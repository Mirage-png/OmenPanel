# OmenHosting — Engineering Handoff

Everything needed to work on this project without rediscovering it. Read this
fully before changing anything.

Live deployment: `https://omen-panel--bussinessprivat.replit.app/`
Repo: `https://github.com/jasontchen0325-wq/OmenPanel`

---

## 1. What this is

A customized Minecraft hosting panel built on **MCSManager** (open source),
with a custom middleware layer adding a themed UI, cloud backups, a mod
installer, resource stats, a start queue, and auto-sleep.

It is **stateful**: real Minecraft worlds, user accounts, and instance configs
live on local disk. It is not a stateless web app and must not be treated as one.

---

## 2. Architecture — four Node processes

| Service | Port | Directory | Role |
|---|---|---|---|
| **router** | 3000 | `minecraft-server/web/index.js` | Public entry point. Reverse-proxies to the other three. Zero external deps (Node core only). |
| **mcsm-daemon** | 24444 | `minecraft-server/mcsmanager/daemon` | MCSManager daemon. Runs the actual Minecraft server processes. |
| **mcsm-web** | 23333 | `minecraft-server/mcsmanager/web` | MCSManager control panel (Vue frontend + Koa API). |
| **middleware** | 29999 | `minecraft-server/middleware/server.js` | Custom OmenHosting layer. All `/api/omen/*` routes + UI injection. |

Only port **3000** is public (mapped to `externalPort 80` in `.replit`).
Everything else is internal.

### Request routing (`web/index.js` → `getBackend()`)
- `/socket.io`, `/upload-*`, `/download/` → **daemon**
- `/api/omen/*`, `/create` → **middleware**
- everything else → **web panel**

The router also injects `theme.css` + `inject.js` into HTML responses to skin
the panel without forking MCSManager's frontend.

---

## 3. Boot sequence — the order is load-bearing

From `deploy-start.sh` (production) and `start.sh` (dev "Run" button):

1. Start **router** first — it has no external dependencies, so it opens port
   3000 within milliseconds and the platform health check passes immediately
   instead of timing out while npm installs.
2. `npm ci` fallback for any missing `node_modules` (normally already done by
   the `[deployment].build` step in `.replit`).
3. `middleware/install-libs.js` — downloads MCSManager's platform-specific
   native binaries (pty, file_zip, 7z) for the **current** OS/arch.
4. Start **mcsm-daemon**.
5. `middleware/bootstrap-admin.js` — **must run before mcsm-web starts.**
   MCSManager loads its user list into memory once at boot and never re-reads
   the directory, so an account created after that point stays invisible until
   the next restart.
6. Start **mcsm-web**.
7. Start **middleware**.
8. Enter a monitor loop: restart any dead service, max 5 restarts per 10 min
   per service, with backoff. Rotates logs over 10MB.

All four services' log files are streamed into the main process's stdout with
`[service-name]` prefixes, because the platform's Logs panel only captures the
top-level process's output — it cannot see files written inside the container.
**This is the only way to see real crash output. Use it.**

---

## 4. Configuration

Set in the platform's **Secrets** pane (never in source, never committed):

| Variable | Purpose |
|---|---|
| `OMEN_ADMIN_USERNAME` | Panel admin username (defaults to `admin`) |
| `OMEN_ADMIN_PASSWORD` | Panel admin password. **No default** — bootstrap skips without it. |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_BUCKET_ID` | Backblaze B2 cloud backups |
| `BACKUP_PROVIDER` | `local` or `b2` |
| `BACKUP_COMPRESSION_LEVEL`, `BACKUP_STORE_PRECOMPRESSED`, `BACKUP_REMOTE_ROOT`, `BACKUP_LOCAL_PATH` | Backup tuning |
| `OMEN_DAEMON_HEAP_MB` / `OMEN_WEB_HEAP_MB` / `OMEN_MIDDLEWARE_HEAP_MB` / `OMEN_ROUTER_HEAP_MB` | Per-service V8 heap caps (defaults 512/512/256/128, sized for a 2GB VM) |

---

## 5. THE RECURRING FAILURE PATTERN — read this twice

Nearly every bug in this project has had the same root cause:

> **Local development state that works, is correctly gitignored, and therefore
> never ships to the fresh deploy — where the defaults are broken.**

Confirmed instances of this exact pattern:
- The panel's `data/User/` had accounts locally → fresh deploy had **zero**
  accounts → signup failed with "Admin authentication failed".
- The panel's `data/SystemConfig/config.json` had `reverseProxyMode: true`
  locally → fresh deploy defaulted to `false` → panel-wide IP ban lockout.
- macOS native binaries (`pty_darwin_arm64`) were committed → they cannot run
  on the Linux deploy container.

**Therefore:** when debugging, never trust that something works because it works
locally. `data/` directories are gitignored *on purpose* (they hold real
credentials and user data). Anything required for a fresh deploy to function
must be **generated at boot by a script**, not committed as a data file.

---

## 6. Bugs already fixed — do not redo these

| Bug | Fix |
|---|---|
| `setsid` used to launch every service, but isn't available in this container — background jobs died silently, port 3000 never opened | Removed `setsid` entirely; unnecessary since scripts run as the container's main process |
| Startup scripts hardcoded a path to a bundled Node binary that was never committed | Use the Nix-provisioned `node` on `PATH` |
| Root `package-lock.json` drifted from `package.json` → `npm ci` failed → fallback `npm install` pulled `tar@7.5.14`, blocked by the platform's security firewall as a CVE | Regenerated lockfile; pinned `tar@7.5.22` |
| Build step's last loop iteration returned non-zero (a directory with no `package.json`), failing the whole build despite every install succeeding | Restructured loop + trailing `true` |
| Dependency installs ran at boot, blowing the health-check window | Moved to `[deployment].build`; router starts first regardless |
| No auto-restart in production — a crashed service stayed dead | Monitor loop with crash-loop backoff |
| Per-service logs invisible to the platform Logs panel | `tail -F` streamed into main stdout with prefixes |
| Fresh deploy had no admin account, so signup's admin auth had nothing to log into | `bootstrap-admin.js` creates it pre-boot |
| `reverseProxyMode: false` → every visitor resolved to `127.0.0.1` → 10 failed logins banned the **entire panel** for everyone | Bootstrap enables reverse-proxy mode; router sets `X-Real-IP` |
| macOS binaries committed; wrong arch for the deploy container | `install-libs.js` downloads correct per-platform binaries |
| "Create Server" unreachable — its only entry point was deleted along with a removed banner | Restored a persistent "+ Create Server" link (the `/create` page and API were always intact) |
| Hardcoded admin password in source (3 call sites) | Replaced with `OMEN_ADMIN_USERNAME`/`OMEN_ADMIN_PASSWORD` env vars |

---

## 7. MCSManager behaviors that will bite you

- **API requires `x-requested-with: xmlhttprequest`.** Without it, API routes
  return `404` — which looks like a missing route but is an auth guard. Any
  `curl` test without this header gives misleading results.
- **IP ban:** `loginCheckIp` defaults `true`; >10 failed logins bans that IP for
  10 minutes. The ban is **in-memory**, so restarting `mcsm-web` clears it.
- **Users load once at boot.** Writing a user file while the panel is running
  has no effect until restart.
- **`ctx.ip`** comes from the `X-Real-IP` header only when `reverseProxyMode` is
  on. Both must stay in sync or bans go global again.
- `app.js` is a **webpack bundle** — readable, but don't try to patch it. Change
  behavior via config or the middleware layer instead.

---

## 8. Current status — what is verified vs. not

**Verified working (tested on a clean local deploy, zero prior state):**
- Full boot sequence, all four services up
- Admin bootstrap creates the account; admin login returns HTTP 200
- Login → identity fetch returns the real user object
- Per-IP ban works correctly: exhausting the limit from one IP bans only that
  IP while another visitor logs in successfully at the same moment
- Forged leftmost `X-Forwarded-For` entries are correctly ignored
- Theme/inject assets serve; panel HTML renders

**NOT verified on the live deployment — this is your job:**
- Whether `mcsm-daemon` still crash-loops after the `install-libs.js` fix
- Whether signup works end-to-end on the live site
- Whether the panel stays up over hours, not just seconds

---

## 9. What needs to be done

### A. Verify the live deployment (highest priority)
1. Confirm the deployed commit matches GitHub `main` (`git log -1`). Everything
   below is meaningless against stale code.
2. Redeploy, then read the **runtime** log (after "Starting Build" finishes) for
   at least 60 seconds of uptime. Quote every `[mcsm-daemon]`, `[mcsm-web]`,
   `[bootstrap]`, and `[RESTART]` line.
3. If the daemon still crash-loops, the prefixed log now contains the real stack
   trace. Diagnose from that — do not guess.
4. Confirm `[bootstrap] Created initial admin account` and
   `[bootstrap] Enabled reverse-proxy mode` both appear.
5. Test signup through the actual UI; confirm a new file appears in
   `mcsmanager/web/data/User/`.

### B. Switch deployment type to Reserved VM
Currently `deploymentTarget = "cloudrun"`. This app is stateful and
single-instance by design. Autoscale's scale-to-zero and multi-instance model
will corrupt or lose state regardless of any code fix. **This is a change the
project owner makes in the platform UI**, not in code.

### C. Real gap: admin password rotation does nothing
`bootstrapAdminIfNeeded()` only acts when the user directory is **empty**. If
`OMEN_ADMIN_PASSWORD` is changed later, the existing account keeps the old
password and the new secret silently does nothing — a confusing failure mode.
Add a safe reconciliation path (e.g. update the admin account's hash when the
env password no longer matches), being careful not to clobber non-admin users.

### D. Design issue: the router's "OK" fallback hides outages
When the router can't reach the web panel it returns a plain `OK` with HTTP 200.
This made a total panel outage look like a rendering bug and cost significant
debugging time. Improve it: keep returning 200 to the platform's health check so
deploys don't die during startup, but serve a real "starting up / unavailable"
page to browsers and log loudly when the backend is unreachable.

### E. Housekeeping
- Credentials (a B2 application key, the admin password) were pasted in plain
  text in a chat during development. They are **not** in the repo, but should be
  rotated.
- Regression suite: `npm test` (offline) and `npm run test:live` (requires the
  panel running) from `minecraft-server/`. Run these after changes.

---

## 10. Rules of engagement

1. **Never commit secrets.** Credentials come from env vars only.
2. **Never commit `data/` directories.** They hold real user accounts, access
   keys, and worlds. They are gitignored deliberately.
3. **Never commit platform-specific binaries.** Download them at boot
   (`install-libs.js`).
4. **Diagnose before fixing.** The prefixed runtime logs exist specifically so
   you can read the real error. Quote it, then fix it.
5. **Verify on a fresh state**, not on a machine that already has working local
   data — that is how nearly every bug here slipped through.
