'use strict';
// account profiles (src/account-profile.js, PROTOCOL §4.1): a local account's name, picture, banner, colour, bio and pronouns kept on the
// server, the Nookara sync marker, and a moderator's reset
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
delete process.env.EMBER_OWNER;
const dir = tmpDir();
// a 1x1 png
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const form = () => { const f = new FormData(); f.append('file', new Blob([PNG], { type: 'image/png' }), 'p.png'); return f; };
let inst, base, owner, member, sid;
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
  sid = (await owner.a.post('/api/v1/servers', { name: 'Camp' })).body.server.sid;
  await owner.a.patch(`/api/v1/servers/${sid}`, { join_policy: 'open' });
  assert.equal((await member.a.post(`/api/v1/servers/${sid}/join`, {})).status, 200);
});
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const memberRow = async who => (await owner.a.get(`/api/v1/servers/${sid}/members`)).body.members.find(m => m.id === who.user.id);
const stored = url => path.join(dir, 'uploads', new URL(url).pathname.slice('/uploads/'.length));

test('a server with its own accounts says so, and a new account has an empty profile', async () => {
  assert.equal((await api(base).get('/.well-known/ember')).body.features.account_profiles, true);
  const r = await member.a.get('/api/v1/me/profile');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.profile, { display_name: null, pfp: null, banner: null, color: null, bio: null, pronouns: null });
  assert.equal(r.body.sync, null);
  assert.equal((await memberRow(member)).profile, undefined);
});

test('name, bio, pronouns and colour are saved on the server and show on the member and in messages', async () => {
  const ws = await wsClient(base).login(owner.session);
  const r = await member.a.patch('/api/v1/me/profile', { display_name: '  Mem  Ber ', bio: 'hello\r\nthere', pronouns: 'they/them', color: '#AABBCC' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.profile, { display_name: 'Mem Ber', pfp: null, banner: null, color: '#aabbcc', bio: 'hello\nthere', pronouns: 'they/them' });
  assert.equal(r.body.user.display_name, 'Mem Ber');
  const row = await memberRow(member);
  assert.equal(row.display_name, 'Mem Ber');
  assert.deepEqual(row.profile, { color: '#aabbcc', bio: 'hello\nthere', pronouns: 'they/them' });
  // everyone connected hears about it: the new name for their messages, and the changed member
  const idf = await ws.waitFor(f => f.type === 'chat_identity_update' && f.user.id === member.user.id);
  assert.equal(idf.user.display_name, 'Mem Ber');
  const mf = await ws.waitFor(f => f.type === 'chat_member_update' && f.user_id === member.user.id && f.member?.profile?.bio);
  assert.equal(mf.member.profile.pronouns, 'they/them');
  ws.close();
  assert.equal((await member.a.get('/api/v1/me')).body.user.display_name, 'Mem Ber');
  // it survives being read back, and a cleared name goes back to the username
  assert.equal((await member.a.get('/api/v1/me/profile')).body.profile.bio, 'hello\nthere');
  assert.equal((await member.a.patch('/api/v1/me/profile', { display_name: '' })).body.user.display_name, 'member');
  assert.equal((await member.a.patch('/api/v1/me/profile', { bio: null })).body.profile.bio, null);
});

test('bad values are refused', async () => {
  const bad = async body => (await member.a.patch('/api/v1/me/profile', body)).body.error;
  assert.equal(await bad({ color: 'red' }), 'invalid_color');
  assert.equal(await bad({ bio: 'x'.repeat(301) }), 'bio_too_long');
  assert.equal(await bad({ pronouns: 'x'.repeat(41) }), 'pronouns_too_long');
  assert.equal(await bad({ display_name: 'x'.repeat(33) }), 'display_name_too_long');
  assert.equal(await bad({ display_name: 5 }), 'invalid_display_name');
  assert.equal(await bad({ sync: { velora_id: 'nope' } }), 'invalid_sync');
  assert.equal((await member.a.post('/api/v1/me/profile/elsewhere', form())).status, 404);
  assert.equal((await api(base).get('/api/v1/me/profile')).status, 401);
});

test('picture and banner are uploaded to the server, replaced files are deleted', async () => {
  const p1 = (await member.a.post('/api/v1/me/profile/pfp', form())).body;
  assert.match(p1.profile.pfp, /\/uploads\/chat\/profile_pfp_[0-9a-f]+\.png$/);
  assert.equal(p1.user.pfp, p1.profile.pfp);
  assert.ok(fs.existsSync(stored(p1.profile.pfp)));
  const b1 = (await member.a.post('/api/v1/me/profile/banner', form())).body;
  assert.match(b1.profile.banner, /\/uploads\/chat\/profile_banner_[0-9a-f]+\.png$/);
  const row = await memberRow(member);
  assert.equal(row.pfp, p1.profile.pfp);
  assert.equal(row.profile.pfp, p1.profile.pfp);
  assert.equal(row.profile.banner, b1.profile.banner);
  const p2 = (await member.a.post('/api/v1/me/profile/pfp', form())).body;
  assert.notEqual(p2.profile.pfp, p1.profile.pfp);
  assert.ok(!fs.existsSync(stored(p1.profile.pfp)));
  assert.equal((await member.a.del('/api/v1/me/profile/banner')).body.profile.banner, null);
  assert.ok(!fs.existsSync(stored(b1.profile.banner)));
  assert.equal((await member.a.post('/api/v1/me/profile/pfp', (() => { const f = new FormData(); f.append('file', new Blob(['not a picture']), 'x.png'); return f; })())).body.error, 'images_only');
});

test('a profile on this server only still wins over the account one', async () => {
  await member.a.patch('/api/v1/me/profile', { bio: 'account bio', color: '#111111' });
  const everyone = (await owner.a.get(`/api/v1/servers/${sid}`)).body.roles.find(r => r.is_default);
  await owner.a.patch(`/api/v1/servers/${sid}/roles/${everyone.rid}`, { permissions: Number(everyone.permissions) | 32768 });
  assert.equal((await member.a.patch(`/api/v1/servers/${sid}/members/@me/profile`, { bio: 'camp bio' })).status, 200);
  const row = await memberRow(member);
  assert.equal(row.profile.bio, 'camp bio');
  assert.equal(row.profile.color, '#111111');
  await member.a.del(`/api/v1/servers/${sid}/members/@me/profile`);
  assert.equal((await memberRow(member)).profile.bio, 'account bio');
});

test('the sync marker is kept with the profile and can be switched off', async () => {
  const on = await member.a.patch('/api/v1/me/profile', { sync: { velora_id: '42', stamp: 'abc' } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.sync.velora_id, '42');
  assert.equal(on.body.sync.stamp, 'abc');
  assert.ok(on.body.sync.at > 0);
  assert.equal((await member.a.get('/api/v1/me/profile')).body.sync.stamp, 'abc');
  assert.equal((await member.a.patch('/api/v1/me/profile', { bio: 'still synced' })).body.sync.velora_id, '42'); // other edits leave it alone
  assert.equal((await member.a.patch('/api/v1/me/profile', { sync: null })).body.sync, null);
  // the new name of the field works the same, and both names come back
  const v2 = (await member.a.patch('/api/v1/me/profile', { sync: { nookara_id: '43', stamp: 'def' } })).body.sync;
  assert.deepEqual([v2.nookara_id, v2.velora_id, v2.stamp], ['43', '43', 'def']);
  assert.equal((await member.a.patch('/api/v1/me/profile', { sync: null })).body.sync, null);
});

test('a moderator reset clears the account profile too, and stops the sync', async () => {
  await member.a.patch('/api/v1/me/profile', { display_name: 'Rude Name', bio: 'rude', sync: { velora_id: '42', stamp: 's' } });
  const pfp = (await member.a.get('/api/v1/me/profile')).body.profile.pfp;
  assert.ok(pfp);
  assert.equal((await member.a.post(`/api/v1/servers/${sid}/members/${owner.user.id}/profile/reset`, {})).status, 403);
  assert.equal((await owner.a.post(`/api/v1/servers/${sid}/members/${member.user.id}/profile/reset`, {})).status, 200);
  const after = (await member.a.get('/api/v1/me/profile')).body;
  assert.deepEqual(after.profile, { display_name: null, pfp: null, banner: null, color: null, bio: null, pronouns: null });
  assert.equal(after.sync, null);
  assert.ok(!fs.existsSync(stored(pfp)));
  const row = await memberRow(member);
  assert.equal(row.profile, undefined);
  assert.equal(row.display_name, 'member');
});
