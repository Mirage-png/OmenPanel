#!/bin/bash
# Production entrypoint for Replit Deployments (24/7).
# Uses the Nix-provisioned `node` on PATH — no bundled binary dependency.
set -u
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
LOG_DIR="$BASE_DIR/logs"
PID_DIR="$BASE_DIR/.pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

if [ -z "$NODE" ]; then
  echo "[FATAL] node not found on PATH — check replit.nix packages" >&2
  exit 1
fi

export NODE_ENV=production

# Default admin credentials for bootstrapping (overridable via Replit Secrets)
export OMEN_ADMIN_USERNAME="${OMEN_ADMIN_USERNAME:-admin}"
export OMEN_ADMIN_PASSWORD="${OMEN_ADMIN_PASSWORD:-OmenAdmin2026!}"

# Heap sizes tuned to fit a 2GB Reserved VM with headroom left for the
# Minecraft JVM itself (~512MB-1GB per running instance). Bump these via
# env vars if the deployment is sized larger.
DAEMON_HEAP="${OMEN_DAEMON_HEAP_MB:-512}"
WEB_HEAP="${OMEN_WEB_HEAP_MB:-512}"
MIDDLEWARE_HEAP="${OMEN_MIDDLEWARE_HEAP_MB:-256}"
ROUTER_HEAP="${OMEN_ROUTER_HEAP_MB:-128}"
GC_FLAGS="--optimize-for-size --gc-interval=100 --max-semi-space-size=32"

echo "Deploying OmenHosting..."

# ── Install dependencies if missing (fallback only — the [deployment].build
# step in .replit should have already done this during build, not runtime).
# Router has zero external deps (core `http`/`url` only) so it never waits
# on this; daemon/web/middleware installs run in the background after the
# router is already listening, so the platform health check on :3000 passes
# immediately instead of timing out while npm installs ~250MB of packages.
install_if_needed() {
  local dir="$1"
  if [ -f "$dir/package.json" ] && [ ! -d "$dir/node_modules" ]; then
    echo "  Installing deps in ${dir#$BASE_DIR/}..."
    # minecraft-server/package-lock.json pins resolved URLs against
    # package-firewall.replit.local, a .local hostname that doesn't exist
    # outside Replit. Trying `npm ci` against it first (previous version of
    # this function) doesn't fail fast — .local hostnames commonly trigger
    # slow mDNS resolution attempts before giving up, once per package, so
    # the "fails outright" assumption was wrong and it was actually just
    # slowly timing out on every single lookup before ever reaching the
    # fallback. Going straight to --no-package-lock skips all of that: npm
    # ignores the lockfile entirely and resolves fresh from the real
    # registry, no poisoned URLs ever touched.
    (cd "$dir" && npm install --no-package-lock --omit=dev --no-audit --no-fund 2>&1) | tail -20
  fi
}

# ── Log rotation: truncate any log over 10MB so disk never fills ──────
rotate_logs() {
  for f in "$LOG_DIR"/*.log; do
    [ -f "$f" ] || continue
    size=$(wc -c < "$f" 2>/dev/null || echo 0)
    if [ "$size" -gt 10485760 ]; then
      tail -c 2097152 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    fi
  done
}

SERVICES="router mcsm-daemon mcsm-web middleware"

start_service() {
  local name="$1"; shift
  local pidfile="$PID_DIR/$name.pid"
  local logfile="$LOG_DIR/$name.log"
  # Launched fully detached (see spawn-detached.js) so it survives this
  # script's own process group being signalled.
  local pid
  pid=$("$NODE" "$BASE_DIR/middleware/spawn-detached.js" "$logfile" "$@")
  if [ -z "$pid" ]; then
    echo "  [FAIL] Could not start $name"
    return 1
  fi
  echo "$pid" > "$pidfile"
  echo "  Started $name (PID $pid)"
}

# Replit's deployment log only captures this script's own stdout/stderr —
# it can't see files written inside the container. Stream every service's
# log into this process's stdout (prefixed by name) so real crash output
# is actually visible in the platform's Logs panel instead of being stuck
# in files nobody can read.
for name in router mcsm-daemon mcsm-web middleware; do
  touch "$LOG_DIR/$name.log"
  ( tail -n 0 -F "$LOG_DIR/$name.log" 2>/dev/null | sed "s/^/[$name] /" ) &
done

echo "[1/4] Starting router (no external deps — opens the health-checked port immediately)..."
start_service router "$NODE" --max-old-space-size="$ROUTER_HEAP" $GC_FLAGS "$BASE_DIR/web/index.js"

echo "[2/4] Installing dependencies for daemon/web/middleware (if not already built)..."
install_if_needed "$BASE_DIR"
install_if_needed "$BASE_DIR/mcsmanager/daemon"
install_if_needed "$BASE_DIR/mcsmanager/web"
install_if_needed "$BASE_DIR/middleware"

echo "[3/4] Ensuring architecture-specific lib binaries..."
"$NODE" "$BASE_DIR/middleware/install-libs.js"

# Must run before mcsm-daemon starts — the daemon loads InstanceConfig once
# at its own boot and never re-reads it, so a world restored after that point
# would stay invisible until a second restart. This is what actually survives
# a "republish": without it, every account, server config, and world is gone
# the moment the ephemeral filesystem resets (see middleware/state-sync.js).
echo "[3/4] Restoring panel state from remote storage (if configured)..."
"$NODE" "$BASE_DIR/middleware/restore-state.js"

echo "[3/4] Starting MCSManager daemon..."
start_service mcsm-daemon bash -c "cd '$BASE_DIR/mcsmanager/daemon' && exec '$NODE' --max-old-space-size=$DAEMON_HEAP $GC_FLAGS app.js"
sleep 3

# Must run before mcsm-web starts — MCSManager loads its user list into
# memory once at boot and never re-reads it, so a user created afterward
# would be invisible until the next restart.
"$NODE" "$BASE_DIR/middleware/bootstrap-admin.js"

echo "[3/4] Starting MCSManager web panel..."
start_service mcsm-web bash -c "cd '$BASE_DIR/mcsmanager/web' && exec '$NODE' --max-old-space-size=$WEB_HEAP $GC_FLAGS app.js"
sleep 2

echo "[4/4] Starting OmenHosting middleware..."
start_service middleware "$NODE" --max-old-space-size="$MIDDLEWARE_HEAP" $GC_FLAGS "$BASE_DIR/middleware/server.js"

if [ -z "${OMEN_ADMIN_PASSWORD:-}" ]; then
  echo "  [WARN] OMEN_ADMIN_PASSWORD is not set — set it in Replit Secrets."
fi
if [ -z "${B2_KEY_ID:-}" ] && [ "${BACKUP_PROVIDER:-}" = "b2" ]; then
  echo "  [WARN] BACKUP_PROVIDER=b2 but B2_KEY_ID is not set — backups will fail."
fi
if [ "${BACKUP_PROVIDER:-}" = "s3" ] && { [ -z "${S3_ENDPOINT:-}" ] || [ -z "${S3_ACCESS_KEY_ID:-}" ] || [ -z "${S3_SECRET_ACCESS_KEY:-}" ] || [ -z "${S3_BUCKET:-}" ]; }; then
  echo "  [WARN] BACKUP_PROVIDER=s3 but S3_ENDPOINT/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET are incomplete — state will not survive a redeploy."
fi

# A "republish" on Replit sends SIGTERM to this process before tearing the
# container down. Without catching it, everything since the last periodic
# save (up to STATE_SYNC_INTERVAL below) is lost — this is the actual fix for
# "republishing deletes everything." Runs synchronously so the container
# isn't reclaimed mid-upload.
STATE_SYNC_INTERVAL="${STATE_SYNC_INTERVAL_SECONDS:-120}"
shutdown_save() {
  echo "[shutdown] Saving panel state before exit..."
  "$NODE" "$BASE_DIR/middleware/save-state.js"
  exit 0
}
trap shutdown_save SIGTERM SIGINT

if [ "${BACKUP_PROVIDER:-}" = "s3" ] || [ "${BACKUP_PROVIDER:-}" = "b2" ]; then
  ( while true; do sleep "$STATE_SYNC_INTERVAL"; "$NODE" "$BASE_DIR/middleware/save-state.js"; done ) &
fi

echo "Deployment started. Monitoring with auto-restart (max 5 restarts/service before backing off)..."

# ── Monitor + auto-restart with crash-loop protection ─────────────────
# Restart counters live in plain files rather than associative arrays —
# this environment already turned out to be missing `setsid`, a normally
# ubiquitous util-linux tool, so bash-4-only features aren't assumed safe.
MAX_RESTARTS=5
RESTART_WINDOW=600  # reset restart count if service stays up this long (s)

restart_service() {
  local name="$1"
  case "$name" in
    router) start_service router "$NODE" --max-old-space-size="$ROUTER_HEAP" $GC_FLAGS "$BASE_DIR/web/index.js" ;;
    mcsm-daemon) start_service mcsm-daemon bash -c "cd '$BASE_DIR/mcsmanager/daemon' && exec '$NODE' --max-old-space-size=$DAEMON_HEAP $GC_FLAGS app.js" ;;
    mcsm-web) start_service mcsm-web bash -c "cd '$BASE_DIR/mcsmanager/web' && exec '$NODE' --max-old-space-size=$WEB_HEAP $GC_FLAGS app.js" ;;
    middleware) start_service middleware "$NODE" --max-old-space-size="$MIDDLEWARE_HEAP" $GC_FLAGS "$BASE_DIR/middleware/server.js" ;;
  esac
}

while true; do
  sleep 15
  rotate_logs
  now=$(date +%s)
  for name in $SERVICES; do
    pidfile="$PID_DIR/$name.pid"
    [ -f "$pidfile" ] || continue
    pid=$(cat "$pidfile" 2>/dev/null)
    kill -0 "$pid" 2>/dev/null && continue

    countfile="$PID_DIR/$name.restarts"
    lastfile="$PID_DIR/$name.lastrestart"
    count=$(cat "$countfile" 2>/dev/null || echo 0)
    last=$(cat "$lastfile" 2>/dev/null || echo 0)

    if [ $((now - last)) -gt "$RESTART_WINDOW" ]; then
      count=0
    fi

    if [ "$count" -ge "$MAX_RESTARTS" ]; then
      echo "[WARN] $name crash-looping, backing off (waiting ${RESTART_WINDOW}s before retry)"
      echo "$now" > "$lastfile"
      echo 0 > "$countfile"
      continue
    fi

    echo "[RESTART] $name (died, attempt $((count + 1))/$MAX_RESTARTS)"
    echo $((count + 1)) > "$countfile"
    echo "$now" > "$lastfile"
    rm -f "$pidfile"
    restart_service "$name"
  done
done
