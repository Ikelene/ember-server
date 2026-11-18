'use strict';
// Sleep mode (PROTOCOL §7.2). A client that lets this server's socket go to save data (Ember's sleep mode) signs up first:
// POST /api/v1/wake, renewed every few minutes (a sign-up lasts TTL). While it's fresh:
//   - the person still counts as connected here (member lists, chat_presence), so sleeping doesn't look like leaving
//   - the first new message they can see sends one "activity" ping for them through Velora (§12.12); their client marks the server
//     unread and connects when they open it. One ping per sign-up: nothing more until they connect again.
// Connecting again ends the sign-up (gateway), so does DELETE /api/v1/wake. Velora principals only (the ping goes through Velora).
const auth = require('./auth');

const TTL = 5 * 60e3;
const subs = new Map(); // userId -> { until, pinged }
const G = () => require('./gateway');

function subscribe(user) {
  if (!user?.id || user.kind === 'bot') return { ok: false };
  const id = Number(user.id), had = subs.get(id);
  const live = !!had && had.until > Date.now();
  subs.set(id, { until: Date.now() + TTL, pinged: live && had.pinged });
  if (!live) G().peopleChanged(id); // (new, or one that had run out but wasn't swept yet)
  return { ok: true, ttl_ms: TTL, pings: !!user.velora_id && available() };
}
function end(userId) {
  if (subs.delete(Number(userId))) G().peopleChanged(Number(userId));
}
const active = userId => { const s = subs.get(Number(userId)); return !!s && s.until > Date.now(); };
const available = () => { try { return require('./relay/client').registered(); } catch { return false; } };

// a new message in a community: one ping for each signed-up member who can see it and hasn't been pinged yet
function onMessage(communityId, msg) {
  if (!subs.size || !msg?.channel || !available()) return;
  const snap = require('./communities').snapById(communityId);
  const ch = snap?.channels.find(x => x.cid === msg.channel);
  if (!ch) return;
  const now = Date.now(), ids = [], marked = [];
  for (const [uid, s] of subs) {
    if (s.pinged || s.until <= now || G().isOnline(uid) || !snap.isMember(uid) || !snap.canView(ch, uid)) continue; // (connected: they see it anyway)
    const u = auth.userById(uid);
    if (!u?.velora_id || String(msg.author?.id) === String(u.principal)) continue;
    s.pinged = true;
    marked.push(uid);
    ids.push(String(u.velora_id));
  }
  if (!ids.length) return;
  // only the people Velora actually reached count as pinged: anyone whose Ember wasn't reachable just then gets the next message's ping
  const unmark = uids => { for (const uid of uids) { const s = subs.get(uid); if (s) s.pinged = false; } };
  require('./relay/client').call('POST', '/bonfire/relay/wake', { user_ids: ids }).then(r => {
    if (!Array.isArray(r?.delivered_ids)) return; // (an older Velora: trust it)
    const got = new Set(r.delivered_ids.map(String));
    unmark(marked.filter((uid, i) => !got.has(ids[i])));
  }).catch(e => {
    unmark(marked);
    if (e.status !== 429 && e.code !== 'velora_unreachable') console.error('[wake] relay', e.code || e.message);
  });
}

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [uid, s] of subs) if (s.until <= now) { subs.delete(uid); G().peopleChanged(uid); }
}, 30e3);
sweep.unref?.();

module.exports = { subscribe, end, active, available, onMessage, TTL, _subs: subs };
