package com.example.bpkeeper;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

/**
 * 蓝牙广播自动同步 JS 桥（JS 侧暴露为 window.BPBleSync）。
 *
 *   configure(mac, bindkey) -> boolean：校验并保存血压计 MAC + 32 hex bindkey（不打印 bindkey）
 *   start() -> "requesting"（缺权限已申请，结果事件 bp-ble-sync-permission）
 *              "started"（服务已在运行或已启动）
 *              "error:未配置" / "error:蓝牙未开启" / "error:..."
 *   stop() -> void
 *   isRunning() -> boolean
 *   getPending() -> JSON 数组字符串（最新在前，最多 50 条）
 *   clearPending(idsJson) -> void（ids 为 JSON 字符串数组）
 *
 * 权限 requestCode 1005：Android 13+ 含 POST_NOTIFICATIONS；Android 12+ BLUETOOTH_SCAN/CONNECT；
 * Android 11 及以下 ACCESS_FINE_LOCATION。
 * 前台服务通知渠道 bp_ble_sync；服务不直接发 HTTP，导入由前端完成。
 */
public class BleSyncBridge {

    private static final String TAG = "BPBleSyncBridge";

    /** 权限请求码（与 MainActivity 约定） */
    public static final int REQ_BLE_SYNC_PERMISSION = 1005;

    private final MainActivity activity;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private volatile boolean permissionDenied;

    public BleSyncBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public boolean configure(String mac, String bindkey) {
        try {
            return BleSyncStore.configure(activity, mac, bindkey);
        } catch (Throwable t) {
            Log.w(TAG, "configure failed", t);
            return false;
        }
    }

    @JavascriptInterface
    public String start() {
        try {
            if (!BleSyncStore.isConfigured(activity)) {
                return "error:未配置";
            }
            if (!hasPermissions()) {
                if (permissionDenied) {
                    return "error:未授予蓝牙/通知权限，请在系统设置中手动允许";
                }
                requestPermissions();
                return "requesting";
            }
            BluetoothAdapter adapter = getAdapter();
            if (adapter == null) {
                return "error:设备不支持蓝牙";
            }
            try {
                if (!adapter.isEnabled()) {
                    return "error:蓝牙未开启";
                }
            } catch (Throwable t) {
                return "error:缺少蓝牙权限";
            }
            if (BpBleSyncService.isRunning()) {
                return "started";
            }
            Intent intent = new Intent(activity, BpBleSyncService.class);
            intent.setAction(BpBleSyncService.ACTION_START);
            activity.startForegroundService(intent);
            return "started";
        } catch (Throwable t) {
            Log.w(TAG, "start ble sync failed", t);
            return "error:无法启动蓝牙同步服务";
        }
    }

    @JavascriptInterface
    public void stop() {
        try {
            Intent intent = new Intent(activity, BpBleSyncService.class);
            intent.setAction(BpBleSyncService.ACTION_STOP);
            activity.stopService(intent);
        } catch (Throwable t) {
            Log.w(TAG, "stop ble sync failed", t);
        }
    }

    @JavascriptInterface
    public boolean isRunning() {
        return BpBleSyncService.isRunning();
    }

    @JavascriptInterface
    public String getPending() {
        try {
            return BleSyncStore.getPendingJson(activity);
        } catch (Throwable t) {
            Log.w(TAG, "getPending failed", t);
            return "[]";
        }
    }

    @JavascriptInterface
    public void clearPending(String idsJson) {
        try {
            List<String> ids = new ArrayList<>();
            if (idsJson != null && idsJson.trim().length() > 0) {
                JSONArray array = new JSONArray(idsJson);
                for (int i = 0; i < array.length(); i++) {
                    String id = array.optString(i, null);
                    if (id != null && id.length() > 0) {
                        ids.add(id);
                    }
                }
            }
            BleSyncStore.clearPending(activity, ids);
        } catch (Throwable t) {
            Log.w(TAG, "clearPending failed", t);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 权限                                                                */
    /* ------------------------------------------------------------------ */

    /** MainActivity.onRequestPermissionsResult 调用 */
    public void onPermissionResult(int requestCode) {
        if (requestCode != REQ_BLE_SYNC_PERMISSION) {
            return;
        }
        permissionDenied = !hasPermissions();
        activity.dispatchBleSyncPermissionEvent();
    }

    private boolean hasPermissions() {
        for (String permission : requiredPermissions()) {
            if (!hasPermission(permission)) {
                return false;
            }
        }
        return true;
    }

    private String[] requiredPermissions() {
        if (Build.VERSION.SDK_INT >= 33) {
            return new String[]{
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.POST_NOTIFICATIONS
            };
        }
        if (Build.VERSION.SDK_INT >= 31) {
            return new String[]{
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_CONNECT
            };
        }
        return new String[]{
                Manifest.permission.ACCESS_FINE_LOCATION
        };
    }

    private boolean hasPermission(String permission) {
        try {
            return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    private void requestPermissions() {
        final String[] permissions = requiredPermissions();
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    activity.requestPermissions(permissions, REQ_BLE_SYNC_PERMISSION);
                } catch (Throwable t) {
                    Log.w(TAG, "request ble sync permissions failed", t);
                }
            }
        });
    }

    private BluetoothAdapter getAdapter() {
        try {
            BluetoothManager manager = (BluetoothManager) activity.getSystemService(
                    Context.BLUETOOTH_SERVICE);
            if (manager != null) {
                return manager.getAdapter();
            }
            return BluetoothAdapter.getDefaultAdapter();
        } catch (Throwable t) {
            return null;
        }
    }
}
