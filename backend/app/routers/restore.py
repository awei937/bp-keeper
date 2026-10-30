"""备份恢复接口（仅管理员，恢复到管理员自己的数据）。"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..security import current_admin
from ..services.restore import restore_backup

router = APIRouter(prefix="/api/import", tags=["import"])


class RestoreIn(BaseModel):
    backup: dict


@router.post("/backup")
def import_backup(payload: RestoreIn, admin: dict = Depends(current_admin)):
    """用导出的 JSON 备份覆盖当前管理员自己的测量、药品、服药记录与设置。"""
    try:
        return restore_backup(int(admin["id"]), payload.backup)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"恢复失败：{exc}")
