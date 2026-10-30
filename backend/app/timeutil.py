"""时区、时段与日期工具。"""
from datetime import date, datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .config import SLOT_LABELS, SLOT_ORDER


def get_tz(settings: dict) -> ZoneInfo:
    name = settings.get("timezone") or "Asia/Shanghai"
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("Asia/Shanghai")


def now_local(settings: dict) -> datetime:
    return datetime.now(get_tz(settings))


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def parse_datetime(value: str | None, settings: dict) -> datetime:
    """解析 ISO 时间；无时区时按本地时区处理；空值取当前时间。"""
    tz = get_tz(settings)
    if not value:
        return now_local(settings)
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        raise ValueError("时间格式不正确")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=tz)
    return dt.astimezone(tz)


def parse_date(value: str | None, settings: dict) -> date:
    if not value:
        return now_local(settings).date()
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        raise ValueError("日期格式应为 YYYY-MM-DD")


def date_str(dt: datetime) -> str:
    return dt.date().isoformat()


def minutes_of(hhmm: str) -> int:
    hour, minute = hhmm.split(":")
    return int(hour) * 60 + int(minute)


def hhmm(dt: datetime) -> str:
    return dt.strftime("%H:%M")


def validate_hhmm(value: str) -> bool:
    try:
        hour, minute = value.split(":")
        return 0 <= int(hour) <= 23 and 0 <= int(minute) <= 59 and len(hour) == 2 and len(minute) == 2
    except Exception:
        return False


def slot_for(dt: datetime, settings: dict) -> str:
    current = dt.hour * 60 + dt.minute
    windows = settings.get("slot_windows") or {}
    for key in SLOT_ORDER:
        window = windows.get(key)
        if not window or len(window) != 2:
            continue
        start, end = minutes_of(window[0]), minutes_of(window[1])
        if start <= current <= end:
            return key
    return "other"


def slot_label(key: str) -> str:
    return SLOT_LABELS.get(key, key)


def slot_windows(settings: dict) -> dict:
    windows = settings.get("slot_windows") or {}
    result = {}
    for key in SLOT_ORDER:
        window = windows.get(key)
        if not window or len(window) != 2:
            continue
        result[key] = {"start": window[0], "end": window[1]}
    return result


def day_bounds(day: date, settings: dict) -> tuple[datetime, datetime]:
    tz = get_tz(settings)
    start = datetime.combine(day, dtime(0, 0), tzinfo=tz)
    return start, start + timedelta(days=1)


def last_n_days(day: date, n: int) -> list[date]:
    return [day - timedelta(days=i) for i in range(n - 1, -1, -1)]


def min_to_hhmm(minutes: int) -> str:
    minutes = max(0, min(23 * 60 + 59, minutes))
    return f"{minutes // 60:02d}:{minutes % 60:02d}"
