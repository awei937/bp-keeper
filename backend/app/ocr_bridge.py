"""OCR 识别桥接层：把 bp_app/ocr 模块安全地接入后端。"""
import logging

logger = logging.getLogger("bp.ocr")

_recognize = None
_available_check = None

try:  # 容器内：/app/app/ocr
    from app.ocr import recognize_image as _recognize  # type: ignore

    try:
        from app.ocr import is_available as _available_check  # type: ignore
    except ImportError:
        _available_check = None
except Exception as exc:  # noqa: BLE001
    try:  # 本地开发：项目根目录下的 ocr 包
        from ocr import recognize_image as _recognize  # type: ignore

        try:
            from ocr import is_available as _available_check  # type: ignore
        except ImportError:
            _available_check = None
    except Exception:  # noqa: BLE001
        logger.warning("OCR 模块不可用：%s", exc)


def is_available() -> bool:
    if _recognize is None:
        return False
    if _available_check is not None:
        try:
            return bool(_available_check())
        except Exception:  # noqa: BLE001
            return False
    return True


def recognize(path: str) -> dict:
    if _recognize is None:
        return {
            "engine": "none",
            "image_type": "unknown",
            "candidates": [],
            "raw_text": [],
            "message": "服务器未安装 OCR 识别模块",
        }
    try:
        result = _recognize(path)
    except Exception as exc:  # noqa: BLE001
        logger.exception("OCR 识别失败")
        return {
            "engine": "rapidocr",
            "image_type": "unknown",
            "candidates": [],
            "raw_text": [],
            "message": f"识别失败：{exc}",
        }
    if not isinstance(result, dict):
        return {
            "engine": "rapidocr",
            "image_type": "unknown",
            "candidates": [],
            "raw_text": [],
            "message": "识别结果格式异常",
        }
    result.setdefault("engine", "rapidocr")
    result.setdefault("image_type", "unknown")
    result.setdefault("candidates", [])
    result.setdefault("raw_text", [])
    result.setdefault("message", "")
    return result
