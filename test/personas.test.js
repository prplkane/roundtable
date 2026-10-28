import test from 'node:test';
import assert from 'node:assert/strict';
import { HIDDEN_MOODS } from '../src/personas.js';
import { hiddenMood } from '../src/seats.js';
import { avatar } from '../src/ui/avatars.js';

test('every persona has distinct activation codes and its original pixel artwork', () => {
  const codes = HIDDEN_MOODS.flatMap((h) => h.codes);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(new Set(HIDDEN_MOODS.map((h) => h.art)).size, HIDDEN_MOODS.length);
  for (const h of HIDDEN_MOODS) {
    for (const code of h.codes) assert.equal(hiddenMood(code), h);
    assert.equal(h.sprite.length, 12);
    assert.ok(h.sprite.every((row) => /^[.X]{12}$/.test(row)));
    const rendered = avatar(h.art, h.sprite);
    assert.match(rendered, /<svg/);
    assert.match(rendered, /<rect/);
    assert.notEqual(rendered, avatar('custom'));
  }
});
