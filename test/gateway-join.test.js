'use strict';
// Joining a server while a socket of the account has not finished chat_hello: that socket hears the server's live events too
// once its hello is done, like the sockets that were ready (gateway.js subscribe / chat_hello).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const { startServer } = require('../src/index');

const dir = tmpDir();
let inst, base;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a join while one socket is still before its chat_hello: both sockets get the live events', async () => {
  const alice = await reg('alice'), bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current(), accept_operator_terms: true });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Race', join_policy: 'open' })).body;
  const sid = d.server.sid, general = d.channels.find(c => c.type === 'text').cid;
  const ready = await wsClient(base).login(bob.session); // hello done
  const early = wsClient(base); // signed in, no hello yet
  await early.open(); early.send({ type: 'auth', session: bob.session }); await early.waitFor(f => f.type === 'auth_success');
  assert.equal((await bob.a.post(`/api/v1/servers/${sid}/join`)).status, 200);
  early.send({ type: 'chat_hello' }); await early.waitFor(f => f.type === 'chat_ready');
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'live?' });
  for (const s of [ready, early]) assert.ok(await s.waitFor(f => f.type === 'chat_message' && f.message?.body === 'live?'));
  // leaving before the hello: not subscribed after it
  const late = wsClient(base);
  await late.open(); late.send({ type: 'auth', session: bob.session }); await late.waitFor(f => f.type === 'auth_success');
  assert.equal((await bob.a.post(`/api/v1/servers/${sid}/leave`)).status, 200);
  late.send({ type: 'chat_hello' }); await late.waitFor(f => f.type === 'chat_ready');
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'gone' });
  await new Promise(r => setTimeout(r, 200));
  assert.ok(!late.frames.some(f => f.type === 'chat_message'));
  for (const s of [ready, early, late]) s.close();
});
