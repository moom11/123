"""التأمينات الاجتماعية: حصة الموظف تُخصم، وحصة المنشأة تُبيَّن ولا تُخصم.

النسب لا تُثبَّت في الكود: تختلف بالجنسية وبتاريخ الاشتراك، وتتغيّر بتعديلات
النظام. تُدخلها المنشأة من حسابها في التأمينات، ويبقى الخصم صفراً حتى تُضبط —
فلا يُخصم من موظف شيء بناءً على رقم مفترض.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from ..models import Employee
from . import settings_store


@dataclass(frozen=True)
class Shares:
    """نتيجة الاحتساب لشهر واحد."""

    base: float = 0.0          # الوعاء الخاضع
    employee: float = 0.0      # حصة الموظف (تُخصم من راتبه)
    employer: float = 0.0      # حصة المنشأة (التزام عليها لا خصم منه)

    @property
    def total(self) -> float:
        return round(self.employee + self.employer, 2)


def is_enabled(db: Session) -> bool:
    return settings_store.get_bool(db, "gosi_enabled")


def _rate(db: Session, key: str) -> float:
    try:
        return max(0.0, float(settings_store.get(db, key) or 0))
    except (TypeError, ValueError):
        return 0.0


def base_amount(db: Session, employee: Employee, factor: float = 1.0) -> float:
    """الوعاء قبل الحد الأقصى: الأساسي وحده أو مع البدلات حسب الإعداد."""
    basic = float(employee.basic_salary or 0)
    allowances = float(employee.allowances or 0)
    gross = basic + allowances if settings_store.get(db, "gosi_base") == "total" else basic
    if settings_store.get_bool(db, "gosi_prorate"):
        gross *= max(0.0, min(1.0, factor))
    cap = _rate(db, "gosi_max_base")
    if cap:
        cap_value = cap * (max(0.0, min(1.0, factor))
                           if settings_store.get_bool(db, "gosi_prorate") else 1.0)
        gross = min(gross, cap_value)
    return round(gross, 2)


def compute(db: Session, employee: Employee, factor: float = 1.0) -> Shares:
    """حصتا الموظف والمنشأة لهذا الشهر. غير المشترك = أصفار."""
    if not is_enabled(db) or not employee.gosi_subscribed:
        return Shares()
    suffix = "" if employee.is_saudi else "_expat"
    employee_rate = _rate(db, f"gosi_employee_rate{suffix}")
    employer_rate = _rate(db, f"gosi_employer_rate{suffix}")
    if not employee_rate and not employer_rate:
        return Shares()

    base = base_amount(db, employee, factor)
    return Shares(
        base=base,
        employee=round(base * employee_rate / 100, 2),
        employer=round(base * employer_rate / 100, 2),
    )


def summary_label(db: Session) -> str:
    """وصف مختصر للإعداد الحالي، يظهر في الشاشة والتقارير."""
    if not is_enabled(db):
        return "التأمينات غير مفعّلة"
    base = "الأساسي + البدلات" if settings_store.get(db, "gosi_base") == "total" else "الأساسي"
    return (f"الوعاء: {base} · السعودي {_rate(db, 'gosi_employee_rate'):g}% موظف "
            f"+ {_rate(db, 'gosi_employer_rate'):g}% منشأة · "
            f"غير السعودي {_rate(db, 'gosi_employee_rate_expat'):g}% موظف "
            f"+ {_rate(db, 'gosi_employer_rate_expat'):g}% منشأة")
