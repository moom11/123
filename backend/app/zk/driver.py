"""طبقة الاتصال بأجهزة البصمة ZKTeco.

الوضع الحقيقي يستخدم مكتبة pyzk وبروتوكول ZKTeco على المنفذ 4370 (TCP/UDP)،
ويعمل مع أجهزة مثل: iClock, K40, F18, MB360, uFace, SpeedFace وغيرها.
وضع "demo" يولّد بصمات تجريبية لتشغيل النظام واختباره بدون عتاد.
"""
from __future__ import annotations

import random
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

try:  # pragma: no cover - يعتمد على توفر المكتبة
    from zk import ZK
    from zk.exception import ZKErrorResponse, ZKNetworkError

    PYZK_AVAILABLE = True
except Exception:  # pragma: no cover
    ZK = None  # type: ignore[assignment]
    ZKErrorResponse = ZKNetworkError = Exception  # type: ignore[misc,assignment]
    PYZK_AVAILABLE = False


class DeviceError(RuntimeError):
    """خطأ في الاتصال بالجهاز أو في تنفيذ أمر عليه."""


@dataclass
class AttendanceRecord:
    user_id: str
    timestamp: datetime
    status: str | None = None      # حالة السجل في الجهاز (دخول/خروج/استراحة...)
    verify_mode: str | None = None  # 1=بصمة، 3=كلمة مرور، 4=بطاقة، 15=وجه
    uid: str | None = None


@dataclass
class DeviceUser:
    user_id: str
    name: str
    privilege: int = 0
    card: str | None = None
    uid: int | None = None


@contextmanager
def connect(device):
    """يفتح اتصالاً بالجهاز ويغلقه دائماً، مع تعطيل الجهاز أثناء العملية."""
    if not PYZK_AVAILABLE:  # pragma: no cover
        raise DeviceError("مكتبة pyzk غير مثبتة. نفّذ: pip install pyzk")
    if not device.ip:
        raise DeviceError("عنوان IP للجهاز غير محدد")
    zk = ZK(
        device.ip,
        port=device.port or 4370,
        timeout=device.timeout or 10,
        password=device.comm_password or 0,
        force_udp=bool(device.force_udp),
        ommit_ping=bool(device.ommit_ping),
    )
    conn = None
    try:
        conn = zk.connect()
        conn.disable_device()
        yield conn
    except (ZKErrorResponse, ZKNetworkError) as exc:
        raise DeviceError(f"تعذر الاتصال بالجهاز {device.ip}:{device.port} - {exc}") from exc
    except OSError as exc:
        raise DeviceError(f"خطأ شبكة أثناء الاتصال بالجهاز {device.ip} - {exc}") from exc
    finally:
        if conn is not None:
            try:
                conn.enable_device()
            finally:
                conn.disconnect()


def test_connection(device) -> dict:
    """يتحقق من الاتصال ويعيد معلومات الجهاز."""
    with connect(device) as conn:
        return {
            "device_name": _safe(conn.get_device_name),
            "serial_number": _safe(conn.get_serialnumber),
            "firmware": _safe(conn.get_firmware_version),
            "platform": _safe(conn.get_platform),
            "mac": _safe(conn.get_mac),
            "device_time": str(_safe(conn.get_time)),
            "users": _safe(lambda: len(conn.get_users())),
            "records": _safe(lambda: conn.records),
        }


def _safe(func):
    try:
        return func()
    except Exception:  # pragma: no cover - بعض الأجهزة لا تدعم كل الاستعلامات
        return None


def fetch_attendance(device) -> list[AttendanceRecord]:
    """يسحب كل سجلات الحضور المخزنة في الجهاز."""
    with connect(device) as conn:
        rows = conn.get_attendance() or []
        return [
            AttendanceRecord(
                user_id=str(r.user_id).strip(),
                timestamp=r.timestamp,
                status=str(getattr(r, "status", "")),
                verify_mode=str(getattr(r, "punch", "")),
                uid=str(getattr(r, "uid", "")),
            )
            for r in rows
        ]


def clear_attendance(device) -> None:
    """يمسح سجلات الحضور من ذاكرة الجهاز (بعد استيرادها)."""
    with connect(device) as conn:
        conn.clear_attendance()


def fetch_users(device) -> list[DeviceUser]:
    with connect(device) as conn:
        return [
            DeviceUser(
                user_id=str(u.user_id).strip(),
                name=(u.name or "").strip(),
                privilege=int(getattr(u, "privilege", 0) or 0),
                card=str(getattr(u, "card", "") or "") or None,
                uid=getattr(u, "uid", None),
            )
            for u in (conn.get_users() or [])
        ]


def push_user(device, user_id: str, name: str, privilege: int = 0) -> None:
    """يضيف/يحدّث موظفاً على الجهاز (بدون بصمة، تُسجَّل على الجهاز نفسه)."""
    with connect(device) as conn:
        uid = abs(hash(user_id)) % 60000 or 1
        try:
            uid = int(user_id)
        except ValueError:
            pass
        conn.set_user(uid=uid, name=name[:24], privilege=privilege, user_id=str(user_id))


def sync_time(device) -> datetime:
    """يضبط ساعة الجهاز على وقت الخادم."""
    now = datetime.now()
    with connect(device) as conn:
        conn.set_time(now)
    return now


# ------------------------------ الوضع التجريبي ------------------------------
def demo_attendance(employee_codes: list[str], days: int = 14, seed: int | None = None) -> list[AttendanceRecord]:
    """يولّد بصمات تجريبية واقعية (تأخير/غياب/وقت إضافي) لتجربة النظام."""
    rng = random.Random(seed if seed is not None else 20260902)
    records: list[AttendanceRecord] = []
    today = date.today()
    for offset in range(days, -1, -1):
        day = today - timedelta(days=offset)
        if day.weekday() in (4, 5):  # الجمعة والسبت عطلة
            continue
        for code in employee_codes:
            roll = rng.random()
            if roll < 0.06:  # غياب
                continue
            base_in = datetime.combine(day, time(8, 0))
            minutes_in = rng.randint(-25, 12) if roll > 0.22 else rng.randint(15, 55)
            check_in = base_in + timedelta(minutes=minutes_in, seconds=rng.randint(0, 59))
            check_out = datetime.combine(day, time(16, 0)) + timedelta(
                minutes=rng.randint(-20, 75), seconds=rng.randint(0, 59)
            )
            records.append(AttendanceRecord(code, check_in, status="0", verify_mode="1"))
            if roll > 0.10:
                records.append(AttendanceRecord(code, check_out, status="1", verify_mode="1"))
    return records
