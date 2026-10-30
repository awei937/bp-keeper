"""后端冒烟测试：在容器内运行 python /app/backend/tests/smoke_test.py。"""
import json
import os
import sys
import tempfile
from datetime import datetime
from zoneinfo import ZoneInfo

DATA_DIR = tempfile.mkdtemp(prefix="bp-smoke-")
os.environ["BP_DATA_DIR"] = DATA_DIR
os.environ["BP_FRONTEND_DIR"] = "/tmp/bp-no-frontend"
os.environ["BP_DB_PATH"] = os.path.join(DATA_DIR, "bp.db")
sys.path.insert(0, "/app")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

TZ = ZoneInfo("Asia/Shanghai")
TODAY = datetime.now(TZ).date().isoformat()


def main() -> None:
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/auth/status").json() == {"initialized": False, "authenticated": False}
        assert client.get("/api/measurements").status_code == 401

        response = client.post("/api/auth/setup", json={"password": "test123456"})
        assert response.status_code == 200, response.text
        assert client.get("/api/auth/status").json()["authenticated"] is True

        # 记录
        response = client.post(
            "/api/measurements",
            json={
                "measured_at": f"{TODAY}T06:45:00+08:00",
                "systolic": 138,
                "diastolic": 98,
                "pulse": 76,
                "arm": "left",
                "position": "sitting",
                "note": "冒烟测试",
            },
        )
        assert response.status_code == 200, response.text
        measurement = response.json()
        assert measurement["slot"] == "morning", measurement
        measurement_id = measurement["id"]

        response = client.post(
            "/api/measurements",
            json={"measured_at": f"{TODAY}T17:10:00+08:00", "systolic": 145, "diastolic": 88, "pulse": 80},
        )
        assert response.status_code == 200
        assert response.json()["slot"] == "afternoon"

        response = client.put(f"/api/measurements/{measurement_id}", json={"note": "修改后"})
        assert response.status_code == 200 and response.json()["note"] == "修改后"

        listed = client.get("/api/measurements").json()
        assert listed["total"] == 2, listed

        # 药品与服药
        response = client.post(
            "/api/medications",
            json={"name": "氨氯地平", "dose": 1, "unit": "片", "times": ["08:00", "20:00"]},
        )
        assert response.status_code == 200, response.text
        medication_id = response.json()["id"]

        logs = client.get(f"/api/medlogs?date={TODAY}").json()["items"]
        assert len(logs) == 2, logs
        log_id = logs[0]["id"]
        taken = client.post(f"/api/medlogs/{log_id}/take", json={"note": "饭后"}).json()
        assert taken["status"] == "taken", taken
        undone = client.post(f"/api/medlogs/{log_id}/undo").json()
        assert undone["status"] == "pending", undone

        # 首页与统计
        dashboard = client.get("/api/dashboard").json()
        assert dashboard["date"] == TODAY
        assert len(dashboard["slots"]) == 4
        assert dashboard["stats7"]["count"] == 2
        assert dashboard["meds"], dashboard
        stats = client.get("/api/stats?days=7").json()
        assert stats["count"] == 2 and stats["classification"]["high"] == 2, stats

        # 提醒（服务端计算不应报错）
        reminders = client.get("/api/reminders").json()
        assert "items" in reminders

        # 设置
        settings = client.get("/api/settings").json()
        assert settings["slot_times"]["morning"] == "06:30"
        response = client.put("/api/settings", json={"target_sys": 130, "reminder_enabled": False})
        assert response.status_code == 200 and response.json()["target_sys"] == 130

        # 导出
        xlsx = client.get("/api/export/xlsx")
        assert xlsx.status_code == 200 and len(xlsx.content) > 2000, xlsx.status_code
        csv_bp = client.get("/api/export/csv?type=bp")
        assert csv_bp.status_code == 200 and "收缩压" in csv_bp.content.decode("utf-8-sig")
        backup = client.get("/api/export/backup")
        data = json.loads(backup.content.decode("utf-8"))
        assert data["measurements"] and data["medications"] and data["med_logs"]

        # OCR 接口
        ocr_health = client.get("/api/ocr/health").json()
        assert "available" in ocr_health
        response = client.post(
            "/api/ocr",
            files={"file": ("test.png", b"\x89PNG\r\n\x1a\n" + b"0" * 100, "image/png")},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert "candidates" in body

        # 修改密码后需重新登录
        response = client.post(
            "/api/auth/password", json={"old_password": "test123456", "new_password": "newpass123"}
        )
        assert response.status_code == 200, response.text
        client.post("/api/auth/logout")
        assert client.get("/api/measurements").status_code == 401
        assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
        assert client.post("/api/auth/login", json={"password": "newpass123"}).status_code == 200
        assert client.get("/api/measurements").status_code == 200

        # 删除
        assert client.delete(f"/api/medications/{medication_id}").status_code == 200
        assert client.delete(f"/api/measurements/{measurement_id}").status_code == 200

    print("SMOKE OK")


if __name__ == "__main__":
    main()
