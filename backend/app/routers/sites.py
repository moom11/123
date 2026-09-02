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
from ..services import audit, geo, settings_store

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


@router.post("/sites", response_model=WorkSiteOut, status_code=201)
def create_site(
    payload: WorkSiteIn, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    if db.scalar(select(WorkSite).where(WorkSite.name == payload.name)):
        raise HTTPException(status_code=400, detail="اسم الموقع مستخدم مسبقاً")
    site = WorkSite(**payload.model_dump())
    db.add(site)
    db.flush()
    audit.log(db, user, "create", "site", site.id, f"{site.name} ({site.radius_meters} م)", commit=False)
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


def _settings_out(values: dict) -> SettingsOut:
    return SettingsOut(
        web_punch_enabled=values["web_punch_enabled"] == "true",
        web_punch_requires_location=values["web_punch_requires_location"] == "true",
        geo_max_accuracy_meters=int(float(values["geo_max_accuracy_meters"])),
        payroll_days_per_month=int(float(values["payroll_days_per_month"])),
        payroll_workday_hours=int(float(values["payroll_workday_hours"])),
        payroll_overtime_multiplier=float(values["payroll_overtime_multiplier"]),
        payroll_late_deduction_mode=values["payroll_late_deduction_mode"],
        payroll_absence_multiplier=float(values["payroll_absence_multiplier"]),
        violation_reset_days=int(float(values["violation_reset_days"])),
        document_alert_days=int(float(values["document_alert_days"])),
    )


@router.get("/settings", response_model=SettingsOut)
def get_settings(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return _settings_out(settings_store.get_all(db))


@router.put("/settings", response_model=SettingsOut)
def update_settings(
    payload: SettingsIn, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    changes = payload.model_dump(exclude_unset=True)
    values = settings_store.set_many(db, changes)
    audit.log(
        db, user, "settings", "settings", None,
        "، ".join(f"{k}={v}" for k, v in changes.items()),
    )
    return _settings_out(values)
