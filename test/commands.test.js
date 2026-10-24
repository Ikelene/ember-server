'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const WebSocket = require('ws');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base, alice, bob, sid, general, bot, token, guild, gw;
const clients = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reg = async n => {
  const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' });
  const a = api(base, r.body.session), post = a.post;
  a.post = (p, b) => { if (/\/messages$/.test(p)) require('../src/messages')._sendLimit.reset(); return post(p, b); };
  return { ...r.body, a };
};
const botCall = async (method, p, body, auth = true) => {
  require('../src/messages')._sendLimit.reset();
  require('../src/routes/botapi')._hits.reset();
  const r = await fetch(base + '/bot/v1' + p, { method, headers: { ...(auth ? { Authorization: 'Bot ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const until = async (frames, pred, ms = 3000) => { for (let i = 0; i < ms / 40; i++) { const f = frames.find(pred); if (f) return f; await sleep(40); } throw new Error('no frame: ' + frames.map(f => f.t || f.type || 'op' + f.op).join(',')); };
const S = p => `/api/v1/servers/${sid}${p}`;

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup: server, members, a bot with a live gateway', async () => {
  alice = await reg('alice'); bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid;
  await bob.a.post(S('/join'));
  const r = await alice.a.post('/api/v1/bots', { name: 'Mahi', description: 'quotes' });
  bot = r.body.bot; token = r.body.token;
  await alice.a.post('/api/v1/bots/by-name/mahi/add', { sid });
  guild = (await botCall('GET', '/users/@me/guilds')).body[0].id;
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/bot/gateway');
  const frames = [];
  ws.on('message', d => frames.push(JSON.parse(d)));
  await new Promise(res => ws.on('open', res));
  ws.send(JSON.stringify({ op: 2, d: { token } }));
  await until(frames, f => f.t === 'READY');
  gw = { ws, frames };
  clients.push({ close: () => ws.close() });
  assert.equal(frames.find(f => f.t === 'READY').d.application.id, bot.id.slice(2));
});

let quoteId, adminId, ctxId;
test('register commands: validation, create vs update, bulk, scopes', async () => {
  assert.equal((await botCall('GET', '/applications/@me/commands', null, false)).status, 401);
  const badName = await botCall('POST', '/applications/@me/commands', { name: 'Bad Name', description: 'x' });
  assert.deepEqual([badName.status, badName.body.code], [400, 50035]);
  assert.equal((await botCall('POST', '/applications/@me/commands', { name: 'x', description: '' })).status, 400);
  assert.equal((await botCall('POST', '/applications/@me/commands', { name: 'x', description: 'd', options: [{ type: 3, name: 'a', description: 'd' }, { type: 3, name: 'b', description: 'd', required: true }] })).status, 400);
  assert.equal((await botCall('POST', '/applications/999/commands', { name: 'x', description: 'd' })).status, 404);
  const q = await botCall('POST', '/applications/@me/commands', {
    name: 'quote', description: 'Make a quote', options: [
      { type: 6, name: 'user', description: 'Who said it', required: true },
      { type: 3, name: 'text', description: 'What they said', required: true, max_length: 20 },
      { type: 4, name: 'size', description: 'Size', min_value: 1, max_value: 5 },
      { type: 3, name: 'style', description: 'Style', choices: [{ name: 'Dark', value: 'dark' }, { name: 'Light', value: 'light' }] },
      { type: 3, name: 'tag', description: 'Tag', autocomplete: true },
    ],
  });
  assert.equal(q.status, 201);
  quoteId = q.body.id;
  assert.equal(q.body.application_id, String(bot.id.slice(2)));
  const again = await botCall('POST', '/applications/@me/commands', { name: 'quote', description: 'Make a quote 2', options: q.body.options });
  assert.deepEqual([again.status, again.body.id, again.body.description], [200, quoteId, 'Make a quote 2']);
  const a = await botCall('POST', `/applications/@me/guilds/${guild}/commands`, { name: 'admin', description: 'Admins only', default_member_permissions: '8', options: [{ type: 1, name: 'ban', description: 'Ban', options: [{ type: 3, name: 'who', description: 'who' }] }, { type: 1, name: 'info', description: 'Info' }] });
  adminId = a.body.id;
  const m = await botCall('POST', '/applications/@me/commands', { name: 'Save quote', type: 3 });
  ctxId = m.body.id;
  assert.equal(m.body.description, '');
  assert.equal((await botCall('GET', '/applications/@me/commands')).body.length, 2);
  assert.equal((await botCall('GET', `/applications/@me/guilds/${guild}/commands`)).body.length, 1);
  assert.equal((await botCall('PATCH', `/applications/@me/commands/${quoteId}`, { description: 'Quotes!' })).body.description, 'Quotes!');
  const bulk = await botCall('PUT', '/applications/@me/commands', [{ name: 'quote', description: 'Quotes!!', options: q.body.options }, { name: 'ping', description: 'Ping' }, { name: 'Save quote', type: 3 }]);
  assert.equal(bulk.body.length, 3);
  assert.equal(bulk.body.find(c => c.name === 'quote').id, quoteId);
  assert.equal((await botCall('DELETE', `/applications/@me/commands/${bulk.body.find(c => c.name === 'ping').id}`)).status, 204);
});

test('members see the commands they may run, with the bot they come from', async () => {
  const mine = (await alice.a.get(S('/commands'))).body;
  assert.deepEqual(mine.bots.map(b => b.username), ['Mahi']);
  assert.equal(mine.bots[0].online, true);
  assert.deepEqual(mine.commands.map(c => c.name).sort(), ['Save quote', 'admin', 'quote']);
  const theirs = (await bob.a.get(S('/commands'))).body;
  assert.deepEqual(theirs.commands.map(c => c.name).sort(), ['Save quote', 'quote']);
  assert.equal(theirs.commands.find(c => c.name === 'quote').bot, bot.id);
  assert.equal((await bob.a.post(S('/interactions'), { type: 2, channel: general, command: adminId, path: ['info'] })).body.error, 'unknown_command');
});

test('running a command: the bot gets INTERACTION_CREATE, answers, followups', async () => {
  const bad = await bob.a.post(S('/interactions'), { type: 2, channel: general, command: quoteId, values: { user: alice.user.id, text: 'x'.repeat(30) } });
  assert.deepEqual([bad.status, bad.body.error, bad.body.option], [400, 'bad_option', 'text']);
  assert.equal((await bob.a.post(S('/interactions'), { type: 2, channel: general, command: quoteId, values: { text: 'hi' } })).body.option, 'user');
  assert.equal((await bob.a.post(S('/interactions'), { type: 2, channel: general, command: quoteId, values: { user: alice.user.id, text: 'hi', style: 'neon' } })).body.option, 'style');
  const wb = await wsClient(base).login(bob.session); clients.push(wb);
  const wa = await wsClient(base).login(alice.session); clients.push(wa);
  const run = await bob.a.post(S('/interactions'), { type: 2, channel: general, command: quoteId, values: { user: alice.user.id, text: 'hello there', size: 3, style: 'dark' } });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const ev = (await until(gw.frames, f => f.t === 'INTERACTION_CREATE' && f.d.id === run.body.id)).d;
  assert.equal(ev.type, 2);
  assert.equal(ev.data.name, 'quote');
  assert.equal(ev.data.id, quoteId);
  const opts = Object.fromEntries(ev.data.options.map(o => [o.name, o.value]));
  assert.deepEqual(opts, { user: alice.user.id.slice(2), text: 'hello there', size: 3, style: 'dark' });
  assert.equal(ev.data.resolved.users[opts.user].username, 'alice');
  assert.equal(ev.member.user.username, 'bob');
  assert.equal(ev.application_id, bot.id.slice(2));
  assert.ok(ev.token.length > 30);

  const cb = (id, tok, body) => botCall('POST', `/interactions/${id}/${tok}/callback`, body, false);
  const ok = await cb(ev.id, ev.token, { type: 4, data: { content: 'Quote made', embeds: [{ title: 'Hi' }], components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Again', custom_id: 'again' }, { type: 2, style: 5, label: 'Site', url: 'https://ember.example' }] }] } });
  assert.equal(ok.status, 204);
  const posted = (await until(wa.frames, f => f.type === 'chat_message' && f.message.body === 'Quote made')).message;
  assert.equal(posted.author.username, 'Mahi');
  assert.deepEqual([posted.interaction.name, posted.interaction.user.username], ['quote', 'bob']);
  assert.equal(posted.components[0].components[0].custom_id, 'again');
  assert.equal((await cb(ev.id, ev.token, { type: 4, data: { content: 'again' } })).body.code, 40060);
  assert.equal((await cb('1', 'nope', { type: 4, data: { content: 'x' } })).body.code, 10062);

  const hook = (m, p, body) => botCall(m, `/webhooks/${ev.application_id}/${ev.token}${p}`, body, false);
  const f = await hook('POST', '', { content: 'followup' });
  assert.equal(f.body.content, 'followup');
  assert.equal((await hook('PATCH', `/messages/${f.body.id}`, { content: 'edited followup' })).body.content, 'edited followup');
  assert.equal((await hook('PATCH', '/messages/@original', { content: 'Quote updated' })).body.content, 'Quote updated');
  assert.equal((await hook('GET', '/messages/@original')).body.content, 'Quote updated');
  const eph = await hook('POST', '', { content: 'psst', flags: 64 });
  assert.equal(eph.body.flags, 64);
  const seen = await until(wb.frames, f => f.type === 'chat_interaction_message' && f.message.body === 'psst');
  assert.deepEqual([seen.op, seen.message.ephemeral, seen.message.author.username], ['create', true, 'Mahi']);
  await sleep(150);
  assert.equal(wa.frames.some(f => f.type === 'chat_interaction_message'), false);
  assert.equal(wa.frames.some(f => f.type === 'chat_message' && f.message.body === 'psst'), false);
  assert.equal((await hook('DELETE', `/messages/${eph.body.id}`)).status, 204);
  await until(wb.frames, f => f.type === 'chat_interaction_message' && f.op === 'delete' && f.message.id === eph.body.id);
  assert.equal((await hook('DELETE', '/messages/@original')).status, 204);
  await until(wa.frames, f => f.type === 'chat_message_delete');
  wa.close(); wb.close();
});

test('deferred replies and ephemeral defer', async () => {
  const wa = await wsClient(base).login(alice.session); clients.push(wa);
  const run = await alice.a.post(S('/interactions'), { type: 2, channel: general, command: quoteId, values: { user: bob.user.id, text: 'slow' } });
  const ev = (await until(gw.frames, f => f.t === 'INTERACTION_CREATE' && f.d.id === run.body.id)).d;
  await botCall('POST', `/interactions/${ev.id}/${ev.token}/callback`, { type: 5 }, false);
  const thinking = (await until(wa.frames, f => f.type === 'chat_message' && f.message.interaction?.thinking)).message;
  assert.equal(thinking.body, '');
  const done = await botCall('POST', `/webhooks/${ev.application_id}/${ev.token}`, { content: 'done thinking' }, false);
  assert.equal(done.body.id, thinking.id);
  const upd = (await until(wa.frames, f => f.type === 'chat_message_update' && f.message.id === thinking.id)).message;
  assert.deepEqual([upd.body, upd.interaction.thinking, upd.edited_at], ['done thinking', undefined, null]);

  const run2 = await alice.a.post(S('/interactions'), { type: 2, channel: general, command: quoteId, values: { user: bob.user.id, text: 'quiet' } });
  const ev2 = (await until(gw.frames, f => f.t === 'INTERACTION_CREATE' && f.d.id === run2.body.id)).d;
  await botCall('POST', `/interactions/${ev2.id}/${ev2.token}/callback`, { type: 5, data: { flags: 64 } }, false);
  const wait = await until(wa.frames, f => f.type === 'chat_interaction_message' && f.message.thinking);
  await botCall('PATCH', `/webhooks/${ev2.application_id}/${ev2.token}/messages/@original`, { content: 'only you' }, false);
  const got = await until(wa.frames, f => f.type === 'chat_interaction_message' && f.op === 'update' && f.message.id === wait.message.id);
  assert.equal(got.message.body, 'only you');
  wa.close();
});

test('autocomplete, context menu commands, buttons, modals', async () => {
  const ac = alice.a.post(S('/interactions'), { type: 4, channel: general, command: quoteId, values: { text: 'x' }, focused: 'tag' });
  const ev = (await until(gw.frames, f => f.t === 'INTERACTION_CREATE' && f.d.type === 4)).d;
  assert.deepEqual(ev.data.options.find(o => o.focused), { name: 'tag', type: 3, value: '', focused: true });
  await botCall('POST', `/interactions/${ev.id}/${ev.token}/callback`, { type: 8, data: { choices: [{ name: 'Funny', value: 'funny' }, { name: 'Sad', value: 'sad' }] } }, false);
  assert.deepEqual((await ac).body.choices, [{ name: 'Funny', value: 'funny' }, { name: 'Sad', value: 'sad' }]);

  const msg = (await bob.a.post(`/api/v1/channels/${general}/messages`, { message: 'quote me' })).body.message;
  const run = await alice.a.post(S('/interactions'), { type: 2, channel: general, command: ctxId, target: msg.id });
  const cev = (await until(gw.frames, f => f.t === 'INTERACTION_CREATE' && f.d.id === run.body.id)).d;
  assert.deepEqual([cev.data.type, cev.data.target_id, cev.data.resolved.messages[msg.id].content], [3, msg.id, 'quote me']);
  assert.equal((await alice.a.post(S('/interactions'), { type: 2, channel: general, command: ctxId, target: '99999' })).body.error, 'message_not_found');

  const wa = await wsClient(base).login(alice.session); clients.push(wa);
  await botCall('POST', `/interactions/${cev.id}/${cev.token}/callback`, { type: 4, data: { content: 'pick', components: [{ type: 1, components: [{ type: 3, custom_id: 'menu', options: [{ label: 'One', value: '1' }, { label: 'Two', value: '2' }] }] }, { type: 1, components: [{ type: 2, style: 3, label: 'Go', custom_id: 'go' }] }] } }, false);
  const withBtn = (await until(wa.frames, f => f.type === 'chat_message' && f.message.body === 'pick')).message;
  assert.equal((await bob.a.post(S('/interactions'), { type: 3, channel: general, message: withBtn.id, custom_id: 'nope' })).status, 404);
  assert.equal((await bob.a.post(S('/interactions'), { type: 3, channel: general, message: withBtn.id, custom_id: 'menu', selected: ['9'] })).body.option, 'menu');
  const click = await bob.a.post(S('/interactions'), { type: 3, channel: general, message: withBtn.id, custom_id: 'go' });
  const bev = (await until(gw.frames, f => f.t === 'INTERACTION_CREATE' && f.d.id === click.body.id)).d;
  assert.deepEqual([bev.type, bev.data.custom_id, bev.data.component_type, bev.message.id], [3, 'go', 2, withBtn.id]);
  const sel = await bob.a.post(S('/interactions'), { type: 3, channel: general, message: withBtn.id, custom_id: 'menu', selected: ['2'] });
  assert.deepEqual((await until(gw.frames, f => f.t === 'INTERACTION_CREATE' && f.d.id === sel.body.id)).d.data.values, ['2']);

  await botCall('POST', `/interactions/${bev.id}/${bev.token}/callback`, { type: 7, data: { content: 'clicked', components: [] } }, false);
  const upd = (await until(wa.frames, f => f.type === 'chat_message_update' && f.message.id === withBtn.id)).message;
  assert.deepEqual([upd.body, upd.components], ['clicked', undefined]);

  const modalRun = await bob.a.post(S('/interactions'), { type: 2, channel: general, command: quoteId, values: { user: alice.user.id, text: 'm' } });
  const mev = (await until(gw.frames, f => f.t === 'INTERACTION_CREATE' && f.d.id === modalRun.body.id)).d;
  const wb = await wsClient(base).login(bob.session); clients.push(wb);
  await botCall('POST', `/interactions/${mev.id}/${mev.token}/callback`, { type: 9, data: { custom_id: 'form', title: 'Fill me', components: [{ type: 1, components: [{ type: 4, custom_id: 'who', label: 'Who', style: 1, required: true, max_length: 5 }] }] } }, false);
  const modal = await until(wb.frames, f => f.type === 'chat_interaction_modal');
  assert.equal(modal.modal.title, 'Fill me');
  assert.equal((await bob.a.post(S('/interactions'), { type: 5, channel: general, source: modal.interaction, fields: { who: '' } })).body.option, 'who');
  assert.equal((await alice.a.post(S('/interactions'), { type: 5, channel: general, source: modal.interaction, fields: { who: 'Al' } })).status, 404);
  const sub = await bob.a.post(S('/interactions'), { type: 5, channel: general, source: modal.interaction, fields: { who: 'Al' } });
  const sev = (await until(gw.frames, f => f.t === 'INTERACTION_CREATE' && f.d.id === sub.body.id)).d;
  assert.deepEqual([sev.type, sev.data.custom_id, sev.data.components[0].components[0]], [5, 'form', { type: 4, custom_id: 'who', value: 'Al' }]);
  wa.close(); wb.close();
});

test('permissions: managers can switch a command off for a role, and channels', async () => {
  const everyone = (await alice.a.get(S(''))).body.roles.find(r => r.is_default).rid;
  assert.equal((await bob.a.put(S('/commands/permissions'), { bot: bot.id, command: quoteId, permissions: [] })).status, 403);
  assert.equal((await alice.a.put(S('/commands/permissions'), { bot: bot.id, command: quoteId, permissions: [{ type: 'role', id: everyone, allow: false }] })).status, 200);
  assert.deepEqual((await bob.a.get(S('/commands'))).body.commands.map(c => c.name), ['Save quote']);
  assert.equal((await alice.a.get(S('/commands'))).body.commands.some(c => c.name === 'quote'), true);
  const manage = (await alice.a.get(S('/commands/manage'))).body;
  assert.equal(manage.bots[0].commands.find(c => c.name === 'quote').perms[0].allow, false);
  assert.equal((await alice.a.put(S('/commands/permissions'), { bot: bot.id, command: quoteId, permissions: [{ type: 'user', id: bob.user.id, allow: true }, { type: 'role', id: everyone, allow: false }] })).status, 200);
  assert.equal((await bob.a.get(S('/commands'))).body.commands.some(c => c.name === 'quote'), true);
  await alice.a.put(S('/commands/permissions'), { bot: bot.id, command: quoteId, permissions: [{ type: 'channel', id: 'all', allow: false }, { type: 'channel', id: general, allow: true }] });
  assert.equal((await bob.a.get(S(`/commands?channel=${general}`))).body.commands.some(c => c.name === 'quote'), true);
  await alice.a.put(S('/commands/permissions'), { bot: bot.id, command: quoteId, permissions: [] });
});

test('offline bots, late answers and bot removal', async () => {
  const slow = await alice.a.post(S('/interactions'), { type: 2, channel: general, command: quoteId, values: { user: bob.user.id, text: 'late' } });
  await until(gw.frames, f => f.t === 'INTERACTION_CREATE' && f.d.id === slow.body.id);
  const wa = await wsClient(base).login(alice.session); clients.push(wa);
  await sleep(3200);
  assert.equal((await botCall('POST', `/interactions/${slow.body.id}/x/callback`, { type: 4, data: { content: 'late' } }, false)).body.code, 10062);
  gw.ws.close();
  await sleep(200);
  assert.deepEqual([(await alice.a.get(S('/commands'))).body.bots[0].online], [false]);
  const off = await alice.a.post(S('/interactions'), { type: 2, channel: general, command: quoteId, values: { user: bob.user.id, text: 'hi' } });
  assert.deepEqual([off.status, off.body.error], [409, 'bot_offline']);
  await alice.a.post(S('/members/' + encodeURIComponent(bot.id) + '/kick'), {});
  wa.close();
});
