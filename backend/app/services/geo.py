"""التحقق الجغرافي من الحضور الذاتي (Geofencing) لمواقع العمل."""
from __future__ import annotations

from math import asin, cos, radians, sin, sqrt

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Employee, WorkSite
from . import settings_store

EARTH_RADIUS_M = 6371000.0


def distance_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """المسافة بين نقطتين على سطح الأرض بالأمتار (صيغة هافرساين)."""
    p1, p2 = radians(lat1), radians(lat2)
    d_phi = p2 - p1
    d_lambda = radians(lon2 - lon1)
    a = sin(d_phi / 2) ** 2 + cos(p1) * cos(p2) * sin(d_lambda / 2) ** 2
    return round(2 * EARTH_RADIUS_M * asin(sqrt(a)), 1)


def allowed_sites(db: Session, employee: Employee) -> list[WorkSite]:
    """مواقع العمل المسموح للموظف البصم منها: موقعه المخصص، أو كل المواقع المفعّلة."""
    if employee.site_id:
        site = db.get(WorkSite, employee.site_id)
        return [site] if site and site.is_active else []
    return list(db.scalars(select(WorkSite).where(WorkSite.is_active.is_(True))).all())


def nearest_site(
    db: Session, employee: Employee, latitude: float, longitude: float
) -> tuple[WorkSite | None, float | None]:
    """أقرب موقع عمل مسموح مع المسافة إليه."""
    best: tuple[WorkSite | None, float | None] = (None, None)
    for site in allowed_sites(db, employee):
        dist = distance_meters(latitude, longitude, site.latitude, site.longitude)
        if best[1] is None or dist < best[1]:
            best = (site, dist)
    return best


def verify_location(
    db: Session,
    employee: Employee,
    latitude: float | None,
    longitude: float | None,
    accuracy: float | None,
) -> tuple[WorkSite | None, float | None]:
    """يتحقق من أن الموظف داخل نطاق موقع عمل معتمد، ويعيد (الموقع، المسافة).

    يرفع HTTPException برسالة عربية واضحة عند أي مخالفة.
    """
    if not settings_store.get_bool(db, "web_punch_requires_location"):
        if latitude is None or longitude is None:
            return None, None
        return nearest_site(db, employee, latitude, longitude)

    if latitude is None or longitude is None:
        raise HTTPException(
            status_code=400,
            detail="يجب السماح بالوصول إلى الموقع الجغرافي لتسجيل الحضور من التطبيق",
        )
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise HTTPException(status_code=400, detail="إحداثيات الموقع غير صحيحة")

    max_accuracy = settings_store.get_int(db, "geo_max_accuracy_meters", 150)
    if accuracy is not None and accuracy > max_accuracy:
        raise HTTPException(
            status_code=400,
            detail=(
                f"دقة تحديد الموقع ضعيفة ({int(accuracy)} م). "
                f"الحد المسموح {max_accuracy} م - فعّل GPS وحاول في مكان مكشوف."
            ),
        )

    sites = allowed_sites(db, employee)
    if not sites:
        raise HTTPException(
            status_code=400,
            detail=(
                "لا يوجد موقع عمل معتمد لك. راجع الموارد البشرية لإضافة الموقع "
                "من: الإعدادات ← مواقع العمل"
            ),
        )

    site, dist = nearest_site(db, employee, latitude, longitude)
    if site is None or dist is None or dist > site.radius_meters:
        where = f" أقرب موقع: {site.name} على بُعد {int(dist)} م" if site and dist is not None else ""
        raise HTTPException(
            status_code=403,
            detail=f"أنت خارج نطاق موقع العمل، لا يمكن تسجيل الحضور.{where}",
        )
    return site, dist
