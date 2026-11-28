'use strict';
// Moving a server here on someone else's behalf (PROTOCOL §5a "Moving a server here"): a homeserver admin imports an export
// zip (bonfire-export-v1) for its owner, at the address it had. Nookara's migration of its hosted servers into its own
// homeserver uses this (Nookara scripts/migrate-hosted.js). The server's old origin is remembered with the homeserver's
// earlier addresses (previous_urls), so signatures made for it still check out.
const db = require('./db');
const auth = require('./auth');
const config = require('./config');
const exp = require('./export');
const uploads = require('./uploads');
const C = require('./communities');
const SLUG = require('./slug');
const IB = require('./import-bots');
const path = require('path');
const { strFromU8 } = require('fflate');
const { err, normalizeOrigin, clean } = require('./util');

const MAX_IMPORTED = 1000;
// the earlier origins of servers that moved here (meta imported_origins), newest last
function importedOrigins() { try { const a = JSON.parse(db.metaGet('imported_origins') || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } }
function rememberOrigin(o) {
  const list = importedOrigins().filter(x => x !== o);
  list.push(o);
  db.metaSet('imported_origins', JSON.stringify(list.slice(-MAX_IMPORTED)));
}
// owner: "v:<Nookara id>" (made as a placeholder when nobody here has it yet; needs accounts.nookara_identity) or the
// principal of an account here
function ownerOf(raw) {
  const p = String(raw || '').trim();
  if (/^v:[1-9]\d{0,19}$/.test(p)) {
    if (!config.nookaraIdentity() && config.mode() !== 'nookara') throw err('nookara_accounts_off', 400);
    return auth.ensureNookaraPlaceholder(p.slice(2));
  }
  const u = auth.userByPrincipal(p);
  if (!u || u.kind === 'bot' || u.kind === 'remote' || u.banned) throw err('owner_not_found', 404);
  return u;
}
// POST /api/v2/homeserver/import?owner=<principal>&slug=<slug>&previous_url=<origin>&invite_code=<code> (multipart `file`, and
// optionally `bridges`: JSON, the server's bridge links when its export does not carry them) -> { sid, slug, address, owner,
// invite_code, invites, bridges }
async function importFor(q) {
  const owner = ownerOf(q.owner);
  let slug;
  if (q.slug !== undefined && q.slug !== '') {
    slug = String(q.slug).trim().toLowerCase();
    if (!SLUG.valid(slug)) throw err('invalid_slug');
    if (db.get('SELECT 1 FROM communities WHERE slug = ?', slug)) throw err('slug_taken', 409, { slug });
  }
  let prev = null;
  if (q.previous_url !== undefined && q.previous_url !== '') {
    prev = normalizeOrigin(String(q.previous_url));
    if (!prev || prev === normalizeOrigin(config.publicUrl())) throw err('invalid_previous_url');
  }
  return { owner, slug, prev };
}
function register(app) {
  app.post('/api/v2/homeserver/import', { admin: true }, async req => {
    const { owner, slug, prev } = await importFor(req.query || {}); // (checked before the upload is read)
    const { buffer, fields } = await uploads.readMultipart(req, { maxBytes: 1024 * 1024 * 1024, fieldSize: 512 * 1024 });
    if (!buffer) throw err('no_file');
    let bridges;
    if (fields.bridges !== undefined) { try { bridges = JSON.parse(fields.bridges); } catch { bridges = null; } if (!Array.isArray(bridges)) throw err('invalid_bridges'); }
    const bots = botsField(fields);
    const report = {};
    const c = exp.importCommunity(owner, buffer, null, { trusted: true, slug, inviteCode: typeof req.query.invite_code === 'string' ? req.query.invite_code : undefined, bridges, bots, report });
    if (slug && c.slug !== slug) throw err('slug_taken', 409, { slug, sid: c.sid }); // (taken while it was uploading)
    if (prev) rememberOrigin(prev);
    // each bridge as this homeserver's bot sees it: not set up here, or not in that guild (the owner invites it again)
    let seen = [];
    if (report.bridges?.some(b => b.linked)) {
      try { seen = (await require('./bridge/bridge').status(owner, c.sid)).bridges; } catch { seen = []; }
    }
    const bridgesOut = (report.bridges || []).map(b => {
      const s = seen.find(x => x.platform === b.platform);
      const problem = b.why || s?.problem || null;
      return { ...b, ...(problem ? { problem, action: problem === 'bot_not_in_server' ? 'reinvite_bot' : problem === 'bridge_not_set_up' ? 'homeserver_bot_needed' : problem === 'matrix_bot_needed' ? 'owner_sets_matrix_bot' : problem === 'guild_already_linked' ? 'resolve_conflict' : 'check' } : {}) };
    });
    const main = require('./db').get('SELECT invite_code FROM communities WHERE id = ?', c.id).invite_code;
    return { sid: c.sid, slug: c.slug, address: C.addressOf(c), owner: owner.principal, main_invite_code: main, invite_code: report.invite_code || null, invites: report.invites || [], bridges: bridgesOut, members: report.members || { added: 0, already: 0, skipped: [] }, bots: report.bots || [] };
  });
  // POST /api/v2/homeserver/import/bots?sid=<sid> (multipart `file`: the export the server was imported from; optionally `bots`:
  // JSON, its bots when the export does not carry them, scripts/export-bots.js) -> { sid, bots, members, messages, mentions }.
  // For a server imported before bots moved too. Safe to repeat.
  app.post('/api/v2/homeserver/import/bots', { admin: true }, async req => {
    const c = db.get("SELECT * FROM communities WHERE sid = ? AND kind = 'server'", String(req.query?.sid || ''));
    if (!c) throw err('server_not_found', 404);
    const { buffer, fields } = await uploads.readMultipart(req, { maxBytes: 1024 * 1024 * 1024, fieldSize: 512 * 1024 });
    if (!buffer) throw err('no_file');
    const bots = botsField(fields);
    return { sid: c.sid, ...botsInto(c, exp.readExport(buffer), bots) };
  });
}
function botsField(fields) {
  if (fields.bots === undefined) return undefined;
  let v; try { v = JSON.parse(fields.bots); } catch { v = null; }
  if (!Array.isArray(v)) throw err('invalid_bots');
  return v;
}

// the bots of an export into a server already imported from it: accounts, membership and roles (by role name), and the messages
// the first import kept under the bot's name only become the bot's again (matched by name, time and text)
const jsonl = u8 => strFromU8(u8).split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
function botsInto(c, { entries, cj }, records) {
  const origin = normalizeOrigin(config.publicUrl());
  const mapUrl = v => {
    if (typeof v === 'string' && v.startsWith('files/') && !v.includes('..') && entries[v]) {
      const rel = `imported/bots-${c.sid}/${path.basename(v)}`;
      uploads.writeStored(rel, Buffer.from(entries[v]));
      return `${origin}/uploads/${rel}`;
    }
    return /^https?:\/\//.test(v || '') ? v : null;
  };
  const report = {};
  return db.tx(() => {
    const map = IB.carry(records ?? (entries['bots.jsonl'] ? jsonl(entries['bots.jsonl']) : []), { c, fallbackOwner: auth.userById(c.owner_id), mapUrl, report });
    const oldRoles = new Map((Array.isArray(cj.roles) ? cj.roles : []).filter(r => r && typeof r.rid === 'string').map(r => [r.rid, r]));
    const roleOf = rid => {
      const r = oldRoles.get(rid);
      return r && !r.is_default ? db.get('SELECT * FROM roles WHERE community_id = ? AND is_default = 0 AND name = ? ORDER BY ABS(position - ?) LIMIT 1', c.id, clean(r.name, 40) || 'role', Number(r.position) || 0) : null;
    };
    const members = { added: 0, already: 0, skipped: [] };
    for (const m of entries['members.jsonl'] ? jsonl(entries['members.jsonl']) : []) {
      const u = map.get(m.user?.id);
      if (!u) continue;
      const j = IB.join(c, u, m.roles, roleOf);
      if (j.added) members.added++; else if (j.why) members.skipped.push({ id: m.user.id, username: u.username, why: j.why }); else members.already++;
    }
    // bots that were members without a members.jsonl line (an older export) still join
    for (const u of map.values()) if (!db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', c.id, u.id)) { const j = IB.join(c, u, [], roleOf); if (j.added) members.added++; }
    let messages = 0;
    const find = db.raw().prepare(`SELECT m.id FROM messages m JOIN channels ch ON ch.id = m.channel_id
      WHERE ch.community_id = ? AND m.user_id IS NULL AND m.system = 0 AND m.author_name = ? AND m.created_at = ? AND m.body = ? LIMIT 1`);
    for (const key of Object.keys(entries).filter(k => /^messages\/[^/]+\.jsonl$/.test(k))) {
      for (const m of jsonl(entries[key])) {
        const u = map.get(m.author?.id);
        if (!u || m.system) continue;
        const nameOnly = clean(m.author_name || m.author?.display_name || m.author?.username, 80);
        const row = nameOnly && find.get(c.id, nameOnly, Number(m.created_at) || 0, String(m.body ?? '').slice(0, 4000));
        if (!row) continue;
        db.run('UPDATE messages SET user_id = ?, author_name = NULL, author_avatar = NULL WHERE id = ?', u.id, row.id);
        if (m.alias && typeof m.alias === 'object') { try { const al = require('./messages').cleanAlias(u, m.alias); if (al) db.run('UPDATE messages SET alias_name = ?, alias_avatar = ? WHERE id = ?', al.name, al.avatar, row.id); } catch { /* dropped */ } }
        messages++;
      }
    }
    // <@b:old> mentions -> the bots here, once per old bot (a second run would read the new ids as old ones)
    const key = 'bot_import_mentions:' + c.sid;
    let done = []; try { done = JSON.parse(db.metaGet(key) || '[]'); } catch { done = []; }
    const todo = new Map([...map].filter(([p]) => !done.includes(p)));
    let mentions = 0;
    if (todo.size) {
      for (const m of db.all("SELECT m.id, m.body FROM messages m JOIN channels ch ON ch.id = m.channel_id WHERE ch.community_id = ? AND m.body LIKE '%<@%b:%'", c.id)) {
        const body = IB.remapMentions(m.body, todo);
        if (body !== m.body) { db.run('UPDATE messages SET body = ? WHERE id = ?', body, m.id); mentions++; }
      }
      db.metaSet(key, JSON.stringify([...done, ...todo.keys()]));
    }
    return { bots: report.bots, members, messages, mentions };
  });
}

module.exports = { register, importedOrigins };
