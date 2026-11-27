'use strict';
// Client-neutral invite links: GET /i/<slug>/<code> (and /i/<slug>), the invites settings and the discovery field.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
delete process.env.EMBER_OWNER;
const dir = tmpDir();
let inst, base, alice, sid, code;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
const page = p => fetch(base + p, { headers: { Accept: 'text/html' } });
const disco = async () => (await api(base).get('/.well-known/ember')).body;

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup: a server and an invite', async () => {
  alice = await reg('alice');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp <Fire>', description: 'cosy <b>place</b>', join_policy: 'invite' })).body;
  sid = d.server.sid;
  code = (await alice.a.post(`/api/v1/servers/${sid}/invites`, { max_uses: 5 })).body.code;
  assert.ok(code);
});

test('discovery advertises invites: url_base and the default clients', async () => {
  const d = await disco();
  const origin = new URL(base).port ? `http://localhost:${new URL(base).port}` : base;
  assert.deepEqual(d.invites, {
    url_base: origin + '/i/',
    clients: [{ name: 'Ember', url: 'https://nookara.cc/chat#/i/{address}/{code}' }, { name: 'Canopy', url: 'https://canopy.ikelene.net/#/i/{address}/{code}' }],
  });
});

test('a valid invite renders the page: card, open-in buttons, web+ember link, address and code, strict csp', async () => {
  const r = await page(`/i/camp-fire/${code}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/); assert.ok(!/script-src/.test(csp), 'no scripts allowed');
  const html = await r.text();
  assert.ok(!html.includes('<script'), 'no scripts');
  assert.ok(html.includes('Camp &lt;Fire&gt;') && html.includes('cosy &lt;b&gt;place&lt;/b&gt;'), 'escaped');
  assert.ok(html.includes('1 member ·'));
  assert.ok(html.includes(`href="https://nookara.cc/chat#/i/camp-fire@localhost/${code}"`));
  assert.ok(html.includes(`href="https://canopy.ikelene.net/#/i/camp-fire@localhost/${code}"`));
  assert.ok(html.includes(`href="web+ember:invite?address=camp-fire%40localhost&amp;code=${code}"`));
  assert.ok(html.includes('<dd>camp-fire@localhost</dd>') && html.includes(`<dd>${code}</dd>`));
  // a client asking for JSON gets the server
  const j = await api(base).get(`/i/camp-fire/${code}`);
  assert.equal(j.status, 200);
  assert.equal(j.body.server.sid, sid); assert.equal(j.body.server.member_count, 1); assert.equal(j.body.code, code);
  assert.match(j.body.url, new RegExp(`/i/camp-fire/${code}$`));
});

test('the page carries link preview tags: og:title, description, url, site name; an icon is og:image as an absolute url', async () => {
  const meta = html => Object.fromEntries([...html.matchAll(/<meta (?:property|name)="((?:og|twitter):[a-z_]+)" content="([^"]*)">/g)].map(m => [m[1], m[2]]));
  let m = meta(await (await page(`/i/camp-fire/${code}`)).text());
  const name = (await disco()).homeserver.name || 'localhost';
  assert.equal(m['og:title'], 'Camp &lt;Fire&gt;');
  assert.equal(m['og:description'], 'cosy &lt;b&gt;place&lt;/b&gt;');
  assert.match(m['og:url'], new RegExp(`^http://localhost:\\d+/i/camp-fire/${code}$`));
  assert.equal(m['og:site_name'], name);
  assert.deepEqual([m['twitter:card'], m['twitter:title']], ['summary', 'Camp &lt;Fire&gt;']);
  assert.equal(m['og:image'], undefined); // no icon anywhere
  await alice.a.patch(`/api/v1/servers/${sid}`, { icon_url: '/uploads/camp.png', description: '' });
  m = meta(await (await page(`/i/camp-fire/${code}`)).text());
  assert.match(m['og:image'], /^http:\/\/localhost:\d+\/uploads\/camp\.png$/);
  assert.equal(m['twitter:image'], m['og:image']);
  assert.match(m['og:description'], /^You are invited to join Camp &lt;Fire&gt;: 1 member on /);
  await alice.a.patch(`/api/v1/servers/${sid}`, { icon_url: null, description: 'cosy <b>place</b>' });
});

test('unknown slug, unknown code, a code of another server, unlisted without code: 404', async () => {
  const other = (await alice.a.post('/api/v1/servers', { name: 'Other Place' })).body.server;
  const otherCode = (await alice.a.post(`/api/v1/servers/${other.sid}/invites`, {})).body.code;
  for (const p of [`/i/nope/${code}`, '/i/camp-fire/zzzzzzzz', `/i/camp-fire/${otherCode}`, '/i/camp-fire']) {
    const r = await page(p);
    assert.equal(r.status, 404, p);
    assert.match(await r.text(), /Invite not found/);
    assert.equal((await api(base).get(p)).body.error, 'invalid_invite');
  }
  // an expired / used-up invite is gone too
  const once = (await alice.a.post(`/api/v1/servers/${sid}/invites`, { max_uses: 1 })).body.code;
  const bob = await reg('bob');
  assert.equal((await bob.a.post('/api/v1/join/' + once)).status, 200);
  assert.equal((await page(`/i/camp-fire/${once}`)).status, 404);
});

test('a listed server opens without a code', async () => {
  assert.equal((await alice.a.patch(`/api/v1/servers/${sid}`, { listed: true })).status, 200);
  const r = await page('/i/camp-fire');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('href="https://nookara.cc/chat#/i/camp-fire@localhost"'));
  assert.ok(html.includes('href="web+ember:invite?address=camp-fire%40localhost"'));
  assert.ok(!html.includes('<dt>Code</dt>'));
});

test('invites settings: validated, saved, shown to admins, reach discovery and the page; null resets', async () => {
  const set = b => alice.a.patch('/api/v1/instance/settings', { invites: b });
  for (const bad of ['x', [], { url_base: 'javascript:alert(1)' }, { url_base: 'https://a.test/i/?x' }, { clients: 'x' }, { clients: [{ name: '', url: 'https://a.test/' }] },
    { clients: [{ name: 'X', url: 'javascript:alert(1)//{code}' }] }, { clients: [{ name: 'X', url: 'https://a.test/', icon_url: 'data:x' }] }, { clients: Array(13).fill({ name: 'X', url: 'https://a.test/' }) }]) {
    const r = await set(bad);
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.body.error, 'invalid_invites');
  }
  const clients = [{ name: 'Dev <Ember>', url: 'http://localhost:5173/chat#/i/{address}/{code}', icon_url: 'https://a.test/e.png' }];
  assert.equal((await set({ url_base: 'https://links.example/i', clients })).status, 200);
  const s = (await alice.a.get('/api/v1/instance/settings')).body;
  assert.deepEqual(s.invites, { url_base: 'https://links.example/i/', clients });
  assert.deepEqual((await disco()).invites, { url_base: 'https://links.example/i/', clients });
  const html = await (await page(`/i/camp-fire/${code}`)).text();
  assert.ok(html.includes(`href="http://localhost:5173/chat#/i/camp-fire@localhost/${code}"`) && html.includes('Open in Dev &lt;Ember&gt;') && html.includes('src="https://a.test/e.png"'));
  assert.ok(!html.includes('canopy.ikelene.net'));
  assert.ok(html.includes(`https://links.example/i/camp-fire/${code}`));
  // only clients changes: url_base stays
  assert.equal((await set({ clients: [] })).status, 200);
  assert.deepEqual((await disco()).invites, { url_base: 'https://links.example/i/', clients: [] });
  assert.equal((await set(null)).status, 200);
  assert.equal((await disco()).invites.clients.length, 2);
  assert.match((await disco()).invites.url_base, /^http:\/\/localhost:\d+\/i\/$/);
  // the domain is not the public url's host: https://<domain>/i/
  assert.equal((await alice.a.patch('/api/v1/instance/settings', { domain: 'camp.example' })).status, 200);
  assert.equal((await disco()).invites.url_base, 'https://camp.example/i/');
  assert.equal((await alice.a.patch('/api/v1/instance/settings', { domain: null })).status, 200);
});

test('the landing page links the client-neutral invite', async () => {
  require('../src/landing').resetCache();
  const html = await (await page('/')).text();
  const inv = (await alice.a.get(`/api/v1/servers/${sid}`)).body.server.invite;
  assert.match(html, new RegExp(`href="http://localhost:\\d+/i/camp-fire/${inv}"`));
  const st = (await api(base).get('/api/v1/instance/stats')).body.servers.find(x => x.slug === 'camp-fire');
  assert.match(st.invite_url, new RegExp(`/i/camp-fire/${inv}$`));
  assert.match(st.join_url, /#\/i\/.*\/invite\//); // the old link is still there
});
