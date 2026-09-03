"""اختبارات شاملة لمسارات النظام: المصادقة، الحضور، الإجازات، وبروتوكول iclock."""
from __future__ import annotations

import os
import sys
import tempfile
from datetime import date, datetime, time, timedelta
from pathlib import Path

import pytest

TMP = tempfile.mkdtemp(prefix="hr_test_")
os.environ["HR_DATA_DIR"] = TMP
# افتراضياً SQLite؛ ولتشغيل نفس الاختبارات على PostgreSQL:
#   HR_DATABASE_URL="postgresql+psycopg://user:pass@localhost/hr_test" pytest backend/tests
os.environ.setdefault("HR_DATABASE_URL", f"sqlite:///{Path(TMP) / 'test.db'}")
os.environ["HR_ADMIN_PASSWORD"] = "admin123"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import DayStatus, Employee, Shift  # noqa: E402
from app.seed import init_db  # noqa: E402


@pytest.fixture(scope="session")
def client():
    init_db()
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def admin_token(client):
    res = client.post("/api/auth/login", data={"username": "admin", "password": "admin123"})
    assert res.status_code == 200, res.text
    return res.json()["access_token"]


@pytest.fixture(scope="session")
def auth(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_login_rejects_bad_password(client):
    res = client.post("/api/auth/login", data={"username": "admin", "password": "wrong"})
    assert res.status_code == 401


def test_requires_token(client):
    assert client.get("/api/employees").status_code == 401


def test_create_employee_and_shift(client, auth):
    shift = client.post("/api/shifts", headers=auth, json={
        "name": "وردية الاختبار", "start_time": "08:00:00", "end_time": "16:00:00",
        "grace_in_minutes": 10, "grace_out_minutes": 10, "work_days": "6,0,1,2,3",
    })
    assert shift.status_code == 201, shift.text
    res = client.post("/api/employees", headers=auth, json={
        "code": "9001", "full_name": "موظف الاختبار", "shift_id": shift.json()["id"],
        "hire_date": "2024-01-01",
    })
    assert res.status_code == 201, res.text
    assert res.json()["code"] == "9001"
    dup = client.post("/api/employees", headers=auth, json={"code": "9001", "full_name": "مكرر"})
    assert dup.status_code == 400


def _employee_id(client, auth, code="9001"):
    rows = client.get("/api/employees", headers=auth).json()
    return next(r["id"] for r in rows if r["code"] == code)


def test_manual_punch_creates_attendance(client, auth):
    emp_id = _employee_id(client, auth)
    # اختيار يوم عمل (الأحد) قريب
    day = date.today()
    while day.weekday() != 6:
        day -= timedelta(days=1)
    for hhmm in ("08:25:00", "16:10:00"):
        res = client.post("/api/attendance/punches", headers=auth, json={
            "employee_id": emp_id, "punch_time": f"{day}T{hhmm}"})
        assert res.status_code == 201, res.text
    rows = client.get(
        f"/api/attendance/employee/{emp_id}?date_from={day}&date_to={day}", headers=auth
    ).json()
    assert len(rows) == 1
    row = rows[0]
    assert row["status"] == DayStatus.late.value       # 08:25 مع سماح 10 دقائق = تأخير
    assert row["late_minutes"] == 25
    assert row["worked_minutes"] == 465                # من 08:25 حتى 16:10
    assert row["overtime_minutes"] == 0                # 10 دقائق ضمن حد السماح


def test_duplicate_manual_punch_rejected(client, auth):
    emp_id = _employee_id(client, auth)
    day = date.today()
    while day.weekday() != 6:
        day -= timedelta(days=1)
    res = client.post("/api/attendance/punches", headers=auth, json={
        "employee_id": emp_id, "punch_time": f"{day}T08:25:00"})
    assert res.status_code == 400


def test_iclock_push_flow(client, auth):
    """محاكاة جهاز ZKTeco يعمل بوضع الدفع ADMS."""
    sn = "TEST-SN-123"
    handshake = client.get(f"/iclock/cdata?SN={sn}&options=all")
    assert handshake.status_code == 200
    assert "GET OPTION FROM" in handshake.text

    day = date.today()
    while day.weekday() != 6:
        day -= timedelta(days=1)
    day = day - timedelta(days=7)
    body = f"9001\t{day} 07:55:00\t0\t1\t0\n9001\t{day} 16:30:00\t1\t1\t0\n"
    res = client.post(f"/iclock/cdata?SN={sn}&table=ATTLOG", content=body)
    assert res.status_code == 200
    assert res.text.startswith("OK")

    # إعادة الإرسال لا تكرر السجلات
    again = client.post(f"/iclock/cdata?SN={sn}&table=ATTLOG", content=body)
    assert again.text == "OK: 0"

    emp_id = _employee_id(client, auth)
    rows = client.get(
        f"/api/attendance/employee/{emp_id}?date_from={day}&date_to={day}", headers=auth
    ).json()
    assert rows[0]["status"] == DayStatus.present.value
    assert rows[0]["overtime_minutes"] == 30

    devices = client.get("/api/devices", headers=auth).json()
    assert any(d["serial_number"] == sn and d["mode"] == "push" for d in devices)


def test_absent_on_workday_without_punches(client, auth):
    emp_id = _employee_id(client, auth)
    day = date.today() - timedelta(days=30)
    while day.weekday() != 6:
        day -= timedelta(days=1)
    rows = client.get(
        f"/api/attendance/employee/{emp_id}?date_from={day}&date_to={day}", headers=auth
    ).json()
    assert rows[0]["status"] == DayStatus.absent.value


def test_weekend_status(client, auth):
    emp_id = _employee_id(client, auth)
    day = date.today() - timedelta(days=30)
    while day.weekday() != 4:  # الجمعة
        day -= timedelta(days=1)
    rows = client.get(
        f"/api/attendance/employee/{emp_id}?date_from={day}&date_to={day}", headers=auth
    ).json()
    assert rows[0]["status"] == DayStatus.weekend.value


def test_leave_workflow_and_balance(client, auth):
    emp_id = _employee_id(client, auth)
    types = client.get("/api/leave-types", headers=auth).json()
    annual = next(t for t in types if t["code"] == "annual")

    start = date.today() + timedelta(days=10)
    end = start + timedelta(days=2)
    preview = client.post("/api/leave-requests/preview", headers=auth, json={
        "employee_id": emp_id, "leave_type_id": annual["id"],
        "start_date": str(start), "end_date": str(end)}).json()
    assert preview["days"] == 3

    created = client.post("/api/leave-requests", headers=auth, json={
        "employee_id": emp_id, "leave_type_id": annual["id"],
        "start_date": str(start), "end_date": str(end), "reason": "ظروف عائلية"})
    assert created.status_code == 201, created.text
    req = created.json()
    assert req["days"] == 3 and req["status"] == "pending"

    # التعارض مرفوض
    overlap = client.post("/api/leave-requests", headers=auth, json={
        "employee_id": emp_id, "leave_type_id": annual["id"],
        "start_date": str(start), "end_date": str(end)})
    assert overlap.status_code == 400

    approved = client.post(f"/api/leave-requests/{req['id']}/approve", headers=auth,
                           json={"decision_note": "موافق"})
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"

    balances = client.get(f"/api/leave-balances?employee_id={emp_id}", headers=auth).json()
    annual_balance = next(b for b in balances if b["leave_type_id"] == annual["id"])
    assert annual_balance["used_days"] == 3
    assert annual_balance["remaining_days"] == annual_balance["entitled_days"] - 3

    rows = client.get(
        f"/api/attendance/employee/{emp_id}?date_from={start}&date_to={start}", headers=auth
    ).json()
    assert rows[0]["status"] == DayStatus.leave.value

    # الإلغاء يعيد الرصيد
    cancelled = client.post(f"/api/leave-requests/{req['id']}/cancel", headers=auth)
    assert cancelled.status_code == 200
    balances = client.get(f"/api/leave-balances?employee_id={emp_id}", headers=auth).json()
    annual_balance = next(b for b in balances if b["leave_type_id"] == annual["id"])
    assert annual_balance["used_days"] == 0


def test_insufficient_balance_rejected(client, auth):
    emp_id = _employee_id(client, auth)
    types = client.get("/api/leave-types", headers=auth).json()
    emergency = next(t for t in types if t["code"] == "emergency")  # الرصيد 5 أيام
    start = date.today() + timedelta(days=60)
    res = client.post("/api/leave-requests", headers=auth, json={
        "employee_id": emp_id, "leave_type_id": emergency["id"],
        "start_date": str(start), "end_date": str(start + timedelta(days=20))})
    assert res.status_code == 400
    assert "الرصيد" in res.json()["detail"]


def test_holiday_marks_day(client, auth):
    emp_id = _employee_id(client, auth)
    day = date.today() - timedelta(days=45)
    while day.weekday() != 6:
        day -= timedelta(days=1)
    res = client.post("/api/holidays", headers=auth, json={"holiday_date": str(day), "name": "عطلة اختبار"})
    assert res.status_code == 201
    rows = client.get(
        f"/api/attendance/employee/{emp_id}?date_from={day}&date_to={day}", headers=auth
    ).json()
    assert rows[0]["status"] == DayStatus.holiday.value


def test_demo_device_sync(client, auth):
    device = client.post("/api/devices", headers=auth, json={
        "name": "جهاز تجريبي", "mode": "demo", "serial_number": "DEMO-TEST"}).json()
    res = client.post(f"/api/devices/{device['id']}/sync", headers=auth)
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["ok"] and data["imported"] > 0
    # المزامنة الثانية لا تكرر
    again = client.post(f"/api/devices/{device['id']}/sync", headers=auth).json()
    assert again["imported"] == 0 and again["duplicates"] > 0


def test_pull_device_requires_ip(client, auth):
    res = client.post("/api/devices", headers=auth, json={"name": "بلا IP", "mode": "pull"})
    assert res.status_code == 400


def test_dashboard_and_reports(client, auth):
    stats = client.get("/api/reports/dashboard", headers=auth).json()
    assert stats["employees_total"] >= 1
    monthly = client.get("/api/reports/monthly", headers=auth).json()
    assert isinstance(monthly, list)
    csv_res = client.get("/api/reports/monthly-export.csv", headers=auth)
    assert csv_res.status_code == 200
    assert "text/csv" in csv_res.headers["content-type"]


def test_employee_role_scope(client, auth):
    """الموظف يرى نفسه فقط ولا يستطيع إدارة الموظفين."""
    emp = client.post("/api/employees", headers=auth, json={
        "code": "9002", "full_name": "موظف محدود"}).json()
    client.post("/api/users", headers=auth, json={
        "username": "emp9002", "password": "Aa123456", "role": "employee", "employee_id": emp["id"]})
    token = client.post("/api/auth/login", data={"username": "emp9002", "password": "Aa123456"}).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    rows = client.get("/api/employees", headers=h).json()
    assert [r["code"] for r in rows] == ["9002"]
    denied = client.post("/api/employees", headers=h, json={"code": "9003", "full_name": "مرفوض"})
    assert denied.status_code == 403
    other_id = _employee_id(client, auth, "9001")
    assert client.get(f"/api/employees/{other_id}", headers=h).status_code == 403
    # البصم الذاتي من التطبيق مرفوض بدون إحداثيات الموقع (يُختبر بالتفصيل لاحقاً)
    punch = client.post("/api/attendance/self-punch", headers=h, json={})
    assert punch.status_code == 400


def test_night_shift_spans_midnight(client, auth):
    shift = client.post("/api/shifts", headers=auth, json={
        "name": "وردية ليلية", "start_time": "22:00:00", "end_time": "06:00:00",
        "grace_in_minutes": 10, "grace_out_minutes": 10, "work_days": "0,1,2,3,4,5,6",
        "is_night_shift": True}).json()
    emp = client.post("/api/employees", headers=auth, json={
        "code": "9100", "full_name": "موظف ليلي", "shift_id": shift["id"]}).json()
    day = date.today() - timedelta(days=3)
    client.post("/api/attendance/punches", headers=auth, json={
        "employee_id": emp["id"], "punch_time": f"{day}T21:55:00"})
    client.post("/api/attendance/punches", headers=auth, json={
        "employee_id": emp["id"], "punch_time": f"{day + timedelta(days=1)}T06:05:00"})
    rows = client.get(
        f"/api/attendance/employee/{emp['id']}?date_from={day}&date_to={day}", headers=auth
    ).json()
    assert rows[0]["status"] == DayStatus.present.value
    assert rows[0]["worked_minutes"] == 490


# ------------------------------ الحضور الذاتي بالموقع الجغرافي ------------------------------
HQ_LAT, HQ_LNG = 24.774265, 46.738586  # مقر تجريبي في الرياض


def _emp_token(client, auth, code, username):
    """ينشئ موظفاً وحساباً له ويعيد ترويسة المصادقة ومعرّف الموظف."""
    emp = client.post("/api/employees", headers=auth, json={
        "code": code, "full_name": f"موظف {code}"}).json()
    client.post("/api/users", headers=auth, json={
        "username": username, "password": "Aa123456", "role": "employee", "employee_id": emp["id"]})
    token = client.post(
        "/api/auth/login", data={"username": username, "password": "Aa123456"}
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}, emp["id"]


def test_create_work_site(client, auth):
    res = client.post("/api/sites", headers=auth, json={
        "name": "المقر الرئيسي", "latitude": HQ_LAT, "longitude": HQ_LNG,
        "radius_meters": 150, "address": "الرياض"})
    assert res.status_code == 201, res.text
    assert res.json()["radius_meters"] == 150
    dup = client.post("/api/sites", headers=auth, json={
        "name": "المقر الرئيسي", "latitude": HQ_LAT, "longitude": HQ_LNG})
    assert dup.status_code == 400


def test_self_punch_requires_location(client, auth):
    h, _ = _emp_token(client, auth, "9200", "geo_none")
    res = client.post("/api/attendance/self-punch", headers=h, json={})
    assert res.status_code == 400
    assert "الموقع الجغرافي" in res.json()["detail"]


def test_self_punch_inside_site_accepted(client, auth):
    h, emp_id = _emp_token(client, auth, "9201", "geo_in")
    res = client.post("/api/attendance/self-punch", headers=h, json={
        "latitude": HQ_LAT + 0.0003, "longitude": HQ_LNG, "accuracy_meters": 12})
    assert res.status_code == 201, res.text
    data = res.json()
    assert data["site_name"] == "المقر الرئيسي"
    assert data["distance_meters"] < 150
    assert data["punch"]["source"] == "web"
    assert data["punch"]["latitude"] is not None
    # البصمة مسجلة فعلياً مع الموقع
    punches = client.get(f"/api/attendance/punches?employee_id={emp_id}", headers=auth).json()
    assert punches[0]["site_name"] == "المقر الرئيسي"
    assert punches[0]["distance_meters"] is not None


def test_self_punch_outside_site_rejected(client, auth):
    h, _ = _emp_token(client, auth, "9202", "geo_out")
    res = client.post("/api/attendance/self-punch", headers=h, json={
        "latitude": HQ_LAT + 0.02, "longitude": HQ_LNG, "accuracy_meters": 10})  # ~2 كم
    assert res.status_code == 403
    assert "خارج نطاق" in res.json()["detail"]


def test_self_punch_low_accuracy_rejected(client, auth):
    h, _ = _emp_token(client, auth, "9203", "geo_acc")
    res = client.post("/api/attendance/self-punch", headers=h, json={
        "latitude": HQ_LAT, "longitude": HQ_LNG, "accuracy_meters": 900})
    assert res.status_code == 400
    assert "دقة تحديد الموقع" in res.json()["detail"]


def test_employee_bound_to_specific_site(client, auth):
    """موظف مرتبط بموقع محدد لا يُقبل بصمه من موقع آخر."""
    branch = client.post("/api/sites", headers=auth, json={
        "name": "فرع الشمال", "latitude": HQ_LAT + 0.05, "longitude": HQ_LNG,
        "radius_meters": 120}).json()
    h, emp_id = _emp_token(client, auth, "9204", "geo_branch")
    client.patch(f"/api/employees/{emp_id}", headers=auth, json={"site_id": branch["id"]})

    at_hq = client.post("/api/attendance/self-punch", headers=h, json={
        "latitude": HQ_LAT, "longitude": HQ_LNG, "accuracy_meters": 10})
    assert at_hq.status_code == 403

    at_branch = client.post("/api/attendance/self-punch", headers=h, json={
        "latitude": branch["latitude"], "longitude": branch["longitude"], "accuracy_meters": 10})
    assert at_branch.status_code == 201
    assert at_branch.json()["site_name"] == "فرع الشمال"


def test_geo_check_endpoint(client, auth):
    h, _ = _emp_token(client, auth, "9205", "geo_check")
    inside = client.post("/api/sites/check", headers=h, json={
        "latitude": HQ_LAT, "longitude": HQ_LNG, "accuracy_meters": 10}).json()
    assert inside["allowed"] is True and inside["site_name"] == "المقر الرئيسي"
    outside = client.post("/api/sites/check", headers=h, json={
        "latitude": HQ_LAT + 0.3, "longitude": HQ_LNG}).json()
    assert outside["allowed"] is False and outside["distance_meters"] > 1000


def test_settings_toggle_disables_geofence(client, auth):
    h, _ = _emp_token(client, auth, "9206", "geo_toggle")
    assert client.get("/api/settings", headers=h).json()["web_punch_requires_location"] is True

    # الموظف لا يملك صلاحية تعديل الإعدادات
    assert client.put("/api/settings", headers=h, json={"web_punch_enabled": False}).status_code == 403

    client.put("/api/settings", headers=auth, json={"web_punch_requires_location": False})
    res = client.post("/api/attendance/self-punch", headers=h, json={})
    assert res.status_code == 201, res.text

    # تعطيل البصم من التطبيق كلياً
    client.put("/api/settings", headers=auth, json={"web_punch_enabled": False})
    h2, _ = _emp_token(client, auth, "9207", "geo_off")
    blocked = client.post("/api/attendance/self-punch", headers=h2, json={})
    assert blocked.status_code == 403 and "معطّل" in blocked.json()["detail"]

    # إعادة الإعدادات الافتراضية
    client.put("/api/settings", headers=auth, json={
        "web_punch_enabled": True, "web_punch_requires_location": True})
    assert client.get("/api/settings", headers=auth).json()["web_punch_requires_location"] is True


def test_distance_formula_accuracy():
    """التحقق من صيغة هافرساين مقابل مسافة معروفة (الرياض - جدة ≈ 845 كم)."""
    from app.services.geo import distance_meters

    riyadh = (24.7136, 46.6753)
    jeddah = (21.4858, 39.1925)
    km = distance_meters(*riyadh, *jeddah) / 1000
    assert 840 <= km <= 860
    assert distance_meters(24.7136, 46.6753, 24.7136, 46.6753) == 0


# ------------------------------ المخالفات والجزاءات ------------------------------
def test_default_violation_types_seeded(client, auth):
    types = client.get("/api/violation-types", headers=auth).json()
    codes = {t["code"] for t in types}
    assert {"dress_code", "hygiene", "workplace_absence"} <= codes
    dress = next(t for t in types if t["code"] == "dress_code")
    assert dress["level1_action"] == "warning"
    assert dress["level2_action"] == "deduction_percent_day"


def test_violation_escalating_penalties(client, auth):
    """أول مخالفة إنذار، والثانية والثالثة خصم نسبة من أجر يوم، والرابعة خصم يوم."""
    emp = client.post("/api/employees", headers=auth, json={
        "code": "9300", "full_name": "موظف المخالفات", "basic_salary": 9000}).json()
    types = client.get("/api/violation-types", headers=auth).json()
    hygiene = next(t for t in types if t["code"] == "hygiene")
    daily_wage = 9000 / 30  # 300 ريال

    expected = [
        ("warning", 0.0),
        ("deduction_percent_day", round(daily_wage * 0.05, 2)),
        ("deduction_percent_day", round(daily_wage * 0.10, 2)),
        ("deduction_days", round(daily_wage * 0.5, 2)),
        ("deduction_days", round(daily_wage * 0.5, 2)),  # الخامسة تأخذ مستوى الرابعة
    ]
    for index, (action, amount) in enumerate(expected):
        day = date.today() - timedelta(days=30 - index)
        preview = client.post("/api/violations/preview", headers=auth, json={
            "employee_id": emp["id"], "violation_type_id": hygiene["id"],
            "occurred_on": str(day)}).json()
        assert preview["repetition_no"] == index + 1
        assert preview["penalty_action"] == action
        assert preview["penalty_amount"] == amount

        created = client.post("/api/violations", headers=auth, json={
            "employee_id": emp["id"], "violation_type_id": hygiene["id"],
            "occurred_on": str(day), "description": "ملاحظة ميدانية"})
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["repetition_no"] == index + 1
        assert body["penalty_amount"] == amount
        assert body["status"] == "pending"


def test_violation_notifies_employee(client, auth):
    emp = client.post("/api/employees", headers=auth, json={
        "code": "9301", "full_name": "موظف الإشعار", "basic_salary": 6000}).json()
    client.post("/api/users", headers=auth, json={
        "username": "viol_emp", "password": "Aa123456", "role": "employee", "employee_id": emp["id"]})
    token = client.post("/api/auth/login", data={
        "username": "viol_emp", "password": "Aa123456"}).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}

    types = client.get("/api/violation-types", headers=auth).json()
    dress = next(t for t in types if t["code"] == "dress_code")
    violation = client.post("/api/violations", headers=auth, json={
        "employee_id": emp["id"], "violation_type_id": dress["id"],
        "occurred_on": str(date.today()), "description": "زي غير نظامي"}).json()

    # وصل إشعار للموظف
    notes = client.get("/api/notifications", headers=h).json()
    assert any("مخالفة" in n["title"] for n in notes)
    assert client.get("/api/notifications/unread-count", headers=h).json()["count"] >= 1

    # الموظف يرى مخالفته ويستطيع الإقرار
    mine = client.get("/api/violations", headers=h).json()
    assert [v["id"] for v in mine] == [violation["id"]]
    ack = client.post(f"/api/violations/{violation['id']}/acknowledge", headers=h,
                      json={"note": "أقر بالاطلاع"})
    assert ack.status_code == 200 and ack.json()["status"] == "acknowledged"

    # التظلّم بعد الإقرار مسموح، ويصل إشعار للموارد البشرية
    obj = client.post(f"/api/violations/{violation['id']}/object", headers=h,
                      json={"note": "كنت في مهمة خارجية"})
    assert obj.status_code == 200 and obj.json()["status"] == "objected"
    hr_notes = client.get("/api/notifications", headers=auth).json()
    assert any("تظلّم" in n["title"] for n in hr_notes)


def test_employee_cannot_create_or_approve_violation(client, auth):
    token = client.post("/api/auth/login", data={
        "username": "viol_emp", "password": "Aa123456"}).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    types = client.get("/api/violation-types", headers=auth).json()
    denied = client.post("/api/violations", headers=h, json={
        "employee_id": 1, "violation_type_id": types[0]["id"], "occurred_on": str(date.today())})
    assert denied.status_code == 403


def test_violation_approval_and_cancel(client, auth):
    emp = client.post("/api/employees", headers=auth, json={
        "code": "9302", "full_name": "موظف الاعتماد", "basic_salary": 12000}).json()
    types = client.get("/api/violation-types", headers=auth).json()
    smoking = next(t for t in types if t["code"] == "smoking")
    v1 = client.post("/api/violations", headers=auth, json={
        "employee_id": emp["id"], "violation_type_id": smoking["id"],
        "occurred_on": str(date.today())}).json()
    approved = client.post(f"/api/violations/{v1['id']}/approve", headers=auth,
                           json={"note": "بعد سماع الموظف"})
    assert approved.status_code == 200 and approved.json()["status"] == "approved"
    # لا يمكن تعديل معتمدة
    again = client.post(f"/api/violations/{v1['id']}/cancel", headers=auth)
    assert again.status_code == 400

    v2 = client.post("/api/violations", headers=auth, json={
        "employee_id": emp["id"], "violation_type_id": smoking["id"],
        "occurred_on": str(date.today() - timedelta(days=1))}).json()
    cancelled = client.post(f"/api/violations/{v2['id']}/cancel", headers=auth,
                            json={"note": "ثبت عدم صحتها"})
    assert cancelled.json()["status"] == "cancelled"


def test_future_violation_rejected(client, auth):
    types = client.get("/api/violation-types", headers=auth).json()
    emp_id = _employee_id(client, auth, "9302")
    res = client.post("/api/violations", headers=auth, json={
        "employee_id": emp_id, "violation_type_id": types[0]["id"],
        "occurred_on": str(date.today() + timedelta(days=3))})
    assert res.status_code == 400


# ------------------------------ سجل التدقيق ------------------------------
def test_audit_log_records_sensitive_actions(client, auth):
    logs = client.get("/api/audit-logs", headers=auth).json()
    actions = {(row["action"], row["entity"]) for row in logs}
    assert ("login", "user") in actions
    assert ("create", "employee") in actions
    assert ("create", "violation") in actions
    assert ("approve", "violation") in actions
    assert all(row["action_label"] and row["entity_label"] for row in logs)

    filtered = client.get("/api/audit-logs?entity=violation&action=approve", headers=auth).json()
    assert filtered and all(r["entity"] == "violation" and r["action"] == "approve" for r in filtered)


def test_audit_log_hidden_from_employee(client, auth):
    token = client.post("/api/auth/login", data={
        "username": "viol_emp", "password": "Aa123456"}).json()["access_token"]
    assert client.get("/api/audit-logs", headers={"Authorization": f"Bearer {token}"}).status_code == 403


# ------------------------------ الوثائق ------------------------------
def test_documents_and_expiry_alerts(client, auth):
    emp_id = _employee_id(client, auth, "9300")
    soon = date.today() + timedelta(days=20)
    doc = client.post("/api/documents", headers=auth, json={
        "employee_id": emp_id, "doc_type": "إقامة", "number": "2345678901",
        "expiry_date": str(soon)})
    assert doc.status_code == 201, doc.text
    assert doc.json()["days_left"] == 20

    far = client.post("/api/documents", headers=auth, json={
        "employee_id": emp_id, "doc_type": "جواز سفر", "expiry_date": str(date.today() + timedelta(days=400))})
    assert far.status_code == 201

    expiring = client.get("/api/documents?expiring_days=30", headers=auth).json()
    assert [d["doc_type"] for d in expiring] == ["إقامة"]

    scan = client.post("/api/documents/scan-expiring", headers=auth).json()
    assert scan["documents"] == 1
    notes = client.get("/api/notifications", headers=auth).json()
    assert any("إقامة" in n["title"] for n in notes)


# ------------------------------ الاستيراد الجماعي ------------------------------
def test_import_employees_from_csv(client, auth):
    content = (
        "رقم الموظف,الاسم,الإدارة,المسمى الوظيفي,الجوال,البريد,الهوية,تاريخ التعيين,الراتب الأساسي,الوردية\n"
        "9400,سالم عبدالله الغامدي,المشتريات,أخصائي مشتريات,0501234567,salem@example.com,1098765432,2023-05-01,7500,\n"
        "9401,هند خالد العنزي,المشتريات,منسق,0509876543,hind@example.com,1076543210,15/06/2024,6800,\n"
        ",بدون رقم,,,,,,,,\n"
    ).encode("utf-8")
    res = client.post(
        "/api/employees/import",
        headers=auth,
        files={"file": ("employees.csv", content, "text/csv")},
        data={"update_existing": "true"},
    )
    assert res.status_code == 200, res.text
    report = res.json()
    assert report["created"] == 2 and report["skipped"] == 1 and len(report["errors"]) == 1

    rows = client.get("/api/employees?q=9400", headers=auth).json()
    assert rows[0]["full_name"] == "سالم عبدالله الغامدي"
    assert rows[0]["department_name"] == "المشتريات"
    assert rows[0]["basic_salary"] == 7500
    assert rows[0]["hire_date"] == "2023-05-01"

    # إعادة الاستيراد تُحدّث ولا تكرر
    again = client.post("/api/employees/import", headers=auth,
                        files={"file": ("employees.csv", content, "text/csv")}).json()
    assert again["created"] == 0 and again["updated"] == 2


def test_import_employees_from_xlsx(client, auth):
    import io as _io

    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(["رقم الموظف", "الاسم", "الإدارة", "المسمى الوظيفي", "الجوال",
               "البريد", "الهوية", "تاريخ التعيين", "الراتب الأساسي", "الوردية"])
    ws.append(["9500", "ماجد فيصل الشهري", "الصيانة", "فني", "", "", "", "2022-02-02", 5200, ""])
    buffer = _io.BytesIO()
    wb.save(buffer)
    res = client.post(
        "/api/employees/import", headers=auth,
        files={"file": ("employees.xlsx", buffer.getvalue(),
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    ).json()
    assert res["created"] == 1
    assert client.get("/api/employees?q=9500", headers=auth).json()[0]["basic_salary"] == 5200


# ------------------------------ مسير الرواتب ------------------------------
def test_payroll_run_computes_deductions(client, auth):
    """مسير الشهر يحتسب الغياب والتأخير والإضافي وخصم المخالفات."""
    today = date.today()
    year, month = today.year, today.month

    run = client.post(f"/api/payroll/runs?year={year}&month={month}", headers=auth)
    assert run.status_code == 201, run.text
    run_id = run.json()["id"]
    assert run.json()["employees"] > 0

    slips = client.get(f"/api/payroll/runs/{run_id}/payslips", headers=auth).json()
    by_code = {s["employee_code"]: s for s in slips}

    # الموظف 9302 لديه مخالفة تدخين معتمدة (خصم 0 لأن المستوى الأول إنذار)
    # والموظف 9300 لديه مخالفات: نتحقق أن الخصم انعكس في القسيمة
    emp = by_code["9300"]
    assert emp["basic_salary"] == 9000
    expected_violation = client.get(
        f"/api/violations?employee_id={_employee_id(client, auth, '9300')}", headers=auth
    ).json()
    approved_amount = sum(
        v["penalty_amount"] for v in expected_violation
        if v["status"] == "approved" and v["occurred_on"][:7] == f"{year}-{month:02d}"
    )
    assert emp["violation_deduction"] == round(approved_amount, 2)
    assert emp["net_pay"] == round(
        emp["basic_salary"] + emp["overtime_amount"] - emp["absence_deduction"]
        - emp["late_deduction"] - emp["unpaid_leave_deduction"] - emp["violation_deduction"], 2
    )


def test_payroll_adjust_and_approve(client, auth):
    today = date.today()
    runs = client.get("/api/payroll/runs", headers=auth).json()
    run = next(r for r in runs if r["year"] == today.year and r["month"] == today.month)
    slips = client.get(f"/api/payroll/runs/{run['id']}/payslips", headers=auth).json()
    slip = slips[0]

    adjusted = client.patch(f"/api/payroll/payslips/{slip['id']}", headers=auth,
                            json={"other_additions": 500, "other_deductions": 100,
                                  "note": "بدل مواصلات"}).json()
    assert adjusted["net_pay"] == round(slip["net_pay"] + 400, 2)

    approved = client.post(f"/api/payroll/runs/{run['id']}/approve", headers=auth)
    assert approved.status_code == 200 and approved.json()["status"] == "approved"
    assert approved.json()["net_total"] > 0

    # بعد الاعتماد: لا تعديل ولا حذف ولا إعادة احتساب
    assert client.patch(f"/api/payroll/payslips/{slip['id']}", headers=auth,
                        json={"other_additions": 10}).status_code == 400
    assert client.delete(f"/api/payroll/runs/{run['id']}", headers=auth).status_code == 400
    assert client.post(
        f"/api/payroll/runs?year={today.year}&month={today.month}", headers=auth
    ).status_code == 400

    csv_res = client.get(f"/api/payroll/runs/{run['id']}/export.csv", headers=auth)
    assert csv_res.status_code == 200 and "text/csv" in csv_res.headers["content-type"]


def test_employee_sees_only_approved_payslip(client, auth):
    token = client.post("/api/auth/login", data={
        "username": "viol_emp", "password": "Aa123456"}).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    slips = client.get("/api/payroll/my-payslips", headers=h).json()
    assert len(slips) == 1 and slips[0]["employee_code"] == "9301"
    # ولا يصل إلى مسير الشركة
    assert client.get("/api/payroll/runs", headers=h).status_code == 403


def test_payroll_settings_affect_calculation(client, auth):
    settings = client.get("/api/settings", headers=auth).json()
    assert settings["payroll_days_per_month"] == 30
    assert settings["payroll_overtime_multiplier"] == 1.5
    updated = client.put("/api/settings", headers=auth, json={
        "payroll_overtime_multiplier": 2, "payroll_late_deduction_mode": "none"}).json()
    assert updated["payroll_overtime_multiplier"] == 2
    assert updated["payroll_late_deduction_mode"] == "none"
    client.put("/api/settings", headers=auth, json={
        "payroll_overtime_multiplier": 1.5, "payroll_late_deduction_mode": "proportional"})


def test_future_workdays_not_counted_as_absence(client, auth):
    """أيام الشهر القادمة لا تُحتسب غياباً ولا تُخصم من الراتب."""
    emp = client.post("/api/employees", headers=auth, json={
        "code": "9600", "full_name": "موظف الشهر الحالي", "basic_salary": 30000}).json()
    future = date.today() + timedelta(days=5)
    rows = client.get(
        f"/api/attendance/employee/{emp['id']}?date_from={future}&date_to={future}", headers=auth
    ).json()
    assert rows[0]["status"] in ("scheduled", "weekend", "holiday")
    assert rows[0]["status"] != "absent"

    # مسير شهر قادم بالكامل: لا غياب ولا خصم لأن أيامه لم تحن بعد
    today = date.today()
    year, month = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
    run = client.post(f"/api/payroll/runs?year={year}&month={month}", headers=auth).json()
    slips = client.get(f"/api/payroll/runs/{run['id']}/payslips", headers=auth).json()
    slip = next(s for s in slips if s["employee_code"] == "9600")
    assert slip["absent_days"] == 0
    assert slip["absence_deduction"] == 0
    assert slip["net_pay"] == slip["basic_salary"]
