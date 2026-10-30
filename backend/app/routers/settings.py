"""设置接口（每用户独立）。"""
from fastapi import APIRouter, Depends, HTTPException

from .. import db
from ..schemas import SettingsIn, TestChannelIn
from ..security import current_user, ensure_writable, owner_settings
from ..services import notify

router = APIRouter(prefix="/api/settings", tags=["settings"], dependencies=[Depends(current_user)])


def _public(settings: dict) -> dict:
    return {key: value for key, value in settings.items() if not key.startswith("_")}


@router.get("")
def read_settings(patient_id: int | None = None, user: dict = Depends(current_user)):
    owner, settings = owner_settings(user, patient_id)
    public = _public(settings)
    # 医生查看患者设置时不下发通知通道凭据（token/邮箱密码等）
    if user.get("role") == "doctor" and owner != int(user["id"]):
        public.pop("channels", None)
    return public


@router.put("")
def write_settings(payload: SettingsIn, user: dict = Depends(current_user)):
    ensure_writable(user)
    owner = int(user["id"])
    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        return _public(db.get_settings(owner))
    current = db.get_settings(owner)
    if "channels" in fields and isinstance(fields["channels"], dict):
        merged_channels = dict(current.get("channels") or {})
        for name, cfg in fields["channels"].items():
            if name not in merged_channels:
                raise HTTPException(status_code=400, detail=f"未知通知通道：{name}")
            if not isinstance(cfg, dict):
                raise HTTPException(status_code=400, detail=f"{name} 配置格式不正确")
            merged = dict(merged_channels[name])
            merged.update(cfg)
            merged_channels[name] = merged
        fields["channels"] = merged_channels
    db.update_settings(owner, fields)
    return _public(db.get_settings(owner))


@router.post("/test-channel")
async def test_channel(payload: TestChannelIn, user: dict = Depends(current_user)):
    ensure_writable(user)
    settings = db.get_settings(int(user["id"]))
    return await notify.test_channel(settings, payload.channel)
