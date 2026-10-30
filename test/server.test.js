// End to end over the real server with the scripted runner: no CLI is needed. Starts
// src/server.js --fake on a free port, posts a three-seat debate, reads the SSE stream to
// `done`, answers every gate through the API, then checks the transcript on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { rollup } from '../src/engine.js';
import { decisionRecord } from '../src/export.js';
import os from 'node:os';
import path from 'node:path';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on('error', reject);
});

async function startFakeServer(debatesDir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js', '--fake'], { env: { ...process.env, PORT: String(port), ROUNDTABLE_DEBATES_DIR: debatesDir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { log += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { log += d; });
  const t0 = Date.now();
  while (!/roundtable \(fake seats\)/.test(log)) {
    if (Date.now() - t0 > 15_000) throw new Error(`server did not start: ${log}`);
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${log}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const token = /token ([0-9a-f]{32})/.exec(log)?.[1];
  return { port, child, log: () => log, base: `http://127.0.0.1:${port}`, token };
}

// Read `data:` events from an SSE response until `until(event)` is true (or the stream ends).
// events.lastId is the last `id:` seen, what a browser would send back as Last-Event-ID.
async function readEvents(res, until, onEvent) {
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const id = chunk.split('\n').find((l) => l.startsWith('id: '));
      if (id) events.lastId = id.slice(4);
      const e = JSON.parse(line.slice(6));
      events.push(e);
      await onEvent?.(e);
      if (until(e)) { reader.cancel().catch(() => {}); return events; }
    }
  }
  return events;
}

test('the JSON agent checks without calls, answers grouped questions, rejects stale rounds and reads completion', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-agent-'));
  const srv = await startFakeServer(root);
  const agent = (command, args = [], body) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['src/cli.js', 'agent', command, '--port', String(srv.port), ...args, ...(body ? ['--input', '-'] : [])],
      { env: { ...process.env, ROUNDTABLE_TOKEN: '' }, windowsHide: true, timeout: 35_000 }, (error, stdout, stderr) => {
        try { resolve({ exit: error?.code || 0, result: JSON.parse(stdout) }); } catch { reject(new Error(`Agent did not return JSON: ${stderr}`)); }
      });
    child.stdin.end(body ? JSON.stringify(body) : '');
  });
  const body = { fieldNotes: { decision: 'Synthetic automated review', options: ['Trial', 'Wait'] },
    seats: [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost' }, { vendor: 'agy', lens: 'evidence' }],
    chairman: { vendor: 'claude', effort: 'low' }, options: { critiqueRounds: 1 } };
  try {
    assert.equal((await fetch(`${srv.base}/api/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
    const setup = await agent('status');
    assert.equal(setup.exit, 0); assert.equal(setup.result.mode, 'demo');
    const preview = await agent('check', [], body);
    assert.equal(preview.exit, 0); assert.equal(preview.result.plannedCalls, 7);
    assert.equal((await fetch(`${srv.base}/api/debates`).then((r) => r.json())).debates.length, 0);
    const started = await agent('start', [], body), id = started.result.id;
    assert.equal(started.exit, 0); assert.ok(id);
    assert.equal(started.result.board, `${srv.base}/#${id}`, 'a person can be handed the board link');
    const waiting = (await agent('wait', ['--id', id])).result;
    assert.equal(waiting.board, `${srv.base}/#${id}`);
    assert.equal(waiting.status, 'waiting'); assert.equal(waiting.gate.round, 0);
    assert.equal(waiting.gate.questions.length, 2);
    assert.equal(waiting.gate.questions.find((q) => q.sources.includes('risk')).sources.length, 2);
    assert.doesNotMatch(JSON.stringify(waiting), new RegExp(srv.token));
    assert.equal((await fetch(`${srv.base}/api/debates/${id}/state`, { headers: { origin: 'https://untrusted.example' } })).status, 403);
    const stale = await agent('answer', ['--id', id], { round: 1, answers: [{ id: 'q1', text: 'Not sent.' }] });
    assert.equal(stale.exit, 1); assert.equal(stale.result.status, 409);
    const answered = await agent('answer', ['--id', id], { round: 0, source: 'human', answers: [{ id: 'q1', text: 'The deadline can move by one week.' }] });
    assert.equal(answered.exit, 0);
    let done = (await agent('wait', ['--id', id])).result;
    if (done.status === 'waiting') {
      await agent('answer', ['--id', id], { round: done.gate.round, message: '' });
      done = (await agent('wait', ['--id', id])).result;
    }
    assert.equal(done.status, 'done'); assert.equal(done.verdict.status, 'ready'); assert.equal(done.gate, null);
    assert.deepEqual(done.actions, []);
    const transcript = readFileSync(path.join(root, id, 'transcript.jsonl'), 'utf8');
    assert.match(transcript, /The deadline can move by one week/);
    assert.doesNotMatch(transcript, /Not sent\./);
    const notes = transcript.trim().split('\n').map(JSON.parse).filter((r) => r.type === 'human');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].source, 'agent', 'the agent client cannot label its answers as human');
    const replay = await readEvents(await fetch(`${srv.base}/api/debates/${id}/events`), (e) => e.type === 'done');
    assert.equal(replay.find((e) => e.type === 'human').source, 'agent');
    const status = (await agent('status', ['--id', id])).result;
    assert.equal(status.verdict.status, 'ready');
    assert.equal(status.board, `${srv.base}/#${id}`);
    const help = (await agent('--help')).result;
    assert.ok(help.recipe?.lenses && help.recipe?.context, 'the help carries the small-review recipe');
    assert.match(help.recipe.isolation, /options\.allowLimitedIsolation=true/);
    assert.match(help.recipe.isolation, /user has agreed/);

    // Resume before round zero, stop at a gate, then reload from disk. All three CLI note
    // paths retain their source; a direct board-style request still defaults to human.
    const resumeId = 'synthetic-note-sources', dir = path.join(root, resumeId);
    mkdirSync(dir);
    const head = JSON.parse(transcript.split('\n')[0]);
    writeFileSync(path.join(dir, 'transcript.jsonl'), JSON.stringify({ ...head, deadlineAt: Date.now() + 60_000 }) + '\n');
    assert.equal((await agent('resume', ['--id', resumeId], { message: 'Coordinator setup note.' })).exit, 0);
    const resumed = (await agent('wait', ['--id', resumeId])).result;
    assert.equal(resumed.gate.round, 0);
    const post = (action, body) => fetch(`${srv.base}/api/debates/${resumeId}/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(body) });
    assert.equal((await post('continue', { round: 0, message: 'Do not save.', source: 'system' })).status, 400);
    assert.equal((await post('continue', { round: 0, message: 'Human supplied date.' })).status, 200);
    const next = (await agent('wait', ['--id', resumeId])).result;
    assert.equal(next.gate.round, 1);
    assert.equal((await agent('stop', ['--id', resumeId], { round: 1, message: 'Coordinator stopped discussion.' })).exit, 0);
    assert.equal((await agent('wait', ['--id', resumeId])).result.status, 'done');
    const saved = readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(saved.filter((r) => r.type === 'human').map((r) => [r.round, r.source, r.text]), [
      [-1, 'agent', 'Coordinator setup note.'], [0, 'human', 'Human supplied date.'], [1, 'agent', 'Coordinator stopped discussion.'],
    ]);
    const record = decisionRecord(saved, resumeId).markdown;
    assert.match(record, /\*\*Agent coordinator:\*\* Coordinator setup note\./);
    assert.match(record, /\*\*Human:\*\* Human supplied date\./);
    const originalExited = new Promise((resolve) => srv.child.once('exit', resolve)); srv.child.kill(); await originalExited;
    const restarted = await startFakeServer(root);
    try {
      const replayed = await readEvents(await fetch(`${restarted.base}/api/debates/${resumeId}/events`), (e) => e.type === 'done');
      assert.deepEqual(replayed.filter((e) => e.type === 'human').map((e) => e.source), ['agent', 'human', 'agent']);
    } finally { restarted.child.kill(); }
  } finally { srv.child.kill(); }
});

test('local diagnostics require the launch token, preserve error references and exclude request content', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-server-diagnostics-'));
  const srv = await startFakeServer(root);
  const headers = { 'content-type': 'application/json', 'x-roundtable-token': srv.token };
  const post = (p, body = {}, extra = {}) => fetch(`${srv.base}${p}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${srv.base}/api/diagnostics`)).status, 405);
    assert.equal((await post('/api/diagnostics', {}, { 'x-roundtable-token': '' })).status, 401);
    assert.equal((await post('/api/diagnostics/report', { events: [] }, { origin: 'https://foreign.example' })).status, 403);
    const invalid = await post('/api/debates', { fieldNotes: { decision: 'PRIVATE-MARKER' } });
    assert.equal(invalid.status, 400);
    const failure = await invalid.json();
    assert.equal(failure.diagnostic.saved, true);
    const id = 'RT-0123456789abcdef';
    const report = await post('/api/diagnostics/report', { events: [{ id, code: 'browser-error', action: 'create', line: 90,
      message: 'PRIVATE-MARKER', token: srv.token, url: 'https://private.example/path' }] }).then((r) => r.json());
    assert.deepEqual(report.saved, [id]);
    assert.equal((await post('/api/diagnostics/report', { events: [{ id, code: 'server-crash', action: 'create' }] })).status, 400);
    // A pool write failure must not report success or update the in-memory value.
    mkdirSync(path.join(root, '_pools.fake.json'));
    const pool = await post('/api/pools/claude', { remaining: 100, note: 'PRIVATE-MARKER' });
    assert.equal(pool.status, 500);
    assert.match((await pool.json()).error, /could not complete this action/);
    assert.equal((await fetch(`${srv.base}/api/seats`).then((r) => r.json())).pools.claude, undefined);
    const bundle = await post('/api/diagnostics').then((r) => r.json());
    assert.ok(bundle.entries.some((e) => e.id === failure.diagnostic.id && e.action === 'create'));
    assert.ok(bundle.entries.some((e) => e.id === id && e.line === 90));
    assert.ok(bundle.entries.some((e) => e.systemCode === 'EISDIR'));
    assert.doesNotMatch(JSON.stringify(bundle), new RegExp(`PRIVATE-MARKER|private\\.example|${srv.token}`));
    assert.equal((await fetch(`${srv.base}/api/debates`).then((r) => r.json())).debates.length, 0, 'the log directory never becomes a review');
  } finally { srv.child.kill(); }
});

test('an empty added lens is a field error before calls; corrected seats start and replay is marked', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-seat-validation-'));
  const srv = await startFakeServer(root);
  const post = (p, body = {}) => fetch(`${srv.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(body) });
  try {
    const body = { fieldNotes: { decision: 'Synthetic starter lens check', options: ['Trial', 'Wait'] },
      seats: [{ vendor: 'claude', lens: 'risk' }, { vendor: 'claude', lens: 'cost' }, { vendor: 'claude', lens: '' }],
      chairman: { vendor: 'claude', effort: 'medium' }, options: { critiqueRounds: 0, autoContinueMs: 5000, wallClockMs: 300000, memory: 'stateless', budget: {} } };
    const invalid = await post('/api/debates', body);
    assert.equal(invalid.status, 400);
    const problem = await invalid.json();
    assert.deepEqual([problem.field, problem.seatIndex], ['lens', 2]);
    assert.match(problem.error, /Seat 3 needs a lens/);
    assert.equal((await fetch(`${srv.base}/api/debates`).then((r) => r.json())).debates.length, 0);
    const diagnostics = await post('/api/diagnostics').then((r) => r.json());
    const logged = diagnostics.entries.find((e) => e.id === problem.diagnostic.id);
    assert.equal(logged.systemCode, 'SEAT_LENS_REQUIRED');
    assert.equal(logged.seatIndex, 2);
    body.seats[2].lens = 'evidence';
    const opened = await post('/api/debates', body).then((r) => r.json());
    assert.ok(opened.slug);
    const events = await readEvents(await fetch(`${srv.base}/api/debates/${opened.slug}/events`), (e) => e.type === 'done', async (e) => {
      if (e.type === 'gate') await post(`/api/debates/${opened.slug}/continue`);
    });
    assert.ok(events.some((e) => e.type === 'reply' && !e.replayed), 'new replies can use the visual reveal');
    const replay = await readEvents(await fetch(`${srv.base}/api/debates/${opened.slug}/events`), (e) => e.type === 'done');
    assert.ok(replay.filter((e) => ['reply', 'verdict'].includes(e.type)).every((e) => e.replayed), 'saved replies do not animate again');
  } finally { srv.child.kill(); }
});

test('a board that reconnects gets what it missed as new events; a fresh board gets history', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-reconnect-'));
  const srv = await startFakeServer(root);
  const post = (p, body = {}) => fetch(`${srv.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(body) });
  const stream = (headers = {}) => fetch(`${srv.base}/api/debates/${slug}/events`, { headers });
  let slug;
  try {
    ({ slug } = await post('/api/debates', { fieldNotes: { decision: 'Synthetic reconnect check', options: ['Trial', 'Wait'] },
      seats: [{ vendor: 'claude', lens: 'risk' }, { vendor: 'claude', lens: 'cost' }],
      chairman: { vendor: 'claude', effort: 'medium' }, options: { critiqueRounds: 1, autoContinueMs: 400, wallClockMs: 300000, memory: 'stateless', budget: {} } }).then((r) => r.json()));
    // The board watches until the first gate, then its connection drops.
    const before = await readEvents(await stream(), (e) => e.type === 'gate');
    assert.ok(before.lastId, 'every event carries an id');
    // No event has been missed: the browser still needs headers now so EventSource can open
    // and clear its reconnecting state without a human action advancing the review.
    const idle = await fetch(`${srv.base}/api/debates/${slug}/events`, {
      headers: { 'last-event-id': before.lastId }, signal: AbortSignal.timeout(2000),
    });
    assert.equal(idle.status, 200);
    assert.match(idle.headers.get('content-type'), /text\/event-stream/);
    await idle.body.cancel();
    // Another client moves the review on, and it finishes while the board is away.
    await readEvents(await stream(), (e) => e.type === 'done' && !e.replayed, async (e) => { if (e.type === 'gate') await post(`/api/debates/${slug}/continue`); });
    const missed = await readEvents(await stream({ 'last-event-id': before.lastId }), (e) => e.type === 'done');
    assert.ok(!missed.some((e) => e.type === 'started'), 'only what came after the last id is resent');
    assert.ok(missed.every((e) => !e.replayed), 'what the board missed is new to it, so the ending can show and sound');
    const fresh = await readEvents(await stream(), (e) => e.type === 'done');
    assert.ok(fresh.some((e) => e.type === 'started') && fresh.every((e) => e.replayed), 'a board opened afterwards only sees history');
    const stale = await readEvents(await stream({ 'last-event-id': '999:0' }), (e) => e.type === 'done');
    assert.ok(stale.some((e) => e.type === 'started') && stale.every((e) => e.replayed), 'an id from another server run gets the full history, marked as history');
  } finally { srv.child.kill(); }
});

test('only the board can unlock a hidden mood; an agent request gets plain custom text', { timeout: 30_000 }, async () => {
  const { HIDDEN_MOODS, LIGHTEST } = await import('../src/seats.js');
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-hidden-'));
  const srv = await startFakeServer(root);
  const headers = { 'content-type': 'application/json', 'x-roundtable-token': srv.token };
  const code = HIDDEN_MOODS[0].codes[0];
  const body = (n) => ({ fieldNotes: { decision: `Synthetic hidden mood check ${n}`, options: ['Trial', 'Wait'] },
    seats: [{ vendor: 'claude', lens: 'risk', model: 'opus', effort: 'high', mood: { preset: 'custom', text: code } }, { vendor: 'codex', lens: 'cost' }],
    chairman: { vendor: 'claude', effort: 'low' }, options: { critiqueRounds: 0 } });
  const seatsOf = async (extra, n) => {
    const { slug } = await fetch(`${srv.base}/api/debates`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body(n)) }).then((r) => r.json());
    const events = await readEvents(await fetch(`${srv.base}/api/debates/${slug}/events`), (e) => e.type === 'started');
    return events.find((e) => e.type === 'started').seats;
  };
  try {
    const [agentSeat] = await seatsOf({}, 1);
    assert.deepEqual([agentSeat.mood.hidden, agentSeat.model, agentSeat.effort], [undefined, 'opus', 'high'], 'no Origin: the agent client and scripts never unlock one');
    const browserHeaders = { origin: srv.base, 'sec-fetch-site': 'same-origin' };
    const [headersOnly] = await seatsOf(browserHeaders, 2);
    assert.equal(headersOnly.mood.hidden, undefined, 'browser-like headers without the page cookie are not the board');
    const page = await fetch(`${srv.base}/`);
    const boardCookie = /rt_board=[0-9a-f]{32}/.exec(page.headers.get('set-cookie') || '')?.[0];
    assert.match(page.headers.get('set-cookie') || '', /HttpOnly/i, 'scripts on the page cannot read it');
    const [wrongCookie] = await seatsOf({ ...browserHeaders, cookie: 'rt_board=0000' }, 3);
    assert.equal(wrongCookie.mood.hidden, undefined);
    const [boardSeat] = await seatsOf({ ...browserHeaders, cookie: boardCookie }, 4);
    assert.deepEqual([boardSeat.mood.hidden, boardSeat.model, boardSeat.effort], [HIDDEN_MOODS[0].art, LIGHTEST.claude, 'low'], 'the board page does, locked to the cheapest model');
  } finally { srv.child.kill(); }
});

test('history and replay preserve unknown usage; a restart cannot bypass its token cap', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-unknown-server-'));
  const slug = '2026-10-26-unknown';
  const dir = path.join(root, slug); mkdirSync(dir);
  const seat = { id: 'seat-0', vendor: 'codex', lens: 'cost', colour: 'olive', index: 0 };
  const rows = [
    { type: 'field-notes', fake: true, schemaVersion: 3, fieldNotes: { decision: 'Unknown usage?', options: ['Ship', 'Wait'] },
      seats: [seat], chairman: { vendor: 'codex' }, options: { critiqueRounds: 1, budget: { codex: { tokens: 100_000 } } } },
    { type: 'attempt', attemptId: 'unknown', seat, round: 0, kind: 'reply', usage: null, unknown: true, ms: 12 },
  ];
  writeFileSync(path.join(dir, 'transcript.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  const srv = await startFakeServer(root);
  try {
    const list = (await fetch(`${srv.base}/api/debates`).then((r) => r.json())).debates;
    assert.equal(list[0].tokens, null, 'unknown is not a measured zero');
    assert.equal(list[0].tokensPartial, true);
    const before = await readEvents(await fetch(`${srv.base}/api/debates/${slug}/events`), (e) => e.type === 'interrupted');
    assert.deepEqual(rollup(before).total.tokenCoverage, { reported: 0, of: 1 });
    const response = await fetch(`${srv.base}/api/debates/${slug}/resume`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: '{}' });
    assert.equal(response.status, 200);
    const after = await readEvents(await fetch(`${srv.base}/api/debates/${slug}/events`), (e) => e.type === 'done');
    assert.equal(after.filter((e) => e.type === 'attempt').length, 1, 'no call was dispatched after restart');
    assert.equal(after.find((e) => e.type === 'budget').kind, 'tokens-unknown');
    assert.equal(after.find((e) => e.type === 'stopped').reason, 'budget');
  } finally { srv.child.kill(); }
});

test('a torn record replays with a warning, resumes with an exact backup, and exports its recovery notice', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-recovery-server-'));
  const slug = '2026-10-26-recovery';
  const dir = path.join(root, slug); mkdirSync(dir);
  const file = path.join(dir, 'transcript.jsonl');
  const seats = [{ id: 'seat-0', vendor: 'claude', lens: 'risk', colour: 'rust', index: 0 }, { id: 'seat-1', vendor: 'codex', lens: 'cost', colour: 'olive', index: 1 }];
  const original = Buffer.from(JSON.stringify({ type: 'field-notes', schemaVersion: 3, fake: true,
    fieldNotes: { decision: 'Recovery check?', options: ['Ship', 'Wait'] }, seats, chairman: { vendor: 'claude' },
    options: { critiqueRounds: 0, memory: 'stateless' } }) + '\n{"type":"attempt","usage":');
  writeFileSync(file, original);
  let srv = await startFakeServer(root);
  const post = (p, body = {}) => fetch(`${srv.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(body) });
  try {
    const listed = (await fetch(`${srv.base}/api/debates`).then((r) => r.json())).debates[0];
    assert.equal(listed.state, 'interrupted');
    assert.match(listed.warning, /incomplete final line 2/);
    const before = await readEvents(await fetch(`${srv.base}/api/debates/${slug}/events`), (e) => e.type === 'interrupted');
    assert.equal(before.find((e) => e.type === 'transcript-warning').line, 2);
    assert.deepEqual(readFileSync(file), original, 'GET history and replay are read-only');
    assert.deepEqual(readdirSync(dir), ['transcript.jsonl']);
    assert.equal((await post(`/api/debates/${slug}/resume`, { message: 'Correction before the first round.' })).status, 200);
    const events = await readEvents(await fetch(`${srv.base}/api/debates/${slug}/events`), (e) => e.type === 'done' && !e.replayed, async (e) => {
      if (e.type === 'gate') assert.equal((await post(`/api/debates/${slug}/continue`)).status, 200);
    });
    const recovery = events.find((e) => e.type === 'transcript-warning' && e.backup);
    assert.ok(recovery);
    assert.deepEqual(readFileSync(path.join(dir, recovery.backup)), original);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.type === 'human' && r.round === -1 && r.text === 'Correction before the first round.'));
    assert.equal(rows.filter((r) => r.type === 'field-notes').length, 1);
    assert.equal(rows.filter((r) => r.type === 'transcript-recovered').length, 1);
    // A later interrupted acceptance must not be hidden by the older recovery notice.
    const secondTornWrite = Buffer.concat([readFileSync(file), Buffer.from('{"type":"accepted","option":')]);
    writeFileSync(file, secondTornWrite);
    const exited = new Promise((resolve) => srv.child.once('exit', resolve)); srv.child.kill(); await exited;
    srv = await startFakeServer(root);
    const replay = await readEvents(await fetch(`${srv.base}/api/debates/${slug}/events`), (e) => e.type === 'done');
    assert.ok(replay.some((e) => e.type === 'human' && e.round === -1 && e.text === 'Correction before the first round.'));
    assert.equal(replay.find((e) => e.type === 'transcript-warning').backup, recovery.backup);
    assert.equal(replay.filter((e) => e.type === 'transcript-warning').at(-1).code, 'TRANSCRIPT_TAIL');
    const target = mkdtempSync(path.join(os.tmpdir(), 'rt-recovery-export-'));
    const exported = await post(`/api/debates/${slug}/export`, { target });
    assert.equal(exported.status, 200);
    const result = await exported.json();
    const record = readFileSync(result.path, 'utf8');
    assert.match(record, /## Record recovery/);
    assert.ok(record.includes(recovery.backup));
    assert.match(record, /incomplete final line/);
    assert.deepEqual(readFileSync(file), secondTornWrite, 'export discloses the incomplete suffix without changing its source');
    assert.equal(readdirSync(dir).filter((f) => f.startsWith('transcript.recovery-')).length, 1);
  } finally { srv.child.kill(); }
});

test('completed corrupt records stay visible, report their line, and cannot resume or export', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-corrupt-server-'));
  const head = { type: 'field-notes', fake: true, schemaVersion: 3, fieldNotes: { decision: 'Damaged record?', options: ['A', 'B'] }, seats: [], options: {} };
  const badSlug = '2026-10-26-corrupt', goodSlug = '2026-10-26-healthy';
  for (const slug of [badSlug, goodSlug]) mkdirSync(path.join(root, slug));
  const file = path.join(root, badSlug, 'transcript.jsonl');
  const original = JSON.stringify(head) + '\ninvalid private content\n' + JSON.stringify({ type: 'stop', reason: 'human', rounds: 0 }) + '\n';
  writeFileSync(file, original);
  writeFileSync(path.join(root, goodSlug, 'transcript.jsonl'), JSON.stringify(head) + '\n');
  const srv = await startFakeServer(root);
  try {
    const list = (await fetch(`${srv.base}/api/debates`).then((r) => r.json())).debates;
    assert.equal(list.length, 2, 'one bad record does not hide the healthy one or disappear itself');
    const bad = list.find((r) => r.slug === badSlug);
    assert.equal(bad.state, 'corrupt');
    assert.match(bad.warning, /line 2.*backup/);
    assert.ok(!bad.warning.includes('invalid private content'), 'diagnostics do not echo transcript contents');
    const events = await readEvents(await fetch(`${srv.base}/api/debates/${badSlug}/events`), (e) => e.type === 'error');
    assert.equal(events[0].fatal, true);
    for (const action of ['resume', 'export']) {
      const response = await fetch(`${srv.base}/api/debates/${badSlug}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: '{}' });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /line 2/);
    }
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.deepEqual(readdirSync(path.dirname(file)), ['transcript.jsonl']);
  } finally { srv.child.kill(); }
});

test('fake server end to end: three seats, gates answered through the API, transcript and strip events on disk and on the wire', { timeout: 90_000 }, async () => {
  const debatesDir = mkdtempSync(path.join(os.tmpdir(), 'rt-debates-'));
  const srv = await startFakeServer(debatesDir);
  try {
    const body = {
      fieldNotes: { decision: 'Integration: ship the new checkout?', options: ['Ship now', 'Wait a sprint'], constraints: 'two devs' },
      seats: [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost', mood: 'builder' }, { vendor: 'agy', lens: 'customer' }],
      chairman: { vendor: 'claude' },
      options: { critiqueRounds: 1, autoContinueMs: 400 },
    };
    const post = async (p, b) => { const r = await fetch(`${srv.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(b) }); return { ok: r.ok, body: await r.json() }; };
    const seatsApi = await (await fetch(`${srv.base}/api/seats`)).json();
    assert.equal(seatsApi.vendors.length, 4); // three CLIs and the API endpoint vendor
    assert.deepEqual(seatsApi.vendors.map((v) => v.kind), ['cli', 'cli', 'cli', 'api'], 'every vendor says whether it is a CLI or an API');
    assert.equal(seatsApi.vendors.find((v) => v.vendor === 'api').profiles, true, 'API pools are per endpoint host');
    assert.equal(seatsApi.defaults.memory, 'stateless');
    assert.equal(seatsApi.defaults.critiqueRounds, 1, 'the default review has one critique round');
    assert.deepEqual(seatsApi.runtime, { mode: 'demo', dataDir: debatesDir, diagnostics: { available: true, dropped: 0 } });
    assert.ok(srv.log().includes(`data: ${debatesDir}`));
    const page = await fetch(`${srv.base}/`).then((r) => r.text());
    assert.match(page, /id="run-mode"/);
    assert.doesNotMatch(page, /https:\/\/fonts\./, 'the board needs no remote font request');
    const guide = await fetch(`${srv.base}/docs/workflow.md`);
    assert.equal(guide.status, 200);
    assert.match(guide.headers.get('content-type'), /^text\/plain/);
    assert.match(await guide.text(), /### Back up and restore/);
    const started = await post('/api/debates', body);
    assert.ok(started.ok, JSON.stringify(started.body));
    const slug = started.body.slug;
    assert.match(slug, /^\d{4}-\d{2}-\d{2}-integration-ship-the-new-checkout-[a-f0-9]{32}$/);

    const gates = [];
    const stream = await fetch(`${srv.base}/api/debates/${slug}/events`);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const events = await readEvents(stream, (e) => e.type === 'done' || e.type === 'error', async (e) => {
      if (e.type === 'gate') {
        gates.push(e);
        // round 0 gets a note; later gates (a seat's question, or the countdown) continue
        const r = await post(`/api/debates/${slug}/continue`, { message: e.round === 0 ? 'Mind the deadline' : '' });
        assert.equal(r.body.ok, true);
      }
    });
    assert.equal(events.at(-1).type, 'done', srv.log());
    assert.equal(gates[0].round, 0);
    assert.equal(gates[0].mode, 'blocking');

    const types = events.map((e) => e.type);
    assert.equal(events.find((e) => e.type === 'started').seats.length, 3);
    assert.equal(events.filter((e) => e.type === 'reply').length, 6, 'three seats, two rounds');
    // every reply names its attempt; the attempt carries the usage
    const attemptsLive = events.filter((e) => e.type === 'attempt');
    assert.ok(events.filter((e) => e.type === 'reply').every((e) => e.usage === undefined && attemptsLive.some((a) => a.attemptId === e.attemptId && a.usage.input > 0)), 'every reply names an attempt with usage');
    assert.ok(attemptsLive.some((a) => a.kind === 'reprompt'), 'the fake agy seat is re-prompted in round 0');
    assert.ok(events.some((e) => e.type === 'seat-state' && e.state === 'thinking'));
    assert.ok(events.some((e) => e.type === 'seat-state' && e.state === 'replied'));
    assert.ok(events.some((e) => e.type === 'round-done' && e.positions), 'positions ride on round-done');
    assert.ok(events.some((e) => e.type === 'human' && e.text === 'Mind the deadline'));
    assert.ok(types.includes('quota'), 'the fake quota reaches the strip');
    // codex is read at boot and after each reply, so its round 0 is measured; claude's first
    // reading arrives with its first reply, so its round 1 is the first measured one
    const measured = events.filter((e) => e.type === 'calibration' && e.round != null && e.tokens > 0).map((e) => `${e.vendor}:${e.round}`);
    assert.ok(measured.includes('codex:0'), `rounds were measured against the fake windows: ${measured}`);
    assert.ok(measured.includes('claude:1'), `claude's second round is measured: ${measured}`);
    assert.ok(types.includes('stopped'));
    assert.ok(types.includes('verdict'));
    assert.ok(events.find((e) => e.type === 'verdict').text.includes('RECOMMENDATION'));

    // the transcript on disk
    const file = path.join(debatesDir, slug, 'transcript.jsonl');
    assert.ok(existsSync(file));
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const head = rows[0];
    assert.equal(head.type, 'field-notes');
    assert.equal(head.schemaVersion, 3);
    assert.equal(head.fake, true, 'the fake server marks its head row');
    assert.equal(head.seats.length, 3);
    assert.equal(head.options.memory, 'stateless');
    const replies = rows.filter((r) => r.type === 'reply');
    assert.equal(replies.length, 6);
    assert.ok(replies.every((r) => r.fresh === true && r.sessionId && r.state), 'stateless rows: fresh, with the session the runner reported and a state');
    assert.ok(rows.some((r) => r.type === 'stop'));
    assert.ok(rows.some((r) => r.type === 'verdict' && r.text));
    assert.ok(existsSync(path.join(debatesDir, slug, 'verdict.md')));
    assert.ok(existsSync(path.join(debatesDir, slug, 'field-notes.md')));
    assert.ok(existsSync(path.join(debatesDir, '_calibration.fake.json')), 'the fake board measures into its own file');
    assert.ok(!existsSync(path.join(debatesDir, '_calibration.json')));

    // a second board connecting after the fact replays everything, ending in done
    const again = await fetch(`${srv.base}/api/debates/${slug}/events`);
    const replay = await readEvents(again, (e) => e.type === 'done');
    assert.equal(replay[0].type, 'quota');
    assert.ok(replay.some((e) => e.type === 'started'));
    assert.equal(replay.filter((e) => e.type === 'reply').length, 6);
    // one ledger, three readers: the live board, a replaying board, and the transcript (which the
    // decision record reads) all reconcile exactly, re-prompt included
    const live = rollup(events), replayed = rollup(replay), disk = rollup(rows);
    for (const k of ['input', 'cacheRead', 'cacheWrite', 'output']) {
      assert.equal(live.total[k], disk.total[k], `live = transcript: ${k}`);
      assert.equal(replayed.total[k], disk.total[k], `replay = transcript: ${k}`);
    }
    assert.equal(rows.filter((r) => r.type === 'attempt').length, attemptsLive.length, 'one attempt row per call');
    const record = decisionRecord(rows, slug).markdown;
    assert.ok(record.includes(`| **debate** | ${disk.total.input.toLocaleString('en-US')} |`), 'the record total is the transcript total');
    // and a stop on a finished debate is refused
    const refused = await post(`/api/debates/${slug}/stop`, {});
    assert.equal(refused.ok, false);
  } finally {
    srv.child.kill();
  }
});

test('local API boundary: token, Host, Origin, method, content type and size are all enforced', { timeout: 30_000 }, async () => {
  const debatesDir = mkdtempSync(path.join(os.tmpdir(), 'rt-debates-'));
  const srv = await startFakeServer(debatesDir);
  try {
    assert.match(srv.token || '', /^[0-9a-f]{32}$/, 'the startup line prints the launch token');
    const body = JSON.stringify({ fieldNotes: { decision: 'Boundary?', options: ['A', 'B'] }, seats: [{ vendor: 'claude', lens: 'one' }, { vendor: 'codex', lens: 'two' }], chairman: { vendor: 'claude' } });
    const json = { 'content-type': 'application/json' };
    const call = (p, init = {}) => fetch(`${srv.base}${p}`, { method: 'POST', body, ...init, headers: { ...json, 'x-roundtable-token': srv.token, ...(init.headers || {}) } }).then((r) => r.status);
    assert.equal(await call('/api/debates', { headers: { 'x-roundtable-token': '' } }), 401, 'no token');
    assert.equal(await call('/api/debates', { headers: { 'x-roundtable-token': 'f'.repeat(32) } }), 401, 'wrong token');
    assert.equal(await call('/api/debates', { headers: { origin: 'https://evil.example' } }), 403, 'foreign Origin');
    assert.equal(await call('/api/debates', { headers: { 'content-type': 'text/plain' } }), 415, 'text/plain');
    assert.equal(await call('/api/debates', { body: 'x'.repeat(300 * 1024) }), 413, 'over the body limit');
    assert.equal(await fetch(`${srv.base}/api/debates/x/continue`).then((r) => r.status), 405, 'GET on a mutation route');
    // a DNS-rebound name reaches the socket with a foreign Host header
    const http = await import('node:http');
    const hostStatus = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/seats', headers: { host: `rebound.example:${srv.port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostStatus, 403, 'bad Host');
    // a streamed body with no content-length is cut off at the limit too
    const streamed = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/debates', method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token, 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      for (let i = 0; i < 40; i++) req.write('x'.repeat(8 * 1024));
      req.end();
    });
    assert.equal(streamed, 413, 'streamed body over the limit');
    // the page carries the token; the same request with it is accepted
    const pageRes = await fetch(`${srv.base}/`);
    const page = await pageRes.text();
    assert.ok(page.includes(`content="${srv.token}"`), 'the served page carries the token');
    // every response, page, asset, API and error alike, forbids foreign scripts, sniffing and framing
    for (const [name, res] of [['page', pageRes], ['asset', await fetch(`${srv.base}/ui/app.js`)], ['api', await fetch(`${srv.base}/api/seats`)],
      ['error', await fetch(`${srv.base}/api/debates/x/continue`)]]) {
      const csp = res.headers.get('content-security-policy') || '';
      assert.match(csp, /(^|; )script-src 'self'(;|$)/, `${name}: only this server's scripts run`);
      assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/, `${name}: the page cannot be framed`);
      assert.doesNotMatch(csp, /script-src[^;]*unsafe/, `${name}: no inline or eval scripts`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${name}: no sniffing`);
    }
    assert.equal(await call('/api/debates', { headers: { origin: srv.base } }), 200, 'same-origin with the token');
  } finally {
    srv.child.kill();
  }
});

test('after a restart, a debate whose verdict was skipped gets one through /synthesize: only the chairman runs', { timeout: 60_000 }, async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const debatesDir = mkdtempSync(path.join(os.tmpdir(), 'rt-debates-'));
  const slug = '2026-10-20-synthesize-after-restart';
  const seats = [{ id: 'seat-0', vendor: 'claude', lens: 'risk', colour: 'rust', index: 0 }, { id: 'seat-1', vendor: 'codex', lens: 'cost', colour: 'olive', index: 1 }];
  const reply = (seat, stance) => ({ type: 'reply', round: 0, seat, text: `STANCE: ${stance}\nAGREE_WITH: []\nDISAGREE:\n- x\nNEW:\n- none\nASSUMPTIONS:\n- y`, parsed: { pass: false, stance, agreeWith: [], disagree: ['x'], new: ['none'], assumptions: ['y'], question: null }, valid: true, errors: [], stanceKey: stance, attemptId: `a-${seat.id}`, reprompted: false, failed: false, fresh: true, sessionId: `s-${seat.id}` });
  const attempt = (seat) => ({ type: 'attempt', attemptId: `a-${seat.id}`, round: 0, kind: 'reply', seat, fresh: true, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, cost: null, usageVersion: 3 } });
  const rowsOnDisk = [
    { type: 'field-notes', schemaVersion: 3, fake: true, fieldNotes: { decision: 'Synthesize after restart?', options: ['Ship now', 'Wait a sprint'] }, seats, chairman: { vendor: 'claude' }, options: { critiqueRounds: 0 }, deadlineAt: 1 },
    attempt(seats[0]), reply(seats[0], 'opt-1'), attempt(seats[1]), reply(seats[1], 'opt-2'),
    { type: 'stop', reason: 'wall-clock', rounds: 1 },
    { type: 'verdict', seat: null, text: 'Verdict not written: the wall clock ran out.', usage: null, skipped: true, reason: 'wall-clock' },
  ];
  mkdirSync(path.join(debatesDir, slug));
  writeFileSync(path.join(debatesDir, slug, 'transcript.jsonl'), rowsOnDisk.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const srv = await startFakeServer(debatesDir);
  try {
    const post = (p) => fetch(`${srv.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: '{}' });
    const r = await post(`/api/debates/${slug}/synthesize`);
    assert.equal(r.status, 200, await r.clone().text());
    const stream = await fetch(`${srv.base}/api/debates/${slug}/events`);
    const events = await readEvents(stream, (e) => e.type === 'done' && !e.replayed);
    const done = events.at(-1);
    assert.equal(done.synthesis, 'done');
    assert.equal(done.reason, 'wall-clock', 'the original stop reason is kept');
    const after = readFileSync(path.join(debatesDir, slug, 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const added = after.slice(rowsOnDisk.length);
    assert.deepEqual([...new Set(added.filter((x) => x.type === 'attempt').map((x) => x.seat.id))], ['chairman'], 'only the chairman ran');
    assert.ok(added.some((x) => x.type === 'synthesize'));
    const verdict = added.filter((x) => x.type === 'verdict').at(-1);
    assert.ok(verdict && !verdict.skipped && !verdict.failed);
    const again = await post(`/api/debates/${slug}/synthesize`);
    assert.equal(again.status, 400, 'a debate with its verdict is not synthesized twice');
  } finally {
    srv.child.kill();
  }
});

test('a seat on a named profile gets its own quota pool', { timeout: 60_000 }, async () => {
  const debatesDir = mkdtempSync(path.join(os.tmpdir(), 'rt-debates-'));
  const srv = await startFakeServer(debatesDir);
  try {
    const body = { fieldNotes: { decision: 'Profiles?', options: ['A', 'B'] }, seats: [{ vendor: 'claude', lens: 'one' }, { vendor: 'codex', lens: 'two', account: 'work' }], chairman: { vendor: 'claude' }, options: { critiqueRounds: 0 } };
    const r = await fetch(`${srv.base}/api/debates`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(body) }).then((x) => x.json());
    const stream = await fetch(`${srv.base}/api/debates/${r.slug}/events`);
    const events = await readEvents(stream, (e) => e.type === 'quota' && e.vendor === 'codex@work');
    assert.ok(events.some((e) => e.type === 'quota' && e.vendor === 'codex@work'), 'the work profile is read as its own pool');
  } finally {
    srv.child.kill();
  }
});

test('accept is refused before the debate is done, checks the option, and is recorded apart from the recommendation', { timeout: 60_000 }, async () => {
  const debatesDir = mkdtempSync(path.join(os.tmpdir(), 'rt-debates-'));
  const srv = await startFakeServer(debatesDir);
  try {
    const post = (p, b) => fetch(`${srv.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(b) });
    const body = { fieldNotes: { decision: 'Accept flow?', options: ['Ship now', 'Wait a sprint'] }, seats: [{ vendor: 'claude', lens: 'one' }, { vendor: 'codex', lens: 'two' }], chairman: { vendor: 'claude' }, options: { critiqueRounds: 0 } };
    const { slug } = await post('/api/debates', body).then((r) => r.json());
    assert.equal((await post(`/api/debates/${slug}/accept`, { option: 'opt-1' })).status, 400, 'refused while the debate runs');
    const stream = await fetch(`${srv.base}/api/debates/${slug}/events`);
    await readEvents(stream, (e) => e.type === 'done', async (e) => { if (e.type === 'gate') await post(`/api/debates/${slug}/continue`, {}); });
    assert.equal((await post(`/api/debates/${slug}/accept`, { option: 'opt-9' })).status, 400, 'an option the debate does not have');
    const ok = await post(`/api/debates/${slug}/accept`, { option: 'opt-2', note: 'Busy week.' });
    assert.equal(ok.status, 200);
    const rows = readFileSync(path.join(debatesDir, slug, 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const acc = rows.find((r) => r.type === 'accepted');
    assert.deepEqual({ option: acc.option, note: acc.note }, { option: 'opt-2', note: 'Busy week.' });
    assert.equal(decisionRecord(rows, slug).meta.status, 'accepted');
  } finally {
    srv.child.kill();
  }
});

test('GET /api/debates lists the debates on disk with the status and pick the record would carry', { timeout: 60_000 }, async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const debatesDir = mkdtempSync(path.join(os.tmpdir(), 'rt-debates-'));
  const seats = [{ id: 'seat-0', vendor: 'claude', lens: 'risk', colour: 'rust', index: 0 }, { id: 'seat-1', vendor: 'codex', lens: 'cost', colour: 'olive', index: 1 }];
  const reply = (seat) => ({ type: 'reply', round: 0, seat, text: 'STANCE: opt-1', parsed: { pass: false, stance: 'opt-1', agreeWith: [], disagree: [], new: [], assumptions: [], question: null }, valid: true, errors: [], stanceKey: 'opt-1', attemptId: `a-${seat.id}`, failed: false });
  const attempt = (seat, id = seat.id) => ({ type: 'attempt', attemptId: `a-${id}`, round: 0, kind: 'reply', seat, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, cost: seat.vendor === 'claude' ? 0.02 : null, usageVersion: 3 } });
  const slug = '2026-10-20-listed';
  mkdirSync(path.join(debatesDir, slug));
  writeFileSync(path.join(debatesDir, slug, 'transcript.jsonl'), [
    { type: 'field-notes', schemaVersion: 3, fieldNotes: { decision: 'Listed?', options: ['Yes', 'No'] }, seats, chairman: { vendor: 'claude' }, options: {} },
    attempt(seats[0]), reply(seats[0]), attempt(seats[1]), reply(seats[1]),
    { type: 'stop', reason: 'consensus', rounds: 1 },
    { type: 'verdict', seat: { id: 'chairman', vendor: 'claude', lens: 'chairman' }, text: 'RECOMMENDATION: opt-1\nWhy.\nDISSENT: x\nKILL_CRITERIA:\n- y\nOPEN_QUESTIONS:\n- z' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const srv = await startFakeServer(debatesDir);
  try {
    const { debates } = await fetch(`${srv.base}/api/debates`).then((r) => r.json());
    assert.equal(debates.length, 1);
    const d = debates[0];
    assert.deepEqual({ slug: d.slug, decision: d.decision, state: d.state, status: d.status, recommended: d.recommended, rounds: d.rounds, seats: d.seats, tokens: d.tokens, costPartial: d.costPartial },
      { slug, decision: 'Listed?', state: 'finished', status: 'recommended', recommended: 'Yes', rounds: 1, seats: 2, tokens: 220, costPartial: true });
    const foreign = await fetch(`${srv.base}/api/debates`, { headers: { origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403, 'the list is readable only from this page');
  } finally {
    srv.child.kill();
  }
});

test('GET preflight is cached-only; authenticated POST refreshes and GET fresh cannot execute checks', { timeout: 60_000 }, async () => {
  const srv = await startFakeServer(mkdtempSync(path.join(os.tmpdir(), 'rt-debates-')));
  try {
    const { pools } = await fetch(`${srv.base}/api/preflight?pools=claude,codex,codex@work,nope@x,BAD!`).then((r) => r.json());
    assert.deepEqual(pools.map((p) => p.key), ['claude', 'codex', 'codex@work', 'nope@x']);
    assert.ok(pools.slice(0, 3).every((p) => p.state === 'idle' && p.checkedAt === null), 'GET does not run a missing check');
    assert.equal(pools[3].kind, 'missing');
    const body = JSON.stringify({ pools: ['claude', 'codex', 'codex@work'], fresh: true });
    const noToken = await fetch(`${srv.base}/api/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(noToken.status, 401);
    const forcedGet = await fetch(`${srv.base}/api/preflight?pools=claude,codex&fresh=1`).then((r) => r.json());
    assert.ok(forcedGet.pools.every((p) => p.checkedAt === null), 'a query flag cannot authorize execution');
    const refreshed = await fetch(`${srv.base}/api/preflight`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body }).then((r) => r.json());
    assert.ok(refreshed.pools.every((p) => p.installed && p.loggedIn === true && p.checkedAt > 0 && !p.stale));
    const cached = await fetch(`${srv.base}/api/preflight?pools=claude,codex,codex@work&fresh`).then((r) => r.json());
    assert.deepEqual(cached.pools, refreshed.pools, 'GET returns the exact saved checks');
    const forbidden = await fetch(`${srv.base}/api/preflight`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token, origin: 'https://foreign.example' }, body });
    assert.equal(forbidden.status, 403);
  } finally {
    srv.child.kill();
  }
});

test('POST /api/preflight takes API pools with their endpoint and key variable, needs the launch token, and sends nothing out', { timeout: 60_000 }, async () => {
  const srv = await startFakeServer(mkdtempSync(path.join(os.tmpdir(), 'rt-debates-')));
  try {
    const body = { pools: ['claude', 'api@localhost-11434', 'api@api.deepseek.com'], endpoints: { 'api@localhost-11434': { url: 'http://localhost:11434/v1' }, 'api@api.deepseek.com': { url: 'https://api.deepseek.com/v1', keyEnv: 'RT_TEST_KEY_THAT_IS_NOT_SET' } } };
    const noToken = await fetch(`${srv.base}/api/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(noToken.status, 401, 'an endpoint check names a variable of this process: token required');
    const { pools } = await fetch(`${srv.base}/api/preflight`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(body) }).then((r) => r.json());
    assert.deepEqual(pools.map((p) => p.key), ['claude', 'api@localhost-11434', 'api@api.deepseek.com']);
    assert.deepEqual(pools.slice(1).map((p) => p.state), ['ok', 'danger']);
    assert.match(pools[1].note, /API · local · checked on the first call/);
    assert.match(pools[2].note, /RT_TEST_KEY_THAT_IS_NOT_SET is not set/);
    // GET knows nothing about endpoints: an API pool answers idle, never a probe
    const viaGet = await fetch(`${srv.base}/api/preflight?pools=api@localhost-11434`).then((r) => r.json());
    assert.equal(viaGet.pools[0].state, 'idle');
  } finally {
    srv.child.kill();
  }
});

test('a verdict that failed for quota can be written with another chairman', { timeout: 60_000 }, async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const debatesDir = mkdtempSync(path.join(os.tmpdir(), 'rt-debates-'));
  const slug = '2026-10-21-another-chairman';
  const seats = [{ id: 'seat-0', vendor: 'claude', lens: 'risk', colour: 'rust', index: 0 }, { id: 'seat-1', vendor: 'codex', lens: 'cost', colour: 'olive', index: 1 }];
  const reply = (seat) => ({ type: 'reply', round: 0, seat, text: 'STANCE: opt-1', parsed: { pass: false, stance: 'opt-1', agreeWith: [], disagree: [], new: [], assumptions: [], question: null }, valid: true, errors: [], stanceKey: 'opt-1', failed: false });
  mkdirSync(path.join(debatesDir, slug));
  writeFileSync(path.join(debatesDir, slug, 'transcript.jsonl'), [
    { type: 'field-notes', schemaVersion: 3, fake: true, fieldNotes: { decision: 'Another chairman?', options: ['Yes', 'No'] }, seats, chairman: { vendor: 'claude' }, options: { critiqueRounds: 0 } },
    reply(seats[0]), reply(seats[1]), { type: 'stop', reason: 'consensus', rounds: 1 },
    { type: 'pool-down', key: 'claude@', vendor: 'claude', kind: 'quota', message: 'Claude: usage limit reached.' },
    { type: 'verdict', seat: { id: 'chairman', vendor: 'claude', lens: 'chairman' }, text: 'Chairman failed: Claude: usage limit reached.', failed: true, errorKind: 'quota' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const srv = await startFakeServer(debatesDir);
  try {
    const post = (b) => fetch(`${srv.base}/api/debates/${slug}/synthesize`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(b) });
    assert.equal((await post({ chairman: { vendor: 'nope' } })).status, 400);
    assert.equal((await post({ chairman: { vendor: 'agy' } })).status, 200);
    const events = await readEvents(await fetch(`${srv.base}/api/debates/${slug}/events`), (e) => e.type === 'done' && !e.replayed);
    assert.ok(events.some((e) => e.type === 'pool-down' && e.vendor === 'claude'), 'the replay carries the login that went down');
    assert.equal(events.find((e) => e.type === 'verdict' && e.failed).errorKind, 'quota', 'replay keeps the reason for the failed chairman');
    const v = events.filter((e) => e.type === 'verdict').at(-1);
    assert.equal(v.seat.vendor, 'agy');
    assert.ok(!v.failed);
  } finally {
    srv.child.kill();
  }
});

test('Stop cancels all work at a gate and during automatic or manual verdicts', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-stop-all-'));
  let srv = await startFakeServer(root);
  const post = (p, body = {}) => fetch(`${srv.base}${p}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(body) });
  const getState = (slug) => fetch(`${srv.base}/api/debates/${slug}/state`).then((r) => r.json());
  try {
    for (const atGate of [true, false]) {
      const created = await post('/api/debates', { fieldNotes: { decision: `Synthetic Stop ${atGate ? 'gate' : 'chairman'}`, options: ['Trial', 'Wait'] },
        seats: [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost' }], options: { critiqueRounds: 0 } });
      const { slug } = await created.json(), route = `/api/debates/${slug}`;
      await readEvents(await fetch(`${srv.base}${route}/events`), (e) => e.type === 'gate');
      if (!atGate) {
        assert.equal((await post(`${route}/continue`, { round: 0 })).status, 200);
        await readEvents(await fetch(`${srv.base}${route}/events`), (e) => e.type === 'chairman-start');
      }
      const before = await getState(slug);
      assert.equal(before.status, atGate ? 'waiting' : 'verdict');
      assert.ok(before.actions.includes('stop'));
      const cancelled = await post(`${route}/stop`, { round: 1, message: 'Stop the review now.', answers: [{ id: 'q1', text: 'Stale question draft.' }] });
      assert.equal(cancelled.status, 200, 'a stale question must not prevent cancellation');
      assert.match((await cancelled.json()).warning, /Question answers were not submitted/);
      const ended = await readEvents(await fetch(`${srv.base}${route}/events`, { headers: { 'last-event-id': before.revision } }), (e) => e.type === 'done');
      assert.equal(ended.at(-1).cancelled, true);
      assert.equal(ended.at(-1).reason, atGate ? 'human' : before.stopReason);
      assert.equal(ended.at(-1).synthesis, 'skipped');
      const file = path.join(root, slug, 'transcript.jsonl');
      const rows = () => readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(rows().find((r) => r.type === 'human').text, 'Stop the review now.');
      assert.doesNotMatch(readFileSync(file, 'utf8'), /Stale question draft/);
      assert.equal(rows().filter((r) => r.type === 'attempt' && r.seat.id === 'chairman').length, atGate ? 0 : 1);

      assert.equal((await post(`${route}/synthesize`)).status, 200);
      const active = await getState(slug);
      assert.equal(active.status, 'verdict', 'manual synthesis is active, not a finished review');
      assert.deepEqual(active.actions, ['wait', 'stop']);
      assert.equal((await post(`${route}/synthesize`)).status, 400, 'no duplicate synthesis');
      assert.equal((await post(`${route}/stop`, { message: 'Cancel the requested verdict too.' })).status, 200);
      const stopped = await readEvents(await fetch(`${srv.base}${route}/events`, { headers: { 'last-event-id': active.revision } }), (e) => e.type === 'done');
      assert.equal(stopped.at(-1).cancelled, true);
      assert.equal((await getState(slug)).verdict.status, 'skipped');
      const attempts = rows().filter((r) => r.type === 'attempt' && r.seat.id === 'chairman');
      assert.equal(attempts.length, atGate ? 1 : 2);
      assert.ok(attempts.every((r) => r.cancelReason === 'human'));
      const exited = new Promise((resolve) => srv.child.once('exit', resolve)); srv.child.kill(); await exited;
      srv = await startFakeServer(root);
      const replay = await getState(slug);
      assert.equal(replay.status, 'done');
      assert.equal(replay.stopReason, atGate ? 'human' : before.stopReason);
      assert.equal(replay.verdict.status, 'skipped');
      assert.deepEqual(replay.actions, ['verdict'], 'only an explicit request can start another call');
    }
  } finally { srv.child.kill(); }
});

test('history cleanup protects live calls, preserves exports and statistics, and clears the full confirmed selection', { timeout: 45_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-cleanup-'));
  const target = mkdtempSync(path.join(os.tmpdir(), 'rt-cleanup-export-'));
  const ids = Array.from({ length: 55 }, (_, i) => `saved-${i}`);
  const seats = [{ id: 'seat-0', vendor: 'claude', lens: 'risk', colour: 'rust', index: 0 }];
  const head = { type: 'field-notes', schemaVersion: 3, fieldNotes: { decision: 'PRIVATE_CLEANUP_TEST', options: ['Trial', 'Wait'] },
    seats, chairman: { vendor: 'claude' }, options: { critiqueRounds: 0 } };
  const reply = { type: 'reply', round: 0, seat: seats[0], valid: true, failed: false, stanceKey: 'opt-1',
    text: 'STANCE: opt-1\nAGREE_WITH: []\nDISAGREE: none\nNEW: bounded trial\nASSUMPTIONS: budget',
    parsed: { agreeWith: [], disagree: ['none'], new: ['bounded trial'], assumptions: ['budget'] },
    usage: { input: 10, output: 5, cost: 0.01, usageVersion: 3 } };
  for (const id of [...ids, 'interrupted']) {
    mkdirSync(path.join(root, id));
    writeFileSync(path.join(root, id, 'transcript.jsonl'), [head, reply,
      ...(id === 'interrupted' ? [] : [{ type: 'stop', reason: 'human', rounds: 1 }, { type: 'verdict', skipped: true, reason: 'human' }])].map(JSON.stringify).join('\n') + '\n');
  }
  writeFileSync(path.join(root, '_pools.json'), '{}');
  let srv = await startFakeServer(root);
  const post = (p, body = {}) => fetch(`${srv.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(body) });
  const list = () => fetch(`${srv.base}/api/debates`).then((r) => r.json());
  try {
    assert.equal((await list()).debates.length, 56, 'history cleanup includes sessions beyond the former 50-row limit');
    assert.equal((await fetch(`${srv.base}/api/debates/saved-0/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${srv.base}/api/debates/clear-finished`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token, origin: 'https://foreign.example' }, body: JSON.stringify({ ids }) })).status, 403);
    assert.equal((await fetch(`${srv.base}/api/debates/saved-0/delete`)).status, 405);
    const exported = await post('/api/debates/saved-0/export', { target });
    assert.equal(exported.status, 200);
    const exportPaths = await exported.json();
    const exportBytes = readFileSync(exportPaths.path), indexBytes = readFileSync(exportPaths.indexPath);

    const created = await post('/api/debates', { fieldNotes: { decision: 'Synthetic live cleanup protection', options: ['Trial', 'Wait'] },
      seats: [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost' }], options: { critiqueRounds: 0 } });
    const activeId = (await created.json()).slug, activeRoute = `/api/debates/${activeId}`;
    await readEvents(await fetch(`${srv.base}${activeRoute}/events`), (e) => e.type === 'gate');
    assert.equal((await post(`${activeRoute}/delete`)).status, 409, 'waiting for answers is still active');
    assert.equal((await post('/api/debates/clear-finished', { ids: ['saved-0', activeId] })).status, 409);
    assert.ok(existsSync(path.join(root, 'saved-0', 'transcript.jsonl')), 'a refused batch removes nothing');
    assert.equal((await post('/api/debates/clear-finished', { ids: ['saved-0', 'interrupted'] })).status, 409);

    assert.equal((await post('/api/debates/saved-0/synthesize')).status, 200);
    assert.equal((await post('/api/debates/saved-0/delete')).status, 409, 'manual chairman calls are protected');
    assert.equal((await post('/api/debates/saved-0/stop')).status, 200);
    await readEvents(await fetch(`${srv.base}/api/debates/saved-0/events`), (e) => e.type === 'done' && e.cancelled === true);

    const statsPath = path.join(root, '_usage.json'), numeric = readFileSync(statsPath, 'utf8');
    unlinkSync(statsPath); mkdirSync(statsPath);
    assert.equal((await post('/api/debates/saved-0/delete')).status, 500, 'statistics must be durable before removal');
    assert.ok(existsSync(path.join(root, 'saved-0', 'transcript.jsonl')));
    rmdirSync(statsPath); writeFileSync(statsPath, numeric);

    const before = await list();
    const baseline = (await fetch(`${srv.base}/api/seats`).then((r) => r.json())).baselines;
    const watching = readEvents(await fetch(`${srv.base}/api/debates/saved-0/events`), (e) => e.type === 'deleted');
    assert.equal((await post('/api/debates/saved-0/delete')).status, 200);
    assert.equal((await watching).at(-1).type, 'deleted', 'other open tabs learn that the record was deleted');
    assert.equal((await fetch(`${srv.base}/api/debates/saved-0/state`)).status, 404, 'the cached session is removed too');
    assert.equal((await post('/api/debates/clear-finished', { ids: ids.slice(1) })).status, 200);
    const after = await list();
    assert.deepEqual(after.usage, before.usage);
    assert.equal(after.debates.length, 2);
    assert.equal(after.debates.find((d) => d.slug === activeId).state, 'running');
    assert.equal(after.debates.find((d) => d.slug === 'interrupted').state, 'interrupted');
    assert.deepEqual(readFileSync(exportPaths.path), exportBytes);
    assert.deepEqual(readFileSync(exportPaths.indexPath), indexBytes);
    assert.equal(readFileSync(path.join(root, '_pools.json'), 'utf8'), '{}');
    assert.doesNotMatch(readFileSync(statsPath, 'utf8'), /PRIVATE_CLEANUP_TEST|bounded trial|saved-0/);
    assert.deepEqual((await fetch(`${srv.base}/api/seats`).then((r) => r.json())).baselines, baseline);

    assert.equal((await post(`${activeRoute}/continue`, { round: 0 })).status, 200);
    await readEvents(await fetch(`${srv.base}${activeRoute}/events`), (e) => e.type === 'chairman-start');
    assert.equal((await post(`${activeRoute}/delete`)).status, 409, 'automatic chairman calls are protected');
    assert.equal((await post(`${activeRoute}/stop`)).status, 200);
    await readEvents(await fetch(`${srv.base}${activeRoute}/events`), (e) => e.type === 'done');
    const kept = (await list()).usage;
    const exited = new Promise((resolve) => srv.child.once('exit', resolve)); srv.child.kill(); await exited;
    srv = await startFakeServer(root);
    assert.deepEqual((await list()).usage, kept, 'restart neither forgets nor double counts deleted reviews');
    assert.deepEqual((await fetch(`${srv.base}/api/seats`).then((r) => r.json())).baselines, baseline);
  } finally { srv.child.kill(); }
});

test('the agent can finish a discussion after its first round, but cannot request an empty verdict', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-finish-'));
  const srv = await startFakeServer(root);
  const post = (p, body = {}) => fetch(`${srv.base}${p}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(body) });
  try {
    const created = await post('/api/debates', { fieldNotes: { decision: 'Synthetic early verdict', options: ['Trial', 'Wait'] },
      seats: [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost' }], options: { critiqueRounds: 3 } });
    const { slug } = await created.json(), route = `/api/debates/${slug}`;
    assert.equal((await post(`${route}/finish`)).status, 409, 'no completed blind round yet');
    await readEvents(await fetch(`${srv.base}${route}/events`), (e) => e.type === 'gate');
    const state = await fetch(`${srv.base}${route}/state`).then((r) => r.json());
    assert.ok(state.actions.includes('finish'));
    assert.equal((await post(`${route}/continue`, { round: 0, message: 'Consider a smaller trial.' })).status, 200);
    await readEvents(await fetch(`${srv.base}${route}/events`), (e) => e.type === 'round-start' && e.round === 1);
    const result = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['src/cli.js', 'agent', 'finish', '--port', String(srv.port), '--id', slug, '--input', '-'],
        { env: { ...process.env, ROUNDTABLE_TOKEN: '' }, windowsHide: true }, (error, stdout) => {
          if (error) reject(error); else resolve(JSON.parse(stdout));
        });
      child.stdin.end(JSON.stringify({ message: 'Use the collected replies.' }));
    });
    assert.equal(result.ok, true);
    const events = await readEvents(await fetch(`${srv.base}${route}/events`), (e) => e.type === 'done');
    assert.equal(events.at(-1).reason, 'finish');
    assert.equal(events.at(-1).synthesis, 'done');
    assert.equal(events.at(-1).cancelled, false);
    const rows = readFileSync(path.join(root, slug, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter((r) => r.type === 'attempt' && r.seat.id === 'chairman').length, 1);
    assert.ok(rows.some((r) => r.type === 'attempt' && r.cancelReason === 'finish'));
    assert.ok(rows.some((r) => r.type === 'human' && r.source === 'agent' && r.text === 'Use the collected replies.'));
    assert.ok(!events.some((e) => e.type === 'round-start' && e.round >= 2));
    const empty = await post('/api/debates', { fieldNotes: { decision: 'Synthetic empty abort', options: ['Trial', 'Wait'] },
      seats: [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost' }], options: { critiqueRounds: 0 } });
    const emptyId = (await empty.json()).slug, emptyRoute = `/api/debates/${emptyId}`;
    assert.equal((await post(`${emptyRoute}/stop`)).status, 200);
    await readEvents(await fetch(`${srv.base}${emptyRoute}/events`), (e) => e.type === 'done');
    const emptyState = await fetch(`${srv.base}${emptyRoute}/state`).then((r) => r.json());
    assert.deepEqual(emptyState.actions, [], 'empty results do not advertise a verdict action');
    const refused = await post(`${emptyRoute}/synthesize`);
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /No usable replies/);
    const emptyRows = readFileSync(path.join(root, emptyId, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(!emptyRows.some((r) => r.type === 'attempt' && r.seat.id === 'chairman'));
  } finally { srv.child.kill(); }
});

test('a retired model is refused at debate start, with what to use instead', { timeout: 60_000 }, async () => {
  const srv = await startFakeServer(mkdtempSync(path.join(os.tmpdir(), 'rt-debates-')));
  try {
    const body = { fieldNotes: { decision: 'Retired?', options: ['A', 'B'] }, seats: [{ vendor: 'claude', lens: 'one' }, { vendor: 'codex', lens: 'two', model: 'gpt-5.5' }], chairman: { vendor: 'claude' } };
    const r = await fetch(`${srv.base}/api/debates`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': srv.token }, body: JSON.stringify(body) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Codex retired gpt-5\.5 \(2026-10-14\); use gpt-6\.1-sol/);
  } finally {
    srv.child.kill();
  }
});
