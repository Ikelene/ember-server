'use strict';
// Nookara accounts as the accounts of a homeserver (PROTOCOL §4a accounts.nookara_identity, §4c social, §4b extra_jwks):
// the `nookara` login method signs in as the v:<id> account Nookara instance tokens use, their social API may live
// elsewhere (config `social`), DMs hosted here tell that place about them, and extra JWKS are published as this domain's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { tmpDir, api, fakeIdp, mockHomeserver } = require('./helpers');
const nke1 = require('./nke1');

process.env.EMBER_DEV = '1';
process.env.EMBER_NOOKARA_REGISTRATION = 'off';
for (const k of ['EMBER_ACCOUNTS_MODE', 'EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL', 'EMBER_NOOKARA_URL']) delete process.env[k];
const { startServer } = require('../src/index');
const config = require('../src/config');
const auth = require('../src/auth');
const AS = require('../src/account-settings');
const keys = require('../src/federation/keys');
const s2s = require('../src/social/s2s');
const dms = require('../src/social/dms');
const messages = require('../src/messages');

const dir = tmpDir();
const APP = 'https://app.example', PASS = 'correct horse battery', DOMAIN = 'nk.example';
let inst, base, pub, alice, idp, nk, remoteHs, nookaraSide, jwksSrv, natOld, sid;
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const claimsOf = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => r(b)); });
const json = (res, s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

// an OpenID Connect provider standing in for nookara.cc (Ed25519 id_tokens)
function provider() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const p = { next: {} };
  p.server = http.createServer(async (req, res) => {
    const u = new URL(req.url, p.url);
    if (u.pathname === '/.well-known/openid-configuration') return json(res, 200, { issuer: p.url, authorization_endpoint: p.url + '/authorize', token_endpoint: p.url + '/token', jwks_uri: p.url + '/jwks', token_endpoint_auth_methods_supported: ['client_secret_basic'] });
    if (u.pathname === '/jwks') return json(res, 200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'EdDSA' }] });
    if (u.pathname === '/token' && req.method === 'POST') {
      await readBody(req);
      const t = Math.floor(Date.now() / 1000), n = p.next;
      const head = b64({ alg: 'EdDSA', typ: 'JWT', kid: 'k1' }), body = b64({ iss: p.url, aud: 'ember-client', nonce: n.nonce, iat: t, exp: t + 300, ...n.claims });
      return json(res, 200, { access_token: 'at', token_type: 'Bearer', id_token: `${head}.${body}.${crypto.sign(null, Buffer.from(head + '.' + body), privateKey).toString('base64url')}` });
    }
    json(res, 404, {});
  });
  return new Promise(r => p.server.listen(0, '127.0.0.1', () => { p.url = `http://127.0.0.1:${p.server.address().port}`; r(p); }));
}
const close = srv => new Promise(r => { srv.close(() => r()); srv.closeAllConnections?.(); });

// a browser going through /login/start/nookara -> the provider -> /login/callback/nookara -> the token endpoint
const pkce = () => { const verifier = crypto.randomBytes(32).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };
async function nookaraSignIn(claims) {
  const k = pkce();
  const q = { response_type: 'code', client_id: 'ember', redirect_uri: `${APP}/ember/auth/callback.html`, state: 'st1', code_challenge: k.challenge, code_challenge_method: 'S256' };
  const get = u => fetch(base + u, { redirect: 'manual' });
  const s = await get(`/login/start/nookara?${new URLSearchParams(q)}`);
  assert.equal(s.status, 302, await s.text());
  const to = new URL(s.headers.get('location'));
  idp.next = { nonce: to.searchParams.get('nonce'), claims };
  const r = await get(`/login/callback/nookara?${new URLSearchParams({ code: 'c1', state: to.searchParams.get('state') })}`);
  if (r.status !== 302) return { status: r.status, text: await r.text() };
  const code = new URL(r.headers.get('location')).searchParams.get('code');
  return api(base).post('/api/v2/auth/token', { grant_type: 'authorization_code', client_id: 'ember', code, code_verifier: k.verifier, redirect_uri: q.redirect_uri });
}

test.before(async () => {
  idp = await provider();
  inst = await startServer({ dataDir: dir, port: 0 });
  base = `http://localhost:${inst.port}`;
  const r = await api(base).post('/api/v1/auth/register', { username: 'alice', password: PASS });
  alice = api(base, r.body.session);
  assert.equal((await alice.post('/api/v1/instance/claim', { code: inst.setup.current() })).status, 200);
  pub = config.publicUrl();
  config.update({ domain: DOMAIN, nookara_url: idp.url, federation: { denylists: [] }, accounts: { remote_accounts: { mode: 'all', list: [] } } });
  nk = fakeIdp({ iss: idp.url, aud: pub });
  auth.setJwksFetcher(nk.jwks);
  s2s._test.setRetry([20, 20]);
  dms._test.setWindow(20);
});
test.after(async () => {
  await inst?.close();
  for (const x of [idp?.server, jwksSrv]) if (x) await close(x);
  for (const x of [remoteHs, nookaraSide]) await x?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nookara_identity: off by default, on by default when the domain is nookara_url\'s, the setting wins', () => {
  assert.equal(AS.nookaraIdentity({}, { domain: 'nookara.cc', nookara_url: 'https://nookara.cc' }), true);
  assert.equal(AS.nookaraIdentity({}, { domain: 'chat.example', nookara_url: 'https://nookara.cc' }), false);
  assert.equal(AS.nookaraIdentity({ nookara_identity: false }, { domain: 'nookara.cc', nookara_url: 'https://nookara.cc' }), false);
  assert.equal(AS.nookaraIdentity({ nookara_identity: true }, { domain: 'chat.example', nookara_url: 'https://nookara.cc' }), true);
  assert.equal(config.nookaraIdentity(), false);
  assert.throws(() => AS.sanitize({ nookara_identity: 'yes' }), /invalid_nookara_identity/);
});

test('a Nookara instance token still signs in (as v:<id>) once the homeserver hosts accounts with nookara_identity', async () => {
  // switched off: a local homeserver refuses Nookara tokens
  assert.equal((await api(base).post('/api/v1/auth/nookara', { token: nk.mint({ sub: '77', username: 'nat' }) })).body.error, 'wrong_accounts_mode');
  const r = await alice.patch('/api/v2/homeserver/accounts', {
    nookara_identity: true, ember_clients: [APP],
    login_methods: [{ id: 'password', kind: 'password', name: 'Password', enabled: true }, { id: 'nookara', kind: 'nookara', name: 'Nookara', enabled: true, client_id: 'ember-client', client_secret: 'shh' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.nookara_identity, true);
  assert.equal(config.nookaraIdentity(), true);
  const t = await api(base).post('/api/v1/auth/nookara', { token: nk.mint({ sub: '77', username: 'nat', display_name: 'Nat' }) });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.user.id, 'v:77');
  natOld = api(base, t.body.session);
  // nat (from a Nookara token) is in alice's server
  sid = (await alice.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body.server.sid;
  assert.equal((await natOld.post(`/api/v1/servers/${sid}/join`, {})).status, 200);
});

test('the nookara login method maps sub to the existing v: account: same id, same servers, the old token keeps working', async () => {
  const t = await nookaraSignIn({ sub: '77', preferred_username: 'nat', name: 'Nat N', picture: 'https://cdn.example/nat.png' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.deepEqual(t.body.account, { id: 'v:77', username: 'nat', domain: DOMAIN, handle: `nat@${DOMAIN}`, display_name: 'Nat N', avatar_url: 'https://cdn.example/nat.png' });
  const nat = api(base, t.body.access_token);
  const servers = (await nat.get('/api/v1/servers')).body;
  assert.ok(JSON.stringify(servers).includes(sid), JSON.stringify(servers));
  assert.equal((await natOld.get('/api/v1/servers')).status, 200);
  // no local account and no login link was made for it
  const db = require('../src/db');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM users WHERE kind = 'local'").n, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM login_links').n, 0);
  const logins = (await nat.get('/api/v2/account/logins')).body.logins;
  assert.deepEqual(logins.map(l => [l.id, l.linked]), [['password', false], ['nookara', true]]);
  // a refresh works for it too
  const again = await api(base).post('/api/v2/auth/token', { grant_type: 'refresh_token', client_id: 'ember', refresh_token: t.body.refresh_token });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.account.id, 'v:77');
  // a cross-homeserver token says v:77@<domain>
  const rt = await nat.post('/api/v2/auth/remote-token', { audience: 'http://127.0.0.1:9' });
  assert.equal(rt.status, 200, JSON.stringify(rt.body));
  assert.equal(claimsOf(rt.body.token).sub, `v:77@${DOMAIN}`);
  assert.equal(claimsOf(rt.body.token).preferred_username, 'nat');
  // linking a Nookara login to a local account means nothing now
  assert.equal((await alice.post('/login/link/nookara', {})).body.error, 'not_linkable');
});

test('a Nookara account signing in for the first time gets a v: account; a sub that is no Nookara id is refused', async () => {
  const t = await nookaraSignIn({ sub: '88', preferred_username: 'newbie', name: 'New Bie' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.account.id, 'v:88');
  assert.equal(t.body.account.handle, `newbie@${DOMAIN}`);
  const db = require('../src/db');
  assert.equal(db.get("SELECT kind, nookara_id FROM users WHERE principal = 'v:88'").nookara_id, '88');
  const bad = await nookaraSignIn({ sub: 'abc', preferred_username: 'x' });
  assert.equal(bad.status, 400);
});

test('discovery: social urls from config while nookara_identity is on; this homeserver\'s own otherwise', async () => {
  let d = (await api(base).get('/.well-known/ember')).body;
  assert.deepEqual(d.social, { api_url: pub + '/api/v2', s2s_url: pub + '/_ember/s2s/v1' });
  assert.equal(d.accounts.nookara_identity, true);
  nookaraSide = await mockHomeserver(DOMAIN);
  assert.throws(() => config.update({ social: { api_url: 'ftp://x.example' } }), /invalid_social/);
  config.update({ social: { api_url: nookaraSide.origin + '/api/v2', s2s_url: nookaraSide.origin + '/_ember/s2s/v1' } });
  d = (await api(base).get('/.well-known/ember')).body;
  assert.deepEqual(d.social, { api_url: nookaraSide.origin + '/api/v2', s2s_url: nookaraSide.origin + '/_ember/s2s/v1' });
  config.update({ accounts: { nookara_identity: false } });
  assert.deepEqual((await api(base).get('/.well-known/ember')).body.social, { api_url: pub + '/api/v2', s2s_url: pub + '/_ember/s2s/v1' });
  config.update({ accounts: { nookara_identity: true } });
});

test('social routes answer social_elsewhere for v: accounts; local accounts and DMs still work here', async () => {
  const nat = api(base, (await nookaraSignIn({ sub: '77', preferred_username: 'nat' })).body.access_token);
  for (const [m, p, b] of [['get', '/api/v2/social/friends'], ['post', '/api/v2/social/friends', { handle: 'alice' }], ['post', '/api/v2/social/blocks/l%3A1'], ['put', '/api/v2/social/keys', { keys: [] }], ['get', '/api/v2/social/keys/l%3A1%40m.example'],
    ['get', '/api/v2/social/e2ee/me'], ['post', '/api/v2/social/e2ee', {}], ['post', '/api/v2/social/e2ee/unlock', { kind: 'passcode', auth: 'x' }], ['post', '/api/v2/social/e2ee/link', {}]]) { // (their keys are Nookara's to keep)
    const r = await nat[m](p, b);
    assert.deepEqual([r.status, r.body.error, r.body.api_url], [409, 'social_elsewhere', nookaraSide.origin + '/api/v2'], `${m} ${p}`);
  }
  assert.equal((await alice.get('/api/v2/social/friends')).status, 200);
  assert.equal((await nat.get('/api/v2/social/dms')).status, 200);
  assert.equal((await alice.get('/api/v2/social/e2ee/me')).body.has, false);
  // a DM message of a Nookara account is reported to Nookara, wherever the DM is hosted (PROTOCOL §4d)
  const sent = nke1.seal({ dm: `d1@${DOMAIN}`, from: `v:77@${DOMAIN}`, text: 'x', to: [nke1.account()], signer: nke1.account() });
  const r = await alice.post('/api/v2/social/reports', { message: { dm: `d1@${DOMAIN}`, id: '5', from: `v:77@${DOMAIN}`, envelope: sent.enc }, revealed_key: sent.k, reason: 'spam' });
  assert.deepEqual([r.status, r.body], [409, { error: 'report_elsewhere', url: nookaraSide.origin + '/api/report/dm-message', api_url: nookaraSide.origin + '/api/v2' }]);
  config.update({ social: { reports_url: nookaraSide.origin + '/somewhere/reports' } });
  assert.equal((await alice.post('/api/v2/social/reports', { message: { dm: `d1@${DOMAIN}`, id: '5', from: `v:77@${DOMAIN}`, envelope: sent.enc }, revealed_key: sent.k, reason: 'spam' })).body.url, nookaraSide.origin + '/somewhere/reports');
  config.update({ social: { reports_url: null } });
  // its key document is asked for where its keys are
  const doc = { id: `v:77@${DOMAIN}`, format: 'nke1', owner: '77', keys: [(k => ({ kid: k.kid, kind: 'account', alg: 'p256', public_key: k.sig_pub, enc_public_key: k.enc_pub, created_at: 1 }))(nke1.account())], clients: { seq: 0, list: [] }, clients_sig: null, clients_seq: 0, past: [] };
  nookaraSide.handle = (req, res) => json(res, req.url.startsWith('/_ember/s2s/v1/keys/') ? 200 : 404, req.url.startsWith('/_ember/s2s/v1/keys/') ? doc : { error: 'not_found' });
  assert.deepEqual((await alice.get(`/api/v2/social/keys/${encodeURIComponent(doc.id)}`)).body, doc);
  nookaraSide.handle = null;
  require('../src/db').run("DELETE FROM social_cache WHERE kind = 'keys'");
});

test('s2s for a v: account arriving here while its social API is elsewhere: 421 misdirected', async () => {
  remoteHs = await mockHomeserver('m.example');
  config.update({ federation: { dev_origins: { 'm.example': remoteHs.origin } } });
  let r = await remoteHs.s2s(base, 'POST', '/friend_request', { from: 'l:1@m.example', to: `v:77@${DOMAIN}` });
  assert.deepEqual([r.status, r.body.error, r.body.s2s_url], [421, 'misdirected', nookaraSide.origin + '/_ember/s2s/v1']);
  r = await remoteHs.s2s(base, 'GET', '/profile/' + encodeURIComponent(`v:77@${DOMAIN}`));
  assert.equal(r.status, 421);
  // a local account is still answered here
  r = await remoteHs.s2s(base, 'GET', '/profile/' + encodeURIComponent(`l:1@${DOMAIN}`));
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('a v: account starts a DM with a remote member: hosted here, pointers to the remote homeserver and to social.s2s_url', async () => {
  const seen = { remote: [], nookara: [] };
  const record = (list, answer) => async (req, res) => {
    const body = await readBody(req);
    list.push({ method: req.method, path: req.url, headers: req.headers, raw: body, body: body ? JSON.parse(body) : null });
    json(res, 200, answer(req));
  };
  remoteHs.handle = record(seen.remote, req => (req.url.startsWith('/_ember/s2s/v1/profile/')
    ? { id: 'l:1@m.example', handle: 'remi@m.example', display_name: 'Remi', avatar_url: null, presence: { status: 'offline' } } : { ok: true }));
  nookaraSide.handle = record(seen.nookara, () => ({ ok: true }));
  const nat = api(base, (await nookaraSignIn({ sub: '77', preferred_username: 'nat' })).body.access_token);
  const r = await nat.post('/api/v2/social/dms', { member_ids: ['l:1@m.example'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  const dm = r.body.dm;
  assert.equal(dm.host, DOMAIN);
  assert.deepEqual(dm.members.map(m => m.id), [`v:77@${DOMAIN}`, 'l:1@m.example']);
  await s2s.idle();
  // the remote member's homeserver: dm_pointer added, from the v: account
  const toRemote = seen.remote.find(x => x.path === '/_ember/s2s/v1/dm_pointer');
  assert.deepEqual([toRemote.body.to, toRemote.body.kind, toRemote.body.from, toRemote.body.dm.id], ['l:1@m.example', 'added', `v:77@${DOMAIN}`, dm.id]);
  // the starter's own DM list lives at social.s2s_url: it gets the pointer, signed by this homeserver
  const toNookara = seen.nookara.find(x => x.path === '/_ember/s2s/v1/dm_pointer');
  assert.ok(toNookara, JSON.stringify(seen.nookara.map(x => x.path)));
  assert.deepEqual([toNookara.body.to, toNookara.body.kind, toNookara.body.from, toNookara.body.dm.id], [`v:77@${DOMAIN}`, 'added', `v:77@${DOMAIN}`, dm.id]);
  const m = /keyId="([^"#]+)#([^"]+)", created=(\d+), sig="([^"]+)"/.exec(toNookara.headers['ember-signature']);
  assert.equal(m[1], DOMAIN);
  const jwk = keys.jwks().keys.find(k => k.kid === m[2]);
  const signed = ['POST', toNookara.path, new URL(nookaraSide.origin).host, m[3], 'sha-256=' + crypto.createHash('sha256').update(toNookara.raw).digest('base64url')].join('\n');
  assert.ok(crypto.verify(null, Buffer.from(signed), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(m[4], 'base64url')));

  // the DM works for nat through this homeserver's own routes
  assert.ok((await nat.get('/api/v2/social/dms')).body.dms.some(x => x.id === dm.id));
  messages._sendLimit.reset();
  assert.equal((await nat.post(`/api/v1/channels/${dm.channel}/messages`, { enc: nke1.sealed('hi remi') })).status, 200);
  dms._test.flush(); await s2s.idle();
  const act = seen.remote.find(x => x.path === '/_ember/s2s/v1/dm_activity');
  assert.deepEqual([act.body.to, act.body.dm, act.body.sender.id], ['l:1@m.example', dm.id, `v:77@${DOMAIN}`]);

  // remi, signed in here from m.example, answers: nat's activity goes to social.s2s_url
  remoteHs.aud = pub;
  const x = await api(base).post('/api/v2/auth/remote', { token: remoteHs.mint({ sub: 'l:1@m.example' }) });
  assert.equal(x.status, 200, JSON.stringify(x.body));
  messages._sendLimit.reset();
  assert.equal((await api(base, x.body.access_token).post(`/api/v1/channels/${dm.channel}/messages`, { enc: nke1.sealed('hey nat') })).status, 200);
  dms._test.flush(); await s2s.idle();
  const natAct = seen.nookara.find(y => y.path === '/_ember/s2s/v1/dm_activity');
  assert.ok(natAct, JSON.stringify(seen.nookara.map(y => y.path)));
  assert.deepEqual([natAct.body.to, natAct.body.dm, natAct.body.sender.id, natAct.body.preview], [`v:77@${DOMAIN}`, dm.id, 'l:1@m.example', undefined]); // sealed: no preview
  remoteHs.handle = null; nookaraSide.handle = null;
});

test('federation.extra_jwks: published with this homeserver\'s keys, colliding kids skipped, an unknown kid fetches again', async () => {
  const extra = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  const own = keys.jwks().keys;
  let served = [{ ...extra, kid: 'nk1' }, { ...extra, kid: own[0].kid }, { ...extra, kid: 'hs_0000000000000000' }, { kty: 'RSA', kid: 'rsa1' }];
  let fetches = 0;
  jwksSrv = http.createServer((req, res) => { fetches++; json(res, 200, { keys: served }); });
  await new Promise(r => jwksSrv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${jwksSrv.address().port}/jwks.json`;
  assert.equal((await alice.patch('/api/v2/homeserver/federation', { extra_jwks: ['ftp://x'] })).body.error, 'invalid_extra_jwks');
  const p = await alice.patch('/api/v2/homeserver/federation', { extra_jwks: [url] });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.federation.extra_jwks, [url]);
  let j = (await api(base).get('/.well-known/ember/jwks.json')).body;
  assert.deepEqual(j.keys.map(k => k.kid), [...own.map(k => k.kid), 'nk1']);
  assert.deepEqual(j.keys.at(-1), { kty: 'OKP', crv: 'Ed25519', x: extra.x, kid: 'nk1', alg: 'EdDSA', use: 'sig' });
  // cached for an hour ...
  served = [...served, { ...extra, kid: 'nk2' }];
  j = (await api(base).get('/.well-known/ember/jwks.json')).body;
  assert.equal(fetches, 1);
  assert.ok(!j.keys.some(k => k.kid === 'nk2'));
  // ... unless a verifier asks for a kid nobody has (at most once a minute)
  j = (await api(base).get('/.well-known/ember/jwks.json?kid=nk2')).body;
  assert.ok(j.keys.some(k => k.kid === 'nk2'));
  assert.equal(fetches, 2);
  await api(base).get('/.well-known/ember/jwks.json?kid=nk3');
  assert.equal(fetches, 2);
});
