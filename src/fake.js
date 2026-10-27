// A scripted runner for trying the board without spending tokens: `node src/server.js --fake`.
// With `--fake-consensus` every seat takes the first option in rounds 0 and 1, so the board shows
// the unanimous round-0 gate and, after a note, the reopened round 1 stopping on consensus.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr, i) => arr[i % arr.length];

// A plausible quota snapshot so the strip can be seen without real seats.
// Reset times are fixed at load so snapshots compare as the same window (a moved reset time
// marks a rolled-over window and voids the delta; see estimate.js windowDeltas).
const BOOT = Math.floor(Date.now() / 1000);
let codexCalls = 0;
export function fakeQuota(vendor, n = vendor === 'codex' ? codexCalls++ : 0) {
  return {
    windows: [
      { label: '5h', used: Math.min(0.95, 0.12 + n * 0.07), resetsAt: BOOT + 3 * 3600 + 600 },
      { label: '7d', used: Math.min(0.95, 0.31 + n * 0.02), resetsAt: BOOT + 2 * 86400 + 5 * 3600 },
    ],
    plan: vendor === 'codex' ? 'fake' : null,
    at: Date.now(),
  };
}

export function fakeRunner({ consensus = false } = {}) {
  let calls = 0;
  return async (vendor, prompt, sessionId, opts = {}) => {
    const n = calls++;
    // Behaviour follows the seat's position at the table, so two seats of one vendor still differ.
    const idx = opts.seat?.index ?? (/chairman/i.test(prompt) ? -1 : n % 3);
    const who = idx === 0 ? 'claude' : idx === 1 ? 'codex' : 'agy'; // the v1 script's three roles
    await sleep(800 + Math.random() * 1500);
    const round = Number((prompt.match(/^Round (\d+) of/m) || [])[1] ?? (/chairman/i.test(prompt) ? -1 : 0));
    // OPTIONS: opt-1 = Ship now | opt-2 = Wait a sprint (the chairman sees the same line)
    const options = (prompt.match(/^OPTIONS: (.+)$/m)?.[1] || '').split(' | ').map((o) => o.replace(/^opt-\d+ = /, '')).slice(0, 4);
    const usage = { input: 9000 + n * 1200, cacheRead: n * 400, cacheWrite: 0, output: 180 + (n % 5) * 40, thinking: 60, cost: vendor === 'claude' ? 0.11 + n * 0.02 : null, ms: 900, usageVersion: 3 };
    let text;
    if (round === -1) {
      text = `RECOMMENDATION: opt-1\n${pick(options, 0)}, on the balance of risk and cost; the customer lens did not overturn it.\nDISSENT: The customer lens argued that ${pick(options, 1)} protects adoption; that risk is real and should be watched.\nKILL_CRITERIA:\n- Support tickets about the change exceed 5% of weekly volume\n- The migration takes more than two sprints\nOPEN_QUESTIONS:\n- Is the deadline movable by a week?`;
    } else if (!consensus && round >= 2 && who === 'codex') {
      text = 'PASS';
    } else if (!consensus && round === 0 && who === 'agy' && !/did not follow the contract/.test(prompt)) {
      text = `I think ${pick(options, 1)} is right because customers hate surprises.`; // off contract, forces a re-prompt
    } else {
      // claude answers with the id, the others with the exact label: the contract accepts both
      const n2 = !consensus && (who === 'agy' || idx >= 3) ? 1 : 0;
      const stance = who === 'claude' ? `opt-${n2 + 1}` : pick(options, n2);
      text = [
        `STANCE: ${stance}`,
        `AGREE_WITH: [${round > 0 && who === 'claude' ? 'cost and effort' : ''}]`,
        'DISAGREE:', `- The ${who === 'agy' ? 'cost' : 'customer'} argument assumes a traffic pattern we have not measured`,
        'NEW:', round === 1 ? '- A staged rollout to 10% of accounts gives both sides their evidence' : '- none',
        'ASSUMPTIONS:', '- The team stays at two developers', '- No regulatory change before the deadline',
        !consensus && round === 0 ? `QUESTION_FOR_HUMAN: ${who === 'agy' ? 'What evidence would make you stop the trial?' : 'Is the deadline movable by one week?'}`
          : !consensus && round === 1 && who === 'agy' && !/Answer:/.test(prompt) ? 'QUESTION_FOR_HUMAN: Is the deadline movable by one week?' : null,
      ].filter(Boolean).join('\n');
    }
    const quota = vendor === 'claude' ? fakeQuota(vendor, n) : null; // claude's rides on each reply
    return { text, usage, sessionId: sessionId || `fake-${opts.seat?.id || vendor}-${n}`, quota, raw: {} };
  };
}
