'use strict';
// A bot without Read message history in a channel (PROTOCOL §6.5): no single message by id (missing_access), and a new message
// that replies to an earlier one comes without it (referenced_message null) on the bot gateway; with it, as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const WebSocket = require('ws');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const { startServer } = require('../src/index');

const dir = tmpDir();
let inst, base, alice, sid, general, bot, token, chId, frames, ws;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); return { ...r.body, a: api(base, r.body.session) }; };
const botCall = async (method, p, body) => { const r = await fetch(base + '/bot/v1' + p, { method, headers: { Authorization: 'Bot ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const until = async (pred, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const f = frames.find(pred); if (f) return f; await new Promise(r => setTimeout(r, 20)); } throw new Error('no frame; got ' + frames.map(f => f.t).join(',')); };
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { try { ws?.close(); } catch { /* closed */ } await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a bot without read_message_history: no message by id, replies without the earlier message', async () => {
  alice = await reg('alice');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current(), accept_operator_terms: true });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid;
  const r = await alice.a.post('/api/v1/bots', { name: 'Sable', description: 'agent' });
  bot = r.body.bot; token = r.body.token;
  await alice.a.post('/api/v1/bots/by-name/sable/add', { sid });
  chId = (await botCall('GET', `/guilds/${(await botCall('GET', '/users/@me/guilds')).body[0].id}/channels`)).body.find(c => c.name === 'general').id;
  frames = [];
  ws = new WebSocket(base.replace(/^http/, 'ws') + '/bot/gateway');
  ws.on('message', x => frames.push(JSON.parse(x)));
  await new Promise(res => ws.on('open', res));
  ws.send(JSON.stringify({ op: 2, d: { token, intents: 1 << 15 | 1 << 9 } }));
  await until(f => f.t === 'READY');

  const first = (await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'the earlier one' })).body.message;
  // with history: the message by id, and a reply carries what it replies to
  assert.equal((await botCall('GET', `/channels/${chId}/messages/${first.id}`)).status, 200);
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'reply one', reply_to: first.id });
  const withRef = await until(f => f.t === 'MESSAGE_CREATE' && f.d.content === 'reply one');
  assert.equal(withRef.d.referenced_message.content, 'the earlier one');

  // without it
  const ow = await alice.a.put(`/api/v1/servers/${sid}/channels/${general}/overwrites/member/${encodeURIComponent(bot.id)}`, { deny: ['read_message_history'] });
  assert.equal(ow.status, 200, JSON.stringify(ow.body));
  const one = await botCall('GET', `/channels/${chId}/messages/${first.id}`);
  assert.equal(one.status, 403);
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'reply two', reply_to: first.id });
  const bare = await until(f => f.t === 'MESSAGE_CREATE' && f.d.content === 'reply two');
  assert.equal(bare.d.referenced_message, null);
  assert.equal(bare.d.message_reference.message_id, first.id, 'which message it replies to is still said');
  // and no edits of messages
  await alice.a.patch(`/api/v1/messages/${first.id}`, { message: 'the earlier one, edited' });
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!frames.some(f => f.t === 'MESSAGE_UPDATE' && f.d.id === first.id));
});
