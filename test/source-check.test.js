import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAddress, verifyResearchSources } from '../src/source-check.js';
import { researchSettings } from '../src/research.js';

const doc = 'https://docs.example.com/v2/file';
const passage = 'Exclusive copy fails when the destination file already exists.';
const source = (url, excerpt = passage) => ({ url, title: 'Suggested title', publishedAt: '2020-01-01', excerpt });
const settings = { query: 'Does exclusive copy fail if the destination file already exists?', sourceScopes: ['https://docs.example.com/v2/'] };
const html = '<html><head><title>File operations</title></head><body><p>' + passage + '</p></body></html>';
const check = (sources, opts, read) => verifyResearchSources(sources, opts, new AbortController().signal, read);

test('research resolves grounding links, enforces path boundaries and keeps matched page evidence', async () => {
  const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/sample';
  const seen = [];
  const out = await check([source(redirect), source(doc + '#section'), source('https://docs.example.com/v20/other'),
    source('https://docs.example.com/v2/away'), source('http://docs.example.com/v2/file')], settings, async url => {
    seen.push(url.href);
    if (url.href === redirect) return { redirect: doc };
    if (url.href.endsWith('/away')) return { redirect: 'https://mirror.example.com/v2/file' };
    return { body: html };
  });
  assert.deepEqual(out.verification, { checked: 5, unavailable: 1, outsideScope: 2, unsupported: 0, duplicates: 1 });
  assert.ok(seen.every(url => !url.includes('mirror') && !url.includes('v20')));
  assert.deepEqual(out.sources, [{ ...source(doc), id: 'S1', title: 'File operations', publishedAt: null }]);
});

test('a page must contain evidence beyond its title, navigation and scripted content', async () => {
  const hidden = '<head><title>' + passage + '</title></head><script>' + passage + '</script><nav>' + passage + '</nav>';
  const out = await check([source(doc), source(doc + '/missing'), source(doc + '/news')], settings, async url => {
    if (url.href.endsWith('/missing')) throw new Error('not available');
    return { body: hidden + '<p>Subscribe to our mailing list for news.</p>' };
  });
  assert.deepEqual(out.sources, []);
  assert.equal(out.verification.unsupported, 2);
  assert.equal(out.verification.unavailable, 1);
});

test('publication metadata confirms a proposed date and same-host document aliases share a single excerpt', async () => {
  const page = html.replace('</head>', '<meta content="2020-01-01T12:34:56Z" property="article:published_time"></head>');
  const result = await check([source(doc), source(doc + '/alias')], settings, async () => ({ body: page }));
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].publishedAt, '2020-01-01');
  assert.equal(result.verification.duplicates, 1);
});

test('a paraphrase can yield only the actual passage and a supplied document can fill an empty bundle', async () => {
  const guessed = 'An exclusive copy replaces the destination file by default.';
  const out = await check([source(doc, guessed)], settings, async () => ({ body: html }));
  assert.equal(out.sources[0].excerpt, passage);
  const calls = [];
  const fallback = await check([], { ...settings, sourceScopes: [doc, 'https://docs.example.com/v2/'] }, async url => {
    calls.push(url.href); return { body: html };
  });
  assert.deepEqual(calls, [doc]);
  assert.equal(fallback.sources[0].excerpt, passage);
  assert.equal(fallback.verification.checked, 1);
});

test('checks accept only public destinations and bounded redirects and propagate cancellation', async () => {
  for (const ip of ['127.0.0.1', '169.254.1.1', '192.168.1.1', '100.64.0.1', '224.0.0.2', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1', '2002::1']) assert.equal(publicAddress(ip), false, ip);
  for (const ip of ['1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicAddress(ip), true, ip);
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(verifyResearchSources([source(doc)], settings, ctrl.signal, () => assert.fail()), { name: 'AbortError' });
  const calls = [];
  const out = await check([source(doc), source('https://127.0.0.1/file'), source('https://service.local/file'), source('https://docs.example.com/v2/a%2fb')], {}, async url => {
    calls.push(url.href); return { redirect: doc };
  });
  assert.equal(calls.length, 5);
  assert.equal(out.verification.unavailable, 4);
});

test('research defaults follow the selected CLI and invalid source scopes fail during setup', () => {
  for (const [vendor, limit] of [['agy', 2], ['codex', 4], ['claude', 4]]) assert.equal(researchSettings({ vendor, query: 'Question' }).maxSearches, limit);
  assert.equal(researchSettings({ vendor: 'agy', query: 'Question', maxSearches: 1 }).maxSearches, 1);
  for (const scope of ['http://example.com/', 'https://user@example.com/path', 'https://example.com/path?x=1', 'https://example.com/a%2fb', 'https://127.0.0.1/']) {
    assert.throws(() => researchSettings({ query: 'Question', sourceScopes: [scope] }), /source URL prefix/);
  }
});
