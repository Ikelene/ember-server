'use strict';
// The old names (bonfire / velora) still work at the edges: env vars, bonfire.db, config.json keys, discovery paths.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');
const compat = require('../src/compat');

test('env: EMBER_X wins, the old BONFIRE_X (BONFIRE_VELORA_X, BONFIRE_EMBER_URL) is the fallback', () => {
  const keys = ['EMBER_PLAN', 'BONFIRE_PLAN', 'EMBER_NOOKARA_URL', 'BONFIRE_VELORA_URL', 'EMBER_CLIENT_URL', 'BONFIRE_EMBER_URL'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(compat.env('PLAN'), undefined);
    process.env.BONFIRE_PLAN = 'plus';
    assert.equal(compat.env('PLAN'), 'plus');
    process.env.EMBER_PLAN = 'starter';
    assert.equal(compat.env('PLAN'), 'starter');
    process.env.EMBER_PLAN = ''; // an empty new name (an image default) does not hide the old one
    assert.equal(compat.env('PLAN'), 'plus');
    process.env.BONFIRE_VELORA_URL = 'https://old.example';
    assert.equal(compat.env('NOOKARA_URL'), 'https://old.example');
    process.env.BONFIRE_EMBER_URL = 'https://client.example';
    assert.equal(compat.env('CLIENT_URL'), 'https://client.example');
  } finally { for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('settings: velora keys and the "velora" accounts mode are renamed, values stay "velora" on the wire', () => {
  assert.deepEqual(compat.renameLegacySettings({ velora_url: 'https://a', velora_registration: 'off', accounts_mode: 'velora' }), { nookara_url: 'https://a', nookara_registration: 'off', accounts_mode: 'nookara' });
  assert.deepEqual(compat.renameLegacySettings({ velora_url: 'https://a', nookara_url: 'https://b' }), { nookara_url: 'https://b' });
  assert.equal(compat.wireMode('nookara'), 'velora');
  assert.equal(compat.wireMode('local'), 'local');
  assert.deepEqual(compat.withLegacy({ nookara: 1, nookara_url: 2, x: 3 }), { nookara: 1, nookara_url: 2, x: 3, velora: 1, velora_url: 2 });
});

test('boot: bonfire.db becomes ember.db, config.json velora keys become nookara keys, both discovery paths answer', async () => {
  const dir = tmpDir();
  // an old install: config.json with the old names, the database under its old name
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name: 'Old', accounts_mode: 'velora', velora_url: 'https://nookara.cc', velora_registration: 'off' }));
  const config = require('../src/config'), db = require('../src/db');
  config.init({ dataDir: dir, port: 4999 });
  db.open(); db.run("INSERT INTO meta (k, v) VALUES ('velora_dir', 'x')"); db.close();
  fs.renameSync(path.join(dir, 'ember.db'), path.join(dir, 'bonfire.db'));
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(path.join(dir, 'ember.db' + ext))) fs.renameSync(path.join(dir, 'ember.db' + ext), path.join(dir, 'bonfire.db' + ext));
  // reset the database to before v21 so the column / meta migration runs on it
  {
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(dir, 'bonfire.db'));
    raw.exec("ALTER TABLE users RENAME COLUMN nookara_id TO velora_id; UPDATE meta SET k = 'velora_dir' WHERE k = 'nookara_dir'; PRAGMA user_version = 20;");
    raw.close();
  }
  const { startServer } = require('../src/index');
  const srv = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  try {
    assert.ok(fs.existsSync(path.join(dir, 'ember.db')));
    assert.ok(!fs.existsSync(path.join(dir, 'bonfire.db')));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.accounts_mode, 'nookara');
    assert.equal(saved.nookara_url, 'https://nookara.cc');
    assert.equal(saved.nookara_registration, 'off');
    assert.ok(!('velora_url' in saved) && !('velora_registration' in saved));
    assert.equal(config.mode(), 'nookara');
    assert.ok(db.get("SELECT 1 AS ok FROM pragma_table_info('users') WHERE name = 'nookara_id'"));
    assert.equal(db.metaGet('nookara_dir'), 'x');
    const base = srv.url;
    const now = await (await fetch(base + compat.WELL_KNOWN)).json();
    const old = await (await fetch(base + compat.LEGACY_WELL_KNOWN)).json();
    assert.equal(now.accounts_mode, 'velora');
    assert.deepEqual(now.nookara, now.velora);
    assert.equal(now.nookara.issuer, 'https://nookara.cc');
    assert.deepEqual(Object.keys(old).sort(), Object.keys(now).sort());
  } finally { await srv.close(); }
});
