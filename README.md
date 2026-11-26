# ember-server

> Formerly **Bonfire** / `bonfire-server`, with Nookara formerly called Velora. Ember is an open chat protocol: anyone can write an Ember client and use or run Ember servers. See [Upgrading from bonfire-server](#upgrading-from-bonfire-server) for what was renamed and what still accepts the old names.

A small, self-hostable chat server: communities, text + voice channels, special channel types (logs, welcome, link, roles shop, starboard, Minecraft), roles and permissions, invites, join requests, uploads, webhooks, bots, Discord / Fluxer / CloudLink bridges, soundboard, link previews, mentions, message signing and full export / import. One Node process, one SQLite file, no external services (voice uses your own Cloudflare Realtime account).

It implements the **Ember Instance Protocol v1** - see [PROTOCOL.md](./PROTOCOL.md) - so the Ember web, desktop and Android clients can talk to it, as well as any other clients made by anyone else. Licensed AGPL-3.0-or-later.

## Quick start

Needs **Node.js 22.13 or newer**. There are no native dependencies (storage is Node's built-in `node:sqlite`), so nothing gets compiled and it installs the same on Windows, macOS and Linux.

```sh
npm install
npm start            # http://localhost:4100, data in ./data
```

On first boot an unclaimed instance prints a **setup code** (`XXXX-XXXX`) to the console and writes it to `data/setup-code.txt`:

```
  This instance is not claimed yet. Log in, then claim it with the setup code:
      7Q3K-M9XD
```

1. Sign in (local mode: create an account; Nookara mode: sign in with Nookara).
2. Claim the instance: `POST /api/v1/instance/claim {"code":"7Q3K-M9XD","accept_operator_terms":true}` (the Ember client has a button for it). Setting up a server means accepting the [Ember Server Operator Terms](https://nookara.cc/operator-terms) (v1.0): the client shows a required checkbox, and the claim is refused with `400 operator_terms_required` without it. The acceptance (version, time, who) is stored in the instance database. An instance set up before the terms existed keeps working; its admins see a one-time notice and can accept from the dashboard (`POST /api/v1/instance/operator-terms/accept {"accept_operator_terms":true}`). You become the owner and an admin, and the code file is deleted.
3. Create a server: `POST /api/v1/servers {"name":"…","slug":"…"}` or `POST /api/v1/import` (an export zip). **A homeserver hosts many servers**, each with an address `slug@domain`. Whoever creates a server owns it. By default only instance admins may create them; the `creation` setting opens that up (`"mode": "admins" | "allowlist" | "request" | "anyone"`, an `allowlist`, and `per_account`, a cap on how many one account may own). Everyone else joins a server through its `join_policy` or an invite code (there is no auto-join).

Or skip the code: set `EMBER_OWNER=v:<nookara user id>` and the instance boots already claimed by that Nookara user (Nookara accounts only; on local accounts it is ignored). A headless setup like this must also accept the operator terms explicitly: start with `--accept-operator-terms` or set `EMBER_ACCEPT_OPERATOR_TERMS=1` (without it `EMBER_OWNER` is ignored and the setup code flow is used).

**Switching accounts mode keeps the owner.** After a switch the owner's account is the wrong kind to sign in (a local account on Nookara accounts, or a Nookara one on local accounts). The owner who switches it in the settings gets a code there; on the next start the instance prints it again (`This instance's owner ... can't sign in`) and reports `claimed: false`. Sign in with an account of the new kind and claim it with that code: you become the owner, and the community comes with you. On Nookara accounts `EMBER_OWNER` does the same at boot.

### Docker

```sh
docker compose up -d --build
docker compose logs ember | grep -A2 "not claimed"     # the setup code
```

`docker-compose.yml` mounts `./data` at `/data` and uses `restart: unless-stopped` — keep that policy, the admin "restart" button relies on it (see below).

## Configuration

Settings live in **`DATA_DIR/config.json`** (created on first boot). You can edit it by hand — the server watches the file and reloads it — or change it from the admin API (`GET/PATCH /api/v1/instance/settings`), which rewrites the file.

| key | default | notes |
|---|---|---|
| `name`, `description`, `icon_url` | | the homeserver's own, shown in discovery and on the landing page. A server has its own name / description / icon (`PATCH /servers/:sid`); nothing is mirrored. Name ≤ 60 chars, description ≤ 300 |
| `public_url` | `http://localhost:<PORT>` | the origin clients reach you at. **Set this in production** (https). It is the JWT audience and the base of upload URLs |
| `accounts_mode` | `local` | `local` (accounts on this instance) or `nookara` (Nookara sign-in). Changing it needs a restart; accounts of the other kind can no longer log in |
| `nookara_url` | `https://nookara.cc` | issuer for Nookara mode |
| `registration` | `open` | local mode: `open` / `closed` (always open while unclaimed) |
| `accounts` | from `accounts_mode` | The homeserver's account settings: `hosts_accounts`, `registration` (`open` / `closed` / `invite` / `approval`), `remote_accounts`, `link_verified_emails`, `login_methods` (password, OpenID Connect, OAuth 2.0, the Nookara preset). `accounts_mode` and `registration` above are derived from it and still written. See "Accounts and login" below |
| `federation` | see PROTOCOL §4b | Accounts of other homeservers: `rate_limits` (per remote homeserver), `min_age_floor_days` (the least any server's new-homeserver cooldown can be), `denylists` (signed shared deny lists to follow, by default Nookara's; `[]` follows none) and `deny` (your own entries: domains, `*.domain`, networks, `id@domain` accounts). Which homeservers are let in at all is `accounts.remote_accounts` |
| `ember_clients` | Nookara's, Canopy's and this server | The web origins an Ember client may be served from: where `/login` may send people back to, and who may call the token endpoint from a browser |
| `max_upload_mb` | `25` | instance ceiling (1–500); each community also has `upload_max_mb` |
| `voice` | empty | `{ cf_app_id, cf_app_secret, cf_turn_key_id, cf_turn_token }` — Cloudflare Realtime SFU app + TURN key. Secrets are write-only over the API |
| `youtube` | `{ enabled: true, ytdlp_path: "yt-dlp", cache_dir: "", cache_max_gb: 5 }` | the optional YouTube player, see below. `cache_dir` empty = `DATA_DIR/cache/yt` |
| `nookara_registration` | `auto` | `auto`: register with `nookara_url` and use its relays (push, paid roles, daily credits, voice broker, directory). `off`: never contact Nookara. See "Nookara relays" below |
| `domain` | hostname of `public_url` | the homeserver's name in server addresses (`slug@domain`) |
| `creation` | `{"mode":"admins","allowlist":[],"per_account":null}` | who may create servers here (instance admins always may) |
| `tags` | `[]` | up to 8 directory tags |

### Upgrading from bonfire-server

Everything was renamed: Bonfire is Ember and Velora is Nookara. An existing install keeps working without changes:

- **Environment variables** are `EMBER_*` now (`EMBER_NOOKARA_URL`, `EMBER_NOOKARA_REGISTRATION`, `EMBER_CLIENT_URL` for the old `BONFIRE_EMBER_URL`). The old `BONFIRE_*` / `BONFIRE_VELORA_*` names still work; a deprecation warning is logged once per name.
- **Database**: `ember.db`. On boot, a `bonfire.db` (with its `-wal` / `-shm` files) in the data directory is renamed to `ember.db` when there is no `ember.db` yet. Its `velora_id` column becomes `nookara_id` (migration v21).
- **config.json**: `nookara_url`, `nookara_registration` and `accounts_mode: "nookara"`. The old `velora_url`, `velora_registration` and `"velora"` are still read and the file is rewritten with the new names.
- **Discovery** is `GET /.well-known/ember`; `/.well-known/bonfire` serves the same document. Discovery and the admin settings carry the `nookara` object also under its old name `velora`, and `accounts_mode` still reads `"velora"` on the wire for older clients.
- **Routes**: `/api/v1/auth/nookara`, `/api/v1/import/nookara` and `/api/v1/instance/nookara/register`; the `.../velora` paths still work.
- **Docker**: image `ember-server`, compose service `ember`, build args `EMBER_BUILD_*` (the `BONFIRE_BUILD_*` args still work). The `./data` volume is unchanged; run `docker compose up -d --remove-orphans` once so the old `bonfire` container goes away.
- Still under the old names for now, because clients, bots, the Minecraft plugin or Nookara itself read them: the calls to Nookara (`/bonfire/relay/*`, `/bonfire/instances/*`, `/.well-known/bonfire/jwks.json`), signature contexts and JWT types, the `bonfire-export-v1` format, `velora_id` on user objects, `kind: "velora"`, `v:` principals and the `velora_*` error codes. All of them are listed in `src/compat.js`.

### Environment variables

| variable | meaning |
|---|---|
| `EMBER_DATA` | data directory (default `./data`): `ember.db`, `uploads/`, `config.json`, `setup-code.txt` |
| `PORT` | listen port (default `4100`) |
| `EMBER_HOST` | Address to listen on. Default `::` (IPv4 + IPv6), falling back to `0.0.0.0` when the host has no IPv6 |
| `EMBER_PUBLIC_URL` | overrides `public_url` |
| `EMBER_NOOKARA_URL` | overrides `nookara_url` |
| `EMBER_ACCOUNTS_MODE` | overrides `accounts_mode` (`nookara` / `local`) |
| `EMBER_OWNER` | `v:<nookara id>`: boot already claimed by that user (ignored if the instance is already claimed) |
| `EMBER_ACCEPT_OPERATOR_TERMS` | `1` = you accept the [Ember Server Operator Terms](https://nookara.cc/operator-terms) (same as `--accept-operator-terms`); needed for a headless setup, and records the acceptance on an existing instance |
| `EMBER_OPERATOR_TERMS_AT`, `EMBER_OPERATOR_TERMS_BY` | Nookara-hosted instances: when / by whom Nookara collected the acceptance (set by bonfire-hostd) |
| `EMBER_NOOKARA_REGISTRATION` | overrides `nookara_registration` (`auto` / `off`) |
| `EMBER_TRUST_PROXY` | `1` = take the client IP from `X-Forwarded-For` (set this behind a reverse proxy, otherwise per-IP rate limits see only the proxy) |
| `EMBER_DISCORD_TOKEN`, `EMBER_FLUXER_TOKEN` | bridge bot tokens, used when none is saved in the instance settings (`PATCH /api/v1/bridge/settings`) |
| `EMBER_MANAGED`, `EMBER_PLAN`, `EMBER_LIMITS` | Nookara-hosted ("managed") instances: plan limits (member cap, upload size, emojis, sounds, bots, bridges, own voice keys) and locked settings. See "Nookara-hosted" below, PROTOCOL §19 |
| `EMBER_READ_ONLY` | `1` = refuse every write (reading, signing in and the export still work) |
| `EMBER_UPDATE_URL`, `EMBER_UPDATE_SECRET` | optional one-click "Update server": base URL of the host agent (`bonfire-hostd`) API as seen from this container (e.g. `http://172.17.0.1:8090`) and its bearer secret (`HOSTD_SECRET` or the narrower `HOSTD_CHAT_UPDATE_SECRET`). Unset, or `EMBER_MANAGED=1`: `GET /api/v1/instance/update` answers `supported:false` and `POST` answers `501`. See "Updating from the dashboard" |
| `EMBER_IMPORT_ON_BOOT` | path of a `bonfire-export-v1` zip: imported once, as the owner, on a boot where the instance has no community yet, then deleted |
| `EMBER_DEV` | `1` = development only: CloudLink bridges may connect to `ws://localhost`, private addresses and any port |

Put it behind a TLS-terminating reverse proxy (nginx, Caddy, Cloudflare Tunnel…). WebSocket paths are `/gateway`, `/bot/gateway` and `/game-gateway` (Minecraft); both HTTP and WS must be proxied.

### Nookara mode

Users sign in with a short-lived instance token minted by Nookara (`POST /bonfire/instance-token`). The server verifies the Ed25519 JWT against Nookara's JWKS (`iss`, `aud` = your `public_url`, `exp`, one-time `jti`). Message signing (§8) is available in this mode only.

## Accounts and login

A homeserver hosts accounts (`username@domain`) and many servers. People sign in on the homeserver's own page, `/login`, never inside the client: Ember opens it, and gets tokens back through OAuth 2.0 with PKCE (`POST /api/v2/auth/token`, access tokens for an hour, refresh tokens for 60 days). The page offers whatever the `accounts.login_methods` setting has switched on: a password, any OpenID Connect provider (give it the issuer, the server finds the rest), a plain OAuth 2.0 provider with a userinfo address, or the Nookara preset. Register `<public_url>/login/callback/<method id>` as the redirect address with the provider.

Instance admins edit all of it at `GET` / `PATCH /api/v2/homeserver/accounts` (client secrets are write-only). An outside login only reaches an account it was linked to; a matching email links nothing unless `link_verified_emails` is on and the provider vouches for the address. A `config.json` from before this is migrated on load, and `accounts_mode` keeps working. The details are in [PROTOCOL.md](PROTOCOL.md) §4a.

### Nookara relays

Unless `nookara_registration` is `off`, the instance registers itself with Nookara (`nookara_url`) in **both** accounts modes, in the background once it is listening (it retries with backoff and never blocks startup). It proves it owns `public_url` by publishing its key (`DATA_DIR/keys/instance.key`, generated on first boot; back it up) in `/.well-known/ember`, so `public_url` must be reachable from Nookara. Registered, it gets:

- **Push**: Nookara users who are pinged while not connected get a phone / browser notification (at most one per channel per 30 s; they control it per instance in Ember).
- **Paid roles**: priced roles in a roles shop are paid with Nookara credits through a pay request the buyer approves on Nookara; the instance verifies Nookara's signed receipt and grants the role. Credits go to the instance owner's Nookara account once the owner links it: the instance signs a short-lived owner attestation (`GET /api/v1/instance/owner-attestation`) and the owner presents it to Nookara themselves (`POST /bonfire/instances/payout`), so no Nookara token ever goes to the instance. Otherwise credits go to Nookara.
- **Daily credits** for chatting (only for instances Nookara staff marked `trusted`).
- **Voice without your own Cloudflare account**: with no `voice` keys set, voice goes through Nookara's broker (free monthly minutes for untrusted instances). Your own keys always win.
- **Directory**: set a server's `listed` (`PATCH /api/v1/servers/:sid`) to show it in Nookara's public directory.
- **Import from Discord / Fluxer**: prepare the import on Nookara, then hand the ticket to `POST /api/v1/import/nookara`.

`GET /api/v1/instance/settings` shows the state under `nookara` (`registered`, `instance_id`, `trusted`, voice minutes, `last_error`). Details: PROTOCOL §12.11.

### Bridges: Discord, Fluxer, CloudLink

Bring your **own bot** for Discord and/or Fluxer: create a bot (Discord: enable the *Message Content* intent), then save its token as an instance admin with `PATCH /api/v1/bridge/settings {"discord":{"token":"…"}}` (or `fluxer`). The token is checked against `/users/@me`, stored in the database (never in `config.json`), and never shown again (`GET` returns `********` + its last 4 characters; `null` removes it). The instance then keeps a gateway connection for that bot. Add the bot to your server with the invite link from `GET /api/v1/bridge/platforms` (it needs View channels, Send, Read history, Embed links, Attach files, Manage messages and **Manage webhooks**), and link it in Server settings > Bridge (`PUT /api/v1/bridge/servers/:sid`, Manage server): channels with the same name are linked automatically, others per channel. Messages, replies, edits and deletes go both ways; people over there show up with their name and picture, Ember people post over there through a "Ember bridge" webhook. PROTOCOL §16.

**Matrix** works the same way with an ordinary Matrix account as the bot (any homeserver, no application service): save its homeserver address and access token with `PATCH /api/v1/bridge/settings {"matrix":{"homeserver":"https://matrix.org","token":"..."}}` (or `EMBER_MATRIX_HOMESERVER` / `EMBER_MATRIX_TOKEN`), invite the bot to rooms, then link a room to a text channel. The bot posts Ember messages as `name: text`; encrypted rooms can't be bridged. See PROTOCOL 16.5.

A `logs` channel can also bridge a **CloudLink** chat (`config: {"mode":"cloudlink","url":"wss://…","room":"","username":""}`; at most 3 per community; public `ws`/`wss` servers on ports 80 / 443 only). PROTOCOL §17.

### Minecraft (Ember Link)

Install the Ember Link plugin / mod on your Minecraft server and run **`ember server https://your.instance`** in its console. The server connects out to `/game-gateway` (no open ports) and appears under **Connected game servers**; create a "Game server" channel and pick it (or use a claim code: `ember link XXXX-XXXX`). Channels can show join info, a live console (Manage server only, every command audited) or synced chat. Unlinked servers that haven't connected for 30 days are forgotten. PROTOCOL §18. `node scripts/game-gateway-sim.js --url http://localhost:4100` pretends to be a Minecraft server for testing.

### Local mode

Usernames are 2–32 chars of `[a-z0-9_.]`; passwords are 8–200 chars, hashed with scrypt (N=16384, r=8, p=1). There is no email and no password reset — the instance owner can only recreate accounts. (Message signing is off in this mode.)

### Optional: the YouTube player (yt-dlp)

The client can play YouTube links "without YouTube": the instance downloads the video with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and streams it itself (no ads, no trackers, the viewer never contacts YouTube). It is **off unless yt-dlp is installed** — **install yt-dlp to enable it** (`pip install yt-dlp`, your package manager, or the single binary on PATH; add `ffmpeg` for merged 720p video), then restart or touch the `youtube` settings. The instance runs `yt-dlp --version` at boot and on settings changes and advertises `features.youtube` in `/.well-known/ember`; while it is off the `/api/v1/yt/*` routes answer `503 {"error":"youtube_unavailable"}`. Set `youtube.ytdlp_path` for a binary that is not on PATH, or `youtube.enabled: false` to switch it off. Downloads are capped (2 h, 720p, 900 MB, two at a time), kept 24 h after the last watch and trimmed to `cache_max_gb`. Stream links are HMAC-signed with a per-process secret, so they stop working on a restart (the player just asks again). See PROTOCOL §15.

## Restart behaviour

`POST /api/v1/instance/restart` (admins) answers `202`, tells connected clients `instance_restarting`, closes their sockets with code `4010` and exits with **code 75**. Something must start it again: Docker's `restart: unless-stopped`, systemd `Restart=always`, or the `npm run dev` loop. On `SIGTERM`/`SIGINT` the server shuts down cleanly (sockets closed with 1001, database flushed) and exits 0.

## Updating from the dashboard

An instance that runs in a container which `bonfire-hostd` can rebuild can update itself from Server settings -> Danger zone -> Update (instance admins). The instance never touches Docker: with `EMBER_UPDATE_URL` and `EMBER_UPDATE_SECRET` set it asks the host agent (`GET` / `POST /chat-update`, see the hostd README), which rebuilds the image and recreates the container (the old image is put back when the new one is not healthy). `GET /api/v1/instance/update` (admins) returns `{ supported, reason?, current, latest?, running?, outdated?, update?, reachable? }`; `POST` answers `200 { ok, update }` right away and the server goes away for a minute while it is recreated. Errors: `501 update_not_supported` (not configured), `501 update_managed` (Nookara-hosted instances are updated by the host), `409 update_in_progress`, `502 update_service_unreachable` / `update_service_rejected` / `update_service_error`. The secret is never sent to clients. The container needs to reach the host agent's API (`HOSTD_API_HOST` / `HOSTD_API_ALLOW`).

## Instance backups and upload limits

Every instance, including self-hosted and both hosted plans, has admin-only portable backups, one server at a time. `POST /api/v1/instance/backups { sid, note? }` creates one, `GET /api/v1/instance/backups?sid=` lists them (`sid` may be left out while there is one server), and `GET /api/v1/instance/backups/:id/download` downloads the ZIP. `DELETE /api/v1/instance/backups/:id` removes it. They live under `DATA_DIR/backups/`; instance settings `max_backups` defaults to 10 per server (range 1-50, oldest pruned first).

Only the instance owner can restore: `POST /api/v1/instance/backups/:id/restore`, or upload an export ZIP (multipart `file`, max 500 MB) to `POST /api/v1/instance/restore`. Restore takes a safety backup (`before restore`), replaces that one server in a transaction (every other server is left alone), returns `{ ok: true, sid }`, and closes its members' gateway sockets for a fresh reconnect (`instance_restarting`, code 4010). Read-only instances still allow backup list/download. See PROTOCOL section 5b for response shapes and errors.

Roles accept nullable `upload_max_mb` (integer 1-500) on create/PATCH. A member gets the maximum of the community default and their roles' overrides, capped by the instance and managed plan; the owner gets the ceiling. `GET /api/v1/servers/:sid` keeps `server.upload_max_mb` as the community default for settings, exposes the caller's effective value as `server.my_upload_max_mb`, and returns `server.upload_ceiling_mb` (the minimum of the instance ceiling and managed plan cap) for the role editor. Hosted Starter stays at 10 MB; Plus now allows 250 MB. Role limits travel with exports, including compatibility with older backups.

Clients can save any instance ZIP to the owner's Nookara account using `POST NOOKARA/bonfire/hosting/backups/upload` (Nookara bearer + CHAT; multipart `file`, `name`, `url`, optional `slug`, 500 MB streamed to disk). Uploaded and hosted ZIPs share account retention and download/delete/restore flows. To restore an account backup into an existing instance, the client downloads it from Nookara and sends it to the instance's restore route using the owner's instance session. Nookara tokens never go to instances. PROTOCOL sections 19.5-19.6 describe both services.

## Data, export and import

Everything is in `DATA_DIR`; back it up by copying it while the process is stopped (or use SQLite's online backup). A community's owner can download `GET /api/v1/servers/:sid/export` (a `bonfire-export-v1` zip: settings, channels, roles, emojis, members, messages with reactions/pins/signatures, local files) and anyone allowed to create communities can `POST /api/v1/import` it into any instance — including exports from Nookara's built-in chat.

## Extension points

Later waves (bridges, push, payments, imports) plug into these places and need no changes to the core (the Nookara relays in `src/relay/` use `onPost` for daily credits and `setOfflineHandler` for push; the bridges in `src/bridge/` and Ember Link in `src/game/` use `onPost`, `onEdit`, `onDelete`, `postBridged` and `communities.onChannelsChanged`):

```js
const messages = require('./src/messages');
const notify = require('./src/notify');

// 1. messages.onPost(fn): runs after ANY message is created - people, bots, webhooks, system lines, bridged posts.
//    fn(message, { ch, c, snap }, { system, webhook, bridged, userId }); returns an unsubscribe function.
const off = messages.onPost((msg, ctx, meta) => { /* e.g. relay to Discord unless meta.bridged === 'discord' */ });

// 2. messages.postBridged(channel, { platform, name, avatar, body, attachments, embeds?, replyTo?, from?, sysKind? }): a message from outside.
//    (`from` shows as author.bridge_from, e.g. the Velocity backend a Minecraft chat line came from.)
//    `channel` is a cid, a channel row or a { ch, c, snap } context. It shows as a name-only author with
//    author.bridge = platform, goes through the gateway like any message, and fires onPost with meta.bridged = platform.
//    attachments are trusted as given: [{ url, type: 'image'|'gif'|'video'|'audio'|'file', name, size, width, height }].
messages.postBridged('c0123456789', { platform: 'discord', name: 'Zed', avatar: 'https://…', body: 'hi' });

// 3. notify.notifyOffline(userIds, payload): called for members a message pings who have no gateway socket open.
//    payload is the chat_mention event. src/relay/push.js registers the Nookara push backend here:
notify.setOfflineHandler((userIds, payload) => { /* send web push */ });

// 4. messages.onEdit(fn(message, ctx)) / messages.onDelete(fn({ id, ch, c })): after an edit / delete (people, bots, bridges).
//    messages.editBridged(id, body) / messages.deleteBridged(id): change a bridged message when it changed where it came from.
// 5. communities.onChannelsChanged(fn(community)): after any channel create / edit / delete / layout change.
```

Online members get the `chat_mention` gateway event themselves; `notifyOffline` is only for the rest, already filtered by their notification level / mute settings.

## Features at a glance

- **Channel types** `text`, `voice`, `logs`, `welcome` (join / leave notices), `link`, `roles` (self-assign shop; priced roles are paid with Nookara credits), `starboard` (⭐ threshold reposting), `game` (Minecraft). PROTOCOL §6.1.
- **Discord / Fluxer bridge** with your own bot: messages, replies, edits, deletes, pictures both ways, auto-linking channels by name. §16.
- **Matrix bridge** with your own bot account on any homeserver: messages, replies, edits, deletes and files both ways in unencrypted rooms. §16.5.
- **Typing indicators over the bridges**: someone typing on Discord, Fluxer or Matrix shows here with their name and picture; the bot types over there while someone types here. §16.6.
- **Import a Matrix space** as the server during setup: rooms become channels, sub-spaces categories, with the picture and custom emoji. §16.7.
- **CloudLink bridge** in logs channels (gmsg both ways, `!online`, SSRF-guarded). §17.
- **Ember Link (Minecraft)**: `bonfire server <url>` connects a server; join-info card, live console with audit log, synced chat and join / death / advancement lines. §18.
- **Webhooks**: Discord-compatible `POST /api/v1/webhooks/:wid/:token` (embeds, files, `?wait=true`, 30/min per hook). §13.
- **Bots**: instance-local `b:<n>` accounts with a Discord-dialect REST API at `/bot/v1` and gateway at `/bot/gateway`, with slash commands, message menu commands, buttons and modals, and voice channels (`op 4`, `op 40`). §14.
- **Soundboard**: per-community sounds (mp3 / wav / ogg / flac / m4a, ≤ 5.2 s), played into a voice room with the `voice_sound` frame. §6.2.
- **Link previews** with SSRF protection: `GET /api/v1/unfurl?url=` (needs a session). §6.3.
- **Mentions** (`@user`, `@everyone`, `@here`, `@role`, replies) as `chat_mention` events, per-channel / per-community notification levels and mutes.

## Development

```sh
npm test            # node --test: permissions, JWT, signing, voice (stubbed Cloudflare), HTTP+WS end to end,
                    # features (types, shop, starboard, webhooks, soundboard, mentions, bots), unfurl SSRF, youtube (fake yt-dlp),
                    # bridge (fake Discord REST + gateway), cloudlink (local CL4 server, SSRF), game (scripts/game-gateway-sim.js)
npm run dev         # restarts on exit code 75
```

Source layout: `src/index.js` (boot), `config.js`, `db.js` (migrations via `PRAGMA user_version`), `auth.js`, `perms.js` (pure permission algorithm), `communities.js`, `messages.js`, `signing.js`, `uploads.js`, `gateway.js`, `voice.js`, `export.js`, `notify.js` (mentions + the offline hook), `identity.js`, `starboard.js`, `webhooks.js`, `soundboard.js`, `unfurl.js`, `bots.js`, `youtube.js`, `relay/*.js` (Nookara relays: `client.js` key + registration + signed requests, `push.js`, `daily.js`, `shop.js`, `broker.js`, `directory.js`, `import.js`), `bridge/*.js` (`platform.js` REST + gateway client, `bridge.js` Discord / Fluxer, `cloudlink.js`, `store.js` its tables), `game/*.js` (`game.js` data side, `gateway.js` the /game-gateway socket, `index.js` routes), `routes/*.js` (`extras.js` management routes, `hooks.js` webhook execute, `botapi.js` the bot REST). Bridge and game tables are created by their modules at boot (`CREATE TABLE IF NOT EXISTS`), not as `db.js` migrations.
