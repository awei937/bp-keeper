# Android WebView 壳

一个极简的 Android WebView 外壳，加载部署好的 Web 应用，并补齐浏览器做不到的能力：

- 原生系统通知（`BPNativeNotify`）
- 华为 / Android 系统日历同步（`BPCalendarSync`）
- 原生打印 / 另存 PDF（`BPPrint`）
- BLE 诊断（`BPBle`）与 BLE 广播自动同步（`BPBleSync`）
- 文件上传 / 下载、下拉刷新、错误重试

## 目录

```text
android/
├── AndroidManifest.xml
├── res/
├── src/com/example/bpkeeper/
├── test/CcmSelfTest.java
├── build.sh
└── README.md
```

## 构建

前置条件：

- Android SDK：build-tools 35.0.0、platform 35
- JDK 17+
- `python3`（用于把 classes.dex 打包进 APK）
- 自己生成一个 keystore（**不要提交到仓库**）

```bash
export ANDROID_SDK_ROOT=/path/to/android-sdk
export BP_KEYSTORE_PASS='change-me'
export BP_KEY_ALIAS=bpkeeper
bash build.sh
```

产物：`android/bp-keeper.apk`。

## 配置服务地址

编辑 `src/com/example/bpkeeper/MainActivity.java`：

```java
private static final String TARGET_URL = "https://example.com/";
private static final String APP_HOST = "example.com";
```

换成你自己的 HTTPS 部署地址。

## 签名 / 升级

- 自行生成 keystore；升级必须使用同一个 keystore，否则 Android 不允许覆盖安装。
- `bp-keeper.jks` 已被 `.gitignore` 排除，不要提交。
- 不要使用来源不明的签名文件。

## 自测

```bash
javac -d /tmp/bp-ccm-test \
  src/com/example/bpkeeper/Ccm.java \
  src/com/example/bpkeeper/MiBeaconParser.java \
  test/CcmSelfTest.java
java -cp /tmp/bp-ccm-test CcmSelfTest
```

覆盖 AES-CCM 测试向量、MiBeacon 合成帧解析、错误密钥 / 篡改 / 越界拒绝。

## 说明

- 系统通知、日历、打印、BLE 的具体行为受 Android 版本与厂商 ROM 限制；
- BLE 自动同步仅用于读取自己拥有并绑定的设备，不要用于未授权设备；
- `window.print()` 在 WebView 中不生效，报告页需调用 `BPPrint.print()`。
