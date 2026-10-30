import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { validateTarget, exportDebate } from '../src/export.js';

const rows = [{ type: 'field-notes', fieldNotes: { decision: 'Choose', options: ['A', 'B'] }, seats: [] }];
test('record export resolves directory aliases and refuses linked record and index leaves', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-export-links-'));
  const privateDir = path.join(root, 'private'), alias = path.join(root, 'alias');
  mkdirSync(privateDir); symlinkSync(privateDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateTarget(alias, { forbid: [privateDir] }), /Refusing/);
  const target = path.join(root, 'target'); mkdirSync(target);
  writeFileSync(path.join(privateDir, 'sentinel'), 'keep');
  for (const name of ['review.md', 'README.md']) symlinkSync(privateDir, path.join(target, name), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportDebate(rows, 'review', target), /linked|non-file/);
  assert.throws(() => exportDebate(rows, 'other', target), /linked|non-file/);
  assert.equal(readFileSync(path.join(privateDir, 'sentinel'), 'utf8'), 'keep');
  assert.equal(existsSync(path.join(target, 'other.md')), false);
});

const devExporter = new URL('../internal/export-public.mjs', import.meta.url);
test('public export preserves nonempty targets and prepares sources before creating a fresh target', { skip: !existsSync(devExporter) }, async () => {
  const { exportPublic } = await import(devExporter);
  const base = mkdtempSync(path.join(os.tmpdir(), 'rt-public-export-'));
  const root = path.join(base, 'source'); mkdirSync(root);
  execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"test"}\n');
  execFileSync('git', ['-C', root, 'add', 'package.json'], { windowsHide: true });
  const occupied = path.join(base, 'occupied'); mkdirSync(occupied); writeFileSync(path.join(occupied, 'sentinel'), 'keep');
  assert.throws(() => exportPublic(occupied, { root }), /empty/);
  assert.equal(readFileSync(path.join(occupied, 'sentinel'), 'utf8'), 'keep');
  assert.throws(() => exportPublic(base, { root }), /ancestor/);
  assert.throws(() => exportPublic(path.join(root, 'nested'), { root }), /source/);
  const alias = path.join(base, 'alias'); symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportPublic(alias, { root }), /source/);
  const target = path.join(base, 'fresh'); mkdirSync(target); mkdirSync(path.join(target, '.git')); writeFileSync(path.join(target, '.git', 'sentinel'), 'keep');
  assert.equal(exportPublic(target, { root }).count, 1);
  assert.equal(readFileSync(path.join(target, '.git', 'sentinel'), 'utf8'), 'keep');
  assert.deepEqual(readdirSync(target).sort(), ['.git', 'package.json']);
  execFileSync('git', ['-C', root, 'rm', '--cached', 'package.json'], { windowsHide: true });
  const absent = path.join(base, 'absent');
  assert.throws(() => exportPublic(absent, { root }), /package.json missing/);
  assert.equal(existsSync(absent), false);
});
