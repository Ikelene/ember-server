'use strict';
// A Matrix space as this instance's community (PROTOCOL §16.6): the same thing Velora's import bundles do for Discord / Fluxer
// (§12.6), done here with a Matrix bot account the admin brings (its homeserver address + an access token).
// Structure only: rooms become channels, sub-spaces become categories, plus the space's picture and its custom emoji.
// Members and messages stay on Matrix. The bot's token is kept in memory for half an hour and only saved when the admin
// asks for the imported rooms to be bridged (it then becomes the bridge's bot, matrix.js).
const crypto = require('crypto');
const db = require('../db');
const C = require('../communities');
const uploads = require('../uploads');
const managed = require('../managed');
const config = require('../config');
const { P, EVERYONE_DEFAULT } = require('../perms');
const { err, clean, normalizeOrigin } = require('../util');
const MX = require('./matrix');

const V3 = '/_matrix/client/v3';
const enc = encodeURIComponent;
const TTL = 30 * 60e3;
const ROOM_ID = /^![^\s/]{1,255}$/;
const VOICE_TYPES = ['org.matrix.msc3417.call', 'io.element.video', 'm.call'];
const OPEN_RULES = ['public', 'restricted', 'knock_restricted'];
const ROLES = [
  { id: 'admin', name: 'Admin', permissions: P.ADMIN },
  { id: 'mod', name: 'Moderator', permissions: P.KICK | P.BAN | P.MANAGE_MESSAGES | P.MENTION_EVERYONE },
];

// ---------------------------------------------------------------- whose bot
const sessions = new Map(); // user id -> { base, token, bot, at, snap }
let saved = null; // the bridge's own bot, when one is set up: { saved: true, bot, snap }
function sessionOf(me) {
  const s = sessions.get(me.id);
  if (s && Date.now() - s.at < TTL) return s;
  sessions.delete(me.id);
  if (managed.allows('bridges') && MX.configured() && MX.botId()) {
    if (!saved || saved.bot !== MX.botId()) saved = { saved: true, bot: MX.botId(), snap: null };
    return saved;
  }
  return null;
}
const need = me => { const s = sessionOf(me); if (!s) throw err('bridge_not_set_up', 503, { platform: 'matrix' }); return s; };
const auth = s => (s.saved ? {} : { token: s.token, base: s.base });
const call = (s, method, route, body, o = {}) => MX.api(method, route, body, { ...o, ...auth(s) });

function view(me) {
  C.assertMayCreate(me);
  const s = sessionOf(me);
  return { ready: !!s, bot: s ? s.bot : null, saved: !!s?.saved, can_bridge: managed.allows('bridges') };
}
async function setBot(me, v) {
  C.assertMayCreate(me);
  const token = MX.cleanToken(v.token);
  if (!token) throw err('invalid_token', 400, { platform: 'matrix' });
  const base = await MX.discover(MX.cleanHomeserver(v.homeserver));
  const bot = await MX.whoami(base, token);
  sessions.set(me.id, { base, token, bot, at: Date.now(), snap: null });
  if (sessions.size > 50) sessions.delete(sessions.keys().next().value);
  return view(me);
}
function dropBot(me) { sessions.delete(me.id); return view(me); }

// ---------------------------------------------------------------- what the bot can see
const TYPES = ['m.room.create', 'm.room.name', 'm.room.topic', 'm.room.avatar', 'm.room.canonical_alias', 'm.room.join_rules', 'm.room.power_levels', 'm.room.encryption', 'm.space.child', 'im.ponies.room_emotes'];
const FILTER = JSON.stringify({ presence: { types: [] }, account_data: { types: [] }, room: { ephemeral: { types: [] }, account_data: { types: [] }, state: { types: TYPES }, timeline: { limit: 1, types: TYPES } } });
const sync = s => call(s, 'GET', `${V3}/sync?timeout=0&filter=${enc(FILTER)}`, undefined, { timeout: 90000, maxBytes: 48 << 20 });

function roomFrom(id, events) {
  const o = { id, joined: true, type: null, name: '', topic: '', avatar: null, alias: '', join: 'invite', power: null, encrypted: false, children: new Map(), packs: new Map() };
  for (const ev of events) {
    if (!ev || typeof ev.state_key !== 'string') continue;
    const c = ev.content && typeof ev.content === 'object' ? ev.content : {};
    if (ev.type === 'm.room.create') o.type = typeof c.type === 'string' ? c.type : null;
    else if (ev.type === 'm.room.name') o.name = clean(c.name, 100);
    else if (ev.type === 'm.room.topic') o.topic = clean(c.topic, 300);
    else if (ev.type === 'm.room.avatar') o.avatar = MX.MXC.test(c.url || '') ? c.url : null;
    else if (ev.type === 'm.room.canonical_alias') o.alias = clean(c.alias, 100);
    else if (ev.type === 'm.room.join_rules') o.join = String(c.join_rule || 'invite');
    else if (ev.type === 'm.room.power_levels') o.power = c;
    else if (ev.type === 'm.room.encryption') o.encrypted = true;
    else if (ev.type === 'm.space.child') { if (Array.isArray(c.via) && c.via.length) o.children.set(ev.state_key, childOf(ev)); else o.children.delete(ev.state_key); }
    else if (ev.type === 'im.ponies.room_emotes') o.packs.set(ev.state_key, c);
  }
  return o;
}
const childOf = ev => ({ id: ev.state_key, order: typeof ev.content?.order === 'string' ? ev.content.order : null, ts: Number(ev.origin_server_ts) || 0, via: (ev.content?.via || []).filter(x => typeof x === 'string').slice(0, 3) });

// one /sync with nothing but room state in it: every room the bot is in, and its invites (accepted here, as the bridge does)
async function snapshot(s, fresh = false) {
  if (!fresh && s.snap && Date.now() - s.snap.at < 20e3) return s.snap.v;
  let r = await sync(s);
  const invites = Object.keys(r?.rooms?.invite || {}).slice(0, 50);
  if (invites.length) {
    let any = false;
    for (const id of invites) await call(s, 'POST', `${V3}/rooms/${enc(id)}/join`, {}).then(() => { any = true; }, () => {});
    if (any) r = await sync(s);
  }
  const rooms = new Map();
  for (const [id, room] of Object.entries(r?.rooms?.join || {}).slice(0, 2000)) rooms.set(id, roomFrom(id, [...(room?.state?.events || []), ...(room?.timeline?.events || [])]));
  s.snap = { at: Date.now(), v: rooms };
  return rooms;
}
// the rooms of a space the bot is not in itself, as far as the homeserver shows them to it
async function hierarchy(s, gid) {
  const out = new Map();
  let from = '';
  try {
    for (let page = 0; page < 6; page++) {
      const r = await call(s, 'GET', `/_matrix/client/v1/rooms/${enc(gid)}/hierarchy?limit=50&max_depth=4${from ? `&from=${enc(from)}` : ''}`, undefined, { timeout: 30000 });
      for (const x of Array.isArray(r.rooms) ? r.rooms : []) {
        if (typeof x?.room_id !== 'string') continue;
        const children = new Map();
        for (const ev of Array.isArray(x.children_state) ? x.children_state : []) if (typeof ev?.state_key === 'string' && Array.isArray(ev.content?.via) && ev.content.via.length) children.set(ev.state_key, childOf(ev));
        out.set(x.room_id, { id: x.room_id, joined: false, type: typeof x.room_type === 'string' ? x.room_type : null, name: clean(x.name, 100), topic: clean(x.topic, 300), avatar: MX.MXC.test(x.avatar_url || '') ? x.avatar_url : null, alias: clean(x.canonical_alias, 100), join: String(x.join_rule || 'public'), power: null, encrypted: !!x.encryption, children, packs: new Map() });
      }
      if (typeof r.next_batch !== 'string' || !r.next_batch) break;
      from = r.next_batch;
    }
  } catch { /* an older homeserver, or a space it won't walk: what the bot is in is still there */ }
  return out;
}

const nameOf = r => r.name || r.alias || r.id;
const isSpace = r => r.type === 'm.space';
// rooms that are in none of the spaces the bot is in
function looseRooms(rooms) {
  const inSpace = new Set([...rooms.values()].filter(isSpace).flatMap(r => [...r.children.keys()]));
  return [...rooms.values()].filter(r => !isSpace(r) && !inSpace.has(r.id));
}
const byOrder = (a, b) => (a.order === null ? 1 : 0) - (b.order === null ? 1 : 0) || (a.order || '').localeCompare(b.order || '') || a.ts - b.ts || a.id.localeCompare(b.id);
function channelOf(r, via = []) {
  const kind = !r.type ? 'text' : VOICE_TYPES.includes(r.type) ? 'voice' : null;
  const pl = r.power || {};
  return {
    id: r.id, name: nameOf(r), topic: r.topic, kind, skip: kind ? null : 'Ember has no channel like this',
    private: !OPEN_RULES.includes(r.join), locked: (Number(pl.events_default) || 0) > (Number(pl.users_default) || 0),
    encrypted: r.encrypted, joined: r.joined, via,
  };
}
async function gather(s, gid, fresh = false) {
  const rooms = await snapshot(s, fresh);
  if (gid === 'rooms') {
    const list = looseRooms(rooms).sort((a, b) => nameOf(a).localeCompare(nameOf(b))).slice(0, 300);
    return { guild: { id: 'rooms', name: `${s.bot}'s rooms`, topic: '', avatar: null }, groups: list.length ? [{ id: null, name: 'Text channels', channels: list.map(r => channelOf(r)) }] : [], emojis: [] };
  }
  const space = ROOM_ID.test(gid) ? rooms.get(gid) : null;
  if (!space || !isSpace(space)) throw err('bot_not_in_server', 404);
  const seen = await hierarchy(s, gid);
  const info = id => rooms.get(id) || seen.get(id) || null;
  const top = { id: null, name: 'Text channels', channels: [] };
  const groups = [top];
  const done = new Set([gid]);
  const walk = (id, group, depth) => {
    for (const k of [...(info(id)?.children.values() || [])].sort(byOrder)) {
      if (done.has(k.id)) continue;
      done.add(k.id);
      const r = info(k.id);
      if (!r) continue; // a room the bot is neither in nor shown
      if (!isSpace(r)) { group.channels.push(channelOf(r, k.via)); continue; }
      if (depth >= 4) continue;
      let g = group;
      if (depth === 0) { g = { id: r.id, name: clean(nameOf(r), 40), channels: [] }; groups.push(g); } // (a space inside a sub-space joins its category)
      walk(k.id, g, depth + 1);
    }
  };
  walk(gid, top, 0);
  return { guild: { id: gid, name: nameOf(space), topic: space.topic, avatar: space.avatar }, groups: groups.filter(g => g.channels.length), emojis: emojisOf(space) };
}
// custom emoji packs of the space (MSC2545, the `im.ponies.room_emotes` state event Element and others write)
function emojisOf(room) {
  const out = [];
  for (const pack of room.packs.values()) {
    const packUse = Array.isArray(pack?.pack?.usage) ? pack.pack.usage : null;
    for (const [code, img] of Object.entries(pack?.images && typeof pack.images === 'object' ? pack.images : {})) {
      const use = Array.isArray(img?.usage) ? img.usage : packUse;
      if (!MX.MXC.test(img?.url || '') || (use && use.length && !use.includes('emoticon'))) continue;
      const name = String(code).replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32);
      if (name && !out.some(e => e.name === name)) out.push({ name, url: img.url });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- the picker (same shapes as Velora's /bonfire/import/*)
async function guilds(me, fresh) {
  C.assertMayCreate(me);
  const s = need(me);
  const rooms = await snapshot(s, fresh).catch(fail);
  const all = [...rooms.values()];
  const out = all.filter(isSpace).sort((a, b) => nameOf(a).localeCompare(nameOf(b))).slice(0, 50).map(r => ({ id: r.id, name: nameOf(r), icon: null, rooms: r.children.size }));
  const loose = looseRooms(rooms).length;
  if (loose) out.push({ id: 'rooms', name: 'Rooms outside a space', icon: null, rooms: loose, loose: true });
  return { bot: s.bot, guilds: out };
}
async function preview(me, gid) {
  C.assertMayCreate(me);
  const s = need(me);
  const g = await gather(s, String(gid), true).catch(fail);
  return {
    platform: 'matrix', guild: { id: g.guild.id, name: g.guild.name, description: g.guild.topic, icon: null, has_icon: !!g.guild.avatar, banner: null },
    groups: g.groups.map(x => ({ id: x.id, name: x.name, channels: x.channels.map(({ via, ...c }) => c) })),
    roles: ROLES.map(r => ({ id: r.id, name: r.name, color: null, admin: r.id === 'admin' })), everyone_send: true,
    emojis: g.emojis.slice(0, 100).map(e => ({ id: e.name, name: e.name, animated: false, url: null })), emoji_total: g.emojis.length,
    can_bridge: managed.allows('bridges'),
  };
}
function fail(e) {
  if (e.code && e.status && !e.errcode) throw e;
  if (e.status === 401 || e.errcode === 'M_UNKNOWN_TOKEN') throw err('invalid_token', 400, { platform: 'matrix' });
  throw err('platform_unreachable', 502, { platform: 'matrix' });
}

// ---------------------------------------------------------------- the import: a bonfire-export-v1 zip, fed to the normal importer
const running = new Set();
async function run(me, body) {
  C.assertMayCreate(me);
  const s = need(me);
  const want = new Set(Array.isArray(body.channels) && body.channels.length <= 300 ? body.channels.map(String).filter(x => ROOM_ID.test(x)) : []);
  if (!want.size) throw err('pick_a_channel');
  if (running.has(me.id)) throw err('import_running', 429);
  running.add(me.id);
  try {
    const { zipSync, strToU8 } = require('fflate');
    const g = await gather(s, String(body.guild_id || ''), true).catch(fail);
    const picked = g.groups.flatMap(grp => grp.channels.filter(c => c.kind && want.has(c.id)).map(c => ({ ...c, category: grp.name }))).slice(0, C.LIMITS.channels);
    if (!picked.length) throw err('pick_a_channel');
    const wantRoles = new Set(Array.isArray(body.roles) ? body.roles.map(String) : []);
    const extra = ROLES.filter(r => wantRoles.has(r.id)).reverse(); // (moderators below admins)
    const roles = [{ rid: 'everyone', name: '@everyone', color: null, position: 0, permissions: EVERYONE_DEFAULT, hoist: false, mentionable: false, is_default: true },
      ...extra.map((r, i) => ({ rid: r.id, name: r.name, color: null, position: i + 1, permissions: r.permissions, hoist: true, mentionable: false, is_default: false }))];
    const channels = picked.map((c, i) => ({
      cid: `c${i}`, name: c.name, topic: c.topic, category: c.category, position: i, locked: c.locked && c.kind === 'text', type: c.kind, config: null,
      // an invite-only room stays out of sight here: only the roles brought over (and the owner) see it
      perms: c.private ? [{ role: 'everyone', allow: 0, deny: P.VIEW }, ...extra.map(r => ({ role: r.id, allow: P.VIEW, deny: 0 }))] : [],
    }));
    const files = {};
    let icon = null;
    if (body.icon !== false && g.guild.avatar) {
      try {
        const buf = await MX.media(g.guild.avatar, { thumb: true, size: 256, maxBytes: 4 << 20, ...auth(s) });
        const sn = uploads.sniff(buf);
        if (sn && ['image', 'gif'].includes(sn.type)) { icon = `files/icon.${sn.ext}`; files[icon] = new Uint8Array(buf); }
      } catch { /* no picture then */ }
    }
    const emojis = [];
    if (body.emojis !== false) {
      for (const e of g.emojis.slice(0, C.LIMITS.emojis)) {
        try {
          const buf = await MX.media(e.url, { maxBytes: 2 << 20, ...auth(s) });
          const sn = uploads.sniff(buf);
          if (!sn || !['image', 'gif'].includes(sn.type)) continue;
          const eid = `e${crypto.randomBytes(5).toString('hex')}`, file = `files/emojis/${eid}.${sn.ext}`;
          files[file] = new Uint8Array(buf);
          emojis.push({ eid, name: e.name, animated: sn.ext === 'gif', file });
        } catch { /* skip it */ }
      }
    }
    const community = {
      name: clean(body.name, 60) || clean(g.guild.name, 60) || 'Matrix', description: clean(g.guild.topic, 300), icon, banner: null,
      settings: { join_policy: 'open', allow_uploads: true, upload_max_mb: 12 },
      categories: [...new Set(picked.map(c => c.category))], channels, roles, emojis, invites: [],
    };
    files['community.json'] = strToU8(JSON.stringify(community));
    files['members.jsonl'] = strToU8('');
    files['manifest.json'] = strToU8(JSON.stringify({ format: 'bonfire-export-v1', source: normalizeOrigin(config.publicUrl()), source_kind: 'matrix-import', exported_at: Date.now(), community: `matrix_${g.guild.id}` }));
    C.assertMayCreate(me); // someone may have set the community up meanwhile
    const c = require('../export').importCommunity(me, Buffer.from(zipSync(files, { level: 6 })));
    let bridged = 0;
    if (body.bridge && managed.allows('bridges')) bridged = await bridgeRooms(me, s, c, picked).catch(e => { console.error('[import] matrix bridge', e.message); return 0; });
    sessions.delete(me.id);
    return { sid: c.sid, channels: picked.length, roles: extra.length, emojis: emojis.length, bridged };
  } finally { running.delete(me.id); }
}
// "bridge it": the import's bot becomes the bridge's bot, and each imported text room is linked to its new channel
async function bridgeRooms(me, s, c, picked) {
  const B = require('./bridge');
  if (!s.saved) await MX.saveSettings({ homeserver: s.base, token: s.token });
  await B.link(me, c.sid, 'matrix', 'rooms', false);
  const b = db.get('SELECT id FROM bridge_guilds WHERE community_id = ? AND platform = ?', c.id, 'matrix');
  const rows = db.all('SELECT id, position FROM channels WHERE community_id = ?', c.id);
  let n = 0;
  for (let i = 0; i < picked.length; i++) {
    const x = picked[i], ch = rows.find(r => r.position === i);
    if (!ch || x.kind !== 'text' || x.encrypted || B.linkByExt('matrix', x.id)) continue;
    if (!x.joined) { // a room of the space the bot may walk into (public, or open to the space's members)
      if (x.private) continue;
      try {
        await MX.api('POST', `${V3}/join/${enc(x.id)}${x.via.length ? `?${x.via.map(v => `server_name=${enc(v)}`).join('&')}` : ''}`, {});
        if ((await MX.roomOf(x.id, true)).encrypted) continue;
      } catch { continue; }
    }
    db.run('INSERT OR IGNORE INTO bridge_channels (channel_id, bridge_id, ext_channel_id, ext_name) VALUES (?, ?, ?, ?)', ch.id, b.id, x.id, clean(x.name, 100));
    n++;
  }
  C.channelsChanged(db.get('SELECT * FROM communities WHERE id = ?', c.id));
  return n;
}

module.exports = { view, setBot, dropBot, guilds, preview, run, _test: { sessions } };
