'use strict';
// The homeserver's look on its own pages (PROTOCOL §5e): /login and the pages around it, /account, the invite page, the landing
// page, error pages. A homeserver admin sets `branding` (name, icon, banner, logo, accent, theme tokens, custom CSS); every value
// is checked here and the pages get it as stylesheets this server makes (no inline styles, no scripts):
//   /_ember/page/<name>.css   the pages' own rules (login-page.js and the page modules register them)
//   /branding/theme.css       the theme as CSS custom properties, from the checked tokens only
//   /branding/custom.css      the admin's own CSS, after the theme (refused when it imports, runs script-like things or loads from
//                             elsewhere than https: or this homeserver)
// Discovery publishes the resolved tokens (never the custom CSS) so clients can tint this homeserver's chips and cards.
// Only homeserver admins write any of it (PATCH /api/v2/homeserver/branding): nothing a member sends reaches a stylesheet.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { err } = require('./util');

const HEX = /^#[0-9a-f]{6}$/;
const COLORS = ['accent', 'background', 'surface', 'text', 'muted', 'border'];
const SCHEMES = ['dark', 'light', 'auto'];
// the built-in palette (the pages' own CSS): what a token that is not set falls back to
const DEFAULT_COLORS = {
  dark: { accent: '#9d8ad1', background: '#0e0e10', surface: '#141417', text: '#e7e7ea', muted: '#8b8b94', border: '#292930' },
  light: { accent: '#6f5bb0', background: '#f4f4f6', surface: '#ffffff', text: '#18181b', muted: '#5d5d68', border: '#dcdce2' },
};
// fonts: stacks of fonts people already have; "custom" is a font file uploaded here (theme.font_url)
const FONTS = {
  system: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
  sans: '"Helvetica Neue",Helvetica,Arial,sans-serif',
  serif: 'Georgia,"Times New Roman",Times,serif',
  mono: 'ui-monospace,Consolas,"Cascadia Code",Menlo,monospace',
  rounded: 'ui-rounded,"SF Pro Rounded",Nunito,"Varela Round",system-ui,sans-serif',
  humanist: '"Segoe UI","Gill Sans","Trebuchet MS",Calibri,sans-serif',
  custom: '"Homeserver Font",system-ui,sans-serif',
};
const DENSITY = { compact: 0.75, normal: 1, comfortable: 1.25 };
const CUSTOM_CSS_MAX = 50 * 1024;
const RANGES = { radius: [0, 24], button_radius: [0, 24], font_size: [12, 20], banner_height: [0, 320], page_width: [320, 960] };
const BRANDING_KEYS = ['name', 'icon_url', 'banner_url', 'logo_url', 'accent', 'theme', 'custom_css'];
const THEME_KEYS = ['scheme', 'dark', 'light', 'radius', 'button_radius', 'font', 'font_url', 'font_size', 'density', 'banner_height', 'banner_position', 'header', 'page_width', 'background_url'];

// ---------- colours ----------
const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// the text colour that reads on a colour: dark or light, whichever stands out more
const inkOn = hex => (contrast(hex, '#0e0e10') >= contrast(hex, '#ffffff') ? '#0e0e10' : '#ffffff');

// ---------- checking ----------
const bad = (field, reason = 'invalid') => err('invalid_branding', 400, { field, reason });
// an address a page may load: https anywhere, or this homeserver's own (its uploads; http too on an http dev server)
function assetUrl(v, field) {
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 512) throw bad(field);
  const own = config.publicUrl();
  let u;
  try { u = new URL(v.trim(), own + '/'); } catch { throw bad(field); }
  if (u.username || u.password || /["'()\\\s<>]/.test(u.href)) throw bad(field);
  if (u.protocol === 'https:' || u.origin === new URL(own).origin) return u.href;
  throw bad(field, 'https_or_own');
}
const color = (v, field) => { if (v === null || v === '') return null; if (typeof v === 'string' && HEX.test(v.trim().toLowerCase())) return v.trim().toLowerCase(); throw bad(field); };
const int = (v, field) => { if (v === null || v === '') return null; const [lo, hi] = RANGES[field]; if (Number.isInteger(v) && v >= lo && v <= hi) return v; throw bad('theme.' + field, 'out_of_range'); };
const oneOf = (v, list, field) => { if (v === null || v === '') return null; if (list.includes(v)) return v; throw bad(field); };

// custom CSS: what it may not do. Escapes are read and comments dropped first, so "@\69mport" or "exp/**/ression(" do not get by
function checkCss(css) {
  if (css === null || css === '') return null;
  if (typeof css !== 'string') throw bad('custom_css');
  if (Buffer.byteLength(css) > CUSTOM_CSS_MAX) throw bad('custom_css', 'too_large');
  if (css.includes('\0')) throw bad('custom_css');
  const plain = css
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (m, h) => { const n = parseInt(h, 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; })
    .replace(/\\(.)/g, '$1')
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, '')
    .toLowerCase();
  for (const [needle, reason] of [['@import', 'import'], ['expression(', 'expression'], ['javascript:', 'script_url'], ['vbscript:', 'script_url'], ['behavior', 'behavior'], ['-moz-binding', 'binding'], ['</style', 'markup'], ['<!--', 'markup'], ['<script', 'markup']]) {
    if (plain.replace(/\s+/g, needle.includes(' ') ? ' ' : '').includes(needle)) throw bad('custom_css', reason);
  }
  // every address it loads: url(...) and the strings of image-set(...)
  const targets = [...plain.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g)].map(m => m[1] ?? m[2] ?? m[3]);
  for (const m of plain.matchAll(/image-set\(([^)]*)\)/g)) for (const s of m[1].matchAll(/"([^"]*)"|'([^']*)'/g)) targets.push(s[1] ?? s[2]);
  if (/\bsrc\(/.test(plain)) throw bad('custom_css', 'src_function');
  const own = new URL(config.publicUrl()).origin.toLowerCase();
  for (const t of targets) {
    const x = t.trim();
    const ok = x.startsWith('https://') || (x.startsWith('/') && !x.startsWith('//')) || x.startsWith(own + '/') || /^data:image\/(png|gif|jpeg|webp);base64,/.test(x) || x.startsWith('#');
    if (!ok) throw bad('custom_css', 'url_not_allowed');
  }
  return css;
}

function cleanPalette(v, field) {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(field);
  const out = {};
  for (const k of Object.keys(v)) { if (!COLORS.includes(k)) throw bad(`${field}.${k}`, 'unknown'); out[k] = color(v[k], `${field}.${k}`); } // (null: back to the default)
  return out;
}
function cleanTheme(t) {
  if (t === null) return null;
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw bad('theme');
  const out = {};
  for (const k of Object.keys(t)) {
    if (!THEME_KEYS.includes(k)) throw bad('theme.' + k, 'unknown');
    const v = t[k];
    let c;
    if (k === 'scheme') c = oneOf(v, SCHEMES, 'theme.scheme');
    else if (k === 'dark' || k === 'light') c = cleanPalette(v, 'theme.' + k);
    else if (k in RANGES) c = int(v, k);
    else if (k === 'font') c = oneOf(v, Object.keys(FONTS), 'theme.font');
    else if (k === 'density') c = oneOf(v, Object.keys(DENSITY), 'theme.density');
    else if (k === 'banner_position') c = oneOf(v, ['top', 'center', 'bottom'], 'theme.banner_position');
    else if (k === 'header') c = oneOf(v, ['icon', 'logo'], 'theme.header');
    else c = assetUrl(v, 'theme.' + k); // font_url, background_url
    out[k] = c; // (null: back to the default)
  }
  return out;
}
// a (partial) branding object from an admin -> the checked values (null = back to the default)
function sanitize(p) {
  if (p === null) return null;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('branding');
  const out = {};
  for (const k of Object.keys(p)) {
    if (!BRANDING_KEYS.includes(k)) throw bad(k, 'unknown');
    const v = p[k];
    if (k === 'name') {
      if (v === null || v === '') out.name = null;
      else if (typeof v === 'string' && Array.from(v.trim()).length >= 1 && Array.from(v.trim()).length <= 64 && !/[\u0000-\u001f]/.test(v)) out.name = v.trim();
      else throw bad('name');
    } else if (k === 'accent') out.accent = color(v, 'accent');
    else if (k === 'theme') out.theme = cleanTheme(v);
    else if (k === 'custom_css') out.custom_css = checkCss(v);
    else out[k] = assetUrl(v, k); // icon_url, banner_url, logo_url
  }
  return out;
}
// saved + a change: keys set to null go back to the default; theme and its palettes merge the same way
function merge(cur = {}, patch = {}) {
  const out = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) { delete out[k]; continue; }
    if (k === 'theme') {
      const t = { ...(cur.theme || {}) };
      for (const [tk, tv] of Object.entries(v)) {
        if (tv === null) delete t[tk];
        else if (tk === 'dark' || tk === 'light') { const p = { ...(t[tk] || {}), ...tv }; for (const c of Object.keys(p)) if (p[c] === null) delete p[c]; if (Object.keys(p).length) t[tk] = p; else delete t[tk]; }
        else t[tk] = tv;
      }
      if (Object.keys(t).length) out.theme = t; else delete out.theme;
    } else out[k] = v;
  }
  return out;
}

// everything the pages and clients use, with the defaults filled in; throws invalid_branding / low_contrast for colours that do
// not read (checked on save, so a page never gets them)
function resolve(b = {}) {
  const cfg = config.get(), t = b.theme || {};
  const scheme = t.scheme || 'auto';
  const colors = {};
  for (const s of ['dark', 'light']) {
    const c = { ...DEFAULT_COLORS[s], ...(b.accent ? { accent: b.accent } : {}), ...(t[s] || {}) };
    c.accent_ink = inkOn(c.accent);
    // links and focus rings use the accent where it reads on the cards, the text colour where it does not
    c.link = contrast(c.accent, c.surface) >= 3 ? c.accent : c.text;
    colors[s] = c;
  }
  const icon = b.icon_url || absolute(cfg.icon_url);
  return {
    domain: cfg.domain,
    name: b.name || cfg.name || 'Ember server',
    icon_url: icon,
    banner_url: b.banner_url || null,
    logo_url: b.logo_url || null,
    accent: b.accent || null,
    theme: {
      scheme, colors, radius: t.radius ?? 0, button_radius: t.button_radius ?? t.radius ?? 0,
      font: t.font || 'system', font_stack: FONTS[t.font || 'system'], font_url: t.font === 'custom' ? t.font_url || null : null,
      font_size: t.font_size ?? 15, density: t.density || 'normal',
      banner_height: t.banner_height ?? 120, banner_position: t.banner_position || 'center',
      header: t.header === 'logo' && b.logo_url ? 'logo' : 'icon', page_width: t.page_width ?? null, background_url: t.background_url || null,
    },
    custom_css: !!b.custom_css,
  };
}
// the colour pairs that have to read; -> throws low_contrast naming the first that does not
function checkContrast(b) {
  const r = resolve(b), t = b.theme || {};
  const schemes = r.theme.scheme === 'auto' ? ['dark', 'light'] : [r.theme.scheme];
  if (t.font === 'custom' && !t.font_url) throw bad('theme.font_url', 'missing');
  for (const s of schemes) {
    const c = r.theme.colors[s];
    if (contrast(c.text, c.background) < 4.5) throw bad(`theme.${s}.text`, 'low_contrast');
    if (contrast(c.text, c.surface) < 4.5) throw bad(`theme.${s}.text`, 'low_contrast');
    if (contrast(c.muted, c.surface) < 3) throw bad(`theme.${s}.muted`, 'low_contrast');
  }
  return r;
}
function absolute(u) {
  if (!u) return null;
  try { const x = new URL(String(u), config.publicUrl() + '/'); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}

// ---------- stylesheets ----------
const pageSheets = new Map(); // name -> css (the pages' own rules)
const pageScripts = new Map(); // name -> js (the landing page's live numbers: a file of this server, never inline)
const registerSheet = (name, css) => { pageSheets.set(name, css); };
const registerScript = (name, js) => { pageScripts.set(name, js); };
const hash = s => crypto.createHash('sha256').update(s).digest('base64url').slice(0, 12);
const vars = c => `--bg:${c.background};--surface:${c.surface};--surface-2:color-mix(in srgb,${c.surface} 88%,${c.text});--border:${c.border};--border-2:color-mix(in srgb,${c.border} 80%,${c.text});--text:${c.text};--muted:${c.muted};--faint:${c.muted};--accent:${c.accent};--accent-ink:${c.accent_ink};--link:${c.link}`;
// the theme as CSS: custom properties, then the few rules that use them. Every value in it was checked above.
function themeCss(b) {
  const r = resolve(b), t = r.theme, saved = b.theme || {};
  const out = [];
  const set = b.accent || saved.dark || saved.light || saved.scheme;
  if (set) {
    if (t.scheme === 'auto') out.push(`:root{color-scheme:dark;${vars(t.colors.dark)}}`, `@media (prefers-color-scheme:light){:root{color-scheme:light;${vars(t.colors.light)}}}`);
    else out.push(`:root{color-scheme:${t.scheme};${vars(t.colors[t.scheme])}}`, `@media (prefers-color-scheme:light){:root{color-scheme:${t.scheme};${vars(t.colors[t.scheme])}}}`);
    out.push('a{color:var(--link)}', 'input:focus-visible,textarea:focus-visible,select:focus-visible,.btn:focus-visible,a:focus-visible{outline-color:var(--link)}');
  }
  if (t.font_url) out.push(`@font-face{font-family:"Homeserver Font";src:url("${t.font_url}");font-display:swap}`);
  if (saved.font || saved.font_size) out.push(`html,body{font-family:${t.font_stack};font-size:${t.font_size}px}`, `input,textarea,select,button{font-family:inherit}`);
  if (saved.radius !== undefined) out.push(`.card,.msg,input,textarea,select,.srv,.stat,.step,.url,.ic,.si,.av,.live,.none,.hb{border-radius:${t.radius}px}`);
  if (saved.button_radius !== undefined || saved.radius !== undefined) out.push(`.btn,.apps a,.url button{border-radius:${t.button_radius}px}`);
  if (t.density !== 'normal') { const d = DENSITY[t.density]; out.push(`:root{--pad:${Math.round(24 * d)}px}`,`.wrap{padding-top:${Math.round(48 * d)}px;padding-bottom:${Math.round(48 * d)}px}`, `.btn{padding:${Math.round(11 * d)}px ${Math.round(16 * d)}px}`, `label{margin-top:${Math.round(12 * d)}px}`); }
  if (t.page_width) out.push(`.wrap{max-width:${t.page_width}px}`);
  if (t.background_url) out.push(`body{background-image:url("${t.background_url}");background-size:cover;background-position:center;background-attachment:fixed}`);
  if (saved.banner_height !== undefined) out.push(`.banner{height:${t.banner_height}px}`);
  out.push(`.hb{height:${t.banner_height}px}`, `.hb img,.banner img{object-position:center ${t.banner_position}}`);
  return out.join('\n') + '\n';
}

// what a page's <head> links, for the saved branding or a preview's draft
function links(b, { prefix = '/branding' } = {}) {
  const theme = themeCss(b);
  const tags = [`<link rel="stylesheet" href="${prefix}/theme.css?v=${hash(theme)}">`];
  if (b.custom_css) tags.push(`<link rel="stylesheet" href="${prefix}/custom.css?v=${hash(b.custom_css)}">`);
  return tags.join('\n');
}
const pageLink = name => (pageSheets.has(name) ? `<link rel="stylesheet" href="/_ember/page/${name}.css?v=${hash(pageSheets.get(name))}">` : '');
const scriptTag = name => (pageScripts.has(name) ? `<script src="/_ember/page/${name}.js?v=${hash(pageScripts.get(name))}"></script>` : '');
const saved = () => config.get().branding || {};

// the Content-Security-Policy of the homeserver's pages: its own stylesheets only (no inline styles), pictures and fonts from
// itself or https, no scripts unless a page names its own
function csp({ formTo = null, form = "'self'", script = null, connect = null, frameAncestors = null } = {}) {
  return [
    "default-src 'none'", "img-src 'self' https: data:", "font-src 'self' https:", "style-src 'self'",
    ...(script ? [`script-src ${script}`] : []), ...(connect ? [`connect-src ${connect}`] : []),
    "base-uri 'none'", `form-action ${form}${formTo ? ' ' + formTo : ''}`, `frame-ancestors ${frameAncestors || "'none'"}`,
  ].join('; ');
}

// ---------- uploads (admins): pictures and a font file for the pages ----------
const KINDS = { icon: 'image', banner: 'image', logo: 'image', background: 'image', font: 'font' };
const MAX = { image: 5 * 1024 * 1024, font: 2 * 1024 * 1024 };
const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };
const dir = () => path.join(config.dir(), 'branding');
function fontType(b) {
  const head = b.subarray(0, 4).toString('latin1');
  if (head === 'wOF2') return 'woff2';
  if (head === 'wOFF') return 'woff';
  if (head === 'OTTO') return 'otf';
  if (b.length >= 4 && b.readUInt32BE(0) === 0x00010000) return 'ttf';
  return null;
}
async function upload(req) {
  const kind = String(req.query.kind || '');
  if (!KINDS[kind]) throw err('invalid_kind', 400);
  const { buffer } = await require('./uploads').readMultipart(req, { maxBytes: MAX[KINDS[kind]] });
  if (!buffer || !buffer.length) throw err('no_file', 400);
  let ext;
  if (KINDS[kind] === 'font') ext = fontType(buffer);
  else { const s = require('./uploads').sniff(buffer); ext = s && ['png', 'jpg', 'gif', 'webp'].includes(s.ext) ? s.ext : null; }
  if (!ext) throw err('unsupported_type', 415);
  const data = ext === 'jpg' ? require('./uploads').stripJpegExif(buffer) : buffer;
  const name = `${crypto.createHash('sha256').update(data).digest('hex').slice(0, 24)}.${ext}`;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), name), data);
  return { kind, url: `${config.publicUrl()}/branding/files/${name}`, size: data.length, type: TYPES[ext] };
}
function serveFile(req, res) {
  const name = String(req.params.name || '');
  const m = /^[0-9a-f]{24}\.(png|jpg|gif|webp|woff2|woff|ttf|otf)$/.exec(name);
  let data = null;
  if (m) { try { data = fs.readFileSync(path.join(dir(), name)); } catch { data = null; } }
  if (!data) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"not_found"}'); }
  res.writeHead(200, { 'Content-Type': TYPES[m[1]], 'Content-Length': data.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'cross-origin' });
  res.end(req.method === 'HEAD' ? undefined : data);
}

// ---------- previews (admins): the sign-in page with branding that is not saved yet, for a client's live preview ----------
const drafts = new Map(); // id -> { branding, exp }
const PREVIEW_TTL = 10 * 60 * 1000;
function preview(body = {}) {
  const change = sanitize(body.branding ?? {});
  const draft = merge(saved(), change || {});
  checkContrast(draft);
  const t = Date.now();
  for (const [k, v] of drafts) if (v.exp < t) drafts.delete(k);
  if (drafts.size > 200) drafts.delete(drafts.keys().next().value);
  const id = crypto.randomBytes(18).toString('base64url');
  drafts.set(id, { branding: draft, exp: t + PREVIEW_TTL });
  const pageName = ['login', 'message'].includes(body.page) ? body.page : 'login';
  return { url: `${config.publicUrl()}/branding/preview/${id}${pageName === 'login' ? '' : '?page=' + pageName}`, expires_at: t + PREVIEW_TTL, homeserver: resolve(draft) };
}
const draftOf = id => { const d = drafts.get(String(id || '')); return d && d.exp > Date.now() ? d.branding : null; };

function sendCss(res, req, css, cache = 'public, max-age=300') {
  res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Content-Length': Buffer.byteLength(css), 'Cache-Control': cache, 'Content-Security-Policy': "default-src 'none'" });
  res.end(req.method === 'HEAD' ? undefined : css);
}
const notFound = res => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not_found"}'); };

// GET/PATCH/DELETE /api/v2/homeserver/branding (admins)
function adminView() { const b = saved(); return { branding: b, homeserver: resolve(b), fonts: Object.keys(FONTS), limits: { name: 64, custom_css_bytes: CUSTOM_CSS_MAX, ...Object.fromEntries(Object.entries(RANGES)) } }; }
function save(body) { // (null: everything back to the default)
  const change = body === null ? null : sanitize(body || {});
  const next = change === null ? {} : merge(saved(), change);
  checkContrast(next);
  config.update({ branding: Object.keys(next).length ? next : null });
  return adminView();
}

function register(app) {
  app.get('/api/v2/homeserver/branding', { admin: true }, () => adminView());
  app.patch('/api/v2/homeserver/branding', { admin: true }, req => save(req.body));
  app.delete('/api/v2/homeserver/branding', { admin: true }, () => save(null));
  app.post('/api/v2/homeserver/branding/upload', { admin: true }, req => upload(req));
  app.post('/api/v2/homeserver/branding/preview', { admin: true }, req => preview(req.body || {}));
  app.get('/branding/theme.css', { auth: false }, (req, res) => sendCss(res, req, themeCss(saved())));
  app.get('/branding/custom.css', { auth: false }, (req, res) => sendCss(res, req, saved().custom_css || ''));
  app.get('/branding/files/:name', { auth: false }, serveFile);
  app.get('/_ember/page/:name', { auth: false }, (req, res) => {
    const m = /^([a-z]+)\.(css|js)$/.exec(String(req.params.name || ''));
    if (m && m[2] === 'css' && pageSheets.has(m[1])) return sendCss(res, req, pageSheets.get(m[1]), 'public, max-age=86400');
    if (m && m[2] === 'js' && pageScripts.has(m[1])) {
      const js = pageScripts.get(m[1]);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': Buffer.byteLength(js), 'Cache-Control': 'public, max-age=86400' });
      return res.end(req.method === 'HEAD' ? undefined : js);
    }
    notFound(res);
  });
  app.get('/branding/preview/:id', { auth: false }, (req, res) => {
    const b = draftOf(req.params.id);
    if (!b) return notFound(res);
    const page = require('./login-page');
    page.send(res, 200, page.previewPage(b, req.params.id, req.query.page), { preview: true });
  });
  app.get('/branding/preview/:id/theme.css', { auth: false }, (req, res) => { const b = draftOf(req.params.id); return b ? sendCss(res, req, themeCss(b), 'no-store') : notFound(res); });
  app.get('/branding/preview/:id/custom.css', { auth: false }, (req, res) => { const b = draftOf(req.params.id); return b ? sendCss(res, req, b.custom_css || '', 'no-store') : notFound(res); });
}

// discovery's `homeserver` (PROTOCOL §5e): the name, pictures and resolved tokens, never the custom CSS
function discovery() {
  let r;
  try { r = resolve(saved()); } catch { r = resolve({}); }
  const { custom_css, ...pub } = r;
  return pub;
}

module.exports = { register, sanitize, merge, resolve, checkContrast, checkCss, themeCss, links, pageLink, scriptTag, registerSheet, registerScript, saved, csp, discovery, contrast, inkOn, FONTS, DEFAULT_COLORS, _test: { drafts } };
