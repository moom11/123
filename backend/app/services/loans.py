"""السلف على الراتب: جدولة الأقساط وخصمها في المسير الشهري.

الجدول محسوب حسابياً من (المبلغ، القسط، شهر البداية) وليس مخزّناً، فإعادة احتساب
المسير أكثر من مرة لا تُكرّر الخصم ولا تُغيّره.
"""
from __future__ import annotations

from math import ceil

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import EmployeeLoan, LoanStatus


def installments(loan: EmployeeLoan) -> list[tuple[int, int, float]]:
    """أقساط السلفة: [(السنة، الشهر، المبلغ), ...] بدءاً من شهر البداية."""
    amount = round(loan.amount or 0, 2)
    step = round(loan.installment_amount or 0, 2)
    if amount <= 0 or step <= 0:
        return []
    count = max(1, ceil(round(amount / step, 6)))
    rows: list[tuple[int, int, float]] = []
    remaining = amount
    for index in range(count):
        month_index = (loan.start_month - 1) + index
        year = loan.start_year + month_index // 12
        month = month_index % 12 + 1
        value = round(min(step, remaining), 2)
        remaining = round(remaining - value, 2)
        rows.append((year, month, value))
        if remaining <= 0:
            break
    return rows


def installment_for(loan: EmployeeLoan, year: int, month: int) -> float:
    """قسط السلفة المستحق في شهر محدد (صفر إن لم يكن ضمن الجدول)."""
    if loan.status != LoanStatus.active:
        return 0.0
    for row_year, row_month, value in installments(loan):
        if row_year == year and row_month == month:
            return value
    return 0.0


def paid_until(loan: EmployeeLoan, year: int, month: int) -> float:
    """ما استُحق خصمه حتى نهاية الشهر المحدد."""
    limit = year * 12 + month
    return round(
        sum(v for y, m, v in installments(loan) if y * 12 + m <= limit),
        2,
    )


def monthly_deduction(db: Session, employee_id: int, year: int, month: int) -> float:
    """مجموع أقساط سلف الموظف المستحقة في شهر المسير."""
    loans = db.scalars(
        select(EmployeeLoan).where(
            EmployeeLoan.employee_id == employee_id,
            EmployeeLoan.status == LoanStatus.active,
        )
    ).all()
    return round(sum(installment_for(loan, year, month) for loan in loans), 2)


def deduction_lines(db: Session, employee_id: int, year: int, month: int) -> list[dict]:
    """أقساط السلف المستحقة هذا الشهر، كل سلفة بسطرها."""
    loans = db.scalars(
        select(EmployeeLoan).where(
            EmployeeLoan.employee_id == employee_id,
            EmployeeLoan.status == LoanStatus.active,
        )
    ).all()
    lines = []
    for loan in loans:
        amount = installment_for(loan, year, month)
        if not amount:
            continue
        reason = (f"قسط سلفة بمبلغ {round(loan.amount or 0, 2):g} ريال "
                  f"(بدأ خصمها {loan.start_month}/{loan.start_year})")
        if loan.reason:
            reason += f" — {loan.reason}"
        lines.append({"kind": "loan", "work_date": None,
                      "reason": reason[:255], "amount": round(amount, 2)})
    return lines


def summary(loan: EmployeeLoan, year: int, month: int) -> dict:
    """ملخص السلفة حتى شهر مرجعي: المسدد والمتبقي وعدد الأقساط."""
    rows = installments(loan)
    paid = paid_until(loan, year, month) if loan.status == LoanStatus.active else (
        round(loan.amount or 0, 2) if loan.status == LoanStatus.settled else 0.0
    )
    total = round(loan.amount or 0, 2)
    last = rows[-1] if rows else None
    return {
        "months": len(rows),
        "paid_amount": paid,
        "remaining_amount": round(max(total - paid, 0), 2),
        "last_installment": f"{last[0]}-{last[1]:02d}" if last else None,
        "is_finished": bool(rows) and paid >= total,
    }
