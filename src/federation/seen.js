'use strict';
// When each remote homeserver was first seen here (PROTOCOL §4b), for the new-homeserver cooldown and the tighter limits on
// new ones. Three clocks run: the domain itself, its registered domain (psl.js) and the network its homeserver answers from
// (/24 for IPv4, /48 for IPv6). A homeserver is as old as the oldest of the three, or older still when a shared deny list
// says it has known the domain for longer.
const db = require('../db');
const { now } = require('../util');
const { registeredDomain } = require('./psl');
const R = require('./rules');

const DAY = 24 * 3600 * 1000;
let shared = new Map(); // domain -> first_seen (ms), from the deny lists' `first_seen` maps

const touchGroup = (key, t) => db.run('INSERT INTO homeserver_groups_seen (key, first_seen, last_seen) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_seen = excluded.last_seen', key, t, t);
// a verified token from `domain`, whose homeserver is at `origin` and answers from `ips`
function touch(domain, { origin = null, ips = [] } = {}, t = now()) {
  const nets = [...new Set(ips.map(R.netOf).filter(Boolean))];
  db.tx(() => {
    db.run('INSERT INTO homeservers_seen (domain, first_seen, last_seen, origin, net, ips) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(domain) DO UPDATE SET last_seen = excluded.last_seen, origin = excluded.origin, net = excluded.net, ips = excluded.ips',
      domain, t, t, origin, nets.join(' ') || null, ips.join(' ') || null);
    touchGroup('d:' + registeredDomain(domain), t);
    for (const n of nets) touchGroup('n:' + n, t);
  });
}
const row = domain => db.get('SELECT * FROM homeservers_seen WHERE domain = ?', domain) || null;
// the addresses its homeserver answered from at its last sign-in
const ipsOf = domain => String(row(domain)?.ips || '').split(' ').filter(Boolean);
const groupFirst = key => db.get('SELECT first_seen FROM homeserver_groups_seen WHERE key = ?', key)?.first_seen;
// the earliest any clock saw this homeserver (ms), or null when it has never been seen
function firstSeen(domain) {
  const r = row(domain), reg = registeredDomain(domain);
  const times = [r?.first_seen, groupFirst('d:' + reg), shared.get(domain), shared.get(reg)];
  for (const n of String(r?.net || '').split(' ').filter(Boolean)) times.push(groupFirst('n:' + n));
  const known = times.filter(x => Number.isFinite(x) && x > 0);
  return known.length ? Math.min(...known) : null;
}
// whole days since it was first seen (0 for one never seen)
function ageDays(domain, t = now()) {
  const f = firstSeen(domain);
  return f === null ? 0 : Math.max(0, Math.floor((t - f) / DAY));
}
// days still to wait before it is `minDays` old (0 = old enough)
function daysLeft(domain, minDays, t = now()) {
  if (!(minDays > 0)) return 0;
  const f = firstSeen(domain);
  return f === null ? minDays : Math.max(0, Math.ceil((f + minDays * DAY - t) / DAY));
}
const setShared = map => { shared = map; };
const all = () => db.all('SELECT * FROM homeservers_seen ORDER BY first_seen').map(r => ({ domain: r.domain, origin: r.origin, net: r.net, first_seen: firstSeen(r.domain), first_seen_here: r.first_seen, last_seen: r.last_seen }));

const _test = { // tests wind the clocks back: a domain, or a group key ("d:example.org", "n:203.0.113.0/24")
  age(key, ms) { db.run('UPDATE homeservers_seen SET first_seen = first_seen - ? WHERE domain = ?', ms, key); db.run('UPDATE homeserver_groups_seen SET first_seen = first_seen - ? WHERE key = ?', ms, key); },
  clear() { db.run('DELETE FROM homeservers_seen'); db.run('DELETE FROM homeserver_groups_seen'); shared = new Map(); },
};
module.exports = { DAY, touch, row, ipsOf, firstSeen, ageDays, daysLeft, setShared, all, _test };
