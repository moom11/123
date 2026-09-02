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
    if applied:
        logger.info("ترقية قاعدة البيانات: أُضيفت الأعمدة %s", ", ".join(applied))
    return applied
