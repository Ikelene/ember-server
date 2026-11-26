'use strict';
// The `federation` block of config.json: limits per remote homeserver, the lowest cooldown a server may set, the shared
// deny lists to follow and this homeserver's own deny entries. Pure functions; config.js stores the block.
const { err } = require('../util');
const R = require('./rules');

const DEFAULT_DENYLIST = 'https://nookara.cc/.well-known/ember/denylist';
const RATE_DEFAULTS = {
  exchanges_per_minute: 30, // sign-ins (token exchanges) from one homeserver
  joins_per_hour: 60,       // joins and join requests
  messages_per_minute: 300,
  reports_per_hour: 30,
  new_days: 30,             // a homeserver first seen less than this long ago ...
  new_divisor: 4,           // ... gets the limits above divided by this
  hold_after: 5,            // this many refused actions within ten minutes ...
  hold_minutes: 60,         // ... put the homeserver on hold for this long
};
const RATE_RANGE = { exchanges_per_minute: [1, 100000], joins_per_hour: [1, 1000000], messages_per_minute: [1, 1000000], reports_per_hour: [1, 100000], new_days: [0, 3650], new_divisor: [1, 1000], hold_after: [1, 100000], hold_minutes: [1, 10080] };
const defaults = () => ({ rate_limits: { ...RATE_DEFAULTS }, min_age_floor_days: 0, denylists: [DEFAULT_DENYLIST], deny: [], dev_origins: {} });

function listUrl(raw, allowHttp) {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  let u; try { u = new URL(raw.trim()); } catch { return null; }
  if (u.username || u.password || u.hash) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowHttp)) return null;
  return u.href;
}

// validate a (partial) block. loose = drop what is wrong quietly (hand-edited file)
function sanitize(p, { loose = false, allowHttp = false } = {}) {
  const out = {};
  const bad = (code, extra) => { if (!loose) throw err(code, 400, extra); };
  if (!p || typeof p !== 'object' || Array.isArray(p)) { bad('invalid_federation'); return out; }
  if (p.rate_limits !== undefined) {
    const v = p.rate_limits, r = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, [min, max]] of Object.entries(RATE_RANGE)) {
        if (v[k] === undefined) continue;
        if (Number.isInteger(v[k]) && v[k] >= min && v[k] <= max) r[k] = v[k]; else bad('invalid_rate_limits', { field: k });
      }
      out.rate_limits = r;
    } else bad('invalid_rate_limits');
  }
  if (p.min_age_floor_days !== undefined) { if (Number.isInteger(p.min_age_floor_days) && p.min_age_floor_days >= 0 && p.min_age_floor_days <= 365) out.min_age_floor_days = p.min_age_floor_days; else bad('invalid_min_age_floor_days'); }
  if (p.denylists !== undefined) {
    const list = Array.isArray(p.denylists) && p.denylists.length <= 20 ? p.denylists.map(x => listUrl(x, allowHttp || loose)) : null;
    if (list && list.every(Boolean)) out.denylists = [...new Set(list)]; else bad('invalid_denylists');
  }
  if (p.deny !== undefined) {
    const list = Array.isArray(p.deny) && p.deny.length <= 5000 ? p.deny.map(R.cleanDeny) : null;
    if (list && (loose || list.every(Boolean))) out.deny = [...new Set(list.filter(Boolean))]; else bad('invalid_deny');
  }
  if (p.dev_origins !== undefined) { // development only (EMBER_DEV=1): where a domain's homeserver really is, e.g. { "a.test": "http://localhost:4101" }
    const v = p.dev_origins, o = {};
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 50) {
      for (const [d, url] of Object.entries(v)) {
        let origin = null; try { const u = new URL(String(url)); if (/^https?:$/.test(u.protocol)) origin = u.origin; } catch { /* not a url */ }
        if (R.isDomain(d) && origin) o[d] = origin; else bad('invalid_dev_origins');
      }
      out.dev_origins = o;
    } else bad('invalid_dev_origins');
  }
  return out;
}
const complete = f => { const d = defaults(); return { ...d, ...(f || {}), rate_limits: { ...d.rate_limits, ...((f || {}).rate_limits || {}) } }; };
const merge = (cur, patch) => ({ ...cur, ...patch, ...(patch.rate_limits ? { rate_limits: { ...(cur.rate_limits || {}), ...patch.rate_limits } } : {}) });

module.exports = { DEFAULT_DENYLIST, RATE_DEFAULTS, defaults, sanitize, complete, merge };
