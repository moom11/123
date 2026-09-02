"""إدارة أجهزة البصمة ZKTeco: الاتصال، المزامنة، ومستخدمو الجهاز."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Device, DeviceCommand, DeviceMode, Employee, EmployeeStatus, User
from ..schemas import (
    DeviceIn,
    DeviceOut,
    DeviceTestResult,
    DeviceUpdate,
    DeviceUserOut,
    SyncResult,
)
from ..security import require_hr
from ..services import zk_service
from ..zk import driver
from ..zk.driver import DeviceError

router = APIRouter(prefix="/api/devices", tags=["devices"], dependencies=[Depends(require_hr)])


@router.get("", response_model=list[DeviceOut])
def list_devices(db: Session = Depends(get_db)):
    return db.scalars(select(Device).order_by(Device.id)).all()


@router.post("", response_model=DeviceOut, status_code=201)
def create_device(payload: DeviceIn, db: Session = Depends(get_db)):
    if payload.mode == DeviceMode.pull and not payload.ip:
        raise HTTPException(status_code=400, detail="أجهزة وضع السحب تتطلب عنوان IP")
    if payload.mode == DeviceMode.push and not payload.serial_number:
        raise HTTPException(status_code=400, detail="أجهزة وضع الدفع تتطلب الرقم التسلسلي (SN)")
    device = Device(**payload.model_dump())
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


@router.patch("/{device_id}", response_model=DeviceOut)
def update_device(device_id: int, payload: DeviceUpdate, db: Session = Depends(get_db)):
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="الجهاز غير موجود")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(device, key, value)
    db.commit()
    db.refresh(device)
    return device


@router.delete("/{device_id}")
def delete_device(device_id: int, db: Session = Depends(get_db)):
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="الجهاز غير موجود")
    db.delete(device)
    db.commit()
    return {"ok": True}


@router.post("/{device_id}/test", response_model=DeviceTestResult)
def test_device(device_id: int, db: Session = Depends(get_db)):
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="الجهاز غير موجود")
    if device.mode == DeviceMode.demo:
        device.last_status = "جهاز تجريبي جاهز"
        db.commit()
        return DeviceTestResult(ok=True, message="جهاز تجريبي (بدون عتاد فعلي)", info={"mode": "demo"})
    if device.mode == DeviceMode.push:
        last = device.last_sync_at.strftime("%Y-%m-%d %H:%M") if device.last_sync_at else "لم يتصل بعد"
        return DeviceTestResult(
            ok=bool(device.last_sync_at),
            message=f"جهاز يعمل بوضع الدفع (ADMS). آخر اتصال: {last}",
            info={"serial_number": device.serial_number or ""},
        )
    try:
        info = driver.test_connection(device)
    except DeviceError as exc:
        device.last_status = f"فشل الاتصال: {exc}"
        db.commit()
        return DeviceTestResult(ok=False, message=str(exc))
    if info.get("serial_number") and not device.serial_number:
        device.serial_number = str(info["serial_number"])
    device.last_status = "الاتصال ناجح"
    db.commit()
    return DeviceTestResult(
        ok=True, message="تم الاتصال بالجهاز بنجاح", info={k: str(v) for k, v in info.items() if v is not None}
    )


@router.post("/{device_id}/sync", response_model=SyncResult)
def sync_device(device_id: int, db: Session = Depends(get_db)):
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="الجهاز غير موجود")
    return SyncResult(**zk_service.sync_device(db, device))


@router.post("/sync-all", response_model=list[SyncResult])
def sync_all(db: Session = Depends(get_db)):
    return [SyncResult(**r) for r in zk_service.sync_all(db)]


@router.get("/{device_id}/users", response_model=list[DeviceUserOut])
def device_users(device_id: int, db: Session = Depends(get_db)):
    """قراءة الموظفين المسجلين على الجهاز ومطابقتهم مع النظام."""
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="الجهاز غير موجود")
    if device.mode != DeviceMode.pull:
        raise HTTPException(status_code=400, detail="قراءة المستخدمين متاحة لأجهزة وضع السحب فقط")
    try:
        users = driver.fetch_users(device)
    except DeviceError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    codes = {e.code for e in db.scalars(select(Employee)).all()}
    return [
        DeviceUserOut(
            user_id=u.user_id,
            name=u.name,
            privilege=u.privilege,
            card=u.card,
            exists_in_system=u.user_id in codes,
        )
        for u in users
    ]


@router.post("/{device_id}/import-users")
def import_device_users(device_id: int, db: Session = Depends(get_db)):
    """ينشئ ملفات موظفين للمستخدمين الموجودين على الجهاز وغير المسجلين في النظام."""
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="الجهاز غير موجود")
    try:
        users = driver.fetch_users(device)
    except DeviceError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    existing = {e.code for e in db.scalars(select(Employee)).all()}
    created = []
    for u in users:
        if not u.user_id or u.user_id in existing:
            continue
        emp = Employee(code=u.user_id, full_name=u.name or f"موظف {u.user_id}")
        db.add(emp)
        created.append(u.user_id)
    db.commit()
    return {"ok": True, "created": len(created), "codes": created}


@router.post("/{device_id}/push-employee/{employee_id}")
def push_employee(device_id: int, employee_id: int, db: Session = Depends(get_db)):
    """يرسل بيانات موظف إلى الجهاز (تسجيل البصمة يتم على الجهاز نفسه)."""
    device = db.get(Device, device_id)
    emp = db.get(Employee, employee_id)
    if not device or not emp:
        raise HTTPException(status_code=404, detail="الجهاز أو الموظف غير موجود")
    if device.mode == DeviceMode.push:
        db.add(
            DeviceCommand(
                device_id=device.id,
                command=f"DATA UPDATE USERINFO PIN={emp.code}\tName={emp.full_name}\tPri=0",
            )
        )
        db.commit()
        return {"ok": True, "message": "تمت جدولة الأمر، سيُنفَّذ عند اتصال الجهاز"}
    try:
        driver.push_user(device, emp.code, emp.full_name)
    except DeviceError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True, "message": f"تم إرسال الموظف {emp.full_name} إلى الجهاز"}


@router.post("/{device_id}/sync-time")
def sync_device_time(device_id: int, db: Session = Depends(get_db)):
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="الجهاز غير موجود")
    if device.mode != DeviceMode.pull:
        raise HTTPException(status_code=400, detail="ضبط الوقت متاح لأجهزة وضع السحب فقط")
    try:
        now = driver.sync_time(device)
    except DeviceError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True, "message": f"تم ضبط ساعة الجهاز على {now:%Y-%m-%d %H:%M:%S}"}


@router.post("/{device_id}/clear-logs")
def clear_logs(device_id: int, db: Session = Depends(get_db)):
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(status_code=404, detail="الجهاز غير موجود")
    if device.mode != DeviceMode.pull:
        raise HTTPException(status_code=400, detail="مسح السجلات متاح لأجهزة وضع السحب فقط")
    try:
        driver.clear_attendance(device)
    except DeviceError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True, "message": "تم مسح سجلات الجهاز بعد استيرادها"}
