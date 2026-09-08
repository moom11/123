"""إشعارات الجوال (Web Push): يظهر الإشعار بنغمة الجهاز حتى والتطبيق مغلق.

المفاتيح (VAPID) تُولَّد تلقائياً عند أول استخدام وتُحفظ في إعدادات النظام،
فلا يحتاج المستخدم إلى أي حساب أو خدمة خارجية.
"""
from __future__ import annotations

import base64
import json
import logging
import threading
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..models import PushSubscription
from . import settings_store

logger = logging.getLogger("hr")

PRIVATE_KEY_SETTING = "push_private_key"
PUBLIC_KEY_SETTING = "push_public_key"
SUBJECT_SETTING = "push_subject"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def ensure_keys(db: Session) -> tuple[str, str]:
    """يعيد (المفتاح الخاص، المفتاح العام) ويولّدهما عند أول مرة."""
    private_key = settings_store.get(db, PRIVATE_KEY_SETTING)
    public_key = settings_store.get(db, PUBLIC_KEY_SETTING)
    if private_key and public_key:
        return private_key, public_key

    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives import serialization

    key = ec.generate_private_key(ec.SECP256R1())
    private_bytes = key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_bytes = key.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    private_key, public_key = _b64(private_bytes), _b64(public_bytes)
    settings_store.set_many(db, {PRIVATE_KEY_SETTING: private_key, PUBLIC_KEY_SETTING: public_key})
    logger.info("تم توليد مفاتيح إشعارات الجوال (VAPID)")
    return private_key, public_key


def public_key(db: Session) -> str:
    return ensure_keys(db)[1]


def is_configured(db: Session) -> bool:
    return bool(settings_store.get(db, PUBLIC_KEY_SETTING))


def _deliver(subscriptions: list[dict], payload: dict, private_key: str, subject: str) -> None:
    """يرسل فعلياً في خيط منفصل، ويحذف الاشتراكات المنتهية."""
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:  # pragma: no cover - الحزمة غير مثبتة
        logger.warning("pywebpush غير مثبتة: تعذر إرسال إشعارات الجوال")
        return

    dead: list[str] = []
    for item in subscriptions:
        try:
            webpush(
                subscription_info={
                    "endpoint": item["endpoint"],
                    "keys": {"p256dh": item["p256dh"], "auth": item["auth"]},
                },
                data=json.dumps(payload, ensure_ascii=False),
                vapid_private_key=private_key,
                vapid_claims={"sub": subject},
                timeout=10,
            )
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None)
            if status in (404, 410):
                dead.append(item["endpoint"])
            else:
                logger.warning("تعذر إرسال إشعار جوال: %s", exc)
        except Exception as exc:  # pragma: no cover - شبكة خارجية
            logger.warning("تعذر إرسال إشعار جوال: %s", exc)

    if dead:
        with SessionLocal() as db:
            for endpoint in dead:
                row = db.scalar(select(PushSubscription).where(PushSubscription.endpoint == endpoint))
                if row:
                    db.delete(row)
            db.commit()
            logger.info("حُذفت %d اشتراكات إشعارات منتهية", len(dead))


def send_to_users(
    db: Session,
    user_ids: list[int],
    title: str,
    body: str = "",
    link_page: str | None = None,
) -> int:
    """يرسل إشعار جوال لكل أجهزة المستخدمين المشتركين. يعيد عدد الأجهزة."""
    ids = [uid for uid in set(user_ids) if uid]
    if not ids or not settings_store.get_bool(db, "push_enabled"):
        return 0
    # لا نولّد المفاتيح هنا: التوليد يحدث عند الإقلاع أو عند طلب المفتاح العام،
    # حتى لا نُغلق معاملة قاعدة بيانات مفتوحة لدى المستدعي.
    private_key = settings_store.get(db, PRIVATE_KEY_SETTING)
    if not private_key:
        return 0
    rows = db.scalars(
        select(PushSubscription).where(PushSubscription.user_id.in_(ids))
    ).all()
    if not rows:
        return 0
    subject = settings_store.get(db, SUBJECT_SETTING) or "mailto:hr@example.com"
    payload = {
        "title": title,
        "body": body or "",
        "page": link_page or "",
        "time": datetime.now().isoformat(timespec="seconds"),
    }
    items = [{"endpoint": r.endpoint, "p256dh": r.p256dh, "auth": r.auth} for r in rows]
    for row in rows:
        row.last_sent_at = datetime.now()
    db.flush()
    threading.Thread(
        target=_deliver,
        args=(items, payload, private_key, subject),
        daemon=True,
    ).start()
    return len(items)
