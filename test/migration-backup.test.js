'use strict';
// Updating a database (db.js backupBeforeMigrating): a consistent copy first, in DATA_DIR/backups, the newest 3 kept; no copy,
// no update (unless EMBER_SKIP_MIGRATION_BACKUP=1); bonfire.db is taken over first; a new database needs none.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { tmpDir, api } = require('./helpers');

for (const k of Object.keys(process.env)) if (/^(BONFIRE|EMBER)_/.test(k)) delete process.env[k];
const { startServer } = require('../src/index');
const db = require('../src/db');

const FIX = path.join(__dirname, 'fixtures', 'old-local-instance');
const dir = tmpDir();
const backups = () => (fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')).filter(f => f.startsWith('ember.db.pre-v')).sort() : []);
const versionOf = file => { const d = new DatabaseSync(file, { readOnly: true }); try { return d.prepare('PRAGMA user_version').get().user_version; } finally { d.close(); } };
const start = () => startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
// the database back to the version before the newest migration (it runs again: every migration can)
function oneBack(inst) { const to = db.migrationCount(); db.raw().exec(`PRAGMA user_version = ${to - 1}`); return inst.close(); }
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('an old bonfire.db: taken over as ember.db, copied to backups before it is updated, and it still works', async () => {
  fs.cpSync(path.join(FIX, 'data'), dir, { recursive: true });
  const from = versionOf(path.join(dir, 'bonfire.db'));
  const inst = await start();
  try {
    const to = db.migrationCount();
    assert.ok(from > 0 && from < to);
    assert.ok(fs.existsSync(path.join(dir, 'ember.db')) && !fs.existsSync(path.join(dir, 'bonfire.db')));
    const list = backups();
    assert.equal(list.length, 1);
    assert.match(list[0], new RegExp(`^ember\\.db\\.pre-v${from}-to-v${to}-\\d{4}-\\d\\d-\\d\\dT`));
    assert.equal(db.lastMigrationBackup(), path.join(dir, 'backups', list[0]));
    // a real database, as it was before the update, with its accounts in it
    const copy = new DatabaseSync(path.join(dir, 'backups', list[0]), { readOnly: true });
    assert.equal(copy.prepare('PRAGMA user_version').get().user_version, from);
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM users WHERE kind = 'local'").get().n, 3);
    copy.close();
    assert.equal((await api(inst.url).post('/api/v1/auth/login', { username: 'alice', password: 'alice old password' })).status, 200);
  } finally { await oneBack(inst); }
});

test('the newest three are kept', async () => {
  for (let i = 0; i < 4; i++) {
    const inst = await start();
    await oneBack(inst);
    await new Promise(r => setTimeout(r, 15)); // (distinct times)
  }
  assert.equal(backups().length, 3);
});

test('a backup that fails stops the update and the start; EMBER_SKIP_MIGRATION_BACKUP=1 goes ahead without one', async () => {
  const keep = path.join(dir, 'backups.kept');
  fs.renameSync(path.join(dir, 'backups'), keep);
  fs.writeFileSync(path.join(dir, 'backups'), 'not a folder'); // (nothing can be written there)
  try {
    const before = versionOf(path.join(dir, 'ember.db'));
    await assert.rejects(start(), e => e.code === 'migration_backup_failed' && /EMBER_SKIP_MIGRATION_BACKUP/.test(e.message));
    assert.equal(versionOf(path.join(dir, 'ember.db')), before, 'nothing was migrated');
    process.env.EMBER_SKIP_MIGRATION_BACKUP = '1';
    const inst = await start();
    assert.equal(db.lastMigrationBackup(), null);
    assert.equal(db.raw().prepare('PRAGMA user_version').get().user_version, db.migrationCount());
    await inst.close();
  } finally {
    delete process.env.EMBER_SKIP_MIGRATION_BACKUP;
    fs.rmSync(path.join(dir, 'backups'), { force: true });
    fs.renameSync(keep, path.join(dir, 'backups'));
  }
});

test('a new database needs no backup', async () => {
  const fresh = tmpDir();
  try {
    const inst = await startServer({ dataDir: fresh, port: 0, host: '127.0.0.1', restart: () => {} });
    assert.equal(db.lastMigrationBackup(), null);
    assert.ok(!fs.existsSync(path.join(fresh, 'backups')) || !fs.readdirSync(path.join(fresh, 'backups')).some(f => f.startsWith('ember.db.pre-v')));
    await inst.close();
  } finally { fs.rmSync(fresh, { recursive: true, force: true }); }
});
