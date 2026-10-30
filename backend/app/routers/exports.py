"""导出接口（按 owner 隔离；备份/恢复仅管理员）。"""
from datetime import date, timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse, Response

from .. import db
from ..security import current_admin, current_user, owner_settings, resolve_owner
from ..services import exports as export_service
from ..timeutil import now_local, parse_date

router = APIRouter(prefix="/api/export", tags=["export"], dependencies=[Depends(current_user)])


def _range(settings: dict, from_: str | None, to: str | None):
    today = now_local(settings).date()
    start = parse_date(from_, settings) if from_ else today.replace(day=1)
    end = parse_date(to, settings) if to else today
    if end < start:
        start, end = end, start
    return start.isoformat(), end.isoformat()


@router.get("/xlsx")
def export_xlsx(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    patient_id: int | None = None,
    user: dict = Depends(current_user),
):
    owner, settings = owner_settings(user, patient_id)
    start, end = _range(settings, from_, to)
    measurements = export_service.fetch_measurements(start, end, owner)
    med_logs = export_service.fetch_med_logs(start, end, owner)
    content = export_service.build_xlsx(measurements, med_logs, settings, start, end)
    filename = f"血压记录_{start}_{end}.xlsx"
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@router.get("/csv")
def export_csv(
    type: str = "bp",
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    patient_id: int | None = None,
    user: dict = Depends(current_user),
):
    owner, settings = owner_settings(user, patient_id)
    start, end = _range(settings, from_, to)
    if type == "med":
        rows = export_service.fetch_med_logs(start, end, owner)
        content = export_service.build_csv(rows, "med")
        filename = f"服药记录_{start}_{end}.csv"
    else:
        rows = export_service.fetch_measurements(start, end, owner)
        content = export_service.build_csv(rows, "bp")
        filename = f"血压记录_{start}_{end}.csv"
    body = ("\ufeff" + content).encode("utf-8")
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@router.get("/calendar.ics")
def export_calendar(patient_id: int | None = None, user: dict = Depends(current_user)):
    """导出每日测血压/吃药提醒日历，可导入手机系统日历。"""
    owner, settings = owner_settings(user, patient_id)
    conn = db.connect()
    try:
        medications = [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM medications WHERE owner_id = ? AND active = 1 ORDER BY id", (owner,)
            ).fetchall()
        ]
    finally:
        conn.close()
    content = export_service.build_ics(settings, medications)
    filename = "血压管家提醒.ics"
    return Response(
        content=content,
        media_type="text/calendar; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


@router.get("/report")
def export_report(days: int = 30, patient_id: int | None = None, user: dict = Depends(current_user)):
    """生成可直接打印 / 另存为 PDF 的血压与服药汇总报告（HTML）。"""
    owner, settings = owner_settings(user, patient_id)
    days = max(1, min(365, int(days)))
    today = now_local(settings).date()
    start = (today - timedelta(days=days - 1)).isoformat()
    end = today.isoformat()
    measurements = export_service.fetch_measurements(start, end, owner)
    med_logs = export_service.fetch_med_logs(start, end, owner)
    content = export_service.build_report_html(measurements, med_logs, settings, start, end, days, patient_id=patient_id)
    return HTMLResponse(content=content, headers={"Cache-Control": "no-store"})


@router.get("/backup")
def export_backup(admin: dict = Depends(current_admin)):
    """完整备份仅管理员可用；包含管理员自己的数据与设置。"""
    owner = int(admin["id"])
    content = export_service.build_backup(owner)
    today = date.today().isoformat()
    filename = f"血压管家备份_{today}.json"
    return Response(
        content=content,
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )
