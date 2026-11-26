'use strict';
// The old names: this server was "bonfire-server" and Nookara was "Velora". Everything inside the server now uses the new
// names; the old ones are only still accepted (or still sent) at the edges, and every such spot is named here so they can
// be switched off in one place later.

// ---------------------------------------------------------------- environment variables
// EMBER_X wins; BONFIRE_X still works (BONFIRE_VELORA_X for EMBER_NOOKARA_X), with a warning once per old name.
const LEGACY_ENV = { CLIENT_URL: 'BONFIRE_EMBER_URL' }; // renamed beyond the prefix
const warned = new Set();
const legacyName = name => LEGACY_ENV[name] || 'BONFIRE_' + name.replace(/NOOKARA/g, 'VELORA');
// env('DATA') -> EMBER_DATA, else BONFIRE_DATA; env('NOOKARA_URL') -> EMBER_NOOKARA_URL, else BONFIRE_VELORA_URL.
// Read on every call (tests flip them).
function env(name) {
  const now = 'EMBER_' + name;
  if (process.env[now] !== undefined && process.env[now] !== '') return process.env[now];
  const old = legacyName(name);
  if (process.env[old] === undefined || process.env[old] === '') return process.env[now]; // '' set by an image default: still the new name
  if (!warned.has(old)) { warned.add(old); console.warn(`[compat] ${old} is deprecated, use ${now}`); }
  return process.env[old];
}

// ---------------------------------------------------------------- data directory
const DB_FILE = 'ember.db', LEGACY_DB_FILE = 'bonfire.db';

// ---------------------------------------------------------------- Nookara's old addresses (same identity provider)
const LEGACY_NOOKARA_ORIGINS = ['https://velora.ikelene.net', 'https://velora.ikelene.dev'];
const LEGACY_NOOKARA_HOSTS = LEGACY_NOOKARA_ORIGINS.map(o => new URL(o).hostname);

// ---------------------------------------------------------------- discovery + config
const WELL_KNOWN = '/.well-known/ember', LEGACY_WELL_KNOWN = '/.well-known/bonfire'; // both serve the discovery document
// TODO protocol v2: the `software` name clients and Nookara read in discovery / instance info
const SOFTWARE = 'bonfire-server';
// accounts_mode is "nookara" in config.json; "velora" is still read (and rewritten). On the wire (discovery, the admin
// settings, registration with Nookara) it is still "velora" until clients and Nookara learn the new value (TODO protocol v2).
const LEGACY_MODE = 'velora';
const readMode = v => (v === LEGACY_MODE ? 'nookara' : v);
const wireMode = v => (v === 'nookara' ? LEGACY_MODE : v);
// config.json keys renamed on load
const LEGACY_CONFIG_KEYS = { velora_url: 'nookara_url', velora_registration: 'nookara_registration' };
// a settings object (config.json or a settings PATCH) with the old keys / mode value renamed; a new key wins over its old one
function renameLegacySettings(p) {
  const q = { ...p };
  for (const [old, now] of Object.entries(LEGACY_CONFIG_KEYS)) if (old in q) { if (q[now] === undefined) q[now] = q[old]; delete q[old]; }
  if (q.accounts_mode !== undefined) q.accounts_mode = readMode(q.accounts_mode);
  return q;
}
// discovery / settings objects also carry these old field names next to the new ones (old clients read them)
const LEGACY_FIELD = { nookara: 'velora', nookara_url: 'velora_url', nookara_registration: 'velora_registration' };
const withLegacy = obj => { const out = { ...obj }; for (const [k, old] of Object.entries(LEGACY_FIELD)) if (k in obj) out[old] = obj[k]; return out; };

// ---------------------------------------------------------------- stored formats (left alone for now)
// users.kind of a Nookara account, also sent to clients as user.kind (TODO protocol v2)
const KIND_NOOKARA = 'velora';
// the wire name of a Nookara account id on user objects, clone-check, account profile sync and chat_profile_refresh (TODO protocol v2)
const NOOKARA_ID_FIELD = 'velora_id';
// export format: still written as bonfire-export-v1, always read
const EXPORT_FORMAT = 'bonfire-export-v1';
const EXPORT_FORMATS = [EXPORT_FORMAT];

// ---------------------------------------------------------------- calls to Nookara (not renamed on Nookara's side yet)
const NOOKARA_PATHS = {
  jwks: '/.well-known/bonfire/jwks.json',
  relay: '/bonfire/relay', // + /notify, /daily, /wake, /rtc, /directory, /identities, /notice, /pay-request, /bots/sync, /import/bundle
  challenge: '/bonfire/instances/challenge',
  register: '/bonfire/instances/register',
  profiles: '/bonfire/profiles',
  keys: '/bonfire/keys/kid/',
  latest: '/bonfire/server-latest.json',
};
const relayPath = sub => NOOKARA_PATHS.relay + sub;
// signed-request headers and signature contexts Nookara checks
const RELAY_HEADERS = { instance: 'X-Bonfire-Instance', ts: 'X-Bonfire-Ts', sig: 'X-Bonfire-Sig' };
const SIGN_CONTEXT = {
  register: 'bonfire-register-v1', // instance registration signature
  message: 'bonfire-msg-v1\n',      // signed chat messages (PROTOCOL §8)
  game: 'bonfire-gw-v1',            // Minecraft plugin identity proof (PROTOCOL §18)
};
// JWT types: written as the old ones; receipts are accepted under either name
const TYP = { owner: 'bonfire-owner+jwt', botAdd: 'bonfire-botadd+jwt', receipt: 'bonfire-receipt+jwt' };
const RECEIPT_TYPS = ['bonfire-receipt+jwt', 'ember-receipt+jwt'];

// ---------------------------------------------------------------- things clients and bots see (TODO protocol v2)
// HTTP routes: the new paths are canonical, the old ones keep working
const LEGACY_ROUTES = { authNookara: '/api/v1/auth/velora', importNookara: '/api/v1/import/velora', registerNookara: '/api/v1/instance/velora/register' };
// error codes clients branch on
const ERR = {
  unreachable: 'velora_unreachable', tooLarge: 'velora_response_too_large', badResponse: 'velora_bad_response',
  off: 'velora_off', notRegistered: 'velora_not_registered', required: 'velora_required', downloadFailed: 'velora_download_failed',
  ownerNotNookara: 'owner_not_velora', galleryNeedsAccount: 'gallery_needs_velora_account', badRegistration: 'invalid_velora_registration',
  status: s => `velora_${s}`,
};
// a managed instance's host, and the roles shop's payment provider, as clients read them
const WIRE_HOST = 'velora';
// the official apps' User-Agent markers (new and old builds)
const APP_UA = { desktop: /\b(?:Ember|Bonfire)Desktop\//, android: /\b(?:Ember|Bonfire)Android\// };
// Discord-dialect bot API: the avatar / icon placeholder hash and the extra fields bots read
const BOT_API = { avatar: 'bonfire', channelType: 'bonfire_type', extra: 'bonfire' };
// the Minecraft plugin's console command (`bonfire link CODE`, `bonfire server <url>`) and the source name its lines carry
const GAME_CMD = 'bonfire';

module.exports = {
  env, legacyName, LEGACY_NOOKARA_ORIGINS, LEGACY_NOOKARA_HOSTS, DB_FILE, LEGACY_DB_FILE, WELL_KNOWN, LEGACY_WELL_KNOWN, SOFTWARE, LEGACY_MODE, readMode, wireMode,
  LEGACY_CONFIG_KEYS, renameLegacySettings, LEGACY_FIELD, withLegacy, KIND_NOOKARA, NOOKARA_ID_FIELD, EXPORT_FORMAT, EXPORT_FORMATS,
  NOOKARA_PATHS, relayPath, RELAY_HEADERS, SIGN_CONTEXT, TYP, RECEIPT_TYPS, LEGACY_ROUTES, ERR, WIRE_HOST, APP_UA, BOT_API, GAME_CMD,
};
