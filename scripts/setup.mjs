// Explicit, user-scoped host setup. No install hook, vendor CLI or model invocation.
import { readFile, writeFile, mkdir, rename, unlink, lstat, open, access, constants } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_BEGIN as BEGIN, MCP_END as END, tomlConnection, replaceTomlConnection } from '../src/setup-toml.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HELP = `roundtable setup --client codex|claude|agy|all [--check|--remove] [--port N] [--fake|--live] [--home directory]

Connect the installed Roundtable MCP tools and skill for all projects of the selected assistant.
Run once after a global npm install. Restart the assistant or reload its MCP connections afterward.
Run again after an update to refresh the skill and connection. --check inspects without changing files.
--remove removes only this setup's unchanged entries. User edits and unrelated settings are preserved.
--fake selects demo mode; --live selects live mode. Updates preserve the saved mode and port
unless explicitly changed. A new connection defaults to live port 4747 (demo: 4748).
--home selects an isolated user home for testing; normally the current user's home is used.
CODEX_HOME and CLAUDE_CONFIG_DIR are honored unless --home is supplied. No model call is made.
`;
const hash = (s) => createHash('sha256').update(s).digest('hex');
const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);

function parse(args) {
  const out = { clients: [], home: os.homedir(), explicitHome: false, check: false, remove: false };
  while (args.length) {
    const key = args.shift();
    if (key === '--client' && args.length) out.clients.push(args.shift());
    else if (key === '--home' && args.length && !out.explicitHome) { out.home = path.resolve(args.shift()); out.explicitHome = true; }
    else if (key === '--port' && args.length && out.port == null) out.port = Number(args.shift());
    else if (['--fake', '--live'].includes(key) && out.fake == null) out.fake = key === '--fake';
    else if (['--check', '--remove'].includes(key) && !out[key.slice(2)]) out[key.slice(2)] = true;
    else throw new Error('Invalid or repeated setup option. Use roundtable setup --help.');
  }
  if (!out.clients.length || out.clients.some((c) => !['codex', 'claude', 'agy', 'all'].includes(c))) throw new Error('Choose --client codex, claude, agy or all.');
  out.clients = [...new Set(out.clients.includes('all') ? ['codex', 'claude', 'agy'] : out.clients)];
  if (out.check && out.remove) throw new Error('Choose either --check or --remove.');
  if (out.port != null && (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)) throw new Error('Port must be from 1 to 65535.');
  return out;
}

async function readTarget(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to replace a linked or non-file configuration: ${file}`);
    return { text: await readFile(file, 'utf8'), mode: stat.mode & 0o777 };
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function json(raw, label) {
  let value;
  try { value = raw ? JSON.parse(raw.text.replace(/^\uFEFF/, '')) : {}; } catch { throw new Error(`${label} contains invalid JSON; it was not changed.`); }
  if (!plain(value)) throw new Error(`${label} must contain a JSON object; it was not changed.`);
  return value;
}
const same = (a, b) => a?.text === b?.text;
async function writeTarget(file, before, after) {
  if (!same(before, await readTarget(file))) throw new Error(`Configuration changed during setup; retry after the other editor finishes: ${file}`);
  if (after == null) { if (before) await unlink(file); return; }
  if (before?.text === after.text) return;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.roundtable-${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, after.text, { flag: 'wx', mode: after.mode ?? before?.mode ?? 0o600 });
    if (!same(before, await readTarget(file))) throw new Error(`Configuration changed during setup; it was not replaced: ${file}`);
    await rename(tmp, file);
  }
  finally { await unlink(tmp).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
}

function hostFiles(client, opts) {
  const h = opts.home;
  if (client === 'codex') {
    const codex = !opts.explicitHome && process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(h, '.codex');
    return { config: path.join(codex, 'config.toml'), skill: path.join(codex, 'skills', 'roundtable', 'SKILL.md'), kind: 'toml' };
  }
  if (client === 'claude') {
    const custom = !opts.explicitHome && process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : null;
    return { config: custom ? path.join(custom, '.claude.json') : path.join(h, '.claude.json'),
      skill: path.join(custom || path.join(h, '.claude'), 'skills', 'roundtable', 'SKILL.md'), kind: 'json' };
  }
  return { config: path.join(h, '.gemini', 'config', 'mcp_config.json'), skill: path.join(h, '.gemini', 'config', 'skills', 'roundtable', 'SKILL.md'), kind: 'json' };
}

function configEntry(raw, kind) {
  if (kind === 'json') {
    const parsed = json(raw, 'Assistant configuration');
    if (parsed.mcpServers != null && !plain(parsed.mcpServers)) throw new Error('mcpServers must be an object; configuration was not changed.');
    return { parsed, entry: parsed.mcpServers?.roundtable === undefined ? null : JSON.stringify(parsed.mcpServers.roundtable) };
  }
  return tomlConnection(raw?.text || '');
}
function updateConfig(current, kind, entry) {
  if (kind === 'json') {
    const parsed = structuredClone(current.parsed);
    if (entry == null) { if (parsed.mcpServers) { delete parsed.mcpServers.roundtable; if (!Object.keys(parsed.mcpServers).length) delete parsed.mcpServers; } }
    else { parsed.mcpServers ??= {}; parsed.mcpServers.roundtable = JSON.parse(entry); }
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  return replaceTomlConnection(current, entry);
}

async function executableExists(command) {
  if (!command || !path.isAbsolute(command)) return false;
  try {
    await access(command, constants.X_OK);
    const stat = await lstat(command);
    return stat.isFile() || stat.isSymbolicLink();
  } catch { return false; }
}

async function setup(opts) {
  const receiptFile = path.join(opts.home, '.roundtable', 'integrations.json');
  let lock;
  if (!opts.check) {
    await mkdir(path.dirname(receiptFile), { recursive: true, mode: 0o700 });
    try { lock = await open(`${receiptFile}.lock`, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('Another setup holds the integration lock. If it crashed, remove integrations.json.lock before retrying.'); throw e; }
  }
  try {
    const oldReceipt = await readTarget(receiptFile), receipt = json(oldReceipt, 'Roundtable integration receipt');
    receipt.clients ??= {};
    if (!plain(receipt.clients)) throw new Error('Invalid integration receipt; no configuration changed.');
    const skillText = await readFile(path.join(ROOT, 'skills', 'roundtable', 'SKILL.md'), 'utf8');
    const command = process.execPath;
    const changes = [], results = [];
    for (const client of opts.clients) {
      const files = hostFiles(client, opts);
      const [configRaw, skillRaw] = await Promise.all([readTarget(files.config), readTarget(files.skill)]);
      const current = configEntry(configRaw, files.kind), saved = receipt.clients[client];
      const sameLocation = saved && saved.config === files.config && saved.skill === files.skill;
      // A profile override selects a different host, not permission to overwrite the old one.
      if (saved && !sameLocation) throw new Error(`${client}: the host profile moved. Remove the old connection using its original profile before connecting this one.`);
      const configMatches = sameLocation && current.entry != null && hash(current.entry) === saved.configHash;
      const skillMatches = sameLocation && skillRaw != null && hash(skillRaw.text) === saved.skillHash;
      const intact = configMatches && skillMatches;
      if (opts.check) {
        let scriptExists = false, nodeExists = false;
        if (saved?.script) scriptExists = !!await readTarget(saved.script);
        // Old receipts predate the command field; read it only from an unchanged owned entry.
        const node = saved?.command || (configMatches ? files.kind === 'json' ? current.parsed.mcpServers.roundtable.command
          : JSON.parse(/^command = (.+)$/m.exec(current.entry)?.[1] || 'null') : null);
        nodeExists = await executableExists(node);
        results.push({ client, connected: !!intact && scriptExists && nodeExists, config: files.config, skill: files.skill,
          ...(intact && scriptExists && nodeExists ? {} : { issue: !nodeExists && saved ? 'The configured Node executable is missing or not executable. Rerun setup with a working Node installation.'
            : 'Connection missing, edited, or installed script moved. Rerun setup to repair missing files; reconcile edited files first.' }) });
        continue;
      }
      if (saved && (current.entry != null && !configMatches || skillRaw != null && !skillMatches) || !saved && (current.entry != null || skillRaw)) throw new Error(`${client}: existing Roundtable settings or skill were edited or are unmanaged. They were preserved; reconcile them before setup.`);
      if (opts.remove && !saved) { results.push({ client, removed: false, reason: 'No managed connection.' }); continue; }
      const fake = opts.fake ?? (saved?.mode === 'demo');
      const port = opts.port ?? (opts.fake == null ? saved?.port : null) ?? (fake ? 4748 : 4747);
      const args = [path.join(ROOT, 'scripts', 'mcp.mjs'), '--port', String(port), ...(fake ? ['--fake'] : [])];
      const entry = opts.remove ? null : files.kind === 'json' ? JSON.stringify({ command, args })
        : `${BEGIN}\n[mcp_servers.roundtable]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n${END}`;
      if (!opts.remove || current.entry != null) changes.push({ file: files.config, before: configRaw, after: { text: updateConfig(current, files.kind, entry) } });
      changes.push({ file: files.skill, before: skillRaw, after: opts.remove ? null : { text: skillText } });
      if (opts.remove) delete receipt.clients[client];
      else receipt.clients[client] = { ...files, configHash: hash(entry), skillHash: hash(skillText), command, script: args[0], port, mode: fake ? 'demo' : 'live' };
      results.push({ client, ...(opts.remove ? { removed: true } : { connected: true }), config: files.config, skill: files.skill });
    }
    if (!opts.check) {
      changes.push({ file: receiptFile, before: oldReceipt, after: { text: `${JSON.stringify(receipt, null, 2)}\n` } });
      const applied = [];
      try { for (const change of changes) { await writeTarget(change.file, change.before, change.after); applied.push(change); } }
      catch (e) {
        let rollbackFailed = false;
        for (const c of applied.reverse()) { try { await writeTarget(c.file, c.after, c.before); } catch { rollbackFailed = true; } }
        throw new Error(`${e.message}${rollbackFailed ? ' Some files changed concurrently; inspect the connection before retrying.' : ' Previous file contents restored.'}`);
      }
    }
    return { ok: !opts.check || results.every((r) => r.connected), clients: results,
      next: opts.check ? 'A connection check makes no model call. Use roundtable_status in the assistant to verify tool availability.'
        : opts.remove ? 'Restart the assistant or reload its MCP connections to remove the tools.'
          : 'Restart the assistant or reload its MCP connections. From any project, ask it to use Roundtable; it should call roundtable_guide, status, check, start and wait for the chairman. Connecting a host does not authorize using it as a review provider.' };
  } finally { if (lock) { await lock.close(); await unlink(`${receiptFile}.lock`); } }
}

if (!process.argv[2] || process.argv.slice(2).some((a) => ['--help', '-h', 'help'].includes(a))) console.log(HELP);
else {
  try { const result = await setup(parse(process.argv.slice(2))); console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1; }
  catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; }
}
