#!/usr/bin/env bash
# تثبيت نظام الموارد البشرية على خادم Ubuntu 22.04/24.04 كخدمة نظام
# الاستخدام:  sudo bash deploy/install-ubuntu.sh hr.example.com
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/hr
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then echo "شغّل السكربت بصلاحية root (sudo)"; exit 1; fi

echo "==> تثبيت المتطلبات"
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip nginx rsync

echo "==> نسخ الملفات إلى $APP_DIR"
id -u hr >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin hr
mkdir -p "$APP_DIR"
rsync -a --delete --exclude .venv --exclude data --exclude .git "$REPO_DIR/" "$APP_DIR/"
mkdir -p "$APP_DIR/data"

echo "==> إنشاء البيئة الافتراضية وتثبيت الحزم"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip -q
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" -q

if [ ! -f /etc/hr.env ]; then
  echo "==> إنشاء /etc/hr.env بمفتاح وكلمة مرور عشوائية"
  ADMIN_PASS="$(head -c 9 /dev/urandom | base64 | tr -d '/+=')"
  cat > /etc/hr.env <<ENV
HR_SECRET_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '/+=')
HR_ADMIN_PASSWORD=${ADMIN_PASS}
HR_AUTO_SYNC_MINUTES=0
ENV
  chmod 600 /etc/hr.env
  echo "    كلمة مرور المدير الأولى: ${ADMIN_PASS}"
fi

echo "==> تهيئة قاعدة البيانات"
set -a; . /etc/hr.env; set +a
HR_DATA_DIR="$APP_DIR/data" PYTHONPATH="$APP_DIR/backend" "$APP_DIR/.venv/bin/python" -m app.seed
chown -R hr:hr "$APP_DIR"

echo "==> تسجيل الخدمة"
cp "$APP_DIR/deploy/hr.service" /etc/systemd/system/hr.service
systemctl daemon-reload
systemctl enable --now hr
systemctl restart hr

if [ -n "$DOMAIN" ]; then
  echo "==> إعداد Nginx للنطاق $DOMAIN"
  sed "s/hr.example.com/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/hr
  ln -sf /etc/nginx/sites-available/hr /etc/nginx/sites-enabled/hr
  rm -f /etc/nginx/sites-enabled/default
  # شهادة SSL (مطلوبة لعمل تحديد الموقع على الجوالات)
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email || \
    echo "    تعذر إصدار الشهادة تلقائياً - أصدرها يدوياً: certbot --nginx -d $DOMAIN"
  nginx -t && systemctl reload nginx
  echo "==> جاهز: https://$DOMAIN"
else
  echo "==> جاهز على http://<عنوان-الخادم>:8000 (مرّر النطاق للسكربت لإعداد HTTPS)"
fi

echo "==> حالة الخدمة:"; systemctl --no-pager --lines=5 status hr || true
