'use strict';
// Limits per server (PROTOCOL §19): the homeserver's defaults, a homeserver admin's overrides for one server, paid tiers
// (bought through a stand-in for Nookara's pay requests, with receipts signed by a key the test holds), running out,
// and what is refused in one server while another carries on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const { tmpDir, api, fakeIdp } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'nookara';
process.env.EMBER_NOOKARA_URL = 'http://nookara.test/';
process.env.EMBER_PUBLIC_URL = 'http://chat.test';
process.env.EMBER_OWNER = 'v:100';
for (const k of ['EMBER_MANAGED', 'EMBER_PLAN', 'EMBER_LIMITS']) delete process.env[k];

const dir = tmpDir();
const idp = fakeIdp({ iss: 'http://nookara.test', aud: 'http://chat.test' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const file = (buf, name, fields = {}) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('file', new Blob([buf]), name); return f; };
const WEEK = 7 * 24 * 3600 * 1000;
let inst, base, owner, A, B, db, client, L;

// ---- a stand-in for the pay-request relay (PROTOCOL §12.5) ----
const relay = { on: false, calls: [], pays: new Map(), n: 0, receipt: 'good' };
function receipt(p) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'EdDSA', typ: 'ember-receipt+jwt', kid: idp.kid });
  const body = b64({ iss: 'http://nookara.test', aud: 'http://chat.test', sub: p.user_id, amount: relay.receipt === 'wrong_amount' ? p.amount + 1 : p.amount, ref: p.ref, paid_at: Date.now(), rcp: p.id, iat, exp: iat + 3600 });
  return `${head}.${body}.${crypto.sign(null, Buffer.from(head + '.' + body), idp.privateKey).toString('base64url')}`;
}
async function relayCall(method, path, body) {
  relay.calls.push({ method, path, body });
  if (method === 'POST' && path.endsWith('/pay-request')) {
    const prior = [...relay.pays.values()].find(p => p.ref === body.ref);
    const p = prior || { id: 'pr' + ++relay.n, user_id: body.user_id, amount: body.amount, ref: body.ref, reason: body.reason, status: 'pending' };
    relay.pays.set(p.id, p);
    return { id: p.id, status: p.status, approve_url: `http://nookara.test/payment/${p.id}`, amount: p.amount, expires_at: Date.now() + 30 * 60000 };
  }
  const m = /\/pay-request\/([^/]+)$/.exec(path);
  if (method === 'GET' && m) {
    const p = relay.pays.get(decodeURIComponent(m[1]));
    if (!p) throw Object.assign(new Error('not_found'), { code: 'not_found', status: 404 });
    return { id: p.id, status: p.status, amount: p.amount, ref: p.ref, receipt: p.status === 'paid' ? receipt(p) : null };
  }
  return {};
}
const pay = id => { relay.pays.get(id).status = 'paid'; };

test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  auth.setJwksFetcher(idp.jwks);
  db = require('../src/db'); L = require('../src/limits');
  client = require('../src/relay/client');
  client.registered = () => relay.on;
  client.call = relayCall;
});
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const login = async (sub, username) => {
  const r = await api(base).post('/api/v1/auth/nookara', { token: idp.mint({ sub: String(sub), username }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, a: api(base, r.body.session) };
};
const S = (sid, p = '') => `/api/v1/servers/${sid}${p}`;
const emoji = (who, sid, name) => who.a.raw('POST', S(sid, '/emojis'), file(PNG, name + '.png', { name }));
const upload = (who, sid, buf, name = 'f.bin') => who.a.raw('POST', `/api/v1/media/upload?sid=${sid}`, file(buf, name));
const cidOf = sid => db.get('SELECT id FROM communities WHERE sid = ?', sid).id;

test('a self-hosted homeserver limits nothing; discovery shows the defaults and no tiers', async () => {
  const wk = (await api(base).get('/.well-known/ember')).body;
  assert.equal(wk.managed, null);
  assert.deepEqual(wk.limits, { defaults: { member_cap: null, voice_minutes: null, max_upload_mb: 25, storage_mb: null, files_per_member: null, upload_expiry_days: null, emojis: null, sounds: null, bots: null, bridges: ['discord', 'fluxer', 'matrix', 'cloudlink'], custom_voice_keys: true }, tiers: [] });
  owner = await login(100, 'owner');
  A = (await owner.a.post('/api/v1/servers', { name: 'Alpha', join_policy: 'open' })).body.server.sid;
  B = (await owner.a.post('/api/v1/servers', { name: 'Beta', join_policy: 'open' })).body.server.sid;
  const v = (await owner.a.get(S(A, '/limits'))).body;
  assert.equal(v.limits.emojis, null);
  assert.deepEqual(v.usage, { member_cap: 1, emojis: 0, sounds: 0, bots: 0, storage_mb: 0 });
  assert.deepEqual([v.tier, v.until, v.overridden, v.tiers_available], [null, null, false, false]);
  // an over-size file is still the plain 413 here: the homeserver's own max_upload_mb is not a plan
  await owner.a.patch(S(A), { allow_uploads: true }); await owner.a.patch(S(B), { allow_uploads: true });
});

test('admins set the defaults and the tiers; bad values are refused', async () => {
  const outsider = await login(101, 'one');
  assert.equal((await outsider.a.get('/api/v2/homeserver/limits')).status, 403);
  const P = b => owner.a.patch('/api/v2/homeserver/limits', b);
  assert.equal((await P({ defaults: { emojis: -1 } })).body.error, 'invalid_limits');
  assert.equal((await P({ defaults: { bridges: ['irc'] } })).body.error, 'invalid_limits');
  assert.equal((await P({ tiers: [{ id: 'Plus!', name: 'x', limits: {}, price_credits: 5, period_weeks: 1 }] })).body.error, 'invalid_tiers');
  assert.equal((await P({ tiers: [{ id: 'plus', name: 'Plus', limits: {}, price_credits: 0, period_weeks: 1 }] })).body.error, 'invalid_tiers');
  const r = await P({ defaults: { emojis: 1, member_cap: 3, bridges: ['discord'] }, tiers: [{ id: 'plus', name: 'Plus', limits: { emojis: 5, member_cap: null, bridges: true }, price_credits: 50, period_weeks: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.saved_defaults, { member_cap: 3, emojis: 1, bridges: ['discord'] });
  assert.equal(r.body.defaults.max_upload_mb, 25);
  const wk = (await api(base).get('/.well-known/ember')).body.limits;
  assert.deepEqual([wk.defaults.emojis, wk.defaults.member_cap, wk.defaults.bridges], [1, 3, ['discord']]);
  assert.deepEqual(wk.tiers, [{ id: 'plus', name: 'Plus', price_credits: 50, period_weeks: 1 }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${dir}/config.json`, 'utf8')).limits.defaults, { member_cap: 3, emojis: 1, bridges: ['discord'] });
  // the server settings carry what applies, where the plan used to be
  const st = (await owner.a.get(S(A, '/settings'))).body.settings;
  assert.equal(st.plan, null);
  assert.equal(st.limits.limits.emojis, 1);
  assert.equal(st.limits.tiers[0].limits.emojis, 5);
});

test('emojis are counted per server; an override lifts one server only', async () => {
  assert.equal((await emoji(owner, A, 'a1')).status, 200);
  const two = await emoji(owner, A, 'a2');
  assert.equal(two.status, 403);
  assert.deepEqual(two.body, { error: 'plan_limit', what: 'emojis', limit: 1, used: 1 });
  assert.equal((await emoji(owner, B, 'b1')).status, 200); // Alpha being full says nothing about Beta
  assert.equal((await emoji(owner, B, 'b2')).status, 403);
  const o = await owner.a.patch(`/api/v2/homeserver/servers/${B}/limits`, { overrides: { emojis: 3, member_cap: null }, note: 'friends' });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.deepEqual([o.body.overrides, o.body.note, o.body.updated_by, o.body.limits.emojis, o.body.overridden], [{ member_cap: null, emojis: 3 }, 'friends', 'v:100', 3, true]);
  assert.equal((await emoji(owner, B, 'b2')).status, 200);
  assert.equal((await emoji(owner, B, 'b3')).status, 200);
  assert.equal((await emoji(owner, B, 'b4')).body.limit, 3);
  assert.equal((await owner.a.get(S(B, '/emojis'))).body.max, 3);
  assert.equal((await owner.a.get(S(A, '/emojis'))).body.max, 1);
  assert.equal((await emoji(owner, A, 'a2')).status, 403);
  assert.equal((await owner.a.patch(`/api/v2/homeserver/servers/${B}/limits`, { overrides: { emojis: 'many' } })).body.error, 'invalid_limits');
  assert.equal((await (await login(101, 'one')).a.get(`/api/v2/homeserver/servers/${B}/limits`)).status, 403);
});

test('the member cap is per server: people past it are refused there and welcome next door', async () => {
  const u1 = await login(101, 'one'), u2 = await login(102, 'two'), u3 = await login(103, 'three');
  assert.equal((await u1.a.post(S(A, '/join'))).status, 200);
  assert.equal((await u2.a.post(S(A, '/join'))).status, 200); // owner + 2 = 3
  const full = await u3.a.post(S(A, '/join'));
  assert.equal(full.status, 403);
  assert.deepEqual(full.body, { error: 'member_cap_reached', cap: 3, what: 'member_cap', limit: 3, used: 3 });
  assert.equal((await owner.a.get(S(A))).body.server.member_cap, 3);
  for (const u of [u1, u2, u3]) assert.equal((await u.a.post(S(B, '/join'))).status, 200); // Beta's override: no cap
  assert.equal((await owner.a.get(S(B))).body.server.member_cap, null);
  assert.equal((await u3.a.get(S(B, '/limits'))).body.usage.member_cap, 4);
  assert.equal((await u3.a.get(S(A, '/limits'))).status, 403); // members only
});

test('bridges: only the platforms on the server\'s list', async () => {
  const no = await owner.a.put(`/api/v1/bridge/servers/${A}`, { platform: 'fluxer', guild_id: '1' });
  assert.equal(no.status, 403);
  assert.deepEqual(no.body, { error: 'plan_feature', what: 'bridges', limit: 0, message: 'This plan does not include bridges.' });
  assert.equal((await owner.a.get(`/api/v1/bridge/matrix/guilds?sid=${A}`)).body.error, 'plan_feature');
  assert.equal((await owner.a.put(`/api/v1/bridge/servers/${A}`, { platform: 'discord', guild_id: '1' })).body.error, 'bridge_not_set_up'); // allowed; no bot yet
  assert.equal((await owner.a.get(`/api/v1/bridge/servers/${A}`)).status, 200); // looking is never refused
  const ch = (await owner.a.post(S(A, '/channels'), { name: 'link', type: 'logs', config: { mode: 'cloudlink', url: 'wss://cl.example/', room: 'r', username: 'u' } }));
  assert.equal(ch.body.error, 'plan_feature');
});

test('uploads: size and storage are a server\'s own', async () => {
  await owner.a.patch(`/api/v2/homeserver/servers/${B}/limits`, { overrides: { emojis: 3, member_cap: null, max_upload_mb: 1, storage_mb: 1 } });
  const big = await upload(owner, B, crypto.randomBytes(1024 * 1024 + 10));
  assert.equal(big.status, 403);
  assert.deepEqual(big.body, { error: 'plan_limit', what: 'max_upload_mb', limit: 1, used: null });
  assert.equal((await owner.a.get(S(B))).body.server.upload_ceiling_mb, 1);
  assert.equal((await owner.a.get(S(A))).body.server.upload_ceiling_mb, 25);
  const one = await upload(owner, B, crypto.randomBytes(600 * 1024));
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(db.get('SELECT community_id FROM uploads WHERE sha256 = ?', one.body.sha256).community_id, cidOf(B));
  const two = await upload(owner, B, crypto.randomBytes(600 * 1024)); // 1.2 MB would not fit in 1
  assert.equal(two.status, 403);
  assert.equal(two.body.error, 'storage_full');
  assert.equal((await upload(owner, B, crypto.randomBytes(500 * 1024))).status, 403);
  // Alpha is not Beta: the same files go through there, and an over-size one is the plain 413
  assert.equal((await upload(owner, A, crypto.randomBytes(1024 * 1024 + 10))).status, 200);
  assert.equal((await upload(owner, A, crypto.randomBytes(600 * 1024))).status, 200);
  assert.equal((await upload(owner, A, Buffer.alloc(26 * 1024 * 1024, 1))).status, 413);
  assert.equal((await owner.a.get(S(A, '/limits'))).body.usage.storage_mb, 2);
  assert.equal((await owner.a.get(S(B, '/limits'))).body.usage.storage_mb, 1);
  // an upload from before uploads belonged to a server counts toward none
  db.run("INSERT INTO uploads (path, sha256, name, size, mime, type, created_at) VALUES ('old/x.bin', 'x', 'x.bin', ?, 'application/octet-stream', 'file', 1)", 900 * 1024 * 1024);
  assert.equal(L.usage(cidOf(A)).storage_mb, 2);
  await owner.a.patch(`/api/v2/homeserver/servers/${B}/limits`, { overrides: { emojis: 3, member_cap: null } });
});

test('tiers are only sold by a homeserver registered with Nookara, and only to the owner', async () => {
  const r = await owner.a.post(`/api/v2/servers/${A}/tier`, { tier: 'plus' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'tiers_unavailable');
  relay.on = true;
  assert.equal((await owner.a.get(S(A, '/limits'))).body.tiers_available, true);
  assert.equal((await (await login(101, 'one')).a.post(`/api/v2/servers/${A}/tier`, { tier: 'plus' })).body.error, 'owner_only');
  assert.equal((await owner.a.post(`/api/v2/servers/${A}/tier`, { tier: 'gold' })).body.error, 'unknown_tier');
});

test('buying a tier: a pay request, a checked receipt, the limits of the tier; buying again adds a period', async () => {
  const t0 = Date.now();
  const r = await owner.a.post(`/api/v2/servers/${A}/tier`, { tier: 'plus' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.status, r.body.tier, r.body.pay_request.amount, r.body.pay_request.tier], ['pending', null, 50, 'plus']);
  assert.match(r.body.pay_request.approve_url, /\/payment\/pr1$/);
  const sent = relay.calls.find(c => c.path.endsWith('/pay-request')).body;
  assert.equal(sent.user_id, '100');
  assert.equal(sent.amount, 50);
  const m = /^tier:plus:server:(.+):(\d+)$/.exec(sent.ref);
  assert.ok(m && m[1] === A && Number(m[2]) >= t0 && Number(m[2]) <= Date.now(), sent.ref);
  // asking again hands back the same request
  assert.equal((await owner.a.post(`/api/v2/servers/${A}/tier`, { tier: 'plus' })).body.pay_request.id, 'pr1');
  assert.equal(relay.calls.filter(c => c.path.endsWith('/pay-request')).length, 1);
  assert.equal((await owner.a.get(`/api/v2/servers/${A}/tier`)).body.status, 'pending');
  assert.equal(L.limit('emojis', cidOf(A)), 1); // nothing until it is paid
  pay('pr1');
  const paid = (await owner.a.get(`/api/v2/servers/${A}/tier`)).body;
  assert.deepEqual([paid.status, paid.tier], ['paid', 'plus']);
  assert.ok(Math.abs(paid.until - (Date.now() + WEEK)) < 5000);
  const v = (await owner.a.get(S(A, '/limits'))).body;
  assert.deepEqual([v.tier, v.limits.emojis, v.limits.member_cap, v.limits.bridges.length], ['plus', 5, null, 4]);
  assert.equal(db.get('SELECT receipt_jti FROM server_tiers WHERE community_id = ?', cidOf(A)).receipt_jti, 'pr1');
  assert.equal((await emoji(owner, A, 'a2')).status, 200);
  assert.equal((await (await login(103, 'three')).a.post(S(A, '/join'))).status, 200); // no cap on the tier
  assert.equal((await owner.a.put(`/api/v1/bridge/servers/${A}`, { platform: 'fluxer', guild_id: '1' })).body.error, 'bridge_not_set_up');
  assert.equal(L.limit('emojis', cidOf(B)), 3); // Beta bought nothing
  // again: the new period starts where the running one ends
  const again = await owner.a.post(`/api/v2/servers/${A}/tier`, { tier: 'plus' });
  assert.equal(again.body.pay_request.id, 'pr2');
  assert.equal(relay.pays.get('pr2').ref, `tier:plus:server:${A}:${paid.until}`);
  pay('pr2');
  const more = (await owner.a.get(`/api/v2/servers/${A}/tier`)).body;
  assert.equal(more.until, paid.until + WEEK);
});

test('a receipt that does not match is refused and changes nothing', async () => {
  relay.receipt = 'wrong_amount';
  const r = await owner.a.post(`/api/v2/servers/${B}/tier`, { tier: 'plus' });
  pay(r.body.pay_request.id);
  const st = (await owner.a.get(`/api/v2/servers/${B}/tier`)).body;
  assert.deepEqual([st.status, st.tier, st.pay_request.error], ['failed', null, 'receipt_wrong_amount']);
  relay.receipt = 'good';
  assert.equal(L.activeTier(cidOf(B)), null);
});

test('when the tier runs out the defaults are back: what is there stays, more is refused', async () => {
  db.run('UPDATE server_tiers SET until = ? WHERE community_id = ?', Date.now() - 1, cidOf(A));
  const v = (await owner.a.get(S(A, '/limits'))).body;
  assert.deepEqual([v.tier, v.until, v.limits.emojis, v.limits.member_cap, v.usage.emojis, v.usage.member_cap], [null, null, 1, 3, 2, 4]);
  assert.equal((await owner.a.get(S(A, '/emojis'))).body.emojis.length, 2);
  assert.deepEqual((await emoji(owner, A, 'a3')).body, { error: 'plan_limit', what: 'emojis', limit: 1, used: 2 });
  assert.equal((await (await login(105, 'five')).a.post(S(A, '/join'))).body.error, 'member_cap_reached');
  assert.equal((await owner.a.put(`/api/v1/bridge/servers/${A}`, { platform: 'fluxer', guild_id: '1' })).body.error, 'plan_feature');
});

test('effective limits: override, then tier, then defaults', async () => {
  const cid = cidOf(A);
  db.run('UPDATE server_tiers SET until = ? WHERE community_id = ?', Date.now() + WEEK, cid);
  assert.deepEqual([L.limit('emojis', cid), L.source('emojis', cid), L.source('sounds', cid), L.source('member_cap', cid)], [5, 'tier', 'builtin', 'tier']);
  await owner.a.patch(`/api/v2/homeserver/servers/${A}/limits`, { overrides: { emojis: 9, bridges: [] } });
  assert.deepEqual([L.limit('emojis', cid), L.source('emojis', cid), L.limit('member_cap', cid), L.allowsBridge('discord', cid)], [9, 'override', null, false]);
  await owner.a.patch(`/api/v2/homeserver/servers/${A}/limits`, { overrides: null });
  assert.deepEqual([L.limit('emojis', cid), L.allowsBridge('matrix', cid)], [5, true]);
  assert.equal(L.limit('emojis'), 1); // no server: the defaults
  // a tier the homeserver no longer offers gives nothing
  await owner.a.patch('/api/v2/homeserver/limits', { tiers: [] });
  assert.equal(L.limit('emojis', cid), 1);
});
