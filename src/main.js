const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

// ---------- 路径布局 ----------
// 打包后：主程序 resources/app；后端在 resources/server（extraResources，升级会被替换）
//       用户数据（config.json/backups/server.log）在 %APPDATA%\bai-router —— 升级不会覆盖
const APP_DIR = __dirname;
const SERVER_JS = app.isPackaged
  ? path.join(process.resourcesPath, "server", "server.mjs")
  : path.join(APP_DIR, "server", "server.mjs");
const DATA_DIR = app.getPath("userData");
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.join(APP_DIR, "..", "build", "icon.ico");

let win = null;
let tray = null;
let child = null;
let quitting = false;
let panelPort = 15723;
let relayPort = 15722;
let updateState = null; // {version, downloaded}

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { }
try {
  const c = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8"));
  panelPort = c.panelPort || panelPort;
  relayPort = c.relayPort || relayPort;
} catch {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(path.dirname(SERVER_JS), "config.defaults.json"), "utf8"));
    panelPort = c.panelPort || panelPort;
    relayPort = c.relayPort || relayPort;
  } catch { }
}

const PANEL = `http://127.0.0.1:${panelPort}`;
const startMin = process.argv.includes("--min");

// ---------- 单实例 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  main().catch((e) => { dialog.showErrorBox("B.AI 路由台启动失败", String((e && e.stack) || e)); app.quit(); });
}

async function main() {
  await app.whenReady();
  app.setAppUserModelId("local.bai.router");
  await ensureServer();
  createTray();
  setupUpdater();
  maybeFirstRunDeploy();
  if (!startMin) showWindow();
}

// ---------- 服务生命周期 ----------
async function ping() {
  try {
    const r = await fetch(PANEL + "/api/ping", { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}
async function getStatus() {
  try {
    const r = await fetch(PANEL + "/api/status", { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch { return null; }
}

function findSystemNode() {
  const candidates = ["C:\\Program Files\\nodejs\\node.exe"];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH || "").split(";")) {
    try { if (fs.existsSync(path.join(dir.trim(), "node.exe"))) return path.join(dir.trim(), "node.exe"); } catch { }
  }
  return null;
}

function spawnServer() {
  const cfg = readCfgSafe();
  const node = findSystemNode();
  const env = {
    ...process.env,
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: cfg.proxy || "http://127.0.0.1:7890",
    HTTP_PROXY: cfg.proxy || "http://127.0.0.1:7890",
    NO_PROXY: "127.0.0.1,localhost",
    BAI_ROUTER_EXE: process.execPath,
    BAI_DATA_DIR: DATA_DIR,
    APP_VERSION: app.getVersion(),
  };
  if (node) child = spawn(node, [SERVER_JS], { cwd: path.dirname(SERVER_JS), env, stdio: "ignore" });
  else { env.ELECTRON_RUN_AS_NODE = "1"; child = spawn(process.execPath, [SERVER_JS], { cwd: path.dirname(SERVER_JS), env, stdio: "ignore" }); }
  child.on("exit", () => {
    child = null;
    if (quitting) return;
    setTimeout(() => { if (!quitting && !child) respawnWithNotice(); }, 500);
  });
}

async function respawnWithNotice() {
  spawnServer();
  await waitReady(20000);
  if (tray) tray.displayBalloon({ title: "B.AI 路由台", content: "服务已自动恢复运行" });
}

async function waitReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function ensureServer() {
  const st = await getStatus();
  if (st && st.service && st.service.up && st.service.pid && st.service.pid !== process.pid) {
    try { await new Promise((r) => execFile("taskkill", ["/F", "/PID", String(st.service.pid)], r)); } catch { }
    for (let i = 0; i < 20 && (await ping()); i++) await new Promise((r) => setTimeout(r, 300));
  }
  spawnServer();
  const ok = await waitReady(25000);
  if (!ok && tray) tray.displayBalloon({ title: "B.AI 路由台", content: "服务启动失败，请查看日志 " + path.join(DATA_DIR, "server.log"), iconType: "error" });
  return ok;
}

function readCfgSafe() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8")); } catch { return {}; }
}

async function restartServer() {
  quitting = true;
  try { if (child) await killTree(child.pid); } catch { }
  quitting = false;
  const st = await getStatus();
  if (st && st.service && st.service.pid) {
    try { await new Promise((r) => execFile("taskkill", ["/F", "/PID", String(st.service.pid)], r)); } catch { }
  }
  for (let i = 0; i < 20 && (await ping()); i++) await new Promise((r) => setTimeout(r, 300));
  spawnServer();
  const ok = await waitReady(25000);
  if (win) win.webContents.reload();
  return ok;
}

function killTree(pid) {
  return new Promise((r) => execFile("taskkill", ["/F", "/T", "/PID", String(pid)], () => r()));
}

// ---------- 窗口 ----------
function showWindow() {
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 940, height: 780, minWidth: 720, minHeight: 560,
    title: "B.AI 路由台", backgroundColor: "#16171b", autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: { preload: path.join(APP_DIR, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(PANEL);
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

// ---------- 托盘 ----------
function createTray() {
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip("B.AI 路由台");
  const menu = Menu.buildFromTemplate([
    { label: "显示主界面", click: () => showWindow() },
    { label: "检查更新", click: () => manualCheckUpdate() },
    { label: "重启服务", click: async (item) => { item.enabled = false; await restartServer(); item.enabled = true; } },
    { type: "separator" },
    { label: "部署到本机（快捷方式/自启）…", click: () => deployLocal() },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.on("double-click", () => showWindow());
  tray.setContextMenu(menu);
}

async function deployLocal() {
  const { response } = await dialog.showMessageBox(win && win.isVisible() ? win : undefined, {
    type: "question", title: "部署到本机",
    message: "将创建桌面/开始菜单快捷方式，并注册开机自启（登录后台运行）。",
    detail: "· 快捷方式 → 本软件\n· 开机自启：当前用户启动文件夹（不写注册表）\n· 自动探测本机代理端口\n重复执行无害。",
    buttons: ["部署（含开机自启）", "只创建快捷方式", "取消"],
    defaultId: 0, cancelId: 2,
  });
  if (response === 2) return;
  await runDeploy(response === 0);
}

async function runDeploy(autostart) {
  const msgs = [];
  // ① 代理/Node 探测走面板 API（纯 curl/where，无风险）
  try {
    const r = await fetch(PANEL + "/api/deploy-local", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ shortcuts: false, autostart: false, probeProxy: true }),
    });
    const j = await r.json();
    msgs.push(...(j.messages || []));
  } catch (e) { msgs.push("探测失败：" + (e && e.message)); }
  // ② 快捷方式：Electron 原生 API（不经过 PowerShell，避免安全软件拦截）
  const lnkName = "B.AI 路由台.lnk";
  const targets = [
    path.join(app.getPath("desktop"), lnkName),
    path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", lnkName),
  ];
  let okCnt = 0;
  for (const t of targets) {
    try {
      if (shell.writeShortcutLink(path.dirname(t) + "\\" + lnkName, "update", {
        target: process.execPath, cwd: path.dirname(process.execPath),
        iconPath: iconPath, iconIndex: 0, description: "B.AI 模型路由台",
      })) okCnt++;
    } catch { }
  }
  msgs.push(`快捷方式：${okCnt ? "已更新（桌面/开始菜单）" : "创建失败，请从安装目录手动发送"}`);
  // ③ 开机自启：当前用户启动文件夹 VBS（不写注册表）
  const startup = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const vbs = path.join(startup, "bai-router.vbs");
  try {
    fs.mkdirSync(startup, { recursive: true });
    if (autostart) {
      fs.writeFileSync(vbs, `CreateObject("Wscript.Shell").Run """${process.execPath}"" --min", 0, False\r\n`);
      msgs.push("开机自启：已开启（登录后台运行，托盘常驻）");
    } else {
      if (fs.existsSync(vbs)) fs.writeFileSync(vbs, "' disabled by bai-router\r\n");
      msgs.push("开机自启：已关闭");
    }
  } catch (e) { msgs.push("自启写入失败：" + (e && e.message)); }
  // 部署后端口/代理可能变化 → 重启服务子进程让新代理生效
  restartServer().catch(() => { });
  return { ok: true, messages: msgs };
}

function maybeFirstRunDeploy() {
  const marker = path.join(DATA_DIR, ".deployed");
  if (fs.existsSync(marker)) return;
  dialog.showMessageBox(win && win.isVisible() ? win : undefined, {
    type: "question", title: "欢迎使用 B.AI 路由台",
    message: "首次运行：是否自动创建桌面快捷方式并开启开机自启？",
    detail: "推荐「一键部署」——之后开机自动在托盘常驻。也可以稍后从托盘菜单手动部署。",
    buttons: ["一键部署", "暂不"], defaultId: 0, cancelId: 1,
  }).then(async ({ response }) => {
    fs.writeFileSync(marker, new Date().toISOString());
    if (response === 0) {
      const j = await runDeploy(true);
      if (tray) tray.displayBalloon({ title: "部署完成", content: (j.messages || [j.error || "完成"]).join("\n") });
    }
  });
}

// ---------- 自动更新 ----------
let autoUpdater = null;
function setupUpdater() {
  if (!app.isPackaged) return; // 开发/绿色模式没有 app-update.yml，跳过
  try {
    const { autoUpdater: au } = require("electron-updater");
    autoUpdater = au;
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.on("checking-for-update", () => { updateState = { phase: "checking" }; syncTray(); });
    au.on("update-available", (info) => {
      updateState = { phase: "downloading", version: info.version };
      syncTray();
      if (tray) tray.displayBalloon({ title: "发现新版本 " + info.version, content: "正在后台下载更新…" });
    });
    au.on("update-not-available", () => { updateState = { phase: "latest" }; syncTray(); });
    au.on("download-progress", (p) => { updateState = updateState || {}; updateState.percent = Math.round(p.percent); syncTray(); });
    au.on("update-downloaded", (info) => {
      updateState = { phase: "ready", version: info.version };
      syncTray();
      dialog.showMessageBox({
        type: "info", title: "更新已就绪",
        message: `B.AI 路由台 ${info.version} 已下载完成`,
        detail: "重启应用后生效。现在重启吗？（中转会中断约 5 秒）",
        buttons: ["立即重启安装", "稍后（退出时自动装）"], defaultId: 0, cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) { quitting = true; setImmediate(() => au.quitAndInstall(false, true)); }
      });
    });
    au.on("error", (e) => {
      updateState = { phase: "error", msg: String((e && e.message) || e).slice(0, 120) };
      syncTray();
    });
    // 启动 8 秒后检查一次，之后每 12 小时一次
    setTimeout(() => au.checkForUpdates().catch(() => { }), 8000);
    setInterval(() => au.checkForUpdates().catch(() => { }), 12 * 3600 * 1000);
  } catch { autoUpdater = null; }
}

function syncTray() {
  if (!tray) return;
  const u = updateState;
  let tip = "B.AI 路由台";
  if (u && u.phase === "downloading") tip += ` · 下载新版 ${u.version || ""} ${u.percent || 0}%`;
  else if (u && u.phase === "ready") tip += ` · 新版 ${u.version} 待安装`;
  else if (u && u.phase === "error") tip += " · 更新失败（可重试检查更新）";
  tray.setToolTip(tip);
}

async function manualCheckUpdate() {
  if (!autoUpdater) {
    dialog.showMessageBox({ type: "info", title: "检查更新", message: "当前为绿色/开发模式，自动更新仅在安装版可用。" });
    return;
  }
  try {
    updateState = null;
    const r = await autoUpdater.checkForUpdates();
    if (!r || !r.updateInfo) return;
    if (r.isUpdateAvailable === false && !updateState?.version) {
      dialog.showMessageBox({ type: "info", title: "检查更新", message: "已是最新版本 v" + app.getVersion() });
    }
  } catch (e) {
    dialog.showMessageBox({ type: "error", title: "检查更新失败", message: String((e && e.message) || e), detail: "常见原因：网络/代理未就绪，或 GitHub 不可达。开 Clash 后重试。" });
  }
}

// ---------- IPC ----------
ipcMain.handle("server-restart", async () => restartServer());
ipcMain.handle("deploy-local", async () => { deployLocal(); return true; });
ipcMain.handle("check-update", async () => { manualCheckUpdate(); return true; });
ipcMain.handle("app-version", () => ({ version: app.getVersion(), packaged: app.isPackaged }));
ipcMain.on("app-quit", () => { quitting = true; app.quit(); });

app.on("before-quit", () => {
  quitting = true;
  try { if (child) killTree(child.pid); } catch { }
});
app.on("window-all-closed", () => { /* 常驻托盘 */ });
