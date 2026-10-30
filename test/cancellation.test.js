import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebate } from '../src/engine.js';
import { rebuildDebate } from '../src/store.js';
import { ceremonyOutcome } from '../src/review-view.js';

const fieldNotes = { decision: 'Synthetic cancellation check', options: ['Trial', 'Wait'] };
const seats = [{ vendor: 'claude', lens: 'risk' }, { vendor: 'codex', lens: 'cost' }];
const reply = 'STANCE: opt-1\nAGREE_WITH: []\nDISAGREE: none\nNEW: none\nASSUMPTIONS: bounded trial';
const verdict = 'RECOMMENDATION: opt-1\nTry it.\nDISSENT: cost\nKILL_CRITERIA: overrun\nOPEN_QUESTIONS: date';
const response = (text) => ({ text, usage: { input: 10, output: 5 } });

for (const trigger of ['Stop', 'saving a reply']) {
  test(`a failed disk write while ${trigger} still cancels every active call`, async () => {
    let refuseWrites = false, arrived = 0, entered, finishFirst;
    const ready = new Promise((resolve) => { entered = resolve; });
    const signals = [], cancellations = [];
    const failure = Object.assign(new Error('Synthetic full disk'), { code: 'ENOSPC' });
    const d = createDebate({ fieldNotes, seats, options: { critiqueRounds: 0 },
      store: { append() { if (refuseWrites) throw failure; } },
      cancel: (reason) => cancellations.push(reason), gate: async () => ({ action: 'continue' }),
      runner: async (_, __, ___, { seat, signal }) => {
        signals.push(signal);
        if (++arrived === seats.length) entered();
        return new Promise((resolve, reject) => {
          if (seat.id === 'seat-0') finishFirst = () => resolve(response(reply));
          signal.addEventListener('abort', () => reject(Object.assign(new Error('Synthetic cancellation'), { code: 'KILLED' })), { once: true });
        });
      },
    });
    const running = d.run();
    const failed = assert.rejects(running, (error) => error === failure);
    await ready; refuseWrites = true;
    if (trigger === 'Stop') assert.throws(() => d.requestStop('Cancel now.'), (error) => error === failure);
    else finishFirst();
    await failed;
    assert.ok(signals.every((signal) => signal.aborted), 'no provider call survives the storage error');
    assert.deepEqual(cancellations, [trigger === 'Stop' ? 'human' : 'error']);
    assert.equal(d.state.status, 'error');
    assert.equal(arrived, seats.length, 'no retry or chairman call starts');
  });
}

for (const phase of ['seat', 'chairman']) {
  test(`a ${phase} network retry is refused if the deadline passes during its delay`, async () => {
    let clock = 0, failed = false;
    const calls = [], rows = [];
    const state = await createDebate({ fieldNotes, seats, now: () => clock,
      options: { critiqueRounds: 0, wallClockMs: 10_000, networkRetryMs: 10 },
      gate: async () => ({ action: 'continue' }), store: { append: (row) => rows.push(row) },
      emit: (_, event) => {
        // Advance only after retry eligibility was checked, while its delay is pending.
        if (event.type === 'attempt' && event.errorKind === 'network') setTimeout(() => { clock = 10_001; }, 0);
      },
      runner: async (_, __, ___, { seat }) => {
        calls.push({ seat: seat.id, at: clock });
        if (!failed && seat.id === (phase === 'seat' ? 'seat-0' : 'chairman')) {
          failed = true; throw Object.assign(new Error('Synthetic network failure'), { kind: 'network' });
        }
        return response(seat.id === 'chairman' ? verdict : reply);
      },
    }).run();
    assert.ok(failed, 'the initial network attempt ran');
    assert.equal(calls.length, phase === 'seat' ? 2 : 3, 'the retry never reaches the runner');
    assert.ok(calls.every((call) => call.at < state.deadlineAt));
    assert.equal(rows.filter((row) => row.type === 'attempt').length, calls.length, 'refused calls add no usage attempt');
    const stopped = phase === 'seat' ? state.rounds[0][0] : state.verdict;
    assert.equal(stopped.cancelReason, 'wall-clock');
  });
}

test('Finish with verdict at the blind gate works with zero critique rounds', async () => {
  let calls = 0;
  const events = [], rows = [];
  const state = await createDebate({ fieldNotes, seats, options: { critiqueRounds: 0 },
    runner: async (_, __, ___, { seat, signal }) => { calls++; assert.equal(signal.aborted, false); return response(seat.id === 'chairman' ? verdict : reply); },
    gate: async () => ({ action: 'finish', message: 'Use the replies we have.', source: 'agent' }),
    store: { append: (row) => rows.push(row) }, emit: (_, event) => events.push(event),
  }).run();
  assert.equal(calls, 3, 'two blind replies and one verdict');
  assert.equal(state.rounds.length, 1);
  assert.equal(state.stopReason, 'finish');
  assert.equal(state.verdict.failed, false);
  assert.equal(ceremonyOutcome(events.at(-1)), 'verdict');
  assert.equal(rows.find((r) => r.type === 'human').source, 'agent');
});

for (const abortEverything of [false, true]) {
  test(`Finish during a critique cancels seats ${abortEverything ? 'and Stop can override it' : 'but allows one verdict'}`, { timeout: 3000 }, async () => {
    let entered, arrivals = 0, cancelledSeats = 0, chairCalls = 0;
    const inFlight = new Promise((resolve) => { entered = resolve; });
    const events = [];
    const d = createDebate({ fieldNotes, seats, options: { critiqueRounds: 3 }, emit: (_, event) => events.push(event),
      gate: async () => ({ action: 'continue', message: 'Reconsider the blind consensus.' }),
      runner: async (_, prompt, __, { seat, signal }) => {
        if (seat.id === 'chairman') {
          chairCalls++; assert.equal(signal.aborted, false);
          assert.match(prompt, /bounded trial/);
          return response(verdict);
        }
        if (!/^Round 1 of/m.test(prompt)) return response(reply);
        if (++arrivals === 2) entered();
        return new Promise((_, reject) => signal.addEventListener('abort', () => {
          cancelledSeats++; reject(Object.assign(new Error('cancel fixture'), { code: 'KILLED', usage: { input: 1, output: 0 } }));
        }, { once: true }));
      },
    });
    assert.equal(d.requestFinish(), false, 'no completed round yet');
    const running = d.run(); await inFlight;
    assert.equal(d.canFinish(), true);
    assert.equal(d.requestFinish('End discussion here.'), true);
    assert.equal(d.requestFinish(), false, 'no duplicate finish');
    if (abortEverything) d.requestStop('Abort the verdict too.');
    const state = await running;
    assert.equal(cancelledSeats, 2);
    assert.equal(arrivals, 2, 'no extra discussion attempt');
    assert.equal(chairCalls, abortEverything ? 0 : 1);
    assert.equal(state.stopReason, abortEverything ? 'human' : 'finish');
    assert.equal(ceremonyOutcome(events.at(-1)), abortEverything ? 'cancelled' : 'verdict');
    assert.ok(state.rounds[1].every((r) => r.cancelReason === (abortEverything ? 'human' : 'finish')));
  });
}

test('Finish is refused if a completed round contains only failed or PASS replies', async () => {
  for (const text of ['PASS', 'off contract']) {
    let d;
    d = createDebate({ fieldNotes, seats, options: { critiqueRounds: 0 },
      runner: async () => response(text), gate: async () => {
        assert.equal(d.canFinish(), false);
        assert.equal(d.requestFinish(), false);
        return { action: 'finish' }; // an injected gate must not dispatch an empty verdict either
      },
    });
    assert.equal((await d.run()).verdict.skipped, true);
  }
});

test('Stop at a gate starts no chairman; writing a verdict later requires a new request', async () => {
  const calls = [], events = [], rows = [];
  const state = await createDebate({ fieldNotes, seats, options: { critiqueRounds: 0 },
    runner: async (_, prompt) => { calls.push(prompt); return response(reply); },
    gate: async () => ({ action: 'stop', message: 'Save my reason.' }),
    store: { append: (row) => rows.push(row) }, emit: (_, event) => events.push(event),
  }).run();
  assert.equal(calls.length, 2);
  assert.equal(state.stopReason, 'human');
  assert.equal(state.verdict.skipped, true);
  assert.equal(events.at(-1).cancelled, true);
  assert.equal(ceremonyOutcome(events.at(-1)), 'cancelled');
  const rebuilt = rebuildDebate(rows);
  assert.equal(rebuilt.finished, true);
  assert.equal(rebuilt.synthesis, 'skipped');
  const later = [];
  await createDebate({ fieldNotes, seats, synthesisOnly: true, resume: rebuilt,
    runner: async (_, prompt) => { calls.push(prompt); return response(verdict); }, emit: (_, event) => later.push(event),
  }).run();
  assert.equal(calls.length, 3);
  assert.match(calls.at(-1), /Save my reason/);
  assert.equal(later.at(-1).cancelled, false);
  assert.equal(ceremonyOutcome(later.at(-1)), 'verdict');
});

test('automatic completion cannot request a verdict without usable replies', async () => {
  for (const text of ['PASS', 'off contract', null]) {
    let chairCalls = 0;
    const state = await createDebate({ fieldNotes, seats, options: { critiqueRounds: 0 },
      runner: async (_, __, ___, { seat }) => {
        if (seat.id === 'chairman') { chairCalls++; return response(verdict); }
        if (text === null) throw new Error('Synthetic provider failure');
        return response(text);
      }, gate: async () => ({ action: 'continue' }),
    }).run();
    assert.equal(chairCalls, 0);
    assert.equal(state.verdict.skipped, true);
    assert.equal(state.verdict.reason, 'no-round');
  }
});

for (const phase of ['first call', 'format retry', 'fallback']) {
  test(`Stop cancels the chairman during ${phase} and never starts another attempt`, { timeout: 3000 }, async () => {
    const rows = [], events = [], cancelled = [];
    let entered, aborted = false, chairCalls = 0;
    const inFlight = new Promise((resolve) => { entered = resolve; });
    const d = createDebate({ fieldNotes, seats, options: { critiqueRounds: 0, networkRetryMs: 0 },
      store: { append: (row) => rows.push(row) }, emit: (_, event) => events.push(event),
      gate: async () => ({ action: 'continue' }), cancel: (reason) => cancelled.push(reason),
      runner: async (_, prompt, __, { seat, signal }) => {
        if (seat.id !== 'chairman') return response(reply);
        chairCalls++;
        if (chairCalls === 1 && phase === 'format retry') return response('off contract');
        if (chairCalls === 1 && phase === 'fallback') throw Object.assign(new Error('quota fixture'), { kind: 'quota', usage: { input: 1, output: 0 } });
        entered();
        return new Promise((_, reject) => signal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('cancel fixture'), { code: 'KILLED', usage: { input: 3, output: 1 } }));
        }, { once: true }));
      },
    });
    const running = d.run(); await inFlight;
    d.requestStop('Stop the whole review.');
    d.requestStop('Duplicate click.');
    const state = await running;
    assert.equal(aborted, true);
    assert.deepEqual(cancelled, ['human']);
    assert.equal(chairCalls, phase === 'first call' ? 1 : 2);
    assert.equal(state.stopReason, 'consensus', 'synthesis cancellation preserves the completed discussion reason');
    assert.equal(state.verdict.skipped, true);
    assert.equal(state.verdict.reason, 'human');
    assert.equal(ceremonyOutcome(events.at(-1)), 'cancelled');
    assert.equal(rows.filter((r) => r.type === 'human').length, 1);
    const attempt = rows.filter((r) => r.type === 'attempt').at(-1);
    assert.equal(attempt.cancelReason, 'human');
    assert.equal(attempt.usage.input, 3, 'cancelled spend is retained');
    assert.equal(rebuildDebate(rows).stopReason, 'consensus', 'the discussion reason is preserved on reload');
    assert.equal(rows.filter((r) => r.type === 'synthesis-cancelled').length, 1);
  });
}

test('a chairman result arriving after Stop cannot turn cancellation into success', async () => {
  let entered, finish;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const rows = [], events = [];
  const d = createDebate({ fieldNotes, seats, options: { critiqueRounds: 0 },
    store: { append: (row) => rows.push(row) }, emit: (_, event) => events.push(event),
    gate: async () => ({ action: 'continue' }),
    runner: async (_, __, ___, { seat }) => {
      if (seat.id !== 'chairman') return response(reply);
      entered(); await pending; return response(verdict);
    },
  });
  const run = d.run(); await waiting; d.requestStop(); finish(); const state = await run;
  assert.equal(state.verdict.skipped, true);
  assert.equal(ceremonyOutcome(events.at(-1)), 'cancelled');
  assert.equal(rows.filter((r) => r.type === 'attempt').at(-1).usage.output, 5);
  assert.equal(rows.filter((r) => r.type === 'attempt').at(-1).cancelReason, 'human');
});
