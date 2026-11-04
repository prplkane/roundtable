// What each vendor can be asked for: model ids and effort levels, from the sources that exist.
//
//  claude  no list command headless; the aliases in config.js are the hints
//  codex   the model table in models.js and the levels in config.js. Not ~/.codex/config.toml: the
//          seat runs with --ignore-user-config, so that file cannot describe its defaults
//  agy     `agy models` prints "<id>\t<label>" lines (slow: a network call), cached after one read
import { ADAPTERS } from './config.js';
import { resolveBinary, runProcess } from './spawn.js';
import { MODELS, agyFamilies } from './models.js';

// "gemini-4-argon-high\tGemini 4 Argon (High)" lines; anything else (the "Fetching..." line) is skipped.
export function parseAgyModels(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && /^[a-z0-9.-]+$/i.test(p[0].trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
}

let agyCache = null;
export async function readAgyModels({ timeoutMs = 30_000 } = {}) {
  if (agyCache) return agyCache;
  try {
    const bin = resolveBinary('agy');
    const res = await runProcess(bin, ['models'], { timeoutMs });
    const models = parseAgyModels(res.stdout);
    if (models.length) agyCache = models;
    return models;
  } catch { return []; }
}

// One object for the setup screen, per vendor: models, efforts, defaults, and the pool the
// vendor's quota is drawn against. `agyModels` is injectable so tests never spawn the CLI.
export async function vendorCatalogue({ agyModels = readAgyModels } = {}) {
  const agy = await agyModels();
  const out = {};
  for (const [vendor, a] of Object.entries(ADAPTERS)) {
    const entry = {
      models: a.modelHints.map((id) => ({ id, label: id })), efforts: a.effortLevels,
      defaultModel: null, defaultEffort: null, pool: a.pool, effortInModel: !!a.effortInModel,
    };
    // claude and codex: the model table (models.js); the CLI's own default named where it is known
    if (MODELS[vendor]) entry.models = MODELS[vendor].slice();
    if (vendor === 'claude') entry.defaultLabel = 'Opus 5.5';
    // The installed CLI chooses its default; a static model table cannot establish it.
    if (vendor === 'codex') entry.defaultLabel = 'CLI default';
    if (vendor === 'agy' && agy.length) { entry.models = agy; entry.families = agyFamilies(agy); }
    out[vendor] = entry;
  }
  return out;
}
