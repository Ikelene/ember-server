'use strict';
// Asking for a server (PROTOCOL §5a, creation mode `request`): someone who may not create one asks with the name, address
// and description it would have; a homeserver admin approves it (the server is made then, owned by whoever asked) or rejects
// it. Admins hear of each request on the gateway (`homeserver_pending`, kind `server`) and, with a Nookara account, in their
// Nookara inbox (registration.js notice, `server_request`); whoever asked hears the answer on the gateway
// (`server_request_update`).
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const C = require('./communities');
const SLUG = require('./slug');
const { err, now, clean } = require('./util');

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const view = r => ({
  id: r.id, name: r.name, slug: r.slug || null, description: r.description || '', note: r.note || '', status: r.status, reason: r.reason || null,
  created_at: r.created_at, decided_at: r.decided_at || null, sid: r.sid || null,
  ...(r.username !== undefined ? { account: { id: r.principal, username: r.username, display_name: r.display_name } } : {}),
});
const requestUrl = () => `${config.publicUrl()}/api/v2/server-requests`;

// may this account ask? (creation mode `request`, not a bot, under its per_account cap with what it already asked for)
function assertMayAsk(me) {
  if (!me || me.kind === 'bot') throw err('forbidden', 403);
  if (config.get().creation.mode !== 'request') throw err('requests_not_used', 400, { mode: config.get().creation.mode });
  if (!auth.claimed()) throw err('instance_not_claimed', 409);
  if (db.get("SELECT 1 FROM server_requests WHERE user_id = ? AND status = 'pending'", me.id)) throw err('request_pending', 409);
  const cap = config.get().creation.per_account;
  if (cap !== null && !auth.isAdmin(me)) {
    const used = db.get("SELECT COUNT(*) AS n FROM communities WHERE kind = 'server' AND owner_id = ?", me.id).n;
    if (used >= cap) throw err('creation_limit', 403, { limit: cap, used });
  }
}
// POST /api/v2/server-requests { name, slug?, description?, note? }
function ask(me, b = {}) {
  assertMayAsk(me);
  const name = clean(b.name, 60);
  if (!name) throw err('name_required');
  let slug = null;
  if (b.slug !== undefined && b.slug !== null && b.slug !== '') {
    slug = String(b.slug).trim().toLowerCase();
    if (!SLUG.valid(slug)) throw err('invalid_slug');
    if (db.get('SELECT 1 FROM communities WHERE slug = ?', slug) || db.get("SELECT 1 FROM server_requests WHERE slug = ? AND status = 'pending'", slug)) throw err('slug_taken', 409);
  }
  if (b.note != null && (typeof b.note !== 'string' || b.note.length > 500)) throw err('invalid_note');
  const id = db.run("INSERT INTO server_requests (user_id, name, slug, description, note, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    me.id, name, slug, clean(b.description, 300), String(b.note || '').trim(), now()).lastInsertRowid;
  const r = row(id);
  try { require('./gateway').pushToAdmins({ type: 'homeserver_pending', kind: 'server', request: r }); } catch { /* no gateway */ }
  require('./registration').notice('server_request', name);
  return { request: r };
}
const row = id => { const r = db.get('SELECT s.*, u.principal, u.username, u.display_name FROM server_requests s JOIN users u ON u.id = s.user_id WHERE s.id = ?', Number(id)); return r ? view(r) : null; };
const mine = me => ({ requests: db.all('SELECT * FROM server_requests WHERE user_id = ? ORDER BY id DESC LIMIT 50', me.id).map(view), request_url: requestUrl() });
function cancel(me, id) {
  if (!db.run("UPDATE server_requests SET status = 'cancelled', decided_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'", now(), Number(id), me.id).changes) throw err('request_not_found', 404);
  return mine(me);
}

// ---------- admins ----------
function list(q = {}) {
  const status = STATUSES.includes(q.status) ? q.status : 'pending';
  return { requests: db.all('SELECT s.*, u.principal, u.username, u.display_name FROM server_requests s JOIN users u ON u.id = s.user_id WHERE s.status = ? ORDER BY s.id DESC LIMIT 200', status).map(view) };
}
function pending(id) {
  const r = db.get("SELECT * FROM server_requests WHERE id = ? AND status = 'pending'", Number(id));
  if (!r) throw err('request_not_found', 404);
  return r;
}
const tell = (userId, r) => { try { require('./gateway').pushToUser(userId, { type: 'server_request_update', request: r }); } catch { /* no gateway */ } };
// the server is made now, as asked, owned by whoever asked (a slug taken since then: one is made from the name)
function approve(admin, id, b = {}) {
  const r = pending(id), owner = auth.userById(r.user_id);
  if (!owner || owner.banned) throw err('user_not_found', 404);
  const slug = r.slug && !db.get('SELECT 1 FROM communities WHERE slug = ?', r.slug) ? r.slug : undefined;
  const c = C.createCommunity(owner, { name: b.name ? clean(b.name, 60) || r.name : r.name, slug, description: r.description }, { trusted: true });
  db.run("UPDATE server_requests SET status = 'approved', decided_at = ?, decided_by = ?, sid = ? WHERE id = ?", now(), admin.id, c.sid, r.id);
  const out = row(r.id);
  tell(r.user_id, out);
  return { request: out };
}
function reject(admin, id, b = {}) {
  const r = pending(id);
  if (b.reason != null && (typeof b.reason !== 'string' || b.reason.length > 300)) throw err('invalid_reason');
  db.run("UPDATE server_requests SET status = 'rejected', decided_at = ?, decided_by = ?, reason = ? WHERE id = ?", now(), admin.id, String(b.reason || '').trim() || null, r.id);
  const out = row(r.id);
  tell(r.user_id, out);
  return { request: out };
}

function register(app) {
  app.get('/api/v2/server-requests', req => mine(req.user));
  app.post('/api/v2/server-requests', req => ask(req.user, req.body || {}));
  app.delete('/api/v2/server-requests/:id', req => cancel(req.user, req.params.id));
  app.get('/api/v2/homeserver/server-requests', { admin: true }, req => list(req.query));
  app.post('/api/v2/homeserver/server-requests/:id/approve', { admin: true }, req => approve(req.user, req.params.id, req.body || {}));
  app.post('/api/v2/homeserver/server-requests/:id/reject', { admin: true }, req => reject(req.user, req.params.id, req.body || {}));
}

module.exports = { register, ask, mine, cancel, list, approve, reject, requestUrl };
