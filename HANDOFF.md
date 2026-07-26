# OmenHosting — Engineering Handoff v2.0

Everything needed to work on this project without rediscovering it.
**Read this fully before changing anything.**

- Live: `https://omen-panel--bussinessprivat.replit.app/`
- Repo: `https://github.com/jasontchen0325-wq/OmenPanel`
- Host: Replit **Autoscale** (2 vCPU / 4 GiB / max 1). Staying on Replit is a
  settled decision — do not re-litigate it. Design around it (see §4).

---

## 1. What this is

A Minecraft hosting panel built on **MCSManager** (open source), plus a custom
middleware layer adding a themed UI, cloud backups, a Modrinth mod installer,
resource stats, a start queue, and auto-sleep.

It is **stateful**: worlds, user accounts, and instance configs live on disk.

---

## 2. Architecture — four Node processes

| Service | Port | Directory | Role |
|---|---|---|---|
| **router** | 3000 | `minecraft-server/web/index.js` | Public entry. Reverse-proxies the other three. Zero external deps (Node core only). |
| **mcsm-daemon** | 24444 | `minecraft-server/mcsmanager/daemon` | Runs the actual Minecraft processes. |
| **mcsm-web** | 23333 | `minecraft-server/mcsmanager/web` | MCSManager panel (Vue SPA + Koa API). |
| **middleware** | 29999 | `minecraft-server/middleware/server.js` | OmenHosting layer. All `/api/omen/*` + UI injection. |

Only port **3000** is public (`externalPort 80` in `.replit`).

**Routing** (`web/index.js` → `getBackend()`):
- `/socket.io`, `/upload-*`, `/download/` → daemon
- `/api/omen/*`, `/create` → middleware
- everything else → web panel

The router injects `theme.css` + `inject.js` into HTML responses to skin the
panel without forking MCSManager's frontend.

---

## 3. Boot sequence — the order is load-bearing

From `deploy-start.sh` (production) / `start.sh` (dev Run button):

1. **router** first — no external deps, so it opens the health-checked port in
   milliseconds instead of timing out behind an npm install.
2. `npm ci` fallback for missing `node_modules` (normally done by
   `[deployment].build` in `.replit`).
3. `middleware/install-libs.js` — downloads MCSManager's native binaries
   (pty, file_zip, 7z) for the **current** OS/arch.
4. **mcsm-daemon**.
5. `middleware/bootstrap-admin.js` — **must run before mcsm-web starts.** It:
   - pins the session key (§7)
   - enables reverse-proxy mode (§7)
   - creates/reconciles the admin account
   MCSManager loads users into memory once at boot and never re-reads them, so
   anything written after mcsm-web starts is invisible until the next restart.
6. **mcsm-web**.
7. **middleware**.
8. Monitor loop: restart dead services, max 5 per 10 min each, with backoff.
   Rotates logs over 10MB.

All four services' logs are streamed into the main process's stdout with
`[service-name]` prefixes, because the platform's Logs panel only captures the
top-level process. **This is the only way to see real crash output.** Note the
platform's log view is *lossy* — it drops and reorders lines, so absence of a
line is not evidence.

---

## 4. THE CORE CONSTRAINT — ephemeral filesystem

Autoscale wipes the container filesystem on every deploy and can recycle the
instance at any time. Therefore:

> **Anything that must survive has to live in git, in Secrets, or in B2.
> Treat the local disk as a scratchpad that vanishes without warning.**

Everything that has gone wrong on this project traces back to violating that
rule. The app must be able to fully reconstruct itself on a cold start from
environment variables plus cloud backups. Where it can't yet, that's a bug.

Known consequences to design around:
- Sessions die on redeploy unless the signing key is pinned → `OMEN_SESSION_KEY`
- Admin account vanishes → recreated by `bootstrap-admin.js`
- Panel config resets to defaults → rewritten by `bootstrap-admin.js`
- **Minecraft worlds vanish → only B2 backups can save them. Not yet configured.**
- A running server is killed when the instance idles to zero.

---

## 5. Configuration (Replit → Secrets)

| Variable | Status | Purpose |
|---|---|---|
| `OMEN_ADMIN_USERNAME` | optional | Admin username (default `admin`) |
| `OMEN_ADMIN_PASSWORD` | **required** | Admin password. No default; bootstrap skips without it. |
| `OMEN_SESSION_KEY` | **required** | Fixed random string. Without it **every deploy logs all users out** (§7). |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_BUCKET_ID` | **not set — should be** | Backblaze B2 backups. Currently falls back to `local`, which is wiped on redeploy. |
| `BACKUP_PROVIDER` | | `local` or `b2` |
| `BACKUP_COMPRESSION_LEVEL`, `BACKUP_STORE_PRECOMPRESSED`, `BACKUP_REMOTE_ROOT`, `BACKUP_LOCAL_PATH` | optional | Backup tuning |
| `OMEN_TRUSTED_PROXY_HOPS` | optional | Proxy hops in front of the router (default 3, §7) |
| `OMEN_DAEMON_HEAP_MB` / `OMEN_WEB_HEAP_MB` / `OMEN_MIDDLEWARE_HEAP_MB` / `OMEN_ROUTER_HEAP_MB` | optional | Per-service V8 heap caps (512/512/256/128) |

---

## 6. Bugs already fixed — do not redo these

| Bug | Fix |
|---|---|
| `setsid` used to launch every service, unavailable in this container — background jobs died silently, port 3000 never opened | Removed; unnecessary since scripts run as the container's main process |
| Scripts hardcoded a bundled Node binary path that was never committed | Use the Nix-provisioned `node` on `PATH` |
| Root `package-lock.json` drifted → `npm ci` failed → fallback pulled `tar@7.5.14`, blocked by the platform firewall as a CVE | Regenerated lockfile; pinned `tar@7.5.22` |
| Build step's last loop iteration returned non-zero, failing the whole build despite every install succeeding | Restructured loop + trailing `true` |
| Dependency installs ran at boot, blowing the health-check window | Moved to `[deployment].build`; router starts first regardless |
| No auto-restart in production | Monitor loop with crash-loop backoff |
| Per-service logs invisible to the platform | `tail -F` streamed into main stdout with prefixes |
| macOS binaries committed; wrong arch for the Linux container | `install-libs.js` downloads correct per-platform binaries |
| Fresh deploy had no admin account → signup returned "Admin authentication failed" | `bootstrap-admin.js` creates it pre-boot |
| `reverseProxyMode: false` → every visitor resolved to `127.0.0.1` → 10 failed logins banned **everyone** | Bootstrap enables reverse-proxy mode; router sets `X-Real-IP` |
| Ban *still* global: router took the **rightmost** `X-Forwarded-For`, which is the platform's load balancer — shared by all and rotating per request | Count back 3 trusted hops from the end (§7) |
| Duplicate root handler dropped all cookies/headers on `/` | Removed; everything goes through `proxyRequest` |
| Bare `OK` fallback masked total outages | Moved to `/health`; unreachable backend serves a self-refreshing loading page |
| "Create Server" unreachable — its only entry point was deleted with a removed banner | Persistent "+ Create Server" link restored (the `/create` page and API were always intact) |
| Hardcoded admin password in source (3 sites) | Env vars only |
| Rotating `OMEN_ADMIN_PASSWORD` silently did nothing | Bootstrap reconciles the stored hash each boot |
| Signup failures always said "Failed to create user"; a 200 with an error envelope was treated as success | Read the panel's `data` field; treat error envelopes as failures |
| **Every deploy logged all users out** → "Unable to retrieve identity data" | Session key pinned from `OMEN_SESSION_KEY` (§7) |

---

## 7. MCSManager behaviours that will waste your time

**API requires `x-requested-with: xmlhttprequest`.** Without it, API routes
return `404` — an auth guard that looks like a missing route. Any `curl` test
without this header gives misleading results.

**Session key = cookie name AND signing key.** Patched into `web/app.js`:
```js
const __sessionKeyFile = path.join(process.cwd(), "data", ".session-key");
// generates a fresh uuid if the file is missing
app.keys = [__stableKey];
app.use(koa_session({ key: __stableKey, ... }))
```
`data/` is gitignored and wiped on deploy, so a new key was generated every
release, instantly invalidating every login. The browser then presents a cookie
the server doesn't recognise, `/api/auth/` 403s, and the SPA shows
*"Unable to retrieve identity data, may be banned or network issue"*.
`bootstrap-admin.js` now writes this file from `OMEN_SESSION_KEY`.

**IP ban.** `loginCheckIp` defaults true; >10 failed logins bans that IP for
10 minutes. In-memory, so restarting `mcsm-web` clears it. `ctx.ip` comes from
`X-Real-IP` only when `reverseProxyMode` is on — both must stay in sync.

**The proxy chain has 3 rotating hops.** Measured via `GET /api/omen/debug/ip`:
```
plain request   -> 35.144.47.23, 34.117.33.233, 35.191.147.240, 34.67.115.235
forged XFF sent -> 1.2.3.4, 35.144.47.23, 34.117.33.233, 35.191.102.185, 136.115.212.231
```
`35.144.47.23` was the caller's real address. Client-supplied values are
**prepended**; trailing entries are load balancers that differ per request.
Never take the last entry, never trust the first — count back from the end.
That endpoint is live and is the fastest way to re-derive this if the topology
changes.

**Users load once at boot.** Writing a user file while the panel runs has no
effect until restart.

**`app.js` is a webpack bundle.** Readable, but don't hand-patch it — change
behaviour via config or the middleware layer. (The session-key block above is a
pre-existing patch; leave it, it's now driven by the secret.)

---

## 8. Verified working (tested against the live deployment)

- Root page, `/create`, `theme.css`, `inject.js`, `/health` → 200
- `/api/omen/status`, `instances`, `settings`, `check-user`, `backup/status`,
  `queue/count`, `debug/ip` → 200
- `/api/overview` unauthenticated → 403 (auth correctly enforced)
- Signup validation, and the admin-auth path (tested with an existing username,
  which fails at the duplicate check *after* admin auth — creating nothing)
- Login endpoint returns correct structured responses
- Client IP resolves to the real visitor and ignores forged `X-Forwarded-For`
  and `X-Real-IP`
- Daemon healthy: `key validation successful`, no `[RESTART]` lines

## 9. NOT verified — the real gap

**Nothing behind the login has ever been tested on the live deployment.** No
one has logged in and exercised the dashboard, file manager, mod installer,
backups, resource stats, or the queue.

**No Minecraft server has ever been created end-to-end in production.**
`/api/omen/instances` returns `[]`. That is the panel's entire purpose and it
is completely untested. Everything above is plumbing.

---

## 10. Remaining work, in priority order

### A. Set the two missing secrets — highest value, lowest effort
- `OMEN_SESSION_KEY` — any fixed random string. Until set, **every deploy logs
  everyone out**; the bootstrap now warns loudly in the logs when it's missing.
- `B2_KEY_ID` / `B2_APPLICATION_KEY` / `B2_BUCKET` (+ `BACKUP_PROVIDER=b2`).
  Backups currently report `{"provider":"local"}` — written to a disk that is
  wiped on redeploy, i.e. no backups at all. On ephemeral hosting B2 is the
  *only* thing that can make worlds survive.

Then redeploy and confirm in the logs:
```
[bootstrap] Session key pinned from OMEN_SESSION_KEY
[backup] Ready using "b2" storage
```

### B. Prove the core flow works
Log in, create a server, start it, confirm it reaches "running", and confirm a
backup lands in B2. Until this is done the panel is unproven. Expect problems
here — it is the least-tested path in the system.

### C. Make cold starts non-destructive
Given §4, a recycled instance should restore its instances from B2 rather than
come back empty. `/api/omen/prestart` and the restore path exist for exactly
this but have never been exercised in production. Verify a server survives a
redeploy; if it doesn't, that is the most important bug left.

### D. Loose ends
- `/api/auth/sso/config` returns 500 (SSO disabled, page renders fine —
  cosmetic, uninvestigated).
- `backupRetention = 1` — only one backup is kept.
- `/api/omen/debug/ip` is a diagnostic endpoint; harmless (echoes only the
  caller's own headers) but can be removed once the topology is settled.
- Credentials pasted in plaintext during development (a B2 key, the admin
  password) should be rotated. They are not in the repo.

---

## 11. Rules of engagement

1. **Measure, don't guess.** The ban bug was "fixed" twice from plausible
   reasoning about proxy behaviour and was wrong both times. A diagnostic
   endpoint settled it in ten minutes. If a claim about the environment can be
   tested, test it before writing the fix.
2. **Never commit secrets.** Env vars only.
3. **Never commit `data/` directories.** Real accounts, keys, worlds.
4. **Never commit platform-specific binaries.** Download at boot.
5. **Verify on fresh state.** Nearly every bug here slipped through because it
   worked on a machine that already had good local data.
6. **The platform's log view is lossy.** A missing line is not evidence of
   anything.
7. **Don't test by creating accounts on production.** To exercise the signup
   admin-auth path, sign up with an *existing* username: MCSManager's duplicate
   check throws before any account is written.
