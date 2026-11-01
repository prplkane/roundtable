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
  // claude and codex come from the plan table (adapters/models.js); agy is grouped by model
  assert.deepEqual(cat.claude.models.map((m) => m.id), ['opus', 'sonnet', 'claude-haiku-4-5', 'fable']);
  assert.equal(cat.claude.defaultLabel, 'Opus 5.5');
  assert.deepEqual(cat.codex.models.map((m) => m.id), ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra']);
  assert.deepEqual(cat.agy.families, [{ id: 'gemini-4-argon', label: 'Gemini 4 Argon', levels: ['medium'] }]);
  assert.match(cat.agy.pool, /Google/);
  // with nothing readable the static hints stand
  const bare = await vendorCatalogue({ agyModels: async () => [] });
  assert.deepEqual(bare.codex.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(bare.agy.models, []);
});

test('models by plan: grouped for the plan the CLI reports; a retired id is named with its replacement', async () => {
  const { modelsForPlan, retired, agyFamilies } = await import('../src/adapters/models.js');
  const plus = modelsForPlan('codex', 'plus');
  assert.deepEqual(plus.onPlan.map((m) => m.id), ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']);
  assert.deepEqual(plus.above.map((m) => [m.id, m.note]), [['gpt-6-astra', 'needs Pro']]);
  assert.equal(modelsForPlan('codex', 'prolite').above.length, 0, 'Pro (prolite) has them all');
  assert.equal(modelsForPlan('codex', 'free').onPlan.map((m) => m.id).join(), 'gpt-6-luna');
  const pro = modelsForPlan('claude', 'pro');
  assert.deepEqual(pro.above.map((m) => [m.id, m.note]), [['fable', 'may bill usage credits']]);
  assert.equal(modelsForPlan('claude', 'max').above.length, 0);
  assert.equal(modelsForPlan('codex', null).above.length, 0, 'an unknown plan hides nothing');
  assert.deepEqual(retired('codex', 'gpt-5.5'), { date: '2026-10-14', instead: 'gpt-6.1-sol' });
  assert.equal(retired('codex', 'gpt-6.1-sol'), null);
  const fams = agyFamilies([{ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' }, { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' }, { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }]);
  assert.deepEqual(fams, [{ id: 'gemini-4-argon', label: 'Gemini 4 Argon', levels: ['low', 'high'] }, { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', levels: ['medium'] }]);
});
