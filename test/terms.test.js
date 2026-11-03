// A vendor's terms notice (config.js terms, src/terms.js): who needs it, when a request is
// refused, and how the board's acknowledgment is kept. No CLI is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADAPTERS } from '../src/adapters/config.js';
import { termsVendors, termsRefusal, createTermsRecord } from '../src/terms.js';

test('only Antigravity carries a terms notice, naming the FAQ and the date it was checked', () => {
  assert.deepEqual(Object.keys(ADAPTERS).filter((v) => ADAPTERS[v].terms), ['agy']);
  const t = ADAPTERS.agy.terms;
  assert.equal(t.url, 'https://antigravity.google/docs/faq');
  assert.match(t.read, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(t.notice, /not supported under consumer plans/);
  assert.match(t.notice, /suspension or termination of your account/);
});

test('a request with an Antigravity seat, chairman or searcher is refused without acknowledgeTermsRisk', () => {
  const claude = { vendor: 'claude' }, agy = { vendor: 'agy' };
  assert.deepEqual(termsVendors([claude, null, { vendor: 'codex' }], ADAPTERS), []);
  assert.deepEqual(termsVendors([claude, agy, agy, undefined], ADAPTERS), ['agy']);
  assert.equal(termsRefusal([claude, { vendor: 'codex' }], {}, ADAPTERS), null, 'nothing to acknowledge');
  for (const cards of [[agy, claude], [claude, claude, agy], [claude, claude, null, { vendor: 'agy', query: 'q' }]]) {
    for (const options of [{}, { acknowledgeTermsRisk: false }, { acknowledgeTermsRisk: 'yes' }, { allowLimitedIsolation: true }]) {
      const e = termsRefusal(cards, options, ADAPTERS);
      assert.equal(e?.code, 'TERMS_ACK_REQUIRED'); assert.equal(e.status, 400);
      assert.ok(e.message.includes(ADAPTERS.agy.terms.notice), 'the refusal carries the notice itself');
      assert.match(e.message, /options\.acknowledgeTermsRisk: true once the person has agreed/);
    }
    assert.equal(termsRefusal(cards, { acknowledgeTermsRisk: true }, ADAPTERS), null);
  }
});

test('the board acknowledgment is kept per data folder, can be withdrawn, and is asked again for a newer notice', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rt-terms-'));
  const file = path.join(dir, '_terms.json');
  let clock = 1_000;
  const record = createTermsRecord(file, { adapters: ADAPTERS, now: () => clock });
  assert.equal(record.acknowledged('agy'), false);
  assert.equal(record.acknowledged('claude'), true, 'a vendor without a notice is never held');
  assert.equal(record.status('claude'), null);
  assert.deepEqual(record.status('agy'), { ...ADAPTERS.agy.terms, acknowledgedAt: null });
  assert.throws(() => record.set('claude', true), (e) => e.status === 400);
  assert.throws(() => record.set('nobody', true), (e) => e.status === 400);

  assert.equal(record.set('agy', true).acknowledgedAt, 1_000);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { agy: { at: 1_000, read: ADAPTERS.agy.terms.read } });
  assert.equal(createTermsRecord(file, { adapters: ADAPTERS }).acknowledged('agy'), true, 'a restart remembers it');
  const rechecked = { ...ADAPTERS, agy: { ...ADAPTERS.agy, terms: { ...ADAPTERS.agy.terms, read: '2099-01-01' } } };
  assert.equal(createTermsRecord(file, { adapters: rechecked }).acknowledged('agy'), false, 'a notice checked again later asks again');

  clock = 2_000;
  assert.equal(record.set('agy', false).acknowledgedAt, null);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
  assert.equal(createTermsRecord(file, { adapters: ADAPTERS }).acknowledged('agy'), false);

  writeFileSync(file, '{"agy": {"at": "soon", "read": "' + ADAPTERS.agy.terms.read + '"}}');
  assert.equal(createTermsRecord(file, { adapters: ADAPTERS }).acknowledged('agy'), false, 'a malformed entry is not an acknowledgment');
});

test('an unreadable acknowledgment file holds Antigravity and is never overwritten', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rt-terms-bad-'));
  const file = path.join(dir, '_terms.json');
  writeFileSync(file, '{not json');
  const errors = [];
  const record = createTermsRecord(file, { adapters: ADAPTERS, onError: (e) => errors.push(e) });
  assert.equal(errors.length, 1);
  assert.equal(record.acknowledged('agy'), false);
  assert.throws(() => record.set('agy', true), /unreadable at startup/);
  assert.equal(readFileSync(file, 'utf8'), '{not json');
});
