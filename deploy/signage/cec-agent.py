#!/usr/bin/env python3
"""وكيل الشاشة: يحوّل مصدر التلفاز إلى جهاز العرض عند بدء الفاصل، ويعيده بعده.

يعمل على أي جهاز موصول بالتلفاز عبر HDMI ومثبَّت عليه `cec-client`
(حزمة cec-utils على راسبيري باي وأوبنتو). لا يحتاج مبدّل HDMI ولا ريموت:
أمر «المصدر النشط» في بروتوكول HDMI-CEC يجعل التلفاز يعرض هذا المنفذ،
وأمر «مصدر غير نشط» يعيده إلى ما كان عليه — وهو الرسيفر.

    python3 cec-agent.py --server http://10.0.0.5:8000 --key <مفتاح الشاشة>

الشاشة التي أُلغي عنها خيار HDMI-CEC في النظام لا يمسّها الوكيل.
"""
from __future__ import annotations

import argparse
import json
import logging
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

logger = logging.getLogger("cec-agent")

# أوامر CEC كما يبتلعها cec-client عبر المدخل القياسي
CMD_ON = "on 0"            # أيقظ التلفاز إن كان نائماً
CMD_ACTIVE = "as"          # اجعلني المصدر النشط (يحوّل المنفذ)
CMD_INACTIVE = "is"        # لم أعد المصدر النشط (يعيد المنفذ السابق)


def send_cec(command: str, adapter: str) -> bool:
    """يمرّر أمراً واحداً إلى cec-client. يعيد False إن فشل فلا يتوقف الوكيل."""
    if not shutil.which("cec-client"):
        logger.warning("cec-client غير مثبَّت — التحويل التلقائي معطّل")
        return False
    try:
        proc = subprocess.run(
            ["cec-client", "-s", "-d", "1", adapter],
            input=f"{command}\n",
            capture_output=True,
            text=True,
            timeout=15,
        )
        if proc.returncode != 0:
            logger.warning("فشل أمر CEC %s: %s", command, proc.stderr.strip()[:200])
            return False
        return True
    except (subprocess.SubprocessError, OSError) as exc:
        logger.warning("تعذر تنفيذ أمر CEC %s: %s", command, exc)
        return False


def fetch_state(server: str, key: str, timeout: int = 10) -> dict | None:
    url = f"{server.rstrip('/')}/api/signage/play/{key}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            logger.error("مفتاح الشاشة غير صالح — راجع رابط التشغيل في النظام")
        else:
            logger.warning("الخادم ردّ بخطأ %s", exc.code)
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        logger.warning("تعذر الوصول إلى الخادم: %s", exc)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="تحويل مصدر التلفاز وقت الفاصل الإعلاني")
    parser.add_argument("--server", required=True, help="عنوان النظام، مثال http://10.0.0.5:8000")
    parser.add_argument("--key", required=True, help="مفتاح الشاشة من صفحة «شاشات العرض»")
    parser.add_argument("--adapter", default="RPI", help="اسم محوّل CEC (RPI افتراضياً)")
    parser.add_argument("--interval", type=int, default=10, help="ثواني بين كل استعلام")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
    showing = None      # آخر حالة أرسلنا عليها أمراً: لا نكرر الأمر كل دورة

    while True:
        state = fetch_state(args.server, args.key)
        if state is None:
            # انقطاع الشبكة لا يغيّر مصدر التلفاز: الصفحة تكمل من ذاكرتها
            time.sleep(max(5, args.interval))
            continue

        if not state.get("cec_enabled", True):
            showing = None
            time.sleep(max(5, state.get("poll_seconds") or args.interval))
            continue

        wants_screen = state.get("playing") in ("break", "always")
        if wants_screen != showing:
            if wants_screen:
                send_cec(CMD_ON, args.adapter)
                ok = send_cec(CMD_ACTIVE, args.adapter)
                logger.info("بدء الفاصل: طلب صورة الشاشة (%s)", "تم" if ok else "فشل")
            else:
                ok = send_cec(CMD_INACTIVE, args.adapter)
                logger.info("انتهاء الفاصل: إعادة الشاشة إلى الرسيفر (%s)", "تم" if ok else "فشل")
            # الفشل لا يُثبَّت: نعيد المحاولة في الدورة التالية
            showing = wants_screen if ok else None

        time.sleep(max(5, state.get("poll_seconds") or args.interval))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
