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
