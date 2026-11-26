'use strict';
// The homeserver's signing keys (PROTOCOL §4b): remote sign-in tokens are signed with the current one, and the public halves
// are served as a JWKS at /.well-known/ember/jwks.json. The first key is the instance key (DATA_DIR/keys/instance.key, the
// one the Nookara relays know). Rotating makes a new key file (DATA_DIR/keys/signing-<kid>.key); the instance key itself
// never changes, and a retired key stays published for seven days so tokens signed just before the switch still verify.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const { sha256, now } = require('../util');

const KEEP_RETIRED = 7 * 24 * 3600 * 1000;
const META = 'federation_keys'; // [{ kid, file, created_at, retired_at }]
const kidOf = priv => 'hs_' + sha256(Buffer.from(crypto.createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url')).slice(0, 16);
const dir = () => path.join(config.dir(), 'keys');
const loaded = new Map(); // absolute file -> KeyObject

function readKey(file) {
  const abs = path.join(dir(), path.basename(file));
  if (!loaded.has(abs)) loaded.set(abs, crypto.createPrivateKey(fs.readFileSync(abs)));
  return loaded.get(abs);
}
function list() {
  let rows = null;
  try { rows = JSON.parse(db.metaGet(META) || 'null'); } catch { rows = null; }
  if (Array.isArray(rows) && rows.length) return rows;
  require('../relay/client').identity(); // makes the instance key on first use
  rows = [{ kid: kidOf(readKey('instance.key')), file: 'instance.key', created_at: now(), retired_at: null }];
  db.metaSet(META, JSON.stringify(rows));
  return rows;
}
// -> { kid, key } the key new tokens are signed with
function current() {
  const row = list().filter(r => !r.retired_at).pop();
  return { kid: row.kid, key: readKey(row.file) };
}
// the keys a verifier may still meet: the current one and those retired less than seven days ago
const published = (t = now()) => list().filter(r => !r.retired_at || t - r.retired_at < KEEP_RETIRED);
function jwks() {
  return { keys: published().map(r => ({ ...crypto.createPublicKey(readKey(r.file)).export({ format: 'jwk' }), kid: r.kid, alg: 'EdDSA', use: 'sig' })) };
}
// a new signing key; the old one is retired (still published for seven days). -> the new kid
function rotate() {
  const rows = list(), t = now();
  const priv = crypto.generateKeyPairSync('ed25519').privateKey, kid = kidOf(priv), file = `signing-${kid}.key`;
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir(), file), priv.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  for (const r of rows) {
    if (!r.retired_at) r.retired_at = t;
    else if (t - r.retired_at >= KEEP_RETIRED && r.file !== 'instance.key') { try { fs.unlinkSync(path.join(dir(), r.file)); } catch { /* gone */ } loaded.delete(path.join(dir(), r.file)); }
  }
  db.metaSet(META, JSON.stringify([...rows.filter(r => t - r.retired_at < KEEP_RETIRED), { kid, file, created_at: t, retired_at: null }]));
  return kid;
}
const view = () => ({ current: current().kid, keys: published().map(r => ({ kid: r.kid, created_at: r.created_at, retired_at: r.retired_at })) });
// a compact EdDSA JWT signed with the current key
function signJwt(typ, claims) {
  const { kid, key } = current();
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'EdDSA', typ, kid }), body = b64(claims);
  return `${head}.${body}.${crypto.sign(null, Buffer.from(head + '.' + body), key).toString('base64url')}`;
}
const _test = { age(kid, ms) { const rows = list(); for (const r of rows) if (r.kid === kid && r.retired_at) r.retired_at -= ms; db.metaSet(META, JSON.stringify(rows)); } };
module.exports = { current, jwks, rotate, view, signJwt, KEEP_RETIRED, _test };
