'use strict';
// Rules that name homeservers: a domain ("example.org" is that one name only), a domain and everything under it written
// "*.example.org" (subdomains, not the bare name), a network ("203.0.113.0/24", "2001:db8::/32") and a single account
// ("l:5@example.org"). Pure functions, shared by the accounts settings, the server settings and the deny lists.
const net = require('net');

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const isDomain = d => typeof d === 'string' && HOST.test(d);
const isDomainRule = r => typeof r === 'string' && HOST.test(r.replace(/^\*\./, ''));

// does the rule list name this domain?
function domainMatches(list, domain) {
  for (const r of list || []) {
    if (r === domain) return true;
    if (r.startsWith('*.') && domain.endsWith(r.slice(1))) return true;
  }
  return false;
}

// "id@domain" -> { id, domain } | null
function parseSub(sub) {
  if (typeof sub !== 'string' || sub.length > 320) return null;
  const at = sub.lastIndexOf('@');
  if (at < 1) return null;
  const id = sub.slice(0, at), domain = sub.slice(at + 1);
  return ACCOUNT_ID.test(id) && isDomain(domain) ? { id, domain } : null;
}

// ---------- addresses ----------
function ipBig(ip) {
  if (net.isIPv4(ip)) return { v: 4, n: ip.split('.').reduce((a, b) => (a << 8n) | BigInt(b), 0n) };
  if (!net.isIPv6(ip)) return null;
  let s = ip.split('%')[0];
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s); // ::ffff:1.2.3.4
  if (m) { const b = m[2].split('.').map(Number); s = m[1] + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16); }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [], t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(parseInt(g || '0', 16));
  if ((n >> 32n) === 0xffffn) return { v: 4, n: n & 0xffffffffn }; // an IPv4 address written as IPv6
  return { v: 6, n };
}
// "a.b.c.d/n" -> { v, n, bits } | null (a bare address is a /32 or /128)
function parseCidr(text) {
  const m = /^([0-9a-f:.]+)(?:\/(\d{1,3}))?$/i.exec(String(text || '').trim());
  if (!m) return null;
  const ip = ipBig(m[1]);
  if (!ip) return null;
  const full = ip.v === 4 ? 32 : 128, bits = m[2] === undefined ? full : Number(m[2]);
  if (bits > full) return null;
  return { v: ip.v, n: ip.n >> BigInt(full - bits), bits };
}
function inCidr(cidr, ip) {
  const a = ipBig(ip);
  if (!a || a.v !== cidr.v) return false;
  return (a.n >> BigInt((a.v === 4 ? 32 : 128) - cidr.bits)) === cidr.n;
}
// the network a homeserver's age is shared by: its /24 (IPv4) or /48 (IPv6), as text. null when it is not an address
function netOf(ip) {
  const a = ipBig(ip);
  if (!a) return null;
  if (a.v === 4) { const n = a.n >> 8n; return `${n >> 16n}.${(n >> 8n) & 255n}.${n & 255n}.0/24`; }
  const n = a.n >> 80n;
  return `${[(n >> 32n) & 0xffffn, (n >> 16n) & 0xffffn, n & 0xffffn].map(x => x.toString(16)).join(':')}::/48`;
}

// ---------- deny entries ----------
// one entry as typed -> its clean text, or null when it is none of: domain, *.domain, network, id@domain
function cleanDeny(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || t.length > 320) return null;
  if (t.includes('@')) { const s = parseSub(t.slice(0, t.lastIndexOf('@')) + '@' + t.slice(t.lastIndexOf('@') + 1).toLowerCase()); return s ? `${s.id}@${s.domain}` : null; }
  if (/^[0-9a-f:.]+(\/\d{1,3})?$/i.test(t) && (t.includes('/') || net.isIP(t))) return parseCidr(t) ? t.toLowerCase() : null;
  return isDomainRule(t.toLowerCase()) ? t.toLowerCase() : null;
}
// entries -> { domains: [rule], cidrs: [{..}], accounts: Set } for matching
function compileDeny(entries) {
  const out = { domains: [], cidrs: [], accounts: new Set() };
  for (const e of entries || []) {
    const t = cleanDeny(e)?.replace(/^([^@]+)@/, (m, id) => (/^[a-z0-9._-]+$/i.test(id) && !id.includes(':') ? id.toLowerCase() + '@' : m));
    if (!t) continue;
    if (t.includes('@')) out.accounts.add(t);
    else if (isDomainRule(t) && !/^[0-9.]+$/.test(t)) out.domains.push(t);
    else { const c = parseCidr(t); if (c) out.cidrs.push(c); }
  }
  return out;
}
// -> 'domain' | 'network' | 'account' | null
// an account entry may name the stable id (`l:5@a.example`) or the handle (`alice@a.example`, what Nookara's list holds)
function denied(compiled, { domain, ips = [], sub = null, handle = null }) {
  if (domain && domainMatches(compiled.domains, domain)) return 'domain';
  if (sub && compiled.accounts.has(sub)) return 'account';
  if (handle && compiled.accounts.has(String(handle).toLowerCase())) return 'account';
  for (const ip of ips) if (compiled.cidrs.some(c => inCidr(c, ip))) return 'network';
  return null;
}

module.exports = { HOST, ACCOUNT_ID, isDomain, isDomainRule, domainMatches, parseSub, parseCidr, inCidr, netOf, cleanDeny, compileDeny, denied };
