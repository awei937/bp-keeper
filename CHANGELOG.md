# Changelog

## 2026-10-30

### Added
- 四时段血压 / 心率记录、趋势统计
- 拍照 / 长截图 OCR
- 吃药管理、打卡与依从率
- 页面 / ntfy / PushPlus / 邮件 / Webhook 提醒
- Excel / CSV / JSON 备份 / 打印报告 / `.ics` 日历
- 多用户角色（管理员 / 普通用户 / 医生）
- PWA 与 Android WebView App
- 原生通知、日历同步、原生打印
- 米家 BLE 广播自动同步（MiBeacon + AES-CCM，需自己的 bindkey）

### Security
- PBKDF2 密码哈希、HMAC 会话 Cookie
- 登录验证码、账号锁定、IP 限流、同源校验
- 医生只读、备份 / 恢复仅管理员
- BLE bindkey 仅本人可读

### Notes
- 开源版本已脱敏：不含真实服务器、账号、设备密钥或个人数据。
