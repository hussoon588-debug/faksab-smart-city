package com.faksab.smartcity;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private WebView wv;
    private static final int NAVY = 0xFF050D1F;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setBackgroundDrawable(new ColorDrawable(NAVY));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(NAVY);
            getWindow().setNavigationBarColor(NAVY);
        }

        wv = new WebView(this);
        wv.setBackgroundColor(NAVY);
        wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(false);
        }

        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        wv.setWebViewClient(new WebViewClient());
        setContentView(wv);
        wv.loadUrl("file:///android_asset/index.html");
    }

    @Override
    public void onBackPressed() {
        // Let the game close a sheet / return to the city first; exit only when it declines.
        wv.evaluateJavascript("(window.__back&&window.__back())?1:0", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (value == null || !value.contains("1")) {
                    MainActivity.this.finish();
                }
            }
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (wv != null) wv.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (wv != null) wv.onResume();
    }

    @Override
    protected void onDestroy() {
        if (wv != null) {
            wv.loadUrl("about:blank");
            wv.destroy();
            wv = null;
        }
        super.onDestroy();
    }
}
