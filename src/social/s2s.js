'use strict';
// Server-to-server requests (PROTOCOL §4c): one homeserver calling another's /_ember/s2s/v1/*. Every request is signed with
// the sending homeserver's signing key (federation/keys.js, the one its JWKS publishes):
//   Ember-Signature: keyId="<domain>#<kid>", created=<unix seconds>, sig="<base64url Ed25519>"
//   X-Ember-Homeserver: <domain>
// signed over five lines joined by "\n": METHOD, path?query, host, created, "sha-256=" + base64url(sha256(body)).
// The receiver finds the sender's keys the way cross-homeserver sign-in does (federation/resolve.js) and applies the same
// rules: who is let in, the deny lists, first-seen, limits per homeserver.
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const safe = require('../safe-http');
const { err, now } = require('../util');
const keys = require('../federation/keys');
const R = require('../federation/rules');
const resolve = require('../federation/resolve');
const remote = require('../federation/remote');
const denylist = require('../federation/denylist');
const seen = require('../federation/seen');
const limits = require('../federation/limits');
const where = require('./where');

const PREFIX = '/_ember/s2s/v1';
const MAX_AGE = 300, MAX_AHEAD = 60; // seconds
const TIMEOUT = 8000;
let RETRY = [2000, 15000];           // waits between the tries of a queued call

const digest = body => crypto.createHash('sha256').update(body || Buffer.alloc(0)).digest('base64url');
// the bytes a signature covers. target: the request path with its query, exactly as sent; host: the receiver's host[:port]
const canonical = ({ method, target, host, created, body }) => [String(method).toUpperCase(), target, String(host).toLowerCase(), String(created), 'sha-256=' + digest(body)].join('\n');

// ---------- sending ----------
// the headers of a request this homeserver makes. body: the exact bytes sent (string / Buffer), or null
function sign({ method, url, body = null, created = Math.floor(now() / 1000) }) {
  const u = new URL(url), { kid, key } = keys.current();
  const sig = crypto.sign(null, Buffer.from(canonical({ method, target: u.pathname + u.search, host: u.host, created, body })), key).toString('base64url');
  return { 'Ember-Signature': `keyId="${config.domain()}#${kid}", created=${created}, sig="${sig}"`, 'X-Ember-Homeserver': config.domain() };
}
// may this homeserver talk to `domain` at all? The rules for accounts coming in hold for requests going out
function assertPeer(domain) {
  if (config.mode() !== 'local') throw err('account_not_hosted_here', 403);
  if (!R.isDomain(domain) || domain === config.domain()) throw err('invalid_homeserver', 400);
  if (remote.acceptMode() === 'none') throw err('remote_accounts_off', 403);
  if (denylist.check({ domain, ips: seen.ipsOf(domain) })) throw err('homeserver_denied', 403);
  if (!remote.domainAllowed(domain)) throw err('homeserver_not_allowed', 403, { domain });
}
// one signed request. -> { status, body (parsed JSON or null) }; throws 502 homeserver_unreachable when nothing answers
// domain = this homeserver's own: the place config `social.s2s_url` names for its Nookara accounts (PROTOCOL §4c)
async function request(domain, method, path, body) {
  let base;
  if (domain === config.domain() && where.urls().s2s_url !== config.publicUrl() + PREFIX) base = where.urls().s2s_url;
  else { assertPeer(domain); base = (await resolve.homeserver(domain)).s2s_url; }
  const url = base + path, payload = body === undefined ? null : JSON.stringify(body);
  let r;
  try { r = await safe.request(method, url, { headers: { ...sign({ method, url, body: payload }), ...(payload ? { 'Content-Type': 'application/json' } : {}) }, body: payload, timeout: TIMEOUT, maxBytes: 1 << 20 }); }
  catch (e) { throw err('homeserver_unreachable', 502, { domain, reason: e.code === 'EPRIVATE' ? 'private_address' : 'unreachable' }); }
  return { status: r.status, body: r.json() };
}
// the same, where anything but a 2xx is an error: the other homeserver's own code and status come back (5xx as 502)
async function call(domain, method, path, body) {
  const r = await request(domain, method, path, body);
  if (r.status >= 200 && r.status < 300) return r.body || {};
  const code = typeof r.body?.error === 'string' && /^[a-z0-9_]{1,64}$/.test(r.body.error) ? r.body.error : 'remote_error';
  const { error, ...extra } = r.body && typeof r.body === 'object' ? r.body : {};
  throw err(code, r.status >= 500 || r.status < 400 ? 502 : r.status, { ...extra, homeserver: domain });
}
// a call nobody waits for (removals, renames, activity): in order per homeserver, tried up to three times.
// done(status, body) hears the last answer, or (0, null) when none came
const queues = new Map(); // domain -> promise chain
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
function later(domain, path, body, done = null) {
  const run = async () => {
    let last = { status: 0, body: null };
    for (let i = 0; i <= RETRY.length; i++) {
      if (!db.raw()) return;
      try { last = await request(domain, 'POST', path, body); if (last.status < 500 && last.status !== 429) break; }
      catch (e) { last = { status: 0, body: null }; if (e.status !== 502) break; } // refused by our own rules: no point trying again
      if (i < RETRY.length) await sleep(RETRY[i]);
    }
    if (done && db.raw()) { try { await done(last.status, last.body); } catch (e) { console.error('[s2s]', path, e.message); } }
  };
  const chain = (queues.get(domain) || Promise.resolve()).then(run).catch(e => console.error('[s2s]', domain, path, e.message));
  queues.set(domain, chain);
  chain.then(() => { if (queues.get(domain) === chain) queues.delete(domain); });
}
const idle = async () => { while (queues.size) await Promise.all([...queues.values()]); }; // tests

// ---------- receiving ----------
function parseHeader(v) {
  if (typeof v !== 'string' || v.length > 1000) return null;
  const p = {};
  for (const m of v.matchAll(/([A-Za-z]+)=(?:"([^"]*)"|(\d+))(?:\s*,\s*|\s*$)/g)) p[m[1]] = m[2] ?? m[3];
  const hash = String(p.keyId || '').lastIndexOf('#');
  const domain = hash > 0 ? p.keyId.slice(0, hash).toLowerCase() : '', kid = hash > 0 ? p.keyId.slice(hash + 1) : '';
  if (!R.isDomain(domain) || !kid || kid.length > 100 || !/^\d{1,12}$/.test(p.created || '') || !/^[A-Za-z0-9_-]{1,200}$/.test(p.sig || '')) return null;
  return { domain, kid, created: Number(p.created), sig: Buffer.from(p.sig, 'base64url') };
}
// who sent this request. -> { domain, origin, ips }. Throws the errors of §4c, in its order: nothing is fetched for a
// homeserver that is not let in
async function verify(req) {
  const p = parseHeader(req.headers['ember-signature']);
  if (!p) throw err('invalid_signature_header', 401);
  const { domain } = p, named = req.headers['x-ember-homeserver'];
  if (named !== undefined && String(named).trim().toLowerCase() !== domain) throw err('homeserver_mismatch', 401);
  const t = Math.floor(now() / 1000);
  if (t - p.created > MAX_AGE || p.created - t > MAX_AHEAD) throw err('signature_expired', 401);
  if (remote.acceptMode() === 'none') throw err('remote_accounts_off', 403);
  if (domain === config.domain()) throw err('own_homeserver', 400);
  if (denylist.check({ domain })) throw err('homeserver_denied', 403);
  if (!remote.domainAllowed(domain)) throw err('homeserver_not_allowed', 403, { domain });
  const hs = await resolve.homeserver(domain);
  const key = await resolve.keyFor(domain, hs, p.kid);
  if (!key) throw err('unknown_kid', 401);
  // signed for this homeserver and nobody else: the host is the one of our own public address
  const signed = Buffer.from(canonical({ method: req.method, target: req.url, host: new URL(config.publicUrl()).host, created: p.created, body: req.rawBody }));
  let ok = false;
  try { ok = crypto.verify(null, signed, key, p.sig); } catch { ok = false; }
  if (!ok) throw err('invalid_signature', 401);
  const ips = await resolve.addresses(hs.origin);
  seen.touch(domain, { origin: hs.origin, ips });
  if (denylist.check({ domain, ips })) throw err('homeserver_denied', 403);
  limits.hit(domain, 's2s');
  return { domain, origin: hs.origin, ips };
}
// "id@domain" of an account hosted here -> its user row (404 user_not_found)
// (a Nookara account whose side of s2s is answered elsewhere: 421 misdirected { s2s_url })
function localAccount(id) {
  const who = R.parseSub(id);
  if (who && who.domain === config.domain() && where.idElsewhere(who.id)) throw err('misdirected', 421, { s2s_url: where.urls().s2s_url });
  const u = who && who.domain === config.domain() ? auth.userByPrincipal(who.id) : null;
  if (!auth.hostedHere(u) || u.banned) throw err('user_not_found', 404);
  return u;
}
// the two accounts of a call: `from` belongs to the homeserver that signed it, `to` lives here. -> { from: "id@domain", to: user row }
function parties(body, hs) {
  const from = R.parseSub(body?.from);
  if (!from || typeof body.to !== 'string') throw err('invalid_request', 400);
  if (from.domain !== hs.domain) throw err('from_mismatch', 403);
  if (denylist.check({ domain: hs.domain, ips: hs.ips, sub: body.from })) throw err('homeserver_denied', 403);
  return { from: `${from.id}@${from.domain}`, to: localAccount(body.to) };
}
// a route under /_ember/s2s/v1: fn(req, hs) runs once the signature holds
function on(app, method, path, fn) {
  app.add(method, PREFIX + path, { auth: false }, async req => fn(req, await verify(req)));
}
function register(app) {
  on(app, 'POST', '/ping', (req, hs) => ({ ok: true, homeserver: config.domain(), you: hs.domain }));
}
const discovery = () => ({ social: where.urls() });

module.exports = { PREFIX, MAX_AGE, canonical, digest, sign, request, call, later, idle, verify, parties, localAccount, on, register, discovery, assertPeer, _test: { setRetry(list) { RETRY = list; } } };
