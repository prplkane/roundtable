// A research URL is provider output. Fetch only public HTTPS pages, pin the checked DNS
// answer on each connection, and examine a bounded text body without executing the page.
import https from 'node:https';
import { publicSourceUrl } from './research.js';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked.addSubnet(network, bits, 'ipv4');
for (const [network, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) blocked.addSubnet(network, bits, 'ipv6');
const unicast = new BlockList();
unicast.addSubnet('2000::', 3, 'ipv6');
export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && unicast.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
function publicLookup(host, options, done) {
  lookup(host, { all: true }, (error, records) => {
    if (error) return done(error);
    if (!records.length || !records.every(r => publicAddress(r.address))) return done(new Error('Non-public source address.'));
    if (options.all) return done(null, records);
    done(null, records[0].address, records[0].family);
  });
}
function inScope(url, scopes) {
  if (!scopes?.length) return true;
  return scopes.some(raw => {
    const scope = new URL(raw);
    return scope.origin === url.origin && (scope.pathname === url.pathname || url.pathname.startsWith(scope.pathname.replace(/\/?$/, '/')));
  });
}

function readPage(url, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: false, lookup: publicLookup, signal,
      headers: { accept: 'text/html, text/plain, application/xhtml+xml', 'accept-encoding': 'identity', 'user-agent': 'Roundtable citation check' } }, res => {
      res.on('error', reject);
      const redirect = [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location;
      if (redirect) { resolve({ redirect }); res.destroy(); return; }
      if (res.statusCode !== 200 || !/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:;|$)/i.test(res.headers['content-type'] || '') ||
          (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        reject(new Error('No readable source page.')); res.destroy(); return;
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { res.destroy(new Error('Source page exceeds the byte limit.')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

// Treat page text as evidence only. Discard provider paraphrases, guessed dates and titles.
// Separate structural boundaries before decoding entities. Skip hidden sections in one pass.
function visibleText(html) {
  const tags = /<!--[\s\S]*?(?:-->|$)|<\/?([a-z][\w:-]*)\b[^<>]{0,2048}>/gi;
  const hidden = new Set(['script', 'style', 'template', 'noscript', 'head', 'nav', 'footer']);
  const blocks = new Set(['p', 'li', 'br', 'div', 'td', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const parts = [];
  let from = 0, skip = null;
  for (const match of html.matchAll(tags)) {
    if (!skip) parts.push(html.slice(from, match.index));
    const tag = match[1]?.toLowerCase();
    const closing = match[0][1] === '/';
    if (!skip && hidden.has(tag) && !closing) skip = tag;
    else if (skip === tag && closing) skip = null;
    if (!skip && blocks.has(tag)) parts.push('\n');
    from = match.index + match[0].length;
  }
  if (!skip) parts.push(html.slice(from));
  return parts.join('');
}
function plain(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘' };
  return visibleText(html)
    .replace(/&(?:#(x[\da-f]+|\d+)|([a-z]+));/gi, (s, num, name) => {
      if (!num) return entities[name.toLowerCase()] ?? s;
      const n = num[0].toLowerCase() === 'x' ? parseInt(num.slice(1), 16) : Number(num);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    }).replace(/[ \t\r]+/g, ' ').trim();
}
const norm = text => text.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const stopWords = new Set('about after also before between calls could described different does each example first following from have into more other query return search should source specifies that their them these they this those using what when where which will with would'.split(' '));
const keywords = s => new Set(norm(s).match(/[\p{L}\p{N}]+/gu)?.filter(w => w.length >= 3 && !stopWords.has(w)));

function publicationDate(body, proposed) {
  if (!proposed) return null;
  // Accept only explicit publication metadata, and only the date the searcher proposed.
  for (const [tag] of body.matchAll(/<(?:meta|time)\b[^<>]{0,2048}>/gi)) {
    const attributes = Object.fromEntries([...tag.matchAll(/\s([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), m[3]]));
    if (attributes.property !== 'article:published_time' && attributes.itemprop !== 'datePublished') continue;
    const date = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(attributes.content || attributes.datetime || '')?.[1];
    if (date === proposed) return date;
  }
  return null;
}

function pageEvidence(body, source, query, url) {
  const text = plain(body);
  const quote = source.excerpt.trim().replace(/^["“]|["”]$/g, '');
  const titleStart = /<title\b[^<>]{0,500}>/i.exec(body);
  const title = titleStart && plain(body.slice(titleStart.index + titleStart[0].length).split('<', 1)[0]).slice(0, 200) || url.hostname;
  const wanted = keywords(query);
  const claim = keywords(quote);
  const passages = text.split(/\n+|(?<=[.!?])\s+(?=[A-Z])/u);
  const shares = (words, set) => [...words].filter(w => set.has(w)).length;
  const exact = quote.length >= 18 && quote.length <= 450 && claim.size >= 3 && norm(text).includes(norm(quote));
  if (exact && shares(claim, wanted) >= 1) return { title, excerpt: quote };
  // If search returned a paraphrase, send only an actual, relevant passage. The seat receives
  // the passage itself, never the original inference. Home pages need an exact quote.
  if (url.pathname === '/') return null;
  let best = null, score = 0;
  for (const passage of passages) {
    const line = passage.trim();
    if (line.length < 30 || line.length > 450) continue;
    const words = keywords(line), support = shares(words, claim), topic = shares(words, wanted);
    if (support < 3 || topic < 2 || support / Math.max(1, Math.min(claim.size, words.size)) < 0.35) continue;
    if (support + topic > score) { best = line; score = support + topic; }
  }
  return best ? { title, excerpt: best } : null;
}

export async function verifyResearchSources(sources, settings, signal, read = readPage) {
  const verification = { checked: 0, unavailable: 0, outsideScope: 0, unsupported: 0, duplicates: 0 };
  const kept = [], seen = new Set(), sameEvidence = new Set();
  const budget = AbortSignal.timeout(20_000);
  async function check(source) {
    signal.throwIfAborted();
    let url = new URL(source.url), issue = 'unavailable';
    verification.checked++;
    url.hash = '';
    try {
      const deadline = AbortSignal.any([signal, budget, AbortSignal.timeout(6000)]);
      deadline.throwIfAborted();
      for (let hop = 0; hop <= 4 && publicSourceUrl(url); hop++) {
        const grounding = url.origin === 'https://vertexaisearch.cloud.google.com' && url.pathname.startsWith('/grounding-api-redirect/');
        if (!grounding && !inScope(url, settings.sourceScopes)) { issue = 'outsideScope'; break; }
        if (seen.has(url.href)) { issue = 'duplicates'; break; }
        const page = await read(url, deadline);
        if (page.redirect) { url = new URL(page.redirect, url); url.hash = ''; continue; }
        if (grounding) break;
        const evidence = pageEvidence(page.body, source, settings.query, url);
        if (!evidence) { issue = 'unsupported'; break; }
        seen.add(url.href);
        const key = JSON.stringify([url.hostname, evidence.title, norm(evidence.excerpt)]);
        if (sameEvidence.has(key)) { issue = 'duplicates'; break; }
        sameEvidence.add(key);
        kept.push({ ...source, id: 'S' + (kept.length + 1), url: url.href, ...evidence, publishedAt: publicationDate(page.body, source.publishedAt) });
        issue = null;
        break;
      }
    } catch { signal.throwIfAborted(); }
    if (issue) verification[issue]++;
  }
  for (const source of sources) await check(source);
  if (!kept.length) {
    // A user-supplied document can supply a passage even if search returned a mirror.
    // Hosts and directory prefixes constrain search and are never crawled.
    for (const url of settings.sourceScopes || []) {
      if (new URL(url).pathname.endsWith('/') || sources.some(s => s.url === url) || budget.aborted) continue;
      await check({ url, excerpt: settings.query, gatheredAt: sources[0]?.gatheredAt });
    }
  }
  return { sources: kept, verification };
}
