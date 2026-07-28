#!/bin/bash
# Dev/preview entrypoint (Replit "Run" button). Uses the Nix-provisioned
# `node` on PATH. No external tunnel needed — Replit already exposes
# localPort 3000 on the workspace's own domain (see .replit [[ports]]).
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

DAEMON_HEAP="${OMEN_DAEMON_HEAP_MB:-512}"
WEB_HEAP="${OMEN_WEB_HEAP_MB:-512}"
MIDDLEWARE_HEAP="${OMEN_MIDDLEWARE_HEAP_MB:-256}"
ROUTER_HEAP="${OMEN_ROUTER_HEAP_MB:-128}"
# See the matching comment in deploy-start.sh: --gc-interval and
# --optimize-for-size trade CPU for memory, which is backwards for a
# CPU-constrained host running a JVM alongside these 4 Node processes.
GC_FLAGS="--max-semi-space-size=32"

# Default admin credentials for bootstrapping (overridable via Replit Secrets)
export OMEN_ADMIN_USERNAME="${OMEN_ADMIN_USERNAME:-admin}"
export OMEN_ADMIN_PASSWORD="${OMEN_ADMIN_PASSWORD:-OmenAdmin2026!}"

echo "Starting OmenHosting supervisor..."

install_if_needed() {
  local dir="$1"
  if [ -f "$dir/package.json" ] && [ ! -d "$dir/node_modules" ]; then
    echo "  Installing deps in ${dir#$BASE_DIR/}..."
    # See the matching comment in deploy-start.sh: npm ci against
    # minecraft-server's own package-lock.json doesn't fail fast, it hangs on
    # slow .local mDNS resolution attempts against Replit's unreachable
    # internal package firewall. Skip straight to --no-package-lock.
    (cd "$dir" && npm install --no-package-lock --omit=dev --no-audit --no-fund 2>&1) | tail -20
  fi
}

# Cleanup handler
cleanup() {
  echo "Shutting down..."
  if [ "${BACKUP_PROVIDER:-}" = "s3" ] || [ "${BACKUP_PROVIDER:-}" = "b2" ]; then
    echo "  Saving panel state before exit..."
    "$NODE" "$BASE_DIR/middleware/save-state.js"
  fi
  for pidf in "$PID_DIR"/*.pid; do
    [ -f "$pidf" ] && kill "$(cat "$pidf")" 2>/dev/null
  done
  rm -f "$PID_DIR"/*.pid
  exit 0
}
trap cleanup SIGINT SIGTERM

rotate_logs() {
  for f in "$LOG_DIR"/*.log; do
    [ -f "$f" ] || continue
    size=$(wc -c < "$f" 2>/dev/null || echo 0)
    if [ "$size" -gt 10485760 ]; then
      tail -c 2097152 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    fi
  done
}

start_service() {
  local name="$1"; shift
  local pidf="$PID_DIR/$name.pid"
  local logf="$LOG_DIR/$name.log"
  # Launched fully detached (see spawn-detached.js) so it survives this
  # script's own process group being signalled — e.g. the shell that ran
  # start.sh exiting, or a tool harness tearing down its own child.
  local pid
  pid=$("$NODE" "$BASE_DIR/middleware/spawn-detached.js" "$logf" "$@")
  if [ -z "$pid" ]; then
    echo "  [FAIL] Could not start $name"
    return 1
  fi
  echo "$pid" > "$pidf"
  echo "  Started $name (PID $pid)"
}

restart_service() {
  local name="$1"
  case "$name" in
    router) start_service router "$NODE" --max-old-space-size="$ROUTER_HEAP" $GC_FLAGS "$BASE_DIR/web/index.js" ;;
    mcsm-daemon) start_service mcsm-daemon bash -c "cd '$BASE_DIR/mcsmanager/daemon' && exec '$NODE' --max-old-space-size=$DAEMON_HEAP $GC_FLAGS app.js" ;;
    mcsm-web) start_service mcsm-web bash -c "cd '$BASE_DIR/mcsmanager/web' && exec '$NODE' --max-old-space-size=$WEB_HEAP $GC_FLAGS app.js" ;;
    middleware) start_service middleware "$NODE" --max-old-space-size="$MIDDLEWARE_HEAP" $GC_FLAGS "$BASE_DIR/middleware/server.js" ;;
  esac
}

for name in router mcsm-daemon mcsm-web middleware; do
  touch "$LOG_DIR/$name.log"
  ( tail -n 0 -F "$LOG_DIR/$name.log" 2>/dev/null | sed "s/^/[$name] /" ) &
done

echo "[1] Starting services..."
restart_service router

install_if_needed "$BASE_DIR" &
install_if_needed "$BASE_DIR/mcsmanager/daemon" &
install_if_needed "$BASE_DIR/mcsmanager/web" &
install_if_needed "$BASE_DIR/middleware" &
wait

echo "  Ensuring architecture-specific lib binaries..."
"$NODE" "$BASE_DIR/middleware/install-libs.js"

# Must run before mcsm-daemon starts — see middleware/state-sync.js.
echo "  Restoring panel state from remote storage (if configured)..."
"$NODE" "$BASE_DIR/middleware/restore-state.js"

restart_service mcsm-daemon
sleep 3

# Must run before mcsm-web starts — see middleware/bootstrap-admin.js.
"$NODE" "$BASE_DIR/middleware/bootstrap-admin.js"

restart_service mcsm-web
sleep 2
restart_service middleware

if [ -n "${REPLIT_DOMAINS:-}" ]; then
  echo ""
  echo "  Public URL: https://${REPLIT_DOMAINS%%,*}"
fi
if [ -z "${OMEN_ADMIN_PASSWORD:-}" ]; then
  echo "  [WARN] OMEN_ADMIN_PASSWORD is not set — set it in Replit Secrets."
fi

echo ""
echo "============================================"
echo "  Monitoring $(ls "$PID_DIR"/*.pid 2>/dev/null | wc -l) services (auto-restart, max 5/service per 10min)..."
echo "============================================"

MAX_RESTARTS=5
RESTART_WINDOW=600
STATE_SYNC_INTERVAL="${STATE_SYNC_INTERVAL_SECONDS:-120}"

if [ "${BACKUP_PROVIDER:-}" = "s3" ] || [ "${BACKUP_PROVIDER:-}" = "b2" ]; then
  ( while true; do sleep "$STATE_SYNC_INTERVAL"; "$NODE" "$BASE_DIR/middleware/save-state.js"; done ) &
fi

while true; do
  sleep 10
  rotate_logs
  now=$(date +%s)
  for name in router mcsm-daemon mcsm-web middleware; do
    pidf="$PID_DIR/$name.pid"
    [ -f "$pidf" ] || continue
    pid=$(cat "$pidf")
    kill -0 "$pid" 2>/dev/null && continue

    countfile="$PID_DIR/$name.restarts"
    lastfile="$PID_DIR/$name.lastrestart"
    count=$(cat "$countfile" 2>/dev/null || echo 0)
    last=$(cat "$lastfile" 2>/dev/null || echo 0)

    if [ $((now - last)) -gt "$RESTART_WINDOW" ]; then
      count=0
    fi

    if [ "$count" -ge "$MAX_RESTARTS" ]; then
      echo "[WARN] $name crash-looping, backing off"
      echo "$now" > "$lastfile"
      echo 0 > "$countfile"
      continue
    fi

    echo "[RESTART] $name (died, attempt $((count + 1))/$MAX_RESTARTS)"
    echo $((count + 1)) > "$countfile"
    echo "$now" > "$lastfile"
    rm -f "$pidf"
    restart_service "$name"
  done
done
