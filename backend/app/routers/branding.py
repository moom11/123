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
from ..services import appicon, audit, quotes, settings_store

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


class BrandingIn(BaseModel):
    company_name: str | None = Field(default=None, max_length=120)
    daily_quote_enabled: bool | None = None
    daily_quote_hour: int | None = Field(default=None, ge=0, le=23)
    app_icon_bg: str | None = Field(default=None, pattern=r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


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
