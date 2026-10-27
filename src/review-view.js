// Shared presentation rules. No model calls are needed to collect questions or explain state.
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function groupQuestions(questions = []) {
  const groups = new Map();
  for (const q of questions) {
    if (!q.question?.trim()) continue;
    const key = q.question.normalize('NFKC').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').replace(/[?.\s]+$/, '').trim();
    if (!groups.has(key)) groups.set(key, { id: `q${groups.size + 1}`, question: q.question.trim(), sources: [] });
    const group = groups.get(key);
    if (!group.sources.includes(q.lens)) group.sources.push(q.lens);
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
    human: 'You stopped the discussion. Replies already received are kept.',
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
