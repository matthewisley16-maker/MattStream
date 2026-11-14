#!/usr/bin/env bash
# MattStream launcher for macOS and Linux
set -e
cd "$(dirname "$0")"

if [ -x "node_modules/electron/dist/electron" ]; then
  exec node_modules/electron/dist/electron . "$@"
fi

if command -v node >/dev/null 2>&1; then
  exec node server/index.js --open "$@"
fi

echo
echo "  MattStream needs Node.js. Install the LTS build from https://nodejs.org"
echo
exit 1
