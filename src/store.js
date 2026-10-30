import { mkdirSync, existsSync, appendFileSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fieldNotesText } from './prompts.js';
import { positions, ledgerEntries, synthesisOf } from './engine.js';
import { ADAPTERS } from './adapters/config.js';
import { optionId, humanQuestion } from './contract.js';
import { noteRecord, storedNote } from './notes.js';
import { researchSources } from './research.js';

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

const reportTranscriptWarning = (warning) => console.warn(`[transcript] ${warning.message}`);

// Parse bytes so a torn UTF-8 character and a torn JSON value have the same recovery boundary.
// Only an unreadable, unterminated final line with a valid prefix is recoverable. A completed
// bad line or a non-record JSON value is corruption; never skip it and trust the rest.
function inspectTranscript(file, data = existsSync(file) ? readFileSync(file) : Buffer.alloc(0)) {
  const rows = [];
  const name = `${path.basename(path.dirname(file))}/transcript.jsonl`;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const corrupt = (line) => Object.assign(new Error(`${name}: corrupt record at line ${line}. Restore the transcript from a backup before resuming or exporting; the original file has not been changed.`), { code: 'TRANSCRIPT_CORRUPT', line });
  let start = 0, line = 0;
  while (start < data.length) {
    line++;
    const newline = data.indexOf(10, start);
    const end = newline < 0 ? data.length : newline;
    let row;
    try {
      const text = decoder.decode(data.subarray(start, end));
      if (text.trim()) row = JSON.parse(text);
    } catch {
      if (newline < 0 && rows.some((r) => r.type === 'field-notes')) {
        const warning = { code: 'TRANSCRIPT_TAIL', line, message: `${name}: incomplete final line ${line} was ignored. Complete records are available; the original bytes will be backed up before the next write.` };
        return { rows, data, tail: start, warning };
      }
      throw corrupt(line);
    }
    if (row !== undefined) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.type !== 'string' || !row.type) throw corrupt(line);
      rows.push(row);
    }
    start = end + 1;
  }
  return { rows, data, tail: null, warning: null };
}

// Every readable transcript's valid prefix, oldest folder first. Corrupt records are excluded
// as a whole with a warning, so one damaged archive does not prevent server startup.
// excludeSynthetic: leave out whole transcripts from scripted seats (estimates must never learn
// from them).
export function readAllTranscripts(root, { excludeSynthetic = false, onWarning = reportTranscriptWarning } = {}) {
  const rows = [];
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name).sort(); } catch { return rows; }
  for (const name of dirs) {
    const f = path.join(root, name, 'transcript.jsonl');
    if (!existsSync(f)) continue;
    let own;
    try {
      const parsed = inspectTranscript(f);
      own = parsed.rows;
      if (parsed.warning) onWarning(parsed.warning);
    } catch (error) { onWarning(error); continue; }
    if (excludeSynthetic && isSynthetic(own)) continue;
    rows.push(...normaliseRows(own));
  }
  return rows;
}

export function slugFor(decision, root) {
  const base = (decision || 'debate').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'debate';
  const day = new Date().toISOString().slice(0, 10);
  let slug;
  do { slug = `${day}-${base}-${globalThis.crypto.randomUUID().replaceAll('-', '')}`; } while (existsSync(path.join(root, slug)));
  return slug;
}

// One folder per debate: transcript.jsonl (every message, with usage), field-notes.md, verdict.md.
export function openDebateDir(root, slug, { create = true } = {}) {
  const dir = path.join(root, slug);
  const transcript = path.join(dir, 'transcript.jsonl');
  if (!create && !existsSync(transcript)) return null;
  mkdirSync(dir, { recursive: true });
  let prepared = false;
  function prepareAppend() {
    if (prepared) return null;
    const parsed = inspectTranscript(transcript);
    let recovery = null;
    if (parsed.tail != null) {
      const id = globalThis.crypto.randomUUID();
      const backup = `transcript.recovery-${id}.jsonl`;
      const temporary = path.join(dir, `transcript.repair-${id}.tmp`);
      // Save the exact original first, without replacing an existing file. Stage the repaired
      // prefix separately; a failed backup or replacement leaves the original unchanged.
      writeFileSync(path.join(dir, backup), parsed.data, { flag: 'wx', mode: 0o600 });
      recovery = { t: new Date().toISOString(), type: 'transcript-recovered', line: parsed.warning.line, backup,
        message: `Recovered complete records before incomplete line ${parsed.warning.line}. The exact original is saved beside the transcript as ${backup}.` };
      writeFileSync(temporary, Buffer.concat([parsed.data.subarray(0, parsed.tail), Buffer.from(JSON.stringify(recovery) + '\n')]), { flag: 'wx', mode: 0o600 });
      try { renameSync(temporary, transcript); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    } else if (parsed.data.length && parsed.data.at(-1) !== 10) {
      // A fully written final JSON value is valid even without its newline. Separate the next
      // append so it cannot turn two valid records into one corrupt line.
      appendFileSync(transcript, '\n');
    }
    prepared = true;
    return recovery;
  }
  return {
    dir,
    prepareAppend,
    // One empty directory per instance: the CLIs read project files, project memory and
    // project settings from the working directory, so none of that is shared between seats.
    seatDir(id) {
      const d = path.join(dir, 'seats', String(id).replace(/[^a-z0-9_-]/gi, '_'));
      mkdirSync(d, { recursive: true });
      return d;
    },
    append(row) {
      try {
        prepareAppend();
        appendFileSync(transcript, JSON.stringify({ t: new Date().toISOString(), ...row }) + '\n', { flush: row.type === 'attempt-start' });
      } catch (error) {
        // A failed append can have written a torn tail. Even this same writer must inspect
        // and preserve it before a later turn or a repaired review writes anything else.
        prepared = false;
        throw error;
      }
    },
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
    readTranscript({ onWarning = reportTranscriptWarning } = {}) {
      const parsed = inspectTranscript(transcript);
      if (parsed.warning) onWarning(parsed.warning);
      return parsed.rows;
    },
    async readTranscriptAsync({ onWarning = reportTranscriptWarning } = {}) {
      const parsed = inspectTranscript(transcript, await readFile(transcript));
      if (parsed.warning) onWarning(parsed.warning);
      return parsed.rows;
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
  let research = rows.findLast((r) => r.type === 'research') || (rows.some((r) => r.type === 'research-start') ? { status: 'interrupted' } : null);
  const fieldNotes = { ...head.fieldNotes };
  delete fieldNotes.research;
  if (research?.status === 'done') {
    try {
      const gatheredAt = new Date(research.gatheredAt).toISOString();
      if (!Number.isInteger(research.searches) || research.searches < 1 || research.searches > 8) throw new Error('invalid count');
      research = { status: 'done', gatheredAt, searches: research.searches, attemptId: research.attemptId,
        sources: researchSources(JSON.stringify({ sources: research.sources }), gatheredAt) };
      fieldNotes.research = research.sources;
    } catch { research = { status: 'failed', errorKind: 'format', error: 'The saved research bundle is invalid. It was not refetched.' }; }
  }
  const seats = head.seats || [];
  const sid = (s) => s?.id ?? `${s?.vendor}:${s?.lens}`; // schema 1 rows had no seat id
  const byRound = new Map(); // round -> Map(seatId -> reply)
  const humanNotes = [], initialNotes = [], reopens = [];
  let stop = null, verdict = null, error = null, resumedRows = 0, accepted = null;
  const downs = [];
  let fallback = null;
  const originalOf = new Map(); // a normalized reply -> the row as written (for usage identity)
  for (const r of rows) {
    if (r.type === 'reply') {
      if (!byRound.has(r.round)) byRound.set(r.round, new Map());
      // before 0.3.0 a stance key was the option's label; since, its id. A resumed old debate
      // compares both, so old keys are read as ids (PASS and "other: …" are left as they are);
      // otherwise a stance that never moved could not count as stable.
      const old = !(head.schemaVersion >= 3) && r.stanceKey && r.stanceKey !== 'PASS' && !r.stanceKey.startsWith('other: ');
      let row = old ? { ...r, stanceKey: optionId(r.stanceKey, head.fieldNotes?.options) ?? r.stanceKey } : r;
      const question = humanQuestion(r.question);
      if (question !== (r.question ?? null) || (r.parsed?.question && humanQuestion(r.parsed.question) !== r.parsed.question))
        row = { ...row, question, ...(row.parsed ? { parsed: { ...row.parsed, question: humanQuestion(row.parsed.question) } } : {}) };
      if (row !== r) originalOf.set(row, r);
      byRound.get(r.round).set(sid(r.seat), row);
    } else if (r.type === 'human') (r.round === -1 ? initialNotes : (humanNotes[r.round] ??= [])).push(storedNote(r));
    else if (r.type === 'reopen') reopens.push(r);
    else if (r.type === 'stop') stop = r;
    else if (r.type === 'verdict') verdict = r;
    else if (r.type === 'synthesis-cancelled') verdict = { text: 'Verdict not written: you stopped the synthesis.', failed: true, skipped: true, reason: r.reason, seat: null };
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
  // Older versions recorded tool activity on a repair/reply row after the successful
  // attempt. Keep the policy state even if the process stopped before a complete round.
  const policyFailures = rows.filter((r) => r.seat && (r.usedTools || r.toolFail || r.errorKind === 'policy')).map((r) => r.seat);
  const lastRawCost = {};
  for (const e of ledger) {
    const cost = e.usage?.raw?.cost ?? e.rawCost;
    if (typeof cost === 'number') lastRawCost[sid(e.seat)] = cost;
  }
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
  const events = [{ type: 'started', seats, fieldNotes, options: head.options, chairman: head.chairman, deadlineAt, replayed: true }];
  if (research) events.push({ type: 'research', ...research, replayed: true });
  const recoveryWarnings = rows.filter((r) => r.type === 'transcript-recovered').map((r) => ({ ...r, type: 'transcript-warning' }));
  events.push(...recoveryWarnings);
  events.push(...initialNotes.map((note) => ({ type: 'human', round: -1, ...noteRecord(note) })));
  rounds.forEach((replies, i) => {
    events.push({ type: 'round-start', round: i });
    events.push(...attemptsFor((e) => e.round === i && e.kind !== 'verdict'));
    for (const r of replies) {
      events.push({ ...r, type: 'reply' });
      events.push({ type: 'seat-state', round: i, seat: r.seat, state: r.state || (r.failed ? (r.timedOut ? 'timed-out' : 'failed') : (r.reprompted ? 'reprompted' : 'replied')) });
    }
    events.push({ type: 'round-done', round: i, replies, positions: positions(replies) });
    for (const note of humanNotes[i] || []) events.push({ type: 'human', round: i, ...noteRecord(note) });
    for (const ro of reopens.filter((x) => x.round === i)) events.push({ type: 'reopen', round: ro.round, stop: ro.stop });
  });
  events.push(...attemptsFor(() => true)); // a partial round's calls and the chairman's
  events.push(...rows.filter((r) => r.type === 'budget'));
  for (const x of downs) events.push({ ...x, type: 'pool-down' });
  if (fallback) events.push({ ...fallback, type: 'chairman-fallback' });
  for (const expired of rows.filter((r) => r.type === 'gate-expired')) events.push({ type: 'gate-expired', round: expired.round });
  if (stop) events.push({ type: 'stopped', reason: stop.reason, rounds: stop.rounds, context: stop.context });
  if (verdict && verdict.skipped) events.push({ type: 'verdict', seat: null, text: verdict.text, usage: null, failed: true, skipped: true, reason: verdict.reason });
  else if (verdict) events.push({ type: 'chairman-start', seat: verdict.seat }, { type: 'verdict', seat: verdict.seat, text: verdict.text, usage: verdict.usage, attemptId: verdict.attemptId, progress: verdict.progress, ...(verdict.failed ? { failed: true, errors: verdict.errors, errorKind: verdict.errorKind, cancelReason: verdict.cancelReason } : {}) });
  if (error && !finished) events.push({ type: 'error', message: error.message });
  if (finished) events.push({ type: 'done', reason: stop?.reason ?? null, replayed: true, synthesis });
  else events.push({ type: 'interrupted', round: rounds.length, partialRound, resumedBefore: resumedRows });
  if (accepted) events.push({ ...accepted, type: 'accepted' });
  return {
    fieldNotes, research, seats: seatsWithSessions, chairman: head.chairman, options: head.options,
    rounds, humanNotes, initialNotes, partialRound, finished, synthesis, deadlineAt, accepted, stopReason: stop?.reason ?? null, stopContext: stop?.context ?? null, verdict, nextRound: rounds.length, events, ledger, policyFailures, recoveryWarnings,
  };
}
