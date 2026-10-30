"""SQLite 数据层（支持多用户角色）。"""
import json
import sqlite3
import threading
from datetime import datetime
from typing import Any

from .config import DATA_DIR, DB_PATH, DEFAULT_SETTINGS, UPLOAD_DIR

_lock = threading.RLock()
_initialized = False

USER_SETTING_KEYS = (
    "slot_times",
    "slot_windows",
    "target_sys",
    "target_dia",
    "reminder_enabled",
    "timezone",
    "channels",
)

ROLES = ("admin", "user", "doctor")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    pw_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    display_name TEXT NOT NULL DEFAULT '',
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS captcha_challenges (
    token TEXT PRIMARY KEY,
    answer TEXT NOT NULL,
    expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
    owner_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY(owner_id, key)
);

CREATE TABLE IF NOT EXISTS measurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 0,
    measured_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    systolic INTEGER NOT NULL,
    diastolic INTEGER NOT NULL,
    pulse INTEGER,
    arm TEXT,
    position TEXT,
    slot TEXT,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_measurements_date ON measurements(local_date);
CREATE INDEX IF NOT EXISTS idx_measurements_time ON measurements(measured_at);

CREATE TABLE IF NOT EXISTS medications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    dose REAL NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT '片',
    times TEXT NOT NULL DEFAULT '[]',
    start_date TEXT NOT NULL,
    end_date TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS med_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 0,
    medication_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    scheduled_time TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    taken_at TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(medication_id, date, scheduled_time)
);
CREATE INDEX IF NOT EXISTS idx_med_logs_date ON med_logs(date);

CREATE TABLE IF NOT EXISTS reminder_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    last_notified_at TEXT,
    snooze_until TEXT,
    UNIQUE(owner_id, date, key)
);

CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL DEFAULT 0,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doctor_patients (
    doctor_id INTEGER NOT NULL,
    patient_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(doctor_id, patient_id)
);

CREATE TABLE IF NOT EXISTS ble_config (
    owner_id INTEGER PRIMARY KEY,
    mac TEXT NOT NULL,
    bindkey TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ---------------------------------------------------------------- migration


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    return row is not None


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    if not _table_exists(conn, table):
        return set()
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _add_missing_columns(conn: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    existing = _columns(conn, table)
    for name, decl in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


def _rebuild_reminder_events(conn: sqlite3.Connection) -> None:
    """旧 reminder_events 的 UNIQUE(date,key) 无法跨用户，重建为 UNIQUE(owner_id,date,key)。"""
    if not _table_exists(conn, "reminder_events"):
        return
    columns = _columns(conn, "reminder_events")
    if "owner_id" in columns:
        return
    conn.execute("ALTER TABLE reminder_events RENAME TO reminder_events_legacy")
    conn.execute(
        """
        CREATE TABLE reminder_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER NOT NULL DEFAULT 0,
            date TEXT NOT NULL,
            key TEXT NOT NULL,
            kind TEXT NOT NULL,
            last_notified_at TEXT,
            snooze_until TEXT,
            UNIQUE(owner_id, date, key)
        )
        """
    )
    conn.execute(
        "INSERT INTO reminder_events(id, owner_id, date, key, kind, last_notified_at, snooze_until) "
        "SELECT id, 0, date, key, kind, last_notified_at, snooze_until FROM reminder_events_legacy"
    )
    conn.execute("DROP TABLE reminder_events_legacy")


def _migrate(conn: sqlite3.Connection) -> None:
    """幂等迁移：旧单用户库 -> 多用户角色。全新库执行也不会出错。"""
    _add_missing_columns(
        conn,
        "users",
        {
            "role": "TEXT NOT NULL DEFAULT 'user'",
            "display_name": "TEXT NOT NULL DEFAULT ''",
            "failed_attempts": "INTEGER NOT NULL DEFAULT 0",
            "locked_until": "INTEGER NOT NULL DEFAULT 0",
        },
    )
    for table in ("measurements", "medications", "med_logs", "uploads"):
        _add_missing_columns(conn, table, {"owner_id": "INTEGER NOT NULL DEFAULT 0"})
    _rebuild_reminder_events(conn)
    conn.execute("UPDATE reminder_events SET owner_id = 0 WHERE owner_id IS NULL")

    conn.execute("CREATE INDEX IF NOT EXISTS idx_measurements_owner ON measurements(owner_id, local_date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_medications_owner ON medications(owner_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_med_logs_owner ON med_logs(owner_id, date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads(owner_id)")

    # 第一个用户若没有 admin，则提升为 admin（旧库单用户场景）
    admin = conn.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").fetchone()
    if admin is None:
        first = conn.execute("SELECT id FROM users ORDER BY id LIMIT 1").fetchone()
        if first is not None:
            conn.execute("UPDATE users SET role = 'admin' WHERE id = ?", (first["id"],))
            admin = first
    if admin is not None:
        admin_id = int(admin["id"])
        for table in ("measurements", "medications", "med_logs", "reminder_events", "uploads"):
            conn.execute(f"UPDATE {table} SET owner_id = ? WHERE owner_id = 0", (admin_id,))
        # 旧 settings 的用户可见键迁移到 admin 的 user_settings
        for key in USER_SETTING_KEYS:
            row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            if row is None:
                continue
            conn.execute(
                "INSERT INTO user_settings(owner_id, key, value) VALUES(?, ?, ?) "
                "ON CONFLICT(owner_id, key) DO NOTHING",
                (admin_id, key, row["value"]),
            )
            conn.execute("DELETE FROM settings WHERE key = ?", (key,))


def init_db() -> None:
    global _initialized
    with _lock:
        if _initialized:
            return
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        conn = connect()
        try:
            conn.executescript(SCHEMA)
            _migrate(conn)
            conn.commit()
        finally:
            conn.close()
        _initialized = True


# ---------------------------------------------------------------- users


def row_to_dict(row: sqlite3.Row) -> dict:
    return {k: row[k] for k in row.keys()}


def public_user(row: sqlite3.Row | dict) -> dict:
    data = row_to_dict(row) if isinstance(row, sqlite3.Row) else dict(row)
    return {
        "id": int(data["id"]),
        "username": data.get("username") or "",
        "display_name": data.get("display_name") or "",
        "role": data.get("role") or "user",
    }


def get_user(user_id: int) -> dict | None:
    init_db()
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    finally:
        conn.close()
    return row_to_dict(row) if row else None


def get_user_by_username(username: str) -> dict | None:
    init_db()
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    finally:
        conn.close()
    return row_to_dict(row) if row else None


def list_users() -> list[dict]:
    init_db()
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM users ORDER BY id").fetchall()
    finally:
        conn.close()
    return [row_to_dict(row) for row in rows]


def first_admin_id() -> int | None:
    init_db()
    conn = connect()
    try:
        row = conn.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").fetchone()
    finally:
        conn.close()
    return int(row["id"]) if row else None


def count_admins() -> int:
    init_db()
    conn = connect()
    try:
        row = conn.execute("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").fetchone()
    finally:
        conn.close()
    return int(row["c"])


def is_doctor(user: dict) -> bool:
    return (user or {}).get("role") == "doctor"


def doctor_patients(doctor_id: int) -> list[int]:
    init_db()
    conn = connect()
    try:
        rows = conn.execute("SELECT patient_id FROM doctor_patients WHERE doctor_id = ?", (doctor_id,)).fetchall()
    finally:
        conn.close()
    return [int(row["patient_id"]) for row in rows]


def doctors_for_patient(patient_id: int) -> list[int]:
    init_db()
    conn = connect()
    try:
        rows = conn.execute("SELECT doctor_id FROM doctor_patients WHERE patient_id = ?", (patient_id,)).fetchall()
    finally:
        conn.close()
    return [int(row["doctor_id"]) for row in rows]


# ---------------------------------------------------------------- settings


def _admin_fallback_id() -> int:
    return int(first_admin_id() or 0)


def get_settings(owner_id: int | None = None) -> dict:
    """返回某用户（合并默认值后的）完整设置；owner_id 为空时用第一个 admin。"""
    init_db()
    owner = int(owner_id) if owner_id is not None else _admin_fallback_id()
    result = json.loads(json.dumps(DEFAULT_SETTINGS))
    if owner <= 0:
        return result
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT key, value FROM user_settings WHERE owner_id = ?", (owner,)
        ).fetchall()
    finally:
        conn.close()
    for row in rows:
        try:
            value = json.loads(row["value"])
        except json.JSONDecodeError:
            value = row["value"]
        if row["key"] in result and isinstance(result[row["key"]], dict) and isinstance(value, dict):
            merged = dict(result[row["key"]])
            merged.update(value)
            result[row["key"]] = merged
        else:
            result[row["key"]] = value
    return result


def get_setting(key: str, default: Any = None) -> Any:
    if key in DEFAULT_SETTINGS:
        return get_settings().get(key, default)
    init_db()
    conn = connect()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    finally:
        conn.close()
    if row is None:
        return default
    try:
        return json.loads(row["value"])
    except json.JSONDecodeError:
        return row["value"]


def put_setting(key: str, value: Any) -> None:
    init_db()
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )
        conn.commit()
    finally:
        conn.close()


def update_settings(owner_id: int, partial: dict) -> dict:
    init_db()
    owner = int(owner_id)
    conn = connect()
    try:
        for key, value in partial.items():
            if key.startswith("_") or key not in DEFAULT_SETTINGS:
                continue
            conn.execute(
                "INSERT INTO user_settings(owner_id, key, value) VALUES(?, ?, ?) "
                "ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value",
                (owner, key, json.dumps(value, ensure_ascii=False)),
            )
        conn.commit()
    finally:
        conn.close()
    return get_settings(owner)


def internal_value(key: str, default: Any = None) -> Any:
    return get_setting(key, default)


def set_internal(key: str, value: Any) -> None:
    put_setting(key, value)


# ---------------------------------------------------------------- helpers


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def table_count(table: str) -> int:
    init_db()
    conn = connect()
    try:
        row = conn.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()
        return int(row["c"])
    finally:
        conn.close()


def cleanup_old_uploads(max_age_days: int = 30) -> None:
    """删除过旧的识别图片，避免磁盘无限增长。"""
    import os
    import time as _time

    cutoff = _time.time() - max_age_days * 86400
    conn = connect()
    try:
        rows = conn.execute("SELECT id, path FROM uploads").fetchall()
        for row in rows:
            path = row["path"]
            try:
                if os.path.exists(path) and os.path.getmtime(path) < cutoff:
                    os.remove(path)
                    conn.execute("DELETE FROM uploads WHERE id = ?", (row["id"],))
            except OSError:
                pass
        conn.commit()
    finally:
        conn.close()


__all__ = [
    "connect",
    "init_db",
    "get_settings",
    "get_setting",
    "put_setting",
    "update_settings",
    "internal_value",
    "set_internal",
    "now_iso",
    "row_to_dict",
    "public_user",
    "table_count",
    "cleanup_old_uploads",
    "UPLOAD_DIR",
    "USER_SETTING_KEYS",
    "ROLES",
    "get_user",
    "get_user_by_username",
    "list_users",
    "first_admin_id",
    "count_admins",
    "is_doctor",
    "doctor_patients",
    "doctors_for_patient",
]
