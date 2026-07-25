#!/bin/bash
# Service Status Check

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"
PID_DIR="$BASE_DIR/.pids"
LOG_DIR="$BASE_DIR/logs"

echo "============================================"
echo "  Service Status"
echo "============================================"
echo ""

for name in cloudflared router mcsm-daemon mcsm-web pumpkin; do
    pidfile="$PID_DIR/$name.pid"
    pid=$(cat "$pidfile" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        mem=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{printf "%.1f", $1/1024}')
        echo "  [RUNNING] $name  PID=$pid  RAM=${mem}MB"
    else
        echo "  [STOPPED] $name"
    fi
done

echo ""
TUNNEL_URL=$(cat "$LOG_DIR/tunnel-url.txt" 2>/dev/null)
if [ -n "$TUNNEL_URL" ]; then
    echo "  Tunnel URL: $TUNNEL_URL"
else
    echo "  Tunnel URL: (not available)"
fi
echo "  PumpkinMC:  localhost:25565"
echo ""
echo "============================================"
