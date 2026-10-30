"""血压管家 FastAPI 应用入口。"""
import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, db
from .routers import admin, auth, ble, dashboard, data, exports, ocr, patients, restore, settings
from .services.reminders import reminder_loop

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("bp")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    stop_event = asyncio.Event()
    reminder_task = asyncio.create_task(reminder_loop(stop_event))
    logger.info("血压管家启动完成，数据目录：%s", config.DATA_DIR)
    try:
        yield
    finally:
        stop_event.set()
        reminder_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await reminder_task


app = FastAPI(title=config.APP_NAME, version=config.APP_VERSION, lifespan=lifespan)


def _hostname(value: str) -> str:
    """把 Host/Origin/URL 归一化为小写主机名（忽略端口与协议）。"""
    value = (value or "").strip().lower()
    if not value:
        return ""
    if "://" in value:
        value = urlparse(value).netloc
    if value.startswith("["):
        return value.split("]")[0].lstrip("[")
    return value.rsplit(":", 1)[0]


@app.middleware("http")
async def same_origin_and_headers(request: Request, call_next):
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("origin")
        if origin:
            allowed = {
                _hostname(request.headers.get("host", "")),
                _hostname(request.headers.get("x-forwarded-host", "")),
            }
            allowed.discard("")
            origin_host = _hostname(origin)
            if allowed and origin_host and origin_host not in allowed:
                logger.warning(
                    "CSRF 拒绝：origin=%r host=%r x-forwarded-host=%r",
                    origin,
                    request.headers.get("host"),
                    request.headers.get("x-forwarded-host"),
                )
                return JSONResponse({"detail": "跨站请求被拒绝"}, status_code=403)
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=()")
    return response


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "version": config.APP_VERSION,
        "time": db.now_iso(),
    }


app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(patients.router)
app.include_router(data.router)
app.include_router(dashboard.router)
app.include_router(settings.router)
app.include_router(exports.router)
app.include_router(restore.router)
app.include_router(ocr.router)
app.include_router(ble.router)

if config.FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIR), html=True), name="frontend")
else:  # 没有前端构建产物时给出提示
    @app.get("/")
    def placeholder():
        return JSONResponse(
            {"app": config.APP_NAME, "message": "前端静态文件未找到，请构建/拷贝 frontend 目录"}
        )
