"""حماية إضافية: ترويسات أمنية، وتحديد محاولات الدخول الفاشلة."""
from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict

from starlette.middleware.base import BaseHTTPMiddleware

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
