import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeProgress, progressText } from '../src/progress.js';
import { makeAdapter } from '../src/adapters/common.js';
import { createDebate } from '../src/engine.js';

test('transport diagnostics admit only bounded numbers and fixed stages, never provider content', () => {
  const raw = { elapsedMs: 300000, timeoutMs: 300000, firstOutputMs: 2000, idleMs: 290000,
    stdoutBytes: 400, stderrBytes: 0, eventCount: 3, stage: 'reasoning', outcome: 'timeout',
    prompt: 'PRIVATE-MARKER', reasoning: 'PRIVATE-MARKER', sessionId: 'PRIVATE-MARKER', tool: 'PRIVATE-MARKER' };
  const safe = safeProgress(raw);
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE-MARKER|prompt|sessionId|tool/);
  assert.match(progressText(safe), /First output after 2 s.*last 290 s.*reasoning/);
  assert.deepEqual(safeProgress({ elapsedMs: -1, eventCount: Infinity, exitCode: '0', stage: 'PRIVATE-MARKER', outcome: 'PRIVATE-MARKER' }), {});
  assert.match(progressText({ elapsedMs: 100, stdoutBytes: 0, stderrBytes: 0 }), /No provider output arrived/);
});

test('CLI timeouts distinguish no output, reasoning stalls and completed usage before a stuck exit', async () => {
  const cases = [
    { prelude: '', stage: 'waiting', known: false },
    { prelude: JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'PRIVATE-MARKER' } }) + '\n', stage: 'reasoning', known: false },
    { prelude: [
      { type: 'item.completed', item: { type: 'agent_message', text: 'PRIVATE-MARKER' } },
      { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5 } },
    ].map(JSON.stringify).join('\n') + '\n', stage: 'completed', known: true },
  ];
  try {
    for (const c of cases) {
      process.env.FAKE_SHAPE = 'codex'; process.env.FAKE_SLEEP = '10000'; process.env.FAKE_PRELUDE = c.prelude;
      const run = makeAdapter('codex', { bin: { file: process.execPath, prefix: [path.resolve('test/fixtures/fake-cli.mjs')] } });
      await assert.rejects(run('synthetic question', null, { timeoutMs: 1500 }), (e) => {
        assert.equal(e.kind, 'timeout');
        assert.equal(e.progress.stage, c.stage);
        assert.equal(e.progress.outcome, 'timeout');
        assert.ok(e.progress.elapsedMs >= 1400);
        assert.equal(!!e.usage, c.known);
        assert.doesNotMatch(JSON.stringify(e.progress) + e.message, /PRIVATE-MARKER/);
        if (c.known) assert.equal(e.usage.input, 20);
        else assert.equal(e.usage, null);
        return true;
      });
    }
  } finally { for (const k of ['FAKE_SHAPE', 'FAKE_SLEEP', 'FAKE_PRELUDE']) delete process.env[k]; }
});

test('failed attempts and replies save sanitized transport details without a paid timeout retry', async () => {
  const rows = [], calls = [];
  await createDebate({ fieldNotes: { decision: 'Trial?', options: ['Trial', 'Wait'] }, seats: [{ vendor: 'codex', lens: 'risk' }, { vendor: 'claude', lens: 'cost' }],
    options: { critiqueRounds: 0 }, store: { append: (r) => rows.push(r) }, gate: async () => ({ action: 'continue' }),
    runner: async (vendor) => { calls.push(vendor); throw Object.assign(new Error('Timed out.'), { kind: 'timeout', code: 'TIMEOUT', progress: {
      elapsedMs: 300000, stage: 'reasoning', eventCount: 3, raw: 'PRIVATE-MARKER',
    } }); },
  }).run();
  assert.equal(calls.length, 2);
  assert.equal(rows.filter((r) => r.type === 'attempt').length, 2);
  for (const r of rows.filter((r) => ['attempt', 'reply'].includes(r.type))) {
    assert.deepEqual(r.progress, { elapsedMs: 300000, eventCount: 3, stage: 'reasoning' });
    if (r.type === 'attempt') assert.equal(r.usage, null);
  }
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE-MARKER/);
});
