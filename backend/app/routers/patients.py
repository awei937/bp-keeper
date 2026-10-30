"""患者列表（供管理员/医生切换查看）。"""
from fastapi import APIRouter, Depends

from .. import db
from ..security import current_user

router = APIRouter(prefix="/api", tags=["patients"])


@router.get("/patients")
def list_patients(user: dict = Depends(current_user)):
    uid = int(user["id"])
    role = user.get("role")
    if role == "admin":
        items = [u for u in db.list_users() if u.get("role") in ("user", "admin")]
    elif role == "doctor":
        linked = set(db.doctor_patients(uid))
        items = [u for u in db.list_users() if int(u["id"]) in linked]
    else:
        items = [u for u in db.list_users() if int(u["id"]) == uid]
    return {"items": [db.public_user(row) for row in items]}
