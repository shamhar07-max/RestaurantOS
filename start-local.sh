#!/usr/bin/env bash
# Local demo deployment for DigitalBurj Restaurant OS.
# Serves the built UI + API together on http://127.0.0.1:3001
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3001}"
export DEMO_MODE=true
export DATA_DIR="${DATA_DIR:-$PWD/data}"
export PORT

# Build the frontend if dist/ is missing.
if [ ! -f dist/index.html ]; then
  echo "Building frontend..."
  npm run build
fi

echo "Starting Restaurant OS on http://127.0.0.1:${PORT} (demo mode)"
exec node server/index.mjs
