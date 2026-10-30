package com.example.bpkeeper;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;
import android.util.SparseArray;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * BLE 扫描/连接诊断桥（JS 侧暴露为 window.BPBle）。
 *
 * 背景：手机浏览器 / WebView 不支持 Web Bluetooth，无法直接读小米血压计；
 * 这里提供原生 BLE 诊断能力，只输出原始扫描结果与 GATT 服务/特征，不解析血压协议。
 *
 * JS 接口：
 *   isSupported() -> 有 BLE adapter 且（可查询时）蓝牙已开启
 *   startScan(seconds) -> "requesting"（缺权限，已申请；结果事件 bp-ble-permission）
 *                         "scanning" 已开始（seconds 5–60，默认 15，到时自动停止）
 *                         "error:..." 失败（蓝牙未开启等）
 *   status() -> "idle" | "scanning" | "done" | "error:<msg>"
 *   results() -> JSON 数组，按 RSSI 降序，最多 50 条：
 *                {name,address,rssi,services:[uuid...],manufacturerData:"hex",manufacturerId}
 *   dumpServices(address) -> "requesting"（缺 BLUETOOTH_CONNECT 权限）
 *                | {"ok":true,name,address,services:[{uuid,characteristics:[{uuid,properties:[...],readValueHex?}]}]}
 *                | {"ok":false,error:"..."}
 *   stopScan() -> void
 *
 * 权限：Android 12+ 用 BLUETOOTH_SCAN + BLUETOOTH_CONNECT（neverForLocation）；
 *       Android 11 及以下用 ACCESS_FINE_LOCATION（扫描结果需要），requestCode 1004。
 *       权限结果通过 window.dispatchEvent(new Event('bp-ble-permission')) 通知网页重试。
 */
public class BleBridge {

    private static final String TAG = "BPKeeperBle";

    /** BLE 运行时权限请求码（与 MainActivity 约定） */
    public static final int REQ_BLE_PERMISSION = 1004;

    private static final int MIN_SCAN_SECONDS = 5;
    private static final int MAX_SCAN_SECONDS = 60;
    private static final int DEFAULT_SCAN_SECONDS = 15;
    private static final int MAX_RESULTS = 50;
    private static final int MAX_CACHED_RESULTS = 200;
    private static final int MAX_CHARACTERISTICS = 40;
    private static final int MAX_READS = 12;
    private static final long READ_TIMEOUT_MS = 1200L;
    private static final long CONNECT_TIMEOUT_MS = 15000L;
    private static final long DISCOVER_TIMEOUT_MS = 15000L;

    private final MainActivity activity;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Object scanLock = new Object();
    private final Object resultsLock = new Object();
    private final Map<String, ScanItem> scanResults = new LinkedHashMap<>();

    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private volatile String scanStatus = "idle";
    private volatile boolean permissionDenied;

    private final Runnable scanTimeout = new Runnable() {
        @Override
        public void run() {
            synchronized (scanLock) {
                stopScanInternal();
                scanStatus = "done";
            }
        }
    };

    public BleBridge(MainActivity activity) {
        this.activity = activity;
    }

    /* ------------------------------------------------------------------ */
    /* JS 接口                                                             */
    /* ------------------------------------------------------------------ */

    @JavascriptInterface
    public boolean isSupported() {
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null) {
            return false;
        }
        try {
            return adapter.isEnabled();
        } catch (Throwable t) {
            // 尚未授予 BLUETOOTH_CONNECT 时无法查询开关状态；先返回 true，startScan 会申请权限
            return true;
        }
    }

    @JavascriptInterface
    public String startScan(int seconds) {
        if (!hasScanPermissions()) {
            if (permissionDenied) {
                return "error:未授予蓝牙权限，请在系统设置中手动允许";
            }
            requestBlePermissions();
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

        final int duration = normalizeSeconds(seconds);
        synchronized (scanLock) {
            stopScanInternal();
            synchronized (resultsLock) {
                scanResults.clear();
            }
            BluetoothLeScanner bleScanner = adapter.getBluetoothLeScanner();
            if (bleScanner == null) {
                scanStatus = "error:无法启动扫描";
                return "error:无法启动扫描";
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
                    synchronized (scanLock) {
                        scanStatus = "error:扫描失败(" + errorCode + ")";
                        stopScanInternal();
                    }
                }
            };
            scanner = bleScanner;
            try {
                bleScanner.startScan(scanCallback);
            } catch (Throwable t) {
                Log.w(TAG, "startScan failed", t);
                scanner = null;
                scanCallback = null;
                scanStatus = "error:启动扫描失败";
                return "error:启动扫描失败";
            }
            scanStatus = "scanning";
            mainHandler.postDelayed(scanTimeout, duration * 1000L);
        }
        return "scanning";
    }

    @JavascriptInterface
    public String status() {
        return scanStatus;
    }

    @JavascriptInterface
    public String results() {
        List<ScanItem> items;
        synchronized (resultsLock) {
            items = new ArrayList<>(scanResults.values());
        }
        Collections.sort(items, new Comparator<ScanItem>() {
            @Override
            public int compare(ScanItem a, ScanItem b) {
                return Integer.compare(b.rssi, a.rssi);
            }
        });
        JSONArray array = new JSONArray();
        int limit = Math.min(MAX_RESULTS, items.size());
        for (int i = 0; i < limit; i++) {
            ScanItem item = items.get(i);
            try {
                JSONObject object = new JSONObject();
                object.put("name", item.name);
                object.put("address", item.address);
                object.put("rssi", item.rssi);
                JSONArray services = new JSONArray();
                for (String uuid : item.services) {
                    services.put(uuid);
                }
                object.put("services", services);
                object.put("manufacturerData", item.manufacturerData);
                object.put("manufacturerId", item.manufacturerId);
                array.put(object);
            } catch (JSONException e) {
                Log.w(TAG, "build scan result json failed", e);
            }
        }
        return array.toString();
    }

    @JavascriptInterface
    public void stopScan() {
        synchronized (scanLock) {
            boolean wasScanning = "scanning".equals(scanStatus);
            stopScanInternal();
            if (wasScanning) {
                scanStatus = "done";
            }
        }
    }

    @JavascriptInterface
    public String dumpServices(String address) {
        if (address == null || address.trim().length() == 0) {
            return errorJson("设备地址为空");
        }
        final String targetAddress = address.trim();

        if (!hasConnectPermission()) {
            if (permissionDenied) {
                return errorJson("未授予蓝牙权限，请在系统设置中手动允许");
            }
            requestBlePermissions();
            return "requesting";
        }
        BluetoothAdapter adapter = getAdapter();
        if (adapter == null) {
            return errorJson("设备不支持蓝牙");
        }
        try {
            if (!adapter.isEnabled()) {
                return errorJson("蓝牙未开启");
            }
        } catch (Throwable t) {
            return errorJson("缺少蓝牙权限");
        }

        BluetoothDevice device;
        try {
            device = adapter.getRemoteDevice(targetAddress);
        } catch (Throwable t) {
            return errorJson("设备地址无效");
        }
        if (device == null) {
            return errorJson("设备地址无效");
        }

        synchronized (scanLock) {
            stopScanInternal();
        }

        DumpSession session = new DumpSession();
        try {
            session.gatt = device.connectGatt(activity, false, buildGattCallback(session),
                    BluetoothDevice.TRANSPORT_LE);
            if (session.gatt == null) {
                return errorJson("无法连接设备");
            }
            if (!session.connectLatch.await(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                    || !session.connected) {
                return errorJson(session.failMessage != null ? session.failMessage : "连接超时");
            }
            session.gatt.discoverServices();
            if (!session.discoverLatch.await(DISCOVER_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                    || !session.discovered) {
                return errorJson(session.failMessage != null ? session.failMessage : "服务发现超时");
            }
            return buildServicesJson(device, targetAddress, session).toString();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return errorJson("连接被中断");
        } catch (Throwable t) {
            Log.w(TAG, "dumpServices failed", t);
            return errorJson("连接/读取失败：" + safeMessage(t));
        } finally {
            try {
                if (session.gatt != null) {
                    session.gatt.disconnect();
                    session.gatt.close();
                }
            } catch (Throwable ignored) {
                // ignore
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* 权限                                                                */
    /* ------------------------------------------------------------------ */

    public void onPermissionResult(int requestCode) {
        if (requestCode != REQ_BLE_PERMISSION) {
            return;
        }
        permissionDenied = !hasScanPermissions();
        activity.dispatchBlePermissionEvent();
    }

    private boolean hasScanPermissions() {
        if (Build.VERSION.SDK_INT >= 31) {
            return hasPermission(Manifest.permission.BLUETOOTH_SCAN)
                    && hasPermission(Manifest.permission.BLUETOOTH_CONNECT);
        }
        return hasPermission(Manifest.permission.ACCESS_FINE_LOCATION);
    }

    private boolean hasConnectPermission() {
        if (Build.VERSION.SDK_INT >= 31) {
            return hasPermission(Manifest.permission.BLUETOOTH_CONNECT);
        }
        return true;
    }

    private boolean hasPermission(String permission) {
        try {
            return activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    private void requestBlePermissions() {
        final String[] permissions;
        if (Build.VERSION.SDK_INT >= 31) {
            permissions = new String[]{
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_CONNECT
            };
        } else {
            permissions = new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION
            };
        }
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    activity.requestPermissions(permissions, REQ_BLE_PERMISSION);
                } catch (Throwable t) {
                    Log.w(TAG, "request ble permissions failed", t);
                }
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* 扫描实现                                                            */
    /* ------------------------------------------------------------------ */

    private void stopScanInternal() {
        mainHandler.removeCallbacks(scanTimeout);
        BluetoothLeScanner currentScanner = scanner;
        ScanCallback currentCallback = scanCallback;
        scanner = null;
        scanCallback = null;
        if (currentScanner != null && currentCallback != null) {
            try {
                currentScanner.stopScan(currentCallback);
            } catch (Throwable t) {
                Log.w(TAG, "stopScan failed", t);
            }
        }
    }

    private void handleScanResult(ScanResult result) {
        if (result == null) {
            return;
        }
        try {
            BluetoothDevice device = result.getDevice();
            if (device == null) {
                return;
            }
            String address = device.getAddress();
            if (address == null) {
                return;
            }
            ScanRecord record = result.getScanRecord();

            String name = "";
            try {
                String deviceName = device.getName();
                if (deviceName != null) {
                    name = deviceName;
                }
            } catch (Throwable ignored) {
                // 缺 BLUETOOTH_CONNECT 时忽略
            }
            if (name.length() == 0 && record != null && record.getDeviceName() != null) {
                name = record.getDeviceName();
            }

            List<String> services = new ArrayList<>();
            String manufacturerData = "";
            int manufacturerId = -1;
            if (record != null) {
                try {
                    List<ParcelUuid> uuids = record.getServiceUuids();
                    if (uuids != null) {
                        for (ParcelUuid uuid : uuids) {
                            services.add(uuid.getUuid().toString());
                        }
                    }
                } catch (Throwable ignored) {
                    // ignore
                }
                try {
                    SparseArray<byte[]> manufacturer = record.getManufacturerSpecificData();
                    if (manufacturer != null && manufacturer.size() > 0) {
                        manufacturerId = manufacturer.keyAt(0);
                        byte[] data = manufacturer.valueAt(0);
                        if (data != null) {
                            manufacturerData = bytesToHex(data);
                        }
                    }
                } catch (Throwable ignored) {
                    // ignore
                }
            }

            ScanItem item = new ScanItem(name, address, result.getRssi(), services,
                    manufacturerData, manufacturerId);
            synchronized (resultsLock) {
                if (scanResults.size() >= MAX_CACHED_RESULTS && !scanResults.containsKey(address)) {
                    return;
                }
                scanResults.remove(address);
                scanResults.put(address, item);
            }
        } catch (Throwable t) {
            Log.w(TAG, "handle scan result failed", t);
        }
    }

    /* ------------------------------------------------------------------ */
    /* GATT 连接/服务发现/读取                                              */
    /* ------------------------------------------------------------------ */

    private BluetoothGattCallback buildGattCallback(final DumpSession session) {
        return new BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    session.connected = true;
                    session.connectLatch.countDown();
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    if (!session.connected) {
                        session.failMessage = "连接失败(status=" + status + ")";
                        session.connectLatch.countDown();
                    }
                }
            }

            @Override
            public void onServicesDiscovered(BluetoothGatt gatt, int status) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    session.discovered = true;
                } else {
                    session.failMessage = "服务发现失败(status=" + status + ")";
                }
                session.discoverLatch.countDown();
            }

            @Override
            public void onCharacteristicRead(BluetoothGatt gatt,
                                             BluetoothGattCharacteristic characteristic, int status) {
                handleCharacteristicRead(session, characteristic,
                        characteristic != null ? characteristic.getValue() : null, status);
            }

            // Android 13+ 回调（旧平台不会调用），避免读取值拿不到
            @Override
            public void onCharacteristicRead(BluetoothGatt gatt,
                                             BluetoothGattCharacteristic characteristic,
                                             byte[] value, int status) {
                handleCharacteristicRead(session, characteristic, value, status);
            }
        };
    }

    private void handleCharacteristicRead(DumpSession session, BluetoothGattCharacteristic characteristic,
                                          byte[] value, int status) {
        if (characteristic == null) {
            return;
        }
        synchronized (session.readLock) {
            if (status == BluetoothGatt.GATT_SUCCESS && value != null) {
                session.readValues.put(characteristic.getUuid().toString(), bytesToHex(value));
            }
            session.pendingReadUuid = characteristic.getUuid().toString();
            session.readLock.notifyAll();
        }
    }

    private String readCharacteristic(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic,
                                      DumpSession session) {
        try {
            synchronized (session.readLock) {
                session.pendingReadUuid = null;
            }
            if (!gatt.readCharacteristic(characteristic)) {
                return null;
            }
            long deadline = System.currentTimeMillis() + READ_TIMEOUT_MS;
            synchronized (session.readLock) {
                while (session.pendingReadUuid == null) {
                    long remain = deadline - System.currentTimeMillis();
                    if (remain <= 0) {
                        break;
                    }
                    try {
                        session.readLock.wait(Math.min(remain, 200L));
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return null;
                    }
                }
            }
            return session.readValues.get(characteristic.getUuid().toString());
        } catch (Throwable t) {
            Log.w(TAG, "read characteristic failed: " + characteristic.getUuid(), t);
            return null;
        }
    }

    private JSONObject buildServicesJson(BluetoothDevice device, String address, DumpSession session)
            throws JSONException {
        JSONObject root = new JSONObject();
        root.put("ok", true);
        String name = "";
        try {
            String deviceName = device.getName();
            if (deviceName != null) {
                name = deviceName;
            }
        } catch (Throwable ignored) {
            // ignore
        }
        root.put("name", name);
        root.put("address", address);

        JSONArray servicesArray = new JSONArray();
        int characteristicCount = 0;
        int readCount = 0;
        if (session.gatt != null) {
            List<BluetoothGattService> services = session.gatt.getServices();
            if (services != null) {
                for (BluetoothGattService service : services) {
                    JSONObject serviceJson = new JSONObject();
                    serviceJson.put("uuid", service.getUuid().toString());
                    JSONArray characteristicsArray = new JSONArray();
                    List<BluetoothGattCharacteristic> characteristics = service.getCharacteristics();
                    if (characteristics != null) {
                        for (BluetoothGattCharacteristic characteristic : characteristics) {
                            if (characteristicCount >= MAX_CHARACTERISTICS) {
                                break;
                            }
                            JSONObject characteristicJson = new JSONObject();
                            characteristicJson.put("uuid", characteristic.getUuid().toString());
                            int properties = characteristic.getProperties();
                            characteristicJson.put("properties", propertiesToJson(properties));
                            if (readCount < MAX_READS
                                    && (properties & BluetoothGattCharacteristic.PROPERTY_READ) != 0) {
                                String hex = readCharacteristic(session.gatt, characteristic, session);
                                if (hex != null) {
                                    characteristicJson.put("readValueHex", hex);
                                    readCount++;
                                }
                            }
                            characteristicsArray.put(characteristicJson);
                            characteristicCount++;
                        }
                    }
                    serviceJson.put("characteristics", characteristicsArray);
                    servicesArray.put(serviceJson);
                }
            }
        }
        root.put("services", servicesArray);
        return root;
    }

    private static JSONArray propertiesToJson(int properties) {
        JSONArray array = new JSONArray();
        if ((properties & BluetoothGattCharacteristic.PROPERTY_BROADCAST) != 0) {
            array.put("BROADCAST");
        }
        if ((properties & BluetoothGattCharacteristic.PROPERTY_READ) != 0) {
            array.put("READ");
        }
        if ((properties & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0) {
            array.put("WRITE_NO_RESPONSE");
        }
        if ((properties & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0) {
            array.put("WRITE");
        }
        if ((properties & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) {
            array.put("NOTIFY");
        }
        if ((properties & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0) {
            array.put("INDICATE");
        }
        if ((properties & BluetoothGattCharacteristic.PROPERTY_SIGNED_WRITE) != 0) {
            array.put("SIGNED_WRITE");
        }
        if ((properties & BluetoothGattCharacteristic.PROPERTY_EXTENDED_PROPS) != 0) {
            array.put("EXTENDED_PROPS");
        }
        return array;
    }

    /* ------------------------------------------------------------------ */
    /* 工具方法                                                            */
    /* ------------------------------------------------------------------ */

    private BluetoothAdapter getAdapter() {
        try {
            BluetoothManager manager = (BluetoothManager) activity.getSystemService(Context.BLUETOOTH_SERVICE);
            if (manager != null) {
                return manager.getAdapter();
            }
            return BluetoothAdapter.getDefaultAdapter();
        } catch (Throwable t) {
            return null;
        }
    }

    private static int normalizeSeconds(int seconds) {
        if (seconds <= 0) {
            return DEFAULT_SCAN_SECONDS;
        }
        if (seconds < MIN_SCAN_SECONDS) {
            return MIN_SCAN_SECONDS;
        }
        if (seconds > MAX_SCAN_SECONDS) {
            return MAX_SCAN_SECONDS;
        }
        return seconds;
    }

    private static String bytesToHex(byte[] bytes) {
        if (bytes == null || bytes.length == 0) {
            return "";
        }
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            builder.append(Character.forDigit((b >> 4) & 0xF, 16));
            builder.append(Character.forDigit(b & 0xF, 16));
        }
        return builder.toString();
    }

    private static String safeMessage(Throwable t) {
        String message = t == null ? null : t.getMessage();
        return (message == null || message.trim().length() == 0) ? "未知错误" : message;
    }

    private static String errorJson(String message) {
        try {
            JSONObject object = new JSONObject();
            object.put("ok", false);
            object.put("error", message);
            return object.toString();
        } catch (Throwable t) {
            return "{\"ok\":false,\"error\":\"扫描/连接失败\"}";
        }
    }

    /* ------------------------------------------------------------------ */
    /* 数据类                                                              */
    /* ------------------------------------------------------------------ */

    private static class ScanItem {
        final String name;
        final String address;
        final int rssi;
        final List<String> services;
        final String manufacturerData;
        final int manufacturerId;

        ScanItem(String name, String address, int rssi, List<String> services,
                 String manufacturerData, int manufacturerId) {
            this.name = name;
            this.address = address;
            this.rssi = rssi;
            this.services = services;
            this.manufacturerData = manufacturerData;
            this.manufacturerId = manufacturerId;
        }
    }

    private static class DumpSession {
        final CountDownLatch connectLatch = new CountDownLatch(1);
        final CountDownLatch discoverLatch = new CountDownLatch(1);
        final Object readLock = new Object();
        final Map<String, String> readValues = new HashMap<>();
        volatile boolean connected;
        volatile boolean discovered;
        volatile String failMessage;
        volatile String pendingReadUuid;
        volatile BluetoothGatt gatt;
    }
}
