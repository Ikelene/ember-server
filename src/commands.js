'use strict';
// bot commands, discord dialect (protocol 14.2): slash (1), user menu (2), message menu (3)
// who can run one: owner/admin always, else default_member_permissions unless a manager set overwrites (bot_command_perms)
const db = require('./db');
const auth = require('./auth');
const C = require('./communities');
const { P, ALL_PERMS } = require('./perms');
const { err, now } = require('./util');

const B = () => require('./bots');
const TYPE = { CHAT: 1, USER: 2, MESSAGE: 3 };
const OPT = { SUB: 1, GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10, ATTACHMENT: 11 };
const LIMITS = { [TYPE.CHAT]: 100, [TYPE.USER]: 15, [TYPE.MESSAGE]: 15 };
const CHAT_NAME = /^[-_'\p{L}\p{N}\p{M}]{1,32}$/u;
const MENU_NAME = /^[-_' \p{L}\p{N}\p{M}]{1,32}$/u;
const MAX_INT = 2 ** 53;
const bad = (path, reason) => err('invalid_form_body', 400, { message: `Invalid Form Body: ${path}: ${reason}` });

function locals(v, path) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw bad(path, 'must be an object');
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, 40)) if (typeof x === 'string' && x) out[String(k).slice(0, 12)] = x.slice(0, 100);
  return Object.keys(out).length ? out : null;
}
function cleanChoices(list, type, path) {
  if (list == null) return undefined;
  if (!Array.isArray(list) || list.length > 25) throw bad(path, 'choices must be a list of up to 25');
  return list.map((ch, i) => {
    const name = String(ch?.name ?? '');
    if (!name || name.length > 100) throw bad(`${path}[${i}].name`, 'must be 1 to 100 characters');
    let value = ch.value;
    if (type === OPT.STRING) { if (typeof value !== 'string' || !value || value.length > 100) throw bad(`${path}[${i}].value`, 'must be a string of 1 to 100 characters'); }
    else if (type === OPT.INTEGER) { if (!Number.isInteger(value) || Math.abs(value) > MAX_INT) throw bad(`${path}[${i}].value`, 'must be an integer'); }
    else if (typeof value !== 'number' || !Number.isFinite(value)) throw bad(`${path}[${i}].value`, 'must be a number');
    return { name, value, ...(locals(ch.name_localizations, `${path}[${i}].name_localizations`) ? { name_localizations: locals(ch.name_localizations, path) } : {}) };
  });
}
function cleanOptions(list, path = 'options', level = 0) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 25) throw bad(path, 'must be a list of up to 25');
  const names = new Set();
  let sawOptional = false, subs = 0;
  const out = list.map((o, i) => {
    const p = `${path}[${i}]`;
    if (!o || typeof o !== 'object') throw bad(p, 'must be an object');
    const type = Number(o.type);
    if (!Number.isInteger(type) || type < 1 || type > 11) throw bad(`${p}.type`, 'unknown option type');
    const name = String(o.name ?? '');
    if (!CHAT_NAME.test(name) || name !== name.toLowerCase()) throw bad(`${p}.name`, 'must be 1 to 32 lowercase letters, numbers, - or _');
    if (names.has(name)) throw bad(`${p}.name`, 'is used twice');
    names.add(name);
    const description = String(o.description ?? '');
    if (!description || description.length > 100) throw bad(`${p}.description`, 'must be 1 to 100 characters');
    const out = { type, name, description };
    const nl = locals(o.name_localizations, `${p}.name_localizations`), dl = locals(o.description_localizations, `${p}.description_localizations`);
    if (nl) out.name_localizations = nl;
    if (dl) out.description_localizations = dl;
    if (type === OPT.SUB || type === OPT.GROUP) {
      subs++;
      if (level >= (type === OPT.GROUP ? 1 : 2)) throw bad(`${p}.type`, 'subcommands cannot be nested that deep');
      if (type === OPT.GROUP && !(o.options || []).every(x => Number(x?.type) === OPT.SUB)) throw bad(`${p}.options`, 'a group holds only subcommands');
      out.options = cleanOptions(o.options, `${p}.options`, level + (type === OPT.GROUP ? 1 : 2));
      if (type === OPT.GROUP && !out.options.length) throw bad(`${p}.options`, 'a group needs at least one subcommand');
      return out;
    }
    out.required = !!o.required;
    if (out.required && sawOptional) throw bad(`${p}.required`, 'required options must come before optional ones');
    if (!out.required) sawOptional = true;
    if (type === OPT.STRING || type === OPT.INTEGER || type === OPT.NUMBER) {
      const choices = cleanChoices(o.choices, type, `${p}.choices`);
      if (choices) out.choices = choices;
      if (o.autocomplete) { if (choices?.length) throw bad(`${p}.autocomplete`, 'cannot be used with choices'); out.autocomplete = true; }
    }
    if (type === OPT.STRING) {
      if (o.min_length != null) { if (!Number.isInteger(o.min_length) || o.min_length < 0 || o.min_length > 6000) throw bad(`${p}.min_length`, 'must be 0 to 6000'); out.min_length = o.min_length; }
      if (o.max_length != null) { if (!Number.isInteger(o.max_length) || o.max_length < 1 || o.max_length > 6000) throw bad(`${p}.max_length`, 'must be 1 to 6000'); out.max_length = o.max_length; }
    }
    if (type === OPT.INTEGER || type === OPT.NUMBER) {
      for (const k of ['min_value', 'max_value']) {
        if (o[k] == null) continue;
        if (typeof o[k] !== 'number' || !Number.isFinite(o[k]) || (type === OPT.INTEGER && !Number.isInteger(o[k]))) throw bad(`${p}.${k}`, type === OPT.INTEGER ? 'must be an integer' : 'must be a number');
        out[k] = o[k];
      }
    }
    if (type === OPT.CHANNEL && Array.isArray(o.channel_types)) out.channel_types = o.channel_types.filter(Number.isInteger).slice(0, 10);
    return out;
  });
  if (subs && subs !== out.length) throw bad(path, 'subcommands cannot be mixed with other options');
  return out;
}
function cleanCommand(body, partial = false) {
  if (!body || typeof body !== 'object') throw bad('body', 'must be an object');
  const type = body.type == null ? TYPE.CHAT : Number(body.type);
  if (!LIMITS[type]) throw bad('type', 'must be 1, 2 or 3');
  const out = { type };
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '');
    if (type === TYPE.CHAT ? !CHAT_NAME.test(name) || name !== name.toLowerCase() : !MENU_NAME.test(name) || !name.trim()) throw bad('name', type === TYPE.CHAT ? 'must be 1 to 32 lowercase letters, numbers, - or _' : 'must be 1 to 32 characters');
    out.name = name;
  }
  if (!partial || body.description !== undefined) {
    const description = type === TYPE.CHAT ? String(body.description ?? '') : '';
    if (type === TYPE.CHAT && (!description || description.length > 100)) throw bad('description', 'must be 1 to 100 characters');
    out.description = description;
  }
  if (!partial || body.options !== undefined) out.options = type === TYPE.CHAT ? cleanOptions(body.options) : [];
  if (!partial || body.name_localizations !== undefined) out.name_localizations = locals(body.name_localizations, 'name_localizations');
  if (!partial || body.description_localizations !== undefined) out.description_localizations = locals(body.description_localizations, 'description_localizations');
  if (!partial || body.default_member_permissions !== undefined) {
    const d = body.default_member_permissions;
    if (d != null && !/^\d{1,20}$/.test(String(d))) throw bad('default_member_permissions', 'must be a permission bit string');
    out.default_member_permissions = d == null ? null : String(d);
  }
  if (!partial || body.nsfw !== undefined) out.nsfw = body.nsfw ? 1 : 0;
  return out;
}

const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const row = id => db.get('SELECT * FROM bot_commands WHERE id = ?', Number(id) || 0);
const scopeSql = communityId => (communityId == null ? 'community_id IS NULL' : 'community_id = ?');
const scopeArgs = communityId => (communityId == null ? [] : [communityId]);
const obj = r => ({
  id: String(r.id), application_id: String(r.bot_id), version: String(r.updated_at), default_member_permissions: r.default_member_permissions, type: r.type,
  name: r.name, name_localizations: json(r.name_localizations, null), description: r.description, description_localizations: json(r.description_localizations, null),
  dm_permission: false, contexts: [0], integration_types: [0], options: json(r.options, []), nsfw: !!r.nsfw,
  ...(r.community_id != null ? { guild_id: String(r.community_id) } : {}),
});
const list = (botId, communityId) => db.all(`SELECT * FROM bot_commands WHERE bot_id = ? AND ${scopeSql(communityId)} ORDER BY id`, botId, ...scopeArgs(communityId));
function changed(botId, communityId) {
  const ids = communityId != null ? [communityId] : db.all('SELECT community_id FROM members WHERE user_id = ?', botId).map(r => r.community_id);
  for (const id of ids) pingCommunity(id);
}
const timers = new Map();
function pingCommunity(id) {
  if (timers.has(id)) return;
  const t = setTimeout(() => {
    timers.delete(id);
    const c = db.get('SELECT * FROM communities WHERE id = ?', id);
    if (c) require('./gateway').emit(id, { type: 'chat_commands_update', server: c.sid });
  }, 400);
  t.unref();
  timers.set(id, t);
}
function assertRoom(botId, communityId, type, exceptId = 0) {
  const n = db.get(`SELECT COUNT(*) AS n FROM bot_commands WHERE bot_id = ? AND ${scopeSql(communityId)} AND type = ? AND id <> ?`, botId, ...scopeArgs(communityId), type, exceptId).n;
  if (n >= LIMITS[type]) throw err('max_commands', 400, { message: 'Maximum number of application commands reached' });
}
function upsert(botId, communityId, body) {
  const f = cleanCommand(body);
  const have = db.get(`SELECT * FROM bot_commands WHERE bot_id = ? AND ${scopeSql(communityId)} AND type = ? AND name = ?`, botId, ...scopeArgs(communityId), f.type, f.name);
  const t = now();
  if (have) {
    db.run(`UPDATE bot_commands SET description = ?, options = ?, name_localizations = ?, description_localizations = ?, default_member_permissions = ?, nsfw = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      f.description, JSON.stringify(f.options), f.name_localizations && JSON.stringify(f.name_localizations), f.description_localizations && JSON.stringify(f.description_localizations), f.default_member_permissions, f.nsfw, t, have.id);
    return { row: row(have.id), created: false };
  }
  assertRoom(botId, communityId, f.type);
  const r = db.run('INSERT INTO bot_commands (bot_id, community_id, type, name, name_localizations, description, description_localizations, options, default_member_permissions, nsfw, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    botId, communityId, f.type, f.name, f.name_localizations && JSON.stringify(f.name_localizations), f.description, f.description_localizations && JSON.stringify(f.description_localizations), JSON.stringify(f.options), f.default_member_permissions, f.nsfw, t, t);
  return { row: row(r.lastInsertRowid), created: true };
}
function create(botId, communityId, body) { const out = db.tx(() => upsert(botId, communityId, body)); changed(botId, communityId); return out; }
function overwrite(botId, communityId, bodies) {
  if (!Array.isArray(bodies)) throw bad('body', 'must be a list of commands');
  const cleaned = bodies.map(b => cleanCommand(b));
  const seen = new Set();
  for (const f of cleaned) { const k = f.type + ':' + f.name; if (seen.has(k)) throw bad('name', `${f.name} is used twice`); seen.add(k); }
  const out = db.tx(() => {
    for (const r of list(botId, communityId)) if (!seen.has(r.type + ':' + r.name)) removeRow(r);
    return bodies.map(b => upsert(botId, communityId, b).row);
  });
  changed(botId, communityId);
  return out;
}
function ownRow(botId, communityId, id) {
  const r = row(id);
  if (!r || r.bot_id !== Number(botId) || (communityId == null ? r.community_id != null : r.community_id !== communityId)) throw err('unknown_command', 404);
  return r;
}
function patch(botId, communityId, id, body) {
  const r = ownRow(botId, communityId, id);
  const f = cleanCommand({ type: r.type, ...body }, true);
  if (f.name && f.name !== r.name && db.get(`SELECT 1 FROM bot_commands WHERE bot_id = ? AND ${scopeSql(communityId)} AND type = ? AND name = ? AND id <> ?`, botId, ...scopeArgs(communityId), r.type, f.name, r.id)) throw bad('name', 'is already used');
  const set = { ...f };
  delete set.type;
  for (const k of ['name_localizations', 'description_localizations']) if (k in set) set[k] = set[k] && JSON.stringify(set[k]);
  if ('options' in set) set.options = JSON.stringify(set.options);
  set.updated_at = now();
  const keys = Object.keys(set);
  db.run(`UPDATE bot_commands SET ${keys.map(k => k + ' = ?').join(', ')}, version = version + 1 WHERE id = ?`, ...keys.map(k => set[k]), r.id);
  changed(botId, communityId);
  return row(r.id);
}
function removeRow(r) {
  db.run('DELETE FROM bot_command_perms WHERE bot_id = ? AND command_id = ?', r.bot_id, r.id);
  db.run('DELETE FROM bot_commands WHERE id = ?', r.id);
}
function remove(botId, communityId, id) { removeRow(ownRow(botId, communityId, id)); changed(botId, communityId); }

// overwrites use ember ids (rid, principal, cid, 'all' = every channel)
const overwrites = (communityId, botId, commandId) => db.all('SELECT target_type, target_id, allow FROM bot_command_perms WHERE community_id = ? AND bot_id = ? AND command_id = ?', communityId, botId, commandId);
function needsBits(r) { return r.default_member_permissions == null ? null : BigInt(r.default_member_permissions); }
function allowed(c, snap, uid, ch, r) {
  const base = snap.perms(uid);
  if (base & P.ADMIN) return true;
  const own = overwrites(c.id, r.bot_id, r.id), all = overwrites(c.id, r.bot_id, 0);
  const members = [own, all].map(l => l.filter(x => x.target_type !== 3)).find(l => l.length) || [];
  const channels = [own, all].map(l => l.filter(x => x.target_type === 3)).find(l => l.length) || [];
  let ok = null;
  if (members.length) {
    const u = members.find(x => x.target_type === 2 && x.target_id === auth.userById(uid)?.principal);
    if (u) ok = !!u.allow;
    else {
      const held = new Set(snap.roles.filter(x => !x.is_default && snap.roleIds(uid).has(x.id)).map(x => x.rid));
      const mine = members.filter(x => x.target_type === 1 && held.has(x.target_id));
      if (mine.some(x => x.allow)) ok = true;
      else if (mine.length) ok = false;
      else { const e = members.find(x => x.target_type === 1 && x.target_id === snap.everyone?.rid); if (e) ok = !!e.allow; }
    }
  }
  if (ok === null) {
    const need = needsBits(r);
    ok = need === null ? true : (BigInt(B().permsToDiscord(base)) & need) === need;
  }
  if (ok && ch && channels.length) {
    const here = channels.find(x => x.target_id === ch.cid), every = channels.find(x => x.target_id === 'all');
    if (here) ok = !!here.allow; else if (every) ok = !!every.allow;
  }
  return ok;
}
function usable(c, snap, uid, ch = null) {
  const rows = db.all('SELECT bc.* FROM bot_commands bc JOIN members m ON m.user_id = bc.bot_id AND m.community_id = ? WHERE bc.community_id IS NULL OR bc.community_id = ? ORDER BY bc.bot_id, bc.type, bc.name', c.id, c.id);
  return rows.filter(r => allowed(c, snap, uid, ch, r));
}
function clientView(c, snap, me, ch = null) {
  const rows = usable(c, snap, me.id, ch);
  const botIds = [...new Set(rows.map(r => r.bot_id))];
  const bots = botIds.map(id => { const u = auth.userById(id); return { ...auth.userView(u), description: db.get('SELECT description FROM bots WHERE user_id = ?', id)?.description || '', online: B().isOnline(id) }; });
  return {
    bots,
    commands: rows.map(r => ({
      id: String(r.id), bot: auth.userById(r.bot_id).principal, type: r.type, name: r.name, description: r.description, options: json(r.options, []),
      nsfw: !!r.nsfw, guild: r.community_id != null, version: r.updated_at,
    })),
  };
}

const TARGET = { role: 1, user: 2, channel: 3 };
function setPerms(c, botId, commandId, list) {
  if (!Array.isArray(list) || list.length > 100) throw err('bad_permissions');
  if (commandId && ownRowAny(c, botId, commandId) === null) throw err('unknown_command', 404);
  const snap = C.snapOf(c);
  const rows = list.map(x => {
    const type = TARGET[x?.type] || 0;
    let id = String(x?.id ?? '');
    if (type === 1 && !snap.roles.some(r => r.rid === id)) throw err('role_not_found', 404);
    if (type === 2 && !snap.isMember(auth.userByPrincipal(id)?.id)) throw err('user_not_found', 404);
    if (type === 3 && id !== 'all' && !snap.channels.some(ch => ch.cid === id)) throw err('channel_not_found', 404);
    if (!type) throw err('bad_permissions');
    return [type, id, x.allow ? 1 : 0];
  });
  db.tx(() => {
    db.run('DELETE FROM bot_command_perms WHERE community_id = ? AND bot_id = ? AND command_id = ?', c.id, botId, Number(commandId) || 0);
    for (const [type, id, allow] of rows) db.run('INSERT OR REPLACE INTO bot_command_perms (community_id, bot_id, command_id, target_type, target_id, allow) VALUES (?, ?, ?, ?, ?, ?)', c.id, botId, Number(commandId) || 0, type, id, allow);
  });
  pingCommunity(c.id);
}
function ownRowAny(c, botId, id) { const r = row(id); return r && r.bot_id === Number(botId) && (r.community_id == null || r.community_id === c.id) ? r : null; }
function permsOf(c, botId, commandId) {
  return overwrites(c.id, botId, Number(commandId) || 0).map(x => ({ type: ['', 'role', 'user', 'channel'][x.target_type], id: x.target_id, allow: !!x.allow }));
}
function manageView(c) {
  const snap = C.snapOf(c);
  const bots = db.all("SELECT u.* FROM users u JOIN members m ON m.user_id = u.id WHERE m.community_id = ? AND u.kind = 'bot' ORDER BY u.username_lc", c.id);
  return {
    bots: bots.map(u => ({
      ...auth.userView(u), online: B().isOnline(u.id), perms: permsOf(c, u.id, 0),
      commands: db.all('SELECT * FROM bot_commands WHERE bot_id = ? AND (community_id IS NULL OR community_id = ?) ORDER BY type, name', u.id, c.id).map(r => ({
        id: String(r.id), type: r.type, name: r.name, description: r.description, guild: r.community_id != null, default_member_permissions: r.default_member_permissions, perms: permsOf(c, u.id, r.id),
      })),
    })),
    roles: snap.roles.map(r => ({ rid: r.rid, name: r.name, is_default: !!r.is_default })),
  };
}

function discordTargets(c, snap, rows) {
  return rows.map(x => {
    if (x.type === 'role') { const r = snap.roles.find(y => y.rid === x.id); return r && { id: r.is_default ? String(c.id) : String(B().ROLE_BASE + r.id), type: 1, permission: x.allow }; }
    if (x.type === 'user') { const u = auth.userByPrincipal(x.id); return u && { id: String(u.id), type: 2, permission: x.allow }; }
    const ch = x.id === 'all' ? null : snap.channels.find(y => y.cid === x.id);
    return x.id === 'all' ? { id: String(c.id - 1), type: 3, permission: x.allow } : ch && { id: String(ch.id), type: 3, permission: x.allow };
  }).filter(Boolean);
}
function nativeTargets(c, snap, list) {
  if (!Array.isArray(list)) throw err('bad_permissions');
  return list.map(x => {
    const type = Number(x?.type), id = String(x?.id ?? '');
    if (type === 1) { const r = Number(id) === c.id ? snap.roles.find(y => y.is_default) : snap.roles.find(y => B().ROLE_BASE + y.id === Number(id)); return r && { type: 'role', id: r.rid, allow: !!x.permission }; }
    if (type === 2) { const u = /^\d{1,15}$/.test(id) && auth.userById(Number(id)); return u && { type: 'user', id: u.principal, allow: !!x.permission }; }
    if (type === 3) { if (Number(id) === c.id - 1) return { type: 'channel', id: 'all', allow: !!x.permission }; const ch = snap.channels.find(y => y.id === Number(id)); return ch && { type: 'channel', id: ch.cid, allow: !!x.permission }; }
    return null;
  }).filter(Boolean);
}

module.exports = {
  TYPE, OPT, obj, row, list, create, overwrite, patch, remove, ownRow, usable, allowed, clientView, setPerms, permsOf, manageView, ownRowAny,
  discordTargets, nativeTargets, json, pingCommunity, cleanOptions, ALL_PERMS,
};
