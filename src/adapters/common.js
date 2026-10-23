import { ADAPTERS, ARGV_LIMIT } from './config.js';
import { resolveBinary, runProcess, cleanEnv } from './spawn.js';
import { mkdirSync } from 'node:fs';
import { classifyError } from './errors.js';

export function dig(obj, dotPath) {
  if (!dotPath || obj == null) return undefined;
  return dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function parseLines(text) {
  return text.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// Pull the normalised fields out of one JSON object using the config's dot paths.
export function pickJson(obj, paths) {
  const n = (p) => { const v = dig(obj, p); return typeof v === 'number' ? v : 0; };
  return {
    text: String(dig(obj, paths.text) ?? ''),
    sessionId: dig(obj, paths.sessionId) ?? null,
    usage: { input: n(paths.input), cacheRead: n(paths.cacheRead), cacheWrite: n(paths.cacheWrite),
      output: n(paths.output), thinking: n(paths.thinking) },
    cost: paths.cost ? (dig(obj, paths.cost) ?? null) : null,
    quota: paths.quota ? (dig(obj, paths.quota) ?? null) : null,
    isError: paths.isError ? dig(obj, paths.isError) === true : false,
  };
}

// Same for a JSONL stream: each path names the event type that carries the value.
export function pickJsonl(text, paths) {
  const events = parseLines(text);
  const find = (spec) => {
    if (!spec) return undefined;
    const [type, p, where] = spec;
    let hit;
    for (const e of events) {
      if (e.type !== type) continue;
      if (where && !Object.entries(where).every(([k, v]) => dig(e, k) === v)) continue;
      hit = dig(e, p); // keep the last match
    }
    return hit;
  };
  const n = (spec) => { const v = find(spec); return typeof v === 'number' ? v : 0; };
  return {
    text: String(find(paths.text) ?? ''),
    sessionId: find(paths.sessionId) ?? null,
    usage: { input: n(paths.input), cacheRead: n(paths.cacheRead), cacheWrite: n(paths.cacheWrite),
      output: n(paths.output), thinking: n(paths.thinking) },
    cost: paths.cost ? (find(paths.cost) ?? null) : null,
    quota: paths.quota ? (find(paths.quota) ?? null) : null, // raw vendor object; quota.js normalises
    isError: paths.isError ? find(paths.isError) === true : false,
  };
}

const lastCost = new Map(); // sessionId -> cumulative cost already charged (this process only)

// One meaning for every vendor: `input` is input not served from cache, so input + cacheRead +
// cacheWrite is everything the model read. The vendor's own numbers stay under `raw`.
export const USAGE_VERSION = 3;
export function normaliseUsage(cfg, u, rawCost = null) {
  const raw = { input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output, thinking: u.thinking, ...(rawCost != null ? { cost: rawCost } : {}) };
  const semantics = cfg.cacheSemantics || 'unknown';
  const input = semantics === 'subset' ? Math.max(0, u.input - u.cacheRead) : u.input;
  return { ...u, input, raw, usageVersion: USAGE_VERSION, cacheSemantics: semantics };
}

// Turn a config row plus (prompt, sessionId, model, effort) into argv and stdin. Pure, so it is unit tested.
export function buildArgs(cfg, { prompt, sessionId = null, model = null, effort = null }) {
  const useStdin = cfg.promptVia === 'stdin' ||
    (cfg.promptVia === 'argv-or-stdin' && prompt.length > ARGV_LIMIT);
  const streamMode = useStdin && !!cfg.stdinArgs;
  const base = streamMode ? cfg.stdinArgs : cfg.args;
  const args = sessionId ? cfg.resume(sessionId, base) : [...base];
  const extra = [];
  if (model && cfg.model) extra.push(...cfg.model(model));
  // Skip the effort flag when the model id already names the level (agy), so nothing is said twice.
  if (effort && cfg.effort && !(model && cfg.effortInModel && cfg.effortInModel.test(model))) extra.push(...cfg.effort(effort));
  if (extra.length) {
    const at = args[args.length - 1] === '-' ? args.length - 1 : args.length;
    args.splice(at, 0, ...extra);
  }
  let stdin = null;
  if (useStdin) stdin = cfg.stdinWrap ? cfg.stdinWrap(prompt) : prompt;
  else args.push(cfg.argvFlag + prompt);
  return { args, stdin, streamMode };
}

// Build a run(prompt, sessionId, opts) for one config row. All three adapters are this
// function with a different row; the per-CLI files exist so a vendor quirk has a home.
export function makeAdapter(name, overrides = {}) {
  const cfg = { ...ADAPTERS[name], ...overrides };
  let bin = null;

  // Every failure leaves the adapter classified (errors.js): kind, a plain message, a reset time.
  return async function run(prompt, sessionId = null, opts = {}) {
    try { return await runOnce(prompt, sessionId, opts); } catch (e) {
      const c = classifyError({ message: e.message, stdout: e.raw?.stdout ?? e.stdout ?? '', stderr: e.raw?.stderr ?? e.stderr ?? '', code: e.code, label: cfg.label });
      throw Object.assign(e, { kind: c.kind, resetsAt: c.resetsAt, detail: c.detail, message: c.kind === 'other' ? e.message : c.message });
    }
  };

  async function runOnce(prompt, sessionId = null, opts = {}) {
    bin ??= cfg.bin || resolveBinary(cfg.binary, cfg.npmBin); // cfg.bin: a test's fake CLI
    const { args, stdin, streamMode } = buildArgs(cfg, { prompt, sessionId, model: opts.model, effort: opts.effort });

    // opts.home: the directory of a named profile's CLI state (spawn.js profileHome). Only
    // vendors with a `home` entry honour it. It is created empty and never seeded: the user logs
    // that profile in once (`node src/doctor.js` prints how), and the CLI keeps its login there.
    let home = null;
    if (opts.home && cfg.home) { mkdirSync(opts.home, { recursive: true }); home = { env: cfg.home.env, dir: opts.home }; }
    if (opts.cwd) mkdirSync(opts.cwd, { recursive: true }); // a missing cwd makes spawn fail with ENOENT
    const res = await runProcess(bin, args, {
      stdin, cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 300_000, env: cleanEnv(home), tag: opts.tag ?? null,
    });
    const raw = {
      args: args.map((a) => (a.length > 200 ? a.slice(0, 200) + '...' : a)),
      stdout: res.stdout, stderr: res.stderr, code: res.code, ms: res.ms,
    };

    let picked, usedTools = false;
    if (streamMode) {
      // stream-json: the final line is {"event":"result","result":{...json shape...}}
      const events = parseLines(res.stdout);
      const last = events.filter((e) => e.event === 'result').pop();
      const obj = last ? last.result : {};
      picked = pickJson(obj, cfg.paths);
      usedTools = !!cfg.usedTools?.(obj, events);
    } else if (cfg.output === 'jsonl') {
      picked = pickJsonl(res.stdout, cfg.paths);
      usedTools = !!cfg.usedTools?.(parseLines(res.stdout));
    } else {
      let obj = {};
      try { obj = JSON.parse(res.stdout); } catch { /* reported below */ }
      picked = pickJson(obj, cfg.paths);
      usedTools = !!cfg.usedTools?.(obj);
    }

    if (!picked.text) {
      const hint = (res.stderr || res.stdout).trim().split('\n').pop() || `exit ${res.code}`;
      throw Object.assign(new Error(`${cfg.label}: empty reply (${hint.slice(0, 200)})`), { raw });
    }
    // The CLI answered with an error as its result (claude: a usage limit, a lapsed login). That
    // text is not a reply; what the call cost still counts.
    if (picked.isError) throw Object.assign(new Error(`${cfg.label}: ${picked.text.trim().slice(0, 300)}`), { raw, usage: normaliseUsage(cfg, picked.usage) });

    // A cumulative counter is charged as the difference from the session's previous reading.
    // opts.prevCost is that reading from the transcript (survives a restart); the in-process map
    // is the fallback. A fresh call (no sessionId) starts at zero.
    let cost = picked.cost;
    if (cfg.costIsCumulative && typeof cost === 'number') {
      const key = picked.sessionId || sessionId;
      const prev = !sessionId ? 0 : typeof opts.prevCost === 'number' ? opts.prevCost : (lastCost.get(key) || 0);
      lastCost.set(key, cost);
      cost = Math.max(0, cost - prev);
    }
    const usage = { ...normaliseUsage(cfg, picked.usage, typeof picked.cost === 'number' ? picked.cost : null), cost: typeof cost === 'number' ? cost : null, ms: res.ms };
    const quota = cfg.normaliseQuota && picked.quota ? cfg.normaliseQuota(picked.quota) : null;
    return { text: picked.text.trim(), usage, sessionId: picked.sessionId, quota, usedTools, raw };
  }
}

// Exposed for tests and doctor: the same detection on captured output.
export function detectToolUse(name, stdout) {
  const cfg = ADAPTERS[name];
  if (cfg.output === 'jsonl') return !!cfg.usedTools?.(parseLines(stdout));
  let obj = {}; try { obj = JSON.parse(stdout); } catch { /* not json */ }
  return !!cfg.usedTools?.(obj);
}
