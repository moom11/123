"""إعدادات التطبيق - تُقرأ من متغيرات البيئة مع قيم افتراضية صالحة للتشغيل المباشر."""
from __future__ import annotations

import os
import secrets
from pathlib import Path
from zoneinfo import ZoneInfo

BASE_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = Path(os.getenv("HR_DATA_DIR", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

FRONTEND_DIR = BASE_DIR / "frontend"
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _secret_key() -> str:
    """مفتاح توقيع الجلسات: من البيئة، وإلا يُولَّد ويُحفظ مرة واحدة."""
    env = os.getenv("HR_SECRET_KEY")
    if env:
        return env
    key_file = DATA_DIR / "secret.key"
    if not key_file.exists():
        key_file.write_text(secrets.token_hex(32), encoding="utf-8")
        key_file.chmod(0o600)
    return key_file.read_text(encoding="utf-8").strip()


DATABASE_URL = os.getenv("HR_DATABASE_URL", f"sqlite:///{DATA_DIR / 'hr.db'}")
SECRET_KEY = _secret_key()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("HR_TOKEN_MINUTES", "720"))

TIMEZONE_NAME = os.getenv("HR_TIMEZONE", "Asia/Riyadh")
TZ = ZoneInfo(TIMEZONE_NAME)

# مزامنة دورية تلقائية لأجهزة البصمة (بالدقائق، 0 = تعطيل)
AUTO_SYNC_MINUTES = int(os.getenv("HR_AUTO_SYNC_MINUTES", "0"))

# كلمة مرور مدير النظام الأولى (تُنشأ عند أول تشغيل فقط)
ADMIN_USERNAME = os.getenv("HR_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("HR_ADMIN_PASSWORD", "admin123")

MAX_UPLOAD_BYTES = int(os.getenv("HR_MAX_UPLOAD_BYTES", str(5 * 1024 * 1024)))
