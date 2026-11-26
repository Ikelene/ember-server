'use strict';
// Cross-homeserver sign-in (PROTOCOL §4b). A homeserver that hosts accounts signs a short token saying "this is my account
// X, for homeserver B" (issue); B checks it against the keys X's homeserver publishes and opens a session for a user of kind
// 'remote' whose principal is "id@domain" (accept). Remote users have no password here: their name and picture come from the
// token and are refreshed on every sign-in, the way Nookara accounts are.
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const safe = require('../safe-http');
const { err, normalizeOrigin, fromB64url, now, clean, limiter, randHex } = require('../util');
const keys = require('./keys');
const R = require('./rules');
const resolve = require('./resolve');
const seen = require('./seen');
const limits = require('./limits');
const denylist = require('./denylist');

const TYP = 'ember-remote+jwt';
const TOKEN_TTL = 3600; // seconds
const SKEW = 60;
const issueLimit = limiter(30, 60 * 1000); // remote tokens per account
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

// ---------- who is let in (config accounts.remote_accounts) ----------
const rule = () => config.get().accounts.remote_accounts;
const acceptMode = () => rule().mode;
function domainAllowed(domain) {
  const r = rule();
  if (r.mode === 'all') return true;
  if (r.mode === 'allowlist') return R.domainMatches(r.list, domain);
  if (r.mode === 'blocklist') return !R.domainMatches(r.list, domain);
  return false;
}
const domainOf = u => u.domain || R.parseSub(u.principal)?.domain || '';
// may this remote user's sessions be used right now? (asked on every request: auth.resolveSession)
const sessionAllowed = u => { const d = domainOf(u); return !!d && domainAllowed(d) && !denylist.check({ domain: d, ips: seen.ipsOf(d), sub: u.principal, handle: u.username }); };

// ---------- issuing (the account's own homeserver) ----------
function audienceOf(raw) {
  const aud = typeof raw === 'string' && raw.length <= 500 ? normalizeOrigin(raw) : null;
  if (!aud) throw err('invalid_audience', 400);
  const u = new URL(aud);
  if (u.protocol !== 'https:' && !(safe.local() && LOOPBACK.includes(u.hostname))) throw err('invalid_audience', 400, { reason: 'https_required' });
  if (aud === normalizeOrigin(config.publicUrl())) throw err('invalid_audience', 400, { reason: 'own_homeserver' });
  return aud;
}
function pictureOf(u) {
  if (!u.pfp) return null;
  try { const x = new URL(u.pfp, config.publicUrl() + '/'); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}
// POST /api/v2/auth/remote-token { audience } -> { token, expires_in }
function issue(user, body) {
  if (!require('../auth').hostedHere(user)) throw err('account_not_hosted_here', 403);
  const aud = audienceOf(body?.audience);
  if (!issueLimit.hit(user.id)) throw err('rate_limited', 429);
  const domain = config.domain(), iat = Math.floor(now() / 1000);
  const token = keys.signJwt(TYP, {
    iss: normalizeOrigin(config.publicUrl()), sub: `${user.principal}@${domain}`, aud, iat, exp: iat + TOKEN_TTL, jti: randHex(16),
    preferred_username: user.username, name: user.display_name || user.username, picture: pictureOf(user), domain,
  });
  return { token, expires_in: TOKEN_TTL };
}

// ---------- accepting (the homeserver being visited) ----------
const bad = (code, extra) => err(code, 401, extra);
function parse(token) {
  const parts = typeof token === 'string' && token.length <= 8192 ? token.split('.') : [];
  if (parts.length !== 3) throw bad('invalid_token');
  let header, claims;
  try { header = JSON.parse(fromB64url(parts[0]).toString()); claims = JSON.parse(fromB64url(parts[1]).toString()); } catch { throw bad('invalid_token'); }
  if (!header || header.alg !== 'EdDSA' || header.typ !== TYP || typeof header.kid !== 'string' || header.kid.length > 100 || !claims || typeof claims !== 'object') throw bad('invalid_token');
  const who = R.parseSub(claims.sub);
  if (!who || (claims.domain !== undefined && claims.domain !== who.domain)) throw bad('invalid_token');
  return { header, claims, who, signed: Buffer.from(parts[0] + '.' + parts[1]), sig: fromB64url(parts[2]) };
}
// everything a token must say before anyone is asked about its keys
function checkClaims(claims, t = now()) {
  if (normalizeOrigin(claims.aud) !== normalizeOrigin(config.publicUrl())) throw bad('invalid_audience');
  const s = Math.floor(t / 1000);
  if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat)) throw bad('invalid_token');
  if (claims.exp + SKEW < s) throw bad('token_expired');
  if (claims.iat - SKEW > s || claims.exp - claims.iat > TOKEN_TTL + SKEW) throw bad('invalid_token');
  if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 128) throw bad('invalid_token');
}
const refuseDenied = () => err('homeserver_denied', 403);

// -> { claims, domain, origin, ips }. Throws API errors.
async function verify(token) {
  const { header, claims, who, signed, sig } = parse(token);
  const domain = who.domain;
  if (acceptMode() === 'none') throw err('remote_accounts_off', 403);
  if (domain === config.domain()) throw err('own_homeserver', 400);
  checkClaims(claims);
  // rules that need nothing fetched come first: a refused homeserver is never contacted
  const handle = typeof claims.preferred_username === 'string' ? `${claims.preferred_username}@${domain}` : null;
  if (denylist.check({ domain, sub: claims.sub, handle })) throw refuseDenied();
  if (!domainAllowed(domain)) throw err('homeserver_not_allowed', 403, { domain });
  const hs = await resolve.homeserver(domain);
  if (normalizeOrigin(claims.iss) !== hs.origin) throw bad('invalid_issuer');
  const key = await resolve.keyFor(domain, hs, header.kid);
  if (!key) throw bad('unknown_kid');
  let ok = false;
  try { ok = crypto.verify(null, signed, key, sig); } catch { ok = false; }
  if (!ok) throw bad('invalid_signature');
  // one use per token: remembered until it expires (jti_seen is swept by auth.js)
  if (!db.run('INSERT OR IGNORE INTO jti_seen (jti, exp) VALUES (?, ?)', `r:${domain}:${claims.jti}`, claims.exp).changes) throw bad('token_replayed');
  const ips = await resolve.addresses(hs.origin);
  seen.touch(domain, { origin: hs.origin, ips });
  if (denylist.check({ domain, ips, sub: claims.sub, handle })) throw refuseDenied();
  return { claims, domain, origin: hs.origin, ips };
}

const USERNAME = /^[a-z0-9_.-]{1,32}$/;
function pictureIn(v) {
  if (typeof v !== 'string' || v.length > 500) return null;
  try { const u = new URL(v); return u.protocol === 'https:' || (u.protocol === 'http:' && safe.local()) ? u.href : null; } catch { return null; }
}
// the user row of a remote account: made on its first sign-in, its profile refreshed on every one
function upsertUser(claims, domain) {
  const principal = claims.sub;
  const raw = String(claims.preferred_username || '').trim().toLowerCase();
  const name = USERNAME.test(raw) ? raw : 'user';
  const username = `${name}@${domain}`, dn = clean(claims.name, 64) || name, pfp = pictureIn(claims.picture);
  const row = auth.userByPrincipal(principal);
  if (row) {
    if (row.kind !== 'remote') throw err('invalid_token', 401);
    if (row.banned) throw err('banned', 403);
    db.run('UPDATE users SET username = ?, display_name = ?, pfp = ?, domain = ?, last_login = ? WHERE id = ?', username, dn, pfp, domain, now(), row.id);
    if (row.username !== username || row.display_name !== dn || (row.pfp || null) !== pfp) auth.identityChanged(auth.userById(row.id), row.username);
    return auth.userById(row.id);
  }
  const r = db.run("INSERT INTO users (principal, kind, username, display_name, pfp, domain, created_at, last_login) VALUES (?, 'remote', ?, ?, ?, ?, ?, ?)", principal, username, dn, pfp, domain, now(), now());
  return auth.userById(r.lastInsertRowid);
}

// POST /api/v2/auth/remote { token } -> { access_token, refresh_token, expires_in, token_type, account }
async function accept(token) {
  const v = await verify(token);
  limits.hit(v.domain, 'exchanges');
  const user = upsertUser(v.claims, v.domain);
  return require('../oauth').issueTokens(user, 'ember').body;
}

module.exports = { TYP, TOKEN_TTL, issue, accept, verify, acceptMode, domainAllowed, domainOf, sessionAllowed, _test: { issueLimit } };
