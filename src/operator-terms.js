'use strict';
// Ember Server Operator Terms: whoever sets up or hosts an Ember server accepts them once.
// The acceptance lives in the instance database (meta key `operator_terms`): { version, accepted_at, accepted_by, via }.
//   - self-hosted, first run: the claim (setup) is refused until the claimer accepts (checkbox in the client, or the env var / --accept-operator-terms headless)
//   - self-hosted, already set up: never locked out. Admins see a notice (settings.operator_terms.notice) until they accept or dismiss it
//   - Nookara-hosted (BONFIRE_MANAGED=1): Nookara collected the acceptance when the server was created, so it is recorded from the host's env
//     (BONFIRE_OPERATOR_TERMS_VERSION / _AT / _BY) and the self-host prompt never shows
const db = require('./db');
const config = require('./config');
const managed = require('./managed');
const { err, log } = require('./util');

const VERSION = '1.0';
const URL = 'https://nookara.cc/operator-terms';
const KEY = 'operator_terms', DISMISS_KEY = 'operator_terms_dismissed';

function read() {
  try { const v = JSON.parse(db.metaGet(KEY) || 'null'); return v && typeof v === 'object' && typeof v.version === 'string' ? v : null; } catch { return null; }
}
// accepted the current version?
const accepted = () => read()?.version === VERSION;
const envAccepted = () => ['1', 'true', 'yes'].includes(String(process.env.EMBER_ACCEPT_OPERATOR_TERMS || '').toLowerCase());

function record(by, via, at) {
  const v = { version: VERSION, accepted_at: at || new Date().toISOString(), accepted_by: by, via };
  db.metaSet(KEY, JSON.stringify(v));
  db.metaDel(DISMISS_KEY);
  config.events.emit('change'); // registration carries the acceptance: re-register
  return v;
}

// at boot: a hosted server takes the host's acceptance, a headless setup takes the env var (both only when nothing is recorded yet)
function boot() {
  if (accepted()) return;
  if (managed.active()) {
    const at = Date.parse(process.env.BONFIRE_OPERATOR_TERMS_AT || '');
    record(String(process.env.BONFIRE_OPERATOR_TERMS_BY || 'nookara-hosting').slice(0, 80), 'hosted', Number.isFinite(at) ? new Date(at).toISOString() : undefined);
    log(`[operator-terms] hosted server: acceptance of v${VERSION} recorded from Nookara hosting`);
  } else if (envAccepted()) {
    record('env', 'headless');
    log(`[operator-terms] Ember Server Operator Terms v${VERSION} accepted via EMBER_ACCEPT_OPERATOR_TERMS`);
  }
}

// POST /instance/claim: setup cannot finish without it (already accepted at boot counts)
function requireForSetup(body, user) {
  if (accepted()) return;
  if (body?.accept_operator_terms !== true) throw err('operator_terms_required', 400, { version: VERSION, url: URL });
  record(user.principal, 'setup');
}
// an operator of an instance that was set up before the terms existed accepts from the dashboard notice
function acceptLater(user) {
  if (!accepted()) record(user.principal, 'dashboard');
  return view();
}
function dismiss() { if (!accepted()) db.metaSet(DISMISS_KEY, new Date().toISOString()); return view(); }

// what the settings / dashboard show; `notice` = an admin should be shown the one-time banner
function view() {
  const a = read(), ok = a?.version === VERSION;
  return {
    version: VERSION, url: URL, accepted: ok,
    accepted_at: ok ? a.accepted_at : null, accepted_by: ok ? a.accepted_by : null, via: ok ? a.via : null,
    notice: !ok && !managed.active() && !!db.metaGet('owner_user_id') && !db.metaGet(DISMISS_KEY),
  };
}
// the slice sent to Nookara at registration (null while not accepted)
function forRegistration() { const a = read(); return a?.version === VERSION ? { version: a.version, accepted_at: a.accepted_at } : null; }

module.exports = { VERSION, URL, accepted, boot, requireForSetup, acceptLater, dismiss, view, forRegistration };
