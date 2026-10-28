import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, validateReply, matchStance, optionId, validateVerdict } from '../src/contract.js';

const OPTS = ['Ship now', 'Wait a sprint'];

test('parses a well-formed reply', () => {
  const r = validateReply([
    'STANCE: Ship now',
    'AGREE_WITH: [cost lens, risk lens]',
    'DISAGREE:',
    '- The migration is not blocking',
    'NEW:',
    '- none',
    'ASSUMPTIONS:',
    '- Traffic stays flat',
    'QUESTION_FOR_HUMAN: Is the deadline movable?',
  ].join('\n'), { options: OPTS, round: 1 });
  assert.equal(r.ok, true, r.errors.join(', '));
  assert.equal(r.parsed.stanceKey, 'opt-1', 'stance keys are option ids');
  assert.deepEqual(r.parsed.agreeWith, ['cost lens', 'risk lens']);
  assert.deepEqual(r.parsed.disagree, ['The migration is not blocking']);
  assert.equal(r.parsed.question, 'Is the deadline movable?');
});

test('extra bullets are trimmed to the limit, not sent back for a re-prompt', () => {
  const r = validateReply([
    'STANCE: opt-1',
    'AGREE_WITH: []',
    'DISAGREE:', '- a', '- b', '- c', '- d',
    'NEW:', '- one', '- two', '- three',
    'ASSUMPTIONS:', '- x',
  ].join('\n'), { options: OPTS, round: 1 });
  assert.equal(r.ok, true, 'a bullet count alone never costs a re-prompt');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.parsed.disagree, ['a', 'b', 'c']);
  assert.deepEqual(r.parsed.new, ['one', 'two']);
  assert.deepEqual(r.parsed.trimmed, ['DISAGREE', 'NEW']);
  assert.equal(validateReply('STANCE: opt-1\nDISAGREE:\n- a\nNEW: none\nASSUMPTIONS:\n- x', { options: OPTS, round: 0 }).parsed.trimmed, undefined);
});

test('tolerates markdown bold headers and a code fence', () => {
  const r = validateReply('```\n**STANCE:** wait a sprint\nAGREE_WITH: []\nDISAGREE:\n- x\nNEW: none\nASSUMPTIONS:\n- y\n```', { options: OPTS, round: 1 });
  assert.equal(r.ok, true, r.errors.join(', '));
  assert.equal(r.parsed.stanceKey, 'opt-2');
  assert.deepEqual(r.parsed.agreeWith, []);
});

test('PASS alone is valid', () => {
  const r = validateReply('PASS', { options: OPTS, round: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.parsed.stanceKey, 'PASS');
  assert.equal(parseReply('**PASS**').pass, true);
});

test('other: label is accepted, unknown stance is not', () => {
  assert.equal(matchStance('other: split the release', OPTS), 'other: split the release');
  assert.equal(matchStance('ship it tomorrow', OPTS), null);
  const r = validateReply('STANCE: ship it tomorrow\nDISAGREE:\n- a\nNEW: none\nASSUMPTIONS:\n- b', { options: OPTS, round: 0 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /not an option id \(opt-1, opt-2\)/);
});

test('reports every missing section for the re-prompt', () => {
  const r = validateReply('I think we should ship now because it is fine.', { options: OPTS, round: 1 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, [
    'missing STANCE line', 'missing DISAGREE section', 'missing NEW section', 'missing ASSUMPTIONS section',
    'missing AGREE_WITH line (use [] if none)',
  ]);
});

test('options are matched exactly, by id or label: no prefix, no character stripping', () => {
  assert.equal(matchStance('Ship later', ['Ship', 'Ship later']), 'opt-2', 'Ship later does not match Ship');
  assert.equal(matchStance('Ship', ['Ship', 'Ship later']), 'opt-1');
  assert.equal(matchStance('Позже', ['Сейчас', 'Позже']), 'opt-2', 'non-Latin labels stay distinct');
  assert.equal(matchStance('opt-2', OPTS), 'opt-2');
  assert.equal(matchStance('opt-2: Wait a sprint', OPTS), 'opt-2', 'an id with its own label');
  assert.equal(matchStance('opt-2: Ship now', OPTS), null, 'an id with another label names nothing');
  assert.equal(matchStance('"Wait a sprint".', OPTS), 'opt-2', 'quotes and a full stop are tolerated');
  assert.equal(matchStance('opt-3', OPTS), null);
  // an option labelled PASS is opt-N, never the PASS sentinel
  const r = validateReply('STANCE: PASS\nAGREE_WITH: []\nDISAGREE:\n- a\nNEW: none\nASSUMPTIONS:\n- b', { options: ['PASS', 'Hold'], round: 1 });
  assert.equal(r.parsed.stanceKey, 'opt-1');
  assert.equal(optionId('hold', ['PASS', 'Hold']), 'opt-2');
});

test('the verdict grammar: every section, and an id or none alone on the first recommendation line', () => {
  const ok = 'RECOMMENDATION: opt-2\nWaiting costs little.\nTALLY:\n- opt-2: risk\nDISSENT: cost wanted to ship\nKILL_CRITERIA:\n- x\nOPEN_QUESTIONS:\n- y';
  assert.deepEqual(validateVerdict(ok, OPTS), { ok: true, errors: [], pick: 'opt-2' });
  assert.equal(validateVerdict(ok.replace('opt-2\n', 'none\n'), OPTS).pick, 'none');
  const paragraph = validateVerdict(ok.replace('opt-2\nWaiting costs little.', 'Wait a sprint, on balance, since waiting costs little.'), OPTS);
  assert.equal(paragraph.ok, false, 'a recommendation paragraph without an id on its first line');
  assert.match(paragraph.errors[0], /first line of RECOMMENDATION/);
  const missing = validateVerdict('RECOMMENDATION: opt-1\nDISSENT:\nKILL_CRITERIA:\n- x', OPTS);
  assert.deepEqual(missing.errors, ['DISSENT is empty', 'missing OPEN_QUESTIONS section']);
  // TALLY is no longer asked for (the record counts it in code): a verdict without one is valid
  assert.equal(validateVerdict('RECOMMENDATION: opt-1\nWhy.\nDISSENT: x\nKILL_CRITERIA:\n- y\nOPEN_QUESTIONS:\n- z', OPTS).ok, true);
});

