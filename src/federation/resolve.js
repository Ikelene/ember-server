'use strict';
// Finding a remote homeserver and its keys (PROTOCOL §4b). A domain's homeserver is found at https://<domain>/.well-known/ember:
// that document either is the homeserver's own discovery document (`homeserver` is an object naming the domain) or delegates
// with `homeserver: "https://other.origin"`, whose discovery document must then name the domain. One delegation, no more.
// Every request goes through safe-http (public addresses only, https, no redirects). Development (EMBER_DEV=1): config
// `federation.dev_origins` says where a domain's homeserver really is, over http too.
const crypto = require('crypto');
const dns = require('dns');
const config = require('../config');
const safe = require('../safe-http');
const { err, normalizeOrigin } = require('../util');
const { WELL_KNOWN } = require('../compat');

const HS_TTL = 3600 * 1000, FAIL_TTL = 60 * 1000, JWKS_TTL = 3600 * 1000, REFETCH_EVERY = 60 * 1000;
const homeservers = new Map(); // domain -> { at, origin, jwks_uri } | { at, error }
const jwksCache = new Map();   // origin -> { at, keys: Map(kid -> KeyObject), forced }
const lookup = host => dns.promises.lookup(host, { all: true }).then(list => list.map(x => x.address));
let addressSeam = null; // tests: origin -> [addresses]

const unreachable = (domain, why) => err('homeserver_unreachable', 502, { domain, reason: why });
async function getJson(url) {
  let r;
  try { r = await safe.request('GET', url, { timeout: 8000, maxBytes: 1 << 20 }); } catch (e) { throw new Error(e.code === 'EPRIVATE' ? 'private_address' : 'unreachable'); }
  if (r.status !== 200) throw new Error('http_' + r.status);
  const doc = r.json();
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('bad_document');
  return doc;
}
const devOrigin = domain => (safe.local() ? config.get().federation.dev_origins[domain] || null : null);

// discovery `social: { api_url, s2s_url }` (PROTOCOL §4c): where the homeserver's social API lives; its own origin by default
function socialUrls(social, origin) {
  const url = (v, fallback) => {
    if (typeof v !== 'string' || v.length > 500) return fallback;
    try { const u = new URL(v); if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && safe.local()))) return fallback; return u.href.replace(/\/+$/, ''); } catch { return fallback; }
  };
  const s = social && typeof social === 'object' ? social : {};
  return { api_url: url(s.api_url, origin + '/api/v2'), s2s_url: url(s.s2s_url, origin + '/_ember/s2s/v1') };
}
async function discover(domain) {
  const start = devOrigin(domain) || `https://${domain}`;
  let origin = start, doc = await getJson(start + WELL_KNOWN);
  if (typeof doc.homeserver === 'string') { // delegation: the homeserver for this domain lives at another origin
    origin = normalizeOrigin(doc.homeserver);
    if (!origin || (!origin.startsWith('https://') && !safe.local())) throw new Error('bad_delegation');
    doc = await getJson(origin + WELL_KNOWN);
    if (typeof doc.homeserver === 'string') throw new Error('bad_delegation');
  }
  if (!doc.homeserver || typeof doc.homeserver !== 'object' || String(doc.homeserver.domain || '').toLowerCase() !== domain) throw new Error('domain_mismatch');
  let jwks; try { jwks = new URL(String(doc.jwks_uri)); } catch { throw new Error('no_jwks_uri'); }
  if (jwks.origin !== origin) throw new Error('bad_jwks_uri'); // the keys live on the homeserver itself
  return { origin, jwks_uri: jwks.href, ...socialUrls(doc.social, origin) };
}
// domain -> { origin, jwks_uri, api_url, s2s_url } (cached for an hour; a failure for a minute). Throws 502 homeserver_unreachable { reason }
async function homeserver(domain) {
  const hit = homeservers.get(domain), t = Date.now();
  if (hit && t - hit.at < (hit.error ? FAIL_TTL : HS_TTL)) { if (hit.error) throw unreachable(domain, hit.error); return hit; }
  try {
    const found = await discover(domain);
    homeservers.set(domain, { at: Date.now(), ...found });
  } catch (e) {
    if (homeservers.size > 5000) homeservers.clear();
    homeservers.set(domain, { at: Date.now(), error: e.message || 'unreachable' });
    throw unreachable(domain, e.message || 'unreachable');
  }
  return homeservers.get(domain);
}

// missingKid: the forced refetch names the kid it is after (`?kid=`), so a homeserver that republishes other keys
// (federation.extra_jwks, §4b "Extra keys") fetches them again instead of serving its hour-old copy
async function loadJwks(hs, missingKid = null) {
  let url = hs.jwks_uri;
  if (missingKid) { const u = new URL(url); u.searchParams.set('kid', missingKid); url = u.href; }
  const doc = await getJson(url);
  const keys = new Map();
  for (const k of Array.isArray(doc.keys) ? doc.keys.slice(0, 50) : []) {
    if (k?.kty !== 'OKP' || k.crv !== 'Ed25519' || typeof k.kid !== 'string' || (k.use && k.use !== 'sig')) continue;
    try { keys.set(k.kid, crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' })); } catch { /* skip a bad key */ }
  }
  const entry = { at: Date.now(), keys, forced: jwksCache.get(hs.origin)?.forced || 0 };
  jwksCache.set(hs.origin, entry);
  return entry;
}
// the key `kid` of that homeserver, or null. The JWKS is kept for an hour; an unknown kid fetches it again, at most once a
// minute per homeserver (a rotated key is picked up, a made-up kid cannot make us hammer anyone).
async function keyFor(domain, hs, kid) {
  let entry = jwksCache.get(hs.origin);
  try {
    if (!entry || Date.now() - entry.at > JWKS_TTL) entry = await loadJwks(hs);
    if (!entry.keys.has(kid) && Date.now() - entry.forced > REFETCH_EVERY) {
      const forced = Date.now();
      entry.forced = forced; // counted even when the fetch fails
      entry = await loadJwks(hs, kid); entry.forced = forced;
    }
  } catch (e) { throw unreachable(domain, 'jwks_' + (e.message || 'unreachable')); }
  return entry.keys.get(kid) || null;
}
// the addresses the homeserver answers from (for its network's age and network deny entries); [] when they cannot be found
async function addresses(origin) {
  if (addressSeam) return addressSeam(origin);
  let host; try { host = new URL(origin).hostname.replace(/^\[|\]$/g, ''); } catch { return []; }
  if (require('net').isIP(host)) return [host];
  try { return (await lookup(host)).slice(0, 8); } catch { return []; }
}
const forget = domain => { const h = homeservers.get(domain); if (h?.origin) jwksCache.delete(h.origin); homeservers.delete(domain); };

const _test = {
  clear() { homeservers.clear(); jwksCache.clear(); },
  setAddresses(fn) { addressSeam = fn || null; },
  ageJwks(origin, ms) { const e = jwksCache.get(origin); if (e) { e.at -= ms; e.forced -= ms; } },
  jwksCache, homeservers,
};
module.exports = { homeserver, keyFor, addresses, forget, _test };
