"""سياسات الحضور والاستراحة: افتراضية للنظام، وأخرى لكل فرع أو إدارة أو وردية."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    AttendancePolicy,
    Department,
    Employee,
    PolicyScope,
    Shift,
    User,
    WorkSite,
)
from ..security import get_current_user, require_hr
from ..services import audit
from ..services import policies as policy_service

router = APIRouter(prefix="/api/attendance-policies", tags=["attendance-policies"])

SCOPE_LABELS = {
    PolicyScope.default: "افتراضية (كل الموظفين)",
    PolicyScope.site: "فرع",
    PolicyScope.department: "إدارة",
    PolicyScope.shift: "وردية",
}


class PolicyIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    scope: PolicyScope = PolicyScope.default
    scope_id: int | None = None
    is_active: bool = True
    break_allowance_minutes: int | None = Field(default=None, ge=0, le=600)
    break_grace_minutes: int | None = Field(default=None, ge=0, le=120)
    max_break_count: int | None = Field(default=None, ge=0, le=20)
    max_total_break_minutes: int | None = Field(default=None, ge=0, le=600)
    deduct_breaks: bool | None = None
    clock_out_from_minutes: int | None = Field(default=None, ge=0, le=480)
    early_leave_grace_minutes: int | None = Field(default=None, ge=0, le=240)
    late_grace_minutes: int | None = Field(default=None, ge=0, le=240)
    debounce_seconds: int | None = Field(default=None, ge=0, le=300)


class PolicyOut(PolicyIn):
    id: int
    scope_label: str = ""
    scope_name: str | None = None


def _scope_name(db: Session, scope: PolicyScope, scope_id: int | None) -> str | None:
    if scope is PolicyScope.default or scope_id is None:
        return None
    model = {PolicyScope.site: WorkSite, PolicyScope.department: Department,
             PolicyScope.shift: Shift}[scope]
    row = db.get(model, scope_id)
    return row.name if row else None


def _out(db: Session, row: AttendancePolicy) -> PolicyOut:
    return PolicyOut(
        id=row.id,
        name=row.name,
        scope=row.scope,
        scope_id=row.scope_id,
        is_active=row.is_active,
        break_allowance_minutes=row.break_allowance_minutes,
        break_grace_minutes=row.break_grace_minutes,
        max_break_count=row.max_break_count,
        max_total_break_minutes=row.max_total_break_minutes,
        deduct_breaks=row.deduct_breaks,
        clock_out_from_minutes=row.clock_out_from_minutes,
        early_leave_grace_minutes=row.early_leave_grace_minutes,
        late_grace_minutes=row.late_grace_minutes,
        debounce_seconds=row.debounce_seconds,
        scope_label=SCOPE_LABELS[row.scope],
        scope_name=_scope_name(db, row.scope, row.scope_id),
    )


def _validate(db: Session, payload: PolicyIn) -> None:
    if payload.scope is PolicyScope.default:
        return
    if payload.scope_id is None:
        raise HTTPException(status_code=400, detail="حدّد الفرع أو الإدارة أو الوردية")
    if _scope_name(db, payload.scope, payload.scope_id) is None:
        raise HTTPException(status_code=400, detail="النطاق المحدّد غير موجود")


@router.get("", response_model=list[PolicyOut])
def list_policies(db: Session = Depends(get_db), _: User = Depends(require_hr)):
    rows = db.scalars(select(AttendancePolicy).order_by(AttendancePolicy.id)).all()
    return [_out(db, row) for row in rows]


@router.get("/effective")
def effective_policy(
    employee_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """السياسة المطبَّقة فعلاً بعد دمج المستويات — للتأكد قبل الحفظ."""
    if employee_id:
        employee = db.get(Employee, employee_id)
        if not employee:
            raise HTTPException(status_code=404, detail="الموظف غير موجود")
        policy = policy_service.resolve(db, employee)
    else:
        policy = policy_service.defaults(db)
    data = policy.__dict__.copy()
    data["break_limit"] = policy.break_limit
    return data


@router.post("", response_model=PolicyOut, status_code=201)
def create_policy(
    payload: PolicyIn, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    _validate(db, payload)
    existing = db.scalar(
        select(AttendancePolicy).where(
            AttendancePolicy.scope == payload.scope,
            AttendancePolicy.scope_id == payload.scope_id,
        )
    )
    if existing:
        raise HTTPException(status_code=400, detail="توجد سياسة لهذا النطاق — عدّلها بدل إضافة أخرى")
    row = AttendancePolicy(**payload.model_dump())
    db.add(row)
    db.flush()
    audit.log(db, user, "create", "settings", row.id, f"سياسة حضور: {row.name}", commit=False)
    db.commit()
    db.refresh(row)
    return _out(db, row)


@router.put("/{policy_id}", response_model=PolicyOut)
def update_policy(
    policy_id: int,
    payload: PolicyIn,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    row = db.get(AttendancePolicy, policy_id)
    if not row:
        raise HTTPException(status_code=404, detail="السياسة غير موجودة")
    _validate(db, payload)
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    audit.log(db, user, "update", "settings", row.id, f"سياسة حضور: {row.name}", commit=False)
    db.commit()
    db.refresh(row)
    return _out(db, row)


@router.delete("/{policy_id}")
def delete_policy(
    policy_id: int, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    row = db.get(AttendancePolicy, policy_id)
    if not row:
        raise HTTPException(status_code=404, detail="السياسة غير موجودة")
    name = row.name
    db.delete(row)
    audit.log(db, user, "delete", "settings", policy_id, f"حذف سياسة حضور: {name}", commit=False)
    db.commit()
    return {"ok": True}
