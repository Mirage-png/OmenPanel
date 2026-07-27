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

## Boot sequence (deploy-start.sh)

1. Router starts (port 3000 — health check)
2. Daemon starts (port 24444 — writes `global.json` with random key)
3. `sleep 3`
4. `bootstrap-admin.js` runs — creates admin account, pre-creates RemoteServiceConfig with daemon's actual key
5. Web panel starts (port 23333 — finds pre-created config, connects to daemon with matching UUID)
6. Middleware starts (port 29999 — reads RemoteServiceConfig to discover daemon UUID)

## Key files

- `minecraft-server/deploy-start.sh` — deployment entrypoint
- `minecraft-server/start.sh` — dev entrypoint
- `minecraft-server/middleware/bootstrap-admin.js` — pre-boot script (admin creation, daemon config, session key, reverse proxy)
- `minecraft-server/middleware/server.js` — middleware service (auto-sleep, signup, Minekube Connect)
- `minecraft-server/web/index.js` — HTTP router (ports 3000/23333/24444/29999)
- `minecraft-server/mcsmanager/web/data/RemoteServiceConfig/` — daemon connection configs
- `minecraft-server/mcsmanager/daemon/data/Config/global.json` — daemon config (key, port)

## Defaults (when no Replit Secrets are set)

- `OMEN_ADMIN_USERNAME=admin`
- `OMEN_ADMIN_PASSWORD=OmenAdmin2026!`
- `OMEN_SESSION_KEY` — auto-generated per deploy (sessions break on redeploy until set as Secret)
