package com.example.bpkeeper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;

import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 蓝牙广播自动同步前台服务（v1.4）。
 *
 * 用户开启后常驻无过滤 BLE 扫描，只处理 FE95 service data 且 productId=8120 的
 * 小米 / iHealth 血压计广播；用 bindkey 做 AES-CCM 解密，解析血压测量后写入本地待导入队列
 * （BleSyncStore），并更新前台通知（低优先级）。
 *
 * 不连接 GATT、不发 HTTP；导入由前端通过 window.BPBleSync.getPending() 完成。
 * 进程被杀后不自动恢复（START_NOT_STICKY），前端会重新 start()。
 */
public class BpBleSyncService extends Service {

    private static final String TAG = "BPBleSyncService";

    public static final String ACTION_START = "com.example.bpkeeper.action.BLE_SYNC_START";
    public static final String ACTION_STOP = "com.example.bpkeeper.action.BLE_SYNC_STOP";

    public static final String CHANNEL_ID = "bp_ble_sync";
    public static final int NOTIFICATION_ID = 3001;

    private static volatile boolean running = false;

    /** 服务是否正在运行（同进程内有效） */
    public static boolean isRunning() {
        return running;
    }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Set<String> capturedKeys =
            Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());

    private static final ParcelUuid FE95_PARCEL_UUID =
            ParcelUuid.fromString(MiBeaconParser.FE95_UUID_STRING);

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private byte[] bindkey;
    private String configuredMac;

    @Override
    public void onCreate() {
        super.onCreate();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        Notification notification = buildNotification(
                getString(R.string.ble_sync_notification_starting));
        startForegroundCompat(notification);

        if (running) {
            // 幂等：已经在运行，仅刷新通知
            updateNotification(getString(R.string.ble_sync_notification_starting));
            return START_NOT_STICKY;
        }

        BleSyncStore.Config config = BleSyncStore.loadConfig(this);
        if (config == null) {
            updateNotification("未配置血压计 MAC / bindkey");
            stopSelf();
            return START_NOT_STICKY;
        }
        bindkey = config.bindkey;
        configuredMac = config.mac;

        if (!startScanning()) {
            updateNotification("无法启动蓝牙扫描，请检查蓝牙开关与权限");
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        updateNotification(getString(R.string.ble_sync_notification_starting));
        Log.i(TAG, "ble sync service started");
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        stopScanning();
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Throwable ignored) {
            // ignore
        }
        Log.i(TAG, "ble sync service stopped");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* 扫描                                                                */
    /* ------------------------------------------------------------------ */

    private boolean startScanning() {
        try {
            BluetoothManager manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
            adapter = manager != null ? manager.getAdapter() : BluetoothAdapter.getDefaultAdapter();
            if (adapter == null || !adapter.isEnabled()) {
                return false;
            }
            scanner = adapter.getBluetoothLeScanner();
            if (scanner == null) {
                return false;
            }
            scanCallback = new ScanCallback() {
                @Override
                public void onScanResult(int callbackType, ScanResult result) {
                    handleScanResult(result);
                }

                @Override
                public void onBatchScanResults(List<ScanResult> results) {
                    if (results == null) {
                        return;
                    }
                    for (ScanResult result : results) {
                        handleScanResult(result);
                    }
                }

                @Override
                public void onScanFailed(int errorCode) {
                    Log.w(TAG, "scan failed: " + errorCode);
                }
            };
            scanner.startScan(scanCallback);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "start scanning failed", t);
            return false;
        }
    }

    private void stopScanning() {
        try {
            if (scanner != null && scanCallback != null) {
                scanner.stopScan(scanCallback);
            }
        } catch (Throwable t) {
            Log.w(TAG, "stop scanning failed", t);
        }
        scanner = null;
        scanCallback = null;
    }

    private void handleScanResult(ScanResult result) {
        if (result == null || bindkey == null) {
            return;
        }
        try {
            ScanRecord record = result.getScanRecord();
            if (record == null) {
                return;
            }
            byte[] serviceData = record.getServiceData(FE95_PARCEL_UUID);
            if (serviceData == null) {
                return;
            }
            BluetoothDevice device = result.getDevice();
            String address = device != null ? device.getAddress() : configuredMac;

            MiBeaconParser.Measurement measurement =
                    MiBeaconParser.parse(serviceData, address, bindkey);
            if (measurement == null && configuredMac != null && address != null
                    && !configuredMac.equalsIgnoreCase(address)) {
                // 广播地址与配置 MAC 不一致时，用配置 MAC 再试（例如设备使用随机地址）
                measurement = MiBeaconParser.parse(serviceData, configuredMac, bindkey);
            }
            if (measurement == null) {
                return;
            }

            String key = buildKey(measurement);
            if (!capturedKeys.add(key)) {
                return;
            }
            if (capturedKeys.size() > 500) {
                // 简单防止内存无限增长
                capturedKeys.clear();
            }
            boolean added = BleSyncStore.addPending(this, measurement);
            if (added) {
                updateNotification(getString(R.string.ble_sync_notification_captured,
                        measurement.systolic, measurement.diastolic));
                Log.i(TAG, "captured measurement " + measurement.systolic + "/"
                        + measurement.diastolic + " pulse=" + measurement.pulse);
            }
        } catch (Throwable t) {
            Log.w(TAG, "handle scan result failed", t);
        }
    }

    private static String buildKey(MiBeaconParser.Measurement measurement) {
        return measurement.measuredAtMillis + "-" + measurement.systolic + "-"
                + measurement.diastolic + "-" + measurement.pulse;
    }

    /* ------------------------------------------------------------------ */
    /* 前台通知                                                            */
    /* ------------------------------------------------------------------ */

    private void startForegroundCompat(Notification notification) {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification(String text) {
        ensureChannel();
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, NOTIFICATION_ID, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(getString(R.string.ble_sync_notification_title))
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setPriority(Notification.PRIORITY_LOW)
                .setContentIntent(pendingIntent)
                .build();
    }

    private void updateNotification(String text) {
        try {
            NotificationManager manager =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.notify(NOTIFICATION_ID, buildNotification(text));
            }
        } catch (Throwable t) {
            Log.w(TAG, "update notification failed", t);
        }
    }

    private void ensureChannel() {
        try {
            NotificationManager manager =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
                return;
            }
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.ble_sync_channel_name),
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.ble_sync_channel_desc));
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        } catch (Throwable t) {
            Log.w(TAG, "create channel failed", t);
        }
    }
}
