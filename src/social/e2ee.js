'use strict';
// End-to-end encrypted DMs (PROTOCOL §4d), the format Nookara calls nke1: P-256 everywhere, one account key pair per
// account, held by its own clients. This homeserver never holds a private key or anything readable. Two roles:
//   home   for the accounts hosted here: their public keys and signed client list (e2ee_accounts), the keys locked with a
//          passphrase and with a recovery code (e2ee_backups: handed out only to a right guess), device link requests
//          (e2ee_links). Routes under /api/v2/social/e2ee, the same bodies as Nookara's /im/keys.
//   host   for the DMs hosted here: the shape of a sealed message (checkEnvelope) and whether it is wrapped for every
//          member's account key (coverage). messages.js stores the envelope as it is.
const crypto = require('crypto');
const db = require('../db');
const { err, now, limiter, sha256 } = require('../util');
const people = require('./people');
const gateway = () => require('../gateway');

const b64 = b => Buffer.from(b).toString('base64url');
const unb64 = s => Buffer.from(String(s), 'base64url');
const KID_RE = /^[\w-]{22}$/, B64_RE = /^[\w-]+$/, SIG_RE = /^[\w-]{86}$/, APP_RE = /^[A-Za-z0-9._:-]{0,120}$/;
const MAX_CT = 96 * 1024, MAX_WRAPS = 256, MAX_CLIENTS = 20, MAX_LIST = 200, MAX_PAST = 20;
const PASSCODE_TRIES = 10, LINK_TTL = 10 * 60 * 1000;
// the unlock secret on a homeserver is a passphrase, never a PIN: whoever runs it holds salt + auth hash and could
// try every 6-digit PIN in hours. A client says what it locked with (the server cannot see the secret), and the
// Argon2id cost it used has to be at least what Nookara's clients use
const PASSPHRASE_MIN = 12, KDF_MIN = { m: 65536, t: 3, p: 1 };

const str = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max && B64_RE.test(s);
const isPub = s => typeof s === 'string' && s.length === 87 && B64_RE.test(s) && unb64(s).length === 65 && unb64(s)[0] === 4;
const kidOf = encPub => b64(crypto.createHash('sha256').update(unb64(encPub)).digest()).slice(0, 22);
const parse = (v, d) => { try { return JSON.parse(v || 'null') ?? d; } catch { return d; } };
const SPKI_P256 = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const sigKey = raw => crypto.createPublicKey({ key: Buffer.concat([SPKI_P256, unb64(raw)]), format: 'der', type: 'spki' });
function verify(text, sigPub, sig) {
  try { return crypto.verify('sha256', Buffer.from(text), { key: sigKey(sigPub), dsaEncoding: 'ieee-p1363' }, unb64(sig)); } catch { return false; }
}
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function linkCode(encPub) {
  const h = crypto.createHash('sha256').update(unb64(encPub)).digest();
  const c = Array.from(h.subarray(0, 10), x => ALPHABET[x & 31]).join('');
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}
const hashCode = code => sha256(String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 10));
const clientsText = (owner, kid, doc) => `nke1 clients|${owner}|${kid}|${doc.seq}|${doc.list.map(c => [c.kid, c.enc_pub, c.sig_pub, encodeURIComponent(c.label || ''), c.app || '', c.added_at || 0, c.revoked_at || 0].join(',')).join(';')}`;

// ---------- sealed messages (v: 2) ----------
const aadOf = (dm, from) => Buffer.from(`nke1|2|${dm}|${from}`);
const sigText = (dm, from, editOf, enc) => `nke1 sig|2|${dm}|${from}|${editOf}|${enc.iv}|${enc.ct}|${enc.commit}`;
const commitOf = k => b64(crypto.createHmac('sha256', k).update('nke1 commit').digest());
// a message as a client sends it. Nothing here can tell what it says, only that it has the right shape.
// members: how many people are in the DM (an envelope has at most one wrap per member key: account + linked clients)
function checkEnvelope(enc, members = null) {
  if (!enc || typeof enc !== 'object' || Array.isArray(enc)) throw err('bad_envelope', 400);
  if (Number(enc.v) !== 2) throw err('bad_envelope', 400, { v: 2 });
  if (typeof enc.ct === 'string' && enc.ct.length > MAX_CT) throw err('message_too_long', 400, { max: MAX_CT });
  if (!str(enc.ct, MAX_CT) || !str(enc.iv, 24) || !str(enc.commit, 64) || !str(enc.sig, 128) || !KID_RE.test(String(enc.signer || ''))) throw err('bad_envelope', 400);
  const wraps = enc.wraps;
  if (!wraps || typeof wraps !== 'object' || Array.isArray(wraps)) throw err('bad_envelope', 400);
  const kids = Object.keys(wraps), max = Math.min(MAX_WRAPS, members ? members * (MAX_CLIENTS + 1) : MAX_WRAPS);
  if (!kids.length) throw err('bad_envelope', 400);
  if (kids.length > max) throw err('too_many_wraps', 400, { max });
  for (const k of kids) {
    const w = wraps[k];
    if (!KID_RE.test(k) || !w || typeof w !== 'object' || !str(w.e, 128) || !str(w.i, 24) || !str(w.w, 128)) throw err('bad_envelope', 400);
  }
  // only what the keys need, whatever else a client put in there
  return { v: 2, ct: enc.ct, iv: enc.iv, commit: enc.commit, sig: enc.sig, signer: enc.signer, wraps: Object.fromEntries(kids.map(k => [k, { e: wraps[k].e, i: wraps[k].i, w: wraps[k].w }])) };
}
// is the message wrapped for every member's account key? A usability check (a sender whose copy of someone's keys is
// old hears it at once), not security. -> the ids of the members it is not sealed to. Members without keys, and members
// whose keys cannot be read right now, are skipped: a sender's client holds messages until everyone has keys.
async function uncovered(enc, members) {
  const keys = require('./keys'), missing = [];
  for (const u of members) {
    const id = people.fullId(u);
    let kid = keys.accountKid(await keys.docFor(u).catch(() => null));
    if (kid && !enc.wraps[kid]) kid = keys.accountKid(await keys.docFor(u, { fresh: true }).catch(() => null)); // maybe our copy is the old one
    if (kid && !enc.wraps[kid]) missing.push(id);
  }
  return missing;
}
// a reported message: does this key open it? (the key commitment, then the ciphertext itself) -> the payload | null
function openRevealed(enc, revealed, dm, from) {
  try {
    const k = unb64(revealed);
    if (k.length !== 32 || commitOf(k) !== enc.commit) return null;
    const data = unb64(enc.ct), d = crypto.createDecipheriv('aes-256-gcm', k, unb64(enc.iv));
    if (data.length < 16) return null;
    d.setAAD(aadOf(dm, from));
    d.setAuthTag(data.subarray(data.length - 16));
    const payload = JSON.parse(Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]).toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch { return null; }
}
// was it signed by a key of its sender (the account key, a linked client, a replaced account key)? doc: the key document
// -> { status: 'valid' | 'invalid' | 'unknown', edit_of }
function signatureStatus(enc, doc, dm, from, messageId) {
  const account = (doc?.keys || []).find(k => k.kind === 'account');
  const sigPub = account?.kid === enc.signer ? account.public_key
    : (doc?.clients?.list || []).find(c => c.kid === enc.signer)?.sig_pub || (doc?.past || []).find(p => p.kid === enc.signer)?.sig_pub;
  if (!sigPub) return { status: 'unknown', edit_of: '0' };
  // an edited message is signed with its own id in it
  for (const editOf of ['0', String(messageId)]) if (verify(sigText(dm, from, editOf, enc), sigPub, enc.sig)) return { status: 'valid', edit_of: editOf };
  return { status: 'invalid', edit_of: '0' };
}

// ---------- home: the accounts hosted here ----------
const accountOf = userId => db.get('SELECT * FROM e2ee_accounts WHERE user_id = ?', userId) || null;
const clientsOf = a => { const d = parse(a?.clients_doc, null); return d && Array.isArray(d.list) ? d : { seq: 0, list: [] }; };
const tries = { publish: limiter(5, 3600e3), passcode: limiter(60, 3600e3), recovery: limiter(60, 3600e3), link: limiter(20, 3600e3) };
// accounts hosted here whose keys are kept here, signed in with one of their own clients (not through an OAuth app)
function home(req) {
  people.mine(req.user); // 400 local_accounts_only (an account of another homeserver), 409 social_elsewhere (a Nookara account: its keys are at Nookara)
  if (req.session?.app) throw err('own_clients_only', 403);
  return req.user;
}
const rules = () => ({ kinds: ['passphrase'], min_length: PASSPHRASE_MIN, argon2id: KDF_MIN });

function cleanBackup(kind, b) {
  if (!b || typeof b !== 'object') throw err('bad_backup', 400);
  if (kind === 'passcode') {
    // what the client says it locked the keys with: secret_kind "passphrase" (Nookara's `type: "password"` means the same)
    const said = String(b.secret_kind ?? b.type ?? '');
    if (said === 'pin' || b.type === 'pin') throw err('passphrase_required', 400, rules());
    if (said !== 'passphrase' && said !== 'password') throw err('passphrase_required', 400, rules());
  } else if (b.secret_kind !== undefined && b.secret_kind !== 'recovery') throw err('bad_backup', 400);
  if (!str(b.salt, 64) || !str(b.iv, 32) || !str(b.ct, 64000) || !str(b.auth, 64)) throw err('bad_backup', 400);
  let params = null;
  if (kind === 'passcode') {
    const p = { m: Number(b.params?.m), t: Number(b.params?.t), p: Number(b.params?.p) };
    if (!(p.m >= KDF_MIN.m && p.t >= KDF_MIN.t && p.p >= KDF_MIN.p) || p.m > 4194304 || p.t > 100 || p.p > 16) throw err('weak_kdf', 400, { argon2id: KDF_MIN });
    params = JSON.stringify(p);
  }
  return { kind, type: kind === 'passcode' ? 'password' : null, salt: b.salt, params, iv: b.iv, ct: b.ct, auth_hash: sha256(b.auth) };
}
function saveBackup(userId, x) {
  db.run(`INSERT INTO e2ee_backups (user_id, kind, type, salt, params, blob_iv, blob_ct, auth_hash, fails, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(user_id, kind) DO UPDATE SET type = excluded.type, salt = excluded.salt, params = excluded.params, blob_iv = excluded.blob_iv, blob_ct = excluded.blob_ct, auth_hash = excluded.auth_hash, fails = 0, updated_at = excluded.updated_at`,
  userId, x.kind, x.type, x.salt, x.params, x.iv, x.ct, x.auth_hash, now());
}
// the account's own connections, and everyone it shares a DM hosted here with: their copy of its keys is old now
function keysChanged(me) {
  const ev = { type: 'e2ee_keys_changed', id: people.fullId(me) };
  const others = db.all("SELECT DISTINCT b.user_id AS id FROM members a JOIN communities c ON c.id = a.community_id AND c.kind = 'dm' JOIN members b ON b.community_id = c.id WHERE a.user_id = ?", me.id);
  for (const id of new Set([me.id, ...others.map(r => r.id)])) gateway().pushToUser(id, ev);
}

// GET /me: do I have keys, and how are they locked
function me(req) {
  const u = home(req), id = people.fullId(u), a = accountOf(u.id);
  const who = { id, owner: id, passcode_rules: rules() };
  if (!a) return { ...who, has: false };
  const by = Object.fromEntries(db.all('SELECT kind, type, salt, params, fails FROM e2ee_backups WHERE user_id = ?', u.id).map(r => [r.kind, r]));
  return {
    ...who, has: true, kid: a.kid, enc_pub: a.enc_pub, sig_pub: a.sig_pub, clients: clientsOf(a), clients_sig: a.clients_sig || null,
    passcode: by.passcode ? { type: by.passcode.type, secret_kind: 'passphrase', salt: by.passcode.salt, params: parse(by.passcode.params, null), locked: by.passcode.fails >= PASSCODE_TRIES, tries_left: Math.max(0, PASSCODE_TRIES - by.passcode.fails) } : null,
    recovery: by.recovery ? { salt: by.recovery.salt } : null,
  };
}
// POST / { enc_pub, sig_pub, passcode: {...}, recovery: {...}, replace? }: my first keys, or new ones when everything was lost
function publish(req) {
  const u = home(req), { enc_pub, sig_pub, passcode, recovery, replace } = req.body || {};
  if (!isPub(enc_pub) || !isPub(sig_pub)) throw err('bad_key', 400);
  const p = cleanBackup('passcode', passcode), r = cleanBackup('recovery', recovery);
  const cur = accountOf(u.id);
  if (cur && replace !== true) throw err('already_has_keys', 409);
  if (!tries.publish.hit(u.id)) throw err('rate_limited', 429);
  const kid = kidOf(enc_pub), t = now();
  // the old key stays listed, public half only, so its old messages can still be checked
  const past = cur ? [...parse(cur.past, []), { kid: cur.kid, sig_pub: cur.sig_pub }].slice(-MAX_PAST) : [];
  db.tx(() => {
    db.run(`INSERT INTO e2ee_accounts (user_id, kid, enc_pub, sig_pub, clients_doc, clients_sig, past, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET kid = excluded.kid, enc_pub = excluded.enc_pub, sig_pub = excluded.sig_pub, clients_doc = NULL, clients_sig = NULL, past = excluded.past, created_at = excluded.created_at, updated_at = excluded.updated_at`,
    u.id, kid, enc_pub, sig_pub, JSON.stringify(past), t, t);
    saveBackup(u.id, p); saveBackup(u.id, r);
    db.run('DELETE FROM e2ee_links WHERE user_id = ?', u.id);
  });
  keysChanged(u);
  return { success: true, kid };
}
// POST /unlock { kind: 'passcode' | 'recovery', auth }: the locked keys, once the guess is right
function unlock(req) {
  const u = home(req), kind = req.body?.kind === 'recovery' ? 'recovery' : 'passcode', auth = req.body?.auth;
  if (!str(auth, 64)) throw err('missing_fields', 400);
  if (!tries[kind].hit(u.id)) throw err('rate_limited', 429);
  const b = db.get('SELECT blob_iv, blob_ct, auth_hash, fails FROM e2ee_backups WHERE user_id = ? AND kind = ?', u.id, kind);
  if (!b) throw err('no_backup', 404);
  if (kind === 'passcode' && b.fails >= PASSCODE_TRIES) throw err('passcode_locked', 423, { tries_left: 0 });
  const given = Buffer.from(sha256(auth)), want = Buffer.from(String(b.auth_hash));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    if (kind !== 'passcode') throw err('wrong_recovery_code', 403);
    db.run('UPDATE e2ee_backups SET fails = fails + 1 WHERE user_id = ? AND kind = ?', u.id, kind);
    const left = PASSCODE_TRIES - b.fails - 1;
    throw err(left > 0 ? 'wrong_passcode' : 'passcode_locked', left > 0 ? 403 : 423, { tries_left: Math.max(0, left) });
  }
  // the recovery code opens the passcode lock too: the count starts again
  db.run('UPDATE e2ee_backups SET fails = 0 WHERE user_id = ?', u.id);
  return { iv: b.blob_iv, ct: b.blob_ct };
}
// PUT /backup { kind, ...backup, ts, proof }: a new passphrase or recovery code. proof: only someone holding the keys can sign it
function backup(req) {
  const u = home(req), a = accountOf(u.id), body = req.body || {};
  if (!a) throw err('no_keys', 404);
  const kind = body.kind === 'recovery' ? 'recovery' : 'passcode', ts = Number(body.ts);
  if (!(Math.abs(now() - ts) < 5 * 60e3)) throw err('stale_proof', 400);
  if (!verify(`nke1 proof|backup|${people.fullId(u)}|${ts}`, a.sig_pub, body.proof)) throw err('bad_proof', 403);
  saveBackup(u.id, cleanBackup(kind, body));
  return { success: true };
}
// PUT /clients { doc: { seq, list }, sig }: my signed list of linked clients. A lower seq is refused, so nobody can quietly bring back a revoked client
function cleanClients(doc) {
  if (!doc || !Array.isArray(doc.list) || !Number.isInteger(doc.seq) || doc.seq < 0 || doc.list.length > MAX_LIST) throw err('bad_clients', 400);
  if (doc.list.filter(c => !c?.revoked_at).length > MAX_CLIENTS) throw err('too_many_clients', 400);
  return { seq: doc.seq, list: doc.list.map(c => {
    if (!c || !isPub(c.enc_pub) || !isPub(c.sig_pub) || c.kid !== kidOf(c.enc_pub)) throw err('bad_clients', 400);
    const app = String(c.app || '');
    if (!APP_RE.test(app)) throw err('bad_clients', 400); // (it is not escaped in the signed text)
    return { kid: c.kid, enc_pub: c.enc_pub, sig_pub: c.sig_pub, label: String(c.label || '').slice(0, 120), app, added_at: Number(c.added_at) || 0, revoked_at: Number(c.revoked_at) || 0 };
  }) };
}
function clients(req) {
  const u = home(req), a = accountOf(u.id);
  if (!a) throw err('no_keys', 404);
  const doc = cleanClients(req.body?.doc), sig = req.body?.sig;
  if (!SIG_RE.test(String(sig || ''))) throw err('bad_clients', 400);
  const cur = clientsOf(a);
  if (doc.seq <= Number(cur.seq || 0)) throw err('stale_clients', 409, { seq: Number(cur.seq || 0) });
  const revoked = new Set(cur.list.filter(c => c.revoked_at).map(c => c.kid)); // a client that was revoked stays revoked
  if (doc.list.some(c => revoked.has(c.kid) && !c.revoked_at)) throw err('bad_clients', 400);
  if (!verify(clientsText(people.fullId(u), a.kid, doc), a.sig_pub, sig)) throw err('bad_signature', 403);
  db.run('UPDATE e2ee_accounts SET clients_doc = ?, clients_sig = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(doc), sig, now(), u.id);
  keysChanged(u);
  return { success: true };
}

// ---------- linking a new device: it shows a code, a device that has the keys seals them to it ----------
// POST /link { enc_pub, label? } -> the code to check on a trusted device (made from the key, so the server cannot swap it)
function link(req) {
  const u = home(req), { enc_pub } = req.body || {};
  if (!isPub(enc_pub)) throw err('bad_key', 400);
  if (!tries.link.hit(u.id)) throw err('rate_limited', 429);
  if (!accountOf(u.id)) throw err('no_keys', 404);
  const code = linkCode(enc_pub), exp = now() + LINK_TTL, label = String(req.body?.label || '').replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'New device';
  db.run('DELETE FROM e2ee_links WHERE user_id = ? AND expires_at < ?', u.id, now());
  db.run(`INSERT INTO e2ee_links (code_hash, user_id, kind, enc_pub, sig_pub, label, app, state, sealed, expires_at) VALUES (?, ?, 'device', ?, NULL, ?, NULL, 'waiting', NULL, ?)
    ON CONFLICT(code_hash) DO UPDATE SET user_id = excluded.user_id, enc_pub = excluded.enc_pub, label = excluded.label, state = 'waiting', sealed = NULL, expires_at = excluded.expires_at`,
  hashCode(code), u.id, enc_pub, label, exp);
  gateway().pushToUser(u.id, { type: 'e2ee_link_request', kind: 'device', label });
  return { code, kind: 'device', expires_at: exp };
}
function linkByCode(u, code) {
  const l = db.get('SELECT * FROM e2ee_links WHERE code_hash = ? AND user_id = ?', hashCode(code), u.id);
  if (!l || l.expires_at < now()) throw err('link_not_found', 404);
  return l;
}
// GET /link/:code: the one asking checks on its request, a trusted device looks up what it is about to approve
function linkGet(req) {
  const l = linkByCode(home(req), req.params.code);
  return { kind: l.kind, enc_pub: l.enc_pub, sig_pub: l.sig_pub, label: l.label, app: l.app, state: l.state, sealed: parse(l.sealed, null), expires_at: l.expires_at };
}
// POST /link/:code/approve { sealed: { e, i, w } }: the keys sealed to that device
function linkApprove(req) {
  const u = home(req);
  if (!accountOf(u.id)) throw err('no_keys', 404);
  const l = linkByCode(u, req.params.code);
  if (l.state !== 'waiting') throw err('link_used', 409);
  const s = req.body?.sealed;
  if (!s || !str(s.e, 128) || !str(s.i, 24) || !str(s.w, 64000)) throw err('bad_sealed', 400);
  db.run("UPDATE e2ee_links SET state = 'approved', sealed = ? WHERE code_hash = ?", JSON.stringify({ e: s.e, i: s.i, w: s.w }), l.code_hash);
  gateway().pushToUser(u.id, { type: 'e2ee_link_done', state: 'approved', code: linkCode(l.enc_pub) });
  return { success: true };
}
function linkDeny(req) {
  const u = home(req), l = linkByCode(u, req.params.code);
  db.run("UPDATE e2ee_links SET state = 'denied', sealed = NULL WHERE code_hash = ?", l.code_hash);
  gateway().pushToUser(u.id, { type: 'e2ee_link_done', state: 'denied', code: linkCode(l.enc_pub) });
  return { success: true };
}

function register(app) {
  const base = '/api/v2/social/e2ee';
  app.get(base + '/me', me);
  app.post(base, publish);
  app.post(base + '/unlock', unlock);
  app.put(base + '/backup', backup);
  app.put(base + '/clients', clients);
  app.post(base + '/link', link);
  app.get(base + '/link/:code', linkGet);
  app.post(base + '/link/:code/approve', linkApprove);
  app.post(base + '/link/:code/deny', linkDeny);
}

module.exports = {
  register, checkEnvelope, uncovered, openRevealed, signatureStatus, accountOf, clientsOf, isPub, kidOf, verify, clientsText, sigText, aadOf, commitOf,
  KID_RE, SIG_RE, MAX_CT, MAX_WRAPS, MAX_CLIENTS, MAX_LIST, MAX_PAST, KDF_MIN, PASSPHRASE_MIN, _test: { tries },
};
