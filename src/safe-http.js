'use strict';
// Requests to an address an admin typed (a login provider's discovery document, token and userinfo endpoints). The same rule
// as the Matrix bridge: every connection goes to a checked, public address (never loopback / private / link-local / metadata),
// https only, no redirects followed. EMBER_DEV=1 (or the test seam) lets a provider on this machine through, over http too.
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { env } = require('./compat');
const { isPrivateIp } = require('./unfurl');

let allowLocal = false;
const local = () => allowLocal || env('DEV') === '1';
const refuse = () => Object.assign(new Error('private_address'), { code: 'EPRIVATE' });

function safeLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, { all: true }, (e, list) => {
    if (e) return cb(e);
    if (!list.length || (!local() && list.some(x => isPrivateIp(x.address)))) return cb(refuse());
    return opts && opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
  });
}

// -> { status, headers, body: Buffer, json() }. body: a string / Buffer sent as is (set its Content-Type in headers)
function request(method, url, { headers = {}, body = null, timeout = 10000, maxBytes = 1 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error('bad_url')); }
    if (u.username || u.password) return reject(new Error('bad_url'));
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local())) return reject(new Error('bad_url'));
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!local()) {
      if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return reject(refuse());
      if (net.isIP(host) ? isPrivateIp(host) : /^[0-9.]+$|^0x/i.test(host)) return reject(refuse());
    }
    const payload = body === null ? null : Buffer.from(body);
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method, timeout, lookup: safeLookup,
      headers: { 'User-Agent': 'ember-server', Accept: 'application/json', ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
    }, res => {
      const chunks = []; let n = 0;
      res.on('data', d => { n += d.length; if (n > maxBytes) return req.destroy(new Error('too_big')); chunks.push(d); });
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: buf, json() { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } } }); });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

module.exports = { request, local, _test: { allowLocal(on) { allowLocal = !!on; } } };
