'use strict';
// Cross-homeserver sign-in and federation safety (PROTOCOL §4b): the routes, what discovery says, the admin API.
//   keys.js      this homeserver's signing keys + JWKS          remote.js    issuing and accepting remote sign-in tokens
//   resolve.js   finding a remote homeserver and its keys       servers.js   one server's rules for remote accounts
//   seen.js      when each homeserver was first seen            limits.js    limits per remote homeserver
//   denylist.js  local and shared deny lists                    rules.js / psl.js / settings.js   matching and validation
const config = require('../config');
const { err, limiter, log } = require('../util');
const keys = require('./keys');
const remote = require('./remote');
const denylist = require('./denylist');
const limits = require('./limits');
const seen = require('./seen');

const JWKS_PATH = '/.well-known/ember/jwks.json';
const exchangeLimit = limiter(30, 60 * 1000); // remote sign-ins per address (per homeserver: limits.js)

function discovery() {
  const cfg = config.get(), hosts = config.mode() === 'local';
  return {
    jwks_uri: cfg.public_url + JWKS_PATH,
    federation: {
      remote_token_url: hosts ? `${cfg.public_url}/api/v2/auth/remote-token` : null, // where this homeserver's accounts get a token for another one
      remote_url: `${cfg.public_url}/api/v2/auth/remote`,                            // where another homeserver's token is exchanged for a session here
      accepts_remote: remote.acceptMode(),                                            // none / all / allowlist / blocklist
    },
  };
}

function adminView() {
  const f = config.get().federation;
  return {
    federation: { rate_limits: f.rate_limits, min_age_floor_days: f.min_age_floor_days, denylists: f.denylists, deny: f.deny, extra_jwks: f.extra_jwks },
    accepts_remote: remote.acceptMode(),
    keys: keys.view(),
    denylists: denylist.status(),
    held: limits.held(),
    homeservers: seen.all(),
    remote_accounts: require('./servers').remoteMembers(),
  };
}
// PATCH: { rate_limits?, min_age_floor_days?, denylists?, deny?, release?: [domain] (lift holds), refresh?: true (fetch the lists now) }
async function adminPatch(body) {
  const b = body && typeof body === 'object' ? body : {};
  const part = {};
  for (const k of ['rate_limits', 'min_age_floor_days', 'denylists', 'deny', 'extra_jwks']) if (b[k] !== undefined) part[k] = b[k];
  if (Object.keys(part).length) config.update({ federation: part });
  if (Array.isArray(b.release)) for (const d of b.release.slice(0, 1000)) limits.release(String(d).toLowerCase());
  denylist.invalidate();
  if (part.denylists !== undefined || b.refresh === true) await denylist.refresh(); // (ends the sessions of the denied, too)
  else denylist.enforce();
  return adminView();
}

function register(app) {
  // a remote sign-in carries its own proof and no cookies, so any Ember client may make these two calls from a browser
  app.cors('/api/v2/auth/remote', () => true);
  app.cors('/api/v2/auth/remote-token', () => true);

  // this homeserver's keys and the ones config federation.extra_jwks vouches for (?kid=: one a verifier did not find)
  app.get(JWKS_PATH, { auth: false }, req => require('./extra-jwks').jwks(keys.jwks().keys, typeof req.query.kid === 'string' ? req.query.kid.slice(0, 100) : null));
  app.post('/api/v2/auth/remote-token', req => remote.issue(req.user, req.body));
  app.post('/api/v2/auth/remote', { auth: false }, async req => {
    if (!exchangeLimit.hit(req.ip)) throw err('rate_limited', 429);
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    return remote.accept(req.body?.token || (m ? m[1] : null));
  });

  app.get('/api/v2/homeserver/federation', { admin: true }, () => adminView());
  app.patch('/api/v2/homeserver/federation', { admin: true }, req => adminPatch(req.body));
  app.post('/api/v2/homeserver/federation/rotate-key', { owner: true }, req => {
    const kid = keys.rotate();
    log(`[federation] signing key rotated by ${req.user.principal}: ${kid}`);
    return adminView();
  });
}

const start = () => denylist.start();
const stop = () => denylist.stop();

module.exports = { register, discovery, adminView, start, stop, JWKS_PATH, _test: { exchangeLimit } };
