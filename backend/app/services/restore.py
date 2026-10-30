"""备份恢复：把导出的 JSON 恢复回某个 owner（覆盖该 owner 的数据，仅管理员接口调用）。"""
import json
from datetime import date, datetime

from .. import db

MAX_MEASUREMENTS = 200_000
MAX_MEDICATIONS = 2_000
MAX_MED_LOGS = 500_000

PUBLIC_SETTINGS = (
    "slot_times",
    "slot_windows",
    "target_sys",
    "target_dia",
    "reminder_enabled",
    "timezone",
    "channels",
)


def _as_int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_text(value, default=""):
    if value is None:
        return default
    return str(value)


def _valid_date(value) -> bool:
    try:
        date.fromisoformat(str(value))
        return True
    except (TypeError, ValueError):
        return False


def _clean_measurements(items: list) -> list:
    rows = []
    for item in items:
        if not isinstance(item, dict):
            continue
        systolic = _as_int(item.get("systolic"))
        diastolic = _as_int(item.get("diastolic"))
        measured_at = _as_text(item.get("measured_at"))
        if systolic is None or diastolic is None or not measured_at:
            continue
        try:
            moment = datetime.fromisoformat(measured_at.replace("Z", "+00:00"))
        except ValueError:
            continue
        if not (40 <= systolic <= 300 and 20 <= diastolic <= 200):
            continue
        local_date = _as_text(item.get("local_date"))
        if not _valid_date(local_date):
            local_date = moment.date().isoformat()
        rows.append(
            {
                "measured_at": measured_at,
                "local_date": local_date,
                "systolic": systolic,
                "diastolic": diastolic,
                "pulse": _as_int(item.get("pulse")),
                "arm": item.get("arm") if item.get("arm") in ("left", "right") else None,
                "position": item.get("position") if item.get("position") in ("sitting", "lying", "standing") else None,
                "slot": item.get("slot") if item.get("slot") in ("morning", "forenoon", "afternoon", "bedtime", "other") else None,
                "note": _as_text(item.get("note"))[:500],
                "source": item.get("source") if item.get("source") in ("manual", "ocr") else "manual",
                "created_at": _as_text(item.get("created_at")) or db.now_iso(),
                "updated_at": _as_text(item.get("updated_at")) or db.now_iso(),
            }
        )
    return rows


def _clean_medications(items: list) -> list:
    rows = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = _as_text(item.get("name")).strip()
        times = item.get("times")
        if isinstance(times, str):
            try:
                times = json.loads(times)
            except json.JSONDecodeError:
                times = []
        if not name or not isinstance(times, list):
            continue
        valid_times = [str(time)[:5] for time in times if isinstance(time, str) and len(str(time)) >= 5]
        if not valid_times:
            continue
        start_date = _as_text(item.get("start_date"))
        if not _valid_date(start_date):
            start_date = date.today().isoformat()
        end_date = item.get("end_date")
        if end_date is not None and not _valid_date(end_date):
            end_date = None
        dose = _as_float(item.get("dose"), 1.0)
        rows.append(
            {
                "id": _as_int(item.get("id")),
                "name": name[:60],
                "dose": dose if dose and dose > 0 else 1.0,
                "unit": (_as_text(item.get("unit"), "片") or "片")[:10],
                "times": valid_times,
                "start_date": start_date,
                "end_date": end_date,
                "active": 1 if item.get("active", True) else 0,
                "note": _as_text(item.get("note"))[:300],
                "created_at": _as_text(item.get("created_at")) or db.now_iso(),
            }
        )
    return rows


def _clean_logs(items: list, allowed_medication_ids: set) -> list:
    rows = []
    for item in items:
        if not isinstance(item, dict):
            continue
        medication_id = _as_int(item.get("medication_id"))
        if medication_id not in allowed_medication_ids:
            continue
        log_date = _as_text(item.get("date"))
        scheduled = _as_text(item.get("scheduled_time"))
        if not _valid_date(log_date) or len(scheduled) != 5:
            continue
        status = item.get("status") if item.get("status") in ("pending", "taken", "skipped") else "pending"
        rows.append(
            {
                "medication_id": medication_id,
                "date": log_date,
                "scheduled_time": scheduled,
                "status": status,
                "taken_at": _as_text(item.get("taken_at")) or None,
                "note": _as_text(item.get("note"))[:300],
                "created_at": _as_text(item.get("created_at")) or db.now_iso(),
            }
        )
    return rows


def restore_backup(owner_id: int, data: dict) -> dict:
    owner = int(owner_id)
    if not isinstance(data, dict):
        raise ValueError("备份内容格式不正确")
    measurements = data.get("measurements")
    medications = data.get("medications")
    med_logs = data.get("med_logs")
    if not isinstance(measurements, list) or not isinstance(medications, list) or not isinstance(med_logs, list):
        raise ValueError("备份文件缺少 measurements / medications / med_logs")
    if len(measurements) > MAX_MEASUREMENTS or len(medications) > MAX_MEDICATIONS or len(med_logs) > MAX_MED_LOGS:
        raise ValueError("备份数据量过大")

    clean_measurements = _clean_measurements(measurements)
    clean_medications = _clean_medications(medications)
    medication_ids = {row["id"] for row in clean_medications if row["id"]}
    clean_logs = _clean_logs(med_logs, medication_ids)
    settings_in = data.get("settings") if isinstance(data.get("settings"), dict) else {}

    conn = db.connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM med_logs WHERE owner_id = ?", (owner,))
        conn.execute("DELETE FROM measurements WHERE owner_id = ?", (owner,))
        conn.execute("DELETE FROM medications WHERE owner_id = ?", (owner,))

        conn.executemany(
            "INSERT INTO measurements(owner_id, measured_at, local_date, systolic, diastolic, pulse, arm, position, slot, note, source, created_at, updated_at) "
            "VALUES(:owner, :measured_at, :local_date, :systolic, :diastolic, :pulse, :arm, :position, :slot, :note, :source, :created_at, :updated_at)",
            [{**row, "owner": owner} for row in clean_measurements],
        )

        for row in clean_medications:
            payload = {**row, "owner": owner, "times": json.dumps(row["times"], ensure_ascii=False)}
            if row["id"]:
                conn.execute(
                    "INSERT INTO medications(id, owner_id, name, dose, unit, times, start_date, end_date, active, note, created_at) "
                    "VALUES(:id, :owner, :name, :dose, :unit, :times, :start_date, :end_date, :active, :note, :created_at)",
                    payload,
                )
            else:
                cursor = conn.execute(
                    "INSERT INTO medications(owner_id, name, dose, unit, times, start_date, end_date, active, note, created_at) "
                    "VALUES(:owner, :name, :dose, :unit, :times, :start_date, :end_date, :active, :note, :created_at)",
                    payload,
                )
                row["id"] = int(cursor.lastrowid)
                medication_ids.add(row["id"])

        for row in clean_logs:
            conn.execute(
                "INSERT OR IGNORE INTO med_logs(owner_id, medication_id, date, scheduled_time, status, taken_at, note, created_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    owner,
                    row["medication_id"],
                    row["date"],
                    row["scheduled_time"],
                    row["status"],
                    row["taken_at"],
                    row["note"],
                    row["created_at"],
                ),
            )

        settings_restored = False
        for key in PUBLIC_SETTINGS:
            if key in settings_in:
                conn.execute(
                    "INSERT INTO user_settings(owner_id, key, value) VALUES(?, ?, ?) "
                    "ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value",
                    (owner, key, json.dumps(settings_in[key], ensure_ascii=False)),
                )
                settings_restored = True

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return {
        "ok": True,
        "imported": {
            "measurements": len(clean_measurements),
            "medications": len(clean_medications),
            "med_logs": len(clean_logs),
            "settings": settings_restored,
        },
    }
