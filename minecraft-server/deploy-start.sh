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
    (cd "$dir" && npm ci --omit=dev --no-audit --no-fund 2>&1 || npm install --omit=dev --no-audit --no-fund 2>&1) | tail -20
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
  setsid "$@" >> "$logfile" 2>&1 &
  echo $! > "$pidfile"
  echo "  Started $name (PID $!)"
}

echo "[1/4] Starting router (no external deps — opens the health-checked port immediately)..."
start_service router "$NODE" --max-old-space-size="$ROUTER_HEAP" "$BASE_DIR/web/index.js"

echo "[2/4] Installing dependencies for daemon/web/middleware (if not already built)..."
install_if_needed "$BASE_DIR"
install_if_needed "$BASE_DIR/mcsmanager/daemon"
install_if_needed "$BASE_DIR/mcsmanager/web"
install_if_needed "$BASE_DIR/middleware"

echo "[3/4] Starting MCSManager daemon..."
start_service mcsm-daemon bash -c "cd '$BASE_DIR/mcsmanager/daemon' && exec '$NODE' --max-old-space-size=$DAEMON_HEAP $GC_FLAGS app.js"
sleep 3

echo "[3/4] Starting MCSManager web panel..."
start_service mcsm-web bash -c "cd '$BASE_DIR/mcsmanager/web' && exec '$NODE' --max-old-space-size=$WEB_HEAP $GC_FLAGS app.js"
sleep 2

echo "[4/4] Starting OmenHosting middleware..."
start_service middleware "$NODE" --max-old-space-size="$MIDDLEWARE_HEAP" "$BASE_DIR/middleware/server.js"

if [ -z "${OMEN_ADMIN_PASSWORD:-}" ]; then
  echo "  [WARN] OMEN_ADMIN_PASSWORD is not set — set it in Replit Secrets."
fi
if [ -z "${B2_KEY_ID:-}" ] && [ "${BACKUP_PROVIDER:-}" = "b2" ]; then
  echo "  [WARN] BACKUP_PROVIDER=b2 but B2_KEY_ID is not set — backups will fail."
fi

echo "Deployment started. Monitoring with auto-restart (max 5 restarts/service before backing off)..."

# ── Monitor + auto-restart with crash-loop protection ─────────────────
declare -A RESTART_COUNTS
declare -A LAST_RESTART
MAX_RESTARTS=5
RESTART_WINDOW=600  # reset restart count if service stays up this long (s)

restart_service() {
  local name="$1"
  case "$name" in
    router) start_service router "$NODE" --max-old-space-size="$ROUTER_HEAP" "$BASE_DIR/web/index.js" ;;
    mcsm-daemon) start_service mcsm-daemon bash -c "cd '$BASE_DIR/mcsmanager/daemon' && exec '$NODE' --max-old-space-size=$DAEMON_HEAP $GC_FLAGS app.js" ;;
    mcsm-web) start_service mcsm-web bash -c "cd '$BASE_DIR/mcsmanager/web' && exec '$NODE' --max-old-space-size=$WEB_HEAP $GC_FLAGS app.js" ;;
    middleware) start_service middleware "$NODE" --max-old-space-size="$MIDDLEWARE_HEAP" "$BASE_DIR/middleware/server.js" ;;
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

    last="${LAST_RESTART[$name]:-0}"
    if [ $((now - last)) -gt "$RESTART_WINDOW" ]; then
      RESTART_COUNTS[$name]=0
    fi

    if [ "${RESTART_COUNTS[$name]:-0}" -ge "$MAX_RESTARTS" ]; then
      echo "[WARN] $name crash-looping, backing off (waiting ${RESTART_WINDOW}s before retry)"
      LAST_RESTART[$name]=$now
      RESTART_COUNTS[$name]=0
      continue
    fi

    echo "[RESTART] $name (died, attempt $((${RESTART_COUNTS[$name]:-0} + 1))/$MAX_RESTARTS)"
    RESTART_COUNTS[$name]=$(( ${RESTART_COUNTS[$name]:-0} + 1 ))
    LAST_RESTART[$name]=$now
    rm -f "$pidfile"
    restart_service "$name"
  done
done
