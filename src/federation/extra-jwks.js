'use strict';
// Extra signing keys this homeserver vouches for (config `federation.extra_jwks`, PROTOCOL §4b): the keys of the JWKS at
// each url are published in this homeserver's own JWKS, so a key there may sign for this homeserver's domain (Nookara
// signing s2s requests as nookara.cc while chat.nookara.cc is the homeserver nookara.cc delegates to). Each list is
// cached for an hour; a kid nobody has fetches them again, at most once a minute. A list that cannot be fetched keeps
// its last good copy. A kid that could collide with this homeserver's own (prefix hs_) or with one already published is
// skipped, with a log line.
const config = require('../config');
const safe = require('../safe-http');
const { now, log } = require('../util');

const TTL = 3600 * 1000, FORCE_GAP = 60 * 1000;
const KID = /^[A-Za-z0-9._:-]{1,100}$/;
const cache = new Map(); // url -> { at, keys: [jwk] }
let forcedAt = 0;
const warned = new Set();
const urls = () => config.get().federation.extra_jwks || [];

async function fetchList(url) {
  try {
    const r = await safe.request('GET', url, { timeout: 8000, maxBytes: 256 * 1024 });
    const doc = r.status === 200 ? r.json() : null;
    if (!doc || !Array.isArray(doc.keys)) throw new Error('status ' + r.status);
    const keys = doc.keys.slice(0, 50).filter(k => k && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k.x) && typeof k.kid === 'string' && KID.test(k.kid))
      .map(k => ({ kty: 'OKP', crv: 'Ed25519', x: k.x, kid: k.kid, alg: 'EdDSA', use: 'sig' }));
    cache.set(url, { at: now(), keys });
  } catch (e) {
    log(`[federation] extra_jwks ${url}: ${e.code || e.message}`);
    const old = cache.get(url);
    cache.set(url, { at: now(), keys: old ? old.keys : [] }); // tried: the last good copy stays for another hour
  }
}
async function refresh({ force = false } = {}) {
  const list = urls();
  for (const u of [...cache.keys()]) if (!list.includes(u)) cache.delete(u);
  await Promise.all(list.filter(u => force || !cache.has(u) || now() - cache.get(u).at > TTL).map(fetchList));
}
const skip = (kid, why) => { const k = `${kid}|${why}`; if (!warned.has(k)) { warned.add(k); log(`[federation] extra_jwks: kid ${kid} skipped (${why})`); } };
// own: this homeserver's own JWKS keys. -> them followed by the extra keys that do not collide
function merge(own) {
  const out = [...own], kids = new Set(own.map(k => k.kid));
  for (const u of urls()) for (const k of cache.get(u)?.keys || []) {
    if (k.kid.startsWith('hs_')) { skip(k.kid, 'own prefix'); continue; }
    if (kids.has(k.kid)) { skip(k.kid, 'duplicate'); continue; }
    kids.add(k.kid); out.push(k);
  }
  return out;
}
// the published JWKS. kid: one a verifier did not find; the lists are fetched again (at most once a minute) when nobody has it
async function jwks(own, kid = null) {
  await refresh();
  let keys = merge(own);
  if (kid && !keys.some(k => k.kid === kid) && urls().length && now() - forcedAt > FORCE_GAP) {
    forcedAt = now();
    await refresh({ force: true });
    keys = merge(own);
  }
  return { keys };
}

module.exports = { jwks, refresh, merge, _test: { reset() { cache.clear(); forcedAt = 0; warned.clear(); } } };
