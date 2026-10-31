import test from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, ARGV_LIMIT, CODEX_NO_TOOLS } from '../src/adapters/config.js';
import { buildArgs, pickJson, pickJsonl, makeAdapter, detectToolUse } from '../src/adapters/common.js';
import { claudeQuota, codexQuota } from '../src/adapters/quota.js';
import { cleanEnv, profileHome, runProcess, killAll, liveChildren } from '../src/adapters/spawn.js';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('claude: fresh call on stdin, resume appends --resume', () => {
  const fresh = buildArgs(ADAPTERS.claude, { prompt: 'hi' });
  assert.deepEqual(fresh.args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--tools', '', '--disallowedTools', 'mcp__*', '--disable-slash-commands', '--setting-sources', 'local', '--strict-mcp-config', '--safe-mode', '--permission-prompts', 'none']);
  assert.equal(fresh.stdin, 'hi');
  const res = buildArgs(ADAPTERS.claude, { prompt: 'hi', sessionId: 'S1', model: 'opus' });
  assert.deepEqual(res.args.slice(-4), ['--resume', 'S1', '--model', 'opus']);
});

test('codex: resume replaces the subcommand and keeps the trailing "-" last', () => {
  const fresh = buildArgs(ADAPTERS.codex, { prompt: 'hi', model: 'gpt-x' });
  assert.deepEqual(fresh.args, ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--strict-config', '-c', 'project_doc_max_bytes=0', ...CODEX_NO_TOOLS, '-m', 'gpt-x', '-']);
  const res = buildArgs(ADAPTERS.codex, { prompt: 'hi', sessionId: 'T1' });
  assert.equal(res.args.filter((a) => a === 'exec').length, 1, 'exec must appear once');
  assert.deepEqual(res.args.slice(0, 3), ['exec', 'resume', 'T1']);
  assert.equal(res.args.at(-1), '-');
  assert.ok(!res.args.includes('--sandbox'), 'resume does not accept --sandbox');
  assert.ok(res.args.includes('sandbox_mode="read-only"'));
  assert.ok(res.args.includes('project_doc_max_bytes=0'), 'AGENTS.md stays out on resume too');
  for (const flag of CODEX_NO_TOOLS) assert.ok(res.args.includes(flag), `resume keeps ${flag}`);
  assert.equal(res.stdin, 'hi');
});

test('restriction flags: every adapter sends its tool restrictions on fresh calls and resumes', () => {
  const all = (vendor, sessionId) => buildArgs(ADAPTERS[vendor], { prompt: 'hi', sessionId }).args;
  for (const sid of [undefined, 'S1']) {
    const c = all('claude', sid);
    assert.deepEqual(c.slice(c.indexOf('--tools'), c.indexOf('--tools') + 2), ['--tools', ''], 'claude: empty built-in tool list');
    assert.deepEqual(c.slice(c.indexOf('--disallowedTools'), c.indexOf('--disallowedTools') + 2), ['--disallowedTools', 'mcp__*'], 'claude: --tools does not reach MCP tools');
    for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--safe-mode', '--permission-prompts']) assert.ok(c.includes(f), `claude ${f}`);
    assert.deepEqual(c.slice(c.indexOf('--permission-mode'), c.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan']);
    const x = all('codex', sid);
    for (const f of ['--ignore-user-config', '--ignore-rules', '--strict-config']) assert.ok(x.includes(f), `codex ${f}`);
    for (const f of ['mcp_servers={}', 'web_search="disabled"', 'features.shell_tool=false', 'features.unified_exec=false', 'features.apps=false']) assert.ok(x.includes(f), `codex ${f}`);
    const a = all('agy', sid);
    assert.deepEqual(a.slice(a.indexOf('--mode'), a.indexOf('--mode') + 2), ['--mode', 'plan']);
    assert.ok(a.includes('--disable-slash-commands'));
    const settings = JSON.parse(a[a.indexOf('--settings') + 1]);
    assert.equal(settings.toolPermission, 'strict');
    assert.deepEqual(settings.permissions.deny, ['read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'command(*)', 'mcp(*)']);
  }
});

test('agy: every prompt uses stream-json stdin and resume adds --conversation', () => {
  const fresh = buildArgs(ADAPTERS.agy, { prompt: 'hi' });
  assert.ok(!fresh.args.some((a) => a.includes('hi')));
  assert.equal(JSON.parse(fresh.stdin).message.content, 'hi');
  const long = buildArgs(ADAPTERS.agy, { prompt: 'x'.repeat(ARGV_LIMIT + 1), sessionId: 'C1' });
  assert.equal(long.streamMode, true);
  assert.ok(long.args.includes('stream-json'));
  assert.deepEqual(long.args.slice(-2), ['--conversation', 'C1']);
  assert.match(long.stdin, /^\{"event":"user"/);
  assert.ok(!long.args.some((a) => a.startsWith('-p=')));
});

test('pickJson reads the agy shape', () => {
  const p = pickJson({ response: 'pong', conversation_id: 'C', usage: { input_tokens: 2, cache_read_tokens: 10, output_tokens: 4, thinking_tokens: 1 } }, ADAPTERS.agy.paths);
  assert.deepEqual(p, { text: 'pong', sessionId: 'C', usage: { input: 2, cacheRead: 10, cacheWrite: 0, output: 4, thinking: 1 }, cost: null, quota: null, isError: false });
});

test('CLI parsers distinguish unknown token counters from measured zeros', () => {
  for (const usage of [undefined, {}, { input_tokens: 2 }, { input_tokens: '2', output_tokens: 4 },
    { input_tokens: 2, output_tokens: -1 }, { input_tokens: 2, output_tokens: Infinity },
    { input_tokens: 2, output_tokens: 4, cache_read_tokens: -1, cache_read_input_tokens: -1 }]) {
    assert.equal(pickJson({ usage }, ADAPTERS.agy.paths).usage, null);
    assert.equal(pickJsonl(JSON.stringify({ type: 'result', usage }), ADAPTERS.claude.paths).usage, null);
  }
  assert.equal(pickJson({ usage: { input_tokens: 0, output_tokens: 0 } }, ADAPTERS.agy.paths).usage.input, 0);
  assert.equal(pickJsonl('{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}', ADAPTERS.codex.paths).usage.output, 0);
});

test('CLI adapters preserve unknown usage and known costs, including error results and resumed cost deltas', async () => {
  const fixture = path.resolve('test/fixtures/fake-cli.mjs');
  try {
    for (const name of ['claude', 'codex', 'agy']) {
      process.env.FAKE_SHAPE = name;
      const run = makeAdapter(name, { bin: { file: process.execPath, prefix: [fixture] } });
      for (const mode of ['missing', 'empty', 'partial', 'zero']) {
        process.env.FAKE_USAGE = mode;
        const r = await run('hello', null, { timeoutMs: 20_000, allowLimitedIsolation: true });
        if (mode === 'zero') assert.equal(r.usage.input, 0, name);
        else {
          assert.equal(r.usage, null, `${name}: ${mode}`);
          assert.equal(r.cost, name === 'claude' ? 0.01 : null);
        }
      }
      if (name === 'claude') {
        process.env.FAKE_USAGE = 'missing';
        const resumed = await run('again', 'S1', { prevCost: 0.004, timeoutMs: 20_000 });
        assert.equal(resumed.rawCost, 0.01);
        assert.equal(resumed.cost, 0.006);
        process.env.FAKE_IS_ERROR = '1';
        await assert.rejects(run('error', 'S1', { prevCost: 0.004, timeoutMs: 20_000 }), (e) => e.usage === null && e.cost === 0.006 && e.rawCost === 0.01);
        delete process.env.FAKE_IS_ERROR;
      }
    }
  } finally {
    for (const key of ['FAKE_SHAPE', 'FAKE_USAGE', 'FAKE_IS_ERROR']) delete process.env[key];
  }
});

test('pickJsonl reads the claude stream: result line plus the rate_limit_event', () => {
  // Shapes as the CLIs print them (values trimmed).
  const lines = [
    '{"type":"system","subtype":"init","session_id":"S"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"pong"}]},"session_id":"S"}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792087800,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.06,"resetsAt":1792087800},"seven_day":{"utilization":0.2,"resetsAt":1792422000},"seven_day_overage_included":{"utilization":0.15,"resetsAt":1792422000},"new_window":{"utilization":0.5}}},"session_id":"S"}',
    '{"type":"result","subtype":"success","result":"pong","session_id":"S","total_cost_usd":0.5,"usage":{"input_tokens":2,"cache_read_input_tokens":10,"cache_creation_input_tokens":20,"output_tokens":4,"output_tokens_details":{"thinking_tokens":1}}}',
  ].join('\n');
  const p = pickJsonl(lines, ADAPTERS.claude.paths);
  assert.equal(p.text, 'pong');
  assert.equal(p.sessionId, 'S');
  assert.deepEqual(p.usage, { input: 2, cacheRead: 10, cacheWrite: 20, output: 4, thinking: 1 });
  assert.equal(p.cost, 0.5);
  assert.deepEqual(claudeQuota(p.quota, 1000), {
    windows: [{ label: '5h', used: 0.06, resetsAt: 1792087800 }, { label: '7d', used: 0.2, resetsAt: 1792422000 },
      { label: '7d incl. overage', used: 0.15, resetsAt: 1792422000 }, { label: 'new window', used: 0.5, resetsAt: null }],
    plan: null, at: 1000,
  });
  assert.equal(claudeQuota(null), null, 'a reply without the event has no quota');
});

test('codexQuota normalises account/rateLimits/read, labelling windows by duration', () => {
  const r = { rateLimits: { limitId: 'codex', primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1792649664 }, secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1792100000 }, planType: 'prolite' } };
  assert.deepEqual(codexQuota(r, 1000), {
    windows: [{ label: '7d', used: 0.03, resetsAt: 1792649664 }, { label: '5h', used: 0.4, resetsAt: 1792100000 }],
    plan: 'prolite', at: 1000,
  });
  assert.equal(codexQuota({ rateLimits: { primary: null, secondary: null } }), null);
  assert.equal(codexQuota({}), null);
});

test('every CLI vendor has a usage page for the strip fallback; the API vendor has none (its billing is the endpoint\'s)', () => {
  for (const [name, a] of Object.entries(ADAPTERS)) {
    if (a.kind === 'api') { assert.equal(a.usageUrl, null, name); continue; }
    assert.match(a.usageUrl, /^https:\/\//, name);
  }
});

test('pickJsonl reads the codex event stream, last agent_message wins', () => {
  const lines = [
    '{"type":"thread.started","thread_id":"T"}',
    '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"cache_write_input_tokens":0,"output_tokens":9,"reasoning_output_tokens":3}}',
  ].join('\n');
  const p = pickJsonl(lines, ADAPTERS.codex.paths);
  assert.equal(p.text, 'final');
  assert.equal(p.sessionId, 'T');
  assert.deepEqual(p.usage, { input: 100, cacheRead: 40, cacheWrite: 0, output: 9, thinking: 3 });
  assert.equal(p.cost, null);
});

test('effort: each vendor spells it its own way; agy skips it when the model id carries the level', () => {
  assert.deepEqual(buildArgs(ADAPTERS.claude, { prompt: 'hi', effort: 'high' }).args.slice(-2), ['--effort', 'high']);
  const codex = buildArgs(ADAPTERS.codex, { prompt: 'hi', model: 'gpt-6.1-sol', effort: 'xhigh' }).args;
  assert.deepEqual(codex.slice(-5), ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"', '-'], 'one argv element, TOML-quoted, before the trailing "-"');
  for (const [name, a] of Object.entries(ADAPTERS)) assert.ok(a.isolation, `${name} states its isolation`);
  const codexResume = buildArgs(ADAPTERS.codex, { prompt: 'hi', sessionId: 'T', effort: 'low' }).args;
  assert.ok(codexResume.includes('model_reasoning_effort="low"') && codexResume.at(-1) === '-');
  const agyPlain = buildArgs(ADAPTERS.agy, { prompt: 'hi', model: 'gemini-4-argon', effort: 'low' }).args;
  assert.ok(agyPlain.includes('--effort') && agyPlain.includes('low'));
  const agySuffixed = buildArgs(ADAPTERS.agy, { prompt: 'hi', model: 'gemini-4-argon-high', effort: 'low' }).args;
  assert.ok(!agySuffixed.includes('--effort'), 'the id already says high; do not also say low');
  assert.ok(agySuffixed.includes('gemini-4-argon-high'));
  const agyNoModel = buildArgs(ADAPTERS.agy, { prompt: 'hi', effort: 'medium' }).args;
  assert.deepEqual(agyNoModel.slice(-2), ['--effort', 'medium']);
});

test('profile homes live under the OS user-data dir, one per profile name, per vendor', () => {
  const h = '/home/u';
  assert.equal(profileHome('claude', 'work', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, homedir: h }), 'C:\\Users\\u\\AppData\\Local\\roundtable\\homes\\work\\claude');
  assert.equal(profileHome('codex', 'work', { platform: 'darwin', env: {}, homedir: h }), '/home/u/Library/Application Support/roundtable/homes/work/codex');
  assert.equal(profileHome('codex', 'alt', { platform: 'linux', env: {}, homedir: h }), '/home/u/.local/share/roundtable/homes/alt/codex');
  assert.equal(profileHome('codex', 'alt', { platform: 'linux', env: { XDG_DATA_HOME: '/data' }, homedir: h }), '/data/roundtable/homes/alt/codex');
  assert.throws(() => profileHome('claude', '../x', { platform: 'linux', env: {}, homedir: h }), /Profile name/);
  assert.throws(() => profileHome('claude', '', { platform: 'linux', env: {}, homedir: h }), /Profile name/);
  for (const [name, a] of Object.entries(ADAPTERS)) assert.ok(a.home === null || (a.home.env && !a.home.carry && !a.home.from), `${name}: a home is only an environment variable, nothing is copied`);
});

test('a profile home is created empty and no credential file is ever read or copied', async () => {
  // A fake real home with credential files whose content must never travel.
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'rt-real-home-'));
  mkdirSync(path.join(fakeHome, '.claude'));
  mkdirSync(path.join(fakeHome, '.codex'));
  writeFileSync(path.join(fakeHome, '.claude', '.credentials.json'), '{"secret":"SENTINEL-CLAUDE"}');
  writeFileSync(path.join(fakeHome, '.codex', 'auth.json'), '{"secret":"SENTINEL-CODEX"}');
  const home = path.join(fakeHome, 'profile-home', 'claude');
  const record = path.join(fakeHome, 'record.json');
  const fixture = path.resolve('test/fixtures/fake-cli.mjs');
  const run = makeAdapter('claude', { bin: { file: process.execPath, prefix: [fixture] } });
  process.env.FAKE_SHAPE = 'claude'; process.env.FAKE_RECORD = record; process.env.HOME = fakeHome; process.env.USERPROFILE = fakeHome;
  try {
    const r = await run('hello', null, { home, cwd: path.join(fakeHome, 'cwd'), timeoutMs: 20_000 });
    assert.equal(r.sessionId, 'S1');
    assert.match(r.text, /^STANCE:/);
    const rec = JSON.parse(readFileSync(record, 'utf8'));
    assert.equal(rec.env.CLAUDE_CONFIG_DIR, home, 'the CLI is pointed at the profile home');
    assert.equal(rec.env.MAX_THINKING_TOKENS, undefined, 'an ordinary seat keeps the CLI default thinking');
    await run('hello', null, { minimal: true, cwd: path.join(fakeHome, 'cwd'), timeoutMs: 20_000 });
    assert.equal(JSON.parse(readFileSync(record, 'utf8')).env.MAX_THINKING_TOKENS, '0', 'a minimal seat turns thinking off');
    assert.equal(rec.stdin, 'hello');
    assert.ok(existsSync(home), 'the home exists so the CLI can write its own login there');
    assert.deepEqual(readdirSync(home), [], 'and it is empty: nothing was seeded into it');
    const everywhere = [fakeHome, home, path.join(fakeHome, 'cwd')].flatMap((d) => readdirSync(d, { recursive: true }).map(String));
    assert.ok(!everywhere.some((f) => /profile-home.*(credentials|auth\.json)/.test(f)), 'no credential file under the profile home');
  } finally {
    delete process.env.FAKE_SHAPE; delete process.env.FAKE_RECORD;
  }
  // Nothing in the adapters or the server names a credential file or copies files at all.
  for (const f of ['src/adapters/spawn.js', 'src/adapters/common.js', 'src/adapters/config.js', 'src/adapters/catalogue.js', 'src/server.js', 'src/seats.js']) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /\.credentials\.json|auth\.json|copyFile/, `${f} must not touch credential files`);
  }
});

test('every vendor says its kind and declares effort levels and a pool for the strip; a CLI spells effort as argv', () => {
  for (const [name, a] of Object.entries(ADAPTERS)) {
    assert.ok(['cli', 'api'].includes(a.kind), `${name} kind`);
    assert.ok(Array.isArray(a.effortLevels) && a.effortLevels.length, name);
    // an endpoint has no argv; its effort goes in the request body
    if (a.kind === 'cli') assert.ok(typeof a.effort === 'function', name); else assert.equal(a.effort, null, name);
    assert.ok(a.pool, name);
  }
});

test('a call that overruns its timeout rejects with code TIMEOUT', async () => {
  process.env.FAKE_SLEEP = '5000';
  try {
    await assert.rejects(runProcess({ file: process.execPath, prefix: [path.resolve('test/fixtures/fake-cli.mjs')] }, [], { stdin: 'x', timeoutMs: 300 }), (e) => e.code === 'TIMEOUT' && /timed out/.test(e.message));
  } finally { delete process.env.FAKE_SLEEP; }
});

test('tool-use guard: each adapter rejects reported tools and accepts a plain reply', async () => {
  const fixture = path.resolve('test/fixtures/fake-cli.mjs');
  const bin = { file: process.execPath, prefix: [fixture] };
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'rt-tools-'));
  try {
    for (const name of ['claude', 'codex', 'agy']) {
      const run = makeAdapter(name, { bin });
      process.env.FAKE_SHAPE = name;
      delete process.env.FAKE_TOOLS;
      const plain = await run('hello', null, { cwd, timeoutMs: 20_000, allowLimitedIsolation: true });
      assert.equal(plain.usedTools, false, `${name}: a plain reply`);
      assert.match(plain.text, /^STANCE:/);
      process.env.FAKE_TOOLS = '1';
      await assert.rejects(run('hello', null, { cwd, timeoutMs: 20_000, allowLimitedIsolation: true }), (e) => e.code === 'TOOL_POLICY' && e.usedTools === true && !e.text);
    }
  } finally { delete process.env.FAKE_SHAPE; delete process.env.FAKE_TOOLS; }
  // the detectors on captured shapes
  assert.equal(detectToolUse('claude', '{"type":"result","result":"x","num_turns":1}'), false);
  assert.equal(detectToolUse('claude', '{"type":"result","result":"x","num_turns":3}'), true);
  assert.equal(detectToolUse('codex', '{"type":"item.completed","item":{"type":"agent_message","text":"x"}}\n{"type":"item.completed","item":{"type":"reasoning","text":"y"}}'), false);
  assert.equal(detectToolUse('codex', '{"type":"item.started","item":{"type":"command_execution","command":"ls"}}'), true);
  assert.equal(detectToolUse('agy', '{"response":"","num_turns":1,"denied_actions":[{"action":"run_command"}]}'), true, 'a denied tool is still an attempt');
  assert.equal(detectToolUse('agy', '{"response":"pong","num_turns":1}'), false);
  const step = (s) => JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'C1', step_index: 1, state: 'DONE', ...s } });
  const done = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'pong', num_turns: 1 } });
  assert.equal(detectToolUse('agy', [step({ step_type: 'agent_response', text_delta: 'pong' }), done].join('\n')), false);
  assert.equal(detectToolUse('agy', [step({ step_type: 'tool', tool_name: 'search_web', tool_info: { name: 'search_web' } }), done].join('\n')), true, 'one turn, but a search ran');
});

test('split tool events stop a hanging CLI before its timeout, including server tools and intermediate updates', async () => {
  const cases = [
    ['claude', { type: 'assistant', message: { content: [{ type: 'server_tool_use', name: 'web_search' }] } }],
    ['claude', { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'mcp_tool_use' } } }],
    ['codex', { type: 'item.updated', item: { type: 'command_execution' } }],
    ['agy', { event: 'step_update', tool_info: { name: 'read_file' } }],
    ['agy', { event: 'step_update', subagent_info: { id: 'test' } }],
    // agy 1.4.11 as it streams: the tool inside step_update, here the search no rule can deny
    ['agy', { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'search_web', tool_info: { name: 'search_web', parameters: { query: 'x' } } } }],
    ['agy', { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool' } }],
  ];
  try {
    for (const [name, event] of cases) {
      process.env.FAKE_SHAPE = name;
      process.env.FAKE_PRELUDE = JSON.stringify(event) + '\n';
      process.env.FAKE_SLEEP = '10000';
      const run = makeAdapter(name, { bin: { file: process.execPath, prefix: [path.resolve('test/fixtures/fake-cli.mjs')] } });
      await assert.rejects(run('synthetic question', null, { timeoutMs: 3000, allowLimitedIsolation: true }),
        (e) => e.code === 'TOOL_POLICY' && e.kind === 'policy' && e.usedTools && e.usage === null && !e.text);
    }
  } finally { for (const k of ['FAKE_SHAPE', 'FAKE_PRELUDE', 'FAKE_SLEEP']) delete process.env[k]; }
});

test('a truncated final event or unsuccessful exit cannot promote an earlier message to success', async () => {
  const answer = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial answer' } });
  for (const [tail, exitCode, expected] of [
    ['{"type":"item.started","item":{"type":"command_execution"', 1, 'PROVIDER_PROTOCOL'],
    [JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }), 0, 'TOOL_POLICY'],
    ['', 1, 'CLI_EXIT'],
    ['', 0, 'PROVIDER_PROTOCOL'],
  ]) {
    const script = `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(answer + '\n' + tail)}); process.exit(${exitCode}); });`;
    const run = makeAdapter('codex', { bin: { file: process.execPath, prefix: ['-e', script, '--'] } });
    await assert.rejects(run('q'), (e) => e.code === expected && !e.text && (expected === 'CLI_EXIT' || e.kind === 'policy'));
  }
  const completed = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 4 } });
  const output = `${answer}\n${completed}\n{"error":"network error"`;
  const script = `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(output)}));`;
  const run = makeAdapter('codex', { bin: { file: process.execPath, prefix: ['-e', script, '--'] } });
  await assert.rejects(run('q'), (e) => e.code === 'PROVIDER_PROTOCOL' && e.kind === 'policy' && e.usage?.input === 12 && !e.text);
});

test('limited isolation requires explicit opt-in and malformed or oversized output fails closed', async () => {
  const bin = { file: process.execPath, prefix: [path.resolve('test/fixtures/fake-cli.mjs')] };
  await assert.rejects(makeAdapter('agy', { bin })('q'), (e) => e.code === 'ISOLATION_REQUIRED' && e.kind === 'policy');
  process.env.FAKE_PRELUDE = '{broken event}\n';
  process.env.FAKE_SLEEP = '10000';
  try {
    await assert.rejects(makeAdapter('claude', { bin })('q', null, { timeoutMs: 3000 }), (e) => e.code === 'PROVIDER_PROTOCOL');
    await assert.rejects(runProcess({ file: process.execPath, prefix: [] }, ['-e', 'process.stdout.write("x".repeat(4096))'], { maxOutputBytes: 512 }), (e) => e.code === 'OUTPUT_LIMIT');
  } finally { delete process.env.FAKE_PRELUDE; delete process.env.FAKE_SLEEP; }
});

test('child registry: running CLIs are listed by tag, killAll(tag) kills only those and their calls reject with KILLED', async () => {
  const bin = { file: process.execPath, prefix: [path.resolve('test/fixtures/fake-cli.mjs')] };
  process.env.FAKE_SLEEP = '8000';
  try {
    const a = runProcess(bin, [], { stdin: 'x', timeoutMs: 20_000, tag: 'debate-a' });
    const b = runProcess(bin, [], { stdin: 'x', timeoutMs: 20_000, tag: 'debate-b' });
    const c = runProcess(bin, [], { stdin: 'x', timeoutMs: 20_000, tag: 'debate-a' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(liveChildren().length, 3);
    assert.deepEqual(liveChildren('debate-a').map((x) => x.tag), ['debate-a', 'debate-a']);
    assert.ok(liveChildren().every((x) => Number.isInteger(x.pid) && x.pid > 0));
    // a fake kill records which children were targeted, then the real one ends the processes
    const seen = [];
    const n = killAll('debate-a', { kill: (child) => { seen.push(child.pid); child.kill('SIGKILL'); } });
    assert.equal(n, 2);
    assert.equal(seen.length, 2);
    await assert.rejects(a, (e) => e.code === 'KILLED');
    await assert.rejects(c, (e) => e.code === 'KILLED');
    assert.deepEqual(liveChildren().map((x) => x.tag), ['debate-b'], 'the other debate is untouched');
    assert.equal(killAll(), 1, 'no tag: everything left');
    await assert.rejects(b, (e) => e.code === 'KILLED');
    assert.equal(liveChildren().length, 0);
  } finally { delete process.env.FAKE_SLEEP; }
  // a child that finishes on its own leaves the registry
  await runProcess(bin, [], { stdin: 'x', timeoutMs: 20_000, tag: 'quick' });
  assert.equal(liveChildren('quick').length, 0);
});

test('usage has one meaning: codex input excludes cached input, claude input stays as reported, raw numbers are kept', async () => {
  const { normaliseUsage } = await import('../src/adapters/common.js');
  const u = { input: 50, cacheRead: 10, cacheWrite: 0, output: 20, thinking: 2 };
  const codex = normaliseUsage(ADAPTERS.codex, u);
  assert.equal(codex.input, 40);
  assert.deepEqual(codex.raw, u);
  assert.equal(codex.usageVersion, 3);
  const claude = normaliseUsage(ADAPTERS.claude, { input: 2, cacheRead: 6637, cacheWrite: 100, output: 4, thinking: 0 }, 0.5);
  assert.equal(claude.input, 2);
  assert.equal(claude.raw.cost, 0.5);
  assert.equal(normaliseUsage(ADAPTERS.agy, u).input, 50, 'unknown semantics: left as reported');
  assert.equal(normaliseUsage(ADAPTERS.agy, u).cacheSemantics, 'unknown');
});

test('an error result from the CLI is a classified failure, not a reply, and keeps what it cost', async () => {
  const fixture = path.resolve('test/fixtures/fake-cli.mjs');
  const run = makeAdapter('claude', { bin: { file: process.execPath, prefix: [fixture] } });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rt-iserror-'));
  process.env.FAKE_SHAPE = 'claude'; process.env.FAKE_IS_ERROR = '1'; process.env.FAKE_TEXT = 'Claude AI usage limit reached|1792087800';
  try {
    await assert.rejects(run('hello', null, { cwd: dir, timeoutMs: 20_000 }), (e) => e.kind === 'quota' && e.resetsAt === 1792087800 * 1000 && e.usage?.output === 20);
  } finally {
    delete process.env.FAKE_SHAPE; delete process.env.FAKE_IS_ERROR; delete process.env.FAKE_TEXT;
  }
});

test('API-key variables do not reach a CLI unless ROUNDTABLE_API_BILLING=1: a seat bills its subscription', () => {
  const source = { PATH: 'x', ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-secret', GEMINI_API_KEY: 'g', CODEX_HOME: '/h', CLAUDECODE: '1' };
  const env = cleanEnv(null, { allowApiKeys: false, source });
  assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'PATH']);
  const allowed = cleanEnv(null, { allowApiKeys: true, source });
  assert.ok(allowed.ANTHROPIC_API_KEY && allowed.OPENAI_API_KEY && allowed.GEMINI_API_KEY);
  assert.equal(allowed.CLAUDECODE, undefined, 'the Claude Code session variables stay out either way');
});
