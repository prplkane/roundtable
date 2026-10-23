// One static page plus SSE on localhost. The server owns the live debate, the gate and the
// auto-continue timer; the browser only renders events and posts the human's answers.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters, ADAPTERS, quotaReaders, poolsByAccount } from './adapters/index.js';
import { profileHome, killAll, liveChildren, resolveBinary, runProcess, cleanEnv } from './adapters/spawn.js';
import { checkPool, STATUS, endpointLamp } from './preflight.js';
import { retired } from './adapters/models.js';
import { vendorCatalogue } from './adapters/catalogue.js';
import { createDebate, DEFAULTS } from './engine.js';
import { normaliseSeats, normaliseChairman, MOODS, COLOURS, poolKey, poolVendor, poolAccount } from './seats.js';
import { slugFor, openDebateDir, readAllTranscripts, rebuildDebate, normaliseRows } from './store.js';
import { exportDebate, validateTarget, decisionRecord } from './export.js';
import { rollup } from './engine.js';
import { baselinesFrom, windowDeltas, updateCalibration, migrateCalibration, CALIBRATION_VERSION } from './estimate.js';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fakeRunner, fakeQuota } from './fake.js';
import { validateDebateRequest, validateMessage, validateAccept, BODY_LIMIT } from './validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'src', 'ui');
const FAKE_CONSENSUS = process.argv.includes('--fake-consensus'); // scripted seats that all agree
const FAKE = process.argv.includes('--fake') || FAKE_CONSENSUS;
// ROUNDTABLE_DEBATES_DIR: where transcripts, calibration and pools live (tests point it at a
// temporary folder so nothing they run teaches the real projection). Scripted seats default to
// their own folder, so a fake debate never sits next to real ones.
const DEBATES_DIR = process.env.ROUNDTABLE_DEBATES_DIR ? path.resolve(process.env.ROUNDTABLE_DEBATES_DIR) : path.join(ROOT, FAKE ? 'debates-fake' : 'debates');
const PORT = Number(process.env.PORT) || (FAKE ? 4748 : 4747);
// Per-launch capability: every request that changes something carries it. The page gets it in a
// meta tag when it is served; scripts take it from the startup line (ROUNDTABLE_TOKEN).
const TOKEN = randomBytes(16).toString('hex');
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const debates = new Map(); // slug -> live debate record

// Model ids and effort levels per vendor. `agy models` is a network call, so it is read once in
// the background at boot; the setup screen gets the static hints until it lands.
let catalogue = null;
const catalogueReady = (FAKE ? vendorCatalogue({ agyModels: async () => [] }) : vendorCatalogue())
  .then((c) => { catalogue = c; return c; })
  .catch((e) => { console.error('[catalogue]', e.message); return vendorCatalogue({ agyModels: async () => [] }).then((c) => (catalogue = c)); });
const effortsByVendor = () => Object.fromEntries(Object.entries(catalogue || {}).map(([v, c]) => [v, c.efforts]));

// The quota picture. Baselines: tokens per call per vendor from every transcript on disk.
// Calibration: how much of each vendor window one round took, measured between the quota
// snapshot at one round's start and the next; persisted so the next debate projects from it.
const baselines = baselinesFrom(readAllTranscripts(DEBATES_DIR, { excludeSynthetic: true }));
// The fake board must never teach the real projection: it measures into its own file.
const CALIB_FILE = path.join(DEBATES_DIR, FAKE ? '_calibration.fake.json' : '_calibration.json');
let calibration = {};
const saveCalibration = () => { try { writeFileSync(CALIB_FILE, JSON.stringify({ _version: CALIBRATION_VERSION, ...calibration }, null, 2)); } catch (e) { console.warn('[calibration]', e.message); } };
try {
  const m = migrateCalibration(JSON.parse(readFileSync(CALIB_FILE, 'utf8')), { subsetVendors: Object.keys(ADAPTERS).filter((v) => ADAPTERS[v].cacheSemantics === 'subset') });
  calibration = m.calibration;
  if (m.dropped.length) { console.log(`[calibration] dropped ${m.dropped.join(', ')}: measured before cached input was counted once`); saveCalibration(); }
} catch { /* none yet */ }
const snapshotQuota = () => JSON.parse(JSON.stringify(quota));

// A remaining-pool figure the user types in for a vendor whose CLI reports nothing (agy: the
// "AI credits" page is browser-only). Kept with its time so the strip can say how old it is, and
// decremented on the board by each debate's weighted tokens at the user's own rate when given.
const POOLS_FILE = path.join(DEBATES_DIR, FAKE ? '_pools.fake.json' : '_pools.json');
let pools = {};
try { pools = JSON.parse(readFileSync(POOLS_FILE, 'utf8')); } catch { /* none yet */ }
function setPool(vendor, body) {
  const remaining = Number(body.remaining);
  if (!ADAPTERS[vendor]) throw new Error('Unknown vendor.');
  if (!Number.isFinite(remaining) || remaining < 0) throw new Error('Remaining must be a finite number of 0 or more.');
  const perToken = body.perToken == null || body.perToken === '' ? null : Number(body.perToken);
  if (perToken != null && !(Number.isFinite(perToken) && perToken >= 0)) throw new Error('Units per token must be a finite number of 0 or more.');
  pools[vendor] = { remaining, unit: String(body.unit || 'credits').slice(0, 24), perToken, note: String(body.note || '').slice(0, 120), at: Date.now() };
  try { writeFileSync(POOLS_FILE, JSON.stringify(pools, null, 2)); } catch (e) { console.warn('[pools]', e.message); }
  for (const d of debates.values()) push(d, { type: 'pool', vendor, pool: pools[vendor] });
  return pools[vendor];
}

// Round r of debate d is over (the next round started, or the debate stopped): compare the
// vendor windows now with those at the round's start, against the tokens that round spent.
function settleRound(d, r) {
  if (r < 0 || !d.qAtRound[r] || d.settled.has(r)) return;
  d.settled.add(r);
  const prev = d.qAtRound[r], next = snapshotQuota();
  // Tokens per vendor, and per vendor:model when every seat of that vendor in the round ran one
  // model (a window delta cannot be split between two models in the same round).
  // keyed by pool (seats.poolKey): two profiles of one vendor draw from two windows
  const tokens = {}, models = {};
  for (const e of d.events) {
    if (e.type !== 'attempt' || e.round !== r || !e.usage || e.kind === 'verdict') continue;
    const pool = keyOf(e.seat.vendor, e.seat.account);
    const t = (e.usage.input || 0) + (e.usage.cacheRead || 0) + (e.usage.cacheWrite || 0) + (e.usage.output || 0);
    tokens[pool] = (tokens[pool] || 0) + t;
    (models[pool] ??= new Set()).add(e.seat.model || 'default');
  }
  let changed = false;
  for (const [pool, t] of Object.entries(tokens)) {
    const deltas = windowDeltas(prev[pool], next[pool]);
    if (!deltas.length) continue;
    calibration = updateCalibration(calibration, pool, deltas, t);
    const keys = [pool];
    if (models[pool].size === 1) { const key = `${pool}:${[...models[pool]][0]}`; calibration = updateCalibration(calibration, key, deltas, t); keys.push(key); }
    changed = true;
    for (const key of keys) for (const x of debates.values()) push(x, { type: 'calibration', vendor: pool, key, windows: calibration[key], round: r, tokens: t, deltas });
  }
  if (changed) saveCalibration();
}

// At the end of a debate the app-server vendors (codex) have usually not been re-read since
// their last reply, so the last round is settled only after one fresh read of each such vendor.
async function settleLast(d, r) {
  const pools = new Set(d.events.filter((e) => e.type === 'reply' && e.round === r).map((e) => keyOf(e.seat.vendor, e.seat.account)));
  await Promise.all([...pools].map((k) => refreshQuota(k)));
  settleRound(d, r);
}

function watchRounds(d, payload) {
  if (payload.type === 'round-start') { settleRound(d, payload.round - 1); d.qAtRound[payload.round] = snapshotQuota(); }
  if (payload.type === 'stopped') settleLast(d, payload.rounds - 1).catch((e) => console.warn('[calibration]', e.message));
}

// Every event carries an id (generation:index) so a board that reconnects sends Last-Event-ID
// and gets only what it missed. A record rebuilt from disk after a restart has a new generation,
// so such a board gets the whole list again and resets on its `started` event.
function sseLine(d, i) { return `id: ${d.gen}:${i}\ndata: ${JSON.stringify(d.events[i])}\n\n`; }
function push(d, event) {
  d.events.push(event);
  const line = sseLine(d, d.events.length - 1);
  for (const res of d.clients) res.write(line);
}
function replayFrom(d, lastEventId) {
  const m = /^(\d+):(\d+)$/.exec(lastEventId || '');
  return m && Number(m[1]) === d.gen ? Number(m[2]) + 1 : 0;
}

// A slug the server does not hold in memory (after a restart): rebuild the record from its
// transcript. Finished debates replay read-only; an unfinished one is marked interrupted and
// can be resumed through POST .../resume.
function loadDebate(slug) {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const store = openDebateDir(DEBATES_DIR, slug, { create: false });
  if (!store) return null;
  const rebuilt = rebuildDebate(store.readTranscript());
  if (!rebuilt) return null;
  const d = { slug, gen: Date.now(), events: [...rebuilt.events], clients: new Set(), pending: null, timer: null, stopQueued: false, store, qAtRound: {}, settled: new Set(), rebuilt, interrupted: !rebuilt.finished, finished: rebuilt.finished };
  for (const [vendor, q] of Object.entries(quota)) push(d, { type: 'quota', vendor, quota: q });
  for (const [key, windows] of Object.entries(calibration)) push(d, { type: 'calibration', vendor: key.split(':')[0], key, windows });
  for (const [vendor, pool] of Object.entries(pools)) push(d, { type: 'pool', vendor, pool });
  debates.set(slug, d);
  console.log(`[${slug}] loaded from disk: ${rebuilt.finished ? 'finished' : `interrupted after round ${rebuilt.nextRound - 1}`}`);
  return d;
}

// Continue an interrupted debate: the engine is recreated from the field-notes row (seats with
// their recorded session ids, used when memory is 'resume') and runs from the first incomplete
// round. An optional message becomes the human's note on the last complete round.
function resumeDebate(d, body = {}) {
  if (!d.interrupted) throw new Error(d.finished ? 'This debate is finished.' : 'This debate is running.');
  const rb = d.rebuilt;
  const message = String(body.message || '').trim();
  if (message && rb.nextRound > 0) { (rb.humanNotes[rb.nextRound - 1] ??= []).push(message); d.store.append({ type: 'human', round: rb.nextRound - 1, text: message }); push(d, { type: 'human', round: rb.nextRound - 1, text: message }); }
  d.interrupted = false;
  attachEngine(d, { fieldNotes: rb.fieldNotes, seats: rb.seats, chairman: rb.chairman, options: { ...DEFAULTS, ...(rb.options || {}) }, resume: { rounds: rb.rounds, humanNotes: rb.humanNotes, ledger: rb.ledger, deadlineAt: rb.deadlineAt } });
  console.log(`[${d.slug}] resumed from round ${rb.nextRound}`);
}

// The human's decision, kept apart from the chairman's recommendation: an `accepted` row, and
// the record re-exported where the field notes asked for one.
function acceptDecision(d, body) {
  if (!d.finished) throw new Error('Accept after the debate has finished.');
  const rb = rebuildDebate(d.store.readTranscript());
  const { option, note } = validateAccept(body, rb.fieldNotes.options);
  const row = { type: 'accepted', option, note, t: new Date().toISOString() };
  d.store.append(row);
  push(d, row);
  if (rb.fieldNotes.exportTo) autoExport(d, rb.fieldNotes.exportTo);
  return { ok: true, option };
}

// Pre-flight for the seat lamps: per pool key, the binary, the CLI's own login status and the
// quota, with no model call. Cached a minute per pool (a quota read spawns the codex app-server).
const preflightCache = new Map(); // key -> { at, result }
async function loginStatus(vendor, account) {
  if (FAKE) return true;
  const s = STATUS[vendor];
  if (!s) return (catalogue || await catalogueReady)?.[vendor]?.models?.length ? true : null; // agy: its model list answered
  const home = account && ADAPTERS[vendor].home ? { env: ADAPTERS[vendor].home.env, dir: profileHome(vendor, account) } : null;
  try {
    const r = await runProcess(resolveBinary(ADAPTERS[vendor].binary, ADAPTERS[vendor].npmBin), s.args, { env: cleanEnv(home), timeoutMs: 20_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    return s.plan ? { loggedIn: s.read(out), plan: s.plan(out) } : s.read(out);
  } catch { return null; }
}
// endpoints: { [key]: { url, keyEnv } } for API pools, from the board (POST only: it names a
// variable of this process, so the launch token is required). No request leaves this server
// for an endpoint pool (preflight.js endpointLamp).
async function preflight(keys, fresh = false, endpoints = {}) {
  return Promise.all(keys.map(async (key) => {
    const vendor = poolVendor(key), account = poolAccount(key);
    if (!ADAPTERS[vendor]) return { key, state: 'danger', kind: 'missing', note: `unknown vendor ${vendor}` };
    if (ADAPTERS[vendor].kind === 'api') {
      const ep = endpoints[key] || {};
      const url = typeof ep.url === 'string' ? ep.url.slice(0, 500) : '', keyEnv = typeof ep.keyEnv === 'string' ? ep.keyEnv.slice(0, 64) : null;
      return { key, vendor, account, installed: true, loggedIn: null, plan: null, quota: null, ...endpointLamp({ url, keyEnv: keyEnv || null, keySet: !!(keyEnv && process.env[keyEnv]) }) };
    }
    const hit = preflightCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.result;
    const result = await checkPool({ vendor, account, key }, {
      resolve: (v) => (FAKE ? true : resolveBinary(ADAPTERS[v].binary, ADAPTERS[v].npmBin)),
      status: loginStatus,
      quota: async (k) => { if (readers[vendor]) await refreshQuota(k); return quota[k] || null; },
    });
    preflightCache.set(key, { at: Date.now(), result });
    return result;
  }));
}

// The debates on disk, newest first, summarised for the setup screen's list: the same status and
// pick the decision record would carry, plus whether this server is running it now.
function listDebates(limit = 50) {
  let dirs = [];
  try { dirs = readdirSync(DEBATES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[a-z0-9-]+$/.test(e.name)).map((e) => e.name); } catch { return []; }
  const withTime = dirs.map((slug) => { const f = path.join(DEBATES_DIR, slug, 'transcript.jsonl'); return existsSync(f) ? { slug, f, t: statSync(f).mtimeMs } : null; }).filter(Boolean);
  withTime.sort((a, b) => b.t - a.t);
  const out = [];
  for (const { slug, t } of withTime.slice(0, limit)) {
    try {
      const rows = openDebateDir(DEBATES_DIR, slug, { create: false }).readTranscript();
      const rb = rebuildDebate(rows);
      if (!rb) continue;
      const { meta } = decisionRecord(rows, slug);
      const live = debates.get(slug);
      const state = live && !live.finished && !live.interrupted ? 'running' : rb.finished ? 'finished' : 'interrupted';
      const u = rollup(normaliseRows(rows)).total;
      out.push({ slug, decision: rb.fieldNotes.decision, date: slug.slice(0, 10), updated: t, state, status: state === 'finished' ? meta.status : state,
        chosen: meta.chosen, recommended: meta.recommended, accepted: meta.accepted, seats: rb.seats.length, rounds: rb.rounds.length,
        tokens: u.input + u.cacheRead + u.cacheWrite + u.output, cost: u.cost, costPartial: !!(u.costCoverage && u.costCoverage.reported < u.costCoverage.of) });
    } catch (e) { console.warn(`[list] ${slug}: ${e.message}`); }
  }
  return out;
}

// A finished debate whose verdict was skipped, failed or never written: run the chairman alone,
// from the transcript (so it works after a restart), under the budget. The new verdict row
// supersedes the old one.
// body.chairman (optional): write it with another vendor, for example when the first chairman's
// quota ran out. Checked like the setup screen's chairman.
function synthesizeDebate(d, body = {}) {
  if (!d.finished) throw new Error(d.interrupted ? 'This debate was interrupted; resume it first.' : 'This debate is still running.');
  if (d.synthesizing) throw new Error('The verdict is being written.');
  const rb = rebuildDebate(d.store.readTranscript());
  if (rb.synthesis === 'done') throw new Error('This debate already has its verdict.');
  if (!rb.rounds.length) throw new Error('No round ran, so there is nothing to give a verdict on.');
  let chairman = rb.chairman;
  if (body.chairman) {
    for (const k of ['vendor', 'model', 'effort', 'account', 'keyEnv', 'endpoint']) if (body.chairman[k] != null && (typeof body.chairman[k] !== 'string' || body.chairman[k].length > (k === 'endpoint' ? 500 : 200))) throw new Error(`chairman ${k}: text of at most ${k === 'endpoint' ? 500 : 200} characters`);
    chairman = normaliseChairman(body.chairman, { vendors: ADAPTERS, efforts: effortsByVendor() });
    if (!chairman) throw new Error('chairman vendor: one of ' + Object.keys(ADAPTERS).join(', '));
  }
  d.synthesizing = true;
  attachEngine(d, { fieldNotes: rb.fieldNotes, seats: rb.seats, chairman, options: { ...DEFAULTS, ...(rb.options || {}) }, synthesisOnly: true,
    resume: { rounds: rb.rounds, humanNotes: rb.humanNotes, ledger: rb.ledger, stopReason: rb.stopReason } });
  console.log(`[${d.slug}] writing the verdict`);
}

// Remaining quota is per account, not per debate: one snapshot per pool key (`codex`, or
// `codex@work` for a named profile; seats.poolKey), shared by every board. claude's arrives with
// each reply; codex is read separately (readers); agy has none.
const quota = {}; // pool key -> { windows, plan, at }
const readers = FAKE ? { codex: async () => fakeQuota('codex') } : quotaReaders;
const keyOf = (vendor, account) => poolKey(vendor, account, poolsByAccount(ADAPTERS[vendor]));

function setQuota(key, q) {
  if (!q) return;
  quota[key] = q;
  for (const d of debates.values()) push(d, { type: 'quota', vendor: key, quota: q });
}

// One read per pool at a time: a read asked for while one is running shares its result.
const reading = new Map();
function refreshQuota(key) {
  const vendor = poolVendor(key), account = poolAccount(key);
  if (!readers[vendor]) return Promise.resolve();
  if (reading.has(key)) return reading.get(key);
  // readCodexQuota resolves null on every failure (timeout, spawn error, no result) rather than
  // throwing, so say so here or a dead read is invisible on the console.
  const p = (async () => {
    try {
      const q = await readers[vendor]({ home: account ? profileHome(vendor, account) : null });
      if (!q) console.warn(`[quota] ${key}: no figure (read failed or timed out); the strip keeps the last one`);
      setQuota(key, q);
    } catch (e) { console.error(`[quota] ${key}: ${e.message}`); } finally { reading.delete(key); }
  })();
  reading.set(key, p);
  return p;
}

function answerGate(d, answer) {
  if (!d.pending) return false;
  clearTimeout(d.timer); d.timer = null;
  const { resolve } = d.pending;
  d.pending = null;
  push(d, { type: 'gate-closed', action: answer.action });
  resolve(answer);
  return true;
}

function startDebate(raw) {
  const body = validateDebateRequest(raw, { adapters: ADAPTERS });
  const fieldNotes = body.fieldNotes;
  if (fieldNotes.exportTo) fieldNotes.exportTo = validateTarget(fieldNotes.exportTo, { forbid: [DEBATES_DIR] }); // checked up front, not when the verdict lands
  const seats = normaliseSeats(body.seats, { vendors: ADAPTERS, efforts: effortsByVendor() });
  // a retired model fails its first call: refuse it here, with what to use instead
  for (const s of [...seats, ...(body.chairman ? [body.chairman] : [])]) {
    const r = s?.model && retired(s.vendor, String(s.model).trim());
    if (r) throw new Error(`${ADAPTERS[s.vendor].label} retired ${s.model} (${r.date}); use ${r.instead}.`);
  }
  const chairman = normaliseChairman(body.chairman, { vendors: ADAPTERS, efforts: effortsByVendor() });
  const slug = slugFor(fieldNotes.decision, DEBATES_DIR);
  const store = openDebateDir(DEBATES_DIR, slug);
  const options = { ...DEFAULTS, ...body.options };
  const d = { slug, gen: Date.now(), events: [], clients: new Set(), pending: null, timer: null, stopQueued: false, store, qAtRound: {}, settled: new Set(), interrupted: false, finished: false };
  debates.set(slug, d);
  for (const [vendor, q] of Object.entries(quota)) push(d, { type: 'quota', vendor, quota: q }); // replayed to late boards
  for (const [key, windows] of Object.entries(calibration)) push(d, { type: 'calibration', vendor: key.split(':')[0], key, windows });
  for (const [vendor, pool] of Object.entries(pools)) push(d, { type: 'pool', vendor, pool });
  // a named profile's pool has not been read yet: read it before round 0 is measured
  for (const k of new Set([...seats, ...(chairman ? [chairman] : [])].map((s) => keyOf(s.vendor, s.account)))) if (!quota[k]) refreshQuota(k);
  attachEngine(d, { fieldNotes, seats, chairman, options });
  console.log(`[${slug}] started: ${seats.map((s) => `${s.label}/${s.lens}${s.model ? `/${s.model}` : ''}${s.effort ? `/${s.effort}` : ''}${s.account ? `@${s.account}` : ''}`).join(', ')}`);
  return slug;
}

// Write the decision record into a codebase: on request from the board or the script, or the
// moment the verdict lands when the field notes name an "Export to" directory.
function exportRecord(d, target) {
  const abs = validateTarget(target, { forbid: [DEBATES_DIR] });
  const out = exportDebate(d.store.readTranscript(), d.slug, abs, { forbid: [DEBATES_DIR] });
  push(d, { type: 'exported', path: out.path, indexPath: out.indexPath, status: out.meta.status, chosen: out.meta.chosen });
  console.log(`[${d.slug}] exported to ${out.path}`);
  return out;
}
function autoExport(d, target) {
  if (!target) return;
  try { exportRecord(d, target); } catch (e) { push(d, { type: 'export-failed', error: e.message }); console.warn(`[${d.slug}] export: ${e.message}`); }
}

// Build the runner and the gate for a record and run the engine on it (a new debate, or an
// interrupted one continued from its transcript).
function attachEngine(d, { fieldNotes, seats, chairman, options, resume = null, synthesisOnly = false }) {
  const store = d.store;
  // A seat with a named account profile runs with that profile's CLI state directory (under the
  // OS user-data dir, logged in by the user); every other seat shares the CLI's real one.
  const call = FAKE ? fakeRunner({ consensus: FAKE_CONSENSUS }) : (vendor, prompt, sessionId, opts) =>
    adapters[vendor](prompt, sessionId, {
      cwd: store.seatDir(opts.seat?.id || 'chairman'), home: opts.seat?.account && ADAPTERS[vendor].home ? profileHome(vendor, opts.seat.account) : null,
      endpoint: opts.seat?.endpoint ? { url: opts.seat.endpoint, keyEnv: opts.seat.keyEnv || null } : null, // an API seat: where to send the round
      timeoutMs: opts.timeoutMs, model: opts.model || undefined, effort: opts.effort || undefined, tag: d.slug,
    });
  // Every reply either carries the vendor's quota or triggers a separate read (not awaited).
  const runner = async (vendor, ...rest) => {
    const r = await call(vendor, ...rest);
    const key = keyOf(vendor, rest[2]?.seat?.account);
    if (r.quota) setQuota(key, r.quota); else refreshQuota(key);
    return r;
  };

  const gate = (info) => new Promise((resolve) => {
    d.pending = { resolve, info };
    if (d.stopQueued) { d.stopQueued = false; answerGate(d, { action: 'stop' }); return; }
    if (info.mode === 'countdown') {
      const deadline = Date.now() + info.autoContinueMs;
      push(d, { type: 'countdown', deadline });
      d.timer = setTimeout(() => answerGate(d, { action: 'continue' }), info.autoContinueMs);
    }
  });

  d.debate = createDebate({
    fieldNotes, seats, chairman, options, runner, gate, store, resume, baselines, provenance: FAKE ? { fake: true } : {}, synthesisOnly,
    cancel: () => { const n = killAll(d.slug); if (n) console.log(`[${d.slug}] wall clock: stopped ${n} CLI process${n === 1 ? '' : 'es'}`); },
    emit: (type, payload) => {
      // the engine ended an unanswered gate at the deadline: close this side of it too
      if (type === 'gate-expired' && d.pending) { clearTimeout(d.timer); d.timer = null; d.pending = null; push(d, { type: 'gate-closed', action: 'stop' }); }
      push(d, payload); watchRounds(d, payload);
      if (type === 'done') { d.finished = true; d.synthesizing = false; autoExport(d, fieldNotes.exportTo); }
      if (type === 'error') d.synthesizing = false; // a failed synthesis can be asked for again
    },
  });
  d.debate.run().catch((e) => console.error(`[${d.slug}]`, e.message));
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const tooBig = () => Object.assign(new Error(`Request body over ${BODY_LIMIT / 1024} KB.`), { status: 413, drain: true });
  if (Number(req.headers['content-length']) > BODY_LIMIT) throw tooBig();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw tooBig(); // a streamed body with no length: stop keeping it
    chunks.push(chunk);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  try { return s ? JSON.parse(s) : {}; } catch { throw Object.assign(new Error('Request body is not JSON.'), { status: 400 }); }
}

// Every request: the Host must be this server (a DNS-rebound name is refused), and an Origin,
// when the browser sends one, must be this server's page. Every request that changes state: the
// launch token, POST only, a JSON body. Returns an error [status, message] or null.
function refuse(req, isRead) {
  if (!HOSTS.has(req.headers.host || '')) return [403, 'Unknown Host.'];
  if (req.headers.origin && !ORIGINS.has(req.headers.origin)) return [403, 'Cross-origin request refused.'];
  if (isRead) return null;
  if (req.method !== 'POST') return [405, 'POST only.'];
  if (req.headers['x-roundtable-token'] !== TOKEN) return [401, 'Missing or wrong x-roundtable-token.'];
  if (!/^application\/json(;|$)/i.test(req.headers['content-type'] || '')) return [415, 'Send application/json.'];
  return null;
}

async function serveFile(res, file) {
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    const isRead = req.method === 'GET' && (!p.startsWith('/api/') || p === '/api/seats' || p === '/api/debates' || p === '/api/preflight' || /\/events$/.test(p));
    const no = refuse(req, isRead);
    if (no) return json(res, no[0], { error: no[1] });
    if (p === '/') {
      const html = (await readFile(path.join(UI, 'index.html'), 'utf8')).replace('<meta name="roundtable-token" content="">', `<meta name="roundtable-token" content="${TOKEN}">`);
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && p.startsWith('/ui/')) return serveFile(res, path.join(UI, path.normalize(p.slice(4))));
    if (req.method === 'GET' && p.startsWith('/src/') && p.endsWith('.js')) return serveFile(res, path.join(ROOT, path.normalize(p)));

    if (req.method === 'GET' && p === '/api/seats') {
      const cat = catalogue || await catalogueReady;
      return json(res, 200, {
        vendors: Object.entries(ADAPTERS).map(([vendor, a]) => ({
          vendor, kind: a.kind, label: a.label, colour: a.colour, usageUrl: a.usageUrl || null, quota: quota[vendor] || null, profiles: poolsByAccount(a),
          pool: a.pool, catalogue: cat[vendor],
        })),
        moods: Object.fromEntries(Object.entries(MOODS).map(([k, v]) => [k, v])),
        colours: COLOURS,
        defaults: DEFAULTS,
        baselines,
        calibration,
        pools,
      });
    }
    const pm = p.match(/^\/api\/pools\/([a-z]+)$/);
    if (pm && req.method === 'POST') return json(res, 200, { pool: setPool(pm[1], await readBody(req)) });
    if (req.method === 'GET' && p === '/api/debates') return json(res, 200, { debates: listDebates() });
    if (p === '/api/preflight' && (req.method === 'GET' || req.method === 'POST')) {
      // GET: pools=a,b (CLI pools). POST {pools, endpoints, fresh}: the same plus API pools.
      const body = req.method === 'POST' ? await readBody(req) : { pools: String(url.searchParams.get('pools') || '').split(','), fresh: url.searchParams.has('fresh') };
      const list = Array.isArray(body.pools) ? body.pools : String(body.pools || '').split(',');
      const keys = [...new Set(list.map((k) => String(k).trim()).filter((k) => /^[a-z]+(@[a-z0-9][a-z0-9_.-]{0,39})?$/i.test(k)))].slice(0, 12);
      const endpoints = req.method === 'POST' && body.endpoints && typeof body.endpoints === 'object' ? body.endpoints : {};
      return json(res, 200, { pools: await preflight(keys, !!body.fresh, endpoints) });
    }
    if (req.method === 'POST' && p === '/api/debates') {
      const body = await readBody(req);
      return json(res, 200, { slug: startDebate(body) });
    }
    const m = p.match(/^\/api\/debates\/([^/]+)\/(events|continue|stop|hold|resume|export|synthesize|accept)$/);
    if (m) {
      const d = debates.get(m[1]) || loadDebate(m[1]);
      if (!d) return json(res, 404, { error: 'No debate with that slug on this server or on disk. Start a new one.' });
      if (m[2] === 'events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for (let i = replayFrom(d, req.headers['last-event-id']); i < d.events.length; i++) res.write(sseLine(d, i));
        d.clients.add(res);
        req.on('close', () => d.clients.delete(res));
        return;
      }
      const body = validateMessage(await readBody(req));
      if (m[2] === 'resume') { resumeDebate(d, body); return json(res, 200, { ok: true }); }
      if (m[2] === 'synthesize') { synthesizeDebate(d, body); return json(res, 200, { ok: true }); }
      if (m[2] === 'accept') return json(res, 200, acceptDecision(d, body));
      if (m[2] === 'export') {
        if (!d.finished) return json(res, 400, { error: 'Export after the verdict; the record needs the whole debate.' });
        const out = exportRecord(d, body.target);
        return json(res, 200, { path: out.path, indexPath: out.indexPath, status: out.meta.status, chosen: out.meta.chosen });
      }
      if (d.finished || d.interrupted) return json(res, 400, { error: d.finished ? 'This debate is finished; it replays read-only.' : 'This debate was interrupted; resume it first.' });
      if (m[2] === 'continue') return json(res, 200, { ok: answerGate(d, { action: 'continue', message: body.message || '' }) });
      if (m[2] === 'stop') {
        // At a gate the answer is the stop. Mid-round the seats' CLI children are killed (they
        // fail for the round), the round closes at once and its gate takes the queued stop.
        if (!answerGate(d, { action: 'stop', message: body.message || '' })) {
          d.stopQueued = true;
          const killed = killAll(d.slug);
          push(d, { type: 'stop-queued', killed });
          if (killed) console.log(`[${d.slug}] stop: killed ${killed} CLI process${killed === 1 ? '' : 'es'}`);
        }
        return json(res, 200, { ok: true });
      }
      if (m[2] === 'hold') {
        if (d.timer) { clearTimeout(d.timer); d.timer = null; push(d, { type: 'held' }); }
        return json(res, 200, { ok: true });
      }
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    // An oversized body: answer, close the connection, and discard the rest unread.
    if (e.drain) { res.setHeader('connection', 'close'); req.resume(); }
    json(res, e.status || 400, { error: e.message });
  }
});

// Open the board in the browser when a person started the server from a terminal: not for the
// tests, not for an editor's preview, not with --no-open or ROUNDTABLE_NO_OPEN=1.
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); return true; } catch { return false; }
}
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  const open = process.stdout.isTTY && !process.argv.includes('--no-open') && process.env.ROUNDTABLE_NO_OPEN !== '1' && !process.env.CI;
  const opened = open && openBrowser(url);
  console.log(`roundtable${FAKE ? ' (fake seats)' : ''}: ${url}  token ${TOKEN}`);
  if (opened) console.log('the board is open in your browser; Ctrl+C here stops the server and every CLI it started');
});

// No CLI outlives the server: on a signal or an uncaught error every registered child goes
// (process tree on Windows, process group elsewhere) before the process exits.
function shutdown(why, code = 0) {
  const n = liveChildren().length;
  killAll();
  console.log(`[server] ${why}${n ? `, killed ${n} CLI process${n === 1 ? '' : 'es'}` : ''}`);
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { console.error('[server] uncaught:', e); shutdown('uncaught error', 1); });
process.on('unhandledRejection', (e) => { console.error('[server] unhandled rejection:', e); });
for (const vendor of Object.keys(readers)) refreshQuota(vendor); // codex: one app-server read at start
