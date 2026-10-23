import test from 'node:test';
import assert from 'node:assert/strict';
import { loginInstructions } from '../src/doctor.js';

test('loginInstructions name the profile directory and the login command per vendor and platform', () => {
  const win = loginInstructions('claude', 'work', { platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, homedir: 'C:\\Users\\u' });
  assert.match(win[0], /profile "work" lives in C:\\Users\\u\\AppData\\Local\\roundtable\\homes\\work\\claude/);
  assert.match(win[1], /^\s+set CLAUDE_CONFIG_DIR=/);
  assert.match(win[2], /claude \/login/);
  const nix = loginInstructions('codex', 'alt', { platform: 'linux', env: {}, homedir: '/home/u' });
  assert.match(nix[1], /^\s+CODEX_HOME="\/home\/u\/.local\/share\/roundtable\/homes\/alt\/codex" codex login$/);
  assert.match(loginInstructions('agy', 'x', { platform: 'linux', env: {}, homedir: '/h' })[0], /no state-directory variable/);
});
