'use strict';
// End-to-end encrypted DMs (PROTOCOL §4d). The home role: an account's keys, their locked backups and device links
// (/api/v2/social/e2ee). The host role: a DM takes sealed envelopes and nothing readable. Reports: the reporter hands
// over one message's key, to the homeserver of whoever sent it. Homeserver A runs in a worker thread, B in this one;
// the "clients" here do the real crypto (test/nke1.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { tmpDir, api, wsClient, startHomeserver } = require('./helpers');
const nke1 = require('./nke1');

process.env.EMBER_ACCOUNTS_MODE = 'local';
process.env.EMBER_DEV = '1';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const { startServer } = require('../src/index');
const config = require('../src/config');
const db = require('../src/db');
const s2s = require('../src/social/s2s');
const E = require('../src/social/e2ee');
const reports = require('../src/social/reports');
const keysMod = require('../src/social/keys');
const fedLimits = require('../src/federation/limits');
const messages = require('../src/messages');

const dirA = tmpDir(), dirB = tmpDir();
let A, B, baseB, alice, bo, bob, bea, al, local, cross, lobby;
const K = {}; // each account's key pair, as its clients hold it
const sockets = [];
const PW = 'correct horse battery';
const ALICE = 'l:1@a.example', BO = 'l:1@b.example', BOB = 'l:2@b.example', BEA = 'l:3@b.example';
const enc = encodeURIComponent;
const reg = async (base, n) => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: PW }); assert.equal(r.status, 200, JSON.stringify(r.body)); return { ...r.body, a: api(base, r.body.session) }; };
const e2 = p => '/api/v2/social/e2ee' + p;
const setup = (who, acct, over = {}) => who.a.post(e2(''), { enc_pub: acct.enc_pub, sig_pub: acct.sig_pub, passcode: nke1.passcode(), recovery: nke1.recovery(), ...over });
const post = (who, cid, body) => { messages._sendLimit.reset(); return who.a.post(`/api/v1/channels/${cid}/messages`, body); };
// alice (an account of A) signed in on B
async function onB(who) {
  const t = await who.a.post('/api/v2/auth/remote-token', { audience: baseB });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const r = await api(baseB).post('/api/v2/auth/remote', { token: t.body.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { session: r.body.access_token, a: api(baseB, r.body.access_token) };
}
async function onA(who) {
  const t = await who.a.post('/api/v2/auth/remote-token', { audience: A.url });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const r = await api(A.url).post('/api/v2/auth/remote', { token: t.body.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { session: r.body.access_token, a: api(A.url, r.body.access_token) };
}

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
  config.update({ federation: { dev_origins: { 'a.example': A.url } } });
  s2s._test.setRetry([20, 20]); await A.call('setRetry', [20, 20]);
  for (const who of [alice, bea]) assert.equal((await who.a.patch('/api/v1/settings', { dm_from: 'anyone' })).status, 200);
  al = await onB(alice);
  lobby = (await bo.a.post('/api/v1/servers', { name: 'Lobby', join_policy: 'open' })).body.server;
});
test.after(async () => {
  sockets.forEach(s => s.close());
  await A?.close(); await B?.close();
  for (const d of [dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
});

// ---------- home ----------
test('an account makes its keys: locked with a passphrase and a recovery code, never a PIN', async () => {
  K.bob = nke1.account();
  let r = await bob.a.get(e2('/me'));
  assert.deepEqual(r.body, { id: BOB, owner: BOB, passcode_rules: { kinds: ['passphrase'], min_length: 12, argon2id: { m: 65536, t: 3, p: 1 } }, has: false });
  assert.equal((await setup(bob, { enc_pub: 'nope', sig_pub: K.bob.sig_pub })).body.error, 'bad_key');
  assert.equal((await setup(bob, { enc_pub: K.bob.enc_pub, sig_pub: K.bob.sig_pub.slice(0, 43) })).body.error, 'bad_key');
  // a PIN is refused, however the client words it; so is not saying what it is
  for (const passcode of [nke1.passcode({ type: 'pin', secret_kind: undefined }), nke1.passcode({ secret_kind: 'pin' }), nke1.passcode({ type: 'pin', secret_kind: 'passphrase' }), nke1.passcode({ type: undefined, secret_kind: undefined })]) {
    r = await setup(bob, K.bob, { passcode });
    assert.deepEqual([r.status, r.body.error, r.body.min_length, r.body.kinds], [400, 'passphrase_required', 12, ['passphrase']], JSON.stringify(passcode));
  }
  // and a passphrase stretched with less than Nookara's clients use
  r = await setup(bob, K.bob, { passcode: nke1.passcode({ params: { m: 19456, t: 2, p: 1 } }) });
  assert.deepEqual([r.status, r.body.error, r.body.argon2id], [400, 'weak_kdf', { m: 65536, t: 3, p: 1 }]);
  assert.equal((await setup(bob, K.bob, { passcode: nke1.passcode({ params: undefined }) })).body.error, 'weak_kdf');
  assert.equal((await setup(bob, K.bob, { recovery: nke1.recovery({ auth: '' }) })).body.error, 'bad_backup');
  assert.equal((await setup(bob, K.bob, { recovery: undefined })).body.error, 'bad_backup');
  assert.equal((await bob.a.get(e2('/me'))).body.has, false);

  const ws = await wsClient(baseB).login(bob.session); sockets.push(ws);
  K.bobPass = nke1.passcode(); K.bobRec = nke1.recovery();
  r = await setup(bob, K.bob, { passcode: K.bobPass, recovery: K.bobRec });
  assert.deepEqual([r.status, r.body], [200, { success: true, kid: K.bob.kid }]);
  assert.equal((await ws.waitFor(f => f.type === 'e2ee_keys_changed')).id, BOB);
  r = await setup(bob, nke1.account());
  assert.deepEqual([r.status, r.body.error], [409, 'already_has_keys']);
  // Nookara's own wording for a passphrase ("password") is the same thing
  assert.equal((await setup(bea, K.bea = nke1.account(), { passcode: nke1.passcode({ type: 'password', secret_kind: undefined }) })).status, 200);

  const me = (await bob.a.get(e2('/me'))).body;
  assert.deepEqual([me.has, me.kid, me.enc_pub, me.sig_pub, me.clients, me.clients_sig], [true, K.bob.kid, K.bob.enc_pub, K.bob.sig_pub, { seq: 0, list: [] }, null]);
  assert.deepEqual(me.passcode, { type: 'password', secret_kind: 'passphrase', salt: K.bobPass.salt, params: { m: 65536, t: 3, p: 1 }, locked: false, tries_left: 10 });
  assert.deepEqual(me.recovery, { salt: K.bobRec.salt });
  assert.ok(!JSON.stringify(me).includes(K.bobPass.ct) && !JSON.stringify(me).includes(K.bobPass.auth)); // the locked keys are not handed out here
  // what the database holds: public keys, the locked blobs, a hash of the unlock proof
  const row = db.get("SELECT * FROM e2ee_backups WHERE kind = 'passcode' AND user_id = (SELECT user_id FROM e2ee_accounts WHERE kid = ?)", K.bob.kid);
  assert.deepEqual([row.blob_ct, row.auth_hash, row.type], [K.bobPass.ct, crypto.createHash('sha256').update(K.bobPass.auth).digest('hex'), 'password']);
  ws.close();
});

test('the locked keys are handed out only to a right guess; ten wrong ones lock the passphrase until the recovery code is used', async () => {
  const unlock = (kind, auth) => bob.a.post(e2('/unlock'), { kind, auth });
  assert.equal((await unlock('passcode')).body.error, 'missing_fields');
  let r = await unlock('passcode', nke1.rand(32));
  assert.deepEqual([r.status, r.body], [403, { error: 'wrong_passcode', tries_left: 9 }]);
  r = await unlock('passcode', K.bobPass.auth);
  assert.deepEqual([r.status, r.body], [200, { iv: K.bobPass.iv, ct: K.bobPass.ct }]);
  assert.equal((await bob.a.get(e2('/me'))).body.passcode.tries_left, 10); // a right one starts the count again
  r = await unlock('recovery', nke1.rand(32));
  assert.deepEqual([r.status, r.body.error], [403, 'wrong_recovery_code']);
  for (let i = 0; i < 9; i++) assert.equal((await unlock('passcode', nke1.rand(32))).body.tries_left, 9 - i);
  r = await unlock('passcode', nke1.rand(32));
  assert.deepEqual([r.status, r.body], [423, { error: 'passcode_locked', tries_left: 0 }]);
  r = await unlock('passcode', K.bobPass.auth); // the right one too, now
  assert.deepEqual([r.status, r.body.error], [423, 'passcode_locked']);
  assert.deepEqual([(await bob.a.get(e2('/me'))).body.passcode.locked, (await bob.a.get(e2('/me'))).body.passcode.tries_left], [true, 0]);
  r = await unlock('recovery', K.bobRec.auth);
  assert.deepEqual(r.body, { iv: K.bobRec.iv, ct: K.bobRec.ct });
  assert.equal((await unlock('passcode', K.bobPass.auth)).status, 200);
  // tries are counted per hour as well
  E._test.tries.recovery.reset();
  for (let i = 0; i < 60; i++) E._test.tries.recovery.hit(db.get("SELECT id FROM users WHERE username = 'bob'").id);
  assert.equal((await unlock('recovery', K.bobRec.auth)).status, 429);
  E._test.tries.recovery.reset();
});

test('a new passphrase or recovery code needs a proof signed with the keys', async () => {
  const put = (over = {}, key = K.bob, ts = Date.now()) => bob.a.put(e2('/backup'), { kind: 'passcode', ...nke1.passcode(), ts, proof: nke1.sign(key, `nke1 proof|backup|${BOB}|${ts}`), ...over });
  assert.equal((await put({}, K.bea)).body.error, 'bad_proof');
  assert.equal((await put({ proof: nke1.sign(K.bob, `nke1 proof|backup|${BEA}|${Date.now()}`) })).body.error, 'bad_proof');
  assert.equal((await put({}, K.bob, Date.now() - 6 * 60e3)).body.error, 'stale_proof');
  assert.equal((await put({ type: 'pin', secret_kind: 'pin' })).body.error, 'passphrase_required');
  assert.equal((await put({ params: { m: 1024, t: 1, p: 1 } })).body.error, 'weak_kdf');
  K.bobPass = nke1.passcode();
  assert.deepEqual((await put(K.bobPass)).body, { success: true });
  assert.deepEqual((await bob.a.post(e2('/unlock'), { kind: 'passcode', auth: K.bobPass.auth })).body, { iv: K.bobPass.iv, ct: K.bobPass.ct });
  const rec = nke1.recovery(), ts = Date.now();
  assert.equal((await bob.a.put(e2('/backup'), { kind: 'recovery', ...rec, ts, proof: nke1.sign(K.bob, `nke1 proof|backup|${BOB}|${ts}`) })).status, 200);
  assert.equal((await bob.a.post(e2('/unlock'), { kind: 'recovery', auth: K.bobRec.auth })).body.error, 'wrong_recovery_code');
  assert.equal((await bob.a.post(e2('/unlock'), { kind: 'recovery', auth: rec.auth })).status, 200);
  K.bobRec = rec;
  assert.equal((await bo.a.put(e2('/backup'), { kind: 'passcode', ...nke1.passcode(), ts, proof: 'x' })).body.error, 'no_keys');
});

test('the signed list of linked clients: a higher seq each time, and a revoked client stays revoked', async () => {
  const phone = nke1.account(), tablet = nke1.account();
  const put = s => bob.a.put(e2('/clients'), { doc: s.doc, sig: s.sig });
  let s = nke1.clientsDoc(BOB, K.bob, 1, [{ ...phone, label: 'Phone', app: 'app.one', added_at: 10 }]);
  assert.equal((await put({ doc: s.doc, sig: nke1.clientsDoc(BOB, K.bea, 1, [{ ...phone, label: 'Phone', app: 'app.one', added_at: 10 }]).sig })).body.error, 'bad_signature');
  assert.equal((await put({ doc: s.doc, sig: nke1.clientsDoc(BEA, K.bob, 1, [{ ...phone, label: 'Phone', app: 'app.one', added_at: 10 }]).sig })).body.error, 'bad_signature'); // signed for another account
  assert.equal((await put({ doc: { ...s.doc, list: [{ ...s.doc.list[0], kid: tablet.kid }] }, sig: s.sig })).body.error, 'bad_clients');
  assert.equal((await put(nke1.clientsDoc(BOB, K.bob, 1, [{ ...phone, app: 'a,b;c' }]))).body.error, 'bad_clients');
  assert.equal((await put(nke1.clientsDoc(BOB, K.bob, 1, Array.from({ length: 21 }, () => nke1.account())))).body.error, 'too_many_clients');
  assert.deepEqual((await put(s)).body, { success: true });
  let r = await put(s);
  assert.deepEqual([r.status, r.body.error, r.body.seq], [409, 'stale_clients', 1]);
  s = nke1.clientsDoc(BOB, K.bob, 3, [{ ...phone, label: 'Phone', app: 'app.one', added_at: 10, revoked_at: 20 }, { ...tablet, label: 'Tablet', added_at: 15 }]);
  assert.equal((await put(s)).status, 200);
  assert.equal((await put(nke1.clientsDoc(BOB, K.bob, 2, []))).body.error, 'stale_clients');
  assert.equal((await put(nke1.clientsDoc(BOB, K.bob, 4, [{ ...phone, label: 'Phone', app: 'app.one', added_at: 10 }, { ...tablet, label: 'Tablet', added_at: 15 }]))).body.error, 'bad_clients'); // un-revoked
  const me = (await bob.a.get(e2('/me'))).body;
  assert.deepEqual([me.clients, me.clients_sig], [s.doc, s.sig]);
  const doc = (await bea.a.get(`/api/v2/social/keys/${enc(BOB)}`)).body;
  assert.deepEqual([doc.clients, doc.clients_sig, doc.clients_seq, doc.owner], [s.doc, s.sig, 3, BOB]);
  assert.ok(E.verify(E.clientsText(doc.owner, doc.keys[0].kid, doc.clients), doc.keys[0].public_key, doc.clients_sig));
  K.bobTablet = tablet;
});

test('a new device is linked by a device that has the keys', async () => {
  const eph = nke1.keyPair(), ws = await wsClient(baseB).login(bob.session); sockets.push(ws);
  assert.equal((await bo.a.post(e2('/link'), { enc_pub: eph.pub })).body.error, 'no_keys');
  assert.equal((await bob.a.post(e2('/link'), { enc_pub: 'x' })).body.error, 'bad_key');
  let r = await bob.a.post(e2('/link'), { enc_pub: eph.pub, label: 'Laptop' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { code } = r.body;
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(r.body.kind, 'device');
  assert.equal((await ws.waitFor(f => f.type === 'e2ee_link_request')).label, 'Laptop');
  r = await bob.a.get(e2('/link/' + code.toLowerCase().replace('-', '')));
  assert.deepEqual([r.body.kind, r.body.enc_pub, r.body.label, r.body.state, r.body.sealed], ['device', eph.pub, 'Laptop', 'waiting', null]);
  assert.equal((await bea.a.get(e2('/link/' + code))).body.error, 'link_not_found'); // someone else's
  assert.equal((await bob.a.post(e2(`/link/${code}/approve`), { sealed: { e: 'x' } })).body.error, 'bad_sealed');
  const sealed = nke1.wrap(crypto.randomBytes(32), eph.pub, 'link');
  assert.deepEqual((await bob.a.post(e2(`/link/${code}/approve`), { sealed })).body, { success: true });
  assert.deepEqual(await ws.waitFor(f => f.type === 'e2ee_link_done'), { type: 'e2ee_link_done', state: 'approved', code });
  r = await bob.a.get(e2('/link/' + code));
  assert.deepEqual([r.body.state, r.body.sealed], ['approved', sealed]);
  assert.equal((await bob.a.post(e2(`/link/${code}/approve`), { sealed })).body.error, 'link_used');
  // denied, and gone after ten minutes
  const other = nke1.keyPair(), c2 = (await bob.a.post(e2('/link'), { enc_pub: other.pub })).body.code;
  assert.equal((await bob.a.post(e2(`/link/${c2}/deny`))).status, 200);
  assert.equal((await bob.a.get(e2('/link/' + c2))).body.state, 'denied');
  db.run('UPDATE e2ee_links SET expires_at = ?', Date.now() - 1);
  assert.equal((await bob.a.get(e2('/link/' + code))).body.error, 'link_not_found');
  ws.close();
});

test('only the account\'s own clients, on its own homeserver', async () => {
  // alice lives on A: nothing of hers is kept on B
  for (const [m, p, b] of [['get', '/me'], ['post', '', {}], ['post', '/unlock', { kind: 'passcode', auth: 'x' }], ['put', '/backup', {}], ['put', '/clients', {}], ['post', '/link', {}]]) {
    const r = await al.a[m](e2(p), b);
    assert.deepEqual([r.status, r.body.error], [400, 'local_accounts_only'], `${m} ${p}`);
  }
  // a session an OAuth app signed in with
  const viaApp = await reg(baseB, 'viaapp');
  db.run('UPDATE sessions SET app = ? WHERE hash = ?', JSON.stringify({ id: 'app1', name: 'Some app' }), crypto.createHash('sha256').update(viaApp.session).digest('hex'));
  for (const [m, p, b] of [['get', '/me'], ['post', '', {}], ['post', '/unlock', { kind: 'passcode', auth: 'x' }], ['post', '/link', {}]]) {
    const r = await viaApp.a[m](e2(p), b);
    assert.deepEqual([r.status, r.body.error], [403, 'own_clients_only'], `${m} ${p}`);
  }
  assert.equal((await api(baseB).get(e2('/me'))).status, 401);
});

test('replacing the keys: the old public half stays listed, linked clients are gone', async () => {
  const old = K.bob;
  K.bob = nke1.account(); K.bobPass = nke1.passcode(); K.bobRec = nke1.recovery();
  const r = await setup(bob, K.bob, { passcode: K.bobPass, recovery: K.bobRec, replace: true });
  assert.deepEqual(r.body, { success: true, kid: K.bob.kid });
  const doc = (await bea.a.get(`/api/v2/social/keys/${enc(BOB)}`)).body;
  assert.deepEqual([doc.keys[0].kid, doc.past, doc.clients, doc.clients_sig], [K.bob.kid, [{ kid: old.kid, sig_pub: old.sig_pub }], { seq: 0, list: [] }, null]);
  K.bobOld = old; K.bobTablet = null;
});

// ---------- host ----------
test('a DM takes sealed messages and nothing else', async () => {
  let r = await bob.a.post('/api/v2/social/dms', { members: ['bea'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  local = r.body.dm;
  assert.equal(local.e2ee, true);
  const cid = local.channel, dm = local.id;
  const sealBob = (text, to = [K.bob, K.bea], extra = {}) => nke1.seal({ dm, from: BOB, text, to, signer: K.bob, ...extra });
  // nothing readable gets in, with or without an envelope next to it
  for (const body of [{ message: 'hi' }, { body: 'hi' }, {}, { message: 'hi', enc: sealBob('hi').enc }, { enc: sealBob('hi').enc, attachments: [{ url: 'https://x.example/a.png' }] }, { enc: sealBob('x').enc, sticker: 't1' }, { enc: sealBob('x').enc, signature: { kid: 'k', sig: 's', ts: 1, nonce: 'n' } }]) {
    r = await post(bob, cid, body);
    assert.deepEqual([r.status, r.body.error], [400, 'e2ee_required'], JSON.stringify(body).slice(0, 60));
  }
  // the envelope's shape
  const good = sealBob('hello bea');
  const kid = Object.keys(good.enc.wraps)[0];
  for (const bad of [{ ...good.enc, v: 1 }, { ...good.enc, wraps: {} }, { ...good.enc, wraps: [] }, { ...good.enc, wraps: { short: good.enc.wraps[kid] } }, { ...good.enc, wraps: { [kid]: { e: 'a', i: 'b' } } }, { ...good.enc, sig: '' }, { ...good.enc, iv: 'not base64!' }, { ...good.enc, signer: 'x' }, 'text', []]) {
    r = await post(bob, cid, { enc: bad });
    assert.deepEqual([r.status, r.body.error], [400, 'bad_envelope'], JSON.stringify(bad).slice(0, 80));
  }
  r = await post(bob, cid, { enc: { ...good.enc, ct: 'A'.repeat(96 * 1024 + 1) } });
  assert.deepEqual([r.status, r.body.error], [400, 'message_too_long']);
  // at most one wrap per key a member can have: 2 members x (account + 20 clients)
  const many = Object.fromEntries(Array.from({ length: 43 }, () => [nke1.rand(16).slice(0, 22), good.enc.wraps[kid]]));
  r = await post(bob, cid, { enc: { ...good.enc, wraps: many } });
  assert.deepEqual([r.status, r.body.error, r.body.max], [400, 'too_many_wraps', 42]);
  // sealed for the wrong keys: the host says who is missing (it knows every member's account key)
  r = await post(bob, cid, { enc: sealBob('only me', [K.bob]).enc });
  assert.deepEqual([r.status, r.body.error, r.body.members], [409, 'stale_keys', [BEA]]);
  r = await post(bob, cid, { enc: sealBob('old key', [K.bobOld, K.bea]).enc });
  assert.deepEqual([r.status, r.body.members], [409, [BOB]]);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.cid = ?', cid).n, 0);

  // a sealed one: kept as it came, and all anyone gets back
  const beaWs = await wsClient(baseB).login(bea.session); sockets.push(beaWs);
  r = await post(bob, cid, { enc: { ...good.enc, extra: 'dropped' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = r.body.message;
  assert.deepEqual([m.body, m.attachments, m.enc, m.author.id], ['', [], good.enc, 'l:2']);
  const ev = await beaWs.waitFor(f => f.type === 'chat_message' && f.message.id === m.id);
  assert.deepEqual(ev.message.enc, good.enc);
  const row = db.get('SELECT body, enc, attachments, embeds FROM messages WHERE id = ?', Number(m.id));
  assert.deepEqual([row.body, JSON.parse(row.enc), row.attachments, row.embeds], ['', good.enc, null, null]);
  assert.ok(!JSON.stringify(db.all('SELECT * FROM messages WHERE id = ?', Number(m.id))).includes('hello bea'));
  // bea is told someone wrote, never what
  const ping = await beaWs.waitFor(f => f.type === 'chat_mention' && f.id === m.id);
  assert.deepEqual([ping.body, ping.dm], ['sent a message', dm]);
  // history; ?kids= cuts the wraps down to the reader's own keys
  let h = (await bea.a.get(`/api/v1/channels/${cid}/messages`)).body.messages;
  assert.deepEqual(h.map(x => x.enc), [good.enc]);
  h = (await bea.a.get(`/api/v1/channels/${cid}/messages?kids=${K.bea.kid},nonsense`)).body.messages;
  assert.deepEqual([Object.keys(h[0].enc.wraps), h[0].enc.ct], [[K.bea.kid], good.enc.ct]);
  // bea's client opens it with her key; a reply quotes nothing here
  const reply = nke1.seal({ dm, from: BEA, text: 'hi bob', to: [K.bob, K.bea], signer: K.bea });
  r = await post(bea, cid, { enc: reply.enc, reply_to: m.id });
  assert.deepEqual([r.status, r.body.message.reply.id, r.body.message.reply.body, r.body.message.reply_to], [200, m.id, '', m.id]);
  const replyId = r.body.message.id;

  // an edit is a new envelope, signed with the message's id
  for (const body of [{ message: 'now readable' }, { body: 'x' }, { enc: good.enc, message: 'both' }]) {
    r = await bob.a.patch(`/api/v1/messages/${m.id}`, body);
    assert.deepEqual([r.status, r.body.error], [400, 'e2ee_required'], JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await bob.a.patch(`/api/v1/messages/${m.id}`, { enc: { ...good.enc, v: 1 } })).body.error, 'bad_envelope');
  assert.equal((await bob.a.patch(`/api/v1/messages/${m.id}`, { enc: sealBob('x', [K.bob]).enc })).body.error, 'stale_keys');
  const edited = sealBob('hello bea!', undefined, { editOf: m.id });
  assert.equal((await bea.a.patch(`/api/v1/messages/${m.id}`, { enc: edited.enc })).status, 403);
  r = await bob.a.patch(`/api/v1/messages/${m.id}`, { enc: edited.enc });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.message.enc, r.body.message.body], [edited.enc, '']);
  assert.ok(r.body.message.edited_at > 0);
  assert.deepEqual((await beaWs.waitFor(f => f.type === 'chat_message_update' && f.message.id === m.id && f.message.edited_at)).message.enc, edited.enc);
  K.first = { id: m.id, ...good }; K.edited = { id: m.id, ...edited }; K.reply = { id: replyId, ...reply };

  // nothing to search, nothing fetched for a link
  assert.deepEqual((await bob.a.get(`/api/v1/channels/${cid}/search?q=hello`)).body, { messages: [] });
  assert.deepEqual((await bob.a.get(`/api/v1/channels/${cid}/search?q=${good.enc.ct.slice(0, 8)}`)).body, { messages: [] });
  assert.deepEqual((await bob.a.get(`/api/v1/unfurl?sid=${local.sid}&url=${enc('http://127.0.0.1:1/never')}`)).body, { embed: null });
  // over the gateway too
  messages._sendLimit.reset();
  const bobWs = await wsClient(baseB).login(bob.session); sockets.push(bobWs);
  bobWs.ws.send(JSON.stringify({ type: 'chat_send', channel: cid, message: 'plain', nonce: 'n1' }));
  assert.equal((await bobWs.waitFor(f => f.error === 'e2ee_required' || f.code === 'e2ee_required' || /e2ee_required/.test(JSON.stringify(f)))).nonce ?? 'n1', 'n1');
  const viaWs = sealBob('over the socket');
  bobWs.ws.send(JSON.stringify({ type: 'chat_send', channel: cid, enc: viaWs.enc, nonce: 'n2' }));
  assert.deepEqual((await bobWs.waitFor(f => f.type === 'chat_ack' && f.nonce === 'n2')).message.enc, viaWs.enc);
  // and an envelope has no place in a server
  await bob.a.post(`/api/v1/servers/${lobby.sid}/join`);
  const general = (await bob.a.get(`/api/v1/servers/${lobby.sid}`)).body.channels.find(c => c.type === 'text').cid;
  r = await post(bob, general, { enc: good.enc });
  assert.deepEqual([r.status, r.body.error], [400, 'e2ee_not_here']);
  r = await post(bob, general, { message: 'in the open' });
  assert.equal(r.status, 200);
  assert.equal((await bob.a.patch(`/api/v1/messages/${r.body.message.id}`, { enc: good.enc })).body.error, 'e2ee_not_here');
  beaWs.close(); bobWs.close();
});

test('a file in a DM is sealed on the device and kept byte for byte', async () => {
  const cid = local.channel;
  // ciphertext that happens to start like a JPEG: nothing sniffs, strips or compresses it
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]), crypto.randomBytes(4000)]);
  const form = (name = 'photo.jpg') => { const f = new FormData(); f.append('file', new Blob([bytes], { type: 'image/jpeg' }), name); return f; };
  let r = await bob.a.raw('POST', `/api/v1/media/upload?sid=${local.sid}&cid=${cid}&sealed=1`, form());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.name, r.body.mime, r.body.type, r.body.size, r.body.sealed, r.body.width], ['file.bin', 'application/octet-stream', 'file', bytes.length, true, undefined]);
  assert.match(r.body.url, /\.bin$/);
  const got = await fetch(r.body.url);
  assert.equal(got.headers.get('content-type'), 'application/octet-stream');
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(bytes));
  assert.equal(db.get('SELECT sealed FROM uploads WHERE sha256 = ?', r.body.sha256).sealed, 1);
  // a readable upload is refused in a DM; a sealed one anywhere else; the homeserver never fetches a file for a DM
  r = await bob.a.raw('POST', `/api/v1/media/upload?sid=${local.sid}&cid=${cid}`, form());
  assert.deepEqual([r.status, r.body.error], [400, 'e2ee_required']);
  r = await bob.a.raw('POST', `/api/v1/media/upload?sid=${lobby.sid}&sealed=1`, form());
  assert.deepEqual([r.status, r.body.error], [400, 'e2ee_not_here']);
  r = await bob.a.post(`/api/v1/media/import?sid=${local.sid}&sealed=1`, { url: 'https://x.example/a.png' });
  assert.deepEqual([r.status, r.body.error], [400, 'e2ee_required']);
  assert.equal((await bob.a.post(`/api/v1/media/import?sid=${local.sid}`, { url: 'https://x.example/a.png' })).body.error, 'e2ee_required');
});

test('across homeservers: the host checks the envelope against keys it asks the member\'s home for', async () => {
  K.alice = nke1.account();
  assert.equal((await setup(alice, K.alice)).status, 200);
  let r = await bob.a.post('/api/v2/social/dms', { members: ['alice@a.example'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  cross = r.body.dm;
  const dm = cross.id, cid = cross.channel;
  // alice writes on B with her session there: plain text is refused for her as for anyone
  assert.equal((await post(al, cid, { message: 'hi' })).body.error, 'e2ee_required');
  r = await post(al, cid, { enc: nke1.seal({ dm, from: ALICE, text: 'x', to: [K.alice], signer: K.alice }).enc });
  assert.deepEqual([r.status, r.body.error, r.body.members], [409, 'stale_keys', [BOB]]);
  r = await post(bob, cid, { enc: nke1.seal({ dm, from: BOB, text: 'x', to: [K.bob], signer: K.bob }).enc });
  assert.deepEqual([r.status, r.body.error, r.body.members], [409, 'stale_keys', [ALICE]]); // B read her key document from A
  const sent = nke1.seal({ dm, from: ALICE, text: 'hello from A', to: [K.alice, K.bob], signer: K.alice });
  r = await post(al, cid, { enc: sent.enc });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.message.enc, r.body.message.author.id], [sent.enc, ALICE]);
  K.fromAlice = { id: r.body.message.id, ...sent };
  // her pointer on A says the DM is encrypted, and what reaches A about the message has no preview
  await require('../src/social/dms')._test.flush(); await s2s.idle(); await A.call('idle');
  const p = (await alice.a.get('/api/v2/social/dms')).body.dms.find(d => d.id === dm);
  assert.deepEqual([p.e2ee, p.hosted_here], [true, false]);
  // she replaces her keys: B's copy is old, and a message for the new key makes it ask again
  const next = nke1.account();
  assert.equal((await setup(alice, next, { replace: true })).status, 200);
  keysMod._test.freshLimit.reset();
  r = await post(bob, cid, { enc: nke1.seal({ dm, from: BOB, text: 'for the new key', to: [next, K.bob], signer: K.bob }).enc });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  K.aliceOld = K.alice; K.alice = next;
  // a member whose home has no keys for them yet is not checked (the sender's client holds messages until they have)
  r = await bo.a.post('/api/v2/social/dms', { members: ['bea'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await post(bea, r.body.dm.channel, { enc: nke1.seal({ dm: r.body.dm.id, from: BEA, text: 'x', to: [K.bea], signer: K.bea }).enc })).status, 200);
});

// ---------- reports ----------
test('a report hands over one message and its key, to the homeserver of whoever sent it', async () => {
  const dm = local.id, m = K.edited; // (bob's message, as he last edited it)
  reports._test.perReporter.reset();
  const report = (who, over = {}, msg = {}) => who.a.post('/api/v2/social/reports', { message: { dm, id: m.id, from: BOB, envelope: m.enc, ...msg }, revealed_key: m.k, reason: 'harassment', details: ' he keeps  at it ', ...over });
  assert.equal((await api(baseB).post('/api/v2/social/reports', {})).status, 401);
  assert.equal((await report(bea, { reason: 'because' })).body.error, 'invalid_reason');
  assert.equal((await report(bea, {}, { dm: 'nope' })).body.error, 'invalid_request');
  assert.equal((await report(bea, {}, { from: 'who' })).body.error, 'invalid_request');
  assert.equal((await report(bea, {}, { from: 'l:99@b.example' })).body.error, 'user_not_found');
  assert.equal((await report(bob)).body.error, 'cannot_report_self');
  // a key that does not open it: another message's key, a made-up one, nothing
  for (const revealed_key of [K.first.k, nke1.rand(32), 'short', undefined]) {
    const r = await report(bea, { revealed_key });
    assert.deepEqual([r.status, r.body.error], [400, 'bad_revealed_key'], String(revealed_key));
  }
  // words bob never sent: bea seals her own text, names bob as the sender, and has the key to it
  const forged = nke1.seal({ dm, from: BOB, text: 'something awful', to: [K.bob, K.bea], signer: K.bea });
  let r = await report(bea, { revealed_key: forged.k }, { envelope: forged.enc });
  assert.deepEqual([r.status, r.body.error, r.body.signature], [400, 'bad_signature', 'unknown']);
  r = await report(bea, { revealed_key: forged.k }, { envelope: { ...forged.enc, signer: K.bob.kid } });
  assert.deepEqual([r.status, r.body.error, r.body.signature], [400, 'bad_signature', 'invalid']);
  // his real message moved to another DM, or under another id (an edit is signed with its id)
  assert.equal((await report(bea, {}, { dm: cross.id })).body.error, 'bad_signature');
  assert.equal((await report(bea, {}, { id: '999999' })).body.error, 'bad_signature');
  assert.equal((await report(bea, {}, { envelope: { ...m.enc, ct: K.first.enc.ct } })).body.error, 'bad_signature');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM dm_reports').n, 0);

  // the real thing, with the message before it as context
  reports._test.perReporter.reset(); // (every try above counted)
  r = await report(bea, { context: [{ id: K.reply.id, from: BEA, envelope: K.reply.enc, revealed_key: K.reply.k }] });
  assert.deepEqual([r.status, r.body], [200, { ok: true, id: '1' }]);
  assert.deepEqual((await report(bea)).body, { ok: true, id: '1', duplicate: true });
  assert.equal((await report(bea, { context: [{ id: K.reply.id, from: BEA, envelope: K.reply.enc, revealed_key: m.k }] })).body.error, 'bad_context');
  // nothing readable is stored
  assert.ok(!JSON.stringify(db.all('SELECT * FROM dm_reports')).includes('hello bea'));

  // someone from another homeserver reports him too, with a session here; a message signed with a key he has replaced still counts
  const dmX = cross.id, old = nke1.seal({ dm: dmX, from: BOB, text: 'from before', to: [K.bobOld, K.alice], signer: K.bobOld });
  r = await al.a.post('/api/v2/social/reports', { message: { dm: dmX, id: '7', from: BOB, envelope: old.enc }, revealed_key: old.k, reason: 'spam' });
  assert.deepEqual([r.status, r.body], [200, { ok: true, id: '2' }]);

  // the sender is not ours: the report belongs to their homeserver
  r = await bob.a.post('/api/v2/social/reports', { message: { dm: dmX, id: K.fromAlice.id, from: ALICE, envelope: K.fromAlice.enc }, revealed_key: K.fromAlice.k, reason: 'threats' });
  assert.deepEqual([r.status, r.body], [409, { error: 'report_elsewhere', url: A.url + '/api/v2/social/reports' }]);
  r = await bob.a.post('/api/v2/social/reports', { message: { dm: dmX, id: '1', from: 'l:1@nowhere.invalid', envelope: K.fromAlice.enc }, revealed_key: K.fromAlice.k, reason: 'threats' });
  assert.equal(r.body.error, 'sender_not_here');
  // ... where bob files it with a session from his own (alice signed it with the key she has since replaced: still hers)
  const bobOnA = await onA(bob);
  r = await bobOnA.a.post('/api/v2/social/reports', { message: { dm: dmX, id: K.fromAlice.id, from: ALICE, envelope: K.fromAlice.enc }, revealed_key: K.fromAlice.k, reason: 'threats' });
  assert.deepEqual([r.status, r.body], [200, { ok: true, id: '1' }]);
  const onARow = await A.call('sql', { query: 'SELECT reporter, sender, dm, message_id, status FROM dm_reports' });
  assert.deepEqual(onARow, [{ reporter: BOB, sender: ALICE, dm: dmX, message_id: K.fromAlice.id, status: 'open' }]);
});

test('reports are limited per reporter and per homeserver', async () => {
  const dmX = cross.id;
  const one = (who, i) => { const s = nke1.seal({ dm: dmX, from: BOB, text: 'n' + i, to: [K.bob], signer: K.bob }); return who.a.post('/api/v2/social/reports', { message: { dm: dmX, id: String(100 + i), from: BOB, envelope: s.enc }, revealed_key: s.k, reason: 'spam' }); };
  reports._test.perReporter.reset(); fedLimits.reset();
  for (let i = 0; i < 10; i++) assert.equal((await one(bea, i)).status, 200);
  let r = await one(bea, 10);
  assert.deepEqual([r.status, r.body.error], [429, 'rate_limited']);
  // a forged one counts as a try as well
  reports._test.perReporter.reset();
  for (let i = 0; i < 10; i++) assert.equal((await bea.a.post('/api/v2/social/reports', { message: { dm: dmX, id: '1', from: BOB, envelope: K.first.enc }, revealed_key: nke1.rand(32), reason: 'spam' })).status, 400);
  assert.equal((await one(bea, 11)).status, 429);
  // everyone of one homeserver together
  reports._test.perReporter.reset(); fedLimits.reset();
  config.update({ federation: { rate_limits: { reports_per_hour: 2, new_days: 0 } } });
  assert.equal((await one(al, 20)).status, 200);
  assert.equal((await one(al, 21)).status, 200);
  r = await one(al, 22);
  assert.deepEqual([r.status, r.body.error], [429, 'homeserver_rate_limited']);
  assert.ok(r.body.retry_after > 0);
  assert.equal((await one(bea, 23)).status, 200); // (accounts of this homeserver are not part of that)
  fedLimits.reset(); reports._test.perReporter.reset();
});

test('the homeserver\'s admins read a report by opening that one message themselves', async () => {
  assert.equal((await bob.a.get('/api/v2/homeserver/reports')).status, 403);
  assert.equal((await al.a.get('/api/v2/homeserver/reports')).status, 403);
  assert.equal((await bob.a.patch('/api/v2/homeserver/reports/1', { status: 'resolved' })).status, 403);
  let r = await bo.a.get('/api/v2/homeserver/reports?status=all&limit=100');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.counts.open, r.body.reports.length);
  const first = r.body.reports.at(-1), second = r.body.reports.at(-2);
  assert.deepEqual([first.id, first.status, first.reason, first.details, first.note, first.handled_by], ['1', 'open', 'harassment', 'he keeps at it', '', null]);
  assert.deepEqual([first.reporter.id, first.reporter.handle, first.sender.id, first.sender.handle], [BEA, 'bea@b.example', BOB, 'bob@b.example']);
  assert.deepEqual(first.message, { dm: local.id, id: K.edited.id, from: BOB, envelope: K.edited.enc, edit_of: K.edited.id });
  assert.equal(first.revealed_key, K.edited.k);
  // what the admin's client does with it
  assert.equal(nke1.open(first.message.envelope, first.revealed_key, first.message.dm, first.message.from).t, 'hello bea!');
  assert.deepEqual(first.context.map(c => [c.id, c.from, c.signature, nke1.open(c.envelope, c.revealed_key, first.message.dm, c.from).t]), [[K.reply.id, BEA, 'valid', 'hi bob']]);
  assert.deepEqual([second.reporter.id, second.message.edit_of, second.context], [ALICE, '0', []]);
  // handled
  assert.equal((await bo.a.patch('/api/v2/homeserver/reports/1', { status: 'closed' })).body.error, 'invalid_status');
  assert.equal((await bo.a.patch('/api/v2/homeserver/reports/1', {})).body.error, 'invalid_request');
  assert.equal((await bo.a.patch('/api/v2/homeserver/reports/9999', { status: 'resolved' })).body.error, 'report_not_found');
  r = await bo.a.patch('/api/v2/homeserver/reports/1', { status: 'resolved', note: ' warned him ' });
  assert.deepEqual([r.status, r.body.report.status, r.body.report.note, r.body.report.handled_by], [200, 'resolved', 'warned him', BO]);
  assert.equal((await bo.a.patch('/api/v2/homeserver/reports/2', { status: 'dismissed' })).body.report.note, '');
  assert.deepEqual((await bo.a.get('/api/v2/homeserver/reports?status=resolved')).body.reports.map(x => x.id), ['1']);
  assert.deepEqual((await bo.a.get('/api/v2/homeserver/reports?status=dismissed')).body.reports.map(x => x.id), ['2']);
  r = await bo.a.get('/api/v2/homeserver/reports');
  assert.ok(r.body.reports.length > 0 && r.body.reports.every(x => x.status === 'open'));
  assert.deepEqual([r.body.counts.resolved, r.body.counts.dismissed], [1, 1]);
  assert.equal((await bo.a.get('/api/v2/homeserver/reports?status=nope')).body.error, 'invalid_status');
  r = await bo.a.get('/api/v2/homeserver/reports?status=all&limit=2');
  assert.deepEqual([r.body.reports.length, r.body.has_more], [2, true]);
  assert.ok((await bo.a.get(`/api/v2/homeserver/reports?status=all&before=${r.body.reports[1].id}`)).body.reports.every(x => Number(x.id) < Number(r.body.reports[1].id)));
});
test('a group DM: the owner adds someone, who gets what is sent from then on; a lost key is wrapped again by a member', async () => {
  for (const who of [bob, bea, bo]) await who.a.patch('/api/v1/settings', { dm_from: 'anyone' });
  if (!K.bo) { K.bo = nke1.account(); assert.equal((await setup(bo, K.bo)).status, 200); }
  let r = await bob.a.post('/api/v2/social/dms', { members: ['bea'], group: true, name: 'Pair plus' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const g = r.body.dm, dm = g.id, cid = g.channel;
  const sealBob = (text, to) => nke1.seal({ dm, from: BOB, text, to, signer: K.bob });
  const before = sealBob('before bo', [K.bob, K.bea]);
  const m1 = (await post(bob, cid, { enc: before.enc })).body.message;
  // only the owner adds; someone in it already is not added twice
  assert.equal((await bea.a.post(`/api/v2/social/dms/${enc(dm)}/members`, { members: ['bo'] })).body.error, 'owner_only');
  assert.equal((await bob.a.post(`/api/v2/social/dms/${enc(dm)}/members`, { members: ['bea'] })).body.error, 'already_member');
  const boWs = await wsClient(baseB).login(bo.session); sockets.push(boWs);
  db.run('UPDATE members SET joined_at = joined_at - 5000 WHERE community_id = (SELECT community_id FROM channels WHERE cid = ?)', cid); // (bob and bea were in it first)
  db.run('UPDATE messages SET created_at = created_at - 5000 WHERE id = ?', Number(m1.id));
  r = await bob.a.post(`/api/v2/social/dms/${enc(dm)}/members`, { members: ['bo'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.dm.members.map(m => m.id), [BOB, BEA, BO]);
  assert.equal((await boWs.waitFor(f => f.type === 'social_dm_update' && f.dm.id === dm)).dm.members.length, 3);
  // from now on a message must be sealed to bo too
  r = await post(bob, cid, { enc: sealBob('after', [K.bob, K.bea]).enc });
  assert.deepEqual([r.status, r.body.members], [409, [BO]]);
  const m2 = (await post(bob, cid, { enc: sealBob('after', [K.bob, K.bea, K.bo]).enc })).body.message;
  // bea loses her key: a new one, and what was sealed to the old one is wrapped again by bob, who can open it
  const oldBea = K.bea;
  K.bea = nke1.account();
  assert.equal((await setup(bea, K.bea, { replace: true })).status, 200);
  const want = (await bob.a.get(`/api/v2/social/dms/${enc(dm)}/rewrap?member=${enc(BEA)}&kid=${enc(K.bea.kid)}`)).body;
  assert.deepEqual([want.member, want.messages, want.more], [BEA, [m1.id, m2.id], false]);
  assert.equal((await bob.a.get(`/api/v2/social/dms/${enc(dm)}/rewrap?member=${enc(BEA)}&kid=${enc(oldBea.kid)}`)).body.error, 'unknown_kid');
  const k1 = before.k;
  const beaWs = await wsClient(baseB).login(bea.session); sockets.push(beaWs);
  r = await bob.a.post(`/api/v2/social/dms/${enc(dm)}/rewrap`, { member: BEA, kid: K.bea.kid, wraps: { [m1.id]: nke1.wrap(nke1.unb64(k1), K.bea.enc_pub, K.bea.kid), '999999': nke1.wrap(nke1.unb64(k1), K.bea.enc_pub, K.bea.kid) } });
  assert.deepEqual(r.body, { added: 1, skipped: ['999999'] });
  assert.equal((await beaWs.waitFor(f => f.type === 'social_dm_rewrapped')).count, 1);
  const stored = JSON.parse(db.get('SELECT enc FROM messages WHERE id = ?', Number(m1.id)).enc);
  assert.ok(stored.wraps[K.bea.kid] && stored.wraps[oldBea.kid]);
  // whoever added a wrap may replace it; bo, who neither sent m2 nor is bea, cannot put one in for her (nobody can poison
  // a wrap that blocks her from reading it), and a message whose envelope has no wraps is skipped, not a crash
  assert.deepEqual((await bob.a.post(`/api/v2/social/dms/${enc(dm)}/rewrap`, { member: BEA, kid: K.bea.kid, wraps: { [m1.id]: nke1.wrap(nke1.unb64(k1), K.bea.enc_pub, K.bea.kid) } })).body, { added: 1, skipped: [] });
  const junk = nke1.wrap(crypto.randomBytes(32), K.bea.enc_pub, K.bea.kid);
  assert.deepEqual((await bo.a.post(`/api/v2/social/dms/${enc(dm)}/rewrap`, { member: BEA, kid: K.bea.kid, wraps: { [m2.id]: junk, [m1.id]: junk } })).body, { added: 0, skipped: [m1.id, m2.id] });
  assert.deepEqual((await bo.a.get(`/api/v2/social/dms/${enc(dm)}/rewrap?member=${enc(BEA)}&kid=${enc(K.bea.kid)}`)).body.messages, []);
  assert.ok(!JSON.parse(db.get('SELECT enc FROM messages WHERE id = ?', Number(m2.id)).enc).wraps[K.bea.kid]);
  // bea herself may (another of her clients can still open what it had)
  assert.deepEqual((await bea.a.post(`/api/v2/social/dms/${enc(dm)}/rewrap`, { member: BEA, kid: K.bea.kid, wraps: { [m2.id]: junk } })).body, { added: 1, skipped: [] });
  db.run('UPDATE messages SET enc = ? WHERE id = ?', JSON.stringify({ v: 2 }), Number(m2.id));
  assert.deepEqual((await bea.a.post(`/api/v2/social/dms/${enc(dm)}/rewrap`, { member: BEA, kid: K.bea.kid, wraps: { [m2.id]: junk } })).body, { added: 0, skipped: [m2.id] });
  // bo, who joined after m1, cannot be given it
  r = await bob.a.post(`/api/v2/social/dms/${enc(dm)}/rewrap`, { member: BO, kid: K.bo.kid, wraps: { [m1.id]: nke1.wrap(nke1.unb64(k1), K.bo.enc_pub, K.bo.kid) } });
  assert.deepEqual(r.body, { added: 0, skipped: [m1.id] });
  assert.deepEqual((await bob.a.get(`/api/v2/social/dms/${enc(dm)}/rewrap?member=${enc(BO)}&kid=${enc(K.bo.kid)}`)).body.messages, []);
  assert.equal((await bob.a.post(`/api/v2/social/dms/${enc(dm)}/rewrap`, { member: BEA, kid: K.bea.kid, wraps: { [m1.id]: { e: 'x' } } })).body.error, 'invalid_wraps');
});
