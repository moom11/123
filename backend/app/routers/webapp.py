"""ملفات التطبيق الديناميكية: أيقونة الشاشة الرئيسية وملف manifest.

تُسجَّل هذه المسارات قبل تركيب مجلد الواجهة على /app لتأخذ الأولوية على
الملفات الثابتة، فتعكس شعار المنشأة واسمها فور تحديثهما.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..services import appicon, settings_store

router = APIRouter(tags=["webapp"], include_in_schema=False)

DEFAULT_NAME = "نظام الموارد البشرية - الحضور والإجازات"
DEFAULT_SHORT = "الموارد البشرية"


@router.get("/app/icons/{name}")
def app_icon(name: str):
    path = appicon.icon_path(name)
    if path is None:
        raise HTTPException(status_code=404, detail="أيقونة غير معروفة")
    # الرابط يحمل بصمة الإصدار (?v=) لذا يمكن تخزينه طويلاً
    return FileResponse(
        path, media_type="image/png", headers={"Cache-Control": "public, max-age=604800"}
    )


@router.get("/app/manifest.json")
def manifest(db: Session = Depends(get_db)):
    values = settings_store.get_all(db)
    company = (values.get("company_name") or "").strip()
    stamp = values.get("app_icon_version") or "0"

    def icon(name: str, size: int, purpose: str) -> dict:
        return {
            "src": f"/app/icons/{name}?v={stamp}",
            "sizes": f"{size}x{size}",
            "type": "image/png",
            "purpose": purpose,
        }

    body = {
        "name": company or DEFAULT_NAME,
        "short_name": company or DEFAULT_SHORT,
        "description": "تسجيل الحضور والانصراف من الجوال، طلبات الإجازات، المخالفات، وقسائم الرواتب",
        "lang": "ar",
        "dir": "rtl",
        "start_url": "/app/index.html",
        "scope": "/app/",
        "display": "standalone",
        "orientation": "portrait-primary",
        "background_color": values.get("app_icon_bg") or "#000000",
        "theme_color": "#2563eb",
        "icons": [
            icon("icon-192.png", 192, "any"),
            icon("icon-512.png", 512, "any"),
            icon("icon-maskable-512.png", 512, "maskable"),
        ],
        "shortcuts": [
            {"name": "تسجيل حضور", "url": "/app/index.html#dashboard"},
            {"name": "طلباتي", "url": "/app/index.html#myLeaves"},
        ],
    }
    return JSONResponse(body, headers={"Cache-Control": "no-cache"})
