import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { researchSettings, researchPrompt, researchSources, researchObserver } from '../src/research.js';
import { makeAdapter, buildArgs } from '../src/adapters/common.js';
import { ADAPTERS } from '../src/adapters/config.js';
import { createDebate, rollup } from '../src/engine.js';
import { rebuildDebate } from '../src/store.js';
import { decisionRecord } from '../src/export.js';
import { validateDebateRequest } from '../src/validate.js';
import { project, projectRound, projectChairman, researchInputTokens, RESEARCH_INPUT_RESERVE } from '../src/estimate.js';
import { reviewSnapshot } from '../src/snapshot.js';

const settings = { query: 'Public evidence for a staged release', maxSearches: 2, timeoutMs: 30000 };
const sources = [{ url: 'https://example.com/evidence', title: 'A synthetic primary source', excerpt: 'A small trial exposes adoption risks.', publishedAt: '2026-01-01' }];
const sourceText = JSON.stringify({ sources });
const fieldNotes = { decision: 'Release?', options: ['Trial', 'Wait'], known: 'PRIVATE_REVIEW_CONTEXT' };
const seats = [{ id: 'seat-0', vendor: 'claude', lens: 'risk' }, { id: 'seat-1', vendor: 'codex', lens: 'cost' }];
const verdict = 'RECOMMENDATION: opt-1\nTrial.\nTALLY:\n- split\nDISSENT: cost wanted to wait\nKILL_CRITERIA:\n- faults\nOPEN_QUESTIONS:\n- none';
const reply = (i) => `STANCE: opt-${i + 1}\nAGREE_WITH: []\nDISAGREE:\n- tradeoffs\nNEW:\n- See S1\nASSUMPTIONS:\n- it applies`;
const usage = { input: 10, output: 5 };
const body = () => ({ fieldNotes, seats, options: { research: settings, critiqueRounds: 1, unattended: true } });

test('research estimates include evidence in every seat and chairman call, including budget admission', async () => {
  const baseline = { fresh: { input: 100, output: 10, n: 1, cost: 1, nCost: 1 }, resumed: { input: 200, output: 10, n: 1, cost: 2, nCost: 1 } };
  const baselines = { claude: baseline, codex: baseline };
  const bundle = researchSources(sourceText, '2026-10-30T00:00:00.000Z');
  const extra = researchInputTokens(bundle);
  assert.ok(extra > 0);
  assert.ok(researchInputTokens([{ ...bundle[0], excerpt: '界'.repeat(1000) }]) > extra, 'larger multilingual excerpts increase the allowance');
  for (const memory of ['stateless', 'resume']) {
    const config = { seats, chairman: { vendor: 'claude' }, critiqueRounds: 1, baselines, memory };
    const plain = project(config), setup = project({ ...config, research: settings }), saved = project({ ...config, research: settings, sources: bundle });
    assert.equal(setup.bySeat['seat-0'].input - plain.bySeat['seat-0'].input, 2 * RESEARCH_INPUT_RESERVE);
    assert.equal(saved.bySeat['seat-0'].input - plain.bySeat['seat-0'].input, 2 * extra);
    assert.equal(saved.bySeat.chairman.input - plain.bySeat.chairman.input, extra);
    assert.ok(saved.bySeat['seat-0'].cost > plain.bySeat['seat-0'].cost);
    assert.ok(saved.bySeat.chairman.cost > plain.bySeat.chairman.cost);
    const round = { seats, round: 1, baselines, memory };
    assert.equal(projectRound({ ...round, researchTokens: extra }).claude.tokens - projectRound(round).claude.tokens, extra);
    assert.ok(projectChairman({ chairman: config.chairman, baselines, researchTokens: extra }).claude.cost > projectChairman(config).claude.cost);
  }
  const calls = [];
  const state = await createDebate({ ...body(), baselines, runner: scripted(calls), store: { append() {} },
    options: { ...body().options, budget: { claude: { tokens: 300 } } } }).run();
  assert.equal(state.research.status, 'done');
  assert.equal(state.stopReason, 'budget', 'the saved evidence makes the first discussion round exceed the cap');
  assert.equal(calls.length, 1, 'only research ran; the old source-free projection would admit discussion');
});

const snapshot = (state) => reviewSnapshot({ slug: 'synthetic-research', gen: 1, rebuilt: state, events: [], finished: true });

test('research failure snapshots exclude real adapter error output and unrecognized saved fields', async () => {
  const marker = 'SYNTHETIC_PRIVATE_CLI_MARKER';
  const output = [{ type: 'item.completed', item: { id: 'search-1', type: 'web_search' } },
    { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 0 } }].map(JSON.stringify).join('\n') + '\n';
  const script = `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(output)}); process.stderr.write(${JSON.stringify(marker)}); });`;
  const adapter = makeAdapter('codex', { bin: { file: process.execPath, prefix: ['-e', script, '--'] } });
  const rows = [];
  const state = await createDebate({ ...body(), runner: (vendor, prompt, sid, opts) => adapter(prompt, sid, opts), store: { append: (r) => rows.push(r) } }).run();
  assert.ok(state.research.error.includes(marker), 'the board retains its original diagnostic');
  const live = reviewSnapshot({ slug: 'synthetic', gen: 1, debate: { state }, events: [], finished: true });
  assert.doesNotMatch(JSON.stringify(live), new RegExp(marker));
  assert.equal(live.research.errorKind, 'other');
  assert.equal(live.research.progress.stage, 'completed');
  const modified = rows.map((r) => r.type === 'research' ? { ...r, errorKind: marker, unexpected: marker,
    progress: { ...r.progress, detail: marker }, attemptId: marker } : r);
  const restored = snapshot(rebuildDebate(modified));
  assert.doesNotMatch(JSON.stringify(restored), new RegExp(marker));
  assert.equal(restored.research.errorKind, 'other');
  assert.equal(restored.research.searches, 1);
});

test('research snapshots preserve intended evidence and bounded status without copying arbitrary fields', async () => {
  const rows = [];
  const state = await createDebate({ ...body(), runner: scripted([]), store: { append: (r) => rows.push(r) } }).run();
  const marker = 'UNEXPECTED_METADATA';
  state.research.extra = marker;
  state.research.sources[0].extra = marker;
  for (const s of [state, rebuildDebate(rows)]) {
    const result = snapshot(s).research;
    assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
    assert.deepEqual(result.sources, researchSources(sourceText, state.research.gatheredAt));
    assert.equal(result.searches, 1);
  }
  assert.deepEqual(snapshot({ ...state, research: { status: 'running', maxSearches: 2, timeoutMs: 30000, error: marker } }).research,
    { status: 'running', maxSearches: 2, timeoutMs: 30000 });
  assert.deepEqual(snapshot({ ...state, research: { status: 'running', maxSearches: marker, timeoutMs: -1 } }).research, { status: 'running' });
  const interrupted = snapshot({ ...state, research: { status: 'interrupted', error: marker } }).research;
  assert.equal(interrupted.errorKind, 'interrupted');
  assert.doesNotMatch(JSON.stringify(interrupted), new RegExp(marker));
  const corrupt = snapshot({ ...state, research: { ...state.research, gatheredAt: marker } }).research;
  assert.deepEqual([corrupt.status, corrupt.errorKind], ['failed', 'format']);
  assert.doesNotMatch(JSON.stringify(corrupt), new RegExp(marker));
  assert.equal(snapshot({ ...state, research: null }).research, undefined);
});

test('research is explicit, bounded and runs on one searching CLI; supplied source bundles cannot bypass research', () => {
  const b = body();
  assert.equal(validateDebateRequest(b, { adapters: ADAPTERS }).options.research.vendor, 'codex'); // a request that names none
  for (const vendor of ['claude', 'codex', 'agy']) assert.equal(researchSettings({ ...settings, vendor }).vendor, vendor);
  for (const change of [{ vendor: 'api' }, { vendor: 'other' }, { query: '' }, { maxSearches: 0 }, { maxSearches: 9 }, { timeoutMs: 29999 }, { timeoutMs: 600001 }])
    assert.throws(() => researchSettings({ ...settings, ...change }), /Research/);
  assert.equal(validateDebateRequest({ ...b, fieldNotes: { ...fieldNotes, research: sources } }, { adapters: ADAPTERS }).fieldNotes.research, undefined);
  assert.doesNotMatch(researchPrompt(settings), /PRIVATE_REVIEW_CONTEXT/);
  assert.ok(buildArgs(ADAPTERS.codex, { prompt: 'q' }).args.includes('web_search="disabled"'));
  const p = project({ seats, chairman: { vendor: 'claude' }, critiqueRounds: 1, research: settings });
  assert.equal(p.bySeat.research.calls, 1);
  assert.ok(p.byVendor.codex.seats.includes('research'));
});

test('source records validate URLs, dates and bounds while keeping excerpts as quoted data', () => {
  const good = researchSources(sourceText, '2026-10-30T00:00:00.000Z');
  assert.equal(good[0].id, 'S1');
  assert.equal(good[0].gatheredAt, '2026-10-30T00:00:00.000Z');
  for (const s of [{ ...sources[0], url: 'javascript:alert(1)' }, { ...sources[0], url: 'https://user:secret@example.com/' },
    { ...sources[0], publishedAt: '2026-02-30' }, { ...sources[0], excerpt: 'x'.repeat(1201) }])
    assert.throws(() => researchSources(JSON.stringify({ sources: [s] })), /Research/);
  for (const raw of ['not JSON', '{"sources":[]}', JSON.stringify({ sources: [sources[0], sources[0]] })]) assert.throws(() => researchSources(raw), /Research/);
  // one fenced block, as Claude answers, is the JSON; anything around the fence is not
  assert.equal(researchSources('```json\n' + JSON.stringify({ sources }, null, 2) + '\n```\n')[0].url, sources[0].url);
  for (const raw of ['Here you go:\n```json\n' + sourceText + '\n```', '```json\n' + sourceText + '\n```\nDone.', '```json\n' + sourceText + '\n```\n```json\n{}\n```'])
    assert.throws(() => researchSources(raw), /Research/);
  const observer = researchObserver(settings, ADAPTERS.codex.research.searchIds);
  for (const type of ['item.started', 'item.updated', 'item.completed']) assert.equal(observer.accept({ type, item: { id: 'one', type: 'web_search' } }), true);
  assert.equal(observer.searches, 1);
  assert.equal(observer.accept({ type: 'item.started', item: { id: 'tool', type: 'command_execution' } }), false);
  observer.report(0); assert.equal(observer.searches, 1, 'a CLI count only raises the figure');
  observer.report(2); assert.equal(observer.searches, 2);
});

test('research CLI permits only reported web searches, enforces the count and keeps debate tools disabled', async () => {
  const bin = { file: process.execPath, prefix: [path.resolve('test/fixtures/fake-cli.mjs')] };
  const run = makeAdapter('codex', { bin });
  const search = (id, type = 'item.completed') => JSON.stringify({ type, item: { id, type: 'web_search', query: 'synthetic public query' } });
  try {
    process.env.FAKE_SHAPE = 'codex'; process.env.FAKE_TEXT = sourceText;
    process.env.FAKE_PRELUDE = ['item.started', 'item.updated', 'item.completed'].map((type) => search('same', type)).join('\n') + '\n';
    const result = await run(researchPrompt(settings), null, { research: settings });
    assert.equal(result.research.searches, 1);
    assert.equal(result.usedTools, false);
    assert.ok(result.raw.args.includes('web_search="live"'));
    assert.ok(result.raw.args.includes('mcp_servers={}'));
    assert.ok(result.raw.args.includes('features.shell_tool=false'));
    await assert.rejects(run('ordinary debate'), (e) => e.code === 'TOOL_POLICY');
    await assert.rejects(run('q', 'old-session', { research: settings }), (e) => e.code === 'RESEARCH_INVALID');
    await assert.rejects(makeAdapter('claude', { bin })('q', null, { research: settings }), (e) => e.code === 'RESEARCH_INVALID');
    process.env.FAKE_SLEEP = '10000';
    process.env.FAKE_PRELUDE = ['one', 'two', 'three'].map((id) => search(id)).join('\n') + '\n';
    await assert.rejects(run('q', null, { research: settings, timeoutMs: 3000 }), (e) => e.code === 'RESEARCH_LIMIT' && e.research.searches === 3 && e.usage === null);
    for (const type of ['command_execution', 'mcp_tool_call', 'file_change']) {
      process.env.FAKE_PRELUDE = JSON.stringify({ type: 'item.started', item: { id: 'forbidden', type } }) + '\n';
      await assert.rejects(run('q', null, { research: settings, timeoutMs: 3000 }), (e) => e.code === 'TOOL_POLICY');
    }
    delete process.env.FAKE_SLEEP; delete process.env.FAKE_PRELUDE;
    await assert.rejects(run('q', null, { research: settings }), (e) => e.code === 'RESEARCH_INVALID');
  } finally { for (const k of ['FAKE_SHAPE', 'FAKE_TEXT', 'FAKE_PRELUDE', 'FAKE_SLEEP']) delete process.env[k]; }
});

function scripted(calls) {
  return async (vendor, prompt, sid, opts) => {
    calls.push({ vendor, prompt, sid, opts });
    if (opts.research) return { text: sourceText, usage, research: { searches: 1 }, sessionId: 'research-thread' };
    return { text: opts.seat.id === 'chairman' ? verdict : reply(opts.seat.index), usage, sessionId: `discussion-${opts.seat.id}` };
  };
}

test('research runs once before blind replies and the identical saved evidence reaches recovery, verdict and export', async () => {
  for (const memory of ['stateless', 'resume']) {
    const calls = [], rows = [];
    const state = await createDebate({ ...body(), options: { ...body().options, memory }, runner: scripted(calls), store: { append: (r) => rows.push(r) } }).run();
    assert.equal(calls[0].opts.seat.id, 'research');
    assert.equal(calls.filter((c) => c.opts.research).length, 1);
    assert.doesNotMatch(calls[0].prompt, /PRIVATE_REVIEW_CONTEXT/);
    const evidence = calls.slice(1).filter((c) => c.sid == null).map((c) => c.prompt.split('\n').find((line) => line.includes('"kind":"web_source"')));
    assert.ok(evidence.every((line) => line && line === evidence[0]));
    assert.ok(calls.slice(1).every((c) => !c.opts.research && c.sid !== 'research-thread'));
    assert.equal(state.research.status, 'done');
    assert.equal(rollup(rows).bySeat.research.usage.input, 10);
    const rb = rebuildDebate(rows);
    assert.deepEqual(rb.research.sources, state.research.sources);
    assert.ok(rb.events.some((e) => e.type === 'research' && e.status === 'done'));
    const recoveredCalls = [];
    await createDebate({ fieldNotes: rb.fieldNotes, seats: rb.seats, chairman: rb.chairman, options: rb.options, resume: rb, synthesisOnly: true,
      runner: scripted(recoveredCalls) }).run();
    assert.equal(recoveredCalls.length, 1);
    assert.ok(recoveredCalls[0].prompt.includes(sources[0].url));
    assert.equal(recoveredCalls[0].opts.research, undefined);
    const beforeRound = rebuildDebate(rows.slice(0, rows.findIndex((r) => r.type === 'research' && r.status === 'done') + 1)), continued = [];
    await createDebate({ fieldNotes: beforeRound.fieldNotes, seats: beforeRound.seats, options: beforeRound.options, resume: beforeRound,
      runner: scripted(continued) }).run();
    assert.ok(continued.length > 1 && continued.every((c) => !c.opts.research));
    assert.ok(continued.filter((c) => !c.sid).every((c) => c.prompt.includes(sources[0].url)));
    const md = decisionRecord(rows, 'synthetic-research').markdown;
    assert.ok(md.includes(sources[0].url));
    assert.match(md, /not independently verified/);
  }
});

test('an invalid saved research bundle blocks manual synthesis instead of dropping the evidence', async () => {
  const rows = [];
  await createDebate({ ...body(), runner: scripted([]), store: { append: (r) => rows.push(r) } }).run();
  const corrupted = rows.map((r) => r.type === 'research' && r.status === 'done' ? { ...r, sources: [{ ...sources[0], url: 'file:///private' }] } : r);
  const rb = rebuildDebate(corrupted), calls = [];
  assert.equal(rb.research.status, 'failed');
  const state = await createDebate({ fieldNotes: rb.fieldNotes, seats: rb.seats, options: rb.options, resume: rb, synthesisOnly: true,
    runner: scripted(calls) }).run();
  assert.equal(calls.length, 0);
  assert.equal(state.verdict.skipped, true);
  assert.equal(state.verdict.reason, 'research');
});

test('failed, unknown-cost or interrupted research cannot silently start or repeat discussion', async () => {
  for (const reason of ['network', 'bad-json', 'no-search', 'policy', 'unknown-usage']) {
    const rows = [], calls = [];
    const state = await createDebate({ ...body(), options: { ...body().options, budget: { codex: { tokens: 1000000 } } }, store: { append: (r) => rows.push(r) },
      runner: async (vendor, prompt, sid, opts) => {
        calls.push(opts.seat.id);
        if (reason === 'network') throw Object.assign(new Error('offline fixture'), { kind: 'network', usage });
        return { text: reason === 'bad-json' ? 'bad JSON' : sourceText, usage: reason === 'unknown-usage' ? null : usage,
          usedTools: reason === 'policy', research: { searches: reason === 'no-search' ? 0 : 1 } };
      } }).run();
    assert.deepEqual(calls, ['research'], reason);
    assert.equal(state.rounds.length, 0, reason);
    assert.equal(state.stopReason, reason === 'unknown-usage' ? 'budget' : 'research-failed');
    const interrupted = rows.filter((r) => ['field-notes', 'research-start', 'attempt-start'].includes(r.type));
    const rb = rebuildDebate(interrupted), resumedCalls = [];
    const recovered = await createDebate({ fieldNotes: rb.fieldNotes, seats: rb.seats, options: rb.options, resume: rb, runner: scripted(resumedCalls) }).run();
    assert.equal(resumedCalls.length, 0);
    assert.equal(recovered.stopReason, 'research-failed');
    assert.match(recovered.research.error, /not rerun/);
  }
});

test('the searcher runs on its own model, effort and login profile, never a seat\'s', async () => {
  const own = { ...settings, model: 'gpt-6-luna', effort: 'low', account: 'work' };
  assert.deepEqual(researchSettings(own), { vendor: 'codex', query: settings.query, maxSearches: 2, timeoutMs: 30000, model: 'gpt-6-luna', effort: 'low', account: 'work' });
  assert.equal(researchSettings({ ...settings, model: '' }).model, undefined); // "default": the CLI's own model
  assert.throws(() => researchSettings({ ...settings, model: 42 }), /Research: searcher model/);
  const codexSeat = { id: 'seat-1', vendor: 'codex', lens: 'cost', model: 'gpt-6-astra', effort: 'xhigh', account: 'personal' };
  const calls = [];
  await createDebate({ fieldNotes, seats: [seats[0], codexSeat], options: { research: own, critiqueRounds: 0, unattended: true }, runner: scripted(calls), store: { append() {} } }).run();
  const search = calls.find((c) => c.opts.research);
  assert.deepEqual([search.opts.model, search.opts.effort, search.opts.seat.account], ['gpt-6-luna', 'low', 'work']);
  assert.equal(search.opts.seat.label, 'Searcher');
  const p = project({ seats: [seats[0], codexSeat], chairman: { vendor: 'claude' }, critiqueRounds: 0, research: own });
  assert.equal(p.bySeat.research.model, 'gpt-6-luna');
});

test('the searcher runs on the vendor chosen for it, and its call and estimate go to that pool', async () => {
  const calls = [];
  const claudeSearcher = { ...settings, vendor: 'claude', model: 'claude-haiku-4-5' };
  await createDebate({ fieldNotes, seats, options: { research: claudeSearcher, critiqueRounds: 0, unattended: true }, runner: scripted(calls), store: { append() {} } }).run();
  const search = calls.find((c) => c.opts.research);
  assert.deepEqual([search.vendor, search.opts.seat.vendor, search.opts.model], ['claude', 'claude', 'claude-haiku-4-5']);
  const p = project({ seats, chairman: { vendor: 'codex' }, critiqueRounds: 0, research: claudeSearcher });
  assert.ok(p.byVendor.claude.seats.includes('research'));
  assert.ok(!p.byVendor.codex.seats.includes('research'));
});

// Shapes from Claude CLI 2.1.292 and agy 1.4.11 searching once (stream-json), trimmed.
const claudeSearchEvent = (id, name = 'WebSearch') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { query: 'synthetic public query' } }] } });
const agyStep = (index, name, state = 'DONE') => JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'C1', step_index: index, state, step_type: 'tool', tool_name: name, tool_info: { name, parameters: { query: 'synthetic public query' } } } });
const searchModels = (n) => JSON.stringify({ modelUsage: {
  'claude-haiku-4-5': { inputTokens: 18, outputTokens: 619, cacheReadInputTokens: 10562, cacheCreationInputTokens: 3167, webSearchRequests: 0, thinkingTokens: 484 },
  'claude-haiku-4-5-20251001': { inputTokens: 10190, outputTokens: 143, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: n, thinkingTokens: 0 } } });

test('a Claude searcher may call WebSearch only, counts its own searches and includes the search model\'s tokens', async () => {
  const bin = { file: process.execPath, prefix: [path.resolve('test/fixtures/fake-cli.mjs')] };
  const run = makeAdapter('claude', { bin });
  const claude = { ...settings, vendor: 'claude' };
  try {
    process.env.FAKE_SHAPE = 'claude'; process.env.FAKE_TEXT = sourceText;
    process.env.FAKE_PRELUDE = claudeSearchEvent('toolu_1') + '\n';
    process.env.FAKE_RESULT = searchModels(1);
    const result = await run(researchPrompt(claude), null, { research: claude });
    assert.equal(result.research.searches, 1);
    const args = result.raw.args, i = args.indexOf('--tools');
    assert.deepEqual(args.slice(i, i + 6), ['--tools', 'WebSearch', '--allowedTools', 'WebSearch', '--disallowedTools', 'mcp__*']);
    assert.ok(args.includes('--strict-mcp-config') && args.includes('--safe-mode'));
    assert.equal(result.usage.input, 18 + 10190, 'the search model\'s input is counted');
    assert.equal(result.usage.output, 619 + 143);
    delete process.env.FAKE_RESULT;
    await assert.rejects(run('ordinary debate'), (e) => e.code === 'TOOL_POLICY'); // a seat may not search
    await assert.rejects(makeAdapter('codex', { bin })('q', null, { research: claude }), (e) => e.code === 'RESEARCH_INVALID');
    process.env.FAKE_RESULT = searchModels(3); // one WebSearch call that ran three searches
    await assert.rejects(run('q', null, { research: claude }), (e) => e.code === 'RESEARCH_LIMIT' && e.research.searches === 3);
    delete process.env.FAKE_RESULT;
    process.env.FAKE_SLEEP = '10000';
    for (const [prelude, code] of [[claudeSearchEvent('toolu_2', 'Bash'), 'TOOL_POLICY'], [['a', 'b', 'c'].map((id) => claudeSearchEvent(id)).join('\n'), 'RESEARCH_LIMIT']]) {
      process.env.FAKE_PRELUDE = prelude + '\n';
      await assert.rejects(run('q', null, { research: claude, timeoutMs: 3000 }), (e) => e.code === code);
    }
  } finally { for (const k of ['FAKE_SHAPE', 'FAKE_TEXT', 'FAKE_PRELUDE', 'FAKE_SLEEP', 'FAKE_RESULT']) delete process.env[k]; }
  assert.equal(ADAPTERS.claude.research.foreignTool([{ type: 'result', num_turns: 4, permission_denials: [] }]), false, 'searches take turns');
  assert.equal(ADAPTERS.claude.research.foreignTool([{ type: 'result', permission_denials: [{ tool_name: 'Read' }] }]), true, 'a denied tool is still an attempt');
  assert.throws(() => ADAPTERS.claude.research.args(['-p', '--tools', 'Read']), (e) => e.code === 'RESEARCH_INVALID');
});

test('an Antigravity searcher may use search_web only, each step counted once, and needs consent', async () => {
  const bin = { file: process.execPath, prefix: [path.resolve('test/fixtures/fake-cli.mjs')] };
  const run = makeAdapter('agy', { bin });
  const agy = { ...settings, vendor: 'agy' };
  const consent = { research: agy, allowLimitedIsolation: true };
  try {
    process.env.FAKE_SHAPE = 'agy'; process.env.FAKE_TEXT = sourceText;
    process.env.FAKE_PRELUDE = [agyStep(2, 'search_web', 'ACTIVE'), agyStep(2, 'search_web')].join('\n') + '\n';
    const result = await run(researchPrompt(agy), null, consent);
    assert.equal(result.research.searches, 1);
    assert.equal(result.usedTools, false);
    await assert.rejects(run('q', null, { research: agy }), (e) => e.code === 'ISOLATION_REQUIRED');
    await assert.rejects(run('ordinary debate', null, { allowLimitedIsolation: true }), (e) => e.code === 'TOOL_POLICY'); // a seat's search is a tool
    process.env.FAKE_SLEEP = '10000';
    for (const [prelude, code] of [
      [agyStep(2, 'view_file', 'ACTIVE'), 'TOOL_POLICY'],
      [JSON.stringify({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool' } }), 'TOOL_POLICY'], // a tool without a name is not a search
      [JSON.stringify({ event: 'step_update', step_update: { step_index: 2, subagent_info: { id: 'x' } } }), 'TOOL_POLICY'],
      [[2, 3, 4].map((i) => agyStep(i, 'search_web', 'ACTIVE')).join('\n'), 'RESEARCH_LIMIT'],
    ]) {
      process.env.FAKE_PRELUDE = prelude + '\n';
      await assert.rejects(run('q', null, { ...consent, timeoutMs: 3000 }), (e) => e.code === code);
    }
  } finally { for (const k of ['FAKE_SHAPE', 'FAKE_TEXT', 'FAKE_PRELUDE', 'FAKE_SLEEP']) delete process.env[k]; }
});
