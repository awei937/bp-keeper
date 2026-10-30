package com.example.bpkeeper;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 极简 WebView 壳：加载血压管家网页版。
 *
 * 功能：
 *  - JavaScript / DOM Storage / Cookie 全开
 *  - WebView 内可后退时返回键后退
 *  - onShowFileChooser 文件上传（相册/文件选择；capture 时拉起相机）
 *  - DownloadListener -> 系统 DownloadManager；并桥接网页的 blob 导出下载
 *  - 非本应用域名的链接交给系统浏览器
 *  - 顶部加载进度、错误页 + 重试、下拉刷新
 *  - 原生通知桥 BPNativeNotify（WebView 不暴露 Web Notification API）
 *  - 系统日历同步桥 BPCalendarSync（提醒时间一键写入手机日历）
 *  - BLE 诊断桥 BPBle / 通知监听诊断桥 BPNotify（v1.3 诊断用）
 *  - 蓝牙广播自动同步桥 BPBleSync + 前台服务 BpBleSyncService（v1.4）
 *  - 原生打印桥 BPPrint（v1.5，WebView 内 window.print() 不生效）
 */
public class MainActivity extends android.app.Activity {

    private static final String TAG = "BPKeeper";

    private static final String TARGET_URL = "https://example.com/";
    private static final String APP_HOST = "example.com";
    private static final int APP_PORT = 8288;

    private static final int REQ_FILE_CHOOSER = 4101;
    private static final int REQ_CAPTURE = 4102;
    private static final int REQ_STORAGE_PERMISSION = 4103;

    private static final long MAX_BLOB_BYTES = 4L * 1024L * 1024L;

    private WebView webView;
    private ProgressBar progressBar;
    private View errorView;
    private TextView errorText;
    private PullToRefreshLayout pullLayout;

    private ValueCallback<Uri[]> filePathCallback;
    private Uri pendingCaptureUri;
    private String lastFailedUrl;
    private boolean pageError;

    private PendingDownload pendingDownload;
    private PendingBlob pendingBlob;

    private CalendarBridge calendarBridge;
    private BleBridge bleBridge;
    private BleSyncBridge bleSyncBridge;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progress);
        errorView = findViewById(R.id.error_view);
        errorText = findViewById(R.id.error_text);
        pullLayout = findViewById(R.id.pull_layout);

        Button retryBtn = findViewById(R.id.retry_btn);
        retryBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                retryLoad();
            }
        });

        pullLayout.setOnRefreshListener(new PullToRefreshLayout.OnRefreshListener() {
            @Override
            public void onRefresh() {
                if (webView != null) {
                    webView.reload();
                }
            }
        });

        if (webView.getParent() instanceof View) {
            View parent = (View) webView.getParent();
            parent.setOverScrollMode(View.OVER_SCROLL_NEVER);
        }
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setBackgroundColor(0xFFFFFFFF);

        configureWebView();

        webView.setWebViewClient(new AppWebViewClient());
        webView.setWebChromeClient(new AppChromeClient());
        webView.addJavascriptInterface(new NativeBridge(), "BPNative");
        // 原生本地通知桥：WebView 不暴露 window.Notification，网页通过 BPNativeNotify 发系统通知
        webView.addJavascriptInterface(new NotificationBridge(this), "BPNativeNotify");
        // 通知监听诊断桥：读取米家 App 的通知（JS 名 BPNotify）
        webView.addJavascriptInterface(new NotificationBridge(this), "BPNotify");
        // 系统日历同步桥：网页提醒时间一键写入手机日历（华为日历）
        calendarBridge = new CalendarBridge(this);
        webView.addJavascriptInterface(calendarBridge, "BPCalendarSync");
        // BLE 扫描/连接诊断桥（小米血压计诊断用）
        bleBridge = new BleBridge(this);
        webView.addJavascriptInterface(bleBridge, "BPBle");
        // 蓝牙广播自动同步桥（v1.4：FE95 广播 + bindkey 解密 -> 待导入队列）
        bleSyncBridge = new BleSyncBridge(this);
        webView.addJavascriptInterface(bleSyncBridge, "BPBleSync");
        // 原生打印桥（v1.5：WebView 内 window.print() 不生效，报告页调用 BPPrint.print()）
        webView.addJavascriptInterface(new PrintBridge(this, webView), "BPPrint");
        webView.setDownloadListener(new AppDownloadListener());

        UploadFileProvider.cleanOldFiles(this);

        if (savedInstanceState != null) {
            lastFailedUrl = savedInstanceState.getString("last_failed_url");
            webView.restoreState(savedInstanceState);
            if (webView.copyBackForwardList().getSize() == 0) {
                webView.loadUrl(TARGET_URL);
            }
        } else {
            webView.loadUrl(TARGET_URL);
        }
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        s.setGeolocationEnabled(false);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= 21) {
            cm.setAcceptThirdPartyCookies(webView, true);
        }
    }

    /* ------------------------------------------------------------------ */
    /* WebViewClient                                                       */
    /* ------------------------------------------------------------------ */

    private class AppWebViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (request == null || request.getUrl() == null) {
                return false;
            }
            if (Build.VERSION.SDK_INT >= 24 && !request.isForMainFrame()) {
                // 子框架导航留在 WebView 内处理
                return false;
            }
            return handleNavigation(request.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            if (url == null) {
                return false;
            }
            return handleNavigation(Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            pageError = false;
            if (url != null) {
                lastFailedUrl = url;
            }
            if (progressBar != null) {
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(0);
            }
            if (errorView != null) {
                errorView.setVisibility(View.GONE);
            }
            if (webView != null) {
                webView.setVisibility(View.VISIBLE);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (progressBar != null) {
                progressBar.setVisibility(View.GONE);
            }
            if (!pageError) {
                if (errorView != null) {
                    errorView.setVisibility(View.GONE);
                }
                if (webView != null) {
                    webView.setVisibility(View.VISIBLE);
                }
                if (pullLayout != null) {
                    pullLayout.setRefreshing(false);
                }
            }
            injectBlobDownloadHook();
            CookieManager.getInstance().flush();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                String desc = error != null ? String.valueOf(error.getDescription()) : "";
                if (desc.contains("ERR_ABORTED")) {
                    // 页面内连续跳转/被新导航打断时会产生 ERR_ABORTED，不算加载失败
                    Log.d(TAG, "ignore aborted main-frame load: " + desc);
                    return;
                }
                showErrorPage(request.getUrl() != null ? request.getUrl().toString() : urlOf(view), desc);
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
            // 服务端使用受信任的 Let's Encrypt 证书；出现证书错误时中断并提示
            if (handler != null) {
                handler.cancel();
            }
            showErrorPage(urlOf(view), getString(R.string.ssl_error));
        }
    }

    private String urlOf(WebView view) {
        if (view != null && view.getUrl() != null) {
            return view.getUrl();
        }
        return TARGET_URL;
    }

    private boolean handleNavigation(Uri uri) {
        if (uri == null) {
            return false;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if ("https".equals(scheme)) {
            if (isInternal(uri)) {
                return false;
            }
            openExternally(uri);
            return true;
        }
        if ("http".equals(scheme)) {
            // 仅 HTTPS 站点；http 链接一律交给系统浏览器
            openExternally(uri);
            return true;
        }
        if ("about".equals(scheme) || "data".equals(scheme) || "blob".equals(scheme)
                || "javascript".equals(scheme)) {
            return false;
        }
        // intent:// 链接按系统深链解析后再打开
        if ("intent".equals(scheme)) {
            try {
                Intent intent = Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Exception e) {
                toast(getString(R.string.external_link_failed));
            }
            return true;
        }
        // tel: mailto: sms: 等交给系统处理
        openExternally(uri);
        return true;
    }

    private boolean isInternal(Uri uri) {
        return APP_HOST.equalsIgnoreCase(uri.getHost()) && uri.getPort() == APP_PORT;
    }

    private void openExternally(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            toast(getString(R.string.external_link_failed));
        }
    }

    /* ------------------------------------------------------------------ */
    /* 错误页 / 重试                                                        */
    /* ------------------------------------------------------------------ */

    private void showErrorPage(String failedUrl, String detail) {
        pageError = true;
        if (failedUrl != null && !failedUrl.startsWith("data:")) {
            lastFailedUrl = failedUrl;
        }
        if (progressBar != null) {
            progressBar.setVisibility(View.GONE);
        }
        if (errorView != null) {
            errorView.setVisibility(View.VISIBLE);
        }
        if (errorText != null) {
            errorText.setText(getString(R.string.error_hint));
        }
        if (webView != null) {
            webView.setVisibility(View.GONE);
        }
        if (pullLayout != null) {
            pullLayout.setRefreshing(false);
        }
        if (detail != null && detail.length() > 0) {
            Log.w(TAG, "load error: " + detail + " url=" + failedUrl);
        }
    }

    private void retryLoad() {
        pageError = false;
        if (errorView != null) {
            errorView.setVisibility(View.GONE);
        }
        if (webView != null) {
            webView.setVisibility(View.VISIBLE);
        }
        if (progressBar != null) {
            progressBar.setVisibility(View.VISIBLE);
            progressBar.setProgress(0);
        }
        String url = (lastFailedUrl != null && !lastFailedUrl.isEmpty()) ? lastFailedUrl : TARGET_URL;
        if (webView != null) {
            webView.loadUrl(url);
        }
    }

    /* ------------------------------------------------------------------ */
    /* WebChromeClient：进度 + 文件上传                                      */
    /* ------------------------------------------------------------------ */

    private class AppChromeClient extends WebChromeClient {

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            super.onProgressChanged(view, newProgress);
            if (progressBar == null) {
                return;
            }
            if (newProgress >= 100) {
                progressBar.setVisibility(View.GONE);
            } else {
                progressBar.setVisibility(View.VISIBLE);
                progressBar.setProgress(newProgress);
            }
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (callback == null) {
                return false;
            }
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(null);
                filePathCallback = null;
            }
            filePathCallback = callback;

            try {
                if (params != null && params.isCaptureEnabled()) {
                    Intent camera = buildCameraIntent();
                    if (camera != null) {
                        startActivityForResult(camera, REQ_CAPTURE);
                        return true;
                    }
                    toast(getString(R.string.camera_not_found));
                }
                Intent picker = buildFilePickerIntent(params);
                startActivityForResult(picker, REQ_FILE_CHOOSER);
                return true;
            } catch (Exception e) {
                Log.w(TAG, "file chooser failed", e);
                resetFileCallback(null);
                toast(getString(R.string.file_picker_failed));
                return false;
            }
        }
    }

    private Intent buildFilePickerIntent(WebChromeClient.FileChooserParams params) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        String type = "*/*";
        if (params != null) {
            String[] accept = params.getAcceptTypes();
            if (accept != null) {
                for (String raw : accept) {
                    if (raw != null && raw.trim().length() > 0) {
                        type = raw.split(",")[0].trim();
                        break;
                    }
                }
            }
            if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
        }
        intent.setType(type);
        return Intent.createChooser(intent, getString(R.string.chooser_title));
    }

    private Intent buildCameraIntent() {
        pendingCaptureUri = UploadFileProvider.newImageUri(this);
        if (pendingCaptureUri == null) {
            return null;
        }
        Intent intent = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
        intent.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, pendingCaptureUri);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            intent.setClipData(android.content.ClipData.newRawUri("capture", pendingCaptureUri));
        } catch (Exception ignored) {
            // 部分老系统对 clipData 不友好，忽略
        }
        return intent;
    }

    private void resetFileCallback(Uri[] result) {
        ValueCallback<Uri[]> cb = filePathCallback;
        filePathCallback = null;
        if (cb != null) {
            cb.onReceiveValue(result);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER || requestCode == REQ_CAPTURE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK) {
                if (requestCode == REQ_CAPTURE) {
                    if (pendingCaptureUri != null && UploadFileProvider.exists(this, pendingCaptureUri)) {
                        result = new Uri[]{pendingCaptureUri};
                    }
                } else if (data != null) {
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        List<Uri> uris = new ArrayList<>();
                        for (int i = 0; i < count; i++) {
                            Uri u = data.getClipData().getItemAt(i).getUri();
                            if (u != null) {
                                uris.add(u);
                            }
                        }
                        if (!uris.isEmpty()) {
                            result = uris.toArray(new Uri[0]);
                        }
                    } else if (data.getData() != null) {
                        result = new Uri[]{data.getData()};
                    }
                }
            }
            if (pendingCaptureUri != null && result == null) {
                UploadFileProvider.deleteFile(this, pendingCaptureUri);
            }
            pendingCaptureUri = null;
            resetFileCallback(result);
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /* ------------------------------------------------------------------ */
    /* 文件下载                                                            */
    /* ------------------------------------------------------------------ */

    private class AppDownloadListener implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                    String mimeType, long contentLength) {
            beginDownload(url, userAgent, contentDisposition, mimeType);
        }
    }

    private void beginDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        if (url == null) {
            return;
        }
        String scheme = Uri.parse(url).getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            toast(getString(R.string.download_unsupported));
            return;
        }
        if (!hasStoragePermission()) {
            pendingDownload = new PendingDownload(url, userAgent, contentDisposition, mimeType);
            requestStoragePermission();
            return;
        }
        enqueueDownload(new PendingDownload(url, userAgent, contentDisposition, mimeType));
    }

    private void enqueueDownload(PendingDownload info) {
        try {
            String fileName = URLUtil.guessFileName(info.url, info.contentDisposition, info.mimeType);
            if (fileName == null || fileName.trim().length() == 0) {
                fileName = "download";
            }
            fileName = sanitizeFileName(fileName);

            android.app.DownloadManager.Request request =
                    new android.app.DownloadManager.Request(Uri.parse(info.url));

            String cookie = CookieManager.getInstance().getCookie(info.url);
            if (cookie != null && cookie.length() > 0) {
                request.addRequestHeader("Cookie", cookie);
            }
            if (info.userAgent != null) {
                request.addRequestHeader("User-Agent", info.userAgent);
            }
            String referer = webView != null ? webView.getUrl() : null;
            if (referer != null) {
                request.addRequestHeader("Referer", referer);
            }
            if (info.mimeType != null && info.mimeType.length() > 0) {
                request.setMimeType(info.mimeType);
            }
            request.setTitle(fileName);
            request.setDescription(getString(R.string.app_name));
            request.setNotificationVisibility(
                    android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);

            if (Build.VERSION.SDK_INT >= 29) {
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                }
                File target = uniqueFile(dir, fileName);
                request.setDestinationUri(Uri.fromFile(target));
            }

            android.app.DownloadManager dm =
                    (android.app.DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                toast(getString(R.string.download_failed));
                return;
            }
            dm.enqueue(request);
            toast(getString(R.string.download_started, fileName));
        } catch (Exception e) {
            Log.w(TAG, "enqueue download failed", e);
            toast(getString(R.string.download_failed));
        }
    }

    /* ------------------------------------------------------------------ */
    /* blob 导出下载桥（网页用 fetch -> blob -> a[download]，DownloadListener 收不到） */
    /* ------------------------------------------------------------------ */

    private class NativeBridge {
        @JavascriptInterface
        public void saveBlob(String filename, String mimeType, String base64) {
            if (!isTrustedPage()) {
                Log.w(TAG, "saveBlob from untrusted page, ignored");
                return;
            }
            if (base64 == null || base64.length() == 0) {
                return;
            }
            if (base64.length() > MAX_BLOB_BYTES * 4L / 3L + 16L) {
                toastOnUi(getString(R.string.download_failed));
                return;
            }
            final byte[] bytes;
            try {
                bytes = Base64.decode(base64, Base64.DEFAULT);
            } catch (Exception e) {
                Log.w(TAG, "saveBlob decode failed", e);
                toastOnUi(getString(R.string.download_failed));
                return;
            }
            if (bytes == null || bytes.length == 0) {
                return;
            }
            final String safeName = sanitizeFileName(filename);
            final String mime = mimeType == null ? "" : mimeType;
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    saveBlobBytes(safeName, mime, bytes);
                }
            }, "bp-save-blob");
            t.start();
        }
    }

    private boolean isTrustedPage() {
        String url = webView != null ? webView.getUrl() : null;
        if (url == null) {
            return false;
        }
        Uri uri = Uri.parse(url);
        return "https".equalsIgnoreCase(uri.getScheme()) && isInternal(uri);
    }

    private void saveBlobBytes(String name, String mime, byte[] bytes) {
        String displayMime = (mime == null || mime.length() == 0) ? "application/octet-stream" : mime;
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                Uri saved = Api29.saveToDownloads(getContentResolver(), name, displayMime, bytes);
                if (saved != null) {
                    toastOnUi(getString(R.string.download_saved_downloads, name));
                    return;
                }
            } catch (Exception e) {
                Log.w(TAG, "mediastore save failed", e);
            }
            fallbackSaveToAppDir(name, bytes);
            return;
        }
        if (!hasStoragePermission()) {
            pendingBlob = new PendingBlob(name, displayMime, bytes);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    requestStoragePermission();
                }
            });
            return;
        }
        try {
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!dir.exists()) {
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
            }
            File target = uniqueFile(dir, name);
            FileOutputStream fos = new FileOutputStream(target);
            try {
                fos.write(bytes);
                fos.flush();
            } finally {
                try {
                    fos.close();
                } catch (IOException ignored) {
                }
            }
            toastOnUi(getString(R.string.download_saved_downloads, target.getName()));
        } catch (Exception e) {
            Log.w(TAG, "pre-Q save failed", e);
            fallbackSaveToAppDir(name, bytes);
        }
    }

    private void fallbackSaveToAppDir(String name, byte[] bytes) {
        try {
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) {
                dir = new File(getFilesDir(), "downloads");
            }
            if (!dir.exists()) {
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
            }
            File target = uniqueFile(dir, name);
            FileOutputStream fos = new FileOutputStream(target);
            try {
                fos.write(bytes);
                fos.flush();
            } finally {
                try {
                    fos.close();
                } catch (IOException ignored) {
                }
            }
            toastOnUi(getString(R.string.download_saved_app, target.getAbsolutePath()));
        } catch (Exception e) {
            Log.w(TAG, "fallback save failed", e);
            toastOnUi(getString(R.string.download_failed));
        }
    }

    private void requestStoragePermission() {
        if (Build.VERSION.SDK_INT >= 29) {
            // Android 10+ 写入公共“下载”目录无需权限，直接继续
            if (pendingDownload != null) {
                PendingDownload d = pendingDownload;
                pendingDownload = null;
                enqueueDownload(d);
            }
            if (pendingBlob != null) {
                final PendingBlob b = pendingBlob;
                pendingBlob = null;
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        saveBlobBytes(b.name, b.mime, b.bytes);
                    }
                }, "bp-save-blob").start();
            }
            return;
        }
        if (hasStoragePermission()) {
            if (pendingDownload != null) {
                PendingDownload d = pendingDownload;
                pendingDownload = null;
                enqueueDownload(d);
            }
            if (pendingBlob != null) {
                final PendingBlob b = pendingBlob;
                pendingBlob = null;
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        saveBlobBytes(b.name, b.mime, b.bytes);
                    }
                }, "bp-save-blob").start();
            }
            return;
        }
        requestPermissions(new String[]{android.Manifest.permission.WRITE_EXTERNAL_STORAGE},
                REQ_STORAGE_PERMISSION);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NotificationBridge.REQ_NOTIFICATION_PERMISSION) {
            // 无论允许/拒绝，都通知网页刷新通知权限状态
            dispatchNativeNotifyPermissionEvent();
            return;
        }
        if (requestCode == CalendarBridge.REQ_CALENDAR_PERMISSION) {
            // 日历权限结果：授权则自动继续同步，并通过 bp-calendar-sync-result 事件回传
            if (calendarBridge != null) {
                calendarBridge.onPermissionResult(requestCode, grantResults);
            }
            return;
        }
        if (requestCode == BleBridge.REQ_BLE_PERMISSION) {
            // 蓝牙权限结果：派发 bp-ble-permission 事件，页面重试扫描/连接
            if (bleBridge != null) {
                bleBridge.onPermissionResult(requestCode);
            }
            return;
        }
        if (requestCode == BleSyncBridge.REQ_BLE_SYNC_PERMISSION) {
            // 蓝牙自动同步权限结果：派发 bp-ble-sync-permission 事件，页面重试 start()
            if (bleSyncBridge != null) {
                bleSyncBridge.onPermissionResult(requestCode);
            }
            return;
        }
        if (requestCode != REQ_STORAGE_PERMISSION) {
            return;
        }
        boolean granted = grantResults != null && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            if (pendingDownload != null) {
                PendingDownload d = pendingDownload;
                pendingDownload = null;
                enqueueDownload(d);
            }
            if (pendingBlob != null) {
                final PendingBlob b = pendingBlob;
                pendingBlob = null;
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        saveBlobBytes(b.name, b.mime, b.bytes);
                    }
                }, "bp-save-blob").start();
            }
        } else {
            pendingDownload = null;
            pendingBlob = null;
            toast(getString(R.string.storage_permission_denied));
        }
    }

    private boolean hasStoragePermission() {
        if (Build.VERSION.SDK_INT >= 29) {
            return true;
        }
        return checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED;
    }

    /* ------------------------------------------------------------------ */
    /* 原生通知权限回调（供 NotificationBridge 与 onRequestPermissionsResult 调用） */
    /* ------------------------------------------------------------------ */

    /** 通知权限弹窗结束后调用，通知网页刷新状态 */
    public void onNotificationPermissionResult() {
        dispatchNativeNotifyPermissionEvent();
    }

    private void dispatchNativeNotifyPermissionEvent() {
        if (webView == null) {
            return;
        }
        try {
            webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('bp-native-notify-permission'));", null);
        } catch (Throwable t) {
            Log.w(TAG, "dispatch notify permission event failed", t);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 日历同步结果回调（供 CalendarBridge 调用）                            */
    /* ------------------------------------------------------------------ */

    /** 把日历同步结果以 CustomEvent 回传给网页（detail 为 JSON 对象字符串） */
    public void dispatchCalendarSyncResult(final String json) {
        if (webView == null || json == null) {
            return;
        }
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (webView == null) {
                    return;
                }
                try {
                    webView.evaluateJavascript(
                            "window.dispatchEvent(new CustomEvent('bp-calendar-sync-result',{detail:"
                                    + json + "}));", null);
                } catch (Throwable t) {
                    Log.w(TAG, "dispatch calendar sync result failed", t);
                }
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* BLE 权限回调（供 BleBridge 调用）                                     */
    /* ------------------------------------------------------------------ */

    /** 蓝牙权限弹窗结束后调用，通知网页重试扫描/连接 */
    public void dispatchBlePermissionEvent() {
        if (webView == null) {
            return;
        }
        try {
            webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('bp-ble-permission'));", null);
        } catch (Throwable t) {
            Log.w(TAG, "dispatch ble permission event failed", t);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 蓝牙自动同步权限回调（供 BleSyncBridge 调用）                          */
    /* ------------------------------------------------------------------ */

    /** 蓝牙/通知权限弹窗结束后调用，通知网页重试 start() */
    public void dispatchBleSyncPermissionEvent() {
        if (webView == null) {
            return;
        }
        try {
            webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('bp-ble-sync-permission'));", null);
        } catch (Throwable t) {
            Log.w(TAG, "dispatch ble sync permission event failed", t);
        }
    }

    /**
     * API 29+ 的 MediaStore 写入隔离在独立内部类中，避免旧系统加载到不存在的类。
     */
    private static class Api29 {
        static Uri saveToDownloads(android.content.ContentResolver resolver, String name,
                                   String mime, byte[] bytes) throws IOException {
            android.content.ContentValues cv = new android.content.ContentValues();
            cv.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
            cv.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
            cv.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            cv.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);
            Uri item = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (item == null) {
                return null;
            }
            OutputStream os = null;
            try {
                os = resolver.openOutputStream(item, "w");
                if (os == null) {
                    throw new IOException("openOutputStream returned null");
                }
                os.write(bytes);
                os.flush();
            } finally {
                if (os != null) {
                    try {
                        os.close();
                    } catch (IOException ignored) {
                    }
                }
            }
            android.content.ContentValues done = new android.content.ContentValues();
            done.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(item, done, null, null);
            return item;
        }
    }

    /* ------------------------------------------------------------------ */
    /* 工具方法                                                            */
    /* ------------------------------------------------------------------ */

    private static final String BLOB_HOOK_JS = "(function(){"
            + "if(window.__bpNativeDownloadHook){return;}"
            + "window.__bpNativeDownloadHook=true;"
            + "var store={};"
            + "var origCreate=URL.createObjectURL?URL.createObjectURL.bind(URL):null;"
            + "if(origCreate){URL.createObjectURL=function(b){var u=origCreate(b);try{store[u]=b;}catch(e){}return u;};}"
            + "var origRevoke=URL.revokeObjectURL?URL.revokeObjectURL.bind(URL):null;"
            + "if(origRevoke){URL.revokeObjectURL=function(u){try{delete store[u];}catch(e){}return origRevoke(u);};}"
            + "function send(blob,name){"
            + "if(!blob||!window.BPNative||!window.BPNative.saveBlob){return;}"
            + "var fr=new FileReader();"
            + "fr.onloadend=function(){"
            + "var s=String(fr.result||'');var i=s.indexOf(',');"
            + "if(i<0){return;}"
            + "try{window.BPNative.saveBlob(name,blob.type||'',s.slice(i+1));}catch(e){}"
            + "};"
            + "fr.readAsDataURL(blob);"
            + "}"
            + "document.addEventListener('click',function(ev){"
            + "var t=ev.target;"
            + "while(t&&t!==document&&t.tagName!=='A'){t=t.parentElement;}"
            + "if(!t||t.tagName!=='A'){return;}"
            + "var href=t.href||'';"
            + "if(href.indexOf('blob:')!==0){return;}"
            + "if(!(window.BPNative&&window.BPNative.saveBlob)){return;}"
            + "ev.preventDefault();ev.stopPropagation();"
            + "var name=t.getAttribute('download')||('download_'+Date.now());"
            + "var blob=store[href];"
            + "if(blob){send(blob,name);}"
            + "else{fetch(href).then(function(r){return r.blob();}).then(function(b){send(b,name);}).catch(function(){});}"
            + "},true);"
            + "})();";

    private void injectBlobDownloadHook() {
        if (webView == null) {
            return;
        }
        try {
            webView.evaluateJavascript(BLOB_HOOK_JS, null);
        } catch (Exception e) {
            Log.w(TAG, "inject blob hook failed", e);
        }
    }

    private void toast(String message) {
        try {
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
        } catch (Exception ignored) {
        }
    }

    private void toastOnUi(final String message) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                toast(message);
            }
        });
    }

    private static String sanitizeFileName(String name) {
        if (name == null) {
            return "download";
        }
        String cleaned = name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").trim();
        if (cleaned.length() == 0) {
            cleaned = "download";
        }
        if (cleaned.length() > 120) {
            int dot = cleaned.lastIndexOf('.');
            if (dot > 0 && cleaned.length() - dot <= 12) {
                cleaned = cleaned.substring(0, 120 - (cleaned.length() - dot)) + cleaned.substring(dot);
            } else {
                cleaned = cleaned.substring(0, 120);
            }
        }
        return cleaned;
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) {
            return f;
        }
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            File candidate = new File(dir, base + " (" + i + ")" + ext);
            if (!candidate.exists()) {
                return candidate;
            }
        }
        return new File(dir, base + "_" + System.currentTimeMillis() + ext);
    }

    /* ------------------------------------------------------------------ */
    /* 生命周期 / 返回键                                                    */
    /* ------------------------------------------------------------------ */

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) {
            webView.onPause();
        }
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
        // 用户可能刚从系统设置返回（开启/关闭了通知），让网页刷新一次通知状态
        if (webView != null) {
            dispatchNativeNotifyPermissionEvent();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString("last_failed_url", lastFailedUrl);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onDestroy() {
        resetFileCallback(null);
        if (webView != null) {
            try {
                webView.removeJavascriptInterface("BPNative");
                webView.removeJavascriptInterface("BPNativeNotify");
                webView.removeJavascriptInterface("BPNotify");
                webView.removeJavascriptInterface("BPCalendarSync");
                webView.removeJavascriptInterface("BPBle");
                webView.removeJavascriptInterface("BPBleSync");
                webView.removeJavascriptInterface("BPPrint");
                webView.setWebChromeClient(null);
                webView.setWebViewClient(null);
                webView.stopLoading();
                webView.destroy();
            } catch (Exception e) {
                Log.w(TAG, "webview destroy failed", e);
            }
            webView = null;
        }
        super.onDestroy();
    }

    private static class PendingDownload {
        final String url;
        final String userAgent;
        final String contentDisposition;
        final String mimeType;

        PendingDownload(String url, String userAgent, String contentDisposition, String mimeType) {
            this.url = url;
            this.userAgent = userAgent;
            this.contentDisposition = contentDisposition;
            this.mimeType = mimeType;
        }
    }

    private static class PendingBlob {
        final String name;
        final String mime;
        final byte[] bytes;

        PendingBlob(String name, String mime, byte[] bytes) {
            this.name = name;
            this.mime = mime;
            this.bytes = bytes;
        }
    }
}
