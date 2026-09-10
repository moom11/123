"""المستحقات والخصومات المرحّلة: جدول مستقل يُصرف أو يُخصم في مسير لاحق."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    CarryoverKind,
    CarryoverStatus,
    Employee,
    PayrollCarryover,
    Role,
    User,
)
from ..security import can_view_employee, get_current_user, require_hr, visible_employee_ids
from ..services import audit, carryovers as service, notifications, violations as violations_service

router = APIRouter(prefix="/api/carryovers", tags=["carryovers"])


class CarryoverIn(BaseModel):
    employee_id: int
    kind: CarryoverKind = CarryoverKind.earning
    source_year: int = Field(ge=2000, le=2100)
    source_month: int = Field(ge=1, le=12)
    days: float = Field(default=0, ge=0, le=366)
    day_rate: float = Field(default=0, ge=0)
    amount: float | None = Field(default=None, ge=0)   # يُحتسب من الأيام إن تُرك فارغاً
    reason: str = Field(min_length=2, max_length=255)
    admin_note: str | None = Field(default=None, max_length=1000)


class CarryoverUpdate(BaseModel):
    days: float | None = Field(default=None, ge=0, le=366)
    day_rate: float | None = Field(default=None, ge=0)
    amount: float | None = Field(default=None, ge=0)
    reason: str | None = Field(default=None, min_length=2, max_length=255)
    admin_note: str | None = Field(default=None, max_length=1000)


class CarryoverOut(BaseModel):
    id: int
    employee_id: int
    employee_code: str | None = None
    employee_name: str | None = None
    kind: CarryoverKind
    kind_label: str
    source_year: int
    source_month: int
    period_label: str
    days: float
    day_rate: float
    amount: float
    reason: str
    admin_note: str | None = None
    status: CarryoverStatus
    status_label: str
    paid_run_id: int | None = None
    paid_at: datetime | None = None
    created_at: datetime | None = None


MONTHS = [
    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
    "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
]


def out(row: PayrollCarryover) -> CarryoverOut:
    return CarryoverOut(
        id=row.id,
        employee_id=row.employee_id,
        employee_code=row.employee.code if row.employee else None,
        employee_name=row.employee.full_name if row.employee else None,
        kind=row.kind,
        kind_label=service.KIND_LABELS[row.kind],
        source_year=row.source_year,
        source_month=row.source_month,
        period_label=f"{MONTHS[row.source_month - 1]} {row.source_year}",
        days=row.days,
        day_rate=row.day_rate,
        amount=row.amount,
        reason=row.reason,
        admin_note=row.admin_note,
        status=row.status,
        status_label=service.STATUS_LABELS[row.status],
        paid_run_id=row.paid_run_id,
        paid_at=row.paid_at,
        created_at=row.created_at,
    )


@router.get("", response_model=list[CarryoverOut])
def list_carryovers(
    employee_id: int | None = None,
    status: CarryoverStatus | None = None,
    kind: CarryoverKind | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """الموظف يرى حركاته فقط، والموارد البشرية ترى الجميع."""
    stmt = select(PayrollCarryover)
    if user.role == Role.employee:
        stmt = stmt.where(PayrollCarryover.employee_id == (user.employee_id or 0))
    elif employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(PayrollCarryover.employee_id == employee_id)
    else:
        allowed = visible_employee_ids(db, user)
        if allowed is not None:
            stmt = stmt.where(PayrollCarryover.employee_id.in_(allowed or [0]))
    if status:
        stmt = stmt.where(PayrollCarryover.status == status)
    if kind:
        stmt = stmt.where(PayrollCarryover.kind == kind)
    rows = db.scalars(stmt.order_by(PayrollCarryover.id.desc())).all()
    return [out(row) for row in rows]


@router.get("/day-rate")
def suggested_day_rate(
    employee_id: int, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    """قيمة اليوم المقترحة لهذا الموظف حسب قواعد الرواتب."""
    employee = db.get(Employee, employee_id)
    if not employee:
        raise HTTPException(status_code=404, detail="الموظف غير موجود")
    return {"day_rate": round(violations_service.daily_wage(db, employee), 2)}


@router.post("", response_model=CarryoverOut, status_code=201)
def create_carryover(
    payload: CarryoverIn, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    """تسجيل مستحق أو خصم مرحّل. الأيام لا تُقيَّد إجازةً ولا غياباً — حركة مالية فقط."""
    employee = db.get(Employee, payload.employee_id)
    if not employee:
        raise HTTPException(status_code=404, detail="الموظف غير موجود")

    day_rate = payload.day_rate or round(violations_service.daily_wage(db, employee), 2)
    amount = service.compute_amount(payload.days, day_rate, payload.amount)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="أدخل الأيام وقيمة اليوم، أو المبلغ مباشرة")

    row = PayrollCarryover(
        employee_id=employee.id,
        kind=payload.kind,
        source_year=payload.source_year,
        source_month=payload.source_month,
        days=payload.days,
        day_rate=day_rate,
        amount=amount,
        reason=payload.reason,
        admin_note=payload.admin_note,
        status=CarryoverStatus.pending,
        created_by_id=user.id,
    )
    db.add(row)
    db.flush()
    label = service.KIND_LABELS[payload.kind]
    audit.log(db, user, "create", "carryover", row.id,
              f"{employee.full_name}: {label} {amount:.2f} عن {payload.source_month:02d}/"
              f"{payload.source_year} — {payload.reason}", commit=False)
    notifications.notify_employee(
        db, employee.id, f"{label} مسجَّل على حسابك",
        body=f"{payload.reason} — {amount:.2f} ريال عن شهر {payload.source_month:02d}/"
             f"{payload.source_year}. يُصرف مع أقرب مسير رواتب.",
        category="payroll", link_page="carryovers", commit=False,
    )
    db.commit()
    db.refresh(row)
    return out(row)


@router.patch("/{carryover_id}", response_model=CarryoverOut)
def update_carryover(
    carryover_id: int,
    payload: CarryoverUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    row = db.get(PayrollCarryover, carryover_id)
    if not row:
        raise HTTPException(status_code=404, detail="الحركة غير موجودة")
    if row.status is CarryoverStatus.paid:
        raise HTTPException(status_code=400, detail="الحركة مصروفة ولا تُعدَّل")

    changes = payload.model_dump(exclude_unset=True)
    for key in ("days", "day_rate", "reason", "admin_note"):
        if key in changes and changes[key] is not None:
            setattr(row, key, changes[key])
    row.amount = service.compute_amount(row.days, row.day_rate, changes.get("amount"))
    audit.log(db, user, "update", "carryover", row.id,
              "، ".join(f"{k}={v}" for k, v in changes.items()), commit=False)
    db.commit()
    db.refresh(row)
    return out(row)


class CancelIn(BaseModel):
    reason: str = Field(min_length=3, max_length=255)


@router.post("/{carryover_id}/cancel", response_model=CarryoverOut)
def cancel_carryover(
    carryover_id: int,
    payload: CancelIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """إلغاء حركة غير مصروفة بسبب مكتوب — تبقى في السجل ولا تُحتسب."""
    row = db.get(PayrollCarryover, carryover_id)
    if not row:
        raise HTTPException(status_code=404, detail="الحركة غير موجودة")
    if row.status is CarryoverStatus.paid:
        raise HTTPException(status_code=400, detail="الحركة مصروفة — لا تُلغى")
    row.status = CarryoverStatus.cancelled
    row.admin_note = ((row.admin_note or "") + f"\nسبب الإلغاء: {payload.reason}").strip()
    audit.log(db, user, "delete", "carryover", row.id,
              f"إلغاء حركة {row.amount:.2f} — {payload.reason}", commit=False)
    db.commit()
    db.refresh(row)
    return out(row)


@router.get("/summary")
def carryover_summary(
    year: int | None = None,
    month: int | None = Query(default=None, ge=1, le=12),
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """إجماليات الحركات غير المصروفة — لمعرفة ما سيُضاف في المسير القادم."""
    rows = db.scalars(
        select(PayrollCarryover).where(PayrollCarryover.status == CarryoverStatus.pending)
    ).all()
    if year:
        rows = [r for r in rows if r.source_year == year]
    if month:
        rows = [r for r in rows if r.source_month == month]
    earning = round(sum(r.amount for r in rows if r.kind is CarryoverKind.earning), 2)
    deduction = round(sum(r.amount for r in rows if r.kind is CarryoverKind.deduction), 2)
    return {
        "count": len(rows),
        "employees": len({r.employee_id for r in rows}),
        "earning_total": earning,
        "deduction_total": deduction,
        "net": round(earning - deduction, 2),
    }
