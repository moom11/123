"""بياناتي: يطّلع الموظف على بياناته ويحدّث ما يخصّه منها بنفسه."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Employee, Role, User
from ..schemas import MyProfileIn, MyProfileOut
from ..security import get_current_user
from ..services import accounts, audit, notifications

router = APIRouter(prefix="/api/me", tags=["me"])

EDITABLE_LABELS = {
    "national_id": "رقم الهوية / الإقامة",
    "phone": "رقم الجوال",
    "email": "البريد الإلكتروني",
}


def _employee_of(db: Session, user: User) -> Employee:
    employee = db.get(Employee, user.employee_id) if user.employee_id else None
    if not employee:
        raise HTTPException(status_code=400, detail="حسابك غير مرتبط بملف موظف")
    return employee


def profile_out(employee: Employee) -> MyProfileOut:
    return MyProfileOut(
        employee_id=employee.id,
        code=employee.code,
        full_name=employee.full_name,
        job_title=employee.job_title,
        department_name=employee.department.name if employee.department else None,
        shift_name=employee.shift.name if employee.shift else None,
        site_name=employee.site.name if employee.site else None,
        hire_date=employee.hire_date,
        national_id=employee.national_id,
        phone=employee.phone,
        email=employee.email,
        weekly_rest_days=employee.weekly_rest_days,
        basic_salary=employee.basic_salary or 0,
        allowances=employee.allowances or 0,
        total_salary=round((employee.basic_salary or 0) + (employee.allowances or 0), 2),
    )


@router.get("/profile", response_model=MyProfileOut)
def my_profile(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return profile_out(_employee_of(db, user))


@router.put("/profile", response_model=MyProfileOut)
def update_my_profile(
    payload: MyProfileIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """يحدّث الموظف هويته وجواله وبريده فقط — وبقية البيانات للموارد البشرية."""
    employee = _employee_of(db, user)
    data = payload.model_dump(exclude_unset=True)

    phone = (data.get("phone") or "").strip()
    if phone:
        conflict = accounts.phone_conflict(db, phone, employee.id)
        if conflict:
            raise HTTPException(
                status_code=400,
                detail="رقم الجوال مسجّل لموظف آخر — راجع الموارد البشرية",
            )

    changed: list[str] = []
    for field, label in EDITABLE_LABELS.items():
        if field not in data:
            continue
        value = (data[field] or "").strip() or None
        if value != getattr(employee, field):
            setattr(employee, field, value)
            changed.append(label)

    if not changed:
        return profile_out(employee)

    audit.log(db, user, "update", "employee", employee.id,
              "تحديث ذاتي: " + "، ".join(changed), commit=False)
    notifications.notify_roles(
        db, [Role.admin, Role.hr],
        f"{employee.full_name} حدّث بياناته",
        body="الحقول: " + "، ".join(changed),
        category="employee", link_page="employees", commit=False,
    )
    db.commit()
    db.refresh(employee)
    return profile_out(employee)
