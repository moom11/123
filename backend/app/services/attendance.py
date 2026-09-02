"""احتساب الحضور والانصراف من البصمات الخام وفق الورديات والإجازات والعطل."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from ..models import (
    AttendanceDay,
    DayStatus,
    Employee,
    EmployeeStatus,
    Holiday,
    LeaveRequest,
    LeaveStatus,
    Punch,
    Shift,
)

DEFAULT_SHIFT_START = time(8, 0)
DEFAULT_SHIFT_END = time(16, 0)
DEFAULT_WORK_DAYS = [6, 0, 1, 2, 3]  # الأحد إلى الخميس (ترقيم بايثون: 0=الاثنين)


class ShiftRules:
    """قواعد الوردية المستخدمة في الاحتساب (مع قيم افتراضية إن لم تُسند وردية)."""

    def __init__(self, shift: Shift | None):
        if shift:
            self.start = shift.start_time
            self.end = shift.end_time
            self.grace_in = shift.grace_in_minutes
            self.grace_out = shift.grace_out_minutes
            self.break_minutes = shift.break_minutes
            self.work_days = shift.work_day_list or DEFAULT_WORK_DAYS
            self.is_night = shift.is_night_shift
        else:
            self.start = DEFAULT_SHIFT_START
            self.end = DEFAULT_SHIFT_END
            self.grace_in = 10
            self.grace_out = 10
            self.break_minutes = 0
            self.work_days = DEFAULT_WORK_DAYS
            self.is_night = False

    def scheduled_in(self, day: date) -> datetime:
        return datetime.combine(day, self.start)

    def scheduled_out(self, day: date) -> datetime:
        end = datetime.combine(day, self.end)
        if self.is_night or self.end <= self.start:
            end += timedelta(days=1)
        return end

    def scheduled_minutes(self, day: date) -> int:
        total = (self.scheduled_out(day) - self.scheduled_in(day)).total_seconds() / 60
        return max(0, int(total) - self.break_minutes)

    def window(self, day: date) -> tuple[datetime, datetime]:
        """نافذة زمنية لالتقاط بصمات هذا اليوم (تمتد لليوم التالي في الورديات الليلية)."""
        start = datetime.combine(day, time(0, 0))
        if self.is_night or self.end <= self.start:
            return self.scheduled_in(day) - timedelta(hours=4), self.scheduled_out(day) + timedelta(hours=6)
        return start, start + timedelta(days=1)


def _holidays(db: Session, start: date, end: date) -> dict[date, str]:
    rows = db.scalars(
        select(Holiday).where(and_(Holiday.holiday_date >= start, Holiday.holiday_date <= end))
    ).all()
    return {h.holiday_date: h.name for h in rows}


def _approved_leaves(db: Session, employee_ids: list[int], start: date, end: date):
    stmt = select(LeaveRequest).where(
        LeaveRequest.status == LeaveStatus.approved,
        LeaveRequest.employee_id.in_(employee_ids),
        LeaveRequest.start_date <= end,
        LeaveRequest.end_date >= start,
    )
    result: dict[tuple[int, date], LeaveRequest] = {}
    for lr in db.scalars(stmt).all():
        current = max(lr.start_date, start)
        last = min(lr.end_date, end)
        while current <= last:
            result[(lr.employee_id, current)] = lr
            current += timedelta(days=1)
    return result


def compute_day(
    employee: Employee,
    day: date,
    punches: list[Punch],
    rules: ShiftRules,
    holiday_name: str | None,
    leave: LeaveRequest | None,
) -> dict:
    """يحسب ملخص يوم واحد لموظف واحد ويعيد قاموساً بالقيم."""
    punches = sorted(punches, key=lambda p: p.punch_time)
    check_in = punches[0].punch_time if punches else None
    check_out = punches[-1].punch_time if len(punches) > 1 else None

    worked = late = early = overtime = 0
    is_work_day = day.weekday() in rules.work_days

    if check_in and check_out:
        worked = int((check_out - check_in).total_seconds() // 60) - rules.break_minutes
        worked = max(worked, 0)

    if is_work_day and check_in:
        allowed_in = rules.scheduled_in(day) + timedelta(minutes=rules.grace_in)
        if check_in > allowed_in:
            late = int((check_in - rules.scheduled_in(day)).total_seconds() // 60)
        if check_out:
            allowed_out = rules.scheduled_out(day) - timedelta(minutes=rules.grace_out)
            if check_out < allowed_out:
                early = int((rules.scheduled_out(day) - check_out).total_seconds() // 60)
            extra = int((check_out - rules.scheduled_out(day)).total_seconds() // 60)
            if extra > rules.grace_out:
                overtime = extra
    elif not is_work_day and worked:
        overtime = worked  # عمل في يوم راحة يُحتسب كاملاً وقتاً إضافياً

    if check_in and check_out:
        status = DayStatus.late if late > 0 else DayStatus.present
    elif check_in:
        status = DayStatus.missing_out
    elif leave is not None:
        status = DayStatus.leave
    elif holiday_name:
        status = DayStatus.holiday
    elif not is_work_day:
        status = DayStatus.weekend
    elif day > date.today():
        status = DayStatus.scheduled   # يوم عمل قادم: لا يُحتسب غياباً
    else:
        status = DayStatus.absent

    note = None
    if status == DayStatus.holiday:
        note = holiday_name
    elif status == DayStatus.leave and leave is not None:
        note = leave.leave_type.name if leave.leave_type else "إجازة معتمدة"

    return {
        "employee_id": employee.id,
        "work_date": day,
        "check_in": check_in,
        "check_out": check_out,
        "worked_minutes": worked,
        "late_minutes": late,
        "early_leave_minutes": early,
        "overtime_minutes": overtime,
        "status": status,
        "punches_count": len(punches),
        "leave_request_id": leave.id if leave else None,
        "note": note,
    }


def recompute(
    db: Session,
    start: date,
    end: date,
    employee_ids: list[int] | None = None,
    commit: bool = True,
) -> int:
    """يعيد احتساب أيام الحضور لمدى تواريخ ومجموعة موظفين ويحفظها. يعيد عدد الأيام."""
    if start > end:
        start, end = end, start

    emp_stmt = select(Employee).where(Employee.status == EmployeeStatus.active)
    if employee_ids:
        emp_stmt = select(Employee).where(Employee.id.in_(employee_ids))
    employees = db.scalars(emp_stmt).all()
    if not employees:
        return 0

    ids = [e.id for e in employees]
    holidays = _holidays(db, start, end)
    leaves = _approved_leaves(db, ids, start, end)

    # كل البصمات في المدى (مع هامش يوم للورديات الليلية)
    punch_rows = db.scalars(
        select(Punch).where(
            Punch.employee_id.in_(ids),
            Punch.punch_time >= datetime.combine(start - timedelta(days=1), time(0, 0)),
            Punch.punch_time < datetime.combine(end + timedelta(days=2), time(0, 0)),
        )
    ).all()
    by_employee: dict[int, list[Punch]] = {}
    for p in punch_rows:
        by_employee.setdefault(p.employee_id, []).append(p)

    existing = {
        (row.employee_id, row.work_date): row
        for row in db.scalars(
            select(AttendanceDay).where(
                AttendanceDay.employee_id.in_(ids),
                AttendanceDay.work_date >= start,
                AttendanceDay.work_date <= end,
            )
        ).all()
    }

    count = 0
    for emp in employees:
        rules = ShiftRules(emp.shift)
        emp_punches = by_employee.get(emp.id, [])
        day = start
        while day <= end:
            if emp.hire_date and day < emp.hire_date:
                day += timedelta(days=1)
                continue
            win_start, win_end = rules.window(day)
            day_punches = [p for p in emp_punches if win_start <= p.punch_time < win_end]
            data = compute_day(
                emp, day, day_punches, rules, holidays.get(day), leaves.get((emp.id, day))
            )
            row = existing.get((emp.id, day))
            if row is None:
                row = AttendanceDay(**data)
                db.add(row)
                existing[(emp.id, day)] = row
            else:
                for key, value in data.items():
                    setattr(row, key, value)
            count += 1
            day += timedelta(days=1)

    if commit:
        db.commit()
    return count


def recompute_for_punches(db: Session, punches: list[Punch]) -> int:
    """يعيد احتساب الأيام المتأثرة ببصمات مستوردة حديثاً."""
    targets: dict[int, list[date]] = {}
    for p in punches:
        if p.employee_id:
            targets.setdefault(p.employee_id, []).append(p.punch_time.date())
    total = 0
    for emp_id, days in targets.items():
        start = min(days) - timedelta(days=1)
        end = max(days)
        total += recompute(db, start, end, [emp_id], commit=False)
    if targets:
        db.commit()
    return total
