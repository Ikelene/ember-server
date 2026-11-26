'use strict';
// Friends, DMs, profiles and keys between homeservers (PROTOCOL §4c).
//   s2s.js      signed server-to-server requests (/_ember/s2s/v1/*)
const s2s = require('./s2s');

function register(app) {
  s2s.register(app);
}
const discovery = () => s2s.discovery();

module.exports = { register, discovery };
