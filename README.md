# 血压管家 · BP Keeper

> 一个自托管的家庭血压 / 用药记录应用：四个时段记录、拍照识别、吃药打卡、提醒、趋势与报告、多用户角色，以及 Android WebView App。
>
> **不是医疗器械，不提供诊断或治疗建议。** 本项目为个人自用工具整理后的脱敏开源版本；仓库不包含任何真实健康数据、服务器凭据、设备 MAC / bindkey 或个人账号信息。

## 功能

- **血压 / 心率记录**：收缩压、舒张压、脉率、左右手、体位、备注；四个时段（早上 / 上午 / 下午 / 睡前）；新记录默认「坐姿、左臂」
- **拍照识别**：拍摄血压计屏幕或上传 App 历史截图（长截图 / WebP），RapidOCR + 七段码辅助定位，结果先确认再入库
- **吃药管理**：药品、剂量（支持 0.5 片等小数与毫克 / 克单位）、每日服药时间、打卡 / 跳过 / 撤销、依从率
- **提醒**：页面横幅 + 浏览器通知；服务端支持 ntfy / PushPlus / 邮件 / Webhook；`.ics` 日历导出
- **导出 / 报告**：Excel、CSV、JSON 备份 / 恢复、打印 / PDF 报告
- **多用户角色**：管理员 / 普通用户 / 医生；数据 owner 隔离；医生只读；登录验证码、失败锁定、同源校验
- **PWA**：添加到主屏幕；HTTPS 下 service worker 缓存
- **Android WebView App**：原生通知、系统日历同步、原生打印、文件上传下载；可选 BLE 广播自动同步
- **BLE 自动同步（可选）**：被动监听米家 BLE 血压计的 MiBeacon 广播，在手机本地用 bindkey 做 AES-CCM 解密并导入；不连接 GATT、不配对。仅用于自己拥有并绑定的设备，详见 [docs/BLE_SYNC.md](docs/BLE_SYNC.md)

## 技术栈

- **后端**：Python 3.12、FastAPI、SQLite（WAL）、openpyxl
- **前端**：原生 HTML / CSS / JavaScript 单页应用，本地 Chart.js，无外部 CDN
- **OCR**：RapidOCR / ONNX Runtime + OpenCV
- **部署**：Docker Compose；可选 nginx + HTTPS
- **移动端**：Android WebView 壳（源码在 `android/`，不使用 Gradle，`aapt2 + javac + d8 + apksigner` 手动构建）

```text
浏览器 / PWA ─┐
Android APK ──┼── HTTPS / nginx（可选） ── FastAPI + SQLite ── /data
              │
              └── OCR / 导出 / 备份
```

## 目录结构

```text
.
├── backend/                 # FastAPI 应用与测试
│   ├── app/
│   └── tests/
├── frontend/                # 原生 SPA
├── ocr/                     # OCR 模块
├── android/                 # Android WebView 壳源码与构建脚本
├── deploy/                  # 部署示例脚本 / nginx 示例
├── docs/                    # 架构、OCR、API、BLE、部署说明
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## 快速开始（Docker）

要求：Docker + Docker Compose。

```bash
# 1. 准备数据目录
mkdir -p data

# 2. 可选：复制环境变量示例
cp .env.example .env

# 3. 构建并启动
docker compose up -d --build

# 4. 浏览器打开
# http://127.0.0.1:8288/
```

首次打开会要求设置访问密码（第一个账号为管理员）。数据写入 `./data`，备份时打包这个目录即可。

> **OCR 模型**：镜像会通过 `requirements.txt` 安装 ONNX Runtime；RapidOCR 模型在首次使用时由库自行下载 / 加载。离线部署可预先准备模型目录并参考 [docs/OCR.md](docs/OCR.md)。

## 本地开发

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

打开 `http://127.0.0.1:8000/`。更多开发说明见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `BP_DATA_DIR` | `/data` | SQLite 与上传图片目录 |
| `BP_DB_PATH` | `$BP_DATA_DIR/bp.db` | 可单独指定数据库文件 |
| `BP_FRONTEND_DIR` | `/app/frontend` | 前端静态目录 |
| `BP_TZ` | `Asia/Shanghai` | 默认时区 |

通知通道、BLE 配置等都在应用设置页内保存到数据库；仓库不包含任何真实凭据。

## Android App

见 [android/README.md](android/README.md)。

- 需要 Android SDK（build-tools 35、platform 35）和 JDK；
- 修改 `android/src/com/example/bpkeeper/MainActivity.java` 中的 `TARGET_URL` / `APP_HOST` 为你的部署地址；
- 自行生成 keystore（不要提交到仓库）；
- 构建产物默认在 `android/bp-keeper.apk`。

## 数据与隐私

- 所有数据保存在自己的服务器 / 自己的数据库中；没有第三方健康云依赖。
- 密码使用 PBKDF2-HMAC-SHA256 加盐存储；会话为 HMAC 签名 HttpOnly Cookie。
- 登录有图像验证码、账号失败锁定与同源校验。
- 医生账号只读；备份 / 恢复仅管理员。
- BLE bindkey 仅下发到已登录本人，不写入页面 DOM 或日志；不要把自己的 bindkey 提交到仓库或公开分享。

## 测试

```bash
# 后端冒烟测试（容器内）
docker compose run --rm bp-app python /app/backend/tests/smoke_test.py
```

OCR / 角色 / 导出等回归测试可在 `backend/tests` 与 `ocr/` 中按需运行；详见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 安全

发现安全问题请阅读 [SECURITY.md](SECURITY.md)，不要公开包含真实健康数据或凭据的 Issue。

## 已知限制

- 这是家庭自用工具，不是医疗器械；异常读数请咨询医生。
- OCR 对极端反光、模糊、非标准排版可能失败，失败时请手动输入。
- WebView 的系统通知 / 打印 / BLE 行为受 Android 版本与厂商 ROM 限制。
- BLE 广播协议来自互操作性研究，固件更新可能导致帧格式或 bindkey 变化。
- 日历同步依赖系统存在可写日历。

## License

[MIT](LICENSE)

## 致谢

- [FastAPI](https://fastapi.tiangolo.com/)
- [RapidOCR](https://github.com/RapidAI/RapidOCR)
- [Chart.js](https://www.chartjs.org/)
- 以及公开的 MiBeacon / BLE 互操作性研究资料

> 如果这个项目对你有帮助，欢迎 Star；请勿将个人健康数据、设备密钥或服务器凭据提交到公开仓库。
