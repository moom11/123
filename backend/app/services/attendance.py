"""احتساب الحضور والانصراف من البصمات الخام وفق الورديات والإجازات والعطل."""
from __future__ import annotations

import json
from dataclasses import replace
from datetime import date, datetime, time, timedelta

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from ..models import (
    AttendanceDay,
    AttendanceEvent,
    BreakPeriod,
    DayStatus,
    Employee,
    EmployeeStatus,
    Holiday,
    LeaveRequest,
    LeaveStatus,
    Punch,
    RestDay,
    Shift,
)
from . import workstate
from .policies import Policy, resolve_many

DEFAULT_SHIFT_START = time(8, 0)
DEFAULT_SHIFT_END = time(16, 0)
DEFAULT_WORK_DAYS = [6, 0, 1, 2, 3]  # الأحد إلى الخميس (ترقيم بايثون: 0=الاثنين)


def _parse_hhmm(value: str | None, fallback: time) -> time:
    """يقرأ «06:00» من لقطة محفوظة."""
    try:
        hour, minute = str(value).split(":")[:2]
        return time(int(hour), int(minute))
    except (AttributeError, ValueError):
        return fallback


def parse_rest_days(value: str | None) -> set[int] | None:
    """يقرأ أيام الراحة الأسبوعية «4,5» ويعيد None إن لم تُحدَّد."""
    if value is None:
        return None
    days = {int(part) for part in str(value).split(",") if part.strip().isdigit()}
    days = {day for day in days if 0 <= day <= 6}
    return days if days else None


class ShiftRules:
    """قواعد الوردية المستخدمة في الاحتساب (مع قيم افتراضية إن لم تُسند وردية).

    إن كانت للموظف أيام راحة أسبوعية خاصة به فهي التي تحدد أيام عمله،
    فيمكن أن تختلف راحة كل موظف داخل الوردية نفسها.
    """

    def __init__(self, shift: Shift | None, rest_days: str | None = None):
        if shift:
            self.shift_id = shift.id
            self.label = shift.name
            self.start = shift.start_time
            self.end = shift.end_time
            self.grace_in = shift.grace_in_minutes
            self.grace_out = shift.grace_out_minutes
            self.break_minutes = shift.break_minutes
            self.work_days = shift.work_day_list or DEFAULT_WORK_DAYS
            self.is_night = shift.is_night_shift
        else:
            self.shift_id = None
            self.label = "دوام افتراضي"
            self.start = DEFAULT_SHIFT_START
            self.end = DEFAULT_SHIFT_END
            self.grace_in = 10
            self.grace_out = 10
            self.break_minutes = 0
            self.work_days = DEFAULT_WORK_DAYS
            self.is_night = False

        rest = parse_rest_days(rest_days)
        if rest is not None:
            self.work_days = [day for day in range(7) if day not in rest]

    # ------------------- لقطة الوردية: حفظ الماضي كما وقع -------------------
    def snapshot(self) -> dict:
        """قيم هذه الوردية كما هي الآن، لتُحفظ مع اليوم المحسوب بها."""
        return {
            "shift_id": self.shift_id,
            "label": self.label,
            "start": self.start.strftime("%H:%M"),
            "end": self.end.strftime("%H:%M"),
            "grace_in": self.grace_in,
            "grace_out": self.grace_out,
            "break_minutes": self.break_minutes,
            "work_days": list(self.work_days),
            "is_night": bool(self.is_night),
        }

    @classmethod
    def from_snapshot(cls, data: dict) -> "ShiftRules":
        """يعيد بناء قواعد الوردية من لقطة محفوظة، بلا رجوع إلى وردية الموظف اليوم."""
        rules = cls(None)
        rules.shift_id = data.get("shift_id")
        rules.label = data.get("label") or "وردية محفوظة"
        rules.start = _parse_hhmm(data.get("start"), DEFAULT_SHIFT_START)
        rules.end = _parse_hhmm(data.get("end"), DEFAULT_SHIFT_END)
        rules.grace_in = int(data.get("grace_in") or 0)
        rules.grace_out = int(data.get("grace_out") or 0)
        rules.break_minutes = int(data.get("break_minutes") or 0)
        days = data.get("work_days")
        rules.work_days = [int(d) for d in days] if days else DEFAULT_WORK_DAYS
        rules.is_night = bool(data.get("is_night"))
        return rules

    def describe(self) -> str:
        return f"{self.label} ({self.start:%H:%M}–{self.end:%H:%M})"

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


def _rest_days(db: Session, employee_ids: list[int], start: date, end: date) -> set[tuple[int, date]]:
    """أيام الراحة المجدولة (الراحة الشهرية) لكل موظف ضمن المدى."""
    rows = db.scalars(
        select(RestDay).where(
            RestDay.employee_id.in_(employee_ids),
            RestDay.rest_date >= start,
            RestDay.rest_date <= end,
        )
    ).all()
    return {(row.employee_id, row.rest_date) for row in rows}


def compute_day(
    employee: Employee,
    day: date,
    punches: list[Punch],
    rules: ShiftRules,
    holiday_name: str | None,
    leave: LeaveRequest | None,
    is_rest_day: bool = False,
    policy: Policy | None = None,
) -> tuple[dict, workstate.DaySession]:
    """يحسب ملخص يوم واحد لموظف واحد من أحداث آلة الحالات.

    يعيد (قيم اليوم، جلسة اليوم): الجلسة تحمل الأحداث كما فُسِّرت والاستراحات
    كلٌّ بمدتها، فتُحفظ بعدها سجلات مستقلة لكل استراحة.
    """
    policy = policy or Policy()
    if employee.no_break:
        # لا يأخذ استراحة: لا تُخصم استراحة الوردية الثابتة، وأي استراحة يأخذها
        # تُحتسب تجاوزاً من أول دقيقة بعد دقائق السماح
        policy = replace(policy, break_allowance_minutes=0, max_total_break_minutes=0)
    session = workstate.replay(punches, rules.scheduled_out(day), policy)
    check_in = session.check_in
    check_out = session.check_out

    late = early = overtime = 0
    # يوم راحة مجدول (الراحة الشهرية) يعامل معاملة الراحة الأسبوعية
    is_work_day = day.weekday() in rules.work_days and not is_rest_day
    fixed_break = 0 if employee.no_break else rules.break_minutes
    worked = workstate.worked_minutes(session, policy, fixed_break)

    if is_work_day and check_in:
        allowed_in = rules.scheduled_in(day) + timedelta(minutes=policy.late_grace_minutes)
        if check_in > allowed_in:
            late = int((check_in - rules.scheduled_in(day)).total_seconds() // 60)
        if check_out:
            allowed_out = rules.scheduled_out(day) - timedelta(
                minutes=policy.early_leave_grace_minutes
            )
            if check_out < allowed_out:
                early = int((rules.scheduled_out(day) - check_out).total_seconds() // 60)
            extra = int((check_out - rules.scheduled_out(day)).total_seconds() // 60)
            if extra > rules.grace_out:
                overtime = extra
    elif not is_work_day and worked:
        overtime = worked  # عمل في يوم راحة يُحتسب كاملاً وقتاً إضافياً

    open_break = session.open_break
    shift_ended = datetime.now() >= rules.scheduled_out(day)

    if check_in and check_out:
        status = DayStatus.late if late > 0 else DayStatus.present
    elif check_in and open_break and shift_ended:
        # انتهت الوردية والاستراحة ما زالت مفتوحة: النظام لا يخترع وقت عودة
        status = DayStatus.needs_review
    elif check_in:
        status = DayStatus.missing_out
    elif leave is not None:
        status = DayStatus.leave
    elif holiday_name:
        status = DayStatus.holiday
    elif not is_work_day:
        status = DayStatus.weekend
    elif day > date.today() or (
        day == date.today()
        and datetime.now() < rules.scheduled_in(day) + timedelta(minutes=policy.late_grace_minutes)
    ):
        # يوم عمل لم يبدأ بعد: لا يُكتب غياباً لمن لم يحن دوامه — الوردية
        # المسائية مثلاً تبقى «لم يحن بعد» طوال الصباح
        status = DayStatus.scheduled
    else:
        status = DayStatus.absent

    overrun = session.overrun_minutes(policy)

    note = None
    if status == DayStatus.weekend and is_rest_day:
        note = "يوم راحة مجدول"
    if status == DayStatus.holiday:
        note = holiday_name
    elif status == DayStatus.leave and leave is not None:
        note = leave.leave_type.name if leave.leave_type else "إجازة معتمدة"
    elif status == DayStatus.needs_review:
        note = f"استراحة مفتوحة منذ {open_break.start_at:%H:%M} بلا تسجيل عودة"
    elif open_break:
        note = f"استراحة مفتوحة منذ {open_break.start_at:%H:%M}"
    elif overrun:
        note = f"تجاوز وقت الاستراحة بـ {overrun} دقيقة"

    data = {
        "employee_id": employee.id,
        "work_date": day,
        "check_in": check_in,
        "check_out": check_out,
        "worked_minutes": worked,
        "late_minutes": late,
        "early_leave_minutes": early,
        "overtime_minutes": overtime,
        "status": status,
        "punches_count": session.punches_count(),
        "presence_minutes": session.presence_minutes,
        "break_minutes": session.break_minutes,
        "break_count": session.break_count,
        "break_overrun_minutes": overrun,
        "open_break": open_break is not None,
        "leave_request_id": leave.id if leave else None,
        "note": note,
        "shift_snapshot": json.dumps(rules.snapshot(), ensure_ascii=False),
    }
    return data, session


def _rules_for_day(
    current: ShiftRules,
    row: AttendanceDay | None,
    day: date,
    today: date,
    use_current_shift: bool,
) -> ShiftRules:
    """قواعد احتساب هذا اليوم: لقطته المحفوظة إن كان قد مضى، وإلا الوردية الحالية.

    اليوم الجاري وما بعده يتبعان الوردية الحالية دائماً، فتعديل الوردية يسري
    من اليوم فصاعداً بلا مساس بما مضى.
    """
    if use_current_shift or day >= today or row is None or not row.shift_snapshot:
        return current
    try:
        return ShiftRules.from_snapshot(json.loads(row.shift_snapshot))
    except (ValueError, TypeError):
        return current


def recompute(
    db: Session,
    start: date,
    end: date,
    employee_ids: list[int] | None = None,
    commit: bool = True,
    use_current_shift: bool = False,
) -> int:
    """يعيد احتساب أيام الحضور لمدى تواريخ ومجموعة موظفين ويحفظها. يعيد عدد الأيام.

    الأيام التي مضت تُحسب بلقطة الوردية المحفوظة معها، لا بوردية الموظف اليوم،
    فلا يعيد تعديلُ الوردية كتابةَ الماضي. و`use_current_shift=True` هو الاستثناء
    الصريح: أعد حساب الماضي بالوردية الحالية (لتصحيح إسناد خاطئ مثلاً).
    """
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
    rest_days = _rest_days(db, ids, start, end)
    policies = resolve_many(db, list(employees))

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

    # الأحداث والاستراحات تُبنى من جديد في كل احتساب فتبقى مطابقة للبصمات
    _clear_derived(db, ids, start, end)

    count = 0
    today = date.today()
    overruns: list[tuple[Employee, date, int]] = []
    open_breaks: list[tuple[Employee, date, datetime]] = []
    for emp in employees:
        rules = ShiftRules(emp.shift, emp.weekly_rest_days)
        policy = policies.get(emp.id, Policy())
        emp_punches = by_employee.get(emp.id, [])
        day = start
        while day <= end:
            if emp.hire_date and day < emp.hire_date:
                day += timedelta(days=1)
                continue
            row = existing.get((emp.id, day))
            day_rules = _rules_for_day(rules, row, day, today, use_current_shift)
            win_start, win_end = day_rules.window(day)
            day_punches = [p for p in emp_punches if win_start <= p.punch_time < win_end]
            data, session = compute_day(
                emp, day, day_punches, day_rules, holidays.get(day), leaves.get((emp.id, day)),
                is_rest_day=(emp.id, day) in rest_days, policy=policy,
            )
            if row is None:
                row = AttendanceDay(**data)
                db.add(row)
                existing[(emp.id, day)] = row
            else:
                for key, value in data.items():
                    setattr(row, key, value)

            _save_events(db, emp, day, session)
            _save_breaks(db, emp, day, session)
            overrun = session.overrun_minutes(policy)
            if overrun and not session.open_break:
                overruns.append((emp, day, overrun))
            if data["status"] == DayStatus.needs_review and session.open_break:
                open_breaks.append((emp, day, session.open_break.start_at))
            count += 1
            day += timedelta(days=1)

    _alert_break_issues(db, overruns, open_breaks)

    if commit:
        db.commit()
    return count


ALERT_WINDOW_DAYS = 2   # لا تُنبَّه الإدارة على أيام قديمة عند إعادة احتساب واسعة


def _alert_break_issues(db: Session, overruns: list, open_breaks: list) -> None:
    """تنبيه الإدارة والموظف عند تجاوز الاستراحة، وتسجيل مخالفة عند بلوغ الحد."""
    from ..models import Role, SentAlert
    from . import notifications, settings_store

    today = date.today()
    notify_employee = settings_store.get_bool(db, "break_alert_employee")
    for emp, day, minutes in overruns:
        if (today - day).days > ALERT_WINDOW_DAYS:
            continue
        if not _mark_once(db, SentAlert, f"break_overrun:{emp.id}:{day}"):
            continue
        notifications.notify_roles(
            db, [Role.admin, Role.hr],
            title="تجاوز وقت الاستراحة",
            body=f"الموظف {emp.full_name} تجاوز وقت البريك المسموح بـ {minutes} دقيقة.",
            category="attendance",
            link_page="attendance",
            commit=False,
        )
        if notify_employee:
            notifications.notify_employee(
                db, emp.id,
                title="تجاوزت وقت الاستراحة",
                body=(f"تجاوزت وقت البريك المسموح بـ {minutes} دقيقة في يوم {day}."
                      " الرجاء الالتزام بالمدة المحددة."),
                category="attendance",
                link_page="dashboard",
                commit=False,
            )
        _record_break_violation(db, emp, day, minutes)
    for emp, day, since in open_breaks:
        if (today - day).days > ALERT_WINDOW_DAYS:
            continue
        if not _mark_once(db, SentAlert, f"break_open:{emp.id}:{day}"):
            continue
        notifications.notify_roles(
            db, [Role.admin, Role.hr],
            title="استراحة مفتوحة",
            body=f"الموظف {emp.full_name} بدأ استراحة {since:%H:%M} ولم يسجّل العودة.",
            category="attendance",
            link_page="attendance",
            commit=False,
        )


def _record_break_violation(db: Session, emp, day: date, minutes: int) -> None:
    """يسجّل مخالفة «تجاوز وقت الاستراحة» تلقائياً عند بلوغ الحد المضبوط.

    تُسجَّل بحالة «بانتظار إقرار الموظف» كأي مخالفة، فله أن يقرّ أو يتظلّم،
    ولا تُخصم من الراتب إلا بعد اعتماد الموارد البشرية.
    """
    from ..models import Violation, ViolationStatus, ViolationType
    from . import settings_store, violations as violations_service

    if not settings_store.get_bool(db, "break_violation_enabled"):
        return
    threshold = settings_store.get_int(db, "break_violation_after_minutes", 15)
    if threshold <= 0 or minutes < threshold:
        return

    vtype = db.scalar(select(ViolationType).where(ViolationType.code == "break_overrun"))
    if not vtype or not vtype.is_active:
        return
    exists = db.scalar(
        select(Violation).where(
            Violation.employee_id == emp.id,
            Violation.violation_type_id == vtype.id,
            Violation.occurred_on == day,
        )
    )
    if exists:
        return

    violation = Violation(
        employee_id=emp.id,
        violation_type_id=vtype.id,
        occurred_on=day,
        description=f"تجاوز وقت الاستراحة المسموح بـ {minutes} دقيقة (رصد تلقائي من نظام الحضور)",
        status=ViolationStatus.pending,
    )
    db.add(violation)
    db.flush()
    violations_service.apply_penalty(db, violation)


def _mark_once(db: Session, model, key: str) -> bool:
    """يعيد True مرة واحدة فقط لكل مفتاح تنبيه."""
    if db.scalar(select(model).where(model.key == key)):
        return False
    db.add(model(key=key))
    db.flush()
    return True


def _clear_derived(db: Session, ids: list[int], start: date, end: date) -> None:
    """يحذف الأحداث والاستراحات المشتقة في المدى قبل إعادة بنائها.

    البصمات الخام لا تُمس: هذه سجلات مُشتقة تُبنى منها في كل مرة.
    """
    db.query(AttendanceEvent).filter(
        AttendanceEvent.employee_id.in_(ids),
        AttendanceEvent.work_date >= start,
        AttendanceEvent.work_date <= end,
    ).delete(synchronize_session=False)
    db.query(BreakPeriod).filter(
        BreakPeriod.employee_id.in_(ids),
        BreakPeriod.work_date >= start,
        BreakPeriod.work_date <= end,
    ).delete(synchronize_session=False)


def _save_events(db: Session, emp: Employee, day: date, session) -> None:
    """يحفظ أحداث اليوم بالترتيب الزمني مع لقطة بيانات كل حدث."""
    for event in session.events:
        punch = event.punch
        db.add(AttendanceEvent(
            employee_id=emp.id,
            employee_name=emp.full_name,
            employee_code=emp.code,
            punch_id=punch.id,
            work_date=day,
            event_time=event.event_time,
            received_at=punch.created_at,
            event_type=event.event_type,
            state_before=event.state_before,
            state_after=event.state_after,
            source=punch.source,
            device_id=punch.device_id,
            device_name=punch.device.name if punch.device else None,
            site_id=punch.site_id,
            site_name=punch.site.name if punch.site else (emp.site.name if emp.site else None),
            shift_id=emp.shift_id,
            shift_name=emp.shift.name if emp.shift else None,
            note=punch.note,
        ))


def _save_breaks(db: Session, emp: Employee, day: date, session) -> None:
    """يحفظ كل استراحة سجلاً مستقلاً بمدتها، بلا حد لعددها."""
    for span in session.breaks:
        db.add(BreakPeriod(
            employee_id=emp.id,
            work_date=day,
            sequence=span.sequence,
            start_at=span.start_at,
            end_at=span.end_at,
            minutes=span.minutes,
            is_open=span.is_open,
        ))


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
