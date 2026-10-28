import { rollup, hasUsableRound } from './engine.js';
import { groupQuestions, stopExplanation, cancellationReason } from './review-view.js';
import { optionLabel, verdictSections } from './contract.js';

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
    ...(state.stopReason ? { explanation: stopExplanation(state.stopReason, state.stopContext) } : {}),
    actions: d.finished ? (!verdict || verdict.failed || verdict.skipped) && hasUsableRound(rounds, state.seats.length) ? ['verdict'] : []
      : d.interrupted ? ['resume'] : status === 'error' ? [] : [gate ? 'answer' : 'wait', ...(d.debate?.canFinish() ? ['finish'] : []), 'stop'],
    // reopenCalls: the seats already agree, so empty answers end the discussion; any answer text
    // or message runs one more round at this many calls. Absent when answering cannot reopen.
    gate: gate ? { round: gate.round, mode: gate.mode, stop: gate.stop, questions: groupQuestions(gate.questions),
      ...(gate.reopenable ? { reopenCalls: (state.seats || []).length } : {}) } : null,
    replies: (rounds[lastRound] || []).map((r) => ({ lens: r.seat.lens, vendor: r.seat.vendor,
      status: cancellationReason(r, state.stopReason, lastRound) ? 'cancelled' : r.failed ? 'failed' : r.valid ? 'replied' : 'invalid',
      ...(r.failed ? { reason: cancellationReason(r, state.stopReason, lastRound) || r.errorKind } : r.valid ? {
        position: optionLabel(r.stanceKey, state.fieldNotes?.options), agreesWith: r.parsed.agreeWith,
        disagrees: r.parsed.disagree, newPoints: r.parsed.new, assumptions: r.parsed.assumptions,
      } : {}) })),
    verdict: verdict ? { status: verdict.skipped ? 'skipped' : verdict.failed ? 'failed' : 'ready',
      ...(sections ? { sections: Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.filter((x) => x.trim()).join('\n')])) } : { reason: verdict.reason || verdict.errorKind || 'format' }) } : null,
    usage: { input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output,
      cost: usage.cost, tokenCoverage: usage.tokenCoverage, costCoverage: usage.costCoverage },
  };
}
