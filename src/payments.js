'use strict';
// Paying with Nookara credits from an account that is not a Nookara account (PROTOCOL §19.0c).
// A Nookara account (v:) pays from itself. Anyone else links a Nookara account for payments first:
//   1. POST /api/v2/account/payments/link { return_to? } -> { url }: the address of Nookara's consent page for this account
//   2. the person signs in to Nookara there and agrees that this homeserver may ask their Nookara account to pay for this
//      account; Nookara records the link and sends the browser back to GET /account/payments/linked?state=&token=
//   3. the token (an EdDSA JWT from Nookara's IdP key, typ "ember-payment-link+jwt", aud = this homeserver, sub = the Nookara
//      user id, account = this account's id) is checked and the Nookara id kept on the account
// Pay requests for such an account name the account (`account`) next to the Nookara user id; Nookara takes them only while its
// side of the link exists. DELETE /api/v2/account/payments/link ends it here and tells Nookara.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const page = require('./login-page');
const { err, now } = require('./util');
const { relayPath } = require('./compat');

const TYP = 'ember-payment-link+jwt';
const TTL = 15 * 60 * 1000;
const client = () => require('./relay/client');
const people = () => require('./social/people');
const states = new Map(); // state -> { user_id, return_to, exp }

const accountId = u => people().fullId(u); // "l:5@b.example", "v:7@nookara.cc", a remote account's own id
// who pays for this account: its own Nookara id (a Nookara account) or the one it linked. -> { nookara_id, account? } | null
function payerOf(u) {
  if (!u) return null;
  if (u.nookara_id && u.kind !== 'remote') return { nookara_id: String(u.nookara_id) };
  if (u.payment_nookara_id) return { nookara_id: String(u.payment_nookara_id), account: accountId(u) };
  return null;
}
const linkUrl = () => `${config.publicUrl()}/api/v2/account/payments/link`;
const requireLink = () => err('nookara_link_required', 402, { link_url: linkUrl() });

function view(u) {
  const own = !!(u.nookara_id && u.kind !== 'remote');
  return { own_nookara_account: own, linked: !own && !!u.payment_nookara_id, nookara_id: own ? String(u.nookara_id) : u.payment_nookara_id || null, linked_at: u.payment_linked_at || null, available: client().registered() };
}
function cleanReturn(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let x; try { x = new URL(String(raw)); } catch { throw err('invalid_return_to'); }
  // only back to a client this homeserver lists (ember_clients: the admin's list, and the homeserver itself)
  if (x.username || x.password || String(raw).length > 2000 || !['https:', 'http:'].includes(x.protocol) || !config.get().ember_clients.includes(x.origin)) throw err('invalid_return_to');
  return String(raw);
}
// POST /api/v2/account/payments/link
function start(me, body = {}) {
  if (me.kind === 'bot') throw err('not_allowed', 403);
  if (me.nookara_id && me.kind !== 'remote') throw err('own_nookara_account', 400); // (they pay from it already)
  if (!client().registered()) throw err('payments_unavailable', 409);
  const back = cleanReturn(body.return_to);
  const t = now();
  for (const [k, v] of states) if (v.exp < t) states.delete(k);
  const state = crypto.randomBytes(24).toString('base64url');
  states.set(state, { user_id: me.id, return_to: back, exp: t + TTL });
  const handle = me.kind === 'remote' ? me.username : `${me.username}@${config.domain()}`;
  const q = new URLSearchParams({ instance: config.publicUrl(), account: accountId(me), handle, state, return_to: `${config.publicUrl()}/account/payments/linked` });
  return { url: `${String(config.get().nookara_url).replace(/\/+$/, '')}/ember/payments/link?${q}` };
}
// GET /account/payments/linked?state=&token= (the browser, back from Nookara)
async function finish(req, res) {
  const s = states.get(String(req.query.state || ''));
  states.delete(String(req.query.state || ''));
  const fail = text => page.send(res, 400, page.messagePage({ title: 'Linking did not work', text, bad: true }));
  if (!s || s.exp < now()) return fail('This link has expired. Start again from your account settings.');
  if (req.query.error) { // they said no on Nookara's page
    if (s.return_to) return page.redirect(res, s.return_to + (s.return_to.includes('?') ? '&' : '?') + 'payments_linked=0');
    return page.send(res, 200, page.messagePage({ title: 'Nothing was linked', text: 'You cancelled on Nookara. You can close this page.' }));
  }
  const u = auth.userById(s.user_id);
  if (!u) return fail('That account is gone.');
  let claims;
  try { claims = await auth.verifyNookaraJwt(String(req.query.token || ''), now(), { typ: TYP }); } catch (e) { return fail(`Nookara's answer could not be checked (${e.code || 'invalid_token'}).`); }
  if (claims.account !== accountId(u)) return fail('Nookara linked another account.');
  db.run('UPDATE users SET payment_nookara_id = ?, payment_linked_at = ? WHERE id = ?', String(claims.sub), now(), u.id);
  if (s.return_to) return page.redirect(res, s.return_to + (s.return_to.includes('?') ? '&' : '?') + 'payments_linked=1');
  page.send(res, 200, page.messagePage({ title: 'Nookara account linked', text: 'This account can now pay with the Nookara credits of the account you linked. You can close this page.' }));
}
// DELETE /api/v2/account/payments/link: here at once; Nookara is told (best effort: its side is checked on every pay request)
function unlink(me) {
  const u = auth.userById(me.id);
  if (!u.payment_nookara_id) throw err('not_linked', 404);
  db.run('UPDATE users SET payment_nookara_id = NULL, payment_linked_at = NULL WHERE id = ?', u.id);
  if (client().registered()) client().call('POST', relayPath('/payment-link/revoke'), { account: accountId(u), user_id: String(u.payment_nookara_id) }).catch(() => {});
  return view(auth.userById(u.id));
}

function register(app) {
  app.get('/api/v2/account/payments', req => view(auth.userById(req.user.id)));
  app.post('/api/v2/account/payments/link', req => start(req.user, req.body || {}));
  app.delete('/api/v2/account/payments/link', req => unlink(req.user));
  app.get('/account/payments/linked', { auth: false }, finish);
}

module.exports = { register, payerOf, requireLink, accountId, view, TYP, _test: { states } };
