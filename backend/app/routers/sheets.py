"""إدارة ربط جوجل شيت: الإعداد، الاختبار، الإرسال، وإعادة المزامنة."""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    AttendanceDay,
    DayStatus,
    LeaveRequest,
    LeaveStatus,
    PayrollRun,
    Payslip,
    Punch,
    SheetsOutbox,
    User,
    Violation,
    ViolationStatus,
)
from ..security import require_hr
from ..services import audit, settings_store, sheets
from ..services.violations import PENALTY_LABELS, STATUS_LABELS as VIOLATION_STATUS_LABELS

router = APIRouter(prefix="/api/sheets", tags=["sheets"], dependencies=[Depends(require_hr)])

DAY_LABELS = {
    DayStatus.present: "حاضر", DayStatus.late: "متأخر", DayStatus.absent: "غائب",
    DayStatus.leave: "إجازة", DayStatus.holiday: "عطلة رسمية",
    DayStatus.weekend: "راحة أسبوعية", DayStatus.missing_out: "انصراف ناقص",
    DayStatus.scheduled: "لم يحن بعد",
}
LEAVE_LABELS = {
    LeaveStatus.pending: "قيد الاعتماد", LeaveStatus.approved: "معتمدة",
    LeaveStatus.rejected: "مرفوضة", LeaveStatus.cancelled: "ملغاة",
}


class SheetsSettingsIn(BaseModel):
    sheets_enabled: bool | None = None
    sheets_webhook_url: str | None = None
    sheets_secret: str | None = None
    sheets_datasets: str | None = None


class SheetsStatusOut(BaseModel):
    enabled: bool
    webhook_url: str = ""
    has_secret: bool = False
    datasets: list[str] = []
    pending: int = 0
    failed: int = 0
    sent_today: int = 0
    last_error: str | None = None


@router.get("/status", response_model=SheetsStatusOut)
def status(db: Session = Depends(get_db)):
    values = settings_store.get_all(db)
    rows = db.scalars(select(SheetsOutbox)).all()
    today = date.today()
    failed_rows = [r for r in rows if r.status == "failed"]
    last_error = None
    for row in sorted(rows, key=lambda r: r.id, reverse=True):
        if row.last_error:
            last_error = row.last_error
            break
    return SheetsStatusOut(
        enabled=values["sheets_enabled"] == "true",
        webhook_url=values["sheets_webhook_url"],
        has_secret=bool(values["sheets_secret"]),
        datasets=[d for d in values["sheets_datasets"].split(",") if d],
        pending=len([r for r in rows if r.status == "pending"]),
        failed=len(failed_rows),
        sent_today=len([r for r in rows if r.status == "sent" and r.sent_at and r.sent_at.date() == today]),
        last_error=last_error,
    )


@router.put("/settings", response_model=SheetsStatusOut)
def update_settings(
    payload: SheetsSettingsIn, db: Session = Depends(get_db), user: User = Depends(require_hr)
):
    changes = payload.model_dump(exclude_unset=True)
    if changes.get("sheets_webhook_url"):
        url = changes["sheets_webhook_url"].strip()
        if not url.startswith("https://script.google.com/"):
            raise HTTPException(
                status_code=400,
                detail="الرابط يجب أن يكون رابط تطبيق ويب من Google Apps Script (يبدأ بـ https://script.google.com/)",
            )
        changes["sheets_webhook_url"] = url
    settings_store.set_many(db, changes)
    audit.log(db, user, "settings", "settings", None, "ربط جوجل شيت: " + "، ".join(changes.keys()))
    return status(db)


@router.post("/test")
def test_connection(db: Session = Depends(get_db)):
    """يرسل صفاً تجريبياً للتأكد من صحة الرابط وكلمة السر."""
    url = settings_store.get(db, "sheets_webhook_url")
    if not url:
        raise HTTPException(status_code=400, detail="لم يُضبط رابط تطبيق الويب بعد")
    ok, message = sheets.post_payload(
        url,
        settings_store.get(db, "sheets_secret"),
        {
            "dataset": "test",
            "sheet": "اختبار الاتصال",
            "headers": ["الوقت", "الرسالة"],
            "mode": "append",
            "rows": [[date.today().isoformat(), "تم الاتصال بنجاح من نظام الموارد البشرية"]],
        },
    )
    if not ok:
        raise HTTPException(status_code=502, detail=f"فشل الاتصال: {message}")
    return {"ok": True, "message": "تم الاتصال بجوجل شيت بنجاح — راجع ورقة «اختبار الاتصال»"}


@router.post("/flush")
def flush_now(db: Session = Depends(get_db)):
    """إرسال الدفعات المعلّقة فوراً."""
    return sheets.flush(db)


@router.post("/retry-failed")
def retry_failed(db: Session = Depends(get_db)):
    rows = db.scalars(select(SheetsOutbox).where(SheetsOutbox.status == "failed")).all()
    for row in rows:
        row.status = "pending"
        row.attempts = 0
    db.commit()
    return {"ok": True, "message": f"أُعيدت {len(rows)} دفعة إلى قائمة الإرسال", **sheets.flush(db)}


@router.post("/sync")
def backfill(
    dataset: str,
    date_from: date = Query(default_factory=lambda: date.today() - timedelta(days=30)),
    date_to: date = Query(default_factory=date.today),
    replace: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(require_hr),
):
    """إعادة مزامنة بيانات فترة كاملة إلى جوجل شيت (استبدال الورقة افتراضياً)."""
    if dataset not in sheets.DATASETS:
        raise HTTPException(status_code=400, detail="نوع بيانات غير معروف")
    if not sheets.is_enabled(db, dataset):
        raise HTTPException(status_code=400, detail="ربط جوجل شيت غير مفعّل لهذا النوع")

    if dataset == "punches":
        rows = sheets.punch_rows(
            db.scalars(
                select(Punch).where(
                    Punch.punch_time >= date_from,
                    Punch.punch_time < date_to + timedelta(days=1),
                ).order_by(Punch.punch_time)
            ).all()
        )
    elif dataset == "attendance":
        rows = sheets.attendance_rows(
            db.scalars(
                select(AttendanceDay).where(
                    AttendanceDay.work_date >= date_from, AttendanceDay.work_date <= date_to
                ).order_by(AttendanceDay.work_date)
            ).all(),
            DAY_LABELS,
        )
    elif dataset == "leaves":
        rows = sheets.leave_rows(
            db.scalars(
                select(LeaveRequest).where(
                    LeaveRequest.start_date >= date_from, LeaveRequest.start_date <= date_to
                ).order_by(LeaveRequest.start_date)
            ).all(),
            LEAVE_LABELS,
        )
    elif dataset == "violations":
        rows = sheets.violation_rows(
            db.scalars(
                select(Violation).where(
                    Violation.occurred_on >= date_from, Violation.occurred_on <= date_to
                ).order_by(Violation.occurred_on)
            ).all(),
            PENALTY_LABELS,
            VIOLATION_STATUS_LABELS,
        )
    else:  # payroll
        rows = []
        for run in db.scalars(select(PayrollRun).order_by(PayrollRun.year, PayrollRun.month)).all():
            if not (date_from <= date(run.year, run.month, 1) <= date_to):
                continue
            slips = db.scalars(select(Payslip).where(Payslip.run_id == run.id)).all()
            rows.extend(sheets.payslip_rows(run, slips))

    count = sheets.enqueue(db, dataset, rows, mode="replace" if replace else "append")
    result = sheets.flush(db)
    audit.log(db, user, "sync", "settings", None, f"مزامنة {dataset} إلى جوجل شيت ({count} صف)")
    return {"ok": True, "rows": count, "message": f"أُرسل {count} صف إلى جوجل شيت", **result}
