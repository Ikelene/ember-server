'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// stubs: no database, no Velora, no sockets
const stub = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
stub('../src/config', { mode: () => 'velora', get: () => ({ velora_url: 'https://velora.test', velora_registration: 'open' }) });
stub('../src/db', { all: () => [] });
const refreshed = [];
stub('../src/auth', { refreshVeloraProfile: p => { refreshed.push(p); return true; } });
const urls = [];
global.fetch = async url => { urls.push(String(url)); return { ok: true, json: async () => ({ profiles: [{ id: '12', username: 'ann2', display_name: 'ann2', pfp: 'https://velora.test/uploads/pfp/x.jpeg' }] }) }; };
const profiles = require('../src/profiles');

test('nudge ignores bad ids', async () => {
  assert.equal(await profiles.nudge('abc'), 0);
  assert.equal(await profiles.nudge('0'), 0);
  assert.equal(await profiles.nudge(''), 0);
  assert.equal(urls.length, 0);
});

test('nudge re-reads that profile now (cache-busted) and is throttled per account', async () => {
  assert.equal(await profiles.nudge('12'), 1);
  assert.match(urls[0], /ids=12&_=\d+$/);
  assert.equal(refreshed[0].username, 'ann2');
  assert.equal(await profiles.nudge('12'), 0); // 100 clients sending it at once = one fetch
  assert.equal(urls.length, 1);
});
