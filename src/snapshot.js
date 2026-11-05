import { rollup, hasUsableRound, DEFAULTS } from './engine.js';
import { groupQuestions, stopExplanation, cancellationReason } from './review-view.js';
import { optionLabel, verdictSections } from './contract.js';
import { safeProgress } from './progress.js';
import { researchSources } from './research.js';

const RESEARCH_FAILURES = {
  timeout: 'Research did not finish before its time limit.',
  network: 'Research could not reach the provider.',
  quota: 'The research provider reported a usage limit.',
  auth: 'The research provider requires login.',
  missing: 'The research provider CLI was not found.',
  compatibility: 'The research provider does not support a required option.',
  budget: 'Research was blocked by a budget or operation limit.',
  policy: 'Research stopped after a provider-policy failure.',
  format: 'Research did not produce a valid source bundle.',
  killed: 'Research was cancelled.',
  interrupted: 'Research was interrupted and was not rerun.',
  other: 'Research failed. Open the board for details.',
};
const integerWithin = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// Project both live and saved research: failed transcript rows can contain arbitrary CLI text.
function researchSnapshot(research) {
  if (research.status === 'running') return { status: 'running',
    ...(integerWithin(research.maxSearches, 1, 8) ? { maxSearches: research.maxSearches } : {}),
    ...(integerWithin(research.timeoutMs, 30000, 600000) ? { timeoutMs: research.timeoutMs } : {}) };
  if (research.status === 'done') {
    try {
      const gatheredAt = new Date(research.gatheredAt).toISOString();
      if (gatheredAt !== research.gatheredAt || !integerWithin(research.searches, 1, 8)) throw new Error('invalid metadata');
      return { status: 'done', gatheredAt, searches: research.searches,
        sources: researchSources(JSON.stringify({ sources: research.sources }), gatheredAt) };
    } catch { return { status: 'failed', errorKind: 'format', error: RESEARCH_FAILURES.format }; }
  }
  const errorKind = research.status === 'interrupted' ? 'interrupted'
    : Object.hasOwn(RESEARCH_FAILURES, research.errorKind) ? research.errorKind : 'other';
  return { status: research.status === 'interrupted' ? 'interrupted' : 'failed', errorKind,
    error: RESEARCH_FAILURES[errorKind], progress: safeProgress(research.progress),
    ...(integerWithin(research.searches, 0, 9) ? { searches: research.searches } : {}) };
}

// Epoch milliseconds are easy to misread across time zones, so every deadline also carries an
// ISO timestamp and the whole seconds left, both taken when the snapshot is built.
export const clock = (name, at) => at == null ? {} : {
  [`${name}AtIso`]: new Date(at).toISOString(),
  [`secondsUntil${name[0].toUpperCase()}${name.slice(1)}`]: Math.max(0, Math.ceil((at - Date.now()) / 1000)),
};

// One compact, read-only view for local clients. Raw provider output and launch tokens stay out.
export function reviewSnapshot(d) {
  const state = d.debate?.state || d.rebuilt;
  const rounds = state.rounds || [];
  const lastRound = rounds.length - 1;
  const verdict = state.verdict;
  const status = d.interrupted ? 'interrupted' : d.finished ? 'done' : state.status === 'error' ? 'error' : d.pending ? 'waiting'
    : d.synthesizing || d.events.some((e) => e.type === 'stopped') && !d.finished ? 'verdict' : state.status || 'running';
  const gate = d.pending?.info;
  const sections = verdict && !verdict.failed && !verdict.skipped ? verdictSections(verdict.text) : null;
  const usage = rollup(d.events).total;
  return {
    schemaVersion: 1, id: d.slug, revision: `${d.gen}:${d.events.length - 1}`, status,
    decision: state.fieldNotes?.decision, options: state.fieldNotes?.options, round: state.round ?? lastRound,
    depth: { plannedCritiqueRounds: state.options?.critiqueRounds ?? DEFAULTS.critiqueRounds,
      attemptedRounds: rounds.filter((r) => r?.length === state.seats.length).length,
      attemptedCritiqueRounds: rounds.slice(1).filter((r) => r?.length === state.seats.length).length,
      completedRounds: rounds.filter((r) => hasUsableRound([r], state.seats.length)).length,
      completedCritiqueRounds: rounds.slice(1).filter((r) => hasUsableRound([r], state.seats.length)).length },
    deadlineAt: state.deadlineAt, ...clock('deadline', state.deadlineAt), stopReason: state.stopReason || null,
    ...(state.research ? { research: researchSnapshot(state.research) } : {}),
    ...(state.stopReason ? { explanation: stopExplanation(state.stopReason, state.stopContext) } : {}),
    actions: d.finished ? (!verdict || verdict.failed || verdict.skipped) && hasUsableRound(rounds, state.seats.length) ? ['verdict'] : []
      : d.interrupted ? ['resume'] : status === 'error' ? [] : [...(gate ? ['answer', 'hold'] : ['wait']), ...(d.debate?.canFinish() ? ['finish'] : []), 'stop'],
    // reopenCalls: the seats already agree, so empty answers end the discussion; any answer text
    // or message runs one more round at this many calls. Absent when answering cannot reopen.
    gate: gate ? { round: gate.round, mode: gate.mode, reason: gate.reason, stop: gate.stop, questions: groupQuestions(gate.questions),
      autoContinueAt: d.pending.autoContinueAt ?? null, ...clock('autoContinue', d.pending.autoContinueAt), timeoutBehavior: 'continue_without_answers',
      ...(gate.reopenable ? { reopenCalls: (state.seats || []).length } : {}) } : null,
    nextAction: gate?.questions.length ? {
      type: 'ask_user',
      instruction: 'Ask gate.questions using your available user-input tool. If there is no form, ask in chat. Group overlapping questions without losing their IDs. Do not invent answers. Tell the user when the response window closes (gate.secondsUntilAutoContinue); unanswered questions remain unknown. Read status before submitting a reply because the review may have continued. Mark each answer from: "user" only when it is the user\'s own reply; from: "assistant" when you supplied it yourself with the user\'s permission.',
      answerTemplate: { round: gate.round, answers: groupQuestions(gate.questions).map((q) => ({ id: q.id, text: '' })) },
    } : { type: gate || ['researching', 'running', 'verdict'].includes(status) ? 'wait'
      : status === 'done' && sections ? 'report_result' : 'report_incomplete',
      ...(!gate && !['researching', 'running', 'verdict'].includes(status) && !(status === 'done' && sections)
        ? { instruction: 'The review has no completed chairman recommendation. Report its actual status and available actions; do not invent a verdict or automatically start another model call.' } : {}) },
    replies: (rounds[lastRound] || []).map((r) => ({ lens: r.seat.lens, vendor: r.seat.vendor,
      status: cancellationReason(r, state.stopReason, lastRound) ? 'cancelled' : r.failed ? 'failed' : r.valid ? 'replied' : 'invalid',
      // a recovered stall on a complete reply: the provider connection was started again this many times
      ...(safeProgress(r.progress).reconnects ? { reconnects: safeProgress(r.progress).reconnects } : {}),
      ...(r.failed ? { reason: cancellationReason(r, state.stopReason, lastRound) || r.errorKind, progress: safeProgress(r.progress) } : r.valid ? {
        position: optionLabel(r.stanceKey, state.fieldNotes?.options), agreesWith: r.parsed.agreeWith,
        disagrees: r.parsed.disagree, newPoints: r.parsed.new, assumptions: r.parsed.assumptions,
      } : {}) })),
    verdict: verdict ? { status: verdict.skipped ? 'skipped' : verdict.failed ? 'failed' : 'ready',
      ...(sections ? { sections: Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.filter((x) => x.trim()).join('\n')])) } : { reason: verdict.reason || verdict.errorKind || 'format' }) } : null,
    usage: { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output,
      cost: usage.cost, tokenCoverage: usage.tokenCoverage, costCoverage: usage.costCoverage },
  };
}
