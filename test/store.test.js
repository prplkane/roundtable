import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDebateDir, rebuildDebate, readAllTranscripts } from '../src/store.js';
import { createDebate } from '../src/engine.js';

const FN = { decision: 'Ship?', options: ['Ship now', 'Wait a sprint'] };
const SEATS = [
  { id: 'seat-0', vendor: 'claude', lens: 'risk', colour: 'rust', index: 0 },
  { id: 'seat-1', vendor: 'codex', lens: 'cost', colour: 'olive', index: 1 },
  { id: 'seat-2', vendor: 'agy', lens: 'customer', colour: 'teal', index: 2 },
];
const text = (stance) => `STANCE: ${stance}\nAGREE_WITH: []\nDISAGREE:\n- x\nNEW:\n- none\nASSUMPTIONS:\n- y`;
const reply = (seat, round, stance, extra = {}) => ({
  type: 'reply', round, seat, text: text(stance), parsed: { pass: false, stance, agreeWith: [], disagree: ['x'], new: ['none'], assumptions: ['y'], question: null },
  valid: true, errors: [], stanceKey: stance, question: null, usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, thinking: 0, cost: null, ms: 1 },
  reprompted: false, failed: false, fresh: round === 0, sessionId: `sess-${seat.id}`, ...extra,
});
const VERDICT_OK = 'RECOMMENDATION: opt-1\nShip.\nTALLY:\n- opt-1: all\nDISSENT: none raised\nKILL_CRITERIA:\n- x\nOPEN_QUESTIONS:\n- y';
const head = (options = {}) => ({ type: 'field-notes', schemaVersion: 2, fieldNotes: FN, seats: SEATS, chairman: { vendor: 'codex' }, options: { critiqueRounds: 2, memory: 'resume', ...options } });

test('rebuildDebate: a finished transcript replays read-only with the same event shapes as the live engine', () => {
  const rows = [
    head(),
    reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Wait a sprint'), reply(SEATS[2], 0, 'Ship now'),
    { type: 'human', round: 0, text: 'Mind the deadline' },
    reply(SEATS[0], 1, 'Ship now'), reply(SEATS[1], 1, 'Ship now'), reply(SEATS[2], 1, 'Ship now'),
    { type: 'stop', reason: 'consensus', rounds: 2 },
    { type: 'verdict', seat: { id: 'chairman', vendor: 'codex', lens: 'chairman' }, text: 'RECOMMENDATION: ship', usage: { input: 1, output: 1 } },
  ];
  const rb = rebuildDebate(rows);
  assert.equal(rb.finished, true);
  assert.equal(rb.stopReason, 'consensus');
  assert.equal(rb.rounds.length, 2);
  assert.equal(rb.nextRound, 2);
  assert.deepEqual(rb.humanNotes, [['Mind the deadline']]);
  assert.deepEqual(rb.seats.map((s) => s.sessionId), ['sess-seat-0', 'sess-seat-1', 'sess-seat-2']);
  const R3 = ['reply', 'seat-state', 'reply', 'seat-state', 'reply', 'seat-state'];
  assert.deepEqual(rb.events.map((e) => e.type), [
    'started', 'round-start', ...R3, 'round-done', 'human',
    'round-start', ...R3, 'round-done', 'stopped', 'chairman-start', 'verdict', 'done',
  ]);
  assert.deepEqual(rb.events[3], { type: 'seat-state', round: 0, seat: SEATS[0], state: 'replied' });
  assert.deepEqual(rb.events[8].positions, { 'seat-0': 'agreed', 'seat-1': 'disagreed', 'seat-2': 'agreed' }, 'positions are recomputed from the rows');
  assert.equal(rb.events[0].replayed, true);
  assert.equal(rb.events.at(-1).reason, 'consensus');
  assert.equal(rebuildDebate([{ type: 'human', round: 0, text: 'x' }]), null, 'no field-notes row, nothing to rebuild');
  // a verdict the budget skipped replays as skipped, with no chairman-start
  const skipped = rebuildDebate([head(), reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Ship now'), reply(SEATS[2], 0, 'Ship now'),
    { type: 'budget', vendor: 'codex', what: 'verdict' }, { type: 'stop', reason: 'budget', rounds: 1 }, { type: 'verdict', seat: null, text: 'Verdict not written: the chairman call would cross the budget.', usage: null, skipped: true }]);
  assert.equal(skipped.finished, true);
  assert.deepEqual(skipped.events.slice(-3).map((e) => e.type), ['stopped', 'verdict', 'done']);
  assert.equal(skipped.events.at(-2).skipped, true);
});

test('rebuildDebate: an unfinished transcript is interrupted; a partial round is dropped and the last reply per seat wins', async () => {
  const rows = [
    head(),
    reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Wait a sprint'), reply(SEATS[2], 0, 'Ship now'),
    reply(SEATS[0], 1, 'Ship now'), // round 1 started, two seats never answered
  ];
  const rb = rebuildDebate(rows);
  assert.equal(rb.finished, false);
  assert.equal(rb.rounds.length, 1);
  assert.equal(rb.partialRound, 1);
  assert.equal(rb.nextRound, 1);
  // the partial round's one call was paid for: it replays as an attempt, so the board's ledger is whole
  assert.deepEqual(rb.events.map((e) => e.type), ['started', 'round-start', 'reply', 'seat-state', 'reply', 'seat-state', 'reply', 'seat-state', 'round-done', 'attempt', 'interrupted']);
  assert.deepEqual(rb.events.at(-1), { type: 'interrupted', round: 1, partialRound: 1, resumedBefore: 0 });
  // a seat answered twice in round 0 (re-run after an earlier interruption): the later row counts
  const twice = rebuildDebate([head(), reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Ship now'), reply(SEATS[2], 0, 'Ship now'), reply(SEATS[0], 0, 'Wait a sprint', { sessionId: 'sess-later' })]);
  assert.equal(twice.rounds[0][0].stanceKey, 'opt-2', 'a 0.2.0 label is read as its id, so a resumed debate compares like with like');
  assert.equal(twice.seats[0].sessionId, 'sess-later');
  const { rollup } = await import('../src/engine.js');
  assert.equal(rollup(twice.events).total.input, 40, 'the superseded reply was paid for and replays as an attempt');
  // interrupted during the verdict: every round complete, nothing stopped
  const atVerdict = rebuildDebate([head({ critiqueRounds: 0 }), reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Wait a sprint'), reply(SEATS[2], 0, 'Ship now')]);
  assert.equal(atVerdict.finished, false);
  assert.equal(atVerdict.nextRound, 1);
});

test('the engine resumes from the first incomplete round without a second field-notes row, and resumes recorded sessions in resume mode', async () => {
  const rows = [
    head(),
    reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Wait a sprint'), reply(SEATS[2], 0, 'Ship now'),
    reply(SEATS[1], 1, 'Ship now'),
  ];
  const rb = rebuildDebate(rows);
  const calls = [], appended = [], events = [];
  const runner = async (vendor, prompt, sessionId, opts) => { calls.push({ vendor, sessionId, prompt, seat: opts.seat.id }); return { text: text('Ship now'), usage: { input: 1, output: 1 }, sessionId: `new-${opts.seat.id}` }; };
  const d = createDebate({
    fieldNotes: rb.fieldNotes, seats: rb.seats, chairman: rb.chairman, options: rb.options, resume: { rounds: rb.rounds, humanNotes: rb.humanNotes },
    runner, gate: async () => ({ action: 'continue' }), store: { append: (r) => appended.push(r), writeFieldNotes() { throw new Error('must not rewrite'); }, writeVerdict() {} },
    emit: (t, p) => events.push(p),
  });
  const s = await d.run();
  assert.equal(events[0].type, 'resumed');
  assert.equal(events[0].from, 1);
  assert.ok(!appended.some((r) => r.type === 'field-notes'));
  assert.equal(appended[0].type, 'resumed');
  const r1 = calls.filter((c) => /^Round 1 of/m.test(c.prompt));
  assert.equal(r1.length, 3, 'the partial round 1 is re-run for every seat');
  assert.deepEqual(r1.map((c) => c.sessionId), ['sess-seat-0', 'sess-seat-1', 'sess-seat-2'], 'resume mode continues the recorded sessions');
  assert.ok(r1.every((c) => /### Seat: /.test(c.prompt)), 'round 1 sees the round-0 replies from the transcript');
  assert.equal(s.rounds.length, 2, 'round 0 kept, round 1 unanimous: consensus');
  assert.equal(s.stopReason, 'consensus');
  assert.ok(s.verdict.text);
  // stateless resume: sessions are not handed back to the CLI
  const calls2 = [];
  const d2 = createDebate({
    fieldNotes: rb.fieldNotes, seats: rb.seats, chairman: rb.chairman, options: { ...rb.options, memory: 'stateless' }, resume: { rounds: rb.rounds, humanNotes: rb.humanNotes },
    runner: async (v, p, sid, o) => { calls2.push(sid); return { text: text('Ship now'), usage: {}, sessionId: 'x' }; }, gate: async () => ({ action: 'continue' }), store: { append() {}, writeVerdict() {} },
  });
  await d2.run();
  assert.ok(calls2.every((sid) => sid === null));
});

test('the engine resumed after a round that already met a stop goes straight to the verdict; a noted round-0 consensus reopens', async () => {
  const unanimous = [head({ critiqueRounds: 2 }), reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Ship now'), reply(SEATS[2], 0, 'Ship now')];
  const run = async (rows, extraNote) => {
    const rb = rebuildDebate(rows);
    if (extraNote) rb.humanNotes[0] = [extraNote];
    const calls = [];
    const d = createDebate({
      fieldNotes: rb.fieldNotes, seats: rb.seats, chairman: rb.chairman, options: rb.options, resume: { rounds: rb.rounds, humanNotes: rb.humanNotes },
      runner: async (v, p, sid, o) => { calls.push(p); return { text: /chairman/.test(p) ? VERDICT_OK : text('Ship now'), usage: {}, sessionId: 'x' }; }, gate: async () => ({ action: 'continue' }), store: { append() {}, writeVerdict() {} },
    });
    return { s: await d.run(), calls };
  };
  const a = await run(unanimous);
  assert.equal(a.s.stopReason, 'consensus');
  assert.equal(a.calls.length, 1, 'only the chairman was called');
  assert.match(a.calls[0], /chairman/);
  const b = await run(unanimous, 'Think about mobile');
  assert.equal(b.s.rounds.length, 2, 'the note reopened round 1');
  assert.ok(b.calls.slice(0, 3).every((p) => p.includes('Think about mobile')));
});

test('openDebateDir writes rows the rebuild reads back; create:false returns null for a slug with no transcript', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-store-'));
  assert.equal(openDebateDir(root, 'nope', { create: false }), null);
  const store = openDebateDir(root, '2026-10-20-ship');
  store.append(head());
  for (const s of SEATS) store.append(reply(s, 0, 'Ship now'));
  const again = openDebateDir(root, '2026-10-20-ship', { create: false });
  const rows = again.readTranscript();
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.t), 'every row is stamped');
  const rb = rebuildDebate(rows);
  assert.equal(rb.finished, false);
  assert.equal(rb.nextRound, 1);
  assert.equal(readAllTranscripts(root).length, 4);
});

test('legacy usage is normalised at read time, once: codex input loses its cached part, version 3 rows are left alone', async () => {
  const { normaliseRows } = await import('../src/store.js');
  const legacy = { type: 'reply', round: 0, seat: { vendor: 'codex', id: 'seat-1' }, usage: { input: 23380, cacheRead: 13440, output: 20 } };
  const claude = { type: 'reply', round: 0, seat: { vendor: 'claude', id: 'seat-0' }, usage: { input: 2, cacheRead: 6637, output: 4 } };
  const fresh = { type: 'reply', round: 1, seat: { vendor: 'codex', id: 'seat-1' }, usage: { input: 9940, cacheRead: 13440, output: 20, usageVersion: 3 } };
  const once = normaliseRows([legacy, claude, fresh]);
  assert.equal(once[0].usage.input, 9940);
  assert.equal(once[1].usage.input, 2);
  assert.equal(once[2].usage.input, 9940, 'an appended version-3 row is not reduced again');
  assert.deepEqual(normaliseRows(once), once, 'normalising twice changes nothing');
});

test('an interrupted transcript rebuilds a ledger with its partial round and a lone re-prompt, and carries it into the resumed engine', async () => {
  const { rollup } = await import('../src/engine.js');
  const rows = [
    head(),
    reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Wait a sprint'), reply(SEATS[2], 0, 'Ship now'),
    // round 1 was cut off: one reply, and a re-prompt whose second call never returned
    reply(SEATS[0], 1, 'Ship now'),
    { type: 'reprompt', round: 1, seat: SEATS[1], errors: ['missing STANCE line'], text: 'rambling', usage: { input: 7, cacheRead: 0, cacheWrite: 0, output: 3, cost: null } },
  ];
  const rb = rebuildDebate(rows);
  assert.equal(rb.rounds.length, 1, 'round 1 is partial');
  assert.equal(rb.ledger.length, 5, 'three round-0 replies, the partial reply, the lone re-prompt');
  assert.equal(rollup(rows).total.input, 47);
  assert.equal(rollup(rb.events).total.input, 47, 'the replaying board sees the same ledger');
  // the resumed engine starts from that ledger. Codex spent 25 before the restart (15 + the lone
  // re-prompt's 10); a 50 cap admits round 1 (25 + 15) and refuses round 2 (40 + 15). Counting
  // only complete rounds (15 spent) would have let both run.
  const calls = [];
  const d = createDebate({ fieldNotes: FN, seats: rb.seats, chairman: { vendor: 'claude' }, runner: async (v, p) => { calls.push(v); return { text: text(v === 'codex' ? 'Wait a sprint' : 'Ship now').replace('NEW:\n- none', 'NEW:\n- a new angle'), usage: { input: 10, output: 5 } }; },
    gate: async () => ({ action: 'continue' }), store: { append() {} }, options: { critiqueRounds: 2, budget: { codex: { tokens: 50 } } },
    baselines: { codex: { fresh: { input: 10, output: 5, n: 1 }, resumed: { input: 10, output: 5, n: 1 } } }, resume: { rounds: rb.rounds, humanNotes: rb.humanNotes, ledger: rb.ledger } });
  const s = await d.run();
  assert.equal(s.stopReason, 'budget');
  assert.equal(s.rounds.length, 2, 'round 1 ran, round 2 did not');
});

test('two notes after one round are both kept on replay', () => {
  const rb = rebuildDebate([head(), reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Wait a sprint'), reply(SEATS[2], 0, 'Ship now'),
    { type: 'human', round: 0, text: 'First' }, { type: 'human', round: 0, text: 'Second, on resume' }]);
  assert.deepEqual(rb.humanNotes[0], ['First', 'Second, on resume']);
  assert.deepEqual(rb.events.filter((e) => e.type === 'human').map((e) => e.text), ['First', 'Second, on resume']);
});

test('finished and synthesis are separate: a stop without a verdict, a skipped verdict, a failed one, and a later verdict that supersedes', () => {
  const base = [head(), reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Wait a sprint'), reply(SEATS[2], 0, 'Ship now'), { type: 'stop', reason: 'wall-clock', rounds: 1 }];
  const missing = rebuildDebate(base);
  assert.equal(missing.finished, true);
  assert.equal(missing.synthesis, 'missing');
  assert.equal(missing.stopReason, 'wall-clock');
  const skipped = rebuildDebate([...base, { type: 'verdict', seat: null, text: 'Verdict not written: the wall clock ran out.', skipped: true, reason: 'wall-clock' }]);
  assert.equal(skipped.synthesis, 'skipped');
  const failedRows = [...base, { type: 'verdict', seat: { id: 'chairman', vendor: 'codex', lens: 'chairman' }, text: 'garbled', failed: true, errors: ['missing TALLY section'] }];
  const failed = rebuildDebate(failedRows);
  assert.equal(failed.synthesis, 'failed');
  const ev = failed.events.find((e) => e.type === 'verdict');
  assert.equal(ev.failed, true);
  assert.deepEqual(ev.errors, ['missing TALLY section']);
  const later = rebuildDebate([...base, { type: 'verdict', seat: null, text: 'Verdict not written.', skipped: true }, { type: 'synthesize', stopReason: 'wall-clock' }, { type: 'verdict', seat: { id: 'chairman', vendor: 'codex', lens: 'chairman' }, text: VERDICT_OK }]);
  assert.equal(later.synthesis, 'done', 'the later verdict row supersedes the skipped one');
  assert.equal(later.events.filter((e) => e.type === 'verdict').length, 1);
});

test('a 0.2.0 failed chairman ("Chairman failed: …") replays as failed, so the verdict can be written again', () => {
  const rb = rebuildDebate([head(), reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Ship now'), reply(SEATS[2], 0, 'Wait a sprint'),
    { type: 'stop', reason: 'round-cap', rounds: 1 }, { type: 'verdict', seat: { id: 'chairman', vendor: 'codex', lens: 'chairman' }, text: 'Chairman failed: timed out after 300000 ms' }]);
  assert.equal(rb.synthesis, 'failed');
  assert.deepEqual(rb.rounds[0].map((r) => r.stanceKey), ['opt-1', 'opt-1', 'opt-2'], 'and its label keys are read as ids');
});
