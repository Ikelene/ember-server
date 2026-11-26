'use strict';
// Server slugs: the short name in a server's address, slug@domain (PROTOCOL §5a).
const crypto = require('crypto');

const RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const RESERVED = new Set(['admin', 'api', 'www', 'mail', 'help', 'support', 'status', 'nookara', 'ember', 'root', 'system', 'i', 'invite', 'login', 'account', 'settings', 'uploads', 'well-known', 'static', 'assets']);
const valid = s => typeof s === 'string' && RE.test(s) && !s.includes('--') && !RESERVED.has(s);
const random = () => crypto.randomBytes(8).toString('hex').slice(0, 8);
// a name -> something slug shaped (may still be invalid: too short, reserved)
const fromName = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
// a free slug for `name`: the name's own, then name-2, name-3, ...; a random one when the name gives nothing usable
function derive(name, taken) {
  const base = fromName(name);
  if (!valid(base)) { let r; do r = random(); while (!valid(r) || taken(r)); return r; }
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const tail = '-' + n, s = base.slice(0, 32 - tail.length).replace(/-+$/, '') + tail;
    if (valid(s) && !taken(s)) return s;
  }
}
module.exports = { valid, derive, fromName, RESERVED };
