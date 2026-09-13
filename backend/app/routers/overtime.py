"""الوقت الإضافي: يُرصد تلقائياً، ولا يُحتسب مالياً إلا باعتماد الإدارة."""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Employee, OvertimeRecord, OvertimeStatus, Role, User
from ..schemas import OvertimeDecision, OvertimeOut, OvertimeSummary
from ..security import can_view_employee, get_current_user, require_hr, visible_employee_ids
from ..services import audit, month_lock, notifications
from ..services import overtime as overtime_service

router = APIRouter(prefix="/api", tags=["overtime"])


def overtime_out(row: OvertimeRecord) -> OvertimeOut:
    return OvertimeOut(
        id=row.id,
        employee_id=row.employee_id,
        employee_name=row.employee.full_name if row.employee else None,
        employee_code=row.employee.code if row.employee else None,
        work_date=row.work_date,
        minutes=row.minutes,
        approved_minutes=row.approved_minutes,
        status=row.status,
        status_label=overtime_service.STATUS_LABELS[row.status],
        shift_end=row.shift_end,
        check_out=row.check_out,
        reason=row.reason,
        decided_by=row.decided_by.username if row.decided_by else None,
        decided_at=row.decided_at,
        decision_note=row.decision_note,
    )


def _visible(db: Session, user: User, stmt):
    allowed = visible_employee_ids(db, user)
    if allowed is not None:
        stmt = stmt.where(OvertimeRecord.employee_id.in_(allowed or [0]))
    return stmt


@router.get("/overtime", response_model=list[OvertimeOut])
def list_overtime(
    status: OvertimeStatus | None = None,
    employee_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """سجل الوقت الإضافي: المرصود والمعتمد والمرفوض."""
    stmt = select(OvertimeRecord)
    if status:
        stmt = stmt.where(OvertimeRecord.status == status)
    if employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(OvertimeRecord.employee_id == employee_id)
    if date_from:
        stmt = stmt.where(OvertimeRecord.work_date >= date_from)
    if date_to:
        stmt = stmt.where(OvertimeRecord.work_date <= date_to)
    rows = db.scalars(
        _visible(db, user, stmt).order_by(OvertimeRecord.work_date.desc(), OvertimeRecord.id.desc())
        .limit(500)
    ).all()
    return [overtime_out(r) for r in rows]


@router.get("/overtime/summary", response_model=OvertimeSummary)
def overtime_summary(
    year: int = Query(default_factory=lambda: date.today().year),
    month: int = Query(default_factory=lambda: date.today().month),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """ملخص الشهر: كم بانتظار الموافقة، وكم اعتُمد، وكم رُفض."""
    if not 1 <= month <= 12:
        raise HTTPException(status_code=400, detail="الشهر غير صحيح")
    start = date(year, month, 1)
    end = date(year + (month == 12), (month % 12) + 1, 1) - timedelta(days=1)
    stmt = select(OvertimeRecord).where(
        OvertimeRecord.work_date >= start, OvertimeRecord.work_date <= end
    )
    rows = db.scalars(_visible(db, user, stmt)).all()

    def total(status: OvertimeStatus, field: str) -> int:
        return sum(getattr(r, field) or 0 for r in rows if r.status is status)

    return OvertimeSummary(
        year=year,
        month=month,
        pending_count=sum(1 for r in rows if r.status is OvertimeStatus.pending),
        pending_minutes=total(OvertimeStatus.pending, "minutes"),
        approved_count=sum(1 for r in rows if r.status is OvertimeStatus.approved),
        approved_minutes=total(OvertimeStatus.approved, "approved_minutes"),
        rejected_count=sum(1 for r in rows if r.status is OvertimeStatus.rejected),
        rejected_minutes=total(OvertimeStatus.rejected, "minutes"),
        requires_approval=overtime_service.requires_approval(db),
    )


@router.post("/overtime/{record_id}/decide", response_model=OvertimeOut)
def decide_overtime(
    record_id: int,
    payload: OvertimeDecision,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """اعتماد الوقت الإضافي أو رفضه — باسم من قرّر ووقت قراره."""
    row = db.get(OvertimeRecord, record_id)
    if not row:
        raise HTTPException(status_code=404, detail="السجل غير موجود")
    month_lock.ensure_open(db, row.work_date, "اعتماد وقت إضافي")

    overtime_service.decide(
        db, row, user, payload.approve, minutes=payload.minutes, note=payload.note
    )
    detail = (
        f"{row.employee.full_name if row.employee else row.employee_id} — {row.work_date}: "
        + (f"اعتماد {row.approved_minutes} دقيقة من {row.minutes}" if payload.approve
           else f"رفض {row.minutes} دقيقة")
        + (f" — {row.decision_note}" if row.decision_note else "")
    )
    audit.log(db, user, "approve" if payload.approve else "reject",
              "overtime", row.id, detail, commit=False)
    notifications.notify_employee(
        db, row.employee_id,
        f"وقتك الإضافي في {row.work_date}: "
        + (f"اعتُمد {row.approved_minutes} دقيقة" if payload.approve else "غير معتمد"),
        body=row.decision_note or ("يُحتسب في راتب الشهر" if payload.approve
                                   else "لم تعتمده الإدارة فلا يُحتسب"),
        category="payroll", link_page="myOvertime", commit=False,
    )
    db.commit()
    db.refresh(row)
    return overtime_out(row)


@router.post("/overtime/{record_id}/reopen", response_model=OvertimeOut)
def reopen_overtime(
    record_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """إعادة فتح قرار سابق لتصحيحه — يُسجَّل في التدقيق بالقرار الملغى."""
    row = db.get(OvertimeRecord, record_id)
    if not row:
        raise HTTPException(status_code=404, detail="السجل غير موجود")
    if row.status is OvertimeStatus.pending:
        raise HTTPException(status_code=400, detail="السجل ما زال بانتظار الموافقة")
    month_lock.ensure_open(db, row.work_date, "تغيير قرار وقت إضافي")

    previous = overtime_service.STATUS_LABELS[row.status]
    overtime_service.reopen(db, row)
    audit.log(db, user, "update", "overtime", row.id,
              f"{row.work_date}: إعادة فتح قرار ({previous}) للمراجعة", commit=False)
    db.commit()
    db.refresh(row)
    return overtime_out(row)


@router.get("/me/overtime", response_model=list[OvertimeOut])
def my_overtime(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """وقت الموظف الإضافي وحالته — ليعرف ما اعتُمد له وما لم يُعتمد."""
    if not user.employee_id:
        return []
    rows = db.scalars(
        select(OvertimeRecord)
        .where(OvertimeRecord.employee_id == user.employee_id)
        .order_by(OvertimeRecord.work_date.desc())
        .limit(120)
    ).all()
    return [overtime_out(r) for r in rows]
