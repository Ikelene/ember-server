'use strict';
// Switching accounts mode strands the owner (their account can't sign in any more). The owner gets a handover code when they
// switch; after the restart the instance reports claimed:false, and whoever claims it with the code becomes the owner,
// community included. BONFIRE_OWNER does the same headlessly on Velora accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, api, fakeIdp } = require('./helpers');

delete process.env.BONFIRE_ACCOUNTS_MODE;
delete process.env.BONFIRE_OWNER;
process.env.BONFIRE_VELORA_URL = 'http://velora.test/';
process.env.BONFIRE_PUBLIC_URL = 'https://chat.test';
process.env.EMBER_ACCEPT_OPERATOR_TERMS = '1';
const { startServer } = require('../src/index');
const auth = require('../src/auth');

const idp = fakeIdp();
const dirs = [];
let inst = null;
async function boot(dir) { if (inst) await inst.close(); inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); auth.setJwksFetcher(idp.jwks); return inst; }
test.after(async () => { if (inst) await inst.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const codeIn = dir => fs.readFileSync(path.join(dir, 'setup-code.txt'), 'utf8').trim();

test('local owner switches to Velora accounts, then claims it back with a Velora account and keeps the community', async () => {
  const dir = tmpDir(); dirs.push(dir);
  fs.writeFileSync(dir + '/config.json', JSON.stringify({ accounts_mode: 'local' }));
  await boot(dir);
  const reg = await api(inst.url).post('/api/v1/auth/register', { username: 'amp', password: 'correct horse battery' });
  const local = api(inst.url, reg.body.session);
  assert.equal((await local.post('/api/v1/instance/claim', { code: codeIn(dir), accept_operator_terms: true })).status, 200);
  const sid = (await local.post('/api/v1/servers', { name: 'DevGrounds' })).body.server.sid;

  const r = await local.patch('/api/v1/instance/settings', { accounts_mode: 'velora' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.handover_code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal((await local.patch('/api/v1/instance/settings', { name: 'DevGrounds' })).body.handover_code, undefined, 'only when the mode changes');

  await boot(dir); // the restart the mode change needs
  const info = (await api(inst.url).get('/.well-known/bonfire')).body;
  assert.equal(info.accounts_mode, 'velora');
  assert.equal(info.claimed, false, 'the stranded owner counts as unclaimed');
  assert.equal(codeIn(dir), r.body.handover_code, 'the code from before the restart still works');

  const v = api(inst.url, (await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '35', username: 'amperes' }) })).body.session);
  assert.equal((await v.post('/api/v1/instance/claim', { code: 'AAAA-AAAA', accept_operator_terms: true })).body.error, 'invalid_code');
  assert.equal((await v.post('/api/v1/instance/claim', { code: r.body.handover_code, accept_operator_terms: true })).status, 200);
  assert.equal((await v.get('/api/v1/me')).body.instance_owner, true);
  assert.equal((await api(inst.url).get('/.well-known/bonfire')).body.claimed, true);
  assert.equal(fs.existsSync(path.join(dir, 'setup-code.txt')), false);
  const srv = await v.get(`/api/v1/servers/${sid}`);
  assert.equal(srv.status, 200, 'the new owner is a member');
  assert.equal(srv.body.server.role, 'owner');
  assert.equal(srv.body.server.name, 'DevGrounds');
  assert.equal((await v.patch('/api/v1/instance/settings', { description: 'mine now' })).status, 200);
  assert.equal((await v.post('/api/v1/instance/claim', { code: r.body.handover_code, accept_operator_terms: true })).body.error, 'already_claimed');
});

test('BONFIRE_OWNER takes over from a stranded local owner on boot', async () => {
  const dir = tmpDir(); dirs.push(dir);
  fs.writeFileSync(dir + '/config.json', JSON.stringify({ accounts_mode: 'local' }));
  await boot(dir);
  const local = api(inst.url, (await api(inst.url).post('/api/v1/auth/register', { username: 'amp', password: 'correct horse battery' })).body.session);
  await local.post('/api/v1/instance/claim', { code: codeIn(dir), accept_operator_terms: true });
  const sid = (await local.post('/api/v1/servers', { name: 'Camp' })).body.server.sid;
  fs.writeFileSync(dir + '/config.json', JSON.stringify({ ...JSON.parse(fs.readFileSync(dir + '/config.json', 'utf8')), accounts_mode: 'velora' }));
  process.env.BONFIRE_OWNER = 'v:77';
  try { await boot(dir); } finally { delete process.env.BONFIRE_OWNER; }
  assert.equal((await api(inst.url).get('/.well-known/bonfire')).body.claimed, true);
  const v = api(inst.url, (await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '77', username: 'boss' }) })).body.session);
  assert.equal((await v.get('/api/v1/me')).body.instance_owner, true);
  assert.equal((await v.get(`/api/v1/servers/${sid}`)).body.server.role, 'owner');
});

test('a Velora owner switching to local accounts gets a code a local admin claims with', async () => {
  const dir = tmpDir(); dirs.push(dir);
  fs.writeFileSync(dir + '/config.json', JSON.stringify({ accounts_mode: 'velora' }));
  await boot(dir);
  const v = api(inst.url, (await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '88', username: 'vee' }) })).body.session);
  await v.post('/api/v1/instance/claim', { code: codeIn(dir), accept_operator_terms: true });
  const sid = (await v.post('/api/v1/servers', { name: 'Camp' })).body.server.sid;
  await v.post('/api/v1/instance/local-admin', { username: 'backup', password: 'correct horse battery' });
  const code = (await v.patch('/api/v1/instance/settings', { accounts_mode: 'local' })).body.handover_code;
  assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await boot(dir);
  assert.equal((await api(inst.url).get('/.well-known/bonfire')).body.claimed, false);
  const local = api(inst.url, (await api(inst.url).post('/api/v1/auth/login', { username: 'backup', password: 'correct horse battery' })).body.session);
  assert.equal((await local.post('/api/v1/instance/claim', { code, accept_operator_terms: true })).status, 200);
  assert.equal((await local.get('/api/v1/me')).body.instance_owner, true);
  assert.equal((await local.get(`/api/v1/servers/${sid}`)).body.server.role, 'owner');
});
