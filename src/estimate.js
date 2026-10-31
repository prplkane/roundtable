// The quota picture: how much a table is likely to draw from each vendor's pool, and how the
// measured windows move per round. Pure, so it runs in the browser and in tests.
//
// Baselines come from this machine's own transcripts (tokens per call, fresh round-0 calls and
// resumed later calls separately). Effort multipliers are guesses until measured deltas replace
// them; they live here and nowhere else.

export const EFFORT_MULTIPLIER = { low: 0.7, medium: 1, high: 1.4, xhigh: 1.8, ultra: 2.2, max: 2.6 };

export function unknownUsageMessage(cause) {
  const first = cause === 'timeout' ? 'An earlier call timed out before reporting token usage.'
    : cause === 'network' ? 'An earlier call lost its connection before reporting token usage.'
    : ['killed', 'interrupted'].includes(cause) ? 'An earlier call was interrupted before reporting token usage.'
    : 'An earlier call did not report complete token usage.';
  return `${first} Further calls are blocked because spending is unknown. Check the earlier failure and provider usage before starting more work.`;
}

// How much of a vendor's pool one token of a model draws, relative to the vendor's heaviest
// model (1). Guesses from list-price ratios: Opus : Sonnet : Haiku about 1 : 0.2 : 0.05;
// Gemini Pro-class : Flash about 1 : 0.2. An id that matches nothing weighs 1 (the safe side).
// A per-model calibration, once measured, replaces the weight (projectedWindows).
export const MODEL_WEIGHT = [
  [/haiku/i, 0.05], [/sonnet/i, 0.2], [/opus/i, 1],
  [/flash/i, 0.2], [/argon|pro\b/i, 1], [/gpt-oss/i, 0.1],
  [/mini|nano/i, 0.2],
];
export function modelWeight(model) {
  if (!model) return 1;
  for (const [re, w] of MODEL_WEIGHT) if (re.test(model)) return w;
  return 1;
}
// Used before any transcript exists. Taken from real debates; replaced by this machine's own medians as soon as it has some.
export const FALLBACK = {
  claude: { fresh: { input: 13000, output: 1500 }, resumed: { input: 9500, output: 1200 } },
  codex: { fresh: { input: 18000, output: 1200 }, resumed: { input: 34000, output: 1000 } },
  agy: { fresh: { input: 13000, output: 1300 }, resumed: { input: 30000, output: 1200 } },
};
const GENERIC = { fresh: { input: 15000, output: 1300 }, resumed: { input: 25000, output: 1100 } };
const CHAIRMAN_INPUT_FACTOR = 1.6; // the chairman reads the whole transcript in one fresh call

// Setup has no source bundle yet. Reserve an allowance per discussion/verdict call; after
// research, use the saved bundle's UTF-8 size at three bytes per estimated input token.
// This adds conservatism to historical baselines, not a tokenizer or a billing ceiling.
export const RESEARCH_INPUT_RESERVE = 12000;
export function researchInputTokens(sources = null) {
  if (!Array.isArray(sources)) return RESEARCH_INPUT_RESERVE;
  if (!sources.length) return 0;
  const records = sources.map(({ id, url, title, excerpt, publishedAt, gatheredAt }) =>
    JSON.stringify({ kind: 'web_source', id, url, title, publishedAt, gatheredAt, text: excerpt })
      .replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
  return Math.ceil(new TextEncoder().encode(records.join('\n')).length / 3);
}
const evidenceCost = (cost, baseline, tokens) => cost == null ? 0 : cost * 0.8 * tokens / baseline.input;

// median for dollar figures, kept to the cent
function median100(xs) { return Math.round(median(xs.map((x) => x * 100))) / 100; }

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Transcript rows (any number of debates) -> per-vendor medians per call.
export function baselinesFrom(rows) {
  const acc = {};
  for (const r of rows || []) {
    if (r.kind === 'research') continue; // web evidence gathering has a different context size
    if (!r.usage || !r.seat?.vendor) continue;
    if (r.type !== 'reply' && r.type !== 'verdict' && r.type !== 'attempt') continue;
    if (typeof r.sessionId === 'string' && r.sessionId.startsWith('fake-')) continue; // a scripted seat
    // Rows since 0.2.0 say whether the call resumed a session; older rows are fresh at round 0 only.
    const kind = r.type === 'verdict' || r.kind === 'verdict' || r.round === 0 || r.fresh === true ? 'fresh' : 'resumed';
    const v = (acc[r.seat.vendor] ??= { fresh: { input: [], output: [], cost: [] }, resumed: { input: [], output: [], cost: [] } });
    v[kind].input.push((r.usage.input || 0) + (r.usage.cacheRead || 0) + (r.usage.cacheWrite || 0));
    v[kind].output.push((r.usage.output || 0));
    // Cost in the vendor's own currency where the CLI reports it (claude: total_cost_usd per
    // call, exact and without lag). Kept per model too, since cost is where models differ most.
    if (typeof r.usage.cost === 'number') {
      v[kind].cost.push(r.usage.cost);
      const m = (acc[`${r.seat.vendor}:${r.seat.model || 'default'}`] ??= { fresh: { input: [], output: [], cost: [] }, resumed: { input: [], output: [], cost: [] } });
      m[kind].cost.push(r.usage.cost);
    }
  }
  const out = {};
  for (const [vendor, v] of Object.entries(acc)) {
    out[vendor] = {};
    for (const kind of ['fresh', 'resumed']) {
      out[vendor][kind] = { input: median(v[kind].input), output: median(v[kind].output), n: v[kind].input.length, cost: v[kind].cost.length ? median100(v[kind].cost) : null, nCost: v[kind].cost.length };
    }
  }
  return out;
}

function baseFor(vendor, kind, baselines) {
  const b = baselines?.[vendor]?.[kind];
  if (b && b.n > 0 && b.input > 0) return b;
  return (FALLBACK[vendor] || GENERIC)[kind];
}

// Projection for one debate: every seat answers round 0 fresh and every critique
// round fresh again (memory 'stateless', the default) or resumed ('resume'); the chairman makes
// one long fresh call. Effort scales output tokens only.
export function project({ seats, chairman, critiqueRounds = 3, baselines = {}, memory = 'stateless', research = null, sources = null }) {
  const bySeat = {}, byVendor = {};
  const extra = research ? researchInputTokens(sources) : 0;
  const add = (vendor, id, calls, model) => {
    const sum = calls.reduce((a, c) => ({ input: a.input + c.input, output: a.output + c.output }), { input: 0, output: 0 });
    const weight = modelWeight(model);
    const total = Math.round(sum.input + sum.output);
    // `weighted`: pool units, tokens times the model's weight; the pool bar and window share use it.
    const cost = calls.every((c) => typeof c.cost === 'number') ? Math.round(calls.reduce((a, c) => a + c.cost, 0) * 100) / 100 : null;
    const row = { vendor, id, model: model || null, weight, calls: calls.length, input: Math.round(sum.input), output: Math.round(sum.output), total, weighted: Math.round(total * weight), cost };
    bySeat[id] = row;
    const v = (byVendor[vendor] ??= { vendor, input: 0, output: 0, total: 0, weighted: 0, cost: null, seats: [] });
    v.input += row.input; v.output += row.output; v.total += row.total; v.weighted += row.weighted; v.seats.push(id);
    if (row.cost != null) v.cost = Math.round(((v.cost || 0) + row.cost) * 100) / 100;
  };
  // Dollar cost per call: the model's own median when measured, else the vendor's, scaled by the
  // effort multiplier on the output share only (prompt tokens are the bulk of a call's cost).
  const costFor = (vendor, model, kind) => {
    const own = baselines?.[`${vendor}:${model || 'default'}`]?.[kind];
    const b = (own?.nCost > 0 ? own : baselines?.[vendor]?.[kind]);
    return b && b.nCost > 0 ? b.cost : null;
  };
  for (const s of seats || []) {
    const m = EFFORT_MULTIPLIER[s.effort] ?? 1;
    const fresh = baseFor(s.vendor, 'fresh', baselines), resumed = baseFor(s.vendor, 'resumed', baselines);
    const cf = costFor(s.vendor, s.model, 'fresh'), cr = costFor(s.vendor, s.model, 'resumed');
    const calls = [{ input: fresh.input + extra, output: fresh.output * m, cost: cf == null ? undefined : cf * (0.8 + 0.2 * m) + evidenceCost(cf, fresh, extra) }];
    const later = memory === 'resume' ? { b: resumed, c: cr } : { b: fresh, c: cf };
    for (let r = 0; r < critiqueRounds; r++) calls.push({ input: later.b.input + extra, output: later.b.output * m, cost: later.c == null ? undefined : later.c * (0.8 + 0.2 * m) + evidenceCost(later.c, later.b, extra) });
    add(s.vendor, s.id, calls, s.model);
  }
  if (chairman?.vendor) {
    const m = EFFORT_MULTIPLIER[chairman.effort] ?? 1;
    const fresh = baseFor(chairman.vendor, 'fresh', baselines);
    const cc = costFor(chairman.vendor, chairman.model, 'fresh');
    add(chairman.vendor, 'chairman', [{ input: fresh.input * CHAIRMAN_INPUT_FACTOR + extra, output: fresh.output * 1.5 * m, cost: cc == null ? undefined : cc * CHAIRMAN_INPUT_FACTOR + evidenceCost(cc, fresh, extra) }], chairman.model);
  }
  if (research) {
    const selected = typeof research === 'object' ? research : {}; // the searcher's own vendor, model and effort
    const vendor = selected.vendor || 'codex';
    const fresh = baseFor(vendor, 'fresh', baselines), m = EFFORT_MULTIPLIER[selected.effort] ?? 1;
    add(vendor, 'research', [{ input: fresh.input * CHAIRMAN_INPUT_FACTOR, output: fresh.output * 1.5 * m }], selected.model);
  }
  const total = Object.values(byVendor).reduce((a, v) => a + v.total, 0);
  return { bySeat, byVendor, total, critiqueRounds };
}

// Two quota snapshots of one vendor -> per-window change. A window whose reset time moved has
// rolled over in between, so its delta is meaningless and marked invalid.
export function windowDeltas(prev, next) {
  if (!prev?.windows || !next?.windows) return [];
  return next.windows.map((w) => {
    const p = prev.windows.find((x) => x.label === w.label);
    if (!p) return { label: w.label, delta: 0, valid: false };
    const sameWindow = (p.resetsAt ?? null) === (w.resetsAt ?? null);
    const delta = w.used - p.used;
    return { label: w.label, delta, valid: sameWindow && delta >= 0 };
  });
}

// Vendors report window usage in whole percentage points and, at least for Claude, with a lag:
// a round rarely moves a window, and a move often lands a debate later. So the calibration is
// long-run: every valid round adds its tokens and its movement to one running total per key and
// window, and the rate is total movement over total tokens. Until the total has moved at all, the
// figure is a ceiling (less than one point per every token seen) that tightens with each token.
// A rolled-over window (reset time moved) contributes nothing for that round; the totals stand.
export const WINDOW_RESOLUTION = 0.01;

// calib: { [key]: { [label]: entry } }, key = vendor or vendor:model, entry =
//   { moved, tokens, rounds, samples, pctPerToken, pending, ceilPerToken, pctPerRound }
//   moved        total window movement seen (fraction of the window)
//   tokens       total tokens behind that movement
//   samples      rounds in which a whole-point move landed
//   pctPerToken  moved / tokens once moved > 0, else 0
//   pending      alias of tokens while unmoved (what the UI reports the ceiling over)
//   ceilPerToken resolution / tokens while unmoved
//   pctPerRound  mean movement per round (the pool row's coarse figure)
export function updateCalibration(calib, key, deltas, tokens, { resolution = WINDOW_RESOLUTION } = {}) {
  const out = { ...calib, [key]: { ...(calib?.[key] || {}) } };
  for (const d of deltas) {
    if (!(tokens > 0) || !d.valid) continue;
    const prev = out[key][d.label] || { moved: 0, tokens: 0, rounds: 0, samples: 0, pctPerRound: 0 };
    const moved = prev.moved + d.delta, total = prev.tokens + tokens, rounds = prev.rounds + 1;
    const samples = prev.samples + (d.delta >= resolution ? 1 : 0);
    out[key][d.label] = {
      moved, tokens: total, rounds, samples,
      pctPerToken: moved > 0 ? moved / total : 0,
      pending: moved > 0 ? 0 : total,
      ceilPerToken: moved > 0 ? null : resolution / total,
      pctPerRound: prev.pctPerRound + (d.delta - prev.pctPerRound) / rounds,
    };
  }
  return out;
}

// What one entry says a token costs: a measurement, or a ceiling, or nothing yet.
function rate(entry) {
  if (!entry) return null;
  if (entry.moved > 0 || entry.samples > 0) return { perToken: entry.pctPerToken, upperBound: false, samples: entry.samples, tokens: entry.tokens };
  if (entry.ceilPerToken) return { perToken: entry.ceilPerToken, upperBound: true, samples: 0, pending: entry.pending };
  return null;
}

// Projected share of each window for one vendor's seats. calib is the whole calibration map,
// keyed `vendor` and `vendor:model`. A seat uses its model's own measurement when one exists,
// otherwise the vendor's measurement scaled by the model weight. null when nothing is measured.
export function projectedWindows(calib, vendor, seatRows) {
  const base = calib?.[vendor];
  const labels = new Set();
  for (const key of Object.keys(calib || {})) if (key === vendor || key.startsWith(`${vendor}:`)) for (const l of Object.keys(calib[key])) labels.add(l);
  if (!labels.size) return null;
  const out = [];
  for (const label of labels) {
    let pct = 0, samples = 0, any = false, upperBound = false, pending = 0;
    for (const row of seatRows || []) {
      // The model's own measurement wins. Otherwise the vendor's rate times the model weight,
      // capped by the model's own ceiling when that ceiling is the lower figure.
      const own = rate(calib?.[`${vendor}:${row.model || 'default'}`]?.[label]);
      const b = rate(base?.[label]);
      let pick = null;
      if (own && !own.upperBound) pick = { ...own, weight: 1 };
      else if (b && !b.upperBound) {
        const weighted = b.perToken * (row.weight ?? modelWeight(row.model));
        pick = own && own.perToken < weighted ? { ...own, weight: 1 } : { ...b, weight: row.weight ?? modelWeight(row.model) };
      } else if (own || b) {
        const o = own ? own.perToken : Infinity, v = b ? b.perToken * (row.weight ?? modelWeight(row.model)) : Infinity;
        pick = o <= v ? { ...own, weight: 1 } : { ...b, weight: row.weight ?? modelWeight(row.model) };
      }
      if (!pick) continue;
      pct += pick.perToken * row.total * pick.weight; samples += pick.samples; any = true;
      upperBound ||= pick.upperBound; pending = Math.max(pending, pick.pending || 0);
    }
    // upperBound: the window has not moved a whole point over `pending` tokens, so the figure is
    // "less than this", tightening as tokens accumulate; otherwise it is a measurement.
    if (any) out.push({ label, pct, samples, upperBound, pending });
  }
  return out.length ? out : null;
}

// What one round is likely to draw per vendor, before it runs: each seat's fresh or resumed
// baseline (fresh at round 0 and in stateless memory), effort on the output share. Used by the
// engine's budget gate. Returns { [vendor]: { tokens, cost|null, seats } }.
export function projectRound({ seats, round, baselines = {}, memory = 'stateless', researchTokens = 0 }) {
  const out = {};
  for (const s of seats || []) {
    const kind = round === 0 || memory !== 'resume' ? 'fresh' : 'resumed';
    const b = baseFor(s.vendor, kind, baselines);
    const m = EFFORT_MULTIPLIER[s.effort] ?? 1;
    const own = baselines?.[`${s.vendor}:${s.model || 'default'}`]?.[kind];
    const cb = own?.nCost > 0 ? own : baselines?.[s.vendor]?.[kind];
    const cost = cb && cb.nCost > 0 ? cb.cost * (0.8 + 0.2 * m) + evidenceCost(cb.cost, b, researchTokens) : null;
    const v = (out[s.vendor] ??= { tokens: 0, cost: null, seats: 0 });
    v.tokens += Math.round(b.input + researchTokens + b.output * m);
    v.seats++;
    if (cost != null) v.cost = Math.round(((v.cost || 0) + cost) * 100) / 100;
  }
  return out;
}

// The chairman's one long fresh call, same units.
export function projectChairman({ chairman, baselines = {}, researchTokens = 0 }) {
  if (!chairman?.vendor) return {};
  const b = baseFor(chairman.vendor, 'fresh', baselines);
  const m = EFFORT_MULTIPLIER[chairman.effort] ?? 1;
  const own = baselines?.[`${chairman.vendor}:${chairman.model || 'default'}`]?.fresh;
  const cb = own?.nCost > 0 ? own : baselines?.[chairman.vendor]?.fresh;
  const cost = cb && cb.nCost > 0 ? Math.round((cb.cost * CHAIRMAN_INPUT_FACTOR + evidenceCost(cb.cost, b, researchTokens)) * 100) / 100 : null;
  return { [chairman.vendor]: { tokens: Math.round(b.input * CHAIRMAN_INPUT_FACTOR + researchTokens + b.output * 1.5 * m), cost, seats: 1 } };
}

// Would running `next` ({vendor: {tokens, cost}}) on top of `spent` cross `budget`
// ({vendor: {tokens?, usd?}})? Returns the first crossing, or null.
export function budgetCheck(budget, spent, next) {
  for (const [vendor, cap] of Object.entries(budget || {})) {
    if (!cap) continue;
    // No new call to this vendor adds zero cost. An actual call whose projection is unknown
    // still carries cost: null and must be refused under a dollar cap.
    const s = spent?.[vendor] || { tokens: 0, cost: 0 }, n = next?.[vendor] || { tokens: 0, cost: 0 };
    if (cap.tokens > 0 && s.tokensUnknown && next?.[vendor]) return { vendor, kind: 'tokens-unknown', spent: s.tokens, projected: n.tokens, cap: cap.tokens };
    if (cap.tokens > 0 && s.tokens + n.tokens > cap.tokens) return { vendor, kind: 'tokens', spent: s.tokens, projected: n.tokens, cap: cap.tokens };
    // A dollar cap cannot be checked against a cost nobody reported: that is a crossing of its
    // own kind, not a zero.
    if (cap.usd > 0 && (s.costUnknown || n.cost == null)) return { vendor, kind: 'usd-unknown', spent: Math.round((s.cost || 0) * 100) / 100, projected: n.cost ?? null, cap: cap.usd };
    if (cap.usd > 0 && (s.cost || 0) + (n.cost || 0) > cap.usd) return { vendor, kind: 'usd', spent: Math.round((s.cost || 0) * 100) / 100, projected: n.cost, cap: cap.usd };
  }
  return null;
}

// Calibration on disk divides a window's move by the tokens a round spent. Before usage version 3
// a 'subset' vendor's tokens counted its cached input twice (Codex), so its rates are too low:
// drop those entries (the vendor and its vendor:model keys) once, and mark the file version 3.
// Entries for other vendors measured the same tokens then as now and are kept.
export const CALIBRATION_VERSION = 3;
export function migrateCalibration(file, { subsetVendors = [] } = {}) {
  if (!file || typeof file !== 'object') return { calibration: {}, dropped: [] };
  const { _version, ...entries } = file;
  if (_version >= CALIBRATION_VERSION) return { calibration: entries, dropped: [] };
  const dropped = Object.keys(entries).filter((k) => subsetVendors.includes(k.split('@')[0].split(':')[0]));
  for (const k of dropped) delete entries[k];
  return { calibration: entries, dropped };
}
