// The public tree is an allowlist. The repository holds code, user instructions and
// contribution rules; design notes, plans, reviews, run logs and personal data stay out, and git
// history is the change history. A file outside the allowlist fails this test, so does a
// personal string inside an allowed file, and so does a package file list that would ship more.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { PUBLIC, DEV_ONLY } from './public-tree.mjs';

function trackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { // not a checkout (an unpacked package): walk the folder instead
    const out = [];
    const walk = (dir) => { for (const n of readdirSync(dir)) { if (n === 'node_modules' || n === '.git' || n.startsWith('debates')) continue; const p = path.join(dir, n); if (statSync(p).isDirectory()) walk(p); else out.push(path.relative(root, p).split(path.sep).join('/')); } };
    walk(root);
    return out;
  }
}

const ROOT = path.resolve('.');
const SELF = new Set(['test/public-tree.test.js', 'test/public-tree.mjs']);
const isPublic = (f) => PUBLIC.some((re) => re.test(f));

test('every tracked file is on the public allowlist, or dev-only', () => {
  const stray = trackedFiles(ROOT).filter((f) => !isPublic(f) && !DEV_ONLY.some((re) => re.test(f)));
  assert.deepEqual(stray, [], 'add a file to PUBLIC only when it is code, user instructions or contribution rules');
});

// Placeholders the docs and tests use for a home folder; any other name is someone's machine.
const PLACEHOLDER = /^(u|you|user|runner|<you>|<user>|\$USER|%USERNAME%)$/i;
const CHECKS = [
  { what: 'a personal email address', re: /[\w.%+-]+@(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|proton|protonmail)\.[a-z]+/gi },
  { what: 'a home folder with a real user name', re: /(?:[A-Za-z]:\\{1,2}Users\\{1,2}|\/Users\/|\/home\/)([^\\/\s"'`)]+)/g, keep: (m) => !PLACEHOLDER.test(m[1]) },
  { what: 'a link to an internal document', re: /(?:docs|internal)\/(?:spec|adapters|instances|first-run|history|plan-\d|assessment-\d)[\w.-]*/g },
  { what: 'a dated plan, review or assessment file', re: /\b(?:plan|assessment|review)-20\d\d-\d\d-\d\d\b/g },
];

test('no personal data or internal references inside the public files', () => {
  const found = [];
  for (const f of trackedFiles(ROOT).filter(isPublic)) {
    if (SELF.has(f)) continue; // the patterns themselves
    const text = readFileSync(path.join(ROOT, f), 'utf8');
    for (const c of CHECKS) for (const m of text.matchAll(c.re)) if (!c.keep || c.keep(m)) found.push(`${f}: ${c.what} (${m[0]})`);
  }
  assert.deepEqual(found, []);
});

test('the npm package ships only public files, and local state stays ignored', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.files) && pkg.files.length, 'package.json names its files: without the list npm ships the whole folder');
  for (const entry of pkg.files) {
    assert.ok(!/^(internal|debates|\.)/.test(entry), `${entry} is never shipped`);
    assert.notEqual(entry.replace(/\/$/, ''), 'docs', 'name the user docs one by one, not the folder');
  }
  const ignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  for (const must of ['debates/', 'debates-fake/']) assert.ok(ignore.includes(must), `.gitignore lists ${must}`);
});
