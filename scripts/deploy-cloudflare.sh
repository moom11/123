#!/usr/bin/env bash
#
# Deploy MARA to Cloudflare.
#
#   MARA_API_HOST=mara-api.example.workers.dev ./scripts/deploy-cloudflare.sh
#
# Prerequisites, all one-time — see docs/CLOUDFLARE.md:
#   * a Workers PAID plan (Argon2id needs ~1.4s CPU; the free ceiling is 10ms)
#   * a PostgreSQL database, migrated and seeded
#   * a Hyperdrive config created with --caching-disabled, its id in
#     packages/server/wrangler.jsonc
#   * an R2 bucket named mara-attachments
#   * the six secrets set with `wrangler secret put`
#
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if grep -q 'REPLACE_WITH_HYPERDRIVE_ID' packages/server/wrangler.jsonc; then
  echo "Set the Hyperdrive id in packages/server/wrangler.jsonc first:" >&2
  echo "  npx wrangler hyperdrive create mara-db --connection-string=... --caching-disabled" >&2
  exit 1
fi

say "Building the POS app (shipped inside the API Worker)"
npm --workspace @mara/shared run build >/dev/null
npm --workspace @mara/web run build

say "Deploying the API + POS app"
( cd packages/server && npx wrangler deploy )

say "Building the buyer app"
if [ -z "${MARA_API_HOST:-}" ]; then
  echo "MARA_API_HOST is not set, so the buyer app will not know where the API" >&2
  echo "is. Re-run with e.g. MARA_API_HOST=mara-api.<account>.workers.dev" >&2
  exit 1
fi
VITE_API_BASE="https://${MARA_API_HOST}" npm --workspace @mara/buyer run build

say "Deploying the buyer app"
( cd packages/buyer && npx wrangler deploy )

cat <<EOF

  Deployed.

    POS / admin / QR menu   https://${MARA_API_HOST}
    Buyer app               (the URL wrangler printed for mara-buyer)

  On each iPad: open the POS URL in Safari, then Share → Add to Home Screen.
  It then runs full-screen like an app.

  The print agent does NOT go to Cloudflare. It runs on a small PC or
  Raspberry Pi inside the venue, on the same network as the printers:

    MARA_API_URL=https://${MARA_API_HOST} \\
    MARA_AGENT_TOKEN=<agent token> \\
    node packages/print-agent/dist/index.js

EOF
