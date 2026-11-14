// Exposes a tiny, explicit bridge to the library UI. No Node access leaks
// into the renderer — only these calls plus two listeners.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("anystreamElectron", {
  isElectron: true,
  openSite: function (url) { return ipcRenderer.invoke("site:open", url); },
  closeSite: function () { return ipcRenderer.invoke("site:close"); },
  reloadSite: function () { return ipcRenderer.invoke("site:reload"); },
  goBack: function () { return ipcRenderer.invoke("site:back"); },
  goForward: function () { return ipcRenderer.invoke("site:forward"); },
  setChromeHidden: function (hidden) { return ipcRenderer.invoke("site:chrome", !!hidden); },
  setDownloadsPanel: function (open, height) { return ipcRenderer.invoke("site:downloads-panel", !!open, height); },
  getDownloads: function () { return ipcRenderer.invoke("downloads:get"); },
  startDownload: function (id, qualityId) { return ipcRenderer.invoke("downloads:start", id, qualityId); },
  cancelDownload: function (id) { return ipcRenderer.invoke("downloads:cancel", id); },
  showDownload: function (id) { return ipcRenderer.invoke("downloads:show", id); },
  openDownloadsFolder: function () { return ipcRenderer.invoke("downloads:open-folder"); },
  clearDetectedDownloads: function () { return ipcRenderer.invoke("downloads:clear-media"); },
  clearFinishedDownloads: function () { return ipcRenderer.invoke("downloads:clear-finished"); },
  clearCache: function () { return ipcRenderer.invoke("data:clear-cache"); },
  clearCookies: function () { return ipcRenderer.invoke("data:clear-cookies"); },
  onSiteState: function (callback) {
    ipcRenderer.on("site:state", function (_event, state) { callback(state); });
  },
  onSiteClosed: function (callback) {
    ipcRenderer.on("site:closed", function () { callback(); });
  },
  onDownloadsState: function (callback) {
    ipcRenderer.on("downloads:state", function (_event, state) { callback(state); });
  }
});
