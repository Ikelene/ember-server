'use strict';
// Portable backups, one server at a time; deliberately independent of Nookara relays and managed plans.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const auth = require('./auth');
const C = require('./communities');
const exp = require('./export');
const uploads = require('./uploads');
const gateway = require('./gateway');
const { err, randHex, now, clean } = require('./util');
const dir = () => path.join(config.dir(), 'backups');
// a backup belongs to one server (community_id); its row outlives the server, so a deleted server can come back from it
const sidOf = id => (id ? db.get('SELECT sid FROM communities WHERE id = ?', id)?.sid ?? null : null);
const view = r => ({ id: r.id, sid: sidOf(r.community_id), created_at: r.created_at, size: r.size, by: r.by_principal, note: r.note });
const ORDER = 'ORDER BY created_at DESC, rowid DESC';
const list = c => (c ? db.all(`SELECT * FROM instance_backups WHERE community_id = ? ${ORDER}`, c.id) : db.all(`SELECT * FROM instance_backups ${ORDER}`));
const file = id => path.join(dir(), id + '.zip');
function find(id) {
  if (!/^[a-f0-9]{32}$/.test(id || '')) throw err('backup_not_found', 404);
  const r = db.get('SELECT * FROM instance_backups WHERE id = ?', id);
  if (!r || !fs.existsSync(file(id))) throw err('backup_not_found', 404);
  return r;
}
function remove(r) {
  fs.rmSync(file(r.id), { force: true });
  db.run('DELETE FROM instance_backups WHERE id = ?', r.id);
}
// max_backups counts per server
function prune() {
  const max = config.get().max_backups;
  for (const g of db.all('SELECT DISTINCT community_id FROM instance_backups')) {
    const rows = g.community_id === null ? db.all(`SELECT * FROM instance_backups WHERE community_id IS NULL ${ORDER}`) : db.all(`SELECT * FROM instance_backups WHERE community_id = ? ${ORDER}`, g.community_id);
    for (const r of rows.slice(max)) remove(r);
  }
}
function create(me, c, note = '') {
  if (typeof note !== 'string' || note.length > 300) throw err('invalid_note');
  if (!c) throw err('no_community', 409);
  const zip = exp.exportCommunity(c.sid, auth.userById(c.owner_id));
  const r = { id: randHex(16), community_id: c.id, created_at: now(), size: zip.length, by_principal: me.principal, note: clean(note, 300) };
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file(r.id) + '.tmp', zip, { mode: 0o600 });
    fs.renameSync(file(r.id) + '.tmp', file(r.id));
    db.run('INSERT INTO instance_backups (id, community_id, created_at, size, by_principal, note) VALUES (?, ?, ?, ?, ?, ?)', r.id, r.community_id, r.created_at, r.size, r.by_principal, r.note);
  } catch (e) { fs.rmSync(file(r.id) + '.tmp', { force: true }); fs.rmSync(file(r.id), { force: true }); throw e; }
  prune();
  return view(r);
}
// Replaces `current` (one server; every other server is left alone) with the export in `buffer`. The restored server keeps its
// owner, slug and backups; without a `current` the export comes back as a new server owned by whoever restores it.
function restore(me, buffer, current) {
  const parsed = exp.readExport(buffer); // validate before changing anything
  if (current) create(me, current, 'before restore');
  const afterCommit = [];
  const c = db.tx(() => {
    const owner = (current && auth.userById(current.owner_id)) || me;
    if (current) C.deleteCommunity(current.sid, me, { afterCommit });
    const made = exp.importCommunity(owner, buffer, parsed, { trusted: true, slug: current?.slug });
    if (current) db.run('UPDATE instance_backups SET community_id = ? WHERE community_id = ?', made.id, current.id);
    return made;
  });
  afterCommit.forEach(fn => fn());
  // the people of that server refresh memberships, roles and channels on reconnect; everyone else stays connected
  gateway.closeUsers(db.all('SELECT user_id FROM members WHERE community_id = ?', c.id).map(m => m.user_id), 4010, 'community restored', { type: 'instance_restarting' });
  return { ok: true, sid: c.sid };
}
// ?sid= / body sid, else the only server (400 sid_required with several); null when there is none
const target = req => C.pickCommunity(req.body?.sid ?? req.query?.sid);
function register(app) {
  const base = '/api/v1/instance/backups';
  app.get(base, { admin: true }, req => ({ backups: list(target(req)).map(view) }));
  app.post(base, { admin: true }, req => ({ backup: create(req.user, target(req), req.body?.note) }));
  app.get(base + '/:id/download', { admin: true }, (req, res) => {
    const r = find(req.params.id);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${r.id}.zip"`, 'Content-Length': r.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(file(r.id)).on('error', () => res.destroy()).pipe(res);
  });
  app.delete(base + '/:id', { admin: true }, req => { remove(find(req.params.id)); return { ok: true }; });
  // a stored backup goes back over the server it was taken from (or the `sid` given); a server deleted since comes back as a new one
  app.post(base + '/:id/restore', { owner: true }, req => {
    const r = find(req.params.id), sid = req.body?.sid ?? req.query?.sid;
    const current = sid ? C.findCommunity(sid) : r.community_id ? db.get('SELECT * FROM communities WHERE id = ?', r.community_id) || null : null;
    return restore(req.user, fs.readFileSync(file(r.id)), current);
  });
  app.post('/api/v1/instance/restore', { owner: true }, async req => {
    const current = target(req); // (before reading the upload: 400 sid_required)
    const { buffer } = await uploads.readMultipart(req, { maxBytes: 500 * 1024 * 1024 });
    if (!buffer?.length) throw err('no_file');
    return restore(req.user, buffer, current);
  });
}
module.exports = { register, create, restore, prune };
