'use strict';
// The account page (GET /account, PROTOCOL §4a): plain server-rendered HTML like the sign-in page, no scripts. A person
// signs in through the homeserver's own /login (authorization code + PKCE, with this page as the client) and gets a session
// in an HttpOnly cookie that is only ever sent to /account. Every change is a form post with a CSRF token bound to that
// session, answered with a redirect back to the page.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const O = require('./oauth');
const page = require('./login-page');
const { b64url, safeEqual, now } = require('./util');

const { esc } = page;
const COOKIE = 'ember_account', LOGIN_COOKIE = 'ember_account_login';
const CALLBACK = '/account/auth/callback.html';
const DM_FROM = { friends: 'My friends', anyone: 'Anyone', nobody: 'Nobody' };
// where a Nookara account's DM privacy is kept (config social.api_url's site), for the link on the page
const socialOrigin = () => { try { return new URL(require('./social/where').urls().api_url).origin; } catch { return ''; } };
const NOTES = {
  profile: 'Profile saved.', avatar: 'Picture saved.', avatar_removed: 'Picture removed.', dm: 'DM privacy saved.', session: 'That session was signed out.',
  unlinked: 'That sign-in method was removed.', linked: 'Sign-in method added.',
};
const ERRORS = {
  csrf: 'This page was open for too long. Try again.', display_name_too_long: 'That display name is too long (32 characters at most).', bio_too_long: 'That bio is too long (300 characters at most).',
  pronouns_too_long: 'Those pronouns are too long (40 characters at most).', no_file: 'Choose a picture first.', file_too_large: 'That picture is too big (4 MB at most).',
  images_only: 'That file is not a picture this server can use.', last_login_method: 'That is the only way into this account. Add another one first.',
  login_already_linked: 'That login is already linked to another account.', unknown_method: 'That way to sign in is not available here.', not_linked: 'That sign-in method is not linked.',
  invalid_dm_from: 'Choose one of the options.', session_not_found: 'That session is already gone.',
};

// ---------- cookies and the session ----------
const secure = () => (config.publicUrl().startsWith('https:') ? '; Secure' : '');
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/account; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure()}`;
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => { const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()]; }));
const csrfOf = token => crypto.createHash('sha256').update('ember-account-csrf\n' + token).digest('base64url');
// -> { token, user, family, hash } | null
function session(req) {
  const token = cookies(req)[COOKIE];
  const s = token && /^[A-Za-z0-9_-]{20,200}$/.test(token) ? auth.resolveSession(token) : null;
  return s && auth.hostedHere(s.user) && !s.user.banned ? { token, user: s.user, family: s.family, hash: s.hash } : null;
}
const back = (res, q = '', set = []) => page.redirect(res, '/account' + q, set);

// no session: off to the homeserver's own sign-in page, as an OAuth client whose redirect address is this page
function toLogin(res) {
  const state = b64url(crypto.randomBytes(16)), verifier = b64url(crypto.randomBytes(32));
  const q = new URLSearchParams({ response_type: 'code', client_id: O.CLIENT_ID, redirect_uri: config.publicUrl() + CALLBACK, state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
  page.redirect(res, '/login?' + q, [cookie(LOGIN_COOKIE, `${state}.${verifier}`, 600)]);
}
function callback(req, res) {
  const [state, verifier] = String(cookies(req)[LOGIN_COOKIE] || '').split('.');
  const clear = cookie(LOGIN_COOKIE, '', 0);
  const fail = text => page.send(res, 400, page.messagePage({ title: 'Signing in did not work', text, bad: true, links: [{ href: '/account', label: 'Try again' }] }), { cookies: [clear] });
  if (req.query.error) return fail(req.query.error === 'access_denied' ? 'The sign-in was cancelled.' : 'Something went wrong. Try again.');
  if (!state || !verifier || typeof req.query.state !== 'string' || !safeEqual(state, req.query.state) || typeof req.query.code !== 'string') return fail('This sign-in was not started here, or it took too long.');
  let tokens;
  try { tokens = O.token({ grant_type: 'authorization_code', client_id: O.CLIENT_ID, code: req.query.code, code_verifier: verifier, redirect_uri: config.publicUrl() + CALLBACK }); }
  catch (e) { if (!e.code) throw e; return fail('This sign-in was not started here, or it took too long.'); }
  return back(res, '', [clear, cookie(COOKIE, tokens.access_token, tokens.expires_in)]);
}

// ---------- the sessions of an account ----------
// one entry per sign-in: a refresh family (an Ember client, this page) or a session without one (the older sign-in routes)
function sessionsOf(u, cur) {
  const out = new Map();
  for (const r of db.all('SELECT family, MIN(created_at) AS created_at FROM refresh_tokens WHERE user_id = ? AND used_at IS NULL AND expires_at > ? GROUP BY family', u.id, now())) out.set('f:' + r.family, { key: 'f:' + r.family, created_at: r.created_at, last_used: r.created_at });
  for (const s of db.all('SELECT * FROM sessions WHERE user_id = ?', u.id)) {
    if (s.expires_at && s.expires_at <= now()) continue;
    const key = s.family ? 'f:' + s.family : 's:' + s.hash.slice(0, 24), e = out.get(key) || { key, created_at: s.created_at, last_used: 0 };
    e.created_at = Math.min(e.created_at, s.created_at); e.last_used = Math.max(e.last_used, s.last_used);
    out.set(key, e);
  }
  const mine = cur.family ? 'f:' + cur.family : 's:' + cur.hash.slice(0, 24);
  return [...out.values()].map(e => ({ ...e, current: e.key === mine })).sort((a, b) => b.current - a.current || b.last_used - a.last_used);
}
function endSession(u, key) {
  const k = String(key || '');
  let n = 0;
  if (/^f:[0-9a-f]{8,64}$/.test(k)) n = db.run('DELETE FROM refresh_tokens WHERE user_id = ? AND family = ?', u.id, k.slice(2)).changes + db.run('DELETE FROM sessions WHERE user_id = ? AND family = ?', u.id, k.slice(2)).changes;
  else if (/^s:[0-9a-f]{24}$/.test(k)) n = db.run("DELETE FROM sessions WHERE user_id = ? AND family IS NULL AND hash LIKE ?", u.id, k.slice(2) + '%').changes;
  return n > 0;
}
// every session and refresh token of the account, and its open connections
function endAll(u) {
  db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  db.run('DELETE FROM refresh_tokens WHERE user_id = ?', u.id);
  require('./gateway').closeUsers([u.id], 4001, 'signed_out');
}

// ---------- the page ----------
const when = t => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never');
const CSS = `
.wrap{max-width:560px}
section{margin-top:26px;padding-top:20px;border-top:1px solid var(--border)}
textarea{width:100%;min-height:84px;padding:10px 12px;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--border-2);resize:vertical}
select,input[type=file]{width:100%;padding:9px 10px;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--border-2)}
textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn.small{display:inline-block;width:auto;margin:0;padding:6px 12px;font-size:13px}
.btn.danger{border-color:var(--bad);color:var(--bad)}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:0}
.row form{margin:0;flex:none}
.sub{color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.who{display:flex;align-items:center;gap:14px}
.av{width:64px;height:64px;background:var(--surface-2);display:grid;place-items:center;overflow:hidden;font-size:26px;font-weight:700;color:var(--accent);flex:none}
.av img{width:100%;height:100%;object-fit:cover;display:block}
.inline{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
.inline .btn{margin-top:0;width:auto;flex:1}
`;
function render(s, { note, error } = {}) {
  const u = auth.userById(s.user.id), cfg = config.get(), csrf = esc(csrfOf(s.token));
  const hidden = `<input type="hidden" name="csrf" value="${csrf}">`;
  const profile = require('./account-profile').get(u).profile;
  const settings = require('./communities').getSettings(u);
  const logins = require('./login').logins(u).logins;
  const h = page.head(`Your account on ${cfg.name || 'Ember'}`, CSS);
  const avatar = require('./social/people').absolute(u.pfp);
  // a Nookara account (accounts.nookara_identity): name and picture follow Nookara; DM privacy is Nookara's when its social API is there
  const nookara = u.kind !== 'local', elsewhere = require('./social/where').apiElsewhere(u);
  let body = '';
  if (error) body += `<p class="msg bad" role="alert">${esc(ERRORS[error] || page.message(error))}</p>`;
  else if (note && NOTES[note]) body += `<p class="msg" role="status">${esc(NOTES[note])}</p>`;
  body += `
  <div class="who"><div class="av">${avatar ? `<img src="${esc(avatar)}" alt="">` : esc((Array.from(u.display_name || u.username)[0] || '?').toUpperCase())}</div>
    <div><h2 style="margin:0">${esc(u.display_name || u.username)}</h2><div class="sub">${esc(u.username)}@${esc(cfg.domain)}</div></div></div>

  <section aria-labelledby="h-profile"><h2 id="h-profile">Profile</h2>
  ${nookara ? '<p class="sub">Your name and picture come from your Nookara account and are updated each time you sign in.</p>' : ''}
  <form method="post" action="/account/profile">${hidden}
    ${nookara ? '' : `<label for="dn">Display name</label><input id="dn" type="text" name="display_name" maxlength="32" value="${esc(profile.display_name || '')}" placeholder="${esc(u.username)}">`}
    <label for="pr">Pronouns</label><input id="pr" type="text" name="pronouns" maxlength="40" value="${esc(profile.pronouns || '')}">
    <label for="bio">Bio</label><textarea id="bio" name="bio" maxlength="300">${esc(profile.bio || '')}</textarea>
    <button class="btn primary" type="submit">Save profile</button>
  </form>${nookara ? '' : `
  <form method="post" action="/account/avatar" enctype="multipart/form-data">${hidden}
    <label for="pic">Picture (PNG, JPEG, GIF or WebP, up to 4 MB)</label><input id="pic" type="file" name="file" accept="image/png,image/jpeg,image/gif,image/webp" required>
    <div class="inline"><button class="btn" type="submit">Upload picture</button>${u.pfp ? `<button class="btn" type="submit" formaction="/account/avatar/remove" formenctype="application/x-www-form-urlencoded" formnovalidate>Remove picture</button>` : ''}</div>
  </form>`}</section>
${elsewhere ? `
  <section aria-labelledby="h-dm"><h2 id="h-dm">DM privacy</h2>
  <p class="sub">Who can start a DM with you is kept with your Nookara account.</p>
  <a class="btn" href="${esc(socialOrigin() + '/me#privacy')}" rel="noopener">Change it on Nookara</a></section>` : `
  <section aria-labelledby="h-dm"><h2 id="h-dm">DM privacy</h2>
  <form method="post" action="/account/dm-privacy">${hidden}
    <label for="dmf">Who can start a DM with you</label>
    <select id="dmf" name="dm_from">${Object.entries(DM_FROM).map(([k, v]) => `<option value="${k}"${settings.dm_from === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
    <button class="btn" type="submit">Save</button>
  </form></section>`}

  <section aria-labelledby="h-logins"><h2 id="h-logins">Sign-in methods</h2>
  ${logins.filter(l => l.enabled || l.linked).map(l => `<div class="row"><div><div>${esc(l.name)}</div><div class="sub">${l.kind === 'password' ? (l.linked ? 'This account has a password' : 'No password set') : l.linked ? `Linked${l.email ? ' as ' + esc(l.email) : ''}` : 'Not linked'}</div></div>${
    l.kind === 'password' ? '' : `<form method="post" action="/account/logins/${l.linked ? 'unlink' : 'link'}">${hidden}<input type="hidden" name="method" value="${esc(l.id)}"><button class="btn small" type="submit">${l.linked ? 'Unlink' : 'Link'}<span class="sub"> ${esc(l.name)}</span></button></form>`}</div>`).join('\n  ') || '<p class="sub">None.</p>'}
  </section>

  <section aria-labelledby="h-sessions"><h2 id="h-sessions">Active sessions</h2>
  ${sessionsOf(u, s).map(x => `<div class="row"><div><div>${x.current ? 'This page' : 'A signed-in client'}</div><div class="sub">Signed in ${esc(when(x.created_at))}, last used ${esc(when(x.last_used))}</div></div>${
    x.current ? '' : `<form method="post" action="/account/sessions/end">${hidden}<input type="hidden" name="key" value="${esc(x.key)}"><button class="btn small" type="submit">Sign out<span class="sub"> this session</span></button></form>`}</div>`).join('\n  ')}
  <div class="inline">
    <form method="post" action="/account/signout" style="flex:1">${hidden}<button class="btn" type="submit" style="width:100%">Sign out of this page</button></form>
    <form method="post" action="/account/signout-all" style="flex:1">${hidden}<button class="btn danger" type="submit" style="width:100%">Sign out everywhere</button></form>
  </div></section>`;
  return `${h.top}${body}${h.bottom}`;
}

function register(app) {
  app.cors('/account', () => false); // a page for people, not for other origins
  const local = res => { if (config.mode() === 'local') return true; page.send(res, 404, page.messagePage({ title: 'No accounts here', text: 'This homeserver does not host accounts. Sign in where your account lives.', bad: true })); return false; };

  app.get('/account', { auth: false }, (req, res) => {
    if (!local(res)) return;
    const s = session(req);
    if (!s) return toLogin(res);
    const linked = typeof req.query.linked === 'string', q = req.query;
    page.send(res, 200, render(s, { note: linked ? 'linked' : q.ok, error: typeof q.link_error === 'string' ? q.link_error : q.error }));
  });
  app.get(CALLBACK, { auth: false }, (req, res) => { if (local(res)) callback(req, res); });

  // a form post from the page: the session, then the CSRF token, then fn(s, fields) -> the note to show (or a redirect it made itself)
  const post = (path, fn, { multipart = false } = {}) => app.post('/account' + path, { auth: false, form: true }, async (req, res) => {
    if (!local(res)) return;
    const s = session(req);
    if (!s) return back(res);
    let fields = req.body || {}, file = null;
    try {
      if (multipart && /^multipart\//i.test(req.headers['content-type'] || '')) { const m = await require('./uploads').readMultipart(req, { maxBytes: 4 * 1024 * 1024 }); fields = m.fields || {}; file = m.buffer; }
      if (typeof fields.csrf !== 'string' || !safeEqual(fields.csrf, csrfOf(s.token))) return page.send(res, 403, render(s, { error: 'csrf' }));
      const note = await fn(s, fields, res, file);
      if (!res.writableEnded) back(res, note ? '?ok=' + encodeURIComponent(note) : '');
    } catch (e) {
      if (!e.code) throw e;
      if (!res.writableEnded) back(res, '?error=' + encodeURIComponent(e.code));
    }
  });
  const fail = code => Object.assign(new Error(code), { code });
  const AP = () => require('./account-profile');
  post('/profile', (s, f) => { AP().update(s.user, { ...(s.user.kind === 'local' ? { display_name: f.display_name ?? '' } : {}), bio: f.bio ?? '', pronouns: f.pronouns ?? '' }); return 'profile'; });
  const localOnly = s => { if (s.user.kind !== 'local') throw fail('local_accounts_only'); };
  post('/avatar', (s, f, res, file) => { localOnly(s); if (!file || !file.length) throw fail('no_file'); AP().setImage(s.user, 'pfp', file); return 'avatar'; }, { multipart: true });
  post('/avatar/remove', s => { localOnly(s); AP().setImage(s.user, 'pfp', null); return 'avatar_removed'; });
  post('/dm-privacy', (s, f) => { if (require('./social/where').apiElsewhere(s.user)) throw fail('social_elsewhere'); if (!DM_FROM[f.dm_from]) throw fail('invalid_dm_from'); require('./communities').setSettings(s.user, { dm_from: f.dm_from }); return 'dm'; });
  post('/logins/unlink', (s, f) => { require('./login').unlink(auth.userById(s.user.id), String(f.method || '')); return 'unlinked'; });
  // linking goes through the provider and comes back here with ?linked= or ?link_error=
  // (a link, not a redirect: the page's form-action rule only lets forms end up on this homeserver)
  post('/logins/link', (s, f, res) => {
    const { url } = require('./login').linkTicket(s.user, String(f.method || ''), config.publicUrl() + '/account');
    page.send(res, 200, page.messagePage({ title: 'Add a sign-in method', text: 'Continue to sign in there once. It is then linked to your account.', links: [{ href: url, label: 'Continue' }, { href: '/account', label: 'Back' }] }));
  });
  post('/sessions/end', (s, f) => { if (!endSession(s.user, f.key)) throw fail('session_not_found'); return 'session'; });
  const bye = (res, text) => page.send(res, 200, page.messagePage({ title: 'Signed out', text, links: [{ href: '/account', label: 'Sign in again' }] }), { cookies: [cookie(COOKIE, '', 0)] });
  post('/signout', (s, f, res) => { auth.revokeSession(s.token); bye(res, 'You are signed out of this page. Your other sessions are still signed in.'); });
  post('/signout-all', (s, f, res) => { endAll(s.user); bye(res, 'Every session of your account was signed out, on every device.'); });
}

module.exports = { register, sessionsOf, csrfOf, _test: { COOKIE, render } };
