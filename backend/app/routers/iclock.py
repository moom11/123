"""بروتوكول الدفع ADMS/iclock لأجهزة ZKTeco.

يُضبط على الجهاز: Comm > Ethernet > Cloud Server / ADMS
    Server Address = عنوان هذا الخادم، Server Port = منفذ التطبيق (8000 افتراضياً)
ثم يبدأ الجهاز بإرسال البصمات فور حدوثها إلى /iclock/cdata.
لا يحتاج هذا المسار توكن لأن الأجهزة لا تدعمه؛ الحماية بالرقم التسلسلي (SN)
وبقصر الوصول على الشبكة الداخلية.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Device, DeviceCommand, DeviceMode, PunchSource
from ..services import zk_service
from ..zk.driver import AttendanceRecord

router = APIRouter(prefix="/iclock", tags=["iclock"], include_in_schema=True)


def _plain(text: str) -> Response:
    return Response(content=text, media_type="text/plain; charset=utf-8")


def _get_or_register_device(db: Session, sn: str) -> Device:
    device = db.scalar(select(Device).where(Device.serial_number == sn))
    if device is None:
        device = Device(
            name=f"جهاز {sn}",
            mode=DeviceMode.push,
            serial_number=sn,
            is_active=True,
            last_status="تم التعرف على الجهاز تلقائياً عند أول اتصال",
        )
        db.add(device)
        db.commit()
        db.refresh(device)
    return device


@router.get("/cdata")
def handshake(request: Request, SN: str = "", db: Session = Depends(get_db)):
    """مصافحة أولية: الجهاز يطلب إعداداته من الخادم."""
    if not SN:
        return _plain("OK")
    device = _get_or_register_device(db, SN)
    device.last_sync_at = datetime.now()
    device.last_status = "متصل (وضع الدفع)"
    db.commit()
    body = (
        f"GET OPTION FROM: {SN}\r\n"
        "ATTLOGStamp=None\r\n"
        "OPERLOGStamp=9999\r\n"
        "ATTPHOTOStamp=None\r\n"
        "ErrorDelay=30\r\n"
        "Delay=10\r\n"
        "TransTimes=00:00;14:00\r\n"
        "TransInterval=1\r\n"
        "TransFlag=1111000000\r\n"
        "TimeZone=3\r\n"
        "Realtime=1\r\n"
        "Encrypt=0\r\n"
    )
    return _plain(body)


@router.post("/cdata")
async def receive_data(request: Request, SN: str = "", table: str = "", db: Session = Depends(get_db)):
    """استقبال سجلات البصمة (ATTLOG) وسجلات العمليات (OPERLOG) من الجهاز."""
    raw = (await request.body()).decode("utf-8", errors="ignore")
    if not SN:
        return _plain("OK")
    device = _get_or_register_device(db, SN)
    device.last_sync_at = datetime.now()

    if table.upper() != "ATTLOG":
        device.last_status = f"استقبال جدول {table or 'غير محدد'}"
        db.commit()
        return _plain("OK")

    records: list[AttendanceRecord] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            parts = line.split()
        if len(parts) < 2:
            continue
        pin = parts[0].strip()
        stamp = parts[1].strip()
        timestamp = None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M:%S"):
            try:
                timestamp = datetime.strptime(stamp, fmt)
                break
            except ValueError:
                continue
        if timestamp is None and len(parts) >= 3:
            try:
                timestamp = datetime.strptime(f"{parts[1]} {parts[2]}", "%Y-%m-%d %H:%M:%S")
            except ValueError:
                timestamp = None
        if timestamp is None:
            continue
        records.append(
            AttendanceRecord(
                user_id=pin,
                timestamp=timestamp,
                status=parts[2].strip() if len(parts) > 2 else None,
                verify_mode=parts[3].strip() if len(parts) > 3 else None,
            )
        )

    result = zk_service.import_records(db, device, records, PunchSource.device_push)
    device.last_status = f"استُقبل {result['imported']} سجل جديد من أصل {len(records)}"
    db.commit()
    return _plain(f"OK: {result['imported']}")


@router.get("/getrequest")
def get_request(SN: str = "", db: Session = Depends(get_db)):
    """الجهاز يسأل عن أوامر معلّقة (إضافة مستخدم، إعادة تشغيل...)."""
    if not SN:
        return _plain("OK")
    device = _get_or_register_device(db, SN)
    device.last_sync_at = datetime.now()
    command = db.scalar(
        select(DeviceCommand)
        .where(DeviceCommand.device_id == device.id, DeviceCommand.sent_at.is_(None))
        .order_by(DeviceCommand.id)
    )
    if command is None:
        db.commit()
        return _plain("OK")
    command.sent_at = datetime.now()
    db.commit()
    return _plain(f"C:{command.id}:{command.command}")


@router.post("/devicecmd")
async def device_cmd_result(request: Request, SN: str = "", db: Session = Depends(get_db)):
    """نتيجة تنفيذ الأمر كما يعيدها الجهاز."""
    raw = (await request.body()).decode("utf-8", errors="ignore")
    for chunk in raw.replace("\r", "\n").split("\n"):
        fields = dict(
            part.split("=", 1) for part in chunk.split("&") if "=" in part
        )
        cmd_id = fields.get("ID")
        if not cmd_id or not cmd_id.isdigit():
            continue
        command = db.get(DeviceCommand, int(cmd_id))
        if command:
            command.result = fields.get("Return", "")[:255]
    db.commit()
    return _plain("OK")


@router.get("/ping")
def ping():
    return _plain("OK")


@router.get("/fdata")
@router.post("/fdata")
def fdata():  # بصمات/صور يرسلها بعض الأجهزة - نستقبلها دون تخزين
    return _plain("OK")
