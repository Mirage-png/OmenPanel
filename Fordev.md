# OmenHosting — For Dev

Read this before touching anything. It tells you what this panel is, what's
ours vs. upstream, and how to run it.

- Repo: `https://github.com/jasontchen0325-wq/HostingPanel.git`
  (same codebase also lives at `OmenPanel` and `OmenPanel2`)
- Base: **MCSManager** (open source Minecraft hosting panel), skinned and
  extended with a custom middleware layer. We do **not** fork MCSManager's
  frontend — we reverse-proxy it and inject our theme/JS into its HTML.
- There was an earlier attempt to build a panel completely from scratch. That
  is abandoned. This MCSManager-based panel is the one going forward.

---

## 1. What this actually is

A Minecraft server hosting control panel. A user logs in, sees "My
Application" (their instance list + stat cards), and can spin up a Minecraft
server with one button. Behind that button: MCSManager creates and manages
the actual server process (start/stop/console/files), and our middleware adds
everything MCSManager doesn't do out of the box — signup, queueing when
capacity is full, cloud backups, mod/plugin installs, auto-sleep, resource
stats, and the whole visual skin.

## 2. Architecture — four Node processes behind one router

| Service | Port | Directory | Role |
|---|---|---|---|
| **router** | 3000 | `minecraft-server/web/index.js` | The only public port. Reverse-proxies the other three, injects `theme.css`/`inject.js` into HTML responses. |
| **mcsm-daemon** | 24444 | `minecraft-server/mcsmanager/daemon` | Upstream MCSManager daemon — actually runs the Minecraft JVM processes. |
| **mcsm-web** | 23333 | `minecraft-server/mcsmanager/web` | Upstream MCSManager panel (Vue SPA + Koa API). |
| **middleware** | 29999 | `minecraft-server/middleware/server.js` | Everything custom: `/api/omen/*` routes. |

Routing in `getBackend()` (`web/index.js`): `/socket.io`, `/upload-*`,
`/download/` → daemon · `/api/omen/*` → middleware · everything else → the
MCSManager web panel.

## 3. What's ours (this is the part to actually read the code for)

MCSManager itself is vendored upstream code — don't hand-patch it. Everything
below is what makes this OmenHosting instead of stock MCSManager:

```
minecraft-server/middleware/
  server.js            routes, auto-sleep, queue, signup, instance creation,
                       Minekube address detection, whoami/create-server APIs
  bootstrap-admin.js   pre-boot: pins the session key, enables reverse-proxy
                       mode, creates/reconciles the admin account
  spawn-detached.js    launches a child process fully detached into its own
                       session (Node's native `detached: true`, no external
                       `setsid` dependency) so services survive the
                       launching shell exiting
  install-libs.js      downloads MCSManager's native binaries for the
                       current OS/arch (pty, file_zip, 7z) at boot
  stats.js             per-instance CPU / RAM / disk from the OS
  public/theme.css     the green-on-dark skin, injected into the panel
  public/inject.js     injected UI: resource panel, server-address box,
                       queue modal, backup box, mod browser, signup link,
                       and the "+ Create Server" button + modal embedded
                       directly in the My Application dashboard
  backup/              archive.js (zip + real CRC-32 verification),
                       manager.js (retention, shrink guard), history.js
  storage/             b2.js (Backblaze B2 native API), local.js,
                       index.js (provider factory), provider.js
  mods/modrinth.js     plugin/mod search + install, host-restricted
  test/run-tests.js    regression suite (npm test / npm run test:live)
```

The theme/UI injection is deliberate: `web/index.js` rewrites the HTML that
comes back from `mcsm-web` to add our CSS/JS, so MCSManager can be upgraded
in place without redoing the skin.

**There is no standalone `/create` page anymore.** Server creation lives
entirely inside the "My Application" dashboard (`#/customer`) — a
"+ Create Server" button injected into the Instance List panel header, which
opens a modal that calls `/api/omen/whoami` then `/api/omen/create-server`.

## 4. Boot sequence — order is load-bearing

From `minecraft-server/start.sh` (dev) / `deploy-start.sh` (prod) /
`scripts/supervisor.sh`:

1. **router** first — no external deps, opens the health-checked port immediately
2. `install-libs.js` — platform-specific binaries
3. **mcsm-daemon**
4. `bootstrap-admin.js` — **must run before mcsm-web starts.** MCSManager
   loads its user list into memory once at boot and never re-reads it; an
   account created afterward is invisible until the next restart.
5. **mcsm-web**
6. **middleware**
7. Monitor loop: restart dead services, max 5 per 10 min, with backoff.

Every service is launched via `spawn-detached.js`, which spawns it fully
detached (its own session, reparented to init on exit of the launcher). This
is what makes services survive the launching shell dying — there used to be a
real bug here (see §7) where everything died with `SIGTERM` seconds after
start because nothing detached the child processes; it's fixed now.

## 5. Configuration

| Variable | Required | Purpose |
|---|---|---|
| `OMEN_SESSION_KEY` | **yes** | Fixed random string. Without it, every restart logs all users out — the session cookie name *and* signing key both derive from this. |
| `OMEN_ADMIN_USERNAME` | no | Defaults to `admin`. |
| `OMEN_ADMIN_PASSWORD` | **yes** | Admin password; no default. |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET` | recommended | Backblaze B2 backups. Without these, backups fall back to local disk. |
| `BACKUP_PROVIDER` | no | `local` or `b2` |
| `PROXY_PORT` | no | Router port, default 3000 |
| `OMEN_TRUSTED_PROXY_HOPS` | no | Number of trusted proxy hops in front of the router — determines which `X-Forwarded-For` entry is trusted as the real client IP |

## 6. Running it locally

```bash
cd minecraft-server
for d in . mcsmanager/daemon mcsmanager/web middleware; do (cd $d && npm ci --omit=dev); done
node middleware/install-libs.js

OMEN_SESSION_KEY=local-dev-fixed-key \
OMEN_ADMIN_USERNAME=admin \
OMEN_ADMIN_PASSWORD=OmenLocal12345 \
PROXY_PORT=3000 \
bash start.sh
```

Open `http://127.0.0.1:3000/`. Confirmed working end to end: login, the "My
Application" dashboard with stat cards + Instance List, the "+ Create Server"
button/modal actually creating a server, and it showing up in the list.

**If you change the serving host** (new machine, tunnel, deployment domain),
update `mcsmanager/web/data/RemoteServiceConfig/*.json` → `remoteMappings` to
point at the new browser-facing origin, or the console will show "Unable to
Connect to Remote Daemon". See §8.

## 7. Bugs already fixed — don't rediscover these

| Bug | Fix |
|---|---|
| Services died with `SIGTERM` seconds after boot when the launching shell exited (no `setsid` on macOS, or in Replit's Nix container) | `spawn-detached.js` — Node's native `detached: true` spawn, portable, no external binary needed |
| Root `package-lock.json` drifted → `npm ci` failed → fallback pulled a CVE-flagged `tar` version | Regenerated lockfile; pinned a safe `tar` version |
| Dependency installs at boot blew the platform's health-check window | Moved to a build step; router starts first regardless |
| Per-service logs invisible to the hosting platform | `tail -F` streamed into main stdout with `[service]` prefixes |
| Platform-specific binaries were committed, wrong arch on Linux | `install-libs.js` downloads the right ones per-platform at boot |
| Fresh deploy had no admin account → signup returned "Admin authentication failed" | `bootstrap-admin.js` creates it pre-boot |
| `reverseProxyMode: false` → every visitor resolved to `127.0.0.1` → failed logins banned **everyone** | Bootstrap enables it; router sets `X-Real-IP` |
| Ban was *still* global — router trusted the rightmost `X-Forwarded-For`, which is the platform's shared, rotating load balancer | Count back `OMEN_TRUSTED_PROXY_HOPS` from the end instead — the only position a client can't forge |
| **Every deploy logged all users out** — session key regenerated whenever `data/.session-key` was missing (gitignored) | Pinned from `OMEN_SESSION_KEY` before boot |
| Hardcoded admin password in source | Env vars only |
| Queue: 5 separate bugs (race condition, slot leak on failed upload, wrong daemon event field, bare-string rejections, `.query` used on a `URL` object) | All fixed — regression-tested |
| Backups: zip validation checked size but not CRC, so corrupt-but-same-length archives passed | Real CRC-32 verification |
| B2 uploads failed/weren't retried on slow links | Widened connection timeout; retry wraps the streaming body |
| Server creation was only reachable via a standalone `/create` page | Moved into the My Application dashboard as a button + modal |

## 8. MCSManager behaviors that will waste your time

- **API routes require `x-requested-with: xmlhttprequest`.** Without it they
  404 like a missing route, not a 401 — misleading if you're testing with
  plain `curl`.
- **Session key = cookie name AND signing key**, from `data/.session-key`.
  Pinned via `OMEN_SESSION_KEY` so it survives restarts/redeploys.
- **IP ban is in-memory**, resets on `mcsm-web` restart. >10 failed logins
  from one (trusted-hop-resolved) IP bans it for 10 minutes.
- **Users load once at boot.** Writing a user file while running does
  nothing until the next restart — this is why `bootstrap-admin.js` must run
  before `mcsm-web` starts, not after.
- **`app.js` is a webpack bundle.** Don't hand-patch it; change behavior
  through config or the middleware layer instead.
- **The browser talks to the daemon over WebSocket** via
  `mcsmanager/web/data/RemoteServiceConfig/*.json` → `remoteMappings`. This
  must point at whatever origin the browser is actually loading the panel
  from, or the console shows "Unable to Connect to Remote Daemon".
- **BSD vs GNU `du`:** the daemon shells out to `du -s --block-size=1M`,
  which fails on macOS. Harmless — only affects instance disk-size reporting.

## 9. Remaining work

1. Set B2 secrets in whatever environment this deploys to — backups
   currently fall back to local disk without them.
2. Exercise auto-sleep and the queue's automatic promotion under real load —
   both are implemented and unit-tested but not yet watched happen live
   against a full queue.
3. Migrated instance configs from other hosts can reference host-specific
   paths (e.g. a Replit path like `/home/runner/...`) that don't exist
   locally — this is expected when moving instance data across machines, not
   a bug to fix in code. Create fresh instances for clean local testing.

## 10. Rules of engagement

1. **Measure, don't guess.** The IP-ban bug was "fixed" twice from plausible
   reasoning about proxy behavior and was wrong both times. A diagnostic
   endpoint settled it in ten minutes.
2. **Never commit secrets** — env vars only.
3. **Never commit `data/` directories** — real accounts, access keys, worlds.
4. **Never commit platform-specific binaries** — download them at boot.
5. **Verify on fresh state.** Most bugs here slipped through because they
   worked on a machine that already had good local data.
6. **A green test suite is not evidence a button works.** Most user-visible
   breakage in this project was UI wired to endpoints that didn't exist —
   click through the actual browser before calling something done.
