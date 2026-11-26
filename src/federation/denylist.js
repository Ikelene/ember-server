'use strict';
// Deny lists (PROTOCOL §4b): this homeserver's own entries (config `federation.deny`) and the shared lists it follows
// (config `federation.denylists`, by default Nookara's). A shared list is a signed JSON document, fetched every five minutes:
//   { updated_at, domains: [..], networks: [..], accounts: [..], first_seen: { domain: time }, signature: { alg: "EdDSA", kid, sig } }
// `sig` is base64url Ed25519 over the document without `signature`, as JSON with the keys sorted at every level and no
// whitespace. The key comes from the list origin's JWKS (/.well-known/bonfire/jwks.json, then /.well-known/ember/jwks.json).
// A list that cannot be fetched or does not verify changes nothing: the last good copy stays in force (also over a restart).
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const safe = require('../safe-http');
const { canonNookara, normalizeOrigin, sha256, now, log } = require('../util');
const R = require('./rules');
const seen = require('./seen');

const REFRESH = 5 * 60 * 1000;
const JWKS_PATHS = ['/.well-known/bonfire/jwks.json', '/.well-known/ember/jwks.json'];
const metaKey = url => 'denylist:' + sha256(url).slice(0, 24);

// JSON with the keys sorted at every level and no whitespace
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
// a time in a list: unix seconds, milliseconds or an ISO date -> ms | null
function timeOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) && t > 0 ? t : null; }
  return null;
}

// ---------- state ----------
const lists = new Map(); // url -> { entries: [text], first_seen: Map, updated_at, fetched_at, error }
let compiled = null;     // { local, shared } compiled deny entries
let timer = null, running = null;
const invalidate = () => { compiled = null; };
config.events.on('change', invalidate);

function loadSaved(url) {
  try {
    const s = JSON.parse(db.metaGet(metaKey(url)) || 'null');
    if (s && Array.isArray(s.entries)) return { entries: s.entries, first_seen: new Map(Object.entries(s.first_seen || {})), updated_at: s.updated_at || null, fetched_at: s.fetched_at || null, error: null };
  } catch { /* none saved */ }
  return null;
}
// lists on Nookara's own address are not fetched while this homeserver is told never to contact Nookara
const skipped = url => config.get().nookara_registration === 'off' && canonNookara(normalizeOrigin(url)) === canonNookara(config.get().nookara_url);
const followed = () => (config.get().accounts.remote_accounts.mode === 'none' ? [] : config.get().federation.denylists.filter(u => !skipped(u)));
function state() {
  const urls = followed();
  for (const u of [...lists.keys()]) if (!urls.includes(u)) { lists.delete(u); invalidate(); }
  for (const u of urls) if (!lists.has(u)) { lists.set(u, loadSaved(u) || { entries: [], first_seen: new Map(), updated_at: null, fetched_at: null, error: null }); invalidate(); }
  if (!compiled) {
    compiled = { local: R.compileDeny(config.get().federation.deny), shared: R.compileDeny([...lists.values()].flatMap(l => l.entries)) };
    const first = new Map();
    for (const l of lists.values()) for (const [d, t] of l.first_seen) if (!first.has(d) || t < first.get(d)) first.set(d, t);
    seen.setShared(first);
  }
  return compiled;
}
// why this homeserver / account is refused: 'local' | 'shared' | null. who: { domain, ips, sub }
function check(who) {
  const c = state();
  if (R.denied(c.local, who)) return 'local';
  if (R.denied(c.shared, who)) return 'shared';
  return null;
}

// ---------- fetching ----------
async function keysOf(origin) {
  const keys = new Map();
  for (const p of JWKS_PATHS) {
    let doc = null;
    try { const r = await safe.request('GET', origin + p, { timeout: 8000 }); if (r.status === 200) doc = r.json(); } catch { /* try the next address */ }
    for (const k of doc?.keys || []) {
      if (k?.kty !== 'OKP' || k.crv !== 'Ed25519' || typeof k.kid !== 'string' || keys.has(k.kid)) continue;
      try { keys.set(k.kid, crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' })); } catch { /* skip a bad key */ }
    }
    if (keys.size) break;
  }
  return keys;
}
// fetch + verify one list. -> { entries, first_seen, updated_at }; throws Error(reason) and changes nothing when it is not good
async function fetchList(url) {
  const r = await safe.request('GET', url, { timeout: 10000, maxBytes: 4 << 20 });
  if (r.status !== 200) throw new Error('http_' + r.status);
  const doc = r.json();
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('bad_document');
  const { signature, ...body } = doc;
  if (!signature || signature.alg !== 'EdDSA' || typeof signature.kid !== 'string' || typeof signature.sig !== 'string') throw new Error('unsigned');
  const key = (await keysOf(new URL(url).origin)).get(signature.kid);
  if (!key) throw new Error('unknown_kid');
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(canonical(body)), key, Buffer.from(signature.sig, 'base64url')); } catch { ok = false; }
  if (!ok) throw new Error('bad_signature');
  const arr = k => (Array.isArray(body[k]) ? body[k] : []);
  // Nookara's list: entries: [{ kind: homeserver | ip_range | account, value, expires_at }]; plain string arrays are also read
  const fromEntries = arr('entries').filter(e => e && typeof e === 'object' && ['homeserver', 'ip_range', 'account'].includes(e.kind) && typeof e.value === 'string'
    && !(timeOf(e.expires_at) && timeOf(e.expires_at) <= Date.now())).map(e => e.value);
  const entries = [...new Set([...fromEntries, ...arr('deny'), ...arr('domains'), ...arr('networks'), ...arr('cidrs'), ...arr('accounts')].filter(x => typeof x === 'string').map(R.cleanDeny).filter(Boolean))].slice(0, 200000);
  const first = new Map();
  if (body.first_seen && typeof body.first_seen === 'object' && !Array.isArray(body.first_seen)) {
    for (const [d, v] of Object.entries(body.first_seen).slice(0, 200000)) { const t = timeOf(v), dom = String(d).toLowerCase(); if (t && R.isDomain(dom)) first.set(dom, t); }
  }
  return { entries, first_seen: first, updated_at: timeOf(body.updated_at) };
}
// fetch every followed list now, then close the sessions of remote accounts that are denied. -> status()
async function refresh() {
  if (running) return running;
  running = (async () => {
    state();
    for (const url of followed()) {
      const cur = lists.get(url);
      try {
        const got = await fetchList(url);
        if (!db.raw()) return;
        lists.set(url, { ...got, fetched_at: now(), error: null });
        db.metaSet(metaKey(url), JSON.stringify({ entries: got.entries, first_seen: Object.fromEntries(got.first_seen), updated_at: got.updated_at, fetched_at: now() }));
      } catch (e) {
        if (cur) cur.error = e.message || 'failed'; // the last good list stays
        if (cur?.error !== cur?.logged) { log(`[federation] deny list ${url}: ${cur?.error}, keeping the last good copy`); if (cur) cur.logged = cur.error; }
      }
    }
    invalidate();
    if (db.raw()) enforce();
  })().finally(() => { running = null; });
  await running;
  return status();
}
// sessions of remote accounts that are denied now end (their sockets close)
function enforce() {
  const gone = [];
  for (const u of db.all("SELECT id, principal, domain FROM users WHERE kind = 'remote' AND domain IS NOT NULL")) {
    if (!check({ domain: u.domain, ips: seen.ipsOf(u.domain), sub: u.principal })) continue;
    const n = db.run('DELETE FROM sessions WHERE user_id = ?', u.id).changes + db.run('DELETE FROM refresh_tokens WHERE user_id = ?', u.id).changes;
    if (n) gone.push(u.id);
    require('../gateway').closeUsers([u.id], 4003, 'homeserver_denied');
  }
  if (gone.length) log(`[federation] closed the sessions of ${gone.length} denied remote account(s)`);
  return gone.length;
}
const status = () => { state(); return [...lists].map(([url, l]) => ({ url, entries: l.entries.length, updated_at: l.updated_at, fetched_at: l.fetched_at, error: l.error })); };

function start() {
  stop();
  timer = setInterval(() => { refresh().catch(() => {}); }, REFRESH);
  timer.unref();
  if (followed().length) refresh().catch(() => {});
}
function stop() { clearInterval(timer); timer = null; lists.clear(); invalidate(); }

module.exports = { canonical, check, refresh, enforce, status, start, stop, invalidate, REFRESH };
