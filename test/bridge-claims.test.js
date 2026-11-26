'use strict';
// The homeserver's Discord bot is shared by every server, so linking a guild needs proof of control (PROTOCOL §16): a claim
// code posted in the guild by someone with Manage Server (owner, a role, or nobody), Discord sign-in, one guild per
// homeserver, `!ember-unlink`, links from before the check, and the shard plumbing. All against a local fake Discord.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_DISCORD_TOKEN', 'EMBER_MANAGED']) delete process.env[k];
const dir = tmpDir();
const TOKEN = 'good.discord.token-WXYZ';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } }

// ---- the fake Discord: guild 111 (owner 60; role 7 has Manage Server; member 51 holds it, 50 holds nothing),
//      guild 222 (owner 61), guild 333 (only reachable through sign-in) ----
const GUILDS = {
  111: { id: '111', name: 'One', owner_id: '60', roles: [{ id: '111', name: '@everyone', permissions: '1024' }, { id: '7', name: 'Mods', permissions: String(0x20 | 0x800) }, { id: '8', name: 'Fans', permissions: '2048' }] },
  222: { id: '222', name: 'Two', owner_id: '61', roles: [{ id: '222', name: '@everyone', permissions: '0' }] },
};
const MEMBERS = { '111:50': { roles: ['8'] }, '111:51': { roles: ['7', '8'] }, '111:60': { roles: [] }, '222:61': { roles: [] }, '222:51': { roles: [] } };
const calls = [], idents = [], said = [], gw = new Set();
let fake, fbase, hookN = 0;
function fakeServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'), p = u.pathname, auth = req.headers.authorization || null;
      const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch { parsed = Object.fromEntries(new URLSearchParams(body)); }
      calls.push({ method: req.method, path: p, auth, body: parsed });
      if (p === '/oauth2/token') return parsed.code === 'good' && parsed.client_secret === 'shh' && parsed.grant_type === 'authorization_code' ? json(200, { access_token: 'user-access', token_type: 'Bearer' }) : json(400, { error: 'invalid_grant' });
      if (auth === 'Bearer user-access') {
        if (p === '/users/@me') return json(200, { id: '70', username: 'signedin' });
        if (p === '/users/@me/guilds') return json(200, [{ id: '333', name: 'Three', owner: false, permissions: '32' }, { id: '444', name: 'Four', owner: false, permissions: '2048' }, { id: '555', name: 'Five', owner: true, permissions: '0' }]);
      }
      if (p.startsWith('/webhooks/')) { res.writeHead(204); return res.end(); }
      if (auth !== `Bot ${TOKEN}`) return json(401, { message: '401: Unauthorized' });
      if (p === '/users/@me') return json(200, { id: '900', username: 'TestBot' });
      if (p === '/gateway/bot') return json(200, { url: fbase.replace('http', 'ws') + '/gw' });
      let m = /^\/guilds\/(\d+)$/.exec(p);
      if (m) return GUILDS[m[1]] || ['333', '555'].includes(m[1]) ? json(200, GUILDS[m[1]] || { id: m[1], name: 'G' + m[1], owner_id: '1', roles: [] }) : json(404, { message: 'Unknown Guild' });
      m = /^\/guilds\/(\d+)\/members\/(\d+)$/.exec(p);
      if (m) return MEMBERS[`${m[1]}:${m[2]}`] ? json(200, { user: { id: m[2] }, ...MEMBERS[`${m[1]}:${m[2]}`] }) : json(404, { message: 'Unknown Member' });
      if (/^\/guilds\/\d+\/channels$/.test(p)) return json(200, [{ id: p.split('/')[2] + '1', type: 0, name: 'general', position: 0 }]);
      if (/^\/channels\/\d+\/webhooks$/.test(p)) { const id = String(7000 + ++hookN); return json(200, { id, token: `tok${id}` }); }
      m = /^\/channels\/(\d+)\/messages$/.exec(p);
      if (m && req.method === 'POST') { said.push({ channel: m[1], text: parsed.content }); return json(200, { id: '1' }); }
      json(404, { message: 'Unknown' });
    });
  });
  const wss = new WebSocketServer({ server, path: '/gw' });
  wss.on('connection', ws => {
    gw.add(ws);
    ws.on('close', () => gw.delete(ws));
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
    ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.op === 2) { idents.push(m.d); ws.shard = m.d.shard || null; ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 's' + idents.length, user: { id: '900', username: 'TestBot' } } })); }
      if (m.op === 1) ws.send(JSON.stringify({ op: 11 }));
    });
  });
  return server;
}
let seq = 1, msgN = 0;
// someone says something in a guild (delivered on one connection, as Discord does)
const say = (guild, user, content, extra = {}) => { const ws = [...gw][0]; ws.send(JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', s: ++seq, d: { id: `5${++msgN}`, type: 0, guild_id: guild, channel_id: guild + '1', author: { id: user, username: 'u' + user }, content, ...extra } })); };

let inst, base, B, CL, db, store, alice, bob, carol, s1, s2, s3;
test.before(async () => {
  fake = fakeServer();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  fbase = `http://127.0.0.1:${fake.address().port}`;
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  const PL = require('../src/bridge/platform');
  B = require('../src/bridge/bridge'); CL = require('../src/bridge/claims'); db = require('../src/db'); store = require('../src/bridge/store');
  PL._test.set('discord', { api: fbase, cdn: fbase, authorize: fbase + '/oauth2/authorize', identifyGap: 0, media: /^http:\/\/127\.0\.0\.1:\d+\// });
});
test.after(async () => { await inst.close(); for (const ws of gw) ws.terminate(); fake.closeAllConnections?.(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); return { ...r.body, a: api(base, r.body.session) }; };
const BR = sid => `/api/v1/bridge/servers/${sid}`;
const claim = (who, sid, guild) => who.a.post(BR(sid) + '/claim', { platform: 'discord', guild_id: guild });
const claimState = async (who, sid, guild) => (await who.a.get(`${BR(sid)}/claim?platform=discord&guild_id=${guild}`)).body.status;
const link = (who, sid, guild) => who.a.put(BR(sid), { platform: 'discord', guild_id: guild });
const settle = async () => { await sleep(60); await B.idle(); };

test('setup: one bot for the homeserver, three servers with their own owners', async () => {
  alice = await reg('alice'); bob = await reg('bob'); carol = await reg('carol');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  assert.equal((await alice.a.patch('/api/v1/instance/settings', { creation: { mode: 'anyone' } })).status, 200);
  s1 = (await alice.a.post('/api/v1/servers', { name: 'Admins' })).body.server.sid;
  s2 = (await bob.a.post('/api/v1/servers', { name: 'Bobs' })).body.server.sid;
  s3 = (await carol.a.post('/api/v1/servers', { name: 'Carols' })).body.server.sid;
  assert.equal((await alice.a.patch('/api/v1/bridge/settings', { discord: { token: TOKEN } })).status, 200);
  await until(async () => (await alice.a.get('/api/v1/bridge/settings')).body.bridges.discord.state === 'ready');
  assert.equal(idents[0].shard, undefined); // one connection: no shard field
});

test('linking a guild needs a verified claim (homeserver admins are trusted)', async () => {
  const no = await link(bob, s2, '111');
  assert.equal(no.status, 403);
  assert.deepEqual(no.body, { error: 'guild_not_verified', platform: 'discord', guild_id: '111' });
  assert.equal(await claimState(bob, s2, '111'), 'none');
  assert.equal((await claim(carol, s2, '111')).status, 403); // Manage server in that server
  assert.equal((await claim(bob, s2, 'abc')).body.error, 'bad_guild');
});

test('claim code: missing permission, wrong guild, then a role with Manage Server', async () => {
  const c = (await claim(bob, s2, '111')).body;
  assert.match(c.code, /^EC-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.ok(c.expires_at > Date.now() + 9 * 60000 && c.expires_at <= Date.now() + 10 * 60000);
  assert.equal(c.command, `!ember-claim ${c.code}`);
  assert.equal(await claimState(bob, s2, '111'), 'pending');
  say('111', '50', `!ember-claim ${c.code}`); // a member without Manage Server
  await until(() => said.some(x => /Only someone with Manage Server/.test(x.text)));
  assert.equal(await claimState(bob, s2, '111'), 'pending');
  say('222', '61', `!ember-claim ${c.code}`); // the right code in another guild (its owner, even)
  await until(() => said.some(x => x.channel === '2221' && /not for this server/.test(x.text)));
  assert.equal(await claimState(bob, s2, '111'), 'pending');
  say('111', '99', c.code); // not a member at all
  await settle();
  assert.equal(await claimState(bob, s2, '111'), 'pending');
  say('111', '51', `!ember-claim ${c.code.toLowerCase()}`); // the Mods role has Manage Server
  await until(async () => (await claimState(bob, s2, '111')) === 'verified');
  assert.ok(said.some(x => x.channel === '1111' && /Confirmed/.test(x.text) && /Bobs/.test(x.text)));
  assert.ok(calls.some(x => x.path === '/guilds/111/members/51') && calls.some(x => x.path === '/guilds/111'));
  // a verified claim is for that server and that guild only
  assert.equal((await link(carol, s3, '111')).body.error, 'guild_not_verified');
  assert.equal((await link(bob, s2, '222')).body.error, 'guild_not_verified');
  const ok = await link(bob, s2, '111');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.bridges[0].guild_name, 'One');
  assert.equal(db.get("SELECT verified FROM bridge_guilds WHERE guild_id = '111'").verified, 1);
  assert.equal(await claimState(bob, s2, '111'), 'none'); // spent
});

test('claim code: the guild owner, with the code alone; a code that ran out does nothing', async () => {
  const old = (await claim(carol, s3, '222')).body;
  db.run("UPDATE bridge_claims SET expires_at = ? WHERE guild_id = '222'", Date.now() - 1);
  say('222', '61', old.code);
  await settle();
  assert.equal(await claimState(carol, s3, '222'), 'none');
  const c = (await claim(carol, s3, '222')).body;
  assert.notEqual(c.code, old.code);
  say('222', '51', c.code); // in the guild, no roles, not the owner
  await settle();
  assert.equal(await claimState(carol, s3, '222'), 'pending');
  say('222', '61', c.code); // the owner: no role needed
  await until(async () => (await claimState(carol, s3, '222')) === 'verified');
  assert.equal(db.get("SELECT verified_by FROM bridge_claims WHERE guild_id = '222'").verified_by, '61');
  assert.equal((await link(carol, s3, '222')).status, 200);
});

test('one guild links to one server per homeserver', async () => {
  const r = await claim(carol, s1, '111').then(() => link(alice, s1, '111'));
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { error: 'guild_already_linked', sid: s2 });
  const c = await claim(alice, s1, '111');
  assert.deepEqual([c.status, c.body], [409, { error: 'guild_already_linked', sid: s2 }]);
});

test('!ember-unlink from someone with Manage Server over there takes the link away', async () => {
  say('111', '50', '!ember-unlink');
  await until(() => said.some(x => /can unlink this server/.test(x.text)));
  assert.equal((await bob.a.get(BR(s2))).body.bridges.length, 1);
  say('111', '51', '!ember-unlink');
  await until(async () => (await bob.a.get(BR(s2))).body.bridges.length === 0);
  assert.ok(calls.some(x => x.method === 'DELETE' && x.path.startsWith('/webhooks/')));
  assert.equal((await carol.a.get(BR(s3))).body.bridges.length, 1); // another guild's link is untouched
  // free again: an admin may link it without a claim
  assert.equal((await link(alice, s1, '111')).status, 200);
});

test('links made before the check stay valid', async () => {
  const raw = db.raw();
  raw.exec("ALTER TABLE bridge_guilds DROP COLUMN verified");
  store._forget(); store.ensure();
  assert.deepEqual(db.all('SELECT guild_id, verified FROM bridge_guilds ORDER BY guild_id').map(r => [r.guild_id, r.verified]), [['111', 1], ['222', 1]]);
  assert.equal((await carol.a.get(BR(s3))).body.bridges[0].guild_id, '222');
});

test('Discord sign-in: the guild must be one the person manages', async () => {
  assert.equal((await bob.a.get(`/api/v1/bridge/oauth/discord/start?sid=${s2}&guild_id=333`)).body.error, 'oauth_not_set_up');
  const set = await alice.a.patch('/api/v1/instance/settings', { bridges: { discord_oauth: { client_id: 'app1', client_secret: 'shh' } } });
  assert.deepEqual(set.body.bridges, { discord_oauth: { client_id: 'app1', has_secret: true }, discord_shards: 1 });
  assert.ok(!JSON.stringify(set.body).includes('shh'));
  assert.equal((await bob.a.get('/api/v1/bridge/platforms')).body.platforms.find(p => p.id === 'discord').oauth, true);
  const go = async guild => {
    const r = await bob.a.get(`/api/v1/bridge/oauth/discord/start?sid=${s2}&guild_id=${guild}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return new URL(r.body.url);
  };
  const u = await go('333');
  assert.equal(u.origin + u.pathname, fbase + '/oauth2/authorize');
  assert.deepEqual([u.searchParams.get('client_id'), u.searchParams.get('scope'), u.searchParams.get('redirect_uri')], ['app1', 'identify guilds', `${base.replace('127.0.0.1', 'localhost')}/api/v1/bridge/oauth/discord/callback`]);
  const back = (q) => fetch(`${base}/api/v1/bridge/oauth/discord/callback?${new URLSearchParams(q)}`);
  assert.equal((await back({ code: 'good', state: 'made-up' })).status, 400);
  const bad = await back({ code: 'nope', state: u.searchParams.get('state') });
  assert.equal(bad.status, 400);
  assert.equal((await back({ code: 'good', state: u.searchParams.get('state') })).status, 400); // a state works once
  const ok = await back({ code: 'good', state: (await go('333')).searchParams.get('state') });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Confirmed/);
  assert.equal(await claimState(bob, s2, '333'), 'verified');
  assert.equal((await link(bob, s2, '333')).status, 200);
  // in the guild without Manage Server: no
  const no = await back({ code: 'good', state: (await go('444')).searchParams.get('state') });
  assert.equal(no.status, 400);
  assert.match(await no.text(), /Manage Server/);
  assert.equal(await claimState(bob, s2, '444'), 'none');
  // not in their list at all
  assert.equal((await back({ code: 'good', state: (await go('999')).searchParams.get('state') })).status, 400);
});

test('shards: one connection each, identified with [i, n]', async () => {
  const before = idents.length;
  assert.equal((await alice.a.patch('/api/v1/instance/settings', { bridges: { discord_shards: 0 } })).body.error, 'invalid_bridges');
  const set = await alice.a.patch('/api/v1/instance/settings', { bridges: { discord_shards: 2 } });
  assert.deepEqual(set.body.bridges, { discord_oauth: { client_id: 'app1', has_secret: true }, discord_shards: 2 }); // the secret was not sent again and is kept
  await until(() => idents.length >= before + 2);
  assert.deepEqual(idents.slice(before).map(d => d.shard).sort(), [[0, 2], [1, 2]]);
  const st = await until(async () => { const b = (await alice.a.get('/api/v1/bridge/settings')).body.bridges.discord; return b.state === 'ready' && b; });
  assert.equal(st.shards, 2);
  assert.equal(B.clientFor('discord', '0').shard[0], 0);
  assert.equal(B.clientFor('discord', String(1n << 22n)).shard[0], 1);
});
