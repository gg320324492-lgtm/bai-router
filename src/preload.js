const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("baiDesktop", {
  version: 5,
  quit: () => ipcRenderer.send("app-quit"),
  restartServer: () => ipcRenderer.invoke("server-restart"),
  deployLocal: () => ipcRenderer.invoke("deploy-local"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  switchInstalled: () => ipcRenderer.invoke("switch-installed"),
  appVersion: () => ipcRenderer.invoke("app-version"),
  diagInfo: () => ipcRenderer.invoke("diag-info"),
  diagRetry: () => ipcRenderer.invoke("diag-retry"),
  trustCert: () => ipcRenderer.invoke("trust-cert"),
  openLog: (p) => ipcRenderer.invoke("open-log", p),
  onAppEvent: (cb) => ipcRenderer.on("app-event", (_e, payload) => cb(payload)),
  // v1.0.34：自绘标题栏的窗口控制（浏览器直开面板时为 undefined，页面自动退回无按钮）
  winMinimize: () => ipcRenderer.invoke("win-minimize"),
  winToggleMaximize: () => ipcRenderer.invoke("win-toggle-maximize"),
  winClose: () => ipcRenderer.invoke("win-close"),
  onWindowState: (cb) => ipcRenderer.on("win-state", (_e, s) => cb(s)),
});
