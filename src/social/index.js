'use strict';
// Friends, DMs, profiles and keys between homeservers (PROTOCOL §4c).
//   s2s.js      signed server-to-server requests (/_ember/s2s/v1/*)
//   people.js   ids and handles, lookup, profiles, what is cached about accounts of other homeservers
//   friends.js  friends and blocks
//   keys.js     the key document of an account (what a sender needs to seal a message to it)
//   e2ee.js     end-to-end encrypted DMs: an account's own keys, their locked backups, device links; the sealed envelope
//   reports.js  reported DM messages, for the admins of the sender's homeserver
//   dms.js      DMs hosted here, pointers to DMs hosted elsewhere, activity
const s2s = require('./s2s');

function register(app) {
  s2s.register(app);
  require('./people').register(app);
  require('./friends').register(app);
  require('./keys').register(app);
  require('./e2ee').register(app);
  require('./reports').register(app);
  require('./dms').register(app);
}
const start = () => require('./dms').start();
const stop = () => require('./dms').stop();
const discovery = () => s2s.discovery();

module.exports = { register, discovery, start, stop };
