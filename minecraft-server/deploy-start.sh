#!/bin/bash
set -u
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$BASE_DIR/node-v20.11.0-linux-x64/bin/node"
LOG_DIR="$BASE_DIR/logs"
mkdir -p "$LOG_DIR"

echo "Deploying OmenHosting..."

# Start all services (no SSH tunnel in deployment)
# Router
"$NODE" "$BASE_DIR/web/index.js" &
sleep 1

# Daemon
setsid bash -c "cd '$BASE_DIR/mcsmanager/daemon' && '$NODE' --max-old-space-size=1024 app.js" > "$LOG_DIR/mcsm-daemon.log" 2>&1 &
sleep 3

# Web panel
setsid bash -c "cd '$BASE_DIR/mcsmanager/web' && '$NODE' --max-old-space-size=1024 app.js" > "$LOG_DIR/mcsm-web.log" 2>&1 &
sleep 2

# Middleware
"$NODE" "$BASE_DIR/middleware/server.js" > "$LOG_DIR/middleware.log" 2>&1 &

echo "Deployment started. Monitoring..."

# Keep alive
while true; do sleep 30; done