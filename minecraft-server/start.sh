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
GC_FLAGS="--optimize-for-size --gc-interval=100 --max-semi-space-size=32"

echo "Starting OmenHosting supervisor..."

install_if_needed() {
  local dir="$1"
  if [ -f "$dir/package.json" ] && [ ! -d "$dir/node_modules" ]; then
    echo "  Installing deps in ${dir#$BASE_DIR/}..."
    (cd "$dir" && npm ci --omit=dev --no-audit --no-fund 2>&1 || npm install --omit=dev --no-audit --no-fund 2>&1) | tail -20
  fi
}

# Cleanup handler
cleanup() {
  echo "Shutting down..."
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
  "$@" >> "$logf" 2>&1 &
  echo $! > "$pidf"
  echo "  Started $name (PID $!)"
}

restart_service() {
  local name="$1"
  case "$name" in
    router) start_service router "$NODE" --max-old-space-size="$ROUTER_HEAP" "$BASE_DIR/web/index.js" ;;
    mcsm-daemon) start_service mcsm-daemon bash -c "cd '$BASE_DIR/mcsmanager/daemon' && exec '$NODE' --max-old-space-size=$DAEMON_HEAP $GC_FLAGS app.js" ;;
    mcsm-web) start_service mcsm-web bash -c "cd '$BASE_DIR/mcsmanager/web' && exec '$NODE' --max-old-space-size=$WEB_HEAP $GC_FLAGS app.js" ;;
    middleware) start_service middleware "$NODE" --max-old-space-size="$MIDDLEWARE_HEAP" "$BASE_DIR/middleware/server.js" ;;
  esac
}

echo "[1] Starting services..."
restart_service router

install_if_needed "$BASE_DIR"
install_if_needed "$BASE_DIR/mcsmanager/daemon"
install_if_needed "$BASE_DIR/mcsmanager/web"
install_if_needed "$BASE_DIR/middleware"

restart_service mcsm-daemon
sleep 3
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
