#!/bin/bash
# Stop all services managed by supervisor.sh
set -e
BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$BASE_DIR/.pids"

# Find supervisor
SUPERVISOR_PID=""
if [ -f "$PID_DIR/supervisor.pid" ]; then
  SUPERVISOR_PID=$(cat "$PID_DIR/supervisor.pid")
fi
if [ -z "$SUPERVISOR_PID" ] || ! kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
  SUPERVISOR_PID=$(pgrep -f "supervisor.sh" | head -1)
fi

if [ -n "$SUPERVISOR_PID" ]; then
  echo "Sending SIGUSR1 to supervisor (PID: $SUPERVISOR_PID)..."
  kill -SIGUSR1 "$SUPERVISOR_PID"
  sleep 2
else
  # Direct kill
  echo "Supervisor not found, killing services directly..."
  for name in cloudflared router mcsm-daemon mcsm-web middleware; do
    pidfile="$PID_DIR/$name.pid"
    [ -f "$pidfile" ] || continue
    pid=$(cat "$pidfile" 2>/dev/null)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "  Stopped $name"
    rm -f "$pidfile"
  done
fi

rm -f "$PID_DIR/.stop"
echo "All services stopped."
