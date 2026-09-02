"""إدارة مستخدمي النظام (مدير النظام فقط)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Employee, User
from ..schemas import UserCreate, UserOut, UserUpdate
from ..security import hash_password, require_admin
from ..services import audit
from .auth import user_out

router = APIRouter(prefix="/api/users", tags=["users"], dependencies=[Depends(require_admin)])


@router.get("", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db)):
    return [user_out(u) for u in db.scalars(select(User).order_by(User.id)).all()]


@router.post("", response_model=UserOut, status_code=201)
def create_user(
    payload: UserCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)
):
    if db.scalar(select(User).where(User.username == payload.username)):
        raise HTTPException(status_code=400, detail="اسم المستخدم موجود مسبقاً")
    if payload.employee_id and not db.get(Employee, payload.employee_id):
        raise HTTPException(status_code=404, detail="الموظف غير موجود")
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role=payload.role,
        employee_id=payload.employee_id,
    )
    db.add(user)
    db.flush()
    audit.log(db, admin, "create", "user", user.id, f"{user.username} ({user.role.value})", commit=False)
    db.commit()
    db.refresh(user)
    return user_out(user)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(
    user_id: int,
    payload: UserUpdate,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="المستخدم غير موجود")
    data = payload.model_dump(exclude_unset=True)
    if "password" in data and data["password"]:
        user.password_hash = hash_password(data.pop("password"))
    data.pop("password", None)
    for key, value in data.items():
        setattr(user, key, value)
    audit.log(db, admin, "update", "user", user.id, user.username, commit=False)
    db.commit()
    db.refresh(user)
    return user_out(user)


@router.delete("/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="المستخدم غير موجود")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="لا يمكنك حذف حسابك الحالي")
    audit.log(db, admin, "delete", "user", user.id, user.username, commit=False)
    db.delete(user)
    db.commit()
    return {"ok": True}
