"""统计汇总。"""
from collections import defaultdict

from ..config import SLOT_ORDER


def _avg(values):
    values = [v for v in values if v is not None]
    if not values:
        return None
    return round(sum(values) / len(values), 1)


def _median(values):
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    mid = len(values) // 2
    if len(values) % 2:
        return float(values[mid])
    return round((values[mid - 1] + values[mid]) / 2, 1)


def classify(systolic: int, diastolic: int) -> str:
    if systolic < 120 and diastolic < 80:
        return "normal"
    if systolic < 140 and diastolic < 90:
        return "elevated"
    return "high"


def is_high(systolic: int, diastolic: int, settings: dict) -> bool:
    target_sys = int(settings.get("target_sys") or 135)
    target_dia = int(settings.get("target_dia") or 85)
    return systolic >= target_sys or diastolic >= target_dia


def summarize(rows) -> dict:
    """rows 为包含 systolic/diastolic/pulse/slot 的映射序列。"""
    row_list = list(rows)
    systolic = [r["systolic"] for r in row_list]
    diastolic = [r["diastolic"] for r in row_list]
    pulse = [r["pulse"] for r in row_list]
    return {
        "count": len(row_list),
        "avg_sys": _avg(systolic),
        "avg_dia": _avg(diastolic),
        "avg_pulse": _avg(pulse),
        "max_sys": max(systolic) if systolic else None,
        "min_sys": min(systolic) if systolic else None,
        "max_dia": max(diastolic) if diastolic else None,
        "min_dia": min(diastolic) if diastolic else None,
    }


def summarize_with_slots(rows) -> dict:
    row_list = list(rows)
    base = summarize(row_list)
    grouped: dict[str, list] = defaultdict(list)
    for row in row_list:
        grouped[row["slot"] or "other"].append(row)
    by_slot: dict[str, dict] = {}
    for key in SLOT_ORDER + ["other"]:
        items = grouped.get(key)
        if not items:
            continue
        by_slot[key] = {
            "count": len(items),
            "avg_sys": _avg([r["systolic"] for r in items]),
            "avg_dia": _avg([r["diastolic"] for r in items]),
            "avg_pulse": _avg([r["pulse"] for r in items]),
        }
    base["by_slot"] = by_slot
    return base


def stats_payload(rows, days: int, settings: dict) -> dict:
    row_list = list(rows)
    base = summarize_with_slots(row_list)
    classification = {"normal": 0, "elevated": 0, "high": 0}
    for row in row_list:
        classification[classify(row["systolic"], row["diastolic"])] += 1

    by_date: dict[str, list] = defaultdict(list)
    for row in row_list:
        by_date[row["local_date"]].append(row)

    series = []
    for day in sorted(by_date.keys()):
        items = by_date[day]
        series.append(
            {
                "date": day,
                "avg_sys": _avg([r["systolic"] for r in items]),
                "avg_dia": _avg([r["diastolic"] for r in items]),
                "avg_pulse": _avg([r["pulse"] for r in items]),
                "count": len(items),
            }
        )

    payload = {
        "days": days,
        "count": base["count"],
        "avg_sys": base["avg_sys"],
        "avg_dia": base["avg_dia"],
        "avg_pulse": base["avg_pulse"],
        "max_sys": base["max_sys"],
        "min_sys": base["min_sys"],
        "max_dia": base["max_dia"],
        "min_dia": base["min_dia"],
        "by_slot": base["by_slot"],
        "classification": classification,
        "series": series,
        "median_sys": _median([r["systolic"] for r in row_list]),
        "median_dia": _median([r["diastolic"] for r in row_list]),
        "high_count": sum(
            1 for r in row_list if is_high(r["systolic"], r["diastolic"], settings)
        ),
    }
    return payload
