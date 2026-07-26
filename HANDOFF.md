# OmenHosting (MCSManager) — Engineering Handoff

Everything needed to work on this without rediscovering it.
**Read this fully before changing anything.**

- Repo: `https://github.com/jasontchen0325-wq/OmenPanel2.git` (also pushed to `OmenPanel`)
- Base: **MCSManager** (open source) + a custom middleware layer
- Immediate goal: **run it on localhost**. It is 95% there; §7 has the one
  remaining blocker, already diagnosed.

There was a parallel experiment building a panel from scratch
(`Omenhostingpanel` repo). That is **abandoned** — this MCSManager-based panel
is the one being taken forward.

---

## 1. Architecture — four Node processes

| Service | Port | Directory | Role |
|---|---|---|---|
| **router** | 3000 | `minecraft-server/web/index.js` | Public entry. Reverse-proxies the other three and injects the theme. |
| **mcsm-daemon** | 24444 | `minecraft-server/mcsmanager/daemon` | Runs the actual Minecraft processes. |
| **mcsm-web** | 23333 | `minecraft-server/mcsmanager/web` | MCSManager panel (Vue SPA + Koa API). |
| **middleware** | 29999 | `minecraft-server/middleware/server.js` | All custom OmenHosting features. |

Only **3000** is public. Routing lives in `getBackend()`:
`/socket.io`, `/upload-*`, `/download/` → daemon · `/api/omen/*`, `/create` →
middleware · everything else → web panel.

---

## 2. What is custom (this is the work to preserve)

MCSManager itself is upstream code. Everything below was written for this
project and is what makes it OmenHosting rather than stock MCSManager.

```
minecraft-server/middleware/
  server.js            main service: routes, auto-sleep, queue, signup,
                       instance creation, Minekube address detection
  bootstrap-admin.js   pre-boot: pins session key, enables reverse-proxy
                       mode, creates/reconciles the admin account
  install-libs.js      downloads MCSManager's native binaries for the
                       current OS/arch (pty, file_zip, 7z)
  stats.js             per-instance CPU / RAM / disk from the OS
  public/theme.css     the green-on-dark skin, injected into the panel
  public/inject.js     injected UI: resource panel, server-address box,
                       queue modal, backup box, mod browser, signup link,
                       "+ Create Server" button
  backup/              archive.js (zip + real CRC-32 verification),
                       manager.js (retention, shrink guard), history.js
  storage/             b2.js (Backblaze B2 native API), local.js,
                       index.js (provider factory), provider.js
  mods/modrinth.js     plugin/mod search + install, host-restricted
  test/run-tests.js    regression suite (npm test / npm run test:live)
```

The theme is applied by **injection**, not by forking MCSManager's frontend —
`web/index.js` rewrites HTML responses to add `theme.css` and `inject.js`.
That is deliberate: MCSManager can be upgraded without redoing the skin.

---

## 3. Boot sequence — the order is load-bearing

From `minecraft-server/start.sh`:

1. **router** first (no external deps, opens the port immediately)
2. `install-libs.js` — platform binaries
3. **mcsm-daemon**
4. `bootstrap-admin.js` — **must run before mcsm-web starts.** MCSManager
   loads its user list into memory once at boot and never re-reads it, so an
   account created afterwards is invisible until the next restart.
5. **mcsm-web**
6. **middleware**
7. Monitor loop: restart dead services, max 5 per 10 min, with backoff.

All four services' logs are streamed into the supervisor's stdout with
`[service-name]` prefixes.

---

## 4. Configuration

| Variable | Required | Purpose |
|---|---|---|
| `OMEN_SESSION_KEY` | **yes** | Fixed random string. Without it **every restart logs all users out** (§6). |
| `OMEN_ADMIN_USERNAME` | no | Defaults to `admin`. |
| `OMEN_ADMIN_PASSWORD` | **yes** | Admin password; no default. |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET` | recommended | Backblaze B2 backups. Without these backups fall back to local disk. |
| `BACKUP_PROVIDER` | no | `local` or `b2` |
| `PROXY_PORT` | no | Router port, default 3000 |
| `OMEN_TRUSTED_PROXY_HOPS` | no | Proxy hops in front of the router (§6) |

---

## 5. Running it locally — current state

Verified working on this machine (macOS, Node v26.5.0, Java 25.0.2):

```bash
cd minecraft-server
# deps (already installed here)
for d in . mcsmanager/daemon mcsmanager/web; do (cd $d && npm ci --omit=dev); done
node middleware/install-libs.js          # darwin_arm64 binaries

OMEN_SESSION_KEY=local-dev-fixed-key \
OMEN_ADMIN_USERNAME=admin \
OMEN_ADMIN_PASSWORD=OmenLocal12345 \
PROXY_PORT=3000 \
bash start.sh
```

Then open `http://127.0.0.1:3000/`.

**Confirmed working:** all four services start, the daemon/web link validates
(`key validation successful`), the login page renders with the green theme and
the injected "Create Account" link, login succeeds, the instance list shows all
8 existing instances, the "+ Create Server" button appears, and the Server
Queue modal appears on opening an instance.

Existing local state: **6 user accounts, 8 instances**. Admin password was
re-synced to `OmenLocal12345` by the bootstrap during testing.

---

## 6. Bugs already fixed — do not redo these

| Bug | Fix |
|---|---|
| `setsid` used to launch services but unavailable in the container — jobs died silently, port 3000 never opened | Removed; unnecessary as the script is the main process |
| Scripts hardcoded a bundled Node binary path that was never committed | Use `node` from `PATH` |
| Root `package-lock.json` drifted → `npm ci` failed → fallback pulled `tar@7.5.14`, blocked as a CVE | Regenerated lockfile; pinned `tar@7.5.22` |
| Build step returned non-zero on a directory with no `package.json`, failing the whole build | Restructured loop + trailing `true` |
| Dependency installs at boot blew the health-check window | Moved to a build step; router starts first |
| Per-service logs invisible to the platform | `tail -F` streamed into main stdout |
| macOS binaries committed; wrong arch for Linux | `install-libs.js` downloads per-platform |
| Fresh deploy had no admin account → signup returned "Admin authentication failed" | `bootstrap-admin.js` creates it pre-boot |
| `reverseProxyMode: false` → every visitor resolved to `127.0.0.1` → 10 failed logins banned **everyone** | Bootstrap enables it; router sets `X-Real-IP` |
| Ban *still* global: router took the **rightmost** `X-Forwarded-For`, which is the platform's load balancer — shared and rotating | Count back `OMEN_TRUSTED_PROXY_HOPS` (3) from the end |
| **Every deploy logged all users out** — the session cookie's name *and* signing key come from `data/.session-key`, regenerated whenever that gitignored file is missing | Pinned from `OMEN_SESSION_KEY` before boot |
| Hardcoded admin password in source (3 sites) | Env vars only |
| Queue: 5 separate bugs (race in `queueStartNext`, slot leak on failed upload, wrong daemon event field, bare-string rejections, `url.query` on a `URL` object) | All fixed |
| Backups: `yauzl` validates size but not CRC, so corrupt-but-same-length archives passed | Real CRC-32 verification |
| B2 uploads failed on slow links (Node's 250 ms `autoSelectFamilyAttemptTimeout`) and were not retried at the streaming-body level | Widened to 30 s; retry wraps the body |
| "Create Server" unreachable — its only entry point was deleted with a removed banner | Persistent "+ Create Server" link restored |

---

## 7. THE ONE REMAINING BLOCKER

`start.sh` works, but the services do not survive the launching shell exiting.

**Symptom:** router (3000) and daemon (24444) come up, then die seconds later
with `Received SIGTERM signal from the system`. The web panel and middleware
sometimes survive. Restarting produces the same result.

**Diagnosis:** `start.sh` installs `trap cleanup SIGINT SIGTERM`, and `cleanup`
kills every PID in `.pids/`. When the shell that launched the script exits, the
process group is signalled, the trap fires, and the supervisor takes its own
children down with it. On Linux this was avoided with `setsid`, which **does
not exist on macOS**, so there is nothing detaching the supervisor from the
launching shell's process group.

**Fix — pick one:**

1. **Run the four services directly, no supervisor.** Simplest for local dev:
   ```bash
   cd minecraft-server
   node web/index.js &
   (cd mcsmanager/daemon && node app.js) &
   node middleware/bootstrap-admin.js
   (cd mcsmanager/web && node app.js) &
   node middleware/server.js &
   ```
   Order matters — see §3.

2. **Detach the supervisor properly.** Wrap the launch so it is not in the
   caller's process group. `nohup` alone was not sufficient in testing;
   something equivalent to `setsid` is needed. On macOS, `python3 -c
   "import os,subprocess; os.setsid(); subprocess.run(['bash','start.sh'])"`
   or a `launchd`/`pm2`-style manager works.

3. **Make the trap discriminate.** Only run `cleanup` on an explicit stop
   request rather than on any SIGTERM, so an incidental group signal does not
   tear everything down.

Option 1 is enough to see the panel running; option 2 or 3 is the real fix.

---

## 8. MCSManager behaviours that will waste your time

- **The API requires `x-requested-with: xmlhttprequest`.** Without it, routes
  return `404` — an auth guard that looks like a missing route. Any `curl` test
  without this header gives misleading results.
- **Session key = cookie name AND signing key**, from `data/.session-key`.
  Losing that file logs everyone out. Pinned via `OMEN_SESSION_KEY`.
- **IP ban:** `loginCheckIp` defaults true; >10 failed logins bans that IP for
  10 minutes. In-memory, so restarting `mcsm-web` clears it.
- **Users load once at boot.** Writing a user file while running has no effect
  until restart.
- **`app.js` is a webpack bundle.** Readable, but do not hand-patch it; change
  behaviour through config or the middleware layer. (The session-key block is a
  pre-existing patch, now driven by the secret.)
- **The browser talks to the daemon over WebSocket**, using
  `mcsmanager/web/data/RemoteServiceConfig/*.json` → `remoteMappings`. It was
  pointing at a dead tunnel domain; for local use it must map the
  browser-facing origin to the router:
  ```json
  "remoteMappings": [{ "from": {"ip":"127.0.0.1","port":3000,"prefix":"/"},
                       "to":   {"ip":"ws://127.0.0.1","port":3000,"prefix":""} }]
  ```
  Already applied locally. **This has to be updated for whatever host the panel
  is served from**, or the console shows "Unable to Connect to Remote Daemon".
- **BSD vs GNU `du`:** the daemon calls `du -s --block-size=1M`, which fails on
  macOS. Harmless for the panel; affects instance size reporting only.

---

## 9. Remaining work

1. **Fix the process-detachment blocker** (§7) so `start.sh` survives.
2. **Set B2 secrets** — backups currently fall back to local disk.
3. **Exercise the custom features end to end.** Reachable but not verified in
   this session: the mod/plugin browser, the backup box, auto-sleep, and the
   queue actually promoting a server. The queue *modal* renders; automatic
   promotion has not been observed here.
4. **Update `remoteMappings`** whenever the serving host changes (§8).

---

## 10. Rules of engagement

1. **Measure, don't guess.** The IP-ban bug was "fixed" twice from plausible
   reasoning about proxy behaviour and was wrong both times; a diagnostic
   endpoint settled it in ten minutes.
2. **Never commit secrets.** Env vars only.
3. **Never commit `data/` directories** — real accounts, access keys, worlds.
4. **Never commit platform-specific binaries.** Download at boot.
5. **Verify on fresh state.** Nearly every bug here slipped through because it
   worked on a machine that already had good local data.
6. **A green test suite is not evidence a button works.** Most user-visible
   breakage in this project was UI wired to endpoints that did not exist.
