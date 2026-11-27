'use strict';
// Accounts as the social API names them (PROTOCOL §4c): a stable id is "id@domain" ("l:5@a.example"), a handle is
// "name@domain". Looking a handle up (here, or on the homeserver it names), profiles (local, or fetched over s2s and kept
// for ten minutes) and the short form of an account that friend and DM lists carry: { id, handle, display_name, avatar_url }.
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const safe = require('../safe-http');
const { err, now, clean, limiter } = require('../util');
const R = require('../federation/rules');
const resolve = require('../federation/resolve');
const s2s = require('./s2s');
const where = require('./where');
const { KIND_NOOKARA } = require('../compat');
const AP = () => require('../account-profile');
const gateway = () => require('../gateway');

const CACHE_TTL = 10 * 60 * 1000;
const NAME = /^[a-z0-9_.-]{1,32}$/;
const lookupLimit = limiter(60, 60 * 1000); // lookups per address

// ---------- ids ----------
const own = () => config.domain();
const fullId = u => (u.kind === 'remote' ? u.principal : `${u.principal}@${own()}`);
const handleOf = u => (u.kind === 'remote' ? u.username : `${u.username}@${own()}`);
function absolute(url) {
  if (!url) return null;
  try { const x = new URL(url, config.publicUrl() + '/'); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}
const snippetOf = u => ({ id: fullId(u), handle: handleOf(u), display_name: u.display_name || u.username, avatar_url: absolute(u.pfp) });
// an id as a client or another homeserver writes it ("l:5", "l:5@own.domain", "l:5@other.example") -> { id (full), domain, local, user (row, local accounts only) } | null
function parseId(raw) {
  let text = String(raw ?? '').trim();
  if (!text.includes('@')) text += '@' + own();
  const who = R.parseSub(text.slice(0, text.lastIndexOf('@')) + '@' + text.slice(text.lastIndexOf('@') + 1).toLowerCase());
  if (!who) return null;
  const local = who.domain === own();
  const user = local ? auth.userByPrincipal(who.id) : null;
  if (local && (!auth.hostedHere(user) || user.banned)) return null;
  return { id: `${who.id}@${who.domain}`, domain: who.domain, local, user };
}
const mustParse = raw => { const p = parseId(raw); if (!p) throw err('user_not_found', 404); return p; };
// only accounts hosted here have DMs here
const mineForDms = me => { if (!auth.hostedHere(me)) throw err('local_accounts_only', 400); return me; };
// ... and friends and keys, unless they are kept where config `social.api_url` says (a Nookara account: 409 social_elsewhere)
const mine = me => {
  mineForDms(me);
  if (where.apiElsewhere(me)) throw err('social_elsewhere', 409, { api_url: where.urls().api_url });
  return me;
};

// ---------- what was fetched from other homeservers ----------
const cached = (kind, id) => { const r = db.get('SELECT body, fetched_at FROM social_cache WHERE kind = ? AND id = ?', kind, id); if (!r) return null; try { return { body: JSON.parse(r.body), at: r.fetched_at }; } catch { return null; } };
const remember = (kind, id, body) => db.run('INSERT INTO social_cache (kind, id, body, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at', kind, id, JSON.stringify(body), now());
const text = (v, n) => (typeof v === 'string' ? clean(v, n) : '') || null;
function urlIn(v) {
  if (typeof v !== 'string' || v.length > 500) return null;
  try { const u = new URL(v); return u.protocol === 'https:' || (u.protocol === 'http:' && safe.local()) ? u.href : null; } catch { return null; }
}
// what another homeserver said about its account, cut down to the fields we know. null when it is not about `id`
function cleanSnippet(o, id) {
  const who = R.parseSub(id);
  if (!o || typeof o !== 'object' || o.id !== id || !who) return null;
  const name = String(o.handle || '').toLowerCase().split('@');
  const handle = name.length === 2 && name[1] === who.domain && NAME.test(name[0]) ? name.join('@') : null;
  return { id, handle, display_name: text(o.display_name, 64) || (handle ? name[0] : id), avatar_url: urlIn(o.avatar_url) };
}

// ---------- the short form ----------
// of any account, without asking anyone: a local account's row, else what is cached, else just the id
function snippet(id) {
  const p = parseId(id);
  if (p?.local) return snippetOf(p.user);
  const hit = cached('user', id)?.body;
  if (hit) return hit;
  const u = auth.userByPrincipal(id); // signed in here before (a remote user)
  return u ? snippetOf(u) : { id, handle: null, display_name: id, avatar_url: null };
}

// ---------- lookup ----------
// GET /api/v2/users/lookup?handle=name[@domain]: an account hosted here
function lookupLocal(handle) {
  const m = /^@?([^@\s]{1,64})(?:@([^@\s]{1,253}))?$/.exec(String(handle || '').trim().toLowerCase());
  if (!m || config.mode() !== 'local') throw err('user_not_found', 404);
  if (m[2] && m[2] !== own()) throw err('wrong_homeserver', 404);
  // (and the Nookara accounts of this homeserver, by their Nookara username)
  const u = db.get("SELECT * FROM users WHERE kind = 'local' AND username_lc = ? AND banned = 0", m[1])
    || (config.nookaraIdentity() ? db.get('SELECT * FROM users WHERE kind = ? AND lower(username) = ? AND banned = 0 ORDER BY id LIMIT 1', KIND_NOOKARA, m[1]) : null);
  if (!u) throw err('user_not_found', 404);
  return snippetOf(u);
}
// an id -> the short form; an account of another homeserver is asked for there (404 user_not_found when it has none)
async function findById(raw) {
  const p = mustParse(raw);
  if (p.local) return snippetOf(p.user);
  await profile(p.id);
  return snippet(p.id);
}
// a handle ("alice", "alice@b.example") -> the short form, asking the homeserver it names when it is not ours
async function find(raw) {
  const t = String(raw ?? '').trim();
  const m = /^@?([^@\s]{1,64})@([^@\s]{1,253})$/.exec(t.toLowerCase());
  if (!m || m[2] === own()) return lookupLocal(t);
  if (!NAME.test(m[1]) || !R.isDomain(m[2])) throw err('user_not_found', 404);
  s2s.assertPeer(m[2]);
  const hs = await resolve.homeserver(m[2]);
  let r;
  try { r = await safe.request('GET', `${hs.api_url}/users/lookup?handle=${encodeURIComponent(m[1])}`, { timeout: 8000, maxBytes: 64 * 1024 }); }
  catch { throw err('homeserver_unreachable', 502, { domain: m[2], reason: 'unreachable' }); }
  if (r.status === 404) throw err('user_not_found', 404);
  const doc = r.status === 200 ? r.json() : null;
  const s = doc && R.parseSub(doc.id)?.domain === m[2] ? cleanSnippet(doc, doc.id) : null;
  if (!s || s.handle !== `${m[1]}@${m[2]}`) throw err('homeserver_unreachable', 502, { domain: m[2], reason: 'bad_lookup' });
  remember('user', s.id, s);
  return s;
}

// ---------- profiles ----------
const PRESENCE = ['online', 'idle', 'dnd', 'offline'];
// a local account's profile. showPresence: whether the asker may see if they are connected (friends only)
function localProfile(u, showPresence) {
  const p = AP().get(u).profile;
  return {
    ...snippetOf(u), bio: p.bio, pronouns: p.pronouns, banner_url: absolute(p.banner), color: p.color,
    presence: { status: showPresence && gateway().present(u.id) ? 'online' : 'offline' },
    updated_at: u.profile_updated_at || u.created_at,
  };
}
function cleanProfile(o, id) {
  const s = cleanSnippet(o, id);
  if (!s) return null;
  const status = PRESENCE.includes(o.presence?.status) ? o.presence.status : 'offline';
  const activity = text(o.presence?.activity, 128);
  return { ...s, bio: text(o.bio, 300), pronouns: text(o.pronouns, 40), banner_url: urlIn(o.banner_url), color: /^#[0-9a-f]{6}$/i.test(String(o.color || '')) ? o.color : null,
    presence: { status, ...(activity ? { activity } : {}) }, updated_at: Number.isFinite(o.updated_at) ? o.updated_at : null };
}
// the profile of an account of another homeserver: asked over s2s, kept for ten minutes; an old copy is better than none
// the presence of accounts elsewhere as their homeservers last said it (s2s presence, friends.js): kept in memory, so a list
// or a profile shows it at once instead of "offline" until the next change. id -> { status, at }
const remotePresence = new Map();
const notePresence = (id, status) => { if (remotePresence.size > 100000) remotePresence.clear(); remotePresence.set(id, { status, at: now() }); };
const withPresence = (p, at) => { const r = remotePresence.get(p.id); return r && r.at >= (at || 0) ? { ...p, presence: { ...(p.presence || {}), status: r.status } } : p; };
async function profile(id, { fresh = false } = {}) {
  const hit = cached('profile', id);
  if (hit && !fresh && now() - hit.at < CACHE_TTL) return withPresence(hit.body, hit.at);
  const domain = R.parseSub(id).domain;
  try {
    const p = cleanProfile(await s2s.call(domain, 'GET', '/profile/' + encodeURIComponent(id)), id);
    if (!p) throw err('homeserver_unreachable', 502, { domain, reason: 'bad_profile' });
    remember('profile', id, p);
    remember('user', id, { id: p.id, handle: p.handle, display_name: p.display_name, avatar_url: p.avatar_url });
    return p;
  } catch (e) {
    if (e.status === 404) { db.run("DELETE FROM social_cache WHERE kind IN ('profile', 'user') AND id = ?", id); throw err('user_not_found', 404); }
    if (hit) return { ...hit.body, stale: true };
    throw e;
  }
}
// short forms that are missing or old are fetched in the background (lists never wait for another homeserver)
const refreshing = new Set();
function refreshLater(ids) {
  for (const id of ids.slice(0, 20)) {
    const p = parseId(id), hit = p && !p.local ? cached('user', id) : null;
    if (!p || p.local || refreshing.has(id) || (hit && now() - hit.at < CACHE_TTL)) continue;
    refreshing.add(id);
    profile(id, { fresh: true }).catch(() => {}).finally(() => refreshing.delete(id));
  }
}
// GET /api/v2/social/profile/:id
async function getProfile(me, rawId) {
  const p = mustParse(rawId);
  if (p.local) return { profile: localProfile(p.user, p.user.id === me.id || require('./friends').areFriends(p.user, fullId(me))) };
  mine(me);
  return { profile: await profile(p.id) };
}

function register(app) {
  app.get('/api/v2/users/lookup', { auth: false }, req => {
    if (!lookupLimit.hit(req.ip)) throw err('rate_limited', 429);
    return lookupLocal(req.query.handle);
  });
  app.get('/api/v2/social/profile/:id', req => getProfile(req.user, req.params.id));
  // presence is for friends: a homeserver sees it only for accounts that have a friend there
  s2s.on(app, 'GET', '/profile/:id', (req, hs) => {
    const u = s2s.localAccount(req.params.id);
    return localProfile(u, require('./friends').hasFriendAt(u, hs.domain));
  });
}

module.exports = { remotePresence, notePresence, register, fullId, handleOf, snippetOf, snippet, cleanSnippet, parseId, mustParse, mine, mineForDms, find, findById, lookupLocal, profile, getProfile, localProfile, refreshLater, cached, remember, absolute, CACHE_TTL, _test: { lookupLimit } };
