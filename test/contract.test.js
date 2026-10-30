import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseReply, validateReply, matchStance, optionId, validateVerdict } from '../src/contract.js';

const OPTS = ['Ship now', 'Wait a sprint'];

test('whole-line emphasis preserves reply and verdict values, including literal closing punctuation', () => {
  for (const marker of ['*', '**', '_', '__']) {
    for (const value of ['opt-1', 'Ship*', 'Wait_']) {
      const options = ['Ship*', 'Wait_', 'Ship', 'Wait'];
      const pick = value === 'Wait_' ? 'opt-2' : 'opt-1';
      const reply = validateReply(`${marker}STANCE: ${value}${marker}\nDISAGREE: none\nNEW: none\nASSUMPTIONS: none`, { options, round: 0 });
      assert.equal(reply.ok, true, `${marker}: ${value}`);
      assert.equal(reply.parsed.stanceKey, pick);
      const verdict = validateVerdict(`${marker}RECOMMENDATION: ${value}${marker}\nDISSENT: none\nKILL_CRITERIA: none\nOPEN_QUESTIONS: none`, options);
      assert.equal(verdict.ok, true, `${marker}: ${value}`);
      assert.equal(verdict.pick, pick);
    }
  }
  assert.equal(parseReply('**STANCE:** Ship**').stance, 'Ship**', 'a closed header leaves the value intact');
  assert.equal(parseReply('STANCE: Ship**').stance, 'Ship**', 'an undecorated header leaves the value intact');
});

test('provider text normalization remains bounded for adversarial whitespace, markup and Unicode', { timeout: 15000 }, () => {
  // A child timeout detects a regex regression without hanging the whole offline suite.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { parseReply, optionId, humanQuestion, matchStance, verdictSections } from './src/contract.js';
    import { filterReply, HIDDEN_MOODS } from './src/seats.js';
    const n = 160000, spaces = ' '.repeat(n);
    const cat = HIDDEN_MOODS.find(h => h.stripParentheticals);
    for (const ws of [' ', '\\u2003']) {
      parseReply('STANCE: opt-1\\n' + ws.repeat(n) + 'x');
      parseReply('STANCE' + ws.repeat(n) + 'x');
    }
    for (const punctuation of ['.', ';', '"', '*']) optionId('x' + punctuation.repeat(n) + 'x', ['Trial', 'Wait']);
    assert.equal(optionId('"'.repeat(n) + 'Trial' + '"'.repeat(n), ['Trial', 'Wait']), 'opt-1');
    for (const separator of ['\\u2028', '\\u2029', '\\r']) {
      verdictSections('RECOMMENDATION' + spaces + 'x' + separator + 'y');
      assert.equal(humanQuestion('none: ' + spaces + 'x' + separator + 'y'), 'none: ' + spaces + 'x' + separator + 'y');
      matchStance('other: ' + spaces + 'x' + separator + 'y', ['Trial', 'Wait']);
    }
    assert.equal(filterReply({hidden:cat.art}, 'a' + spaces + 'x'), 'a' + spaces + 'x');
    assert.equal(filterReply({hidden:cat.art}, '('.repeat(n) + 'x'), '('.repeat(n) + 'x');
    assert.equal(parseReply('  \\\`\\\`\\\`json\\r\\nSTANCE: opt-1\\r\\nNEW: none\\r\\n\\\`\\\`\\\` ').stance, 'opt-1');
  `], { timeout: 6000, encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('exact punctuation-bearing labels win before formatting tolerance, also in verdicts', () => {
  const labels = ['Wait a "sprint"', '"Quoted"', 'Ship*', 'A;', 'Wait (later)'];
  for (const label of labels) {
    assert.equal(optionId(label, [label, 'Other']), 'opt-1');
    assert.equal(optionId('opt-1: ' + label, [label, 'Other']), 'opt-1');
    assert.equal(validateVerdict('RECOMMENDATION: ' + label + '\nDISSENT: None.\nKILL_CRITERIA: None.\nOPEN_QUESTIONS: None.', [label, 'Other']).pick, 'opt-1');
  }
  assert.equal(optionId('"Trial".', ['Trial', 'Other']), 'opt-1');
  assert.equal(optionId('**opt-1**', ['Trial', 'Other']), 'opt-1');
  assert.equal(optionId('opt-1: Other', ['Trial', 'Other']), null);
  const punctuated = ['Ship*', 'Ship', '"Quoted"', 'Quoted'];
  for (const value of ['"Ship*".', "'Ship*';", '**Ship***', '`Ship*`']) {
    assert.equal(optionId(value, punctuated), 'opt-1', 'formatting cannot select the unpunctuated option');
    const reply = validateReply('STANCE: ' + value + '\nDISAGREE: none\nNEW: none\nASSUMPTIONS: none', { options: punctuated, round: 0 });
    assert.equal(reply.parsed.stanceKey, 'opt-1');
    assert.equal(validateVerdict('RECOMMENDATION: ' + value + '\nDISSENT: None.\nKILL_CRITERIA: None.\nOPEN_QUESTIONS: None.', punctuated).pick, 'opt-1');
  }
  assert.equal(optionId('**"Quoted"**', punctuated), 'opt-3');
  for (const header of ['STANCE:', '**STANCE:**', '**STANCE**:']) {
    const parsed = validateReply(header + ' * Ship\nDISAGREE: none\nNEW: none\nASSUMPTIONS: none', { options: ['* Ship', 'Ship'], round: 0 });
    assert.equal(parsed.parsed.stanceKey, 'opt-1', 'header decoration cannot remove label punctuation');
  }
  for (const header of ['RECOMMENDATION:', '**RECOMMENDATION:**', '**RECOMMENDATION**:']) {
    assert.equal(validateVerdict(header + ' * Ship\nDISSENT: None.\nKILL_CRITERIA: None.\nOPEN_QUESTIONS: None.', ['* Ship', 'Ship']).pick, 'opt-1');
  }
  assert.equal(validateVerdict('RECOMMENDATION **opt-1**\nDISSENT None.\nKILL_CRITERIA None.\nOPEN_QUESTIONS None.', OPTS).pick, 'opt-1');
});

test('Unicode line separators inside a placeholder explanation remain conservative questions', async () => {
  const { humanQuestion } = await import('../src/contract.js');
  for (const separator of ['\r', '\u2028', '\u2029']) {
    const text = 'None: treat the' + separator + 'detail as an assumption';
    assert.equal(humanQuestion(text), text);
  }
});

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
  const rant = validateReply(['STANCE: opt-1', 'AGREE_WITH: []', 'DISAGREE:', '- a', '- b', '- c', '- d', 'NEW:', '- one', '- two', '- three', 'ASSUMPTIONS:', '- x'].join('\n'), { options: OPTS, round: 1, trim: false });
  assert.deepEqual([rant.parsed.disagree.length, rant.parsed.new.length, rant.parsed.trimmed], [4, 3, undefined], 'a hidden mood keeps its whole rant');
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



test('answer paragraphs and question priority do not change the verdict grammar or trigger retries', () => {
  for (const pick of ['opt-1', 'none']) {
    const text = `RECOMMENDATION: ${pick}\nStart only if the change is reversible.\n\nA pilot limits the initial cost.\nDISSENT: None.\nKILL_CRITERIA: None.\nOPEN_QUESTIONS:\n- NEEDED: Is rollback tested?\n- OPTIONAL: Who can share the results?`;
    assert.deepEqual(validateVerdict(text, OPTS), { ok: true, errors: [], pick });
    assert.equal(validateVerdict(text.replace(/OPEN_QUESTIONS:[\s\S]*/, 'OPEN_QUESTIONS: None.'), OPTS).ok, true);
    assert.equal(validateVerdict(text.replace(/NEEDED: |OPTIONAL: /g, ''), OPTS).ok, true, 'old or untagged questions are still valid');
  }
});


test('verdict headings accept bold punctuation without treating closing stars as content', () => {
  const plain = 'RECOMMENDATION: opt-2\nWait for the support team.\nDISSENT: Delay costs time.\nKILL_CRITERIA: None.\nOPEN_QUESTIONS: None.';
  const bold = plain.replace(/^(RECOMMENDATION|DISSENT|KILL_CRITERIA|OPEN_QUESTIONS):/gm, '**$1:**');
  assert.deepEqual(validateVerdict(bold, OPTS), { ok: true, errors: [], pick: 'opt-2' });
  const separate = bold.replace('**RECOMMENDATION:** opt-2', '**RECOMMENDATION:**\nopt-2');
  assert.deepEqual(validateVerdict(separate, OPTS), { ok: true, errors: [], pick: 'opt-2' });
  assert.deepEqual(validateVerdict(plain.replace('opt-2', '**opt-2**'), OPTS), { ok: true, errors: [], pick: 'opt-2' });
});
