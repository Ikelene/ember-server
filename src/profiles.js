'use strict';
// Keeps the names / pictures of Nookara-account members current. Sessions can outlive the login token's claims, so an account that
// renamed itself on Nookara would otherwise stay "old_name" here until its next sign-in. Source: NOOKARA + compat NOOKARA_PATHS.profiles ?ids=1,2,3
// (public, cached 60 s). A change goes through auth.refreshNookaraProfile -> identityChanged -> chat_identity_update to clients.
//   - lazily on every gateway chat_hello (at most once per account per 10 minutes)
//   - periodically (every 15 min, rotating through up to 500 members per run)
// The same response says whether staff switched Ember off for the account (`restricted`, Nookara's disabled_scopes chat bit). That is
// enforced by gate() on every REST request + gateway frame, and by sweep() every 30 s for sockets that only listen.
const { KIND_NOOKARA, env, NOOKARA_PATHS } = require('./compat');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');

const TTL = 10 * 60 * 1000, CYCLE = 15 * 60 * 1000, PER_CYCLE = 500, BATCH = 100;
const checked = new Map(); // nookara id -> ms
const gatedAt = new Map(); // nookara id -> ms of the last restriction check
const GATE_TTL = 30 * 1000, SWEEP = 30 * 1000;
let offset = 0, timer = null;

const enabled = () => (config.mode() === 'nookara' || config.nookaraIdentity()) && config.get().nookara_registration !== 'off' && env('PROFILE_SYNC') !== '0';
// restrictions apply on every Nookara-accounts instance, whatever the registration setting
const gateOn = () => (config.mode() === 'nookara' || config.nookaraIdentity()) && env('PROFILE_SYNC') !== '0';

async function fetchProfiles(ids, fresh = false, ms = 8000) {
  const r = await fetch(`${config.get().nookara_url}${NOOKARA_PATHS.profiles}?ids=${ids.join(',')}${fresh ? '&_=' + Date.now() : ''}`, { signal: AbortSignal.timeout(ms), headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('status ' + r.status);
  const j = await r.json();
  return Array.isArray(j?.profiles) ? j.profiles : [];
}

// -> number of accounts that changed. Never throws (Nookara being down must not hurt anything).
async function refresh(nookaraIds, { force = false, always = false } = {}) {
  if (!(always ? gateOn() : enabled())) return 0;
  const now = Date.now();
  const ids = [...new Set(nookaraIds.map(String))].filter(id => /^[1-9]\d{0,19}$/.test(id) && (force || now - (checked.get(id) || 0) > TTL));
  let changed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const part = ids.slice(i, i + BATCH);
    try {
      for (const p of await fetchProfiles(part, force, always ? 3000 : 8000)) {
        if (p && typeof p.username === 'string' && auth.refreshNookaraProfile({ id: String(p.id), username: p.username, display_name: p.display_name, pfp: typeof p.pfp === 'string' ? p.pfp : null })) changed++;
        if (p && typeof p.restricted === 'boolean') auth.setRestricted(String(p.id), p.restricted); // an older Nookara sends nothing: leave it as it was
      }
      for (const id of part) { checked.set(id, now); gatedAt.set(id, now); }
    } catch { /* fail silent; retried next time */ }
  }
  if (checked.size > 20000) for (const [k, t] of checked) if (now - t > TTL) checked.delete(k);
  if (gatedAt.size > 20000) for (const [k, t] of gatedAt) if (now - t > GATE_TTL) gatedAt.delete(k);
  return changed;
}

// a client saw Nookara's live `user_update` for a Nookara member of this instance: re-read that one profile now instead of waiting for
// the 10-15 minute schedule. Throttled per account (every client of the instance sends this at once), so Nookara sees ~1 request / 15 s.
const nudged = new Map(); // nookara id -> ms
const NUDGE_GAP = 15000;
function nudge(nookaraId) {
  const id = String(nookaraId || '');
  if (!/^[1-9]\d{0,19}$/.test(id)) return Promise.resolve(0);
  const now = Date.now();
  if (now - (nudged.get(id) || 0) < NUDGE_GAP) return Promise.resolve(0);
  nudged.set(id, now);
  if (nudged.size > 5000) for (const [k, t] of nudged) if (now - t > NUDGE_GAP) nudged.delete(k);
  return refresh([id], { force: true });
}

const lazy = user => { if (user?.kind === KIND_NOOKARA && user.nookara_id) refresh([user.nookara_id]).catch(() => {}); };

// Is Ember switched off for this person? Reads the stored flag, re-asking Nookara first when the last answer is over 30 s old
// (Nookara being down keeps the last known state).
async function gate(user) {
  if (user?.kind !== KIND_NOOKARA || !user.nookara_id) return false;
  const id = String(user.nookara_id), t = Date.now();
  if (gateOn() && t - (gatedAt.get(id) || 0) > GATE_TTL) { gatedAt.set(id, t); await refresh([id], { force: true, always: true }); }
  return !!auth.userById(user.id)?.restricted;
}
// the Nookara ids of everyone with an open gateway socket, re-checked together (restricted people still connected are cut off here)
async function sweep() {
  try {
    const ids = require('./gateway').onlineUserIds().map(uid => auth.userById(uid)).filter(u => u?.kind === KIND_NOOKARA && u.nookara_id).map(u => u.nookara_id);
    if (ids.length) await refresh(ids, { force: true, always: true });
  } catch { /* db closed / not ready */ }
}

async function cycle() {
  try {
    const rows = db.all(`SELECT DISTINCT u.nookara_id FROM users u JOIN members m ON m.user_id = u.id WHERE u.kind = '${KIND_NOOKARA}' AND u.nookara_id IS NOT NULL ORDER BY u.id LIMIT ? OFFSET ?`, PER_CYCLE, offset);
    offset = rows.length < PER_CYCLE ? 0 : offset + PER_CYCLE;
    await refresh(rows.map(r => r.nookara_id), { force: true });
  } catch { /* db closed / not ready */ }
}
let sweeper = null;
const start = () => { if (timer) return; timer = setInterval(cycle, CYCLE); timer.unref(); setTimeout(cycle, 45000).unref(); sweeper = setInterval(sweep, SWEEP); sweeper.unref(); };
const stop = () => { if (timer) clearInterval(timer); timer = null; if (sweeper) clearInterval(sweeper); sweeper = null; };

module.exports = { refresh, gate, sweep, lazy, nudge, start, stop };
