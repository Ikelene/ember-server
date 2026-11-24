'use strict';
// Discord voice channel <-> Ember voice channel (PROTOCOL §16.4), the signalling half. The media half is voice-worker.js.
//
// A voice link is a bridge_channels row like a text link, between one of this server's voice channels and a Discord voice
// channel, on the instance's own Discord bot (Instance settings > Bridges).
//   - Everyone in the Discord channel shows up in the Ember channel as themselves: their Discord name + picture, platform
//     'discord' (clients put the Discord mark on them), their own audio track, so their own speaking ring. They have no
//     account here: they are voice-room entries the server makes (principal d:<discord id>), never members.
//   - On Discord only the bot joins: while at least one person with an account here is in the Ember channel, it sits in the
//     Discord channel and plays everyone from here, mixed. When the Ember channel empties it leaves (after LINGER_MS).
// Needs the optional dependencies @discordjs/voice, werift and opusscript; without them voice links simply never connect.
const path = require('path');
const { Worker } = require('worker_threads');
const db = require('../db');
const { log } = require('../util');

const V = () => require('../voice');
const B = () => require('./bridge');
const PL = () => require('./platform');

const LINGER_MS = 15000;
const VOICE_TYPES = [2, 13]; // Discord voice, stage
const principalOf = id => `d:${id}`;
const usernameOf = id => `discord:${id}`; // never a real username (no account name has a colon), so no client mixes them up

let available = null;
function canRun() {
  if (available == null) {
    try { require.resolve('@discordjs/voice'); require.resolve('werift'); require.resolve('opusscript'); available = true; } catch { available = false; log('[vbridge] voice links are off: @discordjs/voice / werift / opusscript are not installed'); }
  }
  return available;
}

// ---------------------------------------------------------------- what Discord tells us
const states = new Map();  // guild id -> Map(user id -> { channel_id, user, member, mute, deaf })
const members = new Map(); // `${guild}:${user}` -> member (from GUILD_CREATE / VOICE_STATE_UPDATE / REST), for names + pictures
const botId = () => String(B().clients.get('discord')?.user?.id || '');

const voiceLinks = () => {
  try {
    require('./store').ensure();
    return db.all(`SELECT bc.*, bg.platform, bg.guild_id, bg.community_id, bg.enabled, ch.cid FROM bridge_channels bc
      JOIN bridge_guilds bg ON bg.id = bc.bridge_id JOIN channels ch ON ch.id = bc.channel_id WHERE bg.platform = 'discord' AND ch.type = 'voice'`);
  } catch { return []; }
};
const keyOf = l => `${l.channel_id}`;
const roomOf = l => `bf_${l.cid}`;

function onDispatch(t, d) {
  if (!d) return;
  if (t === 'GUILD_CREATE') {
    const g = String(d.id), m = new Map();
    for (const mem of d.members || []) if (mem?.user?.id) members.set(`${g}:${mem.user.id}`, mem);
    for (const vs of d.voice_states || []) if (vs.channel_id) m.set(String(vs.user_id), { channel_id: String(vs.channel_id), mute: !!(vs.mute || vs.self_mute), deaf: !!(vs.deaf || vs.self_deaf) });
    states.set(g, m);
    refreshGuild(g);
  } else if (t === 'GUILD_DELETE') {
    states.delete(String(d.id));
    refreshGuild(String(d.id));
  } else if (t === 'VOICE_STATE_UPDATE') {
    const g = String(d.guild_id || ''), u = String(d.user_id || '');
    if (!g || !u) return;
    if (u === botId()) { worker?.postMessage({ t: 'vsu', d }); return; } // ours: only the voice connection cares
    if (d.member?.user) members.set(`${g}:${u}`, d.member);
    if (!states.has(g)) states.set(g, new Map());
    if (d.channel_id) states.get(g).set(u, { channel_id: String(d.channel_id), mute: !!(d.mute || d.self_mute), deaf: !!(d.deaf || d.self_deaf) });
    else states.get(g).delete(u);
    refreshGuild(g);
  } else if (t === 'VOICE_SERVER_UPDATE') {
    worker?.postMessage({ t: 'vsrv', d });
  }
}

// name + picture of someone over there (the picture is re-hosted here, like a bridged message's)
const shown = new Map(); // `${guild}:${user}` -> { name, avatar, at }
async function personOf(g, u) {
  const k = `${g}:${u}`;
  const hit = shown.get(k);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit;
  let mem = members.get(k);
  if (!mem) { try { mem = await PL().rest('discord', 'GET', `/guilds/${g}/members/${u}`); members.set(k, mem); } catch { mem = null; } }
  const user = mem?.user || { id: u };
  const avatar = await B().hostAvatar('discord', user).catch(() => null);
  const out = { name: String(mem?.nick || user.global_name || user.username || 'Discord user').slice(0, 80), avatar, bot: !!user.bot, at: Date.now() };
  shown.set(k, out);
  if (shown.size > 2000) shown.delete(shown.keys().next().value);
  return out;
}

// ---------------------------------------------------------------- the Ember side: who's shown, when the bot goes over
const presentIn = new Map(); // room -> Map(principal -> entry) of the Discord people we show there
const refreshing = new Map(); // link key -> promise (one refresh at a time per link, the last one wins)
function refreshGuild(g) { for (const l of voiceLinks()) if (String(l.guild_id) === g) refreshLink(l); }
function refreshLink(l) {
  const k = keyOf(l);
  const run = () => doRefresh(l).catch(e => log(`[vbridge] refresh ${k}: ${e.message}`));
  const prev = refreshing.get(k);
  const p = prev ? prev.then(run) : run();
  refreshing.set(k, p);
  p.finally(() => { if (refreshing.get(k) === p) refreshing.delete(k); });
}
async function doRefresh(l) {
  const room = roomOf(l), g = String(l.guild_id);
  const on = !!l.enabled && !!PL().tokenOf('discord');
  const list = [];
  if (on) {
    for (const [u, s] of states.get(g) || []) {
      if (s.channel_id !== String(l.ext_channel_id) || u === botId()) continue;
      const who = await personOf(g, u);
      list.push({ id: u, principal: principalOf(u), username: usernameOf(u), platform: 'discord', name: who.name, avatar: who.avatar, muted: s.mute, deafened: s.deaf });
    }
  }
  const before = presentIn.get(room) || new Map(), now = new Map(list.map(x => [x.principal, x]));
  for (const [pr] of before) if (!now.has(pr)) V().setVirtualPresence(room, null, pr);
  for (const x of list) V().setVirtualPresence(room, x);
  if (now.size) presentIn.set(room, now); else presentIn.delete(room);
  const a = active.get(keyOf(l));
  if (a) worker?.postMessage({ t: 'people', key: a.key, list });
  evaluate(l);
}

const active = new Map(); // link key -> { key, link, stopTimer }
function evaluate(l) {
  const k = keyOf(l), a = active.get(k);
  const wanted = !!l.enabled && !!PL().tokenOf('discord') && canRun() && V().realPeopleIn(roomOf(l)).length > 0 && !!botId();
  if (wanted) {
    if (a) { clearTimeout(a.stopTimer); a.stopTimer = null; return; }
    start(l);
  } else if (a && !a.stopTimer) {
    a.stopTimer = setTimeout(() => stop(k), l.enabled ? LINGER_MS : 0);
    a.stopTimer.unref?.();
  }
}
function onRoom(room) {
  for (const l of voiceLinks()) if (roomOf(l) === room) evaluate(l);
}

function start(l) {
  const w = ensureWorker();
  if (!w) return;
  const k = keyOf(l);
  active.set(k, { key: k, link: l, stopTimer: null });
  w.postMessage({ t: 'start', link: { key: k, guildId: String(l.guild_id), channelId: String(l.ext_channel_id), room: roomOf(l), botId: botId() } });
  w.postMessage({ t: 'people', key: k, list: [...(presentIn.get(roomOf(l))?.values() || [])] });
}
function stop(k) {
  const a = active.get(k);
  if (!a) return;
  clearTimeout(a.stopTimer);
  active.delete(k);
  worker?.postMessage({ t: 'stop', key: k });
  if (!active.size) idleWorker();
}

// ---------------------------------------------------------------- the worker + its pseudo sockets
let worker = null, restarts = 0, idleTimer = null;
const socks = new Map(); // worker sock id -> pseudo socket (what voice.js sends frames to)
function sockFor(id) {
  let s = socks.get(id);
  if (!s) {
    s = { readyState: 1, bridgeSock: id, send: raw => { try { worker?.postMessage({ t: 'frame', sock: id, frame: JSON.parse(raw) }); } catch { /* gone */ } } };
    socks.set(id, s);
  }
  return s;
}
function closeSock(id) {
  const s = socks.get(id);
  if (!s) return;
  socks.delete(id);
  try { V().leave(s); } catch { /* gone */ }
  s.readyState = 3;
}
const fail = (s, msg, e) => s.send(JSON.stringify({ type: 'chat_error', nonce: msg.nonce, request: msg.type, error: e.code || 'server_error' }));

async function onWorker(m) {
  if (m.t === 'log') return log(m.msg);
  if (m.t === 'op4') { B().clients.get('discord')?.sendOp(4, m.d); return; }
  if (m.t === 'leave') return closeSock(m.sock);
  const s = sockFor(m.sock);
  if (m.t === 'join') {
    try {
      const r = await V().virtualJoin(s, m.person, m.room);
      s.send(JSON.stringify({ type: 'chat_rtc_joined', nonce: m.nonce, room: r.room, iceServers: r.iceServers, people: r.people }));
    } catch (e) { fail(s, { type: 'chat_rtc_join', nonce: m.nonce }, e); }
  } else if (m.t === 'rtc') {
    const msg = m.msg || {};
    if (!/^chat_rtc_(publish|connected|subscribe|answer|ice|close)$/.test(String(msg.type))) return;
    try { await V().handle(s, { id: 0, principal: '', username: '' }, msg, f => s.send(JSON.stringify(f))); } catch (e) { fail(s, msg, e); }
  }
}

function ensureWorker() {
  clearTimeout(idleTimer); idleTimer = null;
  if (worker) return worker;
  if (!canRun()) return null;
  const w = worker = new Worker(path.join(__dirname, 'voice-worker.js'));
  w.on('message', m => { onWorker(m).catch(e => log(`[vbridge] ${m?.t}: ${e.message}`)); });
  w.on('error', e => log(`[vbridge] worker crashed: ${e.stack || e.message}`));
  w.on('exit', code => {
    if (worker !== w) return;
    worker = null;
    for (const id of [...socks.keys()]) closeSock(id);
    if (!active.size) return;
    // it died with links up: start them again (backing off if it keeps dying)
    const again = [...active.values()].map(a => a.link);
    active.clear();
    const wait = Math.min(60000, 2000 * 2 ** Math.min(restarts++, 5));
    log(`[vbridge] worker exited (${code}) - restarting in ${wait / 1000}s`);
    setTimeout(() => { for (const l of again) evaluate(l); }, wait).unref?.();
  });
  return w;
}
// nothing bridged for a minute: let the worker go (its memory, the Discord voice libraries)
function idleWorker() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!active.size && worker) { const w = worker; worker = null; for (const id of [...socks.keys()]) closeSock(id); w.terminate().catch(() => {}); restarts = 0; } }, 60000);
  idleTimer.unref?.();
}

// ---------------------------------------------------------------- lifecycle
let unwatch = null;
function init() {
  unwatch?.();
  unwatch = V().watchRooms(onRoom);
}
// links changed (linked / unlinked / switched off): show the right people and start / stop
function linksChanged() {
  const live = new Set(voiceLinks().map(keyOf));
  for (const k of [...active.keys()]) if (!live.has(k)) stop(k);
  const rooms = new Set(voiceLinks().map(roomOf));
  for (const [room, m] of [...presentIn]) if (!rooms.has(room)) { for (const pr of m.keys()) V().setVirtualPresence(room, null, pr); presentIn.delete(room); }
  for (const l of voiceLinks()) refreshLink(l);
}
function shutdown() {
  unwatch?.(); unwatch = null;
  for (const k of [...active.keys()]) stop(k);
  for (const [room, m] of [...presentIn]) for (const pr of m.keys()) V().setVirtualPresence(room, null, pr);
  presentIn.clear(); states.clear();
  const w = worker; worker = null;
  for (const id of [...socks.keys()]) closeSock(id);
  if (w) setTimeout(() => w.terminate().catch(() => {}), 500).unref?.();
}
const status = () => ({ available: canRun(), active: [...active.keys()], worker: !!worker });

module.exports = { init, shutdown, onDispatch, linksChanged, status, VOICE_TYPES, canRun, _test: { states, presentIn, active, socks, onWorker, sockFor } };
