'use strict';
// Limits per remote homeserver (PROTOCOL §4b), on top of the limits each account has: sign-ins, joins, messages and reports
// are counted per remote domain. A homeserver first seen less than `new_days` ago gets a fraction of them. A homeserver that
// keeps running into its limits is put on hold for an hour: everything counted here is refused until the hold ends.
const config = require('../config');
const { err } = require('../util');
const seen = require('./seen');

const WINDOWS = { exchanges: ['exchanges_per_minute', 60 * 1000], joins: ['joins_per_hour', 3600 * 1000], messages: ['messages_per_minute', 60 * 1000], reports: ['reports_per_hour', 3600 * 1000],
  s2s: ['s2s_per_minute', 60 * 1000], friend_requests: ['friend_requests_per_hour', 3600 * 1000], dms: ['dms_per_hour', 3600 * 1000] }; // (server-to-server: PROTOCOL §4c)
const OVERRUN_WINDOW = 10 * 60 * 1000;
const hits = new Map();     // "domain|action" -> [timestamps]
const overruns = new Map(); // domain -> [timestamps of refused actions]
const holds = new Map();    // domain -> until (ms)

const rules = () => config.get().federation.rate_limits;
function limitFor(domain, action) {
  const r = rules(), base = r[WINDOWS[action][0]];
  return seen.ageDays(domain) < r.new_days ? Math.max(1, Math.floor(base / r.new_divisor)) : base;
}
const refuse = retry => err('homeserver_rate_limited', 429, { retry_after: Math.max(1, Math.ceil(retry / 1000)) });
// count one action of `domain`; throws 429 homeserver_rate_limited { retry_after (seconds) } when it is over its limit or on hold
function hit(domain, action, t = Date.now()) {
  const until = holds.get(domain);
  if (until) { if (until > t) throw refuse(until - t); holds.delete(domain); }
  const [, ms] = WINDOWS[action], key = `${domain}|${action}`;
  const list = (hits.get(key) || []).filter(x => t - x < ms);
  if (list.length < limitFor(domain, action)) { list.push(t); hits.set(key, list); return; }
  hits.set(key, list);
  const r = rules(), over = (overruns.get(domain) || []).filter(x => t - x < OVERRUN_WINDOW);
  over.push(t); overruns.set(domain, over);
  if (over.length >= r.hold_after) { holds.set(domain, t + r.hold_minutes * 60 * 1000); overruns.delete(domain); throw refuse(r.hold_minutes * 60 * 1000); }
  throw refuse(ms - (t - list[0]));
}
const held = (t = Date.now()) => [...holds].filter(([, until]) => until > t).map(([domain, until]) => ({ domain, until }));
const release = domain => { holds.delete(domain); overruns.delete(domain); };
const reset = () => { hits.clear(); overruns.clear(); holds.clear(); };
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > 3600 * 1000) hits.delete(k); }, 600 * 1000).unref();

module.exports = { hit, held, release, reset, limitFor };
