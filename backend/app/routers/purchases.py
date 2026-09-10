"""مشتريات الموظفين: فواتير تُسجَّل عليهم وتُخصم من راتب الشهر."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Employee, EmployeePurchase, PayrollRun, PayrollStatus, Role, User
from ..schemas import PurchaseIn, PurchaseOut
from ..security import can_view_employee, get_current_user, require_hr, visible_employee_ids
from ..services import audit, notifications

router = APIRouter(prefix="/api/purchases", tags=["purchases"])


class CancelIn(BaseModel):
    reason: str = Field(min_length=3, max_length=255)


def purchase_out(row: EmployeePurchase) -> PurchaseOut:
    return PurchaseOut(
        id=row.id,
        employee_id=row.employee_id,
        employee_code=row.employee.code if row.employee else None,
        employee_name=row.employee.full_name if row.employee else None,
        purchase_date=row.purchase_date,
        amount=row.amount,
        description=row.description,
        invoice_no=row.invoice_no,
        is_cancelled=row.is_cancelled,
        cancel_reason=row.cancel_reason,
        created_at=row.created_at,
    )


def _locked_month(db: Session, when: date) -> bool:
    """هل شهر الفاتورة داخل مسير معتمد؟ فلا يُعدَّل ما خُصم فعلاً."""
    run = db.scalar(
        select(PayrollRun).where(PayrollRun.year == when.year, PayrollRun.month == when.month)
    )
    return bool(run and run.status == PayrollStatus.approved)


@router.get("", response_model=list[PurchaseOut])
def list_purchases(
    employee_id: int | None = None,
    year: int | None = None,
    month: int | None = Query(default=None, ge=1, le=12),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """الموظف يرى فواتيره فقط، والموارد البشرية ترى الجميع."""
    stmt = select(EmployeePurchase)
    if user.role == Role.employee:
        stmt = stmt.where(EmployeePurchase.employee_id == (user.employee_id or 0))
    elif employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(EmployeePurchase.employee_id == employee_id)
    else:
        allowed = visible_employee_ids(db, user)
        if allowed is not None:
            stmt = stmt.where(EmployeePurchase.employee_id.in_(allowed or [0]))
    if year:
        stmt = stmt.where(EmployeePurchase.purchase_date >= date(year, month or 1, 1))
        end_year, end_month = (year, month) if month else (year, 12)
        last = date(end_year + (1 if end_month == 12 else 0),
                    1 if end_month == 12 else end_month + 1, 1)
        stmt = stmt.where(EmployeePurchase.purchase_date < last)
    rows = db.scalars(
        stmt.order_by(EmployeePurchase.purchase_date.desc(), EmployeePurchase.id.desc())
    ).all()
    return [purchase_out(row) for row in rows]


@router.post("", response_model=PurchaseOut, status_code=201)
def create_purchase(
    payload: PurchaseIn, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    """تسجيل فاتورة مشتريات على موظف — تُخصم في مسير الشهر الذي وقعت فيه."""
    employee = db.get(Employee, payload.employee_id)
    if not employee:
        raise HTTPException(status_code=404, detail="الموظف غير موجود")
    if payload.purchase_date > date.today():
        raise HTTPException(status_code=400, detail="لا يمكن تسجيل فاتورة بتاريخ مستقبلي")
    if _locked_month(db, payload.purchase_date):
        raise HTTPException(
            status_code=400,
            detail="مسير هذا الشهر معتمد — ألغِ اعتماده أولاً أو سجّل الفاتورة في الشهر الحالي",
        )

    row = EmployeePurchase(**payload.model_dump(), created_by_id=user.id)
    db.add(row)
    db.flush()
    audit.log(db, user, "create", "purchase", row.id,
              f"{employee.full_name}: فاتورة {payload.amount:.2f} — {payload.description}",
              commit=False)
    notifications.notify_employee(
        db, employee.id, "فاتورة مشتريات على حسابك",
        body=f"{payload.description} — {payload.amount:.2f} ريال بتاريخ {payload.purchase_date}."
             " تُخصم من راتب هذا الشهر.",
        category="payroll", link_page="purchases", commit=False,
    )
    db.commit()
    db.refresh(row)
    return purchase_out(row)


@router.post("/{purchase_id}/cancel", response_model=PurchaseOut)
def cancel_purchase(
    purchase_id: int,
    payload: CancelIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """إلغاء فاتورة بسبب مكتوب — تبقى في السجل ولا تُخصم."""
    row = db.get(EmployeePurchase, purchase_id)
    if not row:
        raise HTTPException(status_code=404, detail="الفاتورة غير موجودة")
    if row.is_cancelled:
        raise HTTPException(status_code=400, detail="الفاتورة ملغاة أصلاً")
    if _locked_month(db, row.purchase_date):
        raise HTTPException(status_code=400, detail="خُصمت في مسير معتمد — ألغِ اعتماده أولاً")

    row.is_cancelled = True
    row.cancel_reason = payload.reason
    db.flush()
    audit.log(db, user, "delete", "purchase", row.id,
              f"إلغاء فاتورة {row.amount:.2f} — السبب: {payload.reason}", commit=False)
    db.commit()
    db.refresh(row)
    return purchase_out(row)


@router.get("/summary")
def purchases_summary(
    year: int,
    month: int = Query(ge=1, le=12),
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """إجمالي مشتريات الشهر لكل موظف — لمراجعتها قبل احتساب المسير."""
    from ..services import purchases as service

    employees = db.scalars(select(Employee).order_by(Employee.code)).all()
    rows = []
    for employee in employees:
        amount = service.monthly_deduction(db, employee.id, year, month)
        if amount:
            rows.append({
                "employee_id": employee.id,
                "employee_code": employee.code,
                "employee_name": employee.full_name,
                "amount": amount,
                "count": len(service.month_rows(db, employee.id, year, month)),
            })
    return {"year": year, "month": month, "rows": rows,
            "total": round(sum(r["amount"] for r in rows), 2)}
