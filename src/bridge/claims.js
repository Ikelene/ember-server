'use strict';
// Proof of control before a Discord / Fluxer server is linked (PROTOCOL §16). The bot is the homeserver's, shared by every
// server here, so "the bot is in that guild" proves nothing about the person asking. Two ways to prove it:
//   a claim code: the server's manager gets a code here and someone with Manage Server over there posts it in the guild
//                 (`!ember-claim <code>`, or just the code); the bot sees it and checks their permissions over REST
//   OAuth (Discord, when bridges.discord_oauth is set): Discord itself says which guilds the person manages
// A verified claim lets that one server link that one guild. `!ember-unlink` in the guild takes the link away again.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const store = require('./store');
const PL = require('./platform');
const { err, now, log } = require('../util');

const B = () => require('./bridge');
const TTL = 10 * 60 * 1000;        // a code is good for this long
const KEEP = 24 * 3600 * 1000;     // a verified claim waits this long to be used
const MANAGE_GUILD = 0x20n, ADMINISTRATOR = 0x8n;
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE = /^EC-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const newCode = () => { const s = [...crypto.randomBytes(8)].map(x => ALPHA[x & 31]).join(''); return `EC-${s.slice(0, 4)}-${s.slice(4)}`; };

function checkTarget(c, p, gid) {
  if (!PL.IDS.includes(p)) throw err('bad_platform', 404);
  if (!/^\d{1,24}$/.test(String(gid))) throw err('bad_guild');
  store.ensure();
  const other = linkedElsewhere(c.id, p, gid);
  if (other) throw err('guild_already_linked', 409, { sid: other.sid });
}
// one guild links to one server per homeserver
const linkedElsewhere = (cid, p, gid) => db.get('SELECT c.sid FROM bridge_guilds bg JOIN communities c ON c.id = bg.community_id WHERE bg.platform = ? AND bg.guild_id = ? AND bg.community_id <> ?', p, String(gid), cid);
const rowOf = (cid, p, gid) => db.get('SELECT * FROM bridge_claims WHERE community_id = ? AND platform = ? AND guild_id = ?', cid, p, String(gid));
const verified = (cid, p, gid) => { store.ensure(); const r = rowOf(cid, p, gid); return !!r?.verified_at && r.verified_at > now() - KEEP; };
const spend = (cid, p, gid) => db.run('DELETE FROM bridge_claims WHERE community_id = ? AND platform = ? AND guild_id = ?', cid, p, String(gid));
function markVerified(cid, p, gid, by, how) {
  store.ensure();
  db.run(`INSERT INTO bridge_claims (community_id, platform, guild_id, code, expires_at, verified_at, verified_by, how) VALUES (?, ?, ?, NULL, 0, ?, ?, ?)
    ON CONFLICT(community_id, platform, guild_id) DO UPDATE SET code = NULL, verified_at = excluded.verified_at, verified_by = excluded.verified_by, how = excluded.how`, cid, p, String(gid), now(), String(by), how);
  const c = db.get('SELECT sid FROM communities WHERE id = ?', cid);
  if (c) require('../gateway').emit(cid, { type: 'chat_bridge_claim', server: c.sid, platform: p, guild_id: String(gid), status: 'verified' });
}

// POST /bridge/servers/:sid/claim { platform, guild_id } -> { code, expires_at }
function start(c, me, p, gid) {
  checkTarget(c, p, gid);
  const code = newCode(), exp = now() + TTL;
  db.run(`INSERT INTO bridge_claims (community_id, platform, guild_id, code, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(community_id, platform, guild_id) DO UPDATE SET code = excluded.code, created_by = excluded.created_by, expires_at = excluded.expires_at, verified_at = NULL, verified_by = NULL, how = NULL`, c.id, p, String(gid), code, me.id, exp);
  db.run('DELETE FROM bridge_claims WHERE (verified_at IS NULL AND expires_at < ?) OR verified_at < ?', now() - TTL, now() - KEEP);
  return { code, expires_at: exp, command: `!ember-claim ${code}` };
}
// GET /bridge/servers/:sid/claim?platform=&guild_id= -> where it stands
function view(c, p, gid) {
  store.ensure();
  const r = rowOf(c.id, p, gid);
  if (r?.verified_at && r.verified_at > now() - KEEP) return { status: 'verified', verified_at: r.verified_at, how: r.how || 'code' };
  if (r?.code && r.expires_at > now()) return { status: 'pending', code: r.code, expires_at: r.expires_at };
  return { status: 'none' };
}

// ---------- over there: who may speak for a guild ----------
// Manage Server: the guild's owner, or any of their roles (with @everyone, whose id is the guild's) has it or Administrator
async function canManage(p, gid, uid) {
  const g = await PL.rest(p, 'GET', `/guilds/${gid}`);
  if (g?.owner_id != null && String(g.owner_id) === String(uid)) return true;
  const m = await PL.rest(p, 'GET', `/guilds/${gid}/members/${uid}`);
  const roles = Array.isArray(g?.roles) ? g.roles : await PL.rest(p, 'GET', `/guilds/${gid}/roles`);
  const mine = new Set([String(gid), ...(Array.isArray(m?.roles) ? m.roles : []).map(String)]);
  let perms = 0n;
  for (const r of Array.isArray(roles) ? roles : []) if (mine.has(String(r.id))) { try { perms |= BigInt(r.permissions || 0); } catch { /* not a number */ } }
  return (perms & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n;
}
// is this gateway message one of ours? -> { claim: code } | { unlink: true } | null (an ordinary message)
function command(d) {
  if (!d?.guild_id || !d.author?.id || d.webhook_id || d.author.bot) return null;
  const t = String(d.content || '').trim();
  if (t.length > 60) return null;
  const m = /^!ember-claim\s+(\S+)$/i.exec(t);
  if (m) return { claim: m[1].toUpperCase(), explicit: true };
  if (CODE.test(t.toUpperCase())) return { claim: t.toUpperCase() };
  if (/^!ember-unlink$/i.test(t)) return { unlink: true };
  return null;
}
async function run(p, d, cmd) {
  store.ensure();
  const gid = String(d.guild_id), uid = String(d.author.id);
  const say = text => PL.rest(p, 'POST', `/channels/${d.channel_id}/messages`, { content: text, allowed_mentions: { parse: [] } }).catch(() => {});
  const may = () => canManage(p, gid, uid).catch(e => { log(`[bridge] ${p} permission check in ${gid}: ${e.message}`); return false; });
  if (cmd.claim) {
    const r = db.get('SELECT * FROM bridge_claims WHERE code = ? AND platform = ? AND guild_id = ? AND verified_at IS NULL AND expires_at > ?', cmd.claim, p, gid, now());
    if (!r) { if (cmd.explicit) await say('That code is not for this server, or it ran out. Get a new one in Ember.'); return; }
    if (!(await may())) { await say('Only someone with Manage Server here can confirm this.'); return; }
    markVerified(r.community_id, p, gid, uid, 'code');
    const c = db.get('SELECT name FROM communities WHERE id = ?', r.community_id);
    await say(`Confirmed. This server can now be linked to ${c?.name || 'your server'} on Ember.`);
    return;
  }
  const rows = db.all('SELECT * FROM bridge_guilds WHERE platform = ? AND guild_id = ?', p, gid);
  if (!rows.length) return;
  if (!(await may())) { await say('Only someone with Manage Server here can unlink this server.'); return; }
  for (const b of rows) await B().removeBridge(b);
  await say('Unlinked from Ember.');
}

// ---------- OAuth (Discord): the person signs in to Discord, which lists the guilds they manage ----------
const oauthSettings = () => { const o = config.get().bridges.discord_oauth; return o?.client_id && o?.client_secret ? o : null; };
const redirectUri = () => `${config.publicUrl()}/api/v1/bridge/oauth/discord/callback`;
const states = new Map(); // state -> { cid, gid, at }
// GET /bridge/oauth/discord/start?sid=&guild_id= -> { url } (open it in a browser)
function oauthStart(c, me, gid) {
  const o = oauthSettings();
  if (!o) throw err('oauth_not_set_up', 503);
  checkTarget(c, 'discord', gid);
  for (const [k, v] of states) if (now() - v.at > TTL) states.delete(k);
  if (states.size > 2000) states.delete(states.keys().next().value);
  const state = crypto.randomBytes(24).toString('base64url');
  states.set(state, { cid: c.id, gid: String(gid), at: now() });
  const q = new URLSearchParams({ response_type: 'code', client_id: o.client_id, scope: 'identify guilds', state, redirect_uri: redirectUri(), prompt: 'consent' });
  return { url: `${PL.platform('discord').authorize}?${q}` };
}
// GET /bridge/oauth/discord/callback?code=&state= -> a short page
async function oauthCallback(q) {
  const st = states.get(String(q.state || ''));
  states.delete(String(q.state || ''));
  const o = oauthSettings();
  if (!st || now() - st.at > TTL || !o) return { ok: false, message: 'This link ran out. Start again from Ember.' };
  if (!q.code) return { ok: false, message: 'Discord did not confirm anything.' };
  try {
    const { api } = await PL.endpoints('discord');
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: String(q.code), redirect_uri: redirectUri(), client_id: o.client_id, client_secret: o.client_secret });
    const tr = await fetch(`${api}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': PL.UA }, body: form, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const tok = tr.ok ? await tr.json() : null;
    if (!tok?.access_token) return { ok: false, message: 'Discord refused the sign-in.' };
    const auth = { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': PL.UA };
    const gr = await fetch(`${api}/users/@me/guilds`, { headers: auth, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const guilds = gr.ok ? await gr.json() : [];
    const g = (Array.isArray(guilds) ? guilds : []).find(x => String(x.id) === st.gid);
    let perms = 0n; try { perms = BigInt(g?.permissions || 0); } catch { perms = 0n; }
    if (!g || !(g.owner === true || (perms & (MANAGE_GUILD | ADMINISTRATOR)) !== 0n)) return { ok: false, message: 'You need Manage Server in that Discord server.' };
    const who = await fetch(`${api}/users/@me`, { headers: auth, redirect: 'error', signal: AbortSignal.timeout(15000) }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (linkedElsewhere(st.cid, 'discord', st.gid)) return { ok: false, message: 'That Discord server is linked to another server here.' };
    markVerified(st.cid, 'discord', st.gid, who?.id || 'oauth', 'oauth');
    return { ok: true, message: `Confirmed: ${g.name || 'the server'} can now be linked. You can close this page.` };
  } catch (e) { log(`[bridge] discord oauth: ${e.message}`); return { ok: false, message: 'Discord could not be reached. Try again.' }; }
}
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
function sendPage(res, r) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ember bridge</title><body style="font:16px system-ui;margin:15vh auto;max-width:28em;padding:0 1em"><h1 style="font-size:1.3em">${r.ok ? 'Confirmed' : 'Not confirmed'}</h1><p>${esc(r.message)}</p>`;
  res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Frame-Options': 'DENY' });
  res.end(html);
}

module.exports = { start, view, verified, spend, markVerified, linkedElsewhere, canManage, command, run, oauthSettings, oauthStart, oauthCallback, sendPage, TTL };
