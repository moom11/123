#!/usr/bin/env bash
#
# Put MARA on Cloudflare, in one command.
#
#   export DATABASE_URL='postgres://user:pass@host/mara?sslmode=require'
#   ./scripts/deploy-cloudflare.sh
#
# It creates what is missing and leaves alone what is already there, so it is
# safe to run again: the second run is an upgrade, not a rebuild. In
# particular it never rotates a secret that already exists — doing so would
# sign out every terminal and invalidate every enrolled second factor.
#
# Two things it cannot do for you, both because they are decisions about your
# account and its bill:
#
#   * `wrangler login`  — a token is a key to your account.
#   * the Workers PAID plan and R2, enabled once in the dashboard.
#
# Everything else below is automatic. See docs/CLOUDFLARE.md for the why.
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# The pinned wrangler from this repo, not whatever npx would fetch: a deploy
# that silently changes tool version between two runs is a deploy you cannot
# reason about.
WRANGLER="npx wrangler"
HYPERDRIVE_NAME="${MARA_HYPERDRIVE_NAME:-mara-db}"
BUCKET="${MARA_R2_BUCKET:-mara-attachments}"
CONFIG=packages/server/wrangler.jsonc

# --- 0. The two things only you can do ---------------------------------------

say "Checking your Cloudflare session"
# Tested on the text, not the exit code: `wrangler whoami` prints "You are not
# authenticated" and exits 0, so an exit-status check waves an unauthenticated
# run straight through to fail later and less clearly.
WHOAMI="$($WRANGLER whoami 2>&1 || true)"
if printf '%s' "$WHOAMI" | grep -qi 'not authenticated\|Unable to retrieve'; then
  die "Not signed in to Cloudflare.

  On a machine with a browser:   npx wrangler login
  On a server or CI:             export CLOUDFLARE_API_TOKEN=...
                                 export CLOUDFLARE_ACCOUNT_ID=...

  The token needs Workers Scripts: Edit, Workers R2 Storage: Edit,
  Hyperdrive: Edit and Account Settings: Read.
  Create it at dash.cloudflare.com → My Profile → API Tokens."
fi
printf '%s\n' "$WHOAMI" | grep -i 'account name\|account id' || true

# --- 1. The database ----------------------------------------------------------
# Cloudflare hosts no PostgreSQL, so this is your database at your provider,
# reached directly from here. The Worker reaches it through Hyperdrive.

[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set.

  Cloudflare does not host PostgreSQL. Create one at Neon, Supabase, RDS or
  Cloud SQL, then:

    export DATABASE_URL='postgres://user:pass@host/mara?sslmode=require'"

say "Applying migrations"
npm --workspace @mara/server run migrate

# Always, not only on a fresh install: the role/permission matrix lives in code
# and an upgrade that adds a permission ships a screen nobody can open until
# the database has heard of it.
say "Syncing the role and permission matrix"
npm --workspace @mara/server run sync-permissions

if [ "${MARA_SEED:-auto}" != "skip" ]; then
  say "Seeding (only fills an empty database)"
  npm --workspace @mara/server run seed
fi

# --- 2. Hyperdrive ------------------------------------------------------------
# Created with caching disabled, and that is not a tuning choice: Hyperdrive
# does not invalidate cached reads when the application writes, and this is a
# point of sale. A stale stock level or order status is a wrong answer.

say "Hyperdrive"
hyperdrive_id() {
  $WRANGLER hyperdrive list --json 2>/dev/null \
    | node -e "
        let raw = '';
        process.stdin.on('data', (c) => { raw += c; });
        process.stdin.on('end', () => {
          try {
            const list = JSON.parse(raw);
            const found = (Array.isArray(list) ? list : list.result ?? [])
              .find((c) => c.name === process.argv[1]);
            if (found) process.stdout.write(found.id);
          } catch { /* no config yet, or an older wrangler with no --json */ }
        });
      " "$HYPERDRIVE_NAME"
}

ID="$(hyperdrive_id || true)"
if [ -z "$ID" ]; then
  echo "  creating '$HYPERDRIVE_NAME' with caching disabled"
  $WRANGLER hyperdrive create "$HYPERDRIVE_NAME" \
    --connection-string="$DATABASE_URL" --caching-disabled >/dev/null \
    || die "Could not create the Hyperdrive config.

  If it says the connection string is unreachable, check that your database
  allows connections from outside its own network, and that the URL carries a
  password and ?sslmode=require."
  ID="$(hyperdrive_id || true)"
fi
[ -n "$ID" ] || die "Created the Hyperdrive config but could not read its id back.
  Run: npx wrangler hyperdrive list
  Then put the id into $CONFIG under hyperdrive[0].id and run this again."
echo "  id $ID"

# The id names a config; it is not a credential — your connection string stays
# on Cloudflare's side — so it is safe to commit.
node -e '
  const fs = require("fs");
  const [file, id] = process.argv.slice(1);
  const before = fs.readFileSync(file, "utf8");
  // Rewritten inside the hyperdrive block only. A bare /"id":/ would hit
  // whatever binding happens to be declared first the day someone adds one.
  const after = before.replace(
    /("hyperdrive"\s*:\s*\[[\s\S]*?"id"\s*:\s*")[^"]*(")/,
    `$1${id}$2`);
  if (after === before) {
    console.error(`  could not write the id into ${file} — set hyperdrive[0].id by hand`);
    process.exit(1);
  }
  fs.writeFileSync(file, after);
' "$CONFIG" "$ID"

# --- 3. R2 --------------------------------------------------------------------
# Purchase invoices photographed by the buyer, waste evidence.

say "R2 bucket"
if $WRANGLER r2 bucket list 2>/dev/null | grep -q "$BUCKET"; then
  echo "  $BUCKET already exists"
elif $WRANGLER r2 bucket create "$BUCKET" >/dev/null 2>&1; then
  echo "  created $BUCKET"
else
  die "Could not create the R2 bucket '$BUCKET'.

  R2 is enabled once, by hand, in the dashboard — Workers alone does not
  enable it: dash.cloudflare.com → R2 → Enable. Then run this again."
fi

# --- 4. Secrets ---------------------------------------------------------------
# Generated here rather than chosen by anyone, and never regenerated: a new
# MFA_SECRET_KEY makes every stored second factor undecryptable, and a new JWT
# secret signs out every terminal mid-shift.

say "Secrets"
existing="$( (cd packages/server && $WRANGLER secret list 2>/dev/null) || echo '[]' )"
for name in JWT_ACCESS_SECRET JWT_REFRESH_SECRET COOKIE_SECRET MFA_SECRET_KEY; do
  if printf '%s' "$existing" | grep -q "\"$name\""; then
    echo "  $name already set — left alone"
  else
    echo "  generating $name"
    openssl rand -base64 48 | (cd packages/server && $WRANGLER secret put "$name" >/dev/null)
  fi
done
cat <<'NOTE'

  WhatsApp is not set here because it needs your business account:
    cd packages/server
    npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
    npx wrangler secret put WHATSAPP_ACCESS_TOKEN
  Without them, customer discount codes and points redemption cannot be sent.
NOTE

# --- 5. Refuse to open with published credentials -----------------------------

if [ "${SKIP_PREFLIGHT:-}" != "true" ]; then
  say "Checking the branch is safe to open with"
  # The seed's passwords and staff PINs are printed in this public repository.
  # Preflight verifies the stored hashes against them and refuses while any
  # still match. SKIP_PREFLIGHT=true for a staging deployment.
  npm --workspace @mara/server run preflight \
    || die "Preflight refused. Fix what it listed, then run this again.
  (SKIP_PREFLIGHT=true to deploy a staging environment anyway.)"
fi

# --- 6. Deploy ----------------------------------------------------------------

say "Building the POS app (it ships inside the API Worker)"
npm --workspace @mara/shared run build >/dev/null
npm --workspace @mara/web run build

say "Deploying the API + POS app"
( cd packages/server && $WRANGLER deploy ) || die "Deploy failed.

  If the error mentions CPU limits or the account plan: this Worker needs the
  Workers PAID plan. Argon2id password verification measures ~1.4 s of CPU on
  workerd against a 10 ms free-plan ceiling, so every login would be killed
  mid-verification. Lowering the Argon2 cost is not the fix — it is what makes
  a stolen hash expensive to attack."

# The buyer app is a separate Worker on separate devices, and reaches the API
# by absolute URL baked in at build time.
API_HOST="${MARA_API_HOST:-}"
if [ -z "$API_HOST" ]; then
  API_HOST="$( (cd packages/server && $WRANGLER deployments list --json 2>/dev/null) \
    | node -e "let r='';process.stdin.on('data',c=>r+=c);process.stdin.on('end',()=>{
        try { const d=JSON.parse(r); const u=(Array.isArray(d)?d:d.result??[])[0]?.url;
              if (u) process.stdout.write(new URL(u).host); } catch {} })" || true)"
fi
[ -n "$API_HOST" ] || die "Deployed the API, but could not work out its hostname for the buyer app.
  Re-run with e.g. MARA_API_HOST=mara-api.<your-account>.workers.dev"

say "Building and deploying the buyer app"
VITE_API_BASE="https://${API_HOST}" npm --workspace @mara/buyer run build
( cd packages/buyer && $WRANGLER deploy )

cat <<EOF

  Deployed.

    POS / admin / QR menu   https://${API_HOST}
    Buyer app               (the URL wrangler printed for mara-buyer)

  On each iPad: open the POS URL in Safari, then Share -> Add to Home Screen.

  Still yours to do, and the venue cannot open without them:
    1. Change the owner password and every staff PIN, from the Users screen.
    2. Put the real printer IP addresses in, from the Printers screen.
    3. Register the till with ZATCA, from the Devices screen.
    4. Run the print agent on a machine INSIDE the venue — it cannot live in
       the cloud, because the printers speak ESC/POS on your own LAN:

       MARA_API_URL=https://${API_HOST} \\
       MARA_AGENT_TOKEN=<the token the seed printed> \\
       node packages/print-agent/dist/index.js

EOF
