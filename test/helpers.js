'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

// tests never contact a real Nookara unless they ask for it (relay.test.js runs its own stub Nookara)
process.env.EMBER_NOOKARA_REGISTRATION ??= 'off';
// tests set up instances headlessly; operator-terms.test.js removes this to test the real setup gate
process.env.EMBER_ACCEPT_OPERATOR_TERMS ??= '1';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ember-test-'));

// tiny JSON client: const a = api(base, token); await a.post('/servers', {...}) -> { status, body }
function api(base, token) {
  const call = async (method, p, body, headers = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    let payload;
    if (body !== undefined && !(body instanceof Uint8Array) && !(body instanceof FormData)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); } else payload = body;
    const r = await fetch(base + p, { method, headers: h, body: payload });
    const ct = r.headers.get('content-type') || '';
    const out = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, body: out, headers: r.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), patch: (p, b) => call('PATCH', p, b ?? {}), del: (p) => call('DELETE', p), raw: call };
}

// websocket client that records every frame
function wsClient(url) {
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/gateway');
  const frames = [], waiters = [];
  ws.on('message', raw => {
    const f = JSON.parse(raw.toString());
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(f); }
  });
  const closed = new Promise(res => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
  const c = {
    ws, frames, closed,
    open: () => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: o => ws.send(JSON.stringify(o)),
    waitFor: (pred, ms = 4000) => {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, t: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout waiting for frame; got: ' + frames.map(f => f.type).join(','))); }, ms) };
        waiters.push(w);
      });
    },
    // auth + chat_hello, resolves once chat_ready
    async login(session) {
      await c.open();
      c.send({ type: 'auth', session });
      await c.waitFor(f => f.type === 'auth_success');
      c.send({ type: 'chat_hello' });
      await c.waitFor(f => f.type === 'chat_ready');
      return c;
    },
    close: () => { try { ws.close(); } catch { /* closed */ } },
  };
  return c;
}
module.exports = { tmpDir, api, wsClient };

// a stand-in for Nookara's identity provider: Ed25519 key, JWKS, instance-token minting
const crypto = require('crypto');
function fakeIdp({ kid = 'testkid1', iss = 'http://nookara.test', aud = 'https://chat.test' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' };
  const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const idp = {
    iss, aud, kid, privateKey, publicKey, jwk, jwksFetches: 0,
    jwks: async () => { idp.jwksFetches++; return { keys: [jwk] }; },
    mint(over = {}, { key = privateKey, kid: k = kid, alg = 'EdDSA' } = {}) {
      const iat = Math.floor(Date.now() / 1000);
      const claims = { iss, sub: '123', aud, iat, exp: iat + 600, jti: crypto.randomBytes(16).toString('base64url'), username: 'nat', display_name: 'nat', pfp: null, scp: ['chat', 'voice', 'media', 'sign'], ...over };
      const head = b64({ alg, typ: 'JWT', kid: k });
      const body = b64(claims);
      return `${head}.${body}.${crypto.sign(null, Buffer.from(head + '.' + body), key).toString('base64url')}`;
    },
  };
  return idp;
}
module.exports.fakeIdp = fakeIdp;

// ---------- more than one homeserver (PROTOCOL §4b) ----------
// a real second homeserver, in a worker thread (test/homeserver-worker.js). -> { port, url, setupCode, call(cmd, args), close() }
async function startHomeserver({ dataDir, config } = {}) {
  const { Worker } = require('worker_threads');
  const worker = new Worker(path.join(__dirname, 'homeserver-worker.js'), { workerData: { dataDir, config }, stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume(); // its log stays out of the test output
  const waiting = new Map(); let seq = 0;
  worker.on('message', m => { const w = waiting.get(m.id); waiting.delete(m.id); if (w) (m.error ? w.reject(new Error(m.error)) : w.resolve(m.result)); });
  const call = (cmd, args) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); worker.postMessage({ id, cmd, args }); });
  const { port, setupCode } = await call('start');
  return { port, url: `http://localhost:${port}`, setupCode, call, close: async () => { try { await call('close'); } finally { await worker.terminate(); } } };
}

// a stand-in homeserver: a discovery document, a JWKS and tokens signed with keys the test holds.
// -> { domain, origin, aud (set it: the homeserver its tokens are for), keys, mint(claims, opts), addKey(kid), jwksFetches, doc (replace to change discovery), close() }
async function mockHomeserver(domain, { delegateTo = null } = {}) {
  const http = require('http');
  const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const hs = { domain, keys: [], jwksFetches: 0, discoveryFetches: 0, doc: null, published: null };
  hs.addKey = kid => { const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); const k = { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' } }; hs.keys.push(k); return k; };
  hs.addKey('k1');
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/.well-known/ember') { hs.discoveryFetches++; return send(200, hs.doc || (delegateTo ? { homeserver: delegateTo } : { homeserver: { domain }, jwks_uri: hs.origin + '/.well-known/ember/jwks.json' })); }
    if (req.url === '/.well-known/ember/jwks.json') { hs.jwksFetches++; return send(200, { keys: (hs.published || hs.keys).map(k => k.jwk) }); }
    send(404, { error: 'not_found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  hs.origin = `http://127.0.0.1:${server.address().port}`;
  hs.mint = (over = {}, { key = hs.keys[hs.keys.length - 1], typ = 'ember-remote+jwt', iss = hs.origin } = {}) => {
    const iat = Math.floor(Date.now() / 1000);
    const claims = { iss, sub: `l:1@${domain}`, aud: hs.aud, iat, exp: iat + 3600, jti: crypto.randomBytes(16).toString('hex'), preferred_username: 'remi', name: 'Remi', picture: null, domain, ...over };
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    const head = b64({ alg: 'EdDSA', typ, kid: key.kid }), body = b64(claims);
    return `${head}.${body}.${crypto.sign(null, Buffer.from(head + '.' + body), key.privateKey).toString('base64url')}`;
  };
  // the headers of a signed server-to-server request (PROTOCOL §4c). body: the exact string sent, or null
  hs.sign = (method, url, body = null, { key = hs.keys[hs.keys.length - 1], created = Math.floor(Date.now() / 1000), host = new URL(url).host, signAs = domain, target = new URL(url).pathname + new URL(url).search } = {}) => {
    const digest = crypto.createHash('sha256').update(body || '').digest('base64url');
    const sig = crypto.sign(null, Buffer.from([method, target, host, created, 'sha-256=' + digest].join('\n')), key.privateKey).toString('base64url');
    return { 'Ember-Signature': `keyId="${signAs}#${key.kid}", created=${created}, sig="${sig}"`, 'X-Ember-Homeserver': signAs, ...(body ? { 'Content-Type': 'application/json' } : {}) };
  };
  // a signed request to another homeserver. -> { status, body }
  hs.s2s = async (base, method, path, body, opts = {}) => {
    const url = base + '/_ember/s2s/v1' + path, payload = body === undefined ? null : JSON.stringify(body);
    const r = await fetch(url, { method, headers: { ...hs.sign(method, url, payload, opts), ...(opts.headers || {}) }, body: opts.sendBody !== undefined ? opts.sendBody : payload ?? undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  hs.close = () => new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); });
  return hs;
}
module.exports.startHomeserver = startHomeserver;
module.exports.mockHomeserver = mockHomeserver;
