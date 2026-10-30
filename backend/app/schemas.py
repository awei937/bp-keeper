"""请求/响应模型（Pydantic v2）。"""
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

from .config import SLOT_ORDER
from .timeutil import validate_hhmm

Slot = Literal["morning", "forenoon", "afternoon", "bedtime", "other"]
Arm = Literal["left", "right"]
Position = Literal["sitting", "lying", "standing"]
Source = Literal["manual", "ocr", "ble"]
Role = Literal["admin", "user", "doctor"]


class SetupIn(BaseModel):
    username: str = Field(default="admin", min_length=1, max_length=32)
    password: str = Field(min_length=6, max_length=128)


class LoginIn(BaseModel):
    username: str = Field(default="admin", max_length=32)
    password: str = Field(min_length=1, max_length=128)
    captcha_id: Optional[str] = Field(default=None, max_length=64)
    captcha: Optional[str] = Field(default=None, max_length=16)


class UserCreateIn(BaseModel):
    username: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=6, max_length=128)
    display_name: str = Field(default="", max_length=32)
    role: Role = "user"


class UserPatchIn(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=32)
    role: Optional[Role] = None
    password: Optional[str] = Field(default=None, min_length=6, max_length=128)


class LinkIn(BaseModel):
    doctor_id: int = Field(gt=0)
    patient_id: int = Field(gt=0)


class PasswordIn(BaseModel):
    old_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=6, max_length=128)


class ProfileIn(BaseModel):
    """用户可修改自己的显示名称（不能改用户名 / 角色）。"""
    display_name: str = Field(default="", max_length=32)


class BleConfigIn(BaseModel):
    """蓝牙自动同步配置；bindkey 只下发给已登录的本人，不进入公开设置接口。"""
    mac: str = Field(pattern=r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")
    bindkey: str = Field(min_length=32, max_length=32, pattern=r"^[0-9a-fA-F]{32}$")
    enabled: bool = True


class MeasurementIn(BaseModel):
    measured_at: Optional[str] = None
    systolic: int = Field(ge=40, le=300)
    diastolic: int = Field(ge=20, le=200)
    pulse: Optional[int] = Field(default=None, ge=20, le=250)
    arm: Arm = "left"
    position: Position = "sitting"
    slot: Optional[Slot] = None
    note: str = Field(default="", max_length=500)
    source: Source = "manual"

    @field_validator("systolic")
    @classmethod
    def _sys_gt_dia(cls, value: int) -> int:
        return value


class MeasurementPatch(BaseModel):
    measured_at: Optional[str] = None
    systolic: Optional[int] = Field(default=None, ge=40, le=300)
    diastolic: Optional[int] = Field(default=None, ge=20, le=200)
    pulse: Optional[int] = Field(default=None, ge=20, le=250)
    arm: Optional[Arm] = None
    position: Optional[Position] = None
    slot: Optional[Slot] = None
    note: Optional[str] = Field(default=None, max_length=500)
    source: Optional[Source] = None


class MedicationIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    dose: float = Field(default=1, gt=0, le=100)
    unit: str = Field(default="片", max_length=10)
    times: list[str] = Field(min_length=1, max_length=8)
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    active: bool = True
    note: str = Field(default="", max_length=300)

    @field_validator("times")
    @classmethod
    def _check_times(cls, value: list[str]) -> list[str]:
        cleaned = []
        for item in value:
            text = item.strip()
            if not validate_hhmm(text):
                raise ValueError(f"服药时间格式不正确：{item}")
            if text not in cleaned:
                cleaned.append(text)
        return sorted(cleaned)


class MedicationPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    dose: Optional[float] = Field(default=None, gt=0, le=100)
    unit: Optional[str] = Field(default=None, max_length=10)
    times: Optional[list[str]] = Field(default=None, min_length=1, max_length=8)
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    active: Optional[bool] = None
    note: Optional[str] = Field(default=None, max_length=300)

    @field_validator("times")
    @classmethod
    def _check_times(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        if value is None:
            return value
        cleaned = []
        for item in value:
            text = item.strip()
            if not validate_hhmm(text):
                raise ValueError(f"服药时间格式不正确：{item}")
            if text not in cleaned:
                cleaned.append(text)
        return sorted(cleaned)


class TakeIn(BaseModel):
    note: str = Field(default="", max_length=300)


class SnoozeIn(BaseModel):
    key: str = Field(min_length=1, max_length=120)
    minutes: int = Field(default=10, ge=1, le=180)


class TestChannelIn(BaseModel):
    channel: Literal["ntfy", "pushplus", "email", "webhook"]


class SettingsIn(BaseModel):
    slot_times: Optional[dict[str, str]] = None
    slot_windows: Optional[dict[str, list[str]]] = None
    target_sys: Optional[int] = Field(default=None, ge=80, le=220)
    target_dia: Optional[int] = Field(default=None, ge=40, le=140)
    reminder_enabled: Optional[bool] = None
    timezone: Optional[str] = Field(default=None, max_length=64)
    channels: Optional[dict] = None

    @field_validator("slot_times")
    @classmethod
    def _check_slot_times(cls, value: Optional[dict[str, str]]) -> Optional[dict[str, str]]:
        if value is None:
            return value
        for key, text in value.items():
            if key not in SLOT_ORDER:
                raise ValueError(f"未知时段：{key}")
            if not validate_hhmm(text):
                raise ValueError(f"时间格式不正确：{text}")
        return value

    @field_validator("slot_windows")
    @classmethod
    def _check_slot_windows(cls, value: Optional[dict[str, list[str]]]) -> Optional[dict[str, list[str]]]:
        if value is None:
            return value
        for key, window in value.items():
            if key not in SLOT_ORDER:
                raise ValueError(f"未知时段：{key}")
            if not isinstance(window, list) or len(window) != 2:
                raise ValueError("时段窗口应为 [开始, 结束]")
            for text in window:
                if not validate_hhmm(text):
                    raise ValueError(f"时间格式不正确：{text}")
        return value
