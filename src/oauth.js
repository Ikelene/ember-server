'use strict';
// The homeserver as an OAuth 2.0 authorization server for Ember clients (PROTOCOL §4a). Ember is a public client: there is
// no client secret, PKCE (S256) is required. The /login page ends by handing the client a one-time code; the token endpoint
// turns it into an access token (an ordinary session, so every route and the gateway take it) and a refresh token.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const { err, b64url, sha256, randHex, now } = require('./util');

const CLIENT_ID = 'ember';
const CODE_TTL = 60 * 1000;
const ACCESS_TTL = 3600 * 1000;
const REFRESH_TTL = 60 * 24 * 3600 * 1000;
const REUSE_GRACE = 30 * 1000; // two tabs refreshing at once: the second gets the same new tokens instead of losing the family
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

const oauthErr = (code, description, status = 400) => err(code, status, { error_description: description });

// ---------- redirect_uri ----------
// Allowed: an origin in ember_clients, over https (http only for localhost / 127.0.0.1), no credentials, and one of
//   a) no fragment and a path ending in /auth/callback.html  -> the answer is added to the query string
//   b) any path with the fragment route "#/auth/callback"    -> the answer is added inside the fragment: #/auth/callback?code=..&state=..
// -> { uri (exactly as given), origin, fragment } | null
function checkRedirect(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2000 || /[\s\u0000-\u001f]/.test(raw)) return null;
  let u; try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password) return null;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
  if (!config.get().ember_clients.includes(u.origin)) return null;
  const hash = raw.indexOf('#');
  if (hash === -1) return u.pathname.endsWith('/auth/callback.html') ? { uri: raw, origin: u.origin, fragment: false } : null;
  return raw.slice(hash) === '#/auth/callback' ? { uri: raw, origin: u.origin, fragment: true } : null;
}
// the address to send the browser back to, with the answer (code + state, or error + state) attached
function redirectWith(redirect, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  if (redirect.fragment) return `${redirect.uri}?${q}`;
  return redirect.uri + (redirect.uri.includes('?') ? '&' : '?') + q;
}

// ---------- the authorization request (GET /login) ----------
// -> { ok: true, authz } | { ok: false, redirect, error, description } (answer goes back to the client) | { ok: false, error, description } (shown here)
function parseAuthz(q) {
  const s = k => (typeof q[k] === 'string' ? q[k] : '');
  if (s('client_id') !== CLIENT_ID) return { ok: false, error: 'invalid_client', description: 'Unknown client_id.' };
  const redirect = checkRedirect(s('redirect_uri'));
  if (!redirect) return { ok: false, error: 'invalid_redirect_uri', description: 'This redirect_uri is not allowed here.' };
  const state = s('state');
  if (state.length > 512) return { ok: false, redirect, error: 'invalid_request', description: 'state is too long.' };
  const back = (error, description) => ({ ok: false, redirect, state, error, description });
  if (s('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code.');
  if (s('code_challenge_method') !== 'S256' || !CHALLENGE.test(s('code_challenge'))) return back('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  return { ok: true, authz: { client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirect.uri, state, code_challenge: s('code_challenge'), code_challenge_method: 'S256', login_hint: s('login_hint').slice(0, 100) }, redirect };
}

// ---------- codes ----------
const codes = new Map(); // sha256(code) -> { user_id, client_id, redirect_uri, challenge, exp, family }
function sweep(map, t = now()) { if (map.size > 500) for (const [k, v] of map) if (v.exp < t) map.delete(k); }
function issueCode(user, authz) {
  sweep(codes);
  const code = b64url(crypto.randomBytes(32));
  codes.set(sha256(code), { user_id: user.id, client_id: authz.client_id, redirect_uri: authz.redirect_uri, challenge: authz.code_challenge, exp: now() + CODE_TTL, family: null });
  return code;
}

// ---------- tokens ----------
function accountView(u) {
  const domain = config.domain();
  let avatar = null;
  if (u.pfp) { try { const x = new URL(u.pfp, config.publicUrl() + '/'); if (/^https?:$/.test(x.protocol)) avatar = x.href; } catch { /* none */ } }
  if (u.kind === 'remote') return { id: u.principal, username: u.username.split('@')[0], domain: u.domain, handle: u.username, display_name: u.display_name, avatar_url: avatar, remote: true };
  return { id: u.principal, username: u.username, domain, handle: `${u.username}@${domain}`, display_name: u.display_name, avatar_url: avatar };
}
// an account that may hold tokens right now
function usable(userId) {
  const u = auth.userById(userId);
  // an account hosted here, or one of another homeserver that is still let in (PROTOCOL §4b: its refresh tokens work the same)
  const ok = u && (u.kind === 'remote' ? require('./federation/remote').sessionAllowed(u) : u.kind === 'local' && config.mode() === 'local');
  if (!ok) throw oauthErr('invalid_grant', 'This account cannot sign in here.');
  if (u.banned) throw oauthErr('access_denied', 'This account is banned.', 403);
  return u;
}
function issueTokens(u, clientId, family = randHex(16)) {
  const refresh = b64url(crypto.randomBytes(32));
  db.run('INSERT INTO refresh_tokens (hash, family, user_id, client_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', sha256(refresh), family, u.id, clientId, now(), now() + REFRESH_TTL);
  const access = auth.createSession(u.id, auth.LOCAL_SCOPES, null, { ttl: ACCESS_TTL, family });
  return { family, body: { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL / 1000, token_type: 'Bearer', account: accountView(u) } };
}

function grantCode(b) {
  const str = k => (typeof b[k] === 'string' ? b[k] : '');
  if (!str('code') || !str('code_verifier') || !str('redirect_uri')) throw oauthErr('invalid_request', 'code, code_verifier and redirect_uri are required.');
  const key = sha256(str('code')), c = codes.get(key);
  if (!c) throw oauthErr('invalid_grant', 'Unknown or expired code.');
  if (c.family) { auth.revokeFamily(c.family); codes.delete(key); throw oauthErr('invalid_grant', 'This code was already used.'); } // a replayed code: what it issued goes too
  if (c.exp < now()) { codes.delete(key); throw oauthErr('invalid_grant', 'Unknown or expired code.'); }
  c.family = 'spent'; // single use, whatever happens next
  if (c.client_id !== str('client_id')) throw oauthErr('invalid_grant', 'The code was issued to another client.');
  if (c.redirect_uri !== str('redirect_uri')) throw oauthErr('invalid_grant', 'redirect_uri does not match the authorization request.');
  if (!VERIFIER.test(str('code_verifier')) || b64url(crypto.createHash('sha256').update(str('code_verifier')).digest()) !== c.challenge) throw oauthErr('invalid_grant', 'code_verifier does not match the code_challenge.');
  const out = issueTokens(usable(c.user_id), c.client_id);
  c.family = out.family;
  return out.body;
}

const recent = new Map(); // sha256(old refresh token) -> { body, exp }: the answer a racing second use gets
function grantRefresh(b) {
  const token = typeof b.refresh_token === 'string' ? b.refresh_token : '';
  if (!token || token.length > 200) throw oauthErr('invalid_request', 'refresh_token is required.');
  const hash = sha256(token), row = db.get('SELECT * FROM refresh_tokens WHERE hash = ?', hash);
  if (!row || row.client_id !== b.client_id) throw oauthErr('invalid_grant', 'Unknown refresh token.');
  const t = now();
  if (row.used_at) {
    const again = recent.get(hash);
    if (again && t - row.used_at <= REUSE_GRACE) return again.body;
    auth.revokeFamily(row.family); // an old refresh token used again: someone else may hold the family, so it all ends
    throw oauthErr('invalid_grant', 'This refresh token was already used. Sign in again.');
  }
  if (row.expires_at < t) { db.run('DELETE FROM refresh_tokens WHERE hash = ?', hash); throw oauthErr('invalid_grant', 'The refresh token has expired.'); }
  const u = usable(row.user_id);
  db.run('UPDATE refresh_tokens SET used_at = ? WHERE hash = ?', t, hash);
  const out = issueTokens(u, row.client_id, row.family);
  sweep(recent, t);
  recent.set(hash, { body: out.body, exp: t + REUSE_GRACE });
  return out.body;
}

// POST /api/v2/auth/token
function token(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.client_id !== CLIENT_ID) throw oauthErr('invalid_client', 'Unknown client_id.', 401);
  if (b.grant_type === 'authorization_code') return grantCode(b);
  if (b.grant_type === 'refresh_token') return grantRefresh(b);
  throw oauthErr('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.');
}
// POST /api/v2/auth/revoke { token }: a refresh token or an access token; its whole family ends. Always answers ok.
function revoke(tok) {
  if (typeof tok !== 'string' || !tok || tok.length > 200) return;
  const hash = sha256(tok);
  const family = db.get('SELECT family FROM refresh_tokens WHERE hash = ?', hash)?.family || db.get('SELECT family FROM sessions WHERE hash = ?', hash)?.family;
  if (family) auth.revokeFamily(family);
  else db.run('DELETE FROM sessions WHERE hash = ? AND expires_at IS NOT NULL', hash);
}

const _test = { codes, recent, expireCodes() { for (const c of codes.values()) c.exp = 0; }, ageRefresh(ms) { db.run('UPDATE refresh_tokens SET used_at = used_at - ? WHERE used_at IS NOT NULL', ms); } };
module.exports = { CLIENT_ID, checkRedirect, redirectWith, parseAuthz, issueCode, issueTokens, token, revoke, accountView, _test };
