// Remaining subscription quota per vendor.
//
// One shape for the board, whatever the vendor reports:
//   { windows: [{ label: '5h' | '7d' | ..., used: 0..1, resetsAt: epoch seconds | null }],
//     plan: string | null, at: epoch ms }
// A vendor whose limits differ by model adds groups: each window names its `group`, and
// `groups: [{ name, models }]` lets models.js quotaGroup say which group a seat's model uses.
//
//  claude  separate read, no model call: `claude -p /usage --output-format json` is answered by
//          the CLI itself (no turn, zero tokens, local_command "usage") -> sentences in `result`
//          ("Current session: 53% used · resets Nov 2, 4:59am (Europe/Berlin)"). Each reply also
//          carries a rate_limit_event (rate_limit_info.unifiedWindows, utilization 0..1), used
//          when that read gives nothing.
//  codex   separate read, no model call: `codex app-server` over stdio, JSON-RPC
//          account/rateLimits/read -> rateLimits.{primary,secondary}.usedPercent (0..100).
//  agy     separate read, no model call: `agy -p /usage --output-format json` is answered by the
//          CLI itself (no turn, zero tokens) -> command.data.groups[].buckets[] with window,
//          remaining_fraction (0..1) and reset_time (ISO, UTC). Groups are model families.
import { resolveBinary, runProcess, cleanEnv, dataDir } from './spawn.js';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

// Keys seen in rate_limit_info.unifiedWindows (the third appeared in the first real debate after the
// spike). An unknown key is shown with its underscores as spaces rather than hidden.
const WINDOW_LABELS = { five_hour: '5h', seven_day: '7d', seven_day_overage_included: '7d incl. overage' };
const windowKeyLabel = (k) => WINDOW_LABELS[k] || k.replace(/_/g, ' ');

// claude: rate_limit_info from the last rate_limit_event of a stream-json call.
export function claudeQuota(info, at = Date.now()) {
  const wins = info?.unifiedWindows;
  if (!wins || typeof wins !== 'object') return null;
  const windows = Object.entries(wins)
    .filter(([, w]) => w && typeof w.utilization === 'number')
    .map(([k, w]) => ({ label: windowKeyLabel(k), used: w.utilization, resetsAt: w.resetsAt ?? null }));
  return windows.length ? { windows, plan: null, at } : null;
}

// claude: the text `claude -p /usage` prints. Only the limit lines are read:
//   Current session: 53% used · resets Nov 2, 4:59am (Europe/Berlin)
//   Current week (all models): 57% used · resets Nov 2, 8:59pm (Europe/Berlin)
//   Current week (Fable): 75% used · resets Nov 2, 8:59pm (Europe/Berlin)
// The same answer summarises local activity (requests, sessions, skills, MCP servers); none of it
// is kept. Labels match the reply's rate_limit_event (5h, 7d), so calibration compares like with
// like; a week for one model family becomes "7d <family>".
const CLAUDE_LIMIT = /^\s*Current (session|week)(?:\s*\(([^)]+)\))?\s*:\s*(\d{1,3}(?:\.\d+)?)%\s+used\b(?:\s*\S\s*resets\s+(.+?))?\s*$/i;
export function claudeUsage(text, at = Date.now()) {
  const windows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = CLAUDE_LIMIT.exec(line);
    if (!m) continue;
    const family = m[2] && !/^all models$/i.test(m[2].trim()) ? m[2].trim() : null;
    const label = m[1].toLowerCase() === 'session' ? '5h' : family ? `7d ${family}` : '7d';
    if (windows.some((w) => w.label === label)) continue;
    windows.push({ label, used: Math.min(1, Number(m[3]) / 100), resetsAt: m[4] ? claudeResetAt(m[4], at) : null });
  }
  return windows.length ? { windows, plan: null, at } : null;
}

// "Nov 2, 4:59am (Europe/Berlin)", or "4:59am (Europe/Berlin)" for later today: a wall-clock time
// in a named zone, without a year. The next such moment from `now`, in epoch seconds; null when
// the text or the zone cannot be read (the reply's figure then supplies exact reset times).
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function zoneParts(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms);
  const n = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  return n;
}
function zoneToEpochMs(year, month, day, hour, minute, zone) {
  const wall = Date.UTC(year, month, day, hour, minute);
  const offset = (ms) => { const p = zoneParts(ms, zone); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms; };
  const first = wall - offset(wall);
  return wall - offset(first); // a second pass settles a daylight-saving change between the two
}
export function claudeResetAt(text, now = Date.now()) {
  const m = /^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)\s*$/i.exec(String(text).trim());
  if (!m) return null;
  let today;
  try { today = zoneParts(now, m[6].trim()); } catch { return null; } // a zone this runtime does not know
  if (Number(m[3]) < 1 || Number(m[3]) > 12) return null; // a 12-hour clock: 13pm is no time
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0), minute = Number(m[4] || 0);
  if (minute > 59) return null;
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : today.month - 1;
  if (month < 0) return null;
  // A dated reset up to a day past is a display a little behind, not next year's; an undated one
  // already past means tomorrow.
  const candidates = m[1] ? [[today.year, month, Number(m[2])], [today.year + 1, month, Number(m[2])]]
    : [[today.year, month, today.day], [today.year, month, today.day + 1]];
  const grace = m[1] ? 86_400_000 : 60_000;
  for (const [y, mo, d] of candidates) {
    const t = zoneToEpochMs(y, mo, d, hour, minute, m[6].trim());
    if (t >= now - grace) return Math.round(t / 1000);
  }
  return null;
}

// The read is free only when the CLI answered it as a local command: no turn, no cost, every
// token counter zero. Anything else, an unreadable answer included, is not shown free.
const CLAUDE_TOKENS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
export function claudeReadWasFree(obj) {
  const u = obj?.usage;
  return !!u && typeof u === 'object' && obj.num_turns === 0 && obj.local_command === 'usage'
    && (obj.total_cost_usd ?? 0) === 0 && CLAUDE_TOKENS.every((k) => (u[k] ?? 0) === 0);
}

// The seats' lockdown (config.js claude args) minus --disable-slash-commands, which /usage needs.
// --model haiku: should a CLI ever send "/usage" to a model, the stray turn is the cheapest one,
// and the latch below stops every later read.
export const CLAUDE_USAGE_ARGS = ['-p', '/usage', '--output-format', 'json', '--model', 'haiku', '--permission-mode', 'plan',
  '--tools', '', '--disallowedTools', 'mcp__*', '--setting-sources', 'local', '--strict-mcp-config', '--safe-mode', '--no-session-persistence'];

// A reader with its own latch, as for agy: an answer that is not shown free, or a read cut off by
// the timeout, stops every later read until the server restarts. A proven-free answer without
// limit lines, or with an error, is no figure this time; the next ordinary read may work.
// It runs from an empty folder
// so no project settings or instructions load, with the seats' cleaned environment (a shell
// another agent CLI opened changes how the CLI treats slash commands). home: a named profile's
// CLAUDE_CONFIG_DIR. run, resolve and cwd are injectable so tests never spawn the CLI.
export function claudeQuotaReader({ run = runProcess, resolve = resolveBinary, warn = console.error, cwd = null } = {}) {
  let stopped = null;
  const stop = (why) => { stopped = why; warn(`[quota] claude: ${why}; Claude quota reads are off until the server restarts`); return null; };
  const read = async ({ timeoutMs = 30_000, home = null } = {}) => {
    if (stopped) return null;
    let bin;
    try { bin = resolve('claude'); } catch { return null; }
    const dir = cwd || path.join(dataDir(), 'quota', 'claude');
    let out;
    try {
      mkdirSync(dir, { recursive: true });
      out = (await run(bin, CLAUDE_USAGE_ARGS, { timeoutMs, cwd: dir, env: cleanEnv(home ? { env: 'CLAUDE_CONFIG_DIR', dir: home } : null) })).stdout;
    } catch (e) {
      if (e.code === 'TIMEOUT') return stop(`/usage gave no answer within ${timeoutMs} ms, so it may have reached a model`);
      return null; // it did not start, or the server is shutting down
    }
    const obj = lastJson(out);
    if (!claudeReadWasFree(obj)) return stop(obj ? '/usage did not answer as a local command (a turn, tokens or a cost)' : '/usage gave no JSON answer');
    if (obj.is_error) return null;
    return claudeUsage(obj.result);
  };
  read.stopped = () => stopped;
  return read;
}
export const readClaudeQuota = claudeQuotaReader();

// codex: the result object of account/rateLimits/read.
export function codexQuota(result, at = Date.now()) {
  const rl = result?.rateLimits;
  if (!rl) return null;
  const windows = [rl.primary, rl.secondary]
    .filter((w) => w && typeof w.usedPercent === 'number')
    .map((w) => ({ label: windowLabel(w.windowDurationMins), used: w.usedPercent / 100, resetsAt: w.resetsAt ?? null }));
  return windows.length ? { windows, plan: rl.planType ?? null, at } : null;
}

// agy: the parsed answer to `-p /usage`. A window is labelled by its group's short name and its
// span ("Gemini 5h", "Claude and GPT 7d"), unique in the pool, since calibration matches windows
// by label. A bucket without a figure (the CLI shows a disabled one dimmed) is left out, and so is
// a group left with no window.
const AGY_SPANS = { '5h': '5h', weekly: '7d' };
const groupTag = (name) => String(name).replace(/\s+models$/i, '');
// "Models within this group: Gemini Flash, Gemini Pro" -> ['Gemini Flash', 'Gemini Pro']
const groupModels = (text) => { const m = /group:\s*(.+?)\.?$/i.exec(String(text || '')); return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : []; };
export function agyQuota(obj, at = Date.now()) {
  const data = obj?.command?.name === 'usage' ? obj.command.data : null;
  if (!Array.isArray(data?.groups)) return null;
  const windows = [], groups = [];
  for (const g of data.groups) {
    if (typeof g?.name !== 'string' || !g.name) continue;
    const own = (Array.isArray(g.buckets) ? g.buckets : [])
      .filter((b) => typeof b?.remaining_fraction === 'number' && Number.isFinite(b.remaining_fraction))
      .map((b) => {
        const reset = Date.parse(b.reset_time);
        return { label: `${groupTag(g.name)} ${AGY_SPANS[b.window] || b.window || 'window'}`, used: Math.min(1, Math.max(0, 1 - b.remaining_fraction)),
          resetsAt: Number.isFinite(reset) ? Math.round(reset / 1000) : null, group: g.name };
      });
    if (!own.length) continue;
    windows.push(...own);
    groups.push({ name: g.name, models: groupModels(g.description) });
  }
  return windows.length ? { windows, groups, plan: null, at } : null;
}

// The read is free only when the CLI answered it itself: no turn, no conversation left behind,
// and every token counter zero. Anything else, an unreadable answer included, is not shown free.
export function agyReadWasFree(obj) {
  const u = obj?.usage;
  return !!u && typeof u === 'object' && obj.num_turns === 0 && !obj.conversation_id
    && Object.values(u).every((n) => n === 0);
}

// The JSON object on stdout: the whole output when it is one (printed over several lines or one),
// else the last line that is one (a notice printed before it is skipped).
function lastJson(text) {
  const whole = String(text || '').trim();
  if (whole.startsWith('{')) { try { return JSON.parse(whole); } catch { /* not one object: scan the lines */ } }
  for (const line of whole.split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* keep looking */ }
  }
  return null;
}

// A reader with its own latch. `-p /usage` reaches a model only if a CLI stops answering it
// itself; the reader runs after every Antigravity reply, so the first answer that is not shown
// free (a turn, tokens, a conversation, or a read cut off by the timeout) stops every later read
// until the server restarts: one stray call at most, never one per reply. Slash commands stay
// on here (the seats turn them off): /usage is the expansion this read needs. The cleaned
// environment is load-bearing: run from a shell that another agent CLI opened (Claude Code's
// variables set), agy 1.4.12 sent "/usage" to a model instead of answering it, a turn of 18k
// tokens each time. The argv below is the one measured free; the seats' deny rules are not
// added to it, since that was not measured, and the latch bounds a CLI that stops answering.
// run and resolve are injectable so tests never spawn the CLI.
// agy: the parsed answer to `-p /credits`, the AI credits that take over once a group's limits
// are used: command.data.remaining_credits. null when the answer holds no such number.
export function agyCredits(obj) {
  const n = obj?.status === 'SUCCESS' && obj.command?.name === 'credits' ? obj.command.data?.remaining_credits : undefined;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

// How often /credits is asked: a balance that moves only once a group's limits are used up, so
// not after every reply as /usage is.
export const AGY_CREDITS_EVERY_MS = 10 * 60_000;

export function agyQuotaReader({ run = runProcess, resolve = resolveBinary, warn = console.error, now = Date.now } = {}) {
  // credits: { remaining, at } from the last /credits answer that held a figure; askedAt: when it
  // was last asked, answered or not, so an account without credits is not asked on every read
  let stopped = null, credits = null, askedAt = null;
  const stop = (why) => { stopped = why; warn(`[quota] agy: ${why}; Antigravity quota reads are off until the server restarts`); return null; };
  // One command the CLI answers itself, or null: it did not start, or it was not shown free (the
  // latch then says why, once). 30 s, as for `agy models`: both wait on the network, and a
  // timeout turns reads off.
  const ask = async (bin, command, timeoutMs) => {
    let out;
    try { out = (await run(bin, ['-p', command, '--output-format', 'json'], { timeoutMs, env: cleanEnv() })).stdout; } catch (e) {
      if (e.code === 'TIMEOUT') return stop(`${command} gave no answer within ${timeoutMs} ms, so it may have reached a model`);
      return null; // it did not start, or the server is shutting down
    }
    const obj = lastJson(out);
    if (!agyReadWasFree(obj)) return stop(obj ? `${command} did not answer as a free command (a turn, tokens or a conversation)` : `${command} gave no JSON answer`);
    return obj;
  };
  const read = async ({ timeoutMs = 30_000 } = {}) => {
    if (stopped) return null;
    let bin;
    try { bin = resolve('agy'); } catch { return null; }
    const usage = await ask(bin, '/usage', timeoutMs);
    const q = usage?.status === 'SUCCESS' ? agyQuota(usage) : null; // ERROR: not signed in, or no network
    if (!q) return null;
    if (askedAt == null || now() - askedAt >= AGY_CREDITS_EVERY_MS) {
      askedAt = now();
      const answer = await ask(bin, '/credits', timeoutMs);
      if (stopped) return null;
      const remaining = agyCredits(answer);
      if (remaining != null) credits = { remaining, at: now() };
    }
    return credits ? { ...q, credits } : q;
  };
  read.stopped = () => stopped;
  return read;
}
export const readAgyQuota = agyQuotaReader();

function windowLabel(mins) {
  if (!mins) return 'window';
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

// Ask the codex app-server for the account's rate limits. Spawns `codex app-server` on stdio,
// does the initialize handshake, reads one response, kills the child. Resolves null on any
// failure so the board degrades to the usage-page link.
// home: a named profile's CODEX_HOME, so each account's own limits are read.
export function readCodexQuota({ timeoutMs = 20_000, home = null } = {}) {
  return new Promise((resolve) => {
    let bin;
    try { bin = resolveBinary('codex', ['@openai/codex', 'bin/codex.js']); } catch { return resolve(null); }
    const child = spawn(bin.file, [...bin.prefix, 'app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: cleanEnv(home ? { env: 'CODEX_HOME', dir: home } : null) });
    let buf = '', done = false;
    const finish = (v) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
      else { try { child.kill('SIGKILL'); } catch {} }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (o) => { try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n'); } catch {} };
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8').on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read', params: null }); }
        if (msg.id === 2) finish(msg.result ? codexQuota(msg.result) : null);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'roundtable', version: '0.6.1' } } });
  });
}
