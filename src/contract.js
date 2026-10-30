// The reply contract every seat must follow, and its parser.
//
//   STANCE: <an option id (opt-1, opt-2, ...) or its exact label | other: <label>>
//   AGREE_WITH: [labels]        (empty in round 0)
//   DISAGREE: <=3 bullets
//   NEW: <=2 bullets or "none"
//   ASSUMPTIONS: bullets
//   QUESTION_FOR_HUMAN: one line, optional
//   PASS                        (alone, when nothing new)

import { normLabel } from './validate.js';

export const HEADERS = ['STANCE', 'AGREE_WITH', 'DISAGREE', 'NEW', 'ASSUMPTIONS', 'QUESTION_FOR_HUMAN'];
// Parse decoration in separate passes: adjacent optional whitespace regexes can backtrack
// quadratically, especially when a provider puts a Unicode line separator inside a line.
function header(line, names, verdict = false) {
  let rest = line.trimStart(), i = 0;
  const opening = verdict ? '*#_-' : '*_`#>-';
  while (i < rest.length && opening.includes(rest[i])) i++;
  const decoration = rest.slice(0, i);
  rest = rest.slice(i).trimStart();
  const name = names.find((h) => rest.slice(0, h.length).toUpperCase() === h);
  if (!name) return null;
  rest = rest.slice(name.length).trimStart(); i = 0;
  const closing = verdict ? '*_' : '*_`';
  while (i < rest.length && closing.includes(rest[i])) i++;
  const suffix = rest.slice(i).trimStart();
  const closedBeforeColon = i > 0 && (suffix.startsWith(':') || decoration.endsWith(rest.slice(0, i)));
  if (closedBeforeColon) rest = suffix;
  if (rest.startsWith(':')) rest = rest.slice(1).trimStart();
  else if (!verdict) return null;
  let headerClosed = closedBeforeColon;
  if (!closedBeforeColon && decoration) {
    i = 0;
    while (i < rest.length && closing.includes(rest[i])) i++;
    if (i && decoration.endsWith(rest.slice(0, i)) && (i === rest.length || /\s/.test(rest[i]))) {
      rest = rest.slice(i).trimStart(); headerClosed = true;
    }
  }
  rest = rest.trimEnd();
  // A still-open emphasis marker can wrap the entire header/value line. Remove only its
  // matching closing marker, preserving literal punctuation in the value (e.g. Ship*).
  if (!headerClosed && decoration) {
    let start = decoration.length;
    const mark = decoration[start - 1];
    if (closing.includes(mark)) {
      while (start > 0 && decoration[start - 1] === mark) start--;
      const wrapper = decoration.slice(start);
      if (rest.endsWith(wrapper)) rest = rest.slice(0, -wrapper.length).trimEnd();
    }
  }
  // Keep the existing line grammar; these are not additional section delimiters.
  if (/[\r\u2028\u2029]/.test(rest.trimEnd())) return null;
  return [name, rest.trimEnd()];
}

function bullets(lines) {
  return lines.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
}

function stripFence(text) {
  let body = text.trim();
  if (body.startsWith('```')) {
    let i = 3;
    while (i < body.length && /[a-z]/i.test(body[i])) i++;
    body = body.slice(i).trimStart();
  }
  return body.endsWith('```') ? body.slice(0, -3).trimEnd() : body;
}

// Ignore explicit no-question placeholders, including a short declarative explanation.
// Be conservative: punctuation is not required for real questions, and an uncertain suffix
// remains a question. In particular, "None of these options ..." is not a placeholder.
export function humanQuestion(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const plain = text.replace(/[*_`]/g, '').replace(/^[-•]\s+/, '').trim();
  if (/^[-–—]+[.!]?$/.test(plain)) return null;
  if (/[?？]/.test(plain)) return text;
  const match = /^(?:none|n\/?a|not applicable|no (?:further |additional |unanswered )?questions?(?: for (?:the )?human)?)(?:\s*[.,;:!–—-]\s*|$)([\s\S]*)$/i.exec(plain);
  if (!match) return text;
  const explanation = match[1].trim();
  if (!explanation) return null;
  if (/[\r\u2028\u2029]/.test(explanation)) return text;
  // These are bookkeeping statements, not a request for an answer. Other suffixes stay live.
  if (/^(?:treat [^.;:!?]{1,160} as (?:an? )?(?:explicit )?(?:unknown|assumption)s?|(?:all |the )?questions? (?:are |were |have been )?answered|(?:the |this )?(?:information|answer|detail|value) (?:is |remains )?(?:unknown|not provided))[.!]?$/i.test(explanation)
      && !/\b(?:who|what|when|where|why|how|which|whether|please|confirm|clarify)\b/i.test(explanation)) return null;
  return text;
}

// Split the reply into sections keyed by header. Text before the first header is ignored.
export function parseReply(text) {
  const body = stripFence(text || '').trim();
  if (/^\**PASS\**\.?$/i.test(body)) return { pass: true, stance: null, agreeWith: [], disagree: [], new: [], assumptions: [], question: null, raw: text };

  const sections = {};
  const duplicates = [];
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const m = header(line, HEADERS);
    if (m) {
      current = m[0];
      if (Object.hasOwn(sections, current)) duplicates.push(current);
      sections[current] = m[1].trim() ? [m[1].trim()] : [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  const one = (k) => (sections[k] || []).join(' ').trim();
  const list = (k) => bullets((sections[k] || []));
  const agree = one('AGREE_WITH').replace(/^\[|\]$/g, '').split(/[,;]/).map((s) => s.trim()).filter((s) => s && !/^(none|empty|-)$/i.test(s));
  const question = one('QUESTION_FOR_HUMAN');
  return {
    pass: false,
    stance: one('STANCE') || null,
    agreeWith: agree,
    disagree: list('DISAGREE'),
    new: list('NEW'),
    assumptions: list('ASSUMPTIONS'),
    question: humanQuestion(question),
    sections: Object.keys(sections),
    duplicates,
    raw: text,
  };
}

// Options have ids, opt-1 ... opt-N in field-notes order. Every comparison (stance keys, the
// tally, the chosen option) uses the id; the label is for display. So "Ship" and "Ship later"
// stay apart, non-Latin labels stay apart, and no label can collide with PASS or "other:".
export const optionIds = (options) => (options || []).map((label, i) => ({ id: `opt-${i + 1}`, label }));
export function optionLabel(key, options) {
  return optionIds(options).find((o) => o.id === key)?.label ?? key;
}

// The option a piece of text names: its id, its exact label (after NFKC, case and whitespace
// folding; nothing stripped), or the id followed by its own label ("opt-2: Wait a sprint").
// Quotes and a trailing full stop are tolerated. Anything else names no option.
export function optionId(text, options) {
  if (text == null) return null;
  const ids = optionIds(options).map((o) => ({ ...o, normalized: normLabel(o.label) }));
  const match = (s) => {
    for (const o of ids) if (s === o.id || s === o.normalized) return o.id;
    const m = /^(opt-\d+)/.exec(s);
    const o = m && ids.find((x) => x.id === m[1]);
    if (!o) return null;
    let label = s.slice(m[1].length).trimStart();
    if (label && ':=(\u2014\u2013-'.includes(label[0])) label = label.slice(1).trimStart();
    if (!label || label === o.normalized) return o.id;
    if (label.endsWith(')') && label.slice(0, -1) === o.normalized) return o.id;
    return null;
  };
  const raw = normLabel(String(text));
  const exact = match(raw);
  if (exact) return exact;
  let end = raw.length, start = 0;
  while (end && '.;'.includes(raw[end - 1])) end--;
  // Peel only matching wrappers, testing the literal label at each layer. Removing all
  // stars/quotes at once can turn a formatted Ship* response into the different option Ship.
  // Only short cores can name a bounded option; huge wrapper runs still take linear work.
  const maximum = Math.max(0, ...ids.map((o) => o.normalized.length + o.id.length + 4));
  for (;;) {
    while (start < end && raw[start] === ' ') start++;
    while (end > start && raw[end - 1] === ' ') end--;
    if (end - start <= maximum) {
      const pick = match(raw.slice(start, end));
      if (pick) return pick;
    }
    if (end - start < 2 || raw[start] !== raw[end - 1] || !'"\'`*'.includes(raw[start])) return null;
    start++; end--;
  }
}

// A seat's STANCE as a key: an option id, `other: <label>`, or null when it names nothing.
export function matchStance(stance, options) {
  if (!stance) return null;
  const id = optionId(stance, options);
  if (id) return id;
  const body = stance.trim(), other = /^other\s*:/i.exec(body);
  const label = other && body.slice(other[0].length).trim();
  if (label) return `other: ${label}`;
  return null;
}

// Bullet limits are repaired here, not re-prompted: a re-prompt is a whole extra call, and the
// extra bullets stay in the reply text the board and the other seats read.
export const BULLET_LIMITS = { disagree: 3, new: 2 };

// Returns {ok, errors[], parsed}. A violation list feeds the single re-prompt; parsed.trimmed
// names the sections cut back to their limit.
// trim: false keeps every bullet (a hidden mood's rant is the point, not a list to keep short).
// requireAgree: false reads a missing AGREE_WITH line in a later round as agreeing with nobody.
export function validateReply(text, { options, round, trim = true, requireAgree = true }) {
  const parsed = parseReply(text);
  const errors = [];
  for (const h of parsed.duplicates || []) errors.push(`duplicate ${h} section`);
  if (parsed.pass) return { ok: true, errors, parsed: { ...parsed, stanceKey: 'PASS' } };
  const stanceKey = matchStance(parsed.stance, options);
  if (!parsed.stance) errors.push('missing STANCE line');
  else if (!stanceKey) errors.push(`STANCE "${parsed.stance}" is not an option id (${optionIds(options).map((o) => o.id).join(', ')}) or an exact option label, and is not written as "other: <label>"`);
  for (const h of ['DISAGREE', 'NEW', 'ASSUMPTIONS']) {
    if (!(parsed.sections || []).includes(h)) errors.push(`missing ${h} section`);
  }
  if (requireAgree && round > 0 && !(parsed.sections || []).includes('AGREE_WITH')) errors.push('missing AGREE_WITH line (use [] if none)');
  const trimmed = [];
  for (const [key, limit] of trim ? Object.entries(BULLET_LIMITS) : []) {
    if (parsed[key].length > limit) { parsed[key] = parsed[key].slice(0, limit); trimmed.push(key.toUpperCase()); }
  }
  return { ok: errors.length === 0, errors, parsed: { ...parsed, stanceKey, ...(trimmed.length ? { trimmed } : {}) } };
}

// ---- The chairman's verdict -----------------------------------------------------------------

// TALLY is still read (verdicts before 0.3.1 have one) but no longer asked for: the tally is
// counted in code from the seats' final stances, exactly, and writing it cost output tokens.
export const VERDICT_HEADERS = ['RECOMMENDATION', 'TALLY', 'DISSENT', 'KILL_CRITERIA', 'OPEN_QUESTIONS'];
export const REQUIRED_VERDICT = ['RECOMMENDATION', 'DISSENT', 'KILL_CRITERIA', 'OPEN_QUESTIONS'];

// The verdict's sections, tolerant of markdown emphasis around a header.
export function verdictSections(text, duplicates = []) {
  const sections = {};
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = header(line, VERDICT_HEADERS, true);
    if (m) {
      cur = m[0];
      if (Object.hasOwn(sections, cur)) duplicates.push(cur);
      sections[cur] = m[1] ? [m[1]] : [];
    } else if (cur) sections[cur].push(line);
  }
  return sections;
}

// The pick on the recommendation's first line: an option id, 'none' (an explicit abstention),
// or null when the line names neither.
export function recommendationPick(firstLine, options) {
  const line = String(firstLine || '').trim();
  if (/^\**\s*(none|no pick)\s*\.?\**$/i.test(line)) return 'none';
  return optionId(line, options);
}

// Since 0.3.0 the verdict has a grammar: every section present and non-empty, and the
// recommendation's first line is exactly an option id (or its label) or none, with the rationale
// below it. Returns { ok, errors, pick }.
export function validateVerdict(text, options) {
  const duplicates = [];
  const sections = verdictSections(text, duplicates);
  const errors = duplicates.map((h) => `duplicate ${h} section`);
  for (const h of REQUIRED_VERDICT) {
    if (!sections[h]) errors.push(`missing ${h} section`);
    else if (!sections[h].some((l) => l.trim())) errors.push(`${h} is empty`);
  }
  const first = (sections.RECOMMENDATION || []).find((l) => l.trim()) || '';
  const pick = recommendationPick(first, options);
  if (sections.RECOMMENDATION && !pick) errors.push(`the first line of RECOMMENDATION must be one option id (${optionIds(options).map((o) => o.id).join(', ')}) or none, with the rationale on the lines below`);
  return { ok: errors.length === 0, errors, pick };
}
