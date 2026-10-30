# -*- coding: utf-8 -*-
"""血压管家 OCR 模块。

对外只暴露两个函数::

    from app.ocr import recognize_image, is_available
    # 或者同目录直接
    from ocr import recognize_image, is_available

``recognize_image(path)`` 返回::

    {"engine": "rapidocr",
     "image_type": "monitor" | "screenshot" | "unknown",
     "candidates": [{"systolic": int, "diastolic": int, "pulse": int | None,
                     "measured_at": "带时区 ISO8601" | None,
                     "confidence": float, "evidence": str}],
     "raw_text": [str, ...],
     "message": str}

屏幕照片（大号 7 段码数字）与 App 历史截图都会自动判别；
依赖缺失时 ``is_available()`` 返回 False，``recognize_image`` 不抛异常。
"""

from __future__ import annotations

try:  # 作为包导入（后端 app/ocr 子包）
    from .recognizer import ENGINE_NAME, is_available, recognize_image
except ImportError:  # 直接把 ocr 目录加入 sys.path 时
    from recognizer import ENGINE_NAME, is_available, recognize_image  # type: ignore

__all__ = ["recognize_image", "is_available", "ENGINE_NAME"]
__version__ = "1.0.0"
