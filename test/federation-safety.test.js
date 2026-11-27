'use strict';
// Federation safety (PROTOCOL §4b): which remote homeservers are let in, what one server adds to that, limits per homeserver,
// the new-homeserver cooldown (by domain, registered domain and network), invites that skip it, and deny lists.
// The remote homeservers are stand-ins whose keys the test holds (helpers.js mockHomeserver).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { tmpDir, api, wsClient, mockHomeserver } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
process.env.EMBER_DEV = '1';
delete process.env.EMBER_OWNER;
delete process.env.EMBER_MANAGED;
delete process.env.EMBER_PUBLIC_URL;
const { startServer } = require('../src/index');
const config = require('../src/config');
const db = require('../src/db');
const resolve = require('../src/federation/resolve');
const seen = require('../src/federation/seen');
const limits = require('../src/federation/limits');
const denylist = require('../src/federation/denylist');
const fed = require('../src/federation');

const dir = tmpDir();
let B, base, aud, bo, lobby, general;
const mocks = new Map(), extra = [];
const ips = new Map();
const S = (p = '') => `/api/v1/servers/${lobby.sid}${p}`;
const fresh = () => { limits.reset(); fed._test.exchangeLimit.reset(); };
// the stand-in homeserver of `domain`, answering from `ip`
async function hs(domain, ip) {
  if (mocks.has(domain)) return mocks.get(domain);
  const m = await mockHomeserver(domain);
  m.aud = aud; mocks.set(domain, m);
  if (ip) ips.set(m.origin, [ip]);
  config.update({ federation: { dev_origins: { ...config.get().federation.dev_origins, [domain]: m.origin } } });
  return m;
}
const exchange = token => api(base).post('/api/v2/auth/remote', { token });
// sign in as account `id` of `domain`. -> { status, body, a (client), token }
async function signIn(domain, { id = 'l:1', name = 'remi', ip } = {}) {
  const m = await hs(domain, ip);
  const r = await exchange(m.mint({ sub: `${id}@${domain}`, preferred_username: name }));
  return { ...r, token: r.body.access_token, a: api(base, r.body.access_token) };
}
const accounts = remote_accounts => bo.a.patch('/api/v2/homeserver/accounts', { remote_accounts });
const settings = join => bo.a.patch(S('/settings'), { join });
const fedPatch = body => bo.a.patch('/api/v2/homeserver/federation', body);
const old = domain => seen._test.age(domain, 40 * seen.DAY); // past the cooldown and the "new homeserver" limits

test.before(async () => {
  B = await startServer({ dataDir: dir, port: 0 });
  base = B.url; aud = `http://localhost:${B.port}`;
  const r = await api(base).post('/api/v1/auth/register', { username: 'bo', password: 'correct horse battery' });
  bo = { ...r.body, a: api(base, r.body.session) };
  assert.equal((await bo.a.post('/api/v1/instance/claim', { code: B.setup.current() })).status, 200);
  lobby = (await bo.a.post('/api/v1/servers', { name: 'Lobby', join_policy: 'open' })).body.server;
  general = (await bo.a.get(S())).body.channels.find(c => c.name === 'general');
  config.update({ federation: { denylists: [] } });
  resolve._test.setAddresses(origin => ips.get(origin) || []);
  assert.equal((await accounts({ mode: 'all' })).status, 200);
});
test.after(async () => {
  resolve._test.setAddresses(null);
  await B?.close();
  for (const m of [...mocks.values(), ...extra]) await m.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rules: a domain is one name, "*.domain" is everything under it; registered domains; networks', () => {
  const R = require('../src/federation/rules'), { registeredDomain } = require('../src/federation/psl');
  assert.equal(R.domainMatches(['example.org'], 'example.org'), true);
  assert.equal(R.domainMatches(['example.org'], 'chat.example.org'), false);
  assert.equal(R.domainMatches(['*.example.org'], 'chat.example.org'), true);
  assert.equal(R.domainMatches(['*.example.org'], 'example.org'), false);
  assert.equal(R.domainMatches(['*.example.org'], 'notexample.org'), false);
  for (const [h, want] of [['chat.example.com', 'example.com'], ['a.b.example.co.uk', 'example.co.uk'], ['me.github.io', 'me.github.io'], ['x.me.github.io', 'me.github.io'], ['example.com.au', 'example.com.au'], ['localhost', 'localhost']]) assert.equal(registeredDomain(h), want, h);
  assert.equal(R.netOf('203.0.113.77'), '203.0.113.0/24');
  assert.equal(R.netOf('2001:db8:1:2::5'), '2001:db8:1::/48');
  assert.equal(R.netOf('::ffff:203.0.113.77'), '203.0.113.0/24');
  const c = R.compileDeny(['Bad.example', '*.evil.example', '10.0.0.0/8', '2001:db8::/32', 'l:5@X.example', 'not a rule']);
  assert.equal(R.denied(c, { domain: 'bad.example' }), 'domain');
  assert.equal(R.denied(c, { domain: 'a.evil.example' }), 'domain');
  assert.equal(R.denied(c, { domain: 'ok.example', ips: ['10.9.8.7'] }), 'network');
  assert.equal(R.denied(c, { domain: 'ok.example', ips: ['2001:db8::1'] }), 'network');
  assert.equal(R.denied(c, { domain: 'x.example', sub: 'l:5@x.example' }), 'account');
  assert.equal(R.denied(c, { domain: 'x.example', sub: 'l:6@x.example', ips: ['11.0.0.1'] }), null);
});

test('remote_accounts modes: none, all, allowlist, blocklist; a homeserver shut out loses its sessions', async () => {
  fresh();
  const one = await signIn('one.example', { ip: '198.51.100.1' });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal((await one.a.get('/api/v1/me')).status, 200);
  // allowlist: named domains, and "*.domain" for everything under one
  assert.equal((await accounts({ mode: 'allowlist', list: ['two.example', '*.wild.example'] })).status, 200);
  let r = await signIn('one.example');
  assert.deepEqual([r.status, r.body.error, r.body.domain], [403, 'homeserver_not_allowed', 'one.example']);
  assert.equal((await one.a.get('/api/v1/me')).status, 401); // its open session ends with the rule
  assert.equal((await signIn('two.example', { ip: '198.51.100.2' })).status, 200);
  assert.equal((await signIn('chat.wild.example', { ip: '198.51.100.3' })).status, 200);
  assert.equal((await signIn('wild.example', { ip: '198.51.100.4' })).body.error, 'homeserver_not_allowed');
  // a homeserver that is not let in is never asked for its keys
  const never = await hs('never.example');
  assert.equal((await exchange(never.mint())).body.error, 'homeserver_not_allowed');
  assert.deepEqual([never.discoveryFetches, never.jwksFetches], [0, 0]);
  // blocklist
  await accounts({ mode: 'blocklist', list: ['two.example', '*.wild.example'] });
  assert.equal((await signIn('two.example')).body.error, 'homeserver_not_allowed');
  assert.equal((await signIn('chat.wild.example')).body.error, 'homeserver_not_allowed');
  assert.equal((await signIn('one.example')).status, 200);
  assert.equal((await one.a.get('/api/v1/me')).status, 200); // and comes back with it
  // none
  await accounts({ mode: 'none' });
  assert.deepEqual((r = await signIn('one.example'), [r.status, r.body.error]), [403, 'remote_accounts_off']);
  assert.equal((await api(base).get('/.well-known/ember')).body.federation.accepts_remote, 'none');
  assert.equal((await accounts({ mode: 'allowlist', list: ['not a domain'] })).body.error, 'invalid_remote_accounts');
  await accounts({ mode: 'all', list: [] });
});

test('a server narrows it: none, or its own allowlist, checked on every request', async () => {
  fresh();
  const one = await signIn('one.example'), two = await signIn('two.example');
  old('one.example'); old('two.example');
  for (const u of [one, two]) assert.equal((await u.a.post(S('/join'))).status, 200);
  const view = (await bo.a.get(S('/settings'))).body.settings;
  assert.deepEqual([view.join.remote_accounts, view.join.remote_min_age_days, view.join.remote_invite_bypass, view.remote_min_age_floor_days], [{ mode: 'inherit', list: [] }, 3, true, 0]);
  // only one.example from now on
  assert.equal((await settings({ remote_accounts: { mode: 'allowlist', list: ['one.example'] } })).status, 200);
  assert.equal((await one.a.get(S())).status, 200);
  for (const call of [() => two.a.get(S()), () => two.a.post(`/api/v1/channels/${general.cid}/messages`, { body: 'hi' }), () => two.a.get(S('/members')), () => two.a.post(S('/join'))]) {
    const r = await call();
    assert.deepEqual([r.status, r.body.error], [403, 'remote_not_allowed']);
  }
  assert.deepEqual((await two.a.get('/api/v1/servers')).body.servers, []); // gone from their list too
  assert.equal((await one.a.get('/api/v1/servers')).body.servers.length, 1);
  // nobody remote; local members are untouched
  await settings({ remote_accounts: 'none' });
  assert.equal((await one.a.get(S())).body.error, 'remote_not_allowed');
  assert.equal((await bo.a.get(S())).status, 200);
  // back to whatever the homeserver lets in: they are members again, nothing was lost
  await settings({ remote_accounts: { mode: 'inherit' } });
  assert.equal((await two.a.post(`/api/v1/channels/${general.cid}/messages`, { body: 'back' })).status, 200);
  assert.equal((await settings({ remote_accounts: { mode: 'sometimes' } })).body.error, 'invalid_remote_accounts');
  assert.equal((await settings({ remote_accounts: { mode: 'allowlist', list: ['no spaces.example'] } })).body.error, 'invalid_remote_accounts');
});

test('limits per homeserver: every account of a domain shares them; a new homeserver gets a fraction; overruns mean a hold', async () => {
  fresh();
  assert.equal((await fedPatch({ rate_limits: { exchanges_per_minute: 8, messages_per_minute: 4, new_divisor: 4, new_days: 30, hold_after: 3, hold_minutes: 60 } })).status, 200);
  // lim.example was first seen just now: 8 / 4 = 2 sign-ins a minute, whoever asks
  assert.equal((await signIn('lim.example', { id: 'l:1', ip: '198.51.100.20' })).status, 200);
  const second = await signIn('lim.example', { id: 'l:2', name: 'sam' });
  assert.equal(second.status, 200);
  let r = await signIn('lim.example', { id: 'l:3', name: 'tess' });
  assert.deepEqual([r.status, r.body.error], [429, 'homeserver_rate_limited']);
  assert.ok(r.body.retry_after >= 1 && r.body.retry_after <= 60, String(r.body.retry_after));
  assert.equal((await signIn('one.example')).status, 200); // another homeserver is not slowed down
  // an old homeserver gets the whole limit
  limits.reset(); old('lim.example');
  for (let i = 0; i < 8; i++) assert.equal((await signIn('lim.example', { id: 'l:' + (i + 1), name: 'u' + i })).status, 200);
  assert.equal((await signIn('lim.example')).status, 429);
  // messages: 4 a minute for the whole homeserver, on top of each account's own limit
  limits.reset();
  const a = second.a, b = (await signIn('lim.example', { id: 'l:3', name: 'tess' })).a;
  for (const u of [a, b]) assert.equal((await u.post(S('/join'))).status, 200);
  const post = u => u.post(`/api/v1/channels/${general.cid}/messages`, { body: 'x' });
  for (const u of [a, b, a, b]) assert.equal((await post(u)).status, 200);
  r = await post(a);
  assert.deepEqual([r.status, r.body.error], [429, 'homeserver_rate_limited']);
  assert.equal((await bo.a.post(`/api/v1/channels/${general.cid}/messages`, { body: 'local' })).status, 200);
  // the third refusal in ten minutes puts the homeserver on hold (five minutes, the first time): nothing counted gets through, sign-ins included
  await post(b);
  r = await post(a);
  assert.equal(r.status, 429);
  assert.ok(r.body.retry_after > 290 && r.body.retry_after <= 300, String(r.body.retry_after));
  assert.equal((await signIn('lim.example')).status, 429);
  const view = (await bo.a.get('/api/v2/homeserver/federation')).body;
  assert.deepEqual(view.held.map(h => [h.domain, h.minutes, h.level, h.refused]), [['lim.example', 5, 0, { messages: 3 }]]);
  // an admin lifts it
  assert.deepEqual((await fedPatch({ release: ['lim.example'] })).body.held, []);
  limits.reset();
  assert.equal((await post(a)).status, 200);
  assert.equal((await fedPatch({ rate_limits: { exchanges_per_minute: 0 } })).body.error, 'invalid_rate_limits');
  await fedPatch({ rate_limits: { exchanges_per_minute: 30, messages_per_minute: 300, hold_after: 5 } });
});

test('cooldown: a homeserver first seen less than remote_min_age_days ago cannot join', async () => {
  fresh();
  const u = await signIn('new.example', { ip: '203.0.113.9' });
  let r = await u.a.post(S('/join'));
  assert.deepEqual([r.status, r.body.error, r.body.days_left], [403, 'homeserver_too_new', 3]);
  seen._test.age('new.example', seen.DAY + 1000);
  assert.equal((await u.a.post(S('/join'))).body.days_left, 2);
  seen._test.age('new.example', 2 * seen.DAY);
  assert.equal((await u.a.post(S('/join'))).status, 200);
  // asking to join counts as joining
  const gated = (await bo.a.post('/api/v1/servers', { name: 'Gated', join_policy: 'request' })).body.server;
  const v = await signIn('newer.example', { ip: '203.0.114.9' });
  assert.equal((await v.a.post(`/api/v1/servers/${gated.sid}/join`, { message: 'hi' })).body.error, 'homeserver_too_new');
  // the server picks the number; the homeserver sets a floor under it
  await settings({ remote_min_age_days: 0 });
  assert.equal((await v.a.post(S('/join'))).status, 200);
  assert.equal((await fedPatch({ min_age_floor_days: 5 })).status, 200);
  const w = await signIn('newest.example', { ip: '203.0.115.9' });
  r = await w.a.post(S('/join'));
  assert.deepEqual([r.body.error, r.body.days_left], ['homeserver_too_new', 5]);
  assert.equal((await bo.a.get(S('/settings'))).body.settings.remote_min_age_floor_days, 5);
  await fedPatch({ min_age_floor_days: 0 }); await settings({ remote_min_age_days: 3 });
  assert.equal((await settings({ remote_min_age_days: -1 })).body.error, 'invalid_remote_min_age_days');
});

test('cooldown by registered domain: a new subdomain of a known domain is not a new homeserver', async () => {
  fresh();
  const a = await signIn('a.big.example', { ip: '203.0.120.1' });
  assert.equal((await a.a.post(S('/join'))).body.error, 'homeserver_too_new');
  seen._test.age('d:big.example', 10 * seen.DAY); // big.example has been around for ten days
  assert.equal((await a.a.post(S('/join'))).status, 200);
  const b = await signIn('b.big.example', { ip: '203.0.121.1' }); // never seen, another network
  assert.equal((await b.a.post(S('/join'))).status, 200);
  assert.ok(seen.ageDays('b.big.example') >= 10);
  // names under a hosting suffix are each their own registered domain
  const me = await signIn('me.github.io', { ip: '203.0.122.1' });
  seen._test.age('d:me.github.io', 10 * seen.DAY);
  assert.equal((await me.a.post(S('/join'))).status, 200);
  const you = await signIn('you.github.io', { ip: '203.0.123.1' });
  assert.equal((await you.a.post(S('/join'))).body.error, 'homeserver_too_new');
});

test('cooldown by network: a new domain on a known /24 (or /48) is as old as the network', async () => {
  fresh();
  const first = await signIn('ipold.example', { ip: '192.0.2.50' });
  assert.equal((await first.a.post(S('/join'))).body.error, 'homeserver_too_new');
  seen._test.age('n:192.0.2.0/24', 10 * seen.DAY);
  assert.equal((await first.a.post(S('/join'))).status, 200);
  const near = await signIn('ipnew.example', { ip: '192.0.2.99' });
  assert.equal((await near.a.post(S('/join'))).status, 200);
  const far = await signIn('ipfar.example', { ip: '192.0.3.99' });
  assert.equal((await far.a.post(S('/join'))).body.error, 'homeserver_too_new');
  const six = await signIn('six.example', { ip: '2001:db8:aa:1::5' });
  assert.equal(seen.row('six.example').net, '2001:db8:aa::/48');
  seen._test.age('n:2001:db8:aa::/48', 10 * seen.DAY);
  assert.equal((await six.a.post(S('/join'))).status, 200);
  assert.equal((await (await signIn('six2.example', { ip: '2001:db8:aa:ffff::9' })).a.post(S('/join'))).status, 200);
});

test('an invite made by a moderator skips the cooldown while remote_invite_bypass is on; the permanent code does not', async () => {
  fresh();
  const inv = (await bo.a.post(S('/invites'), {})).body.code;
  const permanent = (await bo.a.get(S())).body.server.invite;
  const u1 = await signIn('inv.example', { id: 'l:1', ip: '203.0.130.1' });
  assert.equal((await u1.a.post('/api/v1/join/' + permanent)).body.error, 'homeserver_too_new');
  assert.equal((await u1.a.post(S('/join'))).body.error, 'homeserver_too_new');
  assert.equal((await u1.a.post('/api/v1/join/' + inv)).status, 200);
  await settings({ remote_invite_bypass: false });
  const u2 = await signIn('inv.example', { id: 'l:2', name: 'sam' });
  assert.equal((await u2.a.post('/api/v1/join/' + inv)).body.error, 'homeserver_too_new');
  await settings({ remote_invite_bypass: true });
  assert.equal((await u2.a.post('/api/v1/join/' + inv)).status, 200);
});

// a shared deny list: a signed document and the JWKS its key is in
async function listServer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const s = { kid: 'deny1', body: { updated_at: 1, domains: [] }, tamper: null, status: 200, fetches: 0, jwksAt: '/.well-known/bonfire/jwks.json' };
  s.signed = () => {
    const doc = { ...s.body, signature: { alg: 'EdDSA', kid: s.kid, sig: crypto.sign(null, Buffer.from(denylist.canonical(s.body)), privateKey).toString('base64url') } };
    return s.tamper ? s.tamper(doc) : doc;
  };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj, null, 2)); };
    if (req.url === '/.well-known/ember/denylist') { s.fetches++; return send(s.status, s.status === 200 ? s.signed() : { error: 'down' }); }
    if (req.url === s.jwksAt) return send(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'deny1', alg: 'EdDSA', use: 'sig' }] });
    send(404, { error: 'not_found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${server.address().port}/.well-known/ember/denylist`;
  s.close = () => new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); });
  extra.push(s);
  return s;
}

test('the signature covers the document with sorted keys and no whitespace', () => {
  assert.equal(denylist.canonical({ b: [3, { z: 1, a: null }], a: 'x', c: { y: true, x: 1.5 } }), '{"a":"x","b":[3,{"a":null,"z":1}],"c":{"x":1.5,"y":true}}');
  const FS = require('../src/federation/settings');
  assert.deepEqual(FS.defaults().denylists, ['https://nookara.cc/.well-known/ember/denylist']);
  assert.deepEqual(config.get().federation.denylists, []); // this homeserver opted out
});

test('a shared deny list: verified, followed, kept when a later copy is bad, and its sessions end', async () => {
  fresh();
  const list = await listServer();
  const bad = await signIn('bad.example', { ip: '203.0.140.1' });
  assert.equal((await bad.a.get('/api/v1/me')).status, 200);
  const ws = await wsClient(base).login(bad.token);
  list.body = { updated_at: 1700000000, domains: ['bad.example', '*.worse.example'], networks: ['203.0.141.0/24'], accounts: ['l:9@one.example'], first_seen: { 'aged.example': Math.floor(Date.now() / 1000) - 40 * 86400 } };
  let r = await fedPatch({ denylists: [list.url] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.denylists.map(l => [l.url, l.entries, l.error, l.updated_at]), [[list.url, 4, null, 1700000000000]]);
  // refused from now on, and the session it had is gone
  assert.equal((await signIn('bad.example')).body.error, 'homeserver_denied');
  assert.equal((await bad.a.get('/api/v1/me')).status, 401);
  assert.deepEqual(await ws.closed, { code: 4003, reason: 'homeserver_denied' });
  assert.equal((await signIn('chat.worse.example', { ip: '203.0.142.1' })).body.error, 'homeserver_denied');
  r = await signIn('netbad.example', { ip: '203.0.141.77' }); // a fine name on a denied network
  assert.deepEqual([r.status, r.body.error], [403, 'homeserver_denied']);
  assert.equal((await signIn('one.example', { id: 'l:9', name: 'nine' })).body.error, 'homeserver_denied');
  assert.equal((await signIn('one.example', { id: 'l:1' })).status, 200);
  // the list has known aged.example for forty days: no cooldown here
  const aged = await signIn('aged.example', { ip: '203.0.143.1' });
  assert.equal((await aged.a.post(S('/join'))).status, 200);
  // a copy that does not verify changes nothing
  list.body = { updated_at: 1700000001, domains: ['one.example'] };
  list.tamper = doc => ({ ...doc, domains: ['one.example', 'two.example'] });
  r = await fedPatch({ refresh: true });
  assert.deepEqual(r.body.denylists.map(l => [l.entries, l.error]), [[4, 'bad_signature']]);
  assert.equal((await signIn('one.example')).status, 200);
  assert.equal((await signIn('bad.example')).body.error, 'homeserver_denied');
  // unsigned, signed by an unknown key, unreachable: the same
  for (const [change, error] of [[() => { list.tamper = ({ signature, ...doc }) => doc; }, 'unsigned'], [() => { list.tamper = null; list.kid = 'other'; }, 'unknown_kid'], [() => { list.kid = 'deny1'; list.status = 500; }, 'http_500']]) {
    change();
    r = await fedPatch({ refresh: true });
    assert.deepEqual(r.body.denylists.map(l => [l.entries, l.error]), [[4, error]]);
    assert.equal((await signIn('bad.example')).body.error, 'homeserver_denied');
  }
  // the last good copy survives a restart of the fetcher
  denylist.stop();
  assert.equal(denylist.check({ domain: 'bad.example' }), 'shared');
  // a good copy again, now without bad.example; the key may also be at /.well-known/ember/jwks.json
  list.status = 200; list.jwksAt = '/.well-known/ember/jwks.json';
  r = await fedPatch({ refresh: true });
  assert.deepEqual(r.body.denylists.map(l => [l.entries, l.error]), [[1, null]]);
  assert.equal((await signIn('bad.example')).status, 200);
  assert.equal((await signIn('one.example')).body.error, 'homeserver_denied');
  // following no list at all
  r = await fedPatch({ denylists: [] });
  assert.deepEqual(r.body.denylists, []);
  assert.equal((await signIn('one.example')).status, 200);
  assert.equal((await fedPatch({ denylists: ['ftp://nope'] })).body.error, 'invalid_denylists');
});

test("Nookara's list shape: entries with kind and value, accounts by handle, expired entries left out", async () => {
  fresh();
  const list = await listServer();
  const old = Date.now() - 1000;
  list.body = { version: 3, generated_at: Date.now(), first_seen: {}, entries: [
    { id: 1, kind: 'homeserver', value: 'evil.example', reason_category: 'spam', reason: 'spam', created_at: 1, expires_at: null },
    { id: 2, kind: 'account', value: 'mallory@one.example', reason_category: 'abuse', reason: 'abuse', created_at: 1, expires_at: null },
    { id: 3, kind: 'ip_range', value: '203.0.150.0/24', reason_category: 'other', reason: '', created_at: 1, expires_at: null },
    { id: 4, kind: 'homeserver', value: 'over.example', reason_category: 'other', reason: '', created_at: 1, expires_at: old },
  ] };
  const r = await fedPatch({ denylists: [list.url] });
  assert.deepEqual(r.body.denylists.map(l => [l.entries, l.error]), [[3, null]]);
  assert.equal((await signIn('evil.example', { ip: '203.0.151.1' })).body.error, 'homeserver_denied');
  assert.equal((await signIn('one.example', { id: 'l:7', name: 'Mallory' })).body.error, 'homeserver_denied');
  assert.equal((await signIn('one.example', { id: 'l:8', name: 'alice' })).status, 200);
  assert.equal((await signIn('fine.example', { ip: '203.0.150.9' })).body.error, 'homeserver_denied');
  assert.equal((await signIn('over.example', { ip: '203.0.152.1' })).status, 200);
  await fedPatch({ denylists: [] });
});

test('the deny entries of the homeserver itself: a domain, everything under one, a network, one account', async () => {
  fresh();
  const one = await signIn('one.example'), two = await signIn('two.example'), nine = await signIn('one.example', { id: 'l:9', name: 'nine' });
  let r = await fedPatch({ deny: ['l:9@one.example', 'Two.Example', '*.sub.example'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.federation.deny, ['l:9@one.example', 'two.example', '*.sub.example']);
  assert.equal((await nine.a.get('/api/v1/me')).status, 401);
  assert.equal((await two.a.get('/api/v1/me')).status, 401);
  assert.equal((await one.a.get('/api/v1/me')).status, 200);
  assert.equal((await signIn('two.example')).body.error, 'homeserver_denied');
  assert.equal((await signIn('a.sub.example', { ip: '203.0.150.1' })).body.error, 'homeserver_denied');
  // one.example answers from 198.51.100.1, lim.example from 198.51.100.20
  r = await fedPatch({ deny: ['198.51.100.0/28'] });
  assert.equal((await one.a.get('/api/v1/me')).status, 401);
  assert.equal((await signIn('one.example')).body.error, 'homeserver_denied');
  assert.equal((await signIn('lim.example')).status, 200);
  assert.equal((await fedPatch({ deny: ['not a rule'] })).body.error, 'invalid_deny');
  assert.equal((await api(base).get('/api/v2/homeserver/federation')).status, 401);
  await fedPatch({ deny: [] });
  assert.equal((await signIn('one.example')).status, 200);
});

test('holds: only for homeservers this one has nothing to do with; they escalate; admins see what was refused and lift them', async () => {
  fresh();
  const H = 'flood.example', t0 = Date.now();
  config.update({ federation: { rate_limits: { exchanges_per_minute: 2, hold_after: 3 } } });
  seen.touch('flood.example', {});
  try {
    const run = t => { const out = []; for (let i = 0; i < 6; i++) { try { limits.hit(H, 'exchanges', t); out.push(200); } catch (e) { out.push(e.extra.retry_after); } } return out; };
    seen._test.age(H, 40 * seen.DAY); // (old: the whole limit)
    // a stranger over its limit three times in ten minutes: 5 minutes, then 15, then hold_minutes (60)
    let r = run(t0);
    assert.deepEqual(r.slice(0, 2), [200, 200]);
    assert.equal(r[4], 300, 'the third refusal starts a 5 minute hold');
    assert.deepEqual(limits.held(t0).map(h => [h.domain, h.minutes, h.level, h.refused]), [[H, 5, 0, { exchanges: 3 }]]);
    r = run(t0 + 6 * 60000); assert.equal(r[4], 900);
    r = run(t0 + 30 * 60000); assert.equal(r[4], 3600);
    r = run(t0 + 100 * 60000); assert.equal(r[4], 3600, 'never longer than hold_minutes');
    // a day without a hold starts over
    r = run(t0 + 30 * 3600000); assert.equal(r[4], 300);
    // admins see it, with what was refused, and lift it
    let view = (await bo.a.get('/api/v2/homeserver/federation')).body;
    assert.ok(Array.isArray(view.throttled));
    limits.reset(); run(Date.now());
    view = (await bo.a.get('/api/v2/homeserver/federation')).body;
    assert.deepEqual(view.held.map(h => [h.domain, h.minutes]), [[H, 5]]);
    assert.ok(view.held[0].until > Date.now() && view.held[0].since <= Date.now());
    assert.deepEqual((await bo.a.del(`/api/v2/homeserver/federation/holds/${H}`)).body.held, []);
    assert.equal((await bo.a.del(`/api/v2/homeserver/federation/holds/${H}`)).body.error, 'not_held');
    // (lifted: what is left is the per-minute limit, not the hold)
    assert.ok((() => { try { limits.hit(H, 'exchanges'); return 0; } catch (e) { return e.extra.retry_after; } })() <= 60);

    // a homeserver an account here is friends with is never held, and gets the whole limit while it is new
    limits.reset();
    const F = 'friendly.example';
    seen._test.age(F, 0); // (first seen just now: a new homeserver)
    assert.equal(limits.limitFor(F, 'messages'), Math.floor(300 / 4));
    db.run("INSERT INTO friends (user_id, peer, state, message, created_at, updated_at) VALUES (?, ?, 'friend', '', ?, ?)", db.get("SELECT id FROM users WHERE username = 'bo'").id, `l:7@${F}`, Date.now(), Date.now());
    limits._test.forgetKnown();
    assert.equal(limits.known(F), true);
    assert.equal(limits.limitFor(F, 'messages'), 300);
    r = []; for (let i = 0; i < 20; i++) { try { limits.hit(F, 'exchanges'); r.push(200); } catch (e) { r.push(e.extra.retry_after); } }
    assert.deepEqual(r.slice(0, 2), [200, 200]);
    assert.ok(r.slice(2).every(x => x <= 60), 'refused per minute, never held: ' + r.join(','));
    assert.deepEqual(limits.held(), []);
    assert.deepEqual(limits.throttled().map(x => [x.domain, x.known, x.refused.exchanges]), [[F, true, 18]]);
  } finally {
    config.update({ federation: { rate_limits: { exchanges_per_minute: 30, hold_after: 5 } } });
    limits.reset();
  }
});

test('throttled: every homeserver refused anything in the last ten minutes, remote sign-ins included, before and during a hold', async () => {
  fresh();
  config.update({ federation: { rate_limits: { exchanges_per_minute: 2, hold_after: 3, new_divisor: 1 } } });
  try {
    const view = async () => (await bo.a.get('/api/v2/homeserver/federation')).body;
    const mine = v => v.throttled.find(x => x.domain === 'thr.example');
    for (let i = 0; i < 2; i++) assert.equal((await signIn('thr.example', { id: 'l:' + (i + 1), name: 'u' + i })).status, 200);
    let r = await signIn('thr.example', { id: 'l:3', name: 'u3' });
    assert.deepEqual([r.status, r.body.error], [429, 'homeserver_rate_limited']);
    let t = mine(await view());
    assert.deepEqual([t.refused, t.held, t.known], [{ exchanges: 1 }, false, false], 'listed from the first refusal');
    await signIn('thr.example', { id: 'l:4', name: 'u4' });
    r = await signIn('thr.example', { id: 'l:5', name: 'u5' }); // the third: a hold
    assert.ok(r.body.retry_after > 60);
    await signIn('thr.example', { id: 'l:6', name: 'u6' }); // refused while held: still counted
    const v = await view();
    t = mine(v);
    assert.deepEqual([t.refused, t.held], [{ exchanges: 4 }, true]);
    assert.deepEqual(v.held.map(h => h.domain), ['thr.example']);
  } finally {
    config.update({ federation: { rate_limits: { exchanges_per_minute: 30, hold_after: 5, new_divisor: 4 } } });
    limits.reset();
  }
});
