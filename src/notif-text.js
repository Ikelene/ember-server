'use strict';
// Readable text for notifications (phone push, browser push, the Ember Android notification socket). A message body keeps
// Ember's tokens for the app to draw, but a notification can only show text, and raw tokens read as noise
// ("<:fire_cat:e1a2b3c4d5>", "<@&r0a1b2c3d4>"). Here they become what the app would show:
//   <:name:e…> / <a:name:e…>  -> :name:          (custom emoji; Unicode emoji stay as they are)
//   c:e…  (a reaction key)     -> :emoji:
//   <@&r…>                     -> @role (its name when the caller knows it)
//   <t:1700000000:R>           -> the date
//   ||spoiler||                -> [spoiler]       (a notification can't hide it, so it isn't shown)
// Only the notification copies change; what the app receives is untouched.
const EMOJI = /<a?:([A-Za-z0-9_]{1,32}):e[0-9a-f]{10}>/g;
const REACT_KEY = /(^|\s)c:e[0-9a-f]{10}(?=\s|$)/g;
const ROLE = /<@&(r[0-9a-f]{10})>/g;
const TIME = /<t:(-?\d{1,13})(?::[tTdDfFR])?>/g;
const SPOILER = /\|\|[\s\S]+?\|\|/g;

function when(sec) {
  const d = new Date(Number(sec) * 1000);
  if (Number.isNaN(d.getTime())) return 'a date';
  return d.toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' UTC';
}

// text -> readable text. roles: optional (rid) -> name
function readable(text, { roles } = {}) {
  if (text == null) return text;
  return String(text)
    .replace(SPOILER, '[spoiler]')
    .replace(EMOJI, (_, name) => `:${name}:`)
    .replace(REACT_KEY, (_, sp) => `${sp}:emoji:`)
    .replace(ROLE, (_, rid) => { const n = typeof roles === 'function' ? roles(rid) : null; return `@${n || 'role'}`; })
    .replace(TIME, (_, s) => when(s));
}

// a live event as a notification would show it: the text fields made readable, everything else as it was
function readableEvent(e) {
  if (!e || typeof e !== 'object') return e;
  switch (e.type) {
    case 'im_received': {
      const m = e.message;
      if (!m || m.enc || typeof m.body !== 'string') return e; // (encrypted: Nookara can't read it; the device opens it)
      return { ...e, message: { ...m, body: readable(m.body) } };
    }
    case 'roomMessage': return typeof e.message === 'string' ? { ...e, message: readable(e.message) } : e;
    case 'bonfire_notice': case 'chat_mention': return { ...e, body: readable(e.body) };
    case 'bonfire_relay': return { ...e, body: readable(e.body), title: readable(e.title) };
    default: return e;
  }
}

module.exports = { readable, readableEvent };
