#!/bin/bash
# Entry point - starts all services via supervisor
# Cloudflared tunnel exposes the stack to the internet

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/supervisor.sh"
