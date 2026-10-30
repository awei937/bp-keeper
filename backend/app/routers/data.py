"""血压记录、药品与服药任务接口（按 owner 隔离）。"""
import json

from fastapi import APIRouter, Depends, HTTPException, Query

from .. import db
from ..config import SLOT_LABELS
from ..schemas import MeasurementIn, MeasurementPatch, MedicationIn, MedicationPatch, TakeIn
from ..security import current_user, ensure_writable, owner_settings, resolve_owner
from ..services.reminders import materialize_logs
from ..timeutil import date_str, now_local, parse_date, parse_datetime, slot_for

router = APIRouter(prefix="/api", tags=["data"], dependencies=[Depends(current_user)])


# ---------------------------------------------------------------- helpers


def measurement_dict(row) -> dict:
    return {
        "id": row["id"],
        "measured_at": row["measured_at"],
        "systolic": row["systolic"],
        "diastolic": row["diastolic"],
        "pulse": row["pulse"],
        "arm": row["arm"],
        "position": row["position"],
        "slot": row["slot"],
        "note": row["note"],
        "source": row["source"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def medication_dict(row) -> dict:
    try:
        times = json.loads(row["times"] or "[]")
    except json.JSONDecodeError:
        times = []
    return {
        "id": row["id"],
        "name": row["name"],
        "dose": row["dose"],
        "unit": row["unit"],
        "times": times,
        "start_date": row["start_date"],
        "end_date": row["end_date"],
        "active": bool(row["active"]),
        "note": row["note"],
    }


def medlog_dict(row) -> dict:
    return {
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


def _fetch_measurement(conn, measurement_id: int, owner_id: int):
    row = conn.execute(
        "SELECT * FROM measurements WHERE id = ? AND owner_id = ?", (measurement_id, owner_id)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    return row


def _fetch_medication(conn, medication_id: int, owner_id: int):
    row = conn.execute(
        "SELECT * FROM medications WHERE id = ? AND owner_id = ?", (medication_id, owner_id)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="药品不存在")
    return row


def _fetch_medlog(conn, log_id: int, owner_id: int):
    row = conn.execute(
        "SELECT l.*, m.name, m.dose, m.unit FROM med_logs l "
        "JOIN medications m ON m.id = l.medication_id "
        "WHERE l.id = ? AND l.owner_id = ? AND m.owner_id = ?",
        (log_id, owner_id, owner_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="服药任务不存在")
    return row


# ---------------------------------------------------------------- measurements


@router.get("/measurements")
def list_measurements(
    patient_id: int | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    limit: int = 500,
    offset: int = 0,
    user: dict = Depends(current_user),
):
    owner, settings = owner_settings(user, patient_id)
    limit = max(1, min(2000, int(limit)))
    offset = max(0, int(offset))
    where = ["owner_id = ?"]
    params: list = [owner]
    if from_:
        where.append("local_date >= ?")
        params.append(parse_date(from_, settings).isoformat())
    if to:
        where.append("local_date <= ?")
        params.append(parse_date(to, settings).isoformat())
    sql_where = " AND ".join(where)
    conn = db.connect()
    try:
        total = conn.execute(f"SELECT COUNT(*) AS c FROM measurements WHERE {sql_where}", params).fetchone()["c"]
        rows = conn.execute(
            f"SELECT * FROM measurements WHERE {sql_where} ORDER BY measured_at DESC LIMIT ? OFFSET ?",
            params + [limit, offset],
        ).fetchall()
    finally:
        conn.close()
    return {"items": [measurement_dict(row) for row in rows], "total": int(total)}


@router.post("/measurements")
def create_measurement(payload: MeasurementIn, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    settings = db.get_settings(owner)
    try:
        dt = parse_datetime(payload.measured_at, settings)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    slot = payload.slot or slot_for(dt, settings)
    now = db.now_iso()
    conn = db.connect()
    try:
        cursor = conn.execute(
            "INSERT INTO measurements(owner_id, measured_at, local_date, systolic, diastolic, pulse, arm, position, slot, note, source, created_at, updated_at) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                owner,
                dt.isoformat(timespec="seconds"),
                date_str(dt),
                payload.systolic,
                payload.diastolic,
                payload.pulse,
                payload.arm,
                payload.position,
                slot,
                payload.note,
                payload.source,
                now,
                now,
            ),
        )
        conn.commit()
        row = _fetch_measurement(conn, int(cursor.lastrowid), owner)
    finally:
        conn.close()
    return measurement_dict(row)


@router.put("/measurements/{measurement_id}")
def update_measurement(measurement_id: int, payload: MeasurementPatch, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    settings = db.get_settings(owner)
    conn = db.connect()
    try:
        row = _fetch_measurement(conn, measurement_id, owner)
        fields = payload.model_dump(exclude_unset=True)
        data = {key: row[key] for key in row.keys()}
        if "measured_at" in fields:
            try:
                dt = parse_datetime(fields["measured_at"], settings)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
            data["measured_at"] = dt.isoformat(timespec="seconds")
            data["local_date"] = date_str(dt)
            if fields.get("slot") is None and "slot" not in fields:
                data["slot"] = slot_for(dt, settings)
        for key in ("systolic", "diastolic", "pulse", "arm", "position", "slot", "note", "source"):
            if key in fields:
                data[key] = fields[key]
        if data["systolic"] is not None and data["diastolic"] is not None and data["systolic"] <= data["diastolic"]:
            raise HTTPException(status_code=400, detail="收缩压应高于舒张压")
        data["updated_at"] = db.now_iso()
        conn.execute(
            "UPDATE measurements SET measured_at=?, local_date=?, systolic=?, diastolic=?, pulse=?, arm=?, position=?, slot=?, note=?, source=?, updated_at=? "
            "WHERE id=? AND owner_id=?",
            (
                data["measured_at"],
                data["local_date"],
                data["systolic"],
                data["diastolic"],
                data["pulse"],
                data["arm"],
                data["position"],
                data["slot"],
                data["note"],
                data["source"],
                data["updated_at"],
                measurement_id,
                owner,
            ),
        )
        conn.commit()
        row = _fetch_measurement(conn, measurement_id, owner)
    finally:
        conn.close()
    return measurement_dict(row)


@router.delete("/measurements/{measurement_id}")
def delete_measurement(measurement_id: int, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    conn = db.connect()
    try:
        _fetch_measurement(conn, measurement_id, owner)
        conn.execute("DELETE FROM measurements WHERE id = ? AND owner_id = ?", (measurement_id, owner))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ---------------------------------------------------------------- medications


@router.get("/medications")
def list_medications(active: str | None = None, patient_id: int | None = None, user: dict = Depends(current_user)):
    owner = resolve_owner(user, patient_id)
    sql = "SELECT * FROM medications WHERE owner_id = ?"
    params: list = [owner]
    if active is not None:
        sql += " AND active = ?"
        params.append(1 if active in ("1", "true", "True") else 0)
    sql += " ORDER BY id ASC"
    conn = db.connect()
    try:
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    return {"items": [medication_dict(row) for row in rows]}


@router.post("/medications")
def create_medication(payload: MedicationIn, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    settings = db.get_settings(owner)
    start = payload.start_date or now_local(settings).date().isoformat()
    conn = db.connect()
    try:
        cursor = conn.execute(
            "INSERT INTO medications(owner_id, name, dose, unit, times, start_date, end_date, active, note, created_at) "
            "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                owner,
                payload.name.strip(),
                payload.dose,
                payload.unit.strip() or "片",
                json.dumps(payload.times, ensure_ascii=False),
                start,
                payload.end_date,
                1 if payload.active else 0,
                payload.note,
                db.now_iso(),
            ),
        )
        conn.commit()
        row = _fetch_medication(conn, int(cursor.lastrowid), owner)
    finally:
        conn.close()
    materialize_logs(start, owner, settings)
    return medication_dict(row)


@router.put("/medications/{medication_id}")
def update_medication(medication_id: int, payload: MedicationPatch, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    settings = db.get_settings(owner)
    conn = db.connect()
    try:
        row = _fetch_medication(conn, medication_id, owner)
        fields = payload.model_dump(exclude_unset=True)
        data = {key: row[key] for key in row.keys()}
        for key in ("name", "dose", "unit", "times", "start_date", "end_date", "active", "note"):
            if key in fields and fields[key] is not None:
                data[key] = fields[key]
        if isinstance(data["times"], list):
            data["times"] = json.dumps(data["times"], ensure_ascii=False)
        data["active"] = 1 if data["active"] else 0
        conn.execute(
            "UPDATE medications SET name=?, dose=?, unit=?, times=?, start_date=?, end_date=?, active=?, note=? "
            "WHERE id=? AND owner_id=?",
            (
                data["name"],
                data["dose"],
                data["unit"],
                data["times"],
                data["start_date"],
                data["end_date"],
                data["active"],
                data["note"],
                medication_id,
                owner,
            ),
        )
        # 清理今天尚未打卡、但已不在服药时间列表里的任务
        today = now_local(settings).date().isoformat()
        try:
            times = json.loads(data["times"])
        except json.JSONDecodeError:
            times = []
        if times:
            placeholders = ",".join("?" for _ in times)
            conn.execute(
                f"DELETE FROM med_logs WHERE owner_id=? AND medication_id=? AND date=? AND status='pending' AND scheduled_time NOT IN ({placeholders})",
                [owner, medication_id, today] + times,
            )
        conn.commit()
        row = _fetch_medication(conn, medication_id, owner)
    finally:
        conn.close()
    materialize_logs(now_local(settings).date().isoformat(), owner, settings)
    return medication_dict(row)


@router.delete("/medications/{medication_id}")
def delete_medication(medication_id: int, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    conn = db.connect()
    try:
        _fetch_medication(conn, medication_id, owner)
        conn.execute("DELETE FROM med_logs WHERE owner_id = ? AND medication_id = ?", (owner, medication_id))
        conn.execute("DELETE FROM medications WHERE id = ? AND owner_id = ?", (medication_id, owner))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


# ---------------------------------------------------------------- med logs


@router.get("/medlogs")
def list_medlogs(date: str | None = None, patient_id: int | None = None, user: dict = Depends(current_user)):
    owner, settings = owner_settings(user, patient_id)
    day = parse_date(date, settings).isoformat()
    materialize_logs(day, owner, settings)
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT l.*, m.name, m.dose, m.unit FROM med_logs l JOIN medications m ON m.id = l.medication_id "
            "WHERE l.date = ? AND l.owner_id = ? AND m.owner_id = ? ORDER BY l.scheduled_time ASC",
            (day, owner, owner),
        ).fetchall()
    finally:
        conn.close()
    return {"items": [medlog_dict(row) for row in rows]}


@router.post("/medlogs/{log_id}/take")
def take_medlog(log_id: int, payload: TakeIn | None = None, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    conn = db.connect()
    try:
        _fetch_medlog(conn, log_id, owner)
        conn.execute(
            "UPDATE med_logs SET status='taken', taken_at=?, note=? WHERE id=? AND owner_id=?",
            (db.now_iso(), (payload.note if payload else "") or "", log_id, owner),
        )
        conn.commit()
        row = _fetch_medlog(conn, log_id, owner)
    finally:
        conn.close()
    return medlog_dict(row)


@router.post("/medlogs/{log_id}/skip")
def skip_medlog(log_id: int, payload: TakeIn | None = None, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    conn = db.connect()
    try:
        _fetch_medlog(conn, log_id, owner)
        conn.execute(
            "UPDATE med_logs SET status='skipped', taken_at=NULL, note=? WHERE id=? AND owner_id=?",
            ((payload.note if payload else "") or "", log_id, owner),
        )
        conn.commit()
        row = _fetch_medlog(conn, log_id, owner)
    finally:
        conn.close()
    return medlog_dict(row)


@router.post("/medlogs/{log_id}/undo")
def undo_medlog(log_id: int, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    conn = db.connect()
    try:
        _fetch_medlog(conn, log_id, owner)
        conn.execute(
            "UPDATE med_logs SET status='pending', taken_at=NULL WHERE id=? AND owner_id=?",
            (log_id, owner),
        )
        conn.commit()
        row = _fetch_medlog(conn, log_id, owner)
    finally:
        conn.close()
    return medlog_dict(row)


# ---------------------------------------------------------------- slots meta


@router.get("/slots")
def list_slots(patient_id: int | None = None, user: dict = Depends(current_user)):
    _, settings = owner_settings(user, patient_id)
    result = []
    windows = settings.get("slot_windows") or {}
    times = settings.get("slot_times") or {}
    for key in ("morning", "forenoon", "afternoon", "bedtime"):
        if key not in windows:
            continue
        result.append(
            {
                "key": key,
                "label": SLOT_LABELS.get(key, key),
                "window": windows[key],
                "target_time": times.get(key),
            }
        )
    return {"items": result}
