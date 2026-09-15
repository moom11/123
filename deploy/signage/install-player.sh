#!/usr/bin/env bash
# تجهيز جهاز شاشة واحد (راسبيري باي أو أي لينكس بسطح مكتب):
# متصفح ملء الشاشة يعرض قائمة الشاشة، ووكيل يحوّل مصدر التلفاز وقت الفاصل.
#
#   sudo ./install-player.sh http://10.0.0.5:8000 <مفتاح-الشاشة>
#
# المفتاح تجده في: النظام ← شاشات العرض ← الشاشات ← «رابط التشغيل».
set -euo pipefail

SERVER="${1:-}"
KEY="${2:-}"
RUN_USER="${SUDO_USER:-$(id -un)}"

if [[ -z "$SERVER" || -z "$KEY" ]]; then
  echo "الاستعمال: sudo $0 <عنوان الخادم> <مفتاح الشاشة>" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "شغّل السكربت بصلاحية الجذر (sudo)" >&2
  exit 1
fi

echo "==> تثبيت المتطلبات"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# cec-utils: أوامر تحويل مصدر التلفاز. unclutter: إخفاء مؤشر الفأرة.
apt-get install -y --no-install-recommends \
  chromium-browser xdotool unclutter cec-utils python3 >/dev/null 2>&1 \
  || apt-get install -y --no-install-recommends \
       chromium xdotool unclutter cec-utils python3

BROWSER="$(command -v chromium-browser || command -v chromium)"
AGENT_DIR="/opt/mara-signage"
install -d "$AGENT_DIR"
install -m 755 "$(dirname "$0")/cec-agent.py" "$AGENT_DIR/cec-agent.py"

echo "==> كتابة إعدادات الشاشة"
cat > "$AGENT_DIR/screen.env" <<ENV
SIGNAGE_SERVER=$SERVER
SIGNAGE_KEY=$KEY
ENV
chmod 600 "$AGENT_DIR/screen.env"     # المفتاح يقوم مقام كلمة المرور

echo "==> خدمة تحويل مصدر التلفاز"
cat > /etc/systemd/system/mara-cec.service <<UNIT
[Unit]
Description=تحويل مصدر التلفاز وقت الفاصل الإعلاني
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$AGENT_DIR/screen.env
ExecStart=/usr/bin/python3 $AGENT_DIR/cec-agent.py --server \${SIGNAGE_SERVER} --key \${SIGNAGE_KEY}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

echo "==> تشغيل المتصفح ملء الشاشة عند الإقلاع"
cat > "$AGENT_DIR/kiosk.sh" <<KIOSK
#!/usr/bin/env bash
set -euo pipefail
source $AGENT_DIR/screen.env
# لا تُطفأ الشاشة ولا تظهر شاشة توقف
xset s off -dpms s noblank || true
unclutter -idle 1 &
exec "$BROWSER" --kiosk --noerrdialogs --disable-infobars --incognito \\
  --disable-session-crashed-bubble --check-for-update-interval=31536000 \\
  --autoplay-policy=no-user-gesture-required \\
  "\${SIGNAGE_SERVER}/player/?k=\${SIGNAGE_KEY}"
KIOSK
chmod 755 "$AGENT_DIR/kiosk.sh"

install -d -o "$RUN_USER" -g "$RUN_USER" "/home/$RUN_USER/.config/autostart"
cat > "/home/$RUN_USER/.config/autostart/mara-signage.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=شاشة عرض مارا
Exec=$AGENT_DIR/kiosk.sh
X-GNOME-Autostart-enabled=true
DESKTOP
chown "$RUN_USER:$RUN_USER" "/home/$RUN_USER/.config/autostart/mara-signage.desktop"

systemctl daemon-reload
systemctl enable --now mara-cec.service

cat <<DONE

تم. أعد تشغيل الجهاز ليبدأ العرض تلقائياً:  sudo reboot

  حالة وكيل التحويل:   systemctl status mara-cec
  سجلّه:               journalctl -u mara-cec -f
  تغيير الشاشة لاحقاً:  حرّر $AGENT_DIR/screen.env ثم أعد التشغيل

DONE
