"""نقطة تشغيل نظام الموارد البشرية (حضور وانصراف وإجازات) مع تكامل أجهزة ZKTeco."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import AUTO_SYNC_MINUTES, FRONTEND_DIR, TIMEZONE_NAME, UPLOAD_DIR
from .database import SessionLocal
from .routers import attendance, auth, devices, employees, iclock, leaves, reports, users
from .seed import bootstrap
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    bootstrap()
    task = None
    if AUTO_SYNC_MINUTES > 0:
        task = asyncio.create_task(_auto_sync_loop())
        logger.info("المزامنة التلقائية مفعّلة كل %s دقيقة", AUTO_SYNC_MINUTES)
    yield
    if task:
        task.cancel()


app = FastAPI(
    title="نظام الموارد البشرية - الحضور والإجازات",
    description="نظام حضور وانصراف وإجازات مع تكامل أجهزة بصمة ZKTeco (سحب 4370 ودفع ADMS).",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in (
    auth.router,
    users.router,
    employees.router,
    attendance.router,
    leaves.router,
    devices.router,
    reports.router,
    iclock.router,
):
    app.include_router(router)


@app.get("/api/health")
def health():
    return {"status": "ok", "timezone": TIMEZONE_NAME}


app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

if FRONTEND_DIR.exists():
    app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(FRONTEND_DIR / "index.html")
