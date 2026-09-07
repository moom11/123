"""المهام اليومية: إشعار العبارة التحفيزية لكل الموظفين."""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import User
from . import notifications, quotes, settings_store


def send_daily_quote(db: Session, force: bool = False) -> int:
    """يرسل عبارة اليوم إشعاراً لكل المستخدمين النشطين، مرة واحدة يومياً.

    force=True يتجاوز التحقق من الوقت ومن الإرسال السابق (للإرسال اليدوي).
    """
    today = date.today()
    if not force:
        if not settings_store.get_bool(db, "daily_quote_enabled"):
            return 0
        if settings_store.get(db, "daily_quote_last_sent") == today.isoformat():
            return 0
        if datetime.now().hour < settings_store.get_int(db, "daily_quote_hour", 7):
            return 0

    users = db.scalars(select(User).where(User.is_active.is_(True))).all()
    if not users:
        return 0

    company = settings_store.get(db, "company_name") or "إدارة الموارد البشرية"
    sent = notifications.notify_users(
        db,
        list(users),
        "عبارة اليوم ✦",
        body=f"{quotes.quote_for(today)}\n\n{company}",
        category="quote",
        commit=False,
    )
    settings_store.set_many(db, {"daily_quote_last_sent": today.isoformat()})
    return sent
