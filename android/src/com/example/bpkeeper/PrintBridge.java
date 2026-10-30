package com.example.bpkeeper;

import android.app.Activity;
import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * 原生打印桥（JS 侧暴露为 window.BPPrint）。
 *
 * 背景：WebView 中 window.print() 不生效（会被 WebView 忽略），报告页检测到本桥后调用
 * BPPrint.print()，弹出 Android 系统打印/另存为 PDF 界面。
 *
 *   isSupported() -> boolean（PrintManager 可用）
 *   print() -> void（在 UI 线程用 WebView.createPrintDocumentAdapter + PrintManager.print，
 *              标题「血压管家报告」；异常静默返回，不崩溃）
 */
public class PrintBridge {

    private static final String TAG = "BPPrintBridge";
    private static final String JOB_NAME = "血压管家报告";

    private final Activity activity;
    private final WebView webView;

    public PrintBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    @JavascriptInterface
    public boolean isSupported() {
        try {
            return getPrintManager() != null;
        } catch (Throwable t) {
            return false;
        }
    }

    @JavascriptInterface
    public void print() {
        try {
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    doPrint();
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "post print task failed", t);
        }
    }

    private void doPrint() {
        try {
            WebView view = webView;
            if (view == null) {
                Log.w(TAG, "print ignored: webview is null");
                return;
            }
            String url = null;
            try {
                url = view.getUrl();
            } catch (Throwable ignored) {
                // ignore
            }
            if (url == null) {
                Log.w(TAG, "print ignored: no page loaded");
                return;
            }
            PrintManager printManager = getPrintManager();
            if (printManager == null) {
                Log.w(TAG, "print ignored: PrintManager unavailable");
                return;
            }
            PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(JOB_NAME);
            if (adapter == null) {
                Log.w(TAG, "print ignored: print adapter unavailable");
                return;
            }
            PrintAttributes attributes = new PrintAttributes.Builder().build();
            printManager.print(JOB_NAME, adapter, attributes);
        } catch (Throwable t) {
            // 打印失败不影响 App，静默返回
            Log.w(TAG, "print failed", t);
        }
    }

    private PrintManager getPrintManager() {
        try {
            Object service = activity.getSystemService(Context.PRINT_SERVICE);
            return service instanceof PrintManager ? (PrintManager) service : null;
        } catch (Throwable t) {
            return null;
        }
    }
}
