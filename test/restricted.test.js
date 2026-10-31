'use strict';
// Velora switched Ember off for an account (profiles `restricted`): refused over REST and the gateway, also while already signed in / connected; back on = works again.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api, wsClient, fakeIdp } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_VELORA_URL = 'http://velora.test/';
process.env.BONFIRE_PUBLIC_URL = 'https://chat.test';
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const profiles = require('../src/profiles');

const idp = fakeIdp();
const dir = tmpDir();
let inst;
const off = new Set(); // velora ids Velora reports as restricted
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (!u.startsWith('http://velora.test/bonfire/profiles')) return realFetch(url, opts);
  const ids = new URL(u).searchParams.get('ids').split(',');
  return { ok: true, json: async () => ({ profiles: ids.map(id => ({ id, username: 'u' + id, display_name: 'u' + id, pfp: null, restricted: off.has(id) })) }) };
};
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); auth.setJwksFetcher(idp.jwks); });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// the 30 s re-check, without waiting
const expire = () => profiles.refresh(['701', '702', '703'], { force: true, always: true });

test('REST: refused once restricted (even with a live session), allowed again when switched back on', async () => {
  const r = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '701', username: 'ann', scp: ['chat'] }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = api(inst.url, r.body.session);
  assert.equal((await a.get('/api/v1/me')).status, 200);
  off.add('701'); await expire();
  const denied = await a.get('/api/v1/me');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'account_restricted');
  assert.match(denied.body.message, /switched off/);
  off.delete('701'); await expire();
  assert.equal((await a.get('/api/v1/me')).status, 200);
});

test('gateway: a connected socket is cut off and told, frames are refused, then it works again', async () => {
  const r = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '702', username: 'bob', scp: ['chat'] }) });
  const ws = await wsClient(inst.url).login(r.body.session);
  off.add('702'); await expire();
  await ws.waitFor(f => f.type === 'account_restricted');
  ws.send({ type: 'chat_send', nonce: 'n1', channel: 'x', message: 'hi' });
  const e = await ws.waitFor(f => f.type === 'chat_error' && f.nonce === 'n1');
  assert.equal(e.error, 'account_restricted');
  off.delete('702'); await expire();
  await ws.waitFor(f => f.type === 'account_restored');
  ws.send({ type: 'chat_hello' });
  await ws.waitFor(f => f.type === 'chat_ready' && f !== ws.frames[0]);
  ws.close();
});

test('gateway: a socket that connects while restricted is told and gets nothing', async () => {
  const r = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '703', username: 'cy', scp: ['chat'] }) });
  off.add('703'); await expire();
  const ws = wsClient(inst.url);
  await ws.open();
  ws.send({ type: 'auth', session: r.body.session });
  await ws.waitFor(f => f.type === 'account_restricted');
  ws.send({ type: 'chat_hello', nonce: 'h' });
  assert.equal((await ws.waitFor(f => f.type === 'chat_error' && f.nonce === 'h')).error, 'account_restricted');
  assert.ok(!ws.frames.some(f => f.type === 'chat_ready'));
  ws.close();
});
