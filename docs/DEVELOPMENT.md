# 开发与测试

## 本地后端

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
pip install rapidocr-onnxruntime==1.4.4

export BP_DATA_DIR="$PWD/data"
export BP_FRONTEND_DIR="$PWD/frontend"
mkdir -p "$BP_DATA_DIR"
uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --reload
```

前端是静态文件，直接由 FastAPI 托管；开发时刷新页面即可。

## 目录职责

- `backend/app/routers`：API 路由（认证、数据、设置、导出、OCR、BLE）
- `backend/app/services`：提醒、统计、导出、备份恢复
- `backend/app/db.py`：SQLite schema / 迁移 / 查询
- `frontend/js`：SPA；`views.js` 页面、`app.js` 交互、`core.js` 工具与 API
- `ocr/recognizer.py`：OCR 识别
- `android/src`：WebView 壳与原生桥

## 测试

```bash
# 容器内冒烟测试
docker compose run --rm bp-app python /app/backend/tests/smoke_test.py
```

如果没有 Docker，可在本地环境设置 `BP_DATA_DIR`、`BP_FRONTEND_DIR` 后运行同一脚本（需安装测试依赖）。

## OCR 开发

```bash
python ocr/recognizer.py --help   # 如提供 CLI
```

不要提交真实血压计照片 / App 截图；使用合成或脱敏图片做回归测试。

## Android 构建

```bash
cd android
export ANDROID_SDK_ROOT=/path/to/android-sdk
export BP_KEYSTORE_PASS='change-me'
export BP_KEY_ALIAS=bpkeeper
bash build.sh
```

依赖：Android build-tools 35、platform 35、JDK 17+。
修改 `src/com/example/bpkeeper/MainActivity.java` 中的 `TARGET_URL` / `APP_HOST` 为你的地址。

## 代码风格

- Python 保持标准库 + FastAPI 风格，类型标注优先；
- 前端保持原生 JS，不引入构建链；
- 敏感配置通过数据库设置或环境变量，不写入源码；
- 提交前扫描：`git diff --cached | grep -iE 'token|password|secret|bindkey|DNS provider'`。
