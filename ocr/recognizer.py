# -*- coding: utf-8 -*-
"""血压管家 OCR 识别模块。

识别两类图片：
1. 血压计屏幕照片（大号 7 段码数字）-> image_type="monitor"
2. 手机 App 血压历史记录截图 -> image_type="screenshot"

主引擎 RapidOCR（rapidocr-onnxruntime），对 7 段码大数字提供
"字符分割 + 线段清单" 的纯 opencv/numpy 兜底识别，不依赖 OCR 识别 7 段码。

模块无包内相对导入，既可以作为包 ``app.ocr.recognizer`` 导入，
也可以从同目录直接 ``from recognizer import recognize_image``。

对外接口::

    recognize_image(path: str) -> dict
    is_available() -> bool

返回结构::

    {"engine": "rapidocr",
     "image_type": "monitor" | "screenshot" | "unknown",
     "candidates": [{"systolic": int, "diastolic": int, "pulse": int | None,
                     "measured_at": "带时区 ISO8601" | None,
                     "confidence": float, "evidence": str}],
     "raw_text": [str, ...],
     "message": str}

环境变量：
    BP_OCR_TZ_OFFSET   截图日期时间的时区偏移，默认 "+08:00"
    BP_OCR_DEBUG       为 "1" 时把中间结果写到 BP_OCR_DEBUG_DIR（默认 /tmp/ocr_debug）

依赖：rapidocr-onnxruntime、opencv-python-headless、numpy、Pillow
"""

from __future__ import annotations

import os
import re
import time
from datetime import datetime, timedelta, timezone

__all__ = ["recognize_image", "is_available", "ENGINE_NAME"]

ENGINE_NAME = "rapidocr"

# ---------------------------------------------------------------------------
# 可选依赖（缺失时 is_available() 返回 False，recognize_image 返回错误消息而不抛异常）
# ---------------------------------------------------------------------------
try:  # pragma: no cover - 依赖探测
    import cv2
    import numpy as np

    _CV_OK = True
    _CV_ERR = ""
except Exception as exc:  # pragma: no cover
    cv2 = None  # type: ignore
    np = None  # type: ignore
    _CV_OK = False
    _CV_ERR = "opencv/numpy 不可用: %s" % exc

try:  # pragma: no cover
    from PIL import Image, ImageOps

    _PIL_OK = True
    _PIL_ERR = ""
except Exception as exc:  # pragma: no cover
    Image = ImageOps = None  # type: ignore
    _PIL_OK = False
    _PIL_ERR = "Pillow 不可用: %s" % exc

_ENGINE = None
_ENGINE_ERR = ""
_ENGINE_FAILED = False
try:
    import threading

    _OCR_LOCK = threading.Lock()
except Exception:  # pragma: no cover
    _OCR_LOCK = None


# ---------------------------------------------------------------------------
# 通用小工具
# ---------------------------------------------------------------------------
def _debug_enabled() -> bool:
    return os.environ.get("BP_OCR_DEBUG", "") not in ("", "0", "false", "False")


def _debug_dir() -> str:
    d = os.environ.get("BP_OCR_DEBUG_DIR", os.path.join("/tmp", "ocr_debug"))
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        d = "."
    return d


def _dbg_write(name: str, image) -> None:
    if not _debug_enabled() or not _CV_OK:
        return
    try:
        cv2.imwrite(os.path.join(_debug_dir(), name), image)
    except Exception:
        pass


def _tzinfo():
    """从环境变量 BP_OCR_TZ_OFFSET 解析时区，如 "+08:00"。默认东八区。"""
    raw = os.environ.get("BP_OCR_TZ_OFFSET", "+08:00").strip()
    m = re.fullmatch(r"([+-])(\d{1,2}):?(\d{2})?", raw)
    if not m:
        return timezone(timedelta(hours=8))
    sign = 1 if m.group(1) == "+" else -1
    hours = int(m.group(2))
    minutes = int(m.group(3) or 0)
    try:
        return timezone(sign * timedelta(hours=hours, minutes=minutes))
    except Exception:
        return timezone(timedelta(hours=8))


# ---------------------------------------------------------------------------
# 图片读取（Pillow 处理 EXIF 方向 -> BGR ndarray）
# ---------------------------------------------------------------------------
def _load_bgr(path):
    """读入图片并做 EXIF 旋转，返回 BGR ndarray；失败抛异常。"""
    if not _PIL_OK:
        raise RuntimeError(_PIL_ERR)
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    rgb = np.asarray(im.convert("RGB"))
    if rgb.ndim != 3 or rgb.shape[0] < 8 or rgb.shape[1] < 8:
        raise ValueError("图片尺寸过小或格式不支持: %r" % (rgb.shape,))
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _resize_max(bgr, max_side: int):
    """长边缩放到 max_side 以内，返回 (img, scale)；scale = 新/旧。"""
    h, w = bgr.shape[:2]
    long_side = max(h, w)
    if long_side <= max_side:
        return bgr, 1.0
    scale = max_side / float(long_side)
    out = cv2.resize(bgr, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
                     interpolation=cv2.INTER_AREA)
    return out, scale


# ---------------------------------------------------------------------------
# RapidOCR 封装
# ---------------------------------------------------------------------------
def _get_engine():
    global _ENGINE, _ENGINE_ERR, _ENGINE_FAILED
    if _ENGINE is not None:
        return _ENGINE
    if _ENGINE_FAILED:
        return None
    if _OCR_LOCK is not None:
        with _OCR_LOCK:
            if _ENGINE is not None:
                return _ENGINE
            try:
                from rapidocr_onnxruntime import RapidOCR

                _ENGINE = RapidOCR()
                _ENGINE_ERR = ""
            except Exception as exc:  # pragma: no cover
                _ENGINE = None
                _ENGINE_FAILED = True
                _ENGINE_ERR = "rapidocr 初始化失败: %s" % exc
    return _ENGINE


def _ocr(bgr):
    """对 BGR ndarray 跑 RapidOCR，返回 [{'text','score','box':(x0,y0,x1,y1),'xc','yc'}]。"""
    engine = _get_engine()
    if engine is None:
        return []
    try:
        if _OCR_LOCK is not None:
            with _OCR_LOCK:  # RapidOCR 实例不保证线程安全，串行调用
                result, _elapse = engine(bgr)
        else:
            result, _elapse = engine(bgr)
    except Exception:
        return []
    lines = []
    if not result:
        return lines
    for item in result:
        try:
            box, text, score = item[0], item[1], float(item[2])
        except Exception:
            continue
        text = str(text).strip()
        if not text:
            continue
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        lines.append({
            "text": text,
            "score": score,
            "box": (min(xs), min(ys), max(xs), max(ys)),
            "xc": sum(xs) / len(xs),
            "yc": sum(ys) / len(ys),
        })
    return lines


# ===========================================================================
# 一、血压计屏幕（7 段码）识别
# ===========================================================================
# 7 段码标准段位：a 上 g 中 d 下 / f 左上 b 右上 / e 左下 c 右下
_SEG7 = {
    "0": set("abcdef"),
    "1": set("bc"),
    "2": set("abged"),
    "3": set("abgcd"),
    "4": set("fgbc"),
    "5": set("afgcd"),
    "6": set("afgecd"),
    "7": set("abc"),
    "8": set("abcdefg"),
    "9": set("abcdfg"),
}


def _warp_screen_rect(bgr, rect, area_ratio):
    """按 minAreaRect 透视矫正屏幕区域，返回 (warped, info)。"""
    (cx, cy), (rw, rh), angle = rect
    if min(rw, rh) < 100 or min(rw, rh) / max(rw, rh) < 0.30:
        return None, {"reason": "implausible screen rect", "rect": rect}
    pts = cv2.boxPoints(rect).astype(np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    tl, br = pts[np.argmin(s)], pts[np.argmax(s)]
    tr, bl = pts[np.argmin(d)], pts[np.argmax(d)]
    wmax = int(round(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))))
    hmax = int(round(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))))
    if wmax < 120 or hmax < 120:
        return None, {"reason": "screen too small", "size": (wmax, hmax)}
    src = np.array([tl, tr, br, bl], np.float32)
    dst = np.array([[0, 0], [wmax - 1, 0], [wmax - 1, hmax - 1], [0, hmax - 1]], np.float32)
    m = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(bgr, m, (wmax, hmax))
    info = {
        "rect": ((round(cx, 1), round(cy, 1)), (round(rw, 1), round(rh, 1)), round(angle, 2)),
        "warp_size": (warped.shape[1], warped.shape[0]),
        "area_ratio": round(area_ratio, 4),
        "transform": m,
    }
    return warped, info


def _screen_masks(bgr):
    """生成多个"屏幕区域"候选掩码：[(名称, bool mask)]。

    屏幕可能是绿色背光液晶，也可能接近中性白/浅色，而机身颜色各异（白/粉/灰/深色）。
    因此同时给出"绿偏"与"低饱和亮区"两类假设，由后续 7 段码识别结果投票选择，
    避免只依赖绿色色偏（粉色机身+中性屏的照片会失效）。
    """
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    s, v = hsv[:, :, 1], hsv[:, :, 2]
    b = bgr[:, :, 0].astype(np.int16)
    g = bgr[:, :, 1].astype(np.int16)
    r = bgr[:, :, 2].astype(np.int16)
    excess = g - (r + b) / 2.0
    return [
        ("green", (excess > 4) & (v > 120) & (v < 245)),
        ("green-soft", (excess > 2) & (v > 120) & (v < 245)),
        ("neutral", (s < 22) & (v > 145)),
        ("bright", (s < 38) & (v > 158)),
    ]


def _screen_candidates(bgr):
    """找出所有可能的血压计屏幕四边形并透视矫正。

    返回 [{"name", "warped", "info"}]；同一区域被多个掩码命中时去重。
    """
    h, w = bgr.shape[:2]
    img_area = float(h * w)
    k = max(9, int(round(min(h, w) * 0.008)) | 1)
    kernel = np.ones((k, k), np.uint8)
    out = []
    seen = []
    for name, mask in _screen_masks(bgr):
        m = mask.astype(np.uint8) * 255
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, kernel)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel)
        cnts = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[-2]
        if not cnts:
            continue
        cnts = sorted(cnts, key=cv2.contourArea, reverse=True)[:2]
        for cont in cnts:
            area = cv2.contourArea(cont)
            ratio = area / img_area
            if ratio < 0.02 or ratio > 0.88:
                continue
            rect = cv2.minAreaRect(cont)
            (cx, cy), (rw, rh), _angle = rect
            if min(rw, rh) < 120:
                continue
            dup = False
            for (ox, oy, ow, oh) in seen:
                if (abs(cx - ox) < 0.08 * max(ow, 60) and abs(cy - oy) < 0.08 * max(oh, 60)
                        and 0.85 < (rw * rh) / max(1.0, ow * oh) < 1.18):
                    dup = True
                    break
            if dup:
                continue
            warped, info = _warp_screen_rect(bgr, rect, ratio)
            if warped is None:
                continue
            seen.append((cx, cy, rw, rh))
            info["name"] = name
            out.append({"name": name, "warped": warped, "info": info})
    return out


def _screen_rect_from_green(bgr):
    """兼容旧接口：优先返回绿色偏候选，否则返回第一个候选。"""
    cands = _screen_candidates(bgr)
    if not cands:
        return None, {"reason": "no screen region"}
    for cand in cands:
        if cand["name"] == "green":
            return cand["warped"], cand["info"]
    return cands[0]["warped"], cands[0]["info"]


def _cluster_segments(segs, key0, key1, tol_frac):
    """按一维区间重叠把线段聚成组（并查集）。"""
    n = len(segs)
    if not n:
        return []
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    for i in range(n):
        a = segs[i]
        for j in range(i + 1, n):
            b = segs[j]
            tol = tol_frac * min(a["len"], b["len"])
            if a[key0] <= b[key1] + tol and b[key0] <= a[key1] + tol:
                union(i, j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(segs[i])
    return list(groups.values())


def _segments_global(ink):
    """提取全图 7 段码线段（细长墨迹连通块）。

    过滤规则：面积下限、长度下限、长宽比（必须细长，排除标签/色块/文字块）、填充率。
    """
    h, w = ink.shape
    n, _labels, stats, cents = cv2.connectedComponentsWithStats(ink, connectivity=8)
    min_len = max(8.0, 0.05 * min(h, w))
    min_area = max(60, int(0.0001 * w * h))
    segs = []
    for i in range(1, n):
        x, y, bw, bh, area = (int(v) for v in stats[i])
        if area < min_area:
            continue
        long_side, short_side = max(bw, bh), min(bw, bh)
        if long_side < min_len:
            continue
        if short_side > 0.34 * long_side:
            continue
        if area / float(max(1, bw * bh)) > 0.96:
            continue
        if bw >= 2.0 * bh:
            ori = "H"
        elif bh >= 2.0 * bw:
            ori = "V"
        else:
            continue
        segs.append({"x": x, "y": y, "w": bw, "h": bh, "area": area,
                     "cx": float(cents[i][0]), "cy": float(cents[i][1]), "ori": ori,
                     "x0": x, "x1": x + bw - 1, "y0": y, "y1": y + bh - 1,
                     "len": float(long_side)})
    return segs


def _cluster_digit_cells(segs, x_gap_tol):
    """把同一位数字的线段按 x 区间重叠聚成一位，返回 digit cell 列表。"""
    segs = [s for s in segs if s["ori"] in ("H", "V")]
    n = len(segs)
    if not n:
        return []
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri

    for i in range(n):
        for j in range(i + 1, n):
            a, b = segs[i], segs[j]
            if a["x0"] <= b["x1"] + x_gap_tol and b["x0"] <= a["x1"] + x_gap_tol:
                union(i, j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(segs[i])
    cells = []
    for g in groups.values():
        x0 = min(s["x0"] for s in g)
        x1 = max(s["x1"] for s in g)
        y0 = min(s["y"] for s in g)
        y1 = max(s["y"] + s["h"] - 1 for s in g)
        cells.append({"x0": x0, "x1": x1, "y0": y0, "y1": y1,
                      "w": x1 - x0 + 1, "h": y1 - y0 + 1, "segs": g})
    cells.sort(key=lambda c: c["x0"])
    return cells


def _classify_cell(cell):
    """按线段清单分类单个 7 段码数字，返回 (digit|None, diff, present)。"""
    segs = cell["segs"]
    w = float(cell["w"])
    h = float(cell["h"])
    h_segs = [s for s in segs if s["ori"] == "H"]
    v_segs = [s for s in segs if s["ori"] == "V"]
    present = set()
    # 局部坐标
    lx0, ly0 = cell["x0"], cell["y0"]
    for s in h_segs:
        fy = (s["cy"] - ly0) / h
        if fy < 0.34:
            present.add("a")
        elif fy < 0.67:
            present.add("g")
        else:
            present.add("d")
    for s in v_segs:
        fy = (s["cy"] - ly0) / h
        fx = (s["cx"] - lx0) / w
        if fx < 0.5:
            present.add("f" if fy < 0.5 else "e")
        else:
            present.add("b" if fy < 0.5 else "c")
    # 特殊：没有横段、只有 1~2 根竖/斜段 -> 数字 1
    if not h_segs and 1 <= len(v_segs) <= 2:
        return "1", 0, present
    if not present:
        return None, 99, present
    best, best_diff = None, 99
    for digit, seg_set in _SEG7.items():
        diff = len(present ^ seg_set)
        if diff < best_diff:
            best, best_diff = digit, diff
    if best_diff > 1:
        return None, best_diff, present
    return best, best_diff, present


def _rows_from_ink(ink):
    """从二值墨迹图提取 7 段码数字行。

    不再依赖"行投影 + 行带"（右侧标签/角标会把相邻数字行连成一个大行带，
    导致行高虚高、线段长度阈值失真）；改为：
    1. 全图提取细长线段（连通块）；
    2. 按 y 区间重叠把线段聚成"数字行"；
    3. 行内按 x 区间重叠聚成"位"；
    4. 位内按 a~g 段位清单分类。
    """
    h = ink.shape[0]
    segs = _segments_global(ink)
    if not segs:
        return []
    rows = []
    for grp in _cluster_segments(segs, "y0", "y1", 0.15):
        gy0 = min(s["y0"] for s in grp)
        gy1 = max(s["y1"] for s in grp)
        gh = gy1 - gy0 + 1
        if gh < 0.10 * h or gh > 0.55 * h:
            continue  # 太矮（噪声/文字）或太高（多行被合并）
        # 行内按 x 重叠聚位
        cells = []
        for cg in _cluster_segments(grp, "x0", "x1", 0.05):
            cx0 = min(s["x0"] for s in cg)
            cx1 = max(s["x1"] for s in cg)
            cy0 = min(s["y0"] for s in cg)
            cy1 = max(s["y1"] for s in cg)
            cells.append({"x0": cx0, "x1": cx1, "y0": cy0, "y1": cy1,
                          "w": cx1 - cx0 + 1, "h": cy1 - cy0 + 1, "segs": cg})
        cells.sort(key=lambda c: c["x0"])
        digits = []
        for cell in cells:
            if cell["h"] < 0.60 * gh:  # 位高应接近行高（标签/电池图标过滤）
                continue
            if cell["w"] < max(6, int(0.02 * gh)):
                continue
            if cell["w"] > 1.25 * gh:
                continue
            d, diff, present = _classify_cell(cell)
            if d is None:
                continue
            cell["digit"] = d
            cell["diff"] = diff
            cell["present"] = "".join(sorted(present))
            digits.append(cell)
        if not (2 <= len(digits) <= 3):
            continue  # 血压计数值为 2~3 位
        heights = [c["h"] for c in digits]
        if max(heights) > 1.35 * min(heights):
            continue
        y_tops = [c["y0"] for c in digits]
        if max(y_tops) - min(y_tops) > 0.35 * gh:
            continue
        digits.sort(key=lambda c: c["x0"])
        val = "".join(c["digit"] for c in digits)
        diffs = sum(c["diff"] for c in digits)
        conf = max(0.35, 0.94 - 0.06 * diffs - 0.02 * (len(digits) - 2))
        y_center = sum((c["y0"] + c["y1"]) / 2.0 for c in digits) / len(digits)
        rows.append({"digits": val, "conf": round(conf, 2), "y": float(y_center),
                     "cells": digits})
    rows.sort(key=lambda r: r["y"])
    dedup = []
    for r in rows:
        if dedup and r["y"] - dedup[-1]["y"] < 0.5 * min(r["cells"][0]["h"],
                                                          dedup[-1]["cells"][0]["h"]):
            if r["conf"] > dedup[-1]["conf"]:
                dedup[-1] = r
            continue
        dedup.append(r)
    return dedup


def _read_7seg_rows(warped_bgr, fixed_thr=None):
    """在矫正后的屏幕图上识别 7 段码数字行。

    参数:
        warped_bgr: 屏幕区域图（BGR）
        fixed_thr: 非 None 时用固定灰度阈值取深色数字（用于整图兜底，
                   Otsu 在背景多峰时可能把屏幕底色也当墨迹）
    返回 {"rows": [{"digits": "152", "conf": 0.93, "y": 222, "cells": [...]}],
          "ink_ratio": float, "polarity": "dark_on_light"|"light_on_dark"}
    """
    gray = cv2.cvtColor(warped_bgr, cv2.COLOR_BGR2GRAY)
    if float(gray.mean()) < 110.0:  # 反色屏幕：浅色数字 + 深色底
        ink = (gray > (150 if fixed_thr is None else max(60, 255 - fixed_thr))).astype(np.uint8)
        polarity = "light_on_dark"
    elif fixed_thr is not None:
        ink = (gray < fixed_thr).astype(np.uint8)
        polarity = "dark_on_light"
    else:
        thr, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        ink = (gray < thr).astype(np.uint8)
        polarity = "dark_on_light"
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    ink_ratio = float(ink.mean())
    rows = _rows_from_ink(ink)
    return {"rows": rows, "ink_ratio": ink_ratio, "polarity": polarity}


def _rows_to_candidate(rows, labels, label_map):
    """把数字行映射成 收缩压/舒张压/脉率。rows 已按 y 排序。

    labels: [{'text','box','yc',...}]（原图坐标）
    label_map: {'systolic': [...keywords], 'diastolic': [...], 'pulse': [...]}
    返回 (candidate dict | None, evidence str)
    """
    if len(rows) < 2:
        return None, "数字行不足"
    assign = {}
    if labels:
        # 每个标签的中心 y 与行中心 y 最近匹配
        for role, kws in label_map.items():
            best = None
            for lab in labels:
                txt = lab["text"].replace(" ", "")
                if any(k in txt for k in kws):
                    # 只取 y 方向最接近的行
                    for row in rows:
                        dy = abs(lab["_yc_warp"] - row["y"])
                        if best is None or dy < best[0]:
                            best = (dy, row)
            if best is not None:
                dy, row = best
                # 距离过大不采纳
                if dy < 0.9 * max(c["h"] for c in row["cells"]):
                    assign.setdefault(role, row)
    if len({id(v) for v in assign.values()}) == len(assign):
        pass  # 各角色行不重复
    order_roles = ["systolic", "diastolic", "pulse"]
    used_ids = {id(r) for r in assign.values()}
    # 补全：按顺序取未被占用的行
    for role in order_roles:
        if role in assign:
            continue
        for row in rows:
            if id(row) in used_ids:
                continue
            assign[role] = row
            used_ids.add(id(row))
            break

    def val(role):
        row = assign.get(role)
        if row is None:
            return None
        try:
            return int(row["digits"])
        except ValueError:
            return None

    sys_v, dia_v, pulse_v = val("systolic"), val("diastolic"), val("pulse")
    # 合理性校验：收缩压 > 舒张压，范围合理
    def ok_sys(x):
        return x is not None and 50 <= x <= 300

    def ok_dia(x):
        return x is not None and 20 <= x <= 200

    def ok_pulse(x):
        return x is not None and 20 <= x <= 250

    if not ok_sys(sys_v) or not ok_dia(dia_v) or sys_v <= dia_v:
        # 退回"行序优先"的固定布局：第 1 行收缩压、第 2 行舒张压、第 3 行脉率
        if not rows:
            return None, "无可解析数字"
        try:
            sys_v = int(rows[0]["digits"])
            dia_v = int(rows[1]["digits"]) if len(rows) > 1 else None
            pulse_v = int(rows[2]["digits"]) if len(rows) > 2 else None
        except ValueError:
            return None, "数字解析失败"
        if not ok_dia(dia_v) or sys_v <= dia_v:
            return None, "数值不合理: %s/%s" % (sys_v, dia_v)
        pulse_v = pulse_v if ok_pulse(pulse_v) else None
        evidence = "7seg 行序: %s" % " / ".join(r["digits"] for r in rows[:3])
    else:
        pulse_v = pulse_v if ok_pulse(pulse_v) else None
        parts = []
        for role, cn in (("systolic", "收缩压"), ("diastolic", "舒张压"), ("pulse", "脉率")):
            if role in assign:
                parts.append("%s=%s" % (cn, assign[role]["digits"]))
        evidence = "7seg 标签映射: " + ", ".join(parts)

    sr = assign.get("systolic")
    conf = 0.9 if sr is not None else 0.8
    if len(rows) >= 3:
        conf = min(r["conf"] for r in rows[:3])
    high = [r for r in rows if r["conf"] >= 0.8]
    conf = round(min(conf, 0.95), 2) if high else round(conf * 0.9, 2)
    return {"systolic": sys_v, "diastolic": dia_v, "pulse": pulse_v,
            "measured_at": None, "confidence": conf, "evidence": evidence}, evidence


_MONITOR_LABEL_KW = {
    "systolic": ["高压", "收缩压", "收缩", "SYS", "SYS.", "SBP"],
    "diastolic": ["低压", "舒张压", "舒张", "DIA", "DIA.", "DBP"],
    "pulse": ["脉率", "脉搏", "心率", "PULSE", "PUL", "HR"],
}


def _rot_transform(kind, shape):
    """返回把 warp 图旋转 kind 后的坐标合成矩阵（原图 -> 旋转后图）。"""
    h, w = shape[:2]
    if kind == "cw":
        return np.array([[0, -1, h - 1], [1, 0, 0], [0, 0, 1]], np.float32)
    if kind == "ccw":
        return np.array([[0, 1, 0], [-1, 0, w - 1], [0, 0, 1]], np.float32)
    if kind == "180":
        return np.array([[-1, 0, w - 1], [0, -1, h - 1], [0, 0, 1]], np.float32)
    return np.eye(3, dtype=np.float32)


def _read_7seg_best(warped, m):
    """在 4 种朝向中挑选 7 段码数字行最多/最可信的一种。

    返回 (rows, seg, transform_3x3, orientation)。
    """
    variants = [("none", warped, m)]
    for kind, rot in (("cw", cv2.ROTATE_90_CLOCKWISE),
                      ("ccw", cv2.ROTATE_90_COUNTERCLOCKWISE),
                      ("180", cv2.ROTATE_180)):
        try:
            variants.append((kind, cv2.rotate(warped, rot), None))
        except Exception:
            pass
    best = None
    for kind, img, base_m in variants:
        try:
            seg = _read_7seg_rows(img)
        except Exception:
            continue
        # 变换矩阵（原图坐标 -> 当前朝向坐标）
        if kind == "none":
            trans = base_m
        else:
            trans = np.dot(_rot_transform(kind, warped.shape), m) if m is not None else None
        rows = seg["rows"]
        score = len(rows) * 100.0 + sum(len(r["digits"]) for r in rows) * 10.0
        # 优先 2~3 行（血压计通常三行）
        if 2 <= len(rows) <= 3:
            score += 25.0
        if best is None or score > best[0]:
            best = (score, rows, seg, trans, kind)
    if best is None:
        return [], {"rows": []}, m, "none"
    return best[1], best[2], best[3], best[4]


def _row_score(rows):
    """数字行识别结果打分：行数越高越好，2~3 行（血压计典型布局）加分。"""
    if not rows:
        return 0.0
    score = len(rows) * 100.0 + sum(len(r["digits"]) for r in rows) * 10.0
    if 2 <= len(rows) <= 3:
        score += 25.0
    return score


def _pick_screen_read(cands):
    """在多个候选屏幕区域中挑选 7 段码识别结果最好的一个。

    先试每块屏幕的正置方向；若都没拿到 >=2 行，再对每个候选尝试 4 种朝向。
    返回 dict(warped, info, name, rows, transform, orientation, seg) 或 None。
    """
    best = None
    for cand in cands:
        try:
            seg = _read_7seg_rows(cand["warped"])
        except Exception:
            continue
        rows = seg["rows"]
        score = _row_score(rows) + (5.0 if cand["name"].startswith("green") else 0.0)
        if best is None or score > best[0]:
            best = (score, cand, rows, cand["info"].get("transform"), "none", seg)
    if best is not None and best[0] >= 200.0:
        return {"warped": best[1]["warped"], "info": best[1]["info"],
                "name": best[1]["name"], "rows": best[2],
                "transform": best[3], "orientation": best[4], "seg": best[5]}
    # 正置失败：逐个候选尝试旋转
    best = None
    for cand in cands:
        try:
            rows, seg, trans, orient = _read_7seg_best(cand["warped"],
                                                       cand["info"].get("transform"))
        except Exception:
            continue
        score = _row_score(rows) + (5.0 if cand["name"].startswith("green") else 0.0)
        if best is None or score > best[0]:
            best = (score, cand, rows, trans, orient, seg)
    if best is None:
        return None
    return {"warped": best[1]["warped"], "info": best[1]["info"], "name": best[1]["name"],
            "rows": best[2], "transform": best[3], "orientation": best[4], "seg": best[5]}


def _recognize_monitor(cands, ocr_lines, ocr_scale, debug=False, picked=None):
    """血压计照片识别。ocr_lines 为原图坐标；ocr_scale 为 OCR 缩放。

    返回 dict（candidates 可能为空，表示是血压计照片但数值解析失败），或 None。
    """
    if picked is None:
        picked = _pick_screen_read(cands)
    if picked is None:
        return None
    warped = picked["warped"]
    winfo = picked["info"]
    rows = picked["rows"]
    trans = picked["transform"]
    orientation = picked["orientation"]
    if debug:
        _dbg_write("01_screen_warp.png", warped)
    # OCR 文本坐标 -> 矫正图坐标（用于标签定位）
    labels = []
    if trans is not None and ocr_lines:
        for lab in ocr_lines:
            xc = lab["xc"] / ocr_scale
            yc = lab["yc"] / ocr_scale
            try:
                pt = cv2.perspectiveTransform(np.array([[[xc, yc]]], np.float32), trans)[0][0]
            except Exception:
                continue
            labels.append({**lab, "_xc_warp": float(pt[0]), "_yc_warp": float(pt[1])})
    cand, evidence = _rows_to_candidate(rows, labels, _MONITOR_LABEL_KW)
    if cand is None:
        # 7 段码失败时，尝试用 OCR 直接识别数字大字号文本
        cand = _monitor_candidate_from_ocr(ocr_lines, ocr_scale)
        if cand is None:
            return {
                "image_type": "monitor",
                "candidates": [],
                "message": "检测到血压计屏幕（%s），但 7 段码识别失败（%s）" % (
                    picked.get("name", "?"), evidence or "无有效数字行"),
                "screen_info": winfo,
                "rows": [r["digits"] for r in rows],
                "_rows": len(rows),
            }
    cand["evidence"] = "screen=%s area=%.1f%% rot=%.1f° orient=%s rows=%s; %s" % (
        picked.get("name", "?"), winfo["area_ratio"] * 100.0, winfo["rect"][2],
        orientation, [r["digits"] for r in rows] or "-", cand["evidence"])
    cand["confidence"] = round(min(0.95, max(0.4, cand["confidence"] + 0.02)), 2)
    return {
        "image_type": "monitor",
        "candidates": [cand],
        "message": "血压计屏幕识别成功: %s/%s%s" % (
            cand["systolic"], cand["diastolic"],
            "" if cand["pulse"] is None else " 脉率%s" % cand["pulse"]),
        "screen_info": winfo,
        "rows": [r["digits"] for r in rows],
        "_rows": len(rows),
    }


def _monitor_candidate_from_ocr(ocr_lines, ocr_scale):
    """OCR 直读数字的兜底（非 7 段码字体或 7 段码分割失败时）。"""
    if not ocr_lines:
        return None
    nums = []
    for lab in ocr_lines:
        txt = lab["text"].strip()
        m = re.fullmatch(r"[^0-9]{0,4}(\d{2,3})[^0-9]{0,4}", txt)
        if not m:
            continue
        val = int(m.group(1))
        nums.append((lab["yc"], val, lab["score"]))
    if len(nums) < 2:
        return None
    nums.sort()
    vals = [v for _, v, _ in nums]
    if len(vals) >= 3:
        sys_v, dia_v, pulse_v = vals[0], vals[1], vals[2]
    else:
        sys_v, dia_v = vals[0], vals[1]
        pulse_v = None
    if not (50 <= sys_v <= 300 and 20 <= dia_v <= 200 and sys_v > dia_v):
        return None
    conf = round(sum(s for _, _, s in nums[:3]) / max(1, min(3, len(nums))), 2)
    return {"systolic": sys_v, "diastolic": dia_v, "pulse": pulse_v,
            "measured_at": None, "confidence": conf,
            "evidence": "OCR 数字行: %s" % vals[:3]}


def _monitor_fallback_unaligned(base_bgr, ocr_lines, ocr_scale):
    """没有找到绿色液晶屏时（白屏/蓝白屏等）在整图上直接尝试 7 段码兜底。

    只在整图内容已大致正置时有意义；倾斜照片会退化为 OCR 数字兜底。
    """
    rows = []
    for fixed_thr in (None, 130, 110, 150):
        try:
            rows = _read_7seg_rows(base_bgr, fixed_thr=fixed_thr)["rows"]
        except Exception:
            rows = []
        if len(rows) >= 2:
            break
    cand = None
    if len(rows) >= 2:
        labels = [{**lab, "_xc_warp": lab["xc"] / ocr_scale,
                   "_yc_warp": lab["yc"] / ocr_scale} for lab in ocr_lines]
        cand, _ev = _rows_to_candidate(rows, labels, _MONITOR_LABEL_KW)
    if cand is not None:
        cand["evidence"] = "整图 7 段码兜底: " + cand["evidence"]
        return cand
    cand = _monitor_candidate_from_ocr(ocr_lines, ocr_scale)
    if cand is not None:
        cand["evidence"] = "OCR 数字行兜底: " + cand["evidence"]
    return cand


# ===========================================================================
# 二、手机 App 历史记录截图识别
# ===========================================================================
_BP_PAT = re.compile(r"(\d{2,3})\s*[/／]\s*(\d{2,3})")
_DATE_FULL_PAT = re.compile(
    r"(?P<y>20\d{2})\s*[/\-.年]\s*(?P<mo>\d{1,2})\s*[/\-.月]\s*(?P<d>\d{1,2})\s*日?"
    r"(?:\s*(?P<hh>\d{1,2})\s*[:：]\s*(?P<mi>\d{2})(?:\s*[:：]\s*(?P<ss>\d{2}))?)?")
_DATE_MD_PAT = re.compile(
    r"(?P<mo>\d{1,2})\s*[/\-月]\s*(?P<d>\d{1,2})\s*日?"
    r"\s*(?P<hh>\d{1,2})\s*[:：]\s*(?P<mi>\d{2})(?:\s*[:：]\s*(?P<ss>\d{2}))?")
_SCREENSHOT_KW = ["历史测量数据", "历史记录", "测量记录", "测量历史", "收缩压最高值",
                  "舒张压最高值", "收缩压平均", "舒张压平均", "正常血压结果", "高血压结果"]
_PULSE_KW = ["脉率", "脉搏", "心率", "PULSE"]
_STATS_KW = ["最高值", "平均值", "正常血压结果", "高血压结果", "统计"]


def _parse_datetime_match(m):
    """把正则 match 转成 dict；缺时间返回 None（不猜测）。"""
    hh = m.group("hh") if "hh" in m.groupdict() else None
    if hh is None:
        return None
    mi = int(m.group("mi"))
    ss = int(m.group("ss") or 0)
    try:
        return {"year": int(m.group("y")) if "y" in m.groupdict() and m.group("y") else None,
                "month": int(m.group("mo")), "day": int(m.group("d")),
                "hour": int(hh), "minute": mi, "second": ss}
    except (ValueError, TypeError):
        return None


def _extract_dates(text):
    """从一段文本中提取日期时间候选，返回 [dict]（全日期优先）。"""
    out = []
    for m in _DATE_FULL_PAT.finditer(text):
        dt = _parse_datetime_match(m)
        if dt is not None:
            out.append(dt)
    if not out:
        for m in _DATE_MD_PAT.finditer(text):
            dt = _parse_datetime_match(m)
            if dt is not None:
                out.append(dt)
    return out


def _format_iso(dt, tzinfo):
    try:
        return datetime(dt["year"], dt["month"], dt["day"], dt["hour"],
                        dt["minute"], dt["second"], tzinfo=tzinfo).isoformat()
    except ValueError:
        return None


def _line_text_no_bp(text):
    return _BP_PAT.sub(" ", text)


def _find_best_date(rec_box, date_items, used, line_h):
    """在记录附近找日期候选（通常在其下一行）。"""
    rx0, ry0, rx1, ry1 = rec_box
    best = None
    for idx, item in enumerate(date_items):
        if idx in used:
            continue
        x0, y0, x1, y1 = item["box"]
        xc = (x0 + x1) / 2.0
        yc = (y0 + y1) / 2.0
        if yc < ry0 - 0.35 * line_h or yc > ry1 + 2.0 * line_h:
            continue
        if xc < rx0 - 2.0 * line_h or xc > rx1 + 2.0 * line_h:
            continue
        dy = abs(yc - (ry1 + 0.5 * line_h))
        score = dy + 0.15 * abs(xc - rx0)
        if best is None or score < best[0]:
            best = (score, idx, item)
    if best is None:
        return None
    return best[1], best[2]


def _recognize_screenshot(ocr_lines, img_w, img_h):
    """解析 App 历史记录截图。返回 dict 或 None（不是截图）。"""
    if not ocr_lines:
        return None
    tzinfo = _tzinfo()
    lines = sorted(ocr_lines, key=lambda l: (l["box"][1], l["box"][0]))
    full_text = "\n".join(l["text"] for l in lines)
    has_screenshot_kw = any(k in full_text for k in _SCREENSHOT_KW)

    # 历史记录区域起点：找到"历史测量数据"等标题，只解析其下方
    cutoff_y = None
    for lab in lines:
        txt = lab["text"].replace(" ", "")
        if any(k in txt for k in ("历史测量数据", "历史记录", "测量记录", "测量历史")):
            cutoff_y = lab["box"][3]
    # 收集所有日期候选（带框）
    date_items = []
    for lab in lines:
        for dt in _extract_dates(lab["text"]):
            date_items.append({"dt": dt, "box": lab["box"], "text": lab["text"],
                               "score": lab["score"]})
    years = [d["dt"]["year"] for d in date_items if d["dt"].get("year")]
    dominant_year = None
    if years:
        dominant_year = max(set(years), key=years.count)
    if dominant_year is None:
        dominant_year = datetime.now().year

    # 收集血压记录
    records = []
    for lab in lines:
        text = lab["text"]
        x0, y0, x1, y1 = lab["box"]
        if cutoff_y is not None and y0 < cutoff_y - 2:
            continue
        m = _BP_PAT.search(text)
        if not m:
            continue
        sys_v, dia_v = int(m.group(1)), int(m.group(2))
        if not (50 <= sys_v <= 300 and 20 <= dia_v <= 200 and sys_v > dia_v):
            continue
        line_h = max(10.0, y1 - y0)
        rec = {"systolic": sys_v, "diastolic": dia_v, "box": lab["box"],
               "text": text, "score": lab["score"],
               "dates": _extract_dates(text), "date_line": None}
        if not rec["dates"]:
            # 同一行里去掉血压后可能还有日期
            rec["dates"] = _extract_dates(_line_text_no_bp(text))
        records.append(rec)
    # 去重（同一记录被 OCR 重复识别）
    dedup = []
    for rec in records:
        dup = None
        for prev in dedup:
            if prev["systolic"] == rec["systolic"] and prev["diastolic"] == rec["diastolic"]:
                dy = abs(prev["box"][1] - rec["box"][1])
                if dy < 1.5 * max(rec["box"][3] - rec["box"][1],
                                  prev["box"][3] - prev["box"][1], 10):
                    dup = prev
        if dup is None:
            dedup.append(rec)
        elif rec["score"] > dup["score"]:
            dedup[dedup.index(dup)] = rec
    records = dedup
    if not records:
        return None
    records.sort(key=lambda r: r["box"][1])

    # 日期关联：优先同行，其次下一行
    used_dates = set()
    for rec in records:
        line_h = max(10.0, rec["box"][3] - rec["box"][1])
        if rec["dates"]:
            rec["dt"] = rec["dates"][0]
            # 同行日期不再分配给其它记录（尽量按文本唯一）
            continue
        found = _find_best_date(rec["box"], date_items, used_dates, line_h)
        if found is not None:
            idx, item = found
            used_dates.add(idx)
            rec["dt"] = item["dt"]
            rec["date_line"] = item["text"]
    # 脉率（截图里一般不显示，有就挂上）
    pulse_items = []
    for lab in lines:
        txt = lab["text"]
        if any(k in txt for k in _PULSE_KW):
            nums = re.findall(r"\d{2,3}", txt)
            if nums:
                pulse_items.append({"yc": lab["yc"], "pulse": int(nums[-1]),
                                    "score": lab["score"]})
    for rec in records:
        if "dt" not in rec:
            rec["dt"] = None
        if pulse_items and "pulse" not in rec:
            cy = (rec["box"][1] + rec["box"][3]) / 2.0
            near = min(pulse_items, key=lambda p: abs(p["yc"] - cy))
            line_h = max(10.0, rec["box"][3] - rec["box"][1])
            if abs(near["yc"] - cy) < 3.0 * line_h:
                rec["pulse"] = near["pulse"]
    # 误动标签（新版 App 会在记录行右侧显示"误动"小标签；OCR 可能按单字切分）
    tag_lines = []
    for lab in lines:
        t = lab["text"].replace(" ", "")
        if "误动" in t or t in ("误", "动"):
            tag_lines.append(lab)
    for rec in records:
        if not tag_lines:
            break
        ry0, ry1 = rec["box"][1], rec["box"][3]
        rec_cy = (ry0 + ry1) / 2.0
        line_h = max(10.0, ry1 - ry0)
        best = None
        for lab in tag_lines:
            lyc = lab["yc"]
            if abs(lyc - rec_cy) < 1.2 * line_h:
                d = abs(lyc - rec_cy)
                if best is None or d < best[0]:
                    best = (d, lab)
        if best is not None:
            rec["tag"] = "误动"
    # 组装 candidates
    candidates = []
    for rec in records:
        dt = rec.get("dt")
        measured_at = None
        conf = float(rec["score"])
        if dt:
            if dt.get("year") is None:
                dt["year"] = dominant_year
            measured_at = _format_iso(dt, tzinfo)
            if measured_at is not None:
                conf = min(conf, 0.90 if rec["date_line"] else 0.95)
        else:
            conf = min(conf, 0.80)
        evidence_parts = ["OCR=%r y=%d" % (rec["text"], int(rec["box"][1]))]
        if rec.get("date_line"):
            evidence_parts.append("date_ocr=%r" % rec["date_line"])
        elif dt:
            evidence_parts.append("date_inline")
        else:
            evidence_parts.append("date_truncated/missing")
        if rec.get("tag"):
            evidence_parts.append("tag=%s" % rec["tag"])
        candidates.append({
            "systolic": rec["systolic"],
            "diastolic": rec["diastolic"],
            "pulse": rec.get("pulse"),
            "measured_at": measured_at,
            "confidence": round(conf, 2),
            "evidence": "; ".join(evidence_parts),
        })
    n_dated = sum(1 for c in candidates if c["measured_at"])
    n_tag = sum(1 for c in candidates if "tag=误动" in c["evidence"])
    msg = "App 历史截图解析到 %d 条记录（%d 条含日期时间%s）" % (
        len(candidates), n_dated, "，%d 条标注误动" % n_tag if n_tag else "")
    if not has_screenshot_kw and len(candidates) < 2:
        return None
    return {"image_type": "screenshot", "candidates": candidates, "message": msg,
            "_tagged": n_tag}


# ===========================================================================
# 主入口
# ===========================================================================
def is_available() -> bool:
    """检查依赖（numpy/opencv/Pillow/rapidocr-onnxruntime）是否可用。"""
    if not (_CV_OK and _PIL_OK):
        return False
    if _ENGINE_ERR:
        return False
    return _get_engine() is not None


def recognize_image(path: str) -> dict:
    """识别一张血压图片，返回契约 dict（不抛异常）。

    参数:
        path: 图片路径（jpg/png/bmp/webp 等，支持 EXIF 方向）
    返回:
        {"engine": "rapidocr", "image_type": "monitor"|"screenshot"|"unknown",
         "candidates": [...], "raw_text": [...], "message": "..."}
    """
    t0 = time.time()
    out = {"engine": ENGINE_NAME, "image_type": "unknown",
           "candidates": [], "raw_text": [], "message": ""}
    if not (_CV_OK and _PIL_OK):
        out["message"] = "依赖缺失: %s %s" % (_CV_ERR, _PIL_ERR)
        return out
    if not path:
        out["message"] = "路径为空"
        return out
    if not os.path.isfile(path):
        out["message"] = "文件不存在: %s" % path
        return out
    timing = {}
    try:
        t_load = time.time()
        full = _load_bgr(path)
        base, base_scale = _resize_max(full, 2400)
        timing["load"] = round((time.time() - t_load) * 1000.0, 1)

        # 1) 屏幕候选 + 7 段码识别（纯 opencv，廉价）：拿到 >=2 行数字才认定 monitor
        t_screen = time.time()
        screen_cands = []
        picked = None
        try:
            screen_cands = _screen_candidates(base)
            if screen_cands:
                picked = _pick_screen_read(screen_cands)
        except Exception:
            picked = None
        timing["screen"] = round((time.time() - t_screen) * 1000.0, 1)

        ocr_lines = []
        res = None
        if picked is not None and len(picked["rows"]) >= 2:
            # 显示器照片：OCR 只用于标签/文本，长边 1600 足够
            ocr_img, ocr_scale = _resize_max(base, 1600)
            t_ocr = time.time()
            ocr_lines = _ocr(ocr_img)
            timing["ocr"] = round((time.time() - t_ocr) * 1000.0, 1)
            res = _recognize_monitor(screen_cands, ocr_lines, ocr_scale,
                                     debug=_debug_enabled(), picked=picked)
            _finalize(out, res, ocr_lines)
        else:
            # 2) 截图/普通图片：长图保持原分辨率（缩太小 OCR 会读不准小字）；
            #    超大图仅限制到长边 4000，避免内存/耗时失控
            ocr_img, ocr_scale = _resize_max(full, 4000)
            t_ocr = time.time()
            ocr_lines = _ocr(ocr_img)
            timing["ocr"] = round((time.time() - t_ocr) * 1000.0, 1)
            if not ocr_lines:
                out["message"] = "未在图片中检测到文字"
            else:
                res = _recognize_screenshot(ocr_lines, full.shape[1], full.shape[0])
                if res is None:
                    full_text = "\n".join(l["text"] for l in ocr_lines)
                    if any(k in full_text for k in _MONITOR_LABEL_KW["systolic"]
                           + _MONITOR_LABEL_KW["diastolic"]):
                        # 屏幕定位失败但疑似血压计：整图 7 段码 -> OCR 数字兜底
                        adj = max(1e-6, ocr_scale / max(1e-6, base_scale))
                        cand = _monitor_fallback_unaligned(base, ocr_lines, adj)
                        res = {"image_type": "monitor",
                               "candidates": [cand] if cand else [],
                               "message": "疑似血压计照片（未找到 7 段码屏幕）：%s" %
                                          ("兜底识别成功" if cand else "无法解析数值")}
                    else:
                        res = {"image_type": "unknown", "candidates": [],
                               "message": "未识别为血压计屏幕或 App 历史截图"}
                _finalize(out, res, ocr_lines)
    except Exception as exc:  # 契约要求：异常输入不抛异常
        out["message"] = "识别失败: %s: %s" % (type(exc).__name__, exc)
    timing["total"] = round((time.time() - t0) * 1000.0, 1)
    if _debug_enabled():
        out["debug"] = dict(out.get("debug", {}), timing=timing)
    return out


def _finalize(out, res, ocr_lines):
    """把内部结果合并进契约输出（剔除内部字段）。"""
    out["image_type"] = res.get("image_type", "unknown")
    out["candidates"] = res.get("candidates", [])
    out["raw_text"] = [l["text"] for l in ocr_lines]
    out["message"] = res.get("message", "")
    if res.get("screen_info") and _debug_enabled():
        si = res["screen_info"]
        out["debug"] = {"screen_rect": si.get("rect"),
                        "screen_area_ratio": si.get("area_ratio"),
                        "seven_seg_rows": res.get("rows")}
