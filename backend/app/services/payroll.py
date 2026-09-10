"""مسير الرواتب: احتساب الخصومات والإضافي من بيانات الحضور والإجازات والمخالفات."""
from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    AttendanceDay,
    DayStatus,
    Employee,
    EmployeeStatus,
    LeaveRequest,
    PayrollRun,
    PayrollStatus,
    Payslip,
)
from . import attendance as attendance_service
from . import loans as loans_service
from . import purchases as purchases_service
from . import settings_store, violations


def _rates(db: Session, monthly_salary: float) -> tuple[float, float]:
    """أجر اليوم وأجر الساعة من الأجر الشهري المعتمد."""
    days = settings_store.get_int(db, "payroll_days_per_month", 30) or 30
    hours = settings_store.get_int(db, "payroll_workday_hours", 8) or 8
    daily = (monthly_salary or 0) / days
    return round(daily, 4), round(daily / hours, 4)


def compute_payslip(db: Session, employee: Employee, year: int, month: int) -> dict:
    """يحسب قسيمة راتب موظف واحد لشهر محدد."""
    last_day = monthrange(year, month)[1]
    start, end = date(year, month, 1), date(year, month, last_day)
    daily, hourly = _rates(db, violations.salary_base(db, employee))

    rows = db.scalars(
        select(AttendanceDay).where(
            AttendanceDay.employee_id == employee.id,
            AttendanceDay.work_date >= start,
            AttendanceDay.work_date <= end,
        )
    ).all()

    present_days = sum(1 for r in rows if r.status in (DayStatus.present, DayStatus.late, DayStatus.missing_out))
    absent_days = sum(1 for r in rows if r.status == DayStatus.absent)
    late_minutes = sum(r.late_minutes for r in rows)
    overtime_minutes = sum(r.overtime_minutes for r in rows)

    # فصل أيام الإجازة إلى مدفوعة وغير مدفوعة
    paid_leave_days = unpaid_leave_days = 0.0
    leave_cache: dict[int, bool] = {}
    for row in rows:
        if row.status != DayStatus.leave:
            continue
        is_paid = True
        if row.leave_request_id:
            if row.leave_request_id not in leave_cache:
                request = db.get(LeaveRequest, row.leave_request_id)
                leave_cache[row.leave_request_id] = bool(
                    request and request.leave_type and request.leave_type.is_paid
                )
            is_paid = leave_cache[row.leave_request_id]
        if is_paid:
            paid_leave_days += 1
        else:
            unpaid_leave_days += 1

    absence_multiplier = float(settings_store.get(db, "payroll_absence_multiplier") or 1)
    overtime_multiplier = float(settings_store.get(db, "payroll_overtime_multiplier") or 1.5)
    late_mode = settings_store.get(db, "payroll_late_deduction_mode")

    absence_deduction = round(absent_days * daily * absence_multiplier, 2)
    unpaid_leave_deduction = round(unpaid_leave_days * daily, 2)
    late_deduction = round((late_minutes / 60) * hourly, 2) if late_mode == "proportional" else 0.0
    overtime_amount = round((overtime_minutes / 60) * hourly * overtime_multiplier, 2)
    violation_deduction = violations.monthly_deduction(db, employee.id, year, month)
    loan_deduction = loans_service.monthly_deduction(db, employee.id, year, month)

    purchases_deduction = purchases_service.monthly_deduction(db, employee.id, year, month)

    basic = round(employee.basic_salary or 0, 2)
    allowances = round(employee.allowances or 0, 2)
    net = round(
        basic + allowances + overtime_amount
        - absence_deduction - unpaid_leave_deduction - late_deduction - violation_deduction
        - loan_deduction - purchases_deduction,
        2,
    )
    return {
        "employee_id": employee.id,
        "basic_salary": basic,
        "allowances": allowances,
        "present_days": present_days,
        "absent_days": absent_days,
        "paid_leave_days": paid_leave_days,
        "unpaid_leave_days": unpaid_leave_days,
        "late_minutes": late_minutes,
        "overtime_minutes": overtime_minutes,
        "absence_deduction": absence_deduction,
        "late_deduction": late_deduction,
        "unpaid_leave_deduction": unpaid_leave_deduction,
        "violation_deduction": violation_deduction,
        "loan_deduction": loan_deduction,
        "purchases_deduction": purchases_deduction,
        "overtime_amount": overtime_amount,
        "other_additions": 0.0,
        "other_deductions": 0.0,
        "net_pay": max(net, 0.0),
    }


def build_run(db: Session, year: int, month: int, user_id: int | None) -> PayrollRun:
    """ينشئ (أو يعيد بناء) مسير رواتب شهر كامل لكل الموظفين النشطين."""
    if not 1 <= month <= 12:
        raise HTTPException(status_code=400, detail="الشهر غير صحيح")
    run = db.scalar(select(PayrollRun).where(PayrollRun.year == year, PayrollRun.month == month))
    if run and run.status == PayrollStatus.approved:
        raise HTTPException(status_code=400, detail="المسير معتمد، لا يمكن إعادة احتسابه")
    if run is None:
        run = PayrollRun(year=year, month=month, created_by_id=user_id)
        db.add(run)
        db.flush()

    employees = db.scalars(
        select(Employee).where(Employee.status == EmployeeStatus.active).order_by(Employee.code)
    ).all()
    if not employees:
        raise HTTPException(status_code=400, detail="لا يوجد موظفون نشطون لاحتساب المسير")

    last_day = monthrange(year, month)[1]
    attendance_service.recompute(
        db, date(year, month, 1), date(year, month, last_day), [e.id for e in employees]
    )

    existing = {p.employee_id: p for p in db.scalars(select(Payslip).where(Payslip.run_id == run.id)).all()}
    for employee in employees:
        data = compute_payslip(db, employee, year, month)
        slip = existing.get(employee.id)
        if slip is None:
            db.add(Payslip(run_id=run.id, **data))
        else:
            for key, value in data.items():
                setattr(slip, key, value)
    db.commit()
    db.refresh(run)
    return run


def approve_run(db: Session, run: PayrollRun) -> PayrollRun:
    if run.status == PayrollStatus.approved:
        raise HTTPException(status_code=400, detail="المسير معتمد مسبقاً")
    run.status = PayrollStatus.approved
    run.approved_at = datetime.now()
    db.commit()
    db.refresh(run)
    return run


def totals(db: Session, run_id: int) -> dict:
    slips = db.scalars(select(Payslip).where(Payslip.run_id == run_id)).all()
    return {
        "employees": len(slips),
        "basic_total": round(sum(s.basic_salary for s in slips), 2),
        "allowances_total": round(sum(s.allowances or 0 for s in slips), 2),
        "loans_total": round(sum(s.loan_deduction or 0 for s in slips), 2),
        "purchases_total": round(sum(s.purchases_deduction or 0 for s in slips), 2),
        "deductions_total": round(
            sum(
                s.absence_deduction + s.late_deduction + s.unpaid_leave_deduction
                + s.violation_deduction + (s.loan_deduction or 0)
                + (s.purchases_deduction or 0) + s.other_deductions
                for s in slips
            ),
            2,
        ),
        "overtime_total": round(sum(s.overtime_amount for s in slips), 2),
        "net_total": round(sum(s.net_pay for s in slips), 2),
    }


def earned_to_date(db: Session, employee: Employee, on_date: date | None = None) -> dict:
    """المستحق للموظف من بداية الشهر حتى تاريخ اليوم، وما عليه من خصومات.

    الأساس: أجر اليوم × الأيام المنقضية من الشهر (بأيام الشهر المعتمدة في
    الإعدادات، ٣٠ يوماً افتراضياً). فمن راتبه ١٠٠٠ ريال وكان اليوم العاشر
    يكون استحقاقه ١٠٠٠ ÷ ٣٠ × ١٠ = ٣٣٣٫٣٣ ريال قبل الخصومات.
    """
    today = on_date or date.today()
    year, month = today.year, today.month
    month_days = settings_store.get_int(db, "payroll_days_per_month", 30) or 30
    monthly = round((employee.basic_salary or 0) + (employee.allowances or 0), 2)
    base = violations.salary_base(db, employee)
    daily, hourly = _rates(db, base)

    days_elapsed = min(today.day, month_days)
    days_remaining = max(0, month_days - days_elapsed)
    gross = round((monthly / month_days) * days_elapsed, 2)

    # الخصومات الواقعة حتى اليوم فقط
    rows = db.scalars(
        select(AttendanceDay).where(
            AttendanceDay.employee_id == employee.id,
            AttendanceDay.work_date >= date(year, month, 1),
            AttendanceDay.work_date <= today,
        )
    ).all()
    absent_days = sum(1 for r in rows if r.status == DayStatus.absent)
    late_minutes = sum(r.late_minutes for r in rows)
    overtime_minutes = sum(r.overtime_minutes for r in rows)

    multiplier = float(settings_store.get(db, "payroll_absence_multiplier") or 1)
    late_mode = settings_store.get(db, "payroll_late_deduction_mode")
    overtime_multiplier = float(settings_store.get(db, "payroll_overtime_multiplier") or 1.5)

    absence_deduction = round(absent_days * daily * multiplier, 2)
    late_deduction = round((late_minutes / 60) * hourly, 2) if late_mode == "proportional" else 0.0
    overtime_amount = round((overtime_minutes / 60) * hourly * overtime_multiplier, 2)
    violation_deduction = violations.monthly_deduction(db, employee.id, year, month)
    loan_deduction = loans_service.monthly_deduction(db, employee.id, year, month)
    purchases_deduction = purchases_service.deduction_until(db, employee.id, year, month, today)

    deductions = round(
        absence_deduction + late_deduction + violation_deduction
        + loan_deduction + purchases_deduction, 2
    )
    net = round(max(gross + overtime_amount - deductions, 0), 2)

    return {
        "as_of": today,
        "year": year,
        "month": month,
        "monthly_salary": monthly,
        "basic_salary": round(employee.basic_salary or 0, 2),
        "allowances": round(employee.allowances or 0, 2),
        "daily_rate": round(monthly / month_days, 2),
        "month_days": month_days,
        "days_elapsed": days_elapsed,
        "days_remaining": days_remaining,
        "gross_to_date": gross,
        "overtime_amount": overtime_amount,
        "absent_days": absent_days,
        "absence_deduction": absence_deduction,
        "late_minutes": late_minutes,
        "late_deduction": late_deduction,
        "violation_deduction": violation_deduction,
        "loan_deduction": loan_deduction,
        "purchases_deduction": purchases_deduction,
        "deductions_total": deductions,
        "net_to_date": net,
        "expected_full_month": round(monthly, 2),
    }
