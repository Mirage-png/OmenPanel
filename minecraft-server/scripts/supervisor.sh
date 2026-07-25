#!/bin/bash
# Supervisor: starts all services with auto-restart, survives shell timeout.
# Stop via: kill -SIGUSR1 <supervisor_pid>   (or pkill -f supervisor.sh)

set -u

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
PID_DIR="$BASE_DIR/.pids"
LOG_DIR="$BASE_DIR/logs"
STOP_FILE="$PID_DIR/.stop"
NODE_FLAGS="--max-old-space-size=512 --optimize-for-size --gc-interval=100 --max-semi-space-size=32"
SERVICES="router mcsm-daemon mcsm-web middleware"

mkdir -p "$PID_DIR" "$LOG_DIR"

if [ -z "$NODE_BIN" ]; then
  echo "[FATAL] node not found on PATH — check replit.nix packages" >&2
  exit 1
fi

# Replit already exposes localPort 3000 on the workspace/deployment domain —
# no separate tunnel needed.
REPLIT_DOMAIN="${REPLIT_DOMAINS%%,*}"
PUBLIC_URL="https://$REPLIT_DOMAIN"
REMOTE_HOST="$REPLIT_DOMAIN"

echo "============================================"
echo "  OmenHosting - 24/7"
echo "============================================"
echo ""

# ── Signal handling ─────────────────────────────────────────────
stop_services() {
  echo "[boot] Shutting down..."
  touch "$STOP_FILE"
  for name in $SERVICES; do
    pidfile="$PID_DIR/$name.pid"
    if [ -f "$pidfile" ]; then
      pid=$(cat "$pidfile" 2>/dev/null)
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null; sleep 0.5
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
        echo "  Stopped $name"
      fi
      rm -f "$pidfile"
    fi
  done
  rm -f "$STOP_FILE"
  echo "[boot] Done."
  exit 0
}

trap stop_services SIGUSR1
trap '' SIGTERM SIGINT

# ── Determine primary URL ───────────────────────────────────────────
REMOTE_HOST="${REPLIT_DOMAINS%%,*}"
TUNNEL_URL="https://$REMOTE_HOST"

# ── Install dependencies if missing (fresh clone has no node_modules) ──
install_if_needed() {
  local dir="$1"
  if [ -f "$dir/package.json" ] && [ ! -d "$dir/node_modules" ]; then
    echo "  Installing deps in ${dir#$BASE_DIR/}..."
    (cd "$dir" && npm ci --omit=dev --no-audit --no-fund 2>&1 || npm install --omit=dev --no-audit --no-fund 2>&1) | tail -20
  fi
}

# ── 1. Update RemoteServiceConfig ──────────────────────────────────
echo "[1/5] Updating MCSManager daemon config..."
REMOTE_CFG="$BASE_DIR/mcsmanager/web/data/RemoteServiceConfig/8912fa8ad2c947b183e6f783558e9f21.json"
if [ -f "$REMOTE_CFG" ]; then
  "$NODE_BIN" -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('$REMOTE_CFG', 'utf8'));
cfg.ip = '127.0.0.1'; cfg.port = 24444; cfg.prefix = '';
cfg.remoteMappings = [{ from: { ip: '$REMOTE_HOST', port: 443, prefix: '/' }, to: { ip: 'wss://$REMOTE_HOST', port: 443, prefix: '' } }];
cfg.connectOpts = cfg.connectOpts || {};
cfg.connectOpts.multiplex = false; cfg.connectOpts.reconnectionDelayMax = 5000;
cfg.connectOpts.timeout = 10000; cfg.connectOpts.reconnection = true;
cfg.connectOpts.reconnectionAttempts = 10; cfg.connectOpts.rejectUnauthorized = false;
fs.writeFileSync('$REMOTE_CFG', JSON.stringify(cfg, null, 4));
console.log('  ip=127.0.0.1:24444, remoteMappings: $REMOTE_HOST:443 -> wss://$REMOTE_HOST:443');
" 2>&1
fi

# ── 2. Start all services ─────────────────────────────────────────
start_service() {
  local name="$1"; shift
  local pidfile="$PID_DIR/$name.pid"
  local logfile="$LOG_DIR/$name.log"
  "$@" > "$logfile" 2>&1 &
  echo $! > "$pidfile"
}

echo "[2/5] Starting local router..."
start_service router "$NODE_BIN" "$BASE_DIR/web/index.js"

install_if_needed "$BASE_DIR"
install_if_needed "$BASE_DIR/mcsmanager/daemon"
install_if_needed "$BASE_DIR/mcsmanager/web"
install_if_needed "$BASE_DIR/middleware"

echo "[3/5] Starting MCSManager daemon..."
start_service mcsm-daemon bash -c "cd '$BASE_DIR/mcsmanager/daemon' && '$NODE_BIN' $NODE_FLAGS app.js"
sleep 3

# Must run before mcsm-web starts — see middleware/bootstrap-admin.js.
"$NODE_BIN" "$BASE_DIR/middleware/bootstrap-admin.js"

echo "[4/5] Starting MCSManager web panel..."
start_service mcsm-web bash -c "cd '$BASE_DIR/mcsmanager/web' && '$NODE_BIN' $NODE_FLAGS app.js"
sleep 2

echo "[5/5] Starting OmenHosting middleware..."
start_service middleware "$NODE_BIN" "$BASE_DIR/middleware/server.js"
sleep 1

# ── Report ─────────────────────────────────────────────────────────
echo ""; echo "============================================"
echo "  Services Running"; echo "============================================"; echo ""
for name in $SERVICES; do
  pidfile="$PID_DIR/$name.pid"
  [ -f "$pidfile" ] || continue
  pid=$(cat "$pidfile" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    mem=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{printf "%.0f", $1/1024}')
    echo "  [OK] $name  PID=$pid  RAM=${mem}MB"
  else
    echo "  [--] $name  (not running)"
  fi
done
echo ""; echo "  Public URL:    $TUNNEL_URL"
echo "  Web Panel:     $TUNNEL_URL  (login with OMEN_ADMIN_USERNAME / OMEN_ADMIN_PASSWORD from Secrets)"
echo "  Stop via: kill -SIGUSR1 $$"; echo ""

# ── Monitor + auto-restart ────────────────────────────────────────
# Restart counts live in plain files, not associative arrays — this
# environment turned out to be missing `setsid`, a normally ubiquitous
# util-linux tool, so bash-4-only features aren't assumed safe either.
MAX_RESTARTS=5

echo "[boot] Monitoring... (auto-restart enabled, max $MAX_RESTARTS per service)"
while [ ! -f "$STOP_FILE" ]; do
  sleep 15
  for name in $SERVICES; do
    pidfile="$PID_DIR/$name.pid"
    [ -f "$pidfile" ] || continue
    pid=$(cat "$pidfile" 2>/dev/null)
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && continue

    countfile="$PID_DIR/$name.restarts"
    count=$(cat "$countfile" 2>/dev/null || echo 0)

    [ "$count" -ge "$MAX_RESTARTS" ] && {
      echo "[WARN] $name max restarts reached"; continue; }

    echo "[RESTART] $name (attempt $((count + 1))/$MAX_RESTARTS)"
    echo $((count + 1)) > "$countfile"

    case "$name" in
      router)
        "$NODE_BIN" "$BASE_DIR/web/index.js" > "$LOG_DIR/router.log" 2>&1 &
        echo $! > "$pidfile" ;;
      mcsm-daemon)
        bash -c "cd '$BASE_DIR/mcsmanager/daemon' && '$NODE_BIN' $NODE_FLAGS app.js" > "$LOG_DIR/mcsm-daemon.log" 2>&1 &
        echo $! > "$pidfile" ;;
      mcsm-web)
        bash -c "cd '$BASE_DIR/mcsmanager/web' && '$NODE_BIN' $NODE_FLAGS app.js" > "$LOG_DIR/mcsm-web.log" 2>&1 &
        echo $! > "$pidfile" ;;
      middleware)
        "$NODE_BIN" "$BASE_DIR/middleware/server.js" > "$LOG_DIR/middleware.log" 2>&1 &
        echo $! > "$pidfile" ;;
    esac
    sleep 2
  done
done

stop_services
