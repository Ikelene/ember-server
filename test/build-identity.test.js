'use strict';
// Build identity without build args: src/gitinfo.js reads a checkout's .git (loose + packed objects, worktrees) without the git binary,
// a git checkout reports source "git" and is compared by commit date, and admins are told how the server was installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_PUBLIC_URL = 'http://chat.test';
process.env.BONFIRE_VELORA_URL = 'http://velora.test';
process.env.BONFIRE_OWNER = 'v:100';
for (const k of ['BONFIRE_MANAGED', 'BONFIRE_UPDATE_CHECK', 'BONFIRE_UPDATE_URL', 'BONFIRE_UPDATE_SECRET', 'BONFIRE_BUILD_COMMIT', 'BONFIRE_BUILD_ID', 'BONFIRE_BUILD_AT', 'BONFIRE_BUILD_COMMIT_DATE', 'BONFIRE_BUILD_FROM_GIT', 'BONFIRE_IMAGE', 'BONFIRE_CONTAINER']) delete process.env[k];
const gitinfo = require('../src/gitinfo');
const { tmpDir, api, fakeIdp } = require('./helpers');

const ROOT = path.join(__dirname, '..');
let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: GIT_ENV }).trim();
const repoHere = !!gitinfo.read(ROOT);

test('applyDelta: copy + insert instructions', () => {
  const src = Buffer.from('hello world');
  // source size 11, target size 11: copy "hello " (offset 0, length 6), then insert "there"
  const delta = Buffer.from([11, 11, 0x80 | 0x10, 6, 5, ...Buffer.from('there')]);
  assert.equal(gitinfo._applyDelta(src, delta).toString(), 'hello there');
});

test('reads HEAD, branch and commit date from loose objects, packs and worktrees', { skip: !hasGit && 'no git binary' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-gitinfo-'));
  const wt = d + '-wt';
  try {
    git(d, 'init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(d, 'src'));
    fs.writeFileSync(path.join(d, 'src', 'a.js'), 'x'.repeat(5000));
    for (let i = 0; i < 5; i++) {
      fs.appendFileSync(path.join(d, 'src', 'a.js'), `line ${i}\n`);
      git(d, 'add', '-A');
      execFileSync('git', ['-C', d, 'commit', '-q', '-m', `commit ${i}`], { stdio: 'ignore', env: { ...GIT_ENV, GIT_COMMITTER_DATE: `2026-11-2${i}T10:00:00-06:00` } });
    }
    const head = git(d, 'rev-parse', 'HEAD'), date = git(d, 'log', '-1', '--format=%cI');
    let r = gitinfo.read(d);
    assert.equal(r.commit, head); assert.equal(r.commit_date, date); assert.equal(r.branch, 'main'); assert.equal(r.message, 'commit 4'); assert.equal(r.dirty, false);
    git(d, 'gc', '-q', '--aggressive'); // everything into a pack, refs into packed-refs
    assert.equal(fs.existsSync(path.join(d, '.git', 'refs', 'heads', 'main')), false);
    r = gitinfo.read(d);
    assert.equal(r.commit, head); assert.equal(r.commit_date, date);
    fs.appendFileSync(path.join(d, 'src', 'a.js'), 'local change\n');
    assert.equal(gitinfo.read(d).dirty, true);
    git(d, 'checkout', '-q', '--', 'src');
    git(d, 'checkout', '-q', '--detach', 'HEAD~2');
    r = gitinfo.read(d);
    assert.equal(r.commit, git(d, 'rev-parse', 'HEAD')); assert.equal(r.branch, null); assert.equal(r.commit_date, '2026-11-22T10:00:00-06:00');
    git(d, 'checkout', '-q', 'main');
    git(d, 'worktree', 'add', '-q', '--detach', wt, 'HEAD~1');
    assert.equal(gitinfo.read(wt).commit, git(wt, 'rev-parse', 'HEAD'));
  } finally { fs.rmSync(wt, { recursive: true, force: true }); fs.rmSync(d, { recursive: true, force: true }); }
  assert.equal(gitinfo.read(os.tmpdir()), null, 'not a checkout');
});

test('scripts/build-info.js: build args win, else the .git checkout', () => {
  const run = env => JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-info.js')], { encoding: 'utf8', env: { ...process.env, ...env } }));
  const a = run({ BONFIRE_BUILD_COMMIT: 'c'.repeat(40), BONFIRE_BUILD_AT: '2026-11-26T00:00:00Z' });
  assert.equal(a.commit, 'c'.repeat(40)); assert.equal(a.build_id, 'c'.repeat(40)); assert.equal(a.commit_short, 'ccccccc'); assert.equal(a.built_at, '2026-11-26T00:00:00Z');
  if (repoHere) { const b = run({}); assert.match(b.commit, /^[0-9a-f]{40}$/); assert.ok(b.commit_date); assert.ok(b.built_at); }
});

test('a git checkout knows its commit, is compared by commit date, and admins see install + reason', { skip: !repoHere && 'not running from a git checkout' }, async () => {
  const V = require('../src/version');
  const me = gitinfo.read(ROOT);
  let latest = null, up = true;
  const nook = http.createServer((req, res) => {
    if (!up) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(latest));
  });
  await new Promise(r => nook.listen(0, '127.0.0.1', r));
  process.env.BONFIRE_LATEST_URL = `http://127.0.0.1:${nook.address().port}/x.json`;
  let clock = 2e12;
  V._setNow(() => clock); V._resetLatest();
  const { startServer } = require('../src/index');
  const auth = require('../src/auth');
  const dir = tmpDir(), idp = fakeIdp({ iss: 'http://velora.test', aud: 'http://chat.test' });
  const inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
  auth.setJwksFetcher(idp.jwks);
  try {
    const r = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '100', username: 'owner' }) });
    const owner = api(inst.url, r.body.session);
    const info = async () => { clock += 20 * 60 * 1000; return (await owner.get('/api/v1/instance/info?refresh=1')).body; };

    up = false;
    let i = await info();
    assert.equal(i.build.source, 'git'); assert.equal(i.build.commit, me.commit); assert.equal(i.build.commit_date, me.commit_date);
    assert.equal(i.update, null); assert.equal(i.update_reason, 'unreachable');
    assert.equal(i.install.kind, fs.existsSync('/.dockerenv') ? 'docker_build' : 'git');
    up = true;

    const day = 86400000;
    latest = { commit: 'd'.repeat(40), commit_date: new Date(Date.parse(me.commit_date) + day).toISOString(), built_at: new Date().toISOString() };
    i = await info();
    assert.equal(i.update.outdated, true, 'a newer release'); assert.equal(i.update_reason, undefined);
    latest = { ...latest, commit_date: new Date(Date.parse(me.commit_date) - day).toISOString() };
    assert.equal((await info()).update.outdated, false, 'this checkout is ahead of the release: no nagging');
    latest = { commit: me.commit, commit_date: me.commit_date, built_at: new Date().toISOString(), build_id: me.commit + '+abcd1234' };
    assert.equal((await info()).update.outdated, false, 'the same commit, built elsewhere');
    // an old commit built today (a self-built image's built_at) is still behind a newer release built earlier
    process.env.BONFIRE_BUILD_COMMIT = 'e'.repeat(40); process.env.BONFIRE_BUILD_COMMIT_DATE = '2026-01-01T00:00:00Z'; process.env.BONFIRE_BUILD_AT = new Date(Date.now() + day).toISOString();
    latest = { commit: 'f'.repeat(40), commit_date: '2026-02-01T00:00:00Z', built_at: new Date().toISOString() };
    assert.equal((await info()).update.outdated, true, 'commit dates beat build times');
    for (const k of ['BONFIRE_BUILD_COMMIT', 'BONFIRE_BUILD_COMMIT_DATE', 'BONFIRE_BUILD_AT']) delete process.env[k];

    process.env.BONFIRE_CONTAINER = '1';
    assert.equal((await info()).install.kind, 'docker_build');
    process.env.BONFIRE_IMAGE = 'ghcr.io/ikelene/ember-server';
    i = await info();
    assert.equal(i.install.kind, 'docker_image'); assert.equal(i.install.image, 'ghcr.io/ikelene/ember-server');
    delete process.env.BONFIRE_CONTAINER; delete process.env.BONFIRE_IMAGE;

    process.env.BONFIRE_UPDATE_CHECK = '0';
    i = await info();
    assert.equal(i.update, null); assert.equal(i.update_reason, 'check_disabled');
    delete process.env.BONFIRE_UPDATE_CHECK;

    const pub = (await api(inst.url).get('/api/v1/instance/info')).body;
    assert.equal(pub.install, undefined, 'install is admin-only'); assert.equal(pub.update_reason, undefined);
  } finally {
    V._setNow(null); delete process.env.BONFIRE_LATEST_URL;
    await inst.close(); await new Promise(r => nook.close(r)); fs.rmSync(dir, { recursive: true, force: true });
  }
});
