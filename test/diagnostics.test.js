import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiagnostics, diagnosticAction, validateBrowserDiagnostics } from '../src/diagnostics.js';
import { createBrowserDiagnostics, requestAction } from '../src/ui/diagnostics.js';

test('diagnostics retain actionable categories and source lines without private text or arbitrary fields', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-diagnostics-'));
  const log = createDiagnostics(root, { mode: 'demo', version: '0.3.0' });
  const error = Object.assign(new Error('PRIVATE-MARKER in a provider reply'), { code: 'ENOSPC',
    stack: 'Error: PRIVATE-MARKER\n at privateName (file:///home/user/project/src/server.js:25:7)\n at privateFn (/secret/private.js:2:3)' });
  const entry = log.write({ code: 'provider-failed', action: 'events', vendor: 'claude', kind: 'auth',
    message: 'PRIVATE-MARKER', model: 'PRIVATE-MARKER', account: 'PRIVATE-MARKER', slug: 'PRIVATE-MARKER',
    headers: { authorization: 'Bearer PRIVATE-MARKER' }, body: { notes: 'PRIVATE-MARKER' } }, error);
  assert.equal(entry.saved, true);
  const raw = readFileSync(path.join(root, '_diagnostics', 'events.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /PRIVATE-MARKER|privateName|privateFn|\/home\/|\/secret\/|authorization|model|account|slug/);
  const event = log.read().entries[0];
  assert.equal(event.id, entry.id);
  assert.equal(event.systemCode, 'ENOSPC');
  assert.deepEqual(event.frames, [{ file: 'server.js', line: 25, column: 7 }]);
  assert.equal(event.vendor, 'claude');
  assert.equal(diagnosticAction('/api/debates/private-title/export'), 'export');
  // Download re-projects even a locally modified file instead of returning its raw contents.
  writeFileSync(path.join(root, '_diagnostics', 'events.jsonl'), JSON.stringify({ ...event, extra: 'PRIVATE-MARKER', vendor: 'PRIVATE-MARKER' }) + '\n');
  assert.doesNotMatch(JSON.stringify(log.read()), /PRIVATE-MARKER/);
});

test('diagnostics rotate within the byte limit, survive restart, and bound a flood', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-diagnostics-rotation-'));
  let time = Date.now();
  const log = createDiagnostics(root, { maxBytes: 1024, maxPerMinute: 30, now: () => time });
  for (let i = 0; i < 30; i++) assert.equal(log.write({ code: 'request-failed', action: 'setup', status: 500 }).saved, true);
  assert.equal(log.write({ code: 'request-failed' }).saved, false);
  assert.equal(log.read().dropped, 1);
  const dir = path.join(root, '_diagnostics');
  assert.deepEqual(readdirSync(dir).sort(), ['events.jsonl', 'previous.jsonl']);
  for (const file of readdirSync(dir)) assert.ok(statSync(path.join(dir, file)).size <= 1024);
  const recovered = createDiagnostics(root, { maxBytes: 1024 }).read().entries;
  assert.ok(recovered.length > 1 && recovered.length < 30);
  time += 60_000;
  assert.equal(log.write({ code: 'request-failed' }).saved, true);
});

test('diagnostic storage failure is explicit and cannot crash a review', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-diagnostics-failure-'));
  writeFileSync(path.join(root, '_diagnostics'), 'not a folder');
  const warnings = [];
  const log = createDiagnostics(root, { warn: (s) => warnings.push(s) });
  assert.equal(log.write({ code: 'server-crash' }, new Error('PRIVATE-MARKER')).saved, false);
  assert.equal(log.status().available, false);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /PRIVATE-MARKER/);
});

test('browser reports cannot inject provider events, URLs, messages or metadata', () => {
  const id = 'RT-0123456789abcdef';
  assert.throws(() => validateBrowserDiagnostics({ events: [{ id, code: 'server-crash', action: 'setup' }] }), /Invalid/);
  assert.throws(() => validateBrowserDiagnostics({ events: Array(21).fill({}) }), /at most 20/);
  assert.deepEqual(validateBrowserDiagnostics({ events: [{ id, code: 'browser-error', action: 'setup', line: 42,
    message: 'PRIVATE-MARKER', endpoint: 'PRIVATE-MARKER', vendor: 'claude', frames: [{ file: 'server.js', line: 1, column: 1 }] }] }),
  [{ id, code: 'browser-error', action: 'setup', line: 42 }]);
});

test('browser diagnostics keep a bounded, sanitized queue through offline reloads and acknowledge only saved entries', async () => {
  let saved = null, online = false;
  const storage = { getItem: () => saved, setItem: (key, value) => { saved = value; } };
  const send = async (events) => { if (!online) throw new Error('offline'); return { saved: events.map((e) => e.id) }; };
  const first = createBrowserDiagnostics({ storage, send });
  for (let i = 0; i < 25; i++) first.report('browser-network', 'create', { message: 'PRIVATE-MARKER', url: '/private-title', status: 500 });
  await first.flush();
  assert.equal(first.pending().length, 20);
  assert.doesNotMatch(saved, /PRIVATE-MARKER|private-title/);
  const reloaded = createBrowserDiagnostics({ storage, send });
  assert.deepEqual(reloaded.pending(), first.pending());
  online = true;
  await reloaded.flush();
  assert.deepEqual(reloaded.pending(), []);
  assert.equal(saved, '[]');
  assert.equal(requestAction('/api/debates/private-title/stop', true), 'stop');
  assert.equal(requestAction('/api/debates', true), 'create');
});
