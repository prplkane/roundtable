// Antigravity quota: `agy -p /usage` as the CLI printed it (fixtures/agy-usage.mjs), the latch
// that stops the read when an answer is not shown free, and which group a seat's model uses.
// No CLI is spawned: the reader gets an injected runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AGY_USAGE } from './fixtures/agy-usage.mjs';
import { agyQuota, agyReadWasFree, agyQuotaReader, agyCredits, AGY_CREDITS_EVERY_MS } from '../src/adapters/quota.js';
import { quotaGroup, quotaWindows } from '../src/adapters/models.js';
import { lamp } from '../src/preflight.js';
import { roundDeltas } from '../src/estimate.js';
import { fakeQuota } from '../src/fake.js';
import { ADAPTERS } from '../src/adapters/config.js';

const usage = () => JSON.parse(AGY_USAGE);
const secs = (...utc) => Date.UTC(...utc) / 1000;
const near = (a, b) => Math.abs(a - b) < 1e-9;
// the ids `agy models` listed on the account the fixture comes from
const IDS = ['gemini-4-argon-low', 'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-3.8-flash-low', 'gemini-3.8-flash-high',
  'claude-opus-5-5-low', 'claude-opus-5-5-high', 'claude-sonnet-5-5-medium', 'gpt-oss-120b-medium'];

test('the captured /usage answer was free: no turn, no tokens, no conversation', () => {
  const obj = usage();
  assert.equal(agyReadWasFree(obj), true);
  assert.equal(agyReadWasFree({ ...obj, num_turns: 1 }), false, 'a turn');
  assert.equal(agyReadWasFree({ ...obj, usage: { ...obj.usage, input_tokens: 12, total_tokens: 12 } }), false, 'tokens');
  assert.equal(agyReadWasFree({ ...obj, conversation_id: 'c-1' }), false, 'a conversation left behind');
  assert.equal(agyReadWasFree({ ...obj, usage: undefined }), false, 'no counters to judge by');
  assert.equal(agyReadWasFree({ ...obj, num_turns: undefined }), false, 'no turn count to judge by');
  assert.equal(agyReadWasFree(null), false);
});

test('agyQuota: one window per bucket, labelled by group and span, used share from remaining_fraction, resets in epoch seconds', () => {
  const q = agyQuota(usage(), 1000);
  assert.deepEqual(q.windows.map((w) => [w.label, w.group]), [
    ['Gemini 7d', 'Gemini Models'], ['Gemini 5h', 'Gemini Models'],
    ['Claude and GPT 7d', 'Claude and GPT models'], ['Claude and GPT 5h', 'Claude and GPT models'],
    ['Gemini 4 Argon 7d', 'Gemini 4 Argon'],
  ]);
  assert.equal(new Set(q.windows.map((w) => w.label)).size, q.windows.length, 'labels are unique in the pool: calibration matches by label');
  assert.ok(near(q.windows[0].used, 1 - 0.9709907174110413));
  assert.equal(q.windows[3].used, 0, 'a full window is 0 used');
  assert.ok(near(q.windows[4].used, 1 - 0.5915986895561218));
  assert.equal(q.windows[0].resetsAt, secs(2026, 10, 3, 5, 42, 18));
  assert.equal(q.windows[4].resetsAt, secs(2026, 10, 6, 14, 16, 27));
  assert.deepEqual(q.groups, [
    { name: 'Gemini Models', models: ['Gemini Flash', 'Gemini Pro'] },
    { name: 'Claude and GPT models', models: ['Claude Opus', 'Claude Sonnet', 'GPT-OSS'] },
    { name: 'Gemini 4 Argon', models: [] },
  ]);
  assert.equal(q.plan, null);
  assert.equal(q.at, 1000);
});

test('agyQuota leaves out a bucket with no figure and a group with no window, and refuses anything but the usage command', () => {
  const obj = usage();
  obj.command.data.groups[1].buckets = obj.command.data.groups[1].buckets.map((b) => ({ ...b, remaining_fraction: undefined, status: 'Disabled' }));
  obj.command.data.groups[0].buckets[1].reset_time = 'soon';
  const q = agyQuota(obj);
  assert.deepEqual(q.windows.map((w) => w.label), ['Gemini 7d', 'Gemini 5h', 'Gemini 4 Argon 7d']);
  assert.deepEqual(q.groups.map((g) => g.name), ['Gemini Models', 'Gemini 4 Argon']);
  assert.equal(q.windows[1].resetsAt, null, 'an unreadable reset time is unknown, not a guess');
  assert.equal(agyQuota({ ...usage(), command: { name: 'model', data: {} } }), null);
  assert.equal(agyQuota({ status: 'ERROR', error: 'not signed in' }), null);
  for (const g of obj.command.data.groups) g.buckets = [];
  assert.equal(agyQuota(obj), null, 'no window at all is no figure');
});

test('quotaGroup: every catalogue id finds its group from the CLI\'s own words', () => {
  const { groups } = agyQuota(usage());
  const got = Object.fromEntries(IDS.map((id) => [id, quotaGroup(groups, id)]));
  for (const id of IDS.filter((x) => x.includes('argon'))) assert.equal(got[id], 'Gemini 4 Argon', id);
  for (const id of IDS.filter((x) => x.includes('flash'))) assert.equal(got[id], 'Gemini Models', id);
  for (const id of IDS.filter((x) => /^(claude|gpt)/.test(x))) assert.equal(got[id], 'Claude and GPT models', id);
  assert.equal(quotaGroup(groups, 'gemini-4-argon'), 'Gemini 4 Argon', 'a family id without its level');
  assert.equal(quotaGroup(groups, 'gemini-3.8-pro-high'), 'Gemini Models', 'a listed model the account does not have yet');
  assert.equal(quotaGroup(groups, ''), null, 'the default model: no group can be told');
  assert.equal(quotaGroup(groups, 'default'), null);
  assert.equal(quotaGroup(groups, 'gemini-9-nova-high'), null, 'two Gemini groups and neither names it');
  assert.equal(quotaGroup(null, 'gemini-3.8-flash-high'), null);
  // a plan without a separate Argon group: Argon counts against the Gemini group
  assert.equal(quotaGroup(groups.filter((g) => g.name !== 'Gemini 4 Argon'), 'gemini-4-argon-high'), 'Gemini Models');
});

test('quotaWindows: the seated models\' groups when every group is known, else every window', () => {
  const q = agyQuota(usage());
  const labels = (models) => quotaWindows(q, models).map((w) => w.label);
  assert.deepEqual(labels(['gemini-3.8-flash-high']), ['Gemini 7d', 'Gemini 5h']);
  assert.deepEqual(labels(['gemini-4-argon-high']), ['Gemini 4 Argon 7d'], 'only what the CLI reports: Argon has no 5-hour window');
  assert.deepEqual(labels(['claude-opus-5-5-high', 'gemini-4-argon-low']), ['Claude and GPT 7d', 'Claude and GPT 5h', 'Gemini 4 Argon 7d']);
  assert.equal(labels(['gemini-3.8-flash-high', '']).length, 5, 'one seat on the default model: every window applies');
  assert.equal(labels([]).length, 5);
  const plain = { windows: [{ label: '5h', used: 0.1, resetsAt: null }], plan: null, at: 0 };
  assert.deepEqual(quotaWindows(plain, ['opus']), plain.windows, 'a quota without groups is unchanged');
  assert.deepEqual(quotaWindows(null, ['x']), []);
});

test('lamp: a used-up Argon week turns only Argon seats red', () => {
  const obj = usage();
  obj.command.data.groups[2].buckets[0].remaining_fraction = 0;
  const quota = agyQuota(obj);
  const NOW = secs(2026, 10, 1, 12, 0, 0) * 1000;
  const at = (model) => lamp({ vendor: 'agy', installed: true, loggedIn: true, quota, model }, NOW);
  assert.equal(at('gemini-3.8-flash-high').state, 'ok');
  assert.match(at('gemini-3.8-flash-high').note, /^ready · Gemini 7d 3% · Gemini 5h 2%$/);
  assert.equal(at('claude-sonnet-5-5-medium').state, 'ok');
  const argon = at('gemini-4-argon-high');
  assert.deepEqual([argon.state, argon.kind], ['danger', 'quota']);
  assert.match(argon.note, /quota used up \(Gemini 4 Argon 7d, resets in 5d 2h\)/);
  assert.equal(at('').state, 'danger', 'the default model may be the Argon one: the pool\'s worst window counts');
  assert.equal(lamp({ vendor: 'agy', installed: true, loggedIn: true, quota }, NOW).state, 'danger', 'no model: the whole pool');
});

test('roundDeltas: a grouped quota is measured per model, on that model\'s group only', () => {
  const before = agyQuota(usage());
  const after = structuredClone(before);
  after.windows[1].used += 0.02; // Gemini 5h moved; the other groups stood still
  const one = roundDeltas(before, after, 'agy', new Set(['gemini-3.8-flash-high']));
  assert.deepEqual(one.keys, ['agy:gemini-3.8-flash-high'], 'no pool-wide key: its rate would be projected onto every group');
  assert.deepEqual(one.deltas.map((d) => d.label), ['Gemini 7d', 'Gemini 5h']);
  assert.ok(one.deltas.every((d) => d.valid));
  assert.deepEqual(roundDeltas(before, after, 'agy', new Set(['gemini-3.8-flash-high', 'claude-opus-5-5-high'])), { deltas: [], keys: [] }, 'two models cannot split one move');
  assert.deepEqual(roundDeltas(before, after, 'agy', new Set(['default'])), { deltas: [], keys: [] }, 'the default model has no known group');
  // a quota without groups keeps the pool key and adds the model's
  const plain = (used) => ({ windows: [{ label: '5h', used, resetsAt: 1 }], plan: null, at: 0 });
  const codex = roundDeltas(plain(0.1), plain(0.2), 'codex', new Set(['gpt-6-luna']));
  assert.deepEqual(codex.keys, ['codex', 'codex:gpt-6-luna']);
  assert.equal(codex.deltas.length, 1);
  assert.deepEqual(roundDeltas(plain(0.1), plain(0.2), 'codex', new Set(['a', 'b'])).keys, ['codex']);
});

test('readAgyQuota runs exactly `agy -p /usage --output-format json` and reads the answer', async () => {
  const calls = [];
  const read = agyQuotaReader({ resolve: () => ({ file: 'agy', prefix: [] }), run: async (bin, args, opts) => { calls.push({ args, opts }); return { stdout: AGY_USAGE, code: 0 }; }, warn: () => {} });
  const saved = process.env.GEMINI_API_KEY, billing = process.env.ROUNDTABLE_API_BILLING;
  process.env.GEMINI_API_KEY = 'test-key';
  delete process.env.ROUNDTABLE_API_BILLING;
  let q;
  try { q = await read(); } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
    if (billing !== undefined) process.env.ROUNDTABLE_API_BILLING = billing;
  }
  assert.equal(q.windows.length, 5);
  assert.deepEqual(calls[0].args, ['-p', '/usage', '--output-format', 'json']);
  assert.ok(!calls[0].args.includes('--disable-slash-commands'), 'the read needs /usage expanded');
  assert.equal(calls[0].opts.env.GEMINI_API_KEY, undefined, 'the seats\' environment: a key in the shell does not move the read to another billing route');
  for (const k of Object.keys(calls[0].opts.env)) assert.doesNotMatch(k, /^(CLAUDECODE|CLAUDE_CODE_)/, 'another agent CLI\'s variables make agy send /usage to a model');
  assert.equal(read.stopped(), null);
});

test('readAgyQuota stops itself on an answer that is not shown free, and on a timeout; a CLI that did not start does not stop it', async () => {
  const resolve = () => ({ file: 'agy', prefix: [] });
  const spent = JSON.stringify({ ...usage(), conversation_id: 'c-9', num_turns: 1, command: undefined, usage: { input_tokens: 40, output_tokens: 30, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 70 } });
  let runs = 0;
  const warned = [];
  const read = agyQuotaReader({ resolve, run: async () => { runs++; return { stdout: spent, code: 0 }; }, warn: (m) => warned.push(m) });
  assert.equal(await read(), null);
  assert.equal(await read(), null);
  assert.equal(runs, 1, 'one stray call at most, never one per reply');
  assert.match(read.stopped(), /did not answer as a free command/);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /until the server restarts/);

  const slow = agyQuotaReader({ resolve, run: async () => { throw Object.assign(new Error('timed out'), { code: 'TIMEOUT', stdout: '' }); }, warn: () => {} });
  assert.equal(await slow({ timeoutMs: 5 }), null);
  assert.match(slow.stopped(), /no answer within 5 ms/);

  const garbled = agyQuotaReader({ resolve, run: async () => ({ stdout: 'Working...\n', code: 0 }), warn: () => {} });
  assert.equal(await garbled(), null);
  assert.match(garbled.stopped(), /no JSON answer/);
  // the same answer printed over several lines, or after a notice, is still the free read
  for (const stdout of [JSON.stringify(usage(), null, 2) + '\n', 'notice: update available\n' + AGY_USAGE]) {
    const pretty = agyQuotaReader({ resolve, run: async () => ({ stdout, code: 0 }), warn: () => {} });
    assert.equal((await pretty()).windows.length, 5);
    assert.equal(pretty.stopped(), null);
  }

  const missing = agyQuotaReader({ resolve: () => { throw new Error('agy not found'); }, run: async () => assert.fail('no spawn without a binary'), warn: () => {} });
  assert.equal(await missing(), null);
  assert.equal(missing.stopped(), null);
  const unstarted = agyQuotaReader({ resolve, run: async () => { throw Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }); }, warn: () => {} });
  assert.equal(await unstarted(), null);
  assert.equal(unstarted.stopped(), null);

  // signed out or offline: the CLI says so itself, for free, and the next read may succeed
  const error = JSON.stringify({ conversation_id: '', status: 'ERROR', response: '', error: 'not signed in', num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } });
  const signedOut = agyQuotaReader({ resolve, run: async () => ({ stdout: `notice: update available\n${error}\n`, code: 1 }), warn: () => {} });
  assert.equal(await signedOut(), null);
  assert.equal(signedOut.stopped(), null);
});

test('the Antigravity row says its quota is a separate read, and the demo quota has the same groups', () => {
  assert.equal(ADAPTERS.agy.quota, 'command');
  assert.equal(ADAPTERS.agy.paths.quota, null, 'nothing rides on a reply');
  const demo = fakeQuota('agy');
  assert.equal(new Set(demo.windows.map((w) => w.label)).size, demo.windows.length);
  for (const id of IDS) assert.ok(quotaGroup(demo.groups, id), id);
  assert.deepEqual(quotaWindows(demo, ['gemini-4-argon-high']).map((w) => w.label), ['Gemini 4 Argon 7d']);
});

// `agy -p /credits --output-format json` as CLI 1.4.12 answered it: free, structured
const CREDITS = (remaining) => JSON.stringify({ conversation_id: '', status: 'SUCCESS', duration_seconds: 0, num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: { name: 'credits', data: { remaining_credits: remaining, upgrade_uri: 'https://antigravity.google/g1-upgrade' } } });

test('agyCredits reads remaining_credits from the /credits answer and nothing else', () => {
  assert.equal(agyCredits(JSON.parse(CREDITS(0))), 0, 'none left is a figure, not a missing one');
  assert.equal(agyCredits(JSON.parse(CREDITS(1200))), 1200);
  assert.equal(agyCredits(JSON.parse(AGY_USAGE)), null, 'the /usage answer holds no credits');
  assert.equal(agyCredits({ ...JSON.parse(CREDITS(5)), status: 'ERROR' }), null);
  for (const bad of [-1, '12', NaN, null]) assert.equal(agyCredits({ ...JSON.parse(CREDITS(0)), command: { name: 'credits', data: { remaining_credits: bad } } }), null, String(bad));
});

test('the reader asks /credits after a good /usage read, at most every ten minutes, under the same latch', async () => {
  const resolve = () => ({ file: 'agy', prefix: [] });
  let clock = 1_000_000, credits = 0;
  const asked = [];
  const answers = { '/usage': () => AGY_USAGE, '/credits': () => CREDITS(credits) };
  const read = agyQuotaReader({ resolve, warn: () => {}, now: () => clock, run: async (bin, args) => { asked.push(args[1]); return { stdout: answers[args[1]](), code: 0 }; } });
  let q = await read();
  assert.deepEqual(asked, ['/usage', '/credits']);
  assert.deepEqual(q.credits, { remaining: 0, at: 1_000_000 });
  assert.equal(q.windows.length, 5, 'the windows are unchanged');
  credits = 300; clock += AGY_CREDITS_EVERY_MS - 1;
  q = await read();
  assert.deepEqual(asked, ['/usage', '/credits', '/usage'], 'within ten minutes: /usage only');
  assert.equal(q.credits.remaining, 0, 'the last figure is kept with its time');
  clock += 1;
  q = await read();
  assert.equal(asked.at(-1), '/credits');
  assert.deepEqual(q.credits, { remaining: 300, at: clock });

  // a /credits answer that is not shown free stops every read, as for /usage
  const spent = agyQuotaReader({ resolve, warn: () => {}, run: async (bin, args) => ({ stdout: args[1] === '/usage' ? AGY_USAGE : JSON.stringify({ ...JSON.parse(CREDITS(0)), num_turns: 1 }), code: 0 }) });
  assert.equal(await spent(), null);
  assert.match(spent.stopped(), /\/credits did not answer as a free command/);
  // a /credits error is no credits figure; the windows still arrive, reads go on, and /credits is
  // not asked again on every read (an account without credits would cost a second start each time)
  const failAsked = [];
  const failed = agyQuotaReader({ resolve, warn: () => {}, run: async (bin, args) => { failAsked.push(args[1]); return { stdout: args[1] === '/usage' ? AGY_USAGE : JSON.stringify({ ...JSON.parse(CREDITS(0)), status: 'ERROR' }), code: 0 }; } });
  const f = await failed();
  assert.equal(f.windows.length, 5);
  assert.equal(f.credits, undefined);
  assert.equal(failed.stopped(), null);
  await failed();
  assert.deepEqual(failAsked, ['/usage', '/credits', '/usage'], 'the next read within ten minutes asks /usage only');
  // no /credits while /usage fails: a signed-out CLI is asked once per read, not twice
  const out = [];
  const signedOut = agyQuotaReader({ resolve, warn: () => {}, run: async (bin, args) => { out.push(args[1]); return { stdout: JSON.stringify({ ...JSON.parse(AGY_USAGE), status: 'ERROR' }), code: 0 }; } });
  assert.equal(await signedOut(), null);
  assert.deepEqual(out, ['/usage']);
});
