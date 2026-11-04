// Dependency-free MCP stdio adapter. Shares the review client with the JSON CLI.
// No provider is called by initialize/tools/list/guide or by starting the local board.
import { VERSION } from '../src/version.js';
import { BODY_LIMIT, LIMITS } from '../src/validate.js';
import { runAgent } from '../src/agent-client.js';
import { clientError } from '../src/local-http.js';
import { ensureServer } from '../src/local-server.js';

const integer = ([minimum, maximum]) => ({ type: 'integer', minimum, maximum });
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const id = { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 250, description: 'The exact review id returned by start.' };
const round = integer(LIMITS.critiqueRounds);
const text = (maxLength, description) => ({ type: 'string', maxLength, ...(description ? { description } : {}) });
const review = { type: 'object', required: ['fieldNotes', 'seats'], additionalProperties: false, properties: {
  fieldNotes: { type: 'object', required: ['decision', 'options'], properties: {
    decision: text(LIMITS.decision), options: { type: 'array', minItems: LIMITS.options[0], maxItems: LIMITS.options[1], items: text(LIMITS.option) },
    constraints: text(LIMITS.field), known: text(LIMITS.field), assumed: text(LIMITS.field), reversibility: text(LIMITS.field), deadline: text(LIMITS.field),
  }, additionalProperties: false },
  seats: { type: 'array', minItems: LIMITS.seats[0], maxItems: LIMITS.seats[1], items: { type: 'object', required: ['vendor', 'lens'],
    properties: { vendor: text(LIMITS.seatField), lens: text(LIMITS.seatField), model: text(LIMITS.seatField), effort: text(LIMITS.seatField) }, additionalProperties: true } },
  chairman: { type: 'object', properties: { vendor: text(LIMITS.seatField), model: text(LIMITS.seatField), effort: text(LIMITS.seatField) }, additionalProperties: true },
  options: { type: 'object', properties: {
    critiqueRounds: { ...round, description: 'Default 1. Use 0 for a quick comparison; 2 for deeper examination within agreed limits. Consensus can stop early.' },
    unattended: { type: 'boolean', description: 'True only when nobody will answer. Attended reviews auto-continue after the answer window.' },
    questionWaitMs: integer(LIMITS.questionWaitMs),
    autoContinueMs: integer(LIMITS.autoContinueMs),
    budget: { type: 'object', additionalProperties: true, description: 'Per-provider caps, for example {"claude":{"tokens":160000}}. Check projected calls first.' },
  }, additionalProperties: true },
} };
const descriptors = [
  ['guide', 'Read the Roundtable workflow, request recipe and question/completion rules. No model calls.', object(), true],
  ['status', 'Check provider setup, or read a review by id. Starts the local board if needed. refresh checks free provider status; no model call.', object({ id, refresh: { type: 'boolean' } }), true],
  ['check', 'Validate a proposed review and estimate its calls/tokens before starting. Makes no model call.', object({ review }, ['review']), true],
  ['start', 'Start the requested Roundtable review after check. Makes model calls within its limits. Returns an id, NOT a recommendation; keep calling wait through the chairman.', object({ review }, ['review']), false],
  ['wait', 'Wait up to 25 seconds for questions or completion. A wait timeout is progress, not completion. After showing questions, pass afterRound to await the next step without repeating them.', object({ id, seconds: integer(LIMITS.waitSeconds), afterRound: round }, ['id']), true],
  ['answer', 'Submit only the user\'s real answers to the current round; read status first. May resume model calls. Silence is handled by the timer, not blank answers.', object({ id, round,
    answers: { type: 'array', maxItems: LIMITS.answers, items: object({ id: text(LIMITS.questionId), text: text(LIMITS.answer) }, ['id', 'text']) }, message: text(LIMITS.message) }, ['id', 'round']), false],
  ['hold', 'Give the user another bounded answer window when they need more time. No model call. Never use as an automatic keepalive.', object({ id, round }, ['id', 'round']), false],
  ['finish', 'On the user\'s request, end discussion and call the chairman with collected replies. Keep waiting for the verdict.', object({ id, message: text(LIMITS.message) }, ['id']), false],
  ['stop', 'Cancel this review, including an in-flight chairman, when the user asks to stop. Does not synthesize a recommendation.', object({ id, message: text(LIMITS.message) }, ['id']), false],
  ['resume', 'Resume an interrupted review when requested. Can make model calls; never automatically retry an uncertain write.', object({ id, message: text(LIMITS.message) }, ['id']), false],
  ['verdict', 'Request a missing or failed chairman verdict when authorized and available in actions. Can make a model call; wait for completion.', object({ id }, ['id']), false],
];
const TOOLS = descriptors.map(([command, description, inputSchema, readOnlyHint]) => ({
  name: `roundtable_${command}`, description, inputSchema,
  annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: !['guide', 'wait', 'hold', 'stop'].includes(command) },
}));

function validate(value, schema, field = 'arguments') {
  const kind = schema.type;
  if (kind === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${field}.${key} is required.`);
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validate(v, schema.properties[key], `${field}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`Unknown field ${field}.${key}.`);
    }
  } else if (kind === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error(`${field} has an invalid list length.`);
    value.forEach((v, i) => validate(v, schema.items, `${field}[${i}]`));
  } else if (kind === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${field} is invalid text.`);
  } else if (kind === 'integer') {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) throw new Error(`${field} must be an integer from ${schema.minimum} to ${schema.maximum}.`);
  } else if (typeof value !== kind) throw new Error(`${field} must be ${kind}.`);
}

function options(args) {
  const out = { fake: false, start: true };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--fake') out.fake = true;
    else if (arg === '--no-start') out.start = false;
    else if (arg === '--port' && args.length && out.port == null) out.port = Number(args.shift());
    else throw new Error('Use roundtable mcp [--port N] [--fake] [--no-start].');
  }
  out.port ??= out.fake ? 4748 : 4747;
  if (!Number.isInteger(out.port) || out.port < LIMITS.port[0] || out.port > LIMITS.port[1]) throw new Error('Invalid loopback port.');
  return out;
}

async function serve(config) {
  let starting;
  async function ready(signal) {
    signal.throwIfAborted();
    // Share startup across simultaneous tools; each cancelled caller stops before dispatch.
    starting ??= ensureServer(config).finally(() => { starting = null; });
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
    try { return await Promise.race([starting, cancelled]); }
    finally { signal.removeEventListener('abort', cancel); }
  }
  async function call(name, input, signal) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error('Unknown Roundtable tool.');
    validate(input, tool.inputSchema);
    if (Buffer.byteLength(JSON.stringify(input)) > BODY_LIMIT) throw new Error('Tool arguments exceed 256 KiB.');
    const command = name.slice('roundtable_'.length);
    if (command !== 'guide') await ready(signal);
    if (signal.aborted) throw new Error('Tool request cancelled before dispatch.');
    const flags = { port: config.port, id: input.id, refresh: input.refresh, seconds: input.seconds, 'after-round': input.afterRound };
    let body;
    if (['start', 'check'].includes(command)) body = input.review;
    else if (['answer', 'hold', 'finish', 'stop', 'resume', 'verdict'].includes(command)) { body = { ...input }; delete body.id; }
    const result = { service: 'roundtable', transport: 'mcp', ok: true, ...await runAgent(command, flags, body, signal) };
    if (result.id) {
      if (['ask_user', 'await_user'].includes(result.nextAction?.type)) {
        result.nextAction.tool = 'roundtable_answer';
        result.nextAction.arguments = { id: result.id, ...result.nextAction.answerTemplate };
        result.nextAction.wait = { tool: 'roundtable_wait', arguments: { id: result.id, afterRound: result.gate.round } };
        result.nextAction.extend = { tool: 'roundtable_hold', arguments: { id: result.id, round: result.gate.round } };
      } else if (!result.nextAction || result.nextAction.type === 'wait') result.nextAction = { type: 'wait', tool: 'roundtable_wait', arguments: { id: result.id }, instruction: 'Keep waiting through discussion and chairman synthesis. Only done with verdict.status ready is a completed recommendation.' };
      result.completed = result.status === 'done' && result.verdict?.status === 'ready';
    }
    return result;
  }

  let initialized = false, input = Buffer.alloc(0), closing = false;
  const requests = new Map();
  const send = (value) => { if (!closing) process.stdout.write(`${JSON.stringify(value)}\n`); };
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  async function handle(message) {
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.id != null && !['number', 'string'].includes(typeof message.id)) { error(null, -32600, 'Invalid JSON-RPC request.'); return; }
    if (!Object.hasOwn(message, 'id')) {
      if (message.method === 'notifications/cancelled') requests.get(message.params?.requestId)?.abort();
      return;
    }
    const { id, method, params = {} } = message;
    if (requests.has(id)) { error(id, -32600, 'Request id is already in flight.'); return; }
    if (method === 'initialize') {
      if (initialized) { error(id, -32600, 'Already initialized.'); return; }
      initialized = true;
      send({ jsonrpc: '2.0', id, result: { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(params?.protocolVersion) ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'roundtable', version: VERSION },
        instructions: 'Use roundtable_guide and status before check/start. Keep waiting until the chairman finishes. Present ask_user questions with the host input tool or chat; silence auto-continues without answers. Never replace Roundtable with your own agents or accept a recommendation for the user.' } }); return;
    }
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    if (!initialized) { error(id, -32000, 'Initialize first.'); return; }
    if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
    if (method !== 'tools/call') { error(id, -32601, 'Method not found.'); return; }
    if (requests.size >= 16) { error(id, -32000, 'Too many concurrent tool calls.'); return; }
    const controller = new AbortController(); requests.set(id, controller);
    try {
      let result;
      try { result = await call(params?.name, params?.arguments ?? {}, controller.signal); }
      catch (e) { result = { service: 'roundtable', transport: 'mcp', ...clientError(e) }; }
      if (!controller.signal.aborted) send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.ok === false } });
    } finally { requests.delete(id); }
  }
  const close = () => { closing = true; for (const c of requests.values()) c.abort(); };
  process.stdin.on('data', (chunk) => {
    input = Buffer.concat([input, chunk]);
    let end;
    while ((end = input.indexOf(10)) >= 0) {
      const line = input.subarray(0, end); input = input.subarray(end + 1);
      if (line.length > BODY_LIMIT + 4096) { error(null, -32600, 'Message exceeds size limit.'); close(); process.exitCode = 1; process.stdin.destroy(); return; }
      if (!line.toString('utf8').trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line.toString('utf8')); } catch { error(null, -32700, 'Invalid JSON.'); continue; }
      void handle(parsed).catch(() => error(parsed?.id ?? null, -32603, 'Internal protocol error.'));
    }
    if (input.length > BODY_LIMIT + 4096) { error(null, -32600, 'Message exceeds size limit.'); close(); process.exitCode = 1; process.stdin.destroy(); }
  });
  process.stdin.on('end', close);
  process.stdout.on('error', close);
  process.on('SIGINT', () => { close(); process.exit(0); });
  process.on('SIGTERM', () => { close(); process.exit(0); });
}

if (process.argv.slice(2).some((a) => ['--help', '-h', 'help'].includes(a))) {
  console.log('roundtable mcp [--port N] [--fake] [--no-start]\nMCP over newline-delimited JSON-RPC on stdio. Normally starts a hidden local board when needed. --fake uses scripted providers and port 4748. --no-start requires an existing board. No model call is made until a review action requests it.');
} else {
  try { await serve(options(process.argv.slice(2))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
