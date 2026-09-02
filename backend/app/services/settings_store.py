"""إعدادات النظام المخزّنة في قاعدة البيانات (مفتاح/قيمة)."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AppSetting

DEFAULTS: dict[str, str] = {
    # تفعيل تسجيل الحضور الذاتي من التطبيق
    "web_punch_enabled": "true",
    # إلزام الموظف بأن يكون داخل نطاق موقع عمل معتمد
    "web_punch_requires_location": "true",
    # أقصى هامش خطأ مقبول لدقة تحديد الموقع (بالأمتار)
    "geo_max_accuracy_meters": "150",
}

BOOL_KEYS = {"web_punch_enabled", "web_punch_requires_location"}


def get_all(db: Session) -> dict[str, str]:
    stored = {row.key: row.value for row in db.scalars(select(AppSetting)).all()}
    return {**DEFAULTS, **{k: v for k, v in stored.items() if k in DEFAULTS}}


def get(db: Session, key: str) -> str:
    row = db.get(AppSetting, key)
    return row.value if row else DEFAULTS.get(key, "")


def get_bool(db: Session, key: str) -> bool:
    return str(get(db, key)).strip().lower() in ("1", "true", "yes", "on")


def get_int(db: Session, key: str, fallback: int = 0) -> int:
    try:
        return int(float(get(db, key)))
    except (TypeError, ValueError):
        return fallback


def set_many(db: Session, values: dict[str, str | bool | int | float]) -> dict[str, str]:
    for key, value in values.items():
        if key not in DEFAULTS or value is None:
            continue
        text = "true" if value is True else "false" if value is False else str(value)
        row = db.get(AppSetting, key)
        if row:
            row.value = text
        else:
            db.add(AppSetting(key=key, value=text))
    db.commit()
    return get_all(db)
