"""المصادقة والصلاحيات: تجزئة كلمات المرور، توكن JWT، واعتماديات FastAPI."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from .config import ACCESS_TOKEN_EXPIRE_MINUTES, ALGORITHM, SECRET_KEY
from .database import get_db
from .models import Role, User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(user: User) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "role": user.role.value,
        "exp": expire,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    token: str | None = Depends(oauth2_scheme), db: Session = Depends(get_db)
) -> User:
    credentials_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="بيانات الدخول غير صالحة أو منتهية",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token:
        raise credentials_error
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        raise credentials_error
    user = db.get(User, int(payload.get("sub", 0)))
    if not user or not user.is_active:
        raise credentials_error
    return user


def require_roles(*roles: Role):
    """اعتمادية تتحقق من أن المستخدم يملك أحد الأدوار المطلوبة."""

    allowed = set(roles)

    def _dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in allowed:
            raise HTTPException(status_code=403, detail="لا تملك صلاحية تنفيذ هذا الإجراء")
        return user

    return _dependency


require_admin = require_roles(Role.admin)
require_hr = require_roles(Role.admin, Role.hr)
require_manager = require_roles(Role.admin, Role.hr, Role.manager)


def can_view_employee(user: User, employee_id: int, db: Session) -> bool:
    """الموظف يرى نفسه فقط، والمدير يرى فريقه، والموارد البشرية ترى الجميع."""
    if user.role in (Role.admin, Role.hr):
        return True
    if user.employee_id == employee_id:
        return True
    if user.role == Role.manager and user.employee_id:
        from .models import Employee  # استيراد محلي لتفادي الدوران

        emp = db.get(Employee, employee_id)
        if emp and (
            emp.manager_id == user.employee_id
            or (emp.department and emp.department.manager_id == user.employee_id)
        ):
            return True
    return False
