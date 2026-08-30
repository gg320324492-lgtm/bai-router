const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("baiDesktop", {
  version: 2,
  quit: () => ipcRenderer.send("app-quit"),
  restartServer: () => ipcRenderer.invoke("server-restart"),
  deployLocal: () => ipcRenderer.invoke("deploy-local"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  appVersion: () => ipcRenderer.invoke("app-version"),
});
