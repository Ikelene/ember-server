// Builds an old (pre-homeservers, main 837dd2d) bonfire-server data dir with local accounts, for ember-server's in-place upgrade
// test. To make it again: git worktree add <dir> 837dd2d, link or install node_modules there, copy this file into it and run
// node build-fixture.js <ember-server>/test/fixtures/old-local-instance. Writes data/ (the data dir) and fixture.json.
const fs = require('fs'), path = require('path');
const out = path.resolve(process.argv[2]);
fs.rmSync(out, { recursive: true, force: true });
const data = path.join(out, 'data');
fs.mkdirSync(data, { recursive: true });
// what a self-hoster's config.json said: local accounts, its public address, no Nookara relay
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ name: 'Old Camp', accounts_mode: 'local', registration: 'open', public_url: 'https://chat.oldcamp.example', velora_registration: 'off' }, null, 2));
for (const k of Object.keys(process.env)) if (/^(BONFIRE|EMBER)_/.test(k)) delete process.env[k];
const { startServer } = require('./src/index');

(async () => {
  const inst = await startServer({ dataDir: data, port: 0, host: '127.0.0.1', restart: () => {} });
  const base = inst.url;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const reg = async (username, password) => ({ password, ...(await call('POST', '/api/v1/auth/register', { username, password })) });
  const alice = await reg('alice', 'alice old password'), bob = await reg('bob', 'bob old password'), carl = await reg('carl', 'carl old password');
  await call('POST', '/api/v1/instance/claim', { code: inst.setup.current(), accept_operator_terms: true }, alice.session);
  const made = await call('POST', '/api/v1/servers', { name: 'Old Camp', description: 'from before homeservers', join_policy: 'open' }, alice.session);
  const sid = made.server.sid, general = made.channels.find(c => c.type === 'text').cid;
  await call('POST', `/api/v1/servers/${sid}/join`, {}, bob.session);
  await call('POST', `/api/v1/servers/${sid}/join`, {}, carl.session);
  const role = (await call('POST', `/api/v1/servers/${sid}/roles`, { name: 'Rangers', color: '#22aa66' }, alice.session)).role;
  await call('PUT', `/api/v1/servers/${sid}/members/${bob.user.id}/roles/${role.rid}`, {}, alice.session);
  const m1 = (await call('POST', `/api/v1/channels/${general}/messages`, { message: 'alice: welcome to the old camp' }, alice.session)).message;
  const m2 = (await call('POST', `/api/v1/channels/${general}/messages`, { message: 'bob: glad to be here' }, bob.session)).message;
  const inv = await call('POST', `/api/v1/servers/${sid}/invites`, {}, alice.session), invite = { code: inv.invite?.code || inv.code };
  const detail = await call('GET', `/api/v1/servers/${sid}`, null, alice.session);
  // bob signs in once more (a second session, e.g. a phone) and carl leaves his session behind
  const bob2 = await call('POST', '/api/v1/auth/login', { username: 'bob', password: bob.password });
  await inst.close();
  fs.rmSync(path.join(data, 'keys'), { recursive: true, force: true }); // (the instance's own keys: made again on start, not kept in a fixture)
  for (const f of ['setup-code.txt']) fs.rmSync(path.join(data, f), { force: true });
  const fixture = {
    made_with: 'bonfire-server main 837dd2d (before homeservers)', public_url: 'https://chat.oldcamp.example',
    users: { alice: { id: alice.user.id, password: alice.password, session: alice.session }, bob: { id: bob.user.id, password: bob.password, session: bob.session, session2: bob2.session }, carl: { id: carl.user.id, password: carl.password, session: carl.session } },
    server: { sid, name: 'Old Camp', general, role: { rid: role.rid, name: role.name }, main_invite: detail.server.invite || null, invite: invite?.code || null, messages: [m1.id, m2.id] },
  };
  fs.writeFileSync(path.join(out, 'fixture.json'), JSON.stringify(fixture, null, 2) + '\n');
  console.log(JSON.stringify(fixture, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
