// What each vendor can be asked for: model ids and effort levels, from the sources that exist.
//
//  claude  no list command headless; the aliases in config.js are the hints
//  codex   `model =`, `model_reasoning_effort =` and `enabled-reasoning-efforts` in ~/.codex/config.toml
//  agy     `agy models` prints "<id>\t<label>" lines (slow: a network call), cached after one read
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ADAPTERS } from './config.js';
import { resolveBinary, runProcess } from './spawn.js';
import { MODELS, agyFamilies, retired } from './models.js';

// Enough TOML for the three keys we need: `key = "string"` and `key = ["a", "b"]`.
export function parseCodexConfig(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (raw.startsWith('[')) out[key] = [...raw.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    else if (raw.startsWith('"')) out[key] = raw.slice(1, raw.lastIndexOf('"'));
  }
  return out;
}

// "gemini-4-argon-high\tGemini 4 Argon (High)" lines; anything else (the "Fetching..." line) is skipped.
export function parseAgyModels(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && /^[a-z0-9.-]+$/i.test(p[0].trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
}

function readCodexConfig() {
  try { return parseCodexConfig(readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8')); } catch { return {}; }
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
export async function vendorCatalogue({ agyModels = readAgyModels, codexConfig = readCodexConfig } = {}) {
  const codex = codexConfig();
  const agy = await agyModels();
  const out = {};
  for (const [vendor, a] of Object.entries(ADAPTERS)) {
    const entry = {
      models: a.modelHints.map((id) => ({ id, label: id })), efforts: a.effortLevels,
      defaultModel: null, defaultEffort: null, pool: a.pool, effortInModel: !!a.effortInModel,
    };
    // claude and codex: the plan table (models.js); the CLI's own default named where it is known
    if (MODELS[vendor]) entry.models = MODELS[vendor].slice();
    if (vendor === 'claude') entry.defaultLabel = 'Opus 5.5';
    if (vendor === 'codex') {
      entry.defaultLabel = 'recommended';
      if (codex.model) {
        entry.defaultModel = codex.model;
        const known = entry.models.find((m) => m.id === codex.model);
        const r = retired('codex', codex.model);
        entry.defaultLabel = r ? `${codex.model}, retired ${r.date}` : known ? known.label : codex.model;
        if (!known && !r) entry.models.push({ id: codex.model, label: `${codex.model} (config.toml)`, min: 'free' });
      }
      if (codex.model_reasoning_effort) entry.defaultEffort = codex.model_reasoning_effort;
      const enabled = codex['enabled-reasoning-efforts'];
      if (Array.isArray(enabled) && enabled.length) entry.efforts = enabled;
    }
    if (vendor === 'agy' && agy.length) { entry.models = agy; entry.families = agyFamilies(agy); }
    out[vendor] = entry;
  }
  return out;
}
