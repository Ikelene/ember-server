'use strict';
// Server stickers: upload / list / limit / rename / delete, sending one, and the deleted marker in history.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');
const db = require('../src/db');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base, alice, bob, sid, general, wsB;
const clients = [];
const S = p => `/api/v1/servers/${sid}${p}`;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
// a real 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const form = (buf, name, fields = {}) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('file', new Blob([buf]), name); return f; };
const upload = (who, id, buf, name, fields) => who.a.raw('POST', `/api/v1/servers/${id}/stickers`, form(buf, name, fields));

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup: alice owns the server, bob is a plain member of the first', async () => {
  alice = await reg('alice'); bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid;
  await bob.a.post(S('/join'));
  wsB = await wsClient(base).login(bob.session); clients.push(wsB);
});

test('upload needs Manage server and a small PNG / GIF / WebP', async () => {
  assert.equal((await upload(bob, sid, PNG, 'wave.png', { name: 'wave' })).status, 403);
  const up = await upload(alice, sid, PNG, 'wave.png', { name: 'wave' });
  assert.equal(up.status, 200);
  const st = up.body.sticker;
  assert.match(st.tid, /^t[0-9a-f]{10}$/);
  assert.equal(st.name, 'wave'); assert.equal(st.animated, false);
  assert.match(st.url, /\/uploads\/stickers\/t[0-9a-f]{10}\.png$/);
  const got = await api(base).get(new URL(st.url).pathname);
  assert.equal(got.status, 200);
  assert.ok(Buffer.compare(got.body, PNG) === 0);
  const frame = await wsB.waitFor(f => f.type === 'chat_stickers_update' && f.server === sid);
  assert.equal(frame.stickers[0].tid, st.tid);

  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  assert.equal((await upload(alice, sid, jpg, 'x.jpg', { name: 'x' })).body.error, 'images_only');
  const big = await upload(alice, sid, Buffer.concat([PNG, Buffer.alloc(600 * 1024)]), 'big.png', { name: 'big' });
  assert.equal(big.status, 413); assert.equal(big.body.error, 'file_too_large');
  const apng = await upload(alice, sid, Buffer.concat([PNG, Buffer.from('acTL')]), 'a.png', { name: 'moving' });
  assert.equal(apng.body.sticker.animated, true);
  await alice.a.del(S(`/stickers/${apng.body.sticker.tid}`));
});

test('list: members see them, GET /stickers groups by server', async () => {
  const l = await bob.a.get(S('/stickers'));
  assert.equal(l.body.max, 30);
  assert.deepEqual(l.body.stickers.map(s => s.name), ['wave']);
  const all = (await bob.a.get('/api/v1/stickers')).body;
  assert.equal(all.servers.length, 1);
  assert.equal(all.servers[0].sid, sid);
  assert.equal(all.servers[0].stickers[0].name, 'wave');
});

test('rename needs a name and Manage server', async () => {
  const tid = (await bob.a.get(S('/stickers'))).body.stickers[0].tid;
  assert.equal((await bob.a.patch(S(`/stickers/${tid}`), { name: 'nope' })).status, 403);
  assert.equal((await alice.a.patch(S(`/stickers/${tid}`), { name: '  ' })).body.error, 'name_required');
  assert.equal((await alice.a.patch(S(`/stickers/${tid}`), { name: 'big wave!' })).status, 200);
  assert.equal((await bob.a.get(S('/stickers'))).body.stickers[0].name, 'big_wave');
});

test('sending a sticker, with and without text; foreign and unknown ones are refused', async () => {
  const tid = (await bob.a.get(S('/stickers'))).body.stickers[0].tid;
  const m = await bob.a.post(`/api/v1/channels/${general}/messages`, { message: '', sticker: tid });
  assert.equal(m.status, 200);
  assert.equal(m.body.message.body, '');
  assert.deepEqual(Object.keys(m.body.message.sticker).sort(), ['animated', 'name', 'tid', 'url']);
  assert.equal(m.body.message.sticker.tid, tid);
  const plain = await bob.a.post(`/api/v1/channels/${general}/messages`, { message: 'hi' });
  assert.equal(plain.body.message.sticker, undefined);
  assert.equal((await bob.a.post(`/api/v1/channels/${general}/messages`, { message: '' })).body.error, 'empty_message');
  assert.equal((await bob.a.post(`/api/v1/channels/${general}/messages`, { message: 'x', sticker: 'tdeadbeef00' })).body.error, 'unknown_sticker');

  // a sticker of another server cannot be used here
  const owner = db.get('SELECT owner_id FROM communities LIMIT 1').owner_id;
  const foreign = Number(db.run("INSERT INTO communities (sid, name, invite_code, owner_id, created_at) VALUES ('sforeign', 'Foreign', 'foreigncode', ?, ?)", owner, Date.now()).lastInsertRowid);
  db.run('INSERT INTO stickers (tid, community_id, name, file, created_at) VALUES (?, ?, ?, ?, ?)', 'tffffffffff', foreign, 'other', 'stickers/none.png', Date.now());
  const other = { tid: 'tffffffffff' };
  const r = await alice.a.post(`/api/v1/channels/${general}/messages`, { message: '', sticker: other.tid });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'unknown_sticker');

  // over the gateway too
  const wsA = await wsClient(base).login(alice.session); clients.push(wsA);
  wsA.send({ type: 'chat_send', nonce: 'n1', channel: general, message: '', sticker: tid });
  const ack = await wsA.waitFor(f => f.type === 'chat_ack' && f.nonce === 'n1');
  assert.equal(ack.message.sticker.tid, tid);
  wsA.send({ type: 'chat_send', nonce: 'n2', channel: general, message: '', sticker: other.tid });
  assert.equal((await wsA.waitFor(f => f.type === 'chat_error' && f.nonce === 'n2')).error, 'unknown_sticker');
});

test('the limit is 30 per server', async () => {
  const have = (await alice.a.get(S('/stickers'))).body.stickers.length;
  for (let i = have; i < 30; i++) assert.equal((await upload(alice, sid, PNG, `s${i}.png`, { name: `s${i}` })).status, 200);
  const over = await upload(alice, sid, PNG, 'more.png', { name: 'more' });
  assert.equal(over.status, 400); assert.equal(over.body.error, 'too_many_stickers');
});

test('a deleted sticker stays in history as deleted:true', async () => {
  const st = (await alice.a.get(S('/stickers'))).body.stickers.find(s => s.name === 'big_wave');
  assert.equal((await bob.a.del(S(`/stickers/${st.tid}`))).status, 403);
  assert.equal((await alice.a.del(S(`/stickers/${st.tid}`))).status, 200);
  assert.equal((await alice.a.del(S(`/stickers/${st.tid}`))).status, 404);
  assert.equal((await api(base).get(new URL(st.url).pathname)).status, 404);
  const hist = (await bob.a.get(`/api/v1/channels/${general}/messages`)).body.messages;
  const withSticker = hist.filter(m => m.sticker);
  assert.ok(withSticker.length >= 2);
  for (const m of withSticker) assert.deepEqual(m.sticker, { tid: st.tid, name: null, url: null, animated: false, deleted: true });
  assert.equal(hist.find(m => m.body === 'hi').sticker, undefined);
  assert.equal((await alice.a.post(`/api/v1/channels/${general}/messages`, { message: '', sticker: st.tid })).body.error, 'unknown_sticker');
});
