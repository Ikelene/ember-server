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
const { err, now, limiter } = require('../util');
const keys = require('../federation/keys');
const R = require('../federation/rules');
const resolve = require('../federation/resolve');
const remote = require('../federation/remote');
const denylist = require('../federation/denylist');
const seen = require('../federation/seen');
const { registeredDomain } = require('../federation/psl');
const limits = require('../federation/limits');
const where = require('./where');

const PREFIX = '/_ember/s2s/v1';
const MAX_AGE = 300, MAX_AHEAD = 60; // seconds
const TIMEOUT = 8000;

const digest = body => crypto.createHash('sha256').update(body || Buffer.alloc(0)).digest('base64url');
// the bytes a signature covers. target: the request path with its query, exactly as sent; host: the receiver's host[:port].
// purpose: what else the key signs with this scheme adds a sixth line ("purpose: push", §20), so a signature made for one
// use is never good for another
const canonical = ({ method, target, host, created, body, purpose = null }) => [String(method).toUpperCase(), target, String(host).toLowerCase(), String(created), 'sha-256=' + digest(body), ...(purpose ? ['purpose: ' + purpose] : [])].join('\n');

// ---------- sending ----------
// the headers of a request this homeserver makes. body: the exact bytes sent (string / Buffer), or null
function sign({ method, url, body = null, created = Math.floor(now() / 1000), purpose = null }) {
  const u = new URL(url), { kid, key } = keys.current();
  const sig = crypto.sign(null, Buffer.from(canonical({ method, target: u.pathname + u.search, host: u.host, created, body, purpose })), key).toString('base64url');
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
// ---------- the outbox ----------
// A call nobody waits for (removals, renames, activity, presence) goes into s2s_outbox and stays there until it is answered,
// so a restart loses none. In order per homeserver; no answer (or a 5xx / 429) is tried again after RETRY[n], and given up
// after the last wait or once the call is older than MAX_QUEUE_AGE. A call our own rules refuse is not tried again.
// done: { then, ctx, key } (then: a handler registered with after(name, fn), which hears fn(status, body, ctx), (0, null) when
// no answer came; key: a newer call with the same key replaces one still waiting), or a function that hears (status, body)
// (kept in memory only: a restart forgets it)
let RETRY = [2000, 15000, 60000, 300000, 900000, 3600000, 3600000, 3 * 3600000, 6 * 3600000, 12 * 3600000];
let MAX_QUEUE_AGE = 24 * 3600 * 1000;
const MAX_PER_DOMAIN = 5000;
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
const handlers = new Map(); // name -> fn(status, body, ctx)
const inMemory = new Map(); // outbox id -> fn(status, body)
const workers = new Map();  // domain -> { running, timer, busy }
const after = (name, fn) => { handlers.set(name, fn); };
function later(domain, path, body, done = null) {
  if (!db.raw()) return;
  const o = done && typeof done === 'object' ? done : {}, t = now();
  const busy = workers.get(domain)?.busy ?? 0;
  if (o.key) db.run('DELETE FROM s2s_outbox WHERE domain = ? AND key = ? AND id <> ?', domain, String(o.key), busy);
  if (db.get('SELECT COUNT(*) AS n FROM s2s_outbox WHERE domain = ?', domain).n >= MAX_PER_DOMAIN) { console.error('[s2s]', domain, 'outbox full, dropped', path); return; }
  const id = db.run('INSERT INTO s2s_outbox (domain, path, body, key, then_name, ctx, tries, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)',
    domain, path, JSON.stringify(body ?? null), o.key ? String(o.key) : null, o.then || null, o.ctx === undefined ? null : JSON.stringify(o.ctx), t, t).lastInsertRowid;
  if (typeof done === 'function') inMemory.set(Number(id), done);
  kick(domain);
}
function kick(domain) {
  const w = workers.get(domain) || { running: false, timer: null, busy: 0 };
  workers.set(domain, w);
  if (w.running || w.timer) return;
  drain(domain, w).catch(e => console.error('[s2s]', domain, e.message));
}
async function drain(domain, w) {
  w.running = true;
  try {
    for (;;) {
      if (!db.raw()) return;
      const row = db.get('SELECT * FROM s2s_outbox WHERE domain = ? ORDER BY id LIMIT 1', domain);
      if (!row) { if (workers.get(domain) === w) workers.delete(domain); return; }
      const wait = row.next_at - now();
      if (wait > 0) { w.timer = setTimeout(() => { w.timer = null; kick(domain); }, wait); w.timer.unref?.(); return; }
      w.busy = row.id;
      let last = { status: 0, body: null }, again = false;
      try { last = await request(domain, 'POST', row.path, JSON.parse(row.body)); again = last.status >= 500 || last.status === 429; }
      catch (e) { again = e.status === 502; } // refused by our own rules: no point trying again
      w.busy = 0;
      if (!db.raw()) return;
      const tries = row.tries + 1, gap = RETRY[tries - 1];
      if (again && gap !== undefined && now() + gap - row.created_at <= MAX_QUEUE_AGE) {
        db.run('UPDATE s2s_outbox SET tries = ?, next_at = ? WHERE id = ?', tries, now() + gap, row.id);
        continue;
      }
      db.run('DELETE FROM s2s_outbox WHERE id = ?', row.id);
      await finish(row, last);
    }
  } finally { w.running = false; }
}
async function finish(row, last) {
  const fn = inMemory.get(row.id), named = row.then_name ? handlers.get(row.then_name) : null;
  inMemory.delete(row.id);
  try {
    if (fn) await fn(last.status, last.body);
    if (named) await named(last.status, last.body, row.ctx ? JSON.parse(row.ctx) : null);
  } catch (e) { console.error('[s2s]', row.path, e.message); }
}
// after a restart: carry on with what was left
function start() { stop(); if (db.raw()) for (const r of db.all('SELECT DISTINCT domain FROM s2s_outbox')) kick(r.domain); }
function stop() { for (const w of workers.values()) { clearTimeout(w.timer); w.timer = null; } workers.clear(); }
// tests: until the outbox is empty
const idle = async () => { while (db.raw() && (db.get('SELECT 1 FROM s2s_outbox LIMIT 1') || [...workers.values()].some(w => w.running))) await sleep(5); };

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
// Before a signature can be checked the sender's keys have to be found (its /.well-known/ember, its JWKS), and that is work
// anyone can ask for with a made-up keyId. Homeservers this one already deals with (signed in before, friends or DMs there,
// calls waiting for them) are never held back by what strangers do. For the rest: signed requests are limited per address,
// lookups of a domain nothing is known about are limited per address and registered domain (wildcard DNS makes endless
// names under one) and overall, and only so many run at once, per address and overall.
// (Behind a reverse proxy the address is the proxy's unless EMBER_TRUST_PROXY=1: http.js warns about that.)
const ipLimit = limiter(600, 60 * 1000), lookupLimit = limiter(10, 10 * 60 * 1000), allLookups = limiter(600, 10 * 60 * 1000);
let MAX_LOOKUPS = 32, MAX_LOOKUPS_PER_IP = 4, lookups = 0;
const lookupsBy = new Map(); // ip -> running
const peerCache = new Map(); // domain -> { at, known }
function knownPeer(domain) {
  const hit = peerCache.get(domain), t = now();
  if (hit && t - hit.at < 60 * 1000) return hit.known;
  const like = '%@' + domain;
  const known = !!(seen.row(domain) || db.get('SELECT 1 FROM s2s_outbox WHERE domain = ? LIMIT 1', domain) || db.get('SELECT 1 FROM friends WHERE peer LIKE ? LIMIT 1', like)
    || db.get('SELECT 1 FROM dm_pointers WHERE host_domain = ? LIMIT 1', domain) || db.get("SELECT 1 FROM users WHERE kind = 'remote' AND domain = ? LIMIT 1", domain));
  if (peerCache.size > 20000) peerCache.clear();
  peerCache.set(domain, { at: t, known });
  return known;
}
async function lookedUp(domain, ip, fn) {
  if (resolve.known(domain) || knownPeer(domain)) return fn();
  if (!lookupLimit.hit(ip + '|' + registeredDomain(domain)) || !allLookups.hit('all')) throw err('rate_limited', 429);
  const mine = lookupsBy.get(ip) || 0;
  if (lookups >= MAX_LOOKUPS || mine >= MAX_LOOKUPS_PER_IP) throw err('busy', 503);
  lookups++; lookupsBy.set(ip, mine + 1);
  try { return await fn(); } finally { lookups--; const n = (lookupsBy.get(ip) || 1) - 1; if (n) lookupsBy.set(ip, n); else lookupsBy.delete(ip); }
}
// who sent this request. -> { domain, origin, ips }. Throws the errors of §4c, in its order: nothing is fetched for a
// homeserver that is not let in
async function verify(req) {
  const p = parseHeader(req.headers['ember-signature']);
  if (!p) throw err('invalid_signature_header', 401);
  const { domain } = p, named = req.headers['x-ember-homeserver'];
  if (!knownPeer(domain) && !ipLimit.hit(req.ip || '')) throw err('rate_limited', 429);
  if (named !== undefined && String(named).trim().toLowerCase() !== domain) throw err('homeserver_mismatch', 401);
  const t = Math.floor(now() / 1000);
  if (t - p.created > MAX_AGE || p.created - t > MAX_AHEAD) throw err('signature_expired', 401);
  if (remote.acceptMode() === 'none') throw err('remote_accounts_off', 403);
  if (domain === config.domain()) throw err('own_homeserver', 400);
  if (denylist.check({ domain })) throw err('homeserver_denied', 403);
  if (!remote.domainAllowed(domain)) throw err('homeserver_not_allowed', 403, { domain });
  const { hs, key } = await lookedUp(domain, req.ip || '', async () => { const h = await resolve.homeserver(domain); return { hs: h, key: await resolve.keyFor(domain, h, p.kid) }; });
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
// the handle we know for an account of another homeserver (its user row here, or what was cached about it), for deny-list
// entries that name the handle rather than the stable id
function handleOf(sub) {
  const u = db.get("SELECT username FROM users WHERE kind = 'remote' AND principal = ?", sub);
  if (u) return u.username;
  try { const r = db.get("SELECT body FROM social_cache WHERE kind IN ('user', 'profile') AND id = ? ORDER BY fetched_at DESC LIMIT 1", sub); return r ? JSON.parse(r.body).handle || null : null; } catch { return null; }
}
// the two accounts of a call: `from` belongs to the homeserver that signed it, `to` lives here. -> { from: "id@domain", to: user row }
function parties(body, hs) {
  const from = R.parseSub(body?.from);
  if (!from || typeof body.to !== 'string') throw err('invalid_request', 400);
  if (from.domain !== hs.domain) throw err('from_mismatch', 403);
  if (denylist.check({ domain: hs.domain, ips: hs.ips, sub: `${from.id}@${from.domain}`, handle: handleOf(`${from.id}@${from.domain}`) })) throw err('homeserver_denied', 403);
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

module.exports = {
  PREFIX, MAX_AGE, canonical, digest, sign, request, call, later, after, start, stop, idle, verify, parties, localAccount, on, register, discovery, assertPeer,
  _test: { setRetry(list) { RETRY = list; }, setMaxAge(ms) { MAX_QUEUE_AGE = ms; }, ipLimit, lookupLimit, allLookups, setMaxLookups(n, perIp = 4) { MAX_LOOKUPS = n; MAX_LOOKUPS_PER_IP = perIp; }, forgetPeers() { peerCache.clear(); } },
};
