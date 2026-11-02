// Remaining subscription quota per vendor.
//
// One shape for the board, whatever the vendor reports:
//   { windows: [{ label: '5h' | '7d' | ..., used: 0..1, resetsAt: epoch seconds | null }],
//     plan: string | null, at: epoch ms }
// A vendor whose limits differ by model adds groups: each window names its `group`, and
// `groups: [{ name, models }]` lets models.js quotaGroup say which group a seat's model uses.
//
//  claude  rides on every call: `--output-format stream-json` emits a rate_limit_event line
//          whose rate_limit_info.unifiedWindows holds utilization (0..1) per window.
//  codex   separate read, no model call: `codex app-server` over stdio, JSON-RPC
//          account/rateLimits/read -> rateLimits.{primary,secondary}.usedPercent (0..100).
//  agy     separate read, no model call: `agy -p /usage --output-format json` is answered by the
//          CLI itself (no turn, zero tokens) -> command.data.groups[].buckets[] with window,
//          remaining_fraction (0..1) and reset_time (ISO, UTC). Groups are model families.
import { resolveBinary, runProcess, cleanEnv } from './spawn.js';
import { spawn, execFileSync } from 'node:child_process';

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
export function agyQuotaReader({ run = runProcess, resolve = resolveBinary, warn = console.error } = {}) {
  let stopped = null;
  const stop = (why) => { stopped = why; warn(`[quota] agy: ${why}; Antigravity quota reads are off until the server restarts`); return null; };
  // 30 s, as for `agy models`: both wait on the network, and a timeout here turns reads off
  const read = async ({ timeoutMs = 30_000 } = {}) => {
    if (stopped) return null;
    let bin;
    try { bin = resolve('agy'); } catch { return null; }
    let out;
    try { out = (await run(bin, ['-p', '/usage', '--output-format', 'json'], { timeoutMs, env: cleanEnv() })).stdout; } catch (e) {
      if (e.code === 'TIMEOUT') return stop(`/usage gave no answer within ${timeoutMs} ms, so it may have reached a model`);
      return null; // it did not start, or the server is shutting down
    }
    const obj = lastJson(out);
    if (!agyReadWasFree(obj)) return stop(obj ? '/usage did not answer as a free command (a turn, tokens or a conversation)' : '/usage gave no JSON answer');
    return obj.status === 'SUCCESS' ? agyQuota(obj) : null; // ERROR: not signed in, or no network
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
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'roundtable', version: '0.5.0' } } });
  });
}
