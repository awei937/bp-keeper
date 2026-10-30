"""日历提醒导出测试：在本地或容器内直接调用 build_ics 校验输出。"""
from app import db
from app.services.exports import build_ics


def main():
    settings = db.get_settings()
    conn = db.connect()
    try:
        medications = [dict(row) for row in conn.execute("SELECT * FROM medications").fetchall()]
    finally:
        conn.close()
    content = build_ics(settings, medications).decode("utf-8")
    checks = []

    def check(name, condition, detail=""):
        checks.append((name, bool(condition), detail))
        print(("PASS" if condition else "FAIL"), "-", name, detail if not condition else "")

    check("BEGIN:VCALENDAR", content.startswith("BEGIN:VCALENDAR\r\n"))
    check("END:VCALENDAR", content.rstrip().endswith("END:VCALENDAR"))
    check("CRLF 换行", "\r\n" in content and "\n\n" not in content.replace("\r\n", "\n"))
    check("包含测量提醒", content.count("测血压") >= 4, content.count("测血压"))
    check("包含 VALARM", content.count("BEGIN:VALARM") >= 4, content.count("BEGIN:VALARM"))
    check("包含 RRULE", "RRULE:FREQ=DAILY" in content)
    check("VTIMEZONE", "BEGIN:VTIMEZONE" in content)
    check("无超长行", all(len(line.encode("utf-8")) <= 76 for line in content.split("\r\n")), "fold check")
    if medications:
        check("包含吃药提醒", "吃药" in content)
    failed = [item for item in checks if not item[1]]
    print(f"\n结果: {len(checks) - len(failed)}/{len(checks)} 通过")
    if failed:
        raise SystemExit(1)
    print("CALENDAR ICS OK")


if __name__ == "__main__":
    main()
