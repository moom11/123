"""الإشعارات: داخل النظام + بريد إلكتروني + ويب هوك (واتساب/تلجرام عبر بوابة)."""
from __future__ import annotations

import json
import logging
import smtplib
import threading
import urllib.request
from email.message import EmailMessage

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import (
    NOTIFY_WEBHOOK_URL,
    SMTP_FROM,
    SMTP_HOST,
    SMTP_PASSWORD,
    SMTP_PORT,
    SMTP_TLS,
    SMTP_USER,
)
from ..models import Employee, Notification, Role, User

logger = logging.getLogger("hr")


def _send_email(to_address: str, subject: str, body: str) -> None:
    if not SMTP_HOST or not to_address:
        return
    try:
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = SMTP_FROM
        message["To"] = to_address
        message.set_content(body)
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
            if SMTP_TLS:
                server.starttls()
            if SMTP_USER:
                server.login(SMTP_USER, SMTP_PASSWORD)
            server.send_message(message)
    except Exception as exc:  # pragma: no cover - يعتمد على خادم بريد خارجي
        logger.warning("تعذر إرسال بريد الإشعار إلى %s: %s", to_address, exc)


def _send_webhook(payload: dict) -> None:
    if not NOTIFY_WEBHOOK_URL:
        return
    try:
        request = urllib.request.Request(
            NOTIFY_WEBHOOK_URL,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        urllib.request.urlopen(request, timeout=15).close()
    except Exception as exc:  # pragma: no cover - يعتمد على خدمة خارجية
        logger.warning("تعذر إرسال إشعار الويب هوك: %s", exc)


def _dispatch_external(payloads: list[dict]) -> None:
    """يرسل البريد والويب هوك في خيط منفصل حتى لا يبطئ الاستجابة."""
    if not (SMTP_HOST or NOTIFY_WEBHOOK_URL) or not payloads:
        return

    def worker() -> None:
        for item in payloads:
            if item.get("email"):
                _send_email(item["email"], item["title"], item.get("body") or item["title"])
            _send_webhook(item)

    threading.Thread(target=worker, daemon=True).start()


def notify_users(
    db: Session,
    users: list[User],
    title: str,
    body: str | None = None,
    category: str = "general",
    link_page: str | None = None,
    commit: bool = True,
) -> int:
    """ينشئ إشعاراً داخل النظام لكل مستخدم، ويرسله بالبريد/الويب هوك إن كانا مضبوطين."""
    payloads: list[dict] = []
    created = 0
    for user in users:
        if not user or not user.is_active:
            continue
        db.add(
            Notification(
                user_id=user.id,
                title=title,
                body=body,
                category=category,
                link_page=link_page,
            )
        )
        created += 1
        payloads.append({
            "title": title,
            "body": body or "",
            "category": category,
            "username": user.username,
            "employee": user.employee.full_name if user.employee else None,
            "email": user.employee.email if user.employee else None,
        })
    if commit:
        db.commit()
    else:
        db.flush()
    _dispatch_external(payloads)
    return created


def notify_employee(db: Session, employee_id: int, title: str, **kwargs) -> int:
    """إشعار الموظف المرتبط بحساب مستخدم."""
    user = db.scalar(select(User).where(User.employee_id == employee_id))
    return notify_users(db, [user] if user else [], title, **kwargs)


def notify_roles(db: Session, roles: list[Role], title: str, **kwargs) -> int:
    users = db.scalars(select(User).where(User.role.in_(roles), User.is_active.is_(True))).all()
    return notify_users(db, list(users), title, **kwargs)


def notify_approvers(db: Session, employee_id: int, title: str, **kwargs) -> int:
    """إشعار الموارد البشرية ومدير الموظف المباشر."""
    targets: dict[int, User] = {}
    for user in db.scalars(
        select(User).where(User.role.in_([Role.admin, Role.hr]), User.is_active.is_(True))
    ).all():
        targets[user.id] = user

    employee = db.get(Employee, employee_id)
    manager_ids = set()
    if employee:
        if employee.manager_id:
            manager_ids.add(employee.manager_id)
        if employee.department and employee.department.manager_id:
            manager_ids.add(employee.department.manager_id)
    for manager_employee_id in manager_ids:
        user = db.scalar(select(User).where(User.employee_id == manager_employee_id))
        if user:
            targets[user.id] = user
    return notify_users(db, list(targets.values()), title, **kwargs)
