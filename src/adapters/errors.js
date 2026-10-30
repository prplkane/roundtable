// What went wrong with a CLI call, in a word the engine and the board can act on:
//
//   quota    the account's limit is used up: no point calling this pool again this debate
//   auth     not logged in, or the login expired: same
//   missing  the CLI is not installed: same
//   network  the service could not be reached: worth one retry
//   timeout  the call ran past its time
//   killed   stopped by the human, the wall clock or a shutdown
//   policy   the provider boundary could not be trusted: stop this seat for the review
//   other    anything else: the seat fails for the round, as before
//
// classifyError({ message, stdout, stderr, code, label }, now) -> { kind, message, resetsAt, detail }
// Pure: tested on captured CLI text. `message` is the plain sentence for the board; `detail` keeps
// the CLI's own words.

const QUOTA = /usage limit|limit reached|hit your (?:usage )?limit|rate[- ]?limit|quota|too many requests|\b429\b|out of credits|insufficient credits|credit balance/i;
const AUTH = /not logged in|please (?:run )?\/?login|log ?in (?:again|required|first)|unauthori[sz]ed|\b401\b|invalid api key|authentication (?:failed|required|error)|session expired|token (?:has )?expired|re-?authenticate/i;
const NETWORK = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|getaddrinfo|network (?:error|is unreachable)|connection (?:error|reset|refused)|\b50[234]\b|overloaded|\b529\b|service unavailable/i;
const LOGIN = { claude: 'claude /login', codex: 'codex login', antigravity: 'agy (sign in in a terminal)' };

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// When the limit lifts, if the CLI says: "try again at Oct 27th, 2026 12:51 PM" (codex), or a
// trailing "|<epoch seconds>" (claude). Milliseconds, or null.
export function resetTime(text, now = Date.now()) {
  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = /(?:try again|resets?|available again)\s+(?:at|on)?\s*([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?,?\s*(?:at\s*)?(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(text);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month == null) return null;
  let hour = Number(m[4]) % 12;
  if (m[6]?.toUpperCase() === 'PM') hour += 12; else if (!m[6]) hour = Number(m[4]);
  const year = m[3] ? Number(m[3]) : new Date(now).getFullYear();
  return new Date(year, month, Number(m[2]), hour, Number(m[5])).getTime();
}

const when = (ms) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function classifyError({ message = '', stdout = '', stderr = '', code = null, label = 'The CLI' } = {}, now = Date.now()) {
  // the CLI's own last words carry the reason; the wrapper's message frames it
  const text = [message, stderr, stdout.split(/\r?\n/).filter((l) => /error|fail|limit|login|denied|quota/i.test(l)).slice(-3).join('\n')].join('\n');
  const detail = String(message).slice(0, 600);
  if (code === 'RESEARCH_LIMIT') return { kind: 'budget', message: 'The reported search-operation limit was exceeded. Research stopped before discussion.', resetsAt: null, detail };
  if (code === 'RESEARCH_INVALID') return { kind: 'format', message: 'Research did not produce usable web evidence. Discussion was not started; check the research details before trying again.', resetsAt: null, detail };
  if (code === 'TOOL_POLICY') return { kind: 'policy', message: 'Provider tool policy rejected this call. This seat is stopped for the review.', resetsAt: null, detail };
  if (code === 'PROVIDER_PROTOCOL') return { kind: 'policy', message: 'Provider output could not be validated. This seat is stopped for the review.', resetsAt: null, detail };
  if (code === 'OUTPUT_LIMIT') return { kind: 'policy', message: 'Provider output exceeded the local size limit. This seat is stopped for the review.', resetsAt: null, detail };
  if (code === 'ISOLATION_REQUIRED') return { kind: 'policy', message: 'Antigravity cannot disable all shared customizations or MCP discovery. Enable Allow limited isolation explicitly, or choose another provider.', resetsAt: null, detail };
  if (/unknown (?:option|argument)|unexpected argument|unrecognized (?:option|argument)/i.test(text)) return { kind: 'compatibility', message: `${label} does not support a required CLI option. Update the CLI; Roundtable will not retry with weaker restrictions.`, resetsAt: null, detail };
  if (code === 'ENOENT' || /not found on PATH/i.test(text)) return { kind: 'missing', message: `${label} CLI not found on this machine.`, resetsAt: null, detail };
  if (code === 'KILLED') return { kind: 'killed', message: 'Stopped before it answered.', resetsAt: null, detail };
  if (code === 'TIMEOUT') return { kind: 'timeout', message: `${label} did not answer in time.`, resetsAt: null, detail };
  if (QUOTA.test(text)) {
    const resetsAt = resetTime(text, now);
    return { kind: 'quota', message: `${label}: usage limit reached${resetsAt ? `, resets ${when(resetsAt)}` : ''}.`, resetsAt, detail };
  }
  if (AUTH.test(text)) return { kind: 'auth', message: `${label}: not logged in. Run ${LOGIN[label.toLowerCase()] || 'its login'} in a terminal.`, resetsAt: null, detail };
  if (NETWORK.test(text)) return { kind: 'network', message: `${label}: could not reach the service.`, resetsAt: null, detail };
  return { kind: 'other', message: String(message).slice(0, 300), resetsAt: null, detail };
}

// Kinds after which calling the same pool again in this debate only fails again.
export const POOL_FATAL = new Set(['quota', 'auth', 'missing']);
