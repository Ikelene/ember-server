'use strict';
// interactions (protocol 14.2). all in memory, an interaction lives 15 min, ephemeral replies are never stored
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const gateway = require('./gateway');
const C = require('./communities');
const K = require('./commands');
const comps = require('./components');
const W = require('./webhooks');
const { err, limiter } = require('./util');

const B = () => require('./bots');
const M = () => require('./messages');
const MOD = () => require('./moderation');
const TOKEN_MS = 15 * 60 * 1000, ACK_MS = 3000, AUTOCOMPLETE_MS = 2500;
const EPHEMERAL = 64;
const live = new Map();
const byToken = new Map();
const ephIndex = new Map();
const runLimit = limiter(15, 10000);
let seq = 0;
const newId = () => String(Date.now() * 4096 + (seq++ % 4096));
const bad = (option, reason) => err('bad_option', 400, { option, reason });
const toggle = (set, fn) => { const t = setTimeout(fn, set); t.unref(); return t; };
const channelOf = (it) => db.get('SELECT * FROM channels WHERE id = ?', it.channelRow);
const commUser = id => auth.userById(id);

const memberObj = (c, snap, u) => ({
  user: B().userObj(u), nick: null, roles: [...snap.roleIds(u.id)].map(id => String(B().ROLE_BASE + id)), flags: 0, pending: false, deaf: false, mute: false,
  joined_at: new Date(db.get('SELECT joined_at FROM members WHERE community_id = ? AND user_id = ?', c.id, u.id)?.joined_at || Date.now()).toISOString(),
  permissions: B().permsToDiscord(snap.perms(u.id)),
});
const roleId = (c, r) => (r.is_default ? String(c.id) : String(B().ROLE_BASE + r.id));

function basePayload(it, c, snap, ch, user, bot, type, data, extra = {}) {
  return {
    id: it.id, application_id: String(bot.id), type, data, guild_id: String(c.id), channel_id: String(ch.id), channel: B().channelObj(ch, c),
    member: memberObj(c, snap, user), token: it.token, version: 1, locale: 'en-US', guild_locale: 'en-US', entitlements: [], context: 0,
    app_permissions: B().permsToDiscord(snap.chPerms(ch, bot.id)), authorizing_integration_owners: { 0: String(c.id) },
    attachment_size_limit: C.effectiveUploadMax(c, snap, user) * 1024 * 1024, ...extra,
  };
}

function resolver(c, snap, ch) {
  const resolved = { users: {}, members: {}, roles: {}, channels: {}, messages: {}, attachments: {} };
  const user = principal => {
    const u = auth.userByPrincipal(principal);
    if (!u || !snap.isMember(u.id)) return null;
    resolved.users[u.id] = B().userObj(u);
    resolved.members[u.id] = (({ user: _u, ...m }) => m)(memberObj(c, snap, u));
    return String(u.id);
  };
  const role = rid => {
    const r = snap.roles.find(x => x.rid === rid);
    if (!r) return null;
    resolved.roles[roleId(c, r)] = B().roleObj(c, r);
    return roleId(c, r);
  };
  const channel = (cid, me) => {
    const x = snap.channels.find(y => y.cid === cid);
    if (!x || !snap.canView(x, me.id)) return null;
    resolved.channels[x.id] = { id: String(x.id), name: x.name, type: x.type === 'voice' ? 2 : 0, permissions: B().permsToDiscord(snap.chPerms(x, me.id)) };
    return String(x.id);
  };
  return { resolved, user, role, channel };
}
function convert(def, v, ctx, me) {
  const name = def.name;
  const { OPT } = K;
  switch (def.type) {
    case OPT.STRING: {
      const s = String(v);
      if (def.min_length != null && s.length < def.min_length) throw bad(name, `at least ${def.min_length} characters`);
      if (def.max_length != null && s.length > def.max_length) throw bad(name, `at most ${def.max_length} characters`);
      if (def.choices?.length && !def.choices.some(x => x.value === s)) throw bad(name, 'not one of the choices');
      return s;
    }
    case OPT.INTEGER: case OPT.NUMBER: {
      const n = typeof v === 'number' ? v : (String(v).trim() === '' ? NaN : Number(v));
      if (!Number.isFinite(n) || (def.type === OPT.INTEGER && !Number.isInteger(n))) throw bad(name, def.type === OPT.INTEGER ? 'must be a whole number' : 'must be a number');
      if (def.min_value != null && n < def.min_value) throw bad(name, `at least ${def.min_value}`);
      if (def.max_value != null && n > def.max_value) throw bad(name, `at most ${def.max_value}`);
      if (def.choices?.length && !def.choices.some(x => x.value === n)) throw bad(name, 'not one of the choices');
      return n;
    }
    case OPT.BOOLEAN: return v === true || v === 'true';
    case OPT.USER: { const id = ctx.user(String(v)); if (!id) throw bad(name, 'that person is not in this server'); return id; }
    case OPT.ROLE: { const id = ctx.role(String(v)); if (!id) throw bad(name, 'unknown role'); return id; }
    case OPT.CHANNEL: {
      const id = ctx.channel(String(v), me);
      if (!id) throw bad(name, 'unknown channel');
      if (def.channel_types?.length) { const ch = ctx.snap.channels.find(x => x.id === Number(id)); if (!def.channel_types.includes(ch.type === 'voice' ? 2 : 0)) throw bad(name, 'wrong kind of channel'); }
      return id;
    }
    case OPT.MENTIONABLE: {
      const id = /^r[0-9a-f]{10}$/.test(String(v)) ? ctx.role(String(v)) : ctx.user(String(v));
      if (!id) throw bad(name, 'unknown person or role');
      return id;
    }
    case OPT.ATTACHMENT: {
      const att = M().cleanAttachments([{ url: typeof v === 'string' ? v : v?.url }])[0];
      if (!att) throw bad(name, 'upload the file first');
      const id = newId();
      ctx.resolved.attachments[id] = { id, filename: att.name, size: att.size || 0, url: att.url, proxy_url: att.url, content_type: att.type === 'image' ? 'image/png' : 'application/octet-stream', width: att.width, height: att.height };
      return id;
    }
    default: throw bad(name, 'unsupported option');
  }
}
function buildOptions(defs, path, values, ctx, me, { focused = null, lenient = false } = {}) {
  let list = defs;
  const chain = [];
  for (const step of path) {
    const d = list.find(x => x.name === step && (x.type === K.OPT.SUB || x.type === K.OPT.GROUP));
    if (!d) throw err('unknown_command', 404);
    chain.push(d);
    list = d.options || [];
  }
  if (list.some(d => d.type === K.OPT.SUB || d.type === K.OPT.GROUP)) throw bad(path.join(' ') || 'command', 'pick a subcommand');
  const out = [];
  for (const d of list) {
    const v = values?.[d.name];
    const empty = v === undefined || v === null || v === '';
    if (focused === d.name) { out.push({ name: d.name, type: d.type, value: empty ? '' : String(v), focused: true }); continue; }
    if (empty) { if (d.required && !lenient) throw bad(d.name, 'required'); continue; }
    try { out.push({ name: d.name, type: d.type, value: convert(d, v, ctx, me) }); } catch (e) { if (!lenient) throw e; }
  }
  return chain.reduceRight((inner, d) => [{ name: d.name, type: d.type, options: inner }], out);
}

function open({ bot, c, ch, user, type, name }) {
  const it = {
    id: newId(), token: crypto.randomBytes(30).toString('base64url'), botId: bot.id, communityId: c.id, sid: c.sid, channelRow: ch.id, cid: ch.cid, userId: user.id, type, name,
    acked: false, deferred: false, ephemeral: false, thinking: false, msgId: null, msgIds: new Set(), eph: new Map(), origEph: null, origDone: false, late: false, timers: [],
  };
  live.set(it.id, it); byToken.set(it.token, it);
  it.timers.push(toggle(TOKEN_MS, () => expire(it)));
  return it;
}
function expire(it) {
  live.delete(it.id); byToken.delete(it.token);
  it.timers.forEach(clearTimeout);
  for (const id of it.eph.keys()) ephIndex.delete(id);
  if (it.thinking && it.msgId) {
    try { M().editMessage(it.msgId, commUser(it.botId), 'The application did not respond.', { embeds: [], components: [], interaction: null, silent: true }).catch(() => {}); } catch { /* gone */ }
  }
}
function armAck(it) {
  it.timers.push(toggle(ACK_MS, () => {
    if (it.acked) return;
    it.late = true;
    push(it, 'create', ephView(it, newId(), { content: `**${commUser(it.botId)?.username || 'The bot'}** did not respond in time.` }));
  }));
}
const find = (id, token) => {
  const it = live.get(String(id));
  if (!it || it.token !== String(token) || it.late) throw err('unknown_interaction', 404);
  return it;
};
const forWebhook = (token, appId) => {
  const it = byToken.get(String(token));
  if (!it || String(it.botId) !== String(appId)) throw err('unknown_webhook', 404);
  return it;
};

function ephView(it, id, d, thinking = false) {
  const bot = commUser(it.botId);
  return {
    id, ephemeral: true, interaction_id: it.id, channel: it.cid, server: it.sid, system: false, author: auth.userView(bot), body: d.content ?? '', embeds: d.embeds || undefined,
    components: d.components || undefined, attachments: d.attachments || [], created_at: d.created_at || Date.now(), edited_at: d.edited_at || null, thinking: thinking || undefined,
    interaction: it.type === 2 ? { id: it.id, type: 2, name: it.name, user: { id: commUser(it.userId)?.principal, username: commUser(it.userId)?.username } } : undefined,
  };
}
function ephDiscord(it, v) {
  const ch = channelOf(it);
  return {
    id: String(v.id), channel_id: String(ch?.id), guild_id: String(it.communityId), type: 0, content: v.body, author: B().userObj(commUser(it.botId)), embeds: v.embeds || [], components: v.components || [],
    attachments: (v.attachments || []).map((a, i) => ({ id: String(i), filename: a.name, url: a.url, size: a.size || 0 })), mentions: [], mention_roles: [], mention_everyone: false, pinned: false, tts: false, flags: EPHEMERAL,
    timestamp: new Date(v.created_at).toISOString(), edited_timestamp: v.edited_at ? new Date(v.edited_at).toISOString() : null, webhook_id: String(it.botId), application_id: String(it.botId),
  };
}
function push(it, op, message) {
  if (op !== 'delete') { it.eph.set(message.id, message); ephIndex.set(message.id, it); } else { it.eph.delete(message.id); ephIndex.delete(message.id); }
  gateway.pushToUser(it.userId, { type: 'chat_interaction_message', op, server: it.sid, channel: it.cid, message: op === 'delete' ? { id: message.id, channel: it.cid, server: it.sid } : message });
}

async function prepare(it, data, files) {
  const c = db.get('SELECT * FROM communities WHERE id = ?', it.communityId), snap = C.snapOf(c), bot = commUser(it.botId);
  data = data && typeof data === 'object' ? data : {};
  const fl = W.withFiles(files, data.embeds, bot.id);
  return {
    c, snap, bot, flags: Number(data.flags) || 0,
    text: data.content === undefined ? undefined : B().textIn(c, snap, data.content, data.allowed_mentions),
    embeds: data.embeds === undefined ? undefined : W.cleanEmbeds(fl.embeds),
    components: data.components === undefined ? undefined : comps.clean(data.components),
    attachments: fl.atts.length ? fl.atts : undefined,
  };
}
const meta = it => (it.type === 2 ? { id: it.id, type: 2, name: it.name, user: (u => ({ id: u.principal, username: u.username }))(commUser(it.userId)) } : undefined);

async function postReal(it, p) {
  const ctx = M().ctxOf(channelOf(it));
  const msg = await M().postMessage(p.bot, ctx, p.text ?? '', { embeds: p.embeds, attachments: p.attachments, components: p.components, interaction: meta(it), force: true });
  it.msgIds.add(Number(msg.id));
  return msg;
}
function putEph(it, p, id = newId(), keep = null) {
  const view = ephView(it, id, {
    content: p.text ?? keep?.body ?? '', embeds: p.embeds ?? keep?.embeds, components: p.components ?? keep?.components, attachments: p.attachments ?? keep?.attachments,
    created_at: keep?.created_at, edited_at: keep ? Date.now() : null,
  });
  push(it, keep ? 'update' : 'create', view);
  return view;
}
const empty = p => !(p.text || '').trim() && !p.embeds?.length && !p.attachments?.length && !p.components?.length;

async function callback(id, token, body, files) {
  const it = find(id, token);
  if (it.acked) throw err('already_acknowledged', 400);
  const type = Number(body?.type), data = body?.data;
  const ok = it.type === 4 ? [8] : it.message ? [4, 5, 6, 7, 9] : [4, 5, 9];
  if (!ok.includes(type)) throw err('invalid_form_body', 400, { message: 'Invalid Form Body: type: this interaction cannot be answered like that' });
  if (type === 8) {
    const choices = (Array.isArray(data?.choices) ? data.choices : []).slice(0, 25).map(x => ({ name: String(x?.name ?? '').slice(0, 100), value: typeof x?.value === 'number' ? x.value : String(x?.value ?? '').slice(0, 100) })).filter(x => x.name);
    it.acked = true;
    it.autocomplete?.(choices);
    return;
  }
  if (type === 9) {
    const m = comps.modal(data);
    it.acked = true; it.modal = m;
    gateway.pushToUser(it.userId, { type: 'chat_interaction_modal', server: it.sid, channel: it.cid, interaction: it.id, modal: m });
    return;
  }
  if (type === 6) { it.acked = true; return; }
  const p = await prepare(it, data, files);
  if (type === 4 || type === 7) {
    if (type === 4 && empty(p)) throw err('empty_message');
    if (type === 7) { await updateMessage(it, p); it.acked = true; return; }
    it.ephemeral = !!(p.flags & EPHEMERAL);
    if (it.ephemeral) it.origEph = putEph(it, p).id;
    else it.msgId = (await postReal(it, p)).id;
    it.acked = true; it.origDone = true;
    return;
  }
  it.acked = true; it.deferred = true; it.ephemeral = !!(p.flags & EPHEMERAL);
  if (it.ephemeral) { const v = ephView(it, newId(), {}, true); it.origEph = v.id; push(it, 'create', v); it.thinking = true; return; }
  const ctx = M().ctxOf(channelOf(it));
  const msg = M().insertMessage(ctx, { userId: p.bot.id, body: '', interaction: { ...meta(it), thinking: true } });
  it.msgId = msg.id; it.msgIds.add(Number(msg.id)); it.thinking = true;
}
async function updateMessage(it, p) {
  if (it.message.eph) {
    const owner = ephIndex.get(it.message.eph), keep = owner?.eph.get(it.message.eph);
    if (!keep) throw err('unknown_message', 404);
    putEphOn(owner, p, keep);
    return;
  }
  await M().editMessage(it.message.real, p.bot, p.text, { embeds: p.embeds, components: p.components, attachments: p.attachments });
}
function putEphOn(owner, p, keep) {
  const view = ephView(owner, keep.id, { content: p.text ?? keep.body, embeds: p.embeds ?? keep.embeds, components: p.components ?? keep.components, attachments: p.attachments ?? keep.attachments, created_at: keep.created_at, edited_at: Date.now() });
  push(owner, 'update', view);
}

// first followup after a defer fills the thinking message, the rest are new messages
async function followup(token, appId, body, files) {
  const it = forWebhook(token, appId);
  if (!it.acked) throw err('unknown_webhook', 404);
  const p = await prepare(it, body, files);
  if (it.deferred && !it.origDone) {
    if (empty(p)) throw err('empty_message');
    it.origDone = true; it.thinking = false;
    if (it.ephemeral) return ephDiscord(it, putEphOn2(it, p, it.eph.get(it.origEph)));
    const msg = await M().editMessage(it.msgId, p.bot, p.text ?? '', { embeds: p.embeds, components: p.components, attachments: p.attachments, interaction: meta(it) || null, silent: true });
    return realObj(it, msg);
  }
  if (empty(p)) throw err('empty_message');
  if (p.flags & EPHEMERAL) return ephDiscord(it, putEph(it, p));
  return realObj(it, await postReal(it, p));
}
function putEphOn2(it, p, keep) { putEphOn(it, p, keep); return it.eph.get(keep.id); }
const realObj = (it, msg) => {
  const ch = channelOf(it), c = db.get('SELECT * FROM communities WHERE id = ?', it.communityId), snap = C.snapOf(c);
  return B().messageObj(M().withReactions([M().viewById(msg.id, snap)])[0], c, snap, ch);
};

function targetOf(it, mid) {
  if (mid === '@original') {
    if (it.origEph) return { eph: it.eph.get(it.origEph) };
    if (it.msgId) return { real: it.msgId };
    throw err('unknown_message', 404);
  }
  if (it.eph.has(String(mid))) return { eph: it.eph.get(String(mid)) };
  if (/^\d{1,15}$/.test(String(mid)) && it.msgIds.has(Number(mid))) return { real: Number(mid) };
  throw err('unknown_message', 404);
}
async function getMessage(token, appId, mid) {
  const it = forWebhook(token, appId);
  const t = targetOf(it, mid);
  return t.eph ? ephDiscord(it, t.eph) : realObj(it, { id: t.real });
}
async function editFollowup(token, appId, mid, body, files) {
  const it = forWebhook(token, appId);
  const t = targetOf(it, mid);
  const p = await prepare(it, body, files);
  const first = (mid === '@original' || mid === String(it.origEph) || Number(mid) === it.msgId) && !it.origDone && it.deferred;
  if (first) { it.origDone = true; it.thinking = false; }
  if (t.eph) { putEphOn(it, p, t.eph); return ephDiscord(it, it.eph.get(t.eph.id)); }
  const msg = await M().editMessage(t.real, p.bot, p.text, { embeds: p.embeds, components: p.components, attachments: p.attachments, ...(first ? { interaction: meta(it) || null, silent: true } : {}) });
  return realObj(it, msg);
}
function deleteFollowup(token, appId, mid) {
  const it = forWebhook(token, appId);
  const t = targetOf(it, mid);
  if (t.eph) { push(it, 'delete', t.eph); return; }
  M().deleteMessage(t.real, commUser(it.botId));
  it.msgIds.delete(t.real);
}

const limitFor = me => { if (!runLimit.hit(me.id)) throw err('rate_limited', 429); };
function ready(me, c, snap, ch) {
  if (!snap.canPost(ch, me.id)) throw err('no_send_permission', 403);
  const until = MOD().timeoutUntil(c, me.id);
  if (until) throw err('timed_out', 403, { until });
}
function send(it, payload, bot) {
  if (!B().sendToBot(bot.id, 'INTERACTION_CREATE', payload)) { expire(it); throw err('bot_offline', 409); }
}
function commandFor(c, snap, me, ch, id) {
  const r = K.usable(c, snap, me.id, ch).find(x => String(x.id) === String(id));
  if (!r) throw err('unknown_command', 404);
  return r;
}
function typeNames(path, r) { return [r.name, ...path].join(' '); }

async function invoke(me, sid, body) {
  const { c, snap } = C.memberCommunity(sid, me);
  limitFor(me);
  const { ch } = C.findChannel(body?.channel, me);
  if (ch.community_id !== c.id) throw err('channel_not_found', 404);
  const type = Number(body?.type);
  if (type === 2 || type === 4) return runCommand(me, c, snap, ch, body, type === 4);
  if (type === 3) return runComponent(me, c, snap, ch, body);
  if (type === 5) return runModal(me, c, snap, ch, body);
  throw err('bad_interaction');
}

async function runCommand(me, c, snap, ch, body, autocomplete) {
  ready(me, c, snap, ch);
  const r = commandFor(c, snap, me, ch, body.command);
  const bot = commUser(r.bot_id);
  const path = Array.isArray(body.path) ? body.path.map(String).slice(0, 2) : [];
  const ctx = { ...resolver(c, snap, ch), snap };
  const data = { id: String(r.id), name: r.name, type: r.type, guild_id: String(c.id) };
  if (r.type === K.TYPE.CHAT) {
    data.options = buildOptions(K.json(r.options, []), path, body.values || {}, ctx, me, { focused: autocomplete ? String(body.focused || '') : null, lenient: autocomplete });
  } else if (r.type === K.TYPE.USER) {
    const id = ctx.user(String(body.target));
    if (!id) throw err('user_not_found', 404);
    data.target_id = id;
  } else {
    const row = /^\d{1,15}$/.test(String(body.target)) && db.get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', Number(body.target), ch.id);
    if (!row) throw err('message_not_found', 404);
    const view = M().withReactions([M().viewById(row.id, snap)])[0];
    ctx.resolved.messages[row.id] = B().messageObj(view, c, snap);
    data.target_id = String(row.id);
  }
  if (Object.values(ctx.resolved).some(x => Object.keys(x).length)) data.resolved = Object.fromEntries(Object.entries(ctx.resolved).filter(([, v]) => Object.keys(v).length));
  const it = open({ bot, c, ch, user: me, type: autocomplete ? 4 : 2, name: typeNames(path, r) });
  const payload = basePayload(it, c, snap, ch, me, bot, autocomplete ? 4 : 2, data);
  if (autocomplete) {
    const answer = new Promise(resolve => { it.autocomplete = resolve; setTimeout(() => resolve([]), AUTOCOMPLETE_MS).unref(); });
    send(it, payload, bot);
    const choices = await answer;
    expire(it);
    return { choices };
  }
  send(it, payload, bot);
  armAck(it);
  return { id: it.id };
}

function messageTarget(me, c, snap, ch, id) {
  const eph = ephIndex.get(String(id));
  if (eph && eph.userId === me.id) return { eph: eph.eph.get(String(id)), owner: eph, botId: eph.botId };
  const row = /^\d{1,15}$/.test(String(id)) && db.get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', Number(id), ch.id);
  if (!row || !row.user_id) throw err('message_not_found', 404);
  if (auth.userById(row.user_id)?.kind !== 'bot' || !snap.isMember(row.user_id)) throw err('message_not_found', 404);
  return { row, botId: row.user_id };
}
function pickValues(def, picked, ctx, me) {
  const list = (Array.isArray(picked) ? picked : []).map(String).slice(0, 25);
  if (list.length < def.min_values || list.length > def.max_values) throw bad(def.custom_id, 'wrong number of choices');
  if (def.type === 3) {
    if (!list.every(v => def.options.some(o => o.value === v))) throw bad(def.custom_id, 'not one of the options');
    return list;
  }
  const out = list.map(v => (def.type === 6 ? ctx.user(v) : def.type === 8 ? ctx.role(v) : def.type === 5 ? ctx.user(v) : def.type === 7 ? (/^r[0-9a-f]{10}$/.test(v) ? ctx.role(v) : ctx.user(v)) : null));
  if (out.some(x => !x)) throw bad(def.custom_id, 'unknown choice');
  return out;
}
async function runComponent(me, c, snap, ch, body) {
  ready(me, c, snap, ch);
  const t = messageTarget(me, c, snap, ch, body.message);
  const bot = commUser(t.botId);
  const message = t.eph ? ephDiscord(t.owner, t.eph) : B().messageObj(M().withReactions([M().viewById(t.row.id, snap)])[0], c, snap);
  const def = comps.find(t.eph ? t.eph.components : K.json(t.row.components, []), String(body.custom_id));
  if (!def || def.disabled || def.type === 2 && def.style === 5) throw err('unknown_component', 404);
  const ctx = { ...resolver(c, snap, ch), snap };
  const data = { custom_id: def.custom_id, component_type: def.type };
  if (def.type !== 2) {
    data.values = pickValues(def, body.selected, ctx, me);
    if (def.type !== 3) data.resolved = Object.fromEntries(Object.entries(ctx.resolved).filter(([, v]) => Object.keys(v).length));
  }
  const it = open({ bot, c, ch, user: me, type: 3, name: def.custom_id });
  it.message = t.eph ? { eph: t.eph.id } : { real: t.row.id };
  send(it, basePayload(it, c, snap, ch, me, bot, 3, data, { message }), bot);
  armAck(it);
  return { id: it.id };
}

async function runModal(me, c, snap, ch, body) {
  const source = live.get(String(body.source));
  if (!source || source.userId !== me.id || !source.modal || source.modalUsed) throw err('unknown_interaction', 404);
  const bot = commUser(source.botId);
  const inputs = comps.inputsOf(source.modal), fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
  const values = {};
  for (const inp of inputs) {
    const v = String(fields[inp.custom_id] ?? '');
    if (inp.required && !v.trim()) throw bad(inp.custom_id, 'required');
    if (v && inp.min_length != null && v.length < inp.min_length) throw bad(inp.custom_id, `at least ${inp.min_length} characters`);
    if (inp.max_length != null && v.length > inp.max_length) throw bad(inp.custom_id, `at most ${inp.max_length} characters`);
    values[inp.custom_id] = v;
  }
  source.modalUsed = true;
  const data = {
    custom_id: source.modal.custom_id,
    components: source.modal.components.map(r => (r.type === 18
      ? { type: 18, component: { type: 4, custom_id: r.component.custom_id, value: values[r.component.custom_id] } }
      : { type: 1, components: [{ type: 4, custom_id: r.components[0].custom_id, value: values[r.components[0].custom_id] }] })),
  };
  const it = open({ bot, c, ch: channelOf(source), user: me, type: 5, name: source.modal.custom_id });
  if (source.message) it.message = source.message;
  const extra = {};
  if (source.message?.real) { const row = db.get('SELECT id FROM messages WHERE id = ?', source.message.real); if (row) extra.message = B().messageObj(M().withReactions([M().viewById(row.id, snap)])[0], c, snap); }
  send(it, basePayload(it, c, snap, channelOf(source), me, bot, 5, data, extra), bot);
  armAck(it);
  return { id: it.id };
}

function start() { db.run(`DELETE FROM messages WHERE interaction LIKE '%"thinking":true%'`); }
function stop() { for (const it of [...live.values()]) it.timers.forEach(clearTimeout); live.clear(); ephIndex.clear(); }
function dismiss(me, id) {
  const it = ephIndex.get(String(id));
  if (it && it.userId === me.id) { it.eph.delete(String(id)); ephIndex.delete(String(id)); }
}

module.exports = { invoke, callback, followup, getMessage, editFollowup, deleteFollowup, start, stop, dismiss, _live: live };
