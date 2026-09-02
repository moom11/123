"""سجل التدقيق: تسجيل كل إجراء حسّاس مع منفّذه ووقته."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import AuditLog, User

# وصف عربي لكل إجراء لعرضه في الشاشة
ACTION_LABELS = {
    "login": "تسجيل دخول",
    "create": "إنشاء",
    "update": "تعديل",
    "delete": "حذف",
    "approve": "اعتماد",
    "reject": "رفض",
    "cancel": "إلغاء",
    "sync": "مزامنة جهاز",
    "import": "استيراد",
    "recompute": "إعادة احتساب",
    "settings": "تغيير إعدادات",
    "password": "تغيير كلمة مرور",
    "payroll": "مسير رواتب",
}

ENTITY_LABELS = {
    "employee": "موظف",
    "punch": "بصمة",
    "attendance_day": "يوم حضور",
    "leave_request": "طلب إجازة",
    "leave_balance": "رصيد إجازة",
    "leave_type": "نوع إجازة",
    "holiday": "عطلة",
    "device": "جهاز بصمة",
    "site": "موقع عمل",
    "user": "مستخدم",
    "settings": "الإعدادات",
    "violation": "مخالفة",
    "violation_type": "نوع مخالفة",
    "document": "وثيقة",
    "payroll": "مسير رواتب",
    "shift": "وردية",
    "department": "إدارة",
}


def log(
    db: Session,
    user: User | None,
    action: str,
    entity: str,
    entity_id: int | str | None = None,
    detail: str | None = None,
    commit: bool = True,
) -> AuditLog:
    """يسجّل إجراءً في سجل التدقيق."""
    row = AuditLog(
        user_id=user.id if user else None,
        action=action,
        entity=entity,
        entity_id=str(entity_id) if entity_id is not None else None,
        detail=detail,
    )
    db.add(row)
    if commit:
        db.commit()
    else:
        db.flush()
    return row
