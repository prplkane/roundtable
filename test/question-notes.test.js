import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply } from '../src/contract.js';
import { createDebate } from '../src/engine.js';
import { rebuildDebate } from '../src/store.js';
import { decisionRecord } from '../src/export.js';
import { noteRecord, noteLabel } from '../src/notes.js';
import { validateMessage } from '../src/validate.js';

const fieldNotes = { decision: 'Synthetic release review', options: ['Trial', 'Wait'] };
const seats = [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost' }];
const reply = (vendor, question = '') => `STANCE: ${vendor === 'claude' ? 'opt-1' : 'opt-2'}\nAGREE_WITH: []\nDISAGREE: different priorities\nNEW: a new constraint\nASSUMPTIONS: bounded trial\nQUESTION_FOR_HUMAN: ${question}`;
const verdict = 'RECOMMENDATION: opt-1\nTry it.\nDISSENT: cost prefers to wait\nKILL_CRITERIA: an overrun\nOPEN_QUESTIONS: the launch date';
const response = (text) => ({ text, usage: { input: 10, output: 5 }, sessionId: 'fake-session' });

test('explicit no-question placeholders do not become questions', () => {
  for (const value of ['', 'none', 'None.', '**None.**', '`N/A`', 'N/A.', '—', '- none', 'No question.',
    'No further questions for the human.', 'Not applicable.', 'none, treat available hours as an explicit unknown.',
    'None — treat the deadline as an assumption.', 'None; all questions have been answered.']) {
    assert.equal(parseReply(reply('claude', value)).question, null, value);
  }
});

test('ambiguous text and genuine questions survive, including missing punctuation', () => {
  for (const value of ['What is the deadline', 'Please confirm the budget', 'None of these options fit; which can change?',
    'None of these options fit', 'No budget has been set; can you set one', 'None? Please confirm.',
    'None; what is the deadline', 'None, treat hours as unknown; can you confirm availability',
    'None, treat how many hours are available as unknown', 'Когда срок', '期限はいつですか？']) {
    assert.equal(parseReply(reply('claude', value)).question, value, value);
  }
});

test('false questions neither block critique rounds nor add a final gate; real final questions still wait', async () => {
  for (const critiqueRounds of [1, 2]) {
    for (const question of ['none, treat available hours as an explicit unknown.', 'What is the launch date']) {
      const gates = [], calls = [];
      const state = await createDebate({ fieldNotes, seats, options: { critiqueRounds },
        runner: async (vendor, prompt) => {
          calls.push(prompt);
          return response(prompt.startsWith('You are the chairman') ? verdict : reply(vendor, question));
        },
        gate: async (info) => { gates.push(info); return { action: 'continue' }; },
      }).run();
      const real = question.startsWith('What');
      assert.equal(state.stopReason, 'round-cap');
      assert.equal(calls.length, 2 * (critiqueRounds + 1) + 1, 'no retry or classifier model call');
      assert.deepEqual(gates.map((g) => [g.round, g.mode]), real
        ? Array.from({ length: critiqueRounds + 1 }, (_, round) => [round, 'blocking'])
        : [[0, 'blocking'], ...(critiqueRounds === 2 ? [[1, 'countdown']] : [])]);
      if (!real) assert.ok(gates.every((g) => g.questions.length === 0));
    }
  }
});

test('agent and human note sources reach seats, retries, chairman, saved rows, replay and export', async () => {
  for (const memory of ['stateless', 'resume']) {
    const calls = [], rows = [], events = [], failed = new Set();
    const initialNotes = [{ text: 'Availability remains unknown.', source: 'agent' }, 'The trial can take one week.'];
    const state = await createDebate({ fieldNotes, seats, options: { memory, critiqueRounds: 2 },
      resume: { rounds: [], humanNotes: [], initialNotes },
      store: { append: (row) => rows.push(row) }, emit: (_, event) => events.push(event),
      runner: async (vendor, prompt) => {
        calls.push({ vendor, prompt });
        if (prompt.startsWith('You are the chairman')) return response(verdict);
        if (!failed.has(vendor)) { failed.add(vendor); return response('off contract'); }
        return response(reply(vendor));
      },
      gate: async ({ round }) => ({ action: 'continue', message: round === 0 ? 'Keep the budget unknown.' : 'I can fund the trial.', source: round === 0 ? 'agent' : 'human' }),
    }).run();
    const notes = rows.filter((r) => r.type === 'human');
    assert.deepEqual(notes.map((n) => [n.source, n.text]), [['agent', 'Keep the budget unknown.'], ['human', 'I can fund the trial.']]);
    assert.deepEqual(events.filter((e) => e.type === 'human'), notes);
    const later = calls.filter((c) => /^Round [12] of/m.test(c.prompt) || c.prompt.startsWith('You are the chairman'));
    for (const { prompt } of later.filter((c) => memory === 'stateless' || !/^Round 2 of/m.test(c.prompt))) {
      assert.match(prompt, /Agent coordinator — After round 0[^\n]*: Keep the budget unknown\./);
      assert.doesNotMatch(prompt, /Human[^\n]*Keep the budget unknown/);
    }
    const fresh = calls.filter((c) => c.prompt.includes('Availability remains unknown.'));
    assert.ok(fresh.length >= 3, 'initial notes reach both seats and the chairman');
    for (const { prompt } of fresh) assert.match(prompt, /Agent coordinator — Before round 0[^\n]*: Availability remains unknown\./);
    if (memory === 'stateless') assert.ok(calls.filter((c) => c.prompt.includes('did not follow the contract')).every((c) => c.prompt.includes('Availability remains unknown.')));
    assert.match(calls.at(-1).prompt, /Human — After round 1[^\n]*: I can fund the trial\./);
    assert.doesNotMatch(calls.map((c) => c.prompt).join('\n'), /\[object Object\]/);

    const transcript = [{ type: 'field-notes', schemaVersion: 3, fieldNotes, seats: state.seats, options: { memory, critiqueRounds: 2 } },
      ...initialNotes.map((note) => ({ type: 'human', round: -1, ...noteRecord(note) })), ...rows];
    const before = JSON.stringify(transcript), rb = rebuildDebate(transcript);
    assert.deepEqual(rb.humanNotes, state.humanNotes);
    assert.deepEqual(rb.events.filter((e) => e.type === 'human').map((n) => n.source), ['agent', 'human', 'agent', 'human']);
    const markdown = decisionRecord(transcript, 'synthetic-attribution').markdown;
    assert.match(markdown, /\*\*Agent coordinator:\*\* Keep the budget unknown\./);
    assert.match(markdown, /\*\*Human:\*\* I can fund the trial\./);
    assert.equal(JSON.stringify(transcript), before, 'reading does not rewrite old records');
    assert.equal(noteLabel(rb.initialNotes[0]), 'Agent note');
    assert.equal(noteLabel(rb.initialNotes[1]), 'You said');
  }
});

test('a stop note keeps its source for a separately requested verdict, without starting one on Stop', async () => {
  let release, started;
  const blocked = new Promise((r) => { release = r; }), inFlight = new Promise((r) => { started = r; });
  const rows = [], prompts = [];
  const debate = createDebate({ fieldNotes, seats, options: { critiqueRounds: 1 }, store: { append: (r) => rows.push(r) },
    runner: async (vendor, prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith('You are the chairman')) return response(verdict);
      if (/^Round 1 of/m.test(prompt)) { started(); await blocked; }
      return response(reply(vendor));
    }, gate: async ({ round }) => { assert.equal(round, 0, 'Stop during round 1 must not require another gate'); return { action: 'continue' }; },
  });
  const running = debate.run();
  await inFlight;
  debate.requestStop('Stop for the coordinator to check the setup.', 'agent');
  release(); const state = await running;
  assert.equal(rows.find((r) => r.type === 'human').source, 'agent');
  assert.ok(!prompts.some((p) => p.startsWith('You are the chairman')));
  await createDebate({ fieldNotes, seats, synthesisOnly: true,
    resume: { rounds: state.rounds, humanNotes: state.humanNotes, stopReason: state.stopReason },
    runner: async (_, prompt) => { prompts.push(prompt); return response(verdict); },
  }).run();
  assert.match(prompts.at(-1), /Agent coordinator — After round 1[^\n]*: Stop for the coordinator/);
});

test('legacy replay normalizes false questions without changing source text or usage', () => {
  const text = reply('claude', 'none, treat available hours as an explicit unknown.');
  const rows = [{ type: 'field-notes', schemaVersion: 3, fieldNotes, seats: [seats[0]] },
    { type: 'reply', round: 0, seat: seats[0], text, question: 'none, treat available hours as an explicit unknown.',
      parsed: { ...parseReply(text), question: 'none, treat available hours as an explicit unknown.' },
      usage: { input: 10, output: 5, usageVersion: 3 } },
    { type: 'human', round: 0, text: 'A legacy note.' }];
  const before = JSON.stringify(rows), rb = rebuildDebate(rows);
  assert.equal(rb.rounds[0][0].question, null);
  assert.equal(rb.rounds[0][0].parsed.question, null);
  assert.equal(rb.rounds[0][0].text, text);
  assert.equal(rb.events.filter((e) => e.type === 'attempt').length, 0, 'no duplicate legacy usage');
  assert.deepEqual(rb.humanNotes, [['A legacy note.']]);
  assert.equal(JSON.stringify(rows), before);
});

test('note sources are a bounded enum and omitted sources stay backward compatible', () => {
  assert.equal(validateMessage({ message: 'hello' }).source, 'human');
  assert.equal(validateMessage({ message: 'hello', source: 'agent' }).source, 'agent');
  for (const source of ['system', 'Agent', {}, [], true]) assert.throws(() => validateMessage({ source }), /source: human or agent/);
});
