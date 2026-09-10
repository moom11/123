"""رصيد أيام الراحة الشهرية: من ملف الموظف أولاً، وإلا الافتراضي في إعدادات المنشأة."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import Employee
from . import settings_store

SETTING_KEY = "monthly_rest_quota"


def default_quota(db: Session) -> int:
    """الرصيد الافتراضي للمنشأة كلها."""
    return max(0, settings_store.get_int(db, SETTING_KEY, 4) or 0)


def has_own_quota(employee: Employee | None) -> bool:
    return employee is not None and employee.monthly_rest_quota is not None


def quota_for(db: Session, employee: Employee | None, default: int | None = None) -> int:
    """الرصيد المطبَّق على هذا الموظف؛ ملفه يغلب الإعداد العام."""
    if has_own_quota(employee):
        return max(0, int(employee.monthly_rest_quota))
    return default_quota(db) if default is None else max(0, default)
