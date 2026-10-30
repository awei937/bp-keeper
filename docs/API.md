# API 参考（摘要）

所有路径均相对同源根路径 `/`；除登录 / 验证码 / 健康检查外均需登录 Cookie。
详细字段以 `backend/app/schemas.py` 与路由源码为准。

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/auth/status` | 当前登录状态与 user |
| GET | `/api/auth/captcha` | 图像验证码（登录必需） |
| POST | `/api/auth/setup` | 首次初始化管理员 |
| POST | `/api/auth/login` | 用户名 + 密码 + 验证码 |
| POST | `/api/auth/logout` | 退出 |
| PATCH | `/api/auth/profile` | 修改自己的显示名称 |
| POST | `/api/auth/password` | 修改自己的密码 |

## 测量

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/measurements?from=&to=&limit=&offset=` | 列表 |
| POST | `/api/measurements` | 新建（source: manual / ocr / ble） |
| GET | `/api/measurements/{id}` | 详情 |
| PUT | `/api/measurements/{id}` | 局部更新 |
| DELETE | `/api/measurements/{id}` | 删除 |

`Measurement` 主要字段：`measured_at`、`systolic`、`diastolic`、`pulse`、`arm`（left / right）、`position`（sitting / lying / standing）、`slot`、`source`。新建时省略 `arm` / `position` 默认 `left` / `sitting`。

## 药品 / 打卡

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/medications` | 药品列表 / 新建 |
| PUT/DELETE | `/api/medications/{id}` | 编辑 / 删除 |
| GET | `/api/medlogs?date=` | 当天服药任务 |
| POST | `/api/medlogs/{id}/take` | 标记已服 |
| POST | `/api/medlogs/{id}/skip` | 跳过 |
| POST | `/api/medlogs/{id}/undo` | 撤销 |

## 设置 / 提醒 / 导出

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/PUT | `/api/settings` | 用户设置 |
| POST | `/api/settings/test-channel` | 测试通知通道 |
| GET | `/api/reminders` | 当前待办提醒 |
| GET | `/api/export/xlsx` | Excel |
| GET | `/api/export/csv` | CSV |
| GET | `/api/export/report?days=30` | 可打印 HTML 报告 |
| GET | `/api/export/calendar.ics` | 日历提醒 |
| GET | `/api/export/backup` | JSON 备份（管理员） |
| POST | `/api/import/backup` | 从 JSON 恢复（管理员） |

## BLE 配置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ble/config` | 当前用户 BLE 配置（含 bindkey，仅本人） |
| PUT | `/api/ble/config` | 保存 MAC / bindkey / enabled |

医生角色不可写；bindkey 不会出现在公开 settings 接口中。
