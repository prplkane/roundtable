// Remaining subscription quota per vendor.
//
// One shape for the board, whatever the vendor reports:
//   { windows: [{ label: '5h' | '7d' | ..., used: 0..1, resetsAt: epoch seconds | null }],
//     plan: string | null, at: epoch ms }
//
//  claude  rides on every call: `--output-format stream-json` emits a rate_limit_event line
//          whose rate_limit_info.unifiedWindows holds utilization (0..1) per window.
//  codex   separate read, no model call: `codex app-server` over stdio, JSON-RPC
//          account/rateLimits/read -> rateLimits.{primary,secondary}.usedPercent (0..100).
//  agy     nothing headless (/usage is an interactive panel), so only a usage-page link.
import { resolveBinary } from './spawn.js';
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
    const child = spawn(bin.file, [...bin.prefix, 'app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], ...(home ? { env: { ...process.env, CODEX_HOME: home } } : {}) });
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
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'roundtable', version: '0.4.0' } } });
  });
}
