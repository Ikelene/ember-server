'use strict';
// Push through a gateway (PROTOCOL §20): pushers are registered per account, a mention of someone who is not connected goes
// to each of their pushers' gateways, a pusher that hides previews gets none, rejected keys are forgotten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const dir = tmpDir();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } }

// ---- a stand-in push gateway ----
const got = []; // { path, homeserver, n: notification }
const reject = new Set();
let gwServer, GW, slow = false, answers = []; // answers: statuses to give before the normal one (a busy or failing gateway)
function gatewayServer() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      const n = JSON.parse(body).notification;
      got.push({ path: req.url, homeserver: req.headers['x-ember-homeserver'], type: req.headers['content-type'], sig: req.headers['ember-signature'], host: req.headers.host, raw: body, n });
      if (slow) await sleep(300);
      const st = answers.shift();
      if (st) { res.writeHead(st, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: st === 401 ? 'invalid_signature' : 'busy' })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rejected: reject.has(n.pushkey) ? [n.pushkey] : [] }));
    });
  });
}

let inst, base, push, db, alice, bob, carol, sid, general;
const clients = [];
test.before(async () => {
  gwServer = gatewayServer();
  await new Promise(r => gwServer.listen(0, '127.0.0.1', r));
  GW = `http://127.0.0.1:${gwServer.address().port}/_ember/push/v1/notify`;
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  push = require('../src/push'); db = require('../src/db');
});
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); require('../src/safe-http')._test.allowLocal(false); gwServer.closeAllConnections?.(); gwServer.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); const a = api(base, r.body.session), post = a.post; a.post = (p, b) => { if (/\/messages$/.test(p)) require('../src/messages')._sendLimit.reset(); return post(p, b); }; return { ...r.body, a }; };
const say = (who, message, extra = {}) => who.a.post(`/api/v1/channels/${general}/messages`, { message, ...extra });
const settle = async () => { await sleep(40); await push.idle(); };

test('setup; discovery says where pushers go', async () => {
  alice = await reg('alice'); bob = await reg('bob'); carol = await reg('carol');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Pushy', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid;
  await bob.a.post(`/api/v1/servers/${sid}/join`); await carol.a.post(`/api/v1/servers/${sid}/join`);
  const wk = (await api(base).get('/.well-known/ember')).body;
  assert.deepEqual(wk.push, { pushers_url: `${wk.public_url}/api/v2/pushers` });
});

test('pushers: register, list, update, remove; the gateway must be https; 20 per account', async () => {
  const P = '/api/v2/pushers';
  assert.equal((await api(base).get(P)).status, 401);
  assert.deepEqual((await bob.a.get(P)).body, { pushers: [] });
  assert.equal((await bob.a.post(P, { app_id: 'cc.nookara.ember', pushkey: 'k1', gateway_url: GW })).body.error, 'invalid_gateway_url'); // http
  for (const bad of ['ftp://x.example/', 'https://user:pw@x.example/', 'nope']) assert.equal((await bob.a.post(P, { app_id: 'a', pushkey: 'k1', gateway_url: bad })).body.error, 'invalid_gateway_url', bad);
  assert.equal((await bob.a.post(P, { app_id: 'a', pushkey: '' })).body.error, 'invalid_pushkey');
  assert.equal((await bob.a.post(P, { app_id: 'bad id', pushkey: 'k1' })).body.error, 'invalid_app_id');
  // no gateway named: the homeserver's default (Nookara's unless config says otherwise)
  const def = await bob.a.post(P, { app_id: 'cc.nookara.ember', pushkey: 'k-default', device_name: 'Pixel' });
  assert.equal(def.status, 200, JSON.stringify(def.body));
  assert.deepEqual([def.body.pusher.gateway_url, def.body.pusher.device_name, def.body.pusher.show_preview, def.body.pusher.last_ok_at], ['https://nookara.cc/_ember/push/v1/notify', 'Pixel', true, null]);
  assert.equal((await alice.a.patch('/api/v1/instance/settings', { push: { default_gateway: 'https://push.example/notify' } })).body.push.default_gateway, 'https://push.example/notify');
  assert.equal((await bob.a.post(P, { app_id: 'a', pushkey: 'k-default2' })).body.pusher.gateway_url, 'https://push.example/notify');
  assert.equal((await bob.a.del(P + '/k-default')).status, 200);
  assert.equal((await bob.a.del(P + '/k-default2')).body.pushers.length, 0);
  assert.equal((await bob.a.del(P + '/k-default')).status, 404);
  require('../src/safe-http')._test.allowLocal(true); // from here the stand-in gateway on this machine is allowed
  const one = await bob.a.post(P, { app_id: 'cc.nookara.ember', pushkey: 'bob-phone', gateway_url: GW, device_name: 'Phone' });
  assert.equal(one.body.pusher.gateway_url, GW);
  // the same key again updates it
  const upd = await bob.a.post(P, { app_id: 'cc.nookara.ember', pushkey: 'bob-phone', gateway_url: GW, device_name: 'New phone' });
  assert.equal(upd.body.pusher.device_name, 'New phone');
  assert.equal((await bob.a.get(P)).body.pushers.length, 1);
  assert.deepEqual((await carol.a.get(P)).body.pushers, []); // each account sees its own
  for (let i = 0; i < 19; i++) assert.equal((await bob.a.post(P, { app_id: 'a', pushkey: 'x' + i, gateway_url: GW })).status, 200);
  const full = await bob.a.post(P, { app_id: 'a', pushkey: 'one-too-many', gateway_url: GW });
  assert.deepEqual([full.status, full.body], [409, { error: 'too_many_pushers', limit: 20 }]);
  for (let i = 0; i < 19; i++) await bob.a.del(P + '/x' + i);
  assert.equal((await bob.a.post(P, { app_id: 'cc.nookara.tablet', pushkey: 'bob-tablet/with+odd=chars', gateway_url: GW, show_preview: false })).body.pusher.show_preview, false);
});

test('a mention of someone who is not connected goes to each of their pushers; a hidden preview stays hidden', async () => {
  const ca = await wsClient(base).login(carol.session); clients.push(ca); // carol is connected: she hears it on the gateway
  await carol.a.post('/api/v2/pushers', { app_id: 'cc.nookara.ember', pushkey: 'carol-phone', gateway_url: GW });
  assert.equal((await say(alice, `hey <@${bob.user.id}> and <@${carol.user.id}>, a secret plan`)).status, 200);
  await until(() => got.length >= 2);
  await settle();
  assert.equal(got.length, 2); // bob's two devices; nothing for carol
  const phone = got.find(g => g.n.pushkey === 'bob-phone'), tablet = got.find(g => g.n.pushkey === 'bob-tablet/with+odd=chars');
  assert.equal(phone.path, '/_ember/push/v1/notify');
  assert.equal(phone.homeserver, 'localhost');
  assert.match(phone.type, /application\/json/);
  assert.deepEqual(phone.n, { pushkey: 'bob-phone', app_id: 'cc.nookara.ember', kind: 'mention', title: 'alice mentioned you', homeserver: 'localhost', counts: { unread: 1 }, preview: 'hey @bob and @carol, a secret plan' });
  assert.deepEqual(tablet.n, { pushkey: 'bob-tablet/with+odd=chars', app_id: 'cc.nookara.tablet', kind: 'mention', title: 'alice mentioned you', homeserver: 'localhost', counts: { unread: 1 } });
  assert.ok(ca.frames.some(f => f.type === 'chat_mention'));
  await until(async () => (await bob.a.get('/api/v2/pushers')).body.pushers.every(p => p.last_ok_at));
});

test('gateway requests carry the s2s signature, which checks out against the JWKS', async () => {
  const crypto = require('crypto'), s2s = require('../src/social/s2s');
  const g = got.find(x => x.n.pushkey === 'bob-phone');
  const p = /^keyId="([^"#]+)#([^"]+)", created=(\d+), sig="([A-Za-z0-9_-]+)"$/.exec(g.sig);
  assert.ok(p, g.sig);
  assert.equal(p[1], 'localhost');
  const jwk = (await api(base).get('/.well-known/ember/jwks.json')).body.keys.find(k => k.kid === p[2]);
  assert.ok(jwk);
  const signed = s2s.canonical({ method: 'POST', target: g.path, host: g.host, created: p[3], body: g.raw, purpose: 'push' });
  assert.ok(crypto.verify(null, Buffer.from(signed), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(p[4], 'base64url')));
  // the same request read as an s2s one (no purpose line) does not verify: a gateway cannot replay it as one
  const asS2s = s2s.canonical({ method: 'POST', target: g.path, host: g.host, created: p[3], body: g.raw });
  assert.ok(!crypto.verify(null, Buffer.from(asS2s), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(p[4], 'base64url')));
  assert.ok(!crypto.verify(null, Buffer.from(signed + 'x'), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(p[4], 'base64url')));
});

test('more pings in the same channel soon after become one summary; a reply says so', async () => {
  push._setWindow(250);
  await sleep(40); push.stop(); push.start(); // (a fresh window for bob + this channel)
  got.length = 0;
  const first = (await say(bob, 'what plan?')).body.message;
  await say(alice, 'this one', { reply_to: first.id });
  await until(() => got.length === 2);
  assert.ok(got.every(g => g.n.kind === 'reply' && g.n.title === 'alice replied to you'));
  await say(alice, `<@${bob.user.id}> one`); await say(alice, `<@${bob.user.id}> two`);
  await sleep(100);
  assert.equal(got.length, 2); // held back
  await until(() => got.length === 4);
  const sum = got.find(g => g.n.pushkey === 'bob-phone' && /new mentions/.test(g.n.title));
  assert.equal(sum.n.title, '2 new mentions in #' + (await alice.a.get(`/api/v1/servers/${sid}`)).body.channels.find(c => c.cid === general).name);
  assert.equal(sum.n.preview, 'alice: @bob two');
  assert.ok(sum.n.title.length <= 100 && sum.n.preview.length <= 300);
  assert.equal(got.find(g => g.n.pushkey !== 'bob-phone' && /new mentions/.test(g.n.title)).n.preview, undefined);
});

test('a key the gateway rejects is forgotten; a slow gateway never holds a message up', async () => {
  await sleep(300); got.length = 0;
  reject.add('bob-phone');
  slow = true;
  const t = Date.now();
  assert.equal((await say(alice, `<@${bob.user.id}> are you there`)).status, 200);
  assert.ok(Date.now() - t < 250, 'posting waited for the gateway');
  slow = false;
  await until(async () => (await bob.a.get('/api/v2/pushers')).body.pushers.length === 1, 6000);
  assert.deepEqual((await bob.a.get('/api/v2/pushers')).body.pushers.map(p => p.pushkey), ['bob-tablet/with+odd=chars']);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM pushers WHERE pushkey = 'carol-phone'").n, 1);
  // a preview is at most 300 characters
  await sleep(300); await push.idle(); got.length = 0;
  await bob.a.post('/api/v2/pushers', { app_id: 'a', pushkey: 'bob-new', gateway_url: GW });
  await say(alice, `<@${bob.user.id}> ${'long '.repeat(200)}`);
  const big = await until(() => got.find(g => g.n.pushkey === 'bob-new'));
  assert.equal([...big.n.preview].length, 300);
  // a key registered by another account moves to it
  await carol.a.post('/api/v2/pushers', { app_id: 'a', pushkey: 'bob-new', gateway_url: GW });
  assert.ok(!(await bob.a.get('/api/v2/pushers')).body.pushers.some(p => p.pushkey === 'bob-new'));
  assert.equal((await bob.a.del('/api/v2/pushers/' + encodeURIComponent('bob-tablet/with+odd=chars'))).body.pushers.length, 0);
});

test('a busy or failing gateway is tried again; an answer that is not 2xx is logged', async () => {
  push._setRetry([20, 20]);
  await sleep(300); await push.idle(); got.length = 0;
  const dan = await reg('dan'); // (nobody connected: carol is)
  const danId = require('../src/auth').userByPrincipal(dan.user.id).id;
  await dan.a.post('/api/v2/pushers', { app_id: 'a', pushkey: 'carol-retry', gateway_url: GW });
  const errors = [], orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    answers.push(503, 429);
    push.onOffline([danId], { cid: 'retry-1', id: 0, channel: 'x', from: 'alice', body: 'hello', sid: sid });
    await until(() => got.filter(g => g.n.pushkey === 'carol-retry').length >= 3);
    await push.idle();
    assert.equal(got.filter(g => g.n.pushkey === 'carol-retry').length, 3); // two refusals, then delivered
    assert.ok((await dan.a.get('/api/v2/pushers')).body.pushers.find(p => p.pushkey === 'carol-retry').last_ok_at);
    // a refused signature is not retried, and it is said in the log
    push._logged.clear(); got.length = 0;
    answers.push(401);
    push.onOffline([danId], { cid: 'retry-2', id: 0, channel: 'x', from: 'alice', body: 'again', sid: sid });
    await until(() => got.some(g => g.n.pushkey === 'carol-retry'));
    await push.idle();
    assert.equal(got.filter(g => g.n.pushkey === 'carol-retry').length, 1);
    assert.ok(errors.some(e => /\[push\] 127\.0\.0\.1:\d+: answered 401 invalid_signature/.test(e)), errors.join('|'));
  } finally { console.error = orig; push._setRetry([1000, 4000, 15000]); }
});
