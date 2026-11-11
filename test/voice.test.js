'use strict';
// Voice signalling against a stubbed Cloudflare Realtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const { startServer } = require('../src/index');
const voice = require('../src/voice');

const dir = tmpDir();
let inst, calls = [], n = 0;
const SDP = 'v=0\r\n' + 'a=x\r\n'.repeat(10);
const stub = async (url, init) => {
  calls.push(`${init.method} ${url.replace('https://rtc.live.cloudflare.com/v1', '')} auth=${init.headers.Authorization}`);
  const body = init.body ? JSON.parse(init.body) : {};
  let out = {};
  if (/sessions\/new$/.test(url)) out = { sessionId: 'sess' + ++n };
  else if (/generate-ice-servers$/.test(url)) out = { iceServers: [{ urls: ['stun:stun.example:3478'] }] };
  else if (/tracks\/new$/.test(url)) out = { sessionDescription: { type: 'answer', sdp: SDP }, tracks: body.tracks.map((t, i) => ({ trackName: t.trackName, mid: String(i), sessionId: t.sessionId })) };
  else if (/\/sessions\/[^/]+$/.test(url)) out = { tracks: [] };
  return { ok: true, status: 200, json: async () => out };
};

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); voice.setFetch(stub); voice._setResumeGraceMs(50); });
test.after(async () => { voice.setFetch(null); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('join, publish, connect, subscribe, leave; permissions and limits', async () => {
  const reg = async u => { const r = await api(inst.url).post('/api/v1/auth/register', { username: u, password: 'password123' }); return { ...r.body, a: api(inst.url, r.body.session) }; };
  const alice = await reg('alice'), bob = await reg('bob'), mallory = await reg('mallory');
  assert.equal((await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() })).status, 200);
  const d = (await alice.a.post('/api/v1/servers', { name: 'Voice', join_policy: 'open' })).body;
  const sid = d.server.sid, vc = d.channels.find(c => c.type === 'voice').cid, room = 'bf_' + vc;
  await bob.a.post(`/api/v1/servers/${sid}/join`);
  const wa = await wsClient(inst.url).login(alice.session), wb = await wsClient(inst.url).login(bob.session), wm = await wsClient(inst.url).login(mallory.session);

  // not configured yet
  wa.send({ type: 'chat_rtc_join', nonce: 'j0', room });
  assert.equal((await wa.waitFor(f => f.nonce === 'j0')).error, 'voice_unavailable');
  await bob.a.patch('/api/v1/instance/settings', { voice: { cf_app_id: 'app', cf_app_secret: 'sec', cf_turn_key_id: 'key', cf_turn_token: 'tok' } }).then(r => assert.equal(r.status, 403)); // bob is not an admin
  const set = await alice.a.patch('/api/v1/instance/settings', { voice: { cf_app_id: 'app', cf_app_secret: 'sec', cf_turn_key_id: 'key', cf_turn_token: 'tok' } });
  assert.equal(set.status, 200);
  assert.equal((await api(inst.url).get('/.well-known/bonfire')).body.features.voice, true);

  // outsiders are refused
  wm.send({ type: 'chat_rtc_join', nonce: 'm1', room });
  assert.equal((await wm.waitFor(f => f.nonce === 'm1')).error, 'not_a_member');

  wa.send({ type: 'chat_rtc_join', nonce: 'j1', room });
  const joined = await wa.waitFor(f => f.type === 'chat_rtc_joined');
  assert.deepEqual(joined.people, []);
  assert.equal(joined.iceServers[0].urls[0], 'stun:stun.example:3478');
  assert.ok(calls.some(c => c.includes('/apps/app/sessions/new') && c.endsWith('auth=Bearer sec')));
  assert.ok(calls.some(c => c.includes('/turn/keys/key/credentials/generate-ice-servers') && c.endsWith('auth=Bearer tok')));
  wa.send({ type: 'chat_rtc_publish', nonce: 'p1', room, sessionDescription: { type: 'offer', sdp: SDP }, tracks: [{ mid: '0', trackName: 'audio' }, { mid: '1', trackName: 'bogus' }] });
  const pub = await wa.waitFor(f => f.type === 'chat_rtc_published');
  assert.deepEqual(pub.tracks.map(t => t.trackName), ['audio']);
  // not visible until the browser confirms a connection
  assert.equal((await alice.a.get(`/api/v1/servers/${sid}`)).body.voice[vc].length, 0);
  wa.send({ type: 'chat_rtc_connected', room });
  const st = await wb.waitFor(f => f.type === 'chat_voice_state');
  assert.deepEqual(st.users.map(u => u.username), ['alice']);
  assert.equal(st.channel, vc);
  assert.equal(st.server, sid);
  assert.equal((await bob.a.get(`/api/v1/servers/${sid}`)).body.voice[vc][0].username, 'alice');

  wb.send({ type: 'chat_rtc_join', nonce: 'j2', room });
  const j2 = await wb.waitFor(f => f.type === 'chat_rtc_joined');
  assert.equal(j2.people[0].userId, alice.user.id);
  wb.send({ type: 'chat_rtc_subscribe', nonce: 's1', room, sources: [{ userId: alice.user.id, trackName: 'audio' }] });
  const offer = await wb.waitFor(f => f.type === 'chat_rtc_offer');
  assert.equal(offer.tracks[0].userId, alice.user.id);
  wb.send({ type: 'chat_rtc_answer', nonce: 'a1', room, session: 'receive', sessionDescription: { type: 'answer', sdp: SDP } });
  assert.equal((await wb.waitFor(f => f.type === 'chat_rtc_ready' && f.nonce === 'a1')).session, 'receive');
  wb.send({ type: 'chat_rtc_ice', nonce: 'i1', room });
  assert.equal((await wb.waitFor(f => f.nonce === 'i1')).session, 'ice');
  // frames from a socket that never joined
  wm.send({ type: 'chat_rtc_publish', nonce: 'x', room, sessionDescription: { type: 'offer', sdp: SDP }, tracks: [] });
  assert.equal((await wm.waitFor(f => f.nonce === 'x' && f.type === 'chat_error')).error, 'not_in_voice');

  // leaving (socket close) clears the voice state
  wa.send({ type: 'chat_rtc_leave' });
  const empty = await wb.waitFor(f => f.type === 'chat_voice_state' && f.users.length === 0);
  assert.equal(empty.users.length, 0);

  // user_limit (Manage channels bypasses it; bob doesn't have that)
  wb.send({ type: 'chat_rtc_leave' });
  await alice.a.patch(`/api/v1/channels/${vc}`, { config: { user_limit: 1 } });
  wa.send({ type: 'chat_rtc_join', nonce: 'j3', room });
  await wa.waitFor(f => f.type === 'chat_rtc_joined' && f.nonce === 'j3');
  wa.send({ type: 'chat_rtc_connected', room });
  await wb.waitFor(f => f.type === 'chat_voice_state' && f.users.length === 1 && f.users[0].username === 'alice' && wb.frames.filter(x => x.type === 'chat_voice_state').length >= 3);
  wb.send({ type: 'chat_rtc_join', nonce: 'j4', room });
  assert.equal((await wb.waitFor(f => f.nonce === 'j4' && f.type === 'chat_error')).error, 'channel_full');
  [wa, wb, wm].forEach(w => w.close());
});

test('a dropped socket parks the call; a new socket resumes it with the token, others never see a leave', async () => {
  // (alice's socket from the test above closed while connected: her parked call ends after the grace period)
  await new Promise(r => setTimeout(r, 150)); voice._setResumeGraceMs(30000);
  const reg = async u => { const r = await api(inst.url).post('/api/v1/auth/register', { username: u, password: 'password123' }); return { ...r.body, a: api(inst.url, r.body.session) }; };
  const carol = await reg('carol'), dave = await reg('dave');
  const owner = (await api(inst.url).post('/api/v1/auth/login', { username: 'alice', password: 'password123' })).body;
  const oa = api(inst.url, owner.session);
  const sid = (await oa.get('/api/v1/servers')).body.servers[0].sid; // (the server from the test above; its voice channel is empty again)
  const vc = (await oa.get(`/api/v1/servers/${sid}`)).body.channels.find(c => c.type === 'voice').cid, room = 'bf_' + vc;
  await oa.patch(`/api/v1/channels/${vc}`, { config: { user_limit: 0 } });
  await carol.a.post(`/api/v1/servers/${sid}/join`); await dave.a.post(`/api/v1/servers/${sid}/join`);
  const wc = await wsClient(inst.url).login(carol.session), wd = await wsClient(inst.url).login(dave.session);
  wc.send({ type: 'chat_rtc_join', nonce: 'c1', room });
  const joined = await wc.waitFor(f => f.type === 'chat_rtc_joined' && f.nonce === 'c1');
  assert.ok(typeof joined.resume === 'string' && joined.resume.length > 10);
  wc.send({ type: 'chat_rtc_publish', nonce: 'cp', room, sessionDescription: { type: 'offer', sdp: SDP }, tracks: [{ mid: '0', trackName: 'audio' }] });
  await wc.waitFor(f => f.type === 'chat_rtc_published' && f.nonce === 'cp');
  wc.send({ type: 'chat_rtc_connected', room });
  await wd.waitFor(f => f.type === 'chat_voice_state' && f.channel === vc && f.users.length === 1);
  const before = calls.length;

  // the socket drops: carol stays in the room (parked), her sessions stay open
  wc.ws.terminate(); await wc.closed;
  await new Promise(r => setTimeout(r, 150));
  assert.equal(voice.voiceIn.get(room)?.size, 1);
  assert.ok(!calls.slice(before).some(c => c.startsWith('GET ') || c.includes('/tracks/close')), 'no sessions closed while parked');

  // a wrong token / another account can't take it over
  wd.send({ type: 'chat_rtc_resume', nonce: 'dr', room, resume: joined.resume });
  assert.equal((await wd.waitFor(f => f.nonce === 'dr')).error, 'resume_failed');
  const wc2 = await wsClient(inst.url).login(carol.session);
  wc2.send({ type: 'chat_rtc_resume', nonce: 'bad', room, resume: 'x'.repeat(24) });
  assert.equal((await wc2.waitFor(f => f.nonce === 'bad')).error, 'resume_failed');

  wc2.send({ type: 'chat_rtc_resume', nonce: 'r1', room, resume: joined.resume });
  const resumed = await wc2.waitFor(f => f.nonce === 'r1');
  assert.equal(resumed.type, 'chat_rtc_resumed');
  assert.deepEqual(resumed.tracks.map(t => t.trackName), ['audio']);
  assert.notEqual(resumed.resume, joined.resume); // (a fresh token every time)
  assert.ok(!wd.frames.some(f => f.type === 'chat_voice_state' && f.channel === vc && f.users.length === 0), 'dave never saw carol leave');
  // the resumed socket is the participant now: mute works, and leaving really leaves
  wc2.send({ type: 'chat_voice_mute', room, muted: true });
  await wd.waitFor(f => f.type === 'chat_voice_state' && f.channel === vc && f.users[0]?.muted === true);
  wc2.send({ type: 'chat_rtc_leave' });
  await wd.waitFor(f => f.type === 'chat_voice_state' && f.channel === vc && f.users.length === 0);

  // a parked call that nobody resumes ends after the grace period
  voice._setResumeGraceMs(100);
  wc2.send({ type: 'chat_rtc_join', nonce: 'c2', room });
  await wc2.waitFor(f => f.type === 'chat_rtc_joined' && f.nonce === 'c2');
  wc2.send({ type: 'chat_rtc_connected', room });
  await wd.waitFor(f => f.type === 'chat_voice_state' && f.channel === vc && f.users.length === 1 && wd.frames.filter(x => x.type === 'chat_voice_state' && x.channel === vc).length >= 4);
  wc2.ws.terminate(); await wc2.closed;
  await wd.waitFor(f => f.type === 'chat_voice_state' && f.channel === vc && f.users.length === 0 && wd.frames.filter(x => x.type === 'chat_voice_state' && x.channel === vc && x.users.length === 0).length >= 2);
  voice._setResumeGraceMs(30000);
  wd.close();
});
