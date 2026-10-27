// Decision records: one plain-markdown file per debate, written into a codebase so an agent
// that can read the repo (sandboxed or not) can read what was decided and why, plus an index
// README.md listing every record. Pure functions over transcript rows, plus two file writers.
//
//   decisionRecord(rows, slug)       -> { markdown, meta }            (pure)
//   updateIndex(existing, meta)      -> new index text, or null when the file is not ours (pure)
//   validateTarget(target)           -> absolute path of an existing directory, or throws
//   exportDebate(rows, slug, target) -> { path, indexPath, meta }     (writes both files)
//
// The exporter writes only into files it can prove it wrote: a record whose front matter names
// this slug under `roundtable:`, and an index region between two marker comments. Everything
// outside the region is kept byte for byte; any other file in the way is refused, never
// replaced.
import { existsSync, statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rebuildDebate, normaliseRows } from './store.js';
import { rollup } from './engine.js';
import { optionIds, optionId, optionLabel, recommendationPick, verdictSections, VERDICT_HEADERS } from './contract.js';
import { normLabel } from './validate.js';

// The chairman's sections, same tolerance as the board (markdown emphasis around the header).
export function parseVerdict(text) {
  const sections = verdictSections(text);
  const out = {};
  for (const h of VERDICT_HEADERS) out[h] = (sections[h] || []).map((l) => l.trim()).filter(Boolean).join('\n');
  out.parsed = Object.keys(sections).length > 0;
  return out;
}

// A 0.2.0 verdict has no grammar line. Its first line counts only when it begins with one exact
// option label followed by punctuation or nothing ("Ship now, on balance."), longest label first,
// so "Ship later, ..." never reads as "Ship" and "Do not use Postgres" never reads as Postgres.
function leadingOption(line, options) {
  const s = normLabel(line || '');
  for (const o of [...optionIds(options)].sort((a, b) => b.label.length - a.label.length)) {
    const l = normLabel(o.label);
    if (s === l || (s.startsWith(l) && /^[\s]*[,.;:!?(\u2014\u2013-]/.test(s.slice(l.length)))) return o.id;
  }
  return null;
}

// Which option the debate chose, as its label:
// - the option on the recommendation's first line;
// - 'no pick' when the chairman wrote none: an abstention is never filled in from the seats;
// - for a legacy verdict (no grammar) or a missing one, the option every seat ended on, and only
//   when every seat has an eligible final stance;
// - otherwise 'no consensus'. Substring presence never counts.
// finalStances: one per seat, an option id or label, or null for a seat with no eligible stance.
export function chosenOption(options, recommendation, finalStances, { legacy = true } = {}) {
  const first = String(recommendation || '').split(/\r?\n/).find((l) => l.trim()) || '';
  const pick = recommendationPick(first, options) ?? (legacy ? leadingOption(first, options) : null);
  if (pick === 'none') return 'no pick';
  if (pick) return optionLabel(pick, options);
  if (!legacy) return 'no consensus';
  const ids = finalStances.map((s) => (s == null ? null : optionId(s, options)));
  if (ids.length && ids.every(Boolean) && new Set(ids).size === 1) return optionLabel(ids[0], options);
  return 'no consensus';
}

const STOPPED = new Set(['human', 'wall-clock', 'budget', 'all-failed', 'seats-down']);
const yaml = (v) => (typeof v === 'string' && /[:#"'\n]|^\s|\s$/.test(v) ? JSON.stringify(v) : String(v));
const k = (n) => (n || 0).toLocaleString('en-US');

export function decisionRecord(rows, slug, { warnings = [] } = {}) {
  rows = normaliseRows(rows);
  const rb = rebuildDebate(rows);
  if (!rb) throw new Error('No field-notes row: nothing to export.');
  const fn = rb.fieldNotes;
  const options = fn.options || [];
  const verdictRow = rb.verdict;
  const v = parseVerdict(verdictRow?.skipped ? '' : verdictRow?.text);
  const date = (rows.find((r) => r.t)?.t || new Date().toISOString()).slice(0, 10);
  const seats = rb.seats;
  const finalRound = rb.rounds.length - 1;
  // A seat's final stance: its last reply's, where only a PASS carries an earlier stance forward.
  // A failed or off-contract last reply leaves the seat with no eligible stance (null).
  const finalStance = (seat) => {
    for (let i = finalRound; i >= 0; i--) {
      const r = rb.rounds[i]?.find((x) => (x.seat.id ?? `${x.seat.vendor}:${x.seat.lens}`) === (seat.id ?? `${seat.vendor}:${seat.lens}`));
      if (!r) continue;
      if (r.failed || !r.valid) return null;
      if (r.stanceKey !== 'PASS') return r.stanceKey;
    }
    return null;
  };
  const head = rows.find((r) => r.type === 'field-notes');
  const finals = seats.map(finalStance);
  // the tally, counted in code from the final stances (the chairman's own is kept for comparison)
  const counts = {};
  for (const f of finals) { const k = f ? optionLabel(f, options) : 'no eligible stance'; counts[k] = (counts[k] || 0) + 1; }
  const tallyCount = Object.keys(counts).length ? `Final: ${Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(', ')}.` : '';
  const legacy = !(head?.schemaVersion >= 3);
  // a failed verdict (the chairman never met the grammar) is diagnostic text: it never chooses
  const failedVerdict = !!(verdictRow?.failed && !verdictRow.skipped);
  const chosen = failedVerdict ? 'no verdict' : chosenOption(options, v.RECOMMENDATION, finals, { legacy });
  // The AI recommends; only a human decides. `accepted` comes from an `accepted` row (POST
  // .../accept) and may differ from the recommendation; both are written.
  const acceptedRow = [...rows].reverse().find((r) => r.type === 'accepted');
  const accepted = acceptedRow ? (acceptedRow.option === 'none' ? 'no option' : optionLabel(acceptedRow.option, options)) : null;
  const recommended = chosen;
  const status = accepted ? 'accepted' : failedVerdict ? 'no verdict' : !rb.finished || !verdictRow || verdictRow.skipped || STOPPED.has(rb.stopReason) ? 'stopped' : chosen === 'no consensus' || chosen === 'no pick' ? 'split' : 'recommended';
  const usage = rollup(rows);
  const recoveryMessages = [...new Set([...rb.recoveryWarnings, ...warnings].map((w) => w.message).filter(Boolean))];

  // where the seat ran is part of the record: a CLI on a subscription, or an API endpoint by URL
  const where = (s) => (s.endpoint ? `API ${s.endpoint}` : 'CLI');
  const seatLine = (s) => [s.label || s.vendor, where(s), s.lens, s.mood?.preset === 'custom' ? `custom: ${s.mood.text}` : (s.mood?.preset || 'grill'), s.model || 'default model', s.effort || 'default effort'].join(', ');
  const front = [
    '---',
    `title: ${yaml(fn.decision)}`,
    `date: ${date}`,
    `slug: ${slug}`,
    `status: ${status}`,
    `stop_reason: ${rb.stopReason || 'none'}`,
    'options:',
    ...options.map((o) => `  - ${yaml(o)}`),
    `chosen: ${yaml(accepted ?? chosen)}`,
    `recommended: ${yaml(recommended)}`,
    ...(acceptedRow ? [`accepted: ${yaml(accepted)}`, `accepted_on: ${String(acceptedRow.t || '').slice(0, 10) || 'unknown'}`] : []),
    'seats:',
    ...seats.map((s) => `  - ${yaml(seatLine(s))}`),
    `chairman: ${rb.chairman?.vendor || 'none'}${rb.chairman?.endpoint ? ` at ${rb.chairman.endpoint}` : ''}${rb.chairman?.model ? ` (${rb.chairman.model})` : ''}`,
    `rounds: ${rb.rounds.length}`,
    `roundtable: ${slug}`,
    '---',
  ];
  const section = (title, body) => [`## ${title}`, '', body && body.trim() ? body.trim() : '_not given_', ''];
  const list = (text) => text; // the chairman already writes bullets
  const notesBody = [
    fn.constraints ? `- **Constraints:** ${fn.constraints}` : null,
    fn.known ? `- **Evidence, known:** ${fn.known}` : null,
    fn.assumed ? `- **Evidence, assumed:** ${fn.assumed}` : null,
    fn.reversibility ? `- **Reversibility:** ${fn.reversibility}` : null,
    fn.deadline ? `- **Deadline:** ${fn.deadline}` : null,
  ].filter(Boolean).join('\n');
  const tallyRows = seats.map((s, i) => {
    const per = rb.rounds.map((round) => {
      const r = round.find((x) => (x.seat.id ?? `${x.seat.vendor}:${x.seat.lens}`) === (s.id ?? `${s.vendor}:${s.lens}`));
      return r ? (r.failed ? 'no reply' : optionLabel(r.stanceKey, options)) : '';
    });
    return `| ${s.label || s.vendor} · ${s.lens} | ${per.join(' | ')} | ${finals[i] ? optionLabel(finals[i], options) : 'none'} |`;
  });
  const tally = rb.rounds.length
    ? [`| seat | ${rb.rounds.map((_, i) => `round ${i}`).join(' | ')} | final |`, `|---|${rb.rounds.map(() => '---').join('|')}|---|`, ...tallyRows].join('\n')
    : '';
  const humanNotes = [rb.initialNotes?.length ? `### Before round 0\n\n${rb.initialNotes.join('\n\n')}` : null,
    ...rb.humanNotes.map((ns, i) => (ns?.length ? `### After round ${i}\n\n${ns.join('\n\n')}` : null))].filter(Boolean).join('\n\n');
  const costCell = (u) => (u.cost == null ? 'not reported' : `$${u.cost.toFixed(2)}${u.costCoverage && u.costCoverage.reported < u.costCoverage.of ? ` (partial: ${u.costCoverage.reported} of ${u.costCoverage.of} calls report a cost)` : ''}`);
  const tokens = (n, u) => u.tokenCoverage?.reported === 0 ? 'unknown'
    : `${k(n)}${u.tokenCoverage && u.tokenCoverage.reported < u.tokenCoverage.of ? ' (partial)' : ''}`;
  const usageRows = seats.map((s) => {
    const u = usage.bySeat[s.id ?? `${s.vendor}:${s.lens}`]?.usage;
    return u ? `| ${s.label || s.vendor} · ${s.lens} | ${tokens(u.input, u)} | ${tokens(u.cacheRead + u.cacheWrite, u)} | ${tokens(u.output, u)} | ${costCell(u)} |` : null;
  }).filter(Boolean);
  const ch = usage.bySeat.chairman?.usage;
  if (ch) usageRows.push(`| chairman (${rb.chairman?.vendor || '?'}) | ${tokens(ch.input, ch)} | ${tokens(ch.cacheRead + ch.cacheWrite, ch)} | ${tokens(ch.output, ch)} | ${costCell(ch)} |`);
  const t = usage.total;
  const usageTable = usageRows.length
    ? ['| seat | input | cache | output | cost |', '|---|---|---|---|---|', ...usageRows, `| **debate** | ${tokens(t.input, t)} | ${tokens(t.cacheRead + t.cacheWrite, t)} | ${tokens(t.output, t)} | ${costCell(t)} |`].join('\n')
    : '';
  // a grammar line names an id: show its label in its place
  const recText = v.parsed ? v.RECOMMENDATION.replace(/^\s*(opt-\d+)\b\.?/, (m, id) => `**${optionLabel(id, options)}** (${id})`) : '';
  const recommendation = verdictRow?.skipped ? verdictRow.text : (v.parsed ? recText : (verdictRow?.text || ''));

  const md = [
    ...front,
    '',
    `# ${fn.decision}`,
    '',
    acceptedRow
      ? `Accepted by the human on ${String(acceptedRow.t || date).slice(0, 10)}: **${accepted}**. Recommended by a roundtable of ${seats.length} seats on ${date}: **${recommended}** (stopped because: ${rb.stopReason || 'not stopped'}).`
      : `Recommended by a roundtable of ${seats.length} seats on ${date}: **${recommended}** (${status}, stopped because: ${rb.stopReason || 'not stopped'}). Not yet accepted by a human.`,
    ...(acceptedRow?.note ? ['', `> ${String(acceptedRow.note).replace(/\r?\n/g, ' ')}`] : []),
    '',
    ...(recoveryMessages.length ? section('Record recovery', recoveryMessages.join('\n\n')) : []),
    ...section('Question', `${fn.decision}\n\nOptions:\n${options.map((o) => `- ${o}`).join('\n')}`),
    ...section('Field notes', notesBody),
    ...section('Tally', [tally, tallyCount].filter(Boolean).join('\n\n')),
    ...section('Recommendation', recommendation),
    ...(v.TALLY ? section("Chairman's tally", v.TALLY) : []),
    ...section('Dissent', list(v.DISSENT)),
    ...section('Kill criteria', list(v.KILL_CRITERIA)),
    ...section('Open questions', list(v.OPEN_QUESTIONS)),
    ...section('Human notes', humanNotes),
    ...section('Usage', [usageTable, usage.unknownAttempts ? `${usage.unknownAttempts} call(s) did not report usable token counts. Totals include reported figures only; unknown usage is not zero.` : ''].filter(Boolean).join('\n\n')),
    `_Exported by roundtable from debates/${slug}/transcript.jsonl._`,
    '',
  ].join('\n');
  const meta = { title: fn.decision, date, slug, status, chosen: accepted ?? chosen, recommended, accepted, stopReason: rb.stopReason, file: `${slug}.md` };
  return { markdown: md, meta };
}

const INDEX_INTRO = ['# Decision records', '', 'One file per roundtable debate, newest first. Written by `npm run export`; re-exporting a debate replaces its row.', ''];
const TABLE_HEAD = ['| date | title | chosen | status | record |', '|---|---|---|---|---|'];
const REGION_START = '<!-- roundtable:index -->';
const REGION_END = '<!-- roundtable:index:end -->';
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const isRow = (l) => /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(l);

// The index: create it, or replace this slug's row inside our marked region. A legacy index
// (written before the markers, recognised by its whole header, not by a date column) is
// converted, keeping what was written around its table. Returns null for any other file.
export function updateIndex(existing, meta) {
  const row = `| ${meta.date} | ${cell(meta.title)} | ${cell(meta.chosen)} | ${meta.status} | [${meta.file}](./${meta.file}) |`;
  const region = (oldRows) => {
    const rows = oldRows.filter(isRow).filter((l) => !l.includes(`](./${meta.file})`));
    rows.push(row);
    rows.sort((a, b) => (b.slice(2, 12).localeCompare(a.slice(2, 12))) || a.localeCompare(b));
    return [REGION_START, ...TABLE_HEAD, ...rows, REGION_END];
  };
  if (existing == null) return [...INDEX_INTRO, ...region([]), ''].join('\n');
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);
  const start = lines.indexOf(REGION_START), end = lines.indexOf(REGION_END);
  if (start >= 0 && end > start) return [...lines.slice(0, start), ...region(lines.slice(start + 1, end)), ...lines.slice(end + 1)].join(eol);
  // legacy: our title, our sentence, our exact table header
  const header = lines.indexOf(TABLE_HEAD[0]);
  const legacy = lines[0] === INDEX_INTRO[0] && lines.some((l) => l.startsWith('One file per roundtable debate') && l.includes('Written by `npm run export`')) && header > 0 && lines[header + 1] === TABLE_HEAD[1];
  if (!legacy) return null;
  let after = header + 2;
  while (after < lines.length && isRow(lines[after])) after++;
  return [...lines.slice(0, header), ...region(lines.slice(header + 2, after)), ...lines.slice(after)].join(eol);
}

// A record file is ours when its front matter names this slug under `roundtable:`; a legacy
// record (before that key) when it has our `slug:` line and our opening sentence.
export function ownsRecord(text, slug) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
  if (new RegExp(`^roundtable: ${slug}$`, 'm').test(front)) return true;
  return new RegExp(`^slug: ${slug}$`, 'm').test(front) && /\nDecided by a roundtable of \d+ seats on /.test(text); // the 0.2.0 sentence
}

// An existing directory, as an absolute path. Records are named from the slug, which is
// restricted to [a-z0-9-], so the written path can only be directly inside it.
// forbid: further directories the caller will not write into (the server's own debates dir).
export function validateTarget(target, { forbid = [] } = {}) {
  if (!target || typeof target !== 'string') throw new Error('Export needs a target directory.');
  const abs = path.resolve(target);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Export target is not an existing directory: ${abs}`);
  const same = (dir) => path.relative(path.resolve(dir), abs) === '';
  if (path.parse(abs).root === abs) throw new Error(`Refusing to export into a filesystem root: ${abs}`);
  if (same(os.homedir())) throw new Error(`Refusing to export into the home directory: ${abs}. Pick a decisions folder inside a project.`);
  for (const f of forbid) if (same(f)) throw new Error(`Refusing to export into ${abs}: roundtable keeps its own transcripts there.`);
  return abs;
}

export function recordPath(target, slug, opts) {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Bad slug: ${slug}`);
  const abs = validateTarget(target, opts);
  const file = path.resolve(abs, `${slug}.md`);
  if (path.dirname(file) !== abs) throw new Error('Refusing to write outside the target directory.');
  return file;
}

// Temp file in the same directory, then rename: a reader never sees half a file.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// Every check runs before the first write, so a refusal leaves the directory untouched.
export function exportDebate(rows, slug, target, opts) {
  const file = recordPath(target, slug, opts);
  if (existsSync(file) && !ownsRecord(readFileSync(file, 'utf8'), slug)) throw new Error(`Refusing to replace ${file}: it was not written by roundtable for this debate.`);
  const { markdown, meta } = decisionRecord(rows, slug, opts);
  let indexPath = null, indexText = null;
  for (const name of ['README.md', 'DECISIONS.md']) {
    const p = path.join(path.dirname(file), name);
    const next = updateIndex(existsSync(p) ? readFileSync(p, 'utf8') : null, meta);
    if (next != null) { indexPath = p; indexText = next; break; }
  }
  if (!indexPath) throw new Error(`Refusing to export into ${path.dirname(file)}: README.md and DECISIONS.md both exist and neither is a roundtable index.`);
  writeAtomic(file, markdown);
  writeAtomic(indexPath, indexText);
  return { path: file, indexPath, meta };
}
