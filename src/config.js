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
// client-neutral invite links (https://<domain>/i/<slug>/<code>): the "Open in" buttons of the invite page. In a url
// {address} is slug@domain, and {slug}, {domain} and {code} are what they say
const DEFAULT_INVITE_CLIENTS = [
  { name: 'Ember', url: 'https://nookara.cc/chat#/invite?u={url}' },
];
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

// a social API base: https (http with EMBER_DEV=1), no credentials, query or fragment, no trailing slash
function socialUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  let u; try { u = new URL(raw.trim()); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || raw.includes('?') || raw.includes('#')) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && devHttp())) return null;
  return u.href.replace(/\/+$/, '');
}

// an http(s) address an admin typed (a link on a page, never fetched): no credentials, at most n characters
function linkUrl(raw, n = 500) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > n) return null;
  let u; try { u = new URL(raw.trim()); } catch { return null; }
  return /^https?:$/.test(u.protocol) && !u.username && !u.password ? raw.trim() : null;
}
// invites: { url_base, clients: [{ name, url, icon_url? }] }; null (or a null key) = the default
function sanitizeInvites(v, bad) {
  if (v === null) return { url_base: null, clients: null };
  if (!v || typeof v !== 'object' || Array.isArray(v)) { bad('invalid_invites'); return {}; }
  const o = {};
  if (v.url_base === null || v.url_base === '') o.url_base = null;
  else if (v.url_base !== undefined) { const u = linkUrl(v.url_base); if (u && !/[?#]/.test(u)) o.url_base = u.endsWith('/') ? u : u + '/'; else bad('invalid_invites'); }
  if (v.clients === null) o.clients = null;
  else if (v.clients !== undefined) {
    const ok = Array.isArray(v.clients) && v.clients.length <= 12 && v.clients.every(c => c && typeof c === 'object' && typeof c.name === 'string' && c.name.trim() && c.name.trim().length <= 40
      && linkUrl(c.url) && (c.icon_url === undefined || c.icon_url === null || c.icon_url === '' || linkUrl(c.icon_url)));
    if (ok) o.clients = v.clients.map(c => ({ name: c.name.trim(), url: c.url.trim(), ...(c.icon_url ? { icon_url: c.icon_url.trim() } : {}) }));
    else bad('invalid_invites');
  }
  return o;
}

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
  if (p.push !== undefined) { // PROTOCOL §20: the gateway a pusher uses when its client names none
    const g = p.push && typeof p.push === 'object' ? p.push.default_gateway : undefined;
    let u = null; try { u = typeof g === 'string' ? new URL(g) : null; } catch { u = null; }
    if (g === null || g === '') out.push = { default_gateway: null };
    else if (u && !u.username && !u.password && g.length <= 500 && (u.protocol === 'https:' || (u.protocol === 'http:' && devHttp()))) out.push = { default_gateway: u.href };
    else bad('invalid_push');
  }
  if (p.bridges !== undefined) { // PROTOCOL §16: Discord sign-in for the ownership check, and how many gateway connections the Discord bot uses
    const v = p.bridges, b = {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) bad('invalid_bridges');
    else {
      if (v.discord_oauth === null) b.discord_oauth = null;
      else if (v.discord_oauth !== undefined) {
        const o = v.discord_oauth, ok = x => typeof x === 'string' && x.length <= 200 && !/\s/.test(x);
        if (o && typeof o === 'object' && ok(o.client_id) && o.client_id && (o.client_secret === undefined || ok(o.client_secret))) b.discord_oauth = { client_id: o.client_id, ...(o.client_secret ? { client_secret: o.client_secret } : {}) };
        else bad('invalid_bridges');
      }
      if (v.discord_shards !== undefined) { if (Number.isInteger(v.discord_shards) && v.discord_shards >= 1 && v.discord_shards <= 64) b.discord_shards = v.discord_shards; else bad('invalid_bridges'); }
      out.bridges = b;
    }
  }
  if (p.invites !== undefined) out.invites = sanitizeInvites(p.invites, bad);
  if (p.branding !== undefined) { // PROTOCOL §5e: the homeserver's look on its own pages (branding.js checks every value)
    try { out.branding = p.branding === null ? null : require('./branding').sanitize(p.branding); } catch (e) { if (!loose) throw e; }
  }
  if (p.limits !== undefined) out.limits = require('./limits').sanitize(p.limits, loose); // PROTOCOL §19: { defaults, tiers }
  if (p.federation !== undefined) out.federation = FS.sanitize(p.federation, { loose, allowHttp: devHttp() }); // PROTOCOL §4b
  if (p.social !== undefined) { // PROTOCOL §4c: where the social API of this homeserver's Nookara accounts is (nookara_identity); null = here
    const v = p.social, o = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of ['api_url', 's2s_url', 'reports_url']) { // (reports_url: where DM messages of those accounts are reported, PROTOCOL §4d.4)
        if (v[k] === undefined) continue;
        if (v[k] === null || v[k] === '') { o[k] = null; continue; }
        const u = socialUrl(v[k]);
        if (u) o[k] = u; else bad('invalid_social');
      }
      out.social = o;
    } else bad('invalid_social');
  }
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
  v.push = { default_gateway: data.push?.default_gateway || 'https://nookara.cc/_ember/push/v1/notify' };
  v.bridges = { discord_oauth: data.bridges?.discord_oauth || null, discord_shards: data.bridges?.discord_shards || 1 };
  v.limits = { defaults: data.limits?.defaults || {}, tiers: data.limits?.tiers || [] };
  v.invites = { url_base: data.invites?.url_base || null, clients: data.invites?.clients || DEFAULT_INVITE_CLIENTS };
  v.branding = data.branding || {};
  if (env('NOOKARA_URL')) v.nookara_url = normalizeOrigin(env('NOOKARA_URL')) || v.nookara_url;
  v.public_url = normalizeOrigin(env('PUBLIC_URL') || v.public_url || `http://localhost:${PORT}`);
  v.nookara_url = normalizeOrigin(v.nookara_url);
  if (!v.domain) { try { v.domain = new URL(v.public_url).hostname.toLowerCase(); } catch { v.domain = 'localhost'; } }
  // https://<domain>/i/ (the public url's own origin when it is the domain, so an http dev server links to itself)
  if (!v.invites.url_base) { let same = false; try { same = new URL(v.public_url).hostname.toLowerCase() === v.domain; } catch { /* no */ } v.invites.url_base = same ? v.public_url + '/i/' : `https://${v.domain}/i/`; }
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
  v.social = { api_url: data.social?.api_url || null, s2s_url: data.social?.s2s_url || null, reports_url: data.social?.reports_url || null };
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
// Nookara accounts are accounts of this homeserver (PROTOCOL §4a accounts.nookara_identity): only while it hosts accounts
const nookaraIdentity = () => { if (mode() !== 'local') return false; const v = get(); return AS.nookaraIdentity(v.accounts, v); };

function update(patch) {
  const clean = sanitize(patch || {});
  if (clean.voice) { // secrets are write-only: an empty/omitted secret keeps the old one
    const cur = data.voice || {};
    clean.voice = { ...cur, ...Object.fromEntries(Object.entries(clean.voice).filter(([k, v]) => v !== '' || !/secret|token/.test(k))) };
  }
  if (clean.youtube) clean.youtube = { ...(data.youtube || {}), ...clean.youtube };
  if (clean.creation) clean.creation = { ...(data.creation || {}), ...clean.creation };
  if (clean.bridges) { // (the secret is write-only: left out, the stored one stays)
    const cur = data.bridges || {}, o = clean.bridges.discord_oauth;
    if (o && !o.client_secret && cur.discord_oauth?.client_secret) o.client_secret = cur.discord_oauth.client_secret;
    clean.bridges = { ...cur, ...clean.bridges };
  }
  if (clean.limits) clean.limits = { ...(data.limits || {}), ...clean.limits };
  if (clean.invites) { clean.invites = { ...(data.invites || {}), ...clean.invites }; for (const k of ['url_base', 'clients']) if (clean.invites[k] === null) delete clean.invites[k]; }
  if (clean.federation) clean.federation = FS.merge(data.federation || {}, clean.federation);
  if (clean.social) clean.social = { ...(data.social || {}), ...clean.social };
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
    push: v.push, invites: v.invites,
    bridges: { discord_oauth: v.bridges.discord_oauth ? { client_id: v.bridges.discord_oauth.client_id, has_secret: !!v.bridges.discord_oauth.client_secret } : null, discord_shards: v.bridges.discord_shards },
    voice: { cf_app_id: v.voice.cf_app_id, has_app_secret: !!v.voice.cf_app_secret, cf_turn_key_id: v.voice.cf_turn_key_id, has_turn_token: !!v.voice.cf_turn_token },
  });
}
// what any connected client may see (instance_update)
function publicView() {
  const v = get();
  return { name: v.name, description: v.description, icon_url: v.icon_url, registration: v.registration, max_upload_mb: v.max_upload_mb, accounts_mode: wireMode(mode()) };
}
const voiceConfigured = () => { if (managed.active() && !managed.allows('custom_voice_keys')) return false; const v = get().voice; return !!(v.cf_app_id && v.cf_app_secret && v.cf_turn_key_id && v.cf_turn_token); };

module.exports = { init, get, mode, publicUrl, domain, nookaraIdentity, update, watch, unwatch, adminView, publicView, voiceConfigured, events, dir: () => DATA_DIR, port: () => PORT, setPort: p => { PORT = p; }, DEFAULTS, DEFAULT_INVITE_CLIENTS, envMode, devHttp, saved: () => AS.complete(data.accounts || {}), _test: { allowHttp(on) { allowHttp = !!on; } } };
