'use strict';
// Friends and blocks (PROTOCOL §4c). Each account's homeserver keeps that account's side: table friends (user_id, peer,
// state) with `peer` a stable id and `state` one of friend / incoming / outgoing / blocked / blocked_by. Two accounts of
// this homeserver are handled here in one go; anything about an account of another homeserver goes to that homeserver as
// a signed request (friend_request, friend_accept, friend_remove, block, unblock) and comes in the same way.
const db = require('../db');
const { err, now, clean, limiter } = require('../util');
const limits = require('../federation/limits');
const s2s = require('./s2s');
const people = require('./people');
const gateway = () => require('../gateway');

const MAX_FRIENDS = 1000;
const requestLimit = limiter(30, 3600 * 1000); // friend requests per account
const OPEN = ['friend', 'incoming', 'outgoing'];

const row = (userId, peer) => db.get('SELECT * FROM friends WHERE user_id = ? AND peer = ?', userId, peer) || null;
function put(userId, peer, state, message = '') {
  db.run('INSERT INTO friends (user_id, peer, state, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, peer) DO UPDATE SET state = excluded.state, message = excluded.message, updated_at = excluded.updated_at',
    userId, peer, state, message, now(), now());
  changed(userId);
}
function drop(userId, peer, states = null) {
  const r = row(userId, peer);
  if (!r || (states && !states.includes(r.state))) return false;
  db.run('DELETE FROM friends WHERE user_id = ? AND peer = ?', userId, peer);
  changed(userId);
  return true;
}
// the account's connected clients fetch the lists again
const changed = userId => gateway().pushToUser(userId, { type: 'social_friends_update' });

const areFriends = (user, peer) => row(user.id, peer)?.state === 'friend';
const hasBlocked = (user, peer) => row(user.id, peer)?.state === 'blocked';
const hasFriendAt = (user, domain) => !!db.get("SELECT 1 FROM friends WHERE user_id = ? AND state = 'friend' AND peer LIKE ? LIMIT 1", user.id, '%@' + domain);
// may `from` start a DM with this account? Its own setting decides (dm_from: friends / anyone / nobody); never someone it blocked
function dmAllowed(user, from) {
  const state = row(user.id, from)?.state;
  if (state === 'blocked') return false;
  const rule = require('../communities').getSettings(user).dm_from;
  return rule === 'anyone' || (rule === 'friends' && state === 'friend');
}

// GET /api/v2/social/friends
function list(me) {
  people.mine(me);
  const rows = db.all("SELECT * FROM friends WHERE user_id = ? AND state <> 'blocked_by' ORDER BY updated_at DESC, peer", me.id);
  people.refreshLater(rows.map(r => r.peer));
  const of = state => rows.filter(r => r.state === state).map(r => ({ ...people.snippet(r.peer), since: r.updated_at, ...(r.message ? { message: r.message } : {}) }));
  return { friends: of('friend'), incoming: of('incoming'), outgoing: of('outgoing'), blocked: of('blocked') };
}

// POST /api/v2/social/friends { handle | id, message? }: ask, or accept when they asked first
async function add(me, body = {}) {
  people.mine(me);
  const target = typeof body.id === 'string' && body.id ? await people.findById(body.id) : await people.find(body.handle);
  const my = people.fullId(me), peer = target.id, p = people.parseId(peer);
  if (peer === my) throw err('cannot_friend_yourself', 400);
  const cur = row(me.id, peer)?.state;
  if (cur === 'friend') return { status: 'friends', friend: target };
  if (cur === 'blocked') throw err('user_blocked', 409);
  if (cur === 'blocked_by') throw err('blocked', 403);
  if (cur === 'incoming') return accept(me, peer);
  // asked before: asked again (the other side may have turned it down, or never got it), at most as often as a new request
  if (cur === 'outgoing' && p.local) return { status: 'pending', friend: target };
  if (!cur && db.get('SELECT COUNT(*) AS n FROM friends WHERE user_id = ?', me.id).n >= MAX_FRIENDS) throw err('too_many_friends', 409, { limit: MAX_FRIENDS });
  if (!requestLimit.hit(me.id)) throw err('rate_limited', 429);
  const message = clean(body.message, 200);
  if (p.local) {
    if (hasBlocked(p.user, my)) throw err('blocked', 403);
    db.tx(() => { put(me.id, peer, 'outgoing', message); put(p.user.id, my, 'incoming', message); });
    return { status: 'pending', friend: target };
  }
  const r = await s2s.call(p.domain, 'POST', '/friend_request', { from: my, to: peer, ...(message ? { message } : {}) });
  const friends = r.status === 'friends';
  put(me.id, peer, friends ? 'friend' : 'outgoing', friends ? '' : message);
  return { status: friends ? 'friends' : 'pending', friend: target };
}
// POST /api/v2/social/friends/:id/accept
async function accept(me, rawId) {
  people.mine(me);
  const p = people.mustParse(rawId), my = people.fullId(me);
  if (row(me.id, p.id)?.state !== 'incoming') throw err('no_request', 404);
  if (p.local) db.tx(() => { put(me.id, p.id, 'friend'); put(p.user.id, my, 'friend'); });
  else { await s2s.call(p.domain, 'POST', '/friend_accept', { from: my, to: p.id }); put(me.id, p.id, 'friend'); }
  return { status: 'friends', friend: people.snippet(p.id) };
}
// DELETE /api/v2/social/friends/:id: unfriend, take a request back, or turn one down
function remove(me, rawId) {
  people.mine(me);
  const p = people.mustParse(rawId), my = people.fullId(me);
  if (!drop(me.id, p.id, OPEN)) throw err('not_friends', 404);
  if (p.local) drop(p.user.id, my, OPEN);
  else s2s.later(p.domain, '/friend_remove', { from: my, to: p.id });
  return list(me);
}
// POST /api/v2/social/blocks/:id: whatever was between the two ends; nothing from them is accepted until it is lifted
function block(me, rawId) {
  people.mine(me);
  const p = people.mustParse(rawId), my = people.fullId(me);
  if (p.id === my) throw err('cannot_block_yourself', 400);
  put(me.id, p.id, 'blocked');
  if (p.local) { if (!hasBlocked(p.user, my)) put(p.user.id, my, 'blocked_by'); }
  else s2s.later(p.domain, '/block', { from: my, to: p.id });
  return list(me);
}
// DELETE /api/v2/social/blocks/:id
function unblock(me, rawId) {
  people.mine(me);
  const p = people.mustParse(rawId), my = people.fullId(me);
  if (!drop(me.id, p.id, ['blocked'])) throw err('not_blocked', 404);
  if (p.local) drop(p.user.id, my, ['blocked_by']);
  else s2s.later(p.domain, '/unblock', { from: my, to: p.id });
  return list(me);
}

// ---------- presence between friends ----------
const PRESENCE = ['online', 'idle', 'dnd', 'offline'];
// one of our accounts connected or left: its friends here hear it, and so do the homeservers its other friends are on
function presenceChanged(u, online) {
  if (!require('../auth').hostedHere(u)) return;
  const my = people.fullId(u), status = online ? 'online' : 'offline', domains = new Set();
  for (const f of db.all("SELECT peer FROM friends WHERE user_id = ? AND state = 'friend'", u.id)) {
    const p = people.parseId(f.peer);
    if (p?.local) gateway().pushToUser(p.user.id, { type: 'social_presence', id: my, status });
    else if (p) domains.add(p.domain);
  }
  for (const d of domains) s2s.later(d, '/presence', { from: my, status }, { key: 'presence:' + my }); // only the newest one waits
}

function register(app) {
  app.get('/api/v2/social/friends', req => list(req.user));
  app.post('/api/v2/social/friends', req => add(req.user, req.body));
  app.post('/api/v2/social/friends/:id/accept', req => accept(req.user, req.params.id));
  app.delete('/api/v2/social/friends/:id', req => remove(req.user, req.params.id));
  app.post('/api/v2/social/blocks/:id', req => block(req.user, req.params.id));
  app.delete('/api/v2/social/blocks/:id', req => unblock(req.user, req.params.id));

  s2s.on(app, 'POST', '/friend_request', (req, hs) => {
    const { from, to } = s2s.parties(req.body, hs);
    limits.hit(hs.domain, 'friend_requests');
    const cur = row(to.id, from)?.state;
    if (cur === 'blocked') throw err('blocked', 403);
    // a request from someone this account counts as a friend: their side has lost the friendship (they removed it and the
    // removal never got here), so this side's is stale. It becomes a request again, to be accepted; never a friendship
    // nobody here agreed to
    if (cur === 'friend') { put(to.id, from, 'incoming', clean(req.body.message, 200)); return { status: 'pending' }; }
    if (cur === 'outgoing') { put(to.id, from, 'friend'); return { status: 'friends' }; } // both asked: they are friends
    if (!cur && db.get('SELECT COUNT(*) AS n FROM friends WHERE user_id = ?', to.id).n >= MAX_FRIENDS) throw err('too_many_friends', 409);
    put(to.id, from, 'incoming', clean(req.body.message, 200));
    people.refreshLater([from]);
    return { status: 'pending' };
  });
  s2s.on(app, 'POST', '/friend_accept', (req, hs) => {
    const { from, to } = s2s.parties(req.body, hs);
    const cur = row(to.id, from)?.state;
    if (cur !== 'friend' && cur !== 'outgoing') throw err('no_request', 409);
    if (cur === 'outgoing') put(to.id, from, 'friend');
    return { status: 'friends' };
  });
  s2s.on(app, 'POST', '/friend_remove', (req, hs) => {
    const { from, to } = s2s.parties(req.body, hs);
    drop(to.id, from, OPEN);
    return { ok: true };
  });
  s2s.on(app, 'POST', '/block', (req, hs) => {
    const { from, to } = s2s.parties(req.body, hs);
    if (!hasBlocked(to, from)) put(to.id, from, 'blocked_by');
    return { ok: true };
  });
  s2s.on(app, 'POST', '/unblock', (req, hs) => {
    const { from, to } = s2s.parties(req.body, hs);
    drop(to.id, from, ['blocked_by']);
    return { ok: true };
  });
  // an account of that homeserver connected or left: its friends here are told (nothing is stored)
  s2s.on(app, 'POST', '/presence', (req, hs) => {
    const from = require('../federation/rules').parseSub(req.body?.from);
    if (!from || !PRESENCE.includes(req.body.status)) throw err('invalid_request', 400);
    if (from.domain !== hs.domain) throw err('from_mismatch', 403);
    const id = `${from.id}@${from.domain}`;
    for (const f of db.all("SELECT user_id FROM friends WHERE peer = ? AND state = 'friend'", id)) gateway().pushToUser(f.user_id, { type: 'social_presence', id, status: req.body.status });
    return { ok: true };
  });
}

module.exports = { register, list, add, accept, remove, block, unblock, areFriends, hasBlocked, hasFriendAt, dmAllowed, presenceChanged, row, _test: { requestLimit } };
