'use strict';
// Homeserver accounts and login (PROTOCOL §4a): the accounts settings and their migration from accounts_mode, the /login page
// as an OAuth 2.0 authorize endpoint (PKCE, redirect rules, CSRF), the token endpoint (codes, refresh rotation), outside
// logins against a stand-in OpenID Connect / OAuth 2.0 provider, linking, and discovery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_DEV = '1'; // the stand-in provider is http on this machine
delete process.env.EMBER_ACCOUNTS_MODE;
delete process.env.EMBER_OWNER;
delete process.env.EMBER_MANAGED;
delete process.env.EMBER_PUBLIC_URL;
delete process.env.EMBER_NOOKARA_URL;

const config = require('../src/config');
const AS = require('../src/account-settings');
const O = require('../src/oauth');
const { startServer } = require('../src/index');

const dir = tmpDir();
let inst, base, pub, alice, idp;
const APP = 'https://app.example';
const PASS = 'correct horse battery';
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

test.after(async () => { await inst?.close(); await idp?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- a stand-in provider (OpenID Connect + OAuth 2.0 userinfo)
function provider() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const p = { kid: 'k1', privateKey, other, discoveryHits: 0, tokenCalls: [], next: {}, userinfo: {}, discovery: true };
  const sign = (claims, key = privateKey, head = { alg: 'RS256', typ: 'JWT', kid: p.kid }) => {
    const data = `${b64(head)}.${b64(claims)}`;
    return `${data}.${crypto.sign('sha256', Buffer.from(data), key).toString('base64url')}`;
  };
  p.server = http.createServer((req, res) => {
    const u = new URL(req.url, p.url);
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/.well-known/openid-configuration') {
      p.discoveryHits++;
      if (!p.discovery) return json(404, {});
      return json(200, { issuer: p.url, authorization_endpoint: p.url + '/authorize', token_endpoint: p.url + '/token', userinfo_endpoint: p.url + '/userinfo', jwks_uri: p.url + '/jwks', token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] });
    }
    if (u.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: p.kid, use: 'sig', alg: 'RS256' }] });
    if (u.pathname === '/userinfo') return req.headers.authorization === 'Bearer at-' + p.userinfoFor ? json(200, p.userinfo) : json(401, {});
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        const f = Object.fromEntries(new URLSearchParams(body));
        p.tokenCalls.push({ form: f, authorization: req.headers.authorization || null });
        const n = p.next;
        const t = Math.floor(Date.now() / 1000);
        const claims = { iss: p.url, aud: 'ember-client', sub: 'sub-1', nonce: n.nonce, iat: t, exp: t + 300, ...(n.claims || {}) };
        p.userinfoFor = f.code;
        json(200, { access_token: 'at-' + f.code, token_type: 'Bearer', id_token: n.raw || sign(claims, n.key || privateKey, n.head) });
      });
      return;
    }
    json(404, {});
  });
  p.listen = () => new Promise(r => p.server.listen(0, '127.0.0.1', () => { p.url = `http://127.0.0.1:${p.server.address().port}`; r(p); }));
  p.close = () => new Promise(r => { p.server.close(() => r()); p.server.closeAllConnections?.(); });
  return p;
}

// ---------------------------------------------------------------- a browser, more or less
const pkce = () => { const verifier = crypto.randomBytes(32).toString('base64url'); return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }; };
function authz(over = {}) {
  const k = pkce();
  const q = { response_type: 'code', client_id: 'ember', redirect_uri: `${APP}/ember/auth/callback.html`, state: 'st-' + crypto.randomBytes(4).toString('hex'), code_challenge: k.challenge, code_challenge_method: 'S256', ...over };
  return { q, verifier: k.verifier, qs: new URLSearchParams(q).toString() };
}
function browser() {
  const jar = {};
  const call = async (method, url, form) => {
    const headers = { Accept: 'text/html' };
    if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const r = await fetch(url.startsWith('http') ? url : base + url, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: r.status, location: r.headers.get('location'), headers: r.headers, text: await r.text() };
  };
  const field = (html, name) => (new RegExp(`name="${name}" value="([^"]*)"`).exec(html) || [])[1];
  return { jar, get: u => call('GET', u), post: (u, f) => call('POST', u, f), field };
}
// open /login, post the password form -> the redirect
async function passwordLogin(a, username, password = PASS, extra = {}) {
  const b = browser();
  const pg = await b.get('/login?' + a.qs + (extra.link ? '&link=' + extra.link : ''));
  assert.equal(pg.status, 200, pg.text);
  return b.post('/login', { ...a.q, csrf: b.field(pg.text, 'csrf'), action: extra.action || 'login', username, password, ...(extra.action === 'register' ? { password2: password } : {}), ...(extra.link ? { link: extra.link } : {}) });
}
const answer = loc => { const u = new URL(loc); const frag = u.hash.includes('?') ? new URLSearchParams(u.hash.slice(u.hash.indexOf('?') + 1)) : null; return Object.fromEntries(frag || u.searchParams); };
const tokenCall = (body, headers = {}) => api(base).raw('POST', '/api/v2/auth/token', body, headers);
const redeem = (a, code, over = {}) => tokenCall({ grant_type: 'authorization_code', client_id: 'ember', code, code_verifier: a.verifier, redirect_uri: a.q.redirect_uri, ...over });
async function signIn(username, password = PASS) {
  const a = authz();
  const r = await passwordLogin(a, username, password);
  assert.equal(r.status, 302, r.text);
  const t = await redeem(a, answer(r.location).code);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  return t.body;
}
// go through an outside method: /login/start -> (the provider) -> /login/callback. -> the last response
async function outside(methodId, a, next = {}, { b = browser(), code = 'c-' + crypto.randomBytes(4).toString('hex'), start = null } = {}) {
  const s = await b.get(start || `/login/start/${methodId}?${a.qs}`);
  assert.equal(s.status, 302, s.text);
  const to = new URL(s.location);
  idp.next = { nonce: to.searchParams.get('nonce'), ...next };
  const r = await b.get(`/login/callback/${methodId}?${new URLSearchParams({ code, state: to.searchParams.get('state') })}`);
  return { ...r, to, b };
}
const accounts = patch => alice.patch('/api/v2/homeserver/accounts', patch);
const oidcMethod = (over = {}) => ({ id: 'corp', kind: 'oidc', name: 'Corp SSO', enabled: true, issuer: idp.url, client_id: 'ember-client', client_secret: 'top-secret-WXYZ', ...over });
const hubMethod = (over = {}) => ({ id: 'hub', kind: 'oauth2', name: 'Hub', enabled: true, client_id: 'hub-client', client_secret: 'hub-secret-1234', authorize_url: idp.url + '/authorize', token_url: idp.url + '/token', userinfo_url: idp.url + '/userinfo', scopes: 'read:user', id_field: 'id', username_field: 'login', email_verified_field: 'verified', ...over });
const PASSWORD = { id: 'password', kind: 'password', name: 'Password', enabled: true };

// ---------------------------------------------------------------- settings
test('config: accounts_mode becomes the accounts block, and is still written (derived)', () => {
  assert.deepEqual(AS.migrate({ accounts_mode: 'local', registration: 'closed' }), { hosts_accounts: true, registration: 'closed', remote_accounts: { mode: 'none', list: [] }, link_verified_emails: false, login_methods: [PASSWORD] });
  assert.deepEqual(AS.migrate({ accounts_mode: 'nookara', nookara_url: 'https://nookara.cc' }), { hosts_accounts: false, registration: 'open', remote_accounts: { mode: 'allowlist', list: ['nookara.cc'] }, link_verified_emails: false, login_methods: [] });

  const read = d => JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'));
  const a = tmpDir(), b = tmpDir();
  try {
    fs.writeFileSync(path.join(a, 'config.json'), JSON.stringify({ name: 'Old local', accounts_mode: 'local', registration: 'closed' }));
    config.init({ dataDir: a });
    assert.equal(config.get().accounts.hosts_accounts, true);
    assert.equal(config.get().accounts.registration, 'closed');
    assert.deepEqual(config.get().accounts.login_methods, [PASSWORD]);
    assert.equal(config.get().accounts_mode, 'local');
    assert.equal(config.get().registration, 'closed');
    assert.deepEqual(read(a).accounts.remote_accounts, { mode: 'none', list: [] }); // written back
    assert.equal(read(a).accounts_mode, 'local');

    fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify({ accounts_mode: 'velora', velora_url: 'https://id.example.org' }));
    config.init({ dataDir: b });
    const acc = config.get().accounts;
    assert.equal(acc.hosts_accounts, false);
    assert.deepEqual(acc.remote_accounts, { mode: 'allowlist', list: ['id.example.org'] });
    assert.deepEqual(acc.login_methods, []);
    assert.equal(config.get().accounts_mode, 'nookara');
    assert.equal(config.mode(), 'nookara');
    assert.equal(read(b).accounts_mode, 'nookara');
    assert.equal(read(b).accounts.hosts_accounts, false);

    // the old setting still switches it (and back), and the invite / approval registration reads as "closed" to old clients
    config.update({ accounts_mode: 'local' });
    assert.equal(config.get().accounts.hosts_accounts, true);
    assert.equal(config.get().accounts.login_methods.some(m => m.kind === 'password' && m.enabled), true);
    config.update({ accounts: { registration: 'invite' } });
    assert.equal(config.get().registration, 'closed');
    config.update({ registration: 'closed' }); // an old admin page sending its form back changes nothing
    assert.equal(config.get().accounts.registration, 'invite');
    config.update({ registration: 'open' });
    assert.equal(config.get().accounts.registration, 'open');
    assert.throws(() => config.update({ accounts: { login_methods: [] } }), { code: 'no_login_method' });
    // a config.json edited by hand to the old key: it wins over the block
    fs.writeFileSync(path.join(b, 'config.json'), JSON.stringify({ ...read(b), accounts_mode: 'nookara' }));
    config.init({ dataDir: b });
    assert.equal(config.get().accounts.hosts_accounts, false);
  } finally { for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('boot: a homeserver with local accounts, claimed by alice', async () => {
  idp = await provider().listen();
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
  base = inst.url; pub = config.publicUrl();
  const r = await api(base).post('/api/v1/auth/register', { username: 'alice', password: PASS });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  alice = api(base, r.body.session);
  assert.equal((await alice.post('/api/v1/instance/claim', { code: inst.setup.current() })).status, 200);
  const s = await accounts({ ember_clients: [APP] });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.deepEqual(s.body.ember_clients, [APP, pub]); // this server's own origin is always one
  assert.equal((await accounts({ ember_clients: ['javascript:alert(1)'] })).body.error, 'invalid_ember_clients');
});

test('discovery: accounts, and the login block with the enabled methods', async () => {
  const r = await fetch(base + '/.well-known/ember', { headers: { Origin: 'https://anywhere.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const d = await r.json();
  assert.equal(d.accounts_mode, 'local');
  assert.equal(typeof d.homeserver, 'object');
  assert.equal(d.homeserver.domain, 'localhost');
  assert.deepEqual(d.accounts, { hosts_accounts: true, registration: 'open', remote_accounts: { mode: 'none' } });
  assert.deepEqual(d.login, { authorize_url: pub + '/login', token_url: pub + '/api/v2/auth/token', revoke_url: pub + '/api/v2/auth/revoke', account_url: pub + '/account', methods: [{ id: 'password', kind: 'password', name: 'Password' }] });
  assert.deepEqual((await api(base).get('/.well-known/bonfire')).body.login, d.login);
});

test('admin: accounts settings, write-only secrets, issuer discovery, url rules', async () => {
  assert.equal((await api(base).get('/api/v2/homeserver/accounts')).status, 401);
  const bob = (await api(base).post('/api/v1/auth/register', { username: 'bob', password: PASS })).body.session;
  assert.equal((await api(base, bob).get('/api/v2/homeserver/accounts')).status, 403);

  let r = await accounts({ login_methods: [PASSWORD, oidcMethod()] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = r.body.login_methods.find(x => x.id === 'corp');
  assert.equal(m.client_secret, '********WXYZ');
  assert.equal(m.callback_url, pub + '/login/callback/corp');
  assert.equal(m.authorize_url, idp.url + '/authorize');
  assert.equal(m.token_url, idp.url + '/token');
  assert.equal(m.userinfo_url, idp.url + '/userinfo');
  assert.equal(JSON.stringify(r.body).includes('top-secret'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).accounts.login_methods[1].client_secret, 'top-secret-WXYZ');

  // sending the masked secret (or none) back keeps the stored one, and the same issuer is not asked again
  const hits = idp.discoveryHits;
  r = await accounts({ login_methods: [PASSWORD, oidcMethod({ client_secret: '********WXYZ', name: 'Corp' })] });
  assert.equal(r.body.login_methods[1].name, 'Corp');
  r = await accounts({ login_methods: [PASSWORD, oidcMethod({ client_secret: undefined })] });
  assert.equal(config.get().accounts.login_methods[1].client_secret, 'top-secret-WXYZ');
  assert.equal(idp.discoveryHits, hits);
  r = await accounts({ login_methods: [PASSWORD, oidcMethod({ client_secret: 'rotated-secret-9999' })] });
  assert.equal(r.body.login_methods[1].client_secret, '********9999');
  await accounts({ login_methods: [PASSWORD, oidcMethod()] });

  // an issuer without a discovery document, or one that names another issuer
  idp.discovery = false;
  r = await accounts({ login_methods: [PASSWORD, oidcMethod({ id: 'other', issuer: idp.url + '/tenant' })] });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_issuer');
  idp.discovery = true;
  r = await accounts({ login_methods: [PASSWORD, oidcMethod({ id: 'other', issuer: idp.url + '/tenant' })] });
  assert.equal(r.body.error, 'invalid_issuer'); // the document says issuer = idp.url
  // switched off, a method may wait for its issuer (the Nookara preset before Nookara has the provider)
  idp.discovery = false;
  r = await accounts({ login_methods: [PASSWORD, oidcMethod(), { id: 'nookara', kind: 'nookara', name: 'Nookara', enabled: false, client_id: 'x' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const nk = r.body.login_methods.find(x => x.kind === 'nookara');
  assert.equal(nk.issuer, 'https://nookara.cc'); assert.equal(nk.scopes, 'openid profile');
  idp.discovery = true;

  // urls: no credentials, https only outside dev, never a private address
  r = await accounts({ login_methods: [PASSWORD, oidcMethod({ issuer: idp.url.replace('http://', 'http://u:p@') })] });
  assert.equal(r.body.error, 'invalid_method_url');
  r = await accounts({ login_methods: [PASSWORD, hubMethod({ token_url: 'ftp://x.example/token' })] });
  assert.equal(r.body.error, 'invalid_method_url'); assert.equal(r.body.field, 'token_url');
  delete process.env.EMBER_DEV;
  try {
    r = await accounts({ login_methods: [PASSWORD, oidcMethod({ id: 'plain', issuer: idp.url })] });
    assert.equal(r.body.error, 'invalid_method_url'); // http
    r = await accounts({ login_methods: [PASSWORD, oidcMethod({ id: 'lan', issuer: 'https://127.0.0.1:9' })] });
    assert.equal(r.body.error, 'invalid_issuer'); assert.equal(r.body.message, 'private_address');
    r = await accounts({ login_methods: [PASSWORD, oidcMethod({ id: 'lan', issuer: 'https://localhost' })] });
    assert.equal(r.body.message, 'private_address');
  } finally { process.env.EMBER_DEV = '1'; }

  for (const bad of [{ registration: 'maybe' }, { remote_accounts: { mode: 'some' } }, { remote_accounts: { list: ['not a host'] } }, { login_methods: [PASSWORD, { ...PASSWORD, id: 'pw2' }] }, { login_methods: [{ id: 'x', kind: 'saml' }] }, { hosts_accounts: 'yes' }])
    assert.equal((await accounts(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await accounts({ login_methods: [] })).body.error, 'no_login_method');
  r = await accounts({ remote_accounts: { mode: 'blocklist', list: ['Bad.Example'] }, registration: 'approval' });
  assert.deepEqual(r.body.remote_accounts, { mode: 'blocklist', list: ['bad.example'] });
  assert.equal((await alice.get('/api/v1/instance/settings')).body.registration, 'closed');
  r = await accounts({ remote_accounts: { mode: 'none', list: [] }, registration: 'open', login_methods: [PASSWORD, oidcMethod(), hubMethod()] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.restart_required, false);
  assert.deepEqual((await api(base).get('/.well-known/ember')).body.login.methods.map(x => x.id), ['password', 'corp', 'hub']);
});

// ---------------------------------------------------------------- the authorize endpoint
test('/login: the page, redirect_uri rules, errors back to the client', async () => {
  const a = authz();
  const pg = await browser().get('/login?' + a.qs);
  assert.equal(pg.status, 200);
  assert.match(pg.headers.get('content-type'), /text\/html/);
  assert.equal(pg.headers.get('cross-origin-opener-policy'), null); // the pop-up keeps window.opener
  assert.equal(pg.headers.get('access-control-allow-origin'), null);
  assert.match(pg.headers.get('content-security-policy'), /form-action 'self' https:\/\/app\.example/);
  assert.match(pg.headers.get('set-cookie'), /^ember_csrf=[\w-]{43}; Path=\/login; HttpOnly; SameSite=Lax/);
  assert.match(pg.text, /name="password"/);
  assert.match(pg.text, /Continue with Corp SSO/);
  assert.match(pg.text, /Create account/);
  assert.doesNotMatch(pg.text, /<script/i);
  // everything from the request is escaped
  const x = authz({ state: '"><script>alert(1)</script>', login_hint: '<b>"x"' });
  const xp = await browser().get('/login?' + x.qs);
  assert.doesNotMatch(xp.text, /<script>alert|<b>"x"/);
  assert.match(xp.text, /&lt;b&gt;&quot;x&quot;/);

  // redirect_uri: an allowed origin, and a path ending in /auth/callback.html or the #/auth/callback fragment route
  const ok = [`${APP}/auth/callback.html`, `${APP}/ember/auth/callback.html`, `${APP}/#/auth/callback`, `${APP}/ember/index.html#/auth/callback`, `${pub}/auth/callback.html`];
  const bad = ['https://evil.example/auth/callback.html', `${APP}/auth/other.html`, `${APP}/`, `${APP}/#/elsewhere`, `${APP}/auth/callback.html#x`, 'http://app.example/auth/callback.html', `https://u:p@app.example/auth/callback.html`, `${APP}.evil.example/auth/callback.html`, 'javascript:alert(1)//auth/callback.html', ''];
  for (const u of ok) assert.equal((await browser().get('/login?' + authz({ redirect_uri: u }).qs)).status, 200, u);
  for (const u of bad) {
    const r = await browser().get('/login?' + authz({ redirect_uri: u }).qs);
    assert.equal(r.status, 400, u); assert.equal(r.location, null); // never redirected to
  }
  assert.equal((await browser().get('/login?' + authz({ client_id: 'other' }).qs)).status, 400);

  // with a good redirect_uri, what is wrong with the request goes back to the client, with its state
  for (const [over, error] of [[{ response_type: 'token' }, 'unsupported_response_type'], [{ code_challenge_method: 'plain' }, 'invalid_request'], [{ code_challenge: 'short' }, 'invalid_request'], [{ code_challenge: undefined }, 'invalid_request']]) {
    const q = authz(over); if (over.code_challenge === undefined && 'code_challenge' in over) delete q.q.code_challenge;
    const r = await browser().get('/login?' + new URLSearchParams(q.q));
    assert.equal(r.status, 302, JSON.stringify(over));
    assert.equal(new URL(r.location).origin, APP);
    assert.deepEqual([answer(r.location).error, answer(r.location).state], [error, q.q.state]);
  }
  // state: echoed exactly; an absurd one is refused
  const long = await browser().get('/login?' + authz({ state: 'x'.repeat(600) }).qs);
  assert.equal(answer(long.location).error, 'invalid_request'); assert.equal(answer(long.location).state, undefined);
  // Cancel
  const c = await browser().get('/login/cancel?' + a.qs);
  assert.deepEqual([answer(c.location).error, answer(c.location).state], ['access_denied', a.q.state]);
  // the fragment route gets its answer inside the fragment
  const f = authz({ redirect_uri: `${APP}/ember/#/auth/callback` });
  const fr = await passwordLogin(f, 'alice');
  assert.match(fr.location, /^https:\/\/app\.example\/ember\/#\/auth\/callback\?code=[\w-]{43}&state=st-/);
  assert.equal((await redeem(f, answer(fr.location).code)).status, 200);
});

test('/login: CSRF token required, wrong password, registration', async () => {
  const a = authz();
  const b = browser();
  const pg = await b.get('/login?' + a.qs);
  const csrf = b.field(pg.text, 'csrf');
  assert.equal(csrf, b.jar.ember_csrf);
  const form = { ...a.q, action: 'login', username: 'alice', password: PASS };
  assert.equal((await b.post('/login', form)).status, 403); // no field
  assert.equal((await b.post('/login', { ...form, csrf: 'x'.repeat(43) })).status, 403); // not the cookie's
  assert.equal((await browser().post('/login', { ...form, csrf })).status, 403); // no cookie
  const wrong = await b.post('/login', { ...form, csrf, password: 'nope nope nope' });
  assert.equal(wrong.status, 401); assert.match(wrong.text, /Wrong username or password/);
  const good = await b.post('/login', { ...form, csrf });
  assert.equal(good.status, 302);
  assert.equal(answer(good.location).state, a.q.state);
  // a tampered redirect_uri in the form is checked again
  assert.equal((await b.post('/login', { ...form, csrf, redirect_uri: 'https://evil.example/auth/callback.html' })).status, 400);

  const reg = authz();
  const mismatch = await browser().get('/login?' + reg.qs + '&view=register');
  assert.match(mismatch.text, /Password again/);
  const rb = browser(); const rp = await rb.get('/login?' + reg.qs);
  const rf = { ...reg.q, csrf: rb.field(rp.text, 'csrf'), action: 'register', username: 'carol', password: PASS };
  assert.match((await rb.post('/login', { ...rf, password2: 'something else' })).text, /not the same/);
  assert.match((await rb.post('/login', { ...rf, username: 'alice', password2: PASS })).text, /taken/);
  const made = await rb.post('/login', { ...rf, password2: PASS });
  assert.equal(made.status, 302);
  assert.equal((await redeem(reg, answer(made.location).code)).body.account.username, 'carol');
  await accounts({ registration: 'closed' });
  const shut = await rb.post('/login', { ...rf, username: 'dave', password2: PASS });
  assert.equal(shut.status, 403); assert.doesNotMatch((await browser().get('/login?' + reg.qs)).text, /Create account/);
  await accounts({ registration: 'open' });
});

// ---------------------------------------------------------------- the token endpoint
test('password login -> code -> tokens -> API and gateway -> refresh (rotation, reuse revokes the family)', async () => {
  const a = authz();
  const r = await passwordLogin(a, 'alice');
  assert.equal(r.status, 302, r.text);
  const back = answer(r.location);
  assert.equal(back.state, a.q.state);
  const t = await redeem(a, back.code);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.deepEqual(Object.keys(t.body).sort(), ['access_token', 'account', 'expires_in', 'refresh_token', 'token_type']);
  assert.equal(t.body.token_type, 'Bearer'); assert.equal(t.body.expires_in, 3600);
  assert.deepEqual(t.body.account, { id: 'l:1', username: 'alice', domain: config.domain(), handle: `alice@${config.domain()}`, display_name: 'alice', avatar_url: null });

  // the access token is a session: the v1 routes and the gateway take it
  const me = await api(base, t.body.access_token).get('/api/v1/me');
  assert.equal(me.status, 200); assert.equal(me.body.user.username, 'alice'); assert.equal(me.body.instance_owner, true);
  assert.equal((await api(base, t.body.access_token).get('/api/v1/instance/settings')).status, 200);
  const { wsClient } = require('./helpers');
  const ws = wsClient(base); await ws.open(); ws.send({ type: 'auth', session: t.body.access_token });
  assert.equal((await ws.waitFor(f => f.type === 'auth_success')).user.username, 'alice'); ws.close();

  // refresh: a new pair, the old refresh token is spent
  const ref = body => tokenCall({ grant_type: 'refresh_token', client_id: 'ember', ...body });
  const t2 = await ref({ refresh_token: t.body.refresh_token });
  assert.equal(t2.status, 200, JSON.stringify(t2.body));
  assert.notEqual(t2.body.refresh_token, t.body.refresh_token); assert.notEqual(t2.body.access_token, t.body.access_token);
  assert.equal((await api(base, t2.body.access_token).get('/api/v1/me')).status, 200);
  // two tabs at once: inside the grace the second gets the same new tokens
  const twin = await ref({ refresh_token: t.body.refresh_token });
  assert.equal(twin.status, 200); assert.equal(twin.body.refresh_token, t2.body.refresh_token);
  const t3 = await ref({ refresh_token: t2.body.refresh_token });
  assert.equal(t3.status, 200);
  // after it, an old refresh token used again ends the whole family
  O._test.ageRefresh(31000);
  const reuse = await ref({ refresh_token: t2.body.refresh_token });
  assert.equal(reuse.status, 400); assert.equal(reuse.body.error, 'invalid_grant'); assert.equal(typeof reuse.body.error_description, 'string');
  assert.equal((await ref({ refresh_token: t3.body.refresh_token })).body.error, 'invalid_grant');
  for (const tok of [t.body.access_token, t2.body.access_token, t3.body.access_token]) assert.equal((await api(base, tok).get('/api/v1/me')).status, 401);

  // an access token ends after an hour
  const s = await signIn('alice');
  require('../src/db').run('UPDATE sessions SET expires_at = ? WHERE family IS NOT NULL', Date.now() - 1);
  assert.equal((await api(base, s.access_token).get('/api/v1/me')).status, 401);
  assert.equal((await ref({ refresh_token: s.refresh_token })).status, 200);

  assert.equal((await ref({ refresh_token: 'nope' })).body.error, 'invalid_grant');
  assert.equal((await ref({})).body.error, 'invalid_request');
  assert.equal((await tokenCall({ grant_type: 'password', client_id: 'ember' })).body.error, 'unsupported_grant_type');
  assert.equal((await tokenCall({ grant_type: 'refresh_token', client_id: 'someone', refresh_token: s.refresh_token })).body.error, 'invalid_client');
  // a form post works too
  const fa = authz(); const fc = answer((await passwordLogin(fa, 'alice')).location).code;
  const fr = await fetch(base + '/api/v2/auth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'ember', code: fc, code_verifier: fa.verifier, redirect_uri: fa.q.redirect_uri }) });
  assert.equal(fr.status, 200);
});

test('codes: PKCE mismatch, wrong redirect_uri, expired, replayed', async () => {
  const code = async a => answer((await passwordLogin(a, 'alice')).location).code;
  let a = authz();
  let r = await redeem(a, await code(a), { code_verifier: pkce().verifier });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_grant'); assert.match(r.body.error_description, /code_verifier/);
  a = authz(); const spent = await code(a);
  assert.equal((await redeem(a, spent, { code_verifier: 'short' })).body.error, 'invalid_grant');
  assert.equal((await redeem(a, spent)).body.error, 'invalid_grant'); // one try per code, even with the right verifier afterwards

  a = authz();
  r = await redeem(a, await code(a), { redirect_uri: `${APP}/auth/callback.html` });
  assert.equal(r.body.error, 'invalid_grant'); assert.match(r.body.error_description, /redirect_uri/);
  a = authz();
  assert.equal((await redeem(a, await code(a), { client_id: 'other' })).body.error, 'invalid_client');

  a = authz(); const old = await code(a);
  O._test.expireCodes();
  assert.equal((await redeem(a, old)).body.error, 'invalid_grant');

  a = authz(); const once = await code(a);
  const first = await redeem(a, once);
  assert.equal(first.status, 200);
  assert.equal((await redeem(a, once)).body.error, 'invalid_grant');
  assert.equal((await api(base, first.body.access_token).get('/api/v1/me')).status, 401); // what the replayed code issued is gone too
  assert.equal((await redeem(a, 'never-issued')).body.error, 'invalid_grant');
  assert.equal((await redeem(a, undefined)).body.error, 'invalid_request');
});

test('token endpoint CORS: the ember_clients origins only, preflight included; revoke and sign-out end the family', async () => {
  const pre = o => fetch(base + '/api/v2/auth/token', { method: 'OPTIONS', headers: { Origin: o, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  let r = await pre(APP);
  assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), APP);
  assert.match(r.headers.get('access-control-allow-headers'), /Content-Type/i); assert.match(r.headers.get('vary'), /Origin/);
  assert.equal((await pre('https://evil.example')).headers.get('access-control-allow-origin'), null);
  r = await tokenCall({ grant_type: 'refresh_token', client_id: 'ember', refresh_token: 'x' }, { Origin: APP });
  assert.equal(r.headers.get('access-control-allow-origin'), APP);
  r = await tokenCall({ grant_type: 'refresh_token', client_id: 'ember', refresh_token: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  r = await api(base).raw('POST', '/api/v2/auth/revoke', { token: 'x' }, { Origin: APP });
  assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), APP);
  // every other API route stays open to any origin, Authorization allowed
  r = await fetch(base + '/api/v1/me', { method: 'OPTIONS', headers: { Origin: 'https://anywhere.example' } });
  assert.equal(r.headers.get('access-control-allow-origin'), '*'); assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);

  const ref = tok => tokenCall({ grant_type: 'refresh_token', client_id: 'ember', refresh_token: tok });
  let s = await signIn('alice');
  await api(base).post('/api/v2/auth/revoke', { token: s.refresh_token });
  assert.equal((await api(base, s.access_token).get('/api/v1/me')).status, 401);
  assert.equal((await ref(s.refresh_token)).body.error, 'invalid_grant');
  s = await signIn('alice');
  await api(base).post('/api/v2/auth/revoke', { token: s.access_token });
  assert.equal((await ref(s.refresh_token)).body.error, 'invalid_grant');
  s = await signIn('alice');
  assert.equal((await api(base, s.access_token).post('/api/v1/auth/logout')).status, 200);
  assert.equal((await ref(s.refresh_token)).body.error, 'invalid_grant');
  // an old-style session is not touched by any of it
  assert.equal((await alice.get('/api/v1/me')).status, 200);
});

// ---------------------------------------------------------------- outside logins
test('OpenID Connect: a new account when registration is open, the same account next time', async () => {
  const a = authz();
  const r = await outside('corp', a, { claims: { sub: 'u-100', preferred_username: 'Alice', name: 'Alice From Corp', email: 'alice@corp.example', email_verified: true } });
  assert.equal(r.status, 302, r.text);
  // what went to the provider: state, nonce, PKCE, our callback
  assert.equal(r.to.origin + r.to.pathname, idp.url + '/authorize');
  assert.equal(r.to.searchParams.get('redirect_uri'), pub + '/login/callback/corp');
  assert.equal(r.to.searchParams.get('client_id'), 'ember-client');
  assert.equal(r.to.searchParams.get('code_challenge_method'), 'S256');
  assert.match(r.to.searchParams.get('scope'), /openid/);
  const call = idp.tokenCalls.at(-1);
  assert.equal(crypto.createHash('sha256').update(call.form.code_verifier).digest('base64url'), r.to.searchParams.get('code_challenge'));
  assert.equal(call.authorization, 'Basic ' + Buffer.from('ember-client:top-secret-WXYZ').toString('base64'));
  assert.equal(call.form.client_secret, undefined);

  assert.equal(answer(r.location).state, a.q.state);
  const t = await redeem(a, answer(r.location).code);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.account.username, 'alice2'); // "alice" is taken here: made unique
  assert.equal(t.body.account.display_name, 'Alice From Corp');
  const mine = await api(base, t.body.access_token).get('/api/v2/account/logins');
  assert.deepEqual(mine.body.logins.map(l => [l.id, l.linked]), [['password', false], ['corp', true], ['hub', false]]);
  assert.equal(mine.body.logins[1].email, 'alice@corp.example');

  const again = authz();
  const r2 = await outside('corp', again, { claims: { sub: 'u-100', preferred_username: 'renamed' } });
  assert.equal((await redeem(again, answer(r2.location).code)).body.account.id, t.body.account.id);
});

test('OpenID Connect: the id_token is checked (signature, issuer, audience, nonce, expiry), and so is state', async () => {
  const users = () => require('../src/db').get("SELECT COUNT(*) AS n FROM users WHERE kind = 'local'").n;
  const before = users();
  const t = Math.floor(Date.now() / 1000);
  const cases = {
    signature: { key: idp.other, claims: { sub: 'bad-1' } },
    issuer: { claims: { sub: 'bad-2', iss: 'https://someone.else' } },
    audience: { claims: { sub: 'bad-3', aud: 'another-client' } },
    nonce: { claims: { sub: 'bad-4', nonce: 'not-ours' } },
    expired: { claims: { sub: 'bad-5', exp: t - 3600, iat: t - 7200 } },
    'alg none': { raw: `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: idp.url, aud: 'ember-client', sub: 'bad-6', exp: t + 300 })}.` },
    'shared secret alg': { head: { alg: 'HS256', typ: 'JWT', kid: 'k1' }, claims: { sub: 'bad-7' } },
  };
  for (const [name, next] of Object.entries(cases)) {
    const override = next.claims?.nonce ? next : null;
    const a = authz();
    const b = browser();
    const s = await b.get(`/login/start/corp?${a.qs}`);
    const to = new URL(s.location);
    idp.next = { nonce: to.searchParams.get('nonce'), ...next, claims: { ...(next.claims || {}), ...(override ? { nonce: 'not-ours' } : {}) } };
    const r = await b.get(`/login/callback/corp?${new URLSearchParams({ code: 'c', state: to.searchParams.get('state') })}`);
    assert.equal(r.status, 400, name); assert.equal(r.location, null, name);
    assert.match(r.text, /did not work/, name);
  }
  assert.equal(users(), before); // nobody got an account out of any of it

  // state: unknown, used twice, or another method's
  const a = authz();
  assert.equal((await browser().get('/login/callback/corp?code=c&state=made-up')).status, 400);
  const ok = await outside('corp', a, { claims: { sub: 'u-100' } });
  assert.equal(ok.status, 302);
  const st = ok.to.searchParams.get('state');
  assert.equal((await ok.b.get(`/login/callback/corp?code=c2&state=${st}`)).status, 400);
  const s2 = new URL((await browser().get(`/login/start/corp?${a.qs}`)).location).searchParams.get('state');
  assert.equal((await browser().get(`/login/callback/hub?code=c&state=${s2}`)).status, 400);
  // the provider said no
  const s3 = new URL((await browser().get(`/login/start/corp?${a.qs}`)).location).searchParams.get('state');
  const denied = await browser().get(`/login/callback/corp?error=access_denied&state=${s3}`);
  assert.equal(denied.status, 400); assert.match(denied.text, /cancelled/); assert.match(denied.text, /name="password"/);
  // start needs a valid authorization request too
  assert.equal((await browser().get('/login/start/corp?' + authz({ redirect_uri: 'https://evil.example/auth/callback.html' }).qs)).status, 400);
  assert.equal((await browser().get('/login/start/nope?' + a.qs)).status, 400);
});

test('registration closed: an unknown login is refused, and can be linked by signing in with a password', async () => {
  await accounts({ registration: 'closed' });
  const a = authz();
  const r = await outside('corp', a, { claims: { sub: 'u-200', preferred_username: 'bobby', email: 'bob@corp.example', email_verified: true } });
  assert.equal(r.status, 403);
  assert.match(r.text, /No account here is linked to this login/);
  assert.equal(require('../src/db').get("SELECT 1 FROM users WHERE username_lc = 'bobby'"), undefined);
  const href = /href="(\/login\?[^"]*link=[^"]*)"/.exec(r.text)[1].replace(/&amp;/g, '&');
  const link = new URL(href, base).searchParams.get('link');
  const pg = await r.b.get(href);
  assert.match(pg.text, /Link your account/);
  const done = await r.b.post('/login', { ...a.q, csrf: r.b.field(pg.text, 'csrf'), action: 'login', username: 'bob', password: PASS, link });
  assert.equal(done.status, 302);
  assert.equal((await redeem(a, answer(done.location).code)).body.account.username, 'bob');
  // from now on that login is bob
  const b = authz();
  const r2 = await outside('corp', b, { claims: { sub: 'u-200' } });
  assert.equal((await redeem(b, answer(r2.location).code)).body.account.username, 'bob');
  await accounts({ registration: 'open' });
});

test('emails never link accounts by default; verified ones do once the admin allows it', async () => {
  const count = () => require('../src/db').get("SELECT COUNT(*) AS n FROM users WHERE kind = 'local'").n;
  const id = async r => { assert.equal(r.status, 302, r.text); return r; };
  // the hub login carries alice2's verified corp address: still a new account
  idp.userinfo = { id: 501, login: 'someone', email: 'alice@corp.example', verified: true };
  let a = authz(), n = count();
  let t = await redeem(a, answer((await id(await outside('hub', a))).location).code);
  assert.equal(t.body.account.username, 'someone'); assert.equal(count(), n + 1);

  let r = await accounts({ link_verified_emails: true });
  assert.equal(r.body.link_verified_emails, true);
  // an address the provider does not vouch for links nothing
  idp.userinfo = { id: 502, login: 'sneaky', email: 'bob@corp.example', verified: false };
  a = authz(); n = count();
  t = await redeem(a, answer((await id(await outside('hub', a))).location).code);
  assert.equal(t.body.account.username, 'sneaky'); assert.equal(count(), n + 1);
  // verified, and exactly one account has a login with that verified address: linked to it
  idp.userinfo = { id: 503, login: 'bob-on-hub', email: 'bob@corp.example', verified: true };
  a = authz(); n = count();
  t = await redeem(a, answer((await id(await outside('hub', a))).location).code);
  assert.equal(t.body.account.username, 'bob'); assert.equal(count(), n);
  await accounts({ link_verified_emails: false });
});

test('OAuth 2.0 with a userinfo address: id_field / username_field, the secret in the form', async () => {
  idp.userinfo = { id: 777, login: 'Octo Cat!', name: 'Octo', email: 'octo@hub.example' };
  const a = authz();
  const r = await outside('hub', a);
  assert.equal(r.status, 302, r.text);
  assert.equal(r.to.searchParams.get('nonce'), null);
  assert.equal(r.to.searchParams.get('scope'), 'read:user');
  const call = idp.tokenCalls.at(-1);
  assert.equal(call.form.client_id, 'hub-client'); assert.equal(call.form.client_secret, 'hub-secret-1234'); assert.equal(call.authorization, null);
  const t = await redeem(a, answer(r.location).code);
  assert.equal(t.body.account.username, 'octocat'); assert.equal(t.body.account.display_name, 'Octo');
  assert.deepEqual({ ...require('../src/db').get("SELECT method_id, subject, email, email_verified FROM login_links WHERE subject = '777'") }, { method_id: 'hub', subject: '777', email: 'octo@hub.example', email_verified: 0 });
  // a userinfo answer without the id field is no login
  idp.userinfo = { login: 'nobody' };
  assert.equal((await outside('hub', authz())).status, 400);
});

test('linking and unlinking from a signed-in account; the last way in cannot be removed', async () => {
  const bob = await signIn('bob');
  const B = api(base, bob.access_token);
  assert.deepEqual((await B.get('/api/v2/account/logins')).body.logins.map(l => [l.id, l.linked]), [['password', true], ['corp', true], ['hub', true]]);
  assert.equal((await B.del('/api/v2/account/logins/hub')).status, 200);
  assert.equal((await B.del('/api/v2/account/logins/hub')).body.error, 'not_linked');
  assert.equal((await B.del('/api/v2/account/logins/password')).body.error, 'cannot_remove_password');

  // link it again: POST gives the address to open in a browser
  assert.equal((await api(base).post('/login/link/hub')).status, 401);
  assert.equal((await B.post('/login/link/password')).status, 404);
  assert.equal((await B.post('/login/link/hub', { return_to: 'https://evil.example/' })).body.error, 'invalid_return_to');
  let l = await B.post('/login/link/hub', { return_to: `${APP}/ember/#/settings` });
  assert.match(l.body.url, new RegExp(`^${pub}/login/start/hub\\?link=`));
  idp.userinfo = { id: 900, login: 'bob-two' };
  let r = await outside('hub', null, {}, { start: l.body.url.replace(pub, '') });
  assert.equal(r.location, `${APP}/ember/?linked=hub#/settings`);
  assert.equal((await browser().get(l.body.url.replace(pub, ''))).status, 400); // the address works once
  // a login that is someone else's cannot be taken
  l = await B.post('/login/link/hub');
  idp.userinfo = { id: 777, login: 'octocat' };
  r = await outside('hub', null, {}, { start: l.body.url.replace(pub, '') });
  assert.equal(r.status, 400); assert.match(r.text, /already linked to another account/);

  // alice2 only has the corp login: it stays
  const a = authz();
  const t = await redeem(a, answer((await outside('corp', a, { claims: { sub: 'u-100' } })).location).code);
  const A2 = api(base, t.body.access_token);
  let d = await A2.del('/api/v2/account/logins/corp');
  assert.equal(d.status, 409); assert.equal(d.body.error, 'last_login_method');
  // with a second login it can go, and then the second one is the last
  l = await A2.post('/login/link/hub');
  idp.userinfo = { id: 901, login: 'alice-hub' };
  r = await outside('hub', null, {}, { start: l.body.url.replace(pub, '') });
  assert.equal(r.status, 200); assert.match(r.text, /Login linked/);
  assert.equal((await A2.del('/api/v2/account/logins/corp')).status, 200);
  assert.equal((await A2.del('/api/v2/account/logins/hub')).body.error, 'last_login_method');
  // bob has a password: both of his logins may go... unless password sign-in is switched off
  await accounts({ login_methods: [{ ...PASSWORD, enabled: false }, oidcMethod({ client_secret: undefined }), hubMethod({ client_secret: undefined })] });
  assert.equal((await B.del('/api/v2/account/logins/hub')).status, 200);
  assert.equal((await B.del('/api/v2/account/logins/corp')).body.error, 'last_login_method');
  assert.equal((await api(base).post('/api/v1/auth/login', { username: 'bob', password: PASS })).body.error, 'password_login_disabled');
  assert.doesNotMatch((await browser().get('/login?' + authz().qs)).text, /name="password"/);
  await accounts({ login_methods: [PASSWORD, oidcMethod({ client_secret: undefined }), hubMethod({ client_secret: undefined })] });
  assert.equal(config.get().accounts.login_methods[2].client_secret, 'hub-secret-1234');
  assert.equal((await B.del('/api/v2/account/logins/corp')).status, 200);
});

test('the link route answers the ember_clients origins (preflight too), /login itself no origin; public_url; a secret can be cleared', async () => {
  const pre = (p, o) => fetch(base + p, { method: 'OPTIONS', headers: { Origin: o, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' } });
  const ok = await pre('/login/link/hub', APP);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), APP);
  assert.match(ok.headers.get('access-control-allow-headers'), /Authorization, Content-Type/);
  assert.equal((await pre('/login/link/hub', 'https://evil.example')).headers.get('access-control-allow-origin'), null);
  assert.equal((await pre('/login', APP)).headers.get('access-control-allow-origin'), null);
  assert.equal((await pre('/login/start/hub', APP)).headers.get('access-control-allow-origin'), null);
  const view = (await alice.get('/api/v2/homeserver/accounts')).body;
  assert.equal(view.public_url, config.get().public_url);
  const r = await accounts({ login_methods: [PASSWORD, oidcMethod({ client_secret: undefined }), hubMethod({ client_secret: null })] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.login_methods[1].client_secret.slice(0, 8), '********'); // left out: kept
  assert.equal(r.body.login_methods[2].client_secret, null);
  assert.equal(config.get().accounts.login_methods[2].client_secret, undefined);
  await accounts({ login_methods: [PASSWORD, oidcMethod({ client_secret: undefined }), hubMethod()] });
});

test('a homeserver that hosts no accounts: no login block, no /login', async () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ accounts_mode: 'nookara' }));
  await inst.close(); inst = null;
  const other = await startServer({ dataDir: d, port: 0, host: '127.0.0.1' });
  try {
    base = other.url;
    const doc = (await api(base).get('/.well-known/ember')).body;
    assert.equal(doc.login, undefined);
    assert.equal(doc.accounts_mode, 'velora');
    assert.deepEqual(doc.accounts, { hosts_accounts: false, registration: 'closed', remote_accounts: { mode: 'allowlist' } });
    const a = authz({ redirect_uri: 'https://nookara.cc/ember/auth/callback.html' });
    assert.equal((await browser().get('/login?' + a.qs)).status, 404);
  } finally { await other.close(); fs.rmSync(d, { recursive: true, force: true }); }
});
