// Local ACP peer. No vendor, network, credentials or project access.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode = process.env.ACP_FIXTURE_MODE || 'review';
const log = (event) => { if (process.env.ACP_FIXTURE_LOG) appendFileSync(process.env.ACP_FIXTURE_LOG, JSON.stringify({ pid: process.pid, ...event }) + '\n'); };
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const sid = `fixture-${process.pid}`;
const option = { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'fake-default', options: [{ value: 'fake-default', name: 'Default' }, { value: 'fake-choice', name: 'Choice' }] };
let pending;
log({ start: true, cwd: process.cwd(), script: process.argv[1] });
const reader = createInterface({ input: process.stdin });
if (mode === 'stubborn') setInterval(() => {}, 1000);
reader.on('close', () => { if (mode === 'stubborn') return; log({ exit: true }); process.exit(0); });
reader.on('line', (line) => {
  const message = JSON.parse(line);
  log({ rpc: message });
  const answer = (result) => send({ id: message.id, result });
  const update = (data) => send({ method: 'session/update', params: { sessionId: mode === 'wrong-session' ? 'other-session' : sid, update: data } });
  if (message.method === 'initialize') {
    if (mode === 'malformed') return process.stdout.write('not json\n');
    if (mode === 'large') return process.stdout.write('x'.repeat(9 * 1024 * 1024));
    if (mode === 'crash') return process.exit(2);
    const version = mode === 'version' ? 2 : message.params.protocolVersion;
    return answer({ protocolVersion: version,
      [version === 2 ? 'capabilities' : 'agentCapabilities']: {},
      [version === 2 ? 'info' : 'agentInfo']: { name: 'offline-roundtable-fixture', version: '1' }, authMethods: [] });
  }
  if (message.method === 'session/new') {
    if (mode === 'auth') return send({ id: message.id, error: { code: -32000, message: 'Login needed' } });
    if (mode === 'early-wrong-session') {
      const frames = [{ jsonrpc: '2.0', id: message.id, result: { sessionId: sid, configOptions: [option] } },
        { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'another-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wrong session' } } } }];
      return process.stdout.write(frames.map(JSON.stringify).join('\n') + '\n');
    }
    return answer({ sessionId: sid, configOptions: [option] });
  }
  if (message.method === 'session/set_config_option') return answer({ configOptions: [{ ...option, currentValue: message.params.value }] });
  if (message.method === 'session/cancel') {
    if (pending != null) send({ id: pending, result: { stopReason: 'cancelled' } });
    return;
  }
  if (message.method !== 'session/prompt') return;
  pending = message.id;
  if (mode === 'wait') return;
  if (mode === 'permission') return send({ id: 'tool-request', method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 'edit', title: 'Edit', kind: 'edit' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } });
  if (mode === 'filesystem') return send({ id: 'file-request', method: 'fs/read_text_file', params: { sessionId: sid, path: 'never-read' } });
  if (mode === 'tool') return update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit', kind: 'edit', status: 'pending' });
  const prompt = message.params.prompt.map((b) => b.text || '').join('');
  const stance = process.env.ACP_FIXTURE_STANCE || 'opt-1';
  const text = /^You are the chairman/m.test(prompt)
    ? 'RECOMMENDATION: opt-1\nChoose the reversible trial.\nDISSENT: The cost lens preferred waiting.\nKILL_CRITERIA:\n- Stop if the trial exceeds the agreed cost.\nOPEN_QUESTIONS:\n- OPTIONAL: Which metric should be monitored?'
    : `STANCE: ${stance}\nAGREE_WITH: []\nDISAGREE:\n- The rollout cost is uncertain\nNEW:\n- A reversible trial can provide evidence\nASSUMPTIONS:\n- The trial can be reversed`;
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(0, 20) } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(20) } });
  update({ sessionUpdate: 'usage_update', used: 999999, size: 1000000, cost: { amount: 0.01, currency: 'USD' } });
  const usage = mode === 'no-usage' ? {} : { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedReadTokens: 20 } };
  answer({ stopReason: mode === 'truncated' ? 'max_tokens' : 'end_turn', ...usage });
  if (mode === 'tail') process.stdout.write('{"unfinished":');
});
