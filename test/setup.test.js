import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from './mcp-client.mjs';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
async function run(home, args = []) {
  try { const { stdout } = await exec(process.execPath, [CLI, 'setup', '--home', home, ...args], { cwd: home, windowsHide: true }); return JSON.parse(stdout); }
  catch (e) { if (e.stdout) return JSON.parse(e.stdout); throw e; }
}

test('user setup preserves unrelated settings, is idempotent, checks and removes its own entries', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rt-setup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.codex'), { recursive: true });
  const toml = '# Keep this comment\nmodel = "test-model"\n[mcp_servers.example]\ncommand = "example"\n';
  await writeFile(path.join(home, '.codex', 'config.toml'), toml);
  const claude = { theme: 'dark', mcpServers: { example: { command: 'example', args: ['one'] } }, projects: { demo: { trusted: true } } };
  await writeFile(path.join(home, '.claude.json'), JSON.stringify(claude));
  const first = await run(home, ['--client', 'all']);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.clients.length, 3);
  const configPath = path.join(home, '.codex', 'config.toml');
  const installed = await readFile(configPath, 'utf8');
  assert.ok(installed.startsWith(toml));
  assert.equal((await run(home, ['--client', 'all', '--check'])).ok, true);
  assert.equal((await run(home, ['--client', 'all'])).ok, true);
  assert.equal(await readFile(configPath, 'utf8'), installed);
  const savedClaude = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8'));
  const { roundtable, ...other } = savedClaude.mcpServers;
  assert.deepEqual({ ...savedClaude, mcpServers: other }, claude);
  assert.equal(roundtable.command, process.execPath);
  assert.ok(path.isAbsolute(roundtable.args[0]));
  const agy = JSON.parse(await readFile(path.join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  assert.deepEqual(agy.mcpServers.roundtable, roundtable);
  for (const c of first.clients) await access(c.skill);
  const removed = await run(home, ['--client', 'all', '--remove']);
  assert.equal(removed.ok, true, removed.error);
  assert.equal((await readFile(configPath, 'utf8')).trimEnd(), toml.trimEnd());
  assert.deepEqual(JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')), claude);
  assert.equal((await run(home, ['--client', 'all', '--check'])).ok, false);
  assert.equal((await run(home, ['--client', 'all', '--remove'])).ok, true);
});

test('setup preserves every unmanaged TOML declaration form and ignores string contents', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rt-setup-toml-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, '.codex', 'config.toml');
  await mkdir(path.dirname(file), { recursive: true });
  for (const toml of [
    '[mcp_servers]\nroundtable = { command = "custom" }\n',
    'mcp_servers.roundtable.command = "custom"\n',
    'mcp_servers = { roundtable = { command = "custom" } }\n',
    '[mcp_servers."roundtable".env]\nTEST = "yes"\n',
    "['mcp_servers'.'roundtable']\ncommand = 'custom'\n",
    '[mcp_servers."round\\u0074able"]\ncommand = "custom"\n',
    '[[mcp_servers]]\ncommand = "custom"\n',
  ]) {
    await writeFile(file, toml);
    assert.equal((await run(home, ['--client', 'codex'])).ok, false, toml);
    assert.equal(await readFile(file, 'utf8'), toml);
    assert.equal((await run(home, ['--client', 'codex', '--check'])).ok, false);
  }
  const valid = 'notice = """\n[mcp_servers.roundtable]\n# BEGIN Roundtable managed MCP\n# END Roundtable managed MCP\n"""\n[mcp_servers]\nother = { command = "example", args = ["# not a comment", "]"] }\n';
  await writeFile(file, valid);
  assert.equal((await run(home, ['--client', 'codex'])).ok, true);
  assert.ok((await readFile(file, 'utf8')).startsWith(valid));
  assert.equal((await run(home, ['--client', 'codex', '--check'])).ok, true);
});

test('setup repairs absent files, preserves mode and port, and removes incomplete owned connections', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rt-setup-repair-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = await run(home, ['--client', 'all', '--fake', '--port', '49231']);
  for (const c of first.clients) await unlink(c.skill);
  assert.equal((await run(home, ['--client', 'all', '--check'])).ok, false);
  assert.equal((await run(home, ['--client', 'all'])).ok, true);
  for (const c of first.clients) await unlink(c.config);
  assert.equal((await run(home, ['--client', 'all'])).ok, true);
  const receipt = JSON.parse(await readFile(path.join(home, '.roundtable', 'integrations.json'), 'utf8'));
  assert.ok(Object.values(receipt.clients).every((c) => c.mode === 'demo' && c.port === 49231));
  assert.equal((await run(home, ['--client', 'all', '--live'])).ok, true);
  const connection = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')).mcpServers.roundtable;
  assert.ok(connection.args.includes('4747') && !connection.args.includes('--fake'));
  await unlink(first.clients[0].config);
  await unlink(first.clients[1].skill);
  assert.equal((await run(home, ['--client', 'all', '--remove'])).ok, true);
  for (const c of first.clients) await assert.rejects(access(c.skill), { code: 'ENOENT' });
});

test('Claude profile overrides and missing Node are checked without touching the default profile', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rt-setup-profile-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = path.join(home, 'custom-profile');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: profile };
  const invoke = async (args) => {
    try { return JSON.parse((await exec(process.execPath, [CLI, 'setup', '--client', 'claude', ...args], { env, cwd: home, windowsHide: true })).stdout); }
    catch (e) { if (e.stdout) return JSON.parse(e.stdout); throw e; }
  };
  const installed = await invoke([]);
  assert.equal(installed.ok, true, installed.error);
  assert.equal(installed.clients[0].config, path.join(profile, '.claude.json'));
  assert.equal(installed.clients[0].skill, path.join(profile, 'skills', 'roundtable', 'SKILL.md'));
  await assert.rejects(access(path.join(home, '.claude.json')), { code: 'ENOENT' });
  assert.equal((await invoke(['--check'])).ok, true);
  // Simulate a removed Node installation while preserving the owned-entry receipt.
  const configFile = installed.clients[0].config, receiptFile = path.join(home, '.roundtable', 'integrations.json');
  const config = JSON.parse(await readFile(configFile, 'utf8')), receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  config.mcpServers.roundtable.command = receipt.clients.claude.command = path.join(home, 'missing-node');
  receipt.clients.claude.configHash = createHash('sha256').update(JSON.stringify(config.mcpServers.roundtable)).digest('hex');
  await writeFile(configFile, JSON.stringify(config)); await writeFile(receiptFile, JSON.stringify(receipt));
  const checked = await invoke(['--check']);
  assert.equal(checked.ok, false); assert.match(checked.clients[0].issue, /Node executable/);
  assert.equal((await invoke([])).ok, true);
  assert.equal((await invoke(['--check'])).ok, true);
});

test('managed TOML updates preserve literal dollar replacement sequences', async () => {
  const { tomlConnection, replaceTomlConnection, MCP_BEGIN, MCP_END } = await import('../src/setup-toml.js');
  const original = `model = "example"\n${MCP_BEGIN}\n[mcp_servers.roundtable]\ncommand = "node"\n${MCP_END}\n`;
  const entry = `${MCP_BEGIN}\n[mcp_servers.roundtable]\ncommand = "node"\nargs = ["$&", "$'", "$\x60", "$$"]\n${MCP_END}`;
  const updated = replaceTomlConnection(tomlConnection(original), entry);
  assert.equal(updated, `model = "example"\n${entry}\n`);
  assert.equal(tomlConnection(updated).entry, entry);
});

test('setup refuses unmanaged and user-edited entries before changing any host', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rt-setup-conflict-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const custom = JSON.stringify({ mcpServers: { roundtable: { command: 'custom-command' } } });
  await writeFile(path.join(home, '.claude.json'), custom);
  assert.equal((await run(home, ['--client', 'all'])).ok, false);
  await assert.rejects(access(path.join(home, '.codex', 'config.toml')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(home, '.claude.json'), 'utf8'), custom);
  assert.equal((await run(home, ['--client', 'codex'])).ok, true);
  const skill = path.join(home, '.codex', 'skills', 'roundtable', 'SKILL.md');
  await writeFile(skill, `${await readFile(skill, 'utf8')}\nMy custom workflow.\n`);
  assert.equal((await run(home, ['--client', 'codex', '--check'])).ok, false);
  assert.equal((await run(home, ['--client', 'codex'])).ok, false);
  assert.equal((await run(home, ['--client', 'codex', '--remove'])).ok, false);
  assert.match(await readFile(skill, 'utf8'), /My custom workflow/);
});

test('invalid JSON and unmanaged TOML are preserved, and invalid arguments change nothing', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rt-setup-invalid-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, '.claude.json'), '{broken');
  assert.equal((await run(home, ['--client', 'claude'])).ok, false);
  assert.equal(await readFile(path.join(home, '.claude.json'), 'utf8'), '{broken');
  await mkdir(path.join(home, '.codex'), { recursive: true });
  const custom = '[mcp_servers."roundtable"]\ncommand = "custom"\n';
  await writeFile(path.join(home, '.codex', 'config.toml'), custom);
  assert.equal((await run(home, ['--client', 'codex'])).ok, false);
  assert.equal(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8'), custom);
  assert.equal((await run(home, ['--client', 'bad'])).ok, false);
  assert.equal((await run(home, ['--client', 'agy', '--port', '0'])).ok, false);
});
