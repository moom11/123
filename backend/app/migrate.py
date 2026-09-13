"""ترقية بسيطة للمخطط: إضافة الأعمدة الجديدة إلى قواعد بيانات قائمة."""
from __future__ import annotations

import logging

from sqlalchemy import inspect, text

from .database import engine

logger = logging.getLogger("hr")

# (الجدول، العمود، تعريف العمود)
NEW_COLUMNS: list[tuple[str, str, str]] = [
    ("employees", "site_id", "INTEGER"),
    ("punches", "latitude", "FLOAT"),
    ("punches", "longitude", "FLOAT"),
    ("punches", "accuracy_meters", "FLOAT"),
    ("punches", "site_id", "INTEGER"),
    ("punches", "distance_meters", "FLOAT"),
    ("employees", "allowances", "FLOAT DEFAULT 0"),
    ("payslips", "allowances", "FLOAT DEFAULT 0"),
    ("payslips", "loan_deduction", "FLOAT DEFAULT 0"),
    ("users", "must_change_password", "BOOLEAN DEFAULT 0"),
    ("employees", "weekly_rest_days", "VARCHAR(20)"),
    ("punches", "intent", "VARCHAR(20)"),
    ("punches", "deleted_at", "DATETIME"),
    ("punches", "deleted_by_id", "INTEGER"),
    ("punches", "delete_reason", "VARCHAR(255)"),
    ("attendance_days", "presence_minutes", "INTEGER DEFAULT 0"),
    ("attendance_days", "break_minutes", "INTEGER DEFAULT 0"),
    ("attendance_days", "break_count", "INTEGER DEFAULT 0"),
    ("attendance_days", "break_overrun_minutes", "INTEGER DEFAULT 0"),
    ("attendance_days", "open_break", "BOOLEAN DEFAULT 0"),
    ("employees", "no_break", "BOOLEAN DEFAULT 0"),
    ("employees", "monthly_rest_quota", "INTEGER"),
    ("employee_loans", "approved_by_id", "INTEGER"),
    ("employee_loans", "approved_at", "DATETIME"),
    ("employee_loans", "acknowledged_at", "DATETIME"),
    ("employee_loans", "decision_note", "VARCHAR(255)"),
    ("payslips", "purchases_deduction", "FLOAT DEFAULT 0"),
    ("payslips", "open_break_days", "FLOAT DEFAULT 0"),
    ("payslips", "open_break_deduction", "FLOAT DEFAULT 0"),
    ("users", "token_version", "INTEGER DEFAULT 1"),
    ("users", "password_changed_at", "DATETIME"),
    ("users", "totp_secret", "VARCHAR(64)"),
    ("users", "totp_enabled", "BOOLEAN DEFAULT 0"),
    ("payslips", "carryover_earning", "FLOAT DEFAULT 0"),
    ("payslips", "carryover_deduction", "FLOAT DEFAULT 0"),
    ("payslips", "early_leave_minutes", "INTEGER DEFAULT 0"),
    ("payslips", "early_leave_deduction", "FLOAT DEFAULT 0"),
    ("attendance_days", "shift_snapshot", "TEXT"),
]


def run() -> list[str]:
    """يضيف الأعمدة الناقصة ويعيد قائمة بما تمت إضافته."""
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    applied: list[str] = []
    with engine.begin() as conn:
        for table, column, ddl in NEW_COLUMNS:
            if table not in tables:
                continue
            existing = {c["name"] for c in inspector.get_columns(table)}
            if column in existing:
                continue
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
            applied.append(f"{table}.{column}")
    if "attendance_days.shift_snapshot" in applied:
        # الأيام المحفوظة سابقاً بلا لقطة: تُختم بوردية الموظف الحالية مرة واحدة،
        # فتُحفظ من هذه اللحظة ولا يعيد تعديلُ الوردية لاحقاً حسابَ الماضي
        frozen = _seal_past_days()
        if frozen:
            logger.info("تجميد أيام الحضور المحفوظة: %d يوم", frozen)
    if applied:
        logger.info("ترقية قاعدة البيانات: أُضيفت الأعمدة %s", ", ".join(applied))
    return applied


def _seal_past_days() -> int:
    """يختم كل يوم حضور محفوظ بلقطة وردية الموظف الحالية. يعيد عدد الأيام."""
    import json

    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from .models import AttendanceDay, Employee
    from .services.attendance import ShiftRules

    with Session(engine) as db:
        employees = {e.id: e for e in db.scalars(select(Employee)).all()}
        rows = db.scalars(
            select(AttendanceDay).where(AttendanceDay.shift_snapshot.is_(None))
        ).all()
        cache: dict[tuple, str] = {}
        for row in rows:
            emp = employees.get(row.employee_id)
            if emp is None:
                continue
            key = (emp.shift_id, emp.weekly_rest_days)
            if key not in cache:
                cache[key] = json.dumps(
                    ShiftRules(emp.shift, emp.weekly_rest_days).snapshot(), ensure_ascii=False
                )
            row.shift_snapshot = cache[key]
        db.commit()
        return len(rows)
