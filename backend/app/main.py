"""نقطة تشغيل نظام الموارد البشرية (حضور وانصراف وإجازات) مع تكامل أجهزة ZKTeco."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import ADMIN_PASSWORD, AUTO_SYNC_MINUTES, FRONTEND_DIR, TIMEZONE_NAME, UPLOAD_DIR
from .security_extra import SecurityHeadersMiddleware
from .database import SessionLocal
from .routers import (
    attendance,
    auth,
    backup,
    branding,
    carryovers,
    devices,
    employees,
    hr_extra,
    iclock,
    leaves,
    loans,
    me,
    payroll,
    policies,
    punch_requests,
    purchases,
    push,
    rest_days,
    reports,
    requests as requests_router,
    sheets,
    sites,
    users,
    violations,
    webapp,
)
from .seed import bootstrap
from .services import appicon as appicon_service
from .services import attendance_alerts
from .services import daily as daily_service
from .services import push as push_service
from .services import sheets as sheets_service
from .services import zk_service

logger = logging.getLogger("hr")
logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")


async def _auto_sync_loop() -> None:
    """مزامنة دورية لأجهزة البصمة عند تفعيل HR_AUTO_SYNC_MINUTES."""
    interval = AUTO_SYNC_MINUTES * 60
    while True:
        await asyncio.sleep(interval)
        try:
            with SessionLocal() as db:
                results = await asyncio.to_thread(zk_service.sync_all, db)
            imported = sum(r.get("imported", 0) for r in results)
            logger.info("مزامنة تلقائية: %s جهاز، %s سجل جديد", len(results), imported)
        except Exception as exc:  # pragma: no cover - حماية الحلقة من التوقف
            logger.warning("فشل المزامنة التلقائية: %s", exc)


async def _background_loop() -> None:
    """مهام دورية: العبارة اليومية، تنبيه الغياب والتأخير، ودفعات جوجل شيت."""
    while True:
        await asyncio.sleep(300)   # كل خمس دقائق
        try:
            with SessionLocal() as db:
                sent = await asyncio.to_thread(daily_service.send_daily_quote, db)
                if sent:
                    logger.info("أُرسلت العبارة اليومية إلى %s مستخدم", sent)
                alert = await asyncio.to_thread(attendance_alerts.scan, db)
                if alert.get("sent"):
                    logger.info("تنبيه الحضور: %s", alert.get("message"))
                if sheets_service.is_enabled(db):
                    await asyncio.to_thread(sheets_service.flush, db)
                    await asyncio.to_thread(sheets_service.daily_attendance_job, db)
        except Exception as exc:  # pragma: no cover - حماية الحلقة
            logger.warning("فشل تنفيذ المهام الدورية: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    bootstrap()
    # توليد مفاتيح إشعارات الجوال مرة واحدة عند الإقلاع
    try:
        with SessionLocal() as db:
            push_service.ensure_keys(db)
    except Exception as exc:  # pragma: no cover - لا يمنع الإقلاع
        logger.warning("تعذر تهيئة مفاتيح إشعارات الجوال: %s", exc)
    # أيقونة التطبيق: تُبنى من الشعار المرفوع إن لم تكن موجودة بعد
    try:
        with SessionLocal() as db:
            if appicon_service.icon_path("icon-192.png") == appicon_service.BUNDLED_DIR / "icon-192.png":
                appicon_service.rebuild(db)
    except Exception as exc:  # pragma: no cover - لا يمنع الإقلاع
        logger.warning("تعذر تجهيز أيقونة التطبيق: %s", exc)
    tasks = [asyncio.create_task(_background_loop())]
    if AUTO_SYNC_MINUTES > 0:
        tasks.append(asyncio.create_task(_auto_sync_loop()))
        logger.info("المزامنة التلقائية مفعّلة كل %s دقيقة", AUTO_SYNC_MINUTES)
    yield
    for task in tasks:
        task.cancel()


app = FastAPI(
    title="نظام الموارد البشرية - الحضور والإجازات",
    description="نظام حضور وانصراف وإجازات مع تكامل أجهزة بصمة ZKTeco (سحب 4370 ودفع ADMS).",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(SecurityHeadersMiddleware)

# CORS: النظام والواجهة على نفس النطاق، فلا يُسمح بنطاقات خارجية إلا بضبط صريح
_cors_origins = [o.strip() for o in os.getenv("HR_CORS_ORIGINS", "").split(",") if o.strip()]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

for router in (
    auth.router,
    users.router,
    employees.router,
    attendance.router,
    leaves.router,
    devices.router,
    sites.router,
    violations.router,
    payroll.router,
    policies.router,
    loans.router,
    purchases.router,
    carryovers.router,
    punch_requests.router,
    me.router,
    push.router,
    rest_days.router,
    branding.router,
    backup.router,
    hr_extra.router,
    sheets.router,
    reports.router,
    requests_router.router,
    iclock.router,
    webapp.router,
):
    app.include_router(router)


@app.get("/api/health")
def health():
    """فحص الحالة. يكشف فقط ما إذا كان الإعداد الأولي لم يكتمل بعد
    (مدير النظام ما زال على كلمة المرور الافتراضية) لتعرض الواجهة تذكيراً."""
    setup_pending = False
    try:
        from sqlalchemy import select

        from .models import Role, User
        from .security import verify_password

        with SessionLocal() as db:
            admin = db.scalar(
                select(User).where(User.role == Role.admin).order_by(User.id).limit(1)
            )
            if admin:
                setup_pending = verify_password(ADMIN_PASSWORD, admin.password_hash)
    except Exception:  # pragma: no cover - لا يعطّل فحص الحالة أبداً
        setup_pending = False
    return {"status": "ok", "timezone": TIMEZONE_NAME, "setup_pending": setup_pending}


app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

if FRONTEND_DIR.exists():
    app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(FRONTEND_DIR / "index.html")
