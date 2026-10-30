// Real HTTP/lifecycle boundaries with scripted seats only: never invoke a vendor CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temporary = () => mkdtempSync(path.join(os.tmpdir(), 'rt-review-fixes-'));
async function server(root, preload = '') {
  const port = await new Promise((resolve) => {
    const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); });
  });
  const child = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), 'src/server.js', '--fake', '--no-open'], {
    env: { ...process.env, PORT: String(port), ROUNDTABLE_DEBATES_DIR: root }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let n = 0; !/token [a-f0-9]{32}/.test(log); n++) {
    if (n > 300 || child.exitCode !== null) { child.kill(); throw new Error('Synthetic server failed to start.'); }
    await delay(25);
  }
  const base = `http://127.0.0.1:${port}`, token = /token ([a-f0-9]{32})/.exec(log)[1];
  return { child, base,
    get: async (route) => (await fetch(base + route)).json(),
    post: (route, body = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': token }, body: JSON.stringify(body) }),
    async stop() { if (child.exitCode === null && child.signalCode === null) { const exited = new Promise((r) => child.once('exit', r)); child.kill(); await exited; } },
  };
}
async function stream(srv, id, until, onEvent = () => {}) {
  const res = await fetch(`${srv.base}/api/debates/${id}/events`, { signal: AbortSignal.timeout(15000) });
  const reader = res.body.getReader(), decoder = new TextDecoder(), events = [];
  let text = '';
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break; text += decoder.decode(part.value, { stream: true });
      let end;
      while ((end = text.indexOf('\n\n')) >= 0) {
        const chunk = text.slice(0, end); text = text.slice(end + 2);
        const line = chunk.split('\n').find((x) => x.startsWith('data: ')); if (!line) continue;
        const event = JSON.parse(line.slice(6)); events.push(event); await onEvent(event);
        if (until(event)) return events;
      }
    }
    return events;
  } finally { await reader.cancel().catch(() => {}); }
}
const request = { fieldNotes: { decision: 'Synthetic lifecycle review', options: ['Trial', 'Wait'] },
  seats: [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'delivery' }, { vendor: 'agy', lens: 'adoption' }], chairman: { vendor: 'claude' },
  options: { critiqueRounds: 2, unattended: true } };

test('graceful shutdown closes streams and preserves recovery at a call, question or verdict', { timeout: 60000 }, async () => {
  for (const phase of ['critique', 'question', 'verdict']) {
    const root = temporary(), preload = path.join(root, 'signal.mjs');
    writeFileSync(preload, `process.on('message', m => { if (m === 'SIGINT' || m === 'SIGTERM') process.emit(m); });
      const timeout = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => timeout(() => { if (ms === 1500) process.send({fallback:true}); fn(...args); }, ms);`);
    let srv = await server(root, preload), fallback = false;
    srv.child.on('message', (m) => { fallback ||= m.fallback === true; });
    try {
      const body = { ...request, options: { ...request.options, unattended: phase !== 'question', critiqueRounds: phase === 'verdict' ? 0 : 2 } };
      const { slug: id } = await (await srv.post('/api/debates', body)).json(); assert.ok(id);
      let signalled = false;
      const exited = once(srv.child, 'exit');
      const events = await stream(srv, id, () => false, (e) => {
        const atPhase = phase === 'critique' ? e.type === 'round-start' && e.round === 1 : e.type === (phase === 'question' ? 'gate' : 'chairman-start');
        if (atPhase && !signalled) { signalled = true; srv.child.send(phase === 'critique' ? 'SIGTERM' : 'SIGINT'); }
      });
      await exited;
      assert.equal(signalled, true, phase);
      assert.equal(fallback, false, 'open event streams do not force the shutdown fallback');
      assert.equal(events.some((e) => e.type === 'done'), false, 'interruption does not finish a review');
      assert.equal(events.filter((e) => e.type === 'chairman-start').length, phase === 'verdict' ? 1 : 0);
      const rows = readFileSync(path.join(root, id, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows.some((r) => r.type === 'stop' && r.reason === 'human'), false);
      assert.equal(rows.some((r) => r.type === 'verdict'), false, 'a cancelled verdict stays missing');
      assert.ok(rows.some((r) => r.type === 'attempt' && r.usage), 'reported spending is retained');
      srv = await server(root);
      const state = await srv.get(`/api/debates/${id}/state`);
      assert.equal(state.status, phase === 'verdict' ? 'done' : 'interrupted');
      assert.deepEqual(state.actions, [phase === 'verdict' ? 'verdict' : 'resume']);
      if (phase === 'question') {
        assert.equal((await srv.post(`/api/debates/${id}/resume`, { message: 'Retain this recovery note.' })).status, 200);
        const resumed = await stream(srv, id, (e) => e.type === 'round-start' && e.round === 1);
        assert.ok(resumed.some((e) => e.type === 'resumed'));
      }
    } finally { await srv.stop(); }
  }
});

test('a repaired storage failure offers recovery and accepts Resume without a server restart', { timeout: 20000 }, async () => {
  const root = temporary(), preload = path.join(root, 'storage.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    let fail = false, partial = false; const append = fs.appendFileSync;
    fs.appendFileSync = (file, ...args) => {
      if (fail && String(file).endsWith('transcript.jsonl')) {
        if (!partial) { partial = true; append(file, '{"type":'); }
        throw Object.assign(new Error('Synthetic storage failure'), {code:'ENOSPC'});
      }
      return append(file, ...args);
    }; syncBuiltinESMExports();
    process.on('message', m => { if (typeof m === 'boolean') { fail = m; process.send({enabled:fail}); } });`);
  const srv = await server(root, preload);
  const fault = (enabled) => new Promise((resolve) => { srv.child.once('message', resolve); srv.child.send(enabled); });
  try {
    const { slug: id } = await (await srv.post('/api/debates', request)).json(); assert.ok(id);
    await fault(true);
    const events = await stream(srv, id, (e) => e.type === 'error');
    assert.equal(events.at(-1).recoverable, true);
    await fault(false);
    const state = await srv.get(`/api/debates/${id}/state`);
    assert.equal(state.status, 'interrupted'); assert.deepEqual(state.actions, ['resume']);
    assert.equal((await srv.post(`/api/debates/${id}/resume`)).status, 200);
    const resumed = await stream(srv, id, (e) => e.type === 'done');
    assert.ok(resumed.some((e) => e.type === 'resumed'));
    const dir = path.join(root, id);
    assert.ok(readdirSync(dir).some((name) => name.startsWith('transcript.recovery-')));
    for (const line of readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  } finally { await srv.stop(); }
});

test('unreadable pool settings reject updates and preserve their original bytes', { timeout: 10000 }, async () => {
  const root = temporary(), file = path.join(root, '_pools.fake.json'), original = '{ synthetic damaged settings';
  writeFileSync(file, original); const srv = await server(root);
  try {
    const res = await srv.post('/api/pools/agy', { remaining: 2, note: 'Synthetic' });
    assert.equal(res.status, 409); assert.match((await res.json()).error, /Restore it and restart/);
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally { await srv.stop(); }
});

test('finished replay bodies are bounded and receive no idle global updates', { timeout: 15000 }, async () => {
  const root = temporary();
  for (let i = 0; i < 36; i++) {
    const dir = path.join(root, `synthetic-${i}`); mkdirSync(dir);
    const rows = [{ type: 'field-notes', fake: true, schemaVersion: 3, fieldNotes: request.fieldNotes, seats: [], options: {} },
      { type: 'stop', reason: 'human', rounds: 0 }, { type: 'verdict', skipped: true, reason: 'human', text: 'Stopped.' }];
    writeFileSync(path.join(dir, 'transcript.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  }
  const srv = await server(root);
  try {
    const first = await srv.get('/api/debates/synthetic-0/state');
    assert.equal((await srv.post('/api/pools/agy', { remaining: 2 })).status, 200);
    assert.equal((await srv.get('/api/debates/synthetic-0/state')).revision, first.revision, 'idle records get no pool event');
    for (let i = 1; i < 36; i++) await srv.get(`/api/debates/synthetic-${i}/state`);
    assert.notEqual((await srv.get('/api/debates/synthetic-0/state')).revision, first.revision, 'old inactive replay was rebuilt after eviction');
    assert.equal((await srv.get('/api/debates')).debates.length, 36);
  } finally { await srv.stop(); }
});
