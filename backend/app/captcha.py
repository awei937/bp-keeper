"""登录图像验证码（存 SQLite，一次性、5 分钟有效，支持多进程/测试）。"""
import base64
import io
import random
import secrets
import time

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from . import db

CAPTCHA_TTL = 300
_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def _font(size: int):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _render(code: str) -> str:
    width, height = 136, 48
    image = Image.new("RGB", (width, height), (245, 250, 249))
    draw = ImageDraw.Draw(image)
    for _ in range(7):
        draw.line(
            (
                random.randint(0, width),
                random.randint(0, height),
                random.randint(0, width),
                random.randint(0, height),
            ),
            fill=(random.randint(140, 215), random.randint(160, 225), random.randint(155, 215)),
            width=1,
        )
    for _ in range(80):
        draw.point(
            (random.randint(0, width), random.randint(0, height)),
            fill=(random.randint(120, 210), random.randint(130, 220), random.randint(130, 210)),
        )
    font = _font(29)
    x = 9
    for char in code:
        layer = Image.new("RGBA", (34, 42), (0, 0, 0, 0))
        layer_draw = ImageDraw.Draw(layer)
        color = (
            random.randint(20, 90),
            random.randint(70, 130),
            random.randint(80, 140),
        )
        layer_draw.text((3, 2), char, font=font, fill=color)
        layer = layer.rotate(random.uniform(-22, 22), expand=1, resample=Image.BICUBIC)
        image.paste(layer, (x, random.randint(1, 9)), layer)
        x += 31
    image = image.filter(ImageFilter.SMOOTH)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return "data:image/png;base64," + encoded


def create_captcha() -> tuple[str, str]:
    db.init_db()
    code = "".join(secrets.choice(_ALPHABET) for _ in range(4))
    token = secrets.token_urlsafe(18)
    data_url = _render(code)
    now = int(time.time())
    conn = db.connect()
    try:
        conn.execute("DELETE FROM captcha_challenges WHERE expires < ?", (now,))
        conn.execute(
            "INSERT INTO captcha_challenges(token, answer, expires) VALUES(?, ?, ?)",
            (token, code, now + CAPTCHA_TTL),
        )
        conn.commit()
    finally:
        conn.close()
    return token, data_url


def verify_captcha(token: str | None, answer: str | None) -> bool:
    if not token or not answer:
        return False
    db.init_db()
    conn = db.connect()
    try:
        row = conn.execute(
            "SELECT answer, expires FROM captcha_challenges WHERE token = ?", (token.strip(),)
        ).fetchone()
        conn.execute("DELETE FROM captcha_challenges WHERE token = ?", (token.strip(),))
        conn.commit()
    finally:
        conn.close()
    if row is None:
        return False
    if int(row["expires"]) < int(time.time()):
        return False
    return answer.strip().upper() == str(row["answer"]).upper()


__all__ = ["CAPTCHA_TTL", "create_captcha", "verify_captcha"]
