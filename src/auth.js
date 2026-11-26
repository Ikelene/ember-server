'use strict';
// Instance sessions, Nookara instance-JWT login (PROTOCOL §2.2/§4), local accounts, principals, admin/owner helpers.
const { KIND_NOOKARA, ERR, NOOKARA_ID_FIELD, NOOKARA_PATHS } = require('./compat');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { err, normalizeOrigin, sameNookara, b64url, fromB64url, sha256, now, clean, limiter } = require('./util');

const SESSION_TTL = 30 * 24 * 3600 * 1000;
const SKEW_S = 60;

// ---------- users / principals ----------
// bots (principal b:<n>) carry bot: true so clients show the BOT tag
// gallery-approved bots (added from Nookara's bot gallery) also carry verified: true (checkmark on the BOT tag)
const botVerified = principal => { try { return !!db.get('SELECT b.gallery_verified AS v FROM bots b JOIN users u ON u.id = b.user_id WHERE u.principal = ?', String(principal))?.v; } catch { return false; } };
// accounts of another homeserver (kind 'remote', PROTOCOL §4b) carry remote: true and their homeserver's domain; their username is the whole handle (name@domain)
const userView = u => (u ? { id: u.principal, kind: u.kind, username: u.username, display_name: u.display_name, pfp: u.pfp || null, [NOOKARA_ID_FIELD]: u.nookara_id || null, ...(u.kind === 'remote' ? { remote: true, domain: u.domain, handle: u.username } : {}), ...(u.kind === 'bot' ? { bot: true, ...(botVerified(u.principal) ? { verified: true } : {}) } : {}) } : null);
const userById = id => db.get('SELECT * FROM users WHERE id = ?', id);
const userByPrincipal = p => db.get('SELECT * FROM users WHERE principal = ?', String(p));

function upsertNookaraUser({ id, username, display_name, pfp }) {
  const principal = 'v:' + id;
  const un = clean(username, 64) || 'user' + id, dn = clean(display_name, 64) || un;
  const row = userByPrincipal(principal);
  if (row) {
    db.run('UPDATE users SET username = ?, display_name = ?, pfp = ?, last_login = ? WHERE id = ?', un, dn, pfp || null, now(), row.id);
    if (row.username !== un || row.display_name !== dn || (row.pfp || null) !== (pfp || null)) identityChanged(userById(row.id), row.username);
    return userById(row.id);
  }
  const r = db.run('INSERT INTO users (principal, kind, username, display_name, pfp, nookara_id, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', principal, KIND_NOOKARA, un, dn, pfp || null, String(id), now(), now());
  return userById(r.lastInsertRowid);
}
// a profile fetched from Nookara (src/profiles.js): update an existing account, never create one, never touch last_login
function refreshNookaraProfile({ id, username, display_name, pfp }) {
  const row = userByPrincipal('v:' + id);
  if (!row || row.kind !== KIND_NOOKARA) return false;
  const un = clean(username, 64) || row.username, dn = clean(display_name, 64) || un;
  if (row.username === un && row.display_name === dn && (row.pfp || null) === (pfp || null)) return false;
  db.run('UPDATE users SET username = ?, display_name = ?, pfp = ? WHERE id = ?', un, dn, pfp || null, row.id);
  identityChanged(userById(row.id), row.username);
  return true;
}
// Nookara switched Ember off (or back on) for this account. -> true when it changed; open sockets are told right away
function setRestricted(nookaraId, flag) {
  const row = userByPrincipal('v:' + nookaraId);
  if (!row || row.kind !== KIND_NOOKARA || !!row.restricted === !!flag) return false;
  db.run('UPDATE users SET restricted = ? WHERE id = ?', flag ? 1 : 0, row.id);
  require('./gateway').restrictionChanged(row.id, !!flag);
  return true;
}
// placeholder for a Nookara user we've only heard of (import, EMBER_OWNER) - refreshed on their first login
function ensureNookaraPlaceholder(id, username, pfp) {
  const row = userByPrincipal('v:' + id);
  if (row) return row;
  const un = clean(username, 64) || 'user' + id;
  const r = db.run('INSERT INTO users (principal, kind, username, display_name, pfp, nookara_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'v:' + id, KIND_NOOKARA, un, un, pfp || null, String(id), now());
  return userById(r.lastInsertRowid);
}

// a profile change (name / picture) reaches every community the person is in: chat_identity_update { user, previous_username }
function identityChanged(u, previousUsername) {
  const gw = require('./gateway');
  for (const m of db.all('SELECT community_id FROM members WHERE user_id = ?', u.id)) gw.emit(m.community_id, { type: 'chat_identity_update', user: userView(u), previous_username: previousUsername });
}

// ---------- sessions ----------
// ttl + family: an access token from the token endpoint (PROTOCOL §4a): it ends after ttl ms and goes with its refresh family
function createSession(userId, scopes, app = null, { ttl = null, family = null } = {}) {
  const token = b64url(crypto.randomBytes(32));
  db.run('INSERT INTO sessions (hash, user_id, scopes, created_at, last_used, app, expires_at, family) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', sha256(token), userId, JSON.stringify(scopes), now(), now(), app ? JSON.stringify(app) : null, ttl ? now() + ttl : null, family);
  return token;
}
// -> { user, scopes, hash } | null
function resolveSession(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const hash = sha256(token);
  const s = db.get('SELECT * FROM sessions WHERE hash = ?', hash);
  if (!s) return null;
  const t = now();
  if (t - s.last_used > SESSION_TTL || (s.expires_at && t >= s.expires_at)) { db.run('DELETE FROM sessions WHERE hash = ?', hash); return null; }
  const user = userById(s.user_id);
  if (!user) return null;
  // principals of the other account mode can no longer use the instance
  // (an account of another homeserver: while its homeserver is still let in, in either mode)
  if (user.kind === 'remote' ? !require('./federation/remote').sessionAllowed(user) : user.kind !== (config.mode() === 'nookara' ? KIND_NOOKARA : 'local')) return null;
  if (t - s.last_used > 3600 * 1000) db.run('UPDATE sessions SET last_used = ? WHERE hash = ?', t, hash);
  let scopes = []; try { scopes = JSON.parse(s.scopes); } catch { /* none */ }
  let app = null; try { app = s.app ? JSON.parse(s.app) : null; } catch { /* none */ }
  return { user, scopes, hash, app, family: s.family || null };
}
// signing out: the session goes, and with it the refresh family it came from (its other access tokens too)
function revokeSession(token) {
  if (!token) return;
  const s = db.get('SELECT family FROM sessions WHERE hash = ?', sha256(token));
  db.run('DELETE FROM sessions WHERE hash = ?', sha256(token));
  if (s?.family) revokeFamily(s.family);
}
function revokeFamily(family) {
  db.run('DELETE FROM refresh_tokens WHERE family = ?', family);
  db.run('DELETE FROM sessions WHERE family = ?', family);
}
const bearer = req => { const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || ''); return m ? m[1] : null; };
setInterval(() => { try { db.run('DELETE FROM sessions WHERE last_used < ? OR expires_at < ?', now() - SESSION_TTL, now()); db.run('DELETE FROM refresh_tokens WHERE expires_at < ?', now()); db.run('DELETE FROM jti_seen WHERE exp < ?', Math.floor(now() / 1000) - 3600); } catch { /* db closed */ } }, 3600 * 1000).unref();

// ---------- Nookara JWT ----------
let jwksFetcher = async () => {
  const url = `${config.get().nookara_url}${NOOKARA_PATHS.jwks}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('jwks ' + r.status);
  return r.json();
};
const setJwksFetcher = fn => { jwksFetcher = fn; jwks = null; };
let jwks = null; // { at, keys: Map(kid -> KeyObject), forced }
const JWKS_TTL = 10 * 60 * 1000;

async function loadJwks() {
  const doc = await jwksFetcher();
  const keys = new Map();
  for (const k of doc?.keys || []) {
    if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || !k.kid) continue;
    try { keys.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })); } catch { /* skip bad key */ }
  }
  jwks = { at: Date.now(), keys, forced: jwks?.forced || 0 };
}
async function keyFor(kid) {
  if (!jwks || Date.now() - jwks.at > JWKS_TTL) await loadJwks();
  let key = jwks.keys.get(kid);
  if (!key && Date.now() - (jwks.forced || 0) > 5000) { // unknown kid: refetch once (rate limited)
    const forced = Date.now();
    await loadJwks(); jwks.forced = forced;
    key = jwks.keys.get(kid);
  }
  return key;
}

const bad = code => err(code, 401);
// verifies signature, iss, aud, exp (60s skew) and jti replay. -> claims
async function verifyNookaraJwt(token, nowMs = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || token.length > 8192) throw bad('invalid_token');
  let header, claims;
  try { header = JSON.parse(fromB64url(parts[0]).toString()); claims = JSON.parse(fromB64url(parts[1]).toString()); } catch { throw bad('invalid_token'); }
  if (!header || header.alg !== 'EdDSA' || typeof header.kid !== 'string' || !claims || typeof claims !== 'object') throw bad('invalid_token');
  if (header.typ !== undefined && header.typ !== 'JWT') throw bad('invalid_token'); // e.g. a pay receipt (compat TYP.receipt) is never a login token (§12.5)
  let key;
  try { key = await keyFor(header.kid); } catch (e) { console.error('[auth] JWKS fetch failed:', e.message); throw err(ERR.unreachable, 502); }
  if (!key) throw bad('unknown_kid');
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1]), key, fromB64url(parts[2])); } catch { ok = false; }
  if (!ok) throw bad('invalid_signature');
  const cfg = config.get();
  if (!sameNookara(claims.iss, cfg.nookara_url)) throw bad('invalid_issuer');
  if (normalizeOrigin(claims.aud) !== normalizeOrigin(cfg.public_url)) throw bad('invalid_audience');
  const nowS = Math.floor(nowMs / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp + SKEW_S < nowS) throw bad('token_expired');
  if (Number.isFinite(claims.iat) && claims.iat - SKEW_S > nowS) throw bad('invalid_token');
  if (typeof claims.jti !== 'string' || !claims.jti || typeof claims.sub !== 'string' || !/^[1-9]\d{0,19}$/.test(claims.sub)) throw bad('invalid_token');
  const fresh = db.run('INSERT OR IGNORE INTO jti_seen (jti, exp) VALUES (?, ?)', claims.jti, claims.exp).changes;
  if (!fresh) throw bad('token_replayed');
  return claims;
}

// ---------- login flows ----------
function finishLogin(user, scopes, app = null) {
  if (user.banned) throw err('banned', 403);
  return { session: createSession(user.id, scopes, app), user: userView(userById(user.id)) };
}
async function loginNookara(token) {
  if (config.mode() !== 'nookara') throw err('wrong_accounts_mode', 400);
  const c = await verifyNookaraJwt(token);
  const scp = Array.isArray(c.scp) ? c.scp.filter(x => ['chat', 'voice', 'media', 'sign'].includes(x)) : [];
  if (!scp.includes('chat')) throw err('insufficient_scope', 403);
  const existing = userByPrincipal('v:' + c.sub);
  if (existing?.banned) throw err('banned', 403);
  const user = upsertNookaraUser({ id: c.sub, username: c.username, display_name: c.display_name, pfp: typeof c.pfp === 'string' ? c.pfp : null });
  // their Nookara plan (`tier` claim: free / pro ...): Server settings > Uploads > Plans whose files never expire
  const tier = typeof c.tier === 'string' && /^[a-z0-9_-]{1,24}$/.test(c.tier) ? c.tier : null;
  if ((user.tier ?? null) !== tier) { db.run('UPDATE users SET tier = ? WHERE id = ?', tier, user.id); user.tier = tier; }
  return finishLogin(user, scp, appClaim(c.app));
}
// the `app` claim of a Nookara token: the registered Nookara app the person signed in through ({ id, name, icon }), kept with
// the session so messages' `via` can name it. Nookara signed it, so it is taken as given, but only in this shape.
function appClaim(a) {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !/^app_[0-9a-f]{8,40}$/.test(a.id)) return null;
  const name = typeof a.name === 'string' ? a.name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) : '';
  const icon = typeof a.icon === 'string' && /^https:\/\/[^\s"'<>]{1,300}\/uploads\/app-logos\/[\w.-]+$/.test(a.icon) ? a.icon : null;
  return { id: a.id, ...(name ? { name } : {}), ...(icon ? { icon } : {}) };
}

// ---------- local accounts ----------
const SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${(await scrypt(pw, salt)).toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [alg, , , , salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) { await scrypt(pw, Buffer.alloc(16)); return false; }
  const k = await scrypt(pw, Buffer.from(salt, 'hex'));
  const h = Buffer.from(hash, 'hex');
  return k.length === h.length && crypto.timingSafeEqual(k, h);
}
const USERNAME = /^[a-z0-9_.]{2,32}$/;
const LOCAL_SCOPES = ['chat', 'voice', 'media'];
const claimed = () => !!db.metaGet('owner_user_id');

// the password way in, when the accounts settings have one switched on
const passwordMethod = () => config.get().accounts.login_methods.find(m => m.kind === 'password' && m.enabled) || null;
// anyone may make an account: registration is open, or nobody has claimed the homeserver yet (its first account)
const registrationOpen = () => config.get().accounts.registration === 'open' || !claimed();
async function registerLocal(username, password) {
  if (config.mode() !== 'local') throw err('wrong_accounts_mode', 400);
  if (!passwordMethod()) throw err('password_login_disabled', 403);
  if (!registrationOpen()) throw err('registration_closed', 403);
  return finishLogin(userById(await createLocalUser(username, password)), LOCAL_SCOPES);
}
// a username + password account (also made by an admin while still on Nookara accounts: the way back in after switching to local)
// noPassword: an account that signs in through a linked outside login only (PROTOCOL §4a)
async function createLocalUser(username, password, { noPassword = false, displayName = null } = {}) {
  const name = String(username || '').trim().toLowerCase();
  if (!USERNAME.test(name)) throw err('invalid_username');
  if (!noPassword && (typeof password !== 'string' || password.length < 8 || password.length > 200)) throw err('invalid_password');
  if (db.get("SELECT 1 FROM users WHERE kind IN ('local', 'bot') AND username_lc = ?", name)) throw err('username_taken', 409);
  const hash = noPassword ? null : await hashPassword(password);
  let id;
  try {
    id = db.tx(() => {
      const r = db.run("INSERT INTO users (principal, kind, username, display_name, username_lc, password_hash, created_at, last_login) VALUES ('pending', 'local', ?, ?, ?, ?, ?, ?)", name, clean(displayName, 64) || name, name, hash, now(), now());
      db.run('UPDATE users SET principal = ? WHERE id = ?', 'l:' + r.lastInsertRowid, r.lastInsertRowid);
      return r.lastInsertRowid;
    });
  } catch (e) { if (/UNIQUE/.test(e.message)) throw err('username_taken', 409); throw e; }
  return id;
}
// instance admins who can sign in with a username + password (switching to local accounts needs one)
const localAdmins = () => db.all("SELECT u.* FROM users u WHERE u.kind = 'local' AND (u.id IN (SELECT user_id FROM instance_admins) OR CAST(u.id AS TEXT) = ?)", String(db.metaGet('owner_user_id') ?? ''));
async function loginLocal(username, password) {
  if (config.mode() !== 'local') throw err('wrong_accounts_mode', 400);
  if (!passwordMethod()) throw err('password_login_disabled', 403);
  const u = db.get("SELECT * FROM users WHERE kind = 'local' AND username_lc = ?", String(username || '').trim().toLowerCase());
  const ok = await checkPassword(String(password || '').slice(0, 200), u?.password_hash);
  if (!u || !ok) throw err('invalid_credentials', 401);
  db.run('UPDATE users SET last_login = ? WHERE id = ?', now(), u.id);
  return finishLogin(u, LOCAL_SCOPES);
}
// the same check without making a session (the /login page): -> the user row
async function checkLocal(username, password) {
  const u = db.get("SELECT * FROM users WHERE kind = 'local' AND username_lc = ?", String(username || '').trim().toLowerCase());
  const ok = await checkPassword(String(password || '').slice(0, 200), u?.password_hash);
  if (!u || !ok) throw err('invalid_credentials', 401);
  if (u.banned) throw err('banned', 403);
  return u;
}
// sign-in limits per address, shared by /api/v1/auth/* and the /login page
const limits = { register: limiter(10, 3600 * 1000), login: limiter(20, 600 * 1000) };

// ---------- owner / admins ----------
const ownerRow = () => { const id = db.metaGet('owner_user_id'); return id ? userById(Number(id)) : null; };
const isOwner = u => !!u && String(db.metaGet('owner_user_id')) === String(u.id);
const isAdmin = u => !!u && (isOwner(u) || !!db.get('SELECT 1 FROM instance_admins WHERE user_id = ?', u.id));
// the owner is an account that can't sign in under the running accounts mode (a local account after switching to Nookara
// accounts, or a Nookara one after switching to local): the instance takes a new owner with the setup code, like an unclaimed one
const ownerStranded = () => { const o = ownerRow(); return !!o && o.kind !== (config.mode() === 'local' ? 'local' : KIND_NOOKARA); };
// returns the previous owner's id when ownership moved from someone else (their communities moved with it), else null
function setOwner(userId) {
  const old = db.metaGet('owner_user_id');
  const moved = old && String(old) !== String(userId) ? Number(old) : null;
  db.tx(() => {
    db.metaSet('owner_user_id', String(userId));
    db.run('INSERT OR IGNORE INTO instance_admins (user_id) VALUES (?)', userId);
    if (moved) db.run('UPDATE communities SET owner_id = ? WHERE owner_id = ?', userId, moved);
  });
  return moved;
}

module.exports = {
  userView, botVerified, userById, userByPrincipal, upsertNookaraUser, refreshNookaraProfile, setRestricted, ensureNookaraPlaceholder,
  createSession, resolveSession, revokeSession, revokeFamily, bearer, checkLocal, limits, passwordMethod, registrationOpen, LOCAL_SCOPES, USERNAME,
  verifyNookaraJwt, setJwksFetcher, keyFor, loginNookara, registerLocal, createLocalUser, localAdmins, loginLocal, hashPassword, checkPassword,
  claimed, ownerRow, ownerStranded, isOwner, isAdmin, setOwner, identityChanged, SESSION_TTL,
};
