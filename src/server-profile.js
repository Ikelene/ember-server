'use strict';
// Server profiles (PROTOCOL §6.7): a member's own picture, banner, name colour, bio and pronouns on this server only, shown here instead of
// the ones their account has everywhere else. Their display name here is their server nickname (members.nick). Setting one needs
// "Customize profile in this server" (P.CUSTOMIZE_PROFILE); Manage users can reset someone's (back to their global profile), and the
// person is told through Velora's notification inbox (§12.13) when they have a Velora account.
const db = require('./db');
const auth = require('./auth');
const { err } = require('./util');
const { P } = require('./perms');
const C = () => require('./communities');

const BIO_MAX = 300, PRONOUNS_MAX = 40;
const FIELDS = ['pfp', 'banner', 'color', 'bio', 'pronouns'];
const isHex = v => /^#[0-9a-f]{6}$/i.test(String(v || ''));

// what's stored ({ pfp, banner, color, bio, pronouns }, only the ones set) -> null when there's nothing
function parse(raw) {
  if (!raw) return null;
  let o; try { o = JSON.parse(raw); } catch { return null; }
  const out = {};
  for (const k of FIELDS) if (typeof o?.[k] === 'string' && o[k]) out[k] = o[k];
  return Object.keys(out).length ? out : null;
}
const read = (communityId, userId) => parse(db.get('SELECT profile FROM members WHERE community_id = ? AND user_id = ?', communityId, userId)?.profile);
function write(c, userId, profile) {
  const clean = parse(JSON.stringify(profile || {}));
  db.run('UPDATE members SET profile = ? WHERE community_id = ? AND user_id = ?', clean ? JSON.stringify(clean) : null, c.id, userId);
  C().memberChanged(c, userId, 'role'); // ('role' = "this member changed": every client updates the member in place)
  return clean;
}
const canCustomize = (snap, uid) => snap.can(uid, P.CUSTOMIZE_PROFILE);
// the stored file behind one of our picture links (uploads/chat/profile_*), to delete it when it's replaced or reset
function storedFile(url) {
  try { const p = new URL(String(url)).pathname; return /^\/uploads\/chat\/profile_(pfp|banner)_[0-9a-f]+\.\w+$/.test(p) ? p.slice('/uploads/'.length) : null; } catch { return null; }
}
const dropFiles = (...urls) => require('./uploads').removeFiles(urls.map(storedFile).filter(Boolean));

// GET /servers/:sid/members/@me/profile
function get(sid, me) {
  const { c, snap } = C().memberCommunity(sid, me);
  return { profile: read(c.id, me.id), nick: snap.nick(me.id), can_customize: canCustomize(snap, me.id) };
}

// PATCH /servers/:sid/members/@me/profile { bio?, pronouns?, color?, display_name? } (null / '' clears a field)
function update(sid, me, body = {}) {
  const { c, snap } = C().memberCommunity(sid, me);
  if (!canCustomize(snap, me.id)) throw err('not_allowed', 403);
  const p = { ...(read(c.id, me.id) || {}) };
  const str = (k, max) => {
    if (body[k] === undefined) return;
    if (body[k] !== null && typeof body[k] !== 'string') throw err(`invalid_${k}`);
    const v = String(body[k] || '').replace(/\r\n?/g, '\n').trim();
    if (v.length > max) throw err(`${k}_too_long`, 400, { max });
    if (v) p[k] = v; else delete p[k];
  };
  str('bio', BIO_MAX);
  str('pronouns', PRONOUNS_MAX);
  if (body.color !== undefined) {
    if (body.color && !isHex(body.color)) throw err('invalid_color');
    if (body.color) p.color = String(body.color).toLowerCase(); else delete p.color;
  }
  // the name here is the server nickname (Customize profile is enough to set your own)
  let nick = snap.nick(me.id);
  if (body.display_name !== undefined) nick = C().setNick(sid, me, '@me', body.display_name, { asProfile: true }).nick;
  return { profile: write(c, me.id, p), nick, can_customize: true };
}

// POST /servers/:sid/members/@me/profile/:kind (pfp | banner, multipart image) and DELETE (back to the global one for that field)
function setImage(sid, me, kind, buffer) {
  if (!['pfp', 'banner'].includes(kind)) throw err('not_found', 404);
  const { c, snap } = C().memberCommunity(sid, me);
  if (!canCustomize(snap, me.id)) throw err('not_allowed', 403);
  const p = { ...(read(c.id, me.id) || {}) };
  const old = p[kind];
  if (buffer) p[kind] = require('./uploads').saveImage(buffer, `profile_${kind}`); else delete p[kind];
  const out = { profile: write(c, me.id, p) };
  if (old && old !== p[kind]) dropFiles(old);
  return out;
}

// DELETE /servers/:sid/members/@me/profile: your own back to your global profile (picture, banner, colour, bio, pronouns and the
// server nickname). Allowed without Customize profile: anyone can go back to normal.
function clearOwn(sid, me) {
  const { c, snap } = C().memberCommunity(sid, me);
  // the nickname too, but only when you may change it yourself (a moderator's nickname for you stays)
  const mayNick = snap.can(me.id, P.CHANGE_NICKNAME) || snap.can(me.id, P.MANAGE_NICKNAMES) || canCustomize(snap, me.id);
  if (mayNick && snap.nick(me.id)) db.run('UPDATE members SET nick = NULL WHERE community_id = ? AND user_id = ?', c.id, me.id);
  const had = read(c.id, me.id);
  const out = { profile: write(c, me.id, null), nick: mayNick ? null : snap.nick(me.id) };
  if (had) dropFiles(had.pfp, had.banner);
  return out;
}

// POST /servers/:sid/members/:uid/profile/reset (Manage users, and above them): someone's server profile back to their global one
function reset(sid, me, targetPrincipal) {
  const { c, snap } = C().memberCommunity(sid, me);
  const t = C().userByPrincipalOrThrow(targetPrincipal);
  if (!snap.isMember(t.id)) throw err('not_a_member', 404);
  const self = Number(t.id) === Number(me.id);
  if (!self && (!snap.can(me.id, P.MANAGE_USERS) || snap.isOwner(t.id) || snap.top(t.id) >= snap.top(me.id))) throw err('not_allowed', 403);
  const prof = read(c.id, t.id), had = prof || snap.nick(t.id);
  if (snap.nick(t.id)) db.run('UPDATE members SET nick = NULL WHERE community_id = ? AND user_id = ?', c.id, t.id);
  write(c, t.id, null);
  if (prof) dropFiles(prof.pfp, prof.banner);
  // a moderator resetting one of this server's own accounts: its account profile goes too (there is no global one behind it)
  if (!self) require('./account-profile').reset(t);
  if (!self) {
    require('./audit').record(c, me, 'member_profile_reset', { target: { kind: 'user', id: t.principal, name: t.username } });
    if (had) tell(c, t);
  }
  return { ok: true };
}
// the notice in their Nookara inbox (a local account has no inbox to put it in)
function tell(c, t) {
  if (!t.velora_id) return;
  const client = require('./relay/client');
  if (!client.registered()) return;
  client.call('POST', '/bonfire/relay/notice', { user_id: String(t.velora_id), kind: 'profile_reset', community_name: String(c.name || '').slice(0, 80) })
    .catch(e => { if (e.status !== 429 && e.code !== 'velora_unreachable') console.error('[server profile] notice', e.code || e.message); });
}

module.exports = { parse, read, get, update, setImage, clearOwn, reset, dropFiles, BIO_MAX, PRONOUNS_MAX };
