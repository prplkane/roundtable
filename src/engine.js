// The round engine. Pure protocol: no CLI, no HTTP. Everything that touches the world comes in
// through `runner`, `gate`, `store` and `emit`.
//
//   runner(vendor, prompt, sessionId, opts) -> {text, usage, sessionId, raw}
//     opts carries {seat, model, effort, timeoutMs}; seat.id is the instance, never shared
//   gate({mode, reason, round, ...})         -> {action: 'continue'|'finish'|'stop', message?, source?}
//   store                                    -> openDebateDir() handle (or a stub)
//   emit(type, payload)                      -> UI events
//
// Each call has a durable `attempt-start` before dispatch and an `attempt` when it settles.
// ledgerEntries joins them by attemptId; an unfinished start is unknown usage after a crash.
// reply, reprompt and verdict rows name that attempt and cannot count it twice.

import { validateReply, validateVerdict } from './contract.js';
import { filterReply } from './seats.js';
import { round0Prompt, roundPrompt, recoveryPrompt, repromptText, chairmanPrompt, statelessPrefix, statelessRoundPrompt, statelessRepromptText, verdictRepromptText } from './prompts.js';
import { projectRound, projectChairman, budgetCheck, unknownUsageMessage, researchInputTokens } from './estimate.js';
import { noteRecord, storedNote } from './notes.js';
import { safeProgress } from './progress.js';
import { researchSettings, researchPrompt, researchSources } from './research.js';

// Failure kinds after which calling the same login again in this debate only fails again
// (adapters/errors.js classifies them; kept here so the engine stays free of adapter imports).
const POOL_FATAL = new Set(['quota', 'auth', 'missing']);


export const DEFAULTS = {
  critiqueRounds: 1,       // rounds after round 0; deeper reviews are an explicit choice
  // Tokens one seat may use in one review (prompt, cache and output together), so a seat that
  // produces unusually large replies sits out before another projected call exceeds its cap.
  // A hidden mood gets enough for several rounds of fun, no more.
  seatTokenCap: 400_000,
  hiddenSeatTokenCap: 60_000,
  wallClockMs: 30 * 60_000,
  callTimeoutMs: 5 * 60_000,
  autoContinueMs: 60_000,
  // 'stateless': every round is a fresh call whose prompt carries what the seat needs (its own
  // last reply, the others', the note). This avoids resending the full conversation; token use
  // still varies. 'resume': the CLI session is resumed, so conversation context can grow.
  memory: 'stateless',
  // Reported tools stop a seat for the review; callers cannot disable this guard.
  strictTools: true,
  // { [vendor]: { tokens?: number, usd?: number } }: admit each round and every call attempt,
  // retries included, against measured spend plus in-flight reservations and the next projection.
  // A refused call never reaches the runner; a refused round stops the debate. Empty: no cap.
  budget: {},
  // the wait before the one retry a network failure gets (internal; not settable from the API)
  networkRetryMs: 2000,
};

const EMPTY_USAGE = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0, cost: null, ms: 0 };

// resume: { rounds, humanNotes, ledger } from store.rebuildDebate (humanNotes[r]: every note
// given after round r, as a legacy human string or {text, source}). Recovery starts clean provider
// sessions from completed rounds; run() continues from the first incomplete round.
// baselines: per-vendor tokens per call (estimate.js baselinesFrom), for the budget gate.
// provenance: extra fields for the head row ({ fake: true } from a server with scripted seats).
// cancel(reason): stop this review's calls on Stop or when its wall clock runs out.
// synthesisOnly: with resume, skip the rounds and write the verdict (POST .../synthesize).
export function createDebate({ fieldNotes, seats, chairman, options = {}, runner, gate, store, emit = () => {}, now = Date.now, resume = null, baselines = {}, provenance = {}, cancel = () => {}, synthesisOnly = false }) {
  const opts = { ...DEFAULTS, ...options, strictTools: true };
  if (opts.research) opts.research = researchSettings(opts.research);
  const maxRound = opts.critiqueRounds;
  const state = {
    status: 'idle', round: -1, rounds: [], humanNotes: [], initialNotes: [...(resume?.initialNotes || [])], stopReason: null, verdict: null,
    down: {}, // vendor@account -> { kind, message, resetsAt }: a login that cannot take calls this debate
    seats: seats.map((s, i) => {
      const seat = { ...s, id: s.id || `seat-${i}`, index: i, sessionId: null, mood: s.mood || { preset: 'grill' } };
      // Recorded provider threads can have advanced beyond the saved review, even without a
      // partial reply row. Recover with new threads; keep all prior spend in the ledger.
      delete seat.lastRawCost;
      return seat;
    }),
    chairman: chairman || { vendor: seats[0].vendor },
    startedAt: null, deadlineAt: null, stopContext: null, fieldNotes, options: opts, usage: [], research: resume?.research || null,
  };
  const fire = (type, payload = {}) => emit(type, { ...payload, type });
  const record = (row) => { store?.append?.(row); };
  let stopRequested = false, finishRequested = false, writingVerdict = false, interruptRequested = false;
  let controller = new AbortController();
  let pendingTurns = [];
  let interruptGate;
  const interruption = new Promise((resolve) => { interruptGate = resolve; });
  const checkInterrupted = () => {
    if (interruptRequested) throw Object.assign(new Error('The server interrupted this review.'), { code: 'INTERRUPTED' });
  };
  function requestInterrupt() {
    if (interruptRequested || ['done', 'error'].includes(state.status)) return;
    interruptRequested = true;
    controller.abort();
    cancel('interrupted');
    interruptGate({ action: 'interrupt' });
  }
  function saveHumanNote(round, text, source = 'human') {
    const message = String(text || '').trim();
    if (!message || /^\/stop\b/i.test(message)) return;
    const note = noteRecord({ text: message, source });
    record({ type: 'human', round, ...note });
    (round < 0 ? state.initialNotes : (state.humanNotes[round] ??= [])).push(storedNote(note));
    fire('human', { round, ...note });
  }
  function requestStop(message = '', source = 'human') {
    if (stopRequested || ['done', 'error'].includes(state.status)) return;
    stopRequested = true;
    const synthesisStop = writingVerdict || synthesisOnly;
    if (!synthesisStop) state.stopReason = 'human';
    try {
      saveHumanNote(writingVerdict ? state.rounds.length - 1 : state.round, message, source);
      // Persist intent before cancellation when storage is available, including during a
      // manually requested verdict. A failed write must never keep provider calls alive.
      record({ type: synthesisStop ? 'synthesis-cancelled' : 'stop', reason: 'human', rounds: state.rounds.length });
    } finally {
      controller.abort();
      cancel('human');
      fire('stop-queued');
    }
  }

  function canFinish() {
    return !interruptRequested && !stopRequested && !finishRequested && !writingVerdict && !['done', 'error'].includes(state.status)
      && hasUsableRound(state.rounds, state.seats.length);
  }

  function requestFinish(message = '', source = 'human') {
    if (!canFinish()) return false;
    saveHumanNote(state.round, message, source);
    finishRequested = true;
    state.stopReason = 'finish';
    record({ type: 'stop', reason: 'finish', rounds: state.rounds.length });
    fire('finish-queued');
    controller.abort();
    cancel('finish');
    return true;
  }

  // The spend ledger: every attempt so far (on resume, the transcript's, legacy rows included),
  // and a reservation per call in flight, registered before the call is awaited so seats that
  // run concurrently see each other's projected draw.
  const ledger = [];
  const reserved = new Map(); // attemptId -> { vendor: { tokens, cost } }
  const sameSeat = (a, b) => (a?.id ? a.id === b.id : a?.lens === b.lens) && a?.vendor === b.vendor && (a?.account || '') === (b.account || '');
  const policyBlocked = (seat) => ledger.some((e) => e.errorKind === 'policy' && sameSeat(e.seat, seat))
    || (resume?.policyFailures || []).some((s) => sameSeat(s, seat))
    || (resume?.rounds || []).flat().some((r) => (r.usedTools || r.toolFail || r.errorKind === 'policy') && sameSeat(r.seat, seat));
  const evidence = (reply) => !reply || reply.failed || reply.usedTools || reply.toolFail || reply.errorKind === 'policy' ? '(no usable reply)' : reply.text || '(no reply)';

  // The wall clock is one absolute deadline, set when the debate starts, written on its head row
  // and carried across a resume, so a restart never grants a fresh half hour. Human waiting counts.
  let deadlineAt = null, deadlineHit = false;
  const expired = () => deadlineHit || (deadlineAt != null && now() >= deadlineAt);
  const newId = () => globalThis.crypto.randomUUID();

  const resumes = opts.memory === 'resume';

  // One CLI call, recorded as one attempt. `projection` ({vendor: {tokens, cost}}) is reserved
  // while the call runs. A call that ends without a usage report is `unknown`, not zero.
  // A login whose quota is used up, or that is logged out or missing, is down for the rest of the
  // debate: its seats are skipped without a call (they would only fail again), and the board is
  // told once. A network failure gets one retry; anything else fails the seat for the round.
  const downKey = (seat) => `${seat.vendor}@${seat.account || ''}`;
  function markDown(seat, res) {
    const key = downKey(seat);
    if (state.down[key]) return;
    state.down[key] = { vendor: seat.vendor, account: seat.account || null, kind: res.kind, message: res.error, resetsAt: res.resetsAt || null };
    record({ type: 'pool-down', key, ...state.down[key] });
    fire('pool-down', { key, ...state.down[key] });
  }

  async function callSeat(seat, prompt, round, kind, projection = {}, { isChairman = false } = {}) {
    if (policyBlocked(seat)) return { ok: false, text: '', usage: { ...EMPTY_USAGE }, reported: false, error: 'This seat is stopped after a provider-policy failure. Check its earlier failure details.', kind: 'policy', skipped: true, fresh: true, attemptId: null };
    const down = state.down[downKey(seat)];
    if (down) return { ok: false, text: '', usage: { ...EMPTY_USAGE }, reported: false, error: `skipped: ${down.message}`, kind: down.kind, resetsAt: down.resetsAt, skipped: true, fresh: true, attemptId: null };
    for (let attemptNo = 1; ; attemptNo++) {
      checkInterrupted();
      if (state.status === 'error') return { ok: false, text: '', usage: { ...EMPTY_USAGE }, reported: false, error: 'the review stopped after an error', kind: 'killed', fresh: true, attemptId: null };
      if (stopRequested || finishRequested && !isChairman) return { ok: false, text: '', usage: { ...EMPTY_USAGE }, reported: false,
        error: stopRequested ? 'stopped by the user' : 'discussion ended for the verdict', kind: 'killed', cancelReason: stopRequested ? 'human' : 'finish', fresh: !resumes || seat.sessionId == null, attemptId: null };
      // The deadline can pass during a retry delay, after the timer already cancelled the
      // earlier calls. Never dispatch a new call after that one-time cancellation sweep.
      if (expired()) return { ok: false, text: '', usage: { ...EMPTY_USAGE }, reported: false,
        error: 'the wall clock ran out before the call', kind: 'killed', cancelReason: 'wall-clock', fresh: !resumes || seat.sessionId == null, attemptId: null };
      const action = attemptNo > 1 ? 'network retry' : kind === 'reprompt' ? 're-prompt' : kind;
      const what = ['verdict', 'research'].includes(action) ? action : `${action} of ${isChairman ? 'the chairman' : seat.lens}`;
      if (!isChairman) projection = oneCall(seat, round);
      // Check and reserve synchronously at the dispatch boundary. A retry sees the failed
      // attempt's reported usage and every other call still in flight; seat calls also leave
      // room for the verdict. A refusal is not an attempt and must not invent a usage row.
      const crossing = budgetGate(what, isChairman ? projection : sumProjections(projection, chairmanCall()));
      if (crossing) return { ok: false, text: '', usage: { ...EMPTY_USAGE }, reported: false,
        error: budgetRefusal(crossing, action), kind: 'budget',
        fresh: !resumes || seat.sessionId == null, attemptId: null };
      if (!isChairman) {
        const cap = seatCap(seat), spent = seatSpent(seat), next = projection[seat.vendor]?.tokens || 0;
        if (cap > 0 && (spent.unknown || spent.tokens + next > cap)) {
          const info = { kind: spent.unknown ? 'seat-tokens-unknown' : 'seat-tokens', vendor: seat.vendor, seat: seat.id, spent: spent.tokens, projected: next, cap, what,
            ...(spent.unknown ? { cause: spent.unknownCause } : {}) };
          record({ type: 'budget', ...info }); fire('budget', info);
          return { ok: false, text: '', usage: { ...EMPTY_USAGE }, reported: false, kind: 'budget',
            error: spent.unknown ? unknownUsageMessage(spent.unknownCause)
              : `${action} was not run: ${seat.lens} would pass its ${cap.toLocaleString('en')}-token cap for this review`,
            fresh: !resumes || seat.sessionId == null, attemptId: null };
        }
      }
      const attemptId = newId();
      reserved.set(attemptId, projection);
      record({ type: 'attempt-start', attemptId, round, kind, seat: pub(seat), fresh: !resumes || seat.sessionId == null });
      const res = await callOnce(seat, prompt, kind === 'research');
      const attempt = { type: 'attempt', attemptId, round, kind, seat: pub(seat), fresh: res.fresh, usage: res.reported ? res.usage : null,
        ...(res.progress ? { progress: res.progress } : {}), ...(res.systemCode ? { systemCode: res.systemCode } : {}),
        ...(res.reported ? {} : { unknown: true, ms: res.usage.ms,
          ...(res.usage.cost != null ? { cost: res.usage.cost } : {}), ...(res.usage.raw?.cost != null ? { rawCost: res.usage.raw.cost } : {}) }),
        ...(res.ok ? {} : { errorKind: res.kind, ...(res.cancelReason ? { cancelReason: res.cancelReason } : {}) }) };
      ledger.push(attempt);
      reserved.delete(attemptId);
      record(attempt);
      fire('attempt', attempt);
      checkInterrupted();
      if (!res.ok && POOL_FATAL.has(res.kind)) markDown(seat, res);
      if (kind !== 'research' && !res.ok && res.kind === 'network' && attemptNo === 1 && !expired() && !stopRequested && !(finishRequested && !isChairman)) { await new Promise((r) => setTimeout(r, opts.networkRetryMs)); continue; }
      return { ...res, attemptId };
    }
  }

  async function callOnce(seat, prompt, researching = false) {
    const t0 = now();
    const cancellation = () => interruptRequested ? 'interrupted' : stopRequested ? 'human' : deadlineHit ? 'wall-clock' : finishRequested && seat.id !== 'chairman' ? 'finish' : null;
    const cancellationText = (reason) => reason === 'interrupted' ? 'interrupted by server shutdown' : reason === 'human' ? 'stopped by the user' : reason === 'finish' ? 'discussion ended for the verdict' : 'stopped: the wall clock ran out during the call';
    // Stateless: never hand the CLI a session to resume; the prompt is self-contained.
    const sessionId = resumes && !researching ? seat.sessionId : null;
    const accounting = (res) => {
      if (res.sessionId) seat.sessionId = res.sessionId;
      const rawCost = res.usage?.raw?.cost ?? res.rawCost;
      if (typeof rawCost === 'number') seat.lastRawCost = rawCost;
      return { ...EMPTY_USAGE, ...(res.usage || {}), cost: res.usage?.cost ?? res.cost ?? null,
        ...(!res.usage && rawCost != null ? { raw: { cost: rawCost } } : {}), ms: res.usage?.ms ?? res.ms ?? (now() - t0) };
    };
    try {
      // prevCost: the session's last cumulative cost reading, so a resumed call is charged only
      // its own part even after a server restart (adapters/common.js).
      const res = await runner(seat.vendor, prompt, sessionId, { timeoutMs: researching ? opts.research.timeoutMs : opts.callTimeoutMs,
        ...(researching ? { research: opts.research } : {}), signal: controller.signal, seat, model: seat.model, effort: seat.effort, allowLimitedIsolation: opts.allowLimitedIsolation === true, prevCost: sessionId ? seat.lastRawCost : undefined });
      const usage = accounting(res);
      if (res.usedTools) {
        seat.sessionId = null;
        return { ok: false, text: '', usage, reported: !!res.usage, progress: safeProgress(res.progress), usedTools: true, kind: 'policy', error: 'Provider reported prohibited tool activity. This seat is stopped for the review.', fresh: sessionId == null };
      }
      const cancelReason = cancellation();
      if (cancelReason) return { ok: false, text: '', usage, reported: !!res.usage, progress: safeProgress(res.progress), error: cancellationText(cancelReason), kind: 'killed', cancelReason, fresh: sessionId == null };
      return { ok: true, text: researching ? res.text || '' : filterReply(seat.mood, res.text || ''), usage, reported: !!res.usage, raw: res.raw,
        ...(researching ? { searches: res.research?.searches } : {}), progress: safeProgress(res.progress), fresh: sessionId == null, usedTools: !!res.usedTools };
    } catch (e) {
      const cancelReason = cancellation();
      const error = cancelReason ? cancellationText(cancelReason) : e.message;
      const kind = cancelReason ? 'killed' : e.kind || (e.code === 'TIMEOUT' ? 'timeout' : e.code === 'KILLED' ? 'killed' : 'other');
      // a failed call can still report what it cost (an error result); keep it in the ledger
      const usage = accounting(e);
      if (e.usedTools || e.kind === 'policy') seat.sessionId = null;
      return { ok: false, text: '', usage, reported: !!e.usage, error, progress: safeProgress(e.progress),
        ...(researching && Number.isInteger(e.research?.searches) && e.research.searches >= 0 && e.research.searches <= 9 ? { searches: e.research.searches } : {}),
        systemCode: ['TIMEOUT', 'KILLED', 'TOOL_POLICY', 'OUTPUT_LIMIT', 'PROVIDER_PROTOCOL', 'CLI_EXIT', 'ISOLATION_REQUIRED', 'RESEARCH_LIMIT', 'RESEARCH_INVALID', 'ENOENT', 'EACCES', 'EPERM'].includes(e.code) ? e.code : undefined,
        kind: e.usedTools ? 'policy' : kind, usedTools: !!e.usedTools, cancelReason, resetsAt: e.resetsAt || null, timedOut: !cancelReason && e.code === 'TIMEOUT', fresh: sessionId == null };
    }
  }

  const oneCall = (seat, round) => projectRound({ seats: [seat], round, baselines,
    memory: resumes && seat.sessionId != null ? 'resume' : 'stateless', researchTokens: researchInputTokens(fieldNotes.research || []) });
  const chairmanCall = (chairman = state.chairman) => projectChairman({ chairman, baselines, researchTokens: researchInputTokens(fieldNotes.research || []) });

  // A seat's connection state, as the board shows it: idle, thinking, replied, reprompted,
  // failed, timed-out. Emitted here so the UI only renders.
  const seatState = (seat, round, state) => fire('seat-state', { round, seat: pub(seat), state });

  // every note given before `round`, as { round, text, source }
  const initialNotes = () => state.initialNotes.map((note) => ({ round: -1, ...noteRecord(note) }));
  const allNotes = (round) => [...initialNotes(), ...state.humanNotes.slice(0, round).flatMap((ns, r) => (ns || []).map((note) => ({ round: r, ...noteRecord(note) })))];

  const unattended = !!opts.unattended;
  const prefixFor = (seat) => statelessPrefix({ fieldNotes, lens: seat.lens, mood: seat.mood, seatCount: state.seats.length, unattended });

  // One seat's turn in a round: call, validate, re-prompt once on violation. In stateless mode
  // the re-prompt carries the offending reply, since there is no thread to point back at.
  // Tool activity is already rejected at the call boundary. Only format errors get a repair.
  function check(res, round, seat) {
    if (!res.ok) return { ok: false, errors: [res.error], parsed: null, tools: false };
    // a hidden mood is in it for the joke: keep its whole rant, and read a missing AGREE_WITH line as
    // agreeing with nobody instead of paying for a re-prompt
    const v = validateReply(res.text, { options: fieldNotes.options, round, trim: !seat?.mood?.hidden, requireAgree: !seat?.mood?.hidden });
    return { ...v, tools: false };
  }

  async function seatTurn(seat, prompt, round) {
    fire('seat-start', { round, seat: pub(seat) });
    seatState(seat, round, 'thinking');
    let res = await callSeat(seat, prompt, round, 'reply', oneCall(seat, round));
    let v = check(res, round, seat);
    let reprompted = false;
    if (res.ok && !v.ok) {
      let crossing;
      reprompted = true;
      record({ type: 'reprompt', round, seat: pub(seat), errors: v.errors, text: res.text, attemptId: res.attemptId, usedTools: res.usedTools });
      fire('reprompt', { round, seat: pub(seat), errors: v.errors, usedTools: res.usedTools, attemptId: res.attemptId });
      // The re-prompt is a call like any other: it must fit the cap with everything in flight and
      // the chairman still affordable. Refused, the seat fails for this round.
      if (expired()) {
        res = { ...res, ok: false, error: 'the wall clock ran out before the re-prompt', kind: 'killed', cancelReason: 'wall-clock' };
        v = { ok: false, errors: [res.error], parsed: null, tools: false };
      } else if ((crossing = budgetGate(`re-prompt of ${seat.lens}`, sumProjections(oneCall(seat, round), chairmanCall())))) {
        res = { ...res, ok: false, error: budgetRefusal(crossing, 're-prompt'), kind: 'budget' };
        v = { ok: false, errors: [res.error], parsed: null, tools: false };
      } else {
        seatState(seat, round, 'reprompted');
        const extra = [];
        const again = resumes && seat.sessionId ? repromptText(v.errors, fieldNotes.options, extra, unattended)
          : statelessRepromptText({ prefix: prefixFor(seat), round, maxRound, text: res.text, errors: v.errors, extra, notes: allNotes(round) });
        const res2 = await callSeat(seat, again, round, 'reprompt', oneCall(seat, round));
        res = { ...res2, fresh: res.fresh, usedTools: res.usedTools || res2.usedTools };
        v = check(res2, round, seat);
      }
    }
    const parsed = v.parsed || { pass: false, stance: null, stanceKey: null, agreeWith: [], disagree: [], new: [], assumptions: [], question: null };
    const reply = {
      round, seat: pub(seat), text: res.text, parsed, valid: v.ok, errors: v.ok ? [] : v.errors,
      ...(res.progress ? { progress: res.progress } : {}),
      stanceKey: v.ok ? parsed.stanceKey : (res.ok ? 'other: unparsed' : 'other: no reply'),
      question: v.ok ? parsed.question : null, attemptId: res.attemptId, reprompted, failed: !res.ok,
      ...(res.ok ? {} : { errorKind: res.kind || 'other', resetsAt: res.resetsAt || null, skipped: !!res.skipped, ...(res.cancelReason ? { cancelReason: res.cancelReason } : {}) }),
      // fresh: the first call of the turn had no session to resume (estimate.js baselines
      // keep fresh and resumed calls apart). sessionId: what the CLI reported, for a resume.
      fresh: res.fresh, sessionId: seat.sessionId || null,
      timedOut: !!res.timedOut, usedTools: !!res.usedTools, toolFail: res.kind === 'policy',
      state: !res.ok ? (res.timedOut ? 'timed-out' : POOL_FATAL.has(res.kind) ? 'down' : 'failed') : (reprompted ? 'reprompted' : 'replied'),
    };
    record({ type: 'reply', ...reply, raw: undefined });
    fire('reply', reply);
    seatState(seat, round, reply.state);
    return reply;
  }

  async function runRound(round) {
    state.round = round;
    fire('round-start', { round });
    // every note so far for a stateless call; only the notes since the last round for a resumed
    // thread, which already holds the older ones
    const notesSince = (from) => state.humanNotes.slice(from, round).flatMap((ns, r) => (ns || []).map((note) => ({ round: from + r, ...noteRecord(note) })));
    const notes = resumes ? notesSince(Math.max(0, round - 1)) : [...initialNotes(), ...notesSince(0)];
    const prev = state.rounds[round - 1] || [];
    pendingTurns = state.seats.map((seat) => {
      const others = prev.filter((r) => r.seat.index !== seat.index).map((r) => ({ lens: r.seat.lens, text: evidence(r) }));
      const prompt = round === 0
        ? round0Prompt({ fieldNotes, lens: seat.lens, mood: seat.mood, seatCount: state.seats.length, notes: initialNotes(), unattended })
        : resumes
          ? seat.sessionId
            ? roundPrompt({ round, maxRound, others, notes, options: fieldNotes.options, mood: seat.mood, unattended })
            : recoveryPrompt({ prefix: prefixFor(seat), round, maxRound, rounds: state.rounds.map((rs) => rs.map((r) => ({ ...r, text: evidence(r) }))), notes: allNotes(round) })
          : statelessRoundPrompt({ prefix: prefixFor(seat), round, maxRound, own: evidence(prev.find((r) => r.seat.index === seat.index)), others, notes });
      return seatTurn(seat, prompt, round);
    });
    const replies = await Promise.all(pendingTurns);
    state.rounds[round] = replies;
    fire('round-done', { round, replies, stop: stopCheck(round), positions: positions(replies) });
    return replies;
  }

  function stopCheck(round) {
    if (expired()) return 'wall-clock';
    const all = state.rounds[round];
    const live = all.filter((r) => !r.failed);
    if (live.length === 0) return 'all-failed';
    // A seat whose login is out for the whole debate (quota, login, missing CLI) has left the table:
    // waiting for it would block consensus forever and spend every remaining round. Fewer than two
    // seats left is no debate: stop and let the chairman write from what was said.
    const out = (r) => r.failed && (state.down[downKey(r.seat)] || policyBlocked(r.seat));
    const replies = all.filter((r) => !out(r));
    if (replies.length < 2) return 'seats-down';
    // PASS and consensus need every remaining seat present: a seat whose call failed this round
    // (a timeout, a network failure) must not make agreement easier.
    const allPresent = live.length === replies.length;
    if (allPresent && live.every((r) => r.stanceKey === 'PASS')) return 'all-pass';
    const stances = new Set(live.map((r) => r.stanceKey));
    if (allPresent && stances.size === 1 && !stances.has('PASS') && ![...stances][0].startsWith('other: ')) return 'consensus';
    if (allPresent && round > 0 && isStable(replies, state.rounds[round - 1])) return 'stable';
    if (round >= maxRound) return 'round-cap';
    if (expired()) return 'wall-clock';
    return null;
  }

  // A critique round moved nothing: every seat holds the stance it had the round before (a PASS
  // holds it too) and nobody put anything NEW on the table. Another round would only repeat.
  function isStable(replies, prev) {
    if (!prev?.length) return false;
    return replies.every((r) => {
      if (!r.valid || r.failed) return false;
      const before = prev.find((p) => p.seat.index === r.seat.index);
      if (!before || before.failed || !before.valid) return false;
      if (r.stanceKey === 'PASS') return true;
      const held = r.stanceKey === (before.stanceKey === 'PASS' ? lastStance(r.seat.index, round0Of(prev)) : before.stanceKey);
      const nothingNew = !r.parsed.new.length || r.parsed.new.every((n) => /^none\.?$/i.test(n.trim()));
      return held && nothingNew;
    });
  }
  // The last named stance a seat took before `upTo` rounds (a run of PASSes holds the earlier one).
  function round0Of(prev) { return state.rounds.indexOf(prev); }
  function lastStance(index, upTo) {
    for (let i = upTo; i >= 0; i--) {
      const r = state.rounds[i]?.find((p) => p.seat.index === index);
      if (r && r.valid && !r.failed && r.stanceKey !== 'PASS') return r.stanceKey;
    }
    return null;
  }

  async function humanGate(round, stop = null) {
    // seat: for the human's side only; what goes back to the seats names the lens (review-view.js)
    const questions = state.rounds[round].filter((r) => r.question).map((r) => ({ lens: r.seat.lens, seat: r.seat.id, question: r.question }));
    const blocking = round === 0 || questions.length > 0;
    const reopenable = round === 0 && stop === 'consensus' && round < maxRound;
    const info = { round, mode: blocking ? 'blocking' : 'countdown', reason: round === 0 ? 'round0' : (questions.length ? 'question' : 'auto'), questions, autoContinueMs: opts.autoContinueMs, stop, reopenable };
    // Nobody is at the table: no pause, no answers. The seats were told to assume instead of ask;
    // a question a seat wrote anyway stays on its card, unanswered.
    if (unattended) { fire('gate-skipped', { round, questions }); return null; }
    state.status = 'waiting';
    fire('gate', { ...info, deadlineAt });
    checkInterrupted();
    // A gate nobody answers ends at the deadline (the server then closes its own side).
    // (not unref'd: an unref'd timer as the only pending work ends the event loop on Node 22,
    // and a test or a headless run then dies with "Promise resolution is still pending"; the
    // timer is cleared below, so nothing keeps a finished debate alive)
    let timer;
    const atDeadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ action: 'stop', reason: 'wall-clock' }), Math.max(0, (deadlineAt ?? Infinity) - now())); });
    const answer = (await Promise.race([gate(info), atDeadline, interruption])) || { action: 'continue' };
    clearTimeout(timer);
    checkInterrupted();
    if (answer.reason === 'wall-clock') {
      // Gate expiry is final even when the overall deadline timer has not fired yet.
      deadlineHit = true;
      state.status = 'running'; state.stopContext = 'waiting';
      record({ type: 'gate-expired', round }); fire('gate-expired', { round }); return 'wall-clock';
    }
    state.status = 'running';
    const message = (answer.message || '').trim();
    if (answer.action === 'stop' || /^\/stop\b/i.test(message)) { requestStop(message, answer.source); return 'human'; }
    if (answer.action === 'finish') {
      if (requestFinish(message, answer.source)) return 'finish';
      requestStop(message, answer.source); return 'human';
    }
    saveHumanNote(round, message, answer.source);
    return null;
  }

  // The chairman's login is out (quota, logged out, missing) or goes out on its call: another
  // vendor seated at this table and not out writes the verdict instead, at its default model and
  // effort, once. The board is told which and why; the record keeps the fallback chairman.
  function fallbackChairman(from) {
    const tried = new Set([`${from.vendor}@${from.account || ''}`]);
    const seat = state.seats.find((s) => !tried.has(`${s.vendor}@${s.account || ''}`) && !state.down[downKey(s)] && !policyBlocked(s) && s.vendor !== from.vendor);
    return seat ? { vendor: seat.vendor, account: seat.account, colour: seat.colour, model: seat.endpoint ? seat.model : undefined, effort: undefined, ...(seat.endpoint ? { endpoint: seat.endpoint, keyEnv: seat.keyEnv } : {}) } : null;
  }

  async function verdict(chair = state.chairman, { fallenFrom = null } = {}) {
    if (stopRequested) { skipVerdict('you stopped the review', 'human'); return; }
    if (!hasUsableRound(state.rounds, state.seats.length)) { skipVerdict('no usable replies were collected', 'no-round'); return; }
    if (finishRequested && controller.signal.aborted && !expired()) controller = new AbortController();
    writingVerdict = true;
    const seat = { id: 'chairman', vendor: chair.vendor, lens: 'chairman', colour: chair.colour || 'ink', index: -1, sessionId: null, model: chair.model, effort: chair.effort, account: chair.account, ...(chair.endpoint ? { endpoint: chair.endpoint, keyEnv: chair.keyEnv } : {}) };
    if (state.down[downKey(seat)] && !fallenFrom) {
      const next = fallbackChairman(seat);
      if (next) { record({ type: 'chairman-fallback', from: pub(seat), to: next.vendor, reason: state.down[downKey(seat)].message }); fire('chairman-fallback', { from: pub(seat), to: next.vendor, reason: state.down[downKey(seat)].message }); return verdict(next, { fallenFrom: seat }); }
    }
    fire('chairman-start', { seat: pub(seat) });
    const prompt = chairmanPrompt({
      fieldNotes,
      rounds: state.rounds.map((r) => r.map((x) => ({ lens: x.seat.lens, text: evidence(x) }))),
      humanNotes: state.humanNotes, initialNotes: state.initialNotes, unattended,
    });
    const R = state.rounds.length;
    // The verdict is checked like a reply: the tool guard and its grammar (contract.validateVerdict).
    const checkVerdict = (res) => {
      const v = validateVerdict(res.text, fieldNotes.options);
      return v;
    };
    let res = await callSeat(seat, prompt, R, 'verdict', chairmanCall(seat), { isChairman: true });
    if (stopRequested) { skipVerdict('you stopped the review', 'human'); return; }
    let v = res.ok ? checkVerdict(res) : { ok: false, errors: [res.error] };
    if (res.ok && !v.ok) {
      record({ type: 'reprompt', round: R, seat: pub(seat), errors: v.errors, text: res.text, attemptId: res.attemptId, usedTools: res.usedTools });
      fire('reprompt', { round: R, seat: pub(seat), errors: v.errors, usedTools: res.usedTools, attemptId: res.attemptId });
      const first = res;
      let crossing;
      if (!synthesisOnly && expired()) v = { ok: false, errors: ['the wall clock ran out before the re-prompt'] };
      else if ((crossing = budgetGate('re-prompt of the chairman', chairmanCall(seat)))) v = { ok: false, errors: [budgetRefusal(crossing, 're-prompt')] };
      else {
        // nothing to reformat (not even a recommendation) and no session holding the first prompt:
        // send the whole prompt again, or the chairman cannot know the question at all
        const lost = v.errors.some((e) => /missing RECOMMENDATION/.test(e));
        const context = lost && !resumes ? prompt : null;
        res = await callSeat(seat, verdictRepromptText({ options: fieldNotes.options, text: first.text, errors: v.errors, context }), R, 'reprompt', chairmanCall(seat), { isChairman: true });
        v = res.ok ? checkVerdict(res) : { ok: false, errors: [res.error] };
      }
      if (!v.ok && !res.ok && res.kind !== 'policy') res = { ...first, ok: true }; // keep the chairman's own text as the diagnostic
    }
    if (stopRequested) { skipVerdict('you stopped the review', 'human'); return; }
    // its login went out on this very call: hand the verdict to another vendor, once
    if (!res.ok && POOL_FATAL.has(res.kind) && !fallenFrom) {
      const next = fallbackChairman(seat);
      if (next) { record({ type: 'chairman-fallback', from: pub(seat), to: next.vendor, reason: res.error }); fire('chairman-fallback', { from: pub(seat), to: next.vendor, reason: res.error }); return verdict(next, { fallenFrom: seat }); }
    }
    if (!res.ok && res.kind === 'budget') { skipVerdict(res.error, 'budget'); return; }
    const failed = !res.ok || !v.ok;
    const text = res.ok ? res.text : `Chairman failed: ${res.error}`;
    const errorKind = failed ? (res.ok ? 'format' : res.kind || 'other') : null;
    state.verdict = { text, attemptId: res.attemptId, seat: pub(seat), failed, ...(res.progress ? { progress: res.progress } : {}), ...(failed ? { errors: v.errors, errorKind, ...(res.cancelReason ? { cancelReason: res.cancelReason } : {}) } : {}) };
    record({ type: 'verdict', ...state.verdict });
    store?.writeVerdict?.(text, { decision: fieldNotes.decision, chairman: seat.vendor, rounds: state.rounds.length, stopReason: state.stopReason });
    fire('verdict', state.verdict);
  }

  const usageUnknown = (usage) => !usage || (usage.tokenCoverage && usage.tokenCoverage.reported < usage.tokenCoverage.of);

  // Spend so far per vendor, in the units the budget speaks: tokens (prompt, cache and output
  // together) and the CLI's own dollar figure where it reports one; `costUnknown` when any
  // attempt's cost is not known. Calls in flight count at their reservation.
  function spentByVendor() {
    const out = {};
    const at = (vendor) => (out[vendor] ??= { tokens: 0, cost: 0, costUnknown: false, tokensUnknown: false });
    for (const e of ledger) {
      const v = at(e.seat.vendor);
      if (usageUnknown(e.usage)) v.tokensUnknown = true;
      if (e.usage) v.tokens += (e.usage.input || 0) + (e.usage.cacheRead || 0) + (e.usage.cacheWrite || 0) + (e.usage.output || 0);
      const cost = e.usage?.cost ?? e.cost;
      if (cost == null) v.costUnknown = true; else v.cost += cost;
    }
    for (const projection of reserved.values()) for (const [vendor, p] of Object.entries(projection)) {
      const v = at(vendor);
      v.tokens += p.tokens || 0;
      if (p.cost == null) v.costUnknown = true; else v.cost += p.cost;
    }
    return out;
  }

  // One seat's spend in this review, counted like the vendor budget counts it.
  const seatCap = (seat) => (seat.mood?.hidden ? opts.hiddenSeatTokenCap : opts.seatTokenCap) ?? 0;
  function seatSpent(seat) {
    let tokens = 0, unknown = false, unknownCause;
    for (const e of ledger) {
      const same = e.seat?.id ? e.seat.id === seat.id : e.seat?.vendor === seat.vendor && e.seat?.lens === seat.lens;
      if (!same) continue;
      if (usageUnknown(e.usage)) { unknown = true; unknownCause = e.errorKind || 'unreported'; }
      if (e.usage) tokens += (e.usage.input || 0) + (e.usage.cacheRead || 0) + (e.usage.cacheWrite || 0) + (e.usage.output || 0);
    }
    return { tokens, unknown, unknownCause };
  }

  // null when the next call fits every cap; otherwise the crossing, recorded and emitted.
  function budgetGate(what, next) {
    if (!Object.keys(opts.budget || {}).length) return null;
    const crossing = budgetCheck(opts.budget, spentByVendor(), next);
    if (!crossing) return null;
    const info = { ...crossing, what };
    record({ type: 'budget', ...info });
    fire('budget', info);
    return info;
  }

  function budgetRefusal(crossing, action) {
    if (crossing.kind === 'tokens-unknown') return `${action} was not run: ${crossing.vendor} token usage is unknown, so further calls under its token cap are blocked`;
    return `${action} would cross the ${crossing.vendor} budget`;
  }

  // After an interruption the last complete round may already have met a stop condition (the
  // engine died at its gate or during the verdict): apply the same rules as the live loop,
  // including the deferred consensus at a round 0 that has a note.
  function stopAfterResume(last) {
    let stop = stopCheck(last);
    if (last === 0 && stop === 'consensus' && state.humanNotes[0]?.length && last < maxRound) stop = null;
    return stop;
  }

  // A verdict not written, with the reason; replay and the board treat it as synthesis skipped.
  function skipVerdict(why, reason) {
    state.verdict = { text: `Verdict not written: ${why}.`, usage: null, seat: null, failed: true, skipped: true, reason };
    record({ type: 'verdict', seat: null, text: state.verdict.text, usage: null, skipped: true, reason });
    fire('verdict', state.verdict);
  }

  async function collectResearch() {
    if (!opts.research) return true;
    if (state.research?.status === 'done') {
      // A completed, saved bundle is reused verbatim; recovering never refetches sources.
      fieldNotes = { ...fieldNotes, research: state.research.sources };
      state.fieldNotes = fieldNotes;
      return true;
    }
    let result;
    if (resume) result = { ok: false, error: 'Research was interrupted before a usable source bundle was saved. It was not rerun. Check provider usage before starting a new review.', kind: 'interrupted' };
    else {
      state.status = 'researching';
      state.research = { status: 'running', maxSearches: opts.research.maxSearches, timeoutMs: opts.research.timeoutMs };
      record({ type: 'research-start', ...state.research }); fire('research', state.research);
      // the searcher: its own model, effort and login profile from the research settings
      const { model, effort, account } = opts.research;
      const seat = { id: 'research', index: -2, vendor: 'codex', label: 'Searcher', lens: 'searcher', model, effort, account };
      result = await callSeat(seat, researchPrompt(opts.research), -1, 'research', chairmanCall(seat), { isChairman: true });
    }
    if (result.ok) {
      try {
        if (!Number.isInteger(result.searches) || result.searches < 1 || result.searches > opts.research.maxSearches) throw new Error('Research did not report a usable search-operation count.');
        const gatheredAt = new Date(now()).toISOString();
        state.research = { status: 'done', sources: researchSources(result.text, gatheredAt), gatheredAt, searches: result.searches, attemptId: result.attemptId };
        fieldNotes = { ...fieldNotes, research: state.research.sources }; state.fieldNotes = fieldNotes;
        record({ type: 'research', ...state.research });
        store?.writeFieldNotes?.(fieldNotes, state.seats);
        fire('research', state.research);
        state.status = 'running';
        return true;
      } catch (e) { result = { ...result, ok: false, kind: 'format', error: e.message }; }
    }
    state.research = { status: 'failed', error: result.error, errorKind: result.kind, attemptId: result.attemptId, progress: result.progress, searches: result.searches };
    record({ type: 'research', ...state.research }); fire('research', state.research);
    state.stopReason = stopRequested ? 'human' : expired() ? 'wall-clock' : 'research-failed';
    return false;
  }

  async function run() {
    state.status = 'running';
    state.startedAt = now();
    deadlineAt = resume?.deadlineAt ?? state.startedAt + opts.wallClockMs;
    state.deadlineAt = deadlineAt;
    // At the deadline the calls in flight are stopped; each fails for its round.
    const deadlineTimer = setTimeout(() => { deadlineHit = true; if (state.status !== 'done') { controller.abort(); cancel('wall-clock'); } }, Math.max(0, deadlineAt - now()));
    try { return await runInner(); }
    catch (error) {
      state.status = interruptRequested ? 'interrupted' : 'error';
      if (!controller.signal.aborted) { controller.abort(); cancel('error'); }
      // A caller may rebuild/resume after this rejects. Let all cancelled turns finish their
      // accounting first, so an old turn cannot append into the newly resumed review.
      await Promise.allSettled(pendingTurns);
      if (error.code === 'INTERRUPTED') return state;
      throw error;
    } finally { clearTimeout(deadlineTimer); }
  }

  async function runInner() {
    let from = 0;
    if (synthesisOnly) {
      state.rounds = resume.rounds.map((r) => r.slice());
      state.humanNotes = (resume.humanNotes || []).map((ns) => (ns == null ? ns : typeof ns === 'string' ? [ns] : [...ns]));
      ledger.push(...(resume.ledger || []));
      state.stopReason = resume.stopReason ?? null;
      record({ type: 'synthesize', stopReason: state.stopReason });
      fire('synthesize', { stopReason: state.stopReason });
      if (opts.research && state.research?.status !== 'done') {
        skipVerdict('the saved research bundle is unavailable; restore it before requesting a verdict', 'research');
        state.status = 'done';
        fire('done', { reason: state.stopReason, synthesis: synthesisOf(state.verdict), cancelled: stopRequested });
        return state;
      }
      // The chairman alone, under the budget; its own call timeout is its time bound.
      const crossing = budgetGate('verdict', chairmanCall());
      if (!crossing) await verdict(); else skipVerdict(budgetRefusal(crossing, 'verdict'), 'budget');
      state.status = 'done';
      fire('done', { reason: state.stopReason, synthesis: synthesisOf(state.verdict), cancelled: stopRequested });
      return state;
    }
    if (resume) {
      state.rounds = resume.rounds.map((r) => r.slice());
      // a round's notes are a list; a lone string (the 0.2.0 shape) is one note
      state.humanNotes = (resume.humanNotes || []).map((ns) => (ns == null ? ns : typeof ns === 'string' ? [ns] : [...ns]));
      ledger.push(...(resume.ledger || []));
      from = state.rounds.length;
      record({ type: 'resumed', from, seats: state.seats.map(pub), deadlineAt });
      fire('resumed', { from, seats: state.seats.map(pub), fieldNotes, options: opts, deadlineAt });
    } else {
      record({ type: 'field-notes', schemaVersion: 3, ...provenance, fieldNotes, seats: state.seats.map(pub), chairman: state.chairman, options: opts, deadlineAt });
      store?.writeFieldNotes?.(fieldNotes, state.seats);
      fire('started', { seats: state.seats.map(pub), fieldNotes, options: opts, chairman: state.chairman, deadlineAt });
    }
    try {
      const researchReady = opts.research ? await collectResearch() : true;
      const carried = researchReady && from > 0 ? stopAfterResume(from - 1) : null;
      if (carried) state.stopReason = carried;
      for (let round = from; researchReady && !carried && round <= maxRound; round++) {
        if (expired()) { state.stopReason = 'wall-clock'; break; }
        // A round is admitted only if the verdict after it is still affordable.
        const over = budgetGate(`round ${round}`, sumProjections(...state.seats.map((seat) => oneCall(seat, round)), chairmanCall()));
        if (over) { state.stopReason = 'budget'; break; }
        await runRound(round);
        if (stopRequested) { state.stopReason = 'human'; break; }
        if (finishRequested) { state.stopReason = 'finish'; break; }
        let stop = stopCheck(round);
        // Round 0 always shows the blind positions and waits, even when a stop condition is met.
        if (!expired() && (round === 0 || !stop || state.rounds[round].some((r) => r.question))) {
          const humanStop = await humanGate(round, stop);
          if (humanStop) { state.stopReason = humanStop; break; }
          // A note at a unanimous round 0 is meant for the seats, not just the chairman: defer the
          // consensus stop so round 1 runs with the note. Round 1 then stops or continues as usual.
          if (round === 0 && stop === 'consensus' && state.humanNotes[0]?.length && round < maxRound) {
            record({ type: 'reopen', round, stop });
            fire('reopen', { round, stop });
            stop = null;
          }
        }
        if (stop) { state.stopReason = stop; break; }
      }
      record({ type: 'stop', reason: state.stopReason, rounds: state.rounds.length, ...(state.stopContext ? { context: state.stopContext } : {}) });
      fire('stopped', { reason: state.stopReason, rounds: state.rounds.length, context: state.stopContext });
      // The verdict is under the cap and the wall clock too. A verdict skipped for either can be
      // written later, on request, through POST .../synthesize.
      if (stopRequested || state.stopReason === 'human') skipVerdict('you stopped the review', 'human');
      else if (!researchReady) skipVerdict('research did not finish; discussion was not started', 'research');
      else if (!state.rounds.length) skipVerdict('no round ran', 'no-round');
      else if (expired()) skipVerdict('the wall clock ran out', 'wall-clock');
      else {
        const crossing = budgetGate('verdict', chairmanCall());
        if (crossing) skipVerdict(budgetRefusal(crossing, 'verdict'), 'budget');
        else await verdict();
      }
      state.status = 'done';
      fire('done', { reason: state.stopReason, synthesis: synthesisOf(state.verdict), cancelled: stopRequested });
    } catch (e) {
      if (e.code === 'INTERRUPTED') throw e;
      state.status = 'error';
      record({ type: 'error', message: e.message });
      fire('error', { message: e.message });
      throw e;
    }
    return state;
  }

  return { state, run, requestStop, requestFinish, requestInterrupt, canFinish };
}

// What leaves the engine about a seat (events, transcript). Vendor and label are for the human
// side; prompts never carry them.
function pub(seat) {
  return { id: seat.id, vendor: seat.vendor, label: seat.label, lens: seat.lens, colour: seat.colour, index: seat.index, model: seat.model, effort: seat.effort, mood: seat.mood, account: seat.account, ...(seat.endpoint ? { endpoint: seat.endpoint, keyEnv: seat.keyEnv } : {}) };
}

// Where each seat stands relative to the round's majority stance, for the card and strip tints:
//   agreed     on the stance most seats took (a strict plurality among the named options)
//   disagreed  on another named option
//   neutral    an "other:" stance, or any named option when no stance has a strict plurality
//   passed     PASS
//   null       no valid reply (failed, timed out, off contract)
// Pure, so the transcript rebuild computes the same thing. Returns { [seatId]: state }.
// Whether the verdict was written: 'done', 'skipped' (budget, wall clock, no round), 'failed'
// (the chairman's reply never met the grammar), or 'missing' (the debate died before it).
export function synthesisOf(verdict) {
  if (!verdict) return 'missing';
  return verdict.skipped ? 'skipped' : verdict.failed ? 'failed' : 'done';
}

export function hasUsableRound(rounds, seatCount) {
  return rounds.some((round) => round?.length === seatCount && round.some((r) => r.valid && !r.failed && !r.usedTools && !r.toolFail && !r.parsed?.pass));
}

export function positions(replies) {
  const count = {};
  for (const r of replies) if (r.valid && !r.failed && r.stanceKey && r.stanceKey !== 'PASS' && !r.stanceKey.startsWith('other: ')) count[r.stanceKey] = (count[r.stanceKey] || 0) + 1;
  const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
  const majority = sorted.length && (sorted.length === 1 || sorted[0][1] > sorted[1][1]) ? sorted[0][0] : null;
  const out = {};
  for (const r of replies) {
    const id = r.seat?.id ?? `${r.seat?.vendor}:${r.seat?.lens}`;
    if (!r.valid || r.failed || !r.stanceKey) out[id] = null;
    else if (r.stanceKey === 'PASS') out[id] = 'passed';
    else if (r.stanceKey.startsWith('other: ')) out[id] = 'neutral';
    else if (!majority) out[id] = 'neutral';
    else out[id] = r.stanceKey === majority ? 'agreed' : 'disagreed';
  }
  return out;
}

// Sum reported figures. Coverage distinguishes missing measurements from measured zeros,
// for tokens and dollars independently; renderers must label incomplete totals.
export function addUsage(a, b) {
  const sum = (k) => (a?.[k] || 0) + (b?.[k] || 0);
  const cost = a?.cost == null && b?.cost == null ? null : (a?.cost || 0) + (b?.cost || 0);
  const cov = (u) => u?.costCoverage || (u ? { reported: u.cost == null ? 0 : 1, of: 1 } : { reported: 0, of: 0 });
  const ca = cov(a), cb = cov(b);
  const tokens = (u) => u?.tokenCoverage || { reported: u ? 1 : 0, of: u ? 1 : 0 };
  const ta = tokens(a), tb = tokens(b);
  const usageVersion = a?.usageVersion ?? b?.usageVersion;
  return { input: sum('input'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), output: sum('output'), thinking: sum('thinking'), cost, ms: sum('ms'),
    costCoverage: { reported: ca.reported + cb.reported, of: ca.of + cb.of },
    tokenCoverage: { reported: ta.reported + tb.reported, of: ta.of + tb.of }, ...(usageVersion ? { usageVersion } : {}) };
}

export function sumProjections(...ps) {
  const out = {};
  for (const p of ps) for (const [vendor, x] of Object.entries(p || {})) {
    const v = (out[vendor] ??= { tokens: 0, cost: 0 });
    v.tokens += x.tokens || 0;
    v.cost = v.cost == null || x.cost == null ? null : v.cost + x.cost;
  }
  return out;
}

// The spend ledger of a list of rows (a transcript, or the board's events): one entry per call.
// `attempt` rows are the ledger itself. Rows that name an attempt are descriptions and add
// nothing. Rows from before the ledger (no attemptId anywhere): a reply or verdict carries the
// whole turn, retries included; a reprompt counts only when its turn never got a reply (the
// debate was cut off between the two calls).
export function ledgerEntries(rows) {
  const out = [];
  const settled = new Set(rows.filter((r) => r.type === 'attempt' && r.attemptId).map((r) => r.attemptId));
  const replied = new Set(rows.filter((r) => r.type === 'reply' && !r.attemptId).map((r) => `${r.round}:${r.seat?.id || `${r.seat?.vendor}:${r.seat?.lens}`}`));
  for (const r of rows) {
    if (r.type === 'attempt-start') {
      if (!settled.has(r.attemptId)) out.push({ ...r, type: 'attempt', usage: null, unknown: true, errorKind: 'interrupted' });
      continue;
    }
    if (r.type === 'attempt') { out.push(r); continue; }
    if (r.attemptId || !r.usage) continue;
    if (r.type === 'reply' || r.type === 'verdict') out.push({ ...r, kind: r.type });
    else if (r.type === 'reprompt' && !replied.has(`${r.round}:${r.seat?.id || `${r.seat?.vendor}:${r.seat?.lens}`}`)) out.push({ ...r, kind: 'reprompt' });
  }
  return out;
}

// Roll the ledger up per seat (by instance id), per round, and in total. Used by the usage strip
// and the decision record. bySeat[id] = { seat, usage }; rows older than schemaVersion 2 fall
// back to vendor:lens. unknownAttempts: calls that ended without a usage report.
export function rollup(rows) {
  const bySeat = {}, byRound = {}, bySeatRound = {};
  let total = null; // not a zero row: costCoverage counts only real calls
  let unknownAttempts = 0;
  for (const r of ledgerEntries(rows)) {
    if (!r.usage) unknownAttempts++;
    const usage = r.usage || { ...EMPTY_USAGE, cost: r.cost ?? null, ms: r.ms || 0, tokenCoverage: { reported: 0, of: 1 } };
    const key = r.seat ? (r.seat.id || `${r.seat.vendor}:${r.seat.lens}`) : 'other';
    bySeat[key] = { seat: r.seat || null, usage: addUsage(bySeat[key]?.usage, usage) };
    const rk = ['verdict', 'research'].includes(r.kind) ? r.kind : String(r.round);
    byRound[rk] = addUsage(byRound[rk], usage);
    (bySeatRound[key] ??= {})[rk] = addUsage(bySeatRound[key][rk], usage); // one seat, one round
    total = addUsage(total, usage);
  }
  return { bySeat, byRound, bySeatRound, total: total ?? { ...EMPTY_USAGE }, unknownAttempts };
}
