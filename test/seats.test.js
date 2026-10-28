import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSeats, normaliseChairman, moodLine, MOODS, COLOURS, initialSeatVendors, nextSeatLens, fillMissingSeatLenses, seatSetupIssue } from '../src/seats.js';
import { ADAPTERS } from '../src/adapters/config.js';

const V = ADAPTERS;

test('added and restored seats get distinct editable lenses without changing existing choices', () => {
  const original = [{ vendor: 'claude', lens: 'Evidence and assumptions', mood: 'builder' },
    { vendor: 'codex', lens: '  ', effort: 'low' }, { vendor: 'claude', lens: '' }];
  const filled = fillMissingSeatLenses(original);
  assert.deepEqual(filled[0], original[0]);
  assert.equal(filled[1].effort, 'low');
  assert.equal(original[1].lens, '  ', 'restoring a draft does not mutate its source');
  assert.equal(new Set(filled.map((s) => s.lens.toLowerCase())).size, 3);
  assert.equal(seatSetupIssue(filled), null);
  assert.ok(!filled.some((s) => s.lens === nextSeatLens(filled)));
  assert.ok(nextSeatLens(Array.from({ length: 12 }, (_, i) => ({ lens: `perspective ${i + 1}` }))));
});

test('seat validation identifies the blank or duplicate lens and custom mood without echoing input', () => {
  const seats = [{ vendor: 'claude', lens: 'PRIVATE-MARKER' }, { vendor: 'codex', lens: '' }];
  assert.deepEqual([seatSetupIssue(seats).seatIndex, seatSetupIssue(seats).field], [1, 'lens']);
  assert.throws(() => normaliseSeats(seats, { vendors: V }), (e) => e.status === 400 && e.seatIndex === 1 && e.code === 'SEAT_LENS_REQUIRED');
  seats[1].lens = ' private-marker ';
  assert.equal(seatSetupIssue(seats).code, 'SEAT_LENS_DUPLICATE');
  assert.doesNotMatch(seatSetupIssue(seats).message, /PRIVATE-MARKER|private-marker/);
  seats[1] = { vendor: 'codex', lens: 'cost', mood: 'custom', moodText: '' };
  assert.equal(seatSetupIssue(seats).field, 'moodText');
  assert.throws(() => normaliseSeats([seats[0], { ...seats[1], mood: { preset: 'custom', text: '' } }], { vendors: V }), (e) => e.code === 'SEAT_MOOD_REQUIRED');
  seats[1].moodText = 'Look for a reversible next step.';
  assert.equal(seatSetupIssue(seats), null);
});

test('first use chooses two CLI seats, preferring ready default logins and reusing a sole ready vendor', () => {
  const vendors = Object.entries(V).map(([vendor, a]) => ({ vendor, kind: a.kind }));
  const snapshot = structuredClone(vendors);
  assert.deepEqual(initialSeatVendors(vendors), ['claude', 'codex']);
  assert.deepEqual(initialSeatVendors(vendors, [
    { key: 'claude', state: 'bad' }, { key: 'codex', state: 'ok' }, { key: 'agy', state: 'ok' },
  ]), ['codex', 'agy']);
  assert.deepEqual(initialSeatVendors(vendors, [{ key: 'codex', state: 'ok' }]), ['codex', 'codex']);
  assert.deepEqual(initialSeatVendors(vendors, [
    { key: 'claude', state: 'bad' }, { key: 'codex', state: 'warn' }, { key: 'agy@work', state: 'ok' }, { key: 'api', state: 'ok' },
  ]), ['claude', 'codex'], 'unknown or named logins do not imply a ready default login');
  assert.deepEqual(initialSeatVendors([{ vendor: 'agy', kind: 'cli' }]), ['agy', 'agy']);
  assert.deepEqual(initialSeatVendors([{ vendor: 'api', kind: 'api' }]), []);
  assert.deepEqual(vendors, snapshot);
});

test('two instances of one vendor get their own ids and numbered labels, and their vendor colour', () => {
  const seats = normaliseSeats([
    { vendor: 'codex', lens: 'risk' },
    { vendor: 'codex', lens: 'cost', mood: 'steelman', effort: 'high' },
    { vendor: 'claude', lens: 'customer' },
  ], { vendors: V });
  assert.deepEqual(seats.map((s) => s.id), ['seat-0', 'seat-1', 'seat-2']);
  assert.deepEqual(seats.map((s) => s.label), ['Codex 1', 'Codex 2', 'Claude']);
  // colour by vendor: both Codex seats are olive, Claude is rust
  assert.deepEqual(seats.map((s) => s.colour), ['olive', 'olive', 'rust']);
  assert.deepEqual(seats[0].mood, { preset: 'grill' }, 'grill is the default');
  assert.deepEqual(seats[1].mood, { preset: 'steelman' });
  assert.equal(seats[1].effort, 'high');
  assert.equal(seats[0].effort, undefined);
});

test('lenses must be unique and present; they are the only identity other seats see', () => {
  assert.throws(() => normaliseSeats([{ vendor: 'codex', lens: 'Risk' }, { vendor: 'claude', lens: 'risk' }], { vendors: V }), /share the lens/);
  assert.throws(() => normaliseSeats([{ vendor: 'codex', lens: '' }, { vendor: 'claude', lens: 'x' }], { vendors: V }), /needs a lens/);
  assert.throws(() => normaliseSeats([{ vendor: 'codex', lens: 'only one' }], { vendors: V }), /at least two/);
  assert.throws(() => normaliseSeats([{ vendor: 'nope', lens: 'a' }, { vendor: 'claude', lens: 'b' }], { vendors: V }), /at least two/);
});

test('effort is checked against the vendor list, which the catalogue may widen', () => {
  assert.throws(() => normaliseSeats([{ vendor: 'claude', lens: 'a', effort: 'max' }, { vendor: 'codex', lens: 'b' }], { vendors: V }), /does not accept effort "max"/);
  const seats = normaliseSeats([{ vendor: 'codex', lens: 'a', effort: 'max' }, { vendor: 'codex', lens: 'b' }],
    { vendors: V, efforts: { codex: ['low', 'medium', 'high', 'xhigh', 'ultra', 'max'] } });
  assert.equal(seats[0].effort, 'max');
});

test('custom mood needs text; unknown presets fall back to grill; moodLine renders each', () => {
  assert.throws(() => normaliseSeats([{ vendor: 'codex', lens: 'a', mood: { preset: 'custom', text: ' ' } }, { vendor: 'codex', lens: 'b' }], { vendors: V }), /custom mood/);
  const [a, b] = normaliseSeats([{ vendor: 'codex', lens: 'a', mood: { preset: 'custom', text: 'Argue as a dentist would.' } }, { vendor: 'codex', lens: 'b', mood: 'bogus' }], { vendors: V });
  assert.equal(moodLine(a.mood), 'Argue as a dentist would.');
  assert.equal(moodLine(b.mood), MOODS.grill);
  assert.equal(moodLine(undefined), MOODS.grill);
  assert.equal(moodLine('contrarian'), MOODS.contrarian);
});

test('colours cycle past the palette and a given colour is kept', () => {
  const six = normaliseSeats(['a', 'b', 'c', 'd', 'e', 'f'].map((l, i) => ({ vendor: 'claude', lens: l, colour: i === 1 ? 'dusk' : undefined })), { vendors: V });
  assert.equal(six[1].colour, 'dusk');
  assert.equal(six[5].colour, COLOURS[5 % COLOURS.length]);
  assert.deepEqual(six.map((s) => s.label), ['Claude 1', 'Claude 2', 'Claude 3', 'Claude 4', 'Claude 5', 'Claude 6']);
});

test('an account profile is optional, validated, and carried on seats and the chairman', () => {
  const [a, b] = normaliseSeats([{ vendor: 'claude', lens: 'a', account: ' work ' }, { vendor: 'claude', lens: 'b' }], { vendors: V });
  assert.equal(a.account, 'work');
  assert.equal(b.account, undefined, 'no profile: the real CLI state directory');
  assert.throws(() => normaliseSeats([{ vendor: 'claude', lens: 'a', account: '../etc' }, { vendor: 'claude', lens: 'b' }], { vendors: V }), /Account profile/);
  assert.equal(normaliseChairman({ vendor: 'codex', account: 'alt' }, { vendors: V }).account, 'alt');
});

test('chairman keeps model and effort, rejects a bad effort, and is null for an unknown vendor', () => {
  assert.deepEqual(normaliseChairman({ vendor: 'agy', model: 'gemini-4-argon-high', effort: 'high' }, { vendors: V }), { vendor: 'agy', colour: 'teal', model: 'gemini-4-argon-high', effort: 'high', account: undefined });
  assert.throws(() => normaliseChairman({ vendor: 'claude', effort: 'ultra' }, { vendors: V }), /Chairman/);
  assert.equal(normaliseChairman({ vendor: 'nope' }, { vendors: V }), null);
});

test('pool keys: the default login is the vendor, a named profile is vendor@profile, a vendor without profiles has one pool', async () => {
  const { poolKey, poolVendor, poolAccount } = await import('../src/seats.js');
  assert.equal(poolKey('codex', undefined), 'codex');
  assert.equal(poolKey('codex', 'work'), 'codex@work');
  assert.equal(poolKey('agy', 'work', false), 'agy', 'no state directory, so no separate pool');
  assert.equal(poolVendor('codex@work:gpt-5'), 'codex');
  assert.equal(poolAccount('codex@work:gpt-5'), 'work');
  assert.equal(poolAccount('codex'), null);
});

test('an API endpoint seat: the URL, model and key variable are checked; its pool is its host; the label names the host', () => {
  const seats = normaliseSeats([
    { vendor: 'api', lens: 'local', endpoint: 'http://localhost:11434/v1/', model: 'llama3' },
    { vendor: 'api', lens: 'hosted', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyEnv: 'DEEPSEEK_API_KEY' },
    { vendor: 'claude', lens: 'risk' },
  ], { vendors: V });
  assert.deepEqual(seats.map((s) => s.label), ['API localhost-11434', 'API api.deepseek.com', 'Claude']);
  assert.deepEqual(seats.map((s) => s.account), ['localhost-11434', 'api.deepseek.com', undefined], 'one pool per host');
  assert.equal(seats[0].endpoint, 'http://localhost:11434/v1', 'trailing slash dropped');
  assert.deepEqual([seats[0].keyEnv, seats[1].keyEnv], [undefined, 'DEEPSEEK_API_KEY']);
  assert.equal(seats[0].colour, 'steel');
  const two = normaliseSeats([{ vendor: 'api', lens: 'a', endpoint: 'http://localhost:11434/v1', model: 'x' }, { vendor: 'api', lens: 'b', endpoint: 'http://localhost:11434/v1', model: 'y' }], { vendors: V });
  assert.deepEqual(two.map((s) => s.label), ['API localhost-11434 1', 'API localhost-11434 2']);
  const bad = (seat, re) => assert.throws(() => normaliseSeats([{ vendor: 'api', lens: 'a', ...seat }, { vendor: 'claude', lens: 'b' }], { vendors: V }), re);
  bad({ model: 'm' }, /needs its endpoint/);
  bad({ endpoint: 'http://localhost:11434/v1' }, /needs a model id/);
  bad({ endpoint: 'http://api.deepseek.com/v1', model: 'm', keyEnv: 'K' }, /plain http only/);
  bad({ endpoint: 'https://api.deepseek.com/v1', model: 'm' }, /needs the name of the environment variable/);
  bad({ endpoint: 'https://api.deepseek.com/v1', model: 'm', keyEnv: 'sk-abc123' }, /NAME of an environment variable/);
  bad({ endpoint: 'https://user:pw@api.deepseek.com/v1', model: 'm', keyEnv: 'K' }, /credentials/);
  bad({ endpoint: 'https://api.deepseek.com/v1?x=1', model: 'm', keyEnv: 'K' }, /without a query/);
  bad({ endpoint: 'ftp://x/v1', model: 'm' }, /http or https/);
  const chair = normaliseChairman({ vendor: 'api', endpoint: 'http://10.0.0.5:8000/v1', model: 'qwen', effort: 'low' }, { vendors: V });
  assert.deepEqual(chair, { vendor: 'api', colour: 'steel', model: 'qwen', effort: 'low', account: '10.0.0.5-8000', endpoint: 'http://10.0.0.5:8000/v1', keyEnv: undefined });
});

test('privateHost and seatKind: plain http stays on this machine or a private network; every card can say CLI or API', async () => {
  const { privateHost, seatKind, hostKey } = await import('../src/seats.js');
  for (const h of ['localhost', '127.0.0.1', '::1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '172.31.0.1', 'fd12::1', 'fe80::1', 'myserver', 'gpu-box.local', 'ollama.internal']) assert.equal(privateHost(h), true, h);
  for (const h of ['api.deepseek.com', '172.32.0.1', '8.8.8.8', '2001:db8::1', 'example.org']) assert.equal(privateHost(h), false, h);
  assert.equal(seatKind(V.claude), 'CLI · subscription');
  assert.equal(seatKind(V.api, 'http://localhost:11434/v1'), 'API · local');
  assert.equal(seatKind(V.api, 'https://api.moonshot.ai/v1'), 'API · pay-per-token');
  assert.match(hostKey('http://[::1]:8080/v1'), /^[a-z0-9][a-z0-9_.-]{0,39}$/, 'an IPv6 host still yields a profile-shaped key');
  assert.equal(hostKey('nonsense'), '');
});

test('private IPv4 prefixes on DNS names never grant HTTP or keyless hosted access', async () => {
  const { checkEndpointUrl, privateHost, seatKind } = await import('../src/seats.js');
  for (const host of ['10.api.example.com', '127.api.example.com', '192.168.api.example.com', '169.254.api.example.com', '172.16.api.example.com', '172.31.api.example.com', '10.0.0.1.example.com', '10.api.example.com.']) {
    assert.equal(privateHost(host), false, host);
    const endpoint = `http://${host}/v1`;
    assert.throws(() => checkEndpointUrl(endpoint), /plain http only/, host);
    assert.throws(() => normaliseSeats([{ vendor: 'api', lens: 'risk', endpoint, model: 'm' }, { vendor: 'claude', lens: 'cost' }], { vendors: V }), /plain http only/);
    assert.throws(() => normaliseChairman({ vendor: 'api', endpoint, model: 'm' }, { vendors: V }), /plain http only/);
    const secure = `https://${host}/v1`;
    assert.equal(checkEndpointUrl(secure), secure, 'HTTPS stays available');
    assert.equal(seatKind(V.api, secure), 'API · pay-per-token');
    assert.throws(() => normaliseChairman({ vendor: 'api', endpoint: secure, model: 'm' }, { vendors: V }), /needs the name of the environment variable/);
  }
  assert.throws(() => checkEndpointUrl('http://%31%30.api.example.com/v1'), /plain http only/, 'URL decoding cannot turn a DNS prefix into a private address');
  for (const host of ['10.0.0.256', '127.999.0.1', '192.168.1.300', '172.16.0.999']) assert.equal(privateHost(host), false, host);
});

test('HTTP endpoint validation preserves canonical private IPs and intentional local names', async () => {
  const { checkEndpointUrl } = await import('../src/seats.js');
  for (const host of ['127.1', '2130706433', '0x7f000001', '0177.0.0.1', '10.1', '192.168.0.9', '172.16.0.1', '172.31.255.255', '169.254.1.1', '[0:0:0:0:0:0:0:1]', '[fd12::1]', '[fe80::1]', 'localhost', 'myserver', 'gpu-box.local', 'ollama.internal']) {
    const endpoint = `http://${host}:8000/v1`;
    assert.equal(checkEndpointUrl(endpoint), new URL(endpoint).href, host);
  }
  for (const host of ['172.15.255.255', '172.32.0.0', '8.8.8.8', '0x08080808', '[2001:db8::1]']) {
    assert.throws(() => checkEndpointUrl(`http://${host}/v1`), /plain http only/, host);
  }
});
