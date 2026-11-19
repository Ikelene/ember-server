'use strict';
// An instance on nookara.cc accepts message signatures that name either Nookara issuer (https://nookara.cc, or Velora's original
// https://velora.ikelene.net that older apps sign with), and lists them in discovery as velora.signing_issuers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { tmpDir, api, fakeIdp } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_VELORA_URL = 'https://nookara.cc';
process.env.BONFIRE_PUBLIC_URL = 'https://chat.test';
process.env.EMBER_ACCEPT_OPERATOR_TERMS = '1';
delete process.env.BONFIRE_OWNER;
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const signing = require('../src/signing');

const dev = crypto.generateKeyPairSync('ed25519');
const rawPub = Buffer.from(dev.publicKey.export({ format: 'jwk' }).x, 'base64url');
const KID = 'k_' + crypto.createHash('sha256').update(rawPub).digest('hex').slice(0, 16);
const fetcher = async kid => (kid === KID ? { kid: KID, user_id: '123', public_key: rawPub.toString('base64url'), created_at: Date.now() - 1000, revoked_at: null } : null);

const idp = fakeIdp({ iss: 'https://nookara.cc' });
const dir = tmpDir();
let inst;
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); auth.setJwksFetcher(idp.jwks); signing.setKeyFetcher(fetcher); });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('both Nookara issuers verify; any other issuer does not', async () => {
  const info = (await api(inst.url).get('/.well-known/bonfire')).body;
  assert.deepEqual(info.velora.signing_issuers, ['https://nookara.cc', 'https://velora.ikelene.net']);
  const a = api(inst.url, (await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '123', username: 'nat' }) })).body.session);
  assert.equal((await a.post('/api/v1/instance/claim', { code: inst.setup.current(), accept_operator_terms: true })).status, 200);
  const d = (await a.post('/api/v1/servers', { name: 'Signed' })).body;
  const sid = d.server.sid, cid = d.channels.find(c => c.type === 'text').cid;
  const send = async (iss, body) => {
    const p = signing.buildPayload({ iss, instance: 'https://chat.test', community: sid, channel: cid, author: '123', ts: Date.now(), nonce: crypto.randomBytes(16).toString('base64url'), body, attachments: [], reply_to: null, edit_of: null });
    const sig = crypto.sign(null, signing.signingBytes(p), dev.privateKey).toString('base64url');
    return a.post(`/api/v1/channels/${cid}/messages`, { message: body, signature: { kid: KID, sig, ts: p.ts, nonce: p.nonce } });
  };
  for (const iss of ['https://nookara.cc', 'https://velora.ikelene.net']) {
    const r = await send(iss, 'hi from ' + iss);
    assert.equal(r.status, 200, `${iss}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.message.verified, true);
  }
  const bad = await send('https://elsewhere.example', 'nope');
  assert.equal(bad.body.error, 'bad_signature');
});
