// Shared presentation rules. No model calls are needed to collect questions or explain state.
import { verdictSections, recommendationPick, optionLabel } from './contract.js';
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function groupQuestions(questions = []) {
  const groups = new Map();
  for (const q of questions) {
    if (!q.question?.trim()) continue;
    const key = q.question.normalize('NFKC').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').replace(/[?.\s]+$/, '').trim();
    if (!groups.has(key)) groups.set(key, { id: `q${groups.size + 1}`, question: q.question.trim(), sources: [], seats: [] });
    const group = groups.get(key);
    if (!group.sources.includes(q.lens)) group.sources.push(q.lens);
    if (q.seat && !group.seats.includes(q.seat)) group.seats.push(q.seat);
  }
  return [...groups.values()];
}

export function answerMessage(questions, answers = [], note = '') {
  const groups = groupQuestions(questions), seen = new Set(), lines = [];
  for (const answer of answers) {
    const group = groups.find((q) => q.id === answer.id);
    if (!group || seen.has(answer.id)) throw Object.assign(new Error('The question list changed. Review the current questions before sending your answers.'), { status: 409 });
    seen.add(answer.id);
    if (answer.text.trim()) lines.push(`Question (${group.sources.join(', ')}): ${group.question}\nAnswer: ${answer.text.trim()}`);
  }
  if (note.trim()) lines.push(note.trim());
  return lines.join('\n\n');
}

export function stopExplanation(reason, context) {
  const labels = {
    human: 'You stopped the review. Replies already received are kept.',
    finish: 'You ended discussion and requested a verdict from the collected replies.',
    'wall-clock': context === 'waiting' ? 'The review time limit expired while waiting for your input. No answer was assumed.' : 'The review time limit expired. Calls still running were cancelled.',
    'round-cap': 'The planned rounds are complete.', consensus: 'The seats reached the same position.',
    stable: 'The positions stopped changing and the seats had nothing new to add.',
    'all-pass': 'All remaining seats had nothing new to add.',
    'all-failed': 'No seat returned a usable reply in the last round.',
    'seats-down': 'Too few providers remained available for another discussion round.',
    budget: 'The budget prevented another call.',
  };
  return labels[reason] || 'The discussion has ended.';
}

export function cancellationReason(reply, stopReason, lastRound) {
  if (reply.cancelReason) return reply.cancelReason;
  // Older transcripts did not distinguish an expected cancellation from a provider failure.
  if (reply.failed && reply.errorKind === 'killed' && reply.round === lastRound && ['human', 'wall-clock'].includes(stopReason)) return stopReason;
  return null;
}

export function remainingWindow(quota) {
  const windows = (quota?.windows || []).filter((w) => typeof w.used === 'number' && Number.isFinite(w.used));
  if (!windows.length) return null;
  const window = windows.reduce((a, b) => a.used > b.used ? a : b);
  return { label: window.label, remaining: Math.max(0, Math.min(100, (1 - window.used) * 100)), at: quota.at };
}

// Literal emphasis, not sentiment analysis. Section labels carry the meaning as well as color.
export function argumentHtml(text, section) {
  const pattern = section === 'disagree'
    ? /\b(?:not|never|cannot|can['’]t|don['’]t|doesn['’]t|isn['’]t|aren['’]t|won['’]t|shouldn['’]t|reject(?:ed|s|ing)?|avoid|unsupported)\b/giu
    : section === 'agree' ? /\b(?:agree|accept|support|supported|feasible|benefit(?:s)?)\b/giu : null;
  if (!pattern) return escapeHtml(text);
  let out = '', at = 0;
  for (const match of String(text).matchAll(pattern)) {
    out += escapeHtml(text.slice(at, match.index));
    const negated = section === 'agree' && /\b(?:not|never|no|don['’]t|doesn['’]t|cannot)(?:\s+\w+){0,2}\s*$/iu.test(text.slice(Math.max(0, match.index - 40), match.index));
    out += negated ? escapeHtml(match[0]) : `<strong class="term-${section}">${escapeHtml(match[0])}</strong>`;
    at = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(at));
}

// Which session cue a board event earns: 'verdict', 'cancelled', 'ended' or 'failed'. Replayed
// history never plays, and neither does a fatal error, which only comes from opening a saved
// transcript that cannot be read. The engine sends no 'done' after an error, so cues never stack.
const SEATS_LOST = new Set(['all-failed', 'seats-down']);
export function ceremonyOutcome(event) {
  if (!event || event.replayed) return null;
  if (event.type === 'error') return event.fatal ? null : 'failed';
  if (event.type !== 'done') return null;
  // Explicit cancellation wins even if an older server finished a verdict after Stop.
  // A separately requested, completed verdict can still succeed after a stopped discussion.
  if (event.cancelled === true || event.cancelled == null && event.reason === 'human') return 'cancelled';
  if (event.synthesis === 'done') return 'verdict';
  if (event.synthesis === 'failed' || SEATS_LOST.has(event.reason)) return 'failed';
  return 'ended';
}


// Presentation only: the saved verdict and its machine-readable contract are unchanged.
// Untagged questions from older reviews stay visible; we cannot infer their importance.
const absent = (text) => /^(?:none|n\/?a|not applicable|нет|не применимо|[-–—])[.!]?$/iu.test(text.replace(/[*_`]/g, '').trim());
function verdictItems(lines = []) {
  const items = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet || !items.length) items.push((bullet?.[1] ?? line).trim());
    else items[items.length - 1] += ` ${line.trim()}`;
  }
  return items.filter((item) => !absent(item));
}

export function verdictView(text, options = []) {
  const sections = verdictSections(text);
  const lines = [...(sections.RECOMMENDATION || [])];
  while (lines.length && !lines[0].trim()) lines.shift();
  const pick = recommendationPick(lines[0], options);
  if (pick) lines.shift(); // only remove a recognized grammar line, never legacy prose
  const paragraphs = lines.join('\n').trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const questions = { needed: [], optional: [], unclassified: [] };
  for (const item of verdictItems(sections.OPEN_QUESTIONS)) {
    const tag = /^\*{0,2}(NEEDED|OPTIONAL)\*{0,2}:\*{0,2}\s*(.*)$/i.exec(item);
    const question = (tag ? tag[2] : item).trim();
    if (question && !absent(question)) questions[tag ? tag[1].toLowerCase() : 'unclassified'].push(question);
  }
  return {
    parsed: Object.keys(sections).length > 0,
    pick,
    option: pick && pick !== 'none' ? optionLabel(pick, options) : null,
    answer: paragraphs[0] || '',
    reasons: paragraphs.slice(1),
    dissent: verdictItems(sections.DISSENT),
    reconsider: verdictItems(sections.KILL_CRITERIA),
    questions,
  };
}

// Copy the conclusion from source data, not the DOM: no hidden tooltips, seat cards or paths.
export function verdictResultText(text, options = [], question = '') {
  const v = verdictView(text, options);
  if (!v.parsed) return String(text || '').trim();
  const parts = question.trim() ? [question.trim(), ''] : [];
  parts.push('Answer', v.answer || 'No conclusion text was provided.');
  if (v.pick) parts.push('', v.pick === 'none' ? 'No single option recommended.' : `Suggested option: ${v.option}`);
  if (v.reasons.length) parts.push('', 'Why', v.reasons.join('\n\n'));
  const list = (title, items) => { if (items.length) parts.push('', title, ...items.map((item) => `- ${item}`)); };
  list('Main reservation', v.dissent);
  list('What could change this', v.reconsider);
  list('Clarification needed from you', v.questions.needed);
  list('Questions for you', v.questions.unclassified);
  list('Further exploration (optional)', v.questions.optional);
  return parts.join('\n').trim();
}
