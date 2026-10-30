// An OpenAI-compatible HTTP endpoint as a seat: a self-hosted server (Ollama, LM Studio, vLLM,
// llama.cpp) or a pay-per-token API (DeepSeek, Moonshot, OpenAI). The seat names the base URL,
// the model and, for a hosted API, the NAME of the environment variable holding the key.
//
// The key is read from this process's environment at call time and sent to that one endpoint
// in an Authorization header. It is never stored, logged, written to a transcript, put in an
// error message, or sent to the browser. The request offers no tools; a reply that carries
// tool_calls anyway counts as tool use for the guard. Stateless: every call is a fresh thread
// (the engine's stateless prompts carry the whole round), so sessionId is always null.
//
//   run(prompt, null, { endpoint: { url, keyEnv }, model, effort, timeoutMs, tag })
//     -> { text, usage, sessionId: null, quota: null, usedTools, raw }
//
// Errors carry the same kinds as a CLI failure (errors.js): auth, quota, network, timeout,
// killed, other; the engine benches a pool on the first three.
import { ADAPTERS } from './config.js';
import { normaliseUsage, usageCounters } from './common.js';
import { registerCall } from './spawn.js';
import { checkEndpointUrl, KEY_ENV_RE } from '../seats.js';
import { safeProgress, progressText } from '../progress.js';

const cfg = ADAPTERS.api;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

// fetch exposes decoded bytes, including for compressed responses. Bound those bytes before
// decoding or parsing, on errors as well as successful replies, and close an oversized stream.
async function responseText(res, onBytes = () => {}) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const tooLarge = () => Object.assign(new Error('response exceeds the 1 MiB limit.'), { code: 'RESPONSE_TOO_LARGE' });
  let bytes = 0, text = '';
  try {
    // Content-Length is only an early check for unencoded bodies, never the actual bound.
    const length = res.headers.get('content-length');
    if (!res.headers.get('content-encoding') && /^\d+$/.test(length || '') && Number(length) > MAX_RESPONSE_BYTES) throw tooLarge();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      onBytes(bytes);
      if (bytes > MAX_RESPONSE_BYTES) throw tooLarge();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally { reader.releaseLock(); }
}

// What an HTTP failure means for the pool. Pure, so it is unit tested on status codes.
//
//   { kind, message, resetsAt }   kind as in errors.js: auth | quota | network | other
//
// `status` is the response status; `text` the body's first 300 characters (the vendor's own
// words, shown to the human); `retryAfter` the Retry-After header (seconds or a date) or null.
export function httpErrorKind(status, text = '', retryAfter = null, now = Date.now()) {
  const said = text ? `: ${text}` : '';
  // Retry-After is either seconds ("30") or an HTTP date ("Wed, 22 Oct 2026 14:00:00 GMT")
  const secs = Number(retryAfter);
  const resetsAt = retryAfter == null || retryAfter === '' ? null
    : Number.isFinite(secs) ? now + secs * 1000
    : Number.isFinite(Date.parse(retryAfter)) ? Date.parse(retryAfter) : null;

  // a wrong or missing key: calling this host again cannot help
  if (status === 401 || status === 403) return { kind: 'auth', message: `HTTP ${status}, the key was refused${said}`, resetsAt: null };
  // no credit on the account
  if (status === 402) return { kind: 'quota', message: `HTTP 402, no credit left on this account${said}`, resetsAt: null };
  // the service itself is down or overloaded: the case the one retry exists for
  if (status >= 500) return { kind: 'network', message: `HTTP ${status}, the service had a problem${said}`, resetsAt: null };

  // a 429 is either a burst limit or a used-up quota; bench the host either way, so a dead
  // quota is never called again round after round (a burst costs the seat this debate)
  if (status === 429) return { kind: 'quota', message: `HTTP 429, too many requests or quota used up${said}`, resetsAt };

  // anything else (404 a model id the server does not know, 400 a field it rejects): this seat, this round
  return { kind: 'other', message: `HTTP ${status}${said}`, resetsAt: null };
}

// The text of a chat completion: a string, or content parts (some servers answer that way).
function contentText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : '')).join('');
  return '';
}

// Usage with one meaning (common.js normaliseUsage): OpenAI's prompt_tokens includes the cached
// part (cached_tokens); DeepSeek reports the hit count under its own name. Reasoning tokens
// count as thinking where the server reports them.
export function pickUsage(u) {
  return usageCounters({
    input: u?.prompt_tokens, cacheRead: u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens, cacheWrite: 0,
    output: u?.completion_tokens, thinking: u?.completion_tokens_details?.reasoning_tokens,
  });
}

export async function run(prompt, sessionId = null, opts = {}) {
  const t0 = Date.now(), timeoutMs = opts.timeoutMs ?? 300_000;
  let firstOutputMs, lastOutputAt = t0, stdoutBytes = 0, stage = 'waiting';
  const progress = (outcome) => safeProgress({ elapsedMs: Date.now() - t0, timeoutMs, firstOutputMs,
    idleMs: Date.now() - lastOutputAt, stdoutBytes, stderrBytes: 0, stage, outcome });
  const ep = opts.endpoint || {};
  const url = checkEndpointUrl(ep.url);
  const host = new URL(url).host;
  const label = `API ${host}`;
  let credential = '';
  const redact = (value) => credential ? String(value).split(credential).join('[credential redacted]') : String(value);
  // Decode ordinary JSON escapes before excerpting error bodies, so escaped echoes and keys
  // crossing the excerpt boundary cannot leak. This is accidental-copy protection, not a
  // defence against an endpoint deliberately encoding a secret it already received.
  const excerpt = (value, size) => redact(String(value).replace(/\\u[0-9a-fA-F]{4}|\\["\\/bfnrt]/g,
    (escape) => JSON.parse(`"${escape}"`))).slice(0, size).replace(/\s+/g, ' ').trim();
  const fail = (message, extra = {}) => Object.assign(new Error(redact(`${label}: ${message}`)), { kind: 'other', resetsAt: null, progress: progress(), ms: Date.now() - t0, ...extra });
  if (!opts.model) throw fail('no model id for this seat.');
  const env = opts.env || process.env; // opts.env: a test's environment, never the server's
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (ep.keyEnv) {
    if (!KEY_ENV_RE.test(ep.keyEnv)) throw fail(`"${ep.keyEnv}" is not the name of an environment variable.`);
    const key = env[ep.keyEnv];
    if (!key) throw fail(`${ep.keyEnv} is not set in the environment roundtable was started from.`, { kind: 'auth' });
    // HTTP removes trailing header whitespace; redact the token the endpoint can receive too.
    credential = String(key).trim();
    headers.authorization = `Bearer ${key}`;
  }
  const body = { model: opts.model, messages: [{ role: 'user', content: prompt }], stream: false };
  if (opts.effort) body.reasoning_effort = opts.effort; // only when set: a server without the field answers 400

  const call = registerCall(opts.tag ?? null);
  let res, text;
  try {
    res = await fetch(`${url}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', // a redirect would carry the key elsewhere
      signal: AbortSignal.any([call.signal, AbortSignal.timeout(timeoutMs)]),
    });
    firstOutputMs = Date.now() - t0; lastOutputAt = Date.now(); stage = 'headers';
    text = await responseText(res, (bytes) => { stdoutBytes = bytes; lastOutputAt = Date.now(); stage = 'body'; });
  } catch (e) {
    const cause = e?.cause || e;
    if (call.signal.aborted) throw fail('stopped before it answered.', { kind: 'killed', code: 'KILLED', progress: progress('cancelled') });
    if (e?.name === 'TimeoutError' || cause?.name === 'TimeoutError') throw fail(`did not answer in time. ${progressText(progress('timeout'))} Save the error log before retrying.`, { kind: 'timeout', code: 'TIMEOUT', progress: progress('timeout') });
    if (e?.code === 'RESPONSE_TOO_LARGE') throw fail(e.message, { code: e.code });
    throw fail(`could not reach ${host} (${cause?.code || cause?.message || e.message}).`, { kind: 'network' });
  } finally { call.release(); }
  const ms = Date.now() - t0;
  const raw = { url: redact(`${url}/chat/completions`), model: redact(opts.model), status: res.status, ms }; // never the headers

  if (!res.ok) {
    const c = httpErrorKind(res.status, excerpt(text, 300), res.headers.get('retry-after'));
    throw fail(c.message, { kind: c.kind, resetsAt: c.resetsAt, raw });
  }
  let data;
  try { data = JSON.parse(text); } catch { throw fail(`answered with something other than JSON (${excerpt(text, 120)}).`, { raw }); }
  const message = data?.choices?.[0]?.message;
  const reply = redact(contentText(message)).trim();
  const usedTools = (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) || message?.function_call != null
    || ['tool_calls', 'function_call'].includes(data?.choices?.[0]?.finish_reason);
  const counters = normaliseUsage(cfg, pickUsage(data?.usage));
  const usage = counters ? { ...counters, cost: null, ms } : null;
  if (usedTools) throw fail('reported prohibited tool activity. This seat is stopped for the review.', { code: 'TOOL_POLICY', kind: 'policy', usedTools: true, usage });
  if (!reply && !usedTools) throw fail(`empty reply (finish_reason ${data?.choices?.[0]?.finish_reason || 'unknown'}).`, { raw, usage });
  stage = 'completed';
  return { text: reply, usage, sessionId: null, quota: null, usedTools, raw, progress: progress('exited') };
}
