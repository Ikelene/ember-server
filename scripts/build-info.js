#!/usr/bin/env node
'use strict';
// Print this server's build identity as JSON (the shape of build-info.json / src/version.js build()). Run from anywhere:
//   node scripts/build-info.js > build-info.json
// BONFIRE_BUILD_* in the environment win (the release script and hostd pass them as docker build args); otherwise the .git
// checkout this file lives in is read with src/gitinfo.js (no git binary needed, so it works inside `docker build`).
// Prints {} when neither is there (a source tarball): the server then reports "no_build_identity".
const path = require('path');
const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const e = process.env;
let out = {};
if (e.BONFIRE_BUILD_COMMIT) {
  out = { commit: e.BONFIRE_BUILD_COMMIT, commit_date: e.BONFIRE_BUILD_COMMIT_DATE || null, built_at: e.BONFIRE_BUILD_AT || new Date().toISOString(), dirty: e.BONFIRE_BUILD_DIRTY === '1', build_id: e.BONFIRE_BUILD_ID || e.BONFIRE_BUILD_COMMIT };
} else {
  const g = require(path.join(root, 'src', 'gitinfo.js')).read(root);
  if (g) out = { commit: g.commit, commit_date: g.commit_date, built_at: new Date().toISOString(), dirty: g.dirty === true, build_id: g.commit, message: g.message, branch: g.branch };
}
if (out.commit) out = { version: pkg.version, commit_short: out.commit.slice(0, 7), ...out };
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
