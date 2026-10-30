'use strict';
// Unmarked aliases (PROTOCOL §14, §6.4 `advanced`): an owner-only server setting that lets bots' alias messages show with no alias
// mark, matched to a member of that server by name. Worked out at read time, so toggling it changes old messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');
const db = require('../src/db');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base, alice, bob, carol, dave, zed, sid, general, bot, token, chId, guildId, ugw, S;
const clients = [];
const reset = () => { require('../src/messages')._sendLimit.reset(); require('../src/routes/botapi')._hits.reset(); };
const reg = async n => {
  const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, a: api(base, r.body.session) };
};
const botCall = async (method, p, body) => {
  reset();
  const r = await fetch(base + '/bot/v1' + p, { method, headers: { Authorization: 'Bot ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const say = (name, content = 'hi', extra = {}) => botCall('POST', `/channels/${chId}/messages`, { content, alias: { name, ...extra } });
const history = async (who = alice) => (await who.a.get(`/api/v1/channels/${general}/messages`)).body.messages;
const inHistory = async (id, who) => (await history(who)).find(x => x.id === id);
const setUnmarked = (who, on) => who.a.patch(S + '/settings', { advanced: { unmarked_aliases: on } });

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('setup: a server, members, a bot', async () => {
  alice = await reg('alice');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid; S = `/api/v1/servers/${sid}`;
  bob = await reg('bob'); carol = await reg('carol'); dave = await reg('dave'); zed = await reg('zed');
  for (const p of [bob, carol, dave]) assert.equal((await p.a.post(`${S}/join`, {})).status, 200);
  // zed has an account on this instance but is not in Camp (an instance holds one server, so "another server" = not a member;
  // the lookup is scoped to the message's community_id either way)
  // bob is an Administrator of Camp (has Manage server, is not the owner)
  const adm = (await alice.a.post(`${S}/roles`, { name: 'admins', permissions: 512 })).body.role;
  assert.equal((await alice.a.put(`${S}/members/${encodeURIComponent(bob.user.id)}/roles/${adm.rid}`)).status < 300, true);
  const r = await alice.a.post('/api/v1/bots', { name: 'Sable', description: 'agent' });
  bot = r.body.bot; token = r.body.token;
  await alice.a.post('/api/v1/bots/by-name/sable/add', { sid });
  guildId = (await botCall('GET', '/users/@me/guilds')).body[0].id;
  chId = (await botCall('GET', `/guilds/${guildId}/channels`)).body.find(c => c.name === 'general').id;
  ugw = await wsClient(base).login(carol.session);
  clients.push(ugw);
});

let oldId;
test('off by default: settings say false, aliases are marked (unmarked: false, no member_id)', async () => {
  const s = (await alice.a.get(S + '/settings')).body.settings;
  assert.equal(s.advanced.unmarked_aliases, false);
  const r = await say('carol', 'before it was on');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.alias, { name: 'carol', avatar_url: null, unmarked: false });
  oldId = r.body.id;
  const m = await inHistory(oldId);
  assert.deepEqual(m.alias, { name: 'carol', avatar_url: null, unmarked: false });
});

test('only the owner can change it (not an Administrator, not with a bad value); the change is audited', async () => {
  const b = await setUnmarked(bob, true);
  assert.deepEqual([b.status, b.body.error], [403, 'owner_only']);
  const c = await setUnmarked(carol, true);
  assert.equal(c.status, 403);
  assert.equal((await alice.a.patch(S + '/settings', { advanced: { unmarked_aliases: 'yes' } })).status, 400);
  assert.equal((await alice.a.get(S + '/settings')).body.settings.advanced.unmarked_aliases, false);
  // bob changing something else in the same section family still works (owner-only is per key)
  assert.equal((await bob.a.patch(S + '/settings', { messages: { max_reactions: 21 } })).status, 200);
  const on = await setUnmarked(alice, true);
  assert.equal(on.status, 200);
  assert.equal(on.body.settings.advanced.unmarked_aliases, true);
  const log = (await alice.a.get(S + '/audit')).body;
  const e = (log.entries || log.audit || []).find(x => x.action === 'unmarked_aliases_update');
  assert.ok(e, 'audit entry');
  assert.equal(e.details.enabled, true);
});

test('on, but the bot lacks "Use unmarked aliases": still marked', async () => {
  const r = await say('carol', 'no permission yet');
  assert.equal(r.body.alias.unmarked, false);
  assert.equal(r.body.alias.member_id, undefined);
  assert.equal((await inHistory(oldId)).alias.unmarked, false);
});

let unmarkedRid;
test('on + permission: unmarked, matched to the member; old messages change too; gateway + bot API', async () => {
  const role = (await alice.a.post(`${S}/roles`, { name: 'puppets', permissions: 4096 })).body.role;
  assert.equal(role.permissions & 4096, 4096);
  unmarkedRid = role.rid;
  assert.ok((await alice.a.put(`${S}/members/${encodeURIComponent(bot.id)}/roles/${role.rid}`)).status < 300);
  const old = await inHistory(oldId);
  assert.equal(old.alias.unmarked, true);
  assert.equal(old.alias.member_id, carol.user.id);
  assert.equal(old.alias.member.username, 'carol');
  assert.equal(old.author.id, bot.id); // the real author never changes
  // case + whitespace insensitive; a fresh message on the user gateway
  const r = await say('  CAROL ', 'hello there');
  assert.equal(r.body.alias.unmarked, true);
  assert.match(r.body.alias.member_id, /^\d+$/);
  assert.equal(r.body.alias.member, undefined);
  const f = await ugw.waitFor(x => x.type === 'chat_message' && x.message.id === r.body.id);
  assert.equal(f.message.alias.unmarked, true);
  assert.equal(f.message.alias.member_id, carol.user.id);
  assert.equal(f.message.author.id, bot.id);
  // a name nobody has: unmarked, no member
  const n = await say('Nobody Here');
  assert.equal(n.body.alias.unmarked, true);
  assert.equal(n.body.alias.member_id, undefined);
});

test('matching: username beats display name, ambiguous display names match nobody, non-members never match', async () => {
  db.run("UPDATE users SET display_name = 'carol' WHERE username = 'bob'"); // bob's display name is carol: carol's username still wins
  const a = await inHistory((await say('carol')).body.id);
  assert.equal(a.alias.member_id, carol.user.id);
  db.run("UPDATE users SET display_name = 'Twin' WHERE username IN ('bob', 'dave')");
  const t = await inHistory((await say('twin')).body.id);
  assert.equal(t.alias.unmarked, true);
  assert.equal(t.alias.member_id, undefined);
  db.run("UPDATE users SET display_name = 'Solo Star' WHERE username = 'dave'");
  const s = await inHistory((await say('solo star')).body.id);
  assert.equal(s.alias.member_id, dave.user.id);
  // zed is not a member of this server: no match
  const z = await inHistory((await say('zed')).body.id);
  assert.equal(z.alias.unmarked, true);
  assert.equal(z.alias.member_id, undefined);
});

test('replies carry the unmarked alias too', async () => {
  const rep = await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'replying', reply_to: oldId });
  assert.equal(rep.body.message.reply.alias.unmarked, true);
  assert.equal(rep.body.message.reply.alias.member_id, carol.user.id);
});

test('Administrator also counts as the permission', async () => {
  assert.ok((await alice.a.del(`${S}/members/${encodeURIComponent(bot.id)}/roles/${unmarkedRid}`)).status < 300);
  assert.equal((await inHistory(oldId)).alias.unmarked, false);
  const adm = (await alice.a.post(`${S}/roles`, { name: 'botadmin', permissions: 512 })).body.role;
  assert.ok((await alice.a.put(`${S}/members/${encodeURIComponent(bot.id)}/roles/${adm.rid}`)).status < 300);
  assert.equal((await inHistory(oldId)).alias.unmarked, true);
});

test('turning it off marks old messages again; exports never carry it', async () => {
  assert.equal((await setUnmarked(alice, false)).status, 200);
  const m = await inHistory(oldId);
  assert.deepEqual(m.alias, { name: 'carol', avatar_url: null, unmarked: false });
  const S_ = require('../src/settings');
  const c = db.get('SELECT * FROM communities WHERE sid = ?', sid);
  assert.equal(S_.exportable(c).advanced, undefined);
  assert.deepEqual(S_.imported({ advanced: { unmarked_aliases: true } }, x => x).advanced, undefined);
  const log = (await alice.a.get(S + '/audit')).body;
  assert.equal((log.entries || []).filter(x => x.action === 'unmarked_aliases_update').length, 2);
});
