"""لوحة المؤشرات والتقارير الشهرية."""
from __future__ import annotations

import csv
import io
from calendar import monthrange
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    AttendanceDay,
    DayStatus,
    Device,
    Employee,
    EmployeeStatus,
    LeaveRequest,
    LeaveStatus,
    Role,
    User,
)
from ..schemas import DashboardStats, MonthlySummaryRow
from ..security import get_current_user, require_manager
from ..services import attendance as attendance_service

router = APIRouter(prefix="/api/reports", tags=["reports"])

STATUS_LABELS = {
    DayStatus.present: "حاضر",
    DayStatus.late: "متأخر",
    DayStatus.absent: "غائب",
    DayStatus.leave: "إجازة",
    DayStatus.holiday: "عطلة",
    DayStatus.weekend: "راحة",
    DayStatus.missing_out: "انصراف ناقص",
    DayStatus.scheduled: "لم يحن بعد",
}


@router.get("/dashboard", response_model=DashboardStats)
def dashboard(
    day: date = Query(default_factory=date.today),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    employees = db.scalars(select(Employee).where(Employee.status == EmployeeStatus.active)).all()
    ids = [e.id for e in employees]
    if ids:
        attendance_service.recompute(db, day - timedelta(days=6), day, ids)

    rows = db.scalars(
        select(AttendanceDay).where(
            AttendanceDay.employee_id.in_(ids or [0]), AttendanceDay.work_date == day
        )
    ).all()
    present = sum(1 for r in rows if r.status in (DayStatus.present, DayStatus.missing_out))
    late = sum(1 for r in rows if r.status == DayStatus.late)
    absent = sum(1 for r in rows if r.status == DayStatus.absent)
    on_leave = sum(1 for r in rows if r.status == DayStatus.leave)

    pending = db.scalar(
        select(func.count(LeaveRequest.id)).where(LeaveRequest.status == LeaveStatus.pending)
    ) or 0

    devices = db.scalars(select(Device)).all()
    online = sum(
        1
        for d in devices
        if d.is_active and d.last_sync_at and (datetime.now() - d.last_sync_at) < timedelta(hours=24)
    )

    trend = []
    for offset in range(6, -1, -1):
        d = day - timedelta(days=offset)
        day_rows = db.scalars(
            select(AttendanceDay).where(
                AttendanceDay.employee_id.in_(ids or [0]), AttendanceDay.work_date == d
            )
        ).all()
        trend.append({
            "date": d.isoformat(),
            "present": sum(1 for r in day_rows if r.status in (DayStatus.present, DayStatus.missing_out)),
            "late": sum(1 for r in day_rows if r.status == DayStatus.late),
            "absent": sum(1 for r in day_rows if r.status == DayStatus.absent),
            "leave": sum(1 for r in day_rows if r.status == DayStatus.leave),
        })

    return DashboardStats(
        date=day,
        employees_total=len(employees),
        present=present + late,
        late=late,
        absent=absent,
        on_leave=on_leave,
        pending_leaves=pending,
        devices_online=online,
        devices_total=len(devices),
        weekly_trend=trend,
    )


def _month_range(year: int, month: int) -> tuple[date, date]:
    if not 1 <= month <= 12:
        raise HTTPException(status_code=400, detail="الشهر غير صحيح")
    last_day = monthrange(year, month)[1]
    return date(year, month, 1), date(year, month, last_day)


def _summary_rows(db: Session, user: User, year: int, month: int, department_id: int | None):
    start, end = _month_range(year, month)
    emp_stmt = select(Employee).where(Employee.status == EmployeeStatus.active)
    if user.role == Role.manager and user.employee_id:
        emp_stmt = emp_stmt.where(
            (Employee.manager_id == user.employee_id) | (Employee.id == user.employee_id)
        )
    if department_id:
        emp_stmt = emp_stmt.where(Employee.department_id == department_id)
    employees = db.scalars(emp_stmt.order_by(Employee.code)).all()
    ids = [e.id for e in employees]
    if not ids:
        return start, end, []

    attendance_service.recompute(db, start, end, ids)
    rows = db.scalars(
        select(AttendanceDay).where(
            AttendanceDay.employee_id.in_(ids),
            AttendanceDay.work_date >= start,
            AttendanceDay.work_date <= end,
        )
    ).all()
    grouped: dict[int, list[AttendanceDay]] = {}
    for r in rows:
        grouped.setdefault(r.employee_id, []).append(r)

    result = []
    for emp in employees:
        days = grouped.get(emp.id, [])
        result.append(
            MonthlySummaryRow(
                employee_id=emp.id,
                employee_code=emp.code,
                employee_name=emp.full_name,
                department_name=emp.department.name if emp.department else None,
                present_days=sum(1 for d in days if d.status in (DayStatus.present, DayStatus.missing_out)),
                late_days=sum(1 for d in days if d.status == DayStatus.late),
                absent_days=sum(1 for d in days if d.status == DayStatus.absent),
                leave_days=sum(1 for d in days if d.status == DayStatus.leave),
                holiday_days=sum(1 for d in days if d.status == DayStatus.holiday),
                weekend_days=sum(1 for d in days if d.status == DayStatus.weekend),
                worked_hours=round(sum(d.worked_minutes for d in days) / 60, 2),
                late_minutes=sum(d.late_minutes for d in days),
                early_leave_minutes=sum(d.early_leave_minutes for d in days),
                overtime_minutes=sum(d.overtime_minutes for d in days),
            )
        )
    return start, end, result


@router.get("/monthly", response_model=list[MonthlySummaryRow])
def monthly_summary(
    year: int = Query(default_factory=lambda: date.today().year),
    month: int = Query(default_factory=lambda: date.today().month),
    department_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    _, _, rows = _summary_rows(db, user, year, month, department_id)
    return rows


@router.get("/monthly-export.csv")
def monthly_export(
    year: int = Query(default_factory=lambda: date.today().year),
    month: int = Query(default_factory=lambda: date.today().month),
    department_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    start, end, rows = _summary_rows(db, user, year, month, department_id)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "رقم الموظف", "الاسم", "الإدارة", "أيام الحضور", "أيام التأخير", "أيام الغياب",
        "أيام الإجازات", "العطل", "الراحة", "ساعات العمل", "دقائق التأخير",
        "دقائق الخروج المبكر", "دقائق الإضافي",
    ])
    for r in rows:
        writer.writerow([
            r.employee_code, r.employee_name, r.department_name or "", r.present_days,
            r.late_days, r.absent_days, r.leave_days, r.holiday_days, r.weekend_days,
            r.worked_hours, r.late_minutes, r.early_leave_minutes, r.overtime_minutes,
        ])
    return Response(
        "﻿" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=summary_{year}_{month:02d}.csv"},
    )


@router.get("/exceptions")
def exceptions_report(
    date_from: date,
    date_to: date,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    """تقرير الاستثناءات: الغياب، التأخير، والانصراف الناقص."""
    stmt = select(AttendanceDay).where(
        AttendanceDay.work_date >= date_from,
        AttendanceDay.work_date <= date_to,
        AttendanceDay.status.in_([DayStatus.absent, DayStatus.late, DayStatus.missing_out]),
    )
    if user.role == Role.manager and user.employee_id:
        team = db.scalars(
            select(Employee.id).where(Employee.manager_id == user.employee_id)
        ).all()
        stmt = stmt.where(AttendanceDay.employee_id.in_(list(team) or [0]))
    rows = db.scalars(stmt.order_by(AttendanceDay.work_date.desc())).all()
    return [
        {
            "work_date": r.work_date.isoformat(),
            "employee_code": r.employee.code if r.employee else "",
            "employee_name": r.employee.full_name if r.employee else "",
            "status": STATUS_LABELS.get(r.status, r.status.value),
            "late_minutes": r.late_minutes,
            "early_leave_minutes": r.early_leave_minutes,
            "check_in": r.check_in.strftime("%H:%M") if r.check_in else "",
            "check_out": r.check_out.strftime("%H:%M") if r.check_out else "",
        }
        for r in rows
    ]
