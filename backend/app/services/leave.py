"""منطق الإجازات: حساب الأيام، الأرصدة، التعارضات، والاعتماد."""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    Employee,
    Holiday,
    LeaveBalance,
    LeaveRequest,
    LeaveStatus,
    LeaveType,
    Shift,
)
from .attendance import DEFAULT_WORK_DAYS

from . import attendance as attendance_service


def _work_days_for(employee: Employee) -> list[int]:
    shift: Shift | None = employee.shift
    return shift.work_day_list if shift and shift.work_day_list else DEFAULT_WORK_DAYS


def count_leave_days(
    db: Session, employee: Employee, leave_type: LeaveType, start: date, end: date
) -> float:
    """يحسب عدد أيام الإجازة مع استثناء العطل الأسبوعية والرسمية حسب إعداد النوع."""
    if end < start:
        raise HTTPException(status_code=400, detail="تاريخ النهاية قبل تاريخ البداية")
    work_days = _work_days_for(employee)
    holidays = {
        h.holiday_date
        for h in db.scalars(
            select(Holiday).where(Holiday.holiday_date >= start, Holiday.holiday_date <= end)
        ).all()
    }
    days = 0.0
    current = start
    while current <= end:
        if leave_type.exclude_weekends and current.weekday() not in work_days:
            current += timedelta(days=1)
            continue
        if leave_type.exclude_holidays and current in holidays:
            current += timedelta(days=1)
            continue
        days += 1
        current += timedelta(days=1)
    return days


def get_or_create_balance(
    db: Session, employee_id: int, leave_type: LeaveType, year: int
) -> LeaveBalance:
    balance = db.scalar(
        select(LeaveBalance).where(
            LeaveBalance.employee_id == employee_id,
            LeaveBalance.leave_type_id == leave_type.id,
            LeaveBalance.year == year,
        )
    )
    if balance is None:
        balance = LeaveBalance(
            employee_id=employee_id,
            leave_type_id=leave_type.id,
            year=year,
            entitled_days=leave_type.annual_quota_days,
            carried_over_days=0,
            used_days=0,
        )
        db.add(balance)
        db.flush()
    return balance


def remaining_days(balance: LeaveBalance) -> float:
    return round(balance.entitled_days + balance.carried_over_days - balance.used_days, 2)


def check_overlap(db: Session, employee_id: int, start: date, end: date, exclude_id: int | None = None):
    stmt = select(LeaveRequest).where(
        LeaveRequest.employee_id == employee_id,
        LeaveRequest.status.in_([LeaveStatus.pending, LeaveStatus.approved]),
        LeaveRequest.start_date <= end,
        LeaveRequest.end_date >= start,
    )
    if exclude_id:
        stmt = stmt.where(LeaveRequest.id != exclude_id)
    return db.scalar(stmt)


def validate_request(
    db: Session, employee: Employee, leave_type: LeaveType, start: date, end: date
) -> float:
    """يتحقق من صحة طلب الإجازة ويعيد عدد الأيام المحتسبة."""
    if not leave_type.is_active:
        raise HTTPException(status_code=400, detail="نوع الإجازة غير مفعّل")
    days = count_leave_days(db, employee, leave_type, start, end)
    if days <= 0:
        raise HTTPException(
            status_code=400, detail="المدة المختارة لا تحتوي أيام عمل قابلة للاحتساب"
        )
    if leave_type.max_consecutive_days and days > leave_type.max_consecutive_days:
        raise HTTPException(
            status_code=400,
            detail=f"الحد الأقصى لهذا النوع {leave_type.max_consecutive_days} يوم متصل",
        )
    if check_overlap(db, employee.id, start, end):
        raise HTTPException(status_code=400, detail="يوجد طلب إجازة آخر يتقاطع مع هذه الفترة")
    if leave_type.deducts_balance:
        balance = get_or_create_balance(db, employee.id, leave_type, start.year)
        if remaining_days(balance) < days:
            raise HTTPException(
                status_code=400,
                detail=f"الرصيد غير كافٍ: المتبقي {remaining_days(balance)} يوم والمطلوب {days} يوم",
            )
    return days


def approve(db: Session, request: LeaveRequest, user_id: int, note: str | None = None) -> LeaveRequest:
    if request.status != LeaveStatus.pending:
        raise HTTPException(status_code=400, detail="لا يمكن اعتماد طلب تمت معالجته مسبقاً")
    leave_type = request.leave_type
    if leave_type.deducts_balance:
        balance = get_or_create_balance(db, request.employee_id, leave_type, request.start_date.year)
        if remaining_days(balance) < request.days:
            raise HTTPException(status_code=400, detail="الرصيد غير كافٍ لاعتماد الطلب")
        balance.used_days = round(balance.used_days + request.days, 2)
    request.status = LeaveStatus.approved
    request.decided_by_id = user_id
    request.decided_at = datetime.now()
    request.decision_note = note
    db.flush()
    attendance_service.recompute(
        db, request.start_date, request.end_date, [request.employee_id], commit=False
    )
    db.commit()
    db.refresh(request)
    return request


def reject(db: Session, request: LeaveRequest, user_id: int, note: str | None = None) -> LeaveRequest:
    if request.status != LeaveStatus.pending:
        raise HTTPException(status_code=400, detail="لا يمكن رفض طلب تمت معالجته مسبقاً")
    request.status = LeaveStatus.rejected
    request.decided_by_id = user_id
    request.decided_at = datetime.now()
    request.decision_note = note
    db.commit()
    db.refresh(request)
    return request


def cancel(db: Session, request: LeaveRequest, user_id: int) -> LeaveRequest:
    """إلغاء طلب: يعيد الرصيد إن كان معتمداً."""
    if request.status in (LeaveStatus.cancelled, LeaveStatus.rejected):
        raise HTTPException(status_code=400, detail="الطلب ملغى أو مرفوض بالفعل")
    if request.status == LeaveStatus.approved and request.leave_type.deducts_balance:
        balance = get_or_create_balance(
            db, request.employee_id, request.leave_type, request.start_date.year
        )
        balance.used_days = round(max(0.0, balance.used_days - request.days), 2)
    request.status = LeaveStatus.cancelled
    request.decided_by_id = user_id
    request.decided_at = datetime.now()
    db.flush()
    attendance_service.recompute(
        db, request.start_date, request.end_date, [request.employee_id], commit=False
    )
    db.commit()
    db.refresh(request)
    return request
