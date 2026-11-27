'use strict';
// A homeserver admin imports a server for its owner (admin-import.js): the owner it names, the address it had, the old origin
// kept with previous_urls. What Nookara's migration of its hosted servers uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const { startServer } = require('../src/index');

const dir = tmpDir();
let inst, base, alice, bob, zip, src;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
const upload = async (session, qs, buf = zip, bridges) => {
  const f = new FormData(); f.append('file', new Blob([buf]), 'server.zip');
  if (bridges !== undefined) f.append('bridges', typeof bridges === 'string' ? bridges : JSON.stringify(bridges));
  const r = await fetch(`${base}/api/v2/homeserver/import?${new URLSearchParams(qs)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + session }, body: f });
  return { status: r.status, body: await r.json() };
};
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup: a server to move, exported', async () => {
  alice = await reg('alice'); bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Moving Co', slug: 'moving-co', join_policy: 'open' })).body;
  const general = d.channels.find(c => c.type === 'text').cid;
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'hello from before' });
  // an invite, the main code, and a Discord guild linked to #general (as a hosted server's would be)
  const inv = (await alice.a.post(`/api/v1/servers/${d.server.sid}/invites`, { max_uses: 5 })).body.code;
  const db = require('../src/db'); require('../src/bridge/store').ensure();
  const cid = db.get('SELECT id FROM communities WHERE sid = ?', d.server.sid).id;
  const bid = db.run("INSERT INTO bridge_guilds (community_id, platform, guild_id, guild_name, created_at, verified) VALUES (?, 'discord', '111222333', 'Movers HQ', 1, 1)", cid).lastInsertRowid;
  db.run("INSERT INTO bridge_channels (channel_id, bridge_id, ext_channel_id, ext_name, hook_id, hook_token) VALUES ((SELECT id FROM channels WHERE cid = ?), ?, '444555', 'general', 'h1', 'secret-hook')", general, bid);
  src = { sid: d.server.sid, inv, main: db.get('SELECT invite_code FROM communities WHERE id = ?', cid).invite_code, general };
  const r = await fetch(`${base}/api/v1/servers/${d.server.sid}/export`, { headers: { Authorization: 'Bearer ' + alice.session } });
  assert.equal(r.status, 200);
  zip = Buffer.from(await r.arrayBuffer());
  assert.ok(!zip.includes(Buffer.from('secret-hook')), 'webhook secrets stay behind');
});

test('an admin imports it for its owner, at the address asked for, and the old origin joins previous_urls', async () => {
  assert.equal((await upload(bob.session, { owner: bob.user.id, slug: 'bobs-place' })).status, 403); // admins only
  let r = await upload(alice.session, { owner: 'l:999', slug: 'x-place' });
  assert.deepEqual([r.status, r.body.error], [404, 'owner_not_found']);
  r = await upload(alice.session, { owner: 'v:42', slug: 'x-place' });
  assert.deepEqual([r.status, r.body.error], [400, 'nookara_accounts_off']); // (Nookara accounts are not this homeserver's)
  assert.equal((await upload(alice.session, { owner: bob.user.id, slug: 'moving-co' })).body.error, 'slug_taken');
  assert.equal((await upload(alice.session, { owner: bob.user.id, slug: 'x-place' }, zip, 'not json')).body.error, 'invalid_bridges');
  assert.equal((await upload(alice.session, { owner: bob.user.id, slug: 'Bad Slug' })).body.error, 'invalid_slug');
  r = await upload(alice.session, { owner: bob.user.id, slug: 'bobs-place', previous_url: 'https://e-bobs-place.nookara.cc/' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.slug, r.body.owner], ['bobs-place', bob.user.id]);
  const s = (await bob.a.get(`/api/v1/servers/${r.body.sid}`)).body;
  assert.deepEqual([s.server.name, s.server.slug, s.server.role], ['Moving Co', 'bobs-place', 'owner']);
  const d = (await api(base).get('/.well-known/ember')).body;
  assert.ok(d.previous_urls.includes('https://e-bobs-place.nookara.cc'));
  assert.equal((await upload(alice.session, { owner: bob.user.id, slug: 'other', previous_url: 'not a url' })).body.error, 'invalid_previous_url');
});

test('old links keep working: invite codes and the main code come along; bridge links too, with what the owner must do', async () => {
  const db = require('../src/db');
  // (the server it came from is gone: on its own homeserver, as a hosted container is)
  assert.equal((await alice.a.del(`/api/v1/servers/${src.sid}`)).status, 200);
  let r = await upload(alice.session, { owner: bob.user.id, slug: 'movers' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.invite_code, r.body.invites], [{ from: src.main, to: src.main }, []]);
  const c = db.get('SELECT * FROM communities WHERE sid = ?', r.body.sid);
  assert.equal(c.invite_code, src.main);
  assert.ok(db.get('SELECT 1 FROM invites WHERE code = ? AND community_id = ?', src.inv, c.id));
  // the guild is linked again on the same channel; no webhook (the bot makes one); this homeserver has no Discord bot yet
  const b = db.get("SELECT * FROM bridge_guilds WHERE community_id = ? AND platform = 'discord'", c.id);
  assert.deepEqual([b.guild_id, b.guild_name, b.verified], ['111222333', 'Movers HQ', 1]);
  const link = db.get('SELECT bc.*, ch.name FROM bridge_channels bc JOIN channels ch ON ch.id = bc.channel_id WHERE bc.bridge_id = ?', b.id);
  assert.deepEqual([link.ext_channel_id, link.name, link.hook_id], ['444555', 'general', null]);
  assert.deepEqual(r.body.bridges, [{ platform: 'discord', guild_id: '111222333', linked: true, channels: 1, problem: 'bridge_not_set_up', action: 'homeserver_bot_needed' }]);
  // the same export again: its codes are taken now (fresh ones, said), and the guild belongs to the first copy
  r = await upload(alice.session, { owner: bob.user.id, slug: 'movers-two' });
  assert.equal(r.body.invite_code.from, src.main); assert.notEqual(r.body.invite_code.to, src.main);
  assert.deepEqual(r.body.invites.map(x => x.from), [src.inv]);
  assert.deepEqual([r.body.bridges[0].linked, r.body.bridges[0].action], [false, 'resolve_conflict']);
  // the main code can be given (an older export without it); a bridges list replaces the export's
  r = await upload(alice.session, { owner: bob.user.id, slug: 'movers-three', invite_code: 'OldMain99' }, zip, [{ platform: 'fluxer', guild_id: '999', guild_name: 'F', links: [{ cid: src.general, ext_channel_id: '1000', ext_name: 'g' }] }]);
  assert.deepEqual(r.body.invite_code, { from: 'OldMain99', to: 'OldMain99' });
  assert.deepEqual([r.body.bridges.length, r.body.bridges[0].platform, r.body.bridges[0].channels], [1, 'fluxer', 1]);
});
