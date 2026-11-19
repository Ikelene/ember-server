'use strict';
// server profiles (src/server-profile.js, PROTOCOL §6.7): your look on one server, behind "Customize profile"; Manage users resets it
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base, owner, member, sid, everyone;
test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  const register = async username => {
    const r = await api(base).post('/api/v1/auth/register', { username, password: 'correct horse battery' });
    assert.equal(r.status, 200);
    return { ...r.body, a: api(base, r.body.session) };
  };
  owner = await register('owner'); member = await register('member');
  await owner.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const made = (await owner.a.post('/api/v1/servers', { name: 'Camp' })).body;
  sid = made.server.sid;
  everyone = made.roles.find(r => r.is_default);
  await owner.a.patch(`/api/v1/servers/${sid}`, { join_policy: 'open' });
  assert.equal((await member.a.post(`/api/v1/servers/${sid}/join`, {})).status, 200);
});
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const memberRow = async who => (await owner.a.get(`/api/v1/servers/${sid}/members`)).body.members.find(m => m.id === who.user.id);

test('off unless a role gives Customize profile', async () => {
  const me = await member.a.get(`/api/v1/servers/${sid}/members/@me/profile`);
  assert.equal(me.status, 200);
  assert.equal(me.body.can_customize, false);
  assert.equal((await member.a.patch(`/api/v1/servers/${sid}/members/@me/profile`, { bio: 'hi' })).status, 403);
});

test('with it: bio, pronouns, colour and a name here, shown in the member list', async () => {
  assert.equal((await owner.a.patch(`/api/v1/servers/${sid}/roles/${everyone.rid}`, { permissions: Number(everyone.permissions) | 32768 })).status, 200);
  const r = await member.a.patch(`/api/v1/servers/${sid}/members/@me/profile`, { bio: 'camp bio', pronouns: 'they/them', color: '#AABBCC', display_name: 'Campy' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.profile, { color: '#aabbcc', bio: 'camp bio', pronouns: 'they/them' });
  assert.equal(r.body.nick, 'Campy');
  const row = await memberRow(member);
  assert.deepEqual(row.profile, { color: '#aabbcc', bio: 'camp bio', pronouns: 'they/them' });
  assert.equal(row.display_name, 'Campy');
  assert.equal((await member.a.patch(`/api/v1/servers/${sid}/members/@me/profile`, { color: 'red' })).body.error, 'invalid_color');
  assert.equal((await member.a.patch(`/api/v1/servers/${sid}/members/@me/profile`, { bio: 'x'.repeat(301) })).body.error, 'bio_too_long');
  assert.equal((await member.a.post(`/api/v1/servers/${sid}/members/@me/profile/elsewhere`, {})).status, 404);
});

test('only Manage users above them can reset it; it goes back to their global profile', async () => {
  assert.equal((await member.a.post(`/api/v1/servers/${sid}/members/${owner.user.id}/profile/reset`, {})).status, 403);
  assert.equal((await owner.a.post(`/api/v1/servers/${sid}/members/${member.user.id}/profile/reset`, {})).status, 200);
  const row = await memberRow(member);
  assert.equal(row.profile, undefined);
  assert.notEqual(row.display_name, 'Campy');
});

test('anyone can clear their own, permission or not', async () => {
  await member.a.patch(`/api/v1/servers/${sid}/members/@me/profile`, { bio: 'again' });
  assert.equal((await owner.a.patch(`/api/v1/servers/${sid}/roles/${everyone.rid}`, { permissions: Number(everyone.permissions) & ~32768 })).status, 200);
  assert.equal((await member.a.del(`/api/v1/servers/${sid}/members/@me/profile`)).status, 200);
  assert.equal((await memberRow(member)).profile, undefined);
});
