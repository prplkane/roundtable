import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, resetTime, POOL_FATAL } from '../src/adapters/errors.js';

const NOW = new Date(2026, 9, 21, 12, 0).getTime();

test('invalid or oversized provider output remains terminal regardless of error-like text', () => {
  for (const code of ['PROVIDER_PROTOCOL', 'OUTPUT_LIMIT']) {
    for (const text of ['network error', 'quota exceeded', 'authentication failed', 'unknown option']) {
      const result = classifyError({ code, message: text, stdout: text, stderr: text });
      assert.equal(result.kind, 'policy');
      assert.match(result.message, /stopped for the review/);
      assert.equal(result.resetsAt, null);
      assert.equal(POOL_FATAL.has(result.kind), false, 'only the affected seat stops');
    }
  }
});

test('a Codex usage limit is quota, with the reset time it names', () => {
  const line = '{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 27th, 2026 12:51 PM."}}';
  const c = classifyError({ message: `Codex: empty reply (${line})`, label: 'Codex' }, NOW);
  assert.equal(c.kind, 'quota');
  assert.equal(c.resetsAt, new Date(2026, 9, 27, 12, 51).getTime());
  assert.match(c.message, /^Codex: usage limit reached, resets 27 Oct/);
  assert.ok(POOL_FATAL.has(c.kind));
});

test('a Claude usage limit with an epoch, a lapsed login, a network failure, a timeout and a missing CLI', () => {
  assert.equal(resetTime('Claude AI usage limit reached|1792087800'), 1792087800 * 1000);
  assert.equal(classifyError({ message: 'Claude: Claude AI usage limit reached|1792087800', label: 'Claude' }, NOW).kind, 'quota');
  const auth = classifyError({ message: 'Claude: Invalid API key · Please run /login', label: 'Claude' }, NOW);
  assert.equal(auth.kind, 'auth');
  assert.match(auth.message, /claude \/login/);
  assert.equal(classifyError({ message: 'x', stderr: 'Error: getaddrinfo ENOTFOUND api.example.com', label: 'Codex' }).kind, 'network');
  assert.equal(classifyError({ message: 'timed out after 300000 ms', code: 'TIMEOUT', label: 'Codex' }).kind, 'timeout');
  assert.equal(classifyError({ message: 'agy: not found on PATH', label: 'Antigravity' }).kind, 'missing');
  const other = classifyError({ message: 'Codex: empty reply (exit 1)', label: 'Codex' });
  assert.deepEqual([other.kind, other.message], ['other', 'Codex: empty reply (exit 1)'], 'unrecognised text keeps its own words');
});
