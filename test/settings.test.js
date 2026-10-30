import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSettingsStore } from '../src/settings.js';

test('missing settings can be saved, valid settings load and unrelated entries survive', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-settings-')), file = path.join(root, 'settings.json');
  const first = createSettingsStore(file); assert.deepEqual(first.value, {});
  first.save({ agy: { remaining: 4 }, codex: { remaining: 2 } });
  const next = createSettingsStore(file);
  next.save({ ...next.value, agy: { remaining: 3 } });
  assert.deepEqual(createSettingsStore(file).value, { agy: { remaining: 3 }, codex: { remaining: 2 } });
  assert.deepEqual(readdirSync(root), ['settings.json']);
});

test('malformed and wrong-shape settings are preserved and blocked until repair and restart', () => {
  for (const original of ['{ damaged', 'null', '[]', '2']) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'rt-settings-')), file = path.join(root, 'settings.json');
    writeFileSync(file, original); const errors = [];
    const store = createSettingsStore(file, { onError: (e) => errors.push(e) });
    assert.equal(errors.length, 1);
    assert.throws(() => store.save({ other: 1 }), /Restore it and restart/);
    assert.equal(readFileSync(file, 'utf8'), original);
    writeFileSync(file, '{"restored":true}');
    assert.throws(() => store.save({ other: 1 }), /restart/);
    const restarted = createSettingsStore(file); restarted.save({ ...restarted.value, other: 1 });
    assert.deepEqual(createSettingsStore(file).value, { restored: true, other: 1 });
  }
});

test('an unreadable settings path is never replaced on save', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rt-settings-')), file = path.join(root, 'settings.json');
  mkdirSync(file); const errors = [];
  const store = createSettingsStore(file, { onError: (e) => errors.push(e) });
  assert.equal(errors.length, 1); assert.throws(() => store.save({ value: 1 }), /unreadable at startup/);
  assert.deepEqual(readdirSync(file), []);
});
