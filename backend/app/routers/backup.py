"""تنزيل نسخة احتياطية كاملة من النظام."""
from __future__ import annotations

import shutil

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from ..database import get_db
from ..models import User
from ..security import require_hr
from ..services import audit
from ..services import backup as service

router = APIRouter(prefix="/api/backup", tags=["backup"], dependencies=[Depends(require_hr)])


class BackupInfo(BaseModel):
    size_bytes: int
    size_mb: float
    records: dict


@router.get("/info", response_model=BackupInfo)
def backup_info(db: Session = Depends(get_db)):
    size = service.data_size_bytes()
    return BackupInfo(
        size_bytes=size, size_mb=round(size / (1024 * 1024), 2), records=service.summary(db)
    )


@router.get("/download")
def download_backup(db: Session = Depends(get_db), user: User = Depends(require_hr)):
    """ملف tar.gz يحوي قاعدة البيانات وكل المرفقات، مع ملف تعليمات الاسترجاع."""
    path, filename = service.create_archive(db)
    audit.log(db, user, "create", "settings", None, f"تنزيل نسخة احتياطية: {filename}")
    return FileResponse(
        path,
        media_type="application/gzip",
        filename=filename,
        background=BackgroundTask(shutil.rmtree, path.parent, ignore_errors=True),
    )
