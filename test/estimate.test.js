import test from 'node:test';
import assert from 'node:assert/strict';
import { baselinesFrom, project, windowDeltas, updateCalibration, projectedWindows, modelWeight, FALLBACK, EFFORT_MULTIPLIER, projectRound, projectChairman, budgetCheck } from '../src/estimate.js';

const row = (vendor, round, input, output, type = 'reply') => ({ type, round, seat: { vendor, id: `s-${vendor}` }, usage: { input, output, cacheRead: 0, cacheWrite: 0 } });

test('baselinesFrom takes medians per vendor, fresh (round 0 and verdict) apart from resumed', () => {
  const b = baselinesFrom([
    row('codex', 0, 10000, 100), row('codex', 0, 30000, 300), row('codex', 0, 20000, 200),
    row('codex', 1, 40000, 50), row('codex', 2, 44000, 70),
    row('claude', 9, 5000, 10, 'verdict'),
    { type: 'human', round: 0, text: 'x' }, { type: 'reply', round: 0, usage: { input: 1 } },
  ]);
  assert.deepEqual(b.codex.fresh, { input: 20000, output: 200, n: 3, cost: null, nCost: 0 });
  assert.deepEqual(b.codex.resumed, { input: 42000, output: 60, n: 2, cost: null, nCost: 0 });
  assert.deepEqual(b.claude.fresh, { input: 5000, output: 10, n: 1, cost: null, nCost: 0 });
  assert.equal(b.claude.resumed.n, 0);
  assert.equal(b.agy, undefined);
});

test('dollar prediction: exact where the CLI reports cost, per model when measured, absent otherwise', () => {
  const rows = [
    { type: 'reply', round: 0, seat: { vendor: 'claude', model: 'sonnet' }, usage: { input: 1, output: 1, cost: 0.03 } },
    { type: 'reply', round: 1, seat: { vendor: 'claude', model: 'sonnet' }, usage: { input: 1, output: 1, cost: 0.02 } },
    { type: 'reply', round: 0, seat: { vendor: 'claude' }, usage: { input: 1, output: 1, cost: 0.09 } },
    { type: 'reply', round: 1, seat: { vendor: 'claude' }, usage: { input: 1, output: 1, cost: 0.05 } },
    { type: 'reply', round: 0, seat: { vendor: 'codex' }, usage: { input: 1, output: 1, cost: null } },
  ];
  const b = baselinesFrom(rows);
  assert.equal(b.claude.fresh.cost, 0.06, 'vendor median across models');
  assert.equal(b['claude:sonnet'].fresh.cost, 0.03);
  assert.equal(b['claude:default'].resumed.cost, 0.05);
  assert.equal(b.codex.fresh.cost, null);
  const p = project({ seats: [{ id: 's', vendor: 'claude', model: 'sonnet' }, { id: 'd', vendor: 'claude' }, { id: 'c', vendor: 'codex' }], critiqueRounds: 2, baselines: b, memory: 'resume' });
  assert.ok(Math.abs(p.bySeat.s.cost - (0.03 + 2 * 0.02)) < 1e-9, 'sonnet seat priced from its own medians');
  assert.ok(Math.abs(p.bySeat.d.cost - (0.09 + 2 * 0.05)) < 1e-9, 'default seat from its own medians');
  assert.equal(p.bySeat.c.cost, null, 'codex reports no cost');
  assert.equal(p.byVendor.codex.cost, null);
  assert.ok(Math.abs(p.byVendor.claude.cost - (0.07 + 0.19)) < 1e-9);
  const high = project({ seats: [{ id: 'd', vendor: 'claude', effort: 'high' }], critiqueRounds: 0, baselines: b });
  assert.ok(high.bySeat.d.cost > 0.09 && high.bySeat.d.cost < 0.09 * 1.4, 'effort raises cost by less than the output multiplier');
});

test('project: more seats, more rounds and more effort grow the vendor pool; fallback when unmeasured', () => {
  const seats = [{ id: 'a', vendor: 'codex' }, { id: 'b', vendor: 'codex', effort: 'high' }, { id: 'c', vendor: 'claude', effort: 'low' }];
  const p = project({ seats, chairman: { vendor: 'claude' }, critiqueRounds: 2, baselines: {}, memory: 'resume' });
  const f = FALLBACK.codex;
  assert.equal(p.bySeat.a.calls, 3);
  assert.equal(p.bySeat.a.input, f.fresh.input + 2 * f.resumed.input);
  assert.equal(p.bySeat.a.output, f.fresh.output + 2 * f.resumed.output);
  assert.equal(p.bySeat.b.input, p.bySeat.a.input, 'effort does not change input');
  assert.equal(p.bySeat.b.output, Math.round((f.fresh.output + 2 * f.resumed.output) * EFFORT_MULTIPLIER.high));
  assert.ok(p.bySeat.c.output < FALLBACK.claude.fresh.output + 2 * FALLBACK.claude.resumed.output, 'low effort shrinks output');
  assert.deepEqual(p.byVendor.codex.seats, ['a', 'b']);
  assert.equal(p.byVendor.codex.total, p.bySeat.a.total + p.bySeat.b.total);
  assert.deepEqual(p.byVendor.claude.seats, ['c', 'chairman']);
  assert.equal(p.total, p.byVendor.codex.total + p.byVendor.claude.total);
  // measured baselines replace the fallback
  const m = project({ seats: [{ id: 'a', vendor: 'codex' }], critiqueRounds: 0, baselines: { codex: { fresh: { input: 100, output: 10, n: 2 }, resumed: { input: 0, output: 0, n: 0 } } } });
  assert.equal(m.bySeat.a.total, 110);
  const none = project({ seats: [], critiqueRounds: 3 });
  assert.equal(none.total, 0);
  // stateless (the default): every critique round is priced as a fresh call
  const st = project({ seats: [{ id: 'a', vendor: 'codex' }], critiqueRounds: 2, baselines: {} });
  assert.equal(st.bySeat.a.input, 3 * f.fresh.input);
  assert.equal(st.bySeat.a.output, 3 * f.fresh.output);
});

test('baselines read the fresh flag on reply rows, falling back to round 0 for older rows', () => {
  const b = baselinesFrom([
    { ...row('codex', 1, 1000, 10), fresh: true },
    { ...row('codex', 2, 3000, 30), fresh: true },
    { ...row('codex', 1, 50000, 10), fresh: false },
    row('codex', 1, 70000, 10),
  ]);
  assert.equal(b.codex.fresh.n, 2);
  assert.equal(b.codex.fresh.input, 2000);
  assert.equal(b.codex.resumed.n, 2);
  assert.equal(b.codex.resumed.input, 60000);
});

test('windowDeltas: same window gives the rise; a moved reset or a drop is invalid', () => {
  const prev = { windows: [{ label: '5h', used: 0.10, resetsAt: 100 }, { label: '7d', used: 0.50, resetsAt: 900 }, { label: 'x', used: 0.2, resetsAt: null }] };
  const next = { windows: [{ label: '5h', used: 0.13, resetsAt: 100 }, { label: '7d', used: 0.02, resetsAt: 950 }, { label: 'x', used: 0.21, resetsAt: null }, { label: 'new', used: 0.1 }] };
  const d = windowDeltas(prev, next);
  assert.deepEqual(d.map((x) => [x.label, x.valid]), [['5h', true], ['7d', false], ['x', true], ['new', false]]);
  assert.ok(Math.abs(d[0].delta - 0.03) < 1e-9);
  assert.deepEqual(windowDeltas(null, next), []);
});

test('updateCalibration is long-run: total movement over total tokens; a ceiling until anything moves', () => {
  // three rounds of 20k tokens with no move: a ceiling that tightens; the fourth moves 2 points
  let c = updateCalibration({}, 'codex', [{ label: '7d', delta: 0, valid: true }], 20000);
  assert.equal(c.codex['7d'].samples, 0);
  assert.equal(c.codex['7d'].pending, 20000);
  assert.ok(Math.abs(c.codex['7d'].ceilPerToken - 0.01 / 20000) < 1e-15);
  c = updateCalibration(c, 'codex', [{ label: '7d', delta: 0, valid: true }], 20000);
  c = updateCalibration(c, 'codex', [{ label: '7d', delta: 0, valid: true }], 20000);
  assert.equal(c.codex['7d'].pending, 60000);
  assert.ok(Math.abs(c.codex['7d'].ceilPerToken - 0.01 / 60000) < 1e-15, 'the ceiling tightens');
  let pw = projectedWindows(c, 'codex', [{ total: 120000, weight: 1 }]);
  assert.equal(pw[0].upperBound, true);
  assert.ok(Math.abs(pw[0].pct - 0.02) < 1e-9, 'less than 1 pt per 60k -> less than 2 pt per 120k');
  assert.equal(pw[0].pending, 60000);
  c = updateCalibration(c, 'codex', [{ label: '7d', delta: 0.02, valid: true }], 20000);
  assert.equal(c.codex['7d'].samples, 1);
  assert.equal(c.codex['7d'].pending, 0);
  assert.equal(c.codex['7d'].ceilPerToken, null);
  assert.ok(Math.abs(c.codex['7d'].pctPerToken - 0.02 / 80000) < 1e-15, 'two points over every token so far');
  assert.equal(c.codex['7d'].rounds, 4);
  pw = projectedWindows(c, 'codex', [{ total: 80000, weight: 1 }]);
  assert.equal(pw[0].upperBound, false);
  assert.ok(Math.abs(pw[0].pct - 0.02) < 1e-9);
  // later quiet rounds dilute the rate (long-run); an invalid round (window rolled over) adds nothing
  c = updateCalibration(c, 'codex', [{ label: '7d', delta: 0, valid: true }], 20000);
  assert.ok(Math.abs(c.codex['7d'].pctPerToken - 0.02 / 100000) < 1e-15);
  c = updateCalibration(c, 'codex', [{ label: '7d', delta: -0.5, valid: false }], 10000);
  assert.equal(c.codex['7d'].tokens, 100000);
  assert.equal(c.codex['7d'].samples, 1);
  assert.deepEqual(updateCalibration(c, 'claude', [{ label: '5h', delta: 0.1, valid: true }], 0).claude, {}, 'no tokens, no sample');
  assert.equal(projectedWindows(undefined, 'claude', [{ total: 1 }]), null);
  assert.equal(projectedWindows({}, 'claude', [{ total: 1 }]), null);
});

test('model weight: heavier ids draw more pool units; a measured model replaces the weight', () => {
  assert.equal(modelWeight('claude-opus-5-5-high'), 1);
  assert.equal(modelWeight('sonnet'), 0.2);
  assert.equal(modelWeight('gemini-3.8-flash-high'), 0.2);
  assert.equal(modelWeight('gemini-4-argon-medium'), 1);
  assert.equal(modelWeight('gpt-6.1-sol'), 1, 'unknown ids weigh 1, the safe side');
  assert.equal(modelWeight(undefined), 1);
  const p = project({ seats: [{ id: 'a', vendor: 'agy', model: 'gemini-4-argon-high' }, { id: 'b', vendor: 'agy', model: 'gemini-3.8-flash-high' }], critiqueRounds: 1 });
  assert.equal(p.bySeat.a.total, p.bySeat.b.total, 'same tokens');
  assert.equal(p.bySeat.b.weighted, Math.round(p.bySeat.b.total * 0.2), 'a fifth of the pool units');
  assert.equal(p.byVendor.agy.weighted, p.bySeat.a.weighted + p.bySeat.b.weighted);
  // vendor-level calibration scaled by weight, unless the model has its own measurement
  const calib = { agy: { '5h': { pctPerToken: 1e-6, samples: 2 } }, 'agy:gemini-3.8-flash-high': { '5h': { pctPerToken: 1e-7, samples: 1 } } };
  const rows = [{ total: 100000, model: 'gemini-4-argon-high', weight: 1 }, { total: 100000, model: 'gemini-3.8-flash-high', weight: 0.2 }];
  const pw = projectedWindows(calib, 'agy', rows);
  assert.ok(Math.abs(pw[0].pct - (0.1 + 0.01)) < 1e-9, 'argon via vendor figure, flash via its own');
  const pw2 = projectedWindows({ agy: calib.agy }, 'agy', rows);
  assert.ok(Math.abs(pw2[0].pct - (0.1 + 0.02)) < 1e-9, 'without its own figure flash is the vendor figure times 0.2');
  // a model's own ceiling does not beat the vendor's measurement; the vendor's ceiling does not beat the model's measurement
  const mixed = { agy: { '5h': { pctPerToken: 0, samples: 0, moved: 0, pending: 50000, ceilPerToken: 0.01 / 50000 } }, 'agy:gemini-3.8-flash-high': { '5h': { pctPerToken: 1e-7, samples: 1, moved: 0.01 } } };
  const pw3 = projectedWindows(mixed, 'agy', rows);
  assert.equal(pw3[0].upperBound, true, 'argon rides the vendor ceiling');
  assert.ok(Math.abs(pw3[0].pct - (0.02 + 0.01)) < 1e-9);
  // a model with only a ceiling, under a measured vendor: the lower of ceiling and weighted rate
  const vendorMeasured = { claude: { '5h': { pctPerToken: 2e-7, samples: 3, moved: 0.07 } }, 'claude:sonnet': { '5h': { pctPerToken: 0, samples: 0, moved: 0, pending: 150000, ceilPerToken: 0.01 / 150000 } } };
  const sonnet = projectedWindows(vendorMeasured, 'claude', [{ total: 50000, model: 'sonnet', weight: 0.2 }]);
  assert.ok(Math.abs(sonnet[0].pct - 2e-7 * 50000 * 0.2) < 1e-12, 'weighted vendor rate is below the ceiling, so it is used');
  assert.equal(sonnet[0].upperBound, false);
  const heavy = projectedWindows(vendorMeasured, 'claude', [{ total: 50000, model: 'sonnet', weight: 1 }]);
  assert.ok(Math.abs(heavy[0].pct - 0.01 / 150000 * 50000) < 1e-12, 'the ceiling caps a weighted rate above it');
  assert.equal(heavy[0].upperBound, true);
});

test('projectRound prices one round per vendor: fresh at round 0 and stateless, resumed later in resume mode; budgetCheck finds the crossing', () => {
  const seats = [{ id: 'a', vendor: 'codex' }, { id: 'b', vendor: 'codex', effort: 'high' }, { id: 'c', vendor: 'claude' }];
  const f = FALLBACK.codex;
  const r0 = projectRound({ seats, round: 0 });
  assert.equal(r0.codex.tokens, Math.round(f.fresh.input + f.fresh.output) + Math.round(f.fresh.input + f.fresh.output * EFFORT_MULTIPLIER.high));
  assert.equal(r0.codex.seats, 2);
  assert.equal(r0.codex.cost, null);
  const r2 = projectRound({ seats, round: 2 });
  assert.equal(r2.codex.tokens, r0.codex.tokens, 'stateless: every round is a fresh call');
  const r2r = projectRound({ seats, round: 2, memory: 'resume' });
  assert.equal(r2r.codex.tokens, Math.round(f.resumed.input + f.resumed.output) + Math.round(f.resumed.input + f.resumed.output * EFFORT_MULTIPLIER.high));
  const b = { claude: { fresh: { input: 100, output: 10, n: 1, cost: 0.2, nCost: 1 }, resumed: { input: 50, output: 5, n: 1, cost: 0.1, nCost: 1 } } };
  assert.equal(projectRound({ seats: [{ id: 'c', vendor: 'claude' }], round: 0, baselines: b }).claude.cost, 0.2);
  assert.equal(projectRound({ seats: [{ id: 'c', vendor: 'claude' }], round: 1, baselines: b, memory: 'resume' }).claude.cost, 0.1);
  const ch = projectChairman({ chairman: { vendor: 'claude' }, baselines: b });
  assert.equal(ch.claude.tokens, Math.round(100 * 1.6 + 10 * 1.5));
  assert.equal(ch.claude.cost, 0.32);
  assert.deepEqual(projectChairman({ chairman: null }), {});
  assert.equal(budgetCheck({ codex: { tokens: 1000 } }, { codex: { tokens: 500, cost: 0 } }, { codex: { tokens: 400 } }), null);
  assert.deepEqual(budgetCheck({ codex: { tokens: 1000 } }, { codex: { tokens: 500, cost: 0 } }, { codex: { tokens: 600 } }), { vendor: 'codex', kind: 'tokens', spent: 500, projected: 600, cap: 1000 });
  assert.deepEqual(budgetCheck({ claude: { usd: 1 } }, { claude: { tokens: 0, cost: 0.8 } }, { claude: { tokens: 1, cost: 0.3 } }), { vendor: 'claude', kind: 'usd', spent: 0.8, projected: 0.3, cap: 1 });
  // an unknown cost is not zero: a dollar cap that cannot be checked is a crossing of its own kind
  assert.deepEqual(budgetCheck({ claude: { usd: 1 } }, {}, { claude: { tokens: 1, cost: null } }), { vendor: 'claude', kind: 'usd-unknown', spent: 0, projected: null, cap: 1 });
  assert.equal(budgetCheck({ claude: { usd: 1 } }, { claude: { tokens: 5, cost: 0.2, costUnknown: true } }, { claude: { tokens: 1, cost: 0.1 } }).kind, 'usd-unknown', 'an attempt with no reported cost');
  assert.equal(budgetCheck({ claude: { tokens: 100 } }, {}, { claude: { tokens: 1, cost: null } }), null, 'a token cap is unaffected');
  assert.equal(budgetCheck({}, { codex: { tokens: 1e9 } }, {}), null);
});

test('baselines never learn from scripted seats: fake- session ids are skipped row by row, and whole fake transcripts are left out', async () => {
  const seat = { vendor: 'claude', id: 'seat-0' };
  const real = { type: 'reply', round: 0, seat, sessionId: 'S1', usage: { input: 100, output: 10 } };
  const fake = { type: 'reply', round: 0, seat, sessionId: 'fake-seat-0-1', usage: { input: 90000, output: 9000 } };
  assert.equal(baselinesFrom([real, fake]).claude.fresh.input, 100);
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { readAllTranscripts } = await import('../src/store.js');
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-synth-'));
  const write = (name, rows) => { mkdirSync(path.join(root, name)); writeFileSync(path.join(root, name, 'transcript.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
  write('a-real', [{ type: 'field-notes', schemaVersion: 2 }, real]);
  write('b-marked', [{ type: 'field-notes', schemaVersion: 2, fake: true }, { ...real, sessionId: 'S2', usage: { input: 70000, output: 1 } }]);
  write('c-legacy-fake', [{ type: 'field-notes', schemaVersion: 2 }, fake]);
  assert.equal(readAllTranscripts(root).length, 6);
  const kept = readAllTranscripts(root, { excludeSynthetic: true });
  assert.equal(kept.length, 2);
  assert.equal(baselinesFrom(kept).claude.fresh.input, 100);
});

test('two profiles of one vendor calibrate and project separately', () => {
  let calib = {};
  calib = updateCalibration(calib, 'codex', [{ label: '5h', delta: 0.01, valid: true }], 100_000);
  calib = updateCalibration(calib, 'codex@work', [{ label: '5h', delta: 0.04, valid: true }], 100_000);
  const row = [{ total: 100_000, weight: 1 }];
  const home = projectedWindows(calib, 'codex', row), work = projectedWindows(calib, 'codex@work', row);
  assert.ok(home && work);
  assert.ok(Math.abs(home[0].pct - 0.01) < 1e-9, 'the default login keeps its own rate');
  assert.ok(Math.abs(work[0].pct - 0.04) < 1e-9, 'the work profile keeps its own rate');
});

test('calibration measured before cached input was counted once is dropped for subset vendors only, once', async () => {
  const { migrateCalibration } = await import('../src/estimate.js');
  const old = { codex: { '5h': { samples: 3 } }, 'codex:gpt-5': { '5h': { samples: 1 } }, 'codex@work': { '7d': {} }, claude: { '5h': { samples: 4 } } };
  const m = migrateCalibration(old, { subsetVendors: ['codex'] });
  assert.deepEqual(m.dropped.sort(), ['codex', 'codex:gpt-5', 'codex@work']);
  assert.deepEqual(Object.keys(m.calibration), ['claude']);
  const again = migrateCalibration({ _version: 3, codex: { '5h': {} } }, { subsetVendors: ['codex'] });
  assert.deepEqual(again.dropped, [], 'a version 3 file is kept as it is');
  assert.ok(again.calibration.codex);
});
