'use strict';
// Friends, lookup and profiles between homeservers (PROTOCOL §4c): homeserver A (a real one, in a worker thread) and
// homeserver B (this thread) each keep their own accounts' side and tell the other with signed requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { tmpDir, api, wsClient, startHomeserver, mockHomeserver } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
process.env.EMBER_DEV = '1';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const { startServer } = require('../src/index');
const config = require('../src/config');
const db = require('../src/db');
const s2s = require('../src/social/s2s');
const friendsMod = require('../src/social/friends');

const dirA = tmpDir(), dirB = tmpDir();
let A, B, baseB, alice, amy, bo, bob, bea, mockHs;
const sockets = [];
const PW = 'correct horse battery';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(30); } }
const reg = async (base, n) => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: PW }); assert.equal(r.status, 200, JSON.stringify(r.body)); return { ...r.body, a: api(base, r.body.session) }; };
const friends = async who => (await who.a.get('/api/v2/social/friends')).body;
const ids = list => list.map(x => x.id);
const settle = async () => { await A.call('idle'); await s2s.idle(); };
const ALICE = 'l:1@a.example', BOB = 'l:2@b.example', BEA = 'l:3@b.example';
const enc = encodeURIComponent;

test.before(async () => {
  B = await startServer({ dataDir: dirB, port: 0 });
  baseB = `http://localhost:${B.port}`;
  config.update({ domain: 'b.example', federation: { denylists: [] }, accounts: { remote_accounts: { mode: 'all', list: [] } } });
  bo = await reg(baseB, 'bo');
  assert.equal((await bo.a.post('/api/v1/instance/claim', { code: B.setup.current() })).status, 200);
  bob = await reg(baseB, 'bob'); bea = await reg(baseB, 'bea');
  A = await startHomeserver({ dataDir: dirA, config: { domain: 'a.example', accounts: { remote_accounts: { mode: 'all', list: [] } }, federation: { denylists: [], dev_origins: { 'b.example': baseB } } } });
  alice = await reg(A.url, 'alice');
  assert.equal((await alice.a.post('/api/v1/instance/claim', { code: A.setupCode })).status, 200);
  amy = await reg(A.url, 'amy');
  mockHs = await mockHomeserver('m.example');
  config.update({ federation: { dev_origins: { 'a.example': A.url, 'm.example': mockHs.origin } } });
  s2s._test.setRetry([20, 20]); await A.call('setRetry', [20, 20]);
});
test.after(async () => {
  sockets.forEach(s => s.close());
  await A?.close(); await B?.close(); await mockHs?.close();
  for (const d of [dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
});

test('every homeserver answers a handle lookup for its own accounts', async () => {
  const pub = api(baseB);
  const r = await pub.get('/api/v2/users/lookup?handle=bob');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: BOB, handle: 'bob@b.example', display_name: 'bob', avatar_url: null });
  assert.equal((await pub.get('/api/v2/users/lookup?handle=Bob@B.example')).body.id, BOB);
  assert.deepEqual([(await pub.get('/api/v2/users/lookup?handle=bob@a.example')).status, (await pub.get('/api/v2/users/lookup?handle=bob@a.example')).body.error], [404, 'wrong_homeserver']);
  assert.equal((await pub.get('/api/v2/users/lookup?handle=nobody')).body.error, 'user_not_found');
  assert.equal((await pub.get('/api/v2/users/lookup')).status, 404);
});

test('two accounts of one homeserver become friends without any server-to-server request', async () => {
  config.update({ accounts: { remote_accounts: { mode: 'none', list: [] } } }); // nothing may leave or come in
  let r = await bob.a.post('/api/v2/social/friends', { handle: 'bea', message: 'hi bea' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pending'); assert.equal(r.body.friend.id, BEA);
  assert.deepEqual(ids((await friends(bob)).outgoing), [BEA]);
  const inc = (await friends(bea)).incoming;
  assert.deepEqual([inc[0].id, inc[0].handle, inc[0].display_name, inc[0].message], [BOB, 'bob@b.example', 'bob', 'hi bea']);
  assert.equal((await bob.a.post('/api/v2/social/friends', { handle: 'bea' })).body.status, 'pending'); // asking twice changes nothing
  assert.equal((await bob.a.post(`/api/v2/social/friends/${enc(BEA)}/accept`)).body.error, 'no_request'); // not his to accept
  r = await bea.a.post(`/api/v2/social/friends/${enc(BOB)}/accept`);
  assert.equal(r.body.status, 'friends');
  assert.deepEqual(ids((await friends(bob)).friends), [BEA]);
  assert.deepEqual(ids((await friends(bea)).friends), [BOB]);
  assert.deepEqual((await friends(bea)).incoming, []);
  assert.equal((await bob.a.post('/api/v2/social/friends', { handle: 'bob' })).body.error, 'cannot_friend_yourself');
  assert.equal((await bob.a.post('/api/v2/social/friends', { handle: 'nobody' })).body.error, 'user_not_found');
  // unfriending takes both sides away
  assert.equal((await bob.a.del(`/api/v2/social/friends/${enc(BEA)}`)).status, 200);
  assert.deepEqual((await friends(bea)).friends, []);
  assert.equal((await bob.a.del(`/api/v2/social/friends/${enc(BEA)}`)).body.error, 'not_friends');
  // asking someone who already asked you makes you friends
  await bob.a.post('/api/v2/social/friends', { handle: 'bea' });
  assert.equal((await bea.a.post('/api/v2/social/friends', { id: 'l:2' })).body.status, 'friends');
  // a block ends it and refuses new requests until it is lifted
  r = await bea.a.post(`/api/v2/social/blocks/${enc(BOB)}`);
  assert.deepEqual(ids(r.body.blocked), [BOB]);
  assert.deepEqual((await friends(bob)).friends, []);
  assert.deepEqual((await friends(bob)).blocked, []); // he is not told
  assert.deepEqual([(await bob.a.post('/api/v2/social/friends', { handle: 'bea' })).status, (await bob.a.post('/api/v2/social/friends', { handle: 'bea' })).body.error], [403, 'blocked']);
  assert.equal((await bea.a.post('/api/v2/social/friends', { handle: 'bob' })).body.error, 'user_blocked');
  assert.equal((await bea.a.del(`/api/v2/social/blocks/${enc(BOB)}`)).status, 200);
  assert.equal((await bea.a.del(`/api/v2/social/blocks/${enc(BOB)}`)).body.error, 'not_blocked');
  friendsMod._test.requestLimit.reset();
  assert.equal((await bob.a.post('/api/v2/social/friends', { handle: 'bea' })).body.status, 'pending');
  assert.equal((await bea.a.post(`/api/v2/social/friends/${enc(BOB)}/accept`)).body.status, 'friends');
  // an account of another homeserver cannot be asked while none is let in
  assert.equal((await bob.a.post('/api/v2/social/friends', { handle: 'alice@a.example' })).body.error, 'remote_accounts_off');
  config.update({ accounts: { remote_accounts: { mode: 'all', list: [] } } });
});

test('a friend request crosses to the other homeserver and is accepted there', async () => {
  const bobWs = await wsClient(baseB).login(bob.session); sockets.push(bobWs);
  let r = await alice.a.post('/api/v2/social/friends', { handle: 'bob@b.example', message: 'hello from a' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pending');
  assert.deepEqual(r.body.friend, { id: BOB, handle: 'bob@b.example', display_name: 'bob', avatar_url: null });
  assert.deepEqual(ids((await friends(alice)).outgoing), [BOB]);
  await bobWs.waitFor(f => f.type === 'social_friends_update');
  // B asks A who that is, in the background
  const inc = await until(async () => { const x = (await friends(bob)).incoming; return x[0]?.handle ? x : null; });
  assert.deepEqual([inc[0].id, inc[0].handle, inc[0].display_name, inc[0].message], [ALICE, 'alice@a.example', 'alice', 'hello from a']);
  r = await bob.a.post(`/api/v2/social/friends/${enc(ALICE)}/accept`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'friends');
  assert.deepEqual(ids((await friends(alice)).friends), [BOB]);
  assert.ok(ids((await friends(bob)).friends).includes(ALICE));
  assert.equal((await alice.a.post('/api/v2/social/friends', { handle: 'nobody@b.example' })).body.error, 'user_not_found');
  assert.equal((await alice.a.post('/api/v2/social/friends', { handle: 'x@nowhere.invalid' })).status, 502);
});

test('a homeserver can only speak for its own accounts', async () => {
  let r = await mockHs.s2s(baseB, 'POST', '/friend_request', { from: ALICE, to: BEA });
  assert.deepEqual([r.status, r.body.error], [403, 'from_mismatch']);
  assert.deepEqual((await friends(bea)).incoming, []);
  r = await mockHs.s2s(baseB, 'POST', '/friend_accept', { from: 'l:9@m.example', to: BEA });
  assert.deepEqual([r.status, r.body.error], [409, 'no_request']); // nobody asked them
  r = await mockHs.s2s(baseB, 'POST', '/friend_request', { from: 'l:9@m.example', to: 'l:99@b.example' });
  assert.deepEqual([r.status, r.body.error], [404, 'user_not_found']);
  r = await mockHs.s2s(baseB, 'POST', '/friend_request', { from: 'l:9@m.example', to: 'l:3@elsewhere.example' });
  assert.equal(r.status, 404);
  r = await mockHs.s2s(baseB, 'POST', '/friend_request', { from: 'l:9@m.example', to: BEA, message: 'x'.repeat(500) });
  assert.deepEqual([r.status, r.body.status], [200, 'pending']);
  const inc = (await friends(bea)).incoming.find(x => x.id === 'l:9@m.example');
  assert.equal(inc.message.length, 200);
  config.update({ federation: { deny: ['l:9@m.example'] } }); // one account on the deny list
  r = await mockHs.s2s(baseB, 'POST', '/friend_request', { from: 'l:9@m.example', to: BOB });
  assert.deepEqual([r.status, r.body.error], [403, 'homeserver_denied']);
  config.update({ federation: { deny: [] } });
  assert.equal((await bea.a.del(`/api/v2/social/friends/${enc('l:9@m.example')}`)).status, 200); // turned down
});

test('profiles of accounts elsewhere are fetched over s2s and kept for ten minutes', async () => {
  assert.equal((await alice.a.patch('/api/v1/me/profile', { display_name: 'Alice A', bio: 'first bio', pronouns: 'she/her' })).status, 200);
  db.run('DELETE FROM social_cache'); // (the friend request already made B ask once)
  let r = await bob.a.get(`/api/v2/social/profile/${enc(ALICE)}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.profile;
  assert.deepEqual([p.id, p.handle, p.display_name, p.bio, p.pronouns, p.avatar_url], [ALICE, 'alice@a.example', 'Alice A', 'first bio', 'she/her', null]);
  assert.equal(p.presence.status, 'offline');
  assert.ok(p.updated_at > 0);
  await alice.a.patch('/api/v1/me/profile', { bio: 'second bio' });
  assert.equal((await bob.a.get(`/api/v2/social/profile/${enc(ALICE)}`)).body.profile.bio, 'first bio'); // still the copy
  db.run("UPDATE social_cache SET fetched_at = fetched_at - ? WHERE id = ?", 11 * 60 * 1000, ALICE);
  assert.equal((await bob.a.get(`/api/v2/social/profile/${enc(ALICE)}`)).body.profile.bio, 'second bio');
  assert.equal((await friends(bob)).friends.find(f => f.id === ALICE).display_name, 'Alice A'); // lists use the same copy
  // a local profile, by either form of the id
  r = await bob.a.get('/api/v2/social/profile/l:3');
  assert.deepEqual([r.body.profile.id, r.body.profile.handle], [BEA, 'bea@b.example']);
  assert.equal((await bob.a.get(`/api/v2/social/profile/${enc('l:77@a.example')}`)).body.error, 'user_not_found');
  assert.equal((await bob.a.get('/api/v2/social/profile/l:77')).status, 404);
  // the s2s shape itself, asked by a homeserver nobody here is friends with: no presence
  const raw = await mockHs.s2s(baseB, 'GET', '/profile/' + enc(BOB));
  assert.equal(raw.status, 200);
  assert.deepEqual(Object.keys(raw.body).sort(), ['avatar_url', 'banner_url', 'bio', 'color', 'display_name', 'handle', 'id', 'presence', 'pronouns', 'updated_at']);
  assert.deepEqual(raw.body.presence, { status: 'offline' }); // bob is connected, but that is for his friends
});

test('friends see each other connect, across homeservers', async () => {
  const bobWs = await wsClient(baseB).login(bob.session); sockets.push(bobWs);
  const aliceWs = await wsClient(A.url).login(alice.session); sockets.push(aliceWs);
  const ev = await bobWs.waitFor(f => f.type === 'social_presence' && f.id === ALICE, 6000);
  assert.equal(ev.status, 'online');
  db.run("UPDATE social_cache SET fetched_at = 0 WHERE id = ?", ALICE);
  assert.equal((await bob.a.get(`/api/v2/social/profile/${enc(ALICE)}`)).body.profile.presence.status, 'online');
  // amy is nobody's friend on B: her homeserver does not say whether she is connected... and bob's is shown to alice only
  assert.equal((await alice.a.get(`/api/v2/social/profile/${enc(BOB)}`)).body.profile.presence.status, 'online');
  assert.equal((await amy.a.get(`/api/v2/social/profile/${enc(BEA)}`)).body.profile.presence.status, 'offline');
});

test('unfriending and blocking reach the other homeserver', async () => {
  assert.equal((await alice.a.del(`/api/v2/social/friends/${enc(BOB)}`)).status, 200);
  await settle();
  assert.ok(!ids((await friends(bob)).friends).includes(ALICE));
  // friends again, then bob blocks alice
  assert.equal((await bob.a.post('/api/v2/social/friends', { id: ALICE })).body.status, 'pending');
  assert.equal((await alice.a.post('/api/v2/social/friends', { handle: 'bob@b.example' })).body.status, 'friends'); // she had a request from him
  assert.ok(ids((await friends(bob)).friends).includes(ALICE));
  assert.equal((await bob.a.post(`/api/v2/social/blocks/${enc(ALICE)}`)).status, 200);
  await settle();
  assert.deepEqual((await friends(alice)).friends, []);
  assert.deepEqual((await friends(alice)).blocked, []);
  let r = await alice.a.post('/api/v2/social/friends', { handle: 'bob@b.example' });
  assert.deepEqual([r.status, r.body.error], [403, 'blocked']); // her own homeserver already knows
  await A.call('sql', { query: 'DELETE FROM friends' }); // even if it forgot, B refuses
  r = await alice.a.post('/api/v2/social/friends', { handle: 'bob@b.example' });
  assert.deepEqual([r.status, r.body.error], [403, 'blocked']);
  assert.equal((await bob.a.del(`/api/v2/social/blocks/${enc(ALICE)}`)).status, 200);
  await settle();
  r = await alice.a.post('/api/v2/social/friends', { handle: 'bob@b.example' });
  assert.equal(r.body.status, 'pending');
  assert.equal((await bob.a.post(`/api/v2/social/friends/${enc(ALICE)}/accept`)).body.status, 'friends');
  assert.deepEqual(ids((await friends(alice)).friends), [BOB]);
});

// ---------- keys ----------
const newKey = (kid, kind = 'device') => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); return { kid, kind, alg: 'ed25519', public_key: publicKey.export({ format: 'jwk' }).x, privateKey }; };
const pub = ({ privateKey, ...k }) => k;
const signedBy = (owner, k, signer) => ({ ...pub(k), signed_by: signer.kid, sig: crypto.sign(null, Buffer.from(['ember-key-v1', owner, k.kid, k.kind, k.alg, k.public_key].join('\n')), signer.privateKey).toString('base64url') });

test('an account publishes its public keys; changes must be signed along the chain', async () => {
  const acct = newKey('acct-1', 'account'), phone = newKey('phone'), laptop = newKey('laptop');
  const put = keys => alice.a.put('/api/v2/social/keys', { keys });
  assert.deepEqual((await alice.a.get('/api/v2/social/keys/l:1')).body, { id: ALICE, keys: [] });
  assert.equal((await put([pub(phone)])).body.error, 'account_key_required');
  assert.equal((await put([{ ...pub(acct), public_key: 'short' }])).body.error, 'invalid_keys');
  assert.equal((await put([pub(acct), pub(acct)])).body.error, 'invalid_keys'); // one kid, twice
  // a device key has to be signed by the account key, from the first set on
  let r = await put([pub(acct), pub(phone)]);
  assert.deepEqual([r.status, r.body.error, r.body.signed_by], [403, 'key_signature_required', 'acct-1']);
  r = await put([pub(acct), signedBy(ALICE, phone, phone)]);
  assert.equal(r.body.error, 'key_signature_required'); // signed by something else
  r = await put([pub(acct), { ...signedBy(ALICE, phone, laptop), signed_by: 'acct-1' }]);
  assert.deepEqual([r.status, r.body.error], [403, 'bad_key_signature']);
  r = await put([pub(acct), signedBy('l:2@a.example', phone, acct)]); // signed for another account
  assert.equal(r.body.error, 'bad_key_signature');
  r = await put([pub(acct), signedBy(ALICE, phone, acct)]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.id, ALICE);
  assert.deepEqual(r.body.keys.map(k => [k.kid, k.kind, k.signed_by || null]), [['acct-1', 'account', null], ['phone', 'device', 'acct-1']]);
  assert.ok(r.body.keys[0].created_at > 0);
  assert.equal(r.body.keys[0].public_key, acct.public_key);
  // another homeserver reads them over s2s, and keeps its copy for ten minutes
  let seenByBob = (await bob.a.get(`/api/v2/social/keys/${enc(ALICE)}`)).body;
  assert.deepEqual(seenByBob, r.body);
  // a new account key without the old one's signature is refused; so is one signed by the wrong key
  const acct2 = newKey('acct-2', 'account');
  r = await put([pub(acct2)]);
  assert.deepEqual([r.status, r.body.error, r.body.signed_by], [403, 'key_signature_required', 'acct-1']);
  r = await put([signedBy(ALICE, acct2, acct2)]);
  assert.equal(r.body.error, 'key_signature_required');
  r = await put([{ ...signedBy(ALICE, acct2, laptop), signed_by: 'acct-1' }]);
  assert.equal(r.body.error, 'bad_key_signature');
  // the same kid with other bytes is a new key too
  r = await put([{ ...pub(acct2), kid: 'acct-1' }]);
  assert.equal(r.body.error, 'key_signature_required');
  assert.equal((await alice.a.get('/api/v2/social/keys/l:1')).body.keys[0].public_key, acct.public_key); // nothing changed
  // signed by the key it replaces: accepted, the signature is published; devices are signed by the new account key
  r = await put([signedBy(ALICE, acct2, acct), signedBy(ALICE, phone, acct)]);
  assert.equal(r.body.error, 'key_signature_required'); // the phone is still signed by the old account key
  r = await put([signedBy(ALICE, acct2, acct), signedBy(ALICE, phone, acct2), signedBy(ALICE, laptop, acct2)]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.keys.map(k => [k.kid, k.signed_by]), [['acct-2', 'acct-1'], ['phone', 'acct-2'], ['laptop', 'acct-2']]);
  assert.match(r.body.keys[0].sig, /^[A-Za-z0-9_-]{86}$/);
  // sending the unchanged account key again (no signature needed) keeps its place in the chain; a device can go
  r = await put([pub(acct2), signedBy(ALICE, laptop, acct2)]);
  assert.deepEqual(r.body.keys.map(k => [k.kid, k.signed_by]), [['acct-2', 'acct-1'], ['laptop', 'acct-2']]);
  assert.equal((await bob.a.get(`/api/v2/social/keys/${enc(ALICE)}`)).body.keys[0].kid, 'acct-1'); // B still has its copy
  db.run("UPDATE social_cache SET fetched_at = fetched_at - ? WHERE kind = 'keys'", 11 * 60 * 1000);
  seenByBob = (await bob.a.get(`/api/v2/social/keys/${enc(ALICE)}`)).body;
  assert.deepEqual(seenByBob, r.body);
  assert.equal((await bob.a.get(`/api/v2/social/keys/${enc('l:77@a.example')}`)).body.error, 'user_not_found');
  const raw = await mockHs.s2s(baseB, 'GET', '/keys/' + enc(BOB));
  assert.deepEqual(raw.body, { id: BOB, keys: [] });
  assert.equal((await mockHs.s2s(baseB, 'GET', '/keys/' + enc('l:99@b.example'))).status, 404);
});
