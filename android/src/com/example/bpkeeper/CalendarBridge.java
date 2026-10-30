package com.example.bpkeeper;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.CalendarContract;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 系统日历同步桥（JS 侧暴露为 window.BPCalendarSync）。
 *
 * 功能：把网页的提醒时间一键写入手机系统日历（华为日历），无需下载/导入 .ics。
 *   isSupported() -> true
 *   sync(eventsJson) -> "requesting"（缺权限，已弹系统权限框）
 *                       "ok:<count>:<calendarName>" 成功写入
 *                       "error:<msg>" 失败
 *   clear() -> "ok:<n>" / "error:<msg>" 删除本 App 上次同步的日历事件
 *
 * eventsJson: [{"title":"测血压 · 早上","time":"06:30","duration":20,"until":null,"description":"..."}]
 *   time: HH:mm；duration: 分钟（默认 20）；until: YYYY-MM-DD 或 null（每天重复无结束）
 *
 * 去重策略：
 *   1) 删除 SharedPreferences 中记录的上次事件 ID；
 *   2) 同时按 DESCRIPTION LIKE '血压管家自动同步%' 清理本 App 可写日历内的旧事件
 *      （用户清除 App 数据/换日历后重新同步也不会产生重复事件）；
 *   3) 再插入新事件，新事件 DESCRIPTION 统一以「血压管家自动同步」开头。
 *
 * 权限：READ_CALENDAR + WRITE_CALENDAR（requestCode 1003），授权后自动继续同步，
 *       并通过 window.dispatchEvent(new CustomEvent('bp-calendar-sync-result',{detail:{...}}))
 *       回传结果。
 */
public class CalendarBridge {

    private static final String TAG = "BPKeeperCalendar";

    /** READ/WRITE_CALENDAR 运行时权限请求码（与 MainActivity 约定） */
    public static final int REQ_CALENDAR_PERMISSION = 1003;

    /** 本 App 写入日历事件的标记（新事件 DESCRIPTION 以此开头） */
    public static final String MARKER = "血压管家自动同步";

    private static final String PREFS_NAME = "bp_calendar_sync";
    private static final String PREF_EVENT_IDS = "event_ids";
    private static final int DEFAULT_DURATION_MIN = 20;
    private static final int REMINDER_MINUTES = 5;

    private final MainActivity activity;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();

    /** 等待权限授权后继续同步的事件 JSON */
    private String pendingEventsJson;

    public CalendarBridge(MainActivity activity) {
        this.activity = activity;
    }

    /* ------------------------------------------------------------------ */
    /* JS 接口                                                             */
    /* ------------------------------------------------------------------ */

    @JavascriptInterface
    public boolean isSupported() {
        return true;
    }

    @JavascriptInterface
    public String sync(String eventsJson) {
        if (eventsJson == null || eventsJson.trim().length() == 0) {
            return "error:同步数据为空";
        }
        if (!hasCalendarPermission()) {
            synchronized (lock) {
                pendingEventsJson = eventsJson;
            }
            requestCalendarPermission();
            return "requesting";
        }
        return doSync(eventsJson);
    }

    @JavascriptInterface
    public String clear() {
        if (!hasCalendarPermission()) {
            return "error:缺少日历权限，请先同步一次并在系统权限中允许日历权限";
        }
        try {
            ContentResolver resolver = activity.getContentResolver();
            int deleted = deleteRecordedEvents(resolver, loadEventIds());
            List<Long> calendarIds = writableCalendarIds(findWritableCalendars(resolver));
            deleted += deleteMarkedEvents(resolver, calendarIds);
            saveEventIds(new ArrayList<Long>());
            Log.d(TAG, "calendar clear: deleted=" + deleted);
            return "ok:" + deleted;
        } catch (Throwable t) {
            Log.w(TAG, "calendar clear failed", t);
            return "error:" + safeMessage(t);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 权限回调（MainActivity.onRequestPermissionsResult 调用）              */
    /* ------------------------------------------------------------------ */

    public void onPermissionResult(int requestCode, int[] grantResults) {
        if (requestCode != REQ_CALENDAR_PERMISSION) {
            return;
        }
        String pending;
        synchronized (lock) {
            pending = pendingEventsJson;
            pendingEventsJson = null;
        }
        if (!hasCalendarPermission()) {
            dispatchSyncResult(calendarErrorJson("未授予日历权限"));
            return;
        }
        if (pending == null) {
            return;
        }
        final String data = pending;
        new Thread(new Runnable() {
            @Override
            public void run() {
                String result = doSync(data);
                dispatchSyncResult(result);
            }
        }, "bp-calendar-sync").start();
    }

    /* ------------------------------------------------------------------ */
    /* 同步实现                                                            */
    /* ------------------------------------------------------------------ */

    private String doSync(String eventsJson) {
        try {
            List<EventSpec> specs = parseEvents(eventsJson);
            if (specs.isEmpty()) {
                return "error:没有可同步的提醒";
            }
            ContentResolver resolver = activity.getContentResolver();
            List<CalendarInfo> calendars = findWritableCalendars(resolver);
            if (calendars.isEmpty()) {
                return "error:没有可写入的日历，请先在华为日历中登录账号或创建本地日历";
            }
            CalendarInfo target = calendars.get(0);
            List<Long> calendarIds = writableCalendarIds(calendars);

            // 1) 删除上次记录的事件 ID
            int old = deleteRecordedEvents(resolver, loadEventIds());
            // 2) 按 DESCRIPTION 标记清理（防止清除 App 数据/换日历后重复）
            old += deleteMarkedEvents(resolver, calendarIds);

            // 3) 写入新事件
            List<Long> newIds = new ArrayList<>();
            int count = 0;
            for (EventSpec spec : specs) {
                long eventId = insertEvent(resolver, target.id, spec);
                if (eventId > 0) {
                    newIds.add(eventId);
                    addReminder(resolver, eventId);
                    count++;
                }
            }
            if (count == 0) {
                return "error:写入日历失败，请检查日历权限或稍后重试";
            }
            saveEventIds(newIds);
            Log.d(TAG, "calendar sync: deleted old=" + old + ", inserted=" + count
                    + ", calendar=" + target.displayName);
            return "ok:" + count + ":" + target.displayName;
        } catch (JSONException e) {
            Log.w(TAG, "events json invalid", e);
            return "error:同步数据格式错误";
        } catch (Throwable t) {
            Log.w(TAG, "calendar sync failed", t);
            return "error:" + safeMessage(t);
        }
    }

    private List<EventSpec> parseEvents(String eventsJson) throws JSONException {
        JSONArray array = new JSONArray(eventsJson);
        List<EventSpec> specs = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) {
                continue;
            }
            String title = item.optString("title", "");
            if (title.trim().length() == 0) {
                title = "血压管家提醒";
            }
            String time = normalizeTime(item.optString("time", ""));
            int duration = item.optInt("duration", DEFAULT_DURATION_MIN);
            if (duration <= 0) {
                duration = DEFAULT_DURATION_MIN;
            }
            String until = null;
            if (!item.isNull("until")) {
                until = normalizeDate(item.optString("until", ""));
            }
            String description = item.optString("description", "");
            specs.add(new EventSpec(title.trim(), time, duration, until, description));
        }
        return specs;
    }

    private long insertEvent(ContentResolver resolver, long calendarId, EventSpec spec) {
        try {
            long startMillis = todayAtMillis(spec.time);
            long endMillis = startMillis + spec.durationMinutes * 60L * 1000L;

            ContentValues values = new ContentValues();
            values.put(CalendarContract.Events.CALENDAR_ID, calendarId);
            values.put(CalendarContract.Events.TITLE, spec.title);
            values.put(CalendarContract.Events.DESCRIPTION, buildDescription(spec.description));
            values.put(CalendarContract.Events.DTSTART, startMillis);
            values.put(CalendarContract.Events.DTEND, endMillis);
            values.put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().getID());
            if (spec.until != null) {
                String until = toUtcUntil(spec.until, spec.time);
                values.put(CalendarContract.Events.RRULE,
                        until != null ? "FREQ=DAILY;UNTIL=" + until : "FREQ=DAILY");
            } else {
                values.put(CalendarContract.Events.RRULE, "FREQ=DAILY");
            }
            values.put(CalendarContract.Events.HAS_ALARM, 1);

            Uri uri = resolver.insert(CalendarContract.Events.CONTENT_URI, values);
            if (uri == null) {
                return -1;
            }
            String last = uri.getLastPathSegment();
            return last != null ? Long.parseLong(last) : -1;
        } catch (Throwable t) {
            Log.w(TAG, "insert event failed: " + spec.title, t);
            return -1;
        }
    }

    private void addReminder(ContentResolver resolver, long eventId) {
        try {
            ContentValues values = new ContentValues();
            values.put(CalendarContract.Reminders.EVENT_ID, eventId);
            values.put(CalendarContract.Reminders.MINUTES, -REMINDER_MINUTES);
            values.put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT);
            resolver.insert(CalendarContract.Reminders.CONTENT_URI, values);
        } catch (Throwable t) {
            Log.w(TAG, "add reminder failed for event " + eventId, t);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 旧事件清理                                                          */
    /* ------------------------------------------------------------------ */

    /** 删除 SharedPreferences 记录的上次事件 ID（仅当仍是本 App 写入的事件，失败忽略） */
    private int deleteRecordedEvents(ContentResolver resolver, long[] ids) {
        int deleted = 0;
        if (ids == null) {
            return 0;
        }
        for (long id : ids) {
            try {
                Uri uri = ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id);
                boolean ours = true;
                Cursor cursor = resolver.query(uri,
                        new String[]{CalendarContract.Events.DESCRIPTION}, null, null, null);
                if (cursor != null) {
                    try {
                        if (cursor.moveToFirst()) {
                            String desc = cursor.getString(0);
                            ours = desc != null && desc.startsWith(MARKER);
                        }
                    } finally {
                        cursor.close();
                    }
                }
                if (ours) {
                    deleted += resolver.delete(uri, null, null);
                }
            } catch (Throwable t) {
                Log.w(TAG, "delete recorded event " + id + " failed", t);
            }
        }
        return deleted;
    }

    /** 按 DESCRIPTION 标记 + 可写日历范围清理旧事件，返回删除条数 */
    private int deleteMarkedEvents(ContentResolver resolver, List<Long> calendarIds) {
        if (calendarIds == null || calendarIds.isEmpty()) {
            return 0;
        }
        StringBuilder inClause = new StringBuilder();
        for (int i = 0; i < calendarIds.size(); i++) {
            if (i > 0) {
                inClause.append(',');
            }
            inClause.append(calendarIds.get(i).longValue());
        }
        String selection = CalendarContract.Events.DESCRIPTION + " LIKE ?"
                + " AND " + CalendarContract.Events.CALENDAR_ID + " IN (" + inClause + ")";
        String[] args = {MARKER + "%"};

        List<Long> eventIds = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = resolver.query(CalendarContract.Events.CONTENT_URI,
                    new String[]{CalendarContract.Events._ID}, selection, args, null);
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    eventIds.add(cursor.getLong(0));
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "query marked events failed", t);
            return 0;
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }

        int deleted = 0;
        for (long id : eventIds) {
            try {
                deleted += resolver.delete(
                        ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), null, null);
            } catch (Throwable t) {
                Log.w(TAG, "delete marked event " + id + " failed", t);
            }
        }
        return deleted;
    }

    /* ------------------------------------------------------------------ */
    /* 日历选择                                                            */
    /* ------------------------------------------------------------------ */

    private List<CalendarInfo> findWritableCalendars(ContentResolver resolver) {
        List<CalendarInfo> preferred = new ArrayList<>();
        List<CalendarInfo> others = new ArrayList<>();
        String[] projection = {
                CalendarContract.Calendars._ID,
                CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
                CalendarContract.Calendars.ACCOUNT_TYPE,
                CalendarContract.Calendars.ACCOUNT_NAME
        };
        String selection = CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL + " >= "
                + CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR
                + " AND " + CalendarContract.Calendars.VISIBLE + " = 1";
        Cursor cursor = null;
        try {
            cursor = resolver.query(CalendarContract.Calendars.CONTENT_URI,
                    projection, selection, null, null);
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    CalendarInfo info = new CalendarInfo(
                            cursor.getLong(0),
                            cursor.getString(1),
                            cursor.getString(2),
                            cursor.getString(3));
                    if (isPreferredCalendar(info)) {
                        preferred.add(info);
                    } else {
                        others.add(info);
                    }
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "query calendars failed", t);
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        List<CalendarInfo> result = new ArrayList<>(preferred);
        result.addAll(others);
        return result;
    }

    private static boolean isPreferredCalendar(CalendarInfo info) {
        String haystack = (nullToEmpty(info.displayName) + " "
                + nullToEmpty(info.accountType) + " "
                + nullToEmpty(info.accountName)).toLowerCase(Locale.ROOT);
        return haystack.contains("huawei")
                || haystack.contains("hw")
                || haystack.contains("华为")
                || haystack.contains("本地")
                || haystack.contains("phone")
                || haystack.contains("local");
    }

    private static List<Long> writableCalendarIds(List<CalendarInfo> calendars) {
        List<Long> ids = new ArrayList<>();
        if (calendars != null) {
            for (CalendarInfo info : calendars) {
                ids.add(info.id);
            }
        }
        return ids;
    }

    /* ------------------------------------------------------------------ */
    /* 权限                                                                */
    /* ------------------------------------------------------------------ */

    private boolean hasCalendarPermission() {
        return activity.checkSelfPermission(Manifest.permission.READ_CALENDAR)
                == PackageManager.PERMISSION_GRANTED
                && activity.checkSelfPermission(Manifest.permission.WRITE_CALENDAR)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void requestCalendarPermission() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    activity.requestPermissions(
                            new String[]{Manifest.permission.READ_CALENDAR,
                                    Manifest.permission.WRITE_CALENDAR},
                            REQ_CALENDAR_PERMISSION);
                } catch (Throwable t) {
                    Log.w(TAG, "request calendar permission failed", t);
                    dispatchSyncResult(calendarErrorJson("无法申请日历权限"));
                }
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* 结果回传                                                            */
    /* ------------------------------------------------------------------ */

    /** 缺权限/异步同步完成后，通过 window 事件回传结果 */
    private void dispatchSyncResult(String result) {
        JSONObject detail = new JSONObject();
        try {
            detail.put("action", "sync");
            if (result != null && result.startsWith("ok:")) {
                String[] parts = result.split(":", 3);
                int count = 0;
                if (parts.length > 1) {
                    try {
                        count = Integer.parseInt(parts[1]);
                    } catch (NumberFormatException ignored) {
                        // ignore
                    }
                }
                detail.put("ok", true);
                detail.put("count", count);
                detail.put("calendar", parts.length > 2 ? parts[2] : "");
                detail.put("message", "已同步 " + count + " 条提醒到日历");
            } else {
                String message = result != null && result.startsWith("error:")
                        ? result.substring("error:".length()) : String.valueOf(result);
                detail.put("ok", false);
                detail.put("error", message);
            }
        } catch (Throwable t) {
            Log.w(TAG, "build sync result json failed", t);
        }
        activity.dispatchCalendarSyncResult(detail.toString());
    }

    private String calendarErrorJson(String message) {
        try {
            JSONObject detail = new JSONObject();
            detail.put("action", "sync");
            detail.put("ok", false);
            detail.put("error", message);
            return detail.toString();
        } catch (Throwable t) {
            return "{\"action\":\"sync\",\"ok\":false,\"error\":\"同步失败\"}";
        }
    }

    /* ------------------------------------------------------------------ */
    /* 工具方法                                                            */
    /* ------------------------------------------------------------------ */

    private static String buildDescription(String detail) {
        String text = detail == null ? "" : detail.trim();
        if (text.length() == 0) {
            return MARKER;
        }
        if (text.startsWith(MARKER)) {
            return text;
        }
        return MARKER + "：" + text;
    }

    private static String normalizeTime(String time) {
        if (time == null) {
            return "08:00";
        }
        String text = time.trim();
        String[] parts = text.split(":");
        if (parts.length != 2) {
            return "08:00";
        }
        try {
            int hour = Integer.parseInt(parts[0].trim());
            int minute = Integer.parseInt(parts[1].trim());
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                return "08:00";
            }
            return String.format(Locale.US, "%02d:%02d", hour, minute);
        } catch (NumberFormatException e) {
            return "08:00";
        }
    }

    private static String normalizeDate(String date) {
        if (date == null) {
            return null;
        }
        String text = date.trim();
        if (text.length() == 0) {
            return null;
        }
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        format.setLenient(false);
        try {
            format.parse(text);
            return text;
        } catch (ParseException e) {
            return null;
        }
    }

    /** 今天（本地时区）的 HH:mm 时刻 */
    private static long todayAtMillis(String time) {
        String[] parts = time.split(":");
        int hour = Integer.parseInt(parts[0]);
        int minute = Integer.parseInt(parts[1]);
        Calendar calendar = Calendar.getInstance();
        calendar.set(Calendar.HOUR_OF_DAY, hour);
        calendar.set(Calendar.MINUTE, minute);
        calendar.set(Calendar.SECOND, 0);
        calendar.set(Calendar.MILLISECOND, 0);
        return calendar.getTimeInMillis();
    }

    /** 最后一天（含）的本地时刻转成 RRULE 需要的 UTC 形式 yyyyMMdd'T'HHmmss'Z' */
    private static String toUtcUntil(String untilDate, String time) {
        try {
            SimpleDateFormat in = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            in.setLenient(false);
            Date date = in.parse(untilDate);
            String[] parts = time.split(":");
            int hour = Integer.parseInt(parts[0]);
            int minute = Integer.parseInt(parts[1]);
            Calendar calendar = Calendar.getInstance();
            calendar.setTime(date);
            calendar.set(Calendar.HOUR_OF_DAY, hour);
            calendar.set(Calendar.MINUTE, minute);
            calendar.set(Calendar.SECOND, 0);
            calendar.set(Calendar.MILLISECOND, 0);
            SimpleDateFormat out = new SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US);
            out.setTimeZone(TimeZone.getTimeZone("UTC"));
            return out.format(new Date(calendar.getTimeInMillis()));
        } catch (Throwable t) {
            Log.w(TAG, "build UNTIL failed", t);
            return null;
        }
    }

    private SharedPreferences prefs() {
        return activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private void saveEventIds(List<Long> ids) {
        StringBuilder builder = new StringBuilder();
        if (ids != null) {
            for (int i = 0; i < ids.size(); i++) {
                if (i > 0) {
                    builder.append(',');
                }
                builder.append(ids.get(i).longValue());
            }
        }
        prefs().edit().putString(PREF_EVENT_IDS, builder.toString()).apply();
    }

    private long[] loadEventIds() {
        String raw = prefs().getString(PREF_EVENT_IDS, "");
        if (raw == null || raw.trim().length() == 0) {
            return new long[0];
        }
        String[] parts = raw.split(",");
        List<Long> ids = new ArrayList<>();
        for (String part : parts) {
            try {
                ids.add(Long.parseLong(part.trim()));
            } catch (NumberFormatException ignored) {
                // ignore
            }
        }
        long[] result = new long[ids.size()];
        for (int i = 0; i < ids.size(); i++) {
            result[i] = ids.get(i);
        }
        return result;
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private static String safeMessage(Throwable t) {
        String message = t == null ? null : t.getMessage();
        return (message == null || message.trim().length() == 0) ? "同步失败，请稍后重试" : message;
    }

    /* ------------------------------------------------------------------ */
    /* 数据类                                                              */
    /* ------------------------------------------------------------------ */

    private static class EventSpec {
        final String title;
        final String time;
        final int durationMinutes;
        final String until;
        final String description;

        EventSpec(String title, String time, int durationMinutes, String until, String description) {
            this.title = title;
            this.time = time;
            this.durationMinutes = durationMinutes;
            this.until = until;
            this.description = description;
        }
    }

    private static class CalendarInfo {
        final long id;
        final String displayName;
        final String accountType;
        final String accountName;

        CalendarInfo(long id, String displayName, String accountType, String accountName) {
            this.id = id;
            this.displayName = displayName;
            this.accountType = accountType;
            this.accountName = accountName;
        }
    }
}
