"""拍照识别接口（上传按 owner 隔离；医生只读不可上传）。"""
import asyncio
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import db, ocr_bridge
from ..config import MAX_UPLOAD_BYTES, UPLOAD_DIR
from ..security import current_user, ensure_writable, viewer_can_view_upload

router = APIRouter(prefix="/api/ocr", tags=["ocr"], dependencies=[Depends(current_user)])

ALLOWED_TYPES = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
}
ALLOWED_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


@router.get("/health")
def ocr_health():
    available = ocr_bridge.is_available()
    return {"available": available, "engine": "rapidocr" if available else "none"}


@router.post("")
async def recognize_upload(file: UploadFile = File(...), user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    suffix = Path(file.filename or "").suffix.lower()
    if file.content_type not in ALLOWED_TYPES and suffix not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail="请上传 JPG/PNG 图片")
    data = bytearray()
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="图片过大（最大 15MB）")
    if not data:
        raise HTTPException(status_code=400, detail="图片为空")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    upload_id = uuid.uuid4().hex
    extension = ALLOWED_TYPES.get(file.content_type or "") or suffix or ".jpg"
    path = UPLOAD_DIR / f"{upload_id}{extension}"
    path.write_bytes(bytes(data))

    conn = db.connect()
    try:
        cursor = conn.execute(
            "INSERT INTO uploads(owner_id, filename, mime, path, created_at) VALUES(?, ?, ?, ?, ?)",
            (owner, file.filename or "upload", file.content_type or "image/jpeg", str(path), db.now_iso()),
        )
        conn.commit()
        row_id = int(cursor.lastrowid)
    finally:
        conn.close()

    result = await asyncio.to_thread(ocr_bridge.recognize, str(path))
    result["upload_id"] = row_id
    if not result.get("message"):
        count = len(result.get("candidates") or [])
        result["message"] = f"识别到 {count} 条测量记录" if count else "未识别到血压数字，请手动输入"
    return result


@router.get("/uploads/{upload_id}")
def get_upload(upload_id: int, user: dict = Depends(current_user)):
    conn = db.connect()
    try:
        row = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
    finally:
        conn.close()
    if row is None or not Path(row["path"]).exists():
        raise HTTPException(status_code=404, detail="图片不存在")
    if not viewer_can_view_upload(user, int(row["owner_id"])):
        raise HTTPException(status_code=403, detail="无权查看该图片")
    return FileResponse(row["path"], media_type=row["mime"], filename=row["filename"])
