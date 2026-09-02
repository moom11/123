"""الموظفون والإدارات والورديات."""
from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Department, Employee, EmployeeStatus, Role, Shift, User
from ..schemas import (
    DepartmentIn,
    DepartmentOut,
    EmployeeIn,
    EmployeeOut,
    EmployeeUpdate,
    ShiftIn,
    ShiftOut,
)
from ..security import get_current_user, require_hr

router = APIRouter(prefix="/api", tags=["employees"])


def employee_out(emp: Employee) -> EmployeeOut:
    return EmployeeOut(
        id=emp.id,
        code=emp.code,
        full_name=emp.full_name,
        national_id=emp.national_id,
        email=emp.email,
        phone=emp.phone,
        job_title=emp.job_title,
        department_id=emp.department_id,
        department_name=emp.department.name if emp.department else None,
        shift_id=emp.shift_id,
        shift_name=emp.shift.name if emp.shift else None,
        manager_id=emp.manager_id,
        hire_date=emp.hire_date,
        basic_salary=emp.basic_salary,
        status=emp.status,
        has_user=emp.user is not None,
    )


# ------------------------------ الموظفون ------------------------------
@router.get("/employees", response_model=list[EmployeeOut])
def list_employees(
    q: str | None = None,
    department_id: int | None = None,
    status: EmployeeStatus | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(Employee)
    if user.role == Role.employee:
        stmt = stmt.where(Employee.id == (user.employee_id or 0))
    elif user.role == Role.manager and user.employee_id:
        stmt = stmt.where(
            (Employee.manager_id == user.employee_id) | (Employee.id == user.employee_id)
        )
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where((Employee.full_name.like(like)) | (Employee.code.like(like)))
    if department_id:
        stmt = stmt.where(Employee.department_id == department_id)
    if status:
        stmt = stmt.where(Employee.status == status)
    rows = db.scalars(stmt.order_by(Employee.code)).all()
    return [employee_out(e) for e in rows]


@router.post("/employees", response_model=EmployeeOut, status_code=201, dependencies=[Depends(require_hr)])
def create_employee(payload: EmployeeIn, db: Session = Depends(get_db)):
    if db.scalar(select(Employee).where(Employee.code == payload.code)):
        raise HTTPException(status_code=400, detail="رقم الموظف مستخدم مسبقاً")
    emp = Employee(**payload.model_dump())
    db.add(emp)
    db.commit()
    db.refresh(emp)
    _link_orphan_punches(db, emp)
    return employee_out(emp)


def _link_orphan_punches(db: Session, emp: Employee) -> None:
    """يربط البصمات التي وصلت قبل إنشاء الموظف بنفس رقمه في الجهاز."""
    from ..models import Punch
    from ..services import attendance as attendance_service

    orphans = db.scalars(
        select(Punch).where(Punch.employee_code == emp.code, Punch.employee_id.is_(None))
    ).all()
    if not orphans:
        return
    for p in orphans:
        p.employee_id = emp.id
    db.flush()
    attendance_service.recompute_for_punches(db, orphans)


@router.get("/employees/{employee_id}", response_model=EmployeeOut)
def get_employee(employee_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from ..security import can_view_employee

    emp = db.get(Employee, employee_id)
    if not emp:
        raise HTTPException(status_code=404, detail="الموظف غير موجود")
    if not can_view_employee(user, employee_id, db):
        raise HTTPException(status_code=403, detail="لا تملك صلاحية عرض هذا الموظف")
    return employee_out(emp)


@router.patch("/employees/{employee_id}", response_model=EmployeeOut, dependencies=[Depends(require_hr)])
def update_employee(employee_id: int, payload: EmployeeUpdate, db: Session = Depends(get_db)):
    emp = db.get(Employee, employee_id)
    if not emp:
        raise HTTPException(status_code=404, detail="الموظف غير موجود")
    data = payload.model_dump(exclude_unset=True)
    if "code" in data and data["code"] != emp.code:
        if db.scalar(select(Employee).where(Employee.code == data["code"])):
            raise HTTPException(status_code=400, detail="رقم الموظف مستخدم مسبقاً")
    for key, value in data.items():
        setattr(emp, key, value)
    db.commit()
    db.refresh(emp)
    return employee_out(emp)


@router.delete("/employees/{employee_id}", dependencies=[Depends(require_hr)])
def delete_employee(employee_id: int, db: Session = Depends(get_db)):
    emp = db.get(Employee, employee_id)
    if not emp:
        raise HTTPException(status_code=404, detail="الموظف غير موجود")
    db.delete(emp)
    db.commit()
    return {"ok": True}


@router.get("/employees-export.csv", dependencies=[Depends(require_hr)])
def export_employees(db: Session = Depends(get_db)):
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["رقم الموظف", "الاسم", "الإدارة", "المسمى", "الوردية", "تاريخ التعيين", "الحالة"])
    for e in db.scalars(select(Employee).order_by(Employee.code)).all():
        writer.writerow([
            e.code,
            e.full_name,
            e.department.name if e.department else "",
            e.job_title or "",
            e.shift.name if e.shift else "",
            e.hire_date or "",
            e.status.value,
        ])
    return Response(
        "﻿" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=employees.csv"},
    )


# ------------------------------ الإدارات ------------------------------
@router.get("/departments", response_model=list[DepartmentOut])
def list_departments(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    counts = dict(
        db.execute(
            select(Employee.department_id, func.count(Employee.id)).group_by(Employee.department_id)
        ).all()
    )
    return [
        DepartmentOut(
            id=d.id, name=d.name, manager_id=d.manager_id, employees_count=counts.get(d.id, 0)
        )
        for d in db.scalars(select(Department).order_by(Department.name)).all()
    ]


@router.post("/departments", response_model=DepartmentOut, status_code=201, dependencies=[Depends(require_hr)])
def create_department(payload: DepartmentIn, db: Session = Depends(get_db)):
    if db.scalar(select(Department).where(Department.name == payload.name)):
        raise HTTPException(status_code=400, detail="الإدارة موجودة مسبقاً")
    dep = Department(**payload.model_dump())
    db.add(dep)
    db.commit()
    db.refresh(dep)
    return DepartmentOut(id=dep.id, name=dep.name, manager_id=dep.manager_id, employees_count=0)


@router.patch("/departments/{dep_id}", response_model=DepartmentOut, dependencies=[Depends(require_hr)])
def update_department(dep_id: int, payload: DepartmentIn, db: Session = Depends(get_db)):
    dep = db.get(Department, dep_id)
    if not dep:
        raise HTTPException(status_code=404, detail="الإدارة غير موجودة")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(dep, key, value)
    db.commit()
    db.refresh(dep)
    return DepartmentOut(id=dep.id, name=dep.name, manager_id=dep.manager_id)


@router.delete("/departments/{dep_id}", dependencies=[Depends(require_hr)])
def delete_department(dep_id: int, db: Session = Depends(get_db)):
    dep = db.get(Department, dep_id)
    if not dep:
        raise HTTPException(status_code=404, detail="الإدارة غير موجودة")
    db.delete(dep)
    db.commit()
    return {"ok": True}


# ------------------------------ الورديات ------------------------------
@router.get("/shifts", response_model=list[ShiftOut])
def list_shifts(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return db.scalars(select(Shift).order_by(Shift.name)).all()


@router.post("/shifts", response_model=ShiftOut, status_code=201, dependencies=[Depends(require_hr)])
def create_shift(payload: ShiftIn, db: Session = Depends(get_db)):
    if db.scalar(select(Shift).where(Shift.name == payload.name)):
        raise HTTPException(status_code=400, detail="اسم الوردية مستخدم مسبقاً")
    shift = Shift(**payload.model_dump())
    db.add(shift)
    db.commit()
    db.refresh(shift)
    return shift


@router.patch("/shifts/{shift_id}", response_model=ShiftOut, dependencies=[Depends(require_hr)])
def update_shift(shift_id: int, payload: ShiftIn, db: Session = Depends(get_db)):
    shift = db.get(Shift, shift_id)
    if not shift:
        raise HTTPException(status_code=404, detail="الوردية غير موجودة")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(shift, key, value)
    db.commit()
    db.refresh(shift)
    return shift


@router.delete("/shifts/{shift_id}", dependencies=[Depends(require_hr)])
def delete_shift(shift_id: int, db: Session = Depends(get_db)):
    shift = db.get(Shift, shift_id)
    if not shift:
        raise HTTPException(status_code=404, detail="الوردية غير موجودة")
    db.delete(shift)
    db.commit()
    return {"ok": True}
