'use strict';
// DATA_DIR/config.json is the source of truth for instance settings; a few env vars override it.
const { ERR, env, LEGACY_CONFIG_KEYS, LEGACY_MODE, readMode, wireMode, withLegacy, renameLegacySettings } = require('./compat');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { err, normalizeOrigin } = require('./util');
const managed = require('./managed');
const AS = require('./account-settings');
const FS = require('./federation/settings');

const events = new EventEmitter();
let DATA_DIR = path.resolve(env('DATA') || './data');
let PORT = Number(process.env.PORT) || 4100;
let file = null;
let data = {};
let runningMode = null; // accounts_mode is fixed until restart
let watcher = null, lastWritten = null, debounce = null;

const DEFAULTS = {
  name: 'Ember Instance', description: '', icon_url: null, public_url: null,
  nookara_url: 'https://nookara.cc',
  max_upload_mb: 25, max_backups: 10,
  voice: { cf_app_id: '', cf_app_secret: '', cf_turn_key_id: '', cf_turn_token: '' },
  // optional "watch through the instance" YouTube player (needs yt-dlp); cache_dir '' = DATA_DIR/cache/yt
  youtube: { enabled: true, ytdlp_path: 'yt-dlp', cache_dir: '', cache_max_gb: 5 },
  // Nookara relays (PROTOCOL §12): 'auto' registers with nookara_url on boot; 'off' never contacts Nookara (no push / payments / daily / voice broker / directory)
  nookara_registration: 'auto', tags: [],
  // who may create servers here (PROTOCOL §5a): instance admins always may. per_account: how many one account may own (null = no cap)
  creation: { mode: 'admins', allowlist: [], per_account: null },
};
const CREATION_MODES = ['admins', 'allowlist', 'request', 'anyone'];
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function init({ dataDir, port } = {}) {
  if (dataDir) DATA_DIR = path.resolve(dataDir);
  if (port) PORT = port;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  file = path.join(DATA_DIR, 'config.json');
  data = {};
  reload(true);
  if (!fs.existsSync(file)) write();
  runningMode = get().accounts_mode;
}

function reload(quiet) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { if (e.code !== 'ENOENT' && !quiet) console.error('[config] could not read config.json:', e.message); }
  try { data = fromFile(sanitize(raw, true)); } catch (e) { console.error('[config] invalid config.json, keeping previous values:', e.message); return; }
  if (hasLegacy(raw)) { write(); console.log('[config] config.json: renamed the old velora settings to nookara'); }
  else if (Object.keys(raw).length && !raw.accounts) { write(); console.log('[config] config.json: accounts_mode became the accounts settings'); }
}

// old names in config.json or a settings PATCH: velora_url / velora_registration keys, accounts_mode "velora"
const hasLegacy = p => Object.keys(LEGACY_CONFIG_KEYS).some(k => k in p) || p.accounts_mode === LEGACY_MODE;

// what config.json holds -> the stored settings: the `accounts` block is the truth; a file from before it existed has
// accounts_mode + registration instead, which become the block. (Both keys are still written, derived, for older versions.)
function fromFile(clean) {
  const { accounts_mode, registration, accounts, ...rest } = clean;
  const url = normalizeOrigin(env('NOOKARA_URL') || rest.nookara_url || DEFAULTS.nookara_url);
  if (!accounts) return { ...rest, accounts: AS.migrate({ accounts_mode: accounts_mode || 'local', registration, nookara_url: url }) };
  // both are in the file and say different things: someone edited the old key by hand, so it is applied to the block
  let acc = AS.complete(accounts);
  if (accounts_mode && accounts_mode !== AS.modeOf(acc)) { acc = AS.withMode(acc, accounts_mode, url); console.log(`[config] config.json: accounts_mode "${accounts_mode}" applied to the accounts settings`); }
  if (registration && registration !== AS.legacyRegistration(acc)) acc = { ...acc, registration };
  return { ...rest, accounts: acc };
}
const devHttp = () => env('DEV') === '1' || allowHttp;
let allowHttp = false; // tests

// validate a (partial) settings object. loose = ignore unknown keys / bad values quietly (hand-edited file)
function sanitize(p, loose = false) {
  p = renameLegacySettings(p);
  const out = {};
  const bad = code => { if (!loose) throw err(code, 400); };
  const str = (k, n) => { if (p[k] !== undefined) { if (typeof p[k] === 'string' && p[k].length <= n) out[k] = p[k].trim(); else bad('invalid_' + k); } };
  str('name', 60); str('description', 300); // the homeserver's own name / description (a server has its own, PROTOCOL §5a)
  if (out.name === '') { delete out.name; bad('invalid_name'); }
  if (p.icon_url !== undefined) { if (p.icon_url === null || p.icon_url === '') out.icon_url = null; else if (typeof p.icon_url === 'string' && p.icon_url.length < 512) out.icon_url = p.icon_url; else bad('invalid_icon_url'); }
  for (const k of ['public_url', 'nookara_url']) {
    if (p[k] === undefined) continue;
    const o = typeof p[k] === 'string' ? normalizeOrigin(p[k]) : null;
    if (o) out[k] = o; else if (p[k] === null && k === 'public_url') out[k] = null; else bad('invalid_' + k);
  }
  if (p.accounts_mode !== undefined) { if (['nookara', 'local'].includes(p.accounts_mode)) out.accounts_mode = p.accounts_mode; else bad('invalid_accounts_mode'); }
  if (p.registration !== undefined) { if (['open', 'closed'].includes(p.registration)) out.registration = p.registration; else bad('invalid_registration'); }
  if (p.accounts !== undefined) out.accounts = AS.sanitize(p.accounts, { loose, allowHttp: devHttp() });
  if (p.ember_clients !== undefined) { const c = p.ember_clients === null ? null : AS.sanitizeClients(p.ember_clients); if (c || p.ember_clients === null) out.ember_clients = c; else bad('invalid_ember_clients'); }
  if (p.max_upload_mb !== undefined) { const n = Number(p.max_upload_mb); if (Number.isInteger(n) && n >= 1 && n <= 500) out.max_upload_mb = n; else bad('invalid_max_upload_mb'); }
  if (p.max_backups !== undefined) { if (Number.isInteger(p.max_backups) && p.max_backups >= 1 && p.max_backups <= 50) out.max_backups = p.max_backups; else bad('invalid_max_backups'); }
  if (p.voice !== undefined) {
    if (p.voice && typeof p.voice === 'object') {
      const v = {};
      for (const k of ['cf_app_id', 'cf_app_secret', 'cf_turn_key_id', 'cf_turn_token']) if (p.voice[k] !== undefined) { if (typeof p.voice[k] === 'string' && p.voice[k].length < 300) v[k] = p.voice[k].trim(); else bad('invalid_voice'); }
      out.voice = v;
    } else bad('invalid_voice');
  }
  if (p.youtube !== undefined) {
    if (p.youtube && typeof p.youtube === 'object') {
      const y = {}, v = p.youtube;
      if (v.enabled !== undefined) y.enabled = !!v.enabled;
      for (const k of ['ytdlp_path', 'cache_dir']) if (v[k] !== undefined) { if (typeof v[k] === 'string' && v[k].length < 300 && !v[k].includes('\0')) y[k] = v[k].trim(); else bad('invalid_youtube'); }
      if (v.cache_max_gb !== undefined) { const n = Number(v.cache_max_gb); if (Number.isFinite(n) && n >= 0.1 && n <= 10000) y.cache_max_gb = n; else bad('invalid_youtube'); }
      out.youtube = y;
    } else bad('invalid_youtube');
  }
  if (p.nookara_registration !== undefined) { if (['auto', 'off'].includes(p.nookara_registration)) out.nookara_registration = p.nookara_registration; else bad(ERR.badRegistration); }
  // (`listed` was the one community's directory switch: it is a server's own setting now, so the key is accepted and dropped)
  if (p.domain !== undefined) { // the homeserver's name in server addresses (slug@domain); null = the public url's hostname
    const d = typeof p.domain === 'string' ? p.domain.trim().toLowerCase() : null;
    if (p.domain === null || d === '') out.domain = null; else if (d && DOMAIN.test(d)) out.domain = d; else bad('invalid_domain');
  }
  if (p.federation !== undefined) out.federation = FS.sanitize(p.federation, { loose, allowHttp: devHttp() }); // PROTOCOL §4b
  if (p.creation !== undefined) {
    if (p.creation && typeof p.creation === 'object' && !Array.isArray(p.creation)) {
      const c = {}, v = p.creation;
      if (v.mode !== undefined) { if (CREATION_MODES.includes(v.mode)) c.mode = v.mode; else bad('invalid_creation'); }
      if (v.allowlist !== undefined) {
        if (Array.isArray(v.allowlist) && v.allowlist.length <= 1000 && v.allowlist.every(x => typeof x === 'string' && x.trim().length >= 1 && x.trim().length <= 64)) c.allowlist = [...new Set(v.allowlist.map(x => x.trim().toLowerCase()))];
        else bad('invalid_creation');
      }
      if (v.per_account !== undefined) { if (v.per_account === null || (Number.isInteger(v.per_account) && v.per_account >= 1 && v.per_account <= 1000)) c.per_account = v.per_account; else bad('invalid_creation'); }
      out.creation = c;
    } else bad('invalid_creation');
  }
  if (p.tags !== undefined) {
    const ok = Array.isArray(p.tags) && p.tags.length <= 8 && p.tags.every(t => typeof t === 'string' && t.trim().length >= 1 && t.trim().length <= 24 && !t.includes(','));
    if (ok) out.tags = [...new Set(p.tags.map(t => t.trim().toLowerCase()))]; else bad('invalid_tags');
  }
  return out;
}

// the effective settings: defaults < file < env. (Old community_creation / auto_join keys in config.json are ignored.)
function get() {
  const v = { ...DEFAULTS, ...data, voice: { ...DEFAULTS.voice, ...(data.voice || {}) }, youtube: { ...DEFAULTS.youtube, ...(data.youtube || {}) }, creation: { ...DEFAULTS.creation, ...(data.creation || {}) } };
  if (env('NOOKARA_URL')) v.nookara_url = normalizeOrigin(env('NOOKARA_URL')) || v.nookara_url;
  v.public_url = normalizeOrigin(env('PUBLIC_URL') || v.public_url || `http://localhost:${PORT}`);
  v.nookara_url = normalizeOrigin(v.nookara_url);
  if (!v.domain) { try { v.domain = new URL(v.public_url).hostname.toLowerCase(); } catch { v.domain = 'localhost'; } }
  if (['auto', 'off'].includes(env('NOOKARA_REGISTRATION'))) v.nookara_registration = env('NOOKARA_REGISTRATION');
  let forced = envMode();
  if (managed.active()) { // Nookara-hosted (PROTOCOL §19): sign-in and registration are fixed, uploads are capped by the plan
    forced = 'nookara'; v.nookara_registration = 'auto';
    const cap = managed.limit('max_upload_mb');
    if (cap !== null) v.max_upload_mb = cap;
  }
  // the accounts settings (PROTOCOL §4a); accounts_mode and registration are what older clients read, derived from them
  v.accounts = AS.complete(data.accounts || {});
  v.federation = FS.complete(data.federation);
  if (forced && AS.modeOf(v.accounts) !== forced) v.accounts = AS.withMode(v.accounts, forced, v.nookara_url);
  v.accounts_mode = AS.modeOf(v.accounts);
  v.registration = AS.legacyRegistration(v.accounts);
  // where an Ember client may live: the saved list (or the well-known ones) and always this server's own origin
  v.ember_clients = [...new Set([...(data.ember_clients || AS.DEFAULT_CLIENTS), v.public_url])];
  return v;
}
// EMBER_ACCOUNTS_MODE ("velora" still means nookara), or null
function envMode() { const m = readMode(env('ACCOUNTS_MODE')); return ['nookara', 'local'].includes(m) ? m : null; }
// the mode this process booted with (switching needs a restart)
const mode = () => runningMode || get().accounts_mode;
const publicUrl = () => get().public_url;
const domain = () => get().domain;

function update(patch) {
  const clean = sanitize(patch || {});
  if (clean.voice) { // secrets are write-only: an empty/omitted secret keeps the old one
    const cur = data.voice || {};
    clean.voice = { ...cur, ...Object.fromEntries(Object.entries(clean.voice).filter(([k, v]) => v !== '' || !/secret|token/.test(k))) };
  }
  if (clean.youtube) clean.youtube = { ...(data.youtube || {}), ...clean.youtube };
  if (clean.creation) clean.creation = { ...(data.creation || {}), ...clean.creation };
  if (clean.federation) clean.federation = FS.merge(data.federation || {}, clean.federation);
  // the old accounts_mode / registration settings edit the accounts block (a value that only repeats what the block already
  // says changes nothing: old admin pages send whole forms back)
  let acc = AS.complete(data.accounts || {});
  if (clean.accounts) acc = AS.merge(acc, clean.accounts);
  if (clean.accounts_mode !== undefined && clean.accounts_mode !== AS.modeOf(acc)) acc = AS.withMode(acc, clean.accounts_mode, get().nookara_url);
  if (clean.registration !== undefined && clean.registration !== AS.legacyRegistration(acc)) acc = { ...acc, registration: clean.registration };
  if (acc.hosts_accounts && !acc.login_methods.some(m => m.enabled)) throw err('no_login_method', 400);
  delete clean.accounts_mode; delete clean.registration;
  if (clean.ember_clients === null) { delete clean.ember_clients; delete data.ember_clients; }
  clean.accounts = acc;
  data = { ...data, ...clean };
  write();
  events.emit('change');
  return get();
}

function write() {
  const acc = AS.complete(data.accounts || {});
  const text = JSON.stringify({ ...data, accounts_mode: AS.modeOf(acc), registration: AS.legacyRegistration(acc), accounts: acc }, null, 2) + '\n';
  lastWritten = text;
  fs.writeFileSync(file + '.tmp', text, { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

function watch() {
  if (watcher) return;
  try {
    watcher = fs.watch(DATA_DIR, (ev, name) => {
      if (name !== 'config.json') return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
        if (text === lastWritten) return; // our own write
        lastWritten = text;
        reload();
        console.log('[config] config.json changed, reloaded');
        events.emit('change');
      }, 150);
    });
    watcher.on('error', () => {});
  } catch (e) { console.error('[config] cannot watch config.json:', e.message); }
}
function unwatch() { clearTimeout(debounce); watcher?.close(); watcher = null; }

// settings shown to admins (voice secrets are write-only)
function adminView() {
  const v = get();
  const saved = managed.active() ? 'nookara' : AS.modeOf(AS.complete(data.accounts || {}));
  // accounts_mode values go out under their old wire name (compat wireMode); the renamed keys also go out under the old names
  return withLegacy({
    name: v.name, description: v.description, icon_url: v.icon_url, public_url: v.public_url, domain: v.domain, creation: v.creation,
    accounts_mode: wireMode(saved), running_accounts_mode: wireMode(mode()), restart_required: saved !== mode(),
    accounts_mode_env: !!envMode(), // the env var wins over the saved setting
    nookara_url: v.nookara_url, registration: v.registration, max_upload_mb: v.max_upload_mb, max_backups: v.max_backups,
    youtube: v.youtube, nookara_registration: v.nookara_registration, tags: v.tags, ember_clients: v.ember_clients,
    voice: { cf_app_id: v.voice.cf_app_id, has_app_secret: !!v.voice.cf_app_secret, cf_turn_key_id: v.voice.cf_turn_key_id, has_turn_token: !!v.voice.cf_turn_token },
  });
}
// what any connected client may see (instance_update)
function publicView() {
  const v = get();
  return { name: v.name, description: v.description, icon_url: v.icon_url, registration: v.registration, max_upload_mb: v.max_upload_mb, accounts_mode: wireMode(mode()) };
}
const voiceConfigured = () => { if (!managed.allows('custom_voice_keys')) return false; const v = get().voice; return !!(v.cf_app_id && v.cf_app_secret && v.cf_turn_key_id && v.cf_turn_token); };

module.exports = { init, get, mode, publicUrl, domain, update, watch, unwatch, adminView, publicView, voiceConfigured, events, dir: () => DATA_DIR, port: () => PORT, setPort: p => { PORT = p; }, DEFAULTS, envMode, devHttp, saved: () => AS.complete(data.accounts || {}), _test: { allowHttp(on) { allowHttp = !!on; } } };
