'use strict';
// What one server says about accounts of other homeservers (PROTOCOL §4b), on top of the homeserver's own rule: the server
// setting join.remote_accounts (inherit / none / allowlist), the new-homeserver cooldown (join.remote_min_age_days, never
// under config federation.min_age_floor_days) and whether a moderator's invite skips the cooldown (join.remote_invite_bypass).
const config = require('../config');
const db = require('../db');
const { err } = require('../util');
const R = require('./rules');
const seen = require('./seen');
const limits = require('./limits');

const joinRules = c => require('../settings').raw(c).join;
// does this server let accounts of `domain` in? (asked by every membership check: communities.js Snap.isMember)
function serverAllows(c, domain) {
  const r = joinRules(c).remote_accounts || { mode: 'inherit', list: [] };
  if (r.mode === 'none') return false;
  if (r.mode === 'allowlist') return !!domain && R.domainMatches(r.list || [], domain);
  return true;
}
const minAgeDays = c => Math.max(Number(joinRules(c).remote_min_age_days) || 0, config.get().federation.min_age_floor_days || 0);
// an invite a moderator made (one who can still manage the server); the server's permanent code any member can hand out is not one
function moderatorInvite(snap, inv) {
  if (!inv || !inv.created_by) return false;
  const { P } = require('../perms');
  return snap.isMember(inv.created_by) && (snap.perms(inv.created_by) & (P.MANAGE_SERVER | P.KICK)) !== 0;
}
// a remote account about to join (or ask to join) `c`: 403 remote_not_allowed, 403 homeserver_too_new { days_left },
// 429 homeserver_rate_limited { retry_after }. Local accounts pass untouched.
function assertMayJoin(c, snap, me, inv = null) {
  if (me?.kind !== 'remote') return;
  const domain = me.domain;
  if (!serverAllows(c, domain)) throw err('remote_not_allowed', 403);
  const left = seen.daysLeft(domain, minAgeDays(c));
  if (left > 0 && !(joinRules(c).remote_invite_bypass !== false && moderatorInvite(snap, inv))) throw err('homeserver_too_new', 403, { days_left: left });
  limits.hit(domain, 'joins');
}
// how many members of each server are remote accounts (admin view)
const remoteMembers = () => db.get("SELECT COUNT(*) AS n FROM users WHERE kind = 'remote'").n;

module.exports = { serverAllows, minAgeDays, assertMayJoin, remoteMembers };
