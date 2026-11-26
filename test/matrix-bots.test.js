'use strict';
// A Matrix bot per server (PROTOCOL §16.5): two servers bring two Matrix accounts, each with its own sync loop, rooms and
// place in the stream; a room both bots sit in is carried by the bot of the server it is linked to; a server without a bot
// falls back to the homeserver's. Against a local fake homeserver with two accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_MATRIX_TOKEN', 'EMBER_MATRIX_HOMESERVER', 'EMBER_MANAGED']) delete process.env[k];
const dir = tmpDir();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } }

// ---- the fake homeserver: two accounts, each in its own rooms and with its own /sync stream ----
const T1 = 'syt_token_one_AAAA', T2 = 'syt_token_two_BBBB';
const ACCOUNTS = {
  [T1]: { id: '@bot1:fake.test', rooms: ['!a:fake.test', '!both:fake.test'], queue: [], waiters: [], batch: 1, syncs: [] },
  [T2]: { id: '@bot2:fake.test', rooms: ['!b:fake.test', '!both:fake.test'], queue: [], waiters: [], batch: 1, syncs: [] },
};
const NAMES = { '!a:fake.test': 'general', '!b:fake.test': 'general', '!both:fake.test': 'shared' };
const calls = [];
let fake, fbase, sendN = 0;
// the next /sync of that account answers with these events in that room
function deliver(token, roomId, ...events) {
  const a = ACCOUNTS[token], body = { next_batch: `s${++a.batch}`, rooms: { join: { [roomId]: { timeline: { events } } } } };
  const w = a.waiters.shift();
  if (w) w(body); else a.queue.push(body);
}
function fakeServer() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
      const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const token = String(req.headers.authorization || '').replace(/^Bearer /, ''), a = ACCOUNTS[token];
      let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch { /* not json */ }
      if (p === '/.well-known/matrix/client') return json(404, {});
      if (!a) return json(401, { errcode: 'M_UNKNOWN_TOKEN' });
      const v3 = p.replace('/_matrix/client/v3', '');
      if (v3 !== '/sync') calls.push({ method: req.method, path: v3, token, body: parsed });
      if (v3 === '/account/whoami') return json(200, { user_id: a.id });
      if (v3 === '/joined_rooms') return json(200, { joined_rooms: a.rooms });
      if (v3 === '/sync') {
        a.syncs.push(u.searchParams.get('since'));
        if (!u.searchParams.get('since')) return json(200, { next_batch: `s${a.batch}`, rooms: {} });
        if (a.queue.length) return json(200, a.queue.shift());
        const w = b => { clearTimeout(t); json(200, b); };
        const t = setTimeout(() => { const i = a.waiters.indexOf(w); if (i >= 0) a.waiters.splice(i, 1); json(200, { next_batch: `s${a.batch}` }); }, 150);
        a.waiters.push(w);
        res.on('close', () => { const i = a.waiters.indexOf(w); if (i >= 0) { a.waiters.splice(i, 1); clearTimeout(t); } });
        return undefined;
      }
      let m = /^\/rooms\/([^/]+)\/state\/([^/]+)\/(.*)$/.exec(v3);
      if (m) {
        if (!a.rooms.includes(m[1])) return json(403, { errcode: 'M_FORBIDDEN' });
        return m[2] === 'm.room.name' ? json(200, { name: NAMES[m[1]] }) : json(404, { errcode: 'M_NOT_FOUND' });
      }
      m = /^\/rooms\/([^/]+)\/send\/m\.room\.message\/([^/]+)$/.exec(v3);
      if (m && req.method === 'PUT') return a.rooms.includes(m[1]) ? json(200, { event_id: `$out${++sendN}` }) : json(403, { errcode: 'M_FORBIDDEN' });
      if (/^\/rooms\/[^/]+\/typing\//.test(v3)) return json(200, {});
      return json(404, { errcode: 'M_UNRECOGNIZED' });
    });
  });
}
const sends = token => calls.filter(c => c.method === 'PUT' && /\/send\/m\.room\.message\//.test(c.path) && c.token === token);
const text = (id, sender, body) => ({ type: 'm.room.message', event_id: id, sender, content: { msgtype: 'm.text', body } });

let inst, base, MX, db, alice, bob, carol, dave, s2, s3, g2, g3, shared3;
test.before(async () => {
  fake = fakeServer();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  fbase = `http://127.0.0.1:${fake.address().port}`;
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  MX = require('../src/bridge/matrix'); db = require('../src/db');
  MX._test.allowLocal(true);
});
test.after(async () => {
  await inst.close(); MX._test.allowLocal(false);
  for (const a of Object.values(ACCOUNTS)) a.waiters.splice(0).forEach(w => w({ next_batch: 'end' }));
  fake.closeAllConnections?.(); fake.close(); fs.rmSync(dir, { recursive: true, force: true });
});

const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); const a = api(base, r.body.session), post = a.post; a.post = (p, b) => { if (/\/messages$/.test(p)) require('../src/messages')._sendLimit.reset(); return post(p, b); }; return { ...r.body, a }; };
const MXR = sid => `/api/v1/bridge/servers/${sid}/matrix`;
const bodies = cid => db.all('SELECT m.body, m.author_name FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.cid = ? AND m.bridge = ? ORDER BY m.id', cid, 'matrix').map(r => `${r.author_name}: ${r.body}`);

test('setup: no bot for the homeserver, two servers with their own owners', async () => {
  alice = await reg('alice'); bob = await reg('bob'); carol = await reg('carol'); dave = await reg('dave');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  await alice.a.patch('/api/v1/instance/settings', { creation: { mode: 'anyone' } });
  let d = (await bob.a.post('/api/v1/servers', { name: 'Bobs', join_policy: 'open' })).body;
  s2 = d.server.sid; g2 = d.channels.find(c => c.type === 'text').cid;
  d = (await carol.a.post('/api/v1/servers', { name: 'Carols', join_policy: 'open' })).body;
  s3 = d.server.sid; g3 = d.channels.find(c => c.type === 'text').cid;
  shared3 = (await carol.a.post(`/api/v1/servers/${s3}/channels`, { name: 'shared', type: 'text' })).body.channel.cid;
  await dave.a.post(`/api/v1/servers/${s2}/join`);
  assert.deepEqual((await bob.a.get(MXR(s2))).body.matrix, { own: false, configured: false, token: null, homeserver: null, source: null, state: 'off', error: null, bot: null });
  assert.equal((await bob.a.put(`/api/v1/bridge/servers/${s2}`, { platform: 'matrix', guild_id: 'rooms' })).body.error, 'bridge_not_set_up');
});

test('each server brings its own Matrix account (Manage server); the token is checked and write-only', async () => {
  assert.equal((await dave.a.get(MXR(s2))).status, 403);
  assert.equal((await dave.a.patch(MXR(s2), { homeserver: fbase, token: T1 })).status, 403);
  assert.equal((await carol.a.patch(MXR(s2), { homeserver: fbase, token: T2 })).status, 403); // not her server
  assert.deepEqual((await bob.a.patch(MXR(s2), { homeserver: fbase, token: 'wrong' })).body, { error: 'invalid_token', platform: 'matrix' });
  assert.equal((await bob.a.patch(MXR(s2), { token: T1 })).body.error, 'invalid_homeserver');
  const one = await bob.a.patch(MXR(s2), { homeserver: fbase, token: T1 });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  const m = one.body.matrix;
  assert.deepEqual([m.own, m.configured, m.token, m.homeserver, m.source, m.bot], [true, true, '********AAAA', fbase, 'server', { id: '@bot1:fake.test', username: '@bot1:fake.test' }]);
  assert.ok(!JSON.stringify(one.body).includes(T1));
  assert.equal((await carol.a.patch(MXR(s3), { homeserver: fbase, token: T2 })).body.matrix.bot.id, '@bot2:fake.test');
  await until(async () => (await bob.a.get(MXR(s2))).body.matrix.state === 'ready' && (await carol.a.get(MXR(s3))).body.matrix.state === 'ready');
  assert.deepEqual(db.all('SELECT user_id FROM matrix_bots ORDER BY community_id').map(r => r.user_id), ['@bot1:fake.test', '@bot2:fake.test']);
  assert.equal(MX._test.bots.size >= 2 && MX._test.client(db.get('SELECT id FROM communities WHERE sid = ?', s2).id) !== MX._test.client(db.get('SELECT id FROM communities WHERE sid = ?', s3).id), true);
  // the homeserver itself still has none
  assert.equal((await alice.a.get('/api/v1/bridge/settings')).body.bridges.matrix.configured, false);
  const plat = async (who, sid) => (await who.a.get(`/api/v1/bridge/platforms?sid=${sid}`)).body.platforms.find(p => p.id === 'matrix');
  assert.deepEqual([(await plat(bob, s2)).bot, (await plat(bob, s2)).own, (await plat(carol, s3)).bot], ['@bot1:fake.test', true, '@bot2:fake.test']);
  assert.equal((await bob.a.get('/api/v1/bridge/platforms')).body.platforms.find(p => p.id === 'matrix').ready, false); // no server named: the homeserver's
});

test('each server sees and links its own bot\'s rooms', async () => {
  const a = await bob.a.put(`/api/v1/bridge/servers/${s2}`, { platform: 'matrix', guild_id: 'rooms' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b2 = a.body.bridges[0];
  assert.equal(b2.guild_name, '@bot1:fake.test');
  assert.deepEqual(b2.ext_channels.map(x => x.id), ['!a:fake.test', '!both:fake.test']);
  assert.deepEqual(b2.links.map(l => [l.cid, l.ext_channel_id]), [[g2, '!a:fake.test']]);
  const b3 = (await carol.a.put(`/api/v1/bridge/servers/${s3}`, { platform: 'matrix', guild_id: 'rooms' })).body.bridges[0];
  assert.equal(b3.guild_name, '@bot2:fake.test');
  assert.deepEqual(b3.ext_channels.map(x => x.id), ['!b:fake.test', '!both:fake.test']);
  assert.deepEqual(b3.links.map(l => [l.cid, l.ext_channel_id]).sort(), [[g3, '!b:fake.test'], [shared3, '!both:fake.test']].sort());
  // a room of the other bot is not this server's to link
  assert.equal((await bob.a.put(`/api/v1/bridge/servers/${s2}/channels/${g2}`, { platform: 'matrix', ext_channel_id: '!b:fake.test' })).body.error, 'channel_not_found');
});

test('messages come in through the right bot, once, and go out as the right bot', async () => {
  deliver(T1, '!a:fake.test', text('$a1', '@zed:other.test', 'hello bobs'));
  deliver(T2, '!b:fake.test', text('$b1', '@yan:other.test', 'hello carols'));
  await until(() => bodies(g2).length === 1 && bodies(g3).length === 1);
  assert.deepEqual([bodies(g2), bodies(g3)], [['zed: hello bobs'], ['yan: hello carols']]);
  // both bots sit in !both and both hear it: only the bot of the server it is linked to carries it
  const ev = text('$s1', '@zed:other.test', 'to the shared room');
  deliver(T1, '!both:fake.test', ev); deliver(T2, '!both:fake.test', ev);
  await until(() => bodies(shared3).length === 1);
  await sleep(150); await require('../src/bridge/bridge').idle();
  assert.deepEqual(bodies(shared3), ['zed: to the shared room']);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM messages WHERE bridge = 'matrix'").n, 3);
  // a bot's own events are not taken back in
  deliver(T2, '!b:fake.test', text('$b2', '@bot2:fake.test', 'carol: echo'));
  // out
  const n1 = sends(T1).length, n2 = sends(T2).length;
  assert.equal((await bob.a.post(`/api/v1/channels/${g2}/messages`, { message: 'from bobs' })).status, 200);
  assert.equal((await carol.a.post(`/api/v1/channels/${g3}/messages`, { message: 'from carols' })).status, 200);
  await until(() => sends(T1).length === n1 + 1 && sends(T2).length === n2 + 1);
  assert.deepEqual([sends(T1).at(-1).path.split('/')[2], sends(T1).at(-1).body.body], ['!a:fake.test', 'bob: from bobs']);
  assert.deepEqual([sends(T2).at(-1).path.split('/')[2], sends(T2).at(-1).body.body], ['!b:fake.test', 'carol: from carols']);
  await sleep(100);
  assert.equal(bodies(g3).length, 1);
  // each bot keeps its own place in the stream
  const rows = db.all('SELECT next_batch FROM matrix_bots ORDER BY community_id');
  assert.ok(rows.every(r => /^s\d+$/.test(r.next_batch)));
  assert.equal(require('../src/bridge/store').setting('matrix.since'), null);
});

test('a server that gives up its bot falls back to the homeserver\'s', async () => {
  const gone = await carol.a.patch(MXR(s3), { token: null });
  assert.deepEqual([gone.body.matrix.own, gone.body.matrix.configured], [false, false]);
  assert.equal(db.all('SELECT 1 FROM matrix_bots').length, 1);
  assert.equal((await carol.a.get(`/api/v1/bridge/servers/${s3}`)).body.bridges[0].problem, 'bridge_not_set_up');
  assert.equal((await bob.a.get(MXR(s2))).body.matrix.state, 'ready'); // Bob's is untouched
  // the homeserver gets a bot (the second account): Carol's server uses it, without seeing its token or address
  assert.equal((await alice.a.patch('/api/v1/bridge/settings', { matrix: { homeserver: fbase, token: T2 } })).status, 200);
  const v = (await carol.a.get(MXR(s3))).body.matrix;
  assert.deepEqual([v.own, v.configured, v.token, v.homeserver, v.source, v.bot.id], [false, true, null, null, 'homeserver', '@bot2:fake.test']);
  await until(async () => (await alice.a.get('/api/v1/bridge/settings')).body.bridges.matrix.state === 'ready');
  assert.equal((await carol.a.get(`/api/v1/bridge/servers/${s3}`)).body.bridges[0].problem, null);
  deliver(T2, '!b:fake.test', text('$b3', '@yan:other.test', 'through the homeserver bot'));
  await until(() => bodies(g3).length === 2);
  assert.equal(bodies(g2).length, 1);
  assert.equal((await bob.a.get(MXR(s2))).body.matrix.bot.id, '@bot1:fake.test');
});
