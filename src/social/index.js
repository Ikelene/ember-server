'use strict';
// Friends, DMs, profiles and keys between homeservers (PROTOCOL §4c).
//   s2s.js      signed server-to-server requests (/_ember/s2s/v1/*)
//   people.js   ids and handles, lookup, profiles, what is cached about accounts of other homeservers
//   friends.js  friends and blocks
//   keys.js     the public keys accounts publish
const s2s = require('./s2s');

function register(app) {
  s2s.register(app);
  require('./people').register(app);
  require('./friends').register(app);
  require('./keys').register(app);
}
const discovery = () => s2s.discovery();

module.exports = { register, discovery };
