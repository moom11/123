"""سجل الدخول: تسجيل كل محاولة، والتنبيه عند دخول من جهاز أو مكان جديد."""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import LoginEvent, Role, User

# لا نُنبّه على أول دخول للحساب، فالجهاز الأول ليس «جديداً»
NEW_DEVICE_LOOKBACK_DAYS = 180


def record(
    db: Session,
    username: str,
    ip: str | None,
    user_agent: str | None,
    success: bool,
    user: User | None = None,
    reason: str | None = None,
    commit: bool = True,
) -> LoginEvent:
    row = LoginEvent(
        user_id=user.id if user else None,
        username=(username or "")[:64],
        ip=(ip or "-")[:64],
        user_agent=(user_agent or "")[:255] or None,
        success=success,
        reason=(reason or None) if not success else None,
    )
    db.add(row)
    if commit:
        db.commit()
    else:
        db.flush()
    return row


def is_new_device(db: Session, user: User, ip: str | None, user_agent: str | None) -> bool:
    """دخول ناجح سابق بالبصمة نفسها (IP + متصفح)؟ إن لا، فهو جهاز جديد."""
    since = datetime.now() - timedelta(days=NEW_DEVICE_LOOKBACK_DAYS)
    previous = db.scalars(
        select(LoginEvent).where(
            LoginEvent.user_id == user.id,
            LoginEvent.success.is_(True),
            LoginEvent.created_at >= since,
        )
    ).all()
    if not previous:
        return False        # أول دخول مسجَّل: لا تنبيه
    agent = (user_agent or "")[:255]
    return not any(row.ip == (ip or "-") and (row.user_agent or "") == agent for row in previous)


def notify_new_device(db: Session, user: User, ip: str | None, user_agent: str | None) -> None:
    """يُشعر صاحب الحساب بدخول جديد، ويُشعر مديري النظام إن كان حساباً إدارياً."""
    from . import notifications

    when = datetime.now().strftime("%Y-%m-%d %H:%M")
    body = f"من {ip or 'غير معروف'} — {when}\n{(user_agent or '')[:120]}"
    notifications.notify_users(
        db, [user], "دخول جديد إلى حسابك",
        body=body + "\nإن لم تكن أنت، غيّر كلمة المرور فوراً من «حسابي».",
        category="security", link_page="account", commit=False,
    )
    if user.role in (Role.admin, Role.hr):
        admins = db.scalars(
            select(User).where(User.role == Role.admin, User.is_active.is_(True), User.id != user.id)
        ).all()
        if admins:
            notifications.notify_users(
                db, list(admins), f"دخول إداري جديد: {user.username}",
                body=body, category="security", link_page="settings", commit=False,
            )


def failure_burst(db: Session, username: str, minutes: int = 15, limit: int = 5) -> int:
    """عدد المحاولات الفاشلة الأخيرة لهذا الاسم — لتنبيه الإدارة عند الهجوم."""
    since = datetime.now() - timedelta(minutes=minutes)
    rows = db.scalars(
        select(LoginEvent).where(
            LoginEvent.username == (username or "")[:64],
            LoginEvent.success.is_(False),
            LoginEvent.created_at >= since,
        )
    ).all()
    return len(rows)
