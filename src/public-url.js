'use strict';
// The instance's public address changed (e.g. a Nookara-hosted server moved from <slug>-bonfire.ikelene.net to e_<slug>.nookara.cc):
// uploads, icons, emojis, embeds and attachments are stored as absolute urls on the old origin. The host keeps redirecting the old
// origin only for a while, so on the first boot with a new BONFIRE_PUBLIC_URL every stored copy of the old origin is rewritten
// (plain, as a JSON string and percent-encoded), in the database and in config.json. meta.public_url remembers the last origin;
// meta.public_url_history keeps the earlier ones.
const config = require('./config');
const db = require('./db');
const { normalizeOrigin, log } = require('./util');

const likeEscape = s => s.replace(/[\\%_]/g, m => '\\' + m);

// tables and TEXT-ish columns that may hold a url (FTS virtual tables and their shadow tables are skipped: triggers keep them in step)
function textColumns() {
  const tables = db.all("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  const virtual = tables.filter(t => /^CREATE VIRTUAL/i.test(t.sql || '')).map(t => t.name);
  const out = [];
  for (const t of tables) {
    if (virtual.includes(t.name) || virtual.some(v => t.name.startsWith(v + '_'))) continue;
    const cols = db.all(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`);
    const signed = cols.some(c => c.name === 'sig_sig');
    for (const c of cols) {
      const type = String(c.type || '').toUpperCase();
      // a signed message's body is covered by its signature: it stays exactly as the author wrote it
      if (type === '' || /TEXT|CHAR|CLOB|JSON/.test(type)) out.push([t.name, c.name, signed && c.name === 'body' ? ' AND sig_sig IS NULL' : '']);
    }
  }
  return out;
}

// -> { from, to, rows } when something was rewritten, else null
function rewrite(from, to) {
  const pairs = [[from + '/', to + '/'], [JSON.stringify(from), JSON.stringify(to)], [encodeURIComponent(from), encodeURIComponent(to)]];
  let rows = 0;
  db.tx(() => {
    for (const [t, c, extra] of textColumns()) {
      const q = `"${t.replace(/"/g, '""')}"`, col = `"${c.replace(/"/g, '""')}"`;
      // whole-value matches (a stored origin on its own), then the url / JSON / encoded forms inside longer values
      rows += db.run(`UPDATE ${q} SET ${col} = ? WHERE ${col} = ?${extra}`, to, from).changes;
      for (const [a, b] of pairs) rows += db.run(`UPDATE ${q} SET ${col} = REPLACE(${col}, ?, ?) WHERE ${col} LIKE ? ESCAPE '\\'${extra}`, a, b, '%' + likeEscape(a) + '%').changes;
    }
  });
  return rows;
}

function rewriteConfig(from, to) {
  const v = config.get();
  const patch = {};
  for (const k of ['icon_url', 'banner_url']) if (typeof v[k] === 'string' && (v[k] === from || v[k].startsWith(from + '/'))) patch[k] = to + v[k].slice(from.length);
  if (Object.keys(patch).length) config.update(patch);
  return Object.keys(patch);
}

// call after db.open() and before anything reads stored urls
function checkPublicUrl() {
  const cur = normalizeOrigin(config.publicUrl());
  if (!cur) return null;
  const last = db.metaGet('public_url');
  if (!last) { db.metaSet('public_url', cur); return null; } // first boot (or first boot of this version): nothing to compare yet
  if (last === cur) return null;
  const rows = rewrite(last, cur);
  let cfg = [];
  try { cfg = rewriteConfig(last, cur); } catch (e) { log(`[public-url] config.json not rewritten: ${e.message}`); }
  let hist = [];
  try { hist = JSON.parse(db.metaGet('public_url_history') || '[]'); } catch { /* reset */ }
  hist = [...hist.filter(h => h !== last && h !== cur), last].slice(-10);
  db.metaSet('public_url_history', JSON.stringify(hist));
  db.metaSet('public_url', cur);
  log(`public url changed: ${last} -> ${cur} (${rows} stored value(s)${cfg.length ? ` + config.json ${cfg.join(', ')}` : ''} rewritten)`);
  return { from: last, to: cur, rows, config: cfg };
}

// earlier origins, newest first (signatures of messages sent before a move name the old instance origin: clients try these too)
function previousUrls() { try { const h = JSON.parse(db.metaGet('public_url_history') || '[]'); return Array.isArray(h) ? h.filter(x => typeof x === 'string').reverse() : []; } catch { return []; } }

module.exports = { checkPublicUrl, previousUrls, rewrite, textColumns };
