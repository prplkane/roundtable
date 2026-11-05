// The `roundtable` command: it must start the right script with the right flags. The fake
// board is the one checked live (it spends nothing); the others are checked by their usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { terminalBanner } from '../src/terminal.js';
import { VERSION } from '../src/version.js';

const CLI = path.resolve('src/cli.js');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });

test('roundtable --help exits 0 and names every command; an unknown command exits 2', () => {
  const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  for (const c of ['fake', 'doctor', 'export', 'debate', '--no-open']) assert.ok(help.includes(c), c);
  assert.doesNotMatch(help, /ROUNDTABLE|\x1b\[/, 'redirected help stays plain');
  assert.throws(() => execFileSync(process.execPath, [CLI, 'bogus'], { encoding: 'utf8', stdio: 'pipe' }), (e) => e.status === 2 && /unknown command: bogus/.test(e.stderr));
});

test('terminal branding respects output capabilities and does not decorate pipes or CI', () => {
  const terminal = { isTTY: true, columns: 80, env: { LANG: 'en_US.UTF-8' }, platform: 'linux' };
  const basic = terminalBanner(terminal);
  assert.match(basic, /ROUNDTABLE/);
  assert.match(basic, /[▀▄█]/, 'the mark is the pixel tile drawn with half blocks');
  assert.match(basic, /\x1b\[45m/, 'a basic terminal gets the standard magenta tile');
  assert.match(terminalBanner({ ...terminal, env: { ...terminal.env, COLORTERM: 'truecolor' } }), /48;2;199;154;208m/, 'true colour gets the orchid tile');
  const plain = terminalBanner({ ...terminal, env: { ...terminal.env, NO_COLOR: '1' } });
  assert.match(plain, /ROUNDTABLE/);
  assert.doesNotMatch(plain, /\x1b\[/, 'NO_COLOR removes ANSI styling');
  assert.match(plain, /[▀▄█]/, 'the tile stays without colour');
  const compact = `\nROUNDTABLE  v${VERSION}\n\n`;
  assert.equal(terminalBanner({ ...terminal, env: { NO_COLOR: '1', LANG: 'C' } }), compact, 'a locale without UTF-8 gets the wordmark only');
  assert.equal(terminalBanner({ ...terminal, env: { NO_COLOR: '1' } }), compact, 'no locale at all: no half blocks');
  assert.equal(terminalBanner({ ...terminal, env: { ...terminal.env, NO_COLOR: '1', ROUNDTABLE_ASCII: '1' } }), compact);
  assert.equal(terminalBanner({ ...terminal, env: { NO_COLOR: '1' }, platform: 'win32' }), plain, 'Windows consoles take Unicode whatever the locale says');
  assert.equal(terminalBanner({ ...terminal, isTTY: false }), '');
  assert.equal(terminalBanner({ ...terminal, env: { ...terminal.env, CI: '1' } }), '');
  assert.equal(terminalBanner({ ...terminal, env: { ...terminal.env, TERM: 'dumb' } }), '');
  assert.equal(terminalBanner({ ...terminal, columns: 30, env: { ...terminal.env, NO_COLOR: '1' } }), compact);
});

test('terminal banner fits its available width and identifies the installed version', () => {
  for (const columns of [10, 18, 30, 42, 43, 80]) {
    const banner = terminalBanner({ isTTY: true, columns, env: { NO_COLOR: '1', LANG: 'en_US.UTF-8' }, platform: 'linux' });
    for (const line of banner.split('\n')) assert.ok([...line].length <= columns, `line exceeds ${columns} columns`);
    assert.equal(banner.match(/ROUNDTABLE/g).length, 1);
    if (columns >= 12 + `v${VERSION}`.length) assert.ok(banner.includes(`v${VERSION}`));
    assert.equal(/[▀▄█]/.test(banner), columns >= 43, 'the tile appears once the tagline fits beside it');
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
