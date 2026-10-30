# 蓝牙广播自动同步（v1.4）

> 目标设备：米家智能电子血压计 **`ihealth.bpm.bpx1`**（固件实测 2.0.1_0005）
> 状态：已在真实设备上完成验证（个人自用）

## 1. 为什么不用 GATT 连接

诊断发现该设备虽然能被手机扫描/连接，但其 GATT 只有：

- 标准 GAP / Device Name
- 小米 FE95 / MIoT 蓝牙服务（认证与传输）
- 小米私有 `mi.miot.lbe` 服务（Write/Notify）

**没有标准蓝牙血压服务 0x1810 / 0x2A35**；官方数据通道需要米家认证后的会话语钥，第三方无法直接读取。

真正的数据在**测量完成后 1–2 秒内以 MiBeacon 广播（FE95）突发发出**，用每台设备唯一的 **bindkey** 做 AES-CCM 加密。因此正确方案是：**被动监听广播 + 本地解密**，不连 GATT、不配对、不干扰米家。

## 2. 数据流

```
血压计测量完成
  └─ FE95 MiBeacon 加密广播（productId 8120，突发 6~30 帧）
        │
        ▼
手机 APK v1.4  前台服务 BpBleSyncService
  ├─ BluetoothLeScanner 无过滤扫描
  ├─ 取 FE95 service data
  ├─ AES-CCM(tag=4, nonce=rev(MAC)+productId+counter+random3, AAD=0x11)
  ├─ 解析 TLV（object len=9）：时间 / 收缩压 / 舒张压 / 脉率 / flags
  ├─ 去重（测量时间+数值）
  └─ 写入本地待导入队列（SharedPreferences，最多 50 条）
        │
        ▼
打开 App（登录态）→ 前端从 /api/ble/config 取 MAC+bindkey → 原生 configure
  ├─ 主动开启：PUT enabled=true → start() 前台服务
  ├─ 启动时：GET config → 已启用则静默 start()
  └─ 导入待处理记录 → POST /api/measurements（source=ble）
        └─ 成功后 clearPending(ids)
```

## 3. 协议要点

### 3.1 广播帧（小端）

| 偏移 | 字段 | 说明 |
|---|---|---|
| 0–1 | frameControl | bit3=加密，bit4=含 MAC，bit5=capability，bit6=含对象 |
| 2–3 | productId | 8120（帧内 `B8 1F`） |
| 4 | counter | 事件计数器 |
| 5… | 可选字段 | MAC(6B，反序) / capability(1B，可能 +1B) / payload |
| 末尾 | random3 + tag4 | 仅在加密时存在 |

### 3.2 解密

- 算法：**AES-CCM，tag 4 字节**
- 密钥：**bindkey**（16 字节 / 32 hex，每台设备唯一）
- nonce(12B)：`reverse(MAC 6B) + serviceData[2:5] + random3`
- AAD：`0x11`
- 密文：payload 起点到“帧尾 - 7”
- 校验 tag 失败直接丢弃，不返回明文

### 3.3 测量对象

解密后 TLV：`u16 objectId, u8 len, value`，取 `len == 9`：

| 字段 | 类型 | 说明 |
|---|---|---|
| 时间 | u32 LE | 自 2000-01-01 00:00:00 UTC+8 起秒数 |
| 收缩压 | u16 LE | mmHg |
| 舒张压 | u8 | mmHg |
| 脉率 | u8 | bpm |
| flags | u8 | bit0 心律不齐；bit1 体动 |

过滤：40≤sys≤260、20≤dia≤200、20≤pulse≤250、sys>dia。

## 4. bindkey 获取与安全

- 来源：**使用者自己的小米云账号**，接口 `POST /v2/device/blt_get_beaconkey`，参数 `{"did": "<设备DID>", "pdid": 1}`；返回 32 位 hex `beaconkey`。
- 一次性操作：服务器用 `mijiaAPI` 生成米家扫码登录二维码，用户用米家 App 扫码授权；随后自动读取设备 DID 与 bindkey。
- 保存位置：
  - 服务器数据库 `ble_config` 表（仅登录本人可通过 `/api/ble/config` 读取）
  - APK 本地 SharedPreferences（App 私有目录）
- **不会**出现在页面 DOM、普通设置接口 `/api/settings`、日志或截图中。
- 米家登录态保存在 `本地私有目录中的 auth.json（不要提交到仓库）`；可随时删除，不影响已保存的 bindkey。
- 若设备在米家重置/重新绑定，bindkey 可能变化，需要重新获取并更新配置。

## 5. 使用步骤（用户）

1. 安装 **APK v1.4**（versionCode 5，覆盖安装保数据）。
2. App → 设置 → **蓝牙自动同步** → 打开开关。
3. 允许「附近设备 / 蓝牙」+ 通知权限；华为系统建议允许「后台运行 / 自启动」。
4. 手机蓝牙保持开启；无需在系统蓝牙里配对血压计。
5. 血压计正常测量一次；通知栏会出现「已捕获血压 xxx/yyy · 打开 App 自动导入」。
6. 打开 App 后自动导入，记录来源显示「蓝牙自动同步」。

## 6. 真机验证结果

- 已在真实设备上完成广播捕获、AES-CCM 解密与导入验证。
- 数据来源：`source=ble`；记录备注「蓝牙自动同步」。
- 验证结果：测量后可在手机端捕获并导入，记录来源标记为 BLE 自动同步。
- 配置：MAC 使用占位符 `AA:BB:CC:DD:EE:FF`；bindkey 为 32 位 hex，只保存在本地。
- Android App：源码位于 `android/`，版本以仓库为准。
- 协议单测：AES-CCM 向量、MiBeacon 变体（MAC/capability/无 MAC/flags）、错误 productId/bindkey/篡改/越界拒绝全部 PASS。

## 7. 排障

| 现象 | 检查 |
|---|---|
| 设置卡片不存在 | 是否 APK v1.4？是否医生/只读账号？浏览器没有原生桥，卡片按设计隐藏 |
| 开启失败 | 是否允许附近设备/通知权限；系统蓝牙是否开启；服务器 `/api/ble/config` 是否正常 |
| 常驻通知消失 | 华为 ROM 清理了后台；允许「后台运行 / 自启动」，锁定后台任务 |
| 测量后无捕获 | 测量时手机蓝牙开启、App 服务在跑；可先退出米家 App；测量帧只发 1–2 秒，不补发 |
| 有通知但打开 App 没记录 | 前端导入失败：检查网络/登录态；pending 会保留，下次再试 |
| 仍无捕获 | 需要「原始 FE95 service data」调试帧，下一版加原始帧缓存后按实际帧微调 |

## 8. 已知限制

- 只捕获**新的测量**，不会从设备/米家同步历史记录。
- App 进程被杀后服务不会自动恢复（`START_NOT_STICKY`）；再次打开 App 会自动重新 `start()`。
- 华为等 ROM 可能限制后台前台服务，需要用户允许自启动/后台运行。
- 长时间无过滤扫描会增加耗电；只在用户开启自动同步时运行。
- 设备绑定关系/固件变化可能导致 bindkey 或广播布局变化，需要重新获取/适配。
- 该功能依赖小米云 bindkey 与 MiBeacon 逆向协议，属于非官方互操作方案。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
