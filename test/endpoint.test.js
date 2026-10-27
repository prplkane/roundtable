// The API endpoint adapter against a local OpenAI-compatible server (node:http on 127.0.0.1,
// port 0): what it sends, what it reads, how it fails. No network beyond loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { run, pickUsage, httpErrorKind, MAX_RESPONSE_BYTES } from '../src/adapters/endpoint.js';
import { killAll, liveChildren } from '../src/adapters/spawn.js';

// A scripted endpoint. `script(req, body)` returns { status, body (object or text), headers,
// delayMs, writeBody(res) }; every request is recorded with its headers and parsed body.
async function endpoint(script) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      let body = null; try { body = JSON.parse(raw); } catch {}
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const r = await script(req, body);
      if (r.delayMs) await new Promise((t) => setTimeout(t, r.delayMs));
      res.writeHead(r.status || 200, { 'content-type': 'application/json', ...(r.headers || {}) });
      if (r.writeBody) r.writeBody(res);
      else res.end(typeof r.body === 'string' || Buffer.isBuffer(r.body) ? r.body : JSON.stringify(r.body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/v1`;
  return { url, seen, close: () => new Promise((r) => srv.close(r)) };
}
const reply = (text, usage = { prompt_tokens: 120, completion_tokens: 30 }, extra = {}) => ({ status: 200, body: { id: 'x', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text, ...extra } }], usage } });

test('a call posts one user message to <base>/chat/completions with the model, no tools, and reads text and usage with one meaning', async () => {
  const ep = await endpoint(() => reply('STANCE: opt-1\nfine', { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 20 } }));
  try {
    const r = await run('hello', null, { endpoint: { url: ep.url }, model: 'llama3', timeoutMs: 5000, tag: 't1' });
    assert.equal(r.text, 'STANCE: opt-1\nfine');
    assert.equal(r.sessionId, null, 'stateless: nothing to resume');
    assert.equal(r.usedTools, false);
    assert.equal(r.usage.input, 600, 'subset semantics: input is the uncached part');
    assert.deepEqual([r.usage.cacheRead, r.usage.output, r.usage.thinking, r.usage.cost], [400, 50, 20, null]);
    assert.equal(r.usage.raw.input, 1000, 'the vendor figure is kept');
    const req = ep.seen[0];
    assert.equal(req.url, '/v1/chat/completions');
    assert.deepEqual(req.body, { model: 'llama3', messages: [{ role: 'user', content: 'hello' }], stream: false });
    assert.equal(req.headers.authorization, undefined, 'no key variable, no header');
    assert.deepEqual(Object.keys(r.raw).sort(), ['model', 'ms', 'status', 'url'], 'raw never carries headers');
  } finally { await ep.close(); }
});

test('the key is read by NAME from the environment and sent as a bearer only to that endpoint; effort rides as reasoning_effort only when set', async () => {
  const ep = await endpoint(() => reply('ok'));
  try {
    const env = { MY_KEY: 'sk-test-123' };
    await run('q', null, { endpoint: { url: ep.url, keyEnv: 'MY_KEY' }, model: 'm', effort: 'high', env, timeoutMs: 5000 });
    assert.equal(ep.seen[0].headers.authorization, 'Bearer sk-test-123');
    assert.equal(ep.seen[0].body.reasoning_effort, 'high');
    await run('q', null, { endpoint: { url: ep.url, keyEnv: 'MY_KEY' }, model: 'm', env, timeoutMs: 5000 });
    assert.equal(ep.seen[1].body.reasoning_effort, undefined, 'no effort set: the field is absent');
    // the variable is named but empty: an auth failure before any request leaves this machine
    await assert.rejects(run('q', null, { endpoint: { url: ep.url, keyEnv: 'MY_KEY' }, model: 'm', env: {}, timeoutMs: 5000 }), (e) => e.kind === 'auth' && /MY_KEY is not set/.test(e.message) && !/sk-/.test(e.message));
    assert.equal(ep.seen.length, 2);
    // the field must be a variable name: a pasted key is refused on shape
    await assert.rejects(run('q', null, { endpoint: { url: ep.url, keyEnv: 'sk-test-123' }, model: 'm', env, timeoutMs: 5000 }), /not the name of an environment variable/);
  } finally { await ep.close(); }
});

test('DeepSeek-style usage names the cache hit its own way; content parts are joined; tool_calls count as tool use', async () => {
  assert.deepEqual(pickUsage({ prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 20 }), { input: 50, cacheRead: 30, cacheWrite: 0, output: 5, thinking: 0 });
  assert.equal(pickUsage(undefined), null, 'omitted usage is unknown, not a measured zero');
  const ep = await endpoint((req, body) => (body.messages[0].content === 'parts'
    ? reply([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])
    : reply('', undefined, { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] })));
  try {
    assert.equal((await run('parts', null, { endpoint: { url: ep.url }, model: 'm', timeoutMs: 5000 })).text, 'ab');
    const t = await run('tools', null, { endpoint: { url: ep.url }, model: 'm', timeoutMs: 5000 });
    assert.equal(t.usedTools, true, 'no tools were offered, so a tool call is a contract violation for the guard');
  } finally { await ep.close(); }
});

test('missing or unusable endpoint usage stays unknown; explicit zero counters are reported', async () => {
  const unknown = [null, {}, { prompt_tokens: 10 }, { completion_tokens: 2 },
    { prompt_tokens: '10', completion_tokens: 2 }, { prompt_tokens: -1, completion_tokens: 2 },
    { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 'bad' } }];
  for (const usage of unknown) assert.equal(pickUsage(usage), null, JSON.stringify(usage));
  assert.equal(pickUsage({ prompt_tokens: Infinity, completion_tokens: 2 }), null);
  const ep = await endpoint((req, body) => reply('ok', body.messages[0].content === 'zero' ? { prompt_tokens: 0, completion_tokens: 0 } : null));
  try {
    const opts = { endpoint: { url: ep.url }, model: 'm', timeoutMs: 5000 };
    assert.equal((await run('missing', null, opts)).usage, null);
    assert.equal((await run('zero', null, opts)).usage.input, 0);
  } finally { await ep.close(); }
});

test('failures are classified: nothing listening is network, a slow server is timeout, killAll(tag) aborts the request as killed, non-JSON and empty replies are other', async () => {
  const dead = await endpoint(() => reply('x'));
  const url = dead.url; await dead.close();
  await assert.rejects(run('q', null, { endpoint: { url }, model: 'm', timeoutMs: 5000 }), (e) => e.kind === 'network' && /could not reach 127\.0\.0\.1/.test(e.message));

  const slow = await endpoint(() => ({ ...reply('late'), delayMs: 1000 }));
  try {
    await assert.rejects(run('q', null, { endpoint: { url: slow.url }, model: 'm', timeoutMs: 300 }), (e) => e.kind === 'timeout' && e.code === 'TIMEOUT');
    const p = run('q', null, { endpoint: { url: slow.url }, model: 'm', timeoutMs: 10_000, tag: 'debate-x' });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(liveChildren('debate-x').map((x) => x.tag), ['debate-x'], 'the request is registered under the debate');
    assert.equal(killAll('debate-x', { kill: () => { throw new Error('a request is not a process'); } }), 1);
    await assert.rejects(p, (e) => e.kind === 'killed' && e.code === 'KILLED');
    assert.equal(liveChildren('debate-x').length, 0);
  } finally { await slow.close(); }

  const odd = await endpoint((req, body) => (body.messages[0].content === 'html' ? { status: 200, body: '<html>proxy page</html>' } : reply('')));
  try {
    await assert.rejects(run('html', null, { endpoint: { url: odd.url }, model: 'm', timeoutMs: 5000 }), (e) => e.kind === 'other' && /other than JSON/.test(e.message));
    await assert.rejects(run('empty', null, { endpoint: { url: odd.url }, model: 'm', timeoutMs: 5000 }), (e) => e.kind === 'other' && /empty reply/.test(e.message));
  } finally { await odd.close(); }
});

test('an HTTP error carries the status and the body\'s first words, through httpErrorKind, and the seat rules refuse a bad endpoint before any request', async () => {
  const ep = await endpoint(() => ({ status: 400, body: { error: { message: 'unknown field reasoning_effort' } } }));
  try {
    await assert.rejects(run('q', null, { endpoint: { url: ep.url }, model: 'm', effort: 'low', timeoutMs: 5000 }), (e) => e.raw.status === 400 && /400/.test(e.message) && /reasoning_effort/.test(e.message) && typeof e.kind === 'string');
  } finally { await ep.close(); }
  assert.deepEqual(Object.keys(httpErrorKind(500, 'x')).sort(), ['kind', 'message', 'resetsAt']);
  // each status family: what the engine does next depends on the kind
  const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
  for (const s of [401, 403]) assert.equal(httpErrorKind(s, 'invalid api key').kind, 'auth', `${s}: a refused key benches the host`);
  assert.equal(httpErrorKind(402, 'Insufficient Balance').kind, 'quota', '402: no credit benches the host');
  for (const s of [500, 502, 503, 504, 529]) assert.equal(httpErrorKind(s).kind, 'network', `${s}: the service, worth the one retry`);
  for (const s of [400, 404, 422]) assert.equal(httpErrorKind(s).kind, 'other', `${s}: this seat, this round`);
  const limited = httpErrorKind(429, 'quota exceeded', '30', NOW);
  assert.deepEqual([limited.kind, limited.resetsAt], ['quota', NOW + 30_000], '429 benches the host; Retry-After in seconds');
  assert.match(limited.message, /HTTP 429.*: quota exceeded$/, 'the server\'s own words reach the card');
  assert.equal(httpErrorKind(429, '', 'Wed, 22 Oct 2026 14:00:00 GMT', NOW).resetsAt, Date.UTC(2026, 9, 22, 14, 0, 0), 'Retry-After as an HTTP date');
  assert.equal(httpErrorKind(429, '', 'soon', NOW).resetsAt, null, 'an unreadable Retry-After is no reset time');
  assert.equal(httpErrorKind(429).resetsAt, null);
  assert.ok(!/sk-/.test(httpErrorKind(401, 'bad key').message), 'no key in a message');
  await assert.rejects(run('q', null, { endpoint: { url: 'http://api.example.com/v1' }, model: 'm' }), /plain http only/);
  await assert.rejects(run('q', null, { endpoint: { url: 'http://localhost:11434/v1' } }), /no model id/);
});

test('the adapter rejects private-looking public DNS before any request, including stored seat URLs', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unexpected request'); });
  for (const host of ['10.api.example.com', '127.api.example.com', '192.168.api.example.com', '169.254.api.example.com', '172.16.api.example.com', '%31%30.api.example.com']) {
    await assert.rejects(run('q', null, { endpoint: { url: `http://${host}/v1`, keyEnv: 'K' }, env: { K: 'synthetic-value' }, model: 'm' }), /plain http only/);
  }
  assert.equal(requests, 0);
});

const oversized = (e) => e.kind === 'other' && e.code === 'RESPONSE_TOO_LARGE' && /1 MiB/.test(e.message);

test('the response limit rejects oversized success and error bodies and counts UTF-8 bytes', async () => {
  const body = JSON.stringify(reply('界'.repeat(Math.floor(MAX_RESPONSE_BYTES / 3) + 1)).body);
  assert.ok(body.length < MAX_RESPONSE_BYTES, 'a character limit would miss this body');
  assert.ok(Buffer.byteLength(body) > MAX_RESPONSE_BYTES);
  for (const status of [200, 500]) {
    const ep = await endpoint(() => ({ status, body }));
    try {
      await assert.rejects(run('q', null, { endpoint: { url: ep.url }, model: 'm', timeoutMs: 5000, tag: 'size-test' }), oversized);
      assert.equal(liveChildren('size-test').length, 0, 'failed reads release their call registration');
    } finally { await ep.close(); }
  }
});

test('a valid response at the byte limit and a small compressed response still work', async () => {
  const count = MAX_RESPONSE_BYTES - Buffer.byteLength(JSON.stringify(reply('').body));
  const body = JSON.stringify(reply('x'.repeat(count)).body);
  assert.equal(Buffer.byteLength(body), MAX_RESPONSE_BYTES);
  const ep = await endpoint((req, request) => request.messages[0].content === 'compressed'
    ? { body: gzipSync(JSON.stringify(reply('small compressed reply').body)), headers: { 'content-encoding': 'gzip' } }
    : { body, headers: { 'content-length': String(Buffer.byteLength(body)) } });
  try {
    assert.equal((await run('boundary', null, { endpoint: { url: ep.url }, model: 'm', timeoutMs: 5000 })).text.length, count);
    assert.equal((await run('compressed', null, { endpoint: { url: ep.url }, model: 'm', timeoutMs: 5000 })).text, 'small compressed reply');
  } finally { await ep.close(); }
});

test('compressed success and error bodies cannot evade the decoded-byte limit', async () => {
  const body = gzipSync(JSON.stringify(reply('x'.repeat(MAX_RESPONSE_BYTES)).body));
  assert.ok(body.length < MAX_RESPONSE_BYTES, 'the wire length alone is within the limit');
  for (const status of [200, 500]) {
    const ep = await endpoint(() => ({ status, body, headers: { 'content-encoding': 'gzip', 'content-length': String(body.length) } }));
    try {
      await assert.rejects(run('q', null, { endpoint: { url: ep.url }, model: 'm', timeoutMs: 5000 }), oversized);
    } finally { await ep.close(); }
  }
});

test('oversized declared and open chunked responses are cancelled without waiting for their end', async () => {
  for (const declared of [true, false]) {
    let onClose;
    const closed = new Promise((resolve) => { onClose = resolve; });
    const ep = await endpoint(() => ({
      headers: declared ? { 'content-length': String(MAX_RESPONSE_BYTES + 1) } : {},
      writeBody(res) {
        res.once('close', onClose);
        res.flushHeaders();
        if (!declared) res.write(Buffer.alloc(MAX_RESPONSE_BYTES + 1, 'x'));
        // Stay open: the client must cancel instead of waiting for EOF or its timeout.
      },
    }));
    let timer;
    try {
      await assert.rejects(run('q', null, { endpoint: { url: ep.url }, model: 'm', timeoutMs: 5000, tag: 'open-body' }), oversized);
      await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('response was not cancelled')), 2000); })]);
      assert.equal(liveChildren('open-body').length, 0);
    } finally { clearTimeout(timer); await ep.close(); }
  }
});

test('streamed UTF-8 characters and empty response bodies keep their existing parsing behavior', async (t) => {
  const body = Buffer.from('\uFEFF' + JSON.stringify(reply('before 💡 after').body));
  const split = body.indexOf(Buffer.from('💡')) + 2;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(body.subarray(0, split)); controller.enqueue(body.subarray(split)); controller.close(); },
  })));
  assert.equal((await run('q', null, { endpoint: { url: 'http://localhost:11434/v1' }, model: 'm' })).text, 'before 💡 after');
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  await assert.rejects(run('q', null, { endpoint: { url: 'http://localhost:11434/v1' }, model: 'm' }), (e) => e.kind === 'other' && /other than JSON/.test(e.message));
});
