"""认证、会话、角色权限与登录限流。"""
import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from typing import Optional

from fastapi import Depends, HTTPException, Request, Response

from . import db
from .config import SESSION_COOKIE, SESSION_DAYS

PBKDF2_ITERATIONS = 240_000
_RATE_LIMIT_WINDOW = 900
_RATE_LIMIT_MAX_FAILS = 10

RATE_LIMIT_MAX_FAILS = _RATE_LIMIT_MAX_FAILS

_rate_lock = threading.Lock()
_rate_state: dict[str, list[float]] = {}


# ---------------------------------------------------------------- password


def hash_password(password: str) -> tuple[str, str]:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS
    )
    return digest.hex(), salt


def verify_password(password: str, pw_hash: str, salt: str) -> bool:
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS
    )
    return hmac.compare_digest(digest.hex(), pw_hash)


# ---------------------------------------------------------------- session


def _secret() -> bytes:
    value = db.internal_value("_session_secret")
    if not value:
        value = secrets.token_hex(32)
        db.set_internal("_session_secret", value)
    return value.encode("utf-8")


def session_version() -> int:
    return int(db.internal_value("_session_version", 1) or 1)


def bump_session_version() -> None:
    db.set_internal("_session_version", session_version() + 1)


def create_session_token(user_id: int) -> str:
    payload = {
        "u": user_id,
        "v": session_version(),
        "exp": int(time.time()) + SESSION_DAYS * 86400,
    }
    raw = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    sig = hmac.new(_secret(), raw.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{raw}.{sig}"


def verify_session_token(token: str) -> Optional[int]:
    try:
        raw, sig = token.rsplit(".", 1)
        expected = hmac.new(_secret(), raw.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        data = json.loads(base64.urlsafe_b64decode(raw.encode("ascii")))
    except Exception:
        return None
    if int(data.get("exp", 0)) < int(time.time()):
        return None
    if int(data.get("v", -1)) != session_version():
        return None
    return int(data.get("u", 0)) or None


def set_session_cookie(response: Response, user_id: int, request: Request) -> None:
    secure = (
        request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto", "").lower() == "https"
    )
    response.set_cookie(
        key=SESSION_COOKIE,
        value=create_session_token(user_id),
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def optional_user(request: Request) -> Optional[dict]:
    """返回当前登录用户行（id/username/display_name/role），未登录或用户已删除返回 None。"""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    user_id = verify_session_token(token)
    if not user_id:
        return None
    return db.get_user(user_id)


def current_user(request: Request) -> dict:
    user = optional_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="未登录或登录已失效")
    return user


def current_admin(user: dict = Depends(current_user)) -> dict:
    """FastAPI 依赖：必须是管理员。"""
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


# ---------------------------------------------------------------- roles / owner


def is_read_only(user: dict) -> bool:
    return (user or {}).get("role") == "doctor"


def ensure_writable(user: dict) -> None:
    if is_read_only(user):
        raise HTTPException(status_code=403, detail="医生账号为只读")


def resolve_owner(user: dict, patient_id: int | None = None) -> int:
    """把请求解析为要读取的 owner_id；无权限时抛 403。"""
    if user is None:
        raise HTTPException(status_code=401, detail="未登录")
    role = user.get("role")
    user_id = int(user["id"])
    if role == "admin":
        if patient_id in (None, "", 0):
            return user_id
        target = db.get_user(int(patient_id))
        if target is None:
            raise HTTPException(status_code=404, detail="用户不存在")
        return int(target["id"])
    if role == "doctor":
        if patient_id in (None, "", 0):
            raise HTTPException(status_code=403, detail="医生需要指定患者")
        target_id = int(patient_id)
        if target_id not in db.doctor_patients(user_id):
            raise HTTPException(status_code=403, detail="无权查看该患者数据")
        return target_id
    # 普通用户
    if patient_id not in (None, "", 0) and int(patient_id) != user_id:
        raise HTTPException(status_code=403, detail="无权访问其他用户数据")
    return user_id


def owner_settings(user: dict, patient_id: int | None = None) -> tuple[int, dict]:
    """返回 (owner_id, settings)，供读接口使用。"""
    owner = resolve_owner(user, patient_id)
    return owner, db.get_settings(owner)


def viewer_can_view_upload(user: dict, owner_id: int) -> bool:
    if user.get("role") == "admin":
        return True
    if int(owner_id) == int(user["id"]):
        return True
    if user.get("role") == "doctor":
        return int(owner_id) in db.doctor_patients(int(user["id"]))
    return False


# ---------------------------------------------------------------- rate limit


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_login_allowed(request: Request) -> None:
    ip = _client_ip(request)
    cutoff = time.time() - _RATE_LIMIT_WINDOW
    with _rate_lock:
        attempts = [t for t in _rate_state.get(ip, []) if t >= cutoff]
        _rate_state[ip] = attempts
        if len(attempts) >= _RATE_LIMIT_MAX_FAILS:
            raise HTTPException(status_code=429, detail="尝试次数过多，请 15 分钟后再试")


def record_login_failure(request: Request) -> None:
    ip = _client_ip(request)
    cutoff = time.time() - _RATE_LIMIT_WINDOW
    with _rate_lock:
        attempts = [t for t in _rate_state.get(ip, []) if t >= cutoff]
        attempts.append(time.time())
        _rate_state[ip] = attempts


def clear_login_failures(request: Request) -> None:
    ip = _client_ip(request)
    with _rate_lock:
        _rate_state.pop(ip, None)
