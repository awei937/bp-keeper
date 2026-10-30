package com.example.bpkeeper;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 蓝牙自动同步的本地存储：
 *   - 配置：目标血压计 MAC + 16 字节 bindkey（bindkey 只在本地保存，不写日志、不上传）
 *   - 待导入队列：最多 50 条测量，格式
 *     {id, measured_at:"YYYY-MM-DDTHH:MM:SS", systolic, diastolic, pulse, irregular, movement}
 *
 * 服务端（BpBleSyncService）写入，前端通过 JS 桥读取并导入，然后 clearPending 清除。
 */
public final class BleSyncStore {

    private static final String TAG = "BPBleSyncStore";

    private static final String PREFS_NAME = "bp_ble_sync";
    private static final String KEY_MAC = "mac";
    private static final String KEY_BINDKEY = "bindkey";
    private static final String KEY_PENDING = "pending";

    private static final int MAX_PENDING = 50;
    private static final Object LOCK = new Object();

    private static final Pattern MAC_PATTERN =
            Pattern.compile("^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$");
    private static final Pattern BINDKEY_PATTERN =
            Pattern.compile("^[0-9A-Fa-f]{32}$");
    private static final String ALL_ZERO_KEY = "00000000000000000000000000000000";

    private BleSyncStore() {
    }

    /** 已配置的血压计信息 */
    public static class Config {
        public final String mac;
        public final byte[] bindkey;

        Config(String mac, byte[] bindkey) {
            this.mac = mac;
            this.bindkey = bindkey;
        }
    }

    /* ------------------------------------------------------------------ */
    /* 配置                                                                */
    /* ------------------------------------------------------------------ */

    /** 保存 MAC + bindkey；校验失败返回 false（不打印 bindkey） */
    public static boolean configure(Context context, String mac, String bindkeyHex) {
        if (context == null) {
            return false;
        }
        String normalizedMac = normalizeMac(mac);
        String normalizedKey = normalizeBindkey(bindkeyHex);
        if (normalizedMac == null || normalizedKey == null) {
            return false;
        }
        synchronized (LOCK) {
            prefs(context).edit()
                    .putString(KEY_MAC, normalizedMac)
                    .putString(KEY_BINDKEY, normalizedKey)
                    .apply();
        }
        Log.d(TAG, "configure ok, mac=" + normalizedMac);
        return true;
    }

    /** 读取有效配置；未配置或 bindkey 非法返回 null */
    public static Config loadConfig(Context context) {
        if (context == null) {
            return null;
        }
        synchronized (LOCK) {
            SharedPreferences preferences = prefs(context);
            String mac = normalizeMac(preferences.getString(KEY_MAC, null));
            String bindkey = normalizeBindkey(preferences.getString(KEY_BINDKEY, null));
            if (mac == null || bindkey == null) {
                return null;
            }
            byte[] keyBytes = hexToBytes(bindkey);
            if (keyBytes == null || keyBytes.length != 16) {
                return null;
            }
            return new Config(mac, keyBytes);
        }
    }

    public static boolean isConfigured(Context context) {
        return loadConfig(context) != null;
    }

    /* ------------------------------------------------------------------ */
    /* 待导入队列                                                          */
    /* ------------------------------------------------------------------ */

    /** 新增一条测量，返回是否真的新增（重复返回 false） */
    public static boolean addPending(Context context, MiBeaconParser.Measurement measurement) {
        if (context == null || measurement == null) {
            return false;
        }
        String id = buildId(measurement);
        synchronized (LOCK) {
            SharedPreferences preferences = prefs(context);
            JSONArray existing = readPendingArray(preferences);
            for (int i = 0; i < existing.length(); i++) {
                JSONObject item = existing.optJSONObject(i);
                if (item != null && id.equals(item.optString("id"))) {
                    return false;
                }
            }
            JSONObject json = toJson(measurement, id);
            if (json == null) {
                return false;
            }
            JSONArray next = new JSONArray();
            next.put(json);
            for (int i = 0; i < existing.length() && next.length() < MAX_PENDING; i++) {
                JSONObject item = existing.optJSONObject(i);
                if (item != null) {
                    next.put(item);
                }
            }
            preferences.edit().putString(KEY_PENDING, next.toString()).apply();
            return true;
        }
    }

    /** 最近待导入测量（JSON 数组字符串，最新在前） */
    public static String getPendingJson(Context context) {
        if (context == null) {
            return "[]";
        }
        synchronized (LOCK) {
            JSONArray array = readPendingArray(prefs(context));
            return array.toString();
        }
    }

    /** 按 id 清除已导入的测量 */
    public static void clearPending(Context context, List<String> ids) {
        if (context == null || ids == null || ids.isEmpty()) {
            return;
        }
        synchronized (LOCK) {
            SharedPreferences preferences = prefs(context);
            JSONArray existing = readPendingArray(preferences);
            JSONArray next = new JSONArray();
            for (int i = 0; i < existing.length(); i++) {
                JSONObject item = existing.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                if (ids.contains(item.optString("id"))) {
                    continue;
                }
                next.put(item);
            }
            preferences.edit().putString(KEY_PENDING, next.toString()).apply();
        }
    }

    /* ------------------------------------------------------------------ */
    /* 内部工具                                                            */
    /* ------------------------------------------------------------------ */

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static JSONArray readPendingArray(SharedPreferences preferences) {
        String raw = preferences.getString(KEY_PENDING, null);
        if (raw == null || raw.length() == 0) {
            return new JSONArray();
        }
        try {
            return new JSONArray(raw);
        } catch (Throwable t) {
            Log.w(TAG, "pending json corrupted, reset");
            return new JSONArray();
        }
    }

    private static JSONObject toJson(MiBeaconParser.Measurement measurement, String id) {
        try {
            JSONObject json = new JSONObject();
            json.put("id", id);
            json.put("measured_at", formatDate(measurement.measuredAtMillis));
            json.put("systolic", measurement.systolic);
            json.put("diastolic", measurement.diastolic);
            json.put("pulse", measurement.pulse);
            json.put("irregular", measurement.irregular);
            json.put("movement", measurement.movement);
            return json;
        } catch (Throwable t) {
            Log.w(TAG, "build pending json failed", t);
            return null;
        }
    }

    private static String buildId(MiBeaconParser.Measurement measurement) {
        return measurement.measuredAtMillis + "-" + measurement.systolic + "-"
                + measurement.diastolic + "-" + measurement.pulse;
    }

    private static String formatDate(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
        return format.format(new Date(millis));
    }

    private static String normalizeMac(String mac) {
        if (mac == null) {
            return null;
        }
        String trimmed = mac.trim().toUpperCase(Locale.US);
        return MAC_PATTERN.matcher(trimmed).matches() ? trimmed : null;
    }

    private static String normalizeBindkey(String bindkey) {
        if (bindkey == null) {
            return null;
        }
        String cleaned = bindkey.trim()
                .replace(" ", "")
                .replace(":", "")
                .replace("-", "");
        if (!BINDKEY_PATTERN.matcher(cleaned).matches()) {
            return null;
        }
        String lower = cleaned.toLowerCase(Locale.US);
        if (ALL_ZERO_KEY.equals(lower)) {
            return null;
        }
        return lower;
    }

    private static byte[] hexToBytes(String hex) {
        if (hex == null || (hex.length() & 1) != 0) {
            return null;
        }
        byte[] output = new byte[hex.length() / 2];
        try {
            for (int i = 0; i < output.length; i++) {
                output[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
            }
            return output;
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
