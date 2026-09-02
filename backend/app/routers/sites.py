"""مواقع العمل المعتمدة للحضور الذاتي، وإعدادات البصم من التطبيق."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Employee, User, WorkSite
from ..schemas import (
    GeoCheckIn,
    GeoCheckOut,
    SettingsIn,
    SettingsOut,
    WorkSiteIn,
    WorkSiteOut,
    WorkSiteUpdate,
)
from ..security import get_current_user, require_hr
from ..services import geo, settings_store

router = APIRouter(prefix="/api", tags=["sites"])


def site_out(site: WorkSite, count: int = 0) -> WorkSiteOut:
    return WorkSiteOut(
        id=site.id,
        name=site.name,
        latitude=site.latitude,
        longitude=site.longitude,
        radius_meters=site.radius_meters,
        address=site.address,
        is_active=site.is_active,
        employees_count=count,
    )


@router.get("/sites", response_model=list[WorkSiteOut])
def list_sites(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    counts = dict(
        db.execute(select(Employee.site_id, func.count(Employee.id)).group_by(Employee.site_id)).all()
    )
    return [
        site_out(s, counts.get(s.id, 0))
        for s in db.scalars(select(WorkSite).order_by(WorkSite.name)).all()
    ]


@router.post("/sites", response_model=WorkSiteOut, status_code=201, dependencies=[Depends(require_hr)])
def create_site(payload: WorkSiteIn, db: Session = Depends(get_db)):
    if db.scalar(select(WorkSite).where(WorkSite.name == payload.name)):
        raise HTTPException(status_code=400, detail="اسم الموقع مستخدم مسبقاً")
    site = WorkSite(**payload.model_dump())
    db.add(site)
    db.commit()
    db.refresh(site)
    return site_out(site)


@router.patch("/sites/{site_id}", response_model=WorkSiteOut, dependencies=[Depends(require_hr)])
def update_site(site_id: int, payload: WorkSiteUpdate, db: Session = Depends(get_db)):
    site = db.get(WorkSite, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="الموقع غير موجود")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(site, key, value)
    db.commit()
    db.refresh(site)
    return site_out(site)


@router.delete("/sites/{site_id}", dependencies=[Depends(require_hr)])
def delete_site(site_id: int, db: Session = Depends(get_db)):
    site = db.get(WorkSite, site_id)
    if not site:
        raise HTTPException(status_code=404, detail="الموقع غير موجود")
    db.delete(site)
    db.commit()
    return {"ok": True}


@router.post("/sites/check", response_model=GeoCheckOut)
def check_location(
    payload: GeoCheckIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """يخبر الموظف إن كان داخل نطاق موقع عمل معتمد قبل تسجيل البصمة."""
    if not user.employee_id:
        raise HTTPException(status_code=400, detail="الحساب غير مرتبط بملف موظف")
    employee = db.get(Employee, user.employee_id)
    site, dist = geo.nearest_site(db, employee, payload.latitude, payload.longitude)
    if site is None:
        return GeoCheckOut(allowed=False, message="لا يوجد موقع عمل معتمد لك، راجع الموارد البشرية")
    allowed = dist is not None and dist <= site.radius_meters
    return GeoCheckOut(
        allowed=allowed,
        site_name=site.name,
        distance_meters=dist,
        radius_meters=site.radius_meters,
        message=(
            f"أنت داخل نطاق «{site.name}» (على بُعد {int(dist)} م)"
            if allowed
            else f"أنت خارج النطاق: أقرب موقع «{site.name}» على بُعد {int(dist or 0)} م"
        ),
    )


@router.get("/settings", response_model=SettingsOut)
def get_settings(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    values = settings_store.get_all(db)
    return SettingsOut(
        web_punch_enabled=values["web_punch_enabled"] == "true",
        web_punch_requires_location=values["web_punch_requires_location"] == "true",
        geo_max_accuracy_meters=int(float(values["geo_max_accuracy_meters"])),
    )


@router.put("/settings", response_model=SettingsOut, dependencies=[Depends(require_hr)])
def update_settings(payload: SettingsIn, db: Session = Depends(get_db)):
    values = settings_store.set_many(db, payload.model_dump(exclude_unset=True))
    return SettingsOut(
        web_punch_enabled=values["web_punch_enabled"] == "true",
        web_punch_requires_location=values["web_punch_requires_location"] == "true",
        geo_max_accuracy_meters=int(float(values["geo_max_accuracy_meters"])),
    )
