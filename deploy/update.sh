#!/usr/bin/env bash
# تحديث النظام المنصَّب على الخادم إلى آخر إصدار من المستودع.
# الاستخدام:  cd ~/123 && sudo bash deploy/update.sh
set -euo pipefail

APP_DIR=/opt/hr
BACKUP_DIR=/var/backups/hr
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "شغّل السكربت بصلاحية root:  sudo bash deploy/update.sh"
  exit 1
fi
if [ ! -d "$APP_DIR" ]; then
  echo "لم يُعثر على $APP_DIR — النظام غير منصَّب بعد. شغّل deploy/install-ubuntu.sh أولاً."
  exit 1
fi

if [ -d "$REPO_DIR/.git" ]; then
  echo "==> جلب آخر التحديثات من Git"
  git -C "$REPO_DIR" pull --ff-only
fi

echo "==> إيقاف الخدمة مؤقتاً"
systemctl stop hr || true

echo "==> نسخة احتياطية قبل التحديث"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
tar -czf "$BACKUP_DIR/pre-update-$STAMP.tar.gz" -C "$APP_DIR" data 2>/dev/null || true
# الإبقاء على آخر ١٠ نسخ فقط
ls -1t "$BACKUP_DIR"/pre-update-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
echo "    $BACKUP_DIR/pre-update-$STAMP.tar.gz"

echo "==> تحديث ملفات النظام (بيانات النظام ومرفقاته لا تُمس)"
rsync -a --delete --exclude .venv --exclude data --exclude .git "$REPO_DIR/" "$APP_DIR/"

echo "==> تحديث حزم بايثون"
[ -x "$APP_DIR/.venv/bin/pip" ] || python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip -q
"$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/requirements.txt" -q

echo "==> ترقية قاعدة البيانات (إضافة الأعمدة والبيانات الجديدة)"
set -a; . /etc/hr.env; set +a
HR_DATA_DIR="$APP_DIR/data" PYTHONPATH="$APP_DIR/backend" "$APP_DIR/.venv/bin/python" -m app.seed
chown -R hr:hr "$APP_DIR"

echo "==> إعادة تشغيل الخدمة"
cp "$APP_DIR/deploy/hr.service" /etc/systemd/system/hr.service
systemctl daemon-reload
systemctl start hr
sleep 2
systemctl --no-pager --lines=5 status hr || true

echo
echo "تم التحديث ✅"
if [ -d "$REPO_DIR/.git" ]; then
  echo "الإصدار الحالي: $(git -C "$REPO_DIR" log -1 --pretty='%h %s')"
fi
echo "افتح النظام في المتصفح واضغط Ctrl+Shift+R لتحديث الواجهة المخزّنة."
