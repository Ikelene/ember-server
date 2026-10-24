'use strict';
// bots in voice (PROTOCOL 14.1): op 4 joins / leaves, op 40 carries the same chat_rtc_* frames people use, replies come back as RTC dispatches
const db = require('./db');
const C = require('./communities');
const V = () => require('./voice');

const prev = new Map(); // channel cid -> Map(principal -> state), to turn chat_voice_state snapshots into per user updates

function sockOf(g) {
  if (!g.voiceSock) {
    g.voiceSock = {
      get readyState() { return g.ws.readyState; },
      send: raw => { try { g.send('RTC', JSON.parse(raw)); } catch { /* closing */ } },
    };
  }
  return g.voiceSock;
}
const fail = (g, request, nonce, error) => g.send('RTC', { type: 'chat_error', nonce, request, error });

function channelFor(g, d) {
  const c = db.get('SELECT c.* FROM communities c JOIN members m ON m.community_id = c.id WHERE c.id = ? AND m.user_id = ?', Number(d.guild_id), g.botId);
  if (!c) return null;
  const ch = db.get("SELECT * FROM channels WHERE id = ? AND community_id = ? AND type = 'voice'", Number(d.channel_id), c.id);
  return ch ? { c, ch } : null;
}

async function op4(g, me, d) {
  const nonce = d.nonce == null ? undefined : String(d.nonce).slice(0, 64);
  if (d.channel_id == null) { V().leave(sockOf(g)); return; }
  const hit = channelFor(g, d);
  if (!hit) return fail(g, 'op4', nonce, 'not_allowed');
  const room = `bf_${hit.ch.cid}`;
  await V().handle(sockOf(g), me, { type: 'chat_rtc_join', nonce, room }, f => {
    if (f.type !== 'chat_rtc_joined') return g.send('RTC', f);
    g.send('VOICE_SERVER_UPDATE', { guild_id: String(hit.c.id), channel_id: String(hit.ch.id), room, nonce, ice_servers: f.iceServers, people: f.people });
  });
}

async function op40(g, me, d) {
  const type = String(d?.type || ''), nonce = d?.nonce;
  if (!/^chat_(rtc|voice)/.test(type) || type === 'chat_rtc_join') return fail(g, type, nonce, 'bad_request');
  await V().handle(sockOf(g), me, d, f => g.send('RTC', f));
}

async function handleOp(g, me, ev) {
  try {
    if (ev.op === 4) await op4(g, me, ev.d || {});
    else await op40(g, me, ev.d || {});
  } catch (e) {
    fail(g, ev.op === 4 ? 'op4' : String(ev.d?.type || 'op40'), ev.d?.nonce, e.code || 'server_error');
    if (!e.code) console.error('[bot-voice]', e.stack || e.message);
  }
}

const drop = g => { if (g.voiceSock) V().leave(g.voiceSock); };

// the state of one voice channel changed: [{ channel, user, present, muted, deafened }] per person who joined, left or changed flags
function diff(obj) {
  const now = new Map((obj.users || []).map(u => [u.id, u]));
  const was = prev.get(obj.channel) || new Map();
  const out = [];
  for (const [id, u] of now) {
    const o = was.get(id);
    if (!o || o.muted !== u.muted || o.deafened !== u.deafened) out.push({ principal: id, username: u.username, present: true, muted: u.muted, deafened: u.deafened });
  }
  for (const [id, o] of was) if (!now.has(id)) out.push({ principal: id, username: o.username, present: false, muted: false, deafened: false });
  if (now.size) prev.set(obj.channel, now); else prev.delete(obj.channel);
  return out;
}

const stateObj = (c, ch, uidOf, u, present) => ({
  guild_id: String(c.id), channel_id: present ? String(ch.id) : null, user_id: String(uidOf(u.principal) ?? 0),
  mute: false, deaf: false, self_mute: !!u.muted, self_deaf: !!u.deafened, suppress: false, member: { user: { id: String(uidOf(u.principal) ?? 0), username: u.username, bot: String(u.principal).startsWith('b:') } },
});

function voiceStates(c, snap, uidOf) {
  const out = [];
  for (const ch of snap.channels.filter(x => x.type === 'voice'))
    for (const u of V().voiceIn.get(`bf_${ch.cid}`)?.values() || []) out.push(stateObj(c, ch, uidOf, { principal: u.id, username: u.username, muted: u.muted, deafened: u.deafened }, true));
  return out;
}

module.exports = { handleOp, drop, diff, stateObj, voiceStates };
