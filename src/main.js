const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const instCheck = require("./install-consistency");

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
let snRelayPort = 15732; // v1.0.28: SenseNova 独立中转端口（同样纳入启动预检回收）
let updateState = null; // {version, downloaded}

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { }
try {
  const c = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8"));
  panelPort = c.panelPort || panelPort;
  relayPort = c.relayPort || relayPort;
  snRelayPort = (c.sn && c.sn.relayPort) || snRelayPort;
} catch {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(path.dirname(SERVER_JS), "config.defaults.json"), "utf8"));
    panelPort = c.panelPort || panelPort;
    relayPort = c.relayPort || relayPort;
    snRelayPort = (c.sn && c.sn.relayPort) || snRelayPort;
  } catch { }
}

const PANEL = `http://127.0.0.1:${panelPort}`;
const startMin = process.argv.includes("--min");

// ---------- 单实例 ----------
// BAI_SELFHEAL=1 的子进程（从旧副本一键切到正式版）会等旧实例退出后再拿锁
function startApp() {
  app.on("second-instance", () => showWindow());
  main().catch((e) => { dialog.showErrorBox("B.AI 路由台启动失败", String((e && e.stack) || e)); app.quit(); });
}
if (!app.requestSingleInstanceLock()) {
  if (process.env.BAI_SELFHEAL) {
    let lockTries = 0;
    const lockTimer = setInterval(() => {
      if (app.requestSingleInstanceLock()) { clearInterval(lockTimer); startApp(); }
      else if (++lockTries >= 40) { clearInterval(lockTimer); app.quit(); }
    }, 500);
  } else {
    app.quit();
  }
} else {
  startApp();
}

async function main() {
  await app.whenReady();
  app.setAppUserModelId("local.bai.router");
  await detectRuntime();
  const ok = await ensureServer();
  serverHealthy = ok;
  createTray();
  setupUpdater();
  instCheck.init({
    app, spawn, logMain,
    getUpdateState: () => updateState,
    setUpdateState: (s) => { updateState = s; },
    notifyWindow, syncTray,
    requestQuit: () => { quitting = true; setTimeout(() => app.quit(), 600); },
  });
  instCheck.check().catch(() => { });
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
  // NO_PROXY：回环 + 每个 useProxy=false 的上游域名（必须与 server.mjs 的 computeNoProxy 逐项一致）。
  // Node 启动时缓存 env 代理配置，两边不一致时 server 会自检重启一次——而那次 exit(0) 会被下面的
  // 看门狗当成崩溃再拉起，形成"服务已自动恢复运行"弹窗风暴 + 端口互抢的死循环。
  // 新增提供方时**这里必须同步加一行**（v1.0.37 加 zen 漏加就是一次真实故障）。
  const noProxyList = ["127.0.0.1", "localhost"];
  const addNoProxyHost = (upstream, useProxy) => {
    if (useProxy === true) return;
    try { const h = new URL(upstream).host; if (h && !noProxyList.includes(h)) noProxyList.push(h); } catch { }
  };
  addNoProxyHost(cfg.wb?.upstream || "https://www.workbuddy.ai", cfg.wb?.useProxy);
  addNoProxyHost(cfg.sn?.upstream || "https://token.sensenova.cn", cfg.sn?.useProxy);
  addNoProxyHost(cfg.zen?.upstream || "https://opencode.ai/zen/v1", cfg.zen?.useProxy);
  addNoProxyHost(cfg.qd?.upstream || "https://api2-v2.qoder.sh/model/v1", cfg.qd?.useProxy);
  const env = {
    ...process.env,
    NODE_USE_ENV_PROXY: "1",
    // 本进程已按上表备好代理环境：告诉 server.mjs 不要自检重启。
    // 少了这一行，每个子进程都会重启一次自己，而那次正常退出会被看门狗计成崩溃 → 无限重启。
    BAI_ENV_FIXED: "1",
    ...(cfg.proxy ? { HTTPS_PROXY: cfg.proxy, HTTP_PROXY: cfg.proxy } : {}), // 空 = 直连（TUN/全局模式）
    NO_PROXY: noProxyList.join(","),
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
    // 快速崩溃计数：连续 5 次秒退 → 熔断重试，切诊断页（防止无限拉起循环）
    if (Date.now() - born < 5000) crashStreak++; else crashStreak = 0;
    if (crashStreak >= 5) {
      crashStreak = 0;
      lastSpawnError = `服务连续崩溃 ${5} 次已停止自动重试。最近退出码=${code}（2=端口被占用）。详见诊断日志`;
      serverHealthy = false;
      logMain("崩溃熔断：停止自动重拉，界面切换诊断页");
      showWindow(true);
      return;
    }
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
let lastRecoverNoticeAt = 0;
function logMain(msg) {
  try { fs.appendFileSync(path.join(DATA_DIR, "app.log"), `[${new Date().toISOString()}] ${msg}\n`); } catch { }
}

async function respawnWithNotice() {
  spawnServer();
  const ok = await waitReady(20000);
  if (ok) crashStreak = 0;
  // 静默恢复：只通知面板横幅。限流 60s 一次——若真出现重启循环（NO_PROXY 漂移等），
  // 逐次弹出的横幅会盖住整个界面且关不掉，而根因在日志里，60s 一次足够定位。
  const now = Date.now();
  if (now - lastRecoverNoticeAt < 60000) return;
  lastRecoverNoticeAt = now;
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

// ---------- 端口预检与回收（v1.0.10：根治"教程旧 relay 残留占 15722"导致的死循环） ----------
const net = require("net");
function portBusy(port) {
  return new Promise((res) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 1200 }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.on("timeout", () => { s.destroy(); res(false); });
  });
}
function execOut(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (e, so) => res(e ? "" : String(so))));
}
async function occupantOf(port) {
  const out = await execOut("netstat", ["-ano", "-p", "TCP"]);
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("TCP") || !t.includes(`127.0.0.1:${port}`) || !/LISTENING/i.test(t)) continue;
    const pid = (t.match(/(\d+)\s*$/) || [])[1];
    if (!pid) continue;
    const tl = await execOut("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    const m = String(tl).match(/"([^"]+\.exe)"/i); // CSV: "node.exe","4996","Console",...
    const name = m ? m[1] : "未知进程";
    return { pid, name };
  }
  return null;
}
let portReport = null; // 展示给诊断页
async function reclaimPort(port) {
  if (!(await portBusy(port))) return null;
  const o = await occupantOf(port);
  if (!o) return { port, note: "占用者未知" };
  // node.exe = 上一代服务；B.AI Router.exe = 旧实例/半死 Electron。都可以安全回收
  if (/^(node(\.exe)?|B\.AI Router\.exe)$/i.test(o.name) && String(o.pid) !== String(process.pid)) {
    await new Promise((r) => execFile("taskkill", ["/F", "/T", "/PID", String(o.pid)], { windowsHide: true }, r));
    for (let i = 0; i < 10 && (await portBusy(port)); i++) await new Promise((r) => setTimeout(r, 300));
    const still = await portBusy(port);
    logMain(`端口:${port} 原被 ${o.name}(pid ${o.pid}) 占用 → 已${still ? "回收失败" : "回收"}`);
    return { port, killed: `${o.name} pid ${o.pid}`, ok: !still };
  }
  return { port, occupant: `${o.name} pid ${o.pid}`, blocked: true };
}

async function ensureServer() {
  // 预检：抢回被旧残留占用的端口（含 SenseNova 中转 :15732）
  const r1 = await reclaimPort(relayPort);
  const r2 = await reclaimPort(panelPort);
  const r3 = await reclaimPort(snRelayPort);
  portReport = [r1, r2, r3].filter(Boolean);
  const blocked = portReport.find((p) => p.blocked);
  if (blocked) {
    lastSpawnError = `端口 ${blocked.port} 被非本软件进程占用: ${blocked.occupant}（请手动关闭该程序或改端口）`;
    logMain(lastSpawnError);
  }
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

let crashStreak = 0;

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
  // 重试前重新回收端口（应对"外部残留占用"场景）
  const r1 = await reclaimPort(relayPort);
  const r2 = await reclaimPort(panelPort);
  const r3 = await reclaimPort(snRelayPort);
  portReport = [r1, r2, r3].filter(Boolean);
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
    width: 1120, height: 800, minWidth: 720, minHeight: 560,
    title: "B.AI 路由台", backgroundColor: "#16171b", autoHideMenuBar: true,
    icon: iconPath,
    // v1.0.34：自绘标题栏——原生标题栏是系统浅色，与面板深色割裂；隐藏后由页面 header 接管拖动/最小化/关闭，
    // 整个窗口成为一整块主题色（浅色主题同理，页面会把窗口底色一起切过去）。
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 12, y: 14 } } : {}),
    webPreferences: { preload: path.join(APP_DIR, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  // 恢复上次窗口尺寸/位置（越界保护：显示器变了就居中）
  try {
    const st = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "window-state.json"), "utf8"));
    const { screen } = require("electron");
    const inScreen = st && screen.getAllDisplays().some((d) =>
      st.x !== undefined && d.workArea.x - 60 <= st.x && st.x <= d.workArea.x + d.workArea.width - 60 &&
      d.workArea.y - 20 <= st.y && st.y <= d.workArea.y + d.workArea.height - 60);
    if (st && inScreen) win.setBounds({ x: st.x, y: st.y, width: st.width, height: st.height });
    if (st && st.maximized) win.maximize();
  } catch { }
  let wsTimer = null;
  const saveWindowState = () => {
    clearTimeout(wsTimer);
    wsTimer = setTimeout(() => {
      try {
        if (!win || win.isDestroyed()) return;
        const b = win.getBounds();
        fs.writeFileSync(path.join(DATA_DIR, "window-state.json"), JSON.stringify({ ...b, maximized: win.isMaximized() }));
      } catch { }
    }, 400);
  };
  win.on("resize", saveWindowState);
  win.on("move", saveWindowState);
  win.on("maximize", saveWindowState);
  win.on("unmaximize", saveWindowState);
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
    if (updateState && updateState.phase === "stale") {
      notifyWindow("app-event", { kind: "stale", state: updateState });
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
let manualCheckAt = 0;   // 用户主动点「检查更新」的时刻（区分 自动/手动 失败的提示方式）
let autoFailRetried = false; // 本会话内自动检查失败后的静默重试只做一次
let trayMenuRef = null;
// 把 electron-updater 的 releaseNotes 归一化成字符串（面板只认 state.releaseNotes 一个字段名）。
// 类型见 node_modules/builder-util-runtime/out/updateInfo.d.ts:52：
//   string | Array<ReleaseNoteInfo> | null
// - string：latest.yml 里直接写的一整段（本项目的默认形态，见 build.releaseInfo.releaseNotesFile）
// - 数组：只有开了 fullChangelog 才会出现，每项 {version, note}，按顺序取 .note 拼接
// - null/undefined/空：老版本发布的包没有该字段 → 返回空串，面板据此优雅降级
function normalizeReleaseNotes(notes) {
  if (!notes) return "";
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) return notes.map((n) => (n && typeof n.note === "string" ? n.note : "")).filter(Boolean).join("\n\n");
  return "";
}
function setupUpdater() {
  if (!app.isPackaged) return; // 开发/绿色模式没有 app-update.yml，跳过
  try {
    const { autoUpdater: au } = require("electron-updater");
    autoUpdater = au;
    au.autoDownload = true;
    au.autoInstallOnAppQuit = true;
    au.on("checking-for-update", () => { updateState = { phase: "checking" }; syncTray(); });
    au.on("update-available", (info) => {
      updateState = { phase: "downloading", version: info.version, percent: 0, releaseNotes: normalizeReleaseNotes(info.releaseNotes) };
      syncTray();
      notifyWindow("app-event", { kind: "update", state: updateState });
    });
    au.on("update-not-available", () => { updateState = { phase: "latest" }; syncTray(); });
    let lastPct = -5;
    let dlWatchdog = null;
    au.on("download-progress", (p) => {
      const pct = Math.round(p.percent);
      updateState = { ...(updateState || { phase: "downloading" }), phase: "downloading", percent: pct };
      if (pct - lastPct >= 5 || pct === 100) { lastPct = pct; notifyWindow("app-event", { kind: "update", state: updateState }); }
      syncTray();
      // 看门狗：100% 后 25 秒仍未收到 ready → 主动再查一次（已下载文件会被秒判就绪）
      if (pct >= 100 && !dlWatchdog) {
        dlWatchdog = setTimeout(() => {
          dlWatchdog = null;
          if (updateState && updateState.phase === "downloading") {
            logMain("下载100%后未见 ready 事件，主动重查");
            au.checkForUpdates().catch(() => { });
          }
        }, 25000);
      }
    });
    au.on("update-downloaded", (info) => {
      if (dlWatchdog) { clearTimeout(dlWatchdog); dlWatchdog = null; }
      lastPct = -5;
      // 保留 update-available 阶段已解析出的日志；若该事件被跳过（如已缓存秒就绪）再兜底解析一次
      updateState = { phase: "ready", version: info.version, releaseNotes: (updateState && updateState.releaseNotes) || normalizeReleaseNotes(info.releaseNotes) };
      syncTray();
      notifyWindow("app-event", { kind: "update", state: updateState });
    });
    au.on("error", (e) => {
      updateState = { phase: "error", msg: String((e && e.message) || e).slice(0, 160) };
      syncTray();
      // 两种情况都落日志：自动失败记"已静默"，手动失败记明文——
      // 否则"点了检查更新没反应"在 app.log 里查无实据，无法区分是没找到还是根本没发出去。
      if (Date.now() - manualCheckAt < 3 * 60 * 1000) {
        logMain("手动检查更新失败: " + updateState.msg);
        notifyWindow("app-event", { kind: "update", state: updateState });
      } else {
        logMain("自动检查更新失败（已静默）: " + updateState.msg);
        if (!autoFailRetried) {
          autoFailRetried = true;
          setTimeout(() => { au.checkForUpdates().catch(() => { }); }, 5 * 60 * 1000);
        }
      }
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
  else if (u && u.phase === "stale") tip += ` · 正在运行旧副本（正式版 v${u.version} 装在 ${u.regPath || "别处"}）`;
  tray.setToolTip(tip);
  // 更新就绪时：托盘菜单第一项变成「安装更新 vX」
  if (trayMenuRef) {
    const first = trayMenuRef.items[0];
    if (u && u.phase === "ready") {
      first.label = `安装更新 v${u.version}`;
      first.click = installReadyUpdate;
    } else if (u && u.phase === "stale" && u.canSwitch) {
      first.label = `切换到正式版 v${u.version}`;
      first.click = () => instCheck.switchToInstalled();
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
    manualCheckAt = Date.now();
    const r = await autoUpdater.checkForUpdates();
    logMain("手动检查更新完成: " + (r ? (r.updateInfo ? `远端最新 v${r.updateInfo.version}` : JSON.stringify(r).slice(0, 120)) : "无返回值"));
    if (r && r.isUpdateAvailable === false) {
      notifyWindow("app-event", { kind: "check", text: "已是最新版本 v" + app.getVersion() });
    }
    // 有更新：update-available 事件自动切到下载横幅，无需弹窗
  } catch (e) {
    // 失败详情已由 au.on("error") 弹「更新失败」横幅（含重试/备用升级按钮），
    // 这里不再补发第二条，避免一次失败双横幅轰炸
    if (!updateState || updateState.phase !== "error") {
      notifyWindow("app-event", { kind: "check", text: "检查更新失败：" + String((e && e.message) || e).slice(0, 100) + "（多为网络/代理未就绪，开 Clash 后重试）", sticky: true });
    }
  }
}

// ---------- IPC ----------
ipcMain.handle("server-restart", async () => restartServer());
ipcMain.handle("deploy-local", async () => { deployLocal(); return true; });
ipcMain.handle("check-update", async () => { manualCheckUpdate(); return true; });
ipcMain.handle("install-update", async () => { installReadyUpdate(); return true; });
ipcMain.handle("switch-installed", () => instCheck.switchToInstalled());
ipcMain.handle("app-version", () => ({ version: app.getVersion(), packaged: app.isPackaged }));
ipcMain.on("app-quit", () => { quitting = true; app.quit(); });

// v1.0.34：自绘标题栏的窗口控制
const pushWinState = () => { if (win && !win.isDestroyed()) win.webContents.send("win-state", { maximized: win.isMaximized() }); };
ipcMain.handle("win-minimize", () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.handle("win-toggle-maximize", () => {
  if (!win || win.isDestroyed()) return false;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
  return win.isMaximized();
});
ipcMain.handle("win-close", () => { if (win && !win.isDestroyed()) { quitting = true; win.close(); } });
for (const ev of ["maximize", "unmaximize"]) {
  try { win && win.on(ev, pushWinState); } catch { }
}

// 诊断页支持
function tailOf(p, n = 2400) {
  try {
    const s = fs.readFileSync(p, "utf8");
    return s.length > n ? "…" + s.slice(-n) : s;
  } catch { return ""; }
}
ipcMain.handle("diag-info", () => ({
  version: app.getVersion(),
  runtime: runtimeSystem ? `system-node (${runtimeNodePath})` : "electron 内置 node",
  lastSpawnError,
  portReport,
  dataDir: DATA_DIR,
  childLog: path.join(DATA_DIR, "server-child.log"),
  appLog: path.join(DATA_DIR, "app.log"),
  logs: {
    server: tailOf(path.join(DATA_DIR, "server.log")),
    child: tailOf(path.join(DATA_DIR, "server-child.log")),
    app: tailOf(path.join(DATA_DIR, "app.log")),
  },
  panel: PANEL,
  win: require("os").release(),
}));
ipcMain.handle("open-log", (_e, p) => shell.openPath(p || path.join(DATA_DIR, "server-child.log")));
ipcMain.handle("diag-retry", async () => { const ok = await restartServer(); return ok; });
// 一键信任自带证书（解决自签名更新校验：每台新电脑点一次即可，写当前用户信任库，免管理员）
ipcMain.handle("trust-cert", async () => {
  const cer = app.isPackaged
    ? path.join(process.resourcesPath, "bai-router.cer")
    : path.join(APP_DIR, "..", "cert", "bai-router.cer");
  if (!fs.existsSync(cer)) return { ok: false, msg: "随包证书文件缺失" };
  const run = (args) => new Promise((r) => execFile("certutil", args, { windowsHide: true, timeout: 20000 }, (e) => r(!e)));
  const a = await run(["-addstore", "-user", "Root", cer]);
  const b = await run(["-addstore", "-user", "TrustedPublisher", cer]);
  logMain(`trust-cert 导入：Root=${a ? "OK" : "FAIL"} TrustedPublisher=${b ? "OK" : "FAIL"}`);
  return { ok: a && b };
});

app.on("before-quit", () => {
  quitting = true;
  try { if (child) killTree(child.pid); } catch { }
});
app.on("window-all-closed", () => { /* 常驻托盘 */ });
