"""مشتريات الموظفين: فواتير المتجر أو المطعم تُخصم من راتب الشهر."""
from __future__ import annotations

from calendar import monthrange
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import EmployeePurchase


def month_rows(db: Session, employee_id: int, year: int, month: int) -> list[EmployeePurchase]:
    """فواتير الموظف السارية في شهر محدد (الملغاة لا تُحتسب)."""
    last_day = monthrange(year, month)[1]
    return list(db.scalars(
        select(EmployeePurchase).where(
            EmployeePurchase.employee_id == employee_id,
            EmployeePurchase.purchase_date >= date(year, month, 1),
            EmployeePurchase.purchase_date <= date(year, month, last_day),
            EmployeePurchase.is_cancelled.is_(False),
        ).order_by(EmployeePurchase.purchase_date)
    ).all())


def monthly_deduction(db: Session, employee_id: int, year: int, month: int) -> float:
    """مجموع مشتريات الموظف في شهر المسير."""
    return round(sum(row.amount or 0 for row in month_rows(db, employee_id, year, month)), 2)


def deduction_lines(db: Session, employee_id: int, year: int, month: int) -> list[dict]:
    """فواتير مشتريات الموظف هذا الشهر، كل فاتورة بيومها ووصفها."""
    lines = []
    for row in sorted(month_rows(db, employee_id, year, month), key=lambda r: r.purchase_date):
        if not row.amount:
            continue
        reason = f"مشتريات: {row.description}" if row.description else "مشتريات على حساب الموظف"
        lines.append({"kind": "purchase", "work_date": row.purchase_date,
                      "reason": reason[:255], "amount": round(row.amount, 2)})
    return lines


def deduction_until(db: Session, employee_id: int, year: int, month: int, until: date) -> float:
    """مجموع المشتريات من بداية الشهر حتى تاريخ محدد (لحساب المستحق حتى اليوم)."""
    return round(
        sum(row.amount or 0 for row in month_rows(db, employee_id, year, month)
            if row.purchase_date <= until),
        2,
    )
