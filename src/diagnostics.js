// Local support data uses an allowlist, never error messages, request bodies or CLI output.
import { mkdirSync, appendFileSync, readFileSync, renameSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeProgress } from './progress.js';

const CODES = new Set(['request-failed', 'provider-failed', 'call-cancelled', 'reply-invalid', 'engine-failed', 'export-failed',
  'transcript-warning', 'status-failed', 'storage-failed', 'server-crash', 'server-start',
  'browser-network', 'browser-timeout', 'browser-response', 'browser-error', 'browser-rejection', 'browser-stream', 'browser-validation']);
export const BROWSER_CODES = new Set([...CODES].filter((c) => c.startsWith('browser-')));
const ACTIONS = new Set(['setup', 'pick-folder', 'history', 'delete', 'clear-finished', 'preflight', 'preview', 'create', 'events', 'state', 'continue', 'finish', 'stop', 'hold',
  'resume', 'export', 'synthesize', 'accept', 'pools', 'diagnostics', 'catalogue', 'quota', 'calibration', 'startup', 'unknown']);
const KINDS = new Set(['quota', 'auth', 'missing', 'network', 'timeout', 'killed', 'format', 'budget', 'policy', 'compatibility', 'other']);
const SYSTEM_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EISDIR', 'EROFS', 'EMFILE', 'ENFILE',
  'TOOL_POLICY', 'OUTPUT_LIMIT', 'PROVIDER_PROTOCOL', 'CLI_EXIT', 'ISOLATION_REQUIRED', 'RESEARCH_LIMIT', 'RESEARCH_INVALID',
  'EADDRINUSE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'TIMEOUT', 'KILLED', 'TRANSCRIPT_CORRUPT', 'TRANSCRIPT_TAIL',
  'SEAT_LENS_REQUIRED', 'SEAT_LENS_DUPLICATE', 'SEAT_MOOD_REQUIRED']);
const FILES = new Set(['server.js', 'store.js', 'history.js', 'engine.js', 'export.js', 'validate.js', 'estimate.js',
  'seats.js', 'preflight.js', 'diagnostics.js', 'snapshot.js', 'review-view.js', 'ui/app.js', 'ui/help.js', 'adapters/common.js', 'adapters/spawn.js',
  'adapters/endpoint.js', 'adapters/claude.js', 'adapters/codex.js', 'adapters/agy.js']);
const ID = /^RT-[a-f0-9]{16}$/;
const integer = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
export const diagnosticId = () => `RT-${randomBytes(8).toString('hex')}`;

export function diagnosticAction(pathname) {
  if (pathname === '/api/seats') return 'setup';
  if (pathname === '/api/debates') return 'history';
  if (pathname === '/api/preflight') return 'preflight';
  if (pathname === '/api/preview') return 'preview';
  if (/^\/api\/pools\/[a-z]+$/.test(pathname)) return 'pools';
  if (pathname.startsWith('/api/diagnostics')) return 'diagnostics';
  const match = /^\/api\/debates\/[^/]+\/([a-z]+)$/.exec(pathname);
  return match && ACTIONS.has(match[1]) ? match[1] : 'unknown';
}

// Project only fixed categories and bounded numbers. Even an endpoint echoing a secret cannot
// put it in this log. Source locations omit function names and absolute filesystem paths.
function fields(input) {
  const out = { code: CODES.has(input?.code) ? input.code : 'request-failed',
    action: ACTIONS.has(input?.action) ? input.action : 'unknown' };
  if (['claude', 'codex', 'agy', 'api'].includes(input?.vendor)) out.vendor = input.vendor;
  if (KINDS.has(input?.kind)) out.kind = input.kind;
  const progress = safeProgress(input?.progress);
  if (Object.keys(progress).length) out.progress = progress;
  if (SYSTEM_CODES.has(input?.systemCode)) out.systemCode = input.systemCode;
  if (['lens', 'moodText'].includes(input?.field)) out.field = input.field;
  if (['human', 'wall-clock'].includes(input?.cancelReason)) out.cancelReason = input.cancelReason;
  for (const [key, max] of Object.entries({ seatIndex: 7, status: 599, round: 100, line: 1_000_000, column: 1_000_000 })) {
    if (integer(input?.[key], max)) out[key] = input[key];
  }
  if (Array.isArray(input?.frames)) out.frames = input.frames.filter((f) => FILES.has(f?.file) && integer(f.line, 1_000_000) && integer(f.column, 1_000_000))
    .slice(0, 5).map(({ file, line, column }) => ({ file, line, column }));
  return out;
}

export function diagnosticError(error) {
  const frames = [];
  for (const m of String(error?.stack || '').matchAll(/[\\/]src[\\/]([\w./\\-]+):(\d+):(\d+)/g)) {
    const file = m[1].replaceAll('\\', '/');
    if (FILES.has(file)) frames.push({ file, line: Number(m[2]), column: Number(m[3]) });
  }
  return { systemCode: error?.code, frames: frames.slice(0, 5) };
}

export function validateBrowserDiagnostics(body) {
  if (!Array.isArray(body?.events) || body.events.length > 20) throw new Error('Send at most 20 diagnostic events.');
  return body.events.map((e) => {
    if (!e || !ID.test(e.id) || !BROWSER_CODES.has(e.code) || !ACTIONS.has(e.action)) throw new Error('Invalid diagnostic event.');
    // Browser callers cannot impersonate a server/provider event or inject stack frames.
    return { id: e.id, ...fields({ code: e.code, action: e.action, status: e.status, line: e.line, column: e.column, seatIndex: e.seatIndex, field: e.field }) };
  });
}

export function createDiagnostics(root, { mode = 'live', version = 'unknown', maxBytes = 256 * 1024,
  maxPerMinute = 120, now = Date.now, warn = (s) => console.warn(s) } = {}) {
  const dir = path.join(root, '_diagnostics');
  const current = path.join(dir, 'events.jsonl'), previous = path.join(dir, 'previous.jsonl');
  const environment = { mode: mode === 'demo' ? 'demo' : 'live',
    version: /^\d+\.\d+\.\d+$/.test(version) ? version : 'unknown', platform: process.platform, nodeMajor: Number(process.versions.node.split('.')[0]) };
  let available = true, dropped = 0, windowAt = now(), count = 0;
  const safeFile = (file) => {
    let stat;
    try { stat = lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid diagnostic file.');
    return stat.size;
  };
  function fail() {
    if (available) warn('[diagnostics] Could not save the local error log. Check free disk space and data-folder permissions.');
    available = false;
  }
  function write(input, error) {
    const id = ID.test(input?.id) ? input.id : diagnosticId();
    if (now() - windowAt >= 60_000) { windowAt = now(); count = 0; }
    if (++count > maxPerMinute) { dropped++; return { id, saved: false }; }
    const entry = { id, at: new Date(now()).toISOString(), ...environment, ...fields({ ...input, ...diagnosticError(error) }) };
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (lstatSync(dir).isSymbolicLink()) throw new Error('Invalid diagnostic directory.');
      const line = JSON.stringify(entry) + '\n';
      const size = safeFile(current);
      if (size > maxBytes || Buffer.byteLength(line) > maxBytes) throw new Error('Oversized diagnostic file.');
      if (size + Buffer.byteLength(line) > maxBytes && existsSync(current)) { safeFile(previous); renameSync(current, previous); }
      appendFileSync(current, line, { mode: 0o600 });
      available = true;
      return { id, saved: true };
    } catch { fail(); return { id, saved: false }; }
  }
  function read() {
    const entries = [];
    try {
      if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('Invalid diagnostic directory.');
      for (const file of [previous, current]) {
        if (!existsSync(file)) continue;
        if (safeFile(file) > maxBytes) throw new Error('Oversized diagnostic file.');
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          try {
            const e = JSON.parse(line);
            if (!ID.test(e.id) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.at) || !CODES.has(e.code)) continue;
            entries.push({ id: e.id, at: e.at, ...fields(e), mode: e.mode === 'demo' ? 'demo' : 'live',
              version: /^\d+\.\d+\.\d+$/.test(e.version) ? e.version : 'unknown',
              platform: ['win32', 'darwin', 'linux'].includes(e.platform) ? e.platform : 'other',
              ...(integer(e.nodeMajor, 1000) ? { nodeMajor: e.nodeMajor } : {}) });
          } catch { /* an interrupted diagnostic line is not a debate record */ }
        }
      }
    } catch { fail(); }
    return { format: 'roundtable-diagnostics-v1', generatedAt: new Date(now()).toISOString(), ...environment, available, dropped, entries };
  }
  return { write, read, status: () => ({ available, dropped }) };
}
