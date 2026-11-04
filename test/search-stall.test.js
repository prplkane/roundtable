// A stalled Codex search: the process runner's silence limit, the adapter applying it to the
// searcher only, and the engine starting the search once more inside its one time limit.
// No vendor CLI runs: a node one-liner and the fake CLI stand in.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { runProcess } from '../src/adapters/spawn.js';
import { makeAdapter, buildArgs } from '../src/adapters/common.js';
import { ADAPTERS, codexStreamFor, codexStream } from '../src/adapters/config.js';
import { createDebate, SEARCH_RETRY_MIN_MS } from '../src/engine.js';

const node = { file: process.execPath, prefix: ['-e'] };
const fake = { file: process.execPath, prefix: [path.resolve('test/fixtures/fake-cli.mjs')] };

test('runProcess stops a process that prints nothing for stallMs, and leaves a talkative one alone', async () => {
  const t0 = Date.now();
  await assert.rejects(runProcess(node, ['process.stdout.write("started\\n"); setTimeout(() => {}, 10000)'], { timeoutMs: 8000, stallMs: 400 }), (e) => {
    assert.equal(e.code, 'STALL');
    assert.match(e.message, /no progress for 0 s/);
    assert.equal(e.progress.outcome, 'timeout');
    assert.ok(Date.now() - t0 < 4000, 'stopped by the silence limit, not the time limit');
    return true;
  });
  // the limit counts from spawn, so leave a slow node start well inside it
  const r = await runProcess(node, ['let n = 0; const t = setInterval(() => { process.stdout.write("tick\\n"); if (++n === 8) { clearInterval(t); } }, 100)'], { timeoutMs: 8000, stallMs: 2500 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 8);
});

test('only the Codex searcher has a silence limit; a stalled search is a timeout named as a stall', async () => {
  assert.equal(ADAPTERS.codex.research.stallMs, 40_000);
  for (const v of ['claude', 'agy']) assert.equal(ADAPTERS[v].research?.stallMs, undefined, `${v} searcher: unchanged`);
  const search = JSON.stringify({ type: 'item.started', item: { id: 'search-1', type: 'web_search', query: '', action: { type: 'other' } } }) + '\n';
  const research = { vendor: 'codex', query: 'public question', maxSearches: 2, timeoutMs: 30000 };
  try {
    Object.assign(process.env, { FAKE_SHAPE: 'codex', FAKE_SLEEP: '10000', FAKE_PRELUDE: search });
    const run = makeAdapter('codex', { bin: fake, research: { ...ADAPTERS.codex.research, stallMs: 1000 } });
    const t0 = Date.now();
    await assert.rejects(run('q', null, { timeoutMs: 8000, research }), (e) => {
      assert.equal(e.code, 'STALL'); assert.equal(e.kind, 'timeout');
      assert.match(e.message, /web search stalled: no progress for 1 s/);
      assert.equal(e.progress.stage, 'searching'); assert.equal(e.progress.outcome, 'timeout');
      return true;
    });
    assert.ok(Date.now() - t0 < 5000);
    // an ordinary seat call has no silence limit: silence runs to its time limit (a search event
    // there would be a tool violation, so this one prints nothing)
    process.env.FAKE_PRELUDE = '';
    await assert.rejects(makeAdapter('codex', { bin: fake, research: { ...ADAPTERS.codex.research, stallMs: 300 } })('q', null, { timeoutMs: 1500 }), (e) => e.code === 'TIMEOUT');
  } finally { for (const k of ['FAKE_SHAPE', 'FAKE_SLEEP', 'FAKE_PRELUDE']) delete process.env[k]; }
});

// a stand-in Codex: the turn starts, then only "Reconnecting..." every 250 ms, never a result
const reconnecting = `const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
  say({ type: 'thread.started', thread_id: 't' }); say({ type: 'turn.started' });
  let n = 0; setInterval(() => say({ type: 'error', message: 'Reconnecting... ' + (++n) + '/9 (stream disconnected before completion: idle timeout waiting for SSE)' }), 250);`;
const researchOpts = { vendor: 'codex', query: 'public question', maxSearches: 2, timeoutMs: 30000 };

test('a light Codex call reconnects a silent request early and often; other efforts keep the derived settings', () => {
  const stream = (limit, effort = 'low') => ADAPTERS.codex.stream(limit, effort);
  for (const effort of ['none', 'minimal', 'low']) {
    assert.ok(stream(120_000, effort).includes('model_providers.roundtable.stream_idle_timeout_ms=15000'), effort);
    assert.ok(stream(300_000, effort).includes('model_providers.roundtable.stream_max_retries=5'), effort);
  }
  assert.ok(stream(30_000).includes('model_providers.roundtable.stream_idle_timeout_ms=10000'), 'a tight limit keeps the shorter derived idle');
  assert.ok(codexStreamFor(120_000, 'low').includes('model_provider="roundtable"'), 'same provider and login');
  for (const effort of ['medium', 'high', 'xhigh', null]) assert.deepEqual(stream(300_000, effort), codexStream(300_000), `${effort} effort: may reason in silence, so the derived settings`);
  const plain = buildArgs(ADAPTERS.codex, { prompt: 'hi', timeoutMs: 120_000 }).args;
  assert.ok(plain.includes('model_providers.roundtable.stream_idle_timeout_ms=35000') && plain.includes('model_providers.roundtable.stream_max_retries=2'), 'no effort named: the CLI default, derived settings');
  assert.ok(buildArgs(ADAPTERS.codex, { prompt: 'hi', timeoutMs: 300_000, effort: 'low' }).args.includes('model_providers.roundtable.stream_idle_timeout_ms=15000'), 'buildArgs passes the effort on');
  assert.equal(ADAPTERS.codex.research.reconnectIsProgress, true);
});

test('the argv carries the light stream for a searcher and a seat at low effort alike', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rt-stall-'));
  const record = path.join(dir, 'argv.json');
  const argv = async (opts) => { await run('q', null, opts).catch(() => {}); return JSON.parse(readFileSync(record, 'utf8')).argv; };
  const run = makeAdapter('codex', { bin: fake });
  const research = { ...researchOpts, timeoutMs: 120_000 };
  try {
    Object.assign(process.env, { FAKE_SHAPE: 'codex', FAKE_RECORD: record });
    assert.ok((await argv({ timeoutMs: 120_000, effort: 'low', research })).includes('model_providers.roundtable.stream_idle_timeout_ms=15000'));
    assert.ok((await argv({ timeoutMs: 120_000, effort: 'high', research })).includes('model_providers.roundtable.stream_idle_timeout_ms=35000'));
    assert.ok((await argv({ timeoutMs: 300_000, effort: 'low' })).includes('model_providers.roundtable.stream_idle_timeout_ms=15000'), 'a seat at low effort');
    assert.ok((await argv({ timeoutMs: 300_000, effort: 'medium' })).includes('model_providers.roundtable.stream_idle_timeout_ms=95000'), 'a seat at medium effort');
  } finally { delete process.env.FAKE_SHAPE; delete process.env.FAKE_RECORD; rmSync(dir, { recursive: true, force: true }); }
});

test('Codex reconnects are counted from its retry log too, which sees the first WebSocket retry its events leave out', async () => {
  // a stand-in Codex: two retry lines on stderr (as RUST_LOG prints them), one visible notice, then a reply
  const script = `const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
    const warn = (n) => process.stderr.write('2026-11-02T00:00:00Z  WARN codex_core::responses_retry: stream disconnected - retrying sampling request (' + n + '/5 in 200ms)...\\n');
    say({ type: 'thread.started', thread_id: 't' }); say({ type: 'turn.started' });
    warn(1); warn(2); say({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: idle timeout waiting for websocket)' });
    say({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'log level ' + process.env.RUST_LOG } });
    say({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } });`;
  const r = await makeAdapter('codex', { bin: { file: process.execPath, prefix: ['-e', script] } })('q', null, { timeoutMs: 10_000, effort: 'low' });
  assert.equal(r.progress.reconnects, 2, 'both retries, not just the one notice');
  assert.equal(r.text, `log level ${ADAPTERS.codex.env.RUST_LOG}`, 'the child gets the retry log level');
  assert.equal(ADAPTERS.codex.retries('no retries here'), 0);
  for (const v of ['claude', 'agy']) assert.equal(ADAPTERS[v].retries, undefined, `${v}: unchanged`);
});

test('the searcher waits through the CLI\'s own reconnects', async () => {
  const run = makeAdapter('codex', { bin: { file: process.execPath, prefix: ['-e', reconnecting] }, research: { ...ADAPTERS.codex.research, stallMs: 1500 } });
  const t0 = Date.now();
  await assert.rejects(run('q', null, { timeoutMs: 4000, research: researchOpts }), (e) => {
    assert.equal(e.code, 'TIMEOUT', 'reconnect notices kept the call alive until its time limit');
    assert.ok(e.progress.reconnects >= 6, 'and every notice was counted');
    return true;
  });
  assert.ok(Date.now() - t0 >= 3500);
});

test('reconnect notices are not progress where reconnects are not bounded for the searcher', async () => {
  const run = makeAdapter('codex', { bin: { file: process.execPath, prefix: ['-e', reconnecting] }, research: { ...ADAPTERS.codex.research, stallMs: 1500, reconnectIsProgress: false } });
  const t0 = Date.now();
  await assert.rejects(run('q', null, { timeoutMs: 10000, research: researchOpts }), (e) => {
    assert.equal(e.code, 'STALL');
    assert.ok(e.progress.reconnects >= 3, 'the notices kept arriving and were counted');
    return true;
  });
  assert.ok(Date.now() - t0 < 6000, 'stopped about 1.5 s after the last real event, not at the time limit');
});

// the engine: a stalled searcher call, then what follows
const fieldNotes = { decision: 'Release?', options: ['Trial', 'Wait'] };
const seats = [{ id: 'seat-0', vendor: 'claude', lens: 'risk' }, { id: 'seat-1', vendor: 'codex', lens: 'cost' }];
const sources = JSON.stringify({ sources: [{ url: 'https://example.com/evidence', title: 'A synthetic source', excerpt: 'A small trial exposes risks.', publishedAt: null }] });
const reply = (i) => `STANCE: opt-${i + 1}\nAGREE_WITH: []\nDISAGREE:\n- tradeoffs\nNEW:\n- See S1\nASSUMPTIONS:\n- it applies`;
const verdict = 'RECOMMENDATION: opt-1\nTrial.\nTALLY:\n- split\nDISSENT: cost wanted to wait\nKILL_CRITERIA:\n- faults\nOPEN_QUESTIONS:\n- none';
const usage = { input: 10, output: 5 };
const stall = () => Object.assign(new Error('Codex\'s web search stalled: no progress for 40 s.'), { code: 'STALL', kind: 'timeout', progress: { elapsedMs: 41000, stage: 'searching', outcome: 'timeout' } });

async function review({ timeoutMs = 120_000, research, clock = null }) {
  const rows = [], searchCalls = [];
  const now = clock ? () => clock.t : Date.now;
  const state = await createDebate({ fieldNotes, seats, now, options: { research: { vendor: 'codex', query: 'public question', maxSearches: 2, timeoutMs }, critiqueRounds: 0, unattended: true },
    store: { append: (r) => rows.push(r) },
    runner: async (vendor, prompt, sid, o) => {
      if (o.research) { searchCalls.push(o.timeoutMs); return research(searchCalls.length, clock); }
      return { text: o.seat.id === 'chairman' ? verdict : reply(o.seat.index), usage };
    } }).run();
  return { state, rows, searchCalls, attempts: rows.filter((r) => r.type === 'attempt' && r.kind === 'research') };
}

test('a stalled search is started once more within the same time limit, and the review goes on', async () => {
  const clock = { t: Date.now() };
  const { state, searchCalls, attempts } = await review({ clock, research: (n, c) => {
    if (n === 1) { c.t += 41_000; throw Object.assign(stall(), { research: { searches: 2 } }); }
    return { text: sources, usage, research: { searches: 1 } };
  } });
  assert.deepEqual(attempts.map((a) => a.searches), [2, 1], 'each attempt keeps its own search count');
  assert.equal(state.research.searches, 1, 'the evidence comes from the attempt that answered');
  assert.equal(state.research.status, 'done');
  assert.equal(searchCalls.length, 2);
  assert.equal(searchCalls[0], 120_000);
  assert.equal(searchCalls[1], 120_000 - 41_000, 'the retry gets only what is left of the limit');
  assert.deepEqual(attempts.map((a) => [a.systemCode, a.errorKind]), [['STALL', 'timeout'], [undefined, undefined]]);
  assert.ok(attempts[0].unknown, 'the stalled attempt reported no usage');
  assert.ok(state.rounds[0].every((r) => r.valid), 'discussion ran on the retried evidence');
});

test('no retry when too little time is left, after a second stall, or for a timeout that is not a stall', async () => {
  const clock = { t: Date.now() };
  // 120 s limit, the stall noticed at 100 s: 20 s left, under the minimum a search needs
  let r = await review({ clock, research: (n, c) => { c.t += 100_000; throw stall(); } });
  assert.ok(120_000 - 100_000 < SEARCH_RETRY_MIN_MS);
  assert.deepEqual([r.state.research.status, r.searchCalls.length], ['failed', 1]);
  assert.equal(r.state.stopReason, 'research-failed');
  // two stalls: one retry, never a second
  r = await review({ clock: { t: Date.now() }, research: (n, c) => { c.t += 41_000; throw stall(); } });
  assert.deepEqual([r.state.research.status, r.searchCalls.length], ['failed', 2]);
  // the plain time limit running out is not a stall: research is still never rerun for it
  r = await review({ research: () => { throw Object.assign(new Error('timed out'), { code: 'TIMEOUT', kind: 'timeout' }); } });
  assert.deepEqual([r.state.research.status, r.searchCalls.length], ['failed', 1]);
  // a turn the provider failed for another reason is not rerun either
  r = await review({ research: () => { throw Object.assign(new Error('model not supported'), { code: 'CLI_FAILURE', kind: 'other' }); } });
  assert.deepEqual([r.state.research.status, r.searchCalls.length], ['failed', 1]);
});

test('a search whose CLI used up its reconnects on a silent stream is started once more', async () => {
  const clock = { t: Date.now() };
  const { state, searchCalls, attempts } = await review({ clock, research: (n, c) => {
    if (n === 1) { c.t += 80_000; throw Object.assign(new Error('Codex\'s provider connection stalled before completion.'), { code: 'CLI_FAILURE', kind: 'timeout' }); }
    return { text: sources, usage, research: { searches: 1 } };
  } });
  assert.deepEqual(attempts.map((a) => [a.systemCode, a.errorKind]), [['CLI_FAILURE', 'timeout'], [undefined, undefined]]);
  assert.equal(searchCalls[1], 120_000 - 80_000, 'within the same time limit');
  assert.equal(state.research.status, 'done');
});
