'use strict';
// Permission bits + the permission algorithm (ported from Nookara chat.js permsOf / channelPermsOf / canView / canPost / topPosition).
// Everything here is a pure function of plain data, so it can be unit-tested without a database.
//
//   roles       [{ id, permissions, is_default, position }]
//   roleIds     Set of role ids the member holds (@everyone is implicit)
//   overwrites  Map(roleId -> { allow, deny }) for one channel (its own, or its category's while it is synced)
//   member      { allow, deny } of the member's own overwrite there, or null
const P = {
  SEND: 1, MANAGE_CHANNELS: 2, MANAGE_SERVER: 4, MANAGE_ROLES: 8, KICK: 16, BAN: 32,
  MANAGE_MESSAGES: 64, MENTION_EVERYONE: 128, ATTACH: 256, ADMIN: 512,
  MANAGE_USERS: 2048, // last login of members and the page each message was sent from (Nookara's own chat also shows invisible people and devices)
  VIEW: 1024, // channel-level only
  UNMARKED_ALIASES: 4096, // a bot's alias messages show with no alias mark, when the server's Danger zone turns unmarked aliases on (messages.js)
  CHANGE_NICKNAME: 8192, // set your own server nickname (@everyone has it by default)
  MANAGE_NICKNAMES: 16384, // set anyone's server nickname whose top role is below yours (your own too)
  CUSTOMIZE_PROFILE: 32768, // your own picture, banner, name colour, bio, pronouns and name on this server only (server-profile.js)
  // channel permissions (PROTOCOL §6.5), also on roles for the whole server; @everyone has all of these by default but pinning
  ADD_REACTIONS: 1 << 16,       // react (a new emoji, or one already on the message)
  EMBED_LINKS: 1 << 17,         // links in your messages get previews
  READ_HISTORY: 1 << 18,        // see messages sent before you opened the channel (history, search, pins); live ones come either way
  USE_EXTERNAL_EMOJIS: 1 << 19, // custom emojis and stickers of other servers in messages and reactions
  PIN_MESSAGES: 1 << 20,        // pin and unpin (Manage messages also may)
  CONNECT: 1 << 21,             // join a voice channel
  SPEAK: 1 << 22,               // send your microphone there
  VIDEO: 1 << 23,               // send your camera there
  STREAM: 1 << 24,              // share your screen there
  USE_SOUNDBOARD: 1 << 25,      // play soundboard sounds there
};
// what an overwrite may allow / deny: the per-channel ones, plus Manage channels (= manage this channel) and Manage roles (= manage
// this channel's permissions). Server-wide ones (Administrator, Manage server, kick, ban, nicknames, ...) are not channel things
const CHANNEL_BITS = P.VIEW | P.SEND | P.ATTACH | P.EMBED_LINKS | P.ADD_REACTIONS | P.MENTION_EVERYONE | P.MANAGE_MESSAGES | P.PIN_MESSAGES
  | P.READ_HISTORY | P.USE_EXTERNAL_EMOJIS | P.CONNECT | P.SPEAK | P.VIDEO | P.STREAM | P.USE_SOUNDBOARD | P.MANAGE_CHANNELS | P.MANAGE_ROLES;
const MEMBER_DEFAULT = P.ADD_REACTIONS | P.EMBED_LINKS | P.READ_HISTORY | P.USE_EXTERNAL_EMOJIS | P.CONNECT | P.SPEAK | P.VIDEO | P.STREAM | P.USE_SOUNDBOARD;
const ALL_PERMS = 1023 | P.MANAGE_USERS | P.UNMARKED_ALIASES | P.CHANGE_NICKNAME | P.MANAGE_NICKNAMES | P.CUSTOMIZE_PROFILE | MEMBER_DEFAULT | P.PIN_MESSAGES;
const EVERYONE_DEFAULT = P.SEND | P.ATTACH | P.CHANGE_NICKNAME | MEMBER_DEFAULT;
// the names APIs show next to the bits (an overwrite's bits in a channel use the channel names: Manage channels is
// manage_channel there, Manage roles is manage_permissions)
const NAMES = {
  view_channel: P.VIEW, send_messages: P.SEND, attach_files: P.ATTACH, embed_links: P.EMBED_LINKS, add_reactions: P.ADD_REACTIONS,
  mention_everyone: P.MENTION_EVERYONE, manage_messages: P.MANAGE_MESSAGES, pin_messages: P.PIN_MESSAGES, read_message_history: P.READ_HISTORY,
  use_external_emojis: P.USE_EXTERNAL_EMOJIS, connect: P.CONNECT, speak: P.SPEAK, video: P.VIDEO, stream: P.STREAM, use_soundboard: P.USE_SOUNDBOARD,
  manage_channel: P.MANAGE_CHANNELS, manage_permissions: P.MANAGE_ROLES,
};
const SERVER_NAMES = {
  administrator: P.ADMIN, manage_server: P.MANAGE_SERVER, manage_channels: P.MANAGE_CHANNELS, manage_roles: P.MANAGE_ROLES, kick_members: P.KICK,
  ban_members: P.BAN, manage_users: P.MANAGE_USERS, unmarked_aliases: P.UNMARKED_ALIASES, change_nickname: P.CHANGE_NICKNAME,
  manage_nicknames: P.MANAGE_NICKNAMES, customize_profile: P.CUSTOMIZE_PROFILE,
};
// a role's names: the server ones and the channel ones (without the two channel spellings of Manage channels / Manage roles)
const ROLE_NAMES = { ...SERVER_NAMES, ...Object.fromEntries(Object.entries(NAMES).filter(([n]) => n !== 'manage_channel' && n !== 'manage_permissions')) };
const namesOf = (bits, table = NAMES) => Object.entries(table).filter(([, b]) => (bits & b) === b).map(([n]) => n);
// bits from a number, or from a list of names (either table): -> number, or null for something it does not know
function bitsFrom(v, table = { ...SERVER_NAMES, ...NAMES }) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : null; }
  if (!Array.isArray(v)) return null;
  let b = 0;
  for (const n of v) { if (!(n in table)) return null; b |= table[n]; }
  return b;
}

// a role's bits from before the channel permissions (old databases, old exports): what it allowed stays allowed. @everyone gets
// the member ones (the voice ones only with Send messages, which joining voice used to need); Send gives voice; Manage messages
// gives Pin messages
const VOICE_BITS = P.CONNECT | P.SPEAK | P.VIDEO | P.STREAM | P.USE_SOUNDBOARD;
function upgradeRole(bits, isDefault) {
  let b = Number(bits) || 0;
  if (isDefault) b |= MEMBER_DEFAULT & ~VOICE_BITS;
  if (b & P.SEND) b |= VOICE_BITS;
  if (b & P.MANAGE_MESSAGES) b |= P.PIN_MESSAGES;
  return b;
}
// an old overwrite (see / send / attach) on a voice channel: its send allow / deny also covers the voice ones
const upgradeOverwrite = (o, voice) => (voice && (o & P.SEND) ? o | VOICE_BITS : o);
// community-wide permissions: owner = all, Administrator = all, otherwise OR of @everyone + held roles
function basePerms({ isMember = true, isOwner = false, roles = [], roleIds = new Set() }) {
  if (!isMember) return 0;
  if (isOwner) return ALL_PERMS;
  let p = 0;
  for (const r of roles) if (r.is_default || roleIds.has(r.id)) p |= Number(r.permissions);
  return (p & P.ADMIN) ? ALL_PERMS : p;
}

// one channel, like Discord: the server permissions, then the channel's @everyone overwrite, then the member's roles' overwrites
// (their denies OR'd and taken away, then their allows OR'd and given), then the member's own overwrite (deny, then allow).
// The owner and Administrator skip all of it
function channelPerms(base, { overwrites = null, everyoneId = null, roleIds = new Set(), member = null } = {}) {
  if (base === ALL_PERMS) return ALL_PERMS | P.VIEW;
  let p = base | P.VIEW;
  if (overwrites && overwrites.size) {
    const e = everyoneId != null ? overwrites.get(everyoneId) : null;
    if (e) p = (p & ~e.deny) | e.allow;
    let allow = 0, deny = 0;
    for (const rid of roleIds) { const o = overwrites.get(rid); if (o) { allow |= o.allow; deny |= o.deny; } }
    p = (p & ~deny) | allow;
  }
  if (member) p = (p & ~member.deny) | member.allow;
  return p;
}

// people who manage channels (or administrate) always see every channel so they can fix it
function canView(base, chPerms, isMember = true) {
  return !!isMember && (base === ALL_PERMS || (base & (P.ADMIN | P.MANAGE_CHANNELS)) !== 0 || (chPerms & P.VIEW) !== 0);
}

// Ember Link game channels override visibility: console = Manage server only (even over Manage channels), not set up yet =
// managers only. -> true (visible), false (hidden) or null (the normal rules)
function gameView(channel, base) {
  if ((channel.type || 'text') !== 'game') return null;
  const cfg = cfgOf(channel);
  if (cfg.purpose === 'console') return (base & P.MANAGE_SERVER) !== 0;
  if (!cfg.instance || !cfg.purpose) return (base & (P.ADMIN | P.MANAGE_SERVER | P.MANAGE_CHANNELS)) !== 0;
  return null;
}

// which channel types have no chat at all / only managers (or webhooks) post / take messages only when `allow_chat` is on
const NO_CHAT = new Set(['voice', 'roles', 'link', 'starboard']);
const cfgOf = ch => { const c = ch.config; if (c && typeof c === 'object') return c; try { return JSON.parse(c || '{}') || {}; } catch { return {}; } };
// no-chat types (voice, roles shop, link, starboard) never take messages; logs, welcome (unless allow_chat) and locked channels
// need MANAGE_MESSAGES; otherwise SEND in the channel
function canPost(channel, base, chPerms, isMember = true) {
  if (!isMember) return false;
  const type = channel.type || 'text';
  if (NO_CHAT.has(type)) return false;
  if (type === 'game' && cfgOf(channel).purpose !== 'chat') return false; // Ember Link: only synced-chat game channels take messages
  if (type === 'logs' && cfgOf(channel).mode === 'cloudlink' && !channel.locked) return canView(base, chPerms, isMember) && (chPerms & P.SEND) !== 0; // CloudLink bridge: chat both ways
  if (type === 'logs' || (type === 'welcome' && !cfgOf(channel).allow_chat) || channel.locked) return (base & P.MANAGE_MESSAGES) !== 0;
  return canView(base, chPerms, isMember) && (chPerms & P.SEND) !== 0;
}

// how high someone sits (their highest role); you can only manage people and roles below you
function topPosition(roles, roleIds, isOwner) {
  if (isOwner) return Infinity;
  let top = 0;
  for (const r of roles) if (!r.is_default && roleIds.has(r.id)) top = Math.max(top, r.position);
  return top;
}

// you can't hand out permissions you don't have yourself, and can't strip ones you lack
const grantable = (requested, actorPerms, existing = 0) => (((Number(requested) || 0) & ALL_PERMS & actorPerms) | (Number(existing) & ~actorPerms)) & ALL_PERMS;

// may `actor` edit this role? (needs MANAGE_ROLES and the role must sit below the actor; @everyone is always editable)
const canManageRole = (actorPerms, actorTop, role) => (actorPerms & P.MANAGE_ROLES) !== 0 && (!role || !!role.is_default || role.position < actorTop);

// 'owner' / 'admin' (has Administrator) / 'member' - the little chip on profiles
const roleLabel = (isOwner, base) => (isOwner ? 'owner' : base === ALL_PERMS ? 'admin' : 'member');

module.exports = { NO_CHAT, gameView, P, CHANNEL_BITS, VOICE_BITS, upgradeRole, upgradeOverwrite, ALL_PERMS, EVERYONE_DEFAULT, MEMBER_DEFAULT, NAMES, SERVER_NAMES, ROLE_NAMES, namesOf, bitsFrom, basePerms, channelPerms, canView, canPost, topPosition, grantable, canManageRole, roleLabel };
