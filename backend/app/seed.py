"""تهيئة قاعدة البيانات: الجداول، الحساب الأول، والبيانات الافتراضية والتجريبية."""
from __future__ import annotations

from datetime import date, time, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import ADMIN_PASSWORD, ADMIN_USERNAME
from .database import Base, SessionLocal, engine
from .models import (
    Department,
    Device,
    DeviceMode,
    Employee,
    Holiday,
    LeaveType,
    Role,
    Shift,
    User,
)
from .security import hash_password

DEFAULT_LEAVE_TYPES = [
    dict(code="annual", name="إجازة سنوية", annual_quota_days=30, exclude_weekends=False,
         exclude_holidays=False, color="#2f7d6f"),
    dict(code="sick", name="إجازة مرضية", annual_quota_days=30, requires_attachment=True, color="#c26a3d"),
    dict(code="emergency", name="إجازة اضطرارية", annual_quota_days=5, color="#8a6bbd"),
    dict(code="unpaid", name="إجازة بدون راتب", annual_quota_days=0, is_paid=False,
         deducts_balance=False, color="#6b7280"),
    dict(code="maternity", name="إجازة وضع", annual_quota_days=70, exclude_weekends=False,
         exclude_holidays=False, requires_attachment=True, color="#b3477a"),
    dict(code="marriage", name="إجازة زواج", annual_quota_days=5, exclude_weekends=False,
         exclude_holidays=False, color="#3d7fc2"),
]


def init_db() -> None:
    Base.metadata.create_all(bind=engine)


def ensure_defaults(db: Session) -> None:
    """ينشئ الوردية الافتراضية وأنواع الإجازات وحساب مدير النظام إن لم توجد."""
    if not db.scalar(select(Shift).limit(1)):
        db.add(
            Shift(
                name="الوردية الصباحية",
                start_time=time(8, 0),
                end_time=time(16, 0),
                grace_in_minutes=10,
                grace_out_minutes=10,
                work_days="6,0,1,2,3",
            )
        )
        db.add(
            Shift(
                name="الوردية المسائية",
                start_time=time(16, 0),
                end_time=time(23, 0),
                grace_in_minutes=10,
                grace_out_minutes=10,
                work_days="6,0,1,2,3",
            )
        )
    existing_types = {t.code for t in db.scalars(select(LeaveType)).all()}
    for data in DEFAULT_LEAVE_TYPES:
        if data["code"] not in existing_types:
            db.add(LeaveType(**data))

    if not db.scalar(select(User).where(User.username == ADMIN_USERNAME)):
        db.add(
            User(
                username=ADMIN_USERNAME,
                password_hash=hash_password(ADMIN_PASSWORD),
                role=Role.admin,
            )
        )
    db.commit()


DEMO_EMPLOYEES = [
    ("1001", "عبدالله محمد الحربي", "تقنية المعلومات", "مطور برمجيات"),
    ("1002", "سارة أحمد القحطاني", "الموارد البشرية", "أخصائي موارد بشرية"),
    ("1003", "خالد سعد الدوسري", "المالية", "محاسب"),
    ("1004", "نورة عبدالعزيز الشمري", "تقنية المعلومات", "مهندس شبكات"),
    ("1005", "فهد ناصر العتيبي", "العمليات", "مشرف تشغيل"),
    ("1006", "منى صالح الزهراني", "المالية", "محلل مالي"),
    ("1007", "تركي عبدالرحمن المطيري", "العمليات", "فني صيانة"),
    ("1008", "ريم فيصل السبيعي", "الموارد البشرية", "منسق تدريب"),
]


def seed_demo(db: Session, with_punches: bool = True) -> dict:
    """بيانات تجريبية كاملة: إدارات، موظفون، حسابات، عطلة، وجهاز تجريبي."""
    from .services import zk_service

    ensure_defaults(db)
    shift = db.scalar(select(Shift).order_by(Shift.id))
    departments: dict[str, Department] = {
        d.name: d for d in db.scalars(select(Department)).all()
    }
    for _, _, dep_name, _ in DEMO_EMPLOYEES:
        if dep_name not in departments:
            dep = Department(name=dep_name)
            db.add(dep)
            db.flush()
            departments[dep_name] = dep

    created = 0
    for code, name, dep_name, title in DEMO_EMPLOYEES:
        if db.scalar(select(Employee).where(Employee.code == code)):
            continue
        db.add(
            Employee(
                code=code,
                full_name=name,
                job_title=title,
                department_id=departments[dep_name].id,
                shift_id=shift.id if shift else None,
                hire_date=date.today() - timedelta(days=400 + created * 30),
                basic_salary=8000 + created * 500,
                email=f"user{code}@example.com",
            )
        )
        created += 1
    db.commit()

    # مدير إدارة الموارد البشرية + حساب موظف للتجربة
    hr_emp = db.scalar(select(Employee).where(Employee.code == "1002"))
    ops_emp = db.scalar(select(Employee).where(Employee.code == "1005"))
    emp_emp = db.scalar(select(Employee).where(Employee.code == "1001"))
    if ops_emp:
        for e in db.scalars(select(Employee).where(Employee.code.in_(["1007"]))).all():
            e.manager_id = ops_emp.id
    accounts = [
        ("hr", "hr12345", Role.hr, hr_emp),
        ("manager", "manager123", Role.manager, ops_emp),
        ("employee", "employee123", Role.employee, emp_emp),
    ]
    for username, password, role, emp in accounts:
        if not db.scalar(select(User).where(User.username == username)):
            db.add(
                User(
                    username=username,
                    password_hash=hash_password(password),
                    role=role,
                    employee_id=emp.id if emp else None,
                )
            )

    today = date.today()
    national_day = date(today.year, 9, 23)
    if not db.scalar(select(Holiday).where(Holiday.holiday_date == national_day)):
        db.add(Holiday(holiday_date=national_day, name="اليوم الوطني"))

    device = db.scalar(select(Device).where(Device.mode == DeviceMode.demo))
    if device is None:
        device = Device(
            name="جهاز بصمة تجريبي",
            mode=DeviceMode.demo,
            location="المدخل الرئيسي",
            serial_number="DEMO-0001",
        )
        db.add(device)
    db.commit()

    result = {}
    if with_punches:
        result = zk_service.sync_device(db, device, demo_days=21)
    return {"employees_created": created, "sync": result}


def bootstrap() -> None:
    init_db()
    with SessionLocal() as db:
        ensure_defaults(db)


if __name__ == "__main__":  # pragma: no cover
    import sys

    init_db()
    with SessionLocal() as db:
        if "--demo" in sys.argv:
            print(seed_demo(db))
        else:
            ensure_defaults(db)
            print("تمت التهيئة: الجداول والحساب الافتراضي جاهزة")
