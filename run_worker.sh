#!/bin/sh
set -eu
cd "$(dirname "$0")"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

exec /usr/bin/env node hello_travel_lead_worker.js
