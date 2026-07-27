# CLAUDE.md

## What was fixed

Three bugs in the OmenHosting panel: admin login failure, all instances stuck on "Under Maintenance," and "Unable to retrieve identity data" error.

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

**Root cause:** MCSManager's `loginCheckIp` (default `true`) bans an IP for 10 minutes after 12 failed login attempts. On Replit, without `reverseProxyMode`, all visitors appear as `127.0.0.1` — a single failed login attempt by anyone (or the middleware's own admin-auth calls) bans every user. Even with `reverseProxyMode`, the middleware connects directly to `127.0.0.1:23333` without the X-Real-IP header, so its failed login attempts always register as `127.0.0.1`.

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

**Update — confirmed live that this was never actually running on the deployment:** checked the configured Filebase bucket directly and it was completely empty — no save had ever landed there, meaning `BACKUP_PROVIDER`/`S3_*` Secrets were very likely never set (or set without a redeploy afterward). Since a misconfigured or silently-failing state sync was otherwise invisible short of manually listing the bucket, added `GET /api/omen/state-sync/status` (`configured`, `provider`, `lastSaveAt`/`lastSaveError`, `lastRestoreAt`/`lastRestoreError`) — check this after any redeploy that was supposed to persist data. Also shortened `STATE_SYNC_INTERVAL_SECONDS` from 600 to 120: the shutdown-triggered save is not fully trustworthy on its own if Replit's SIGTERM-to-kill grace period is shorter than a large `InstanceData` upload takes, so the periodic save needs to run often enough to have something recent regardless.

### 8. CPU always showed 0.0% — measured live, not guessed

**Root cause:** MCSManager launches every instance through a PTY helper process for terminal support (`pty_darwin_arm64`/`pty_linux_*`), which chdirs into the instance directory and then execs the actual `java` process as its child. Both processes end up with the *identical* cwd. `stats.js`'s `findPidByCwd()` used to return the first cwd match it found, which — verified live by actually starting a real Purpur server and inspecting both PIDs — is the idle PTY wrapper, not the JVM doing the work. The daemon's own internal `pidusage(instance.process.pid)` tracking (used by its live terminal stat display) has the exact same bug, since `instance.process` in the daemon *is* the PTY; an attempt to read CPU/memory through that channel instead (`instance/detail` → `ProcessInfoCommand`) was tried and measured the same wrong process, then reverted.

**Fix:** `findPidByCwd()` now collects *every* pid sharing the instance's cwd and picks the one whose command name matches `java`, falling back to the first match only if none do (`middleware/stats.js`). Verified end to end: started a real server, confirmed the fixed endpoint returns the JVM's actual pid with realistic non-zero CPU/memory, and confirmed it correctly reports offline once the process exits.

### 9. Server address changed on every restart

**Root cause:** the Minekube Connect plugin's own bundled `config.yml` documents an `endpoint:` field — "Default is a random string. You can change it to a custom endpoint name" — but the config OmenHosting generates for it never set that field, so the plugin always fell through to its own random default on every boot.

**Fix:** `installMinekubePlugin()`/`ensureMinekubeConfig()` in `server.js` now writes `endpoint: <instanceUuid>` into the plugin's config, pinning the address to something stable per-instance. Also patches this retroactively into any instance's config that predates the fix and is missing the line — takes effect on that instance's next restart. Also fixed a bug in the same function where this config-patching code was unreachable whenever the plugin jar already existed on disk (the common case for any already-running server) — restructured so config/properties patches always run, independent of whether the jar itself needed downloading.

**Update — the full uuid itself broke the connection (found on the live deployment, reproduced and fixed locally):** Minekube's WatchService rejected the 32-char uuid outright with `invalid endpoint name format` (400), retried forever, and the server never got tunneled at all. Measured live by actually connecting: a 32-char name fails regardless of whether it starts with a letter or digit, a 16-char name (`812f59fe38514cdd`) works, a 10-char name works too. `minekubeEndpointName()` now truncates to the first 16 hex chars — still 64 bits of per-instance uniqueness, comfortably under whatever the real limit is. Also retroactively replaces a full-uuid `endpoint:` value that an earlier version of this fix already wrote into a config (matched exactly against the literal full uuid, so a manually customized endpoint name is never touched) — takes effect on that instance's next restart, same as the original fix.

### 12. New servers always failed their first boot on a missing EULA

**Root cause:** `setupPurpurServer()` only wrote `eula.txt` in its *failure* fallback path (`createMinimalFiles`, called when the Purpur download didn't return 200). On the ordinary, successful path — which is nearly every server creation — `eula.txt` was never created at all, so the first start always hit "You need to agree to the EULA" and stopped; a manual restart was needed before it would actually boot.

**Fix:** renamed to `ensureMinimalFiles()` and made idempotent (skips any file that already exists, so it never clobbers a customized `server.properties`), and it now runs unconditionally at the start of `setupPurpurServer()` — before the download, and even on the fast path where the jar already exists from an earlier session. Verified live: created a fresh server, confirmed `eula.txt` exists immediately after creation, and confirmed the server reaches "Done (8.561s)!" on the very first start with no EULA error.

### 10. Custom server.jar uploads intermittently "corrupt"

**Root cause (likely, not fully provable without reproducing on a slow connection):** the router (`web/index.js`) applied a blanket 10-second *inactivity* socket timeout to every proxied request, including large file uploads/downloads proxied to the daemon (`/upload-new`, `/upload-piece`, `/upload/`, `/download/`). A momentary stall on a slow or mobile connection kills that connection mid-transfer, leaving a truncated file on disk — which then fails to start with the JVM's own "invalid or corrupt jarfile" error, since nothing else in this stack produces a message containing the word "corrupt."

**Fix:** requests proxied to the daemon now get a 10-minute timeout instead of 10 seconds; ordinary API/page requests to the web panel or middleware are unaffected.

### 11. Removed MCSManager's native "Mod & Plugin Manager" card

Redundant with OmenHosting's own injected mod browser and confusing as a second entry point — removed outright per explicit request. `removeModManagerCard()` in `inject.js`.

### 13. Loading screen required manually refreshing to recover

**Root cause:** `LOADING_PAGE` (`web/index.js`, shown whenever the router can't reach the web panel backend — most often a cold-starting Autoscale container) used `<meta http-equiv="refresh" content="2">`: a blind full-page reload every 2 seconds regardless of whether the backend was actually ready yet. Every "refresh" was a real navigation with no idea whether it would succeed, which is why it visibly needed several manual reloads before it "just worked" — it was retrying blind, same as a human mashing refresh, just automatically.

**Fix:** replaced the meta-refresh with a small client-side script that polls a new lightweight endpoint, `GET /_omen/ready` (a fast HEAD request from the router straight to the web panel backend, 2s timeout), and only calls `location.reload()` once that actually confirms the backend is accepting connections. Verified live: killed the web panel process, confirmed the loading page renders and `/_omen/ready` correctly reports `false`, then let it come back up and watched the page reload itself to the real login page with no manual interaction.

**Unresolved:** the user separately described a plain "Hi" appearing behind the loading screen. Checked for this specifically — grepped the entire codebase for the literal string, and directly inspected `document.body.innerText` on the live site — found no trace of it anywhere in this stack's own code. It may be something Cloud Run/Replit itself briefly serves during a cold start that this fix's less-aggressive reload behavior will incidentally reduce exposure to, but if it still appears, it needs a screenshot to diagnose further — nothing in this repository renders that text.

### 14. Resource/memory optimization pass

Three things found and fixed in the same pass:

- **Router and middleware were missing the GC tuning flags** (`--optimize-for-size --gc-interval=100 --max-semi-space-size=32`) that the daemon and web panel already had — they only got `--max-old-space-size`. Applied consistently across all four processes in both `start.sh` and `deploy-start.sh`.
- **`checkAutoSleep()` checked every instance's port sequentially**, each `await`ed one at a time, so N stopped instances serialized their checks on every 30s cycle. Worse: one malformed/corrupt `InstanceConfig` file threw out of the shared `try/catch` and silently skipped every instance queued behind it in the loop for that whole cycle. Fixed by processing instances concurrently via `Promise.all`, each with its own error boundary — measured the actual port-check timing difference directly (small locally, since a closed loopback port refuses near-instantly either way) but the per-instance error isolation is a real correctness fix regardless.
- **`serverStates`, `logPlayerActivity`, and `installedPlugins` never got cleaned up** when an instance was deleted — deletion goes straight through to the web panel/daemon and never touches this middleware, so nothing ever noticed. These now get pruned against the live `InstanceConfig` file list on every auto-sleep cycle (which already reads that list regardless), independent of whether auto-sleep itself is enabled.

**Also reiterating, since it bears directly on "the loading screen still shows up":** none of this changes the underlying Autoscale multi-instance issue from §6. If requests keep landing on different container instances that don't share memory, some of them will always be cold. Reserved VM (a single persistent machine) is still the only fix for that specific symptom — these optimizations reduce this app's own footprint and waste, they don't change how many separate instances Cloud Run decides to run.

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
