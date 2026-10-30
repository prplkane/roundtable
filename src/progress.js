// Safe transport metadata shared by adapters, saved attempts, diagnostics and the board.
// Never accept provider text, names, paths, IDs or arbitrary event fields here.
const BOUNDS = { elapsedMs: 86_400_000, timeoutMs: 10_800_000, firstOutputMs: 86_400_000,
  idleMs: 86_400_000, stdoutBytes: 16 * 1024 * 1024, stderrBytes: 16 * 1024 * 1024,
  eventCount: 1_000_000, exitCode: 4_294_967_295 };
const STAGES = new Set(['waiting', 'started', 'reasoning', 'reply', 'completed', 'tool', 'headers', 'body']);
const OUTCOMES = new Set(['exited', 'timeout', 'cancelled', 'spawn-error', 'policy', 'output-limit', 'protocol']);

export function safeProgress(input) {
  const out = {};
  for (const [key, max] of Object.entries(BOUNDS)) if (Number.isSafeInteger(input?.[key]) && input[key] >= 0 && input[key] <= max) out[key] = input[key];
  if (STAGES.has(input?.stage)) out.stage = input.stage;
  if (OUTCOMES.has(input?.outcome)) out.outcome = input.outcome;
  return out;
}

export function progressText(input) {
  const p = safeProgress(input);
  if (p.elapsedMs == null) return '';
  const seconds = (ms) => `${Math.round(ms / 1000)} s`;
  const parts = [`Elapsed ${seconds(p.elapsedMs)}${p.timeoutMs == null ? '' : `; limit ${seconds(p.timeoutMs)}`}.`];
  if (p.firstOutputMs == null && p.stdoutBytes === 0 && p.stderrBytes === 0) parts.push('No provider output arrived.');
  else if (p.firstOutputMs != null) parts.push(`First output after ${seconds(p.firstOutputMs)}; no output for the last ${seconds(p.idleMs || 0)}.`);
  const stages = { waiting: 'waiting for output', started: 'call started', reasoning: 'reasoning', reply: 'reply received', completed: 'completion received', tool: 'tool activity', headers: 'HTTP headers received', body: 'HTTP body arriving' };
  if (p.stage) parts.push(`Last observed stage: ${stages[p.stage]}.`);
  if (p.exitCode != null) parts.push(`Exit code ${p.exitCode}.`);
  return parts.join(' ');
}
