#!/usr/bin/env python3
"""نقل بيانات النظام من SQLite إلى PostgreSQL (أو أي قاعدة يدعمها SQLAlchemy).

الاستخدام:
    PYTHONPATH=backend python deploy/migrate_to_postgres.py \
        --source sqlite:///data/hr.db \
        --target "postgresql+psycopg://hr:pass@localhost/hr"

ينشئ الجداول في الوجهة، ثم ينسخ الصفوف بترتيب يحترم المفاتيح الأجنبية،
ويؤجّل الأعمدة ذات العلاقات الدائرية (مدير الإدارة ومدير الموظف) إلى تحديث لاحق،
ثم يضبط تسلسلات PostgreSQL على آخر معرّف منقول.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from sqlalchemy import create_engine, func, insert, select, text, update  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app import models  # noqa: F401,E402  (تسجيل كل الجداول)
from app.database import Base  # noqa: E402

# أعمدة تُملأ بـ NULL أثناء الإدراج ثم تُحدَّث بعد اكتمال النسخ (علاقات دائرية)
DEFERRED = {
    "departments": ["manager_id"],
    "employees": ["manager_id"],
}


def ordered_tables() -> list:
    """ترتيب طوبولوجي للجداول مع تجاهل العلاقات المؤجّلة."""
    tables = list(Base.metadata.tables.values())
    deps: dict[str, set[str]] = {}
    for table in tables:
        skip = set(DEFERRED.get(table.name, []))
        needed = {
            fk.column.table.name
            for column in table.columns
            if column.name not in skip
            for fk in column.foreign_keys
            if fk.column.table.name != table.name
        }
        deps[table.name] = needed

    ordered: list = []
    placed: set[str] = set()
    remaining = {t.name: t for t in tables}
    while remaining:
        ready = [name for name, table in remaining.items() if deps[name] <= placed]
        if not ready:  # حماية من دورة غير متوقعة
            ready = sorted(remaining)
        for name in sorted(ready):
            ordered.append(remaining.pop(name))
            placed.add(name)
    return ordered


def copy_all(source_url: str, target_url: str, force: bool = False, batch: int = 500) -> dict:
    source = create_engine(source_url)
    target = create_engine(target_url)
    Base.metadata.create_all(bind=target)

    tables = ordered_tables()
    report: dict[str, int] = {}
    deferred_rows: dict[str, list[dict]] = {}

    with Session(source) as src, Session(target) as dst:
        if not force:
            for table in tables:
                if dst.execute(select(func.count()).select_from(table)).scalar():
                    raise SystemExit(
                        f"الوجهة تحتوي بيانات في الجدول {table.name}. "
                        "أفرغها أولاً أو أعد التشغيل مع --force"
                    )

        for table in tables:
            rows = [dict(row._mapping) for row in src.execute(select(table))]
            report[table.name] = len(rows)
            if not rows:
                continue

            skip = DEFERRED.get(table.name, [])
            if skip:
                pk = list(table.primary_key.columns)[0].name
                pending = [
                    {pk: row[pk], **{c: row[c] for c in skip}}
                    for row in rows
                    if any(row.get(c) is not None for c in skip)
                ]
                if pending:
                    deferred_rows[table.name] = pending
                rows = [{**row, **{c: None for c in skip}} for row in rows]

            for start in range(0, len(rows), batch):
                dst.execute(insert(table), rows[start:start + batch])
        dst.commit()

        # المرحلة الثانية: إعادة العلاقات المؤجّلة
        for table_name, rows in deferred_rows.items():
            table = Base.metadata.tables[table_name]
            pk = list(table.primary_key.columns)[0]
            for row in rows:
                values = {c: row[c] for c in DEFERRED[table_name]}
                dst.execute(update(table).where(pk == row[pk.name]).values(**values))
        dst.commit()

        # ضبط تسلسلات PostgreSQL على آخر معرّف
        if target.dialect.name == "postgresql":
            for table in tables:
                pk_columns = list(table.primary_key.columns)
                if len(pk_columns) != 1 or not str(pk_columns[0].type).upper().startswith("INTEGER"):
                    continue
                column = pk_columns[0]
                dst.execute(
                    text(
                        "SELECT setval(pg_get_serial_sequence(:t, :c), "
                        "COALESCE((SELECT MAX(" + column.name + ") FROM " + table.name + "), 1))"
                    ),
                    {"t": table.name, "c": column.name},
                )
            dst.commit()
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="نقل بيانات نظام الموارد البشرية بين قاعدتين")
    parser.add_argument("--source", default="sqlite:///data/hr.db", help="قاعدة المصدر")
    parser.add_argument("--target", required=True, help="قاعدة الوجهة (postgresql+psycopg://...)")
    parser.add_argument("--force", action="store_true", help="تجاهل وجود بيانات في الوجهة")
    args = parser.parse_args()

    report = copy_all(args.source, args.target, args.force)
    print("تم النقل:")
    for name, count in report.items():
        if count:
            print(f"  {name}: {count} صف")
    print(f"الإجمالي: {sum(report.values())} صف")
    print("\nالخطوة التالية: اضبط HR_DATABASE_URL في /etc/hr.env ثم: sudo systemctl restart hr")


if __name__ == "__main__":
    main()
