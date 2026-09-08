"""إعدادات النظام المخزّنة في قاعدة البيانات (مفتاح/قيمة)."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AppSetting

DEFAULTS: dict[str, str] = {
    # تفعيل تسجيل الحضور الذاتي من التطبيق
    "web_punch_enabled": "true",
    # إلزام الموظف بأن يكون داخل نطاق موقع عمل معتمد
    "web_punch_requires_location": "true",
    # أقصى هامش خطأ مقبول لدقة تحديد الموقع (بالأمتار)
    "geo_max_accuracy_meters": "150",
    # ------------------------------ الرواتب ------------------------------
    # عدد أيام الشهر المعتمدة لاحتساب أجر اليوم
    "payroll_days_per_month": "30",
    # ساعات يوم العمل لاحتساب أجر الساعة
    "payroll_workday_hours": "8",
    # معامل أجر الساعة الإضافية (نظام العمل السعودي: 1.5)
    "payroll_overtime_multiplier": "1.5",
    # خصم التأخير: proportional = بمقدار زمن التأخير، none = بدون خصم
    "payroll_late_deduction_mode": "proportional",
    # عدد أيام الأجر التي تُخصم عن كل يوم غياب بدون إذن (2 = أجر يومين عن اليوم الواحد).
    # الغياب بإذن يُسجَّل إجازة: بدون راتب = يوم واحد، أو إجازة مدفوعة = بلا خصم.
    "payroll_absence_multiplier": "2",
    # أساس احتساب الخصومات وأجر اليوم: total = الأساسي + البدلات، basic = الأساسي فقط
    "payroll_deduction_base": "total",
    # ------------------------------ حسابات الموظفين ------------------------------
    # إنشاء حساب دخول تلقائياً لكل موظف يُسجَّل له رقم جوال
    "auto_account_on_phone": "true",
    # ------------------------------ إشعارات الجوال ------------------------------
    # تفعيل إشعارات الويب (Web Push) التي تظهر بنغمة على جوال الموظف
    "push_enabled": "true",
    # عنوان المسؤول المطلوب في بروتوكول VAPID
    "push_subject": "mailto:hr@example.com",
    # مفاتيح VAPID (تُولَّد تلقائياً، لا تُعدّل يدوياً)
    "push_private_key": "",
    "push_public_key": "",
    # ------------------------------ تنبيه الغياب والتأخير ------------------------------
    # إرسال تنبيه يومي بمن لم يبصم ومن تأخر
    "attendance_alert_enabled": "true",
    # كم دقيقة بعد بداية الوردية يُرسل التنبيه
    "attendance_alert_after_minutes": "60",
    # تنبيه الموظف نفسه أيضاً عند عدم بصمه
    "attendance_alert_notify_employee": "true",
    # آخر يوم أُرسل فيه التنبيه (يُدار داخلياً)
    "attendance_alert_last_sent": "",
    # ------------------------------ المخالفات ------------------------------
    # المدة التي تُمحى بعدها المخالفة من سجل التكرار (نظام العمل: 180 يوماً)
    "violation_reset_days": "180",
    # ------------------------------ هوية المنشأة ------------------------------
    # اسم المنشأة كما يظهر في الواجهة
    "company_name": "",
    # اسم ملف الشعار داخل مجلد المرفقات
    "logo_path": "",
    # إرسال العبارة التحفيزية إشعاراً يومياً لكل الموظفين
    "daily_quote_enabled": "true",
    # ساعة إرسال العبارة (0-23)
    "daily_quote_hour": "7",
    # آخر يوم أُرسلت فيه (يُدار داخلياً)
    "daily_quote_last_sent": "",
    # ------------------------------ ربط جوجل شيت ------------------------------
    # تفعيل الإرسال التلقائي إلى جوجل شيت
    "sheets_enabled": "false",
    # رابط تطبيق الويب الناتج من Google Apps Script
    "sheets_webhook_url": "",
    # كلمة سر مشتركة للتحقق (تُكتب في السكربت أيضاً)
    "sheets_secret": "",
    # البيانات المُرسَلة: punches,attendance,leaves,violations,payroll
    "sheets_datasets": "punches,attendance,leaves,violations,payroll",
    # آخر يوم حضور أُرسل تلقائياً (يُدار داخلياً)
    "sheets_last_attendance_date": "",
    # ------------------------------ الوثائق ------------------------------
    # التنبيه قبل انتهاء الوثيقة بعدد أيام
    "document_alert_days": "30",
}

BOOL_KEYS = {"web_punch_enabled", "web_punch_requires_location"}


def get_all(db: Session) -> dict[str, str]:
    stored = {row.key: row.value for row in db.scalars(select(AppSetting)).all()}
    return {**DEFAULTS, **{k: v for k, v in stored.items() if k in DEFAULTS}}


def get(db: Session, key: str) -> str:
    row = db.get(AppSetting, key)
    return row.value if row else DEFAULTS.get(key, "")


def get_bool(db: Session, key: str) -> bool:
    return str(get(db, key)).strip().lower() in ("1", "true", "yes", "on")


def get_int(db: Session, key: str, fallback: int = 0) -> int:
    try:
        return int(float(get(db, key)))
    except (TypeError, ValueError):
        return fallback


def set_many(db: Session, values: dict[str, str | bool | int | float]) -> dict[str, str]:
    for key, value in values.items():
        if key not in DEFAULTS or value is None:
            continue
        text = "true" if value is True else "false" if value is False else str(value)
        row = db.get(AppSetting, key)
        if row:
            row.value = text
        else:
            db.add(AppSetting(key=key, value=text))
    db.commit()
    return get_all(db)
