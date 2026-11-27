'use strict';
// Limits per remote homeserver (PROTOCOL §4b), on top of the limits each account has: sign-ins, joins, messages and reports
// are counted per remote domain. Over a limit: 429 homeserver_rate_limited { retry_after }.
//
// Holds. A homeserver that keeps running into its limits (hold_after refusals within ten minutes) is put on hold: everything
// counted here is refused until the hold ends. Holds are for homeservers this one has nothing to do with yet, so ordinary
// traffic between homeservers that know each other never stops it:
//   - a known peer is never held, and never gets the new-homeserver fraction of the limits. Known: an account here is friends
//     with an account there, or an account there has been a member of a server here for a day (it is still limited per minute / hour);
//   - holds escalate: 5 minutes the first time, then 15, then hold_minutes (60 by default); a day without one starts over;
//   - admins see each hold with what was refused (GET /api/v2/homeserver/federation `held`) and lift it
//     (DELETE /api/v2/homeserver/federation/holds/:domain, or PATCH { release: [domain] }).
const config = require('../config');
const db = require('../db');
const { err, log } = require('../util');
const seen = require('./seen');

const WINDOWS = { exchanges: ['exchanges_per_minute', 60 * 1000], joins: ['joins_per_hour', 3600 * 1000], messages: ['messages_per_minute', 60 * 1000], reports: ['reports_per_hour', 3600 * 1000],
  s2s: ['s2s_per_minute', 60 * 1000], friend_requests: ['friend_requests_per_hour', 3600 * 1000], dms: ['dms_per_hour', 3600 * 1000] }; // (server-to-server: PROTOCOL §4c)
const OVERRUN_WINDOW = 10 * 60 * 1000;
const STEPS = [5, 15]; // minutes of the first holds; then hold_minutes
const LEVEL_RESET = 24 * 3600 * 1000;
const KNOWN_TTL = 60 * 1000;
const MEMBER_DAYS = 1; // (a member for a day at least: joining an open server just now does not make a homeserver known)
const hits = new Map();     // "domain|action" -> [timestamps]
const overruns = new Map(); // domain -> [{ t, action }] refused actions
const holds = new Map();    // domain -> { until, since, minutes, level, refused: { action: n } }
const levels = new Map();   // domain -> { level, at } (the last hold, for escalation)
const knownCache = new Map(); // domain -> { known, at }

const rules = () => config.get().federation.rate_limits;
// a homeserver accounts here deal with: a friend there, or a member of a server here from there
function known(domain, t = Date.now()) {
  const c = knownCache.get(domain);
  if (c && t - c.at < KNOWN_TTL) return c.known;
  let k = false;
  try {
    k = !!db.get("SELECT 1 FROM friends WHERE state = 'friend' AND peer LIKE ? LIMIT 1", '%@' + domain)
      || !!db.get("SELECT 1 FROM users u JOIN members m ON m.user_id = u.id WHERE u.kind = 'remote' AND u.domain = ? AND m.joined_at < ? LIMIT 1", domain, t - MEMBER_DAYS * 24 * 3600 * 1000);
  } catch { k = false; }
  knownCache.set(domain, { known: k, at: t });
  return k;
}
function limitFor(domain, action) {
  const r = rules(), base = r[WINDOWS[action][0]];
  return seen.ageDays(domain) < r.new_days && !known(domain) ? Math.max(1, Math.floor(base / r.new_divisor)) : base;
}
const refuse = retry => err('homeserver_rate_limited', 429, { retry_after: Math.max(1, Math.ceil(retry / 1000)) });
function holdMinutes(domain, t) {
  const last = levels.get(domain);
  const level = last && t - last.at < LEVEL_RESET ? last.level + 1 : 0;
  levels.set(domain, { level, at: t });
  return { level, minutes: Math.min(STEPS[level] ?? Infinity, rules().hold_minutes) };
}
// count one action of `domain`; throws 429 homeserver_rate_limited { retry_after (seconds) } when it is over its limit or on hold
function hit(domain, action, t = Date.now()) {
  const h = holds.get(domain);
  if (h) { if (h.until > t) throw refuse(h.until - t); holds.delete(domain); }
  const [, ms] = WINDOWS[action], key = `${domain}|${action}`;
  const list = (hits.get(key) || []).filter(x => t - x < ms);
  if (list.length < limitFor(domain, action)) { list.push(t); hits.set(key, list); return; }
  hits.set(key, list);
  const r = rules(), over = (overruns.get(domain) || []).filter(x => t - x.t < OVERRUN_WINDOW);
  over.push({ t, action }); overruns.set(domain, over);
  if (over.length >= r.hold_after && !known(domain, t)) {
    const { level, minutes } = holdMinutes(domain, t);
    const refused = {};
    for (const o of over) refused[o.action] = (refused[o.action] || 0) + 1;
    holds.set(domain, { until: t + minutes * 60 * 1000, since: t, minutes, level, refused });
    overruns.delete(domain);
    log(`[federation] ${domain} on hold for ${minutes} min: ${over.length} refused in ten minutes (${Object.entries(refused).map(([a, n]) => `${a} ${n}`).join(', ')})`);
    throw refuse(minutes * 60 * 1000);
  }
  throw refuse(ms - (t - list[0]));
}
// for admins: every hold that is on, with what was refused
const held = (t = Date.now()) => [...holds].filter(([, h]) => h.until > t).map(([domain, h]) => ({ domain, until: h.until, since: h.since, minutes: h.minutes, level: h.level, refused: h.refused }));
// for admins: homeservers refused something in the last ten minutes (not held), with how often
function throttled(t = Date.now()) {
  const out = [];
  for (const [domain, list] of overruns) {
    const recent = list.filter(x => t - x.t < OVERRUN_WINDOW);
    if (!recent.length) continue;
    const refused = {};
    for (const o of recent) refused[o.action] = (refused[o.action] || 0) + 1;
    out.push({ domain, refused, known: known(domain, t), last: recent[recent.length - 1].t });
  }
  return out;
}
const release = domain => { const was = holds.delete(domain); overruns.delete(domain); levels.delete(domain); return was; };
const reset = () => { hits.clear(); overruns.clear(); holds.clear(); levels.clear(); knownCache.clear(); };
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > 3600 * 1000) hits.delete(k); }, 600 * 1000).unref();

module.exports = { hit, held, throttled, release, reset, limitFor, known, _test: { forgetKnown: () => knownCache.clear() } };
