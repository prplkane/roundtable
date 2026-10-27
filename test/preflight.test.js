import test from 'node:test';
import assert from 'node:assert/strict';
import { lamp, checkPool, STATUS, createPreflightCache } from '../src/preflight.js';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const win = (label, used, resetsInS = 3600) => ({ label, used, resetsAt: NOW / 1000 + resetsInS });

test('preflight reads never execute checks, even when missing, stale or already refreshing', async () => {
  let now = NOW, calls = 0, release;
  const cache = createPreflightCache({ now: () => now, check: async (key) => {
    calls++;
    await new Promise((r) => { release = r; });
    return { key, state: 'ok', kind: null, note: 'ready' };
  } });
  assert.equal(cache.read('codex').state, 'idle');
  assert.equal(cache.read('codex').checkedAt, null);
  assert.equal(calls, 0);
  const first = cache.refresh('codex');
  await new Promise(setImmediate);
  assert.equal(cache.read('codex').refreshing, true);
  assert.equal(calls, 1);
  release();
  const result = await first;
  assert.equal(result.checkedAt, NOW);
  assert.equal(result.refreshing, false);
  now += 60_001;
  assert.equal(cache.read('codex').stale, true);
  assert.equal(cache.read('codex').state, 'ok', 'a stale snapshot is labelled, not replaced by a fabricated check');
  assert.equal(calls, 1, 'expired reads do not run anything');
});

test('preflight shares in-flight work and bounds concurrent checks and the waiting queue', async () => {
  let active = 0, peak = 0;
  const started = [], releases = new Map();
  const cache = createPreflightCache({ maxConcurrent: 2, maxPending: 3, check: async (key) => {
    started.push(key); peak = Math.max(peak, ++active);
    await new Promise((r) => releases.set(key, r));
    active--;
    return { key, state: 'ok' };
  } });
  const a = cache.refresh('claude'), b = cache.refresh('codex'), c = cache.refresh('codex@work');
  assert.equal(cache.refresh('claude', { fresh: true }), a, 'forced refresh joins the same check');
  assert.equal(cache.refresh('codex@work'), c, 'queued checks are shared too');
  await new Promise(setImmediate);
  assert.deepEqual(started, ['claude', 'codex']);
  const busy = await cache.refresh('codex@extra');
  assert.equal(busy.kind, 'busy');
  assert.match(busy.note, /Refresh status/);
  releases.get('claude')(); await a;
  await new Promise(setImmediate);
  assert.deepEqual(started, ['claude', 'codex', 'codex@work']);
  releases.get('codex')(); releases.get('codex@work')();
  await Promise.all([b, c]);
  assert.equal(peak, 2);
  assert.equal(cache.read('codex@extra').checkedAt, null, 'overflow did not execute or enter the cache');
});

test('ordinary refreshes reuse a one-minute cache; forced refreshes respect a five-second cooldown', async () => {
  let now = NOW, calls = 0;
  const cache = createPreflightCache({ now: () => now, check: async (key) => ({ key, state: 'ok', count: ++calls }) });
  await cache.refresh('codex');
  now += 4_999;
  assert.equal((await cache.refresh('codex', { fresh: true })).count, 1);
  now++;
  assert.equal((await cache.refresh('codex', { fresh: true })).count, 2);
  now += 59_999;
  assert.equal((await cache.refresh('codex')).count, 2);
  now++;
  assert.equal((await cache.refresh('codex')).count, 3);
});

test('failed preflight checks free their slots, use the cooldown and never echo command output', async () => {
  let calls = 0;
  const cache = createPreflightCache({ maxConcurrent: 1, check: async (key) => {
    calls++;
    if (key === 'codex') throw new Error('private command output');
    return { key, state: 'ok' };
  } });
  const [failed, good] = await Promise.all([cache.refresh('codex'), cache.refresh('claude')]);
  assert.equal(failed.kind, 'check-failed');
  assert.equal(failed.state, 'warn');
  assert.ok(!failed.note.includes('private command output'));
  assert.equal(good.state, 'ok');
  await cache.refresh('codex', { fresh: true });
  assert.equal(calls, 2);
});

test('preflight retains only a bounded number of completed snapshots', async () => {
  const cache = createPreflightCache({ maxCached: 2, check: async (key) => ({ key, state: 'ok' }) });
  for (const key of ['codex', 'codex@work', 'claude']) await cache.refresh(key);
  assert.equal(cache.read('codex').checkedAt, null);
  assert.notEqual(cache.read('codex@work').checkedAt, null);
  assert.notEqual(cache.read('claude').checkedAt, null);
});

test('lamp: missing and logged out are red; a used-up window is red with its reset; nearly used is yellow; logged in is green', () => {
  assert.equal(lamp({ vendor: 'codex', installed: false }, NOW).kind, 'missing');
  const out = lamp({ vendor: 'claude', installed: true, loggedIn: false, account: 'work' }, NOW);
  assert.deepEqual([out.state, out.kind], ['danger', 'auth']);
  assert.match(out.note, /profile work.*claude \/login/);
  const spent = lamp({ vendor: 'codex', installed: true, loggedIn: true, quota: { windows: [win('5h', 0.12), win('7d', 1, 5 * 86400)] } }, NOW);
  assert.deepEqual([spent.state, spent.kind], ['danger', 'quota']);
  assert.match(spent.note, /quota used up \(7d, resets in 5d 0h\)/);
  assert.equal(lamp({ vendor: 'codex', installed: true, loggedIn: true, quota: { windows: [win('5h', 0.93)] } }, NOW).state, 'warn');
  assert.equal(lamp({ vendor: 'claude', installed: true, loggedIn: true, quota: null }, NOW).state, 'ok');
  assert.equal(lamp({ vendor: 'agy', installed: true, loggedIn: null, quota: null }, NOW).state, 'warn', 'a CLI that cannot say is not called ready');
});

test('checkPool reads no quota for a logged-out CLI, and the status readers understand each CLI', async () => {
  let quotaRead = false;
  const r = await checkPool({ vendor: 'codex', key: 'codex' }, { resolve: () => true, status: async () => false, quota: async () => { quotaRead = true; return null; }, now: NOW });
  assert.equal(r.kind, 'auth');
  assert.equal(quotaRead, false);
  assert.equal(STATUS.claude.read('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}'), true);
  assert.equal(STATUS.claude.read('{ "loggedIn": false }'), false);
  assert.equal(STATUS.codex.read('Logged in using ChatGPT'), true);
  assert.equal(STATUS.codex.read('Not logged in'), false);
});

test('the pre-flight carries the plan the CLI names: claude from its status, codex from its quota read', async () => {
  const { STATUS: S, checkPool: check } = await import('../src/preflight.js');
  assert.equal(S.claude.plan('{ "loggedIn": true, "subscriptionType": "max" }'), 'max');
  const claude = await check({ vendor: 'claude', key: 'claude' }, { resolve: () => true, status: async () => ({ loggedIn: true, plan: 'pro' }), quota: async () => null });
  assert.deepEqual([claude.loggedIn, claude.plan, claude.state], [true, 'pro', 'ok']);
  const codex = await check({ vendor: 'codex', key: 'codex' }, { resolve: () => true, status: async () => true, quota: async () => ({ plan: 'prolite', windows: [{ label: '7d', used: 0.2 }] }) });
  assert.equal(codex.plan, 'prolite');
});

test('endpointLamp: no probe leaves this server; the lamp says what the URL and the environment allow', async () => {
  const { endpointLamp } = await import('../src/preflight.js');
  assert.equal(endpointLamp({ url: '' }).state, 'idle');
  assert.deepEqual(endpointLamp({ url: 'http://localhost:11434/v1' }), { state: 'ok', kind: null, note: 'API · local · checked on the first call' });
  const hosted = endpointLamp({ url: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', keySet: false });
  assert.deepEqual([hosted.state, hosted.kind], ['danger', 'auth']);
  assert.match(hosted.note, /DEEPSEEK_API_KEY is not set/);
  assert.match(endpointLamp({ url: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', keySet: true }).note, /pay-per-token · DEEPSEEK_API_KEY set/);
  assert.equal(endpointLamp({ url: 'https://api.deepseek.com/v1' }).kind, 'auth', 'a hosted API without a key variable');
  assert.equal(endpointLamp({ url: 'http://api.deepseek.com/v1', keyEnv: 'K', keySet: true }).kind, 'endpoint', 'plain http to a hosted API');
  assert.equal(endpointLamp({ url: 'http://10.api.example.com/v1', keyEnv: 'K', keySet: true }).kind, 'endpoint', 'a private-looking DNS prefix still needs HTTPS');
  assert.equal(endpointLamp({ url: 'https://10.api.example.com/v1' }).kind, 'auth', 'the same hosted name still needs a key variable over HTTPS');
  assert.equal(endpointLamp({ url: 'https://api.deepseek.com/v1', keyEnv: 'sk-live-123', keySet: false }).kind, 'auth', 'a pasted key is not a variable name');
});
