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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const { err } = require('./util');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const KINDS = ['emojis', 'stickers'];

// sha256 -> Set of community ids that have an emoji/sticker with exactly those bytes (built on first use, kept up to date)
let index = null;
const fileHash = rel => { try { return rel && !rel.includes('..') ? sha256(fs.readFileSync(path.join(config.dir(), 'uploads', rel))) : null; } catch { return null; } };
function build() {
  index = new Map();
  for (const t of KINDS) for (const r of db.all(`SELECT community_id, file FROM ${t}`)) add(r.community_id, fileHash(r.file));
  return index;
}
function add(communityId, hash) {
  if (!hash || !index) return;
  if (!index.has(hash)) index.set(hash, new Set());
  index.get(hash).add(Number(communityId));
}
// after a create: the bytes that were saved
const saved = (communityId, buf) => add(communityId, sha256(buf));
// after a delete (the file is gone, so rebuild that hash from the table on the next look)
const forget = () => { index = null; };

const allowsCloning = c => require('./settings').get(c).emojis?.allow_cloning !== false;
// the servers that would refuse a copy of these bytes for this user (velora_id: a Nookara account id, for other servers asking)
function lockedBy(hash, { userId = null, veloraId = null, into = null } = {}) {
  const C = require('./communities');
  const out = [];
  for (const cid of (index || build()).get(hash) || []) {
    const c = db.get('SELECT * FROM communities WHERE id = ?', cid);
    if (!c || allowsCloning(c) || Number(c.id) === Number(into)) continue; // (a copy inside the same server isn't a clone)
    let uid = userId;
    if (uid == null && veloraId) uid = db.get("SELECT id FROM users WHERE velora_id = ?", String(veloraId))?.id ?? null;
    if (uid != null && C.canManageClones(c, uid)) continue; // its owner / admins: their own server's pictures
    out.push(c);
  }
  return out;
}

// GET /api/v1/clone-check: { locked, reason? } - no names, nothing else about the server
function check(hash, veloraId) {
  if (!/^[0-9a-f]{64}$/.test(String(hash || ''))) throw err('invalid_sha256');
  return lockedBy(String(hash), { veloraId: veloraId ? String(veloraId).slice(0, 40) : null }).length ? { locked: true, reason: 'cloning_disabled' } : { locked: false };
}

// ask another server (Nookara or an Ember server): true = locked. Any failure = not locked (never block uploads on a slow peer)
async function askRemote(origin, hash, veloraId) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return false;
    const pathPart = /(^|\.)nookara\.cc$|velora\.ikelene\.net$/.test(u.hostname) || origin === config.get().velora_url ? '/chat/clone-check' : '/api/v1/clone-check';
    const q = new URLSearchParams({ sha256: hash, ...(veloraId ? { velora_id: String(veloraId) } : {}) });
    const res = await fetch(`${u.origin}${pathPart}?${q}`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (!res.ok) return false;
    return (await res.json().catch(() => ({}))).locked === true;
  } catch { return false; }
}
const selfOrigin = () => { try { return new URL(config.get().public_url).origin; } catch { return null; } };

// before an emoji/sticker upload is saved. me: the uploader. from: the picture's address the client copied it from (optional)
// into: the server it goes to
async function assertCloneAllowed(buf, me, from, into = null) {
  if (!buf) return;
  const hash = sha256(buf);
  if (lockedBy(hash, { userId: me.id, into }).length) throw err('cloning_disabled', 403);
  const veloraId = me.velora_id || null;
  const asks = [];
  if (config.mode() === 'velora' && config.get().velora_url) asks.push(askRemote(config.get().velora_url, hash, veloraId).then(l => l && 'clone_locked'));
  let fromOrigin = null;
  try { fromOrigin = from ? new URL(String(from).slice(0, 500)).origin : null; } catch { fromOrigin = null; }
  if (fromOrigin && fromOrigin !== selfOrigin() && fromOrigin !== config.get().velora_url && !/(^|\.)nookara\.cc$/.test(new URL(fromOrigin).hostname)) {
    asks.push(askRemote(fromOrigin, hash, veloraId).then(l => l && 'cloning_disabled'));
  }
  for (const code of await Promise.all(asks)) if (code) throw err(code, 403);
}

module.exports = { sha256, saved, forget, check, assertCloneAllowed, lockedBy, allowsCloning, _reset: () => { index = null; } };
