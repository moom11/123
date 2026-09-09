"""مخططات الإدخال والإخراج (Pydantic)."""
from __future__ import annotations

from datetime import date, datetime, time

from pydantic import BaseModel, ConfigDict, Field

from .models import (
    DayStatus,
    DeviceMode,
    EmployeeStatus,
    LeaveStatus,
    LoanStatus,
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
    must_change_password: bool = False


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
    allowances: float = 0
    weekly_rest_days: str | None = None
    no_break: bool = False
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
    allowances: float | None = None
    weekly_rest_days: str | None = None
    no_break: bool | None = None
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
    allowances: float = 0
    total_salary: float = 0
    weekly_rest_days: str | None = None
    no_break: bool = False
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
    presence_minutes: int = 0
    break_minutes: int = 0
    break_count: int = 0
    break_overrun_minutes: int = 0
    open_break: bool = False
    breaks: list["BreakOut"] = []
    note: str | None = None


class BreakOut(ORMModel):
    """استراحة واحدة بمدتها."""

    sequence: int
    start_at: datetime
    end_at: datetime | None = None
    minutes: int = 0
    is_open: bool = False


class AttendanceEventOut(ORMModel):
    """حدث حضور مُفسَّر بكل بياناته."""

    id: int
    employee_id: int
    employee_code: str
    employee_name: str
    work_date: date
    event_time: datetime
    received_at: datetime | None = None
    event_type: str
    event_label: str = ""
    state_before: str
    state_after: str
    state_after_label: str = ""
    source: str
    device_name: str | None = None
    site_name: str | None = None
    shift_name: str | None = None
    note: str | None = None


class LiveStatusOut(BaseModel):
    """حالة موظف الآن للوحة الإدارة."""

    employee_id: int
    employee_name: str
    employee_code: str
    site_name: str | None = None
    shift_name: str | None = None
    state: str                      # out | in | break
    state_label: str
    since: datetime | None = None   # منذ متى في هذه الحالة
    since_minutes: int = 0
    check_in: datetime | None = None
    check_out: datetime | None = None
    break_minutes: int = 0
    break_count: int = 0
    break_overrun_minutes: int = 0
    open_break: bool = False
    needs_review: bool = False


class SelfPunchIn(BaseModel):
    """تسجيل حضور ذاتي من التطبيق مع إحداثيات الموظف."""

    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    accuracy_meters: float | None = Field(default=None, ge=0)
    # نية صريحة من الزر: clock_in / break_start / break_end / clock_out
    # وإن تُركت فارغة يستنتجها النظام من حالة الموظف
    intent: str | None = Field(default=None, pattern="^(clock_in|break_start|break_end|clock_out)$")


class SelfPunchResult(BaseModel):
    ok: bool = True
    punch: PunchOut
    site_name: str | None = None
    distance_meters: float | None = None
    kind: str = ""          # حضور / بدء استراحة / عودة من الاستراحة / انصراف
    time_label: str = ""    # 08:57 ص
    message: str = ""
    state: str = "out"      # حالة الموظف بعد البصمة
    state_label: str = ""


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
    payroll_deduction_base: str = "total"
    violation_reset_days: int = 180
    document_alert_days: int = 30
    push_enabled: bool = True
    auto_account_on_phone: bool = True
    monthly_rest_quota: int = 4
    show_leave_balance_to_employee: bool = False
    attendance_alert_enabled: bool = True
    attendance_alert_after_minutes: int = 60
    attendance_alert_notify_employee: bool = True
    # سياسة الحضور والاستراحة الافتراضية
    break_allowance_minutes: int = 60
    break_grace_minutes: int = 5
    break_max_count: int = 0
    break_max_total_minutes: int = 0
    break_deducted: bool = True
    clock_out_from_minutes: int = 30
    early_leave_grace_minutes: int = 10
    late_grace_minutes: int = 10
    punch_debounce_seconds: int = 20
    break_violation_enabled: bool = True
    break_violation_after_minutes: int = 15
    break_alert_employee: bool = True


class SettingsIn(BaseModel):
    web_punch_enabled: bool | None = None
    web_punch_requires_location: bool | None = None
    geo_max_accuracy_meters: int | None = Field(default=None, ge=10, le=5000)
    payroll_days_per_month: int | None = Field(default=None, ge=20, le=31)
    payroll_workday_hours: int | None = Field(default=None, ge=1, le=16)
    payroll_overtime_multiplier: float | None = Field(default=None, ge=1, le=3)
    payroll_late_deduction_mode: str | None = None
    payroll_absence_multiplier: float | None = Field(default=None, ge=0, le=3)
    payroll_deduction_base: str | None = None
    violation_reset_days: int | None = Field(default=None, ge=30, le=730)
    document_alert_days: int | None = Field(default=None, ge=1, le=365)
    push_enabled: bool | None = None
    auto_account_on_phone: bool | None = None
    monthly_rest_quota: int | None = Field(default=None, ge=0, le=15)
    show_leave_balance_to_employee: bool | None = None
    attendance_alert_enabled: bool | None = None
    attendance_alert_after_minutes: int | None = Field(default=None, ge=5, le=600)
    attendance_alert_notify_employee: bool | None = None
    break_allowance_minutes: int | None = Field(default=None, ge=0, le=600)
    break_grace_minutes: int | None = Field(default=None, ge=0, le=120)
    break_max_count: int | None = Field(default=None, ge=0, le=20)
    break_max_total_minutes: int | None = Field(default=None, ge=0, le=600)
    break_deducted: bool | None = None
    clock_out_from_minutes: int | None = Field(default=None, ge=0, le=480)
    early_leave_grace_minutes: int | None = Field(default=None, ge=0, le=240)
    late_grace_minutes: int | None = Field(default=None, ge=0, le=240)
    punch_debounce_seconds: int | None = Field(default=None, ge=0, le=300)
    break_violation_enabled: bool | None = None
    break_violation_after_minutes: int | None = Field(default=None, ge=1, le=240)
    break_alert_employee: bool | None = None


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
    accounts_created: int = 0
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
    allowances_total: float = 0
    loans_total: float = 0
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
    allowances: float = 0
    loan_deduction: float = 0
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


class LoanIn(BaseModel):
    employee_id: int
    amount: float = Field(gt=0)
    installment_amount: float = Field(gt=0)
    start_year: int = Field(ge=2000, le=2100)
    start_month: int = Field(ge=1, le=12)
    reason: str | None = None


class LoanUpdate(BaseModel):
    installment_amount: float | None = Field(default=None, gt=0)
    reason: str | None = None
    status: LoanStatus | None = None


class LoanOut(ORMModel):
    id: int
    employee_id: int
    employee_code: str | None = None
    employee_name: str | None = None
    amount: float
    installment_amount: float
    start_year: int
    start_month: int
    reason: str | None = None
    status: LoanStatus
    months: int = 0
    paid_amount: float = 0
    remaining_amount: float = 0
    last_installment: str | None = None
    created_at: datetime | None = None


class MyProfileIn(BaseModel):
    """ما يسمح للموظف بتحديثه في بياناته بنفسه."""

    national_id: str | None = Field(default=None, max_length=32)
    phone: str | None = Field(default=None, max_length=32)
    email: str | None = Field(default=None, max_length=160)


class MyProfileOut(ORMModel):
    employee_id: int
    code: str
    full_name: str
    job_title: str | None = None
    department_name: str | None = None
    shift_name: str | None = None
    site_name: str | None = None
    hire_date: date | None = None
    national_id: str | None = None
    phone: str | None = None
    email: str | None = None
    weekly_rest_days: str | None = None
    basic_salary: float = 0
    allowances: float = 0
    total_salary: float = 0


class RestDayIn(BaseModel):
    employee_id: int
    rest_date: date
    note: str | None = None


class RestDayOut(ORMModel):
    id: int
    employee_id: int
    employee_name: str | None = None
    employee_code: str | None = None
    rest_date: date
    note: str | None = None


class RestSummaryRow(BaseModel):
    employee_id: int
    employee_code: str
    employee_name: str
    used: int = 0
    quota: int = 0
    remaining: int = 0
    dates: list[date] = []


class HomeDay(BaseModel):
    date: date
    weekday: str
    status: DayStatus | None = None
    label: str = ""
    shift_label: str | None = None
    check_in: datetime | None = None
    check_out: datetime | None = None
    is_today: bool = False


class MyHomeOut(BaseModel):
    employee_name: str
    job_title: str | None = None
    state: str = "out"              # in | break | out | done | off
    state_label: str = ""           # أنت الآن داخل العمل / في استراحة / خارج العمل
    state_detail: str = ""          # وقت بداية العمل أو بداية الاستراحة أو آخر انصراف
    action: str = "in"              # in | break_start | break_end | out | none
    action_label: str = ""
    secondary_action: str | None = None      # زر ثانٍ (انصراف أثناء العمل مثلاً)
    secondary_action_label: str | None = None
    break_started_at: datetime | None = None
    break_elapsed_minutes: int = 0           # مدة الاستراحة الجارية الآن
    break_minutes: int = 0                   # إجمالي استراحات اليوم
    break_count: int = 0
    break_allowance_minutes: int = 60
    break_overrun_minutes: int = 0
    today_status: DayStatus | None = None
    check_in: datetime | None = None
    check_out: datetime | None = None
    late_minutes: int = 0
    worked_minutes: int = 0
    shift_name: str | None = None
    shift_label: str | None = None
    is_workday: bool = True
    site_name: str | None = None
    requires_location: bool = True
    punch_enabled: bool = True
    last_punch_at: datetime | None = None
    last_punch_kind: str | None = None
    last_punch_site: str | None = None
    pending_requests: int = 0
    alert: str | None = None
    week: list[HomeDay] = []


class PushSubscriptionIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=500)
    p256dh: str = Field(min_length=10, max_length=255)
    auth: str = Field(min_length=4, max_length=255)
    user_agent: str | None = None


class PayslipAdjust(BaseModel):
    other_additions: float | None = None
    other_deductions: float | None = None
    note: str | None = None
