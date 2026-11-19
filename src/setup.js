'use strict';
// First-boot claiming: setup code (Crockford base32 XXXX-XXXX) printed to stdout and DATA_DIR/setup-code.txt.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const terms = require('./operator-terms');
const { setupCode, normCode, safeEqual, log } = require('./util');

const file = () => path.join(config.dir(), 'setup-code.txt');
let code = null;

function boot() {
  code = null;
  terms.boot(); // hosted: Nookara's acceptance; headless: EMBER_ACCEPT_OPERATOR_TERMS
  const stranded = auth.ownerStranded(); // switched accounts mode: the owner's account can't sign in any more
  if (auth.claimed() && !stranded) { try { fs.unlinkSync(file()); } catch { /* none */ } return; }
  // BONFIRE_OWNER (a Velora account) claims the instance, or takes over from a stranded owner, only on Velora accounts:
  // on local accounts that owner could never sign in
  let pre = process.env.BONFIRE_OWNER;
  if (pre && config.mode() !== 'velora') { console.error(`[setup] ignoring BONFIRE_OWNER="${pre}": this instance uses local accounts, so claim it with the setup code`); pre = null; }
  if (pre && !terms.accepted()) {
    // headless setup must accept the Ember Server Operator Terms explicitly (--accept-operator-terms / EMBER_ACCEPT_OPERATOR_TERMS=1)
    console.error(`[setup] ignoring BONFIRE_OWNER="${pre}": accept the Ember Server Operator Terms (${terms.URL}) with --accept-operator-terms or EMBER_ACCEPT_OPERATOR_TERMS=1, or claim with the setup code and tick the box`);
  } else if (pre) {
    const m = /^v:([1-9]\d{0,19})$/.exec(pre.trim());
    if (m) {
      const u = auth.ensureVeloraPlaceholder(m[1]);
      takeOver(u);
      log(`[setup] instance claimed by ${pre} (BONFIRE_OWNER)`);
      try { fs.unlinkSync(file()); } catch { /* none */ }
      return;
    }
    console.error(`[setup] ignoring BONFIRE_OWNER="${pre}" (expected v:<velora user id>)`);
  }
  code = savedCode();
  log('');
  if (stranded) {
    const o = auth.ownerRow();
    log(`  This instance's owner (${o.principal} ${o.username}) is a ${o.kind === 'local' ? 'local' : 'Velora'} account, which can't sign in with ${config.mode() === 'local' ? 'local' : 'Velora'} accounts.`);
    log('  Log in, then claim it with the setup code to become the owner (the community comes with it):');
  } else log('  This instance is not claimed yet. Log in, then claim it with the setup code:');
  log(`      ${code}`);
  log(`  (also in ${file()})`);
  log('');
}
// the code in setup-code.txt, made when there is none (boot reads the same file, so a code handed out before a restart still works after it)
function savedCode() {
  let c = null;
  try { c = fs.readFileSync(file(), 'utf8').trim(); } catch { /* none yet */ }
  if (!/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(c || '')) {
    c = setupCode();
    fs.writeFileSync(file(), c + '\n', { mode: 0o600 });
  }
  return c;
}
const current = () => code;
const check = given => !!code && safeEqual(normCode(given), normCode(code));
// the new owner gets the instance and every community the old owner had, and is a member of them
function takeOver(user) {
  if (!auth.setOwner(user.id)) return;
  const C = require('./communities');
  for (const c of db.all('SELECT * FROM communities WHERE owner_id = ?', user.id)) C.addMember(c, user.id, { quiet: false });
}
function claim(user) {
  takeOver(user);
  code = null;
  try { fs.unlinkSync(file()); } catch { /* gone */ }
  log(`[setup] instance claimed by ${user.principal} (${user.username})`);
}
// the owner switching accounts mode in the settings: their own account won't sign in after the restart, so they get the
// code now and claim the instance again with an account of the new kind
const handoverCode = () => savedCode();
module.exports = { boot, current, check, claim, handoverCode };
