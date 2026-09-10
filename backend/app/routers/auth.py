"""تسجيل الدخول وإدارة الحساب الشخصي."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Employee, LoginEvent, User
from ..schemas import PasswordChange, Token, UserOut
from ..security import (
    create_access_token,
    get_current_user,
    hash_password,
    revoke_sessions,
    verify_password,
)
from ..security_extra import clear_failures, login_block_seconds, password_problem, register_failure
from ..services import audit, security_log, settings_store, totp

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
def login(
    request: Request,
    form: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    client_ip = request.client.host if request.client else "-"
    agent = request.headers.get("user-agent", "")
    blocked = login_block_seconds(form.username, client_ip)
    if blocked:
        raise HTTPException(
            status_code=429,
            detail=f"تجاوزت عدد المحاولات المسموحة، حاول بعد {max(1, blocked // 60)} دقيقة",
        )

    def fail(reason: str, detail: str, status_code: int = 401, user: User | None = None):
        """يسجّل الفشل في سجل الدخول وسجل التدقيق ثم يعيد الاستثناء المناسب."""
        tries = register_failure(form.username, client_ip)
        security_log.record(db, form.username, client_ip, agent, False, user=user,
                            reason=reason, commit=False)
        audit.log(
            db, None, "login_failed", "user", None,
            f"محاولة فاشلة لـ «{form.username}» من {client_ip} ({reason}، رقم {tries})",
            commit=False,
        )
        _alert_on_burst(db, form.username, client_ip)
        db.commit()
        return HTTPException(status_code=status_code, detail=detail)

    user = find_login_user(db, form.username)
    if not user or not verify_password(form.password, user.password_hash):
        # نربط المحاولة بالحساب إن كان موجوداً ليراها صاحبه في سجل دخوله
        raise fail("كلمة مرور خاطئة",
                   "اسم المستخدم أو رقم الجوال أو كلمة المرور غير صحيحة", user=user)
    if not user.is_active:
        raise fail("حساب موقوف", "الحساب موقوف، راجع مدير النظام", 403, user)

    # التحقق بخطوتين إن كان مفعّلاً على الحساب
    if user.totp_enabled and user.totp_secret:
        code = (form.client_secret or "").strip()
        if not code:
            raise fail("رمز التحقق مطلوب", "أدخل رمز التحقق من تطبيق المصادقة", 401, user)
        if not totp.verify(user.totp_secret, code):
            raise fail("رمز تحقق خاطئ", "رمز التحقق غير صحيح أو انتهت صلاحيته", 401, user)

    clear_failures(form.username, client_ip)
    new_device = security_log.is_new_device(db, user, client_ip, agent)
    security_log.record(db, form.username, client_ip, agent, True, user=user, commit=False)
    audit.log(db, user, "login", "user", user.id,
              f"دخول {user.username} من {client_ip}", commit=False)
    if new_device:
        security_log.notify_new_device(db, user, client_ip, agent)
    db.commit()
    return Token(access_token=create_access_token(user), user=user_out(user))


def _alert_on_burst(db: Session, username: str, ip: str) -> None:
    """تنبيه مديري النظام عند تكرار المحاولات الفاشلة على الحساب نفسه."""
    from ..models import Role
    from ..services import notifications

    count = security_log.failure_burst(db, username)
    if count != 5:      # مرة واحدة فقط عند بلوغ الحد
        return
    admins = db.scalars(
        select(User).where(User.role == Role.admin, User.is_active.is_(True))
    ).all()
    if admins:
        notifications.notify_users(
            db, list(admins), "محاولات دخول فاشلة متكررة",
            body=f"الحساب «{username}» — {count} محاولات فاشلة من {ip} خلال ربع ساعة.",
            category="security", link_page="settings", commit=False,
        )


@router.get("/2fa/status")
def two_factor_status(user: User = Depends(get_current_user)):
    return {"enabled": bool(user.totp_enabled)}


@router.post("/2fa/setup")
def two_factor_setup(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """يولّد سرّاً جديداً ويعيده مع رابط otpauth ليُضاف في تطبيق المصادقة."""
    if user.totp_enabled:
        raise HTTPException(status_code=400, detail="التحقق بخطوتين مفعّل أصلاً")
    secret = totp.new_secret()
    user.totp_secret = secret
    db.commit()
    issuer = settings_store.get(db, "company_name") or "نظام الموارد البشرية"
    return {
        "secret": secret,
        "secret_grouped": totp.grouped(secret),
        "uri": totp.provisioning_uri(secret, user.username, issuer),
        "message": "أضف السرّ في تطبيق المصادقة ثم أدخل الرمز لتفعيله",
    }


class TwoFactorCode(BaseModel):
    code: str = Field(min_length=6, max_length=8)


@router.post("/2fa/enable")
def two_factor_enable(
    payload: TwoFactorCode, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    if not user.totp_secret:
        raise HTTPException(status_code=400, detail="ابدأ بإعداد التحقق بخطوتين أولاً")
    if not totp.verify(user.totp_secret, payload.code):
        raise HTTPException(status_code=400, detail="الرمز غير صحيح — تأكد من ساعة جهازك")
    user.totp_enabled = True
    audit.log(db, user, "settings", "user", user.id, "تفعيل التحقق بخطوتين", commit=False)
    db.commit()
    return {"ok": True, "message": "فُعِّل التحقق بخطوتين — ستُطلب منك الرموز عند كل دخول"}


class TwoFactorDisable(BaseModel):
    password: str
    code: str | None = None


@router.post("/2fa/disable")
def two_factor_disable(
    payload: TwoFactorDisable, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """التعطيل يتطلب كلمة المرور — لا يكفي أن يكون الجهاز مفتوحاً."""
    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=400, detail="كلمة المرور غير صحيحة")
    user.totp_enabled = False
    user.totp_secret = None
    audit.log(db, user, "settings", "user", user.id, "تعطيل التحقق بخطوتين", commit=False)
    db.commit()
    return {"ok": True, "message": "أُوقف التحقق بخطوتين"}


@router.post("/logout-all")
def logout_all_devices(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """إبطال كل الجلسات على كل الأجهزة فوراً — بما فيها الجهاز الحالي."""
    revoke_sessions(user)
    audit.log(db, user, "password", "user", user.id, "خروج من كل الأجهزة", commit=False)
    db.commit()
    return {"ok": True, "message": "أُنهيت كل الجلسات — سجّل الدخول من جديد"}


@router.get("/login-history")
def login_history(
    limit: int = 20, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """آخر محاولات الدخول على حساب المستخدم نفسه."""
    rows = db.scalars(
        select(LoginEvent)
        .where(LoginEvent.user_id == user.id)
        .order_by(LoginEvent.created_at.desc(), LoginEvent.id.desc())
        .limit(max(1, min(limit, 100)))
    ).all()
    return [
        {
            "at": row.created_at,
            "ip": row.ip,
            "device": row.user_agent,
            "success": row.success,
            "reason": row.reason,
        }
        for row in rows
    ]


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
    problem = password_problem(
        payload.new_password, user.username,
        user.employee.phone if user.employee else "",
    )
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    user.password_hash = hash_password(payload.new_password)
    user.must_change_password = False
    user.password_changed_at = datetime.now()
    # كل جلسة قديمة تُبطل فوراً: من سرق التوكن لا يستفيد منه بعد التغيير
    revoke_sessions(user)
    audit.log(db, user, "password", "user", user.id, "تغيير كلمة المرور الذاتية", commit=False)
    db.commit()
    return {
        "ok": True,
        "message": "تم تغيير كلمة المرور وأُنهيت الجلسات الأخرى",
        "access_token": create_access_token(user),
    }
