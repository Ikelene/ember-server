'use strict';
// The account page (GET /account, PROTOCOL §4a): signs in through the homeserver's own /login, keeps its session in a cookie
// only /account ever sees, and changes things with form posts that carry a CSRF token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const dir = tmpDir();
const PW = 'correct horse battery';
let inst, base, bob, jar;

// a browser, as far as this page needs one: cookies per path, no redirects followed
function browser() {
  const cookies = new Map(); // name -> { value, path }
  const header = path => [...cookies].filter(([, c]) => path === c.path || path.startsWith(c.path + '/') || path.startsWith(c.path + '?')).map(([k, c]) => `${k}=${c.value}`).join('; ');
  const call = async (method, url, body, headers = {}) => {
    const u = new URL(url, base);
    const r = await fetch(u, { method, redirect: 'manual', headers: { ...(header(u.pathname) ? { Cookie: header(u.pathname) } : {}), ...headers }, body });
    for (const line of r.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map(x => x.trim()), i = pair.indexOf('=');
      const path = attrs.find(a => /^path=/i.test(a))?.slice(5) || '/', gone = attrs.some(a => /^max-age=0$/i.test(a));
      if (gone) cookies.delete(pair.slice(0, i)); else cookies.set(pair.slice(0, i), { value: pair.slice(i + 1), path, attrs });
    }
    return { status: r.status, location: r.headers.get('location'), headers: r.headers, text: await r.text() };
  };
  return {
    cookies,
    get: url => call('GET', url),
    form: (url, fields) => call('POST', url, new URLSearchParams(fields).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' }),
    upload: (url, fields, file) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); if (file) f.append('file', new Blob([file.data], { type: file.type }), file.name); return call('POST', url, f); },
  };
}
const hiddenFields = html => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1], m[2].replace(/&amp;/g, '&')]));
const csrfOf = html => /name="csrf" value="([^"]+)"/.exec(html)[1];
// GET /account -> /login -> the password form -> back to /account with a session cookie
async function signIn(b, username) {
  const start = await b.get('/account');
  assert.equal(start.status, 302);
  assert.match(start.location, /^\/login\?response_type=code&client_id=ember&redirect_uri=/);
  const login = await b.get(start.location);
  assert.equal(login.status, 200);
  const done = await b.form('/login', { ...hiddenFields(login.text), username, password: PW });
  assert.equal(done.status, 302, done.text.slice(0, 300));
  assert.ok(done.location.startsWith(`${new URL(base).origin.replace('127.0.0.1', 'localhost')}/account/auth/callback.html?code=`), done.location);
  const cb = await b.get(done.location);
  assert.deepEqual([cb.status, cb.location], [302, '/account']);
  return cb;
}

test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0 });
  base = `http://localhost:${inst.port}`;
  const r = await api(base).post('/api/v1/auth/register', { username: 'bob', password: PW });
  bob = { ...r.body, a: api(base, r.body.session) };
  await bob.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
});
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('the page sends someone who is not signed in to /login and comes back with a session only /account sees', async () => {
  jar = browser();
  const cb = await signIn(jar, 'bob');
  const c = jar.cookies.get('ember_account');
  assert.equal(c.path, '/account');
  assert.ok(c.attrs.some(a => /^httponly$/i.test(a)) && c.attrs.some(a => /^samesite=lax$/i.test(a)));
  assert.ok(!jar.cookies.has('ember_account_login')); // used up
  assert.ok(cb.headers.getSetCookie().every(l => /Path=\/account/.test(l)));
  // the cookie is not sent anywhere else on the homeserver
  const elsewhere = await jar.get('/api/v1/servers');
  assert.equal(elsewhere.status, 401);
  const wk = (await api(base).get('/.well-known/ember')).body;
  assert.equal(wk.login.account_url, wk.public_url + '/account');
});

test('it shows the account: handle, profile, sign-in methods, sessions, DM privacy; plain html, no scripts', async () => {
  const r = await jar.get('/account');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(!/<script/i.test(r.text));
  assert.ok(r.text.includes('bob@localhost'));
  for (const h of ['Profile', 'DM privacy', 'Sign-in methods', 'Active sessions']) assert.ok(r.text.includes(`>${h}</h2>`), h);
  assert.ok(r.text.includes('This account has a password'));
  assert.ok(r.text.includes('<option value="friends" selected>'));
  assert.ok(r.text.includes('This page') && r.text.includes('A signed-in client')); // this page, and the session the test registered with
  assert.ok(r.text.includes('Sign out everywhere'));
  for (const l of r.text.matchAll(/<(?:input|textarea|select) id="([^"]+)"/g)) assert.ok(r.text.includes(`<label for="${l[1]}">`), `label for ${l[1]}`);
});

test('forms need the CSRF token of the session', async () => {
  let r = await jar.form('/account/profile', { display_name: 'Mallory' });
  assert.equal(r.status, 403);
  assert.ok(r.text.includes('role="alert"'));
  r = await jar.form('/account/profile', { csrf: 'x'.repeat(43), display_name: 'Mallory' });
  assert.equal(r.status, 403);
  r = await jar.form('/account/signout-all', {});
  assert.equal(r.status, 403);
  assert.equal((await bob.a.get('/api/v1/me/profile')).body.profile.display_name, null);
  // another browser's token is no good either
  const other = browser();
  await signIn(other, 'bob');
  const theirs = csrfOf((await other.get('/account')).text);
  assert.equal((await jar.form('/account/profile', { csrf: theirs, display_name: 'Mallory' })).status, 403);
  // without a session a post changes nothing and goes back to signing in
  r = await browser().form('/account/profile', { csrf: theirs, display_name: 'Mallory' });
  assert.deepEqual([r.status, r.location], [302, '/account']);
  assert.equal((await bob.a.get('/api/v1/me/profile')).body.profile.display_name, null);
});

test('profile, picture and DM privacy are edited from the page', async () => {
  const csrf = csrfOf((await jar.get('/account')).text);
  let r = await jar.form('/account/profile', { csrf, display_name: 'Bob <b>', bio: 'likes "tea" & <i>cake</i>', pronouns: 'he/him' });
  assert.deepEqual([r.status, r.location], [302, '/account?ok=profile']);
  const p = (await bob.a.get('/api/v1/me/profile')).body.profile;
  assert.deepEqual([p.display_name, p.bio, p.pronouns], ['Bob <b>', 'likes "tea" & <i>cake</i>', 'he/him']);
  r = await jar.get(r.location);
  assert.ok(r.text.includes('Profile saved.'));
  assert.ok(r.text.includes('value="Bob &lt;b&gt;"') && r.text.includes('likes &quot;tea&quot; &amp; &lt;i&gt;cake&lt;/i&gt;')); // escaped
  assert.ok(!r.text.includes('<i>cake'));
  r = await jar.form('/account/profile', { csrf, display_name: 'x'.repeat(40) });
  assert.equal(r.location, '/account?error=display_name_too_long');
  assert.ok((await jar.get(r.location)).text.includes('too long'));
  // picture
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  r = await jar.upload('/account/avatar', { csrf }, { data: png, type: 'image/png', name: 'me.png' });
  assert.deepEqual([r.status, r.location], [302, '/account?ok=avatar']);
  const pfp = (await bob.a.get('/api/v1/me/profile')).body.profile.pfp;
  assert.match(pfp, /\/uploads\/chat\/profile_pfp_/);
  assert.ok((await jar.get('/account')).text.includes(`<img src="${pfp}"`));
  assert.equal((await jar.upload('/account/avatar', {}, { data: png, type: 'image/png', name: 'me.png' })).status, 403); // no token
  r = await jar.upload('/account/avatar', { csrf }, { data: Buffer.from('not a picture'), type: 'image/png', name: 'me.png' });
  assert.equal(r.location, '/account?error=images_only');
  r = await jar.form('/account/avatar/remove', { csrf });
  assert.equal(r.location, '/account?ok=avatar_removed');
  assert.equal((await bob.a.get('/api/v1/me/profile')).body.profile.pfp, null);
  // DM privacy
  r = await jar.form('/account/dm-privacy', { csrf, dm_from: 'nobody' });
  assert.equal(r.location, '/account?ok=dm');
  assert.equal((await bob.a.get('/api/v1/settings')).body.settings.dm_from, 'nobody');
  assert.ok((await jar.get('/account')).text.includes('<option value="nobody" selected>'));
  assert.equal((await jar.form('/account/dm-privacy', { csrf, dm_from: 'aliens' })).location, '/account?error=invalid_dm_from');
});

test('sessions: one can be signed out from the page, or all of them', async () => {
  let html = (await jar.get('/account')).text;
  const csrf = csrfOf(html);
  const keys = [...html.matchAll(/name="key" value="([^"]+)"/g)].map(m => m[1]);
  assert.equal(keys.length, 2); // the registered session and the other browser of the last test
  const legacy = keys.find(k => k.startsWith('s:'));
  assert.equal((await bob.a.get('/api/v1/servers')).status, 200);
  let r = await jar.form('/account/sessions/end', { csrf, key: legacy });
  assert.equal(r.location, '/account?ok=session');
  assert.equal((await bob.a.get('/api/v1/servers')).status, 401);
  assert.equal((await jar.form('/account/sessions/end', { csrf, key: legacy })).location, '/account?error=session_not_found');
  assert.equal((await jar.form('/account/sessions/end', { csrf, key: 'f:zz' })).location, '/account?error=session_not_found');
  // a fresh sign-in elsewhere, then everything goes
  const again = await api(base).post('/api/v1/auth/login', { username: 'bob', password: PW });
  assert.equal(again.status, 200);
  r = await jar.form('/account/signout-all', { csrf });
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('Every session of your account was signed out'));
  assert.ok(!jar.cookies.has('ember_account'));
  assert.equal((await api(base, again.body.session).get('/api/v1/servers')).status, 401);
  const db = require('../src/db');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM sessions').n + db.get('SELECT COUNT(*) AS n FROM refresh_tokens').n, 0);
  assert.equal((await jar.get('/account')).status, 302); // back to signing in
});

test('signing out of the page ends only that session; a callback that was not started here is refused', async () => {
  const b = browser();
  await signIn(b, 'bob');
  const other = await api(base).post('/api/v1/auth/login', { username: 'bob', password: PW });
  const r = await b.form('/account/signout', { csrf: csrfOf((await b.get('/account')).text) });
  assert.equal(r.status, 200);
  assert.ok(!b.cookies.has('ember_account'));
  assert.equal((await api(base, other.body.session).get('/api/v1/servers')).status, 200);
  // a code for another browser's sign-in, or no sign-in at all
  const stranger = browser();
  let cb = await stranger.get('/account/auth/callback.html?code=abc&state=def');
  assert.equal(cb.status, 400);
  const start = await stranger.get('/account');
  cb = await stranger.get('/account/auth/callback.html?code=abc&state=' + new URL(start.location, base).searchParams.get('state'));
  assert.equal(cb.status, 400); // the right state, a made-up code
  assert.ok(!stranger.cookies.has('ember_account'));
  cb = await stranger.get('/account/auth/callback.html?error=access_denied&state=x');
  assert.ok(cb.text.includes('cancelled'));
});
