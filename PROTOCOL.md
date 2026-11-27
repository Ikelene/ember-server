# Ember Instance Protocol - v1

> **Ember is an open protocol.** Anyone can write an Ember client and use or run Ember servers. Nookara's own clients (web, desktop, Android) are just the ones the Nookara ecosystem uses; this document is all a third-party client or server needs.

This is the contract between three parties:

- **Nookara** (`NOOKARA` = Nookara base URL, e.g. `https://nookara.cc`, dev `http://localhost:3000`) — identity provider, the account signing key, DMs.
- **Instance** (`INSTANCE` = origin of an ember-server, e.g. `https://chat.ikelene.net`, dev `http://localhost:4100`) - a **homeserver**: it has a `domain` and hosts any number of communities (what the UI calls "servers"), each with an address `slug@domain` (§5a).
- **Client** - Ember (web `/chat`, desktop, android).

Terminology in code and docs: **instance** (the running server process at a URL) and **community** (a Discord-like server on it). One instance hosts many communities (§5a). On the wire, paths keep the old `servers` / `sid` naming so the existing client and response shapes carry over (see §6).

All JSON. All errors are `{ "error": "<snake_code>", ...extra }` with a fitting HTTP status. All instance HTTP routes send `Access-Control-Allow-Origin: *` and allow the `Authorization, Content-Type, X-Device-Fingerprint` headers. No cookies anywhere. The client is always served from Nookara, so every instance call is cross-origin. Ember works **without a Nookara sign-in** (local-account instances); a Nookara sign-in is only needed for DMs, group chats and Nookara-login instances.


**Old names.** Bonfire is now Ember and Velora is now Nookara. Where a client, bot, the Minecraft plugin or Nookara itself depends on an old name it is kept for protocol v1 and listed in the server's `src/compat.js`: the `/bonfire/*` paths and `/.well-known/bonfire/jwks.json` on Nookara, the `X-Bonfire-*` relay headers, the `bonfire-*-v1` signature contexts and `bonfire-*+jwt` token types (receipts are also accepted as `ember-receipt+jwt`), the `bonfire-export-v1` format, `velora_id` on user objects, `kind: "velora"`, `accounts_mode: "velora"`, `v:` principals and the `velora_*` error codes. The new `/.well-known/ember`, `/api/v1/auth/nookara`, `/api/v1/import/nookara` and `/api/v1/instance/nookara/register` are canonical; the old `velora` / `bonfire` paths still answer.
---

## 1. Origins and normalization

`normalizeOrigin(url)` means: parse it, lowercase the scheme and host, drop the default port (80 for http, 443 for https), drop the path, query and trailing slash. The result is `scheme://host[:port]`. Nookara puts the instance origin in a token's `aud`, and instances compare `aud` with their own `public_url` (config), normalized the same way.

Production requires `https`. `http` audiences are accepted only when Nookara runs with `EMBER_DEV=1`.

---

## 2. Nookara identity API

### 2.1 JWKS
`GET NOOKARA/.well-known/bonfire/jwks.json` returns:
```json
{ "keys": [ { "kty": "OKP", "crv": "Ed25519", "x": "<b64url raw 32B>", "kid": "<kid>", "alg": "EdDSA", "use": "sig" } ] }
```
The signing key is stored at `BONFIRE_IDP_KEY` (default `/opt/secrets/bonfire-idp.key`, PKCS8 PEM), and Nookara generates it on first use if it's missing. `kid` is the first 16 hex characters of `sha256(raw public key)`. Instances cache JWKS for 10 minutes, and refetch it once when they see an unknown `kid`.

### 2.2 Instance token
`POST NOOKARA/bonfire/instance-token` takes a Nookara bearer token and needs scope `CHAT` (2048).
Request `{ "instance": "<any url>" }` returns `{ "token": "<jwt>", "expires_at": <ms>, "aud": "<normalized origin>" }`.

The JWT is compact and signed with EdDSA (Ed25519).
- Header: `{ "alg": "EdDSA", "typ": "JWT", "kid": "<kid>" }`
- Claims:

| claim | value |
|---|---|
| `iss` | Nookara `BASE_URL`, normalized |
| `sub` | Nookara `users.id` as a **string** |
| `aud` | normalized instance origin |
| `iat`, `exp` | seconds since epoch; `exp = iat + 600` |
| `jti` | 16 random bytes, b64url |
| `username` | Nookara username |
| `display_name` | currently the same as username |
| `pfp` | absolute URL or null |
| `scp` | array drawn from `"chat"`, `"voice"`, `"media"`, `"sign"`; each is present only if the Nookara token holds `CHAT`, `VOICE`, `MEDIA_UPLOAD` or `SIGN_MESSAGES` respectively |
| `tier` | the person's Nookara plan: `"pro"` (Pro, legacy Plus, staff ranks or a credit-bought tier) or `"free"`; instances use it for "plans whose files never expire" (§6.4) |
| `app` | optional: `{ id, name?, icon? }` when the person signed in to Nookara through a registered (third-party) app. The instance keeps it with the session and adds `app` (the id), `token` (the name) and `icon` to the `via` of messages sent with that session, so clients can name the app. `id` is `app_` + hex; `icon` is an https link to Nookara's `/uploads/app-logos/`. Clients never take an instance's `via.app` as proof of an official app (no verified badge from it). |

Errors:
- `invalid_instance`: the URL doesn't parse, or it's http outside dev.
- `insufficient_scope`: the standard Nookara 403.

### 2.3 Account signing key (message signing)
New Nookara scope: **`SIGN_MESSAGES = 32768`** ("Sign messages as you"). It counts as dangerous, so it's unchecked by default on the consent screen.

Each Nookara account has **one** active Ed25519 signing key, shared by every app and browser the person uses. Nookara keeps the private half encrypted at rest (AES-256-GCM, with a key file outside the repository) and gives it only to a token that holds `SIGN_MESSAGES`. Per-device key registration (`POST /bonfire/keys`) is retired.

| route | auth | result |
|---|---|---|
| `GET NOOKARA/bonfire/signing-key` | bearer + `SIGN_MESSAGES` | `{ kid, public_key, private_key, created_at }`: the active key, created on the first call. `Cache-Control: no-store` |
| `POST NOOKARA/bonfire/signing-key/rotate` | Nookara **website session** only (not an app token) | revokes the active key, makes a new one, returns `{ kid, public_key, created_at }` |
| `GET NOOKARA/bonfire/keys/kid/:kid` | public | `{ kid, user_id, public_key, created_at, revoked_at }` or 404 `key_not_found` |
| `GET NOOKARA/bonfire/keys/user/:userId` | public | `{ user_id, keys: [ ... including revoked ] }` |

- `public_key` is the b64url of the raw 32-byte Ed25519 public key. `private_key` is the b64url of the PKCS#8 DER private key. Clients import it into WebCrypto as a **non-extractable** key, keep it in memory, and never store the raw bytes.
- `kid = "k_" + first 16 hex of sha256(raw public key)`.
- Clients fetch the key after sign-in and fetch it again when a sign attempt fails, on a 401, or when the instance rejects a signature. After a rotation the old key stops working and apps pick up the new one automatically.
- Rotation does not touch old messages: they stay valid because verification compares the key's `revoked_at` with the signature's `ts` (§8). Keys that older clients registered per device stay in the lookups as history, but no new ones can be created.
- Times are ms epoch numbers, and `revoked_at` is null while the key is active.

### 2.4 User instance list (syncs the rail across devices)
The client always keeps its list locally; when signed in with Nookara it merges the local list with this one (union, server order first) and then keeps them in sync.
| route | auth | result |
|---|---|---|
| `GET NOOKARA/bonfire/instances` | bearer + `CHAT` | `{ default_instance: "<origin>" \| null, instances: [ { url, position, added_at, muted, push, auto_join } ] }` (see "Official server" below) |
| `PUT NOOKARA/bonfire/instances` `{ instances: [ { url } ] }` | bearer + `CHAT` | replaces the whole list in this order (keeps each kept instance's `muted`/`push`); returns the list |
| `PATCH NOOKARA/bonfire/instances/prefs` `{ url, muted?, push? }` | bearer + `CHAT` | per-instance push consent (§12.3); returns that list entry, or 404 `instance_not_in_list` |
| `POST NOOKARA/bonfire/instances/default-joined` `{ url? }` | bearer + `CHAT` | the client confirms it joined (or chose not to join) the official server: clears `auto_join` for that `url` (all entries when omitted; bad `url` = 400 `invalid_instance`); returns the list |

Each `url` is a normalized origin, and the list holds at most 100.

**Official server.** When Nookara's `BONFIRE_DEFAULT_INSTANCE` (an https origin, e.g. `https://chat.ikelene.net`) is set, every account gets it **once**: at sign-up (password and OAuth), on its first `GET /bonfire/instances` for older accounts, and by the ops script `scripts/bonfire-default-instance.js [--dry-run]`. It is appended at the end of the list (`users.bonfire_default_added` marks it done, so removing it later sticks). `default_instance` is that origin (`null` when unset). `auto_join` is `true` only on the default instance's entry from the time it was added until the client calls `default-joined`; the client joins the community once, then confirms, so it happens once per account across devices. `PUT` keeps each entry's `auto_join`. Legacy Nookara servers that have `moved_to` set no longer appear in `GET /chat/servers` or `/chat/discover`; their rows and memberships stay (the owner can still export).

### 2.5 Ember web sign-in (separate token)
Ember on the web (`NOOKARA/chat`) never uses the main site's session token. It signs in like the apps do, through the consent screen, and keeps its **own** token (`localStorage['bonfire_token']`; project name `Ember (web)`):
1. Client makes a random `state` (16–128 chars `[A-Za-z0-9_-]`, kept in `sessionStorage`) and navigates to `NOOKARA/bonfire/app-login?client=web&state=<state>`.
2. Nookara redirects to `/login?…&app=ember&client=web&state=…`. If already signed in on the site, the page offers the saved account (no password), then the consent screen.
3. On approve, the login page navigates to **`/chat#/signin?code=<code>&state=<state>`** (same origin only, hard-coded path, never a URL from the query).
4. Client checks `state` matches, then `POST NOOKARA/bonfire/app-exchange { code, state }` → `{ token, username, scopes, version }`, stores it, clears the hash.
Desktop/Android keep their existing `bonfire://` flow and token storage. Signing out of Ember revokes only Ember's token.

### 2.6 Legacy export
Legacy Nookara communities may be read-only: server objects include `read_only: boolean` and `moved_to: https-origin|null`. Writes fail with HTTP 403 `{ error: "server_read_only", moved_to }` (gateway: `chat_error`); typing is ignored. Reading, leaving, and owner exports remain available; new accounts are not auto-joined to a read-only default server.

`POST NOOKARA/chat/servers/:sid/export-to-account` (owner bearer + `CHAT`, 3/hour/owner) saves the same ZIP in account backups and returns `{ backup: { id, slug, name, size, created_at, reason: "legacy", source: "uploaded", url: null } }`. Existing backup listing, download and restore flows accept it; the 10-per-account retention prunes oldest backups.

`GET NOOKARA/chat/servers/:sid/export` takes a bearer with `CHAT`, and only the **owner** may call it. It returns `application/zip` in the format of §9. Users in the export are principals of the form `v:<users.id>`.

---

## 3. Instance discovery

`GET INSTANCE/.well-known/ember` is public and returns (`GET INSTANCE/.well-known/bonfire` still serves the same document):
```json
{
  "software": "bonfire-server", "version": "0.1.0", "protocol": 1, "protocol_version": 2,
  "open_protocol": true, "protocol_name": "Ember Instance Protocol", "protocol_docs": "https://github.com/Ikelene/ember-server/blob/main/PROTOCOL.md", "about": "<one sentence: Ember is open, anyone can write a client or server>",
  "name": "My Instance", "description": "", "icon_url": null,
  "public_url": "http://localhost:4100", "previous_urls": [],
  "accounts_mode": "velora" | "local",
  "nookara": { "issuer": "http://localhost:3000", "jwks_url": "http://localhost:3000/.well-known/bonfire/jwks.json", "signing_issuers": ["http://localhost:3000"] } | null,
  "velora": <the same as "nookara", for older clients>,
  "claimed": true,
  "registration": "open" | "closed",
  "features": { "signing": true, "voice": false, "uploads": true, "youtube": false, "minecraft": true, "bridges": { "discord": false, "fluxer": false, "cloudlink": true } },
  "build": { "version": "0.1.0", "commit": "<40 hex>" | null, "commit_short": "4eb45c9" | null, "commit_date": "<ISO 8601>" | null, "built_at": "<ISO 8601>" | null, "dirty": false, "build_id": "<commit, or commit+8 hex when dirty>" | null },
  "max_upload_mb": 25,
  "managed": { "plan": "starter", "limits": { "member_cap": 30, "max_upload_mb": 10, "emojis": 50, "sounds": 10, "bots": 2, "bridges": false, "custom_voice_keys": false }, "host": "velora" } | null,
  "limits": { "defaults": { "member_cap": null, "voice_minutes": null, "max_upload_mb": 25, "storage_mb": null, "files_per_member": null, "upload_expiry_days": null, "emojis": null, "sounds": null, "bots": null, "bridges": ["discord", "fluxer", "matrix", "cloudlink"], "custom_voice_keys": true },
              "tiers": [ { "id": "plus", "name": "Plus", "price_credits": 50, "period_weeks": 1 } ] },
  "push": { "pushers_url": "…/api/v2/pushers" },
  "invites": { "url_base": "https://a.example/i/", "clients": [ { "name": "Ember", "url": "https://nookara.cc/chat#/i/{address}/{code}" } ] },
  "social": { "api_url": "…/api/v2", "s2s_url": "…/_ember/s2s/v1" },
  "read_only": false,
  "homeserver": { "domain": "chat.example", "name": "My Instance", "description": "", "icon_url": null },
  "communities_count": 2,
  "communities": [ { "sid": "s…", "slug": "camp-fire", "address": "camp-fire@chat.example", "name": "…", "icon_url": null, "description": "", "member_count": 3, "join_policy": "open" | "request" | … } ],
  "community": <one entry of the same shape> | null,
  "accounts": { "hosts_accounts": true, "registration": "open", "remote_accounts": { "mode": "none" } },
  "login": { "authorize_url": "…/login", "token_url": "…/api/v2/auth/token", "revoke_url": "…/api/v2/auth/revoke", "methods": [ { "id": "password", "kind": "password", "name": "Password" } ] },
  "instance_key": "<b64url raw 32-byte Ed25519 public key>", "instance_id": "ik_…"
}
```
- `accounts_mode` is still `"velora"` on the wire for a Nookara-accounts instance (older clients compare against it); `software` is still `"bonfire-server"`. Both change in protocol v2.
- `registration` applies only to local mode.
- `accounts` and `login` are the homeserver's account settings and where to sign in (§4a); `login` is only there when accounts are hosted here. `accounts_mode` and `registration` stay for old clients.
- `features.signing` is false in local mode. `features.youtube` is true only when the optional yt-dlp player works (§15).
- `features.minecraft` is always true (the Ember Link game gateway, §18); `features.bridges` says which bridge bots the owner has configured (§16; CloudLink needs none, §17).
- `protocol` stays `1` for old clients; `protocol_version: 2` says the homeserver hosts many servers (§5a).
- `homeserver` is the homeserver itself: its `domain` (the part after `@` in a server address) and its own `name` / `description` / `icon_url` (the same values as the top-level ones).
- `communities` are the **listed** servers only; `communities_count` counts all of them.
- `creation: { mode, per_account, request_url? }`: who may create a server here (`admins` / `allowlist` / `request` / `anyone`) and how many one account may own (`null` = no cap), so a client can hide homeservers its user cannot create on. With `request`, `request_url` is where to ask (§5a). `403 creation_limit` carries `{ limit, used }`.
- `jwks_uri` and `federation`: cross-homeserver sign-in (§4b).
- `community` is for protocol 1 clients, which know one server per instance: the only server when there is exactly one (listed or not), else the oldest listed one, else the oldest, or `null` when there is none.
- `name` / `description` / `icon_url` are the homeserver's own; a server has its own (they are no longer mirrored).
- `instance_key` / `instance_id` are the instance's relay key (§12.1). Nookara reads them here to check that a registering key controls the url.
- `features.voice` is true when voice works: the instance's own Cloudflare keys, or Nookara's voice broker while registered and under its cap (§10).
- `limits` is what a server here may have unless it bought a tier or an admin said otherwise, and the tiers on offer (§19). `push.pushers_url` is where a client registers for push (§20).
- `invites`: an invite link is `url_base + slug + "/" + code` (`url_base` ends in `/`, default `https://<domain>/i/`). The homeserver serves that address as a page any client can open: the server's name, icon and member count, an "Open in your Ember app" link (`web+ember:invite?address=<slug@domain>&code=<code>`) and one link per entry of `clients`, whose `url` may use `{address}` (`slug@domain`), `{slug}`, `{domain}` and `{code}`. Asked for anything but HTML it answers `{ server, code, url }` (`404 invalid_invite`). `/i/<slug>` without a code works for a listed server. A delegating domain redirects `/i/...` to its homeserver.
- `managed` stays for old clients. It is non-null on a Nookara-hosted instance (§19.2): its plan and limits (`null` = unlimited). `features.bridges` is `false` when the plan has no bridges. `max_upload_mb` is already capped by the plan.
- `read_only` is true while the instance refuses all writes (§19.3).
- `previous_urls` lists earlier `public_url`s, newest first (a Nookara-hosted server that moved, §19). On the first boot with a new `public_url` the instance rewrites stored copies of the old origin (uploads, icons, attachments, embeds; never the body of a signed message). Signatures name the origin a message was sent to (`instance`, §8), so a client re-checking an older signature tries `public_url` and then each of these.
- `build` is the running server build (§5c). `commit` / `built_at` are `null` on a server not built by the release script (plain checkout).

---

## 4. Instance authentication

In both modes the client ends up holding an **instance session token**. It's 32 random bytes, b64url, stored server-side as sha256. It lasts 30 days from last use and can be revoked. The client sends it as `Authorization: Bearer <session>` on REST calls and in the WS `auth` frame.

| route | body | result |
|---|---|---|
| `POST /api/v1/auth/velora` (nookara mode) | `{ token: <instance jwt> }` | `{ session, user }` |
| `POST /api/v1/auth/register` (local mode, registration open, or instance unclaimed) | `{ username, password }` | `{ session, user }` |
| `POST /api/v1/auth/login` (local mode) | `{ username, password }` | `{ session, user }` |
| `POST /api/v1/auth/logout` | – | `{ ok: true }` |
| `GET /api/v1/me` | – | `{ user, instance_admin, instance_owner, scopes }` |

How the instance checks a JWT:
1. The signature verifies against JWKS from the configured `nookara_url`.
2. `iss` equals `normalizeOrigin(nookara_url)`.
3. `aud` equals `normalizeOrigin(public_url)`.
4. `exp` is in the future, with 60s of skew allowed.
5. The `jti` hasn't been seen before.

On success it upserts the principal, refreshing `username`, `display_name` and `pfp`. The session remembers `scp`: without `"chat"` the instance refuses the login with `insufficient_scope`, and without `"sign"` the instance refuses signed messages from that session.

Local mode rules:
- Usernames are 2–32 characters of `[a-z0-9_.]`, case-insensitive and unique.
- Passwords are 8–200 characters, hashed with `crypto.scrypt` (N=16384, r=8, p=1, 16-byte salt) so there's no native dependency.

**User object** (every place a user appears):
```json
{ "id": "v:123" | "l:7", "kind": "velora" | "local", "username": "nat", "display_name": "nat", "pfp": "https://…" | null, "velora_id": "123" | null }
```
The principal string is **the** user id in every instance payload: authors, members, reactions, mentions and bans.

A third principal kind is the **bot** (`b:<n>`, `"kind": "bot"`): its user object carries `"bot": true` (clients show the BOT tag). Bots never hold sessions or log in; they use bot tokens (§14).

### 4.1 Account profiles (local accounts)

A server with its own accounts (`accounts_mode: "local"`) advertises `features.account_profiles`: each local account has a profile kept on that server, made of a display name, picture, banner, name colour, bio and pronouns. (A Nookara account's profile comes from Nookara, see 5d; these routes answer `local_accounts_only` (400) for one.)

- `GET /api/v1/me/profile` -> `{ profile: { display_name, pfp, banner, color, bio, pronouns }, sync, user }`. Every field is `null` when unset; `user` is the account's user object.
- `PATCH /api/v1/me/profile` `{ display_name?, bio?, pronouns?, color?, sync? }` -> the same shape. `null` or `''` clears a field (`display_name` goes back to the username). `display_name` is up to 32 characters, bio up to 300, pronouns up to 40, `color` is `#rrggbb`. Errors: `invalid_display_name`, `display_name_too_long`, `bio_too_long`, `pronouns_too_long`, `invalid_color`, `invalid_sync`.
- `POST /api/v1/me/profile/pfp` or `/banner` (multipart image, up to 4 MB) and `DELETE` the same path. The picture is stored on the server; the one it replaces is deleted.

The display name and picture are the user object's `display_name` and `pfp`, so they show everywhere a user appears; a change emits `chat_identity_update` like a Nookara profile change does. The whole look also rides on the member object's `profile` (6.7), with anything the person set for that server only on top, and a change emits `chat_member_update`.

**Following a Nookara profile.** The server never talks to Nookara for this. A client that is signed in to both copies the person's Nookara profile over with the routes above (text fields with `PATCH`, the pictures downloaded and uploaded again so the server holds its own copy). `sync` is where it remembers that the profile should keep following: `PATCH { sync: { velora_id, stamp } }` stores `{ velora_id, stamp, at }` (`stamp`: an opaque string of up to 128 characters the client derives from the Nookara profile it copied), `PATCH { sync: null }` switches it off. A client signed in to the Nookara account `sync.velora_id` compares the stamp on connect and when that profile changes, and copies again when it differs. A client signed in to another Nookara account, or to none, leaves the profile alone.

A moderator's profile reset (6.7, Manage users) on a local account clears its account profile too: name back to the username, pictures deleted, `sync` off.

### 4a. Homeserver accounts and login (v2)

A homeserver hosts accounts (`username@domain`) and many servers. Signing in happens on the homeserver's own web page, never inside the client: the client opens `/login`, the person signs in there, and the client gets tokens back through OAuth 2.0 (authorization code + PKCE). The routes of §4 keep working; this is what new clients use.

**Account settings.** `config.json` has an `accounts` block:
```json
{ "hosts_accounts": true,
  "registration": "open" | "closed" | "invite" | "approval",
  "remote_accounts": { "mode": "none" | "all" | "allowlist" | "blocklist", "list": ["nookara.cc"] },
  "link_verified_emails": false,
  "login_methods": [ { "id": "password", "kind": "password", "name": "Password", "enabled": true },
                     { "id": "corp", "kind": "oidc", "name": "Corp SSO", "enabled": true, "issuer": "https://id.example", "client_id": "…", "client_secret": "…", "scopes": "openid profile email" },
                     { "id": "hub", "kind": "oauth2", "name": "Hub", "enabled": true, "client_id": "…", "client_secret": "…", "authorize_url": "…", "token_url": "…", "userinfo_url": "…", "scopes": "…", "id_field": "id", "username_field": "login", "email_field": "email", "email_verified_field": "verified" },
                     { "id": "nookara", "kind": "nookara", "name": "Nookara", "enabled": false, "client_id": "…", "client_secret": "…" } ] }
```
- `hosts_accounts`: accounts live here (what `accounts_mode: "local"` meant). `false` is what `accounts_mode: "nookara"` meant: accounts come from elsewhere (`remote_accounts`), and sign-in is still §2.2 / §4 for now.
- `registration`: `open` lets anyone make an account (and anyone may while the homeserver is unclaimed, as before); `invite` needs a registration code an admin made; `approval` lets anyone ask, and the account waits for an admin; `closed` lets nobody. See *Registration* below.
- `remote_accounts`: which other homeservers' accounts are let in (§4b). `list` entries: `example.org` is that domain only, `*.example.org` everything under it.
- `login_methods`: the ways to sign in. `id` is `[a-z0-9][a-z0-9_-]{0,31}`, unique; at most one `password` method; at most 20. `kind: "nookara"` is OpenID Connect with `issuer` = `nookara_url` and scopes `openid profile`. Optional per method: `token_auth` (`"basic"` | `"post"`: how the client secret is sent to the token endpoint; from discovery for OpenID Connect, `post` by default for `oauth2`) and `pkce: false` (leave PKCE out for a provider that refuses it). Field names may be dotted paths (`data.id`).
- While accounts are hosted, at least one method must be enabled (`400 no_login_method`). With the password method switched off, `/api/v1/auth/login` and `/register` answer `403 password_login_disabled`.
- `nookara_identity` (`true` / `false` / `null`; `null` or missing is the default: on when the homeserver's `domain` is the hostname of `nookara_url`, so the homeserver of `nookara.cc` has it on): **Nookara accounts are this homeserver's accounts.** Only while accounts are hosted. See *Nookara accounts* below. The admin view shows the effective value as `nookara_identity` and the stored one as `nookara_identity_setting`; discovery's `accounts` block has `nookara_identity: true` while it is on.
- `ember_clients` (top level of `config.json`): the web origins an Ember client may be served from. Default `["https://nookara.cc", "https://canopy.ikelene.net", "https://ember.nookara.cc"]`; this server's own `public_url` origin always counts as well.
- Migration: a `config.json` without the block gets one on load. `accounts_mode: "local"` becomes `hosts_accounts: true`, `registration` as it was, no remote accounts, the password method. `accounts_mode: "nookara"` becomes `hosts_accounts: false`, `remote_accounts: { mode: "allowlist", list: [<hostname of nookara_url>] }`, no methods. `accounts_mode` and `registration` are still written to `config.json` and still sent everywhere they were (derived: `local` when accounts are hosted; `open` or `closed`), and a settings `PATCH` with either still works. If a hand-edited file has both and they disagree, the old key is applied to the block. Switching `hosts_accounts` needs a restart, as `accounts_mode` did (`EMBER_ACCOUNTS_MODE` and managed hosting still override it).

**Nookara accounts** (`nookara_identity` on). A Nookara account is the account `v:<Nookara user id>` here: the same user row that a Nookara instance token (§2.2 / §4, `POST /api/v1/auth/nookara`) makes, so servers that came from a homeserver with `accounts_mode: "nookara"` keep their members.
- Signing in with a `kind: "nookara"` login method maps the id_token's `sub` (it must be a Nookara user id, `[1-9][0-9]{0,19}`; anything else is a failed sign-in) to `v:<sub>`: that account when it exists, else a new one. Its username, display name and picture (`preferred_username`, `name`, `picture`) are taken from the id_token (or userinfo) on every sign-in. No local `l:N` account and no `login_links` row is made; the login shows as `linked` for the account, and linking a Nookara login to a local account answers `400 not_linkable`. Registration settings do not apply (the account exists at Nookara). A banned `v:` account is refused.
- The token endpoint, refresh, `/account`, `/api/v2/account/logins` and `remote-token` (§4b) work for these accounts: `account` is `{ "id": "v:<id>", "username", "domain": <domain>, "handle": "<username>@<domain>", ... }` and a cross-homeserver token's `sub` is `v:<id>@<domain>`. Their profile (§4.1: bio, pronouns, banner, colour) is kept here; name and picture follow Nookara, so the account page shows no name or picture fields for them (`local_accounts_only` on those posts).
- Nookara instance tokens keep working side by side: `POST /api/v1/auth/nookara` is accepted while `nookara_identity` is on (`400 wrong_accounts_mode` otherwise on a homeserver that hosts accounts), and the sessions it made before (in `accounts_mode: "nookara"`) stay valid.
- `GET /api/v2/users/lookup` finds them by their Nookara username (after the local accounts).

**Admin API** (instance admins):
- `GET /api/v2/homeserver/accounts` -> `{ domain, public_url, hosts_accounts, registration, remote_accounts, link_verified_emails, ember_clients, login_methods, accounts_mode, running_accounts_mode, restart_required }`. Each method other than the password one also has `callback_url` (`<public_url>/login/callback/<id>`: the redirect address to register with the provider) and, for OpenID Connect, the endpoints found from its issuer. `client_secret` is write-only: it reads back as `"********WXYZ"` (the last four characters) or `null`.
- `PATCH /api/v2/homeserver/accounts` with any of `hosts_accounts`, `registration`, `remote_accounts` (`mode` and / or `list`), `link_verified_emails`, `nookara_identity` (`null` = the default; `400 invalid_nookara_identity`), `login_methods` (the whole list), `ember_clients` (`null` = the default) -> the same view. A method sent without `client_secret`, with an empty one, or with the masked one keeps its stored secret (matched by `id` + `kind`); `client_secret: null` removes it. `public_url` lets a client show the callback address of a method that is not saved yet (`<public_url>/login/callback/<id>`).
- URLs must be `https` without credentials (`http` is allowed with `EMBER_DEV=1`): `400 invalid_method_url` `{ method, field }`. For `oidc` / `nookara` the server fetches `<issuer>/.well-known/openid-configuration` on save and takes `authorization_endpoint`, `token_endpoint`, `userinfo_endpoint` and `jwks_uri` from it (those are never taken from the request); `400 invalid_issuer` `{ method, message }` when it cannot be fetched, is incomplete, or names another issuer. A method saved with `enabled: false` may be saved while its issuer does not answer; it is looked up when first used. These requests, and the later ones to the token, userinfo and key addresses, only go to public addresses (the rule of the Matrix bridge, §16.5; `EMBER_DEV=1` lifts it) and follow no redirects.
- Other errors: `invalid_registration`, `invalid_remote_accounts`, `invalid_login_methods` `{ method?, field? }`, `invalid_ember_clients`, `invalid_hosts_accounts`, `local_admin_required` (409: switching accounts on with nobody who could sign in), `managed_setting` (403).

**Registration** (`registration.js`). Discovery's `accounts.registration` is the mode in force (`open` while unclaimed).
- `invite`: `POST /api/v1/auth/register` and the `/login` page's Create account form take an `invite` code (the form shows an "Invite code" field, filled from `?invite=` on the `/login` URL). No code: `403 invite_required`; an unknown, used up, expired or revoked one: `403 invalid_invite`. A try that fails for another reason (a taken username) does not use the code up. The code an account was made with is kept (`users.registered_with`). An outside login (below) cannot make an account in this mode.
- `approval`: a new account (by password, or by an outside login with no account yet) is made with `users.approval = "pending"` and cannot sign in: `/api/v1/auth/register` answers `{ pending: true, user }` without a session, `/api/v1/auth/login` `403 account_pending`, the `/login` page shows "Your account is waiting", the token endpoint refuses it (`access_denied`). Admins hear of it: connected admins get `{ type: "homeserver_pending", kind: "account", account }` on the gateway, and admins with a Nookara account get a line in their Nookara inbox (relay notice §12.13, `kind: "account_request"`, `community_name` = the username); otherwise it is only listed.
- Admin API (instance admins):
  - `GET /api/v2/homeserver/registration` -> `{ registration, invites: [ { code, note, uses, max_uses, expires_at, created_at, created_by, revoked } ], pending: [ { id, username, display_name, created_at, logins: [ { method, email } ] } ] }` (revoked codes are left out).
  - `POST /api/v2/homeserver/registration/invites { max_uses?: 1-1000, expires_in_hours?: 1-8760, note?: up to 200 characters }` -> `{ invite }`. A code is 12 letters and digits without look-alikes. `400 invalid_max_uses` / `invalid_expires_in_hours` / `invalid_note`, `409 too_many_invites { limit: 500 }`.
  - `DELETE /api/v2/homeserver/registration/invites/:code` -> `{ invites }` (`404 invite_not_found`).
  - `POST /api/v2/homeserver/registration/pending/:id/approve` -> `{ ok, account }`; `.../reject` deletes the account (`{ ok: true }`). `:id` is the account id (`l:7`). `404 account_not_pending`.

**An account's password.** For a local account while the password method is on (`403 password_login_disabled`):
- `POST /api/v2/account/password { new_password, current_password? }` sets or changes it (8-200 characters, `400 invalid_password`) -> `{ logins }` (as `GET /api/v2/account/logins`). An account that has a password must send it (`403 invalid_credentials`); one without (made by an outside login) must have signed in within the last 10 minutes (the refresh family, or the session, started then): `403 fresh_sign_in_required { max_age_seconds: 600 }`. Every other session and refresh family of the account ends.
- `DELETE /api/v2/account/password { current_password? }` removes it, the same proof asked, only while another enabled login is linked (`409 last_login_method`; `404 no_password`). `DELETE /api/v2/account/logins/password` still answers `400 cannot_remove_password`.

**Discovery** (§3) gains:
```json
"accounts": { "hosts_accounts": true, "registration": "open" | "closed" | "invite" | "approval", "remote_accounts": { "mode": "none" } },
"login": { "authorize_url": "https://chat.example/login", "token_url": "https://chat.example/api/v2/auth/token", "revoke_url": "https://chat.example/api/v2/auth/revoke",
           "account_url": "https://chat.example/account", "methods": [ { "id": "password", "kind": "password", "name": "Password" } ] }
```
`login` is only there when the homeserver hosts accounts; `methods` are the enabled ones, `account_url` is the account page (below). `accounts.registration` is `open` while the homeserver is unclaimed. `accounts_mode` and `registration` stay for old clients.

**Authorize: `GET /login`.** Query: `response_type=code`, `client_id=ember`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`, optional `login_hint` (fills in the username). Ember is a public client: no secret, PKCE with S256 is required (`code_challenge` is 43 base64url characters).

`redirect_uri` rules:
- its origin is in `ember_clients`; `https` (or `http` on `localhost` / `127.0.0.1` / `[::1]`); no credentials; at most 2000 characters;
- and either it has no fragment and its path ends with `/auth/callback.html` (any directory, so `https://nookara.cc/ember/auth/callback.html` is fine), or it ends with the fragment route `#/auth/callback` (any path before it);
- the answer goes back to exactly the address given. Without a fragment the parameters are added to the query: `…/auth/callback.html?code=…&state=…`. With the fragment route they are added **inside the fragment**: `…#/auth/callback?code=…&state=…` (a fragment never reaches a server, so nothing is lost);
- the token request must repeat the same `redirect_uri` string.

An unknown `client_id` or a `redirect_uri` that is not allowed shows an error page (400) and never redirects. Anything else wrong with the request goes back to the `redirect_uri` as `error` + `error_description` + `state`: `unsupported_response_type`, `invalid_request` (PKCE missing or not S256; a `state` over 512 characters, which is not echoed), `access_denied` (the person pressed Cancel). `state` is echoed exactly on every answer. A homeserver that hosts no accounts answers 404 with a page.

The page is plain HTML with no scripts and nothing loaded from elsewhere: the homeserver's name and icon, a username + password form when the password method is on, one "Continue with …" link per other enabled method, "Create account" (username, password, password again) when registration is open, and Cancel. Forms carry a CSRF token that must match the CSRF cookie: over https `__Host-ember_csrf` (`HttpOnly`, `SameSite=Lax`, `Secure`, `Path=/`, no `Domain`, so a sibling subdomain cannot plant one), over plain http (development) `ember_csrf` with `Path=/login`; a post without it gets the page again with 403. Password tries and new accounts share the limits of `/api/v1/auth/login` and `/register`. The page sends no `Cross-Origin-Opener-Policy`, so a client that opened it as a pop-up keeps `window.opener`; it refuses to be framed.

On success the browser is sent (302) to the `redirect_uri` with `code` (32 random bytes, good for 60 seconds, usable once, bound to the client, the `redirect_uri`, the challenge and the account) and `state`.

**Outside logins.** `GET /login/start/<method id>?<the same authorization parameters>` sends the browser to the provider with `state`, `nonce` (OpenID Connect) and PKCE (S256), kept server-side for 10 minutes and bound to the browser (its CSRF cookie); the provider returns to `GET /login/callback/<method id>`, which a browser without that cookie cannot use (400, "started somewhere else"). The server swaps the code for tokens and reads who it is:
- OpenID Connect: the `id_token`'s signature is checked against the provider's JWKS (RS / PS / ES 256-512 and EdDSA; never `none` or a shared-secret algorithm), then `iss`, `aud` (= `client_id`), `nonce` and `exp`. The subject is `sub`; the username comes from `preferred_username` (or `username_field`), looked up in userinfo when the token lacks it.
- OAuth 2.0: `userinfo_url` is called with the access token; the subject is `id_field` (default `id`), the username `username_field` (default: the first of `preferred_username`, `username`, `login`, `nickname`, `name`).

Then:
1. the login is linked to an account already (table `login_links`): signed in as that account;
2. else, when `link_verified_emails` is on, the provider marks the email verified, and exactly one account has another login with the same verified email: linked to that account and signed in. **An email never links anything otherwise** (off by default);
3. else, when registration is open (or `approval`: the account then waits for an admin): a new account (the provider's username, cut down to the username rules and made unique with a number; no password) linked to the login;
4. else a page says "No account here is linked to this login", with a link back to the password form: signing in there links the login to that account and carries on. That link works only in the browser that came back from the provider (the entry is bound to its CSRF cookie), and the password page names the login being linked (its provider and email or username).

A provider error, a failed check or an unknown / used / expired `state` never signs anyone in: the login page comes back with a message (400), or an error page when there is no request to go back to.

**Token: `POST /api/v2/auth/token`** (JSON or form-encoded; no authentication).
- `{ grant_type: "authorization_code", client_id: "ember", code, code_verifier, redirect_uri }`
- `{ grant_type: "refresh_token", client_id: "ember", refresh_token }`

Both answer
```json
{ "access_token": "…", "refresh_token": "…", "expires_in": 3600, "token_type": "Bearer",
  "account": { "id": "l:7", "username": "nat", "domain": "chat.example", "handle": "nat@chat.example", "display_name": "nat", "avatar_url": "https://…" | null } }
```
- The **access token** is an instance session token (§4) that ends after an hour: it is sent the same way (`Authorization: Bearer`, the gateway's `auth` frame) and every route takes it. `account.id` is the principal; `account.domain` is the homeserver's `domain`.
- The **refresh token** is random, stored hashed (table `refresh_tokens`), good for 60 days and rotated on every use: each refresh returns a new one and spends the old. A spent one used again within 30 seconds gets the same new tokens (two tabs refreshing at once); after that it ends the whole family (every refresh and access token that came from that sign-in) and the person signs in again.
- A code works once, whatever the outcome; a code presented a second time also ends what it issued.
- Errors are `{ error, error_description }`: `invalid_request` (400), `invalid_client` (401), `invalid_grant` (400: unknown / expired / used code, wrong `code_verifier`, another `redirect_uri`, unknown / expired / reused refresh token), `unsupported_grant_type` (400), `access_denied` (403, banned), `rate_limited` (429).
- CORS: `/api/v2/auth/*` answers cross-origin (preflight included) only to the `ember_clients` origins. Every other route stays open to any origin, as before.

**`POST /api/v2/auth/revoke`** `{ token }` (a refresh or access token; no authentication) ends its family; always `{ ok: true }`. `POST /api/v1/auth/logout` with an access token does the same.

**An account's logins** (signed in):
- `GET /api/v2/account/logins` -> `{ logins: [ { id, kind, name, enabled, linked, email?, created_at? } ] }`: every configured method, and whether this account can use it (`linked`; for the password method: has a password).
- `POST /login/link/<method id>` `{ return_to? }` -> `{ url }`: open `url` in a browser (once, within 10 minutes) to go through the provider and link the login to this account. The page at `url` first names the account the login will be added to and asks; only its button (a form post with that browser's CSRF token) uses the address up and goes on to the provider, so an address made for someone else's account does nothing unless whoever opens it agrees. Afterwards the browser goes to `return_to` (an `ember_clients` origin) with `linked=<method id>` or `link_error=<code>` added to its query, or shows a short page without one. A login that belongs to another account is refused (`login_already_linked`). Errors: `unknown_method` (404), `invalid_return_to`. `/login/link/*` answers cross-origin (preflight included) to the `ember_clients` origins; the rest of `/login` answers no other origin.
- `DELETE /api/v2/account/logins/<method id>` -> the list again. `409 last_login_method` when nothing else would let the account in (a password while password sign-in is on, or a login whose method is enabled); `404 not_linked`; `400 cannot_remove_password`.

**The account page: `GET /account`.** A page for people, on the homeserver itself, in the style of the sign-in page (plain HTML, no scripts, nothing loaded from elsewhere, refuses to be framed, answers no other origin). It shows the handle and lets the person edit the display name, pronouns, bio and picture (§4.1), choose who may start a DM with them (`dm_from`, §4c.3), link and unlink sign-in methods (the routes above), see the account's sessions and sign one out, sign out of the page, and sign out everywhere (every session and refresh token of the account ends and its gateway connections close).
- Signing in: without a session the page sends the browser to `/login` as an ordinary authorization request (`client_id=ember`, PKCE, `redirect_uri=<public_url>/account/auth/callback.html`, the state and verifier kept in the cookie `ember_account_login` for 10 minutes). The callback swaps the code at the token endpoint and keeps the access token in the cookie `ember_account` (`HttpOnly`, `SameSite=Lax`, `Path=/account`, `Secure` on https, one hour): it is never sent to any other path. Like every `redirect_uri`, this needs a `public_url` that is https (or this machine).
- Changes are form posts (`POST /account/profile`, `/account/avatar` (multipart, `file`), `/account/avatar/remove`, `/account/dm-privacy`, `/account/logins/link`, `/account/logins/unlink`, `/account/sessions/end`, `/account/signout`, `/account/signout-all`). Each carries `csrf`, a token derived from the session (base64url SHA-256 of `ember-account-csrf\n<session token>`); a post without it gets the page again with 403 and changes nothing. A post answers with a redirect to `/account?ok=<what>` or `/account?error=<code>`.
- A session in the list is one sign-in: a refresh-token family (an Ember client, this page), or a session of the older sign-in routes.

---

### 4b. Cross-homeserver sign-in and federation safety

An account lives on one homeserver (`alice@a.example`, an account of the homeserver whose `domain` is `a.example`) and can use servers on another (B). A signs a short token saying "this is my account, for B"; B checks it against the keys A publishes and opens a session for a **remote user**. No passwords cross, and B never talks to A about anything but its discovery document and its keys.

**Discovery** (both sides) adds:

```jsonc
"jwks_uri": "https://a.example/.well-known/ember/jwks.json",
"federation": {
  "remote_token_url": "https://a.example/api/v2/auth/remote-token", // null when this homeserver hosts no accounts
  "remote_url": "https://a.example/api/v2/auth/remote",             // where another homeserver's token becomes a session here
  "accepts_remote": "none" | "all" | "allowlist" | "blocklist"       // accounts.remote_accounts.mode
}
```

**Signing keys.** `GET /.well-known/ember/jwks.json` -> `{ keys: [ { kty: "OKP", crv: "Ed25519", x, kid, alg: "EdDSA", use: "sig" } ] }`. The first key is the instance key (§12.1, `kid` = `hs_` + the first 16 hex of sha256 of the raw public key). `POST /api/v2/homeserver/federation/rotate-key` (owner) makes a new signing key (`DATA_DIR/keys/signing-<kid>.key`); new tokens are signed with it at once and the retired key stays in the JWKS for 7 days. The instance key itself (what the Nookara relays know) never changes.

**Extra keys.** Config `federation.extra_jwks: ["https://…/jwks.json"]` (at most 10; https, http with `EMBER_DEV=1`; `400 invalid_extra_jwks`; also in the federation admin view and `PATCH`) names JWKS whose Ed25519 keys are **published in this homeserver's own JWKS**, after its own keys. This means: *these keys may sign for my domain* — cross-homeserver tokens and s2s requests (`keyId="<domain>#<kid>"`) signed with them verify as this homeserver's. It is how `nookara.cc` (whose homeserver is an Ember server) lets Nookara itself sign for the domain. Each list is fetched with the rules of `src/safe-http.js` and cached for an hour (a list that cannot be fetched keeps its last good copy). `GET /.well-known/ember/jwks.json?kid=<kid>` with a kid that is not published fetches the lists again first (at most once a minute), so a verifier that meets a new key can find it. Only `OKP` / `Ed25519` keys with a `kid` are taken, re-published as `{ kty, crv, x, kid, alg: "EdDSA", use: "sig" }`. A kid that starts with `hs_` (this homeserver's own prefix) or is already published is skipped, with a log line.

**Issuing (on A, the account's homeserver).** `POST /api/v2/auth/remote-token` with `Authorization: Bearer <a session or access token of A>` and `{ "audience": "https://b.example" }` -> `{ "token": "<jwt>", "expires_in": 3600 }`.
- Header `{ alg: "EdDSA", typ: "ember-remote+jwt", kid }`. Claims `{ iss: <A's public_url origin>, sub: "<account id>@<A's domain>" (e.g. "l:5@a.example"), aud: <the audience's origin>, iat, exp (iat + 3600), jti, preferred_username, name, picture (absolute url or null), domain: <A's domain> }`.
- Only for accounts hosted here: `403 account_not_hosted_here` otherwise (Nookara accounts, bots, remote users). `400 invalid_audience` (`reason: "https_required"`: the audience must be https, http only for this machine with `EMBER_DEV=1`; `reason: "own_homeserver"`). `429 rate_limited`: 30 a minute per account. One token is for one exchange.

**Accepting (on B).** `POST /api/v2/auth/remote` `{ "token": "<jwt>" }` (or the token as `Authorization: Bearer`), no session needed, from any origin -> the same answer as the token endpoint (§4a):

```jsonc
{ "access_token": "...", "refresh_token": "...", "expires_in": 3600, "token_type": "Bearer",
  "account": { "id": "l:5@a.example", "username": "alice", "domain": "a.example", "handle": "alice@a.example", "display_name": "Alice", "avatar_url": null, "remote": true } }
```

The access token is an ordinary session (every route and the gateway take it); the refresh token is used at `POST /api/v2/auth/token` like any other (that route answers browsers on `ember_clients` origins only; any other client simply asks A for a new token and exchanges it again). B checks, in this order:
1. Shape: `alg` EdDSA, `typ` `ember-remote+jwt`, `sub` = `<id>@<domain>` (`id`: 1-64 of `A-Za-z0-9._:-`), `domain` (when present) equals the domain in `sub` -> `401 invalid_token`. `403 remote_accounts_off` when `accounts.remote_accounts.mode` is `none`; `400 own_homeserver`.
2. `aud` is B's `public_url` origin (`401 invalid_audience`); `exp` / `iat` with 60 s of skew, at most an hour apart (`401 token_expired` / `invalid_token`); a `jti`.
3. Rules that need nothing fetched: the deny lists (`403 homeserver_denied`), then `accounts.remote_accounts` (`403 homeserver_not_allowed { domain }`). A homeserver that is not let in is never contacted.
4. The homeserver: `GET https://<domain>/.well-known/ember`. If its `homeserver` is a string (`"homeserver": "https://hs.example"`: delegation, one step only) that origin's `/.well-known/ember` is fetched instead. The final document's `homeserver.domain` must be the domain, its `jwks_uri` must be on that same origin, and the token's `iss` must be that origin (`401 invalid_issuer`). Anything else: `502 homeserver_unreachable { domain, reason }` (remembered for a minute; a good answer for an hour).
5. The key: the JWKS is cached for an hour; an unknown `kid` fetches it again, at most once a minute per homeserver (`401 unknown_kid`), then the signature (`401 invalid_signature`).
6. `jti` not seen before from that domain, remembered until `exp` (`401 token_replayed`).
7. The deny lists again, now with the addresses the homeserver answers from; `429 homeserver_rate_limited`; `403 banned`.

All fetches follow the rules of `src/safe-http.js`: https, public addresses only, no redirects. Development (`EMBER_DEV=1`): http is allowed and config `federation.dev_origins` (`{ "a.test": "http://localhost:4101" }`) says where a domain's homeserver really is.

**Remote users.** A user of kind `"remote"`: `id` (principal) is the token's `sub`, `username` is the whole handle (`alice@a.example`), and user objects also carry `remote: true`, `domain`, `handle`. Name and picture come from the token and are refreshed on every sign-in; there is no password and no account profile here (`local_accounts_only`), and a remote user cannot claim the homeserver (`remote_cannot_claim`). Scopes: `chat`, `voice`, `media`. Mentions (`<@l:5@a.example>`), `GET /identities` and join allowlists take the longer id. Nookara accounts (`v:<id>`) are untouched by all of this. A remote user's sessions stop working (`401 invalid_session`) the moment `accounts.remote_accounts` no longer lets their homeserver in, and work again when it does.

`accounts.remote_accounts.list` entries: `example.org` is that domain only; `*.example.org` is everything under it (not the bare name).

**Per server** (server settings, section `join`, §6.4): `remote_accounts` `{ mode: "inherit" | "none" | "allowlist", list: [domain rules] }` (a bare string is taken as the mode) narrows what the homeserver allows. It is part of the membership check itself, so it holds for every request and gateway event that touches the server: a remote member whose homeserver the server stops letting in gets `403 remote_not_allowed`, the server leaves their `/servers` list, and nothing is deleted (switching back restores them). The server's owner is never shut out.

**New-homeserver cooldown.** Table `homeservers_seen (domain, first_seen, last_seen, origin, net, ips)` records every homeserver whose token verified. Server setting `join.remote_min_age_days` (default 3, 0-365; config `federation.min_age_floor_days` is a floor under every server's number, shown as `remote_min_age_floor_days` in the settings view): a remote account whose homeserver was first seen less than that many days ago cannot join or ask to join: `403 homeserver_too_new { days_left }`. An invite made by a moderator (someone who can still manage the server or kick) skips it while `join.remote_invite_bypass` (default true) is on; the server's permanent invite code does not. Three clocks run and the **earliest** counts: the domain itself, its registered domain (eTLD+1) and the network its homeserver answers from (/24 for IPv4, /48 for IPv6), plus any `first_seen` a followed deny list reports. Registered domains come from a compact built-in list of common multi-label suffixes (`co.uk`, `com.au`, `github.io`, `pages.dev`, ...), not the full Public Suffix List: under a suffix that is missing, every customer shares one registered domain and so one age.

**Limits per remote homeserver** (config `federation.rate_limits`), on top of each account's own limits, counted per domain: `exchanges_per_minute` (30), `joins_per_hour` (60, joins and join requests), `messages_per_minute` (300), `reports_per_hour` (30). A homeserver first seen less than `new_days` (30) ago gets each limit divided by `new_divisor` (4). Over the limit: `429 homeserver_rate_limited { retry_after }` (seconds). `hold_after` (5) refusals within ten minutes put the domain on hold for `hold_minutes` (60): everything counted here is refused until then. Server-to-server requests (§4c) are counted the same way: `s2s_per_minute` (600, every signed request), `friend_requests_per_hour` (60), `dms_per_hour` (120, DMs started with accounts here).

**Deny lists.** Local entries (config `federation.deny`): a domain, `*.domain`, a network in CIDR form, or one account (`id@domain`). Shared lists (config `federation.denylists`, default `["https://nookara.cc/.well-known/ember/denylist"]`, `[]` to follow none) are fetched every 5 minutes while remote accounts are accepted (a list on Nookara's address is skipped while `nookara_registration` is `off`):

```jsonc
{ "updated_at": 1700000000, "domains": ["bad.example", "*.worse.example"], "networks": ["203.0.113.0/24"], "accounts": ["l:9@some.example"],
  "first_seen": { "old.example": 1690000000 },            // seconds, milliseconds or an ISO date; the earliest known time wins
  "signature": { "alg": "EdDSA", "kid": "...", "sig": "<base64url>" } }
```

`sig` is Ed25519 over the document without `signature`, serialized as JSON with the keys sorted at every level and no whitespace. The key is looked up by `kid` in the list origin's `/.well-known/bonfire/jwks.json`, then `/.well-known/ember/jwks.json`. A list that cannot be fetched or does not verify changes nothing: the last good copy stays in force, also across restarts. Effect of any entry: tokens are refused with `403 homeserver_denied`, and on the next refresh (or settings change) the sessions and refresh tokens of matching remote users are deleted and their sockets closed (`4003 homeserver_denied`).

**Admin API.** `GET /api/v2/homeserver/federation` (instance admin) -> `{ federation: { rate_limits, min_age_floor_days, denylists, deny }, accepts_remote, keys: { current, keys: [ { kid, created_at, retired_at } ] }, denylists: [ { url, entries, updated_at, fetched_at, error } ], held: [ { domain, until } ], homeservers: [ { domain, origin, net, first_seen, first_seen_here, last_seen } ], remote_accounts: <count> }`. `PATCH` the same route with any of `rate_limits`, `min_age_floor_days`, `denylists`, `deny`, plus `release: [domain]` (lift holds) and `refresh: true` (fetch the lists now) -> the view again. `400 invalid_rate_limits` / `invalid_min_age_floor_days` / `invalid_denylists` / `invalid_deny`. Which homeservers are let in at all stays in `PATCH /api/v2/homeserver/accounts` (`remote_accounts`).

---

### 4c. Friends, DMs, profiles and keys (s2s)

(DMs are end-to-end encrypted: §4d.)

Accounts of different homeservers can be friends, talk in DMs, read each other's profiles and find each other's public keys. Nothing here is special to this server: any implementation that serves the routes below with these shapes interoperates (Nookara serves `nookara.cc` accounts this way).

The rules everything follows:
- **Ids and handles.** An account's stable id is `<id>@<domain>` (`l:5@a.example`; `id` is 1-64 of `A-Za-z0-9._:-`, opaque to everyone but its homeserver). Its handle is `<name>@<domain>` (`alice@a.example`) and may change; ids never do. `from` and `to` in every call are stable ids.
- **Each side keeps its own.** An account's friend list, blocks, DM privacy and DM list live on its own homeserver, which is the source of truth for that account. The other homeserver is told with a signed request and keeps its own account's side.
- **A DM lives in one place.** A DM (two people, or a group) is hosted by the homeserver of the account that starts it. Messages are never copied: the other members sign in to the host (§4b) and use it there, like a server. Their own homeserver only keeps a **pointer** (so the DM shows in their list) and is told about activity (so they get unread counts and push).
- **Where an account's social API is.** Discovery (§3) says:
  ```jsonc
  "social": { "api_url": "https://a.example/api/v2", "s2s_url": "https://a.example/_ember/s2s/v1" }
  ```
  `api_url` is the base of the client routes below (`<api_url>/social/...`, `<api_url>/users/lookup`), `s2s_url` the base of the server-to-server routes (`<s2s_url>/friend_request`, ...). Both default to those paths on the homeserver's own origin when `social` is missing; each must be `https` (http with `EMBER_DEV=1`) without credentials, query or fragment.
- **Nookara accounts elsewhere.** While `accounts.nookara_identity` is on (§4a), config `social: { "api_url": …, "s2s_url": … }` (each `null` = this homeserver, the default; `400 invalid_social`; a third key, `reports_url`, says where DM messages of those accounts are reported, §4d.4, and is in discovery's `social` when set; when a domain delegates to its homeserver, the delegating document's `social` is the one other homeservers use) is what discovery says, and it applies to the `v:` accounts: for `nookara.cc` it names Nookara, which keeps their friends, blocks, keys, DM privacy and DM list and answers s2s for them. Then, for a `v:` account:
  - this homeserver's friends, blocks and keys routes (the home API of §4d.2 included), and profiles / keys of accounts elsewhere, answer `409 social_elsewhere { api_url }` (local `l:` accounts still use this homeserver). Reading the profile or keys of an account of this homeserver still works;
  - DMs still work here: `GET/POST /api/v2/social/dms*` are served, a DM a `v:` account starts is hosted here, and every `v:` member's pointer and activity (`dm_pointer`, `dm_activity`, the starter's own pointer included) are sent to `social.s2s_url` with `to` = `v:<id>@<domain>`, signed by this homeserver like any s2s request (`keyId="<domain>#<kid>"`, line 3 the host of `social.s2s_url`; the receiver checks it against this homeserver's JWKS). Adding another `v:` member is asked there (`dm_pointer` `added`, its answer counts), not decided here;
  - an s2s request arriving here with `to` (or a path id) `v:<id>@<domain>` is answered `421 misdirected { s2s_url }` (after the signature checks).

#### 4c.1 Signed requests

Every server-to-server request is signed by the sending homeserver with a key from its JWKS (§4b: the keys cross-homeserver tokens are signed with).

```
POST /_ember/s2s/v1/friend_request HTTP/1.1
Host: b.example
Content-Type: application/json
X-Ember-Homeserver: a.example
Ember-Signature: keyId="a.example#hs_0123456789abcdef", created=1764200000, sig="<base64url>"

{"from":"l:5@a.example","to":"l:2@b.example"}
```

- `keyId` is `<the sending homeserver's domain>#<kid>`; `created` is the time of signing in unix seconds; `sig` is the base64url (no padding) Ed25519 signature over the **signing string**. The three parameters are separated by `, ` and may come in any order; `keyId` and `sig` are quoted, `created` is not.
- The signing string is five lines joined by a single `\n` (no trailing newline):
  1. the method in upper case (`POST`);
  2. the request target exactly as sent: path, and `?query` when there is one (`/_ember/s2s/v1/profile/l%3A5%40a.example`);
  3. the receiver's host, lower case: the host (with `:port` unless it is the default one) of the receiver's `s2s_url`, which is the host of its public origin;
  4. `created`, in decimal;
  5. `sha-256=` followed by the base64url (no padding) SHA-256 of the request body bytes; for a request without a body, the digest of zero bytes (`sha-256=47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU`).
- `X-Ember-Homeserver` repeats the sender's domain; when present it must equal the domain in `keyId`.
- Bodies and answers are JSON. Errors are `{ "error": "<code>", ... }` with the status given below.

The receiver checks, in this order:
1. the header parses (`401 invalid_signature_header`); `X-Ember-Homeserver` matches (`401 homeserver_mismatch`);
2. `created` is at most 300 s old and at most 60 s in the future (`401 signature_expired`);
3. the rules of §4b that need nothing fetched: `403 remote_accounts_off` (it accepts no other homeserver), `400 own_homeserver`, the deny lists (`403 homeserver_denied`), `accounts.remote_accounts` (`403 homeserver_not_allowed { domain }`). A homeserver that is not let in is never contacted;
4. the sender's homeserver and keys, found exactly as in §4b steps 4-5 (`502 homeserver_unreachable`; an unknown `kid` fetches the JWKS again at most once a minute: `401 unknown_kid`), then the signature, with **its own** public host on line 3 (`401 invalid_signature`): a request signed for another homeserver does not verify;
5. the sender is recorded as seen (`homeservers_seen`, the cooldown clocks of §4b), the deny lists are checked again with its addresses, and the request is counted: `federation.rate_limits.s2s_per_minute` (600; `429 homeserver_rate_limited { retry_after }`, with the hold of §4b);
6. per call: a `from` must be an account of the signing homeserver (`403 from_mismatch`) and not on a deny list (`403 homeserver_denied`); a `to` must be an account hosted by the receiver (`404 user_not_found`; `421 misdirected { s2s_url }` when the receiver's social API for that account is elsewhere, see above); malformed bodies are `400 invalid_request`.

There is no nonce: every call is idempotent (sending one twice leaves the same state), so a replay within the five minutes changes nothing. `POST /_ember/s2s/v1/ping` (any body) -> `{ ok: true, homeserver: <receiver's domain>, you: <sender's domain> }` checks a setup.

A sender applies its own rules before it calls: it never contacts a homeserver its `accounts.remote_accounts` or deny lists refuse (`remote_accounts_off`, `homeserver_denied`, `homeserver_not_allowed` come back to the client that asked). Calls a person waits for (`friend_request`, `friend_accept`, `dm_pointer` `added`, `profile`, `keys`) are made once, and the other homeserver's error code and status are passed to the client (a 5xx as 502). The rest (`friend_remove`, `block`, `unblock`, `presence`, `dm_pointer` `removed` / `renamed`, `dm_activity`) are queued per homeserver, sent in order off the request path, and kept until they are answered: the queue is stored (a restart loses nothing), a call that gets no answer, a 5xx or a 429 is tried again with growing waits (2 s, 15 s, 1 min, 5 min, 15 min, 1 h, 1 h, 3 h, 6 h, 12 h) and given up after the last one or once it is a day old. Only the newest `presence` of an account waits for each homeserver.

**Before the signature.** Finding a sender's keys means fetching from its domain, which anyone can ask for with a made-up `keyId`. Homeservers this one already deals with (seen after a good signature, a friend's or a DM's homeserver, calls waiting for it) are never held back by what others do. For any other sender a receiver limits signed requests per address (600 a minute, `429 rate_limited`), lookups of an unknown domain per address and registered domain (10 in ten minutes) and overall (600 in ten minutes), both `429 rate_limited`, and runs at most 4 such lookups per address and 32 in all at once (`503 busy`). Each domain is looked up once however many requests wait for it, and a failed lookup is remembered for a minute. Behind a reverse proxy the address is the client's only with `EMBER_TRUST_PROXY=1`.

#### 4c.2 Server-to-server calls

All under `<s2s_url>`; all `POST` unless marked.

| call | body | answer |
|---|---|---|
| `friend_request` | `{ from, to, message? }` (`message`: up to 200 characters) | `{ status: "pending" }`, or `{ status: "friends" }` when `to` had already asked `from` (or they are friends). `403 blocked` when `to` blocked `from`; `409 too_many_friends`; counted in `friend_requests_per_hour` (60) |
| `friend_accept` | `{ from, to }`: `from` accepts the request `to` sent | `{ status: "friends" }`. `409 no_request` when `to` has no request out to `from` |
| `friend_remove` | `{ from, to }`: `from` unfriended `to`, took a request back, or turned one down | `{ ok: true }`: whatever `to` had with `from` (friendship or request, either direction) is deleted |
| `block` | `{ from, to }` | `{ ok: true }`: the same as `friend_remove`, and `to`'s homeserver may refuse `to`'s later requests to `from` itself (`403 blocked`) |
| `unblock` | `{ from, to }` | `{ ok: true }` |
| `dm_pointer` | `{ dm, to, kind, from? }`, see 4c.4 | `{ ok: true }`. `403 dm_not_allowed`, `403 dm_host_mismatch`, `410 pointer_gone`, `409 too_many_dms` |
| `dm_activity` | `{ dm, to, last_message_id, count?, mention?, sender?, name?, e2ee? }`, see 4c.4 | `{ ok: true }`. `410 pointer_gone`, `403 dm_host_mismatch` |
| `GET profile/<id>` | - | the profile, see 4c.5. `404 user_not_found` |
| `GET keys/<id>` | - | the account's key document (`{ id, keys: [] }` when it has none), see 4c.6. `404 user_not_found` |
| `presence` | `{ from, status }` (`online`, `idle`, `dnd`, `offline`) | `{ ok: true }`. Optional: sent when an account connects or leaves, to the homeservers its friends are on; the receiver tells `from`'s friends' connected clients and keeps the last status in memory (friends lists and profiles show it) |

`<id>` in a path is the URL-encoded stable id.

#### 4c.3 Friends (client API on the account's own homeserver)

`Authorization: Bearer <a session of an account hosted here>`; other accounts get `400 local_accounts_only`. An account in these lists is always `{ id, handle, display_name, avatar_url }` (for an account of another homeserver: what was last fetched from it; `handle` is `null` until then).

| route | result |
|---|---|
| `GET /api/v2/users/lookup?handle=<name>` (public, on **every** homeserver; 60 a minute per address) | `{ id, handle, display_name, avatar_url }` of an account hosted there. `<name>@<domain>` is accepted when the domain is its own (`404 wrong_homeserver` otherwise); `404 user_not_found` |
| `GET /api/v2/social/friends` | `{ friends: [...], incoming: [...], outgoing: [...], blocked: [...] }`, each entry the short form plus `since` (ms) and, for requests, `message`. A friend also has `presence: { status }` when it is known: connected or not for an account here; for one elsewhere, what its homeserver last sent (`presence`, 4c.1) or the profile fetched of it. A client starts from these and follows `social_presence` |
| `POST /api/v2/social/friends { handle }` or `{ id }`, optional `message` | `{ status: "pending" \| "friends", friend }`. `handle` is `alice` (here) or `alice@b.example`: the homeserver finds `b.example` (§4b), asks its `lookup`, then sends `friend_request`. Asking someone who already asked you accepts. Asking again while your earlier request waits sends it again (the other side may have turned it down). A `friend_request` from someone the receiver still counts as a friend means their side lost the friendship (a removal that never arrived): the receiver turns it into a request to accept, never a friendship nobody agreed to. `400 cannot_friend_yourself`, `404 user_not_found`, `403 blocked` (they blocked you), `409 user_blocked` (you blocked them), `409 too_many_friends { limit: 1000 }`, `429 rate_limited` (30 an hour), plus the other homeserver's and the sender-side errors of 4c.1 |
| `POST /api/v2/social/friends/<id>/accept` | `{ status: "friends", friend }`. `404 no_request` |
| `DELETE /api/v2/social/friends/<id>` | the lists again: unfriends, takes a request back or turns one down. For an account elsewhere it is idempotent: its homeserver gets `friend_remove` whether or not this side still had a row (a friendship only the other side remembers ends there too); `404 not_friends` for one this account blocked, and for an account of this homeserver with nothing open |
| `POST /api/v2/social/blocks/<id>` | the lists again. Ends any friendship or request; nothing from that account is accepted until it is lifted (friend requests, DMs). The blocked account is not shown that it is blocked |
| `DELETE /api/v2/social/blocks/<id>` | the lists again. `404 not_blocked` |

`<id>` is a stable id; for an account of this homeserver the bare id (`l:7`) works too. Two accounts of one homeserver never use s2s: both sides are written at once. Table `friends (user_id, peer, state, message, created_at, updated_at)`, `state` one of `friend`, `incoming`, `outgoing`, `blocked`, `blocked_by` (the other side blocked this account: never listed).

Gateway (§7), to the account's own connections: `{ type: "social_friends_update" }` whenever its lists changed (fetch them again) and `{ type: "social_presence", id, status }` when a friend connects or leaves.

**DM privacy.** The account setting `dm_from` (`PATCH /api/v1/settings { dm_from }`, also on the account page) is `"friends"` (default), `"anyone"` or `"nobody"`: who may start a DM with this account. It is enforced by the account's own homeserver (4c.4).

#### 4c.4 DMs

**The DM object.** As clients get it (`dm`):
```jsonc
{ "id": "d0a1b2c3d4e@b.example",        // <dm id>@<host domain>
  "host": "b.example", "host_origin": "https://b.example", "hosted_here": true,
  "group": false, "name": null, "owner": null,       // a group has a name (or null) and an owner (stable id)
  "sid": "d0a1b2c3d4e", "channel": "c5f6a7b8c9d",   // on the host: the DM's community and its one text channel
  "members": [ { "id": "l:2@b.example", "handle": "bob@b.example", "display_name": "bob", "avatar_url": null }, ... ],
  "created_at": 1764200000000, "updated_at": 1764200100000, "last_message_id": "41", "unread": 0, "mention": false,
  "e2ee": true }                          // every DM is end-to-end encrypted (§4d)
```

**Client API** (`<api_url>/social`):

| route | result |
|---|---|
| `GET /api/v2/social/dms` | `{ dms: [...] }`, newest activity first: the DMs hosted here that the caller is in (`hosted_here: true`; any account, also one signed in from another homeserver) and, for accounts of this homeserver, the pointers to DMs hosted elsewhere (`hosted_here: false`, `unread` / `mention` / `last_message_id` as last reported by the host) |
| `GET /api/v2/social/dms/<id>` | `{ dm }`. `404 dm_not_found` |
| `POST /api/v2/social/dms { members: [handle], member_ids?: [id], name?, group? }` | `{ dm, created }`: starts a DM **here** (accounts of this homeserver only). One other member makes a two-person DM unless `group: true`; more make a group (10 members at most, `name` up to 60 characters). A two-person DM that already exists between the two, here or on the other homeserver, is returned instead (`created: false`). `400 invalid_members`, `404 user_not_found`, `403 dm_not_allowed { member }` (that member's `dm_from` or block says no: nothing is created), `409 user_blocked { member }`, `429 rate_limited` (30 an hour) |
| `PATCH /api/v2/social/dms/<id> { name }` | `{ dm }`: any member of a group renames it. `400 not_a_group` |
| `DELETE /api/v2/social/dms/<id>/members/<member id>` | `{ dm }`: the group's owner removes someone. `403 owner_only`, `404 not_a_member`, `400 cannot_remove_yourself` |
| `POST /api/v2/social/dms/<id>/members { members: [handle], member_ids?: [id] }` | `{ dm }`: the group's owner adds people. Each is asked as for a new DM (their `dm_from`, blocks; an account elsewhere through its homeserver, `dm_pointer` `added` with `from`, waited for: its error comes back with `member`); the members elsewhere already in it get `dm_pointer` `renamed` with the new member list. `403 owner_only`, `400 already_member` (nobody new), `409 group_full { max: 10 }`, `400 not_a_group`, `400 not_hosted_here { host_origin }`. A member added later gets wraps only for what is sent from then on (§4d.3) |
| `GET /api/v2/social/dms/<id>/rewrap?member=<id>&kid=<kid>` / `POST .../rewrap { member, kid, wraps }` | wrapping messages again for a member's new key, §4d.3 |
| `POST /api/v2/social/dms/<id>/leave` | `{ ok: true, hosted_here }`: leaves a group. The owner leaving hands it to the longest-standing member; the last member leaving deletes it. `400 not_a_group` (a two-person DM cannot be left) |
| `POST /api/v2/social/dms/<id>/read` | `{ dm }`: marks it read (on the host: the read state; on the member's homeserver: the pointer's `unread` and `mention`) |

`PATCH`, `DELETE .../members` and `leave` act on the host: asked of a homeserver that only has the pointer they answer `400 not_hosted_here { host_origin }`, except `leave`, which drops the pointer there (`{ ok: true, hosted_here: false, host_origin }`); the host then learns it from its next `dm_activity` (`410 pointer_gone`) and removes the member.

**Using a DM.** Every DM is end-to-end encrypted: its messages are sealed envelopes and its files are sealed too (§4d says what the host takes and refuses). On the host a DM is a hidden community of kind `dm` with one text channel (`channel`): messages, history, edits, reactions, typing, read state, uploads (`/api/v1/media/upload?sid=<sid>&cid=<channel>`) and the gateway events are those of §6-§7 on that channel id, and members get every message as a notification (`chat_mention`, and push with `kind: "dm"`, §20). A member from another homeserver gets a session on the host with a cross-homeserver token (§4b: `remote-token` with `audience` = `host_origin`, then `POST <host_origin>/api/v2/auth/remote`) and uses the same routes there. A DM is **not** a server: it is in no server list (`/servers`, `/discover`, discovery, the landing page, the directory, the admin's list of servers, backups and exports), it has no slug, address, invites, join policy, roles, extra channels, bots, bridges, webhooks, settings, audit log or reports, and every route that names a server by `sid` answers `404 server_not_found` for it. Its members can post, attach, react, edit and delete their own messages; the only moderation is leave, remove (the group's owner) and rename.

**What the host sends** to the homeserver of each member that lives elsewhere:

`dm_pointer` `{ dm, to, kind, from? }`:
```jsonc
{ "dm": { "id": "d0a1b2c3d4e@b.example", "host": "b.example", "name": null, "group": false, "owner": null, "sid": "d0a1b2c3d4e", "channel": "c5f6a7b8c9d",
          "members": [ { "id", "handle", "display_name", "avatar_url" }, ... ], "created_at": 1764200000000, "e2ee": true },
  "to": "l:5@a.example", "kind": "added", "from": "l:2@b.example" }
```
- `dm.host` must be the signing homeserver and `dm.id` must end in `@<that domain>` (`403 dm_host_mismatch`): only the host speaks for a DM. `host_origin` is never taken from the body: it is the signer's origin as found by discovery.
- `kind: "added"`: `to` is in the DM (or, when the pointer exists already, it changed). For a new pointer `from` is required: the account of the host that added `to`. The receiver applies `to`'s rule: `403 dm_not_allowed` when `to` blocked `from`, when `dm_from` is `nobody`, or when it is `friends` and `from` is not a friend of `to`. The host then **must not** add `to`: the member's homeserver has the last word. `to` must be among `dm.members` (`400 invalid_request`). Counted in `dms_per_hour` (120).
- `kind: "renamed"`: the name or the members changed; the pointer is updated. `410 pointer_gone` when `to` has none.
- `kind: "removed"`: `to` is no longer in it (left on the host, removed, or the DM is gone); the pointer is deleted. Only `dm.id` and `dm.host` are needed.

`dm_activity` `{ dm: "<dm id>", to, last_message_id, count?, mention?, sender?: { id, display_name }, name?, e2ee? }`: new messages. `e2ee`: whether the DM is end-to-end encrypted (an ember-server host always sends `true`); a receiver updates its pointer from it, so a pointer made before the host encrypted DMs follows. The host coalesces what is said within a second into one call per member; `count` is how many messages it stands for (default 1), `mention` whether one of them pinged or replied to `to` (a host cannot tell for sealed messages and sends `false`). There is no `preview`: messages are sealed (§4d), and a receiver ignores one that is sent anyway. The receiver sets the pointer's `last_message_id`, adds `count` to `unread`, ORs `mention`, tells `to`'s connected clients and pushes to `to`'s pushers when none is connected (`kind: "dm"`, §20). `410 pointer_gone` when `to` has no pointer: for a group the host takes that as "left" and removes the member.

Table (member's side) `dm_pointers (user_id, dm_id, host_domain, host_origin, name, members_json, last_message_id, unread, mention, extra_json, updated_at)`, at most 500 per account. Host side: `communities.kind = 'dm'` (`join_policy` `'dm'` for two people, `'group'` for a group).

Gateway, to the account's own connections on whichever homeserver sent it: `{ type: "social_dm_update", dm }` (new or changed), `{ type: "social_dm_remove", id }`, and on the member's homeserver `{ type: "social_dm_activity", dm, mention, sender? }`.

#### 4c.5 Profiles

`GET <s2s_url>/profile/<id>` ->
```jsonc
{ "id": "l:5@a.example", "handle": "alice@a.example", "display_name": "Alice", "avatar_url": "https://a.example/uploads/..." | null,
  "bio": "..." | null, "pronouns": "..." | null, "banner_url": null, "color": "#aabbcc" | null,
  "presence": { "status": "online" | "idle" | "dnd" | "offline", "activity": "..." },   // activity is optional
  "updated_at": 1764200000000 }
```
`presence` is for friends: a homeserver gets the real status only when one of its accounts is a friend of that account, `offline` otherwise.

Client: `GET /api/v2/social/profile/<id>` -> `{ profile }` in the same shape. An account of this homeserver is answered from its own data (§4.1); another homeserver's is fetched with the call above and kept for 10 minutes (table `social_cache (kind, id, body, fetched_at)`); when the other homeserver cannot be reached an older copy is returned with `stale: true`. `404 user_not_found`.

#### 4c.6 Keys

A homeserver stores and publishes **public** keys only; encryption and signing happen in clients (§4d). Every account has at most one **key document**, in the format `nke1` (the one Nookara's end-to-end encrypted DMs use): one P-256 account key with a signing half and an encryption half, the account's signed list of linked clients, and the public halves of account keys it replaced.

```jsonc
{ "id": "l:5@a.example",
  "format": "nke1",
  "owner": "l:5@a.example",            // the exact string this account's signed texts are made over
  "keys": [ { "kid": "<22 chars>", "kind": "account", "alg": "p256", "public_key": "<signing key, 87 chars>", "enc_public_key": "<encryption key, 87 chars>", "created_at": 1764200000000 } ],
  "clients": { "seq": 3, "list": [ { "kid", "enc_pub", "sig_pub", "label", "app", "added_at", "revoked_at" } ] },   // as the account signed it, revoked entries included
  "clients_sig": "<86 chars>" | null,
  "clients_seq": 3,                    // = clients.seq
  "past": [ { "kid", "sig_pub" } ],    // replaced account keys, public half, up to 20: their old signatures can still be checked
  "stale": true }                      // only when served from an old copy
```

- An account that has no keys yet: `{ "id": ..., "keys": [] }`. An unknown account: `404 user_not_found`.
- Keys are raw uncompressed P-256 points (65 bytes, first byte `0x04`), base64url without padding (87 characters). `kid` = the first 22 characters of `base64url(SHA-256(encryption key))`. Signatures are ECDSA P-256 / SHA-256 in the 64-byte `r‖s` form, base64url (86 characters).
- `keys` holds exactly one `account` entry. `device` entries (`signed_by` = the account's kid) may be listed for older readers, but **`clients` is what counts**: a linked client is an entry of `clients.list` whose `revoked_at` is `0`.
- `owner` is the full stable id, except for Nookara accounts, whose signatures use the bare number (`"5"` for `v:5@nookara.cc`). A reader **must** check `owner === id` or `id === "v:" + owner + "@" + <domain of id>` and refuse anything else.
- `clients_sig` is by the account's signing key over `nke1 clients|<owner>|<account kid>|<seq>|<entries>`, an entry being `kid,enc_pub,sig_pub,encodeURIComponent(label),app,added_at,revoked_at` and entries joined by `;`. On this homeserver `app` is limited to `A-Za-z0-9._:-` (it is not escaped).
- **A homeserver passing on another's document changes nothing in it.** It checks the shape only (`id` is the one asked for; `owner` as above; one account key; `alg: "p256"`; keys of 87 characters that decode to a point; kids of 22 characters; `label` and `app` up to 120 characters; at most 200 list entries, 20 `past` entries, 21 keys; `clients_sig` 86 characters) and passes every field through as it came, in its order, fields it does not know included. It never checks or rewrites a signature: that is the reader's job. A document that fails the check is refused whole (`502 homeserver_unreachable { reason: "bad_keys" }`, or the last good copy with `stale: true`); one without `format: "nke1"` counts as `keys: []`.
- What a reader (a client) checks before sealing to a document: `owner` as above; each `kid` matches its encryption key; `clients_sig` when the list is not empty. It remembers the account key per stable id (trust on first use), refuses a lower `seq` for the same key, and tells the person when the key changes. There is no signed chain from one account key to the next: a replaced key shows as a key change.

Client:
- `GET /api/v2/social/keys/<id>[?fresh=1]` -> the document: an account here, or another homeserver's through `GET <s2s_url>/keys/<id>`, kept for 10 minutes (`stale: true` as for profiles). `?fresh=1` asks the other homeserver again (10 a minute per account asked about; beyond that the kept copy is served): for a sender told `stale_keys` (§4d.3) or looking at a signature by a key it does not know.
- The keys themselves are made and changed through the home API of §4d.2. `PUT /api/v2/social/keys` (an Ed25519 / X25519 key chain no client ever used) is retired: `410 use_e2ee_api`. Table `account_keys` is left unused.

#### 4c.7 What another implementation needs

To take part, a homeserver (for a domain `d`) serves:
1. `https://d/.well-known/ember` with `homeserver: { domain: d }` (or one delegation), `jwks_uri` on its own origin, `federation` (§4b) and, when its social API is not at the default paths, `social: { api_url, s2s_url }`;
2. its JWKS (Ed25519 keys with `kid`), and signs every s2s request as in 4c.1;
3. `GET <api_url>/users/lookup?handle=`;
4. under `<s2s_url>`: `GET keys/<id>` answering the key document of 4c.6 and passing other homeservers' documents on unchanged; `friend_request`, `friend_accept`, `friend_remove`, `block`, `unblock`, `dm_pointer`, `dm_activity`, `GET profile/<id>`, `GET keys/<id>` (and `presence` if it wants it), verifying each request as in 4c.1 and answering unknown calls with 404;
5. to host DMs for members elsewhere: cross-homeserver sign-in (§4b, `POST <origin>/api/v2/auth/remote`) and, for those sessions, the message routes and gateway of §6-§7 on the DM's `channel`, plus `GET <api_url>/social/dms` (so a member's client finds `sid` and `channel`) and the `leave` / `rename` / `remove` routes; it sends `dm_pointer` / `dm_activity` as in 4c.4; and it follows the host rules of §4d.3 (sealed envelopes only, nothing readable stored or sent on);
6. to let its accounts join DMs hosted elsewhere: `remote-token` (§4b), pointers kept from `dm_pointer` / `dm_activity`, the home API of §4d.2 for their keys, and `POST <api_url>/social/reports` (§4d.4).

A homeserver that only wants friends, profiles and keys can answer `dm_pointer` with `403 dm_not_allowed` and never host a DM.

### 4d. End-to-end encrypted DMs

Every DM (§4c.4) is end-to-end encrypted, from its first message: the host stores sealed envelopes and can read none of them, and there is no unencrypted DM. The crypto is Nookara's `nke1` (P-256 ECDH + ECDSA, AES-256-GCM, HKDF-SHA256, HMAC-SHA256), done entirely in clients. A homeserver has two separate parts in it:

- the **home** of an account keeps its public keys (the key document, §4c.6) and the account's private keys **locked**: two blobs only the account's own secret opens (4d.2);
- the **host** of a DM stores and relays envelopes (4d.3).

Neither can read a message. What a homeserver does see: who is in a DM, when messages are sent and how big they are, which message a message replies to, reactions, pins, read state, typing; public keys, the locked blobs with their salts, and who links which device.

Base64 below is always base64url without padding.

#### 4d.1 The sealed message

One fresh key per message, wrapped once for every key that may read it. No ratchet and no forward secrecy.

```json
{ "v": 2, "ct": "…", "iv": "…", "commit": "…", "sig": "…", "signer": "<kid>", "wraps": { "<kid>": { "e": "…", "i": "…", "w": "…" } } }
```

| | |
|---|---|
| `dm` | the DM's id, `<sid>@<host domain>` with the domain in lower case |
| `from` | the sender's full stable id (`l:5@a.example`, `v:5@nookara.cc`) |
| payload | JSON `{ "t": text, "r"?: { "from": name, "s": quote }, "n": 8 random bytes, "ts": sender's clock in ms, "p"?: link previews }`. A file is a link on its own line in `t` (4d.3). Link previews are made by the sender's device and travel in here: no server fetches a link of a DM |
| `ct` | AES-256-GCM(`K`, `iv`, payload), `K` = 32 random bytes, `iv` = 12 random bytes, additional data `nke1\|2\|<dm>\|<from>`, tag appended |
| `commit` | HMAC-SHA256(`K`, `"nke1 commit"`): binds the envelope to its key, so a revealed key (4d.4) cannot be swapped |
| `wraps[kid]` | `K` for one recipient key: a fresh ephemeral P-256 key `e` (raw point), `wrapKey` = HKDF-SHA256(ECDH(ephemeral, recipient's encryption key), salt = `e` raw, info = `"nke1 wrap\|<kid>"`, 32 bytes), `w` = AES-256-GCM(`wrapKey`, `i` (12 random bytes), `K`), no additional data |
| `sig`, `signer` | ECDSA by the sender's key `signer` (its account key or one of its linked clients) over `nke1 sig\|2\|<dm>\|<from>\|<edit_of>\|<iv>\|<ct>\|<commit>`, where `edit_of` is `0` for a new message and the host's message id for an edit |
| recipients | every current member of the DM, the sender included: the account key and every linked client that is not revoked, from each member's key document. In a two-person DM a client seals to exactly the two accounts it knows and refuses when the host lists more |

A reader finds `wraps[<its kid>]`, unwraps `K`, checks `commit`, opens `ct` with the same additional data (so an envelope moved to another DM or put under another sender does not open) and verifies `sig` against the sender's key document (account key, a client in `clients.list`, or a `past` key).

**Nobody without keys gets plain text.** A sender's client holds a message until every member has keys (it shows who is missing) and never falls back to an unencrypted message; the host would refuse it anyway.

Limits: `ct` up to 98,304 characters; `wraps` up to 256 and up to 21 per member of the DM (an account key and 20 clients); `e` 128, `i` 24, `w` 128, `iv` 24, `commit` 64, `sig` 128 characters at most; kids are 22 characters.

#### 4d.2 The home API: an account's own keys

`<api_url>/social/e2ee`, on the account's home only. The bodies and answers are those of Nookara's `/im/keys`, so one client implementation serves both.

- An account of another homeserver signed in here: `400 local_accounts_only`. A Nookara (`v:`) account whose social API is elsewhere (§4c): `409 social_elsewhere { api_url }`: its keys are Nookara's to keep, at `<api_url>/social/e2ee`. A session an OAuth app signed in with: `403 own_clients_only`.
- **The unlock secret is a passphrase, never a PIN.** Whoever runs a homeserver holds the salt and a hash of the unlock proof and could try every 6-digit PIN in hours, so only `nookara.cc` itself takes PINs. Here a client must lock the keys with a passphrase of at least 12 characters, stretched with Argon2id at `m >= 65536` KiB, `t >= 3`, `p >= 1`, and **say so**: `passcode.secret_kind: "passphrase"` (Nookara's `type: "password"` is taken as the same). `type: "pin"` or `secret_kind: "pin"`, or neither field: `400 passphrase_required { kinds: ["passphrase"], min_length: 12, argon2id: { m, t, p } }`. Weaker Argon2id parameters: `400 weak_kdf { argon2id }`. The server cannot see the secret, so the length is the client's to enforce: it reads the rules from `GET /me` (`passcode_rules`) and must refuse a shorter one. The recovery code (26 Crockford characters, 130 bits) is the other way in.

A locked blob is `AES-256-GCM(wrap, iv, JSON { enc_pub, sig_pub, kid, enc_priv (JWK), sig_priv (JWK) })` with additional data `nke1 backup`. The secret is stretched to 64 bytes (passphrase: Argon2id with `salt` and `params`; recovery code: HKDF-SHA256, `salt`, info `nke1 recovery`): the first 32 are `wrap`, the last 32 are `auth`. The server keeps `SHA-256(auth)` and hands the blob out only to someone who sends the right `auth`.

| route | |
|---|---|
| `GET /me` | `{ id, owner, passcode_rules: { kinds, min_length, argon2id }, has: false }`, or with keys: `{ id, owner, passcode_rules, has: true, kid, enc_pub, sig_pub, clients: { seq, list }, clients_sig, passcode: { type: "password", secret_kind: "passphrase", salt, params: { m, t, p }, locked, tries_left }, recovery: { salt } }`. `owner` is the string the account's signed texts use (here always `id`) |
| `POST /` `{ enc_pub, sig_pub, passcode: { secret_kind: "passphrase", salt, params: { m, t, p }, iv, ct, auth }, recovery: { secret_kind?: "recovery", salt, iv, ct, auth }, replace? }` | `{ success: true, kid }`. The first keys, or with `replace: true` new ones when everything was lost: the old `{ kid, sig_pub }` joins `past`, the client list is emptied, pending links are dropped, and old messages can no longer be opened. `400 bad_key`, `400 bad_backup`, `400 passphrase_required`, `400 weak_kdf`, `409 already_has_keys`, `429 rate_limited` (5 an hour) |
| `POST /unlock` `{ kind: "passcode" \| "recovery", auth }` | `{ iv, ct }`, the locked keys, when `SHA-256(auth)` matches. `403 wrong_passcode { tries_left }`; after 10 wrong ones `423 passcode_locked { tries_left: 0 }` until the recovery code is used (which starts the count again); `403 wrong_recovery_code`; `404 no_backup`; `429 rate_limited` (60 an hour per kind) |
| `PUT /backup` `{ kind, ...the blob as above, ts, proof }` | `{ success: true }`: a new passphrase or recovery code. `proof` = ECDSA by the account key over `nke1 proof\|backup\|<owner>\|<ts>`, `ts` within 5 minutes. `400 stale_proof`, `403 bad_proof`, `404 no_keys`, and the blob's errors |
| `PUT /clients` `{ doc: { seq, list }, sig }` | `{ success: true }`: the signed list of linked clients (§4c.6). `seq` must be higher than the stored one (`409 stale_clients { seq }`), a revoked client stays revoked and at most 20 are active (`400 bad_clients`, `400 too_many_clients`), `sig` must be the account key's (`403 bad_signature`) |
| `POST /link` `{ enc_pub, label? }` | `{ code, kind: "device", expires_at }`: a new device asks for the keys. `enc_pub` is an ephemeral P-256 key; `code` is 10 Crockford characters of `SHA-256(enc_pub)` as `XXXXX-XXXXX`, shown on both devices, so the server cannot swap the key. Valid 10 minutes. `404 no_keys`, `429 rate_limited` (20 an hour) |
| `GET /link/<code>` | `{ kind, enc_pub, sig_pub, label, app, state: "waiting" \| "approved" \| "denied", sealed, expires_at }`. `404 link_not_found` |
| `POST /link/<code>/approve` `{ sealed: { e, i, w } }` | `{ success: true }`: a device that has the keys seals them to `enc_pub` (as a wrap, 4d.1). `409 link_used`, `400 bad_sealed` |
| `POST /link/<code>/deny` | `{ success: true }` |

Linking a third-party app as a client of its own (its own key pair in `clients.list`) is not offered here yet; the list and its rules are in place for it.

Gateway, on the home: `{ type: "e2ee_keys_changed", id }` to the account's own connections and to everyone it shares a DM hosted here with (drop the kept key document); `{ type: "e2ee_link_request", kind, label }` and `{ type: "e2ee_link_done", state, code }` to the account's own connections. Other homeservers are not told: their accounts learn of new keys through `stale_keys`, a signature by a key they do not know, or the 10-minute copy running out, each time asking with `?fresh=1`.

Tables `e2ee_accounts (user_id, kid, enc_pub, sig_pub, clients_doc, clients_sig, past, created_at, updated_at)`, `e2ee_backups (user_id, kind, type, salt, params, blob_iv, blob_ct, auth_hash, fails, updated_at)`, `e2ee_links (code_hash, user_id, kind, enc_pub, sig_pub, label, app, state, sealed, expires_at)`. They go with the account.

#### 4d.3 The host: what a DM takes

The DM object says `"e2ee": true`. On its channel:

- **Post** `POST /api/v1/channels/<channel>/messages { enc, reply_to? }` (or the gateway's `chat_send { channel, enc, reply_to?, nonce }`); **edit** `PATCH /api/v1/messages/<id> { enc }` with an envelope signed for `edit_of` = that id. Anything readable next to or instead of the envelope (`message` / `body`, `attachments`, `embeds`, `sticker`, `signature`, `alias`) is refused: `400 e2ee_required`. `enc` anywhere that is not a DM: `400 e2ee_not_here`. A malformed envelope: `400 bad_envelope` (`v` must be `2`), `400 message_too_long { max }`, `400 too_many_wraps { max }`.
- The envelope is stored as sent (only the fields of 4d.1; anything else in it is dropped) and never opened. A message of a DM is `{ ..., "body": "", "attachments": [], "enc": { ... } }` in every view (post, history, pins, gateway events); `reply.body` of a reply is `""` (the quote is in the payload's `r`).
- **Coverage.** Before storing, the host looks at each member's key document (its own accounts' directly, others' through s2s with the 10-minute copy) and expects a wrap for the member's **account** kid. A member that is missing one is asked about once more (`fresh`), and then `409 stale_keys { members: [id, …] }`: the sender fetches those documents with `?fresh=1`, seals again and retries once. Members that have no keys yet, or whose homeserver cannot be reached, are not checked. This helps senders with old copies of keys; it is not what keeps a message private.
- `GET /api/v1/channels/<channel>/messages?kids=<kid>,<kid>` returns only those wraps of each envelope (a client names its own kids; without it all wraps come back).
- **No previews, anywhere.** `chat_mention` and push (§20) for a DM message say `sent a message` and nothing else; `dm_activity` carries no `preview` and `mention: false` (the host cannot tell who is mentioned), and a homeserver receiving a `preview` from another host does not pass it on.
- **No search**: `GET /api/v1/channels/<channel>/search` answers `{ messages: [] }`. **No link previews**: `GET /api/v1/unfurl?sid=<a DM's sid>` answers `{ embed: null }` without fetching anything, and a client must not ask any server to unfurl a link from a sealed message (the sender's device builds the preview and puts it in the payload). No AutoMod, no reports to the host.
- **Files** are encrypted on the device (AES-256-GCM, a random 32-byte key and 12-byte iv, additional data `nke1 file`) and uploaded with `POST /api/v1/media/upload?sid=<sid>&cid=<channel>&sealed=1`. The host keeps the bytes exactly as sent: no type detection, no compression, no metadata stripping, whatever the bytes look like; the answer is `{ url, name: "file.bin", mime: "application/octet-stream", type: "file", size, sha256, sealed: true }`. The link goes inside the sealed text on its own line, `<url>#nke=<key>.<iv>.<name>.<mime>` (name and mime URI-encoded), never in `attachments`. An upload to a DM without `sealed=1`, and `POST /api/v1/media/import` for a DM: `400 e2ee_required`. `sealed=1` on a server: `400 e2ee_not_here`. `/uploads/*` answers any origin, so a client fetches the file without credentials and decrypts it.
- System lines the host writes itself (someone joined or left a group, a rename, a pin) stay readable `system: true` rows.
- **Pins**: any member of a DM pins and unpins (`PUT` / `DELETE /api/v1/messages/<id>/pin`), as in Nookara's DMs; in a server it takes Manage messages.
- **Members and keys over time.** A sender wraps for the members the DM lists when it sends; someone added later gets what is sent from then on, and what was said before stays sealed to the others. Someone removed keeps what they could already open.
- **Wrapping again** (a member lost their account key and made a new one, which other members' clients see as a key change; or linked a new client): a wrap for a message may be added by **whoever sent it** (they made its key) or by **the member it is for** (from another of their clients that can still open it), nobody else. `GET /api/v2/social/dms/<id>/rewrap?member=<id>&kid=<kid>` -> `{ member, kid, messages: [id, …] (at most 500), more }`: the sealed messages sent while `member` was in the DM that have no wrap for `kid` and that the caller may wrap. `POST /api/v2/social/dms/<id>/rewrap { member, kid, wraps: { "<message id>": { e, i, w } } }` (at most 500) -> `{ added, skipped: [id] }`. `kid` must be in the member's key document now (its account key or a client not revoked: `400 unknown_kid`). A message of another DM, one sent before the member joined, one the caller may not wrap, one that has no wraps, one with 256 wraps, or one that already has a wrap for `kid` is skipped, except that whoever added a wrap this way may replace it (a wrap the sender sealed into the message is never replaced; table `dm_rewraps` keeps who added which). `400 invalid_wraps` for a malformed wrap; `404 not_a_member`. The host cannot check a wrap; the member's client checks the key commitment as for any message. The member's clients get `{ type: "social_dm_rewrapped", dm, kid, count }` and load the history again.

#### 4d.4 Reports

A reported message goes to whoever manages the **sender's** account, with the one key that opens it: the reporter's client reveals that message's `K` and nothing else.

`POST <sender's api_url>/social/reports`, with a session there (the reporter's own homeserver, or a cross-homeserver session, §4b):

```jsonc
{ "message": { "dm": "<dm id>", "id": "<the host's message id>", "from": "<sender's stable id>", "envelope": { "v": 2, ... } },
  "revealed_key": "<K, base64url, 32 bytes>",
  "reason": "harassment" | "spam" | "child_safety" | "nsfw" | "threats" | "other",
  "details": "up to 1000 characters",                                    // optional
  "context": [ { "id", "from", "envelope", "revealed_key" } ] }           // optional: up to 15 messages around it, each with its own key
```
-> `{ ok: true, id }` (`duplicate: true` when this reporter already reported that message).

Before anything is kept the homeserver checks, without trusting the reporter or the DM's host:
1. `from` is an account hosted here. A Nookara (`v:`) account whose social API is elsewhere: `409 report_elsewhere { url, api_url }`, `url` being Nookara's own DM report route (config `social.reports_url`, else `<origin of social.api_url>/api/report/dm-message`), which takes `{ source: "homeserver_dm", dm, message_id, from, envelope, revealed_key, reason, details? }` with a Nookara session and makes the same checks with the same strings. An account of another homeserver: `409 report_elsewhere { url, api_url }`, `url` being the route that homeserver's discovery names in `social.reports_url` (Nookara's, for `nookara.cc` accounts), else `<its api_url>/social/reports` (`400 sender_not_here` when that homeserver cannot be found). `404 user_not_found`; `400 cannot_report_self`.
2. The envelope was **signed by a key of the sender** (its account key, a client in its list, or a `past` key) for this `dm`, this `from` and `edit_of` = `0` or `message.id`: `400 bad_signature { signature: "invalid" | "unknown" }`. Nobody can report words the sender did not send, in a DM they were not sent in.
3. `revealed_key` **is that envelope's key**: its HMAC equals `commit` and it opens `ct` with the DM's additional data: `400 bad_revealed_key`.
4. Each `context` entry's key opens its envelope (`400 bad_context { id }`); its signature is recorded as `valid` / `invalid` / `unknown` when its sender is an account of this homeserver and `unchecked` otherwise.

Limits: 10 an hour per reporter (`429 rate_limited`; refused tries count), and per reporting homeserver `reports_per_hour` of §4b (`429 homeserver_rate_limited { retry_after }`). `400 invalid_reason { reasons }`, `400 invalid_request`, `400 bad_envelope`.

The homeserver stores the envelope and the key, not the text. Its admins read a report by opening that one message in their client:

- `GET /api/v2/homeserver/reports?status=open|resolved|dismissed|all&before=<id>&limit=` (instance admin; default `open`, 50, newest first) -> `{ reports: [ { id, status, reason, details, reporter: { id, handle, display_name, avatar_url }, sender: { … }, message: { dm, id, from, envelope, edit_of }, revealed_key, context: [ { id, from, envelope, revealed_key, signature } ], note, handled_by, created_at, updated_at } ], counts: { open, resolved, dismissed }, has_more }`. To read one: AES-256-GCM-open `envelope.ct` with `revealed_key`, `envelope.iv` and additional data `nke1|2|<message.dm>|<message.from>` (a context entry: its own `from`); files in it open with the keys in their links.
- `PATCH /api/v2/homeserver/reports/<id> { status?, note? }` -> `{ report }`. `404 report_not_found`, `400 invalid_status`.

Table `dm_reports (id, reporter, sender_id, sender, dm, message_id, envelope, revealed_key, edit_of, reason, details, context, status, note, handled_by, created_at, updated_at)`, one row per reporter and message.

#### 4d.5 What is not protected

- A homeserver can replace an account's published keys; the people it talks to see a key change and can compare safety numbers. Trust is on first use.
- The host decides who is in a group, and clients seal to whoever it lists. A two-person DM is sealed to exactly two accounts.
- A host can drop, replay or reorder envelopes within a DM. It cannot read, alter or forge them, or move them to another DM (`ts` in the payload lets a reader notice).
- A database copy of the home lets its holder guess passphrases offline; that is why PINs are refused (4d.2).
- No forward secrecy: a key that leaks opens every message wrapped for it.

---

## 5. Claiming and instance administration

**Claim.** On first boot an unclaimed instance writes a setup code (`XXXX-XXXX`, Crockford base32) to stdout and to `DATA_DIR/setup-code.txt`. An authenticated user claims it with `POST /api/v1/instance/claim { code }`, which returns `{ ok: true }`. That user becomes the instance owner and an admin, and the code file is deleted.

If the env var `EMBER_OWNER=v:<nookara id>` is set (Nookara mode only), the instance boots already claimed by that user. While unclaimed, local-mode registration is always allowed so the first user can create an account.

**Stranded owner.** When the owner's account can't sign in under the running `accounts_mode` (`local` owner in Nookara mode, Nookara owner in local mode), the instance behaves as unclaimed for claiming: discovery reports `claimed: false`, a setup code is printed and saved at boot, and `POST /api/v1/instance/claim` accepts it. The claimer becomes the owner and an admin, every community the old owner owned becomes theirs, and they are added as a member. The old owner stays an admin row but can't sign in. Registration rules don't change (local registration still follows `registration`; switching to local needs a local admin, below). In Nookara mode `EMBER_OWNER` takes over from a stranded owner at boot. Bots can't claim (`403 bots_cannot_claim`).

**Settings.** `GET /api/v1/instance/settings` (admins) returns the settings below; `PATCH` with a partial object updates them.

| setting | type | notes |
|---|---|---|
| `name`, `description`, `icon_url` | string | |
| `public_url` | origin | |
| `accounts_mode` | `"velora"` / `"local"` | **requires restart**; existing principals of the other kind can no longer log in. When the owner switches to the kind their own account isn't, the PATCH response adds `handover_code`: after the restart they sign in with an account of the new kind and claim with it (see Stranded owner). GET also returns `running_accounts_mode`, `restart_required` and `accounts_mode_env` (true when env `EMBER_ACCOUNTS_MODE` fixes the mode, so a saved change has no effect until it is removed) |
| `nookara_url` | origin | default `https://nookara.cc` |
| `registration` | `"open"` / `"closed"` | local mode |
| `max_upload_mb` | int 1–500 | the most one file may be, unless `limits.defaults.max_upload_mb`, a tier or an override says otherwise (§19) |
| `max_backups` | int 1–50 | retained instance backups; default 10, oldest pruned first |
| `voice` | `{ cf_app_id, cf_app_secret, cf_turn_key_id, cf_turn_token }` | secrets are **write-only**; GET returns `{ cf_app_id, has_app_secret, cf_turn_key_id, has_turn_token }` |
| `youtube` | `{ enabled, ytdlp_path, cache_dir, cache_max_gb }` | optional player, §15. Defaults `true`, `"yt-dlp"` (on PATH), `""` (= `DATA_DIR/cache/yt`), `5` |
| `nookara_registration` | `"auto"` / `"off"` | default `auto`: register with `nookara_url` and use the relays (§12.11). `off`: never contact Nookara (no push, payments, daily credits, voice broker, directory). Env `EMBER_NOOKARA_REGISTRATION` overrides |
| `domain` | string \| null | the homeserver's name in server addresses (`slug@domain`); `null` / unset = the hostname of `public_url`. `400 invalid_domain` |
| `creation` | object | who may create servers (§5a): `{ mode: "admins" \| "allowlist" \| "request" \| "anyone", allowlist: [username or principal…], per_account: N \| null }`, default `{ "mode": "admins", "allowlist": [], "per_account": null }`. A PATCH may send any subset of the three. `400 invalid_creation` |
| `listed` | bool | read-only: true while any server is listed. Listing is a server's own setting now (`PATCH /servers/:sid { listed }`); the key is accepted and ignored in a PATCH |
| `tags` | string[] | ≤ 8 directory tags, ≤ 24 chars each, lower-cased, no commas |
| `bridges` | object | `{ discord_oauth: { client_id, client_secret } \| null, discord_shards: 1-64 }` (§16). The secret is write-only: GET returns `{ discord_oauth: { client_id, has_secret } \| null, discord_shards }`, and a PATCH without it keeps the stored one. `400 invalid_bridges` |
| `push` | object | `{ default_gateway }`: the push gateway a pusher uses when its client names none (§20); `https`, default `https://nookara.cc/_ember/push/v1/notify`; `null` = the default. `400 invalid_push` |
| `invites` | object | `{ url_base, clients: [ { name, url, icon_url? } ] }` (§3): where invite links point and the clients the invite page offers (up to 12; `http(s)` without credentials, `url_base` without `?` or `#`); `null` (whole or a key) = the default. `400 invalid_invites` |
| `limits` | object | `{ defaults, tiers }` (§19); normally edited through `/api/v2/homeserver/limits` |

`GET` (and `PATCH`) also return read-only relay status: `velora: { registration, nookara_url, registered, instance_id, trusted, voice: { cap_minutes, used_minutes } | null, registered_at, last_error, voice_backend: "direct" | "broker" | null, directory: { listed, hidden_by_staff, pushed_at, last_error } }`. `POST /api/v1/instance/velora/register` (admins) registers right away and returns the same object; it takes no body (a `token` field is ignored: Nookara tokens never go to an instance). `GET /api/v1/instance/owner-attestation` (instance owner only) returns `{ attestation, instance_id }` for the payee flow (§12.1).

On a Nookara-hosted (managed) instance `GET`/`PATCH` also return `managed` (same object as in discovery), `max_upload_mb` is capped by the plan, and `accounts_mode`, `public_url`, `nookara_url` and `nookara_registration` cannot be changed (`403 managed_setting`); see §19.2.

The settings live in `DATA_DIR/config.json`, a file you can edit by hand. The instance watches it and reloads it, and API writes rewrite it. `DATA_DIR/config.json` is the source of truth for these keys.

### 5a. Many servers per homeserver
- A homeserver hosts any number of communities ("servers"). `POST /api/v1/servers { name, slug? }` or an import (`POST /api/v1/import`, the Matrix import, a Nookara import bundle) each make a **new** one, owned by whoever creates it; the instance must be claimed (`409 instance_not_claimed`).
- **Who may create** is the `creation` setting. Instance admins always may. `mode: "admins"` (default): nobody else (`403 forbidden`). `"allowlist"`: also the usernames / principals on `allowlist`. `"anyone"`: every account. `"request"`: creating answers `403 creation_requires_approval { request_url }`; the account asks instead (below). `per_account` caps how many servers one non-admin account may own (`403 creation_limit { limit, used }`). Bots never may.
- **Asking for a server** (mode `request`; `server-requests.js`). `POST /api/v2/server-requests { name, slug?, description?, note? (up to 500) }` -> `{ request }`; one pending request per account (`409 request_pending`), the slug is checked as for creating (`invalid_slug`, `409 slug_taken`, also against pending requests), `per_account` counts as for creating, `400 requests_not_used { mode }` in another mode. `GET /api/v2/server-requests` -> `{ requests, request_url }` (the caller's, newest first), `DELETE /api/v2/server-requests/:id` takes a pending one back (`404 request_not_found`). A request is `{ id, name, slug, description, note, status: "pending" | "approved" | "rejected" | "cancelled", reason, created_at, decided_at, sid }` (`sid`: the server made from it), and in admin lists also `account { id, username, display_name }`.
  - Admins: `GET /api/v2/homeserver/server-requests?status=pending|approved|rejected|cancelled` -> `{ requests }` (default pending). `POST /api/v2/homeserver/server-requests/:id/approve { name? }` makes the server as asked, owned by whoever asked (a slug taken meanwhile: one is derived from the name) -> `{ request }`; `POST .../:id/reject { reason? (up to 300) }` -> `{ request }`. `404 request_not_found` for one that is not pending.
  - Admins hear of a new request on the gateway (`{ type: "homeserver_pending", kind: "server", request }`) and, with a Nookara account, in their Nookara inbox (relay notice §12.13 `server_request`, `community_name` = the name asked for). Whoever asked hears the answer: `{ type: "server_request_update", request }`.
- **Slugs and addresses.** Every server has a unique `slug`: 3-32 characters, `^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$`, no `--`, and not one of `admin api www mail help support status nookara ember root system i invite login account settings uploads well-known static assets`. Create takes an optional `slug` (`400 invalid_slug`, `409 slug_taken`); without one it comes from the name (lowercased, everything else becomes `-`, then `-2`, `-3`… when taken; 8 random characters when the name gives nothing usable). `PATCH /api/v1/servers/:sid { slug }` changes it: the server's owner only (`403 owner_only`). Server objects carry `slug` and `address` = `slug@domain`.
- `GET /api/v1/servers/resolve?address=<slug@domain or slug>` (public: no session, any origin, 120 a minute per address) → `{ sid, slug, address }`; `404 server_not_found`, or `404 wrong_homeserver` when the domain is not this homeserver's.
- The homeserver's `name` / `description` / `icon_url` are its own; nothing is mirrored between them and a server's in either direction.
- `GET /api/v1/discover` returns every listed server plus the ones you are in (a homeserver with a single server returns it whether listed or not, as before).
- Deleting a server (`DELETE /servers/:sid`, its owner or an instance admin) removes that one only. With none left, discovery shows `community: null`.
- **Routes that never had a sid** (`GET /bridge/:platform/guilds`, the game routes' optional `sid`, backups below) take `?sid=` (or `sid` in the body). Without it they use the only server when there is exactly one, and answer `400 sid_required` when there are several.
- Joining = `POST /servers/:sid/join` (follows `join_policy`) or an invite code. There is no auto-join setting any more.
- **Every server, for admins.** `GET /api/v2/homeserver/servers` (instance admins) -> `{ servers: [ { sid, slug, address, name, icon_url, owner: { id, username } | null, member_count, listed, created_at, limits_override: bool, tier: "<id>" | null } ], has_more }`, newest first. `?limit=` (default 50, at most 200) and `?before=<sid>` (the last `sid` of the page before).

**Other admin routes:**
- `POST /api/v1/instance/restart` (admins) returns `202 { ok: true }`. The instance broadcasts `{type:"instance_restarting"}`, closes its sockets, and calls `process.exit(75)`. The supervisor (docker `--restart unless-stopped`, systemd `Restart=always`, or the dev script) starts it again.
- `GET /api/v1/instance/update` (admins) returns `{ supported, reason?, current: build, latest?, running?, outdated?, update?, reachable?, error? }`. `supported` is false (`reason`: `not_configured` / `managed`) unless the instance was started with `EMBER_UPDATE_URL` + `EMBER_UPDATE_SECRET` (its host agent's API and bearer) and is not in managed mode. `latest` / `running` are build objects (`version`, `commit`, `commit_short`, `commit_date`, `built_at`, `build_id`, `message`), `outdated` whether a newer build is available, `update` the host's run state (`state`: `idle` / `running` / `done` / `failed`, `step`, `started_at`, `finished_at`, `output` tail). `POST /api/v1/instance/update` (admins) asks the host agent to rebuild and recreate this container: `200 { ok: true, update }` is sent before the container stops. Errors: `501 update_not_supported` / `update_managed`, `409 update_in_progress`, `502 update_service_unreachable` / `update_service_rejected` / `update_service_error`. The server then goes away for a short while; clients poll `GET` until it answers again with a different `current.build_id`.
- `GET /api/v1/instance/admins` returns `{ admins: [user…], owner: user }`. `PUT /api/v1/instance/admins/:uid` and `DELETE /api/v1/instance/admins/:uid` are owner-only.
- Switching `accounts_mode` from `velora` to `local` (`PATCH /api/v1/instance/settings`) needs an instance admin with a local account (`409 local_admin_required` otherwise; the settings list them as `local_admins`). `POST /api/v1/instance/local-admin { username, password }` (owner-only, works in Nookara mode) makes one: a local account that is an instance admin and has an Administrator role in the server `sid` (body, optional: the only server when there is one; with several and no `sid` the account is an instance admin only).

---

**Moving a server here.** `POST /api/v2/homeserver/import?owner=<principal>&slug=<slug>&previous_url=<origin>` (instance admins; multipart `file`: a `bonfire-export-v1` zip, up to 1 GB) imports a server for its owner: `owner` is the principal of an account here, or `v:<Nookara id>` while Nookara accounts are this homeserver's (`accounts.nookara_identity`; a placeholder account until they first sign in; `400 nookara_accounts_off` otherwise). `slug` is the address it keeps (`400 invalid_slug`, `409 slug_taken { slug }`; left out: the export's own, else one from the name). `previous_url`, the origin the server had (a Nookara-hosted `https://e-<slug>.nookara.cc`), joins discovery's `previous_urls` (after the homeserver's own earlier addresses; at most 1000 kept), so signatures made for it still check out (`400 invalid_previous_url`). -> `{ sid, slug, address, owner }`. `404 owner_not_found`, `400 no_file`. Nookara's `scripts/migrate-hosted.js` moves its hosted servers into its homeserver with it.

### 5b. Backups

Available on every instance (self-hosted, Starter and Plus). Authentication uses an **instance session**, never a Nookara token. Backups are portable `bonfire-export-v1` ZIPs (section 9), saved in `DATA_DIR/backups/<id>.zip` with a SQLite index. A backup belongs to **one server**; `max_backups` (default 10, configurable 1-50 through instance settings) is kept per server, the oldest removed first. The routes take the server as `?sid=` or body `sid` (§5a: optional while there is one server, `400 sid_required` with several). Lowering the setting through PATCH prunes immediately.

A backup is `{ id: <32 hex chars>, sid: <its server, null once deleted>, created_at: <ms>, size: <bytes>, by: <principal>, note: <string> }`. Notes are optional strings up to 300 characters.

| route | authorization | body / result |
|---|---|---|
| `POST /api/v1/instance/backups` | instance admin (owner always) | `{ sid?, note? }` -> `{ backup }`; `409 no_community` if there is no server |
| `GET /api/v1/instance/backups?sid=` | instance admin | `{ backups: [backup...] }` of that server, newest first |
| `GET /api/v1/instance/backups/:id/download` | instance admin | `application/zip`, attachment `<id>.zip` |
| `DELETE /api/v1/instance/backups/:id` | instance admin | `{ ok: true }` |
| `POST /api/v1/instance/backups/:id/restore` | instance owner only | `{ sid? }` -> `{ ok: true, sid }`; goes back over the server it was taken from (or `sid`); a server deleted since comes back as a new one |
| `POST /api/v1/instance/restore?sid=` | instance owner only | multipart `file` (export ZIP, max 500 MB) -> `{ ok: true, sid }` |

Unknown IDs return `404 backup_not_found`. Read-only mode permits list/download and rejects all four write operations with `403 read_only`. Non-admins receive 403; restore by a non-owner admin receives `403 owner_only`.

Restore validates the archive, takes an automatic safety backup with note `before restore` when a community exists, then replaces that one server through the normal delete/import paths in a transaction; every other server on the homeserver is left alone. A failed import rolls back the database; the safety ZIP remains subject to normal retention. The restored server keeps its owner, its slug and its backups (a server that no longer exists comes back owned by whoever restores it). IDs are remapped, so clients must discard cached community/channel IDs. Success sends `instance_restarting` to that server's members, closes their gateway sockets with code 4010 (nobody else is disconnected), and returns the new `sid`; reconnect and reload discovery/server detail. The process stays running. Instance settings for relays, registration, admin accounts, and identity keys remain in place. An empty instance can also restore an uploaded ZIP (there is nothing to safety-back up).

### 5c. Build, stats and updates (`GET /api/v1/instance/info`)

`GET /api/v1/instance/info` needs no sign-in and returns `{ software, protocol, version, name, build }` (`build` as in §3). With an **instance admin / owner** bearer it also returns:

```json
{
  "admin": true,
  "runtime": { "node": "v22.23.3", "uptime_s": 12345, "started_at": "<ISO 8601>", "platform": "linux" },
  "stats": { "members": 12, "channels": 8, "messages": 4521, "upload_count": 80, "upload_bytes": 52428800, "db_bytes": 3145728, "bots": 2, "emojis": 14, "sounds": 3 },
  "update": { "outdated": true, "latest": { "version": "0.1.0", "commit": "<40 hex>", "commit_short": "abc1234", "commit_date": "<ISO>", "built_at": "<ISO>", "build_id": "<id>", "dirty": false, "message": "<commit subject>" }, "checked_at": "<ISO>" } | null
}
```

`stats` is cached for 30 s. `update` is `null` when the server cannot tell (no `build.build_id`, `EMBER_UPDATE_CHECK=0`, Nookara unreachable and nothing cached). The comparison is against **`GET https://nookara.cc/bonfire/server-latest.json`** (override: env `EMBER_LATEST_URL`), which returns the object that appears as `update.latest` (plus `published_at`). The server caches it for 1 hour (10 minutes after a failure) and fails silently. `outdated` is true when `latest.build_id` differs from `build.build_id` and `latest.built_at` is newer. Only admins ever see `update`.

Release flow (operators): `/root/bonfire-release.sh` on the Proxmox host builds the image on the Docker LXC with the commit baked in (`EMBER_BUILD_*` build args), publishes `server-latest.json` (`POST NOOKARA/bonfire/server-latest`, Bearer = the hostd secret), and bonfire-hostd (`POST /update-all`) recreates every hosted container on the new image one at a time, health-checked, rolled back on failure. bonfire-hostd also does this check every 10 minutes by itself.

### 5c.1 Landing page and public stats (`GET /`, `GET /api/v1/instance/stats`)

`GET /` (and `HEAD /`) with `text/html` (or `application/xhtml+xml`) in `Accept` returns an HTML landing page: the server's card (banner, icon, name, description, member count, join policy), live numbers, an "Open in Ember" link (`https://ember.nookara.cc/server/<host>` on https, else `https://ember.nookara.cc/#/i/<encoded origin>`) and Open Graph / Twitter tags. Any other `Accept` (none, `*/*`, `application/json`) gets the same JSON as before. No other path changes.

`GET /api/v1/instance/stats` needs no sign-in and returns counts only (cached 5 s):

```json
{ "name": "...", "description": "...", "icon_url": "https://...", "banner_url": null,
  "members": 375, "online": 11, "connections": 14, "channels": 9,
  "uptime_s": 86400, "started_at": "2026-11-15T00:00:00.000Z", "version": "0.1.0",
  "join_policy": "open", "url": "https://chat.example", "ember_url": "https://ember.nookara.cc/server/chat.example" }
```

`online` = people with at least one signed-in gateway socket (bots left out); `connections` = every signed-in socket, bots too. Nobody is named.

### 5d. Profile freshness (Nookara accounts)

A Nookara member's `username` / `display_name` / `pfp` follow their Nookara profile: the instance refreshes them from `GET NOOKARA/bonfire/profiles?ids=1,2,3` (public, ≤ 100 ids, `{ profiles: [{ id, username, display_name, pfp }] }`) on every gateway `chat_hello` (at most once per account per 10 minutes), every 15 minutes for members, and at sign-in. A change emits `chat_identity_update { user, previous_username }` to every community the person is in; system lines (`body_parts`) already render the current name. Clients should patch every cached `author` / `subject` / member whose `id` equals `user.id` (principal, e.g. `v:12`). A client that learned about a change sooner (Nookara's own `user_update` event) may send `chat_profile_refresh { velora_id }` to make the instance re-read that one profile right away (no reply; throttled to one fetch per account per 15 s). Env `EMBER_PROFILE_SYNC=0` turns the refresh off (so does `nookara_registration: "off"`).

## 6. Communities: REST (compatibility rule)

**Rule:** every endpoint below uses the same path as Nookara's current `routes/chat.js`, with the `/chat` prefix replaced by `/api/v1`. It has the same request body and the **same response JSON shape** as Nookara returns today. The only difference is that user ids are principal strings (§4).

A server/community object gains these fields:
- `join_policy`: `"open"` or `"request"`
- `allow_signing`: bool, true in nookara mode (signing is always allowed there and never required). Older clients may still send `allow_signing` / `require_signing` in `PATCH`; they are ignored.
- `allow_uploads`: bool
- `upload_max_mb`: int; the community default edited by community settings (never the caller's role limit)
- `my_upload_max_mb`: int; the caller's effective per-file limit with roles, instance ceiling and managed plan applied; returned in personalized server objects, including `GET /api/v1/servers/:sid`, server lists and community PATCH responses; omitted from broadcasts/public views without a caller
- `upload_ceiling_mb`: int; `min(instance.max_upload_mb, managed.limits.max_upload_mb if set)`, the maximum the client can offer in the role upload-limit field
- `listed`: bool
- `instance`: the normalized origin of the instance

Core subset for v1:
- **Servers:** `GET/POST /servers`, `GET/PATCH/DELETE /servers/:sid`, `PUT /servers/:sid/layout`, `POST /servers/:sid/join`, `POST /servers/:sid/leave`, `GET /invite/:code` (public), `POST /join/:code`, `POST/DELETE /servers/:sid/icon|banner`
- **Members:** `GET /servers/:sid/members` (each member also has `joined_at`, ms), `DELETE /servers/:sid/members/:uid` (`?ban=1`), `DELETE /servers/:sid/bans/:uid`, `GET /servers/:sid/bans`
- **Roles:** CRUD on `/servers/:sid/roles[/:rid]`, `PUT /servers/:sid/roles/order`, `PUT/DELETE /servers/:sid/members/:uid/roles/:rid`
- **Channels:** `POST /servers/:sid/channels`, `PATCH/DELETE /channels/:cid`, `PUT /channels/:cid/perms`
- **Messages:** `GET/POST /channels/:cid/messages`, `POST /channels/:cid/read`, `PATCH/DELETE /messages/:id`, `GET /messages/:id/reactions`, `PUT/DELETE /messages/:id/reactions/:emoji`, `PUT/DELETE /messages/:id/pin`, `GET /channels/:cid/pins`, `GET /channels/:cid/search`, `GET /channels/:cid/viewers` (`{ all: true }` when nothing limits who sees it, else `{ all: false, ids: [principals] }`; Ember shows only those in the member list)
- **Identities and settings:**
  - `GET /identities?ids=` takes principal ids and returns `{ users: [user…] }`.
  - `GET/PATCH /settings` stores the user's per-instance settings, e.g. `server_order`.
- **Emojis:** `GET /servers/:sid/emojis`, `POST /servers/:sid/emojis` (multipart `file`, `name`), `DELETE /servers/:sid/emojis/:eid`
- **Stickers:** `GET /stickers`, `GET /servers/:sid/stickers`, `POST /servers/:sid/stickers` (multipart `file`, `name`), `PATCH/DELETE /servers/:sid/stickers/:tid` (§6.1.1)

Member routes take the principal id (`:uid`) where Nookara took a username.

Also ported from Nookara with the same paths and shapes (details in the sections named):

| area | routes |
|---|---|
| Channel types (§6.1) | `POST /servers/:sid/channels` and `PATCH /channels/:cid` accept `type` + `config` |
| Roles shop | `GET /channels/:cid/shop`, `POST/DELETE /channels/:cid/shop/:rid`, `GET /channels/:cid/shop/:rid/status` (paid roles, §6.1) |
| Starboard | `GET /channels/:cid/starboard[?before=<starred_at>]` |
| Webhooks (§13) | `GET/POST /channels/:cid/webhooks`, `PATCH/DELETE /hooks/:wid`, `POST /hooks/:wid/avatar`; execute: `/webhooks/:wid/:token` |
| Soundboard (§6.2) | `GET /sounds`, `GET/POST /servers/:sid/sounds`, `PATCH/DELETE /servers/:sid/sounds/:id` |
| Link previews (§6.3) | `GET /unfurl?url=` |
| Bots (§14) | `GET/POST /bots`, `GET /bots/by-name/:username`, `POST /bots/by-name/:username/add`, `PATCH/DELETE /bots/:id`, `POST /bots/:id/avatar`, `POST /bots/:id/token` |
| Slash commands (§14.2) | `GET /servers/:sid/commands`, `POST /servers/:sid/interactions`, `DELETE /servers/:sid/interactions/messages/:id`, `GET /servers/:sid/commands/manage`, `PUT /servers/:sid/commands/permissions` |
| Notifications | `GET /notify`, `PUT /notify/:target` (`{ level: default|all|mentions|none, mute_minutes: 0 unmute | -1 forever | n, push }`) |
| Search | `GET /servers/:sid/search?q=` with `from:name`, `in:channel`, `has:image|video|file|link|embed|sound|audio` (voice, link, roles-shop and starboard channels are never searched) |
| Emojis | `GET /emojis/:eid/info` |
| YouTube (§15) | `POST /yt/:id/prepare`, `GET /yt/:id/status`, `POST /yt/:id/save`, `GET /yt/stream/:id` |
| Discord / Fluxer bridge (§16) | `GET/PATCH /bridge/settings`, `GET /bridge/platforms`, `GET /bridge/:platform/guilds`, `GET/PUT/PATCH/DELETE /bridge/servers/:sid`, `PUT /bridge/servers/:sid/channels/:cid` |
| CloudLink (§17) | `GET /channels/:cid/cloudlink`, `POST /channels/:cid/cloudlink/reconnect` |
| Ember Link / Minecraft (§18) | `/game/*` |

### 6.1 Channel types

`type` is one of `text`, `voice`, `logs`, `roles`, `welcome`, `link`, `starboard`, `game` (Ember Link, §18). Anything else is `text`. `config` is validated and cleaned per type (Manage channels; the response shows the cleaned value):

| type | `config` | posting |
|---|---|---|
| `text` | `{}` | needs Send (and not locked) |
| `voice` | `{ allow_call_in, user_limit 0–99 }` | no chat |
| `logs` | `{}` - webhooks post here (§13); or a CloudLink bridge `{ mode: "cloudlink", url, room, username }` (§17) | only Manage messages (and webhooks / bots with the permission); a CloudLink channel: needs Send (and not locked) |
| `welcome` | `{ allow_chat, join: [template…], leave: [template…] }`; a template contains `{user}` (and may use `{server}`, `{count}`), ≤ 20 of ≤ 200 chars, others are dropped | Manage messages, unless `allow_chat`; the instance posts a system line (`sys_kind` `join` / `leave`, with the `subject` account) here when someone joins or leaves, using the templates or a built-in default |
| `link` | `{ url }` (http/https, else `400 bad_link`) | no chat |
| `roles` | `{ items: [{ rid, price 0–1000000, desc ≤ 200, cat?, color? }] ≤ 25, categories?: [{ id (1–12 letters/digits), name ≤ 40, style: "cards" \| "buttons" }] ≤ 10 }`, roles must be below yours and not Administrator (`shop_admin_role`), needs Manage roles. Order is the array order. `cat` names a category (unknown ones are dropped: the role shows first, with no category); `color` (`#rrggbb`) is the role's colour in this shop only. `GET /channels/:cid/shop` returns `categories` and each item's `cat` / `color` | no chat |
| `starboard` | `{ watch: [cid…] (none = every text/welcome/logs channel), min 1–100 (default 3) }` | no chat |
| `game` | `{ game, instance, purpose, events, address, show_players, show_server_tag }` (§18.3); not set up = managers only, `console` = Manage server only | only `purpose: "chat"` (needs Send) |

A locked channel always needs Manage messages. `can_post` in `GET /servers/:sid` reflects all of this.

**Roles shop.** `GET /channels/:cid/shop` → `{ items: [{ role, price, desc, has, owned, pending? }], balance: null, owner_free, payments: "velora" | "unavailable" | "velora_required" }` (`balance` is null: the instance has no credits; `owned` = free, you are the owner, or you bought it; `pending` = your open pay request for that role). `POST /channels/:cid/shop/:rid` (body `{ price? }`, the price the client showed: `409 price_changed` if it differs) self-assigns a free or already bought role. `DELETE` takes the role off. Both return the shop view and push `chat_member_update` + `chat_perms_changed`.

**Paid roles** go through Nookara credits (§12.5): for a priced role you have not bought (and you are not the owner), `POST` creates a Nookara pay request and answers `200 { ...shop view, pending: true, pay_request: { id, status: "pending", approve_url, amount, expires_at } }`. Asking again while it is open returns the same request. The client opens `approve_url` (Nookara's Pay / Cancel page), then polls `GET /channels/:cid/shop/:rid/status` → `{ status: "none" | "pending" | "paid" | "declined" | "expired" | "failed", pay_request, ...shop view }` (the instance also polls Nookara itself). On `paid` the instance has verified the receipt and granted the role (`chat_member_update`, `chat_perms_changed`, and to the buyer `chat_shop_update { server, channel, rid, status }`, which is also sent for `declined` / `expired`). `failed` carries `pay_request.error` (e.g. `receipt_wrong_amount`). Like Nookara's own shop, a bought role is kept: take it off and put it back on for free; there are no refunds, and deleting the role deletes the purchase. Errors: `402 velora_required` (local accounts cannot pay), `402 payment_unavailable` (the instance is not registered with Nookara, or `nookara_registration` is `off`), and Nookara's pay-request errors passed through (`403 not_subscribed`: add the instance to your Ember list; `429 too_many_requests`; `503 payee_unavailable`).

**Reactions.** `PUT/DELETE /api/v1/messages/:id/reactions/:emoji` accepts Unicode emoji or a custom key `c:<eid>` (URL-encode the path segment). For compatibility, bare `eid`, `<:name:eid>` / `<a:name:eid>`, and `:name:` of the message's community are accepted. New custom reactions require an existing emoji belonging to that community; foreign/deleted IDs return `unknown_emoji`. Users must be community members able to view the message's channel. There are at most 20 distinct reactions per message; repeat PUT is idempotent.

Message history/pins/search and `chat_reactions.reactions` return `{ emoji, count, users, user_ids }`. For custom reactions, `emoji` is always the stable key `c:<eid>`, with additional `{ emoji_id: <eid>, name, url, animated }`. `users` and `user_ids` contain the first 25 usernames/principals in reaction order. `GET /api/v1/messages/:id/reactions` returns everyone (up to 1000 per emoji) as `{ reactions: [{ emoji, count, users: [person] }] }` (same emoji keys and order; each person is the author shape: `id`, `kind`, `username`, `display_name`, `pfp`, `velora_id`), for anyone who can see the message. `chat_reactions.emoji` uses the same stable key. Render custom `url` as an image with `:name:` as its tooltip. A deleted emoji has `url: null` and a stored name fallback: show `:name:` and allow DELETE by stable key. Renaming never splits counts or prevents removal. Historical name-bearing storage tokens remain readable and exports keep their name snapshot; import remaps tokens to the imported emoji IDs. Unicode reactions and starboard behavior are unchanged.

**Starboard.** The ⭐ reaction is the vote. When a message in a watched channel reaches `min` stars it is added to the board and stays (only deleting the message or channel removes it). `GET /channels/:cid/starboard` → `{ recent: [message + { channel_name, starred_at, stars, starred }], more, top, throwback, total, min, watching }`; `?before=<starred_at>` pages back and returns only `{ recent, more }`. Entries from channels you cannot see are left out.

### 6.1.1 Stickers

Stickers are like custom emojis but bigger and server-only: a sticker can only be sent in channels of the server that owns it. A sticker is `{ tid, name, animated, url }`: `tid` is `t` + 10 hex, `url` is `<instance>/uploads/stickers/<tid>.<ext>`.

- `GET /servers/:sid/stickers` (members) -> `{ stickers, max: 30 }`. `GET /stickers` -> `{ servers: [{ sid, name, icon, stickers }] }` for every server the caller is in that has stickers.
- `POST /servers/:sid/stickers` (Manage server, multipart `file` + `name`) -> `{ sticker }`. Names follow the emoji rules (letters, digits and `_`, up to 32; a missing name falls back to the file name). The file must be **PNG, GIF, WebP or APNG** (checked by magic bytes; `animated` is detected) and **at most 512 KB**. Errors: `too_many_stickers` (30 per server), `file_too_large` (413), `images_only`, `no_file`, `name_required` (PATCH).
- `PATCH /servers/:sid/stickers/:tid { name }` and `DELETE /servers/:sid/stickers/:tid` need Manage server; both are audit-logged (`sticker_create`, `sticker_update`, `sticker_delete`). Any change emits `{ type: "chat_stickers_update", server: "<sid>", stickers: [...] }` to the whole server.
- **Sending.** `POST /channels/:cid/messages` and the gateway `chat_send` accept `sticker: "<tid>"` (one per message). A tid that does not belong to the channel's own server is `400 unknown_sticker`. A message with a sticker may have an empty `message`.
- **Message view.** A message sent with a sticker carries `sticker: { tid, name, url, animated }` in history, pins, search, `chat_message` and `chat_message_update`. If the sticker was deleted afterwards the field stays as `{ tid, name: null, url: null, animated: false, deleted: true }` so clients can show "Sticker deleted". Messages without a sticker have no `sticker` field. Bots can read the message as usual (empty `content`); the Bot API has no sticker sending.
- **Clone lock.** Server settings `emojis.allow_cloning` (default `true`, Manage server) says whether other servers and Nookara personal emojis/stickers may copy this server's emojis and stickers. The server view and each entry of `GET /emojis` / `GET /stickers` carry `allow_cloning`. A copy is recognised by the file's SHA-256 (Ember clones by uploading the same bytes): `GET /clone-check?sha256=<hex>[&velora_id=<Nookara id>]` (no login) -> `{ locked: true, reason: "cloning_disabled" }` when this server has a picture with those bytes and cloning off, unless that Nookara account is the server's owner or has Administrator; else `{ locked: false }`. Emoji/sticker uploads take an optional multipart `from` (the address the picture was copied from): when it is another Ember server, that server's `/clone-check` is asked; in Nookara mode Nookara's `/chat/clone-check` is asked too (a locked personal emoji/sticker). Either says locked -> 403 `cloning_disabled` / `clone_locked`. A peer that does not answer within 4 s counts as not locked. A changed picture (re-saved, cropped) is not recognised.
- **Origin.** A copy remembers where its bytes were first seen: `origin` is `{ type: "server", name, host }` or `{ type: "user", user_id, username }` (a Nookara personal emoji/sticker). It comes from the `/clone-check` answer of the server named by `from` (else Nookara's), is stored with the copy, and shows on emoji/sticker views, `GET /emojis/:eid/info` and a message's `sticker`. `/clone-check` returns `origin` too: the oldest copy's stored origin, else this server, so a copy of a copy keeps the first. Pictures that are not copies have no `origin`.
- **Export.** `community.json` has `stickers: [{ tid, name, animated, file }]` (files under `files/`) and messages have `sticker: "<tid>"`; import gives them fresh ids and remaps the messages.

### 6.2 Soundboard

Sounds belong to the community: `GET /servers/:sid/sounds` → `{ sounds: [{ id, name, emoji, volume, duration, url }], max: 30 }`; `GET /sounds` → `{ servers: [{ sid, name, icon, sounds }] }`. `POST /servers/:sid/sounds` (Manage server, multipart `file`, optional `name`, `emoji`) stores the file under `/uploads/sounds/`. The instance has no transcoder: the file must be **mp3, wav, ogg, flac or m4a** (checked by magic bytes, duration read from the headers) and **at most 5.2 s** (errors `not_audio`, `sound_too_long`, `too_many_sounds`, `file_too_large`; 8 MB ceiling). `PATCH` takes `name`, `emoji`, `volume` (5–100). Playing is a gateway frame, §7.

### 6.3 Link previews

`GET /unfurl?url=<url>` (session required, 60 / minute / user) → `{ embed }`, where `embed` is `null` when there is nothing to show (always, without a fetch, when `sid` names a DM: §4d.3), or:
- `{ type: "link", url, site, title, description, color?, image, large }`, from OpenGraph / Twitter tags (falling back to oEmbed discovery); `image` is re-hosted at `/uploads/embeds/…` so viewers never contact the site;
- `{ type: "youtube", id, url, title, channel, image }` for YouTube links.

The fetch is **SSRF-safe**: http(s) only, ports 80 / 443 only, no credentials in the URL; the host is resolved and refused if *any* address is private, loopback, link-local, metadata (169.254.169.254), CGNAT, multicast or reserved, in IPv4 or IPv6 (including IPv4-mapped, NAT64 and 6to4 forms, and numeric host spellings like `2130706433`); the connection is pinned to the address that was checked; redirects are followed manually (max 3) and every hop is re-validated; limits are 1 MB per page, 5 MB per picture, 7 s per hop, 10 s total. Results are cached in SQLite (24 h, failures 1 h). Nookara-specific cards (invites, profiles) are not made here.

New in v1:

| route | who | result |
|---|---|---|
| `GET /servers/:sid/requests` | `KICK` or `MANAGE_SERVER` | `{ requests: [ { user, message, created_at } ] }` |
| `POST /servers/:sid/requests/:uid/accept` / `…/deny` | same | `{ ok: true }` |
| `POST /servers/:sid/join` when `join_policy=request` | anyone not banned | `{ pending: true }`; a second call returns the same |
| `GET /servers/:sid/invites` | `MANAGE_SERVER` | `{ invites: [ { code, created_by, created_at, expires_at, max_uses, uses } ] }` |
| `POST /servers/:sid/invites` `{ expires_in?: seconds, max_uses?: int }` | `MANAGE_SERVER` | invite object |
| `DELETE /invites/:code` | `MANAGE_SERVER` | `{ ok: true }` |
| `GET /servers/:sid/export` | owner | `application/zip` (§9) |
| `POST /import` multipart `file` | whoever may create a server (§5a); makes a new one, owned by the importer | `{ sid }` |
| `POST /import/nookara { ticket }` | same rules as `/import` | `{ sid }`: downloads a Discord / Fluxer import prepared on Nookara (§12.6, §12.11) |
| `GET /import/matrix`, `PUT` / `DELETE /import/matrix/bot`, `GET /import/matrix/guilds[/:gid]`, `POST /import/matrix` | same rules as `/import` | a Matrix space as the community, read by the instance with a bot the admin brings (§16.7) |

Invites behave like this:
- **An invite code always admits** you, even when `join_policy=request`. That's the "anyone with the link" path.
- A bare `POST /servers/:sid/join` follows `join_policy`.
- Every community keeps its legacy permanent `invite_code` field too. `PATCH { new_invite: true }` regenerates it, as before.

Permission bits are the same as Nookara's `chat.js:42-49`:

| bit | value | bit | value |
|---|---|---|---|
| SEND | 1 | BAN | 32 |
| MANAGE_CHANNELS | 2 | MANAGE_MESSAGES | 64 |
| MANAGE_SERVER | 4 | MENTION_EVERYONE | 128 |
| MANAGE_ROLES | 8 | ATTACH | 256 |
| KICK | 16 | ADMIN | 512 |
| | | VIEW (channel-only) | 1024 |
| | | MANAGE_USERS (Nookara's own chat only) | 2048 |
| | | UNMARKED_ALIASES (instances only) | 4096 |
| | | CHANGE_NICKNAME (instances only; @everyone has it by default) | 8192 |
| | | MANAGE_NICKNAMES (instances only) | 16384 |

The permission algorithm is the same as `permsOf` / `channelPermsOf` / `canView` / `canPost`. The community owner has all permissions. **Instance admins have no implicit power inside communities** unless they're a member with roles. The one exception is that instance admins may delete the community (returning the instance to setup).

**Manage users (bit 2048).** Human presence is Nookara's, not the instance's (section 7), so the invisible-status, sessions and notification-only parts below exist only in servers hosted by Nookara's own chat. An instance supports the bit too (an owner has it, `grantable` and exports keep it) but only does the **Last login** and **Client on messages** parts, described at the end of this section. A person holding it, in a server they share with someone, gets these extra fields. Everyone else gets none of them, and Nookara enforces that when it builds each payload (it is never a client-side hide):

- **Invisible people.** In `presence_update`, member lists and `chat_presence` replies, a person who set themselves to invisible has `status: "online"` and `invisible: true`, with their custom status and activities still hidden. Without the permission they stay `status: "offline"` with no `invisible` field. Clients should draw the dot hollow, not grey.
- **Sessions.** `sessions` is a list (at most 8) of the person's live connections: `state` (`active`, `background` or `notifications`), `via` (below), `platform`, `device`, `browser`, `version`, `mobile`, `app` (a custom token's project name) and `connected_at`. There are no IP addresses. A connection that is only there for notifications (an app's background service, not the app open) is `state: "notifications"`; it never makes anyone look online. If that is all they have, the presence is `status: "offline"` with `notifications_only: true`.
- **Last login.** `last_login` is the time (ms since epoch) of their last chat connection (`chat_hello`), or `null` if unknown.
- **Client on messages.** A `chat_message` / `chat_message_update` message, and messages in history, search and pins, carry `via` for everyone who can see the message (not only holders).

`via` is `{ official, kind, name, token, url }`, worked out on the server and never trusted from the client: the official Ember apps sign in with a reserved token name only the app login flow can mint, and a website session counts as official only when the browser's `Origin` is the site. Otherwise `token` is the name the person gave their sign-in token and `url` is the page's origin (never an IP address).

**On an instance** (this server): `GET /servers/:sid/members` adds `last_login` (ms, or `null` if they never connected), `last_online` (ms their last gateway connection closed, or `null`) and `online` (true while connected) to each member for holders; the instance sets `last_login` whenever a gateway connection authenticates and `last_online` when the last one closes. Messages are stored with the `Origin` of the request that posted them as `via: { url }`, plus `app` / `token` / `icon` when the session came from a registered app (the instance token's `app` claim) (an origin only; IP addresses are dropped, and nothing is stored for bots, webhooks, bridges or system messages) and carry `via` in `chat_message`, `chat_message_update`, history, search and pins for every member who can see the message, as `{ url, kind?, app? }` only (the token name and icon are kept but never sent; clients name an app from Nookara's app registry). An instance cannot tell whether a client is the official one, so it never sets `official`. Holders (and the person themselves) can also ask which clients a member is connected with right now: §7.1.

Backward compatible: older clients ignore the new fields. A client may add `client: { version, platform, device }` to its `auth_token` frame to say more about itself; it is optional, trimmed and capped.

### 6.4 Server settings, reports, timeouts, audit log, dashboard (bonfire-server only)

`GET / PATCH /api/v1/servers/:sid/settings` (Manage server). The PATCH body has any of `join_policy`, `join_password` (4-200 chars, `""` clears) and the sections below; unknown keys are ignored and nothing is saved unless every value is valid. The answer is `{ settings }`: the saved values plus `join_policy`, `has_password`, `plan` (a Nookara-hosted server's caps, else `null`), `spam_defaults`, `image_compression_available`, `instance_admin`, `audit_categories`, `file_types`.

| section | keys (default) |
|---|---|
| `join` | `allowlist` ([] usernames or principals), `max_members` (null = no limit; a hosted plan's `member_cap` is the most), `default_roles` ([] rids given to people who join; only roles below you) |
| `messages` | `max_length` (4000, 1-4000), `search_results` (25, 1-100), `max_reactions` (20 different emoji per message, 1-50), `link_previews` (true), `preview_proxy` ("" - **instance admins only**) |
| `automod` | `words_enabled` (false), `words` ([]), `word_file` ("" - a file under the data folder, one word per line, `#` comments - **instance admins only**), `whole_word` (true), `match_case` (false), `timeout_seconds` (60, 0 = only block), `exempt_roles` ([]), `spam_enabled` (false), `spam_per_minute` / `spam_burst` / `spam_pause_seconds` (null = 30 a minute, 8 within 10 s, no pause) |
| `audit` | `enabled` (true), `retention_days` (90), `retention` ({ category: days } overrides) |
| `advanced` | `unmarked_aliases` (false - **the server owner only**, `403 owner_only` for anyone else; never exported or imported): see "Unmarked aliases" in §14 |
| `uploads` | `per_minute` (30), `files_per_member` (null), `types` (["any"] or some of images / videos / audio / pdf / text / archives), `expire_days` (null = kept), `never_expire_plans` ([] Nookara plans, from the instance token's `tier` claim), `never_expire_roles` ([] rids: members with one keep their files), `storage_mb` (null), `compress` (false), `max_width` / `max_height` (1920), `max_pixels` (50000000), `jpeg_quality` (85) |

`join_policy`: `open`, `request` (a moderator lets them in), `password` (`POST /servers/:sid/join { password }` -> `password_required` / `wrong_password`), `allowlist` (`not_on_allowlist`), `invite` (`invite_only`). An invite link, and an instance admin, always gets in. A full server answers `server_full { cap }`.

Posting / editing: `message_too_long { max }` (only when a server lowered it; 4000 still trims), `timed_out { until }`, `automod_blocked { until | null }`, `slow_down { until | null }` (429). Uploads: `upload_rate_limited { per_minute }` (429), `upload_quota { limit, used }`, `file_type_not_allowed { allowed }` (415), `storage_full { limit_mb }`, `image_too_large { max_pixels }` (413); on a hosted plan the quota / storage errors are `plan_limit` (§19). `POST /media/upload` takes an optional `expires_in_days` field (shorter than the server's longest only); the answer then has `expires_at`. An expired upload is deleted and its attachments in messages get `expired: true`. The server object (`serverView`) carries `max_message_length`, `link_previews` and `member_cap` (the limit in force).

Reports: `POST /servers/:sid/reports { message_id | user_id, reason? }` (any member; `{ report: { id }, duplicate? }`). Kick, Ban, Manage messages or Manage server: `GET /servers/:sid/reports?status=open|resolved|dismissed&before=` -> `{ reports, open, has_more }`, `PATCH /servers/:sid/reports/:id { status, note? }`. Moderators get gateway `chat_report { server, report, open }`.

Timeouts: `GET /servers/:sid/timeouts`, `POST /servers/:sid/timeouts { user_id, seconds (1 .. 2419200), reason? }` -> `{ until }` (sets the end, shorter or longer; never the owner or someone as high as you), `DELETE /servers/:sid/timeouts/:uid` (Kick or Ban). The person gets gateway `chat_timeout { server, until | null, reason? }`. While timed out they can't post, add reactions (`403 timed_out { until }`), join voice (`timed_out`) or play sounds; joining a timeout drops them from voice. Their server view has `timeout_until`, and member lists show `timeout_until` on everyone timed out.

Audit log: `GET /servers/:sid/audit?category=&action=&before=&limit=` (Manage server, Kick or Ban) -> `{ entries: [{ id, action, category, actor, automod, target: { kind, id, name }, details, created_at }], has_more, actions, categories }`. Categories: `user_moderation`, `role_management`, `channel_management`, `message_moderation`, `server_management`.

Dashboard: `GET /servers/:sid/dashboard` (Manage server) -> `{ members, bots, banned, messages, open_reports, timeouts, disk, storage: [{ key, label, bytes }], health: { runtime, memory, heap, uptime_s, version, commit_short }, channels: { with_messages, empty, by_messages, by_storage } }`.

---

### 6.7 Server profiles

Servers that advertise `features.server_profiles` let a member look different on that server only: a picture, banner, name colour, bio and pronouns, plus their server nickname as the name shown there. Setting them needs the role permission `32768` ("Customize profile", off for `@everyone` unless the server turns it on; owners and Administrator have it).

- `GET /api/v1/servers/:sid/members/@me/profile` -> `{ profile, nick, can_customize }` (`profile` null = they use their global one).
- `PATCH /api/v1/servers/:sid/members/@me/profile` `{ bio?, pronouns?, color?, display_name? }` (`null` or `''` clears a field; `color` is `#rrggbb`; bio up to 300, pronouns up to 40; `display_name` sets the nickname). Errors: `not_allowed` (403), `invalid_color`, `bio_too_long`, `pronouns_too_long`.
- `POST /api/v1/servers/:sid/members/@me/profile/pfp` or `/banner` (multipart image, up to 4 MB) and `DELETE` the same path (back to the global one for that field).
- `DELETE /api/v1/servers/:sid/members/@me/profile`: everything back to the global profile, nickname included. No permission needed.
- `POST /api/v1/servers/:sid/members/:uid/profile/reset`: Manage users, and above them (never the owner), resets someone's. It is audit-logged (`member_profile_reset`), and a Nookara account is told through Nookara's notification inbox (§12.13).

The member object (member lists, `chat_member_update`) carries `profile: { pfp?, banner?, color?, bio?, pronouns? }` with only the fields that are set, and no `profile` at all for someone using their global one. On a server with its own accounts a local account's account profile (4.1) is what sits underneath: the member's `profile` is that, with the fields set for this server only on top. Clients show those instead of the person's account profile on this server (avatars and name colours in the member list and messages, and their profile card).

## 7. Gateway (WebSocket)

Connect to `ws(s)://INSTANCE/gateway`.

**Handshake**
1. The client sends `{ "type": "auth", "session": "<instance session>" }` within 10 seconds.
2. The server replies `{ "type": "auth_success", "user": <user>, "instance_admin": bool, "instance_owner": bool, "voice_quota"?: { cap_minutes, used_minutes } }` (`voice_quota` only for admins, once known, §19.4), or closes with `4001` (`invalid_session`).
3. The client sends `{ "type": "chat_hello" }`. The server replies `{ "type": "chat_ready" }` and starts sending community events.
4. The client sends `{ "type": "ping" }` every 25 seconds. The server answers `{ "type": "pong" }` and drops any socket that has been idle for more than 60 seconds.

**Client to server** frames have the same names and fields as Nookara today:
- `chat_send { nonce, channel, message, reply_to?, attachments?, signature?, sticker? }`. The server replies `chat_ack { nonce, message }` or `chat_error { nonce, error }`.
- `chat_typing { channel }` (`typing: false` = stopped). Others get `chat_typing { server, channel, username, user_id, typing }`. Someone typing on the other side of a bridge (§16.6) comes as `chat_typing { server, channel, username: "<their name there>", user_id: null, typing, bridged: { platform, name, avatar } }`: they have no account here, so a client shows `bridged.name` and `bridged.avatar` (a picture on this instance, or null) with the platform's mark, and keys them by platform + name, not by `username`.
- `chat_read { channel, message_id }`
- the `chat_rtc_*` family (§10)

**Server to client** events have the same names and shapes as Nookara today:
- Messages: `chat_message`, `chat_message_update`, `chat_message_delete`, `chat_reactions`, `chat_typing`, `chat_pins_update`
- Server and roles: `chat_server_update`, `chat_server_removed`, `chat_roles_update`, `chat_perms_changed`
- Channels and members: `chat_channels_update`, `chat_member_update`, `chat_members_stale`, `chat_emojis_update`, `chat_stickers_update`
- Identity: `chat_identity_update`
- Replies and errors: `chat_ack`, `chat_error`, `chat_ephemeral`
- Bots (§14.2): `chat_commands_update { server }`, `chat_interaction_message`, `chat_interaction_modal`
- Mentions: `chat_mention { id, server, sid, channel, cid, from, pfp, body }`, sent only to the people a message pings who are online (their `@name`, a reply to them, `@everyone`, `@here` (online members only), a role they hold, or every message if their level is `all`), minus muted / `none` settings. Everyone else goes to the server-side `notifyOffline(userIds, payload)` hook, which pushes Nookara principals through Nookara (§12.3, §12.11).
- Starboard: `chat_starboard { server, channel (the board), id (message), stars, added? }` when a watched message's stars change (`added: true` the moment it first lands on the board)
- Voice: `chat_voice_state` and the rtc replies
- Soundboard: the client sends `{ type: "voice_sound", sound: "<sound id>" }` while in a voice room (needs the `voice` scope); every socket in that room, the sender included, gets `{ type: "voice_sound", by: "<username>", channel: "<cid>", sound: { id, name, emoji, volume, duration, url } }`. Failures come back to the sender only as `{ type: "voice_sound_failed", reason }` with `not_in_voice`, `not_found`, `not_allowed`, `too_fast` (one sound per 1.2 s) or `insufficient_scope`.
- Cross-server sounds: `sound` may instead be an object, the public view of a sound from another server (`{ name, emoji, volume, duration, url }` as `GET /sounds` lists it, taken from any instance or Nookara the user is signed in to). The instance does not fetch it: it checks the shape (an `http(s)` URL with no credentials or query, whose path is `/uploads/sounds/<id>.<mp3|wav|ogg|flac|m4a>`; name, volume 5-100 and duration up to 5.3 s are cleaned; custom emoji are dropped), applies the same membership, timeout and 1.2 s cooldown checks, and relays `voice_sound` with `sound: { id: null, external: true, name, emoji, volume, duration, url }`. Plain ids keep working unchanged. Clients should only play an external `url` whose origin they already trust (Nookara, an instance they are signed in to, or the room's own instance), so a stranger's URL never makes your client contact an unknown host.

New events:
- `chat_join_request { sid, request }` goes to members who can accept.
- `chat_join_result { sid, accepted }` goes to the requester.
- `chat_server_added { server }` is sent when you join or are accepted (or the community is created for you as its owner).
- `instance_update { settings: <public subset>, voice_quota? }`: `voice_quota: { cap_minutes (null = unlimited), used_minutes }` is sent to instance admins only, after each refresh of the voice quota (§19.4).
- `instance_restarting {}`
- `chat_shop_update { server, channel, rid, status }`: your pay request for a shop role was `paid` (role granted), `declined` or `expired` (§6.1).
- Ember Link: `game_status`, `game_console`, `game_linked`, `game_unlinked` (§18.4).

**Fan-out** is per community. Each socket subscribes to the communities its user belongs to, and a member only receives an event if they can view its channel. Instances don't relay human presence: the client gets Nookara users' presence from its Nookara home socket (Manage users holders can still ask which clients a member is connected with, §7.1). Bot presence is instance-local (section 14).

**Close codes:**

| code | meaning |
|---|---|
| 4001 | invalid or expired session |
| 4003 | banned from instance |
| 4008 | rate limited |
| 4010 | instance restarting |

### 7.1 Member clients (Manage users)

An instance reports which clients each member is connected with right now: one entry per live gateway connection, on `/gateway` (Ember, third-party apps, scripts) or `/bot/gateway` (bots). This is how a profile shows the clients of instance-only accounts, bots, and Nookara members who talk to the instance directly (with no Nookara socket of their own).

**Who sees it.** The person themselves, and members holding **Manage users** (bit 2048) in a server they both belong to. Nobody else, instance admins included unless they hold the bit there. The instance checks this on every reply and again before every live update; there are no IP addresses in it.

**Session entry** (the same field names as Nookara's presence `sessions`, §6 Manage users):

| field | |
|---|---|
| `via` | `{ url?, kind?, app?, token?, icon? }` like a message's `via` (§6): `url` = the connection's `Origin` (never an IP address; absent for scripts that send none), `kind` = `desktop` / `android` (official app User-Agent marker) or `bot` (a `/bot/gateway` connection), `app` / `token` / `icon` = the registered Nookara app of the session (the instance token's `app` claim). An instance can write anything here, so clients take the app's name, logo and verified mark only from Nookara's app registry, never from these fields. |
| `state` | `active` (default), `background` or `notifications`, as the client last said (below) |
| `platform`, `browser`, `mobile` | coarse, from the User-Agent (only for browser-style `Mozilla/` agents; no versions, no device model) |
| `version`, `device`, `platform` | from the client's own `client` object in `auth` (overrides the User-Agent platform) |
| `connected_at` | ms since epoch, when the connection authenticated |

At most 8 entries (the newest), oldest first.

**REST:** `GET /api/v1/servers/:sid/members/:uid/clients` (`:uid` = the member's principal id) returns `{ server, user_id, online, sessions, last_online }` (`last_online` only while offline). Errors: `not_a_member` (403, you), `user_not_found` (404, not a member there), `not_allowed` (403, no permission).

**Gateway** (needs the `chat` scope):
- `{ type: "chat_clients_watch", server, user_id }` answers with `{ type: "chat_clients", server, user_id, online, sessions, last_online }` at once and then again whenever that member's connections change (connect, disconnect, state), coalesced over 250 ms. Refused with `chat_error { request: "chat_clients_watch", error }` (same codes as REST). A socket watches at most 16 members (the oldest watch is dropped); watches end with the socket, so clients watch again after reconnecting.
- If the watcher loses the permission (or either person leaves), the next update is `{ type: "chat_clients", server, user_id, ended: true }` and the watch is gone.
- `{ type: "chat_clients_unwatch", server?, user_id? }` stops one watch, or all with no fields.
- `{ type: "chat_client_state", state }` (`active` / `background` / `notifications`) says what this connection is doing. `auth` may also carry `state`, `mobile: true` and `client: { version?, platform?, device? }` (trimmed to 24 / 24 / 40 characters).

Older clients ignore all of this; an instance without it answers the REST route with 404 and the watch with nothing, which clients treat as "no data".

---

### 7.2 Who is here, and sleep mode

Servers that advertise `features.member_presence` say who is here: a person's member `presence` is `"online"` while they have a socket open to this server, or a fresh sleep sign-up (below), else `"offline"`; their communities get `chat_presence` when that changes (settled 2 s, as for bots in §14).

Servers that advertise `features.wake` let a client close its socket to save data without looking gone. Before closing, the client calls `POST /api/v1/wake` (any session; answers `{ ok, ttl_ms, pings }`) and renews it well inside `ttl_ms` (5 minutes) for as long as it wants to stay reachable. While the sign-up is fresh the person counts as here (above), and the first new message they can see sends one ping for them through Nookara (§12.12); `pings: false` means this server can't send them (not registered with Nookara, or a local account). One ping per sign-up: nothing more until the person connects again, which ends the sign-up (so does `DELETE /api/v1/wake`). A client that stops renewing is gone once `ttl_ms` passes.

## 8. Message signing

Signing is available only in nookara mode and only to sessions whose `scp` contains `"sign"`. It is **optional**: every community in nookara mode accepts signed messages, and no community can require them (unsigned messages are always accepted, with `verified: null`).

**What the client signs:** the UTF-8 bytes of `"bonfire-msg-v1\n" + canonical(payload)`.
- `canonical` means JSON with object keys sorted recursively, no whitespace, and numbers as integers.
- `iss` is one of the instance's `velora.signing_issuers` (discovery, §3), preferred first. On any Nookara address that list is `["https://nookara.cc", "https://velora.ikelene.net"]`: both are accepted, and clients sign with `https://nookara.cc`. Instances older than the list check `iss` against their own `nookara_url`, so a client signs with exactly `velora.issuer` there. The instance stores no `iss`; anyone re-checking a stored signature tries each Nookara issuer.
- `payload` has these fields:
```json
{
  "v": 1,
  "iss": "<one of the instance's velora.signing_issuers>",
  "instance": "<normalized instance origin>",
  "community": "<sid>",
  "channel": "<cid>",
  "author": "<nookara user id string>",
  "ts": <ms epoch int>,
  "nonce": "<b64url 16 random bytes>",
  "body": "<exact message text>",
  "attachments": ["<sha256 hex>", ...],
  "reply_to": "<message id string>" | null,
  "edit_of": "<message id string>" | null,
  "sticker": "<sticker id>"
}
```
`sticker` is there only for a message sent with a sticker (`sticker` on `chat_send` / `POST /channels/:cid/messages`, section on stickers), and an edit of one; every other payload leaves the key out, so it is unchanged.
`attachments` holds one sha256 from the upload response (section 11) per uploaded attachment, in message order. Link-only Klipy GIFs without a sha256 use `"url:" + url` instead (the exact stored URL, limited to 512 characters); this binds the link, not the remote bytes. Existing hash entries and text-only payloads are unchanged. Saved files hosted elsewhere are imported with `POST /api/v1/media/import?sid=...&cid=...` (section 11) before signing and use its returned sha256. The browser never needs to fetch the remote bytes; the instance stores, sanitizes and hashes them. No signing payload or verifier change is needed.

**How the client sends it.** `chat_send` and `POST /channels/:cid/messages` carry `signature: { kid, sig, ts, nonce }`, where `sig` is the b64url of a 64-byte Ed25519 signature. An edit, `PATCH /messages/:id { message, signature }`, uses `edit_of = id`. (The text field is `message`, as in Nookara's routes; the instance also accepts `body` as an alias on REST.)

**How the instance verifies it** (unchanged by the single account key: a signature is still checked by `kid`, and a key revoked before `ts` is rejected):
1. It rebuilds the payload from the stored fields.
2. It fetches the key from `NOOKARA/bonfire/keys/kid/:kid` and caches it for 10 minutes.
3. It requires that `key.user_id == author.velora_id`.
4. It requires that the key wasn't revoked before `ts`.
5. It requires that `|ts - now| ≤ 5 min`.
6. It verifies the signature.

If verification fails, the instance rejects the message with `bad_signature`. Bots, webhooks and system messages never carry signatures.

**What the API returns.** Each message gains `signature: { kid, sig, ts, nonce } | null` and `verified: true | false | null`. `null` means unsigned. The API also returns `reply_to` (the stored id, even if the target was deleted) for reconstructing the signed payload. **Clients verify independently** against Nookara keys, so they don't trust `verified`. An edit without a signature clears `signature` and `verified`. Exports keep signatures, and so does a later re-import.

---

## 9. Export format `bonfire-export-v1` (zip, built with `fflate`)

| path | contents |
|---|---|
| `manifest.json` | `{ format: "bonfire-export-v1", source: "<origin>", source_kind: "instance" \| "velora-legacy" \| "velora-import" \| "matrix-import", exported_at: <ms>, community: "<sid>" }` |
| `community.json` | `{ name, slug (the address it had: taken on import when free on that homeserver, else one is made from the name), description, icon, banner, settings: {join_policy, allow_uploads, upload_max_mb}, categories: [name…], channels: [ {cid, name, topic, category, position, locked, type, config, perms: [ {role: "<rid>", allow, deny} ]} ], roles: [ {rid, name, color, position, permissions, upload_max_mb, hoist, mentionable, is_default} ], emojis: [ {eid, name, animated, file} ], stickers: [ {tid, name, animated, file} ], invites: [ {code, expires_at, max_uses} ] }` |
| `members.jsonl` | one JSON object per line: `{ user: <user object>, roles: ["<rid>"…], joined_at, owner?: true }` |
| `messages/<cid>.jsonl` | oldest first, one JSON object per line: `{ id, author: <user object> \| null, author_name?, author_avatar?, body, attachments, embeds?, reply_to, created_at, edited_at, system, sys_kind?, pinned, sticker?: "<tid>", reactions: [ {emoji, users: [uid…]} ], signature?, bridge? }` |
| `files/<path>` | icon, banner, emojis, and locally hosted attachments, referenced as `files/…` from the JSON |

Import rules:
- The importer recreates the community with new ids and maps old ids to new ones for channels, roles, messages (including `reply_to`) and emojis.
- `allow_signing` / `require_signing` in the `settings` of older exports are ignored (signing is always optional, §8).
- The **owner of the import is whoever runs it**. The exported owner flag is kept only as a hint.
- `v:` principals keep their identity. `l:` principals from another instance become **name-only authors**: `author_name` and `author_avatar` are set and there is no account.
- On a nookara-mode instance, members whose principal is `v:` are recreated as members with their roles.
- Channel `config` of the typed channels (§6.1) is carried over: link `url`, welcome templates, starboard `watch` (channel ids remapped) and shop `items` (role ids remapped), CloudLink settings of `logs` channels (re-validated, at most 3) and `game` channel settings (purpose, events, address, …; the Minecraft link itself does not travel: `instance` becomes null, so the channel needs a server picked again).

---

## 10. Voice

Voice uses the same `chat_rtc_*` protocol Nookara has today (`chat_rtc_join`, `publish`, `connected`, `subscribe`, `answer`, `close`, `ice` and `leave`, plus `chat_rtc_joined`/`published`/`offer`/`ready`/`room` and `chat_voice_state`). It runs over the instance gateway, and rooms are named `bf_<cid>`.

Mute state: once connected, a client sends `{ type: "chat_voice_mute", room, muted, deafened }` (booleans; deafened implies muted) whenever either changes and right after `chat_rtc_connected`. The instance keeps the flags per participant and broadcasts them as `muted` / `deafened` on that participant's entry in `chat_voice_state { server, channel, users: [ { id, username, muted, deafened, since } ] }`, so clients can show the red mute / deafen icon. Older clients that never send it simply show as unmuted.

Resuming after a dropped socket: `chat_rtc_joined` carries `resume` (an opaque token). When a gateway socket closes while its participant is connected, the instance parks the call for 30 s instead of ending it: the participant stays in the room and in `chat_voice_state`, and its Cloudflare sessions stay open (the media never went through the gateway). A new socket of the same account sends `{ type: "chat_rtc_resume", nonce, room, resume }` and gets `{ type: "chat_rtc_resumed", nonce, room, resume, tracks, people }` (a fresh token every time; `tracks` = what it publishes, `people` = the room as in `chat_rtc_room`); it then carries on with the same peer connections. Anything else (`chat_error { error: "resume_failed" }`: unknown or spent token, another account, the grace ran out, the instance restarted) means join again with `chat_rtc_join`. A participant that disconnects before `chat_rtc_connected` leaves at once. The gateway also sends websocket pings to sockets that have been quiet for 15 s, and a pong counts as activity, so a background tab whose `{"type":"ping"}` timer is throttled is not cut off after 60 s.

Backend, chosen per join: (1) the instance's own Cloudflare Realtime keys (`voice` settings) when all four are set; else (2) **Nookara's voice broker** (§12.7) while the instance is registered and Nookara has voice set up; else `chat_rtc_join` returns `chat_error { nonce, error: "voice_unavailable" }`. Through the broker the receive session is created on the first subscribe (sessions are metered), every open session gets a heartbeat each minute, and when the instance is over its monthly cap the joiner gets `chat_error { nonce, error: "voice_cap_reached", cap_minutes, used_minutes }` (and `features.voice` turns false until Nookara answers again). A participant stays on the backend they joined with.

DM calls (`bfc_…`) stay on Nookara.

---

## 11. Uploads

(A DM takes only files sealed on the device, `?sealed=1`, kept byte for byte: §4d.3.) `POST /api/v1/media/upload` takes a multipart field `file` and requires a session with `media` scope and community setting `allow_uploads`. The `sid` query parameter is required. Clients sending to a channel also pass `cid`; it must belong to that community and be visible to the caller. ATTACH is checked with channel overrides when `cid` is present, otherwise community permissions apply. Sending an attachment still checks the destination channel's ATTACH permission.

`POST /api/v1/media/import?sid=...&cid=...` takes JSON `{ url, name? }` and returns the same upload response. It uses the same scope, membership, permission and size checks. Only HTTPS source URLs without credentials, up to 4096 characters, are accepted. The existing SSRF-safe fetcher pins public DNS addresses and rechecks redirects, ports and private addresses, with bounded size and time. No browser cookies or authorization headers are forwarded. Magic-byte detection and JPEG EXIF stripping happen before hashing, exactly as for multipart uploads. Errors: `invalid_media_url`, `media_import_failed` (422), and `file_too_large` (413, with `max_mb`). The client should offer downloading and attaching the file if the source refuses imports.

Response:
```json
{ "url": "INSTANCE/uploads/<yyyy>/<mm>/<random>.<ext>", "name": "…", "size": 123, "mime": "image/png", "type": "image|gif|video|audio|file", "sha256": "<hex>", "width"?: n, "height"?: n }
```

- Message attachments are `{ url, type, name, size, width?, height?, sha256 }`, with at most 10.
- The instance accepts only URLs that are its own `/uploads/…` or Klipy GIF URLs.
- `sha256` is the hash of the **stored** bytes, which is what the client hashes when it signs.
- The instance doesn't re-encode images in v1 because it has no native dependency. It strips JPEG EXIF via a byte-level APP1 drop and checks the type against the file's magic bytes.
- Roles accept `upload_max_mb: <integer 1-500> | null` on `POST /api/v1/servers/:sid/roles` and `PATCH /api/v1/servers/:sid/roles/:rid`. Omission on create means null; omission on PATCH leaves it unchanged. Role objects (including gateway updates and exports) return this field; older exports without it import as null. Invalid values return `400 invalid_upload_max_mb`.
- An upload belongs to the server it was sent to (`sid`), and that server's `storage_mb` limit counts it (§19). Files stored before this was recorded belong to no server and count toward none.
- For a member, size is `min(the server's max_upload_mb limit (§19: the instance's max_upload_mb unless a tier or override changes it), max(community.upload_max_mb, all held role upload_max_mb values))`; the implicit everyone role counts. Null role values add no override. An absent or invalid community limit falls back to the instance ceiling; absent instance configuration defaults to 25 MB. The owner gets the instance/plan ceiling. A lower role value cannot reduce the community default. Managed instance ceilings follow the plan (Starter 10 MB, Plus 250 MB by default).
- `GET /api/v1/servers/:sid` keeps `server.upload_max_mb` as the community default, returns the caller's effective value in `server.my_upload_max_mb`, and exposes the instance/plan ceiling in `server.upload_ceiling_mb`. Use the default for community settings, the effective value for upload checks, and the ceiling for the role editor. Refresh detail after roles/settings change. Oversized streaming uploads stop buffering immediately and return `413 { error: "file_too_large", max_mb: <effective limit> }`.
- Files are served with `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`. Non-media types are served with `Content-Disposition: attachment`.

---

## 12. Nookara relays

Services an instance asks Nookara for: registering, push, credit payments, daily credits, the voice broker, import bundles and the public directory. People and the public call the matching routes under `NOOKARA/bonfire/*`. Everything an instance calls is **signed with the instance's Ed25519 key** (§12.2). Nookara never fetches an instance-supplied URL. Dev: `http` instance urls need `EMBER_DEV=1` on Nookara (as in §1); public urls stored for the directory must be `https`.

### 12.1 Registration
The instance has an Ed25519 key (`DATA_DIR/keys/instance.key`). Its **`instance_id`** is `ik_` + first 16 hex of `sha256(raw 32-byte public key)`. `pubkey` is the b64url of the raw 32 bytes (same encoding as the signing key, §2.3). `url` is the instance's `public_url` (normalized as in §1).

1. `POST NOOKARA/bonfire/instances/challenge` `{ pubkey, url }` -> `{ nonce, expires_in: 300 }` (single use).
2. `POST NOOKARA/bonfire/instances/register` `{ pubkey, url, name, accounts_mode: "velora"|"local", nonce, sig, operator_terms?: { version, accepted_at } }` (`operator_terms`: the Ember Server Operator Terms the operator accepted, https://nookara.cc/operator-terms; omitted until accepted) where `sig` = b64url Ed25519 over the UTF-8 string `bonfire-register-v1|<nonce>|<normalized url>` -> `{ instance_id, trusted, voice: { cap_minutes, used_minutes } }`.

- Upserts by key hash, so re-registering updates `url`, `name` and `accounts_mode` (call it on every start). `cap_minutes` is `null` when unlimited (trusted).
- Registration never reads an `Authorization` header and never changes the instance's owner. A Nookara token is never sent to an instance.
- Errors: `invalid_pubkey`, `invalid_url`, `invalid_nonce`, `bad_signature` (401), `invalid_accounts_mode`, `invalid_name`, `url_taken` (409, another key owns that url), `instance_banned` (403). Rate limited per IP (429 `rate_limited`).
- `name` is stored with control characters and `<>` stripped, max 80 characters.
- **Url proof:** before binding a url that is not already bound to this key, Nookara fetches `<url>/.well-known/bonfire` and requires its `instance_key` (§3) to equal `pubkey`; otherwise `403 { error: "url_unverified", reason }` (`reason`: `key_mismatch`, `no_instance_key`, `private_address`, `bad_status`, `timeout`, `too_large`, `dns_failed`, `fetch_failed`, …). The fetch is SSRF-guarded: http(s) only, no credentials, refused when the host resolves to any private, loopback, link-local, CGNAT, metadata, multicast or reserved address (IPv4 and IPv6, incl. IPv4-mapped, NAT64, 6to4 and Teredo forms; the connection is pinned to the checked address), redirects (max 3) re-checked, 5 s total, 64 KB max. With `EMBER_DEV=1` localhost / private targets are allowed (dev stack), cloud metadata addresses never are. So the instance must be reachable at `public_url` when it registers. An admin can still remove a registration.
- `trusted` is set only by Nookara staff (for `chat.ikelene.net` and hosted instances). It unlocks §12.4 and unlimited voice.
- `instance-token` (§2.2) refuses audiences that are banned (403 `instance_banned`).

**Payee (owner attestation).** The instance **owner** receives pay-request payments (§12.5) once Nookara knows their account. The owner proves it with a short-lived proof signed by the instance, and presents it to Nookara themselves:
1. `GET INSTANCE/api/v1/instance/owner-attestation` (instance owner session only) -> `{ attestation, instance_id }`. Errors: 403 `owner_only`, 400 `owner_not_velora` (the owner is a local account), 409 `not_registered`.
2. `POST NOOKARA/bonfire/instances/payout { attestation }` with the owner's own Nookara bearer token (scope `CHAT`; Ember's token, called by the client) -> `{ ok: true, instance_id }`. Sets the instance's `owner_user_id` to the caller.
- `attestation` is a compact JWS signed with the instance key: header `{ "alg": "EdDSA", "typ": "bonfire-owner+jwt" }`, claims `{ iss: <instance_id>, url: <public_url, normalized>, sub: <owner Nookara id, string>, iat, exp: iat + 300, jti: <random> }` (seconds).
- Nookara finds the instance by `iss`, verifies the signature with that row's stored `pubkey`, requires `typ`, `exp` in the future but at most 10 min ahead, `url` equal to the row's url, `sub` equal to the caller's Nookara id, and a `jti` not seen before. Errors: 400 `invalid_attestation`, 404 `unknown_instance`, 403 `not_owner` (`sub` is another account), 403 `instance_banned`.


**Payout card:** `GET NOOKARA/bonfire/instances/payout?url=<instance origin>` (bearer + `CHAT`) returns `{ linked: bool, payee: { id: <string>, username, pfp } | null, linked_at: <ms> | null, you: bool }`. Normalize the URL as in section 1. Only the registered owner/current payee can read it (`403 forbidden` otherwise); unknown instance -> `404 unknown_instance`, bad URL -> `400 invalid_instance`. The existing registry uses `owner_user_id` for both the owner and payout target, so those are the same account. `you` compares the payee with the caller. `linked_at` records the last successful owner attestation; pre-existing/automatically registered ownership may return null. A missing payee account returns `linked: false`, `payee: null`, `you: false`.

### 12.2 Signed requests (instance -> Nookara, all `NOOKARA/bonfire/relay/*`)
Headers:
```
X-Bonfire-Instance: <instance_id>
X-Bonfire-Ts:       <unix ms>
X-Bonfire-Sig:      b64url( Ed25519( METHOD "|" path "|" ts "|" sha256hex(body) ) )
```
- `METHOD` is upper case. `path` is the request target exactly as sent: the path **with** its query string (`/bonfire/relay/import/bundle?ticket=bit_...`). `body` is the exact bytes sent (empty for GET, so the hash is `e3b0c442...b855`). Send JSON bodies with `Content-Type: application/json`.
- `ts` must be within **60 s** of Nookara's clock (401 `stale_timestamp`). Each signature is accepted **once** (401 `replayed`), so sign every request freshly.
- Other errors: 401 `unknown_instance` / `bad_timestamp` / `bad_signature`, 403 `instance_banned`, 429 `rate_limited` (with `Retry-After`), 400 `invalid_json`, 413 `payload_too_large` (bodies are at most 300 KB).
- The relay router reads the raw body itself, ahead of Nookara's global JSON parser and xss-clean, so strings are never rewritten before the hash is checked. Responses are normal JSON.
- Limits are per instance: 1500 requests/min overall, plus the route limits below.

### 12.3 `POST /bonfire/relay/notify` (offline push)
```json
{ "user_id": "123", "kind": "mention" | "reply" | "dm_like", "community_name": "…", "channel_name": "…", "title": "nat mentioned you", "preview": "…", "url": "INSTANCE/…" }
```
- `user_id` is the Nookara id (`sub` of the token). `title` max 100, `preview` max 300, names max 80. `url` is optional and must be on the instance's own origin (400 `invalid_url`).
- Result: `{ "delivered": true }` or `{ "delivered": false, "reason": "not_subscribed" | "muted" | "push_off" | "held" }`. It always returns 200 for those cases.
- **Consent:** only if the user has this instance's url in their list (§2.4), `muted` is false and `push` is true. People change this with `PATCH /bonfire/instances/prefs`.
- Delivery matches Nookara's own mentions: the Android notification socket plus browser push, with the "quiet while you're here" hold. While the person is actively using Ember somewhere, the push is `held` and sent after they go idle (relayed pushes can't be checked for "read", so they are dropped after 2 hours).
- Tapping the push opens Ember at that instance (`/chat#/i/<instance>`).
- Limits: 600/min per instance, 20/min per instance and user (429 `user_rate_limited`).

The instance also sends the same pings to the pushers people registered with it, through a push gateway (§20); the two do not depend on each other.

### 12.4 `POST /bonfire/relay/daily` (trusted only)
`{ "user_id": "123" }` -> `{ "status": "claimed", "amount": 5 }` | `{ "status": "already" }` | `{ "status": "banned" }`. This is the same once-a-day credit as Ember/Fluxer chat (`source: ember`; 15 for Pro or staff). Untrusted instances get 403 `not_trusted`.

### 12.4a `POST /bonfire/relay/identities`
`{ "ids": ["123", ...] }` (1-200 Nookara account ids) -> `{ "users": [{ "id": "123", "username", "display_name", "pfp" }] }`. Banned and unknown accounts are left out. An instance in `velora` mode calls this a minute after boot and then every 10 minutes for every Nookara account it knows, and applies changed names / pictures (members, messages and clients then see them through `chat_identity_update`, as for a login refresh). Without it a rename only reached an instance when that person next signed in there.

### 12.5 Credit payments (pay requests)
`POST /bonfire/relay/pay-request` `{ user_id, amount, reason, ref }` -> `{ id, status: "pending", approve_url, amount, expires_at }`.
- `amount` is an integer from 1 to 100000. `reason` max 200 is shown on the approval page. `ref` (required, max 100) is the instance's own reference, e.g. `role:<rid>`. Sending the same `ref` again returns the same request (a different user or amount gives 409 `ref_reused`).
- The user must have the instance in their list (403 `not_subscribed`). Other errors: `invalid_amount`, `invalid_ref`, `user_not_found` (404), `self_payment`, `too_many_requests` (429, five open requests per user), `payee_unavailable` (503).
- **Payee:** the instance **owner's Nookara account** when registration recorded one (§12.1). Otherwise Nookara's own account (`BONFIRE_HOUSE_USER`, default the first owner-rank account). Credits are never burned.
- The request is a normal Nookara payment request that lives 30 minutes. The person opens `approve_url` (`NOOKARA/payment/<id>`: the existing Pay / Cancel page with the captcha). Alternatively `POST NOOKARA/bonfire/pay-requests/:id/approve` (bearer + `CURRENCY_PAY` + captcha like `/currency/transfer`) and `POST NOOKARA/bonfire/pay-requests/:id/decline` (bearer, only the payer).
- `GET /bonfire/relay/pay-request/:id` -> `{ id, status: "pending"|"paid"|"declined"|"expired", amount, ref, receipt, paid_at?, error? }`. Only the requesting instance can read it (else 404). Poll every few seconds. `declined` covers cancelled and failed (then `error` is set). Credits move before `paid` is reported.
- **Receipt** (`status: "paid"` only): an EdDSA JWS signed with Nookara's key (the JWKS key of §2.1), verifiable offline:
  - header `{ "alg": "EdDSA", "typ": "bonfire-receipt+jwt", "kid": <jwks kid> }`
  - claims `{ iss: <Nookara issuer>, aud: <instance url>, sub: "<user id>", amount, ref, paid_at: <ms>, rcp: "<request id>", iat, exp }` (`exp` is about a year)
  - The instance MUST check the signature against the JWKS, `typ` is exactly `bonfire-receipt+jwt`, `aud` is its own `public_url`, `ref`/`amount`/`sub` match what it asked for, and `rcp` has not been used before. Receipts must never be accepted as login tokens (§2.2 tokens have `typ: "JWT"`), and login verification should reject any other `typ`.


Clients display the payout target using `GET /bonfire/instances/payout?url=` (section 12.1). `POST /bonfire/instances/payout { attestation }` still links payouts through the signed owner attestation and now records `linked_at`. No DELETE/unlink endpoint is provided; the existing payout fallback behavior is unchanged.

### 12.6 Import bundles
For importing a Discord / Fluxer server into a self-hosted instance. The person uses their **Nookara** token (it works for local-account instances too), so the user routes take a bearer with `CHAT`:

| route | result |
|---|---|
| `GET NOOKARA/bonfire/import/platforms` | `{ platforms: [ { id, name, ready, bot, invite, linked } ] }` |
| `GET NOOKARA/bonfire/import/:platform/guilds` | `{ guilds: [ { id, name, icon } ] }` the person can manage (needs the linked account; `not_linked`, `bot_not_in_server`, `not_your_server`) |
| `GET NOOKARA/bonfire/import/:platform/guilds/:gid` | the picker preview: `{ guild, groups: [ {name, channels: [ {id, name, topic, kind, skip, private, locked} ]} ], roles, emojis, … }` |
| `POST NOOKARA/bonfire/import` `{ platform, guild_id, channels: [id…], roles: [id…], options?: { name, icon, banner, emojis }, instance }` | `{ job_id, ticket, instance, expires_at }` |
| `GET NOOKARA/bonfire/import/:job_id` | `{ job_id, status: "queued"\|"running"\|"done"\|"failed", progress (0-100), stage, error, instance, size, expires_at, downloaded }` (owner only) |

- The job runs in the background (one per person at a time: 429 `import_running`; at least one channel is required: `pick_a_channel`). It builds a **`bonfire-export-v1` zip** (§9) with `source_kind: "velora-import"`: channels (with categories, voice channels and per-role view/send/attach settings), roles with their permissions, `@everyone` (rid `everyone`, `is_default`), emojis, icon and banner. It contains **no members or messages**: `members.jsonl` and `messages/<cid>.jsonl` are empty, so history stays where it is. `cid`s are `c<platform id>`, role `rid`s are `r<platform id>`.
- **`ticket`** (`bit_…`) is a one-time secret, shown only in the `POST` response and bound to the normalized `instance` url. The client hands it to the instance.
- Instance route: `GET /bonfire/relay/import/bundle?ticket=<ticket>` (signed, §12.2) -> `application/zip`. Errors: 404 `ticket_invalid`, 403 `ticket_wrong_instance` (the signing instance's url must equal the ticket's), 409 `not_ready` (retry), 410 `ticket_expired` (already downloaded, or older than 1 hour after the bundle was ready), 410 `import_failed`. **One download:** the ticket is spent when the download starts and the file is deleted afterwards. If a transfer fails, run the import again.

### 12.7 Voice broker
`POST /bonfire/relay/rtc/*`, `GET /bonfire/relay/rtc/ice`, wrapping Cloudflare Realtime. The keys stay on Nookara. The bodies mirror what `chat_rtc_*` does today, with Cloudflare's names. Limit: 1200/min per instance, at most 400 open sessions.

| route | body | result |
|---|---|---|
| `POST /rtc/session` | `{}` | `{ sessionId, voice }` (a new SFU session) |
| `POST /rtc/tracks` | publish: `{ sessionId, sessionDescription: {type:"offer", sdp}, tracks: [ {mid, trackName} ] }`; subscribe (no description): `{ sessionId, tracks: [ {sessionId, trackName} ] }` | Cloudflare's reply (`sessionDescription`, `tracks` with per-track errors) |
| `POST /rtc/renegotiate` | `{ sessionId, sessionDescription: {type:"answer", sdp} }` | `{}` |
| `POST /rtc/close` | `{ sessionId, mids?: [mid…] }` | with `mids`: closes those tracks. Without: **ends the session** and stops its metering -> `{ ok, voice }` |
| `POST /rtc/heartbeat` | `{ sessionIds: [id…] }` | `{ alive, voice }` |
| `GET /rtc/ice` | | `{ iceServers }` |
| `GET /rtc/usage` | | `{ cap_minutes, used_minutes, over }` |

- A session can only be used by the instance that opened it (404 `session_not_found`). Track names are `[A-Za-z0-9_.:-]{1,64}`, `mid`s `[A-Za-z0-9_-]{1,32}`, at most 30 tracks per call. Errors: 503 `voice_unavailable` (not set up on Nookara), 502 `voice_upstream`, 402 `voice_cap_reached` `{ cap_minutes, used_minutes }`.
- **Metering:** Cloudflare sessions are metered **per instance, per calendar month (UTC)** in raw session-minutes. A session counts from `rtc/session` until `rtc/close` (without `mids`) or, if the instance disappears, until its last call or heartbeat (sessions silent for 10 minutes are closed automatically). A participant who has a publish and a receive session uses 2 minutes per minute, so create the receive session lazily. Every `rtc/*` call for a session counts as a heartbeat, but an idle but connected session needs `rtc/heartbeat` at least every 5 minutes (once a minute is recommended).
- **Cap:** trusted instances are unlimited. Others get `BONFIRE_VOICE_FREE_MINUTES` (default 3000) a month, or the per-instance override set by staff. At or over the cap, `rtc/session`, `rtc/tracks` and `rtc/ice` return `402 { error: "voice_cap_reached" }` (renegotiate, close and heartbeat still work). Fall back to the instance's own keys when configured (§10).

### 12.8 Bans
Nookara staff can ban an instance by key (`ik_…`) or by url host (`chat.example.com`, or `*.example.com` for subdomains). A banned instance gets 403 `instance_banned` on every relay and registration, no instance tokens, and no directory listing.

### 12.9 Directory
`PUT /bonfire/relay/directory` (signed, 20/min):
```json
{ "listed": true, "name": "…", "description": "…", "icon_url": "https://…", "banner_url": "https://…", "member_count": 12, "invite_url": "https://…", "tags": ["gaming"] }
```
- `listed: false` removes the listing (nothing else is needed). With one listed server the body is that single entry, as always. With several, the oldest listed one fills those fields and all of them ride along in `communities: [ { sid, slug, address, name, description, icon_url, banner_url, member_count, invite_url, tags } ]` (Nookara reads only the single entry for now).
- Validation: `name` required, max 80. `description` max 500. `icon_url`, `banner_url` and `invite_url` are optional `https` urls without credentials, max 512 (`banner_url` is newer: an older Nookara ignores it). `member_count` is an integer 0-100000000. `tags` is at most 8, each max 24 characters, lower-cased, no commas. Control characters and `<>` are stripped from text. Errors: `invalid_listed`, `invalid_name`, `invalid_icon_url`, `invalid_banner_url`, `invalid_invite_url`, `invalid_member_count`, `invalid_tags`. The response is `{ listed, hidden_by_staff? }`. Staff can hide a listing, and then the instance can't bring it back.
- `GET NOOKARA/bonfire/directory?q=<text>&page=<n>` is public (CORS `*`) and returns `{ page, page_size: 24, has_more, results: [ { id: <instance_id>, url, name, description, icon_url, banner_url, member_count, invite_url, tags, trusted, updated_at } ] }`, sorted by `member_count`. `q` matches name, description and tags. Unlisted, staff-hidden and banned instances never appear. Clients must treat every field as untrusted text and open `invite_url` / `url` only as links.

### 12.10 Staff routes (not for instances)
`/admin/bonfire/*` (rank `admin` or `owner` only): `GET instances`, `PATCH instances/:key` `{ trusted?, voice_cap_override? }` (`null` = default cap), `DELETE instances/:key`, `POST directory/:key/delist|relist`, `GET|POST bans` `{ key_hash? | url?, reason }`, `DELETE bans/:id`. They are driven by Admin > Instances in the dashboard.

---

### 12.11 Instance behaviour (bonfire-server)
- **Owner attestation.** `GET /api/v1/instance/owner-attestation` is owner-only, needs the owner principal to be a Nookara user and the instance to be registered (§12.1). The instance never receives, forwards or stores a Nookara token.
- **Key + registration.** The key is generated on first boot (`DATA_DIR/keys/instance.key`, PKCS#8 PEM, mode 0600; keep it with backups, it is the instance's identity on Nookara). Once the HTTP server listens, the instance registers (§12.1) in both accounts modes (local-mode instances use Nookara only for these opt-in services); it never blocks startup, retries with backoff (5 s … 30 min), re-registers when `nookara_url`, `public_url`, `name`, `accounts_mode` or `nookara_registration` change and every 12 h, and again after a `401 unknown_instance`. `instance_id`, `trusted` and the voice cap are kept in the database (`meta`). `nookara_registration: "off"` stops every Nookara call.
- **Push** (§12.3): only for Nookara principals (`v:`) that `notifyOffline` reports (pinged, not connected to this instance, push not muted). `kind` is `reply` for a reply to them, else `mention`; `title` "`<from>` mentioned you" / "replied to you"; `preview` is the message (≤ 300); `url` is `INSTANCE/#/s/<sid>/<cid>` (on the instance's own origin as Nookara requires; the fragment is the client route, i.e. `NOOKARA/chat#/i/<instance>/s/<sid>/<cid>`). Per user and channel at most one push per 30 s: later pings in the window become one summary ("3 new mentions in #general"), dropped if the person connected meanwhile.
- **Daily credits** (§12.4): the first message (people only: not system, webhook or bridged) of the UTC day by a Nookara principal calls `relay/daily` when the instance is `trusted`; a `claimed` answer sends that person `chat_ephemeral { server, channel, kind: "daily", amount, body: "You claimed your daily chat credits (+5 credits)." }` (unless their `daily_notice` setting is false). `403 not_trusted` marks the instance untrusted until the next registration says otherwise.
- **Paid roles** (§6.1, §12.5): `ref` is `role:<rid>:v<nookara id>:<attempt>:<random>`, unique per person, role and attempt and reused on retries. A background poller asks Nookara every few seconds while requests are open. Receipts are checked offline against the JWKS (same cache as login, §4): `alg` EdDSA, `typ` exactly `bonfire-receipt+jwt`, signature, `iss` = `nookara_url`, `aud` = `public_url`, `sub` = the buyer's Nookara id, `amount`, `ref`, `rcp` = the request id, not expired, and `rcp` never used before. A bad receipt fails the attempt and grants nothing. Login refuses any JWT whose `typ` is not `JWT`.
- **Voice broker** (§10, §12.7): see §10.
- **Directory** (§12.9): while `listed` is on, the instance PUTs `{ listed: true, name, description, icon_url (absolute), banner_url (absolute), member_count, invite_url, tags }`, where `invite_url` is the community's permanent invite opened in Ember on the web (`NOOKARA/chat#/i/<instance>/invite/<code>`). It re-pushes (debounced) when any of that changes and every 6 h; turning `listed` off sends `{ listed: false }`. A link Nookara refuses (it stores only `https`) is dropped from the listing instead of failing it.
- **Import** (§12.6): `POST /api/v1/import/velora { ticket }` (instance admins, only while no community exists) downloads `relay/import/bundle?ticket=` and runs the zip importer (§9). Nookara's errors come back with the same codes plus a `message`: `404 ticket_invalid`, `403 ticket_wrong_instance`, `409 not_ready` (`retry: true`), `410 ticket_expired` / `import_failed`; `503 velora_not_registered` / `velora_off` when the instance cannot reach the relays.

### 12.12 `POST /bonfire/relay/wake`

`{ user_ids: [nookara user id, ...] }` (at most 200): people signed up for wake pings (§7.2) have something new on this instance. Nookara checks each person has this instance in their list (muted ones too: a ping is not a notification) and sends `{ "type": "instance_wake", "instance": "<instance origin>" }` to their open Nookara sockets; clients mark the instance unread. Nothing is stored, pushed or emailed. Answers `{ ok, delivered, delivered_ids }`: the instance treats only `delivered_ids` as pinged, so someone whose client couldn't be reached gets the next message's ping.

### 12.13 `POST /bonfire/relay/notice`

`{ user_id, kind: "profile_reset" | "account_request" | "server_request", community_name }`: something this instance did to a person that they should hear about (`account_request` / `server_request`: for an admin, someone asked for an account (`community_name` = its username) or a server (its name), §4a / §5a). Nookara writes the wording itself (an instance can't put its own text in someone's inbox) and adds it to their notification inbox, for people who have this instance in their list. Answers `{ ok, delivered }`.

## 13. Webhooks

Management (needs Manage channels; only `text` and `logs` channels): `GET /channels/:cid/webhooks` → `{ webhooks: [ { wid, name, avatar, channel, url, created_by, created_at } ] }`; `POST /channels/:cid/webhooks { name }` (30 per community, `too_many_webhooks`); `PATCH /hooks/:wid { name?, avatar?, new_token?, channel? }`; `DELETE /hooks/:wid`; `POST /hooks/:wid/avatar` (multipart `file`). `url` is built from the instance's `public_url`:

    POST INSTANCE/api/v1/webhooks/:wid/:token

No login: the token is the key. The body is Discord's: JSON `{ content, username, avatar_url, embeds[] }`, or multipart with `payload_json` and files (`files[0]`, …; an embed image can say `attachment://name`, and then that file is not repeated as an attachment). Embeds are cleaned like Discord's (10 embeds, field / length limits, http(s) URLs only). `?wait=true` returns the message (`{ id, type, channel_id (the cid), content, embeds, webhook_id, attachments, author, timestamp }`), otherwise `204`. `GET` returns the webhook info `{ id, type: 1, name, avatar, channel_id, guild_id, token }`, `DELETE` removes it (`204`). Limit **30 posts / minute / webhook** (`429 { message, retry_after, global: false }`). Errors here use Discord's `{ message, code }` shape. Messages show an author `{ id: null, name_only: true, webhook: true, username, pfp }`; they are exempt from signing and do not ping anyone offline.

## 14. Bots

A bot is an instance-local account (principal `b:<n>`, BOT tag, no login, no DMs). People with **Manage server** in any server here (and instance admins) make them; instance admins manage every bot, a server's managers the ones they made (with a single server its managers manage all of them, as before). `GET /bots` and `POST /bots` take an optional `sid` (the server whose Manage server is checked). `GET /bots/by-name/:username` → `can_add_to`: every server where you have Manage server and the bot is not in yet. `GET /bots` → `{ bots: [ { id, username, pfp, description, public, servers, owner, created_at } ], max }`; `POST /bots { name, description }` (name `[A-Za-z0-9_.-]{2,32}`, unique) → `{ bot, token }`; `PATCH /bots/:id { name?, description?, public? }`; `POST /bots/:id/avatar`; `POST /bots/:id/token` (new token, closes its gateway sessions); `DELETE /bots/:id`; `GET /bots/by-name/:username` → `{ bot, can_add_to }`; `POST /bots/by-name/:username/add { sid }` puts it in the community (it is a normal member afterwards, so roles, kicks and channel permissions apply). `:id` may be `b:3` or `3`.

**Token:** `base64url(<n>) + "." + 40 random base64url chars`, shown once, stored as sha256. Used as `Authorization: Bot <token>`.

**REST** is Discord's dialect at `INSTANCE/bot/v1/...` (Nookara serves it at `/chat/api/v1`): `GET /bot/discovery` (`{ api_code_version, endpoints: { api, api_public, api_client, gateway } }`), `GET /bot/v1/gateway`, and with a token `GET /gateway/bot`, `/users/@me`, `/users/@me/guilds`, `DELETE /users/@me/guilds/:gid`, `/users/:uid`, `/guilds/:gid` (+ `/roles`, `/channels`, `/members`, `/members/:uid`), `/channels/:cid` (+ `POST /typing`), `GET/POST /channels/:cid/messages`, `GET/PATCH/DELETE /channels/:cid/messages/:mid`, `PUT/DELETE /channels/:cid/messages/:mid/reactions/:emoji/@me`, `PUT/DELETE /channels/:cid/pins/:mid`. Ids are numbers (guild = community row id, channel / message / user = row ids, role = 1000000000 + row id, `@everyone` = the guild id). Message bodies take `content`, `embeds`, `message_reference`, `allowed_mentions`, multipart `payload_json` + files. A bot posts as a member: it needs Send in the channel and obeys locked / no-chat channels. Rate limit **150 requests / 10 s per bot** (`429`). Errors are `{ message, code }`.

**Aliases:** a bot may post a message under another name and picture. `POST /channels/:cid/messages` (and interaction replies / followups) take an optional `alias: { name, avatar_url? }`: `name` is trimmed and cleaned like a display name and must be 1-32 characters on one line; `avatar_url` is optional, `https://` only, at most 500 characters (no credentials), stored as given and loaded by clients like webhook avatars (the instance does not proxy it). Bad input is `400 invalid_alias` (`message` says which field). `PATCH /channels/:cid/messages/:mid` with `alias` replaces it, `alias: null` clears it, leaving it out keeps it. Every message object (bot REST and gateway `MESSAGE_CREATE / UPDATE`, `referenced_message`, and the client API's history, search, pins, `chat_message` / `chat_message_update`, `reply`) carries `alias: { name, avatar_url, unmarked, member_id?, member? } | null` next to the unchanged real `author`. Mentions, notifications, blocks, moderation, reports and the audit log all use the real author; clients show the alias with a mask icon that names the real bot. Only bots may set one: a person sending `alias` (REST post / edit, gateway `chat_send`) gets `403 alias_bots_only`. Webhooks keep their own `username` / `avatar_url` overrides (§13), which are separate.

**Unmarked aliases** (risky, off by default). The server owner can turn on `advanced.unmarked_aliases` (Server settings > Danger zone > Advanced; the change is in the audit log as `unmarked_aliases_update { enabled }`). While it is on, an alias posted by a bot that is a member of the server and holds **Use unmarked aliases** (bit 4096, or Administrator) carries `unmarked: true`; otherwise every alias carries `unmarked: false`. The instance also looks the alias name up among **that server's** members only: exactly (trimmed, any case) one member's `username`, or failing that exactly one member's `display_name`. Two or more matches = no match. A match adds `member_id` (their principal) and `member` (their author object: `id, kind, username, display_name, pfp, velora_id`, `bot`) to the alias; the bot API's alias has `member_id` as a numeric user id instead and no `member`. All of this is worked out each time a message is shown (history, search, pins, `chat_message`, gateway, bot REST), so turning the setting off or on changes old messages too; nothing extra is stored. Clients draw an unmarked alias like a normal message: no mask, no BOT tag, the matched member's name colour and profile card (else the bot's), `avatar_url` or else the matched member's picture or else the bot's. The real author stays in `author` and everything (mentions, notifications, blocks, reports, moderation, the audit log) still uses it; clients show it to people with Manage messages in a "Message info" view.

**Gateway:** `ws(s)://INSTANCE/bot/gateway`, Discord-style: server `op 10 hello { heartbeat_interval }`; client `op 2 identify { token }` (bad token closes `4004`); `op 1` heartbeat answered with `op 11`. Dispatch (`op 0`, `t`, `s`, `d`): `READY`, `GUILD_CREATE` (whole community, also when a manager adds the bot), `GUILD_UPDATE`, `GUILD_DELETE`, `GUILD_MEMBER_ADD / REMOVE`, `MESSAGE_CREATE / UPDATE / DELETE`, `MESSAGE_REACTION_ADD / REMOVE`. A bot only receives events for channels it can see.

**Voice:** bots use the same Cloudflare Realtime transport as people (§10), over the bot gateway. The bot needs a WebRTC stack (for example `aiortc` in Python, `werift` in Node) and must be a member who can view the voice channel and has Send in it; limits, timeouts and `user_limit` apply as for people.

- `op 4` (client) `{ guild_id, channel_id, nonce? }` joins that voice channel; `channel_id: null` leaves. The server answers with dispatch `VOICE_SERVER_UPDATE { guild_id, channel_id, room, ice_servers, people, nonce }`, or `RTC` carrying a `chat_error` (`not_allowed`, `not_a_member`, `timed_out`, `channel_full`, `voice_unavailable`). Joining again moves the bot. Closing the gateway leaves.
- `op 40` (client) `{ type, ... }` sends one of the `chat_rtc_*` frames or `chat_voice_mute` from §10 for the room in `VOICE_SERVER_UPDATE` (everything except `chat_rtc_join`, which is `op 4`). Every `chat_rtc_*` reply and push (`chat_rtc_published`, `chat_rtc_offer`, `chat_rtc_ready`, `chat_rtc_room`, `chat_rtc_left`, errors, `voice_sound`) arrives as dispatch `t: "RTC"`, `d` = the frame, with the `nonce` you sent. To speak: `op 4`, create a PeerConnection with an audio track, `chat_rtc_publish` the offer with `tracks: [{ mid, trackName: "audio" }]`, apply the returned `sessionDescription` as the answer, then `chat_rtc_connected`. Only after `chat_rtc_connected` does the bot show up in the channel. To hear people: `chat_rtc_subscribe` with `sources: [{ userId, trackName: "audio" }]`, set the `chat_rtc_offer` description, send `chat_rtc_answer { session: "receive" }`.
- Events: `GUILD_CREATE` has `voice_states` (current voice members), and `VOICE_STATE_UPDATE { guild_id, channel_id (null = left), user_id, self_mute, self_deaf, member }` fires when anyone joins, leaves or changes mute / deafen in a channel the bot can see.

**Bot presence:** a bot (including a gallery bot with `gallery_id`) is `online` in each community it belongs to iff at least one authenticated connection on this instance's `/bot/gateway` has been sent `READY`. Other connections and REST requests do not count. Multiple gateway connections count independently; the last connection closing, erroring, being revoked or timing out makes it `offline`. Heartbeats expire after 2.5 times the advertised 41250 ms interval, checked every 15 s; stale connections are removed from presence immediately when detected, without waiting for the WebSocket close handshake. Presence is in memory and starts offline after restart.

**Server nicknames.** `PATCH /api/v1/servers/:sid/members/:uid` `{ nick }` (`:uid` = a principal, or `@me`) sets someone's nickname on that server: 1–32 characters, `""` / `null` clears it (`400 invalid_nick`). Your own needs **Change nickname** (bit 8192, on @everyone by default; servers from before it got it on @everyone when they updated) or Manage nicknames; someone else's needs **Manage nicknames** (bit 16384) and a higher role than theirs (`403 not_allowed`). Answers `{ nick }`, pushes `chat_member_update` (`change: "role"`) and writes `member_nick` to the audit log. On that server, member views and message authors (replies, reactors and unmarked-alias members too) carry `nick` and use it as their `display_name`, with their own name in `global_display_name`. Bots: `PATCH /guilds/:gid/members/@me` (or `/:uid`) `{ nick }`, and `nick` in member objects.

`GET /api/v1/servers/:sid/members` returns the member `presence` field as the string `"online"` or `"offline"`: for bots, whether the bot is connected; for people (servers advertising `features.member_presence`), whether they have a socket open to this server right now. Older servers send `presence: null` for people. The `member` in `chat_member_update` (including `change: "joined"`) has the same field, so adding an already connected bot immediately supplies its current status. Reads reflect current connections immediately. Changes are coalesced for 2 seconds and sent only to current community subscribers, using `{ "type": "chat_presence", "server": "<sid>", "user_id": "b:<n>", "username": "<bot name>", "presence": "online" }` (or `"offline"`). Unchanged aggregate status produces no event; a brief disconnect/reconnect can produce none. Clients update the matching member's `presence` to render its dot. No presence is broadcast outside the bot's communities. People get the same event (with their principal id) when their first socket to the server opens or their last one closes, settled the same 2 s; a client should show someone as online only while they are connected here (and may still apply that person's own status, e.g. invisible, from elsewhere).

This gateway does not support IDENTIFY presence or UPDATE_PRESENCE (`op 3`); supplied `idle`, `dnd`, `invisible`, or `offline` statuses are ignored, as before. A live READY connection remains online. There is no invisible mode. Generic `userView` / profile and Discord-shaped Bot REST user/member objects do not expose human presence and remain unchanged; bot presence is exposed in the community member view, not globally to non-members.

### 14.1 Bot gallery (Nookara Discovery > Bots)
Nookara lists reviewed bots (`NOOKARA/bonfire/bots/gallery`, see Nookara's BOT-GALLERY.md). A manager adds a listed bot with a **ticket**: the client asks `POST NOOKARA/bonfire/bots/gallery/:id/ticket { instance }` (bearer + CHAT) and sends it to `POST INSTANCE/api/v1/bots/gallery/add { ticket, sid }` (needs Manage server). The ticket is an EdDSA JWS (`typ: bonfire-botadd+jwt`) signed with Nookara's IdP key; claims `{ iss, aud: <public_url>, sub: <Nookara id>, iat, exp (5 min), jti, test, verified, token_hash, bot: { id, username, description, avatar_url } }`. The instance verifies it offline (as receipts, §12.5: signature, `iss`, `aud`, `sub` = the caller's `velora_id`, `exp`, single use by `jti`), creates a normal bot (principal `b:<n>`) with `bots.gallery_id`, stores `token_hash` as its token hash (the developer's own Nookara token then authenticates on this instance) and adds it to the community. Errors: `gallery_needs_velora_account`, `ticket_invalid | ticket_unknown_kid | ticket_bad_signature | ticket_wrong_issuer | ticket_wrong_audience | ticket_wrong_user | ticket_expired | ticket_used`, `token_conflict`, `already_in_server`, `banned_from_server`. Gallery bots carry `verified` (bot views, `userView`, bot API user objects) and `gallery: { id, test }`; they are managed by Nookara (`403 gallery_bot_managed` on rename / avatar / token reset). `POST NOOKARA/bonfire/relay/bots/sync { bots: [ { id, test } ] }` (signed, §12.2) runs every 10 minutes and after an add: per bot `{ id, status: ok | revoked | unknown, verified, token_hash, username, description, avatar_url, trusted_in }`; `ok` refreshes the copy, `revoked` / `unknown` remove the bot, and Nookara counts installs from these reports ("trusted in N servers").

### 14.2 Slash commands, context menus and interactions

Bots can register **application commands** and answer **interactions**, in Discord's dialect, so libraries such as discord.py and discord.js work by pointing them at `INSTANCE/bot/v1` and `INSTANCE/bot/gateway`. The application id of a bot is its number (`b:3` -> `3`, also what `READY.application.id` says; `@me` works too). REST paths below are relative to `/bot/v1`.

**Commands.** Three types: `1` chat input (`/name`), `2` user menu, `3` message menu. Scope is global (`/applications/:app/commands`) or one community (`/applications/:app/guilds/:gid/commands`): `GET`, `POST` (create, or replace the command with the same name and type: `201` when new, `200` when replaced), `PUT` (bulk overwrite, keeps ids of commands that keep their name and type), and per command `GET`, `PATCH`, `DELETE` at `.../commands/:cid`. Limits per scope: 100 chat input, 15 user, 15 message commands (`30032` over that). Shape: `{ id, application_id, version, type, name, description, options, default_member_permissions, nsfw, name_localizations, description_localizations, guild_id? }`. Chat input names are 1 to 32 lowercase letters, numbers, `-` and `_`; menu command names can have capitals and spaces and have no description. Options (up to 25, required ones first) take Discord's types: `1` subcommand, `2` group (subcommands nest at most two deep), `3` string (`min_length`, `max_length`), `4` integer and `10` number (`min_value`, `max_value`), `5` boolean, `6` user, `7` channel (`channel_types`: `0` text, `2` voice), `8` role, `9` mentionable, `11` attachment; strings and numbers take up to 25 `choices` or `autocomplete: true`. Bad bodies answer `400 { code: 50035 }` with the problem in `message`.

**Who sees and runs a command.** Only commands of bots that are members of the community. Owners and Administrators can always run them; everyone else must hold the Discord permission bits in `default_member_permissions` (`"0"` = admins only, missing = everyone), unless a manager set overwrites: per command, or for all commands of a bot, for roles (`@everyone` included), members and channels (`all` = every channel). The most specific wins: a member overwrite, then roles (any allow wins), then `@everyone`, then the default; a channel overwrite must also pass. Managers (Manage server) use `GET /servers/:sid/commands/manage` -> `{ bots: [ { ...user, online, perms: [overwrite], commands: [ { id, type, name, description, guild, default_member_permissions, perms } ] } ], roles }` and `PUT /servers/:sid/commands/permissions { bot: "b:3", command?: "12" (omit = all commands of the bot), permissions: [ { type: "role" | "user" | "channel", id: rid | principal | cid | "all", allow } ] }` (an empty list clears them). Bots can set theirs with `GET/PUT /applications/:app/guilds/:gid/commands/:cid/permissions` (`:cid` = the application id for the bot-wide default) in Discord's shape (`{ permissions: [ { id, type 1 role | 2 user | 3 channel, permission } ] }`, role id `@everyone` = guild id, channel id guild id - 1 = all channels).

**Client side.** `GET /servers/:sid/commands?channel=<cid>` -> `{ bots: [ { id, username, pfp, verified?, description, online } ], commands: [ { id, bot (principal), type, name, description, options, nsfw, guild, version } ] }`, already filtered to what the caller may run. `chat_commands_update { server }` arrives when a bot changes its commands or permissions: fetch again. Clients show `/` as a list grouped by bot (picture, name, BOT tag, offline bots dimmed) filtered as you type, flatten subcommands into `/name sub`, and show message commands under **Bots** > bot in the message context menu (user commands in a member's menu).

**Running one.** `POST /servers/:sid/interactions` (needs Send in the channel; timed-out members are refused). Body by `type`:
- `2` run a command: `{ type: 2, channel: cid, command: id, path?: ["group", "sub"], values?: { option: value }, target?: principal | message id }`. Values are plain JSON in Ember's own ids: user = principal, channel = cid, role = rid, mentionable = either, attachment = the `url` of an upload (`/media/upload` first), boolean/number/string as is. They are validated against the definitions (`400 bad_option { option, reason }`) and the bot gets Discord ids. Answers `{ id }`.
- `4` autocomplete: the same plus `focused: "option"`; waits at most 2.5 s for the bot and answers `{ choices: [ { name, value } ] }`.
- `3` component: `{ type: 3, channel, message: id, custom_id, selected?: [values] }` (selected = option values for string menus, principals / rids / cids for user / role / channel menus). Goes to the bot that wrote the message.
- `5` modal submit: `{ type: 5, channel, source: <interaction id from chat_interaction_modal>, fields: { custom_id: text } }`.

Errors: `bot_offline` (409, no live gateway), `unknown_command` (404), `bad_option`, `rate_limited` (15 per 10 s), `no_send_permission`, `timed_out`.

**Gateway.** The bot gets `INTERACTION_CREATE` on its newest gateway connection: `{ id, application_id, type (2 command, 3 component, 4 autocomplete, 5 modal submit), data, guild_id, channel_id, channel, member, token, version: 1, locale, app_permissions, message? (components) }`. Commands: `data = { id, name, type, guild_id, options?: [ { name, type, value, focused? } | { name, type, options } ], target_id?, resolved? }` with Discord ids (user = row id, channel = row id, role = 1000000000 + row id, `@everyone` = guild id) and `resolved: { users, members, roles, channels, messages, attachments }`. Components: `data = { custom_id, component_type, values?, resolved? }`. Modal submits: `data = { custom_id, components: [ { type: 1, components: [ { type: 4, custom_id, value } ] } ] }` (a label wrapper, type 18, keeps its shape).

**Answering.** The first answer must come within **3 seconds** or the member is told the bot did not respond. `POST /interactions/:id/:token/callback { type, data }` (no bot token needed, the token in the path is the key; `204`; a second call is `40060`; unknown or expired is `10062`): `4` message, `5` deferred message (shows "Mahi is thinking..."), `6` deferred update (components), `7` update the message the component sits on, `8` autocomplete choices (up to 25), `9` modal. `data` takes `content`, `embeds`, `components`, `allowed_mentions`, `flags` (`64` = ephemeral) and multipart `payload_json` + files. Interaction tokens live **15 minutes**. After a `5`, the first followup (or `PATCH .../messages/@original`) fills the thinking message. Followups: `POST /webhooks/:app/:token` (returns the message unless `?wait=false`), `GET / PATCH / DELETE /webhooks/:app/:token/messages/:mid` (`@original` or an id from a followup). A bot's interaction replies are not blocked by missing Send or Attach permissions in the channel.

**Ephemeral replies** (`flags: 64`) are delivered only to the member who ran the interaction, as `chat_interaction_message { op: "create" | "update" | "delete", server, channel, message }` where `message` is `{ id, ephemeral: true, interaction_id, author (the bot), body, embeds, components, attachments, created_at, edited_at, thinking?, interaction }`. They are never stored: they go away when the page is reloaded, and can carry components that work. Clients show "Only you can see this" and a dismiss button (`DELETE /servers/:sid/interactions/messages/:id` forgets one). A modal arrives the same way as `chat_interaction_modal { server, channel, interaction, modal: { custom_id, title, components } }` (text inputs: `style` 1 short / 2 paragraph, `label`, `placeholder`, `min_length`, `max_length`, `required`, `value`).

**Messages with components.** Bots can also send `components` with ordinary `POST /channels/:cid/messages` and change `content`, `embeds` and `components` with `PATCH`. A message view carries `components` (action rows: up to 5 rows of up to 5 buttons, or one select menu; buttons: `style` 1 to 4 + `custom_id`, 5 link + `url`, `label`, `emoji`, `disabled`; selects: type `3` string with `options`, `5` user, `6` role, `7` mentionable, `8` channel; `placeholder`, `min_values`, `max_values`) and, for answers to commands, `interaction: { id, type, name, user: { id, username }, thinking? }` (the "Nat used /quote" line). A message that is still `thinking` has an empty `body`. Gateway message objects carry `components`, `interaction` and `application_id`.

Not supported: HTTP interaction endpoints (gateway only), DMs, localization effects, Components V2 layouts, entitlements, `with_response`.

## 15. YouTube player (optional)

The client's "watch without YouTube" player. It needs a **yt-dlp** binary on the instance (not bundled: install it and put it on PATH, or set `youtube.ytdlp_path`). It is detected at boot and whenever the `youtube` settings change; `features.youtube` in discovery says whether it works. While it is off every route below answers **`503 { "error": "youtube_unavailable" }`**.

| route | auth | result |
|---|---|---|
| `POST /yt/:id/prepare` | session (`chat` scope) | starts fetching; `{ status: "queued"\|"downloading", progress, part }` / `{ status: "ready", src, download }` / `{ status: "error", error: "too_long"\|"not_available"\|"server_busy"\|"failed" }` |
| `GET /yt/:id/status` | session | same shapes (`{ status: "none", can_download }` when idle) |
| `POST /yt/:id/save { title }` | session + `media` scope | fetches if needed (poll again); then `{ status: "saved", id, attachment: { url, type: "video", name, size, sha256 } }`, a regular upload in `/uploads/` (subject to `allow_uploads` and the size limit) |
| `GET /yt/stream/:id?e=&s=[&dl=1]` | HMAC link | the video, `Range` supported; `403 link_expired` for a bad / expired / mismatched signature, `404 not_ready` |

`:id` must match `[A-Za-z0-9_-]{11}` (`400 bad_video`), and yt-dlp is spawned with an argument array, never through a shell. `src` / `download` are absolute URLs on the instance, signed with an HMAC (`sha256(secret, id.expires.dl)`, secret per process, 6 h validity, a stream link cannot be turned into a download). Videos are capped at 2 h / 720p / 900 MB, at most 2 downloads run at once, files are kept 24 h after the last watch, and the cache is trimmed oldest-first to `cache_max_gb`. Unlike Nookara there are no account tiers: every signed-in member gets the download link.

## 16. Bridges: Discord, Fluxer and Matrix

The instance owner connects **their own bot** for each platform (Discord, Fluxer; Fluxer's API is Discord's). The instance runs a minimal gateway client per configured token (no discord.js): `hello` → `identify` (Discord: intents `GUILDS | GUILD_VOICE_STATES | GUILD_MESSAGES | MESSAGE_CONTENT` = 33409; Fluxer: no intents) → heartbeats with ack tracking (a missed ack reconnects), `op 7` / `op 9` / dropped connections reconnect with backoff and **resume** (`op 6`) while the session is valid; close codes 4004 and 4010–4014 stop the client (`state: "error"`). It handles `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_DELETE_BULK`, and for voice links (§16.4) `GUILD_CREATE`, `GUILD_DELETE`, `VOICE_STATE_UPDATE`, `VOICE_SERVER_UPDATE`. REST is plain `fetch` with `Authorization: Bot <token>` and waits out `429` (`retry_after`, ≤ 15 s, 5 tries). Fluxer's endpoints come from `https://fluxer.app/.well-known/fluxer` (`endpoints.api_public | api | api_client`, `endpoints.gateway`); Discord's gateway URL from `GET /gateway/bot`.

**Instance settings** (instance admins; stored in the database table `bridge_settings`, not in `config.json`):

| route | result |
|---|---|
| `GET /api/v1/bridge/settings` | `{ bridges: { discord: B, fluxer: B } }`, `B = { configured, token: "********WXYZ" \| null, source: "settings" \| "env" \| null, state: "off" \| "connecting" \| "ready" \| "waiting" \| "error" \| "stopped", error, bot: { id, username } \| null }`. The token is **write-only**: only its last 4 characters are shown |
| `PATCH /api/v1/bridge/settings` `{ discord?: { token }, fluxer?: { token } }` | a non-empty token is checked with `GET /users/@me` first (`400 invalid_token { platform }`, `502 platform_unreachable`), saved, and the gateway (re)connects; `""` keeps the stored token, `null` removes it. Same response as GET |

Env fallbacks: `EMBER_DISCORD_TOKEN`, `EMBER_FLUXER_TOKEN` (used when the setting is empty). Discovery shows `features.bridges = { discord, fluxer, matrix, cloudlink: true }` (configured or not; `matrix` is missing on servers older than the Matrix bridge, 16.5).

**One bot, many servers.** The Discord / Fluxer bot belongs to the homeserver and every server on it shares it, so "the bot is in that guild" says nothing about who is asking. Before `PUT /bridge/servers/:sid` links a guild, the server must hold a **verified claim** for that `(sid, platform, guild_id)`; without one it answers `403 guild_not_verified { platform, guild_id }`. Instance admins are trusted and need none. A guild is linked to at most one server per homeserver: `409 guild_already_linked { sid }` (from the claim routes too). Links made before this check stay valid (`bridge_guilds.verified`).

| route | result |
|---|---|
| `POST /api/v1/bridge/servers/:sid/claim { platform, guild_id }` | `{ code: "EC-XXXX-XXXX", expires_at, command: "!ember-claim EC-XXXX-XXXX" }`. The code lives 10 minutes; asking again replaces it. `bad_platform` (404), `bad_guild`, `guild_already_linked` (409) |
| `GET /api/v1/bridge/servers/:sid/claim?platform=&guild_id=` | `{ status: "none" }` \| `{ status: "pending", code, expires_at }` \| `{ status: "verified", verified_at, how: "code" \| "oauth" }` |
| `GET /api/v1/bridge/oauth/discord/start?sid=&guild_id=` | Discord only, when the `bridges.discord_oauth` setting is there (`503 oauth_not_set_up` otherwise; `GET /bridge/platforms` then has `oauth: true` on Discord): `{ url }`, to open in a browser |

- **Claim code.** Someone with **Manage Server** in the guild posts `!ember-claim <code>` there (or a message that is exactly the code) in any channel the bot can read. The bot checks them over REST (`GET /guilds/:id`, `GET /guilds/:id/members/:uid`): the guild's owner, or any of their roles (with `@everyone`) has Manage Server (`0x20`) or Administrator (`0x8`). Then the claim is verified, the bot says so in that channel, and the server's sockets get `{ type: "chat_bridge_claim", server, platform, guild_id, status: "verified" }`. A code posted in another guild, by someone without the permission, or after it ran out verifies nothing. These messages are never bridged.
- **Discord sign-in.** The page at `url` asks Discord for `identify guilds` and comes back to `GET /api/v1/bridge/oauth/discord/callback` (register `<public_url>/api/v1/bridge/oauth/discord/callback` as a redirect of the Discord application). The guild must be in the person's guilds with `owner` or `permissions & 0x20` (or Administrator); then the claim is verified and a short page says so. `state` works once, for 10 minutes.
- A verified claim waits 24 hours to be used, for that server and guild only, and is spent by linking.
- **`!ember-unlink`** in the guild, from someone with Manage Server there, removes the guild's link (its webhooks are deleted), whoever made it.
- **Shards.** `bridges.discord_shards` (default 1) is how many gateway connections the Discord bot uses; with more than one each identifies with `shard: [i, n]`, 5.5 s apart, and `GET /bridge/settings` adds `shards: n` to `bridges.discord`. A guild's voice state updates go out on shard `(guild_id >> 22) % n`.

**Community routes** (same paths and shapes as Nookara's `/chat/bridge/*`; all need **Manage server** in the community). Which platforms a server may bridge to is one of its limits (§19): linking or switching on a platform that is not on its `bridges` list answers `403 plan_feature { what: "bridges" }`; reading and unlinking always work.

| route | result |
|---|---|
| `GET /bridge/platforms` | `{ platforms: [ { id, name, ready, bot, invite, linked: true } ] }` (`invite` = the bot's OAuth add-to-server link). With `?sid=` (Manage server there) the Matrix entry is that server's bot (`own: true` when it brought one, 16.5) |
| `GET /bridge/:platform/guilds` | `{ guilds: [ { id, name, icon } ] }` = the bot's servers (`/users/@me/guilds`) |
| `GET /bridge/servers/:sid` | `{ bridges: [ { platform, platform_name, guild_id, guild_name, enabled, problem, links: [ { cid, ext_channel_id, ext_name, hook, kind } ], ext_channels: [ { id, name, category, kind } ] } ], bridge, links, ext_channels, voice_links }` (`kind`: `text` \| `voice`; Discord voice / stage channels are listed too; `voice_links` = this instance can run them, §16.4) (`bridge` / `links` / `ext_channels` = the first bridge, for old clients). `problem`: `bot_not_in_server`, `unreachable`, `bridge_not_set_up` |
| `PUT /bridge/servers/:sid { platform, guild_id, automap? }` | links the community to one server per platform (`already_bridged`, `guild_already_linked` 409, `guild_not_verified` 403, `bot_not_in_server` 404, `bridge_not_set_up` 503). `automap` (default true) links text channels whose names match after lower-casing and dropping everything but `a-z0-9` (`general` = `General`), and creates their webhooks right away |
| `PATCH /bridge/servers/:sid { platform, enabled }` | pause / resume without losing the links |
| `DELETE /bridge/servers/:sid { platform }` (or `?platform=`) | unlinks; the bridge webhooks over there are deleted |
| `PUT /bridge/servers/:sid/channels/:cid { platform, ext_channel_id \| null }` | link one text channel to one text / announcement channel over there, or (Discord only) one voice channel to a voice / stage channel there (`text_channels_only`, `voice_channels_only`, `already_linked`, `channel_not_found`, `bot_needs_webhooks`, `bridge_failed`); `null` unlinks it. A voice link has no webhook |

A linked channel's view (`GET /servers/:sid`, `chat_channels_update`) carries `bridges: [ { platform, name } ]` and `bridged` (the first one).

**There → here.** A message in a linked channel is posted with `postBridged` as the person: `author = { name_only: true, webhook: true, bridge: "discord" | "fluxer", username: nick | global name | username, pfp }`. The avatar is downloaded from the platform CDN and re-hosted at `/uploads/bridge/avatars/…`; up to 4 attachments (and 2 stickers) are downloaded **only from the platform's CDN hosts** and stored as normal uploads (capped at min(25 MB, community `upload_max_mb`, instance `max_upload_mb`), and only when the community allows uploads); others become links. Text conversion: user mentions → `@\u200bname`, role mentions → `@\u200brole name`, channel mentions → `#name` (the linked local channel's name when there is one), custom emojis → a local emoji with the same name or `:name:`, `@everyone` / `@here` → `@\u200beveryone`, and a typed `<@&` → `<\u200b@&`: **nothing from a bridge pings anyone**. A reply to a bridged message becomes a real reply, other replies a quote line. Rich embeds are cleaned like webhook embeds. Message types 0, 19, 20 only.

**Here → there.** `messages.onPost` sends every message posted in a linked channel (people, bots, and messages bridged from the *other* platform) through a webhook named **"Ember bridge"** in the linked channel, created on first use and re-created when executing it answers 404 / 401. Payload: `{ content, username, avatar_url, allowed_mentions: { parse: [] }, embeds }` - `username` is the author's name with `discord` / `clyde` removed (Discord refuses those; empty → `Ember`), `avatar_url` the author's picture as an absolute instance URL (else the instance icon), role tokens become names, custom emojis are matched by name, attachments are appended as URLs, replies become a quote line with a jump link, 2000 characters at most. System lines and instance webhook posts are not sent. Webhook ids and tokens stay on the server (`bridge_channels`); they are never in an API response.

**Loop prevention.** Gateway messages from our own webhooks, and message ids we just sent (2 minutes), are ignored; a bridged message is never sent back to the platform it came from.

**Edits and deletes** go both ways through the id map `bridge_msgs (message_id, platform, ext_message_id, ext_channel_id, outbound, created_at)`: an edit here PATCHes the webhook message; a delete here deletes the webhook message, or (for a message that came from there) deletes it with the bot (needs Manage messages over there). An update there edits the bridged copy here (an update with the same text, e.g. a link preview being added, is not an edit; one without `content` is ignored); a delete / bulk delete there deletes it here (`chat_message_update` / `chat_message_delete`). Map rows older than **60 days** are pruned (every 6 hours).

Extension points used (also available to other modules): `messages.onPost`, `messages.onEdit(fn(msg, ctx))`, `messages.onDelete(fn({ id, ch, c }))`, `messages.editBridged(id, body)`, `messages.deleteBridged(id)`, `messages.postBridged(channel, { platform, name, avatar, body, attachments, embeds, replyTo, from, sysKind })`, `communities.onChannelsChanged(fn(c))`.

### 16.4 Voice links (Discord)

A voice channel linked to a Discord voice / stage channel carries **voice only** (`src/bridge/voice-bridge.js` for the signalling, `src/bridge/voice-worker.js`, a worker thread, for the media). It needs the optional dependencies `@discordjs/voice` (with `@snazzah/davey` for Discord's DAVE end-to-end encryption), `werift` and `opusscript`; without them `voice_links` is `false` and nothing connects. The invite link asks for Connect + Speak too.

- **Discord people show up here as themselves.** From `GUILD_CREATE.voice_states` and `VOICE_STATE_UPDATE`, everyone in the linked Discord channel (except our own bot) is put into the room's voice state, whether or not the bridge is carrying audio right now: `chat_voice_state.users[]` and `chat_rtc_room.people[]` entries with `id` / `userId` = `d:<discord user id>`, `username` = `discord:<discord user id>` (never a real username), and the extra fields `platform: "discord"`, `name` (nick, global name or username) and `avatar` (re-hosted like a bridged message's, or `null`). `muted` / `deafened` follow their server or self mute / deafen. They are not members and have no account; clients show the name, picture and the platform's mark instead of a member card. Other clients that don't know the fields see the `username`.
- **The bot joins Discord while someone is here.** While at least one person with an account (a member or bot) is in the Ember channel, the instance's bot sits in the Discord channel; it leaves 15 s after the Ember channel empties (or at once when the link is removed or paused). On Discord only the bot is seen.
- **Discord → here:** each Discord person gets their own participant (a server-side publisher with one `audio` track) once the bot is in; their Opus packets are forwarded as they are, so each has their own speaking ring and volume. **Here → Discord:** a hidden server-side listener (never in `people`) subscribes to everyone with an account, decodes, mixes (60 ms jitter buffer per person, soft limiter), encodes once and the bot plays it. Bridged people are never sent back, so nothing loops.
- The soundboard is not carried to Discord (clients play it locally).

Not ported from Nookara: importing a Discord / Fluxer server through the bot (`/bridge/:platform/guilds/:gid[/import]`) — use Nookara's import bundles (§12.6).

### 16.5 Matrix

The instance owner connects **their own bot**: an ordinary Matrix account on any homeserver (`src/bridge/matrix.js`). There is no application service, so nothing is installed on the homeserver and it works on homeservers the owner doesn't run. It uses the same routes, tables and message hooks as the Discord / Fluxer bridge, with platform id `matrix`.

**A bot per server.** The settings below are the **homeserver's** bot. Any server can bring its own Matrix account instead (table `matrix_bots`), and then uses that one for everything; a server without one uses the homeserver's, as before. Every bot has its own `/sync` loop, its own place in the stream and its own rooms. When two bots sit in the same room, only the bot of the server the room is linked to carries it, so nothing arrives twice.

| route (Manage server) | result |
|---|---|
| `GET /api/v1/bridge/servers/:sid/matrix` | `{ matrix: { own, configured, token, homeserver, source, state, error, bot } }`. `own: true`: the server's own bot (`source: "server"`, the token masked). `own: false`: the homeserver's bot it falls back to (`source: "homeserver"` or `null`); its `token` and `homeserver` are `null` here |
| `PATCH /api/v1/bridge/servers/:sid/matrix { homeserver?, token? }` | the same rules and errors as the homeserver's setting below (checked with `whoami` first; an empty field keeps the stored value); `token: null` removes the server's bot and goes back to the homeserver's. Needs `matrix` on the server's `bridges` limit (§19) |

`GET /bridge/:platform/guilds?sid=`, `GET` / `PUT /bridge/servers/:sid` and the channel routes use the server's bot: its id in `guild_name`, its rooms in `ext_channels`.

**Settings.** `GET /api/v1/bridge/settings` also answers `bridges.matrix = { configured, token: "********WXYZ" | null, homeserver: "https://..." | null, source, state: "off" | "connecting" | "ready" | "waiting" | "error" | "stopped", error, bot: { id, username } | null }` (`id` and `username` are both the bot's Matrix id, `@name:server`). `PATCH /api/v1/bridge/settings { matrix: { homeserver?, token? } }`: an empty or missing field keeps the stored value, `token: null` removes the bot (address, token and its place in the stream). Before anything is saved the pair is checked with `GET /_matrix/client/v3/account/whoami`: `400 invalid_token { platform: "matrix" }`, `400 invalid_homeserver { platform: "matrix" }`, `502 platform_unreachable`. Env fallbacks: `EMBER_MATRIX_HOMESERVER`, `EMBER_MATRIX_TOKEN`.

**The homeserver address** is typed by an admin, so it is treated like any user-supplied address: `https` only, no `user:pass@`, no query, and never a private, loopback or link-local address. The name is resolved by the instance on every connection and the connection is refused if any address it resolves to is private (the same rule as link previews, 6.3). A typed server name is looked up once at `/.well-known/matrix/client` and its `m.homeserver.base_url` is used when there is one. `EMBER_DEV=1` allows `http` and local addresses (development only).

**Rooms.** The bot accepts every invite. Matrix has no servers to pick from, so `GET /bridge/matrix/guilds` answers one entry, `{ id: "rooms", name: "Rooms @bot:server is in" }`, and `PUT /bridge/servers/:sid { platform: "matrix", guild_id: "rooms" }` links the community to it (`guild_name` = the bot's id). In `GET /bridge/servers/:sid` its `ext_channels` are the rooms the bot is in (at most 300): `{ id: "<room id>", name: <room name, else its canonical alias, else its id>, category: "", kind: "text", encrypted?: true }`. `GET /bridge/platforms` lists `{ id: "matrix", name: "Matrix", ready, bot: "@bot:server", invite: null, linked: true, rooms: true }` (`rooms: true` = there is no add-to-server link: the bot is invited to a room like a person). A channel is linked with `PUT /bridge/servers/:sid/channels/:cid { platform: "matrix", ext_channel_id: "<room id>" }`: text channels only (`text_channels_only`), a room the bot is in (`channel_not_found`), not already linked (`already_linked`), and **not encrypted** (`room_encrypted`: the bot holds no keys, so it could neither read nor be read there). A link has no webhook (`hook: false`).

**There -> here.** The bot long-polls `GET /_matrix/client/v3/sync` (30 s, a filter for `m.room.message`, `m.sticker`, `m.room.redaction` and the room's name / member events, members lazy-loaded) and keeps its `next_batch` in the settings, so a restart carries on where it stopped. The first sync only finds its place in the stream: nothing said before the bridge existed is brought over. A message in a linked room is posted with `postBridged` as the person: `author = { name_only: true, webhook: true, bridge: "matrix", username: <their display name in that room, else the name part of their id>, pfp }`. Their picture and any `m.image` / `m.video` / `m.audio` / `m.file` / `m.sticker` are fetched from the homeserver with the bot's token (`/_matrix/client/v1/media/...`, falling back to `/_matrix/media/v3/...` on old homeservers) and stored here like the other bridges do (the picture as a 128 px thumbnail under `/uploads/bridge/avatars/matrix_<hash>.png`; a file as a normal upload under the same size caps, and only when the community allows uploads). A file that can't be stored (too big, uploads off, or encrypted) becomes `[its name]`. The text is the event's plain `body`; `m.emote` is wrapped in `*...*`. `@everyone`, `@here`, `@room` and Ember's own role / user tokens typed over there get a zero-width space so nothing pings here.

**Here -> there.** Matrix has no webhooks: a bot can only speak as itself. Every message posted in a linked channel (people, bots, and messages bridged from another platform) is sent by the bot as `m.text` with `body: "<name>: <text>"` and `formatted_body: "<strong>name</strong>: text"` (everything escaped, new lines as `<br>`). Role, user and channel tokens become names, custom emojis `:name:`, attachments are appended as links, 8000 characters at most. System lines and instance webhook posts are not sent.

**Replies, edits, deletes** go both ways through `bridge_msgs` (platform `matrix`, `ext_message_id` = the event id, `ext_channel_id` = the room id). A Matrix reply (`m.in_reply_to`) to a message that is here becomes a real reply and its quoted fallback lines are dropped; a reply to something that isn't here keeps one quoted line (`> **name** text`). A reply here carries `m.in_reply_to` when the other message is over there, otherwise a quoted line. An edit there (`m.replace`) edits the copy here; an edit here is sent as an `m.replace` event with `m.new_content`. A redaction there deletes the copy here (`redacts` at the top level or in `content`); a delete here redacts the bot's event, or (for a message that came from there) asks the homeserver to redact the person's event, which needs the bot to be a moderator in that room.

**Loop prevention.** Events whose `sender` is the bot are never taken in, a bridged message is never sent back to Matrix, and an event id that is already in `bridge_msgs` is skipped (the same stretch of `/sync` read twice).

**Stopping.** A `401` / `M_UNKNOWN_TOKEN` stops the bot with `state: "error"`, `error: "invalid_token"` until a new token is saved; anything else retries with backoff (1 s doubling to 60 s). `429` answers are waited out (`retry_after_ms`, 15 s at most, 5 tries).

Not done: moving a server's existing links when it changes bots (they stay; a room the new bot is not in shows nothing until it is invited), encrypted rooms, per-person accounts on Matrix (that needs an application service on the homeserver), reactions, and importing a room's history.

### 16.6 Typing

Who is typing is carried both ways on every linked text channel (Discord, Fluxer and Matrix), while the bridge is on.

- **There -> here.** The person shows up here as themselves: `chat_typing` with `bridged: { platform, name, avatar }` (§7), the name and picture a bridged message of theirs would have. Clients forget a typer after 7 s, so the instance says it again every 5 s while it lasts, and sends `typing: false` when it ends.
  - Discord / Fluxer: the gateway's `TYPING_START` (Discord needs the `GUILD_MESSAGE_TYPING` intent, which the bot now asks for; Fluxer has no intents and sends it to bots anyway). It lasts 10 s unless another one arrives, and ends when that person's message arrives. An event with no `member` is looked up with `GET /guilds/:gid/members/:uid` (kept 10 minutes).
  - Matrix: the `m.typing` event of `/sync` (the bot's filter now lets it through) lists everyone typing in the room; people who join the list start, people who leave it stop.
  - The bot's own typing is never shown here.
- **Here -> there.** Nobody but the bot can type over there, so the bot does, without saying who: Discord / Fluxer `POST /channels/:id/typing` at most once every 8 s per channel; Matrix `PUT /_matrix/client/v3/rooms/:room/typing/:bot { typing: true, timeout: 8000 }` at most once every 6 s per room, and `{ typing: false }` once the message is sent. Discord and Fluxer have no "stopped typing" call, and the message goes out through a webhook, so the bot can show as typing for a few seconds after the message landed.
- Someone who turned `share_typing` off is never announced, here or there. Typing by bots (`POST /channels/:cid/typing` of the bot API) is not carried.

### 16.7 A Matrix space as the community

The Discord / Fluxer import (§12.6) is done by Nookara with its own bot. Matrix has no such bot, so the instance does it itself (`src/bridge/matrix-import.js`) with a Matrix account the admin brings: the same kind of bot as §16.5, and the same rules for the homeserver address. Instance admins only, and only while the instance has no community (`403 not_allowed` / `forbidden`, `409 community_exists`). These routes are **not** behind the bridges plan: copying a space is not a bridge.

| Route | Answer |
|---|---|
| `GET /api/v1/import/matrix` | `{ ready, bot: "@name:server" \| null, saved, can_bridge }`. `saved`: the bridge's own bot (§16.5) is being used; `can_bridge`: the plan allows bridges |
| `PUT /api/v1/import/matrix/bot { homeserver, token }` | checked with `/account/whoami` (`400 invalid_homeserver` / `invalid_token`, `502 platform_unreachable`), then the same answer. The token is kept **in memory only**, for 30 minutes, per admin, and is never returned |
| `DELETE /api/v1/import/matrix/bot` | forgets it |
| `GET /api/v1/import/matrix/guilds[?fresh=1]` | `{ bot, guilds: [ { id: "<room id of the space>", name, icon: null, rooms } ] }`: every space the bot is in, plus `{ id: "rooms", name: "Rooms outside a space", loose: true }` when it is in rooms that belong to none of them. `503 bridge_not_set_up` without a bot |
| `GET /api/v1/import/matrix/guilds/:gid` | the picker preview, the shape of §12.6: `{ platform: "matrix", guild: { id, name, description, icon: null, has_icon, banner: null }, groups: [ { id, name, channels: [ { id, name, topic, kind: "text" \| "voice" \| null, skip, private, locked, encrypted, joined } ] } ], roles, everyone_send, emojis: [ { id, name, animated, url: null } ], emoji_total, can_bridge }`. `404 bot_not_in_server` |
| `POST /api/v1/import/matrix { guild_id, channels: [room id…], roles: ["admin", "mod"], name?, icon?, emojis?, bridge? }` | `{ sid, channels, roles, emojis, bridged }`. `pick_a_channel`, `429 import_running` |

- **Reading the space.** One `/sync` with a filter that leaves nothing but room state gives every room the bot is in; its invites are accepted first. Rooms of the space the bot is not in come from `GET /_matrix/client/v1/rooms/:space/hierarchy` (as far as the homeserver shows them to the bot); a homeserver without it just shows fewer rooms.
- **What becomes what.** A room is a text channel (a call / video room a voice channel; any other room type is not brought over). A space inside the space is a category, with every room below it, however deep; rooms directly in the space go to "Text channels". The order is the space's (`order`, then age). The room's topic is the channel's topic.
- **Private and locked.** A room that is not `public`, `restricted` or `knock_restricted` comes over hidden from `@everyone` and visible to the roles brought over. A room where `events_default` is above `users_default` comes over locked.
- **Roles.** Matrix has power levels, not roles: `admin` (Admin, administrator) and `mod` (Moderator: kick, ban, manage messages, mention everyone) stand in for them. Nobody has them after the import.
- **Picture and emoji.** The space's avatar becomes the icon. Custom emoji come from the space's `im.ponies.room_emotes` state events (MSC2545), `emoticon` usage only, 100 at most.
- **Members and messages** stay on Matrix. The import is a `bonfire-export-v1` zip (`source_kind: "matrix-import"`) fed to the normal importer (§9).
- **`bridge: true`** (only when the plan allows bridges): the bot is saved as the bridge's bot (§16.5), the community is linked, and each imported text room is linked to its channel. Encrypted rooms are left out, and so are rooms the bot is not in and may not walk into (it joins `public` and `restricted` ones itself).

## 17. CloudLink bridge

A `logs` channel can join a **CloudLink 4** chat instead of being a webhook channel: `config = { mode: "cloudlink", url, room, username }` (Manage channels).

- `url`: `ws:` / `wss:` only, no credentials, ports 80 / 443 only (`cl_bad_url`, `cl_bad_port`); empty = `wss://ikelene.net/cl/` (the official server). Refused (`cl_private_address`): `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, numeric host spellings, and any private / loopback / link-local / metadata / reserved address (the same rules as link previews, §6.3, IPv4 and IPv6). The host is resolved again on **every connect** with a lookup that refuses the connection when *any* address is private, so DNS rebinding cannot reach the LAN. `EMBER_DEV=1` lifts the address and port rules (development only).
- `room` ≤ 60 chars (empty = the main chat), `username` ≤ 40 (no `:`). With a room and no username the bridge uses `Ember`.
- At most **3** CloudLink channels per community (`too_many_cloudlink_bridges`). The view adds `official: true` for the official URL.
- Posting: unlike plain logs channels, a CloudLink channel is a chat — members with Send post (unless it is locked, then Manage messages).

The instance holds one socket per channel: `{"cmd":"handshake"}`, then `setid` (username) and `link` (room) after each `statuscode`; ready after the last step (or 8 s). It pings every 30 s and reconnects with backoff (5 s doubling to 5 min, 10 min after an address refusal).

- **CloudLink → here**: `gmsg` packets for our room whose `val` is `"Name: text"` are posted with `postBridged` as `{ bridge: "cloudlink", username: Name }`; prefixes `[Discord] `, `Fluxer | `, `Ember | ` set `author.bridge_from` (`Discord`, `Fluxer`, `Ember`). Control characters are removed, every `@` gets a zero-width space (nothing pings), 2000 characters max, 8 per 10 s and 40 per minute per channel (beyond that a system line says messages were skipped, at most once a minute). The `gmsg` a server replays before we are ready is skipped.
- **Here → CloudLink**: messages from people (not system / webhook / bridged) go out as `{"cmd":"gmsg","val":"Ember | <username>: <text>"}` (+ `rooms` when set): one line, role tokens as names, custom emojis as `:name:`, attachment URLs appended, `(replying to X)`, 1000 characters, 15 per 10 s. The server echoes `gmsg` back to its sender; each value we sent is skipped **once** within 20 s (echo suppression).
- **`!online`** typed in the channel is answered (as `CloudLink`) from the room's `ulist` and not forwarded.

Routes (Manage channels, CloudLink channels only, else `400 not_a_cloudlink_bridge`): `GET /channels/:cid/cloudlink` and `POST /channels/:cid/cloudlink/reconnect` → `{ status: { mode, url, room, username, official, state: "connecting" | "handshaking" | "connected" | "waiting" | "off" | "stopped", error, since, retry_at, online, users: [name…], last_in, last_out, skipped } }` (`off` + `error: "over_limit"` for a 4th channel).

## 18. Ember Link (Minecraft)

The `game` channel type links a Minecraft server ("Ember Link" plugin / mod) to the community. The plugin keeps **one outbound WebSocket** per root (a Velocity proxy, or a standalone Paper / Spigot / Fabric / Forge server) to the instance - no open ports needed.

### 18.1 Connecting: `bonfire server <url>`
1. The server owner runs `bonfire server https://chat.example.com` in the server console. The plugin stores the URL and connects to `wss://chat.example.com/game-gateway?v=1` (`http://` → `ws://`).
2. Once identified, an unlinked server shows up in the instance's **Connected game servers** list (`GET /api/v1/game/connected`, Manage server) — with its MOTD, icon, version, player count and **pairing tag** (printed in its console on startup, so the admin can tell servers apart).
3. A community admin creates a game channel (it starts "not set up", visible only to managers) and **picks the server from the list** (`POST /api/v1/game/connected/:iid/link { cid }`). The channel gets the server; the admin picks the purpose (info / console / chat).
4. Alternative (Nookara's flow, kept): a claim code. `POST /api/v1/game/claims { sid, cid? }` → `{ code: "XXXX-XXXX", command: "bonfire link XXXX-XXXX", expires_at }` (10 minutes, 10 per hour per user); running the command in the console links the server whose console ran it.

### 18.2 Gateway frames
Every frame is a JSON text frame `{ "op": "<name>", "d": { … }, "id"?: <n> }`, at most 64 KB (bigger closes with 1009; binary closes 4001).

| direction | op | d |
|---|---|---|
| server → game | `hello` | `{ v: 1, nonce, heartbeat_ms: 30000 }` |
| game → server | `identify` (within 15 s) | `{ v: 1, key: <b64 SPKI DER Ed25519, 44 bytes>, sig: <b64 Ed25519 over "bonfire-gw-v1|<nonce>|<iid>">, iid, platform: paper\|spigot\|fabric\|velocity\|forge, software, mc_version, mod_version, listing: public\|private, motd: [segment], icon_sha256?, max_players, online_mode, public_address, features: { chat, events, console, console_exec } }` |
| server → game | `ready` | `{ iid, pairing_tag, linked: { server_name, sid, linked_by, linked_at } \| null, icon_needed, relay: { chat, events }, console_stream, limits: { frames_per_s: 30, chat_per_10s: 20 } }` |
| game → server | `heartbeat` `{ seq }` | answered with `heartbeat_ack { seq }` |
| game → server | `status` | `{ online, version, motd, players: { online, max, list: [ { uuid, name, display?, server? } ≤ 100 ] }, tps, uptime_s, backends?: [ { name, online, version, motd, players } ] }` |
| game → server | `icon` | `{ png: <b64> }` (PNG ≤ 48 KB, ≤ 1024 px) when `ready.icon_needed` |
| game → server | `chat` | `{ uuid, name, display, text ≤ 512, server?, bedrock?, skin? }` (linked only; 20 per 10 s, beyond that one "skipped" line a minute) |
| game → server | `event` | `{ kind: join\|leave\|death\|advancement\|switch\|server_start\|server_stop\|backend_up\|backend_down, uuid, name, display, text?, advancement?: { id, title, frame }, from?, server?, skin? }` |
| game → server | `console.log` | `{ lines: [ { t, level, logger, msg } ] }` (10 frames / s, 40 lines / s kept, a ring of 1000 lines per server) |
| game → server | `console.command` | `{ t, source: console\|rcon, by, command }` (typed on the server; audited as `[CONSOLE] …` / `[RCON] …`, status `local`) |
| server → game | `console.exec` | `{ req, command, by }`; answered with `console.result { req, ok, output: [line ≤ 100], truncated?, error? }` within 10 s |
| server → game | `chat` | `{ id, channel, author: { username, color, bot, webhook, bridge? }, segments: [segment ≤ 400 chars], reply: { author, text } \| null }` (synced-chat channels; never for messages from Minecraft) |
| server → game | `config` | `{ relay: { chat, events }, console_stream }` whenever what the channels need changes |
| game → server | `link` `{ code }` (with `id`) | answered `link_result { ok, server_name? , error?: invalid_code\|expired\|not_allowed\|already_linked\|too_many_instances\|rate_limited }` (5 per 10 min) |
| server → game | `linked` | `{ server_name, sid, linked_by }` (after a code or an admin's pick) |
| game → server | `unlink` | `bonfire unlink confirm` in the console |
| server → game | `unlinked` | `{ by: ember\|console, username }` |
| server → game | `error` | `{ code: rate_limited\|not_linked\|bad_op, message, fatal: false }` |

**Skins.** `skin` (optional, on `chat` and `event`) is the player's skin texture URL from their profile, `https://textures.minecraft.net/texture/<hex>` and nothing else (anything else is ignored). With sharp installed the instance downloads that one texture (4 s, 256 KB, once per texture), cuts out face + hat, enlarges it to 64×64 and serves it as `/uploads/game-heads/<hex>.png`; that is the message's avatar. It is what makes heads work on offline-mode servers, where mc-heads.net can't find the skin. Without `skin` (an older mod) the instance asks Mojang's session server for the skin of a real (v4) UUID once per 10 minutes and renders that the same way. Without sharp, or when both fail, the avatar is `https://mc-heads.net/avatar/<uuid or name>/64` as below. Frames are posted in order even while a texture downloads.

A **segment** is `{ text, color?: "#rrggbb", b?, i?, u?, s?, code?, link?: https URL, hover? }`. MOTDs are cleaned to 2 lines / 120 characters, no links.

**Identity (trust on first use).** `iid = "g" + first 16 hex of sha256(SPKI DER)`; pairing tag = the top 30 bits of sha256 bytes 8–11 as 6 Crockford characters shown `XXX-XXX`. The first identify with a key creates the identity; later ones must sign with the same key (the iid is derived from it). One session per iid: a newer one closes the older with 4006.

**Limits.** 10 open sockets per address; a token bucket of 30 frames / s (burst 60): excess frames are dropped (one `error rate_limited` per 5 s) and **10 s** of sustained excess closes the socket (4005). New identities: **5 per address per day**, 200 per hour on the instance (4008). Addresses are only kept as salted hashes (`EMBER_TRUST_PROXY=1` takes `X-Forwarded-For`).

**Close codes:** 4000 server error, 4001 malformed / identify first / binary, 4002 identify timeout, 4003 bad key / signature, 4004 banned, 4005 rate limited, 4006 replaced by a newer session, 4007 unsupported protocol version, 4008 too many connections / new servers from this address, 1001 instance shutting down.

The connected list only shows sessions that are identified, unlinked, not banned, sent a heartbeat or status in the last 3 minutes and have been up for 10 s; `listing: "private"` servers only show for their pairing tag; the unfiltered list shows at most 20 per address. A server is marked offline 60 s after its socket closes (at once after `server_stop`).

### 18.3 Game channels
`config = { game: "minecraft", instance: iid | null, purpose: "info" | "console" | "chat" | null, events: { join, leave, death, advancement, switch, server } (default all true), address ≤ 120, show_players, show_server_tag }` (Manage channels; `instance` must be linked to this community, `instance_not_linked`; `purpose: "console"` needs Manage server; `bad_purpose`, `bad_game`). The view adds `setup` (instance and purpose set), `instance_name`, `platform`, and `address` falls back to the server's `public_address`.

- **Visibility**: not set up → only Manage channels / Manage server / Administrator; `console` → **Manage server only** (even over Manage channels and channel permissions); otherwise the normal rules.
- **Posting**: only `chat` channels take messages (Send, like a text channel). Their messages go to the game (`chat` frame); the game's `chat` / `event` frames are posted with `postBridged` as `{ bridge: "minecraft", username: display name, pfp: https://mc-heads.net/avatar/<uuid or name>/64, bridge_from: the Velocity backend (when show_server_tag) }`; events carry `sys_kind` `mc_join`, `mc_leave`, `mc_death`, `mc_adv`, `mc_switch`, `mc_start`, `mc_stop` and respect the channel's `events` switches. Nothing from the game pings (`@` gets a zero-width space). Unlinking posts a system line (`mc_unlink`).
- A community links at most 10 servers (`too_many_instances`).

### 18.4 REST (`/api/v1/game/*`, same shapes as Nookara's `/chat/game/*`; `sid` may be omitted where it is a query / body field while the homeserver has one server; `400 sid_required` with several)

| route | who | result |
|---|---|---|
| `GET /game/downloads` | public | `{ version: null, modrinth_url: "", files: {} }` (the instance doesn't host plugin builds) |
| `GET /game/connected?sid=&tag=&q=&page=` (alias `/game/unclaimed`) | Manage server, 30 / min | `{ instances: [ { iid, platform, mc_version, motd, icon, players: { online, max }, pairing_tag, connected_at } ], total, page, pages, tag_match }` (20 per page) |
| `POST /game/connected/:iid/link { sid?, cid? }` | Manage server | links a connected, unlinked server (`not_connected` 404, `already_linked` 409, `too_many_instances`); `cid` = a game channel without a server that gets it → `{ instance }` |
| `POST /game/claims { sid?, cid?, hint? }` | Manage server | `{ code, command, expires_at }` |
| `GET /game/claims/:code` | the creator | `{ state: "pending", expires_at }` / `{ state: "linked", instance, hint }` / `{ state: "expired" }` (`claim_not_found` 404) |
| `GET /game/servers/:sid/instances` | Manage channels | `{ instances: [ instance ] }` |
| `DELETE /game/servers/:sid/instances/:iid` | Manage server | unlink → `{ ok: true }` |
| `GET /game/channels/:cid/status` | can view the channel | `{ instance, status, online, last_seen, connected, features }` (info channels with `show_players: false` drop the player list) |
| `GET /game/channels/:cid/console?before=<seq>` | can view (console = Manage server) | `{ lines: [ { seq, t, kind: "log", level, logger, msg } \| { seq, t, kind: "command", source: "bonfire"\|"console"\|"rcon", by, command, status? } ], has_more }` (200 per page) |
| `POST /game/channels/:cid/console { command }` | Manage server, 10 per 10 s | `{ ok: true, output, truncated }` / `{ ok: false, error: offline\|timeout\|console_disabled\|…, output? }`; every command is in the audit log |
| `GET /game/servers/:sid/audit?before=<id>` | Manage server | `{ entries: [ { id, kind: link\|unlink\|command, command, status: sent\|ok\|error\|timeout\|denied\|local, output_preview, user: { id, username, pfp } \| null, instance, instance_name, created_at } ], has_more }` (50 per page) |

An **instance** object is `{ iid, platform, software, mc_version, mod_version, name, motd, icon, public_address, online, last_seen, linked_by, linked_at, pairing_tag, backends?, channels?: [ { cid, name, purpose } ] }`.

**Gateway events** (instance gateway, §7): `game_status { server, channel, instance, status, online, last_seen }` (per game channel, debounced 2 s; online / offline at once), `game_console { server, channel, instance, lines }` (console channels), `game_linked { server, instance, claim?, hint? }`, `game_unlinked { server, instance }`. Channel events only reach members who can view that channel.

**Retention**: unlinked identities not seen for **30 days** (and not connected) are deleted hourly, with icons nobody uses; audit entries are kept a year. Discovery shows `features.minecraft: true`.

**The plugin side** (Ember Link 0.2.0+, `minecraft-mod/`): `bonfire server <url>` stores the instance as `server=` in `config.properties` and connects to `<ws(s) of url>/game-gateway?v=1` (a path prefix is kept, `bonfire server nookara` goes back to `wss://velora.ikelene.net/chat/game-gateway`); everything else (frames, identity, claim codes, `bonfire link` / `bonfire unlink confirm`) is unchanged. It prints the pairing tag and the instance it is connected to, and "waiting for an admin to pick this server" while unlinked.

---

## 19. Limits and tiers

What a server may have is decided per server, by the homeserver it lives on. In order: the **override** a homeserver admin set for that server, the **tier** it paid for while that lasts, the homeserver's **defaults**. A self-hosted homeserver's defaults limit nothing.

### 19.0 Limits

```json
{ "member_cap": null, "voice_minutes": null, "max_upload_mb": 25, "storage_mb": null, "files_per_member": null, "upload_expiry_days": null,
  "emojis": null, "sounds": null, "bots": null, "bridges": ["discord", "fluxer", "matrix", "cloudlink"], "custom_voice_keys": true }
```
- `null` = unlimited; `0` = not at all. `bridges` is the list of platforms a server may bridge to (`true` / `null` in a request = all four, `false` = none). `custom_voice_keys: false` = calls in that server never use the homeserver's own Cloudflare keys, only Nookara's broker (§12.7).
- `max_upload_mb` left out of the defaults is the instance's `max_upload_mb` setting (§5); `null` means the hard ceiling of 500 MB.
- `voice_minutes` is metered per server: every minute an account (not someone bridged in from another platform) is connected to one of its voice channels counts, per calendar month (UTC), in table `voice_usage`. `usage.voice_minutes` is this month's. At the limit `chat_rtc_join` answers `chat_error { error: "plan_limit", what: "voice_minutes", limit, used }` (`0`: `plan_feature`), and calls going on end within a minute with `chat_rtc_left { room, reason: "voice_minutes" }`. Voice through Nookara's broker is also still capped per homeserver by Nookara (§19.4).
- `storage_mb` counts the uploads sent to that server (§11); older uploads belong to no server.
- The server's own settings (§6.4: member limit, files per member, expiry, storage) can only narrow these; a saved number above the limit counts as the limit.

**Homeserver settings** (`config.json` `limits`, or the admin API):
```json
"limits": { "defaults": { "emojis": 50, "member_cap": 100, "bridges": ["discord"] },
            "tiers": [ { "id": "plus", "name": "Plus", "limits": { "emojis": null, "member_cap": null, "bridges": true }, "price_credits": 50, "period_weeks": 1 } ] }
```
`defaults` and each tier's `limits` are partial: a key that is left out falls through to the next level. A tier `id` is `[a-z0-9][a-z0-9_-]{0,23}`, unique, at most 20 tiers; `name` 1-40 characters; `price_credits` 1-100000; `period_weeks` 1-52.

| route | result |
|---|---|
| `GET /api/v2/homeserver/limits` (admins) | `{ defaults: <the full object in force>, saved_defaults: <what is configured>, tiers, managed: bool, tiers_available: bool }` |
| `PATCH /api/v2/homeserver/limits { defaults?, tiers? }` (admins) | each key that is sent replaces the stored one whole. `400 invalid_limits { field }`, `400 invalid_tiers { field, tier? }`, `403 managed_setting { setting: "limits" }` |
| `GET /api/v2/homeserver/servers/:sid/limits` (admins) | `{ sid, overrides, note, updated_by, updated_at, ...<the member view below> }` |
| `PATCH /api/v2/homeserver/servers/:sid/limits { overrides?, note? }` (admins) | `overrides` is a partial limits object and replaces the stored one; `null` or `{}` removes it. `note` at most 300 characters. Table `server_limits (community_id PK, overrides JSON, note, updated_by, updated_at)` |
| `GET /api/v1/servers/:sid/limits` (members) | `{ limits: <effective>, usage: { member_cap, emojis, sounds, bots, storage_mb }, tier: "<id>" \| null, until: <ms> \| null, overridden: bool, tiers: [ { id, name, price_credits, period_weeks, limits } ], tiers_available: bool }` |

- `GET /api/v1/servers/:sid/settings` carries the same member view as `settings.limits` (where `plan` was; `plan` stays `null` outside managed mode).
- When a server's limits change (an override, a tier bought), its sockets get `{ type: "chat_server_limits", server, limits, tier, until }`.
- Discovery (§3) has `limits: { defaults, tiers: [ { id, name, price_credits, period_weeks } ] }`.

**What is refused**, in that server only (the codes of §19.2, unchanged; `plan` is the server's tier id, or the managed plan, and is left out when there is neither):
- joining past `member_cap`: `403 member_cap_reached { cap, what, limit, used }` (the owner and instance admins are never blocked, bots do not count);
- one more emoji / sound / bot than allowed: `403 plan_limit { what, limit, used }`; the lists report `max`;
- a file over `max_upload_mb`: `403 plan_limit { what: "max_upload_mb", limit, used: null }` when that number comes from a configured default, a tier or an override (the instance's own `max_upload_mb` with nothing else set stays `413 file_too_large`); uploads past `storage_mb` or `files_per_member`: `plan_limit` / `storage_full` / `upload_quota`;
- a bridge platform that is not on the list: `403 plan_feature { what: "bridges" }` (§16, §17).
- Nothing is ever taken away. When a limit drops (a tier ran out, an override was removed), what is over it stays and only new additions are refused.

### 19.0a Tiers

A server's **owner** buys one of the homeserver's tiers with Nookara credits, through the pay requests of §12.5. Only a homeserver registered with Nookara can sell (`409 tiers_unavailable` otherwise, and `tiers_available: false`); the buyer needs a Nookara account (`402 velora_required`).

- `POST /api/v2/servers/:sid/tier { tier }` -> `{ status: "pending", pay_request: { id, status, approve_url, amount, tier, expires_at }, tier, until }`. The instance asks for a pay request with `amount = price_credits`, a `reason` naming the tier and server, and `ref = "tier:<tier>:server:<sid>:<period start ms>"`. Asking again while one is open returns the same request. Errors: `owner_only` (403), `unknown_tier` (404), `tiers_unavailable` (409), and the pay-request errors of §12.5.
- `GET /api/v2/servers/:sid/tier` (owner) -> `{ tier, until, status: "none" | "pending" | "paid" | "declined" | "expired" | "failed", pay_request, tiers_available }`. It asks Nookara about an open request right away; the instance also polls every few seconds while one is open.
- The person approves on Nookara (`approve_url`). The receipt (`ember-receipt+jwt` / `bonfire-receipt+jwt`) is checked as in §12.5 (signature, `aud`, `sub`, `amount`, `ref`, `rcp` unused). Then `server_tiers (community_id PK, tier, until, receipt_jti, updated_at)` is set (`receipt_jti` holds the receipt's `rcp`) and the owner gets `{ type: "chat_tier_update", server, status, tier, until }`. A receipt that does not check out sets nothing (`status: "failed"`, `pay_request.error`).
- **Periods stack.** Buying the tier a server already holds starts the new period where the running one ends (`until += period_weeks`). Another tier starts now and replaces it.
- **Running out.** After `until` the server is back on the defaults (and its override, if any). Nothing renews by itself. A tier that the homeserver removed from its list no longer gives anything, so rename a tier rather than delete one that servers hold.

### 19.0b Nookara-hosted instances (the old managed mode)

`EMBER_MANAGED=1` still works, as an alias: the plan's numbers (19.1, 19.2) become the homeserver's default limits (`bridges: false` = `[]`), so the old hosted containers keep their caps until they are moved. In that mode the defaults, the tiers and the overrides cannot be changed from the instance (`403 managed_setting { setting: "limits" }`), no tier is sold, and the `managed` / `plan` objects below are still sent for old clients. Everything else on this page describes that mode.

Nookara can run an Ember instance for someone: a `bonfire-server` container behind `https://<slug>-bonfire.ikelene.net`, started by **bonfire-hostd** (`bonfire-hostd/`, the Docker host agent) when the owner creates a server from Ember. The instance is an ordinary instance (Nookara accounts, registered with Nookara, one community) that was started in **managed mode**. Everything on this page is optional for self-hosters: without `EMBER_MANAGED=1` and `EMBER_READ_ONLY=1` nothing changes.

### 19.1 Plans

| | `starter` | `plus` |
|---|---|---|
| who | anyone, free, 1 per account | bought in prepaid weeks |
| members | 30 | unlimited |
| voice (participant-minutes / calendar month, per instance) | 3000 | 30000 |
| upload size | 10 MB | 250 MB |
| emojis / soundboard sounds / bots | 50 / 10 / 2 | unlimited |
| Discord / Fluxer / CloudLink bridges | no | yes |
| own Cloudflare voice keys | no (always Nookara's broker) | yes |
| files each member keeps / upload expiry / total upload storage | 500 / never / 2048 MB | unlimited |

`plus` costs what Nookara Pro costs with credits **per week** (`CREDIT_TIER_WEEK_COST.pro`, 50 credits). It never renews by itself (§19.8). All numbers are env-overridable on Nookara (`EMBER_PLAN_<PLAN>_<FIELD>`, e.g. `BONFIRE_PLAN_PLUS_PRICE_CREDITS`) and editable by staff. Voice caps: a hosted instance gets its plan's number, a self-hosted untrusted one the starter number, a trusted one none, and the staff `voice_cap_override` always wins.

`GET NOOKARA/bonfire/hosting/plans` (public) -> `{ plans: [ { id, name, price_credits, period: "week" | null, limits: { member_cap, voice_minutes, max_upload_mb, emojis, sounds, bots, bridges, custom_voice_keys, files_per_member, upload_expiry_days, storage_mb } } ], available, domain, host_template, url_template, starter_limit_per_account }`. `null` = unlimited; `period` is `null` for the free plan.

### 19.2 Managed mode (`EMBER_MANAGED=1`)

The host sets `EMBER_MANAGED=1`, `EMBER_PLAN` and `EMBER_LIMITS` (JSON of `member_cap`, `max_upload_mb`, `emojis`, `sounds`, `bots`, `bridges`, `custom_voice_keys`; a missing key falls back to the plan's number, `null` = unlimited), plus `EMBER_OWNER=v:<id>`, `EMBER_ACCOUNTS_MODE=nookara`, `EMBER_PUBLIC_URL` and `EMBER_NOOKARA_URL`. The instance then enforces:

- **Member cap.** Joining (`POST /servers/:sid/join`, `POST /join/:code`, a join request, accepting one) past `member_cap` retains the compatibility code: `403 { error: "member_cap_reached", cap, what: "member_cap", limit: cap, used: <human count>, plan: <name> }`. A zero allowance returns `plan_feature`. The community owner and instance admins are never blocked; bots are not counted. `GET /servers/:sid` (and every server object) has `member_cap` (`null` when none).
- **Uploads.** `max_upload_mb` and the community's `upload_max_mb` are capped at the plan's number (a larger setting is accepted and reported as the cap). When the plan is the effective size cap, oversized uploads/imports return `403 { error: "plan_limit", what: "max_upload_mb", limit: <MB>, used: null, plan: <name> }`; zero disables uploads with `plan_feature`. A smaller community/role cap still returns `413 file_too_large`. Image, sound and backup format/safety size limits remain independent of the plan.
- **Counts.** Creating an emoji / soundboard sound / bot past its positive allowance returns `403 { error: "plan_limit", what: "emojis" | "sounds" | "bots", limit: <number>, used: <current count>, plan: <name> }`. Zero allowance returns `plan_feature`. The matching lists report the plan's `max`; the bot list additionally reports `used`, including gallery bots. Bot usage counts only current community members, never retained accounts/history. Adding an existing bot (including gallery re-add) also checks the allowance.
- **Bridges** off: every `/api/v1/bridge/*` route and CloudLink channel settings answer `403 plan_feature` with `what: "bridges"`, `features.bridges` is `false`, and no bridge connects.
- **Custom voice keys** off: a `PATCH /api/v1/instance/settings` that sets any non-empty `voice` value -> `403 { error: "plan_feature", what: "custom_voice_keys", limit: 0, plan: <name>, message: <sentence> }` (clearing is fine); saved keys are ignored, voice always goes through Nookara's broker (§12.7).
- **Locked settings.** `accounts_mode` (always `velora`), `public_url`, `nookara_url`, `nookara_registration` (always `auto`): a PATCH that changes one -> `403 { error: "managed_setting", setting }`. Sending the current value is accepted, so an admin form can send everything back. Restart stays allowed.

`GET /.well-known/ember` and `GET /api/v1/instance/settings` carry `"managed": { "plan": "starter", "limits": { … }, "host": "velora" }` (`null` on a normal instance).

Plan restriction responses use stable machine-readable keys. A feature wholly absent from the plan returns HTTP 403:

```json
{ "error": "plan_feature", "what": "bridges", "limit": 0, "plan": "starter", "message": "This plan does not include bridges." }
```

A positive numeric allowance already exhausted returns HTTP 403:

```json
{ "error": "plan_limit", "what": "bots", "limit": 1, "used": 1, "plan": "testing" }
```

`plan_limit` remains the existing count-limit code. `plan_feature` replaces its former boolean `limit: false` cases and covers numeric zero allowances. `what` is the configuration key, not a display label. `plan` is the instance's known plan name, including custom plan names. `used` is a count, or `null` for a per-file size allowance (not cumulative storage). The legacy `member_cap_reached` code retains `cap` and adds the same `what`, `limit`, `used`, `plan` metadata; clients must also handle this compatibility code. `managed_setting` and `read_only` retain their existing meanings and are not plan-feature denials.

Admin `GET /api/v1/instance/info` and admin `GET`/`PATCH /api/v1/instance/settings` additionally return a fresh `plan` block (`null` for an unmanaged instance; omitted from public instance info). The existing `managed` block is unchanged. Example for a custom plan with one bot:

```json
{
  "plan": {
    "name": "testing",
    "limits": {
      "bots": { "limit": 1, "used": 0 },
      "emojis": { "limit": 50, "used": 0 },
      "sounds": { "limit": 10, "used": 0 },
      "member_cap": { "limit": 30, "used": 1 },
      "max_upload_mb": { "limit": 10, "used": null }
    },
    "features": {
      "bridges": false,
      "custom_voice_keys": false,
      "bots": true,
      "emojis": true,
      "sounds": true,
      "uploads": true,
      "backups": true,
      "game_servers": true,
      "ember_link": true,
      "webhooks": true
    }
  }
}
```

`limit: null` means unlimited. Counts describe the instance's community, excluding non-member bot accounts; `stats.bots` and bot-list `used` likewise exclude them and refresh immediately after removal. Feature flags express plan entitlement, not user permissions, backend availability or read-only status. Backups, game servers/Ember Link and webhooks have no managed-plan restriction in this server and remain `true`; their ordinary permission, rate and safety limits still apply.

On kick, ban or leave, human gateways receive `chat_server_removed` and lose the community subscription; typing is cleared with `chat_typing { typing: false }`. RTC participants receive `chat_rtc_left { room, reason: "membership_removed" }`, and their voice/RTC state and upstream sessions are removed. Bots receive `GUILD_DELETE { id, unavailable: false }`; when no memberships remain all their `/bot/gateway` sockets close with `4003`, reason `community membership removed: <left|kicked|banned>`, and presence becomes offline. Token reset/rotation uses `4004`. Deletion and gallery revocation use the same membership cleanup before closing any remaining sockets.

Kicked/banned/left gallery bots retain their account/history with `gallery_active = 0`; their token cannot authenticate. A fresh add-ticket reactivates the existing row after bans and plan capacity are checked. Removal schedules a debounced report (normally 3 seconds) to the existing `POST /bonfire/relay/bots/sync`, including an empty `bots` list when the final install is removed. An in-flight reply cannot reactivate a removed bot, and a removal during sync queues another report. Nookara must treat that list as the authoritative installed set for the reporting instance and delete/mark removed any absent install rows, then recompute counts. No new relay endpoint is required. If Nookara only upserts submitted rows, that reconciliation is the needed Nookara-side change. Failed/offline reporting retries on the existing periodic sync.

### 19.3 Read-only mode (`EMBER_READ_ONLY=1`)

The host switches it on when a hosted server's paid time is over (§19.8). Every write is refused with `403 { error: "read_only" }`: posting (also through the gateway, bots, webhooks, bridges and Ember Link), editing, reactions, joins, uploads, settings, channels, roles, invites, emojis, bots, webhooks, and joining a voice room. Still allowed: signing in (`/api/v1/auth/*`) and every `GET` (including the owner's `GET /servers/:sid/export`). `/.well-known/bonfire` has `"read_only": true` and server objects have `read_only: true`. Clients should show a banner and hide write controls.

### 19.4 Voice quota for admins

`GET /api/v1/instance/settings` -> `nookara.voice: { cap_minutes, used_minutes }` (`cap_minutes: null` = unlimited). While registered, the instance refreshes it from Nookara (`GET /bonfire/relay/rtc/usage`) at least every **10 minutes** (and on registration) and whenever a voice call reports it. Instance admins get the numbers on the gateway: `auth_success` carries `voice_quota: { cap_minutes, used_minutes }` when known, and after every change an `instance_update { settings, voice_quota }` frame is sent to **admins only**. A client warns admins at >= 80 % (`used_minutes / cap_minutes`) and says voice stops at 100 % (`voice_cap_reached`, §12.7).

### 19.5 Nookara hosting API (`NOOKARA/bonfire/hosting/*`)

Bearer token. Spending needs the `CURRENCY_PAY` scope (like Pro's buy route); the rest `CHAT`. Everything except `plans` answers `503 hosting_unavailable` when hostd is not configured (`BONFIRE_HOSTD_URL`, `BONFIRE_HOSTD_SECRET`, and a valid `BONFIRE_HOSTING_HOST_TEMPLATE` or fallback `BONFIRE_HOSTING_DOMAIN`). A hosted **server object**:

```json
{ "slug": "camp", "url": "https://camp-bonfire.ikelene.net", "name": "Camp", "plan": "starter" | "plus", "status": "provisioning" | "running" | "stopped" | "suspended" | "deleted" | "error",
  "billing": "pro" | "active" | "overdue" | "read_only" | "archived", "pro_covered": bool, "paused_ms": <number>, "paid_until": 1760000000000 | null, "read_only_at": <ms> | null, "archive_at": <ms> | null,
  "created_at": <ms>, "last_error": null, "price_credits": 50, "period": "week", "voice": { "cap_minutes": 3000, "used_minutes": 120 } }
```

| route | what |
|---|---|
| `GET /hosting/plans` | public; `{ plans, available, host_template, url_template, domain, starter_limit_per_account }`. Production: `host_template: "{slug}-bonfire.ikelene.net"`, `url_template: "https://{slug}-bonfire.ikelene.net"`, `domain: "-bonfire.ikelene.net"` (the part after `{slug}`). Templates contain exactly one `{slug}`, may include a prefix/suffix and must form valid DNS labels for all 3-32 character slugs (each label <= 63 characters). `BONFIRE_HOSTING_HOST_TEMPLATE` takes precedence; fallback is `{slug}.<BONFIRE_HOSTING_DOMAIN>` (dev: `bonfire.localhost`). Missing/invalid configuration yields null templates and `available: false`. Slugs retain the built-in service reservations; `BONFIRE_HOSTING_RESERVED` adds comma-separated names. |
| `GET /hosting/slug/:slug` | `{ available, reason? }`; `reason` is `invalid`, `reserved` or `taken`. A name you removed stays yours for 30 days: `{ available: true, reserved_for_you: true }` |
| `POST /hosting/servers { slug, name, plan, weeks?, restore_backup? }` | provisions; `{ server, url, charged }` (`charged` is the credits spent, 0 with Pro). `plus` is free for a Pro owner (no `weeks` or `CURRENCY_PAY` needed); otherwise `weeks` 1-52 (default 1) is charged up front (`400 insufficient_balance { cost, balance }`). One free Starter per account (`403 starter_limit_reached`). Waits up to ~60 s for `GET <url>/.well-known/bonfire`; if the container is slower the server stays `provisioning` and flips to `running` when it answers. The url is added to your instance list. Nookara holds **no session** on the instance: the client signs in there and calls `POST /api/v1/servers { name }` itself. Errors: `invalid_slug`, `slug_reserved`, `slug_taken` 409, `invalid_plan`, `invalid_weeks`, `backup_not_found` 404, `hosting_failed` 502 (nothing is charged or kept) |
| `GET /hosting/servers` | `{ servers: [...], you: { pro: bool, pro_until: <ms> or null } }`; credit-Pro expiry in ms, null for a paying/staff rank or no Pro |
| `GET /hosting/servers/by-url?url=<origin>` | `{ server }` or 404 (owner only) |
| `POST /hosting/servers/:slug/weeks { weeks }` | buy 1-52 more weeks of Plus: `paid_until = max(now, paid_until) + paused_ms + weeks * 7 days`, then clears `paused_ms`. A Pro owner upgrades Starter for free (`weeks` ignored, no `CURRENCY_PAY`, `{ server, cost: 0 }`); already-Plus returns `409 { error: "pro_covers" }`. Otherwise `{ server, cost }`. Works while active, overdue or read-only (read-only is switched off at once) and on a Starter server (= upgrade). `400 insufficient_balance { cost, balance }` |
| `PATCH /hosting/servers/:slug { plan: "starter" }` | switch to free Starter now, no refund (`403 starter_limit_reached` when the account has no free slot; `plan: "plus"` is `400 use_weeks`) |
| `POST /hosting/servers/:slug/restart` | restart the container |
| `POST /hosting/servers/:slug/backup` | take a backup now (reason `manual`) -> `{ backup }` |
| `DELETE /hosting/servers/:slug { confirm: slug }` | backs up first (reason `deleted`), then removes the container and its data; `{ ok, backup, reserved_until }`. The name stays the owner's for 30 days |
| `POST /hosting/backups/upload` | bearer + `CHAT`; multipart `file` (max 500 MB), `name` (1-80 characters), `url` (instance origin), optional `slug` (normal hosting slug syntax); `{ backup }`. Streamed to disk; validates ZIP directory and `bonfire-export-v1` manifest. No hostd required. Errors: `no_file`, `invalid_name`, `invalid_slug`, `invalid_instance`, `invalid_multipart`, `invalid_export` (400), `file_too_large` (413, `max_mb: 500`) |
| `GET /hosting/backups` | `{ backups: [ { id, slug, name, size, created_at, reason: "archived" or "manual" or "deleted" or "uploaded", url: <origin> or null, source: "hosted" or "uploaded" } ] }` |
| `GET /hosting/backups/:id/download` | the `bonfire-export-v1` zip (owner only) |
| `DELETE /hosting/backups/:id` | |

Staff (rank `admin` or `owner`): `GET /hosting/admin/servers` (every server + `owner`, `owner_user_id`), `PATCH /hosting/admin/servers/:slug { plan?, status?: "suspended" | "running", paid_until? }` (no charge; `paid_until: null` on Plus = never expires), `GET /hosting/admin/servers/:slug/logs?tail=` -> `{ logs }`, `GET|PATCH /hosting/admin/settings` (`{ plans, starter_limit_per_account }`; a plan patch is `{ plans: { plus: { price_credits, limits: {…} } } }`, `null` resets one). Transactions are recorded like Pro's: `from_user_id` = the payer, `to_user_id` NULL, positive amount, type `bonfire_hosting`, note `"<n>w Ember Plus: <slug>"`.

### 19.6 Backups and restores

Every plan can call `POST /hosting/servers/:slug/backup` (Starter included). Account backup records include `url` (origin or null) and `source: "hosted" | "uploaded"`. Clients can save an instance backup to their Nookara account by downloading it with an **instance session**, then uploading the file to `POST NOOKARA/bonfire/hosting/backups/upload` with their **Nookara bearer + CHAT**, multipart fields `file`, `name`, `url`, optional `slug`. The 500 MB limit applies only to this multipart route; the file streams to disk and archive validation reads bounded directory/manifest data. Saved records use `reason: "uploaded"`, count toward the shared 10-per-account/180-day retention, and can be listed/downloaded/deleted without hostd. For older hosted records `url` uses the configured hosting origin when available. No tokens are exchanged between services.

To restore a saved account backup into an existing instance: download `GET NOOKARA/bonfire/hosting/backups/:id/download` with the Nookara bearer, then send that ZIP as multipart `file` to `POST INSTANCE/api/v1/instance/restore` with the owner's instance session (section 5b). To create a new hosted server from either an uploaded or hosted backup, use the existing `restore_backup` field below.

A backup is a normal `bonfire-export-v1` zip (§9: settings, channels, roles, emojis, members, messages, files). Nookara keeps them under `BONFIRE_BACKUP_DIR` (default `/opt/velora-data/bonfire-backups`) in table `bonfire_hosted_backups`: 180 days, at most 10 per account (oldest removed first). The container produces one with `node src/cli.js export <out.zip>` (exit 3 = no community yet, nothing to save; with several servers it writes one file each, `<out>-<slug>.zip`, and prints them as `files`); hostd runs it with `docker exec` and streams the file to Nookara.

**Restore** = `POST /hosting/servers { …, restore_backup: <id> }`: hostd receives the zip, copies it to `/data/import.zip` of the new container and starts it with `EMBER_IMPORT_ON_BOOT=/data/import.zip`. On a boot where the instance has **no community yet**, it imports the zip as the owner (`EMBER_OWNER`) and deletes the file. Members who sign in again get their roles back.

### 19.7 bonfire-hostd (Nookara -> Docker host)

`Authorization: Bearer <HOSTD_SECRET>` on `HOSTD_API_PORT` (8090): `POST /instances { slug, owner_principal, plan, limits, nookara_url, public_url, env?, restore? }`, `GET /instances`, `GET /instances/:slug`, `PATCH /instances/:slug { plan?, limits?, read_only?, env? }` (recreates the container, same data), `POST /instances/:slug/{start,stop,restart}`, `DELETE /instances/:slug[?purge=1]`, `GET /instances/:slug/logs?tail=`, `POST /instances/:slug/backup` (the zip, or `204`), `PUT /imports/:slug` (the zip for a restore). The API can bind a LAN address via `HOSTD_API_HOST`; bearer secrets use constant-time digest comparison. Optional `HOSTD_API_ALLOW` is a comma-separated socket-IP allow-list (empty allows all; `::ffff:` normalized; forwarded headers ignored); firewall 8090 to Nookara only. A reverse proxy on `HOSTD_PROXY_PORT` (8080) routes `HOSTD_HOST_TEMPLATE` (production `{slug}-bonfire.ikelene.net`, same syntax as Nookara; fallback `{slug}.<HOSTD_DOMAIN>`) to the container, WebSockets included (`unknown_instance` 404 with a tiny JSON body and `Cache-Control: no-store`, no instance list; `instance_stopped` 503). Nookara supplies `public_url`, hostd checks its hostname against the template and passes it as container `EMBER_PUBLIC_URL`. Cloudflare Tunnel uses `*` on `ikelene.net` -> `http://<hostd LXC>:8080` as the LAST rule, after explicit services; DNS `CNAME * -> <tunnel>.cfargotunnel.com`, proxied. Set `HOSTD_PROXY_HOST=0.0.0.0` for tunnel access. See `bonfire-hostd/README.md`.

### 19.8 When paid time runs out

**Nookara Pro covers Plus for free.** Pro means a stored paying/staff rank with tier >= 2 (`pro`, legacy `plus`, `admin`, `mod`, `owner`), or any set `credit_tier` with a future `credit_tier_expires_at`. Public `GET /hosting/plans` adds `free_with_pro: true` on Plus.

On Pro start, every live Plus row becomes `billing: "pro"`, `pro_covered: true`: remaining paid time is banked in `paused_ms` (a number, initially 0); `paid_until`, `read_only_at`, and `archive_at` are null. An overdue/read-only server becomes writable again; staff suspension is preserved. The owner is notified that its remaining days are saved. On Pro end, `paid_until = now + paused_ms`, `paused_ms = 0`, and billing resumes as `active` before the normal expiry flow below. No saved time means overdue immediately; the owner is notified that Plus weeks are needed. Other servers have `pro_covered: false`.

The hourly sweep joins owners in one query and checks both transitions, including Plus rows without `paid_until`. Credit Pro purchases reconcile immediately after success; owner list and by-url reads also reconcile, writing only out-of-sync Plus rows. Paid rank writes are scattered (Ko-fi and admin), so reads or the hourly sweep detect those. Downgrading to Starter keeps banked time unused; a later Pro upgrade is free, or a paid weeks purchase adds the bank on top. Staff sees `paused_ms`; an explicit admin `paid_until` replaces existing banked time and is banked again if Pro still applies. Deleted/archived rows are not revived.

Without Pro, Plus is prepaid and **never renews automatically**. After `paid_until`:

1. **`overdue`** (2 days): the server keeps working normally.
2. **`read_only`** (the next 7 days): hostd recreates the container with `EMBER_READ_ONLY=1` (§19.3). Buying weeks brings it straight back.
3. **`archived`**: Nookara stores a backup (reason `archived`), hostd stops and removes the container and its data, `status` becomes `deleted`. The name stays the owner's for 30 days; restoring the backup into a new server (§19.6) brings it back.

`read_only_at = paid_until + 2 days`, `archive_at = read_only_at + 7 days` (null for a free server). The owner is notified 2 days before `paid_until`, on overdue, on read-only and on archive. The job runs hourly; a failed backup keeps the server read-only and retries (nothing is removed without a backup). Starter servers never expire.

### 19.9 Maintenance mode (Nookara)

Staff can put Nookara in maintenance: `GET /admin/maintenance` -> `{ on, message, env_forced }`, `PUT /admin/maintenance { on, message? }` (rank `admin` / `owner`). Env `VELORA_MAINTENANCE=1|0` overrides the stored toggle (`env_forced: true`). While on, everyone except those staff gets `503` with `Retry-After: 600`: a page for browser navigations, `{ "error": "maintenance", "message"? }` for API calls (including `POST /bonfire/instance-token`, so instances wait), and WebSockets are closed with `4503` after auth. Always open: `/health`, `/.well-known/bonfire/jwks.json`, `/bonfire/relay/*` (instances keep working), `/login`, `/auth/*` except registration, `/assets/*`. Signed-in staff pass with their bearer token; the maintenance page offers them "Continue as staff" (`POST /admin/maintenance/bypass` sets a 12 hour cookie).

---

## 20. Push

A client that wants notifications while it is not connected registers a **pusher** with each homeserver it uses: the key its push provider gave it, and the **push gateway** that can reach that provider. Nookara runs one; its address is `push_gateway` in `https://nookara.cc/.well-known/ember`, and it is this server's default. Discovery (§3) says where pushers go: `push: { pushers_url }`.

**Pushers** (any signed-in account that is not a bot: local, Nookara, or another homeserver's):

| route | result |
|---|---|
| `POST /api/v2/pushers { app_id, pushkey, gateway_url?, device_name?, show_preview? }` | `{ pusher }`. `pushkey`: 1-512 printable ASCII characters. `app_id`: 1-64 of `A-Z a-z 0-9 . _ -`. `gateway_url`: `https`, no credentials, at most 500 characters; left out = the `push.default_gateway` setting (default `https://nookara.cc/_ember/push/v1/notify`). `show_preview` defaults to `true`. The same `pushkey` again updates it; a key another account here had moves to the caller. Errors: `invalid_pushkey`, `invalid_app_id`, `invalid_gateway_url`, `invalid_device_name`, `invalid_show_preview`, `409 too_many_pushers { limit: 20 }` |
| `GET /api/v2/pushers` | `{ pushers: [ { pushkey, app_id, gateway_url, device_name, show_preview, created_at, last_ok_at } ] }`, the caller's own |
| `DELETE /api/v2/pushers/:pushkey` (URL-encoded) | the list again; `404 pusher_not_found`. A client removes its pusher when it signs out |

Table `pushers (user_id, pushkey, app_id, gateway_url, device_name, show_preview, created_at, last_ok_at, PRIMARY KEY (user_id, pushkey))`, at most 20 per account.

**Sending.** Whenever a message pings someone who has no gateway connection here (the rules of §12.3's offline push: a mention, a reply, a role, `@everyone`, or their "all messages" setting; never a muted channel or server, never with `push` switched off for it), each of their pushers gets:
```
POST <gateway_url>
Ember-Signature: keyId="<domain>#<kid>", created=<unix seconds>, sig="<base64url Ed25519>"
X-Ember-Homeserver: <this homeserver's domain>
{ "notification": { "pushkey": "…", "app_id": "…", "kind": "mention" | "reply", "title": "nat mentioned you", "preview": "…", "url": "https://chat.example/#/s/<sid>/<cid>", "homeserver": "chat.example", "counts": { "unread": 3 } } }
-> { "rejected": ["<pushkey>", …] }
```
- The request is signed like a server-to-server request (§4c.1): the same key (the one the homeserver's JWKS publishes), over the same five lines (`POST`, the gateway URL's path and query, the gateway's host, `created`, the body's `sha-256`) and a sixth, `purpose: push`. The gateway is an address a client chose, so the extra line keeps it from passing the signature off as an s2s request: an s2s receiver checks five lines and never accepts it. A gateway finds the key the way an s2s receiver does and answers `401` (`invalid_signature_header`, `homeserver_mismatch`, `signature_expired`, `unknown_kid`, `invalid_signature`) to a request that is unsigned or does not check out, `403 homeserver_mismatch` when `notification.homeserver` is not the domain that signed, and `502 homeserver_unreachable` when the homeserver's keys cannot be fetched. Nookara's gateway requires it.
- `title` is at most 100 characters, `preview` at most 300 and only sent to a pusher with `show_preview: true`. `url` is only sent when `public_url` is `https`. `counts.unread` is the number of channels the person has something unread in.
- For a DM message `preview` is always `sent a message` (with the sender's name in front in a summary): DMs are sealed (§4d) and no homeserver can say more.
- `kind` is `mention`, `reply` or `dm`; `call` and `other` are the gateway's other kinds and are not sent yet. `dm` (§4c.4) is every message in a DM, to each member who is not connected: by the host to its own accounts, and by a member's own homeserver when the host reports activity (`dm_activity`). Its `title` is the sender's name (`"nat"`, `"nat in <group>"`, or `"3 new messages from nat"` / `"... in <group>"` for the summary), its `url` is `<public_url>/#/dm/<dm id>`, and `counts.unread` also counts DMs hosted elsewhere that have something unread.
- Quiet the way §12.3 is: nobody who is connected is pushed, and per person and channel the first ping goes out at once while the ones in the next 30 seconds become one summary (`"3 new mentions in #general"`).
- A pushkey the gateway lists in `rejected` is deleted. Any other 2xx sets `last_ok_at`. A `429` or `5xx` is tried again after 1, 4 and 15 seconds (signed anew each time); any other answer stands, and a non-2xx answer is written to the log (one line a minute per gateway).
- One request per pusher, in order per gateway, 5 seconds each at most, off the message path: a slow or dead gateway never delays a message (more than 500 waiting for one gateway are dropped). Requests only go to public addresses and follow no redirects (the rule of §4a's outside logins; `EMBER_DEV=1` lifts it).
- This is separate from §12.3 (`relay/notify`, Nookara accounts on a registered instance): both are sent, and a client that has a pusher here should switch the relay push off for this instance on Nookara, or it is told twice.
