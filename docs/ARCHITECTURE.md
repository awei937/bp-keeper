# 架构说明

## 组件

```text
┌───────────────┐        ┌─────────────────────┐        ┌───────────────┐
│ Browser / PWA │        │ Android WebView App │        │  BLE 血压计    │
└───────┬───────┘        └──────────┬──────────┘        └───────┬───────┘
        │ HTTPS                     │ HTTPS + 原生桥              │ MiBeacon 广播
        └──────────────┬────────────┴────────────────────────────┘
                       ▼
              ┌─────────────────┐
              │  nginx / proxy  │  可选：TLS、反向代理
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │ FastAPI + SQLite│  /data/bp.db + uploads
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │ OCR / 导出 / 备份│  RapidOCR + ONNX + OpenCV
              └─────────────────┘
```

## 数据模型

- `users`：账号、角色、密码哈希、锁定状态
- `measurements`：测量记录（owner / 时间 / 收缩压 / 舒张压 / 脉率 / 体位 / 来源）
- `medications` / `med_logs`：药品、剂量、每日时间、打卡
- `user_settings`：每用户独立的时段、阈值、通知通道
- `ble_config`：每用户 BLE 设备配置（MAC / bindkey / enabled）
- `uploads`：OCR 原图（保留期限可清理）

所有业务表都有 `owner_id`（或用户账号关联）；查询与写入都按当前登录用户隔离。医生只能读取被绑定患者的数据。

## 请求与权限

1. 登录：验证码 + 密码校验，成功后写入 HMAC 签名 HttpOnly Cookie。
2. 每个 API 请求从 Cookie 解析用户；写操作校验角色与 owner。
3. 医生只读；管理员可管理用户与医生-患者绑定。
4. 写操作做同源 Origin 校验，降低 CSRF 风险。

## OCR 流程

1. 上传图片；
2. OCR 引擎检测文字 / 七段码；
3. 返回候选值（不会直接写库）；
4. 前端让用户确认 / 修改；
5. 用户保存后才写入 measurement。

## BLE 自动同步（可选）

```text
血压计测量完成
  └─ FE95 / MiBeacon 加密广播（1–2 秒）
        │
        ▼
Android 前台服务：扫描 → 解析帧 → AES-CCM 解密 → TLV
        │
        ▼
本地待导入队列（SharedPreferences）
        │
        ▼
打开 App → 登录态 → POST /api/measurements（source=ble）
```

BLE 只在手机本地解密；服务器不主动连接设备。详情见 [BLE_SYNC.md](BLE_SYNC.md)。

## 设计取舍

- **SQLite**：单家庭实例，备份 = 复制目录；WAL 支持并发读。
- **原生 JS**：页面不多，零构建、部署简单；避免前端框架升级成本。
- **WebView + 原生桥**：业务页面一份 Web 代码；通知、日历、打印、BLE 由原生补齐。
- **Docker + 反向代理**：应用只监听内部端口，TLS 与下载由 nginx 负责。
