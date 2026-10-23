import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDebateRequest, validateMessage, normLabel } from '../src/validate.js';
import { ADAPTERS } from '../src/adapters/index.js';

const base = () => ({
  fieldNotes: { decision: 'Ship?', options: ['Ship now', 'Wait'] },
  seats: [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost' }],
  chairman: { vendor: 'claude' },
  options: {},
});
const rejects = (mutate, re) => { const b = base(); mutate(b); assert.throws(() => validateDebateRequest(b, { adapters: ADAPTERS }), re); };

test('debate request: bounds on rounds, seats, options and caps', () => {
  assert.ok(validateDebateRequest(base(), { adapters: ADAPTERS }));
  rejects((b) => { b.options.critiqueRounds = -1; }, /critiqueRounds/);
  rejects((b) => { b.options.critiqueRounds = 9; }, /critiqueRounds/);
  rejects((b) => { b.options.critiqueRounds = 1.5; }, /critiqueRounds/);
  rejects((b) => { b.seats = [b.seats[0]]; }, /seats: 2 to 8/);
  rejects((b) => { b.seats = Array.from({ length: 9 }, (_, i) => ({ vendor: 'claude', lens: `l${i}` })); }, /seats: 2 to 8/);
  rejects((b) => { b.fieldNotes.options = Array.from({ length: 13 }, (_, i) => `o${i}`); }, /options: 2 to 12/);
  rejects((b) => { b.fieldNotes.options = ['Ship', ' ship ']; }, /appears twice/);
  rejects((b) => { b.fieldNotes.decision = 'x'.repeat(2001); }, /decision/);
  rejects((b) => { b.options.budget = { codex: { usd: 1 } }; }, /does not report cost/);
  rejects((b) => { b.options.budget = { claude: { tokens: Infinity } }; }, /token cap/);
  rejects((b) => { b.options.memory = 'forever'; }, /memory/);
  rejects((b) => { b.options.wallClockMs = 10; }, /wallClockMs/);
});

test('debate request: unknown keys are dropped, a dollar cap is kept where cost is reported', () => {
  const b = base();
  b.options = { critiqueRounds: 2, budget: { claude: { tokens: 50000, usd: 1.5 } }, evil: true };
  b.fieldNotes.extra = 'x';
  const out = validateDebateRequest(b, { adapters: ADAPTERS });
  assert.deepEqual(out.options, { critiqueRounds: 2, budget: { claude: { tokens: 50000, usd: 1.5 } } });
  assert.equal(out.fieldNotes.extra, undefined);
});

test('messages are bounded text; labels normalise without stripping non-Latin text', () => {
  assert.equal(validateMessage({ message: 'hi' }).message, 'hi');
  assert.throws(() => validateMessage({ message: 'x'.repeat(4001) }), /message/);
  assert.throws(() => validateMessage({ message: 42 }), /message/);
  assert.notEqual(normLabel('Сейчас'), normLabel('Позже'));
  assert.equal(normLabel('  Ship   NOW '), 'ship now');
});

test('API endpoint seats: the endpoint and key variable are bounded text, and resume memory is refused (an endpoint has no thread to continue)', () => {
  const api = { vendor: 'api', lens: 'local', endpoint: 'http://localhost:11434/v1', model: 'llama3' };
  const b = base(); b.seats[1] = api; b.chairman = { ...api };
  const out = validateDebateRequest(b, { adapters: ADAPTERS });
  assert.equal(out.seats[1].endpoint, api.endpoint);
  rejects((x) => { x.seats[1] = { ...api, endpoint: 'h'.repeat(501) }; }, /seat 2 endpoint: at most 500/);
  rejects((x) => { x.seats[1] = { ...api, keyEnv: 7 }; }, /seat 2 keyEnv: must be text/);
  rejects((x) => { x.chairman = { ...api, endpoint: 'h'.repeat(501) }; }, /chairman endpoint/);
  rejects((x) => { x.seats[1] = api; x.options.memory = 'resume'; }, /memory: resume needs a session/);
  rejects((x) => { x.chairman = api; x.options.memory = 'resume'; }, /memory: resume needs a session/);
  const ok = base(); ok.options.memory = 'resume';
  assert.equal(validateDebateRequest(ok, { adapters: ADAPTERS }).options.memory, 'resume', 'CLI seats may resume');
  rejects((x) => { x.options.budget = { api: { usd: 1 } }; }, /does not report cost/);
});
