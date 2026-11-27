'use strict';
// Build identity + live stats + "am I outdated?" (PROTOCOL §3 `build`, §5c `GET /api/v1/instance/info`).
// Where the identity comes from, first match wins:
//   env   BONFIRE_BUILD_* (Dockerfile ARG -> ENV, set by hostd/rebuild-image.sh and the release script)
//   git   the .git checkout this runs from (src/gitinfo.js: HEAD + commit date, read once at start = the code that is running)
//   file  build-info.json beside package.json (written by scripts/build-info.js, e.g. inside `docker build` from the .git it was given)
// Without any of them commit is null and no update check is made (update reason "no_build_identity").
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const config = require('./config');
const db = require('./db');

const startedAt = Date.now();
const ROOT = path.join(__dirname, '..');
let fileInfo = {};
try { fileInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'build-info.json'), 'utf8')); } catch { /* not built by the release script */ }
// the .git checkout is read once, at start: it describes the code this process loaded, even after a `git pull` on disk
const gitInfo = process.env.BONFIRE_BUILD_FROM_GIT === '0' ? null : require('./gitinfo').read(ROOT);
function current() {
  if (process.env.BONFIRE_BUILD_COMMIT) return { source: 'env', src: {} };
  if (gitInfo) return { source: 'git', src: { commit: gitInfo.commit, commit_date: gitInfo.commit_date, built_at: null, dirty: gitInfo.dirty === true, build_id: gitInfo.commit } };
  if (fileInfo.commit) return { source: 'file', src: fileInfo };
  return { source: null, src: {} };
}

function build() {
  const { source, src } = current();
  const pick = (envKey, key) => { const v = source === 'env' ? process.env[envKey] : src[key]; return v ? String(v) : null; };
  const commit = pick('BONFIRE_BUILD_COMMIT', 'commit');
  return {
    source, // env | git | file | null
    version: pkg.version,
    commit,
    commit_short: commit ? commit.slice(0, 7) : null,
    commit_date: pick('BONFIRE_BUILD_COMMIT_DATE', 'commit_date'), // ISO 8601, date of the commit
    built_at: pick('BONFIRE_BUILD_AT', 'built_at'),                // ISO 8601, when the image was built
    dirty: (pick('BONFIRE_BUILD_DIRTY', 'dirty') || '0') === '1' || src.dirty === true,
    build_id: pick('BONFIRE_BUILD_ID', 'build_id') || commit, // commit, + "+<treehash>" when built from uncommitted changes
  };
}

// How this server was installed, so Server info can say how to update it (the server never updates itself, except through hostd):
//   managed       Nookara-hosted: updated by Nookara
//   host_agent    BONFIRE_UPDATE_URL set: one-click update through bonfire-hostd
//   docker_image  a container from a published image (BONFIRE_IMAGE baked in by the release script): pull + recreate
//   docker_build  a container built from source (`docker build` / compose `build: .`): git pull + rebuild
//   git           `node src/index.js` from a git checkout: git pull + npm ci + restart
//   unknown       anything else (a tarball, a copy)
const inContainer = () => ['/.dockerenv', '/run/.containerenv'].some(f => { try { return fs.existsSync(f); } catch { return false; } }) || process.env.BONFIRE_CONTAINER === '1';
function install() {
  const b = current();
  let kind = 'unknown';
  if (require('./managed').active()) kind = 'managed';
  else if (require('./selfupdate').support().supported) kind = 'host_agent';
  else if (inContainer()) kind = process.env.BONFIRE_IMAGE ? 'docker_image' : 'docker_build';
  else if (b.source === 'git') kind = 'git';
  const out = { kind };
  if (kind === 'docker_image') out.image = String(process.env.BONFIRE_IMAGE).slice(0, 200);
  if (kind === 'git') { out.branch = gitInfo.branch; out.dirty = gitInfo.dirty; }
  return out;
}

// ---- live stats (cached 30 s: COUNT(*) over a big messages table is not free) ----
let statsCache = { at: 0, v: null };
function dbBytes() {
  let n = 0;
  for (const f of ['bonfire.db', 'bonfire.db-wal', 'bonfire.db-shm']) { try { n += fs.statSync(path.join(config.dir(), f)).size; } catch { /* absent */ } }
  return n;
}
function stats() {
  if (statsCache.v && Date.now() - statsCache.at < 30000) return { ...statsCache.v, bots: require('./managed').botCount() };
  const n = (sql) => db.get(sql)?.n || 0;
  const v = {
    members: n('SELECT COUNT(*) n FROM members'),
    channels: n('SELECT COUNT(*) n FROM channels'),
    messages: n('SELECT COUNT(*) n FROM messages'),
    upload_count: n('SELECT COUNT(*) n FROM uploads'),
    upload_bytes: n('SELECT COALESCE(SUM(size),0) n FROM uploads'),
    db_bytes: dbBytes(),
    bots: require('./managed').botCount(),
    emojis: n('SELECT COUNT(*) n FROM emojis'),
    sounds: n('SELECT COUNT(*) n FROM sounds'),
  };
  statsCache = { at: Date.now(), v };
  return v;
}
const runtime = () => ({ node: process.version, uptime_s: Math.round((Date.now() - startedAt) / 1000), started_at: new Date(startedAt).toISOString(), platform: process.platform });

// ---- update check against Nookara's published "latest" (cache 10 min, silent on failure) ----
// fresh = an admin pressed Refresh: ask again unless the last real check was under FRESH_MIN ago (so Refresh can't hammer Nookara)
const LATEST_URL = () => process.env.BONFIRE_LATEST_URL || 'https://nookara.cc/bonfire/server-latest.json';
const OK_TTL = 10 * 60 * 1000, FAIL_TTL = 5 * 60 * 1000, FRESH_MIN = 15 * 1000;
let latest = { at: 0, ttl: 0, v: null, pending: null };
let now = () => Date.now(); // (tests move the clock)
async function fetchLatest({ fresh = false } = {}) {
  if (process.env.BONFIRE_UPDATE_CHECK === '0') return null;
  if (latest.pending) return latest.pending;
  const age = now() - latest.at;
  if (latest.at && (fresh ? age < FRESH_MIN : age < latest.ttl)) return latest.v;
  latest.pending = (async () => {
    try {
      const r = await fetch(LATEST_URL(), { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('status');
      const j = await r.json();
      if (!j || typeof j !== 'object' || !j.commit) throw new Error('shape');
      const s = k => (typeof j[k] === 'string' ? j[k].slice(0, 80) : null);
      latest.v = { version: s('version'), commit: s('commit'), commit_short: s('commit_short') || (s('commit') || '').slice(0, 7) || null, commit_date: s('commit_date'), built_at: s('built_at'), build_id: s('build_id') || s('commit'), dirty: !!j.dirty, message: s('message') };
      latest.ttl = OK_TTL;
    } catch { latest.ttl = FAIL_TTL; /* keep the previous value, if any */ }
    latest.at = now();
    return latest.v;
  })();
  try { return await latest.pending; } finally { latest.pending = null; }
}
// { update: {outdated, latest, checked_at} | null, reason } - reason says why update is null:
//   no_build_identity  this server doesn't know which commit it runs (built without .git or build args)
//   check_disabled     BONFIRE_UPDATE_CHECK=0
//   unreachable        server-latest.json could not be fetched (and there is no earlier answer)
async function check({ fresh = false } = {}) {
  const me = build();
  if (process.env.BONFIRE_UPDATE_CHECK === '0') return { update: null, reason: 'check_disabled' };
  if (!me.build_id) return { update: null, reason: 'no_build_identity' };
  const l = await fetchLatest({ fresh });
  if (!l) return { update: null, reason: 'unreachable' };
  let outdated = l.build_id !== me.build_id && l.commit !== me.commit;
  // never nag a server that is ahead (a newer checkout, a fork): compare build times, else commit times
  if (outdated && l.built_at && me.built_at) outdated = Date.parse(l.built_at) > Date.parse(me.built_at);
  else if (outdated && l.commit_date && me.commit_date) outdated = Date.parse(l.commit_date) > Date.parse(me.commit_date);
  return { update: { outdated, latest: l, checked_at: new Date(latest.at).toISOString() }, reason: null };
}
// {outdated, latest, checked_at} or null when we cannot tell (see check() for why)
async function update(opts) { return (await check(opts)).update; }

module.exports = { build, stats, runtime, update, check, install, startedAt, root: ROOT, gitInfo: () => gitInfo, _resetLatest: () => { latest = { at: 0, ttl: 0, v: null, pending: null }; }, _setNow: f => { now = f || (() => Date.now()); } };
