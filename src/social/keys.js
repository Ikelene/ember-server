'use strict';
// The key document of an account (PROTOCOL §4c.6, §4d): what anyone sealing a message to it needs. Format "nke1": one
// P-256 account key (a signing half and an encryption half), the account's signed list of linked clients exactly as it
// signed it, and the public halves of account keys it replaced. An account hosted here publishes through the home API
// (e2ee.js); the document of an account of another homeserver is asked for over s2s, checked for shape only and passed
// on unchanged: signatures are for clients to check, never rewritten here.
const db = require('../db');
const { err, now, limiter } = require('../util');
const s2s = require('./s2s');
const people = require('./people');
const where = require('./where');
const E = require('./e2ee');

const freshLimit = limiter(10, 60 * 1000); // ?fresh=1 per account asked about

function localKeys(u) {
  const id = people.fullId(u), a = E.accountOf(u.id);
  if (!a) return { id, keys: [] };
  const clients = E.clientsOf(a);
  return {
    id, format: 'nke1', owner: id,
    keys: [{ kid: a.kid, kind: 'account', alg: 'p256', public_key: a.sig_pub, enc_public_key: a.enc_pub, created_at: a.created_at }],
    clients, clients_sig: a.clients_sig || null, clients_seq: clients.seq,
    past: (() => { try { return JSON.parse(a.past) || []; } catch { return []; } })(),
  };
}
const accountKid = doc => (doc?.keys || []).find(k => k.kind === 'account')?.kid || null;

// what another homeserver published for its account: the same document when it is well formed, { id, keys: [] } when it
// is not in this format (or has no keys yet), null when it is not about `id` or is broken
function cleanRemote(doc, id) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.id !== id || !Array.isArray(doc.keys)) return null;
  if (doc.format !== 'nke1' || !doc.keys.length) return { id, keys: [] };
  const at = id.lastIndexOf('@'), int = v => Number.isInteger(v) && v >= 0;
  // the string its signatures are made over: the id itself, or the bare number of a Nookara account
  if (typeof doc.owner !== 'string' || (doc.owner !== id && id !== `v:${doc.owner}${id.slice(at)}`)) return null;
  if (doc.keys.length > E.MAX_CLIENTS + 1 || doc.keys.filter(k => k?.kind === 'account').length !== 1) return null;
  for (const k of doc.keys) {
    if (!k || typeof k !== 'object' || !E.KID_RE.test(String(k.kid || '')) || !['account', 'device'].includes(k.kind) || k.alg !== 'p256' || !E.isPub(k.public_key) || !E.isPub(k.enc_public_key)) return null;
    if (k.signed_by != null && !E.KID_RE.test(String(k.signed_by))) return null;
  }
  const c = doc.clients;
  if (c != null) {
    if (typeof c !== 'object' || !int(c.seq) || !Array.isArray(c.list) || c.list.length > E.MAX_LIST) return null;
    for (const x of c.list) {
      if (!x || typeof x !== 'object' || !E.KID_RE.test(String(x.kid || '')) || !E.isPub(x.enc_pub) || !E.isPub(x.sig_pub)) return null;
      if (typeof (x.label ?? '') !== 'string' || (x.label ?? '').length > 120 || typeof (x.app ?? '') !== 'string' || (x.app ?? '').length > 120) return null;
      if (!int(x.added_at ?? 0) || !int(x.revoked_at ?? 0)) return null;
    }
  }
  if (doc.clients_sig != null && !E.SIG_RE.test(String(doc.clients_sig))) return null;
  if (doc.clients_seq != null && !int(doc.clients_seq)) return null;
  if (doc.past != null && (!Array.isArray(doc.past) || doc.past.length > E.MAX_PAST || doc.past.some(p => !p || !E.KID_RE.test(String(p.kid || '')) || !E.isPub(p.sig_pub)))) return null;
  const { stale, ...rest } = doc; // (only ever said by the one serving an old copy)
  return rest;
}
// the document of an account of another homeserver (or of a Nookara account of this one whose keys are kept where config
// `social.s2s_url` says): asked for over s2s, kept for ten minutes
async function remoteKeys(id, domain, { fresh = false } = {}) {
  const hit = people.cached('keys', id);
  if (hit && now() - hit.at < people.CACHE_TTL && !(fresh && freshLimit.hit(id))) return hit.body;
  try {
    const doc = cleanRemote(await s2s.call(domain, 'GET', '/keys/' + encodeURIComponent(id)), id);
    if (!doc) throw err('homeserver_unreachable', 502, { domain, reason: 'bad_keys' });
    people.remember('keys', id, doc);
    return doc;
  } catch (e) {
    if (e.status === 404) { db.run("DELETE FROM social_cache WHERE kind = 'keys' AND id = ?", id); throw err('user_not_found', 404); }
    if (hit) return { ...hit.body, stale: true };
    throw e;
  }
}
const failed = new Map(); // id -> when: a homeserver that did not answer is not asked again for a minute (docFor)
// the document of a member of a DM hosted here (a user row), for the host's own checks. null when it cannot be read
async function docFor(u, opts) {
  if (u.kind !== 'remote' && !where.s2sElsewhere(u)) return localKeys(u);
  const id = people.fullId(u);
  if (now() - (failed.get(id) || 0) < 60 * 1000) return people.cached('keys', id)?.body || null;
  try { return await remoteKeys(id, u.kind === 'remote' ? u.domain : require('../config').domain(), opts); }
  catch { if (failed.size > 5000) failed.clear(); failed.set(id, now()); return null; }
}

// GET /api/v2/social/keys/:id[?fresh=1]: an account here, or one of another homeserver
async function get(me, rawId, { fresh = false } = {}) {
  const p = people.mustParse(rawId);
  if (p.local && !where.s2sElsewhere(p.user)) return localKeys(p.user);
  people.mine(me);
  return remoteKeys(p.id, p.domain, { fresh });
}

function register(app) {
  // (the ed25519 / x25519 key chain this route once took is retired: keys are published with POST /api/v2/social/e2ee)
  app.put('/api/v2/social/keys', req => { people.mine(req.user); throw err('use_e2ee_api', 410, { api: '/api/v2/social/e2ee' }); });
  app.get('/api/v2/social/keys/:id', req => get(req.user, req.params.id, { fresh: req.query.fresh === '1' }));
  s2s.on(app, 'GET', '/keys/:id', req => localKeys(s2s.localAccount(req.params.id)));
}

module.exports = { register, get, localKeys, cleanRemote, docFor, accountKid, _test: { freshLimit, failed } };
