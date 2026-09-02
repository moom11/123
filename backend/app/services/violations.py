"""المخالفات والجزاءات: احتساب التكرار والجزاء المستحق وفق سلّم لائحة تنظيم العمل."""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    Employee,
    PenaltyAction,
    Violation,
    ViolationStatus,
    ViolationType,
)
from . import settings_store

PENALTY_LABELS = {
    PenaltyAction.warning: "إنذار كتابي",
    PenaltyAction.deduction_percent_day: "خصم نسبة من أجر يوم",
    PenaltyAction.deduction_days: "خصم أجر أيام",
    PenaltyAction.suspension: "إيقاف عن العمل بدون أجر",
    PenaltyAction.termination: "الفصل من العمل",
}

STATUS_LABELS = {
    ViolationStatus.pending: "بانتظار إقرار الموظف",
    ViolationStatus.acknowledged: "أقرّ الموظف بالاطلاع",
    ViolationStatus.objected: "تظلّم الموظف",
    ViolationStatus.approved: "معتمدة",
    ViolationStatus.cancelled: "ملغاة",
}

# الحالات التي تُحتسب ضمن التكرار
COUNTED = (
    ViolationStatus.pending,
    ViolationStatus.acknowledged,
    ViolationStatus.objected,
    ViolationStatus.approved,
)


def repetition_number(
    db: Session,
    employee_id: int,
    violation_type_id: int,
    occurred_on: date,
    exclude_id: int | None = None,
) -> int:
    """رقم تكرار المخالفة خلال المدة النظامية (افتراضياً 180 يوماً)."""
    window = settings_store.get_int(db, "violation_reset_days", 180)
    since = occurred_on - timedelta(days=window)
    stmt = select(Violation).where(
        Violation.employee_id == employee_id,
        Violation.violation_type_id == violation_type_id,
        Violation.occurred_on >= since,
        Violation.occurred_on <= occurred_on,
        Violation.status.in_(COUNTED),
    )
    if exclude_id:
        stmt = stmt.where(Violation.id != exclude_id)
    return len(db.scalars(stmt).all()) + 1


def penalty_for(vtype: ViolationType, repetition: int) -> tuple[PenaltyAction, float]:
    """الجزاء المقرر حسب رقم التكرار (الرابعة فأكثر تأخذ المستوى الرابع)."""
    levels = [
        (vtype.level1_action, vtype.level1_value),
        (vtype.level2_action, vtype.level2_value),
        (vtype.level3_action, vtype.level3_value),
        (vtype.level4_action, vtype.level4_value),
    ]
    return levels[min(max(repetition, 1), 4) - 1]


def daily_wage(db: Session, employee: Employee) -> float:
    days = settings_store.get_int(db, "payroll_days_per_month", 30) or 30
    return round((employee.basic_salary or 0) / days, 2)


def penalty_amount(
    db: Session, employee: Employee, action: PenaltyAction, value: float
) -> float:
    """قيمة الخصم بالريال حسب نوع الجزاء وأجر اليوم."""
    wage = daily_wage(db, employee)
    if action == PenaltyAction.deduction_percent_day:
        return round(wage * (value or 0) / 100, 2)
    if action == PenaltyAction.deduction_days:
        return round(wage * (value or 0), 2)
    if action == PenaltyAction.suspension:
        return round(wage * (value or 0), 2)
    return 0.0


def preview(db: Session, employee: Employee, vtype: ViolationType, occurred_on: date) -> dict:
    """معاينة الجزاء قبل تسجيل المخالفة."""
    repetition = repetition_number(db, employee.id, vtype.id, occurred_on)
    action, value = penalty_for(vtype, repetition)
    amount = penalty_amount(db, employee, action, value)
    return {
        "repetition_no": repetition,
        "penalty_action": action.value,
        "penalty_action_label": PENALTY_LABELS[action],
        "penalty_value": value,
        "penalty_amount": amount,
        "daily_wage": daily_wage(db, employee),
    }


def apply_penalty(db: Session, violation: Violation) -> Violation:
    """يعيد احتساب التكرار والجزاء لمخالفة قائمة."""
    employee = db.get(Employee, violation.employee_id)
    vtype = db.get(ViolationType, violation.violation_type_id)
    if not employee or not vtype:
        raise HTTPException(status_code=404, detail="الموظف أو نوع المخالفة غير موجود")
    violation.repetition_no = repetition_number(
        db, employee.id, vtype.id, violation.occurred_on, exclude_id=violation.id
    )
    action, value = penalty_for(vtype, violation.repetition_no)
    violation.penalty_action = action
    violation.penalty_value = value
    violation.penalty_amount = penalty_amount(db, employee, action, value)
    return violation


def decide(
    db: Session,
    violation: Violation,
    status: ViolationStatus,
    user_id: int,
    note: str | None = None,
) -> Violation:
    if violation.status in (ViolationStatus.approved, ViolationStatus.cancelled):
        raise HTTPException(status_code=400, detail="المخالفة معتمدة أو ملغاة ولا يمكن تغييرها")
    violation.status = status
    violation.decided_by_id = user_id
    violation.decided_at = datetime.now()
    if note:
        violation.decision_note = note
    db.commit()
    db.refresh(violation)
    return violation


def monthly_deduction(db: Session, employee_id: int, year: int, month: int) -> float:
    """مجموع خصومات المخالفات المعتمدة خلال شهر لاحتسابها في الراتب."""
    start = date(year, month, 1)
    end = date(year + (month == 12), (month % 12) + 1, 1) - timedelta(days=1)
    rows = db.scalars(
        select(Violation).where(
            Violation.employee_id == employee_id,
            Violation.status == ViolationStatus.approved,
            Violation.occurred_on >= start,
            Violation.occurred_on <= end,
        )
    ).all()
    return round(sum(v.penalty_amount or 0 for v in rows), 2)
