'use strict';
// The homeserver's sign-in page (GET /login, PROTOCOL §4a): plain server-rendered HTML, no scripts, nothing loaded from
// anywhere else. Every value that reaches the page is escaped.
const config = require('./config');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
:root{color-scheme:dark;--bg:#0e0e10;--surface:#141417;--surface-2:#1a1a1f;--border:#292930;--border-2:#35353d;--text:#e7e7ea;--muted:#8b8b94;--accent:#9d8ad1;--accent-ink:#0e0e10;--bad:#f87171}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f4f6;--surface:#ffffff;--surface-2:#f0f0f3;--border:#dcdce2;--border-2:#c9c9d1;--text:#18181b;--muted:#5d5d68;--accent:#6f5bb0;--accent-ink:#ffffff;--bad:#dc2626}}
*{box-sizing:border-box;border-radius:0}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
.wrap{max-width:400px;margin:0 auto;padding:48px 16px}
.card{background:var(--surface);border:1px solid var(--border);padding:24px}
.hs{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.ic{width:56px;height:56px;background:var(--surface-2);display:grid;place-items:center;overflow:hidden;font-size:24px;font-weight:700;color:var(--accent);flex:none}
.ic img{width:100%;height:100%;object-fit:cover;display:block}
h1{margin:0;font-size:20px;line-height:1.2;overflow-wrap:anywhere}
.dom{color:var(--muted);font-size:13px;overflow-wrap:anywhere}
h2{margin:0 0 14px;font-size:16px}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
input[type=text],input[type=password]{width:100%;padding:10px 12px;font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--border-2)}
input:focus-visible,.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn{display:block;width:100%;margin-top:14px;padding:11px 16px;font:inherit;font-weight:600;text-align:center;text-decoration:none;border:1px solid var(--border-2);background:var(--surface-2);color:var(--text);cursor:pointer}
.btn:hover{border-color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.or{display:flex;align-items:center;gap:10px;margin:18px 0 4px;color:var(--muted);font-size:13px}
.or:before,.or:after{content:"";flex:1;border-top:1px solid var(--border)}
.msg{margin:0 0 14px;padding:10px 12px;border:1px solid var(--border-2);border-left:3px solid var(--accent);background:var(--surface-2);font-size:14px;overflow-wrap:anywhere}
.msg.bad{border-left-color:var(--bad)}
.foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 16px;margin-top:18px;font-size:14px}
.to{margin-top:16px;color:var(--muted);font-size:13px;text-align:center;overflow-wrap:anywhere}
`;

const MESSAGES = {
  invalid_credentials: 'Wrong username or password.',
  rate_limited: 'Too many tries. Wait a few minutes and try again.',
  csrf: 'This page was open for too long. Try again.',
  banned: 'This account is banned.',
  invalid_username: 'Usernames are 2 to 32 characters: lowercase letters, numbers, dots and underscores.',
  invalid_password: 'Passwords are at least 8 characters.',
  password_mismatch: 'The two passwords are not the same.',
  username_taken: 'That username is taken.',
  registration_closed: 'New accounts cannot be made here right now.',
  password_login_disabled: 'Password sign-in is switched off here.',
  not_linked: 'No account here is linked to this login.',
  login_already_linked: 'That login is already linked to another account.',
  provider_failed: 'Signing in that way did not work. Try again or use another way.',
  provider_denied: 'The sign-in was cancelled.',
  unknown_method: 'That way to sign in is not available here.',
};
const message = code => MESSAGES[code] || 'Something went wrong. Try again.';

// extraCss: more rules for a page that needs them (the account page)
// meta: more <head> lines (already escaped), e.g. the invite page's link preview tags
function head(title, extraCss = '', meta = '') {
  const cfg = config.get();
  let icon = null;
  if (cfg.icon_url) { try { const x = new URL(String(cfg.icon_url), cfg.public_url + '/'); if (/^https?:$/.test(x.protocol)) icon = x.href; } catch { /* none */ } }
  const name = cfg.name || 'Ember server';
  const initial = esc((Array.from(name.trim())[0] || 'E').toUpperCase());
  return {
    top: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
${meta}${icon ? `<link rel="icon" href="${esc(icon)}">` : ''}
<style>${CSS}${extraCss}</style>
</head>
<body>
<main class="wrap">
<div class="card">
  <div class="hs"><div class="ic">${icon ? `<img src="${esc(icon)}" alt="">` : initial}</div><div><h1>${esc(name)}</h1><div class="dom">${esc(cfg.domain)}</div></div></div>`,
    bottom: `
</div>
</main>
</body>
</html>`,
  };
}

const hidden = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
const query = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

// { authz, csrf, view: 'login' | 'register', methods: [{ id, kind, name }], canRegister, error, notice, link, to }
function loginPage(p) {
  const h = head(`Sign in to ${config.get().name || 'Ember'}`);
  const password = p.methods.find(m => m.kind === 'password');
  const others = p.methods.filter(m => m.kind !== 'password');
  const carry = { ...p.authz, ...(p.link ? { link: p.link } : {}) };
  const self = `/login?${query(carry)}`;
  const register = p.view === 'register' && password && p.canRegister && !p.link;
  let body = '';
  if (p.error) body += `<p class="msg bad" role="alert">${esc(message(p.error))}</p>`;
  if (p.link) body += `<p class="msg">${esc(p.notice || 'Sign in with your password to link this login to your account.')}</p>`;
  else if (p.notice) body += `<p class="msg">${esc(p.notice)}</p>`;
  if (register) {
    body += `<h2>Create an account</h2>
  <form method="post" action="/login" autocomplete="on">${hidden({ ...carry, csrf: p.csrf, action: 'register' })}
    <label for="u">Username</label><input id="u" type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" required value="${esc(p.username || '')}">
    <label for="p">Password</label><input id="p" type="password" name="password" autocomplete="new-password" minlength="8" maxlength="200" required>
    <label for="p2">Password again</label><input id="p2" type="password" name="password2" autocomplete="new-password" minlength="8" maxlength="200" required>
    <button class="btn primary" type="submit">Create account</button>
  </form>`;
  } else {
    body += `<h2>${p.link ? 'Link your account' : 'Sign in'}</h2>`;
    if (password) body += `
  <form method="post" action="/login" autocomplete="on">${hidden({ ...carry, csrf: p.csrf, action: 'login' })}
    <label for="u">Username</label><input id="u" type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required value="${esc(p.username || p.authz.login_hint || '')}">
    <label for="p">Password</label><input id="p" type="password" name="password" autocomplete="current-password" maxlength="200" required>
    <button class="btn primary" type="submit">Sign in</button>
  </form>`;
    if (others.length && !p.link) {
      if (password) body += '<div class="or">or</div>';
      body += others.map(m => `<a class="btn" href="/login/start/${encodeURIComponent(m.id)}?${esc(query(p.authz))}">Continue with ${esc(m.name)}</a>`).join('\n  ');
    }
    if (!password && !others.length) body += '<p class="msg bad">There is no way to sign in here right now.</p>';
  }
  const links = [];
  if (!p.link && password && p.canRegister) links.push(register ? `<a href="${esc(self)}">Sign in instead</a>` : `<a href="${esc(self)}&amp;view=register">Create account</a>`);
  links.push(`<a href="/login/cancel?${esc(query(p.authz))}">Cancel</a>`);
  body += `<div class="foot">${links.join('')}</div>`;
  return `${h.top}
  ${body}${h.bottom.replace('</div>\n</main>', `</div>\n<div class="to">You will go back to ${esc(p.to)}</div>\n</main>`)}`;
}

// a page with one message (an error that cannot go back to the client, the end of linking a login)
function messagePage({ title, text, bad = false, links = [] }) {
  const h = head(title);
  return `${h.top}
  <h2>${esc(title)}</h2>
  <p class="msg${bad ? ' bad' : ''}"${bad ? ' role="alert"' : ''}>${esc(text)}</p>
  ${links.length ? `<div class="foot">${links.map(l => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join('')}</div>` : ''}${h.bottom}`;
}

// formTo: the client origin the last redirect goes to (a form's redirect chain is checked against form-action)
function send(res, status, body, { cookies = [], formTo = null } = {}) {
  const csp = `default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'${formTo ? ' ' + formTo : ''}; frame-ancestors 'none'`;
  res.removeHeader('Access-Control-Allow-Origin');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
    'Content-Security-Policy': csp, 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  });
  res.end(body);
}
function redirect(res, url, cookies = []) {
  res.removeHeader('Access-Control-Allow-Origin');
  res.writeHead(302, { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  res.end();
}

module.exports = { loginPage, messagePage, send, redirect, message, esc, head };
