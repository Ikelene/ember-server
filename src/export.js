'use strict';
// The export format (PROTOCOL §9, compat EXPORT_FORMAT): export a community to a zip, import one back as a new community.
const { EXPORT_FORMAT, env, KIND_NOOKARA, NOOKARA_ID_FIELD } = require('./compat');
const fs = require('fs');
const path = require('path');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const C = require('./communities');
const uploads = require('./uploads');
const { ALL_PERMS, CHANNEL_BITS } = require('./perms');
const { err, normalizeOrigin, randHex, sha256, now, clean } = require('./util');

const FORMAT = EXPORT_FORMAT;
const MAX_UNZIPPED = 2 * 1024 * 1024 * 1024;
const origin = () => normalizeOrigin(config.publicUrl());

// ---------------------------------------------------------------- export
function exportCommunity(sid, me) {
  const c = C.findCommunity(sid);
  const snap = C.snapOf(c);
  if (!snap.isOwner(me.id)) throw err('not_allowed', 403);
  const files = {};
  const fileRefs = new Map(); // upload path -> files/<path>
  // a locally hosted file becomes files/<path> inside the zip; anything else stays a URL
  const localFile = url => {
    if (typeof url !== 'string') return url ?? null;
    const prefix = origin() + '/uploads/';
    if (!url.startsWith(prefix)) return url;
    let rel; try { rel = decodeURIComponent(url.slice(prefix.length)); } catch { return url; }
    if (fileRefs.has(rel)) return fileRefs.get(rel);
    const abs = path.resolve(uploads.root(), rel);
    if (!abs.startsWith(path.resolve(uploads.root()) + path.sep)) return url;
    let data; try { data = fs.readFileSync(abs); } catch { return url; }
    const ref = 'files/' + rel;
    files[ref] = [data, { level: 0 }];
    fileRefs.set(rel, ref);
    return ref;
  };
  const roleByRid = id => snap.roles.find(r => r.id === id)?.rid;
  const emojis = db.all('SELECT * FROM emojis WHERE community_id = ? ORDER BY id', c.id).map(e => ({ eid: e.eid, name: e.name, animated: !!e.animated, file: localFile(`${origin()}/uploads/${e.file}`) }));
  const stickers = db.all('SELECT * FROM stickers WHERE community_id = ? ORDER BY id', c.id).map(s => ({ tid: s.tid, name: s.name, animated: !!s.animated, file: localFile(`${origin()}/uploads/${s.file}`) }));
  const community = {
    name: c.name, slug: c.slug, description: c.description, icon: localFile(c.icon_url), banner: localFile(c.banner_url),
    settings: { join_policy: c.join_policy, allow_uploads: !!c.allow_uploads, upload_max_mb: c.upload_max_mb, rules: require('./settings').exportable(c) },
    categories: C.categoriesOf(c),
    channels: snap.channels.map(ch => ({
      cid: ch.cid, name: ch.name, topic: ch.topic, category: ch.category, position: ch.position, locked: !!ch.locked, type: ch.type, config: C.cfgOf(ch),
      perms: [...(snap.ow.get(ch.id) || new Map())].map(([rid, o]) => ({ role: roleByRid(rid), allow: o.allow, deny: o.deny })).filter(x => x.role),
    })),
    roles: snap.roles.map(r => ({ rid: r.rid, name: r.name, color: r.color || null, position: r.position, permissions: r.permissions, upload_max_mb: r.upload_max_mb ?? null, hoist: !!r.hoist, mentionable: !!r.mentionable, is_default: !!r.is_default })),
    emojis,
    stickers,
    invites: db.all('SELECT * FROM invites WHERE community_id = ?', c.id).map(i => ({ code: i.code, expires_at: i.expires_at ?? null, max_uses: i.max_uses ?? null })),
    invite_code: c.invite_code, // the server's own permanent code (old links carry it)
    bridges: bridgesOf(c), // linked Discord / Fluxer guilds and Matrix rooms with their channel maps (no tokens, no webhooks)
  };
  files['manifest.json'] = strToU8(JSON.stringify({ format: FORMAT, source: origin(), source_kind: 'instance', exported_at: now(), community: c.sid }));
  files['community.json'] = strToU8(JSON.stringify(community, null, 1));

  const members = db.all('SELECT u.*, m.joined_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? ORDER BY m.joined_at, u.id', c.id);
  files['members.jsonl'] = strToU8(members.map(u => JSON.stringify({
    user: auth.userView(u), roles: [...snap.roleIds(u.id)].map(roleByRid).filter(Boolean), joined_at: u.joined_at, ...(snap.isOwner(u.id) ? { owner: true } : {}),
  })).join('\n') + (members.length ? '\n' : ''));

  for (const ch of snap.channels) {
    const lines = [];
    let last = 0;
    for (;;) {
      const rows = db.all(`SELECT m.*, u.principal AS u_principal, u.kind AS u_kind, u.username AS u_username, u.display_name AS u_dn, u.pfp AS u_pfp, u.nookara_id AS u_vid
        FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? AND m.id > ? ORDER BY m.id LIMIT 1000`, ch.id, last);
      if (!rows.length) break;
      last = rows[rows.length - 1].id;
      const rx = new Map();
      for (const r of db.raw().prepare(`SELECT r.message_id, r.emoji, u.principal FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id IN (${db.inList(rows)}) ORDER BY r.created_at, r.rowid`).all(...rows.map(x => x.id))) {
        if (!rx.has(r.message_id)) rx.set(r.message_id, []);
        const list = rx.get(r.message_id);
        let e = list.find(x => x.emoji === r.emoji);
        if (!e) { e = { emoji: r.emoji, users: [] }; list.push(e); }
        e.users.push(r.principal);
      }
      for (const r of rows) {
        let atts = []; try { atts = r.attachments ? JSON.parse(r.attachments) : []; } catch { atts = []; }
        const o = {
          id: String(r.id),
          author: r.u_principal ? { id: r.u_principal, kind: r.u_kind, username: r.u_username, display_name: r.u_dn, pfp: r.u_pfp || null, ...require('./compat').nookaraIdFields(r.u_vid) } : null,
          ...(!r.u_principal && r.author_name ? { author_name: r.author_name, author_avatar: r.author_avatar || null } : {}),
          body: r.body, attachments: atts.map(a => ({ ...a, url: localFile(a.url) })),
          ...(r.embeds ? { embeds: JSON.parse(r.embeds) } : {}),
          reply_to: r.reply_to ? String(r.reply_to) : null, created_at: r.created_at, edited_at: r.edited_at || null, system: !!r.system,
          ...(r.sys_kind ? { sys_kind: r.sys_kind } : {}), pinned: !!r.pinned_at, reactions: rx.get(r.id) || [],
          ...(r.sig_kid ? { signature: { kid: r.sig_kid, sig: r.sig_sig, ts: r.sig_ts, nonce: r.sig_nonce } } : {}),
          ...(r.bridge ? { bridge: r.bridge } : {}),
          ...(r.sticker_id ? { sticker: r.sticker_id } : {}),
          ...(r.alias_name ? { alias: { name: r.alias_name, avatar_url: r.alias_avatar || null } } : {}),
        };
        lines.push(JSON.stringify(o));
      }
    }
    files[`messages/${ch.cid}.jsonl`] = strToU8(lines.join('\n') + (lines.length ? '\n' : ''));
  }
  return Buffer.from(zipSync(files, { level: 6 }));
}

// ---------------------------------------------------------------- import
const jsonl = u8 => strFromU8(u8).split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const validRoleUpload = v => Number.isInteger(v) && v >= 1 && v <= 500 ? v : null;
function readExport(buffer) {
  let total = 0, entries;
  try { entries = unzipSync(new Uint8Array(buffer), { filter: f => { total += f.originalSize; if (total > MAX_UNZIPPED) throw new Error('too big'); return true; } }); } catch { throw err('invalid_export', 400); }
  let manifest, cj;
  try { manifest = JSON.parse(strFromU8(entries['manifest.json'])); cj = JSON.parse(strFromU8(entries['community.json'])); } catch { throw err('invalid_export', 400); }
  if (manifest?.format !== FORMAT || !cj || typeof cj !== 'object' || !Array.isArray(cj.channels) || !Array.isArray(cj.roles)) throw err('invalid_export', 400);
  return { entries, manifest, cj };
}
// A new server owned by `me`. opts.trusted: no creation check (restoring a backup); opts.slug: the address to take when it is free
// the bridge links of a server, for its export: what is needed to link the same guilds again (secrets stay behind)
function bridgesOf(c) {
  try { require('./bridge/store').ensure(); } catch { return []; }
  return db.all('SELECT * FROM bridge_guilds WHERE community_id = ? ORDER BY id', c.id).map(b => ({
    platform: b.platform, guild_id: b.guild_id, guild_name: b.guild_name, enabled: !!b.enabled,
    links: db.all('SELECT ch.cid, bc.ext_channel_id, bc.ext_name FROM bridge_channels bc JOIN channels ch ON ch.id = bc.channel_id WHERE bc.bridge_id = ?', b.id),
  }));
}
const CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;
const codeFree = code => !db.get('SELECT 1 FROM invites WHERE code = ?', code) && !db.get('SELECT 1 FROM communities WHERE invite_code = ?', code);
// opts: trusted (a restore or an admin's import: nothing is asked), slug, inviteCode (the main code to keep, else the export's),
// bridges (links to make, else the export's; only for a trusted import), report (an object filled with what was kept or not:
// { invite_code: { from, to }, invites: [{ from, to }], bridges: [{ platform, guild_id, linked, why? }] })
function importCommunity(me, buffer, parsed, opts = {}) {
  if (!opts.trusted) C.assertMayCreate(me);
  const { entries, manifest, cj } = parsed || readExport(buffer);
  const sameInstance = normalizeOrigin(manifest.source) === origin();
  const nookara = config.mode() === 'nookara';
  const sidTag = randHex(4);
  const storeFile = (ref, kind) => { // files/<path> inside the zip -> a file under uploads/, returning its URL
    const data = typeof ref === 'string' && ref.startsWith('files/') ? entries[ref] : null;
    if (!data || ref.includes('..')) return null;
    const rel = `imported/${sidTag}/${kind}/${path.basename(ref)}`;
    uploads.writeStored(rel, Buffer.from(data));
    return `${origin()}/uploads/${rel}`;
  };
  const mapUrl = (v, kind) => (typeof v === 'string' && v.startsWith('files/') ? storeFile(v, kind) : (/^https?:\/\//.test(v || '') ? v : null));

  // who is who: v: principals keep identity; l: principals only if they're this instance's own accounts
  const resolve = u => {
    const principal = typeof u === 'string' ? u : u?.id;
    if (typeof principal !== 'string') return null;
    if (principal.startsWith('v:') && /^v:[1-9]\d{0,19}$/.test(principal)) return auth.ensureNookaraPlaceholder(principal.slice(2), u?.username, u?.pfp);
    if (principal.startsWith('l:') && sameInstance) return auth.userByPrincipal(principal) || null;
    return null;
  };

  const result = db.tx(() => {
    const st = cj.settings || {};
    // (a password isn't exported: a password server comes back asking to join)
    // the address it had (a backup's server, else the export's own slug) when nobody here has it; otherwise one from the name
    const want = [opts.slug, cj.slug].find(s => typeof s === 'string' && require('./slug').valid(s) && !db.get('SELECT 1 FROM communities WHERE slug = ?', s));
    const slug = want || undefined;
    const c = C.createCommunity(me, { name: cj.name, description: cj.description, slug, join_policy: ['open', 'request', 'allowlist', 'invite'].includes(st.join_policy) ? st.join_policy : 'request' }, { empty: true, trusted: opts.trusted });
    const set = { allow_uploads: st.allow_uploads === false ? 0 : 1, upload_max_mb: Number.isInteger(st.upload_max_mb) && st.upload_max_mb >= 1 && st.upload_max_mb <= 500 ? st.upload_max_mb : 25 };
    // (allow_signing / require_signing in older exports are ignored: signing is always optional)
    set.icon_url = mapUrl(cj.icon, 'chat'); set.banner_url = mapUrl(cj.banner, 'chat');
    db.run(`UPDATE communities SET ${Object.keys(set).map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(set), c.id);

    // roles (old rid -> new row)
    const roleMap = new Map();
    const everyoneNew = db.get('SELECT * FROM roles WHERE community_id = ? AND is_default = 1', c.id);
    const roleList = cj.roles.filter(r => r && typeof r.rid === 'string').slice(0, C.LIMITS.roles);
    for (const r of roleList.filter(x => x.is_default)) { db.run('UPDATE roles SET permissions = ?, upload_max_mb = ? WHERE id = ?', (Number(r.permissions) || 0) & ALL_PERMS & ~0, validRoleUpload(r.upload_max_mb), everyoneNew.id); roleMap.set(r.rid, everyoneNew); }
    let pos = 1;
    for (const r of roleList.filter(x => !x.is_default).sort((a, b) => (a.position || 0) - (b.position || 0))) {
      roleMap.set(r.rid, C.insertRole(c.id, { name: clean(r.name, 40) || 'role', color: /^#[0-9a-f]{6}$/i.test(r.color || '') ? r.color : null, position: pos++, permissions: (Number(r.permissions) || 0) & ALL_PERMS, hoist: r.hoist, mentionable: r.mentionable, upload_max_mb: validRoleUpload(r.upload_max_mb) }));
    }
    // Server settings (joining, message rules, AutoMod, audit log, uploads), with role ids moved to the new roles
    if (st.rules) db.run('UPDATE communities SET settings = ? WHERE id = ?', JSON.stringify(require('./settings').imported(st.rules, rid => roleMap.get(rid)?.rid)), c.id);
    // channels + overwrites
    const chMap = new Map();
    const cats = [...new Set([...(Array.isArray(cj.categories) ? cj.categories : []), ...cj.channels.map(x => x?.category)].map(x => clean(x, 40)).filter(Boolean))].slice(0, 30);
    if (!cats.length) cats.push('Text channels');
    C.setCategories(c, cats);
    let i = 0;
    const pending = []; // [row, type, exported config]: link / welcome / starboard / shop settings, once every id is mapped
    for (const x of cj.channels.slice(0, C.LIMITS.channels)) {
      if (!x || typeof x.cid !== 'string') continue;
      const type = C.CHANNEL_TYPES.includes(x.type) ? x.type : 'text';
      const row = C.insertChannel(c.id, { name: C.channelName(x.name) || 'channel', topic: x.topic, category: clean(x.category, 40) || cats[0], locked: !!x.locked, type, config: type === 'voice' ? { allow_call_in: !!x.config?.allow_call_in, user_limit: Math.min(Math.max(Math.trunc(Number(x.config?.user_limit) || 0), 0), 99) } : {} }, Number.isFinite(x.position) ? x.position : i);
      i++;
      chMap.set(x.cid, row);
      pending.push([row, type, x.config]);
      for (const o of Array.isArray(x.perms) ? x.perms : []) {
        const role = roleMap.get(o?.role);
        const allow = (Number(o?.allow) || 0) & CHANNEL_BITS, deny = (Number(o?.deny) || 0) & CHANNEL_BITS;
        if (role && (allow || deny)) db.run('INSERT OR REPLACE INTO channel_perms (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)', row.id, role.id, allow & ~deny, deny);
      }
    }
    let cloudlinks = 0;
    for (const [row, type, cfg] of pending) {
      if (!cfg || typeof cfg !== 'object' || type === 'voice' || type === 'text') continue;
      let conf = {};
      if (type === 'logs') { // a CloudLink bridge keeps its server / room / username (re-validated; at most 3 per community)
        conf = cfg.mode === 'cloudlink' && cloudlinks < 3 ? require('./bridge/cloudlink').importConfig(cfg) : {};
        if (conf.mode) cloudlinks++; else continue;
      }
      if (type === 'game') conf = require('./game/game').importConfig(cfg); // settings only: the Minecraft link stays on the old instance
      if (type === 'link' && /^https?:\/\/\S+$/i.test(String(cfg.url || ''))) conf = { url: String(cfg.url).slice(0, 500) };
      else if (type === 'welcome') conf = { allow_chat: !!cfg.allow_chat, join: C.cleanTemplates(cfg.join), leave: C.cleanTemplates(cfg.leave) };
      else if (type === 'starboard') conf = { watch: (Array.isArray(cfg.watch) ? cfg.watch : []).map(cid => chMap.get(String(cid))?.cid).filter(Boolean), min: Math.min(Math.max(Math.trunc(Number(cfg.min) || 3), 1), 100) };
      else if (type === 'roles') conf = { items: (Array.isArray(cfg.items) ? cfg.items : []).filter(it => roleMap.get(it?.rid)).slice(0, 25).map(it => ({ rid: roleMap.get(it.rid).rid, price: Math.min(Math.max(Math.trunc(Number(it.price) || 0), 0), 1000000), desc: clean(it.desc, 200) })) };
      db.run('UPDATE channels SET config = ? WHERE id = ?', JSON.stringify(conf), row.id);
    }
    if (!chMap.size) { const row = C.insertChannel(c.id, { name: 'general', category: cats[0], type: 'text' }, 0); chMap.set('_', row); }
    // emojis: fresh IDs also need to be remapped in custom reaction tokens.
    const emojiMap = new Map();
    for (const e of (Array.isArray(cj.emojis) ? cj.emojis : []).slice(0, C.LIMITS.emojis)) {
      const data = e && typeof e.file === 'string' ? entries[e.file] : null;
      if (!data) continue;
      try {
        const eid = 'e' + randHex(5);
        const { file, animated } = uploads.saveEmoji(Buffer.from(data), eid);
        require('./clonelock').forget();
        db.run('INSERT INTO emojis (eid, community_id, name, animated, file, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', eid, c.id, clean(e.name, 32).replace(/[^A-Za-z0-9_]/g, '_') || 'emoji', animated ? 1 : 0, file, me.id, now());
        emojiMap.set(e.eid, { eid, name: clean(e.name, 32).replace(/[^A-Za-z0-9_]/g, '_') || 'emoji', animated });
      } catch { /* skip an unusable emoji */ }
    }
    // stickers: fresh IDs too, messages that used one point at the new id
    const stickerMap = new Map();
    for (const s of (Array.isArray(cj.stickers) ? cj.stickers : []).slice(0, C.LIMITS.stickers)) {
      const data = s && typeof s.file === 'string' ? entries[s.file] : null;
      if (!data) continue;
      try {
        const tid = 't' + randHex(5);
        const { file, animated } = uploads.saveSticker(Buffer.from(data), tid);
        require('./clonelock').forget();
        db.run('INSERT INTO stickers (tid, community_id, name, animated, file, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', tid, c.id, clean(s.name, 32).replace(/[^A-Za-z0-9_]/g, '_') || 'sticker', animated ? 1 : 0, file, me.id, now());
        stickerMap.set(s.tid, tid);
      } catch { /* skip an unusable sticker */ }
    }
    // invites: the same codes and limits, so old links keep working; a code someone here already has gets a fresh one
    const report = opts.report || {};
    report.invites = [];
    for (const inv of (Array.isArray(cj.invites) ? cj.invites : []).slice(0, 50)) {
      if (inv?.expires_at && inv.expires_at <= now()) continue;
      const want = typeof inv?.code === 'string' && CODE_RE.test(inv.code) ? inv.code : null, code = want && codeFree(want) ? want : randHex(4);
      if (want && code !== want) report.invites.push({ from: want, to: code });
      db.run('INSERT INTO invites (code, community_id, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)', code, c.id, me.id, now(), inv?.expires_at || null, Number.isInteger(inv?.max_uses) ? inv.max_uses : null);
    }
    // the server's own permanent code
    const mainWant = [opts.inviteCode, cj.invite_code].find(x => typeof x === 'string' && CODE_RE.test(x));
    if (mainWant) {
      if (codeFree(mainWant)) db.run('UPDATE communities SET invite_code = ? WHERE id = ?', mainWant, c.id);
      report.invite_code = { from: mainWant, to: db.get('SELECT invite_code FROM communities WHERE id = ?', c.id).invite_code };
    }
    // bridge links, only when nobody has to prove anything (a restore, an admin moving a server for its owner): the same guilds
    // and rooms on the same channels; a guild another server here already links is left out. Webhooks are made again by the
    // bot on first use. Whether this homeserver's bot is in the guild is for the caller to check (admin-import.js)
    report.bridges = [];
    const wantBridges = Array.isArray(opts.bridges) ? opts.bridges : Array.isArray(cj.bridges) ? cj.bridges : [];
    if (opts.trusted && wantBridges.length) {
      require('./bridge/store').ensure();
      for (const b of wantBridges.slice(0, 5)) {
        const p = String(b?.platform || ''), gid = String(b?.guild_id || '');
        if (!['discord', 'fluxer', 'matrix'].includes(p) || !/^[\w.:!-]{1,64}$/.test(gid)) continue;
        if (db.get('SELECT 1 FROM bridge_guilds WHERE community_id = ? AND platform = ?', c.id, p)) continue;
        const other = p !== 'matrix' && db.get('SELECT c.sid FROM bridge_guilds bg JOIN communities c ON c.id = bg.community_id WHERE bg.platform = ? AND bg.guild_id = ?', p, gid);
        if (other) { report.bridges.push({ platform: p, guild_id: gid, linked: false, why: 'guild_already_linked', sid: other.sid }); continue; }
        const bid = Number(db.run('INSERT INTO bridge_guilds (community_id, platform, guild_id, guild_name, enabled, created_by, created_at, verified) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
          c.id, p, gid, clean(b.guild_name, 100), b.enabled === false ? 0 : 1, me.id, now()).lastInsertRowid);
        let n = 0;
        for (const l of Array.isArray(b.links) ? b.links.slice(0, 500) : []) {
          const row = chMap.get(String(l?.cid || '')), ext = String(l?.ext_channel_id || '');
          if (!row || !/^[\w.:!#-]{1,128}$/.test(ext) || db.get('SELECT 1 FROM bridge_channels bc JOIN bridge_guilds bg ON bg.id = bc.bridge_id WHERE bc.ext_channel_id = ? AND bg.platform = ?', ext, p)) continue;
          db.run('INSERT OR IGNORE INTO bridge_channels (channel_id, bridge_id, ext_channel_id, ext_name) VALUES (?, ?, ?, ?)', row.id, bid, ext, clean(l.ext_name, 100));
          n++;
        }
        report.bridges.push({ platform: p, guild_id: gid, linked: true, channels: n, ...(p === 'matrix' ? { why: 'matrix_bot_needed' } : {}) });
      }
    }

    // messages, oldest first per channel
    const idMap = new Map(); // old message id -> new id
    const replies = [];
    for (const [oldCid, ch] of chMap) {
      const file = entries[`messages/${oldCid}.jsonl`];
      if (!file) continue;
      for (const m of jsonl(file)) {
        const u = m.author ? resolve(m.author) : null;
        const nameOnly = !u && !m.system ? (m.author_name || m.author?.display_name || m.author?.username || null) : null;
        const atts = (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 10).map(a => {
          if (typeof a?.url !== 'string') return null;
          if (!a.url.startsWith('files/')) return /^https?:\/\//.test(a.url) ? a : null;
          const data = entries[a.url];
          if (!data) return null;
          const rel = `imported/${sidTag}/a/${randHex(6)}-${path.basename(a.url)}`;
          const buf = Buffer.from(data);
          uploads.writeStored(rel, buf);
          const sn = uploads.sniff(buf);
          const rec = { name: clean(a.name, 120) || path.basename(a.url), size: buf.length, mime: a.mime || 'application/octet-stream', type: ['image', 'gif', 'video', 'audio', 'file'].includes(a.type) ? a.type : (sn?.type || 'file') };
          const hash = sha256(buf);
          db.run('INSERT OR IGNORE INTO uploads (path, sha256, name, size, mime, type, width, height, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', rel, hash, rec.name, rec.size, rec.mime, rec.type, a.width || null, a.height || null, me.id, now());
          return { url: `${origin()}/uploads/${rel}`, type: rec.type, name: rec.name, size: rec.size, width: a.width || undefined, height: a.height || undefined, sha256: hash };
        }).filter(Boolean);
        const sig = m.signature && typeof m.signature.kid === 'string' && typeof m.signature.sig === 'string' ? m.signature : null;
        const created = Number(m.created_at) || now();
        const res = db.run(
          `INSERT INTO messages (channel_id, user_id, body, attachments, system, sys_kind, author_name, author_avatar, embeds, bridge, pinned_at, created_at, edited_at, sig_kid, sig_sig, sig_ts, sig_nonce, verified, sticker_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ch.id, u?.id ?? null, String(m.body ?? '').slice(0, 4000), atts.length ? JSON.stringify(atts) : null, m.system ? 1 : 0, m.sys_kind ? String(m.sys_kind).slice(0, 12) : null,
          nameOnly ? clean(nameOnly, 80) : null, nameOnly ? (m.author_avatar || m.author?.pfp || null) : null, Array.isArray(m.embeds) ? JSON.stringify(m.embeds) : null, m.bridge ? String(m.bridge).slice(0, 10) : null,
          m.pinned ? created : null, created, Number(m.edited_at) || null, sig?.kid ?? null, sig?.sig ?? null, sig ? Number(sig.ts) || 0 : null, sig ? String(sig.nonce ?? '') : null, sig ? 0 : null, stickerMap.get(m.sticker) ?? null);
        const nid = Number(res.lastInsertRowid);
        idMap.set(String(m.id), nid);
        if (u?.kind === 'bot' && m.alias && typeof m.alias === 'object') { // a bot's alias survives only when the author is still that bot
          try { const al = require('./messages').cleanAlias(u, m.alias); if (al) db.run('UPDATE messages SET alias_name = ?, alias_avatar = ? WHERE id = ?', al.name, al.avatar, nid); } catch { /* invalid alias: drop it */ }
        }
        if (m.reply_to) replies.push([nid, String(m.reply_to)]);
        for (const rx of Array.isArray(m.reactions) ? m.reactions : []) {
          if (typeof rx?.emoji !== 'string') continue;
          const oldEid = /^(?:c:)?(e[0-9a-f]{10})$/.exec(rx.emoji)?.[1] || /^<a?:\w+:(e[0-9a-f]{10})>$/.exec(rx.emoji)?.[1];
          const mapped = emojiMap.get(oldEid);
          const token = mapped ? `<${mapped.animated ? 'a' : ''}:${mapped.name}:${mapped.eid}>` : rx.emoji;
          for (const uid of (rx.users || []).slice(0, 5000)) { const ru = resolve(uid); if (ru) db.run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', nid, ru.id, token.slice(0, 64), created); }
        }
        db.run('UPDATE channels SET last_message_id = ? WHERE id = ?', nid, ch.id);
      }
    }
    for (const [nid, old] of replies) { const target = idMap.get(old); if (target) db.run('UPDATE messages SET reply_to = ? WHERE id = ?', target, nid); }
    // the importer reads everything they just imported
    for (const uid of new Set([me.id, c.owner_id])) for (const ch of chMap.values()) db.run('INSERT OR REPLACE INTO read_state (user_id, channel_id, last_read_id) SELECT ?, id, last_message_id FROM channels WHERE id = ?', uid, ch.id);

    // members: accounts of this homeserver come back with their roles (the owner and the importer are already members). Those
    // are Nookara accounts (v:) where Nookara accounts are this homeserver's (accounts mode nookara, or a homeserver that also
    // hosts Nookara identities, like nookara.cc's), and its own local accounts on a restore here. Local accounts of another
    // instance have no account here: they are left out and counted (report.members)
    const toAnnounce = [];
    const nookaraHere = nookara || config.nookaraIdentity();
    const tally = { added: 0, already: 0, skipped: [] };
    for (const m of entries['members.jsonl'] ? jsonl(entries['members.jsonl']) : []) {
      const u = resolve(m.user);
      const p = typeof m.user?.id === 'string' ? m.user.id : null;
      const ours = u && ((u.kind === KIND_NOOKARA && nookaraHere) || (u.kind === 'local' && !nookara && sameInstance));
      if (!ours) { if (p && p !== me.principal) tally.skipped.push({ id: p, username: clean(m.user?.username, 64) || null, why: p.startsWith('l:') ? 'local_account_elsewhere' : 'not_an_account_here' }); continue; }
      if (u.id === me.id || db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', c.id, u.id)) { tally.already++; continue; }
      if (C.memberCount(c.id) >= C.LIMITS.members) { tally.skipped.push({ id: p, username: u.username, why: 'member_cap' }); continue; }
      tally.added++;
      C.addMember(c, u.id, { quiet: true, announce: false });
      db.run('UPDATE members SET joined_at = ? WHERE community_id = ? AND user_id = ?', Number(m.joined_at) || now(), c.id, u.id);
      for (const rid of Array.isArray(m.roles) ? m.roles : []) { const r = roleMap.get(rid); if (r && !r.is_default) db.run('INSERT OR IGNORE INTO member_roles (community_id, user_id, role_id) VALUES (?, ?, ?)', c.id, u.id, r.id); }
      toAnnounce.push(u.id);
    }
    if (opts.report) opts.report.members = tally;
    setImmediate(() => { const fresh = db.get('SELECT * FROM communities WHERE id = ?', c.id); if (!fresh) return; const snap = C.snapOf(fresh); for (const uid of toAnnounce) require('./gateway').pushToUser(uid, { type: 'chat_server_added', server: C.serverView(fresh, snap, auth.userById(uid)) }); });
    return db.get('SELECT * FROM communities WHERE id = ?', c.id);
  });
  require('./bridge/cloudlink').channelsChanged(); // imported CloudLink bridge channels connect now
  return result;
}

// EMBER_IMPORT_ON_BOOT=<zip>: a restored backup (PROTOCOL §19.6). Imported once, on a boot where the homeserver has no server yet,
// owned by the instance owner; the file is deleted afterwards.
function importOnBoot() {
  const file = env('IMPORT_ON_BOOT');
  if (!file) return null;
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[import]', ...a);
  try {
    if (!fs.existsSync(file)) return null;
    if (db.get("SELECT 1 AS x FROM communities WHERE kind = 'server' LIMIT 1")) { log('the instance already has a community, ignoring', file); return null; }
    const owner = auth.ownerRow();
    if (!owner) { log('no owner yet, cannot import'); return null; }
    const c = importCommunity(owner, fs.readFileSync(file));
    try { fs.unlinkSync(file); } catch { /* read-only mount */ }
    log(`restored "${c.name}" from backup`);
    return c;
  } catch (e) { console.error('[import] boot import failed:', e.code || e.message); return null; }
}
// every server as an export zip, for the host's backups (src/cli.js): [{ sid, slug, name, zip }]. Empty = nothing to back up
function exportForBackup() {
  return db.all("SELECT * FROM communities WHERE kind = 'server' ORDER BY id").map(c => ({ sid: c.sid, slug: c.slug, name: c.name, zip: exportCommunity(c.sid, auth.userById(c.owner_id)) }));
}

module.exports = { readExport, exportCommunity, importCommunity, importOnBoot, exportForBackup, FORMAT };
