#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cadence_directory="${0:A:h}"
cd "$cadence_directory"
if ! command -v node >/dev/null 2>&1; then
  print "Cadence needs Node.js 24 or newer. Install it from https://nodejs.org, then open this file again."
  read -r "?Press Return to close."
  exit 1
fi
print "Keep this Terminal window open while using Cadence. Press Control-C to stop."
exec node src/server.mjs
