#!/bin/bash
# Supervisor: starts all services with auto-restart, survives shell timeout.
# Stop via: kill -SIGUSR1 <supervisor_pid>   (or pkill -f supervisor.sh)

set -u

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$BASE_DIR/node-v20.11.0-linux-x64/bin/node"
CLOUDFLARED_BIN="/tmp/cloudflared"
PID_DIR="$BASE_DIR/.pids"
LOG_DIR="$BASE_DIR/logs"
STOP_FILE="$PID_DIR/.stop"
TUNNEL_LOG="$LOG_DIR/cloudflared.log"
TUNNEL_URL_FILE="$LOG_DIR/tunnel-url.txt"
NODE_FLAGS="--max-old-space-size=1024 --optimize-for-size --gc-interval=100 --max-semi-space-size=64 --enable-source-maps"
SERVICES="cloudflared router mcsm-daemon mcsm-web middleware"

export PATH="$BASE_DIR/node-v20.11.0-linux-x64/bin:$PATH"
mkdir -p "$PID_DIR" "$LOG_DIR"

# Determine Replit URL
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
# Will be overridden by tunnel URL if cloudflared starts

# ── 1. Start cloudflared (auto-restart loop) ────────────────────────
echo "[1/5] Starting cloudflared tunnel..."
rm -f "$TUNNEL_URL_FILE"
TUNNEL_URL=""
setsid bash -c '
while true; do
  /tmp/cloudflared tunnel --url http://127.0.0.1:3000 --no-autoupdate > '"$TUNNEL_LOG"' 2>&1
  sleep 2
done
' > /dev/null 2>&1 &
echo $! > "$PID_DIR/cloudflared.pid"

echo "  Waiting for tunnel URL..."
TRIES=0
while [ $TRIES -lt 60 ] && [ ! -f "$STOP_FILE" ]; do
  if [ -f "$TUNNEL_LOG" ]; then
    TUNNEL_URL=$(grep -oP 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1)
    if [ -n "$TUNNEL_URL" ]; then
      echo "$TUNNEL_URL" > "$TUNNEL_URL_FILE"
      REMOTE_HOST=$(echo "$TUNNEL_URL" | sed 's|https://||')
      break
    fi
  fi
  sleep 0.5; TRIES=$((TRIES + 1))
done

if [ -n "$TUNNEL_URL" ]; then
  echo "  Tunnel URL: $TUNNEL_URL"
else
  echo "  [WARN] Tunnel not ready, using Replit URL"
  TUNNEL_URL="https://$REMOTE_HOST"
fi

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
  setsid "$@" > "$logfile" 2>&1 &
  echo $! > "$pidfile"
}

echo "[2/5] Starting local router..."
start_service router "$NODE_BIN" "$BASE_DIR/web/index.js"
sleep 1

echo "[3/5] Starting MCSManager daemon..."
start_service mcsm-daemon bash -c "cd '$BASE_DIR/mcsmanager/daemon' && '$NODE_BIN' $NODE_FLAGS app.js"
sleep 3

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
echo "  Web Panel:     $TUNNEL_URL  (login: admin / Admin123!)"
echo "  Stop via: kill -SIGUSR1 $$"; echo ""

# ── Monitor + auto-restart ────────────────────────────────────────
declare -A RESTART_COUNTS
MAX_RESTARTS=5

echo "[boot] Monitoring... (auto-restart enabled, max $MAX_RESTARTS per service)"
while [ ! -f "$STOP_FILE" ]; do
  sleep 15
  for name in $SERVICES; do
    pidfile="$PID_DIR/$name.pid"
    [ -f "$pidfile" ] || continue
    pid=$(cat "$pidfile" 2>/dev/null)
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && continue

    [ "${RESTART_COUNTS[$name]:-0}" -ge "$MAX_RESTARTS" ] && {
      echo "[WARN] $name max restarts reached"; continue; }

    echo "[RESTART] $name (attempt $((RESTART_COUNTS[$name] + 1))/$MAX_RESTARTS)"
    RESTART_COUNTS[$name]=$((RESTART_COUNTS[$name] + 1))

    case "$name" in
      cloudflared)
        setsid bash -c '
          while true; do
            /tmp/cloudflared tunnel --url http://127.0.0.1:3000 --no-autoupdate > '"$TUNNEL_LOG"' 2>&1
            sleep 2
          done
        ' > /dev/null 2>&1 &
        echo $! > "$pidfile" ;;
      router)
        setsid "$NODE_BIN" "$BASE_DIR/web/index.js" > "$LOG_DIR/router.log" 2>&1 &
        echo $! > "$pidfile" ;;
      mcsm-daemon)
        setsid bash -c "cd '$BASE_DIR/mcsmanager/daemon' && '$NODE_BIN' $NODE_FLAGS app.js" > "$LOG_DIR/mcsm-daemon.log" 2>&1 &
        echo $! > "$pidfile" ;;
      mcsm-web)
        setsid bash -c "cd '$BASE_DIR/mcsmanager/web' && '$NODE_BIN' $NODE_FLAGS app.js" > "$LOG_DIR/mcsm-web.log" 2>&1 &
        echo $! > "$pidfile" ;;
      middleware)
        setsid "$NODE_BIN" "$BASE_DIR/middleware/server.js" > "$LOG_DIR/middleware.log" 2>&1 &
        echo $! > "$pidfile" ;;
    esac
    sleep 2
  done
done

stop_services
