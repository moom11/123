#!/usr/bin/env bash
# إعداد النسخ الاحتياطي التلقائي اليومي إلى جوجل درايف.
# الاستخدام:  sudo bash deploy/setup-drive-backup.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "شغّل السكربت بصلاحية root (sudo)"; exit 1; fi
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> تثبيت rclone و sqlite3"
apt-get update -qq
apt-get install -y -qq sqlite3
command -v rclone >/dev/null 2>&1 || curl -fsSL https://rclone.org/install.sh | bash

echo "==> تثبيت سكربت النسخ الاحتياطي"
install -m 755 "$REPO_DIR/deploy/hr-backup" /usr/local/bin/hr-backup

if [ ! -f /etc/hr-backup.env ]; then
  cat > /etc/hr-backup.env <<'ENV'
HR_DATA_DIR=/opt/hr/data
HR_BACKUP_DIR=/var/backups/hr
# اسم الاتصال في rclone ثم اسم المجلد في درايف
HR_RCLONE_REMOTE=gdrive:HR-Backups
# عدد الأيام التي تُحفظ (محلياً وعلى درايف)
HR_BACKUP_KEEP_DAYS=14
ENV
  chmod 600 /etc/hr-backup.env
fi

echo "==> تسجيل المؤقّت اليومي (2:30 صباحاً)"
cat > /etc/systemd/system/hr-backup.service <<'UNIT'
[Unit]
Description=نسخة احتياطية لنظام الموارد البشرية ورفعها إلى جوجل درايف

[Service]
Type=oneshot
EnvironmentFile=-/etc/hr-backup.env
ExecStart=/usr/local/bin/hr-backup
UNIT

cat > /etc/systemd/system/hr-backup.timer <<'UNIT'
[Unit]
Description=تشغيل النسخة الاحتياطية يومياً

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now hr-backup.timer

echo
echo "==> بقيت خطوة واحدة: ربط حساب جوجل درايف"
echo "    نفّذ الآن:  sudo rclone config"
echo "    الخيارات: n (اتصال جديد) ← الاسم: gdrive ← النوع: drive"
echo "              client_id و client_secret: اتركهما فارغين"
echo "              scope: اختر 3 (drive.file) ← الباقي Enter"
echo "              Use auto config? اختر y  (بعد فتح نفق SSH كما في DEPLOY.md)"
echo
echo "    ثم جرّب:  sudo hr-backup"
echo "    وللتأكد من الجدولة:  systemctl list-timers hr-backup.timer"
