"""حماية إضافية: ترويسات أمنية، وتحديد محاولات الدخول الفاشلة."""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import defaultdict

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

logger = logging.getLogger("hr")

# ------------------------------ تحديد محاولات الدخول ------------------------------
MAX_ATTEMPTS = 6           # عدد المحاولات الفاشلة المسموحة
WINDOW_SECONDS = 15 * 60   # مدة احتساب المحاولات
LOCK_SECONDS = 15 * 60     # مدة الإيقاف بعد تجاوز الحد

_lock = threading.Lock()
_attempts: dict[str, list[float]] = defaultdict(list)
_locked_until: dict[str, float] = {}


def _key(username: str, ip: str) -> str:
    return f"{(username or '').strip().lower()}|{ip or '-'}"


def login_block_seconds(username: str, ip: str) -> int:
    """كم ثانية متبقية على الإيقاف (0 = مسموح بالمحاولة)."""
    key = _key(username, ip)
    with _lock:
        until = _locked_until.get(key, 0)
        remaining = int(until - time.time())
        if remaining <= 0:
            _locked_until.pop(key, None)
            return 0
        return remaining


def register_failure(username: str, ip: str) -> int:
    """يسجّل محاولة فاشلة ويعيد عدد المحاولات داخل النافذة."""
    key = _key(username, ip)
    now = time.time()
    with _lock:
        tries = [t for t in _attempts[key] if now - t < WINDOW_SECONDS]
        tries.append(now)
        _attempts[key] = tries
        if len(tries) >= MAX_ATTEMPTS:
            _locked_until[key] = now + LOCK_SECONDS
            _attempts[key] = []
            logger.warning("إيقاف مؤقت لمحاولات الدخول: %s", key)
        return len(tries)


def clear_failures(username: str, ip: str) -> None:
    key = _key(username, ip)
    with _lock:
        _attempts.pop(key, None)
        _locked_until.pop(key, None)


def reset_all() -> None:
    """للاختبارات: تصفير كل العدادات."""
    with _lock:
        _attempts.clear()
        _locked_until.clear()


# ------------------------------ الترويسات الأمنية ------------------------------
CSP = (
    "default-src 'self'; "
    "base-uri 'self'; "
    "object-src 'none'; "
    "frame-ancestors 'none'; "
    "form-action 'self'; "
    # الواجهة تستخدم معالجات onclick داخل HTML، لذا يلزم 'unsafe-inline' للسكربت
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
    "img-src 'self' data: blob:; "
    "connect-src 'self'; "
    "manifest-src 'self'; "
    "worker-src 'self'"
)

HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(self), camera=(), microphone=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": CSP,
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """يضيف ترويسات الحماية لكل استجابة (وHSTS عند العمل خلف HTTPS)."""

    async def dispatch(self, request, call_next):
        # حدّ معدل الطلبات قبل أي معالجة: يوقف الفحص الآلي والاستنزاف مبكراً
        client_ip = request.client.host if request.client else "-"
        if rate_exceeded(client_ip, request.url.path):
            logger.warning("تجاوز حد الطلبات من %s على %s", client_ip, request.url.path)
            return JSONResponse(
                {"detail": "طلبات كثيرة جداً، انتظر قليلاً ثم أعد المحاولة"},
                status_code=429,
                headers={"Retry-After": "60", **HEADERS},
            )
        response = await call_next(request)
        for name, value in HEADERS.items():
            response.headers.setdefault(name, value)
        forwarded = request.headers.get("x-forwarded-proto", request.url.scheme)
        if forwarded == "https":
            response.headers.setdefault(
                "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
            )
        if request.url.path.startswith("/uploads/"):
            # المرفقات تُنزَّل ولا تُنفَّذ داخل المتصفح
            response.headers["Content-Disposition"] = "attachment"
            response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
        return response


# ------------------------------ كلمات المرور الضعيفة ------------------------------
WEAK_PASSWORDS = {
    "123456", "1234567", "12345678", "123456789", "1234567890", "password", "passw0rd",
    "qwerty", "111111", "000000", "abc123", "admin", "admin123", "aa123456", "123123",
    "welcome", "letmein", "iloveyou", "sa123456", "a1234567",
}


def password_problem(password: str, username: str = "", phone: str = "") -> str | None:
    """يعيد سبب رفض كلمة المرور، أو None إن كانت مقبولة."""
    value = (password or "").strip()
    if len(value) < 6:
        return "كلمة المرور قصيرة: ٦ أحرف على الأقل"
    if value.lower() in WEAK_PASSWORDS:
        return "كلمة المرور شائعة جداً، اختر كلمة أقوى"
    if username and value.lower() == username.strip().lower():
        return "لا تجعل كلمة المرور نفس اسم المستخدم"
    digits = "".join(ch for ch in value if ch.isdigit())
    if phone and digits and digits == "".join(ch for ch in phone if ch.isdigit()):
        return "لا تجعل كلمة المرور نفس رقم جوالك"
    if value.isdigit() and len(set(value)) <= 2:
        return "كلمة المرور بسيطة جداً"
    return None


# ------------------------------ فحص محتوى المرفقات ------------------------------
# التحقق من امتداد الملف وحده لا يكفي: نفحص التوقيع الفعلي (magic bytes)
_SIGNATURES: dict[str, tuple[bytes, ...]] = {
    ".png": (b"\x89PNG\r\n\x1a\n",),
    ".jpg": (b"\xff\xd8\xff",),
    ".jpeg": (b"\xff\xd8\xff",),
    ".gif": (b"GIF87a", b"GIF89a"),
    ".webp": (b"RIFF",),          # مع "WEBP" في الموضع الثامن
    ".pdf": (b"%PDF-",),
    ".zip": (b"PK\x03\x04",),
    ".xlsx": (b"PK\x03\x04",),
    ".xls": (b"\xd0\xcf\x11\xe0", b"PK\x03\x04"),
    ".docx": (b"PK\x03\x04",),
}

# ملفات نصّية أو متجهية لا توقيع ثنائي لها
_TEXT_TYPES = {".svg", ".csv", ".txt"}

# وسوم خطيرة داخل ملفات SVG (تنفيذ سكربت في المتصفح)
_SVG_FORBIDDEN = (b"<script", b"javascript:", b"onload=", b"onerror=", b"<foreignobject")


def content_problem(content: bytes, suffix: str) -> str | None:
    """يعيد رسالة خطأ إن كان محتوى الملف لا يطابق امتداده أو كان خطراً."""
    suffix = (suffix or "").lower()
    if not content:
        return "الملف فارغ"

    if suffix == ".svg":
        head = content[:4096].lower()
        if not (b"<svg" in head or b"<?xml" in head):
            return "الملف ليس SVG صالحاً"
        lowered = content.lower()
        if any(bad in lowered for bad in _SVG_FORBIDDEN):
            return "ملف SVG يحتوي سكربتاً — غير مسموح"
        return None

    if suffix in _TEXT_TYPES:
        return None

    signatures = _SIGNATURES.get(suffix)
    if not signatures:
        return None      # امتداد غير معروف: تتكفّل به قائمة الامتدادات المسموحة
    if not any(content.startswith(sig) for sig in signatures):
        return "محتوى الملف لا يطابق امتداده"
    if suffix == ".webp" and content[8:12] != b"WEBP":
        return "محتوى الملف لا يطابق امتداده"
    return None


# ------------------------------ حدّ عام لمعدل الطلبات ------------------------------
# يحمي من الاستنزاف والفحص الآلي: نافذة دقيقة واحدة لكل عنوان IP
RATE_WINDOW = 60
# الحد سخيّ عمداً: فرع كامل قد يشترك في عنوان واحد (NAT)، والهدف إيقاف
# الفحص الآلي والاستنزاف (آلاف الطلبات) لا إزعاج الاستخدام العادي
RATE_MAX = int(os.getenv("HR_RATE_LIMIT", "1200"))   # طلب/دقيقة لكل IP
_RATE: dict[str, list[float]] = {}

# مسارات معفاة: بروتوكول أجهزة البصمة وملفات الواجهة
RATE_EXEMPT_PREFIXES = ("/iclock/", "/app/", "/uploads/")


def rate_exceeded(ip: str, path: str) -> bool:
    """يعيد True إن تجاوز هذا العنوان الحد المسموح في الدقيقة الأخيرة."""
    if RATE_MAX <= 0 or path.startswith(RATE_EXEMPT_PREFIXES):
        return False
    now = time.time()
    hits = [t for t in _RATE.get(ip, []) if now - t < RATE_WINDOW]
    hits.append(now)
    _RATE[ip] = hits
    if len(_RATE) > 5000:        # تنظيف دوري حتى لا تتضخم الذاكرة
        for key in [k for k, v in _RATE.items() if not v or now - v[-1] > RATE_WINDOW]:
            _RATE.pop(key, None)
    return len(hits) > RATE_MAX


def reset_rate() -> None:
    _RATE.clear()
