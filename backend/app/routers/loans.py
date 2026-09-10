"""السلف على الراتب: تسجيلها ومتابعة أقساطها."""
from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Employee, EmployeeLoan, LoanStatus, PayrollRun, PayrollStatus, Role, User
from ..schemas import LoanDecisionIn, LoanIn, LoanOut, LoanRequestIn, LoanUpdate
from ..security import can_view_employee, get_current_user, require_hr
from ..services import audit, loans as loans_service, notifications

router = APIRouter(prefix="/api", tags=["loans"])


LOAN_STATUS_LABELS = {
    LoanStatus.pending: "بانتظار الاعتماد",
    LoanStatus.approved: "معتمدة — بانتظار إقرارك بالاستلام",
    LoanStatus.active: "سارية ويُخصم قسطها",
    LoanStatus.settled: "مسدّدة",
    LoanStatus.cancelled: "ملغاة",
}


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
        status_label=LOAN_STATUS_LABELS.get(loan.status, ""),
        approved_at=loan.approved_at,
        acknowledged_at=loan.acknowledged_at,
        decision_note=loan.decision_note,
        can_acknowledge=loan.status == LoanStatus.approved,
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
    loan = EmployeeLoan(
        **payload.model_dump(), created_by_id=user.id, status=LoanStatus.pending
    )
    db.add(loan)
    db.flush()
    months = len(loans_service.installments(loan))
    audit.log(db, user, "create", "loan", loan.id,
              f"{employee.full_name}: سلفة {payload.amount} على {months} قسط (بانتظار الاعتماد)",
              commit=False)
    notifications.notify_roles(
        db, [Role.admin, Role.hr], "سلفة بانتظار الاعتماد",
        body=f"{employee.full_name}: {payload.amount:.2f} ريال على {months} قسط",
        category="payroll", link_page="loans", commit=False,
    )
    db.commit()
    db.refresh(loan)
    today = date.today()
    return loan_out(loan, today.year, today.month)


@router.post("/loans/request", response_model=LoanOut, status_code=201)
def request_loan(
    payload: LoanRequestIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """الموظف يطلب سلفة بنفسه، فتُرفع للموارد البشرية للاعتماد."""
    if not user.employee_id:
        raise HTTPException(status_code=400, detail="الحساب غير مرتبط بملف موظف")
    if payload.installment_amount > payload.amount:
        raise HTTPException(status_code=400, detail="القسط الشهري أكبر من مبلغ السلفة")
    employee = db.get(Employee, user.employee_id)
    loan = EmployeeLoan(
        employee_id=employee.id,
        amount=payload.amount,
        installment_amount=payload.installment_amount,
        start_year=payload.start_year,
        start_month=payload.start_month,
        reason=payload.reason,
        status=LoanStatus.pending,
        created_by_id=user.id,
    )
    db.add(loan)
    db.flush()
    months = len(loans_service.installments(loan))
    audit.log(db, user, "create", "loan", loan.id,
              f"طلب سلفة من الموظف {employee.full_name}: {payload.amount}", commit=False)
    notifications.notify_roles(
        db, [Role.admin, Role.hr], "طلب سلفة جديد",
        body=f"{employee.full_name} يطلب سلفة {payload.amount:.2f} ريال على {months} قسط",
        category="payroll", link_page="loans", commit=False,
    )
    db.commit()
    db.refresh(loan)
    today = date.today()
    return loan_out(loan, today.year, today.month)


@router.post("/loans/{loan_id}/decide", response_model=LoanOut)
def decide_loan(
    loan_id: int,
    payload: LoanDecisionIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """اعتماد السلفة أو رفضها. بعد الاعتماد تعود للموظف ليقرّ باستلامها."""
    loan = db.get(EmployeeLoan, loan_id)
    if not loan:
        raise HTTPException(status_code=404, detail="السلفة غير موجودة")
    if loan.status != LoanStatus.pending:
        raise HTTPException(status_code=400, detail="السلفة ليست بانتظار الاعتماد")

    loan.decision_note = payload.note
    if payload.approve:
        loan.status = LoanStatus.approved
        loan.approved_by_id = user.id
        loan.approved_at = datetime.now()
        title = "اعتُمدت سلفتك — أقرّ باستلامها"
        body = (f"المبلغ {loan.amount:.2f} ريال. افتح «السلف» واضغط «أقرّ باستلام السلفة»"
                " ليبدأ خصم الأقساط.")
    else:
        loan.status = LoanStatus.cancelled
        title = "رُفض طلب السلفة"
        body = payload.note or "تواصل مع الموارد البشرية لمعرفة السبب."
    db.flush()
    audit.log(db, user, "approve" if payload.approve else "reject", "loan", loan.id,
              f"{'اعتماد' if payload.approve else 'رفض'} سلفة {loan.amount}"
              + (f" — {payload.note}" if payload.note else ""), commit=False)
    notifications.notify_employee(
        db, loan.employee_id, title, body=body,
        category="payroll", link_page="loans", commit=False,
    )
    db.commit()
    db.refresh(loan)
    today = date.today()
    return loan_out(loan, today.year, today.month)


@router.post("/loans/{loan_id}/acknowledge", response_model=LoanOut)
def acknowledge_loan(
    loan_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """إقرار الموظف باستلام السلفة — وبه تبدأ الأقساط تُخصم."""
    loan = db.get(EmployeeLoan, loan_id)
    if not loan:
        raise HTTPException(status_code=404, detail="السلفة غير موجودة")
    if loan.employee_id != (user.employee_id or 0):
        raise HTTPException(status_code=403, detail="هذه السلفة ليست لك")
    if loan.status != LoanStatus.approved:
        raise HTTPException(status_code=400, detail="السلفة ليست بانتظار إقرارك")

    loan.status = LoanStatus.active
    loan.acknowledged_at = datetime.now()
    db.flush()
    months = len(loans_service.installments(loan))
    audit.log(db, user, "update", "loan", loan.id,
              f"إقرار الموظف باستلام سلفة {loan.amount}", commit=False)
    notifications.notify_roles(
        db, [Role.admin, Role.hr], "إقرار باستلام سلفة",
        body=f"{loan.employee.full_name} أقرّ باستلام سلفة {loan.amount:.2f} ريال"
             f" — يبدأ الخصم من {loan.start_month:02d}/{loan.start_year} على {months} قسط",
        category="payroll", link_page="loans", commit=False,
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
