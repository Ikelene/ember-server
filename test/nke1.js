'use strict';
// The client side of end-to-end encrypted DMs (PROTOCOL §4d), for tests: the same crypto Nookara's clients use (nke1),
// done with node:crypto. P-256 keys as raw uncompressed points, base64url.
const crypto = require('crypto');

const b64 = b => Buffer.from(b).toString('base64url');
const unb64 = s => Buffer.from(String(s), 'base64url');
const kidOf = encPub => b64(crypto.createHash('sha256').update(unb64(encPub)).digest()).slice(0, 22);
function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { pub: b64(Buffer.concat([Buffer.from([4]), unb64(jwk.x), unb64(jwk.y)])), privateKey };
}
// an account's (or a linked client's) key pair: an encryption half and a signing half
function account() {
  const enc = keyPair(), sig = keyPair();
  return { enc_pub: enc.pub, sig_pub: sig.pub, kid: kidOf(enc.pub), sigKey: sig.privateKey, encKey: enc.privateKey };
}
const sign = (acct, text) => b64(crypto.sign('sha256', Buffer.from(text), { key: acct.sigKey, dsaEncoding: 'ieee-p1363' }));
function aes(key, iv, plain, aad) {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(aad);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function wrap(k, encPub, kid) {
  const eph = crypto.createECDH('prime256v1'), ephRaw = eph.generateKeys();
  const key = Buffer.from(crypto.hkdfSync('sha256', eph.computeSecret(unb64(encPub)), ephRaw, Buffer.from(`nke1 wrap|${kid}`), 32));
  const i = crypto.randomBytes(12);
  return { e: b64(ephRaw), i: b64(i), w: b64(aes(key, i, k)) };
}
// a sealed message (v: 2). to: the key pairs it is wrapped for; signer: whose signing key signs it. -> { enc, k }
function seal({ dm, from, text, to, signer, editOf = 0 }) {
  const k = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const ct = b64(aes(k, iv, Buffer.from(JSON.stringify({ t: text, n: b64(crypto.randomBytes(8)), ts: Date.now() })), Buffer.from(`nke1|2|${dm}|${from}`)));
  const commit = b64(crypto.createHmac('sha256', k).update('nke1 commit').digest());
  const wraps = Object.fromEntries(to.map(r => [r.kid, wrap(k, r.enc_pub, r.kid)]));
  const sig = sign(signer, `nke1 sig|2|${dm}|${from}|${editOf}|${b64(iv)}|${ct}|${commit}`);
  return { enc: { v: 2, ct, iv: b64(iv), commit, sig, signer: signer.kid, wraps }, k: b64(k) };
}
// what an admin's client does with a report: open the message with the one key that was handed over
function open(enc, k, dm, from) {
  const data = unb64(enc.ct), d = crypto.createDecipheriv('aes-256-gcm', unb64(k), unb64(enc.iv));
  d.setAAD(Buffer.from(`nke1|2|${dm}|${from}`));
  d.setAuthTag(data.subarray(data.length - 16));
  return JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8'));
}
// an envelope of the right shape that nobody can open, for tests that are not about the crypto
const throwaway = account();
const sealed = (text = 'x', dm = 'd0@x.example', from = 'l:0@x.example') => seal({ dm, from, text, to: [throwaway], signer: throwaway }).enc;
// a signed list of linked clients. list: [{ ...account(), label, app, added_at, revoked_at }]
function clientsDoc(owner, acct, seq, list) {
  const doc = { seq, list: list.map(c => ({ kid: c.kid, enc_pub: c.enc_pub, sig_pub: c.sig_pub, label: c.label || '', app: c.app || '', added_at: c.added_at || 0, revoked_at: c.revoked_at || 0 })) };
  const text = `nke1 clients|${owner}|${acct.kid}|${seq}|${doc.list.map(c => [c.kid, c.enc_pub, c.sig_pub, encodeURIComponent(c.label), c.app, c.added_at, c.revoked_at].join(',')).join(';')}`;
  return { doc, sig: sign(acct, text), text };
}
// the keys locked with a passphrase / a recovery code, as a client uploads them (the blob here is random: the server never opens it)
const rand = n => b64(crypto.randomBytes(n));
const passcode = (over = {}) => ({ type: 'password', secret_kind: 'passphrase', salt: rand(16), params: { m: 65536, t: 3, p: 1 }, iv: rand(12), ct: rand(300), auth: rand(32), ...over });
const recovery = (over = {}) => ({ secret_kind: 'recovery', salt: rand(16), iv: rand(12), ct: rand(300), auth: rand(32), ...over });

module.exports = { b64, unb64, kidOf, keyPair, account, sign, wrap, seal, open, sealed, clientsDoc, passcode, recovery, rand };
