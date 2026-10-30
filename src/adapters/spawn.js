import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROFILE_RE } from '../seats.js';
import { safeProgress } from '../progress.js';

const WIN = process.platform === 'win32';

// Find a real executable for `name` so spawn never needs a shell (Node refuses .cmd shims
// without one, and a shell would mangle quoted prompt text).
export function resolveBinary(name, npmBin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = WIN ? ['.exe'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (existsSync(p)) return { file: p, prefix: [] };
    }
  }
  if (npmBin) {
    const [pkg, rel] = npmBin;
    for (const dir of dirs) {
      const script = path.join(dir, 'node_modules', pkg, rel);
      if (existsSync(script)) return { file: process.execPath, prefix: [script] };
    }
  }
  throw new Error(`${name}: not found on PATH`);
}

// Kill a CLI and everything it started: the process tree on Windows (taskkill /T), the process
// group elsewhere (the child is spawned as a group leader, so -pid reaches its helpers).
export function killTree(child) {
  if (WIN) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

// Every CLI child still running, with the tag its caller gave (the debate slug), so a stopped
// debate or a dying server can kill exactly those. Entries leave when the child closes.
const live = new Map(); // child (or a call token) -> { tag, onKill, virtual }
export function liveChildren(tag = null) {
  return [...live.entries()].filter(([, v]) => tag == null || v.tag === tag).map(([child, v]) => ({ pid: v.virtual ? null : child.pid, tag: v.tag }));
}
// Kill the registered children (all, or those with `tag`). `kill` is injectable for tests.
export function killAll(tag = null, { kill = killTree } = {}) {
  let n = 0;
  for (const [child, v] of [...live.entries()]) {
    if (tag != null && v.tag !== tag) continue;
    v.onKill(); if (!v.virtual) kill(child); live.delete(child); n++;
  }
  return n;
}
// An in-process call (an HTTP request to an API endpoint) registered under a tag, so a stopped
// debate or a dying server aborts it like a child. Returns its abort signal and a release().
export function registerCall(tag = null) {
  const token = {};
  const ac = new AbortController();
  live.set(token, { tag, virtual: true, onKill: () => ac.abort(Object.assign(new Error('killed: the debate was stopped or the server shut down'), { code: 'KILLED' })) });
  return { signal: ac.signal, release: () => live.delete(token) };
}

// Run a CLI once. Resolves with {stdout, stderr, code, ms}; rejects on timeout (code TIMEOUT),
// on a kill through killAll (code KILLED) or on a spawn error.
export function runProcess({ file, prefix }, args, { stdin = null, cwd, timeoutMs = 300_000, env, tag = null, onStdout, maxOutputBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(file, [...prefix, ...args], { cwd, env, windowsHide: true, detached: !WIN, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false, outputBytes = 0, stdoutBytes = 0, stderrBytes = 0, firstOutputMs, lastOutputAt = t0;
    const progress = (outcome, exitCode) => safeProgress({ elapsedMs: Date.now() - t0, timeoutMs, stdoutBytes, stderrBytes,
      firstOutputMs, idleMs: Date.now() - lastOutputAt, outcome, exitCode });
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); live.delete(child); fn(); };
    live.set(child, { tag, onKill: () => finish(() => reject(Object.assign(new Error('killed: the debate was stopped or the server shut down'), { code: 'KILLED', stdout: out, stderr: err, ms: Date.now() - t0, progress: progress('cancelled') }))) });
    const stop = (e) => finish(() => {
      const metadata = progress(e.code === 'TOOL_POLICY' ? 'policy' : e.code === 'OUTPUT_LIMIT' ? 'output-limit' : 'protocol');
      killTree(child);
      reject(Object.assign(e, { stdout: out, stderr: err, ms: metadata.elapsedMs, progress: metadata }));
    });
    const receive = (d, stdout) => {
      if (done) return;
      outputBytes += Buffer.byteLength(d);
      if (stdout) stdoutBytes += Buffer.byteLength(d); else stderrBytes += Buffer.byteLength(d);
      lastOutputAt = Date.now();
      firstOutputMs ??= lastOutputAt - t0;
      if (outputBytes > maxOutputBytes) { stop(Object.assign(new Error('Provider output exceeded the local size limit.'), { code: 'OUTPUT_LIMIT' })); return; }
      if (stdout) out += d; else err += d;
      try { if (stdout) onStdout?.(d); } catch (e) { stop(e); }
    };
    child.stdout.setEncoding('utf8').on('data', (d) => receive(d, true));
    child.stderr.setEncoding('utf8').on('data', (d) => receive(d, false));
    const timer = setTimeout(() => finish(() => {
      const metadata = progress('timeout');
      killTree(child);
      reject(Object.assign(new Error(`timed out after ${timeoutMs} ms`), { code: 'TIMEOUT', stdout: out, stderr: err, ms: metadata.elapsedMs, progress: metadata }));
    }), timeoutMs);
    child.on('error', (e) => finish(() => reject(Object.assign(e, { stdout: out, stderr: err, ms: Date.now() - t0, progress: progress('spawn-error') }))));
    child.on('close', (code) => finish(() => resolve({ stdout: out, stderr: err, code, ms: Date.now() - t0, progress: progress('exited', code) })));
    child.stdin.on('error', () => {}); // CLI may exit before reading stdin
    child.stdin.end(stdin ?? '');
  });
}

// Strip the variables Claude Code sets for its own children so a nested `claude -p`
// behaves like one launched from a plain terminal. `home` ({env, dir}) points the CLI's local
// state at the instance's own directory.
// Variables that would make a CLI bill an API account instead of the subscription it is logged
// in to. A seat runs on the subscription unless ROUNDTABLE_API_BILLING=1 says otherwise, so a
// key left in the shell cannot quietly move a debate onto pay-per-token.
export const API_KEY_VARS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_API_KEY|OPENAI_API_KEY|OPENAI_ACCESS_TOKEN|CODEX_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|GOOGLE_GENAI_API_KEY)$/;

export function cleanEnv(home = null, { allowApiKeys = process.env.ROUNDTABLE_API_BILLING === '1', source = process.env } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(source)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_EFFORT|ANTHROPIC_BASE_URL)/.test(k)) continue;
    if (!allowApiKeys && API_KEY_VARS.test(k)) continue;
    env[k] = v;
  }
  if (home) env[home.env] = home.dir;
  return env;
}

// Where a named profile's CLI state lives: the OS user-data directory, never the project
// folder. One tree per profile name, one subdirectory per vendor inside it, so a profile is a
// login the user made themselves (`doctor` prints the command). Nothing is ever copied into it:
// the CLI's own login flow writes its credentials there, and roundtable never reads them.
//   Windows  %LOCALAPPDATA%\\roundtable\\homes\\<profile>\\<vendor>
//   macOS    ~/Library/Application Support/roundtable/homes/<profile>/<vendor>
//   Linux    $XDG_DATA_HOME/roundtable/homes/<profile>/<vendor>, default ~/.local/share
export function dataDir({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix; // the target platform's separators, so tests can ask for any
  if (platform === 'win32') return P.join(env.LOCALAPPDATA || P.join(homedir, 'AppData', 'Local'), 'roundtable');
  if (platform === 'darwin') return P.join(homedir, 'Library', 'Application Support', 'roundtable');
  return P.join(env.XDG_DATA_HOME || P.join(homedir, '.local', 'share'), 'roundtable');
}

export function profileHome(vendor, profile, where = {}) {
  const name = String(profile || '').trim();
  if (!PROFILE_RE.test(name)) throw new Error(`Profile name "${profile}" must be 1-40 letters, digits, dots, dashes or underscores.`);
  return (where.platform === 'win32' || (!where.platform && process.platform === 'win32') ? path.win32 : path.posix).join(dataDir(where), 'homes', name, vendor);
}
