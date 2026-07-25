#!/bin/bash
# Start All Services (delegates to supervisor)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/supervisor.sh"
