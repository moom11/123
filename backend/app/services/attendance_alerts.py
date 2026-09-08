"""تنبيه يومي بمن لم يبصم ومن تأخر، يُرسل بعد بداية الوردية بمدة قابلة للضبط."""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    AttendanceDay,
    DayStatus,
    Employee,
    EmployeeStatus,
    Role,
    User,
)
from . import attendance as attendance_service
from . import notifications, settings_store

logger = logging.getLogger("hr")


def _shift_start(employee: Employee) -> datetime | None:
    """بداية وردية الموظف اليوم، أو None إذا كان اليوم راحة له."""
    rules = attendance_service.ShiftRules(employee.shift)
    today = date.today()
    if today.weekday() not in rules.work_days:
        return None
    return rules.scheduled_in(today)


def scan(db: Session, force: bool = False) -> dict:
    """يفحص حضور اليوم ويرسل تنبيهاً واحداً للمشرفين (وللموظف عند تفعيله)."""
    if not force and not settings_store.get_bool(db, "attendance_alert_enabled"):
        return {"ok": False, "sent": 0, "message": "تنبيه الغياب معطّل من الإعدادات"}

    today = date.today()
    if not force and settings_store.get(db, "attendance_alert_last_sent") == today.isoformat():
        return {"ok": True, "sent": 0, "message": "أُرسل تنبيه اليوم مسبقاً"}

    delay = settings_store.get_int(db, "attendance_alert_after_minutes", 60) or 60
    now = datetime.now()

    employees = db.scalars(
        select(Employee).where(Employee.status == EmployeeStatus.active).order_by(Employee.code)
    ).all()
    due = []
    for employee in employees:
        start = _shift_start(employee)
        if start is None:
            continue
        if now >= start + timedelta(minutes=delay):
            due.append(employee)
    if not due:
        return {"ok": True, "sent": 0, "message": "لم يحن وقت التنبيه لأي وردية بعد"}

    attendance_service.recompute(db, today, today, [e.id for e in due])
    rows = {
        row.employee_id: row
        for row in db.scalars(
            select(AttendanceDay).where(
                AttendanceDay.work_date == today,
                AttendanceDay.employee_id.in_([e.id for e in due]),
            )
        ).all()
    }

    missing: list[Employee] = []
    late: list[tuple[Employee, int]] = []
    for employee in due:
        row = rows.get(employee.id)
        if row is None or row.status in (DayStatus.leave, DayStatus.holiday, DayStatus.weekend):
            continue
        if row.check_in is None:
            missing.append(employee)
        elif row.late_minutes > 0:
            late.append((employee, row.late_minutes))

    if not missing and not late:
        settings_store.set_many(db, {"attendance_alert_last_sent": today.isoformat()})
        return {"ok": True, "sent": 0, "message": "لا يوجد غياب ولا تأخير حتى الآن"}

    lines = []
    if missing:
        lines.append("لم يبصموا: " + "، ".join(f"{e.full_name} ({e.code})" for e in missing))
    if late:
        lines.append("متأخرون: " + "، ".join(
            f"{e.full_name} {minutes} د" for e, minutes in late))
    body = "\n".join(lines)
    title = f"تنبيه حضور {today.isoformat()}: {len(missing)} لم يبصم، {len(late)} متأخر"

    supervisors = db.scalars(
        select(User).where(User.role.in_([Role.admin, Role.hr]), User.is_active.is_(True))
    ).all()
    manager_ids = {e.manager_id for e in missing + [x[0] for x in late] if e.manager_id}
    for manager_employee_id in manager_ids:
        manager_user = db.scalar(select(User).where(User.employee_id == manager_employee_id))
        if manager_user and manager_user not in supervisors:
            supervisors.append(manager_user)

    sent = notifications.notify_users(
        db, list(supervisors), title, body=body,
        category="attendance", link_page="attendance", commit=False,
    )

    if settings_store.get_bool(db, "attendance_alert_notify_employee"):
        for employee in missing:
            notifications.notify_employee(
                db, employee.id, "لم نستلم بصمة حضورك اليوم",
                body="سجّل حضورك من التطبيق أو راجع مسؤولك المباشر.",
                category="attendance", link_page="dashboard", commit=False,
            )
        for employee, minutes in late:
            notifications.notify_employee(
                db, employee.id, f"سُجّل تأخيرك اليوم {minutes} دقيقة",
                body="التأخير المتكرر يُخصم من الراتب حسب لائحة العمل.",
                category="attendance", link_page="attendance", commit=False,
            )

    settings_store.set_many(db, {"attendance_alert_last_sent": today.isoformat()})
    db.commit()
    logger.info("تنبيه الحضور: %d لم يبصم، %d متأخر", len(missing), len(late))
    return {
        "ok": True,
        "sent": sent,
        "missing": len(missing),
        "late": len(late),
        "message": f"أُرسل التنبيه إلى {sent} مستخدم ({len(missing)} لم يبصم، {len(late)} متأخر)",
    }
