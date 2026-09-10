"""الطلبات العامة، وشاشة «طلباتي» الموحّدة لكل أنواع الطلبات."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    Employee,
    EmployeeLoan,
    EmployeeRequest,
    LeaveRequest,
    LeaveStatus,
    LoanStatus,
    PunchRequest,
    RequestCategory,
    Role,
    User,
)
from ..security import can_view_employee, get_current_user, require_hr, visible_employee_ids
from ..services import audit, notifications

router = APIRouter(prefix="/api", tags=["requests"])

CATEGORY_LABELS = {
    RequestCategory.certificate: "تعريف أو شهادة",
    RequestCategory.shift_change: "تغيير وردية أو راحة",
    RequestCategory.data_update: "تصحيح بيانات",
    RequestCategory.complaint: "شكوى",
    RequestCategory.suggestion: "اقتراح",
    RequestCategory.other: "طلب آخر",
}

STATUS_LABELS = {
    LeaveStatus.pending: "قيد الاعتماد",
    LeaveStatus.approved: "معتمد",
    LeaveStatus.rejected: "مرفوض",
    LeaveStatus.cancelled: "ملغى",
}

LOAN_STATUS_LABELS = {
    LoanStatus.pending: "بانتظار الاعتماد",
    LoanStatus.approved: "بانتظار إقرارك بالاستلام",
    LoanStatus.active: "معتمدة وتُخصم أقساطها",
    LoanStatus.settled: "مسدّدة",
    LoanStatus.cancelled: "مرفوضة أو ملغاة",
}

# حالة السلفة مقابل حالة الطلب الموحّدة
LOAN_TO_STATUS = {
    LoanStatus.pending: "pending",
    LoanStatus.approved: "approved",
    LoanStatus.active: "approved",
    LoanStatus.settled: "approved",
    LoanStatus.cancelled: "rejected",
}


class RequestIn(BaseModel):
    category: RequestCategory = RequestCategory.other
    subject: str = Field(min_length=3, max_length=160)
    body: str = Field(min_length=3, max_length=4000)
    employee_id: int | None = None      # للموارد البشرية نيابةً عن موظف


class RequestDecision(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=1000)


class RequestOut(BaseModel):
    id: int
    employee_id: int
    employee_code: str | None = None
    employee_name: str | None = None
    category: RequestCategory
    category_label: str
    subject: str
    body: str
    status: LeaveStatus
    status_label: str
    decision_note: str | None = None
    decided_at: datetime | None = None
    created_at: datetime | None = None


def request_out(row: EmployeeRequest) -> RequestOut:
    return RequestOut(
        id=row.id,
        employee_id=row.employee_id,
        employee_code=row.employee.code if row.employee else None,
        employee_name=row.employee.full_name if row.employee else None,
        category=row.category,
        category_label=CATEGORY_LABELS[row.category],
        subject=row.subject,
        body=row.body,
        status=row.status,
        status_label=STATUS_LABELS[row.status],
        decision_note=row.decision_note,
        decided_at=row.decided_at,
        created_at=row.created_at,
    )


@router.get("/requests", response_model=list[RequestOut])
def list_requests(
    status: LeaveStatus | None = None,
    employee_id: int | None = None,
    limit: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(EmployeeRequest)
    if user.role == Role.employee:
        stmt = stmt.where(EmployeeRequest.employee_id == (user.employee_id or 0))
    elif employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(EmployeeRequest.employee_id == employee_id)
    else:
        allowed = visible_employee_ids(db, user)
        if allowed is not None:
            stmt = stmt.where(EmployeeRequest.employee_id.in_(allowed or [0]))
    if status:
        stmt = stmt.where(EmployeeRequest.status == status)
    rows = db.scalars(stmt.order_by(EmployeeRequest.id.desc()).limit(limit)).all()
    return [request_out(row) for row in rows]


@router.post("/requests", response_model=RequestOut, status_code=201)
def create_request(
    payload: RequestIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
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

    row = EmployeeRequest(
        employee_id=employee_id,
        category=payload.category,
        subject=payload.subject.strip(),
        body=payload.body.strip(),
        status=LeaveStatus.pending,
    )
    db.add(row)
    db.flush()
    audit.log(db, user, "create", "request", row.id,
              f"{employee.full_name}: {CATEGORY_LABELS[payload.category]} — {payload.subject}",
              commit=False)
    notifications.notify_approvers(
        db, employee_id, f"طلب جديد: {CATEGORY_LABELS[payload.category]}",
        body=f"{employee.full_name} — {payload.subject}",
        category="general", link_page="requests", commit=False,
    )
    db.commit()
    db.refresh(row)
    return request_out(row)


@router.post("/requests/{request_id}/decide", response_model=RequestOut)
def decide_request(
    request_id: int,
    payload: RequestDecision,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    row = db.get(EmployeeRequest, request_id)
    if not row:
        raise HTTPException(status_code=404, detail="الطلب غير موجود")
    if row.status != LeaveStatus.pending:
        raise HTTPException(status_code=400, detail="الطلب محسوم مسبقاً")

    row.status = LeaveStatus.approved if payload.approve else LeaveStatus.rejected
    row.decided_by_id = user.id
    row.decided_at = datetime.now()
    row.decision_note = payload.note
    audit.log(db, user, "approve" if payload.approve else "reject", "request", row.id,
              f"{row.subject}" + (f" — {payload.note}" if payload.note else ""), commit=False)
    notifications.notify_employee(
        db, row.employee_id,
        ("اعتُمد طلبك: " if payload.approve else "رُفض طلبك: ") + row.subject,
        body=payload.note or "راجع صفحة الطلبات للتفاصيل.",
        category="general", link_page="myLeaves", commit=False,
    )
    db.commit()
    db.refresh(row)
    return request_out(row)


@router.delete("/requests/{request_id}")
def cancel_request(
    request_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    row = db.get(EmployeeRequest, request_id)
    if not row:
        raise HTTPException(status_code=404, detail="الطلب غير موجود")
    is_owner = row.employee_id == (user.employee_id or 0)
    if not is_owner and user.role not in (Role.admin, Role.hr):
        raise HTTPException(status_code=403, detail="هذا الطلب ليس لك")
    if row.status != LeaveStatus.pending:
        raise HTTPException(status_code=400, detail="لا يُلغى طلب محسوم")
    row.status = LeaveStatus.cancelled
    audit.log(db, user, "cancel", "request", row.id, commit=False)
    db.commit()
    return {"ok": True, "message": "أُلغي الطلب"}


# ------------------------------ شاشة «طلباتي» الموحّدة ------------------------------
@router.get("/me/requests")
def my_requests(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """كل طلبات الموظف بأنواعها في قائمة واحدة مرتّبة بالأحدث."""
    if not user.employee_id:
        return {"rows": [], "pending": 0}
    employee_id = user.employee_id
    rows: list[dict] = []

    for leave in db.scalars(
        select(LeaveRequest).where(LeaveRequest.employee_id == employee_id)
    ).all():
        rows.append({
            "kind": "leave",
            "kind_label": "إجازة",
            "id": leave.id,
            "title": leave.leave_type.name if leave.leave_type else "إجازة",
            "detail": f"من {leave.start_date} إلى {leave.end_date} — {leave.days} يوم",
            "note": leave.reason or "",
            "status": leave.status.value,
            "status_label": STATUS_LABELS.get(leave.status, leave.status.value),
            "decision_note": leave.decision_note,
            "at": leave.created_at,
            "can_cancel": leave.status == LeaveStatus.pending,
            "attachment": leave.attachment_path,
        })

    for punch in db.scalars(
        select(PunchRequest).where(PunchRequest.employee_id == employee_id)
    ).all():
        rows.append({
            "kind": "punch",
            "kind_label": "بصمة فائتة",
            "id": punch.id,
            "title": "طلب تسجيل بصمة",
            "detail": f"{punch.requested_time:%Y-%m-%d %H:%M}",
            "note": punch.reason,
            "status": punch.status.value,
            "status_label": STATUS_LABELS.get(punch.status, punch.status.value),
            "decision_note": punch.decision_note,
            "at": punch.created_at,
            "can_cancel": punch.status == LeaveStatus.pending,
            "attachment": None,
        })

    for loan in db.scalars(
        select(EmployeeLoan).where(EmployeeLoan.employee_id == employee_id)
    ).all():
        rows.append({
            "kind": "loan",
            "kind_label": "سلفة",
            "id": loan.id,
            "title": f"سلفة {loan.amount:,.2f} ريال",
            "detail": f"قسط {loan.installment_amount:,.2f} من"
                      f" {loan.start_month:02d}/{loan.start_year}",
            "note": loan.reason or "",
            "status": LOAN_TO_STATUS.get(loan.status, "pending"),
            "status_label": LOAN_STATUS_LABELS.get(loan.status, ""),
            "decision_note": loan.decision_note,
            "at": loan.created_at,
            "can_cancel": False,
            "needs_ack": loan.status == LoanStatus.approved,
            "attachment": None,
        })

    for row in db.scalars(
        select(EmployeeRequest).where(EmployeeRequest.employee_id == employee_id)
    ).all():
        rows.append({
            "kind": "general",
            "kind_label": CATEGORY_LABELS[row.category],
            "id": row.id,
            "title": row.subject,
            "detail": "",
            "note": row.body,
            "status": row.status.value,
            "status_label": STATUS_LABELS.get(row.status, row.status.value),
            "decision_note": row.decision_note,
            "at": row.created_at,
            "can_cancel": row.status == LeaveStatus.pending,
            "attachment": None,
        })

    rows.sort(key=lambda item: (item["at"] or datetime.min), reverse=True)
    return {
        "rows": rows,
        "pending": sum(1 for r in rows if r["status"] == "pending"),
        "needs_action": sum(1 for r in rows if r.get("needs_ack")),
    }
