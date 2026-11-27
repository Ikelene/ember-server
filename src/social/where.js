'use strict';
// Where the social API of this homeserver's accounts is (PROTOCOL §4c). Normally here. While accounts.nookara_identity is on,
// config `social.api_url` / `social.s2s_url` may name another place (Nookara) for the Nookara accounts (v:<id>): their
// friends, blocks, keys and DM list live there, and the DMs hosted here tell that place about them over s2s.
const config = require('../config');
const { KIND_NOOKARA } = require('../compat');

const PREFIX = '/_ember/s2s/v1';
const ownApi = () => `${config.publicUrl()}/api/v2`;
const ownS2s = () => config.publicUrl() + PREFIX;
function urls() {
  const s = config.get().social, on = config.nookaraIdentity();
  return { api_url: (on && s.api_url) || ownApi(), s2s_url: (on && s.s2s_url) || ownS2s(), ...(on && s.reports_url ? { reports_url: s.reports_url } : {}) };
}
const nookara = u => !!u && u.kind === KIND_NOOKARA;
// a Nookara account of this homeserver whose friends / keys / DM list are kept elsewhere
const apiElsewhere = u => nookara(u) && config.nookaraIdentity() && urls().api_url !== ownApi();
// ... whose homeserver side of s2s (dm_pointer, dm_activity, friend calls) is answered elsewhere
const s2sElsewhere = u => nookara(u) && config.nookaraIdentity() && urls().s2s_url !== ownS2s();
// the same for a stable id of this homeserver ("v:7")
const idElsewhere = id => /^v:/.test(String(id)) && config.nookaraIdentity() && urls().s2s_url !== ownS2s();

module.exports = { PREFIX, urls, apiElsewhere, s2sElsewhere, idElsewhere };
