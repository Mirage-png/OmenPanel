#!/bin/bash
# Restart All Services

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Restarting All Services ==="
bash "$SCRIPT_DIR/stop.sh"
echo ""
sleep 2
bash "$SCRIPT_DIR/start.sh"
