'use strict';
// Build identity straight from a git checkout, without needing the git binary: HEAD -> ref -> commit object (loose or packed,
// deltas included) -> committer date. Used by src/version.js for plain `git clone` installs and by scripts/build-info.js inside
// `docker build` (the slim image has no git). The git binary, when there is one, only adds "are there local changes?".
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const HEX40 = /^[0-9a-f]{40}$/;

// the .git directory of `root` (a ".git" file = worktree / submodule: "gitdir: <path>"), plus the common dir that holds objects + refs
function gitDirs(root) {
  const dotgit = path.join(root, '.git');
  let st; try { st = fs.statSync(dotgit); } catch { return null; }
  let gitDir = dotgit;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
    if (!m) return null;
    gitDir = path.resolve(root, m[1].trim());
  }
  let common = gitDir;
  try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
  return { gitDir, common };
}

function resolveRef(dirs, ref, depth = 0) {
  if (depth > 5) return null;
  for (const d of [dirs.gitDir, dirs.common]) {
    try {
      const v = fs.readFileSync(path.join(d, ref), 'utf8').trim();
      if (v.startsWith('ref: ')) return resolveRef(dirs, v.slice(5).trim(), depth + 1);
      if (HEX40.test(v)) return v;
    } catch { /* not a loose ref here */ }
  }
  try {
    for (const line of fs.readFileSync(path.join(dirs.common, 'packed-refs'), 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && HEX40.test(sha)) return sha;
    }
  } catch { /* no packed refs */ }
  return null;
}

function head(dirs) {
  let v; try { v = fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf8').trim(); } catch { return { sha: null, branch: null }; }
  if (HEX40.test(v)) return { sha: v, branch: null }; // detached
  if (!v.startsWith('ref: ')) return { sha: null, branch: null };
  const ref = v.slice(5).trim();
  return { sha: resolveRef(dirs, ref), branch: ref.replace(/^refs\/heads\//, '') };
}

// ---- object store ----
const TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs_delta', 7: 'ref_delta' };
function inflate(buf) { return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }

function readLoose(common, sha) {
  let raw; try { raw = fs.readFileSync(path.join(common, 'objects', sha.slice(0, 2), sha.slice(2))); } catch { return null; }
  const buf = inflate(raw), nul = buf.indexOf(0);
  return { type: buf.subarray(0, nul).toString().split(' ')[0], data: buf.subarray(nul + 1) };
}

function idxOffset(idxPath, sha) {
  const idx = fs.readFileSync(idxPath);
  if (idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) return null; // only v2 indexes (git >= 1.5.2)
  const want = Buffer.from(sha, 'hex'), first = want[0];
  const fan = i => idx.readUInt32BE(8 + i * 4);
  const n = fan(255), shas = 8 + 256 * 4;
  let lo = first ? fan(first - 1) : 0, hi = fan(first) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, c = want.compare(idx, shas + mid * 20, shas + mid * 20 + 20);
    if (c === 0) {
      const offs = shas + n * 20 + n * 4;
      const o = idx.readUInt32BE(offs + mid * 4);
      if (!(o & 0x80000000)) return o;
      return Number(idx.readBigUInt64BE(offs + n * 4 + (o & 0x7fffffff) * 8));
    }
    if (c > 0) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

function readAt(fd, pos, len) { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n); }

function packEntry(common, fd, pos, depth) {
  if (depth > 50) throw new Error('delta chain too deep');
  const hdr = readAt(fd, pos, 32);
  let i = 0, c = hdr[i++];
  const type = (c >> 4) & 7;
  let size = c & 15, shift = 4;
  while (c & 0x80) { c = hdr[i++]; size += (c & 0x7f) * 2 ** shift; shift += 7; }
  let base = null;
  if (type === 6) {
    c = hdr[i++]; let off = c & 0x7f;
    while (c & 0x80) { c = hdr[i++]; off = ((off + 1) * 128) + (c & 0x7f); }
    base = packEntry(common, fd, pos - off, depth + 1);
  } else if (type === 7) {
    base = readObject(common, hdr.subarray(i, i + 20).toString('hex'), depth + 1); i += 20;
  }
  // the compressed length is not stored: read generously and grow until the stream inflates
  for (let len = Math.max(4096, size * 2 + 256); ; len *= 4) {
    const chunk = readAt(fd, pos + i, len);
    let data;
    try { data = inflate(chunk); } catch (e) { if (chunk.length < len) throw e; continue; }
    if (data.length < size && chunk.length === len) continue;
    data = data.subarray(0, size);
    if (base) return { type: base.type, data: applyDelta(base.data, data) };
    return { type: TYPES[type], data };
  }
}

function applyDelta(src, delta) {
  let i = 0;
  const varint = () => { let v = 0, s = 0, c; do { c = delta[i++]; v += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80); return v; };
  varint(); // source size
  const out = Buffer.alloc(varint());
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0, len = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) off += delta[i++] * 2 ** (8 * b);
      for (let b = 0; b < 3; b++) if (op & (0x10 << b)) len += delta[i++] * 2 ** (8 * b);
      if (len === 0) len = 0x10000;
      o += src.copy(out, o, off, off + len);
    } else if (op) { o += delta.copy(out, o, i, i + op); i += op; } else throw new Error('bad delta');
  }
  return out;
}

function readObject(common, sha, depth = 0) {
  const loose = readLoose(common, sha);
  if (loose) return loose;
  const packDir = path.join(common, 'objects', 'pack');
  let files = []; try { files = fs.readdirSync(packDir).filter(f => f.endsWith('.idx')); } catch { /* no packs */ }
  for (const f of files) {
    const off = idxOffset(path.join(packDir, f), sha);
    if (off == null) continue;
    const fd = fs.openSync(path.join(packDir, f.replace(/\.idx$/, '.pack')), 'r');
    try { return packEntry(common, fd, off, depth); } finally { fs.closeSync(fd); }
  }
  return null;
}

function commitInfo(common, sha) {
  const o = readObject(common, sha);
  if (!o || o.type !== 'commit') return null;
  const text = o.data.toString('utf8');
  const m = /^committer .* (\d+) ([+-])(\d\d)(\d\d)$/m.exec(text);
  let date = null;
  if (m) {
    // ISO 8601 in the committer's own offset, like `git log --format=%cI`
    const offMin = (m[2] === '-' ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
    date = new Date(Number(m[1]) * 1000 + offMin * 60000).toISOString().replace(/\.000Z$/, offMin === 0 && m[2] === '+' ? 'Z' : `${m[2]}${m[3]}:${m[4]}`);
  }
  const body = text.slice(text.indexOf('\n\n') + 2);
  return { date, message: body.split('\n')[0].slice(0, 190) };
}

// uncommitted changes to the files that make up the server (needs the git binary; null = can't tell)
function dirtyState(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no', '--', 'src', 'package.json', 'package-lock.json'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.trim().length > 0;
  } catch { return null; }
}

// { commit, commit_date, branch, message, dirty } for the checkout at root, or null when root is not one
function read(root, { dirty = true } = {}) {
  try {
    const dirs = gitDirs(root);
    if (!dirs) return null;
    const h = head(dirs);
    if (!h.sha) return null;
    let c = null; try { c = commitInfo(dirs.common, h.sha); } catch { /* unreadable object: still know the commit */ }
    return { commit: h.sha, commit_date: c?.date || null, message: c?.message || null, branch: h.branch, dirty: dirty ? dirtyState(root) : null, git_dir: dirs.gitDir };
  } catch { return null; }
}

module.exports = { read, _applyDelta: applyDelta };
