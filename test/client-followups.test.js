'use strict';
// What the Ember client reads around many servers per homeserver: address lookups without a session, the answer to creating
// a server, slug / address / role on every server view, joining an unlisted server, `creation` in discovery, slugs in exports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { unzipSync, strFromU8 } = require('fflate');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
delete process.env.EMBER_OWNER;
delete process.env.EMBER_MANAGED;
delete process.env.EMBER_PUBLIC_URL;
const dir = tmpDir();
let inst, base, alice, bob;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };

test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0 });
  base = inst.url;
  alice = await reg('alice'); bob = await reg('bob');
  assert.equal((await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() })).status, 200);
});
test.after(async () => { await inst?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('creating a server answers { server } with slug, address and role; the list carries them too', async () => {
  const r = await alice.a.post('/api/v1/servers', { name: 'Camp Fire', join_policy: 'open' });
  assert.equal(r.status, 200);
  const s = r.body.server;
  assert.equal(s.slug, 'camp-fire'); assert.equal(s.address, 'camp-fire@localhost'); assert.equal(s.role, 'owner');
  assert.ok(Array.isArray(r.body.channels));
  const mine = (await alice.a.get('/api/v1/servers')).body.servers.find(x => x.sid === s.sid);
  assert.deepEqual([mine.slug, mine.address, mine.role], ['camp-fire', 'camp-fire@localhost', 'owner']);
  const detail = (await alice.a.get(`/api/v1/servers/${s.sid}`)).body.server;
  assert.deepEqual([detail.slug, detail.address, detail.role], ['camp-fire', 'camp-fire@localhost', 'owner']);
});

test('an address resolves without a session, from any origin', async () => {
  const r = await fetch(base + '/api/v1/servers/resolve?address=camp-fire@localhost', { headers: { Origin: 'https://some.client' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const b = await r.json();
  assert.equal(b.slug, 'camp-fire'); assert.match(b.sid, /^s/);
  assert.equal((await api(base).get('/api/v1/servers/resolve?address=nope')).status, 404);
});

test('an unlisted server is joined by its sid, following its join policy', async () => {
  const s = (await alice.a.get('/api/v1/servers')).body.servers[0];
  assert.equal(s.listed, false);
  const j = await bob.a.post(`/api/v1/servers/${s.sid}/join`);
  assert.equal(j.status, 200);
  assert.equal(j.body.server.role, 'member'); assert.equal(j.body.server.slug, 'camp-fire');
});

test('discovery says who may create servers; the limit error says how many', async () => {
  let d = (await api(base).get('/.well-known/ember')).body;
  assert.deepEqual(d.creation, { mode: 'admins', per_account: null });
  await alice.a.patch('/api/v1/instance/settings', { creation: { mode: 'anyone', per_account: 1 } });
  d = (await api(base).get('/.well-known/ember')).body;
  assert.deepEqual(d.creation, { mode: 'anyone', per_account: 1 });
  assert.equal((await bob.a.post('/api/v1/servers', { name: 'Bobs' })).status, 200);
  const over = await bob.a.post('/api/v1/servers', { name: 'Bobs two' });
  assert.equal(over.status, 403);
  assert.deepEqual(over.body, { error: 'creation_limit', limit: 1, used: 1 });
});

test('an export carries the slug; an import takes it when it is free here', async () => {
  const made = (await alice.a.post('/api/v1/servers', { name: 'Travels', slug: 'far-away' })).body.server;
  const zip = (await alice.a.get(`/api/v1/servers/${made.sid}/export`)).body;
  assert.equal(JSON.parse(strFromU8(unzipSync(new Uint8Array(zip))['community.json'])).slug, 'far-away');
  const imp = () => { const f = new FormData(); f.append('file', new Blob([zip], { type: 'application/zip' }), 'export.zip'); return alice.a.raw('POST', '/api/v1/import', f); };
  const taken = await imp(); // far-away is still here: a slug from the name
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  const sidOf = b => b.server?.sid || b.sid;
  const t = (await alice.a.get(`/api/v1/servers/${sidOf(taken.body)}`)).body.server;
  assert.equal(t.slug, 'travels');
  assert.equal((await alice.a.del(`/api/v1/servers/${made.sid}`)).status, 200);
  const free = await imp();
  const f = (await alice.a.get(`/api/v1/servers/${sidOf(free.body)}`)).body.server;
  assert.equal(f.slug, 'far-away');
});
