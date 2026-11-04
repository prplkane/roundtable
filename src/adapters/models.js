// Model names and supported effort levels. Pure and browser-safe. Account access is decided
// by the vendor CLI, not inferred from a subscription name in the picker.
//
// From the vendors' own pages; re-check when a vendor ships or retires a model:
//   claude  https://code.claude.com/docs/en/model-config
//   codex   https://learn.chatgpt.com/docs/models
//   agy     `agy models` already lists what the signed-in account can use; nothing to add here.
//           Its quota groups (which limits a model counts against) are matched below.

export const MODELS = {
  claude: [
    { id: 'fable', label: 'Fable 5.1' },
    { id: 'opus', label: 'Opus 5.5', note: 'default' },
    { id: 'sonnet', label: 'Sonnet 5.5' },
    // Pin the intended Haiku version instead of relying on the CLI alias.
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'lightest' },
  ],
  codex: [
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
    // efforts: only where a model takes fewer levels than its vendor offers (`codex debug models`
    // supported_reasoning_levels: the Luna models stop at max)
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: 'lightest', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ],
};

// Broad capability tiers for the picker, not a benchmark ranking across vendors.
// Unknown models retain their provider order after the known families.
export function modelsByCapability(models = []) {
  const tier = (model) => {
    const name = `${model.id} ${model.label || ''}`.toLowerCase();
    for (const [pattern, rank] of [[/\b(fable|astra)\b/, 6], [/\b(opus|argon)\b|\bgemini\b.*\bpro\b/, 5], [/\b(sol|sonnet)\b/, 4], [/\bterra\b/, 3], [/\b(flash|120b)\b/, 2], [/\b(haiku|luna|20b)\b/, 1]]) {
      if (pattern.test(name)) return rank;
    }
    return 0;
  };
  return models.slice().sort((a, b) => tier(b) - tier(a));
}

// The effort levels a model takes: its vendor's levels, narrowed where the table names fewer.
// A model the table does not know (a typed id, the CLI default) keeps the vendor's levels.
export function modelEfforts(vendor, model, levels = []) {
  const known = (MODELS[vendor] || []).find((m) => m.id === String(model || '').trim());
  return known?.efforts ? levels.filter((l) => known.efforts.includes(l)) : levels;
}

// Retired for ChatGPT sign-in: a call with one of these fails. id -> [date, replacement].
export const RETIRED = {
  codex: {
    'gpt-5.5': ['2026-10-14', 'gpt-6.1-sol'], 'gpt-5.4': ['2026-08-31', 'gpt-6-sol'], 'gpt-5.4-mini': ['2026-08-31', 'gpt-6-luna'],
    'gpt-5.3-codex-spark': ['2026-09-14', 'gpt-6.1-sol'], 'gpt-5.3-codex': ['deprecated', 'gpt-6.1-sol'], 'gpt-5.2': ['deprecated', 'gpt-6.1-sol'],
  },
};

export function retired(vendor, id) {
  const r = RETIRED[vendor]?.[id];
  return r ? { date: r[0], instead: r[1] } : null;
}

// agy ids carry the effort level ("gemini-4-argon-high"): one entry per model, the levels it has.
export function agyFamilies(models = []) {
  const fam = new Map();
  for (const m of models) {
    const hit = /^(.*)-(low|medium|high)$/.exec(m.id);
    const id = hit ? hit[1] : m.id;
    const label = String(m.label || id).replace(/\s*\((low|medium|high)\)\s*$/i, '');
    if (!fam.has(id)) fam.set(id, { id, label, levels: [] });
    if (hit) fam.get(id).levels.push(hit[2]);
  }
  const order = ['low', 'medium', 'high'];
  return [...fam.values()].map((f) => ({ ...f, levels: f.levels.sort((a, b) => order.indexOf(a) - order.indexOf(b)) }));
}

// agy's quota comes in groups, each with its own windows (quota.js agyQuota). Which group a model
// draws on is read from the CLI's own words: every word of the group's name, or of a model the
// group lists ("Gemini Flash", "GPT-OSS"), is in the id. The longest such name wins. A model none
// of them names goes to the one group of its family, if there is only one: an Argon model on a
// plan without a separate Argon group counts against the Gemini group. null: no group can be
// told, and every window applies.
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
export function quotaGroup(groups, model) {
  const id = words(model);
  if (!id.length || !Array.isArray(groups)) return null;
  const names = (g) => [g.name, ...(g.models || [])].map(words);
  let best = null, score = 0;
  for (const g of groups) for (const w of names(g)) if (w.length > score && w.every((x) => id.includes(x))) { best = g.name; score = w.length; }
  if (best) return best;
  const family = groups.filter((g) => names(g).some((w) => w[0] === id[0]));
  return family.length === 1 ? family[0].name : null;
}

// The windows that apply to these models: their groups' when each model's group is known, else
// every window (a quota without groups, a default model, an id no group names).
export function quotaWindows(quota, models = []) {
  const windows = quota?.windows || [];
  if (!quota?.groups?.length) return windows;
  const groups = new Set();
  for (const m of [].concat(models)) {
    const g = quotaGroup(quota.groups, m);
    if (!g) return windows;
    groups.add(g);
  }
  return groups.size ? windows.filter((w) => groups.has(w.group)) : windows;
}
