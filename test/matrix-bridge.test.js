'use strict';
// Matrix bridge (src/bridge/matrix.js, PROTOCOL §16.5) against a local fake homeserver (no real Matrix): the homeserver address
// and token are checked on save and the token is write-only, the bot joins rooms it is invited to, rooms are linked by name,
// messages go both ways as the person, edits / deletes / replies are mirrored, encrypted rooms can't be linked, no echo loop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
delete process.env.BONFIRE_MATRIX_TOKEN;
delete process.env.BONFIRE_MATRIX_HOMESERVER;
const dir = tmpDir();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const TOKEN = 'syt_good_matrix_token_WXYZ', BOT = '@emberbot:fake.test';
const ZW = String.fromCharCode(0x200b);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } }

// ---- the fake homeserver ----
const calls = [];                 // every request: { method, path, auth, body }
const ROOMS = {                   // room id -> state
  '!gen:fake.test': { name: 'General' }, '!rand:fake.test': { name: 'random stuff' }, '!secret:fake.test': { name: 'Secret', encrypted: true },
};
const joined = new Set(['!gen:fake.test', '!rand:fake.test', '!secret:fake.test']);
const MEMBERS = { '@zed:other.test': { displayname: 'Zeddy', avatar_url: 'mxc://other.test/zedpic' } };
let batch = 1, sendN = 0, fake, fbase, wellKnown = false;
const queue = [], waiters = [];
// the next /sync answers with these rooms
function push(rooms) { const w = waiters.shift(); const body = { next_batch: `s${++batch}`, rooms }; if (w) w(body); else queue.push(body); }
const timeline = (roomId, ...events) => push({ join: { [roomId]: { timeline: { events } } } });
function fakeServer() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const p = decodeURIComponent(u.pathname), auth = req.headers.authorization || null;
      const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch { /* not json */ }
      if (!p.endsWith('/sync')) calls.push({ method: req.method, path: p, auth, body: parsed });
      if (p === '/.well-known/matrix/client') return wellKnown ? json(200, { 'm.homeserver': { base_url: fbase + '/hs/' } }) : json(404, {});
      const c = p.replace(/^\/hs/, '');
      if (c.startsWith('/_matrix/client/v1/media/')) {
        if (auth !== `Bearer ${TOKEN}`) return json(401, { errcode: 'M_MISSING_TOKEN' });
        res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG);
      }
      if (auth !== `Bearer ${TOKEN}`) return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token' });
      const v3 = c.replace('/_matrix/client/v3', '');
      if (v3 === '/account/whoami') return json(200, { user_id: BOT, device_id: 'DEV' });
      if (v3 === '/joined_rooms') return json(200, { joined_rooms: [...joined] });
      if (v3 === '/sync') {
        if (!u.searchParams.get('since')) return json(200, { next_batch: `s${batch}`, rooms: { join: { '!gen:fake.test': { timeline: { events: [{ type: 'm.room.message', event_id: '$old', sender: '@zed:other.test', content: { msgtype: 'm.text', body: 'said before the bridge' } }] } } } } });
        if (queue.length) return json(200, queue.shift());
        const w = b => { clearTimeout(t); json(200, b); };
        const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); json(200, { next_batch: `s${batch}` }); }, 150);
        waiters.push(w);
        res.on('close', () => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); clearTimeout(t); } }); // (a bot that was restarted hung up)
        return undefined;
      }
      let m = /^\/rooms\/([^/]+)\/state\/([^/]+)\/(.*)$/.exec(v3);
      if (m) {
        const room = ROOMS[m[1]];
        if (!room || !joined.has(m[1])) return json(403, { errcode: 'M_FORBIDDEN' });
        if (m[2] === 'm.room.name') return room.name ? json(200, { name: room.name }) : json(404, { errcode: 'M_NOT_FOUND' });
        if (m[2] === 'm.room.encryption') return room.encrypted ? json(200, { algorithm: 'm.megolm.v1.aes-sha2' }) : json(404, { errcode: 'M_NOT_FOUND' });
        if (m[2] === 'm.room.member') return MEMBERS[m[3]] ? json(200, { membership: 'join', ...MEMBERS[m[3]] }) : json(404, { errcode: 'M_NOT_FOUND' });
        return json(404, { errcode: 'M_NOT_FOUND' });
      }
      m = /^\/rooms\/([^/]+)\/join$/.exec(v3);
      if (m && req.method === 'POST') { joined.add(m[1]); return json(200, { room_id: m[1] }); }
      m = /^\/rooms\/([^/]+)\/send\/m\.room\.message\/([^/]+)$/.exec(v3);
      if (m && req.method === 'PUT') return json(200, { event_id: `$out${++sendN}` });
      m = /^\/rooms\/([^/]+)\/typing\/([^/]+)$/.exec(v3);
      if (m && req.method === 'PUT') return json(200, {});
      m = /^\/rooms\/([^/]+)\/redact\/([^/]+)\/([^/]+)$/.exec(v3);
      if (m && req.method === 'PUT') return json(200, { event_id: `$red${++sendN}` });
      return json(404, { errcode: 'M_UNRECOGNIZED' });
    });
  });
}
const sends = () => calls.filter(c => c.method === 'PUT' && /\/send\/m\.room\.message\//.test(c.path));

let inst, base, MX, B;
const clients = [];
test.before(async () => {
  fake = fakeServer();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  fbase = `http://127.0.0.1:${fake.address().port}`;
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  MX = require('../src/bridge/matrix');
  B = require('../src/bridge/bridge');
});
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); MX._test.allowLocal(false); waiters.splice(0).forEach(w => w({ next_batch: 'end' })); fake.closeAllConnections?.(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); return { ...r.body, a: api(base, r.body.session) }; };
let alice, bob, sid, general, other, wa;
const say = (who, cid, message, extra = {}) => who.a.post(`/api/v1/channels/${cid}/messages`, { message, ...extra });
const history = async () => (await alice.a.get(`/api/v1/channels/${general}/messages`)).body.messages;
const mapped = (id, outbound) => require('../src/db').get('SELECT ext_message_id FROM bridge_msgs WHERE message_id = ? AND platform = ? AND outbound = ?', Number(id), 'matrix', outbound ? 1 : 0)?.ext_message_id;

test('setup', async () => {
  alice = await reg('alice'); bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Bridged', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid;
  other = (await alice.a.post(`/api/v1/servers/${sid}/channels`, { name: 'offtopic', type: 'text' })).body.channel.cid;
  await bob.a.post(`/api/v1/servers/${sid}/join`);
  wa = await wsClient(base).login(alice.session); clients.push(wa);
});

test('the homeserver address must be public and https', () => {
  assert.equal(MX.cleanHomeserver('matrix.org'), 'https://matrix.org');
  assert.equal(MX.cleanHomeserver(' https://matrix.example.org:8448/ '), 'https://matrix.example.org:8448');
  for (const bad of ['http://matrix.org', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.5:8448', 'https://[::1]', 'https://192.168.1.20', 'https://2130706433', 'https://hs.internal', 'https://user:pw@matrix.org', 'ftp://matrix.org', 'https://matrix.org/?x=1', '', 'not a host'])
    assert.throws(() => MX.cleanHomeserver(bad), e => e.code === 'invalid_homeserver', bad);
});

test('a name that resolves to a private address is never connected to', async () => {
  MX._test.setResolver((host, cb) => cb(null, [{ address: '10.1.2.3', family: 4 }]));
  await new Promise(done => MX.safeLookup('sneaky.example', { all: true }, e => { assert.equal(e?.code, 'EPRIVATE'); done(); }));
  MX._test.setResolver((host, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
  await new Promise(done => MX.safeLookup('fine.example', {}, (e, addr) => { assert.equal(e, null); assert.equal(addr, '93.184.216.34'); done(); }));
  MX._test.resetResolver();
});

test('settings: checked on save, the token is write-only and masked, the bot starts syncing', async () => {
  const S = '/api/v1/bridge/settings';
  assert.equal((await bob.a.get(S)).status, 403); // instance admins only
  assert.deepEqual((await alice.a.get(S)).body.bridges.matrix, { configured: false, token: null, homeserver: null, source: null, state: 'off', error: null, bot: null });
  // a homeserver on this machine is refused outside tests / development
  assert.equal((await alice.a.patch(S, { matrix: { homeserver: fbase, token: TOKEN } })).body.error, 'invalid_homeserver');
  MX._test.allowLocal(true);
  const bad = await alice.a.patch(S, { matrix: { homeserver: fbase, token: 'wrong' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: 'invalid_token', platform: 'matrix' });
  assert.equal((await alice.a.patch(S, { matrix: { token: TOKEN } })).body.error, 'invalid_homeserver'); // a token alone, with no homeserver yet
  const ok = await alice.a.patch(S, { matrix: { homeserver: fbase + '/', token: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const m = ok.body.bridges.matrix;
  assert.equal(m.configured, true);
  assert.equal(m.token, '********WXYZ');
  assert.equal(m.homeserver, fbase);
  assert.equal(m.source, 'settings');
  assert.deepEqual(m.bot, { id: BOT, username: BOT });
  assert.ok(!JSON.stringify(ok.body).includes(TOKEN));
  assert.equal((await api(base).get('/.well-known/bonfire')).body.features.bridges.matrix, true);
  await until(async () => (await alice.a.get(S)).body.bridges.matrix.state === 'ready');
  // an empty token keeps the stored one
  assert.equal((await alice.a.patch(S, { matrix: { token: '' } })).body.bridges.matrix.token, '********WXYZ');
});

test('a typed server name is looked up (/.well-known/matrix/client)', async () => {
  wellKnown = true;
  const r = await alice.a.patch('/api/v1/bridge/settings', { matrix: { homeserver: fbase } });
  assert.equal(r.body.bridges.matrix.homeserver, fbase + '/hs');
  wellKnown = false;
  assert.equal((await alice.a.patch('/api/v1/bridge/settings', { matrix: { homeserver: fbase } })).body.bridges.matrix.homeserver, fbase);
  await until(async () => (await alice.a.get('/api/v1/bridge/settings')).body.bridges.matrix.state === 'ready');
});

test('platforms + rooms: linking maps rooms to channels by name, encrypted rooms are marked and refused', async () => {
  const mx = (await alice.a.get('/api/v1/bridge/platforms')).body.platforms.find(p => p.id === 'matrix');
  assert.deepEqual(mx, { id: 'matrix', name: 'Matrix', ready: true, bot: BOT, invite: null, linked: true, rooms: true });
  assert.deepEqual((await alice.a.get('/api/v1/bridge/matrix/guilds')).body.guilds, [{ id: 'rooms', name: `Rooms ${BOT} is in`, icon: null }]);
  assert.equal((await bob.a.get('/api/v1/bridge/matrix/guilds')).status, 403); // Manage server
  const st = await alice.a.put(`/api/v1/bridge/servers/${sid}`, { platform: 'matrix', guild_id: 'rooms' });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  const b = st.body.bridges.find(x => x.platform === 'matrix');
  assert.equal(b.platform_name, 'Matrix');
  assert.equal(b.guild_name, BOT);
  assert.equal(b.problem, null);
  assert.deepEqual(b.links, [{ cid: general, ext_channel_id: '!gen:fake.test', ext_name: 'General', hook: false, kind: 'text' }]); // "general" == "General"
  assert.deepEqual(b.ext_channels, [
    { id: '!gen:fake.test', name: 'General', category: '', kind: 'text' },
    { id: '!rand:fake.test', name: 'random stuff', category: '', kind: 'text' },
    { id: '!secret:fake.test', name: 'Secret', category: '', kind: 'text', encrypted: true },
  ]);
  assert.equal((await alice.a.put(`/api/v1/bridge/servers/${sid}`, { platform: 'matrix', guild_id: 'rooms' })).body.error, 'already_bridged');
  const C = cid => `/api/v1/bridge/servers/${sid}/channels/${cid}`;
  assert.equal((await alice.a.put(C(other), { platform: 'matrix', ext_channel_id: '!secret:fake.test' })).body.error, 'room_encrypted');
  assert.equal((await alice.a.put(C(other), { platform: 'matrix', ext_channel_id: '!gen:fake.test' })).body.error, 'already_linked');
  assert.equal((await alice.a.put(C(other), { platform: 'matrix', ext_channel_id: '!nowhere:fake.test' })).body.error, 'channel_not_found');
  const ch = (await alice.a.get(`/api/v1/servers/${sid}`)).body.channels.find(c => c.cid === general);
  assert.deepEqual(ch.bridges, [{ platform: 'matrix', name: 'General' }]);
});

test('what was said before the bridge existed is not brought over', async () => {
  await B.idle();
  assert.ok(!(await history()).some(m => m.body === 'said before the bridge'));
});

test('the bot joins a room it is invited to, and the room can then be linked', async () => {
  ROOMS['!new:fake.test'] = { name: 'Off Topic' };
  push({ invite: { '!new:fake.test': { invite_state: { events: [] } } } });
  await until(() => calls.find(c => c.method === 'POST' && c.path === '/_matrix/client/v3/rooms/!new:fake.test/join'));
  const st = await until(async () => { const r = await alice.a.put(`/api/v1/bridge/servers/${sid}/channels/${other}`, { platform: 'matrix', ext_channel_id: '!new:fake.test' }); return r.status === 200 ? r : null; });
  assert.ok(st.body.bridges.find(x => x.platform === 'matrix').links.some(l => l.cid === other && l.ext_name === 'Off Topic'));
});

let inboundId;
test('Matrix -> here: posted as the person, picture + file re-hosted, nothing pings, not sent back', async () => {
  const before = sends().length;
  timeline('!gen:fake.test',
    { type: 'm.room.message', event_id: '$in1', sender: '@zed:other.test', content: { msgtype: 'm.text', body: 'hi @everyone and @room, <@&r0000000000>' } },
    { type: 'm.room.message', event_id: '$in2', sender: '@zed:other.test', content: { msgtype: 'm.image', body: 'cat.png', url: 'mxc://other.test/catpic', info: { size: PNG.length, mimetype: 'image/png' } } },
    { type: 'm.room.message', event_id: '$enc', sender: '@zed:other.test', content: { msgtype: 'm.image', body: 'locked.png', file: { url: 'mxc://other.test/enc' } } },
    { type: 'm.room.message', event_id: '$emote', sender: '@nopic:other.test', content: { msgtype: 'm.emote', body: 'waves' } },
  );
  const m = await wa.waitFor(f => f.type === 'chat_message' && f.message.channel === general && f.message.author?.bridge === 'matrix');
  inboundId = m.message.id;
  assert.equal(m.message.author.username, 'Zeddy');
  assert.equal(m.message.author.webhook, true);
  assert.match(m.message.author.pfp, /\/uploads\/bridge\/avatars\/matrix_[0-9a-f]{24}\.png$/);
  assert.equal(m.message.body, `hi @${ZW}everyone and @${ZW}room, <${ZW}@&r0000000000>`);
  assert.equal(m.message.mention_everyone, null);
  const pic = await wa.waitFor(f => f.type === 'chat_message' && f.message.attachments?.length === 1 && f.message.author?.bridge === 'matrix');
  assert.match(pic.message.attachments[0].url, /\/uploads\/\d{4}\/\d{2}\/[0-9a-f]+\.png$/);
  assert.equal(pic.message.attachments[0].type, 'image');
  assert.equal((await fetch(pic.message.attachments[0].url.replace(/^https?:\/\/[^/]+/, base))).status, 200);
  // an encrypted file can't be read: its name stands in for it. Someone with no display name shows as the start of their id
  const locked = await wa.waitFor(f => f.type === 'chat_message' && f.message.body === '[locked.png]');
  assert.equal(locked.message.attachments.length, 0);
  const emote = await wa.waitFor(f => f.type === 'chat_message' && f.message.body === '*waves*');
  assert.equal(emote.message.author.username, 'nopic');
  assert.equal(emote.message.author.pfp, null);
  // the media was fetched with the bot's token (authenticated media)
  assert.ok(calls.some(c => c.path === '/_matrix/client/v1/media/download/other.test/catpic' && c.auth === `Bearer ${TOKEN}`));
  await B.idle(); await sleep(50);
  assert.equal(sends().length, before); // a Matrix message is never sent back to Matrix
  // a room that isn't linked, and the same event read twice, are ignored
  timeline('!rand:fake.test', { type: 'm.room.message', event_id: '$x1', sender: '@zed:other.test', content: { msgtype: 'm.text', body: 'elsewhere' } });
  timeline('!gen:fake.test', { type: 'm.room.message', event_id: '$in1', sender: '@zed:other.test', content: { msgtype: 'm.text', body: 'hi again' } });
  await sleep(250); await B.idle();
  const hist = await history();
  assert.ok(!hist.some(x => x.body === 'elsewhere' || x.body === 'hi again'));
});

let outId, outExt;
test('here -> Matrix: the bot says who wrote it; its own events never come back', async () => {
  const r = await say(alice, general, 'hello <@&r0000000000> matrix\nsecond <b>line</b>');
  outId = r.body.message.id;
  const call = await until(() => sends().find(c => c.body?.body?.includes('matrix')));
  assert.equal(call.auth, `Bearer ${TOKEN}`);
  assert.match(call.path, /^\/_matrix\/client\/v3\/rooms\/!gen:fake\.test\/send\/m\.room\.message\/ember\d+_\d+$/);
  assert.equal(call.body.msgtype, 'm.text');
  assert.equal(call.body.body, 'alice: hello @role matrix\nsecond <b>line</b>');
  assert.equal(call.body.format, 'org.matrix.custom.html');
  assert.equal(call.body.formatted_body, '<strong>alice</strong>: hello @role matrix<br>second &lt;b&gt;line&lt;/b&gt;'); // typed html is text, never markup
  await B.idle();
  outExt = mapped(outId, true);
  assert.match(outExt, /^\$out\d+$/);
  // the homeserver hands our own event back in /sync: it must not be posted here again
  timeline('!gen:fake.test', { type: 'm.room.message', event_id: outExt, sender: BOT, content: call.body }, { type: 'm.room.message', event_id: '$mine2', sender: BOT, content: { msgtype: 'm.text', body: 'another bot line' } });
  await sleep(250); await B.idle();
  assert.ok(!(await history()).some(x => x.body === 'another bot line' || (x.author?.bridge && x.body.startsWith('alice:'))));
  // a file here goes over as its link
  const up = await say(alice, general, '', { attachments: [{ url: `${base}/uploads/2026/01/abc.png`, type: 'image', name: 'abc.png' }] }).catch(() => null);
  if (up?.status === 200) assert.ok((await until(() => sends().find(c => c.body?.body?.includes('/uploads/2026/01/abc.png')))).body.body.startsWith('alice: '));
});

test('replies are real replies both ways, or a quoted line when the message is not on the other side', async () => {
  // there -> here, to a message that is here
  timeline('!gen:fake.test', { type: 'm.room.message', event_id: '$rep1', sender: '@zed:other.test', content: { msgtype: 'm.text', body: '> <@emberbot:fake.test> alice: hello\n\nreplying to alice', 'm.relates_to': { 'm.in_reply_to': { event_id: outExt } } } });
  const r1 = await wa.waitFor(f => f.type === 'chat_message' && f.message.body === 'replying to alice');
  assert.equal(String(r1.message.reply?.id), String(outId));
  // there -> here, to something from before the bridge: one quoted line
  timeline('!gen:fake.test', { type: 'm.room.message', event_id: '$rep2', sender: '@zed:other.test', content: { msgtype: 'm.text', body: '> <@yan:other.test> an older message\n> its second line\n\nand my answer', 'm.relates_to': { 'm.in_reply_to': { event_id: '$unknown' } } } });
  const r2 = await wa.waitFor(f => f.type === 'chat_message' && f.message.body.endsWith('and my answer'));
  assert.equal(r2.message.body, '> **yan** an older message\nand my answer');
  assert.equal(r2.message.reply, null);
  // here -> there, to a message that came from there
  await B.idle();
  await say(bob, general, 'answering zed', { reply_to: inboundId });
  const out = await until(() => sends().find(c => c.body?.body === 'bob: answering zed'));
  assert.deepEqual(out.body['m.relates_to'], { 'm.in_reply_to': { event_id: '$in1' } });
});

test('edits and deletes are mirrored both ways', async () => {
  // here -> there
  await alice.a.patch(`/api/v1/messages/${outId}`, { message: 'hello edited' });
  const pe = await until(() => sends().find(c => c.body?.['m.relates_to']?.rel_type === 'm.replace'));
  assert.equal(pe.body['m.relates_to'].event_id, outExt);
  assert.equal(pe.body['m.new_content'].body, 'alice: hello edited');
  assert.equal(pe.body.body, '* alice: hello edited');
  await alice.a.del(`/api/v1/messages/${outId}`);
  await until(() => calls.find(c => c.method === 'PUT' && c.path.startsWith(`/_matrix/client/v3/rooms/!gen:fake.test/redact/${outExt}/`)));
  // there -> here
  timeline('!gen:fake.test', { type: 'm.room.message', event_id: '$edit1', sender: '@zed:other.test', content: { msgtype: 'm.text', body: '* hi (edited)', 'm.new_content': { msgtype: 'm.text', body: 'hi (edited)' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$in1' } } });
  const up = await wa.waitFor(f => f.type === 'chat_message_update' && f.message.id === inboundId);
  assert.equal(up.message.body, 'hi (edited)');
  assert.ok(up.message.edited_at);
  timeline('!gen:fake.test', { type: 'm.room.redaction', event_id: '$red1', sender: '@zed:other.test', redacts: '$in1', content: {} });
  await wa.waitFor(f => f.type === 'chat_message_delete' && f.id === inboundId);
  // newer rooms put the redacted id in the content
  timeline('!gen:fake.test', { type: 'm.room.message', event_id: '$in9', sender: '@zed:other.test', content: { msgtype: 'm.text', body: 'delete me' } });
  const m9 = await wa.waitFor(f => f.type === 'chat_message' && f.message.body === 'delete me');
  timeline('!gen:fake.test', { type: 'm.room.redaction', event_id: '$red2', sender: '@zed:other.test', content: { redacts: '$in9' } });
  await wa.waitFor(f => f.type === 'chat_message_delete' && f.id === m9.message.id);
  // a moderator deleting a Matrix person's message here redacts it there with the bot
  timeline('!gen:fake.test', { type: 'm.room.message', event_id: '$in10', sender: '@zed:other.test', content: { msgtype: 'm.text', body: 'moderate me' } });
  const m10 = await wa.waitFor(f => f.type === 'chat_message' && f.message.body === 'moderate me');
  await B.idle();
  await alice.a.del(`/api/v1/messages/${m10.message.id}`);
  await until(() => calls.find(c => c.method === 'PUT' && c.path.startsWith('/_matrix/client/v3/rooms/!gen:fake.test/redact/$in10/')));
});

test('typing goes both ways: Matrix people show here with name and picture, the bot types in the room', async () => {
  const typed = x => x.type === 'chat_typing' && x.bridged;
  const typingNow = ids => push({ join: { '!gen:fake.test': { ephemeral: { events: [{ type: 'm.typing', content: { user_ids: ids } }] } } } });
  typingNow(['@zed:other.test', BOT]);
  const f = await wa.waitFor(x => typed(x) && x.typing === true);
  assert.deepEqual([f.bridged.platform, f.bridged.name, f.username, f.channel, f.user_id], ['matrix', 'Zeddy', 'Zeddy', general, null]);
  assert.match(f.bridged.avatar, /\/uploads\/bridge\/avatars\/matrix_[0-9a-f]{24}\.png$/);
  typingNow([BOT]); // zed stopped
  await wa.waitFor(x => typed(x) && x.bridged.name === 'Zeddy' && x.typing === false);
  assert.equal(wa.frames.filter(typed).length, 2); // the bot's own typing is never shown here
  // here -> Matrix: the bot types in the room, and stops when the message lands
  const puts = () => calls.filter(c => c.method === 'PUT' && c.path.endsWith(`/rooms/!gen:fake.test/typing/${BOT}`));
  const wb = await wsClient(base).login(bob.session); clients.push(wb);
  wb.send({ type: 'chat_typing', channel: general });
  assert.deepEqual((await until(() => puts()[0])).body, { typing: true, timeout: 8000 });
  await say(bob, general, 'typed and sent');
  assert.deepEqual((await until(() => puts()[1])).body, { typing: false });
});

test('pause, unlink a channel, unlink the bridge (Manage server)', async () => {
  const BR = `/api/v1/bridge/servers/${sid}`;
  assert.equal((await bob.a.patch(BR, { platform: 'matrix', enabled: false })).status, 403);
  assert.equal((await alice.a.patch(BR, { platform: 'matrix', enabled: false })).body.bridges.find(x => x.platform === 'matrix').enabled, false);
  const before = sends().length;
  await say(alice, general, 'while paused');
  timeline('!gen:fake.test', { type: 'm.room.message', event_id: '$paused', sender: '@zed:other.test', content: { msgtype: 'm.text', body: 'paused inbound' } });
  await sleep(250); await B.idle();
  assert.equal(sends().length, before);
  assert.ok(!(await history()).some(x => x.body === 'paused inbound'));
  await alice.a.patch(BR, { platform: 'matrix', enabled: true });
  const un = await alice.a.put(`${BR}/channels/${other}`, { platform: 'matrix', ext_channel_id: null });
  assert.ok(!un.body.bridges.find(x => x.platform === 'matrix').links.some(l => l.cid === other));
  const gone = await alice.a.del(`${BR}?platform=matrix`);
  assert.equal(gone.body.bridges.find(x => x.platform === 'matrix'), undefined);
  assert.deepEqual((await alice.a.get(`/api/v1/servers/${sid}`)).body.channels.find(c => c.cid === general).bridges || [], []);
});

test('a token the homeserver no longer accepts stops the bridge; removing it switches the bridge off', async () => {
  require('../src/bridge/store').setSetting('matrix.token', 'revoked');
  MX.init();
  const st = await until(async () => { const m = (await alice.a.get('/api/v1/bridge/settings')).body.bridges.matrix; return m.state === 'error' ? m : null; });
  assert.equal(st.error, 'invalid_token');
  const off = (await alice.a.patch('/api/v1/bridge/settings', { matrix: { token: null } })).body.bridges.matrix;
  assert.deepEqual(off, { configured: false, token: null, homeserver: null, source: null, state: 'off', error: null, bot: null });
  assert.equal((await api(base).get('/.well-known/bonfire')).body.features.bridges.matrix, false);
});

test('the quoted lines of a Matrix reply are told apart from the answer', () => {
  assert.deepEqual(MX.splitReply('> <@alice:example.org> first\n> second\n\nanswer\nmore'), { quote: { who: 'alice', text: 'first' }, rest: 'answer\nmore' });
  assert.deepEqual(MX.splitReply('> * <@alice:example.org> waves\n\nok'), { quote: { who: 'alice', text: 'waves' }, rest: 'ok' });
  assert.deepEqual(MX.splitReply('no quote here'), { quote: null, rest: 'no quote here' });
  assert.equal(MX.textIn({ body: '> <@a:b> q\n\nreal text' }, 'real'), 'real text');
});
