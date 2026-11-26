'use strict';
// The `accounts` block of config.json (PROTOCOL §4a): whether this homeserver hosts accounts, who may register, which remote
// homeservers' accounts are let in, and the ways to sign in. Pure functions: config.js stores the block, routes/login.js edits it.
// The older `accounts_mode` ("local" / "nookara") is derived from it and still read from a config.json that has no block yet.
const { err } = require('./util');

const REGISTRATION = ['open', 'closed', 'invite', 'approval'];
const REMOTE_MODES = ['none', 'all', 'allowlist', 'blocklist'];
const KINDS = ['password', 'oidc', 'oauth2', 'nookara'];
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const FIELD = /^[A-Za-z0-9_.:\/-]{1,100}$/; // a claim / userinfo field name (dots walk into objects)
const URL_FIELDS = ['issuer', 'authorize_url', 'token_url', 'userinfo_url', 'jwks_url'];
const DEFAULT_CLIENTS = ['https://nookara.cc', 'https://canopy.ikelene.net', 'https://ember.nookara.cc'];

const passwordMethod = () => ({ id: 'password', kind: 'password', name: 'Password', enabled: true });
const defaults = () => ({ hosts_accounts: true, registration: 'open', remote_accounts: { mode: 'none', list: [] }, link_verified_emails: false, login_methods: [passwordMethod()] });
const hostOf = url => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };

// the block an older config.json (accounts_mode + registration) stands for
function migrate({ accounts_mode, registration, nookara_url }) {
  if (accounts_mode === 'nookara') {
    const h = hostOf(nookara_url);
    return { ...defaults(), hosts_accounts: false, registration: registration === 'closed' ? 'closed' : 'open', remote_accounts: { mode: 'allowlist', list: h ? [h] : [] }, login_methods: [] };
  }
  return { ...defaults(), registration: registration === 'closed' ? 'closed' : 'open' };
}

// the block after the old accounts_mode setting is switched (settings PATCH, EMBER_ACCOUNTS_MODE, managed hosting)
function withMode(a, mode, nookaraUrl) {
  if (mode === 'nookara') {
    const h = hostOf(nookaraUrl);
    return { ...a, hosts_accounts: false, remote_accounts: a.remote_accounts.mode === 'none' ? { mode: 'allowlist', list: h ? [h] : [] } : a.remote_accounts };
  }
  const methods = a.login_methods.some(m => m.enabled) ? a.login_methods : a.login_methods.some(m => m.kind === 'password')
    ? a.login_methods.map(m => (m.kind === 'password' ? { ...m, enabled: true } : m)) : [passwordMethod(), ...a.login_methods];
  return { ...a, hosts_accounts: true, login_methods: methods };
}
const modeOf = a => (a.hosts_accounts ? 'local' : 'nookara');
// what old clients read as `registration`
const legacyRegistration = a => (a.registration === 'open' ? 'open' : 'closed');

// http(s) url without credentials, as typed (https only unless dev). null when it is not one
function cleanUrl(raw, allowHttp) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 500 || /\s/.test(raw.trim())) return null;
  let u; try { u = new URL(raw.trim()); } catch { return null; }
  if (u.username || u.password || u.hash) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowHttp)) return null;
  return u.href;
}

// one login method. loose: a bad value drops the method (hand-edited file) instead of throwing
function sanitizeMethod(m, { loose, allowHttp }) {
  const bad = (code, extra) => { throw err(code, 400, extra); };
  if (!m || typeof m !== 'object' || Array.isArray(m)) bad('invalid_login_methods');
  if (!KINDS.includes(m.kind)) bad('invalid_login_methods', { field: 'kind' });
  const id = typeof m.id === 'string' ? m.id.trim().toLowerCase() : '';
  if (!ID.test(id)) bad('invalid_login_methods', { field: 'id' });
  const name = typeof m.name === 'string' ? m.name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  const out = { id, kind: m.kind, name: name || { password: 'Password', nookara: 'Nookara', oidc: 'Single sign-on', oauth2: 'Single sign-on' }[m.kind], enabled: m.enabled !== false };
  if (m.kind === 'password') return out;
  for (const k of ['client_id', 'client_secret']) if (m[k] !== undefined && m[k] !== null) { if (typeof m[k] === 'string' && m[k].length <= 500) out[k] = m[k].trim(); else bad('invalid_login_methods', { method: id, field: k }); }
  for (const k of URL_FIELDS) {
    if (m[k] === undefined || m[k] === null || m[k] === '') continue;
    if (k === 'issuer' && m.kind !== 'oidc') continue; // nookara: the issuer is nookara_url; oauth2 has none
    const u = cleanUrl(m[k], allowHttp || loose);
    if (!u) bad('invalid_method_url', { method: id, field: k });
    out[k] = k === 'issuer' ? u.replace(/\/+$/, '') : u;
  }
  if (typeof m.discovered_for === 'string' && m.discovered_for.length <= 500) out.discovered_for = m.discovered_for;
  if (m.kind === 'nookara') out.scopes = 'openid profile';
  else if (m.scopes !== undefined && m.scopes !== null && m.scopes !== '') {
    const s = Array.isArray(m.scopes) ? m.scopes.join(' ') : m.scopes;
    if (typeof s !== 'string' || s.length > 300 || !/^[\x21\x23-\x5b\x5d-\x7e ]+$/.test(s)) bad('invalid_login_methods', { method: id, field: 'scopes' });
    out.scopes = s.trim().split(/\s+/).join(' ');
  }
  for (const k of ['id_field', 'username_field', 'email_field', 'email_verified_field']) if (m[k] !== undefined && m[k] !== null && m[k] !== '') { if (typeof m[k] === 'string' && FIELD.test(m[k])) out[k] = m[k]; else bad('invalid_login_methods', { method: id, field: k }); }
  if (m.token_auth !== undefined && m.token_auth !== null) { if (['basic', 'post'].includes(m.token_auth)) out.token_auth = m.token_auth; else bad('invalid_login_methods', { method: id, field: 'token_auth' }); }
  if (m.pkce === false) out.pkce = false;
  if (!loose) {
    if (m.kind === 'oidc' && !out.issuer) bad('invalid_method_url', { method: id, field: 'issuer' });
    if (m.kind === 'oauth2') for (const k of ['authorize_url', 'token_url', 'userinfo_url']) if (!out[k]) bad('invalid_method_url', { method: id, field: k });
  }
  return out;
}

// validate a (partial) accounts block. loose = drop what is wrong quietly (hand-edited file)
function sanitize(p, { loose = false, allowHttp = false } = {}) {
  const out = {};
  const bad = (code, extra) => { if (!loose) throw err(code, 400, extra); };
  if (!p || typeof p !== 'object' || Array.isArray(p)) { bad('invalid_accounts'); return out; }
  if (p.hosts_accounts !== undefined) { if (typeof p.hosts_accounts === 'boolean') out.hosts_accounts = p.hosts_accounts; else bad('invalid_hosts_accounts'); }
  if (p.registration !== undefined) { if (REGISTRATION.includes(p.registration)) out.registration = p.registration; else bad('invalid_registration'); }
  if (p.link_verified_emails !== undefined) { if (typeof p.link_verified_emails === 'boolean') out.link_verified_emails = p.link_verified_emails; else bad('invalid_link_verified_emails'); }
  if (p.remote_accounts !== undefined) {
    const r = p.remote_accounts, v = {};
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      if (r.mode !== undefined) { if (REMOTE_MODES.includes(r.mode)) v.mode = r.mode; else bad('invalid_remote_accounts'); }
      if (r.list !== undefined) {
        const list = Array.isArray(r.list) ? r.list.map(x => (typeof x === 'string' ? x.trim().toLowerCase() : '')) : null;
        if (list && list.length <= 1000 && list.every(x => HOST.test(x.replace(/^\*\./, '')))) v.list = [...new Set(list)]; else bad('invalid_remote_accounts');
      }
      out.remote_accounts = v;
    } else bad('invalid_remote_accounts');
  }
  if (p.login_methods !== undefined) {
    if (!Array.isArray(p.login_methods) || p.login_methods.length > 20) bad('invalid_login_methods');
    else {
      const list = [];
      for (const m of p.login_methods) {
        let c; try { c = sanitizeMethod(m, { loose, allowHttp }); } catch (e) { if (loose) continue; throw e; }
        if (list.some(x => x.id === c.id) || (c.kind === 'password' && list.some(x => x.kind === 'password'))) { bad('invalid_login_methods', { method: c.id, field: 'id' }); continue; }
        list.push(c);
      }
      out.login_methods = list;
    }
  }
  return out;
}

// a sanitized partial block over the stored one. A method keeps its stored secret unless a new one is sent
// (an empty one, or the masked one read back from the admin view, means "unchanged").
function merge(cur, patch) {
  const out = { ...cur, ...patch };
  if (patch.remote_accounts) out.remote_accounts = { ...cur.remote_accounts, ...patch.remote_accounts };
  if (patch.login_methods) out.login_methods = patch.login_methods.map(m => {
    const old = cur.login_methods.find(x => x.id === m.id && x.kind === m.kind);
    if (m.kind === 'password') return m;
    const kept = !m.client_secret || isMasked(m.client_secret);
    const next = { ...m };
    if (kept) { if (old?.client_secret) next.client_secret = old.client_secret; else delete next.client_secret; }
    return next;
  });
  return out;
}
// a full block out of whatever config.json holds
const complete = a => { const d = defaults(); return { ...d, ...a, remote_accounts: { ...d.remote_accounts, ...(a.remote_accounts || {}) }, login_methods: a.login_methods || d.login_methods }; };

const mask = t => (t ? `${'*'.repeat(8)}${String(t).slice(-4)}` : null);
const isMasked = t => /^\*{8}.{0,4}$/.test(String(t || ''));

// a method with what its kind implies filled in: the Nookara preset is OpenID Connect against nookara_url
function resolve(m, cfg) {
  if (m.kind === 'nookara') return { ...m, issuer: String(cfg.nookara_url || '').replace(/\/+$/, ''), scopes: 'openid profile', oidc: true };
  if (m.kind === 'oidc') return { ...m, scopes: m.scopes || 'openid profile email', oidc: true };
  return { ...m };
}

// ember_clients: the web origins an Ember client may be served from (login redirect targets, CORS on the token endpoint)
function sanitizeClients(v) {
  if (!Array.isArray(v) || v.length > 100) return null;
  const out = [];
  for (const x of v) {
    let u; try { u = new URL(String(x).trim()); } catch { return null; }
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return null;
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out;
}

module.exports = { REGISTRATION, REMOTE_MODES, KINDS, DEFAULT_CLIENTS, defaults, migrate, withMode, modeOf, legacyRegistration, sanitize, merge, complete, mask, isMasked, resolve, sanitizeClients, cleanUrl, passwordMethod, hostOf };
