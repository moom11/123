"""إنشاء حسابات دخول الموظفين تلقائياً عند تسجيل رقم الجوال.

القاعدة: بمجرد إضافة رقم جوال لموظف يصبح مصرَّحاً له بالدخول، اسم المستخدم هو رقمه،
وكلمة المرور المؤقتة هي الرقم نفسه — ويُطالَب بتغييرها فور أول دخول.
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Employee, Role, User
from ..security import hash_password
from . import settings_store

logger = logging.getLogger("hr")


def normalize_phone(value: str | None) -> str:
    """يوحّد صيغة رقم الجوال: أرقام فقط، ويحوّل 9665… و+9665… إلى 05…"""
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if digits.startswith("00966"):
        digits = digits[5:]
    elif digits.startswith("966"):
        digits = digits[3:]
    if len(digits) == 9 and digits.startswith("5"):
        digits = "0" + digits
    return digits


def is_valid_phone(value: str | None) -> bool:
    phone = normalize_phone(value)
    return len(phone) >= 9


def phone_conflict(db: Session, phone: str | None, exclude_employee_id: int | None = None) -> Employee | None:
    """يعيد الموظف الآخر المسجَّل بنفس رقم الجوال (إن وجد)."""
    normalized = normalize_phone(phone)
    if len(normalized) < 9:
        return None
    for other in db.scalars(select(Employee).where(Employee.phone.is_not(None))).all():
        if other.id != exclude_employee_id and normalize_phone(other.phone) == normalized:
            return other
    return None


def ensure_account(db: Session, employee: Employee, *, commit: bool = False) -> User | None:
    """ينشئ حساب دخول للموظف إن كان له رقم جوال ولا حساب له. يعيد الحساب المنشأ أو None."""
    if not settings_store.get_bool(db, "auto_account_on_phone"):
        return None
    if employee is None or not is_valid_phone(employee.phone):
        return None
    if db.scalar(select(User).where(User.employee_id == employee.id)):
        return None   # للموظف حساب بالفعل

    phone = normalize_phone(employee.phone)
    if phone_conflict(db, phone, employee.id):
        logger.info("لم يُنشأ حساب تلقائي: الرقم %s مسجّل لموظف آخر", phone)
        return None
    if db.scalar(select(User).where(User.username == phone)):
        return None   # اسم المستخدم محجوز لحساب آخر

    user = User(
        username=phone,
        password_hash=hash_password(phone),   # كلمة مرور مؤقتة = رقم الجوال
        role=Role.employee,
        employee_id=employee.id,
        must_change_password=True,
    )
    db.add(user)
    db.flush()
    if commit:
        db.commit()
    logger.info("أُنشئ حساب دخول تلقائي للموظف %s (%s)", employee.full_name, phone)
    return user
