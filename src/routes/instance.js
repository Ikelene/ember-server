'use strict';
// Discovery, instance auth, claiming, instance settings + admins.
const { KIND_NOOKARA, ERR, SOFTWARE, LEGACY_SOFTWARE, NOOKARA_PATHS, WELL_KNOWN, LEGACY_WELL_KNOWN, LEGACY_ROUTES, wireMode, withLegacy } = require('../compat');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const setup = require('../setup');
const gateway = require('../gateway');
const C = require('../communities');
const managed = require('../managed');
const { err, limiter, log } = require('../util');
const pkg = require('../../package.json');
const V = require('../version');

const registerLimit = auth.limits.register, loginLimit = auth.limits.login;
const nookaraLimit = limiter(60, 60 * 1000);
const claimLimit = limiter(10, 600 * 1000);

// legacy: the document at /.well-known/bonfire (released clients): the old software name and accounts_mode value
function discovery({ legacy = false } = {}) {
  const cfg = config.get();
  const mode = config.mode();
  // withLegacy: the `nookara` object also goes out as `velora` (older clients read that)
  return withLegacy({
    software: legacy ? LEGACY_SOFTWARE : SOFTWARE, version: pkg.version, protocol: 1, protocol_version: 2,
    open_protocol: true, protocol_name: 'Ember Instance Protocol', protocol_docs: 'https://github.com/Ikelene/ember-server/blob/main/PROTOCOL.md',
    about: "Ember is an open chat protocol, not a Nookara-only product: anyone can write an Ember client and use or run Ember servers. Nookara's web, desktop and Android apps are just the clients the Nookara ecosystem uses.",
    build: V.build(), // PROTOCOL §3: { version, commit, commit_short, commit_date, built_at, dirty, build_id }
    name: cfg.name, description: cfg.description, icon_url: cfg.icon_url, public_url: cfg.public_url, previous_urls: require('../public-url').previousUrls(), // earlier addresses (signed messages name the one they were sent to)
    accounts_mode: legacy ? wireMode(mode) : mode,
    // signing_issuers: the "iss" a message signature may name here, preferred first (clients sign with the first one they know)
    nookara: mode === 'nookara' ? { issuer: cfg.nookara_url, jwks_url: `${cfg.nookara_url}${NOOKARA_PATHS.jwks}`, signing_issuers: require('../signing').issuers() } : null,
    claimed: auth.claimed() && !auth.ownerStranded(), // false also when the owner's account can't sign in under this accounts mode: the setup code hands it over
    registration: mode === 'local' && (cfg.registration === 'open' || !auth.claimed()) ? 'open' : 'closed',
    features: { signing: mode === 'nookara', voice: require('../voice').available(), uploads: true, youtube: require('../youtube').enabled(), minecraft: true, bridges: require('../bridge').features(), member_presence: true, wake: true, server_profiles: true, account_profiles: mode === 'local' },
    max_upload_mb: cfg.max_upload_mb,
    read_only: managed.readOnly(), // PROTOCOL §19.5
    managed: managed.view(), // the old hosted containers' plan (old clients read it), null otherwise
    ...require('../push').discovery(), // PROTOCOL §20: where a client registers its pushers
    ...require('../limits').discovery(), // PROTOCOL §19: the homeserver's default limits and the tiers a server can buy
    // the homeserver itself, and the servers it lists (PROTOCOL §5a). `community` stays for protocol 1 clients: one server per instance
    // (with its branding, PROTOCOL §5e: the name and pictures its pages show, and the theme tokens clients may tint it with)
    homeserver: { ...require('../branding').discovery(), description: cfg.description },
    // client-neutral invite links: <url_base><slug>/<code>; clients: [{ name, url, icon_url? }], url templates with {address} {slug} {domain} {code}
    invites: { url_base: cfg.invites.url_base, clients: cfg.invites.clients },
    creation: { mode: cfg.creation.mode, per_account: cfg.creation.per_account, ...(cfg.creation.mode === 'request' ? { request_url: require('../server-requests').requestUrl() } : {}) }, // who may make a server here (admins / allowlist / request / anyone); request: where to ask
    communities_count: C.communityCount(),
    communities: C.listedCommunities().map(C.discoveryView),
    community: C.discoveryCommunity(),
    // homeserver accounts (PROTOCOL §4a): `accounts`, and `login` (where to sign in) when accounts are hosted here
    ...require('../login').discovery(),
    // cross-homeserver sign-in (PROTOCOL §4b): `jwks_uri` and `federation`
    ...require('../federation').discovery(),
    // friends, DMs, profiles and keys (PROTOCOL §4c): `social`, where this homeserver's accounts are reached
    ...require('../social').discovery(),
    // the instance's relay key (PROTOCOL §12.1): Nookara checks it here before binding this url to the key
    ...require('../relay/client').identity(),
  });
}

function register(app, { restart }) {
  require('../backups').register(app);
  require('../limits').register(app); require('../tiers').register(app); // PROTOCOL §19
  require('../push').register(app); // PROTOCOL §20
  require('../selfupdate').register(app); // GET/POST /api/v1/instance/update (asks hostd to rebuild + recreate this container)
  app.get(WELL_KNOWN, { auth: false }, () => discovery());
  app.get(LEGACY_WELL_KNOWN, { auth: false }, () => discovery({ legacy: true }));
  app.get('/health', { auth: false }, () => ({ ok: true }));
  // PROTOCOL §5c: public build identity; instance admins/owner additionally get uptime, node, live stats and the update check
  app.get('/api/v1/instance/info', { auth: false }, async req => {
    const out = { software: SOFTWARE, protocol: 1, open_protocol: true, version: pkg.version, build: V.build(), name: config.get().name };
    const s = auth.resolveSession(auth.bearer(req));
    if (s && !s.user.banned && auth.isAdmin(s.user)) {
      out.admin = true;
      out.plan = managed.usage(planCommunity(req)); // ?sid= one server's usage
      out.runtime = V.runtime();
      out.stats = V.stats();
      // ?refresh=1 (Server info > Refresh): really ask Nookara again instead of the cached answer
      out.update = await V.update({ fresh: String(req.query?.refresh || '') === '1' });
      if (out.update) out.update.one_click = require('../selfupdate').support().supported; // the "Update now" button can do it from Ember
    }
    return out;
  });
  // public numbers for the landing page (and anyone): counts only, nothing a stranger couldn't already see
  app.get('/api/v1/instance/stats', { auth: false }, () => require('../landing').publicStats());
  // a browser gets the landing page (landing.js); every other client the same JSON as always
  app.get('/', { auth: false }, (req, res) => (require('../landing').wantsHtml(req) ? require('../landing').sendPage(req, res) : rootJson()));
  const rootJson = () => ({ software: SOFTWARE, version: pkg.version, protocol: 1, open_protocol: true, about: "Ember is an open chat protocol, not a Nookara-only product: anyone can write an Ember client and use or run Ember servers. Nookara's web, desktop and Android apps are just the clients the Nookara ecosystem uses.", protocol_docs: 'https://github.com/Ikelene/ember-server/blob/main/PROTOCOL.md', discovery: WELL_KNOWN });

  // ---- auth ----
  for (const p of ['/api/v1/auth/nookara', LEGACY_ROUTES.authNookara]) app.post(p, { auth: false }, async req => {
    if (!nookaraLimit.hit(req.ip)) throw err('rate_limited', 429);
    return auth.loginNookara(req.body?.token);
  });
  app.post('/api/v1/auth/register', { auth: false }, async req => {
    if (!registerLimit.hit(req.ip)) throw err('rate_limited', 429);
    return auth.registerLocal(req.body?.username, req.body?.password, req.body?.invite);
  });
  app.post('/api/v1/auth/login', { auth: false }, async req => {
    if (!loginLimit.hit(req.ip)) throw err('rate_limited', 429);
    return auth.loginLocal(req.body?.username, req.body?.password);
  });
  app.post('/api/v1/auth/logout', req => { auth.revokeSession(auth.bearer(req)); return { ok: true }; });
  app.get('/api/v1/me', req => ({ user: auth.userView(req.user), instance_admin: auth.isAdmin(req.user), instance_owner: auth.isOwner(req.user), scopes: req.scopes }));
  // account profiles (§4.1): a local account's name, picture, banner, colour, bio and pronouns, kept on this server
  const AP = () => require('../account-profile');
  app.get('/api/v1/me/profile', req => AP().get(req.user));
  app.patch('/api/v1/me/profile', req => AP().update(req.user, req.body || {}));
  app.post('/api/v1/me/profile/:kind', async req => {
    if (!['pfp', 'banner'].includes(req.params.kind)) throw err('not_found', 404);
    if (!auth.profileHere(req.user)) throw err('local_accounts_only', 400);
    const { buffer } = await require('../uploads').readMultipart(req, { maxBytes: 4 * 1024 * 1024 });
    if (!buffer) throw err('no_file');
    return AP().setImage(req.user, req.params.kind, buffer);
  });
  app.delete('/api/v1/me/profile/:kind', req => AP().setImage(req.user, req.params.kind, null));

  // ---- claim + settings + admins ----
  app.post('/api/v1/instance/claim', req => {
    if (!claimLimit.hit(req.ip)) throw err('rate_limited', 429);
    if (auth.claimed() && !auth.ownerStranded()) throw err('already_claimed', 409);
    if (req.user.kind === 'bot') throw err('bots_cannot_claim', 403);
    if (req.user.kind === 'remote') throw err('remote_cannot_claim', 403); // the owner is an account this homeserver can vouch for
    if (!setup.check(req.body?.code)) throw err('invalid_code', 403);
    require('../operator-terms').requireForSetup(req.body, req.user); // setup cannot finish without accepting the Ember Server Operator Terms
    setup.claim(req.user);
    gateway.pushToUser(req.user.id, { type: 'instance_update', settings: config.publicView() });
    return { ok: true };
  });
  // `listed` is a server's own setting now; old admin pages still read it here: true while any server is listed
  const planCommunity = req => (req?.query?.sid ? C.findCommunity(req.query.sid).id : null);
  const settingsView = req => ({ ...config.adminView(), listed: C.listedCommunities().length > 0, operator_terms: require('../operator-terms').view(), managed: managed.view(), plan: managed.usage(planCommunity(req)), ...withLegacy({ nookara: withLegacy(require('../relay').status()) }), local_admins: auth.localAdmins().map(u => u.username) });
  app.get('/api/v1/instance/settings', { admin: true }, req => settingsView(req));
  app.patch('/api/v1/instance/settings', { admin: true }, req => {
    managed.guardSettings(req.body, config.get());
    // switching to local accounts: Nookara sign-in stops working, so someone must be able to sign in with a password and switch back
    if (req.body?.accounts_mode === 'local' && config.get().accounts_mode !== 'local' && !auth.localAdmins().length) throw err('local_admin_required', 409);
    config.update(req.body); if (req.body?.max_backups !== undefined) require('../backups').prune();
    if (req.body?.tags !== undefined) require('../relay/directory').poke();
    // the owner switching to accounts their own account isn't: after the restart they claim it again with this code (and keep the community)
    const next = config.adminView().accounts_mode, me = req.user;
    if (req.body?.accounts_mode !== undefined && auth.isOwner(me) && me.kind !== (next === 'local' ? 'local' : KIND_NOOKARA)) return { ...settingsView(), handover_code: setup.handoverCode() };
    return settingsView();
  });
  // Ember Server Operator Terms: an instance set up before they existed accepts from the dashboard notice (never blocks chat); anyone signed in can read the status
  app.get('/api/v1/instance/operator-terms', () => require('../operator-terms').view());
  app.post('/api/v1/instance/operator-terms/accept', { owner: true }, req => {
    if (req.body?.accept_operator_terms !== true) throw err('operator_terms_required', 400);
    return require('../operator-terms').acceptLater(req.user);
  });
  app.post('/api/v1/instance/operator-terms/dismiss', { admin: true }, () => require('../operator-terms').dismiss());
  // (owner, like adding admins) a local (username + password) admin account, made while still on Nookara accounts: instance admin, and an
  // Administrator role on the server `sid` (or the only one there is; with several and no sid it is an instance admin only)
  app.post('/api/v1/instance/local-admin', { owner: true }, async req => {
    const c = req.body?.sid || C.communityCount() === 1 ? C.pickCommunity(req.body?.sid) : null;
    const id = await auth.createLocalUser(req.body?.username, req.body?.password);
    db.run('INSERT OR IGNORE INTO instance_admins (user_id) VALUES (?)', id);
    if (c) {
      const owner = auth.userById(c.owner_id), u = auth.userById(id);
      C.addMember(c, id, { announce: false });
      let role = C.snapOf(c).roles.filter(r => !r.is_default && (Number(r.permissions) & 512)).sort((a, b) => b.position - a.position)[0];
      if (!role) { const made = C.createRole(c.sid, owner, { name: 'Admin', permissions: 512 }); role = made.role || made; }
      C.setMemberRole(c.sid, owner, u.principal, role.rid, true);
    }
    return { user: auth.userView(auth.userById(id)), settings: settingsView() };
  });
  // Nookara relays (PROTOCOL §12): register now (any `token` in the body is ignored: Nookara tokens never go to an instance)
  for (const p of ['/api/v1/instance/nookara/register', LEGACY_ROUTES.registerNookara]) app.post(p, { admin: true }, async () => {
    await require('../relay/client').registerNow();
    return settingsView();
  });
  // the owner's signed proof of ownership; they present it to Nookara themselves (POST to its instances/payout route)
  app.get('/api/v1/instance/owner-attestation', { owner: true }, () => {
    const owner = auth.ownerRow(), rc = require('../relay/client');
    if (!owner?.nookara_id || owner.kind !== KIND_NOOKARA) throw err(ERR.ownerNotNookara, 400);
    if (!rc.registered()) throw err('not_registered', 409);
    return { attestation: rc.ownerAttestation(owner.nookara_id), instance_id: rc.identity().instance_id };
  });
  for (const p of ['/api/v1/import/nookara', LEGACY_ROUTES.importNookara]) app.post(p, req => require('../relay/import').importFromNookara(req.user, req.body?.ticket));
  app.post('/api/v1/instance/restart', { admin: true }, (req, res) => {
    log(`[instance] restart requested by ${req.user.principal}`);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    setTimeout(restart, 100);
  });
  app.get('/api/v1/instance/admins', { admin: true }, () => ({
    admins: db.all('SELECT u.* FROM instance_admins a JOIN users u ON u.id = a.user_id ORDER BY u.id').map(auth.userView),
    owner: auth.userView(auth.ownerRow()),
  }));
  app.put('/api/v1/instance/admins/:uid', { owner: true }, req => {
    const u = C.userByPrincipalOrThrow(req.params.uid);
    db.run('INSERT OR IGNORE INTO instance_admins (user_id) VALUES (?)', u.id);
  });
  app.delete('/api/v1/instance/admins/:uid', { owner: true }, req => {
    const u = C.userByPrincipalOrThrow(req.params.uid);
    if (auth.isOwner(u)) throw err('cannot_remove_owner', 400);
    db.run('DELETE FROM instance_admins WHERE user_id = ?', u.id);
  });
}
module.exports = { register, discovery };
