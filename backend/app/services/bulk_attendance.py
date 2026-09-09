"""تسجيل حضور جماعي لمدى تواريخ.

يستعمل حين يعمل الفريق فعلاً لكن البصمات لم تُسجَّل (الجهاز لم يكن موصولاً بعد،
أو انقطع الاتصال). ينشئ لكل موظف بصمة حضور وانصراف بمواعيد ورديته في أيام العمل
فقط، ثم يعيد احتساب الكشف. لا يمسّ يوماً فيه بصمات فعلية، ولا أيام الراحة
الأسبوعية أو المجدولة ولا العطل ولا الإجازات المعتمدة — تسجيلها حضوراً يفسد
الرواتب ويلغي حق الموظف في راحته.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Employee, EmployeeStatus, Punch, PunchSource, PunchType
from .attendance import (
    ShiftRules,
    _approved_leaves,
    _holidays,
    _rest_days,
    recompute,
)

NOTE = "تسجيل حضور جماعي"


@dataclass
class Result:
    """حصيلة العملية: ما سُجّل وما تُخطّي ولماذا."""

    employees: int = 0
    days_marked: int = 0
    punches_created: int = 0
    skipped_existing: int = 0      # اليوم فيه بصمات فعلاً
    skipped_rest: int = 0          # راحة أسبوعية أو مجدولة
    skipped_holiday: int = 0
    skipped_leave: int = 0
    skipped_before_hire: int = 0   # قبل تاريخ التعيين
    skipped_future: int = 0        # يوم لم يأتِ بعد
    recomputed_days: int = 0
    names: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        data = self.__dict__.copy()
        data["message"] = (
            f"سُجّل حضور {self.employees} موظف في {self.days_marked} يوم عمل"
            f" ({self.punches_created} بصمة)"
        )
        return data


def mark_present(
    db: Session,
    start: date,
    end: date,
    employee_ids: list[int] | None = None,
    today: date | None = None,
) -> Result:
    if start > end:
        start, end = end, start
    today = today or date.today()

    stmt = select(Employee).where(Employee.status == EmployeeStatus.active)
    if employee_ids:
        stmt = select(Employee).where(Employee.id.in_(employee_ids))
    employees = db.scalars(stmt).all()
    result = Result()
    if not employees:
        return result

    ids = [e.id for e in employees]
    holidays = _holidays(db, start, end)
    leaves = _approved_leaves(db, ids, start, end)
    rest_days = _rest_days(db, ids, start, end)

    # البصمات الموجودة مسبقاً في المدى (مع هامش الورديات الليلية)
    existing_punches = db.scalars(
        select(Punch).where(
            Punch.employee_id.in_(ids),
            Punch.punch_time >= _midnight(start - timedelta(days=1)),
            Punch.punch_time < _midnight(end + timedelta(days=2)),
        )
    ).all()
    by_employee: dict[int, list[Punch]] = {}
    for p in existing_punches:
        by_employee.setdefault(p.employee_id, []).append(p)

    for emp in employees:
        rules = ShiftRules(emp.shift, emp.weekly_rest_days)
        emp_punches = by_employee.get(emp.id, [])
        marked_for_employee = 0
        day = start
        while day <= end:
            reason = _skip_reason(emp, day, rules, holidays, leaves, rest_days, today)
            if reason:
                setattr(result, reason, getattr(result, reason) + 1)
                day += timedelta(days=1)
                continue

            win_start, win_end = rules.window(day)
            if any(win_start <= p.punch_time < win_end for p in emp_punches):
                result.skipped_existing += 1
                day += timedelta(days=1)
                continue

            for moment, kind in (
                (rules.scheduled_in(day), PunchType.in_),
                (rules.scheduled_out(day), PunchType.out),
            ):
                db.add(
                    Punch(
                        employee_code=emp.code,
                        employee_id=emp.id,
                        punch_time=moment,
                        punch_type=kind,
                        source=PunchSource.manual,
                        note=NOTE,
                    )
                )
                result.punches_created += 1
            result.days_marked += 1
            marked_for_employee += 1
            day += timedelta(days=1)

        if marked_for_employee:
            result.employees += 1
            result.names.append(emp.full_name)

    db.flush()
    result.recomputed_days = recompute(db, start, end, ids, commit=False)
    db.commit()
    return result


def _skip_reason(emp, day, rules, holidays, leaves, rest_days, today) -> str | None:
    if emp.hire_date and day < emp.hire_date:
        return "skipped_before_hire"
    if day > today:
        return "skipped_future"
    if day.weekday() not in rules.work_days or (emp.id, day) in rest_days:
        return "skipped_rest"
    if day in holidays:
        return "skipped_holiday"
    if (emp.id, day) in leaves:
        return "skipped_leave"
    return None


def _midnight(day: date):
    from datetime import datetime, time

    return datetime.combine(day, time(0, 0))
