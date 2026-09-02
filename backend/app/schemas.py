"""مخططات الإدخال والإخراج (Pydantic)."""
from __future__ import annotations

from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, Field

from .models import (
    DayStatus,
    DeviceMode,
    EmployeeStatus,
    LeaveStatus,
    PayrollStatus,
    PenaltyAction,
    PunchSource,
    PunchType,
    Role,
    ViolationStatus,
)


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ------------------------------ المصادقة ------------------------------
class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class UserOut(ORMModel):
    id: int
    username: str
    role: Role
    is_active: bool
    employee_id: int | None = None
    employee_name: str | None = None


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=6, max_length=128)
    role: Role = Role.employee
    employee_id: int | None = None


class UserUpdate(BaseModel):
    password: str | None = Field(default=None, min_length=6, max_length=128)
    role: Role | None = None
    is_active: bool | None = None
    employee_id: int | None = None


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=6, max_length=128)


# ------------------------------ الهيكل التنظيمي ------------------------------
class DepartmentIn(BaseModel):
    name: str
    manager_id: int | None = None


class DepartmentOut(ORMModel):
    id: int
    name: str
    manager_id: int | None = None
    employees_count: int = 0


class ShiftIn(BaseModel):
    name: str
    start_time: time
    end_time: time
    grace_in_minutes: int = 10
    grace_out_minutes: int = 10
    break_minutes: int = 0
    work_days: str = "6,0,1,2,3"
    is_night_shift: bool = False


class ShiftOut(ORMModel):
    id: int
    name: str
    start_time: time
    end_time: time
    grace_in_minutes: int
    grace_out_minutes: int
    break_minutes: int
    work_days: str
    is_night_shift: bool


# ------------------------------ الموظفون ------------------------------
class EmployeeIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    full_name: str = Field(min_length=2, max_length=160)
    national_id: str | None = None
    email: str | None = None
    phone: str | None = None
    job_title: str | None = None
    department_id: int | None = None
    shift_id: int | None = None
    site_id: int | None = None
    manager_id: int | None = None
    hire_date: date | None = None
    basic_salary: float = 0
    status: EmployeeStatus = EmployeeStatus.active


class EmployeeUpdate(BaseModel):
    code: str | None = None
    full_name: str | None = None
    national_id: str | None = None
    email: str | None = None
    phone: str | None = None
    job_title: str | None = None
    department_id: int | None = None
    shift_id: int | None = None
    site_id: int | None = None
    manager_id: int | None = None
    hire_date: date | None = None
    basic_salary: float | None = None
    status: EmployeeStatus | None = None


class EmployeeOut(ORMModel):
    id: int
    code: str
    full_name: str
    national_id: str | None = None
    email: str | None = None
    phone: str | None = None
    job_title: str | None = None
    department_id: int | None = None
    department_name: str | None = None
    shift_id: int | None = None
    shift_name: str | None = None
    site_id: int | None = None
    site_name: str | None = None
    manager_id: int | None = None
    hire_date: date | None = None
    basic_salary: float = 0
    status: EmployeeStatus
    has_user: bool = False


# ------------------------------ الحضور ------------------------------
class PunchIn(BaseModel):
    employee_id: int
    punch_time: datetime
    punch_type: PunchType = PunchType.auto
    note: str | None = None


class PunchOut(ORMModel):
    id: int
    employee_id: int | None = None
    employee_code: str
    employee_name: str | None = None
    punch_time: datetime
    punch_type: PunchType
    source: PunchSource
    device_id: int | None = None
    device_name: str | None = None
    verify_mode: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    accuracy_meters: float | None = None
    site_id: int | None = None
    site_name: str | None = None
    distance_meters: float | None = None
    note: str | None = None


class AttendanceDayOut(ORMModel):
    id: int | None = None
    employee_id: int
    employee_code: str | None = None
    employee_name: str | None = None
    work_date: date
    check_in: datetime | None = None
    check_out: datetime | None = None
    worked_minutes: int = 0
    late_minutes: int = 0
    early_leave_minutes: int = 0
    overtime_minutes: int = 0
    status: DayStatus
    punches_count: int = 0
    note: str | None = None


class SelfPunchIn(BaseModel):
    """تسجيل حضور ذاتي من التطبيق مع إحداثيات الموظف."""

    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    accuracy_meters: float | None = Field(default=None, ge=0)


class SelfPunchResult(BaseModel):
    ok: bool = True
    punch: PunchOut
    site_name: str | None = None
    distance_meters: float | None = None
    message: str = ""


class WorkSiteIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    radius_meters: int = Field(default=150, ge=20, le=20000)
    address: str | None = None
    is_active: bool = True


class WorkSiteUpdate(BaseModel):
    name: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    radius_meters: int | None = Field(default=None, ge=20, le=20000)
    address: str | None = None
    is_active: bool | None = None


class WorkSiteOut(ORMModel):
    id: int
    name: str
    latitude: float
    longitude: float
    radius_meters: int
    address: str | None = None
    is_active: bool
    employees_count: int = 0


class GeoCheckIn(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_meters: float | None = None


class GeoCheckOut(BaseModel):
    allowed: bool
    site_name: str | None = None
    distance_meters: float | None = None
    radius_meters: int | None = None
    message: str


class SettingsOut(BaseModel):
    web_punch_enabled: bool
    web_punch_requires_location: bool
    geo_max_accuracy_meters: int
    payroll_days_per_month: int = 30
    payroll_workday_hours: int = 8
    payroll_overtime_multiplier: float = 1.5
    payroll_late_deduction_mode: str = "proportional"
    payroll_absence_multiplier: float = 1
    violation_reset_days: int = 180
    document_alert_days: int = 30


class SettingsIn(BaseModel):
    web_punch_enabled: bool | None = None
    web_punch_requires_location: bool | None = None
    geo_max_accuracy_meters: int | None = Field(default=None, ge=10, le=5000)
    payroll_days_per_month: int | None = Field(default=None, ge=20, le=31)
    payroll_workday_hours: int | None = Field(default=None, ge=1, le=16)
    payroll_overtime_multiplier: float | None = Field(default=None, ge=1, le=3)
    payroll_late_deduction_mode: str | None = None
    payroll_absence_multiplier: float | None = Field(default=None, ge=0, le=3)
    violation_reset_days: int | None = Field(default=None, ge=30, le=730)
    document_alert_days: int | None = Field(default=None, ge=1, le=365)


class AttendanceOverride(BaseModel):
    check_in: datetime | None = None
    check_out: datetime | None = None
    status: DayStatus | None = None
    note: str | None = None


# ------------------------------ الإجازات ------------------------------
class LeaveTypeIn(BaseModel):
    code: str
    name: str
    annual_quota_days: float = 0
    is_paid: bool = True
    deducts_balance: bool = True
    exclude_weekends: bool = True
    exclude_holidays: bool = True
    requires_attachment: bool = False
    max_consecutive_days: int = 0
    color: str = "#2f7d6f"
    is_active: bool = True


class LeaveTypeOut(ORMModel):
    id: int
    code: str
    name: str
    annual_quota_days: float
    is_paid: bool
    deducts_balance: bool
    exclude_weekends: bool
    exclude_holidays: bool
    requires_attachment: bool
    max_consecutive_days: int
    color: str
    is_active: bool


class LeaveRequestIn(BaseModel):
    employee_id: int | None = None  # يُملأ تلقائياً للموظف مقدّم الطلب
    leave_type_id: int
    start_date: date
    end_date: date
    reason: str | None = None


class LeaveDecision(BaseModel):
    decision_note: str | None = None


class LeaveRequestOut(ORMModel):
    id: int
    employee_id: int
    employee_name: str | None = None
    employee_code: str | None = None
    leave_type_id: int
    leave_type_name: str | None = None
    start_date: date
    end_date: date
    days: float
    reason: str | None = None
    status: LeaveStatus
    attachment_path: str | None = None
    decided_at: datetime | None = None
    decision_note: str | None = None
    created_at: datetime | None = None


class LeaveBalanceOut(ORMModel):
    id: int | None = None
    employee_id: int
    employee_name: str | None = None
    leave_type_id: int
    leave_type_name: str | None = None
    year: int
    entitled_days: float
    carried_over_days: float
    used_days: float
    remaining_days: float = 0


class LeaveBalanceIn(BaseModel):
    employee_id: int
    leave_type_id: int
    year: int
    entitled_days: float
    carried_over_days: float = 0


class HolidayIn(BaseModel):
    holiday_date: date
    name: str


class HolidayOut(ORMModel):
    id: int
    holiday_date: date
    name: str


# ------------------------------ الأجهزة ------------------------------
class DeviceIn(BaseModel):
    name: str
    mode: DeviceMode = DeviceMode.pull
    ip: str | None = None
    port: int = 4370
    comm_password: int = 0
    timeout: int = 10
    force_udp: bool = False
    ommit_ping: bool = True
    serial_number: str | None = None
    location: str | None = None
    is_active: bool = True
    clear_after_sync: bool = False


class DeviceUpdate(BaseModel):
    name: str | None = None
    mode: DeviceMode | None = None
    ip: str | None = None
    port: int | None = None
    comm_password: int | None = None
    timeout: int | None = None
    force_udp: bool | None = None
    ommit_ping: bool | None = None
    serial_number: str | None = None
    location: str | None = None
    is_active: bool | None = None
    clear_after_sync: bool | None = None


class DeviceOut(ORMModel):
    id: int
    name: str
    mode: DeviceMode
    ip: str | None = None
    port: int
    serial_number: str | None = None
    location: str | None = None
    is_active: bool
    clear_after_sync: bool
    last_sync_at: datetime | None = None
    last_status: str | None = None


class DeviceTestResult(BaseModel):
    ok: bool
    message: str
    info: dict = {}


class SyncResult(BaseModel):
    ok: bool
    device_id: int | None = None
    device_name: str | None = None
    fetched: int = 0
    imported: int = 0
    duplicates: int = 0
    unknown_codes: list[str] = []
    recomputed_days: int = 0
    message: str = ""


class DeviceUserOut(BaseModel):
    user_id: str
    name: str
    privilege: int = 0
    card: str | None = None
    exists_in_system: bool = False


# ------------------------------ التقارير ------------------------------
class DashboardStats(BaseModel):
    date: date
    employees_total: int
    present: int
    late: int
    absent: int
    on_leave: int
    pending_leaves: int
    devices_online: int
    devices_total: int
    weekly_trend: list[dict] = []


class MonthlySummaryRow(BaseModel):
    employee_id: int
    employee_code: str
    employee_name: str
    department_name: str | None = None
    present_days: int = 0
    late_days: int = 0
    absent_days: int = 0
    leave_days: int = 0
    holiday_days: int = 0
    weekend_days: int = 0
    worked_hours: float = 0
    late_minutes: int = 0
    early_leave_minutes: int = 0
    overtime_minutes: int = 0


Token.model_rebuild()


# ------------------------------ الإشعارات وسجل التدقيق ------------------------------
class NotificationOut(ORMModel):
    id: int
    title: str
    body: str | None = None
    category: str
    link_page: str | None = None
    is_read: bool
    created_at: datetime | None = None


class AuditLogOut(BaseModel):
    id: int
    user_id: int | None = None
    username: str | None = None
    action: str
    action_label: str
    entity: str
    entity_label: str
    entity_id: str | None = None
    detail: str | None = None
    created_at: datetime | None = None


# ------------------------------ المخالفات والجزاءات ------------------------------
class ViolationTypeIn(BaseModel):
    code: str
    name: str
    category: str = "سلوك عام"
    description: str | None = None
    is_active: bool = True
    level1_action: PenaltyAction = PenaltyAction.warning
    level1_value: float = 0
    level2_action: PenaltyAction = PenaltyAction.deduction_percent_day
    level2_value: float = 5
    level3_action: PenaltyAction = PenaltyAction.deduction_percent_day
    level3_value: float = 10
    level4_action: PenaltyAction = PenaltyAction.deduction_days
    level4_value: float = 1


class ViolationTypeOut(ORMModel):
    id: int
    code: str
    name: str
    category: str
    description: str | None = None
    is_active: bool
    level1_action: PenaltyAction
    level1_value: float
    level2_action: PenaltyAction
    level2_value: float
    level3_action: PenaltyAction
    level3_value: float
    level4_action: PenaltyAction
    level4_value: float


class ViolationIn(BaseModel):
    employee_id: int
    violation_type_id: int
    occurred_on: date
    description: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    site_id: int | None = None


class ViolationDecision(BaseModel):
    note: str | None = None


class ViolationOut(ORMModel):
    id: int
    employee_id: int
    employee_code: str | None = None
    employee_name: str | None = None
    violation_type_id: int
    violation_type_name: str | None = None
    category: str | None = None
    occurred_on: date
    description: str | None = None
    repetition_no: int
    penalty_action: PenaltyAction
    penalty_action_label: str | None = None
    penalty_value: float
    penalty_amount: float
    status: ViolationStatus
    status_label: str | None = None
    employee_note: str | None = None
    decision_note: str | None = None
    attachment_path: str | None = None
    site_id: int | None = None
    latitude: float | None = None
    longitude: float | None = None
    created_at: datetime | None = None


class ViolationPreview(BaseModel):
    repetition_no: int
    penalty_action: str
    penalty_action_label: str
    penalty_value: float
    penalty_amount: float
    daily_wage: float


# ------------------------------ وثائق الموظفين ------------------------------
class DocumentIn(BaseModel):
    employee_id: int
    doc_type: str
    number: str | None = None
    issue_date: date | None = None
    expiry_date: date | None = None
    note: str | None = None


class DocumentOut(ORMModel):
    id: int
    employee_id: int
    employee_name: str | None = None
    employee_code: str | None = None
    doc_type: str
    number: str | None = None
    issue_date: date | None = None
    expiry_date: date | None = None
    file_path: str | None = None
    note: str | None = None
    days_left: int | None = None


class ImportReport(BaseModel):
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: list[str] = []
    message: str = ""


# ------------------------------ الرواتب ------------------------------
class PayrollRunOut(ORMModel):
    id: int
    year: int
    month: int
    status: PayrollStatus
    note: str | None = None
    created_at: datetime | None = None
    approved_at: datetime | None = None
    employees: int = 0
    basic_total: float = 0
    deductions_total: float = 0
    overtime_total: float = 0
    net_total: float = 0


class PayslipOut(ORMModel):
    id: int
    run_id: int
    employee_id: int
    employee_code: str | None = None
    employee_name: str | None = None
    department_name: str | None = None
    basic_salary: float
    present_days: int
    absent_days: int
    paid_leave_days: float
    unpaid_leave_days: float
    late_minutes: int
    overtime_minutes: int
    absence_deduction: float
    late_deduction: float
    unpaid_leave_deduction: float
    violation_deduction: float
    overtime_amount: float
    other_additions: float
    other_deductions: float
    net_pay: float
    note: str | None = None


class PayslipAdjust(BaseModel):
    other_additions: float | None = None
    other_deductions: float | None = None
    note: str | None = None
