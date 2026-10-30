'use strict';
// Aliases: a bot posts under another name and picture; the author stays the real bot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const WebSocket = require('ws');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base, alice, sid, general, bot, token, chId, gw, ugw;
const clients = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reset = () => { require('../src/messages')._sendLimit.reset(); require('../src/routes/botapi')._hits.reset(); };
const reg = async n => {
  const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' });
  return { ...r.body, a: api(base, r.body.session) };
};
const botCall = async (method, p, body) => {
  reset();
  const r = await fetch(base + '/bot/v1' + p, { method, headers: { Authorization: 'Bot ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const until = async (frames, pred, ms = 3000) => { for (let i = 0; i < ms / 40; i++) { const f = frames.find(pred); if (f) return f; await sleep(40); } throw new Error('no frame'); };

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup: server, a bot on the bot gateway, a user on the gateway', async () => {
  alice = await reg('alice');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid;
  const r = await alice.a.post('/api/v1/bots', { name: 'Sable', description: 'agent' });
  bot = r.body.bot; token = r.body.token;
  await alice.a.post('/api/v1/bots/by-name/sable/add', { sid });
  chId = (await botCall('GET', `/guilds/${(await botCall('GET', '/users/@me/guilds')).body[0].id}/channels`)).body.find(c => c.name === 'general').id;
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/bot/gateway');
  const frames = [];
  ws.on('message', x => frames.push(JSON.parse(x)));
  await new Promise(res => ws.on('open', res));
  ws.send(JSON.stringify({ op: 2, d: { token, intents: 1 << 15 | 1 << 9 } }));
  await until(frames, f => f.t === 'READY');
  gw = { ws, frames };
  clients.push({ close: () => ws.close() });
  ugw = await wsClient(base).login(alice.session);
  clients.push(ugw);
});

let aliasedId;
test('a bot posts with an alias: REST response, history, both gateways, author unchanged', async () => {
  const r = await botCall('POST', `/channels/${chId}/messages`, { content: 'hi from the alias', alias: { name: '  sable :3 · opencode-go/kimi-k3 ', avatar_url: 'https://example.com/a.png' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.alias, { name: 'sable :3 · opencode-go/kimi-k3', avatar_url: 'https://example.com/a.png' });
  assert.equal(r.body.author.id, bot.id.slice(2));
  assert.equal(r.body.author.bot, true);
  aliasedId = r.body.id;
  // user gateway: chat_message carries alias + the real author
  const f = await ugw.waitFor(x => x.type === 'chat_message' && x.message.id === aliasedId);
  assert.deepEqual(f.message.alias, { name: 'sable :3 · opencode-go/kimi-k3', avatar_url: 'https://example.com/a.png' });
  assert.equal(f.message.author.id, bot.id);
  // bot gateway MESSAGE_CREATE
  const mc = await until(gw.frames, x => x.t === 'MESSAGE_CREATE' && x.d.id === aliasedId);
  assert.equal(mc.d.alias.name, 'sable :3 · opencode-go/kimi-k3');
  // user history + bot history
  const h = await alice.a.get(`/api/v1/channels/${general}/messages`);
  const m = h.body.messages.find(x => x.id === aliasedId);
  assert.deepEqual(m.alias, { name: 'sable :3 · opencode-go/kimi-k3', avatar_url: 'https://example.com/a.png' });
  assert.equal(m.author.id, bot.id);
  const bh = await botCall('GET', `/channels/${chId}/messages`);
  assert.equal(bh.body.find(x => x.id === aliasedId).alias.avatar_url, 'https://example.com/a.png');
  // no alias -> null, name only -> avatar_url null
  const plain = await botCall('POST', `/channels/${chId}/messages`, { content: 'plain' });
  assert.equal(plain.body.alias, null);
  const nameOnly = await botCall('POST', `/channels/${chId}/messages`, { content: 'named', alias: { name: 'Narrator' } });
  assert.deepEqual(nameOnly.body.alias, { name: 'Narrator', avatar_url: null });
});

test('replies, search and pins carry the alias', async () => {
  const rep = await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'replying', reply_to: aliasedId });
  assert.equal(rep.status, 200);
  assert.equal(rep.body.message.reply.alias.name, 'sable :3 · opencode-go/kimi-k3');
  assert.equal(rep.body.message.alias, null);
  const s = await alice.a.get(`/api/v1/channels/${general}/search?q=alias`);
  assert.equal(s.body.messages.find(x => x.id === aliasedId).alias.name, 'sable :3 · opencode-go/kimi-k3');
  const ss = await alice.a.get(`/api/v1/servers/${sid}/search?q=alias`);
  assert.equal(ss.body.messages.find(x => x.id === aliasedId).alias.name, 'sable :3 · opencode-go/kimi-k3');
  assert.ok([200, 204].includes((await alice.a.put(`/api/v1/messages/${aliasedId}/pin`)).status));
  const p = await alice.a.get(`/api/v1/channels/${general}/pins`);
  assert.equal(p.body.messages[0].alias.name, 'sable :3 · opencode-go/kimi-k3');
  // the bot API's referenced_message too
  const bh = await botCall('GET', `/channels/${chId}/messages/${rep.body.message.id}`);
  assert.equal(bh.body.referenced_message.alias.name, 'sable :3 · opencode-go/kimi-k3');
});

test('validation: too long, empty, newlines, non-https, too-long url, wrong type', async () => {
  const bad = [
    { name: 'x'.repeat(33) }, { name: '   ' }, { name: '' }, { name: 'two\nlines' }, { name: 5 },
    { name: 'ok', avatar_url: 'http://example.com/a.png' }, { name: 'ok', avatar_url: 'javascript:alert(1)' },
    { name: 'ok', avatar_url: 'https://example.com/' + 'a'.repeat(490) }, { name: 'ok', avatar_url: 'https://u:p@example.com/a.png' }, 'sable', [],
  ];
  for (const alias of bad) {
    const r = await botCall('POST', `/channels/${chId}/messages`, { content: 'nope', alias });
    assert.equal(r.status, 400, JSON.stringify(alias));
    assert.equal(r.body.message.startsWith('alias') || r.body.message === 'invalid_alias', true);
  }
  // exactly 32 is fine
  assert.equal((await botCall('POST', `/channels/${chId}/messages`, { content: 'max', alias: { name: 'y'.repeat(32) } })).status, 200);
});

test('users can never set an alias: 403 alias_bots_only (REST post, REST edit, gateway send)', async () => {
  const r = await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'sneaky', alias: { name: 'Mod Team' } });
  assert.deepEqual([r.status, r.body.error], [403, 'alias_bots_only']);
  const ok = await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'mine' });
  const e = await alice.a.patch(`/api/v1/messages/${ok.body.message.id}`, { message: 'edited', alias: { name: 'Mod Team' } });
  assert.deepEqual([e.status, e.body.error], [403, 'alias_bots_only']);
  const clr = await alice.a.patch(`/api/v1/messages/${ok.body.message.id}`, { message: 'edited', alias: null });
  assert.equal(clr.status, 403);
  ugw.send({ type: 'chat_send', nonce: 'n1', channel: general, message: 'via gw', alias: { name: 'Mod Team' } });
  const f = await ugw.waitFor(x => x.nonce === 'n1');
  assert.equal(f.error, 'alias_bots_only');
});

test('a bot edits its alias, keeps it when not given, and clears it with null', async () => {
  let r = await botCall('PATCH', `/channels/${chId}/messages/${aliasedId}`, { alias: { name: 'Renamed', avatar_url: 'https://example.com/b.png' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.alias, { name: 'Renamed', avatar_url: 'https://example.com/b.png' });
  const up = await ugw.waitFor(x => x.type === 'chat_message_update' && x.message.id === aliasedId && x.message.alias?.name === 'Renamed');
  assert.equal(up.message.author.id, bot.id);
  r = await botCall('PATCH', `/channels/${chId}/messages/${aliasedId}`, { content: 'new text' });
  assert.equal(r.body.alias.name, 'Renamed');
  assert.equal(r.body.content, 'new text');
  r = await botCall('PATCH', `/channels/${chId}/messages/${aliasedId}`, { alias: { name: 'x'.repeat(40) } });
  assert.equal(r.status, 400);
  r = await botCall('PATCH', `/channels/${chId}/messages/${aliasedId}`, { alias: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.alias, null);
  const h = await alice.a.get(`/api/v1/channels/${general}/messages`);
  assert.equal(h.body.messages.find(x => x.id === aliasedId).alias, null);
});
