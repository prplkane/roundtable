import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebate, rollup, positions } from '../src/engine.js';

const FIELD_NOTES = { decision: 'Ship the new checkout?', options: ['Ship now', 'Wait a sprint'], constraints: 'two devs' };
const SEATS = [
  { vendor: 'claude', lens: 'risk', colour: 'rust' },
  { vendor: 'codex', lens: 'cost', colour: 'olive' },
  { vendor: 'agy', lens: 'customer', colour: 'teal' },
];

const reply = (stance, extra = {}) => [
  `STANCE: ${stance}`,
  `AGREE_WITH: [${(extra.agree || []).join(', ')}]`,
  'DISAGREE:', `- ${extra.disagree || 'something'}`,
  'NEW:', `- ${extra.new || 'a fresh angle'}`, // something new by default, so only tests that say "none" can go stable
  'ASSUMPTIONS:', '- it holds',
  extra.question ? `QUESTION_FOR_HUMAN: ${extra.question}` : null,
].filter(Boolean).join('\n');

// script: (vendor, round, callIndexForThisSeatInRound) -> text. Records every prompt.
function fakeRunner(script) {
  const calls = [];
  const sessions = {};
  const runner = async (vendor, prompt, sessionId, opts = {}) => {
    const round = (prompt.match(/^Round (\d+) of/m) || [])[1];
    // A stateless re-prompt carries the round line too, so the violation text is checked first.
    const r = /did not follow the contract/.test(prompt) ? 'reprompt' : /^You are the chairman/.test(prompt) ? 'verdict' : round ? Number(round) : 0;
    const key = opts.seat?.id || vendor; // sessions belong to instances, never to vendors
    const prior = calls.filter((c) => c.key === key && c.round === r).length;
    calls.push({ vendor, key, seat: opts.seat, prompt, sessionId, round: r, opts });
    sessions[key] ??= `sess-${key}`;
    let out = script(vendor, r, prior, prompt, opts.seat);
    // a chairman whose script wrote no verdict writes a well-formed one (tests about a bad verdict say so)
    if (r === 'verdict' && !/RECOMMENDATION/.test(typeof out === 'string' ? out : out?.text || '')) out = GOOD_VERDICT;
    const { text, usedTools = false } = typeof out === 'string' ? { text: out } : out;
    return { text, usage: { input: 10, output: 5, cost: vendor === 'claude' ? 0.01 : null, ms: 1 }, sessionId: sessions[key], usedTools };
  };
  return { runner, calls };
}

const GOOD_VERDICT = 'RECOMMENDATION: opt-1\nShip it.\nTALLY:\n- opt-1: risk\nDISSENT: cost wanted a sprint\nKILL_CRITERIA:\n- errors above 2%\nOPEN_QUESTIONS:\n- is the deadline movable?';
const autoGate = async () => ({ action: 'continue' });
const stub = () => ({ append() {}, writeFieldNotes() {}, writeVerdict() {} });

test('a note before resumed round zero reaches fresh seats, stateless retries and later rounds, and every chairman', async () => {
  for (const memory of ['stateless', 'resume']) {
    const initialNotes = ['The deadline changed before the first round completed.'];
    const fr = fakeRunner((vendor, round) => round === 0 ? 'off contract' : reply('opt-1'));
    let gates = 0;
    const state = await createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, store: stub(), emit() {},
      options: { memory, critiqueRounds: 1 }, resume: { rounds: [], humanNotes: [], initialNotes, ledger: [] },
      gate: async () => ({ action: 'continue', message: gates++ === 0 ? 'Revisit the blind consensus.' : '' }),
    }).run();
    assert.equal(state.rounds.length, 2);
    for (const call of fr.calls.filter((c) => c.round === 0 || c.round === 'verdict' || memory === 'stateless')) {
      assert.ok(call.prompt.includes(initialNotes[0]), `${memory}: ${call.round} keeps the correction`);
      assert.match(call.prompt, /Before round 0/);
    }
    await createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, store: stub(), emit() {}, gate: autoGate,
      synthesisOnly: true, resume: { rounds: state.rounds, humanNotes: state.humanNotes, initialNotes, ledger: [] },
    }).run();
    assert.ok(fr.calls.at(-1).prompt.includes(initialNotes[0]), 'manual synthesis also receives the correction');
    assert.deepEqual(initialNotes, ['The deadline changed before the first round completed.']);
  }
});

function debate(script, extra = {}) {
  const fr = fakeRunner(script);
  const events = [];
  const d = createDebate({
    fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, gate: extra.gate || autoGate, store: stub(),
    emit: (t, p) => events.push(p), options: { critiqueRounds: 3, ...(extra.options || {}) }, now: extra.now,
    chairman: extra.chairman,
  });
  return { d, fr, events };
}

const disagreeForever = (vendor, round) => {
  if (round === 'reprompt') return reply('Ship now');
  return reply(vendor === 'claude' ? 'Ship now' : vendor === 'codex' ? 'Wait a sprint' : 'other: split it');
};

test('a budget-skipped chairman keeps its configuration available to the live recovery controls', async () => {
  const chairman = { vendor: 'claude', model: 'sonnet', effort: 'low', account: 'review' };
  const { d, fr, events } = debate(disagreeForever, { chairman, options: { budget: { claude: { tokens: 1 } } } });
  const state = await d.run();
  assert.equal(state.verdict.skipped, true);
  assert.equal(fr.calls.length, 0);
  assert.deepEqual(events.find((e) => e.type === 'started').chairman, chairman);
  assert.ok(!events.some((e) => e.type === 'chairman-start'), 'the configured choice is available before any chairman attempt');
});

test('a mid-round stop is journaled immediately, beats consensus or failure, and prevents retries', async () => {
  for (const fail of [false, true]) {
    const rows = [], events = [];
    let entered, release, arrivals = 0;
    const inFlight = new Promise((resolve) => { entered = resolve; });
    const finishCalls = new Promise((resolve) => { release = resolve; });
    const fr = fakeRunner(() => reply('opt-1'));
    const runner = async (...args) => {
      if (/^Round 1 of/m.test(args[1])) {
        if (++arrivals === 2) entered();
        await finishCalls;
        if (fail) throw Object.assign(new Error('network fixture'), { kind: 'network', usage: { input: 1, output: 1 } });
      }
      return fr.runner(...args);
    };
    const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS.slice(0, 2), runner,
      chairman: { vendor: 'claude' }, options: { critiqueRounds: 2, networkRetryMs: 1 },
      store: { append: (row) => rows.push(row) }, emit: (t, e) => events.push(e),
      gate: async () => ({ action: 'continue', message: 'Reconsider the blind consensus.' }),
    });
    const running = d.run(); await inFlight;
    d.requestStop('Stop with this explanation preserved.');
    assert.ok(rows.some((r) => r.type === 'human' && r.round === 1 && r.text === 'Stop with this explanation preserved.'), 'the note is saved before calls settle');
    release(); const state = await running;
    assert.equal(state.stopReason, 'human'); assert.equal(state.rounds.length, 2);
    assert.equal(arrivals, 2, 'no network retries or re-prompts dispatch after Stop');
    assert.equal(events.filter((e) => e.type === 'gate').length, 1, 'Stop does not depend on another gate');
    assert.ok(!fr.calls.some((c) => c.round === 'verdict'), 'Stop never starts the chairman');
    assert.equal(state.verdict.skipped, true);
    assert.equal(state.verdict.reason, 'human');
    assert.equal(events.at(-1).cancelled, true);
  }
});

test('Stop during manual synthesis keeps its note with the completed round and prevents a chairman retry', async () => {
  const { d: initial } = debate(() => reply('opt-1'), { options: { critiqueRounds: 0 } });
  const prior = await initial.run();
  const rows = []; let entered, release, calls = 0;
  const inFlight = new Promise((resolve) => { entered = resolve; });
  const finishCall = new Promise((resolve) => { release = resolve; });
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, chairman: { vendor: 'claude' },
    synthesisOnly: true, resume: { rounds: prior.rounds, humanNotes: prior.humanNotes, ledger: [] },
    options: { networkRetryMs: 1 }, store: { append: (row) => rows.push(row) }, gate: autoGate,
    runner: async () => { calls++; entered(); await finishCall; throw Object.assign(new Error('network fixture'), { kind: 'network', usage: { input: 1, output: 1 } }); },
  });
  const running = d.run(); await inFlight; d.requestStop('Stop this synthesis.');
  assert.ok(rows.some((r) => r.type === 'human' && r.round === 0 && r.text === 'Stop this synthesis.'));
  release(); const state = await running;
  assert.equal(calls, 1); assert.equal(state.verdict.skipped, true);
  assert.equal(state.stopReason, 'human');
});

test('round cap: stops after round 0 plus critiqueRounds', async () => {
  const { d } = debate(disagreeForever, { options: { critiqueRounds: 2 } });
  const s = await d.run();
  assert.equal(s.rounds.length, 3);
  assert.equal(s.stopReason, 'round-cap');
  assert.equal(s.status, 'done');
});

test('all PASS exits', async () => {
  const { d } = debate((v, round) => (round === 1 ? 'PASS' : disagreeForever(v, round)));
  const s = await d.run();
  assert.equal(s.rounds.length, 2);
  assert.equal(s.stopReason, 'all-pass');
});

test('consensus exits, including in round 0, after the round-0 gate, and still writes a verdict', async () => {
  const gates = [];
  const gate = async (info) => { gates.push(info); return { action: 'continue', message: '' }; };
  const { d, events } = debate(() => reply('ship now'), { gate });
  const s = await d.run();
  assert.equal(s.rounds.length, 1);
  assert.equal(s.stopReason, 'consensus');
  assert.deepEqual(gates.map((g) => [g.round, g.mode, g.stop, g.reopenable]), [[0, 'blocking', 'consensus', true]]);
  assert.equal(s.humanNotes[0], undefined);
  assert.ok(s.verdict.text);
  assert.ok(events.some((e) => e.type === 'verdict'));
  assert.ok(!events.some((e) => e.type === 'reopen'));
});

test('a note at a unanimous round 0 runs round 1 with the note; a second unanimous round stops without a gate', async () => {
  const gates = [];
  const gate = async (info) => { gates.push(info); return { action: 'continue', message: 'What about mobile checkout?' }; };
  const { d, fr, events } = debate(() => reply('ship now'), { gate });
  const s = await d.run();
  assert.equal(s.rounds.length, 2);
  assert.equal(s.stopReason, 'consensus');
  assert.deepEqual(gates.map((g) => [g.round, g.stop]), [[0, 'consensus']], 'no gate after the deferred stop fires again');
  const r1 = fr.calls.filter((c) => c.round === 1);
  assert.equal(r1.length, 3);
  assert.ok(r1.every((c) => c.prompt.includes('What about mobile checkout?')), 'the note reaches every seat');
  assert.deepEqual(events.filter((e) => e.type === 'reopen').map((e) => [e.round, e.stop]), [[0, 'consensus']]);
  // the chairman still sees the note
  assert.match(fr.calls.at(-1).prompt, /What about mobile checkout\?/);
});

test('a note at a unanimous round 0 that splits the seats continues under the ordinary rules', async () => {
  const gate = async (info) => ({ action: 'continue', message: info.round === 0 ? 'Consider the deadline' : '' });
  const { d } = debate((v, round) => (round === 0 ? reply('Ship now') : disagreeForever(v, round)), { gate, options: { critiqueRounds: 2 } });
  const s = await d.run();
  assert.equal(s.rounds.length, 3);
  assert.equal(s.stopReason, 'round-cap');
});

test('a note at a unanimous round 0 cannot run past the round cap', async () => {
  const gates = [];
  const gate = async (info) => { gates.push(info); return { action: 'continue', message: 'Think again' }; };
  const { d, events } = debate(() => reply('ship now'), { gate, options: { critiqueRounds: 0 } });
  const s = await d.run();
  assert.equal(s.rounds.length, 1);
  assert.equal(s.stopReason, 'consensus');
  assert.equal(gates[0].reopenable, false);
  assert.deepEqual(s.humanNotes[0], ['Think again'], 'the note is still recorded for the chairman');
  assert.ok(!events.some((e) => e.type === 'reopen'));
});

test('/stop with a note at a unanimous round 0 stops, it does not reopen', async () => {
  const gate = async () => ({ action: 'stop', message: '/stop enough' });
  const { d, events } = debate(() => reply('ship now'), { gate });
  const s = await d.run();
  assert.equal(s.rounds.length, 1);
  assert.equal(s.stopReason, 'human');
  assert.ok(!events.some((e) => e.type === 'reopen'));
});

test('an other: stance never counts as consensus', async () => {
  const { d } = debate(() => reply('other: do a spike'), { options: { critiqueRounds: 1 } });
  const s = await d.run();
  assert.equal(s.stopReason, 'round-cap');
});

test('gate blocks after round 0 and on any QUESTION_FOR_HUMAN, counts down otherwise', async () => {
  const gates = [];
  const gate = async (info) => { gates.push(info); return { action: 'continue', message: info.round === 0 ? 'think about mobile' : '' }; };
  const { d, fr } = debate((v, round) =>
    (round === 1 && v === 'codex') ? reply('Wait a sprint', { question: 'Is the deadline fixed?' }) : disagreeForever(v, round), { gate });
  const s = await d.run();
  assert.deepEqual(gates.map((g) => [g.round, g.mode, g.reason]), [[0, 'blocking', 'round0'], [1, 'blocking', 'question'], [2, 'countdown', 'auto']]);
  assert.deepEqual(gates[1].questions, [{ lens: 'cost', question: 'Is the deadline fixed?' }]);
  // the human note after round 0 reaches every seat in round 1
  const r1 = fr.calls.filter((c) => c.round === 1);
  assert.ok(r1.every((c) => c.prompt.includes('think about mobile')));
  assert.deepEqual(s.humanNotes[0], ['think about mobile']);
});

test('/stop from the human ends the debate with reason human', async () => {
  const gate = async (info) => ({ action: 'continue', message: info.round === 1 ? '/stop' : '' });
  const { d } = debate(disagreeForever, { gate });
  const s = await d.run();
  assert.equal(s.rounds.length, 2);
  assert.equal(s.stopReason, 'human');
  assert.equal(s.humanNotes[1], undefined);
});

test('wall-clock cap stops the debate', async () => {
  let t = 0;
  const now = () => (t += 10_000);
  const { d } = debate(disagreeForever, { now, options: { wallClockMs: 15_000 } });
  const s = await d.run();
  assert.equal(s.stopReason, 'wall-clock');
  assert.ok(s.rounds.length < 4);
});

test('anonymisation: later rounds carry lens labels only, never vendors, never the seat itself (resume mode)', async () => {
  const { d, fr } = debate(disagreeForever, { options: { critiqueRounds: 1, memory: 'resume' } });
  await d.run();
  const r1 = fr.calls.filter((c) => c.round === 1);
  assert.equal(r1.length, 3);
  for (const c of r1) {
    assert.doesNotMatch(c.prompt, /claude|codex|agy|antigravity|openai|google|anthropic/i);
    const lensesShown = ['risk', 'cost', 'customer'].filter((l) => c.prompt.includes(`### Seat: ${l}`));
    const own = SEATS.find((s) => s.vendor === c.vendor).lens;
    assert.equal(lensesShown.length, 2);
    assert.ok(!lensesShown.includes(own), `${c.vendor} saw its own reply`);
    assert.equal(c.sessionId, `sess-${c.key}`, 'round 1 resumes the instance session');
  }
  // round 0 is blind: fresh sessions, no peer text
  for (const c of fr.calls.filter((c) => c.round === 0)) {
    assert.equal(c.sessionId, null);
    assert.doesNotMatch(c.prompt, /### Seat:/);
  }
});

test('re-prompt once on a contract violation, then give up', async () => {
  let codexGarbage = 2; // round 0: garbage twice -> invalid; round 1: garbage once then fixed
  const { d, fr, events } = debate((v, round, prior) => {
    if (v !== 'codex') return disagreeForever(v, round);
    if (round === 0) return 'I just think we should ship.';
    if (round === 'reprompt') return --codexGarbage > 0 ? 'still rambling' : reply('Wait a sprint');
    return 'rambling again';
  }, { options: { critiqueRounds: 1 } });
  const s = await d.run();
  const codexCalls = fr.calls.filter((c) => c.vendor === 'codex');
  assert.equal(codexCalls.length, 4, 'two calls per round for codex');
  assert.match(codexCalls[1].prompt, /did not follow the contract/);
  assert.match(codexCalls[1].prompt, /missing STANCE line/);
  // stateless (the default): the re-prompt is self-contained, so it carries the offending reply
  // after the same stable prefix, and resumes nothing
  assert.match(codexCalls[1].prompt, /### Your reply\nI just think we should ship\./);
  assert.ok(codexCalls[1].prompt.indexOf('--- FIELD NOTES ---') < codexCalls[1].prompt.indexOf('did not follow'), 'stable prefix first');
  assert.ok(codexCalls.every((c) => c.sessionId === null));
  const r0 = s.rounds[0].find((r) => r.seat.vendor === 'codex');
  assert.equal(r0.valid, false);
  assert.equal(r0.stanceKey, 'other: unparsed');
  assert.equal(r0.reprompted, true);
  const r1 = s.rounds[1].find((r) => r.seat.vendor === 'codex');
  assert.equal(r1.valid, true);
  assert.equal(r1.stanceKey, 'opt-2');
  assert.equal(events.filter((e) => e.type === 'reprompt').length, 2);
  // each call is its own attempt; the reply names its attempt and carries no usage of its own
  const attempts = events.filter((e) => e.type === 'attempt' && e.seat.vendor === 'codex' && e.round === 1);
  assert.deepEqual(attempts.map((e) => [e.kind, e.usage.input]), [['reply', 10], ['reprompt', 10]]);
  assert.equal(r1.usage, undefined);
  assert.equal(r1.attemptId, attempts[1].attemptId);
  assert.equal(rollup(events).bySeatRound[r1.seat.id]['1'].input, 20, 'the two attempts, once each');
});

test('a seat whose CLI throws is marked failed and the others continue', async () => {
  const { d } = debate((v, round) => { if (v === 'agy') throw new Error('agy: not found on PATH'); return disagreeForever(v, round); },
    { options: { critiqueRounds: 1 } });
  const s = await d.run();
  const agy = s.rounds[0].find((r) => r.seat.vendor === 'agy');
  assert.equal(agy.failed, true);
  assert.equal(agy.stanceKey, 'other: no reply');
  assert.equal(s.status, 'done');
});

test('chairman is a fresh session of a vendor that did not deliberate in that session', async () => {
  const { d, fr } = debate(disagreeForever, { options: { critiqueRounds: 0 }, chairman: { vendor: 'codex' } });
  await d.run();
  const last = fr.calls.at(-1);
  assert.equal(last.vendor, 'codex');
  assert.equal(last.sessionId, null, 'chairman must not resume a deliberating session');
  assert.match(last.prompt, /chairman/i);
  assert.match(last.prompt, /### risk/);
  assert.doesNotMatch(last.prompt, /claude|agy/i);
});

test('rollup sums usage per seat, per round and in total', () => {
  const rows = [
    { type: 'reply', round: 0, seat: { vendor: 'claude', lens: 'risk' }, usage: { input: 10, output: 5, cost: 0.01 } },
    { type: 'reply', round: 0, seat: { vendor: 'codex', lens: 'cost' }, usage: { input: 20, output: 5, cost: null } },
    { type: 'reply', round: 1, seat: { vendor: 'claude', lens: 'risk' }, usage: { input: 30, output: 5, cost: 0.02 } },
    { type: 'verdict', seat: { vendor: 'agy', lens: 'chairman' }, usage: { input: 1, output: 1, cost: null } },
  ];
  const u = rollup(rows);
  assert.equal(u.bySeat['claude:risk'].usage.input, 40, 'rows without an id fall back to vendor:lens');
  assert.equal(u.bySeat['claude:risk'].usage.cost, 0.03);
  assert.equal(u.bySeat['codex:cost'].usage.cost, null);
  const byId = rollup([
    { type: 'reply', round: 0, seat: { id: 'seat-0', vendor: 'codex', lens: 'risk' }, usage: { input: 10, output: 1 } },
    { type: 'reply', round: 0, seat: { id: 'seat-1', vendor: 'codex', lens: 'cost' }, usage: { input: 20, output: 1 } },
  ]);
  assert.deepEqual(Object.keys(byId.bySeat), ['seat-0', 'seat-1'], 'two seats of one vendor stay apart');
  assert.equal(byId.bySeat['seat-1'].seat.lens, 'cost');
  assert.equal(u.byRound['0'].input, 30);
  assert.equal(u.byRound.verdict.input, 1);
  assert.equal(u.total.input, 61);
});

test('a failed seat blocks consensus and all-PASS until it is back', async () => {
  const { d } = debate((v, round) => { if (v === 'agy') throw new Error('agy: down'); return reply('Ship now'); },
    { options: { critiqueRounds: 1 } });
  const s = await d.run();
  assert.equal(s.stopReason, 'round-cap');
});

test('two instances of one vendor are independent: own sessions, own moods, each other only as lens text', async () => {
  const seats = [
    { id: 'seat-0', vendor: 'codex', lens: 'risk', mood: { preset: 'grill' }, colour: 'rust', effort: 'high' },
    { id: 'seat-1', vendor: 'codex', lens: 'cost', mood: { preset: 'custom', text: 'Argue like a CFO.' }, colour: 'olive', model: 'gpt-6.1-sol' },
    { id: 'seat-2', vendor: 'claude', lens: 'customer', mood: { preset: 'steelman' }, colour: 'teal' },
  ];
  const fr = fakeRunner((vendor, round, prior, prompt, seat) =>
    reply(seat?.lens === 'risk' ? 'Ship now' : 'Wait a sprint', { disagree: `from ${seat?.lens}: the other side is wrong` }));
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats, runner: fr.runner, gate: autoGate, store: stub(), options: { critiqueRounds: 1, memory: 'resume' } });
  const s = await d.run();
  const r0 = fr.calls.filter((c) => c.round === 0);
  assert.deepEqual(r0.map((c) => c.key), ['seat-0', 'seat-1', 'seat-2']);
  assert.notEqual(s.seats[0].sessionId, s.seats[1].sessionId, 'same vendor, different sessions');
  const r1 = fr.calls.filter((c) => c.round === 1);
  assert.deepEqual(r1.map((c) => c.sessionId), ['sess-seat-0', 'sess-seat-1', 'sess-seat-2'], 'each instance resumes only its own session');
  // mood and effort reach the right instance and no other
  assert.match(r0[0].prompt, /sceptical/);
  assert.match(r0[1].prompt, /Argue like a CFO\./);
  assert.doesNotMatch(r0[0].prompt, /CFO/);
  assert.equal(r0[0].opts.effort, 'high');
  assert.equal(r0[1].opts.effort, undefined);
  assert.equal(r0[1].opts.model, 'gpt-6.1-sol');
  // in round 1, seat-1 sees seat-0's text under its lens only; never a vendor, id or label
  assert.match(r1[1].prompt, /### Seat: risk\n[\s\S]*from risk: the other side is wrong/);
  assert.doesNotMatch(r1[1].prompt, /codex|claude|seat-0|Codex 1/i);
  assert.doesNotMatch(r1[1].prompt, /from cost:/, 'a seat is not shown its own earlier reply');
  // the chairman gets lens labels only, too
  assert.doesNotMatch(fr.calls.at(-1).prompt, /codex|seat-\d|Codex \d/i);
  // transcript row for the field notes is versioned and carries the instances
  assert.equal(s.seats[1].mood.text, 'Argue like a CFO.');
});

test('stateless rounds (the default): fresh calls, own last reply first, then the others, then the note; never a vendor', async () => {
  const gate = async (info) => ({ action: 'continue', message: info.round === 0 ? 'Mind the deadline' : '' });
  const rows = [];
  const fr = fakeRunner((vendor, round, prior, prompt, seat) => reply(vendor === 'claude' ? 'Ship now' : 'Wait a sprint', { disagree: `${seat.lens} says round ${round}` }));
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, gate, store: { append: (r) => rows.push(r), writeFieldNotes() {}, writeVerdict() {} }, options: { critiqueRounds: 2 } });
  const s = await d.run();
  assert.equal(s.options.memory, 'stateless');
  assert.ok(fr.calls.every((c) => c.sessionId === null), 'no call resumes a session');
  for (const c of fr.calls.filter((c) => c.round === 1)) {
    const own = SEATS.find((x) => x.vendor === c.vendor).lens;
    assert.doesNotMatch(c.prompt, /claude|codex|agy|antigravity|openai|google|anthropic/i);
    const iNotes = c.prompt.indexOf('--- FIELD NOTES ---'), iContract = c.prompt.indexOf('Reply with ONLY these lines');
    const iOwn = c.prompt.indexOf(`### Your reply in round 0\nSTANCE:`), iOthers = c.prompt.indexOf('### Seat: '), iNote = c.prompt.indexOf('Mind the deadline');
    assert.ok(iNotes > 0 && iContract > iNotes && iOwn > iContract && iOthers > iOwn && iNote > iOthers, `order: notes, contract, own, others, note (${[iNotes, iContract, iOwn, iOthers, iNote]})`);
    assert.match(c.prompt, new RegExp(`### Your reply in round 0\\n[\\s\\S]*${own} says round 0`), 'the seat sees its own last reply');
    assert.ok(!c.prompt.includes(`### Seat: ${own}`), 'and not as a peer');
    for (const other of SEATS.filter((x) => x.vendor !== c.vendor)) assert.match(c.prompt, new RegExp(`### Seat: ${other.lens}\\n[\\s\\S]*${other.lens} says round 0`));
    assert.match(c.prompt, /^Round 1 of 2\./m);
  }
  // round 2 carries round-1 text, not round-0 text; the round-0 note carries forward, labelled
  // (before 0.3.0 it vanished here, and a seat could argue from an assumption the human had
  // already overturned)
  const r2 = fr.calls.find((c) => c.round === 2 && c.vendor === 'codex');
  assert.match(r2.prompt, /cost says round 1/);
  assert.doesNotMatch(r2.prompt, /says round 0/);
  assert.match(r2.prompt, /- Human — After round 0 \(latest\): Mind the deadline/);
  // transcript rows say every call was fresh and carry the session the CLI reported
  const replies = rows.filter((r) => r.type === 'reply');
  assert.equal(replies.length, 9);
  assert.ok(replies.every((r) => r.fresh === true && r.sessionId === `sess-${r.seat.id}`));
  // round 0 itself is unchanged
  for (const c of fr.calls.filter((c) => c.round === 0)) assert.doesNotMatch(c.prompt, /### Seat:|### Your reply/);
});

test('resume mode keeps the thread: later rounds resume the session and carry no own reply', async () => {
  const rows = [];
  const fr = fakeRunner(disagreeForever);
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, gate: autoGate, store: { append: (r) => rows.push(r), writeFieldNotes() {}, writeVerdict() {} }, options: { critiqueRounds: 1, memory: 'resume' } });
  await d.run();
  const r1 = fr.calls.filter((c) => c.round === 1);
  assert.ok(r1.every((c) => c.sessionId === `sess-${c.key}`));
  assert.ok(r1.every((c) => !c.prompt.includes('### Your reply')));
  const replies = rows.filter((r) => r.type === 'reply');
  assert.deepEqual(replies.map((r) => r.fresh), [true, true, true, false, false, false]);
});

test('rollup keeps one figure per seat per round for the strip', () => {
  const u = rollup([
    { type: 'reply', round: 0, seat: { id: 'a', vendor: 'codex' }, usage: { input: 10, output: 1 } },
    { type: 'reply', round: 1, seat: { id: 'a', vendor: 'codex' }, usage: { input: 12, output: 1 } },
    { type: 'reply', round: 1, seat: { id: 'b', vendor: 'codex' }, usage: { input: 30, output: 1 } },
  ]);
  assert.equal(u.bySeatRound.a['0'].input, 10);
  assert.equal(u.bySeatRound.a['1'].input, 12);
  assert.equal(u.bySeatRound.b['1'].input, 30);
  assert.equal(u.bySeatRound.b['0'], undefined);
});

test('positions: majority, dissent, other, pass, tie, and no valid reply', () => {
  const r = (id, stanceKey, extra = {}) => ({ seat: { id }, stanceKey, valid: true, failed: false, ...extra });
  assert.deepEqual(positions([r('a', 'Ship now'), r('b', 'Ship now'), r('c', 'Wait a sprint'), r('d', 'other: spike'), r('e', 'PASS'), r('f', null, { valid: false }), r('g', 'Ship now', { failed: true, valid: false })]),
    { a: 'agreed', b: 'agreed', c: 'disagreed', d: 'neutral', e: 'passed', f: null, g: null });
  assert.deepEqual(positions([r('a', 'Ship now'), r('b', 'Wait a sprint')]), { a: 'neutral', b: 'neutral' }, 'a tie has no majority');
  assert.deepEqual(positions([r('a', 'Ship now')]), { a: 'agreed' }, 'one seat is its own majority');
  assert.deepEqual(positions([r('a', 'other: x'), r('b', 'other: y')]), { a: 'neutral', b: 'neutral' });
});

test('the engine emits seat states: thinking, replied, reprompted, failed, timed-out; round-done carries positions', async () => {
  const { d, events } = debate((v, round, prior) => {
    if (v === 'agy') { const e = new Error('timed out after 5 ms'); e.code = 'TIMEOUT'; throw e; }
    if (v === 'codex' && round === 0) return 'rambling';
    if (v === 'codex' && round === 'reprompt') return reply('Wait a sprint');
    return disagreeForever(v, round);
  }, { options: { critiqueRounds: 0 } });
  const s = await d.run();
  const states = events.filter((e) => e.type === 'seat-state').map((e) => `${e.seat.lens}:${e.state}`);
  assert.deepEqual(states.filter((x) => x.startsWith('risk')), ['risk:thinking', 'risk:replied']);
  assert.deepEqual(states.filter((x) => x.startsWith('cost')), ['cost:thinking', 'cost:reprompted', 'cost:reprompted'], 'a re-prompted seat that then answers keeps the amber light');
  assert.deepEqual(states.filter((x) => x.startsWith('customer')), ['customer:thinking', 'customer:timed-out']);
  const agy = s.rounds[0].find((r) => r.seat.vendor === 'agy');
  assert.equal(agy.timedOut, true);
  assert.equal(agy.state, 'timed-out');
  const done = events.find((e) => e.type === 'round-done');
  assert.deepEqual(done.positions, { 'seat-0': 'neutral', 'seat-1': 'neutral', 'seat-2': null }, 'one for, one against: a tie');
  // a plain failure is "failed", not "timed-out"
  const { d: d2, events: ev2 } = debate((v, round) => { if (v === 'agy') throw new Error('agy: not found on PATH'); return disagreeForever(v, round); }, { options: { critiqueRounds: 0 } });
  await d2.run();
  assert.ok(ev2.some((e) => e.type === 'seat-state' && e.seat.lens === 'customer' && e.state === 'failed'));
});

test('tool-use guard: one re-prompt that says tools are not allowed, then the seat fails for the round', async () => {
  const { d, fr, events } = debate((v, round, prior) => {
    if (v !== 'codex') return disagreeForever(v, round);
    if (round === 0) return { text: reply('Wait a sprint'), usedTools: true };          // round 0: tools once, then clean
    if (round === 'reprompt' && prior === 0) return reply('Wait a sprint');
    if (round === 1) return { text: reply('Wait a sprint'), usedTools: true };          // round 1: tools twice
    return { text: reply('Wait a sprint'), usedTools: true };
  }, { options: { critiqueRounds: 1 } });
  const s = await d.run();
  const codex = fr.calls.filter((c) => c.vendor === 'codex');
  assert.equal(codex.length, 4);
  assert.match(codex[1].prompt, /Tools are not allowed at this table/);
  assert.match(codex[1].prompt, /used tools or ran commands/);
  const r0 = s.rounds[0].find((r) => r.seat.vendor === 'codex');
  assert.equal(r0.valid, true, 'the clean second answer counts');
  assert.equal(r0.reprompted, true);
  assert.equal(r0.usedTools, true, 'the row remembers the first attempt');
  assert.equal(r0.toolFail, false);
  const r1 = s.rounds[1].find((r) => r.seat.vendor === 'codex');
  assert.equal(r1.failed, true);
  assert.equal(r1.toolFail, true);
  assert.equal(r1.stanceKey, 'other: no reply');
  assert.match(r1.errors[0], /used tools again/);
  assert.ok(events.some((e) => e.type === 'seat-state' && e.seat.lens === 'cost' && e.round === 1 && e.state === 'failed'));
  // strictTools off: the same replies pass
  const { d: lax } = debate((v, round) => ({ text: disagreeForever(v, round), usedTools: true }), { options: { critiqueRounds: 0, strictTools: false } });
  const s2 = await lax.run();
  assert.ok(s2.rounds[0].every((r) => r.valid && !r.reprompted));
});

test('budget cap: a round whose projection would cross the vendor cap is not run; the gate names the vendor', async () => {
  // 10 input + 5 output per fake call; the fallback baseline is far larger, so give baselines
  const baselines = { claude: { fresh: { input: 100, output: 10, n: 1, cost: 0.5, nCost: 1 }, resumed: { input: 100, output: 10, n: 1, cost: 0.5, nCost: 1 } },
    codex: { fresh: { input: 100, output: 10, n: 1, cost: null, nCost: 0 }, resumed: { input: 100, output: 10, n: 1, cost: null, nCost: 0 } },
    agy: { fresh: { input: 100, output: 10, n: 1, cost: null, nCost: 0 }, resumed: { input: 100, output: 10, n: 1, cost: null, nCost: 0 } } };
  const run = async (budget, extra = {}) => {
    const fr = fakeRunner(disagreeForever);
    const events = [], rows = [];
    const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, gate: autoGate, store: { append: (r) => rows.push(r), writeFieldNotes() {}, writeVerdict() {} }, emit: (t, p) => events.push(p), options: { critiqueRounds: 3, budget, ...extra }, baselines });
    return { s: await d.run(), events, rows, fr };
  };
  // codex projects 110 per round and spends 15; a 130 cap lets rounds 0 and 1 run (15 + 110 fits), then round 2 (30 + 110) would cross
  const a = await run({ codex: { tokens: 130 } });
  assert.equal(a.s.stopReason, 'budget');
  assert.equal(a.s.rounds.length, 2);
  const ev = a.events.find((e) => e.type === 'budget');
  assert.deepEqual({ vendor: ev.vendor, kind: ev.kind, spent: ev.spent, projected: ev.projected, cap: ev.cap, what: ev.what }, { vendor: 'codex', kind: 'tokens', spent: 30, projected: 110, cap: 130, what: 'round 2' });
  assert.ok(a.rows.some((r) => r.type === 'budget' && r.vendor === 'codex'));
  assert.ok(a.s.verdict.text, 'the verdict still runs when the chairman vendor is not capped');
  assert.equal(a.s.verdict.skipped, undefined);
  // a dollar cap on claude (0.01 per fake call, baseline projects 0.5): round 0 fits nothing
  const b = await run({ claude: { usd: 0.3 } });
  assert.equal(b.s.rounds.length, 0);
  assert.equal(b.s.stopReason, 'budget');
  assert.equal(b.s.verdict.skipped, true, 'no round ran, no verdict');
  assert.equal(b.fr.calls.length, 0);
  // a round is admitted only if the verdict after it stays affordable: claude is the chairman
  // (projects 175) and a claude seat projects 110 a round, so a 150 cap runs nothing at all
  // (before the ledger, both rounds ran and then the verdict was refused)
  const c = await run({ claude: { tokens: 150 } }, { critiqueRounds: 1 });
  assert.equal(c.s.rounds.length, 0);
  assert.equal(c.s.verdict.skipped, true);
  assert.equal(c.events.find((e) => e.type === 'budget').what, 'round 0');
  assert.equal(c.fr.calls.length, 0);
  // 290: round 0 fits (110 + 175), round 1 does not (15 spent + 110 + 175), and the verdict that
  // was reserved for still runs (15 + 175)
  const e = await run({ claude: { tokens: 290 } }, { critiqueRounds: 1 });
  assert.equal(e.s.rounds.length, 1);
  assert.equal(e.events.find((x) => x.type === 'budget').what, 'round 1');
  assert.ok(e.s.verdict.text && !e.s.verdict.skipped, 'the reserved verdict runs');
  // no budget: nothing changes
  const n = await run({});
  assert.equal(n.s.stopReason, 'round-cap');
});

test('stability stop: a critique round where no stance moved and every NEW is none stops with reason stable', async () => {
  // seats disagree from round 0 on and never add anything: round 1 is stable
  const { d, events } = debate((v, round) => reply(v === 'claude' ? 'Ship now' : 'Wait a sprint', { new: 'none' }), { options: { critiqueRounds: 3 } });
  const s = await d.run();
  assert.equal(s.stopReason, 'stable');
  assert.equal(s.rounds.length, 2);
  assert.equal(events.find((e) => e.type === 'round-done' && e.round === 1).stop, 'stable');
  assert.ok(s.verdict.text);
  // something NEW in round 1 keeps it going; round 2 with nothing new is stable
  const { d: d2 } = debate((v, round) => reply(v === 'claude' ? 'Ship now' : 'Wait a sprint', { new: round === 1 ? 'a staged rollout' : 'none' }), { options: { critiqueRounds: 3 } });
  const s2 = await d2.run();
  assert.equal(s2.stopReason, 'stable');
  assert.equal(s2.rounds.length, 3);
  // a changed stance is not stable even with nothing new
  const { d: d3 } = debate((v, round) => reply(v === 'claude' ? (round === 1 ? 'Wait a sprint' : 'Ship now') : v === 'codex' ? 'Wait a sprint' : 'other: split', { new: 'none' }), { options: { critiqueRounds: 2 } });
  const s3 = await d3.run();
  assert.equal(s3.rounds.length, 3);
  assert.notEqual(s3.stopReason, 'stable', `round 1 moved claude; round 2 moved it back: ${s3.stopReason}`);
  // a PASS holds the previous stance: one seat passes, the others hold with nothing new -> stable (all-PASS needs everyone)
  const { d: d4 } = debate((v, round) => (round === 1 && v === 'agy' ? 'PASS' : reply(v === 'claude' ? 'Ship now' : 'Wait a sprint', { new: 'none' })), { options: { critiqueRounds: 3 } });
  const s4 = await d4.run();
  assert.equal(s4.stopReason, 'stable');
  assert.equal(s4.rounds.length, 2);
  // a failed seat blocks the stability stop as it blocks consensus
  const { d: d5 } = debate((v, round) => { if (v === 'agy' && round === 1) throw new Error('down'); return reply(v === 'claude' ? 'Ship now' : 'Wait a sprint', { new: 'none' }); }, { options: { critiqueRounds: 2 } });
  const s5 = await d5.run();
  assert.notEqual(s5.rounds.length, 2);
  // round 0 is never stable
  const { d: d6 } = debate((v) => reply(v === 'claude' ? 'Ship now' : 'Wait a sprint', { new: 'none' }), { options: { critiqueRounds: 0 } });
  assert.equal((await d6.run()).stopReason, 'round-cap');
});

// The ledger. Baselines make one codex call project 110 tokens; every fake call spends 15.
const CODEX_110 = { codex: { fresh: { input: 100, output: 10, n: 1, cost: null, nCost: 0 }, resumed: { input: 100, output: 10, n: 1, cost: null, nCost: 0 } } };

test('re-prompts that run concurrently are both reserved: the second one that would cross the cap is not made and that seat fails for the round', async () => {
  const seats = [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost a' }, { vendor: 'codex', lens: 'cost b' }];
  const fr = fakeRunner((v, round) => (v === 'codex' && round === 0 ? 'rambling' : reply(v === 'claude' ? 'Ship now' : 'Wait a sprint')));
  const events = [], rows = [];
  // round 0 admits 220 for codex. After both first calls (30 spent), the first re-prompt fits
  // (30 + 110 = 140); the second sees the first still in flight (30 + 110 + 110 = 250 > 240).
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats, chairman: { vendor: 'claude' }, runner: fr.runner, gate: autoGate, store: { append: (r) => rows.push(r) }, emit: (t, p) => events.push(p),
    options: { critiqueRounds: 0, budget: { codex: { tokens: 240 } } }, baselines: CODEX_110 });
  const s = await d.run();
  const codex = s.rounds[0].filter((r) => r.seat.vendor === 'codex');
  const refused = codex.filter((r) => r.failed);
  assert.equal(refused.length, 1, 'exactly one re-prompt refused');
  assert.match(refused[0].errors[0], /re-prompt would cross the codex budget/);
  assert.equal(codex.filter((r) => r.valid).length, 1, 'the other seat was re-prompted and recovered');
  assert.equal(fr.calls.filter((c) => c.round === 'reprompt').length, 1, 'the refused re-prompt was never made');
  const budget = events.filter((e) => e.type === 'budget');
  assert.equal(budget.length, 1);
  assert.match(budget[0].what, /^re-prompt of cost [ab]$/);
  assert.ok(rows.some((r) => r.type === 'budget' && /^re-prompt/.test(r.what)), 'the refusal is in the transcript');
  assert.ok(s.verdict.text && !s.verdict.skipped, 'a refused re-prompt does not stop the debate');
  // the ledger: 2 claude (seat, chairman) + 3 codex calls, each once
  assert.equal(rows.filter((r) => r.type === 'attempt').length, 5);
  assert.equal(rollup(rows).total.input, 50);
});

test('a call that ends without a usage report is recorded as unknown, not as zero, and is never missing from the ledger', async () => {
  const fr = fakeRunner(disagreeForever);
  const runner = async (vendor, prompt, sessionId, opts) => {
    if (vendor === 'agy') throw Object.assign(new Error('killed by stop'), { code: 'KILLED' });
    return fr.runner(vendor, prompt, sessionId, opts);
  };
  const events = [];
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner, gate: autoGate, store: stub(), emit: (t, p) => events.push(p), options: { critiqueRounds: 0 } });
  const s = await d.run();
  const agy = events.filter((e) => e.type === 'attempt' && e.seat.vendor === 'agy');
  assert.equal(agy.length, 1);
  assert.equal(agy[0].usage, null);
  assert.equal(agy[0].unknown, true);
  assert.ok(s.rounds[0].find((r) => r.seat.vendor === 'agy').failed);
  const u = rollup(events);
  assert.equal(u.unknownAttempts, 1);
  assert.deepEqual(u.bySeat[agy[0].seat.id].usage.tokenCoverage, { reported: 0, of: 1 }, 'the seat shows unknown usage, not no call yet');
});

test('unknown token usage blocks further calls only for that capped vendor, including re-prompts and network retries', async () => {
  for (const failure of ['valid', 'format', 'network']) for (const capped of [false, true]) {
    const fr = fakeRunner(disagreeForever), rows = [];
    let calls = 0;
    const runner = async (vendor, prompt, sid, opts) => {
      if (vendor !== 'codex') return fr.runner(vendor, prompt, sid, opts);
      calls++;
      if (failure === 'network') throw Object.assign(new Error('lost response'), { kind: 'network' });
      return { text: failure === 'format' ? 'invalid reply' : reply('Wait a sprint'), usage: null };
    };
    const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, chairman: { vendor: 'claude' }, runner,
      gate: autoGate, store: { append: (r) => rows.push(r) },
      options: { critiqueRounds: 2, networkRetryMs: 0, budget: capped ? { codex: { tokens: 1_000_000 } } : {} } });
    const s = await d.run();
    assert.equal(calls === 1, capped, `${failure}, capped=${capped}`);
    assert.equal(rows.filter((r) => r.type === 'attempt' && r.seat.vendor === 'codex').length, calls, 'refusals are not attempts');
    assert.equal(s.verdict.failed, false, 'the uncapped chairman can finish');
    if (capped) {
      assert.equal(rows.find((r) => r.type === 'budget').kind, 'tokens-unknown');
      assert.equal(rows.filter((r) => r.type === 'pool-down').length, 0, 'unknown usage is not a login failure');
    }
  }
});

test('unknown usage blocks the same vendor chairman across replay, resume and later synthesis', async () => {
  const { rebuildDebate } = await import('../src/store.js');
  const rows = [], fr = fakeRunner(disagreeForever);
  const runner = async (vendor, prompt, sid, opts) => ({ ...await fr.runner(vendor, prompt, sid, opts), usage: null });
  const options = { critiqueRounds: 2, budget: { codex: { tokens: 1_000_000 } } };
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, chairman: { vendor: 'codex' }, runner, options,
    gate: autoGate, store: { append: (r) => rows.push(r) } });
  const s = await d.run();
  assert.equal(fr.calls.filter((c) => c.vendor === 'codex').length, 1);
  assert.equal(s.verdict.skipped, true);
  assert.match(s.verdict.text, /usage.*unknown/i);
  const rb = rebuildDebate(rows);
  assert.deepEqual(rollup(rb.events), rollup(rows), 'replay retains unknown accounting');
  assert.equal(rb.events.filter((e) => e.type === 'budget').at(-1).kind, 'tokens-unknown');
  for (const synthesisOnly of [false, true]) {
    let calls = 0;
    const resumed = createDebate({ fieldNotes: FIELD_NOTES, seats: rb.seats, chairman: { vendor: 'codex' }, options,
      runner: async () => { calls++; throw new Error('must not dispatch'); }, gate: autoGate, store: stub(), synthesisOnly,
      resume: { rounds: rb.rounds, humanNotes: rb.humanNotes, ledger: rb.ledger } });
    assert.equal((await resumed.run()).verdict.skipped, true);
    assert.equal(calls, 0, 'restart grants no additional calls');
  }
});

test('rollup keeps unknown token coverage, elapsed time and known cost without confusing a measured zero', async () => {
  const { rebuildDebate } = await import('../src/store.js');
  const rows = [];
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, chairman: { vendor: 'claude' },
    runner: async (vendor, prompt) => ({ text: /^You are the chairman/.test(prompt) ? GOOD_VERDICT : reply('Ship now'),
      usage: vendor === 'claude' ? null : { input: 0, output: 0, cost: 0, ms: 2 },
      cost: 0.01, rawCost: 0.02, ms: 7, sessionId: `s-${vendor}` }),
    gate: autoGate, store: { append: (r) => rows.push(r) }, options: { critiqueRounds: 0, memory: 'resume' } });
  await d.run();
  const u = rollup(rows);
  assert.deepEqual(u.total.tokenCoverage, { reported: 2, of: 4 });
  assert.deepEqual(u.total.costCoverage, { reported: 4, of: 4 });
  assert.equal(u.total.cost, 0.02);
  assert.equal(u.total.ms, 18);
  assert.deepEqual(u.bySeat['seat-1'].usage.tokenCoverage, { reported: 1, of: 1 });
  assert.equal(rebuildDebate(rows).seats[0].lastRawCost, 0.02, 'cost-only reports survive restart');
});

test('a cap in dollars cannot be checked against a vendor that reports no cost', async () => {
  const fr = fakeRunner(disagreeForever);
  const baselines = { claude: { fresh: { input: 100, output: 10, n: 1, cost: null, nCost: 0 }, resumed: { input: 100, output: 10, n: 1, cost: null, nCost: 0 } } };
  const events = [];
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, gate: autoGate, store: stub(), emit: (t, p) => events.push(p), options: { critiqueRounds: 0, budget: { claude: { usd: 5 } } }, baselines });
  const s = await d.run();
  assert.equal(s.stopReason, 'budget');
  assert.equal(events.find((e) => e.type === 'budget').kind, 'usd-unknown');
  assert.equal(fr.calls.length, 0);
});

test('every human note carries forward, labelled: rounds 1 to 3 and a stateless re-prompt all see a correction made after round 0', async () => {
  const notes = { 0: 'Traffic doubled last month', 1: 'Budget is fixed' };
  const gate = async (info) => ({ action: 'continue', message: notes[info.round] || '' });
  const { d, fr } = debate((v, round) => (v === 'codex' && round === 2 ? 'rambling' : disagreeForever(v, round)), { gate, options: { critiqueRounds: 3 } });
  await d.run();
  for (const r of [1, 2, 3]) {
    const p = fr.calls.find((c) => c.round === r && c.vendor === 'claude').prompt;
    assert.match(p, /- Human — After round 0[^\n]*: Traffic doubled last month/, `round ${r} keeps the round-0 note`);
  }
  const r3 = fr.calls.find((c) => c.round === 3 && c.vendor === 'claude').prompt;
  assert.match(r3, /- Human — After round 0: Traffic doubled last month\n- Human — After round 1 \(latest\): Budget is fixed/);
  const reprompt = fr.calls.find((c) => c.round === 'reprompt' && c.vendor === 'codex').prompt;
  assert.match(reprompt, /Traffic doubled last month/);
  assert.match(reprompt, /Budget is fixed/);
});

test('resume mode sends only the notes the thread has not seen', async () => {
  const gate = async (info) => ({ action: 'continue', message: info.round === 0 ? 'Old note' : info.round === 1 ? 'New note' : '' });
  const { d, fr } = debate(disagreeForever, { gate, options: { critiqueRounds: 2, memory: 'resume' } });
  await d.run();
  const r2 = fr.calls.find((c) => c.round === 2 && c.vendor === 'claude').prompt;
  assert.match(r2, /New note/);
  assert.doesNotMatch(r2, /Old note/, 'the resumed thread already holds it');
});

// S8: the chairman is checked; the wall clock is one absolute deadline.
test('a chairman that uses tools is re-prompted once, then its verdict is recorded failed', async () => {
  const rows = [];
  const fr = fakeRunner((v, round) => (round === 'verdict' ? { text: GOOD_VERDICT, usedTools: true } : disagreeForever(v, round)));
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, gate: autoGate, store: { append: (r) => rows.push(r) }, emit() {}, options: { critiqueRounds: 0 } });
  const s = await d.run();
  const chair = fr.calls.filter((c) => c.round === 'verdict');
  assert.equal(chair.length, 2, 'one re-prompt');
  assert.match(chair[1].prompt, /did not follow the required format/);
  assert.match(chair[1].prompt, /Tools are not allowed/);
  assert.doesNotMatch(chair[1].prompt, /--- TRANSCRIPT/, 'the re-prompt fixes the form; the transcript stays out');
  assert.equal(s.verdict.failed, true);
  assert.ok(rows.some((r) => r.type === 'verdict' && r.failed === true));
});

test('a malformed chairman reply is re-prompted once and the corrected verdict stands', async () => {
  let n = 0;
  const fr = fakeRunner((v, round) => (round === 'verdict' ? (n++ === 0 ? 'RECOMMENDATION: Ship now, on balance.\nTALLY:\n- x\nDISSENT: y\nKILL_CRITERIA:\n- z\nOPEN_QUESTIONS:\n- q' : GOOD_VERDICT) : disagreeForever(v, round)));
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, gate: autoGate, store: stub(), emit() {}, options: { critiqueRounds: 0 } });
  const s = await d.run();
  assert.equal(fr.calls.filter((c) => c.round === 'verdict').length, 2);
  assert.equal(s.verdict.failed, false);
  assert.match(s.verdict.text, /^RECOMMENDATION: opt-1/);
});

test('a chairman re-prompt that would cross the cap is not made', async () => {
  const baselines = { claude: { fresh: { input: 100, output: 10, n: 1, cost: null, nCost: 0 }, resumed: { input: 100, output: 10, n: 1, cost: null, nCost: 0 } } };
  const fr = fakeRunner((v, round) => (round === 'verdict' ? 'RECOMMENDATION: maybe\nTALLY:\n- x' : disagreeForever(v, round)));
  const events = [];
  // round 0 (claude 110) + chairman (175) fit in 300. The chairman's first call reads 200 tokens,
  // so 15 + 205 spent plus a second chairman call (175) would not.
  const runner = async (v, p, sid, o) => { const r = await fr.runner(v, p, sid, o); return /^You are the chairman/.test(p) ? { ...r, usage: { ...r.usage, input: 200 } } : r; };
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, chairman: { vendor: 'claude' }, runner, gate: autoGate, store: stub(), emit: (t, p) => events.push(p), options: { critiqueRounds: 0, budget: { claude: { tokens: 300 } } }, baselines });
  const s = await d.run();
  assert.equal(fr.calls.filter((c) => c.round === 'verdict').length, 1);
  assert.equal(s.verdict.failed, true);
  assert.equal(events.find((e) => e.type === 'budget').what, 're-prompt of the chairman');
});

test('a wall clock that runs out during the human gate dispatches no further seat and skips the verdict', async () => {
  let t = 0;
  const gate = async () => { t = 31 * 60_000; return { action: 'continue' }; }; // the human took 31 minutes
  const { d, fr } = debate(disagreeForever, { gate, now: () => t, options: { critiqueRounds: 3, wallClockMs: 30 * 60_000 } });
  const s = await d.run();
  assert.equal(s.stopReason, 'wall-clock');
  assert.equal(s.rounds.length, 1);
  assert.equal(fr.calls.length, 3, 'round 0 only; no chairman either');
  assert.equal(s.verdict.skipped, true);
  assert.equal(s.verdict.reason, 'wall-clock');
});

test('a gate nobody answers ends at the deadline', async () => {
  const events = [];
  const fr = fakeRunner(disagreeForever);
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, gate: () => new Promise(() => {}), store: stub(), emit: (t, p) => events.push(p), options: { critiqueRounds: 2, wallClockMs: 30 } });
  const s = await d.run();
  assert.equal(s.stopReason, 'wall-clock');
  assert.ok(events.some((e) => e.type === 'gate-expired'));
  assert.equal(s.verdict.skipped, true);
  assert.equal(s.stopContext, 'waiting');
  assert.equal(events.find((e) => e.type === 'stopped').context, 'waiting');
});

test('a call in flight at the deadline is cancelled and its seat fails for the round', async () => {
  let release;
  const runner = (vendor, prompt) => (vendor === 'agy' && /Round 1 of/.test(prompt)
    ? new Promise((_, reject) => { release = () => reject(new Error('killed')); })
    : fakeRunner(disagreeForever).runner(vendor, prompt, null, {}));
  let cancelled = 0;
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner, gate: autoGate, store: stub(), emit() {}, cancel: () => { cancelled++; release?.(); }, options: { critiqueRounds: 2, wallClockMs: 60 } });
  const s = await d.run();
  assert.equal(cancelled, 1);
  const agy = s.rounds[1].find((r) => r.seat.vendor === 'agy');
  assert.equal(agy.failed, true);
  assert.equal(agy.cancelReason, 'wall-clock');
  assert.match(agy.errors[0], /wall clock ran out during the call/);
  assert.equal(s.stopReason, 'wall-clock');
});

test('questions in the final critique round still wait for answers before the verdict', async () => {
  const gates = [];
  const fr = fakeRunner((vendor, round) => reply(vendor === 'claude' ? 'opt-1' : 'opt-2', { question: round === 1 ? 'What evidence would change the plan?' : null }));
  const state = await createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, store: stub(), options: { critiqueRounds: 1 },
    gate: async (info) => { gates.push(info); return { action: 'continue', message: info.round === 1 ? 'The pilot must be reversible.' : '' }; },
  }).run();
  assert.deepEqual(gates.map((g) => g.round), [0, 1]);
  assert.equal(gates[1].stop, 'round-cap');
  assert.equal(state.rounds.length, 2);
  assert.match(fr.calls.find((c) => c.round === 'verdict').prompt, /The pilot must be reversible/);
});

test('a resumed debate keeps its original deadline', async () => {
  const fr = fakeRunner(disagreeForever);
  const first = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: fr.runner, gate: autoGate, store: stub(), emit() {}, now: () => 0, options: { critiqueRounds: 0, wallClockMs: 1000 } });
  const s0 = await first.run();
  const fr2 = fakeRunner(disagreeForever);
  // the restart happens an hour later; the deadline set at the start (t = 1000) has long passed
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: s0.seats, runner: fr2.runner, gate: autoGate, store: stub(), emit() {}, now: () => 3_600_000,
    options: { critiqueRounds: 2, wallClockMs: 1000 }, resume: { rounds: s0.rounds, humanNotes: [], deadlineAt: 1000 } });
  const s = await d.run();
  assert.equal(s.stopReason, 'wall-clock');
  assert.equal(fr2.calls.length, 0, 'no fresh half hour after a restart');
});

test('a login out of quota is down for the debate: its seat is skipped without a call, the board is told once', async () => {
  const fr = fakeRunner(disagreeForever);
  let codexCalls = 0;
  const runner = async (vendor, prompt, sid, o) => {
    if (vendor === 'codex') { codexCalls++; throw Object.assign(new Error('Codex: usage limit reached, resets 27 Oct, 12:51.'), { kind: 'quota', resetsAt: 1800000000000 }); }
    return fr.runner(vendor, prompt, sid, o);
  };
  const events = [], rows = [];
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner, gate: autoGate, store: { append: (r) => rows.push(r) }, emit: (t, p) => events.push(p), options: { critiqueRounds: 2 } });
  const s = await d.run();
  assert.equal(codexCalls, 1, 'one call found the limit; later rounds did not call again');
  const downs = events.filter((e) => e.type === 'pool-down');
  assert.equal(downs.length, 1);
  assert.deepEqual([downs[0].vendor, downs[0].kind, downs[0].resetsAt], ['codex', 'quota', 1800000000000]);
  assert.ok(rows.some((r) => r.type === 'pool-down'));
  const codex = s.rounds.map((r) => r.find((x) => x.seat.vendor === 'codex'));
  assert.equal(codex[0].errorKind, 'quota');
  assert.equal(codex[0].state, 'down');
  assert.ok(codex.slice(1).every((x) => x.skipped && x.failed), 'skipped in later rounds');
  assert.ok(s.verdict.text && !s.verdict.failed, 'the debate goes on with the other seats');
});

test('a network failure gets one retry, and a second one fails the seat for the round only', async () => {
  const fr = fakeRunner(disagreeForever);
  let tries = 0;
  const runner = async (vendor, prompt, sid, o) => {
    if (vendor === 'agy' && /round 0/i.test(prompt) && tries++ < 1) throw Object.assign(new Error('Antigravity: could not reach the service.'), { kind: 'network' });
    if (vendor === 'codex') throw Object.assign(new Error('Codex: could not reach the service.'), { kind: 'network' });
    return fr.runner(vendor, prompt, sid, o);
  };
  const events = [];
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner, gate: autoGate, store: stub(), emit: (t, p) => events.push(p), options: { critiqueRounds: 0, networkRetryMs: 0 } });
  const s = await d.run();
  assert.ok(s.rounds[0].find((r) => r.seat.vendor === 'agy').valid, 'the retry answered');
  const codex = s.rounds[0].find((r) => r.seat.vendor === 'codex');
  assert.equal(codex.errorKind, 'network');
  assert.equal(events.filter((e) => e.type === 'attempt' && e.seat.vendor === 'codex').length, 2, 'two attempts, both in the ledger');
  assert.equal(events.filter((e) => e.type === 'pool-down').length, 0, 'a network failure does not take the login out');
});

test('network retries recheck token and dollar caps against the failed attempt, without charging a refused retry', async () => {
  const baselines = { codex: { fresh: { input: 10, output: 10, n: 1, cost: 0.2, nCost: 1 } } };
  for (const [cap, allowed] of [[{ tokens: 25 }, false], [{ tokens: 40 }, true], [{ usd: 0.25 }, false], [{ usd: 0.4 }, true]]) {
    const fr = fakeRunner(disagreeForever), rows = [];
    let calls = 0;
    const runner = async (vendor, prompt, sid, opts) => {
      if (vendor !== 'codex') return fr.runner(vendor, prompt, sid, opts);
      const usage = { input: 10, output: 10, cost: 0.2 };
      if (++calls === 1) throw Object.assign(new Error('connection lost after usage was reported'), { kind: 'network', usage });
      return { text: reply('Wait a sprint'), usage };
    };
    const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner, gate: autoGate, store: { append: (r) => rows.push(r) },
      baselines, options: { critiqueRounds: 0, networkRetryMs: 0, budget: { codex: cap } } });
    const s = await d.run();
    const seat = s.rounds[0].find((r) => r.seat.vendor === 'codex');
    assert.equal(calls, allowed ? 2 : 1, JSON.stringify(cap));
    assert.equal(seat.valid, allowed);
    const attempts = rows.filter((r) => r.type === 'attempt' && r.seat.vendor === 'codex');
    assert.equal(attempts.length, calls, 'only calls actually dispatched enter the ledger');
    assert.equal(attempts[0].errorKind, 'network');
    assert.equal(rollup(attempts).total.input, calls * 10);
    if (!allowed) {
      assert.equal(seat.errorKind, 'budget');
      assert.equal(seat.skipped, false, 'a budget refusal does not mark the login out for the debate');
      assert.equal(seat.attemptId, null);
      assert.match(seat.errors[0], /network retry would cross the codex budget/);
      const refusal = rows.find((r) => r.type === 'budget');
      assert.equal(refusal.what, 'network retry of cost');
      assert.equal(refusal.spent, cap.tokens ? 20 : 0.2);
      assert.equal(refusal.projected, cap.tokens ? 20 : 0.2);
    }
    assert.equal(s.verdict.failed, false, 'an uncapped chairman remains available');
  }
});

test('concurrent network retries reserve their allowance before dispatch', async () => {
  const seats = [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost a' }, { vendor: 'codex', lens: 'cost b' }];
  const baselines = { codex: { fresh: { input: 10, output: 10, n: 1 } } };
  const fr = fakeRunner(disagreeForever), rows = [], calls = new Map();
  let release, retries = 0;
  const retryFinished = new Promise((resolve) => { release = resolve; });
  const runner = async (vendor, prompt, sid, opts) => {
    if (vendor !== 'codex') return fr.runner(vendor, prompt, sid, opts);
    const n = (calls.get(opts.seat.id) || 0) + 1;
    calls.set(opts.seat.id, n);
    if (n === 1) throw Object.assign(new Error('connection lost'), { kind: 'network', usage: { input: 5, output: 5 } });
    // The first retry stays in flight until the second is refused (or wrongly dispatched).
    if (++retries === 2) release();
    await retryFinished;
    return { text: reply('Wait a sprint'), usage: { input: 10, output: 10 } };
  };
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats, runner, gate: autoGate, store: { append: (r) => rows.push(r) },
    emit: (type) => { if (type === 'budget') release(); }, baselines,
    options: { critiqueRounds: 0, networkRetryMs: 0, budget: { codex: { tokens: 50 } } } });
  const s = await d.run();
  assert.equal(retries, 1, 'two failed 10-token calls leave room for only one 20-token retry');
  const refusal = rows.find((r) => r.type === 'budget');
  assert.equal(refusal.spent, 40, '20 measured tokens plus the in-flight 20-token reservation');
  assert.equal(refusal.projected, 20);
  assert.equal(s.rounds[0].filter((r) => r.errorKind === 'budget').length, 1);
  assert.equal(rows.filter((r) => r.type === 'attempt' && r.seat.vendor === 'codex').length, 3);
});

test('a network retry leaves the projected chairman call affordable', async () => {
  const baselines = { codex: { fresh: { input: 10, output: 10, n: 1 } } };
  const fr = fakeRunner(disagreeForever), rows = [];
  let seatCalls = 0, chairmanCalls = 0;
  const runner = async (vendor, prompt, sid, opts) => {
    if (vendor !== 'codex') return fr.runner(vendor, prompt, sid, opts);
    const usage = { input: 10, output: 10 };
    if (opts.seat.id === 'chairman') { chairmanCalls++; return { text: GOOD_VERDICT, usage }; }
    if (++seatCalls === 1) throw Object.assign(new Error('connection lost'), { kind: 'network', usage });
    return { text: reply('Wait a sprint'), usage };
  };
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, chairman: { vendor: 'codex' }, runner, gate: autoGate,
    store: { append: (r) => rows.push(r) }, baselines, options: { critiqueRounds: 0, networkRetryMs: 0, budget: { codex: { tokens: 60 } } } });
  const s = await d.run();
  assert.equal(seatCalls, 1, '20 spent + 20 retry + 31 chairman would cross 60');
  assert.equal(chairmanCalls, 1, '20 spent + 31 chairman still fits');
  assert.equal(rows.find((r) => r.type === 'budget').projected, 51);
  assert.equal(s.verdict.failed, false);
});

test('chairman network retries obey the cap in normal and synthesis-only runs', async () => {
  const baselines = { codex: { fresh: { input: 10, output: 0, n: 1 } } };
  for (const synthesisOnly of [false, true]) {
    const fr = fakeRunner(disagreeForever), rows = [];
    const reviewSeats = SEATS.filter((s) => s.vendor !== 'codex');
    const collected = synthesisOnly ? await createDebate({ fieldNotes: FIELD_NOTES, seats: reviewSeats,
      runner: fr.runner, gate: async () => ({ action: 'stop' }), options: { critiqueRounds: 0 } }).run() : null;
    let calls = 0;
    const runner = async (vendor, prompt, sid, opts) => {
      if (vendor !== 'codex') return fr.runner(vendor, prompt, sid, opts);
      if (++calls === 1) throw Object.assign(new Error('connection lost'), { kind: 'network', usage: { input: 20, output: 0 } });
      return { text: GOOD_VERDICT, usage: { input: 20, output: 0 } };
    };
    const d = createDebate({ fieldNotes: FIELD_NOTES, seats: reviewSeats, chairman: { vendor: 'codex' }, runner,
      gate: autoGate, store: { append: (r) => rows.push(r) }, baselines, synthesisOnly,
      resume: synthesisOnly ? { rounds: collected.rounds, humanNotes: [], ledger: [] } : null,
      options: { critiqueRounds: 0, networkRetryMs: 0, budget: { codex: { tokens: 25 } } } });
    const s = await d.run();
    assert.equal(calls, 1);
    assert.equal(s.verdict.failed, true);
    assert.equal(s.verdict.skipped, true);
    assert.equal(s.verdict.reason, 'budget', 'the board explains a budget refusal, not a malformed verdict');
    assert.equal(rows.find((r) => r.type === 'budget').what, 'network retry of the chairman');
    assert.equal(rows.filter((r) => r.type === 'attempt' && r.seat.vendor === 'codex').length, 1);
  }
});

test('a fallback chairman is admitted against its own vendor projection and cap', async () => {
  const baselines = { codex: { fresh: { input: 10, output: 10, n: 1 } } };
  const fr = fakeRunner(disagreeForever), rows = [];
  let fallbackCalls = 0;
  const runner = async (vendor, prompt, sid, opts) => {
    if (opts.seat.id === 'chairman') {
      if (vendor === 'claude') throw Object.assign(new Error('quota exhausted'), { kind: 'quota' });
      fallbackCalls++;
    }
    return fr.runner(vendor, prompt, sid, opts);
  };
  const d = createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, chairman: { vendor: 'claude' }, runner, gate: autoGate,
    store: { append: (r) => rows.push(r) }, baselines, options: { critiqueRounds: 0, budget: { codex: { tokens: 30 } } } });
  const s = await d.run();
  assert.equal(fallbackCalls, 0, '15 spent + the codex chairman projection of 31 would cross 30');
  assert.equal(s.verdict.failed, true);
  assert.equal(s.verdict.skipped, true);
  assert.equal(s.verdict.reason, 'budget');
  const refusal = rows.find((r) => r.type === 'budget');
  assert.equal(refusal.vendor, 'codex');
  assert.equal(refusal.projected, 31);
});

test('a seat out for the debate leaves the table: the others can reach consensus, and one seat left stops the debate', async () => {
  const quota = () => Object.assign(new Error('Codex: usage limit reached.'), { kind: 'quota' });
  // three seats, codex out from round 0; claude and agy agree in round 1: consensus, not round-cap
  const fr = fakeRunner((v, round) => reply(round === 0 && v === 'agy' ? 'Wait a sprint' : 'Ship now'));
  const runner = async (vendor, ...rest) => { if (vendor === 'codex') throw quota(); return fr.runner(vendor, ...rest); };
  const a = await createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner, gate: autoGate, store: stub(), emit() {}, options: { critiqueRounds: 4 } }).run();
  assert.equal(a.stopReason, 'consensus');
  assert.equal(a.rounds.length, 2, 'stopped at round 1, not after four rounds of waiting for codex');
  // two seats, codex out: one voice is no debate
  const fr2 = fakeRunner(disagreeForever);
  const runner2 = async (vendor, ...rest) => { if (vendor === 'codex') throw quota(); return fr2.runner(vendor, ...rest); };
  const b = await createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS.slice(0, 2), runner: runner2, gate: autoGate, store: stub(), emit() {}, options: { critiqueRounds: 4 } }).run();
  assert.equal(b.stopReason, 'seats-down');
  assert.equal(b.rounds.length, 1);
  assert.ok(b.verdict.text && !b.verdict.skipped, 'the chairman still writes from what was said');
  // a seat failing for one round only (a timeout) still blocks consensus that round
  let n = 0;
  const fr3 = fakeRunner(() => reply('Ship now'));
  const runner3 = async (vendor, ...rest) => { if (vendor === 'agy' && n++ === 0) throw Object.assign(new Error('timed out'), { kind: 'timeout', code: 'TIMEOUT' }); return fr3.runner(vendor, ...rest); };
  const c = await createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, runner: runner3, gate: autoGate, store: stub(), emit() {}, options: { critiqueRounds: 3 } }).run();
  assert.equal(c.rounds.length, 2, 'round 0 had a timeout, so consensus waited for round 1');
});

test('a chairman whose login is out hands the verdict to another seated vendor, once; nobody left means a failed verdict', async () => {
  const quota = () => Object.assign(new Error('Claude: usage limit reached.'), { kind: 'quota' });
  // claude chairs; its login goes out on the chairman call; codex (seated, not out) writes instead
  const fr = fakeRunner(disagreeForever);
  const runner = async (vendor, prompt, ...rest) => { if (vendor === 'claude' && /^You are the chairman/.test(prompt)) throw quota(); return fr.runner(vendor, prompt, ...rest); };
  const events = [], rows = [];
  const a = await createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, chairman: { vendor: 'claude', model: 'opus' }, runner, gate: autoGate, store: { append: (r) => rows.push(r) }, emit: (t, p) => events.push(p), options: { critiqueRounds: 0 } }).run();
  assert.equal(a.verdict.failed, false);
  assert.equal(a.verdict.seat.vendor, 'codex');
  const fb = events.find((e) => e.type === 'chairman-fallback');
  assert.deepEqual([fb.from.vendor, fb.to], ['claude', 'codex']);
  assert.ok(rows.some((r) => r.type === 'chairman-fallback'));
  assert.ok(fr.calls.some((c) => c.vendor === 'codex' && c.round === 'verdict' && !c.opts.model), 'the fallback runs at its default model, not the original chairman model');
  // the chairman's login was already out from the rounds: no call is wasted on it
  const runner2 = async (vendor, ...rest) => { if (vendor === 'claude') throw quota(); return fr.runner(vendor, ...rest); };
  const calls = [];
  const b = await createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS, chairman: { vendor: 'claude' }, runner: async (v, ...r) => { calls.push(v); return runner2(v, ...r); }, gate: autoGate, store: stub(), emit() {}, options: { critiqueRounds: 0 } }).run();
  assert.equal(b.verdict.seat.vendor, 'codex');
  assert.equal(calls.filter((v) => v === 'claude').length, 1, 'claude was called once (round 0), never as chairman');
  // every other vendor out too: the verdict fails and can be written later
  const runner3 = async (vendor, ...rest) => { if (vendor !== 'agy') throw quota(); return fr.runner(vendor, ...rest); };
  const c = await createDebate({ fieldNotes: FIELD_NOTES, seats: SEATS.slice(0, 2), chairman: { vendor: 'claude' }, runner: runner3, gate: autoGate, store: stub(), emit() {}, options: { critiqueRounds: 0 } }).run();
  assert.equal(c.stopReason, 'all-failed', 'no seat answered at all');
  assert.ok(c.verdict.failed || c.verdict.skipped, 'no vendor left to fall back to');
});
