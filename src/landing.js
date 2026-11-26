'use strict';
// The page a browser gets at "/" (Accept: text/html): the homeserver's card, the servers it lists, live numbers and how to join in Ember.
// Everything on it is already public (the discovery document, the invite card): names, descriptions, icons, member counts,
// plus counts only (people online, sockets, channels, uptime), never who. Anything else asking for "/" still gets the JSON it always did.
const config = require('./config');
const db = require('./db');
const pkg = require('../package.json');

const EMBER = 'https://ember.nookara.cc';
const NOOKARA = 'https://nookara.cc';
const STATS_TTL = 5000;
let cache = { at: 0, v: null };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// the servers the page shows: the listed ones; a homeserver with a single server shows it either way (as it always did)
const shown = () => { const all = db.all('SELECT * FROM communities ORDER BY id LIMIT 2'); return all.length === 1 ? all : db.all('SELECT * FROM communities WHERE listed = 1 ORDER BY id LIMIT 200'); };

// a stored picture address -> absolute https/http url on this server (or null): relative ones join the public url, nothing but http(s)
function absUrl(u) {
  if (!u) return null;
  try { const x = new URL(String(u), config.get().public_url + '/'); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}

// Ember's link for this server: the short /server/<host> on https, the long #/i/ form for an http dev server
function emberLink(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:' && (u.pathname === '/' || !u.pathname)) return `${EMBER}/server/${u.host.toLowerCase()}`;
  } catch { /* fall through */ }
  return `${EMBER}/#/i/${encodeURIComponent(origin)}`;
}

function stats() {
  if (cache.v && Date.now() - cache.at < STATS_TTL) return cache.v;
  const cfg = config.get(), list = shown(), one = list.length === 1 ? list[0] : null;
  const n = (sql, ...a) => db.get(sql, ...a)?.n || 0;
  const { emberBase } = require('./util');
  const servers = list.map(c => ({
    name: c.name, slug: c.slug, address: `${c.slug}@${cfg.domain}`, description: c.description || '', icon_url: absUrl(c.icon_url),
    members: n('SELECT COUNT(*) n FROM members WHERE community_id = ?', c.id), join_policy: c.join_policy,
    join_url: `${emberBase(cfg.nookara_url)}#/i/${encodeURIComponent(cfg.public_url)}/invite/${c.invite_code}`,
  }));
  const { online, connections } = require('./gateway').counts();
  const { uptime_s, started_at } = require('./version').runtime();
  const v = {
    // the homeserver's own name, description and icon; the numbers are the whole homeserver's
    name: cfg.name, description: cfg.description || '', domain: cfg.domain,
    icon_url: absUrl(cfg.icon_url), banner_url: absUrl(one?.banner_url),
    members: n('SELECT COUNT(DISTINCT user_id) n FROM members'),
    online, connections,
    channels: n('SELECT COUNT(*) n FROM channels'),
    uptime_s, started_at, version: pkg.version,
    join_policy: one?.join_policy || null, ready: n('SELECT COUNT(*) n FROM communities') > 0,
    servers,
    url: cfg.public_url, ember_url: emberLink(cfg.public_url),
  };
  cache = { at: Date.now(), v };
  return v;
}
const resetCache = () => { cache = { at: 0, v: null }; };

// a browser asking for a page: text/html (or xhtml) in Accept, not a client that only wants JSON
function wantsHtml(req) {
  const a = String(req.headers.accept || '').toLowerCase();
  return /\btext\/html\b|\bapplication\/xhtml\+xml\b/.test(a);
}

const JOIN = {
  open: 'Anyone can join', request: 'Join by request', password: 'Password to join', allowlist: 'Allowlist only', invite: 'Invite only',
};

// lucide icons (ISC licence), inline so the page needs nothing else
const ICON = {
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
};
const icon = (k, size = 18) => `<svg class="i" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

const fmt = n => Number(n || 0).toLocaleString('en-US');
function fmtUptime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const CSS = `
:root{color-scheme:dark;--bg:#0e0e10;--surface:#141417;--surface-2:#1a1a1f;--border:#292930;--border-2:#35353d;--text:#e7e7ea;--muted:#8b8b94;--faint:#5c5c66;--accent:#9d8ad1;--accent-ink:#0e0e10;--ok:#4ade80}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f4f6;--surface:#ffffff;--surface-2:#f0f0f3;--border:#dcdce2;--border-2:#c9c9d1;--text:#18181b;--muted:#5d5d68;--faint:#8b8b94;--accent:#6f5bb0;--accent-ink:#ffffff;--ok:#16a34a}}
*{box-sizing:border-box;border-radius:0}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
.i{flex:none;display:block}
.wrap{max-width:880px;margin:0 auto;padding:40px 16px 56px}
.top{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px;margin-bottom:20px}
.live{display:inline-flex;align-items:center;gap:8px;padding:4px 10px;border:1px solid var(--border);background:var(--surface);color:var(--text)}
.dot{width:8px;height:8px;background:var(--ok);box-shadow:0 0 0 0 var(--ok);animation:pulse 2s infinite}
.dot.off{background:var(--faint);animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ok) 60%,transparent)}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.top .sp{flex:1}
.card{background:var(--surface);border:1px solid var(--border)}
.banner{height:180px;overflow:hidden;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 55%,var(--bg)),color-mix(in srgb,var(--accent) 12%,var(--bg)));background-size:cover;background-position:center;border-bottom:1px solid var(--border)}
.banner img{width:100%;height:100%;object-fit:cover;display:block}
.head{display:flex;gap:18px;padding:0 24px 22px;align-items:flex-end}
.ic{width:96px;height:96px;margin-top:-48px;background:var(--surface-2);border:4px solid var(--surface);display:grid;place-items:center;overflow:hidden;font-size:38px;font-weight:700;color:var(--accent);flex:none}
.ic img{width:100%;height:100%;object-fit:cover;display:block}
.who{min-width:0;flex:1;padding-top:14px}
h1{margin:0;font-size:30px;line-height:1.15;letter-spacing:-.01em;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:6px;color:var(--muted);font-size:14px}
.meta span{display:inline-flex;align-items:center;gap:6px}
.meta b{color:var(--text);font-weight:600}
.desc{margin:0;padding:0 24px 22px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
.acts{display:flex;flex-wrap:wrap;gap:10px;padding:18px 24px;border-top:1px solid var(--border);background:var(--surface-2)}
.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;font:inherit;font-weight:600;text-decoration:none;border:1px solid var(--border-2);background:var(--surface);color:var(--text);cursor:pointer}
.btn:hover{border-color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.primary:hover{filter:brightness(1.08)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:36px 0 12px}
.list{display:grid;gap:12px}
.srv{display:flex;align-items:center;gap:14px;padding:14px 16px;background:var(--surface);border:1px solid var(--border)}
.srv .si{width:48px;height:48px;background:var(--surface-2);display:grid;place-items:center;overflow:hidden;font-size:20px;font-weight:700;color:var(--accent);flex:none}
.srv .si img{width:100%;height:100%;object-fit:cover;display:block}
.srv .sw{min-width:0;flex:1}
.srv h3{margin:0;font-size:16px;overflow-wrap:anywhere}
.srv .sa{color:var(--faint);font:12px/1.4 Consolas,"Cascadia Code",ui-monospace,monospace;overflow-wrap:anywhere}
.srv p{margin:4px 0 0;color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.srv .meta{margin-top:4px;font-size:13px}
.none{padding:16px 18px;background:var(--surface);border:1px solid var(--border);color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{padding:16px 18px;background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--accent)}
.stat .k{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}
.stat .v{font-size:30px;font-weight:700;margin-top:6px;font-variant-numeric:tabular-nums;line-height:1.1}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.step{padding:18px;background:var(--surface);border:1px solid var(--border)}
.step .n{display:inline-grid;place-items:center;width:26px;height:26px;background:var(--accent);color:var(--accent-ink);font-weight:700;font-size:13px}
.step h3{margin:12px 0 6px;font-size:16px}
.step p{margin:0;color:var(--muted);font-size:14px}
.url{display:flex;margin-top:12px;border:1px solid var(--border-2);background:var(--bg)}
.url code{flex:1;min-width:0;padding:9px 10px;font:13px/1.4 Consolas,"Cascadia Code",ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.url button{display:grid;place-items:center;width:40px;border:0;border-left:1px solid var(--border-2);background:var(--surface-2);color:var(--text);cursor:pointer}
.url button:hover{color:var(--accent)}
.apps{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.apps a{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid var(--border-2);color:var(--text);text-decoration:none;font-size:13px}
.apps a:hover{border-color:var(--accent)}
footer{margin-top:40px;padding-top:18px;border-top:1px solid var(--border);display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--faint);font-size:13px}
footer a{color:var(--muted);display:inline-flex;align-items:center;gap:6px}
footer span{display:inline-flex;align-items:center;gap:6px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:600px){
  .wrap{padding-top:20px}
  .banner{height:120px}
  .head{flex-direction:column;align-items:flex-start;gap:10px;padding:0 16px 16px}
  .ic{width:80px;height:80px;margin-top:-40px;font-size:30px}
  .who{padding-top:0}
  h1{font-size:24px}
  .desc{padding:0 16px 16px}
  .acts{padding:14px 16px}
  .acts .btn{flex:1 1 100%;justify-content:center}
  .srv{flex-wrap:wrap}
  .srv .btn{flex:1 1 100%;justify-content:center}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .stat .v{font-size:24px}
}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
`;

// refreshes the numbers every 15 s while the tab is visible; no libraries
const JS = `
(function(){
  var dot=document.getElementById('dot'),st=document.getElementById('st');
  var fmt=function(n){return Number(n||0).toLocaleString()};
  var up=function(s){s=Math.max(0,Math.floor(s||0));var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+'d '+h+'h':h?h+'h '+m+'m':m+'m'};
  function set(k,v){var e=document.querySelectorAll('[data-s="'+k+'"]');for(var i=0;i<e.length;i++)e[i].textContent=v}
  function load(){
    if(document.hidden)return;
    fetch('/api/v1/instance/stats',{headers:{Accept:'application/json'},cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){
      set('online',fmt(d.online));set('members',fmt(d.members));set('connections',fmt(d.connections));set('channels',fmt(d.channels));set('uptime',up(d.uptime_s));
      dot.className='dot';st.textContent='Online';
    }).catch(function(){dot.className='dot off';st.textContent='Not responding'});
  }
  setInterval(load,15000);document.addEventListener('visibilitychange',load);
  var cp=document.getElementById('cp');
  if(cp)cp.addEventListener('click',function(){
    var t=document.getElementById('srv').textContent,done=function(){cp.innerHTML=cp.getAttribute('data-ok');cp.setAttribute('aria-label','Copied');setTimeout(function(){cp.innerHTML=cp.getAttribute('data-ic');cp.setAttribute('aria-label','Copy server address')},1600)};
    if(navigator.clipboard)navigator.clipboard.writeText(t).then(done,function(){});
  });
})();
`;

function page() {
  const s = stats();
  const name = s.name || 'Ember server';
  const first = t => esc((Array.from(String(t || '').trim())[0] || 'E').toUpperCase());
  const server = v => `<div class="srv">
      <div class="si">${v.icon_url ? `<img src="${esc(v.icon_url)}" alt="">` : first(v.name)}</div>
      <div class="sw"><h3>${esc(v.name)}</h3><div class="sa">${esc(v.address)}</div>${v.description ? `<p>${esc(v.description)}</p>` : ''}
        <div class="meta"><span>${icon('users', 14)}<b>${fmt(v.members)}</b> member${v.members === 1 ? '' : 's'}</span><span>${icon('lock', 14)}${esc(JOIN[v.join_policy] || v.join_policy)}</span></div></div>
      <a class="btn primary" href="${esc(v.join_url)}" rel="noopener">${icon('flame')}Join</a>
    </div>`;
  const title = `${name} on Ember`;
  const summary = `${fmt(s.members)} member${s.members === 1 ? '' : 's'}${s.description ? ' · ' + s.description.replace(/\s+/g, ' ').slice(0, 160) : ''}`;
  const ogImage = s.banner_url || s.icon_url;
  const initial = first(name);
  const host = (() => { try { return new URL(s.url).host; } catch { return s.url; } })();
  const stat = (k, ic, label, v) => `<div class="stat"><div class="k">${icon(ic, 16)}${label}</div><div class="v" data-s="${k}">${v}</div></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(summary)}">
<meta name="theme-color" content="#9d8ad1">
<link rel="canonical" href="${esc(s.url)}/">
${s.icon_url ? `<link rel="icon" href="${esc(s.icon_url)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Ember">
<meta property="og:title" content="${esc(name)}">
<meta property="og:description" content="${esc(summary)}">
<meta property="og:url" content="${esc(s.url)}/">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ''}
<meta name="twitter:card" content="${s.banner_url ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(name)}">
<meta name="twitter:description" content="${esc(summary)}">
${ogImage ? `<meta name="twitter:image" content="${esc(ogImage)}">` : ''}
<style>${CSS}</style>
</head>
<body>
<main class="wrap">
  <div class="top">
    <span class="live"><span id="dot" class="dot"></span><span id="st">Online</span></span>
    <span class="sp"></span>
    <span>Ember server</span>
  </div>

  <section class="card" aria-label="Server">
    <div class="banner">${s.banner_url ? `<img src="${esc(s.banner_url)}" alt="">` : ''}</div>
    <div class="head">
      <div class="ic">${s.icon_url ? `<img src="${esc(s.icon_url)}" alt="">` : initial}</div>
      <div class="who">
        <h1>${esc(name)}</h1>
        <div class="meta">
          <span>${icon('users', 16)}<b data-s="members">${fmt(s.members)}</b> members</span>
          <span>${icon('activity', 16)}<b data-s="online">${fmt(s.online)}</b> online</span>
          <span>${icon('hash', 16)}<b>${fmt(s.servers.length)}</b> server${s.servers.length === 1 ? '' : 's'} listed</span>
        </div>
      </div>
    </div>
    ${s.description ? `<p class="desc">${esc(s.description)}</p>` : ''}
    <div class="acts">
      <a class="btn primary" href="${esc(s.ember_url)}" rel="noopener">${icon('flame')}Open in Ember</a>
      <a class="btn" href="${NOOKARA}/ember/download" rel="noopener">${icon('monitor')}Get the app</a>
    </div>
  </section>

  <h2>Servers</h2>
  <div class="list">
    ${s.servers.length ? s.servers.map(server).join('\n    ') : '<div class="none">No servers are listed here yet.</div>'}
  </div>

  <h2>Live</h2>
  <div class="stats">
    ${stat('online', 'activity', 'Online now', fmt(s.online))}
    ${stat('members', 'users', 'Members', fmt(s.members))}
    ${stat('connections', 'plug', 'Connections', fmt(s.connections))}
    ${stat('channels', 'hash', 'Channels', fmt(s.channels))}
    ${stat('uptime', 'clock', 'Uptime', fmtUptime(s.uptime_s))}
  </div>

  <h2>How to join</h2>
  <div class="steps">
    <div class="step"><span class="n">1</span><h3>Open it in Ember</h3><p>The buttons above open Ember on the web with a server ready to join. Sign in with your Nookara account if you are asked.</p></div>
    <div class="step"><span class="n">2</span><h3>Or add it by address</h3><p>In Ember, open Create a server, pick By address and paste:</p>
      <div class="url"><code id="srv">${esc(s.url)}</code><button id="cp" type="button" aria-label="Copy server address" data-ic="${esc(icon('copy', 16))}" data-ok="${esc(icon('check', 16))}">${icon('copy', 16)}</button></div></div>
    <div class="step"><span class="n">3</span><h3>Use the apps</h3><p>Ember also runs as an app with notifications and more.</p>
      <div class="apps">
        <a href="${NOOKARA}/ember/download?os=windows" rel="noopener">${icon('monitor', 15)}Windows</a>
        <a href="${NOOKARA}/ember/download?os=mac" rel="noopener">${icon('laptop', 15)}macOS</a>
        <a href="${NOOKARA}/ember/android/" rel="noopener">${icon('phone', 15)}Android</a>
      </div></div>
  </div>

  <footer>
    <span>${icon('flame', 14)}Ember server ${esc(s.version)}</span>
    <span>${esc(host)}</span>
    <a href="https://github.com/Ikelene/ember-server" rel="noopener">${icon('code', 14)}Run your own</a>
  </footer>
</main>
<script>${JS}</script>
</body>
</html>`;
}

const CSP = "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sendPage(req, res) {
  const body = page();
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache',
    'Content-Security-Policy': CSP, 'Referrer-Policy': 'strict-origin-when-cross-origin', Vary: 'Accept',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// the JSON the stats endpoint returns (same numbers the page shows)
function publicStats() {
  const s = stats();
  return {
    name: s.name, description: s.description, domain: s.domain, icon_url: s.icon_url, banner_url: s.banner_url, servers: s.servers,
    members: s.members, online: s.online, connections: s.connections, channels: s.channels,
    uptime_s: s.uptime_s, started_at: s.started_at, version: s.version, join_policy: s.join_policy, url: s.url, ember_url: s.ember_url,
  };
}

module.exports = { wantsHtml, sendPage, publicStats, page, emberLink, resetCache };
