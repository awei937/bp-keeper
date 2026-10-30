package com.example.bpkeeper;

import android.app.Notification;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 通知监听诊断服务：记录「米家」App（com.xiaomi.smarthome）发出的通知，
 * 用于判断米家是否会推送小米血压计的测量结果通知。
 *
 * 用户需在系统「设置 → 通知和状态栏 → 通知使用权」中手工开启本 App。
 * 记录最多 100 条，保存到 SharedPreferences（JSON），不写日志正文。
 */
public class BpNotificationListener extends NotificationListenerService {

    private static final String TAG = "BPNotifyListener";

    /** 米家 App 包名 */
    public static final String TARGET_PACKAGE = "com.xiaomi.smarthome";

    private static final String PREFS_NAME = "bp_notification_log";
    private static final String PREF_ITEMS = "items";
    private static final int MAX_ITEMS = 100;
    private static final int MAX_TEXT_LENGTH = 2000;
    private static final Object LOCK = new Object();

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null) {
            return;
        }
        try {
            if (!TARGET_PACKAGE.equals(sbn.getPackageName())) {
                return;
            }
            Notification notification = sbn.getNotification();
            Bundle extras = notification != null ? notification.extras : null;
            String title = extras != null
                    ? charSequenceToString(extras.getCharSequence(Notification.EXTRA_TITLE)) : "";
            String text = extras != null
                    ? charSequenceToString(extras.getCharSequence(Notification.EXTRA_TEXT)) : "";
            String bigText = extras != null
                    ? charSequenceToString(extras.getCharSequence(Notification.EXTRA_BIG_TEXT)) : "";

            JSONObject item = new JSONObject();
            item.put("time", sbn.getPostTime());
            item.put("package", TARGET_PACKAGE);
            item.put("title", truncate(title));
            item.put("text", truncate(text));
            item.put("bigText", truncate(bigText));

            appendNotification(getApplicationContext(), item);
        } catch (Throwable t) {
            Log.w(TAG, "onNotificationPosted failed", t);
        }
    }

    private static void appendNotification(Context context, JSONObject item) {
        if (context == null || item == null) {
            return;
        }
        synchronized (LOCK) {
            try {
                SharedPreferences preferences = context.getSharedPreferences(PREFS_NAME,
                        Context.MODE_PRIVATE);
                JSONArray previous = null;
                String raw = preferences.getString(PREF_ITEMS, null);
                if (raw != null && raw.length() > 0) {
                    try {
                        previous = new JSONArray(raw);
                    } catch (Throwable ignored) {
                        // 数据损坏则重新开始
                    }
                }
                JSONArray next = new JSONArray();
                next.put(item);
                if (previous != null) {
                    for (int i = 0; i < previous.length() && next.length() < MAX_ITEMS; i++) {
                        next.put(previous.opt(i));
                    }
                }
                preferences.edit().putString(PREF_ITEMS, next.toString()).apply();
            } catch (Throwable t) {
                Log.w(TAG, "save notification failed", t);
            }
        }
    }

    /** 读取最近 100 条（按时间倒序），无数据返回 "[]" */
    public static String getNotificationsJson(Context context) {
        if (context == null) {
            return "[]";
        }
        synchronized (LOCK) {
            try {
                String raw = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .getString(PREF_ITEMS, null);
                if (raw == null || raw.length() == 0) {
                    return "[]";
                }
                JSONArray array = new JSONArray(raw);
                return array.toString();
            } catch (Throwable t) {
                Log.w(TAG, "read notifications failed", t);
                return "[]";
            }
        }
    }

    /** 清空记录 */
    public static void clearNotifications(Context context) {
        if (context == null) {
            return;
        }
        synchronized (LOCK) {
            try {
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                        .edit().remove(PREF_ITEMS).apply();
            } catch (Throwable t) {
                Log.w(TAG, "clear notifications failed", t);
            }
        }
    }

    private static String charSequenceToString(CharSequence value) {
        return value == null ? "" : value.toString();
    }

    private static String truncate(String text) {
        if (text == null) {
            return "";
        }
        return text.length() > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;
    }
}
