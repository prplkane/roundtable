import test from 'node:test';
import assert from 'node:assert/strict';
import { groupQuestions, answerMessage, argumentHtml, remainingWindow, cancellationReason, stopExplanation, ceremonyOutcome, verdictView, verdictResultText, verdictHeadline, defaultSearchQuery } from '../src/review-view.js';

test('questions share an answer only when their wording matches; distinct questions and sources survive', () => {
  const questions = [{ lens: 'risk', seat: 'seat-0', question: 'What is the budget?' }, { lens: 'cost', seat: 'seat-1', question: '  What is the budget? ' }, { lens: 'evidence', seat: 'seat-2', question: 'Is the budget approved?' }];
  const grouped = groupQuestions(questions);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0].sources, ['risk', 'cost']);
  assert.deepEqual(grouped[0].seats, ['seat-0', 'seat-1'], 'the asking seats, for the board to name them');
  assert.deepEqual(groupQuestions([{ lens: 'risk', question: 'Why?' }])[0].seats, [], 'an older gate without seat ids');
  const text = answerMessage(questions, [{ id: 'q1', text: 'Not decided.' }], 'Keep the pilot reversible.');
  assert.match(text, /Question \(risk, cost\): What is the budget\?\nAnswer: Not decided/);
  assert.ok(text.endsWith('Keep the pilot reversible.'));
  assert.doesNotMatch(text, /approved/);
  const attributed = answerMessage(questions, [{ id: 'q1', text: 'Not decided.', from: 'user' }, { id: 'q2', text: 'Two weeks.', from: 'assistant' }], '', { attributed: true });
  assert.match(attributed, /\nAnswer \(the user's words, relayed by the assistant\): Not decided\./);
  assert.match(attributed, /\nAnswer \(the assistant's own, not the user's\): Two weeks\./);
  assert.match(answerMessage(questions, [{ id: 'q1', text: 'x' }], '', { attributed: true }), /the assistant's own/, 'an undeclared answer is the assistant\'s');
  assert.throws(() => answerMessage(questions, [{ id: 'q9', text: 'value' }]), (e) => e.status === 409);
  assert.throws(() => answerMessage(questions, [{ id: 'q1', text: 'a' }, { id: 'q1', text: 'b' }]), (e) => e.status === 409);
});

test('argument emphasis escapes HTML, preserves wording and does not turn negated support green', () => {
  const input = 'I do not support <img src=x onerror=alert(1)>; don’t reject evidence.';
  const html = argumentHtml(input, 'disagree');
  assert.match(html, /term-disagree">not<\/strong>/);
  assert.match(html, /term-disagree">don’t<\/strong>/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(argumentHtml('I do not support it', 'agree'), 'I do not support it');
  assert.match(argumentHtml('I support it', 'agree'), /term-agree">support<\/strong>/);
});

test('compact quota reports the limiting window, with no invented percentage for unknown usage', () => {
  assert.deepEqual(remainingWindow({ at: 100, windows: [{ label: '5h', used: .09 }, { label: '7d', used: .05 }] }), { at: 100, label: '5h', remaining: 91 });
  assert.equal(remainingWindow({ windows: [{ used: null }, { used: NaN }] }), null);
  assert.equal(remainingWindow({ windows: [{ used: 1.1, label: '5h' }] }).remaining, 0);
});

test('known cancellation differs from provider timeout, including old final-round records', () => {
  const reply = { failed: true, errorKind: 'killed', round: 1 };
  assert.equal(cancellationReason(reply, 'human', 1), 'human');
  assert.equal(cancellationReason(reply, 'wall-clock', 1), 'wall-clock');
  assert.equal(cancellationReason(reply, 'human', 2), null);
  assert.equal(cancellationReason({ ...reply, errorKind: 'timeout' }, 'human', 1), null);
  assert.match(stopExplanation('wall-clock', 'waiting'), /waiting for your input.*No answer was assumed/);
});

test('session cue: live endings play once by outcome; replayed history and unreadable transcripts stay still', () => {
  assert.equal(ceremonyOutcome({ type: 'done', synthesis: 'done', reason: 'round-cap' }), 'verdict');
  assert.equal(ceremonyOutcome({ type: 'done', synthesis: 'done', reason: 'all-failed' }), 'verdict', 'a verdict written from earlier rounds still counts');
  assert.equal(ceremonyOutcome({ type: 'done', synthesis: 'failed', reason: 'human' }), 'cancelled');
  assert.equal(ceremonyOutcome({ type: 'done', synthesis: 'missing', reason: 'seats-down' }), 'failed');
  assert.equal(ceremonyOutcome({ type: 'done', synthesis: 'skipped', reason: 'budget' }), 'ended');
  assert.equal(ceremonyOutcome({ type: 'done', synthesis: 'missing', reason: 'human' }), 'cancelled');
  assert.equal(ceremonyOutcome({ type: 'done', synthesis: 'done', reason: 'human' }), 'cancelled', 'old servers must not celebrate a verdict after Stop');
  assert.equal(ceremonyOutcome({ type: 'done', synthesis: 'done', cancelled: true }), 'cancelled');
  assert.equal(ceremonyOutcome({ type: 'done', synthesis: 'done', reason: 'human', cancelled: false }), 'verdict', 'a later, explicitly requested verdict may succeed');
  assert.equal(ceremonyOutcome({ type: 'done', synthesis: 'skipped', cancelled: true, replayed: true }), null);
  assert.equal(ceremonyOutcome({ type: 'error', message: 'The review stopped unexpectedly.' }), 'failed');
  assert.equal(ceremonyOutcome({ type: 'error', message: 'corrupt', fatal: true }), null);
  assert.equal(ceremonyOutcome({ type: 'done', synthesis: 'done', replayed: true }), null);
  assert.equal(ceremonyOutcome({ type: 'error', message: 'old', replayed: true }), null);
  assert.equal(ceremonyOutcome({ type: 'verdict' }), null);
  assert.equal(ceremonyOutcome(null), null);
});

test('agent state: a unanimous round 0 says what answering would cost; other gates do not', async () => {
  const { reviewSnapshot } = await import('../src/snapshot.js');
  const seats = [{ lens: 'risk' }, { lens: 'cost' }, { lens: 'evidence' }];
  const board = (info) => ({ slug: 'r', gen: 1, events: [], pending: { info }, debate: { canFinish: () => false, state: { seats, rounds: [], fieldNotes: { decision: 'd', options: ['A', 'B'] } } } });
  const agreed = reviewSnapshot(board({ round: 0, mode: 'blocking', stop: 'consensus', questions: [], reopenable: true }));
  assert.equal(agreed.gate.reopenCalls, 3, 'one more call per seat if the agent sends any text');
  const open = reviewSnapshot(board({ round: 0, mode: 'blocking', stop: null, questions: [], reopenable: false }));
  assert.equal(open.gate.reopenCalls, undefined);
});

test('agent state carries each deadline as epoch ms, an ISO timestamp and whole seconds left', async () => {
  const { reviewSnapshot, clock } = await import('../src/snapshot.js');
  const at = Date.now() + 90_500;
  const snap = reviewSnapshot({ slug: 'r', gen: 1, events: [], pending: { info: { round: 0, mode: 'blocking', stop: null, questions: [] }, autoContinueAt: at },
    debate: { canFinish: () => false, state: { seats: [{ lens: 'risk' }], rounds: [], deadlineAt: at + 60_000, fieldNotes: { decision: 'd', options: ['A', 'B'] } } } });
  assert.equal(snap.gate.autoContinueAt, at, 'the epoch field stays for existing clients');
  assert.equal(snap.gate.autoContinueAtIso, new Date(at).toISOString());
  assert.ok(snap.gate.secondsUntilAutoContinue >= 89 && snap.gate.secondsUntilAutoContinue <= 91, String(snap.gate.secondsUntilAutoContinue));
  assert.equal(snap.deadlineAtIso, new Date(at + 60_000).toISOString());
  assert.ok(snap.secondsUntilDeadline >= 149 && snap.secondsUntilDeadline <= 151, String(snap.secondsUntilDeadline));
  assert.deepEqual(clock('deadline', null), {}, 'no deadline, no readable fields');
  assert.equal(clock('deadline', Date.now() - 5000).secondsUntilDeadline, 0, 'a passed deadline reads as zero, never negative');
});

test('agent depth counts usable rounds separately from completed failed attempts, live and replayed', async () => {
  const { reviewSnapshot } = await import('../src/snapshot.js');
  const seats = [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost' }];
  const replies = (patch = {}) => seats.map((seat) => ({ seat, valid: true, parsed: {}, ...patch }));
  const scenarios = [
    { rounds: [replies(), replies({ failed: true })], attempted: 2, usable: 1, critiques: 0 },
    { rounds: [replies(), replies({ parsed: { pass: true } })], attempted: 2, usable: 1, critiques: 0 },
    { rounds: [replies(), replies({ usedTools: true }), replies({ toolFail: true })], attempted: 3, usable: 1, critiques: 0 },
    { rounds: [replies(), replies({ valid: false })], attempted: 2, usable: 1, critiques: 0 },
    { rounds: [replies(), replies().slice(0, 1)], attempted: 1, usable: 1, critiques: 0 },
    { rounds: [replies(), [replies()[0], replies({ failed: true })[1]]], attempted: 2, usable: 2, critiques: 1 },
  ];
  for (const scenario of scenarios) {
    const state = { seats, rounds: scenario.rounds, options: { critiqueRounds: 2 }, fieldNotes: { options: ['A', 'B'] } };
    for (const source of [{ debate: { state } }, { rebuilt: state }]) {
      const result = reviewSnapshot({ slug: 'synthetic', gen: 1, events: [], finished: true, ...source });
      assert.deepEqual(result.depth, { plannedCritiqueRounds: 2, attemptedRounds: scenario.attempted,
        attemptedCritiqueRounds: scenario.attempted - 1, completedRounds: scenario.usable, completedCritiqueRounds: scenario.critiques });
    }
  }
});


const CONCLUSION = `RECOMMENDATION: opt-1
Run a small pilot if the change can be reversed.

The pilot can answer the adoption question before a wider rollout.
It also keeps the initial cost bounded.
DISSENT: A pilot delays the wider benefit (customer).
KILL_CRITERIA:
- The pilot cannot be reversed without losing records.
OPEN_QUESTIONS:
- NEEDED: Can records be restored?
  Has that been checked?
- OPTIONAL: Which team could document the lessons?
`;
const CHOICES = ['Run a pilot', 'Roll out everywhere'];

test('a readable conclusion preserves the pick, answer, reasoning and classified questions', () => {
  const view = verdictView(CONCLUSION, CHOICES);
  assert.equal(view.pick, 'opt-1');
  assert.equal(view.option, CHOICES[0]);
  assert.equal(view.answer, 'Run a small pilot if the change can be reversed.');
  assert.deepEqual(view.reasons, ['The pilot can answer the adoption question before a wider rollout.\nIt also keeps the initial cost bounded.']);
  assert.deepEqual(view.questions, {
    needed: ['Can records be restored? Has that been checked?'],
    optional: ['Which team could document the lessons?'], unclassified: [],
  });
  assert.deepEqual(view.reconsider, ['The pilot cannot be reversed without losing records.']);
});

test('legacy prose and unclassified questions remain intact, never silently downgraded to optional', () => {
  const legacy = '**RECOMMENDATION:**\nRoll out everywhere, provided support is ready.\nTALLY:\n- Roll out everywhere: risk\nDISSENT: A pilot is cheaper.\nKILL_CRITERIA: none\nOPEN_QUESTIONS:\n- Is support ready?';
  const view = verdictView(legacy, CHOICES);
  assert.equal(view.pick, null);
  assert.equal(view.answer, 'Roll out everywhere, provided support is ready.');
  assert.deepEqual(view.questions, { needed: [], optional: [], unclassified: ['Is support ready?'] });
  assert.deepEqual(view.reconsider, []);
  const oldId = verdictView(legacy.replace('Roll out everywhere, provided support is ready.', 'opt-2\nThe support team can cover it.'), CHOICES);
  assert.equal(oldId.pick, 'opt-2');
  assert.equal(oldId.answer, 'The support team can cover it.');
});

test('none remains an abstention or synthesis; empty sections do not fabricate concerns', () => {
  const text = 'RECOMMENDATION: none\nCombine the approaches only after the goal is clear.\n\nNeither listed option captures that condition.\nDISSENT: None.\nKILL_CRITERIA:\n- None.\nOPEN_QUESTIONS:\n- NEEDED: What outcome matters?\n- OPTIONAL: None.';
  const view = verdictView(text, CHOICES);
  assert.equal(view.pick, 'none');
  assert.equal(view.option, null);
  assert.deepEqual(view.dissent, []);
  assert.deepEqual(view.reconsider, []);
  assert.deepEqual(view.questions, { needed: ['What outcome matters?'], optional: [], unclassified: [] });
  assert.match(verdictResultText(text, CHOICES), /Answer\nNO SINGLE OPTION RECOMMENDED\nCombine/);
  assert.doesNotMatch(verdictResultText(text, CHOICES), /Suggested option|Further exploration|Main reservation/);
});

test('only explicit empty values disappear; non-English and uncertain questions are preserved', () => {
  const text = CONCLUSION.replace(/OPEN_QUESTIONS:[\s\S]*/, 'OPEN_QUESTIONS:\n- **NEEDED:** Какой результат важнее?\n- OPTIONAL: None of these measures captures trust; what would?\n- How should we measure it?');
  const view = verdictView(text, CHOICES);
  assert.deepEqual(view.questions.needed, ['Какой результат важнее?']);
  assert.match(view.questions.optional[0], /^None of these measures/);
  assert.deepEqual(view.questions.unclassified, ['How should we measure it?']);
  assert.equal(verdictView(CONCLUSION.replace(/OPEN_QUESTIONS:[\s\S]*/, 'OPEN_QUESTIONS: None.'), CHOICES).questions.needed.length, 0);
});

test('copy result retains the conclusion and caveats without tally, protocol labels or run metadata', () => {
  const text = CONCLUSION.replace('DISSENT:', 'TALLY:\n- opt-2: incorrect generated tally\nDISSENT:');
  const copy = verdictResultText(text, CHOICES, 'How should we test the change?');
  assert.ok(copy.startsWith('How should we test the change?\n\nAnswer\nRUN A PILOT\nRun a small pilot'));
  for (const expected of ['Why\nThe pilot', 'Main reservation', 'What could change this', 'Clarification needed from you', 'Can records be restored?', 'Further exploration (optional)']) assert.ok(copy.includes(expected), expected);
  assert.doesNotMatch(copy, /RECOMMENDATION:|TALLY:|opt-1|opt-2|incorrect generated tally|NEEDED:|OPTIONAL:|verdict\.md/);
  assert.equal(verdictResultText('An old unstructured answer.', CHOICES), 'An old unstructured answer.');
});

test('the verdict headline comes from its validated option, even when prose mentions another first', () => {
  const view = verdictView(CONCLUSION.replace('Run a small pilot', 'Before rolling out everywhere, run a small pilot'), CHOICES);
  assert.equal(verdictHeadline(view), 'RUN A PILOT');
  assert.equal(verdictHeadline({ pick: null, option: null }), '', 'do not infer a pick from prose');
});

test('the default search query contains only the current question and candidate options', () => {
  const query = defaultSearchQuery({ decision: ' Which approach should we test? ', options: [' Run a pilot ', 'Wait'], constraints: 'PRIVATE CONSTRAINT', known: 'PRIVATE FACT', exportTo: 'PRIVATE PATH', answers: 'PRIVATE ANSWER' });
  assert.equal(query, 'Which approach should we test?\n\nOptions to investigate:\n- Run a pilot\n- Wait');
  assert.doesNotMatch(query, /PRIVATE/);
  assert.equal(defaultSearchQuery({ decision: 'An exact question?', options: [] }), 'An exact question?');
});
