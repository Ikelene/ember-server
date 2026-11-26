'use strict';
// Daily chat credits (PROTOCOL §12.4): the first message of the UTC day by a Nookara principal asks Nookara for the daily
// credit. Trusted instances only: Nookara answers 403 not_trusted otherwise, and the instance stops asking.
const { ERR, relayPath, KIND_NOOKARA } = require('../compat');
const db = require('../db');
const gateway = require('../gateway');
const messages = require('../messages');
const C = require('../communities');
const client = require('./client');

const done = new Map(); // user id -> 'YYYY-MM-DD' (UTC) already asked today
const today = () => new Date().toISOString().slice(0, 10);
let off = null;

async function onPost(msg, ctx, meta) {
  if (meta.system || meta.webhook || meta.bridged || !meta.userId || !client.trusted()) return;
  const day = today();
  if (done.get(meta.userId) === day) return;
  const u = db.get(`SELECT * FROM users WHERE id = ? AND kind = '${KIND_NOOKARA}'`, Number(meta.userId));
  if (!u?.nookara_id) return;
  done.set(meta.userId, day);
  if (done.size > 50000) for (const [k, v] of done) if (v !== day) done.delete(k);
  let r;
  try { r = await client.call('POST', relayPath('/daily'), { user_id: String(u.nookara_id) }); } catch (e) {
    if (e.code === 'not_trusted') { client.setTrusted(false); return; }
    if (e.status === 429 || e.code === ERR.unreachable || e.status >= 500) done.delete(meta.userId); // try again on their next message
    return;
  }
  if (r?.status === 'claimed' && C.getSettings(u).daily_notice !== false) {
    gateway.pushToUser(u.id, { type: 'chat_ephemeral', server: ctx.c.sid, channel: ctx.ch.cid, kind: 'daily', amount: r.amount, body: `You claimed your daily chat credits (+${r.amount} credits).` });
  }
}

function start() { off = messages.onPost(onPost); }
function stop() { off?.(); off = null; done.clear(); }
module.exports = { start, stop, onPost };
