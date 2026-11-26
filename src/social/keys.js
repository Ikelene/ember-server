'use strict';
// Public keys of accounts (PROTOCOL §4c), for encryption that happens in clients: the homeserver only stores and publishes
// them. An account has one account key (Ed25519) and up to twenty device keys. The first account key is taken as it comes;
// after that the set only changes along a chain a client can check: a new account key is signed by the one it replaces,
// and every device key is signed by the account key. Signed bytes: "ember-key-v1\n<id@domain>\n<kid>\n<kind>\n<alg>\n<public_key>".
const crypto = require('crypto');
const db = require('../db');
const { err, now } = require('../util');
const s2s = require('./s2s');
const people = require('./people');

const MAX_DEVICES = 20;
const KID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, KEY = /^[A-Za-z0-9_-]{43}$/, SIG = /^[A-Za-z0-9_-]{86}$/;
const ALGS = { account: ['ed25519'], device: ['ed25519', 'x25519'] };

const signedBytes = (owner, k) => Buffer.from(['ember-key-v1', owner, k.kid, k.kind, k.alg, k.public_key].join('\n'));
function verifySig(owner, k, signerPublicKey) {
  try { return crypto.verify(null, signedBytes(owner, k), crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: signerPublicKey }, format: 'jwk' }), Buffer.from(k.sig, 'base64url')); } catch { return false; }
}
const view = r => ({ kid: r.kid, kind: r.kind, alg: r.alg, public_key: r.public_key, created_at: r.created_at, ...(r.signed_by ? { signed_by: r.signed_by, sig: r.sig } : {}) });
const stored = userId => db.all("SELECT * FROM account_keys WHERE user_id = ? ORDER BY kind = 'account' DESC, created_at, kid", userId);
const localKeys = u => ({ id: people.fullId(u), keys: stored(u.id).map(view) });

// one key as sent -> its clean form, or null
function cleanKey(k) {
  if (!k || typeof k !== 'object' || !KID.test(String(k.kid || '')) || !ALGS[k.kind]?.includes(k.alg) || !KEY.test(String(k.public_key || ''))) return null;
  const signed = k.signed_by !== undefined && k.signed_by !== null;
  if (signed && (!KID.test(String(k.signed_by)) || !SIG.test(String(k.sig || '')))) return null;
  return { kid: k.kid, kind: k.kind, alg: k.alg, public_key: k.public_key, signed_by: signed ? k.signed_by : null, sig: signed ? k.sig : null };
}

// PUT /api/v2/social/keys { keys: [ { kid, kind, alg, public_key, signed_by?, sig? } ] }: the whole set, replacing the last one
function publish(me, body = {}) {
  people.mine(me);
  const owner = people.fullId(me);
  const list = Array.isArray(body.keys) && body.keys.length <= MAX_DEVICES + 1 ? body.keys.map(cleanKey) : null;
  if (!list || list.some(k => !k) || new Set(list.map(k => k.kid)).size !== list.length) throw err('invalid_keys', 400);
  const accounts = list.filter(k => k.kind === 'account');
  if (accounts.length !== 1) throw err('account_key_required', 400);
  const account = accounts[0], have = stored(me.id), was = have.find(k => k.kind === 'account') || null;
  const same = (a, b) => !!a && !!b && a.kid === b.kid && a.public_key === b.public_key && a.kind === b.kind && a.alg === b.alg;
  // the account key: the first one stands on its own; a new one is signed by the one before it
  if (was && !same(was, account)) {
    if (account.signed_by !== was.kid) throw err('key_signature_required', 403, { signed_by: was.kid });
    if (!verifySig(owner, account, was.public_key)) throw err('bad_key_signature', 403, { kid: account.kid });
  } else if (was) { account.signed_by = was.signed_by; account.sig = was.sig; } // unchanged: its place in the chain stays
  else { account.signed_by = null; account.sig = null; }
  // device keys: each signed by the account key of this set
  for (const k of list) {
    if (k.kind !== 'device') continue;
    if (k.signed_by !== account.kid) throw err('key_signature_required', 403, { kid: k.kid, signed_by: account.kid });
    if (!verifySig(owner, k, account.public_key)) throw err('bad_key_signature', 403, { kid: k.kid });
  }
  const t = now();
  db.tx(() => {
    db.run('DELETE FROM account_keys WHERE user_id = ?', me.id);
    for (const k of list) {
      const old = have.find(x => same(x, k));
      db.run('INSERT INTO account_keys (user_id, kid, kind, alg, public_key, created_at, signed_by, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', me.id, k.kid, k.kind, k.alg, k.public_key, old ? old.created_at : t, k.signed_by, k.sig);
    }
  });
  return localKeys(me);
}

// what another homeserver published for its account, cut down to well-formed keys
function cleanRemote(doc, id) {
  if (!doc || typeof doc !== 'object' || doc.id !== id || !Array.isArray(doc.keys)) return null;
  const keys = doc.keys.slice(0, MAX_DEVICES + 1).map(k => { const c = cleanKey(k); return c ? { kid: c.kid, kind: c.kind, alg: c.alg, public_key: c.public_key, created_at: Number.isFinite(k.created_at) ? k.created_at : null, ...(c.signed_by ? { signed_by: c.signed_by, sig: c.sig } : {}) } : null; }).filter(Boolean);
  return { id, keys };
}
// GET /api/v2/social/keys/:id: an account here, or one of another homeserver (asked over s2s, kept for ten minutes)
async function get(me, rawId) {
  const p = people.mustParse(rawId);
  if (p.local) return localKeys(p.user);
  people.mine(me);
  const hit = people.cached('keys', p.id);
  if (hit && now() - hit.at < people.CACHE_TTL) return hit.body;
  try {
    const doc = cleanRemote(await s2s.call(p.domain, 'GET', '/keys/' + encodeURIComponent(p.id)), p.id);
    if (!doc) throw err('homeserver_unreachable', 502, { domain: p.domain, reason: 'bad_keys' });
    people.remember('keys', p.id, doc);
    return doc;
  } catch (e) {
    if (e.status === 404) { db.run("DELETE FROM social_cache WHERE kind = 'keys' AND id = ?", p.id); throw err('user_not_found', 404); }
    if (hit) return { ...hit.body, stale: true };
    throw e;
  }
}

function register(app) {
  app.put('/api/v2/social/keys', req => publish(req.user, req.body));
  app.get('/api/v2/social/keys/:id', req => get(req.user, req.params.id));
  s2s.on(app, 'GET', '/keys/:id', req => localKeys(s2s.localAccount(req.params.id)));
}

module.exports = { register, publish, get, localKeys, signedBytes };
