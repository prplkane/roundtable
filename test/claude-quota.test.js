// Claude quota: `claude -p /usage` as the CLI answers it (a local command: no turn, no tokens),
// the latch that stops the read when an answer is not shown free, and the limit lines it keeps.
// No CLI is spawned: the reader gets an injected runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeUsage, claudeResetAt, claudeReadWasFree, claudeQuotaReader, CLAUDE_USAGE_ARGS } from '../src/adapters/quota.js';
import { quotaReaders } from '../src/adapters/index.js';
import { ADAPTERS } from '../src/adapters/config.js';

const secs = (...utc) => Date.UTC(...utc) / 1000;
const NOW = Date.UTC(2026, 10, 1, 20, 0); // Nov 1, 21:00 in Berlin (CET, UTC+1)
// The shape CLI 2.1.292 printed; the activity section is synthetic, the zone a neutral one.
const RESULT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 53% used · resets Nov 2, 4:59am (Europe/Berlin)',
  'Current week (all models): 57% used · resets Nov 2, 8:59pm (Europe/Berlin)',
  'Current week (Fable): 75% used · resets Nov 2, 8:59pm (Europe/Berlin)',
  '',
  "What's contributing to your limits usage?",
  'Last 24h · 12 requests · 2 sessions',
  '  91% of your usage was at >150k context',
  '  Top skills: /SYNTHETIC-SKILL 8%',
  '  Top MCP servers: SYNTHETIC-MCP 3%',
].join('\n');
const ANSWER = { type: 'result', subtype: 'success', is_error: false, num_turns: 0, total_cost_usd: 0, local_command: 'usage', modelUsage: {},
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: 'standard' }, result: RESULT, session_id: 'SYNTHETIC' };

test('the captured /usage answer was free: a local command with no turn, tokens or cost', () => {
  assert.equal(claudeReadWasFree(ANSWER), true);
  assert.equal(claudeReadWasFree({ ...ANSWER, num_turns: 1 }), false, 'a turn');
  assert.equal(claudeReadWasFree({ ...ANSWER, usage: { ...ANSWER.usage, input_tokens: 14000 } }), false, 'tokens');
  assert.equal(claudeReadWasFree({ ...ANSWER, usage: { ...ANSWER.usage, cache_read_input_tokens: 9 } }), false, 'cached tokens');
  assert.equal(claudeReadWasFree({ ...ANSWER, total_cost_usd: 0.002 }), false, 'a cost');
  assert.equal(claudeReadWasFree({ ...ANSWER, local_command: undefined }), false, 'not marked as a local command');
  assert.equal(claudeReadWasFree({ ...ANSWER, num_turns: undefined }), false, 'no turn count to judge by');
  assert.equal(claudeReadWasFree(null), false);
});

test('claudeUsage keeps the limit lines only, labelled as the reply labels them, with the per-model week beside them', () => {
  const q = claudeUsage(RESULT, NOW);
  assert.deepEqual(q.windows.map((w) => [w.label, w.used]), [['5h', 0.53], ['7d', 0.57], ['7d Fable', 0.75]]);
  assert.deepEqual(q.windows.map((w) => w.resetsAt), [secs(2026, 10, 2, 3, 59), secs(2026, 10, 2, 19, 59), secs(2026, 10, 2, 19, 59)]);
  assert.equal(q.plan, null);
  assert.equal(q.at, NOW);
  assert.doesNotMatch(JSON.stringify(claudeUsage(RESULT)), /SYNTHETIC|context|requests|skills/i, 'nothing of the activity summary is kept');
  assert.equal(claudeUsage('Current session: unavailable\nYou are using an API key.'), null, 'no limit lines: no figure');
  assert.equal(claudeUsage(''), null);
  // a line without a reset time still counts; a repeated label keeps the first
  assert.deepEqual(claudeUsage('Current session: 100% used\nCurrent session: 5% used').windows, [{ label: '5h', used: 1, resetsAt: null }]);
});

test('claudeResetAt: a wall-clock time in a named zone, the next such moment, across years and daylight saving', () => {
  assert.equal(claudeResetAt('Nov 2, 4:59am (Europe/Berlin)', NOW), secs(2026, 10, 2, 3, 59), 'CET is UTC+1');
  assert.equal(claudeResetAt('Nov 2, 8:59pm (Europe/Berlin)', NOW), secs(2026, 10, 2, 19, 59));
  assert.equal(claudeResetAt('Nov 2, 12:15am (UTC)', NOW), secs(2026, 10, 2, 0, 15), '12am is midnight');
  assert.equal(claudeResetAt('Nov 2, 12:15pm (UTC)', NOW), secs(2026, 10, 2, 12, 15), '12pm is noon');
  assert.equal(claudeResetAt('11:30pm (Europe/Berlin)', NOW), secs(2026, 10, 1, 22, 30), 'no date: later today');
  assert.equal(claudeResetAt('4am (Europe/Berlin)', NOW), secs(2026, 10, 2, 3, 0), 'no date, already past: tomorrow');
  assert.equal(claudeResetAt('Jan 1, 9:00am (UTC)', Date.UTC(2026, 11, 31, 12)), secs(2027, 0, 1, 9, 0), 'no year: the next January');
  assert.equal(claudeResetAt('Nov 1, 7:00pm (UTC)', NOW), secs(2026, 10, 1, 19, 0), 'a dated reset an hour past is a late display, not next year');
  assert.equal(claudeResetAt('Jul 1, 9:00am (America/New_York)', Date.UTC(2026, 5, 15)), secs(2026, 6, 1, 13, 0), 'EDT is UTC-4');
  assert.equal(claudeResetAt('Jan 5, 9:00am (America/New_York)', Date.UTC(2026, 0, 2)), secs(2026, 0, 5, 14, 0), 'EST is UTC-5');
  for (const bad of ['Nov 2, 4:59am (Mars/Olympus)', 'soon', 'Nov 2, 13:00pm (UTC)', 'Foo 2, 4:59am (UTC)', ''])
    assert.equal(claudeResetAt(bad, NOW), null, JSON.stringify(bad));
});

test('the reader runs the seats\' lockdown with slash commands on, from an empty folder, in the cleaned environment', async () => {
  const calls = [];
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rt-claude-usage-'));
  const read = claudeQuotaReader({ cwd, resolve: () => ({ file: 'claude', prefix: [] }), warn: () => {},
    run: async (bin, args, opts) => { calls.push({ args, opts }); return { stdout: JSON.stringify(ANSWER) + '\n', code: 0 }; } });
  const saved = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, billing: process.env.ROUNDTABLE_API_BILLING };
  Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_API_KEY: 'test-key' });
  delete process.env.ROUNDTABLE_API_BILLING;
  let q;
  try { q = await read({ home: path.join(cwd, 'profile') }); } finally {
    for (const [k, v] of Object.entries({ CLAUDECODE: saved.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: saved.CLAUDE_CODE_ENTRYPOINT, ANTHROPIC_API_KEY: saved.ANTHROPIC_API_KEY, ROUNDTABLE_API_BILLING: saved.billing }))
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  assert.deepEqual(q.windows.map((w) => w.label), ['5h', '7d', '7d Fable']);
  const { args, opts } = calls[0];
  assert.deepEqual(args, CLAUDE_USAGE_ARGS);
  assert.deepEqual(args.slice(0, 2), ['-p', '/usage']);
  assert.ok(!args.includes('--disable-slash-commands'), 'the read needs /usage expanded');
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--tools') + 1], '', 'no tools');
  assert.equal(opts.cwd, cwd);
  assert.equal(opts.env.CLAUDE_CONFIG_DIR, path.join(cwd, 'profile'), 'a named profile reads its own limits');
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined, 'a key in the shell does not move the read to API billing');
  for (const k of Object.keys(opts.env)) assert.doesNotMatch(k, /^(CLAUDECODE|CLAUDE_CODE_)/, 'another agent CLI\'s variables change how slash commands are treated');
  assert.equal(read.stopped(), null);
});

test('the reader stops itself on an answer that is not shown free, and on a timeout', async () => {
  const resolve = () => ({ file: 'claude', prefix: [] }), cwd = mkdtempSync(path.join(os.tmpdir(), 'rt-claude-usage-'));
  let runs = 0;
  const warned = [];
  const spent = { ...ANSWER, num_turns: 1, local_command: undefined, total_cost_usd: 0.001, usage: { ...ANSWER.usage, input_tokens: 9000, output_tokens: 40 } };
  const read = claudeQuotaReader({ cwd, resolve, warn: (m) => warned.push(m), run: async () => { runs++; return { stdout: JSON.stringify(spent), code: 0 }; } });
  assert.equal(await read(), null);
  assert.equal(await read(), null);
  assert.equal(runs, 1, 'one stray call at most, never one per reply');
  assert.match(read.stopped(), /did not answer as a local command/);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /Claude quota reads are off until the server restarts/);

  const slow = claudeQuotaReader({ cwd, resolve, warn: () => {}, run: async () => { throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' }); } });
  assert.equal(await slow({ timeoutMs: 5 }), null);
  assert.match(slow.stopped(), /no answer within 5 ms/);

  const garbled = claudeQuotaReader({ cwd, resolve, warn: () => {}, run: async () => ({ stdout: 'Loading...\n', code: 0 }) });
  assert.equal(await garbled(), null);
  assert.match(garbled.stopped(), /no JSON answer/);
});

test('a proven-free /usage answer without limits allows the next normal read to recover', async () => {
  const resolve = () => ({ file: 'claude', prefix: [] }), cwd = mkdtempSync(path.join(os.tmpdir(), 'rt-claude-usage-'));
  for (const result of ['Current session: unavailable', 'You are using an API key; no plan limits apply.', '']) {
    let runs = 0;
    const read = claudeQuotaReader({ cwd, resolve, warn: () => assert.fail('a free empty result must not disable quota reads'),
      run: async () => ({ stdout: `notice\n${JSON.stringify(++runs === 1 ? { ...ANSWER, result } : ANSWER)}\n`, code: 0 }) });
    assert.equal(await read(), null, 'missing limits are unknown, not zero');
    assert.equal(read.stopped(), null);
    assert.equal(runs, 1, 'no automatic retry');
    assert.deepEqual((await read()).windows.map((w) => [w.label, w.used]), [['5h', 0.53], ['7d', 0.57], ['7d Fable', 0.75]]);
    assert.equal(runs, 2, 'a later refresh succeeds without restarting the reader');
    assert.equal(read.stopped(), null);
  }
  // an error answer is no figure this time; the next read may work
  const failed = claudeQuotaReader({ cwd, resolve, warn: () => {}, run: async () => ({ stdout: JSON.stringify({ ...ANSWER, is_error: true, result: 'Could not fetch usage' }), code: 0 }) });
  assert.equal(await failed(), null);
  assert.equal(failed.stopped(), null);
  const missing = claudeQuotaReader({ cwd, resolve: () => { throw new Error('claude not found'); }, run: async () => assert.fail('no spawn without a binary'), warn: () => {} });
  assert.equal(await missing(), null);
  assert.equal(missing.stopped(), null);
});

test('Claude\'s quota is a separate read, registered beside codex and agy', () => {
  assert.equal(ADAPTERS.claude.quota, 'command');
  assert.equal(typeof quotaReaders.claude, 'function');
  assert.deepEqual(Object.keys(quotaReaders).sort(), ['agy', 'claude', 'codex']);
});
