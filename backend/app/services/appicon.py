"""أيقونة التطبيق على شاشة الجوال (Home Screen).

يبني ملفات PNG بالمقاسات التي يطلبها iOS و Android انطلاقاً من شعار
المنشأة المرفوع في «الإعدادات ← هوية المنشأة»، ويضعه على خلفية موحّدة
(أسود افتراضياً ليناسب الشعارات الذهبية). إن لم يوجد شعار مرفوع — أو لم
تتوفر مكتبة Pillow — نعود إلى الأيقونة المدمجة في frontend/assets.
"""
from __future__ import annotations

import secrets
from pathlib import Path

from sqlalchemy.orm import Session

from ..config import DATA_DIR, FRONTEND_DIR, UPLOAD_DIR
from . import settings_store

ICON_DIR = DATA_DIR / "appicons"
BUNDLED_DIR = FRONTEND_DIR / "assets"
DEFAULT_BG = "#000000"

# اسم الملف -> (المقاس، نسبة المساحة التي يشغلها الشعار)
SPECS: dict[str, tuple[int, float]] = {
    "icon-192.png": (192, 0.78),
    "icon-512.png": (512, 0.78),
    "apple-touch-icon.png": (180, 0.80),
    # الأقنعة على أندرويد تقصّ الأطراف، فنترك هامش أمان أوسع
    "icon-maskable-512.png": (512, 0.60),
}

# ما يُستخدم من الأيقونات المدمجة عند تعذّر التوليد
FALLBACK = {
    "icon-192.png": "icon-192.png",
    "icon-512.png": "icon-512.png",
    "apple-touch-icon.png": "apple-touch-icon.png",
    "icon-maskable-512.png": "icon-maskable-512.png",
}


def _parse_color(value: str) -> tuple[int, int, int]:
    text = (value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        return (0, 0, 0)
    try:
        return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
    except ValueError:
        return (0, 0, 0)


def _clear() -> None:
    if ICON_DIR.exists():
        for path in ICON_DIR.glob("*.png"):
            path.unlink(missing_ok=True)


def version(db: Session) -> str:
    """بصمة تتغيّر مع كل شعار جديد لكسر ذاكرة المتصفح والجوال."""
    return settings_store.get(db, "app_icon_version") or "0"


def rebuild(db: Session) -> bool:
    """يعيد بناء الأيقونات من الشعار الحالي. يعيد True إن نجح التوليد."""
    logo_name = settings_store.get(db, "logo_path") or ""
    ok = _render(logo_name, settings_store.get(db, "app_icon_bg") or DEFAULT_BG)
    settings_store.set_many(db, {"app_icon_version": secrets.token_hex(4)})
    return ok


def _render(logo_name: str, bg: str) -> bool:
    if not logo_name or logo_name.lower().endswith(".svg"):
        _clear()
        return False
    source = UPLOAD_DIR / logo_name
    if not source.exists():
        _clear()
        return False
    try:
        from PIL import Image
    except Exception:  # pragma: no cover - Pillow غير مثبّتة
        _clear()
        return False

    try:
        with Image.open(source) as raw:
            logo = raw.convert("RGBA")
            logo = _trim(logo)
            ICON_DIR.mkdir(parents=True, exist_ok=True)
            color = _parse_color(bg)
            for name, (size, inset) in SPECS.items():
                _compose(Image, logo, size, inset, color).save(ICON_DIR / name, "PNG")
    except Exception:  # pragma: no cover - ملف صورة تالف
        _clear()
        return False
    return True


def _trim(logo):
    """يقص الهوامش الشفافة حتى يملأ الشعار الأيقونة فعلياً."""
    box = logo.getbbox()
    return logo.crop(box) if box else logo


def _compose(Image, logo, size: int, inset: float, color: tuple[int, int, int]):
    canvas = Image.new("RGBA", (size, size), color + (255,))
    limit = max(1, int(size * inset))
    scaled = logo.copy()
    scaled.thumbnail((limit, limit), Image.LANCZOS)
    canvas.alpha_composite(
        scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2)
    )
    return canvas.convert("RGB")


def icon_path(name: str) -> Path | None:
    """مسار الأيقونة المطلوبة: المولّدة إن وُجدت، وإلا المدمجة."""
    if name not in SPECS:
        return None
    generated = ICON_DIR / name
    if generated.exists():
        return generated
    bundled = BUNDLED_DIR / FALLBACK[name]
    return bundled if bundled.exists() else None
