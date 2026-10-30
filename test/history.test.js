import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dataDirectory, acquireDataLock, checkedHistoryPath, removeHistory, createUsageStore, createHistoryIndex } from '../src/history.js';
import { slugFor } from '../src/store.js';

const temporary = () => mkdtempSync(path.join(os.tmpdir(), 'rt-history-'));
function saved(root, id, rows) {
  const dir = path.join(root, id); mkdirSync(dir);
  writeFileSync(path.join(dir, 'transcript.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  return dir;
}

test('history summaries are cached, refreshed and asynchronously read without retaining replays', async () => {
  const root = temporary();
  const head = (decision) => ({ type: 'field-notes', schemaVersion: 3, fieldNotes: { decision, options: ['Trial', 'Wait'] }, seats: [], chairman: { vendor: 'claude' } });
  saved(root, 'one', [head('First')]);
  const index = createHistoryIndex(root, { limit: 2 });
  let yielded = false; const tick = new Promise((resolve) => setImmediate(() => { yielded = true; resolve(); }));
  const first = await index.list(); assert.equal(yielded, true); await tick;
  const second = await index.list(); assert.equal(second[0], first[0], 'unchanged summaries are reused');
  assert.equal('rounds' in first[0] && Array.isArray(first[0].rounds), false, 'no transcript/round bodies in the index');
  writeFileSync(path.join(root, 'one', 'transcript.jsonl'), JSON.stringify(head('A changed decision')) + '\n');
  assert.equal((await index.list())[0].decision, 'A changed decision');
  saved(root, 'two', [head('Second')]); saved(root, 'three', [head('Third')]);
  const overLimit = await index.list();
  const again = await index.list();
  assert.equal(overLimit.length, 3, 'cache bound does not hide records');
  assert.ok(again.filter((row) => overLimit.includes(row)).length >= 2, 'misses do not evict upcoming hits');
  const third = await index.list();
  assert.ok(third.filter((row) => again.includes(row)).length >= 2, 'a history above the limit does not thrash');
  removeHistory(root, 'one'); assert.equal((await index.list()).some((x) => x.slug === 'one'), false);
});

test('history summaries show corruption and torn tails without repairing the transcript', async () => {
  const root = temporary(), errors = [];
  const header = JSON.stringify({ type: 'field-notes', fieldNotes: { decision: 'Synthetic', options: ['Trial', 'Wait'] }, seats: [] });
  const dir = saved(root, 'torn', []), file = path.join(dir, 'transcript.jsonl'), original = header + '\n{"type":';
  writeFileSync(file, original);
  const index = createHistoryIndex(root, { onWarning: (e) => errors.push(e) });
  assert.match((await index.list())[0].warning, /incomplete final line/);
  assert.equal(readFileSync(file, 'utf8'), original);
  writeFileSync(file, header + '\nnot json\n');
  assert.equal((await index.list())[0].state, 'corrupt'); assert.equal(errors.length, 1);
});

test('default history lives in the OS data folder, with separate live and demo paths', () => {
  const root = temporary(), home = path.join(root, 'home');
  for (const platform of ['win32', 'darwin', 'linux']) {
    const live = dataDirectory({ home, platform, env: {} });
    assert.equal(path.basename(live), 'live');
    assert.equal(path.basename(dataDirectory({ home, platform, env: {}, fake: true })), 'demo');
    assert.ok(live.startsWith(home + path.sep));
  }
  assert.equal(dataDirectory({ home, platform: 'win32', env: { LOCALAPPDATA: root } }), path.join(root, 'Roundtable', 'live'));
  assert.equal(dataDirectory({ home, platform: 'linux', env: { XDG_DATA_HOME: root } }), path.join(root, 'roundtable', 'live'));
  assert.equal(dataDirectory({ env: { ROUNDTABLE_DEBATES_DIR: root }, fake: true }), root);
});

test('a data folder admits one server and refuses an unreadable lock', () => {
  const root = temporary(), release = acquireDataLock(root);
  assert.throws(() => acquireDataLock(root), /already open/);
  release();
  acquireDataLock(root)();
  writeFileSync(path.join(root, '_server.lock'), 'broken');
  assert.throws(() => acquireDataLock(root), /unreadable/);
  assert.equal(existsSync(path.join(root, '_server.starting')), false, 'failed startup releases the startup guard');
  unlinkSync(path.join(root, '_server.lock'));
  writeFileSync(path.join(root, '_server.starting'), 'another-startup');
  assert.throws(() => acquireDataLock(root), /Another server is starting/);
  assert.equal(readFileSync(path.join(root, '_server.starting'), 'utf8'), 'another-startup');
});

test('usage survives deletion and restart without retaining review content or counting mirrored replies twice', () => {
  const root = temporary(), id = 'synthetic-private-title';
  const head = { type: 'field-notes', fieldNotes: { decision: 'PRIVATE_DECISION', exportTo: 'PRIVATE_PATH' } };
  const attempt = { type: 'attempt', attemptId: 'one', round: 0, fresh: true, kind: 'reply',
    seat: { vendor: 'claude', model: 'sonnet', lens: 'PRIVATE_LENS', account: 'PRIVATE_ACCOUNT' },
    usage: { input: 10, cacheRead: 2, output: 5, cost: 0.3, usageVersion: 3 }, text: 'PRIVATE_REPLY', raw: 'PRIVATE_RAW' };
  saved(root, id, [head, attempt, { ...attempt, type: 'reply' },
    { type: 'attempt', round: 1, seat: attempt.seat, usage: null, cost: 0.1, raw: 'PRIVATE_RAW' }, { type: 'human', text: 'PRIVATE_NOTE' }]);
  saved(root, 'demo', [{ ...head, fake: true }, attempt]);
  const usage = createUsageStore(root); usage.sync();
  const before = usage.summary();
  assert.equal(before.reviews, 1);
  assert.equal(before.input, 10); assert.equal(before.cacheRead, 2);
  assert.deepEqual(before.tokenCoverage, { reported: 1, of: 2 });
  assert.equal(before.cost, 0.4);
  assert.equal(usage.baselines().claude.fresh.n, 1);
  const numeric = readFileSync(path.join(root, '_usage.json'), 'utf8');
  assert.doesNotMatch(numeric, /PRIVATE_|synthetic-private-title|attemptId|sessionId/);
  removeHistory(root, id);
  const reopened = createUsageStore(root); reopened.sync();
  assert.deepEqual(reopened.summary(), before);
  assert.deepEqual(reopened.baselines(), usage.baselines());
  assert.equal(readFileSync(path.join(root, '_usage.json'), 'utf8'), numeric, 'rescan does not duplicate retained samples');
});

test('recursive cleanup cannot leave the data directory or follow links', () => {
  const root = temporary(), outside = temporary();
  writeFileSync(path.join(outside, 'keep'), 'outside');
  const dir = saved(root, 'safe', [{ type: 'field-notes' }]);
  for (const id of ['..', '../outside', path.resolve(outside), '_usage.json', 'a/b', 'a\\b'])
    assert.throws(() => checkedHistoryPath(root, id));
  symlinkSync(outside, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => removeHistory(root, 'safe'), /contains a link/);
  symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => removeHistory(root, 'linked'), /real directory/);
  assert.equal(readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside');
  assert.ok(existsSync(path.join(dir, 'transcript.jsonl')));
});

test('new sessions cannot reuse a deleted session ID or its usage record', () => {
  const root = temporary(), first = slugFor('Same decision', root);
  saved(root, first, [{ type: 'field-notes' }]); removeHistory(root, first);
  assert.notEqual(slugFor('Same decision', root), first);
});
