// The `roundtable` command: it must start the right script with the right flags. The fake
// board is the one checked live (it spends nothing); the others are checked by their usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve('src/cli.js');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });

test('roundtable --help exits 0 and names every command; an unknown command exits 2', () => {
  const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  for (const c of ['fake', 'doctor', 'export', 'debate', '--no-open']) assert.ok(help.includes(c), c);
  assert.throws(() => execFileSync(process.execPath, [CLI, 'bogus'], { encoding: 'utf8', stdio: 'pipe' }), (e) => e.status === 2 && /unknown command: bogus/.test(e.stderr));
});

test('roundtable fake --port starts the fake server on that port, with scripted seats, and the flags reach it as flags', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'fake', '--port', String(port), '--no-open'], { env: { ...process.env, ROUNDTABLE_DEBATES_DIR: mkdtempSync(path.join(os.tmpdir(), 'rt-cli-')) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  let log = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { log += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { log += d; });
  try {
    const t0 = Date.now();
    while (!/token/.test(log) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(log.includes(`roundtable (fake seats): http://localhost:${port}  token `), log);
    assert.match(log, /token [0-9a-f]{32}/);
    assert.doesNotMatch(log, /the board is open in your browser/, 'no browser from a test');
    const r = await fetch(`http://127.0.0.1:${port}/api/seats`);
    assert.equal(r.status, 200);
  } finally {
    // stop the dispatcher and the server it started: the whole tree, on every platform
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
    await new Promise((resolve) => { child.on('exit', resolve); setTimeout(resolve, 5000).unref(); });
  }
});
