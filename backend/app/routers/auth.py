"""تسجيل الدخول وإدارة الحساب الشخصي."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Employee, User
from ..schemas import PasswordChange, Token, UserOut
from ..security import create_access_token, get_current_user, hash_password, verify_password
from ..services import audit

router = APIRouter(prefix="/api/auth", tags=["auth"])


def user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        username=user.username,
        role=user.role,
        is_active=user.is_active,
        employee_id=user.employee_id,
        employee_name=user.employee.full_name if user.employee else None,
        must_change_password=bool(user.must_change_password),
    )


from ..services.accounts import normalize_phone


def find_login_user(db: Session, identifier: str) -> User | None:
    """يقبل اسم المستخدم أو رقم جوال الموظف (بأي صيغة معتادة)."""
    identifier = (identifier or "").strip()
    user = db.scalar(select(User).where(User.username == identifier))
    if user:
        return user

    phone = normalize_phone(identifier)
    if len(phone) < 9:
        return None
    matches = [
        employee
        for employee in db.scalars(select(Employee).where(Employee.phone.is_not(None))).all()
        if normalize_phone(employee.phone) == phone
    ]
    if len(matches) != 1:
        # رقم غير موجود، أو مشترك بين أكثر من موظف: لا نخمّن
        return None
    return db.scalar(select(User).where(User.employee_id == matches[0].id))


@router.post("/login", response_model=Token)
def login(form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = find_login_user(db, form.username)
    if not user or not verify_password(form.password, user.password_hash):
        raise HTTPException(
            status_code=401, detail="اسم المستخدم أو رقم الجوال أو كلمة المرور غير صحيحة"
        )
    if not user.is_active:
        raise HTTPException(status_code=403, detail="الحساب موقوف، راجع مدير النظام")
    audit.log(db, user, "login", "user", user.id, f"دخول {user.username}")
    return Token(access_token=create_access_token(user), user=user_out(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user_out(user)


@router.post("/change-password")
def change_password(
    payload: PasswordChange,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="كلمة المرور الحالية غير صحيحة")
    if payload.new_password == payload.current_password:
        raise HTTPException(status_code=400, detail="اختر كلمة مرور مختلفة عن الحالية")
    user.password_hash = hash_password(payload.new_password)
    user.must_change_password = False
    audit.log(db, user, "password", "user", user.id, "تغيير كلمة المرور الذاتية", commit=False)
    db.commit()
    return {"ok": True, "message": "تم تغيير كلمة المرور"}
