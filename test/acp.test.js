import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAcpAdapter, promptUsage, agentLinkBinary } from '../src/adapters/acp.js';
import { liveChildren, killAll } from '../src/adapters/spawn.js';
import { normaliseSeats, normaliseChairman, seatKind } from '../src/seats.js';
import { ADAPTERS } from '../src/adapters/config.js';
import { validateDebateRequest } from '../src/validate.js';
import { createDebate } from '../src/engine.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url));

test('AgentLink resolves and launches the public scoped npm package from PATH', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'roundtable-agentlink-npm-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const script = path.join(root, 'node_modules', '@prplkane', 'agentlink', 'src', 'cli.mjs');
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, "console.log('synthetic-public-agentlink');\n");
  writeFileSync(path.join(root, 'agentlink.cmd'), '@echo off\n');
  const bin = agentLinkBinary({ PATH: root });
  assert.equal(execFileSync(bin.file, bin.prefix, { encoding: 'utf8', windowsHide: true }).trim(), 'synthetic-public-agentlink');
});

function setup(t, mode = 'review') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'roundtable-acp-'));
  const log = path.join(root, 'wire.jsonl');
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const run = makeAcpAdapter({ bin: { file: process.execPath, prefix: [fixture] }, env: { ...process.env, ACP_FIXTURE_MODE: mode, ACP_FIXTURE_LOG: log } });
  return { root, run, opts: { cwd: root, account: 'synthetic', allowLimitedIsolation: true, timeoutMs: 10000 },
    events: () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('ACP streams an answer, sends only standard methods and uses a fresh isolated session', async (t) => {
  const c = setup(t);
  const reply = await c.run('Synthetic review', null, { ...c.opts, model: 'fake-choice' });
  assert.match(reply.text, /^STANCE: opt-1/);
  assert.deepEqual([reply.usage.input, reply.usage.cacheRead, reply.usage.output, reply.cost], [980, 20, 100, 0.01]);
  const events = c.events(), rpc = events.filter((e) => e.rpc?.method).map((e) => e.rpc);
  assert.deepEqual(rpc.map((m) => m.method), ['initialize', 'session/new', 'session/set_config_option', 'session/prompt']);
  assert.deepEqual(rpc[0].params.clientCapabilities, {});
  assert.deepEqual(rpc[1].params, { cwd: c.root, mcpServers: [] });
  assert.ok(events.some((e) => e.exit));
});

test('ACP selects an advertised reasoning level and refuses one the agent does not offer', async (t) => {
  const c = setup(t);
  const reply = await c.run('Synthetic review', null, { ...c.opts, effort: 'max' });
  assert.match(reply.text, /^STANCE: opt-1/);
  const set = c.events().filter((e) => e.rpc?.method === 'session/set_config_option').map((e) => [e.rpc.params.configId, e.rpc.params.value]);
  assert.deepEqual(set, [['thought_level', 'max']], 'the level goes through the standard config option, nothing else is sent');
  await assert.rejects(c.run('q', null, { ...c.opts, effort: 'ultra' }), { code: 'ACP_UNSUPPORTED' });
  const bare = setup(t, 'no-levels');
  await assert.rejects(bare.run('q', null, { ...bare.opts, effort: 'max' }), { code: 'ACP_UNSUPPORTED' });
  assert.ok(!bare.events().some((e) => e.rpc?.method === 'session/prompt'), 'an agent without a reasoning setting is not prompted at one');
});

test('an ACP seat may name any identifier as its effort; the agent, not a static list, decides', () => {
  const two = (effort) => [{ vendor: 'acp', account: 'work', lens: 'risk', effort }, { vendor: 'acp', account: 'work', lens: 'cost' }];
  assert.equal(normaliseSeats(two('max'), { vendors: ADAPTERS })[0].effort, 'max');
  assert.throws(() => normaliseSeats(two('very high!'), { vendors: ADAPTERS }), /identifier the agent advertises/);
  assert.equal(normaliseChairman({ vendor: 'acp', account: 'work', effort: 'low' }, { vendors: ADAPTERS }).effort, 'low');
  assert.throws(() => normaliseSeats([{ vendor: 'claude', lens: 'risk', effort: 'max' }, { vendor: 'codex', lens: 'cost' }], { vendors: ADAPTERS }), /does not accept effort "max"/, 'CLI vendors keep their lists');
});

test('a budget on one AgentLink profile is checked apart from other profiles and from the bare acp cap', () => {
  const body = (budget) => validateDebateRequest({ fieldNotes: { decision: 'd', options: ['A', 'B'] }, seats: [{ vendor: 'acp', account: 'a', lens: 'risk' }, { vendor: 'acp', account: 'b', lens: 'cost' }], options: { budget } }, { adapters: ADAPTERS });
  assert.deepEqual(body({ 'acp@a': { tokens: 500 }, acp: { tokens: 9000 } }).options.budget, { 'acp@a': { tokens: 500 }, acp: { tokens: 9000 } });
  assert.throws(() => body({ 'claude@work': { tokens: 1 } }), /one budget for all its seats/);
  assert.throws(() => body({ 'acp@Bad Name': { tokens: 1 } }), /acp@Bad Name: An ACP seat needs a valid saved AgentLink profile/);
  assert.throws(() => body({ 'acp@a': { usd: 1 } }), /does not report cost/);
});

test('missing token usage stays unknown; context occupancy is never charged as tokens', async (t) => {
  const c = setup(t, 'no-usage');
  const reply = await c.run('Synthetic review', null, c.opts);
  assert.equal(reply.usage, null); assert.equal(reply.cost, 0.01);
  assert.equal(promptUsage({ inputTokens: 5, outputTokens: 2, totalTokens: 99 }, null, 1), null);
});

test('ACP rejects foreign updates coalesced with the session creation response', async (t) => {
  const c = setup(t, 'early-wrong-session');
  await assert.rejects(c.run('Synthetic review', null, c.opts), { code: 'PROVIDER_PROTOCOL' });
  assert.ok(!c.events().some(e => e.rpc?.method === 'session/prompt'));
});

for (const [mode, code] of [['permission', 'TOOL_POLICY'], ['filesystem', 'TOOL_POLICY'], ['tool', 'TOOL_POLICY'],
  ['wrong-session', 'PROVIDER_PROTOCOL'], ['malformed', 'PROVIDER_PROTOCOL'], ['large', 'OUTPUT_LIMIT'], ['version', 'ACP_UNSUPPORTED'],
  ['auth', 'CLI_FAILURE'], ['crash', 'CLI_EXIT'], ['truncated', 'CLI_FAILURE'], ['tail', 'PROVIDER_PROTOCOL']]) {
  test(`ACP rejects ${mode} without accepting an answer`, async (t) => {
    const c = setup(t, mode);
    await assert.rejects(c.run('Synthetic review', null, c.opts), (e) => e.code === code && !e.text);
    if (mode === 'permission') assert.deepEqual(c.events().find((e) => e.rpc?.id === 'tool-request')?.rpc.result, { outcome: { outcome: 'cancelled' } });
    if (mode === 'filesystem') assert.equal(c.events().find((e) => e.rpc?.id === 'file-request')?.rpc.error.code, -32601);
  });
}

test('ACP deadline sends cancel and releases its registered process', async (t) => {
  const c = setup(t, 'wait');
  await assert.rejects(c.run('Synthetic review', null, { ...c.opts, tag: 'acp-timeout', timeoutMs: 600 }), { code: 'TIMEOUT' });
  assert.ok(c.events().some((e) => e.rpc?.method === 'session/cancel'));
  assert.deepEqual(liveChildren('acp-timeout'), []);
});

test('stopping one tagged ACP call cancels it without stopping another', async (t) => {
  const c = setup(t, 'wait'), other = setup(t);
  const pending = c.run('Synthetic review', null, { ...c.opts, tag: 'acp-stop' });
  const rejected = assert.rejects(pending, { code: 'KILLED' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(killAll('acp-stop'), 1);
  const result = await other.run('Synthetic review', null, { ...other.opts, tag: 'acp-other' });
  await rejected;
  assert.match(result.text, /^STANCE:/);
  assert.deepEqual(liveChildren('acp-stop'), []);
});

test('ACP reaps a process that ignores input EOF after completing its reply', async (t) => {
  const c = setup(t, 'stubborn');
  const reply = await c.run('Synthetic review', null, c.opts);
  assert.match(reply.text, /^STANCE:/);
  const pid = c.events().find((e) => e.start).pid;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('ACP rejects missing profiles, unsafe names, resume and undeclared capabilities before prompting', async (t) => {
  const c = setup(t);
  await assert.rejects(c.run('q', null, { ...c.opts, account: '' }), /profile/i);
  await assert.rejects(c.run('q', null, { ...c.opts, account: '../private' }), /Profile/i);
  await assert.rejects(c.run('q', null, { ...c.opts, allowLimitedIsolation: false }), { code: 'ISOLATION_REQUIRED' });
  await assert.rejects(c.run('q', 'old', c.opts), { code: 'ACP_STATELESS_REQUIRED' });
  await assert.rejects(c.run('q', null, { ...c.opts, model: 'unadvertised' }), { code: 'ACP_UNSUPPORTED' });
  assert.ok(!c.events().some((e) => e.rpc?.method === 'session/prompt'));
  assert.throws(() => agentLinkBinary({ ROUNDTABLE_AGENTLINK_CLI: 'relative.mjs' }), { code: 'ENOENT' });
});

test('ACP profile selection survives seat/chair normalization and refuses resume memory', () => {
  const raw = [{ vendor: 'acp', account: 'first', lens: 'risk' }, { vendor: 'acp', account: 'second', lens: 'cost' }];
  const seats = normaliseSeats(raw, { vendors: ADAPTERS });
  assert.deepEqual(seats.map((s) => s.account), ['first', 'second']);
  assert.deepEqual(seats.map((s) => s.label), ['ACP first', 'ACP second']);
  assert.equal(normaliseChairman(raw[0], { vendors: ADAPTERS }).account, 'first');
  assert.equal(seatKind(ADAPTERS.acp), 'ACP · profile billing');
  assert.throws(() => normaliseChairman({ vendor: 'acp' }, { vendors: ADAPTERS }), /profile/);
  assert.throws(() => validateDebateRequest({ fieldNotes: { decision: 'Synthetic', options: ['A', 'B'] }, seats: raw, options: { memory: 'resume' } }, { adapters: ADAPTERS }), /stateless/);
});

test('a complete offline review reaches chairman synthesis through ACP', async (t) => {
  const c = setup(t), records = [];
  const seats = normaliseSeats([{ vendor: 'acp', account: 'synthetic', lens: 'risk' }, { vendor: 'acp', account: 'synthetic', lens: 'cost' }], { vendors: ADAPTERS });
  const debate = createDebate({ fieldNotes: { decision: 'Synthetic review', options: ['Trial', 'Wait'] }, seats,
    runner: (vendor, prompt, sid, opts) => c.run(prompt, sid, { ...c.opts, ...opts, account: opts.seat.account, cwd: path.join(c.root, opts.seat.id) }),
    gate: async () => ({ action: 'continue', message: 'Synthetic correction: consider cost again.' }),
    store: { append: (r) => records.push(r), writeVerdict() {}, writeFieldNotes() {} }, emit() {},
    options: { critiqueRounds: 1, allowLimitedIsolation: true } });
  const result = await debate.run();
  assert.equal(result.status, 'done'); assert.equal(result.verdict.failed, false); assert.match(result.verdict.text, /^RECOMMENDATION: opt-1/);
  assert.equal(result.rounds.length, 2);
  assert.equal(result.verdict.seat.account, 'synthetic', 'the default chairman retains its ACP profile');
  assert.equal(records.filter((r) => r.type === 'attempt').length, 5);
  assert.equal(new Set(c.events().filter((e) => e.start).map((e) => e.pid)).size, 5);
});

test('a budget on one AgentLink profile counts that profile alone; the bare acp cap counts every ACP seat', async (t) => {
  const c = setup(t);
  // 110 tokens projected per call; the fixture then reports 1,100 per call
  const baselines = { acp: { fresh: { input: 100, output: 10, n: 1, cost: null, nCost: 0 }, resumed: { input: 100, output: 10, n: 1, cost: null, nCost: 0 } } };
  const run = async (budget) => {
    const records = [], events = [];
    const seats = normaliseSeats([{ vendor: 'acp', account: 'capped', lens: 'risk' }, { vendor: 'acp', account: 'open', lens: 'cost' }], { vendors: ADAPTERS });
    const result = await createDebate({ fieldNotes: { decision: 'Synthetic profile budget', options: ['Trial', 'Wait'] }, seats, chairman: { vendor: 'acp', account: 'open' },
      runner: (vendor, prompt, sid, opts) => c.run(prompt, sid, { ...c.opts, ...opts, account: opts.seat.account, cwd: path.join(c.root, opts.seat.id) }),
      gate: async () => ({ action: 'continue', message: '' }),
      store: { append: (r) => records.push(r), writeVerdict() {}, writeFieldNotes() {} }, emit: (type, p) => events.push(p),
      options: { critiqueRounds: 0, allowLimitedIsolation: true, budget }, baselines }).run();
    return { result, budget: events.find((e) => e.type === 'budget'), attempts: records.filter((r) => r.type === 'attempt') };
  };
  // 1,500 tokens: one profile's single call (1,100) fits under its own cap, so the review completes
  const scoped = await run({ 'acp@capped': { tokens: 1500 } });
  assert.equal(scoped.budget, undefined, 'the other profile and the chairman do not count against this profile');
  assert.equal(scoped.result.verdict.failed, false);
  // the same 1,500 on the bare vendor key counts both seats (2,200) and blocks the verdict
  const bare = await run({ acp: { tokens: 1500 } });
  assert.equal(bare.budget?.vendor, 'acp');
  assert.equal(bare.result.verdict.skipped, true);
  // a cap the profile's first call cannot fit stops the round before any call, named by profile
  const tight = await run({ 'acp@capped': { tokens: 50 } });
  assert.equal(tight.budget?.vendor, 'acp@capped'); assert.equal(tight.budget.kind, 'tokens');
  assert.equal(tight.attempts.length, 0); assert.equal(tight.result.stopReason, 'budget');
});

test('an unavailable ACP chairman can fall back to another configured profile', async (t) => {
  const c = setup(t);
  const seats = normaliseSeats([{ vendor: 'acp', account: 'working', lens: 'risk' }, { vendor: 'acp', account: 'working', lens: 'cost' }], { vendors: ADAPTERS });
  const state = await createDebate({ fieldNotes: { decision: 'Synthetic fallback', options: ['Trial', 'Wait'] }, seats,
    chairman: { vendor: 'acp', account: 'unavailable' },
    runner: (vendor, prompt, sid, opts) => {
      if (opts.seat.account === 'unavailable') throw Object.assign(new Error('Synthetic sign-in failure'), { kind: 'auth' });
      return c.run(prompt, sid, { ...c.opts, ...opts, account: opts.seat.account, cwd: path.join(c.root, opts.seat.id) });
    }, gate: async () => ({ action: 'continue' }), emit() {}, options: { critiqueRounds: 0, allowLimitedIsolation: true },
  }).run();
  assert.equal(state.verdict.failed, false); assert.equal(state.verdict.seat.account, 'working');
});
