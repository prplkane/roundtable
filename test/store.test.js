import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
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

test('legacy tool activity recorded only on an interrupted repair still blocks that seat on resume', async () => {
  const rows = [head({ strictTools: false }),
    { type: 'attempt-start', attemptId: 'legacy-tool', round: 0, kind: 'reply', seat: SEATS[0] },
    { type: 'attempt', attemptId: 'legacy-tool', round: 0, kind: 'reply', seat: SEATS[0], usage: { input: 10, output: 2 } },
    { type: 'reprompt', attemptId: 'legacy-tool', round: 0, seat: SEATS[0], usedTools: true, text: 'PRIVATE_REJECTED_TEXT' },
  ];
  const rb = rebuildDebate(rows), calls = [];
  assert.equal(rb.ledger.length, 1, 'retaining policy state must not double-charge the attempt');
  assert.equal(rb.ledger[0].usage.input, 10);
  await createDebate({ fieldNotes: FN, seats: rb.seats, chairman: rb.chairman, options: { ...rb.options, critiqueRounds: 0 }, resume: rb,
    gate: async () => ({ action: 'continue' }), runner: async (v, prompt, sid, opts) => {
      calls.push(opts.seat.id);
      assert.ok(!prompt.includes('PRIVATE_REJECTED_TEXT'));
      return { text: opts.seat.id === 'chairman' ? VERDICT_OK : text('opt-1'), usage: { input: 1, output: 1 } };
    } }).run();
  assert.ok(!calls.includes('seat-0'));
});

test('interrupted resume seeds completed history and every note without reusing mutable provider threads', async () => {
  for (const partialReply of [false, true]) {
    const rows = [head({ seatTokenCap: 0 }),
      ...[0, 1].flatMap((r) => SEATS.map((s, i) => reply(s, r, i === 1 ? 'Wait a sprint' : 'Ship now', { rawCost: 20 }))),
      { type: 'human', round: 0, text: 'Keep the older correction.' },
      { type: 'human', round: 1, text: 'Keep the latest correction.' },
      { type: 'attempt-start', attemptId: 'unfinished', round: 2, kind: 'reply', seat: SEATS[0] },
      ...(partialReply ? [reply(SEATS[0], 2, 'Ship now', { text: 'DISCARDED_PROVIDER_CONTEXT', attemptId: 'unfinished' })] : []),
    ];
    const rb = rebuildDebate(rows), calls = [], saved = [];
    assert.equal(rb.partialRound, partialReply ? 2 : null);
    const d = createDebate({ fieldNotes: FN, seats: rb.seats.map((s) => ({ ...s, lastRawCost: 20 })), chairman: rb.chairman,
      options: rb.options, resume: rb, gate: async () => ({ action: 'continue' }), store: { append: (r) => saved.push(r) },
      runner: async (vendor, prompt, sid, opts) => {
        calls.push({ prompt, sid, prevCost: opts.prevCost, id: opts.seat.id });
        return { text: opts.seat.id === 'chairman' ? VERDICT_OK : text('Ship now'), usage: { input: 1, output: 1 }, sessionId: `fresh-${opts.seat.id}` };
      } });
    await d.run();
    for (const c of calls.filter((c) => c.id !== 'chairman')) {
      assert.equal(c.sid, null); assert.equal(c.prevCost, undefined);
      assert.match(c.prompt, /DECISION: Ship\?/);
      assert.match(c.prompt, /Keep the older correction/); assert.match(c.prompt, /Keep the latest correction/);
      assert.doesNotMatch(c.prompt, /DISCARDED_PROVIDER_CONTEXT/);
      const input = c.prompt.split('\n').filter((l) => l.startsWith('{')).map(JSON.parse);
      assert.deepEqual([...new Set(input.filter((r) => r.kind === 'seat').map((r) => r.round))], [0, 1]);
    }
    assert.equal(rb.ledger.filter((a) => a.attemptId === 'unfinished' && a.unknown).length, 1, 'spent or uncertain calls remain accounted for');
    assert.equal(saved.filter((r) => r.type === 'field-notes').length, 0);
  }
});

test('recovery uses fresh projections for seat caps and round admission, and admits a fitting fresh call', async () => {
  for (const scenario of [
    { vendor: 'claude', spent: 387000, budget: {}, blocked: true, kind: 'seat-tokens', projected: 14500 },
    { vendor: 'claude', spent: 387000, budget: { claude: { tokens: 400000 } }, blocked: true, kind: 'tokens', projected: 14500 },
    { vendor: 'codex', spent: 375000, budget: {}, blocked: false },
  ]) {
    const rows = [head({ critiqueRounds: 1, budget: scenario.budget }), ...SEATS.map((seat, i) =>
      reply(seat, 0, i === 1 ? 'Wait a sprint' : 'Ship now', { usage: {
        input: seat.vendor === scenario.vendor ? scenario.spent : 1, output: 0, cacheRead: 0, cacheWrite: 0,
      } }))];
    const rb = rebuildDebate(rows), calls = [], saved = [];
    await createDebate({ fieldNotes: FN, seats: rb.seats, chairman: { vendor: 'agy' }, options: rb.options, resume: rb,
      store: { append: (row) => saved.push(row) }, gate: async () => ({ action: 'continue' }),
      runner: async (vendor, prompt, sessionId, { seat }) => {
        calls.push({ vendor, sessionId, id: seat.id });
        return { text: seat.id === 'chairman' ? VERDICT_OK : text('Ship now'), usage: { input: 1, output: 1 }, sessionId: 'fresh-session' };
      },
    }).run();
    const targetCalls = calls.filter((call) => call.vendor === scenario.vendor && call.id !== 'chairman');
    assert.equal(targetCalls.length, scenario.blocked ? 0 : 1);
    if (scenario.blocked) {
      const refusal = saved.find((row) => row.type === 'budget' && row.vendor === scenario.vendor);
      assert.equal(refusal.kind, scenario.kind); assert.equal(refusal.projected, scenario.projected);
    } else assert.equal(targetCalls[0].sessionId, null, 'fresh recovery fits even when a resumed call would not');
  }
});

test('synthesis cancellation preserves the discussion stop through replay and export, even before a verdict row', async () => {
  const rows = [head(), ...SEATS.map((s) => reply(s, 0, 'Ship now')), { type: 'stop', reason: 'consensus', rounds: 1 },
    { type: 'synthesize', stopReason: 'consensus' }, { type: 'synthesis-cancelled', reason: 'human', rounds: 1 }];
  const rb = rebuildDebate(rows);
  assert.equal(rb.stopReason, 'consensus'); assert.equal(rb.synthesis, 'skipped'); assert.equal(rb.verdict.reason, 'human');
  const { decisionRecord } = await import('../src/export.js');
  assert.match(decisionRecord(rows, 'review').markdown, /stop_reason: consensus/);
});

test('dispatch intents survive a hard interruption and become one unknown attempt per unfinished call', async () => {
  const { ledgerEntries, rollup } = await import('../src/engine.js');
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-dispatch-')), store = openDebateDir(root, 'review');
  let snapshot, dispatched = 0;
  const pending = [];
  const d = createDebate({ fieldNotes: FN, seats: SEATS.slice(0, 2), chairman: { vendor: 'claude' }, store,
    options: { critiqueRounds: 0, unattended: true, budget: { claude: { tokens: 60000 }, codex: { tokens: 60000 } } },
    gate: async () => ({}), runner: async (_, __, ___, { signal }) => {
      dispatched++; snapshot = store.readTranscript();
      assert.equal(snapshot.filter((r) => r.type === 'attempt-start').length, dispatched, 'intent is on disk before the runner');
      return new Promise((resolve, reject) => { pending.push(resolve); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
    } });
  const running = d.run();
  assert.equal(dispatched, 2);
  const rb = rebuildDebate(snapshot);
  assert.equal(rb.ledger.length, 2); assert.ok(rb.ledger.every((a) => a.usage === null && a.unknown));
  assert.equal(rollup(rb.events).unknownAttempts, 2);
  let resumedCalls = 0;
  const resumed = createDebate({ fieldNotes: rb.fieldNotes, seats: rb.seats, chairman: { vendor: 'claude' }, resume: rb,
    options: rb.options, runner: async () => { resumedCalls++; return {}; }, store: { append() {} }, gate: async () => ({}) });
  assert.equal((await resumed.run()).stopReason, 'budget'); assert.equal(resumedCalls, 0);
  d.requestStop(); await running;
  const completed = store.readTranscript();
  assert.equal(ledgerEntries(completed).length, 2, 'start and settlement never count twice');
  const settled = { type: 'attempt', attemptId: rb.ledger[0].attemptId, seat: rb.ledger[0].seat, usage: { input: 3, output: 2, usageVersion: 3 } };
  assert.deepEqual(rollup([...snapshot, settled]).total.tokenCoverage, { reported: 1, of: 2 });
});

test('failed durable dispatch writes start no provider work', async () => {
  let calls = 0;
  const d = createDebate({ fieldNotes: FN, seats: SEATS, options: { unattended: true }, gate: async () => ({}),
    store: { append(row) { if (row.type === 'attempt-start') throw new Error('Synthetic dispatch write failure'); } },
    runner: async () => { calls++; return {}; } });
  await assert.rejects(d.run(), /Synthetic dispatch write failure/);
  assert.equal(calls, 0);
});

test('notes before round zero survive replay and export separately from later gate notes', async () => {
  const rows = [head(), { type: 'human', round: -1, text: 'First correction before starting.' },
    { type: 'human', round: -1, text: 'Second correction after another interruption.' },
    ...SEATS.map((s) => reply(s, 0, 'Ship now')),
    { type: 'human', round: 0, text: 'After seeing the blind replies.' }, { type: 'stop', reason: 'human', rounds: 1 }];
  const rb = rebuildDebate(rows);
  assert.deepEqual(rb.initialNotes, ['First correction before starting.', 'Second correction after another interruption.']);
  assert.deepEqual(rb.humanNotes, [['After seeing the blind replies.']]);
  assert.deepEqual(rb.events.filter((e) => e.type === 'human').map((e) => [e.round, e.text]),
    [[-1, rb.initialNotes[0]], [-1, rb.initialNotes[1]], [0, rb.humanNotes[0][0]]]);
  const { decisionRecord } = await import('../src/export.js');
  const record = decisionRecord(rows, 'initial-note').markdown;
  assert.match(record, /### Before round 0\n\n\*\*Human:\*\* First correction before starting\.\n\n\*\*Human:\*\* Second correction after another interruption\./);
  assert.match(record, /### After round 0\n\n\*\*Human:\*\* After seeing the blind replies\./);
});

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

test('the engine resumes from the first incomplete round without rewriting notes and seeds fresh provider sessions', async () => {
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
  assert.deepEqual(r1.map((c) => c.sessionId), [null, null, null], 'interrupted provider threads may contain discarded work, so recovery starts clean');
  assert.ok(r1.every((c) => c.prompt.includes('"kind":"seat"')), 'round 1 sees the round-0 replies from the transcript');
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

test('single and bulk transcript reads recover an unterminated final line without changing any bytes', () => {
  const incompleteUtf8 = Buffer.from('{"type":"reply","text":"💡').subarray(0, -2);
  for (const tail of [Buffer.from('{"type":"reply","text":"unfinished'), incompleteUtf8]) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rt-torn-read-'));
    const store = openDebateDir(root, 'torn');
    const file = path.join(store.dir, 'transcript.jsonl');
    const prefix = Buffer.from(JSON.stringify(head()) + '\r\n' + JSON.stringify(reply(SEATS[0], 0, 'Ship now')) + '\r\n');
    const original = Buffer.concat([prefix, tail]);
    writeFileSync(file, original);
    const warnings = [];
    const rows = store.readTranscript({ onWarning: (w) => warnings.push(w) });
    assert.deepEqual(rows.map((r) => r.type), ['field-notes', 'reply']);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'TRANSCRIPT_TAIL');
    assert.equal(warnings[0].line, 3);
    const bulkWarnings = [];
    assert.deepEqual(readAllTranscripts(root, { onWarning: (w) => bulkWarnings.push(w) }).map((r) => r.type), rows.map((r) => r.type));
    assert.equal(bulkWarnings[0].code, warnings[0].code);
    assert.deepEqual(readFileSync(file), original, 'opening history never repairs or truncates a file');
    assert.deepEqual(readdirSync(store.dir), ['transcript.jsonl']);
  }
});

test('resuming a torn transcript backs up its exact bytes and preserves its valid records and usage', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-torn-resume-'));
  const store = openDebateDir(root, 'torn');
  const file = path.join(store.dir, 'transcript.jsonl');
  const prefix = Buffer.from([head({ critiqueRounds: 0 }), reply(SEATS[0], 0, 'Ship now')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const original = Buffer.concat([prefix, Buffer.from('{"type":"reply","text":"partial')]);
  writeFileSync(file, original);
  const rb = rebuildDebate(store.readTranscript({ onWarning() {} }));
  const recovery = store.prepareAppend();
  assert.equal(recovery.type, 'transcript-recovered');
  assert.equal(recovery.line, 3);
  assert.deepEqual(readFileSync(path.join(store.dir, recovery.backup)), original);
  const calls = [];
  const d = createDebate({ fieldNotes: rb.fieldNotes, seats: rb.seats, chairman: rb.chairman, options: rb.options,
    resume: { rounds: rb.rounds, humanNotes: rb.humanNotes, ledger: rb.ledger }, store,
    gate: async () => ({ action: 'continue' }), runner: async (vendor, prompt, sid, opts) => {
      calls.push(opts.seat.id);
      return { text: opts.seat.id === 'chairman' ? VERDICT_OK : text('Ship now'), usage: { input: 2, output: 1 } };
    } });
  assert.equal((await d.run()).status, 'done');
  const bytes = readFileSync(file);
  assert.deepEqual(bytes.subarray(0, prefix.length), prefix, 'the valid prefix stays byte-for-byte intact');
  const rows = bytes.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.filter((r) => r.type === 'field-notes').length, 1);
  assert.equal(rows.filter((r) => r.type === 'transcript-recovered').length, 1);
  assert.equal(rebuildDebate(rows).finished, true);
  assert.equal(rebuildDebate(rows).ledger.length, 1 + calls.length, 'the paid partial round stays in the ledger');
  assert.equal(rebuildDebate(rows).events.find((e) => e.type === 'transcript-warning').backup, recovery.backup);
  assert.deepEqual(readFileSync(path.join(store.dir, recovery.backup)), original, 'later appends leave the backup untouched');
  assert.equal(store.prepareAppend(), null, 'repeated preparation creates no extra recovery');
});

test('append separates a valid last row without a newline and preserves blank lines and Unicode', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-final-row-'));
  const store = openDebateDir(root, 'valid');
  const file = path.join(store.dir, 'transcript.jsonl');
  const row = { type: 'human', round: 0, text: 'A full row 💡' };
  const original = JSON.stringify(head()) + '\r\n \t\r\n' + JSON.stringify(row);
  writeFileSync(file, original);
  assert.equal(store.readTranscript().length, 2);
  store.append({ type: 'human', round: 0, text: 'Next' });
  assert.deepEqual(store.readTranscript().map((r) => r.type), ['field-notes', 'human', 'human']);
  assert.equal(store.readTranscript()[1].text, row.text);
  assert.ok(readFileSync(file, 'utf8').startsWith(original + '\n'));
  assert.deepEqual(readdirSync(store.dir), ['transcript.jsonl'], 'a valid file needs no recovery backup');
});

test('corrupt completed lines are reported, never skipped into a resumable record or bulk calibration', () => {
  const good = JSON.stringify(head()) + '\n';
  for (const bad of [good + 'broken\n', good + 'broken\n' + JSON.stringify(reply(SEATS[0], 0, 'Ship now')) + '\n', good + 'null', good + '[]\n', good + '{}\n', '{"type":', Buffer.concat([Buffer.from(good), Buffer.from([0xff, 10])])]) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rt-corrupt-'));
    const store = openDebateDir(root, 'corrupt');
    const file = path.join(store.dir, 'transcript.jsonl');
    writeFileSync(file, bad);
    const isCorruption = (e) => e.code === 'TRANSCRIPT_CORRUPT' && /line \d+/.test(e.message) && /backup/i.test(e.message);
    assert.throws(() => store.readTranscript(), isCorruption);
    assert.throws(() => store.append({ type: 'human', text: 'must not append' }), isCorruption);
    const healthy = openDebateDir(root, 'healthy'); healthy.append(head());
    const warnings = [];
    assert.equal(readAllTranscripts(root, { onWarning: (w) => warnings.push(w) }).length, 1, 'the whole corrupt record is excluded');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'TRANSCRIPT_CORRUPT');
    assert.deepEqual(readFileSync(file), Buffer.isBuffer(bad) ? bad : Buffer.from(bad));
    assert.deepEqual(readdirSync(store.dir), ['transcript.jsonl']);
  }
});

test('failed recovery writes never replace a transcript or an existing backup', (t) => {
  t.mock.method(globalThis.crypto, 'randomUUID', () => 'fixed-test-id');
  for (const blocked of ['transcript.recovery-fixed-test-id.jsonl', 'transcript.repair-fixed-test-id.tmp']) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rt-backup-failure-'));
    const store = openDebateDir(root, 'torn');
    const file = path.join(store.dir, 'transcript.jsonl');
    const original = Buffer.from(JSON.stringify(head()) + '\n{"type":');
    writeFileSync(file, original);
    writeFileSync(path.join(store.dir, blocked), 'existing file');
    assert.throws(() => store.prepareAppend(), (e) => e.code === 'EEXIST');
    assert.deepEqual(readFileSync(file), original);
    assert.equal(readFileSync(path.join(store.dir, blocked), 'utf8'), 'existing file');
  }
});

test('exports disclose a recovered prefix while leaving an unrepaired transcript unchanged', async () => {
  const { exportDebate } = await import('../src/export.js');
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-recovery-export-'));
  const store = openDebateDir(root, 'torn');
  const file = path.join(store.dir, 'transcript.jsonl');
  const original = JSON.stringify(head()) + '\n{"type":"human","text":"unfinished';
  writeFileSync(file, original);
  const warnings = [];
  const rows = store.readTranscript({ onWarning: (w) => warnings.push(w) });
  const target = mkdtempSync(path.join(os.tmpdir(), 'rt-recovery-record-'));
  const out = exportDebate(rows, 'torn', target, { warnings });
  assert.match(readFileSync(out.path, 'utf8'), /## Record recovery\s+.*incomplete final line 2/);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual(readdirSync(store.dir), ['transcript.jsonl']);
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
