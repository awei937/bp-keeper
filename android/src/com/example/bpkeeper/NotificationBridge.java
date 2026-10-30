package com.example.bpkeeper;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * 原生本地通知桥（JS 侧暴露为 window.BPNativeNotify）。
 *
 * 背景：Android WebView 不暴露 Web Notification API（window.Notification 不存在），
 * 网页无法直接发系统通知，因此由原生侧提供：
 *   isSupported() -> true
 *   isPermissionGranted() -> 是否已授权且系统通知未被关闭
 *   requestPermission() -> "granted" / "requesting" / "disabled"
 *        Android 13+ 未授权时发起 POST_NOTIFICATIONS 运行时权限请求（requestCode 1002），
 *        MainActivity 在 onRequestPermissionsResult 中回调前端事件
 *        window.dispatchEvent(new Event('bp-native-notify-permission'))
 *   notify(title, body) -> 发一条本地通知（渠道 bp_reminders / IMPORTANCE_HIGH）
 *   test() -> 发一条「通知已开启」测试通知
 *
 * 另外该类也作为 window.BPNotify 暴露（通知监听诊断，用于确认米家 App 是否发送测量通知）：
 *   isEnabled() -> 是否已获得「通知使用权」
 *   openSettings() -> 打开系统通知使用权设置页
 *   getNotifications() -> 最近 100 条 com.xiaomi.smarthome（米家）通知的 JSON 数组（无权限返回 []）
 *   clear() -> 清空记录
 *
 * 注意：通知点击后打开 MainActivity。
 */
public class NotificationBridge {

    private static final String TAG = "BPKeeperNotify";

    /** 通知渠道：血压管家提醒 */
    public static final String CHANNEL_ID = "bp_reminders";

    /** POST_NOTIFICATIONS 运行时权限请求码（与 MainActivity 约定） */
    public static final int REQ_NOTIFICATION_PERMISSION = 1002;

    private static final int ID_BASE = 2000;

    /** 每条通知用递增 id，避免相互覆盖 */
    private static final AtomicInteger NEXT_ID = new AtomicInteger(ID_BASE);

    private final MainActivity activity;

    public NotificationBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public boolean isSupported() {
        return true;
    }

    @JavascriptInterface
    public boolean isPermissionGranted() {
        try {
            if (!hasRuntimePermission()) {
                return false;
            }
            NotificationManager nm = getNotificationManager();
            return nm != null && nm.areNotificationsEnabled();
        } catch (Throwable t) {
            Log.w(TAG, "isPermissionGranted failed", t);
            return false;
        }
    }

    /**
     * @return "granted" 已授权；"requesting" 已发起系统权限弹窗（结果通过事件通知网页）；
     *         "disabled" 通知在系统设置中被关闭/无法请求。
     */
    @JavascriptInterface
    public String requestPermission() {
        try {
            if (isPermissionGranted()) {
                return "granted";
            }
            if (Build.VERSION.SDK_INT >= 33 && !hasRuntimePermission()) {
                final MainActivity act = activity;
                act.runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            act.requestPermissions(
                                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                                    REQ_NOTIFICATION_PERMISSION);
                        } catch (Throwable t) {
                            Log.w(TAG, "requestPermissions failed", t);
                            dispatchPermissionEventNow();
                        }
                    }
                });
                return "requesting";
            }
            // 已有权限但系统层面关闭了通知（或低版本用户手动关闭了通知）
            return "disabled";
        } catch (Throwable t) {
            Log.w(TAG, "requestPermission failed", t);
            return "disabled";
        }
    }

    @JavascriptInterface
    public void notify(String title, String body) {
        try {
            Context ctx = activity;
            ensureChannel(ctx);
            String safeTitle = (title == null || title.trim().length() == 0)
                    ? ctx.getString(R.string.app_name) : title.trim();
            String safeBody = body == null ? "" : body.trim();
            int id = nextId();
            Notification notification = new Notification.Builder(ctx, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_stat_notify)
                    .setContentTitle(safeTitle)
                    .setContentText(safeBody)
                    .setStyle(new Notification.BigTextStyle().bigText(safeBody))
                    .setAutoCancel(true)
                    .setShowWhen(true)
                    .setWhen(System.currentTimeMillis())
                    .setCategory(Notification.CATEGORY_REMINDER)
                    .setContentIntent(contentIntent(ctx, id))
                    .build();
            NotificationManager nm = getNotificationManager();
            if (nm == null) {
                Log.w(TAG, "NotificationManager unavailable");
                return;
            }
            nm.notify(id, notification);
        } catch (Throwable t) {
            Log.w(TAG, "notify failed", t);
        }
    }

    @JavascriptInterface
    public void test() {
        try {
            notify(activity.getString(R.string.notify_test_title),
                    activity.getString(R.string.notify_test_body));
        } catch (Throwable t) {
            Log.w(TAG, "test notify failed", t);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 通知监听诊断接口（JS 侧 BPNotify）：读取米家 App 通知               */
    /* ------------------------------------------------------------------ */

    /** 本 App 是否已获得「通知使用权」（在系统设置中开启） */
    @JavascriptInterface
    public boolean isEnabled() {
        return isNotificationListenerEnabled();
    }

    /** 打开系统「通知使用权」设置页，方便用户手工开启 */
    @JavascriptInterface
    public void openSettings() {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Throwable t) {
            Log.w(TAG, "open notification listener settings failed", t);
            try {
                Intent fallback = new Intent(android.provider.Settings.ACTION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(fallback);
            } catch (Throwable ignored) {
                // ignore
            }
        }
    }

    /** 最近 100 条米家通知（JSON 数组，按时间倒序）；无通知使用权时返回 "[]" */
    @JavascriptInterface
    public String getNotifications() {
        try {
            if (!isNotificationListenerEnabled()) {
                return "[]";
            }
            return BpNotificationListener.getNotificationsJson(activity);
        } catch (Throwable t) {
            Log.w(TAG, "getNotifications failed", t);
            return "[]";
        }
    }

    /** 清空通知监听记录 */
    @JavascriptInterface
    public void clear() {
        try {
            BpNotificationListener.clearNotifications(activity);
        } catch (Throwable t) {
            Log.w(TAG, "clear notifications failed", t);
        }
    }

    private boolean isNotificationListenerEnabled() {
        try {
            String enabled = android.provider.Settings.Secure.getString(
                    activity.getContentResolver(), "enabled_notification_listeners");
            if (enabled == null || enabled.length() == 0) {
                return false;
            }
            String expected = activity.getPackageName() + "/"
                    + BpNotificationListener.class.getName();
            return enabled.contains(expected);
        } catch (Throwable t) {
            Log.w(TAG, "check notification listener enabled failed", t);
            return false;
        }
    }

    /* ------------------------------------------------------------------ */

    private NotificationManager getNotificationManager() {
        return (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private boolean hasRuntimePermission() {
        if (Build.VERSION.SDK_INT < 33) {
            return true;
        }
        return activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void ensureChannel(Context ctx) {
        NotificationManager nm = getNotificationManager();
        if (nm == null) {
            return;
        }
        NotificationChannel existing = nm.getNotificationChannel(CHANNEL_ID);
        if (existing != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                ctx.getString(R.string.notify_channel_name),
                NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(ctx.getString(R.string.notify_channel_desc));
        channel.setShowBadge(true);
        nm.createNotificationChannel(channel);
    }

    private PendingIntent contentIntent(Context ctx, int id) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(ctx, id, intent, flags);
    }

    private static int nextId() {
        int id = NEXT_ID.incrementAndGet();
        if (id <= ID_BASE) {
            // 极端回绕保护
            NEXT_ID.set(ID_BASE);
            id = NEXT_ID.incrementAndGet();
        }
        return id;
    }

    private void dispatchPermissionEventNow() {
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.onNotificationPermissionResult();
            }
        });
    }
}
