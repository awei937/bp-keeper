"""通知通道：ntfy / PushPlus / 邮件 / 通用 Webhook。"""
import asyncio
import json
import smtplib
import ssl
import urllib.error
import urllib.request
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr
from typing import Any


def _post_json(url: str, payload: dict, headers: dict | None = None, method: str = "POST") -> str:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method=method.upper(),
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "bp-keeper/1.0",
            **(headers or {}),
        },
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        text = response.read(2000).decode("utf-8", "replace")
        return f"HTTP {response.status}: {text[:300]}"


def send_ntfy(cfg: dict, title: str, body: str) -> str:
    server = (cfg.get("server") or "https://ntfy.sh").rstrip("/")
    topic = (cfg.get("topic") or "").strip()
    if not topic:
        raise ValueError("ntfy 未配置 topic")
    headers = {}
    token = (cfg.get("token") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = {"topic": topic, "title": title, "message": body, "priority": 4, "tags": ["pill"]}
    return _post_json(server + "/", payload, headers=headers)


def send_pushplus(cfg: dict, title: str, body: str) -> str:
    token = (cfg.get("token") or "").strip()
    if not token:
        raise ValueError("PushPlus 未配置 token")
    payload = {"token": token, "title": title, "content": body, "template": "txt"}
    return _post_json("https://www.pushplus.plus/send", payload)


def send_email(cfg: dict, title: str, body: str) -> str:
    host = (cfg.get("smtp_host") or "").strip()
    to_addr = (cfg.get("to") or "").strip()
    username = (cfg.get("username") or "").strip()
    password = cfg.get("password") or ""
    if not host or not to_addr or not username:
        raise ValueError("邮件通道未配置完整（smtp_host/username/to）")
    port = int(cfg.get("smtp_port") or 465)
    use_ssl = bool(cfg.get("ssl", True))
    message = MIMEText(body, "plain", "utf-8")
    message["Subject"] = Header(title, "utf-8")
    message["From"] = formataddr((str(Header("血压管家", "utf-8")), username))
    message["To"] = to_addr
    if use_ssl:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, timeout=15, context=context) as smtp:
            smtp.login(username, password)
            smtp.sendmail(username, [a.strip() for a in to_addr.split(",") if a.strip()], message.as_string())
    else:
        with smtplib.SMTP(host, port, timeout=15) as smtp:
            smtp.starttls(context=ssl.create_default_context())
            smtp.login(username, password)
            smtp.sendmail(username, [a.strip() for a in to_addr.split(",") if a.strip()], message.as_string())
    return "邮件已发送"


def send_webhook(cfg: dict, title: str, body: str) -> str:
    url = (cfg.get("url") or "").strip()
    if not url:
        raise ValueError("Webhook 未配置 url")
    method = (cfg.get("method") or "POST").upper()
    payload = {"title": title, "body": body, "app": "血压管家"}
    if method == "GET":
        from urllib.parse import urlencode

        sep = "&" if "?" in url else "?"
        with urllib.request.urlopen(url + sep + urlencode(payload), timeout=12) as response:
            return f"HTTP {response.status}"
    return _post_json(url, payload, method=method)


SENDERS = {
    "ntfy": send_ntfy,
    "pushplus": send_pushplus,
    "email": send_email,
    "webhook": send_webhook,
}


def _dispatch(cfg: dict, channel: str, title: str, body: str) -> dict:
    try:
        detail = SENDERS[channel](cfg, title, body)
        return {"channel": channel, "ok": True, "detail": detail}
    except Exception as exc:  # noqa: BLE001 - 通道失败不能影响主流程
        return {"channel": channel, "ok": False, "detail": f"{type(exc).__name__}: {exc}"}


async def send_channels(settings: dict, title: str, body: str) -> list[dict]:
    channels = settings.get("channels") or {}
    tasks = []
    for name in ("ntfy", "pushplus", "email", "webhook"):
        cfg = channels.get(name) or {}
        if cfg.get("enabled"):
            tasks.append(asyncio.to_thread(_dispatch, cfg, name, title, body))
    if not tasks:
        return []
    return list(await asyncio.gather(*tasks))


async def test_channel(settings: dict, channel: str) -> dict:
    channels = settings.get("channels") or {}
    cfg = channels.get(channel) or {}
    if not cfg.get("enabled"):
        return {"ok": False, "message": f"{channel} 通道未启用"}
    result = await asyncio.to_thread(
        _dispatch, cfg, channel, "血压管家测试通知", "这是一条测试通知，收到说明通知通道配置成功。"
    )
    return {"ok": bool(result["ok"]), "message": result["detail"]}
