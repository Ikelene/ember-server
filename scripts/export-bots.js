#!/usr/bin/env node
'use strict';
// The bots of a server, read out of an instance's database, for an import whose export does not carry them (exports from
// before bots.jsonl): prints the JSON for the `bots` field of POST /api/v2/homeserver/import(/bots).
//   node scripts/export-bots.js <data dir or .db file> [sid]
// Without a sid, the instance's only server (a Nookara-hosted instance has one). Read-only.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const [arg, sid] = process.argv.slice(2);
if (!arg) { console.error('usage: node scripts/export-bots.js <data dir or .db file> [sid]'); process.exit(2); }
const file = fs.statSync(arg).isDirectory() ? ['ember.db', 'bonfire.db'].map(f => path.join(arg, f)).find(f => fs.existsSync(f)) : arg;
if (!file) { console.error('no ember.db / bonfire.db in', arg); process.exit(1); }
const db = new DatabaseSync(file, { readOnly: true });
const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c);
const table = t => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

const servers = db.prepare('SELECT * FROM communities' + (has('communities', 'kind') ? " WHERE kind = 'server'" + (sid ? ' AND sid = ?' : '') : (sid ? ' WHERE sid = ?' : ''))).all(...(sid ? [sid] : [])); // (older instances have no kind column)
if (servers.length !== 1) { console.error(sid ? `no server ${sid}` : `${servers.length} servers here: name one (sid)`); process.exit(1); }
const c = servers[0];
const gallery = has('bots', 'gallery_id');
const rows = db.prepare(`SELECT b.*, u.principal, u.username, u.display_name, u.pfp FROM bots b JOIN users u ON u.id = b.user_id
  JOIN members m ON m.user_id = b.user_id AND m.community_id = ? WHERE u.kind = 'bot' ORDER BY b.user_id`).all(c.id);
const out = rows.map(r => {
  const owner = r.owner_id != null ? db.prepare('SELECT principal, username FROM users WHERE id = ?').get(r.owner_id) : null;
  const extra = table('bot_tokens') ? db.prepare('SELECT token_hash FROM bot_tokens WHERE user_id = ?').all(r.user_id).map(x => x.token_hash) : [];
  const cmds = table('bot_commands') ? db.prepare('SELECT * FROM bot_commands WHERE bot_id = ? AND (community_id IS NULL OR community_id = ?)').all(r.user_id, c.id) : [];
  return {
    id: r.principal, username: r.username, display_name: r.display_name || r.username, pfp: r.pfp || null, description: r.description || '', public: !!r.public,
    owner: owner?.principal || null, owner_username: owner?.username || null, created_at: r.created_at,
    token_hashes: gallery && r.gallery_id ? [] : [...new Set([r.token_hash, ...extra])],
    ...(gallery && r.gallery_id ? { gallery: { id: String(r.gallery_id), test: !!r.gallery_test, verified: !!r.gallery_verified } } : {}),
    commands: cmds.map(x => ({ guild: x.community_id != null, type: x.type, name: x.name, name_localizations: x.name_localizations, description: x.description, description_localizations: x.description_localizations, options: x.options, default_member_permissions: x.default_member_permissions, nsfw: !!x.nsfw })),
  };
});
process.stdout.write(JSON.stringify(out) + '\n');
