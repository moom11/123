#!/usr/bin/env bash
#
# Bring the whole MARA system up on one machine, from nothing.
#
#   ./scripts/dev-up.sh          start everything
#   ./scripts/dev-up.sh --reset  drop the database and rebuild it first
#
# Needs: Node 22+, PostgreSQL 16 running locally, npm install already done.
#
set -euo pipefail
cd "$(dirname "$0")/.."

PGUSER_="${PGUSER:-postgres}"
PGPASS_="${PGPASSWORD:-postgres}"
PGHOST_="${PGHOST:-127.0.0.1}"
PGPORT_="${PGPORT:-5432}"
DB="${MARA_DB:-mara}"

export DATABASE_URL="postgres://${PGUSER_}:${PGPASS_}@${PGHOST_}:${PGPORT_}/${DB}"
export PGPASSWORD="$PGPASS_"

# Development secrets. Production sets real ones; see docs/CLOUDFLARE.md.
export NODE_ENV=development
export PORT="${PORT:-4000}"
export REQUIRE_ADMIN_MFA=false
export WHATSAPP_PROVIDER=log
export JWT_ACCESS_SECRET='dev-access-secret-at-least-32-characters-long!!'
export JWT_REFRESH_SECRET='dev-refresh-secret-at-least-32-characters-long!'
export COOKIE_SECRET='dev-cookie-secret-at-least-32-characters-long!!'
export MFA_SECRET_KEY='dev-mfa-key-at-least-32-characters-long-here!!!'
export CORS_ORIGINS='http://localhost:5173,http://localhost:5174,http://localhost:4173,http://localhost:4174'

LOGS=.dev-logs
mkdir -p "$LOGS"
PIDS="$LOGS/pids"
: > "$PIDS"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

stop() {
  [ -f "$PIDS" ] || return 0
  while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$PIDS"
}
trap stop EXIT INT TERM

# --- database ---------------------------------------------------------------
if ! pg_isready -h "$PGHOST_" -p "$PGPORT_" >/dev/null 2>&1; then
  echo "PostgreSQL is not accepting connections on ${PGHOST_}:${PGPORT_}." >&2
  echo "Start it first (e.g. pg_ctlcluster 16 main start) and run this again." >&2
  exit 1
fi

if [ "${1:-}" = "--reset" ]; then
  say "Dropping and recreating ${DB}"
  psql "postgres://${PGUSER_}:${PGPASS_}@${PGHOST_}:${PGPORT_}/postgres" -qtAX \
    -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" -c "CREATE DATABASE ${DB}"
elif ! psql "$DATABASE_URL" -qtAX -c 'select 1' >/dev/null 2>&1; then
  say "Creating ${DB}"
  psql "postgres://${PGUSER_}:${PGPASS_}@${PGHOST_}:${PGPORT_}/postgres" -qtAX \
    -c "CREATE DATABASE ${DB}"
fi

say "Applying migrations"
npm --workspace @mara/server run migrate

if [ "$(psql "$DATABASE_URL" -qtAX -c 'select count(*) from branches')" = "0" ]; then
  say "Seeding"
  npm --workspace @mara/server run seed
else
  echo "already seeded — pass --reset to start over"
fi

# --- build ------------------------------------------------------------------
say "Building"
npm --workspace @mara/shared run build >/dev/null
npm --workspace @mara/server run build >/dev/null
npm --workspace @mara/print-agent run build >/dev/null
[ -f packages/web/dist/index.html ]   || npm --workspace @mara/web run build >/dev/null
[ -f packages/buyer/dist/index.html ] || npm --workspace @mara/buyer run build >/dev/null

# --- run --------------------------------------------------------------------
say "Starting services"

node packages/server/dist/index.js > "$LOGS/api.log" 2>&1 &
echo $! >> "$PIDS"

( cd packages/web   && npx vite preview --port 4173 --host 127.0.0.1 --strictPort ) \
  > "$LOGS/web.log" 2>&1 &
echo $! >> "$PIDS"

( cd packages/buyer && npx vite preview --port 4174 --host 127.0.0.1 --strictPort ) \
  > "$LOGS/buyer.log" 2>&1 &
echo $! >> "$PIDS"

for i in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || {
  echo "API did not come up; see $LOGS/api.log" >&2; tail -20 "$LOGS/api.log" >&2; exit 1;
}

cat <<EOF

  MARA is up.

    POS / admin      http://localhost:4173
    Buyer app        http://localhost:4174
    API              http://localhost:${PORT}
    Health           http://localhost:${PORT}/health

  Sign in
    Owner            owner@maralounge.sa / MaraOwner#2026Xy
    Branch manager   manager@maralounge.sa / MaraManager#2026Xy
    Waiter           1042 / 2580          Cashier   2001 / 4826
    Purchasing rep   4001 / 3648          Bar       3001 / 7192

  The customer QR menu opens without signing in; the table 12 link is printed
  by the seed above.

  Logs are in $LOGS/. Ctrl-C stops everything.

EOF

wait
