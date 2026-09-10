"""المستحقات والخصومات المرحّلة من شهور سابقة.

حين لا يُصرف للموظف راتب أيام من شهر ماضٍ، لا تُقيَّد تلك الأيام إجازةً ولا
غياباً في الشهر الحالي — بل تُسجَّل حركة مالية مستقلة تُصرف في مسير لاحق.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import CarryoverKind, CarryoverStatus, PayrollCarryover, PayrollRun

KIND_LABELS = {
    CarryoverKind.earning: "مستحق سابق",
    CarryoverKind.deduction: "خصم سابق",
}

STATUS_LABELS = {
    CarryoverStatus.pending: "غير مصروف",
    CarryoverStatus.paid: "مصروف",
    CarryoverStatus.cancelled: "ملغاة",
}


def compute_amount(days: float, day_rate: float, amount: float | None) -> float:
    """المبلغ = الأيام × قيمة اليوم، إلا إن أُدخل مبلغ صريح."""
    if amount is not None and amount > 0:
        return round(amount, 2)
    return round(max(0.0, days or 0) * max(0.0, day_rate or 0), 2)


def pending_for(db: Session, employee_id: int) -> list[PayrollCarryover]:
    """الحركات غير المصروفة لموظف، الأقدم أولاً."""
    return list(db.scalars(
        select(PayrollCarryover).where(
            PayrollCarryover.employee_id == employee_id,
            PayrollCarryover.status == CarryoverStatus.pending,
        ).order_by(PayrollCarryover.source_year, PayrollCarryover.source_month, PayrollCarryover.id)
    ).all())


def totals_for(db: Session, employee_id: int) -> tuple[float, float]:
    """(إجمالي المستحقات، إجمالي الخصومات) غير المصروفة."""
    rows = pending_for(db, employee_id)
    earning = round(sum(r.amount for r in rows if r.kind is CarryoverKind.earning), 2)
    deduction = round(sum(r.amount for r in rows if r.kind is CarryoverKind.deduction), 2)
    return earning, deduction


def mark_paid(db: Session, run: PayrollRun) -> int:
    """يعلّم الحركات غير المصروفة «مصروفة» عند اعتماد المسير.

    يقتصر على موظفي هذا المسير، ويسجّل رقم المسير ووقت الصرف.
    """
    from ..models import Payslip

    employee_ids = set(db.scalars(
        select(Payslip.employee_id).where(Payslip.run_id == run.id)
    ).all())
    if not employee_ids:
        return 0
    rows = db.scalars(
        select(PayrollCarryover).where(
            PayrollCarryover.employee_id.in_(employee_ids),
            PayrollCarryover.status == CarryoverStatus.pending,
        )
    ).all()
    now = datetime.now()
    for row in rows:
        row.status = CarryoverStatus.paid
        row.paid_run_id = run.id
        row.paid_at = now
    return len(rows)


def unmark_paid(db: Session, run: PayrollRun) -> int:
    """يعيد الحركات إلى «غير مصروف» عند إلغاء اعتماد المسير."""
    rows = db.scalars(
        select(PayrollCarryover).where(PayrollCarryover.paid_run_id == run.id)
    ).all()
    for row in rows:
        row.status = CarryoverStatus.pending
        row.paid_run_id = None
        row.paid_at = None
    return len(rows)
