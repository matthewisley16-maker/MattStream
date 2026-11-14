'use strict';

// MattStream desktop app: the media server runs inside this process and the
// window loads it directly - no browser, no address bar, no console window.
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, Menu, dialog, shell, ipcMain, Tray, clipboard } = require('electron');

const APP_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = 8096;

app.setName('MattStream');
app.setAppUserModelId('com.mattstream.app');

let mainWindow = null;
let serverPort = DEFAULT_PORT;
let tray = null;
let isQuitting = false;
let hidOnce = false;

// Started by Windows at login, so it should not steal the screen.
const START_HIDDEN = process.argv.includes('--background');
const WATCHDOG_NAME = 'MattStream-watchdog.vbs';

/* ---------------- staying up ---------------- */

function pauseFile() {
  const dir = app.isPackaged ? app.getPath('userData') : path.join(APP_ROOT, '.tools');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    /* best effort */
  }
  return path.join(dir, 'watchdog-paused');
}

function startupFolder() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function watchdogShimPath() {
  return path.join(startupFolder(), WATCHDOG_NAME);
}

// The loop lives in PowerShell, which can catch a failed request cleanly.
function watchdogScriptPath() {
  const dir = app.isPackaged ? path.join(app.getPath('userData'), 'watchdog') : path.join(APP_ROOT, '.tools');
  return path.join(dir, 'watchdog.ps1');
}

function watchdogInstalled() {
  try {
    return fs.existsSync(watchdogShimPath());
  } catch (err) {
    return false;
  }
}

function psString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function watchdogScript() {
  const launchArgs = app.isPackaged ? "@('--background')" : "@($root, '--background')";
  return [
    '# MattStream - keeps the server up, and keeps the public link fresh.',
    '# Written by MattStream itself; remove the Startup shortcut to stop it.',
    '$root = ' + psString(APP_ROOT),
    '$exe = ' + psString(process.execPath),
    '$pause = ' + psString(pauseFile()),
    "$url = 'http://127.0.0.1:" + DEFAULT_PORT + "/api/status'",
    "$tunnel = Join-Path $root '.tools\\cloudflared.exe'",
    "$tunnelLog = Join-Path $root '.tools\\tunnel.log'",
    '$linkFile = Join-Path ([Environment]::GetFolderPath("Desktop")) "MattStream on my phone.url"',
    '$published = Join-Path $root ".tools\\public-url.txt"',
    'while ($true) {',
    '  if (-not (Test-Path -LiteralPath $pause)) {',
    '    $alive = $false',
    '    try {',
    '      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri $url',
    '      if ($response.StatusCode -eq 200) { $alive = $true }',
    '    } catch { $alive = $false }',
    '    if (-not $alive) {',
    '      Start-Process -FilePath $exe -ArgumentList ' + launchArgs + ' -WorkingDirectory $root -WindowStyle Hidden',
    '    }',
    '    if (Test-Path -LiteralPath $tunnel) {',
    '      if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {',
    '        Start-Process -FilePath $tunnel -ArgumentList @("tunnel", "--url", $url.Replace("/api/status", ""), "--no-autoupdate", "--logfile", $tunnelLog) -WindowStyle Hidden',
    '        Start-Sleep -Seconds 8',
    '      }',
    '      if (Test-Path -LiteralPath $tunnelLog) {',
    '        $match = Select-String -Path $tunnelLog -Pattern "https://[a-z0-9-]+\\.trycloudflare\\.com" -AllMatches | Select-Object -Last 1',
    '        if ($match) {',
    '          $link = ([string]$match.Matches[0].Value).Trim().Replace([char]13, "").Replace([char]10, "")',
    '          $known = ""',
    '          if (Test-Path -LiteralPath $published) { $known = (Get-Content -LiteralPath $published -Raw).Trim() }',
    '          if ($link -ne $known) {',
    '            Set-Content -LiteralPath $published -Value $link -NoNewline',
    '            [System.IO.File]::WriteAllText($linkFile, "[InternetShortcut]" + [char]13 + [char]10 + "URL=" + $link + [char]13 + [char]10)',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '  Start-Sleep -Seconds 10',
    '}',
    '',
  ].join(String.fromCharCode(13, 10));
}

// A one-line hidden launcher, so Windows runs the watchdog without a console.
function watchdogShim() {
  return (
    'Set sh = CreateObject("WScript.Shell")\r\n' +
    'sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' +
    watchdogScriptPath() +
    '""", 0, False\r\n'
  );
}

function setWatchdog(on) {
  try {
    const script = watchdogScriptPath();
    if (on) {
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.mkdirSync(startupFolder(), { recursive: true });
      fs.writeFileSync(script, watchdogScript(), 'utf8');
      fs.writeFileSync(watchdogShimPath(), watchdogShim(), 'utf8');
    } else {
      fs.rmSync(watchdogShimPath(), { force: true });
      fs.rmSync(script, { force: true });
    }
    return true;
  } catch (err) {
    console.error('[mattstream] watchdog change failed: ' + err.message);
    return false;
  }
}

function autostartEnabled() {
  try {
    return Boolean(app.getLoginItemSettings().openAtLogin);
  } catch (err) {
    return false;
  }
}

function setAutostart(on) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(on),
      path: process.execPath,
      args: app.isPackaged ? ['--background'] : [APP_ROOT, '--background'],
    });
    return true;
  } catch (err) {
    console.error('[mattstream] login item change failed: ' + err.message);
    return false;
  }
}

function lanAddress() {
  const addresses = [];
  for (const details of Object.values(os.networkInterfaces())) {
    for (const entry of details || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  const preferred = addresses.find((address) => address.startsWith('192.168.')) || addresses[0];
  return preferred ? 'http://' + preferred + ':' + serverPort : 'http://localhost:' + serverPort;
}

function quitApp() {
  isQuitting = true;
  try {
    fs.writeFileSync(pauseFile(), 'quit from the tray');
  } catch (err) {
    /* the watchdog may restart it once; nothing else to do */
  }
  app.quit();
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(path.join(APP_ROOT, 'icon.ico'));
  } catch (err) {
    console.error('[mattstream] no tray icon: ' + err.message);
    return;
  }
  const refresh = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open MattStream', click: showWindow },
        { label: 'Copy network address (' + lanAddress() + ')', click: () => clipboard.writeText(lanAddress()) },
        { type: 'separator' },
        {
          label: 'Start with Windows',
          type: 'checkbox',
          checked: autostartEnabled(),
          click: (item) => setAutostart(item.checked),
        },
        {
          label: 'Restart it if it ever stops',
          type: 'checkbox',
          checked: watchdogInstalled(),
          click: (item) => setWatchdog(item.checked),
        },
        { type: 'separator' },
        { label: 'Quit MattStream', click: quitApp },
      ])
    );
  };
  tray.setToolTip('MattStream - your library is being served');
  tray.on('click', showWindow);
  tray.on('right-click', refresh);
  refresh();
}

// If the server is already up (started from a terminal, or a stale instance),
// reuse it instead of fighting over the port.
function probeServer(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get(
      { host: '127.0.0.1', port, path: '/api/status', timeout: 1200 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          if (body.length < 4000) body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            finish(Boolean(parsed && parsed.version) ? port : null);
          } catch (err) {
            finish(null);
          }
        });
      }
    );
    request.on('timeout', () => {
      request.destroy();
      finish(null);
    });
    request.on('error', () => finish(null));
  });
}

// The page asks for these when you add videos, so picking files happens in the
// real operating-system dialog instead of clicking through folders inside the app.
const VIDEO_PICKER_FILTERS = [
  {
    name: 'Video files',
    extensions: ['mp4', 'mkv', 'avi', 'mov', 'm4v', 'webm', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', 'ogv', '3gp'],
  },
  { name: 'All files', extensions: ['*'] },
];

async function showPicker(options) {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result && !result.canceled ? result.filePaths || [] : [];
}

function registerPickerHandlers() {
  ipcMain.handle('mattstream:pick-folder', () =>
    showPicker({
      title: 'Choose a folder of videos',
      buttonLabel: 'Add this folder',
      properties: ['openDirectory', 'createDirectory'],
    })
  );
  ipcMain.handle('mattstream:pick-video-files', () =>
    showPicker({
      title: 'Choose video files',
      buttonLabel: 'Add these videos',
      properties: ['openFile', 'multiSelections'],
      filters: VIDEO_PICKER_FILTERS,
    })
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#07070b',
    title: 'MattStream',
    icon: path.join(APP_ROOT, 'icon.ico'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadURL('http://127.0.0.1:' + serverPort + '/');
  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN) mainWindow.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Closing the window only hides it: the library keeps serving to phones and
  // TVs until you pick Quit from the tray.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (!hidOnce) {
      hidOnce = true;
      tray && tray.displayBalloon
        ? tray.displayBalloon({
            title: 'MattStream is still running',
            content: 'Your library keeps serving. Use the tray icon to open it again, or Quit.',
          })
        : null;
    }
  });

  // Nothing in the app should navigate away; send real links to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:' + serverPort)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

async function boot() {
  Menu.setApplicationMenu(null);
  registerPickerHandlers();

  // Coming back up means the previous quit is over.
  try {
    fs.rmSync(pauseFile(), { force: true });
  } catch (err) {
    /* nothing to clear */
  }

  if (process.argv.includes('--enable-always-on')) {
    setAutostart(true);
    setWatchdog(true);
  }
  if (process.argv.includes('--disable-always-on')) {
    setAutostart(false);
    setWatchdog(false);
  }

  // Installed copies live in Program Files, so the library, the index and the
  // generated artwork go to the user's own AppData folder instead.
  if (app.isPackaged) {
    process.env.MATTSTREAM_DATA = path.join(app.getPath('userData'), 'data');
  }

  const already = await probeServer(DEFAULT_PORT);
  if (already) {
    serverPort = already;
  } else {
    try {
      const backend = require(path.join(APP_ROOT, 'server', 'index.js'));
      const started = await backend.start();
      serverPort = started.port;
    } catch (err) {
      dialog.showErrorBox('MattStream could not start', String(err && err.message ? err.message : err));
      app.quit();
      return;
    }
  }

  createWindow();
  createTray();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Launching it again while it lives in the tray brings the window back.
  app.on('second-instance', () => showWindow());

  app.whenReady().then(boot);

  app.on('activate', () => showWindow());

  // No window left means "in the tray", not "stop serving".
  app.on('window-all-closed', () => {
    if (isQuitting) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    try {
      require(path.join(APP_ROOT, 'server', 'index.js')).stop();
    } catch (err) {
      /* shutting down anyway */
    }
  });
}
