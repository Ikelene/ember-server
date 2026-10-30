'use strict';
// Server settings > Insights: joins / leaves, messages, unique chatters, reactions, top channels, top chatters and the busiest
// hours over a range (24h hourly, 7d / 30d / 90d daily), each total next to the previous range of the same length.
// GET /api/v1/servers/:sid/insights?range=7d&bots=0&tz=<Date#getTimezoneOffset()>  (Manage server or an instance admin)
//
// Everything is a handful of GROUP BY range scans over indexed timestamps (messages_created, reactions_created,
// member_events_at: migration v11), bounded by the range, and cached for 60 s per (server, range, bots, tz).
// Buckets line up with the viewer's local hours / midnights (tz = minutes behind UTC, as the browser reports it).
// (node:sqlite binds JS numbers as REAL, so bucket maths is CAST back to INTEGER or GROUP BY would split every row.)
// Voice isn't here: voice presence is only kept in memory, nothing records sessions.
const db = require('./db');
const { err } = require('./util');

const HOUR = 3600000, DAY = 24 * HOUR;
const RANGES = { '24h': { n: 24, step: HOUR }, '7d': { n: 7, step: DAY }, '30d': { n: 30, step: DAY }, '90d': { n: 90, step: DAY } };
const TOP_CHANNELS = 8, TOP_CHATTERS = 10, TTL = 60000;

// message filters: system notices never count; bots (and webhooks) only when asked
// (subqueries, not joins: the scan stays inside the covering messages_created index, no row lookups per message)
const BOT_IDS = "(SELECT id FROM users WHERE kind = 'bot')";
const HUMAN = `m.webhook_id IS NULL AND m.user_id IS NOT NULL AND m.user_id NOT IN ${BOT_IDS}`;
const msgWhere = bots => `m.channel_id IN (SELECT id FROM channels WHERE community_id = ?) AND m.created_at >= ? AND m.created_at < ? AND m.system = 0${bots ? '' : ` AND ${HUMAN}`}`;
// INDEXED BY: without ANALYZE stats SQLite prefers messages_channel and walks every message of every channel
const MSG_FROM = 'messages m INDEXED BY messages_created';

function window_(range, tz, at = Date.now()) {
  const r = RANGES[range];
  if (!r) throw err('invalid_range', 400);
  const off = tz * 60000; // local = utc - off
  const local = at - off;
  const end = (Math.floor(local / r.step) + 1) * r.step + off; // the end of the current local hour / day
  const start = end - r.n * r.step;
  return { ...r, start, end, prevStart: start - r.n * r.step };
}

function compute(c, { range, bots, tz }, at = Date.now()) {
  const w = window_(range, tz, at);
  const { n, step, start, end, prevStart } = w;
  const zeros = () => new Array(n).fill(0);
  const num = v => Number(v) || 0;
  const into = (rows, key = 'b', val = 'n') => { const out = zeros(); for (const r of rows) { const i = num(r[key]); if (i >= 0 && i < n) out[i] += num(r[val]); } return out; };

  // ---- messages: one pass by hour (feeds the buckets and the weekday x hour heatmap) ----
  const hours = db.all(`SELECT CAST((m.created_at - ?) / ${HOUR} AS INTEGER) AS h, COUNT(*) AS n FROM ${MSG_FROM} WHERE ${msgWhere(bots)} GROUP BY h`, start, c.id, start, end);
  const msgSeries = zeros();
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of hours) {
    const h = num(r.h), cnt = num(r.n);
    const t = start + h * HOUR;
    const i = Math.floor((t - start) / step);
    if (i >= 0 && i < n) msgSeries[i] += cnt;
    const d = new Date(t - tz * 60000); // read the UTC fields of a shifted date = the viewer's local wall clock
    heat[d.getUTCDay()][d.getUTCHours()] += cnt;
  }
  const msgTotal = msgSeries.reduce((a, b) => a + b, 0);
  const msgPrev = num(db.get(`SELECT COUNT(*) AS n FROM ${MSG_FROM} WHERE ${msgWhere(bots)}`, c.id, prevStart, start)?.n);

  // ---- unique chatters: people only, whatever the bots switch says ----
  const chatSeries = into(db.all(`SELECT CAST((m.created_at - ?) / ${step} AS INTEGER) AS b, COUNT(DISTINCT m.user_id) AS n FROM ${MSG_FROM} WHERE ${msgWhere(false)} GROUP BY b`, start, c.id, start, end));
  const distinct = (from, to) => num(db.get(`SELECT COUNT(DISTINCT m.user_id) AS n FROM ${MSG_FROM} WHERE ${msgWhere(false)}`, c.id, from, to)?.n);
  const chatTotal = distinct(start, end), chatPrev = distinct(prevStart, start);
  const active = { dau: distinct(at - DAY, at + 1), wau: distinct(at - 7 * DAY, at + 1), mau: distinct(at - 30 * DAY, at + 1) };

  // ---- reactions (by who reacted; the message must be in this server) ----
  const reactWhere = `m.channel_id IN (SELECT id FROM channels WHERE community_id = ?) AND r.created_at >= ? AND r.created_at < ?${bots ? '' : ` AND r.user_id NOT IN ${BOT_IDS}`}`;
  const REACT_FROM = 'reactions r INDEXED BY reactions_created JOIN messages m ON m.id = r.message_id';
  const reactSeries = into(db.all(`SELECT CAST((r.created_at - ?) / ${step} AS INTEGER) AS b, COUNT(*) AS n FROM ${REACT_FROM} WHERE ${reactWhere} GROUP BY b`, start, c.id, start, end));
  const reactPrev = num(db.get(`SELECT COUNT(*) AS n FROM ${REACT_FROM} WHERE ${reactWhere}`, c.id, prevStart, start)?.n);

  // ---- members: joins / leaves (people only) and the member count walked back from now ----
  const EV = "member_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.community_id = ? AND e.at >= ? AND e.at < ? AND COALESCE(u.kind, '') <> 'bot'";
  const ev = db.all(`SELECT e.kind AS k, CAST((e.at - ?) / ${step} AS INTEGER) AS b, COUNT(*) AS n FROM ${EV} GROUP BY k, b`, start, c.id, start, end);
  const joins = into(ev.filter(r => r.k === 'join')), leaves = into(ev.filter(r => r.k === 'leave'));
  const prevJoins = num(db.get(`SELECT COUNT(*) AS n FROM ${EV} AND e.kind = 'join'`, c.id, prevStart, start)?.n);
  const prevLeaves = num(db.get(`SELECT COUNT(*) AS n FROM ${EV} AND e.kind = 'leave'`, c.id, prevStart, start)?.n);
  const membersNow = num(db.get("SELECT COUNT(*) AS n FROM members m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND u.kind <> 'bot'", c.id)?.n);
  const net = joins.map((j, i) => j - leaves[i]);
  const count = zeros(); // members at the end of each bucket
  let acc = membersNow;
  for (let i = n - 1; i >= 0; i--) { count[i] = Math.max(0, acc); acc -= net[i]; }
  const membersAtStart = Math.max(0, acc);

  // ---- top channels (with a per-bucket sparkline) ----
  const topCh = db.all(`SELECT m.channel_id AS id, COUNT(*) AS n FROM ${MSG_FROM} WHERE ${msgWhere(bots)} GROUP BY m.channel_id ORDER BY n DESC LIMIT ${TOP_CHANNELS}`, c.id, start, end);
  let channels = [];
  if (topCh.length) {
    const ids = topCh.map(r => r.id);
    const meta = new Map(db.all(`SELECT id, cid, name, type FROM channels WHERE id IN (${db.inList(ids)})`, ...ids).map(r => [r.id, r]));
    const sp = db.all(`SELECT m.channel_id AS id, CAST((m.created_at - ?) / ${step} AS INTEGER) AS b, COUNT(*) AS n FROM ${MSG_FROM} WHERE ${msgWhere(bots)} AND m.channel_id IN (${db.inList(ids)}) GROUP BY m.channel_id, b`, start, c.id, start, end, ...ids);
    channels = topCh.map(r => ({ cid: meta.get(r.id)?.cid, name: meta.get(r.id)?.name || 'deleted', type: meta.get(r.id)?.type || 'text', messages: num(r.n), spark: into(sp.filter(x => x.id === r.id)) }));
  }

  // ---- top chatters ----
  const topU = db.all(`SELECT m.user_id AS uid, COUNT(*) AS n FROM ${MSG_FROM} WHERE ${msgWhere(bots)} AND m.user_id IS NOT NULL GROUP BY m.user_id ORDER BY n DESC LIMIT ${TOP_CHATTERS}`, c.id, start, end);
  const who = topU.length ? new Map(db.all(`SELECT id, principal, username, display_name, pfp, kind FROM users WHERE id IN (${db.inList(topU.map(r => r.uid))})`, ...topU.map(r => r.uid)).map(u => [u.id, u])) : new Map();
  const chatters = topU.filter(r => who.has(r.uid)).map(r => { const u = who.get(r.uid); return { id: u.principal, username: u.username, display_name: u.display_name || u.username, pfp: u.pfp || null, ...(u.kind === 'bot' ? { bot: true } : {}), messages: num(r.n) }; });

  const sum = a => a.reduce((x, y) => x + y, 0);
  return {
    range, bots: !!bots, tz, start, end, step_ms: step, count: n, generated_at: at,
    members: {
      now: membersNow, at_start: membersAtStart, series: count, joins, leaves, net,
      joins_total: sum(joins), leaves_total: sum(leaves), prev_joins: prevJoins, prev_leaves: prevLeaves,
      leaves_since: num(db.metaGet('member_events_since')) || null,
    },
    messages: { series: msgSeries, total: msgTotal, prev: msgPrev },
    chatters: { series: chatSeries, total: chatTotal, prev: chatPrev, ...active },
    reactions: { series: reactSeries, total: sum(reactSeries), prev: reactPrev },
    heatmap: heat, // [weekday 0 = Sunday][local hour]
    top_channels: channels,
    top_chatters: chatters,
    voice: null, // not recorded
  };
}

let cache = new Map();
function view(c, q = {}) {
  const range = RANGES[q.range] ? q.range : '7d';
  const bots = q.bots === '1' || q.bots === 'true' || q.bots === true;
  let tz = Math.round(Number(q.tz) || 0);
  tz = Math.max(-840, Math.min(840, tz));
  const key = `${c.id}|${range}|${bots ? 1 : 0}|${tz}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  const v = compute(c, { range, bots, tz });
  if (cache.size > 200) cache = new Map();
  cache.set(key, { at: Date.now(), v });
  return v;
}
const _reset = () => { cache = new Map(); };

module.exports = { view, compute, window_, RANGES, _reset };
