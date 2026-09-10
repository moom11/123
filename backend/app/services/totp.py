"""التحقق بخطوتين (TOTP) بمعيار RFC 6238 — يعمل مع Google Authenticator وغيره.

مبني على المكتبة القياسية وحدها (hmac + base64)، بلا اعتماد خارجي.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

DIGITS = 6
PERIOD = 30          # ثانية لكل رمز
WINDOW = 1           # يُقبل رمز الفترة السابقة واللاحقة (فرق ساعة الجهاز)


def new_secret() -> str:
    """سرّ عشوائي بترميز Base32 (١٦٠ بت) كما تتوقعه تطبيقات المصادقة."""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def _code_at(secret: str, counter: int) -> str:
    padding = "=" * (-len(secret) % 8)
    try:
        key = base64.b32decode(secret + padding, casefold=True)
    except Exception:
        return ""
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % (10 ** DIGITS)).zfill(DIGITS)


def code_now(secret: str, at: float | None = None) -> str:
    return _code_at(secret, int((at if at is not None else time.time()) // PERIOD))


def verify(secret: str, code: str, at: float | None = None) -> bool:
    """يتحقق من الرمز مع هامش فترة قبله وبعده، ومقارنة ثابتة الزمن."""
    code = "".join(ch for ch in str(code or "") if ch.isdigit())
    if len(code) != DIGITS or not secret:
        return False
    counter = int((at if at is not None else time.time()) // PERIOD)
    for drift in range(-WINDOW, WINDOW + 1):
        expected = _code_at(secret, counter + drift)
        if expected and hmac.compare_digest(expected, code):
            return True
    return False


def provisioning_uri(secret: str, account: str, issuer: str) -> str:
    """رابط otpauth:// يُمسح كـ QR أو يُدخل يدوياً في تطبيق المصادقة."""
    label = quote(f"{issuer}:{account}", safe="")
    return (
        f"otpauth://totp/{label}?secret={secret}"
        f"&issuer={quote(issuer, safe='')}&algorithm=SHA1&digits={DIGITS}&period={PERIOD}"
    )


def grouped(secret: str) -> str:
    """السرّ بمجموعات رباعية ليسهل نسخه يدوياً."""
    return " ".join(secret[i:i + 4] for i in range(0, len(secret), 4))
