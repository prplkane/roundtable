import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginInstructions } from '../src/doctor.js';

test('loginInstructions name the profile directory and the login command per vendor and platform', () => {
  const win = loginInstructions('claude', 'work', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, homedir: 'C:\\Users\\u', exists: () => false });
  assert.match(win[0], /profile "work" lives in C:\\Users\\u\\\.roundtable\\homes\\work\\claude/);
  assert.match(win[1], /^\s+set CLAUDE_CONFIG_DIR=/);
  assert.match(win[2], /claude \/login/);
  const nix = loginInstructions('codex', 'alt', { platform: 'linux', env: {}, homedir: '/home/u' });
  assert.match(nix[1], /^\s+CODEX_HOME="\/home\/u\/.local\/share\/roundtable\/homes\/alt\/codex" codex login$/);
  assert.match(loginInstructions('agy', 'x', { platform: 'linux', env: {}, homedir: '/h' })[0], /no state-directory variable/);
});

test('doctor shows the Antigravity terms notice and sends agy nothing without --acknowledge-terms-risk', { timeout: 30_000 }, () => {
  // no CLI on PATH, so nothing but node itself can run whatever the doctor decides
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)));
  env.PATH = mkdtempSync(path.join(os.tmpdir(), 'rt-no-cli-'));
  env.ROUNDTABLE_DEBATES_DIR = mkdtempSync(path.join(os.tmpdir(), 'rt-doctor-'));
  const doctor = (...args) => execFileSync(process.execPath, ['src/doctor.js', '--vendor', 'agy', ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  const held = doctor('--live');
  assert.match(held, /terms {6}Google's Antigravity FAQ says .+ \(https:\/\/antigravity\.google\/docs\/faq, checked \d{4}-\d{2}-\d{2}\)/);
  assert.match(held, /models {5}held: nothing is sent to agy without --acknowledge-terms-risk/);
  assert.match(held, /pool read {2}held: nothing is sent to agy/);
  const given = doctor('--acknowledge-terms-risk');
  assert.match(given, /terms {6}Google's Antigravity FAQ/, 'the notice is shown either way');
  assert.doesNotMatch(given, /held:/);
  // without --vendor, CLIs that are not on this machine get one line, not a block each
  const all = execFileSync(process.execPath, ['src/doctor.js'], { env, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.match(all, /^not installed: Claude \(claude\), Codex \(codex\), Antigravity \(agy\); install and sign in/m);
  assert.doesNotMatch(all, /== (Claude|Codex|Antigravity)|NOT FOUND/);
  assert.match(all, /== API endpoint \(api\)/, 'the endpoint seat has no binary to miss');
  assert.doesNotMatch(all, /\x1b\[/, 'piped output stays plain');
});
