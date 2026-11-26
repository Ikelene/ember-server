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
const UA = 'Bonfire-Bridge/1.0 (+https://github.com/Ikelene/ember-server)';
const ZW = String.fromCharCode(0x200b);
const V3 = '/_matrix/client/v3';
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
const enc = encodeURIComponent;
const origin = () => normalizeOrigin(config.publicUrl());

// ---------------------------------------------------------------- settings: homeserver + access token (write-only)
const homeserver = () => store.setting('matrix.homeserver') || cleanEnvHomeserver() || '';
const tokenOf = () => store.setting('matrix.token') || process.env.BONFIRE_MATRIX_TOKEN || '';
const tokenSource = () => (store.setting('matrix.token') ? 'settings' : process.env.BONFIRE_MATRIX_TOKEN ? 'env' : null);
const botId = () => store.setting('matrix.user_id') || null;
const configured = () => !!(homeserver() && tokenOf());
function cleanEnvHomeserver() { try { return process.env.BONFIRE_MATRIX_HOMESERVER ? cleanHomeserver(process.env.BONFIRE_MATRIX_HOMESERVER) : ''; } catch { return ''; } }

// development / tests: a homeserver on this machine or the LAN
let allowLocal = false;
const local = () => allowLocal || process.env.BONFIRE_DEV === '1';
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
async function api(method, route, body, { token = tokenOf(), base = homeserver(), timeout, signal, maxBytes } = {}) {
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
async function media(mxc, { thumb = false, size = 128, maxBytes = 4 << 20, token = tokenOf(), base = homeserver() } = {}) {
  const m = MXC.exec(String(mxc || ''));
  if (!m) throw new Error('bad_mxc');
  const tail = `/${thumb ? 'thumbnail' : 'download'}/${enc(m[1])}/${enc(m[2])}${thumb ? `?width=${size}&height=${size}&method=crop` : ''}`;
  let r = await request('GET', `${base}/_matrix/client/v1/media${tail}`, { token, maxBytes });
  if ([400, 404, 405].includes(r.status)) r = await request('GET', `${base}/_matrix/media/v3${tail}`, { token, maxBytes });
  if (r.status !== 200) throw Object.assign(new Error(`media ${r.status}`), { status: r.status });
  return r.body;
}

const mask = t => (t ? `${'*'.repeat(8)}${String(t).slice(-4)}` : null);
function settingsView() {
  const id = botId();
  return {
    configured: configured(), token: mask(tokenOf()), homeserver: homeserver() || null, source: tokenSource(),
    state: client ? client.state : 'off', error: client?.error || null, bot: id && configured() ? { id, username: id } : null,
  };
}
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
async function saveSettings(v) {
  if (!v || typeof v !== 'object') return;
  if (v.token === null) {
    for (const k of ['token', 'homeserver', 'user_id', 'since']) store.setSetting(`matrix.${k}`, null);
    restart();
    return;
  }
  const hsIn = typeof v.homeserver === 'string' && v.homeserver.trim() ? v.homeserver : null;
  if (v.homeserver != null && typeof v.homeserver !== 'string') throw err('invalid_homeserver', 400, { platform: P });
  if (v.token != null && typeof v.token !== 'string') throw err('invalid_token', 400, { platform: P });
  const tokIn = cleanToken(v.token);
  if (!hsIn && !tokIn) return; // nothing new
  const base = hsIn ? await discover(cleanHomeserver(hsIn)) : homeserver();
  const tok = tokIn || tokenOf();
  if (!base) throw err('invalid_homeserver', 400, { platform: P });
  if (!tok) throw err('invalid_token', 400, { platform: P });
  const id = await whoami(base, tok);
  if (id !== botId() || base !== homeserver()) store.setSetting('matrix.since', null); // another account / server: its own place in the stream
  store.setSetting('matrix.homeserver', base);
  store.setSetting('matrix.token', tok);
  store.setSetting('matrix.user_id', id);
  restart();
}

// ---------------------------------------------------------------- what the bot knows about rooms and people
const roomInfo = new Map(); // room id -> { at, v: { id, name, encrypted } }
const members = new Map(); // "<room>\n<user>" -> { at, name, avatar }
let roomList = null; // { at, v: [info] }
const forget = () => { roomInfo.clear(); members.clear(); roomList = null; };
const state = (roomId, type, key = '') => api('GET', `${V3}/rooms/${enc(roomId)}/state/${enc(type)}/${enc(key)}`).catch(e => { if (e.status === 404) return null; throw e; });
async function roomOf(roomId, fresh = false) {
  const hit = roomInfo.get(roomId);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
  const [name, alias, crypt] = await Promise.all([state(roomId, 'm.room.name'), state(roomId, 'm.room.canonical_alias'), state(roomId, 'm.room.encryption')]);
  const v = { id: roomId, name: clean(name?.name, 100) || clean(alias?.alias, 100) || roomId, encrypted: !!crypt };
  roomInfo.set(roomId, { at: Date.now(), v });
  if (roomInfo.size > 2000) roomInfo.delete(roomInfo.keys().next().value);
  return v;
}
// the rooms the bot is in (at most 300), by name. fresh: ask which rooms again (what is known about each room is kept for
// 10 minutes, and dropped sooner when /sync says its name or encryption changed)
async function rooms(fresh = false) {
  if (!fresh && roomList && Date.now() - roomList.at < 30e3) return roomList.v;
  const ids = ((await api('GET', `${V3}/joined_rooms`)).joined_rooms || []).filter(x => typeof x === 'string').slice(0, 300);
  const out = [];
  for (let i = 0; i < ids.length; i += 6) out.push(...(await Promise.all(ids.slice(i, i + 6).map(id => roomOf(id).catch(() => null)))).filter(Boolean));
  out.sort((a, b) => a.name.localeCompare(b.name));
  roomList = { at: Date.now(), v: out };
  return out;
}
const localpart = id => String(id || '').replace(/^@/, '').split(':')[0] || 'someone';
function noteMember(roomId, ev) {
  if (typeof ev.state_key !== 'string') return;
  members.set(`${roomId}\n${ev.state_key}`, { at: Date.now(), name: clean(ev.content?.displayname, 80) || null, avatar: MXC.test(ev.content?.avatar_url || '') ? ev.content.avatar_url : null });
  if (members.size > 20000) members.delete(members.keys().next().value);
}
async function memberOf(roomId, userId) {
  const k = `${roomId}\n${userId}`;
  const hit = members.get(k);
  if (hit && Date.now() - hit.at < 3600e3) return hit;
  const m = await state(roomId, 'm.room.member', userId).catch(() => null);
  noteMember(roomId, { state_key: userId, content: m || {} });
  return members.get(k);
}

// ---------------------------------------------------------------- files: pictures + attachments are re-hosted here
async function hostAvatar(mxc) {
  if (!MXC.test(mxc || '')) return null;
  const rel = `bridge/avatars/matrix_${crypto.createHash('sha256').update(mxc).digest('hex').slice(0, 24)}.png`;
  if (!fs.existsSync(path.join(uploads.root(), rel))) {
    try {
      const buf = await media(mxc, { thumb: true });
      const sn = uploads.sniff(buf);
      if (!sn || !['image', 'gif'].includes(sn.type)) return null;
      uploads.writeStored(rel, buf);
    } catch { return null; }
  }
  return `${origin()}/uploads/${rel}`;
}
async function hostFile(content, maxBytes) {
  if (!MXC.test(content?.url || '') || (Number(content.info?.size) || 0) > maxBytes) return null; // (an encrypted file has no `url`)
  try {
    const buf = await media(content.url, { maxBytes });
    const name = String(content.filename || content.body || 'file').replace(/[^\w.-]+/g, '_').slice(-80) || 'file';
    const up = uploads.storeUpload(buf, name, null);
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
  t = t.replace(/<@!?((?:[vlb]:)?\d{1,20})>/g, (_, p) => `@${db.get('SELECT username FROM users WHERE principal = ?', p)?.username || 'someone'}`);
  t = t.replace(/<#(c[0-9a-f]{10})>/g, (_, cid) => `#${db.get('SELECT name FROM channels WHERE cid = ?', cid)?.name || 'channel'}`);
  return t.replace(/<a?:(\w+):e[0-9a-f]{10}>/g, ':$1:');
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const html = s => esc(s).replace(/\n/g, '<br>');
const absUrl = u => (!u ? null : /^https?:/i.test(u) ? u : `${origin()}${u.startsWith('/') ? '' : '/'}${u}`);

// ---------------------------------------------------------------- Matrix -> here
const mapOf = (extId, inboundOnly = false) => db.get(`SELECT message_id, outbound FROM bridge_msgs WHERE ext_message_id = ? AND platform = ?${inboundOnly ? ' AND outbound = 0' : ''}`, String(extId), P);
function onRoomEvent(roomId, ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'm.room.member') return noteMember(roomId, ev);
  if (['m.room.name', 'm.room.canonical_alias', 'm.room.encryption'].includes(ev.type)) { roomInfo.delete(roomId); roomList = null; return; }
  if (ev.sender === botId()) return; // our own posts from here
  const key = `in:${P}:${roomId}`;
  if (ev.type === 'm.room.redaction') {
    const target = ev.redacts || ev.content?.redacts;
    if (!target) return;
    return B().enqueue(key, async () => {
      const m = mapOf(target, true);
      if (m) { db.run('DELETE FROM bridge_msgs WHERE message_id = ? AND platform = ?', m.message_id, P); M().deleteBridged(m.message_id); }
    });
  }
  if (ev.type === 'm.room.message' || ev.type === 'm.sticker') return B().enqueue(key, () => inbound(roomId, ev));
}
async function inbound(roomId, ev) {
  const link = B().linkByExt(P, roomId);
  if (!link || !link.enabled || !ev.event_id) return;
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
    const h = c.allow_uploads ? await hostFile(content, maxBytes) : null;
    const name = clean(content.filename || content.body, 120) || 'file';
    if (h) atts.push(h);
    // (a caption: `body` is text of its own when `filename` says what the file is called)
    if (kind !== 'm.sticker' && content.filename && content.body && content.body !== content.filename) body = textIn(content, replied ? (target ? 'real' : 'quote') : null);
    if (!h) body = [body, `[${name}]`].filter(Boolean).join('\n');
  } else body = textIn(content, replied ? (target ? 'real' : 'quote') : null);
  if (!body.trim() && !atts.length) return;
  const who = await memberOf(roomId, ev.sender);
  const msg = M().postBridged(ch, { platform: P, name: who?.name || localpart(ev.sender), avatar: await hostAvatar(who?.avatar), body, attachments: atts, replyTo: target ? target.message_id : null });
  db.run('INSERT OR IGNORE INTO bridge_msgs (message_id, platform, ext_message_id, ext_channel_id, outbound, created_at) VALUES (?, ?, ?, ?, 0, ?)', Number(msg.id), P, String(ev.event_id), String(roomId), now());
}

// ---------------------------------------------------------------- here -> Matrix (the bot says "<name>: <text>")
let txn = 0;
const send = (roomId, content) => api('PUT', `${V3}/rooms/${enc(roomId)}/send/m.room.message/${enc(`ember${Date.now()}_${++txn}`)}`, content);
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
  const sent = await send(link.ext_channel_id, { ...contentOf(name, text, quote), ...(relates ? { 'm.relates_to': relates } : {}) });
  if (sent?.event_id) db.run('INSERT OR IGNORE INTO bridge_msgs (message_id, platform, ext_message_id, ext_channel_id, outbound, created_at) VALUES (?, ?, ?, ?, 1, ?)', Number(msg.id), P, String(sent.event_id), link.ext_channel_id, now());
  typingOut(link, false);
}
async function editOut(link, ctx, msg) {
  const m = db.get('SELECT ext_message_id, outbound FROM bridge_msgs WHERE message_id = ? AND platform = ?', Number(msg.id), P);
  if (!m || !m.outbound) return;
  const { name, text } = composed(msg, ctx.c.id);
  if (!text.trim()) return;
  const fresh = contentOf(name, text);
  await send(link.ext_channel_id, { ...fresh, body: `* ${fresh.body}`, formatted_body: `* ${fresh.formatted_body}`, 'm.new_content': fresh, 'm.relates_to': { rel_type: 'm.replace', event_id: m.ext_message_id } });
}
// a delete here: the copy over there is redacted (someone else's message needs the bot to be a moderator in that room)
async function deleteOut(link, id) {
  const m = db.get('SELECT ext_message_id FROM bridge_msgs WHERE message_id = ? AND platform = ?', Number(id), P);
  if (!m) return;
  db.run('DELETE FROM bridge_msgs WHERE message_id = ? AND platform = ?', Number(id), P);
  await api('PUT', `${V3}/rooms/${enc(link.ext_channel_id)}/redact/${enc(m.ext_message_id)}/${enc(`ember${Date.now()}_${++txn}`)}`, {}).catch(() => {});
}

// ---------------------------------------------------------------- who is typing
// m.typing lists everyone typing in the room right now, and comes again when that changes
const typingNow = new Map(); // room id -> Set of user ids
async function typingIn(roomId, ids) {
  if (!B().linkByExt(P, roomId)) return;
  const now = new Set((Array.isArray(ids) ? ids : []).filter(x => typeof x === 'string' && x !== botId()).slice(0, 20));
  const was = typingNow.get(roomId) || new Set();
  if (now.size) typingNow.set(roomId, now); else typingNow.delete(roomId);
  for (const id of was) if (!now.has(id)) B().typingStop(P, roomId, id);
  for (const id of now) {
    if (was.has(id)) continue;
    const m = await memberOf(roomId, id).catch(() => null);
    if (typingNow.get(roomId)?.has(id)) B().typingStart(P, roomId, id, { platform: P, name: m?.name || localpart(id), avatar: await hostAvatar(m?.avatar) }, 30000);
  }
}
// the bot types in the room while someone types in the linked channel (8 s at a time), and stops when the message lands
const typedOut = new Map(); // room id -> when
function typingOut(link, on = true) {
  const room = link.ext_channel_id, t = Date.now(), last = typedOut.get(room) || 0;
  if (on ? t - last < 6000 : !last) return;
  if (on) typedOut.set(room, t); else typedOut.delete(room);
  if (typedOut.size > 5000) typedOut.delete(typedOut.keys().next().value);
  api('PUT', `${V3}/rooms/${enc(room)}/typing/${enc(botId())}`, on ? { typing: true, timeout: 8000 } : { typing: false }).catch(() => {});
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
  constructor() { this.state = 'stopped'; this.error = null; this.attempts = 0; this.stopped = true; this.ctl = null; }
  start() { this.stopped = false; this.state = 'connecting'; this.loop().catch(e => console.error('[bridge] matrix sync', e.message)); }
  async loop() {
    while (!this.stopped) {
      try {
        if (!botId()) store.setSetting('matrix.user_id', (await api('GET', `${V3}/account/whoami`)).user_id);
        const since = store.setting('matrix.since');
        this.ctl = new AbortController();
        // the first sync only finds our place in the stream (what was said before the bridge existed stays there)
        const q = new URLSearchParams({ timeout: since ? '30000' : '0', filter: since ? FILTER : FIRST_FILTER, ...(since ? { since } : {}) });
        const r = await api('GET', `${V3}/sync?${q}`, undefined, { timeout: 60000, signal: this.ctl.signal, maxBytes: 48 << 20 });
        if (this.stopped) return;
        if (this.state !== 'ready') log(`[bridge] matrix sync ready as ${botId()}`);
        this.state = 'ready'; this.error = null; this.attempts = 0;
        await onSync(r, !since);
        if (!this.stopped && typeof r.next_batch === 'string') store.setSetting('matrix.since', r.next_batch);
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
async function onSync(r, first) {
  for (const roomId of Object.keys(r?.rooms?.invite || {})) { // invited: join (an admin then picks the room in the bridge settings)
    await api('POST', `${V3}/rooms/${enc(roomId)}/join`, {}).then(() => { roomList = null; log(`[bridge] matrix joined ${roomId}`); }, e => log(`[bridge] matrix could not join ${roomId}: ${e.message}`));
  }
  for (const roomId of Object.keys(r?.rooms?.leave || {})) { roomInfo.delete(roomId); roomList = null; }
  for (const [roomId, room] of Object.entries(r?.rooms?.join || {})) {
    for (const ev of room?.state?.events || []) if (ev?.type === 'm.room.member') noteMember(roomId, ev);
    if (!first) for (const ev of room?.ephemeral?.events || []) if (ev?.type === 'm.typing') typingIn(roomId, ev.content?.user_ids).catch(e => console.error('[bridge] matrix typing', e.message));
    for (const ev of room?.timeline?.events || []) {
      if (first && !['m.room.member'].includes(ev?.type)) continue;
      try { onRoomEvent(roomId, ev); } catch (e) { console.error('[bridge] matrix event', e.message); }
    }
  }
}
let client = null;
function restart() {
  if (client) client.stop();
  client = null;
  forget();
  if (!configured()) return;
  client = new SyncClient();
  client.start();
}
function shutdown() { if (client) client.stop(); client = null; forget(); }

// tests point the bridge at a local fake homeserver
const _test = { allowLocal(on) { allowLocal = !!on; }, setResolver(fn) { resolver = fn; }, resetResolver() { resolver = (host, cb) => dns.lookup(host, { all: true }, cb); }, client: () => client, forget };

module.exports = {
  P, configured, botId, homeserver, settingsView, saveSettings, rooms, roomOf, outbound, editOut, deleteOut, init: restart, shutdown,
  cleanHomeserver, cleanToken, discover, whoami, api, media, MXC, typingIn, typingOut, textIn, textOut, splitReply, onRoomEvent, onSync, safeLookup, _test,
};
