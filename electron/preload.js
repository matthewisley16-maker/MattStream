'use strict';

// Bridge between the page and the desktop shell. The only thing the page can
// do here is ask Windows/macOS/Linux to show a real "open" dialog, because a
// file browser built inside the app is far worse at picking files than the one
// the operating system already has.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mattstreamDesktop', {
  isDesktop: true,
  // Returns [] when the dialog is cancelled, otherwise absolute paths.
  pickFolder: () => ipcRenderer.invoke('mattstream:pick-folder'),
  pickVideoFiles: () => ipcRenderer.invoke('mattstream:pick-video-files'),
  // Called when the window is closed to the tray.
  onHidden: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('mattstream:hidden', () => callback());
  },
});
