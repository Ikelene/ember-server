'use strict';
// Signed server-to-server requests (PROTOCOL §4c): a stand-in homeserver signs requests with keys the test holds, this
// homeserver checks them against the keys that homeserver publishes and applies the rules of §4b to the sender.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api, mockHomeserver } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
process.env.EMBER_DEV = '1';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const { startServer } = require('../src/index');
const config = require('../src/config');
const resolve = require('../src/federation/resolve');
const seen = require('../src/federation/seen');
const limits = require('../src/federation/limits');

const dir = tmpDir();
let B, base, bo;
const mocks = [];
async function mock(domain, { known = true } = {}) {
  const hs = await mockHomeserver(domain);
  mocks.push(hs);
  if (known) config.update({ federation: { dev_origins: { ...config.get().federation.dev_origins, [domain]: hs.origin } } });
  return hs;
}
const accept = (mode, list = []) => config.update({ accounts: { remote_accounts: { mode, list } } });

test.before(async () => {
  B = await startServer({ dataDir: dir, port: 0 });
  base = `http://localhost:${B.port}`;
  config.update({ domain: 'b.example', federation: { denylists: [] } });
  const r = await api(base).post('/api/v1/auth/register', { username: 'bo', password: 'correct horse battery' });
  bo = { ...r.body, a: api(base, r.body.session) };
  await bo.a.post('/api/v1/instance/claim', { code: B.setup.current() });
  accept('all');
  resolve._test.setAddresses(() => ['198.51.100.7']);
});
test.after(async () => {
  resolve._test.setAddresses(null);
  await B?.close();
  for (const m of mocks) await m.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('discovery says where the social api lives', async () => {
  const d = (await api(base).get('/.well-known/ember')).body;
  assert.deepEqual(d.social, { api_url: `${d.public_url}/api/v2`, s2s_url: `${d.public_url}/_ember/s2s/v1` });
});

test('a signed request is accepted and its homeserver is recorded as seen', async () => {
  const hs = await mock('good.example');
  assert.equal(seen.row('good.example'), null);
  const r = await hs.s2s(base, 'POST', '/ping', { hello: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, homeserver: 'b.example', you: 'good.example' });
  assert.equal(seen.row('good.example').origin, hs.origin);
  assert.equal(hs.jwksFetches, 1);
  assert.equal((await hs.s2s(base, 'POST', '/ping')).status, 200); // no body: the digest of nothing
  assert.equal(hs.jwksFetches, 1); // the keys are cached
});

test('no signature, a broken header and a name that does not match are refused', async () => {
  const hs = await mock('hdr.example');
  assert.equal((await api(base).post('/_ember/s2s/v1/ping', {})).body.error, 'invalid_signature_header');
  const bad = await fetch(base + '/_ember/s2s/v1/ping', { method: 'POST', headers: { 'Ember-Signature': 'keyId="hdr.example", created=1, sig="x"' } });
  assert.equal(bad.status, 401);
  const r = await hs.s2s(base, 'POST', '/ping', {}, { headers: { 'X-Ember-Homeserver': 'other.example' } });
  assert.deepEqual([r.status, r.body.error], [401, 'homeserver_mismatch']);
});

test('a signature over other bytes, another path or another host does not verify', async () => {
  const hs = await mock('sig.example');
  let r = await hs.s2s(base, 'POST', '/ping', { a: 1 }, { sendBody: '{"a":2}' });
  assert.deepEqual([r.status, r.body.error], [401, 'invalid_signature']);
  r = await hs.s2s(base, 'POST', '/ping', { a: 1 }, { target: '/_ember/s2s/v1/other' });
  assert.equal(r.body.error, 'invalid_signature');
  r = await hs.s2s(base, 'POST', '/ping', { a: 1 }, { host: 'c.example' }); // signed for another homeserver
  assert.equal(r.body.error, 'invalid_signature');
  const other = await mock('thief.example');
  r = await hs.s2s(base, 'POST', '/ping', { a: 1 }, { key: other.keys[0] }); // another homeserver's key under this one's name
  assert.equal(r.body.error, 'invalid_signature');
});

test('a stale signature and one from the future are refused', async () => {
  const hs = await mock('time.example'), t = Math.floor(Date.now() / 1000);
  for (const created of [t - 301, t + 61 + 5]) {
    const r = await hs.s2s(base, 'POST', '/ping', {}, { created });
    assert.deepEqual([r.status, r.body.error], [401, 'signature_expired']);
  }
  assert.equal((await hs.s2s(base, 'POST', '/ping', {}, { created: t - 200 })).status, 200);
  assert.equal((await hs.s2s(base, 'POST', '/ping', {}, { created: t + 30 })).status, 200);
});

test('an unknown key id fetches the keys again, at most once a minute', async () => {
  const hs = await mock('rotate.example');
  assert.equal((await hs.s2s(base, 'POST', '/ping')).status, 200);
  assert.equal(hs.jwksFetches, 1);
  const k2 = hs.addKey('k2');
  resolve._test.ageJwks(hs.origin, 61 * 1000);
  assert.equal((await hs.s2s(base, 'POST', '/ping', {}, { key: k2 })).status, 200); // the rotated key is picked up
  assert.equal(hs.jwksFetches, 2);
  const fake = { kid: 'made-up', privateKey: k2.privateKey };
  const r = await hs.s2s(base, 'POST', '/ping', {}, { key: fake });
  assert.deepEqual([r.status, r.body.error], [401, 'unknown_kid']);
  assert.equal(hs.jwksFetches, 2); // (a made-up kid cannot make us fetch again right away)
});

test('a denied homeserver is refused before anything is fetched; so is one that is not let in', async () => {
  const hs = await mock('denied.example');
  config.update({ federation: { deny: ['denied.example'] } });
  let r = await hs.s2s(base, 'POST', '/ping');
  assert.deepEqual([r.status, r.body.error], [403, 'homeserver_denied']);
  assert.equal(hs.discoveryFetches, 0);
  config.update({ federation: { deny: ['198.51.100.0/24'] } }); // the network it answers from
  r = await hs.s2s(base, 'POST', '/ping');
  assert.deepEqual([r.status, r.body.error], [403, 'homeserver_denied']);
  config.update({ federation: { deny: [] } });
  accept('allowlist', ['friend.example']);
  r = await hs.s2s(base, 'POST', '/ping');
  assert.deepEqual([r.status, r.body.error], [403, 'homeserver_not_allowed']);
  accept('none');
  assert.equal((await hs.s2s(base, 'POST', '/ping')).body.error, 'remote_accounts_off');
  accept('all');
  assert.equal((await hs.s2s(base, 'POST', '/ping')).status, 200);
  const me = await mock('b.example', { known: false });
  assert.equal((await me.s2s(base, 'POST', '/ping')).body.error, 'own_homeserver');
});

test('requests are counted per homeserver', async () => {
  const hs = await mock('busy.example');
  assert.equal((await hs.s2s(base, 'POST', '/ping')).status, 200);
  for (const k of ['busy.example', 'd:busy.example', 'n:198.51.100.0/24']) seen._test.age(k, 40 * seen.DAY); // not a new homeserver any more
  config.update({ federation: { rate_limits: { s2s_per_minute: 8 } } });
  limits.reset();
  for (let i = 0; i < 8; i++) assert.equal((await hs.s2s(base, 'POST', '/ping')).status, 200);
  const r = await hs.s2s(base, 'POST', '/ping');
  assert.deepEqual([r.status, r.body.error], [429, 'homeserver_rate_limited']);
  assert.ok(r.body.retry_after > 0);
  config.update({ federation: { rate_limits: { s2s_per_minute: 600 } } });
  limits.reset();
});
