'use strict';
// Clone origins (clonelock.js): a copy remembers where its bytes were first seen. Asked from the server it was copied from
// (`from`), it shows on the emoji / sticker views, emoji info and messages' stickers, and /clone-check passes it on so a
// copy of a copy keeps the first one. New pictures have no origin.
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
let inst, base, alice, sid, general, peer, peerUrl;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const THEIRS = Buffer.concat([PNG, Buffer.from('first seen on the peer')]);
const NAT = Buffer.concat([PNG, Buffer.from("nat's personal one")]);
const MINE = Buffer.concat([PNG, Buffer.from('brand new')]);
const form = (buf, name, fields = {}) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('file', new Blob([buf]), name); return f; };
const up = (kind, buf, name, fields = {}) => alice.a.raw('POST', `/api/v1/servers/${sid}/${kind}`, form(buf, `${name}.png`, { name, ...fields }));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url;
  // another Ember server: THEIRS was first seen on its server "Fox Den"; NAT is a copy it got from Nat's personal emojis
  peer = http.createServer((req, res) => {
    const h = new URL(req.url, 'http://x').searchParams.get('sha256');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(h === sha(THEIRS) ? { locked: false, origin: { type: 'server', name: 'Fox Den', host: 'fox.example' } }
      : h === sha(NAT) ? { locked: false, origin: { type: 'user', user_id: '42', username: 'nat', extra: 'dropped' } } : { locked: false }));
  });
  await new Promise(r => peer.listen(0, '127.0.0.1', r));
  peerUrl = `http://127.0.0.1:${peer.address().port}`;
});
test.after(async () => { peer.close(); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup', async () => {
  alice = await reg('alice');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid;
});

test('a new picture has no origin', async () => {
  const r = await up('stickers', MINE, 'mine');
  assert.equal(r.status, 200);
  assert.equal(r.body.sticker.origin, undefined);
  // and /clone-check names this server as where those bytes were first seen
  assert.deepEqual((await api(base).get(`/api/v1/clone-check?sha256=${sha(MINE)}`)).body.origin, { type: 'server', name: 'Camp', host: new URL(base).host.replace('127.0.0.1', 'localhost') });
});

test('a copy from another Ember server keeps where it was first seen', async () => {
  const s = await up('stickers', THEIRS, 'theirs', { from: `${peerUrl}/uploads/stickers/t1.png` });
  assert.deepEqual(s.body.sticker.origin, { type: 'server', name: 'Fox Den', host: 'fox.example' });
  const e = await up('emojis', NAT, 'nat', { from: `${peerUrl}/uploads/emojis/e1.png` });
  assert.deepEqual(e.body.emoji.origin, { type: 'user', user_id: '42', username: 'nat' }); // (unknown keys dropped)

  // it shows everywhere the sticker / emoji does
  assert.deepEqual((await alice.a.get(`/api/v1/servers/${sid}/stickers`)).body.stickers.find(x => x.name === 'theirs').origin.name, 'Fox Den');
  assert.deepEqual((await alice.a.get(`/api/v1/emojis/${e.body.emoji.eid}/info`)).body.origin, { type: 'user', user_id: '42', username: 'nat' });
  const m = await alice.a.post(`/api/v1/channels/${general}/messages`, { message: '', sticker: s.body.sticker.tid });
  assert.equal(m.body.message.sticker.origin.name, 'Fox Den');

  // a copy of the copy: /clone-check passes on the first origin, not this server
  assert.deepEqual((await api(base).get(`/api/v1/clone-check?sha256=${sha(THEIRS)}`)).body.origin, { type: 'server', name: 'Fox Den', host: 'fox.example' });
});

test('a copy whose source has nothing to say has no origin', async () => {
  const r = await up('emojis', Buffer.concat([PNG, Buffer.from('unknown')]), 'x', { from: `${peerUrl}/uploads/emojis/e9.png` });
  assert.equal(r.status, 200);
  assert.equal(r.body.emoji.origin, undefined);
});
