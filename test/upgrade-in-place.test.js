'use strict';
// A self-hosted instance from before homeservers, updated in place (PROTOCOL §5a, §4a): its data dir (test/fixtures/old-local-instance,
// made by build-fixture.js with bonfire-server main 837dd2d: local accounts, one server, a role, messages, invites, sessions) is
// started with this version. It becomes a homeserver on its own domain; its accounts sign in as username@<domain> with the same
// passwords; memberships, roles, messages and invite links are as they were; old sessions keep working; a client that only knows
// one server per instance (protocol 1) still finds it, and gets sid_required once there are two.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, api } = require('./helpers');

for (const k of Object.keys(process.env)) if (/^(BONFIRE|EMBER)_/.test(k)) delete process.env[k]; // (nothing but its own config.json)
const { startServer } = require('../src/index');

const FIX = path.join(__dirname, 'fixtures', 'old-local-instance');
const fx = JSON.parse(fs.readFileSync(path.join(FIX, 'fixture.json'), 'utf8'));
const dir = tmpDir();
fs.cpSync(path.join(FIX, 'data'), dir, { recursive: true });
let inst, base;

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('it starts on the old data: the database taken over, the settings moved, a homeserver on its own domain', async () => {
  assert.ok(fs.existsSync(path.join(dir, 'ember.db')) && !fs.existsSync(path.join(dir, 'bonfire.db')), 'bonfire.db became ember.db');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(cfg.accounts.hosts_accounts, true, 'accounts_mode local became the accounts block');
  assert.ok(cfg.accounts.login_methods.some(m => m.kind === 'password' && m.enabled));
  const d = (await api(base).get('/.well-known/ember')).body;
  assert.deepEqual([d.public_url, d.homeserver.domain, d.homeserver.name, d.accounts_mode], ['https://chat.oldcamp.example', 'chat.oldcamp.example', 'Old Camp', 'local']);
  assert.equal(d.claimed, true, 'still claimed by its owner');
  // protocol 1 clients: one server per instance, as `community`
  assert.equal(d.community.sid, fx.server.sid);
  assert.equal(d.communities_count, 1);
});

test('the accounts are username@domain and sign in with the same passwords', async () => {
  for (const [name, u] of Object.entries(fx.users)) {
    const r = await api(base).post('/api/v1/auth/login', { username: name, password: u.password });
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.user.id, u.id, 'the same account');
    assert.equal(require('../src/social/people').fullId(require('../src/auth').userByPrincipal(u.id)), `${u.id}@chat.oldcamp.example`);
  }
  assert.equal((await api(base).post('/api/v1/auth/login', { username: 'alice', password: 'not it' })).body.error, 'invalid_credentials');
  // and through the homeserver's own sign-in page (what new clients use)
  const page = await fetch(`${base}/login?response_type=code&client_id=ember&redirect_uri=${encodeURIComponent('https://chat.oldcamp.example/#/auth/callback')}&code_challenge=${'x'.repeat(43)}&code_challenge_method=S256`, { redirect: 'manual' });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /name="password"/);
});

test('sessions from before keep working; a bad one is a clean 401', async () => {
  for (const s of [fx.users.alice.session, fx.users.bob.session, fx.users.bob.session2, fx.users.carl.session]) {
    const r = await api(base, s).get('/api/v1/me');
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const me = (await api(base, fx.users.alice.session).get('/api/v1/me')).body;
  assert.deepEqual([me.user.id, me.instance_owner], [fx.users.alice.id, true]);
  const bad = await api(base, 'not-a-session').get('/api/v1/me');
  assert.equal(bad.status, 401);
  assert.equal(typeof bad.body.error, 'string');
});

test('memberships, roles and messages are as they were', async () => {
  const bob = api(base, fx.users.bob.session);
  const list = (await bob.get('/api/v1/servers')).body.servers;
  assert.deepEqual(list.map(s => [s.sid, s.name]), [[fx.server.sid, 'Old Camp']]);
  const det = (await bob.get(`/api/v1/servers/${fx.server.sid}`)).body;
  assert.ok(det.server.slug, 'it has an address now');
  assert.equal(det.server.address, `${det.server.slug}@chat.oldcamp.example`);
  const members = (await bob.get(`/api/v1/servers/${fx.server.sid}/members`)).body.members;
  const byId = Object.fromEntries(members.map(m => [m.user?.id || m.id, m]));
  assert.deepEqual(Object.keys(byId).sort(), [fx.users.alice.id, fx.users.bob.id, fx.users.carl.id].sort());
  assert.ok((byId[fx.users.bob.id].roles || []).includes(fx.server.role.rid), 'bob kept his role');
  assert.equal(det.server.owner_id ?? det.server.owner?.id ?? fx.users.alice.id, fx.users.alice.id);
  const hist = (await bob.get(`/api/v1/channels/${fx.server.general}/messages`)).body.messages;
  const mine = hist.filter(m => fx.server.messages.includes(String(m.id)));
  assert.deepEqual(mine.map(m => [m.author.id, m.body]).sort(), [[fx.users.alice.id, 'alice: welcome to the old camp'], [fx.users.bob.id, 'bob: glad to be here']].sort());
});

test('invite links: the old codes open the server, on the API and on the homeserver\'s invite page', async () => {
  const slug = (await api(base, fx.users.alice.session).get(`/api/v1/servers/${fx.server.sid}`)).body.server.slug;
  for (const code of [fx.server.main_invite, fx.server.invite]) {
    const r = await api(base).get(`/api/v1/invite/${code}`);
    assert.equal(r.status, 200, `${code}: ${JSON.stringify(r.body)}`);
    assert.equal((r.body.server || r.body.community || r.body).sid, fx.server.sid);
    const p = await fetch(`${base}/i/${slug}/${code}`);
    assert.equal(p.status, 200);
    assert.match(await p.text(), /Old Camp/);
  }
  // carl, who left nothing, joins again with the invite (the join flow of protocol 1 clients)
  const carl = api(base, fx.users.carl.session);
  assert.equal((await carl.post(`/api/v1/servers/${fx.server.sid}/leave`)).status, 200);
  assert.equal((await carl.post(`/api/v1/join/${fx.server.invite}`)).status, 200);
});

test('a protocol 1 client that names no server: fine with one, a clear sid_required once there are two', async () => {
  const alice = api(base, fx.users.alice.session);
  assert.notEqual((await alice.get('/api/v1/instance/backups')).body.error, 'sid_required');
  assert.equal((await alice.post('/api/v1/servers', { name: 'Second Camp' })).status, 200);
  const r = await alice.get('/api/v1/instance/backups');
  assert.deepEqual([r.status, r.body.error], [400, 'sid_required']);
  // and the discovery document still has `community` (the first server) for them
  assert.equal((await api(base).get('/.well-known/ember')).body.community.sid, fx.server.sid);
});
