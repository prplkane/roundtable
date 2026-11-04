import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgyModels, vendorCatalogue } from '../src/adapters/catalogue.js';

test('parseAgyModels keeps "<id>\\t<label>" lines and drops the status line', () => {
  const out = 'Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n\n';
  assert.deepEqual(parseAgyModels(out), [
    { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
  ]);
});

test('vendorCatalogue merges the agy list over the static hints; codex never quotes config.toml, which the seat ignores', async () => {
  const cat = await vendorCatalogue({
    agyModels: async () => [{ id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' }],
  });
  // --ignore-user-config: the seat runs on the CLI's own default, whatever ~/.codex/config.toml says
  assert.equal(cat.codex.defaultModel, null);
  assert.equal(cat.codex.defaultEffort, null);
  assert.equal(cat.codex.defaultLabel, 'CLI default');
  assert.deepEqual(cat.codex.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(cat.agy.models, [{ id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' }]);
  assert.equal(cat.agy.effortInModel, true);
  // claude and codex come from the model table (adapters/models.js); agy is grouped by model
  assert.deepEqual(cat.claude.models.map((m) => m.id), ['fable', 'opus', 'sonnet', 'claude-haiku-4-5']);
  assert.equal(cat.claude.defaultLabel, 'Opus 5.5');
  assert.deepEqual(cat.codex.models.map((m) => m.id), ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6.1-terra', 'gpt-6-luna']);
  assert.deepEqual(cat.agy.families, [{ id: 'gemini-4-argon', label: 'Gemini 4 Argon', levels: ['medium'] }]);
  assert.match(cat.agy.pool, /Google/);
  // with nothing readable the static hints stand
  const bare = await vendorCatalogue({ agyModels: async () => [] });
  assert.deepEqual(bare.codex.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(bare.agy.models, []);
});

test('model names carry only default and lightest notes; a retired id is named with its replacement', async () => {
  const { MODELS, retired, agyFamilies } = await import('../src/adapters/models.js');
  assert.deepEqual(MODELS.codex.map((m) => [m.label, m.note || null]), [
    ['GPT-6 Astra', null], ['GPT-6.1 Sol', null], ['GPT-6 Sol', null], ['GPT-6.1 Terra', null], ['GPT-6 Luna', 'lightest'],
  ]);
  assert.deepEqual(MODELS.claude.map((m) => [m.label, m.note || null]), [
    ['Fable 5.1', null], ['Opus 5.5', 'default'], ['Sonnet 5.5', null], ['Haiku 4.5', 'lightest'],
  ]);
  assert.deepEqual(retired('codex', 'gpt-5.5'), { date: '2026-10-14', instead: 'gpt-6.1-sol' });
  assert.equal(retired('codex', 'gpt-6.1-sol'), null);
  const fams = agyFamilies([{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' }, { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' }, { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }]);
  assert.deepEqual(fams, [{ id: 'gemini-4-argon', label: 'Gemini 4 Argon', levels: ['low', 'high'] }, { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', levels: ['medium'] }]);
});

test('model pickers put stronger families first and keep unknown models', async () => {
  const { modelsByCapability, MODELS } = await import('../src/adapters/models.js');
  assert.deepEqual(modelsByCapability(MODELS.claude).map((m) => m.id), ['fable', 'opus', 'sonnet', 'claude-haiku-4-5']);
  const mixed = ['gemini-4-flash', 'claude-haiku-4-5', 'claude-opus-5-5', 'gemini-4-argon', 'claude-sonnet-5-5', 'new-model'].map((id) => ({ id }));
  assert.deepEqual(modelsByCapability(mixed).map((m) => m.id), ['claude-opus-5-5', 'gemini-4-argon', 'claude-sonnet-5-5', 'gemini-4-flash', 'claude-haiku-4-5', 'new-model']);
  assert.equal(mixed[0].id, 'gemini-4-flash', 'sorting must not mutate the catalogue');
});
