"""بياناتي: يطّلع الموظف على بياناته ويحدّث ما يخصّه منها بنفسه."""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    AttendanceDay,
    AttendanceEvent,
    DayStatus,
    EventType,
    Notification,
    Employee,
    LeaveRequest,
    LeaveStatus,
    Punch,
    RestDay,
    Role,
    User,
    WorkState,
)
from ..schemas import (
    HomeDay,
    HomeEvent,
    MyHomeOut,
    MyProfileIn,
    MyProfileOut,
    SalaryToDateOut,
)
from ..security import get_current_user
from ..services import accounts, audit, notifications, policies, settings_store
from ..services import attendance as attendance_service
from ..services import payroll as payroll_service
from ..services import workstate

router = APIRouter(prefix="/api/me", tags=["me"])

EDITABLE_LABELS = {
    "national_id": "رقم الهوية / الإقامة",
    "phone": "رقم الجوال",
    "email": "البريد الإلكتروني",
}


def _employee_of(db: Session, user: User) -> Employee:
    employee = db.get(Employee, user.employee_id) if user.employee_id else None
    if not employee:
        raise HTTPException(status_code=400, detail="حسابك غير مرتبط بملف موظف")
    return employee


def profile_out(employee: Employee) -> MyProfileOut:
    return MyProfileOut(
        employee_id=employee.id,
        code=employee.code,
        full_name=employee.full_name,
        job_title=employee.job_title,
        department_name=employee.department.name if employee.department else None,
        shift_name=employee.shift.name if employee.shift else None,
        site_name=employee.site.name if employee.site else None,
        hire_date=employee.hire_date,
        national_id=employee.national_id,
        phone=employee.phone,
        email=employee.email,
        weekly_rest_days=employee.weekly_rest_days,
        basic_salary=employee.basic_salary or 0,
        allowances=employee.allowances or 0,
        total_salary=round((employee.basic_salary or 0) + (employee.allowances or 0), 2),
    )


@router.get("/profile", response_model=MyProfileOut)
def my_profile(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return profile_out(_employee_of(db, user))


@router.put("/profile", response_model=MyProfileOut)
def update_my_profile(
    payload: MyProfileIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """يحدّث الموظف هويته وجواله وبريده فقط — وبقية البيانات للموارد البشرية."""
    employee = _employee_of(db, user)
    data = payload.model_dump(exclude_unset=True)

    phone = (data.get("phone") or "").strip()
    if phone:
        conflict = accounts.phone_conflict(db, phone, employee.id)
        if conflict:
            raise HTTPException(
                status_code=400,
                detail="رقم الجوال مسجّل لموظف آخر — راجع الموارد البشرية",
            )

    changed: list[str] = []
    for field, label in EDITABLE_LABELS.items():
        if field not in data:
            continue
        value = (data[field] or "").strip() or None
        if value != getattr(employee, field):
            setattr(employee, field, value)
            changed.append(label)

    if not changed:
        return profile_out(employee)

    audit.log(db, user, "update", "employee", employee.id,
              "تحديث ذاتي: " + "، ".join(changed), commit=False)
    notifications.notify_roles(
        db, [Role.admin, Role.hr],
        f"{employee.full_name} حدّث بياناته",
        body="الحقول: " + "، ".join(changed),
        category="employee", link_page="employees", commit=False,
    )
    db.commit()
    db.refresh(employee)
    return profile_out(employee)


# ------------------------------ الشاشة الرئيسية للموظف ------------------------------
WEEKDAY_NAMES = ["الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"]
STATUS_LABELS = {
    DayStatus.present: "حاضر",
    DayStatus.late: "متأخر",
    DayStatus.absent: "غياب",
    DayStatus.leave: "إجازة",
    DayStatus.holiday: "عطلة رسمية",
    DayStatus.weekend: "راحة",
    DayStatus.missing_out: "لم يسجّل الانصراف",
    DayStatus.scheduled: "دوام قادم",
}


def _time_label(value: datetime | None) -> str:
    if not value:
        return ""
    hour = value.hour % 12 or 12
    return f"{hour}:{value:%M} {'ص' if value.hour < 12 else 'م'}"


@router.get("/salary-to-date", response_model=SalaryToDateOut)
def my_salary_to_date(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """كم استحقّ الموظف من راتبه من بداية الشهر حتى اليوم، وما عليه من خصومات."""
    employee = _employee_of(db, user)
    return SalaryToDateOut(**payroll_service.earned_to_date(db, employee))


@router.get("/home", response_model=MyHomeOut)
def my_home(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """كل ما تحتاجه شاشة الموظف الرئيسية في طلب واحد: حالته الآن، وزره، وأسبوعه."""
    employee = _employee_of(db, user)
    today = date.today()

    # أسبوع يبدأ من الأحد
    start = today - timedelta(days=(today.weekday() + 1) % 7)
    end = start + timedelta(days=6)
    attendance_service.recompute(db, start, min(end, today), [employee.id])

    rows = {
        row.work_date: row
        for row in db.scalars(
            select(AttendanceDay).where(
                AttendanceDay.employee_id == employee.id,
                AttendanceDay.work_date >= start,
                AttendanceDay.work_date <= end,
            )
        ).all()
    }
    rest_dates = {
        row.rest_date
        for row in db.scalars(
            select(RestDay).where(
                RestDay.employee_id == employee.id,
                RestDay.rest_date >= start,
                RestDay.rest_date <= end,
            )
        ).all()
    }

    rules = attendance_service.ShiftRules(employee.shift, employee.weekly_rest_days)
    shift_label = f"{rules.start:%H:%M} - {rules.end:%H:%M}"
    today_row = rows.get(today)
    is_workday = today.weekday() in rules.work_days and today not in rest_dates

    # ------------------------- حالة الموظف الآن -------------------------
    # تُقرأ من آخر حدث فسّرته آلة الحالات، لا من ترتيب البصمات
    policy = policies.resolve(db, employee)
    last_event = db.scalar(
        select(AttendanceEvent)
        .where(AttendanceEvent.employee_id == employee.id, AttendanceEvent.work_date == today)
        .order_by(AttendanceEvent.event_time.desc(), AttendanceEvent.id.desc())
        .limit(1)
    )
    work_state = last_event.state_after if last_event else WorkState.out
    now = datetime.now()

    break_started_at = None
    break_elapsed = 0
    secondary_action = secondary_label = None
    state_detail = ""

    if work_state is WorkState.on_break:
        break_started_at = last_event.event_time
        break_elapsed = max(0, int((now - break_started_at).total_seconds() // 60))
        state = "break"
        state_label = "أنت الآن في استراحة"
        state_detail = f"بدأت {_time_label(break_started_at)} — مضى {break_elapsed} دقيقة"
        action, action_label = "break_end", "إنهاء الاستراحة"
    elif work_state is WorkState.working:
        state = "in"
        state_label = "أنت الآن داخل العمل"
        state_detail = f"بدأت دوامك {_time_label(today_row.check_in if today_row else None)}"
        # داخل نافذة الانصراف لا استراحة إطلاقاً: زر واحد للانصراف
        clock_out_from = rules.scheduled_out(today) - timedelta(
            minutes=max(0, policy.clock_out_from_minutes)
        )
        if now >= clock_out_from:
            action, action_label = "clock_out", "تسجيل انصراف"
            state_detail += f" — لا استراحة في آخر {policy.clock_out_from_minutes} دقيقة"
        else:
            action, action_label = "break_start", "بدء استراحة"
            secondary_action, secondary_label = "clock_out", "تسجيل انصراف"
    elif today_row and today_row.check_in and today_row.check_out:
        state = "done"
        state_label = "أنت الآن خارج العمل"
        state_detail = f"آخر انصراف {_time_label(today_row.check_out)}"
        action, action_label = "clock_in", "تسجيل حضور جديد"
    elif not is_workday:
        state, state_label = "off", "اليوم راحتك"
        action, action_label = "clock_in", "تسجيل حضور"
    else:
        state = "out"
        state_label = "أنت الآن خارج العمل"
        last_out = db.scalar(
            select(AttendanceDay)
            .where(AttendanceDay.employee_id == employee.id, AttendanceDay.check_out.isnot(None))
            .order_by(AttendanceDay.work_date.desc())
            .limit(1)
        )
        if last_out and last_out.check_out:
            state_detail = f"آخر انصراف {_time_label(last_out.check_out)} — {last_out.work_date}"
        action, action_label = "clock_in", "تسجيل حضور"

    last_punch = db.scalar(
        select(Punch)
        .where(Punch.employee_id == employee.id)
        .order_by(Punch.punch_time.desc())
        .limit(1)
    )
    last_kind = None
    if last_punch and today_row:
        if today_row.check_out and last_punch.punch_time == today_row.check_out:
            last_kind = "انصراف"
        elif today_row.check_in and last_punch.punch_time == today_row.check_in:
            last_kind = "حضور"
    last_site = last_punch.site.name if last_punch and last_punch.site else None

    pending = len(db.scalars(
        select(LeaveRequest).where(
            LeaveRequest.employee_id == employee.id,
            LeaveRequest.status == LeaveStatus.pending,
        )
    ).all())

    alert = None
    if today_row and today_row.late_minutes:
        alert = f"سُجّل تأخيرك اليوم {today_row.late_minutes} دقيقة"
    elif is_workday and state == "out" and datetime.now() > rules.scheduled_in(today):
        minutes = int((datetime.now() - rules.scheduled_in(today)).total_seconds() // 60)
        if minutes > rules.grace_in:
            alert = f"بدأ دوامك قبل {minutes} دقيقة ولم تسجّل حضورك"

    # ------------------------- أرقام الشاشة الرئيسية -------------------------
    day_events = db.scalars(
        select(AttendanceEvent)
        .where(AttendanceEvent.employee_id == employee.id, AttendanceEvent.work_date == today)
        .order_by(AttendanceEvent.event_time)
    ).all()
    clock_in_count = sum(1 for e in day_events if e.event_type == EventType.clock_in)

    # مدة العمل حتى هذه اللحظة: من الحضور إلى الآن (أو الانصراف) ناقص الاستراحات
    worked_live = today_row.worked_minutes if today_row else 0
    if today_row and today_row.check_in and not today_row.check_out:
        end = now if work_state is not WorkState.on_break else (
            break_started_at or now
        )
        elapsed = max(0, int((end - today_row.check_in).total_seconds() // 60))
        worked_live = max(0, elapsed - (today_row.break_minutes or 0))

    recent = db.scalars(
        select(AttendanceEvent)
        .where(AttendanceEvent.employee_id == employee.id)
        .order_by(AttendanceEvent.event_time.desc(), AttendanceEvent.id.desc())
        .limit(6)
    ).all()
    recent_events = [
        HomeEvent(
            at=row.event_time,
            type=row.event_type.value,
            label=workstate.EVENT_LABELS[row.event_type],
            site_name=row.site_name,
        )
        for row in recent
    ]

    unread = len(db.scalars(
        select(Notification).where(
            Notification.user_id == user.id, Notification.is_read.is_(False)
        )
    ).all())

    week: list[HomeDay] = []
    for offset in range(7):
        day = start + timedelta(days=offset)
        row = rows.get(day)
        day_off = day.weekday() not in rules.work_days or day in rest_dates
        status = row.status if row else (DayStatus.weekend if day_off else DayStatus.scheduled)
        week.append(HomeDay(
            date=day,
            weekday=WEEKDAY_NAMES[day.weekday()],
            status=status,
            label=STATUS_LABELS.get(status, ""),
            shift_label="راحة" if day_off else shift_label,
            check_in=row.check_in if row else None,
            check_out=row.check_out if row else None,
            is_today=(day == today),
        ))

    return MyHomeOut(
        employee_name=employee.full_name,
        job_title=employee.job_title,
        state=state,
        state_label=state_label,
        state_detail=state_detail,
        action=action,
        action_label=action_label,
        secondary_action=secondary_action,
        secondary_action_label=secondary_label,
        break_started_at=break_started_at,
        break_elapsed_minutes=break_elapsed,
        break_minutes=today_row.break_minutes if today_row else 0,
        break_count=today_row.break_count if today_row else 0,
        break_allowance_minutes=policy.break_allowance_minutes,
        break_overrun_minutes=today_row.break_overrun_minutes if today_row else 0,
        today_status=today_row.status if today_row else None,
        check_in=today_row.check_in if today_row else None,
        check_out=today_row.check_out if today_row else None,
        late_minutes=today_row.late_minutes if today_row else 0,
        worked_minutes=today_row.worked_minutes if today_row else 0,
        shift_name=employee.shift.name if employee.shift else "الدوام الافتراضي",
        shift_label=shift_label,
        is_workday=is_workday,
        site_name=employee.site.name if employee.site else None,
        requires_location=settings_store.get_bool(db, "web_punch_requires_location"),
        punch_enabled=settings_store.get_bool(db, "web_punch_enabled"),
        last_punch_at=last_punch.punch_time if last_punch else None,
        last_punch_kind=last_kind,
        last_punch_site=last_site,
        pending_requests=pending,
        unread_notifications=unread,
        worked_minutes_live=worked_live,
        clock_in_count=clock_in_count,
        expected_clock_ins=1,
        recent_events=recent_events,
        alert=alert,
        week=week,
    )
