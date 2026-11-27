'use strict';
// Mentions: who a message pings, and delivery. Online members get a `chat_mention` gateway event; everyone else goes through
// notifyOffline(userIds, payload), the single extension point for push (a later wave replaces it; it is a no-op here).
// Preferences (/notify levels + mute) come from the `notify` table: the channel's setting, else the community's, else mentions only.
const db = require('./db');
const gateway = require('./gateway');

let offline = () => {};
const setOfflineHandler = fn => { offline = typeof fn === 'function' ? fn : () => {}; };
// notifyOffline(userIds: number[], payload: the chat_mention object)
// more listeners for the same thing (push.js: the push gateway). -> a function that takes it off again
const others = new Set();
const onOffline = fn => { others.add(fn); return () => others.delete(fn); };
function notifyOffline(userIds, payload) {
  for (const fn of [offline, ...others]) { try { fn(userIds, payload); } catch (e) { console.error('[notify] offline hook', e.message); } }
}

function effective(prefs, sid, cid) {
  const sv = prefs.get(sid) || {}, ch = prefs.get(cid) || {}, t = Date.now();
  const muted = (ch.muted_until && ch.muted_until > t) || (sv.muted_until && sv.muted_until > t);
  const level = ch.level && ch.level !== 'default' ? ch.level : (sv.level && sv.level !== 'default' ? sv.level : 'mentions');
  return { muted: !!muted, level, push: ch.push !== false && sv.push !== false };
}

// message text -> what a notification shows: <@v:42> -> @name, <#cid> -> #channel, <:name:eid> -> :name:, <@&rid> -> @role
function plainBody(body, snap) {
  return String(body || '')
    .replace(/<@!?((?:[vlb]:)?\d{1,20}(?:@[a-z0-9.-]{1,253})?|[A-Za-z0-9][A-Za-z0-9._:-]{0,63}@[a-z0-9.-]{1,253})>/g, (_, p) => `@${db.get('SELECT username FROM users WHERE principal = ?', p)?.username || 'unknown-user'}`)
    .replace(/<#(c[0-9a-f]{10})>/g, (_, cid) => `#${snap?.channels.find(x => x.cid === cid)?.name || 'unknown'}`)
    .replace(/<a?:(\w{1,32}):e[0-9a-f]{10}>/g, ':$1:')
    .replace(/<@&(r[0-9a-f]{10})>/g, (_, rid) => `@${snap?.roles.find(r => r.rid === rid)?.name || 'role'}`);
}

// msg = the message view; ctx = { ch, c, snap }. Called for ordinary posts (not system / webhook / bridged).
// A person is pinged by a <@principal> token (Discord's format); a plain "@name" in the text is just text.
function deliver(ctx, msg, authorId) {
  const { ch, c, snap } = ctx;
  const dm = c.kind === 'dm'; // (PROTOCOL §4c) every message in a DM is for everyone in it; it is sealed (§4d), so there is nothing to preview
  const body = plainBody(msg.body, snap);
  const pinged = new Set([...String(msg.body || '').matchAll(/<@!?((?:[vlb]:)?\d{1,20}(?:@[a-z0-9.-]{1,253})?|[A-Za-z0-9][A-Za-z0-9._:-]{0,63}@[a-z0-9.-]{1,253})>/g)].map(x => x[1]));
  const prefs = new Map();
  for (const r of db.all('SELECT user_id, target, level, muted_until, push FROM notify WHERE target IN (?, ?)', c.sid, ch.cid)) {
    if (!prefs.has(r.user_id)) prefs.set(r.user_id, new Map());
    prefs.get(r.user_id).set(r.target, { level: r.level, muted_until: r.muted_until, push: !!r.push });
  }
  const online = new Set(gateway.onlineUserIds());
  const payload = { type: 'chat_mention', id: msg.id, server: c.name, sid: c.sid, channel: ch.name, cid: ch.cid, from: msg.author?.username, pfp: msg.author?.pfp || null, body: msg.enc ? 'sent a message' : body || 'sent a picture', ...(dm ? { dm: `${c.sid}@${require('./config').domain()}`, group: c.join_policy === 'group' } : {}) };
  const off = [];
  for (const u of db.all("SELECT u.* FROM users u JOIN members m ON m.user_id = u.id WHERE m.community_id = ? AND u.kind <> 'bot'", c.id)) {
    if (u.id === Number(authorId) || !snap.canView(ch, u.id)) continue;
    const n = effective(prefs.get(u.id) || new Map(), c.sid, ch.cid);
    if (n.muted || n.level === 'none') continue;
    const isOn = online.has(u.id);
    let hit = dm || n.level === 'all' || msg.mention_everyone === 'everyone' || (msg.mention_everyone === 'here' && isOn) || (msg.reply?.author?.id && msg.reply.author.id === u.principal);
    if (!hit && msg.mention_roles?.length) { const ids = snap.roleIds(u.id); hit = snap.roles.some(r => ids.has(r.id) && msg.mention_roles.includes(r.rid)); }
    if (!hit && pinged.size) hit = pinged.has(String(u.principal));
    if (!hit) continue;
    if (isOn) gateway.pushToUser(u.id, payload);
    else if (n.push && !(dm && u.kind === 'remote')) off.push(u.id); // (their own homeserver pushes: dm_activity)
  }
  if (off.length) notifyOffline(off, payload);
}

module.exports = { effective, deliver, notifyOffline, setOfflineHandler, onOffline, plainBody };
