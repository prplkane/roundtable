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
const HEADER_RE = /^\s*(?:[*_`#>-]+\s*)?(STANCE|AGREE_WITH|DISAGREE|NEW|ASSUMPTIONS|QUESTION_FOR_HUMAN)\s*[*_`]*\s*:\s*(.*)$/i;

function bullets(lines) {
  return lines.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
}

function stripFence(text) {
  return text.replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?\s*```\s*$/, '');
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
  const match = /^(?:none|n\/?a|not applicable|no (?:further |additional |unanswered )?questions?(?: for (?:the )?human)?)(?:\s*[.,;:!–—-]\s*|$)(.*)$/i.exec(plain);
  if (!match) return text;
  const explanation = match[1].trim();
  if (!explanation) return null;
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
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(HEADER_RE);
    if (m) {
      current = m[1].toUpperCase();
      sections[current] = m[2].trim() ? [m[2].trim()] : [];
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
  const s = normLabel(String(text).trim().replace(/[.;]+$/, '').replace(/^["'`*]+|["'`*]+$/g, ''));
  const ids = optionIds(options);
  for (const o of ids) if (s === o.id || s === normLabel(o.label)) return o.id;
  const m = /^(opt-\d+)\s*(?:[:=(\u2014\u2013-]\s*)?(.*?)\)?$/.exec(s);
  const o = m && ids.find((x) => x.id === m[1]);
  return o && (!m[2] || m[2] === normLabel(o.label)) ? o.id : null;
}

// A seat's STANCE as a key: an option id, `other: <label>`, or null when it names nothing.
export function matchStance(stance, options) {
  if (!stance) return null;
  const id = optionId(stance, options);
  if (id) return id;
  const other = stance.trim().match(/^other\s*:\s*(.+)$/i);
  if (other) return `other: ${other[1].trim()}`;
  return null;
}

// Bullet limits are repaired here, not re-prompted: a re-prompt is a whole extra call, and the
// extra bullets stay in the reply text the board and the other seats read.
export const BULLET_LIMITS = { disagree: 3, new: 2 };

// Returns {ok, errors[], parsed}. A violation list feeds the single re-prompt; parsed.trimmed
// names the sections cut back to their limit.
export function validateReply(text, { options, round }) {
  const parsed = parseReply(text);
  const errors = [];
  if (parsed.pass) return { ok: true, errors, parsed: { ...parsed, stanceKey: 'PASS' } };
  const stanceKey = matchStance(parsed.stance, options);
  if (!parsed.stance) errors.push('missing STANCE line');
  else if (!stanceKey) errors.push(`STANCE "${parsed.stance}" is not an option id (${optionIds(options).map((o) => o.id).join(', ')}) or an exact option label, and is not written as "other: <label>"`);
  for (const h of ['DISAGREE', 'NEW', 'ASSUMPTIONS']) {
    if (!(parsed.sections || []).includes(h)) errors.push(`missing ${h} section`);
  }
  if (round > 0 && !(parsed.sections || []).includes('AGREE_WITH')) errors.push('missing AGREE_WITH line (use [] if none)');
  const trimmed = [];
  for (const [key, limit] of Object.entries(BULLET_LIMITS)) {
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
export function verdictSections(text) {
  const sections = {};
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:[*#_-]+\s*)?(RECOMMENDATION|TALLY|DISSENT|KILL_CRITERIA|OPEN_QUESTIONS)\s*[*_]*\s*:?\s*(.*)$/i);
    if (m) { cur = m[1].toUpperCase(); sections[cur] = m[2] ? [m[2]] : []; } else if (cur) sections[cur].push(line);
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
  const sections = verdictSections(text);
  const errors = [];
  for (const h of REQUIRED_VERDICT) {
    if (!sections[h]) errors.push(`missing ${h} section`);
    else if (!sections[h].some((l) => l.trim())) errors.push(`${h} is empty`);
  }
  const first = (sections.RECOMMENDATION || []).find((l) => l.trim()) || '';
  const pick = recommendationPick(first, options);
  if (sections.RECOMMENDATION && !pick) errors.push(`the first line of RECOMMENDATION must be one option id (${optionIds(options).map((o) => o.id).join(', ')}) or none, with the rationale on the lines below`);
  return { ok: errors.length === 0, errors, pick };
}
