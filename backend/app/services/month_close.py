"""فحص ما قبل إقفال الشهر: ما الذي يجب معالجته قبل احتساب المسير واعتماده.

خمس حالات تُراجَع لكل موظف:
  ١) يوم بلا بصمة وبلا إجازة (غياب مفتوح)
  ٢) تجاوز رصيد الإجازة
  ٣) مستحقات مرحّلة من شهر سابق لم تُصرف
  ٤) خصم مسجَّل لم يُعتمد بعد
  ٥) بصمة دخول بلا خروج (أو استراحة بلا عودة)
"""
from __future__ import annotations

from calendar import monthrange
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    AttendanceDay,
    CarryoverStatus,
    DayStatus,
    Employee,
    EmployeeStatus,
    LeaveBalance,
    PayrollCarryover,
    Violation,
    ViolationStatus,
)

# مفتاح الحالة -> (العنوان، درجة الخطورة)
ISSUE_LABELS = {
    "absent_days": ("أيام غياب بلا بصمة وبلا إجازة", "danger"),
    "leave_overdraft": ("تجاوز رصيد الإجازة", "danger"),
    "unpaid_carryover": ("مستحقات مرحّلة لم تُصرف", "warn"),
    "pending_violation": ("خصم مسجَّل لم يُعتمد", "warn"),
    "open_shift": ("بصمة دخول بلا خروج", "warn"),
}


def _month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, monthrange(year, month)[1])


def scan(db: Session, year: int, month: int, employee_ids: list[int] | None = None) -> dict:
    """يفحص الشهر ويعيد قائمة الموظفين ذوي الملاحظات مع تفصيلها."""
    start, end = _month_bounds(year, month)
    stmt = select(Employee).where(Employee.status == EmployeeStatus.active)
    if employee_ids:
        stmt = select(Employee).where(Employee.id.in_(employee_ids))
    employees = db.scalars(stmt.order_by(Employee.code)).all()
    if not employees:
        return {"year": year, "month": month, "rows": [], "totals": {}, "clean": True}

    ids = [e.id for e in employees]
    days = db.scalars(
        select(AttendanceDay).where(
            AttendanceDay.employee_id.in_(ids),
            AttendanceDay.work_date >= start,
            AttendanceDay.work_date <= end,
        )
    ).all()
    by_employee: dict[int, list[AttendanceDay]] = {}
    for row in days:
        by_employee.setdefault(row.employee_id, []).append(row)

    balances = db.scalars(
        select(LeaveBalance).where(LeaveBalance.employee_id.in_(ids), LeaveBalance.year == year)
    ).all()
    balance_map: dict[int, list[LeaveBalance]] = {}
    for row in balances:
        balance_map.setdefault(row.employee_id, []).append(row)

    carryovers = db.scalars(
        select(PayrollCarryover).where(
            PayrollCarryover.employee_id.in_(ids),
            PayrollCarryover.status == CarryoverStatus.pending,
        )
    ).all()
    carry_map: dict[int, list[PayrollCarryover]] = {}
    for row in carryovers:
        carry_map.setdefault(row.employee_id, []).append(row)

    open_statuses = (
        ViolationStatus.pending, ViolationStatus.acknowledged, ViolationStatus.objected,
    )
    violations = db.scalars(
        select(Violation).where(
            Violation.employee_id.in_(ids),
            Violation.occurred_on >= start,
            Violation.occurred_on <= end,
            Violation.status.in_(open_statuses),
        )
    ).all()
    violation_map: dict[int, list[Violation]] = {}
    for row in violations:
        violation_map.setdefault(row.employee_id, []).append(row)

    rows: list[dict] = []
    totals = {key: 0 for key in ISSUE_LABELS}
    for employee in employees:
        issues: list[dict] = []
        employee_days = by_employee.get(employee.id, [])

        absent = [d for d in employee_days if d.status == DayStatus.absent]
        if absent:
            issues.append({
                "key": "absent_days",
                "count": len(absent),
                "detail": "، ".join(d.work_date.isoformat() for d in absent[:6])
                          + (" …" if len(absent) > 6 else ""),
            })

        over = [
            b for b in balance_map.get(employee.id, [])
            if (b.used_days or 0) > (b.entitled_days or 0) + (b.carried_over_days or 0)
        ]
        if over:
            worst = max(
                over,
                key=lambda b: (b.used_days or 0) - (b.entitled_days or 0) - (b.carried_over_days or 0),
            )
            extra = round(
                (worst.used_days or 0) - (worst.entitled_days or 0) - (worst.carried_over_days or 0), 2
            )
            issues.append({
                "key": "leave_overdraft",
                "count": len(over),
                "detail": f"{worst.leave_type.name if worst.leave_type else 'إجازة'}:"
                          f" تجاوز {extra} يوم",
            })

        pending_carry = [c for c in carry_map.get(employee.id, [])
                         if (c.source_year, c.source_month) < (year, month)]
        if pending_carry:
            amount = round(sum(c.amount for c in pending_carry), 2)
            issues.append({
                "key": "unpaid_carryover",
                "count": len(pending_carry),
                "detail": f"{amount:.2f} ريال عن "
                          + "، ".join(f"{c.source_month:02d}/{c.source_year}"
                                      for c in pending_carry[:4]),
            })

        open_violations = violation_map.get(employee.id, [])
        if open_violations:
            issues.append({
                "key": "pending_violation",
                "count": len(open_violations),
                "detail": "، ".join(
                    (v.violation_type.name if v.violation_type else "مخالفة")
                    for v in open_violations[:3]
                ),
            })

        open_shifts = [
            d for d in employee_days
            if d.status in (DayStatus.missing_out, DayStatus.needs_review)
        ]
        if open_shifts:
            issues.append({
                "key": "open_shift",
                "count": len(open_shifts),
                "detail": "، ".join(d.work_date.isoformat() for d in open_shifts[:6])
                          + (" …" if len(open_shifts) > 6 else ""),
            })

        if issues:
            for issue in issues:
                totals[issue["key"]] += issue["count"]
            rows.append({
                "employee_id": employee.id,
                "employee_code": employee.code,
                "employee_name": employee.full_name,
                "issues": [
                    {
                        **issue,
                        "label": ISSUE_LABELS[issue["key"]][0],
                        "tone": ISSUE_LABELS[issue["key"]][1],
                    }
                    for issue in issues
                ],
            })

    return {
        "year": year,
        "month": month,
        "employees_checked": len(employees),
        "rows": rows,
        "totals": totals,
        "labels": {key: value[0] for key, value in ISSUE_LABELS.items()},
        "clean": not rows,
    }


def summary_text(result: dict) -> str:
    """ملخّص نصّي للتنبيه."""
    if result.get("clean"):
        return "لا ملاحظات — الشهر جاهز للإقفال"
    parts = [
        f"{ISSUE_LABELS[key][0]}: {count}"
        for key, count in result.get("totals", {}).items() if count
    ]
    return f"{len(result['rows'])} موظف بحاجة مراجعة — " + "، ".join(parts)
