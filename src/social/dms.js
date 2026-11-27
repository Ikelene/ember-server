'use strict';
// DMs (PROTOCOL §4c). A DM, between two people or a group, lives on the homeserver of whoever starts it and nowhere else:
// here it is a community of kind 'dm' with one text channel, so messages, uploads, reactions, read state and the gateway
// all work as they do in a server (and none of what makes a server a server does: communities.js findCommunity). Members
// from other homeservers use it with a cross-homeserver session, and their homeserver keeps a pointer (table dm_pointers)
// so the DM shows in their list and they hear about new messages: the host sends dm_pointer and dm_activity over s2s.
//   communities.join_policy of a DM: 'dm' (two people, fixed) or 'group' (named, an owner who can remove people)
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const { err, now, clean, randId, limiter } = require('../util');
const { P } = require('../perms');
const R = require('../federation/rules');
const limits = require('../federation/limits');
const s2s = require('./s2s');
const people = require('./people');
const friends = require('./friends');
const where = require('./where');
const gateway = () => require('../gateway');
const C = () => require('../communities');

const MAX_MEMBERS = 10, MAX_POINTERS = 500;
const createLimit = limiter(30, 3600 * 1000); // DMs started per account
let WINDOW = 1000;                            // messages within this long become one dm_activity

const own = () => config.domain();
const idOf = c => `${c.sid}@${own()}`;
const isGroup = c => c.join_policy === 'group';
const channelOf = c => db.get('SELECT * FROM channels WHERE community_id = ? ORDER BY id LIMIT 1', c.id);
const membersOf = c => db.all('SELECT u.* FROM users u JOIN members m ON m.user_id = u.id WHERE m.community_id = ? ORDER BY m.joined_at, u.id', c.id);
const isMember = (c, userId) => !!db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', c.id, userId);

// ---------- DMs hosted here ----------
// what the other homeservers are told about a DM (dm_pointer), and the base of what clients see
function describe(c) {
  const owner = isGroup(c) ? auth.userById(c.owner_id) : null;
  return {
    id: idOf(c), host: own(), name: isGroup(c) ? c.name || null : null, group: isGroup(c), owner: owner ? people.fullId(owner) : null,
    sid: c.sid, channel: channelOf(c)?.cid || null, members: membersOf(c).map(people.snippetOf), created_at: c.created_at, e2ee: true,
  };
}
function view(c, me) {
  const ch = channelOf(c);
  const read = db.get('SELECT last_read_id FROM read_state WHERE user_id = ? AND channel_id = ?', me.id, ch.id)?.last_read_id ?? 0;
  const unread = db.get('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND id > ? AND (user_id IS NULL OR user_id <> ?)', ch.id, read, me.id).n;
  const last = db.get('SELECT created_at FROM messages WHERE id = ?', ch.last_message_id)?.created_at;
  return { ...describe(c), host_origin: config.publicUrl(), last_message_id: String(ch.last_message_id || 0), unread, mention: false, hosted_here: true, updated_at: last || c.created_at };
}
// "<sid>@<this homeserver>" (or just the sid) -> the DM, for one of its members
function hosted(rawId, me) {
  const [sid, domain] = String(rawId || '').split('@');
  const c = !domain || domain.toLowerCase() === own() ? db.get("SELECT * FROM communities WHERE sid = ? AND kind = 'dm'", sid) : null;
  if (!c || !isMember(c, me.id)) throw err('dm_not_found', 404);
  return c;
}
// where a member hears about a DM hosted here: the homeserver of an account of another one, or the place config
// `social.s2s_url` names for a Nookara account of this one. -> { domain, to } | null (the DM list is kept here)
function peerOf(u) {
  if (u.kind === 'remote') return { domain: u.domain, to: u.principal };
  if (where.s2sElsewhere(u)) return { domain: own(), to: people.fullId(u) };
  return null;
}
const notHere = id => { const d = String(id).split('@')[1]; return !!d && d.toLowerCase() !== own(); };
// every member's connected clients here get the DM as they see it
function announce(c) { for (const u of membersOf(c)) gateway().pushToUser(u.id, { type: 'social_dm_update', dm: view(c, u) }); }
// the homeservers of the members who live elsewhere hear that the DM changed (its name, who is in it)
function tellOthers(c, kind = 'renamed') {
  const dm = describe(c);
  for (const u of membersOf(c)) { const p = peerOf(u); if (p) s2s.later(p.domain, '/dm_pointer', { dm, to: p.to, kind }); }
}
// the user row of an account of another homeserver, made when it is first named here (its first sign-in fills it in)
function remoteUser(s) {
  const row = auth.userByPrincipal(s.id);
  if (row) return row.kind === 'remote' && !row.banned ? row : null;
  const domain = R.parseSub(s.id).domain;
  const r = db.run("INSERT INTO users (principal, kind, username, display_name, pfp, domain, created_at) VALUES (?, 'remote', ?, ?, ?, ?, ?)", s.id, s.handle || s.id, s.display_name || s.handle || s.id, s.avatar_url, domain, now());
  return auth.userById(r.lastInsertRowid);
}

// POST /api/v2/social/dms { members: [handle], member_ids?: [id], name?, group? }: starts a DM here
async function create(me, body = {}) {
  people.mineForDms(me);
  const my = people.fullId(me);
  const handles = Array.isArray(body.members) ? body.members : [], given = Array.isArray(body.member_ids) ? body.member_ids : [];
  if (handles.length + given.length < 1 || handles.length + given.length > MAX_MEMBERS * 2 || [...handles, ...given].some(x => typeof x !== 'string')) throw err('invalid_members', 400);
  const found = new Map();
  for (const h of handles) { const s = await people.find(h); found.set(s.id, s); }
  for (const id of given) { const s = await people.findById(id); found.set(s.id, s); }
  found.delete(my);
  const others = [...found.values()];
  if (!others.length || others.length > MAX_MEMBERS - 1) throw err('invalid_members', 400, { max: MAX_MEMBERS });
  const group = others.length > 1 || body.group === true;
  const name = group ? clean(body.name, 60) : '';
  if (!group) { const have = between(me, others[0].id); if (have) return { dm: have, created: false }; }
  if (!createLimit.hit(me.id)) throw err('rate_limited', 429);
  // every member decides who may start a DM with them: accounts here are asked here, the others through their homeserver
  const users = [];
  for (const s of others) {
    if (friends.hasBlocked(me, s.id)) throw err('user_blocked', 409, { member: s.id });
    const p = people.parseId(s.id);
    if (p.local && where.s2sElsewhere(p.user)) { users.push(p.user); continue; } // asked where its social API is, below
    if (p.local) { if (!friends.dmAllowed(p.user, my)) throw err('dm_not_allowed', 403, { member: s.id }); users.push(p.user); continue; }
    s2s.assertPeer(p.domain);
    const u = remoteUser(s);
    if (!u) throw err('dm_not_allowed', 403, { member: s.id });
    users.push(u);
  }
  const sid = randId('d'), cid = randId('c'), t = now();
  const dm = { id: `${sid}@${own()}`, host: own(), name: name || null, group, owner: group ? my : null, sid, channel: cid, members: [people.snippetOf(me), ...others], created_at: t, e2ee: true };
  const told = [];
  for (const u of users) {
    const to = peerOf(u);
    if (!to) continue;
    try { await s2s.call(to.domain, 'POST', '/dm_pointer', { dm, to: to.to, kind: 'added', from: my }); told.push(to); }
    catch (e) {
      for (const x of told) s2s.later(x.domain, '/dm_pointer', { dm, to: x.to, kind: 'removed' });
      throw err(e.code, e.status, { ...(e.extra || {}), member: to.to });
    }
  }
  const c = db.tx(() => {
    const r = db.run("INSERT INTO communities (sid, slug, name, description, owner_id, invite_code, join_policy, listed, created_at, categories, kind, allow_uploads) VALUES (?, NULL, ?, '', ?, ?, ?, 0, ?, '[]', 'dm', 1)",
      sid, name, me.id, 'dm-' + randId(''), group ? 'group' : 'dm', t);
    const id = r.lastInsertRowid;
    C().insertRole(id, { name: '@everyone', permissions: P.SEND | P.ATTACH | require('../perms').MEMBER_DEFAULT, is_default: 1, position: 0 }); // (reactions, history, voice: PROTOCOL §6.5)
    db.run("INSERT INTO channels (cid, community_id, name, type, config, created_at) VALUES (?, ?, 'dm', 'text', '{}', ?)", cid, id, t);
    for (const u of [me, ...users]) db.run('INSERT INTO members (community_id, user_id, joined_at) VALUES (?, ?, ?)', id, u.id, t);
    return db.get('SELECT * FROM communities WHERE id = ?', id);
  });
  for (const u of [me, ...users]) gateway().subscribe(u.id, c.id);
  // the starter's own DM list, when it is kept elsewhere, gets the pointer too
  const mine = peerOf(me);
  if (mine) s2s.later(mine.domain, '/dm_pointer', { dm, to: mine.to, kind: 'added', from: my });
  announce(c);
  return { dm: view(c, me), created: true };
}
// the DM between me and one other account, wherever it lives: hosted here, or a pointer to theirs
function between(me, peer) {
  const p = people.parseId(peer), other = p?.local ? p.user : auth.userByPrincipal(peer);
  if (other) {
    const c = db.get("SELECT c.* FROM communities c JOIN members a ON a.community_id = c.id AND a.user_id = ? JOIN members b ON b.community_id = c.id AND b.user_id = ? WHERE c.kind = 'dm' AND c.join_policy = 'dm' ORDER BY c.id LIMIT 1", me.id, other.id);
    if (c) return view(c, me);
  }
  if (p?.local) return null;
  const row = db.all('SELECT * FROM dm_pointers WHERE user_id = ? AND host_domain = ?', me.id, p.domain).find(r => { const x = pointerView(r); return !x.group && x.members.some(m => m.id === peer); });
  return row ? pointerView(row) : null;
}

// someone is out of a DM hosted here (they left, or the owner removed them)
function takeOut(c, u) {
  const ch = channelOf(c);
  db.tx(() => {
    db.run('DELETE FROM members WHERE community_id = ? AND user_id = ?', c.id, u.id);
    db.run('DELETE FROM read_state WHERE user_id = ? AND channel_id = ?', u.id, ch.id);
  });
  gateway().unsubscribe(u.id, c.id);
  gateway().pushToUser(u.id, { type: 'social_dm_remove', id: idOf(c) });
  const out = peerOf(u);
  if (out) s2s.later(out.domain, '/dm_pointer', { dm: { id: idOf(c), host: own() }, to: out.to, kind: 'removed' });
  const left = membersOf(c);
  if (!left.length) { db.run('DELETE FROM communities WHERE id = ?', c.id); gateway().dropCommunity(c.id); return; }
  if (Number(c.owner_id) === Number(u.id)) { db.run('UPDATE communities SET owner_id = ? WHERE id = ?', left[0].id, c.id); c = db.get('SELECT * FROM communities WHERE id = ?', c.id); } // the longest-standing member takes over
  announce(c);
  tellOthers(c);
}
const group = c => { if (!isGroup(c)) throw err('not_a_group', 400); return c; };

// PATCH /api/v2/social/dms/:id { name }: any member of a group
function rename(me, rawId, body = {}) {
  if (notHere(rawId)) throw err('not_hosted_here', 400, { host_origin: pointer(me, rawId).host_origin });
  const c = group(hosted(rawId, me));
  if (body.name !== null && typeof body.name !== 'string') throw err('invalid_name', 400);
  c.name = clean(body.name, 60);
  db.run('UPDATE communities SET name = ? WHERE id = ?', c.name, c.id);
  announce(c);
  tellOthers(c);
  return { dm: view(c, me) };
}
// DELETE /api/v2/social/dms/:id/members/:member: the group's owner
function removeMember(me, rawId, member) {
  if (notHere(rawId)) throw err('not_hosted_here', 400, { host_origin: pointer(me, rawId).host_origin });
  const c = group(hosted(rawId, me));
  if (Number(c.owner_id) !== Number(me.id)) throw err('owner_only', 403);
  const p = people.parseId(member), u = p?.local ? p.user : p ? auth.userByPrincipal(p.id) : null;
  if (!u || !isMember(c, u.id)) throw err('not_a_member', 404);
  if (u.id === me.id) throw err('cannot_remove_yourself', 400);
  takeOut(c, u);
  return { dm: view(db.get('SELECT * FROM communities WHERE id = ?', c.id), me) };
}
// POST /api/v2/social/dms/:id/members { members: [handle], member_ids?: [id] }: the group's owner adds people. Each is asked
// the way a new DM asks (their dm_from, blocks; an account elsewhere through its homeserver: dm_pointer `added`, waited for).
// End-to-end encryption: a sender wraps each message to the members the DM lists when it is sent, so someone added gets
// the messages from then on; what was said before stays sealed to the others (PROTOCOL §4d)
async function addMembers(me, rawId, body = {}) {
  if (notHere(rawId)) throw err('not_hosted_here', 400, { host_origin: pointer(me, rawId).host_origin });
  const c = group(hosted(rawId, me)), my = people.fullId(me);
  if (Number(c.owner_id) !== Number(me.id)) throw err('owner_only', 403);
  const handles = Array.isArray(body.members) ? body.members : [], given = Array.isArray(body.member_ids) ? body.member_ids : [];
  if (handles.length + given.length < 1 || handles.length + given.length > MAX_MEMBERS || [...handles, ...given].some(x => typeof x !== 'string')) throw err('invalid_members', 400);
  const found = new Map();
  for (const h of handles) { const s = await people.find(h); found.set(s.id, s); }
  for (const id of given) { const s = await people.findById(id); found.set(s.id, s); }
  const have = new Set(membersOf(c).map(u => people.fullId(u)));
  const fresh = [...found.values()].filter(s => !have.has(s.id));
  if (!fresh.length) throw err('already_member', 400);
  if (have.size + fresh.length > MAX_MEMBERS) throw err('group_full', 409, { max: MAX_MEMBERS });
  const users = [];
  for (const s of fresh) {
    if (friends.hasBlocked(me, s.id)) throw err('user_blocked', 409, { member: s.id });
    const p = people.parseId(s.id);
    if (p.local && where.s2sElsewhere(p.user)) { users.push(p.user); continue; }
    if (p.local) { if (!friends.dmAllowed(p.user, my)) throw err('dm_not_allowed', 403, { member: s.id }); users.push(p.user); continue; }
    s2s.assertPeer(p.domain);
    const u = remoteUser(s);
    if (!u) throw err('dm_not_allowed', 403, { member: s.id });
    users.push(u);
  }
  const t = now(), dm = { ...describe(c), members: [...membersOf(c).map(people.snippetOf), ...fresh] };
  const told = [];
  for (const u of users) {
    const to = peerOf(u);
    if (!to) continue;
    try { await s2s.call(to.domain, 'POST', '/dm_pointer', { dm, to: to.to, kind: 'added', from: my }); told.push(to); }
    catch (e) {
      for (const x of told) s2s.later(x.domain, '/dm_pointer', { dm: { id: idOf(c), host: own() }, to: x.to, kind: 'removed' });
      throw err(e.code, e.status, { ...(e.extra || {}), member: to.to });
    }
  }
  const newcomers = new Set(told.map(x => x.to));
  db.tx(() => { for (const u of users) db.run('INSERT OR IGNORE INTO members (community_id, user_id, joined_at) VALUES (?, ?, ?)', c.id, u.id, t); });
  for (const u of users) gateway().subscribe(u.id, c.id);
  announce(c);
  // the members elsewhere who were in it already hear who is in it now (the new ones were told above)
  const d2 = describe(c);
  for (const u of membersOf(c)) { const p = peerOf(u); if (p && !newcomers.has(p.to)) s2s.later(p.domain, '/dm_pointer', { dm: d2, to: p.to, kind: 'renamed' }); }
  return { dm: view(db.get('SELECT * FROM communities WHERE id = ?', c.id), me) };
}

// ---------- wrapping messages again (PROTOCOL §4d.3) ----------
// A member whose keys changed (a lost account key, a new client) cannot open what was sealed to the old ones. A wrap for a
// message may be added by whoever sent it (they made its key) or by the member it is for (from another client that can
// still open it), only for the keys the member's key document lists now, only for messages sent while they were a member.
// A wrap the sender put in the message is never replaced; one added here may be replaced only by whoever added it
// (dm_rewraps). The host cannot check a wrap (it cannot open it); the member's client checks the key commitment.
const MAX_REWRAP = 500;
async function rewrapTarget(c, memberRaw) {
  const p = people.parseId(String(memberRaw || '')), u = p?.local ? p.user : p ? auth.userByPrincipal(p.id) : null;
  if (!u || !isMember(c, u.id)) throw err('not_a_member', 404);
  const doc = await require('./keys').docFor(u, { fresh: true });
  const kids = new Set([...(doc?.keys || []).map(k => k.kid), ...((doc?.clients?.list || []).filter(x => !x.revoked_at).map(x => x.kid))]);
  const joined = db.get('SELECT joined_at FROM members WHERE community_id = ? AND user_id = ?', c.id, u.id).joined_at;
  return { u, kids, joined };
}
const wrapsOf = m => { try { const e = m?.enc ? JSON.parse(m.enc) : null; return e && e.wraps && typeof e.wraps === 'object' && !Array.isArray(e.wraps) ? e : null; } catch { return null; } };
// may `me` add (or replace) the wrap for `kid` on message m, for member t? -> 'add' | 'replace' | null
function mayWrap(me, t, m, enc, kid) {
  if (!enc || m.created_at < t.joined) return null;
  if (Number(m.user_id) !== Number(me.id) && Number(t.u.id) !== Number(me.id)) return null; // its sender, or the member it is for
  if (!enc.wraps[kid]) return Object.keys(enc.wraps).length < require('./e2ee').MAX_WRAPS ? 'add' : null;
  const by = db.get('SELECT author_id FROM dm_rewraps WHERE message_id = ? AND kid = ?', m.id, kid)?.author_id;
  return by != null && Number(by) === Number(me.id) ? 'replace' : null;
}
// GET /api/v2/social/dms/:id/rewrap?member=<id>&kid=<kid>: the sealed messages since they joined that have no wrap for that
// key and that the caller may wrap (the ones they sent; all of them for the member themselves)
async function rewrapWanted(me, rawId, q = {}) {
  const c = hosted(rawId, me), t = await rewrapTarget(c, q.member);
  const kid = String(q.kid || '');
  if (!t.kids.has(kid)) throw err('unknown_kid', 400);
  const ch = channelOf(c);
  const ids = db.all('SELECT id, user_id, enc, created_at FROM messages WHERE channel_id = ? AND enc IS NOT NULL AND created_at >= ? ORDER BY id', ch.id, t.joined)
    .filter(m => { const e = wrapsOf(m); return e && !e.wraps[kid] && mayWrap(me, t, m, e, kid) === 'add'; }).map(m => String(m.id));
  return { member: people.fullId(t.u), kid, messages: ids.slice(0, MAX_REWRAP), more: ids.length > MAX_REWRAP };
}
// POST /api/v2/social/dms/:id/rewrap { member, kid, wraps: { "<message id>": { e, i, w } } } -> { added, skipped }
async function rewrap(me, rawId, body = {}) {
  const c = hosted(rawId, me), t = await rewrapTarget(c, body.member);
  const kid = String(body.kid || '');
  if (!t.kids.has(kid)) throw err('unknown_kid', 400);
  const wraps = body.wraps && typeof body.wraps === 'object' && !Array.isArray(body.wraps) ? body.wraps : null;
  if (!wraps || !Object.keys(wraps).length || Object.keys(wraps).length > MAX_REWRAP) throw err('invalid_wraps', 400, { max: MAX_REWRAP });
  const ch = channelOf(c), str = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n && /^[A-Za-z0-9_-]+$/.test(v);
  let added = 0;
  const skipped = [];
  db.tx(() => {
    for (const [id, w] of Object.entries(wraps)) {
      if (!w || typeof w !== 'object' || !str(w.e, 128) || !str(w.i, 24) || !str(w.w, 128)) throw err('invalid_wraps', 400, { message: id });
      const m = /^\d{1,19}$/.test(id) ? db.get('SELECT id, user_id, enc, created_at FROM messages WHERE id = ? AND channel_id = ?', Number(id), ch.id) : null;
      const enc = wrapsOf(m);
      // not here, not sealed, sent before they joined, not theirs to wrap, already wrapped for that key by someone else, or full
      if (!m || !mayWrap(me, t, m, enc, kid)) { skipped.push(id); continue; }
      enc.wraps[kid] = { e: w.e, i: w.i, w: w.w };
      db.run('UPDATE messages SET enc = ? WHERE id = ?', JSON.stringify(enc), m.id);
      db.run('INSERT INTO dm_rewraps (message_id, kid, author_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id, kid) DO UPDATE SET created_at = excluded.created_at', m.id, kid, me.id, now());
      added++;
    }
  });
  if (added) gateway().pushToUser(t.u.id, { type: 'social_dm_rewrapped', dm: idOf(c), kid, count: added });
  return { added, skipped };
}

// POST /api/v2/social/dms/:id/leave: a group hosted here, or the pointer to one hosted elsewhere (that homeserver hears
// it the next time it reports activity: 410 pointer_gone)
function leave(me, rawId) {
  if (notHere(rawId)) {
    const row = pointer(me, rawId);
    if (!pointerView(row).group) throw err('not_a_group', 400);
    dropPointer(me.id, row.dm_id);
    return { ok: true, hosted_here: false, host_origin: row.host_origin };
  }
  takeOut(group(hosted(rawId, me)), me);
  return { ok: true, hosted_here: true };
}
// POST /api/v2/social/dms/:id/read: everything in it is read (a pointer's count is cleared; the client reads on the host)
function read(me, rawId) {
  if (notHere(rawId)) {
    const row = pointer(me, rawId);
    db.run('UPDATE dm_pointers SET unread = 0, mention = 0 WHERE user_id = ? AND dm_id = ?', me.id, row.dm_id);
    return { dm: pointerView(pointer(me, rawId)) };
  }
  const c = hosted(rawId, me), ch = channelOf(c);
  db.run('INSERT INTO read_state (user_id, channel_id, last_read_id) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)', me.id, ch.id, ch.last_message_id || 0);
  return { dm: view(c, me) };
}
// GET /api/v2/social/dms: the DMs hosted here that I am in, and (accounts of this homeserver) the pointers to the rest
function list(me) {
  const here = db.all("SELECT c.* FROM communities c JOIN members m ON m.community_id = c.id WHERE c.kind = 'dm' AND m.user_id = ?", me.id).map(c => view(c, me));
  const there = auth.hostedHere(me) ? db.all('SELECT * FROM dm_pointers WHERE user_id = ?', me.id).map(pointerView) : [];
  return { dms: [...here, ...there].sort((a, b) => b.updated_at - a.updated_at) };
}
const one = (me, rawId) => ({ dm: notHere(rawId) ? pointerView(pointer(me, rawId)) : view(hosted(rawId, me), me) });

// ---------- pointers: DMs hosted elsewhere that an account here is in ----------
const json = (text, fallback) => { try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
function pointerView(r) {
  const x = json(r.extra_json, {}) || {};
  return {
    id: r.dm_id, host: r.host_domain, host_origin: r.host_origin, name: r.name || null, group: !!x.group, owner: x.owner || null, sid: x.sid || null, channel: x.channel || null,
    members: json(r.members_json, []), created_at: x.created_at || null, e2ee: true, last_message_id: r.last_message_id || '0', unread: r.unread, mention: !!r.mention, hosted_here: false, updated_at: r.updated_at,
  };
}
function pointer(me, rawId) {
  const r = auth.hostedHere(me) ? db.get('SELECT * FROM dm_pointers WHERE user_id = ? AND dm_id = ?', me.id, String(rawId).replace(/@[^@]*$/, m => m.toLowerCase())) : null;
  if (!r) throw err('dm_not_found', 404);
  return r;
}
function dropPointer(userId, dmId) {
  if (db.run('DELETE FROM dm_pointers WHERE user_id = ? AND dm_id = ?', userId, dmId).changes) gateway().pushToUser(userId, { type: 'social_dm_remove', id: dmId });
}
// the `dm` of a dm_pointer, from the homeserver that signed the request: only it can describe DMs it hosts
function cleanDm(dm, hs) {
  const id = R.parseSub(dm?.id);
  if (!id || id.domain !== hs.domain || String(dm.host || '').toLowerCase() !== hs.domain) throw err('dm_host_mismatch', 403);
  const members = (Array.isArray(dm.members) ? dm.members.slice(0, 50) : []).map(m => people.cleanSnippet(m, m?.id)).filter(Boolean);
  const str = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
  return {
    id: `${id.id}@${id.domain}`, name: clean(dm.name, 60) || null, members,
    extra: { group: dm.group === true, owner: R.parseSub(dm.owner) ? dm.owner : null, sid: str(dm.sid, /^[A-Za-z0-9._:-]{1,64}$/), channel: str(dm.channel, /^[A-Za-z0-9._:-]{1,64}$/), created_at: Number.isFinite(dm.created_at) ? dm.created_at : null },
  };
}

// ---------- activity: the host tells the homeservers of members who live elsewhere ----------
const pending = new Map(); // "dm|to" -> { domain, body }
let timer = null;
function onPost(msg, ctx, meta) {
  const { c } = ctx;
  if (c.kind !== 'dm' || meta.system) return;
  const author = meta.userId ? auth.userById(meta.userId) : null;
  for (const u of membersOf(c)) {
    const peer = peerOf(u);
    if (!peer || u.id === meta.userId) continue;
    const key = `${c.id}|${u.id}`, e = pending.get(key) || { domain: peer.domain, community: c.id, user: u.id, body: { dm: idOf(c), to: peer.to, count: 0, mention: false, e2ee: true } }; // (every DM hosted here is end-to-end encrypted, §4d)
    // (messages are sealed, PROTOCOL §4d: no preview, and nobody here can tell who is mentioned)
    Object.assign(e.body, { last_message_id: String(msg.id), count: e.body.count + 1, mention: false, name: isGroup(c) ? c.name || null : null,
      sender: author ? { id: people.fullId(author), display_name: author.display_name || author.username } : null });
    pending.set(key, e);
  }
  if (pending.size && !timer) { timer = setTimeout(flush, WINDOW); timer.unref?.(); }
}
function flush() {
  clearTimeout(timer); timer = null;
  const list = [...pending.values()];
  pending.clear();
  for (const e of list) s2s.later(e.domain, '/dm_activity', e.body, { then: 'dm_activity', ctx: { community: e.community, user: e.user } });
}
// their homeserver has no pointer any more: they left a group there
s2s.after('dm_activity', (status, body, e) => { if (status === 410 && e) pointerGone(e); });
function pointerGone(e) {
  const c = db.get("SELECT * FROM communities WHERE id = ? AND kind = 'dm'", e.community), u = auth.userById(e.user);
  if (c && u && isGroup(c) && isMember(c, u.id)) takeOut(c, u);
}

let off = null;
function start() { stop(); off = require('../messages').onPost(onPost); }
function stop() { if (off) off(); off = null; clearTimeout(timer); timer = null; pending.clear(); }

function register(app) {
  app.get('/api/v2/social/dms', req => list(req.user));
  app.post('/api/v2/social/dms', req => create(req.user, req.body));
  app.get('/api/v2/social/dms/:id', req => one(req.user, req.params.id));
  app.patch('/api/v2/social/dms/:id', req => rename(req.user, req.params.id, req.body));
  app.post('/api/v2/social/dms/:id/leave', req => leave(req.user, req.params.id));
  app.post('/api/v2/social/dms/:id/read', req => read(req.user, req.params.id));
  app.delete('/api/v2/social/dms/:id/members/:member', req => removeMember(req.user, req.params.id, req.params.member));
  app.post('/api/v2/social/dms/:id/members', req => addMembers(req.user, req.params.id, req.body || {}));
  app.get('/api/v2/social/dms/:id/rewrap', req => rewrapWanted(req.user, req.params.id, req.query));
  app.post('/api/v2/social/dms/:id/rewrap', req => rewrap(req.user, req.params.id, req.body || {}));

  // the host of a DM: `to` is in it now (added), no longer in it (removed), or it changed (renamed)
  s2s.on(app, 'POST', '/dm_pointer', (req, hs) => {
    const b = req.body || {}, to = s2s.localAccount(b.to), dm = cleanDm(b.dm, hs), my = people.fullId(to);
    const have = db.get('SELECT * FROM dm_pointers WHERE user_id = ? AND dm_id = ?', to.id, dm.id);
    if (b.kind === 'removed') { dropPointer(to.id, dm.id); return { ok: true }; }
    if (b.kind !== 'added' && b.kind !== 'renamed') throw err('invalid_request', 400);
    if (!have && b.kind === 'renamed') throw err('pointer_gone', 410);
    if (!dm.members.some(m => m.id === my)) throw err('invalid_request', 400);
    if (!have) {
      const from = R.parseSub(b.from);
      if (!from) throw err('invalid_request', 400);
      if (from.domain !== hs.domain) throw err('from_mismatch', 403);
      if (require('../federation/denylist').check({ domain: hs.domain, ips: hs.ips, sub: `${from.id}@${from.domain}` })) throw err('homeserver_denied', 403);
      limits.hit(hs.domain, 'dms');
      // the account's own rule for who may start a DM with it (dm_from), and never someone it blocked
      if (!friends.dmAllowed(to, `${from.id}@${from.domain}`)) throw err('dm_not_allowed', 403);
      if (db.get('SELECT COUNT(*) AS n FROM dm_pointers WHERE user_id = ?', to.id).n >= MAX_POINTERS) throw err('too_many_dms', 409);
    }
    db.run(`INSERT INTO dm_pointers (user_id, dm_id, host_domain, host_origin, name, members_json, last_message_id, extra_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, '0', ?, ?)
      ON CONFLICT(user_id, dm_id) DO UPDATE SET host_origin = excluded.host_origin, name = excluded.name, members_json = excluded.members_json, extra_json = excluded.extra_json`,
    to.id, dm.id, hs.domain, hs.origin, dm.name, JSON.stringify(dm.members), JSON.stringify(dm.extra), now());
    for (const m of dm.members) if (m.id !== my && !people.parseId(m.id)?.local) people.remember('user', m.id, m);
    gateway().pushToUser(to.id, { type: 'social_dm_update', dm: pointerView(db.get('SELECT * FROM dm_pointers WHERE user_id = ? AND dm_id = ?', to.id, dm.id)) });
    return { ok: true };
  });
  // new messages in a DM hosted there: the pointer counts them, the account's clients hear it, and its pushers when none is connected
  s2s.on(app, 'POST', '/dm_activity', (req, hs) => {
    const b = req.body || {}, to = s2s.localAccount(b.to), id = R.parseSub(b.dm);
    if (!id || id.domain !== hs.domain) throw err('dm_host_mismatch', 403);
    const dmId = `${id.id}@${id.domain}`, row = db.get('SELECT * FROM dm_pointers WHERE user_id = ? AND dm_id = ?', to.id, dmId);
    if (!row) throw err('pointer_gone', 410);
    if (typeof b.last_message_id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(b.last_message_id)) throw err('invalid_request', 400);
    const count = Number.isInteger(b.count) && b.count > 0 ? Math.min(b.count, 1000) : 1;
    db.run('UPDATE dm_pointers SET last_message_id = ?, unread = MIN(unread + ?, 100000), mention = MAX(mention, ?), updated_at = ? WHERE user_id = ? AND dm_id = ?', b.last_message_id, count, b.mention === true ? 1 : 0, now(), to.id, dmId);
    const dm = pointerView(db.get('SELECT * FROM dm_pointers WHERE user_id = ? AND dm_id = ?', to.id, dmId));
    // DMs are end-to-end encrypted (PROTOCOL §4d): a `preview` a host sends anyway is not passed on
    const sender = people.cleanSnippet(b.sender, b.sender?.id);
    gateway().pushToUser(to.id, { type: 'social_dm_activity', dm, mention: b.mention === true, ...(sender ? { sender: { id: sender.id, display_name: sender.display_name } } : {}) });
    require('../push').dm(to.id, { id: dmId, from: sender?.display_name || 'Someone', name: dm.group ? dm.name : null, group: dm.group, body: 'sent a message' });
    return { ok: true };
  });
}

module.exports = { register, start, stop, list, create, describe, view, idOf, isGroup, _test: { createLimit, setWindow(ms) { WINDOW = ms; }, flush } };
