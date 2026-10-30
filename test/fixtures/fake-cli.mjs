// A stand-in for a vendor CLI, run through node by the tests. It prints the vendor's verified
// output shape (claude stream-json, codex jsonl, agy json) and, when FAKE_RECORD names a file,
// writes its argv, cwd and the environment variables the adapters set, so a test can see what
// the real CLI would have seen. Never reads anything.
//   FAKE_SHAPE   claude | codex | agy        (default claude)
//   FAKE_TOOLS   1: the reply shows tool use in the stream
//   FAKE_SLEEP   milliseconds to stay alive before answering (child-process cleanup tests)
//   FAKE_EXIT    exit code to use after printing (default 0)
//   FAKE_IS_ERROR 1: claude's result line is an error (is_error: true), as for a usage limit
//   FAKE_USAGE missing | empty | partial | zero (default: reported fixture usage)
import { writeFileSync } from 'node:fs';

const shape = process.env.FAKE_SHAPE || 'claude';
const tools = process.env.FAKE_TOOLS === '1';
const text = process.env.FAKE_TEXT || 'STANCE: Ship now\nAGREE_WITH: []\nDISAGREE:\n- nothing\nNEW:\n- none\nASSUMPTIONS:\n- it holds';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', main);
process.stdin.resume();
if (process.stdin.isTTY) main();

async function main() {
  if (process.env.FAKE_RECORD) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE|CODEX|ANTHROPIC|FAKE|MAX_THINKING)/.test(k)));
    writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env, stdin }));
  }
  if (process.env.FAKE_PRELUDE) {
    const prelude = process.env.FAKE_PRELUDE;
    const split = Math.floor(prelude.length / 2);
    process.stdout.write(prelude.slice(0, split));
    await new Promise((r) => setTimeout(r, 10));
    process.stdout.write(prelude.slice(split));
  }
  if (process.env.FAKE_SLEEP) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLEEP)));
  const lines = [];
  if (shape === 'claude') {
    lines.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S1' }));
    if (tools) lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] }, session_id: 'S1' }));
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] }, session_id: 'S1' }));
    lines.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: process.env.FAKE_IS_ERROR === '1', result: text, session_id: 'S1', num_turns: tools ? 2 : 1, total_cost_usd: 0.01, usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 100, output_tokens: 20, output_tokens_details: { thinking_tokens: 0 } } }));
  } else if (shape === 'codex') {
    lines.push(JSON.stringify({ type: 'thread.started', thread_id: 'T1' }));
    lines.push(JSON.stringify({ type: 'turn.started' }));
    if (tools) lines.push(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', exit_code: 0 } }));
    lines.push(JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'reasoning', text: 'thinking' } }));
    lines.push(JSON.stringify({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text } }));
    lines.push(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 2 } }));
  } else {
    lines.push(JSON.stringify({ conversation_id: 'C1', status: 'SUCCESS', response: text, duration_seconds: 1, num_turns: tools ? 2 : 1, usage: { input_tokens: 40, output_tokens: 20, thinking_tokens: 3, cache_read_tokens: 0, total_tokens: 63 }, ...(tools ? { denied_actions: [{ action: 'run_command', display_name: 'ls' }] } : {}) }));
  }
  const output = lines.map((line) => {
    const row = JSON.parse(line);
    if (row.usage) {
      if (process.env.FAKE_USAGE === 'missing') delete row.usage;
      if (process.env.FAKE_USAGE === 'empty') row.usage = {};
      if (process.env.FAKE_USAGE === 'partial') row.usage = { input_tokens: 10 };
      if (process.env.FAKE_USAGE === 'zero') row.usage = { input_tokens: 0, output_tokens: 0 };
    }
    return JSON.stringify(shape === 'agy' && process.argv.includes('--input-format') ? { event: 'result', result: row } : row);
  });
  process.stdout.write(output.join('\n') + '\n');
  process.exit(Number(process.env.FAKE_EXIT || 0));
}
