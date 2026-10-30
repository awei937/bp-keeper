"""导出：Excel / CSV / JSON 备份 / 日历提醒 / 打印报告。"""
import csv
import html
import io
import json
import math
from datetime import date, datetime, time as dtime, timedelta, timezone

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from .. import db
from ..config import SLOT_LABELS
from ..timeutil import get_tz, now_local
from .stats import stats_payload

THIN = Side(style="thin", color="FFD9D9D9")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEADER_FILL = PatternFill("solid", fgColor="FFE8F5F1")
HEADER_FONT = Font(name="等线", bold=True, size=11)
BODY_FONT = Font(name="等线", size=10.5)
TITLE_FONT = Font(name="等线", bold=True, size=14)

STATUS_TEXT = {"pending": "未打卡", "taken": "已服", "skipped": "跳过"}


def _style_header(ws, row: int, columns: int) -> None:
    for col in range(1, columns + 1):
        cell = ws.cell(row=row, column=col)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.border = BORDER
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def _autosize(ws, widths: dict[int, int]) -> None:
    for index, width in widths.items():
        ws.column_dimensions[get_column_letter(index)].width = width


def fetch_measurements(date_from: str | None, date_to: str | None, owner_id: int) -> list:
    sql = "SELECT * FROM measurements WHERE owner_id = ?"
    params: list = [int(owner_id)]
    if date_from:
        sql += " AND local_date >= ?"
        params.append(date_from)
    if date_to:
        sql += " AND local_date <= ?"
        params.append(date_to)
    sql += " ORDER BY measured_at ASC"
    conn = db.connect()
    try:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def fetch_med_logs(date_from: str | None, date_to: str | None, owner_id: int) -> list:
    sql = (
        "SELECT l.*, m.name, m.dose, m.unit FROM med_logs l "
        "JOIN medications m ON m.id = l.medication_id WHERE l.owner_id = ? AND m.owner_id = ?"
    )
    params: list = [int(owner_id), int(owner_id)]
    if date_from:
        sql += " AND l.date >= ?"
        params.append(date_from)
    if date_to:
        sql += " AND l.date <= ?"
        params.append(date_to)
    sql += " ORDER BY l.date ASC, l.scheduled_time ASC"
    conn = db.connect()
    try:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def _format_measured(item: dict) -> tuple[str, str]:
    try:
        dt = datetime.fromisoformat(item["measured_at"])
        return dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M")
    except Exception:
        return item.get("local_date", ""), ""


def build_xlsx(measurements: list, med_logs: list, settings: dict, date_from: str, date_to: str) -> bytes:
    workbook = Workbook()

    sheet = workbook.active
    sheet.title = "血压记录"
    headers = ["日期", "时间", "收缩压(mmHg)", "舒张压(mmHg)", "脉率(次/分)", "时段", "左右手", "体位", "备注", "来源"]
    sheet.append(headers)
    _style_header(sheet, 1, len(headers))
    for item in measurements:
        day, clock = _format_measured(item)
        sheet.append(
            [
                day,
                clock,
                item["systolic"],
                item["diastolic"],
                item["pulse"] if item["pulse"] is not None else "",
                SLOT_LABELS.get(item["slot"] or "other", item["slot"] or ""),
                {"left": "左手", "right": "右手"}.get(item["arm"] or "", ""),
                {"sitting": "坐位", "lying": "卧位", "standing": "站位"}.get(item["position"] or "", ""),
                item["note"] or "",
                "识别" if item["source"] == "ocr" else "手动",
            ]
        )
    for row in sheet.iter_rows(min_row=2, max_row=sheet.max_row, max_col=len(headers)):
        for cell in row:
            cell.font = BODY_FONT
            cell.border = BORDER
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    sheet.freeze_panes = "A2"
    _autosize(sheet, {1: 12, 2: 8, 3: 13, 4: 13, 5: 11, 6: 8, 7: 8, 8: 8, 9: 26, 10: 8})

    sheet2 = workbook.create_sheet("服药记录")
    headers2 = ["日期", "药品", "剂量", "计划时间", "状态", "实际时间", "备注"]
    sheet2.append(headers2)
    _style_header(sheet2, 1, len(headers2))
    for item in med_logs:
        taken = ""
        if item.get("taken_at"):
            try:
                taken = datetime.fromisoformat(item["taken_at"]).strftime("%H:%M")
            except Exception:
                taken = item["taken_at"]
        dose = item["dose"]
        dose_text = f"{int(dose) if float(dose).is_integer() else dose}{item['unit']}"
        sheet2.append(
            [
                item["date"],
                item["name"],
                dose_text,
                item["scheduled_time"],
                STATUS_TEXT.get(item["status"], item["status"]),
                taken,
                item["note"] or "",
            ]
        )
    for row in sheet2.iter_rows(min_row=2, max_row=sheet2.max_row, max_col=len(headers2)):
        for cell in row:
            cell.font = BODY_FONT
            cell.border = BORDER
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    sheet2.freeze_panes = "A2"
    _autosize(sheet2, {1: 12, 2: 18, 3: 10, 4: 10, 5: 8, 6: 10, 7: 26})

    sheet3 = workbook.create_sheet("统计摘要")
    stats = stats_payload(
        [
            {
                "systolic": m["systolic"],
                "diastolic": m["diastolic"],
                "pulse": m["pulse"],
                "slot": m["slot"],
                "local_date": m["local_date"],
            }
            for m in measurements
        ],
        days=0,
        settings=settings,
    )
    sheet3["A1"] = "血压记录统计摘要"
    sheet3["A1"].font = TITLE_FONT
    sheet3["A2"] = f"统计区间：{date_from or '全部'} 至 {date_to or '全部'}"
    sheet3["A3"] = f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}"
    rows = [
        ("记录条数", stats["count"]),
        ("收缩压平均值", stats["avg_sys"]),
        ("舒张压平均值", stats["avg_dia"]),
        ("脉率平均值", stats["avg_pulse"]),
        ("收缩压最高值", stats["max_sys"]),
        ("舒张压最高值", stats["max_dia"]),
        ("超标次数（≥目标值）", stats["high_count"]),
        ("正常血压次数", stats["classification"]["normal"]),
        ("正常高值次数", stats["classification"]["elevated"]),
        ("高血压范围次数", stats["classification"]["high"]),
    ]
    start = 5
    for offset, (label, value) in enumerate(rows):
        sheet3.cell(row=start + offset, column=1, value=label).font = BODY_FONT
        cell = sheet3.cell(row=start + offset, column=2, value=value)
        cell.font = BODY_FONT
        cell.alignment = Alignment(horizontal="center")
    adherence_start = start + len(rows) + 2
    taken = sum(1 for item in med_logs if item["status"] == "taken")
    skipped = sum(1 for item in med_logs if item["status"] == "skipped")
    total = len(med_logs)
    sheet3.cell(row=adherence_start, column=1, value="服药任务总数").font = BODY_FONT
    sheet3.cell(row=adherence_start, column=2, value=total).alignment = Alignment(horizontal="center")
    sheet3.cell(row=adherence_start + 1, column=1, value="按时服药").font = BODY_FONT
    sheet3.cell(row=adherence_start + 1, column=2, value=taken).alignment = Alignment(horizontal="center")
    sheet3.cell(row=adherence_start + 2, column=1, value="跳过").font = BODY_FONT
    sheet3.cell(row=adherence_start + 2, column=2, value=skipped).alignment = Alignment(horizontal="center")
    if total:
        sheet3.cell(row=adherence_start + 3, column=1, value="服药依从率").font = BODY_FONT
        sheet3.cell(row=adherence_start + 3, column=2, value=f"{taken / total * 100:.1f}%").alignment = Alignment(
            horizontal="center"
        )
    _autosize(sheet3, {1: 22, 2: 16})

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def build_csv(rows: list[dict], kind: str) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    if kind == "med":
        writer.writerow(["日期", "药品", "剂量", "计划时间", "状态", "实际时间", "备注"])
        for item in rows:
            dose = item["dose"]
            dose_text = f"{int(dose) if float(dose).is_integer() else dose}{item['unit']}"
            writer.writerow(
                [
                    item["date"],
                    item["name"],
                    dose_text,
                    item["scheduled_time"],
                    STATUS_TEXT.get(item["status"], item["status"]),
                    item.get("taken_at") or "",
                    item.get("note") or "",
                ]
            )
    else:
        writer.writerow(["日期", "时间", "收缩压", "舒张压", "脉率", "时段", "左右手", "体位", "备注", "来源"])
        for item in rows:
            day, clock = _format_measured(item)
            writer.writerow(
                [
                    day,
                    clock,
                    item["systolic"],
                    item["diastolic"],
                    item["pulse"] if item["pulse"] is not None else "",
                    SLOT_LABELS.get(item["slot"] or "other", item["slot"] or ""),
                    item["arm"] or "",
                    item["position"] or "",
                    item["note"] or "",
                    item["source"],
                ]
            )
    return buffer.getvalue()


def build_backup(owner_id: int) -> bytes:
    owner = int(owner_id)
    conn = db.connect()
    try:
        data = {
            "app": "血压管家",
            "version": 2,
            "exported_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "owner_id": owner,
            "settings": {k: v for k, v in db.get_settings(owner).items() if not k.startswith("_")},
            "measurements": [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM measurements WHERE owner_id = ? ORDER BY id", (owner,)
                ).fetchall()
            ],
            "medications": [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM medications WHERE owner_id = ? ORDER BY id", (owner,)
                ).fetchall()
            ],
            "med_logs": [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM med_logs WHERE owner_id = ? ORDER BY id", (owner,)
                ).fetchall()
            ],
        }
    finally:
        conn.close()
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


# ---------------------------------------------------------------- 日历提醒 (.ics)


def _ics_escape(text) -> str:
    value = str(text or "")
    return (
        value.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\r\n", "\\n")
        .replace("\n", "\\n")
    )


def _ics_fold(line: str, limit: int = 73) -> str:
    """按 RFC5545 每 75 字节折行（中文按 UTF-8 字节算）。"""
    if len(line.encode("utf-8")) <= limit:
        return line
    chunks: list[str] = []
    current = ""
    current_len = 0
    for char in line:
        char_len = len(char.encode("utf-8"))
        if current_len + char_len > limit:
            chunks.append(current)
            current = char
            current_len = char_len
        else:
            current += char
            current_len += char_len
    if current:
        chunks.append(current)
    return "\r\n ".join(chunks)


def _ics_datetime(day: date, hhmm_text: str) -> str:
    hour, minute = hhmm_text.split(":")
    return f"{day.strftime('%Y%m%d')}T{hour}{minute}00"


def build_ics(settings: dict, medications: list) -> bytes:
    """生成每日测量/服药提醒日历（.ics），可导入手机系统日历。"""
    tz = get_tz(settings)
    tzid = settings.get("timezone") or "Asia/Shanghai"
    now = now_local(settings)
    today = now.date()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//BP Keeper//血压管家 v1.0//CN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:" + _ics_escape("血压管家提醒"),
        "X-WR-TIMEZONE:" + tzid,
        "X-WR-CALDESC:" + _ics_escape("每天测血压与吃药提醒"),
        "BEGIN:VTIMEZONE",
        "TZID:" + tzid,
        "BEGIN:STANDARD",
        "DTSTART:19700101T000000",
        "TZOFFSETFROM:+0800",
        "TZOFFSETTO:+0800",
        "TZNAME:CST",
        "END:STANDARD",
        "END:VTIMEZONE",
    ]

    slot_times = settings.get("slot_times") or {}
    windows = settings.get("slot_windows") or {}
    for slot in ("morning", "forenoon", "afternoon", "bedtime"):
        slot_time = slot_times.get(slot)
        if not slot_time:
            continue
        label = SLOT_LABELS.get(slot, slot)
        window = windows.get(slot)
        window_text = f"{window[0]}–{window[1]}" if window and len(window) == 2 else ""
        lines += [
            "BEGIN:VEVENT",
            f"UID:bp-measure-{slot}@bp-keeper",
            f"DTSTAMP:{stamp}",
            f"DTSTART;TZID={tzid}:{_ics_datetime(today, slot_time)}",
            "RRULE:FREQ=DAILY",
            "SUMMARY:" + _ics_escape(f"测血压（{label}）"),
            "DESCRIPTION:" + _ics_escape(f"{label} {window_text} 测血压，记录到「血压管家」"),
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "DESCRIPTION:" + _ics_escape("该测血压了"),
            "TRIGGER:-PT5M",
            "END:VALARM",
            "END:VEVENT",
        ]

    for medication in medications:
        if not medication.get("active"):
            continue
        try:
            med_times = json.loads(medication.get("times") or "[]")
        except json.JSONDecodeError:
            continue
        try:
            start_date = date.fromisoformat(medication.get("start_date") or today.isoformat())
        except ValueError:
            start_date = today
        start_date = max(start_date, today)
        end_date = None
        if medication.get("end_date"):
            try:
                end_date = date.fromisoformat(medication["end_date"])
            except ValueError:
                end_date = None
        dose = medication.get("dose")
        dose_text = (
            f"{int(dose) if isinstance(dose, (int, float)) and float(dose).is_integer() else dose}"
            f"{medication.get('unit') or ''}"
        )
        for index, med_time in enumerate(med_times):
            if not isinstance(med_time, str) or len(med_time) != 5:
                continue
            lines += [
                "BEGIN:VEVENT",
                f"UID:bp-med-{medication.get('id')}-{index}@bp-keeper",
                f"DTSTAMP:{stamp}",
                f"DTSTART;TZID={tzid}:{_ics_datetime(start_date, med_time)}",
            ]
            rrule = "RRULE:FREQ=DAILY"
            if end_date is not None and end_date >= today:
                until_local = datetime.combine(end_date + timedelta(days=1), dtime(0, 0), tzinfo=tz)
                rrule += ";UNTIL=" + until_local.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            lines += [
                rrule,
                "SUMMARY:" + _ics_escape(f"吃药：{medication.get('name')}"),
                "DESCRIPTION:" + _ics_escape(
                    f"{medication.get('name')} {dose_text}，计划 {med_time}，吃完在「血压管家」打卡"
                ),
                "BEGIN:VALARM",
                "ACTION:DISPLAY",
                "DESCRIPTION:" + _ics_escape(f"该吃药了：{medication.get('name')} {dose_text}"),
                "TRIGGER:-PT0M",
                "END:VALARM",
                "END:VEVENT",
            ]

    lines.append("END:VCALENDAR")
    content = "\r\n".join(_ics_fold(line) for line in lines) + "\r\n"
    return content.encode("utf-8")


# ---------------------------------------------------------------- 打印报告 (HTML)


def _esc(value) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


def _svg_trend(series: list) -> str:
    if not series:
        return '<p class="muted">暂无趋势数据</p>'
    width, height = 760, 220
    left, right, top, bottom = 46, 16, 14, 34
    plot_w = width - left - right
    plot_h = height - top - bottom
    low, high = 50.0, 180.0

    def x_of(index: int) -> float:
        if len(series) == 1:
            return left + plot_w / 2
        return left + plot_w * index / (len(series) - 1)

    def y_of(value: float) -> float:
        value = max(low, min(high, float(value)))
        return top + plot_h * (high - value) / (high - low)

    parts = [f'<svg viewBox="0 0 {width} {height}" width="100%" role="img" aria-label="血压趋势图">']
    for value in range(60, 181, 20):
        y = y_of(value)
        parts.append(f'<line x1="{left}" y1="{y:.1f}" x2="{width - right}" y2="{y:.1f}" stroke="#e2e8e6" stroke-width="1"/>')
        parts.append(f'<text x="{left - 8}" y="{y + 4:.1f}" text-anchor="end" font-size="11" fill="#667">{value}</text>')
    step = max(1, math.ceil(len(series) / 8))
    for index, item in enumerate(series):
        if index % step != 0 and index != len(series) - 1:
            continue
        x = x_of(index)
        label = item["date"][5:]
        parts.append(f'<text x="{x:.1f}" y="{height - 10}" text-anchor="middle" font-size="10" fill="#667">{label}</text>')
    for key, color in (("avg_sys", "#0e9f8a"), ("avg_dia", "#d97706")):
        points = [
            (x_of(index), y_of(item[key]))
            for index, item in enumerate(series)
            if item.get(key) is not None
        ]
        if not points:
            continue
        points_text = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
        parts.append(f'<polyline fill="none" stroke="{color}" stroke-width="2.2" points="{points_text}"/>')
        for x, y in points:
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{color}"/>')
    parts.append("</svg>")
    return "".join(parts)


def build_report_html(measurements: list, med_logs: list, settings: dict, start: str, end: str, days: int, patient_id: int | None = None) -> str:
    stats = stats_payload(
        [
            {
                "systolic": item["systolic"],
                "diastolic": item["diastolic"],
                "pulse": item["pulse"],
                "slot": item["slot"],
                "local_date": item["local_date"],
            }
            for item in measurements
        ],
        days=days,
        settings=settings,
    )
    slot_labels = {"morning": "早上", "forenoon": "上午", "afternoon": "下午", "bedtime": "睡前", "other": "其他"}
    generated = datetime.now().strftime("%Y-%m-%d %H:%M")
    cache_bust = str(int(datetime.now().timestamp()))
    taken = sum(1 for item in med_logs if item["status"] == "taken")
    skipped = sum(1 for item in med_logs if item["status"] == "skipped")
    total_med = len(med_logs)
    adherence = f"{taken / total_med * 100:.0f}%" if total_med else "—"

    rows = []
    for item in measurements:
        day, clock = _format_measured(item)
        rows.append(
            "<tr>"
            f"<td>{_esc(day)}</td><td>{_esc(clock)}</td>"
            f"<td class='num'>{item['systolic']}</td><td class='num'>{item['diastolic']}</td>"
            f"<td class='num'>{_esc(item['pulse'] if item['pulse'] is not None else '—')}</td>"
            f"<td>{_esc(slot_labels.get(item['slot'] or 'other', ''))}</td>"
            f"<td>{_esc({'left': '左手', 'right': '右手'}.get(item['arm'] or '', '—'))}</td>"
            f"<td>{_esc(item['note'] or '')}</td>"
            "</tr>"
        )
    if not rows:
        rows.append('<tr><td colspan="8" class="empty">统计区间内暂无血压记录</td></tr>')

    med_rows = []
    for item in med_logs:
        status_text = {"pending": "未打卡", "taken": "已服", "skipped": "跳过"}.get(item["status"], item["status"])
        dose = item["dose"]
        dose_text = f"{int(dose) if float(dose).is_integer() else dose}{item['unit']}"
        taken_at = item.get("taken_at") or ""
        if taken_at:
            try:
                taken_at = datetime.fromisoformat(taken_at).strftime("%H:%M")
            except ValueError:
                pass
        med_rows.append(
            "<tr>"
            f"<td>{_esc(item['date'])}</td><td>{_esc(item['name'])}</td><td>{_esc(dose_text)}</td>"
            f"<td>{_esc(item['scheduled_time'])}</td><td>{_esc(status_text)}</td><td>{_esc(taken_at)}</td>"
            "</tr>"
        )
    if not med_rows:
        med_rows.append('<tr><td colspan="6" class="empty">统计区间内暂无服药记录</td></tr>')

    slot_rows = []
    for key, label in (("morning", "早上"), ("forenoon", "上午"), ("afternoon", "下午"), ("bedtime", "睡前")):
        data = stats["by_slot"].get(key)
        if not data:
            slot_rows.append(f"<tr><td>{label}</td><td class='num'>0</td><td class='num'>—</td><td class='num'>—</td></tr>")
            continue
        slot_rows.append(
            f"<tr><td>{label}</td><td class='num'>{data['count']}</td>"
            f"<td class='num'>{data.get('avg_sys') if data.get('avg_sys') is not None else '—'}</td>"
            f"<td class='num'>{data.get('avg_dia') if data.get('avg_dia') is not None else '—'}</td></tr>"
        )

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>血压监测报告（{_esc(start)} 至 {_esc(end)}）</title>
<style>
  :root {{ --teal: #0e9f8a; --ink: #1f2d2a; --muted: #667; --line: #c9d6d2; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; padding: 24px; background: #f3f6f5; color: var(--ink);
         font-family: "Microsoft YaHei", "Noto Sans CJK SC", "PingFang SC", sans-serif; font-size: 13px; }}
  .sheet {{ max-width: 860px; margin: 0 auto; background: #fff; padding: 28px 32px;
           border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.08); }}
  h1 {{ margin: 0 0 6px; font-size: 22px; }}
  h2 {{ font-size: 15px; margin: 26px 0 10px; padding-left: 10px; border-left: 4px solid var(--teal); }}
  .meta {{ color: var(--muted); font-size: 12px; margin-bottom: 4px; }}
  .cards {{ display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }}
  .card {{ flex: 1 1 120px; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }}
  .card .label {{ color: var(--muted); font-size: 11px; }}
  .card .value {{ font-size: 20px; font-weight: 700; margin-top: 2px; }}
  .card .unit {{ font-size: 11px; color: var(--muted); font-weight: 400; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
  th, td {{ border: 1px solid var(--line); padding: 5px 7px; text-align: left; }}
  th {{ background: #eef5f3; }}
  td.num {{ text-align: center; }}
  td.empty {{ text-align: center; color: var(--muted); }}
  .muted {{ color: var(--muted); }}
  .legend {{ display: flex; gap: 18px; color: var(--muted); font-size: 12px; margin-top: 4px; }}
  .dot {{ display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; }}
  .actions {{ display: flex; gap: 10px; margin: 18px 0 0; }}
  .actions button, .actions a {{ border: 1px solid var(--teal); background: var(--teal); color: #fff;
      border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; text-decoration: none; }}
  .actions a.ghost {{ background: #fff; color: var(--teal); }}
  .footer {{ margin-top: 26px; color: var(--muted); font-size: 11px; line-height: 1.7;
             border-top: 1px dashed var(--line); padding-top: 12px; }}
  .report-head {{ display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }}
  .range-links a {{ color: var(--teal); text-decoration: none; margin-right: 10px; font-size: 12px; }}
  @media print {{
    body {{ background: #fff; padding: 0; font-size: 11.5px; }}
    .sheet {{ max-width: none; box-shadow: none; border-radius: 0; padding: 0; }}
    .no-print {{ display: none !important; }}
    h2 {{ break-after: avoid; }}
    table {{ break-inside: auto; }}
    tr {{ break-inside: avoid; }}
    @page {{ size: A4; margin: 12mm; }}
  }}
</style>
</head>
<body>
<div class="sheet">
  <div class="report-head">
    <div>
      <h1>血压监测报告</h1>
      <div class="meta">统计区间：{_esc(start)} 至 {_esc(end)}（近 {days} 天）　生成时间：{generated}</div>
      <div class="meta">数据来源：血压管家（家庭自测）　记录条数：{stats['count']} 条</div>
    </div>
    <div class="range-links no-print">
      <a href="?days=7{_esc(('&patient_id=' + str(patient_id)) if patient_id else '')}&_v={cache_bust}">近 7 天</a><a href="?days=30{_esc(('&patient_id=' + str(patient_id)) if patient_id else '')}&_v={cache_bust}">近 30 天</a><a href="?days=90{_esc(('&patient_id=' + str(patient_id)) if patient_id else '')}&_v={cache_bust}">近 90 天</a>
    </div>
  </div>

  <div class="actions no-print">
    <button onclick="bpPrint()">打印 / 另存为 PDF</button>
    <a class="ghost" href="javascript:bpClose()">关闭</a>
  </div>
  <script>
    function bpPrint() {{
      if (window.BPPrint && typeof window.BPPrint.print === 'function') {{
        window.BPPrint.print();
      }} else {{
        window.print();
      }}
    }}
    function bpClose() {{
      if (window.BPPrint && history.length > 1) {{
        history.back();
      }} else {{
        window.close();
      }}
    }}
  </script>

  <div class="cards">
    <div class="card"><div class="label">收缩压平均</div><div class="value">{stats['avg_sys'] if stats['avg_sys'] is not None else '—'}<span class="unit"> mmHg</span></div></div>
    <div class="card"><div class="label">舒张压平均</div><div class="value">{stats['avg_dia'] if stats['avg_dia'] is not None else '—'}<span class="unit"> mmHg</span></div></div>
    <div class="card"><div class="label">收缩压最高 / 最低</div><div class="value">{stats['max_sys'] if stats['max_sys'] is not None else '—'}<span class="unit"> / {stats['min_sys'] if stats['min_sys'] is not None else '—'} mmHg</span></div></div>
    <div class="card"><div class="label">舒张压最高 / 最低</div><div class="value">{stats['max_dia'] if stats['max_dia'] is not None else '—'}<span class="unit"> / {stats['min_dia'] if stats['min_dia'] is not None else '—'} mmHg</span></div></div>
    <div class="card"><div class="label">超标次数（≥ {_esc(settings.get('target_sys'))} / {_esc(settings.get('target_dia'))}）</div><div class="value">{stats['high_count']}<span class="unit"> 次</span></div></div>
    <div class="card"><div class="label">服药任务 / 依从率</div><div class="value">{taken}/{total_med}<span class="unit"> 次 · {adherence}</span></div></div>
  </div>

  <h2>趋势（每日平均）</h2>
  {_svg_trend(stats['series'])}
  <div class="legend"><span><span class="dot" style="background:#0e9f8a"></span>收缩压</span><span><span class="dot" style="background:#d97706"></span>舒张压</span></div>

  <h2>分时段统计</h2>
  <table>
    <thead><tr><th>时段</th><th>次数</th><th>收缩压平均</th><th>舒张压平均</th></tr></thead>
    <tbody>{''.join(slot_rows)}</tbody>
  </table>

  <h2>血压明细（{stats['count']} 条）</h2>
  <table>
    <thead><tr><th>日期</th><th>时间</th><th>收缩压</th><th>舒张压</th><th>脉率</th><th>时段</th><th>左右手</th><th>备注</th></tr></thead>
    <tbody>{''.join(rows)}</tbody>
  </table>

  <h2>服药记录（{total_med} 项，已服 {taken}，跳过 {skipped}，依从率 {adherence}）</h2>
  <table>
    <thead><tr><th>日期</th><th>药品</th><th>剂量</th><th>计划时间</th><th>状态</th><th>实际时间</th></tr></thead>
    <tbody>{''.join(med_rows)}</tbody>
  </table>

  <div class="footer">
    说明：本报告由「血压管家」自动生成，仅供就诊参考，不构成诊断或用药建议。家庭自测血压的高血压判定标准通常为 ≥135/85 mmHg（诊室 ≥140/90 mmHg）。<br>
    记录区间：{_esc(start)} 至 {_esc(end)}；统计口径：每日平均、分时段平均均按该区间内的记录计算。
  </div>
</div>
</body>
</html>"""
