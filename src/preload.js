const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("baiDesktop", {
  version: 4,
  quit: () => ipcRenderer.send("app-quit"),
  restartServer: () => ipcRenderer.invoke("server-restart"),
  deployLocal: () => ipcRenderer.invoke("deploy-local"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  appVersion: () => ipcRenderer.invoke("app-version"),
  diagInfo: () => ipcRenderer.invoke("diag-info"),
  diagRetry: () => ipcRenderer.invoke("diag-retry"),
  openLog: (p) => ipcRenderer.invoke("open-log", p),
  onAppEvent: (cb) => ipcRenderer.on("app-event", (_e, payload) => cb(payload)),
});
