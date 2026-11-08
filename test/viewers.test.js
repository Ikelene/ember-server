'use strict';
// GET /channels/:cid/viewers: who can see a channel, so Ember's member list shows only them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base, alice, bob, carol, sid, general;
const S = p => `/api/v1/servers/${sid}${p}`;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('viewers: everyone on an open channel, only the allowed roles on a private one', async () => {
  alice = await reg('alice'); bob = await reg('bob'); carol = await reg('carol');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid;
  await bob.a.post(S('/join')); await carol.a.post(S('/join'));

  const open = await bob.a.get(`/api/v1/channels/${general}/viewers`);
  assert.equal(open.status, 200);
  assert.deepEqual(open.body, { all: true });

  const mods = (await alice.a.post(S('/roles'), { name: 'Mods' })).body.role;
  const user = (await alice.a.post(S('/roles'), { name: 'user' })).body.role;
  assert.equal((await alice.a.put(S(`/members/${bob.user.id}/roles/${mods.rid}`))).status, 200);
  assert.equal((await alice.a.put(S(`/members/${carol.user.id}/roles/${user.rid}`))).status, 200);
  const secret = (await alice.a.post(S('/channels'), { name: 'mod-talk' })).body.channel;
  const everyone = (await alice.a.get(S(''))).body.roles.find(r => r.is_default).rid;
  const set = await alice.a.put(`/api/v1/channels/${secret.cid}/perms`, { overwrites: [{ rid: everyone, deny: 1024 }, { rid: mods.rid, allow: 1024 | 2048 }, { rid: user.rid, deny: 1024 }] });
  assert.equal(set.status, 200);

  const v = await alice.a.get(`/api/v1/channels/${secret.cid}/viewers`);
  assert.equal(v.status, 200);
  assert.equal(v.body.all, false);
  assert.deepEqual([...v.body.ids].sort(), [alice.user.id, bob.user.id].sort());
  // someone who can't see the channel can't ask either
  assert.equal((await carol.a.get(`/api/v1/channels/${secret.cid}/viewers`)).status, 404);
});
