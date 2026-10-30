// Seats are instances: one vendor CLI, one session, one lens, one mood, one model, one effort.
// This module turns what the setup screen posts into the seat list the engine runs, and
// rejects what would break anonymity or the CLIs. Pure, so it is unit tested.

export const MOODS = {
  grill: 'Your default posture is sceptical: attack assumptions, demand evidence, and do not agree until the case is made.',
  steelman: 'Before judging an option, state its strongest version; then say where even that version fails.',
  builder: 'Judge by what it takes to ship: effort, sequencing, what breaks first.',
  contrarian: 'Take the stance the other seats are least likely to take, and defend it with evidence.',
};
export const DEFAULT_MOOD = 'grill';

// A custom mood matching a persona code uses its prompt, avatar and light model settings.
// The server opts board requests into these shortcuts; ordinary API requests keep custom text.
import { HIDDEN_MOODS } from './personas.js';
export { HIDDEN_MOODS } from './personas.js';
export function hiddenMood(text) {
  const word = String(text || '').trim().toLowerCase();
  return word ? HIDDEN_MOODS.find((h) => h.codes.includes(word)) || null : null;
}
// Remove complete parentheticals in one pass, preserving unmatched openings. A regex that
// searches again after every unmatched opening or whitespace character can stall the server.
export function filterReply(mood, text) {
  const h = mood?.hidden && HIDDEN_MOODS.find((x) => x.art === mood.hidden);
  if (!h?.stripParentheticals) return text;
  const body = String(text), parts = [];
  let from = 0, search = 0;
  while (search < body.length) {
    const open = body.indexOf('(', search);
    if (open < 0) break;
    const close = body.indexOf(')', open + 1);
    if (close < 0) break;
    let start = open;
    while (start > from && /\s/.test(body[start - 1])) start--;
    parts.push(body.slice(from, start));
    from = search = close + 1;
  }
  return parts.join('') + body.slice(from);
}
// The cheapest model each CLI offers (adapters/models.js marks claude's and codex's lightest).
// agy: Flash-low over gpt-oss-120b-medium, measured on a hidden-mood prompt: the same input,
// but gpt-oss wrote 1.7k-4k output tokens to Flash-low's ~190, and took two to four times longer.
export const LIGHTEST = { claude: 'claude-haiku-4-5', codex: 'gpt-6-luna', agy: 'gemini-3.8-flash-low' };
// agy's list depends on the account (`agy models`): a Flash-Lite model, where offered, is lighter
// than Flash, and a family's "-low" level is its lightest. LIGHTEST.agy when the list has neither.
export function lightestModel(vendor, models = []) {
  if (vendor !== 'agy') return LIGHTEST[vendor];
  const rank = (id) => (/flash-lite/.test(id) ? 0 : 3) + (/-low$/.test(id) ? 0 : /-medium$/.test(id) ? 1 : 2);
  const ids = models.map((m) => m?.id || m).filter((id) => /^gemini-.*flash/.test(String(id)));
  return ids.sort((a, b) => rank(a) - rank(b))[0] || LIGHTEST.agy;
}

const STARTER_LENSES = ['risk and failure modes', 'cost and effort', 'evidence and assumptions',
  'long-term effects', 'practical steps', 'alternatives', 'people affected', 'opportunities'];
export function nextSeatLens(seats) {
  const used = new Set(seats.map((s) => String(s?.lens || '').trim().toLowerCase()));
  const starter = STARTER_LENSES.find((lens) => !used.has(lens));
  if (starter) return starter;
  let n = seats.length + 1;
  while (used.has(`perspective ${n}`)) n++;
  return `perspective ${n}`;
}

export function fillMissingSeatLenses(seats) {
  const out = seats.map((s) => ({ ...s }));
  for (const seat of out) if (!String(seat.lens || '').trim()) seat.lens = nextSeatLens(out);
  return out;
}

// Shared by the form and API, with field coordinates rather than private input in errors.
export function seatSetupIssue(seats) {
  const seen = new Map();
  for (const [seatIndex, seat] of seats.entries()) {
    if (!seat) continue;
    const lens = String(seat.lens || '').trim().toLowerCase();
    if (!lens) return { seatIndex, field: 'lens', code: 'SEAT_LENS_REQUIRED',
      message: `Seat ${seatIndex + 1} needs a lens. Give it a perspective, such as risk, evidence or long-term effects.` };
    if (seen.has(lens)) return { seatIndex, field: 'lens', code: 'SEAT_LENS_DUPLICATE',
      message: `Seats ${seen.get(lens) + 1} and ${seatIndex + 1} share the lens. Give each seat a different perspective.` };
    seen.set(lens, seatIndex);
    const preset = typeof seat.mood === 'string' ? seat.mood : seat.mood?.preset;
    const text = typeof seat.mood === 'object' ? seat.mood?.text : seat.moodText;
    if (preset === 'custom' && !String(text || '').trim()) return { seatIndex, field: 'moodText', code: 'SEAT_MOOD_REQUIRED',
      message: `Seat ${seatIndex + 1} needs a custom mood sentence. Describe how it should argue, or choose a preset.` };
  }
  return null;
}

// Seat colours from the signature-design accent family, cycled when a table has more seats.
export const COLOURS = ['rust', 'olive', 'teal', 'dusk', 'steel'];

// First use starts small. Prefer ready default logins; one ready vendor can fill both seats.
// With no ready result yet, show two editable CLI choices and their status lamps.
export function initialSeatVendors(vendors, checks = []) {
  const cli = vendors.filter((v) => v.kind !== 'api').map((v) => v.vendor);
  const ready = cli.filter((v) => checks.some((p) => p.key === v && p.state === 'ok'));
  const choices = ready.length ? ready : cli;
  return choices.length ? [choices[0], choices[1] || choices[0]] : [];
}

// A profile name is a directory name under the roundtable data dir, so it is kept plain.
// (Here rather than in adapters/spawn.js because this module also runs in the browser.)
export const PROFILE_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/i;

// The quota pool a seat draws from, as a key: the vendor's own login is `codex`; a named profile
// with its own login is `codex@work`. A vendor whose CLI has no separate state directory
// (`profiles` false: agy) has one pool whatever the seat says. Quota snapshots, calibration and
// the board's pool rows are all keyed by it.
export function poolKey(vendor, account, profiles = true) {
  return account && profiles ? `${vendor}@${account}` : vendor;
}
export const poolVendor = (key) => String(key).split('@')[0].split(':')[0];
export const poolAccount = (key) => String(key).split(':')[0].split('@')[1] || null;

// An optional profile name: the seat then runs with its own CLI state directory under the OS
// user-data dir (adapters/spawn.js profileHome), which the user logged in themselves. Empty
// means the vendor's real state directory, shared with the terminal.
export function normaliseAccount(raw) {
  const name = String(raw || '').trim();
  if (!name) return undefined;
  if (!PROFILE_RE.test(name)) throw new Error(`Account profile "${name}" must be 1-40 letters, digits, dots, dashes or underscores.`);
  return name;
}

// The one line a seat sees about how to approach the question. Custom text wins when given.
export function moodLine(mood) {
  if (!mood) return MOODS[DEFAULT_MOOD];
  if (typeof mood === 'string') return MOODS[mood] || MOODS[DEFAULT_MOOD];
  if (mood.hidden) { const h = HIDDEN_MOODS.find((x) => x.art === mood.hidden); if (h) return h.text; }
  if (mood.preset === 'custom' && mood.text) return String(mood.text).trim();
  return MOODS[mood.preset] || MOODS[DEFAULT_MOOD];
}

// hidden: whether this request may unlock a hidden mood (only the board's own requests may).
function normaliseMood(m, { hidden = false } = {}) {
  if (!m) return { preset: DEFAULT_MOOD };
  if (typeof m === 'string') return MOODS[m] ? { preset: m } : { preset: DEFAULT_MOOD };
  if (m.preset === 'custom') {
    const text = String(m.text || '').trim();
    if (!text) throw new Error('A custom mood needs its sentence.');
    const h = hidden ? hiddenMood(text) : null;
    return { preset: 'custom', text: text.slice(0, 400), ...(h ? { hidden: h.art } : {}) };
  }
  return { preset: MOODS[m.preset] ? m.preset : DEFAULT_MOOD };
}

// ---------- API endpoint seats ----------
// A seat on an OpenAI-compatible endpoint names a base URL, a model and, for a hosted API, the
// NAME of the environment variable that holds the key (never the key). These rules are shared
// with the browser, so the card can say the same thing the server will.

export const KEY_ENV_RE = /^[A-Z_][A-Z0-9_]{0,63}$/; // an identifier: a pasted key is refused on shape alone
// Browser preferences must never retain an invalid value while the form reports its error.
export function keyEnvName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return KEY_ENV_RE.test(name) ? name : '';
}

// On this machine or on a private network: loopback, link-local, RFC 1918, ULA, a bare LAN
// name, or the local-only suffixes. Plain http is allowed only here, so a key never crosses the
// open internet in clear.
export function privateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::') return true;
  if (/\.(localhost|local|test|internal|lan|home|home\.arpa)$/.test(h)) return true;
  if (!h.includes('.') && !h.includes(':')) return true; // a bare LAN hostname
  // URL callers already canonicalize alternate IPv4 spellings. Check the whole address:
  // a DNS name such as 10.api.example.com must not inherit a private address's HTTP policy.
  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(h) ? h.split('.').map(Number) : null;
  if (ipv4 && ipv4.every((n) => n <= 255)) {
    const [a, b] = ipv4;
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31);
  }
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}

// The base URL as the adapter will use it ("…/v1", no trailing slash), or a thrown reason.
export function checkEndpointUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('An API seat needs its endpoint: the base URL, for example http://localhost:11434/v1.');
  let u;
  try { u = new URL(text); } catch { throw new Error(`Endpoint "${text}" is not a URL.`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Endpoint ${text}: http or https only.`);
  if (u.protocol === 'http:' && !privateHost(u.hostname)) throw new Error(`Endpoint ${u.host}: plain http only to this machine or a private network; a hosted API must be https.`);
  if (u.username || u.password) throw new Error('Endpoint: credentials belong in an environment variable, not in the URL.');
  if (u.search || u.hash) throw new Error('Endpoint: a base URL, without a query or a fragment.');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

// The pool identity of an endpoint: its host, as a profile-shaped name (poolKey, PROFILE_RE):
// api.deepseek.com, localhost-11434. One pool per host, so a host that fails benches only itself.
export function hostKey(url) {
  let u; try { u = new URL(String(url || '').trim()); } catch { return ''; }
  const name = `${u.hostname.replace(/^\[|\]$/g, '')}${u.port ? `-${u.port}` : ''}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '');
  return name.slice(0, 40);
}

// What the card and the record say about where a seat runs: the CLI on a subscription, an API
// on this machine, or an API that bills per token.
export function seatKind(vendorRow, endpoint = null) {
  if (vendorRow?.kind !== 'api') return 'CLI · subscription';
  let u; try { u = new URL(String(endpoint || '')); } catch { return 'API'; }
  return privateHost(u.hostname) ? 'API · local' : 'API · pay-per-token';
}

function normaliseEndpoint(raw, label) {
  const endpoint = checkEndpointUrl(raw.endpoint);
  const keyEnv = String(raw.keyEnv || '').trim();
  if (keyEnv && !KEY_ENV_RE.test(keyEnv)) throw new Error(`${label}: the key variable must be the NAME of an environment variable (letters, digits, underscores), not the key itself.`);
  if (!keyEnv && !privateHost(new URL(endpoint).hostname)) throw new Error(`${label}: a hosted API needs the name of the environment variable that holds its key.`);
  const model = raw.model ? String(raw.model).trim() : '';
  if (!model) throw new Error(`${label}: an API seat needs a model id (the endpoint has no default).`);
  return { endpoint, keyEnv: keyEnv || undefined, model, account: hostKey(endpoint) };
}

// vendors: { [vendor]: { label, effortLevels } } (the adapter table). efforts may widen a
// vendor's levels from the catalogue (codex reads its list from config.toml); models is the
// catalogue's model list per vendor, for the lightest model a hidden mood runs on.
export function normaliseSeats(input, { vendors, efforts = {}, models = {}, hidden = false }) {
  const issue = seatSetupIssue((input || []).map((raw) => raw && vendors[raw.vendor] ? raw : null));
  if (issue) throw Object.assign(new Error(issue.message), issue, { status: 400 });
  const seats = [];
  const perVendor = {};
  for (const raw of input || []) {
    if (!raw || !vendors[raw.vendor]) continue;
    const lens = String(raw.lens || '').trim();
    const allowed = efforts[raw.vendor] || vendors[raw.vendor].effortLevels || [];
    const effort = raw.effort ? String(raw.effort).trim() : null;
    if (effort && !allowed.includes(effort)) throw new Error(`${vendors[raw.vendor].label} does not accept effort "${effort}" (allowed: ${allowed.join(', ')}).`);
    perVendor[raw.vendor] = (perVendor[raw.vendor] || 0) + 1;
    // an endpoint seat: URL, model and key variable checked; its account is its host
    const ep = vendors[raw.vendor].kind === 'api' ? normaliseEndpoint(raw, `Seat "${lens}"`) : null;
    const mood = normaliseMood(raw.mood, { hidden });
    // a hidden mood always runs as cheaply as the seat's vendor allows
    const locked = mood.hidden ? { model: ep ? ep.model : lightestModel(raw.vendor, models[raw.vendor]) || (raw.model ? String(raw.model).trim() : undefined), effort: allowed[0] || undefined } : null;
    seats.push({
      id: `seat-${seats.length}`,
      vendor: raw.vendor,
      n: perVendor[raw.vendor],
      lens,
      mood,
      model: locked ? locked.model : ep ? ep.model : raw.model ? String(raw.model).trim() : undefined,
      effort: locked ? locked.effort : effort || undefined,
      account: ep ? ep.account : normaliseAccount(raw.account),
      ...(ep ? { endpoint: ep.endpoint, keyEnv: ep.keyEnv } : {}),
      // the vendor's colour (adapters config) unless the board sent one; positions as a fallback
      colour: COLOURS.includes(raw.colour) ? raw.colour : (vendors[raw.vendor].colour || COLOURS[seats.length % COLOURS.length]),
    });
  }
  if (seats.length < 2) throw new Error('Seat at least two instances, each with a lens.');
  // Human-side label only: "Codex 2" when a vendor is seated more than once; an endpoint seat
  // is named by its host ("API localhost-11434"). Never in a prompt.
  const perBase = {};
  for (const s of seats) { s.base = s.endpoint ? `API ${s.account}` : vendors[s.vendor].label; perBase[s.base] = (perBase[s.base] || 0) + 1; }
  const seen2 = {};
  for (const s of seats) { seen2[s.base] = (seen2[s.base] || 0) + 1; s.label = perBase[s.base] > 1 ? `${s.base} ${seen2[s.base]}` : s.base; delete s.base; }
  return seats;
}

export function normaliseChairman(raw, { vendors, efforts = {} }) {
  const vendor = raw?.vendor && vendors[raw.vendor] ? raw.vendor : null;
  if (!vendor) return null;
  const allowed = efforts[vendor] || vendors[vendor].effortLevels || [];
  const effort = raw.effort ? String(raw.effort).trim() : null;
  if (effort && !allowed.includes(effort)) throw new Error(`Chairman: ${vendors[vendor].label} does not accept effort "${effort}".`);
  const ep = vendors[vendor].kind === 'api' ? normaliseEndpoint(raw, 'Chairman') : null;
  return { vendor, colour: vendors[vendor].colour || undefined, model: ep ? ep.model : raw.model ? String(raw.model).trim() : undefined, effort: effort || undefined,
    account: ep ? ep.account : normaliseAccount(raw.account), ...(ep ? { endpoint: ep.endpoint, keyEnv: ep.keyEnv } : {}) };
}
