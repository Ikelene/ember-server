'use strict';
// The registered domain of a host name (eTLD+1): "chat.example.co.uk" -> "example.co.uk". Used to age homeservers by the
// domain someone had to register, so a fresh subdomain is not a fresh homeserver. This is NOT the whole Public Suffix List:
// only the common multi-label suffixes below are known. Under a suffix that is missing here (a rare country second level,
// a small hosting provider), every customer shares one registered domain, so their homeservers share one age and a
// `*.suffix` rule covers all of them. Operators can still name single hosts in their rules.
const SECOND = ['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'mil', 'nom', 'sch', 'gob', 'ltd', 'plc', 'me', 'info', 'biz', 'id', 'web'];
// country codes whose second level is one of SECOND (co.uk, com.au, co.jp, com.br, ...)
const CC = ['uk', 'au', 'nz', 'za', 'jp', 'kr', 'in', 'br', 'mx', 'ar', 'cn', 'tw', 'hk', 'sg', 'my', 'id', 'th', 'vn', 'ph', 'tr', 'il', 'eg', 'ng', 'ke', 'ua', 'pl', 'pt', 'es', 'co', 've', 'pe', 'uy', 'pk', 'bd', 'sa', 'ae', 'cy', 'gr'];
// private suffixes: hosting where each customer gets a name under it
const PRIVATE = [
  'github.io', 'gitlab.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'fly.dev', 'onrender.com', 'railway.app',
  'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'ngrok.io', 'ngrok.app', 'ngrok-free.app', 'trycloudflare.com',
  'duckdns.org', 'dyndns.org', 'no-ip.org', 'ddns.net', 'hopto.org', 'zapto.org', 'sytes.net', 'mooo.com', 'nip.io', 'sslip.io', 'glitch.me', 'repl.co', 'replit.app', 'replit.dev',
  'blogspot.com', 'wordpress.com', 'neocities.org', 'surge.sh', 'deno.dev', 'tailscale.net', 'ts.net', 'eu.org', 'us.com', 'uk.com', 'de.com', 'eu.com', 'gb.net', 'co.com',
];
const SUFFIXES = new Set(PRIVATE);
for (const c of CC) for (const s of SECOND) SUFFIXES.add(`${s}.${c}`);

const isSuffix = h => SUFFIXES.has(h);
// -> the registered domain (lowercase), or the host itself when it is one label, an ip address or a bare suffix
function registeredDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || /^[0-9.]+$/.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  for (let take = 3; take >= 2; take--) { // the longest known suffix wins (a 3-label one is not in the list today, kept for later)
    const suffix = parts.slice(-take).join('.');
    if (isSuffix(suffix)) return parts.length > take ? parts.slice(-(take + 1)).join('.') : h;
  }
  return parts.slice(-2).join('.');
}
module.exports = { registeredDomain, isSuffix };
