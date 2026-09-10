"""طلبات «نسيت البصمة»: الموظف يطلب تسجيل بصمة فائتة والإدارة تعتمدها."""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    Employee,
    LeaveStatus,
    Punch,
    PunchRequest,
    PunchSource,
    PunchType,
    Role,
    User,
)
from ..database import get_db
from ..schemas import PunchRequestDecision, PunchRequestIn, PunchRequestOut
from ..security import can_view_employee, get_current_user, require_hr, visible_employee_ids
from ..services import attendance as attendance_service
from ..services import audit, notifications

router = APIRouter(prefix="/api/punch-requests", tags=["punch-requests"])

KIND_LABELS = {
    "auto": "يحدّده النظام",
    "clock_in": "حضور",
    "break_start": "بدء استراحة",
    "break_end": "عودة من الاستراحة",
    "clock_out": "انصراف",
}

# أقصى قِدم مسموح لطلب بصمة فائتة
MAX_AGE_DAYS = 30


def request_out(row: PunchRequest) -> PunchRequestOut:
    return PunchRequestOut(
        id=row.id,
        employee_id=row.employee_id,
        employee_code=row.employee.code if row.employee else None,
        employee_name=row.employee.full_name if row.employee else None,
        requested_time=row.requested_time,
        kind=row.kind,
        kind_label=KIND_LABELS.get(row.kind, row.kind),
        reason=row.reason,
        status=row.status,
        decision_note=row.decision_note,
        decided_at=row.decided_at,
        punch_id=row.punch_id,
        created_at=row.created_at,
    )


@router.get("", response_model=list[PunchRequestOut])
def list_requests(
    status: LeaveStatus | None = None,
    employee_id: int | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """الموظف يرى طلباته، والمدير فريقه، والموارد البشرية الجميع."""
    stmt = select(PunchRequest)
    if user.role == Role.employee:
        stmt = stmt.where(PunchRequest.employee_id == (user.employee_id or 0))
    elif employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(PunchRequest.employee_id == employee_id)
    else:
        allowed = visible_employee_ids(db, user)
        if allowed is not None:
            stmt = stmt.where(PunchRequest.employee_id.in_(allowed or [0]))
    if status:
        stmt = stmt.where(PunchRequest.status == status)
    rows = db.scalars(stmt.order_by(PunchRequest.id.desc()).limit(limit)).all()
    return [request_out(row) for row in rows]


@router.post("", response_model=PunchRequestOut, status_code=201)
def create_request(
    payload: PunchRequestIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """تقديم طلب بصمة فائتة. الموظف لنفسه، والموارد البشرية نيابة عن أي موظف."""
    employee_id = user.employee_id
    if payload.employee_id and payload.employee_id != user.employee_id:
        if user.role not in (Role.admin, Role.hr):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية التقديم نيابة عن غيرك")
        employee_id = payload.employee_id
    if not employee_id:
        raise HTTPException(status_code=400, detail="الحساب غير مرتبط بملف موظف")

    employee = db.get(Employee, employee_id)
    if not employee:
        raise HTTPException(status_code=404, detail="الموظف غير موجود")

    when = payload.requested_time.replace(second=0, microsecond=0)
    if when > datetime.now():
        raise HTTPException(status_code=400, detail="لا يمكن طلب بصمة بوقت مستقبلي")
    if (date.today() - when.date()).days > MAX_AGE_DAYS:
        raise HTTPException(
            status_code=400, detail=f"لا تُقبل طلبات أقدم من {MAX_AGE_DAYS} يوماً"
        )

    duplicate = db.scalar(
        select(PunchRequest).where(
            PunchRequest.employee_id == employee_id,
            PunchRequest.requested_time == when,
            PunchRequest.status == LeaveStatus.pending,
        )
    )
    if duplicate:
        raise HTTPException(status_code=400, detail="لديك طلب معلّق بالوقت نفسه")

    row = PunchRequest(
        employee_id=employee_id,
        requested_time=when,
        kind=payload.kind,
        reason=payload.reason,
        status=LeaveStatus.pending,
    )
    db.add(row)
    db.flush()
    audit.log(db, user, "create", "punch_request", row.id,
              f"{employee.full_name}: طلب بصمة {when:%Y-%m-%d %H:%M}", commit=False)
    notifications.notify_approvers(
        db, employee_id, "طلب «نسيت البصمة»",
        body=f"{employee.full_name} يطلب تسجيل {KIND_LABELS.get(payload.kind, '')}"
             f" بتاريخ {when:%Y-%m-%d} الساعة {when:%H:%M} — السبب: {payload.reason}",
        category="attendance", link_page="punchRequests", commit=False,
    )
    db.commit()
    db.refresh(row)
    return request_out(row)


@router.post("/{request_id}/decide", response_model=PunchRequestOut)
def decide_request(
    request_id: int,
    payload: PunchRequestDecision,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """اعتماد الطلب فتُسجَّل البصمة فعلياً ويُعاد احتساب اليوم، أو رفضه."""
    row = db.get(PunchRequest, request_id)
    if not row:
        raise HTTPException(status_code=404, detail="الطلب غير موجود")
    if row.status != LeaveStatus.pending:
        raise HTTPException(status_code=400, detail="الطلب محسوم مسبقاً")

    row.decided_by_id = user.id
    row.decided_at = datetime.now()
    row.decision_note = payload.note

    if payload.approve:
        row.status = LeaveStatus.approved
        punch = Punch(
            employee_code=row.employee.code,
            employee_id=row.employee_id,
            punch_time=row.requested_time,
            punch_type=PunchType.auto,
            source=PunchSource.manual,
            intent=None if row.kind == "auto" else row.kind,
            note=f"طلب نسيان بصمة معتمد: {row.reason[:120]}",
        )
        db.add(punch)
        db.flush()
        row.punch_id = punch.id
        day = row.requested_time.date()
        attendance_service.recompute(
            db, day - timedelta(days=1), day, [row.employee_id], commit=False
        )
        title = "اعتُمد طلب البصمة"
        body = f"سُجّلت بصمتك بتاريخ {row.requested_time:%Y-%m-%d} الساعة {row.requested_time:%H:%M}"
    else:
        row.status = LeaveStatus.rejected
        title = "رُفض طلب البصمة"
        body = payload.note or "راجع الموارد البشرية لمعرفة السبب."

    audit.log(db, user, "approve" if payload.approve else "reject", "punch_request", row.id,
              f"{row.employee.full_name}: {row.requested_time:%Y-%m-%d %H:%M}"
              + (f" — {payload.note}" if payload.note else ""), commit=False)
    notifications.notify_employee(
        db, row.employee_id, title, body=body,
        category="attendance", link_page="myPunchRequests", commit=False,
    )
    db.commit()
    db.refresh(row)
    return request_out(row)


@router.delete("/{request_id}")
def cancel_request(
    request_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """الموظف يسحب طلبه ما دام معلّقاً."""
    row = db.get(PunchRequest, request_id)
    if not row:
        raise HTTPException(status_code=404, detail="الطلب غير موجود")
    is_owner = row.employee_id == (user.employee_id or 0)
    if not is_owner and user.role not in (Role.admin, Role.hr):
        raise HTTPException(status_code=403, detail="هذا الطلب ليس لك")
    if row.status != LeaveStatus.pending:
        raise HTTPException(status_code=400, detail="لا يُلغى طلب محسوم")
    row.status = LeaveStatus.cancelled
    audit.log(db, user, "cancel", "punch_request", row.id, commit=False)
    db.commit()
    return {"ok": True, "message": "أُلغي الطلب"}
