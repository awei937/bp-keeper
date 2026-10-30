"""全局配置。"""
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("BP_DATA_DIR", "/data"))
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = Path(os.environ.get("BP_DB_PATH", str(DATA_DIR / "bp.db")))
FRONTEND_DIR = Path(os.environ.get("BP_FRONTEND_DIR", "/app/frontend"))

APP_NAME = "血压管家"
APP_VERSION = "1.0.0"
SESSION_COOKIE = "bp_session"
SESSION_DAYS = 30
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
DEFAULT_TZ = os.environ.get("BP_TZ", "Asia/Shanghai")

SLOT_ORDER = ["morning", "forenoon", "afternoon", "bedtime"]
SLOT_LABELS = {
    "morning": "早上",
    "forenoon": "上午",
    "afternoon": "下午",
    "bedtime": "睡前",
    "other": "其他",
}

DEFAULT_SETTINGS = {
    "slot_times": {
        "morning": "06:30",
        "forenoon": "10:00",
        "afternoon": "17:00",
        "bedtime": "22:00",
    },
    "slot_windows": {
        "morning": ["06:00", "07:30"],
        "forenoon": ["09:00", "11:30"],
        "afternoon": ["16:00", "18:30"],
        "bedtime": ["21:30", "23:59"],
    },
    "target_sys": 135,
    "target_dia": 85,
    "reminder_enabled": True,
    "timezone": DEFAULT_TZ,
    "channels": {
        "ntfy": {"enabled": False, "server": "https://ntfy.sh", "topic": "", "token": ""},
        "pushplus": {"enabled": False, "token": ""},
        "email": {
            "enabled": False,
            "smtp_host": "",
            "smtp_port": 465,
            "ssl": True,
            "username": "",
            "password": "",
            "to": "",
        },
        "webhook": {"enabled": False, "url": "", "method": "POST"},
    },
}
