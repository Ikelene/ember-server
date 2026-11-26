'use strict';
// External bridges: Discord / Fluxer (bridge.js), Matrix (matrix.js, through bridge.js) and CloudLink (cloudlink.js). index.js calls init() at boot and
// register(app) for the routes (PROTOCOL §16, §17); communities.channelView reads channelTag().
const bridge = require('./bridge');
const cloudlink = require('./cloudlink');
const store = require('./store');
const managed = require('../managed');
const L = require('../limits');

// a managed plan without bridges (PROTOCOL §19): nothing connects and every route is refused
const allOff = () => managed.active() && !L.defaults().bridges.length;
// which platforms a server may bridge to is one of its limits
const allowed = (platform, sid) => { if (platform) L.assertBridge(platform, require('../communities').pickCommunity(sid)?.id ?? null); };

function init() {
  store.ensure();
  if (allOff()) return;
  bridge.init();
  cloudlink.init();
}
function shutdown() {
  bridge.shutdown();
  cloudlink.shutdown();
}

function register(real) {
  const v1 = p => '/api/v1' + p;
  const s = v => String(v ?? '');
  // Every bridge route answers 403 plan_feature { what: 'bridges' } while the plan has none; linking checks the server's own list.
  const gated = fn => (req, res) => { if (allOff()) throw L.planFeature('bridges'); return fn(req, res); };
  const app = {};
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) app[m] = (p, o, f) => (typeof o === 'function' ? real[m](p, gated(o)) : real[m](p, o, gated(f)));

  // ---- a Matrix space as this instance's community (PROTOCOL §16.6): instance admins, only while there is no community.
  // Not behind the bridges plan: copying a space is not a bridge (only its "bridge it" switch is)
  const imp = require('./matrix-import');
  real.get(v1('/import/matrix'), { admin: true }, req => imp.view(req.user));
  real.put(v1('/import/matrix/bot'), { admin: true }, req => imp.setBot(req.user, req.body || {}));
  real.delete(v1('/import/matrix/bot'), { admin: true }, req => imp.dropBot(req.user));
  real.get(v1('/import/matrix/guilds'), { admin: true }, req => imp.guilds(req.user, req.query.fresh === '1'));
  real.get(v1('/import/matrix/guilds/:gid'), { admin: true }, req => imp.preview(req.user, req.params.gid));
  real.post(v1('/import/matrix'), { admin: true }, req => imp.run(req.user, req.body || {}));

  // ---- instance settings: the owner's bot tokens (admins; tokens are write-only) ----
  app.get(v1('/bridge/settings'), { admin: true }, () => ({ bridges: bridge.settingsView() }));
  app.patch(v1('/bridge/settings'), { admin: true }, async req => ({ bridges: await bridge.saveSettings(req.body || {}) }));

  // ---- Discord / Fluxer (same shapes as Nookara's /chat/bridge/*; Manage server) ----
  app.get(v1('/bridge/platforms'), () => bridge.platforms());
  app.get(v1('/bridge/:platform/guilds'), req => { allowed(req.params.platform, req.query.sid); return bridge.guilds(req.user, req.params.platform, req.query.sid); });
  app.get(v1('/bridge/servers/:sid'), req => bridge.status(req.user, req.params.sid));
  app.put(v1('/bridge/servers/:sid'), req => { allowed(s(req.body?.platform), req.params.sid); return bridge.link(req.user, req.params.sid, s(req.body?.platform), s(req.body?.guild_id), req.body?.automap !== false); });
  app.patch(v1('/bridge/servers/:sid'), req => { if (req.body?.enabled) allowed(s(req.body?.platform), req.params.sid); return bridge.setEnabled(req.user, req.params.sid, s(req.body?.platform), !!req.body?.enabled); });
  app.delete(v1('/bridge/servers/:sid'), req => bridge.unlink(req.user, req.params.sid, s(req.body?.platform || req.query.platform)));
  app.put(v1('/bridge/servers/:sid/channels/:cid'), req => { if (req.body?.ext_channel_id) allowed(s(req.body?.platform), req.params.sid); return bridge.setChannel(req.user, req.params.sid, req.params.cid, s(req.body?.platform), req.body?.ext_channel_id ? s(req.body.ext_channel_id) : null); });

  // ---- proof of control before a guild is linked (claims.js): a claim code, or Discord sign-in ----
  const claims = require('./claims');
  app.post(v1('/bridge/servers/:sid/claim'), req => { allowed(s(req.body?.platform), req.params.sid); return claims.start(bridge.manageable(req.user, req.params.sid).c, req.user, s(req.body?.platform), s(req.body?.guild_id)); });
  app.get(v1('/bridge/servers/:sid/claim'), req => claims.view(bridge.manageable(req.user, req.params.sid).c, s(req.query.platform), s(req.query.guild_id)));
  app.get(v1('/bridge/oauth/discord/start'), req => { allowed('discord', req.query.sid); return claims.oauthStart(bridge.manageable(req.user, s(req.query.sid)).c, req.user, s(req.query.guild_id)); });
  real.get(v1('/bridge/oauth/discord/callback'), { auth: false }, async (req, res) => claims.sendPage(res, await claims.oauthCallback(req.query)));

  // ---- CloudLink bridge channels: connection status + reconnect (Manage channels) ----
  app.get(v1('/channels/:cid/cloudlink'), req => ({ status: cloudlink.status(cloudlink.bridgeChannel(req.params.cid, req.user)) }));
  app.post(v1('/channels/:cid/cloudlink/reconnect'), req => ({ status: cloudlink.reconnect(cloudlink.bridgeChannel(req.params.cid, req.user)) }));
}

const channelTag = channelId => bridge.channelTag(channelId);
// someone here is typing in this channel (gateway.js): the linked channels see the bot typing
const typing = (ch, on) => { try { bridge.onTyping(ch, on); } catch (e) { console.error('[bridge] typing', e.message); } };
const features = () => { if (allOff()) return false; const PL = require('./platform'); return { discord: !!PL.tokenOf('discord'), fluxer: !!PL.tokenOf('fluxer'), matrix: require('./matrix').configured(), cloudlink: true }; };

module.exports = { init, shutdown, register, channelTag, typing, features, bridge, cloudlink };
