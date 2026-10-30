"""首页聚合、统计与提醒接口（按 owner 隔离）。"""
from datetime import timedelta

from fastapi import APIRouter, Depends

from .. import db
from ..config import SLOT_LABELS
from ..schemas import SnoozeIn
from ..security import current_user, ensure_writable, owner_settings
from ..services.reminders import due_items, materialize_logs, snooze as snooze_reminder
from ..services.stats import is_high, summarize_with_slots, stats_payload
from ..timeutil import date_str, now_local, parse_date

router = APIRouter(prefix="/api", tags=["dashboard"], dependencies=[Depends(current_user)])


def _measurement_brief(row) -> dict | None:
    if row is None:
        return None
    return {
        "id": row["id"],
        "measured_at": row["measured_at"],
        "systolic": row["systolic"],
        "diastolic": row["diastolic"],
        "pulse": row["pulse"],
        "slot": row["slot"],
    }


def _rows_for_range(days: list[str], owner_id: int) -> list[dict]:
    if not days:
        return []
    conn = db.connect()
    try:
        placeholders = ",".join("?" for _ in days)
        rows = conn.execute(
            f"SELECT * FROM measurements WHERE owner_id = ? AND local_date IN ({placeholders}) ORDER BY measured_at ASC",
            [owner_id] + days,
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def _slot_summary(settings: dict, day: str, measurements: list[dict]) -> list[dict]:
    windows = settings.get("slot_windows") or {}
    times = settings.get("slot_times") or {}
    by_slot: dict[str, list] = {}
    for item in measurements:
        by_slot.setdefault(item.get("slot") or "other", []).append(item)
    result = []
    for key in ("morning", "forenoon", "afternoon", "bedtime"):
        if key not in windows:
            continue
        items = by_slot.get(key, [])
        last = max(items, key=lambda item: item["measured_at"]) if items else None
        result.append(
            {
                "key": key,
                "label": SLOT_LABELS.get(key, key),
                "window": windows[key],
                "target_time": times.get(key),
                "done": bool(items),
                "count": len(items),
                "last": _measurement_brief(last),
            }
        )
    return result


def _medlog_rows(day: str, owner_id: int, settings: dict) -> list[dict]:
    materialize_logs(day, owner_id, settings)
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT l.*, m.name, m.dose, m.unit FROM med_logs l JOIN medications m ON m.id = l.medication_id "
            "WHERE l.date = ? AND l.owner_id = ? AND m.owner_id = ? ORDER BY l.scheduled_time ASC",
            (day, owner_id, owner_id),
        ).fetchall()
    finally:
        conn.close()
    result = []
    for row in rows:
        result.append(
            {
                "id": row["id"],
                "medication_id": row["medication_id"],
                "name": row["name"],
                "dose": row["dose"],
                "unit": row["unit"],
                "date": row["date"],
                "scheduled_time": row["scheduled_time"],
                "status": row["status"],
                "taken_at": row["taken_at"],
                "note": row["note"],
            }
        )
    return result


@router.get("/dashboard")
def dashboard(date: str | None = None, patient_id: int | None = None, user: dict = Depends(current_user)):
    owner, settings = owner_settings(user, patient_id)
    target_day = parse_date(date, settings)
    day = target_day.isoformat()

    measurements = _rows_for_range([day], owner)
    today = now_local(settings).date()
    range_days = [(today - timedelta(days=i)).isoformat() for i in range(6, -1, -1)]
    week_rows = _rows_for_range(range_days, owner)
    week_stats = summarize_with_slots(week_rows)
    week_stats["high_count"] = sum(
        1 for row in week_rows if is_high(row["systolic"], row["diastolic"], settings)
    )

    conn = db.connect()
    try:
        latest_row = conn.execute(
            "SELECT * FROM measurements WHERE owner_id = ? ORDER BY measured_at DESC LIMIT 1", (owner,)
        ).fetchone()
    finally:
        conn.close()

    # 连续记录天数
    streak = 0
    check_day = today
    conn = db.connect()
    try:
        while True:
            exists = conn.execute(
                "SELECT 1 FROM measurements WHERE owner_id = ? AND local_date = ? LIMIT 1",
                (owner, check_day.isoformat()),
            ).fetchone()
            if not exists:
                break
            streak += 1
            check_day -= timedelta(days=1)
            if streak > 3650:
                break
    finally:
        conn.close()

    return {
        "date": day,
        "now": now_local(settings).isoformat(timespec="seconds"),
        "slots": _slot_summary(settings, day, measurements),
        "measurements_today": measurements,
        "latest": _measurement_brief(latest_row),
        "meds": _medlog_rows(day, owner, settings),
        "stats7": week_stats,
        "reminders": due_items(settings, owner),
        "streak_days": streak,
    }


@router.get("/stats")
def stats(days: int = 7, patient_id: int | None = None, user: dict = Depends(current_user)):
    owner, settings = owner_settings(user, patient_id)
    days = max(1, min(365, int(days)))
    today = now_local(settings).date()
    range_days = [(today - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    rows = _rows_for_range(range_days, owner)
    return stats_payload(rows, days, settings)


@router.get("/reminders")
def reminders(patient_id: int | None = None, user: dict = Depends(current_user)):
    owner, settings = owner_settings(user, patient_id)
    return {"items": due_items(settings, owner), "now": now_local(settings).isoformat(timespec="seconds")}


@router.post("/reminders/snooze")
def snooze(payload: SnoozeIn, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    settings = db.get_settings(owner)
    return snooze_reminder(owner, settings, payload.key, payload.minutes)
