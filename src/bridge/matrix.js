'use strict';
// Matrix <-> this instance's community (PROTOCOL §16.5). The instance owner brings a bot: an ordinary Matrix account on any
// homeserver (its address + an access token). No application service, so nothing has to be installed on the homeserver.
//   Matrix -> here: the bot long-polls /sync; messages in linked rooms are posted with messages.postBridged as the person
//                   (display name + picture), tagged "matrix"
//   here -> Matrix: the bot posts "<name>: <text>" (Matrix has no webhooks: a bot can only speak as itself)
// Rooms: the bot accepts every invite; a channel is linked to one of the rooms it is in. Encrypted rooms can't be linked
// (the bot holds no keys). Loop prevention: the bot's own events are never taken back in. Edits, deletes and replies are
// mirrored through the same bridge_msgs id map the Discord / Fluxer bridge uses.
// The homeserver address is typed by an admin: only public addresses are ever connected to (checked on every connection).
const { env } = require('../compat');
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const uploads = require('../uploads');
const store = require('./store');
const { isPrivateIp } = require('../unfurl');
const { err, now, clean, normalizeOrigin, log } = require('../util');

const M = () => require('../messages');
const B = () => require('./bridge');
const P = 'matrix';
const UA = 'Ember-Bridge/1.0 (+https://github.com/Ikelene/ember-server)';
const ZW = String.fromCharCode(0x200b);
const V3 = '/_matrix/client/v3';
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
const enc = encodeURIComponent;
const origin = () => normalizeOrigin(config.publicUrl());

// ---------------------------------------------------------------- the bots: homeserver + access token (write-only) each
// One bot for the homeserver (key 0: bridge_settings, then EMBER_MATRIX_HOMESERVER / EMBER_MATRIX_TOKEN), and one for every
// server that brought its own Matrix account (key = the community's id: table matrix_bots). A server without one uses the
// homeserver's. Each bot has its own sync loop, its own place in the stream and its own view of rooms and people.
class Bot {
  constructor(key) { this.key = key; this.client = null; this.forget(); }
  row() { store.ensure(); return db.get('SELECT * FROM matrix_bots WHERE community_id = ?', this.key) || null; }
  get homeserver() { return this.key ? this.row()?.homeserver || '' : store.setting('matrix.homeserver') || cleanEnvHomeserver() || ''; }
  get token() { return this.key ? this.row()?.token || '' : store.setting('matrix.token') || env('MATRIX_TOKEN') || ''; }
  get source() { return this.key ? (this.row() ? 'server' : null) : store.setting('matrix.token') ? 'settings' : env('MATRIX_TOKEN') ? 'env' : null; }
  get id() { return (this.key ? this.row()?.user_id : store.setting('matrix.user_id')) || null; }
  set id(v) { if (this.key) db.run('UPDATE matrix_bots SET user_id = ? WHERE community_id = ?', v, this.key); else store.setSetting('matrix.user_id', v); }
  get since() { return (this.key ? this.row()?.next_batch : store.setting('matrix.since')) || null; }
  set since(v) { if (this.key) db.run('UPDATE matrix_bots SET next_batch = ? WHERE community_id = ?', v, this.key); else store.setSetting('matrix.since', v); }
  get configured() { return !!(this.homeserver && this.token); }
  // another account or homeserver starts at its own place in the stream
  save(base, tok, id, by = null) {
    const fresh = id !== this.id || base !== this.homeserver;
    if (this.key) {
      db.run(`INSERT INTO matrix_bots (community_id, homeserver, token, user_id, next_batch, updated_by, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(community_id) DO UPDATE SET homeserver = excluded.homeserver, token = excluded.token, user_id = excluded.user_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at${fresh ? ', next_batch = NULL' : ''}`,
        this.key, base, tok, id, by, now());
      return;
    }
    if (fresh) store.setSetting('matrix.since', null);
    store.setSetting('matrix.homeserver', base); store.setSetting('matrix.token', tok); store.setSetting('matrix.user_id', id);
  }
  remove() {
    if (this.key) db.run('DELETE FROM matrix_bots WHERE community_id = ?', this.key);
    else for (const k of ['token', 'homeserver', 'user_id', 'since']) store.setSetting(`matrix.${k}`, null);
  }
  // what it knows about rooms and people
  forget() {
    this.roomInfo = new Map(); // room id -> { at, v: { id, name, encrypted } }
    this.members = new Map(); // "<room>\n<user>" -> { at, name, avatar }
    this.roomList = null; // { at, v: [info] }
    this.typingNow = new Map(); // room id -> Set of user ids
    this.typedOut = new Map(); // room id -> when
  }
}
const bots = new Map(); // key -> Bot
const botOf = (key = 0) => { key = Number(key) || 0; let b = bots.get(key); if (!b) { b = new Bot(key); bots.set(key, b); } return b; };
const hasOwn = cid => { if (!cid) return false; store.ensure(); return !!db.get('SELECT 1 FROM matrix_bots WHERE community_id = ?', Number(cid)); };
// the bot a server uses (cid: its community id; none = the homeserver's): its own when it brought one
const botFor = (cid = null) => (cid instanceof Bot ? cid : hasOwn(cid) ? botOf(cid) : botOf(0));
const homeserver = cid => botFor(cid).homeserver;
const botId = cid => botFor(cid).id;
const configured = cid => botFor(cid).configured;
function cleanEnvHomeserver() { try { return env('MATRIX_HOMESERVER') ? cleanHomeserver(env('MATRIX_HOMESERVER')) : ''; } catch { return ''; } }

// development / tests: a homeserver on this machine or the LAN
let allowLocal = false;
const local = () => allowLocal || env('DEV') === '1';
// "matrix.org" / "https://matrix.example.org/" -> "https://matrix.example.org" (https only, no user:pass@, a public host)
function cleanHomeserver(raw) {
  const bad = () => err('invalid_homeserver', 400, { platform: P });
  let s = String(raw || '').trim();
  if (!s || s.length > 300 || /\s/.test(s)) throw bad();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u; try { u = new URL(s); } catch { throw bad(); }
  if (u.username || u.password || u.search || u.hash) throw bad();
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local())) throw bad();
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!local()) {
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) throw bad();
    if (net.isIP(host) ? isPrivateIp(host) : /^[0-9.]+$|^0x/i.test(host)) throw bad(); // (and numeric spellings like 2130706433)
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

// ---------------------------------------------------------------- http (every connection goes to a checked, public address)
let resolver = (host, cb) => dns.lookup(host, { all: true }, cb);
function safeLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  resolver(host, (e, list) => {
    if (e) return cb(e);
    const all = Array.isArray(list) ? list : [{ address: list, family: net.isIPv6(list) ? 6 : 4 }];
    if (!all.length || (!local() && all.some(x => isPrivateIp(x.address)))) return cb(Object.assign(new Error('private_address'), { code: 'EPRIVATE' }));
    return opts && opts.all ? cb(null, all) : cb(null, all[0].address, all[0].family);
  });
}
// -> { status, headers, body: Buffer }. No redirects are followed.
function request(method, url, { token, body, timeout = 20000, maxBytes = 4 << 20, signal } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error('bad_url')); }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!local() && net.isIP(host) && isPrivateIp(host)) return reject(Object.assign(new Error('private_address'), { code: 'EPRIVATE' }));
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method, timeout, lookup: safeLookup,
      headers: { 'User-Agent': UA, Accept: '*/*', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
    }, res => {
      const chunks = []; let n = 0;
      res.on('data', d => { n += d.length; if (n > maxBytes) return req.destroy(Object.assign(new Error('too_big'), { code: 'too_big' })); chunks.push(d); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (signal) { if (signal.aborted) req.destroy(new Error('aborted')); else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true }); }
    req.end(payload || undefined);
  });
}
// the client-server API as JSON. Waits out 429s (retry_after_ms, 15 s at most, 5 tries). Errors carry { status, errcode }
async function api(method, route, body, { bot = botOf(0), token = bot.token, base = bot.homeserver, timeout, signal, maxBytes } = {}) {
  for (let i = 0; i < 5; i++) {
    const r = await request(method, base + route, { token, body, timeout, signal, maxBytes });
    let j = {}; try { j = r.body.length ? JSON.parse(r.body.toString('utf8')) : {}; } catch { /* not json */ }
    if (r.status === 429) { await sleep(Math.min(Number(j.retry_after_ms) || Number(r.headers['retry-after']) * 1000 || 1000, 15000) + 100); continue; }
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`matrix ${method} ${route.split('?')[0]} -> ${r.status} ${j.errcode || ''}`.trim()), { status: r.status, errcode: j.errcode || null });
    return j;
  }
  throw err('rate_limited', 429);
}
// a file behind an mxc:// address (authenticated media first, the old public path for homeservers that predate it)
const MXC = /^mxc:\/\/([A-Za-z0-9.:[\]_-]{1,255})\/([A-Za-z0-9_=-]{1,255})$/;
async function media(mxc, { thumb = false, size = 128, maxBytes = 4 << 20, bot = botOf(0), token = bot.token, base = bot.homeserver } = {}) {
  const m = MXC.exec(String(mxc || ''));
  if (!m) throw new Error('bad_mxc');
  const tail = `/${thumb ? 'thumbnail' : 'download'}/${enc(m[1])}/${enc(m[2])}${thumb ? `?width=${size}&height=${size}&method=crop` : ''}`;
  let r = await request('GET', `${base}/_matrix/client/v1/media${tail}`, { token, maxBytes });
  if ([400, 404, 405].includes(r.status)) r = await request('GET', `${base}/_matrix/media/v3${tail}`, { token, maxBytes });
  if (r.status !== 200) throw Object.assign(new Error(`media ${r.status}`), { status: r.status });
  return r.body;
}

const mask = t => (t ? `${'*'.repeat(8)}${String(t).slice(-4)}` : null);
function settingsView(bot = botOf(0)) {
  const id = bot.id;
  return {
    configured: bot.configured, token: mask(bot.token), homeserver: bot.homeserver || null, source: bot.source,
    state: bot.client ? bot.client.state : 'off', error: bot.client?.error || null, bot: id && bot.configured ? { id, username: id } : null,
  };
}
// GET /bridge/servers/:sid/matrix: the server's own bot, or (own: false) the homeserver's it falls back to, whose token and address stay out of sight
function serverView(cid) {
  if (hasOwn(cid)) return { own: true, ...settingsView(botOf(cid)) };
  const v = settingsView(botOf(0));
  return { own: false, ...v, token: null, homeserver: null, source: v.configured ? 'homeserver' : null };
}
// PATCH /bridge/servers/:sid/matrix { homeserver?, token? }: token null goes back to the homeserver's bot
async function saveServer(cid, v, by = null) { await saveSettings(v, botOf(cid), by); return serverView(cid); }
// a typed "matrix.org" may only say where its homeserver really is (/.well-known/matrix/client)
async function discover(base) {
  try {
    const r = await request('GET', `${base}/.well-known/matrix/client`, { timeout: 8000, maxBytes: 64 * 1024 });
    const found = r.status === 200 ? JSON.parse(r.body.toString('utf8'))?.['m.homeserver']?.base_url : null;
    return typeof found === 'string' && found ? cleanHomeserver(found) : base;
  } catch { return base; }
}
// whose token this is on that homeserver -> "@bot:example.org"
async function whoami(base, tok) {
  let who;
  try { who = await api('GET', `${V3}/account/whoami`, undefined, { token: tok, base, timeout: 12000 }); } catch (e) {
    if (e.status === 401 || e.status === 403) throw err('invalid_token', 400, { platform: P });
    if (e.code === 'EPRIVATE') throw err('invalid_homeserver', 400, { platform: P });
    throw err('platform_unreachable', 502, { platform: P });
  }
  if (typeof who?.user_id !== 'string' || !/^@[^\s:]+:\S+$/.test(who.user_id)) throw err('platform_unreachable', 502, { platform: P });
  return who.user_id;
}
const cleanToken = v => {
  const t = typeof v === 'string' ? v.trim().replace(/^Bearer\s+/i, '') : '';
  if (t.length > 4096 || /\s/.test(t)) throw err('invalid_token', 400, { platform: P });
  return t;
};
// patch: { homeserver?: "<address>", token?: "<new>" | null (remove) | "" (keep) }. Checked with /account/whoami before it's saved.
async function saveSettings(v, bot = botOf(0), by = null) {
  if (!v || typeof v !== 'object') return;
  if (v.token === null) {
    bot.remove();
    restart(bot);
    return;
  }
  const hsIn = typeof v.homeserver === 'string' && v.homeserver.trim() ? v.homeserver : null;
  if (v.homeserver != null && typeof v.homeserver !== 'string') throw err('invalid_homeserver', 400, { platform: P });
  if (v.token != null && typeof v.token !== 'string') throw err('invalid_token', 400, { platform: P });
  const tokIn = cleanToken(v.token);
  if (!hsIn && !tokIn) return; // nothing new
  const base = hsIn ? await discover(cleanHomeserver(hsIn)) : bot.homeserver;
  const tok = tokIn || bot.token;
  if (!base) throw err('invalid_homeserver', 400, { platform: P });
  if (!tok) throw err('invalid_token', 400, { platform: P });
  const id = await whoami(base, tok);
  bot.save(base, tok, id, by);
  restart(bot);
}

// ---------------------------------------------------------------- what the bot knows about rooms and people
// (each bot keeps its own: Bot.forget). Where a function takes `bot`, a community id (or nothing: the homeserver's) works too.
const state = (bot, roomId, type, key = '') => api('GET', `${V3}/rooms/${enc(roomId)}/state/${enc(type)}/${enc(key)}`, undefined, { bot }).catch(e => { if (e.status === 404) return null; throw e; });
async function roomOf(roomId, fresh = false, bot = null) {
  bot = botFor(bot);
  const hit = bot.roomInfo.get(roomId);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
  const [name, alias, crypt] = await Promise.all([state(bot, roomId, 'm.room.name'), state(bot, roomId, 'm.room.canonical_alias'), state(bot, roomId, 'm.room.encryption')]);
  const v = { id: roomId, name: clean(name?.name, 100) || clean(alias?.alias, 100) || roomId, encrypted: !!crypt };
  bot.roomInfo.set(roomId, { at: Date.now(), v });
  if (bot.roomInfo.size > 2000) bot.roomInfo.delete(bot.roomInfo.keys().next().value);
  return v;
}
// the rooms the bot is in (at most 300), by name. fresh: ask which rooms again (what is known about each room is kept for
// 10 minutes, and dropped sooner when /sync says its name or encryption changed)
async function rooms(fresh = false, bot = null) {
  bot = botFor(bot);
  if (!fresh && bot.roomList && Date.now() - bot.roomList.at < 30e3) return bot.roomList.v;
  const ids = ((await api('GET', `${V3}/joined_rooms`, undefined, { bot })).joined_rooms || []).filter(x => typeof x === 'string').slice(0, 300);
  const out = [];
  for (let i = 0; i < ids.length; i += 6) out.push(...(await Promise.all(ids.slice(i, i + 6).map(id => roomOf(id, false, bot).catch(() => null)))).filter(Boolean));
  out.sort((a, b) => a.name.localeCompare(b.name));
  bot.roomList = { at: Date.now(), v: out };
  return out;
}
const localpart = id => String(id || '').replace(/^@/, '').split(':')[0] || 'someone';
function noteMember(bot, roomId, ev) {
  if (typeof ev.state_key !== 'string') return;
  bot.members.set(`${roomId}\n${ev.state_key}`, { at: Date.now(), name: clean(ev.content?.displayname, 80) || null, avatar: MXC.test(ev.content?.avatar_url || '') ? ev.content.avatar_url : null });
  if (bot.members.size > 20000) bot.members.delete(bot.members.keys().next().value);
}
async function memberOf(bot, roomId, userId) {
  const k = `${roomId}\n${userId}`;
  const hit = bot.members.get(k);
  if (hit && Date.now() - hit.at < 3600e3) return hit;
  const m = await state(bot, roomId, 'm.room.member', userId).catch(() => null);
  noteMember(bot, roomId, { state_key: userId, content: m || {} });
  return bot.members.get(k);
}

// ---------------------------------------------------------------- files: pictures + attachments are re-hosted here
async function hostAvatar(mxc, bot) {
  if (!MXC.test(mxc || '')) return null;
  const rel = `bridge/avatars/matrix_${crypto.createHash('sha256').update(mxc).digest('hex').slice(0, 24)}.png`;
  if (!fs.existsSync(path.join(uploads.root(), rel))) {
    try {
      const buf = await media(mxc, { thumb: true, bot });
      const sn = uploads.sniff(buf);
      if (!sn || !['image', 'gif'].includes(sn.type)) return null;
      uploads.writeStored(rel, buf);
    } catch { return null; }
  }
  return `${origin()}/uploads/${rel}`;
}
async function hostFile(content, maxBytes, bot, communityId = null) {
  if (!MXC.test(content?.url || '') || (Number(content.info?.size) || 0) > maxBytes) return null; // (an encrypted file has no `url`)
  try {
    const buf = await media(content.url, { maxBytes, bot });
    const name = String(content.filename || content.body || 'file').replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
    const up = uploads.storeUpload(buf, name, null, { communityId });
    return { url: up.url, type: up.type, name: up.name, size: up.size, width: up.width || Number(content.info?.w) || undefined, height: up.height || Number(content.info?.h) || undefined };
  } catch { return null; }
}

// ---------------------------------------------------------------- text both ways
const snippet = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}...` : s; };
// the quoted lines Matrix clients put on top of a reply ("> <@alice:example.org> what she said", then an empty line)
function splitReply(body) {
  const lines = String(body || '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  if (!i) return { quote: null, rest: body };
  const first = /^>\s?(?:\*\s)?<(@[^>\s]+)>\s?(.*)$/.exec(lines[0]);
  return { quote: first ? { who: localpart(first[1]), text: first[2] } : { who: null, text: lines[0].replace(/^>\s?/, '') }, rest: lines.slice(lines[i] === '' ? i + 1 : i).join('\n') };
}
// Matrix text -> Ember text: nothing that pings here (@everyone / @here / @room, and Ember's own tokens typed over there)
const quiet = t => String(t || '').replace(/@(everyone|here|room)\b/g, `@${ZW}$1`).replace(/<@&/g, `<${ZW}@&`).replace(/<@([vlb]:)/g, `<${ZW}@$1`);
// reply: 'real' (it became a real reply here: drop the quote) | 'quote' (the message it answers isn't here: keep one quoted line) | null
function textIn(content, reply = null) {
  let t = String(content?.body || '').slice(0, 8000);
  if (reply) {
    const { quote, rest } = splitReply(t);
    t = reply === 'quote' && quote ? `> ${quote.who ? `**${quote.who}** ` : ''}${snippet(quote.text || '(a picture)')}\n${rest}` : rest;
  }
  if (content?.msgtype === 'm.emote') t = `*${t}*`;
  return quiet(t);
}
// Ember text -> plain text for Matrix (tokens as names)
function textOut(body, communityId) {
  let t = String(body || '');
  const roles = db.all('SELECT rid, name FROM roles WHERE community_id = ?', communityId);
  t = t.replace(/<@&(r[0-9a-f]{10})>/g, (_, rid) => `@${roles.find(r => r.rid === rid)?.name || 'role'}`);
  t = t.replace(/<@!?((?:[vlb]:)?\d{1,20}(?:@[a-z0-9.-]{1,253})?|[A-Za-z0-9][A-Za-z0-9._:-]{0,63}@[a-z0-9.-]{1,253})>/g, (_, p) => `@${db.get('SELECT username FROM users WHERE principal = ?', p)?.username || 'someone'}`);
  t = t.replace(/<#(c[0-9a-f]{10})>/g, (_, cid) => `#${db.get('SELECT name FROM channels WHERE cid = ?', cid)?.name || 'channel'}`);
  return t.replace(/<a?:(\w+):e[0-9a-f]{10}>/g, ':$1:');
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const html = s => esc(s).replace(/\n/g, '<br>');
const absUrl = u => (!u ? null : /^https?:/i.test(u) ? u : `${origin()}${u.startsWith('/') ? '' : '/'}${u}`);

// ---------------------------------------------------------------- Matrix -> here
const mapOf = (extId, inboundOnly = false) => db.get(`SELECT message_id, outbound FROM bridge_msgs WHERE ext_message_id = ? AND platform = ?${inboundOnly ? ' AND outbound = 0' : ''}`, String(extId), P);
function onRoomEvent(roomId, ev, bot = null) {
  bot = botFor(bot);
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'm.room.member') return noteMember(bot, roomId, ev);
  if (['m.room.name', 'm.room.canonical_alias', 'm.room.encryption'].includes(ev.type)) { bot.roomInfo.delete(roomId); bot.roomList = null; return; }
  if (ev.sender === bot.id) return; // our own posts from here
  const key = `in:${P}:${roomId}`;
  if (ev.type === 'm.room.redaction') {
    const target = ev.redacts || ev.content?.redacts;
    if (!target) return;
    return B().enqueue(key, async () => {
      const m = mapOf(target, true);
      if (m) { db.run('DELETE FROM bridge_msgs WHERE message_id = ? AND platform = ?', m.message_id, P); M().deleteBridged(m.message_id); }
    });
  }
  if (ev.type === 'm.room.message' || ev.type === 'm.sticker') return B().enqueue(key, () => inbound(roomId, ev, bot));
}
async function inbound(roomId, ev, bot) {
  const link = B().linkByExt(P, roomId);
  if (!link || !link.enabled || !ev.event_id) return;
  if (botFor(link.community_id) !== bot) return; // the room is another bot's to carry (two bots can sit in one room)
  const content = ev.content && typeof ev.content === 'object' ? ev.content : {};
  const rel = content['m.relates_to'] && typeof content['m.relates_to'] === 'object' ? content['m.relates_to'] : {};
  if (rel.rel_type === 'm.replace') { // an edit: the new text is in m.new_content
    const m = rel.event_id && mapOf(rel.event_id, true);
    const fresh = content['m.new_content'];
    if (m && fresh && typeof fresh.body === 'string') M().editBridged(m.message_id, textIn(fresh));
    return;
  }
  if (mapOf(ev.event_id)) return; // already here (the same stretch of /sync read twice after a restart)
  const ch = db.get('SELECT * FROM channels WHERE id = ?', link.channel_id);
  const c = ch && db.get('SELECT * FROM communities WHERE id = ?', ch.community_id);
  if (!c) return;
  const kind = ev.type === 'm.sticker' ? 'm.sticker' : content.msgtype;
  const fileish = ['m.image', 'm.video', 'm.audio', 'm.file', 'm.sticker'].includes(kind);
  if (!fileish && !['m.text', 'm.notice', 'm.emote'].includes(kind)) return;
  const replied = rel['m.in_reply_to']?.event_id;
  const target = replied ? mapOf(replied) : null;
  let body = '';
  const atts = [];
  if (fileish) {
    const maxBytes = Math.min(25, c.upload_max_mb || 25, config.get().max_upload_mb || 25) * 1024 * 1024;
    const h = c.allow_uploads ? await hostFile(content, maxBytes, bot, c.id) : null;
    const name = clean(content.filename || content.body, 120) || 'file';
    if (h) atts.push(h);
    // (a caption: `body` is text of its own when `filename` says what the file is called)
    if (kind !== 'm.sticker' && content.filename && content.body && content.body !== content.filename) body = textIn(content, replied ? (target ? 'real' : 'quote') : null);
    if (!h) body = [body, `[${name}]`].filter(Boolean).join('\n');
  } else body = textIn(content, replied ? (target ? 'real' : 'quote') : null);
  if (!body.trim() && !atts.length) return;
  const who = await memberOf(bot, roomId, ev.sender);
  const msg = M().postBridged(ch, { platform: P, name: who?.name || localpart(ev.sender), avatar: await hostAvatar(who?.avatar, bot), body, attachments: atts, replyTo: target ? target.message_id : null });
  db.run('INSERT OR IGNORE INTO bridge_msgs (message_id, platform, ext_message_id, ext_channel_id, outbound, created_at) VALUES (?, ?, ?, ?, 0, ?)', Number(msg.id), P, String(ev.event_id), String(roomId), now());
}

// ---------------------------------------------------------------- here -> Matrix (the bot says "<name>: <text>")
let txn = 0;
const send = (bot, roomId, content) => api('PUT', `${V3}/rooms/${enc(roomId)}/send/m.room.message/${enc(`ember${Date.now()}_${++txn}`)}`, content, { bot });
function composed(msg, communityId) {
  const a = msg.author || {};
  const name = clean(a.display_name || a.username, 80) || 'Ember';
  let text = textOut(msg.body, communityId);
  if (!text.trim() && msg.embeds?.length) text = msg.embeds.map(e => [e?.title, e?.description].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
  for (const f of msg.attachments || []) if (f?.url) text += `${text ? '\n' : ''}${absUrl(f.url)}`;
  if (text.length > 8000) text = `${text.slice(0, 7990)}...`;
  return { name, text };
}
const contentOf = (name, text, quote = null) => ({
  msgtype: 'm.text', body: `${quote ? `> ${quote}\n\n` : ''}${name}: ${text}`, format: 'org.matrix.custom.html',
  formatted_body: `${quote ? `<blockquote>${esc(quote)}</blockquote>` : ''}<strong>${esc(name)}</strong>: ${html(text)}`,
});
async function outbound(link, ctx, msg) {
  const { name, text } = composed(msg, ctx.c.id);
  if (!text.trim()) return;
  let quote = null, relates = null;
  if (msg.reply) {
    const m = db.get('SELECT ext_message_id FROM bridge_msgs WHERE message_id = ? AND platform = ?', Number(msg.reply.id), P);
    if (m) relates = { 'm.in_reply_to': { event_id: m.ext_message_id } };
    else quote = `${msg.reply.author?.display_name || msg.reply.author?.username || 'Ember'}: ${snippet(msg.reply.body || '(a picture)')}`;
  }
  const sent = await send(botFor(link.community_id), link.ext_channel_id, { ...contentOf(name, text, quote), ...(relates ? { 'm.relates_to': relates } : {}) });
  if (sent?.event_id) db.run('INSERT OR IGNORE INTO bridge_msgs (message_id, platform, ext_message_id, ext_channel_id, outbound, created_at) VALUES (?, ?, ?, ?, 1, ?)', Number(msg.id), P, String(sent.event_id), link.ext_channel_id, now());
  typingOut(link, false);
}
async function editOut(link, ctx, msg) {
  const m = db.get('SELECT ext_message_id, outbound FROM bridge_msgs WHERE message_id = ? AND platform = ?', Number(msg.id), P);
  if (!m || !m.outbound) return;
  const { name, text } = composed(msg, ctx.c.id);
  if (!text.trim()) return;
  const fresh = contentOf(name, text);
  await send(botFor(link.community_id), link.ext_channel_id, { ...fresh, body: `* ${fresh.body}`, formatted_body: `* ${fresh.formatted_body}`, 'm.new_content': fresh, 'm.relates_to': { rel_type: 'm.replace', event_id: m.ext_message_id } });
}
// a delete here: the copy over there is redacted (someone else's message needs the bot to be a moderator in that room)
async function deleteOut(link, id) {
  const m = db.get('SELECT ext_message_id FROM bridge_msgs WHERE message_id = ? AND platform = ?', Number(id), P);
  if (!m) return;
  db.run('DELETE FROM bridge_msgs WHERE message_id = ? AND platform = ?', Number(id), P);
  await api('PUT', `${V3}/rooms/${enc(link.ext_channel_id)}/redact/${enc(m.ext_message_id)}/${enc(`ember${Date.now()}_${++txn}`)}`, {}, { bot: botFor(link.community_id) }).catch(() => {});
}

// ---------------------------------------------------------------- who is typing
// m.typing lists everyone typing in the room right now, and comes again when that changes
async function typingIn(roomId, ids, bot = null) {
  bot = botFor(bot);
  const link = B().linkByExt(P, roomId);
  if (!link || botFor(link.community_id) !== bot) return;
  const typingNow = bot.typingNow;
  const now = new Set((Array.isArray(ids) ? ids : []).filter(x => typeof x === 'string' && x !== bot.id).slice(0, 20));
  const was = typingNow.get(roomId) || new Set();
  if (now.size) typingNow.set(roomId, now); else typingNow.delete(roomId);
  for (const id of was) if (!now.has(id)) B().typingStop(P, roomId, id);
  for (const id of now) {
    if (was.has(id)) continue;
    const m = await memberOf(bot, roomId, id).catch(() => null);
    if (typingNow.get(roomId)?.has(id)) B().typingStart(P, roomId, id, { platform: P, name: m?.name || localpart(id), avatar: await hostAvatar(m?.avatar, bot) }, 30000);
  }
}
// the bot types in the room while someone types in the linked channel (8 s at a time), and stops when the message lands
function typingOut(link, on = true) {
  const bot = botFor(link.community_id), typedOut = bot.typedOut;
  const room = link.ext_channel_id, t = Date.now(), last = typedOut.get(room) || 0;
  if (on ? t - last < 6000 : !last) return;
  if (on) typedOut.set(room, t); else typedOut.delete(room);
  if (typedOut.size > 5000) typedOut.delete(typedOut.keys().next().value);
  api('PUT', `${V3}/rooms/${enc(room)}/typing/${enc(bot.id)}`, on ? { typing: true, timeout: 8000 } : { typing: false }, { bot }).catch(() => {});
}

// ---------------------------------------------------------------- the sync loop
const filterOf = limit => JSON.stringify({
  presence: { types: [] }, account_data: { types: [] },
  room: {
    account_data: { types: [] }, ephemeral: { types: ['m.typing'] },
    state: { types: ['m.room.member'], lazy_load_members: true },
    timeline: { types: ['m.room.message', 'm.sticker', 'm.room.redaction', 'm.room.member', 'm.room.name', 'm.room.canonical_alias', 'm.room.encryption'], limit, lazy_load_members: true },
  },
});
const FILTER = filterOf(50), FIRST_FILTER = filterOf(1); // (the first sync only wants its place in the stream)
class SyncClient {
  constructor(bot) { this.bot = bot; this.state = 'stopped'; this.error = null; this.attempts = 0; this.stopped = true; this.ctl = null; }
  start() { this.stopped = false; this.state = 'connecting'; this.loop().catch(e => console.error('[bridge] matrix sync', e.message)); }
  async loop() {
    const bot = this.bot;
    while (!this.stopped) {
      try {
        if (!bot.id) bot.id = (await api('GET', `${V3}/account/whoami`, undefined, { bot })).user_id;
        const since = bot.since;
        this.ctl = new AbortController();
        // the first sync only finds our place in the stream (what was said before the bridge existed stays there)
        const q = new URLSearchParams({ timeout: since ? '30000' : '0', filter: since ? FILTER : FIRST_FILTER, ...(since ? { since } : {}) });
        const r = await api('GET', `${V3}/sync?${q}`, undefined, { bot, timeout: 60000, signal: this.ctl.signal, maxBytes: 48 << 20 });
        if (this.stopped) return;
        if (this.state !== 'ready') log(`[bridge] matrix sync ready as ${bot.id}`);
        this.state = 'ready'; this.error = null; this.attempts = 0;
        await onSync(r, !since, bot);
        if (!this.stopped && typeof r.next_batch === 'string') bot.since = r.next_batch;
      } catch (e) {
        if (this.stopped) return;
        if (e.status === 401 || e.errcode === 'M_UNKNOWN_TOKEN' || e.errcode === 'M_USER_DEACTIVATED') { this.state = 'error'; this.error = 'invalid_token'; log('[bridge] matrix stopped: the access token is no longer valid'); return; }
        this.attempts++;
        this.state = 'waiting'; this.error = String(e.code === 'EPRIVATE' ? 'private_address' : e.errcode || e.code || e.message || 'failed').slice(0, 80);
        await sleep(Math.min(1000 * 2 ** Math.min(this.attempts - 1, 6), 60000) + Math.random() * 1000);
      }
    }
  }
  stop() { this.stopped = true; try { this.ctl?.abort(); } catch { /* gone */ } this.state = 'stopped'; }
}
async function onSync(r, first, bot = null) {
  bot = botFor(bot);
  for (const roomId of Object.keys(r?.rooms?.invite || {})) { // invited: join (an admin then picks the room in the bridge settings)
    await api('POST', `${V3}/rooms/${enc(roomId)}/join`, {}, { bot }).then(() => { bot.roomList = null; log(`[bridge] matrix joined ${roomId}`); }, e => log(`[bridge] matrix could not join ${roomId}: ${e.message}`));
  }
  for (const roomId of Object.keys(r?.rooms?.leave || {})) { bot.roomInfo.delete(roomId); bot.roomList = null; }
  for (const [roomId, room] of Object.entries(r?.rooms?.join || {})) {
    for (const ev of room?.state?.events || []) if (ev?.type === 'm.room.member') noteMember(bot, roomId, ev);
    if (!first) for (const ev of room?.ephemeral?.events || []) if (ev?.type === 'm.typing') typingIn(roomId, ev.content?.user_ids, bot).catch(e => console.error('[bridge] matrix typing', e.message));
    for (const ev of room?.timeline?.events || []) {
      if (first && !['m.room.member'].includes(ev?.type)) continue;
      try { onRoomEvent(roomId, ev, bot); } catch (e) { console.error('[bridge] matrix event', e.message); }
    }
  }
}
// (re)start one bot's sync loop; a server's bot that is gone leaves the list
function restart(bot = botOf(0)) {
  if (bot.client) bot.client.stop();
  bot.client = null;
  bot.forget();
  if (!bot.configured) { if (bot.key) bots.delete(bot.key); return; }
  bot.client = new SyncClient(bot);
  bot.client.start();
}
// the homeserver's bot and every server's own
function init() {
  store.ensure();
  for (const b of [...bots.values()]) if (b.key && !hasOwn(b.key)) { if (b.client) b.client.stop(); bots.delete(b.key); }
  restart(botOf(0));
  for (const r of db.all('SELECT community_id FROM matrix_bots')) restart(botOf(r.community_id));
}
function shutdown() { for (const b of bots.values()) { if (b.client) b.client.stop(); b.client = null; b.forget(); } bots.clear(); }

// tests point the bridge at a local fake homeserver
const _test = { allowLocal(on) { allowLocal = !!on; }, setResolver(fn) { resolver = fn; }, resetResolver() { resolver = (host, cb) => dns.lookup(host, { all: true }, cb); }, client: (key = 0) => botOf(key).client, forget: () => botOf(0).forget(), bots };

module.exports = {
  P, configured, botId, homeserver, settingsView, saveSettings, serverView, saveServer, botFor, hasOwn, rooms, roomOf, outbound, editOut, deleteOut, init, shutdown,
  cleanHomeserver, cleanToken, discover, whoami, api, media, MXC, typingIn, typingOut, textIn, textOut, splitReply, onRoomEvent, onSync, safeLookup, _test,
};
