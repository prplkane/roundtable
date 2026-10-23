// Which models each vendor offers, and from which plan up. Pure and browser-safe: the setup
// screen groups a seat's model picker by the plan the CLI reports for that login.
//
// From the vendors' own pages; re-check when a vendor ships or retires a model:
//   claude  https://code.claude.com/docs/en/model-config (aliases; Opus 5.5 is the default on Pro
//           and Max; Fable "may bill to usage credits depending on plan"; no per-plan split given)
//   codex   https://learn.chatgpt.com/docs/models and /docs/pricing (gpt-6.1-sol from Plus up;
//           gpt-6-luna on every plan; gpt-6-astra powers "GPT-6 Pro" on Pro and Business; retired
//           ids below)
//   agy     `agy models` already lists what the signed-in account can use; nothing to add here.

// Plan names as the CLIs report them (claude: `claude auth status` subscriptionType; codex: the
// app-server's planType), ranked so "from Plus up" can be compared.
export const PLANS = {
  claude: { free: [0, 'Free'], pro: [1, 'Pro'], max: [2, 'Max'], team: [2, 'Team'], enterprise: [2, 'Enterprise'] },
  codex: { free: [0, 'Free'], go: [1, 'Go'], plus: [2, 'Plus'], business: [2, 'Business'], enterprise: [2, 'Enterprise'], edu: [2, 'Edu'], prolite: [3, 'Pro'], pro: [3, 'Pro'] },
};

// min: the lowest plan that includes the model; below: what it means under that plan.
export const MODELS = {
  claude: [
    { id: 'opus', label: 'Opus 5.5', min: 'pro', note: 'the default' },
    { id: 'sonnet', label: 'Sonnet 5.5', min: 'pro' },
    { id: 'haiku', label: 'Haiku 5.5', min: 'pro', note: 'lightest' },
    { id: 'fable', label: 'Fable 5.1', min: 'max', below: 'may bill usage credits' },
  ],
  codex: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', min: 'plus' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', min: 'plus' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', min: 'free', note: 'lightest' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra', min: 'prolite', note: 'GPT-6 Pro' },
  ],
};

// Retired for ChatGPT sign-in: a call with one of these fails. id -> [date, replacement].
export const RETIRED = {
  codex: {
    'gpt-5.5': ['2026-10-14', 'gpt-6.1-sol'], 'gpt-5.4': ['2026-08-31', 'gpt-6-sol'], 'gpt-5.4-mini': ['2026-08-31', 'gpt-6-luna'],
    'gpt-5.3-codex-spark': ['2026-09-14', 'gpt-6.1-sol'], 'gpt-5.3-codex': ['deprecated', 'gpt-6.1-sol'], 'gpt-5.2': ['deprecated', 'gpt-6.1-sol'],
  },
};

export function planLabel(vendor, plan) { return PLANS[vendor]?.[plan]?.[1] || (plan ? String(plan) : null); }

// The vendor's models split by the login's plan: on it, or needing more. An unknown plan (not
// reported yet, or a vendor without plans here) puts every model on the plan and keeps the notes.
export function modelsForPlan(vendor, plan, models = MODELS[vendor] || []) {
  const ranks = PLANS[vendor];
  const have = ranks?.[plan]?.[0];
  const onPlan = [], above = [];
  for (const m of models) {
    const need = ranks?.[m.min]?.[0];
    if (have == null || need == null || have >= need) onPlan.push(m);
    else above.push({ ...m, note: m.below || `needs ${planLabel(vendor, m.min)}` });
  }
  return { onPlan, above, plan: planLabel(vendor, plan) };
}

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
