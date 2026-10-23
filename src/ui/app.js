import { rollup } from '/src/engine.js';
import { optionLabel } from '/src/contract.js';
import { poolKey, poolVendor, poolAccount, hostKey, seatKind } from '/src/seats.js';
import { avatar } from '/ui/avatars.js';
import { modelsForPlan, retired } from '/src/adapters/models.js';
import { project, projectedWindows } from '/src/estimate.js';

const $ = (id) => document.getElementById(id);
// The launch token the server put in the page; every POST carries it (server.js refuse()).
const SEND = { 'content-type': 'application/json', 'x-roundtable-token': document.querySelector('meta[name="roundtable-token"]')?.content || '' };
const LENSES = { claude: 'risk and failure modes', codex: 'cost and effort', agy: 'customer and adoption' };
const VENDOR_LABEL = {};
const VENDOR_META = {}; // vendor -> { kind, usageUrl, pool, catalogue, colour, profiles } from /api/seats
let MOODS = {}, COLOURS = ['rust', 'olive', 'teal', 'dusk', 'steel'], BASELINES = {};
// Known OpenAI-compatible endpoints, offered as the endpoint field's suggestions. A hosted API
// names the environment variable its key is usually kept in; the card prefills it, never a key.
const ENDPOINT_PRESETS = [
  { label: 'Ollama (this machine)', url: 'http://localhost:11434/v1' },
  { label: 'LM Studio (this machine)', url: 'http://localhost:1234/v1' },
  { label: 'vLLM (this machine)', url: 'http://localhost:8000/v1' },
  { label: 'llama.cpp server (this machine)', url: 'http://localhost:8080/v1' },
  { label: 'DeepSeek', url: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY' },
  { label: 'Moonshot (Kimi)', url: 'https://api.moonshot.ai/v1', keyEnv: 'MOONSHOT_API_KEY' },
  { label: 'OpenAI', url: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
];
const isApi = (vendor) => VENDOR_META[vendor]?.kind === 'api';
// The pool a drafted seat draws on: a CLI's login profile, or an endpoint's host.
const seatAccount = (s) => (isApi(s.vendor) ? hostKey(s.endpoint || '') : (s.account || '').trim());
const chairAccount = () => (isApi($('chairman').value) ? hostKey($('chairman-endpoint').value) : $('chairman-account').value.trim());

// ---------- state ----------
const S = {
  down: {}, // board: logins out for this debate (pool-down events)
  preflight: {}, preflighting: false, startConfirm: null, // setup screen: the lamps' answers per pool key
  slug: null, seats: [], fieldNotes: null, rows: [], rounds: [], humanNotes: [], gate: null, deadline: null, held: false,
  verdict: null, status: 'idle', startedAt: null, stopReason: null, pending: new Set(), quota: {}, calib: {}, pools: {}, chairman: null,
  conn: {}, // seat id -> connection state (idle, thinking, replied, reprompted, failed, timed-out), from seat-state events
  positions: [], // per round: seat id -> agreed | disagreed | neutral | passed | null, from round-done
  draft: [], // setup screen: the seat rows being edited
  budget: {}, // setup screen: vendor -> { tokens, usd } caps
};
const CONN_LABEL = { idle: 'idle', thinking: 'thinking', replied: 'replied', reprompted: 're-prompted', failed: 'failed', 'timed-out': 'timed out', down: 'out for this debate' };
// What a failed call's kind means for the human, in one line (adapters/errors.js classifies).
const ERROR_LINE = {
  quota: 'Out of quota.', auth: 'Not logged in.', missing: 'CLI not installed.', network: 'Could not reach the service (retried once).',
  timeout: 'Did not answer in time.', killed: 'Stopped before it answered.', format: 'The reply did not follow the verdict format.',
};
const POSITION_LABEL = { agreed: 'with the majority', disagreed: 'against the majority', neutral: 'own stance', passed: 'passed' };
const led = (state) => `<span class="led led-${esc(state || 'idle')}" title="${esc(CONN_LABEL[state] || 'idle')}" aria-label="${esc(CONN_LABEL[state] || 'idle')}"></span>`;

// ---------- setup screen ----------
async function setup() {
  const { vendors, moods, colours, defaults, baselines, calibration, pools } = await (await fetch('/api/seats')).json();
  MOODS = moods; COLOURS = colours; BASELINES = baselines || {}; S.calib = calibration || {}; S.pools = pools || {};
  const chair = $('chairman');
  for (const v of vendors) {
    VENDOR_LABEL[v.vendor] = v.label;
    VENDOR_META[v.vendor] = { kind: v.kind, usageUrl: v.usageUrl, pool: v.pool, catalogue: v.catalogue, colour: v.colour, profiles: v.profiles };
    if (v.quota) S.quota[v.vendor] = v.quota;
    chair.insertAdjacentHTML('beforeend', `<option value="${v.vendor}">${esc(v.label)}</option>`);
    // one datalist per vendor, so the model field offers what that CLI is known to accept
    $('datalists').insertAdjacentHTML('beforeend', `<datalist id="models-${v.vendor}">${(v.catalogue?.models || []).map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')}</datalist>`);
  }
  $('datalists').insertAdjacentHTML('beforeend', `<datalist id="endpoints">${ENDPOINT_PRESETS.map((e) => `<option value="${esc(e.url)}">${esc(e.label)}</option>`).join('')}</datalist>`);
  $('critique-rounds').value = defaults.critiqueRounds;
  $('auto').value = defaults.autoContinueMs / 1000;
  $('wall').value = defaults.wallClockMs / 60000;
  try { const saved = JSON.parse(localStorage.getItem('roundtable.notes') || 'null'); if (saved) for (const [k, v] of Object.entries(saved)) if (k !== 'options' && $(k)) $(k).value = v; S.options = String(saved?.options || '').split('\n').map((o) => o.trim()).filter(Boolean); } catch {}
  if (!S.options || S.options.length < 2) S.options = [...(S.options || []), '', ''].slice(0, Math.max(2, S.options?.length || 0));
  renderOptions();
  setupMoreContext();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('roundtable.seats') || 'null'); } catch {}
  S.draft = Array.isArray(saved) && saved.length >= 2 ? saved.filter((s) => VENDOR_META[s.vendor]) : vendors.filter((v) => v.kind !== 'api').map((v) => ({ vendor: v.vendor, lens: LENSES[v.vendor] || '', mood: 'grill', moodText: '', model: '', effort: '' }));
  renderSeats();
  chairEffortOptions();

  $('add-seat').addEventListener('click', () => { S.draft.push({ vendor: vendors[0].vendor, lens: '', mood: 'grill', moodText: '', model: '', effort: '' }); renderSeats(); });
  $('seats').addEventListener('input', onSeatEdit);
  $('seats').addEventListener('change', onSeatEdit);
  $('seats').addEventListener('click', (ev) => {
    const pip = ev.target.closest('.pip');
    if (pip) {
      const s = S.draft[Number(pip.closest('.seat').dataset.i)];
      const fam = s.vendor === 'agy' && familyOf('agy', s.model);
      if (fam) Object.assign(s, pickedModel('agy', fam.id, pip.dataset.level)); // a variant is always one level
      else s.effort = s.effort === pip.dataset.level ? '' : pip.dataset.level;
      renderSeats(); return;
    }
    const btn = ev.target.closest('.remove'); if (!btn) return;
    if (S.draft.length <= 2) { $('seats-error').textContent = 'A table needs at least two seats.'; return; }
    S.draft.splice(Number(btn.closest('.seat').dataset.i), 1); renderSeats();
  });
  chair.addEventListener('change', () => { $('chairman-model').value = ''; chairEffortOptions(); renderChair(); renderProjection(); });
  $('chair-pips').addEventListener('click', (ev) => {
    const pip = ev.target.closest('.pip'); if (!pip) return;
    const sel = $('chairman-effort');
    const fam = $('chairman').value === 'agy' && familyOf('agy', $('chairman-model').value.trim());
    if (fam) { const p = pickedModel('agy', fam.id, pip.dataset.level); $('chairman-model').value = p.model; sel.value = p.effort; }
    else sel.value = sel.value === pip.dataset.level ? '' : pip.dataset.level; // the filled last pip again: back to default
    renderChair(); renderProjection();
  });
  $('chair-card').addEventListener('change', (ev) => {
    if (ev.target.id !== 'chair-model-pick') return;
    const v = ev.target.value;
    if (v === '__other') { $('chairman-model').value = ''; renderChair(); $('chairman-model').focus(); return; }
    const p = pickedModel($('chairman').value, v, $('chairman-effort').value);
    $('chairman-model').value = p.model; if (p.effort !== undefined) $('chairman-effort').value = p.effort || '';
    renderChair(); renderProjection();
  });
  $('chairman-account').addEventListener('input', () => { renderChair(); requestPreflight(); });
  $('chairman').addEventListener('change', () => requestPreflight());
  // an endpoint chairman: a preset URL prefills the key variable's usual name (never a key)
  $('chairman-endpoint').addEventListener('change', () => { const pre = ENDPOINT_PRESETS.find((e) => e.url === $('chairman-endpoint').value.trim()); if (pre?.keyEnv && !$('chairman-keyenv').value.trim()) $('chairman-keyenv').value = pre.keyEnv; renderChair(); requestPreflight(); });
  for (const id of ['chairman-endpoint', 'chairman-keyenv']) $(id).addEventListener('input', () => { renderChair(); requestPreflight(); });
  renderChair();
  for (const id of ['chairman-model', 'chairman-effort', 'critique-rounds', 'memory']) $(id).addEventListener('input', renderProjection);
  $('memory').value = defaults.memory || 'stateless';
  $('start').addEventListener('click', start);
  try { S.budget = JSON.parse(localStorage.getItem('roundtable.budget') || '{}') || {}; } catch {}
  $('projection').addEventListener('input', (ev) => {
    const inp = ev.target.closest('.pool-cap input'); if (!inp) return;
    const v = inp.closest('.pool-cap').dataset.vendor;
    const b = (S.budget[v] ??= {});
    b[inp.name] = inp.value === '' ? undefined : Number(inp.value);
  });
  $('projection').addEventListener('submit', async (ev) => {
    const form = ev.target.closest('form.pool-entry'); if (!form) return;
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    const res = await fetch(`/api/pools/${form.dataset.vendor}`, { method: 'POST', headers: SEND, body: JSON.stringify(body) });
    const out = await res.json();
    if (res.ok) { S.pools[form.dataset.vendor] = out.pool; renderProjection(); } else form.querySelector('.error').textContent = out.error;
  });
}

// The pool figure a user entered for a vendor with no feed: remaining, its age, and what this
// table would take from it when a units-per-token rate was given.
function poolEntry(vendor, weightedTokens) {
  const pl = S.pools[vendor];
  const shown = pl ? `<span><b>${esc(pl.remaining.toLocaleString())} ${esc(pl.unit)}</b> remaining, entered ${agoText(pl.at)}${pl.note ? `, ${esc(pl.note)}` : ''}</span>${pl.perToken ? `<span>this table ≈ ${esc(Math.round(weightedTokens * pl.perToken).toLocaleString())} ${esc(pl.unit)}, ${pct(Math.min(1, weightedTokens * pl.perToken / (pl.remaining || 1)))} of it</span>` : ''}` : '<span>no figure entered</span>';
  return `<p class="pool-note">${shown}</p>
    <details class="pool-edit"><summary>Enter the remaining figure from the usage page</summary>
      <form class="pool-entry" data-vendor="${esc(vendor)}">
        <input name="remaining" type="number" min="0" step="any" placeholder="remaining" value="${pl ? esc(pl.remaining) : ''}" required>
        <input name="unit" placeholder="unit" value="${esc(pl?.unit || 'credits')}">
        <input name="perToken" type="number" min="0" step="any" placeholder="units per token (optional)" value="${pl?.perToken ?? ''}">
        <input name="note" placeholder="note" value="${esc(pl?.note || '')}">
        <button class="btn btn-small" type="submit">Save</button><span class="error"></span>
      </form>
    </details>`;
}

const effortOptions = (vendor, chosen, none = 'default') => `<option value="">${none}</option>${(VENDOR_META[vendor]?.catalogue?.efforts || []).map((e) => `<option value="${e}" ${e === chosen ? 'selected' : ''}>${e}</option>`).join('')}`;

function chairEffortOptions() {
  const sel = $('chairman-effort');
  const keep = sel.value;
  sel.innerHTML = effortOptions($('chairman').value, keep);
  $('chairman-model').setAttribute('list', `models-${$('chairman').value}`);
}

// A seat's colour is its vendor's (signature-design family accents): rust Claude, olive Codex,
// teal Antigravity. Two seats of one vendor share it and differ by number, lens and avatar.
const vendorColour = (vendor) => VENDOR_META[vendor]?.colour || 'ink';

// The model picker for one login: the vendor's models grouped by the plan its CLI reported
// (pre-flight), "other id…" for anything else. Antigravity lists one entry per model; its effort
// pips pick the variant. Returns { html, other } (other: show the free-text id field).
const familyOf = (vendor, model) => (VENDOR_META[vendor]?.catalogue?.families || []).find((f) => model === f.id || String(model).startsWith(`${f.id}-`));
function modelPicker(vendor, account, value, idAttr = '') {
  const cat = VENDOR_META[vendor]?.catalogue || {};
  const plan = S.preflight[poolKey(vendor, (account || '').trim(), !!VENDOR_META[vendor]?.profiles)]?.plan || null;
  let current, groups;
  if (vendor === 'agy') {
    const fam = familyOf(vendor, value);
    current = fam ? fam.id : value ? '__other' : '';
    groups = [{ label: 'On your account', items: cat.families || [] }];
  } else {
    const g = modelsForPlan(vendor, plan, cat.models || []);
    current = !value ? '' : [...g.onPlan, ...g.above].some((m) => m.id === value) ? value : '__other';
    groups = [{ label: g.plan ? `On your plan (${g.plan})` : 'Models', items: g.onPlan }, { label: g.plan ? 'Needs a higher plan' : '', items: g.above }];
  }
  const opt = (m) => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.label)}${m.note ? ` · ${esc(m.note)}` : ''}</option>`;
  const html = `<select class="flat model-pick" ${idAttr} aria-label="Model"><option value="">default${cat.defaultLabel ? ` (${esc(cat.defaultLabel)})` : ' model'}</option>${groups.filter((g) => g.items.length).map((g) => `<optgroup label="${esc(g.label)}">${g.items.map(opt).join('')}</optgroup>`).join('')}<option value="__other" ${current === '__other' ? 'selected' : ''}>other id…</option></select>`;
  return { html, other: current === '__other' };
}
// A picked model as the id to send: an Antigravity model takes its effort as the suffix.
function pickedModel(vendor, picked, effort) {
  if (vendor !== 'agy' || !picked) return { model: picked, effort };
  const fam = familyOf(vendor, picked);
  const level = fam?.levels.includes(effort) ? effort : fam?.levels.includes('medium') ? 'medium' : fam?.levels[0];
  return { model: level ? `${picked}-${level}` : picked, effort: level || '' };
}

// Effort as pips, one per level the CLI accepts; none filled is the CLI's own default. An
// Antigravity model offers the levels its id comes in.
function pipsHtml(vendor, chosen, model = '') {
  const levels = (vendor === 'agy' && familyOf(vendor, model)?.levels) || VENDOR_META[vendor]?.catalogue?.efforts || [];
  const at = levels.indexOf(chosen);
  return levels.map((l, i) => `<button type="button" class="pip ${i <= at ? 'on' : ''}" data-level="${l}" title="${l}" aria-label="Effort ${l}" aria-pressed="${l === chosen}"></button>`).join('')
    + `<span class="pip-label">${esc(chosen || 'default')}</span>`;
}

// The lamp: the pre-flight answer for the seat's pool when there is one (installed, logged in,
// quota; GET /api/preflight), else what the quota alone says.
function poolLamp(vendor, account) {
  const key = poolKey(vendor, account, !!VENDOR_META[vendor]?.profiles);
  const pf = S.preflight[key];
  if (pf) return { cls: pf.state, note: pf.note, kind: pf.kind };
  if (S.preflighting) return { cls: 'idle', note: 'checking…' };
  const q = S.quota[key];
  if (!q?.windows?.length) return { cls: 'idle', note: vendor === 'agy' ? 'quota not reported by this CLI' : 'not checked yet' };
  const worst = q.windows.reduce((a, w) => (w.used > a.used ? w : a));
  const text = q.windows.map((w) => `${w.label} ${pct(w.used)}`).join(' · ');
  if (worst.used >= 1) return { cls: 'danger', note: `quota used up (${worst.label})${worst.resetsAt ? `, resets ${untilText(worst.resetsAt * 1000)}` : ''}` };
  if (worst.used >= 0.9) return { cls: 'warn', note: `quota nearly used: ${text}` };
  return { cls: 'ok', note: `ready · ${text}` };
}

function seatRow(s, i) {
  const colour = vendorColour(s.vendor);
  const api = isApi(s.vendor);
  const same = S.draft.filter((x) => x.vendor === s.vendor);
  const n = same.length > 1 ? ` ${same.indexOf(s) + 1}` : '';
  const lamp = poolLamp(s.vendor, seatAccount(s));
  // an endpoint seat has no catalogue: the model id is typed, and the card says it is required
  const picker = api ? { html: '', other: true } : modelPicker(s.vendor, s.account, s.model || '');
  const gone = retired(s.vendor, (s.model || '').trim());
  return `<article class="seat seat-card" role="listitem" data-i="${i}" style="--seat: var(--seat-${colour})">
    <div class="seat-hd">
      <span class="avatar" title="${esc(s.mood === 'custom' ? 'custom mood' : s.mood)}">${avatar(s.mood === 'custom' ? 'custom' : s.mood)}</span>
      <div class="seat-id">
        <span class="chair-title"><select class="flat vendor" aria-label="Vendor">${Object.keys(VENDOR_META).map((v) => `<option value="${v}" ${v === s.vendor ? 'selected' : ''}>${esc(VENDOR_LABEL[v])}</option>`).join('')}</select>${n ? `<span class="seat-note">${n.trim()}</span>` : ''}<span class="kind-tag ${api ? 'api' : ''}" title="${api ? 'Billed by the endpoint, not a subscription' : 'The vendor CLI on your subscription'}">${esc(seatKind(VENDOR_META[s.vendor], s.endpoint))}</span></span>
        ${picker.html}<input class="flat model" aria-label="Model id" list="models-${s.vendor}" value="${esc(s.model)}" placeholder="${api ? 'model id (required)' : 'model id'}" ${picker.other ? '' : 'hidden'}>
      </div>
      <span class="lamp ${lamp.cls}" title="${esc(lamp.note)}"></span>
    </div>
    <button class="btn remove" type="button" aria-label="Remove seat" title="Remove seat">×</button>
    <div class="seat-bd">
      <label class="f"><span class="label">Lens</span><input class="flat lens" value="${esc(s.lens)}" placeholder="risk and failure modes"></label>
      <label class="f"><span class="label">Mood</span><select class="flat mood">${Object.keys(MOODS).map((m) => `<option value="${m}" ${m === s.mood ? 'selected' : ''}>${m}</option>`).join('')}<option value="custom" ${s.mood === 'custom' ? 'selected' : ''}>custom…</option></select></label>
      <input class="flat mood-text" aria-label="Custom mood" value="${esc(s.moodText)}" placeholder="One sentence: how this seat approaches the question" ${s.mood === 'custom' ? '' : 'hidden'}>
      ${gone ? `<span class="seat-note danger">${esc(s.model)} was retired (${esc(gone.date)}); use ${esc(gone.instead)}.</span>` : ''}
      ${api ? `<label class="f"><span class="label">Endpoint</span><input class="flat endpoint" aria-label="Endpoint base URL" list="endpoints" value="${esc(s.endpoint || '')}" placeholder="http://localhost:11434/v1" title="The base URL of an OpenAI-compatible server, ending in /v1. Plain http only on this machine or a private network."></label>
      <label class="f"><span class="label">Key var</span><input class="flat keyenv" aria-label="Key environment variable" value="${esc(s.keyEnv || '')}" placeholder="none (local server)" title="The NAME of the environment variable that holds the key, set in the shell roundtable was started from. Never the key itself."></label>` : ''}
      <div class="f"><span class="label">Effort</span><span class="pips">${pipsHtml(s.vendor, s.effort, s.model)}</span><select class="effort" hidden>${effortOptions(s.vendor, s.effort)}</select></div>
      <span class="seat-note lamp-note ${lamp.cls === 'danger' || lamp.cls === 'warn' ? lamp.cls : ''}">${esc(lamp.note)}</span>
      ${api ? '' : `<details class="seat-more" ${s.account ? 'open' : ''}><summary>Login profile</summary><input class="flat account" aria-label="Login profile" value="${esc(s.account || '')}" placeholder="none: your usual login" title="A second login of this CLI, for example a work subscription; node src/doctor.js shows how to log a profile in"></details>`}
    </div>
  </article>`;
}

// Ask the server for every pool on the table (seats and chairman), then relight the lamps in
// place, so a field being typed in keeps its focus. Debounced: one request per pause.
let preflightTimer = null;
function requestPreflight({ fresh = false } = {}) {
  clearTimeout(preflightTimer);
  preflightTimer = setTimeout(async () => {
    const seats = [...S.draft, { vendor: $('chairman').value, account: $('chairman-account').value.trim(), endpoint: $('chairman-endpoint').value, keyEnv: $('chairman-keyenv').value }];
    const keys = [...new Set(seats.map((s) => poolKey(s.vendor, seatAccount(s), !!VENDOR_META[s.vendor]?.profiles)))];
    // an API pool is checked from its URL and key-variable NAME (no request leaves the server);
    // those travel in the body, so its lamp follows every edit
    const endpoints = {};
    for (const s of seats) if (isApi(s.vendor)) endpoints[poolKey(s.vendor, seatAccount(s), true)] = { url: (s.endpoint || '').trim(), keyEnv: (s.keyEnv || '').trim() || null };
    const epSig = JSON.stringify(endpoints);
    if (!keys.some((k2) => !S.preflight[k2]) && !fresh && epSig === S.preflightEndpoints) { updateLamps(); return; }
    S.preflighting = true; updateLamps();
    try {
      const { pools } = await (await fetch('/api/preflight', { method: 'POST', headers: SEND, body: JSON.stringify({ pools: keys, endpoints, fresh }) })).json();
      S.preflightEndpoints = epSig;
      const newPlan = pools.some((p) => p.plan && S.preflight[p.key]?.plan !== p.plan);
      for (const p of pools) { S.preflight[p.key] = p; if (p.quota) S.quota[p.key] = p.quota; }
      // the model pickers group by plan: redraw them once a plan is known (not while typing)
      if (newPlan && !$('seats').contains(document.activeElement)) { S.preflighting = false; renderSeats(); renderChair(); return; }
    } catch { /* the lamps keep what they had */ }
    S.preflighting = false; updateLamps();
  }, 400);
}
function updateLamps() {
  $('seats').querySelectorAll('.seat').forEach((card) => {
    const s = S.draft[Number(card.dataset.i)]; if (!s) return;
    const l = poolLamp(s.vendor, seatAccount(s));
    const lampEl = card.querySelector('.lamp'); lampEl.className = `lamp ${l.cls}`; lampEl.title = l.note;
    const note = card.querySelector('.lamp-note');
    if (note) { note.textContent = l.note; note.className = `seat-note lamp-note ${l.cls === 'danger' || l.cls === 'warn' ? l.cls : ''}`; }
  });
  const c = poolLamp($('chairman').value, chairAccount());
  $('chair-lamp').className = `lamp ${c.cls}`; $('chair-lamp').title = c.note;
  $('chair-note').textContent = c.note; $('chair-note').className = `seat-note ${c.cls === 'danger' || c.cls === 'warn' ? c.cls : ''}`;
  S.startConfirm = null; $('start').textContent = 'Open the table';
}

// The chairman card: vendor colour, the gavel, effort pips; its controls keep their ids.
function renderChair() {
  const v = $('chairman').value;
  const card = $('chair-card');
  card.style.setProperty('--seat', `var(--seat-${vendorColour(v)})`);
  $('chair-avatar').innerHTML = avatar('chairman');
  const api = isApi(v);
  $('chair-kind').textContent = seatKind(VENDOR_META[v], $('chairman-endpoint').value);
  $('chair-kind').classList.toggle('api', api);
  $('chair-api').hidden = !api; $('chair-profile').hidden = api;
  const picker = api ? { html: '', other: true } : modelPicker(v, $('chairman-account').value, $('chairman-model').value.trim(), 'id="chair-model-pick"');
  $('chair-model-slot').innerHTML = picker.html;
  $('chairman-model').hidden = !picker.other;
  $('chairman-model').placeholder = api ? 'model id (required)' : 'model id';
  $('chair-pips').innerHTML = pipsHtml(v, $('chairman-effort').value, $('chairman-model').value.trim());
  updateLamps();
}

// Options as chips: opt-1, opt-2 ... as the seats will see them. Enter adds the next one,
// Backspace in an empty chip removes it, a repeated option is marked.
function renderOptions(focus = null) {
  const seen = new Map();
  for (const o of S.options) { const kk = o.trim().toLowerCase(); if (kk) seen.set(kk, (seen.get(kk) || 0) + 1); }
  $('options-editor').innerHTML = S.options.map((o, i) => `<span class="opt ${seen.get(o.trim().toLowerCase()) > 1 ? 'dup' : ''}" data-i="${i}"><b>opt-${i + 1}</b><input value="${esc(o)}" size="${Math.max(8, o.length + 1)}" aria-label="Option ${i + 1}" placeholder="${i === 0 ? 'Stay as we are' : i === 1 ? 'Change it' : 'Another option'}"><button type="button" class="opt-x" aria-label="Remove option ${i + 1}" ${S.options.length <= 2 ? 'hidden' : ''}>×</button></span>`).join('')
    + `<button type="button" class="btn btn-small opt-add" ${S.options.length >= 12 ? 'hidden' : ''}>+ option</button>`;
  if (focus != null) $('options-editor').querySelectorAll('.opt input')[focus]?.focus();
}
function wireOptions() {
  const ed = $('options-editor');
  ed.addEventListener('input', (ev) => {
    const chip = ev.target.closest('.opt'); if (!chip) return;
    S.options[Number(chip.dataset.i)] = ev.target.value;
    ev.target.size = Math.max(8, ev.target.value.length + 1);
    const seen = S.options.map((o) => o.trim().toLowerCase());
    ed.querySelectorAll('.opt').forEach((c, i) => c.classList.toggle('dup', !!seen[i] && seen.indexOf(seen[i]) !== seen.lastIndexOf(seen[i])));
  });
  ed.addEventListener('keydown', (ev) => {
    const chip = ev.target.closest('.opt'); if (!chip) return;
    const i = Number(chip.dataset.i);
    if (ev.key === 'Enter') { ev.preventDefault(); if (S.options.length < 12) { S.options.splice(i + 1, 0, ''); renderOptions(i + 1); } }
    if (ev.key === 'Backspace' && !ev.target.value && S.options.length > 2) { ev.preventDefault(); S.options.splice(i, 1); renderOptions(Math.max(0, i - 1)); }
  });
  ed.addEventListener('click', (ev) => {
    if (ev.target.closest('.opt-add')) { S.options.push(''); renderOptions(S.options.length - 1); return; }
    const x = ev.target.closest('.opt-x'); if (!x) return;
    S.options.splice(Number(x.closest('.opt').dataset.i), 1); renderOptions();
  });
}

// "More context" opens by itself when any of its fields has content, and says how many do.
const MORE = ['known', 'assumed', 'reversibility', 'deadline', 'exportTo'];
function setupMoreContext() {
  const count = () => MORE.filter((id) => $(id).value.trim()).length;
  const show = () => { const n = count(); $('more-filled').textContent = n ? `· ${n} filled` : ''; };
  if (count()) $('more-context').open = true;
  show();
  for (const id of MORE) $(id).addEventListener('input', show);
  wireOptions();
}

function renderSeats() {
  $('seats').innerHTML = S.draft.map(seatRow).join('');
  requestPreflight();
  renderProjection();
}

function onSeatEdit(ev) {
  const row = ev.target.closest('.seat'); if (!row) return;
  const s = S.draft[Number(row.dataset.i)];
  if (ev.target.classList.contains('model-pick')) {
    if (ev.type !== 'change') return;
    const v = ev.target.value;
    if (v === '__other') { s.model = ''; renderSeats(); $('seats').querySelectorAll('.seat')[S.draft.indexOf(s)]?.querySelector('.model')?.focus(); return; }
    Object.assign(s, pickedModel(s.vendor, v, s.effort));
    renderSeats(); renderProjection(); return;
  }
  const vendorBefore = s.vendor;
  s.vendor = row.querySelector('.vendor').value;
  s.lens = row.querySelector('.lens').value;
  s.mood = row.querySelector('.mood').value;
  s.moodText = row.querySelector('.mood-text').value;
  s.model = row.querySelector('.model').value;
  s.effort = row.querySelector('.effort').value;
  s.account = row.querySelector('.account')?.value ?? ''; // an endpoint card has no login profile
  if (row.querySelector('.endpoint')) {
    s.endpoint = row.querySelector('.endpoint').value;
    s.keyEnv = row.querySelector('.keyenv').value;
    // a preset URL prefills the key variable's usual NAME, once, never a key
    const pre = ev.type === 'change' && ev.target.classList.contains('endpoint') && ENDPOINT_PRESETS.find((e) => e.url === s.endpoint.trim());
    if (pre?.keyEnv && !s.keyEnv.trim()) s.keyEnv = pre.keyEnv;
  }
  if (s.vendor !== vendorBefore) { s.model = ''; s.effort = ''; renderSeats(); return; } // the catalogue changed
  // the avatar follows the mood, the lamp the login profile or the endpoint: redraw the cards (not while typing)
  if (['account', 'endpoint', 'keyenv'].some((c) => ev.target.classList.contains(c))) requestPreflight();
  if (ev.type === 'change' && ['mood', 'account', 'endpoint', 'keyenv'].some((c) => ev.target.classList.contains(c))) { renderSeats(); if (s.mood === 'custom') $('seats').querySelectorAll('.seat')[S.draft.indexOf(s)]?.querySelector('.mood-text')?.focus(); return; }
  row.querySelector('.mood-text').hidden = s.mood !== 'custom';
  renderProjection();
}

function draftSeats() {
  return S.draft.map((s, i) => ({
    vendor: s.vendor, lens: s.lens.trim(), colour: vendorColour(s.vendor),
    mood: s.mood === 'custom' ? { preset: 'custom', text: s.moodText.trim() } : { preset: s.mood },
    model: s.model.trim() || undefined, effort: s.effort || undefined, account: seatAccount(s) || undefined,
    ...(isApi(s.vendor) ? { endpoint: (s.endpoint || '').trim(), keyEnv: (s.keyEnv || '').trim() || undefined } : {}),
  }));
}
// The chairman as the server takes it (normaliseChairman): an endpoint chairman carries its URL,
// key variable name and host-derived account, like a seat.
function draftChairman() {
  const vendor = $('chairman').value;
  return { vendor, model: $('chairman-model').value.trim() || undefined, effort: $('chairman-effort').value || undefined, account: chairAccount() || undefined,
    ...(isApi(vendor) ? { endpoint: $('chairman-endpoint').value.trim(), keyEnv: $('chairman-keyenv').value.trim() || undefined } : {}) };
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(Math.round(n)));
const pct = (x) => `${(x * 100).toFixed(x * 100 < 10 ? 1 : 0)}%`;
const level = (x) => (x >= 0.9 ? 'danger' : x >= 0.7 ? 'warn' : '');
const width = (x) => Math.max(0, Math.min(100, x * 100)).toFixed(1);

// The measured draw of one window per 100k tokens: a short form for the readout and the full
// sentence (every model key that has one) for its title.
function rateFor(vendor, label) {
  const keys = Object.keys(S.calib).filter((k2) => k2 === vendor || k2.startsWith(`${vendor}:`));
  const long = [], short = [];
  for (const key of keys) {
    const x = S.calib[key][label]; if (!x || !(x.samples > 0 || x.ceilPerToken)) continue;
    const who = key === vendor ? '' : `, ${key.split(':')[1]}`;
    if (x.samples > 0) { long.push(`${label}: ${pct(x.pctPerToken * 100000)} per 100k tokens (${x.samples} measured move${x.samples === 1 ? '' : 's'}${who})`); if (key === vendor || !short.length) short[0] = `${pct(x.pctPerToken * 100000)}/100k`; }
    else { long.push(`${label}: no movement seen over ${k(x.pending)} tokens yet${who}`); if (!short.length) short[0] = 'no move seen'; }
  }
  return { short: short[0] || '', long: long.join('\n') };
}

// Which window to show first, given each window's used share (0..1), its reset (epoch seconds
// or null) and, on the setup screen, this debate's projected draw `adds` (0..1, else null).
// A display order only: every window stays visible at every width. Returns an index.
function leadWindow(windows) {
  const now = Date.now() / 1000;
  const horizon = (Number($('wall').value) || 30) * 60; // the debate's wall clock
  const score = (w) => {
    const after = w.used + (w.adds || 0);
    if (after >= 1) return 2 + after; // this debate would not finish inside it
    if (after >= 0.9) return 1 + after; // nearly spent: first, whatever its reset
    // a window that resets before the debate could end frees itself, so it counts for half
    return w.resetsAt != null && w.resetsAt - now < horizon ? after / 2 : after;
  };
  return windows.reduce((best, w, i) => (score(w) > score(windows[best]) ? i : best), 0);
}

// One limit window: figure, window name, a track with the used share and the projected draw,
// and the reset beneath (signature-design "Window readout").
function readout(vendor, w, { lead = false, adds = null, upper = false } = {}) {
  const after = w.used + (adds || 0);
  const rate = rateFor(vendor, w.label);
  const sub = [
    w.resetsAt ? `resets ${untilText(w.resetsAt * 1000).replace(/^in /, '')}` : '',
    adds != null ? (upper ? 'no move seen yet' : `+${pct(adds)} this debate`) : rate.short,
  ].filter(Boolean).join(' · ');
  return `<div class="readout ${lead ? 'lead' : ''} ${level(after) ? `lvl-${level(after)}` : ''}" title="${esc(rate.long)}">
    <div class="readout-fig"><b>${pct(w.used)}</b><span>${esc(w.label)} used</span></div>
    <div class="track"><span class="used" style="width: ${width(w.used)}%"></span>${adds ? `<span class="adds" style="width: ${width(Math.min(adds, 1 - w.used))}%"></span>` : ''}</div>
    <div class="readout-sub">${esc(sub)}</div>
  </div>`;
}

// Lead window first; the rest keep their order.
function readouts(vendor, windows) {
  const i = windows.length > 1 ? leadWindow(windows) : 0;
  const lead = Number.isInteger(i) && i >= 0 && i < windows.length ? i : 0;
  const order = [lead, ...windows.map((_, i) => i).filter((i) => i !== lead)];
  return order.map((i) => readout(vendor, windows[i], { lead: i === lead, adds: windows[i].adds ?? null, upper: windows[i].upper })).join('');
}

// key: a vendor or a pool key (seats.poolKey); a named profile shows as "Codex (work)"
const seatPool = (s) => poolKey(s.vendor, s.account, !!VENDOR_META[s.vendor]?.profiles);
const poolId = (key) => { const vendor = poolVendor(key), account = poolAccount(key); return `<div class="pool-id"><b>${esc(VENDOR_LABEL[vendor] || vendor)}${account ? ` (${esc(account)})` : ''}</b><span title="${esc(VENDOR_META[vendor]?.pool || '')}">${esc(VENDOR_META[vendor]?.pool || '')}</span></div>`; };
const usageLink = (key) => { const m = VENDOR_META[poolVendor(key)]; return m?.usageUrl ? `<a href="${esc(m.usageUrl)}" target="_blank" rel="noopener">usage page &#8599;</a>` : ''; };

// One block per vendor pool: live windows, the projected draw for this table stacked per seat,
// and the measured per-round share where a calibration exists.
function renderProjection() {
  const seats = draftSeats().map((s, i) => ({ ...s, id: `seat-${i}` }));
  const chairman = draftChairman();
  const p = project({ seats, chairman, critiqueRounds: Number($('critique-rounds').value) || 0, baselines: BASELINES, memory: $('memory').value });
  const label = (id) => (id === 'chairman' ? 'chairman' : `${seats[Number(id.slice(5))]?.lens || id}`);
  const colourOf = (id) => (id === 'chairman' ? vendorColour(chairman.vendor) : seats[Number(id.slice(5))]?.colour || 'ink');
  $('projection').innerHTML = Object.values(p.byVendor).map((v) => {
    // the vendor's seats all on one account: that account's pool; mixed: the default one
    const keys = new Set(v.seats.map((id) => (id === 'chairman' ? seatPool(chairman) : seatPool(seats[Number(id.slice(5))]))));
    const pool = keys.size === 1 ? [...keys][0] : v.vendor;
    const q = S.quota[pool];
    const pw = projectedWindows(S.calib, pool, v.seats.map((id) => p.bySeat[id])) || [];
    // Live windows carry this debate's projected draw; without a live figure the projection is
    // all there is, so it stays a sentence.
    const windows = q ? q.windows.map((w) => { const x = pw.find((y) => y.label === w.label); return { ...w, adds: x ? x.pct : null, upper: !!x?.upperBound }; }) : [];
    const projected = q ? '' : pw.length ? pw.map((w) => (w.upperBound
      ? `No movement of the ${esc(w.label)} window seen over ${k(w.pending)} tokens yet.`
      : `About +${pct(w.pct)} of the ${esc(w.label)} window (${w.samples} measured move${w.samples === 1 ? '' : 's'}).`)).join(' ')
      : (v.vendor === 'agy' ? 'The CLI reports no remaining credits; tokens per seat are exact.' : 'Window share is unmeasured until a debate runs.');
    const cap = S.budget[v.vendor];
    return `<div class="pool">
      <div class="pool-top">${poolId(pool)}<div class="pool-total"><b>≈ ${k(v.total)}</b><span>tokens${v.cost != null ? ` · ≈ $${v.cost.toFixed(2)}` : ''}</span></div></div>
      <div class="bar" aria-label="Projected share of the pool per seat">${v.seats.map((id) => `<span style="--seat: var(--seat-${colourOf(id)}); width: ${(100 * p.bySeat[id].weighted / (v.weighted || 1)).toFixed(1)}%" title="${esc(label(id))}"></span>`).join('')}</div>
      <div class="pool-seats">${v.seats.map((id) => {
        const row = p.bySeat[id];
        return `<span class="chip" style="--seat: var(--seat-${colourOf(id)})" title="${esc(row.calls)} calls${row.model ? ', ' + esc(row.model) : ''}${row.weight !== 1 ? `, model weight ×${row.weight}` : ''}"><span>${esc(label(id))}</span><b>${k(row.total)}</b>${row.cost != null ? `<span>$${row.cost.toFixed(2)}</span>` : ''}</span>`;
      }).join('')}</div>
      ${v.weighted !== v.total ? `<p class="pool-note">≈ ${k(v.weighted)} pool units after model weight.</p>` : ''}
      ${windows.length ? `<div class="readouts">${readouts(pool, windows)}</div>` : `<p class="pool-note">${projected}</p>`}
      <div class="pool-cap" data-vendor="${esc(v.vendor)}"><label for="cap-${esc(v.vendor)}" title="Projected before each call, with the calls in flight and the verdict reserved. The vendor does not enforce it.">Cap</label><input id="cap-${esc(v.vendor)}" name="tokens" type="number" min="0" step="1000" placeholder="tokens" value="${cap?.tokens ?? ''}" aria-label="Token cap for ${esc(VENDOR_LABEL[v.vendor] || v.vendor)}">${v.cost != null ? `<input name="usd" type="number" min="0" step="0.05" placeholder="$" value="${cap?.usd ?? ''}" aria-label="Dollar cap for ${esc(VENDOR_LABEL[v.vendor] || v.vendor)}">` : ''}${cap?.tokens > 0 && v.total > cap.tokens ? '<span class="warn">the projection is over this cap</span>' : ''}${usageLink(v.vendor)}</div>
      ${q ? '' : poolEntry(v.vendor, v.weighted)}
    </div>`;
  }).join('') || '<span class="muted">Seat at least one instance.</span>';
  const vs = Object.values(p.byVendor);
  const rounds = Number($('critique-rounds').value) || 0;
  const priced = vs.filter((v) => v.cost != null);
  $('start-summary').innerHTML = seats.length ? `<b>${seats.length} seats</b> · up to ${seats.length * (rounds + 1) + 1} calls · ≈ ${k(vs.reduce((n, v) => n + v.total, 0))} tokens${priced.length ? ` · ≈ $${priced.reduce((n, v) => n + v.cost, 0).toFixed(2)} for ${priced.map((v) => esc(VENDOR_LABEL[v.vendor] || v.vendor)).join(', ')}` : ''}` : '';
}

async function start() {
  // a seat whose lamp is red would fail its first call: say which, and open only on a second click
  const red = [...S.draft.map((s) => ({ name: `${VENDOR_LABEL[s.vendor]} (${s.lens || 'no lens'})`, l: poolLamp(s.vendor, seatAccount(s)) })),
    { name: `the chairman (${VENDOR_LABEL[$('chairman').value]})`, l: poolLamp($('chairman').value, chairAccount()) }].filter((x) => x.l.cls === 'danger');
  const sig = red.map((x) => `${x.name}:${x.l.note}`).join('|');
  if (red.length && S.startConfirm !== sig) {
    S.startConfirm = sig;
    $('setup-error').textContent = `${red.map((x) => `${x.name}: ${x.l.note}`).join('; ')}. Those calls will fail.`;
    $('start').textContent = 'Open anyway';
    return;
  }
  const f = $('notes');
  const notes = {};
  for (const el of f.querySelectorAll('input[name], textarea[name]')) notes[el.name] = el.value.trim();
  notes.options = S.options.map((o) => o.trim()).filter(Boolean).join('\n');
  const fieldNotes = { ...notes, options: notes.options.split('\n').filter(Boolean) };
  const body = {
    fieldNotes, seats: draftSeats(),
    chairman: draftChairman(),
    options: { critiqueRounds: Number($('critique-rounds').value), autoContinueMs: Number($('auto').value) * 1000, wallClockMs: Number($('wall').value) * 60000, memory: $('memory').value, budget: budgetBody() },
  };
  try { localStorage.setItem('roundtable.notes', JSON.stringify(notes)); localStorage.setItem('roundtable.seats', JSON.stringify(S.draft)); localStorage.setItem('roundtable.budget', JSON.stringify(S.budget)); } catch {}
  $('setup-error').textContent = ''; $('seats-error').textContent = '';
  const res = await fetch('/api/debates', { method: 'POST', headers: SEND, body: JSON.stringify(body) });
  const out = await res.json();
  if (!res.ok) { (/lens|seat|effort|mood|Chairman/i.test(out.error) ? $('seats-error') : $('setup-error')).textContent = out.error; return; }
  location.hash = out.slug; // route() opens the board
}

// Only vendors with a positive cap are sent; an empty field is no cap.
function budgetBody() {
  const out = {};
  for (const [v, b] of Object.entries(S.budget)) {
    const cap = {};
    if (b?.tokens > 0) cap.tokens = b.tokens;
    if (b?.usd > 0) cap.usd = b.usd;
    if (Object.keys(cap).length) out[v] = cap;
  }
  return out;
}

// ---------- board ----------
// The hash decides the screen: '#<slug>' is that debate's board, no hash is the setup screen with
// the list of debates. Back and forward work, and a board link can be shared or bookmarked.
let live = null; // the open board's { es, timer }
function closeBoard() { if (live) { live.es.close(); clearInterval(live.timer); live = null; } }
function route() {
  closeBoard();
  const slug = decodeURIComponent(location.hash.slice(1));
  if (/^[a-z0-9-]+$/.test(slug)) openBoard(slug); else showSetup();
}
function showSetup() {
  S.slug = null; resetBoard();
  $('setup').hidden = false; $('board').hidden = true; $('humanbar').hidden = true; $('nav-debates').hidden = true;
  $('sys').className = 'status ok'; $('sys').textContent = 'idle';
  for (const id of ['st-round', 'st-seats', 'st-elapsed']) $(id).textContent = '';
  document.title = 'Roundtable';
  loadRecent();
}

// The debates on disk, newest first: status, the pick, size, and a link to each board.
const STATE_CLASS = { running: 'warn', interrupted: 'warn', accepted: 'ok', recommended: 'info', 'no verdict': 'danger' };
const STATE_LABEL = { running: 'live', interrupted: 'interrupted', accepted: 'accepted', recommended: 'recommended', split: 'split', stopped: 'stopped', 'no verdict': 'no verdict' };
async function loadRecent() {
  let list = [];
  try { list = (await (await fetch('/api/debates')).json()).debates || []; } catch { /* the list is optional */ }
  $('recent-count').textContent = list.length ? `${list.length} on this machine` : '';
  if (!list.length) {
    $('recent-list').innerHTML = '<div class="empty"><span><span class="prompt">&gt;</span> no debates yet<br>&nbsp;&nbsp;write the field notes below and open the table_</span></div>';
    return;
  }
  const row = (d) => {
    // the human's choice once accepted, otherwise the recommendation when there is a real one
    const pick = d.status === 'accepted' ? d.accepted : ['no consensus', 'no pick', 'no verdict'].includes(d.recommended) ? '' : d.recommended;
    const cost = d.cost != null ? ` · $${d.cost.toFixed(2)}${d.costPartial ? '+' : ''}` : '';
    return `<a class="debate-row" href="#${esc(d.slug)}" title="${esc(d.decision)}">
      <span class="data">${esc(d.date)}</span>
      <span class="debate-title">${esc(d.decision)}</span>
      <span class="status ${STATE_CLASS[d.status] || 'muted'}">${esc(STATE_LABEL[d.status] || d.status)}</span>
      <span class="debate-pick">${esc(pick || '')}</span>
      <span class="data">${d.rounds} rd · ${k(d.tokens)}${cost}</span>
    </a>`;
  };
  const shown = S.showAllDebates ? list : list.slice(0, 5);
  $('recent-list').innerHTML = shown.map(row).join('') + (list.length > 5 ? `<button class="btn btn-small debates-more" id="debates-more" type="button">${S.showAllDebates ? 'Show the latest 5' : `Show all ${list.length}`}</button>` : '');
}

function openBoard(slug) {
  resetBoard();
  S.slug = slug;
  $('setup').hidden = true; $('board').hidden = false; $('humanbar').hidden = false; $('nav-debates').hidden = false;
  // EventSource reconnects by itself and sends Last-Event-ID, so a dropped connection costs
  // nothing. After a server restart the stream begins again with `started`, which resets the
  // board; a slug with no transcript keeps retrying and says so.
  const es = new EventSource(`/api/debates/${slug}/events`);
  es.onmessage = (m) => { S.connected = true; handle(JSON.parse(m.data)); };
  es.onerror = () => { S.connected = false; renderGate(); renderBanners(); };
  es.onopen = () => { S.connected = true; renderGate(); renderBanners(); };
  live = { es, timer: setInterval(tick, 1000) };
  render(); // clear what the last board showed, before this one's first event (or a 404)
}

function resetBoard() {
  Object.assign(S, { seats: [], fieldNotes: null, rows: [], rounds: [], humanNotes: [], gate: null, deadline: null, held: false, verdict: null, status: 'idle', startedAt: null, stopReason: null, pending: new Set(), chairman: null, interrupted: null, stopQueued: false, error: null, conn: {}, positions: [], accepted: null, synthesis: null, down: {},
    budgetStop: null, exported: null, exportError: null, replayed: false, connected: null, chairmanFallback: null }); // hash routing reuses S: nothing from the last board
}

function handle(e) {
  switch (e.type) {
    case 'started': resetBoard(); S.seats = e.seats; S.fieldNotes = e.fieldNotes; S.status = 'running'; S.startedAt = Date.now(); $('board-title').textContent = e.fieldNotes.decision; document.title = `${e.fieldNotes.decision} · Roundtable`; $('board-empty').hidden = false; break;
    case 'resumed': S.status = 'running'; S.interrupted = null; S.startedAt = Date.now(); S.pending.clear(); break;
    case 'interrupted': S.status = 'interrupted'; S.interrupted = e; S.pending.clear(); break;
    case 'round-start': S.rounds[e.round] = []; S.pending = new Set(S.seats.map((s) => s.index)); $('board-empty').hidden = true; break;
    case 'seat-start': break;
    case 'seat-state': S.conn[e.seat.id] = e.state; break;
    case 'reprompt': S.pending.add(e.seat.index); break;
    case 'reply': S.rows.push(e); S.rounds[e.round] = S.rounds[e.round] || []; S.rounds[e.round].push(e); S.pending.delete(e.seat.index); break;
    case 'round-done': S.pending.clear(); if (e.positions) S.positions[e.round] = e.positions; break;
    case 'gate': S.gate = e; S.deadline = null; S.held = false; S.status = 'waiting'; break;
    case 'countdown': S.deadline = e.deadline; break;
    case 'held': S.held = true; S.deadline = null; break;
    case 'gate-closed': S.gate = null; S.deadline = null; S.status = 'running'; break;
    case 'stop-queued': S.stopQueued = true; break;
    case 'human': (S.humanNotes[e.round] ??= []).push(e.text); break;
    case 'quota': S.quota[e.vendor] = e.quota; break;
    case 'calibration': S.calib[e.key || e.vendor] = e.windows; break;
    case 'pool': S.pools[e.vendor] = e.pool; break;
    case 'pool-down': S.down[e.key] = e; break;
    case 'budget': S.budgetStop = e; break;
    case 'stopped': S.stopReason = e.reason; S.status = 'verdict'; break;
    case 'chairman-start': S.chairman = e.seat; break;
    case 'chairman-fallback': S.chairmanFallback = e; break;
    case 'attempt': S.rows.push(e); break;
    case 'verdict': S.rows.push(e); S.verdict = e; break;
    case 'done': S.status = 'done'; S.replayed = !!e.replayed; S.synthesis = e.synthesis || (S.verdict ? (S.verdict.skipped ? 'skipped' : S.verdict.failed ? 'failed' : 'done') : 'missing'); break;
    case 'synthesize': S.status = 'verdict'; S.verdict = null; break;
    case 'accepted': S.accepted = e; break;
    case 'exported': S.exported = e; S.exportError = null; break;
    case 'export-failed': S.exportError = e.error; break;
    case 'error': S.status = 'error'; S.error = e.message; break;
  }
  render();
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const list = (items) => (items && items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<span class="muted">none</span>');
const seatName = (seat) => seat.label || VENDOR_LABEL[seat.vendor] || seat.vendor;
const seatMeta = (seat) => [seat.endpoint ? 'API' : 'CLI', seat.model, seat.effort].filter(Boolean).join(' · ');

function card(r) {
  const seat = r.seat;
  const flags = [];
  if (r.reprompted) flags.push('<span class="status warn">re-prompted</span>');
  if (r.usedTools) flags.push(`<span class="status ${r.toolFail ? 'danger' : 'warn'}">used tools</span>`);
  if (r.failed) flags.push('<span class="status danger">no reply</span>');
  else if (!r.valid) flags.push('<span class="status warn">off contract</span>');
  let body;
  if (r.failed) {
    const line = r.skipped ? `Skipped: ${VENDOR_LABEL[seat.vendor] || seat.vendor} is out for this debate.` : (ERROR_LINE[r.errorKind] || 'No reply.');
    body = `<p class="fail-line danger">${esc(line)}${r.resetsAt ? ` Resets ${esc(new Date(r.resetsAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}.` : ''}</p><details class="fail-detail"><summary>details</summary><pre>${esc(r.errors.join('\n'))}</pre></details>`;
  }
  else if (r.parsed.pass) body = '<span class="muted">Nothing new to add.</span>';
  else if (!r.valid) body = `<pre>${esc(r.text)}</pre>`;
  else body = `<dl>
      ${r.round > 0 ? `<dt>agrees with</dt><dd>${r.parsed.agreeWith.length ? esc(r.parsed.agreeWith.join(', ')) : '<span class="muted">no one</span>'}</dd>` : ''}
      <dt>disagree</dt><dd>${list(r.parsed.disagree)}</dd>
      <dt>new</dt><dd>${list(r.parsed.new)}</dd>
      <dt>assumes</dt><dd>${list(r.parsed.assumptions)}</dd>
    </dl>${r.question ? `<div class="question"><b>QUESTION FOR YOU</b> ${esc(r.question)}</div>` : ''}`;
  const meta = seatMeta(seat);
  // the dot is the live connection state in the current round, the recorded one in older rounds
  const current = r.round === S.rounds.length - 1;
  const conn = current ? (S.conn[seat.id] || r.state) : (r.state || (r.failed ? 'failed' : 'replied'));
  const position = S.positions[r.round]?.[seat.id] || null;
  return `<article class="card" style="--seat: var(--seat-${esc(seat.colour)})" data-position="${esc(position || 'none')}" title="${esc(position ? POSITION_LABEL[position] : '')}">
    <div class="card-head"><span class="vendor" title="${esc(meta)}">${esc(seatName(seat))}</span><span class="lens">${esc(seat.lens)}</span>${led(conn)}${seat.mood?.preset && seat.mood.preset !== 'grill' ? `<span class="muted">${esc(seat.mood.preset)}</span>` : ''}<span class="flags">${flags.join('')}</span></div>
    ${body}
  </article>`;
}

function pendingCard(seat) {
  return `<article class="card pending" style="--seat: var(--seat-${esc(seat.colour)})"><div class="card-head"><span class="vendor">${esc(seatName(seat))}</span><span class="lens">${esc(seat.lens)}</span>${led(S.conn[seat.id] || 'thinking')}</div></article>`;
}

function renderRound(i, replies, isCurrent) {
  const groups = new Map();
  for (const r of replies) { const k = optionLabel(r.stanceKey || 'other: unparsed', S.fieldNotes?.options); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const pendingSeats = isCurrent ? S.seats.filter((s) => S.pending.has(s.index) && !replies.some((r) => r.seat.index === s.index)) : [];
  const tally = [...groups.entries()].map(([k, v]) => `${k} (${v.length})`).join(' · ') || (pendingSeats.length ? 'in progress' : '');
  const groupHtml = [...groups.entries()].map(([k, v]) => `<section class="group ${v.length > 1 ? 'span' : ''}">
      <div class="group-title"><span>${esc(k)}</span><span class="count">${v.length} seat${v.length > 1 ? 's' : ''}</span></div>
      <div class="cards">${v.map(card).join('')}</div></section>`).join('');
  const pendingHtml = pendingSeats.map((s) => `<section class="group"><div class="group-title"><span class="muted">thinking</span></div><div class="cards">${pendingCard(s)}</div></section>`).join('');
  const note = (S.humanNotes[i] || []).map((n) => `<div class="human-note"><b>You said</b>${esc(n)}</div>`).join('');
  return `<details class="round" ${isCurrent ? 'open' : ''} data-round="${i}">
    <summary><span>${i === 0 ? 'Round 0 · blind' : `Round ${i}`}</span><span class="tally">${esc(tally)}</span></summary>
    <div class="groups">${groupHtml}${pendingHtml}${note}</div>
  </details>`;
}

// The strip: one pool row per vendor account (live windows, measured share per round, usage
// link), its seats beneath it, then the current round and the debate total.
function renderUsage() {
  const u = rollup(S.rows);
  const fmt = (n) => (n || 0).toLocaleString();
  // a sum of reported costs over calls of which some reported none is marked partial
  const cost = (c, x) => (c == null ? '<span class="muted">n/a</span>' : `$${c.toFixed(2)}${x?.costCoverage && x.costCoverage.reported < x.costCoverage.of ? `<span class="seat-meta" title="${x.costCoverage.reported} of ${x.costCoverage.of} calls report a cost">partial</span>` : ''}`);
  const secs = (ms) => `${Math.round((ms || 0) / 1000)}s`;
  // last: the seat's input in the latest round it took part in (cache included), the figure that
  // says whether rounds stay flat (stateless) or grow (resume)
  const row = (name, x, cls = '', last = null, position = null) => `<tr class="${cls}" data-position="${esc(position || 'none')}"><td>${name}</td><td class="data">${fmt(x.input)}</td><td class="data">${fmt(x.cacheRead + x.cacheWrite)}</td><td class="data">${fmt(x.output)}</td><td class="data">${cost(x.cost, x)}</td><td class="data">${secs(x.ms)}</td><td class="data">${last ? `${fmt(last.usage.input + last.usage.cacheRead + last.usage.cacheWrite)}<span class="seat-meta">r${esc(last.round)}</span>` : ''}</td></tr>`;
  const pools = [...new Set([...S.seats.map(seatPool), ...(S.chairman ? [seatPool(S.chairman)] : [])])];
  const rows = [];
  for (const pool of pools) {
    rows.push(`<tr class="pool-row"><td colspan="7">${poolLine(pool)}</td></tr>`);
    const seated = [...S.seats.filter((s) => seatPool(s) === pool), ...(S.chairman && seatPool(S.chairman) === pool ? [S.chairman] : [])];
    for (const seat of seated) {
      const x = u.bySeat[seat.id]?.usage;
      const perRound = u.bySeatRound[seat.id] || {};
      const lastRound = Object.keys(perRound).filter((k2) => k2 !== 'verdict').map(Number).sort((a, b) => b - a)[0];
      const last = lastRound != null ? { round: lastRound, usage: perRound[String(lastRound)] } : null;
      const isChair = seat.id === 'chairman';
      const position = isChair ? null : S.positions[S.rounds.length - 1]?.[seat.id] || null;
      const name = `<span class="seat-dot" style="--seat: var(--seat-${esc(seat.colour)})"></span>${esc(seatName(seat))} · ${esc(seat.lens)}${isChair ? '' : led(S.conn[seat.id] || 'idle')}${seatMeta(seat) ? `<span class="seat-meta">${esc(seatMeta(seat))}</span>` : ''}`;
      const out = S.down[`${seat.vendor}@${seat.account || ''}`];
      rows.push(x ? row(name, x, '', last, position) : `<tr data-position="none"><td>${name}</td><td class="data ${out ? 'danger' : 'muted'}" colspan="6">${out ? `out: ${esc(ERROR_LINE[out.kind] || out.kind)} no tokens charged` : 'no call yet'}</td></tr>`);
    }
  }
  const cur = S.rounds.length ? S.rounds.length - 1 : null;
  if (cur != null && u.byRound[String(cur)]) rows.push(row(`Round ${cur}`, u.byRound[String(cur)], 'muted'));
  rows.push(row('Debate', u.total, 'total'));
  $('usage').querySelector('tbody').innerHTML = rows.join('');
}

// The pool row on the board: name, one readout per live window, then freshness and the usage link.
function poolLine(key) {
  const q = S.quota[key];
  const pl = S.pools[poolVendor(key)];
  const body = q?.windows?.length ? `<div class="readouts">${readouts(key, q.windows)}</div>`
    : pl ? `<div class="readouts"><div class="readout"><div class="readout-fig"><b>${esc(pl.remaining.toLocaleString())}</b><span>${esc(pl.unit)} left</span></div><div class="readout-sub">entered ${agoText(pl.at)}</div></div></div>`
    : '<div class="readouts"><span class="muted">no live figure</span></div>';
  return `<div class="pool-head">${poolId(key)}${body}<div class="pool-meta">${q ? `<span>read ${agoText(q.at)}</span>` : ''}${usageLink(key)}</div></div>`;
}

function untilText(t) {
  const s = Math.max(0, Math.round((t - Date.now()) / 1000));
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
}

function agoText(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

function renderVerdict() {
  const v = S.verdict;
  $('verdict').hidden = !v;
  if (!v) return;
  if (v.skipped) { $('verdict-body').innerHTML = `<p class="wide">${esc(v.text)}</p><div class="verdict-meta">${S.rounds.length} rounds · stopped: ${esc(S.stopReason)} · debates/${esc(S.slug)}/</div>`; return; }
  // the chairman's reply never met the verdict format: show it as diagnostic text, not a verdict
  if (v.failed) { $('verdict-body').innerHTML = `<p class="wide danger">The chairman's reply did not follow the verdict format${v.errors?.length ? `: ${esc(v.errors.join('; '))}` : ''}. Write the verdict again from the bar below.</p><pre class="wide">${esc(v.text)}</pre>`; return; }
  const sections = {};
  let cur = null;
  for (const line of v.text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[*#_-]+\s*)?(RECOMMENDATION|TALLY|DISSENT|KILL_CRITERIA|OPEN_QUESTIONS)\s*[*_]*\s*:?\s*(.*)$/i);
    if (m) { cur = m[1].toUpperCase(); sections[cur] = m[2] ? [m[2]] : []; } else if (cur) sections[cur].push(line);
  }
  const block = (key, title, wide) => {
    const lines = (sections[key] || []).map((l) => l.trim()).filter(Boolean);
    // the grammar line names an option id: show its label
    if (key === 'RECOMMENDATION' && /^opt-\d+\.?$/.test(lines[0] || '')) lines[0] = `${optionLabel(lines[0].replace(/\.$/, ''), S.fieldNotes?.options)}:`;
    if (key === 'RECOMMENDATION' && /^none\.?$/i.test(lines[0] || '')) lines[0] = 'No pick:';
    const isList = lines.length && lines.every((l) => /^[-*•]|^\d+[.)]/.test(l));
    const html = isList ? `<ul>${lines.map((l) => `<li>${esc(l.replace(/^[-*•]\s*|^\d+[.)]\s*/, ''))}</li>`).join('')}</ul>` : `<p>${esc(lines.join(' '))}</p>`;
    return `<div class="section ${wide ? 'wide' : ''}"><span class="label">${title}</span>${lines.length ? html : '<span class="muted">not given</span>'}</div>`;
  };
  const parsed = Object.keys(sections).length > 0;
  // the tally, counted from the seats' final stances (only PASS carries an earlier one), as the
  // decision record counts it; a verdict from before 0.3.1 may still carry the chairman's own
  const finals = {};
  for (const seat of S.seats) {
    let k = null;
    for (let i = S.rounds.length - 1; i >= 0; i--) {
      const r = S.rounds[i]?.find((x) => x.seat.id === seat.id);
      if (!r) continue;
      if (r.failed || !r.valid) break;
      if (r.stanceKey !== 'PASS') { k = r.stanceKey; break; }
    }
    const label = k ? optionLabel(k, S.fieldNotes?.options) : 'no eligible stance';
    (finals[label] ??= []).push(seat.lens);
  }
  if (!sections.TALLY) sections.TALLY = Object.entries(finals).map(([label, lenses]) => `- ${label}: ${lenses.join(', ')}`);
  $('verdict-body').innerHTML = parsed
    ? `${block('RECOMMENDATION', 'Recommendation', true)}${block('TALLY', 'Tally')}${block('DISSENT', 'Dissent')}${block('KILL_CRITERIA', 'Kill criteria')}${block('OPEN_QUESTIONS', 'Open questions')}
       <div class="verdict-meta">chairman ${esc(VENDOR_LABEL[v.seat.vendor] || v.seat.vendor)}${seatMeta(v.seat) ? ` (${esc(seatMeta(v.seat))})` : ''} · ${S.rounds.length} rounds · stopped: ${esc(S.stopReason)} · debates/${esc(S.slug)}/verdict.md</div>`
    : `<pre class="wide">${esc(v.text)}</pre>`;
}

function renderGate() {
  const g = S.gate;
  const st = $('gate-status');
  const interrupted = S.status === 'interrupted';
  $('continue').disabled = !g && !interrupted; $('stop').disabled = S.status === 'done' || interrupted;
  $('human-form').hidden = S.status === 'done'; // a finished debate takes no note; its bar keeps the status
  $('continue').textContent = interrupted ? 'Resume' : 'Continue';
  const link = (S.connected === false ? '<span class="status danger">reconnecting</span> ' : '') + budgetLine();
  if (!g) {
    // a verdict skipped, failed or never written: write it, with this chairman or another vendor
    // (the first one out of quota or logged out is not offered first)
    const chairDown = S.verdict?.seat && S.down[`${S.verdict.seat.vendor}@${S.verdict.seat.account || ''}`];
    // the CLI vendors by name; an endpoint only as a seat already at this table (its URL, key
    // variable and model are the seat's), since the endpoint vendor alone names no server
    const pickable = Object.keys(VENDOR_LABEL).filter((v) => !isApi(v) && !Object.values(S.down).some((x) => x.vendor === v && !x.account));
    const apiSeats = S.seats.filter((s) => s.endpoint && !S.down[`${s.vendor}@${s.account || ''}`]).map((s) => ({ value: `seat:${s.id}`, label: `${s.label} (${s.model})` }));
    const first = chairDown || ['quota', 'auth', 'missing'].includes(S.verdict?.errorKind) ? pickable.find((v) => v !== S.verdict?.seat?.vendor) || pickable[0] : (S.chairman?.vendor || pickable[0]);
    const synth = S.status === 'done' && S.synthesis && S.synthesis !== 'done' && S.rounds.length
      ? ` <span class="synth">Write the verdict with <select id="synth-chair" aria-label="Chairman for the verdict">${pickable.map((v) => `<option value="${v}" ${v === first ? 'selected' : ''}>${esc(VENDOR_LABEL[v])}</option>`).join('')}${apiSeats.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select> <button class="btn btn-small" id="synthesize" type="button">Write</button></span>` : '';
    st.innerHTML = link + (S.status === 'done' ? `<span class="status ok">done</span>${synth} stopped: ${esc(S.stopReason)}. Field notes and verdict are in debates/${esc(S.slug)}/.${S.exported ? ` Decision record written to ${esc(S.exported.path)}.` : ''}${S.exportError ? ` <span class="danger">Export failed: ${esc(S.exportError)}</span>` : ''}${S.replayed ? ' <span class="muted">replayed from the transcript, read-only</span>' : ''}`
      : interrupted ? `<span class="status warn">interrupted</span> ${S.interrupted?.round ? `after round ${S.interrupted.round - 1}` : 'before round 0 finished'}${S.interrupted?.partialRound != null ? `, round ${S.interrupted.partialRound} will be re-run` : ''}. Add a note or resume.`
      : S.status === 'idle' ? '<span class="status warn">loading</span> waiting for the transcript'
      : S.status === 'verdict' ? '<span class="status warn">chairman writing the verdict</span>'
      : S.status === 'error' ? `<span class="status danger">error</span> ${esc(S.error)}`
      : S.stopQueued ? '<span class="status warn">stop queued</span> the seats still thinking were cut off; the round closes, then the chairman writes the verdict'
      : `<span class="status warn">round ${S.rounds.length - 1} in flight</span> ${S.pending.size} seat${S.pending.size === 1 ? '' : 's'} still thinking`);
    return;
  }
  const parts = [];
  if (g.reason === 'round0') parts.push(`<span class="status warn">waiting for you</span> ${S.seats.length} blind positions are on the table. Add a note or continue.`);
  if (g.reason === 'question') parts.push(`<span class="status warn">question</span> ${g.questions.map((q) => `<b>${esc(q.lens)}</b>: ${esc(q.question)}`).join(' · ')}`);
  if (g.stop) parts.push(`<span class="status ok">${esc(g.stop)}</span> ${g.reopenable ? 'Continue goes straight to the verdict; a note runs one more round.' : 'Continue goes straight to the verdict.'}`);
  if (g.mode === 'countdown') {
    if (S.held) parts.push('<span class="status muted">countdown held</span> waiting for you');
    else if (S.deadline) parts.push(`<span class="countdown">auto-continue in <span id="cd">${Math.max(0, Math.ceil((S.deadline - Date.now()) / 1000))}</span> s</span>`);
  }
  st.innerHTML = link + parts.join(' ');
}

// Which vendor would cross its cap, and by how much: shown wherever the gate status is.
function budgetLine() {
  const b = S.budgetStop; if (!b) return '';
  const name = esc(VENDOR_LABEL[b.vendor] || b.vendor);
  if (b.kind === 'usd-unknown') return `<span class="status danger">budget</span> ${name} has a dollar cap, but its cost is not reported, so the ${esc(b.what)} was not run. `;
  const unit = b.kind === 'usd' ? (n) => `$${(n || 0).toFixed(2)}` : (n) => `${k(n || 0)} tokens`;
  const figures = `${esc(unit(b.spent))} spent plus about ${esc(unit(b.projected))} projected, cap ${esc(unit(b.cap))}`;
  // a refused re-prompt fails one seat for one round; the debate goes on
  if (/^re-prompt/.test(b.what)) return `<span class="status warn">budget</span> the ${esc(b.what)} was not made (${name}: ${figures}); the debate goes on. `;
  return `<span class="status danger">budget</span> ${name} would cross its cap at the ${esc(b.what)}: ${figures}. `;
}

// Above the board: a login that is out for this debate (quota, login, missing CLI), and a lost
// connection to the server. Each says what happened and what happens next.
function renderBanners() {
  const items = Object.values(S.down).map((x) => `<div class="banner danger"><span class="status danger">${esc(VENDOR_LABEL[x.vendor] || x.vendor)}${x.account ? ` (${esc(x.account)})` : ''} out</span> ${esc(x.message)} Its seats are skipped for the rest of this debate${S.verdict || S.status === 'done' ? '' : '; continue without them or stop'}.</div>`);
  if (S.chairmanFallback) items.push(`<div class="banner warn"><span class="status warn">chairman</span> ${esc(VENDOR_LABEL[S.chairmanFallback.from.vendor] || S.chairmanFallback.from.vendor)} could not write the verdict (${esc(S.chairmanFallback.reason)}), so ${esc(VENDOR_LABEL[S.chairmanFallback.to] || S.chairmanFallback.to)} wrote it at its default model.</div>`);
  if (S.connected === false && S.status !== 'done') items.unshift('<div class="banner warn"><span class="status warn">reconnecting</span> Lost the connection to the roundtable server. The debate keeps running there; this board catches up when it is back.</div>');
  $('banners').innerHTML = items.join('');
}

function render() {
  $('rounds').innerHTML = S.rounds.map((r, i) => renderRound(i, r, i === S.rounds.length - 1)).join('');
  renderUsage(); renderVerdict(); renderGate(); renderAccept(); renderBanners();
  $('sys').className = `status ${S.status === 'error' ? 'danger' : S.status === 'waiting' ? 'warn' : 'ok'}`;
  $('sys').textContent = S.status;
  $('st-round').textContent = S.rounds.length ? `round ${S.rounds.length - 1}` : '';
  $('st-seats').textContent = S.seats.length ? `${S.seats.length} seats` : '';
}

function tick() {
  if (S.startedAt && S.status !== 'done') $('st-elapsed').textContent = `${Math.floor((Date.now() - S.startedAt) / 60000)}m ${Math.floor(((Date.now() - S.startedAt) / 1000) % 60)}s`;
  const cd = $('cd');
  if (cd && S.deadline) cd.textContent = Math.max(0, Math.ceil((S.deadline - Date.now()) / 1000));
  if (Date.now() % 30000 < 1000) renderUsage(); // keep "read Nm ago" and reset countdowns honest
}

// ---------- human bar ----------
const post = (what, body = {}) => fetch(`/api/debates/${S.slug}/${what}`, { method: 'POST', headers: SEND, body: JSON.stringify(body) });
function hold() { if (S.gate && S.deadline && !S.held) { S.held = true; S.deadline = null; post('hold'); render(); } }
document.addEventListener('click', hold, true);
document.addEventListener('keydown', hold, true);

$('human-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const message = $('human-msg').value.trim();
  $('human-msg').value = '';
  if (S.status === 'interrupted') post('resume', { message });
  else if (/^\/stop\b/i.test(message)) post('stop', { message }); else post('continue', { message });
});
$('stop').addEventListener('click', () => { const message = $('human-msg').value.trim(); $('human-msg').value = ''; post('stop', { message }); });

// ---------- export ----------
try { $('export-target').value = localStorage.getItem('roundtable.exportTarget') || ''; } catch {}
// A verdict skipped (budget, wall clock), failed or never written: run the chairman alone.
$('gate-status').addEventListener('click', async (ev) => {
  if (ev.target.id !== 'synthesize') return;
  ev.target.disabled = true;
  const pick = $('synth-chair').value;
  const seat = pick.startsWith('seat:') && S.seats.find((s) => s.id === pick.slice(5));
  const chairman = seat ? { vendor: seat.vendor, endpoint: seat.endpoint, keyEnv: seat.keyEnv || undefined, model: seat.model } : { vendor: pick };
  const res = await post('synthesize', { chairman });
  if (!res.ok) { ev.target.disabled = false; ev.target.textContent = (await res.json()).error; }
});

// The human's decision: the recommended option preselected, any option or none allowed.
function renderAccept() {
  const opts = S.fieldNotes?.options || [];
  const sel = $('accept-option');
  const rec = /^\s*(opt-\d+)/.exec(S.verdict?.text?.split('RECOMMENDATION:')[1] || '')?.[1];
  const want = S.accepted?.option || rec || '';
  const html = [...opts.map((o, i) => `<option value="opt-${i + 1}">${esc(o)}</option>`), '<option value="none">none of these</option>'].join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; delete sel.dataset.applied; }
  // follow the recommendation, then the acceptance, as they arrive (a replay sends them late);
  // never overwrite what the human is choosing
  if (want && sel.dataset.applied !== want && document.activeElement !== sel) { sel.value = want; sel.dataset.applied = want; }
  $('accept-form').hidden = S.status !== 'done'; // a finished debate, live or replayed, can be accepted
  $('accept-status').textContent = S.accepted ? `accepted: ${S.accepted.option === 'none' ? 'none of these' : optionLabel(S.accepted.option, opts)}` : 'not yet accepted';
}
$('accept-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const res = await post('accept', { option: $('accept-option').value, note: $('accept-note').value.trim() });
  if (!res.ok) $('accept-status').textContent = (await res.json()).error;
});

$('export-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const target = $('export-target').value.trim();
  try { localStorage.setItem('roundtable.exportTarget', target); } catch {}
  $('export-status').textContent = 'writing…';
  const res = await post('export', { target });
  const out = await res.json();
  $('export-status').textContent = res.ok ? `written: ${out.path} (${out.status}: ${out.chosen})` : `failed: ${out.error}`;
  if (res.ok) { S.exported = out; S.exportError = null; renderGate(); }
});

// ---------- theme ----------
$('theme').addEventListener('click', () => {
  const night = document.documentElement.dataset.theme !== 'night';
  document.documentElement.dataset.theme = night ? 'night' : 'paper';
  $('theme').textContent = night ? 'Paper' : 'Night';
  try { localStorage.setItem('roundtable.theme', night ? 'night' : 'paper'); } catch {}
});
try { if (localStorage.getItem('roundtable.theme') === 'night') { document.documentElement.dataset.theme = 'night'; $('theme').textContent = 'Paper'; } } catch {}

// ---------- boot ----------
await setup();
$('recent-list').addEventListener('click', (ev) => { if (ev.target.id === 'debates-more') { S.showAllDebates = !S.showAllDebates; loadRecent(); } });
window.addEventListener('hashchange', route);
route();
