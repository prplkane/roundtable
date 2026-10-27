// Local history and numeric usage records. Neither is model memory.
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { openDebateDir, normaliseRows, isSynthetic } from './store.js';
import { ledgerEntries, rollup } from './engine.js';
import { baselinesFrom } from './estimate.js';

export function dataDirectory({ fake = false, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.ROUNDTABLE_DEBATES_DIR) return path.resolve(env.ROUNDTABLE_DEBATES_DIR);
  const base = platform === 'win32' ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Roundtable')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Roundtable')
      : path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'roundtable');
  return path.resolve(base, fake ? 'demo' : 'live');
}

// A single server owns a data folder. This also protects sessions opened on another port.
// An abruptly terminated server leaves a lock whose dead PID can be reclaimed at startup.
export function acquireDataLock(root) {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, '_server.lock'), owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const starting = path.join(root, '_server.starting');
  try { writeFileSync(starting, owner, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('Another server is starting with this data folder. Retry once it has started. If startup was interrupted, check that no server uses the folder before removing _server.starting.');
  }
  try {
    if (existsSync(file)) {
      if (lstatSync(file).isSymbolicLink()) throw new Error('The data-folder lock must not be a link.');
      const prior = readFileSync(file, 'utf8');
      let pid; try { pid = JSON.parse(prior).pid; } catch { /* fail closed */ }
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('The data-folder lock is unreadable. Check that its server has stopped before removing _server.lock.');
      let running = true;
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') running = false; }
      if (running) throw new Error('This data folder is already open in another Roundtable server. Use that server, or stop it before starting another.');
      if (readFileSync(file, 'utf8') !== prior) throw new Error('The data-folder lock changed. Retry startup.');
      unlinkSync(file);
    }
    writeFileSync(file, owner, { flag: 'wx', mode: 0o600 });
  } finally { unlinkSync(starting); }
  return () => { if (existsSync(file) && readFileSync(file, 'utf8') === owner) unlinkSync(file); };
}

export function historyIds(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[a-z0-9-]+$/.test(d.name)
    && existsSync(path.join(root, d.name, 'transcript.jsonl'))).map((d) => d.name);
}

// Resolve and check the exact directory before any recursive removal. Refuse linked records
// and nested junctions rather than traversing a path outside the selected data folder.
export function checkedHistoryPath(root, id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,119}$/.test(id)) throw new Error('Invalid session ID.');
  const base = realpathSync(root), dir = path.resolve(base, id);
  if (path.dirname(dir) !== base || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory() || realpathSync(dir) !== dir)
    throw new Error('The session must be a real directory directly inside the data folder.');
  const walk = (p) => {
    for (const item of readdirSync(p, { withFileTypes: true })) {
      const child = path.join(p, item.name), st = lstatSync(child);
      if (st.isSymbolicLink()) throw new Error('This session contains a link. Remove the link before deleting the session.');
      if (st.isDirectory()) walk(child);
    }
  };
  walk(dir);
  if (!existsSync(path.join(dir, 'transcript.jsonl'))) throw new Error('This directory is not a saved session.');
  return dir;
}

export function removeHistory(root, id) {
  const dir = checkedHistoryPath(root, id);
  rmSync(dir, { recursive: true, maxRetries: 2, retryDelay: 30 });
}

const number = (n) => Number.isFinite(n) && n >= 0 ? n : 0;
const cost = (n) => Number.isFinite(n) && n >= 0 ? n : null;
// Keep a strict allowlist: no titles, replies, prompts, notes, paths, account IDs or raw output.
function numericCall(row) {
  const usage = row.usage ? Object.fromEntries(['input', 'cacheRead', 'cacheWrite', 'output', 'thinking', 'ms'].map((k) => [k, number(row.usage[k])])) : null;
  if (usage) { usage.cost = cost(row.usage.cost); usage.usageVersion = 3; }
  return { type: 'attempt', seat: { vendor: /^(claude|codex|agy|api)$/.test(row.seat?.vendor) ? row.seat.vendor : 'unknown', ...(row.seat?.model ? { model: String(row.seat.model).slice(0, 200) } : {}) },
    kind: row.kind === 'verdict' || row.type === 'verdict' ? 'verdict' : 'reply', round: number(row.round), fresh: row.fresh === true,
    usage, cost: cost(row.cost), ms: number(row.ms) };
}

export function createUsageStore(root) {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, '_usage.json');
  let reviews = {}, dirty = false;
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink()) throw new Error('The usage statistics file must not be a link.');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.version !== 1 || !saved.reviews || typeof saved.reviews !== 'object' || Array.isArray(saved.reviews)) throw new Error('The usage statistics file is unreadable. Restore _usage.json before cleaning up history.');
    for (const [id, value] of Object.entries(saved.reviews)) {
      if (!/^[a-f0-9]{64}$/.test(id) || !Array.isArray(value?.calls)) throw new Error('The usage statistics file has an invalid record.');
      reviews[id] = { synthetic: value.synthetic === true, calls: value.calls.map(numericCall) };
    }
  }
  const rows = (includeSynthetic = false) => Object.values(reviews).filter((r) => includeSynthetic || !r.synthetic).flatMap((r) => r.calls);
  return {
    record(id, transcript) {
      const key = createHash('sha256').update(id).digest('hex');
      const value = { synthetic: isSynthetic(transcript), calls: ledgerEntries(normaliseRows(transcript)).map(numericCall) };
      if (JSON.stringify(reviews[key]) !== JSON.stringify(value)) { reviews[key] = value; dirty = true; }
    },
    sync(onWarning = () => {}) {
      for (const id of historyIds(root)) {
        try { checkedHistoryPath(root, id); this.record(id, openDebateDir(root, id, { create: false }).readTranscript({ onWarning })); }
        catch (error) { onWarning(error); }
      }
      this.save();
    },
    save(force = false) {
      if (!dirty && !force && existsSync(file)) return;
      const temporary = path.join(root, `_usage-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, reviews }), { flag: 'wx', mode: 0o600, flush: true });
        renameSync(temporary, file); dirty = false;
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    },
    baselines: () => baselinesFrom(rows()),
    summary(includeSynthetic = false) {
      const entries = Object.values(reviews).filter((r) => includeSynthetic || !r.synthetic);
      return { reviews: entries.length, ...rollup(rows(includeSynthetic)).total };
    },
  };
}
