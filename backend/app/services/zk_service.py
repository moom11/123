"""تنسيق المزامنة مع أجهزة البصمة: استيراد البصمات، منع التكرار، وإعادة الاحتساب."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Device, DeviceMode, Employee, EmployeeStatus, Punch, PunchSource, PunchType
from ..zk import driver
from ..zk.driver import AttendanceRecord, DeviceError
from . import attendance as attendance_service


def _employee_map(db: Session) -> dict[str, Employee]:
    return {e.code.strip(): e for e in db.scalars(select(Employee)).all()}


def import_records(
    db: Session,
    device: Device | None,
    records: list[AttendanceRecord],
    source: PunchSource,
) -> dict:
    """يحفظ سجلات البصمة مع تجاهل المكرر، ثم يعيد احتساب الأيام المتأثرة."""
    employees = _employee_map(db)
    device_id = device.id if device else None
    imported: list[Punch] = []
    duplicates = 0
    unknown: set[str] = set()

    # المفاتيح الموجودة مسبقاً لهذا الجهاز لتفادي الإدراج المكرر
    existing = {
        (code, ts)
        for code, ts in db.execute(
            select(Punch.employee_code, Punch.punch_time).where(Punch.device_id == device_id)
        ).all()
    }
    seen: set[tuple[str, datetime]] = set()

    for rec in records:
        code = str(rec.user_id).strip()
        if not code:
            continue
        key = (code, rec.timestamp)
        if key in existing or key in seen:
            duplicates += 1
            continue
        seen.add(key)
        employee = employees.get(code)
        if employee is None:
            unknown.add(code)
        punch = Punch(
            employee_code=code,
            employee_id=employee.id if employee else None,
            punch_time=rec.timestamp,
            punch_type=PunchType.auto,
            source=source,
            device_id=device_id,
            verify_mode=rec.verify_mode,
            status_code=rec.status,
        )
        db.add(punch)
        imported.append(punch)

    db.flush()
    recomputed = attendance_service.recompute_for_punches(db, imported)
    db.commit()
    return {
        "fetched": len(records),
        "imported": len(imported),
        "duplicates": duplicates,
        "unknown_codes": sorted(unknown),
        "recomputed_days": recomputed,
    }


def sync_device(db: Session, device: Device, demo_days: int = 14) -> dict:
    """يزامن جهازاً واحداً: يسحب السجلات (أو يولّدها في الوضع التجريبي) ويستوردها."""
    try:
        if device.mode == DeviceMode.demo:
            codes = [
                e.code
                for e in db.scalars(
                    select(Employee).where(Employee.status == EmployeeStatus.active)
                ).all()
            ]
            records = driver.demo_attendance(codes, days=demo_days)
            source = PunchSource.device_pull
        elif device.mode == DeviceMode.push:
            device.last_status = "وضع الدفع: الجهاز يرسل السجلات تلقائياً إلى /iclock"
            db.commit()
            return {
                "ok": True,
                "device_id": device.id,
                "device_name": device.name,
                "fetched": 0,
                "imported": 0,
                "duplicates": 0,
                "unknown_codes": [],
                "recomputed_days": 0,
                "message": device.last_status,
            }
        else:
            records = driver.fetch_attendance(device)
            source = PunchSource.device_pull
    except DeviceError as exc:
        device.last_status = f"فشل: {exc}"
        db.commit()
        return {
            "ok": False,
            "device_id": device.id,
            "device_name": device.name,
            "fetched": 0,
            "imported": 0,
            "duplicates": 0,
            "unknown_codes": [],
            "recomputed_days": 0,
            "message": str(exc),
        }

    result = import_records(db, device, records, source)
    if device.clear_after_sync and device.mode == DeviceMode.pull and result["imported"]:
        try:
            driver.clear_attendance(device)
        except DeviceError:
            pass
    device.last_sync_at = datetime.now()
    device.last_status = (
        f"تمت المزامنة: {result['imported']} سجل جديد من أصل {result['fetched']}"
    )
    db.commit()
    return {
        "ok": True,
        "device_id": device.id,
        "device_name": device.name,
        "message": device.last_status,
        **result,
    }


def sync_all(db: Session) -> list[dict]:
    devices = db.scalars(select(Device).where(Device.is_active.is_(True))).all()
    return [sync_device(db, d) for d in devices]
