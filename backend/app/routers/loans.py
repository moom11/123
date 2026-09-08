"""السلف على الراتب: تسجيلها ومتابعة أقساطها."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Employee, EmployeeLoan, LoanStatus, PayrollRun, PayrollStatus, Role, User
from ..schemas import LoanIn, LoanOut, LoanUpdate
from ..security import can_view_employee, get_current_user, require_hr
from ..services import audit, loans as loans_service, notifications

router = APIRouter(prefix="/api", tags=["loans"])


def loan_out(loan: EmployeeLoan, year: int, month: int) -> LoanOut:
    data = loans_service.summary(loan, year, month)
    return LoanOut(
        id=loan.id,
        employee_id=loan.employee_id,
        employee_code=loan.employee.code if loan.employee else None,
        employee_name=loan.employee.full_name if loan.employee else None,
        amount=loan.amount,
        installment_amount=loan.installment_amount,
        start_year=loan.start_year,
        start_month=loan.start_month,
        reason=loan.reason,
        status=loan.status,
        months=data["months"],
        paid_amount=data["paid_amount"],
        remaining_amount=data["remaining_amount"],
        last_installment=data["last_installment"],
        created_at=loan.created_at,
    )


@router.get("/loans", response_model=list[LoanOut])
def list_loans(
    employee_id: int | None = None,
    status: LoanStatus | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """الموارد البشرية ترى الجميع، والموظف يرى سلفه فقط."""
    stmt = select(EmployeeLoan)
    if user.role == Role.employee:
        stmt = stmt.where(EmployeeLoan.employee_id == (user.employee_id or 0))
    elif employee_id:
        if not can_view_employee(user, employee_id, db):
            raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
        stmt = stmt.where(EmployeeLoan.employee_id == employee_id)
    elif user.role == Role.manager and user.employee_id:
        team = db.scalars(
            select(Employee.id).where(
                (Employee.manager_id == user.employee_id) | (Employee.id == user.employee_id)
            )
        ).all()
        stmt = stmt.where(EmployeeLoan.employee_id.in_(list(team) or [0]))
    if status:
        stmt = stmt.where(EmployeeLoan.status == status)
    today = date.today()
    rows = db.scalars(stmt.order_by(EmployeeLoan.id.desc())).all()
    return [loan_out(loan, today.year, today.month) for loan in rows]


@router.post("/loans", response_model=LoanOut, status_code=201)
def create_loan(payload: LoanIn, db: Session = Depends(get_db), user: User = Depends(require_hr)):
    employee = db.get(Employee, payload.employee_id)
    if not employee:
        raise HTTPException(status_code=404, detail="الموظف غير موجود")
    if payload.installment_amount > payload.amount:
        raise HTTPException(status_code=400, detail="القسط الشهري أكبر من مبلغ السلفة")
    loan = EmployeeLoan(**payload.model_dump(), created_by_id=user.id)
    db.add(loan)
    db.flush()
    months = len(loans_service.installments(loan))
    audit.log(db, user, "create", "loan", loan.id,
              f"{employee.full_name}: سلفة {payload.amount} على {months} قسط", commit=False)
    notifications.notify_employee(
        db, employee.id, "تم تسجيل سلفة على راتبك",
        body=f"المبلغ {payload.amount:.2f} ريال — القسط الشهري {payload.installment_amount:.2f} "
             f"ريال على {months} شهر، ابتداءً من {payload.start_month:02d}/{payload.start_year}",
        category="payroll", link_page="payroll", commit=False,
    )
    db.commit()
    db.refresh(loan)
    today = date.today()
    return loan_out(loan, today.year, today.month)


@router.patch("/loans/{loan_id}", response_model=LoanOut)
def update_loan(
    loan_id: int, payload: LoanUpdate, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    loan = db.get(EmployeeLoan, loan_id)
    if not loan:
        raise HTTPException(status_code=404, detail="السلفة غير موجودة")
    changes = payload.model_dump(exclude_unset=True)
    if "installment_amount" in changes and changes["installment_amount"] > loan.amount:
        raise HTTPException(status_code=400, detail="القسط الشهري أكبر من مبلغ السلفة")
    for key, value in changes.items():
        setattr(loan, key, value)
    audit.log(db, user, "update", "loan", loan.id,
              "، ".join(f"{k}={v}" for k, v in changes.items()), commit=False)
    db.commit()
    db.refresh(loan)
    today = date.today()
    return loan_out(loan, today.year, today.month)


@router.delete("/loans/{loan_id}")
def delete_loan(loan_id: int, db: Session = Depends(get_db), user: User = Depends(require_hr)):
    loan = db.get(EmployeeLoan, loan_id)
    if not loan:
        raise HTTPException(status_code=404, detail="السلفة غير موجودة")
    # لا يجوز حذف سلفة خُصم قسط منها في مسير معتمد
    approved = db.scalars(
        select(PayrollRun).where(PayrollRun.status == PayrollStatus.approved)
    ).all()
    for run in approved:
        if loans_service.installment_for(loan, run.year, run.month) > 0:
            raise HTTPException(
                status_code=400,
                detail=f"خُصم قسط من هذه السلفة في مسير {run.month:02d}/{run.year} المعتمد — "
                       "ألغِها بدل حذفها",
            )
    db.delete(loan)
    audit.log(db, user, "delete", "loan", loan_id, f"حذف سلفة الموظف {loan.employee_id}")
    return {"ok": True, "message": "تم حذف السلفة"}
