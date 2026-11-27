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
const { err, normalizeOrigin } = require('./util');

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
    const report = {};
    const c = exp.importCommunity(owner, buffer, null, { trusted: true, slug, inviteCode: typeof req.query.invite_code === 'string' ? req.query.invite_code : undefined, bridges, report });
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
    return { sid: c.sid, slug: c.slug, address: C.addressOf(c), owner: owner.principal, invite_code: report.invite_code || null, invites: report.invites || [], bridges: bridgesOut };
  });
}

module.exports = { register, importedOrigins };
