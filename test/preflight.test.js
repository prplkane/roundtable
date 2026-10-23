import test from 'node:test';
import assert from 'node:assert/strict';
import { lamp, checkPool, STATUS } from '../src/preflight.js';

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const win = (label, used, resetsInS = 3600) => ({ label, used, resetsAt: NOW / 1000 + resetsInS });

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
  assert.equal(endpointLamp({ url: 'https://api.deepseek.com/v1', keyEnv: 'sk-live-123', keySet: false }).kind, 'auth', 'a pasted key is not a variable name');
});
