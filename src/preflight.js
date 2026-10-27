// Pre-flight: can a seat's CLI take a call right now? Free checks only, no model call: is the
// binary there, is it logged in (the CLI's own status command), and what does its quota say.
// The answer drives the round lamp on each seat card (signature-design "character cards").
//
//   lamp(check) -> { state: 'ok' | 'warn' | 'danger' | 'idle', kind, note }      (pure)
//   checkPool({ vendor, account }, deps) -> { key, installed, loggedIn, quota, ...lamp }
//   endpointLamp({ url, keyEnv, keySet }) -> the same shape for an API endpoint seat   (pure)
//
import { checkEndpointUrl, privateHost, KEY_ENV_RE } from './seats.js';

export const PREFLIGHT_TTL_MS = 60_000;

// Reading a snapshot is always free of work. Only refresh() can enqueue a CLI check; callers
// must authenticate that action. Keep running and queued work shared per pool, including
// forced refreshes, and never release a slot before its check actually settles.
export function createPreflightCache({ check, now = Date.now, ttlMs = PREFLIGHT_TTL_MS,
  cooldownMs = 5_000, maxConcurrent = 2, maxPending = 12, maxCached = 64 }) {
  const cache = new Map(), pending = new Map(), queue = [];
  let active = 0;
  function read(key) {
    const hit = cache.get(key);
    const result = hit?.result || { key, state: 'idle', kind: 'not-checked', note: 'not checked yet · use Refresh status' };
    return { ...result, checkedAt: hit?.at ?? null, stale: !hit || now() - hit.at >= ttlMs, refreshing: pending.has(key) };
  }
  function drain() {
    while (active < maxConcurrent && queue.length) {
      const { key, resolve } = queue.shift();
      active++;
      Promise.resolve().then(() => check(key))
        .catch(() => ({ key, state: 'warn', kind: 'check-failed', note: 'status check failed · try Refresh status again' }))
        .then((result) => {
          cache.delete(key);
          cache.set(key, { at: now(), result });
          while (cache.size > maxCached) cache.delete(cache.keys().next().value);
          pending.delete(key);
          active--;
          resolve(read(key));
          drain();
        });
    }
  }
  function refresh(key, { fresh = false } = {}) {
    if (pending.has(key)) return pending.get(key);
    const hit = cache.get(key);
    if (hit && now() - hit.at < (fresh ? cooldownMs : ttlMs)) return Promise.resolve(read(key));
    if (pending.size >= maxPending) return Promise.resolve({ ...read(key), state: 'warn', kind: 'busy',
      note: 'status checks are busy · try Refresh status again shortly' });
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    pending.set(key, promise);
    queue.push({ key, resolve });
    drain();
    return promise;
  }
  return { read, refresh };
}

// deps are injected so tests never spawn a CLI: resolve(binary), status(vendor, home) ->
// true | false | null (null: the CLI cannot say), quota(key) -> the pool's snapshot or null.

// The CLI's own login-status command, and how to read its answer. Antigravity has none; its
// model list (read at boot, and only answered for a logged-in user) stands in for it.
// plan(out): the subscription the status names, where it names one (claude: subscriptionType).
export const STATUS = {
  claude: {
    args: ['auth', 'status'],
    read: (out) => { try { return JSON.parse(out.slice(out.indexOf('{'))).loggedIn === true; } catch { return /logged ?in/i.test(out) && !/not logged/i.test(out); } },
    plan: (out) => { try { return JSON.parse(out.slice(out.indexOf('{'))).subscriptionType || null; } catch { return null; } },
  },
  codex: { args: ['login', 'status'], read: (out) => /logged in/i.test(out) && !/not logged in/i.test(out) },
};

const LOGIN = { claude: 'claude /login', codex: 'codex login', agy: 'agy (sign in once in a terminal)' };

function untilText(ms, now) {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
}

// What the lamp shows, from what the checks found. Pure.
export function lamp({ vendor, installed, loggedIn, quota, account = null }, now = Date.now()) {
  if (!installed) return { state: 'danger', kind: 'missing', note: `${vendor} CLI not found on this machine` };
  if (loggedIn === false) return { state: 'danger', kind: 'auth', note: `not logged in${account ? ` (profile ${account})` : ''}: run ${LOGIN[vendor] || 'its login'}` };
  const windows = quota?.windows || [];
  if (windows.length) {
    const worst = windows.reduce((a, w) => (w.used > a.used ? w : a));
    const text = windows.map((w) => `${w.label} ${Math.round(w.used * 100)}%`).join(' · ');
    const reset = worst.resetsAt ? `, resets ${untilText(worst.resetsAt * 1000, now)}` : '';
    if (worst.used >= 1) return { state: 'danger', kind: 'quota', note: `quota used up (${worst.label}${reset})`, resetsAt: worst.resetsAt ? worst.resetsAt * 1000 : null };
    if (worst.used >= 0.9) return { state: 'warn', kind: 'quota-low', note: `quota nearly used: ${text}${reset}` };
    return { state: 'ok', kind: null, note: `ready · ${text}` };
  }
  if (loggedIn === null) return { state: 'warn', kind: 'unknown', note: 'login not checked: this CLI has no status command' };
  return { state: 'ok', kind: null, note: vendor === 'agy' ? 'logged in · quota not reported by this CLI' : 'logged in · quota shows after the first call' };
}

export async function checkPool({ vendor, account = null, key }, { resolve, status, quota, now = Date.now() }) {
  let installed = true;
  try { resolve(vendor); } catch { installed = false; }
  // status() answers true | false | null, or { loggedIn, plan } when the CLI names the plan
  const st = installed ? await status(vendor, account) : null;
  const loggedIn = st && typeof st === 'object' ? st.loggedIn : st;
  const q = installed && loggedIn !== false ? await quota(key) : null;
  const plan = (st && typeof st === 'object' ? st.plan : null) || q?.plan || null; // codex: the quota read's planType
  return { key, vendor, account, installed, loggedIn, plan, quota: q, ...lamp({ vendor, installed, loggedIn, quota: q, account }, now) };
}

// The lamp for an API endpoint pool, from what can be known without a request: does the URL
// pass the seat rules, and is the named key variable set in this process's environment. No
// probe is sent, even on authenticated refresh. This check says only whether configuration
// is present; it does not establish reachability or send a key. The first real call is the
// connection check, and its failure lands on this lamp like a CLI's would.
export function endpointLamp({ url, keyEnv = null, keySet = false }) {
  if (!url) return { state: 'idle', kind: null, note: 'no endpoint yet' };
  let u;
  try { u = new URL(checkEndpointUrl(url)); } catch (e) { return { state: 'danger', kind: 'endpoint', note: e.message }; }
  const where = privateHost(u.hostname) ? 'API · local' : 'API · pay-per-token';
  if (keyEnv && !KEY_ENV_RE.test(keyEnv)) return { state: 'danger', kind: 'auth', note: `the key variable must be the NAME of an environment variable, not the key` };
  if (keyEnv && !keySet) return { state: 'danger', kind: 'auth', note: `${keyEnv} is not set in the environment roundtable was started from` };
  if (!keyEnv && !privateHost(u.hostname)) return { state: 'danger', kind: 'auth', note: 'a hosted API needs the name of the variable that holds its key' };
  return { state: 'ok', kind: null, note: `${where} · ${keyEnv ? `${keyEnv} set · ` : ''}checked on the first call` };
}
