const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

// ---------- 兼容性：老机器/核显/远程桌面下 Electron 窗口黑屏的根治开关 ----------
// 路由台界面极轻，软件渲染没有任何可感知性能损失
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");

// ---------- 路径布局 ----------
// 打包后：主程序 resources/app；后端在 resources/server（extraResources，升级会被替换）
//       用户数据（config.json/backups/server.log）在 %APPDATA%\bai-router —— 升级不会覆盖
const APP_DIR = __dirname;
// 数据目录固定为 %APPDATA%\bai-router —— 不跟 productName 走，跨机器/改名/重装都稳定
try { app.setPath("userData", path.join(app.getPath("appData"), "bai-router")); } catch { }
const DATA_DIR = app.getPath("userData");
const SERVER_JS = app.isPackaged
  ? path.join(process.resourcesPath, "server", "server.mjs")
  : path.join(APP_DIR, "server", "server.mjs");
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, "icon.ico")
  : path.join(APP_DIR, "..", "build", "icon.ico");
// 一次性迁移：v1.0.1 曾把数据写到 productName 目录，存在旧数据且新目录没配置时搬过来
try {
  const oldDir = path.join(app.getPath("appData"), "B.AI Router");
  if (fs.existsSync(path.join(oldDir, "config.json")) && !fs.existsSync(path.join(DATA_DIR, "config.json"))) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(path.join(oldDir, "config.json"), path.join(DATA_DIR, "config.json"));
    for (const f of ["backups"]) { try { fs.cpSync(path.join(oldDir, f), path.join(DATA_DIR, f), { recursive: true }); } catch { } }
  }
} catch { }

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
  await detectRuntime();
  const ok = await ensureServer();
  serverHealthy = ok;
  createTray();
  setupUpdater();
  maybeFirstRunDeploy();
  startHealthWatcher();
  if (!startMin) showWindow(!ok);
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

// 运行时选择：系统 Node 需 ≥18（AbortSignal 等 API），否则用 Electron 内置 Node
let runtimeSystem = false;
let runtimeNodePath = null;
const recentExits = [];
async function detectRuntime() {
  const node = findSystemNode();
  if (node) {
    try {
      const out = await new Promise((res, rej) => execFile(node, ["-v"], { timeout: 8000 }, (e, so) => (e ? rej(e) : res(so))));
      const major = parseInt(String(out).trim().replace(/^v/, ""), 10);
      if (major >= 18) { runtimeSystem = true; runtimeNodePath = node; return; }
    } catch { }
  }
  runtimeSystem = false;
}

function spawnServer() {
  const cfg = readCfgSafe();
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
  // 子进程 stdout/stderr 落盘（server-child.log）——崩溃原因不再丢失
  let fd = null;
  try { fd = fs.openSync(path.join(DATA_DIR, "server-child.log"), "a"); } catch { }
  const born = Date.now();
  try {
    if (runtimeSystem && runtimeNodePath) child = spawn(runtimeNodePath, [SERVER_JS], { cwd: path.dirname(SERVER_JS), env, stdio: ["ignore", fd, fd], windowsHide: true });
    else { env.ELECTRON_RUN_AS_NODE = "1"; child = spawn(process.execPath, [SERVER_JS], { cwd: path.dirname(SERVER_JS), env, stdio: ["ignore", fd, fd], windowsHide: true }); }
  } catch (e) {
    lastSpawnError = "spawn 抛异常: " + String((e && e.message) || e);
    logMain(lastSpawnError);
    if (fd != null) try { fs.closeSync(fd); } catch { }
    return;
  }
  if (fd != null) try { fs.closeSync(fd); } catch { }
  child.on("error", (e) => {
    lastSpawnError = "子进程错误: " + String((e && e.message) || e);
    logMain(lastSpawnError);
  });
  child.on("exit", (code, sig) => {
    child = null;
    logMain(`服务子进程退出 code=${code} sig=${sig} 存活${Math.round((Date.now() - born) / 1000)}s 运行时=${runtimeSystem ? "system-node" : "electron-node"}`);
    if (quitting) return;
    // 崩溃循环保护：秒退说明该运行时不行 → 切到内置 Node 再试
    recentExits.push(Date.now() - born);
    if (recentExits.length > 6) recentExits.shift();
    if (Date.now() - born < 3000 && recentExits.filter((x) => x < 3000).length >= 3 && runtimeSystem) {
      runtimeSystem = false;
      notifyWindow("app-event", { kind: "check", text: "检测到系统 Node 不兼容，已切换为内置运行时", sticky: true });
    }
    setTimeout(() => { if (!quitting && !child) respawnWithNotice(); }, 500);
  });
}

let lastSpawnError = null;
function logMain(msg) {
  try { fs.appendFileSync(path.join(DATA_DIR, "app.log"), `[${new Date().toISOString()}] ${msg}\n`); } catch { }
}

async function respawnWithNotice() {
  spawnServer();
  await waitReady(20000);
  // 静默恢复：只通知面板横幅，不再弹系统气泡
  notifyWindow("app-event", { kind: "recovered", text: "服务已自动恢复运行" });
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
    try { await new Promise((r) => execFile("taskkill", ["/F", "/PID", String(st.service.pid)], { windowsHide: true }, r)); } catch { }
    for (let i = 0; i < 20 && (await ping()); i++) await new Promise((r) => setTimeout(r, 300));
  }
  spawnServer();
  const ok = await waitReady(25000);
  if (!ok) logMain("服务 25 秒内未就绪，进入诊断模式");
  return ok;
}

// 服务未起来时不再黑屏：加载内置诊断页，实时监测，起来了自动切回面板
let serverHealthy = true;
function startHealthWatcher() {
  setInterval(async () => {
    const up = await ping();
    if (up && !serverHealthy) {
      serverHealthy = true;
      if (win && !win.isDestroyed()) win.loadURL(PANEL).catch(() => { });
    } else if (!up && serverHealthy && child === null && !quitting) {
      serverHealthy = false;
    }
  }, 3000);
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
    try { await new Promise((r) => execFile("taskkill", ["/F", "/PID", String(st.service.pid)], { windowsHide: true }, r)); } catch { }
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
function showWindow(diagMode) {
  if (win && !win.isDestroyed()) {
    if (diagMode) win.loadFile(path.join(path.dirname(SERVER_JS), "diag.html")).catch(() => { });
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
  if (diagMode) win.loadFile(path.join(path.dirname(SERVER_JS), "diag.html")).catch(() => { });
  else win.loadURL(PANEL).catch(() => { });
  // 服务尚未就绪导致加载失败 → 自动重试（黑屏保险）
  win.webContents.on("did-fail-load", (_e, code, _d, _u, isMain) => {
    if (!isMain || !win || win.isDestroyed()) return;
    setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(PANEL).catch(() => { }); }, 1500);
  });
  win.webContents.on("did-finish-load", () => {
    // 补发缓存的事件（含当前更新状态），重开窗口横幅不丢
    if (updateState && (updateState.phase === "downloading" || updateState.phase === "ready")) {
      notifyWindow("app-event", { kind: "update", state: updateState });
    }
    for (const ev of pendingEvents.splice(0)) {
      try { win.webContents.send("app-event", ev); } catch { }
    }
  });
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
  trayMenuRef = menu;
}

async function deployLocal() {
  // 静默部署（含开机自启），结果走面板横幅——不再弹系统对话框
  showWindow();
  notifyWindow("app-event", { kind: "check", text: "正在部署到本机…" });
  const j = await runDeploy(true);
  notifyWindow("app-event", { kind: "check", text: "部署完成：" + (j.messages || ["完成"]).join("；"), sticky: true });
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

// 面板内通知通道（替代系统弹窗/气泡）；窗口未就绪时先缓存，加载完补发
const pendingEvents = [];
function notifyWindow(channel, payload) {
  try {
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) { win.webContents.send(channel, payload); return; }
  } catch { }
  pendingEvents.push(payload);
  if (pendingEvents.length > 20) pendingEvents.shift();
}

function maybeFirstRunDeploy() {
  const marker = path.join(DATA_DIR, ".deployed");
  if (fs.existsSync(marker)) return;
  // 首启静默部署（快捷方式+自启），结果走面板横幅，不打扰
  fs.writeFileSync(marker, new Date().toISOString());
  runDeploy(true).then((j) => {
    notifyWindow("app-event", { kind: "deployed", text: "首次运行已完成自动部署：" + (j.messages || []).filter((m) => /快捷方式|自启|代理/.test(m)).join("；") });
  });
}

// ---------- 自动更新（全部静默化：状态进面板横幅 + 托盘提示，不弹系统窗） ----------
let autoUpdater = null;
let trayMenuRef = null;
function setupUpdater() {
  if (!app.isPackaged) return; // 开发/绿色模式没有 app-update.yml，跳过
  try {
    const { autoUpdater: au } = require("electron-updater");
    autoUpdater = au;
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.on("checking-for-update", () => { updateState = { phase: "checking" }; syncTray(); });
    au.on("update-available", (info) => {
      updateState = { phase: "downloading", version: info.version, percent: 0 };
      syncTray();
      notifyWindow("app-event", { kind: "update", state: updateState });
    });
    au.on("update-not-available", () => { updateState = { phase: "latest" }; syncTray(); });
    let lastPct = -5;
    au.on("download-progress", (p) => {
      const pct = Math.round(p.percent);
      updateState = { ...(updateState || { phase: "downloading" }), phase: "downloading", percent: pct };
      if (pct - lastPct >= 5 || pct === 100) { lastPct = pct; notifyWindow("app-event", { kind: "update", state: updateState }); }
      syncTray();
    });
    au.on("update-downloaded", (info) => {
      updateState = { phase: "ready", version: info.version };
      syncTray();
      notifyWindow("app-event", { kind: "update", state: updateState });
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

function installReadyUpdate() {
  if (!autoUpdater || !updateState || updateState.phase !== "ready") return;
  // 面板横幅/托盘菜单点「安装更新」即直接执行，不再二次确认
  quitting = true;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}

function syncTray() {
  if (!tray) return;
  const u = updateState;
  let tip = "B.AI 路由台";
  if (u && u.phase === "downloading") tip += ` · 下载新版 ${u.version || ""} ${u.percent || 0}%`;
  else if (u && u.phase === "ready") tip += ` · 新版 ${u.version} 待安装`;
  else if (u && u.phase === "error") tip += " · 更新失败（可重试检查更新）";
  tray.setToolTip(tip);
  // 更新就绪时：托盘菜单第一项变成「安装更新 vX」
  if (trayMenuRef) {
    const first = trayMenuRef.items[0];
    if (u && u.phase === "ready") {
      first.label = `安装更新 v${u.version}`;
      first.click = installReadyUpdate;
    } else {
      first.label = "显示主界面";
      first.click = () => showWindow();
    }
  }
}

async function manualCheckUpdate() {
  showWindow();
  if (!autoUpdater) {
    notifyWindow("app-event", { kind: "check", text: "绿色/开发模式不支持自动更新，仅安装版可用", sticky: true });
    return;
  }
  if (updateState && updateState.phase === "ready") { notifyWindow("app-event", { kind: "update", state: updateState }); return; }
  if (updateState && updateState.phase === "downloading") { notifyWindow("app-event", { kind: "update", state: updateState }); return; }
  try {
    notifyWindow("app-event", { kind: "check", text: "正在检查更新…" });
    const r = await autoUpdater.checkForUpdates();
    if (r && r.isUpdateAvailable === false) {
      notifyWindow("app-event", { kind: "check", text: "已是最新版本 v" + app.getVersion() });
    }
    // 有更新：update-available 事件自动切到下载横幅，无需弹窗
  } catch (e) {
    notifyWindow("app-event", { kind: "check", text: "检查更新失败：" + String((e && e.message) || e).slice(0, 100) + "（多为网络/代理未就绪，开 Clash 后重试）", sticky: true });
  }
}

// ---------- IPC ----------
ipcMain.handle("server-restart", async () => restartServer());
ipcMain.handle("deploy-local", async () => { deployLocal(); return true; });
ipcMain.handle("check-update", async () => { manualCheckUpdate(); return true; });
ipcMain.handle("install-update", async () => { installReadyUpdate(); return true; });
ipcMain.handle("app-version", () => ({ version: app.getVersion(), packaged: app.isPackaged }));
ipcMain.on("app-quit", () => { quitting = true; app.quit(); });

// 诊断页支持
ipcMain.handle("diag-info", () => ({
  version: app.getVersion(),
  runtime: runtimeSystem ? `system-node (${runtimeNodePath})` : "electron 内置 node",
  lastSpawnError,
  dataDir: DATA_DIR,
  childLog: path.join(DATA_DIR, "server-child.log"),
  appLog: path.join(DATA_DIR, "app.log"),
  panel: PANEL,
  win: require("os").release(),
}));
ipcMain.handle("open-log", (_e, p) => shell.openPath(p || path.join(DATA_DIR, "server-child.log")));
ipcMain.handle("diag-retry", async () => { const ok = await restartServer(); return ok; });

app.on("before-quit", () => {
  quitting = true;
  try { if (child) killTree(child.pid); } catch { }
});
app.on("window-all-closed", () => { /* 常驻托盘 */ });
