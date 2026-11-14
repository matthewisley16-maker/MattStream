'use strict';

// MattStream desktop app: the media server runs inside this process and the
// window loads it directly - no browser, no address bar, no console window.
const path = require('path');
const http = require('http');
const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');

const APP_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = 8096;

app.setName('MattStream');
app.setAppUserModelId('com.mattstream.app');

let mainWindow = null;
let serverPort = DEFAULT_PORT;

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
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
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
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    try {
      require(path.join(APP_ROOT, 'server', 'index.js')).stop();
    } catch (err) {
      /* shutting down anyway */
    }
  });
}
