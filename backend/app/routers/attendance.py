"""سجلات البصمات وكشوف الحضور اليومية والشهرية."""
from __future__ import annotations

import csv
import io
import json
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    AttendanceDay,
    AttendanceEvent,
    BreakPeriod,
    DayStatus,
    Employee,
    EmployeeStatus,
    Punch,
    PunchSource,
    PunchType,
    Role,
    User,
    WorkState,
)
from ..schemas import (
    AttendanceDayOut,
    AttendanceEventOut,
    AttendanceOverride,
    BreakOut,
    LiveStatusOut,
    PunchIn,
    PunchOut,
    SelfPunchIn,
    SelfPunchResult,
)
from ..security import (
    can_view_employee,
    get_current_user,
    require_hr,
    visible_employee_ids,
)
from ..services import attendance as attendance_service
from ..services import policies, workstate
from ..services import bulk_attendance
from ..services import audit, geo, settings_store, sheets

router = APIRouter(prefix="/api/attendance", tags=["attendance"])

STATUS_LABELS = {
    DayStatus.present: "حاضر",
    DayStatus.late: "متأخر",
    DayStatus.absent: "غائب",
    DayStatus.leave: "إجازة",
    DayStatus.holiday: "عطلة رسمية",
    DayStatus.weekend: "راحة أسبوعية",
    DayStatus.missing_out: "بصمة انصراف ناقصة",
    DayStatus.scheduled: "لم يحن بعد",
    DayStatus.needs_review: "تحتاج مراجعة",
}


def punch_out(p: Punch) -> PunchOut:
    return PunchOut(
        id=p.id,
        employee_id=p.employee_id,
        employee_code=p.employee_code,
        employee_name=p.employee.full_name if p.employee else None,
        punch_time=p.punch_time,
        punch_type=p.punch_type,
        source=p.source,
        device_id=p.device_id,
        device_name=p.device.name if p.device else None,
        verify_mode=p.verify_mode,
        latitude=p.latitude,
        longitude=p.longitude,
        accuracy_meters=p.accuracy_meters,
        site_id=p.site_id,
        site_name=p.site.name if p.site else None,
        distance_meters=p.distance_meters,
        note=p.note,
    )


def day_out(row: AttendanceDay, breaks: list | None = None) -> AttendanceDayOut:
    return AttendanceDayOut(
        id=row.id,
        employee_id=row.employee_id,
        employee_code=row.employee.code if row.employee else None,
        employee_name=row.employee.full_name if row.employee else None,
        work_date=row.work_date,
        check_in=row.check_in,
        check_out=row.check_out,
        worked_minutes=row.worked_minutes,
        late_minutes=row.late_minutes,
        early_leave_minutes=row.early_leave_minutes,
        overtime_minutes=row.overtime_minutes,
        status=row.status,
        punches_count=row.punches_count,
        presence_minutes=row.presence_minutes,
        break_minutes=row.break_minutes,
        break_count=row.break_count,
        break_overrun_minutes=row.break_overrun_minutes,
        open_break=row.open_break,
        breaks=[break_out(b) for b in breaks] if breaks else [],
        note=row.note,
        shift_label=_shift_label(row),
    )


def _shift_label(row: AttendanceDay) -> str | None:
    """اسم الوردية وأوقاتها كما حُسب بها هذا اليوم فعلاً."""
    if not row.shift_snapshot:
        return None
    try:
        return attendance_service.ShiftRules.from_snapshot(
            json.loads(row.shift_snapshot)).describe()
    except (ValueError, TypeError):
        return None


def break_out(row: BreakPeriod) -> BreakOut:
    return BreakOut(
        sequence=row.sequence,
        start_at=row.start_at,
        end_at=row.end_at,
        minutes=row.minutes,
        is_open=row.is_open,
    )


def breaks_for(db: Session, employee_ids: list[int], start: date, end: date) -> dict:
    """استراحات المدى مرتّبة لكل (موظف، يوم) — استعلام واحد لا استعلام لكل صف."""
    rows = db.scalars(
        select(BreakPeriod).where(
            BreakPeriod.employee_id.in_(employee_ids),
            BreakPeriod.work_date >= start,
            BreakPeriod.work_date <= end,
        ).order_by(BreakPeriod.start_at)
    ).all()
    grouped: dict[tuple[int, date], list[BreakPeriod]] = {}
    for row in rows:
        grouped.setdefault((row.employee_id, row.work_date), []).append(row)
    return grouped


def _visible_employee_ids(db: Session, user: User) -> list[int] | None:
    """يعيد قائمة الموظفين المسموح للمستخدم بمشاهدتهم، أو None يعني الجميع."""
    return visible_employee_ids(db, user)


# ------------------------------ البصمات الخام ------------------------------
@router.get("/punches", response_model=list[PunchOut])
def list_punches(
    date_from: date | None = None,
    date_to: date | None = None,
    employee_id: int | None = None,
    limit: int = Query(200, le=2000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(Punch)
    allowed = _visible_employee_ids(db, user)
    if allowed is not None:
        stmt = stmt.where(Punch.employee_id.in_(allowed))
    if employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(Punch.employee_id == employee_id)
    if date_from:
        stmt = stmt.where(Punch.punch_time >= datetime.combine(date_from, datetime.min.time()))
    if date_to:
        stmt = stmt.where(
            Punch.punch_time < datetime.combine(date_to + timedelta(days=1), datetime.min.time())
        )
    rows = db.scalars(stmt.order_by(Punch.punch_time.desc()).limit(limit)).all()
    return [punch_out(p) for p in rows]


@router.post("/punches", response_model=PunchOut, status_code=201)
def add_punch(
    payload: PunchIn, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    """إدخال بصمة يدوياً (مثلاً عند نسيان الموظف البصم)."""
    emp = db.get(Employee, payload.employee_id)
    if not emp:
        raise HTTPException(status_code=404, detail="الموظف غير موجود")
    exists = db.scalar(
        select(Punch).where(
            Punch.employee_code == emp.code,
            Punch.punch_time == payload.punch_time,
            Punch.device_id.is_(None),
        )
    )
    if exists:
        raise HTTPException(status_code=400, detail="توجد بصمة مسجلة بنفس الوقت")
    punch = Punch(
        employee_code=emp.code,
        employee_id=emp.id,
        punch_time=payload.punch_time,
        punch_type=payload.punch_type,
        source=PunchSource.manual,
        note=payload.note,
    )
    db.add(punch)
    db.flush()
    audit.log(db, user, "create", "punch", punch.id,
              f"{emp.full_name} {payload.punch_time}", commit=False)
    attendance_service.recompute_for_punches(db, [punch])
    sheets.push(db, "punches", sheets.punch_rows([punch]))
    db.refresh(punch)
    return punch_out(punch)


class PunchEditIn(BaseModel):
    """تعديل بصمة: الوقت و/أو النوع، مع سبب إلزامي يُحفظ في سجل التدقيق."""

    punch_time: datetime | None = None
    intent: str | None = Field(
        default=None, pattern="^(auto|clock_in|break_start|break_end|clock_out)$"
    )
    note: str | None = Field(default=None, max_length=255)
    reason: str = Field(min_length=3, max_length=255)


class PunchDeleteIn(BaseModel):
    reason: str = Field(min_length=3, max_length=255)


@router.patch("/punches/{punch_id}", response_model=PunchOut)
def edit_punch(
    punch_id: int,
    payload: PunchEditIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """تعديل بصمة مع أثر كامل: من عدّل، ومتى، والقيمة القديمة والجديدة، والسبب."""
    punch = db.get(Punch, punch_id)
    if not punch:
        raise HTTPException(status_code=404, detail="البصمة غير موجودة")
    if punch.deleted_at is not None:
        raise HTTPException(status_code=400, detail="البصمة محذوفة ولا تُعدَّل")

    before = _punch_snapshot(punch)
    changes = payload.model_dump(exclude_unset=True, exclude={"reason"})
    days = {punch.punch_time.date()}
    if changes.get("punch_time"):
        punch.punch_time = changes["punch_time"].replace(microsecond=0)
        days.add(punch.punch_time.date())
    if "intent" in changes:
        punch.intent = None if changes["intent"] in (None, "auto") else changes["intent"]
    if "note" in changes:
        punch.note = changes["note"]
    db.flush()

    audit.log(
        db, user, "update", "punch", punch.id,
        f"تعديل بصمة {punch.employee_code}: من [{before}] إلى [{_punch_snapshot(punch)}]"
        f" — السبب: {payload.reason}",
        commit=False,
    )
    if punch.employee_id:
        attendance_service.recompute(
            db, min(days) - timedelta(days=1), max(days), [punch.employee_id], commit=False
        )
    db.commit()
    db.refresh(punch)
    return punch_out(punch)


@router.delete("/punches/{punch_id}")
def delete_punch(
    punch_id: int,
    payload: PunchDeleteIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """حذف ناعم: السجل يبقى في القاعدة ويُستبعد من الاحتساب، وأثره في سجل التدقيق.

    لا يُمحى سجل حضور من قاعدة البيانات نهائياً بلا أثر.
    """
    punch = db.get(Punch, punch_id)
    if not punch:
        raise HTTPException(status_code=404, detail="البصمة غير موجودة")
    if punch.deleted_at is not None:
        raise HTTPException(status_code=400, detail="البصمة محذوفة أصلاً")

    emp_id, day = punch.employee_id, punch.punch_time.date()
    snapshot = _punch_snapshot(punch)
    punch.deleted_at = datetime.now().replace(microsecond=0)
    punch.deleted_by_id = user.id
    punch.delete_reason = payload.reason
    db.flush()
    audit.log(
        db, user, "delete", "punch", punch.id,
        f"حذف بصمة {punch.employee_code}: [{snapshot}] — السبب: {payload.reason}",
        commit=False,
    )
    if emp_id:
        attendance_service.recompute(db, day - timedelta(days=1), day, [emp_id], commit=False)
    db.commit()
    return {"ok": True, "message": "حُذفت البصمة وسُجّل الأثر في سجل التدقيق"}


def _punch_snapshot(punch: Punch) -> str:
    """وصف نصي لحالة البصمة يُحفظ في سجل التدقيق قبل التعديل وبعده."""
    parts = [f"الوقت {punch.punch_time:%Y-%m-%d %H:%M}"]
    if punch.intent:
        parts.append(f"النوع {punch.intent}")
    if punch.note:
        parts.append(f"ملاحظة {punch.note}")
    return "، ".join(parts)


@router.post("/self-punch", response_model=SelfPunchResult, status_code=201)
def self_punch(
    payload: SelfPunchIn | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """تسجيل حضور/انصراف ذاتي من التطبيق، مقيّد بموقع العمل الجغرافي.

    يتحقق النظام من أن إحداثيات الموظف داخل نطاق موقع عمل معتمد (Geofencing)
    قبل قبول البصمة، ويخزّن الموقع والمسافة مع السجل للمراجعة.
    """
    if not user.employee_id:
        raise HTTPException(status_code=400, detail="الحساب غير مرتبط بملف موظف")
    if not settings_store.get_bool(db, "web_punch_enabled"):
        raise HTTPException(status_code=403, detail="تسجيل الحضور من التطبيق معطّل حالياً")

    emp = db.get(Employee, user.employee_id)
    if emp.status != EmployeeStatus.active:
        raise HTTPException(status_code=403, detail="لا يمكن تسجيل الحضور لموظف غير نشط")

    data = payload or SelfPunchIn()
    site, distance = geo.verify_location(
        db, emp, data.latitude, data.longitude, data.accuracy_meters
    )

    now = datetime.now().replace(microsecond=0)
    policy = policies.resolve(db, emp)
    if data.intent == "break_start":
        rules = attendance_service.ShiftRules(emp.shift, emp.weekly_rest_days)
        window_start = rules.scheduled_out(now.date()) - timedelta(
            minutes=max(0, policy.clock_out_from_minutes)
        )
        if now >= window_start:
            raise HTTPException(
                status_code=400,
                detail=f"لا استراحة في آخر {policy.clock_out_from_minutes} دقيقة من الدوام"
                       " — سجّل انصرافك",
            )
        if emp.no_break:
            raise HTTPException(
                status_code=400,
                detail="حسابك مضبوط على «بلا استراحة» — راجع الموارد البشرية",
            )
    debounce = max(0, policy.debounce_seconds)
    recent = db.scalar(
        select(Punch)
        .where(
            Punch.employee_id == emp.id,
            Punch.deleted_at.is_(None),
            Punch.punch_time > now - timedelta(seconds=debounce),
        )
        .order_by(Punch.punch_time.desc())
    ) if debounce else None
    if recent:
        raise HTTPException(status_code=400, detail="سُجّلت بصمة قبل قليل، انتظر لحظة")

    punch = Punch(
        employee_code=emp.code,
        employee_id=emp.id,
        punch_time=now,
        punch_type=PunchType.auto,
        source=PunchSource.web,
        intent=data.intent,
        latitude=data.latitude,
        longitude=data.longitude,
        accuracy_meters=data.accuracy_meters,
        site_id=site.id if site else None,
        distance_meters=distance,
    )
    db.add(punch)
    db.flush()
    attendance_service.recompute_for_punches(db, [punch])
    sheets.push(db, "punches", sheets.punch_rows([punch]))
    db.refresh(punch)

    # ماذا فهم النظام من هذه البصمة، وما حالة الموظف بعدها
    event = db.scalar(
        select(AttendanceEvent)
        .where(AttendanceEvent.punch_id == punch.id)
        .order_by(AttendanceEvent.id.desc())
        .limit(1)
    )
    if event:
        kind = workstate.EVENT_LABELS[event.event_type]
        state = event.state_after
    else:
        kind, state = "بصمة", WorkState.out
    where = f" من موقع «{site.name}»" if site else ""
    hour = now.hour % 12 or 12
    time_label = f"{hour}:{now:%M} {'ص' if now.hour < 12 else 'م'}"
    return SelfPunchResult(
        punch=punch_out(punch),
        site_name=site.name if site else None,
        distance_meters=distance,
        kind=kind,
        time_label=time_label,
        state=state.value,
        state_label=workstate.STATE_LABELS[state],
        message=f"تم تسجيل {kind} الساعة {now:%H:%M}{where}",
    )


# ------------------------------ الكشوف ------------------------------
@router.get("/daily", response_model=list[AttendanceDayOut])
def daily_sheet(
    work_date: date = Query(default_factory=date.today),
    department_id: int | None = None,
    status: DayStatus | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """كشف يوم واحد لكل الموظفين المرئيين (يُحتسب عند الطلب إن لم يكن محفوظاً)."""
    emp_stmt = select(Employee).where(Employee.status == EmployeeStatus.active)
    allowed = _visible_employee_ids(db, user)
    if allowed is not None:
        emp_stmt = select(Employee).where(Employee.id.in_(allowed))
    if department_id:
        emp_stmt = emp_stmt.where(Employee.department_id == department_id)
    employees = db.scalars(emp_stmt.order_by(Employee.code)).all()
    ids = [e.id for e in employees]
    if not ids:
        return []

    attendance_service.recompute(db, work_date, work_date, ids)
    rows = db.scalars(
        select(AttendanceDay).where(
            AttendanceDay.employee_id.in_(ids), AttendanceDay.work_date == work_date
        )
    ).all()
    by_emp = {r.employee_id: r for r in rows}
    breaks = breaks_for(db, ids, work_date, work_date)
    result = [
        day_out(by_emp[e.id], breaks.get((e.id, work_date)))
        for e in employees if e.id in by_emp
    ]
    if status:
        result = [r for r in result if r.status == status]
    return result


@router.get("/employee/{employee_id}", response_model=list[AttendanceDayOut])
def employee_sheet(
    employee_id: int,
    date_from: date,
    date_to: date,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not can_view_employee(user, employee_id, db):
        raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
    if (date_to - date_from).days > 366:
        raise HTTPException(status_code=400, detail="المدى المطلوب أكبر من سنة")
    attendance_service.recompute(db, date_from, date_to, [employee_id])
    rows = db.scalars(
        select(AttendanceDay)
        .where(
            AttendanceDay.employee_id == employee_id,
            AttendanceDay.work_date >= date_from,
            AttendanceDay.work_date <= date_to,
        )
        .order_by(AttendanceDay.work_date)
    ).all()
    breaks = breaks_for(db, [employee_id], date_from, date_to)
    return [day_out(r, breaks.get((employee_id, r.work_date))) for r in rows]


@router.patch("/day/{day_id}", response_model=AttendanceDayOut)
def override_day(
    day_id: int,
    payload: AttendanceOverride,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """تعديل يدوي على يوم حضور (تسوية إدارية)."""
    row = db.get(AttendanceDay, day_id)
    if not row:
        raise HTTPException(status_code=404, detail="السجل غير موجود")
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(row, key, value)
    if row.check_in and row.check_out:
        row.worked_minutes = max(
            0, int((row.check_out - row.check_in).total_seconds() // 60)
        )
    if "note" not in data:
        row.note = "تعديل يدوي"
    audit.log(db, user, "update", "attendance_day", row.id,
              f"موظف {row.employee_id} - {row.work_date}", commit=False)
    db.commit()
    db.refresh(row)
    return day_out(row)


@router.post("/recompute")
def recompute_range(
    date_from: date,
    date_to: date,
    employee_id: int | None = None,
    use_current_shift: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """إعادة احتساب مدى.

    افتراضياً تُحسب الأيام الماضية بلقطة وردية كل يوم، فلا يتغيّر ما مضى.
    و`use_current_shift=true` يفرض إعادة حسابها بالوردية الحالية للموظف — يُستعمل
    عند تصحيح إسناد وردية خاطئ، ويُسجَّل في سجل التدقيق لأنه يُعيد كتابة الماضي.
    """
    count = attendance_service.recompute(
        db, date_from, date_to, [employee_id] if employee_id else None,
        use_current_shift=use_current_shift,
    )
    detail = f"{date_from} → {date_to} ({count} يوم)"
    if use_current_shift:
        detail += " — بالوردية الحالية (أُعيد حساب الماضي)"
    audit.log(db, user, "recompute", "attendance_day", None, detail)
    return {"ok": True, "days": count, "message": f"تمت إعادة احتساب {count} يوم" + (
        " بالوردية الحالية" if use_current_shift else "")}


class MarkPresentIn(BaseModel):
    """تسجيل حضور جماعي لمدى تواريخ."""

    date_from: date
    date_to: date
    employee_ids: list[int] | None = None


# ------------------------------ الحالة الحيّة والأحداث ------------------------------
@router.get("/live", response_model=list[LiveStatusOut])
def live_status(
    department_id: int | None = None,
    state: str | None = Query(default=None, pattern="^(out|in|break)$"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """لوحة الحالة الآن: من داخل العمل، ومن في استراحة، ومن خارج العمل."""
    emp_stmt = select(Employee).where(Employee.status == EmployeeStatus.active)
    allowed = _visible_employee_ids(db, user)
    if allowed is not None:
        emp_stmt = select(Employee).where(Employee.id.in_(allowed))
    if department_id:
        emp_stmt = emp_stmt.where(Employee.department_id == department_id)
    employees = db.scalars(emp_stmt.order_by(Employee.code)).all()
    ids = [e.id for e in employees]
    if not ids:
        return []

    today = date.today()
    attendance_service.recompute(db, today - timedelta(days=1), today, ids)
    return [
        row for row in (
            _live_row(db, emp, today) for emp in employees
        ) if state is None or row.state == state
    ]


def _live_row(db: Session, emp: Employee, today: date) -> LiveStatusOut:
    """حالة موظف واحد الآن من آخر حدث له في يوم وردية جارٍ."""
    rules = attendance_service.ShiftRules(emp.shift, emp.weekly_rest_days)
    work_day = today
    if rules.is_night and datetime.now() < rules.window(today)[0]:
        work_day = today - timedelta(days=1)

    last = db.scalar(
        select(AttendanceEvent)
        .where(AttendanceEvent.employee_id == emp.id, AttendanceEvent.work_date == work_day)
        .order_by(AttendanceEvent.event_time.desc(), AttendanceEvent.id.desc())
        .limit(1)
    )
    day = db.scalar(
        select(AttendanceDay).where(
            AttendanceDay.employee_id == emp.id, AttendanceDay.work_date == work_day
        )
    )
    state = last.state_after.value if last else WorkState.out.value
    since = last.event_time if last else (day.check_out if day else None)
    minutes = int((datetime.now() - since).total_seconds() // 60) if since else 0
    return LiveStatusOut(
        employee_id=emp.id,
        employee_name=emp.full_name,
        employee_code=emp.code,
        site_name=emp.site.name if emp.site else None,
        shift_name=emp.shift.name if emp.shift else None,
        state=state,
        state_label=workstate.STATE_LABELS[WorkState(state)],
        since=since,
        since_minutes=max(0, minutes),
        check_in=day.check_in if day else None,
        check_out=day.check_out if day else None,
        break_minutes=day.break_minutes if day else 0,
        break_count=day.break_count if day else 0,
        break_overrun_minutes=day.break_overrun_minutes if day else 0,
        open_break=bool(day and day.open_break),
        needs_review=bool(day and day.status == DayStatus.needs_review),
    )


@router.get("/events", response_model=list[AttendanceEventOut])
def list_events(
    employee_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """سجل الأحداث بالترتيب الزمني: ماذا كانت كل بصمة وما حالة الموظف قبلها وبعدها."""
    stmt = select(AttendanceEvent)
    allowed = _visible_employee_ids(db, user)
    if allowed is not None:
        stmt = stmt.where(AttendanceEvent.employee_id.in_(allowed))
    if employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(AttendanceEvent.employee_id == employee_id)
    if date_from:
        stmt = stmt.where(AttendanceEvent.work_date >= date_from)
    if date_to:
        stmt = stmt.where(AttendanceEvent.work_date <= date_to)
    rows = db.scalars(
        stmt.order_by(AttendanceEvent.event_time.desc(), AttendanceEvent.id.desc()).limit(limit)
    ).all()
    return [event_out(r) for r in rows]


def event_out(row: AttendanceEvent) -> AttendanceEventOut:
    return AttendanceEventOut(
        id=row.id,
        employee_id=row.employee_id,
        employee_code=row.employee_code,
        employee_name=row.employee_name,
        work_date=row.work_date,
        event_time=row.event_time,
        received_at=row.received_at,
        event_type=row.event_type.value,
        event_label=workstate.EVENT_LABELS[row.event_type],
        state_before=row.state_before.value,
        state_after=row.state_after.value,
        state_after_label=workstate.STATE_LABELS[row.state_after],
        source=row.source.value,
        device_name=row.device_name,
        site_name=row.site_name,
        shift_name=row.shift_name,
        note=row.note,
    )


@router.post("/mark-present")
def mark_present(
    payload: MarkPresentIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """يسجّل الموظفين حاضرين بمواعيد وردياتهم في أيام العمل ضمن المدى.

    لا يمسّ يوماً فيه بصمات فعلية، ولا أيام الراحة والعطل والإجازات المعتمدة.
    """
    span = (payload.date_to - payload.date_from).days
    if abs(span) > 92:
        raise HTTPException(status_code=400, detail="المدى أطول من ثلاثة أشهر")
    result = bulk_attendance.mark_present(
        db, payload.date_from, payload.date_to, payload.employee_ids
    )
    audit.log(
        db, user, "create", "attendance_day", None,
        f"تسجيل حضور جماعي {payload.date_from} → {payload.date_to}:"
        f" {result.days_marked} يوم لـ {result.employees} موظف",
    )
    return result.as_dict()


@router.post("/alerts/scan")
def scan_attendance_alerts(
    db: Session = Depends(get_db), _: User = Depends(require_hr)
):
    """إرسال تنبيه الغياب والتأخير الآن (يدوياً) بدل انتظار الموعد اليومي."""
    from ..services import attendance_alerts

    return attendance_alerts.scan(db, force=True)


@router.get("/export.csv")
def export_attendance(
    date_from: date,
    date_to: date,
    employee_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    allowed = _visible_employee_ids(db, user)
    stmt = select(AttendanceDay).where(
        AttendanceDay.work_date >= date_from, AttendanceDay.work_date <= date_to
    )
    if employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(AttendanceDay.employee_id == employee_id)
    elif allowed is not None:
        stmt = stmt.where(AttendanceDay.employee_id.in_(allowed))

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["التاريخ", "رقم الموظف", "الاسم", "الحضور", "الانصراف",
         "المدة في المقر (ساعة)", "إجمالي الاستراحة (د)", "عدد الاستراحات",
         "تجاوز الاستراحة (د)", "مدد الاستراحات", "ساعات العمل الفعلية",
         "التأخير (د)", "خروج مبكر (د)", "إضافي (د)", "الحالة", "ملاحظة"]
    )
    rows = db.scalars(
        stmt.order_by(AttendanceDay.work_date, AttendanceDay.employee_id)
    ).all()
    spans = breaks_for(
        db, list({r.employee_id for r in rows}) or [0], date_from, date_to
    )
    for r in rows:
        day_breaks = spans.get((r.employee_id, r.work_date), [])
        detail = " + ".join(
            f"{b.start_at:%H:%M}-{b.end_at:%H:%M} ({b.minutes}د)" if b.end_at
            else f"{b.start_at:%H:%M}- مفتوحة"
            for b in day_breaks
        )
        writer.writerow([
            r.work_date.isoformat(),
            r.employee.code if r.employee else "",
            r.employee.full_name if r.employee else "",
            r.check_in.strftime("%H:%M") if r.check_in else "",
            r.check_out.strftime("%H:%M") if r.check_out else "",
            round(r.presence_minutes / 60, 2),
            r.break_minutes,
            r.break_count,
            r.break_overrun_minutes,
            detail,
            round(r.worked_minutes / 60, 2),
            r.late_minutes,
            r.early_leave_minutes,
            r.overtime_minutes,
            STATUS_LABELS.get(r.status, r.status.value),
            r.note or "",
        ])
    return Response(
        "﻿" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=attendance_{date_from}_{date_to}.csv"},
    )
