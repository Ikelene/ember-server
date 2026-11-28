'use strict';
// Bots moving with a server (admin import, PROTOCOL §5a "Moving a server here"). An export carries the server's bots in
// bots.jsonl (or the importer passes them, scripts/export-bots.js reads them out of an older instance's database). Each becomes
// a bot account of this homeserver, owned by the same owner, and keeps its token(s): only their hashes travel, so the bot's
// program keeps working once it points at this homeserver. The same bot (same owner and name, or a token it already has here)
// moved from several servers is one bot here, with each server's token valid.
const db = require('./db');
const auth = require('./auth');
const config = require('./config');
const C = require('./communities');
const { clean, now } = require('./util');

const NAME = /^[A-Za-z0-9_.-]{2,32}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX = 50;

// what an export says about a bot of the server (export.js), token hashes only when the exporter may move them
function exportRecord(r, me, localFile) {
  const mayMove = Number(r.owner_id) === Number(me.id) || auth.isAdmin(me);
  const owner = auth.userById(r.owner_id);
  const cmds = db.all('SELECT * FROM bot_commands WHERE bot_id = ?', r.user_id);
  return {
    id: r.principal, username: r.username, display_name: r.display_name || r.username, pfp: localFile(r.pfp || null), description: r.description || '', public: !!r.public,
    owner: owner?.principal || null, owner_username: owner?.username || null, created_at: r.created_at,
    token_hashes: mayMove && !r.gallery_id ? [...new Set([r.token_hash, ...db.all('SELECT token_hash FROM bot_tokens WHERE user_id = ?', r.user_id).map(x => x.token_hash)])] : [],
    ...(r.gallery_id ? { gallery: { id: String(r.gallery_id), test: !!r.gallery_test, verified: !!r.gallery_verified } } : {}),
    commands: cmds.map(x => ({ guild: x.community_id != null, type: x.type, name: x.name, name_localizations: x.name_localizations, description: x.description, description_localizations: x.description_localizations, options: x.options, default_member_permissions: x.default_member_permissions, nsfw: !!x.nsfw })),
  };
}
function exportBots(c, me, localFile) {
  return db.all("SELECT b.*, u.principal, u.username, u.display_name, u.pfp FROM bots b JOIN users u ON u.id = b.user_id JOIN members m ON m.user_id = b.user_id AND m.community_id = ? WHERE u.kind = 'bot' ORDER BY b.user_id", c.id)
    .map(r => exportRecord(r, me, localFile));
}

// the bot's owner here: a Nookara account (v:) where those are this homeserver's, an account of this instance, else `fallback`
function ownerHere(p, fallback) {
  p = typeof p === 'string' ? p : '';
  if (/^v:[1-9]\d{0,19}$/.test(p) && (config.mode() === 'nookara' || config.nookaraIdentity())) return auth.ensureNookaraPlaceholder(p.slice(2));
  const u = p && auth.userByPrincipal(p);
  return u && u.kind !== 'bot' && u.kind !== 'remote' ? u : fallback;
}
const freeName = (name, exceptId = 0) => !db.get('SELECT 1 FROM users WHERE LOWER(username) = ? AND id <> ?', name.toLowerCase(), exceptId);
function addToken(uid, hash) {
  if (db.get('SELECT 1 FROM bots WHERE token_hash = ?', hash) || db.get('SELECT 1 FROM bot_tokens WHERE token_hash = ?', hash)) return false;
  db.run('INSERT INTO bot_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)', hash, uid, now());
  return true;
}

// records -> Map(old principal -> bot user row here). c: the server they come into (guild commands go there), fallbackOwner:
// the server's owner (for a bot whose owner has no account here), mapUrl(v): a picture as stored here. report.bots is filled:
// [{ from, id, username, created | reused, renamed?, tokens, why? }]
function carry(records, { c, fallbackOwner, mapUrl, report }) {
  const map = new Map();
  const out = report.bots = [];
  for (const b of (Array.isArray(records) ? records : []).slice(0, MAX)) {
    const from = typeof b?.id === 'string' && /^b:\d{1,15}$/.test(b.id) ? b.id : null;
    let name = clean(b?.username, 32);
    if (!from || !NAME.test(name || '')) { out.push({ from: b?.id ?? null, why: 'invalid_bot' }); continue; }
    const hashes = [...new Set((Array.isArray(b.token_hashes) ? b.token_hashes : []).filter(h => typeof h === 'string' && HASH.test(h)))].slice(0, 20);
    const owner = ownerHere(b.owner, fallbackOwner);
    const gid = b.gallery && /^[1-9]\d{0,19}$/.test(String(b.gallery.id)) ? String(b.gallery.id) : null;
    // the same bot already here: by a token it has, its gallery id, or its owner + name
    let row = null;
    for (const h of hashes) { row = db.get('SELECT user_id FROM bots WHERE token_hash = ?', h) || db.get('SELECT user_id FROM bot_tokens WHERE token_hash = ?', h); if (row) break; }
    if (!row && gid) row = db.get('SELECT user_id FROM bots WHERE gallery_id = ?', gid);
    if (!row) row = db.get("SELECT b.user_id FROM bots b JOIN users u ON u.id = b.user_id WHERE u.kind = 'bot' AND LOWER(u.username) = ? AND b.owner_id = ?", name.toLowerCase(), owner.id);
    let uid, created = false, renamed = null;
    if (row) uid = Number(row.user_id);
    else {
      if (!freeName(name)) { // the name is someone else's here: the first free name_2, name_3...
        const base = name.slice(0, 29);
        for (let n = 2; n < 100; n++) if (freeName(`${base}_${n}`)) { renamed = `${base}_${n}`; break; }
        if (!renamed) { out.push({ from, username: name, why: 'name_taken' }); continue; }
        name = renamed;
      }
      const dn = clean(b.display_name, 64) || name;
      const r = db.run("INSERT INTO users (principal, kind, username, display_name, username_lc, pfp, created_at) VALUES ('pending', 'bot', ?, ?, ?, ?, ?)", name, dn, name.toLowerCase(), mapUrl(b.pfp) || null, Number(b.created_at) || now());
      uid = Number(r.lastInsertRowid);
      db.run('UPDATE users SET principal = ? WHERE id = ?', 'b:' + uid, uid);
      // a bot moved without a token gets one nobody has (its owner resets it from the bot's page)
      const first = hashes.find(h => !db.get('SELECT 1 FROM bots WHERE token_hash = ?', h) && !db.get('SELECT 1 FROM bot_tokens WHERE token_hash = ?', h)) || require('crypto').randomBytes(32).toString('hex');
      db.run('INSERT INTO bots (user_id, owner_id, token_hash, description, public, created_at, gallery_id, gallery_test, gallery_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        uid, owner.id, first, String(b.description || '').slice(0, 300), b.public === false ? 0 : 1, Number(b.created_at) || now(), gid, gid && b.gallery.test ? 1 : 0, gid && b.gallery.verified ? 1 : 0);
      created = true;
    }
    for (const h of hashes) addToken(uid, h);
    const have = db.get('SELECT token_hash FROM bots WHERE user_id = ?', uid).token_hash;
    const tokens = hashes.filter(h => h === have || db.get('SELECT 1 FROM bot_tokens WHERE token_hash = ? AND user_id = ?', h, uid)).length;
    // its commands (the server's ones come into this server)
    for (const x of (Array.isArray(b.commands) ? b.commands : []).slice(0, 200)) {
      const cmdName = clean(x?.name, 32);
      if (!cmdName) continue;
      const t = now();
      db.run(`INSERT OR IGNORE INTO bot_commands (bot_id, community_id, type, name, name_localizations, description, description_localizations, options, default_member_permissions, nsfw, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, uid, x.guild ? c.id : null, Number.isInteger(x.type) ? x.type : 1, cmdName, str(x.name_localizations), String(x.description || '').slice(0, 100),
      str(x.description_localizations), str(x.options) || '[]', x.default_member_permissions == null ? null : String(x.default_member_permissions), x.nsfw ? 1 : 0, t, t);
    }
    const u = auth.userById(uid);
    map.set(from, u);
    out.push({ from, id: u.principal, username: u.username, owner: auth.userById(db.get('SELECT owner_id FROM bots WHERE user_id = ?', uid).owner_id)?.principal || null, [created ? 'created' : 'reused']: true, ...(renamed ? { renamed: true } : {}), tokens, ...(hashes.length ? {} : { why: 'no_token' }) });
  }
  return map;
}
const str = v => (v == null ? null : typeof v === 'string' ? v.slice(0, 20000) : JSON.stringify(v).slice(0, 20000));

// a bot as a member of `c` with the roles named by the export (roleOf(old rid) -> role row here)
function join(c, u, roles, roleOf) {
  let added = false;
  if (!db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', c.id, u.id)) {
    try { C.addMember(c, u.id, { quiet: true, announce: false }); added = true; } catch (e) { return { added: false, why: e.code || 'cannot_add' }; }
  }
  for (const rid of Array.isArray(roles) ? roles : []) { const r = roleOf(rid); if (r && !r.is_default) db.run('INSERT OR IGNORE INTO member_roles (community_id, user_id, role_id) VALUES (?, ?, ?)', c.id, u.id, r.id); }
  return { added };
}
// <@b:old> in a message body -> <@b:new>, in one pass
const remapMentions = (body, map) => (typeof body === 'string' && map.size ? body.replace(/<@!?(b:\d{1,15})>/g, (all, p) => (map.has(p) ? `<@${map.get(p).principal}>` : all)) : body);

module.exports = { exportBots, carry, join, remapMentions };
