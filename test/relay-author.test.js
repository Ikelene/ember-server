// relay/push.js: the push body names the author and gives their picture as an absolute https link (Nookara's phone notifications
// show who wrote it, not the community). The rest of the relay is covered by relay.test.js (needs the Velora checkout).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const stub = (rel, exports) => { const p = require.resolve(path.join(__dirname, '..', 'src', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const sent = [];
stub('db', { get: () => ({ ru: null }), all: () => [] });
stub('config', { publicUrl: () => 'https://e-test.nookara.cc' });
stub('gateway', { isOnline: () => false });
stub('notify', { setOfflineHandler: () => {} });
stub('relay/client', { registered: () => true, call: async (m, p, body) => { sent.push(body); return {}; } });
const push = require('../src/relay/push');
const pkt = (over = {}) => ({ id: 1, sid: 's1', cid: 'c1', server: 'Pals', channel: 'general', from: 'alice', pfp: '/uploads/avatars/a.png', body: '@bob hi', ...over });
const u = { id: 7, velora_id: 3 };

test('author name + absolute picture', async () => {
  push._setWindow(10);
  sent.length = 0;
  push.onOffline = push.onOffline; // (direct send through the window code path)
  require.cache[require.resolve('../src/db')].exports.get = (sql) => (/FROM users/.test(sql) ? { ...u, kind: 'velora' } : { ru: null });
  push.onOffline([7], pkt());
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sent[0].author_name, 'alice');
  assert.equal(sent[0].author_avatar, 'https://e-test.nookara.cc/uploads/avatars/a.png');
  assert.equal(sent[0].title, 'alice mentioned you');
});
test('no picture, a non-https one, or credentials in it: left out', async () => {
  for (const pfp of [null, 'http://x.example/a.png', 'https://u:p@x.example/a.png', 'javascript:alert(1)']) {
    sent.length = 0;
    push.onOffline([7], pkt({ cid: 'c' + Math.random(), pfp }));
    await new Promise(r => setTimeout(r, 20));
    assert.equal(sent[0].author_avatar, undefined, String(pfp));
    assert.equal(sent[0].author_name, 'alice');
  }
});
test.after(() => push.stop());
