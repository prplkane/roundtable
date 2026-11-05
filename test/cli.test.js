// The `roundtable` command: it must start the right script with the right flags. The fake
// board is the one checked live (it spends nothing); the others are checked by their usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { terminalBanner } from '../src/terminal.js';

const CLI = path.resolve('src/cli.js');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });

test('roundtable --help exits 0 and names every command; an unknown command exits 2', () => {
  const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  for (const c of ['fake', 'doctor', 'export', 'debate', '--no-open']) assert.ok(help.includes(c), c);
  assert.doesNotMatch(help, /ROUNDTABLE|\x1b\[/, 'redirected help stays plain');
  assert.throws(() => execFileSync(process.execPath, [CLI, 'bogus'], { encoding: 'utf8', stdio: 'pipe' }), (e) => e.status === 2 && /unknown command: bogus/.test(e.stderr));
});

test('terminal branding respects output capabilities and does not decorate pipes or CI', () => {
  const terminal = { isTTY: true, columns: 80, env: {} };
  assert.match(terminalBanner(terminal), /ROUNDTABLE/);
  const plain = terminalBanner({ ...terminal, env: { NO_COLOR: '1' } });
  assert.match(plain, /ROUNDTABLE/);
  assert.doesNotMatch(plain, /\x1b\[/, 'NO_COLOR removes ANSI styling');
  const ascii = terminalBanner({ ...terminal, env: { NO_COLOR: '1', ROUNDTABLE_ASCII: '1' } });
  assert.doesNotMatch(ascii, /[^\x20-\x7e\n]/, 'an ASCII-only fallback is available');
  assert.equal(terminalBanner({ ...terminal, env: { NO_COLOR: '1', LANG: 'C' } }), ascii);
  assert.equal(terminalBanner({ ...terminal, isTTY: false }), '');
  assert.equal(terminalBanner({ ...terminal, env: { CI: '1' } }), '');
  assert.equal(terminalBanner({ ...terminal, env: { TERM: 'dumb' } }), '');
  assert.equal(terminalBanner({ ...terminal, columns: 30, env: { NO_COLOR: '1' } }), '\nROUNDTABLE\n\n');
});

test('terminal mark preserves the actual SVG logo pixels in both renderings', () => {
  const svg = readFileSync('src/ui/logo.svg', 'utf8');
  const pixels = new Set([...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="1" height="1"\/>/g)].map(m => `${m[1]},${m[2]}`));
  assert.ok(pixels.size > 0);
  const render = env => terminalBanner({ isTTY: true, columns: 80, env: { NO_COLOR: '1', ...env } }).split('\n').slice(1, -2);
  const blocks = render({}), ascii = render({ ROUNDTABLE_ASCII: '1' });
  for (let y = 2; y <= 13; y++) for (let x = 2; x <= 13; x++) {
    const glyph = blocks[Math.floor((y - 2) / 2)][x];
    const lit = (y % 2 === 0 ? '▀█' : '▄█').includes(glyph);
    assert.equal(lit, pixels.has(`${x},${y}`), `block pixel ${x},${y}`);
    if (y <= 12) assert.equal(ascii[y - 2].slice(2 + (x - 2) * 2, 4 + (x - 2) * 2), pixels.has(`${x},${y}`) ? '##' : '  ', `ASCII pixel ${x},${y}`);
  }
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
    assert.doesNotMatch(log, /ROUNDTABLE|\x1b\[/, 'redirected board logs stay plain');
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
