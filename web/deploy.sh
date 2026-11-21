#!/usr/bin/env bash
# Build and deploy to Cloudflare, then wait until the geometry container answers
# on the current version (GEOMETRY_VERSION in worker/geometry.ts).
set -euo pipefail
cd "$(dirname "$0")"
npm run build
sg docker -c "npx wrangler deploy --containers-rollout immediate"
want=$(grep -o "GEOMETRY_VERSION = '[^']*'" worker/geometry.ts | cut -d"'" -f2)
# Give the rollout a minute before anything starts a container on the new name.
sleep 60
for _ in $(seq 1 20); do
  h=$(curl -s -m 120 https://merry.beenex.company/api/health || true)
  if echo "$h" | grep -q "\"version\":\"$want\""; then echo "live: $h"; exit 0; fi
  echo "waiting for geometry $want: $h"
  sleep 20
done
echo "geometry container never reported $want" >&2
exit 1
