'use strict';
// Account profiles (PROTOCOL §4.1): on a server with its own accounts, a local account's display name, picture, banner, name colour, bio
// and pronouns are kept here, on the server (a Nookara account's come from Nookara). A client that is also signed in to Nookara can copy
// that profile over and keep it in sync: the client does the copying, `sync` only remembers which Nookara account it follows and the
// stamp of the last copy, so every device of the account knows whether there is anything new to bring over.
const { NOOKARA_ID_FIELD } = require('./compat');
const db = require('./db');
const auth = require('./auth');
const { err, clean, now } = require('./util');
const SP = () => require('./server-profile');
const C = () => require('./communities');

const NAME_MAX = 32, BIO_MAX = 300, PRONOUNS_MAX = 40, STAMP_MAX = 128;
const FIELDS = ['banner', 'color', 'bio', 'pronouns'];
const isHex = v => /^#[0-9a-f]{6}$/i.test(String(v || ''));
const isNookaraId = v => /^[1-9]\d{0,19}$/.test(String(v ?? ''));

// what's stored in users.account_profile ({ banner, color, bio, pronouns, sync }, only the ones set); the name and picture are the
// account's own display_name / pfp columns, which every user object already carries
function stored(u) {
  let o = null; try { o = u?.account_profile ? JSON.parse(u.account_profile) : null; } catch { /* nothing */ }
  const out = {};
  for (const k of FIELDS) if (typeof o?.[k] === 'string' && o[k]) out[k] = o[k];
  if (o?.sync && isNookaraId(o.sync[NOOKARA_ID_FIELD])) out.sync = { [NOOKARA_ID_FIELD]: String(o.sync[NOOKARA_ID_FIELD]), stamp: typeof o.sync.stamp === 'string' ? o.sync.stamp.slice(0, STAMP_MAX) : '', at: Number(o.sync.at) || 0 };
  return out;
}
const mine = u => { if (!auth.profileHere(u)) throw err('local_accounts_only', 400); return auth.userById(u.id); };
// their look as the member object's `profile` carries it (§6.7 shape), null when they have set nothing
function look(u) {
  if (!auth.profileHere(u)) return null;
  const s = stored(u), out = {};
  if (u.pfp) out.pfp = u.pfp;
  for (const k of FIELDS) if (s[k]) out[k] = s[k];
  return Object.keys(out).length ? out : null;
}
function view(u) {
  const s = stored(u);
  return {
    profile: { display_name: u.display_name && u.display_name !== u.username ? u.display_name : null, pfp: u.pfp || null, banner: s.banner || null, color: s.color || null, bio: s.bio || null, pronouns: s.pronouns || null },
    sync: s.sync || null, user: auth.userView(u),
  };
}
// save + tell everyone: a new name / picture patches their messages too (chat_identity_update), the rest is a member change
function write(before, { display_name = before.display_name, pfp = before.pfp || null, data }) {
  const keep = {};
  for (const k of FIELDS) if (data[k]) keep[k] = data[k];
  if (data.sync) keep.sync = data.sync;
  db.run('UPDATE users SET display_name = ?, pfp = ?, account_profile = ?, profile_updated_at = ? WHERE id = ?', display_name, pfp, Object.keys(keep).length ? JSON.stringify(keep) : null, now(), before.id);
  const u = auth.userById(before.id);
  if (u.display_name !== before.display_name || (u.pfp || null) !== (before.pfp || null)) auth.identityChanged(u, before.username);
  for (const m of db.all('SELECT c.* FROM members m JOIN communities c ON c.id = m.community_id WHERE m.user_id = ?', u.id)) C().memberChanged(m, u.id, 'role');
  return view(u);
}

// GET /api/v1/me/profile
const get = me => view(mine(me));

// PATCH /api/v1/me/profile { display_name?, bio?, pronouns?, color?, sync? } (null / '' clears a field; display_name back to the username)
function update(me, body = {}) {
  const u = mine(me), data = stored(u);
  let name = u.display_name;
  if (body.display_name !== undefined) {
    if (body.display_name !== null && typeof body.display_name !== 'string') throw err('invalid_display_name');
    const v = clean(String(body.display_name || '').replace(/[\r\n\u2028\u2029]/g, ' ').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ''), NAME_MAX + 1);
    if (v.length > NAME_MAX) throw err('display_name_too_long', 400, { max: NAME_MAX });
    name = v || u.username;
  }
  const str = (k, max) => {
    if (body[k] === undefined) return;
    if (body[k] !== null && typeof body[k] !== 'string') throw err(`invalid_${k}`);
    const v = String(body[k] || '').replace(/\r\n?/g, '\n').trim();
    if (v.length > max) throw err(`${k}_too_long`, 400, { max });
    if (v) data[k] = v; else delete data[k];
  };
  str('bio', BIO_MAX);
  str('pronouns', PRONOUNS_MAX);
  if (body.color !== undefined) {
    if (body.color && !isHex(body.color)) throw err('invalid_color');
    if (body.color) data.color = String(body.color).toLowerCase(); else delete data.color;
  }
  // sync: null / false = off; { <NOOKARA_ID_FIELD>, stamp } = this profile follows that Nookara account, last copied at `stamp`
  if (body.sync !== undefined) {
    if (!body.sync) delete data.sync;
    else {
      if (typeof body.sync !== 'object' || !isNookaraId(body.sync[NOOKARA_ID_FIELD]) || (body.sync.stamp != null && (typeof body.sync.stamp !== 'string' || body.sync.stamp.length > STAMP_MAX))) throw err('invalid_sync');
      data.sync = { [NOOKARA_ID_FIELD]: String(body.sync[NOOKARA_ID_FIELD]), stamp: body.sync.stamp || '', at: now() };
    }
  }
  return write(u, { display_name: name, data });
}

// POST /api/v1/me/profile/:kind (pfp | banner, multipart image) and DELETE
function setImage(me, kind, buffer) {
  if (!['pfp', 'banner'].includes(kind)) throw err('not_found', 404);
  const u = mine(me), data = stored(u);
  const old = kind === 'pfp' ? u.pfp : data.banner;
  const url = buffer ? require('./uploads').saveImage(buffer, `profile_${kind}`) : null;
  if (kind === 'banner') { if (url) data.banner = url; else delete data.banner; }
  const out = write(u, { ...(kind === 'pfp' ? { pfp: url } : {}), data });
  if (old && old !== url) SP().dropFiles(old);
  return out;
}

// a moderator's reset (server-profile.js reset, Manage users): everything back to a plain account, and nothing follows Nookara any more
function reset(u) {
  if (!auth.profileHere(u)) return false;
  const s = stored(u);
  if (!u.pfp && !Object.keys(s).length && u.display_name === u.username) return false;
  write(u, { display_name: u.username, pfp: null, data: {} });
  SP().dropFiles(u.pfp, s.banner);
  return true;
}

module.exports = { look, get, update, setImage, reset, NAME_MAX, BIO_MAX, PRONOUNS_MAX };
