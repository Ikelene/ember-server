'use strict';
// Friends, lookup and profiles between homeservers (PROTOCOL §4c): homeserver A (a real one, in a worker thread) and
// homeserver B (this thread) each keep their own accounts' side and tell the other with signed requests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const nodeCrypto = require('crypto');
const nke1 = require('./nke1');
const { tmpDir, api, wsClient, startHomeserver, mockHomeserver } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
process.env.EMBER_DEV = '1';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const { startServer } = require('../src/index');
const config = require('../src/config');
const db = require('../src/db');
const s2s = require('../src/social/s2s');
const friendsMod = require('../src/social/friends');
const keysMod = require('../src/social/keys');

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
// (the home API that publishes them: social-e2ee.test.js)
test('the key document of an account goes between homeservers unchanged', async () => {
  assert.deepEqual((await alice.a.get('/api/v2/social/keys/l:1')).body, { id: ALICE, keys: [] });
  // the old key chain is gone
  let r = await alice.a.put('/api/v2/social/keys', { keys: [] });
  assert.deepEqual([r.status, r.body.error], [410, 'use_e2ee_api']);
  // alice makes her keys on A, with one linked client and one that was revoked
  const acct = nke1.account(), phone = nke1.account(), old = nke1.account();
  r = await alice.a.post('/api/v2/social/e2ee', { enc_pub: acct.enc_pub, sig_pub: acct.sig_pub, passcode: nke1.passcode(), recovery: nke1.recovery() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const signed = nke1.clientsDoc(ALICE, acct, 2, [{ ...phone, label: 'Phone, the "new" one; ok', app: 'app:1', added_at: 5 }, { ...old, label: 'Old', added_at: 1, revoked_at: 9 }]);
  assert.equal((await alice.a.put('/api/v2/social/e2ee/clients', { doc: signed.doc, sig: signed.sig })).status, 200);
  const mine = (await alice.a.get('/api/v2/social/keys/l:1')).body;
  assert.deepEqual(Object.keys(mine), ['id', 'format', 'owner', 'keys', 'clients', 'clients_sig', 'clients_seq', 'past']);
  assert.deepEqual([mine.id, mine.format, mine.owner, mine.clients_seq, mine.clients_sig, mine.past], [ALICE, 'nke1', ALICE, 2, signed.sig, []]);
  assert.deepEqual(mine.keys.map(k => [k.kid, k.kind, k.alg, k.public_key, k.enc_public_key]), [[acct.kid, 'account', 'p256', acct.sig_pub, acct.enc_pub]]);
  assert.ok(mine.keys[0].created_at > 0);
  assert.deepEqual(mine.clients, signed.doc);
  // another homeserver reads it over s2s: the same document, and a reader there can check the list's signature
  let seenByBob = (await bob.a.get(`/api/v2/social/keys/${enc(ALICE)}`)).body;
  assert.deepEqual(seenByBob, mine);
  assert.ok(nodeCrypto.verify('sha256', Buffer.from(signed.text), { key: nodeCrypto.createPublicKey({ key: Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), Buffer.from(seenByBob.keys[0].public_key, 'base64url')]), format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(seenByBob.clients_sig, 'base64url')));
  // B keeps its copy for ten minutes; ?fresh=1 asks again
  const acct2 = nke1.account();
  r = await alice.a.post('/api/v2/social/e2ee', { enc_pub: acct2.enc_pub, sig_pub: acct2.sig_pub, passcode: nke1.passcode(), recovery: nke1.recovery(), replace: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await bob.a.get(`/api/v2/social/keys/${enc(ALICE)}`)).body.keys[0].kid, acct.kid);
  seenByBob = (await bob.a.get(`/api/v2/social/keys/${enc(ALICE)}?fresh=1`)).body;
  assert.equal(seenByBob.keys[0].kid, acct2.kid);
  assert.deepEqual([seenByBob.past, seenByBob.clients, seenByBob.clients_sig], [[{ kid: acct.kid, sig_pub: acct.sig_pub }], { seq: 0, list: [] }, null]); // the replaced key, public half; its clients are gone
  db.run("UPDATE social_cache SET fetched_at = fetched_at - ? WHERE kind = 'keys'", 11 * 60 * 1000);
  assert.deepEqual((await bob.a.get(`/api/v2/social/keys/${enc(ALICE)}`)).body, (await alice.a.get('/api/v2/social/keys/l:1')).body);
  assert.equal((await bob.a.get(`/api/v2/social/keys/${enc('l:77@a.example')}`)).body.error, 'user_not_found');
  const raw = await mockHs.s2s(baseB, 'GET', '/keys/' + enc(BOB));
  assert.deepEqual(raw.body, { id: BOB, keys: [] });
  assert.equal((await mockHs.s2s(baseB, 'GET', '/keys/' + enc('l:99@b.example'))).status, 404);
});

test('a document shaped like Nookara\'s passes through as it is; a broken one is refused', async () => {
  // what Nookara publishes for account 5: the owner its signatures use is the bare number, and there are fields this server does not know
  const N = 'v:5@m.example', acct = nke1.account(), app = nke1.account(), gone = nke1.account(), before = nke1.account();
  const signed = nke1.clientsDoc('5', acct, 7, [{ ...app, label: 'Canopy', app: '12', added_at: 1764200000000 }, { ...gone, label: 'Old app', app: 'project:x', added_at: 1764100000000, revoked_at: 1764150000000 }]);
  const doc = {
    id: N, format: 'nke1', owner: '5',
    keys: [{ kid: acct.kid, kind: 'account', alg: 'p256', public_key: acct.sig_pub, enc_public_key: acct.enc_pub, created_at: 1764000000000, future_field: { a: 1 } },
      { kid: app.kid, kind: 'device', alg: 'p256', public_key: app.sig_pub, enc_public_key: app.enc_pub, created_at: 1764200000000, signed_by: acct.kid }],
    clients: signed.doc, clients_sig: signed.sig, clients_seq: 7, past: [{ kid: before.kid, sig_pub: before.sig_pub }], v: 1, something_new: 'kept',
  };
  let served = doc;
  mockHs.handle = (req, res) => { res.writeHead(served ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(served || { error: 'user_not_found' })); };
  const get = async (fresh = true) => { keysMod._test.freshLimit.reset(); return bob.a.get(`/api/v2/social/keys/${enc(N)}${fresh ? '?fresh=1' : ''}`); };
  let r = await get();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, doc);
  assert.equal(JSON.stringify(r.body), JSON.stringify(doc)); // field for field, in its order
  assert.deepEqual(keysMod.cleanRemote(doc, N), doc);
  // not this format, or no keys yet: no keys
  assert.deepEqual(keysMod.cleanRemote({ id: N, keys: [{ kid: 'k1', kind: 'account', alg: 'ed25519', public_key: 'x'.repeat(43) }] }, N), { id: N, keys: [] });
  assert.deepEqual(keysMod.cleanRemote({ id: N, format: 'nke1', keys: [] }, N), { id: N, keys: [] });
  // broken documents are refused whole, never cut down
  const bad = [
    { ...doc, id: 'v:6@m.example' },
    { ...doc, owner: '6' }, { ...doc, owner: 'v:5@other.example' }, { ...doc, owner: undefined },
    { ...doc, keys: [{ ...doc.keys[0], public_key: acct.sig_pub.slice(1) }] },
    { ...doc, keys: [{ ...doc.keys[0], enc_public_key: 'A' + acct.enc_pub.slice(1) }] }, // not an uncompressed point
    { ...doc, keys: [{ ...doc.keys[0], alg: 'ed25519' }] },
    { ...doc, keys: [doc.keys[0], { ...doc.keys[0] }] }, // two account keys
    { ...doc, keys: [doc.keys[1]] },                     // none
    { ...doc, clients: { seq: 7, list: [{ ...signed.doc.list[0], label: 'x'.repeat(121) }] } },
    { ...doc, clients: { seq: 7, list: Array(201).fill(signed.doc.list[0]) } },
    { ...doc, clients: { seq: -1, list: [] } },
    { ...doc, clients_sig: 'short' }, { ...doc, clients_sig: null },
    { ...doc, past: Array(21).fill(doc.past[0]) },
    { ...doc, past: [{ kid: before.kid }] },
  ];
  for (const d of bad) assert.equal(keysMod.cleanRemote(d, N), null, JSON.stringify(d).slice(0, 120));
  // while its homeserver sends a broken one, the copy from before is served, marked stale
  served = bad[1];
  r = await get();
  assert.deepEqual(r.body, { ...doc, stale: true });
  db.run("DELETE FROM social_cache WHERE kind = 'keys' AND id = ?", N);
  r = await get(false);
  assert.deepEqual([r.status, r.body.error, r.body.reason], [502, 'homeserver_unreachable', 'bad_keys']);
  served = null;
  assert.equal((await get()).body.error, 'user_not_found');
  mockHs.handle = null;
});
