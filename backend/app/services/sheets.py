"""ربط النظام بجوجل شيت عبر Google Apps Script (بدون حساب Google Cloud).

الفكرة: سكربت صغير داخل ملف جوجل شيت يُنشر كـ«تطبيق ويب»، والنظام يرسل إليه
الصفوف عبر HTTP. كل دفعة تُخزَّن أولاً في صندوق إرسال داخل قاعدة البيانات،
فإن انقطعت الشبكة تُعاد المحاولة تلقائياً ولا يضيع أي صف.
"""
from __future__ import annotations

import json
import logging
import threading
import urllib.error
import urllib.request
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..models import SheetsOutbox
from . import settings_store

logger = logging.getLogger("hr")

MAX_ATTEMPTS = 12
TIMEOUT_SECONDS = 20

# أسماء الأوراق وعناوين الأعمدة لكل نوع بيانات
DATASETS: dict[str, dict] = {
    "punches": {
        "sheet": "البصمات",
        "headers": ["التاريخ والوقت", "رقم الموظف", "الاسم", "المصدر", "الجهاز/الموقع",
                    "المسافة (م)", "ملاحظة"],
    },
    "attendance": {
        "sheet": "الحضور اليومي",
        "headers": ["التاريخ", "رقم الموظف", "الاسم", "الحضور", "الانصراف", "ساعات العمل",
                    "تأخير (د)", "خروج مبكر (د)", "إضافي (د)", "الحالة"],
    },
    "leaves": {
        "sheet": "الإجازات",
        "headers": ["رقم الطلب", "رقم الموظف", "الموظف", "نوع الإجازة", "من", "إلى",
                    "الأيام", "الحالة", "السبب"],
    },
    "violations": {
        "sheet": "المخالفات",
        "headers": ["التاريخ", "رقم الموظف", "الموظف", "المخالفة", "التكرار", "الجزاء",
                    "الخصم (ريال)", "الحالة"],
    },
    "payroll": {
        "sheet": "الرواتب",
        "headers": ["الفترة", "رقم الموظف", "الاسم", "الأساسي", "البدلات", "أيام الحضور", "أيام الغياب",
                    "خصم الغياب", "خصم التأخير", "خصم الخروج المبكر",
                    "خصم المخالفات", "قسط السلفة",
                    "بدل الإضافي", "الصافي"],
    },
}


def is_enabled(db: Session, dataset: str | None = None) -> bool:
    if not settings_store.get_bool(db, "sheets_enabled"):
        return False
    if not settings_store.get(db, "sheets_webhook_url"):
        return False
    if dataset is None:
        return True
    allowed = {d.strip() for d in settings_store.get(db, "sheets_datasets").split(",")}
    return dataset in allowed


def _clean(value):
    """تحويل القيم إلى أنواع تقبلها جوجل شيت."""
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=" ", timespec="minutes") if isinstance(value, datetime) else value.isoformat()
    if isinstance(value, bool):
        return "نعم" if value else "لا"
    return value


def enqueue(db: Session, dataset: str, rows: list[list], mode: str = "append", commit: bool = True) -> int:
    """يضيف صفوفاً إلى صندوق الإرسال. يعيد عدد الصفوف المضافة."""
    if not rows or dataset not in DATASETS or not is_enabled(db, dataset):
        return 0
    payload = {
        "dataset": dataset,
        "sheet": DATASETS[dataset]["sheet"],
        "headers": DATASETS[dataset]["headers"],
        "mode": mode,   # append = إضافة، replace = استبدال الورقة بالكامل
        "rows": [[_clean(cell) for cell in row] for row in rows],
    }
    db.add(
        SheetsOutbox(
            dataset=dataset,
            payload=json.dumps(payload, ensure_ascii=False),
            rows_count=len(rows),
        )
    )
    if commit:
        db.commit()
    else:
        db.flush()
    return len(rows)


def post_payload(url: str, secret: str, payload: dict) -> tuple[bool, str]:
    """يرسل دفعة واحدة إلى تطبيق الويب ويعيد (نجاح، رسالة)."""
    body = json.dumps({**payload, "secret": secret}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            text = response.read().decode("utf-8", errors="ignore")[:200]
            if response.status >= 400:
                return False, f"HTTP {response.status}: {text}"
            if "error" in text.lower() or "unauthorized" in text.lower():
                return False, text
            return True, text or "OK"
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}: {exc.read().decode('utf-8', errors='ignore')[:150]}"
    except Exception as exc:  # شبكة، مهلة، رابط خاطئ
        return False, str(exc)[:200]


def flush(db: Session, limit: int = 100) -> dict:
    """يرسل الدفعات المعلّقة. يُستدعى دورياً وبعد كل إضافة."""
    if not is_enabled(db):
        return {"sent": 0, "failed": 0, "pending": 0, "message": "الربط غير مفعّل"}

    url = settings_store.get(db, "sheets_webhook_url")
    secret = settings_store.get(db, "sheets_secret")
    rows = db.scalars(
        select(SheetsOutbox)
        .where(SheetsOutbox.status == "pending")
        .order_by(SheetsOutbox.id)
        .limit(limit)
    ).all()

    sent = failed = 0
    for item in rows:
        ok, message = post_payload(url, secret, json.loads(item.payload))
        item.attempts += 1
        if ok:
            item.status = "sent"
            item.sent_at = datetime.now()
            item.last_error = None
            sent += 1
        else:
            item.last_error = message
            if item.attempts >= MAX_ATTEMPTS:
                item.status = "failed"
            failed += 1
    db.commit()

    pending = len(
        db.scalars(select(SheetsOutbox).where(SheetsOutbox.status == "pending")).all()
    )
    return {
        "sent": sent,
        "failed": failed,
        "pending": pending,
        "message": f"أُرسلت {sent} دفعة" + (f"، وتعذّرت {failed}" if failed else ""),
    }


def flush_async() -> None:
    """إرسال في الخلفية حتى لا يتأخر رد الواجهة."""

    def worker() -> None:
        try:
            with SessionLocal() as db:
                flush(db)
        except Exception as exc:  # pragma: no cover - حماية الخيط
            logger.warning("تعذر إرسال دفعات جوجل شيت: %s", exc)

    threading.Thread(target=worker, daemon=True).start()


def push(db: Session, dataset: str, rows: list[list], mode: str = "append") -> int:
    """إضافة إلى الصندوق ثم محاولة إرسال فورية في الخلفية."""
    count = enqueue(db, dataset, rows, mode=mode)
    if count:
        flush_async()
    return count


# ------------------------------ تحويل السجلات إلى صفوف ------------------------------
def punch_rows(punches) -> list[list]:
    return [
        [
            p.punch_time,
            p.employee_code,
            p.employee.full_name if p.employee else "",
            {"device_pull": "جهاز (سحب)", "device_push": "جهاز (دفع)",
             "manual": "إدخال يدوي", "web": "تطبيق الموظف"}.get(p.source.value, p.source.value),
            (p.device.name if p.device else None) or (p.site.name if p.site else ""),
            round(p.distance_meters) if p.distance_meters is not None else "",
            p.note or "",
        ]
        for p in punches
    ]


def attendance_rows(days, status_labels: dict) -> list[list]:
    return [
        [
            d.work_date,
            d.employee.code if d.employee else "",
            d.employee.full_name if d.employee else "",
            d.check_in.strftime("%H:%M") if d.check_in else "",
            d.check_out.strftime("%H:%M") if d.check_out else "",
            round(d.worked_minutes / 60, 2),
            d.late_minutes,
            d.early_leave_minutes,
            d.overtime_minutes,
            status_labels.get(d.status, d.status.value),
        ]
        for d in days
    ]


def leave_rows(requests, status_labels: dict) -> list[list]:
    return [
        [
            r.id,
            r.employee.code if r.employee else "",
            r.employee.full_name if r.employee else "",
            r.leave_type.name if r.leave_type else "",
            r.start_date,
            r.end_date,
            r.days,
            status_labels.get(r.status, r.status.value),
            (r.reason or "").replace("\n", " "),
        ]
        for r in requests
    ]


def violation_rows(violations, penalty_labels: dict, status_labels: dict) -> list[list]:
    return [
        [
            v.occurred_on,
            v.employee.code if v.employee else "",
            v.employee.full_name if v.employee else "",
            v.violation_type.name if v.violation_type else "",
            v.repetition_no,
            penalty_labels.get(v.penalty_action, v.penalty_action.value),
            v.penalty_amount,
            status_labels.get(v.status, v.status.value),
        ]
        for v in violations
    ]


def payslip_rows(run, slips) -> list[list]:
    period = f"{run.month:02d}/{run.year}"
    return [
        [
            period,
            s.employee.code if s.employee else "",
            s.employee.full_name if s.employee else "",
            s.basic_salary,
            s.allowances or 0,
            s.present_days,
            s.absent_days,
            s.absence_deduction,
            s.late_deduction,
            s.early_leave_deduction or 0,
            s.violation_deduction,
            s.loan_deduction or 0,
            s.overtime_amount,
            s.net_pay,
        ]
        for s in slips
    ]


def push_day_attendance(db: Session, work_date: date) -> int:
    """يرسل ملخص حضور يوم كامل إلى جوجل شيت."""
    from ..models import AttendanceDay, DayStatus

    labels = {
        DayStatus.present: "حاضر", DayStatus.late: "متأخر", DayStatus.absent: "غائب",
        DayStatus.leave: "إجازة", DayStatus.holiday: "عطلة رسمية",
        DayStatus.weekend: "راحة أسبوعية", DayStatus.missing_out: "انصراف ناقص",
        DayStatus.scheduled: "لم يحن بعد",
    }
    rows_db = db.scalars(
        select(AttendanceDay).where(AttendanceDay.work_date == work_date)
    ).all()
    interesting = [r for r in rows_db if r.status != DayStatus.scheduled]
    if not interesting:
        return 0
    return push(db, "attendance", attendance_rows(interesting, labels))


def daily_attendance_job(db: Session) -> int:
    """يرسل حضور اليوم السابق مرة واحدة يومياً (يُستدعى من حلقة الخلفية)."""
    if not is_enabled(db, "attendance"):
        return 0
    from datetime import timedelta

    target = date.today() - timedelta(days=1)
    last = settings_store.get(db, "sheets_last_attendance_date")
    if last == target.isoformat():
        return 0
    count = push_day_attendance(db, target)
    settings_store.set_many(db, {"sheets_last_attendance_date": target.isoformat()})
    return count
