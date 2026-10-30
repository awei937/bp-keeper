"""管理员接口：用户与医生-患者绑定管理。"""
from fastapi import APIRouter, Depends, HTTPException, Query

from .. import db
from ..schemas import LinkIn, UserCreateIn, UserPatchIn
from ..security import current_admin, hash_password

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(current_admin)])


def _user_item(user: dict) -> dict:
    uid = int(user["id"])
    return {
        "id": uid,
        "username": user.get("username") or "",
        "display_name": user.get("display_name") or "",
        "role": user.get("role") or "user",
        "created_at": user.get("created_at") or "",
        "patient_ids": db.doctor_patients(uid) if user.get("role") == "doctor" else [],
        "doctor_ids": db.doctors_for_patient(uid) if user.get("role") == "user" else [],
    }


@router.get("/users")
def list_users():
    return {"items": [_user_item(user) for user in db.list_users()]}


@router.post("/users")
def create_user(payload: UserCreateIn):
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="用户名不能为空")
    if db.get_user_by_username(username) is not None:
        raise HTTPException(status_code=400, detail="用户名已存在")
    pw_hash, salt = hash_password(payload.password)
    conn = db.connect()
    try:
        cursor = conn.execute(
            "INSERT INTO users(username, pw_hash, salt, role, display_name, created_at) VALUES(?, ?, ?, ?, ?, ?)",
            (
                username,
                pw_hash,
                salt,
                payload.role,
                (payload.display_name or "").strip(),
                db.now_iso(),
            ),
        )
        conn.commit()
        user_id = int(cursor.lastrowid)
    finally:
        conn.close()
    row = db.get_user(user_id)
    return _user_item(row) if row else {"ok": True}


@router.patch("/users/{user_id}")
def update_user(user_id: int, payload: UserPatchIn, admin: dict = Depends(current_admin)):
    target = db.get_user(user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    fields = payload.model_dump(exclude_unset=True)
    new_role = fields.get("role")
    if new_role is not None and new_role != target["role"]:
        if int(target["id"]) == int(admin["id"]):
            raise HTTPException(status_code=400, detail="不能修改自己的角色")
        if target["role"] == "admin" and new_role != "admin" and db.count_admins() <= 1:
            raise HTTPException(status_code=400, detail="不能降级最后一个管理员")
    conn = db.connect()
    try:
        if "display_name" in fields and fields["display_name"] is not None:
            conn.execute("UPDATE users SET display_name = ? WHERE id = ?", (fields["display_name"].strip(), user_id))
        if new_role is not None:
            conn.execute("UPDATE users SET role = ? WHERE id = ?", (new_role, user_id))
        if fields.get("password"):
            pw_hash, salt = hash_password(fields["password"])
            conn.execute(
                "UPDATE users SET pw_hash = ?, salt = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?",
                (pw_hash, salt, user_id),
            )
        conn.commit()
    finally:
        conn.close()
    return _user_item(db.get_user(user_id))


@router.delete("/users/{user_id}")
def delete_user(user_id: int, admin: dict = Depends(current_admin)):
    target = db.get_user(user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    if int(user_id) == int(admin["id"]):
        raise HTTPException(status_code=400, detail="不能删除自己")
    if target["role"] == "admin" and db.count_admins() <= 1:
        raise HTTPException(status_code=400, detail="不能删除最后一个管理员")
    conn = db.connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        for table in ("measurements", "medications", "med_logs", "reminder_events", "uploads", "user_settings"):
            conn.execute(f"DELETE FROM {table} WHERE owner_id = ?", (user_id,))
        conn.execute("DELETE FROM doctor_patients WHERE doctor_id = ? OR patient_id = ?", (user_id, user_id))
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {"ok": True}


@router.post("/links")
def create_link(payload: LinkIn):
    doctor = db.get_user(payload.doctor_id)
    patient = db.get_user(payload.patient_id)
    if doctor is None or doctor.get("role") != "doctor":
        raise HTTPException(status_code=400, detail="doctor_id 必须是医生账号")
    if patient is None or patient.get("role") != "user":
        raise HTTPException(status_code=400, detail="patient_id 必须是普通用户")
    conn = db.connect()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO doctor_patients(doctor_id, patient_id, created_at) VALUES(?, ?, ?)",
            (payload.doctor_id, payload.patient_id, db.now_iso()),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.delete("/links")
def delete_link(doctor_id: int = Query(gt=0), patient_id: int = Query(gt=0)):
    conn = db.connect()
    try:
        conn.execute(
            "DELETE FROM doctor_patients WHERE doctor_id = ? AND patient_id = ?",
            (doctor_id, patient_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}
