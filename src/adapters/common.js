import { ADAPTERS, ARGV_LIMIT } from './config.js';
import { resolveBinary, runProcess, cleanEnv } from './spawn.js';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyError } from './errors.js';
import { safeProgress, progressText } from '../progress.js';
import { researchSettings, researchObserver, limitExceeded } from '../research.js';

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
const lastUsage = new Map(); // sessionId -> vendor's last cumulative token reading

// Reject a missing baseline or counters that went backwards; neither is a measured zero.
export function usageDelta(current, previous) {
  const a = usageCounters(current || {}), b = usageCounters(previous || {});
  if (!a || !b) return null;
  return usageCounters(Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - b[k]])));
}

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

// Turn a config row plus (prompt, sessionId, model, effort, call limit) into argv and stdin. Pure, so it is unit tested.
// keepSession: the call's session will be resumed (resume memory), so the CLI must save it. Any
// other fresh call adds the CLI's `ephemeral` argv when it has one; a resumed call never does,
// since its session goes on.
export function buildArgs(cfg, { prompt, sessionId = null, model = null, effort = null, instructionsFile = null, timeoutMs = 300_000, keepSession = false }) {
  const useStdin = cfg.promptVia === 'stdin' ||
    (cfg.promptVia === 'argv-or-stdin' && prompt.length > ARGV_LIMIT);
  const streamMode = useStdin && !!cfg.stdinArgs;
  const base = streamMode ? cfg.stdinArgs : cfg.args;
  const args = sessionId ? cfg.resume(sessionId, base) : [...base];
  const extra = [];
  if (cfg.stream) extra.push(...cfg.stream(timeoutMs)); // the stream's idle limit fits inside the call limit
  if (!keepSession && !sessionId && cfg.ephemeral) extra.push(...cfg.ephemeral);
  if (model && cfg.model) extra.push(...cfg.model(model));
  if (instructionsFile) extra.push('-c', `model_instructions_file=${JSON.stringify(instructionsFile)}`);
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
    let instructionsDir, instructionsFile;
    try {
      if (name === 'codex' && cfg.instructions) {
        instructionsDir = mkdtempSync(path.join(os.tmpdir(), 'roundtable-codex-'));
        instructionsFile = path.join(instructionsDir, 'instructions.txt');
        writeFileSync(instructionsFile, cfg.instructions, { flag: 'wx', mode: 0o600 });
      }
      return await runOnce(prompt, sessionId, opts, instructionsFile);
    } catch (e) {
      const c = classifyError({ message: e.message, stdout: e.raw?.stdout ?? e.stdout ?? '', stderr: e.raw?.stderr ?? e.stderr ?? '', code: e.code, label: cfg.label });
      throw Object.assign(e, { kind: c.kind, resetsAt: c.resetsAt, detail: c.detail, message: c.kind === 'timeout'
        ? `${c.message} ${progressText(e.progress)} Save the error log before retrying. Missing usage remains unknown.`
        : c.kind === 'other' ? e.message : c.message });
    } finally {
      // Delete only the file we created. Never recursively remove a directory supplied by a caller.
      if (instructionsFile) { try { unlinkSync(instructionsFile); } catch {} }
      if (instructionsDir) { try { rmdirSync(instructionsDir); } catch {} }
    }
  };

  async function runOnce(prompt, sessionId = null, opts = {}, instructionsFile = null) {
    const research = opts.research ? researchSettings(opts.research) : null;
    // the searcher's CLI only, on its own fresh call; cfg.research says how it searches (config.js)
    const searching = research ? cfg.research : null;
    if (research && (research.vendor !== name || !searching || sessionId)) throw Object.assign(new Error('Research requires one fresh call to the searcher\'s CLI.'), { code: 'RESEARCH_INVALID' });
    const observer = research ? researchObserver(research, searching.searchIds) : null;
    const guard = searching ? searching.foreignTool : cfg.usedTools; // search allowed, every other tool still stops the call
    if (cfg.limitedIsolation && !opts.allowLimitedIsolation) throw Object.assign(new Error('Explicit consent to limited isolation is required.'), { code: 'ISOLATION_REQUIRED' });
    if (cfg.terms && opts.acknowledgeTermsRisk !== true) throw Object.assign(new Error(`The person has not acknowledged ${cfg.label}'s terms notice.`), { code: 'TERMS_ACK_REQUIRED' });
    bin ??= cfg.bin || resolveBinary(cfg.binary, cfg.npmBin); // cfg.bin: a test's fake CLI
    // One time limit for the process and for the argv derived from it (cfg.stream).
    const timeoutMs = research ? Math.min(research.timeoutMs, opts.timeoutMs ?? research.timeoutMs) : opts.timeoutMs ?? 300_000;
    const built = buildArgs(cfg, { prompt, sessionId, model: opts.model, effort: opts.effort, instructionsFile, timeoutMs, keepSession: opts.keepSession === true });
    const { stdin, streamMode } = built;
    const args = searching ? searching.args(built.args) : built.args;

    // opts.home: the directory of a named profile's CLI state (spawn.js profileHome). Only
    // vendors with a `home` entry honour it. It is created empty and never seeded: the user logs
    // that profile in once (`node src/doctor.js` prints how), and the CLI keeps its login there.
    let home = null;
    if (opts.home && cfg.home) { mkdirSync(opts.home, { recursive: true }); home = { env: cfg.home.env, dir: opts.home }; }
    if (opts.cwd) mkdirSync(opts.cwd, { recursive: true }); // a missing cwd makes spawn fail with ENOENT
    let pendingLine = '', processError = null, res, eventCount = 0, stage = 'waiting', hasReply = false, terminalUsage = false, reconnects = 0;
    // the last event that moved the call on: a CLI's reconnect or retry notice says it has been
    // waiting, so the searcher's silence limit counts on through it
    let progressAt = Date.now();
    const notice = (event) => event?.type === 'error' && /reconnect|retry|stream.*disconnect/i.test(event.message || '');
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
        if (!notice(event)) progressAt = Date.now();
        if (event?.type === 'turn.completed' || event?.type === 'result' || event?.event === 'result') stage = 'completed';
        else if (event?.item?.type === 'reasoning' || event?.message?.content?.some?.((c) => c?.type === 'thinking')) stage = 'reasoning';
        else if (event?.item?.type === 'agent_message' || event?.type === 'assistant') stage = 'reply';
        else if (stage === 'waiting') stage = 'started';
        if (observer?.accept(event)) stage = 'searching';
        if (name === 'codex') {
          if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string' && event.item.text.trim()) hasReply = true;
          if (event?.type === 'turn.completed') terminalUsage = !!usageCounters({ input: event.usage?.input_tokens, output: event.usage?.output_tokens,
            cacheRead: event.usage?.cached_input_tokens, cacheWrite: event.usage?.cache_write_input_tokens, thinking: event.usage?.reasoning_output_tokens });
          // the CLI's "Reconnecting... n/m": the stream stalled and the answer starts again; counted
          // into the saved progress so a recovered stall stays visible (retry notices set the stage only)
          if (notice(event)) { stage = 'reconnecting'; if (/reconnect/i.test(event.message)) reconnects++; }
          if (event?.type === 'turn.failed') {
            stage = 'provider-error';
            throw Object.assign(new Error(String(event.error?.message || 'Codex reported a failed turn.').slice(0, 1000)), { code: 'CLI_FAILURE' });
          }
        }
        const tool = streamMode ? guard?.(event.event === 'result' ? event.result : {}, [event])
          : cfg.output === 'jsonl' ? guard?.([event]) : guard?.(event);
        if (tool) { stage = 'tool'; throw Object.assign(new Error('Provider reported prohibited tool activity.'), { code: 'TOOL_POLICY', usedTools: true }); }
      }
      if (pendingLine.length > 1024 * 1024) throw Object.assign(new Error('Provider event exceeded the local size limit.'), { code: 'OUTPUT_LIMIT' });
      return hasReply && terminalUsage;
    };
    try { res = await runProcess(bin, args, {
      // opts.minimal: the seat runs as cheaply as the vendor allows (cfg.minimalEnv, if any)
      stdin, cwd: opts.cwd, timeoutMs, env: { ...cleanEnv(home), ...(opts.minimal && cfg.minimalEnv) }, tag: opts.tag ?? null,
      onStdout: inspect, completionGraceMs: cfg.completionGraceMs,
      stallMs: searching?.stallMs || 0, progressAt: () => progressAt, // the searcher only: a search that went silent (config.js)
    }); } catch (e) { processError = e; res = { stdout: e.stdout || '', stderr: e.stderr || '', code: null, ms: e.ms || 0, progress: e.progress }; }
    // A last event need not end in a newline. Validate it too; a truncated tail must not
    // turn an earlier partial answer into a successful reply.
    if (!processError && pendingLine.trim()) {
      try { inspect('\n'); } catch (e) { processError = e; }
    }
    if (!processError && res.code !== 0 && !res.completed) processError = Object.assign(new Error(`${cfg.label} exited unsuccessfully (${res.code ?? 'signal'}).`), { code: 'CLI_EXIT', stdout: res.stdout, stderr: res.stderr });
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
      usedTools = !!guard?.(obj, events);
    } else if (cfg.output === 'jsonl') {
      const events = parseLines(res.stdout);
      completed = events.some((e) => e.type === cfg.paths.input?.[0]);
      picked = pickJsonl(res.stdout, cfg.paths);
      usedTools = !!guard?.(events);
      // the searcher's figures from the CLI's own totals, where the reply's leave the search out
      observer?.report(searching.reported?.(events));
      const searchUsage = searching?.usage ? usageCounters(searching.usage(events) || {}) : null;
      if (searchUsage) picked.usage = searchUsage;
    } else {
      let obj = {};
      try { obj = JSON.parse(res.stdout); } catch { /* reported below */ }
      completed = !!obj && typeof obj === 'object' && !Array.isArray(obj);
      picked = pickJson(obj, cfg.paths);
      usedTools = !!guard?.(obj);
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
    let charged = picked.usage;
    if (cfg.usageIsCumulative && picked.usage) {
      const key = picked.sessionId || sessionId;
      if (sessionId) charged = picked.sessionId && picked.sessionId !== sessionId ? null
        : usageDelta(picked.usage, opts.prevUsage ?? lastUsage.get(key));
      if (key) lastUsage.set(key, picked.usage);
    }
    const usage = charged ? { ...normaliseUsage(cfg, charged, picked.cost), cost, ms: res.ms,
      ...(cfg.usageIsCumulative ? { raw: { ...picked.usage, ...(picked.cost != null ? { cost: picked.cost } : {}) }, rawScope: 'session' } : {}),
    } : null;
    // A CLI can report dollars without tokens. Preserve both the charge and its cumulative
    // reading separately so a restart does not charge that part of the session again.
    const progress = safeProgress({ ...res.progress, eventCount, stage, ...(reconnects ? { reconnects } : {}),
      ...(processError?.code === 'PROVIDER_PROTOCOL' ? { outcome: 'protocol' } : {}),
      ...(usedTools || processError?.usedTools ? { outcome: 'policy' } : {}),
    });
    const accounting = { usage, progress, ...(observer ? { research: { searches: observer.searches } } : {}), ...(!usage ? { cost, rawCost: picked.cost, ms: res.ms } : {}) };
    if (usedTools || processError?.usedTools) throw Object.assign(new Error('Provider reported prohibited tool activity.'), { code: 'TOOL_POLICY', usedTools: true, ...accounting });
    if (processError) throw Object.assign(processError, accounting);
    if (observer && observer.searches > research.maxSearches) throw Object.assign(limitExceeded(), accounting); // counted by the CLI after the stream
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
