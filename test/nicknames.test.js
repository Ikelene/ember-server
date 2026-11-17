'use strict';
// Server nicknames: PATCH /servers/:sid/members/:uid { nick }. Yourself always; someone else needs Manage users and to sit above them.
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
const memberOf = async (who, name) => (await who.a.get(S('/members'))).body.members.find(m => m.username === name);

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup', async () => {
  alice = await reg('alice'); bob = await reg('bob'); carol = await reg('carol');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid;
  await bob.a.post(S('/join')); await carol.a.post(S('/join'));
});

test('anyone sets their own nickname; it shows in the member list and on their messages', async () => {
  const r = await carol.a.patch(S('/members/@me'), { nick: '  Caz ​ ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.nick, 'Caz');
  const m = await memberOf(bob, 'carol');
  assert.equal(m.nick, 'Caz');
  assert.equal(m.display_name, 'Caz');
  assert.equal(m.global_display_name, 'carol');
  const sent = (await carol.a.post(`/api/v1/channels/${general}/messages`, { message: 'hi' })).body.message;
  assert.equal(sent.author.display_name, 'Caz');
  const hist = (await bob.a.get(`/api/v1/channels/${general}/messages`)).body.messages.find(x => x.id === sent.id);
  assert.equal(hist.author.nick, 'Caz');
});

test('too long is refused, empty clears it', async () => {
  assert.equal((await carol.a.patch(S('/members/@me'), { nick: 'x'.repeat(33) })).status, 400);
  assert.equal((await carol.a.patch(S('/members/@me'), { nick: '' })).status, 200);
  const m = await memberOf(bob, 'carol');
  assert.equal(m.nick, null);
  assert.equal(m.display_name, 'carol');
});

test("someone else's nickname needs Manage users and a higher role", async () => {
  assert.equal((await bob.a.patch(S(`/members/${carol.user.id}`), { nick: 'nope' })).status, 403);
  assert.equal((await alice.a.patch(S(`/members/${carol.user.id}`), { nick: 'Car' })).status, 200);
  assert.equal((await memberOf(bob, 'carol')).nick, 'Car');
  assert.equal((await bob.a.patch(S(`/members/${alice.user.id}`), { nick: 'boss' })).status, 403);
});
