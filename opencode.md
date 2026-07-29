# Handoff to OpenCode — Real Pterodactyl Panel + Wings migration (in progress)

Claude (this session) is about to hit its weekly limit. The user is switching to OpenCode
to continue. This file is a handoff for exactly what's in progress right now — it is
**not** related to the OmenHosting/MCSManager work documented in `CLAUDE.md` at the repo
root. That's a separate, older effort. Read that file for background on this whole
project's deployment history (Replit/Render/Railway/Northflank sagas), but everything
below is about a brand-new, parallel track: **migrating away from MCSManager to the real,
official Pterodactyl Panel + Wings**, per explicit user request.

## Why this exists

The user asked to replace MCSManager with actual Pterodactyl (not just the
Pterodactyl-*styled* theme layered on MCSManager that the rest of this repo is), plus
install third-party Pterodactyl add-ons (Blueprint-style). This is not a reskin — it's a
different codebase entirely (PHP/Laravel Panel + Go Wings daemon), running independently
of everything else in this repo. Nothing in `minecraft-server/` is touched by this effort.

**Key constraint discovered and confirmed via research:** Wings (the daemon that actually
runs game servers) only ships official Linux builds — no macOS binary exists, and no
official Docker-based way to run it either. It needs a real Linux host with Docker
installed directly on it. The user chose to test locally first, so the setup below uses a
real Ubuntu VM (via Lima) rather than trying to run Wings directly on macOS or via an
unofficial community fork.

## Current state — what's built and working right now

A real Ubuntu 26.04 VM is running via **Lima** (`limactl`, already installed on this Mac),
named `pterodactyl`, with rootful Docker configured (`template:docker-rootful`, 4 CPUs,
6GB RAM, 40GB disk). Check it's still up with:

```bash
limactl list
# if not running:
limactl start pterodactyl
```

Home directory (`/Users/jasonchen`) is mounted **read-only** inside this VM (virtiofs) —
all Pterodactyl data lives in `/opt/pterodactyl` (writable) inside the VM instead.

### Panel (PHP/Laravel)

Running via Docker Compose inside the VM at `/opt/pterodactyl/docker-compose.yml` — three
containers: `mariadb:11`, `redis:alpine`, `ghcr.io/pterodactyl/panel:latest`. To manage:

```bash
limactl shell pterodactyl -- bash -c "cd /opt/pterodactyl && docker compose ps"
limactl shell pterodactyl -- bash -c "cd /opt/pterodactyl && docker compose logs panel --tail 60"
```

- Panel container's port 80 is mapped to the **VM's** port 8080, which Lima auto-forwards
  to the **Mac host's** `localhost:8080`.
- Admin account already created: **`admin` / `OmenAdmin2026!`** (email
  `admin@omenhosting.local`), via `docker exec pterodactyl-panel-1 php artisan
  p:user:make ...`.
- Default Nests/Eggs already seeded on first boot (Minecraft: Paper, Vanilla, Forge,
  Bungeecord, Sponge; plus Source Engine, Rust, Voice Server eggs) — this is normal
  Pterodactyl behavior, not something we set up manually.
- Already created in the admin UI: **Location** `local`, **Node** `local-node` (ID 1),
  6 port allocations on `192.168.5.15` (the VM's own internal IP) covering **25565-25570**
  for Minecraft servers, with 3072 MiB memory / 20000 MiB disk budgeted to the node.

### Wings (Go daemon)

Installed as a native binary directly on the VM (not containerized — this is the correct,
official way to run it): `/usr/local/bin/wings`, config at `/etc/pterodactyl/config.yml`
(the exact file Pterodactyl's Node → Configuration admin page generated — don't
regenerate this from scratch, it has a real API token in it already matched to the
Node in the DB).

Currently running via a bare `nohup ... &` (**not** a systemd service yet — this is a gap,
see Immediate Next Steps). Confirmed live and fully connected to the Panel: the Node's
"About" page in the admin UI shows real data pulled from Wings (`Daemon Version: v1.13.1`,
`System Information: Linux (arm64)`, `Total CPU Threads: 4`), and Wings' own boot log shows
`fetching list of servers from API` → `total_configs=0` succeeding.

To check if Wings is still running / restart it:

```bash
limactl shell pterodactyl -- sudo pgrep -af wings
# if not running:
limactl shell pterodactyl -- sudo /usr/local/bin/wings &   # add > logfile 2>&1 and disown for background use
```

### Public access (cloudflared tunnels — THE FRAGILE PART, read this)

Two `cloudflared tunnel --url ...` quick tunnels run **on the Mac host** (not in the VM),
proxying into the Lima-forwarded ports:

| Purpose | Local target | Tunnel URL (as of this handoff) |
|---|---|---|
| Panel | `http://localhost:8080` | `https://maryland-northeast-clothes-commonwealth.trycloudflare.com` |
| Wings daemon API | `http://localhost:8443` | `https://own-ease-stockings-jewish.trycloudflare.com` |

**These URLs are random and change every single time `cloudflared` restarts.** If the Mac
sleeps/reboots, or these background processes get killed, both tunnels die and come back
with **completely different hostnames**. When that happens, ALL of the following must be
updated to match the new URLs, or the Panel breaks with CSRF `419 Page Expired` errors and
Wings shows as disconnected:

1. `docker-compose.yml`'s `APP_URL` env var (Panel container) → the new Panel tunnel URL,
   then `docker compose up -d panel --force-recreate` to apply it.
2. The Node's **FQDN** in the admin UI (`/admin/nodes/view/1/settings`) → the new Wings
   tunnel hostname (no `https://` prefix, just the hostname).
3. `/etc/pterodactyl/config.yml`'s `remote:` field → the new Panel tunnel URL. (Re-fetch
   the whole file from the Node's Configuration tab after step 2, since the FQDN change
   also affects the `cert`/`key` paths shown there, even though `ssl.enabled: false` means
   those paths are unused — copy the whole generated file over to be safe.)
4. Restart Wings after rewriting its config.

This already happened once this session (the very first Panel tunnel attempt used
`APP_URL: http://localhost:8080`, causing an immediate CSRF failure on first form
submission — fixed by updating `APP_URL` to the real tunnel URL and recreating the
container). Expect to hit this again after any restart.

**If continuing this work long-term, the actual fix is to stop depending on ephemeral
quick tunnels** — either run `cloudflared` as a **named tunnel** (persistent hostname,
requires a Cloudflare account + `cloudflared tunnel login`), or move this whole VM to a
real always-on host (a VPS) instead of a Mac that sleeps. Worth raising with the user
before spending more time on tunnel URL whack-a-mole.

### Also still running, unrelated — don't touch

A third `cloudflared tunnel --url http://localhost:3000` is running on the Mac
(PID visible via `ps aux | grep cloudflared`) — that's the **old MCSManager** panel from
the work documented in `CLAUDE.md`, completely separate from this Pterodactyl effort.
Leave it alone.

## Immediate next steps (what the user asked for, not yet done)

1. **Create an actual test Minecraft server** through the Panel UI (Servers → Create New,
   pick the seeded "Paper" or "Vanilla" egg, assign it to `local-node`, use one of the
   allocated 25565-25570 ports) to prove the full chain works end-to-end: creation →
   Wings installs the server → starts → console/file-manager reachable through the
   browser. This hasn't been tried yet — do this first, since it'll surface any remaining
   gaps (e.g., whether the browser can actually reach Wings' file-manager/console
   WebSocket through the tunnel, which hasn't been directly tested, only the base HTTP
   401 response was confirmed).
2. **Install Blueprint** (`https://blueprint.zip` — the addon/theme framework the user
   specifically asked for, calling it "add-ons"). This is a separate installer that patches
   the Panel install in place; needs to run inside the `pterodactyl-panel-1` container or
   against the Panel's own filesystem (`/opt/pterodactyl/var` etc. — check Blueprint's own
   docs for exact compatibility with the official Docker image vs. a bare-metal Panel
   install, since Blueprint's installer assumes shell/composer/yarn access that may not
   exist inside the slim official container image).
3. **Make Wings persistent across VM reboots** — currently just a backgrounded process,
   not a systemd service. Should be:
   ```bash
   limactl shell pterodactyl -- sudo tee /etc/systemd/system/wings.service > /dev/null << 'EOF'
   [Unit]
   Description=Pterodactyl Wings Daemon
   After=docker.service
   Requires=docker.service
   PartOf=docker.service
   [Service]
   User=root
   WorkingDirectory=/etc/pterodactyl
   LimitNOFILE=4096
   PIDFile=/var/run/wings/daemon.pid
   ExecStart=/usr/local/bin/wings
   Restart=on-failure
   StartLimitInterval=180
   StartLimitBurst=30
   RestartSec=5s
   [Install]
   WantedBy=multi-user.target
   EOF
   limactl shell pterodactyl -- sudo systemctl enable --now wings
   ```
   (This is the official install pattern from Pterodactyl's own docs — not yet applied
   here, was deferred in favor of quick manual testing.)
4. Solve **real player connectivity** to whatever Minecraft server actually gets created.
   `cloudflared tunnel --url` (what's used for the Panel/Wings HTTP APIs above) is
   HTTP(S)-only — it cannot proxy Minecraft's raw TCP game protocol on port 25565. The
   old MCSManager setup solved this with the **Minekube Connect** plugin (installed
   directly into the Minecraft server as a Spigot/Paper/Velocity plugin — see
   `minecraft-server/middleware/server.js`'s `installMinekubePlugin()` for reference,
   though that's MCSManager-specific glue code, not reusable directly). The same Minekube
   plugin approach should still work here since it's independent of which panel manages
   the server — but this hasn't been set up for the new Pterodactyl-created server yet.

## Credentials / reference

- Panel admin: `admin` / `OmenAdmin2026!`
- DB (inside VM, mariadb container): user `pterodactyl`, password `PteroDbPass2026!`,
  root password `PteroRootPass2026!` — defined in `/opt/pterodactyl/docker-compose.yml`
- Node UUID: `1daeb4b2-d1f1-49d3-a02b-0b6dec04e47c` (also in `/etc/pterodactyl/config.yml`)
- Wings/Panel communicate via a token in `config.yml` — don't regenerate this unless the
  Node itself gets deleted and recreated in the Panel.
