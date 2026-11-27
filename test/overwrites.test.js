'use strict';
// Channel and category permission overwrites (overwrites.js, perms.js, PROTOCOL §6.5): roles and single members, every channel
// permission, category syncing, who may edit what, enforcement in each feature, no leaks of hidden channels, the v36 migration
// of the old per-role see / send / attach settings, older role editors, and export / import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL', 'EMBER_PLAN', 'EMBER_LIMITS']) delete process.env[k];
const { startServer } = require('../src/index');
const perms = require('../src/perms');
const { P } = perms;

const dir = tmpDir();
let inst, base, owner, mod, amy, ben, sid, general, voice, everyoneRid, modRid, db;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200, JSON.stringify(r.body)); return { ...r.body, a: api(base, r.body.session) }; };
const OW = (cid, p = '') => `/api/v1/servers/${sid}/channels/${cid}/overwrites${p}`;
const CAT = (name, p = '') => `/api/v1/servers/${sid}/categories/${encodeURIComponent(name)}/overwrites${p}`;
const post = (who, cid, message, extra = {}) => who.a.post(`/api/v1/channels/${cid}/messages`, { message, ...extra });
const newChannel = async (name, extra = {}) => (await owner.a.post(`/api/v1/servers/${sid}/channels`, { name, ...extra })).body.channel;
const eff = (who, cid, principal) => who.a.get(`/api/v1/servers/${sid}/channels/${cid}/permissions/${encodeURIComponent(principal)}`);

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; db = require('../src/db'); });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------- the resolution, as a pure function ----------
test('resolution: @everyone, then roles (denies and allows OR\'d), then the member; the owner and Administrator skip it', () => {
  const roles = [{ id: 1, permissions: perms.EVERYONE_DEFAULT, is_default: 1, position: 0 }, { id: 2, permissions: 0, is_default: 0, position: 1 },
    { id: 3, permissions: 0, is_default: 0, position: 2 }, { id: 4, permissions: P.ADMIN, is_default: 0, position: 3 }];
  const b = ids => perms.basePerms({ roles, roleIds: new Set(ids) });
  const ow = new Map([[1, { allow: 0, deny: P.SEND | P.ADD_REACTIONS }], [2, { allow: P.SEND, deny: P.ATTACH }], [3, { allow: P.ATTACH, deny: P.EMBED_LINKS }]]);
  const ch = (ids, member = null) => perms.channelPerms(b(ids), { overwrites: ow, everyoneId: 1, roleIds: new Set(ids), member });
  const rows = [
    // [roles, member overwrite, bit, expected]
    [[], null, P.SEND, false], [[], null, P.ADD_REACTIONS, false], [[], null, P.ATTACH, true],
    [[2], null, P.SEND, true], [[2], null, P.ATTACH, false], [[2, 3], null, P.ATTACH, true], // a role allow wins over another role's deny
    [[3], null, P.EMBED_LINKS, false], [[2], { allow: 0, deny: P.SEND }, P.SEND, false], // the member's deny wins over a role's allow
    [[], { allow: P.ADD_REACTIONS, deny: 0 }, P.ADD_REACTIONS, true], [[2], { allow: P.ATTACH, deny: 0 }, P.ATTACH, true],
    [[], { allow: 0, deny: P.VIEW }, P.VIEW, false],
  ];
  for (const [ids, member, bit, want] of rows) assert.equal((ch(ids, member) & bit) === bit, want, `${ids} ${JSON.stringify(member)} ${perms.namesOf(bit)}`);
  assert.equal(ch([4], { allow: 0, deny: P.VIEW | P.SEND }), perms.ALL_PERMS | P.VIEW, 'Administrator');
  const own = perms.basePerms({ roles, roleIds: new Set(), isOwner: true });
  assert.equal(perms.channelPerms(own, { overwrites: ow, everyoneId: 1, member: { allow: 0, deny: P.VIEW } }), perms.ALL_PERMS | P.VIEW, 'owner');
  assert.deepEqual(perms.namesOf(P.SEND | P.CONNECT), ['send_messages', 'connect']);
  assert.equal(perms.bitsFrom(['send_messages', 'manage_permissions']), P.SEND | P.MANAGE_ROLES);
  assert.equal(perms.bitsFrom(['flying']), null);
});

test('setup: a server, a moderator role, two members', async () => {
  owner = await reg('owner'); mod = await reg('mod'); amy = await reg('amy'); ben = await reg('ben');
  await owner.a.post('/api/v1/instance/claim', { code: inst.setup.current(), accept_operator_terms: true });
  const d = (await owner.a.post('/api/v1/servers', { name: 'Perms', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid; voice = d.channels.find(c => c.type === 'voice').cid;
  everyoneRid = d.roles.find(r => r.is_default).rid;
  for (const u of [mod, amy, ben]) assert.equal((await u.a.post(`/api/v1/servers/${sid}/join`)).status, 200);
  modRid = (await owner.a.post(`/api/v1/servers/${sid}/roles`, { name: 'Mods', permissions: ['manage_roles', 'manage_messages'] })).body.role.rid;
  await owner.a.put(`/api/v1/servers/${sid}/members/${encodeURIComponent(mod.user.id)}/roles/${modRid}`);
  const roles = (await owner.a.get(`/api/v1/servers/${sid}`)).body.roles;
  assert.deepEqual(roles.find(r => r.rid === modRid).permission_names.sort(), ['manage_messages', 'manage_roles', 'pin_messages'].filter(x => x !== 'pin_messages').sort());
  assert.ok(roles.find(r => r.is_default).permission_names.includes('add_reactions'));
  assert.equal((await api(base).get('/api/v1/permissions')).body.channel.manage_permissions, P.MANAGE_ROLES);
});

test('the API: names or bits in, both out; one at a time or the whole list; server-wide bits are refused', async () => {
  let r = await owner.a.put(OW(general, `/role/${everyoneRid}`), { allow: [], deny: ['add_reactions', 'embed_links'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.overwrites.map(o => [o.type, o.id, o.everyone, o.deny_names]), [['role', everyoneRid, true, ['embed_links', 'add_reactions']]]);
  assert.equal(r.body.perms_synced, false, 'editing a channel stops it following its category');
  r = await owner.a.put(OW(general, `/member/${encodeURIComponent(amy.user.id)}`), { allow: P.ADD_REACTIONS, deny: 0 });
  assert.deepEqual(r.body.overwrites.find(o => o.type === 'member'), { type: 'member', id: amy.user.id, name: 'amy', display_name: 'amy', allow: P.ADD_REACTIONS, deny: 0, allow_names: ['add_reactions'], deny_names: [] });
  assert.equal((await owner.a.put(OW(general, `/role/${everyoneRid}`), { deny: ['ban_members'] })).body.error, 'not_a_channel_permission');
  assert.equal((await owner.a.put(OW(general, `/role/${everyoneRid}`), { deny: ['flying'] })).body.error, 'invalid_permissions');
  assert.equal((await owner.a.put(OW(general, '/member/l%3A999'), { deny: ['send_messages'] })).body.error, 'member_not_found');
  assert.equal((await owner.a.put(OW(general, `/member/${encodeURIComponent(owner.user.id)}`), { deny: ['send_messages'] })).body.error, 'owner_not_affected');
  assert.equal((await owner.a.put(OW(general, '/group/x'), { deny: 1 })).body.error, 'invalid_overwrite_type');
  // the channel view and the old route carry them too
  const ch = (await owner.a.get(`/api/v1/servers/${sid}`)).body.channels.find(c => c.cid === general);
  assert.equal(ch.permission_overwrites.length, 2);
  assert.deepEqual(ch.overwrites, [{ rid: everyoneRid, allow: 0, deny: P.ADD_REACTIONS | P.EMBED_LINKS }]);
  // the old route replaces the role ones and keeps the member one
  r = await owner.a.put(`/api/v1/channels/${general}/perms`, { overwrites: [] });
  assert.deepEqual(r.body.channel.permission_overwrites.map(o => o.type), ['member']);
  // the whole list at once
  r = await owner.a.put(OW(general), { overwrites: [{ type: 'role', id: 'everyone', deny: ['add_reactions'] }] });
  assert.deepEqual(r.body.overwrites.map(o => [o.type, o.deny_names]), [['role', ['add_reactions']]]);
  assert.equal((await owner.a.del(OW(general, `/role/${everyoneRid}`))).body.overwrites.length, 0);
});

test('who may edit: Manage roles in the channel; never more than they have, never a higher role, never locking themselves out', async () => {
  const room = await newChannel('mods-room');
  assert.equal((await amy.a.put(OW(room.cid, `/role/${everyoneRid}`), { deny: ['send_messages'] })).status, 403);
  // the moderator has Manage roles and Manage messages, not Mention everyone
  assert.equal((await mod.a.put(OW(room.cid, `/role/${everyoneRid}`), { deny: ['send_messages'] })).status, 200);
  const r = await mod.a.put(OW(room.cid, `/role/${everyoneRid}`), { allow: ['mention_everyone'], deny: ['send_messages'] });
  assert.deepEqual([r.status, r.body.error, r.body.names], [403, 'cannot_grant', ['mention_everyone']]);
  assert.equal((await mod.a.put(OW(room.cid, `/role/${modRid}`), { allow: ['send_messages'] })).body.error, 'role_too_high');
  // hiding the channel from everyone, Mods included: they would not see it any more
  assert.equal((await mod.a.put(OW(room.cid, `/member/${encodeURIComponent(mod.user.id)}`), { deny: ['view_channel'] })).body.error, 'would_lock_you_out');
  assert.equal((await mod.a.put(OW(room.cid, `/member/${encodeURIComponent(mod.user.id)}`), { deny: ['manage_permissions'] })).body.error, 'would_lock_you_out');
  // a channel-level grant of Manage roles lets someone without it edit there
  await owner.a.put(OW(room.cid, `/member/${encodeURIComponent(ben.user.id)}`), { allow: ['manage_permissions'] });
  assert.equal((await ben.a.put(OW(room.cid, `/member/${encodeURIComponent(amy.user.id)}`), { deny: ['add_reactions'] })).status, 200);
  assert.equal((await ben.a.put(OW(general, `/member/${encodeURIComponent(amy.user.id)}`), { deny: ['add_reactions'] })).status, 403, 'only in that channel');
  // effective permissions: yourself, or the people who manage the channel's permissions
  const e = (await eff(ben, room.cid, ben.user.id)).body;
  assert.ok(e.names.includes('manage_permissions') && !e.names.includes('send_messages') && e.view);
  assert.equal((await eff(amy, room.cid, ben.user.id)).status, 403);
  assert.equal((await eff(owner, room.cid, amy.user.id)).body.names.includes('add_reactions'), false);
});

test('enforcement: view, send, attach, reactions, pins, history, mentions, embeds, outside emojis, typing, voice', async () => {
  const ch = await newChannel('rules');
  const amyId = encodeURIComponent(amy.user.id);
  const m0 = (await post(owner, ch.cid, 'hello all')).body.message;
  // send
  await owner.a.put(OW(ch.cid, `/member/${amyId}`), { deny: ['send_messages'] });
  assert.equal((await post(amy, ch.cid, 'x')).body.error, 'no_send_permission');
  // attach
  await owner.a.put(OW(ch.cid, `/member/${amyId}`), { deny: ['attach_files'] });
  const up = new FormData(); up.append('file', new Blob([Buffer.from('hello')]), 'a.txt');
  assert.equal((await amy.a.raw('POST', `/api/v1/media/upload?sid=${sid}&cid=${ch.cid}`, up)).body.error, 'no_attach_permission');
  // reactions (taking one off still works)
  await owner.a.put(OW(ch.cid, `/member/${amyId}`), { deny: ['add_reactions'] });
  assert.equal((await amy.a.put(`/api/v1/messages/${m0.id}/reactions/${encodeURIComponent('👍')}`)).body.error, 'no_reaction_permission');
  assert.equal((await amy.a.del(`/api/v1/messages/${m0.id}/reactions/${encodeURIComponent('👍')}`)).status, 200);
  // pins: Pin messages in the channel is enough
  assert.equal((await amy.a.put(`/api/v1/messages/${m0.id}/pin`)).status, 403);
  await owner.a.put(OW(ch.cid, `/member/${amyId}`), { allow: ['pin_messages'] });
  assert.equal((await amy.a.put(`/api/v1/messages/${m0.id}/pin`)).status, 200);
  // history, pins list, search
  assert.equal((await amy.a.get(`/api/v1/channels/${ch.cid}/messages`)).body.messages.length > 0, true);
  await owner.a.put(OW(ch.cid, `/member/${amyId}`), { deny: ['read_message_history'] });
  const h = (await amy.a.get(`/api/v1/channels/${ch.cid}/messages`)).body;
  assert.deepEqual([h.messages, h.read_history], [[], false]);
  assert.deepEqual((await amy.a.get(`/api/v1/channels/${ch.cid}/pins`)).body.messages, []);
  assert.equal((await amy.a.get(`/api/v1/servers/${sid}/search?q=hello%20all`)).body.messages.length, 0);
  assert.ok((await ben.a.get(`/api/v1/servers/${sid}/search?q=hello%20all`)).body.messages.length > 0);
  // mentions: Mention everyone per channel
  await owner.a.put(OW(ch.cid, `/member/${amyId}`), { allow: ['mention_everyone'], deny: [] });
  assert.equal((await post(amy, ch.cid, '@everyone hi')).body.message.mention_everyone, 'everyone');
  assert.equal((await post(ben, ch.cid, '@everyone hi')).body.message.mention_everyone, null);
  // embeds: no link previews for someone without Embed links
  await owner.a.put(OW(ch.cid, `/member/${amyId}`), { deny: ['embed_links'] });
  const e = (await post(amy, ch.cid, 'see https://example.org', { })).body.message;
  assert.equal(e.suppress_embeds, true);
  assert.equal((await post(ben, ch.cid, 'see https://example.org')).body.message.suppress_embeds, undefined);
  // custom emojis of another server
  await owner.a.put(OW(ch.cid, `/member/${amyId}`), { deny: ['use_external_emojis'] });
  assert.equal((await post(amy, ch.cid, 'nice <:party:eOTHER1234>')).body.error, 'no_external_emojis');
  assert.equal((await post(ben, ch.cid, 'nice <:party:eOTHER1234>')).status, 200);
  // typing goes only where someone may send; messages only to who can see
  await owner.a.put(OW(ch.cid, `/member/${amyId}`), { deny: ['send_messages'] });
  const wa = await wsClient(base).login(amy.session), wb = await wsClient(base).login(ben.session);
  wa.send({ type: 'chat_typing', channel: ch.cid });
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!wb.frames.some(f => f.type === 'chat_typing'));
  await owner.a.put(OW(ch.cid, `/member/${amyId}`), { deny: ['view_channel'] });
  await post(ben, ch.cid, 'secret now');
  await wb.waitFor(f => f.type === 'chat_message' && f.message.body === 'secret now');
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!wa.frames.some(f => f.type === 'chat_message' && f.message.body === 'secret now'));
  assert.equal((await amy.a.get(`/api/v1/channels/${ch.cid}/messages`)).body.error, 'channel_not_found');
  // voice: Connect (no voice keys here, so an allowed join gets voice_unavailable)
  await owner.a.put(OW(voice, `/member/${amyId}`), { deny: ['connect'] });
  wa.send({ type: 'chat_rtc_join', nonce: 'v1', room: 'bf_' + voice });
  wb.send({ type: 'chat_rtc_join', nonce: 'v2', room: 'bf_' + voice });
  assert.equal((await wa.waitFor(f => f.type === 'chat_error' && f.nonce === 'v1')).error, 'not_allowed');
  assert.equal((await wb.waitFor(f => f.type === 'chat_error' && f.nonce === 'v2')).error, 'voice_unavailable');
  wa.close(); wb.close();
});

test('no leaks: a hidden channel is in no list, count, voice state, link preview, bot view or effective-permissions answer', async () => {
  const hidden = await newChannel('hidden');
  await owner.a.put(OW(hidden.cid, '/role/everyone'), { deny: ['view_channel'] });
  await post(owner, hidden.cid, `ping <@${ben.user.id}> @everyone`);
  const d = (await ben.a.get(`/api/v1/servers/${sid}`)).body;
  assert.ok(!d.channels.some(c => c.cid === hidden.cid));
  assert.ok(!JSON.stringify((await ben.a.get('/api/v1/servers')).body).includes(hidden.cid));
  assert.equal((await ben.a.get(`/api/v1/link-info/${sid}/${hidden.cid}`)).body.channel, null);
  assert.equal((await eff(owner, hidden.cid, ben.user.id)).body.view, false);
  assert.equal((await eff(ben, hidden.cid, ben.user.id)).body.error, 'channel_not_found');
  assert.equal((await ben.a.get(OW(hidden.cid))).body.error, 'channel_not_found');
  // a bot sees what its roles let it see
  const C = require('../src/communities'), c = db.get('SELECT * FROM communities WHERE sid = ?', sid);
  assert.equal(C.snapOf(c).canView(C.snapOf(c).channels.find(x => x.cid === hidden.cid), ben.user.id.replace(/\D/g, '') * 1), false);
  // and a member overwrite brings it back for one person
  await owner.a.put(OW(hidden.cid, `/member/${encodeURIComponent(ben.user.id)}`), { allow: ['view_channel'] });
  assert.ok((await ben.a.get(`/api/v1/servers/${sid}`)).body.channels.some(c => c.cid === hidden.cid));
});

test('categories: a channel following its category gets its overwrites; editing the channel copies them first; sync goes back', async () => {
  const cat = 'Text channels';
  const a = await newChannel('follows', { category: cat });
  assert.equal((await owner.a.get(OW(a.cid))).body.perms_synced, true);
  let r = await owner.a.put(CAT(cat, `/member/${encodeURIComponent(ben.user.id)}`), { deny: ['send_messages'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await post(ben, a.cid, 'x')).body.error, 'no_send_permission');
  assert.equal((await owner.a.get(OW(a.cid))).body.overwrites[0].deny_names[0], 'send_messages');
  // editing the channel: its own copy, the category's ones included, and it stops following
  r = await owner.a.put(OW(a.cid, `/member/${encodeURIComponent(amy.user.id)}`), { deny: ['add_reactions'] });
  assert.deepEqual([r.body.perms_synced, r.body.overwrites.length], [false, 2]);
  await owner.a.del(CAT(cat, `/member/${encodeURIComponent(ben.user.id)}`));
  assert.equal((await post(ben, a.cid, 'x')).body.error, 'no_send_permission', 'its own copy stays');
  r = await owner.a.post(OW(a.cid, '/sync'));
  assert.deepEqual([r.body.perms_synced, r.body.overwrites.length], [true, 0]);
  assert.equal((await post(ben, a.cid, 'x')).status, 200);
  assert.equal((await owner.a.get(CAT('Nope'))).body.error, 'category_not_found');
  // a category that goes takes its overwrites along
  await owner.a.put(`/api/v1/servers/${sid}/layout`, { categories: ['Text channels', 'Voice channels', 'Extra'] });
  await owner.a.put(CAT('Extra', '/role/everyone'), { deny: ['add_reactions'] });
  await owner.a.put(`/api/v1/servers/${sid}/layout`, { categories: ['Text channels', 'Voice channels'] });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM perm_overwrites WHERE category = 'Extra'").n, 0);
});

test('an account of another homeserver is addressable as a member overwrite', async () => {
  const c = db.get('SELECT * FROM communities WHERE sid = ?', sid);
  const uid = db.run("INSERT INTO users (principal, kind, username, display_name, domain, created_at) VALUES ('l:5@b.example', 'remote', 'rem@b.example', 'Rem', 'b.example', ?)", Date.now()).lastInsertRowid;
  db.run('INSERT INTO members (community_id, user_id, joined_at) VALUES (?, ?, ?)', c.id, uid, Date.now());
  const r = await owner.a.put(OW(general, '/member/l%3A5%40b.example'), { deny: ['send_messages'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.overwrites.map(o => [o.type, o.id, o.name]), [['member', 'l:5@b.example', 'rem@b.example']]);
  await owner.a.del(OW(general, '/member/l%3A5%40b.example'));
});

test('older role editors keep the new bits; the audit log has every change', async () => {
  const roles = (await owner.a.get(`/api/v1/servers/${sid}`)).body.roles;
  const r = await owner.a.patch(`/api/v1/servers/${sid}/roles/${everyoneRid}`, { permissions: 1 | 256 }); // (an editor that knows send / attach only)
  assert.equal(r.body.role.permissions, 1 | 256 | perms.MEMBER_DEFAULT);
  assert.equal((await owner.a.patch(`/api/v1/servers/${sid}/roles/${everyoneRid}`, { permissions: 1 | 256, full_permissions: true })).body.role.permissions, 1 | 256);
  await owner.a.patch(`/api/v1/servers/${sid}/roles/${everyoneRid}`, { permissions: roles.find(x => x.is_default).permissions, full_permissions: true });
  const log = (await owner.a.get(`/api/v1/servers/${sid}/audit`)).body.entries.map(e => e.action);
  for (const a of ['channel_overwrite_update', 'channel_overwrite_delete', 'channel_overwrites_replace', 'channel_overwrites_sync']) assert.ok(log.includes(a), a);
});

test('export / import keep them; an export from before them is upgraded', async () => {
  const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
  const keep = await newChannel('kept');
  await owner.a.put(OW(keep.cid, '/role/everyone'), { deny: ['add_reactions'] });
  await owner.a.put(OW(keep.cid, `/member/${encodeURIComponent(amy.user.id)}`), { allow: ['add_reactions'] });
  const zip = Buffer.from(await (await fetch(`${base}/api/v1/servers/${sid}/export`, { headers: { Authorization: 'Bearer ' + owner.session } })).arrayBuffer());
  const files = unzipSync(new Uint8Array(zip)), cj = JSON.parse(strFromU8(files['community.json']));
  assert.equal(cj.perm_version, 2);
  assert.deepEqual(cj.channels.find(x => x.cid === keep.cid).overwrites.map(o => [o.type, o.id]), [['role', everyoneRid], ['member', amy.user.id]]);
  // an old export: the three old bits, no versions; voice send covers voice
  const old = JSON.parse(JSON.stringify(cj));
  delete old.perm_version; delete old.category_overwrites;
  for (const ch of old.channels) { delete ch.overwrites; delete ch.perms_synced; ch.perms = []; }
  old.channels.find(x => x.type === 'voice').perms = [{ role: everyoneRid, allow: 0, deny: P.SEND }];
  for (const r of old.roles) r.permissions = r.is_default ? 1 | 256 | 8192 : r.permissions;
  files['community.json'] = strToU8(JSON.stringify(old));
  const f = new FormData(); f.append('file', new Blob([Buffer.from(zipSync(files))]), 'old.zip');
  const imp = await (await fetch(`${base}/api/v1/import`, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.session }, body: f })).json();
  assert.ok(imp.sid, JSON.stringify(imp));
  const d = (await owner.a.get(`/api/v1/servers/${imp.sid}`)).body;
  assert.equal(d.roles.find(r => r.is_default).permissions, perms.upgradeRole(1 | 256 | 8192, true));
  const v = d.channels.find(x => x.type === 'voice');
  assert.deepEqual(v.permission_overwrites[0].deny_names.sort(), ['connect', 'send_messages', 'speak', 'stream', 'use_soundboard', 'video'].sort());
  // the new export into a fresh server: the member overwrite comes back for a member who is one there
  const f2 = new FormData(); f2.append('file', new Blob([zip]), 'new.zip');
  const imp2 = await (await fetch(`${base}/api/v1/import`, { method: 'POST', headers: { Authorization: 'Bearer ' + owner.session }, body: f2 })).json();
  const k2 = (await owner.a.get(`/api/v1/servers/${imp2.sid}`)).body.channels.find(x => x.name === 'kept');
  assert.deepEqual(k2.permission_overwrites.map(o => o.type).sort(), ['member', 'role']);
});

// ---------- the review of f320d50 (each a regression test) ----------
const seesIt = async (who, cid) => (await who.a.get(`/api/v1/servers/${sid}`)).body.channels.some(c => c.cid === cid);
const layoutNow = async () => (await owner.a.get(`/api/v1/servers/${sid}`)).body;

test('review 1: renaming or removing a category never makes its hidden channels visible', async () => {
  const sec = await newChannel('secret', { category: 'Staff' });
  await owner.a.put(CAT('Staff', '/role/everyone'), { deny: ['view_channel'] });
  assert.equal(await seesIt(amy, sec.cid), false);
  // a rename in the layout (the same place, a new name): the overwrites go along, the channel still follows them
  let lay = await layoutNow();
  let r = await owner.a.put(`/api/v1/servers/${sid}/layout`, { categories: lay.categories.map(c => (c === 'Staff' ? 'Staff team' : c)), channels: lay.channels.map(c => ({ cid: c.cid, category: c.category === 'Staff' ? 'Staff team' : c.category })) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await seesIt(amy, sec.cid), false, 'still hidden after the rename');
  assert.equal((await owner.a.get(OW(sec.cid))).body.perms_synced, true);
  // the rename route
  r = await owner.a.put(`/api/v1/servers/${sid}/categories/${encodeURIComponent('Staff team')}`, { name: 'Crew' });
  assert.ok(r.body.categories.includes('Crew') && !r.body.categories.includes('Staff team'));
  assert.equal(await seesIt(amy, sec.cid), false, 'still hidden after the rename route');
  // removed: the channel moves to a neighbour with no such overwrites, keeps its own copy and stays hidden
  lay = await layoutNow();
  r = await owner.a.put(`/api/v1/servers/${sid}/layout`, { categories: lay.categories.filter(c => c !== 'Crew') });
  assert.equal(r.status, 200);
  assert.equal(await seesIt(amy, sec.cid), false, 'still hidden after its category went');
  const now = (await owner.a.get(OW(sec.cid))).body;
  assert.deepEqual([now.perms_synced, now.overwrites.map(o => [o.id, o.deny_names])], [false, [[everyoneRid, ['view_channel']]]]);
  // moving a following channel to another category (PATCH) keeps what it had too
  const moved = await newChannel('moved', { category: 'Voice channels' });
  await owner.a.put(CAT('Voice channels', '/role/everyone'), { deny: ['view_channel'] });
  assert.equal(await seesIt(amy, moved.cid), false);
  await owner.a.patch(`/api/v1/channels/${moved.cid}`, { category: 'Text channels' });
  assert.equal(await seesIt(amy, moved.cid), false, 'still hidden after the move');
  await owner.a.del(CAT('Voice channels', '/role/everyone'));
});

test('review 2: following the category again is checked like an edit (no dropping denies you could not set)', async () => {
  const chan = await newChannel('priv2', { category: 'Text channels' });
  await owner.a.put(OW(chan.cid, '/role/everyone'), { deny: ['view_channel', 'send_messages'] });
  const rid = (await owner.a.post(`/api/v1/servers/${sid}/roles`, { name: 'Chan', permissions: ['manage_channels'] })).body.role.rid;
  await owner.a.put(`/api/v1/servers/${sid}/members/${encodeURIComponent(ben.user.id)}/roles/${rid}`);
  let r = await ben.a.post(OW(chan.cid, '/sync'));
  assert.deepEqual([r.status, r.body.error], [403, 'cannot_grant']);
  assert.equal(await seesIt(amy, chan.cid), false, 'still private');
  r = await ben.a.put(OW(chan.cid, '/role/everyone'), { deny: [] });
  assert.equal(r.body.error, 'cannot_grant');
  await owner.a.del(`/api/v1/servers/${sid}/members/${encodeURIComponent(ben.user.id)}/roles/${rid}`);
});

test('review 3: a bot is told about voice in the channels it can see only', () => {
  const C = require('../src/communities'), V = require('../src/voice'), BV = require('../src/bot-voice');
  const c = db.get('SELECT * FROM communities WHERE sid = ?', sid), snap = C.snapOf(c);
  const vc = snap.channels.find(x => x.cid === voice), amyId = db.get('SELECT id FROM users WHERE principal = ?', amy.user.id).id;
  V.voiceIn.set('bf_' + voice, new Map([[1, { id: owner.user.id, username: 'owner', muted: false, deafened: false }]]));
  try {
    db.run("INSERT OR REPLACE INTO perm_overwrites (community_id, channel_id, target_type, target_id, allow, deny) VALUES (?, ?, 'member', ?, 0, ?)", c.id, vc.id, amyId, P.VIEW);
    const s2 = C.snapOf(db.get('SELECT * FROM communities WHERE sid = ?', sid));
    assert.equal(BV.voiceStates(c, s2, () => 1, amyId).length, 0);
    assert.equal(BV.voiceStates(c, s2, () => 1, null).length, 1);
  } finally { V.voiceIn.delete('bf_' + voice); db.run("DELETE FROM perm_overwrites WHERE channel_id = ? AND target_type = 'member' AND target_id = ?", vc.id, amyId); }
});

test('review 4 + 5: an edit cannot add embeds without Embed links, nor other servers\' emojis without Use external emojis', async () => {
  const M = require('../src/messages'), auth = require('../src/auth');
  const chan = await newChannel('edits');
  const m = (await post(amy, chan.cid, 'plain')).body.message;
  await owner.a.put(OW(chan.cid, `/member/${encodeURIComponent(amy.user.id)}`), { deny: ['embed_links', 'use_external_emojis'] });
  const me = auth.userByPrincipal(amy.user.id);
  const out = await M.editMessage(m.id, me, 'plain still', { embeds: [{ title: 'sneaky', url: 'https://example.org' }] });
  assert.deepEqual([out.embeds, out.suppress_embeds], [undefined, true]);
  await assert.rejects(M.editMessage(m.id, me, 'now <:party:eOTHER9999>'), e => e.code === 'no_external_emojis');
});

test('review 6: without Read message history: no single-message fetch for bots, no starboard entries, a pin is only a flag, a reply has no preview', async () => {
  const chan = await newChannel('history');
  const first = (await post(owner, chan.cid, 'the earlier one')).body.message;
  await owner.a.put(OW(chan.cid, `/member/${encodeURIComponent(amy.user.id)}`), { deny: ['read_message_history'] });
  const wa = await wsClient(base).login(amy.session), wb = await wsClient(base).login(ben.session);
  // a reply: amy gets it without the text of the earlier message; ben with it
  await post(owner, chan.cid, 'answer', { reply_to: first.id });
  const a = await wa.waitFor(f => f.type === 'chat_message' && f.message.body === 'answer');
  const b = await wb.waitFor(f => f.type === 'chat_message' && f.message.body === 'answer');
  assert.deepEqual(a.message.reply, { id: first.id, earlier: true });
  assert.equal(b.message.reply.body, 'the earlier one');
  // a pin: amy gets only the flag
  await owner.a.put(`/api/v1/messages/${first.id}/pin`);
  const pinned = await wa.waitFor(f => f.type === 'chat_message_pinned');
  assert.deepEqual(pinned, { type: 'chat_message_pinned', server: sid, channel: chan.cid, id: first.id, pinned: true });
  await wb.waitFor(f => f.type === 'chat_message_update' && f.message.id === first.id && f.message.pinned);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!wa.frames.some(f => f.type === 'chat_message_update' && f.message?.id === first.id));
  wa.close(); wb.close();
  // starboard: amy does not get entries from a channel whose history she may not read
  const board = await newChannel('stars', { type: 'starboard', config: { min: 1, watch: [chan.cid] } });
  for (const who of [owner, ben]) await who.a.put(`/api/v1/messages/${first.id}/reactions/${encodeURIComponent('⭐')}`);
  const forBen = (await ben.a.get(`/api/v1/channels/${board.cid}/starboard`)).body, forAmy = (await amy.a.get(`/api/v1/channels/${board.cid}/starboard`)).body;
  assert.ok(forBen.recent.some(x => x.id === first.id), JSON.stringify(forBen).slice(0, 200));
  assert.ok(!forAmy.recent.some(x => x.id === first.id));
});

test('review 8: manage_channel in one channel lets someone edit and delete that channel; a channel deny takes it from a manager', async () => {
  const chan = await newChannel('managed');
  assert.equal((await amy.a.patch(`/api/v1/channels/${chan.cid}`, { topic: 'x' })).status, 403);
  await owner.a.put(OW(chan.cid, `/member/${encodeURIComponent(amy.user.id)}`), { allow: ['manage_channel'] });
  assert.equal((await amy.a.patch(`/api/v1/channels/${chan.cid}`, { topic: 'mine now' })).body.channel.topic, 'mine now');
  const rid = (await owner.a.post(`/api/v1/servers/${sid}/roles`, { name: 'Chan2', permissions: ['manage_channels'] })).body.role.rid;
  await owner.a.put(`/api/v1/servers/${sid}/members/${encodeURIComponent(ben.user.id)}/roles/${rid}`);
  await owner.a.put(OW(chan.cid, `/member/${encodeURIComponent(ben.user.id)}`), { deny: ['manage_channel'] });
  assert.equal((await ben.a.patch(`/api/v1/channels/${chan.cid}`, { topic: 'no' })).status, 403);
  assert.equal((await ben.a.del(`/api/v1/channels/${chan.cid}`)).status, 403);
  assert.equal((await amy.a.del(`/api/v1/channels/${chan.cid}`)).status, 200);
  await owner.a.del(`/api/v1/servers/${sid}/members/${encodeURIComponent(ben.user.id)}/roles/${rid}`);
});

test('review 9: an overwrite on the owner can be removed; a whole list sent back names unchanged entries above you freely', async () => {
  const chan = await newChannel('owner-ow');
  const c = db.get('SELECT * FROM communities WHERE sid = ?', sid), ch = db.get('SELECT * FROM channels WHERE cid = ?', chan.cid);
  const ownerId = db.get('SELECT id FROM users WHERE principal = ?', owner.user.id).id;
  db.run("INSERT INTO perm_overwrites (community_id, channel_id, target_type, target_id, allow, deny) VALUES (?, ?, 'member', ?, 0, ?)", c.id, ch.id, ownerId, P.SEND);
  db.run('UPDATE channels SET perms_synced = 0 WHERE id = ?', ch.id);
  assert.equal((await owner.a.del(OW(chan.cid, `/member/${encodeURIComponent(owner.user.id)}`))).status, 200);
  // the moderator sends back the list with the (higher) Mods role's overwrite unchanged and one change of their own
  await owner.a.put(OW(chan.cid, `/role/${modRid}`), { allow: ['attach_files'] });
  const list = (await mod.a.get(OW(chan.cid))).body.overwrites.map(o => ({ type: o.type, id: o.id, allow: o.allow, deny: o.deny }));
  const r = await mod.a.put(OW(chan.cid), { overwrites: [...list, { type: 'role', id: 'everyone', deny: ['add_reactions'] }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // and the old route (PUT /perms) works with it there too
  assert.equal((await owner.a.put(`/api/v1/channels/${chan.cid}/perms`, { overwrites: [] })).status, 200);
});

test('review 10: member overwrites (and whole categories) only for the people who manage them', async () => {
  const chan = await newChannel('quiet', { category: 'Text channels' });
  await owner.a.put(OW(chan.cid, `/member/${encodeURIComponent(ben.user.id)}`), { deny: ['add_reactions'] });
  await owner.a.put(OW(chan.cid, '/role/everyone'), { deny: ['embed_links'] });
  const forAmy = (await amy.a.get(`/api/v1/servers/${sid}`)).body.channels.find(c => c.cid === chan.cid);
  assert.deepEqual(forAmy.permission_overwrites.map(o => o.type), ['role']);
  assert.deepEqual((await amy.a.get(OW(chan.cid))).body.overwrites.map(o => o.type), ['role']);
  const forOwner = (await owner.a.get(`/api/v1/servers/${sid}`)).body.channels.find(c => c.cid === chan.cid);
  assert.deepEqual(forOwner.permission_overwrites.map(o => o.type).sort(), ['member', 'role']);
  // a category with no channel you can see: not there for you
  await owner.a.put(`/api/v1/servers/${sid}/layout`, { categories: [...(await layoutNow()).categories, 'Locked'] });
  const locked = await newChannel('locked-in', { category: 'Locked' });
  await owner.a.put(OW(locked.cid, '/role/everyone'), { deny: ['view_channel'] });
  assert.equal((await amy.a.get(CAT('Locked'))).body.error, 'category_not_found');
  assert.equal((await owner.a.get(CAT('Locked'))).status, 200);
});

test('the v36 migration: the old see / send / attach settings become role overwrites, @everyone gets the new bits', async () => {
  // a database as v35 left it: channel_perms rows, @everyone with the old bits only
  const c = db.get('SELECT * FROM communities WHERE sid = ?', sid);
  const ch = db.get("SELECT * FROM channels WHERE community_id = ? AND type = 'voice'", c.id), txt = db.get('SELECT * FROM channels WHERE cid = ?', general);
  const ev = db.get('SELECT * FROM roles WHERE community_id = ? AND is_default = 1', c.id), modRole = db.get('SELECT * FROM roles WHERE rid = ?', modRid);
  db.raw().exec('CREATE TABLE channel_perms (channel_id INTEGER NOT NULL, role_id INTEGER NOT NULL, allow INTEGER NOT NULL DEFAULT 0, deny INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel_id, role_id))');
  db.run('DELETE FROM perm_overwrites WHERE community_id = ?', c.id);
  db.run('UPDATE channels SET perms_synced = 1 WHERE community_id = ?', c.id);
  db.run('INSERT INTO channel_perms VALUES (?, ?, 0, ?)', ch.id, ev.id, P.SEND);
  db.run('INSERT INTO channel_perms VALUES (?, ?, ?, 0)', txt.id, modRole.id, P.VIEW);
  db.run('UPDATE roles SET permissions = ? WHERE id = ?', 1 | 256 | 8192, ev.id);
  db.run('UPDATE roles SET permissions = ? WHERE id = ?', P.MANAGE_MESSAGES, modRole.id);
  db.raw().exec('PRAGMA user_version = 35');
  await inst.close();
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url;
  assert.equal(db.raw().prepare('PRAGMA user_version').get().user_version >= 36, true);
  assert.ok(!db.get("SELECT 1 FROM sqlite_master WHERE name = 'channel_perms'"), 'the old table is gone');
  const o = db.all('SELECT * FROM perm_overwrites WHERE community_id = ? ORDER BY channel_id', c.id);
  assert.deepEqual(o.map(x => [x.channel_id, x.target_type, x.target_id, x.allow, x.deny]).sort(), [
    [ch.id, 'role', ev.id, 0, P.SEND | perms.VOICE_BITS], [txt.id, 'role', modRole.id, P.VIEW, 0]].sort());
  assert.equal(db.get('SELECT perms_synced FROM channels WHERE id = ?', ch.id).perms_synced, 0);
  assert.equal(db.get('SELECT permissions FROM roles WHERE id = ?', ev.id).permissions, perms.upgradeRole(1 | 256 | 8192, true));
  assert.equal(db.get('SELECT permissions FROM roles WHERE id = ?', modRole.id).permissions, P.MANAGE_MESSAGES | P.PIN_MESSAGES);
});
