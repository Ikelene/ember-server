'use strict';
// The homeserver's look on its own pages (branding.js, PROTOCOL §5e): what admins may set and what is refused, the generated
// stylesheets, the pages that use them under a CSP with no inline styles or scripts, uploads, previews and discovery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL', 'EMBER_PLAN', 'EMBER_LIMITS']) delete process.env[k];
const { startServer } = require('../src/index');

const dir = tmpDir();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let inst, base, admin, member;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
const html = async (p, headers = {}) => { const r = await fetch(base + p, { headers: { Accept: 'text/html', ...headers }, redirect: 'manual' }); return { status: r.status, csp: r.headers.get('content-security-policy') || '', xfo: r.headers.get('x-frame-options'), text: await r.text() }; };
const text = async p => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };
const P = b => admin.a.patch('/api/v2/homeserver/branding', b);
const refused = async (b, field, reason) => { const r = await P(b); assert.equal(r.status, 400, JSON.stringify(b)); assert.equal(r.body.error, 'invalid_branding'); assert.equal(r.body.field, field, JSON.stringify(r.body)); if (reason) assert.equal(r.body.reason, reason); };
const upload = (kind, buf, session = admin.session) => { const f = new FormData(); f.append('file', new Blob([buf]), 'x'); return fetch(`${base}/api/v2/homeserver/branding/upload?kind=${kind}`, { method: 'POST', headers: { Authorization: 'Bearer ' + session }, body: f }).then(async r => ({ status: r.status, body: await r.json() })); };
// what every page of the homeserver must be: its own stylesheets, no inline style, no inline script
function plainPage(p) {
  assert.ok(!/<style/i.test(p.text), 'no <style>');
  assert.ok(!/\sstyle="/i.test(p.text), 'no style attributes');
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(p.text), 'no inline <script>');
  assert.match(p.csp, /style-src 'self'(;|$)/);
  assert.ok(!p.csp.includes('unsafe-inline'), p.csp);
  assert.match(p.text, /<link rel="stylesheet" href="\/_ember\/page\/[a-z]+\.css\?v=/);
  assert.match(p.text, /<link rel="stylesheet" href="\/branding\/theme\.css\?v=/);
}

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('unset: the default look, published in discovery with its resolved tokens', async () => {
  admin = await reg('admin'); member = await reg('member');
  await admin.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  await admin.a.post('/api/v1/servers', { name: 'Town', slug: 'town', join_policy: 'open' });
  const hs = (await api(base).get('/.well-known/ember')).body.homeserver;
  assert.equal(hs.domain, 'localhost');
  assert.equal(hs.name, 'Ember Instance');
  assert.deepEqual([hs.banner_url, hs.logo_url, hs.accent, hs.theme.scheme, hs.theme.colors.dark.accent, hs.theme.colors.light.background], [null, null, null, 'auto', '#9d8ad1', '#f4f4f6']);
  assert.equal(hs.custom_css, undefined);
  const login = await html('/login?response_type=code&client_id=ember&redirect_uri=' + encodeURIComponent(base + '/account/callback'));
  plainPage(login);
  assert.ok(!login.text.includes('/branding/custom.css'), 'no custom sheet while there is none');
  const css = await text('/_ember/page/base.css');
  assert.deepEqual([css.status, css.type], [200, 'text/css; charset=utf-8']);
  assert.match(css.text, /--accent:#9d8ad1/);
});

test('only homeserver admins read and change it', async () => {
  assert.equal((await member.a.get('/api/v2/homeserver/branding')).status, 403);
  assert.equal((await member.a.patch('/api/v2/homeserver/branding', { name: 'Mine' })).status, 403);
  assert.equal((await member.a.post('/api/v2/homeserver/branding/preview', {})).status, 403);
  assert.equal((await upload('icon', PNG, member.session)).status, 403);
  const v = (await admin.a.get('/api/v2/homeserver/branding')).body;
  assert.deepEqual([v.branding, v.fonts.includes('serif'), v.limits.custom_css_bytes], [{}, true, 51200]);
});

test('every value is checked; colours that do not read are refused', async () => {
  await refused({ name: '   ' }, 'name');
  await refused({ name: 'x'.repeat(65) }, 'name');
  await refused({ accent: 'purple' }, 'accent');
  await refused({ accent: '#12345' }, 'accent');
  await refused({ colour: '#123456' }, 'colour', 'unknown');
  await refused({ icon_url: 'http://elsewhere.example/a.png' }, 'icon_url', 'https_or_own');
  await refused({ icon_url: 'javascript:alert(1)' }, 'icon_url');
  await refused({ banner_url: 'https://x.example/a.png")' }, 'banner_url');
  await refused({ theme: { radius: 25 } }, 'theme.radius', 'out_of_range');
  await refused({ theme: { font: 'comic' } }, 'theme.font');
  await refused({ theme: { scheme: 'sepia' } }, 'theme.scheme');
  await refused({ theme: { dark: { accent: 'red' } } }, 'theme.dark.accent');
  await refused({ theme: { dark: { glow: '#ffffff' } } }, 'theme.dark.glow', 'unknown');
  await refused({ theme: { font: 'custom' } }, 'theme.font_url', 'missing');
  await refused({ theme: { scheme: 'dark', dark: { text: '#222222' } } }, 'theme.dark.text', 'low_contrast');
  await refused({ theme: { scheme: 'light', light: { muted: '#eeeeee' } } }, 'theme.light.muted', 'low_contrast');
  // (a light scheme only checks the light colours)
  assert.equal((await P({ theme: { scheme: 'light', dark: { text: '#222222' } } })).status, 200);
  assert.equal((await admin.a.del('/api/v2/homeserver/branding')).status, 200);
});

test('custom CSS: no imports, nothing script-like, no addresses but https and this homeserver, at most 50 KB', async () => {
  for (const [css, reason] of [
    ['@import url(https://x.example/a.css);', 'import'], ['@\\69mport "x.css";', 'import'], ['a{width:exp/**/ression(alert(1))}', 'expression'],
    ['a{background:url(javascript:alert(1))}', 'script_url'], ['a{behavior:url(x.htc)}', 'behavior'], ['a{-moz-binding:url(x.xml#x)}', 'binding'],
    ['</style><script>alert(1)</script>', 'markup'], ['a{background:url(http://evil.example/x.png)}', 'url_not_allowed'],
    ['a{background:url("//evil.example/x.png")}', 'url_not_allowed'], ['a{background-image:image-set("http://evil.example/x.png" 1x)}', 'url_not_allowed'],
  ]) await refused({ custom_css: css }, 'custom_css', reason);
  await refused({ custom_css: 'a{}'.repeat(20000) }, 'custom_css', 'too_large');
  const ok = '.card{box-shadow:0 2px 8px #0004}\n.hs h1{letter-spacing:.02em;background:url(https://cdn.example/x.png),url(/branding/files/a.png)}';
  assert.equal((await P({ custom_css: ok })).status, 200);
});

test('saved: the theme as custom properties, the custom sheet after it, on every page; discovery has the tokens only', async () => {
  const r = await P({ name: 'Town Hall', accent: '#ffcc00', theme: { radius: 8, button_radius: 20, font: 'serif', font_size: 16, density: 'compact', banner_height: 160, banner_position: 'top', page_width: 520, light: { background: '#fffdf5' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.homeserver.theme.colors.dark.accent_ink, '#0e0e10', 'dark ink on a light accent');
  assert.equal(r.body.homeserver.theme.colors.light.link, '#18181b', 'a yellow link does not read on white: the text colour instead');
  // a partial change merges; null takes one value back
  await P({ theme: { page_width: null } });
  const saved = (await admin.a.get('/api/v2/homeserver/branding')).body.branding;
  assert.deepEqual([saved.theme.radius, saved.theme.page_width, saved.theme.light, saved.custom_css.startsWith('.card')], [8, undefined, { background: '#fffdf5' }, true]);

  const theme = await text('/branding/theme.css');
  assert.equal(theme.type, 'text/css; charset=utf-8');
  for (const s of ['--accent:#ffcc00', '--accent-ink:#0e0e10', '--bg:#fffdf5', 'border-radius:8px', 'border-radius:20px', 'Georgia', 'font-size:16px', '--pad:18px', '.hb{height:160px}', 'object-position:center top']) assert.ok(theme.text.includes(s), s);
  assert.ok(theme.text.indexOf('prefers-color-scheme:light') > 0);
  assert.match((await text('/branding/custom.css')).text, /box-shadow/);

  const pages = [await html('/login?response_type=code&client_id=ember&redirect_uri=' + encodeURIComponent(base + '/account/callback')), await html('/account/payments/linked?state=nope'), await html('/no/such/page'), await html('/i/town/nope')];
  for (const p of pages) {
    plainPage(p);
    assert.match(p.text, /<h1>Town Hall<\/h1>/);
    const at = p.text.indexOf('/branding/theme.css'), custom = p.text.indexOf('/branding/custom.css');
    assert.ok(custom > at, 'the custom sheet comes after the theme');
  }
  assert.equal(pages[2].status, 404, 'a browser gets the homeserver\'s own 404 page');
  assert.equal((await fetch(base + '/no/such/page')).headers.get('content-type'), 'application/json; charset=utf-8', 'anything else still gets JSON');

  const hs = (await api(base).get('/.well-known/ember')).body.homeserver;
  assert.deepEqual([hs.name, hs.accent, hs.theme.radius, hs.theme.font, hs.theme.colors.light.background], ['Town Hall', '#ffcc00', 8, 'serif', '#fffdf5']);
  assert.ok(!JSON.stringify(hs).includes('box-shadow'), 'the custom CSS is not published');
});

test('uploads: pictures and a font file of the homeserver\'s own, used by address', async () => {
  const icon = await upload('icon', PNG);
  assert.equal(icon.status, 200, JSON.stringify(icon.body));
  assert.match(icon.body.url, /\/branding\/files\/[0-9a-f]{24}\.png$/);
  const f = await fetch(icon.body.url);
  assert.deepEqual([f.status, f.headers.get('content-type'), f.headers.get('x-content-type-options')], [200, 'image/png', 'nosniff']);
  assert.equal((await upload('icon', Buffer.from('<svg onload=alert(1)>'))).status, 415);
  assert.equal((await upload('font', PNG)).status, 415);
  const font = await upload('font', Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60)]));
  assert.match(font.body.url, /\.woff2$/);
  assert.equal((await upload('sticker', PNG)).body.error, 'invalid_kind');
  assert.equal((await P({ icon_url: icon.body.url, banner_url: icon.body.url, theme: { font: 'custom', font_url: font.body.url } })).status, 200);
  const login = await html('/login?response_type=code&client_id=ember&redirect_uri=' + encodeURIComponent(base + '/account/callback'));
  assert.ok(login.text.includes(`<div class="hb"><img src="${icon.body.url}" alt=""></div>`), 'the banner heads the card');
  assert.match((await text('/branding/theme.css')).text, /@font-face\{font-family:"Homeserver Font";src:url\("[^"]+\.woff2"\)/);
  // the logo instead of the icon and name (the name stays for screen readers)
  const logo = await upload('logo', PNG);
  await P({ logo_url: logo.body.url, theme: { header: 'logo' } });
  assert.match((await html('/i/town/nope')).text, /<img class="logo" src="[^"]+" alt="Town Hall"><h1 class="sr">Town Hall<\/h1>/);
});

test('preview: the sign-in page with unsaved branding, for a client to frame; nothing is saved', async () => {
  const before = (await admin.a.get('/api/v2/homeserver/branding')).body.branding;
  assert.equal((await admin.a.post('/api/v2/homeserver/branding/preview', { branding: { accent: 'nope' } })).body.field, 'accent');
  const r = await admin.a.post('/api/v2/homeserver/branding/preview', { branding: { accent: '#3366ff', custom_css: '.card{outline:1px solid red}' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.homeserver.accent, '#3366ff');
  const id = new URL(r.body.url).pathname.split('/').pop();
  const p = await fetch(r.body.url);
  const body = await p.text(), csp = p.headers.get('content-security-policy');
  assert.equal(p.status, 200);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-ancestors [^;]*https:\/\/nookara\.cc/);
  assert.equal(p.headers.get('x-frame-options'), null);
  assert.ok(body.includes(`/branding/preview/${id}/theme.css`) && body.includes(`/branding/preview/${id}/custom.css`));
  assert.match((await text(`/branding/preview/${id}/theme.css`)).text, /--accent:#3366ff/);
  assert.match((await text(`/branding/preview/${id}/custom.css`)).text, /outline/);
  assert.deepEqual((await admin.a.get('/api/v2/homeserver/branding')).body.branding, before);
  assert.ok(!(await text('/branding/theme.css')).text.includes('#3366ff'));
  assert.equal((await fetch(`${base}/branding/preview/made-up`)).status, 404);
});

test('the landing page: its own sheets and script file, no inline script; reset brings the defaults back', async () => {
  const p = await html('/');
  assert.equal(p.status, 200);
  plainPage(p);
  assert.match(p.text, /<script src="\/_ember\/page\/landing\.js\?v=[^"]+"><\/script>/);
  assert.match(p.csp, /script-src 'self'/);
  assert.match((await text('/_ember/page/landing.js')).text, /instance\/stats/);
  assert.match(p.text, /<h1>Town Hall<\/h1>/);
  assert.equal((await admin.a.del('/api/v2/homeserver/branding')).body.branding.name, undefined);
  assert.equal((await api(base).get('/.well-known/ember')).body.homeserver.name, 'Ember Instance');
  assert.ok(!(await html('/no/such')).text.includes('/branding/custom.css'));
});
