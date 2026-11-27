'use strict';
// Outside ways to sign in (PROTOCOL §4a): OpenID Connect (also the Nookara preset) and plain OAuth 2.0 with a userinfo address.
// start() sends the browser to the provider with state + nonce + PKCE kept here for ten minutes; finish() takes the provider's
// answer, swaps the code for tokens and reads who it is. An OpenID Connect id_token is checked in full: signature against the
// provider's keys, iss, aud, nonce, exp. Nothing here decides which account that is (login.js does).
const crypto = require('crypto');
const config = require('./config');
const AS = require('./account-settings');
const safe = require('./safe-http');
const { err, b64url, fromB64url, now } = require('./util');

const STATE_TTL = 10 * 60 * 1000;
const SKEW_S = 60;
const strip = s => String(s || '').replace(/\/+$/, '');
const callbackUrl = id => `${config.publicUrl()}/login/callback/${encodeURIComponent(id)}`;

// ---------- settings ----------
// the enabled method with this id, with its kind's presets filled in (or null)
function method(id, { any = false } = {}) {
  const cfg = config.get();
  const m = cfg.accounts.login_methods.find(x => x.id === id && (any || x.enabled));
  return m ? AS.resolve(m, cfg) : null;
}

// <issuer>/.well-known/openid-configuration -> the endpoints. Throws invalid_issuer
async function discover(issuer, id) {
  const bad = why => err('invalid_issuer', 400, { method: id, message: why });
  let r;
  try { r = await safe.request('GET', `${strip(issuer)}/.well-known/openid-configuration`); } catch (e) { throw bad(e.code === 'EPRIVATE' ? 'private_address' : 'unreachable'); }
  const doc = r.status === 200 ? r.json() : null;
  if (!doc || typeof doc !== 'object') throw bad('no_discovery_document');
  if (strip(doc.issuer) !== strip(issuer)) throw bad('issuer_mismatch');
  const url = k => AS.cleanUrl(doc[k], safe.local());
  const out = { authorize_url: url('authorization_endpoint'), token_url: url('token_endpoint'), jwks_url: url('jwks_uri'), userinfo_url: doc.userinfo_endpoint ? url('userinfo_endpoint') : null };
  if (!out.authorize_url || !out.token_url || !out.jwks_url) throw bad('incomplete_discovery_document');
  const ways = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : ['client_secret_basic'];
  out.token_auth = ways.includes('client_secret_basic') ? 'basic' : 'post';
  if (!out.userinfo_url) delete out.userinfo_url;
  out.discovered_for = strip(issuer);
  return out;
}

// the login_methods of a settings PATCH, ready to store: an OpenID Connect method gets its endpoints from its issuer's
// discovery document (kept from the stored method while the issuer is the same). A method that is switched off may be
// saved while its issuer does not answer; it is looked up again when it is switched on or first used.
async function prepare(list, stored, cfg) {
  const out = [];
  for (const m of list) {
    if (m.kind !== 'oidc' && m.kind !== 'nookara') { out.push(m); continue; }
    const r = AS.resolve(m, cfg), old = stored.find(x => x.id === m.id && x.kind === m.kind);
    const next = { ...m };
    for (const k of ['authorize_url', 'token_url', 'userinfo_url', 'jwks_url', 'discovered_for']) delete next[k]; // never taken from the request
    if (old && old.discovered_for === strip(r.issuer) && old.authorize_url) {
      for (const k of ['authorize_url', 'token_url', 'userinfo_url', 'jwks_url', 'discovered_for']) if (old[k]) next[k] = old[k];
      if (!next.token_auth && old.token_auth) next.token_auth = old.token_auth;
    } else {
      try { const d = await discover(r.issuer, m.id); Object.assign(next, { ...d, token_auth: m.token_auth || d.token_auth }); }
      catch (e) { if (m.enabled) throw e; }
    }
    out.push(next);
  }
  return out;
}
// a method about to be used: endpoints looked up now if they are missing (a hand-edited config.json, a changed nookara_url)
async function ready(m) {
  if (!m.oidc || (m.authorize_url && m.discovered_for === strip(m.issuer))) return m;
  const d = await discover(m.issuer, m.id);
  const cur = config.saved();
  config.update({ accounts: { login_methods: cur.login_methods.map(x => (x.id === m.id ? { ...x, ...d, token_auth: x.token_auth || d.token_auth } : x)) } });
  return method(m.id, { any: true });
}

// ---------- the round trip ----------
const states = new Map(); // state -> { method_id, nonce, verifier, exp, ...ctx }
function start(m, ctx) {
  const t = now();
  if (states.size > 2000) for (const [k, v] of states) if (v.exp < t) states.delete(k);
  const state = b64url(crypto.randomBytes(24)), nonce = b64url(crypto.randomBytes(24)), verifier = b64url(crypto.randomBytes(32));
  states.set(state, { ...ctx, method_id: m.id, nonce, verifier, exp: t + STATE_TTL });
  const u = new URL(m.authorize_url);
  const q = { response_type: 'code', client_id: m.client_id || '', redirect_uri: callbackUrl(m.id), state, scope: m.scopes || '' };
  if (m.oidc) q.nonce = nonce;
  if (m.pkce !== false) { q.code_challenge = b64url(crypto.createHash('sha256').update(verifier).digest()); q.code_challenge_method = 'S256'; }
  if (ctx.authz?.prompt === 'login') q.prompt = 'login'; // the client asked for a fresh sign-in (adding another account): the provider may not reuse its own session
  for (const [k, v] of Object.entries(q)) if (v) u.searchParams.set(k, v);
  return u.href;
}
// the state of a callback, once: -> the context given to start() (or null)
function take(state, methodId) {
  const s = typeof state === 'string' ? states.get(state) : null;
  if (!s) return null;
  states.delete(state);
  return s.exp >= now() && s.method_id === methodId ? s : null;
}

const fail = (code, why) => Object.assign(new Error(code), { login: code, why });
const pick = (o, path) => { if (!o || !path) return undefined; if (o[path] !== undefined) return o[path]; return path.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o); };

async function exchange(m, code, s) {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl(m.id) });
  if (m.pkce !== false) form.set('code_verifier', s.verifier);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (m.client_secret && (m.token_auth || (m.oidc ? 'basic' : 'post')) === 'basic') headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(m.client_id || '')}:${encodeURIComponent(m.client_secret)}`).toString('base64');
  else { form.set('client_id', m.client_id || ''); if (m.client_secret) form.set('client_secret', m.client_secret); }
  let r;
  try { r = await safe.request('POST', m.token_url, { headers, body: form.toString() }); } catch (e) { throw fail('provider_unreachable', e.message); }
  const doc = r.json();
  if (r.status !== 200 || !doc || typeof doc !== 'object') throw fail('provider_refused', `token endpoint ${r.status}`);
  return doc;
}
async function userinfo(m, accessToken) {
  let r;
  try { r = await safe.request('GET', m.userinfo_url, { headers: { Authorization: `Bearer ${accessToken}` } }); } catch (e) { throw fail('provider_unreachable', e.message); }
  const doc = r.json();
  if (r.status !== 200 || !doc || typeof doc !== 'object') throw fail('provider_refused', `userinfo ${r.status}`);
  return doc;
}

// ---------- id_token ----------
const jwksCache = new Map(); // jwks_url -> { at, forced, keys: [jwk] }
async function loadKeys(url) {
  const r = await safe.request('GET', url);
  const doc = r.status === 200 ? r.json() : null;
  if (!doc || !Array.isArray(doc.keys)) throw new Error('jwks ' + r.status);
  const e = { at: Date.now(), forced: jwksCache.get(url)?.forced || 0, keys: doc.keys.filter(k => k && typeof k === 'object' && k.use !== 'enc') };
  jwksCache.set(url, e);
  return e;
}
const ALGS = {
  RS256: ['rsa', 'sha256'], RS384: ['rsa', 'sha384'], RS512: ['rsa', 'sha512'],
  PS256: ['pss', 'sha256'], PS384: ['pss', 'sha384'], PS512: ['pss', 'sha512'],
  ES256: ['ec', 'sha256'], ES384: ['ec', 'sha384'], ES512: ['ec', 'sha512'], EdDSA: ['ed', null],
};
const KTY = { rsa: 'RSA', pss: 'RSA', ec: 'EC', ed: 'OKP' };
function checkSig(alg, jwk, data, sig) {
  const [family, hash] = ALGS[alg];
  let key; try { key = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { return false; }
  try {
    if (family === 'rsa') return crypto.verify(hash, data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
    if (family === 'pss') return crypto.verify(hash, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, sig);
    if (family === 'ec') return crypto.verify(hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    return key.asymmetricKeyType === 'ed25519' && crypto.verify(null, data, key, sig);
  } catch { return false; }
}
// signature (the provider's published keys; never "none", never a shared-secret algorithm), iss, aud, nonce, exp -> claims
async function verifyIdToken(token, m, nonce) {
  const bad = why => fail('invalid_id_token', why);
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || token.length > 16384) throw bad('malformed');
  let header, claims;
  try { header = JSON.parse(fromB64url(parts[0]).toString()); claims = JSON.parse(fromB64url(parts[1]).toString()); } catch { throw bad('malformed'); }
  if (!header || !ALGS[header.alg] || !claims || typeof claims !== 'object') throw bad('algorithm');
  const kty = KTY[ALGS[header.alg][0]];
  const find = e => e.keys.filter(k => k.kty === kty && (header.kid === undefined || k.kid === header.kid) && (!k.alg || k.alg === header.alg));
  let entry = jwksCache.get(m.jwks_url), keys;
  try {
    if (!entry || Date.now() - entry.at > 10 * 60 * 1000) entry = await loadKeys(m.jwks_url);
    keys = find(entry);
    if (!keys.length && Date.now() - entry.forced > 5000) { entry = await loadKeys(m.jwks_url); entry.forced = Date.now(); keys = find(entry); } // a rotated key: look once more
  } catch (e) { throw fail('provider_unreachable', e.message); }
  const data = Buffer.from(parts[0] + '.' + parts[1]), sig = fromB64url(parts[2]);
  if (!keys.some(k => checkSig(header.alg, k, data, sig))) throw bad('signature');
  if (typeof claims.iss !== 'string' || strip(claims.iss) !== strip(m.issuer)) throw bad('iss');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!m.client_id || !aud.includes(m.client_id) || (aud.length > 1 && claims.azp !== m.client_id) || (claims.azp !== undefined && claims.azp !== m.client_id)) throw bad('aud');
  if (typeof claims.nonce !== 'string' || claims.nonce !== nonce) throw bad('nonce');
  const t = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp + SKEW_S < t) throw bad('exp');
  if (Number.isFinite(claims.iat) && claims.iat - SKEW_S > t) throw bad('iat');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw bad('sub');
  return claims;
}

// ---------- who signed in ----------
// the provider's answer (code) -> { subject, username, name, email, email_verified, picture }
async function identify(m, code, s) {
  const tok = await exchange(m, code, s);
  let info, subject;
  if (m.oidc) {
    info = await verifyIdToken(tok.id_token, m, s.nonce);
    subject = info.sub;
    // the name may only be in userinfo; it counts when it is about the same subject
    if (pick(info, m.username_field || 'preferred_username') === undefined && m.userinfo_url && typeof tok.access_token === 'string') {
      try { const more = await userinfo(m, tok.access_token); if (more.sub === info.sub) info = { ...more, ...info }; } catch { /* the id_token is enough */ }
    }
  } else {
    if (typeof tok.access_token !== 'string' || !tok.access_token) throw fail('provider_refused', 'no access_token');
    info = await userinfo(m, tok.access_token);
    const v = pick(info, m.id_field || 'id') ?? (m.id_field ? undefined : info.sub);
    if ((typeof v !== 'string' && typeof v !== 'number') || String(v) === '' || String(v).length > 255) throw fail('provider_refused', 'no user id');
    subject = String(v);
  }
  const first = (...keys) => { for (const k of keys) { const v = pick(info, k); if (typeof v === 'string' && v.trim()) return v.trim(); } return null; };
  const email = first(m.email_field || 'email');
  const verified = pick(info, m.email_verified_field || 'email_verified');
  return {
    subject,
    username: m.username_field ? first(m.username_field) : first('preferred_username', 'username', 'login', 'nickname', 'name') || (email ? email.split('@')[0] : null),
    name: first('name', 'display_name', 'global_name'),
    email: email && email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email.toLowerCase() : null,
    email_verified: verified === true || verified === 'true',
    picture: /^https?:\/\/[^\s"'<>]{1,500}$/.test(first('picture') || '') ? first('picture') : null,
  };
}

module.exports = { method, callbackUrl, discover, prepare, ready, start, take, identify, verifyIdToken, _test: { states, jwksCache } };
