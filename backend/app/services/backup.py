"""إنشاء نسخة احتياطية كاملة: قاعدة البيانات + المرفقات."""
from __future__ import annotations

import json
import sqlite3
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import DATA_DIR, DATABASE_URL, UPLOAD_DIR
from ..models import AttendanceDay, Employee, LeaveRequest, Punch, Violation


def _sqlite_path() -> Path | None:
    """مسار ملف قاعدة SQLite، أو None لقواعد أخرى مثل PostgreSQL."""
    if not DATABASE_URL.startswith("sqlite"):
        return None
    return Path(DATABASE_URL.split("///", 1)[-1])


def snapshot_database(target: Path) -> bool:
    """نسخة متسقة من قاعدة SQLite حتى أثناء عمل النظام (واجهة backup الرسمية)."""
    source = _sqlite_path()
    if source is None or not source.exists():
        return False
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
    return True


def summary(db: Session) -> dict:
    """أعداد السجلات لتوثيقها داخل النسخة."""
    def count(model) -> int:
        return len(db.scalars(select(model.id)).all())

    return {
        "employees": count(Employee),
        "punches": count(Punch),
        "attendance_days": count(AttendanceDay),
        "leave_requests": count(LeaveRequest),
        "violations": count(Violation),
    }


def create_archive(db: Session) -> tuple[Path, str]:
    """ينشئ ملف tar.gz مؤقتاً ويعيد (المسار، اسم الملف للتنزيل)."""
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    filename = f"hr-backup-{stamp}.tar.gz"
    workdir = Path(tempfile.mkdtemp(prefix="hr_backup_"))
    archive_path = workdir / filename

    manifest = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "database": "sqlite" if _sqlite_path() else "external",
        "records": summary(db),
        "restore": (
            "فك الضغط ثم انسخ hr.db و uploads/ إلى /opt/hr/data على الخادم، "
            "ثم: sudo systemctl restart hr"
        ),
    }

    db_copy = workdir / "hr.db"
    has_db = snapshot_database(db_copy)

    with tarfile.open(archive_path, "w:gz") as tar:
        manifest_path = workdir / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        tar.add(manifest_path, arcname="manifest.json")
        if has_db:
            tar.add(db_copy, arcname="hr.db")
        if UPLOAD_DIR.exists() and any(UPLOAD_DIR.iterdir()):
            tar.add(UPLOAD_DIR, arcname="uploads")
        db_copy.unlink(missing_ok=True)
        manifest_path.unlink(missing_ok=True)

    return archive_path, filename


def data_size_bytes() -> int:
    """حجم بيانات النظام الحالية (تقدير حجم النسخة قبل الضغط)."""
    total = 0
    for path in DATA_DIR.rglob("*"):
        if path.is_file() and not path.name.endswith((".db-wal", ".db-shm", "secret.key")):
            total += path.stat().st_size
    return total
