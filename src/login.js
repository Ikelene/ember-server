'use strict';
// Homeserver accounts and login (PROTOCOL §4a): the /login page (the authorize endpoint), outside logins and the accounts
// they are linked to, the token endpoint, and the admin's accounts settings.
const crypto = require('crypto');
const { wireMode } = require('./compat');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const managed = require('./managed');
const AS = require('./account-settings');
const O = require('./oauth');
const P = require('./login-providers');
const page = require('./login-page');
const safe = require('./safe-http');
const { err, b64url, safeEqual, limiter, now, log } = require('./util');

const TEN_MIN = 10 * 60 * 1000;
const tokenLimit = limiter(120, 60 * 1000);
const startLimit = limiter(60, 600 * 1000);

// ---------- csrf: a token in a cookie and in every form (double submit) ----------
const COOKIE = 'ember_csrf';
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => { const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()]; }));
function csrf(req) {
  const have = cookies(req)[COOKIE];
  if (have && /^[A-Za-z0-9_-]{43}$/.test(have)) return { token: have, set: [] };
  const token = b64url(crypto.randomBytes(32));
  return { token, set: [`${COOKIE}=${token}; Path=/login; HttpOnly; SameSite=Lax; Max-Age=3600${config.publicUrl().startsWith('https:') ? '; Secure' : ''}`] };
}
const csrfOk = (req, sent) => { const have = cookies(req)[COOKIE]; return !!have && typeof sent === 'string' && sent.length > 0 && safeEqual(have, sent); };

// ---------- small stores (ten minutes, used once) ----------
function store() {
  const m = new Map();
  return {
    put(v) { const t = now(); if (m.size > 2000) for (const [k, x] of m) if (x.exp < t) m.delete(k); const id = b64url(crypto.randomBytes(32)); m.set(id, { v, exp: t + TEN_MIN }); return id; },
    peek(id) { const x = typeof id === 'string' ? m.get(id) : null; return x && x.exp >= now() ? x.v : null; },
    take(id) { const v = this.peek(id); if (typeof id === 'string') m.delete(id); return v; },
  };
}
const pending = store(); // an outside login nobody here is linked to yet: { method_id, identity }
const tickets = store(); // a signed-in account about to link a login: { user_id, method_id, return_to }

// ---------- links ----------
const linkOf = (methodId, subject) => db.get('SELECT * FROM login_links WHERE method_id = ? AND subject = ?', methodId, subject);
function addLink(userId, methodId, idn) {
  db.run('INSERT INTO login_links (user_id, method_id, subject, email, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?)', userId, methodId, idn.subject, idn.email, idn.email_verified ? 1 : 0, now());
}
// a username this homeserver can take, out of whatever the provider calls the person
async function uniqueUsername(wanted) {
  let base = String(wanted || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 28);
  if (base.length < 2) base = 'user';
  const taken = n => !!db.get("SELECT 1 FROM users WHERE kind IN ('local', 'bot') AND username_lc = ?", n);
  if (!taken(base)) return base;
  for (let i = 2; i < 50; i++) if (!taken(base + i)) return base + i;
  return base + crypto.randomBytes(2).toString('hex');
}

// ---------- pages ----------
const enabledMethods = () => config.get().accounts.login_methods.filter(m => m.enabled).map(m => ({ id: m.id, kind: m.kind, name: m.name }));
function showLogin(req, res, a, extra = {}, status = 200) {
  const c = csrf(req);
  const body = page.loginPage({ authz: a.authz, csrf: c.token, methods: enabledMethods(), canRegister: auth.registrationOpen(), to: a.redirect.origin, view: 'login', ...extra });
  page.send(res, status, body, { cookies: c.set, formTo: a.redirect.origin });
}
const showError = (res, status, title, text, links) => page.send(res, status, page.messagePage({ title, text, bad: true, links }));
// the authorization request of this page load / form post, or the answer already sent (null)
function request(req, res, src) {
  const a = O.parseAuthz(src || {});
  if (a.ok && config.mode() !== 'local') { showError(res, 404, 'No accounts here', 'This homeserver does not host accounts. Sign in where your account lives.'); return null; }
  if (a.ok) return a;
  if (a.redirect) page.redirect(res, O.redirectWith(a.redirect, { error: a.error, error_description: a.description, state: a.state }));
  else showError(res, 400, 'This sign-in link is not valid', a.description);
  return null;
}
// signed in: back to the client with a one-time code
function finish(res, user, a) {
  db.run('UPDATE users SET last_login = ? WHERE id = ?', now(), user.id);
  page.redirect(res, O.redirectWith(a.redirect, { code: O.issueCode(user, a.authz), state: a.authz.state }));
}

async function postLogin(req, res) {
  const b = req.body || {}, a = request(req, res, b);
  if (!a) return;
  const again = (code, status, extra = {}) => showLogin(req, res, a, { error: code, username: typeof b.username === 'string' ? b.username.slice(0, 64) : '', link: pending.peek(b.link) ? b.link : null, ...extra }, status);
  if (!csrfOk(req, b.csrf)) return again('csrf', 403);
  const register = b.action === 'register';
  if (!auth.passwordMethod()) return again('password_login_disabled', 403);
  let user;
  try {
    if (register) {
      if (!auth.limits.register.hit(req.ip)) throw err('rate_limited', 429);
      if (!auth.registrationOpen()) throw err('registration_closed', 403);
      if (b.password !== b.password2) throw err('password_mismatch', 400);
      user = auth.userById(await auth.createLocalUser(b.username, b.password));
    } else {
      if (!auth.limits.login.hit(req.ip)) throw err('rate_limited', 429);
      user = await auth.checkLocal(b.username, b.password);
    }
  } catch (e) {
    if (!e.code) throw e;
    return again(e.code, e.status || 400, register ? { view: 'register' } : {});
  }
  // signed in with a password to link the outside login that had no account
  const p = register ? null : pending.take(b.link);
  if (p && !linkOf(p.method_id, p.identity.subject)) addLink(user.id, p.method_id, p.identity);
  finish(res, user, a);
}

async function startMethod(req, res) {
  if (!startLimit.hit(req.ip)) return showError(res, 429, 'Too many tries', page.message('rate_limited'));
  const id = req.params.id;
  let ctx, a = null;
  if (req.query.link) {
    const t = tickets.take(req.query.link);
    if (!t || t.method_id !== id) return showError(res, 400, 'This link has expired', 'Start linking again from your account settings.');
    ctx = { link_user: t.user_id, return_to: t.return_to };
  } else {
    a = request(req, res, req.query);
    if (!a) return;
    ctx = { authz: a.authz };
  }
  const oops = code => (a ? showLogin(req, res, a, { error: code }, 400) : showError(res, 400, 'Linking did not work', page.message(code)));
  let m = P.method(id);
  if (!m || m.kind === 'password' || config.mode() !== 'local') return oops('unknown_method');
  try { m = await P.ready(m); } catch (e) { log(`[login] ${id}: ${e.extra?.message || e.message}`); return oops('provider_failed'); }
  page.redirect(res, P.start(m, ctx));
}

function linkDone(res, s, error) {
  if (s.return_to) { const [base, frag = ''] = s.return_to.split('#'); return page.redirect(res, `${base}${base.includes('?') ? '&' : '?'}${error ? 'link_error=' + encodeURIComponent(error) : 'linked=' + encodeURIComponent(s.method_id)}${frag ? '#' + frag : ''}`); }
  if (error) return showError(res, 400, 'Linking did not work', page.message(error));
  return page.send(res, 200, page.messagePage({ title: 'Login linked', text: 'You can now sign in this way. You can close this page.' }));
}

async function callback(req, res) {
  const id = req.params.id, q = req.query;
  const s = P.take(q.state, id);
  if (!s) return showError(res, 400, 'This sign-in has expired', 'It was not started here, or it took too long. Go back to the app and sign in again.');
  const a = s.authz ? O.parseAuthz(s.authz) : null;
  if (a && !a.ok) return showError(res, 400, 'This sign-in link is not valid', a.description);
  const oops = (code, status = 400) => (a ? showLogin(req, res, a, { error: code }, status) : linkDone(res, s, code));
  if (q.error || !q.code) return oops(q.error === 'access_denied' ? 'provider_denied' : 'provider_failed');
  const m = P.method(id);
  if (!m || config.mode() !== 'local') return oops('unknown_method');
  let idn;
  try { idn = await P.identify(m, String(q.code), s); }
  catch (e) { if (!e.login) throw e; log(`[login] ${id}: ${e.login} (${e.why})`); return oops('provider_failed'); }
  const link = linkOf(id, idn.subject);

  if (s.link_user) { // a signed-in account adding this login
    const u = auth.userById(s.link_user);
    if (!u || (link && link.user_id !== u.id)) return linkDone(res, s, 'login_already_linked');
    if (!link) addLink(u.id, id, idn);
    return linkDone(res, s, null);
  }

  let user = link ? auth.userById(link.user_id) : null;
  if (link && idn.email) db.run('UPDATE login_links SET email = ?, email_verified = ? WHERE method_id = ? AND subject = ?', idn.email, idn.email_verified ? 1 : 0, id, idn.subject);
  // the same verified email as another login of exactly one account: only when the admin switched that on, and only when
  // this provider says the address is verified too. An email alone never opens an account.
  if (!user && config.get().accounts.link_verified_emails && idn.email && idn.email_verified) {
    const owners = db.all('SELECT DISTINCT user_id FROM login_links WHERE email = ? AND email_verified = 1', idn.email);
    if (owners.length === 1) { user = auth.userById(owners[0].user_id); if (user) addLink(user.id, id, idn); }
  }
  if (!user && auth.registrationOpen()) {
    user = auth.userById(await auth.createLocalUser(await uniqueUsername(idn.username), null, { noPassword: true, displayName: idn.name }));
    addLink(user.id, id, idn);
  }
  if (!user) {
    const links = [];
    if (auth.passwordMethod()) links.push({ href: `/login?${new URLSearchParams({ ...a.authz, link: pending.put({ method_id: id, identity: idn }) })}`, label: 'Sign in with your password to link it' });
    links.push({ href: `/login?${new URLSearchParams(a.authz)}`, label: 'Back' });
    return showError(res, 403, 'No account found', page.message('not_linked'), links);
  }
  if (user.banned || user.kind !== 'local') return oops('banned', 403);
  finish(res, user, a);
}

// ---------- a signed-in account's logins ----------
function logins(u) {
  const links = db.all('SELECT * FROM login_links WHERE user_id = ?', u.id);
  return {
    logins: config.get().accounts.login_methods.map(m => {
      const l = links.find(x => x.method_id === m.id);
      const linked = m.kind === 'password' ? !!u.password_hash : !!l;
      return { id: m.id, kind: m.kind, name: m.name, enabled: m.enabled, linked, ...(l ? { email: l.email, created_at: l.created_at } : {}) };
    }),
  };
}
function unlink(u, id) {
  const methods = config.get().accounts.login_methods, on = mid => methods.some(m => m.id === mid && m.enabled);
  const m = methods.find(x => x.id === id);
  if (m?.kind === 'password') throw err('cannot_remove_password', 400);
  const links = db.all('SELECT * FROM login_links WHERE user_id = ?', u.id);
  if (!links.some(l => l.method_id === id)) throw err('not_linked', 404);
  // what would still let them in afterwards: a password (while password sign-in is on) or a login whose method is on
  const left = (u.password_hash && auth.passwordMethod() ? 1 : 0) + links.filter(l => l.method_id !== id && on(l.method_id)).length;
  if (left < 1) throw err('last_login_method', 409);
  db.run('DELETE FROM login_links WHERE user_id = ? AND method_id = ?', u.id, id);
  return logins(u);
}
function linkTicket(u, id, returnTo) {
  const m = P.method(id);
  if (!m || m.kind === 'password' || u.kind !== 'local') throw err('unknown_method', 404);
  let back = null;
  if (returnTo !== undefined && returnTo !== null && returnTo !== '') {
    let x; try { x = new URL(String(returnTo)); } catch { throw err('invalid_return_to'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname);
    if (x.username || x.password || String(returnTo).length > 2000 || (x.protocol !== 'https:' && !(x.protocol === 'http:' && loopback)) || !config.get().ember_clients.includes(x.origin)) throw err('invalid_return_to');
    back = String(returnTo);
  }
  return { url: `${config.publicUrl()}/login/start/${encodeURIComponent(id)}?link=${tickets.put({ user_id: u.id, method_id: id, return_to: back })}` };
}

// ---------- admin: the accounts settings ----------
function adminView() {
  const cfg = config.get(), a = managed.active() ? cfg.accounts : config.saved();
  return {
    domain: cfg.domain, hosts_accounts: a.hosts_accounts, registration: a.registration, remote_accounts: a.remote_accounts, link_verified_emails: a.link_verified_emails,
    ember_clients: cfg.ember_clients,
    login_methods: a.login_methods.map(m => {
      const r = AS.resolve(m, cfg), { oidc, discovered_for, ...out } = r;
      if (m.kind === 'password') return out;
      return { ...out, client_secret: AS.mask(m.client_secret), callback_url: P.callbackUrl(m.id) };
    }),
    // the older setting these stand for; switching between hosting accounts and not needs a restart
    accounts_mode: wireMode(AS.modeOf(a)), running_accounts_mode: wireMode(config.mode()), restart_required: AS.modeOf(a) !== config.mode(),
  };
}
async function adminPatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const part = {};
  for (const k of ['hosts_accounts', 'registration', 'remote_accounts', 'link_verified_emails', 'login_methods']) if (b[k] !== undefined) part[k] = b[k];
  if (managed.active() && part.hosts_accounts === true) throw err('managed_setting', 403, { setting: 'accounts_mode' });
  const clean = AS.sanitize(part, { allowHttp: safe.local() });
  if (clean.hosts_accounts === true && !config.saved().hosts_accounts && !auth.localAdmins().length) throw err('local_admin_required', 409);
  if (clean.login_methods) clean.login_methods = await P.prepare(clean.login_methods, config.saved().login_methods, config.get());
  config.update({ accounts: clean, ...(b.ember_clients !== undefined ? { ember_clients: b.ember_clients } : {}) });
  return adminView();
}

// what discovery says (routes/instance.js)
function discovery() {
  const cfg = config.get(), hosts = config.mode() === 'local';
  return {
    accounts: { hosts_accounts: hosts, registration: hosts ? (auth.registrationOpen() ? 'open' : cfg.accounts.registration) : 'closed', remote_accounts: { mode: cfg.accounts.remote_accounts.mode } },
    ...(hosts ? { login: { authorize_url: `${cfg.public_url}/login`, token_url: `${cfg.public_url}/api/v2/auth/token`, revoke_url: `${cfg.public_url}/api/v2/auth/revoke`, methods: enabledMethods() } } : {}),
  };
}

function register(app) {
  const clientOrigin = origin => config.get().ember_clients.includes(origin);
  app.cors('/api/v2/auth', clientOrigin);
  app.cors('/login', () => false);

  app.get('/login', { auth: false }, (req, res) => {
    const a = request(req, res, req.query);
    if (!a) return;
    const link = pending.peek(req.query.link) ? req.query.link : null;
    showLogin(req, res, a, { view: req.query.view === 'register' ? 'register' : 'login', link });
  });
  app.post('/login', { auth: false, form: true }, postLogin);
  // "Cancel" on the page: the client hears access_denied
  app.get('/login/cancel', { auth: false }, (req, res) => {
    const a = request(req, res, req.query);
    if (a) page.redirect(res, O.redirectWith(a.redirect, { error: 'access_denied', error_description: 'The sign-in was cancelled.', state: a.authz.state }));
  });
  app.get('/login/start/:id', { auth: false }, startMethod);
  app.get('/login/callback/:id', { auth: false }, callback);
  app.post('/login/link/:id', req => linkTicket(req.user, req.params.id, req.body?.return_to));

  app.post('/api/v2/auth/token', { auth: false, form: true }, req => {
    if (!tokenLimit.hit(req.ip)) throw err('rate_limited', 429, { error_description: 'Too many requests.' });
    return O.token(req.body);
  });
  app.post('/api/v2/auth/revoke', { auth: false, form: true }, req => { O.revoke(req.body?.token); return { ok: true }; });

  app.get('/api/v2/account/logins', req => logins(req.user));
  app.delete('/api/v2/account/logins/:id', req => unlink(req.user, req.params.id));

  app.get('/api/v2/homeserver/accounts', { admin: true }, () => adminView());
  app.patch('/api/v2/homeserver/accounts', { admin: true }, req => adminPatch(req.body));
}

module.exports = { register, discovery, adminView, _test: { pending, tickets } };
