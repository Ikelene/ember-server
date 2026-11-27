'use strict';
// Limits per server (PROTOCOL §19). What a server may have is, in order: the override a homeserver admin set for it
// (table server_limits), the tier it paid for while that lasts (server_tiers, tiers.js), the homeserver's defaults
// (config.json `limits.defaults`). A self-hosted homeserver's defaults limit nothing. null = unlimited.
// EMBER_MANAGED (managed.js) still works: its plan numbers are the defaults then, and nothing here can be changed.
const managed = require('./managed');
const { err } = require('./util');
const config = () => require('./config');
const db = () => require('./db');

const BRIDGES = ['discord', 'fluxer', 'matrix', 'cloudlink'];
// the numbers, and the most each may be set to
const NUM = { member_cap: 1e7, voice_minutes: 1e9, max_upload_mb: 500, storage_mb: 1e8, files_per_member: 1e6, upload_expiry_days: 3650, emojis: 1e5, sounds: 1e5, bots: 1e5 };
const KEYS = [...Object.keys(NUM), 'bridges', 'custom_voice_keys'];
const TIER_ID = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const MB = 1024 * 1024;

// a (partial) limits object. Unknown keys are dropped; loose = bad values are dropped too (a hand-edited file) instead of 400
function clean(o, loose = false) {
  const out = {};
  if (o == null) return out;
  if (typeof o !== 'object' || Array.isArray(o)) { if (loose) return out; throw err('invalid_limits', 400); }
  const bad = field => { if (!loose) throw err('invalid_limits', 400, { field }); };
  for (const k of Object.keys(NUM)) {
    if (o[k] === undefined) continue;
    if (o[k] === null) out[k] = null;
    else if (Number.isInteger(o[k]) && o[k] >= 0 && o[k] <= NUM[k]) out[k] = o[k];
    else bad(k);
  }
  if (o.bridges !== undefined) { // a list of platforms; true / null = all of them, false = none
    if (o.bridges === true || o.bridges === null) out.bridges = [...BRIDGES];
    else if (o.bridges === false) out.bridges = [];
    else if (Array.isArray(o.bridges) && o.bridges.every(b => BRIDGES.includes(b))) out.bridges = BRIDGES.filter(b => o.bridges.includes(b));
    else bad('bridges');
  }
  if (o.custom_voice_keys !== undefined) { if (typeof o.custom_voice_keys === 'boolean') out.custom_voice_keys = o.custom_voice_keys; else bad('custom_voice_keys'); }
  return out;
}
// the `limits` block of config.json / PATCH /api/v2/homeserver/limits: { defaults?, tiers? }
function sanitize(p, loose = false) {
  const out = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) { if (loose) return out; throw err('invalid_limits', 400); }
  if (p.defaults !== undefined) out.defaults = clean(p.defaults, loose);
  if (p.tiers !== undefined) {
    const bad = (field, tier) => err('invalid_tiers', 400, { field, ...(tier ? { tier } : {}) });
    const list = [];
    if (!Array.isArray(p.tiers) || p.tiers.length > 20) { if (!loose) throw bad('tiers'); }
    else for (const t of p.tiers) {
      try {
        if (!t || typeof t !== 'object') throw bad('tiers');
        if (typeof t.id !== 'string' || !TIER_ID.test(t.id) || list.some(x => x.id === t.id)) throw bad('id');
        const name = typeof t.name === 'string' ? t.name.trim() : '';
        if (!name || name.length > 40) throw bad('name', t.id);
        if (!Number.isInteger(t.price_credits) || t.price_credits < 1 || t.price_credits > 100000) throw bad('price_credits', t.id);
        if (!Number.isInteger(t.period_weeks) || t.period_weeks < 1 || t.period_weeks > 52) throw bad('period_weeks', t.id);
        list.push({ id: t.id, name, limits: clean(t.limits, loose), price_credits: t.price_credits, period_weeks: t.period_weeks });
      } catch (e) { if (!loose) throw e; }
    }
    out.tiers = list;
  }
  return out;
}

// ---------- what applies ----------
// a self-hosted homeserver with nothing configured: no limits (uploads keep the instance's own max_upload_mb)
const builtin = () => ({
  member_cap: null, voice_minutes: null, max_upload_mb: config().get().max_upload_mb, storage_mb: null, files_per_member: null, upload_expiry_days: null,
  emojis: null, sounds: null, bots: null, bridges: [...BRIDGES], custom_voice_keys: true,
});
function defaults() {
  const b = builtin();
  if (managed.active()) { // the old hosted containers: the plan is the defaults
    const { bridges, ...m } = managed.limits();
    return { ...b, ...m, bridges: bridges ? [...BRIDGES] : [] };
  }
  return { ...b, ...clean(config().get().limits.defaults, true) };
}
const tiers = () => (managed.active() ? [] : config().get().limits.tiers);
const tierPublic = t => ({ id: t.id, name: t.name, price_credits: t.price_credits, period_weeks: t.period_weeks });
// the tier a server holds right now (its row + definition), or null: run out, or the tier is no longer offered
function activeTier(cid) {
  if (cid == null || managed.active()) return null;
  const r = db().get('SELECT * FROM server_tiers WHERE community_id = ?', Number(cid));
  if (!r || r.until <= Date.now()) return null;
  const def = tiers().find(t => t.id === r.tier);
  return def ? { ...r, def } : null;
}
function overrideRow(cid) {
  if (cid == null || managed.active()) return null;
  const r = db().get('SELECT * FROM server_limits WHERE community_id = ?', Number(cid));
  if (!r) return null;
  let o = {}; try { o = clean(JSON.parse(r.overrides), true); } catch { o = {}; }
  return { ...r, overrides: o };
}
function effective(cid = null) {
  const d = defaults();
  if (cid == null || managed.active()) return d;
  return { ...d, ...(activeTier(cid)?.def.limits || {}), ...(overrideRow(cid)?.overrides || {}) };
}
// where a server's value for one limit comes from: 'override' | 'tier' | 'defaults' (configured, or the managed plan) | 'builtin' (nothing set)
function source(what, cid = null) {
  if (managed.active()) return 'defaults';
  if (cid != null && what in (overrideRow(cid)?.overrides || {})) return 'override';
  if (cid != null && what in (activeTier(cid)?.def.limits || {})) return 'tier';
  return what in clean(config().get().limits.defaults, true) ? 'defaults' : 'builtin';
}
// a number (emojis / sounds / bots / member_cap / max_upload_mb / files_per_member / upload_expiry_days / storage_mb / voice_minutes), or null (none)
const limit = (what, cid = null) => effective(cid)[what] ?? null;
const allows = (what, cid = null) => effective(cid)[what] !== false;
const allowsBridge = (platform, cid = null) => effective(cid).bridges.includes(platform);
// the name errors carry as `plan`: the managed plan, else the server's tier
const planName = cid => (managed.active() ? managed.plan() : activeTier(cid)?.tier);
const named = cid => { const p = planName(cid); return p ? { plan: p } : {}; };

// ---------- refusals (the codes clients already know) ----------
const planLimit = (what, lim, used = null, cid = null) => err('plan_limit', 403, { what, limit: lim, used, ...named(cid) });
const planFeature = (what, cid = null, extra = {}) => err('plan_feature', 403, { what, limit: 0, ...extra, ...named(cid), message: 'This plan does not include ' + what.replace(/_/g, ' ') + '.' });
// throws when `count` already reached the limit (one more would exceed it)
function assertRoom(what, count, cid = null) {
  const lim = limit(what, cid);
  if (lim === 0) throw planFeature(what, cid);
  if (lim !== null && count >= lim) throw planLimit(what, lim, count, cid);
}
function assertBridge(platform, cid = null) { if (!allowsBridge(platform, cid)) throw planFeature('bridges', cid); }
// joining past the member cap: the owner and instance admins are never blocked; bots do not count (the caller passes the human count)
function assertCanJoin(cid, humanCount, free) {
  const cap = limit('member_cap', cid);
  if (cap === null || free) return;
  if (cap === 0) throw planFeature('member_cap', cid);
  if (humanCount >= cap) throw err('member_cap_reached', 403, { cap, what: 'member_cap', limit: cap, used: humanCount, ...named(cid) });
}

// ---------- usage ----------
const storageUsed = cid => db().get('SELECT COALESCE(SUM(size), 0) AS n FROM uploads WHERE community_id = ?', Number(cid)).n;
function usage(cid) {
  const d = db(), count = table => d.get(`SELECT COUNT(*) AS n FROM ${table} WHERE community_id = ?`, cid).n;
  return {
    member_cap: d.get("SELECT COUNT(*) AS n FROM members m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND u.kind <> 'bot'", cid).n,
    emojis: count('emojis'), sounds: count('sounds'), bots: managed.botCount(cid), storage_mb: Math.ceil(storageUsed(cid) / MB),
    voice_minutes: require('./voice-meter').usedMinutes(cid), // this calendar month (UTC)
  };
}
// what a server's members read: GET /api/v1/servers/:sid/limits, and `limits` in the server settings
function view(c) {
  const t = activeTier(c.id), o = overrideRow(c.id);
  return {
    limits: effective(c.id), usage: usage(c.id), tier: t ? t.tier : null, until: t ? t.until : null, overridden: !!o && Object.keys(o.overrides).length > 0,
    tiers: tiers().map(x => ({ ...tierPublic(x), limits: x.limits })), tiers_available: require('./tiers').available(),
  };
}

// ---------- homeserver admins ----------
const mayChange = () => { if (managed.active()) throw err('managed_setting', 403, { setting: 'limits' }); };
const adminView = () => ({ defaults: defaults(), saved_defaults: managed.active() ? {} : clean(config().get().limits.defaults, true), tiers: tiers(), managed: managed.active(), tiers_available: require('./tiers').available() });
function adminPatch(body) {
  mayChange();
  const p = sanitize({ ...(body?.defaults !== undefined ? { defaults: body.defaults } : {}), ...(body?.tiers !== undefined ? { tiers: body.tiers } : {}) });
  if (Object.keys(p).length) { config().update({ limits: p }); changed(); }
  return adminView();
}
function serverView(c) {
  const o = overrideRow(c.id);
  return { sid: c.sid, overrides: o?.overrides || {}, note: o?.note || '', updated_by: o?.updated_by || null, updated_at: o?.updated_at || null, ...view(c) };
}
// PATCH { overrides: { ...partial } | null, note? }: the whole override object is replaced; null or {} removes it
function serverPatch(c, me, body) {
  mayChange();
  const cur = overrideRow(c.id);
  const o = body?.overrides === undefined ? cur?.overrides || {} : clean(body.overrides);
  const note = body?.note === undefined ? cur?.note || '' : typeof body.note === 'string' && body.note.length <= 300 ? body.note.trim() : (() => { throw err('invalid_note', 400); })();
  if (!Object.keys(o).length && !note) db().run('DELETE FROM server_limits WHERE community_id = ?', c.id);
  else db().run('INSERT INTO server_limits (community_id, overrides, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(community_id) DO UPDATE SET overrides = excluded.overrides, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
    c.id, JSON.stringify(o), note, me.principal, Date.now());
  changed(c);
  return serverView(c);
}
// tell the people in a server (or in every server) that its limits changed
function changed(c = null) {
  const gateway = require('./gateway');
  for (const x of c ? [c] : db().all("SELECT * FROM communities WHERE kind = 'server'")) {
    const t = activeTier(x.id);
    gateway.emit(x.id, { type: 'chat_server_limits', server: x.sid, limits: effective(x.id), tier: t ? t.tier : null, until: t ? t.until : null });
  }
}

// GET /api/v2/homeserver/servers?before=<sid>&limit= : every server here, newest first
function serverList(q = {}) {
  const auth = require('./auth'), d = db();
  const n = Math.min(Math.max(Number.parseInt(q.limit, 10) || 50, 1), 200);
  const before = q.before ? d.get('SELECT id FROM communities WHERE sid = ?', String(q.before))?.id ?? 0 : null;
  const rows = before === null ? d.all("SELECT * FROM communities WHERE kind = 'server' ORDER BY id DESC LIMIT ?", n + 1) : d.all("SELECT * FROM communities WHERE kind = 'server' AND id < ? ORDER BY id DESC LIMIT ?", before, n + 1);
  const servers = rows.slice(0, n).map(c => {
    const o = auth.userById(c.owner_id), ov = overrideRow(c.id);
    return {
      sid: c.sid, slug: c.slug, address: `${c.slug}@${config().domain()}`, name: c.name, icon_url: c.icon_url || null, owner: o ? { id: o.principal, username: o.username } : null,
      member_count: d.get('SELECT COUNT(*) AS n FROM members WHERE community_id = ?', c.id).n, listed: !!c.listed, created_at: c.created_at,
      limits_override: !!ov && Object.keys(ov.overrides).length > 0, tier: activeTier(c.id)?.tier || null,
    };
  });
  return { servers, has_more: rows.length > n };
}

function register(app) {
  const C = require('./communities');
  app.get('/api/v1/servers/:sid/limits', req => view(C.memberCommunity(req.params.sid, req.user).c));
  app.get('/api/v2/homeserver/limits', { admin: true }, () => adminView());
  app.patch('/api/v2/homeserver/limits', { admin: true }, req => adminPatch(req.body));
  app.get('/api/v2/homeserver/servers', { admin: true }, req => serverList(req.query));
  app.get('/api/v2/homeserver/servers/:sid/limits', { admin: true }, req => serverView(C.findCommunity(req.params.sid)));
  app.patch('/api/v2/homeserver/servers/:sid/limits', { admin: true }, req => serverPatch(C.findCommunity(req.params.sid), req.user, req.body));
}
// discovery: `limits: { defaults, tiers: [ { id, name, price_credits, period_weeks } ] }`
const discovery = () => ({ limits: { defaults: defaults(), tiers: tiers().map(tierPublic) } });

module.exports = {
  BRIDGES, KEYS, clean, sanitize, defaults, tiers, tierPublic, activeTier, overrideRow, effective, source, limit, allows, allowsBridge, planName, planLimit, planFeature,
  assertRoom, assertBridge, assertCanJoin, storageUsed, usage, view, adminView, adminPatch, serverView, serverPatch, changed, register, discovery,
};
