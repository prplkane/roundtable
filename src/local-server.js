// A cheap, versioned health check; provider catalogues are not server readiness checks.
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { VERSION } from './version.js';
import { localClient } from './local-http.js';

export const LOCAL_API_VERSION = 1;
const SERVER = fileURLToPath(new URL('./server.js', import.meta.url));
const transient = (message) => Object.assign(new Error(message), { transient: true });
async function canonical(dir) {
  const resolved = await realpath(path.resolve(dir)).catch((e) => { if (e.code === 'ENOENT') return path.resolve(dir); throw e; });
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function inspectServer(config, { signal, allowOlder = false } = {}) {
  signal?.throwIfAborted();
  let response, body;
  const deadline = AbortSignal.timeout(2000);
  try {
    response = await fetch(`http://127.0.0.1:${config.port}/api/health`, { redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    if ([502, 503, 504].includes(response.status)) { await response.body?.cancel(); throw transient('The local board is still becoming ready.'); }
    try { body = await response.json(); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  } catch (e) {
    signal?.throwIfAborted();
    if (e.cause?.code === 'ECONNREFUSED') return null;
    if (e.transient || deadline.aborted || ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(e.cause?.code)) throw transient('The local board did not answer its health check yet.');
    throw new Error('Could not verify the local board. Check the port; no review was started.', { cause: e });
  }
  if (!response.ok || body?.service !== 'roundtable' || body.apiVersion !== LOCAL_API_VERSION || !/^[a-f0-9]{32}$/.test(body.instanceId || '') || typeof body.dataDir !== 'string' || !path.isAbsolute(body.dataDir)) {
    throw new Error('The selected port has an incompatible or older server. Stop that board from its original terminal or process, then retry. No review was started.');
  }
  if (body.mode !== (config.fake ? 'demo' : 'live')) throw new Error('The selected port is not a Roundtable server in the expected mode. Check --port and --fake.');
  const expectedDir = config.dataDir ?? process.env.ROUNDTABLE_DEBATES_DIR;
  if (expectedDir && await canonical(body.dataDir) !== await canonical(expectedDir)) throw new Error('The selected port uses a different data directory than ROUNDTABLE_DEBATES_DIR. Select its port or stop that board before using this directory. No review was started.');
  if (!allowOlder && body.version !== VERSION) throw new Error(`The running board is version ${body.version}; this installation is ${VERSION}. When reviews are finished, run roundtable server restart --port ${config.port}${config.fake ? ' --fake' : ''}, then retry.`);
  if (body.shuttingDown) throw transient('The local board is shutting down.');
  return body;
}

// Readiness reads may be retried. A review write is never part of this loop.
export async function ensureServer(config, { signal, timeoutMs = 35000 } = {}) {
  const end = Date.now() + timeoutMs;
  let spawned = false, spawnFailed = false, exited = null, ready = false, last;
  // The board's stderr goes to a file, never a pipe: it outlives this process, and a pipe to a
  // gone host would break its logging. The file sits in a fresh private temp directory (no
  // predictable path for another user to plant), is read only when the board exits early, and
  // goes once the board is ready (at once where an open file can be unlinked, else when the
  // board exits while this process is still around).
  let log = null;
  const discard = () => { try { if (log) rmSync(path.dirname(log), { recursive: true, force: true }); } catch {} };
  while (Date.now() < end) {
    signal?.throwIfAborted();
    try {
      const status = await inspectServer(config, { signal });
      if (status) { if (spawned) { ready = true; discard(); } return status; }
      if (config.start === false) throw new Error('Roundtable is not running; start the local board or remove --no-start.');
      if (!spawned) {
        spawned = true;
        // Survives the host connection, so closing chat cannot cancel a review or its timer.
        let fd = null;
        try { log = path.join(mkdtempSync(path.join(os.tmpdir(), 'roundtable-start-')), 'stderr.log'); fd = openSync(log, 'wx'); } catch {}
        const child = spawn(process.execPath, [SERVER, '--no-open', ...(config.fake ? ['--fake'] : [])], {
          env: { ...process.env, PORT: String(config.port), ...(config.dataDir ? { ROUNDTABLE_DEBATES_DIR: config.dataDir } : {}) },
          detached: true, windowsHide: true, stdio: ['ignore', 'ignore', fd ?? 'ignore'],
        });
        if (fd != null) closeSync(fd);
        child.once('error', () => { spawnFailed = true; });
        child.once('exit', (code, sig) => { exited = { code, sig }; if (ready) discard(); });
        child.unref();
      }
    } catch (e) { if (!e.transient) throw e; last = e; }
    if (exited) {
      let tail = '';
      // the board's own last word where it had one, else the error line of a crash, else the last line
      try {
        const lines = readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => l.trim());
        tail = (lines.findLast((l) => l.startsWith('[server]')) || lines.find((l) => /Error|\bE[A-Z]{3,}\b/.test(l)) || lines.at(-1) || '').trim().slice(0, 200);
      } catch {}
      discard();
      const sandboxed = /cannot listen.*\b(EPERM|EACCES)\b/.test(tail);
      throw new Error(`The local board exited before it was ready${tail ? ` (${tail})` : ''}. ${sandboxed ? 'This environment blocks local servers: start the board from a normal terminal with roundtable server start, then retry.' : 'Run roundtable --no-open in a terminal for startup details.'} No review was started.`);
    }
    if (spawnFailed) break;
    await delay(100, undefined, { signal });
  }
  throw new Error(`The local board could not become ready. Check whether another port owns its data folder, or run roundtable --no-open for startup details. No review was started.${last ? ` ${last.message}` : ''}`);
}

export async function stopServer(config, { signal } = {}) {
  const status = await inspectServer(config, { signal, allowOlder: true });
  if (!status) return { ok: true, stopped: false };
  await localClient(config.port, signal).request('/api/shutdown', { instanceId: status.instanceId });
  for (let n = 0; n < 50; n++) {
    await delay(100, undefined, { signal });
    try {
      const current = await inspectServer(config, { signal, allowOlder: true });
      if (!current) return { ok: true, stopped: true };
      if (current.instanceId !== status.instanceId) throw new Error('Another board took this port during shutdown. Read its status before retrying.');
    } catch (e) { if (!e.transient) throw e; }
  }
  throw new Error('The board has not stopped yet. Read server status before retrying.');
}
