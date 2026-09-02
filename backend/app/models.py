"""نماذج قاعدة البيانات لنظام الموارد البشرية (الحضور والانصراف والإجازات)."""
from __future__ import annotations

import enum
from datetime import date, datetime, time

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Time,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Role(str, enum.Enum):
    admin = "admin"        # مدير النظام
    hr = "hr"              # موظف موارد بشرية
    manager = "manager"    # مدير إدارة (يعتمد إجازات فريقه)
    employee = "employee"  # موظف


class EmployeeStatus(str, enum.Enum):
    active = "active"
    suspended = "suspended"
    terminated = "terminated"


class LeaveStatus(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    cancelled = "cancelled"


class PunchType(str, enum.Enum):
    auto = "auto"   # يحدده النظام حسب ترتيب البصمات
    in_ = "in"
    out = "out"


class PunchSource(str, enum.Enum):
    device_pull = "device_pull"   # مسحوبة من الجهاز عبر البروتوكول 4370
    device_push = "device_push"   # أرسلها الجهاز عبر ADMS/iclock
    manual = "manual"             # إدخال يدوي من الموارد البشرية
    web = "web"                   # تسجيل ذاتي من الويب


class DayStatus(str, enum.Enum):
    present = "present"
    late = "late"
    absent = "absent"
    leave = "leave"
    holiday = "holiday"
    weekend = "weekend"
    missing_out = "missing_out"
    scheduled = "scheduled"   # يوم عمل لم يحن بعد (لا يُحتسب غياباً)


class PenaltyAction(str, enum.Enum):
    """الجزاء المقرر للمخالفة وفق لائحة تنظيم العمل."""

    warning = "warning"                       # إنذار كتابي
    deduction_percent_day = "deduction_percent_day"  # خصم نسبة من أجر يوم
    deduction_days = "deduction_days"         # خصم أجر أيام
    suspension = "suspension"                 # إيقاف عن العمل بدون أجر
    termination = "termination"               # الفصل


class ViolationStatus(str, enum.Enum):
    pending = "pending"            # مسجلة بانتظار إشعار الموظف
    acknowledged = "acknowledged"  # أقرّ الموظف بالاطلاع
    objected = "objected"          # تظلّم الموظف
    approved = "approved"          # معتمدة ويُطبَّق الجزاء
    cancelled = "cancelled"        # ملغاة


class PayrollStatus(str, enum.Enum):
    draft = "draft"
    approved = "approved"


class DeviceMode(str, enum.Enum):
    pull = "pull"   # النظام يتصل بالجهاز ويسحب السجلات
    push = "push"   # الجهاز يرسل السجلات إلى النظام (ADMS)
    demo = "demo"   # جهاز تجريبي لتشغيل النظام بدون عتاد


class AppSetting(Base):
    """إعدادات النظام كقيم مفتاح/قيمة نصية."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(255))


class WorkSite(Base):
    """موقع عمل معتمد للحضور الذاتي من التطبيق (نطاق جغرافي)."""

    __tablename__ = "work_sites"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    radius_meters: Mapped[int] = mapped_column(Integer, default=150)
    address: Mapped[str | None] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[Role] = mapped_column(Enum(Role), default=Role.employee)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    employee: Mapped["Employee | None"] = relationship(back_populates="user", foreign_keys=[employee_id])


class Department(Base):
    __tablename__ = "departments"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    manager_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id", ondelete="SET NULL"))

    employees: Mapped[list["Employee"]] = relationship(
        back_populates="department", foreign_keys="Employee.department_id"
    )


class Shift(Base):
    __tablename__ = "shifts"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True)
    start_time: Mapped[time] = mapped_column(Time)
    end_time: Mapped[time] = mapped_column(Time)
    grace_in_minutes: Mapped[int] = mapped_column(Integer, default=10)
    grace_out_minutes: Mapped[int] = mapped_column(Integer, default=10)
    break_minutes: Mapped[int] = mapped_column(Integer, default=0)
    # أيام العمل: 0=الاثنين ... 6=الأحد (ترقيم بايثون weekday)
    work_days: Mapped[str] = mapped_column(String(20), default="6,0,1,2,3")
    is_night_shift: Mapped[bool] = mapped_column(Boolean, default=False)

    employees: Mapped[list["Employee"]] = relationship(back_populates="shift")

    @property
    def work_day_list(self) -> list[int]:
        return [int(d) for d in self.work_days.split(",") if d.strip() != ""]


class Employee(Base):
    __tablename__ = "employees"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)  # رقم الموظف في جهاز البصمة
    full_name: Mapped[str] = mapped_column(String(160))
    national_id: Mapped[str | None] = mapped_column(String(32))
    email: Mapped[str | None] = mapped_column(String(160))
    phone: Mapped[str | None] = mapped_column(String(32))
    job_title: Mapped[str | None] = mapped_column(String(120))
    department_id: Mapped[int | None] = mapped_column(ForeignKey("departments.id", ondelete="SET NULL"))
    shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id", ondelete="SET NULL"))
    site_id: Mapped[int | None] = mapped_column(ForeignKey("work_sites.id", ondelete="SET NULL"))
    manager_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id", ondelete="SET NULL"))
    hire_date: Mapped[date | None] = mapped_column(Date)
    basic_salary: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[EmployeeStatus] = mapped_column(Enum(EmployeeStatus), default=EmployeeStatus.active)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    department: Mapped[Department | None] = relationship(
        back_populates="employees", foreign_keys=[department_id]
    )
    shift: Mapped[Shift | None] = relationship(back_populates="employees")
    site: Mapped["WorkSite | None"] = relationship()
    manager: Mapped["Employee | None"] = relationship(remote_side=[id], foreign_keys=[manager_id])
    user: Mapped[User | None] = relationship(
        back_populates="employee", foreign_keys=[User.employee_id], uselist=False
    )


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    mode: Mapped[DeviceMode] = mapped_column(Enum(DeviceMode), default=DeviceMode.pull)
    ip: Mapped[str | None] = mapped_column(String(64))
    port: Mapped[int] = mapped_column(Integer, default=4370)
    comm_password: Mapped[int] = mapped_column(Integer, default=0)
    timeout: Mapped[int] = mapped_column(Integer, default=10)
    force_udp: Mapped[bool] = mapped_column(Boolean, default=False)
    ommit_ping: Mapped[bool] = mapped_column(Boolean, default=True)
    serial_number: Mapped[str | None] = mapped_column(String(64), index=True)  # لأجهزة الدفع ADMS
    location: Mapped[str | None] = mapped_column(String(160))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    clear_after_sync: Mapped[bool] = mapped_column(Boolean, default=False)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_status: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Punch(Base):
    """بصمة خام كما وردت من الجهاز أو أُدخلت يدوياً."""

    __tablename__ = "punches"
    __table_args__ = (UniqueConstraint("employee_code", "punch_time", "device_id", name="uq_punch"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_code: Mapped[str] = mapped_column(String(32), index=True)
    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    punch_time: Mapped[datetime] = mapped_column(DateTime, index=True)
    punch_type: Mapped[PunchType] = mapped_column(Enum(PunchType), default=PunchType.auto)
    source: Mapped[PunchSource] = mapped_column(Enum(PunchSource), default=PunchSource.device_pull)
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"))
    verify_mode: Mapped[str | None] = mapped_column(String(16))   # 1=بصمة، 4=بطاقة، 15=وجه...
    status_code: Mapped[str | None] = mapped_column(String(16))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    accuracy_meters: Mapped[float | None] = mapped_column(Float)
    site_id: Mapped[int | None] = mapped_column(ForeignKey("work_sites.id", ondelete="SET NULL"))
    distance_meters: Mapped[float | None] = mapped_column(Float)
    note: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    employee: Mapped[Employee | None] = relationship()
    device: Mapped[Device | None] = relationship()
    site: Mapped[WorkSite | None] = relationship()


class AttendanceDay(Base):
    """ملخص يوم عمل واحد لموظف واحد، مُحتسب من البصمات."""

    __tablename__ = "attendance_days"
    __table_args__ = (UniqueConstraint("employee_id", "work_date", name="uq_attendance_day"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    work_date: Mapped[date] = mapped_column(Date, index=True)
    check_in: Mapped[datetime | None] = mapped_column(DateTime)
    check_out: Mapped[datetime | None] = mapped_column(DateTime)
    worked_minutes: Mapped[int] = mapped_column(Integer, default=0)
    late_minutes: Mapped[int] = mapped_column(Integer, default=0)
    early_leave_minutes: Mapped[int] = mapped_column(Integer, default=0)
    overtime_minutes: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[DayStatus] = mapped_column(Enum(DayStatus), default=DayStatus.absent)
    punches_count: Mapped[int] = mapped_column(Integer, default=0)
    leave_request_id: Mapped[int | None] = mapped_column(ForeignKey("leave_requests.id", ondelete="SET NULL"))
    note: Mapped[str | None] = mapped_column(String(255))
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    employee: Mapped[Employee] = relationship()


class LeaveType(Base):
    __tablename__ = "leave_types"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    annual_quota_days: Mapped[float] = mapped_column(Float, default=0)
    is_paid: Mapped[bool] = mapped_column(Boolean, default=True)
    deducts_balance: Mapped[bool] = mapped_column(Boolean, default=True)
    exclude_weekends: Mapped[bool] = mapped_column(Boolean, default=True)
    exclude_holidays: Mapped[bool] = mapped_column(Boolean, default=True)
    requires_attachment: Mapped[bool] = mapped_column(Boolean, default=False)
    max_consecutive_days: Mapped[int] = mapped_column(Integer, default=0)  # 0 = بدون حد
    color: Mapped[str] = mapped_column(String(16), default="#2f7d6f")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class LeaveBalance(Base):
    __tablename__ = "leave_balances"
    __table_args__ = (
        UniqueConstraint("employee_id", "leave_type_id", "year", name="uq_leave_balance"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    leave_type_id: Mapped[int] = mapped_column(ForeignKey("leave_types.id", ondelete="CASCADE"))
    year: Mapped[int] = mapped_column(Integer, index=True)
    entitled_days: Mapped[float] = mapped_column(Float, default=0)
    carried_over_days: Mapped[float] = mapped_column(Float, default=0)
    used_days: Mapped[float] = mapped_column(Float, default=0)

    leave_type: Mapped[LeaveType] = relationship()
    employee: Mapped[Employee] = relationship()


class LeaveRequest(Base):
    __tablename__ = "leave_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    leave_type_id: Mapped[int] = mapped_column(ForeignKey("leave_types.id", ondelete="RESTRICT"))
    start_date: Mapped[date] = mapped_column(Date, index=True)
    end_date: Mapped[date] = mapped_column(Date, index=True)
    days: Mapped[float] = mapped_column(Float, default=0)
    reason: Mapped[str | None] = mapped_column(Text)
    status: Mapped[LeaveStatus] = mapped_column(Enum(LeaveStatus), default=LeaveStatus.pending, index=True)
    attachment_path: Mapped[str | None] = mapped_column(String(255))
    decided_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime)
    decision_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    employee: Mapped[Employee] = relationship()
    leave_type: Mapped[LeaveType] = relationship()


class Holiday(Base):
    __tablename__ = "holidays"

    id: Mapped[int] = mapped_column(primary_key=True)
    holiday_date: Mapped[date] = mapped_column(Date, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(160))


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(80))
    entity: Mapped[str] = mapped_column(String(80))
    entity_id: Mapped[str | None] = mapped_column(String(40))
    detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)


class DeviceCommand(Base):
    """أوامر بانتظار جهاز يعمل بوضع الدفع (ADMS) ليسحبها عند اتصاله."""

    __tablename__ = "device_commands"

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    command: Mapped[str] = mapped_column(Text)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime)
    result: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class Notification(Base):
    """إشعار داخل النظام لمستخدم معيّن."""

    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(40), default="general")
    link_page: Mapped[str | None] = mapped_column(String(40))
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), index=True)


class ViolationType(Base):
    """نوع مخالفة مع سلّم الجزاءات حسب عدد التكرار."""

    __tablename__ = "violation_types"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    category: Mapped[str] = mapped_column(String(60), default="سلوك عام")
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # سلّم الجزاءات: المخالفة الأولى حتى الرابعة فأكثر
    level1_action: Mapped[PenaltyAction] = mapped_column(Enum(PenaltyAction), default=PenaltyAction.warning)
    level1_value: Mapped[float] = mapped_column(Float, default=0)
    level2_action: Mapped[PenaltyAction] = mapped_column(
        Enum(PenaltyAction), default=PenaltyAction.deduction_percent_day
    )
    level2_value: Mapped[float] = mapped_column(Float, default=5)
    level3_action: Mapped[PenaltyAction] = mapped_column(
        Enum(PenaltyAction), default=PenaltyAction.deduction_percent_day
    )
    level3_value: Mapped[float] = mapped_column(Float, default=10)
    level4_action: Mapped[PenaltyAction] = mapped_column(
        Enum(PenaltyAction), default=PenaltyAction.deduction_days
    )
    level4_value: Mapped[float] = mapped_column(Float, default=1)


class Violation(Base):
    """مخالفة مسجلة على موظف مع الجزاء المترتب عليها."""

    __tablename__ = "violations"

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    violation_type_id: Mapped[int] = mapped_column(ForeignKey("violation_types.id", ondelete="RESTRICT"))
    occurred_on: Mapped[date] = mapped_column(Date, index=True)
    description: Mapped[str | None] = mapped_column(Text)
    repetition_no: Mapped[int] = mapped_column(Integer, default=1)
    penalty_action: Mapped[PenaltyAction] = mapped_column(Enum(PenaltyAction), default=PenaltyAction.warning)
    penalty_value: Mapped[float] = mapped_column(Float, default=0)
    penalty_amount: Mapped[float] = mapped_column(Float, default=0)  # قيمة الخصم بالريال
    status: Mapped[ViolationStatus] = mapped_column(
        Enum(ViolationStatus), default=ViolationStatus.pending, index=True
    )
    reported_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    decided_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime)
    employee_note: Mapped[str | None] = mapped_column(Text)   # رد الموظف أو تظلّمه
    decision_note: Mapped[str | None] = mapped_column(Text)
    attachment_path: Mapped[str | None] = mapped_column(String(255))
    site_id: Mapped[int | None] = mapped_column(ForeignKey("work_sites.id", ondelete="SET NULL"))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    employee: Mapped[Employee] = relationship()
    violation_type: Mapped[ViolationType] = relationship()
    site: Mapped[WorkSite | None] = relationship()


class EmployeeDocument(Base):
    """وثيقة موظف (إقامة، جواز، عقد...) مع تاريخ الانتهاء للتنبيه."""

    __tablename__ = "employee_documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    doc_type: Mapped[str] = mapped_column(String(60))
    number: Mapped[str | None] = mapped_column(String(64))
    issue_date: Mapped[date | None] = mapped_column(Date)
    expiry_date: Mapped[date | None] = mapped_column(Date, index=True)
    file_path: Mapped[str | None] = mapped_column(String(255))
    note: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    employee: Mapped[Employee] = relationship()


class PayrollRun(Base):
    """مسير رواتب لشهر محدد."""

    __tablename__ = "payroll_runs"
    __table_args__ = (UniqueConstraint("year", "month", name="uq_payroll_period"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    year: Mapped[int] = mapped_column(Integer, index=True)
    month: Mapped[int] = mapped_column(Integer)
    status: Mapped[PayrollStatus] = mapped_column(Enum(PayrollStatus), default=PayrollStatus.draft)
    note: Mapped[str | None] = mapped_column(String(255))
    created_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)


class Payslip(Base):
    """قسيمة راتب موظف ضمن مسير."""

    __tablename__ = "payslips"
    __table_args__ = (UniqueConstraint("run_id", "employee_id", name="uq_payslip"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("payroll_runs.id", ondelete="CASCADE"), index=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id", ondelete="CASCADE"), index=True)
    basic_salary: Mapped[float] = mapped_column(Float, default=0)
    present_days: Mapped[int] = mapped_column(Integer, default=0)
    absent_days: Mapped[int] = mapped_column(Integer, default=0)
    paid_leave_days: Mapped[float] = mapped_column(Float, default=0)
    unpaid_leave_days: Mapped[float] = mapped_column(Float, default=0)
    late_minutes: Mapped[int] = mapped_column(Integer, default=0)
    overtime_minutes: Mapped[int] = mapped_column(Integer, default=0)
    absence_deduction: Mapped[float] = mapped_column(Float, default=0)
    late_deduction: Mapped[float] = mapped_column(Float, default=0)
    unpaid_leave_deduction: Mapped[float] = mapped_column(Float, default=0)
    violation_deduction: Mapped[float] = mapped_column(Float, default=0)
    overtime_amount: Mapped[float] = mapped_column(Float, default=0)
    other_additions: Mapped[float] = mapped_column(Float, default=0)
    other_deductions: Mapped[float] = mapped_column(Float, default=0)
    net_pay: Mapped[float] = mapped_column(Float, default=0)
    note: Mapped[str | None] = mapped_column(String(255))

    employee: Mapped[Employee] = relationship()
