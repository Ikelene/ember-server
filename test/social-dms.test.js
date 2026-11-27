'use strict';
// DMs between homeservers (PROTOCOL §4c): a DM lives where it was started (a community of kind 'dm'), members from
// elsewhere use it with a cross-homeserver session, and their homeserver keeps a pointer that counts new messages and
// pushes. Homeserver A runs in a worker thread, homeserver B in this one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { tmpDir, api, wsClient, startHomeserver, mockHomeserver } = require('./helpers');
const nke1 = require('./nke1');

process.env.EMBER_ACCOUNTS_MODE = 'local';
process.env.EMBER_DEV = '1';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const { startServer } = require('../src/index');
const config = require('../src/config');
const db = require('../src/db');
const push = require('../src/push');
const s2s = require('../src/social/s2s');
const dms = require('../src/social/dms');
const friendsMod = require('../src/social/friends');
const messages = require('../src/messages');

const dirA = tmpDir(), dirB = tmpDir();
let A, B, baseB, alice, amy, bo, bob, bea, mockHs, gw, GW, one, cid;
const pushed = [], sockets = [];
const PW = 'correct horse battery';
const ALICE = 'l:1@a.example', AMY = 'l:2@a.example', BOB = 'l:2@b.example', BEA = 'l:3@b.example';
const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(30); } }
const reg = async (base, n) => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: PW }); assert.equal(r.status, 200, JSON.stringify(r.body)); return { ...r.body, a: api(base, r.body.session) }; };
const dmList = async who => (await who.a.get('/api/v2/social/dms')).body.dms;
const settle = async () => { dms._test.flush(); await s2s.idle(); await A.call('idle'); await s2s.idle(); await push.idle(); };
// (a DM only takes sealed messages, PROTOCOL §4d: what it says is the client's business, so here it is an envelope nobody opens)
const say = (who, channel, message) => { messages._sendLimit.reset(); return who.a.post(`/api/v1/channels/${channel}/messages`, { enc: nke1.sealed(message) }); };
const dmCount = () => db.get("SELECT COUNT(*) AS n FROM communities WHERE kind = 'dm'").n;
// alice (an account of A) signed in on B
async function onB(who) {
  const t = await who.a.post('/api/v2/auth/remote-token', { audience: baseB });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const r = await api(baseB).post('/api/v2/auth/remote', { token: t.body.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { session: r.body.access_token, a: api(baseB, r.body.access_token) };
}
const friend = async (x, handle, y, id) => {
  friendsMod._test.requestLimit.reset();
  assert.equal((await x.a.post('/api/v2/social/friends', { handle })).status, 200);
  assert.equal((await y.a.post(`/api/v2/social/friends/${enc(id)}/accept`)).body.status, 'friends');
};

test.before(async () => {
  gw = http.createServer((req, res) => { let b = ''; req.on('data', d => { b += d; }); req.on('end', () => { pushed.push({ homeserver: req.headers['x-ember-homeserver'], n: JSON.parse(b).notification }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"rejected":[]}'); }); });
  await new Promise(r => gw.listen(0, '127.0.0.1', r));
  GW = `http://127.0.0.1:${gw.address().port}/_ember/push/v1/notify`;
  B = await startServer({ dataDir: dirB, port: 0 });
  baseB = `http://localhost:${B.port}`;
  config.update({ domain: 'b.example', federation: { denylists: [] }, accounts: { remote_accounts: { mode: 'all', list: [] } } });
  bo = await reg(baseB, 'bo');
  assert.equal((await bo.a.post('/api/v1/instance/claim', { code: B.setup.current() })).status, 200);
  bob = await reg(baseB, 'bob'); bea = await reg(baseB, 'bea');
  A = await startHomeserver({ dataDir: dirA, config: { domain: 'a.example', accounts: { remote_accounts: { mode: 'all', list: [] } }, federation: { denylists: [], dev_origins: { 'b.example': baseB } } } });
  alice = await reg(A.url, 'alice');
  assert.equal((await alice.a.post('/api/v1/instance/claim', { code: A.setupCode })).status, 200);
  amy = await reg(A.url, 'amy');
  mockHs = await mockHomeserver('m.example');
  config.update({ federation: { dev_origins: { 'a.example': A.url, 'm.example': mockHs.origin } } });
  s2s._test.setRetry([20, 20]); await A.call('setRetry', [20, 20]);
  dms._test.setWindow(20);
});
test.after(async () => {
  sockets.forEach(s => s.close());
  await A?.close(); await B?.close(); await mockHs?.close();
  gw.closeAllConnections?.(); gw.close();
  for (const d of [dirA, dirB]) fs.rmSync(d, { recursive: true, force: true });
});

test('who may start a DM is each member\'s own choice, kept by their homeserver', async () => {
  // dm_from is "friends" by default: a stranger is refused, here and across homeservers, and nothing is made
  let r = await bob.a.post('/api/v2/social/dms', { members: ['bea'] });
  assert.deepEqual([r.status, r.body.error, r.body.member], [403, 'dm_not_allowed', BEA]);
  r = await bob.a.post('/api/v2/social/dms', { members: ['alice@a.example'] });
  assert.deepEqual([r.status, r.body.error, r.body.member], [403, 'dm_not_allowed', ALICE]);
  assert.equal(dmCount(), 0);
  assert.deepEqual(await dmList(alice), []);
  assert.equal((await bob.a.post('/api/v2/social/dms', { members: [] })).body.error, 'invalid_members');
  assert.equal((await bob.a.post('/api/v2/social/dms', { members: ['bob'] })).body.error, 'invalid_members'); // only himself
  assert.equal((await bob.a.post('/api/v2/social/dms', { members: ['ghost@a.example'] })).body.error, 'user_not_found');
  // "nobody" refuses friends too
  await friend(bob, 'alice@a.example', alice, BOB);
  assert.equal((await alice.a.patch('/api/v1/settings', { dm_from: 'nobody' })).body.settings.dm_from, 'nobody');
  r = await bob.a.post('/api/v2/social/dms', { members: ['alice@a.example'] });
  assert.deepEqual([r.status, r.body.error], [403, 'dm_not_allowed']);
  assert.equal(dmCount(), 0);
  assert.equal((await alice.a.patch('/api/v1/settings', { dm_from: 'everyone' })).body.settings.dm_from, 'nobody'); // not a choice
  await alice.a.patch('/api/v1/settings', { dm_from: 'friends' });
});

test('a DM is started on the starter\'s homeserver; the other member\'s homeserver gets a pointer', async () => {
  const r = await bob.a.post('/api/v2/social/dms', { members: ['alice@a.example'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  one = r.body.dm; cid = one.channel;
  assert.equal(r.body.created, true);
  assert.match(one.id, /^d[0-9a-f]{10}@b\.example$/);
  assert.deepEqual([one.host, one.host_origin, one.hosted_here, one.group, one.name, one.owner, one.unread], ['b.example', baseB, true, false, null, null, 0]);
  assert.deepEqual(one.members.map(m => [m.id, m.handle]), [[BOB, 'bob@b.example'], [ALICE, 'alice@a.example']]);
  assert.equal(dmCount(), 1);
  // on A: a pointer, nothing else (no community, no messages)
  const p = (await dmList(alice))[0];
  assert.deepEqual([p.id, p.host, p.host_origin, p.hosted_here, p.group, p.unread, p.channel, p.sid], [one.id, 'b.example', baseB, false, false, 0, cid, one.sid]);
  assert.deepEqual(p.members.map(m => m.id), [BOB, ALICE]);
  assert.equal((await A.call('sql', { query: "SELECT COUNT(*) AS n FROM communities WHERE kind = 'dm'" }))[0].n, 0);
  assert.equal((await alice.a.get(`/api/v2/social/dms/${enc(one.id)}`)).body.dm.id, one.id);
  // starting it again gives the same one, from either side
  const again = await bob.a.post('/api/v2/social/dms', { member_ids: [ALICE] });
  assert.deepEqual([again.body.created, again.body.dm.id], [false, one.id]);
  const fromA = await alice.a.post('/api/v2/social/dms', { members: ['bob@b.example'] });
  assert.deepEqual([fromA.status, fromA.body.created, fromA.body.dm.id, fromA.body.dm.hosted_here], [200, false, one.id, false]);
  assert.equal(dmCount(), 1);
  // a DM between two accounts of one homeserver needs no other homeserver
  await friend(bob, 'bea', bea, BOB);
  const local = (await bob.a.post('/api/v2/social/dms', { members: ['bea'] })).body.dm;
  assert.deepEqual(local.members.map(m => m.id), [BOB, BEA]);
  assert.deepEqual((await dmList(bea)).map(d => d.id), [local.id]);
});

test('the member from the other homeserver reads and writes in the DM through its host', async () => {
  const bobWs = await wsClient(baseB).login(bob.session); sockets.push(bobWs);
  const al = await onB(alice);
  const mine = (await al.a.get('/api/v2/social/dms')).body.dms;
  assert.deepEqual(mine.map(d => [d.id, d.hosted_here, d.channel]), [[one.id, true, cid]]);
  let r = await say(al, cid, 'hello from the other side');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.author.id, ALICE);
  const got = await bobWs.waitFor(f => f.type === 'chat_message' && f.message.id === r.body.message.id);
  assert.deepEqual([got.message.channel, got.message.body, got.message.enc.ct], [cid, '', r.body.message.enc.ct]);
  assert.equal((await dmList(bob)).find(d => d.id === one.id).unread, 1);
  const hist = await bob.a.get(`/api/v1/channels/${cid}/messages`);
  assert.equal(hist.status, 200);
  assert.deepEqual(hist.body.messages.at(-1).enc, r.body.message.enc);
  assert.equal((await bob.a.post(`/api/v2/social/dms/${enc(one.id)}/read`)).body.dm.unread, 0);
  // her gateway connection on B hears the DM like any channel
  const alWs = await wsClient(baseB).login(al.session); sockets.push(alWs);
  const hi = (await say(bob, cid, 'hi alice')).body.message;
  await alWs.waitFor(f => f.type === 'chat_message' && f.message.id === hi.id);
  // uploads work as in a server, for files sealed on the device
  const form = () => { const f = new FormData(); f.append('file', new Blob([Buffer.from('sealed bytes')], { type: 'application/octet-stream' }), 'file.bin'); return f; };
  const up = await al.a.raw('POST', `/api/v1/media/upload?sid=${one.sid}&cid=${cid}&sealed=1`, form());
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await al.a.raw('POST', `/api/v1/media/upload?sid=${one.sid}&cid=${cid}`, form())).body.error, 'e2ee_required');
  // someone who is not in it gets nothing
  assert.equal((await bea.a.get(`/api/v1/channels/${cid}/messages`)).status, 403);
  assert.equal((await say(bea, cid, 'let me in')).status, 403);
  assert.equal((await bea.a.get(`/api/v2/social/dms/${enc(one.id)}`)).body.error, 'dm_not_found');
  alWs.close(); bobWs.close();
});

test('new messages reach the other homeserver: the pointer counts them and the account is pushed', async () => {
  await settle(); // (what was said so far has been reported)
  assert.equal((await alice.a.post('/api/v2/pushers', { app_id: 'cc.test', pushkey: 'alice-phone', gateway_url: GW })).status, 200);
  await alice.a.post(`/api/v2/social/dms/${enc(one.id)}/read`);
  const m = (await say(bob, cid, 'are you there?')).body.message;
  await say(bob, cid, `and again <@${ALICE}>`);
  const p = await until(async () => { await settle(); const x = (await dmList(alice))[0]; return x.unread >= 2 ? x : null; });
  assert.deepEqual([p.unread, p.mention, p.hosted_here], [2, false, false]); // (the host cannot tell who a sealed message mentions)
  assert.ok(Number(p.last_message_id) > Number(m.id));
  await until(() => pushed.length >= 1);
  const n = pushed.find(x => x.n.pushkey === 'alice-phone');
  assert.deepEqual([n.homeserver, n.n.kind, n.n.title, n.n.homeserver], ['a.example', 'dm', 'bob', 'a.example']);
  assert.equal(n.n.preview, 'sent a message'); // never what it says
  assert.equal(n.n.counts.unread, 1);
  // reading clears the pointer; her own messages do not count for her
  assert.deepEqual([(await alice.a.post(`/api/v2/social/dms/${enc(one.id)}/read`)).body.dm.unread, (await dmList(alice))[0].mention], [0, false]);
  const al = await onB(alice);
  await say(al, cid, 'here now');
  await settle();
  assert.equal((await dmList(alice))[0].unread, 0);
  // a member on the host who is not connected is pushed by the host, as a dm
  assert.equal((await bob.a.post('/api/v2/pushers', { app_id: 'cc.test', pushkey: 'bob-phone', gateway_url: GW })).status, 200);
  pushed.length = 0;
  await say(al, cid, 'one for bob');
  await until(async () => { await push.idle(); return pushed.some(x => x.n.pushkey === 'bob-phone'); });
  const nb = pushed.find(x => x.n.pushkey === 'bob-phone').n;
  assert.deepEqual([nb.kind, nb.title, nb.preview], ['dm', 'alice@a.example', 'sent a message']);
  assert.ok(!pushed.some(x => x.n.pushkey === 'alice-phone')); // not her: she wrote it
});

test('only the host can speak for its DMs', async () => {
  let r = await mockHs.s2s(baseB, 'POST', '/dm_pointer', { dm: { id: 'd1234567890@a.example', host: 'a.example', members: [{ id: BOB }] }, to: BOB, kind: 'added', from: 'l:1@m.example' });
  assert.deepEqual([r.status, r.body.error], [403, 'dm_host_mismatch']);
  r = await mockHs.s2s(baseB, 'POST', '/dm_pointer', { dm: { id: 'd1234567890@m.example', host: 'm.example', members: [{ id: BOB }, { id: 'l:1@m.example' }] }, to: BOB, kind: 'added', from: ALICE });
  assert.deepEqual([r.status, r.body.error], [403, 'from_mismatch']);
  r = await mockHs.s2s(baseB, 'POST', '/dm_pointer', { dm: { id: 'd1234567890@m.example', host: 'm.example', members: [{ id: BOB }, { id: 'l:1@m.example' }] }, to: BOB, kind: 'added', from: 'l:1@m.example' });
  assert.deepEqual([r.status, r.body.error], [403, 'dm_not_allowed']); // not his friend
  r = await mockHs.s2s(baseB, 'POST', '/dm_activity', { dm: 'd1234567890@m.example', to: BOB, last_message_id: '5' });
  assert.deepEqual([r.status, r.body.error], [410, 'pointer_gone']);
  r = await mockHs.s2s(baseB, 'POST', '/dm_activity', { dm: one.id, to: BOB, last_message_id: '5' });
  assert.deepEqual([r.status, r.body.error], [403, 'dm_host_mismatch']);
  r = await mockHs.s2s(baseB, 'POST', '/dm_pointer', { dm: { id: 'd1234567890@m.example', host: 'm.example' }, to: BOB, kind: 'renamed' });
  assert.equal(r.status, 410);
  // an account that takes DMs from anyone gets the pointer, and activity updates it and reaches its sockets
  await bob.a.patch('/api/v1/settings', { dm_from: 'anyone' });
  const bobWs = await wsClient(baseB).login(bob.session); sockets.push(bobWs);
  const dm = { id: 'd1234567890@m.example', host: 'm.example', name: 'ignored for two', channel: 'c0000000001', sid: 'd1234567890', members: [{ id: BOB, handle: 'bob@b.example' }, { id: 'l:1@m.example', handle: 'mo@m.example', display_name: 'Mo' }, { id: 'bad id' }] };
  r = await mockHs.s2s(baseB, 'POST', '/dm_pointer', { dm, to: BOB, kind: 'added', from: 'l:1@m.example' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await bobWs.waitFor(f => f.type === 'social_dm_update' && f.dm.id === dm.id);
  let p = (await dmList(bob)).find(d => d.id === dm.id);
  assert.deepEqual([p.host_origin, p.hosted_here, p.members.length, p.members[1].display_name], [mockHs.origin, false, 2, 'Mo']);
  r = await mockHs.s2s(baseB, 'POST', '/dm_activity', { dm: dm.id, to: BOB, last_message_id: '41', count: 3, mention: true, preview: 'psst', sender: { id: 'l:1@m.example', display_name: 'Mo' } });
  assert.equal(r.status, 200);
  const ev = await bobWs.waitFor(f => f.type === 'social_dm_activity' && f.dm.id === dm.id);
  assert.deepEqual([ev.dm.unread, ev.dm.last_message_id, ev.mention, ev.preview, ev.sender.display_name], [3, '41', true, undefined, 'Mo']); // a preview is never passed on
  r = await mockHs.s2s(baseB, 'POST', '/dm_pointer', { dm: { id: dm.id, host: 'm.example' }, to: BOB, kind: 'removed' });
  assert.equal(r.status, 200);
  await bobWs.waitFor(f => f.type === 'social_dm_remove' && f.id === dm.id);
  assert.ok(!(await dmList(bob)).some(d => d.id === dm.id));
  await bob.a.patch('/api/v1/settings', { dm_from: 'friends' });
  bobWs.close();
});

test('a group: renamed by its members, people removed by its owner, left by anyone', async () => {
  await friend(alice, 'bea@b.example', bea, ALICE);
  let r = await bob.a.post('/api/v2/social/dms', { members: ['bea', 'alice@a.example'], name: 'Trio' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const g = r.body.dm;
  assert.deepEqual([g.group, g.name, g.owner, g.members.length], [true, 'Trio', BOB, 3]);
  await settle();
  let p = (await dmList(alice)).find(d => d.id === g.id);
  assert.deepEqual([p.name, p.group, p.owner, p.members.length], ['Trio', true, BOB, 3]);
  // a second group with the same people is another group
  r = await bob.a.post('/api/v2/social/dms', { members: ['bea', 'alice@a.example'] });
  const g2 = r.body.dm;
  assert.notEqual(g2.id, g.id);
  // rename: any member, also the one from the other homeserver
  const al = await onB(alice);
  assert.equal((await bea.a.patch(`/api/v2/social/dms/${enc(g.id)}`, { name: 'Three' })).body.dm.name, 'Three');
  assert.equal((await al.a.patch(`/api/v2/social/dms/${enc(g.id)}`, { name: 'The three' })).body.dm.name, 'The three');
  await settle();
  assert.equal((await dmList(alice)).find(d => d.id === g.id).name, 'The three');
  assert.equal((await bob.a.patch(`/api/v2/social/dms/${enc(one.id)}`, { name: 'no' })).body.error, 'not_a_group');
  assert.equal((await alice.a.patch(`/api/v2/social/dms/${enc(g.id)}`, { name: 'x' })).body.error, 'not_hosted_here'); // asked of the wrong homeserver
  // remove: the owner only
  r = await bea.a.del(`/api/v2/social/dms/${enc(g.id)}/members/${enc(ALICE)}`);
  assert.deepEqual([r.status, r.body.error], [403, 'owner_only']);
  assert.equal((await bob.a.del(`/api/v2/social/dms/${enc(g.id)}/members/${enc(BOB)}`)).body.error, 'cannot_remove_yourself');
  r = await bob.a.del(`/api/v2/social/dms/${enc(g.id)}/members/${enc(BEA)}`);
  assert.deepEqual(r.body.dm.members.map(m => m.id), [BOB, ALICE]);
  assert.ok(!(await dmList(bea)).some(d => d.id === g.id));
  assert.equal((await say(bea, g.channel, 'still here?')).status, 403);
  await settle();
  assert.equal((await dmList(alice)).find(d => d.id === g.id).members.length, 2);
  // removed across homeservers: the pointer goes
  r = await bob.a.del(`/api/v2/social/dms/${enc(g2.id)}/members/${enc(ALICE)}`);
  assert.equal(r.status, 200);
  await settle();
  assert.ok(!(await dmList(alice)).some(d => d.id === g2.id));
  assert.equal((await say(al, g2.channel, 'gone')).status, 403);
  // leaving through the host: the pointer goes too; the owner leaving hands the group on; the last one out ends it
  assert.equal((await bob.a.post(`/api/v2/social/dms/${enc(one.id)}/leave`)).body.error, 'not_a_group');
  assert.deepEqual((await bob.a.post(`/api/v2/social/dms/${enc(g.id)}/leave`)).body, { ok: true, hosted_here: true });
  await settle();
  p = (await dmList(alice)).find(d => d.id === g.id);
  assert.deepEqual([p.owner, p.members.map(m => m.id)], [ALICE, [ALICE]]);
  const before = dmCount();
  assert.equal((await al.a.post(`/api/v2/social/dms/${enc(g.id)}/leave`)).status, 200);
  await settle();
  assert.ok(!(await dmList(alice)).some(d => d.id === g.id));
  assert.equal(dmCount(), before - 1);
  // leaving on her own homeserver drops the pointer; the host learns it with the next message (410 pointer_gone)
  await bob.a.post(`/api/v2/social/dms/${enc(g2.id)}/leave`); // (g2: bob and bea are left; bob out, bea owns it)
  r = await bea.a.post('/api/v2/social/dms', { members: ['bob', 'alice@a.example'], name: 'Again' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const g3 = r.body.dm;
  await settle();
  assert.deepEqual((await alice.a.post(`/api/v2/social/dms/${enc(g3.id)}/leave`)).body, { ok: true, hosted_here: false, host_origin: baseB });
  assert.ok(!(await dmList(alice)).some(d => d.id === g3.id));
  await say(bea, g3.channel, 'anyone?');
  await until(async () => { await settle(); return (await dmList(bea)).find(d => d.id === g3.id).members.length === 2; });
});

test('a DM is not a server: nothing that lists, manages or exports servers knows it', async () => {
  const lobby = (await bo.a.post('/api/v1/servers', { name: 'Lobby', join_policy: 'open', listed: true })).body.server;
  await bob.a.post(`/api/v1/servers/${lobby.sid}/join`);
  assert.ok(dmCount() >= 2);
  const sids = db.all("SELECT sid FROM communities WHERE kind = 'dm'").map(r => r.sid);
  const has = v => sids.some(s => JSON.stringify(v).includes(s));
  // lists
  assert.deepEqual((await bob.a.get('/api/v1/servers')).body.servers.map(s => s.sid), [lobby.sid]);
  assert.ok(!has((await bob.a.get('/api/v1/discover')).body));
  const wk = (await api(baseB).get('/.well-known/ember')).body;
  assert.deepEqual([wk.communities_count, wk.communities.length, wk.community.sid], [1, 1, lobby.sid]);
  assert.ok(!has(wk));
  assert.ok(!has((await api(baseB).get('/api/v1/instance/stats')).body));
  const admin = (await bo.a.get('/api/v2/homeserver/servers')).body;
  assert.deepEqual(admin.servers.map(s => s.sid), [lobby.sid]);
  assert.deepEqual(require('../src/export').exportForBackup().map(x => x.sid), [lobby.sid]);
  assert.ok(!has((await bob.a.get('/api/v1/emojis')).body));
  // every route that names a server by its sid: 404, for a member too
  const sid = one.sid;
  for (const [method, path, body] of [
    ['get', `/api/v1/servers/${sid}`], ['patch', `/api/v1/servers/${sid}`, { name: 'Mine now' }], ['del', `/api/v1/servers/${sid}`],
    ['get', `/api/v1/servers/${sid}/members`], ['post', `/api/v1/servers/${sid}/join`], ['post', `/api/v1/servers/${sid}/leave`],
    ['post', `/api/v1/servers/${sid}/invites`, {}], ['get', `/api/v1/servers/${sid}/invites`], ['get', `/api/v1/servers/${sid}/export`],
    ['post', `/api/v1/servers/${sid}/channels`, { name: 'more' }], ['post', `/api/v1/servers/${sid}/roles`, { name: 'boss' }],
    ['get', `/api/v1/servers/${sid}/settings`], ['get', `/api/v1/servers/${sid}/audit`], ['post', `/api/v1/servers/${sid}/reports`, { reason: 'x' }],
    ['get', `/api/v2/servers/${sid}/limits`], ['get', `/api/v1/servers/${sid}/backups`], ['get', `/api/v1/servers/${sid}/bans`],
  ]) {
    for (const who of [bob, bo]) {
      const r = await who.a[method](path, body);
      assert.equal(r.status, 404, `${method} ${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    }
  }
  // the channel cannot be managed, by its members or by a homeserver admin
  for (const who of [bob, bo]) {
    assert.ok([403, 404].includes((await who.a.patch(`/api/v1/channels/${cid}`, { name: 'renamed' })).status));
    assert.ok([403, 404].includes((await who.a.del(`/api/v1/channels/${cid}`)).status));
    assert.ok([403, 404].includes((await who.a.post(`/api/v1/channels/${cid}/webhooks`, { name: 'hook' })).status));
  }
  assert.equal(db.get('SELECT name FROM channels WHERE cid = ?', cid).name, 'dm');
  // the permanent invite code of the row lets nobody in, and a homeserver's owner changing does not take DMs along
  const code = db.get('SELECT invite_code FROM communities WHERE sid = ?', sid).invite_code;
  assert.equal((await bea.a.post(`/api/v1/join/${code}`)).status, 404);
  assert.equal(db.get('SELECT slug FROM communities WHERE sid = ?', sid).slug, null);
  assert.equal(db.get('SELECT listed FROM communities WHERE sid = ?', sid).listed, 0);
});
