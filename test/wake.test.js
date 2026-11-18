'use strict';
// sleep mode sign-ups (src/wake.js, PROTOCOL §7.2): present while fresh, one ping per sign-up, only to members who can see the channel
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const stub = (rel, exports) => { const id = require.resolve(path.join('../src', rel)); require.cache[id] = { id, filename: id, loaded: true, exports }; };
const calls = [], changed = [], online = new Set();
let registered = true, reply = () => ({ ok: true });
stub('relay/client', { registered: () => registered, call: async (method, p, body) => { calls.push({ method, p, body }); return reply(body); } });
stub('gateway', { peopleChanged: id => changed.push(id), isOnline: id => online.has(id) });
const users = { 1: { id: 1, principal: 'v:11', velora_id: 11 }, 2: { id: 2, principal: 'v:12', velora_id: 12 }, 3: { id: 3, principal: 'l:3', velora_id: null }, 4: { id: 4, principal: 'v:14', velora_id: 14 } };
stub('auth', { userById: id => users[id] || null });
const snap = { channels: [{ cid: 'c1' }], isMember: uid => uid !== 4, canView: (ch, uid) => uid !== 2 };
stub('communities', { snapById: () => snap });
const W = require('../src/wake');

test('a sign-up counts as present until it ends; bots cannot sign up', () => {
  assert.equal(W.subscribe({ id: 1, velora_id: 11 }).ok, true);
  assert.equal(W.active(1), true);
  assert.deepEqual(changed, [1], 'the first sign-up is a presence change');
  W.subscribe({ id: 1, velora_id: 11 });
  assert.deepEqual(changed, [1], 'a renewal is not');
  W.end(1);
  assert.equal(W.active(1), false);
  assert.deepEqual(changed, [1, 1]);
  assert.equal(W.subscribe({ id: 9, kind: 'bot' }).ok, false);
});

test('a new message pings each signed-up member who can see it, once', async () => {
  calls.length = 0;
  for (const id of [1, 2, 3, 4]) W.subscribe({ id, velora_id: users[id].velora_id });
  W.onMessage(5, { channel: 'c1', author: { id: 'v:99' } });
  await new Promise(r => setImmediate(r));
  // 2 can't see the channel, 3 has no Velora account (no way to reach them), 4 isn't a member
  assert.deepEqual(calls, [{ method: 'POST', p: '/bonfire/relay/wake', body: { user_ids: ['11'] } }]);
  W.onMessage(5, { channel: 'c1', author: { id: 'v:99' } });
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1, 'one ping per sign-up');
  W.subscribe({ id: 1, velora_id: 11 }); // a renewal keeps it pinged
  W.onMessage(5, { channel: 'c1', author: { id: 'v:99' } });
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1);
  W.end(1); W.subscribe({ id: 1, velora_id: 11 }); // connected again, then slept again: a new sign-up can be pinged
  W.onMessage(5, { channel: 'c1', author: { id: 'v:11' } });
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1, 'their own message does not wake them');
  W.onMessage(5, { channel: 'c1', author: { id: 'v:99' } });
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 2);
  for (const id of [1, 2, 3, 4]) W.end(id);
});

test('only people Velora reached count as pinged; nobody connected is pinged', async () => {
  calls.length = 0;
  W.subscribe({ id: 1, velora_id: 11 }); W.subscribe({ id: 4, velora_id: 14 }); snap.isMember = () => true;
  online.add(4); // (connected right now: they see it anyway)
  reply = () => ({ ok: true, delivered: 0, delivered_ids: [] }); // (their Ember wasn't reachable just then)
  W.onMessage(5, { channel: 'c1', author: { id: 'v:99' } });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.map(c => c.body.user_ids), [['11']]);
  reply = () => ({ ok: true, delivered: 1, delivered_ids: ['11'] });
  W.onMessage(5, { channel: 'c1', author: { id: 'v:99' } });
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 2, 'not reached last time: pinged again');
  W.onMessage(5, { channel: 'c1', author: { id: 'v:99' } });
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 2, 'reached: not again');
  online.delete(4); snap.isMember = uid => uid !== 4; reply = () => ({ ok: true });
  W.end(1); W.end(4);
});

test('nothing is sent when the server is not registered with Velora', async () => {
  calls.length = 0; registered = false;
  W.subscribe({ id: 1, velora_id: 11 });
  W.onMessage(5, { channel: 'c1', author: { id: 'v:99' } });
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 0);
  W.end(1); registered = true;
});
