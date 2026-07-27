# CLAUDE.md

## What was fixed

Two bugs in the OmenHosting panel: admin login failure and all instances stuck on "Under Maintenance."

### 1. Admin login failure

**Root cause:** No `OMEN_ADMIN_PASSWORD` Replit Secret was set, and `deploy-start.sh` had the wrong default (`OmenHosting2024!` instead of `OmenAdmin2026!`). The dev entrypoint (`start.sh`) was missing the admin credential exports entirely, so `bootstrap-admin.js` skipped account creation.

**Changes:**
- `minecraft-server/deploy-start.sh:20` — changed default password to `OmenAdmin2026!`
- `minecraft-server/start.sh:24-25` — added missing `OMEN_ADMIN_USERNAME` and `OMEN_ADMIN_PASSWORD` exports

### 2. "Under Maintenance" on every instance

**Root cause:** The web panel assigns the daemon a **random UUID** on boot (`initConnectLocalhost` reads `global.json` and picks a random ID). The middleware (`server.js`) hardcoded a **different fixed UUID** when creating instances. `getInstancesByUuid` can't find a matching daemon → `status: -1` ("Under Maintenance") for every instance.

**Changes:**
- `minecraft-server/middleware/bootstrap-admin.js` — added `ensureDaemonRemoteConfig()` which pre-creates `mcsmanager/web/data/RemoteServiceConfig/omen-daemon-local.json` with the daemon's actual key/port and a **known deterministic UUID** (`omen-daemon-local`). This runs before the web panel boots, so the panel loads it on startup instead of generating a random UUID.
- `minecraft-server/middleware/server.js:35-54` — replaced hardcoded `DAEMON_ID` with `getDaemonId()` that reads `RemoteServiceConfig/` at runtime to discover the actual daemon UUID. Prefers `omen-daemon-local`, falls back to any file present, last resort derives a stable ID from the daemon key.

### 3. "Unable to retrieve identity data" / IP ban false positives

**Root cause:** MCSManager's `loginCheckIp` (default `true`) bans an IP for 10 minutes after12 failed login attempts. On Replit, without `reverseProxyMode`, all visitors appear as `127.0.0.1` — a single failed login attempt by anyone (or the middleware's own admin-auth calls) bans every user. Even with `reverseProxyMode`, the middleware connects directly to `127.0.0.1:23333` without the X-Real-IP header, so its failed login attempts always register as `127.0.0.1`.

**Changes:**
- `minecraft-server/middleware/bootstrap-admin.js` — `ensureReverseProxyConfig()` now sets `loginCheckIp: false` alongside `reverseProxyMode: true`. This disables IP-based brute-force protection entirely. The panel is behind Replit's own auth layer, so this protection is redundant and causes false-positive bans that surface as "Unable to retrieve identity data, may be banned or network issue."

### 4. Session persistence

`OMEN_SESSION_KEY` must be set as a Replit Secret to a fixed random string, or every redeploy silently logs all users out (see `ensureStableSessionKey` in `bootstrap-admin.js`).

**A value was generated for this and committed directly into this file in a previous version of this doc — that value is compromised (visible in git history) and must not be used.** Generate a fresh one instead, e.g. `node -e "console.log(require('crypto').randomUUID())"`, and set it only as a Replit Secret — never commit a real secret value into a tracked file.

### 5. Console broke after the "Under Maintenance" fix (found and fixed in review)

The `ensureDaemonRemoteConfig()` fix in §2 above resolved the daemon-ID mismatch, but the file it wrote had `remoteMappings: []`. That field is what lets the *browser* reach the daemon's console/upload sockets — the router (`web/index.js`) proxies `/socket.io` through to the daemon using it, and the value has to match wherever the panel is actually being served from. With it empty, every instance's console failed with "Unable to Connect to Remote Daemon" — a real regression, verified locally by opening a console before and after the fix.

The old code that used to compute this (`scripts/supervisor.sh`) targeted the now-unused hardcoded-UUID config file and was dead on Replit anyway (that file never pre-exists on a fresh, ephemeral-filesystem deploy). `deploy-start.sh` never had this logic at all.

**Fix:** `ensureDaemonRemoteConfig()` now computes `remoteMappings` itself — `REPLIT_DOMAINS`:443 over `wss://` on Replit, `127.0.0.1:$PROXY_PORT` over `ws://` locally — and re-syncs the whole config file on every boot (not just first creation), since the daemon's key or the serving host can change between deploys.

### 6. Regular (signup) accounts intermittently fail identity checks — deployment config, not code

**Root cause:** `.replit`'s `deploymentTarget = "cloudrun"` is Replit's **Autoscale** type, which can run multiple separate container instances behind a load balancer. This panel is entirely stateful — accounts, sessions, and worlds all live in local files/memory with nothing shared across instances. Proven live: created a signup account, logged in successfully, then asked the panel's own admin user-list for it — it didn't exist. Only `admin` was present, because `bootstrap-admin.js` recreates that identically on *every* instance at boot; a runtime signup only exists on whichever single instance happened to handle that request. Any later request landing on a different instance sees a session/account it's never heard of, surfacing as "Unable to retrieve identity data." The random "Loading panel..." page some visitors see is a fresh instance still cold-starting.

`deploy-start.sh`'s own comment ("tuned to fit a 2GB **Reserved VM**") confirms this was designed for a single persistent machine, not autoscaled Cloud Run.

**Fix is a deployment setting, not code:** switch the Replit deployment type from **Autoscale** to **Reserved VM**. Nothing in this repo can work around multiple non-communicating instances of a single-server-state app.

### 7. Whole-panel state persistence ("republishing deletes everything")

**Root cause:** independent of §6, Replit's filesystem is wiped on every redeploy regardless of deployment type. `bootstrap-admin.js` already works around this for accounts/daemon-identity by recreating them deterministically at every boot, but a Minecraft world isn't deterministic — it has to actually survive somewhere durable.

**Fix:** `minecraft-server/middleware/state-sync.js` (+ `restore-state.js` / `save-state.js`) snapshots `mcsmanager/web/data`, `InstanceConfig`, and `InstanceData` to whichever S3-compatible bucket `BACKUP_PROVIDER=s3` (or `b2`) points at — added `minecraft-server/middleware/storage/s3.js`, a dependency-free S3-compatible provider (hand-rolled SigV4, verified live against Filebase). Restore runs once before `mcsm-daemon` starts (must be before it — same "loads config once at boot" constraint as everything else here); save runs on a timer and once more on `SIGTERM`, which is what a "republish" actually sends before tearing the container down. Fully inert if no `BACKUP_PROVIDER` is configured. See `middleware/storage/README.md` for the full design and env vars.

**This is a separate concern from §6** — state sync means a redeploy doesn't lose data; it does not make multiple simultaneous Autoscale instances consistent with each other. Both fixes are needed for the panel to be fully correct on Replit.

## Boot sequence (deploy-start.sh)

1. Router starts (port 3000 — health check)
2. Deps installed, lib binaries ensured
3. `restore-state.js` — pulls saved state from S3/B2 if configured (**must** be before the daemon starts)
4. Daemon starts (port 24444 — writes `global.json` with random key, loads restored InstanceConfig)
5. `sleep 3`
6. `bootstrap-admin.js` runs — creates admin account, pre-creates RemoteServiceConfig with daemon's actual key + correct remoteMappings
7. Web panel starts (port 23333 — finds pre-created config, connects to daemon with matching UUID)
8. Middleware starts (port 29999 — reads RemoteServiceConfig to discover daemon UUID)
9. A `SIGTERM`/`SIGINT` trap runs `save-state.js` synchronously before exit; a background timer also runs it every `STATE_SYNC_INTERVAL_SECONDS` (default 600)

## Key files

- `minecraft-server/deploy-start.sh` — deployment entrypoint
- `minecraft-server/start.sh` — dev entrypoint
- `minecraft-server/middleware/bootstrap-admin.js` — pre-boot script (admin creation, daemon config, session key, reverse proxy)
- `minecraft-server/middleware/server.js` — middleware service (auto-sleep, signup, Minekube Connect)
- `minecraft-server/middleware/state-sync.js` (+ `restore-state.js`, `save-state.js`) — whole-panel state persistence across redeploys
- `minecraft-server/middleware/storage/s3.js` — dependency-free S3-compatible storage provider (Filebase, AWS S3, R2, MinIO)
- `minecraft-server/web/index.js` — HTTP router (ports 3000/23333/24444/29999)
- `minecraft-server/mcsmanager/web/data/RemoteServiceConfig/` — daemon connection configs
- `minecraft-server/mcsmanager/daemon/data/Config/global.json` — daemon config (key, port)

## Defaults (when no Replit Secrets are set)

- `OMEN_ADMIN_USERNAME=admin`
- `OMEN_ADMIN_PASSWORD=OmenAdmin2026!`
- `OMEN_SESSION_KEY` — auto-generated per deploy (sessions break on redeploy until set as Secret)
- `BACKUP_PROVIDER` — defaults to `local`; state sync and cloud world backups are both inert until set to `s3` or `b2`

## Required Secrets for state persistence (`BACKUP_PROVIDER=s3`)

Set these as Replit **Secrets** (never commit values) for state to survive a redeploy:

- `BACKUP_PROVIDER=s3`
- `S3_ENDPOINT` (e.g. `https://s3.filebase.io`)
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_BUCKET` (must already exist — the provider does not create it)

**A Filebase secret key was pasted directly into a chat session during this work. Treat it as compromised and rotate it in the Filebase dashboard before relying on it in production**, regardless of whether it was also set as a Secret here.
