'use strict';
// A Matrix space imported as the instance's community (src/bridge/matrix-import.js, PROTOCOL §16.6) against a local fake
// homeserver: the bot is checked before anything is listed, invites are accepted, rooms become channels and sub-spaces
// categories, invite-only rooms stay private, the picture and emoji come over, and "bridge it" links the rooms.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
delete process.env.EMBER_OWNER;
delete process.env.EMBER_MATRIX_TOKEN;
delete process.env.EMBER_MATRIX_HOMESERVER;
const dir = tmpDir();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const TOKEN = 'syt_import_token_QRST', BOT = '@porter:fake.test';

const SPACE = '!space:fake.test', GAMES = '!games:fake.test';
const ROOMS = {
  [SPACE]: { type: 'm.space', name: 'Tea House', topic: 'A place for tea', avatar: 'mxc://fake.test/icon', children: [['!gen:fake.test', 'a'], ['!news:fake.test', 'b'], ['!staff:fake.test', 'c'], ['!vault:fake.test', 'd'], ['!lobby:fake.test', 'e'], ['!call:fake.test', 'f'], ['!odd:fake.test', 'g'], [GAMES, 'h'], ['!hidden:fake.test', 'i']],
    emotes: { images: { 'tea cup': { url: 'mxc://fake.test/tea' }, sticker_only: { url: 'mxc://fake.test/st', usage: ['sticker'] }, wave: { url: 'mxc://fake.test/wave' } } } },
  '!gen:fake.test': { name: 'General Chat', topic: 'anything goes', join: 'restricted' },
  '!news:fake.test': { name: 'News', join: 'public', power: { events_default: 50, users_default: 0 } },
  '!staff:fake.test': { name: 'Staff', join: 'invite' },
  '!vault:fake.test': { name: 'Vault', join: 'restricted', encrypted: true },
  '!call:fake.test': { name: 'Voice', type: 'org.matrix.msc3417.call', join: 'restricted' },
  '!odd:fake.test': { name: 'Odd', type: 'org.example.thing', join: 'public' },
  [GAMES]: { type: 'm.space', name: 'Games', children: [['!mc:fake.test', 'a']] },
  '!mc:fake.test': { name: 'minecraft', join: 'restricted' },
  '!loose:fake.test': { name: 'Loose room', join: 'invite' },
};
const LOBBY = { room_id: '!lobby:fake.test', name: 'Lobby', topic: 'say hi', join_rule: 'public' }; // in the space, the bot is not in it
const joined = new Set(Object.keys(ROOMS).filter(id => id !== '!mc:fake.test'));
const invited = new Set(['!mc:fake.test']);
const calls = [];
function stateOf(id) {
  const r = ROOMS[id], ev = (type, content, key = '') => ({ type, state_key: key, content, origin_server_ts: 1 });
  return [ev('m.room.create', r.type ? { type: r.type } : {}), ...(r.name ? [ev('m.room.name', { name: r.name })] : []), ...(r.topic ? [ev('m.room.topic', { topic: r.topic })] : []),
    ...(r.avatar ? [ev('m.room.avatar', { url: r.avatar })] : []), ev('m.room.join_rules', { join_rule: r.join || 'invite' }), ...(r.power ? [ev('m.room.power_levels', r.power)] : []),
    ...(r.encrypted ? [ev('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' })] : []), ...(r.children || []).map(([k, order]) => ev('m.space.child', { via: ['fake.test'], order }, k)),
    ...(r.emotes ? [ev('im.ponies.room_emotes', r.emotes)] : [])];
}
let fake, fbase;
function fakeServer() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const p = decodeURIComponent(u.pathname), auth = req.headers.authorization || null;
      const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!p.endsWith('/sync')) calls.push({ method: req.method, path: p, query: u.search });
      if (p === '/.well-known/matrix/client') return json(404, {});
      if (auth !== `Bearer ${TOKEN}`) return json(401, { errcode: 'M_UNKNOWN_TOKEN' });
      if (p.startsWith('/_matrix/client/v1/media/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
      let m = /^\/_matrix\/client\/v1\/rooms\/([^/]+)\/hierarchy$/.exec(p);
      if (m) return json(200, { rooms: [{ room_id: SPACE, room_type: 'm.space', name: 'Tea House', children_state: stateOf(SPACE).filter(e => e.type === 'm.space.child') }, LOBBY] });
      const v3 = p.replace('/_matrix/client/v3', '');
      if (v3 === '/account/whoami') return json(200, { user_id: BOT });
      if (v3 === '/joined_rooms') return json(200, { joined_rooms: [...joined] });
      if (v3 === '/sync') {
        if (u.searchParams.get('since')) return setTimeout(() => json(200, { next_batch: 's2' }), 100);
        const join = {};
        // (the last state event sits in the timeline, as a homeserver sends it)
        for (const id of joined) { const all = stateOf(id); join[id] = { state: { events: all.slice(0, -1) }, timeline: { events: all.slice(-1) } }; }
        return json(200, { next_batch: 's1', rooms: { join, invite: Object.fromEntries([...invited].map(id => [id, { invite_state: { events: [] } }])) } });
      }
      m = /^\/rooms\/([^/]+)\/join$/.exec(v3) || /^\/join\/([^/]+)$/.exec(v3);
      if (m && req.method === 'POST') { if (m[1] === LOBBY.room_id) ROOMS[m[1]] = { name: 'Lobby', join: 'public' }; if (!ROOMS[m[1]]) return json(403, { errcode: 'M_FORBIDDEN' }); invited.delete(m[1]); joined.add(m[1]); return json(200, { room_id: m[1] }); }
      m = /^\/rooms\/([^/]+)\/state\/([^/]+)\/(.*)$/.exec(v3);
      if (m) {
        const ev = joined.has(m[1]) && stateOf(m[1]).find(e => e.type === m[2] && e.state_key === m[3]);
        return ev && Object.keys(ev.content).length ? json(200, ev.content) : json(404, { errcode: 'M_NOT_FOUND' });
      }
      return json(404, { errcode: 'M_UNRECOGNIZED' });
    });
  });
}

let inst, base, MX, alice, bob;
test.before(async () => {
  fake = fakeServer();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  fbase = `http://127.0.0.1:${fake.address().port}`;
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  MX = require('../src/bridge/matrix');
  MX._test.allowLocal(true);
  const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); return { ...r.body, a: api(base, r.body.session) }; };
  alice = await reg('alice'); bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
});
test.after(async () => { await inst.close(); MX._test.allowLocal(false); fake.closeAllConnections?.(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('nothing is listed until a bot is given, and only admins may', async () => {
  assert.equal((await bob.a.get('/api/v1/import/matrix')).status, 403);
  assert.deepEqual((await alice.a.get('/api/v1/import/matrix')).body, { ready: false, bot: null, saved: false, can_bridge: true });
  const r = await alice.a.get('/api/v1/import/matrix/guilds');
  assert.equal(r.status, 503); assert.equal(r.body.error, 'bridge_not_set_up');
});

test('the bot is checked on its homeserver; the token never comes back', async () => {
  let r = await alice.a.put('/api/v1/import/matrix/bot', { homeserver: fbase, token: 'nope' });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'invalid_token');
  r = await alice.a.put('/api/v1/import/matrix/bot', { homeserver: 'ftp://x', token: TOKEN });
  assert.equal(r.body.error, 'invalid_homeserver');
  r = await alice.a.put('/api/v1/import/matrix/bot', { homeserver: fbase, token: TOKEN });
  assert.deepEqual(r.body, { ready: true, bot: BOT, saved: false, can_bridge: true });
  assert.ok(!JSON.stringify(r.body).includes(TOKEN));
  assert.equal(MX.configured(), false); // not the bridge's bot (yet)
});

test('spaces the bot is in are listed, and its invites accepted', async () => {
  const r = await alice.a.get('/api/v1/import/matrix/guilds');
  assert.equal(r.status, 200);
  assert.ok(calls.some(c => c.method === 'POST' && c.path.endsWith('/rooms/!mc:fake.test/join')));
  assert.deepEqual(r.body.guilds.map(g => [g.id, g.name]), [[GAMES, 'Games'], [SPACE, 'Tea House'], ['rooms', 'Rooms outside a space']]);
  assert.equal(r.body.bot, BOT);
});

test('the preview: rooms as channels, a sub-space as a category', async () => {
  const d = (await alice.a.get(`/api/v1/import/matrix/guilds/${encodeURIComponent(SPACE)}`)).body;
  assert.equal(d.guild.name, 'Tea House'); assert.equal(d.guild.description, 'A place for tea'); assert.equal(d.guild.has_icon, true);
  assert.deepEqual(d.groups.map(g => g.name), ['Text channels', 'Games']);
  const ch = Object.fromEntries(d.groups.flatMap(g => g.channels).map(c => [c.name, c]));
  assert.deepEqual(d.groups[0].channels.map(c => c.name), ['General Chat', 'News', 'Staff', 'Vault', 'Lobby', 'Voice', 'Odd']); // in the space's order; "hidden" is not shown to the bot
  assert.equal(ch.News.locked, true); assert.equal(ch['General Chat'].locked, false);
  assert.equal(ch.Staff.private, true); assert.equal(ch['General Chat'].private, false);
  assert.equal(ch.Vault.encrypted, true);
  assert.equal(ch.Lobby.joined, false); assert.equal(ch.Lobby.topic, 'say hi');
  assert.equal(ch.Voice.kind, 'voice'); assert.equal(ch.Odd.kind, null);
  assert.deepEqual(d.groups[1].channels.map(c => c.name), ['minecraft']);
  assert.deepEqual(d.roles.map(r => r.name), ['Admin', 'Moderator']);
  assert.deepEqual(d.emojis.map(e => e.name), ['tea_cup', 'wave']);
  assert.ok(!JSON.stringify(d).includes('"via"'));
  assert.equal((await alice.a.get('/api/v1/import/matrix/guilds/!nowhere:fake.test')).body.error, 'bot_not_in_server');
  const loose = (await alice.a.get('/api/v1/import/matrix/guilds/rooms')).body;
  assert.ok(loose.groups[0].channels.some(c => c.name === 'Loose room'));
});

let sid;
test('the import makes the community, and bridges the rooms it can', async () => {
  assert.equal((await alice.a.post('/api/v1/import/matrix', { guild_id: SPACE, channels: [] })).body.error, 'pick_a_channel');
  const ids = ['!gen:fake.test', '!news:fake.test', '!staff:fake.test', '!vault:fake.test', '!lobby:fake.test', '!call:fake.test', '!odd:fake.test', '!mc:fake.test'];
  const r = await alice.a.post('/api/v1/import/matrix', { guild_id: SPACE, channels: ids, roles: ['admin', 'mod'], name: 'Tea on Ember', bridge: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual({ ...r.body, sid: null }, { sid: null, channels: 7, roles: 2, emojis: 2, bridged: 5 });
  sid = r.body.sid;
  const d = (await alice.a.get(`/api/v1/servers/${sid}`)).body;
  assert.equal(d.server.name, 'Tea on Ember'); assert.equal(d.server.description, 'A place for tea');
  assert.match(d.server.icon, /\/uploads\/imported\/.+\/icon\.png$/);
  const ch = Object.fromEntries(d.channels.map(c => [c.name, c]));
  assert.deepEqual(d.channels.map(c => [c.name, c.category, c.type]), [['general-chat', 'Text channels', 'text'], ['news', 'Text channels', 'text'], ['staff', 'Text channels', 'text'], ['vault', 'Text channels', 'text'], ['lobby', 'Text channels', 'text'], ['voice', 'Text channels', 'voice'], ['minecraft', 'Games', 'text']]);
  assert.equal(ch['general-chat'].topic, 'anything goes');
  assert.equal(ch.news.locked, true);
  assert.deepEqual(d.roles.filter(x => !x.is_default).map(x => x.name).sort(), ['Admin', 'Moderator']);
  assert.deepEqual(require('../src/db').all('SELECT name FROM emojis ORDER BY name').map(e => e.name), ['tea_cup', 'wave']);
  // an invite-only room: hidden from @everyone, shown to the roles that came over
  const db = require('../src/db');
  const perms = db.all('SELECT r.name, cp.allow, cp.deny FROM channel_perms cp JOIN roles r ON r.id = cp.role_id JOIN channels c ON c.id = cp.channel_id WHERE c.cid = ?', ch.staff.cid);
  assert.deepEqual(perms.map(x => [x.name, x.allow, x.deny]).sort(), [['@everyone', 0, 1024], ['Admin', 1024, 0], ['Moderator', 1024, 0]]);
  // bridged: the bot became the bridge's bot; every text room it is in (or could walk into) is linked, but not the encrypted one
  assert.equal(MX.configured(), true); assert.equal(MX.botId(), BOT);
  const links = db.all("SELECT c.name, bc.ext_channel_id FROM bridge_channels bc JOIN channels c ON c.id = bc.channel_id JOIN bridge_guilds bg ON bg.id = bc.bridge_id WHERE bg.platform = 'matrix'");
  assert.deepEqual(links.map(x => [x.name, x.ext_channel_id]).sort(), [['general-chat', '!gen:fake.test'], ['lobby', '!lobby:fake.test'], ['minecraft', '!mc:fake.test'], ['news', '!news:fake.test'], ['staff', '!staff:fake.test']]);
  assert.ok(calls.some(c => c.method === 'POST' && c.path.endsWith('/join/!lobby:fake.test') && c.query.includes('server_name=fake.test')));
});

test('a second import makes a second server', async () => {
  assert.equal((await alice.a.get('/api/v1/import/matrix')).status, 200);
  const before = (await alice.a.get('/api/v1/servers')).body.servers.length;
  const r = await alice.a.post('/api/v1/import/matrix', { guild_id: SPACE, channels: ['!gen:fake.test'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = (await alice.a.get('/api/v1/servers')).body.servers;
  assert.equal(list.length, before + 1);
  assert.equal(list.find(s => s.sid === r.body.sid).role, 'owner');
  assert.equal(new Set(list.map(s => s.slug)).size, list.length);
});
