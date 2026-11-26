'use strict';
// Cross-homeserver sign-in (PROTOCOL §4b): homeserver A (a real one, in a worker thread) signs a token for its account,
// homeserver B (this thread) checks it against A's published keys and opens a session for a remote user. Then everything a
// token can get wrong, against stand-in homeservers whose keys the test holds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api, wsClient, startHomeserver, mockHomeserver } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
process.env.EMBER_DEV = '1'; // homeservers on this machine, over http
delete process.env.EMBER_OWNER;
delete process.env.EMBER_MANAGED;
delete process.env.EMBER_PUBLIC_URL;
const { startServer } = require('../src/index');
const config = require('../src/config');
const resolve = require('../src/federation/resolve');
const seen = require('../src/federation/seen');
const limits = require('../src/federation/limits');

const dirA = tmpDir(), dirB = tmpDir();
let A, B, baseB, audB, bo, alice, lobby;
const mocks = [];
const ips = new Map(); // homeserver origin -> the addresses it "answers from"
const PW = 'correct horse battery';
const reg = async (base, n) => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: PW }); assert.equal(r.status, 200, JSON.stringify(r.body)); return { ...r.body, a: api(base, r.body.session) }; };
const b64 = s => JSON.parse(Buffer.from(s, 'base64url').toString());
const exchange = token => api(baseB).post('/api/v2/auth/remote', { token });
const tokenFromA = async (who = alice) => { const r = await who.a.post('/api/v2/auth/remote-token', { audience: audB }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.token; };
// a stand-in homeserver for `domain`. known: false = B is not told where it is (the test points the domain elsewhere)
async function mock(domain, opts, { known = true } = {}) {
  const hs = await mockHomeserver(domain, opts);
  hs.aud = audB;
  mocks.push(hs);
  if (known) config.update({ federation: { dev_origins: { ...config.get().federation.dev_origins, [domain]: hs.origin } } });
  return hs;
}

test.before(async () => {
  B = await startServer({ dataDir: dirB, port: 0 });
  baseB = B.url; audB = `http://localhost:${B.port}`;
  bo = await reg(baseB, 'bo');
  assert.equal((await bo.a.post('/api/v1/instance/claim', { code: B.setup.current() })).status, 200);
  lobby = (await bo.a.post('/api/v1/servers', { name: 'Lobby', join_policy: 'open' })).body.server;
  A = await startHomeserver({ dataDir: dirA, config: { domain: 'a.example' } });
  alice = await reg(A.url, 'alice');
  assert.equal((await alice.a.post('/api/v1/instance/claim', { code: A.setupCode })).status, 200);
  config.update({ federation: { denylists: [], dev_origins: { 'a.example': A.url } } });
  resolve._test.setAddresses(origin => ips.get(origin) || []);
  ips.set(A.url, ['198.51.100.10']);
});
test.after(async () => {
  resolve._test.setAddresses(null);
  await A?.close(); await B?.close();
  for (const m of mocks) await m.close();
  for (const d of [dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
});

test('discovery names the keys and the sign-in routes; the JWKS lists the signing key', async () => {
  const d = (await api(A.url).get('/.well-known/ember')).body;
  assert.equal(d.homeserver.domain, 'a.example');
  assert.equal(d.jwks_uri, `${A.url}/.well-known/ember/jwks.json`);
  assert.deepEqual(d.federation, { remote_token_url: `${A.url}/api/v2/auth/remote-token`, remote_url: `${A.url}/api/v2/auth/remote`, accepts_remote: 'none' });
  const jwks = (await api(A.url).get('/.well-known/ember/jwks.json')).body;
  assert.equal(jwks.keys.length, 1);
  const k = jwks.keys[0];
  assert.deepEqual([k.kty, k.crv, k.alg, k.use], ['OKP', 'Ed25519', 'EdDSA', 'sig']);
  assert.match(k.kid, /^hs_[0-9a-f]{16}$/);
  assert.equal(k.d, undefined); // never the private half
});

test('a homeserver signs a token for its own account and one audience', async () => {
  const r = await alice.a.post('/api/v2/auth/remote-token', { audience: audB + '/some/path' });
  assert.equal(r.status, 200);
  assert.equal(r.body.expires_in, 3600);
  const [h, c] = r.body.token.split('.').map((p, i) => (i < 2 ? b64(p) : p));
  assert.deepEqual([h.alg, h.typ], ['EdDSA', 'ember-remote+jwt']);
  assert.match(h.kid, /^hs_/);
  assert.equal(c.iss, A.url); assert.equal(c.sub, 'l:1@a.example'); assert.equal(c.aud, audB); assert.equal(c.domain, 'a.example');
  assert.equal(c.exp - c.iat, 3600); assert.match(c.jti, /^[0-9a-f]{32}$/);
  assert.deepEqual([c.preferred_username, c.name, c.picture], ['alice', 'alice', null]);
  // no session, not https (only this machine may be http, and only in development), ourselves
  assert.equal((await api(A.url).post('/api/v2/auth/remote-token', { audience: audB })).status, 401);
  for (const [audience, reason] of [['http://b.example', 'https_required'], [A.url, 'own_homeserver'], ['nonsense', undefined], [undefined, undefined]]) {
    const bad = await alice.a.post('/api/v2/auth/remote-token', { audience });
    assert.deepEqual([bad.status, bad.body.error, bad.body.reason], [400, 'invalid_audience', reason]);
  }
  assert.equal((await alice.a.post('/api/v2/auth/remote-token', { audience: 'https://b.example' })).status, 200);
});

test('remote accounts are off until the homeserver lets them in', async () => {
  const r = await exchange(await tokenFromA());
  assert.deepEqual([r.status, r.body.error], [403, 'remote_accounts_off']);
  const p = await bo.a.patch('/api/v2/homeserver/accounts', { remote_accounts: { mode: 'all' } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await api(baseB).get('/.well-known/ember')).body.federation.accepts_remote, 'all');
});

test('issue on A, exchange on B, use B: a remote user with a session, a refresh token and a profile from the token', async () => {
  const token = await tokenFromA();
  const r = await exchange(token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.token_type, r.body.expires_in], ['Bearer', 3600]);
  assert.deepEqual(r.body.account, { id: 'l:1@a.example', username: 'alice', domain: 'a.example', handle: 'alice@a.example', display_name: 'alice', avatar_url: null, remote: true });
  const al = api(baseB, r.body.access_token);
  const me = (await al.get('/api/v1/me')).body;
  assert.deepEqual([me.user.id, me.user.kind, me.user.username, me.user.remote, me.user.domain, me.instance_admin], ['l:1@a.example', 'remote', 'alice@a.example', true, 'a.example', false]);
  assert.deepEqual(me.scopes, ['chat', 'voice', 'media']);
  // the same token twice
  const again = await exchange(token);
  assert.deepEqual([again.status, again.body.error], [401, 'token_replayed']);
  // refresh like any homeserver session
  const fresh = await api(baseB).post('/api/v2/auth/token', { grant_type: 'refresh_token', client_id: 'ember', refresh_token: r.body.refresh_token });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.account.handle, 'alice@a.example');
  assert.equal((await api(baseB, fresh.body.access_token).get('/api/v1/me')).status, 200);
  // a remote account has no password or profile to edit here, and cannot take the homeserver over
  assert.equal((await al.patch('/api/v1/me/profile', { bio: 'x' })).body.error, 'local_accounts_only');
  assert.equal((await al.post('/api/v1/instance/claim', { code: 'AAAA-AAAA' })).body.error, 'already_claimed');
  // the Bearer header carries the token just as well; a renamed account is refreshed on its next sign-in
  await alice.a.patch('/api/v1/me/profile', { display_name: 'Alice A.' });
  const viaHeader = await api(baseB, await tokenFromA()).post('/api/v2/auth/remote', {});
  assert.equal(viaHeader.status, 200, JSON.stringify(viaHeader.body));
  assert.equal(viaHeader.body.account.display_name, 'Alice A.');
  assert.equal(require('../src/db').get("SELECT COUNT(*) AS n FROM users WHERE kind = 'remote'").n, 1);
});

test('a remote user joins a server once their homeserver is old enough, and chats there', async () => {
  const al = api(baseB, (await exchange(await tokenFromA())).body.access_token);
  const early = await al.post(`/api/v1/servers/${lobby.sid}/join`);
  assert.deepEqual([early.status, early.body.error, early.body.days_left], [403, 'homeserver_too_new', 3]);
  seen._test.age('a.example', 4 * seen.DAY);
  const j = await al.post(`/api/v1/servers/${lobby.sid}/join`);
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.equal(j.body.server.role, 'member');
  const detail = (await al.get(`/api/v1/servers/${lobby.sid}`)).body;
  const general = detail.channels.find(c => c.name === 'general');
  const second = (await exchange(await tokenFromA())).body.access_token;
  const ws = await wsClient(baseB).login(second);
  const sent = await al.post(`/api/v1/channels/${general.cid}/messages`, { body: 'hello from a.example' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const frame = await ws.waitFor(f => f.type === 'chat_message');
  assert.deepEqual([frame.message.author.id, frame.message.author.kind, frame.message.author.domain], ['l:1@a.example', 'remote', 'a.example']);
  ws.close(); await ws.closed;
  const members = (await bo.a.get(`/api/v1/servers/${lobby.sid}/members`)).body.members;
  const m = members.find(x => x.id === 'l:1@a.example');
  assert.deepEqual([m.username, m.kind, m.domain], ['alice@a.example', 'remote', 'a.example']);
  // mentions and identity lookups take the longer id
  assert.equal((await bo.a.get('/api/v1/identities?ids=' + encodeURIComponent('l:1@a.example'))).status, 200);
});

test('rotation: the new key signs at once, the old one stays published for seven days', async () => {
  const before = await A.call('keys');
  const kid = await A.call('rotateKey');
  assert.notEqual(kid, before.current);
  let jwks = (await api(A.url).get('/.well-known/ember/jwks.json')).body.keys.map(k => k.kid);
  assert.deepEqual(jwks.sort(), [before.current, kid].sort());
  const token = await tokenFromA();
  assert.equal(b64(token.split('.')[0]).kid, kid);
  // B has the old JWKS cached: the unknown kid makes it fetch again
  const r = await exchange(token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await A.call('ageKey', { kid: before.current, ms: 7 * 24 * 3600 * 1000 + 1000 });
  jwks = (await api(A.url).get('/.well-known/ember/jwks.json')).body.keys.map(k => k.kid);
  assert.deepEqual(jwks, [kid]);
});

test('what a token can get wrong', async () => {
  const m = await mock('m.example');
  ips.set(m.origin, ['203.0.113.5']);
  const expect = async (token, status, error) => { const r = await exchange(token); assert.deepEqual([r.status, r.body.error], [status, error], JSON.stringify(r.body)); return r; };
  const s = Math.floor(Date.now() / 1000);
  await expect(m.mint({ aud: 'https://someone.else' }), 401, 'invalid_audience');
  await expect(m.mint({ iat: s - 7200, exp: s - 3600 }), 401, 'token_expired');
  await expect(m.mint({ iat: s - 3630, exp: s - 30 }), 200, undefined); // inside the 60 s of clock skew
  await expect(m.mint({ iat: s + 600, exp: s + 1200 }), 401, 'invalid_token'); // from the future
  await expect(m.mint({ exp: s + 86400 }), 401, 'invalid_token');               // longer than an hour
  await expect(m.mint({ jti: undefined }), 401, 'invalid_token');
  await expect(m.mint({}, { typ: 'JWT' }), 401, 'invalid_token');
  await expect(m.mint({ sub: 'l:1' }), 401, 'invalid_token');
  await expect(m.mint({ domain: 'other.example' }), 401, 'invalid_token');
  await expect(m.mint({}, { iss: 'http://127.0.0.1:1' }), 401, 'invalid_issuer');
  await expect(m.mint({ sub: 'l:1@localhost', domain: 'localhost' }), 400, 'own_homeserver');
  await expect('not.a.token', 401, 'invalid_token');
  await expect(undefined, 401, 'invalid_token');
  const good = m.mint();
  await expect(good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA'), 401, 'invalid_signature');
  // a token signed for m.example by a.example's key: a.example cannot speak for another domain
  const other = await mock('m.example', {}, { known: false });
  await expect(other.mint({}, { iss: m.origin }), 401, 'invalid_signature');
  const ok = await expect(good, 200, undefined);
  assert.equal(ok.body.account.handle, 'remi@m.example');
});

test('an unknown kid fetches the keys again, at most once a minute per homeserver', async () => {
  const m = mocks.find(x => x.domain === 'm.example');
  limits.reset();
  const k2 = m.addKey('k2'); m.published = [m.keys[0]]; // k2 exists but is not published yet
  const n = m.jwksFetches;
  let r = await exchange(m.mint({}, { key: k2 }));
  assert.deepEqual([r.status, r.body.error], [401, 'unknown_kid']);
  assert.equal(m.jwksFetches, n + 1);
  m.published = null; // published now, but B asked a moment ago
  r = await exchange(m.mint({}, { key: k2 }));
  assert.deepEqual([r.status, r.body.error], [401, 'unknown_kid']);
  assert.equal(m.jwksFetches, n + 1);
  resolve._test.ageJwks(m.origin, 61 * 1000);
  r = await exchange(m.mint({}, { key: k2 }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(m.jwksFetches, n + 2);
  // a retired key that is no longer published stops working once the cached keys are an hour old
  m.published = [k2];
  assert.equal((await exchange(m.mint({}, { key: m.keys[0] }))).status, 200);
  resolve._test.ageJwks(m.origin, 3601 * 1000);
  r = await exchange(m.mint({}, { key: m.keys[0] }));
  assert.deepEqual([r.status, r.body.error], [401, 'unknown_kid']);
});

test('the domain has to point at the homeserver: discovery mismatch, delegation, keys on another origin', async () => {
  limits.reset(); require('../src/federation')._test.exchangeLimit.reset();
  const liar = await mock('liar.example');
  liar.doc = { homeserver: { domain: 'victim.example' }, jwks_uri: liar.origin + '/.well-known/ember/jwks.json' };
  let r = await exchange(liar.mint());
  assert.deepEqual([r.status, r.body.error, r.body.reason], [502, 'homeserver_unreachable', 'domain_mismatch']);
  const n = liar.discoveryFetches;
  await exchange(liar.mint()); // the failure is remembered for a minute
  assert.equal(liar.discoveryFetches, n);
  // deleg.example hands its accounts to a homeserver on another origin, which names the domain
  const real = await mock('deleg.example', {}, { known: false });
  await mock('deleg.example', { delegateTo: real.origin });
  r = await exchange(real.mint());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.account.domain, 'deleg.example');
  assert.equal(seen.row('deleg.example').origin, real.origin);
  // a token whose iss is the delegating origin, not the homeserver
  const front = mocks.find(x => x.domain === 'deleg.example' && x !== real);
  r = await exchange(real.mint({}, { iss: front.origin }));
  assert.deepEqual([r.status, r.body.error], [401, 'invalid_issuer']);
  // keys served from somewhere else are not this homeserver's keys
  const far = await mock('far.example');
  far.doc = { homeserver: { domain: 'far.example' }, jwks_uri: real.origin + '/.well-known/ember/jwks.json' };
  r = await exchange(far.mint());
  assert.deepEqual([r.status, r.body.error, r.body.reason], [502, 'homeserver_unreachable', 'bad_jwks_uri']);
  // nobody home
  config.update({ federation: { dev_origins: { ...config.get().federation.dev_origins, 'gone.example': 'http://127.0.0.1:9' } } });
  const gone = await mock('gone.example', {}, { known: false });
  r = await exchange(gone.mint());
  assert.deepEqual([r.status, r.body.error], [502, 'homeserver_unreachable']);
});
