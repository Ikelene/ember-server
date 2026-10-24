'use strict';
const C = require('../communities');
const K = require('../commands');
const I = require('../interactions');
const auth = require('../auth');
const { P } = require('../perms');
const { err } = require('../util');

function register(app) {
  const v1 = p => '/api/v1' + p;
  const manager = (sid, me) => {
    const { c, snap } = C.memberCommunity(sid, me);
    if (!snap.can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
    return { c, snap };
  };
  app.get(v1('/servers/:sid/commands'), req => {
    const { c, snap } = C.memberCommunity(req.params.sid, req.user);
    const ch = req.query.channel ? C.findChannel(req.query.channel, req.user).ch : null;
    return K.clientView(c, snap, req.user, ch);
  });
  app.post(v1('/servers/:sid/interactions'), req => I.invoke(req.user, req.params.sid, req.body));
  app.delete(v1('/servers/:sid/interactions/messages/:id'), req => { C.memberCommunity(req.params.sid, req.user); I.dismiss(req.user, req.params.id); });

  app.get(v1('/servers/:sid/commands/manage'), req => K.manageView(manager(req.params.sid, req.user).c));
  app.put(v1('/servers/:sid/commands/permissions'), req => {
    const { c } = manager(req.params.sid, req.user);
    const bot = auth.userByPrincipal(req.body?.bot);
    if (!bot || bot.kind !== 'bot') throw err('bot_not_found', 404);
    K.setPerms(c, bot.id, req.body?.command ? Number(req.body.command) : 0, req.body?.permissions);
    return { perms: K.permsOf(c, bot.id, req.body?.command ? Number(req.body.command) : 0) };
  });
}
module.exports = { register };
