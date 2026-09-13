"""الوقت الزائد بعد نهاية الدوام: يُرصد تلقائياً، ولا يُحتسب مالياً إلا باعتماد الإدارة.

القاعدة: عمل الموظف بعد نهاية وردیته يُسجَّل «وقتاً زائداً بانتظار الموافقة» ولا يدخل
الراتب. فإن اعتمدته الإدارة صار «عملاً إضافياً معتمداً» ويُحتسب مالياً باسم من اعتمده
ووقت اعتماده. وإن رُفض لم يُحتسب. فلا مطالبة لاحقة بساعات لم تُعتمد رسمياً.
"""
from __future__ import annotations

from datetime import date, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Employee, OvertimeRecord, OvertimeStatus, User
from . import settings_store

STATUS_LABELS = {
    OvertimeStatus.pending: "بانتظار الموافقة",
    OvertimeStatus.approved: "معتمد",
    OvertimeStatus.rejected: "مرفوض",
}


def requires_approval(db: Session) -> bool:
    """هل يشترط النظام اعتماد الإدارة قبل احتساب الإضافي؟ (الأصل: نعم)"""
    return settings_store.get_bool(db, "overtime_requires_approval")


def sync_day(
    db: Session,
    employee_id: int,
    day: date,
    minutes: int,
    shift_end: datetime | None = None,
    check_out: datetime | None = None,
) -> OvertimeRecord | None:
    """يحدّث سجل الوقت الزائد لهذا اليوم بعد إعادة احتساب الحضور.

    القرار المتخذ لا يُمس: السجل المعتمد أو المرفوض يبقى شاهداً على قرار الإدارة،
    ولا تُغيّره إعادة احتساب لاحقة. وما زال بانتظار الموافقة يتبع الأرقام الجديدة.
    """
    row = db.scalar(
        select(OvertimeRecord).where(
            OvertimeRecord.employee_id == employee_id, OvertimeRecord.work_date == day
        )
    )
    if row is not None and row.status is not OvertimeStatus.pending:
        return row     # قرار الإدارة محفوظ كما هو

    if minutes <= 0:
        if row is not None:
            db.delete(row)   # لم يعد هناك وقت زائد، والسجل لم يُقرَّر بعد
        return None

    if row is None:
        row = OvertimeRecord(employee_id=employee_id, work_date=day)
        db.add(row)
    row.minutes = int(minutes)
    row.shift_end = shift_end
    row.check_out = check_out
    row.status = OvertimeStatus.pending
    return row


def approved_minutes(db: Session, employee_id: int, start: date, end: date) -> int:
    """مجموع الدقائق المعتمدة في المدى — وهي وحدها ما يُحتسب مالياً."""
    rows = db.scalars(
        select(OvertimeRecord).where(
            OvertimeRecord.employee_id == employee_id,
            OvertimeRecord.work_date >= start,
            OvertimeRecord.work_date <= end,
            OvertimeRecord.status == OvertimeStatus.approved,
        )
    ).all()
    return sum(int(r.approved_minutes or 0) for r in rows)


def unapproved_minutes(db: Session, employee_id: int, start: date, end: date) -> int:
    """الوقت الزائد الذي لم يُعتمد — للبيان لا للصرف.

    يشمل ما ينتظر الموافقة، وما رُفض، والمتبقي من يوم اعتُمد بعضه فقط.
    """
    rows = db.scalars(
        select(OvertimeRecord).where(
            OvertimeRecord.employee_id == employee_id,
            OvertimeRecord.work_date >= start,
            OvertimeRecord.work_date <= end,
        )
    ).all()
    return sum(max(0, int(r.minutes or 0) - int(r.approved_minutes or 0)) for r in rows)


def decide(
    db: Session,
    row: OvertimeRecord,
    user: User,
    approve: bool,
    minutes: int | None = None,
    note: str | None = None,
) -> OvertimeRecord:
    """اعتماد الوقت الزائد أو رفضه، باسم من قرّر ووقت قراره."""
    if row.status is not OvertimeStatus.pending:
        raise HTTPException(
            status_code=400,
            detail=f"سبق البتّ في هذا الوقت الزائد ({STATUS_LABELS[row.status]})",
        )
    if approve:
        granted = row.minutes if minutes is None else int(minutes)
        if granted <= 0:
            raise HTTPException(status_code=400, detail="الدقائق المعتمدة يجب أن تكون أكبر من صفر")
        if granted > row.minutes:
            raise HTTPException(
                status_code=400,
                detail=f"لا يمكن اعتماد أكثر من الوقت المرصود ({row.minutes} دقيقة)",
            )
        row.approved_minutes = granted
        row.status = OvertimeStatus.approved
    else:
        row.approved_minutes = 0
        row.status = OvertimeStatus.rejected
    row.decided_by_id = user.id
    row.decided_at = datetime.now().replace(microsecond=0)
    row.decision_note = (note or "").strip() or None
    return row


def reopen(db: Session, row: OvertimeRecord) -> OvertimeRecord:
    """إعادة السجل إلى «بانتظار الموافقة» — لتصحيح قرار خاطئ، بأثر في التدقيق."""
    row.status = OvertimeStatus.pending
    row.approved_minutes = 0
    row.decided_by_id = None
    row.decided_at = None
    row.decision_note = None
    return row


def employee_name(db: Session, employee_id: int) -> str:
    emp = db.get(Employee, employee_id)
    return emp.full_name if emp else "—"
