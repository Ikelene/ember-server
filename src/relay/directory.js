'use strict';
// The public Ember directory on Nookara (PROTOCOL §12.9): PUT relayPath('/directory') with every server whose `listed` is on;
// `listed: false` (none listed) takes the listing down. Re-pushed (debounced) whenever what would be listed changes, and every
// 6 hours anyway.
const { relayPath } = require('../compat');
const db = require('../db');
const config = require('../config');
const { emberBase } = require('../util');
const C = require('../communities');
const client = require('./client');

const CHECK_MS = 60 * 1000, FORCE_MS = 6 * 3600 * 1000;
let DEBOUNCE_MS = 3000;
let tick = null, soon = null, busy = false, info = { listed: false, hidden_by_staff: false, pushed_at: null, last_error: null };

const abs = u => { try { return u ? new URL(u, config.publicUrl()).href : null; } catch { return null; } };
function payload() {
  const list = C.listedCommunities();
  if (!list.length) return { listed: false };
  const cfg = config.get(), origin = cfg.public_url;
  const entry = c => ({
    name: c.name, description: c.description || '', icon_url: abs(c.icon_url), banner_url: abs(c.banner_url), member_count: C.memberCount(c.id),
    // the community's permanent invite, opened in Ember on the web
    invite_url: `${emberBase(cfg.nookara_url)}#/i/${encodeURIComponent(origin)}/invite/${c.invite_code}`,
    tags: Array.isArray(cfg.tags) ? cfg.tags.slice(0, 8) : [],
  });
  // One listed server: exactly the entry Nookara has always taken. Several: the oldest stays in those fields (older Nookara
  // versions read only those) and all of them ride along in `communities`, which Nookara lists one row each.
  const out = { listed: true, ...entry(list[0]) };
  if (list.length > 1) out.communities = list.map(c => ({ sid: c.sid, slug: c.slug, address: C.addressOf(c), ...entry(c) }));
  return out;
}
const last = () => { try { return JSON.parse(db.metaGet('nookara_dir') || 'null'); } catch { return null; } };

async function push(force = false) {
  if (busy || !client.registered()) return null;
  const p = payload(), fp = JSON.stringify(p), prev = last();
  if (!force && prev?.fp === fp && Date.now() - prev.at < FORCE_MS) return null;
  if (!p.listed && !prev?.listed) return null; // never listed: nothing to take down
  busy = true;
  try {
    let body = { ...p }, out;
    for (let i = 0; i < 5; i++) { // Nookara only stores https links: drop a link it refuses rather than the whole listing
      try { out = await client.call('PUT', relayPath('/directory'), body); break; } catch (e) {
        if (e.code === 'invalid_communities' && body.communities) { delete body.communities; continue; } // a Nookara that does not take the list yet
        if (e.code === 'invalid_icon_url' && body.icon_url) { body.icon_url = null; continue; }
        if (e.code === 'invalid_banner_url' && body.banner_url) { body.banner_url = null; continue; }
        if (e.code === 'invalid_invite_url' && body.invite_url) { body.invite_url = null; continue; }
        throw e;
      }
    }
    db.metaSet('nookara_dir', JSON.stringify({ fp, at: Date.now(), listed: p.listed }));
    info = { listed: !!out?.listed, hidden_by_staff: !!out?.hidden_by_staff, pushed_at: Date.now(), last_error: null };
    return out;
  } catch (e) { info.last_error = e.code || e.message; return null; } finally { busy = false; }
}
function poke() { clearTimeout(soon); soon = setTimeout(() => { push().catch(() => {}); }, DEBOUNCE_MS); soon.unref?.(); }
const onRegistered = () => poke();

function start() {
  tick = setInterval(() => { push().catch(() => {}); }, CHECK_MS); tick.unref?.();
  config.events.on('change', poke);
  client.events.on('registered', onRegistered);
}
function stop() { clearInterval(tick); clearTimeout(soon); tick = soon = null; config.events.off('change', poke); info = { listed: false, hidden_by_staff: false, pushed_at: null, last_error: null }; }
// (after a restart, until the next push: what the last push stored)
const status = () => (info.pushed_at || !client.registered() ? { ...info } : { ...info, listed: !!last()?.listed, pushed_at: last()?.at || null });
module.exports = { start, stop, push, poke, payload, status, _setDebounce: ms => { DEBOUNCE_MS = ms; } };
