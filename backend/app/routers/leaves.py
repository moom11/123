"""الإجازات: الأنواع، الطلبات، الاعتماد، الأرصدة، والعطل الرسمية."""
from __future__ import annotations

import csv
import io
import secrets
from datetime import date, datetime

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import MAX_UPLOAD_BYTES, UPLOAD_DIR
from ..database import get_db
from ..models import (
    Employee,
    Holiday,
    LeaveBalance,
    LeaveRequest,
    LeaveStatus,
    LeaveType,
    Role,
    User,
)
from ..schemas import (
    HolidayIn,
    HolidayOut,
    LeaveBalanceIn,
    LeaveBalanceOut,
    LeaveDecision,
    LeaveRequestIn,
    LeaveRequestOut,
    LeaveTypeIn,
    LeaveTypeOut,
)
from ..security import can_view_employee, get_current_user, require_hr, require_manager
from ..services import attendance as attendance_service
from ..services import audit, notifications
from ..services import leave as leave_service

router = APIRouter(prefix="/api", tags=["leaves"])

ALLOWED_ATTACHMENTS = {".pdf", ".png", ".jpg", ".jpeg", ".webp"}


def request_out(r: LeaveRequest) -> LeaveRequestOut:
    return LeaveRequestOut(
        id=r.id,
        employee_id=r.employee_id,
        employee_name=r.employee.full_name if r.employee else None,
        employee_code=r.employee.code if r.employee else None,
        leave_type_id=r.leave_type_id,
        leave_type_name=r.leave_type.name if r.leave_type else None,
        start_date=r.start_date,
        end_date=r.end_date,
        days=r.days,
        reason=r.reason,
        status=r.status,
        attachment_path=r.attachment_path,
        decided_at=r.decided_at,
        decision_note=r.decision_note,
        created_at=r.created_at,
    )


def balance_out(b: LeaveBalance) -> LeaveBalanceOut:
    return LeaveBalanceOut(
        id=b.id,
        employee_id=b.employee_id,
        employee_name=b.employee.full_name if b.employee else None,
        leave_type_id=b.leave_type_id,
        leave_type_name=b.leave_type.name if b.leave_type else None,
        year=b.year,
        entitled_days=b.entitled_days,
        carried_over_days=b.carried_over_days,
        used_days=b.used_days,
        remaining_days=leave_service.remaining_days(b),
    )


def _can_decide(user: User, req: LeaveRequest, db: Session) -> bool:
    if user.role in (Role.admin, Role.hr):
        return True
    if user.role == Role.manager and user.employee_id:
        emp = db.get(Employee, req.employee_id)
        return bool(
            emp
            and emp.id != user.employee_id
            and (
                emp.manager_id == user.employee_id
                or (emp.department and emp.department.manager_id == user.employee_id)
            )
        )
    return False


# ------------------------------ أنواع الإجازات ------------------------------
@router.get("/leave-types", response_model=list[LeaveTypeOut])
def list_leave_types(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return db.scalars(select(LeaveType).order_by(LeaveType.name)).all()


@router.post("/leave-types", response_model=LeaveTypeOut, status_code=201, dependencies=[Depends(require_hr)])
def create_leave_type(payload: LeaveTypeIn, db: Session = Depends(get_db)):
    if db.scalar(select(LeaveType).where(LeaveType.code == payload.code)):
        raise HTTPException(status_code=400, detail="رمز نوع الإجازة مستخدم مسبقاً")
    lt = LeaveType(**payload.model_dump())
    db.add(lt)
    db.commit()
    db.refresh(lt)
    return lt


@router.patch("/leave-types/{type_id}", response_model=LeaveTypeOut, dependencies=[Depends(require_hr)])
def update_leave_type(type_id: int, payload: LeaveTypeIn, db: Session = Depends(get_db)):
    lt = db.get(LeaveType, type_id)
    if not lt:
        raise HTTPException(status_code=404, detail="نوع الإجازة غير موجود")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(lt, key, value)
    db.commit()
    db.refresh(lt)
    return lt


# ------------------------------ طلبات الإجازة ------------------------------
@router.get("/leave-requests", response_model=list[LeaveRequestOut])
def list_requests(
    status: LeaveStatus | None = None,
    employee_id: int | None = None,
    year: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(LeaveRequest)
    if user.role == Role.employee:
        stmt = stmt.where(LeaveRequest.employee_id == (user.employee_id or 0))
    elif user.role == Role.manager and user.employee_id:
        team = db.scalars(
            select(Employee.id).where(
                (Employee.manager_id == user.employee_id) | (Employee.id == user.employee_id)
            )
        ).all()
        stmt = stmt.where(LeaveRequest.employee_id.in_(list(team)))
    if status:
        stmt = stmt.where(LeaveRequest.status == status)
    if employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(LeaveRequest.employee_id == employee_id)
    if year:
        stmt = stmt.where(
            LeaveRequest.start_date >= date(year, 1, 1), LeaveRequest.start_date <= date(year, 12, 31)
        )
    rows = db.scalars(stmt.order_by(LeaveRequest.created_at.desc(), LeaveRequest.id.desc())).all()
    return [request_out(r) for r in rows]


@router.post("/leave-requests/preview")
def preview_days(payload: LeaveRequestIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """يحسب عدد الأيام والرصيد المتبقي قبل إرسال الطلب."""
    employee_id = payload.employee_id or user.employee_id
    emp = db.get(Employee, employee_id or 0)
    lt = db.get(LeaveType, payload.leave_type_id)
    if not emp or not lt:
        raise HTTPException(status_code=404, detail="الموظف أو نوع الإجازة غير موجود")
    days = leave_service.count_leave_days(db, emp, lt, payload.start_date, payload.end_date)
    balance = leave_service.get_or_create_balance(db, emp.id, lt, payload.start_date.year)
    db.commit()
    return {
        "days": days,
        "remaining_days": leave_service.remaining_days(balance),
        "after_request": round(leave_service.remaining_days(balance) - days, 2) if lt.deducts_balance else None,
    }


@router.post("/leave-requests", response_model=LeaveRequestOut, status_code=201)
def create_request(
    payload: LeaveRequestIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    employee_id = payload.employee_id if user.role in (Role.admin, Role.hr) else user.employee_id
    employee_id = employee_id or user.employee_id
    if not employee_id:
        raise HTTPException(status_code=400, detail="الحساب غير مرتبط بملف موظف")
    emp = db.get(Employee, employee_id)
    lt = db.get(LeaveType, payload.leave_type_id)
    if not emp or not lt:
        raise HTTPException(status_code=404, detail="الموظف أو نوع الإجازة غير موجود")
    days = leave_service.validate_request(db, emp, lt, payload.start_date, payload.end_date)
    req = LeaveRequest(
        employee_id=emp.id,
        leave_type_id=lt.id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        days=days,
        reason=payload.reason,
        status=LeaveStatus.pending,
    )
    db.add(req)
    db.flush()
    audit.log(db, user, "create", "leave_request", req.id,
              f"{emp.full_name} - {lt.name} {payload.start_date}→{payload.end_date}", commit=False)
    notifications.notify_approvers(
        db, emp.id, f"طلب إجازة جديد: {emp.full_name}",
        body=f"{lt.name} من {payload.start_date} إلى {payload.end_date} ({days} يوم)",
        category="leave", link_page="leaves", commit=False,
    )
    db.commit()
    db.refresh(req)
    return request_out(req)


@router.post("/leave-requests/{request_id}/attachment", response_model=LeaveRequestOut)
def upload_attachment(
    request_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    req = db.get(LeaveRequest, request_id)
    if not req:
        raise HTTPException(status_code=404, detail="الطلب غير موجود")
    if user.role not in (Role.admin, Role.hr) and req.employee_id != user.employee_id:
        raise HTTPException(status_code=403, detail="لا تملك صلاحية تعديل هذا الطلب")
    suffix = "." + (file.filename or "").rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
    if suffix not in ALLOWED_ATTACHMENTS:
        raise HTTPException(status_code=400, detail="نوع الملف غير مدعوم (PDF أو صورة فقط)")
    content = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="حجم الملف أكبر من الحد المسموح")
    name = f"leave_{req.id}_{secrets.token_hex(6)}{suffix}"
    (UPLOAD_DIR / name).write_bytes(content)
    req.attachment_path = name
    db.commit()
    db.refresh(req)
    return request_out(req)


@router.post("/leave-requests/{request_id}/approve", response_model=LeaveRequestOut)
def approve_request(
    request_id: int,
    payload: LeaveDecision | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    req = db.get(LeaveRequest, request_id)
    if not req:
        raise HTTPException(status_code=404, detail="الطلب غير موجود")
    if not _can_decide(user, req, db):
        raise HTTPException(status_code=403, detail="لا تملك صلاحية اعتماد هذا الطلب")
    if req.leave_type.requires_attachment and not req.attachment_path:
        raise HTTPException(status_code=400, detail="هذا النوع يتطلب إرفاق مستند قبل الاعتماد")
    req = leave_service.approve(db, req, user.id, payload.decision_note if payload else None)
    audit.log(db, user, "approve", "leave_request", req.id, f"{req.days} يوم")
    notifications.notify_employee(
        db, req.employee_id, "تم اعتماد طلب إجازتك",
        body=f"{req.leave_type.name} من {req.start_date} إلى {req.end_date} ({req.days} يوم)",
        category="leave", link_page="leaves",
    )
    return request_out(req)


@router.post("/leave-requests/{request_id}/reject", response_model=LeaveRequestOut)
def reject_request(
    request_id: int,
    payload: LeaveDecision | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    req = db.get(LeaveRequest, request_id)
    if not req:
        raise HTTPException(status_code=404, detail="الطلب غير موجود")
    if not _can_decide(user, req, db):
        raise HTTPException(status_code=403, detail="لا تملك صلاحية رفض هذا الطلب")
    req = leave_service.reject(db, req, user.id, payload.decision_note if payload else None)
    audit.log(db, user, "reject", "leave_request", req.id, payload.decision_note if payload else None)
    notifications.notify_employee(
        db, req.employee_id, "تم رفض طلب إجازتك",
        body=(payload.decision_note if payload and payload.decision_note else "راجع الموارد البشرية للتفاصيل"),
        category="leave", link_page="leaves",
    )
    return request_out(req)


@router.post("/leave-requests/{request_id}/cancel", response_model=LeaveRequestOut)
def cancel_request(
    request_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    req = db.get(LeaveRequest, request_id)
    if not req:
        raise HTTPException(status_code=404, detail="الطلب غير موجود")
    is_owner = req.employee_id == user.employee_id
    if not is_owner and user.role not in (Role.admin, Role.hr):
        raise HTTPException(status_code=403, detail="لا تملك صلاحية إلغاء هذا الطلب")
    if is_owner and user.role == Role.employee and req.status == LeaveStatus.approved:
        raise HTTPException(status_code=400, detail="راجع الموارد البشرية لإلغاء إجازة معتمدة")
    req = leave_service.cancel(db, req, user.id)
    audit.log(db, user, "cancel", "leave_request", req.id)
    return request_out(req)


# ------------------------------ الأرصدة ------------------------------
@router.get("/leave-balances", response_model=list[LeaveBalanceOut])
def list_balances(
    employee_id: int | None = None,
    year: int = Query(default_factory=lambda: date.today().year),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    target = employee_id
    if user.role == Role.employee:
        target = user.employee_id
    if target and not can_view_employee(user, target, db):
        raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")

    types = db.scalars(select(LeaveType).where(LeaveType.is_active.is_(True))).all()
    employees = (
        [db.get(Employee, target)] if target else db.scalars(select(Employee).order_by(Employee.code)).all()
    )
    employees = [e for e in employees if e]
    result = []
    for emp in employees:
        for lt in types:
            if not lt.deducts_balance:
                continue
            balance = leave_service.get_or_create_balance(db, emp.id, lt, year)
            result.append(balance_out(balance))
    db.commit()
    return result


@router.put("/leave-balances", response_model=LeaveBalanceOut, dependencies=[Depends(require_hr)])
def set_balance(payload: LeaveBalanceIn, db: Session = Depends(get_db)):
    lt = db.get(LeaveType, payload.leave_type_id)
    if not lt or not db.get(Employee, payload.employee_id):
        raise HTTPException(status_code=404, detail="الموظف أو نوع الإجازة غير موجود")
    balance = leave_service.get_or_create_balance(db, payload.employee_id, lt, payload.year)
    balance.entitled_days = payload.entitled_days
    balance.carried_over_days = payload.carried_over_days
    db.commit()
    db.refresh(balance)
    return balance_out(balance)


# ------------------------------ العطل الرسمية ------------------------------
@router.get("/holidays", response_model=list[HolidayOut])
def list_holidays(year: int | None = None, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(Holiday)
    if year:
        stmt = stmt.where(Holiday.holiday_date >= date(year, 1, 1), Holiday.holiday_date <= date(year, 12, 31))
    return db.scalars(stmt.order_by(Holiday.holiday_date)).all()


@router.post("/holidays", response_model=HolidayOut, status_code=201, dependencies=[Depends(require_hr)])
def create_holiday(payload: HolidayIn, db: Session = Depends(get_db)):
    if db.scalar(select(Holiday).where(Holiday.holiday_date == payload.holiday_date)):
        raise HTTPException(status_code=400, detail="العطلة مسجلة مسبقاً في هذا التاريخ")
    h = Holiday(**payload.model_dump())
    db.add(h)
    db.commit()
    db.refresh(h)
    attendance_service.recompute(db, h.holiday_date, h.holiday_date)
    return h


@router.delete("/holidays/{holiday_id}", dependencies=[Depends(require_hr)])
def delete_holiday(holiday_id: int, db: Session = Depends(get_db)):
    h = db.get(Holiday, holiday_id)
    if not h:
        raise HTTPException(status_code=404, detail="العطلة غير موجودة")
    day = h.holiday_date
    db.delete(h)
    db.commit()
    attendance_service.recompute(db, day, day)
    return {"ok": True}


@router.get("/leave-requests-export.csv")
def export_requests(
    year: int = Query(default_factory=lambda: date.today().year),
    db: Session = Depends(get_db),
    user: User = Depends(require_manager),
):
    rows = db.scalars(
        select(LeaveRequest)
        .where(LeaveRequest.start_date >= date(year, 1, 1), LeaveRequest.start_date <= date(year, 12, 31))
        .order_by(LeaveRequest.start_date)
    ).all()
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["رقم الطلب", "رقم الموظف", "الموظف", "نوع الإجازة", "من", "إلى", "الأيام", "الحالة", "السبب"])
    labels = {
        LeaveStatus.pending: "قيد الاعتماد",
        LeaveStatus.approved: "معتمدة",
        LeaveStatus.rejected: "مرفوضة",
        LeaveStatus.cancelled: "ملغاة",
    }
    for r in rows:
        writer.writerow([
            r.id,
            r.employee.code if r.employee else "",
            r.employee.full_name if r.employee else "",
            r.leave_type.name if r.leave_type else "",
            r.start_date,
            r.end_date,
            r.days,
            labels.get(r.status, r.status.value),
            (r.reason or "").replace("\n", " "),
        ])
    return Response(
        "﻿" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=leaves_{year}.csv"},
    )
