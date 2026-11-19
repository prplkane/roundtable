// Direct CLI choices for the setup screen. ACP profiles advertise their own session options.
import { ADAPTERS } from './config.js';
import { resolveBinary, runProcess, cleanEnv } from './spawn.js';
import { MODELS, agyFamilies } from './models.js';

// "gemini-4-argon-high\tGemini 4 Argon (High)" lines; anything else (the "Fetching..." line) is skipped.
export function parseAgyModels(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && /^[a-z0-9.-]+$/i.test(p[0].trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
}

export async function readAgyModels({ timeoutMs = 30_000 } = {}) {
  try {
    const res = await runProcess(resolveBinary('agy'), ['models'], { timeoutMs });
    return res.code === 0 ? parseAgyModels(res.stdout) : [];
  } catch { return []; }
}

export function parseCodexModels(text) {
  const rows = JSON.parse(text).models;
  if (!Array.isArray(rows)) return [];
  return rows.filter((m) => m?.visibility === 'list' && typeof m.slug === 'string' && m.slug.length > 0)
    .map((m) => {
      const hint = MODELS.codex.find((h) => h.id === m.slug);
      const efforts = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l) => l?.effort).filter((l) => typeof l === 'string') : null;
      return { id: m.slug, label: hint?.label || m.display_name || m.slug, ...(hint?.note ? { note: hint.note } : {}), ...(efforts ? { efforts } : {}) };
    });
}

export async function readCodexModels() {
  try {
    const bin = resolveBinary('codex', ADAPTERS.codex.npmBin);
    const res = await runProcess(bin, ['debug', 'models'], { timeoutMs: 10_000, env: cleanEnv() });
    return res.code === 0 ? parseCodexModels(res.stdout) : [];
  } catch { return []; }
}

// One object for the setup screen, per vendor: models, efforts, defaults, and the pool the
// vendor's quota is drawn against. `agyModels` is injectable so tests never spawn the CLI.
export async function vendorCatalogue({ agyModels = readAgyModels, codexModels = readCodexModels } = {}) {
  const [agy, codex] = await Promise.all([agyModels(), codexModels()]);
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
    if (vendor === 'codex') {
      entry.defaultLabel = 'CLI default';
      if (codex.length) {
        entry.models = codex;
        entry.efforts = [...new Set([...entry.efforts, ...codex.flatMap((m) => m.efforts || [])])];
      }
    }
    if (vendor === 'agy' && agy.length) {
      entry.models = agy;
      entry.families = agyFamilies(agy);
      entry.efforts = [...new Set([...entry.efforts, ...entry.families.flatMap((f) => f.levels)])];
    }
    out[vendor] = entry;
  }
  return out;
}
