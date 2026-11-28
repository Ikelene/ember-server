'use strict';
// Bots move with a server (import-bots.js): an admin's import makes each bot of the export a bot here, owned by the same owner,
// with its roles, its messages and its old token still working; the same bot from several servers is one bot with each token;
// POST /api/v2/homeserver/import/bots carries the bots into a server imported before that, and is safe to repeat.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { tmpDir, api } = require('./helpers');

process.env.EMBER_ACCOUNTS_MODE = 'local';
for (const k of ['EMBER_OWNER', 'EMBER_MANAGED', 'EMBER_PUBLIC_URL']) delete process.env[k];
const { startServer } = require('../src/index');

const dir = tmpDir();
let inst, base, alice, zip, token, oldBot;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };
const botCall = async (tok, method, p, body) => { const r = await fetch(base + '/bot/v1' + p, { method, headers: { Authorization: 'Bot ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const upload = async (p, qs, fields = {}) => {
  const f = new FormData(); f.append('file', new Blob([zip]), 'server.zip');
  for (const [k, v] of Object.entries(fields)) f.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  const r = await fetch(`${base}${p}?${new URLSearchParams(qs)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + alice.session }, body: f });
  return { status: r.status, body: await r.json() };
};
const db = () => require('../src/db');
const sidOf = slug => db().get('SELECT * FROM communities WHERE slug = ?', slug);
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup: a server with a bot (a role, a token, messages), exported, and the bot then gone from here', async () => {
  alice = await reg('alice');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current(), accept_operator_terms: true });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Bot Home', slug: 'bot-home', join_policy: 'open' })).body;
  const r = await alice.a.post('/api/v1/bots', { name: 'Jarvis', description: 'butler' });
  token = r.body.token; oldBot = r.body.bot.id;
  await alice.a.post('/api/v1/bots/by-name/jarvis/add', { sid: d.server.sid });
  const c = sidOf('bot-home');
  const role = (await alice.a.post(`/api/v1/servers/${d.server.sid}/roles`, { name: 'Robots' })).body;
  const rid = role.role?.id || role.id || role.rid;
  const roleRow = db().get('SELECT * FROM roles WHERE community_id = ? AND name = ?', c.id, 'Robots');
  assert.ok(roleRow, 'role made ' + JSON.stringify(role) + rid);
  db().run('INSERT INTO member_roles (community_id, user_id, role_id) VALUES (?, ?, ?)', c.id, Number(oldBot.slice(2)), roleRow.id);
  const guild = (await botCall(token, 'GET', '/users/@me/guilds')).body[0].id;
  const ch = (await botCall(token, 'GET', `/guilds/${guild}/channels`)).body.find(x => x.name === 'general');
  assert.equal((await botCall(token, 'POST', `/channels/${ch.id}/messages`, { content: 'at your service' })).status, 200);
  const general = d.channels.find(x => x.type === 'text').cid;
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: `thanks <@${oldBot}>` });
  const e = await fetch(`${base}/api/v1/servers/${d.server.sid}/export`, { headers: { Authorization: 'Bearer ' + alice.session } });
  zip = Buffer.from(await e.arrayBuffer());
  const { unzipSync, strFromU8 } = require('fflate');
  const bots = strFromU8(unzipSync(new Uint8Array(zip))['bots.jsonl']).trim().split('\n').map(JSON.parse);
  assert.deepEqual([bots.length, bots[0].id, bots[0].username, bots[0].owner, bots[0].token_hashes], [1, oldBot, 'Jarvis', alice.user.id, [sha(token)]]);
  assert.ok(!zip.includes(Buffer.from(token)), 'never the token itself');
  // the bot is gone here (as on a homeserver it never was on), so the import has to make it
  assert.equal((await alice.a.del(`/api/v1/bots/${oldBot}`)).status < 300, true);
  assert.equal((await botCall(token, 'GET', '/users/@me')).status, 401);
});

let moved;
test('an admin import brings the bot: same owner, its role, its messages, its old token works', async () => {
  const r = await upload('/api/v2/homeserver/import', { owner: alice.user.id, slug: 'moved' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bots.length, 1);
  const b = r.body.bots[0];
  assert.deepEqual([b.from, b.username, b.owner, b.created, b.tokens], [oldBot, 'Jarvis', alice.user.id, true, 1]);
  moved = b.id;
  assert.notEqual(moved, oldBot);
  const c = sidOf('moved'), uid = Number(moved.slice(2));
  assert.ok(db().get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', c.id, uid));
  assert.ok(db().get("SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.community_id = ? AND mr.user_id = ? AND r.name = 'Robots'", c.id, uid));
  const msgs = db().all('SELECT m.* FROM messages m JOIN channels ch ON ch.id = m.channel_id WHERE ch.community_id = ? ORDER BY m.id', c.id);
  const own = msgs.find(m => m.body === 'at your service');
  assert.deepEqual([own.user_id, own.author_name], [uid, null]);
  assert.ok(msgs.some(m => m.body === `thanks <@${moved}>`), 'a mention of it points at it here');
  const me = await botCall(token, 'GET', '/users/@me');
  assert.deepEqual([me.status, me.body.username, me.body.bot], [200, 'Jarvis', true]);
  assert.equal(db().get('SELECT owner_id FROM bots WHERE user_id = ?', uid).owner_id, db().get('SELECT id FROM users WHERE principal = ?', alice.user.id).id);
});

test('the same bot from another server is the same bot here, with that server\'s token valid too', async () => {
  const other = 'X'.repeat(10) + '.another-servers-token';
  const { unzipSync, strFromU8 } = require('fflate');
  const rec = JSON.parse(strFromU8(unzipSync(new Uint8Array(zip))['bots.jsonl']).trim());
  const r = await upload('/api/v2/homeserver/import', { owner: alice.user.id, slug: 'second-home' }, { bots: [{ ...rec, token_hashes: [sha(other)] }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.bots[0].id, r.body.bots[0].reused, r.body.bots[0].tokens], [moved, true, 1]);
  assert.equal((await botCall(other, 'GET', '/users/@me')).body.username, 'Jarvis');
  assert.equal((await botCall(token, 'GET', '/users/@me')).status, 200);
  assert.equal((await botCall(token, 'GET', '/users/@me/guilds')).body.length, 2); // both servers on one connection
  assert.equal(db().get("SELECT COUNT(*) AS n FROM users WHERE kind = 'bot'").n, 1);
});

test('bots into a server imported before they moved: membership, roles, messages back to the bot; repeat is a no-op', async () => {
  // as the first hosted moves were: an import that left the bots out (their messages kept under the name only)
  let r = await upload('/api/v2/homeserver/import', { owner: alice.user.id, slug: 'early-move' }, { bots: [] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = sidOf('early-move');
  const nameOnly = db().get("SELECT m.* FROM messages m JOIN channels ch ON ch.id = m.channel_id WHERE ch.community_id = ? AND m.body = 'at your service'", c.id);
  assert.deepEqual([nameOnly.user_id, nameOnly.author_name], [null, 'Jarvis']);
  assert.equal((await upload('/api/v2/homeserver/import/bots', { sid: 'nope' })).status, 404);
  assert.equal((await upload('/api/v2/homeserver/import/bots', { sid: c.sid }, { bots: 'nope' })).body.error, 'invalid_bots');
  r = await upload('/api/v2/homeserver/import/bots', { sid: c.sid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.bots[0].id, r.body.bots[0].reused, r.body.members.added, r.body.messages, r.body.mentions], [moved, true, 1, 1, 1]);
  const uid = Number(moved.slice(2));
  assert.equal(db().get('SELECT user_id FROM messages WHERE id = ?', nameOnly.id).user_id, uid);
  assert.ok(db().get("SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.community_id = ? AND mr.user_id = ? AND r.name = 'Robots'", c.id, uid));
  assert.ok(db().get("SELECT 1 FROM messages m JOIN channels ch ON ch.id = m.channel_id WHERE ch.community_id = ? AND m.body = ?", c.id, `thanks <@${moved}>`));
  r = await upload('/api/v2/homeserver/import/bots', { sid: c.sid });
  assert.deepEqual([r.body.members.added, r.body.members.already, r.body.messages, r.body.mentions], [0, 1, 0, 0]);
  assert.equal(db().get("SELECT COUNT(*) AS n FROM users WHERE kind = 'bot'").n, 1);
});

test('a token reset ends every token the bot came with', async () => {
  const r = await alice.a.post(`/api/v1/bots/${moved}/token`, {});
  assert.equal(r.status, 200);
  assert.equal((await botCall(token, 'GET', '/users/@me')).status, 401);
  assert.equal((await botCall(r.body.token, 'GET', '/users/@me')).status, 200);
});

test('a bot name someone here already has: the bot comes as name_2; a non-admin import never makes bots', async () => {
  await reg('Noki');
  const { unzipSync, strFromU8 } = require('fflate');
  const rec = JSON.parse(strFromU8(unzipSync(new Uint8Array(zip))['bots.jsonl']).trim());
  const r = await upload('/api/v2/homeserver/import', { owner: alice.user.id, slug: 'clash' }, { bots: [{ ...rec, id: 'b:77', username: 'Noki', token_hashes: [sha('noki-token')] }] });
  assert.deepEqual([r.body.bots[0].username, r.body.bots[0].renamed, r.body.bots[0].created], ['Noki_2', true, true]);
  // an owner's own import (not trusted) leaves bots out
  const f = new FormData(); f.append('file', new Blob([zip]), 'server.zip');
  const n = db().get("SELECT COUNT(*) AS n FROM users WHERE kind = 'bot'").n;
  const own = await fetch(`${base}/api/v1/servers/import`, { method: 'POST', headers: { Authorization: 'Bearer ' + alice.session }, body: f });
  assert.ok(own.status < 500);
  assert.equal(db().get("SELECT COUNT(*) AS n FROM users WHERE kind = 'bot'").n, n);
});
