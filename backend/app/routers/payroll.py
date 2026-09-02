"""مسير الرواتب: الاحتساب، التعديلات، الاعتماد، وقسائم الموظفين."""
from __future__ import annotations

import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import PayrollRun, PayrollStatus, Payslip, Role, User
from ..schemas import PayrollRunOut, PayslipAdjust, PayslipOut
from ..security import get_current_user, require_hr
from ..services import audit, notifications
from ..services import payroll as service

router = APIRouter(prefix="/api/payroll", tags=["payroll"])


def run_out(db: Session, run: PayrollRun) -> PayrollRunOut:
    return PayrollRunOut(
        id=run.id,
        year=run.year,
        month=run.month,
        status=run.status,
        note=run.note,
        created_at=run.created_at,
        approved_at=run.approved_at,
        **service.totals(db, run.id),
    )


def payslip_out(slip: Payslip) -> PayslipOut:
    return PayslipOut(
        id=slip.id,
        run_id=slip.run_id,
        employee_id=slip.employee_id,
        employee_code=slip.employee.code if slip.employee else None,
        employee_name=slip.employee.full_name if slip.employee else None,
        department_name=slip.employee.department.name if slip.employee and slip.employee.department else None,
        basic_salary=slip.basic_salary,
        present_days=slip.present_days,
        absent_days=slip.absent_days,
        paid_leave_days=slip.paid_leave_days,
        unpaid_leave_days=slip.unpaid_leave_days,
        late_minutes=slip.late_minutes,
        overtime_minutes=slip.overtime_minutes,
        absence_deduction=slip.absence_deduction,
        late_deduction=slip.late_deduction,
        unpaid_leave_deduction=slip.unpaid_leave_deduction,
        violation_deduction=slip.violation_deduction,
        overtime_amount=slip.overtime_amount,
        other_additions=slip.other_additions,
        other_deductions=slip.other_deductions,
        net_pay=slip.net_pay,
        note=slip.note,
    )


@router.get("/runs", response_model=list[PayrollRunOut], dependencies=[Depends(require_hr)])
def list_runs(db: Session = Depends(get_db)):
    runs = db.scalars(select(PayrollRun).order_by(desc(PayrollRun.year), desc(PayrollRun.month))).all()
    return [run_out(db, r) for r in runs]


@router.post("/runs", response_model=PayrollRunOut, status_code=201)
def create_run(
    year: int = Query(default_factory=lambda: date.today().year),
    month: int = Query(default_factory=lambda: date.today().month),
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """يحتسب مسير الشهر من بيانات الحضور والإجازات والمخالفات."""
    run = service.build_run(db, year, month, user.id)
    audit.log(db, user, "payroll", "payroll", run.id, f"احتساب مسير {month}/{year}")
    return run_out(db, run)


@router.get("/runs/{run_id}", response_model=PayrollRunOut, dependencies=[Depends(require_hr)])
def get_run(run_id: int, db: Session = Depends(get_db)):
    run = db.get(PayrollRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="المسير غير موجود")
    return run_out(db, run)


@router.get("/runs/{run_id}/payslips", response_model=list[PayslipOut], dependencies=[Depends(require_hr)])
def list_payslips(run_id: int, db: Session = Depends(get_db)):
    if not db.get(PayrollRun, run_id):
        raise HTTPException(status_code=404, detail="المسير غير موجود")
    slips = db.scalars(select(Payslip).where(Payslip.run_id == run_id)).all()
    return [payslip_out(s) for s in sorted(slips, key=lambda s: s.employee.code if s.employee else "")]


@router.patch("/payslips/{payslip_id}", response_model=PayslipOut)
def adjust_payslip(
    payslip_id: int,
    payload: PayslipAdjust,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """إضافة بدلات أو خصومات يدوية قبل اعتماد المسير."""
    slip = db.get(Payslip, payslip_id)
    if not slip:
        raise HTTPException(status_code=404, detail="القسيمة غير موجودة")
    run = db.get(PayrollRun, slip.run_id)
    if run and run.status == PayrollStatus.approved:
        raise HTTPException(status_code=400, detail="المسير معتمد ولا يمكن تعديله")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(slip, key, value)
    slip.net_pay = max(
        0.0,
        round(
            slip.basic_salary + slip.overtime_amount + slip.other_additions
            - slip.absence_deduction - slip.late_deduction - slip.unpaid_leave_deduction
            - slip.violation_deduction - slip.other_deductions,
            2,
        ),
    )
    audit.log(db, user, "update", "payroll", slip.run_id, f"تعديل قسيمة {slip.employee_id}", commit=False)
    db.commit()
    db.refresh(slip)
    return payslip_out(slip)


@router.post("/runs/{run_id}/approve", response_model=PayrollRunOut)
def approve_run(run_id: int, db: Session = Depends(get_db), user: User = Depends(require_hr)):
    run = db.get(PayrollRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="المسير غير موجود")
    run = service.approve_run(db, run)
    audit.log(db, user, "approve", "payroll", run.id, f"اعتماد مسير {run.month}/{run.year}")
    for slip in db.scalars(select(Payslip).where(Payslip.run_id == run.id)).all():
        notifications.notify_employee(
            db, slip.employee_id,
            f"قسيمة راتب {run.month}/{run.year} جاهزة",
            body=f"صافي الراتب: {slip.net_pay} ريال",
            category="payroll", link_page="payroll", commit=False,
        )
    db.commit()
    return run_out(db, run)


@router.delete("/runs/{run_id}")
def delete_run(run_id: int, db: Session = Depends(get_db), user: User = Depends(require_hr)):
    run = db.get(PayrollRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="المسير غير موجود")
    if run.status == PayrollStatus.approved:
        raise HTTPException(status_code=400, detail="لا يمكن حذف مسير معتمد")
    db.delete(run)
    audit.log(db, user, "delete", "payroll", run_id, commit=False)
    db.commit()
    return {"ok": True}


@router.get("/my-payslips", response_model=list[PayslipOut])
def my_payslips(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """قسائم الموظف المعتمدة فقط."""
    if not user.employee_id:
        return []
    approved_runs = [
        r.id for r in db.scalars(select(PayrollRun).where(PayrollRun.status == PayrollStatus.approved)).all()
    ]
    if not approved_runs:
        return []
    slips = db.scalars(
        select(Payslip).where(
            Payslip.employee_id == user.employee_id, Payslip.run_id.in_(approved_runs)
        )
    ).all()
    return [payslip_out(s) for s in sorted(slips, key=lambda s: s.run_id, reverse=True)]


@router.get("/runs/{run_id}/export.csv", dependencies=[Depends(require_hr)])
def export_run(run_id: int, db: Session = Depends(get_db)):
    run = db.get(PayrollRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="المسير غير موجود")
    slips = db.scalars(select(Payslip).where(Payslip.run_id == run_id)).all()
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "رقم الموظف", "الاسم", "الإدارة", "الراتب الأساسي", "أيام الحضور", "أيام الغياب",
        "إجازة مدفوعة", "إجازة بدون راتب", "دقائق التأخير", "دقائق الإضافي",
        "خصم الغياب", "خصم التأخير", "خصم إجازة بدون راتب", "خصم المخالفات",
        "بدل الإضافي", "إضافات أخرى", "خصومات أخرى", "صافي الراتب",
    ])
    for s in sorted(slips, key=lambda x: x.employee.code if x.employee else ""):
        writer.writerow([
            s.employee.code if s.employee else "", s.employee.full_name if s.employee else "",
            s.employee.department.name if s.employee and s.employee.department else "",
            s.basic_salary, s.present_days, s.absent_days, s.paid_leave_days, s.unpaid_leave_days,
            s.late_minutes, s.overtime_minutes, s.absence_deduction, s.late_deduction,
            s.unpaid_leave_deduction, s.violation_deduction, s.overtime_amount,
            s.other_additions, s.other_deductions, s.net_pay,
        ])
    return Response(
        "﻿" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=payroll_{run.year}_{run.month:02d}.csv"},
    )
