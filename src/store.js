import { mkdirSync, existsSync, appendFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fieldNotesText } from './prompts.js';
import { positions, ledgerEntries, synthesisOf } from './engine.js';
import { ADAPTERS } from './adapters/config.js';
import { optionId } from './contract.js';

// Usage rows written before usageVersion 3 carry the vendor's own input figure. Bring them to
// the one meaning (input = uncached) by the vendor's cache semantics. Idempotent: a row already
// at version 3 is left alone, so a legacy transcript with new rows appended reads correctly.
export function normaliseRows(rows) {
  return rows.map((r) => {
    if (!r?.usage || r.usage.usageVersion >= 3 || !r.seat?.vendor) return r;
    const semantics = ADAPTERS[r.seat.vendor]?.cacheSemantics || 'unknown';
    const input = semantics === 'subset' ? Math.max(0, (r.usage.input || 0) - (r.usage.cacheRead || 0)) : r.usage.input;
    return { ...r, usage: { ...r.usage, input, usageVersion: 3, cacheSemantics: semantics, normalised: true } };
  });
}

// A transcript from scripted seats: marked fake on its head row (since 0.3.0), or, for older
// ones, any reply carrying a session id the fake runner made.
export function isSynthetic(rows) {
  return rows.some((r) => (r.type === 'field-notes' && r.fake === true) || (typeof r.sessionId === 'string' && r.sessionId.startsWith('fake-')));
}

// Every transcript row under root, oldest folder first. Malformed lines are skipped.
// excludeSynthetic: leave out whole transcripts from scripted seats (estimates must never learn
// from them).
export function readAllTranscripts(root, { excludeSynthetic = false } = {}) {
  const rows = [];
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name).sort(); } catch { return rows; }
  for (const name of dirs) {
    const f = path.join(root, name, 'transcript.jsonl');
    if (!existsSync(f)) continue;
    const own = [];
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { own.push(JSON.parse(line)); } catch { /* skip */ }
    }
    if (excludeSynthetic && isSynthetic(own)) continue;
    rows.push(...normaliseRows(own));
  }
  return rows;
}

export function slugFor(decision, root) {
  const base = (decision || 'debate').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'debate';
  const day = new Date().toISOString().slice(0, 10);
  let slug = `${day}-${base}`;
  for (let i = 2; existsSync(path.join(root, slug)); i++) slug = `${day}-${base}-${i}`;
  return slug;
}

// One folder per debate: transcript.jsonl (every message, with usage), field-notes.md, verdict.md.
export function openDebateDir(root, slug, { create = true } = {}) {
  const dir = path.join(root, slug);
  const transcript = path.join(dir, 'transcript.jsonl');
  if (!create && !existsSync(transcript)) return null;
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    // One empty directory per instance: the CLIs read project files, project memory and
    // project settings from the working directory, so none of that is shared between seats.
    seatDir(id) {
      const d = path.join(dir, 'seats', String(id).replace(/[^a-z0-9_-]/gi, '_'));
      mkdirSync(d, { recursive: true });
      return d;
    },
    append(row) { appendFileSync(transcript, JSON.stringify({ t: new Date().toISOString(), ...row }) + '\n'); },
    writeFieldNotes(fn, seats) {
      const md = [
        `# Field notes: ${fn.decision}`, '',
        '```', fieldNotesText(fn), '```', '',
        '## Seats', ...seats.map((s) => `- ${s.vendor}${s.endpoint ? ` at ${s.endpoint}` : ''} as "${s.lens}"`), '',
      ].join('\n');
      writeFileSync(path.join(dir, 'field-notes.md'), md);
    },
    writeVerdict(text, meta) {
      const md = [
        `# Verdict: ${meta.decision}`, '',
        `Chairman: ${meta.chairman}. Rounds: ${meta.rounds}. Stopped because: ${meta.stopReason}.`, '',
        text.trim(), '',
      ].join('\n');
      writeFileSync(path.join(dir, 'verdict.md'), md);
    },
    readTranscript() {
      if (!existsSync(transcript)) return [];
      return readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

// Rebuild a debate from its transcript rows: what the board needs to replay it, and what the
// engine needs to continue it. Pure. A round is complete when every seat in the field-notes row
// has a reply at that index; a partial round is dropped and re-run from scratch on resume. When
// a seat has several reply rows for one round (a re-run after an interruption), the last wins.
// Returns null when there is no field-notes row.
export function rebuildDebate(rows) {
  rows = normaliseRows(rows);
  const head = rows.find((r) => r.type === 'field-notes');
  if (!head) return null;
  const seats = head.seats || [];
  const sid = (s) => s?.id ?? `${s?.vendor}:${s?.lens}`; // schema 1 rows had no seat id
  const byRound = new Map(); // round -> Map(seatId -> reply)
  const humanNotes = [], reopens = [];
  let stop = null, verdict = null, error = null, resumedRows = 0, accepted = null;
  const downs = [];
  let fallback = null;
  const originalOf = new Map(); // a reply with its stance key rewritten -> the row as written
  for (const r of rows) {
    if (r.type === 'reply') {
      if (!byRound.has(r.round)) byRound.set(r.round, new Map());
      // before 0.3.0 a stance key was the option's label; since, its id. A resumed old debate
      // compares both, so old keys are read as ids (PASS and "other: …" are left as they are);
      // otherwise a stance that never moved could not count as stable.
      const old = !(head.schemaVersion >= 3) && r.stanceKey && r.stanceKey !== 'PASS' && !r.stanceKey.startsWith('other: ');
      const row = old ? { ...r, stanceKey: optionId(r.stanceKey, head.fieldNotes?.options) ?? r.stanceKey } : r;
      if (row !== r) originalOf.set(row, r);
      byRound.get(r.round).set(sid(r.seat), row);
    } else if (r.type === 'human') (humanNotes[r.round] ??= []).push(r.text);
    else if (r.type === 'reopen') reopens.push(r);
    else if (r.type === 'stop') stop = r;
    else if (r.type === 'verdict') verdict = r;
    else if (r.type === 'error') error = r;
    else if (r.type === 'resumed') resumedRows++;
    else if (r.type === 'accepted') accepted = r;
    else if (r.type === 'pool-down') downs.push(r);
    else if (r.type === 'chairman-fallback') fallback = r;
  }
  const rounds = [];
  for (let i = 0; byRound.has(i); i++) {
    const m = byRound.get(i);
    if (seats.length && !seats.every((s) => m.has(sid(s)))) break; // partial: stop here
    rounds.push(seats.length ? seats.map((s) => m.get(sid(s))) : [...m.values()]);
  }
  const partialRound = byRound.has(rounds.length) ? rounds.length : null;
  // finished: the rounds are closed. synthesis: whether a verdict got written. They are separate,
  // so a debate whose verdict was skipped or failed is complete and can still be given one.
  // before 0.3.0 a failed chairman was a verdict whose text began "Chairman failed:"
  if (verdict && !verdict.failed && !verdict.skipped && /^Chairman failed:/.test(verdict.text || '')) verdict = { ...verdict, failed: true };
  const finished = !!(stop || verdict);
  const synthesis = synthesisOf(verdict);
  const deadlineAt = [...rows].reverse().find((r) => (r.type === 'resumed' || r.type === 'field-notes') && r.deadlineAt != null)?.deadlineAt ?? null;
  // session ids: the last reply row of each seat (resume mode continues the thread)
  const sessions = {};
  for (const r of rows) if (r.type === 'reply' && r.sessionId) sessions[sid(r.seat)] = r.sessionId;
  // The spend ledger, partial rounds included (they were paid for), and each seat's last
  // cumulative cost reading, so a resumed session is charged only its own part.
  const ledger = ledgerEntries(rows);
  const lastRawCost = {};
  for (const e of ledger) if (typeof e.usage?.raw?.cost === 'number') lastRawCost[sid(e.seat)] = e.usage.raw.cost;
  const seatsWithSessions = seats.map((s) => ({ ...s, sessionId: sessions[sid(s)] || null, ...(lastRawCost[sid(s)] != null ? { lastRawCost: lastRawCost[sid(s)] } : {}) }));
  // Ledger entries the board must see as attempts: real attempt rows, plus legacy usage that no
  // replayed reply carries (a re-prompt whose turn never got a reply, and, since only the last
  // replay, a reply superseded by a re-run, a reply in a partial round).
  const shownReplies = new Set(rounds.flat().map((x) => originalOf.get(x) || x));
  const attemptEvents = [
    ...ledger.filter((e) => e.type === 'attempt' || e.type === 'reprompt'),
    ...rows.filter((r) => r.type === 'reply' && !r.attemptId && r.usage && !shownReplies.has(r)).map((r) => ({ ...r, kind: 'reply' })),
  ].map((e) => ({ ...e, type: 'attempt' }));
  const shown = new Set();
  const attemptsFor = (pred) => attemptEvents.filter((e, i) => !shown.has(i) && pred(e) && shown.add(i));

  // The event list the board replays. Same shapes as the live engine emits.
  const t = (row) => ({ type: row.type });
  const events = [{ type: 'started', seats, fieldNotes: head.fieldNotes, options: head.options, chairman: head.chairman, replayed: true }];
  rounds.forEach((replies, i) => {
    events.push({ type: 'round-start', round: i });
    events.push(...attemptsFor((e) => e.round === i && e.kind !== 'verdict'));
    for (const r of replies) {
      events.push({ ...r, type: 'reply' });
      events.push({ type: 'seat-state', round: i, seat: r.seat, state: r.state || (r.failed ? (r.timedOut ? 'timed-out' : 'failed') : (r.reprompted ? 'reprompted' : 'replied')) });
    }
    events.push({ type: 'round-done', round: i, replies, positions: positions(replies) });
    for (const text of humanNotes[i] || []) events.push({ type: 'human', round: i, text });
    for (const ro of reopens.filter((x) => x.round === i)) events.push({ type: 'reopen', round: ro.round, stop: ro.stop });
  });
  events.push(...attemptsFor(() => true)); // a partial round's calls and the chairman's
  for (const x of downs) events.push({ ...x, type: 'pool-down' });
  if (fallback) events.push({ ...fallback, type: 'chairman-fallback' });
  if (stop) events.push({ type: 'stopped', reason: stop.reason, rounds: stop.rounds });
  if (verdict && verdict.skipped) events.push({ type: 'verdict', seat: null, text: verdict.text, usage: null, failed: true, skipped: true, reason: verdict.reason });
  else if (verdict) events.push({ type: 'chairman-start', seat: verdict.seat }, { type: 'verdict', seat: verdict.seat, text: verdict.text, usage: verdict.usage, attemptId: verdict.attemptId, ...(verdict.failed ? { failed: true, errors: verdict.errors } : {}) });
  if (error && !finished) events.push({ type: 'error', message: error.message });
  if (finished) events.push({ type: 'done', reason: stop?.reason ?? null, replayed: true, synthesis });
  else events.push({ type: 'interrupted', round: rounds.length, partialRound, resumedBefore: resumedRows });
  if (accepted) events.push({ ...accepted, type: 'accepted' });
  return {
    fieldNotes: head.fieldNotes, seats: seatsWithSessions, chairman: head.chairman, options: head.options,
    rounds, humanNotes, partialRound, finished, synthesis, deadlineAt, accepted, stopReason: stop?.reason ?? null, verdict, nextRound: rounds.length, events, ledger,
  };
}
