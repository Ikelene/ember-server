'use strict';
// A hosted server moved (BONFIRE_PUBLIC_URL changed between boots): stored urls on the old origin follow, config.json too,
// and the discovery document lists the earlier origins (old signed messages name them).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bonfire-puburl-'));
const OLD = 'https://camp-bonfire.ikelene.net', NEW = 'https://e_camp.nookara.cc';
test.after(() => { require('../src/db').close(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.BONFIRE_PUBLIC_URL; });

test('first boot remembers the url; a changed url rewrites stored copies (plain, JSON, encoded) once', () => {
  process.env.BONFIRE_PUBLIC_URL = OLD;
  const config = require('../src/config'), db = require('../src/db'), P = require('../src/public-url');
  config.init({ dataDir: dir });
  db.open();
  assert.equal(P.checkPublicUrl(), null);
  assert.equal(db.metaGet('public_url'), OLD);
  config.update({ icon_url: `${OLD}/uploads/chat/icon.png` });
  db.run("INSERT INTO users (id, principal, kind, username, display_name, created_at) VALUES (1, 'v:1', 'velora', 'a', 'A', 1)");
  db.run("INSERT INTO communities (id, sid, name, icon_url, owner_id, invite_code, created_at) VALUES (1, 's1', 'Camp', ?, 1, 'inv1', 1)", `${OLD}/uploads/chat/icon.png`);
  db.run("INSERT INTO channels (id, cid, community_id, name, created_at) VALUES (1, 'c1', 1, 'general', 1)");
  const att = JSON.stringify([{ url: `${OLD}/uploads/a/b.png`, sha256: 'x'.repeat(64) }]);
  db.run('INSERT INTO messages (id, channel_id, user_id, body, attachments, created_at) VALUES (1, 1, 1, ?, ?, 1)', `see ${OLD}/x and https%3A%2F%2Fcamp-bonfire.ikelene.net%2Finvite`, att);
  db.run('INSERT INTO messages (id, channel_id, user_id, body, created_at) VALUES (2, 1, 1, ?, 1)', `${OLD}.evil.example/x and camp-bonfire.ikelene.net alone`);
  db.run("INSERT INTO messages (id, channel_id, user_id, body, created_at, sig_kid, sig_sig, sig_ts, sig_nonce, verified) VALUES (3, 1, 1, ?, 1, 'k', 'sig', 1, 'n', 1)", `signed ${OLD}/x`);
  assert.equal(P.checkPublicUrl(), null, 'same url: nothing to do');

  process.env.BONFIRE_PUBLIC_URL = NEW;
  const r = P.checkPublicUrl();
  assert.equal(r.from, OLD); assert.equal(r.to, NEW); assert.ok(r.rows >= 3); assert.deepEqual(r.config, ['icon_url']);
  assert.equal(db.get('SELECT icon_url FROM communities WHERE id = 1').icon_url, `${NEW}/uploads/chat/icon.png`);
  const m1 = db.get('SELECT body, attachments FROM messages WHERE id = 1');
  assert.equal(JSON.parse(m1.attachments)[0].url, `${NEW}/uploads/a/b.png`);
  assert.equal(m1.body, `see ${NEW}/x and ${encodeURIComponent(NEW)}%2Finvite`);
  assert.equal(db.get('SELECT body FROM messages WHERE id = 2').body, `${OLD}.evil.example/x and camp-bonfire.ikelene.net alone`, 'only real origin boundaries');
  assert.equal(db.get('SELECT body FROM messages WHERE id = 3').body, `signed ${OLD}/x`, 'signed bodies are never touched');
  assert.equal(config.get().icon_url, `${NEW}/uploads/chat/icon.png`);
  assert.equal(db.metaGet('public_url'), NEW);
  assert.deepEqual(P.previousUrls(), [OLD]);
  assert.equal(P.checkPublicUrl(), null, 'runs once');
});
