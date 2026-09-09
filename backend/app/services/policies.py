"""سياسات الحضور والاستراحة، ودقّة اختيار السياسة الأخص لكل موظف.

الترتيب من الأعم إلى الأخص: القيم الافتراضية في الإعدادات ← سياسة عامة
← سياسة فرع ← سياسة إدارة ← سياسة وردية. كل حقل فارغ في سياسة أخص
يُورَّث من الأعم، فلا حاجة لتكرار كل الإعدادات في كل سياسة.
"""
from __future__ import annotations

from dataclasses import dataclass, fields

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AttendancePolicy, Employee, PolicyScope
from . import settings_store

# الحقول القابلة للضبط، واسم الإعداد العام المقابل لكل حقل
FIELD_SETTINGS = {
    "break_allowance_minutes": "break_allowance_minutes",
    "break_grace_minutes": "break_grace_minutes",
    "max_break_count": "break_max_count",
    "max_total_break_minutes": "break_max_total_minutes",
    "deduct_breaks": "break_deducted",
    "clock_out_from_minutes": "clock_out_from_minutes",
    "early_leave_grace_minutes": "early_leave_grace_minutes",
    "late_grace_minutes": "late_grace_minutes",
    "debounce_seconds": "punch_debounce_seconds",
}


@dataclass
class Policy:
    """السياسة الفعلية المطبَّقة على موظف بعد دمج كل المستويات."""

    break_allowance_minutes: int = 60
    break_grace_minutes: int = 5
    max_break_count: int = 0            # 0 = بلا حد لعدد الاستراحات
    max_total_break_minutes: int = 0    # 0 = يساوي المسموح
    deduct_breaks: bool = True
    clock_out_from_minutes: int = 30    # البصم قبل نهاية الوردية بهذا القدر = انصراف
    early_leave_grace_minutes: int = 10
    late_grace_minutes: int = 10
    debounce_seconds: int = 20
    source: str = "الافتراضية"          # اسم السياسة التي غلبت (للعرض)

    @property
    def break_limit(self) -> int:
        """الحد الأعلى لإجمالي الاستراحة قبل احتساب تجاوز (مع دقائق السماح)."""
        base = self.max_total_break_minutes or self.break_allowance_minutes
        return max(0, base + self.break_grace_minutes)


def defaults(db: Session) -> Policy:
    """القيم الافتراضية من إعدادات النظام."""
    policy = Policy()
    for field, key in FIELD_SETTINGS.items():
        if field == "deduct_breaks":
            setattr(policy, field, settings_store.get_bool(db, key))
        else:
            setattr(policy, field, settings_store.get_int(db, key, getattr(policy, field)))
    return policy


def _apply(policy: Policy, row: AttendancePolicy) -> None:
    changed = False
    for field in fields(Policy):
        if field.name == "source":
            continue
        value = getattr(row, field.name, None)
        if value is not None:
            setattr(policy, field.name, value)
            changed = True
    if changed:
        policy.source = row.name


def resolve(db: Session, employee: Employee) -> Policy:
    """يعيد السياسة المطبَّقة على هذا الموظف بعد دمج المستويات."""
    policy = defaults(db)
    rows = db.scalars(
        select(AttendancePolicy).where(AttendancePolicy.is_active.is_(True))
    ).all()
    by_scope: dict[tuple, AttendancePolicy] = {}
    for row in rows:
        by_scope[(row.scope, row.scope_id)] = row

    order = [
        (PolicyScope.default, None),
        (PolicyScope.site, employee.site_id),
        (PolicyScope.department, employee.department_id),
        (PolicyScope.shift, employee.shift_id),
    ]
    for scope, scope_id in order:
        if scope is not PolicyScope.default and scope_id is None:
            continue
        row = by_scope.get((scope, scope_id))
        if row:
            _apply(policy, row)
    return policy


def resolve_many(db: Session, employees: list[Employee]) -> dict[int, Policy]:
    """نسخة مجمّعة تتجنّب استعلاماً لكل موظف عند احتساب كشف كامل."""
    base = defaults(db)
    rows = db.scalars(
        select(AttendancePolicy).where(AttendancePolicy.is_active.is_(True))
    ).all()
    by_scope = {(row.scope, row.scope_id): row for row in rows}

    result: dict[int, Policy] = {}
    for emp in employees:
        policy = Policy(**{f.name: getattr(base, f.name) for f in fields(Policy)})
        for scope, scope_id in (
            (PolicyScope.default, None),
            (PolicyScope.site, emp.site_id),
            (PolicyScope.department, emp.department_id),
            (PolicyScope.shift, emp.shift_id),
        ):
            if scope is not PolicyScope.default and scope_id is None:
                continue
            row = by_scope.get((scope, scope_id))
            if row:
                _apply(policy, row)
        result[emp.id] = policy
    return result
