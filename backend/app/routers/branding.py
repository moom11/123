"""هوية المنشأة: الاسم والشعار، والعبارة التحفيزية اليومية."""
from __future__ import annotations

import secrets
from datetime import date

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import MAX_UPLOAD_BYTES, UPLOAD_DIR
from ..database import get_db
from ..models import User
from ..security import require_hr
from ..security_extra import content_problem
from ..services import appicon, audit, quotes, settings_store
from ..services import signature as signature_service

router = APIRouter(prefix="/api/branding", tags=["branding"])

LOGO_TYPES = {".png", ".jpg", ".jpeg", ".webp", ".svg"}


class BrandingOut(BaseModel):
    company_name: str = ""
    logo_url: str | None = None
    quote: str = ""
    daily_quote_enabled: bool = True
    daily_quote_hour: int = 7
    app_icon_bg: str = "#000000"
    app_icon_url: str = "/app/icons/icon-192.png"
    # توقيعا المنشأة على التقارير الموقّعة
    signature_hr_url: str | None = None
    signatory_hr_name: str = ""
    signatory_hr_title: str = ""
    signature_manager_url: str | None = None
    signatory_manager_name: str = ""
    signatory_manager_title: str = ""


class BrandingIn(BaseModel):
    company_name: str | None = Field(default=None, max_length=120)
    daily_quote_enabled: bool | None = None
    daily_quote_hour: int | None = Field(default=None, ge=0, le=23)
    app_icon_bg: str | None = Field(default=None, pattern=r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
    signatory_hr_name: str | None = Field(default=None, max_length=120)
    signatory_hr_title: str | None = Field(default=None, max_length=120)
    signatory_manager_name: str | None = Field(default=None, max_length=120)
    signatory_manager_title: str | None = Field(default=None, max_length=120)


def branding_of(db: Session) -> BrandingOut:
    values = settings_store.get_all(db)
    logo = values.get("logo_path") or ""
    return BrandingOut(
        company_name=values.get("company_name") or "",
        logo_url=f"/uploads/{logo}" if logo else None,
        quote=quotes.quote_for(),
        daily_quote_enabled=values.get("daily_quote_enabled") == "true",
        daily_quote_hour=int(float(values.get("daily_quote_hour") or 7)),
        app_icon_bg=values.get("app_icon_bg") or "#000000",
        app_icon_url=f"/app/icons/icon-192.png?v={values.get('app_icon_version') or '0'}",
        signature_hr_url=(f"/uploads/{values['signature_hr_path']}"
                          if values.get("signature_hr_path") else None),
        signatory_hr_name=values.get("signatory_hr_name") or "",
        signatory_hr_title=values.get("signatory_hr_title") or "الموارد البشرية",
        signature_manager_url=(f"/uploads/{values['signature_manager_path']}"
                               if values.get("signature_manager_path") else None),
        signatory_manager_name=values.get("signatory_manager_name") or "",
        signatory_manager_title=values.get("signatory_manager_title") or "المدير العام",
    )


@router.get("", response_model=BrandingOut)
def get_branding(db: Session = Depends(get_db)):
    """عام بلا مصادقة: تحتاجه شاشة الدخول لعرض الشعار والعبارة."""
    return branding_of(db)


@router.put("", response_model=BrandingOut)
def update_branding(
    payload: BrandingIn, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    changes = payload.model_dump(exclude_unset=True)
    settings_store.set_many(db, changes)
    if "app_icon_bg" in changes:
        appicon.rebuild(db)
    audit.log(db, user, "settings", "settings", None, "الهوية: " + "، ".join(changes.keys()))
    return branding_of(db)


@router.post("/logo", response_model=BrandingOut)
def upload_logo(
    file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    name = (file.filename or "").lower()
    suffix = "." + name.rsplit(".", 1)[-1] if "." in name else ""
    if suffix not in LOGO_TYPES:
        raise HTTPException(status_code=400, detail="نوع الملف غير مدعوم (PNG أو JPG أو WEBP أو SVG)")
    content = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="حجم الملف أكبر من الحد المسموح")
    if not content:
        raise HTTPException(status_code=400, detail="الملف فارغ")
    problem = content_problem(content, suffix)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    stored = f"logo_{secrets.token_hex(6)}{suffix}"
    (UPLOAD_DIR / stored).write_bytes(content)

    previous = settings_store.get(db, "logo_path")
    settings_store.set_many(db, {"logo_path": stored})
    if previous and previous != stored:
        (UPLOAD_DIR / previous).unlink(missing_ok=True)
    # الشعار نفسه يصبح أيقونة التطبيق على شاشة الجوال
    appicon.rebuild(db)
    audit.log(db, user, "update", "settings", None, "تحديث شعار المنشأة")
    return branding_of(db)


SIGNATURE_ROLES = {"hr": "توقيع الموارد البشرية", "manager": "توقيع المدير"}


@router.post("/signature/{role}", response_model=BrandingOut)
def upload_signature(
    role: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """توقيع المنشأة على التقارير: يُرفع صورة ويُحفظ PNG شفافاً بلا خلفية."""
    if role not in SIGNATURE_ROLES:
        raise HTTPException(status_code=404, detail="نوع التوقيع غير معروف")
    name = (file.filename or "").lower()
    suffix = "." + name.rsplit(".", 1)[-1] if "." in name else ""
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise HTTPException(status_code=400, detail="نوع الملف غير مدعوم (PNG أو JPG أو WEBP)")
    content = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="حجم الصورة أكبر من الحد المسموح")
    if not content:
        raise HTTPException(status_code=400, detail="الملف فارغ")
    problem = content_problem(content, suffix)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    try:
        stored = signature_service.store(content, UPLOAD_DIR, prefix=f"sign_{role}")
    except signature_service.SignatureError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    key = f"signature_{role}_path"
    previous = settings_store.get(db, key)
    settings_store.set_many(db, {key: stored})
    if previous and previous != stored:
        (UPLOAD_DIR / previous).unlink(missing_ok=True)
    audit.log(db, user, "update", "settings", None, f"تحديث {SIGNATURE_ROLES[role]}")
    return branding_of(db)


@router.delete("/signature/{role}", response_model=BrandingOut)
def delete_signature(role: str, db: Session = Depends(get_db), user: User = Depends(require_hr)):
    if role not in SIGNATURE_ROLES:
        raise HTTPException(status_code=404, detail="نوع التوقيع غير معروف")
    key = f"signature_{role}_path"
    previous = settings_store.get(db, key)
    if previous:
        (UPLOAD_DIR / previous).unlink(missing_ok=True)
    settings_store.set_many(db, {key: ""})
    audit.log(db, user, "delete", "settings", None, f"حذف {SIGNATURE_ROLES[role]}")
    return branding_of(db)


@router.delete("/logo", response_model=BrandingOut)
def delete_logo(db: Session = Depends(get_db), user: User = Depends(require_hr)):
    previous = settings_store.get(db, "logo_path")
    if previous:
        (UPLOAD_DIR / previous).unlink(missing_ok=True)
    settings_store.set_many(db, {"logo_path": ""})
    appicon.rebuild(db)
    audit.log(db, user, "delete", "settings", None, "حذف شعار المنشأة")
    return branding_of(db)


@router.post("/send-quote")
def send_quote_now(db: Session = Depends(get_db), user: User = Depends(require_hr)):
    """إرسال عبارة اليوم فوراً لكل المستخدمين (للتجربة أو التذكير)."""
    from ..services.daily import send_daily_quote

    count = send_daily_quote(db, force=True)
    audit.log(db, user, "create", "settings", None, f"إرسال العبارة اليومية لـ {count} مستخدم")
    return {"ok": True, "sent": count, "quote": quotes.quote_for(), "date": date.today().isoformat()}
