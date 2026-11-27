'use strict';
// A server with no build args, no .git and no build-info.json (a tarball / copied folder) says why it can't check for updates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_PUBLIC_URL = 'http://chat.test';
process.env.BONFIRE_VELORA_URL = 'http://velora.test';
process.env.BONFIRE_OWNER = 'v:100';
process.env.BONFIRE_BUILD_FROM_GIT = '0'; // pretend there is no .git (read once, when src/version.js loads)
process.env.BONFIRE_LATEST_URL = 'http://127.0.0.1:9/never-asked.json';
for (const k of ['BONFIRE_MANAGED', 'BONFIRE_UPDATE_CHECK', 'BONFIRE_UPDATE_URL', 'BONFIRE_BUILD_COMMIT', 'BONFIRE_BUILD_ID', 'BONFIRE_CONTAINER', 'BONFIRE_IMAGE']) delete process.env[k];
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const V = require('../src/version');
const { tmpDir, api, fakeIdp } = require('./helpers');

test('no build identity: update is null and update_reason says why', { skip: fs.existsSync(path.join(__dirname, '..', 'build-info.json')) && 'build-info.json present' }, async () => {
  const dir = tmpDir(), idp = fakeIdp({ iss: 'http://velora.test', aud: 'http://chat.test' });
  V._resetLatest();
  const inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
  auth.setJwksFetcher(idp.jwks);
  try {
    const r = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '100', username: 'owner' }) });
    const i = (await api(inst.url, r.body.session).get('/api/v1/instance/info')).body;
    assert.equal(i.build.source, null); assert.equal(i.build.commit, null);
    assert.equal(i.update, null); assert.equal(i.update_reason, 'no_build_identity');
    assert.equal(i.install.kind, fs.existsSync('/.dockerenv') ? 'docker_build' : 'unknown');
  } finally { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.BONFIRE_LATEST_URL; }
});
