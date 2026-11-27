'use strict';
// Voice minutes per server (PROTOCOL §19.0 `voice_minutes`): every minute someone with an account spends connected to a
// voice channel counts toward that server, per calendar month (UTC), in table voice_usage. A server at its limit cannot
// start more calls (403 plan_limit { what: "voice_minutes" }), and calls going on when it gets there end
// (chat_rtc_left { reason: "voice_minutes" }). People bridged in from another platform do not count.
const db = require('./db');
const { err } = require('./util');

let TICK = 60 * 1000;
let timer = null;
const period = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
const voice = () => require('./voice');
const L = () => require('./limits');

function add(cid, ms, t = Date.now()) {
  if (!(ms > 0) || !db.raw()) return;
  db.run('INSERT INTO voice_usage (community_id, period, ms) VALUES (?, ?, ?) ON CONFLICT(community_id, period) DO UPDATE SET ms = ms + excluded.ms', cid, period(t), Math.round(ms));
}
// whole minutes used this month
const usedMinutes = (cid, t = Date.now()) => Math.floor((db.get('SELECT ms FROM voice_usage WHERE community_id = ? AND period = ?', Number(cid), period(t))?.ms || 0) / 60000);

// the time of one person in a room since it was last counted
function accrue(entry, cid, t = Date.now()) {
  if (!entry || entry.platform) return;
  const from = entry.metered || entry.since || t;
  entry.metered = t;
  add(cid, t - from, t);
}
// voice.js: this person left the room
function left(entry, room) {
  const ch = voice().voiceChannelOf(room);
  if (ch) accrue(entry, ch.community_id);
}
// a call may start in this server? (chat_rtc_join)
function assertCanTalk(cid) {
  const lim = L().limit('voice_minutes', cid);
  if (lim === null) return;
  if (lim === 0) throw L().planFeature('voice_minutes', cid);
  const used = usedMinutes(cid);
  if (used >= lim) throw L().planLimit('voice_minutes', lim, used, cid);
}
// count everyone in a call now, and end the calls of servers that ran out
function tick(t = Date.now()) {
  if (!db.raw()) return;
  const touched = new Set();
  for (const [room, people] of voice().voiceIn) {
    const ch = voice().voiceChannelOf(room);
    if (!ch) continue;
    for (const v of people.values()) accrue(v, ch.community_id, t);
    touched.add(ch.community_id);
  }
  for (const cid of touched) {
    const lim = L().limit('voice_minutes', cid);
    if (lim !== null && usedMinutes(cid, t) >= lim) voice().endCalls(cid, 'voice_minutes');
  }
}
function start() { stop(); timer = setInterval(() => { try { tick(); } catch (e) { console.error('[voice meter]', e.message); } }, TICK); timer.unref?.(); }
function stop() { clearInterval(timer); timer = null; }

module.exports = { add, usedMinutes, left, assertCanTalk, tick, start, stop, period };
