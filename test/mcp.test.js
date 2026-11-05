// Real stdio, installed-file layout and loopback server; every seat is scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, cp, readdir, rm, access, rename, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { exec, freePort, mcpClient } from './mcp-client.mjs';
import { VERSION } from '../src/version.js';
import { LOCAL_API_VERSION, inspectServer, ensureServer, stopServer } from '../src/local-server.js';
import { LIMITS } from '../src/validate.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MCP = path.join(ROOT, 'scripts', 'mcp.mjs');

test('MCP retries slow and reset health reads, reads the catalogue once, and refuses mismatched boards', { timeout: 15000 }, async (t) => {
  let mode = 'live', reads = 0, catalogueReads = 0, version = VERSION, legacy = false;
  const dataDir = path.join(os.tmpdir(), 'synthetic-roundtable-health');
  const unicode = 'A multilingual reply: 日本語 😀. '.repeat(12000);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/health') {
      const n = reads++;
      if (n === 0) await delay(2300);
      if (n === 1) { req.socket.destroy(); return; }
      if (n === 2) { res.writeHead(503); res.end('{}'); return; }
      if (n === 3) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); await delay(50); req.socket.destroy(); return; }
      if (legacy) { res.writeHead(404); res.end('{}'); return; }
      res.end(JSON.stringify({ service: 'roundtable', apiVersion: LOCAL_API_VERSION, version, instanceId: 'a'.repeat(32), mode, dataDir }));
    } else if (req.url === '/api/seats?cached=1') {
      catalogueReads++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ runtime: { mode }, vendors: [], defaults: { critiqueRounds: 1 } }));
    } else if (req.url === '/api/preflight') res.end(JSON.stringify({ pools: {} }));
    else if (req.url === '/api/debates/example/state') res.end(JSON.stringify({ id: 'example', status: 'done', nextAction: { type: 'report_result' },
      verdict: { status: 'ready', sections: { RECOMMENDATION: unicode } } }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = mcpClient(process.execPath, [MCP, '--port', String(server.address().port), '--no-start'], { env: { ...process.env, ROUNDTABLE_DEBATES_DIR: dataDir } });
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  await client.initialize();
  const result = await client.tool('status');
  assert.equal(result.ok, true, result.error);
  assert.equal(result.mode, 'live');
  assert.equal(catalogueReads, 1);
  const review = await client.tool('status', { id: 'example' });
  assert.equal(review.verdict.sections.RECOMMENDATION, unicode, 'UTF-8 survives large streamed responses across chunk boundaries');
  assert.equal(catalogueReads, 1, 'a review read does not fetch the provider catalogue');
  mode = 'demo';
  const refused = await client.tool('status');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /expected mode/);
  mode = 'live'; version = '0.0.0';
  assert.match((await client.tool('status')).error, /server restart/);
  version = VERSION;
  await assert.rejects(inspectServer({ port: server.address().port, dataDir: `${dataDir}-other` }), /different data directory/);
  legacy = true;
  assert.match((await client.tool('status')).error, /incompatible or older/);
});

test('a 30-second MCP wait allows both slow state reads and does not hit the old 55-second watchdog', { timeout: 75000 }, async (t) => {
  const dataDir = path.join(os.tmpdir(), 'synthetic-roundtable-wait');
  let stateReads = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/health') res.end(JSON.stringify({ service: 'roundtable', apiVersion: LOCAL_API_VERSION, version: VERSION, instanceId: 'b'.repeat(32), mode: 'live', dataDir }));
    else if (req.url.endsWith('/state')) {
      stateReads++; await delay(13200);
      res.end(JSON.stringify({ id: 'example', revision: '1:0', status: 'running', nextAction: { type: 'wait' } }));
    } else if (req.url.endsWith('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); }
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = mcpClient(process.execPath, [MCP, '--port', String(server.address().port), '--no-start'], { env: { ...process.env, ROUNDTABLE_DEBATES_DIR: dataDir }, requestTimeoutMs: 70000 });
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  await client.initialize();
  const result = await client.tool('wait', { id: 'example', seconds: 30 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.completed, false);
  assert.equal(result.nextAction.type, 'wait');
  assert.equal(stateReads, 2);
});

test('readiness cancellation prevents dispatch and transient failures have a bounded retry window', async (t) => {
  let reads = 0;
  const server = http.createServer((req, res) => { reads++; res.writeHead(503); res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const config = { port: server.address().port, start: false };
  await assert.rejects(ensureServer(config, { timeoutMs: 300 }), /could not become ready/);
  assert.ok(reads >= 2);
  const controller = new AbortController(); controller.abort();
  const before = reads;
  await assert.rejects(ensureServer(config, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(reads, before);
});

test('a board that exits before it is ready is reported with its own last line, not a 35-second timeout', { timeout: 20000 }, async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'rt-exit-')), 'a-file');
  await (await import('node:fs/promises')).writeFile(file, 'x');
  const t0 = Date.now();
  // a data directory beneath a file cannot be created, so the board dies at startup
  await assert.rejects(ensureServer({ port: await freePort(), dataDir: path.join(file, 'sub') }, { timeoutMs: 15000 }),
    /exited before it was ready \(Error: ENOTDIR.*\)\. Run roundtable --no-open in a terminal for startup details\. No review was started\./);
  assert.ok(Date.now() - t0 < 12000, 'the exit cuts the readiness wait short');
});

test('two hosts starting the board at once both get the one that won the port', { timeout: 40000 }, async (t) => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'rt-race-'));
  const config = { port: await freePort(), fake: true, dataDir: data };
  t.after(async () => { await stopServer(config); await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  // the loser exits on the data-folder lock or the port; its starter must still find the winner
  const [a, b] = await Promise.all([ensureServer(config), ensureServer(config)]);
  assert.equal(a.instanceId, b.instanceId);
  assert.equal(a.mode, 'demo');
});

test('MCP discovery, protocol errors and guide work without starting a server or vendor', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rt-mcp-protocol-'));
  const port = await freePort();
  const client = mcpClient(process.execPath, [MCP, '--port', String(port), '--fake', '--no-start'], { cwd: dir,
    env: { ...process.env, PATH: '', ROUNDTABLE_DEBATES_DIR: path.join(dir, 'data') } });
  t.after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(client.request('tools/list'), /Initialize first/);
  const init = await client.initialize('2025-06-18');
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.equal(init.serverInfo.name, 'roundtable');
  const listed = await client.request('tools/list');
  assert.equal(listed.tools.length, 11);
  const waitSchema = listed.tools.find((t) => t.name === 'roundtable_wait').inputSchema.properties;
  assert.equal(waitSchema.seconds.maximum, LIMITS.waitSeconds[1]);
  assert.equal(waitSchema.afterRound.maximum, LIMITS.critiqueRounds[1]);
  assert.ok(listed.tools.some((t) => t.name === 'roundtable_wait' && t.inputSchema.properties.afterRound));
  assert.ok(!listed.tools.some((t) => /accept|export/.test(t.name)));
  const guide = await client.tool('guide');
  assert.equal(guide.ok, true);
  assert.ok(guide.recipe.completion && guide.recipe.questions);
  assert.equal((await client.tool('answer', { id: '../escape', round: 0 })).ok, false);
  assert.equal((await client.tool('wait', { id: 'test', seconds: 60 })).ok, false);
  assert.equal((await client.tool('status', { unexpected: true })).ok, false);
  assert.equal((await client.tool('status')).ok, false);
  await assert.rejects(access(path.join(dir, 'data')), { code: 'ENOENT' });
  await assert.rejects(client.request('missing/method'), /Method not found/);
  assert.deepEqual(await client.request('ping'), {});
  assert.equal(client.stderr(), '');
});

test('installed MCP works outside the repo: questions, real answers, silence, unattended and chairman completion', { timeout: 90000 }, async (t) => {
  // Windows temp paths can use an 8.3 alias; compare installations under the canonical root.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rt-mcp-install-')));
  const source = path.join(root, 'temporary checkout'), prefix = path.join(root, 'installation with spaces');
  const installed = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', '@prplkane', 'roundtable');
  const project = path.join(root, 'unrelated-project'), home = path.join(root, 'home'), data = path.join(root, 'private-data');
  await Promise.all([mkdir(source), mkdir(project), mkdir(home)]);
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  for (const entry of [...pkg.files, 'package.json']) await cp(path.join(ROOT, entry), path.join(source, entry), { recursive: true });
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../share/nodejs/npm/bin/npm-cli.js')].filter(Boolean);
  let npm;
  for (const file of candidates) { try { await access(file); npm = file; break; } catch {} }
  assert.ok(npm, 'Run the package integration test with npm test when npm is not beside Node.');
  const packed = JSON.parse((await exec(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', root], { cwd: source, windowsHide: true })).stdout);
  await exec(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(root, packed[0].filename)], { cwd: project, windowsHide: true });
  assert.equal(await realpath(installed), installed, 'the installed package is a copy, not a link to the checkout');
  // Move only the temporary source, proving the installed command survives a missing checkout.
  const moved = path.join(root, 'moved checkout');
  assert.equal(path.dirname(source), root); assert.equal(path.dirname(moved), root);
  await rename(source, moved);
  const port = await freePort();
  const { stdout } = await exec(process.execPath, [path.join(installed, 'src', 'cli.js'), 'setup', '--client', 'all', '--home', home, '--fake', '--port', String(port)], { cwd: project, windowsHide: true });
  assert.equal(JSON.parse(stdout).ok, true);
  const connection = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')).mcpServers.roundtable;
  assert.equal(connection.args[0], path.join(installed, 'scripts', 'mcp.mjs'));
  const clients = [];
  let serverPid;
  const serverCommand = async (command) => {
    const args = [path.join(installed, 'src', 'cli.js'), 'server', command, '--port', String(port), '--fake'];
    const options = { cwd: project, windowsHide: true, env: { ...process.env, PATH: '', ROUNDTABLE_DEBATES_DIR: data, ROUNDTABLE_TOKEN: '' } };
    try { return JSON.parse((await exec(process.execPath, args, options)).stdout); }
    catch (e) { if (e.stdout) return JSON.parse(e.stdout); throw e; }
  };
  const connect = async () => {
    const c = mcpClient(connection.command, connection.args, { cwd: project,
      env: { ...process.env, PATH: '', ROUNDTABLE_DEBATES_DIR: data, ROUNDTABLE_TOKEN: '' } });
    clients.push(c); await c.initialize(); return c;
  };
  t.after(async () => {
    for (const c of clients) await c.close();
    if (serverPid) { try { process.kill(serverPid); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    for (let i = 0; i < 50; i++) {
      try { if (serverPid) process.kill(serverPid, 0); else break; } catch { break; }
      await delay(50);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let client = await connect();
  const second = await connect();
  const [setup, shared] = await Promise.all([client.tool('status'), second.tool('status')]);
  assert.equal(setup.ok, true, setup.error);
  assert.equal(shared.ok, true, shared.error);
  await second.close();
  assert.equal(setup.mode, 'demo');
  assert.equal(setup.defaults.critiqueRounds, 1);
  serverPid = JSON.parse(await readFile(path.join(data, '_server.lock'), 'utf8')).pid;
  assert.ok(serverPid > 0);
  const base = `http://127.0.0.1:${port}`;
  const page = await (await fetch(base)).text(), token = /<meta name="roundtable-token" content="([a-f0-9]{32})">/.exec(page)[1];
  assert.equal((await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roundtable-token': token }, body: JSON.stringify({ instanceId: 'stale' }) })).status, 409);
  assert.deepEqual((await readdir(data)).filter((n) => /^\d{4}-/.test(n)), []);
  const request = { fieldNotes: { decision: 'Synthetic outside-project decision', options: ['Trial', 'Wait'] },
    seats: [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost' }, { vendor: 'agy', lens: 'evidence' }],
    chairman: { vendor: 'claude', effort: 'low' }, options: { critiqueRounds: 1, autoContinueMs: 100, questionWaitMs: 8000 } };
  const checked = await client.tool('check', { review: request });
  assert.equal(checked.ok, true, checked.error);
  assert.equal(checked.plannedCalls, 7);
  const started = await client.tool('start', { review: request });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.completed, false);
  assert.match(started.board, new RegExp(`:${port}/#${started.id}$`));
  let state = await client.tool('wait', { id: started.id });
  assert.equal(state.nextAction.type, 'ask_user');
  assert.equal(state.nextAction.tool, 'roundtable_answer');
  assert.equal(state.gate.questions.length, 2, 'overlapping questions are grouped');
  const blockedStop = await serverCommand('stop');
  assert.equal(blockedStop.status, 409, 'server management cannot cancel a waiting review');
  assert.match(blockedStop.error, /active review/);
  const firstRound = state.gate.round;
  const originalDeadline = state.gate.autoContinueAt;
  state = await client.tool('wait', { id: started.id, afterRound: firstRound, seconds: 1 });
  assert.equal(state.nextAction.type, 'await_user');
  assert.equal(state.gate.autoContinueAt, originalDeadline, 'reading never extends a gate');
  assert.equal((await client.tool('hold', { id: started.id, round: firstRound + 1 })).ok, false);
  const held = await client.tool('hold', { id: started.id, round: firstRound });
  assert.equal(held.ok, true);
  assert.ok(held.autoContinueAt > originalDeadline);
  const answered = await client.tool('answer', { id: started.id, round: firstRound,
    answers: state.gate.questions.map((q) => ({ id: q.id, text: 'Synthetic user answer: the deadline can move by a week; stop if failures exceed the trial threshold.' })) });
  assert.equal(answered.ok, true, answered.error);
  for (let n = 0; n < 5; n++) {
    state = await client.tool('wait', { id: started.id, afterRound: firstRound });
    if (state.status === 'done') break;
    if (state.nextAction.type === 'ask_user') await client.tool('answer', { id: started.id, round: state.gate.round,
      answers: state.gate.questions.map((q) => ({ id: q.id, text: 'Synthetic user answer: yes.' })) });
  }
  assert.equal(state.status, 'done');
  assert.equal(state.verdict.status, 'ready');
  assert.equal(state.completed, true);
  assert.equal(state.depth.completedCritiqueRounds, 1);
  const rows = (await readFile(path.join(data, started.id, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rows.some((r) => r.type === 'human'));
  assert.ok(!rows.some((r) => r.type === 'accepted'));

  // Unanswered gates keep their timer even when the coordinator disconnects.
  const silent = await client.tool('start', { review: { ...request, options: { critiqueRounds: 0, questionWaitMs: 1500, autoContinueMs: 100 } } });
  const question = await client.tool('wait', { id: silent.id });
  assert.equal(question.nextAction.type, 'ask_user');
  await client.close();
  client = await connect();
  const continued = await client.tool('wait', { id: silent.id, afterRound: question.gate.round });
  assert.equal(continued.status, 'done');
  assert.equal(continued.verdict.status, 'ready');
  assert.equal(continued.completed, true);
  const late = await client.tool('answer', { id: silent.id, round: question.gate.round, answers: [{ id: 'q1', text: 'Late reply' }] });
  assert.equal(late.ok, false);
  assert.equal(late.status, 409);
  const silentRows = (await readFile(path.join(data, silent.id, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(silentRows.some((r) => r.type === 'gate-timeout' && r.unanswered > 0));
  assert.ok(!silentRows.some((r) => ['human', 'accepted'].includes(r.type)));
  assert.equal(continued.depth.completedCritiqueRounds, 0);

  const background = await client.tool('start', { review: { ...request, options: { critiqueRounds: 1, unattended: true } } });
  const done = await client.tool('wait', { id: background.id });
  assert.equal(done.status, 'done');
  assert.equal(done.completed, true);
  assert.equal(done.verdict.status, 'ready');
  const backgroundRows = (await readFile(path.join(data, background.id, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!backgroundRows.some((r) => ['gate', 'gate-timeout', 'human', 'accepted'].includes(r.type)));
  const stopped = await client.tool('start', { review: request });
  assert.equal((await client.tool('stop', { id: stopped.id })).ok, true);
  const incomplete = await client.tool('wait', { id: stopped.id });
  assert.equal(incomplete.completed, false);
  assert.equal(incomplete.nextAction.type, 'report_incomplete');
  assert.equal(client.stderr(), '');
  const oldServer = (await serverCommand('status')).server;
  const restarted = await serverCommand('restart');
  assert.equal(restarted.ok, true, restarted.error);
  assert.notEqual(restarted.server.instanceId, oldServer.instanceId);
  serverPid = JSON.parse(await readFile(path.join(data, '_server.lock'), 'utf8')).pid;
  const saved = await client.tool('status', { id: started.id });
  assert.equal(saved.completed, true, 'saved chairman results survive a restart');
  assert.equal(saved.depth.completedCritiqueRounds, 1);
  const stoppedServer = await serverCommand('stop');
  assert.equal(stoppedServer.ok, true, stoppedServer.error);
  assert.equal((await serverCommand('status')).server, null);
  serverPid = null;
});
