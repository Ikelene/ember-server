'use strict';
// How accounts are made here (PROTOCOL §4a "Registration"). accounts.registration:
//   open      anyone (and anyone while the homeserver is unclaimed: its first account)
//   invite    with a registration code an admin made (registration_invites: uses, an expiry, revoked)
//   approval  anyone may ask; the account waits (users.approval = 'pending') and cannot sign in until an admin approves
//             it. A rejected one is deleted. Admins hear of each request: on the gateway (`homeserver_pending`) and, for an
//             admin with a Nookara account, in their Nookara inbox (relay notice §12.13 `account_request`). Otherwise it is
//             only listed.
//   closed    nobody
// Also: setting, changing and removing an account's password (POST / DELETE /api/v2/account/password).
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const { err, now } = require('./util');

const MAX_INVITES = 500, FRESH = 10 * 60 * 1000;
const claimed = () => !!db.metaGet('owner_user_id');
// unclaimed: open, so the owner can make the account that claims it, unless Nookara accounts sign in here (the owner uses theirs)
const mode = () => (claimed() || config.nookaraIdentity() ? config.get().accounts.registration : 'open');
// may someone make an account here at all (with whatever the mode asks for)
const canRegister = () => mode() !== 'closed';

// ---------- invites ----------
const CODE_RE = /^[A-Za-z0-9]{6,40}$/;
const inviteView = r => ({ code: r.code, note: r.note || '', uses: r.uses, max_uses: r.max_uses ?? null, expires_at: r.expires_at ?? null, created_at: r.created_at, created_by: r.created_by_name || null, revoked: !!r.revoked_at });
const usable = (r, t = now()) => r && !r.revoked_at && (r.max_uses == null || r.uses < r.max_uses) && (r.expires_at == null || r.expires_at > t);
function listInvites() {
  return db.all(`SELECT i.*, u.username AS created_by_name FROM registration_invites i LEFT JOIN users u ON u.id = i.created_by
    WHERE i.revoked_at IS NULL ORDER BY i.created_at DESC`).map(inviteView);
}
// { max_uses?: 1-1000 | null, expires_in_hours?: 1-8760 | null, note?: up to 200 characters }
function createInvite(me, b = {}) {
  const maxUses = b.max_uses == null ? null : Number(b.max_uses);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000)) throw err('invalid_max_uses');
  const hours = b.expires_in_hours == null ? null : Number(b.expires_in_hours);
  if (hours !== null && (!Number.isFinite(hours) || hours < 1 || hours > 8760)) throw err('invalid_expires_in_hours');
  if (b.note != null && (typeof b.note !== 'string' || b.note.length > 200)) throw err('invalid_note');
  if (db.get('SELECT COUNT(*) AS n FROM registration_invites WHERE revoked_at IS NULL').n >= MAX_INVITES) throw err('too_many_invites', 409, { limit: MAX_INVITES });
  // no look-alike characters (0/O, 1/l/I)
  const ABC = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from(crypto.randomBytes(12), x => ABC[x % ABC.length]).join('');
  db.run('INSERT INTO registration_invites (code, note, max_uses, uses, expires_at, created_by, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
    code, (b.note || '').trim(), maxUses, hours === null ? null : now() + Math.round(hours * 3600000), me.id, now());
  return { invite: inviteView(db.get('SELECT i.*, u.username AS created_by_name FROM registration_invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.code = ?', code)) };
}
function revokeInvite(code) {
  if (!db.run('UPDATE registration_invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL', now(), String(code)).changes) throw err('invite_not_found', 404);
  return { invites: listInvites() };
}
// one use of a code, taken before the account is made (and given back if making it fails)
function takeInvite(code) {
  if (typeof code !== 'string' || !code.trim()) throw err('invite_required', 403);
  const c = code.trim();
  if (!CODE_RE.test(c) || !usable(db.get('SELECT * FROM registration_invites WHERE code = ?', c))) throw err('invalid_invite', 403);
  if (!db.run('UPDATE registration_invites SET uses = uses + 1 WHERE code = ? AND revoked_at IS NULL AND (max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > ?)', c, now()).changes) throw err('invalid_invite', 403);
  return c;
}
const giveBack = code => db.run('UPDATE registration_invites SET uses = MAX(0, uses - 1) WHERE code = ?', code);

// ---------- making an account ----------
// -> { user (row), pending }. invite: the code (invite mode). noPassword / displayName: an outside login (login.js)
async function createAccount({ username, password, invite = null, noPassword = false, displayName = null }) {
  const m = mode();
  if (m === 'closed') throw err('registration_closed', 403);
  const code = m === 'invite' ? takeInvite(invite) : null;
  let id;
  try { id = await auth.createLocalUser(username, password, { noPassword, displayName }); }
  catch (e) { if (code) giveBack(code); throw e; }
  if (code) db.run('UPDATE users SET registered_with = ? WHERE id = ?', code, id);
  if (m !== 'approval') return { user: auth.userById(id), pending: false };
  db.run("UPDATE users SET approval = 'pending' WHERE id = ?", id);
  const u = auth.userById(id);
  tellAdmins(u);
  return { user: u, pending: true };
}
// the account is waiting for an admin: it cannot sign in yet
const isPending = u => !!u && u.approval === 'pending';
function assertNotPending(u) { if (isPending(u)) throw err('account_pending', 403); }

function tellAdmins(u) {
  const gw = require('./gateway');
  try { gw.pushToAdmins({ type: 'homeserver_pending', kind: 'account', account: pendingView(u) }); } catch { /* no gateway (tests) */ }
  notice('account_request', u.username);
}
// an admin's Nookara inbox (relay notice §12.13): only for admins with a Nookara account, and only while relays are on
function notice(kind, name) {
  const client = require('./relay/client');
  if (!client.registered()) return;
  const { relayPath } = require('./compat');
  const owner = String(db.metaGet('owner_user_id') ?? '');
  const admins = db.all("SELECT DISTINCT u.nookara_id FROM users u WHERE u.nookara_id IS NOT NULL AND u.banned = 0 AND (u.id IN (SELECT user_id FROM instance_admins) OR CAST(u.id AS TEXT) = ?)", owner);
  for (const a of admins.slice(0, 20)) {
    client.call('POST', relayPath('/notice'), { user_id: String(a.nookara_id), kind, community_name: String(name || '').slice(0, 80) })
      .catch(e => { if (e.status !== 429) console.error('[registration] notice', e.code || e.message); });
  }
}

// ---------- approvals ----------
const pendingView = u => ({ id: u.principal, username: u.username, display_name: u.display_name, created_at: u.created_at,
  logins: db.all('SELECT method_id, email FROM login_links WHERE user_id = ?', u.id).map(l => ({ method: l.method_id, email: l.email || null })) });
const listPending = () => db.all("SELECT * FROM users WHERE kind = 'local' AND approval = 'pending' ORDER BY created_at").map(pendingView);
function pendingUser(id) {
  const u = auth.userByPrincipal(String(id)) || (/^\d+$/.test(String(id)) ? auth.userById(Number(id)) : null);
  if (!isPending(u)) throw err('account_not_pending', 404);
  return u;
}
function approve(id) {
  const u = pendingUser(id);
  db.run('UPDATE users SET approval = NULL WHERE id = ?', u.id);
  return { ok: true, account: { id: u.principal, username: u.username } };
}
function reject(id) {
  const u = pendingUser(id);
  db.run('DELETE FROM users WHERE id = ?', u.id); // (its login links, sessions and refresh tokens go with it)
  return { ok: true };
}

const adminView = () => ({ registration: mode(), invites: listInvites(), pending: listPending() });

// ---------- an account's password ----------
// Signed in within the last ten minutes: the refresh family (homeserver login) or the session (older clients) started then
function freshSignIn(session) {
  if (!session) return false;
  const started = session.family ? db.get('SELECT MIN(created_at) AS t FROM refresh_tokens WHERE family = ?', session.family)?.t : db.get('SELECT created_at FROM sessions WHERE hash = ?', session.hash)?.created_at;
  return Number.isFinite(started) && now() - started < FRESH;
}
// a change needs the current password, or (an account without one) a fresh sign-in
async function proveIt(u, session, current) {
  if (u.password_hash) {
    if (typeof current !== 'string' || !(await auth.checkPassword(current.slice(0, 200), u.password_hash))) throw err('invalid_credentials', 403);
  } else if (!freshSignIn(session)) throw err('fresh_sign_in_required', 403, { max_age_seconds: FRESH / 1000 });
}
function assertLocal(u) { if (!u || u.kind !== 'local' || config.mode() !== 'local') throw err('not_allowed', 403); }
// POST /api/v2/account/password { new_password, current_password? }
async function setPassword(u, session, b = {}) {
  assertLocal(u);
  if (!auth.passwordMethod()) throw err('password_login_disabled', 403);
  const pw = b.new_password;
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) throw err('invalid_password');
  await proveIt(u, session, b.current_password);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', await auth.hashPassword(pw), u.id);
  // other sign-ins end: a changed password should lock out whoever knew the old one
  db.run('DELETE FROM sessions WHERE user_id = ? AND hash <> ?', u.id, session?.hash || '');
  db.run('DELETE FROM refresh_tokens WHERE user_id = ? AND family IS NOT ?', u.id, session?.family || null);
  return require('./login').logins(auth.userById(u.id));
}
// DELETE /api/v2/account/password { current_password? }: only while another login still lets them in
async function removePassword(u, session, b = {}) {
  assertLocal(u);
  if (!u.password_hash) throw err('no_password', 404);
  const methods = config.get().accounts.login_methods;
  const others = db.all('SELECT method_id FROM login_links WHERE user_id = ?', u.id).filter(l => methods.some(m => m.id === l.method_id && m.enabled && m.kind !== 'password'));
  if (!others.length) throw err('last_login_method', 409);
  await proveIt(u, session, b.current_password);
  db.run('UPDATE users SET password_hash = NULL WHERE id = ?', u.id);
  return require('./login').logins(auth.userById(u.id));
}

function register(app) {
  app.get('/api/v2/homeserver/registration', { admin: true }, () => adminView());
  app.post('/api/v2/homeserver/registration/invites', { admin: true }, req => createInvite(req.user, req.body || {}));
  app.delete('/api/v2/homeserver/registration/invites/:code', { admin: true }, req => revokeInvite(req.params.code));
  app.post('/api/v2/homeserver/registration/pending/:id/approve', { admin: true }, req => approve(req.params.id));
  app.post('/api/v2/homeserver/registration/pending/:id/reject', { admin: true }, req => reject(req.params.id));
  app.post('/api/v2/account/password', req => setPassword(req.user, req.session, req.body || {}));
  app.delete('/api/v2/account/password', req => removePassword(req.user, req.session, req.body || {}));
}

module.exports = { mode, canRegister, createAccount, isPending, assertNotPending, notice, listInvites, createInvite, revokeInvite, listPending, approve, reject, adminView, setPassword, removePassword, freshSignIn, register };
