"""قفل الشهر المُقفل: الشهر الذي اعتُمد مسير رواتبه لا تُعاد كتابة حضوره.

الاعتماد يعني أن الرواتب صُرفت على هذه الأرقام. فأي تغيير في حضور ذلك الشهر
بعده — بصمة يدوية، تعديل بصمة، إعادة احتساب بعد تعديل وردية أو إجازة — يجعل
القسيمة المصروفة لا تطابق بياناتها. ولذلك يُقفل الشهر عند الاعتماد.

المفتاح موجود دائماً: **إلغاء اعتماد المسير** يفتح الشهر من جديد، ثم يُصحَّح
ويُعاد الاعتماد. فالقفل يمنع التغيير الصامت، لا التصحيح المقصود.
"""
from __future__ import annotations

from datetime import date

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import PayrollRun, PayrollStatus


def locked_periods(db: Session) -> set[tuple[int, int]]:
    """الأشهر التي اعتُمدت مسيراتها، كأزواج (سنة، شهر)."""
    rows = db.execute(
        select(PayrollRun.year, PayrollRun.month).where(
            PayrollRun.status == PayrollStatus.approved
        )
    ).all()
    return {(int(year), int(month)) for year, month in rows}


def is_locked(db: Session, day: date) -> bool:
    return (day.year, day.month) in locked_periods(db)


def locked_in_range(db: Session, start: date, end: date) -> list[tuple[int, int]]:
    """الأشهر المقفلة الواقعة ضمن هذا المدى، مرتبة."""
    locked = locked_periods(db)
    found: set[tuple[int, int]] = set()
    year, month = start.year, start.month
    while (year, month) <= (end.year, end.month):
        if (year, month) in locked:
            found.add((year, month))
        month += 1
        if month > 12:
            year, month = year + 1, 1
    return sorted(found)


def label(year: int, month: int) -> str:
    return f"{month}/{year}"


def labels(periods: list[tuple[int, int]]) -> str:
    return "، ".join(label(y, m) for y, m in periods)


def ensure_open(db: Session, day: date, action: str = "التعديل") -> None:
    """يرفض الكتابة على يوم داخل شهر مُقفل، ويسمّي طريق الفتح."""
    if is_locked(db, day):
        raise HTTPException(
            status_code=400,
            detail=f"شهر {label(day.year, day.month)} مُقفل لأن مسير رواتبه معتمد، "
                   f"ولا يمكن {action} فيه. لفتحه: الرواتب ← المسير ← إلغاء الاعتماد.",
        )


def ensure_range_open(db: Session, start: date, end: date, action: str = "التعديل") -> None:
    periods = locked_in_range(db, start, end)
    if periods:
        raise HTTPException(
            status_code=400,
            detail=f"المدى يشمل شهراً مُقفلاً ({labels(periods)}) لاعتماد مسير رواتبه، "
                   f"ولا يمكن {action} فيه. لفتحه: الرواتب ← المسير ← إلغاء الاعتماد.",
        )
