'use strict';
// Channel and category permission overwrites (PROTOCOL §6.5), Discord-style: for a role or for one member (a local account, a
// Nookara account, or an account of another homeserver like "l:5@b.example"), each { allow, deny } of channel permissions
// (perms.js CHANNEL_BITS). A channel either has its own overwrites or follows its category's (perms_synced). Resolution is
// perms.channelPerms; this file is the API:
//   GET    /api/v1/servers/:sid/channels/:cid/overwrites                      -> { overwrites, perms_synced, category }
//   PUT    /api/v1/servers/:sid/channels/:cid/overwrites  { overwrites: [...] } replace all of them
//   PUT    /api/v1/servers/:sid/channels/:cid/overwrites/:type/:id { allow, deny }  one (type: role | member)
//   DELETE /api/v1/servers/:sid/channels/:cid/overwrites/:type/:id
//   POST   /api/v1/servers/:sid/channels/:cid/overwrites/sync                 follow the category again (own ones go)
//   the same under /api/v1/servers/:sid/categories/:name/overwrites (no sync)
//   GET    /api/v1/servers/:sid/channels/:cid/permissions/:principal          what that member may do there
// allow / deny take a number or a list of names (perms.NAMES); views carry both.
// Who may change them: the owner, Administrator, or whoever has Manage roles (manage_permissions) or Manage channels
// (manage_channel) in that channel. Nobody hands out or takes away a permission they don't have there themselves, edits a
// role at or above their own highest one, touches the owner, or leaves themselves unable to see and manage the channel.
const db = require('./db');
const perms = require('./perms');
const { err } = require('./util');
const { P, CHANNEL_BITS, ALL_PERMS } = perms;
const C = () => require('./communities');
const gateway = () => require('./gateway');
const audit = (...a) => require('./audit').record(...a);

const MAX = 200; // overwrites per channel or category
const TYPES = ['role', 'member'];

// ---------- views ----------
function owView(snap, type, id, o) {
  let target;
  if (type === 'role') { const r = snap.roles.find(x => x.id === id); if (!r) return null; target = { id: r.rid, name: r.name, everyone: !!r.is_default }; }
  else { const u = require('./auth').userById(id); if (!u) return null; target = { id: u.principal, name: u.username, display_name: u.display_name }; }
  return { type, ...target, allow: o.allow, deny: o.deny, allow_names: perms.namesOf(o.allow), deny_names: perms.namesOf(o.deny) };
}
function listOf(snap, set) {
  if (!set) return [];
  const out = [];
  for (const [id, o] of set.roles) { const v = owView(snap, 'role', id, o); if (v) out.push(v); }
  for (const [id, o] of set.members) { const v = owView(snap, 'member', id, o); if (v) out.push(v); }
  return out;
}
const channelView = (snap, ch) => ({ overwrites: listOf(snap, snap.owFor(ch)), own: listOf(snap, snap.cow.get(ch.id)), perms_synced: !!ch.perms_synced, category: ch.category || null });

// ---------- targets and scopes ----------
// a role by its rid ("everyone" / the @everyone rid both mean @everyone), a member by principal
function target(snap, type, id) {
  if (!TYPES.includes(type)) throw err('invalid_overwrite_type');
  const raw = decodeURIComponent(String(id || ''));
  if (type === 'role') {
    const r = raw === 'everyone' ? snap.everyone : snap.roles.find(x => x.rid === raw);
    if (!r) throw err('role_not_found', 404);
    return { type, id: r.id, role: r };
  }
  const u = require('./auth').userByPrincipal(raw);
  if (!u || !db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', snap.c.id, u.id)) throw err('member_not_found', 404);
  return { type, id: u.id, user: u };
}
// a channel (by cid, in this server) or a category (by name)
function scopeOf(sid, me, { cid = null, category = null }) {
  const { c, snap } = C().memberCommunity(sid, me);
  if (cid != null) {
    const ch = snap.channels.find(x => x.cid === String(cid));
    if (!ch || !snap.canView(ch, me.id)) throw err('channel_not_found', 404);
    return { c, snap, ch };
  }
  const name = decodeURIComponent(String(category || ''));
  if (!C().categoriesOf(c).includes(name)) throw err('category_not_found', 404);
  return { c, snap, category: name };
}
// the permissions `me` has where the overwrites apply: a channel's, or for a category the server-wide ones and the category's
// own overwrites (as a channel following it would get)
function permsIn(snap, scope, uid) {
  if (scope.ch) return snap.canView(scope.ch, uid) ? snap.chPerms(scope.ch, uid) : 0;
  const o = snap.kow.get(scope.category);
  return perms.channelPerms(snap.perms(uid), { overwrites: o?.roles, everyoneId: snap.everyone?.id, roleIds: snap.roleIds(uid), member: o?.members.get(Number(uid)) || null });
}
const isBoss = (snap, uid) => snap.isOwner(uid) || snap.perms(uid) === ALL_PERMS;
function assertMayEdit(snap, scope, me) {
  if (isBoss(snap, me.id)) return;
  const p = permsIn(snap, scope, me.id);
  if (!(p & (P.MANAGE_ROLES | P.MANAGE_CHANNELS))) throw err('not_allowed', 403);
}
// one change, checked: -> { allow, deny } to store (or null to remove). An entry that does not change is not checked (a list sent
// back whole may name overwrites of roles above you as they are); removing one on the owner is always fine
function checked(snap, scope, me, t, want, existing) {
  const allow = perms.bitsFrom(want?.allow), deny = perms.bitsFrom(want?.deny);
  if (allow === null || deny === null) throw err('invalid_permissions');
  if ((allow | deny) & ~CHANNEL_BITS) throw err('not_a_channel_permission', 400, { bits: (allow | deny) & ~CHANNEL_BITS, names: perms.namesOf((allow | deny) & ~CHANNEL_BITS, perms.SERVER_NAMES) });
  const next = { allow: allow & ~deny, deny };
  const was0 = existing || { allow: 0, deny: 0 };
  if (next.allow === was0.allow && next.deny === was0.deny) return next.allow || next.deny ? next : null; // (unchanged)
  const removing = !next.allow && !next.deny;
  if (t.type === 'member' && snap.isOwner(t.id) && !removing) throw err('owner_not_affected', 400); // (the owner is never limited: nothing to set)
  if (!isBoss(snap, me.id)) {
    if (t.type === 'role' && !t.role.is_default && t.role.position >= snap.top(me.id)) throw err('role_too_high', 403);
    if (t.type === 'member' && Number(t.id) !== Number(me.id) && !snap.isOwner(t.id) && snap.top(t.id) > snap.top(me.id)) throw err('member_too_high', 403); // (someone above you)
  }
  if (!isBoss(snap, me.id)) {
    const mine = permsIn(snap, scope, me.id) | P.VIEW;
    const was = existing || { allow: 0, deny: 0 };
    const changed = (next.allow ^ was.allow) | (next.deny ^ was.deny);
    if (changed & ~mine) throw err('cannot_grant', 403, { names: perms.namesOf(changed & ~mine) });
  }
  return next.allow || next.deny ? next : null;
}

// ---------- writing ----------
// a channel following its category gets its own copy first (editing it stops the following)
function unsync(scope, c) {
  if (!scope.ch || !scope.ch.perms_synced) return;
  db.run('DELETE FROM perm_overwrites WHERE channel_id = ?', scope.ch.id);
  if (scope.ch.category) {
    for (const o of db.all('SELECT * FROM perm_overwrites WHERE community_id = ? AND category = ?', c.id, scope.ch.category)) {
      db.run('INSERT INTO perm_overwrites (community_id, channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?, ?)', c.id, scope.ch.id, o.target_type, o.target_id, o.allow, o.deny);
    }
  }
  db.run('UPDATE channels SET perms_synced = 0 WHERE id = ?', scope.ch.id);
}
function put(scope, c, t, o) {
  if (scope.ch) {
    db.run('DELETE FROM perm_overwrites WHERE channel_id = ? AND target_type = ? AND target_id = ?', scope.ch.id, t.type, t.id);
    if (o) db.run('INSERT INTO perm_overwrites (community_id, channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?, ?)', c.id, scope.ch.id, t.type, t.id, o.allow, o.deny);
  } else {
    db.run('DELETE FROM perm_overwrites WHERE community_id = ? AND category = ? AND target_type = ? AND target_id = ?', c.id, scope.category, t.type, t.id);
    if (o) db.run('INSERT INTO perm_overwrites (community_id, category, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?, ?)', c.id, scope.category, t.type, t.id, o.allow, o.deny);
  }
}
// the change must leave the person able to see the channel (or a channel of the category) and change its permissions again
function assertNotLockedOut(c, scope, me) {
  const snap = C().snapOf(c);
  if (isBoss(snap, me.id)) return;
  if (scope.ch) {
    const ch = snap.channel(scope.ch.id);
    if (!snap.canView(ch, me.id) || !(snap.chPerms(ch, me.id) & (P.MANAGE_ROLES | P.MANAGE_CHANNELS))) throw err('would_lock_you_out', 400);
  } else if (!(permsIn(snap, { category: scope.category }, me.id) & (P.MANAGE_ROLES | P.MANAGE_CHANNELS)) || !((permsIn(snap, { category: scope.category }, me.id) & P.VIEW) || (snap.perms(me.id) & P.MANAGE_CHANNELS))) throw err('would_lock_you_out', 400);
}
function changed(c, scope, me, action, details) {
  C().channelsChanged(c);
  gateway().emit(c.id, { type: 'chat_perms_changed', server: c.sid, ...(scope.ch ? { channel: scope.ch.cid } : { category: scope.category }) });
  audit(c, me, action, { target: scope.ch ? { kind: 'channel', id: scope.ch.cid, name: scope.ch.name } : { kind: 'category', id: scope.category, name: scope.category }, details });
}
const label = t => (t.type === 'role' ? (t.role.is_default ? '@everyone' : t.role.name) : t.user.principal);
const answer = (c, scope) => { const snap = C().snapOf(c); return scope.ch ? channelView(snap, snap.channel(scope.ch.id)) : { overwrites: listOf(snap, snap.kow.get(scope.category)), category: scope.category }; };

function setOne(sid, me, where_, type, id, body = {}) {
  const scope = scopeOf(sid, me, where_);
  const { c, snap } = scope;
  assertMayEdit(snap, scope, me);
  const t = target(snap, type, id);
  const set = scope.ch ? snap.owFor(scope.ch) : snap.kow.get(scope.category);
  const existing = set?.[t.type === 'role' ? 'roles' : 'members'].get(Number(t.id)) || null;
  const o = checked(snap, scope, me, t, body, existing);
  db.tx(() => { unsync(scope, c); put(scope, c, t, o); assertNotLockedOut(c, scope, me); });
  changed(c, scope, me, o ? 'channel_overwrite_update' : 'channel_overwrite_delete', { type: t.type, target: label(t), ...(o ? { allow: perms.namesOf(o.allow), deny: perms.namesOf(o.deny) } : {}) });
  return answer(c, scope);
}
const removeOne = (sid, me, where_, type, id) => setOne(sid, me, where_, type, id, { allow: 0, deny: 0 });
// from the overwrites there now (`from`) to `wanted` (Map "type:id" -> { t, x }): every entry that changes is checked like a
// single edit, the ones that go included. -> [[t, o]]
function plan(snap, scope, me, from, wanted) {
  const ops = [];
  for (const { t, x } of wanted.values()) ops.push([t, checked(snap, scope, me, t, x, from?.[t.type === 'role' ? 'roles' : 'members'].get(Number(t.id)) || null)]);
  for (const [kind, map] of [['role', from?.roles], ['member', from?.members]]) for (const [id, o] of map || []) {
    if (wanted.has(`${kind}:${id}`)) continue;
    const t = kind === 'role' ? { type: 'role', id, role: snap.roles.find(r => r.id === id) } : { type: 'member', id, user: require('./auth').userById(id) };
    if (!t.role && !t.user) continue;
    ops.push([t, checked(snap, scope, me, t, { allow: 0, deny: 0 }, o)]);
  }
  return ops;
}
const asWanted = set => new Map([...[...(set?.roles || [])].map(([id, o]) => [`role:${id}`, { t: { type: 'role', id }, x: o }]), ...[...(set?.members || [])].map(([id, o]) => [`member:${id}`, { t: { type: 'member', id }, x: o }])]);
// the whole list: [{ type, id, allow, deny }] (ones not named go)
function replaceAll(sid, me, where_, list) {
  const scope = scopeOf(sid, me, where_);
  const { c, snap } = scope;
  assertMayEdit(snap, scope, me);
  if (!Array.isArray(list) || list.length > MAX) throw err('invalid_overwrites');
  const set = scope.ch ? snap.owFor(scope.ch) : snap.kow.get(scope.category);
  const wanted = new Map();
  for (const x of list) { const t = target(snap, x?.type, x?.id); wanted.set(`${t.type}:${t.id}`, { t, x }); }
  const ops = plan(snap, scope, me, set, wanted);
  db.tx(() => { unsync(scope, c); for (const [t, o] of ops) put(scope, c, t, o); assertNotLockedOut(c, scope, me); });
  changed(c, scope, me, 'channel_overwrites_replace', { count: ops.filter(([, o]) => o).length });
  return answer(c, scope);
}
// follow the category again: the channel's own overwrites go and the category's apply. That is a change from one set to the other,
// checked entry by entry like any edit (nobody drops a deny they could not set, or inherits something they could not grant)
function sync(sid, me, cid) {
  const scope = scopeOf(sid, me, { cid });
  const { c, snap } = scope;
  assertMayEdit(snap, scope, me);
  if (!scope.ch.category) throw err('no_category');
  if (!scope.ch.perms_synced) {
    const cat = snap.kow.get(scope.ch.category), wanted = asWanted(cat);
    for (const w of wanted.values()) { const r = w.t.type === 'role' ? snap.roles.find(x => x.id === w.t.id) : null; w.t = w.t.type === 'role' ? { ...w.t, role: r } : { ...w.t, user: require('./auth').userById(w.t.id) }; if (!w.t.role && !w.t.user) wanted.delete(`${w.t.type}:${w.t.id}`); }
    plan(snap, scope, me, snap.cow.get(scope.ch.id), wanted);
  }
  db.tx(() => {
    db.run('DELETE FROM perm_overwrites WHERE channel_id = ?', scope.ch.id);
    db.run('UPDATE channels SET perms_synced = 1 WHERE id = ?', scope.ch.id);
    assertNotLockedOut(c, scope, me);
  });
  changed(c, scope, me, 'channel_overwrites_sync', { category: scope.ch.category });
  return answer(c, scope);
}
function list(sid, me, where_) {
  const scope = scopeOf(sid, me, where_);
  const may = isBoss(scope.snap, me.id) || !!(permsIn(scope.snap, scope, me.id) & (P.MANAGE_ROLES | P.MANAGE_CHANNELS));
  if (!scope.ch && !may && !scope.snap.channels.some(ch => ch.category === scope.category && scope.snap.canView(ch, me.id))) throw err('category_not_found', 404);
  const out = answer(scope.c, scope);
  if (may) return out;
  const roles = l => (l || []).filter(o => o.type !== 'member');
  return { ...out, overwrites: roles(out.overwrites), ...(out.own ? { own: roles(out.own) } : {}) };
}
// what a member may do in a channel: { allow, names, view, post }. Themselves, or people who manage the channel's permissions
function effective(sid, me, cid, principal) {
  const { snap, ch } = scopeOf(sid, me, { cid });
  const u = require('./auth').userByPrincipal(decodeURIComponent(String(principal || '')));
  if (!u || !snap.isMember(u.id)) throw err('member_not_found', 404);
  if (Number(u.id) !== Number(me.id) && !isBoss(snap, me.id) && !(snap.chPerms(ch, me.id) & (P.MANAGE_ROLES | P.MANAGE_CHANNELS))) throw err('not_allowed', 403);
  const view = snap.canView(ch, u.id), p = view ? snap.chPerms(ch, u.id) & CHANNEL_BITS : 0;
  return { member: u.principal, channel: ch.cid, view, post: snap.canPost(ch, u.id), owner: snap.isOwner(u.id), administrator: snap.perms(u.id) === ALL_PERMS && !snap.isOwner(u.id),
    allow: p, names: perms.namesOf(p), server: snap.perms(u.id), server_names: perms.namesOf(snap.perms(u.id), perms.ROLE_NAMES) };
}

function register(app) {
  const ch = '/api/v1/servers/:sid/channels/:cid/overwrites', cat = '/api/v1/servers/:sid/categories/:name/overwrites';
  app.get(ch, req => list(req.params.sid, req.user, { cid: req.params.cid }));
  app.put(ch, req => replaceAll(req.params.sid, req.user, { cid: req.params.cid }, req.body?.overwrites));
  app.post(ch + '/sync', req => sync(req.params.sid, req.user, req.params.cid));
  app.put(ch + '/:type/:id', req => setOne(req.params.sid, req.user, { cid: req.params.cid }, req.params.type, req.params.id, req.body || {}));
  app.delete(ch + '/:type/:id', req => removeOne(req.params.sid, req.user, { cid: req.params.cid }, req.params.type, req.params.id));
  app.get(cat, req => list(req.params.sid, req.user, { category: req.params.name }));
  app.put(cat, req => replaceAll(req.params.sid, req.user, { category: req.params.name }, req.body?.overwrites));
  app.put(cat + '/:type/:id', req => setOne(req.params.sid, req.user, { category: req.params.name }, req.params.type, req.params.id, req.body || {}));
  app.delete(cat + '/:type/:id', req => removeOne(req.params.sid, req.user, { category: req.params.name }, req.params.type, req.params.id));
  app.get('/api/v1/servers/:sid/channels/:cid/permissions/:principal', req => effective(req.params.sid, req.user, req.params.cid, req.params.principal));
  // the names and bits, for clients building an editor
  app.get('/api/v1/permissions', { auth: false }, () => ({ channel: perms.NAMES, role: perms.ROLE_NAMES, channel_bits: CHANNEL_BITS, all: perms.ALL_PERMS }));
}

module.exports = { register, channelView, listOf, setOne, replaceAll, sync, effective, target, checked, permsIn };
