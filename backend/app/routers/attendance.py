"""سجلات البصمات وكشوف الحضور اليومية والشهرية."""
from __future__ import annotations

import csv
import io
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    AttendanceDay,
    DayStatus,
    Employee,
    EmployeeStatus,
    Punch,
    PunchSource,
    PunchType,
    Role,
    User,
)
from ..schemas import (
    AttendanceDayOut,
    AttendanceOverride,
    PunchIn,
    PunchOut,
    SelfPunchIn,
    SelfPunchResult,
)
from ..security import can_view_employee, get_current_user, require_hr
from ..services import attendance as attendance_service
from ..services import geo, settings_store

router = APIRouter(prefix="/api/attendance", tags=["attendance"])

STATUS_LABELS = {
    DayStatus.present: "حاضر",
    DayStatus.late: "متأخر",
    DayStatus.absent: "غائب",
    DayStatus.leave: "إجازة",
    DayStatus.holiday: "عطلة رسمية",
    DayStatus.weekend: "راحة أسبوعية",
    DayStatus.missing_out: "بصمة انصراف ناقصة",
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


def day_out(row: AttendanceDay) -> AttendanceDayOut:
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
        note=row.note,
    )


def _visible_employee_ids(db: Session, user: User) -> list[int] | None:
    """يعيد قائمة الموظفين المسموح للمستخدم بمشاهدتهم، أو None يعني الجميع."""
    if user.role in (Role.admin, Role.hr):
        return None
    if user.role == Role.manager and user.employee_id:
        rows = db.scalars(
            select(Employee.id).where(
                (Employee.manager_id == user.employee_id) | (Employee.id == user.employee_id)
            )
        ).all()
        return list(rows)
    return [user.employee_id or 0]


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


@router.post("/punches", response_model=PunchOut, status_code=201, dependencies=[Depends(require_hr)])
def add_punch(payload: PunchIn, db: Session = Depends(get_db)):
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
    attendance_service.recompute_for_punches(db, [punch])
    db.refresh(punch)
    return punch_out(punch)


@router.delete("/punches/{punch_id}", dependencies=[Depends(require_hr)])
def delete_punch(punch_id: int, db: Session = Depends(get_db)):
    punch = db.get(Punch, punch_id)
    if not punch:
        raise HTTPException(status_code=404, detail="البصمة غير موجودة")
    emp_id, day = punch.employee_id, punch.punch_time.date()
    db.delete(punch)
    db.flush()
    if emp_id:
        attendance_service.recompute(db, day - timedelta(days=1), day, [emp_id], commit=False)
    db.commit()
    return {"ok": True}


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
    recent = db.scalar(
        select(Punch)
        .where(Punch.employee_id == emp.id, Punch.punch_time >= now - timedelta(minutes=2))
        .order_by(Punch.punch_time.desc())
    )
    if recent:
        raise HTTPException(status_code=400, detail="تم تسجيل بصمة قبل أقل من دقيقتين")

    punch = Punch(
        employee_code=emp.code,
        employee_id=emp.id,
        punch_time=now,
        punch_type=PunchType.auto,
        source=PunchSource.web,
        latitude=data.latitude,
        longitude=data.longitude,
        accuracy_meters=data.accuracy_meters,
        site_id=site.id if site else None,
        distance_meters=distance,
    )
    db.add(punch)
    db.flush()
    attendance_service.recompute_for_punches(db, [punch])
    db.refresh(punch)

    day = db.scalar(
        select(AttendanceDay).where(
            AttendanceDay.employee_id == emp.id, AttendanceDay.work_date == now.date()
        )
    )
    kind = "انصراف" if day and day.check_out else "حضور"
    where = f" من موقع «{site.name}»" if site else ""
    return SelfPunchResult(
        punch=punch_out(punch),
        site_name=site.name if site else None,
        distance_meters=distance,
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
    result = [day_out(by_emp[e.id]) for e in employees if e.id in by_emp]
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
    return [day_out(r) for r in rows]


@router.patch("/day/{day_id}", response_model=AttendanceDayOut, dependencies=[Depends(require_hr)])
def override_day(day_id: int, payload: AttendanceOverride, db: Session = Depends(get_db)):
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
    db.commit()
    db.refresh(row)
    return day_out(row)


@router.post("/recompute", dependencies=[Depends(require_hr)])
def recompute_range(
    date_from: date,
    date_to: date,
    employee_id: int | None = None,
    db: Session = Depends(get_db),
):
    count = attendance_service.recompute(
        db, date_from, date_to, [employee_id] if employee_id else None
    )
    return {"ok": True, "days": count, "message": f"تمت إعادة احتساب {count} يوم"}


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
        ["التاريخ", "رقم الموظف", "الاسم", "الحضور", "الانصراف", "ساعات العمل",
         "التأخير (د)", "خروج مبكر (د)", "إضافي (د)", "الحالة", "ملاحظة"]
    )
    rows = db.scalars(
        stmt.order_by(AttendanceDay.work_date, AttendanceDay.employee_id)
    ).all()
    for r in rows:
        writer.writerow([
            r.work_date.isoformat(),
            r.employee.code if r.employee else "",
            r.employee.full_name if r.employee else "",
            r.check_in.strftime("%H:%M") if r.check_in else "",
            r.check_out.strftime("%H:%M") if r.check_out else "",
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
