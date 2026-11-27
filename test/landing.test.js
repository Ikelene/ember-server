'use strict';
// "/" for a browser = the landing page; every other client keeps the JSON. /api/v1/instance/stats = public counts only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
delete process.env.EMBER_OWNER;
const dir = tmpDir();
let inst, base, alice, bob, sid;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const get = (p, accept, method = 'GET') => fetch(base + p, { method, headers: accept ? { Accept: accept } : {} });

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('before setup: the page still renders (no community yet)', async () => {
  const r = await get('/', BROWSER);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  const html = await r.text();
  assert.match(html, /<title>Ember Instance on Ember<\/title>/);
});

test('setup + a second member', async () => {
  alice = await reg('alice'); bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp <Fire> & "Friends"', description: 'cosy <script>alert(1)</script> place', join_policy: 'open' })).body;
  sid = d.server.sid;
  assert.equal((await bob.a.post(`/api/v1/servers/${sid}/join`)).status, 200);
  require('../src/landing').resetCache();
});

test('non-browser clients get exactly the old JSON at /', async () => {
  for (const accept of [null, '*/*', 'application/json']) {
    const r = await get('/', accept);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/json/);
    const j = await r.json();
    assert.equal(j.software, 'bonfire-server');
    assert.equal(j.discovery, '/.well-known/ember');
    assert.deepEqual(Object.keys(j).sort(), ['about', 'discovery', 'open_protocol', 'protocol', 'protocol_docs', 'software', 'version']);
  }
});

test('a browser gets the landing page: escaped name/description, stats, join link, og tags, csp', async () => {
  const r = await get('/', BROWSER);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html; charset=utf-8/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(r.headers.get('vary'), /Accept/);
  const html = await r.text();
  assert.ok(html.includes('Camp &lt;Fire&gt; &amp; &quot;Friends&quot;'));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'description is escaped');
  assert.ok(html.includes('cosy &lt;script&gt;'));
  assert.match(html, /<meta property="og:title" content="Ember Instance">/); // the homeserver's own name on top
  assert.match(html, /<meta property="og:description" content="2 members">/);
  assert.match(html, /<div class="sa">camp-fire-friends@localhost<\/div>/);
  assert.match(html, /<meta name="twitter:card" content="summary">/);
  // http dev server: the long #/i/ form
  assert.ok(html.includes(`https://ember.nookara.cc/#/i/${encodeURIComponent(base.replace('127.0.0.1', 'localhost'))}`) || html.includes('https://ember.nookara.cc/#/i/http'));
  assert.match(html, /data-s="members">2</);
  assert.match(html, /Anyone can join/);
  assert.ok(!/border-radius:\s*[1-9]/.test(html), 'no rounded corners');
  assert.ok(!html.includes(alice.user.id) && !html.includes('alice') && !html.includes('bob'), 'no member names or ids');
  const head = await get('/', BROWSER, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal((await head.text()), '');
});

test('stats endpoint: counts follow live sockets, nothing private', async () => {
  const before = await api(base).get('/api/v1/instance/stats');
  assert.equal(before.status, 200);
  assert.equal(before.body.members, 2);
  assert.equal(before.body.online, 0);
  assert.equal(before.body.connections, 0);
  assert.ok(before.body.channels >= 1);
  assert.equal(typeof before.body.uptime_s, 'number');
  assert.deepEqual(Object.keys(before.body).sort(), ['banner_url', 'channels', 'connections', 'description', 'domain', 'ember_url', 'icon_url', 'join_policy', 'members', 'name', 'online', 'servers', 'started_at', 'uptime_s', 'url', 'version']);

  const w1 = wsClient(base), w2 = wsClient(base), w3 = wsClient(base);
  await Promise.all([w1.login(alice.session), w2.login(alice.session), w3.login(bob.session)]);
  require('../src/landing').resetCache();
  const live = (await api(base).get('/api/v1/instance/stats')).body;
  assert.equal(live.online, 2, 'two people');
  assert.equal(live.connections, 3, 'three sockets');
  for (const w of [w1, w2, w3]) w.close();
});

test('banner + icon show up and become og:image (large card)', async () => {
  const db = require('../src/db');
  db.run("UPDATE communities SET banner_url = '/uploads/x/banner.png', icon_url = 'https://cdn.example/icon.png'");
  db.run("UPDATE communities SET description = '' ");
  require('../src/landing').resetCache();
  const html = await (await get('/', BROWSER)).text();
  assert.ok(html.includes(`<meta property="og:image" content="${base.replace('127.0.0.1', 'localhost')}/uploads/x/banner.png">`) || /og:image" content="http:\/\/[^"]+\/uploads\/x\/banner\.png"/.test(html));
  assert.match(html, /twitter:card" content="summary_large_image"/);
  assert.match(html, /<img src="https:\/\/cdn\.example\/icon\.png"/);
  assert.ok(!html.includes('class="desc"'), 'no description block when empty');
  db.run("UPDATE communities SET banner_url = 'javascript:alert(1)'");
  require('../src/landing').resetCache();
  const bad = await (await get('/', BROWSER)).text();
  assert.ok(!bad.includes('javascript:'), 'only http(s) pictures');
});

test('ember link: short /server/<host> on https, long form otherwise', () => {
  const { emberLink } = require('../src/landing');
  assert.equal(emberLink('https://Chat.Ikelene.net'), 'https://ember.nookara.cc/server/chat.ikelene.net');
  assert.equal(emberLink('http://localhost:8080'), 'https://ember.nookara.cc/#/i/http%3A%2F%2Flocalhost%3A8080');
});

test('other paths are untouched for browsers too', async () => {
  const r = await get('/health', BROWSER);
  assert.match(r.headers.get('content-type'), /json/);
  assert.deepEqual(await r.json(), { ok: true });
  // (a page that is not there: the homeserver's own error page for a browser, PROTOCOL §5e; JSON for everything else)
  const nf = await get('/nope', BROWSER);
  assert.equal(nf.status, 404);
  assert.match(nf.headers.get('content-type'), /html/);
  assert.match(await nf.text(), /Not found/);
  assert.deepEqual(await (await get('/nope')).json(), { error: 'not_found' });
  const wk = await get('/.well-known/ember', BROWSER);
  assert.equal((await wk.json()).software, 'bonfire-server');
});
