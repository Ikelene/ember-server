'use strict';
// Reported DM messages (PROTOCOL §4d). A DM is end-to-end encrypted, so a report is made by the reporter's client: it
// hands over the sealed message and the one key that opens it. It goes to whoever manages the SENDER's account: this
// homeserver for the accounts hosted here. Nothing readable is stored: the envelope and its key are kept for the
// homeserver's admins, whose client opens that one message. Before anything is kept the report is checked: the envelope
// was signed by a key of the sender (so nobody can report words the sender never sent) and the key really opens it.
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const { err, now, clean, limiter } = require('../util');
const R = require('../federation/rules');
const resolve = require('../federation/resolve');
const limits = require('../federation/limits');
const people = require('./people');
const where = require('./where');
const keys = require('./keys');
const E = require('./e2ee');

const REASONS = ['harassment', 'spam', 'child_safety', 'nsfw', 'threats', 'other']; // the ones Nookara's DM reports take
const STATUSES = ['open', 'resolved', 'dismissed'];
const MAX_CONTEXT = 15;
const NOOKARA_REPORT_PATH = '/api/report/dm-message';
const perReporter = limiter(10, 3600 * 1000);
const ID = /^[A-Za-z0-9._:-]{1,64}$/;
const json = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

// "<sid>@<host domain>" -> the same with the domain in lower case, or null
function dmId(raw) {
  const m = /^([A-Za-z0-9._:-]{1,64})@([A-Za-z0-9.-]{1,253})$/.exec(String(raw ?? ''));
  return m && R.isDomain(m[2].toLowerCase()) ? `${m[1]}@${m[2].toLowerCase()}` : null;
}
const stableId = raw => { const w = R.parseSub(String(raw ?? '')); return w ? `${w.id}@${w.domain}` : null; };
// the sender, an account hosted here whose keys are here. Anyone else is reported where their account is managed
async function senderOf(raw) {
  const w = R.parseSub(String(raw ?? ''));
  if (!w) throw err('invalid_request', 400, { field: 'message.from' });
  if (w.domain !== config.domain()) {
    let api = null;
    try { api = (await resolve.homeserver(w.domain)).api_url; } catch { /* unknown homeserver */ }
    if (!api) throw err('sender_not_here', 400);
    throw err('report_elsewhere', 409, { url: api.replace(/\/+$/, '') + '/social/reports' });
  }
  const u = auth.userByPrincipal(w.id);
  if (!auth.hostedHere(u)) throw err('user_not_found', 404);
  // a Nookara account: Nookara's own report API takes it (config social.api_url says where Nookara is)
  if (where.apiElsewhere(u)) { const api = where.urls().api_url; throw err('report_elsewhere', 409, { url: new URL(api).origin + NOOKARA_REPORT_PATH, api_url: api }); }
  return u;
}

// POST /api/v2/social/reports { message: { dm, id, from, envelope }, revealed_key, reason, details?, context? }
async function create(me, body = {}) {
  const m = body.message || {}, dm = dmId(m.dm), reporter = people.fullId(me);
  if (!dm || !ID.test(String(m.id ?? ''))) throw err('invalid_request', 400, { field: 'message' });
  if (!REASONS.includes(body.reason)) throw err('invalid_reason', 400, { reasons: REASONS });
  const sender = await senderOf(m.from), from = people.fullId(sender), id = String(m.id);
  if (from === reporter) throw err('cannot_report_self', 400);
  if (!perReporter.hit(reporter)) throw err('rate_limited', 429);
  if (me.kind === 'remote') limits.hit(me.domain, 'reports'); // and per homeserver: 429 homeserver_rate_limited
  const env = E.checkEnvelope(m.envelope);
  const sig = E.signatureStatus(env, keys.localKeys(sender), dm, from, id);
  if (sig.status !== 'valid') throw err('bad_signature', 400, { signature: sig.status });
  if (!E.openRevealed(env, body.revealed_key, dm, from)) throw err('bad_revealed_key', 400);
  // the messages around it, each with its own key: kept only when the key opens them
  const context = [];
  if (body.context !== undefined && !Array.isArray(body.context)) throw err('bad_context', 400);
  for (const x of (body.context || []).slice(0, MAX_CONTEXT)) {
    const xf = stableId(x?.from);
    if (!xf || !ID.test(String(x.id ?? ''))) throw err('bad_context', 400);
    let xe; try { xe = E.checkEnvelope(x.envelope); } catch { throw err('bad_context', 400, { id: String(x.id) }); }
    if (!E.openRevealed(xe, x.revealed_key, dm, xf)) throw err('bad_context', 400, { id: String(x.id) });
    const p = people.parseId(xf), mine = p?.local && !where.apiElsewhere(p.user);
    context.push({ id: String(x.id), from: xf, envelope: xe, revealed_key: x.revealed_key, signature: mine ? E.signatureStatus(xe, keys.localKeys(p.user), dm, xf, String(x.id)).status : 'unchecked' });
  }
  const had = db.get('SELECT id FROM dm_reports WHERE reporter = ? AND dm = ? AND message_id = ?', reporter, dm, id);
  if (had) return { ok: true, id: String(had.id), duplicate: true };
  const t = now();
  const r = db.run('INSERT INTO dm_reports (reporter, sender_id, sender, dm, message_id, envelope, revealed_key, edit_of, reason, details, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    reporter, sender.id, from, dm, id, JSON.stringify(env), body.revealed_key, sig.edit_of, body.reason, clean(body.details, 1000), context.length ? JSON.stringify(context) : null, t, t);
  return { ok: true, id: String(r.lastInsertRowid) };
}

// ---------- the homeserver's admins ----------
// envelope + revealed_key: the admin's client opens the message (AES-256-GCM, AAD "nke1|2|<dm>|<from>"); nobody else's
const view = r => ({
  id: String(r.id), status: r.status, reason: r.reason, details: r.details, reporter: people.snippet(r.reporter), sender: people.snippet(r.sender),
  message: { dm: r.dm, id: r.message_id, from: r.sender, envelope: json(r.envelope, null), edit_of: r.edit_of },
  revealed_key: r.revealed_key, context: json(r.context, []), note: r.note, handled_by: r.handled_by || null, created_at: r.created_at, updated_at: r.updated_at,
});
// GET /api/v2/homeserver/reports?status=open|resolved|dismissed|all&before=&limit=
function list(q = {}) {
  const status = q.status === undefined ? 'open' : String(q.status);
  if (status !== 'all' && !STATUSES.includes(status)) throw err('invalid_status', 400, { statuses: [...STATUSES, 'all'] });
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 100), before = /^\d{1,15}$/.test(String(q.before || '')) ? Number(q.before) : null;
  const cond = [status === 'all' ? null : 'status = ?', before ? 'id < ?' : null].filter(Boolean), args = [...(status === 'all' ? [] : [status]), ...(before ? [before] : [])];
  const rows = db.all(`SELECT * FROM dm_reports ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...args, limit);
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const c of db.all('SELECT status, COUNT(*) AS n FROM dm_reports GROUP BY status')) counts[c.status] = c.n;
  return { reports: rows.map(view), counts, has_more: rows.length === limit };
}
// PATCH /api/v2/homeserver/reports/:id { status?, note? }
function patch(me, id, body = {}) {
  const r = /^\d{1,15}$/.test(String(id)) ? db.get('SELECT * FROM dm_reports WHERE id = ?', Number(id)) : null;
  if (!r) throw err('report_not_found', 404);
  if (body.status !== undefined && !STATUSES.includes(body.status)) throw err('invalid_status', 400, { statuses: STATUSES });
  if (body.note !== undefined && typeof body.note !== 'string') throw err('invalid_note', 400);
  if (body.status === undefined && body.note === undefined) throw err('invalid_request', 400);
  db.run('UPDATE dm_reports SET status = ?, note = ?, handled_by = ?, updated_at = ? WHERE id = ?', body.status ?? r.status, body.note === undefined ? r.note : body.note.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 2000), people.fullId(me), now(), r.id);
  return { report: view(db.get('SELECT * FROM dm_reports WHERE id = ?', r.id)) };
}

function register(app) {
  app.post('/api/v2/social/reports', req => create(req.user, req.body));
  app.get('/api/v2/homeserver/reports', { admin: true }, req => list(req.query));
  app.patch('/api/v2/homeserver/reports/:id', { admin: true }, req => patch(req.user, req.params.id, req.body));
}

module.exports = { register, create, list, patch, REASONS, STATUSES, _test: { perReporter } };
