'use strict';
// Which clients a member is connected with right now (PROTOCOL §7.1): one entry per live gateway connection (Ember, a third-party
// app or a bot), each with a `via` like the one messages carry. Only the person themselves and members holding Manage users in a
// server they share see it (the same rule as Velora's presence `sessions`), checked again on every reply and every live update.
const db = require('./db');
const { err, normalizeOrigin } = require('./util');
const { P } = require('./perms');

const C = () => require('./communities');
const G = () => require('./gateway');
const B = () => require('./bots');

const MAX_SESSIONS = 8, MAX_WATCHES = 16, PUSH_DELAY_MS = 250;
const STATES = new Set(['active', 'background', 'notifications']);
const clean = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');

// ---------- describing one connection ----------
// platform / browser from the User-Agent, coarse on purpose (no versions, no device model)
function uaInfo(ua) {
  const s = String(ua || '');
  if (!/^Mozilla\//.test(s)) return {}; // a library or a script: say nothing rather than guess
  const platform = /Android/.test(s) ? 'Android' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /CrOS/.test(s) ? 'ChromeOS' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : null;
  const browser = /\bElectron\//.test(s) ? 'Electron' : /\bEdg\//.test(s) ? 'Edge' : /\bOPR\//.test(s) ? 'Opera' : /\bFirefox\//.test(s) ? 'Firefox' : /\bChrome\//.test(s) ? 'Chrome' : /\bSafari\//.test(s) ? 'Safari' : null;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/.test(s);
  return { ...(platform ? { platform } : {}), ...(browser ? { browser } : {}), ...(mobile ? { mobile: true } : {}) };
}
// the `via` of a connection: the page's origin (never an IP address), the official apps' kind, the registered app it signed in through
function viaOf(origin, ua, app, extra = {}) {
  const M = require('./messages');
  const kind = M.appKind(ua);
  let url = null;
  if (origin) { const o = normalizeOrigin(origin); if (o && !/^https?:\/\/([\d.]+|\[.*\])(:|$)/.test(o)) url = o.slice(0, 120); }
  const v = { ...(url ? { url } : {}), ...(kind ? { kind } : {}), ...extra };
  if (app?.id) Object.assign(v, { app: app.id, ...(app.name ? { token: app.name } : {}), ...(app.icon ? { icon: app.icon } : {}) });
  return v;
}
// what a client may say about itself in its `auth` frame: { version?, platform?, device? }, trimmed and capped
function clientInfo(c) {
  if (!c || typeof c !== 'object') return null;
  const o = {};
  for (const [k, n] of [['version', 24], ['platform', 24], ['device', 40]]) { const v = clean(c[k], n); if (v) o[k] = v; }
  return Object.keys(o).length ? o : null;
}
// one /gateway socket -> its entry
function socketEntry(st) {
  const ua = uaInfo(st.ua), ci = st.client || {};
  return {
    via: viaOf(st.origin, st.ua, st.app),
    state: st.clientState || 'active',
    ...ua, ...(ci.platform ? { platform: ci.platform } : {}), ...(ci.device ? { device: ci.device } : {}), ...(ci.version ? { version: ci.version } : {}),
    ...(st.mobile ? { mobile: true } : {}),
    connected_at: st.connectedAt,
  };
}
// one /bot/gateway connection -> its entry
function botEntry(g) {
  return { via: viaOf(g.origin, g.ua, null, { kind: 'bot' }), state: 'active', ...uaInfo(g.ua), connected_at: g.connectedAt };
}
// everything a user is connected with now, oldest first, at most 8 (the newest ones)
function sessionsOf(userId) {
  const list = [];
  for (const sock of G().socketsOf(userId)) if (sock.bf?.authed && sock.readyState === 1) list.push(socketEntry(sock.bf));
  for (const g of B().gatewaysOf(userId)) list.push(botEntry(g));
  list.sort((a, b) => a.connected_at - b.connected_at);
  return list.slice(-MAX_SESSIONS);
}

// ---------- who may see them ----------
// the person themselves, or a member holding Manage users in this server who shares it with them
function maySee(snap, viewerId, targetId) {
  if (!snap.isMember(viewerId) || !snap.isMember(targetId)) return false;
  return Number(viewerId) === Number(targetId) || snap.can(viewerId, P.MANAGE_USERS);
}
function view(c, u) {
  const sessions = sessionsOf(u.id);
  return { server: c.sid, user_id: u.principal, online: sessions.length > 0, sessions, last_online: sessions.length ? null : u.last_online || null };
}
// GET /servers/:sid/members/:uid/clients
function memberClients(sid, me, principal) {
  const { c, snap } = C().memberCommunity(sid, me);
  const u = C().userByPrincipalOrThrow(principal);
  if (!snap.isMember(u.id)) throw err('user_not_found', 404);
  if (!maySee(snap, me.id, u.id)) throw err('not_allowed', 403);
  return view(c, u);
}

// ---------- live updates (chat_clients_watch) ----------
// sock.bf.watching: Map(key -> { communityId, userId }); watchers: userId -> Set(sock)
const watchers = new Map();
const key = (communityId, userId) => `${communityId}:${userId}`;
function watch(sock, me, server, principal) {
  const { c, snap } = C().memberCommunity(server, me);
  const u = C().userByPrincipalOrThrow(principal);
  if (!snap.isMember(u.id)) throw err('user_not_found', 404);
  if (!maySee(snap, me.id, u.id)) throw err('not_allowed', 403);
  const w =sock.bf.watching || (sock.bf.watching = new Map());
  const k = key(c.id, u.id);
  w.delete(k);
  w.set(k, { communityId: c.id, userId: u.id });
  while (w.size > MAX_WATCHES) { const [oldK, old] = w.entries().next().value; w.delete(oldK); dropWatcher(sock, old.userId); }
  if (!watchers.has(u.id)) watchers.set(u.id, new Set());
  watchers.get(u.id).add(sock);
  return view(c, u);
}
function dropWatcher(sock, userId) {
  if ([...(sock.bf.watching?.values() || [])].some(x => x.userId === userId)) return; // (still watching them in another server)
  const set = watchers.get(userId);
  set?.delete(sock);
  if (set && !set.size) watchers.delete(userId);
}
// no server / user: stop watching everyone
function unwatch(sock, me, server, principal) {
  const w = sock.bf.watching;
  if (!w?.size) return;
  if (server == null && principal == null) { const ids = new Set([...w.values()].map(x => x.userId)); w.clear(); ids.forEach(id => dropWatcher(sock, id)); return; }
  for (const [k, x] of [...w]) {
    const c = server != null ? db.get('SELECT id FROM communities WHERE sid = ?', String(server)) : null;
    const u = principal != null ? db.get('SELECT id FROM users WHERE principal = ?', String(principal)) : null;
    if ((server == null || x.communityId === c?.id) && (principal == null || x.userId === u?.id)) { w.delete(k); dropWatcher(sock, x.userId); }
  }
}
function socketClosed(sock) {
  const w = sock.bf?.watching;
  if (!w?.size) return;
  const ids = new Set([...w.values()].map(x => x.userId));
  w.clear();
  ids.forEach(id => dropWatcher(sock, id));
}
// a user's connections changed (connected, left, changed state): tell whoever watches them, a moment later so a reconnect is one update
const pending = new Map();
function changed(userId) {
  userId = Number(userId);
  if (!watchers.has(userId) || pending.has(userId)) return;
  const t = setTimeout(() => { pending.delete(userId); try { if (db.raw()) push(userId); } catch (e) { console.error('[clients] push', e.message); } }, PUSH_DELAY_MS);
  t.unref?.();
  pending.set(userId, t);
}
function push(userId) {
  const set = watchers.get(userId);
  if (!set?.size) return;
  const u = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!u) return;
  for (const sock of [...set]) {
    if (sock.readyState !== 1) continue;
    for (const [k, x] of [...(sock.bf.watching || [])]) {
      if (x.userId !== userId) continue;
      const c = db.get('SELECT * FROM communities WHERE id = ?', x.communityId), snap = c && C().snapOf(c);
      // lost Manage users, left, or they left: the watch ends (and the client hears so)
      if (!snap || !maySee(snap, sock.bf.user.id, userId)) { sock.bf.watching.delete(k); dropWatcher(sock, userId); if (c) G().send(sock, { type: 'chat_clients', server: c.sid, user_id: u.principal, ended: true }); continue; }
      G().send(sock, { type: 'chat_clients', ...view(c, u) });
    }
  }
}
function setState(sock, state) {
  if (!STATES.has(state) || sock.bf.clientState === state) return;
  sock.bf.clientState = state;
  changed(sock.bf.user.id);
}
const _reset = () => { watchers.clear(); for (const t of pending.values()) clearTimeout(t); pending.clear(); };

module.exports = { uaInfo, viaOf, clientInfo, sessionsOf, maySee, memberClients, watch, unwatch, socketClosed, changed, setState, MAX_SESSIONS, MAX_WATCHES, _reset };
