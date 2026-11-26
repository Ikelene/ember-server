'use strict';
// A second homeserver for tests, in a worker thread: the server keeps its state in module singletons (config, the database),
// so one thread can run only one. helpers.js startHomeserver() talks to it: { id, cmd, args } in, { id, result | error } out.
const { parentPort, workerData } = require('worker_threads');
const { startServer } = require('../src/index');

let inst = null;
const commands = {
  async start() {
    inst = await startServer({ dataDir: workerData.dataDir, port: 0 });
    if (workerData.config) require('../src/config').update(workerData.config);
    return { port: inst.port, setupCode: inst.setup.current() };
  },
  config(patch) { require('../src/config').update(patch); return require('../src/config').get().federation; },
  rotateKey() { return require('../src/federation/keys').rotate(); },
  keys() { return require('../src/federation/keys').view(); },
  ageKey({ kid, ms }) { require('../src/federation/keys')._test.age(kid, ms); },
  // friends, DMs, profiles and keys (PROTOCOL §4c)
  async idle() { await require('../src/social/s2s').idle(); await require('../src/push').idle(); },
  setRetry(list) { require('../src/social/s2s')._test.setRetry(list); },
  sql({ query, params = [] }) { const db = require('../src/db'); return /^\s*select/i.test(query) ? db.all(query, ...params) : db.run(query, ...params).changes; },
  async close() { await inst?.close(); inst = null; },
};
parentPort.on('message', async ({ id, cmd, args }) => {
  try { parentPort.postMessage({ id, result: await commands[cmd](args) }); } catch (e) { parentPort.postMessage({ id, error: e.message || String(e) }); }
});
