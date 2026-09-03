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

rm -f /etc/nginx/sites-enabled/default

if [ -n "$DOMAIN" ]; then
  echo "==> إعداد Nginx للنطاق $DOMAIN"
  apt-get install -y -qq certbot
  mkdir -p /var/www/html

  # (1) إعداد HTTP مؤقت: يخدم النظام ويسمح لـ Let's Encrypt بالتحقق من ملكية النطاق
  cat > /etc/nginx/sites-available/hr <<NGINX
server {
    listen 80 default_server;
    server_name ${DOMAIN};
    client_max_body_size 8m;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/hr /etc/nginx/sites-enabled/hr
  nginx -t && systemctl reload nginx

  # (2) إصدار الشهادة دون تعديل إعداد nginx
  if certbot certonly --webroot -w /var/www/html -d "$DOMAIN" \
       --non-interactive --agree-tos --register-unsafely-without-email; then
    # (3) الإعداد النهائي: HTTPS للموظفين، و/iclock على HTTP لأجهزة البصمة
    sed "s/hr.example.com/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/hr
    nginx -t && systemctl reload nginx
    systemctl enable certbot.timer 2>/dev/null || true
    echo "==> جاهز: https://$DOMAIN"
  else
    echo "==> تعذّر إصدار الشهادة. تأكد أن $DOMAIN يشير إلى عنوان هذا الخادم وأن المنفذ 80 مفتوح،"
    echo "    ثم أعد: sudo certbot certonly --webroot -w /var/www/html -d $DOMAIN"
    echo "==> النظام يعمل مؤقتاً على http://$DOMAIN (بدون HTTPS لن يعمل تحديد الموقع للبصم الذاتي)"
  fi
else
  # بدون نطاق: وسيط على المنفذ 80 للوصول بعنوان IP مباشرة
  echo "==> إعداد Nginx للوصول بعنوان IP (بدون نطاق)"
  cat > /etc/nginx/sites-available/hr <<'NGINX'
server {
    listen 80 default_server;
    server_name _;
    client_max_body_size 8m;

    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/hr /etc/nginx/sites-enabled/hr
  nginx -t && systemctl reload nginx
  PUBLIC_IP="$(curl -s --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
  echo "==> جاهز: http://${PUBLIC_IP}"
  echo "    تنبيه: تحديد الموقع للبصم الذاتي يحتاج HTTPS — أعد التشغيل مع نطاق:"
  echo "    sudo bash deploy/install-ubuntu.sh hr.example.com"
fi

echo "==> حالة الخدمة:"; systemctl --no-pager --lines=5 status hr || true
