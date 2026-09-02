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
os.environ["HR_DATABASE_URL"] = f"sqlite:///{Path(TMP) / 'test.db'}"
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
    # تسجيل بصمة ذاتية
    punch = client.post("/api/attendance/self-punch", headers=h)
    assert punch.status_code == 201


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
