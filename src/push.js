'use strict';
// Push through a push gateway (PROTOCOL §20). A client registers a pusher: the key its push provider gave it and the gateway
// that can reach that provider (Nookara's by default). Whenever someone who is not connected is pinged (notify.js: mentions,
// replies, @everyone, "all messages"), every pusher of theirs gets a notification:
//   POST <gateway> (signed like an s2s request plus a line "purpose: push", §20) { notification: { pushkey, app_id, kind, title, preview?, url?, homeserver, counts: { unread } } } -> { rejected: [pushkey] }
// It works for every kind of account (local, Nookara, another homeserver's). Nothing here ever waits in the message path:
// sends are queued per gateway, give up after 5 s, and a gateway's `rejected` keys are forgotten.
const db = require('./db');
const config = require('./config');
const gateway = require('./gateway');
const notify = require('./notify');
const safe = require('./safe-http');
const { err, now } = require('./util');

const MAX_PER_USER = 20, TIMEOUT = 5000, MAX_QUEUED = 500;
const DEFAULT_GATEWAY = 'https://nookara.cc/_ember/push/v1/notify';
let WINDOW = 30 * 1000;
const defaultGateway = () => config.get().push.default_gateway || DEFAULT_GATEWAY;
const trim = (s, n) => { const a = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };

// https, no credentials, no fragment (http only in development)
function cleanGateway(v) {
  if (v === undefined || v === null || v === '') return defaultGateway();
  let u; try { u = new URL(String(v)); } catch { throw err('invalid_gateway_url'); }
  if (String(v).length > 500 || u.username || u.password || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && safe.local()))) throw err('invalid_gateway_url');
  return u.href;
}
const view = p => ({ pushkey: p.pushkey, app_id: p.app_id, gateway_url: p.gateway_url, device_name: p.device_name || null, show_preview: !!p.show_preview, created_at: p.created_at, last_ok_at: p.last_ok_at || null });
const list = me => ({ pushers: db.all('SELECT * FROM pushers WHERE user_id = ? ORDER BY created_at, pushkey', me.id).map(view) });

// POST /api/v2/pushers { app_id, pushkey, gateway_url?, device_name?, show_preview? }: registering the same key again updates it
function add(me, body = {}) {
  if (me.kind === 'bot') throw err('not_allowed', 403);
  const str = (v, n, code, re) => { if (typeof v !== 'string' || !v.trim() || v.length > n || (re && !re.test(v))) throw err(code); return v.trim(); };
  const pushkey = str(body.pushkey, 512, 'invalid_pushkey', /^[\x21-\x7e]+$/);
  const appId = str(body.app_id, 64, 'invalid_app_id', /^[A-Za-z0-9._-]+$/);
  const url = cleanGateway(body.gateway_url);
  const device = body.device_name == null ? null : trim(str(body.device_name, 200, 'invalid_device_name'), 80);
  if (body.show_preview !== undefined && typeof body.show_preview !== 'boolean') throw err('invalid_show_preview');
  const had = db.get('SELECT * FROM pushers WHERE user_id = ? AND pushkey = ?', me.id, pushkey);
  if (!had && db.get('SELECT COUNT(*) AS n FROM pushers WHERE user_id = ?', me.id).n >= MAX_PER_USER) throw err('too_many_pushers', 409, { limit: MAX_PER_USER });
  const preview = body.show_preview === undefined ? (had ? had.show_preview : 1) : body.show_preview ? 1 : 0;
  // a key belongs to one account on this homeserver: whoever registers it last (a phone someone else signed in on)
  db.run('DELETE FROM pushers WHERE pushkey = ? AND user_id <> ?', pushkey, me.id);
  db.run(`INSERT INTO pushers (user_id, pushkey, app_id, gateway_url, device_name, show_preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, pushkey) DO UPDATE SET app_id = excluded.app_id, gateway_url = excluded.gateway_url, device_name = excluded.device_name, show_preview = excluded.show_preview`,
  me.id, pushkey, appId, url, device, preview, now());
  return { pusher: view(db.get('SELECT * FROM pushers WHERE user_id = ? AND pushkey = ?', me.id, pushkey)) };
}
function remove(me, pushkey) {
  if (!db.run('DELETE FROM pushers WHERE user_id = ? AND pushkey = ?', me.id, String(pushkey)).changes) throw err('pusher_not_found', 404);
  return list(me);
}

// ---------- sending ----------
// channels with something unread, for the badge
const unread = userId => db.get(`SELECT COUNT(*) AS n FROM channels ch JOIN members m ON m.community_id = ch.community_id AND m.user_id = ?
  LEFT JOIN read_state r ON r.user_id = m.user_id AND r.channel_id = ch.id WHERE ch.last_message_id > COALESCE(r.last_read_id, 0)`, userId).n
  + db.get('SELECT COUNT(*) AS n FROM dm_pointers WHERE user_id = ? AND unread > 0', userId).n; // and DMs hosted elsewhere (§4c)
function notification(u, payload, count) {
  if (payload.dm) return dmNotification(u, payload, count);
  const m = db.get('SELECT r.user_id AS ru FROM messages m LEFT JOIN messages r ON r.id = m.reply_to WHERE m.id = ?', Number(payload.id));
  const kind = m?.ru === u.id ? 'reply' : 'mention', from = payload.from || 'Someone';
  const title = count > 1 ? `${count} new mentions in #${payload.channel}` : kind === 'reply' ? `${from} replied to you` : `${from} mentioned you`;
  const base = config.publicUrl();
  return {
    kind, title: trim(title, 100), preview: trim(count > 1 ? `${from}: ${payload.body}` : payload.body, 300),
    ...(base.startsWith('https://') ? { url: `${base}/#/s/${payload.sid}/${payload.cid}` } : {}),
    homeserver: config.domain(), counts: { unread: unread(u.id) },
  };
}

// a message in a DM (hosted here: notify.js; hosted elsewhere: dm_activity, social/dms.js)
function dmNotification(u, payload, count) {
  const from = payload.from || 'Someone', where = payload.group ? payload.server || 'a group' : null, base = config.publicUrl();
  const title = count > 1 ? `${count} new messages ${where ? 'in ' + where : 'from ' + from}` : where ? `${from} in ${where}` : from;
  return {
    kind: 'dm', title: trim(title, 100), preview: trim(count > 1 && where ? `${from}: ${payload.body}` : payload.body, 300),
    ...(base.startsWith('https://') ? { url: `${base}/#/dm/${encodeURIComponent(payload.dm)}` } : {}),
    homeserver: config.domain(), counts: { unread: unread(u.id) },
  };
}
// dm_activity: new messages in a DM hosted on another homeserver. { id, from, name, group, body }
const dm = (userId, d) => onOffline([userId], { dm: d.id, cid: 'dm:' + d.id, from: d.from, server: d.name, group: !!d.group, body: d.body });

const queues = new Map(); // gateway url -> { chain, waiting }
function post(url, body) {
  const q = queues.get(url) || { chain: Promise.resolve(), waiting: 0 };
  if (q.waiting >= MAX_QUEUED) return; // a gateway that is far behind: these are dropped
  q.waiting++;
  queues.set(url, q);
  q.chain = q.chain.then(async () => {
    try {
      // signed the way server-to-server requests are (§4c.1), with a sixth line "purpose: push" (§20): the gateway checks it
      // against our JWKS, and a gateway (any address a client names) cannot pass the signature off as an s2s request of ours
      const payload = JSON.stringify(body), headers = { ...require('./social/s2s').sign({ method: 'POST', url, body: payload, purpose: 'push' }), 'Content-Type': 'application/json' };
      const r = await safe.request('POST', url, { headers, body: payload, timeout: TIMEOUT, maxBytes: 64 * 1024 });
      const key = body.notification.pushkey;
      if (r.status < 200 || r.status >= 300) return;
      const rejected = r.json()?.rejected;
      if (Array.isArray(rejected) && rejected.includes(key)) db.run('DELETE FROM pushers WHERE pushkey = ? AND gateway_url = ?', key, url);
      else db.run('UPDATE pushers SET last_ok_at = ? WHERE pushkey = ? AND gateway_url = ?', now(), key, url);
    } catch (e) { if (!/closed|not open/i.test(e.message) && e.code !== 'EPRIVATE') log(url, e); }
    finally { q.waiting--; if (!q.waiting && queues.get(url) === q) queues.delete(url); }
  });
}
const logged = new Map(); // gateway url -> when (one line a minute per gateway)
function log(url, e) { const t = now(); if (t - (logged.get(url) || 0) < 60000) return; logged.set(url, t); if (logged.size > 200) logged.clear(); console.error(`[push] ${new URL(url).host}: ${e.message}`); }

function send(u, payload, count) {
  if (gateway.isOnline(u.id)) return;
  const rows = db.all('SELECT * FROM pushers WHERE user_id = ?', u.id);
  if (!rows.length) return;
  const { preview, ...n } = notification(u, payload, count);
  for (const p of rows) post(p.gateway_url, { notification: { pushkey: p.pushkey, app_id: p.app_id, ...n, ...(p.show_preview && preview ? { preview } : {}) } });
}
// notify.js: these people were pinged while not connected. Quiet the way the relay push is: nobody who is connected, and per
// person + channel the first ping goes at once while the ones in the next 30 s become one summary.
const slots = new Map(); // `${userId}:${cid}` -> { until, count, last, timer }
function onOffline(userIds, payload) {
  if (!payload?.cid) return;
  const t = now();
  for (const id of userIds) {
    if (!db.get('SELECT 1 FROM pushers WHERE user_id = ? LIMIT 1', Number(id)) || gateway.isOnline(id)) continue;
    const u = { id: Number(id) }, k = `${u.id}:${payload.cid}`, s = slots.get(k);
    if (s && s.until > t) { s.count++; s.last = payload; continue; }
    const slot = { until: t + WINDOW, count: 0, last: payload, timer: null };
    slot.timer = setTimeout(() => { if (slots.get(k) === slot) slots.delete(k); if (slot.count) { try { send(u, slot.last, slot.count); } catch { /* shutting down */ } } }, WINDOW);
    slot.timer.unref?.();
    slots.set(k, slot);
    send(u, payload, 1);
  }
}

let off = null;
function start() { stop(); off = notify.onOffline(onOffline); }
function stop() { if (off) off(); off = null; for (const s of slots.values()) clearTimeout(s.timer); slots.clear(); }
const idle = () => Promise.all([...queues.values()].map(q => q.chain)); // tests

function register(app) {
  app.get('/api/v2/pushers', req => list(req.user));
  app.post('/api/v2/pushers', req => add(req.user, req.body));
  app.delete('/api/v2/pushers/:pushkey', req => remove(req.user, req.params.pushkey));
}
// discovery: `push: { pushers_url }`
const discovery = () => ({ push: { pushers_url: `${config.publicUrl()}/api/v2/pushers` } });

module.exports = { start, stop, register, discovery, add, remove, list, onOffline, dm, idle, DEFAULT_GATEWAY, _setWindow: ms => { WINDOW = ms; } };
