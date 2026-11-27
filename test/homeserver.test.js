'use strict';
// Many servers per homeserver (PROTOCOL §5a): creation rules, the creator owns the server, slugs + addresses, the discovery
// document, and everything that used to assume one community (bots, bridges, backups, the landing page).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
delete process.env.EMBER_OWNER;
delete process.env.EMBER_MANAGED;
delete process.env.EMBER_PUBLIC_URL;
const dir = tmpDir(), oldDir = tmpDir();
let inst, base, alice, bob, carol, dave, A, B;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
const S = (sid, p = '') => `/api/v1/servers/${sid}${p}`;
const make = async (who, body) => { const r = await who.a.post('/api/v1/servers', body); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.server; };
const creation = c => alice.a.patch('/api/v1/instance/settings', { creation: c });
const disco = async () => (await api(base).get('/.well-known/ember')).body;

test.after(async () => { await inst?.close(); for (const d of [dir, oldDir]) fs.rmSync(d, { recursive: true, force: true }); });

test('slug rules, and names turned into slugs', () => {
  const slug = require('../src/slug');
  for (const ok of ['abc', 'camp-fire', 'a1b', '0day', 'x'.repeat(32)]) assert.equal(slug.valid(ok), true, ok);
  for (const bad of ['', 'ab', 'x'.repeat(33), '-abc', 'abc-', 'a--b', 'Camp', 'a_b', 'a b', 'admin', 'api', 'well-known', 'ember', null, 5]) assert.equal(slug.valid(bad), false, String(bad));
  const taken = new Set(['camp-fire', 'camp-fire-2']);
  assert.equal(slug.derive('Camp  Fire!', s => taken.has(s)), 'camp-fire-3');
  assert.equal(slug.derive('  Élan & Co. ', () => false), 'lan-co');
  assert.equal(slug.derive('Admin', () => false).length, 8); // reserved: a random one
  assert.match(slug.derive('!!', () => false), /^[a-z0-9]{8}$/);
  const long = slug.derive('x'.repeat(60), s => s === 'x'.repeat(32));
  assert.equal(long.length, 32); assert.ok(long.endsWith('-2'));
});

test('migration: servers from before slugs get one each, and their backups stay theirs', () => {
  const config = require('../src/config'), db = require('../src/db');
  const { DatabaseSync } = require('node:sqlite');
  config.init({ dataDir: oldDir, port: 4998 });
  db.open(); db.close();
  const raw = new DatabaseSync(path.join(oldDir, 'ember.db'));
  raw.exec("DROP INDEX communities_slug; ALTER TABLE communities DROP COLUMN slug; ALTER TABLE instance_backups DROP COLUMN community_id; PRAGMA user_version = 21;");
  raw.exec("INSERT INTO users (principal, kind, username, display_name, username_lc, created_at) VALUES ('l:1', 'local', 'old', 'old', 'old', 1)");
  const add = raw.prepare('INSERT INTO communities (sid, name, owner_id, invite_code, created_at) VALUES (?, ?, 1, ?, 1)');
  ['Camp Fire', 'camp fire', 'Camp-Fire', 'Admin', '??'].forEach((n, i) => add.run('s' + i, n, 'code' + i));
  raw.exec("INSERT INTO instance_backups (id, created_at, size, by_principal) VALUES ('" + 'a'.repeat(32) + "', 1, 1, 'l:1')");
  raw.close();
  db.open();
  try {
    const rows = db.all('SELECT id, slug FROM communities ORDER BY id');
    assert.deepEqual(rows.slice(0, 3).map(r => r.slug), ['camp-fire', 'camp-fire-2', 'camp-fire-3']);
    for (const r of rows.slice(3)) assert.match(r.slug, /^[a-z0-9]{8}$/);
    assert.equal(new Set(rows.map(r => r.slug)).size, 5);
    assert.equal(db.get('SELECT community_id FROM instance_backups').community_id, rows[0].id);
    assert.throws(() => db.run('UPDATE communities SET slug = ? WHERE id = ?', 'camp-fire', rows[1].id), /UNIQUE/);
  } finally { db.close(); }
});

test('setup: an unclaimed homeserver has no servers', async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url;
  alice = await reg('alice'); bob = await reg('bob'); carol = await reg('carol'); dave = await reg('dave');
  await creation; // (not an admin yet)
  assert.equal((await alice.a.post('/api/v1/servers', { name: 'Too early' })).status, 403);
  const d = await disco();
  assert.equal(d.protocol, 1); assert.equal(d.protocol_version, 2);
  assert.equal(d.communities_count, 0); assert.deepEqual(d.communities, []); assert.equal(d.community, null);
  assert.deepEqual(d.homeserver, { domain: 'localhost', name: 'Ember Instance', description: '', icon_url: null });
  assert.equal((await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() })).status, 200);
  const s = (await alice.a.get('/api/v1/instance/settings')).body;
  assert.deepEqual(s.creation, { mode: 'admins', allowlist: [], per_account: null });
  assert.equal(s.domain, 'localhost');
});

test('creation rules: admins by default, then anyone / allowlist / request, and a cap per account', async () => {
  A = await make(alice, { name: 'Camp Fire', join_policy: 'open' });
  assert.equal(A.role, 'owner'); assert.equal(A.slug, 'camp-fire'); assert.equal(A.address, 'camp-fire@localhost');
  const denied = await bob.a.post('/api/v1/servers', { name: 'Bobs' });
  assert.equal(denied.status, 403); assert.equal(denied.body.error, 'forbidden');

  for (const bad of [{ mode: 'everyone' }, { per_account: 0 }, { per_account: 1.5 }, { allowlist: 'bob' }, { allowlist: [5] }, 'anyone', []]) {
    const r = await creation(bad);
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.body.error, 'invalid_creation');
  }
  assert.equal((await bob.a.patch('/api/v1/instance/settings', { creation: { mode: 'anyone' } })).status, 403);

  let r = await creation({ mode: 'anyone', per_account: 1 });
  assert.deepEqual(r.body.creation, { mode: 'anyone', allowlist: [], per_account: 1 });
  B = await make(bob, { name: 'Bobs Place', join_policy: 'open' });
  assert.equal(B.role, 'owner'); // whoever creates a server owns it
  assert.deepEqual((await bob.a.get(S(B.sid, '/members'))).body.members.map(m => [m.username, m.role]), [['bob', 'owner']]);
  assert.equal((await alice.a.get(S(B.sid))).body.error, 'not_a_member'); // the instance owner is not put in it
  const capped = await bob.a.post('/api/v1/servers', { name: 'Bobs Other Place' });
  assert.equal(capped.status, 403); assert.deepEqual(capped.body, { error: 'creation_limit', limit: 1, used: 1 });
  await alice.a.del(S((await make(alice, { name: 'Admins are not capped' })).sid));

  r = await creation({ mode: 'allowlist', allowlist: ['Carol', dave.user.id], per_account: null });
  assert.deepEqual(r.body.creation, { mode: 'allowlist', allowlist: ['carol', dave.user.id.toLowerCase()], per_account: null });
  assert.equal((await bob.a.post('/api/v1/servers', { name: 'No' })).body.error, 'forbidden');
  const c1 = await make(carol, { name: 'By username' }), d1 = await make(dave, { name: 'By principal' });
  await carol.a.del(S(c1.sid)); await dave.a.del(S(d1.sid));

  await creation({ mode: 'request' });
  r = await carol.a.post('/api/v1/servers', { name: 'Please' });
  assert.equal(r.status, 403); assert.equal(r.body.error, 'creation_requires_approval');
  const RQ = '/api/v2/server-requests', AQ = '/api/v2/homeserver/server-requests';
  assert.equal(r.body.request_url, (await api(base).get('/.well-known/ember')).body.creation.request_url);
  assert.match(r.body.request_url, /\/api\/v2\/server-requests$/);
  await alice.a.del(S((await make(alice, { name: 'Admins need no approval' })).sid));
  // the queue: carol asks, alice (an admin) approves; carol's server is made then, hers
  assert.equal((await carol.a.post(RQ, {})).body.error, 'name_required');
  assert.equal((await carol.a.post(RQ, { name: 'X', slug: 'Bad Slug' })).body.error, 'invalid_slug');
  r = await carol.a.post(RQ, { name: 'Carol Club', slug: 'carol-club', description: 'for carols', note: 'please?' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const req1 = r.body.request;
  assert.deepEqual([req1.status, req1.slug, req1.account.username], ['pending', 'carol-club', 'carol']);
  assert.equal((await carol.a.post(RQ, { name: 'Second' })).body.error, 'request_pending');
  assert.equal((await dave.a.post(RQ, { name: 'Same address', slug: 'carol-club' })).body.error, 'slug_taken');
  assert.equal((await carol.a.get(AQ)).status, 403);
  assert.deepEqual((await alice.a.get(AQ)).body.requests.map(x => x.name), ['Carol Club']);
  r = await alice.a.post(`${AQ}/${req1.id}/approve`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.request.status, 'approved');
  const made = (await carol.a.get(S(r.body.request.sid))).body;
  assert.deepEqual([made.server.name, made.server.slug, made.server.role], ['Carol Club', 'carol-club', 'owner']);
  assert.equal((await alice.a.post(`${AQ}/${req1.id}/approve`)).body.error, 'request_not_found');
  // dave asks and is turned down, with a reason; a request can also be taken back
  const req2 = (await dave.a.post(RQ, { name: 'Dave Den' })).body.request;
  r = await alice.a.post(`${AQ}/${req2.id}/reject`, { reason: 'not now' });
  assert.deepEqual([r.body.request.status, r.body.request.reason], ['rejected', 'not now']);
  const req3 = (await dave.a.post(RQ, { name: 'Dave Den 2' })).body.request;
  assert.deepEqual((await dave.a.del(`${RQ}/${req3.id}`)).body.requests.map(x => x.status), ['cancelled', 'rejected']);
  assert.equal((await alice.a.get(AQ + '?status=rejected')).body.requests.length, 1);
  await carol.a.del(S(made.server.sid));
  await creation({ mode: 'admins' });
  assert.equal((await carol.a.post(RQ, { name: 'Later' })).body.error, 'requests_not_used');
  await creation({ mode: 'admins' });
  assert.equal((await api(base).get('/.well-known/ember')).body.communities_count, 2);
  assert.deepEqual((await alice.a.get('/api/v1/servers')).body.servers.map(s => s.sid), [A.sid]);
});

test('slugs: picked or derived, unique, changed by the owner only', async () => {
  for (const bad of ['ab', 'Has Space', 'a--b', '-abc', 'admin', 'uploads', 'x'.repeat(33), 7]) {
    const r = await alice.a.post('/api/v1/servers', { name: 'Slugged', slug: bad });
    assert.equal(r.status, 400, String(bad)); assert.equal(r.body.error, 'invalid_slug');
  }
  const taken = await alice.a.post('/api/v1/servers', { name: 'Slugged', slug: 'camp-fire' });
  assert.equal(taken.status, 409); assert.equal(taken.body.error, 'slug_taken');
  const picked = await make(alice, { name: 'Slugged', slug: ' Tree-House ' });
  assert.equal(picked.slug, 'tree-house');
  const twin = await make(alice, { name: 'Camp Fire' });
  assert.equal(twin.slug, 'camp-fire-2');
  const odd = await make(alice, { name: '!!' });
  assert.match(odd.slug, /^[a-z0-9]{8}$/);
  for (const s of [picked, twin, odd]) await alice.a.del(S(s.sid));

  // carol runs bob's server with him (Administrator), but the address is the owner's
  assert.equal((await carol.a.post(S(B.sid, '/join'))).status, 200);
  const role = (await bob.a.post(S(B.sid, '/roles'), { name: 'Admin', permissions: 512 })).body.role;
  await bob.a.put(S(B.sid, `/members/${encodeURIComponent(carol.user.id)}/roles/${role.rid}`));
  assert.equal((await carol.a.patch(S(B.sid), { description: 'run by two' })).status, 200);
  const no = await carol.a.patch(S(B.sid), { slug: 'carols' });
  assert.equal(no.status, 403); assert.equal(no.body.error, 'owner_only');
  assert.equal((await bob.a.patch(S(B.sid), { slug: 'x' })).body.error, 'invalid_slug');
  assert.equal((await bob.a.patch(S(B.sid), { slug: 'camp-fire' })).body.error, 'slug_taken');
  assert.equal((await bob.a.patch(S(B.sid), { slug: 'bobs-place' })).status, 200); // its own slug again: fine
  const moved = await bob.a.patch(S(B.sid), { slug: 'Bobs' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.server.slug, 'bobs'); assert.equal(moved.body.server.address, 'bobs@localhost');
  assert.equal((await bob.a.get(S(B.sid))).body.server.slug, 'bobs');
  B.slug = 'bobs';
});

test('resolve: slug@domain or the slug alone; the domain is a setting', async () => {
  const get = a => api(base).get('/api/v1/servers/resolve?address=' + encodeURIComponent(a));
  assert.deepEqual((await get('bobs@localhost')).body, { sid: B.sid, slug: 'bobs', address: 'bobs@localhost' });
  assert.deepEqual((await get(' Camp-Fire ')).body, { sid: A.sid, slug: 'camp-fire', address: 'camp-fire@localhost' });
  for (const [a, code] of [['nobody@localhost', 'server_not_found'], ['bobs-place', 'server_not_found'], ['bobs@elsewhere.example', 'wrong_homeserver'], ['', 'server_not_found'], ['a@b@c', 'server_not_found']]) {
    const r = await get(a);
    assert.equal(r.status, 404, a); assert.equal(r.body.error, code, a);
  }
  assert.equal((await alice.a.patch('/api/v1/instance/settings', { domain: 'not a domain' })).body.error, 'invalid_domain');
  assert.equal((await alice.a.patch('/api/v1/instance/settings', { domain: 'Chat.Example' })).body.domain, 'chat.example');
  assert.equal((await get('bobs@chat.example')).body.address, 'bobs@chat.example');
  assert.equal((await get('bobs@localhost')).body.error, 'wrong_homeserver');
  assert.equal((await bob.a.get(S(B.sid))).body.server.address, 'bobs@chat.example');
  assert.equal((await disco()).homeserver.domain, 'chat.example');
  assert.equal((await alice.a.patch('/api/v1/instance/settings', { domain: null })).body.domain, 'localhost'); // back to the public url's host
});

test('discovery and /discover: the listed servers, and one `community` for old clients', async () => {
  let d = await disco();
  assert.equal(d.communities_count, 2); assert.deepEqual(d.communities, []);
  assert.equal(d.community.sid, A.sid); // none listed: the oldest
  assert.deepEqual((await dave.a.get('/api/v1/discover')).body.servers, []);
  assert.deepEqual((await bob.a.get('/api/v1/discover')).body.servers.map(s => [s.sid, s.joined]), [[B.sid, true]]); // yours, listed or not

  assert.equal((await bob.a.patch(S(B.sid), { listed: true })).status, 200);
  d = await disco();
  assert.deepEqual(d.communities, [{ sid: B.sid, slug: 'bobs', address: 'bobs@localhost', name: 'Bobs Place', icon_url: null, description: 'run by two', member_count: 2, join_policy: 'open' }]);
  assert.equal(d.community.sid, B.sid); // the oldest listed one
  assert.deepEqual(d.community, d.communities[0]);
  assert.equal((await alice.a.get('/api/v1/instance/settings')).body.listed, true);
  assert.deepEqual((await dave.a.get('/api/v1/discover')).body.servers.map(s => [s.sid, s.joined]), [[B.sid, false]]);
  assert.deepEqual((await alice.a.get('/api/v1/discover')).body.servers.map(s => [s.sid, s.joined]), [[A.sid, true], [B.sid, false]]);

  assert.equal((await alice.a.patch(S(A.sid), { listed: true })).status, 200);
  d = await disco();
  assert.deepEqual(d.communities.map(c => c.sid), [A.sid, B.sid]);
  assert.equal(d.community.sid, A.sid);
  // the homeserver's name is its own: neither server's
  assert.equal(d.name, 'Ember Instance'); assert.equal(d.homeserver.name, 'Ember Instance');
});

test('landing page: the homeserver on top, every listed server under it', async () => {
  require('../src/landing').resetCache();
  await alice.a.patch('/api/v1/instance/settings', { name: 'The Woods', description: 'a homeserver <b>for</b> camps' });
  const html = await (await fetch(base + '/', { headers: { Accept: 'text/html' } })).text();
  assert.match(html, /<title>The Woods on Ember<\/title>/);
  assert.ok(html.includes('a homeserver &lt;b&gt;for&lt;/b&gt; camps'));
  for (const s of ['<h3>Camp Fire</h3>', '<h3>Bobs Place</h3>', 'camp-fire@localhost', 'bobs@localhost', 'run by two']) assert.ok(html.includes(s), s);
  const invites = [(await alice.a.get(S(A.sid))).body.server.invite, (await bob.a.get(S(B.sid))).body.server.invite];
  for (const [i, code] of invites.entries()) assert.ok(html.includes(`/i/${['camp-fire', 'bobs'][i]}/${code}"`), 'join link');
  assert.ok(!html.includes('alice') && !html.includes('carol'), 'no member names');
  const stats = (await api(base).get('/api/v1/instance/stats')).body;
  assert.equal(stats.name, 'The Woods'); assert.equal(stats.domain, 'localhost');
  assert.deepEqual(stats.servers.map(s => [s.slug, s.address, s.members, s.join_policy]), [['camp-fire', 'camp-fire@localhost', 1, 'open'], ['bobs', 'bobs@localhost', 2, 'open']]);
  assert.equal(stats.members, 3); // people, counted once
  // an unlisted server is not shown once there are several
  await alice.a.patch(S(A.sid), { listed: false });
  require('../src/landing').resetCache();
  const less = await (await fetch(base + '/', { headers: { Accept: 'text/html' } })).text();
  assert.ok(!less.includes('<h3>Camp Fire</h3>') && less.includes('<h3>Bobs Place</h3>'));
  await alice.a.patch(S(A.sid), { listed: true });
});

test('bots: can_add_to covers every server you manage; managers handle their own bots', async () => {
  const A2 = await make(alice, { name: 'Second Camp' });
  const made = await alice.a.post('/api/v1/bots', { name: 'helper' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const info = async who => (await who.a.get('/api/v1/bots/by-name/helper')).body.can_add_to.map(s => s.sid);
  assert.deepEqual(await info(alice), [A.sid, A2.sid]);
  assert.equal((await alice.a.patch('/api/v1/bots/' + made.body.bot.id, { public: false })).status, 200);
  assert.deepEqual(await info(bob), []); // a private bot
  assert.equal((await alice.a.patch('/api/v1/bots/' + made.body.bot.id, { public: true })).status, 200);
  assert.deepEqual(await info(bob), [B.sid]);
  assert.deepEqual(await info(carol), [B.sid]); // Administrator there
  assert.deepEqual(await info(dave), []);
  assert.equal((await alice.a.post('/api/v1/bots/by-name/helper/add', { sid: A.sid })).status, 200);
  assert.deepEqual(await info(alice), [A2.sid]);
  assert.equal((await bob.a.post('/api/v1/bots/by-name/helper/add', { sid: A2.sid })).status, 403);
  assert.equal((await bob.a.post('/api/v1/bots/by-name/helper/add', { sid: B.sid })).status, 200);
  assert.deepEqual(await info(bob), []);

  // a server's manager: makes bots, sees and changes only their own; instance admins see all
  assert.equal((await dave.a.get('/api/v1/bots')).status, 403);
  assert.equal((await bob.a.get('/api/v1/bots?sid=' + A.sid)).status, 403); // not a manager of that one
  assert.deepEqual((await bob.a.get('/api/v1/bots?sid=' + B.sid)).body.bots, []);
  for (const r of [await bob.a.patch('/api/v1/bots/' + made.body.bot.id, { description: 'mine now' }), await bob.a.post(`/api/v1/bots/${made.body.bot.id}/token`), await bob.a.del('/api/v1/bots/' + made.body.bot.id)]) { assert.equal(r.status, 403); assert.equal(r.body.error, 'not_allowed'); }
  const own = await bob.a.post('/api/v1/bots', { name: 'bobbot', sid: B.sid });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.deepEqual((await bob.a.get('/api/v1/bots')).body.bots.map(b => b.username), ['bobbot']);
  assert.equal((await bob.a.patch('/api/v1/bots/' + own.body.bot.id, { description: 'hello' })).status, 200);
  assert.deepEqual((await alice.a.get('/api/v1/bots')).body.bots.map(b => b.username), ['helper', 'bobbot']);
  assert.equal((await alice.a.del(S(A2.sid))).status, 200);
});

test('routes without a sid: the only server when there is one, 400 sid_required otherwise', async () => {
  const none = await alice.a.get('/api/v1/bridge/discord/guilds');
  assert.equal(none.status, 400); assert.equal(none.body.error, 'sid_required');
  const mine = await alice.a.get('/api/v1/bridge/discord/guilds?sid=' + A.sid);
  assert.notEqual(mine.body.error, 'sid_required'); assert.notEqual(mine.status, 403);
  assert.equal((await alice.a.get('/api/v1/bridge/discord/guilds?sid=' + B.sid)).status, 403); // not hers
  assert.equal((await alice.a.get('/api/v1/bridge/discord/guilds?sid=s0000000000')).body.error, 'server_not_found');
  assert.equal((await alice.a.get('/api/v1/bridge/matrix/guilds')).body.error, 'sid_required');
  assert.equal((await alice.a.post('/api/v1/game/claims', {})).body.error, 'sid_required');
  assert.notEqual((await alice.a.post('/api/v1/game/claims', { sid: A.sid })).body.error, 'sid_required');
  assert.equal((await alice.a.post('/api/v1/instance/backups')).body.error, 'sid_required');
  assert.equal((await alice.a.get('/api/v1/instance/backups')).body.error, 'sid_required');
});

test('backups: one server at a time; a restore leaves the other server alone', async () => {
  const BK = '/api/v1/instance/backups';
  const text = d => d.channels.find(c => c.type === 'text').cid;
  const bDetail = (await bob.a.get(S(B.sid))).body, aDetail = (await alice.a.get(S(A.sid))).body;
  assert.equal((await bob.a.post(`/api/v1/channels/${text(bDetail)}/messages`, { message: 'before the backup' })).status, 200);
  assert.equal((await alice.a.post(`/api/v1/channels/${text(aDetail)}/messages`, { message: 'in the other server' })).status, 200);
  assert.equal((await bob.a.post(BK, { sid: B.sid })).status, 403); // still an instance admin's tool

  const made = await alice.a.post(BK, { sid: B.sid, note: 'checkpoint' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.backup.sid, B.sid);
  assert.deepEqual((await alice.a.get(BK + '?sid=' + B.sid)).body.backups.map(b => b.note), ['checkpoint']);
  assert.deepEqual((await alice.a.get(BK + '?sid=' + A.sid)).body.backups, []);
  assert.equal((await alice.a.post(BK + '?sid=' + A.sid, { note: 'the other one' })).body.backup.sid, A.sid);

  // max_backups counts per server
  await alice.a.patch('/api/v1/instance/settings', { max_backups: 2 });
  for (const n of ['b2', 'b3']) await alice.a.post(BK, { sid: B.sid, note: n });
  assert.deepEqual((await alice.a.get(BK + '?sid=' + B.sid)).body.backups.map(b => b.note), ['b3', 'b2']);
  assert.deepEqual((await alice.a.get(BK + '?sid=' + A.sid)).body.backups.map(b => b.note), ['the other one']);
  await alice.a.patch('/api/v1/instance/settings', { max_backups: 10 });

  // bob's server changes, then goes back to b3
  assert.equal((await bob.a.post(S(B.sid, '/channels'), { name: 'made-later' })).status, 200);
  const b3 = (await alice.a.get(BK + '?sid=' + B.sid)).body.backups[0];
  const f = new FormData(); f.append('file', new Blob([(await alice.a.get(`${BK}/${b3.id}/download`)).body]), 'export.zip');
  assert.equal((await alice.a.raw('POST', '/api/v1/instance/restore', f)).body.error, 'sid_required');
  const restored = await alice.a.post(`${BK}/${b3.id}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const nsid = restored.body.sid;
  assert.notEqual(nsid, B.sid);
  assert.equal((await bob.a.get(S(B.sid))).status, 404);
  const back = (await bob.a.get(S(nsid))).body;
  assert.equal(back.server.role, 'owner'); // still bob's, not the admin's who restored it
  assert.equal(back.server.slug, 'bobs'); assert.equal(back.server.name, 'Bobs Place');
  assert.ok(!back.channels.some(c => c.name === 'made-later'));
  assert.ok(JSON.stringify((await bob.a.get(`/api/v1/channels/${text(back)}/messages`)).body.messages).includes('before the backup'));
  assert.equal((await alice.a.get(S(nsid))).body.error, 'not_a_member');
  assert.deepEqual((await alice.a.get(BK + '?sid=' + nsid)).body.backups.map(b => b.note), ['before restore', 'b3', 'b2']); // its backups follow it

  // the other server: same sid, same channels, same messages, same backups
  const aAfter = (await alice.a.get(S(A.sid))).body;
  assert.equal(aAfter.server.slug, 'camp-fire');
  assert.deepEqual(aAfter.channels.map(c => c.cid), aDetail.channels.map(c => c.cid));
  assert.ok(JSON.stringify((await alice.a.get(`/api/v1/channels/${text(aAfter)}/messages`)).body.messages).includes('in the other server'));
  assert.deepEqual((await alice.a.get(BK + '?sid=' + A.sid)).body.backups.map(b => b.note), ['the other one']);
  assert.equal((await disco()).communities_count, 2);

  // an uploaded export over one server (?sid=)
  const up = new FormData(); up.append('file', new Blob([(await alice.a.get(`${BK}/${b3.id}/download`)).body]), 'export.zip');
  const over = await alice.a.raw('POST', '/api/v1/instance/restore?sid=' + nsid, up);
  assert.equal(over.status, 200, JSON.stringify(over.body));
  assert.equal((await bob.a.get(S(over.body.sid))).body.server.slug, 'bobs');
  assert.equal((await alice.a.get(S(A.sid))).status, 200);
  B.sid = over.body.sid;
});

test('cli export: one zip per server, named by slug', () => {
  const { spawnSync } = require('child_process');
  const out = path.join(dir, 'host-backup.zip');
  const run = spawnSync(process.execPath, [path.join(__dirname, '../src/cli.js'), 'export', out], { env: { ...process.env, EMBER_DATA: dir }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const res = JSON.parse(run.stdout);
  assert.deepEqual(res.files.map(f => [f.sid, f.slug, path.basename(f.file)]), [[A.sid, 'camp-fire', 'host-backup-camp-fire.zip'], [B.sid, 'bobs', 'host-backup-bobs.zip']]);
  for (const f of res.files) assert.equal(fs.statSync(f.file).size, f.size);
  assert.ok(!fs.existsSync(out));
});
