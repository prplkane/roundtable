import { rollup, hasUsableRound } from './engine.js';
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
    deadlineAt: state.deadlineAt, stopReason: state.stopReason || null,
    ...(state.research ? { research: researchSnapshot(state.research) } : {}),
    ...(state.stopReason ? { explanation: stopExplanation(state.stopReason, state.stopContext) } : {}),
    actions: d.finished ? (!verdict || verdict.failed || verdict.skipped) && hasUsableRound(rounds, state.seats.length) ? ['verdict'] : []
      : d.interrupted ? ['resume'] : status === 'error' ? [] : [gate ? 'answer' : 'wait', ...(d.debate?.canFinish() ? ['finish'] : []), 'stop'],
    // reopenCalls: the seats already agree, so empty answers end the discussion; any answer text
    // or message runs one more round at this many calls. Absent when answering cannot reopen.
    gate: gate ? { round: gate.round, mode: gate.mode, stop: gate.stop, questions: groupQuestions(gate.questions),
      ...(gate.reopenable ? { reopenCalls: (state.seats || []).length } : {}) } : null,
    replies: (rounds[lastRound] || []).map((r) => ({ lens: r.seat.lens, vendor: r.seat.vendor,
      status: cancellationReason(r, state.stopReason, lastRound) ? 'cancelled' : r.failed ? 'failed' : r.valid ? 'replied' : 'invalid',
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
