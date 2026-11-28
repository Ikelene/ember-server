'use strict';
// Signed messages that move (moved-signatures.js, PROTOCOL §8 "Moved messages"): the import keeps the payload each one was signed
// as (old origin, server, channel, ids, body) and checks it without the clock-skew rule; the message view carries it as
// signature.signed + moved_from, so a client can check it too; an edit drops it; POST /api/v2/homeserver/import/signatures
// fills it in for a server imported before it was kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { tmpDir, api, fakeIdp } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'nookara';
process.env.EMBER_NOOKARA_URL = 'https://nookara.cc';
process.env.EMBER_PUBLIC_URL = 'https://chat.test';
process.env.EMBER_ACCEPT_OPERATOR_TERMS = '1';
delete process.env.EMBER_OWNER;
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const signing = require('../src/signing');

const dev = crypto.generateKeyPairSync('ed25519');
const rawPub = Buffer.from(dev.publicKey.export({ format: 'jwk' }).x, 'base64url');
const KID = 'k_' + crypto.createHash('sha256').update(rawPub).digest('hex').slice(0, 16);
const fetcher = async kid => (kid === KID ? { kid: KID, user_id: '123', public_key: rawPub.toString('base64url'), created_at: 1, revoked_at: null } : null);

const idp = fakeIdp({ iss: 'https://nookara.cc' });
const dir = tmpDir();
let inst, a, session, zip, src;
const db = () => require('../src/db');
const upload = async (p, qs, fields = {}) => {
  const f = new FormData(); f.append('file', new Blob([zip]), 'server.zip');
  for (const [k, v] of Object.entries(fields)) f.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  const r = await fetch(`${inst.url}${p}?${new URLSearchParams(qs)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + session }, body: f });
  return { status: r.status, body: await r.json() };
};
const clientCheck = s => crypto.verify(null, signing.signingBytes(s.signed), dev.publicKey, Buffer.from(s.sig, 'base64url'));
const messagesOf = async (sid) => {
  const d = (await a.get(`/api/v1/servers/${sid}`)).body;
  const cid = d.channels.find(c => c.type === 'text').cid;
  return (await a.get(`/api/v1/channels/${cid}/messages?limit=50`)).body.messages;
};
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); auth.setJwksFetcher(idp.jwks); signing.setKeyFetcher(fetcher); });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('setup: signed messages (one a year old, a reply, one altered after signing), exported', async () => {
  session = (await api(inst.url).post('/api/v1/auth/nookara', { token: idp.mint({ sub: '123', username: 'nat' }) })).body.session;
  a = api(inst.url, session);
  assert.equal((await a.post('/api/v1/instance/claim', { code: inst.setup.current(), accept_operator_terms: true })).status, 200);
  const d = (await a.post('/api/v1/servers', { name: 'Signed', slug: 'signed' })).body;
  const sid = d.server.sid, cid = d.channels.find(c => c.type === 'text').cid;
  const sign = (body, extra = {}) => {
    const p = signing.buildPayload({ iss: 'https://nookara.cc', instance: 'https://chat.test', community: sid, channel: cid, author: '123', ts: Date.now(), nonce: crypto.randomBytes(16).toString('base64url'), body, attachments: [], reply_to: null, edit_of: null, ...extra });
    return { kid: KID, sig: crypto.sign(null, signing.signingBytes(p), dev.privateKey).toString('base64url'), ts: p.ts, nonce: p.nonce };
  };
  const first = (await a.post(`/api/v1/channels/${cid}/messages`, { message: 'signed hello', signature: sign('signed hello') })).body.message;
  assert.equal(first.verified, true);
  const reply = await a.post(`/api/v1/channels/${cid}/messages`, { message: 'signed reply', reply_to: first.id, signature: sign('signed reply', { reply_to: first.id }) });
  assert.equal(reply.body.message.verified, true, JSON.stringify(reply.body));
  const altered = (await a.post(`/api/v1/channels/${cid}/messages`, { message: 'what I said', signature: sign('what I said') })).body.message;
  db().run("UPDATE messages SET body = 'what I did not say' WHERE id = ?", Number(altered.id));
  // a year old: signed then, stored as it was (no clock-skew rule for a moved message)
  const old = Date.now() - 400 * 864e5, nonce = 'n-old-' + crypto.randomBytes(6).toString('hex');
  const ch = db().get('SELECT id FROM channels WHERE cid = ?', cid), u = db().get("SELECT id FROM users WHERE principal = 'v:123'");
  const p = signing.buildPayload({ iss: 'https://nookara.cc', instance: 'https://chat.test', community: sid, channel: cid, author: '123', ts: old, nonce, body: 'from last year', attachments: [] });
  db().run('INSERT INTO messages (channel_id, user_id, body, created_at, sig_kid, sig_sig, sig_ts, sig_nonce, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)', ch.id, u.id, 'from last year', old, KID, crypto.sign(null, signing.signingBytes(p), dev.privateKey).toString('base64url'), old, nonce);
  // signed under the instance's earlier addresses: one in its history (the export says so), one only the importer knows
  db().metaSet('public_url_history', JSON.stringify(['https://e_signed.nookara.cc']));
  for (const [instance, body] of [['https://e_signed.nookara.cc', 'from the old address'], ['https://signed-bonfire.example', 'from the oldest address']]) {
    const ts = Date.now() - 200 * 864e5, n = 'n-' + crypto.randomBytes(6).toString('hex');
    const pl = signing.buildPayload({ iss: 'https://velora.ikelene.net', instance, community: sid, channel: cid, author: '123', ts, nonce: n, body, attachments: [] });
    db().run('INSERT INTO messages (channel_id, user_id, body, created_at, sig_kid, sig_sig, sig_ts, sig_nonce, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)', ch.id, u.id, body, ts, KID, crypto.sign(null, signing.signingBytes(pl), dev.privateKey).toString('base64url'), ts, n);
  }
  src = { sid, cid };
  const r = await fetch(`${inst.url}/api/v1/servers/${sid}/export`, { headers: { Authorization: 'Bearer ' + session } });
  zip = Buffer.from(await r.arrayBuffer());
});

let moved;
test('the import keeps what each was signed as and checks it; the view carries it and a client can check it', async () => {
  const r = await upload('/api/v2/homeserver/import', { owner: 'v:123', slug: 'moved', previous_url: 'https://e-signed.nookara.cc' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sg = r.body.signatures;
  assert.deepEqual([sg.checked, sg.verified, sg.failed, sg.unknown], [6, 4, 2, 0]);
  assert.deepEqual(sg.failed_reasons, { bad_signature: 2 });
  assert.equal(sg.failed_samples.length, 2);
  assert.deepEqual(sg.origins.sort(), ['https://chat.test', 'https://e_signed.nookara.cc']);
  moved = r.body.sid;
  const msgs = await messagesOf(moved);
  const by = b => msgs.find(m => m.body === b);
  assert.equal(by('from the old address').signature.moved_from, 'https://e_signed.nookara.cc');
  assert.ok(clientCheck(by('from the old address').signature));
  assert.ok((await api(inst.url).get('/.well-known/ember')).body.previous_urls.includes('https://e_signed.nookara.cc'), 'the origin it verified under is in previous_urls');
  for (const b of ['signed hello', 'signed reply', 'from last year']) {
    const m = by(b);
    assert.equal(m.verified, true, b);
    assert.deepEqual([m.signature.moved_from, m.signature.signed.community, m.signature.signed.channel, m.signature.signed.body], ['https://chat.test', src.sid, src.cid, b]);
    assert.ok(clientCheck(m.signature), 'a client checks the original bytes: ' + b);
    assert.deepEqual([m.author.id, !!m.author.name_only], ['v:123', false], 'the author is the account, not a name');
  }
  assert.notEqual(by('signed reply').signature.signed.reply_to, by('signed reply').reply_to); // (the old id, as signed)
  const bad = by('what I did not say');
  assert.equal(bad.verified, false);
  assert.equal(clientCheck(bad.signature), false);
});

test('a moved signed message that is edited drops what it was signed as', async () => {
  const m = (await messagesOf(moved)).find(x => x.body === 'signed hello');
  const r = await a.patch(`/api/v1/messages/${m.id}`, { message: 'edited here' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message?.signature ?? null, null);
  assert.equal(db().get('SELECT sig_orig FROM messages WHERE id = ?', Number(m.id)).sig_orig, null);
});

test('backfill: a server imported before sig_orig was kept gets it from its export; repeat is the same', async () => {
  const r = await upload('/api/v2/homeserver/import', { owner: 'v:123', slug: 'early' });
  const c = db().get('SELECT id FROM communities WHERE sid = ?', r.body.sid);
  db().run('UPDATE messages SET sig_orig = NULL, verified = 0 WHERE channel_id IN (SELECT id FROM channels WHERE community_id = ?)', c.id);
  assert.equal((await upload('/api/v2/homeserver/import/signatures', { sid: 'nope' })).status, 404);
  for (let i = 0; i < 2; i++) {
    const b = await upload('/api/v2/homeserver/import/signatures', { sid: r.body.sid }, { origins: ['https://signed-bonfire.example/'] });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.deepEqual([b.body.matched, b.body.missing, b.body.verified, b.body.failed], [6, 0, 5, 1]);
  }
  const m = (await messagesOf(r.body.sid)).find(x => x.body === 'from last year');
  assert.deepEqual([m.verified, m.signature.moved_from], [true, 'https://chat.test']);
  const oldest = (await messagesOf(r.body.sid)).find(x => x.body === 'from the oldest address');
  assert.deepEqual([oldest.verified, oldest.signature.moved_from], [true, 'https://signed-bonfire.example']);
  assert.ok((await api(inst.url).get('/.well-known/ember')).body.previous_urls.includes('https://signed-bonfire.example'));
  assert.equal((await upload('/api/v2/homeserver/import/signatures', { sid: r.body.sid }, { origins: 'nope' })).body.error, 'invalid_origins');
});
