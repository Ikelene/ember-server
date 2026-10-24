'use strict';
const db = require('../db');
const K = require('../commands');
const I = require('../interactions');
const uploads = require('../uploads');
const { err } = require('../util');

const created = body => ({ __status: 201, body });

function register({ get, post, patch, put, del, guild }) {
  const own = (req, bot) => {
    if (req.params.app !== '@me' && String(req.params.app) !== String(bot.id)) throw err('unknown_application', 404);
  };
  const scoped = (req, bot) => {
    own(req, bot);
    return req.params.gid ? guild(bot, req.params.gid).c.id : null;
  };
  // commands: /applications/:app/commands (global) and /applications/:app/guilds/:gid/commands (one community)
  for (const base of ['/applications/:app/commands', '/applications/:app/guilds/:gid/commands']) {
    get(base, (req, bot) => K.list(bot.id, scoped(req, bot)).map(K.obj));
    post(base, (req, bot) => {
      const { row, created: isNew } = K.create(bot.id, scoped(req, bot), req.body);
      return isNew ? created(K.obj(row)) : K.obj(row);
    });
    put(base, (req, bot) => K.overwrite(bot.id, scoped(req, bot), req.body).map(K.obj));
    get(base + '/:cid', (req, bot) => K.obj(K.ownRow(bot.id, scoped(req, bot), req.params.cid)));
    patch(base + '/:cid', (req, bot) => K.obj(K.patch(bot.id, scoped(req, bot), req.params.cid, req.body)));
    del(base + '/:cid', (req, bot) => { K.remove(bot.id, scoped(req, bot), req.params.cid); });
  }
  get('/applications/@me', (req, bot) => ({ id: String(bot.id), name: bot.username, description: db.get('SELECT description FROM bots WHERE user_id = ?', bot.id)?.description || '', bot_public: true, flags: 0, bot: require('../bots').userObj(bot) }));

  // who may use them (Discord needs a user's OAuth token for this; a bot may set it for its own commands here)
  const permView = (c, snap, bot, id) => ({ id: String(id || bot.id), application_id: String(bot.id), guild_id: String(c.id), permissions: K.discordTargets(c, snap, K.permsOf(c, bot.id, id)) });
  const setPerms = (c, snap, bot, id, list) => {
    K.setPerms(c, bot.id, id, K.nativeTargets(c, snap, list));
    return permView(c, snap, bot, id);
  };
  get('/applications/:app/guilds/:gid/commands/permissions', (req, bot) => {
    own(req, bot);
    const { c, snap } = guild(bot, req.params.gid);
    return [permView(c, snap, bot, 0), ...K.list(bot.id, c.id).concat(K.list(bot.id, null)).map(r => permView(c, snap, bot, r.id))];
  });
  get('/applications/:app/guilds/:gid/commands/:cid/permissions', (req, bot) => {
    own(req, bot);
    const { c, snap } = guild(bot, req.params.gid);
    const id = String(req.params.cid) === String(bot.id) ? 0 : K.ownRowAny(c, bot.id, req.params.cid)?.id;
    if (id == null) throw err('unknown_command', 404);
    return permView(c, snap, bot, id);
  });
  put('/applications/:app/guilds/:gid/commands/:cid/permissions', (req, bot) => {
    own(req, bot);
    const { c, snap } = guild(bot, req.params.gid);
    const id = String(req.params.cid) === String(bot.id) ? 0 : K.ownRowAny(c, bot.id, req.params.cid)?.id;
    if (id == null) throw err('unknown_command', 404);
    return setPerms(c, snap, bot, id, req.body?.permissions);
  });

  // answering an interaction (the token in the path is the key, so no bot token is needed)
  const readBody = async req => {
    if (!/^multipart\//i.test(req.headers['content-type'] || '')) return { body: req.body || {}, files: [] };
    const f = await uploads.readForm(req);
    let body = f.fields;
    if (body.payload_json != null) { try { body = JSON.parse(body.payload_json); } catch { throw err('invalid_form_body', 400, { message: 'Invalid payload_json' }); } }
    return { body, files: f.files };
  };
  post('/interactions/:id/:token/callback', async req => {
    const { body, files } = await readBody(req);
    await I.callback(req.params.id, req.params.token, body, files);
  }, { anon: true });
  post('/webhooks/:app/:token', async req => {
    const { body, files } = await readBody(req);
    const msg = await I.followup(req.params.token, req.params.app, body, files);
    return String(req.query.wait) === 'false' ? undefined : msg;
  }, { anon: true });
  get('/webhooks/:app/:token/messages/:mid', req => I.getMessage(req.params.token, req.params.app, req.params.mid), { anon: true });
  patch('/webhooks/:app/:token/messages/:mid', async req => {
    const { body, files } = await readBody(req);
    return I.editFollowup(req.params.token, req.params.app, req.params.mid, body, files);
  }, { anon: true });
  del('/webhooks/:app/:token/messages/:mid', req => { I.deleteFollowup(req.params.token, req.params.app, req.params.mid); }, { anon: true });
}
module.exports = { register };
