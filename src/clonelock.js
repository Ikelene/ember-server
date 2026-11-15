'use strict';
// Clone locks (Nat 2026-11-14). A server can turn off "Allow cloning server emojis & stickers" (settings emojis.allow_cloning,
// on by default), and a Nookara account can lock its personal emojis + stickers (Nookara chat setting lock_emojis).
// Cloning in Ember = fetch the picture and upload the same bytes somewhere else, so a clone is spotted by the file's sha256:
// - an instance holds one server, so a clone always lands on another instance (or Nookara): this one answers
//   /clone-check for its own pictures (locked when cloning is off, unless the asker is its owner / has Administrator);
// - an upload here whose bytes are someone's locked Nookara personal emoji/sticker is refused (clone_locked) - Nookara is asked;
// - `from` (the picture's address, sent by Ember) on another Ember server: that server is asked the same question.
// GET /api/v1/clone-check?sha256=&velora_id= answers others (Nookara for "Add to personal", other instances).
// A changed file (re-saved, cropped, screenshotted) is a new picture: this stops clone buttons and exact copies, nothing more.
// Origins (Nat 2026-11-14): a copy remembers where its bytes were first seen - { type: 'server', name, host } or
// { type: 'user', user_id, username } (a Nookara personal one). /clone-check answers it too, so a copy of a copy keeps the first.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const { err } = require('./util');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const KINDS = ['emojis', 'stickers'];

// sha256 -> [{ t: 'emojis'|'stickers', id: row id, cid: community id }] with exactly those bytes (built on first use, kept up to date)
let index = null;
const fileHash = rel => { try { return rel && !rel.includes('..') ? sha256(fs.readFileSync(path.join(config.dir(), 'uploads', rel))) : null; } catch { return null; } };
function build() {
  index = new Map();
  for (const t of KINDS) for (const r of db.all(`SELECT id, community_id, file FROM ${t}`)) add(t, r.id, r.community_id, fileHash(r.file));
  return index;
}
function add(t, id, communityId, hash) {
  if (!hash || !index) return;
  if (!index.has(hash)) index.set(hash, []);
  index.get(hash).push({ t, id: Number(id), cid: Number(communityId) });
}
// after a create: the bytes that were saved. t: 'emojis' | 'stickers', id: the new row's id
const saved = (communityId, buf, t = null, id = null) => { if (t && id != null) add(t, id, communityId, sha256(buf)); else index = null; };
// after a delete (the file is gone, so rebuild that hash from the table on the next look)
const forget = () => { index = null; };

const allowsCloning = c => require('./settings').get(c).emojis?.allow_cloning !== false;
// the servers that would refuse a copy of these bytes for this user (velora_id: a Nookara account id, for other servers asking)
function lockedBy(hash, { userId = null, veloraId = null, into = null } = {}) {
  const C = require('./communities');
  const out = [];
  for (const cid of new Set(((index || build()).get(hash) || []).map(x => x.cid))) {
    const c = db.get('SELECT * FROM communities WHERE id = ?', cid);
    if (!c || allowsCloning(c) || Number(c.id) === Number(into)) continue; // (a copy inside the same server isn't a clone)
    let uid = userId;
    if (uid == null && veloraId) uid = db.get("SELECT id FROM users WHERE velora_id = ?", String(veloraId))?.id ?? null;
    if (uid != null && C.canManageClones(c, uid)) continue; // its owner / admins: their own server's pictures
    out.push(c);
  }
  return out;
}

const parseOrigin = v => { try { const o = typeof v === 'string' ? JSON.parse(v) : v; return o && typeof o === 'object' && ['server', 'user'].includes(o.type) ? cleanOrigin(o) : null; } catch { return null; } };
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
function cleanOrigin(o) {
  if (o.type === 'server') return { type: 'server', name: str(o.name, 100) || 'An Ember server', host: str(o.host, 255) };
  return { type: 'user', user_id: o.user_id != null ? String(o.user_id).slice(0, 40) : null, username: str(o.username, 40) };
}
const host = () => { try { return new URL(config.get().public_url).host; } catch { return null; } };
// where these bytes were first seen, going by this instance's oldest emoji/sticker with them: its own origin, else its server
function originHere(hash) {
  const rows = ((index || build()).get(hash) || []).map(x => ({ ...x, row: db.get(`SELECT * FROM ${x.t} WHERE id = ?`, x.id) })).filter(x => x.row);
  if (!rows.length) return null;
  rows.sort((a, b) => (a.row.created_at || 0) - (b.row.created_at || 0));
  const first = rows[0];
  const o = parseOrigin(first.row.origin);
  if (o) return o;
  const c = db.get('SELECT name FROM communities WHERE id = ?', first.cid);
  return { type: 'server', name: c?.name || 'An Ember server', host: host() };
}

// GET /api/v1/clone-check: { locked, reason?, origin? } - origin: where a picture with those bytes was first seen
function check(hash, veloraId) {
  if (!/^[0-9a-f]{64}$/.test(String(hash || ''))) throw err('invalid_sha256');
  const locked = lockedBy(String(hash), { veloraId: veloraId ? String(veloraId).slice(0, 40) : null }).length > 0;
  const origin = originHere(String(hash));
  return { locked, ...(locked ? { reason: 'cloning_disabled' } : {}), ...(origin ? { origin } : {}) };
}

// ask another server (Nookara or an Ember server): its { locked, origin? }. Any failure = not locked, no origin (never block uploads on a slow peer)
async function askRemote(origin, hash, veloraId) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return {};
    const pathPart = /(^|\.)nookara\.cc$|velora\.ikelene\.net$/.test(u.hostname) || origin === config.get().velora_url ? '/chat/clone-check' : '/api/v1/clone-check';
    const q = new URLSearchParams({ sha256: hash, ...(veloraId ? { velora_id: String(veloraId) } : {}) });
    const res = await fetch(`${u.origin}${pathPart}?${q}`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (!res.ok) return {};
    const d = await res.json().catch(() => ({}));
    return { locked: d.locked === true, origin: parseOrigin(d.origin) };
  } catch { return {}; }
}
const selfOrigin = () => { try { return new URL(config.get().public_url).origin; } catch { return null; } };

// before an emoji/sticker upload is saved. me: the uploader. from: the picture's address the client copied it from (optional)
// into: the server it goes to. -> the copy's origin (where its bytes were first seen) or null for a new picture
async function assertCloneAllowed(buf, me, from, into = null) {
  if (!buf) return null;
  const hash = sha256(buf);
  if (lockedBy(hash, { userId: me.id, into }).length) throw err('cloning_disabled', 403);
  const veloraId = me.velora_id || null;
  const asks = [];
  if (config.mode() === 'velora' && config.get().velora_url) asks.push(askRemote(config.get().velora_url, hash, veloraId).then(a => ({ ...a, code: 'clone_locked' })));
  let fromOrigin = null;
  try { fromOrigin = from ? new URL(String(from).slice(0, 500)).origin : null; } catch { fromOrigin = null; }
  if (fromOrigin && fromOrigin !== selfOrigin() && fromOrigin !== config.get().velora_url && !/(^|\.)nookara\.cc$/.test(new URL(fromOrigin).hostname)) {
    asks.push(askRemote(fromOrigin, hash, veloraId).then(a => ({ ...a, code: 'cloning_disabled', from: true })));
  }
  const answers = await Promise.all(asks);
  for (const a of answers) if (a.locked) throw err(a.code, 403);
  // the origin: the server it was copied from knows best, then Nookara, then this instance (a copy into the same server)
  const into_ = Number(into);
  const here = ((index || build()).get(hash) || []).some(x => x.cid !== into_) ? originHere(hash) : null;
  return answers.find(a => a.from && a.origin)?.origin || answers.find(a => a.origin)?.origin || here || null;
}

module.exports = { sha256, saved, forget, check, assertCloneAllowed, lockedBy, allowsCloning, parseOrigin, _reset: () => { index = null; } };
