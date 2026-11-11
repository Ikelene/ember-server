'use strict';
// A member's live clients (PROTOCOL §7.1): REST + chat_clients_watch, visible to the person and Manage users holders only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const WebSocket = require('ws');
const { startServer } = require('../src/index');
const CL = require('../src/clients');
const { tmpDir, api } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
const sockets = [];
let inst, base, alice, bob, carol, sid, role, wsB;
const S = p => `/api/v1/servers/${sid}${p}`;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// a gateway connection with its own Origin / User-Agent and auth extras
async function connect(session, headers = {}, extra = {}) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/gateway', { headers });
  const frames = [], waiters = [];
  ws.on('message', raw => { const f = JSON.parse(raw.toString()); frames.push(f); for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(f); } });
  const me = {
    ws, frames,
    send: o => ws.send(JSON.stringify(o)),
    waitFor: (pred, ms = 4000) => { const hit = frames.find(pred); if (hit) return Promise.resolve(hit); return new Promise((resolve, reject) => { const w = { pred, resolve, t: setTimeout(() => reject(new Error('timeout; got ' + frames.map(f => f.type).join(','))), ms) }; waiters.push(w); }); },
    close: () => new Promise(res => { ws.once('close', res); ws.close(); }),
  };
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  me.send({ type: 'auth', session, ...extra });
  await me.waitFor(f => f.type === 'auth_success');
  me.send({ type: 'chat_hello' });
  await me.waitFor(f => f.type === 'chat_ready');
  sockets.push(ws);
  return me;
}
const clientsOf = (who, u) => who.a.get(S(`/members/${encodeURIComponent(u.user.id)}/clients`));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { sockets.forEach(ws => ws.terminate()); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup: alice owns, bob has Manage users, carol is plain', async () => {
  alice = await reg('alice'); bob = await reg('bob'); carol = await reg('carol');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid;
  await bob.a.post(S('/join')); await carol.a.post(S('/join'));
  role = (await alice.a.post(S('/roles'), { name: 'Watchers', permissions: 2048 })).body.role;
  assert.equal((await alice.a.put(S(`/members/${bob.user.id}/roles/${role.rid}`))).status, 200);
});

test('the User-Agent gives a coarse platform / browser only; scripts say nothing', () => {
  assert.deepEqual(CL.uaInfo(CHROME_WIN), { platform: 'Windows', browser: 'Chrome' });
  assert.deepEqual(CL.uaInfo('Mozilla/5.0 (Linux; Android 15; wv) Chrome/130 Mobile BonfireAndroid/0.9'), { platform: 'Android', browser: 'Chrome', mobile: true });
  assert.deepEqual(CL.uaInfo('Mozilla/5.0 (Windows NT 10.0) Chrome/130 Electron/33 BonfireDesktop/1.4.2'), { platform: 'Windows', browser: 'Electron' });
  assert.deepEqual(CL.uaInfo('python-requests/2.32'), {});
  assert.deepEqual(CL.viaOf('http://192.168.1.5:5173', 'x', null), {});
  assert.deepEqual(CL.viaOf('https://ember.example', 'Mozilla/5.0 Electron/33 BonfireDesktop/1.4.2', { id: 'app_0123456789ab', name: 'Thing' }), { url: 'https://ember.example', kind: 'desktop', app: 'app_0123456789ab', token: 'Thing' });
  assert.deepEqual(CL.clientInfo({ version: 'abc1234', device: 'x'.repeat(80), platform: 7, other: 'no' }), { version: 'abc1234', device: 'x'.repeat(40) });
});

test('REST: the person and Manage users holders see the live clients, nobody else', async () => {
  const offline = (await clientsOf(bob, carol)).body;
  assert.equal(offline.online, false);
  assert.deepEqual(offline.sessions, []);
  const c1 = await connect(carol.session, { Origin: 'https://app.example', 'User-Agent': CHROME_WIN }, { client: { version: 'v9' } });
  const r = await clientsOf(bob, carol);
  assert.equal(r.status, 200);
  assert.equal(r.body.user_id, carol.user.id);
  assert.equal(r.body.online, true);
  assert.equal(r.body.sessions.length, 1);
  const s = r.body.sessions[0];
  assert.deepEqual(s.via, { url: 'https://app.example' });
  assert.equal(s.platform, 'Windows'); assert.equal(s.browser, 'Chrome'); assert.equal(s.version, 'v9'); assert.equal(s.state, 'active');
  assert.ok(s.connected_at > 0);
  assert.equal(JSON.stringify(r.body).includes('127.0.0.1'), false, 'no addresses');
  assert.equal((await clientsOf(carol, carol)).status, 200, 'yourself');
  assert.equal((await clientsOf(alice, carol)).status, 200, 'the owner has every permission');
  const denied = await clientsOf(carol, alice);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'not_allowed');
  assert.equal((await api(base).get(S(`/members/${carol.user.id}/clients`))).status, 401);
  assert.equal((await bob.a.get(S('/members/u:999/clients'))).status, 404);
  await c1.close();
  await sleep(50);
  assert.equal((await clientsOf(bob, carol)).body.sessions.length, 0);
});

test('a script with no Origin still shows up, with nothing made up', async () => {
  const c = await connect(carol.session, { 'User-Agent': 'python-requests/2.32' });
  const s = (await clientsOf(bob, carol)).body.sessions;
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].via, {});
  assert.equal(s[0].platform, undefined);
  await c.close();
});

test('chat_clients_watch: an answer now, then live updates; refused without the permission', async () => {
  wsB = await connect(bob.session);
  wsB.send({ type: 'chat_clients_watch', server: sid, user_id: carol.user.id });
  const first = await wsB.waitFor(f => f.type === 'chat_clients' && f.user_id === carol.user.id);
  assert.equal(first.server, sid);
  assert.equal(first.sessions.length, 0);
  const n = wsB.frames.length;
  const c1 = await connect(carol.session, { Origin: 'https://app.example' });
  const up = await wsB.waitFor(f => f.type === 'chat_clients' && f.sessions?.length === 1 && wsB.frames.indexOf(f) >= n);
  assert.equal(up.online, true);
  const c2 = await connect(carol.session, { Origin: 'https://other.example' }, { mobile: true });
  const two = await wsB.waitFor(f => f.type === 'chat_clients' && f.sessions?.length === 2);
  assert.deepEqual(two.sessions.map(x => x.via.url), ['https://app.example', 'https://other.example']);
  assert.equal(two.sessions[1].mobile, true);
  c2.send({ type: 'chat_client_state', state: 'background' });
  await wsB.waitFor(f => f.type === 'chat_clients' && f.sessions?.some(x => x.state === 'background'));
  await c2.close();
  await wsB.waitFor(f => f.type === 'chat_clients' && f.sessions?.length === 1 && wsB.frames.indexOf(f) > wsB.frames.indexOf(two));

  const wsC = await connect(carol.session);
  wsC.send({ type: 'chat_clients_watch', server: sid, user_id: alice.user.id, nonce: 'x' });
  const no = await wsC.waitFor(f => f.type === 'chat_error' && f.request === 'chat_clients_watch');
  assert.equal(no.error, 'not_allowed');
  wsC.send({ type: 'chat_clients_watch', server: sid, user_id: carol.user.id });
  const mine = await wsC.waitFor(f => f.type === 'chat_clients' && f.user_id === carol.user.id);
  assert.equal(mine.sessions.length, 2, 'yourself: this socket and the other one');
  await c1.close();
  await wsC.close();
});

test('losing Manage users ends the watch on the next change', async () => {
  assert.equal((await alice.a.del(S(`/members/${bob.user.id}/roles/${role.rid}`))).status, 200);
  const c = await connect(carol.session);
  const end = await wsB.waitFor(f => f.type === 'chat_clients' && f.ended === true);
  assert.equal(end.user_id, carol.user.id);
  assert.equal(end.sessions, undefined);
  const before = wsB.frames.length;
  await c.close();
  await sleep(400);
  assert.equal(wsB.frames.slice(before).some(f => f.type === 'chat_clients'), false, 'no more updates');
});

test('bots: their /bot/gateway connections show as kind bot', async () => {
  const created = await alice.a.post('/api/v1/bots', { name: 'dotbot' });
  const bot = created.body.bot, token = created.body.token;
  assert.equal((await alice.a.post('/api/v1/bots/by-name/dotbot/add', { sid })).status, 200);
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/bot/gateway', { headers: { 'User-Agent': 'DiscordBot (https://x.example, 1.0)' } });
  sockets.push(ws);
  const frames = [];
  ws.on('message', raw => frames.push(JSON.parse(raw)));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ op: 2, d: { token } }));
  for (let i = 0; i < 100 && !frames.some(f => f.t === 'READY'); i++) await sleep(10);
  const r = await alice.a.get(S(`/members/${encodeURIComponent(bot.id)}/clients`));
  assert.equal(r.status, 200);
  assert.equal(r.body.sessions.length, 1);
  assert.deepEqual(r.body.sessions[0].via, { kind: 'bot' });
  assert.equal((await carol.a.get(S(`/members/${encodeURIComponent(bot.id)}/clients`))).status, 403);
  ws.close();
});
