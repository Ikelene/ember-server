'use strict';
// Server settings > Insights: who may see it, counts on seeded data, bucket boundaries, the bots switch, joins / leaves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api } = require('./helpers');
const { startServer } = require('../src/index');
const M = require('../src/messages');
const db = require('../src/db');
const I = require('../src/insights');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_MANAGED;
const dir = tmpDir();
let inst, owner, bob, cat, sid, cid, S, c, chId, botId;

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

async function person(name) {
  const r = await api(inst.url).post('/api/v1/auth/register', { username: name, password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, a: api(inst.url, r.body.session) };
}
const uid = p => db.get('SELECT id FROM users WHERE principal = ?', p.user?.id ?? p.user_id ?? p.principal)?.id;

test('setup', async () => {
  owner = await person('owner');
  assert.equal((await owner.a.post('/api/v1/instance/claim', { code: inst.setup.current() })).status, 200);
  const d = (await owner.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid; cid = d.channels.find(x => x.type === 'text').cid; S = `/api/v1/servers/${sid}`;
  bob = await person('bob'); cat = await person('cat');
  assert.equal((await bob.a.post(S + '/join')).status, 200);
  c = db.get('SELECT * FROM communities WHERE sid = ?', sid);
  chId = db.get('SELECT id FROM channels WHERE cid = ?', cid).id;
  const t = Date.now();
  botId = Number(db.run("INSERT INTO users (principal, kind, username, display_name, created_at) VALUES ('bot:test', 'bot', 'robo', 'Robo', ?)", t).lastInsertRowid);
  db.run('INSERT INTO members (community_id, user_id, joined_at) VALUES (?, ?, ?)', c.id, botId, t);
});

test('permissions: normal members and outsiders get 403, managers and the owner see it', async () => {
  const r = await bob.a.get(S + '/insights');
  assert.equal(r.status, 403); assert.equal(r.body.error, 'not_allowed');
  const o = await cat.a.get(S + '/insights');
  assert.equal(o.status, 403);
  const ok = await owner.a.get(S + '/insights?range=24h');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.range, '24h'); assert.equal(ok.body.count, 24); assert.equal(ok.body.step_ms, 3600000);
  assert.equal(ok.body.members.now, 2); // owner + bob (the bot isn't a person)
  assert.ok(ok.body.members.joins_total >= 2, 'creation + bob joining are recorded');
  assert.equal(ok.body.voice, null);
  // give bob Manage server through a role
  const role = (await owner.a.post(S + '/roles', { name: 'mods', permissions: 4 })).body;
  const rid = role.role?.rid ?? role.rid;
  const bobP = db.get("SELECT principal FROM users WHERE username = 'bob'").principal;
  const give = await owner.a.put(`${S}/members/${encodeURIComponent(bobP)}/roles/${rid}`);
  assert.ok(give.status === 200 || give.status === 204, JSON.stringify(give.body));
  assert.equal((await bob.a.get(S + '/insights')).status, 200);
  assert.equal((await owner.a.get(S + '/insights?range=nope')).body.range, '7d'); // unknown ranges fall back
});

test('counts, bucket boundaries and the bots switch on seeded data', () => {
  const at = Date.UTC(2030, 0, 15, 12, 30); // far from the live rows above
  const w = I.window_('24h', 0, at);
  assert.equal(w.end, Date.UTC(2030, 0, 15, 13)); assert.equal(w.start, Date.UTC(2030, 0, 14, 13));
  const o = db.get("SELECT id FROM users WHERE username = 'owner'").id, b = db.get("SELECT id FROM users WHERE username = 'bob'").id;
  const msg = (user, t, extra = {}) => Number(db.run('INSERT INTO messages (channel_id, user_id, body, system, webhook_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', chId, user, 'x', extra.system ? 1 : 0, extra.webhook ?? null, t).lastInsertRowid);
  msg(o, w.start - 1);            // previous range
  const first = msg(o, w.start);  // bucket 0
  msg(b, w.start + 3600000 - 1);  // still bucket 0
  msg(b, w.start + 3600000);      // bucket 1
  msg(o, w.end - 1);              // bucket 23
  msg(o, w.end);                  // after the range: ignored
  msg(botId, w.start + 5);        // a bot (bucket 0)
  msg(null, w.start + 6, { webhook: 1 }); // a webhook (bucket 0)
  msg(o, w.start + 7, { system: true }); // a system notice: never counted
  db.run('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', first, b, 'x', w.start + 10);
  db.run('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', first, botId, 'x', w.start + 11);
  db.run("INSERT INTO member_events (community_id, user_id, kind, at) VALUES (?, ?, 'join', ?)", c.id, b, w.start + 100);
  db.run("INSERT INTO member_events (community_id, user_id, kind, at) VALUES (?, ?, 'leave', ?)", c.id, b, w.start + 2 * 3600000);
  db.run("INSERT INTO member_events (community_id, user_id, kind, at) VALUES (?, ?, 'join', ?)", c.id, botId, w.start + 100); // bots don't count

  const v = I.compute(c, { range: '24h', bots: false, tz: 0 }, at);
  assert.equal(v.messages.total, 4);
  assert.deepEqual([v.messages.series[0], v.messages.series[1], v.messages.series[23]], [2, 1, 1]);
  assert.equal(v.messages.prev, 1);
  assert.deepEqual([v.chatters.series[0], v.chatters.series[1], v.chatters.series[23]], [2, 1, 1]);
  assert.equal(v.chatters.total, 2); assert.equal(v.chatters.prev, 1);
  assert.equal(v.reactions.total, 1);
  assert.equal(v.members.joins[0], 1); assert.equal(v.members.leaves[2], 1); assert.equal(v.members.joins_total, 1);
  assert.equal(v.members.series[23], v.members.now);
  assert.equal(v.members.series[0], v.members.now + 1); // bob was still in before the leave
  assert.equal(v.top_channels[0].cid, cid); assert.equal(v.top_channels[0].messages, 4); assert.equal(v.top_channels[0].spark[0], 2);
  assert.deepEqual(v.top_chatters.map(x => x.username).sort(), ['bob', 'owner']);
  // 2030-01-14 13:00 UTC is a Monday
  assert.equal(v.heatmap[1][13], 2); assert.equal(v.heatmap[1][14], 1); assert.equal(v.heatmap[2][12], 1);

  const withBots = I.compute(c, { range: '24h', bots: true, tz: 0 }, at);
  assert.equal(withBots.messages.total, 6);
  assert.equal(withBots.messages.series[0], 4);
  assert.equal(withBots.chatters.total, 2, 'unique chatters are always people');
  assert.equal(withBots.reactions.total, 2);
  assert.ok(withBots.top_chatters.some(x => x.bot));

  // daily buckets follow the viewer's midnight: UTC+2 (tz -120) -> days end at 22:00 UTC
  const d = I.window_('7d', -120, at);
  assert.equal(d.end, Date.UTC(2030, 0, 15, 22)); assert.equal(d.end - d.start, 7 * 86400000);
  const v7 = I.compute(c, { range: '7d', bots: false, tz: -120 }, at);
  assert.equal(v7.count, 7);
  assert.equal(v7.messages.series[6], 2, 'Jan 15 local (from 22:00 UTC Jan 14)');
  assert.equal(v7.messages.series[5], 4, 'Jan 14 local (the previous-range message too)');
  assert.equal(v7.heatmap[1][15], 2); // Monday 13:00 UTC = 15:00 local
});

test('kicks and leaves are recorded as leave events', async () => {
  const dan = await person('dan');
  assert.equal((await dan.a.post(S + '/join')).status, 200);
  const danId = db.get("SELECT id FROM users WHERE username = 'dan'").id;
  assert.ok(db.get("SELECT 1 FROM member_events WHERE user_id = ? AND kind = 'join'", danId));
  assert.equal((await dan.a.post(S + '/leave')).status < 300, true);
  const ev = db.get("SELECT reason FROM member_events WHERE user_id = ? AND kind = 'leave'", danId);
  assert.equal(ev?.reason, 'left');
  I._reset();
  M._sendLimit.reset();
  assert.equal((await owner.a.post(`/api/v1/channels/${cid}/messages`, { message: 'hello' })).status, 200);
  const v = (await owner.a.get(S + '/insights?range=24h&tz=0')).body;
  assert.equal(v.members.leaves_total, 1);
  assert.equal(v.messages.total, 1);
  assert.equal(v.chatters.dau, 1);
  assert.ok(v.members.leaves_since > 0);
});
