'use strict';
// Paid tiers (PROTOCOL §19): a server's owner buys one of the homeserver's tiers with Nookara credits. It goes through the
// same pay requests as the roles shop (§12.5, relay/shop.js): a request with ref `tier:<tier>:server:<sid>:<period start ms>`,
// the person approves it on Nookara, and the tier is set once the receipt checks out. Buying the tier a server already
// holds adds a period to the end; another tier starts now and replaces it. Only a homeserver registered with Nookara can sell.
const { ERR, relayPath } = require('./compat');
const db = require('./db');
const L = require('./limits');
const managed = require('./managed');
const { err } = require('./util');

const client = () => require('./relay/client');
const WEEK = 7 * 24 * 3600 * 1000;
const OPEN = "('creating','pending')";
let POLL_MS = 4000;

const available = () => !managed.active() && client().registered();
const payView = p => p && ({ id: p.pay_id, status: p.status === 'creating' ? 'pending' : p.status, approve_url: p.approve_url, amount: p.amount, tier: p.tier, expires_at: p.expires_at, ...(p.error ? { error: p.error } : {}) });
const row = id => db.get('SELECT * FROM tier_payments WHERE id = ?', Number(id));
const set = (id, f) => db.run(`UPDATE tier_payments SET ${Object.keys(f).map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(f), Date.now(), id);
const latest = cid => db.get('SELECT * FROM tier_payments WHERE community_id = ? ORDER BY id DESC LIMIT 1', cid);
const held = cid => db.get('SELECT * FROM server_tiers WHERE community_id = ?', cid);
function owned(sid, me) {
  const c = require('./communities').findCommunity(sid);
  if (Number(c.owner_id) !== Number(me.id)) throw err('owner_only', 403);
  return c;
}
const stateOf = c => { const t = L.activeTier(c.id); return { tier: t ? t.tier : null, until: t ? t.until : null }; };

// POST /api/v2/servers/:sid/tier { tier }
async function buy(sid, me, body = {}) {
  const c = owned(sid, me);
  if (!available()) throw err('tiers_unavailable', 409);
  const def = L.tiers().find(t => t.id === String(body?.tier || ''));
  if (!def) throw err('unknown_tier', 404);
  // credits are paid from a Nookara account: its own, or (any other account) the one it linked for payments (payments.js)
  const payer = require('./payments').payerOf(require('./auth').userById(me.id));
  if (!payer) throw require('./payments').requireLink();
  // one open request per server + tier + price: asking again hands back the same one
  let p = db.tx(() => {
    const cur = db.get(`SELECT * FROM tier_payments WHERE community_id = ? AND user_id = ? AND status IN ${OPEN} ORDER BY id DESC LIMIT 1`, c.id, me.id);
    if (cur && cur.tier === def.id && cur.amount === def.price_credits && cur.period_weeks === def.period_weeks && (!cur.expires_at || cur.expires_at > Date.now())) return cur;
    if (cur) set(cur.id, { status: 'expired' });
    const h = held(c.id), t = Date.now();
    const start = h && h.tier === def.id && h.until > t ? h.until : t; // the same tier again: the new period follows the one that is running
    const id = db.run("INSERT INTO tier_payments (community_id, user_id, tier, amount, period_weeks, ref, status, created_at, updated_at, payer_nookara_id) VALUES (?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)",
      c.id, me.id, def.id, def.price_credits, def.period_weeks, `tier:${def.id}:server:${c.sid}:${start}`, t, t, payer.nookara_id).lastInsertRowid;
    return row(id);
  });
  if (p.status === 'creating') {
    let out;
    try {
      out = await client().call('POST', relayPath('/pay-request'), { user_id: String(p.payer_nookara_id || payer.nookara_id), ...(payer.account ? { account: payer.account } : {}), amount: p.amount, reason: `${def.name} for ${c.name}, ${def.period_weeks} week${def.period_weeks === 1 ? '' : 's'}`.slice(0, 200), ref: p.ref });
    } catch (e) {
      if (!(e.code === ERR.unreachable || e.status === 429 || e.status >= 500)) set(p.id, { status: 'failed', error: e.code || 'payment_failed' });
      throw err(e.code === ERR.notRegistered || e.code === ERR.off ? 'tiers_unavailable' : e.code || 'payment_failed', e.status === 503 ? 409 : e.status || 502, e.extra);
    }
    if (typeof out?.id !== 'string' || typeof out.approve_url !== 'string') { set(p.id, { status: 'failed', error: ERR.badResponse }); throw err('payment_failed', 502); }
    set(p.id, { status: 'pending', pay_id: out.id, approve_url: out.approve_url, expires_at: Number(out.expires_at) || Date.now() + 30 * 60 * 1000 });
    p = row(p.id);
  }
  poll();
  return { status: 'pending', pay_request: payView(p), ...stateOf(c) };
}

// GET /api/v2/servers/:sid/tier: what the server holds, and the last pay request (asked about right now while it is open)
async function status(sid, me) {
  const c = owned(sid, me);
  let p = latest(c.id);
  if (p?.status === 'pending') { await check(p).catch(() => {}); p = row(p.id); }
  return { ...stateOf(c), status: p ? payView(p).status : 'none', pay_request: payView(p) || null, tiers_available: available() };
}

// a verified receipt: the tier is the server's until the end of the period
function grant(p, claims) {
  const c = db.get('SELECT * FROM communities WHERE id = ?', p.community_id);
  db.tx(() => {
    set(p.id, { status: 'paid', error: null, rcp: String(claims.rcp) });
    if (!c) return;
    const h = held(c.id), t = Date.now();
    const from = h && h.tier === p.tier && h.until > t ? h.until : t;
    db.run('INSERT INTO server_tiers (community_id, tier, until, receipt_jti, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(community_id) DO UPDATE SET tier = excluded.tier, until = excluded.until, receipt_jti = excluded.receipt_jti, updated_at = excluded.updated_at',
      c.id, p.tier, from + p.period_weeks * WEEK, String(claims.rcp), t);
  });
  if (!c) return;
  L.changed(c);
  require('./gateway').pushToUser(p.user_id, { type: 'chat_tier_update', server: c.sid, status: 'paid', ...stateOf(c) });
}

// ask Nookara about one open request and act on the answer
async function check(p) {
  if (!client().registered()) return;
  let out;
  try { out = await client().call('GET', relayPath(`/pay-request/${encodeURIComponent(p.pay_id)}`)); } catch (e) {
    if (e.status === 404) set(p.id, { status: 'failed', error: 'not_found' });
    return;
  }
  const fresh = row(p.id);
  if (!fresh || fresh.status !== 'pending') return;
  if (out.status === 'paid') {
    const user = require('./auth').userById(fresh.user_id);
    // the receipt names the Nookara account that paid: the one this request was made for (a linked one, or their own)
    const payerUser = fresh.payer_nookara_id ? { ...(user || {}), nookara_id: fresh.payer_nookara_id } : user;
    const used = rcp => !!db.get('SELECT 1 FROM tier_payments WHERE rcp = ?', rcp) || !!db.get('SELECT 1 FROM role_purchases WHERE rcp = ?', rcp);
    try { grant(fresh, await require('./relay/shop').verifyReceipt(out.receipt, fresh, payerUser || {}, used)); } catch (e) {
      if (e.code === ERR.unreachable) return; // the keys could not be fetched: next round
      set(fresh.id, { status: 'failed', error: e.code || 'receipt_invalid' });
      console.error(`[tiers] rejected a pay receipt for request ${fresh.pay_id}: ${e.code || e.message}`);
    }
  } else if (out.status === 'declined' || out.status === 'expired') {
    set(fresh.id, { status: out.status, error: out.error ? String(out.error).slice(0, 60) : null });
    const c = db.get('SELECT * FROM communities WHERE id = ?', fresh.community_id);
    if (c) require('./gateway').pushToUser(fresh.user_id, { type: 'chat_tier_update', server: c.sid, status: out.status, ...stateOf(c) });
  }
}

// background poller: runs only while requests are open
let timer = null, polling = false, running = false;
function poll() {
  if (timer || !running) return;
  timer = setTimeout(async () => {
    timer = null;
    if (polling) return poll();
    polling = true;
    let more = false;
    try {
      db.run("UPDATE tier_payments SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at < ?", Date.now(), Date.now() - 24 * 3600 * 1000);
      db.run("UPDATE tier_payments SET status = 'failed', error = 'not_sent', updated_at = ? WHERE status = 'creating' AND created_at < ?", Date.now(), Date.now() - 3600 * 1000);
      for (const p of db.all("SELECT * FROM tier_payments WHERE status = 'pending' ORDER BY id LIMIT 50")) await check(p);
      more = !!db.get("SELECT 1 FROM tier_payments WHERE status = 'pending' LIMIT 1");
    } catch (e) { if (!/closed|not open/i.test(e.message)) console.error('[tiers] pay poll', e.message); } finally { polling = false; }
    if (more) poll();
  }, POLL_MS);
  timer.unref?.();
}
function start() { running = true; client().events.on('registered', poll); poll(); }
function stop() { running = false; clearTimeout(timer); timer = null; }

function register(app) {
  app.post('/api/v2/servers/:sid/tier', req => buy(req.params.sid, req.user, req.body));
  app.get('/api/v2/servers/:sid/tier', req => status(req.params.sid, req.user));
}

module.exports = { available, buy, status, check, grant, start, stop, register, _setPollMs: ms => { POLL_MS = ms; } };
