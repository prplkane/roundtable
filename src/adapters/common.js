import { ADAPTERS, ARGV_LIMIT } from './config.js';
import { resolveBinary, runProcess, cleanEnv } from './spawn.js';
import { mkdirSync } from 'node:fs';
import { classifyError } from './errors.js';
import { safeProgress, progressText } from '../progress.js';
import { researchSettings, researchObserver } from '../research.js';

export function dig(obj, dotPath) {
  if (!dotPath || obj == null) return undefined;
  return dotPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function parseLines(text) {
  return text.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// Input and output are required measurements. Optional breakdowns may be absent, but an
// invalid counter is not a measured zero. This distinction is also used by HTTP endpoints.
export function usageCounters({ input, output, cacheRead, cacheWrite, thinking }) {
  const u = { input, output, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0, thinking: thinking ?? 0 };
  return Object.values(u).every((v) => Number.isSafeInteger(v) && v >= 0) ? u : null;
}
const reportedCost = (v) => Number.isFinite(v) && v >= 0 ? v : null;

// Pull the normalised fields out of one JSON object using the config's dot paths.
export function pickJson(obj, paths) {
  const n = (p) => dig(obj, p);
  return {
    text: String(dig(obj, paths.text) ?? ''),
    sessionId: dig(obj, paths.sessionId) ?? null,
    usage: usageCounters({ input: n(paths.input), cacheRead: n(paths.cacheRead), cacheWrite: n(paths.cacheWrite),
      output: n(paths.output), thinking: n(paths.thinking) }),
    cost: reportedCost(dig(obj, paths.cost)),
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
  return {
    text: String(find(paths.text) ?? ''),
    sessionId: find(paths.sessionId) ?? null,
    usage: usageCounters({ input: find(paths.input), cacheRead: find(paths.cacheRead), cacheWrite: find(paths.cacheWrite),
      output: find(paths.output), thinking: find(paths.thinking) }),
    cost: reportedCost(find(paths.cost)),
    quota: paths.quota ? (find(paths.quota) ?? null) : null, // raw vendor object; quota.js normalises
    isError: paths.isError ? find(paths.isError) === true : false,
  };
}

const lastCost = new Map(); // sessionId -> cumulative cost already charged (this process only)

// One meaning for every vendor: `input` is input not served from cache, so input + cacheRead +
// cacheWrite is everything the model read. The vendor's own numbers stay under `raw`.
export const USAGE_VERSION = 3;
export function normaliseUsage(cfg, u, rawCost = null) {
  if (!u) return null;
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
      throw Object.assign(e, { kind: c.kind, resetsAt: c.resetsAt, detail: c.detail, message: c.kind === 'timeout'
        ? `${c.message} ${progressText(e.progress)} Save the error log before retrying. Missing usage remains unknown.`
        : c.kind === 'other' ? e.message : c.message });
    }
  };

  async function runOnce(prompt, sessionId = null, opts = {}) {
    const research = opts.research ? researchSettings(opts.research) : null;
    if (research && (name !== 'codex' || sessionId)) throw Object.assign(new Error('Research requires one fresh Codex CLI call.'), { code: 'RESEARCH_INVALID' });
    const observer = research ? researchObserver(research) : null;
    if (cfg.limitedIsolation && !opts.allowLimitedIsolation) throw Object.assign(new Error('Explicit consent to limited isolation is required.'), { code: 'ISOLATION_REQUIRED' });
    bin ??= cfg.bin || resolveBinary(cfg.binary, cfg.npmBin); // cfg.bin: a test's fake CLI
    const { args, stdin, streamMode } = buildArgs(cfg, { prompt, sessionId, model: opts.model, effort: opts.effort });
    if (research) {
      const index = args.indexOf('web_search="disabled"');
      if (index < 0) throw Object.assign(new Error('Research needs the supported Codex restriction flags.'), { code: 'RESEARCH_INVALID' });
      args[index] = 'web_search="live"';
    }

    // opts.home: the directory of a named profile's CLI state (spawn.js profileHome). Only
    // vendors with a `home` entry honour it. It is created empty and never seeded: the user logs
    // that profile in once (`node src/doctor.js` prints how), and the CLI keeps its login there.
    let home = null;
    if (opts.home && cfg.home) { mkdirSync(opts.home, { recursive: true }); home = { env: cfg.home.env, dir: opts.home }; }
    if (opts.cwd) mkdirSync(opts.cwd, { recursive: true }); // a missing cwd makes spawn fail with ENOENT
    let pendingLine = '', processError = null, res, eventCount = 0, stage = 'waiting';
    const inspect = (chunk) => {
      pendingLine += chunk;
      let end;
      while ((end = pendingLine.indexOf('\n')) >= 0) {
        const line = pendingLine.slice(0, end).trim();
        pendingLine = pendingLine.slice(end + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { throw Object.assign(new Error('Provider emitted an invalid JSON event.'), { code: 'PROVIDER_PROTOCOL' }); }
        eventCount++;
        if (event?.type === 'turn.completed' || event?.type === 'result' || event?.event === 'result') stage = 'completed';
        else if (event?.item?.type === 'reasoning' || event?.message?.content?.some?.((c) => c?.type === 'thinking')) stage = 'reasoning';
        else if (event?.item?.type === 'agent_message' || event?.type === 'assistant') stage = 'reply';
        else if (stage === 'waiting') stage = 'started';
        const allowedSearch = observer?.accept(event);
        const tool = allowedSearch ? false : streamMode ? cfg.usedTools?.(event.event === 'result' ? event.result : {}, [event])
          : cfg.output === 'jsonl' ? cfg.usedTools?.([event]) : cfg.usedTools?.(event);
        if (tool) { stage = 'tool'; throw Object.assign(new Error('Provider reported prohibited tool activity.'), { code: 'TOOL_POLICY', usedTools: true }); }
      }
      if (pendingLine.length > 1024 * 1024) throw Object.assign(new Error('Provider event exceeded the local size limit.'), { code: 'OUTPUT_LIMIT' });
    };
    try { res = await runProcess(bin, args, {
      // opts.minimal: the seat runs as cheaply as the vendor allows (cfg.minimalEnv, if any)
      stdin, cwd: opts.cwd, timeoutMs: research ? Math.min(research.timeoutMs, opts.timeoutMs ?? research.timeoutMs) : opts.timeoutMs ?? 300_000, env: { ...cleanEnv(home), ...(opts.minimal && cfg.minimalEnv) }, tag: opts.tag ?? null,
      onStdout: inspect,
    }); } catch (e) { processError = e; res = { stdout: e.stdout || '', stderr: e.stderr || '', code: null, ms: e.ms || 0, progress: e.progress }; }
    // A last event need not end in a newline. Validate it too; a truncated tail must not
    // turn an earlier partial answer into a successful reply.
    if (!processError && pendingLine.trim()) {
      try { inspect('\n'); } catch (e) { processError = e; }
    }
    if (!processError && res.code !== 0) processError = Object.assign(new Error(`${cfg.label} exited unsuccessfully (${res.code ?? 'signal'}).`), { code: 'CLI_EXIT', stdout: res.stdout, stderr: res.stderr });
    const raw = {
      args: args.map((a) => (a.length > 200 ? a.slice(0, 200) + '...' : a)),
      stdout: res.stdout, stderr: res.stderr, code: res.code, ms: res.ms,
    };

    let picked, usedTools = false, completed = false;
    if (streamMode) {
      // stream-json: the final line is {"event":"result","result":{...json shape...}}
      const events = parseLines(res.stdout);
      const last = events.filter((e) => e.event === 'result').pop();
      completed = !!last;
      const obj = last ? last.result : {};
      picked = pickJson(obj, cfg.paths);
      usedTools = !!cfg.usedTools?.(obj, events);
    } else if (cfg.output === 'jsonl') {
      completed = parseLines(res.stdout).some((e) => e.type === cfg.paths.input?.[0]);
      picked = pickJsonl(res.stdout, cfg.paths);
      usedTools = !!cfg.usedTools?.(parseLines(res.stdout).filter((e) => !(research && /^item\.(started|updated|completed)$/.test(e.type) && e.item?.type === 'web_search')));
    } else {
      let obj = {};
      try { obj = JSON.parse(res.stdout); } catch { /* reported below */ }
      completed = !!obj && typeof obj === 'object' && !Array.isArray(obj);
      picked = pickJson(obj, cfg.paths);
      usedTools = !!cfg.usedTools?.(obj);
    }

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
    const usage = picked.usage ? { ...normaliseUsage(cfg, picked.usage, picked.cost), cost, ms: res.ms } : null;
    // A CLI can report dollars without tokens. Preserve both the charge and its cumulative
    // reading separately so a restart does not charge that part of the session again.
    const progress = safeProgress({ ...res.progress, eventCount, stage,
      ...(processError?.code === 'PROVIDER_PROTOCOL' ? { outcome: 'protocol' } : {}),
      ...(usedTools || processError?.usedTools ? { outcome: 'policy' } : {}),
    });
    const accounting = { usage, progress, ...(observer ? { research: { searches: observer.searches } } : {}), ...(!usage ? { cost, rawCost: picked.cost, ms: res.ms } : {}) };
    if (usedTools || processError?.usedTools) throw Object.assign(new Error('Provider reported prohibited tool activity.'), { code: 'TOOL_POLICY', usedTools: true, ...accounting });
    if (processError) throw Object.assign(processError, accounting);
    if (!completed) throw Object.assign(new Error(`${cfg.label} ended without a completion event; the partial answer was rejected.`), { code: 'PROVIDER_PROTOCOL', ...accounting });
    if (observer && observer.searches === 0) throw Object.assign(new Error('Research completed without a reported web-search operation.'), { code: 'RESEARCH_INVALID', ...accounting });
    if (!picked.text) {
      const hint = (res.stderr || res.stdout).trim().split('\n').pop() || `exit ${res.code}`;
      throw Object.assign(new Error(`${cfg.label}: empty reply (${hint.slice(0, 200)})`), { raw, ...accounting, sessionId: picked.sessionId });
    }
    // An error result is not a reply; what the call cost still counts.
    if (picked.isError) throw Object.assign(new Error(`${cfg.label}: ${picked.text.trim().slice(0, 300)}`), { raw, ...accounting, sessionId: picked.sessionId });
    const quota = cfg.normaliseQuota && picked.quota ? cfg.normaliseQuota(picked.quota) : null;
    return { text: picked.text.trim(), ...accounting, sessionId: picked.sessionId, quota, usedTools, raw };
  }
}

// Exposed for tests and doctor: the same detection on captured output.
export function detectToolUse(name, stdout) {
  const cfg = ADAPTERS[name];
  if (cfg.output === 'jsonl') return !!cfg.usedTools?.(parseLines(stdout));
  const events = parseLines(stdout);
  const result = events.findLast((e) => e.event === 'result');
  if (result || events.some((e) => e.event)) return !!cfg.usedTools?.(result?.result || {}, events);
  let obj = {}; try { obj = JSON.parse(stdout); } catch { /* not json */ }
  return !!cfg.usedTools?.(obj);
}
