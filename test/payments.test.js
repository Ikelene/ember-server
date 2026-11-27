'use strict';
// Paying from another account (PROTOCOL §19.3): an account that is not a Nookara account links one for payments, through
// Nookara's consent page (a stand-in here: the test signs Nookara's answer with a key it holds), then buys a tier with it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { tmpDir, api, fakeIdp } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
process.env.EMBER_NOOKARA_URL = 'http://nookara.test/';
process.env.EMBER_PUBLIC_URL = 'http://chat.test';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PLAN', 'EMBER_LIMITS']) delete process.env[k];
const { startServer } = require('../src/index');
const auth = require('../src/auth');

const dir = tmpDir();
const idp = fakeIdp({ iss: 'http://nookara.test', aud: 'http://chat.test' });
let inst, base, alice, sid, client;

const relay = { on: true, calls: [], pays: new Map(), n: 0 };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, typ) {
  const head = b64({ alg: 'EdDSA', typ, kid: idp.kid }), body = b64(claims);
  return `${head}.${body}.${crypto.sign(null, Buffer.from(head + '.' + body), idp.privateKey).toString('base64url')}`;
}
const iat = () => Math.floor(Date.now() / 1000);
const receipt = p => sign({ iss: 'http://nookara.test', aud: 'http://chat.test', sub: p.user_id, amount: p.amount, ref: p.ref, paid_at: Date.now(), rcp: p.id, iat: iat(), exp: iat() + 3600 }, 'ember-receipt+jwt');
// Nookara's answer after the person agreed on its consent page
const linkToken = (over = {}, typ = 'ember-payment-link+jwt') => sign({ iss: 'http://nookara.test', aud: 'http://chat.test', sub: '777', account: acc(), iat: iat(), exp: iat() + 600, jti: crypto.randomBytes(12).toString('base64url'), ...over }, typ);
async function relayCall(method, path, body) {
  relay.calls.push({ method, path, body });
  if (method === 'POST' && path.endsWith('/pay-request')) {
    const p = { id: 'pr' + ++relay.n, user_id: body.user_id, amount: body.amount, ref: body.ref, status: 'pending' };
    relay.pays.set(p.id, p);
    return { id: p.id, status: p.status, approve_url: `http://nookara.test/payment/${p.id}`, amount: p.amount, expires_at: Date.now() + 30 * 60000 };
  }
  const m = /\/pay-request\/([^/]+)$/.exec(path);
  if (method === 'GET' && m) { const p = relay.pays.get(m[1]); return { id: p.id, status: p.status, amount: p.amount, ref: p.ref, receipt: p.status === 'paid' ? receipt(p) : null }; }
  return {};
}
const back = (state, token) => fetch(`${base}/account/payments/linked?${new URLSearchParams({ state, token })}`, { redirect: 'manual' });
const acc = () => `${alice.user.id}@chat.test`; // the account's full id
const stateOf = url => new URL(url).searchParams.get('state');

test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  auth.setJwksFetcher(idp.jwks);
  client = require('../src/relay/client');
  client.registered = () => relay.on;
  client.call = relayCall;
});
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a local account cannot buy a tier until it links a Nookara account', async () => {
  const r = await api(base).post('/api/v1/auth/register', { username: 'alice', password: 'correct horse battery' });
  alice = { ...r.body, a: api(base, r.body.session) };
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  assert.equal((await alice.a.patch('/api/v2/homeserver/limits', { tiers: [{ id: 'plus', name: 'Plus', limits: { emojis: 5 }, price_credits: 50, period_weeks: 1 }] })).status, 200);
  sid = (await alice.a.post('/api/v1/servers', { name: 'Shop', slug: 'shop' })).body.server.sid;
  const b = await alice.a.post(`/api/v2/servers/${sid}/tier`, { tier: 'plus' });
  assert.deepEqual([b.status, b.body.error, b.body.link_url], [402, 'nookara_link_required', 'http://chat.test/api/v2/account/payments/link']);
  assert.ok(!relay.calls.length, 'nothing was asked of Nookara');
  assert.deepEqual((await alice.a.get('/api/v2/account/payments')).body, { own_nookara_account: false, linked: false, nookara_id: null, linked_at: null, available: true });
});

test('linking: Nookara\'s consent page, its signed answer, the Nookara id kept on the account', async () => {
  assert.equal((await alice.a.post('/api/v2/account/payments/link', { return_to: 'https://evil.example/x' })).body.error, 'invalid_return_to');
  const s = (await alice.a.post('/api/v2/account/payments/link', {})).body;
  const u = new URL(s.url);
  assert.equal(u.origin + u.pathname, 'http://nookara.test/ember/payments/link');
  assert.deepEqual([u.searchParams.get('instance'), u.searchParams.get('account'), u.searchParams.get('return_to')], ['http://chat.test', acc(), 'http://chat.test/account/payments/linked']);
  // a login token, an answer for another account, an unknown state: refused, and nothing kept
  let r = await back(stateOf(s.url), linkToken({}, 'JWT'));
  assert.equal(r.status, 400);
  const s2 = stateOf((await alice.a.post('/api/v2/account/payments/link', {})).body.url);
  assert.equal((await back(s2, linkToken({ account: 'l:99@chat.test' }))).status, 400);
  assert.equal((await back('made-up', linkToken())).status, 400);
  assert.equal((await alice.a.get('/api/v2/account/payments')).body.linked, false);
  // the real answer; the state is used once
  const s3 = stateOf((await alice.a.post('/api/v2/account/payments/link', {})).body.url);
  r = await back(s3, linkToken());
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Nookara account linked/);
  assert.equal((await back(s3, linkToken())).status, 400);
  const v = (await alice.a.get('/api/v2/account/payments')).body;
  assert.deepEqual([v.linked, v.nookara_id, v.own_nookara_account], [true, '777', false]);
  // said no on Nookara's page: nothing changes, the client hears payments_linked=0
  const s5 = (await alice.a.post('/api/v2/account/payments/link', { return_to: 'http://chat.test/' })).body.url;
  r = await fetch(`${base}/account/payments/linked?state=${stateOf(s5)}&error=access_denied`, { redirect: 'manual' });
  assert.deepEqual([r.status, r.headers.get('location')], [302, 'http://chat.test/?payments_linked=0']);
  // with a client to go back to
  const s4 = (await alice.a.post('/api/v2/account/payments/link', { return_to: 'http://chat.test/#/settings' })).body.url;
  r = await back(stateOf(s4), linkToken());
  assert.deepEqual([r.status, r.headers.get('location')], [302, 'http://chat.test/#/settings?payments_linked=1']);
});

test('the purchase asks the linked Nookara account to pay, naming the account; its receipt is checked against it', async () => {
  const b = await alice.a.post(`/api/v2/servers/${sid}/tier`, { tier: 'plus' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const sent = relay.calls.find(c => c.path.endsWith('/pay-request')).body;
  assert.deepEqual([sent.user_id, sent.account, sent.amount], ['777', acc(), 50]);
  relay.pays.get(b.body.pay_request.id).status = 'paid';
  const st = (await alice.a.get(`/api/v2/servers/${sid}/tier`)).body;
  assert.deepEqual([st.status, st.tier], ['paid', 'plus']);
});

test('unlinking: at once here, and Nookara is told', async () => {
  const v = (await alice.a.del('/api/v2/account/payments/link')).body;
  assert.deepEqual([v.linked, v.nookara_id], [false, null]);
  const told = relay.calls.find(c => c.path.endsWith('/payment-link/revoke'));
  assert.deepEqual(told.body, { account: acc(), user_id: '777' });
  assert.equal((await alice.a.del('/api/v2/account/payments/link')).body.error, 'not_linked');
  assert.equal((await alice.a.post(`/api/v2/servers/${sid}/tier`, { tier: 'plus' })).body.error, 'nookara_link_required');
});

test('removed on Nookara: Nookara\'s signed notice ends the link here at once; a pay request Nookara refuses for it does too', async () => {
  const link = async () => { const st = stateOf((await alice.a.post('/api/v2/account/payments/link', {})).body.url); assert.equal((await back(st, linkToken())).status, 200); };
  const notice = (over = {}, typ = 'ember-payment-unlink+jwt') => api(base).post('/api/v2/account/payments/revoked', { token: linkToken(over, typ) });
  await link();
  // a link token is not a notice; a notice for another Nookara account or account changes nothing
  assert.equal((await notice({}, 'ember-payment-link+jwt')).status, 401);
  assert.deepEqual((await notice({ sub: '778' })).body, { ok: true, unlinked: false });
  assert.deepEqual((await notice({ account: 'l:99@chat.test' })).body, { ok: true, unlinked: false });
  assert.equal((await alice.a.get('/api/v2/account/payments')).body.linked, true);
  assert.deepEqual((await notice()).body, { ok: true, unlinked: true });
  assert.equal((await alice.a.get('/api/v2/account/payments')).body.linked, false);
  // Nookara lost its side some other way: the purchase is refused with payment_link_missing, the link goes, the person is asked again
  await link();
  const before = client.call;
  client.call = async (method, path, body) => { if (path.endsWith('/pay-request') && method === 'POST') throw Object.assign(new Error('payment_link_missing'), { code: 'payment_link_missing', status: 403 }); return before(method, path, body); };
  try {
    const r = await alice.a.post(`/api/v2/servers/${sid}/tier`, { tier: 'plus' });
    assert.deepEqual([r.status, r.body.error], [402, 'nookara_link_required']);
    assert.equal((await alice.a.get('/api/v2/account/payments')).body.linked, false);
  } finally { client.call = before; }
});
