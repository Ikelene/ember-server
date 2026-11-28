'use strict';
// Signed messages that moved here (import, PROTOCOL §8 "Moved messages"). A signature names the instance, server, channel,
// message ids and the exact body it was made for; after a move all of those are different here, so it can only be checked
// against what was signed then. The import keeps that payload (messages.sig_orig) and checks it, without the clock-skew rule
// (a signature from last year is still the author's). Clients get it as signature.signed and can check it themselves.
const db = require('./db');
const signing = require('./signing');
const { nookaraIdOf } = require('./compat');
const { normalizeOrigin } = require('./util');

const nookaraIdOfAuthor = a => {
  const id = nookaraIdOf(a || {});
  if (id != null && /^[1-9]\d{0,19}$/.test(String(id))) return String(id);
  const m = /^v:([1-9]\d{0,19})$/.exec(String(a?.id || ''));
  return m ? m[1] : null;
};
const sigOf = m => (m?.signature && typeof m.signature.kid === 'string' && typeof m.signature.sig === 'string' ? m.signature : null);

// the origins an exported message may have been signed under: the export's source, then the old instance's earlier addresses
// (manifest.previous_urls), then any the importer names
const originsOf = (source, more = []) => [...new Set([source, ...(Array.isArray(more) ? more : [])].map(o => (typeof o === 'string' ? normalizeOrigin(o) : null)).filter(Boolean))];

// the payloads the exported message `m` may have been signed as, likeliest first. ctx: { source (the old origin), origins
// (earlier / extra origins), community (the old sid), channel (the old cid) }. An export of a message that had already moved
// carries its payload (signature.signed). -> { cands, why? } (why: nothing to check against)
function candidates(m, ctx) {
  const sig = sigOf(m);
  if (!sig) return { cands: [], why: 'unsigned' };
  if (sig.signed && typeof sig.signed === 'object' && !Array.isArray(sig.signed)) return { cands: [sig.signed] };
  const author = nookaraIdOfAuthor(m.author);
  if (!author) return { cands: [], why: 'no_nookara_author' };
  let attachments;
  try { attachments = signing.attachmentRefs(Array.isArray(m.attachments) ? m.attachments : []); } catch { return { cands: [], why: 'attachment_without_hash' }; }
  const edits = m.edited_at ? [String(m.id), null] : [null, String(m.id)]; // (an edit signs edit_of = the message's own id)
  const replies = m.reply_to == null ? [null] : [String(m.reply_to), null]; // (a reply whose target was not found when it was sent signed reply_to null)
  const cands = [];
  for (const instance of originsOf(ctx.source, ctx.origins)) for (const edit_of of edits) for (const reply_to of replies) for (const iss of signing.issuers()) {
    cands.push(signing.buildPayload({
      iss, instance, community: ctx.community, channel: ctx.channel, author,
      ts: sig.ts, nonce: sig.nonce, body: String(m.body ?? ''), attachments, reply_to, edit_of, sticker: m.sticker ?? null,
    }));
  }
  return { cands };
}

// -> { payload, verified: 1 | 0 | null (the key could not be fetched), reason }
async function check(cands, sig) {
  let unknown = false, reason = 'bad_signature';
  for (const payload of cands) {
    const res = await signing.verify({ payload, signature: sig, nookaraId: payload.author, skew: false });
    if (res.ok) return { payload, verified: 1, reason: null };
    if (res.reason === 'key_unavailable') unknown = true;
    if (res.reason !== 'bad_signature') reason = res.reason;
    if (res.reason !== 'bad_signature' && res.reason !== 'key_unavailable') break; // (an unknown / wrong / revoked key is the same for every candidate)
  }
  return { payload: cands[0], verified: unknown ? null : 0, reason };
}

// what a message that did not verify looks like (to tell why a server's signatures fail)
const traitsOf = m => [m.edited_at && 'edited', m.reply_to != null && 'reply', Array.isArray(m.attachments) && m.attachments.length && 'attachments',
  Array.isArray(m.attachments) && m.attachments.some(a => /klipy\.com\//i.test(a?.url || '')) && 'klipy', m.sticker && 'sticker', String(m.body ?? '').length > 4000 && 'long_body',
  /\r/.test(String(m.body ?? '')) && 'cr_in_body', !String(m.body ?? '').trim() && 'empty_body'].filter(Boolean);

// jobs: [{ id (message here), sig, cands, why?, m? (the exported message) }] -> { checked, verified, failed, unknown, skipped,
// failed_reasons, failed_traits, failed_samples, origins (the origins that verified) }. Each row keeps the payload that verified
// (else the likeliest); a message edited meanwhile (another signature) is left alone
async function verifyAll(jobs) {
  const out = { checked: 0, verified: 0, failed: 0, unknown: 0, skipped: 0, failed_reasons: {}, failed_traits: {}, failed_samples: [], origins: [] };
  const origins = new Set();
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  for (const j of jobs) {
    if (!j.cands.length) { out.skipped++; bump(out.failed_reasons, j.why || 'no_candidates'); continue; }
    const r = await check(j.cands, j.sig);
    db.run('UPDATE messages SET sig_orig = ?, verified = ? WHERE id = ? AND sig_sig = ?', JSON.stringify(r.payload), r.verified, j.id, j.sig.sig);
    out.checked++;
    if (r.verified === 1) { out.verified++; if (r.payload.instance) origins.add(r.payload.instance); continue; }
    if (r.verified === 0) out.failed++; else out.unknown++;
    bump(out.failed_reasons, r.reason);
    const traits = j.m ? traitsOf(j.m) : [];
    for (const t of traits) bump(out.failed_traits, t);
    if (out.failed_samples.length < 20) out.failed_samples.push({ id: String(j.id), old_id: j.m?.id ?? null, kid: j.sig.kid, ts: Number(j.sig.ts), author: r.payload?.author ?? null, iss_tried: [...new Set(j.cands.map(c => c.iss))], reason: r.reason, traits });
  }
  out.origins = [...origins];
  return out;
}

// the view's signature: the stored one, plus what was signed when the message was signed somewhere else
function view(r) {
  if (!r.sig_kid) return null;
  const s = { kid: r.sig_kid, sig: r.sig_sig, ts: r.sig_ts, nonce: r.sig_nonce };
  if (r.sig_orig) { try { const signed = JSON.parse(r.sig_orig); s.signed = signed; s.moved_from = signed.instance || null; } catch { /* unreadable: as unsigned-here */ } }
  return s;
}

const jsonl = u8 => require('fflate').strFromU8(u8).split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// the signed messages of an export into server `c` imported from it before sig_orig existed: each found by its signature
// (sig_sig + nonce); extra: more origins to try -> { matched, missing, ...verifyAll's }
async function backfill(c, { entries, manifest }, extra = []) {
  const find = db.raw().prepare('SELECT m.id FROM messages m JOIN channels ch ON ch.id = m.channel_id WHERE ch.community_id = ? AND m.sig_sig = ? AND m.sig_nonce = ? LIMIT 1');
  const jobs = [];
  let missing = 0;
  for (const key of Object.keys(entries).filter(k => /^messages\/[^/]+\.jsonl$/.test(k))) {
    const channel = key.slice('messages/'.length, -'.jsonl'.length);
    for (const m of jsonl(entries[key])) {
      const sig = sigOf(m);
      if (!sig) continue;
      const row = find.get(c.id, sig.sig, String(sig.nonce ?? ''));
      if (!row) { missing++; continue; }
      const { cands, why } = candidates(m, { source: manifest.source, origins: [...(Array.isArray(manifest.previous_urls) ? manifest.previous_urls : []), ...extra], community: manifest.community, channel });
      jobs.push({ id: row.id, sig, cands, why, m });
    }
  }
  return { matched: jobs.length, missing, ...(await verifyAll(jobs)) };
}

module.exports = { candidates, check, verifyAll, view, backfill, originsOf };
