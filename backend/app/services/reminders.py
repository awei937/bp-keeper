"""测量/服药提醒计算与推送（按用户 owner 隔离）。"""
import asyncio
import json
import logging
from datetime import datetime, timedelta

from .. import db
from ..config import SLOT_LABELS, SLOT_ORDER
from ..timeutil import date_str, get_tz, iso, minutes_of, now_local
from . import notify

logger = logging.getLogger("bp.reminders")

MED_GRACE_MINUTES = 180


# ---------------------------------------------------------------- helpers


def materialize_logs(day: str, owner_id: int, settings: dict | None = None) -> None:
    """为某用户某一天生成服药任务（幂等）。"""
    now = db.now_iso()
    owner = int(owner_id)
    conn = db.connect()
    try:
        meds = conn.execute(
            "SELECT * FROM medications WHERE owner_id = ? AND active = 1 AND start_date <= ? "
            "AND (end_date IS NULL OR end_date = '' OR end_date >= ?)",
            (owner, day, day),
        ).fetchall()
        for med in meds:
            try:
                times = json.loads(med["times"] or "[]")
            except json.JSONDecodeError:
                times = []
            for item in times:
                conn.execute(
                    "INSERT OR IGNORE INTO med_logs(owner_id, medication_id, date, scheduled_time, status, created_at) "
                    "VALUES(?, ?, ?, ?, 'pending', ?)",
                    (owner, med["id"], day, item, now),
                )
        conn.commit()
    finally:
        conn.close()


def _snoozed(events: dict, key: str, now: datetime) -> bool:
    event = events.get(key)
    if not event or not event["snooze_until"]:
        return False
    try:
        until = datetime.fromisoformat(event["snooze_until"])
    except ValueError:
        return False
    return until > now


def _today_events(conn, today: str, owner_id: int) -> dict:
    rows = conn.execute(
        "SELECT * FROM reminder_events WHERE owner_id = ? AND date = ?", (int(owner_id), today)
    ).fetchall()
    return {row["key"]: row for row in rows}


def _slot_target(day: str, hhmm: str, tz) -> datetime:
    hour, minute = hhmm.split(":")
    return datetime.fromisoformat(f"{day}T{hour}:{minute}:00").replace(tzinfo=tz)


# ---------------------------------------------------------------- due items


def due_items(settings: dict, owner_id: int) -> list[dict]:
    owner = int(owner_id)
    now = now_local(settings)
    today = date_str(now)
    tz = get_tz(settings)

    materialize_logs(today, owner, settings)
    conn = db.connect()
    try:
        events = _today_events(conn, today, owner)
        done_slots = {
            row["slot"]
            for row in conn.execute(
                "SELECT slot FROM measurements WHERE owner_id = ? AND local_date = ?", (owner, today)
            ).fetchall()
            if row["slot"]
        }
        pending_logs = conn.execute(
            "SELECT l.*, m.name, m.dose, m.unit FROM med_logs l "
            "JOIN medications m ON m.id = l.medication_id "
            "WHERE l.owner_id = ? AND m.owner_id = ? AND l.date = ? AND l.status = 'pending' "
            "ORDER BY l.scheduled_time",
            (owner, owner, today),
        ).fetchall()
    finally:
        conn.close()

    items: list[dict] = []
    if not settings.get("reminder_enabled", True):
        return items

    now_min = now.hour * 60 + now.minute
    windows = settings.get("slot_windows") or {}
    slot_times = settings.get("slot_times") or {}
    for slot in SLOT_ORDER:
        window = windows.get(slot)
        target = slot_times.get(slot)
        if not window or not target:
            continue
        start_min, end_min = minutes_of(window[0]), minutes_of(window[1])
        target_min = minutes_of(target)
        if now_min < target_min or now_min > end_min:
            continue
        if slot in done_slots:
            continue
        key = f"measure:{today}:{slot}"
        if _snoozed(events, key, now):
            continue
        label = SLOT_LABELS.get(slot, slot)
        items.append(
            {
                "kind": "measure",
                "key": key,
                "title": "该测血压了",
                "body": f"{label}（{window[0]}–{window[1]}）的血压还没记录",
                "due_at": iso(_slot_target(today, target, tz)),
                "slot": slot,
                "medlog_id": None,
            }
        )

    for log in pending_logs:
        scheduled = log["scheduled_time"]
        sched_min = minutes_of(scheduled)
        if now_min < sched_min or now_min > sched_min + MED_GRACE_MINUTES:
            continue
        key = f"med:{today}:{log['id']}"
        if _snoozed(events, key, now):
            continue
        dose = log["dose"]
        dose_text = f"{int(dose) if float(dose).is_integer() else dose}{log['unit']}"
        items.append(
            {
                "kind": "med",
                "key": key,
                "title": "该吃药了",
                "body": f"{log['name']} {dose_text}，计划 {scheduled}",
                "due_at": iso(_slot_target(today, scheduled, tz)),
                "slot": None,
                "medlog_id": log["id"],
            }
        )
    return items


# ---------------------------------------------------------------- snooze


def snooze(owner_id: int, settings: dict, key: str, minutes: int) -> dict:
    owner = int(owner_id)
    now = now_local(settings)
    today = date_str(now)
    until = now + timedelta(minutes=minutes)
    kind = "measure" if key.startswith("measure:") else "med"
    conn = db.connect()
    try:
        conn.execute(
            "INSERT INTO reminder_events(owner_id, date, key, kind, snooze_until) VALUES(?, ?, ?, ?, ?) "
            "ON CONFLICT(owner_id, date, key) DO UPDATE SET snooze_until = excluded.snooze_until",
            (owner, today, key, kind, iso(until)),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "key": key, "snooze_until": iso(until)}


# ---------------------------------------------------------------- push


def _notification_text(settings: dict, owner_id: int, display_name: str = "") -> tuple[str, str]:
    items = due_items(settings, owner_id)
    if not items:
        return "", ""
    titles = "；".join(item["title"] for item in items[:3])
    lines = [f"• {item['body']}" for item in items[:5]]
    if len(items) > 5:
        lines.append(f"…另有 {len(items) - 5} 项待办")
    prefix = f"{display_name} · " if display_name else ""
    return f"{prefix}血压管家提醒：{titles}", "\n".join(lines)


async def push_due_once(owner_id: int, settings: dict, display_name: str = "") -> list[dict]:
    owner = int(owner_id)
    if not settings.get("reminder_enabled", True):
        return []
    items = due_items(settings, owner)
    if not items:
        return []
    now = now_local(settings)
    today = date_str(now)

    conn = db.connect()
    try:
        events = _today_events(conn, today, owner)
        pending = [i for i in items if not events.get(i["key"]) or not events.get(i["key"])["last_notified_at"]]
    finally:
        conn.close()
    if not pending:
        return []

    title, body = _notification_text(settings, owner, display_name)
    if not title:
        return []
    results = await notify.send_channels(settings, title, body)
    if results:
        conn = db.connect()
        try:
            for item in pending:
                conn.execute(
                    "INSERT INTO reminder_events(owner_id, date, key, kind, last_notified_at) VALUES(?, ?, ?, ?, ?) "
                    "ON CONFLICT(owner_id, date, key) DO UPDATE SET last_notified_at = excluded.last_notified_at",
                    (owner, today, item["key"], item["kind"], iso(now)),
                )
            conn.commit()
        finally:
            conn.close()
    return results


async def _push_for_user(owner_id: int, display_name: str) -> None:
    settings = db.get_settings(owner_id)
    await push_due_once(owner_id, settings, display_name)


# ---------------------------------------------------------------- background


async def reminder_loop(stop_event: asyncio.Event) -> None:
    await asyncio.sleep(8)
    cleanup_counter = 0
    while not stop_event.is_set():
        try:
            for user in db.list_users():
                if user.get("role") == "doctor":
                    continue
                try:
                    await _push_for_user(int(user["id"]), user.get("display_name") or "")
                except Exception:  # noqa: BLE001 - 单个用户失败不影响其他用户
                    logger.exception("用户 %s 的提醒推送失败", user.get("username"))
            cleanup_counter += 1
            if cleanup_counter % 120 == 0:
                await asyncio.to_thread(db.cleanup_old_uploads, 30)
        except Exception:  # noqa: BLE001
            logger.exception("提醒轮询失败")
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=30)
        except asyncio.TimeoutError:
            continue
