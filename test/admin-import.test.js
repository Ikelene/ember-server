'use strict';
// A homeserver admin imports a server for its owner (admin-import.js): the owner it names, the address it had, the old origin
// kept with previous_urls. What Nookara's migration of its hosted servers uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const { startServer } = require('../src/index');

const dir = tmpDir();
let inst, base, alice, bob, zip;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
const upload = async (session, qs, buf = zip) => {
  const f = new FormData(); f.append('file', new Blob([buf]), 'server.zip');
  const r = await fetch(`${base}/api/v2/homeserver/import?${new URLSearchParams(qs)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + session }, body: f });
  return { status: r.status, body: await r.json() };
};
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup: a server to move, exported', async () => {
  alice = await reg('alice'); bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Moving Co', slug: 'moving-co', join_policy: 'open' })).body;
  await alice.a.post(`/api/v1/channels/${d.channels.find(c => c.type === 'text').cid}/messages`, { message: 'hello from before' });
  const r = await fetch(`${base}/api/v1/servers/${d.server.sid}/export`, { headers: { Authorization: 'Bearer ' + alice.session } });
  assert.equal(r.status, 200);
  zip = Buffer.from(await r.arrayBuffer());
});

test('an admin imports it for its owner, at the address asked for, and the old origin joins previous_urls', async () => {
  assert.equal((await upload(bob.session, { owner: bob.user.id, slug: 'bobs-place' })).status, 403); // admins only
  let r = await upload(alice.session, { owner: 'l:999', slug: 'x-place' });
  assert.deepEqual([r.status, r.body.error], [404, 'owner_not_found']);
  r = await upload(alice.session, { owner: 'v:42', slug: 'x-place' });
  assert.deepEqual([r.status, r.body.error], [400, 'nookara_accounts_off']); // (Nookara accounts are not this homeserver's)
  assert.equal((await upload(alice.session, { owner: bob.user.id, slug: 'moving-co' })).body.error, 'slug_taken');
  assert.equal((await upload(alice.session, { owner: bob.user.id, slug: 'Bad Slug' })).body.error, 'invalid_slug');
  r = await upload(alice.session, { owner: bob.user.id, slug: 'bobs-place', previous_url: 'https://e-bobs-place.nookara.cc/' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.slug, r.body.owner], ['bobs-place', bob.user.id]);
  const s = (await bob.a.get(`/api/v1/servers/${r.body.sid}`)).body;
  assert.deepEqual([s.server.name, s.server.slug, s.server.role], ['Moving Co', 'bobs-place', 'owner']);
  const d = (await api(base).get('/.well-known/ember')).body;
  assert.ok(d.previous_urls.includes('https://e-bobs-place.nookara.cc'));
  assert.equal((await upload(alice.session, { owner: bob.user.id, slug: 'other', previous_url: 'not a url' })).body.error, 'invalid_previous_url');
});
