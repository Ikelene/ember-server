'use strict';
// Client-neutral invite links: https://<domain>/i/<code> (older links /i/<slug>/<code> keep working, and /i/<slug> for a listed
// server). A browser gets a page
// with the server's card and "Open in" buttons for the clients in config `invites.clients`; any other client gets JSON.
// Plain server-rendered HTML like the sign-in page: no scripts, every value escaped.
const config = require('./config');
const db = require('./db');
const C = require('./communities');
const page = require('./login-page');
const { wantsHtml } = require('./landing');
const { err } = require('./util');

const { esc } = page;

const absUrl = u => {
  if (!u) return null;
  try { const x = new URL(String(u), config.get().public_url + '/'); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
};

// a client's url template -> the link for this invite: {url} is the invite link itself (url-encoded), {code} its code; the older
// {address} {slug} {domain} still fill in (no code: the "/{code}" part goes away)
function fill(tpl, { slug, domain, code, url }) {
  const e = encodeURIComponent, v = { slug: e(slug), domain: e(domain), address: `${e(slug)}@${e(domain)}`, code: code ? e(code) : '', url: e(url || inviteUrl(slug, code)) };
  let s = String(tpl);
  if (!code) s = s.replace(/\/\{code\}/g, '');
  return s.replace(/\{(slug|domain|address|code|url)\}/g, (_, k) => v[k]);
}

// the client-neutral link: <url_base><code> for an invite, <url_base><slug> for a listed server without one
const inviteUrl = (slug, code) => config.get().invites.url_base + encodeURIComponent(code || slug);
const codeUrl = code => config.get().invites.url_base + encodeURIComponent(code);

// -> { c, code } | throws invalid_invite 404. With a code: the invite must be for this slug's server. Without: listed servers only
// /i/<x>: an invite code first, else a listed server's slug
function resolveOne(x) {
  try { const { c } = C.findInvite(x); if (c && c.kind === 'server') return { c, code: String(x).trim() }; } catch { /* not a code */ }
  return resolve(x, null);
}
function resolve(slug, code) {
  const c = db.get("SELECT * FROM communities WHERE slug = ? AND kind = 'server'", String(slug || '').toLowerCase());
  if (!c) throw err('invalid_invite', 404);
  if (code) {
    const found = C.findInvite(code);
    if (found.c?.id !== c.id) throw err('invalid_invite', 404);
  } else if (!c.listed && C.communityCount() !== 1) throw err('invalid_invite', 404);
  return { c, code: code || null };
}

const JOIN = { open: 'Anyone can join', request: 'Join by request', password: 'Password to join', allowlist: 'Allowlist only', invite: 'Invite only' };

const CSS = `
.wrap{max-width:480px}
.srv{display:flex;align-items:center;gap:14px;margin-bottom:16px}
.srv .ic{width:64px;height:64px;font-size:28px}
.sub{color:var(--muted);font-size:14px;margin-top:2px}
.desc{margin:0 0 16px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.lead{margin:0 0 4px;font-size:14px;color:var(--muted)}
.btn{display:flex;align-items:center;justify-content:center;gap:10px}
.btn img{width:20px;height:20px;object-fit:cover}
.paste{margin-top:18px;padding-top:14px;border-top:1px solid var(--border);font-size:14px;color:var(--muted)}
.paste dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:8px 0 0}
.paste dt{color:var(--muted)}
.paste dd{margin:0;color:var(--text);font:13px/1.5 Consolas,"Cascadia Code",ui-monospace,monospace;overflow-wrap:anywhere;user-select:all}
`;
require('./branding').registerSheet('invite', CSS);

// link previews in other apps (Open Graph / Twitter card): the server's name, description and icon, the homeserver as site
function previewMeta(d, c, code, icon) {
  const cfg = config.get(), n = d.member_count, cut = (s, max) => { const a = Array.from(String(s).replace(/\s+/g, ' ').trim()); return a.length > max ? a.slice(0, max - 1).join('') + '…' : a.join(''); };
  const desc = cut(d.description || `You are invited to join ${d.name}: ${n.toLocaleString('en-US')} member${n === 1 ? '' : 's'} on ${cfg.name || cfg.domain}.`, 200);
  const image = icon || absUrl(cfg.icon_url), site = cfg.name || cfg.domain;
  const tags = [['og:type', 'website'], ['og:site_name', site], ['og:title', d.name], ['og:description', desc], ['og:url', inviteUrl(c.slug, code)], ...(image ? [['og:image', image]] : [])]
    .map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`);
  tags.push(...[['twitter:card', 'summary'], ['twitter:title', d.name], ['twitter:description', desc], ...(image ? [['twitter:image', image]] : [])].map(([k, v]) => `<meta name="${k}" content="${esc(v)}">`));
  return `<meta name="description" content="${esc(desc)}">\n${tags.join('\n')}\n`;
}

function render({ c, code }) {
  const cfg = config.get(), d = C.discoveryView(c), icon = absUrl(c.icon_url);
  const url = inviteUrl(c.slug, code), vars = { slug: c.slug, domain: cfg.domain, code, url };
  const initial = esc((Array.from(String(d.name || '').trim())[0] || 'E').toUpperCase());
  const h = page.head(`Join ${d.name}`, 'invite', previewMeta(d, c, code, icon));
  const proto = `web+ember:invite?${new URLSearchParams({ url, address: d.address, ...(code ? { code } : {}) })}`; // (address + code: older apps)
  const clients = cfg.invites.clients.map(x => `<a class="btn" href="${esc(fill(x.url, vars))}" rel="noopener">${x.icon_url ? `<img src="${esc(x.icon_url)}" alt="">` : ''}Open in ${esc(x.name)}</a>`).join('\n  ');
  const n = d.member_count;
  const body = `
  <p class="lead">You are invited to join</p>
  <div class="srv"><div class="ic">${icon ? `<img src="${esc(icon)}" alt="">` : initial}</div><div><h1>${esc(d.name)}</h1>
    <div class="sub">${n.toLocaleString('en-US')} member${n === 1 ? '' : 's'} · ${esc(JOIN[d.join_policy] || d.join_policy)}</div></div></div>
  ${d.description ? `<p class="desc">${esc(d.description)}</p>` : ''}
  <a class="btn primary" href="${esc(proto)}">Open in your Ember app</a>
  ${clients}
  <div class="paste">Or paste this link into any Ember client:
    <dl><dt>Link</dt><dd>${esc(url)}</dd></dl></div>`;
  return `${h.top}${body}${h.bottom}`;
}

function notFound() {
  return page.messagePage({ title: 'Invite not found', text: 'This invite is invalid or has expired. Ask whoever sent it for a new one.', bad: true });
}

function handle(req, res) {
  let r;
  try { r = req.params.code ? resolve(req.params.slug, req.params.code) : resolveOne(req.params.slug); } catch (e) {
    if (e.status !== 404 || !wantsHtml(req)) throw e;
    return page.send(res, 404, notFound());
  }
  if (!wantsHtml(req)) return { server: C.discoveryView(r.c), code: r.code, url: inviteUrl(r.c.slug, r.code) };
  page.send(res, 200, render(r));
}

function register(app) {
  app.get('/i/:slug', { auth: false }, handle);
  app.get('/i/:slug/:code', { auth: false }, handle);
}

module.exports = { register, fill, inviteUrl, codeUrl, resolve };
