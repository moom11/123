"""تسجيل أجهزة الموظفين لاستقبال إشعارات الجوال."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import PushSubscription, User
from ..schemas import PushSubscriptionIn
from ..security import get_current_user
from ..services import push as push_service
from ..services import settings_store

router = APIRouter(prefix="/api/push", tags=["push"])


@router.get("/key")
def get_public_key(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """المفتاح العام المطلوب لاشتراك المتصفح (يُولَّد تلقائياً عند أول طلب)."""
    enabled = settings_store.get_bool(db, "push_enabled")
    devices = db.scalars(
        select(PushSubscription).where(PushSubscription.user_id == user.id)
    ).all()
    return {
        "enabled": enabled,
        "public_key": push_service.public_key(db) if enabled else "",
        "devices": len(devices),
    }


@router.post("/subscribe")
def subscribe(
    payload: PushSubscriptionIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """يسجّل جهاز المستخدم (أو يحدّثه إن كان مسجلاً)."""
    row = db.scalar(select(PushSubscription).where(PushSubscription.endpoint == payload.endpoint))
    if row:
        row.user_id = user.id
        row.p256dh = payload.p256dh
        row.auth = payload.auth
        row.user_agent = (payload.user_agent or "")[:255] or None
        row.last_error = None
    else:
        db.add(PushSubscription(
            user_id=user.id,
            endpoint=payload.endpoint,
            p256dh=payload.p256dh,
            auth=payload.auth,
            user_agent=(payload.user_agent or "")[:255] or None,
        ))
    db.commit()
    return {"ok": True, "message": "تم تفعيل إشعارات هذا الجهاز"}


@router.post("/unsubscribe")
def unsubscribe(
    payload: dict, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    endpoint = str(payload.get("endpoint") or "")
    row = db.scalar(
        select(PushSubscription).where(
            PushSubscription.endpoint == endpoint, PushSubscription.user_id == user.id
        )
    )
    if row:
        db.delete(row)
        db.commit()
    return {"ok": True, "message": "تم إيقاف إشعارات هذا الجهاز"}


@router.post("/test")
def send_test(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """إشعار تجريبي للتأكد من وصول النغمة إلى الجوال."""
    sent = push_service.send_to_users(
        db, [user.id], "تجربة إشعارات الموارد البشرية",
        "وصلك هذا الإشعار بنجاح ✅", link_page="dashboard",
    )
    db.commit()
    return {
        "ok": sent > 0,
        "devices": sent,
        "message": "أُرسل الإشعار التجريبي" if sent else
                   "لا يوجد جهاز مفعّل لهذا الحساب — فعّل الإشعارات من زر «إشعارات الجوال»",
    }
