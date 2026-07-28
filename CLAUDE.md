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

### 15. Sidebar redesign, Limbo queue reskin, and per-server subdomains (Play Hosting-style)

Requested per a reference product's screenshots: a persistent left sidebar in place of relying on MCSManager's own per-page function-card grid, a friendlier reskin of the existing single-slot queue system ("Limbo"), and a way to pick the subdomain a server connects on — while keeping the existing green brand accent (`--pt-primary-400`), not switching to the reference's gold.

**Sidebar** (`renderSidebar()` in `inject.js`, `.omen-sidebar*` in `theme.css`): injected as a fixed-position overlay, shown only when an instance is open (a uuid is present in the hash) — admin-wide pages (Instances list, Users, Daemons) keep the panel's normal full-width top nav untouched. Two groups: **Your Server** (Console, Files, Plugins, Backups) and **Config** (Network, Settings). Console/Files/Settings change `location.hash` directly to MCSManager's real routes, confirmed live rather than guessed: `#/instances/terminal`, `#/instances/terminal/files`, `#/instances/terminal/serverConfig`. Plugins/Backups/Network open modals instead (Plugins reuses the existing mod browser; Backups and Network are new). Native MCSManager's own "Instance Settings" modal is admin-only ("Only Admin can view and change these settings", confirmed live) so the sidebar's Settings item deliberately does not try to open it — it points at the server.properties/startup-command editor instead, which is actually usable by a regular owner. Showing the sidebar shifts the panel's own fixed header and content over via a `body.omen-has-sidebar` class; both collapse back to normal below 900px, the same breakpoint where MCSManager's own layout already switches to its mobile fab-menu, so nothing fights that existing responsive behavior.

**Limbo reskin**: the queue system this panel already had (`MAX_RUNNING = 1` — only one server runs at a time, everyone else queues) gets Play Hosting's terminology: "Server in Limbo" / "Wake Server" for the idle state, "In the Limbo Queue" with position + a wait estimate once queued. The estimate (`estimateWaitMinutes()` in `server.js`) is `position × autoSleepMinutes` — there's no tracked history of real session lengths to average, so this is an honest, clearly-approximate number grounded in a real configured value rather than invented precision. A new countdown banner (`renderLimboBanner()`) shows above the console — "Your server is about to enter limbo in Xm Ys" — whenever the running server is empty and counting down toward auto-sleep, with a **Pause now** button (`POST /api/omen/autosleep/pause`) that clears the empty-timer for one more cycle. The existing `/api/omen/autosleep/:uuid` endpoint was extended to report `secondsUntilSleep` (computed from `serverStates[uuid].emptySince` and the configured auto-sleep threshold) alongside the pre-existing `sleeping` flag.

**Network / per-server subdomain**: a new **Network** sidebar item opens a modal to set a custom subdomain, which is wired straight into the same Minekube `endpoint:` config-pinning mechanism from §9 — `minekubeEndpointName(instanceUuid)` now checks a small `omen-data/custom-endpoints.json` map (`{uuid: name}`) first and only falls back to the uuid-derived default when no custom name was saved. Validation (`validateEndpointName()`) enforces the same ≤16-character limit §9 discovered Minekube's WatchService actually needs, plus letters/numbers/hyphens only (not leading/trailing) — checked both client and server side (`POST /api/omen/network/endpoint`). `ensureMinekubeConfig()`'s sync logic was generalized while touching this: it used to only rewrite the config's `endpoint:` line if missing or if it exactly matched the legacy full-uuid bug from §9; now it re-syncs whenever the file's value differs at all from whatever is currently desired, since this function is the only writer of that line and a saved subdomain change needs the same "fix it on next start" treatment the uuid-migration case already got.

Verified live end-to-end: saved a custom subdomain through the Network modal, confirmed it persisted to `custom-endpoints.json`, then hit the existing `/api/omen/install-minekube/:uuid` route (the same one a real server start triggers) and confirmed the plugin's `config.yml` on disk picked up the new name — and that calling it again is a no-op (no unnecessary rewrite). Server-side validation confirmed rejecting a name over 16 characters, one with invalid characters, and one starting/ending with a hyphen, without touching the previously-saved value. Also confirmed the sidebar is invisible on the admin Instances list (no regression to the existing top-nav layout) and reappears correctly navigating into an instance.

**Follow-up — sidebar now fully replaces the native "Manage Instance" grid, and Resource Usage moved beside the console:** per explicit request, the sidebar gained a **Manage Instance** group mirroring every one of MCSManager's own native cards one-for-one (Configuration Files, File Management, Java Manager, Scheduled Tasks, Event Tasks, Terminal Settings, Instance Settings, Minecraft Players Query). Rather than hardcoding a route or modal per card — several of which are Vue-internal modals with no hash route at all, like the admin-only Instance Settings dialog — `clickNativeCard(title)` in `inject.js` finds the real card by its exact title text and clicks its own "Go" link, so each sidebar entry does exactly what the native card already does, automatically staying correct even for entries that aren't simple navigation. A `Modpacks` sidebar entry was also added (calling the existing `openModBrowser('modpack')`) since hiding the native grid below would otherwise have made that feature unreachable — only "Plugin Manager" already had a sidebar equivalent.

The "Basic Infomation" card and the native "Manage Instance" grid are now hidden outright on the console page (both fully superseded by the sidebar), and the "Resource Usage" box moved from below them to a fixed-width column beside the console/terminal itself, reusing the console's own ant-design grid row (`renderResourceUsage()` inserts it as a sibling of the console's grid column rather than the old "Basic Infomation" card). All of this is pure CSS positioning/hiding scoped via `:has(> .omen-resource-box)` — never touching the native columns' own Vue-managed class lists, which would just get overwritten on their next re-render. One real bug found in the same pass: `.omen-resource-grid`'s 3-column layout was keyed to a *viewport* media query (`max-width: 640px`), which did nothing once the box became a permanently-narrow 280px column on any wide screen — CPU/RAM/Storage rendered so cramped they overflowed the box. Fixed by making the grid single-column unconditionally, since this box no longer has a wide layout to support.

Verified live: reloaded the console page and confirmed all 8 Manage Instance sidebar entries work — clicking each opens the same native page/modal as the original card would (Scheduled Tasks navigates, Instance Settings opens its dialog with the real "Only Admin..." notice, etc.) — and confirmed Basic Infomation/the native grid are gone while Resource Usage renders correctly stacked in its own column beside the console.

**Follow-up — sidebar pushed everything to the left on wide screens:** the fix above shifted the panel over via `margin-left: 220px` on `.global-app-container`, which is the panel's own auto-centering element (`margin: 0 auto` against a 1360px max-width on every other page). Overriding just `margin-left` fixed the left side but left `margin-right` as `auto`, which absorbed *all* the remaining space — on anything wider than ~1580px the whole app hugged the sidebar with a large dead zone on the right, exactly matching "everything is to the left." A second, compounding bug: the Vue app's own root mount node (`#app-mount-point`) carries an *inline* `width: 100vw`, which — unlike a percentage — ignores ancestor padding entirely, so it rendered 220px wider than available and threw the body into horizontal overflow. Fixed both at once by shifting via `padding-left: 220px` on `body` instead (leaves `.global-app-container`'s own centering completely untouched — it just centers within a narrower available width) and overriding `#app-mount-point`'s width to `calc(100vw - 220px)` when the sidebar is present. Verified live at 1920px: content now centers with equal ~170px gaps on both sides of the available space, and `document.body.scrollWidth` matches `clientWidth` (no more overflow).

**Follow-up — emoji icons, a real console stat panel, and a Pterodactyl-style server list:** three more asks in the same vein. (1) Every sidebar icon (including all 8 Manage Instance entries) is now a plain emoji character instead of inline SVG — simpler to maintain and matches what was asked for literally. (2) The Resource Usage panel gained an **Uptime** row and renamed CPU/RAM/Disk to **CPU Load/Memory/Disk**, matching the wording of a real console-page reference screenshot the user provided; `stats.js`'s `readProcessUsage()` now also reads `etimes=` (elapsed seconds) in the same `ps` call already used for CPU/RSS, threaded through `getInstanceStats()` and the existing `/api/omen/instance-stats` spread with no route changes needed. Address and Network In/Out from that same reference were deliberately **not** added: Address is already covered by the existing server-address box above the console (adding it again would just duplicate it), and per-process network I/O has no portable, reasonably-scoped way to measure here (real per-process net stats need cgroup net_cls or eBPF, not a `ps` column) — showing a fabricated or permanently-"N/A" number would violate this project's own "no invented precision" standard (see `estimateWaitMinutes` in §15 above). (3) The admin Instances list was converted from a card grid into a stacked list of rows after the user supplied a real Pterodactyl server-list screenshot as reference — emoji avatar circle, name, then the existing status tag/Instance Type/Startup fields as inline right-aligned chips instead of stacked block text. Done entirely in CSS (`:has(.instance-card)` scoping, `::before` for the avatar so no DOM had to be touched) after discovering live that `.instance-card` already had a native `display:flex; flex-direction:column; align-items:center` — the row layout silently no-op'd until `flex-direction`/`align-items`/`justify-content` were overridden explicitly alongside `display`, not just `display` alone. Live CPU/RAM/Disk per row (like the Pterodactyl reference shows) was scoped out: it would mean polling `/api/omen/instance-stats` for every visible instance on an admin-only page, a real feature addition rather than a restyle.

**Note:** the "index.html" initially supplied as a reference for the server list turned out to be Pterodactyl's marketing/docs site, not the actual panel — its screenshots (fetched directly since they were already linked from a file the user provided) turned out to all be single-server admin/console pages from an old panel version, not the multi-server list. The user separately supplied the real list screenshot directly, which is what §15's list conversion above actually matches.

**Follow-up — real emoji rejected, replaced with custom icon chips; a stray native badge removed:** the sidebar/resource-panel emoji from the previous pass were plain Unicode characters, which render as a *different* glyph per platform (Apple's own art on macOS, something else everywhere else) — rejected for exactly that reason. `chip(bg, glyph)` in `inject.js` replaces every one of them with a small self-contained SVG (a solid-color circle plus a simple white glyph), so the look is pixel-identical regardless of OS or installed fonts, with no external asset or font dependency. Separately, the console header was found to be rendering a bare, unlabeled node number next to the instance-type tag (a laptop icon + "2" — MCSManager's internal daemon index) that read as a confusing floating digit; hidden via a narrowly-scoped CSS rule (`.menus-item-left .ant-typography.mb-0.ml-4 > .ml-16`) rather than a DOM removal, consistent with how "Basic Infomation" was hidden earlier — meaningless in a single-daemon deployment like this one.

**Follow-up — the Limbo modal is now a close visual match to a specific reference, including a new "Restoring Server" state:** the user supplied real screenshots of another product's equivalent screens (idle/wake, an in-progress "Restoring Server" transition, and the queued state) and asked for a close match. `showQueueModal()`/`setLimboState()` in `inject.js` were rewritten as a 3-state machine (`idle` → `queued`/`restoring` → gone) sharing one render function (`limboBody()`), styled via new `.omen-limbo-*` classes in `theme.css` that are a deliberate, narrowly-scoped exception to the rest of the panel's dark theme — a light card on a solid black backdrop, matching the reference's layout — but with the panel's own green accent button (`--pt-primary-400`), not that reference's gold; corrected in the very next follow-up below after the reference's gold was initially carried over along with everything else. The "Restoring Server" screen is new: it didn't exist before (a direct-slot start used to just close the modal and drop the user straight into the console), and now polls the console's own status tag for "Running" every 2s (capped at ~80s) before dismissing, so a slow first boot doesn't cut the screen away early. Two things were deliberately **not** copied 1:1: the reference's specific character illustration is proprietary artwork belonging to that other product, so `LIMBO_ILLUSTRATION` is original art in a similar spirit (blob characters, location pins, a moon and orbit ring) rather than a traced copy; and the reference's footer read "© 2026 Timbers Studio Ltd" / "playhosting-panel-1" — that's someone else's real company name, not this panel's, so the footer here says "OmenHosting" instead. The queue screen's "(X/Y)" format needed one small backend addition: `/api/omen/queue/position` and `/api/omen/queue/join` now also return `queueLength` (total people currently waiting) alongside the existing `position`.

**Follow-up — Limbo accent corrected to green, sidebar stays usable behind it:** two fixes to the modal above. First, the gold accent (carried straight over from the reference) was replaced with the panel's own green (`var(--pt-primary-400)`/`--pt-primary-500`) on both the button and the progress bar — the "green, not gold" rule from earlier in this redesign applies here too, it just got missed on the first pass since the whole point of that pass was matching the reference closely. Second, `.omen-limbo-modal`'s backdrop used to be `inset: 0` (the same full-viewport overlay every other modal in this panel uses), which covered the sidebar entirely while a server was in Limbo or restoring — `body.omen-has-sidebar .omen-limbo-modal { left: 220px }` now starts the backdrop after the sidebar instead, so it stays visible and clickable (navigate to Files/Settings/etc.) while the modal is up, resetting to full-width below the same 900px breakpoint the sidebar itself disappears at.

**Follow-up — unified the icon color system:** every custom icon added in this redesign (sidebar, resource-usage panel, the Instances-list avatar) originally used a different hue per item — blue, purple, orange, pink, cyan, red, and more, none of which existed anywhere else in this panel. Called out directly as not fitting the site. `chip()` in `inject.js` now always renders the same tinted-circle-plus-green-glyph combination (`rgba(34,197,94,0.16)` fill, `#4ade80` stroke) that the resource-usage icons themselves originally used *before* this whole redesign started — the same green already used by the sidebar's active-item highlight and every status dot in the app. Icons are now differentiated by their glyph shape alone, not color, which reads as one deliberate system instead of a decoration bolted on top of the existing design.

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
- `minecraft-server/middleware/server.js` — middleware service (auto-sleep/Limbo queue, signup, Minekube Connect, Network subdomain API)
- `minecraft-server/middleware/public/inject.js` (+ `theme.css`) — panel UI: sidebar, Limbo queue/countdown modals, Network/Backups modals, resource stats
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
