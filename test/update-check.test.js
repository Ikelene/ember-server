'use strict';
// "Am I outdated?" against Nookara's server-latest.json: cached 10 minutes, but Server info > Refresh (?refresh=1) really asks again
// (at most every 15 s), and an admin is told whether Ember can update it in one click (update.one_click).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_PUBLIC_URL = 'http://chat.test';
process.env.BONFIRE_VELORA_URL = 'http://velora.test';
process.env.BONFIRE_OWNER = 'v:100';
process.env.BONFIRE_BUILD_COMMIT = 'a'.repeat(40);
process.env.BONFIRE_BUILD_AT = '2026-11-13T02:11:43.000Z';
delete process.env.BONFIRE_MANAGED;
delete process.env.BONFIRE_UPDATE_CHECK;
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const V = require('../src/version');
const { tmpDir, api, fakeIdp } = require('./helpers');

const dir = tmpDir(), idp = fakeIdp({ iss: 'http://velora.test', aud: 'http://chat.test' });
const SAME = { version: '0.1.0', commit: 'a'.repeat(40), built_at: '2026-11-13T02:11:43.000Z' };
const NEWER = { version: '0.1.0', commit: 'b'.repeat(40), built_at: '2026-11-13T02:47:15.000Z', message: 'bot dms' };
let latest = SAME, fetches = 0, clock = 1e12, inst, owner, member, nook, hostd;
const login = async sub => { const r = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: String(sub), username: 'user' + sub }) }); assert.equal(r.status, 200); return api(inst.url, r.body.session); };

test.before(async () => {
  nook = http.createServer((req, res) => { fetches++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(latest)); });
  await new Promise(r => nook.listen(0, '127.0.0.1', r));
  hostd = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise(r => hostd.listen(0, '127.0.0.1', r));
  process.env.BONFIRE_LATEST_URL = `http://127.0.0.1:${nook.address().port}/bonfire/server-latest.json`;
  V._setNow(() => clock);
  V._resetLatest();
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
  auth.setJwksFetcher(idp.jwks);
  owner = await login(100); member = await login(101);
});
test.after(async () => {
  V._setNow(null);
  for (const k of ['BONFIRE_LATEST_URL', 'BONFIRE_BUILD_COMMIT', 'BONFIRE_BUILD_AT', 'BONFIRE_UPDATE_URL', 'BONFIRE_UPDATE_SECRET']) delete process.env[k];
  await inst.close(); await new Promise(r => nook.close(r)); await new Promise(r => hostd.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const info = async (who, q = '') => (await who.get('/api/v1/instance/info' + q)).body;

test('a release inside the cache window: plain reads keep the old answer, Refresh finds it', async () => {
  let u = (await info(owner)).update;
  assert.equal(u.outdated, false);
  assert.equal(fetches, 1);
  latest = NEWER; // a release lands
  clock += 60 * 1000;
  u = (await info(owner)).update;
  assert.equal(u.outdated, false, 'cached: still the old answer');
  assert.equal(fetches, 1);
  u = (await info(owner, '?refresh=1')).update; // Server info > Refresh
  assert.equal(fetches, 2);
  assert.equal(u.outdated, true);
  assert.equal(u.latest.commit_short, 'bbbbbbb');
  assert.equal(new Date(u.checked_at).getTime(), clock, 'the Checked time moves');
});

test('Refresh can not hammer Nookara: within 15 s it reuses the last check', async () => {
  const before = fetches;
  clock += 5 * 1000;
  await info(owner, '?refresh=1');
  assert.equal(fetches, before);
  clock += 16 * 1000;
  await info(owner, '?refresh=1');
  assert.equal(fetches, before + 1);
});

test('without Refresh the answer is at most 10 minutes old', async () => {
  const before = fetches;
  clock += 9 * 60 * 1000;
  await info(owner);
  assert.equal(fetches, before);
  clock += 2 * 60 * 1000;
  await info(owner);
  assert.equal(fetches, before + 1);
});

test('only admins see the update check, and refresh=1 from anyone else asks nobody', async () => {
  const before = fetches;
  clock += 60 * 1000;
  const m = await info(member, '?refresh=1');
  assert.equal(m.update, undefined);
  assert.equal((await info(api(inst.url), '?refresh=1')).update, undefined);
  assert.equal(fetches, before);
});

test('update.one_click says whether Ember can run the update (hostd configured, not Nookara-hosted)', async () => {
  assert.equal((await info(owner)).update.one_click, false);
  process.env.BONFIRE_UPDATE_URL = `http://127.0.0.1:${hostd.address().port}`;
  process.env.BONFIRE_UPDATE_SECRET = 'very-secret-update-token-0123456789';
  assert.equal((await info(owner)).update.one_click, true);
  process.env.BONFIRE_MANAGED = '1';
  try { assert.equal((await info(owner)).update.one_click, false); } finally { delete process.env.BONFIRE_MANAGED; }
});
