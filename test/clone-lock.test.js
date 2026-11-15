'use strict';
// Clone locks (clonelock.js): "Allow cloning server emojis & stickers" (on by default). With it off this instance answers
// /clone-check "locked" for its pictures (other Ember servers and Nookara ask), says so in its view + emoji lists, and an upload
// that names another Ember server as `from` asks that server first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base, alice, bob, sid, peer, peerUrl;
const asked = [];
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const OTHER = Buffer.concat([PNG, Buffer.from('other bytes')]);
const LOCKED_THERE = Buffer.concat([PNG, Buffer.from('locked on the peer')]);
const form = (buf, name, fields = {}) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('file', new Blob([buf]), name); return f; };
const up = (who, kind, buf, name, fields = {}) => who.a.raw('POST', `/api/v1/servers/${sid}/${kind}`, form(buf, `${name}.png`, { name, ...fields }));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const check = q => api(base).get(`/api/v1/clone-check?${q}`);

test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url;
  // another Ember server: says LOCKED_THERE is locked
  peer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    asked.push(u.pathname + '?' + u.searchParams.toString());
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ locked: u.pathname === '/api/v1/clone-check' && u.searchParams.get('sha256') === sha(LOCKED_THERE) }));
  });
  await new Promise(r => peer.listen(0, '127.0.0.1', r));
  peerUrl = `http://127.0.0.1:${peer.address().port}`;
});
test.after(async () => { peer.close(); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup: alice owns Camp (a sticker + an emoji), bob is a member', async () => {
  alice = await reg('alice'); bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  sid = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body.server.sid;
  await bob.a.post(`/api/v1/servers/${sid}/join`);
  assert.equal((await up(alice, 'stickers', PNG, 'wave')).status, 200);
  assert.equal((await up(alice, 'emojis', PNG, 'wave')).status, 200);
});

test('cloning is on by default and every view says so', async () => {
  assert.equal((await bob.a.get(`/api/v1/servers/${sid}`)).body.server.allow_cloning, true);
  assert.equal((await bob.a.get('/api/v1/stickers')).body.servers[0].allow_cloning, true);
  assert.equal((await bob.a.get('/api/v1/emojis')).body.servers[0].allow_cloning, true);
  assert.equal((await alice.a.get(`/api/v1/servers/${sid}/settings`)).body.settings.emojis.allow_cloning, true);
  assert.equal((await check(`sha256=${sha(PNG)}`)).body.locked, false);
});

test('turning it off needs Manage server; then /clone-check says locked for its pictures only', async () => {
  assert.equal((await bob.a.patch(`/api/v1/servers/${sid}/settings`, { emojis: { allow_cloning: false } })).status, 403);
  assert.equal((await alice.a.patch(`/api/v1/servers/${sid}/settings`, { emojis: { allow_cloning: 'no' } })).body.error, 'invalid_allow_cloning');
  assert.equal((await alice.a.patch(`/api/v1/servers/${sid}/settings`, { emojis: { allow_cloning: false } })).status, 200);
  assert.equal((await bob.a.get(`/api/v1/servers/${sid}`)).body.server.allow_cloning, false);
  assert.equal((await bob.a.get('/api/v1/emojis')).body.servers[0].allow_cloning, false);
  assert.equal((await bob.a.get('/api/v1/stickers')).body.servers[0].allow_cloning, false);
  assert.equal((await check(`sha256=${sha(PNG)}`)).body.reason, 'cloning_disabled');
  assert.equal((await check(`sha256=${sha(OTHER)}`)).body.locked, false);
  assert.equal((await check('sha256=nope')).body.error, 'invalid_sha256');
});

test("its owner is not locked out (asked with her Nookara id), and copies inside the server itself are fine", async () => {
  const db = require('../src/db');
  db.run("UPDATE users SET velora_id = '777' WHERE username = 'alice'");
  db.run("UPDATE users SET velora_id = '888' WHERE username = 'bob'");
  assert.equal((await check(`sha256=${sha(PNG)}&velora_id=777`)).body.locked, false);
  assert.equal((await check(`sha256=${sha(PNG)}&velora_id=888`)).body.reason, 'cloning_disabled');
  assert.equal((await up(alice, 'stickers', PNG, 'again')).status, 200);
  const tid = (await alice.a.get(`/api/v1/servers/${sid}/stickers`)).body.stickers[0].tid;
  assert.equal((await alice.a.patch(`/api/v1/servers/${sid}/stickers/${tid}`, { name: 'hello' })).status, 200);
});

test('an upload copied `from` another Ember server asks that server, and is refused when it says locked', async () => {
  const r = await up(alice, 'stickers', LOCKED_THERE, 'theirs', { from: `${peerUrl}/uploads/stickers/tabc.png` });
  assert.equal(r.status, 403); assert.equal(r.body.error, 'cloning_disabled');
  assert.match(asked.at(-1), /^\/api\/v1\/clone-check\?sha256=[0-9a-f]{64}&velora_id=777$/); // (alice's Nookara id, so its owner isn't locked out)
  const e = await up(alice, 'emojis', LOCKED_THERE, 'theirs', { from: `${peerUrl}/uploads/emojis/eabc.png` });
  assert.equal(e.body.error, 'cloning_disabled');
  assert.equal((await up(alice, 'stickers', OTHER, 'fine', { from: `${peerUrl}/uploads/stickers/tdef.png` })).status, 200);
  // a peer that is down or not https never blocks an upload
  assert.equal((await up(alice, 'emojis', OTHER, 'fine2', { from: 'http://example.invalid/x.png' })).status, 200);
});

test('deleting them unlocks the bytes; on again = not locked', async () => {
  for (const st of (await alice.a.get(`/api/v1/servers/${sid}/stickers`)).body.stickers) await alice.a.del(`/api/v1/servers/${sid}/stickers/${st.tid}`);
  for (const e of (await alice.a.get(`/api/v1/servers/${sid}/emojis`)).body.emojis) await alice.a.del(`/api/v1/servers/${sid}/emojis/${e.eid}`);
  assert.equal((await check(`sha256=${sha(PNG)}`)).body.locked, false);
  await up(alice, 'stickers', PNG, 'back');
  assert.equal((await check(`sha256=${sha(PNG)}`)).body.locked, true);
  await alice.a.patch(`/api/v1/servers/${sid}/settings`, { emojis: { allow_cloning: true } });
  assert.equal((await check(`sha256=${sha(PNG)}`)).body.locked, false);
});
