'use strict';
// Ember Server Operator Terms: setup cannot finish without them, an instance set up earlier is never locked out,
// a Nookara-hosted server takes the host's acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
delete process.env.EMBER_ACCEPT_OPERATOR_TERMS; // helpers turned it on for the other tests; this file tests the real gate
const { startServer } = require('../src/index');
const terms = require('../src/operator-terms');
const db = require('../src/db');

const reg = async (base, n) => {
  const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' });
  return { ...r.body, a: api(base, r.body.session) };
};
const start = dir => startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
const dirs = [];
const mk = () => { const d = tmpDir(); dirs.push(d); return d; };
test.after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

test('setup cannot complete without accepting the operator terms', async () => {
  const dir = mk(), inst = await start(dir);
  try {
    const alice = await reg(inst.url, 'alice');
    const code = inst.setup.current();
    for (const body of [{ code }, { code, accept_operator_terms: false }, { code, accept_operator_terms: 'yes' }]) {
      const r = await alice.a.post('/api/v1/instance/claim', body);
      assert.equal(r.status, 400);
      assert.equal(JSON.stringify(r.body).includes('operator_terms_required'), true);
    }
    assert.equal((await api(inst.url).get('/.well-known/bonfire')).body.claimed, false);
    // a wrong code is still a wrong code, and nothing was recorded
    assert.equal((await alice.a.post('/api/v1/instance/claim', { code: 'AAAA-AAAA', accept_operator_terms: true })).status, 403);
    assert.equal(terms.accepted(), false);
    const ok = await alice.a.post('/api/v1/instance/claim', { code, accept_operator_terms: true });
    assert.equal(ok.status, 200);
    const v = (await alice.a.get('/api/v1/instance/operator-terms')).body;
    assert.equal(v.accepted, true);
    assert.equal(v.version, '1.0');
    assert.equal(v.url, 'https://nookara.cc/operator-terms');
    assert.equal(v.via, 'setup');
    assert.ok(Date.parse(v.accepted_at));
    assert.ok(v.accepted_by); // the claimer's principal
    assert.equal(terms.forRegistration().version, '1.0');
  } finally { await inst.close(); }
});

test('headless setup: BONFIRE_OWNER is ignored without the flag, and works with EMBER_ACCEPT_OPERATOR_TERMS=1', async () => {
  process.env.BONFIRE_OWNER = 'v:77';
  try {
    const a = await start(mk());
    try { assert.equal((await api(a.url).get('/.well-known/bonfire')).body.claimed, false); assert.ok(a.setup.current()); } finally { await a.close(); }
    process.env.EMBER_ACCEPT_OPERATOR_TERMS = '1';
    const b = await start(mk());
    try {
      assert.equal((await api(b.url).get('/.well-known/bonfire')).body.claimed, true);
      assert.equal(terms.view().via, 'headless');
      assert.equal(terms.view().accepted_by, 'env');
    } finally { await b.close(); }
  } finally { delete process.env.BONFIRE_OWNER; delete process.env.EMBER_ACCEPT_OPERATOR_TERMS; }
});

// an instance whose database predates the terms: claimed, no acceptance recorded
async function legacyInstance() {
  const dir = mk();
  process.env.EMBER_ACCEPT_OPERATOR_TERMS = '1';
  const first = await start(dir);
  const alice = await reg(first.url, 'alice');
  assert.equal((await alice.a.post('/api/v1/instance/claim', { code: first.setup.current() })).status, 200);
  db.metaDel('operator_terms');
  await first.close();
  delete process.env.EMBER_ACCEPT_OPERATOR_TERMS;
  return { inst: await start(dir), a: api(first.url, alice.session), session: alice.session };
}

test('an instance set up before the terms existed is not locked out: notice, chat works, accept needs the flag', async () => {
  const { inst, session } = await legacyInstance();
  try {
    const a = api(inst.url, session);
    assert.equal((await a.get('/api/v1/me')).body.instance_owner, true); // still signed in, still owner
    const v = (await a.get('/api/v1/instance/operator-terms')).body;
    assert.equal(v.accepted, false);
    assert.equal(v.notice, true);
    assert.equal((await a.get('/api/v1/instance/settings')).body.operator_terms.notice, true);
    assert.equal((await a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).status, 200); // chat is not blocked
    assert.equal(terms.forRegistration(), null);
    assert.equal((await a.post('/api/v1/instance/operator-terms/accept', {})).status, 400);
    const ok = await a.post('/api/v1/instance/operator-terms/accept', { accept_operator_terms: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.accepted, true);
    assert.equal(ok.body.notice, false);
    assert.equal(ok.body.via, 'dashboard');
  } finally { await inst.close(); }
});

test('dismissing the notice hides it without accepting', async () => {
  const { inst, session } = await legacyInstance();
  try {
    const a = api(inst.url, session);
    assert.equal((await a.get('/api/v1/instance/operator-terms')).body.notice, true);
    const d = (await a.post('/api/v1/instance/operator-terms/dismiss', {})).body;
    assert.equal(d.notice, false);
    assert.equal(d.accepted, false);
  } finally { await inst.close(); }
});

test('a Nookara-hosted server records the host acceptance and never shows the self-host prompt', async () => {
  Object.assign(process.env, { BONFIRE_MANAGED: '1', BONFIRE_PLAN: 'starter', BONFIRE_OWNER: 'v:9', BONFIRE_ACCOUNTS_MODE: 'velora', BONFIRE_OPERATOR_TERMS_AT: '2026-10-31T12:00:00.000Z', BONFIRE_OPERATOR_TERMS_BY: 'v:9' });
  const inst = await start(mk());
  try {
    assert.equal((await api(inst.url).get('/.well-known/bonfire')).body.claimed, true);
    const v = terms.view();
    assert.equal(v.accepted, true);
    assert.equal(v.via, 'hosted');
    assert.equal(v.accepted_at, '2026-10-31T12:00:00.000Z');
    assert.equal(v.accepted_by, 'v:9');
    assert.equal(v.notice, false);
  } finally {
    await inst.close();
    for (const k of ['BONFIRE_MANAGED', 'BONFIRE_PLAN', 'BONFIRE_OWNER', 'BONFIRE_OPERATOR_TERMS_AT', 'BONFIRE_OPERATOR_TERMS_BY']) delete process.env[k];
    process.env.BONFIRE_ACCOUNTS_MODE = 'local';
  }
});

test('a hosted server created before the host passed any terms env still counts as accepted (managed, no notice)', async () => {
  Object.assign(process.env, { BONFIRE_MANAGED: '1', BONFIRE_OWNER: 'v:9', BONFIRE_ACCOUNTS_MODE: 'velora' });
  const inst = await start(mk());
  try { assert.equal(terms.view().accepted, true); assert.equal(terms.view().notice, false); }
  finally { await inst.close(); for (const k of ['BONFIRE_MANAGED', 'BONFIRE_OWNER']) delete process.env[k]; process.env.BONFIRE_ACCOUNTS_MODE = 'local'; }
});
