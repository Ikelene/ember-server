'use strict';
// Registration modes (PROTOCOL §4a): invite (codes admins make, list and revoke), approval (a new account waits until an admin
// approves or rejects it), closed; and an account's password: set, change, remove, with the current password or a fresh sign-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const { startServer } = require('../src/index');

const dir = tmpDir();
let inst, base, admin, db;
const PASS = 'correct horse battery';
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; db = require('../src/db'); });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const register = (username, extra = {}) => { require('../src/auth').limits.register.reset?.(); return api(base).post('/api/v1/auth/register', { username, password: PASS, ...extra }); };
const login = (username, password = PASS) => { require('../src/auth').limits.login.reset?.(); return api(base).post('/api/v1/auth/login', { username, password }); };
const mode = registration => admin.a.patch('/api/v2/homeserver/accounts', { registration });

test('setup: the first account claims the homeserver while registration is still open to it', async () => {
  const r = await register('root');
  assert.equal(r.status, 200);
  admin = { ...r.body, a: api(base, r.body.session) };
  await admin.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  assert.equal((await mode('closed')).status, 200);
  assert.deepEqual([(await register('nope')).status, (await register('nope')).body.error], [403, 'registration_closed']);
  assert.equal((await api(base).get('/.well-known/ember')).body.accounts.registration, 'closed');
});

test('invite: an account needs a code; codes have uses, an expiry, and can be revoked', async () => {
  await mode('invite');
  assert.equal((await api(base).get('/.well-known/ember')).body.accounts.registration, 'invite');
  assert.equal((await register('ivy')).body.error, 'invite_required');
  assert.equal((await register('ivy', { invite: 'NOTACODE1' })).body.error, 'invalid_invite');
  const P = '/api/v2/homeserver/registration';
  const anon = await register('x1', { invite: 'x' });
  assert.equal(anon.status, 403);
  const made = await admin.a.post(P + '/invites', { max_uses: 2, note: 'for the book club' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const { code } = made.body.invite;
  assert.match(code, /^[A-Za-z2-9]{12}$/);
  assert.deepEqual([made.body.invite.uses, made.body.invite.max_uses, made.body.invite.note, made.body.invite.created_by], [0, 2, 'for the book club', 'root']);
  for (const [body, error] of [[{ max_uses: 0 }, 'invalid_max_uses'], [{ expires_in_hours: 0.1 }, 'invalid_expires_in_hours'], [{ note: 'x'.repeat(201) }, 'invalid_note']]) assert.equal((await admin.a.post(P + '/invites', body)).body.error, error);
  const ivy = await register('ivy', { invite: code });
  assert.equal(ivy.status, 200); assert.ok(ivy.body.session);
  assert.equal(db.get("SELECT registered_with FROM users WHERE username = 'ivy'").registered_with, code);
  assert.equal((await register('ivy', { invite: code })).body.error, 'username_taken'); // a failed try gives the use back
  assert.equal((await register('jun', { invite: code })).status, 200);
  assert.equal((await register('kai', { invite: code })).body.error, 'invalid_invite'); // used up
  const list = (await admin.a.get(P)).body;
  assert.equal(list.registration, 'invite');
  assert.deepEqual(list.invites.find(i => i.code === code).uses, 2);
  // expired, and revoked
  const short = (await admin.a.post(P + '/invites', { expires_in_hours: 1 })).body.invite.code;
  db.run('UPDATE registration_invites SET expires_at = ? WHERE code = ?', Date.now() - 1, short);
  assert.equal((await register('kai', { invite: short })).body.error, 'invalid_invite');
  const gone = (await admin.a.post(P + '/invites', {})).body.invite.code;
  assert.equal((await admin.a.del(P + '/invites/' + gone)).status, 200);
  assert.equal((await admin.a.del(P + '/invites/' + gone)).status, 404);
  assert.equal((await register('kai', { invite: gone })).body.error, 'invalid_invite');
  assert.ok(!(await admin.a.get(P)).body.invites.some(i => i.code === gone));
  // admins only
  assert.equal((await api(base, ivy.body.session).get(P)).status, 403);
  assert.equal((await api(base, ivy.body.session).post(P + '/invites', {})).status, 403);
});

test('approval: the account waits, cannot sign in, admins hear of it and approve or reject it', async () => {
  await mode('approval');
  const ws = wsClient(base); await ws.open(); ws.send({ type: 'auth', session: admin.session }); await ws.waitFor(f => f.type === 'auth_success');
  const r = await register('pat');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.pending, r.body.user.username, 'session' in r.body], [true, 'pat', false]);
  const heard = await ws.waitFor(f => f.type === 'homeserver_pending');
  assert.deepEqual([heard.kind, heard.account.username], ['account', 'pat']);
  ws.close();
  assert.deepEqual([(await login('pat')).status, (await login('pat')).body.error], [403, 'account_pending']);
  const P = '/api/v2/homeserver/registration';
  const pending = (await admin.a.get(P)).body.pending;
  assert.deepEqual(pending.map(p => p.username), ['pat']);
  assert.equal((await admin.a.post(`${P}/pending/${encodeURIComponent(pending[0].id)}/approve`)).status, 200);
  assert.equal((await login('pat')).status, 200);
  assert.equal((await admin.a.post(`${P}/pending/${encodeURIComponent(pending[0].id)}/approve`)).body.error, 'account_not_pending');
  // rejected: the account is gone and the name is free again
  await register('quinn');
  const q = (await admin.a.get(P)).body.pending.find(p => p.username === 'quinn');
  assert.equal((await admin.a.post(`${P}/pending/${encodeURIComponent(q.id)}/reject`)).status, 200);
  assert.equal(db.get("SELECT 1 FROM users WHERE username = 'quinn'"), undefined);
  assert.equal((await login('quinn')).body.error, 'invalid_credentials');
  assert.equal((await register('quinn')).body.pending, true);
});

test('the /login page: an invite code field in invite mode, a waiting page in approval mode', async () => {
  const crypto = require('crypto');
  const challenge = crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url');
  const q = new URLSearchParams({ client_id: 'ember', response_type: 'code', redirect_uri: 'http://localhost:5173/auth/callback.html', state: 's', code_challenge: challenge, code_challenge_method: 'S256' });
  require('../src/config').update({ ember_clients: ['http://localhost:5173'] });
  await mode('invite');
  let html = await (await fetch(`${base}/login?${q}&view=register&invite=ABCdef234`)).text();
  assert.match(html, /name="invite"[^>]*value="ABCdef234"/);
  await mode('approval');
  html = await (await fetch(`${base}/login?${q}&view=register`)).text();
  assert.ok(!/name="invite"/.test(html) && /looks at new accounts/.test(html));
});

test('password: change with the current one, set one with a fresh sign-in, remove only while another login is left', async () => {
  await mode('open');
  const r = await register('sam');
  const sam = api(base, r.body.session);
  const P = '/api/v2/account/password';
  assert.equal((await sam.post(P, { new_password: 'short' })).body.error, 'invalid_password');
  assert.deepEqual([(await sam.post(P, { new_password: 'another good one' })).status, (await sam.post(P, { new_password: 'another good one' })).body.error], [403, 'invalid_credentials']);
  const other = (await login('sam')).body.session; // a second sign-in, which a change ends
  const ok = await sam.post(P, { new_password: 'another good one', current_password: PASS });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.logins.find(l => l.kind === 'password').linked);
  assert.equal((await api(base, other).get('/api/v1/me')).status, 401);
  assert.equal((await sam.get('/api/v1/me')).status, 200);
  assert.equal((await login('sam')).body.error, 'invalid_credentials');
  assert.equal((await login('sam', 'another good one')).status, 200);
  // no other login: the password stays
  assert.equal((await sam.del(P, { current_password: 'another good one' })).body.error, 'last_login_method');
  // an account without a password (an outside login) sets one after a fresh sign-in only
  db.run("UPDATE users SET password_hash = NULL WHERE username = 'sam'");
  assert.equal((await sam.post(P, { new_password: 'a third good one' })).status, 200); // signed in moments ago
  db.run("UPDATE users SET password_hash = NULL WHERE username = 'sam'");
  db.run("UPDATE sessions SET created_at = created_at - 3600000 WHERE user_id = (SELECT id FROM users WHERE username = 'sam')");
  const stale = await sam.post(P, { new_password: 'a fourth good one' });
  assert.deepEqual([stale.status, stale.body.error, stale.body.max_age_seconds], [403, 'fresh_sign_in_required', 600]);
});
