// Standard ACP v1 over stdio. AgentLink owns profiles/installations; Roundtable owns
// the review, fresh seat sessions, deadlines and denial of client-side tools.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { cleanEnv, resolveBinary, registerCall, killTree, runProcess } from './spawn.js';
import { agentLinkProfile } from '../seats.js';
import { VERSION } from '../version.js';

const LIMIT = 8 * 1024 * 1024;
const fault = (message, code = 'PROVIDER_PROTOCOL', kind = 'other') => Object.assign(new Error(message), { code, kind });
const policy = () => Object.assign(fault('ACP agent requested or reported prohibited tool activity. This seat is stopped for the review.', 'TOOL_POLICY', 'policy'), { usedTools: true });
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// This local launch override is read only from the server's environment, never a
// review request. It supports source checkouts and avoids Windows .cmd execution.
export function agentLinkBinary(env = process.env) {
  const script = env.ROUNDTABLE_AGENTLINK_CLI;
  if (script) {
    if (!path.isAbsolute(script) || !existsSync(script)) throw fault('ROUNDTABLE_AGENTLINK_CLI must name an existing absolute AgentLink CLI script.', 'ENOENT', 'missing');
    return { file: process.execPath, prefix: [script] };
  }
  try { return resolveBinary('agentlink', ['@prplkane/agentlink', 'src/cli.mjs'], { env }); }
  catch { throw fault('AgentLink is not installed. Run npm install -g @prplkane/agentlink@beta, or set ROUNDTABLE_AGENTLINK_CLI to its absolute src/cli.mjs path.', 'ENOENT', 'missing'); }
}

// Publish only picker metadata. AgentLink's raw inventory can contain launch arguments and environment settings.
const optionId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id);
function savedDefaults(row) {
  return Object.fromEntries(['model', 'effort'].filter((key) => optionId(row?.[key])).map((key) => [key, row[key]]));
}
export async function listProfiles(launch = {}) {
  const env = cleanEnv(null, { source: launch.env || process.env });
  const bin = launch.bin || agentLinkBinary(env);
  const result = await runProcess(bin, ['list', '--json'], { env, timeoutMs: 5000, maxOutputBytes: 2 * 1024 * 1024 });
  if (result.code !== 0) throw new Error('Could not list saved AgentLink profiles. Run agentlink list.');
  const rows = JSON.parse(result.stdout);
  if (!Array.isArray(rows)) throw new Error('AgentLink returned an unreadable profile list.');
  return rows.filter((p) => p && !p.error).map((p) => {
    const defaults = savedDefaults(p.defaults);
    return { name: agentLinkProfile(p.name), provider: typeof p.provider === 'string' ? p.provider : null,
      ...(Object.keys(defaults).length ? { defaults } : {}) };
  });
}

// Optional ACP end-turn usage is still experimental. Fresh sessions avoid the
// deployed turn-vs-session ambiguity. Context-window `used` is never spending.
// Accept inclusive or additive cache counts only when the reported total agrees.
export function promptUsage(value, cost, ms) {
  if (!record(value)) return null;
  const count = (n) => Number.isSafeInteger(n) && n >= 0;
  const { inputTokens: input, outputTokens: output, totalTokens: total } = value;
  const cacheRead = value.cachedReadTokens ?? 0, cacheWrite = value.cachedWriteTokens ?? 0, thinking = value.thoughtTokens ?? 0;
  if (![input, output, total, cacheRead, cacheWrite, thinking].every(count)) return null;
  let uncached;
  if (total === input + output && input >= cacheRead + cacheWrite) uncached = input - cacheRead - cacheWrite;
  else if (total === input + output + cacheRead + cacheWrite) uncached = input;
  else return null;
  return { input: uncached, output, cacheRead, cacheWrite, thinking, cost, ms, usageVersion: 3 };
}

function connect(bin, profile, { cwd, env, signal, onUpdate }) {
  const child = spawn(bin.file, [...bin.prefix, 'acp', profile], {
    cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  let next = 0, pendingText = '', bytes = 0, failure, closed = false, closing = false, sessionId;
  const pending = new Map();
  const send = (message) => { if (!closed && child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); };
  const cancel = () => { if (sessionId) send({ method: 'session/cancel', params: { sessionId } }); };
  const fail = (error) => {
    if (failure) return;
    failure = error;
    cancel();
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  const aborted = () => fail(signal.reason || fault('ACP call cancelled.', 'KILLED', 'killed'));
  const exit = new Promise((resolve) => child.once('close', () => {
    closed = true;
    if (pendingText.trim()) fail(fault('ACP stdout ended with an incomplete JSON-RPC frame.'));
    if (!closing) fail(fault('ACP process exited before the call completed. Run agentlink check for this profile.', 'CLI_EXIT'));
    resolve();
  }));
  child.on('error', (e) => fail(fault(`Could not launch AgentLink (${e.code || 'spawn error'}).`, e.code || 'CLI_EXIT', 'missing')));
  child.stdin.on('error', () => { if (!closing) fail(fault('ACP input closed before the call completed.', 'CLI_EXIT')); });
  function receive(message) {
    if (!record(message) || message.jsonrpc !== '2.0') throw fault('Invalid ACP JSON-RPC envelope.');
    if (Object.hasOwn(message, 'method')) {
      if (typeof message.method !== 'string') throw fault('Invalid ACP method.');
      if (Object.hasOwn(message, 'id')) {
        if (message.method === 'session/request_permission') {
          send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
          throw policy();
        }
        send({ id: message.id, error: { code: -32601, message: 'Roundtable does not provide client tools.' } });
        if (/^(fs\/|terminal\/)/.test(message.method)) throw policy();
      } else if (message.method === 'session/update') {
        const { params } = message;
        if (!record(params) || !record(params.update) || typeof params.sessionId !== 'string') throw fault('Invalid ACP session update.');
        if (['tool_call', 'tool_call_update'].includes(params.update.sessionUpdate)) throw policy();
        if (sessionId && params.sessionId !== sessionId) throw fault('ACP update belongs to another session.');
        if (sessionId) onUpdate(params.update);
      }
      return;
    }
    if (!Object.hasOwn(message, 'id') || Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw fault('Invalid ACP response.');
    const p = pending.get(message.id);
    if (!p) throw fault('ACP response has an unknown request ID.');
    pending.delete(message.id);
    if (message.error) {
      if (p.method === 'session/new' && ['OPTION_UNAVAILABLE', 'OPTION_UNCONFIRMED'].includes(message.error.data?.code)) {
        p.reject(fault(`AgentLink could not apply a saved default for ${profile}. Inspect choices with agentlink models ${profile} and update them with agentlink defaults ${profile}.`, 'ACP_UNSUPPORTED'));
        return;
      }
      const auth = message.error.code === -32000;
      p.reject(fault(auth ? 'ACP authentication is required. Sign in using the agent vendor login flow, then check the AgentLink profile.'
        : `ACP request failed: ${String(message.error.message || 'unknown error').slice(0, 500)}`, 'CLI_FAILURE', auth ? 'auth' : 'other'));
    } else if (!record(message.result)) p.reject(fault('ACP response result must be an object.'));
    else {
      // Bind at the receive boundary: the next frame can be in this same chunk,
      // before the awaiting session/new caller gets a chance to resume.
      if (p.method === 'session/new' && typeof message.result.sessionId === 'string') sessionId = message.result.sessionId;
      p.resolve(message.result);
    }
  }
  const accountBytes = (d) => {
    bytes += Buffer.byteLength(d);
    if (bytes > LIMIT) { fail(fault('ACP output exceeded the local size limit.', 'OUTPUT_LIMIT')); return false; }
    return !failure;
  };
  child.stderr.on('data', accountBytes); // diagnostics are bounded, never copied into review records
  child.stdout.setEncoding('utf8').on('data', (d) => {
    if (!accountBytes(d)) return;
    pendingText += d;
    try {
      let i;
      while ((i = pendingText.indexOf('\n')) >= 0) {
        const line = pendingText.slice(0, i); pendingText = pendingText.slice(i + 1);
        if (line.trim()) receive(JSON.parse(line));
        if (failure) break;
      }
    } catch (e) { fail(e instanceof SyntaxError ? fault('ACP stdout contained invalid JSON.') : e); }
  });
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  return {
    setSession(id) { sessionId = id; },
    check() { if (failure) throw failure; },
    request(method, params) {
      if (failure) return Promise.reject(failure);
      const id = ++next;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, method }); send({ id, method, params }); });
    },
    async close() {
      closing = true;
      signal.removeEventListener('abort', aborted);
      if (!closed) {
        child.stdin.end();
        // Leave time for AgentLink's own bridge cleanup and lease release.
        const timer = setTimeout(() => killTree(child), 2000);
        try { await exit; } finally { clearTimeout(timer); }
      }
    },
  };
}

// A session's select-type config option by ACP category, or by id for an agent that labels
// none, and the values it offers (flat, or grouped). Roundtable never invents a value: a model or
// reasoning level is sent only when the agent advertised it for this session.
function configOption(session, category, ids) {
  const selects = (Array.isArray(session.configOptions) ? session.configOptions : [])
    .filter((o) => o?.type === 'select' && typeof (o.configId ?? o.id) === 'string');
  return selects.find((o) => o.category === category) || selects.find((o) => !o.category && ids.includes(o.configId ?? o.id));
}
const optionValues = (option) => Array.isArray(option?.options) ? option.options.flatMap((o) => Array.isArray(o?.options) ? o.options : [o]).filter(record) : [];
const MODEL = { category: 'model', ids: ['model'], what: 'model' };
const EFFORT = { category: 'thought_level', ids: ['thought_level', 'effort', 'reasoning_effort', 'reasoning'], what: 'reasoning level' };
const advertised = (session, option) => optionValues(configOption(session, option.category, option.ids));
async function selectOption(connection, session, value, { category, ids, what }) {
  const option = configOption(session, category, ids);
  if (!option || !optionValues(option).some((o) => o.value === value)) throw fault(`The ACP agent did not advertise this ${what}. Use its default or an advertised ${what} ID.`, 'ACP_UNSUPPORTED');
  if (option.currentValue === value) return;
  const result = await connection.request('session/set_config_option', { sessionId: session.sessionId, configId: option.configId ?? option.id, value });
  session.configOptions = result.configOptions;
  if (configOption(session, category, ids)?.currentValue !== value) throw fault(`The ACP agent did not confirm the selected ${what}.`, 'ACP_UNSUPPORTED');
}

async function withProfile(prompt, previousSession, opts, { bin, env: suppliedEnv }, inspect) {
  const profile = agentLinkProfile(opts.account);
  if (!opts.allowLimitedIsolation) throw fault('ACP profiles control their own permissions and customization. Accept limited isolation before using this profile.', 'ISOLATION_REQUIRED', 'policy');
  if (previousSession || opts.keepSession) throw fault('ACP seats currently require stateless memory; no previous session was loaded.', 'ACP_STATELESS_REQUIRED');
  if (opts.research) throw fault('ACP seats do not support Roundtable web research.', 'ACP_UNSUPPORTED');
  const cwd = opts.cwd;
  if (!cwd || !path.isAbsolute(cwd)) throw fault('ACP seats need an absolute, isolated working directory.');
  mkdirSync(cwd, { recursive: true });
  const env = cleanEnv(null, { source: suppliedEnv || process.env });
  const launch = bin || agentLinkBinary(env);
  const call = registerCall(opts.tag);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(fault('ACP call timed out.', 'TIMEOUT', 'timeout')), opts.timeoutMs ?? 300_000);
  const signal = AbortSignal.any([call.signal, timeout.signal, ...(opts.signal ? [opts.signal] : [])]);
  const started = Date.now();
  let text = '', cost = null, activePrompt = false;
  let connection;
  try {
    if (signal.aborted) throw signal.reason;
    connection = connect(launch, profile, { cwd, env, signal, onUpdate: (update) => {
      if (!activePrompt) return;
      if (update.sessionUpdate === 'agent_message_chunk') {
        if (update.content?.type !== 'text' || typeof update.content.text !== 'string') throw fault('ACP review replies must contain text.');
        text += update.content.text;
      } else if (update.sessionUpdate === 'usage_update' && update.cost?.currency === 'USD' && Number.isFinite(update.cost.amount) && update.cost.amount >= 0) cost = update.cost.amount;
    } });
    const init = await connection.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'roundtable', version: VERSION } });
    if (init.protocolVersion !== 1) throw fault('This Roundtable client requires ACP v1; the agent negotiated an incompatible protocol.', 'ACP_UNSUPPORTED');
    const session = await connection.request('session/new', { cwd, mcpServers: [] });
    if (typeof session.sessionId !== 'string' || !session.sessionId) throw fault('ACP agent did not return a session ID.');
    connection.setSession(session.sessionId);
    const hasModel = advertised(session, MODEL).some((o) => o.value === opts.model);
    if (opts.model && (!inspect || hasModel)) await selectOption(connection, session, opts.model, MODEL);
    if (inspect) {
      const models = advertised(session, MODEL).filter((o) => typeof o.value === 'string' && o.value.length <= 200)
        .map((o) => ({ id: o.value, label: typeof o.name === 'string' ? o.name : o.value }));
      const effortChoices = advertised(session, EFFORT).filter((o) => optionId(o.value))
        .map((o) => ({ id: o.value, label: typeof o.name === 'string' ? o.name : o.value }));
      await connection.close();
      connection.check();
      return { models, efforts: effortChoices.map((e) => e.id), effortChoices, effortModel: hasModel ? opts.model : '' };
    }
    if (opts.effort) await selectOption(connection, session, opts.effort, EFFORT);
    if (opts.model && configOption(session, MODEL.category, MODEL.ids)?.currentValue !== opts.model) {
      throw fault('The ACP agent changed the selected model while applying the reasoning level.', 'ACP_UNSUPPORTED');
    }
    activePrompt = true;
    const result = await connection.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] });
    connection.check();
    if (result.stopReason !== 'end_turn') throw fault(`ACP turn did not complete (${String(result.stopReason || 'missing stop reason')}).`, result.stopReason === 'cancelled' ? 'KILLED' : 'CLI_FAILURE', result.stopReason === 'cancelled' ? 'killed' : 'other');
    if (!text.trim()) throw fault('ACP agent completed without a text answer.');
    await connection.close();
    connection.check();
    const ms = Date.now() - started;
    return { text, usage: promptUsage(result.usage, cost, ms), cost, ms, sessionId: session.sessionId, usedTools: false };
  } catch (e) {
    throw Object.assign(e, { usage: null, cost, ms: Date.now() - started });
  } finally {
    clearTimeout(timer);
    try { await connection?.close(); } finally { call.release(); }
  }
}

export function makeAcpAdapter(launch = {}) {
  return (prompt, previousSession = null, opts = {}) => withProfile(prompt, previousSession, opts, launch, false);
}

// Explicit local setup action. The profile receives an empty workspace and no prompt.
export async function inspectProfileSession(account, model = '', launch = {}) {
  agentLinkProfile(account);
  if (typeof model !== 'string' || model.length > 200) throw new Error('Model ID must be at most 200 characters.');
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'roundtable-profile-'));
  try {
    return await withProfile(null, null, { account, model, cwd, timeoutMs: 20_000, allowLimitedIsolation: true }, launch, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// Unlike session/new, beta.3 management inspection ignores saved pins. A retired
// central default must not prevent the picker from showing its replacements.
async function modelReport(bin, env, account, model) {
  const args = ['models', account, '--json'];
  if (model) args.push('--model', model);
  const result = await runProcess(bin, args, { env, timeoutMs: 20_000 });
  if (result.code !== 0) {
    if (!model && /^INVALID_ARGUMENT: Unknown command\. Run agentlink --help\.\s*$/.test(result.stderr)) return null; // beta.2
    throw fault(`AgentLink could not inspect profile ${account}. Run agentlink models ${account} to check its connection.`, 'CLI_FAILURE');
  }
  let report;
  try { report = JSON.parse(result.stdout); } catch {}
  if (report?.name !== account || !['model', 'effort'].every((k) => report[k] === null || Array.isArray(report[k]?.choices))) {
    throw fault('AgentLink returned an unreadable model report.');
  }
  return report;
}

function namedChoices(selector) {
  return (selector?.choices || []).filter((o) => optionId(o?.id))
    .map(({ id, name }) => ({ id, label: typeof name === 'string' && name ? name : id }));
}

export async function discoverProfile(account, model = '', launch = {}) {
  account = agentLinkProfile(account);
  if (model !== '' && !optionId(model)) throw new Error('Choose a model ID of at most 200 characters.');
  const env = cleanEnv(null, { source: launch.env || process.env });
  const bin = launch.bin || agentLinkBinary(env);
  const base = await modelReport(bin, env, account);
  if (!base) return inspectProfileSession(account, model, launch);
  const defaults = savedDefaults(base.defaults);
  const models = namedChoices(base.model);
  const offers = (id) => models.some((m) => m.id === id);
  const profileModel = defaults.model || (optionId(base.model?.current) ? base.model.current : '');
  const effortModel = offers(model) ? model : '';
  const selected = effortModel || (offers(profileModel) ? profileModel : '');
  const detail = selected && selected !== base.model?.current ? await modelReport(bin, env, account, selected) : base;
  const effortChoices = namedChoices(detail.effort);
  const efforts = effortChoices.map((e) => e.id);
  const inheritsModel = !effortModel || effortModel === profileModel;
  const stale = defaults.model && !offers(defaults.model) || inheritsModel && defaults.effort && !efforts.includes(defaults.effort);
  // The inspector bypasses saved pins. After a seat overrides a centrally configured
  // model, only its actual session knows whether the provider retained or reset effort.
  const observedEffort = optionId(detail.effort?.current) ? detail.effort.current : '';
  const defaultEffort = inheritsModel ? defaults.effort || observedEffort : Object.keys(defaults).length ? '' : observedEffort;
  return { models, efforts, effortChoices, effortModel, defaults, profileModel, defaultEffort,
    ...(stale ? { warning: `A saved AgentLink default is unavailable. Choose a replacement with agentlink defaults ${account} before starting a review.` } : {}) };
}

export const run = makeAcpAdapter();
