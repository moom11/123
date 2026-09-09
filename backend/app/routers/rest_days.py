"""أيام الراحة الشهرية: جدولتها لكل موظف ومتابعة المستهلك من الرصيد."""
from __future__ import annotations

from calendar import monthrange
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Employee, EmployeeStatus, RestDay, Role, User
from ..schemas import RestDayIn, RestDayOut, RestSummaryRow
from ..security import can_view_employee, get_current_user, require_hr, visible_employee_ids
from ..services import attendance as attendance_service
from ..services import audit, notifications, settings_store

router = APIRouter(prefix="/api", tags=["rest-days"])


def rest_out(row: RestDay) -> RestDayOut:
    return RestDayOut(
        id=row.id,
        employee_id=row.employee_id,
        employee_name=row.employee.full_name if row.employee else None,
        employee_code=row.employee.code if row.employee else None,
        rest_date=row.rest_date,
        note=row.note,
    )


def _month_range(year: int, month: int) -> tuple[date, date]:
    if not 1 <= month <= 12:
        raise HTTPException(status_code=400, detail="الشهر غير صحيح")
    return date(year, month, 1), date(year, month, monthrange(year, month)[1])


@router.get("/rest-days", response_model=list[RestDayOut])
def list_rest_days(
    year: int = Query(default_factory=lambda: date.today().year),
    month: int = Query(default_factory=lambda: date.today().month),
    employee_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    start, end = _month_range(year, month)
    stmt = select(RestDay).where(RestDay.rest_date >= start, RestDay.rest_date <= end)
    allowed = visible_employee_ids(db, user)
    if allowed is not None:
        stmt = stmt.where(RestDay.employee_id.in_(allowed or [0]))
    if employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(RestDay.employee_id == employee_id)
    rows = db.scalars(stmt.order_by(RestDay.rest_date)).all()
    return [rest_out(row) for row in rows]


@router.get("/rest-days/summary", response_model=list[RestSummaryRow])
def rest_summary(
    year: int = Query(default_factory=lambda: date.today().year),
    month: int = Query(default_factory=lambda: date.today().month),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """المستهلك والمتبقي من الراحة الشهرية لكل موظف."""
    start, end = _month_range(year, month)
    quota = settings_store.get_int(db, "monthly_rest_quota", 4) or 0

    emp_stmt = select(Employee).where(Employee.status == EmployeeStatus.active)
    allowed = visible_employee_ids(db, user)
    if allowed is not None:
        emp_stmt = emp_stmt.where(Employee.id.in_(allowed or [0]))
    employees = db.scalars(emp_stmt.order_by(Employee.code)).all()
    if not employees:
        return []

    rows = db.scalars(
        select(RestDay).where(
            RestDay.employee_id.in_([e.id for e in employees]),
            RestDay.rest_date >= start,
            RestDay.rest_date <= end,
        )
    ).all()
    by_employee: dict[int, list[date]] = {}
    for row in rows:
        by_employee.setdefault(row.employee_id, []).append(row.rest_date)

    result = []
    for employee in employees:
        dates = sorted(by_employee.get(employee.id, []))
        result.append(RestSummaryRow(
            employee_id=employee.id,
            employee_code=employee.code,
            employee_name=employee.full_name,
            used=len(dates),
            quota=quota,
            remaining=max(quota - len(dates), 0),
            dates=dates,
        ))
    return result


@router.post("/rest-days", response_model=RestDayOut, status_code=201)
def add_rest_day(payload: RestDayIn, db: Session = Depends(get_db), user: User = Depends(require_hr)):
    employee = db.get(Employee, payload.employee_id)
    if not employee:
        raise HTTPException(status_code=404, detail="الموظف غير موجود")
    existing = db.scalar(
        select(RestDay).where(
            RestDay.employee_id == employee.id, RestDay.rest_date == payload.rest_date
        )
    )
    if existing:
        raise HTTPException(status_code=400, detail="اليوم مسجّل راحة مسبقاً لهذا الموظف")

    quota = settings_store.get_int(db, "monthly_rest_quota", 4) or 0
    start, end = _month_range(payload.rest_date.year, payload.rest_date.month)
    used = len(db.scalars(
        select(RestDay).where(
            RestDay.employee_id == employee.id,
            RestDay.rest_date >= start,
            RestDay.rest_date <= end,
        )
    ).all())
    if quota and used >= quota:
        raise HTTPException(
            status_code=400,
            detail=f"استُهلك رصيد الراحة الشهري ({quota} أيام) لهذا الموظف في هذا الشهر",
        )

    row = RestDay(
        employee_id=employee.id, rest_date=payload.rest_date,
        note=payload.note, created_by_id=user.id,
    )
    db.add(row)
    db.flush()
    audit.log(db, user, "create", "rest_day", row.id,
              f"{employee.full_name}: راحة {payload.rest_date}", commit=False)
    notifications.notify_employee(
        db, employee.id, f"تم تحديد يوم راحتك: {payload.rest_date}",
        body=payload.note or "راحة شهرية مجدولة", category="attendance",
        link_page="attendance", commit=False,
    )
    db.commit()
    attendance_service.recompute(db, payload.rest_date, payload.rest_date, [employee.id])
    db.refresh(row)
    return rest_out(row)


@router.delete("/rest-days/{rest_id}")
def delete_rest_day(rest_id: int, db: Session = Depends(get_db), user: User = Depends(require_hr)):
    row = db.get(RestDay, rest_id)
    if not row:
        raise HTTPException(status_code=404, detail="اليوم غير موجود")
    employee_id, rest_date = row.employee_id, row.rest_date
    db.delete(row)
    audit.log(db, user, "delete", "rest_day", rest_id, f"إلغاء راحة {rest_date}", commit=False)
    db.commit()
    attendance_service.recompute(db, rest_date, rest_date, [employee_id])
    return {"ok": True, "message": "أُلغي يوم الراحة"}
