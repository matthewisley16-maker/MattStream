package com.mattstream.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * MattStream for Android phones and Android TV.
 *
 * The desktop app does the hosting, so this is the client: it asks once for the
 * address the desktop shows, remembers it, and runs the shelf in a WebView with
 * D-pad support, fullscreen video and the hardware Back button wired up.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "mattstream";
    private static final String KEY_SERVER = "server";
    private static final String KEY_SERVERS = "servers";
    private static final int DEFAULT_PORT = 8096;
    private static final int MAX_SERVERS = 8;

    // No address is built in. The app asks the network it is on which machine
    // is running MattStream, so a new DHCP lease or a different Wi-Fi cannot
    // leave it pointing at somewhere that no longer exists.
    private static final int SCAN_THREADS = 48;
    private static final int SCAN_TIMEOUT_MS = 700;

    private FrameLayout root;
    private TvWebView web;
    private View setupView;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private String serverUrl;
    private boolean searchedOnce = false;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#07070B"));
        setContentView(root);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverUrl = prefs.getString(KEY_SERVER, "");
        if (serverUrl == null) serverUrl = "";
        // Open straight into the library. The picker is still one key away, and
        // appears by itself when this address stops answering.
        if (serverUrl.isEmpty()) {
            startServerSearch("Looking for MattStream on this network...");
        } else {
            loadServer(serverUrl);
        }
    }

    /* ---------------- saved servers ---------------- */

    private java.util.List<String> savedServers() {
        java.util.List<String> list = new java.util.ArrayList<>();
        String raw = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVERS, "");
        if (raw == null) return list;
        for (String line : raw.split("\n")) {
            String value = line.trim();
            if (!value.isEmpty() && !list.contains(value)) list.add(value);
        }
        return list;
    }

    private void rememberServer(String url) {
        java.util.List<String> list = savedServers();
        list.remove(url);
        list.add(0, url);
        while (list.size() > MAX_SERVERS) list.remove(list.size() - 1);
        StringBuilder raw = new StringBuilder();
        for (String entry : list) {
            if (raw.length() > 0) raw.append('\n');
            raw.append(entry);
        }
        getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putString(KEY_SERVERS, raw.toString())
                .putString(KEY_SERVER, url)
                .apply();
    }

    private int dp(float value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    /* ---------------- finding the server ---------------- */

    // A MattStream server answers /api/status with JSON that names this
    // machine. Nothing else on the network does, so that is the check.
    private static String probe(String address) {
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL url = new java.net.URL("http://" + address + ":8096/api/status");
            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(SCAN_TIMEOUT_MS);
            conn.setReadTimeout(SCAN_TIMEOUT_MS);
            conn.setUseCaches(false);
            if (conn.getResponseCode() != 200) return null;
            java.io.InputStream in = conn.getInputStream();
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[2048];
            int read;
            while ((read = in.read(buffer)) > 0 && out.size() < 8192) out.write(buffer, 0, read);
            in.close();
            String body = out.toString("UTF-8");
            if (body.contains("\"serverName\"") && body.contains("\"port\"")) {
                return "http://" + address + ":8096";
            }
        } catch (Exception err) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
        return null;
    }

    // Every usable address in this device's own subnet. It only uses the port
    // the server already has open, so no firewall or network change is needed.
    private java.util.List<String> subnetAddresses() {
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        try {
            for (java.net.NetworkInterface nif
                    : java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (java.net.InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    java.net.InetAddress addr = ia.getAddress();
                    if (addr == null || addr.getAddress().length != 4) continue;
                    int prefix = ia.getNetworkPrefixLength();
                    if (prefix < 16 || prefix > 30) continue;
                    byte[] raw = addr.getAddress();
                    int ip = ((raw[0] & 255) << 24) | ((raw[1] & 255) << 16) | ((raw[2] & 255) << 8) | (raw[3] & 255);
                    int mask = 0xFFFFFFFF << (32 - prefix);
                    int network = ip & mask;
                    int size = 1 << (32 - prefix);
                    if (size > 1024) size = 1024;
                    for (int i = 1; i < size - 1; i++) {
                        int value = network + i;
                        out.add(((value >>> 24) & 255) + "." + ((value >>> 16) & 255) + "."
                                + ((value >>> 8) & 255) + "." + (value & 255));
                    }
                }
            }
        } catch (Exception err) {
            // no usable address: the picker is all that is left
        }
        return new java.util.ArrayList<>(out);
    }

    private String findServer() {
        java.util.List<String> addresses = subnetAddresses();
        final java.util.concurrent.atomic.AtomicReference<String> found =
                new java.util.concurrent.atomic.AtomicReference<>();
        final java.util.concurrent.CountDownLatch done =
                new java.util.concurrent.CountDownLatch(addresses.size());
        java.util.concurrent.ExecutorService pool =
                java.util.concurrent.Executors.newFixedThreadPool(SCAN_THREADS);
        for (final String address : addresses) {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (found.get() == null) {
                            String url = probe(address);
                            if (url != null) found.compareAndSet(null, url);
                        }
                    } finally {
                        done.countDown();
                    }
                }
            });
        }
        try {
            done.await(5, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
        }
        pool.shutdownNow();
        return found.get();
    }

    private void startServerSearch(final String message) {
        showSetup(message);
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String found = findServer();
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (found != null) {
                            serverUrl = found;
                            rememberServer(found);
                            loadServer(found);
                        } else {
                            showSetup("No MattStream server answered on this network.\n\nStart MattStream on "
                                    + "the computer that holds your media, make sure both devices are on the same "
                                    + "Wi-Fi, and allow it through Windows Firewall. You can also type its address "
                                    + "below.");
                        }
                    }
                });
            }
        }).start();
    }

    /* ---------------- setup screen ---------------- */

    private void showSetup(String message) {
        removeWeb();
        if (setupView != null) {
            root.removeView(setupView);
            setupView = null;
        }
        final java.util.List<String> known = savedServers();

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_VERTICAL);
        column.setPadding(dp(40), dp(32), dp(40), dp(32));
        column.setBackgroundColor(Color.parseColor("#07070B"));

        TextView title = new TextView(this);
        title.setText("MattStream");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 34);
        column.addView(title);

        TextView hint = new TextView(this);
        hint.setText(message);
        hint.setTextColor(Color.parseColor("#B9BCC8"));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        hint.setPadding(0, dp(10), 0, dp(12));
        column.addView(hint);

        // Every server this device has used, newest first, always listed.
        for (String address : known) {
            Button saved = new Button(this);
            String label = address.equals(serverUrl) ? address + "  (last used)" : address;
            saved.setText(label);
            saved.setAllCaps(false);
            saved.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
            saved.setGravity(Gravity.CENTER_VERTICAL);
            saved.setPadding(dp(18), dp(4), dp(18), dp(4));
            saved.setBackgroundColor(Color.parseColor("#15161E"));
            saved.setTextColor(Color.WHITE);
            final String pick = address;
            saved.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View view) {
                    serverUrl = pick;
                    rememberServer(pick);
                    loadServer(pick);
                }
            });
            LinearLayout.LayoutParams savedParams = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            savedParams.bottomMargin = dp(6);
            column.addView(saved, savedParams);
        }

        if (!known.isEmpty()) {
            TextView addTitle = new TextView(this);
            addTitle.setText("Add another server");
            addTitle.setTextColor(Color.parseColor("#B9BCC8"));
            addTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            addTitle.setPadding(0, dp(14), 0, dp(6));
            column.addView(addTitle);
        }

        final EditText input = new EditText(this);
        input.setHint("address the desktop app shows");
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setTextColor(Color.WHITE);
        input.setHintTextColor(Color.parseColor("#6E7280"));
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        if (!serverUrl.isEmpty()) input.setText(serverUrl);
        else input.setText("");
        column.addView(input, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button connect = new Button(this);
        connect.setText("Connect");
        connect.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        buttonParams.topMargin = dp(20);
        column.addView(connect, buttonParams);

        View.OnClickListener submit = new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                String value = normalize(input.getText().toString());
                if (value.isEmpty()) return;
                serverUrl = value;
                rememberServer(value);
                loadServer(value);
            }
        };
        connect.setOnClickListener(submit);
        input.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override
            public boolean onEditorAction(TextView view, int actionId, android.view.KeyEvent event) {
                submit.onClick(view);
                return true;
            }
        });

        setupView = column;
        root.addView(column, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        input.requestFocus();
        input.post(new Runnable() {
            @Override
            public void run() {
                input.setSelection(input.getText().length());
            }
        });
    }

    /** Accepts "192.168.1.24", "192.168.1.24:8096" or a full URL. */
    private static String normalize(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return "";
        if (!value.startsWith("http://") && !value.startsWith("https://")) value = "http://" + value;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        String afterScheme = value.substring(value.indexOf("//") + 2);
        if (!afterScheme.contains(":")) value = value + ":" + DEFAULT_PORT;
        return value;
    }

    /* ---------------- the shelf ---------------- */

    private void removeWeb() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
    }

    private void loadServer(String url) {
        final String target = normalize(url);
        if (target.isEmpty()) return;
        removeWeb();
        if (setupView != null) {
            root.removeView(setupView);
            setupView = null;
        }

        TvWebView view = new TvWebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setAllowFileAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " MattStreamApp/1.1");

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String link) {
                return !(link.startsWith("http://") || link.startsWith("https://"));
            }

            @Override
            public void onReceivedError(WebView v, int code, String description, String failingUrl) {
                if (failingUrl == null) return;
                if (!failingUrl.startsWith(target)) return;
                // A saved address can be an IP the router has since handed to
                // something else. Look for the server on this network once
                // before asking the viewer to type anything.
                if (!searchedOnce) {
                    searchedOnce = true;
                    startServerSearch("That address stopped answering. Looking for MattStream on this network...");
                    return;
                }
                showSetup("Could not reach " + target + ".\n\nStart MattStream on the desktop, make sure both "
                        + "devices are on the same Wi-Fi, and allow it through Windows Firewall.");
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View v, CustomViewCallback callback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreenView = v;
                fullscreenCallback = callback;
                root.addView(v, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                applyImmersive(true);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });

        web = view;
        root.addView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // Tell the server which device this is, so the cast list on the desktop
        // shows the TV's own name instead of a generic "Phone".
        String deviceName = Build.MODEL == null ? "" : Build.MODEL.trim();
        if (deviceName.isEmpty()) deviceName = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String open = target + "/";
        if (!deviceName.isEmpty()) open += "?name=" + Uri.encode(deviceName);
        view.loadUrl(open);
        view.requestFocus();
    }

    private void exitFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        applyImmersive(false);
        if (fullscreenCallback != null) {
            fullscreenCallback.onCustomViewHidden();
            fullscreenCallback = null;
        }
        if (web != null) web.requestFocus();
    }

    private void applyImmersive(boolean on) {
        View decor = getWindow().getDecorView();
        if (on) {
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        } else {
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    /** Menu (or Settings) on a TV remote opens the server picker from anywhere. */
    @Override
    public boolean onKeyDown(int keyCode, android.view.KeyEvent event) {
        if (web != null && (keyCode == android.view.KeyEvent.KEYCODE_MENU
                || keyCode == android.view.KeyEvent.KEYCODE_SETTINGS)) {
            showSetup("Choose the server to open.");
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (fullscreenView != null) {
            if (web != null) {
                web.evaluateJavascript("(function(){var v=document.querySelector('video');"
                        + "if(document.exitFullscreen){document.exitFullscreen().catch(function(){});}"
                        + "else if(v&&v.webkitExitFullscreen){v.webkitExitFullscreen();}})()", null);
            }
            return;
        }
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        removeWeb();
        super.onDestroy();
    }
}
