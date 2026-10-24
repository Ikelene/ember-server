'use strict';
// bots in voice against a stubbed Cloudflare Realtime
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const WebSocket = require('ws');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const { startServer } = require('../src/index');
const voice = require('../src/voice');

const dir = tmpDir();
const SDP = 'v=0\r\n' + 'a=x\r\n'.repeat(10);
let n = 0;
const stub = async url => {
  let out = {};
  if (/sessions\/new$/.test(url)) out = { sessionId: 'sess' + ++n };
  else if (/generate-ice-servers$/.test(url)) out = { iceServers: [{ urls: ['stun:stun.example:3478'] }] };
  else if (/tracks\/new$/.test(url)) out = { sessionDescription: { type: 'answer', sdp: SDP }, tracks: [{ trackName: 'audio', mid: '0' }] };
  else if (/\/sessions\/[^/]+$/.test(url)) out = { tracks: [] };
  return { ok: true, status: 200, json: async () => out };
};
let inst;
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); voice.setFetch(stub); });
test.after(async () => { voice.setFetch(null); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a bot joins a voice channel, publishes, sees voice state and leaves', async () => {
  const alice = (await api(inst.url).post('/api/v1/auth/register', { username: 'alice', password: 'password123' })).body;
  const a = api(inst.url, alice.session);
  await a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  await a.patch('/api/v1/instance/settings', { voice: { cf_app_id: 'app', cf_app_secret: 'sec', cf_turn_key_id: 'key', cf_turn_token: 'tok' } });
  const d = (await a.post('/api/v1/servers', { name: 'Voice', join_policy: 'open' })).body;
  const vc = d.channels.find(c => c.type === 'voice');
  const created = (await a.post('/api/v1/bots', { name: 'djbot' })).body;
  await a.post('/api/v1/bots/by-name/djbot/add', { sid: d.server.sid });
  const wa = await wsClient(inst.url).login(alice.session);
  wa.send({ type: 'chat_hello' });

  const ws = new WebSocket(inst.url.replace(/^http/, 'ws') + '/bot/gateway');
  const frames = [];
  ws.on('message', raw => frames.push(JSON.parse(raw)));
  await new Promise(r => ws.once('open', r));
  const wait = async f => { for (let i = 0; i < 200; i++) { const hit = frames.find(f); if (hit) return hit; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); };
  const send = o => ws.send(JSON.stringify(o));
  send({ op: 2, d: { token: created.token } });
  const gc = await wait(f => f.t === 'GUILD_CREATE');
  const guild = gc.d.id, chan = String(gc.d.channels.find(c => c.bonfire_type === 'voice').id);
  assert.deepEqual(gc.d.voice_states, []);

  send({ op: 4, d: { guild_id: guild, channel_id: chan, nonce: 'j' } });
  const srv = await wait(f => f.t === 'VOICE_SERVER_UPDATE');
  assert.equal(srv.d.room, 'bf_' + vc.cid);
  assert.equal(srv.d.ice_servers[0].urls[0], 'stun:stun.example:3478');
  send({ op: 40, d: { type: 'chat_rtc_publish', nonce: 'p', room: srv.d.room, sessionDescription: { type: 'offer', sdp: SDP }, tracks: [{ mid: '0', trackName: 'audio' }] } });
  const pub = await wait(f => f.t === 'RTC' && f.d.type === 'chat_rtc_published');
  assert.equal(pub.d.tracks[0].trackName, 'audio');
  send({ op: 40, d: { type: 'chat_rtc_connected', room: srv.d.room } });
  const up = await wait(f => f.t === 'VOICE_STATE_UPDATE');
  assert.equal(up.d.channel_id, chan);
  assert.equal(up.d.member.user.bot, true);
  const seen = await wa.waitFor(f => f.type === 'chat_voice_state');
  assert.equal(seen.users[0].username, 'djbot');

  send({ op: 40, d: { type: 'chat_rtc_join', room: srv.d.room, nonce: 'x' } });
  assert.equal((await wait(f => f.t === 'RTC' && f.d.nonce === 'x')).d.error, 'bad_request');
  send({ op: 4, d: { guild_id: guild, channel_id: '999999', nonce: 'y' } });
  assert.equal((await wait(f => f.t === 'RTC' && f.d.nonce === 'y')).d.error, 'not_allowed');

  frames.length = 0;
  send({ op: 4, d: { guild_id: guild, channel_id: null } });
  const left = await wait(f => f.t === 'VOICE_STATE_UPDATE');
  assert.equal(left.d.channel_id, null);
  ws.terminate(); wa.ws.terminate();
});
