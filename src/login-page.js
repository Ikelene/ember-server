'use strict';
// The homeserver's sign-in page (GET /login, PROTOCOL §4a): plain server-rendered HTML, no scripts. Every value that reaches the
// page is escaped. Its look is the homeserver's branding (branding.js, PROTOCOL §5e): the rules below are served as a stylesheet
// (/_ember/page/base.css), then the theme and the admin's custom CSS; no inline styles.
const config = require('./config');
const branding = require('./branding');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
:root{color-scheme:dark;--bg:#0e0e10;--surface:#141417;--surface-2:#1a1a1f;--border:#292930;--border-2:#35353d;--text:#e7e7ea;--muted:#8b8b94;--accent:#9d8ad1;--accent-ink:#0e0e10;--bad:#f87171}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f4f6;--surface:#ffffff;--surface-2:#f0f0f3;--border:#dcdce2;--border-2:#c9c9d1;--text:#18181b;--muted:#5d5d68;--accent:#6f5bb0;--accent-ink:#ffffff;--bad:#dc2626}}
*{box-sizing:border-box;border-radius:0}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--link,var(--accent))}
.wrap{max-width:400px;margin:0 auto;padding:48px 16px}
.card{background:var(--surface);border:1px solid var(--border);padding:var(--pad,24px)}
.hb{margin:calc(var(--pad,24px) * -1) calc(var(--pad,24px) * -1) 20px;height:120px;overflow:hidden;background:var(--surface-2);border-bottom:1px solid var(--border)}
.hb img{width:100%;height:100%;object-fit:cover;display:block}
.logo{display:block;max-width:100%;max-height:72px;object-fit:contain}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.m0{margin:0}
.grow{flex:1}
.full{width:100%}
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
branding.registerSheet('base', CSS);

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
  invite_required: 'New accounts here need an invite code. Ask an admin of this homeserver for one.',
  invalid_invite: 'That invite code is not valid, has been used up or has expired.',
  account_pending: 'Thanks! An admin of this homeserver looks at new accounts before they can be used. Try signing in again once yours is approved.',
  password_login_disabled: 'Password sign-in is switched off here.',
  not_linked: 'No account here is linked to this login.',
  login_already_linked: 'That login is already linked to another account.',
  provider_failed: 'Signing in that way did not work. Try again or use another way.',
  provider_denied: 'The sign-in was cancelled.',
  unknown_method: 'That way to sign in is not available here.',
};
const message = code => MESSAGES[code] || 'Something went wrong. Try again.';

// sheet: the page's own stylesheet (branding.registerSheet), e.g. the account page's
// meta: more <head> lines (already escaped), e.g. the invite page's link preview tags
// brand: { branding, prefix } for a preview of branding that is not saved (the saved one otherwise)
function head(title, sheet = '', meta = '', brand = null) {
  const b = brand?.branding || branding.saved();
  const r = branding.resolve(b);
  const icon = r.icon_url, name = r.name;
  const initial = esc((Array.from(name.trim())[0] || 'E').toUpperCase());
  const banner = r.banner_url ? `
  <div class="hb"><img src="${esc(r.banner_url)}" alt=""></div>` : '';
  const who = r.theme.header === 'logo'
    ? `<div><img class="logo" src="${esc(r.logo_url)}" alt="${esc(name)}"><h1 class="sr">${esc(name)}</h1><div class="dom">${esc(r.domain)}</div></div>`
    : `<div class="ic">${icon ? `<img src="${esc(icon)}" alt="">` : initial}</div><div><h1>${esc(name)}</h1><div class="dom">${esc(r.domain)}</div></div>`;
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
${branding.pageLink('base')}
${sheet ? branding.pageLink(sheet) + '\n' : ''}${branding.links(b, brand?.prefix ? { prefix: brand.prefix } : {})}
</head>
<body>
<main class="wrap">
<div class="card">${banner}
  <div class="hs">${who}</div>`,
    bottom: `
</div>
</main>
</body>
</html>`,
  };
}

const hidden = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
const query = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

// { authz, csrf, view: 'login' | 'register', methods: [{ id, kind, name }], canRegister, registration (the mode), invite, error, notice, link, to }
function loginPage(p) {
  const h = head(`Sign in to ${branding.resolve(p.brand?.branding || branding.saved()).name}`, '', '', p.brand || null);
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
    <label for="p2">Password again</label><input id="p2" type="password" name="password2" autocomplete="new-password" minlength="8" maxlength="200" required>${p.registration === 'invite' ? `
    <label for="i">Invite code</label><input id="i" type="text" name="invite" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="40" required value="${esc(p.invite || '')}">` : ''}${p.registration === 'approval' ? `
    <p class="msg">An admin looks at new accounts here before they can be used.</p>` : ''}
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
function messagePage({ title, text, bad = false, links = [], brand = null }) {
  const h = head(title, '', '', brand);
  return `${h.top}
  <h2>${esc(title)}</h2>
  <p class="msg${bad ? ' bad' : ''}"${bad ? ' role="alert"' : ''}>${esc(text)}</p>
  ${links.length ? `<div class="foot">${links.map(l => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join('')}</div>` : ''}${h.bottom}`;
}

// the sign-in page with branding that is not saved yet (an admin's live preview, branding.js): its forms go nowhere
function previewPage(b, id, which) {
  const brand = { branding: b, prefix: `/branding/preview/${encodeURIComponent(id)}` };
  if (which === 'message') return messagePage({ title: 'Something to know', text: 'This is how a message from this homeserver looks.', links: [{ href: '#', label: 'A link' }], brand });
  return loginPage({ brand, authz: {}, csrf: 'preview', view: 'login', methods: [{ id: 'password', kind: 'password', name: 'Password' }], canRegister: true, registration: 'open', notice: 'This is a preview of your branding.', to: 'Ember' });
}

// formTo: the client origin the last redirect goes to (a form's redirect chain is checked against form-action)
// preview: a page an admin's client shows in a frame (its forms go nowhere)
function send(res, status, body, { cookies = [], formTo = null, preview = false } = {}) {
  const csp = preview
    ? branding.csp({ form: "'none'", frameAncestors: config.get().ember_clients.join(' ') })
    : branding.csp({ formTo });
  res.removeHeader('Access-Control-Allow-Origin');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
    'Content-Security-Policy': csp, 'Referrer-Policy': 'no-referrer', ...(preview ? {} : { 'X-Frame-Options': 'DENY' }), ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  });
  res.end(body);
}
function redirect(res, url, cookies = []) {
  res.removeHeader('Access-Control-Allow-Origin');
  res.writeHead(302, { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  res.end();
}

module.exports = { loginPage, messagePage, previewPage, send, redirect, message, esc, head, CSS };
