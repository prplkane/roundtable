import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decisionRecord, updateIndex, validateTarget, recordPath, exportDebate, chosenOption, parseVerdict, ownsRecord } from '../src/export.js';

const FN = { decision: 'Ship the new checkout?', options: ['Ship now', 'Wait a sprint'], constraints: 'two devs', known: 'traffic is flat', reversibility: 'high', deadline: 'Friday' };
const SEATS = [
  { id: 'seat-0', vendor: 'claude', label: 'Claude', lens: 'risk', colour: 'rust', index: 0, mood: { preset: 'grill' }, model: 'sonnet' },
  { id: 'seat-1', vendor: 'codex', label: 'Codex', lens: 'cost', colour: 'olive', index: 1, mood: { preset: 'builder' }, effort: 'high' },
  { id: 'seat-2', vendor: 'agy', label: 'Antigravity', lens: 'customer', colour: 'teal', index: 2, mood: { preset: 'custom', text: 'Argue like a CFO.' } },
];
const text = (stance) => `STANCE: ${stance}\nAGREE_WITH: []\nDISAGREE:\n- x\nNEW:\n- none\nASSUMPTIONS:\n- y`;
const reply = (seat, round, stance, usage = {}) => ({
  t: '2026-10-20T18:00:00.000Z', type: 'reply', round, seat, text: text(stance), parsed: { pass: false, stance, agreeWith: [], disagree: ['x'], new: ['none'], assumptions: ['y'], question: null },
  valid: true, errors: [], stanceKey: stance, question: null, usage: { input: 100, cacheRead: 50, cacheWrite: 0, output: 20, thinking: 0, cost: seat.vendor === 'claude' ? 0.05 : null, ms: 1, ...usage },
  reprompted: false, failed: false, fresh: true, sessionId: `s-${seat.id}`,
});
const VERDICT = 'RECOMMENDATION: Ship now, on balance.\nTALLY:\n- Ship now: risk, cost\n- Wait a sprint: customer\nDISSENT: customer argued the launch week is bad.\nKILL_CRITERIA:\n- Error rate above 2%\nOPEN_QUESTIONS:\n- Is the deadline movable?';
const rows = (verdictText = VERDICT, stop = 'round-cap') => [
  { t: '2026-10-20T18:00:00.000Z', type: 'field-notes', schemaVersion: 2, fieldNotes: FN, seats: SEATS, chairman: { vendor: 'codex' }, options: { critiqueRounds: 1 } },
  reply(SEATS[0], 0, 'Ship now'), reply(SEATS[1], 0, 'Wait a sprint'), reply(SEATS[2], 0, 'Wait a sprint'),
  { type: 'human', round: 0, text: 'Mind the deadline' },
  reply(SEATS[0], 1, 'Ship now'), reply(SEATS[1], 1, 'Ship now'), { ...reply(SEATS[2], 1, 'PASS'), stanceKey: 'PASS', parsed: { pass: true } },
  { type: 'stop', reason: stop, rounds: 2 },
  ...(verdictText == null ? [] : [{ type: 'verdict', seat: { id: 'chairman', vendor: 'codex', lens: 'chairman' }, text: verdictText, usage: { input: 300, cacheRead: 0, cacheWrite: 0, output: 40, cost: null } }]),
];

test('decisionRecord: front matter, every section, tally per round with PASS holding the stance, usage per seat', () => {
  const { markdown: md, meta } = decisionRecord(rows(), '2026-10-20-ship-the-new-checkout');
  // the roundtable recommends; only the human decides
  assert.deepEqual(meta, { title: 'Ship the new checkout?', date: '2026-10-20', slug: '2026-10-20-ship-the-new-checkout', status: 'recommended', chosen: 'Ship now', recommended: 'Ship now', accepted: null, stopReason: 'round-cap', file: '2026-10-20-ship-the-new-checkout.md' });
  assert.ok(md.startsWith('---\ntitle: Ship the new checkout?\ndate: 2026-10-20\nslug: 2026-10-20-ship-the-new-checkout\nstatus: recommended\nstop_reason: round-cap\noptions:\n  - Ship now\n  - Wait a sprint\nchosen: Ship now\nrecommended: Ship now\nseats:\n'));
  assert.match(md, /Recommended by a roundtable of 3 seats on 2026-10-20: \*\*Ship now\*\*[^\n]*Not yet accepted by a human\./);
  // each seat line says where it ran, "CLI" or "API <url>"
  assert.match(md, /  - Claude, CLI, risk, grill, sonnet, default effort\n  - Codex, CLI, cost, builder, default model, high\n  - "Antigravity, CLI, customer, custom: Argue like a CFO\., default model, default effort"\n/);
  for (const h of ['Question', 'Field notes', 'Tally', 'Recommendation', 'Dissent', 'Kill criteria', 'Open questions', 'Human notes', 'Usage']) assert.ok(md.includes(`\n## ${h}\n`), h);
  assert.match(md, /- \*\*Constraints:\*\* two devs\n- \*\*Evidence, known:\*\* traffic is flat\n- \*\*Reversibility:\*\* high\n- \*\*Deadline:\*\* Friday/);
  assert.match(md, /\| seat \| round 0 \| round 1 \| final \|\n\|---\|---\|---\|---\|\n\| Claude · risk \| Ship now \| Ship now \| Ship now \|\n\| Codex · cost \| Wait a sprint \| Ship now \| Ship now \|\n\| Antigravity · customer \| Wait a sprint \| PASS \| Wait a sprint \|/);
  assert.match(md, /## Recommendation\n\nShip now, on balance\./);
  assert.match(md, /## Dissent\n\ncustomer argued/);
  assert.match(md, /## Kill criteria\n\n- Error rate above 2%/);
  assert.match(md, /## Human notes\n\n### After round 0\n\nMind the deadline/);
  assert.match(md, /\| Claude · risk \| 200 \| 100 \| 40 \| \$0\.10 \|/);
  assert.match(md, /\| chairman \(codex\) \| 300 \| 0 \| 40 \| not reported \|/);
  // legacy codex rows (no usageVersion) are read as input - cacheRead: 2 x (100 - 50)
  assert.match(md, /\| Codex · cost \| 100 \| 100 \| 40 \| not reported \|/);
  // only the claude calls report a cost, so the total says it is partial
  assert.match(md, /\| \*\*debate\*\* \| 800 \| 300 \| 160 \| \$0\.10 \(partial: 2 of 7 calls report a cost\) \|/);
  assert.doesNotMatch(md, /<[a-z]+>/, 'plain markdown, no HTML');
});

test('exports label unknown and partial token counts, preserving measured zeros and reported costs', () => {
  const head = rows()[0];
  const missing = { type: 'attempt', attemptId: 'u', round: 0, kind: 'reply', seat: SEATS[0], usage: null, unknown: true, cost: 0.05, ms: 12 };
  const allUnknown = decisionRecord([head, missing], 'unknown').markdown;
  assert.match(allUnknown, /\| Claude · risk \| unknown \| unknown \| unknown \| \$0\.05 \|/);
  assert.match(allUnknown, /\| \*\*debate\*\* \| unknown \| unknown \| unknown \| \$0\.05 \|/);
  assert.match(allUnknown, /1 call\(s\) did not report usable token counts/);
  const zero = { ...missing, attemptId: 'zero', seat: SEATS[1], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
  const mixed = decisionRecord([head, missing, zero], 'partial').markdown;
  assert.match(mixed, /\| Codex · cost \| 0 \| 0 \| 0 \| \$0\.00 \|/);
  assert.match(mixed, /\| \*\*debate\*\* \| 0 \(partial\) \| 0 \(partial\) \| 0 \(partial\) \| \$0\.05 \|/);
});

test('status: decided, split (no option chosen), stopped (human, budget, no verdict)', () => {
  assert.equal(decisionRecord(rows('RECOMMENDATION: the evidence does not support a pick yet.\nTALLY: x\nDISSENT: y\nKILL_CRITERIA:\n- z\nOPEN_QUESTIONS:\n- q'), 's').meta.status, 'split');
  assert.equal(decisionRecord(rows('RECOMMENDATION: the evidence does not support a pick yet.'), 's').meta.chosen, 'no consensus');
  assert.equal(decisionRecord(rows(VERDICT, 'human'), 's').meta.status, 'stopped');
  const r = decisionRecord(rows(null), 's');
  assert.equal(r.meta.status, 'stopped');
  assert.match(r.markdown, /## Recommendation\n\n_not given_/);
  const skipped = decisionRecord([...rows(null, 'budget'), { type: 'verdict', seat: null, text: 'Verdict not written: the chairman call would cross the budget.', usage: null, skipped: true }], 's');
  assert.equal(skipped.meta.status, 'stopped');
  assert.match(skipped.markdown, /Verdict not written/);
  // chosen: one option named in the recommendation wins; two named falls back to the seats; unanimous seats decide
  assert.equal(chosenOption(['Ship now', 'Wait a sprint'], 'Ship now rather than wait a sprint.', ['Ship now', 'Ship now']), 'Ship now', 'both named: the seats decide');
  assert.equal(chosenOption(['Ship now', 'Wait a sprint'], 'Ship now rather than wait a sprint.', ['Ship now', 'Wait a sprint']), 'no consensus');
  assert.equal(chosenOption(['A', 'B'], '', ['other: C', 'other: C']), 'no consensus');
  assert.equal(parseVerdict('**RECOMMENDATION**: pick A\nTALLY: t').RECOMMENDATION, 'pick A');
  assert.throws(() => decisionRecord([{ type: 'human', round: 0, text: 'x' }], 's'), /No field-notes row/);
});

test('updateIndex creates the index and replaces a slug\'s row in place, newest first, inside its marked region', () => {
  const a = updateIndex(null, { date: '2026-10-19', title: 'Old | one', chosen: 'A', status: 'decided', file: 'old.md' });
  assert.match(a, /^# Decision records\n/);
  assert.match(a, /<!-- roundtable:index -->\n\| date \| title/);
  assert.match(a, /\| 2026-10-19 \| Old \\\| one \| A \| decided \| \[old\.md\]\(\.\/old\.md\) \|\n<!-- roundtable:index:end -->\n$/);
  const b = updateIndex(a, { date: '2026-10-20', title: 'New', chosen: 'B', status: 'split', file: 'new.md' });
  const rowsB = b.split('\n').filter((l) => /^\| 2026/.test(l));
  assert.deepEqual(rowsB.map((l) => l.slice(2, 12)), ['2026-10-20', '2026-10-19']);
  const c = updateIndex(b, { date: '2026-10-19', title: 'Old, re-exported', chosen: 'A2', status: 'decided', file: 'old.md' });
  const rowsC = c.split('\n').filter((l) => /^\| 2026/.test(l));
  assert.equal(rowsC.length, 2, 'the re-export replaced its row');
  assert.ok(rowsC[1].includes('Old, re-exported') && rowsC[1].includes('A2'));
  // a hand-written file with a date table is not ours: refused, not taken over
  const handWritten = '# Our decisions\n\nHand-written intro.\n\n| date | title | chosen | status | record |\n|---|---|---|---|---|\n| 2026-01-01 | x | y | decided | [x.md](./x.md) |\n\nFooter we wrote.\n';
  assert.equal(updateIndex(handWritten, { date: '2026-02-02', title: 'z', chosen: 'w', status: 'decided', file: 'z.md' }), null);
});

test('updateIndex keeps every byte outside its region, and converts a legacy index keeping its footer', () => {
  const meta = { date: '2026-10-20', title: 'T', chosen: 'A', status: 'decided', file: 't.md' };
  const ours = updateIndex(null, meta);
  const wrapped = `Intro we added.\n\n${ours}\n## Notes below\n\nKeep me.\n`;
  const next = updateIndex(wrapped, { ...meta, date: '2026-10-21', file: 'u.md' });
  assert.ok(next.startsWith('Intro we added.\n\n# Decision records\n'));
  assert.ok(next.endsWith('<!-- roundtable:index:end -->\n\n## Notes below\n\nKeep me.\n'));
  assert.equal(next.split('\n').filter((l) => /^\| 2026/.test(l)).length, 2);
  // a CRLF file stays CRLF
  assert.ok(updateIndex(wrapped.replace(/\n/g, '\r\n'), meta).includes('Keep me.\r\n'));
  // legacy: the 0.2.0 index, with a footer the user added under the table
  const legacy = '# Decision records\n\nOne file per roundtable debate, newest first. Written by `npm run export`; re-exporting a debate replaces its row.\n\n| date | title | chosen | status | record |\n|---|---|---|---|---|\n| 2026-10-19 | Old | A | decided | [old.md](./old.md) |\n\nFooter the user wrote.\n';
  const converted = updateIndex(legacy, meta);
  assert.match(converted, /<!-- roundtable:index -->\n\| date[^]*\| 2026-10-20 [^]*\| 2026-10-19 [^]*<!-- roundtable:index:end -->\n\nFooter the user wrote\.\n$/);
});

test('validateTarget and recordPath: an existing directory only, and never a path outside it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rt-export-'));
  assert.equal(validateTarget(dir), path.resolve(dir));
  assert.throws(() => validateTarget(path.join(dir, 'missing')), /not an existing directory/);
  writeFileSync(path.join(dir, 'file.txt'), 'x');
  assert.throws(() => validateTarget(path.join(dir, 'file.txt')), /not an existing directory/);
  assert.throws(() => validateTarget(''), /needs a target/);
  assert.throws(() => validateTarget(null), /needs a target/);
  assert.equal(recordPath(dir, '2026-10-20-x'), path.join(path.resolve(dir), '2026-10-20-x.md'));
  assert.throws(() => recordPath(dir, '../escape'), /Bad slug/);
  assert.throws(() => recordPath(dir, 'a/b'), /Bad slug/);
  assert.throws(() => recordPath(dir, 'Upper'), /Bad slug/);
});

test('exportDebate refuses what it did not write: a record collision, a foreign README and DECISIONS.md, the home directory', () => {
  const slug = '2026-10-20-ship-the-new-checkout';
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rt-export-'));
  writeFileSync(path.join(dir, `${slug}.md`), '# My own notes\n');
  assert.throws(() => exportDebate(rows(), slug, dir), /not written by roundtable/);
  assert.equal(readFileSync(path.join(dir, `${slug}.md`), 'utf8'), '# My own notes\n', 'untouched');
  // a foreign README: the index goes to DECISIONS.md and the README is kept
  const dir2 = mkdtempSync(path.join(os.tmpdir(), 'rt-export-'));
  writeFileSync(path.join(dir2, 'README.md'), '# Project\n');
  const out = exportDebate(rows(), slug, dir2);
  assert.equal(path.basename(out.indexPath), 'DECISIONS.md');
  assert.equal(readFileSync(path.join(dir2, 'README.md'), 'utf8'), '# Project\n');
  assert.ok(ownsRecord(readFileSync(out.path, 'utf8'), slug));
  // both foreign: refused before anything is written
  const dir3 = mkdtempSync(path.join(os.tmpdir(), 'rt-export-'));
  writeFileSync(path.join(dir3, 'README.md'), '# Project\n');
  writeFileSync(path.join(dir3, 'DECISIONS.md'), '# Ours by hand\n');
  assert.throws(() => exportDebate(rows(), slug, dir3), /neither is a roundtable index/);
  assert.ok(!existsSync(path.join(dir3, `${slug}.md`)), 'no record written');
  assert.throws(() => validateTarget(os.homedir()), /home directory/);
  assert.throws(() => validateTarget(path.parse(process.cwd()).root), /filesystem root/);
  assert.throws(() => validateTarget(dir, { forbid: [dir] }), /keeps its own transcripts/);
  // a legacy record (0.2.0: no roundtable: key) is still recognised as ours
  const legacyRecord = decisionRecord(rows(), slug).markdown.replace(`roundtable: ${slug}\n`, '').replace('Recommended by a roundtable', 'Decided by a roundtable');
  assert.ok(ownsRecord(legacyRecord, slug));
  assert.ok(!ownsRecord(legacyRecord, 'another-slug'));
});

test('exportDebate writes the record and the index, and re-exporting overwrites both', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rt-export-'));
  const out = exportDebate(rows(), '2026-10-20-ship-the-new-checkout', dir);
  assert.equal(out.path, path.join(path.resolve(dir), '2026-10-20-ship-the-new-checkout.md'));
  assert.ok(existsSync(out.path) && existsSync(out.indexPath));
  assert.match(readFileSync(out.indexPath, 'utf8'), /\[2026-10-20-ship-the-new-checkout\.md\]/);
  const again = exportDebate(rows(VERDICT, 'human'), '2026-10-20-ship-the-new-checkout', dir);
  assert.equal(again.meta.status, 'stopped');
  assert.match(readFileSync(out.path, 'utf8'), /status: stopped/);
  const idx = readFileSync(out.indexPath, 'utf8');
  assert.equal(idx.split('\n').filter((l) => /^\| 2026/.test(l)).length, 1);
  assert.match(idx, /\| stopped \|/);
  // a second debate gets its own row
  mkdirSync(path.join(dir, 'sub'));
  exportDebate(rows(), '2026-10-21-other', dir);
  assert.equal(readFileSync(out.indexPath, 'utf8').split('\n').filter((l) => /^\| 2026/.test(l)).length, 2);
});

test('chosen option: an id or none on the first line; an abstention is never filled in; substrings never count; a failed seat blocks the fallback', () => {
  const O = ['Postgres', 'Redis'];
  // 0.2.0 verdicts (no grammar): a substring is not a pick, a leading exact label is
  assert.equal(chosenOption(O, 'Do not use Postgres. More evidence is needed.', []), 'no consensus');
  assert.equal(chosenOption(O, 'Redis, because the queue is ephemeral.', []), 'Redis');
  assert.equal(chosenOption(['Ship', 'Ship later'], 'Ship later, after the audit.', []), 'Ship later', 'the longer label wins');
  // the unanimity fallback needs every seat: a failed seat (null) blocks it
  assert.equal(chosenOption(O, 'the evidence is thin', ['Redis', 'Redis', null]), 'no consensus');
  assert.equal(chosenOption(O, 'the evidence is thin', ['opt-2', 'Redis', 'opt-2']), 'Redis', 'ids and legacy labels both count');
  // 0.3.0 verdicts: the grammar line decides, and none is an abstention even when every seat agrees
  assert.equal(chosenOption(O, 'opt-1\nPostgres keeps one system to run.', ['opt-2', 'opt-2'], { legacy: false }), 'Postgres');
  assert.equal(chosenOption(O, 'none\nNeither case is made yet.', ['opt-2', 'opt-2'], { legacy: false }), 'no pick');
  assert.equal(chosenOption(O, 'Redis, on balance.', ['opt-2', 'opt-2'], { legacy: false }), 'no consensus', 'no grammar line, no fallback');
});

test('a 0.3.0 record: ids shown as labels, the tally counted in code, the chairman tally kept apart, an abstention recorded as no pick', () => {
  const head3 = { ...rows()[0], schemaVersion: 3 };
  const idReply = (seat, round, id) => ({ ...reply(seat, round, id), stanceKey: id });
  const base = [head3, idReply(SEATS[0], 0, 'opt-1'), idReply(SEATS[1], 0, 'opt-2'), idReply(SEATS[2], 0, 'opt-2'), { type: 'stop', reason: 'round-cap', rounds: 1 }];
  const verdict = (rec) => ({ type: 'verdict', seat: { id: 'chairman', vendor: 'codex', lens: 'chairman' }, text: `RECOMMENDATION: ${rec}\nTALLY:\n- opt-2: cost, customer\nDISSENT: risk wanted to ship\nKILL_CRITERIA:\n- x\nOPEN_QUESTIONS:\n- y` });
  const r = decisionRecord([...base, verdict('opt-2\nWaiting costs one sprint.')], 's');
  assert.equal(r.meta.chosen, 'Wait a sprint');
  assert.equal(r.meta.status, 'recommended');
  assert.match(r.markdown, /\| Claude · risk \| Ship now \| Ship now \|/, 'ids are shown as labels');
  assert.match(r.markdown, /Final: Wait a sprint 2, Ship now 1\./, 'the tally is counted in code');
  assert.match(r.markdown, /## Chairman's tally\n\n- opt-2: cost, customer/);
  assert.match(r.markdown, /## Recommendation\n\n\*\*Wait a sprint\*\* \(opt-2\)\nWaiting costs one sprint\./);
  const abstain = decisionRecord([...base, verdict('none\nThe evidence does not support a pick.')], 's');
  assert.equal(abstain.meta.chosen, 'no pick');
  assert.equal(abstain.meta.status, 'split');
});

test('a failed verdict never chooses: status and chosen are "no verdict"', () => {
  const r = decisionRecord([...rows(null), { type: 'verdict', seat: { id: 'chairman', vendor: 'codex', lens: 'chairman' }, text: 'RECOMMENDATION: Ship now', failed: true, errors: ['missing TALLY section'] }], 's');
  assert.equal(r.meta.status, 'no verdict');
  assert.equal(r.meta.chosen, 'no verdict');
});

test('a record says recommended until the human accepts; an accepted option may differ from the recommendation and both are written', () => {
  const base = rows();
  const r = decisionRecord(base, 's');
  assert.equal(r.meta.status, 'recommended');
  assert.doesNotMatch(r.markdown, /status: decided/, 'decided is retired');
  const acc = decisionRecord([...base, { type: 'accepted', option: 'opt-2', note: 'Launch week is too busy.', t: '2026-10-21T09:00:00.000Z' }], 's');
  assert.equal(acc.meta.status, 'accepted');
  assert.equal(acc.meta.chosen, 'Wait a sprint');
  assert.equal(acc.meta.recommended, 'Ship now');
  assert.match(acc.markdown, /\nrecommended: Ship now\naccepted: Wait a sprint\naccepted_on: 2026-10-21\n/);
  assert.match(acc.markdown, /Accepted by the human on 2026-10-21: \*\*Wait a sprint\*\*\. Recommended by a roundtable of 3 seats on 2026-10-20: \*\*Ship now\*\*/);
  assert.match(acc.markdown, /> Launch week is too busy\./);
  const none = decisionRecord([...base, { type: 'accepted', option: 'none', t: '2026-10-21T09:00:00.000Z' }], 's');
  assert.equal(none.meta.chosen, 'no option');
});

test('a mixed-vendor record labels its dollar total as partial', () => {
  const { markdown } = decisionRecord(rows(), 's');
  assert.match(markdown, /\| \*\*debate\*\* \|[^\n]*\$0\.10 \(partial: 2 of 7 calls report a cost\) \|/);
  assert.match(markdown, /\| Claude · risk \|[^\n]*\| \$0\.10 \|/, 'a seat whose every call reports a cost is not marked');
});
