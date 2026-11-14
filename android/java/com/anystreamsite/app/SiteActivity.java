package com.anystreamsite.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * One streaming site in its own WebView, with the same back / forward / reload /
 * exit controls the desktop app shows above the site.
 */
public class SiteActivity extends Activity {
    private WebView web;
    private ImageButton backBtn;
    private ImageButton forwardBtn;
    private ImageButton reloadBtn;
    private ProgressBar progress;
    private FrameLayout stage;
    private View chrome;
    private boolean chromeHidden;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private boolean tv;
    private String siteNavMode;
    private String siteDpadScript;
    private long lastDirectionAt;
    private int lastDirectionCode;
    private boolean chromeFocused;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_site);

        web = (WebView) findViewById(R.id.site);
        tv = Tv.isTv(this);
        siteNavMode = getSharedPreferences("anystreamsite", MODE_PRIVATE)
                .getString("site_nav_mode", "dpad");
        if (!"pointer".equals(siteNavMode)) siteNavMode = "dpad";
        backBtn = (ImageButton) findViewById(R.id.backBtn);
        forwardBtn = (ImageButton) findViewById(R.id.forwardBtn);
        reloadBtn = (ImageButton) findViewById(R.id.reloadBtn);
        progress = (ProgressBar) findViewById(R.id.progress);
        stage = (FrameLayout) findViewById(R.id.stage);
        chrome = findViewById(R.id.chrome);

        String url = getIntent().getStringExtra("url");
        String name = getIntent().getStringExtra("name");
        TextView title = (TextView) findViewById(R.id.title);
        title.setText(name != null && name.length() > 0 ? name : hostOf(url));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (tv) {
            // The site scrollbar must not steal clicks in either navigation
            // mode; the page still scrolls via the controller or content.
            web.setVerticalScrollBarEnabled(false);
            web.setHorizontalScrollBarEnabled(false);
            web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        }
        // D-pad mode also needs real taps for poster/image links whose click
        // handlers do not respond to a synthetic DOM click.
        if (tv) {
            web.addJavascriptInterface(new PointerBridge(), "__anystreamPointerBridge");
            web.addJavascriptInterface(new KeyboardBridge(), "__anystreamKeyboardBridge");
            web.addJavascriptInterface(new ChromeBridge(), "__anystreamChromeBridge");
            int focusBg = R.drawable.tv_chrome_focus;
            backBtn.setBackgroundResource(focusBg);
            forwardBtn.setBackgroundResource(focusBg);
            reloadBtn.setBackgroundResource(focusBg);
            findViewById(R.id.exitBtn).setBackgroundResource(focusBg);
        }

        // Same persistent cookie jar as the library, so sign-ins stick between
        // launches until the user clears them in Settings.
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.setBackgroundColor(0xFF000000);
        if (tv) {
            web.setFocusable(true);
            web.setFocusableInTouchMode(true);
        }
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String target) {
                // Keep http(s) in-app; hand anything else back to the system.
                return !(target != null && (target.startsWith("http://") || target.startsWith("https://")));
            }

            @Override
            public void onPageFinished(WebView view, String target) {
                chromeFocused = false;
                updateNav();
                if (tv) {
                    view.requestFocus();
                    installSiteDpad(view);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (progress == null) return;
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customCallback = callback;
                view.setBackgroundColor(0xFF000000);
                stage.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                applyImmersive(true);
            }

            @Override
            public void onHideCustomView() {
                exitCustomView();
            }
        });

        findViewById(R.id.exitBtn).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { finish(); }
        });
        reloadBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                leaveChrome(false);
                web.reload();
            }
        });
        backBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                leaveChrome(false);
                handleSiteBack();
            }
        });
        forwardBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                leaveChrome(false);
                if (web.canGoForward()) web.goForward();
            }
        });

        updateNav();
        if (url != null) web.loadUrl(url);
        if (tv) web.requestFocus();
    }

    /**
     * A site is an ordinary desktop web page, so its own focus ring and
     * keyboard handling often cannot be reached with a TV remote. Install a
     * small navigation layer after every page load; it moves focus between
     * visible links/buttons, activates the highlighted item on OK/Enter, and
     * scrolls when there is no focusable item in that direction.
     */
    private void installSiteDpad(WebView view) {
        String script = siteDpadScript();
        if (script.length() == 0) return;
        String mode = "pointer".equals(siteNavMode) ? "pointer" : "dpad";
        view.evaluateJavascript(
                "window.__anystreamSiteNavMode = \"" + mode + "\";" +
                "window.__anystreamSiteNativeKeys = true;\n" + script +
                "\nif (window.__anystreamSiteSetMode) window.__anystreamSiteSetMode(\"" + mode + "\");",
                null);
    }

    private String siteDpadScript() {
        if (siteDpadScript != null) return siteDpadScript;
        try (InputStream input = getAssets().open("site-dpad.js")) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            siteDpadScript = new String(output.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            siteDpadScript = "";
        }
        return siteDpadScript;
    }

    /** Coordinates arrive normalized so WebView zoom and toolbar layout do not
     * change which point on the page receives the tap. */
    private final class PointerBridge {
        @JavascriptInterface
        public void clickAt(float xRatio, float yRatio) {
            if (web == null) return;
            final int width = web.getWidth();
            final int height = web.getHeight();
            if (width <= 0 || height <= 0) return;
            final float x = Math.max(1f, Math.min(width - 2, xRatio * width));
            final float y = Math.max(1f, Math.min(height - 2, yRatio * height));
            web.post(new Runnable() {
                @Override public void run() {
                    long down = SystemClock.uptimeMillis();
                    MotionEvent press = MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0);
                    web.dispatchTouchEvent(press);
                    press.recycle();
                    long up = SystemClock.uptimeMillis();
                    MotionEvent release = MotionEvent.obtain(down, up, MotionEvent.ACTION_UP, x, y, 0);
                    web.dispatchTouchEvent(release);
                    release.recycle();
                }
            });
        }
    }

    /** Called by the site controller when an HTML input is opened with OK. */
    private final class KeyboardBridge {
        @JavascriptInterface
        public void show() {
            if (web == null) return;
            web.postDelayed(new Runnable() {
                @Override public void run() {
                    if (web == null) return;
                    InputMethodManager input =
                            (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                    if (input != null) {
                        // The HTML input already has focus. Do not call
                        // requestFocus here: it can blur the editor and close
                        // the keyboard immediately.
                        input.showSoftInput(web, InputMethodManager.SHOW_FORCED);
                    }
                }
            }, 80);
        }
    }

    /** The page can hand focus to the native site toolbar with Up at the top. */
    private final class ChromeBridge {
        @JavascriptInterface
        public boolean available() {
            return !chromeHidden && customView == null;
        }

        @JavascriptInterface
        public void focus() {
            runOnUiThread(new Runnable() {
                @Override public void run() { focusChromeNative(); }
            });
        }
    }

    private void focusChromeNative() {
        if (!tv || chromeHidden || customView != null || chrome == null) return;
        chromeFocused = true;
        View target = backBtn != null && backBtn.isEnabled() ? backBtn : reloadBtn;
        if (target != null) target.requestFocus();
        setPageRing(false);
    }

    private void leaveChrome(boolean moveDown) {
        chromeFocused = false;
        if (web == null) return;
        web.requestFocus();
        setPageRing(true);
        if (moveDown) sendSiteKey("down");
    }

    private void setPageRing(boolean show) {
        if (web == null) return;
        web.evaluateJavascript(
                "window.__anystreamSiteRing && window.__anystreamSiteRing(" + show + ")", null);
    }

    /** Ask the page to close its dialog first, then fall back to history. */
    private void handleSiteBack() {
        if (web == null) {
            finish();
            return;
        }
        web.evaluateJavascript(
                "window.__anystreamSiteBack ? window.__anystreamSiteBack() : false",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String handled) {
                        if ("true".equals(handled)) return;
                        if (web != null && web.canGoBack()) {
                            web.goBack();
                            updateNav();
                        } else {
                            finish();
                        }
                    }
                });
    }

    private boolean isKeyboardVisible() {
        if (web == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowInsets insets = web.getRootWindowInsets();
                if (insets != null && insets.isVisible(WindowInsets.Type.ime())) return true;
            }
            Rect visible = new Rect();
            web.getWindowVisibleDisplayFrame(visible);
            int screenHeight = web.getRootView().getHeight();
            return screenHeight > 0 && screenHeight - visible.bottom > screenHeight * 0.15;
        } catch (Throwable err) {
            return false;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (!tv || customView != null) return super.dispatchKeyEvent(event);
        // The on-screen keyboard needs the D-pad and OK to choose letters.
        // Let the IME consume them instead of driving the site controller.
        if (isKeyboardVisible()) return super.dispatchKeyEvent(event);
        // Menu is a reliable path to the native site toolbar on remotes that
        // do not send an edge-up event at the top of the page.
        if (event.getKeyCode() == KeyEvent.KEYCODE_MENU) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                if (chromeFocused) leaveChrome(false);
                else focusChromeNative();
            }
            return true;
        }
        if (chromeFocused) {
            int code = event.getKeyCode();
            if (event.getAction() == KeyEvent.ACTION_DOWN &&
                    (code == KeyEvent.KEYCODE_DPAD_DOWN || code == KeyEvent.KEYCODE_DPAD_UP)) {
                leaveChrome(code == KeyEvent.KEYCODE_DPAD_DOWN);
                return true;
            }
            // Let Android move focus between the native toolbar buttons and
            // activate the focused one with OK.
            return super.dispatchKeyEvent(event);
        }
        String key = Tv.keyFor(event.getKeyCode());
        if (key == null) return super.dispatchKeyEvent(event);
        if ("select".equals(key)) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                sendSiteKey("select");
                return true;
            }
            return true;
        }
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            long now = SystemClock.uptimeMillis();
            boolean repeat = event.getRepeatCount() > 0;
            if (!repeat || event.getKeyCode() != lastDirectionCode || now - lastDirectionAt >= 85) {
                sendSiteKey(key);
                lastDirectionAt = now;
                lastDirectionCode = event.getKeyCode();
            }
        }
        return true;
    }

    private void sendSiteKey(String key) {
        if (web == null) return;
        web.evaluateJavascript(
                "window.__anystreamSiteKey && window.__anystreamSiteKey('" + key + "')", null);
    }

    private void updateNav() {
        boolean canBack = web.canGoBack();
        boolean canForward = web.canGoForward();
        backBtn.setEnabled(canBack);
        backBtn.setAlpha(canBack ? 1f : 0.35f);
        forwardBtn.setEnabled(canForward);
        forwardBtn.setAlpha(canForward ? 1f : 0.35f);
    }

    private void setChromeHidden(boolean hidden) {
        if (chrome == null || chromeHidden == hidden) return;
        chromeHidden = hidden;
        chrome.setVisibility(hidden ? View.GONE : View.VISIBLE);
        if (web != null) web.requestFocus();
    }

    private void applyImmersive(boolean on) {
        View chrome = findViewById(R.id.chrome);
        if (on) {
            chromeFocused = false;
            chrome.setVisibility(View.GONE);
            chromeHidden = true;
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        } else {
            chrome.setVisibility(View.VISIBLE);
            chromeHidden = false;
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    private void exitCustomView() {
        if (customView == null) return;
        stage.removeView(customView);
        customView = null;
        if (customCallback != null) customCallback.onCustomViewHidden();
        customCallback = null;
        applyImmersive(false);
        if (web != null) web.requestFocus();
    }

    private String hostOf(String url) {
        try {
            String host = Uri.parse(url).getHost();
            if (host == null) return "anystreamsite";
            return host.startsWith("www.") ? host.substring(4) : host;
        } catch (Throwable err) {
            return "anystreamsite";
        }
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            exitCustomView();
            return;
        }
        if (isKeyboardVisible()) {
            InputMethodManager input =
                    (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (input != null && web != null) {
                input.hideSoftInputFromWindow(web.getWindowToken(), 0);
            }
            return;
        }
        handleSiteBack();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
        try {
            CookieManager.getInstance().flush();
        } catch (Throwable ignored) {
            // Nothing to persist.
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        setChromeHidden(false);
        updateNav();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            stage.removeAllViews();
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
