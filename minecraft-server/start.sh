#!/bin/bash
set -u
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$BASE_DIR/node-v20.11.0-linux-x64/bin/node"
LOG_DIR="$BASE_DIR/logs"
PID_DIR="$BASE_DIR/.pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

echo "Starting OmenHosting supervisor..."

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

start_service() {
  local name="$1"
  local cmd="$2"
  local pidf="$PID_DIR/$name.pid"
  local logf="$LOG_DIR/$name.log"
  eval "$cmd" >> "$logf" 2>&1 &
  echo $! > "$pidf"
  echo "  Started $name (PID $!)"
}

stop_service() {
  local name="$1"
  local pidf="$PID_DIR/$name.pid"
  [ -f "$pidf" ] || return
  local pid=$(cat "$pidf")
  kill "$pid" 2>/dev/null; sleep 0.3; kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  rm -f "$pidf"
  echo "  Stopped $name"
}

# Start all services
echo "[1] Starting services..."
start_service router "setsid $NODE $BASE_DIR/web/index.js"
sleep 1
start_service mcsm-daemon "setsid bash -c \"cd $BASE_DIR/mcsmanager/daemon && $NODE --max-old-space-size=1024 app.js\""
sleep 3
start_service mcsm-web "setsid bash -c \"cd $BASE_DIR/mcsmanager/web && $NODE --max-old-space-size=1024 app.js\""
sleep 2
start_service middleware "setsid $NODE $BASE_DIR/middleware/server.js"

# Start SSH tunnel
TUNNEL_URL_FILE="$LOG_DIR/tunnel-url.txt"
rm -f "$TUNNEL_URL_FILE"
echo "[2] Starting SSH tunnel..."
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 80:localhost:3000 nokey@localhost.run > "$LOG_DIR/ssh-tunnel.log" 2>&1 &
SSH_PID=$!
echo $SSH_PID > "$PID_DIR/ssh.pid"
echo "  Started SSH tunnel (PID $SSH_PID)"

# Wait for tunnel URL
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.lhr\.life' "$LOG_DIR/ssh-tunnel.log" 2>/dev/null | head -1)
  if [ -n "$TUNNEL_URL" ]; then
    echo "$TUNNEL_URL" > "$TUNNEL_URL_FILE"
    REMOTE_HOST=$(echo "$TUNNEL_URL" | sed 's|https://||')
    echo "  Tunnel URL: $TUNNEL_URL"
    # Update remoteMappings
    "$NODE" -e "
const fs = require('fs');
const p = '$BASE_DIR/mcsmanager/web/data/RemoteServiceConfig/8912fa8ad2c947b183e6f783558e9f21.json';
try {
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg.ip = '127.0.0.1'; cfg.port = 24444; cfg.prefix = '';
  cfg.remoteMappings = [{ from: { ip: '$REMOTE_HOST', port: 443, prefix: '/' }, to: { ip: 'wss://$REMOTE_HOST', port: 443, prefix: '' } }];
  cfg.connectOpts = cfg.connectOpts || {};
  cfg.connectOpts.multiplex = false; cfg.connectOpts.reconnectionDelayMax = 5000;
  cfg.connectOpts.timeout = 10000; cfg.connectOpts.reconnection = true;
  cfg.connectOpts.reconnectionAttempts = 10; cfg.connectOpts.rejectUnauthorized = false;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 4));
  console.log('  remoteMappings updated for', '$REMOTE_HOST');
} catch(e) { console.error('  Config update failed:', e.message); }
" 2>&1
    break
  fi
  sleep 0.5
done

echo ""
echo "============================================"
echo "  Monitoring $(ls "$PID_DIR"/*.pid 2>/dev/null | wc -l) services..."
echo "============================================"

# Monitoring loop — never exits
RESTART_COUNTS=""
while true; do
  sleep 10

  # Check SSH tunnel (special handling — restart gets new URL)
  if [ -f "$PID_DIR/ssh.pid" ]; then
    pid=$(cat "$PID_DIR/ssh.pid")
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[RESTART] SSH tunnel (died)"
      rm -f "$PID_DIR/ssh.pid"
      ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 80:localhost:3000 nokey@localhost.run > "$LOG_DIR/ssh-tunnel.log" 2>&1 &
      SSH_PID=$!
      echo $SSH_PID > "$PID_DIR/ssh.pid"
      # Wait for new URL
      for i in $(seq 1 30); do
        NEW_URL=$(grep -oP 'https://[a-z0-9-]+\.lhr\.life' "$LOG_DIR/ssh-tunnel.log" 2>/dev/null | head -1)
        if [ -n "$NEW_URL" ]; then
          echo "$NEW_URL" > "$TUNNEL_URL_FILE"
          echo "  New URL: $NEW_URL"
          break
        fi
        sleep 0.5
      done
    fi
  fi

  # Check other services
  for name in router mcsm-daemon mcsm-web middleware; do
    pidf="$PID_DIR/$name.pid"
    [ -f "$pidf" ] || continue
    pid=$(cat "$pidf")
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[RESTART] $name (died)"
      rm -f "$pidf"
      case "$name" in
        router) start_service router "setsid $NODE $BASE_DIR/web/index.js" ;;
        mcsm-daemon) start_service mcsm-daemon "setsid bash -c \"cd $BASE_DIR/mcsmanager/daemon && $NODE --max-old-space-size=1024 app.js\"" ;;
        mcsm-web) start_service mcsm-web "setsid bash -c \"cd $BASE_DIR/mcsmanager/web && $NODE --max-old-space-size=1024 app.js\"" ;;
        middleware) start_service middleware "setsid $NODE $BASE_DIR/middleware/server.js" ;;
      esac
    fi
  done
done