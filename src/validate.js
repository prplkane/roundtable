// Bounds for everything the HTTP API accepts. The server is local, but a browser page from
// anywhere can try to reach it, so every field is typed and bounded here before the engine,
// the seats module or the exporter sees it. Pure, so it is unit tested.

const LIMITS = {
  decision: 2000, option: 200, options: [2, 12], field: 4000, exportTo: 1024, seats: [2, 8], message: 4000,
  critiqueRounds: [0, 8], autoContinueMs: [100, 600_000], wallClockMs: [60_000, 10_800_000], callTimeoutMs: [30_000, 1_800_000], endpoint: 500,
};
export const BODY_LIMIT = 256 * 1024;
const NOTE_FIELDS = ['constraints', 'reversibility', 'known', 'assumed', 'deadline'];

const fail = (field, why) => { throw Object.assign(new Error(`${field}: ${why}`), { status: 400 }); };
const str = (v, field, max, { required = false } = {}) => {
  if (v == null || v === '') { if (required) fail(field, 'required'); return ''; }
  if (typeof v !== 'string') fail(field, 'must be text');
  if (v.length > max) fail(field, `at most ${max} characters`);
  return v;
};
const int = (v, field, [lo, hi]) => {
  if (!Number.isInteger(v) || v < lo || v > hi) fail(field, `a whole number from ${lo} to ${hi}`);
  return v;
};
const amount = (v, field) => {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(field, 'a finite number of 0 or more');
  return v;
};

// The one normalisation every option comparison uses (S7 builds on it): NFKC, lower case,
// whitespace collapsed. Nothing is stripped, so non-Latin labels stay distinct.
export const normLabel = (s) => String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// POST /api/debates. adapters: the adapter table (a vendor whose CLI reports no cost cannot take
// a dollar cap). Returns the body with only known keys, every value checked.
export function validateDebateRequest(body, { adapters }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('body', 'a JSON object');
  const fn = body.fieldNotes;
  if (!fn || typeof fn !== 'object') fail('fieldNotes', 'required');
  const decision = str(fn.decision, 'decision', LIMITS.decision, { required: true }).trim();
  if (!decision) fail('decision', 'required');
  if (!Array.isArray(fn.options)) fail('options', 'a list');
  const options = fn.options.map((o, i) => str(o, `option ${i + 1}`, LIMITS.option).trim()).filter(Boolean);
  if (options.length < LIMITS.options[0] || options.length > LIMITS.options[1]) fail('options', `${LIMITS.options[0]} to ${LIMITS.options[1]} options`);
  const seen = new Set();
  for (const o of options) { const k = normLabel(o); if (seen.has(k)) fail('options', `"${o}" appears twice`); seen.add(k); }
  const fieldNotes = { decision, options };
  for (const k of NOTE_FIELDS) fieldNotes[k] = str(fn[k], k, LIMITS.field);
  const exportTo = str(fn.exportTo, 'exportTo', LIMITS.exportTo).trim();
  if (exportTo) fieldNotes.exportTo = exportTo;

  if (!Array.isArray(body.seats)) fail('seats', 'a list');
  if (body.seats.length < LIMITS.seats[0] || body.seats.length > LIMITS.seats[1]) fail('seats', `${LIMITS.seats[0]} to ${LIMITS.seats[1]} seats`);
  for (const [i, s] of body.seats.entries()) {
    if (!s || typeof s !== 'object') fail(`seat ${i + 1}`, 'an object');
    for (const k of ['vendor', 'lens', 'model', 'effort', 'account', 'colour', 'keyEnv']) str(s[k], `seat ${i + 1} ${k}`, 200);
    str(s.endpoint, `seat ${i + 1} endpoint`, LIMITS.endpoint);
    if (s.mood != null && typeof s.mood !== 'string') str(s.mood.text, `seat ${i + 1} mood`, 400);
  }
  if (body.chairman != null) { for (const k of ['vendor', 'model', 'effort', 'account', 'keyEnv']) str(body.chairman[k], `chairman ${k}`, 200); str(body.chairman.endpoint, 'chairman endpoint', LIMITS.endpoint); }

  const o = body.options || {};
  const options_ = {};
  if (o.critiqueRounds != null) options_.critiqueRounds = int(o.critiqueRounds, 'critiqueRounds', LIMITS.critiqueRounds);
  for (const k of ['autoContinueMs', 'wallClockMs', 'callTimeoutMs']) if (o[k] != null) options_[k] = int(o[k], k, LIMITS[k]);
  if (o.memory != null) { if (!['stateless', 'resume'].includes(o.memory)) fail('memory', 'stateless or resume'); options_.memory = o.memory; }
  // an endpoint seat has no thread at the vendor to continue, so `resume` prompts would reach it
  // with no context: refuse the table rather than run it on half-prompts
  if (options_.memory === 'resume' && [...body.seats, body.chairman].some((s) => s && adapters[s.vendor]?.kind === 'api')) fail('memory', 'resume needs a session to continue, and an API endpoint seat has none; use stateless');
  if (o.strictTools != null) { if (typeof o.strictTools !== 'boolean') fail('strictTools', 'true or false'); options_.strictTools = o.strictTools; }
  if (o.budget != null) {
    if (typeof o.budget !== 'object' || Array.isArray(o.budget)) fail('budget', 'an object');
    options_.budget = {};
    for (const [vendor, cap] of Object.entries(o.budget)) {
      if (!adapters[vendor]) fail('budget', `unknown vendor ${vendor}`);
      const tokens = amount(cap?.tokens, `${vendor} token cap`), usd = amount(cap?.usd, `${vendor} dollar cap`);
      if (usd > 0 && !adapters[vendor].paths?.cost) fail('budget', `${adapters[vendor].label} does not report cost, so it cannot take a dollar cap`);
      options_.budget[vendor] = { ...(tokens != null ? { tokens } : {}), ...(usd != null ? { usd } : {}) };
    }
  }
  return { fieldNotes, seats: body.seats, chairman: body.chairman ?? null, options: options_ };
}

// continue / stop / resume / accept: an optional message.
export function validateMessage(body) {
  if (!body || typeof body !== 'object') return { message: '' };
  const out = { ...body, message: str(body.message, 'message', LIMITS.message) };
  if (body.round != null) out.round = int(body.round, 'round', [0, 8]);
  if (body.answers != null) {
    if (!Array.isArray(body.answers) || body.answers.length > 8) fail('answers', 'a list of at most 8 answers');
    if (body.round == null) fail('round', 'required with answers');
    out.answers = body.answers.map((a) => ({ id: str(a?.id, 'question id', 8, { required: true }), text: str(a?.text, 'answer', 1200) }));
  }
  return out;
}

// accept: an option id from this debate's options, or 'none' (decline every option), and a note.
export function validateAccept(body, options) {
  const option = body?.option;
  const ids = (options || []).map((_, i) => `opt-${i + 1}`);
  if (option !== 'none' && !ids.includes(option)) fail('option', `one of ${[...ids, 'none'].join(', ')}`);
  return { option, note: str(body?.note, 'note', LIMITS.message).trim() };
}
