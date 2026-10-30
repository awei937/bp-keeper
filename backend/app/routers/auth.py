"""认证接口。"""
import time

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from .. import captcha, db
from ..schemas import LoginIn, PasswordIn, ProfileIn, SetupIn
from ..security import (
    bump_session_version,
    check_login_allowed,
    clear_login_failures,
    clear_session_cookie,
    current_user,
    hash_password,
    optional_user,
    record_login_failure,
    set_session_cookie,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

MAX_FAILED_ATTEMPTS = 5
LOCK_SECONDS = 15 * 60


@router.get("/captcha")
def get_captcha():
    """登录验证码：一次性、5 分钟有效、图片以 data URL 返回。"""
    token, image = captcha.create_captcha()
    return {"id": token, "image": image, "expires_in": captcha.CAPTCHA_TTL}


@router.get("/status")
def auth_status(request: Request):
    user = optional_user(request)
    return {
        "initialized": db.table_count("users") > 0,
        "authenticated": user is not None,
        "user": db.public_user(user) if user else None,
    }


@router.post("/setup")
def setup(payload: SetupIn, request: Request, response: Response):
    if db.table_count("users") > 0:
        raise HTTPException(status_code=409, detail="已初始化，请直接登录")
    username = payload.username.strip() or "admin"
    pw_hash, salt = hash_password(payload.password)
    conn = db.connect()
    try:
        cursor = conn.execute(
            "INSERT INTO users(username, pw_hash, salt, role, display_name, created_at) VALUES(?, ?, ?, 'admin', '', ?)",
            (username, pw_hash, salt, db.now_iso()),
        )
        user_id = int(cursor.lastrowid)
        # 首次初始化时，把预置数据（owner_id=0，例如部署脚本 seed 的历史数据）归到新管理员
        for table in ("measurements", "medications", "med_logs", "reminder_events", "uploads"):
            conn.execute(f"UPDATE {table} SET owner_id = ? WHERE owner_id = 0", (user_id,))
        conn.commit()
    finally:
        conn.close()
    set_session_cookie(response, user_id, request)
    return {"ok": True}


def _reset_login_lock(user_id: int) -> None:
    conn = db.connect()
    try:
        conn.execute(
            "UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?", (user_id,)
        )
        conn.commit()
    finally:
        conn.close()


def _register_failure(user: dict) -> None:
    attempts = int(user.get("failed_attempts") or 0) + 1
    locked_until = 0
    if attempts >= MAX_FAILED_ATTEMPTS:
        locked_until = int(time.time()) + LOCK_SECONDS
    conn = db.connect()
    try:
        conn.execute(
            "UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?",
            (attempts, locked_until, int(user["id"])),
        )
        conn.commit()
    finally:
        conn.close()


def _lock_remaining(user: dict) -> int:
    locked_until = int(user.get("locked_until") or 0)
    remaining = locked_until - int(time.time())
    return max(0, remaining)


@router.post("/login")
def login(payload: LoginIn, request: Request, response: Response):
    check_login_allowed(request)
    if db.table_count("users") == 0:
        raise HTTPException(status_code=409, detail="尚未初始化，请先设置密码")
    if not captcha.verify_captcha(payload.captcha_id, payload.captcha):
        raise HTTPException(status_code=400, detail="验证码不正确，请刷新后重试")
    username = (payload.username or "admin").strip() or "admin"
    user = db.get_user_by_username(username)
    if user is None:
        record_login_failure(request)
        raise HTTPException(status_code=401, detail="用户名或密码不正确")
    remaining = _lock_remaining(user)
    if remaining > 0:
        raise HTTPException(
            status_code=423,
            detail=f"账号已锁定，请 {max(1, (remaining + 59) // 60)} 分钟后再试",
        )
    if not verify_password(payload.password, user["pw_hash"], user["salt"]):
        _register_failure(user)
        record_login_failure(request)
        raise HTTPException(status_code=401, detail="用户名或密码不正确")
    clear_login_failures(request)
    _reset_login_lock(int(user["id"]))
    set_session_cookie(response, int(user["id"]), request)
    return {"ok": True}


@router.post("/logout")
def logout(response: Response):
    clear_session_cookie(response)
    return {"ok": True}


@router.patch("/profile")
def update_profile(payload: ProfileIn, user: dict = Depends(current_user)):
    """修改当前登录用户自己的显示名称（用户名 / 角色不可自改）。"""
    display_name = (payload.display_name or "").strip()
    conn = db.connect()
    try:
        conn.execute(
            "UPDATE users SET display_name = ? WHERE id = ?",
            (display_name, int(user["id"])),
        )
        conn.commit()
    finally:
        conn.close()
    row = db.get_user(int(user["id"]))
    if row is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    return {"ok": True, "user": db.public_user(row)}


@router.post("/password")
def change_password(
    payload: PasswordIn,
    request: Request,
    response: Response,
    user: dict = Depends(current_user),
):
    row = db.get_user(int(user["id"]))
    if row is None or not verify_password(payload.old_password, row["pw_hash"], row["salt"]):
        raise HTTPException(status_code=400, detail="原密码不正确")
    pw_hash, salt = hash_password(payload.new_password)
    conn = db.connect()
    try:
        conn.execute(
            "UPDATE users SET pw_hash = ?, salt = ?, failed_attempts = 0, locked_until = 0 WHERE id = ?",
            (pw_hash, salt, int(user["id"])),
        )
        conn.commit()
    finally:
        conn.close()
    bump_session_version()
    set_session_cookie(response, int(user["id"]), request)
    return {"ok": True}
