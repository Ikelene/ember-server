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

// the payloads the exported message `m` may have been signed as, likeliest first. ctx: { source (the old origin), community
// (the old sid), channel (the old cid) }. An export of a message that had already moved carries its payload (signature.signed).
function candidates(m, ctx) {
  const sig = sigOf(m);
  if (!sig) return [];
  if (sig.signed && typeof sig.signed === 'object' && !Array.isArray(sig.signed)) return [sig.signed];
  const author = nookaraIdOfAuthor(m.author);
  if (!author) return [];
  let attachments;
  try { attachments = signing.attachmentRefs(Array.isArray(m.attachments) ? m.attachments : []); } catch { attachments = null; }
  if (!attachments) return [];
  const edits = m.edited_at ? [String(m.id), null] : [null, String(m.id)]; // (an edit signs edit_of = the message's own id)
  const out = [];
  for (const edit_of of edits) for (const iss of signing.issuers()) {
    out.push(signing.buildPayload({
      iss, instance: normalizeOrigin(ctx.source), community: ctx.community, channel: ctx.channel, author,
      ts: sig.ts, nonce: sig.nonce, body: String(m.body ?? ''), attachments, reply_to: m.reply_to ?? null, edit_of, sticker: m.sticker ?? null,
    }));
  }
  return out;
}

// -> { payload, verified: 1 | 0 | null (the key could not be fetched) }
async function check(cands, sig) {
  let unknown = false;
  for (const payload of cands) {
    const res = await signing.verify({ payload, signature: sig, nookaraId: payload.author, skew: false });
    if (res.ok) return { payload, verified: 1 };
    if (res.reason === 'key_unavailable') unknown = true;
    if (res.reason !== 'bad_signature' && res.reason !== 'key_unavailable') break; // (an unknown / wrong / revoked key is the same for every candidate)
  }
  return { payload: cands[0], verified: unknown ? null : 0 };
}

// jobs: [{ id (message here), sig, cands }] -> { checked, verified, failed, unknown }. Each row keeps the payload that verified
// (else the likeliest); a message edited meanwhile (another signature) is left alone
async function verifyAll(jobs) {
  const out = { checked: 0, verified: 0, failed: 0, unknown: 0 };
  for (const j of jobs) {
    if (!j.cands.length) continue;
    const r = await check(j.cands, j.sig);
    db.run('UPDATE messages SET sig_orig = ?, verified = ? WHERE id = ? AND sig_sig = ?', JSON.stringify(r.payload), r.verified, j.id, j.sig.sig);
    out.checked++;
    if (r.verified === 1) out.verified++; else if (r.verified === 0) out.failed++; else out.unknown++;
  }
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
// (sig_sig + nonce) -> { matched, missing, checked, verified, failed, unknown }
async function backfill(c, { entries, manifest }) {
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
      jobs.push({ id: row.id, sig, cands: candidates(m, { source: manifest.source, community: manifest.community, channel }) });
    }
  }
  return { matched: jobs.length, missing, ...(await verifyAll(jobs)) };
}

module.exports = { candidates, check, verifyAll, view, backfill };
