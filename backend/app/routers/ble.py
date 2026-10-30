"""蓝牙自动同步配置接口。

bindkey 只下发给已登录的本人（不能进公开 settings 接口），用于 APK 本地解密
MiBeacon 广播；服务端不主动连接设备。
"""
from fastapi import APIRouter, Depends, HTTPException

from .. import db
from ..schemas import BleConfigIn
from ..security import current_user, ensure_writable

router = APIRouter(prefix="/api/ble", tags=["ble"], dependencies=[Depends(current_user)])


def _get_config(owner_id: int) -> dict | None:
    conn = db.connect()
    try:
        row = conn.execute(
            "SELECT mac, bindkey, enabled, updated_at FROM ble_config WHERE owner_id = ?",
            (int(owner_id),),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "configured": True,
        "mac": row["mac"],
        "bindkey": row["bindkey"],
        "enabled": bool(row["enabled"]),
        "updated_at": row["updated_at"],
    }


@router.get("/config")
def read_ble_config(user: dict = Depends(current_user)):
    config = _get_config(int(user["id"]))
    return config or {"configured": False}


@router.put("/config")
def write_ble_config(payload: BleConfigIn, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    mac = payload.mac.strip().upper()
    bindkey = payload.bindkey.strip().lower()
    now = db.now_iso()
    conn = db.connect()
    try:
        conn.execute(
            "INSERT INTO ble_config(owner_id, mac, bindkey, enabled, updated_at) "
            "VALUES(?, ?, ?, ?, ?) "
            "ON CONFLICT(owner_id) DO UPDATE SET mac = excluded.mac, "
            "bindkey = excluded.bindkey, enabled = excluded.enabled, updated_at = excluded.updated_at",
            (owner, mac, bindkey, 1 if payload.enabled else 0, now),
        )
        conn.commit()
    finally:
        conn.close()
    config = _get_config(owner)
    if config is None:
        raise HTTPException(status_code=500, detail="保存蓝牙配置失败")
    return config
