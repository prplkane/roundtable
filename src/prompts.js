// Every string an agent sees. Seats never see vendor names, only lens labels.
import { moodLine } from './seats.js';
import { optionIds } from './contract.js';

const NO_TOOLS = 'Answer from this prompt only. Do not use any tools, do not read files, do not run commands, do not ask for permissions.';

export function contractText(options) {
  return [
    'Reply with ONLY these lines, in this order, nothing before or after:',
    'Aim for 140 words total. Use short, specific bullets; do not repeat the field notes.',
    '',
    `STANCE: <exactly one option id: ${optionIds(options).map((o) => o.id).join(' | ')}, or other: <short label>>`,
    'AGREE_WITH: [lens labels, comma separated; [] if none]',
    'DISAGREE:',
    '- up to 3 short bullets: what you reject and why',
    'NEW:',
    '- up to 2 short bullets of new evidence or angles, or "none"',
    'ASSUMPTIONS:',
    '- up to 3 short bullets: what must be true for your stance',
    'QUESTION_FOR_HUMAN: <optional; one unanswered question that would change your stance; do not repeat a question already answered in the human notes>',
    '',
    'If you have nothing new to add and no change of stance, reply with the single word PASS instead.',
  ].join('\n');
}

export function fieldNotesText(fn) {
  const lines = [
    `DECISION: ${fn.decision}`,
    `OPTIONS: ${optionIds(fn.options).map((o) => `${o.id} = ${o.label}`).join(' | ')}`,
    fn.constraints ? `CONSTRAINTS: ${fn.constraints}` : null,
    fn.known ? `EVIDENCE (known): ${fn.known}` : null,
    fn.assumed ? `EVIDENCE (assumed): ${fn.assumed}` : null,
    fn.reversibility ? `REVERSIBILITY: ${fn.reversibility}` : null,
    fn.deadline ? `DEADLINE: ${fn.deadline}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

export function round0Prompt({ fieldNotes, lens, mood, seatCount, notes = [] }) {
  return [
    `You are one of ${seatCount} seats at a roundtable deciding a question. You speak through the lens: ${lens}.`,
    `How you approach it: ${moodLine(mood)}`,
    'This is round 0: you have not seen the other seats and must take a position blind. Be concrete and committal.',
    NO_TOOLS,
    '',
    '--- FIELD NOTES ---',
    fieldNotesText(fieldNotes),
    '--- END ---',
    '',
    ...notesBlock(notes),
    contractText(fieldNotes.options),
  ].join('\n');
}

// The part of a stateless prompt that is the same for one seat in every round: who it is, the
// field notes and the contract. It goes first so a vendor's prompt cache can serve it; what
// changes each round follows it (statelessRoundPrompt, statelessRepromptText).
export function statelessPrefix({ fieldNotes, lens, mood, seatCount }) {
  return [
    `You are one of ${seatCount} seats at a roundtable deciding a question. You speak through the lens: ${lens}.`,
    `How you approach it: ${moodLine(mood)}`,
    NO_TOOLS,
    '',
    '--- FIELD NOTES ---',
    fieldNotesText(fieldNotes),
    '--- END ---',
    '',
    contractText(fieldNotes.options),
  ].join('\n');
}

// The human's notes as one block: every note given so far, oldest first, each with the round it
// followed, the newest marked. notes: [{ round, text }]. A correction made after round 0 still
// reaches round 3, so no seat argues from an assumption the human already overturned.
export function notesBlock(notes) {
  const list = (notes || []).filter((n) => n?.text && n.text.trim());
  if (!list.length) return [];
  return ['### The human at the table says', ...list.map((n, i) => `- ${n.round < 0 ? 'Before round 0' : `After round ${n.round}`}${i === list.length - 1 ? ' (latest)' : ''}: ${n.text.trim()}`), ''];
}

// A critique round as one fresh call: the seat has no thread, so its own last reply, the other
// seats' last replies and every human note are all in the prompt, in that order after the
// stable prefix. Lens labels only, as in roundPrompt.
export function statelessRoundPrompt({ prefix, round, maxRound, own, others, notes }) {
  const parts = [
    prefix,
    '',
    `Round ${round} of ${maxRound}. You have no memory of earlier rounds: everything you need is below.`,
    '',
    `### Your reply in round ${round - 1}`,
    (own || '(no reply)').trim(),
    '',
    `The other seats replied as follows in round ${round - 1}, identified by lens only.`,
    '',
  ];
  for (const o of others) parts.push(`### Seat: ${o.lens}`, o.text.trim(), '');
  parts.push(...notesBlock(notes));
  parts.push(
    'Critique what you disagree with, concede what you now accept, and add only what is new. Do not repeat your own earlier points.',
    'Changing your stance is allowed and should be explicit. Forced consensus is not the goal.',
    'Reply in the contract form given above, nothing before or after.',
  );
  return parts.join('\n');
}

// The stateless re-prompt: with no thread to refer back to, the offending reply travels with
// the violation list, after the same stable prefix, and the human's notes come too, so the
// corrected reply cannot drop a correction. The other seats' replies do not: the seat is asked
// for the same content in the right form, and they would double the call's size.
// `extra` adds a line (the tool-use guard).
export function statelessRepromptText({ prefix, round, maxRound, text, errors, extra = [], notes = [] }) {
  return [
    prefix,
    '',
    `Round ${round} of ${maxRound}. Your reply below did not follow the contract:`,
    ...errors.map((e) => `- ${e}`),
    ...extra,
    '',
    ...notesBlock(notes),
    '### Your reply',
    (text || '').trim(),
    '',
    'Reply again, following the contract exactly. Same content, correct form, nothing before or after.',
  ].join('\n');
}

// Resume mode: the seat's own thread already holds every earlier round, notes included, so only
// the notes given since its last call are new (sending all again would pay for them twice).
export function roundPrompt({ round, maxRound, others, notes, options, mood }) {
  const parts = [
    `Round ${round} of ${maxRound}. The other seats replied as follows in round ${round - 1}, identified by lens only.`,
    `How you approach it: ${moodLine(mood)}`,
    NO_TOOLS,
    '',
  ];
  for (const o of others) {
    parts.push(`### Seat: ${o.lens}`, o.text.trim(), '');
  }
  parts.push(...notesBlock(notes));
  parts.push(
    'Critique what you disagree with, concede what you now accept, and add only what is new. Do not repeat your own earlier points.',
    'Changing your stance is allowed and should be explicit. Forced consensus is not the goal.',
    '',
    contractText(options),
  );
  return parts.join('\n');
}

export function repromptText(errors, options, extra = []) {
  return [
    'Your last reply did not follow the contract:',
    ...errors.map((e) => `- ${e}`),
    ...extra,
    '',
    'Reply again, following the contract exactly. Same content, correct form.',
    NO_TOOLS,
    '',
    contractText(options),
  ].join('\n');
}

export function chairmanPrompt({ fieldNotes, rounds, humanNotes, initialNotes = [] }) {
  const parts = [
    'You are the chairman of a roundtable. You did not take part in the debate. Your job is to write the verdict.',
    'Be sceptical. Judge the arguments, not the votes: seats agreeing is not evidence, and a majority can share one unsupported premise.',
    'Count as support only what the field notes state or a seat showed; name the claims that rest on assumption.',
    'If the case for every option rests on assumptions the field notes do not support, recommend none and say what would settle it.',
    NO_TOOLS,
    '',
    '--- FIELD NOTES ---',
    fieldNotesText(fieldNotes),
    '--- END ---',
    '',
    '--- TRANSCRIPT (seats identified by lens) ---',
  ];
  parts.push(...notesBlock(initialNotes.map((text) => ({ round: -1, text }))));
  rounds.forEach((r, i) => {
    parts.push(`## Round ${i}`);
    for (const reply of r) parts.push(`### ${reply.lens}`, reply.text.trim(), '');
    for (const note of humanNotes[i] || []) if (note?.trim()) parts.push('### Human', note.trim(), '');
  });
  parts.push(
    '--- END ---',
    '',
    'Write the verdict with exactly these sections and headers:',
    'Aim for 220 words total. Keep the reasoning specific; do not repeat the field notes or whole seat replies.',
    `RECOMMENDATION: <on this line only: one option id (${optionIds(fieldNotes.options).map((o) => o.id).join(' | ')}), or none if the evidence does not support a pick yet>`,
    'then the rationale on the lines below it, in at most four sentences.',
    'DISSENT: the strongest argument against the recommendation, stated fairly in at most two sentences, with the lens that made it. Never erase it.',
    'KILL_CRITERIA:',
    '- up to 3 bullets, one sentence each: observable evidence that would overturn the recommendation',
    'OPEN_QUESTIONS:',
    '- up to 3 bullets, one sentence each: what the human still has to find out, including any QUESTION_FOR_HUMAN left unanswered',
    'Do not restate the tally; it is counted from the replies.',
  );
  return parts.join('\n');
}

// The chairman's re-prompt: its verdict travels back with what was wrong with it and the option
// ids. The transcript does not: the content is already written, only the form needs fixing, and
// the transcript is most of the chairman's prompt.
export function verdictRepromptText({ options, text, errors, extra = [] }) {
  return [
    'You are the chairman of a roundtable. Your verdict below did not follow the required format:',
    ...errors.map((e) => `- ${e}`),
    ...extra,
    NO_TOOLS,
    '',
    '### Your verdict',
    (text || '').trim(),
    '',
    'Write it again with the same content, in exactly these sections:',
    `RECOMMENDATION: <on this line only: one option id (${optionIds(options).map((o) => `${o.id} = ${o.label}`).join(' | ')}), or none>`,
    'then the rationale on the lines below it, in at most four sentences.',
    'DISSENT:', 'KILL_CRITERIA:', 'OPEN_QUESTIONS:',
    'Every section must have content. Nothing before or after.',
  ].join('\n');
}
