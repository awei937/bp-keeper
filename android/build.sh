#!/usr/bin/env bash
# 手动构建 Android WebView 壳（不依赖 Gradle）
# 依赖：Android SDK build-tools 35.0.0 + platforms/android-35 + JDK 17+
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/opt/android-sdk}}"
BT="${ANDROID_BUILD_TOOLS:-$SDK/build-tools/35.0.0}"
PLATFORM="${ANDROID_PLATFORM:-$SDK/platforms/android-35/android.jar}"

KS="${BP_KEYSTORE:-$ROOT/bp-keeper.jks}"
KS_PASS="${BP_KEYSTORE_PASS:?请设置 BP_KEYSTORE_PASS 环境变量（自行生成的 keystore 密码）}"
KEY_ALIAS="${BP_KEY_ALIAS:-bpkeeper}"
OUT_APK="${BP_OUT_APK:-$ROOT/bp-keeper.apk}"
BUILD="$ROOT/build"

for f in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$PLATFORM"; do
  if [ ! -e "$f" ]; then
    echo "缺少构建依赖: $f" >&2
    echo "请安装 Android build-tools 35、platform 35，并设置 ANDROID_SDK_ROOT" >&2
    exit 1
  fi
done

cd "$ROOT"
rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex"

echo "==> [1/8] aapt2 compile resources"
"$BT/aapt2" compile --dir res -o "$BUILD/res.zip"

echo "==> [2/8] aapt2 link"
"$BT/aapt2" link \
  -o "$BUILD/base.apk" \
  -I "$PLATFORM" \
  --manifest AndroidManifest.xml \
  --java "$BUILD/gen" \
  --min-sdk-version 26 \
  --target-sdk-version 34 \
  "$BUILD/res.zip"

echo "==> [3/8] javac"
find src "$BUILD/gen" -name '*.java' > "$BUILD/sources.txt"
javac -encoding UTF-8 -source 8 -target 8 -Xlint:-options \
  -classpath "$PLATFORM" -d "$BUILD/classes" @"$BUILD/sources.txt"

echo "==> [4/8] d8"
find "$BUILD/classes" -name '*.class' > "$BUILD/classlist.txt"
"$BT/d8" --release --min-api 26 --lib "$PLATFORM" --output "$BUILD/dex" $(cat "$BUILD/classlist.txt")

echo "==> [5/8] package classes.dex"
cp "$BUILD/base.apk" "$BUILD/unsigned.apk"
python3 - "$BUILD/unsigned.apk" "$BUILD/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY

echo "==> [6/8] zipalign"
"$BT/zipalign" -f -p 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

echo "==> [7/8] keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -storetype PKCS12 -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=BP Keeper, OU=Mobile, O=Example, C=CN"
else
  echo "使用已有 keystore: $KS（请勿提交到 Git）"
fi

echo "==> [8/8] apksigner"
"$BT/apksigner" sign \
  --ks "$KS" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$OUT_APK" "$BUILD/aligned.apk"

echo "构建完成: $OUT_APK"
"$BT/apksigner" verify --verbose "$OUT_APK"
