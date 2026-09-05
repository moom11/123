#!/usr/bin/env bash
#
# Turn a bare Ubuntu server into MARA, in one command.
#
#   curl -fsSL <raw-url>/scripts/install.sh | sudo bash
#   # or, from a clone:
#   sudo bash scripts/install.sh
#
# What it does: installs Node 22, PostgreSQL 16, nginx and Caddy-free TLS via
# certbot; creates the database and a role; generates real secrets; builds the
# app; installs a systemd unit; and puts nginx in front so the API and the PWA
# share one origin (which is what makes the app's relative /api work, and what
# keeps the websocket on wss:// without any configuration).
#
# It is idempotent: run it again after a git pull to deploy an update.
#
# It deliberately does NOT: invent a domain, invent printer addresses, or
# pretend to have credentials it cannot have. Those are prompted for or left
# for the operator, because a system that guesses them fails silently later.

set -euo pipefail

APP_USER="${APP_USER:-mara}"
APP_DIR="${APP_DIR:-/opt/mara}"
DB_NAME="${DB_NAME:-mara}"
DB_USER="${DB_USER:-mara}"
PORT="${PORT:-4000}"
DOMAIN="${DOMAIN:-}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m ✗  %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "شغّله بـ sudo"

# --- Packages ---------------------------------------------------------------
log "تثبيت الحزم"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git nginx postgresql postgresql-contrib ufw >/dev/null

if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  log "تثبيت Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

# --- Database ---------------------------------------------------------------
log "تهيئة قاعدة البيانات"
systemctl enable --now postgresql >/dev/null 2>&1 || true

DB_PASS_FILE="/etc/mara/db-password"
mkdir -p /etc/mara && chmod 700 /etc/mara
if [ ! -f "$DB_PASS_FILE" ]; then
  openssl rand -base64 36 | tr -d '\n/+=' | head -c 40 > "$DB_PASS_FILE"
  chmod 600 "$DB_PASS_FILE"
fi
DB_PASS="$(cat "$DB_PASS_FILE")"

sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
sudo -u postgres psql -qc "ALTER ROLE $DB_USER PASSWORD '$DB_PASS'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"

# --- Application user and code ----------------------------------------------
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

if [ ! -d "$APP_DIR/.git" ]; then
  log "استنساخ الكود"
  REPO="${REPO:-https://github.com/moom11/123.git}"
  BRANCH="${BRANCH:-claude/mara-lounge-management-system-tlrc2b}"
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$APP_DIR"
else
  log "تحديث الكود"
  git -C "$APP_DIR" fetch --depth 1 origin
  git -C "$APP_DIR" reset --hard "origin/$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)"
fi

# --- Secrets ----------------------------------------------------------------
# Generated once and kept. Regenerating JWT secrets logs every device out, and
# regenerating MFA_SECRET_KEY makes every enrolled authenticator unreadable —
# so an update must never silently mint new ones.
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  log "توليد الأسرار"
  gen() { openssl rand -base64 48 | tr -d '\n'; }
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
PORT=$PORT
HOST=127.0.0.1

DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
DB_POOL_MAX=10
DB_SSL=false

JWT_ACCESS_SECRET=$(gen)
JWT_REFRESH_SECRET=$(gen)
COOKIE_SECRET=$(gen)
MFA_SECRET_KEY=$(gen)

REQUIRE_ADMIN_MFA=true
MFA_ISSUER=MARA Lounge

# املأ هذه من حساب واتساب للأعمال قبل استخدام خصومات العملاء أو النقاط.
# 'log' يرفض العمل في الإنتاج عمداً — الرمز لن يصل العميل.
WHATSAPP_PROVIDER=meta_cloud
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_API_VERSION=v21.0
WHATSAPP_OTP_TEMPLATE=mara_otp
WHATSAPP_TEMPLATE_LANGUAGE=ar

# نفس الأصل، فلا CORS ولا عنوان مكتوب في الواجهة.
CORS_ORIGINS=${DOMAIN:+https://$DOMAIN}
ENV
  chmod 600 "$ENV_FILE"
else
  warn "‏.env موجود — لم تُولَّد أسرار جديدة (توليدها يُخرج كل الأجهزة ويُعطّل التحقق الثنائي)"
fi

# --- Build ------------------------------------------------------------------
log "بناء التطبيق"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null
npm --workspace @mara/shared run build >/dev/null
npm --workspace @mara/server run build >/dev/null
npm --workspace @mara/web run build >/dev/null

log "تطبيق الهجرات"
set -a; . "$ENV_FILE"; set +a
npm --workspace @mara/server run migrate

# The seed is idempotent and only fills an empty database.
if [ "$(sudo -u postgres psql -tAd "$DB_NAME" -c 'SELECT count(*) FROM branches' 2>/dev/null || echo 0)" = "0" ]; then
  log "تهيئة البيانات الأولية"
  npm --workspace @mara/server run seed | tee /etc/mara/seed-output.txt
  chmod 600 /etc/mara/seed-output.txt
  warn "بيانات الدخول ورموز الأجهزة في /etc/mara/seed-output.txt — اقرأها ثم احذفها"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# --- Service ----------------------------------------------------------------
log "تركيب الخدمة"
cat > /etc/systemd/system/mara.service <<UNIT
[Unit]
Description=MARA Lounge API
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/packages/server
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=3
# A POS that dies at midnight on a full disk is worse than one that is slow.
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$APP_DIR

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable mara >/dev/null
systemctl restart mara

# --- nginx ------------------------------------------------------------------
# One origin for the PWA and the API. This is what makes the app's relative
# /api work everywhere, and what keeps the websocket on wss:// with no
# configuration — the two things that broke on shared hosting.
log "تهيئة nginx"
cat > /etc/nginx/sites-available/mara <<NGINX
server {
  listen 80;
  server_name ${DOMAIN:-_};

  root $APP_DIR/packages/web/dist;
  index index.html;
  client_max_body_size 20m;

  # The API and the websocket, on the same origin as the app.
  location /api/ {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 120s;
  }

  location /ws {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    # A live board must not be cut off every 60 seconds.
    proxy_read_timeout 3600s;
  }

  location /health { proxy_pass http://127.0.0.1:$PORT; }

  # Hashed assets never change; the shell must not be cached or an update
  # never reaches a till that has the old one.
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
  location = /index.html { add_header Cache-Control "no-store"; }
  location = /sw.js { add_header Cache-Control "no-store"; }

  # Client-side routes exist only in the browser.
  location / { try_files \$uri \$uri/ /index.html; }
}
NGINX

ln -sf /etc/nginx/sites-available/mara /etc/nginx/sites-enabled/mara
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null && systemctl reload nginx

# --- Firewall ---------------------------------------------------------------
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
yes | ufw enable >/dev/null 2>&1 || true

# --- TLS --------------------------------------------------------------------
# Without HTTPS the browser blocks the websocket from an https page and the
# PWA will not install. With a domain this is one command; without one it has
# to wait, and the script says so rather than pretending.
if [ -n "$DOMAIN" ]; then
  log "إصدار شهادة TLS لـ $DOMAIN"
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect || warn "تعذّر إصدار الشهادة — راجع أن النطاق يشير إلى هذا الخادم"
else
  warn "لم يُحدَّد نطاق (DOMAIN=) — يعمل على HTTP فقط، والتحديث المباشر لن يعمل من صفحة https"
fi

# --- Verify -----------------------------------------------------------------
log "التحقق"
sleep 2
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  curl -sS "http://127.0.0.1:$PORT/health"
  echo
  printf '\n\033[1;32m✓ النظام يعمل\033[0m\n'
else
  die "الخدمة لا تستجيب — اقرأ: journalctl -u mara -n 50"
fi

cat <<DONE

الخطوات المتبقية — لا يستطيع هذا السكربت أياً منها:

  1. غيّر كلمات المرور والرموز السرية المنشورة (شاشة المستخدمين).
  2. ضع عناوين الطابعات الحقيقية (شاشة الطابعات).
  3. سجّل جهاز الكاشير لدى هيئة الزكاة (شاشة الأجهزة → CSR ثم رمز بوابة فاتورة).
  4. املأ بيانات واتساب في .env إن أردت خصومات العملاء والنقاط.
  5. شغّل الفحص:  cd $APP_DIR && npm --workspace @mara/server run preflight

أوامر تحتاجها:
  systemctl status mara          حالة الخدمة
  journalctl -u mara -f          السجل الحي
  sudo bash scripts/install.sh   تحديث بعد git pull

DONE
