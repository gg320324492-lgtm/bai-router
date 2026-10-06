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
let updateState = null; // {version, txid, phase, percent, releaseNotes, manual}

/* v1.0.55 事务标识：每次「发现新版本」开启一个更新事务，txid 单调递增。
   为什么版本号不够：用户可以在下载 vX 的途中再点「检查更新」，而远端此时
   可能仍是 vX（日志里就出现过同一秒连发两条「手动检查更新完成: 远端最新 v1.0.54」）。
   只按 version 比对时，这种「同版本的新一次检查」与旧事务无法区分，
   旧事务的 download-progress 会被误认成当前事务的进度重新点亮横幅。
   版本号负责「看的是哪个版本」（渲染层跨版本切换），txid 负责「是不是同一次事务」
   （同版本重开检查时也要整体切换）。两者一起随 state 下发，两端口径一致。 */
let updateTxSeq = 0;
function newUpdateTx() { return ++updateTxSeq; }

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
  // OpenRouter（第 6 家，v1.0.59）：与 server.mjs 的 computeNoProxy 最后一行**逐字同构**
  // （同上游默认值、同 useProxy 判据、同为末位追加）。任一侧漏改 → NO_PROXY 漂移 →
  // server 自检重启 exit(0) → 下面的看门狗计成崩溃 → 无限重启（v1.0.37 加 zen 真实发生过）。
  addNoProxyHost(cfg.or?.upstream || "https://openrouter.ai/api/v1", cfg.or?.useProxy);
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
// v1.0.52：判断「这次发现新版本，是不是用户手动点出来的」——决定弹框还是静默后台下载。
// 用「时间窗口」而非只看 manualCheckAt 是否非零：自动检查每 12 小时一轮，
// manualCheckAt 可能残留几小时前的旧值，仅判非零会把自动发现误判成手动。
// 窗口 3 分钟与 error 分支同口径。update-available 可能在 checkForUpdates() 的
// await 返回前就触发，而 manualCheckAt 在调用前已写好，所以窗口期判据一定成立。
const MANUAL_WINDOW_MS = 3 * 60 * 1000;
function isManualCheck() {
  return manualCheckAt > 0 && Date.now() - manualCheckAt < MANUAL_WINDOW_MS;
}
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
    // v1.0.52：关掉「检测到就自动下载」。原来为 true 时，发现新版本立即开下，
    // 用户还没来得及看更新日志，横幅就变成「下载中 3%」——日志形同虚设。
    // 改 false 后由下面的 update-available 按手动/自动分流：
    //   手动 → 只上报事件（manual:true），等用户点「立即安装」再 downloadUpdate()
    //   自动 → 立刻 downloadUpdate()，后台静默下载，用户无感（保持原有体验）
    au.autoDownload = false;
    au.autoInstallOnAppQuit = true;
    au.on("checking-for-update", () => { updateState = { phase: "checking" }; syncTray(); });
    au.on("update-available", (info) => {
      const manual = isManualCheck();
      const releaseNotes = normalizeReleaseNotes(info.releaseNotes);
      /* v1.0.55 契约 2：让「当前待处理的版本」只有一个。
         用户在下 vA 的途中又点「检查更新」，checkForUpdates() 会再发一次
         update-available。两种情形分开处理：

         情形一 · version 变了（vA → vB）：这是用户实拍 bug 的根源。
           旧事务必须先作废，否则它的 download-progress 会继续往 updateState 里灌数据，
           屏幕上同时出现「vB 的弹框」+「vA 的下载横幅」。
           autoUpdater 没有公开的 cancel API，所以做「作废旧事务」：
             - 换一个新 txid，旧事务的迟到事件因 txid 更小被渲染层丢弃；
             - 记一条日志，方便 app.log 排查「下载到一半又换了目标」。

         情形二 · version 没变（vA → vA）：**必须保留当前事务的 txid 与 percent**。
           因为 autoUpdater 每次 checkForUpdates 都会重发 update-available，
           而手动检查现在必定会真的去查远端（见 manualCheckUpdate）——
           若这里也换 txid 并把 percent 归零，一次「下载中再点检查」就会把
           进度条打回 0%，看起来像重新开始下载，是明显倒退。
           percent 归零只应发生在「确实换了一笔新事务」时。 */
      const sameTx = updateState && updateState.txid != null && updateState.version === info.version;
      if (updateState && updateState.txid && updateState.version !== info.version) {
        logMain(`放弃处理中的 v${updateState.version}，改处理 v${info.version}`);
      }
      // phase 仍写 "downloading"：面板横幅的既有渲染只认 downloading/ready 两态，
      // 手动分支下这也是「有新版待处理」的正确语义（真正下载时会被 download-progress 覆盖）。
      // manual 是本版新增字段，渲染层据此决定要不要弹模态框。
      updateState = sameTx
        ? { ...updateState, manual, releaseNotes: releaseNotes || updateState.releaseNotes }
        : { phase: "downloading", version: info.version, txid: newUpdateTx(), percent: 0, releaseNotes, manual };
      syncTray();
      notifyWindow("app-event", { kind: "update", state: updateState });
      if (manual) {
        // 手动：不下载，把决定权交给用户（弹框里的「立即安装」会触发 downloadUpdate）
        logMain(`手动检查发现新版本 v${info.version}，等待用户确认（不自动下载）`);
      } else {
        // 自动：维持「后台自动更新」的既有行为——静默下载，不通知用户
        logMain(`自动检查发现新版本 v${info.version}，后台静默下载`);
        au.downloadUpdate().catch((e) => { logMain("自动下载启动失败: " + String((e && e.message) || e).slice(0, 120)); });
      }
    });
    au.on("update-not-available", () => { updateState = { phase: "latest" }; syncTray(); });
    let lastPct = -5;
    let dlWatchdog = null;
    au.on("download-progress", (p) => {
      const pct = Math.round(p.percent);
      /* v1.0.55 契约 2：download-progress 的载荷里没有版本号，无法自证属于哪个事务。
         归因规则（与渲染层同构，两端都用「当前事务」这一把尺）：
           - 当前 state 是 downloading → 就是它，补 percent；
           - 否则（ready/error/latest，或尚无 state）→ 这多半是上一笔被作废的下载
             迟到的进度。此时**忽略**，否则会把已经切到 vB 的界面重新拉回下载态、
             或把 ready 的安装包重新画成进度条。
         被作废事务的后续进度事件正是这样被挡在门外的。 */
      if (!updateState || updateState.phase !== "downloading") return;
      updateState = { ...updateState, phase: "downloading", percent: pct };
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
      /* v1.0.55 契约 2：作废旧事务后，它的 update-downloaded 仍可能迟到到达
         （autoUpdater 无法真正取消下载，vA 下完照样会报 ready）。
         若照单全收，state 会被改回 vA——屏幕上就又出现「已就绪 vA」与「下载中 vB」
         两个版本并存，正是要修的那个 bug。
         判据：当前 state 正处理的是另一个版本 → 这个 ready 属于被作废的事务，丢弃。
         例外：当前没有 state（启动后直接秒就绪的缓存包），此时 info.version 就是唯一线索，
         没有「冲突的当前版本」可比较，照常接受并开新事务。 */
      if (updateState && updateState.version && updateState.version !== info.version) {
        logMain(`忽略已作废事务的 ready 事件（v${info.version}，当前处理 v${updateState.version}）`);
        return;
      }
      // 保留 update-available 阶段已解析出的日志与 manual 标记；若该事件被跳过
      // （如已缓存秒就绪）再兜底解析日志。manual 一路带到 ready，弹框在下载完成后
      // 仍知道自己是「手动那次」发起的，按钮语义才连贯（下载中→可安装）。
      // v1.0.55：同版本沿用既有 txid，保证「弹框/横幅认的事务」与
      // 「installReadyUpdate 认的事务」始终一致。
      const sameVer = updateState && updateState.version === info.version;
      const txid = sameVer ? updateState.txid : newUpdateTx();
      updateState = { phase: "ready", version: info.version, txid, releaseNotes: (sameVer && updateState.releaseNotes) || normalizeReleaseNotes(info.releaseNotes), manual: !!(sameVer && updateState.manual) };
      syncTray();
      notifyWindow("app-event", { kind: "update", state: updateState });
    });
    au.on("error", (e) => {
      updateState = { phase: "error", msg: String((e && e.message) || e).slice(0, 160) };
      syncTray();
      // 两种情况都落日志：自动失败记"已静默"，手动失败记明文——
      // 否则"点了检查更新没反应"在 app.log 里查无实据，无法区分是没找到还是根本没发出去。
      // 复用 isManualCheck()：与 update-available 的手动判定同源，避免两处口径漂移。
      if (isManualCheck()) {
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
  if (!autoUpdater || !updateState) return;
  // v1.0.52 手动流程：发现新版本时并未下载，用户点「立即安装」= 开始下载。
  // 下载完成会自动进 ready 并发 update-downloaded 事件（弹框/横幅随即切到可安装态），
  // 这里只负责启动，不能 quitAndInstall——此时根本没有已下载的安装包。
  if (updateState.phase === "downloading") {
    /* v1.0.55 契约 1：下载中重复点「立即安装」不应再盲调一次 downloadUpdate()。
       注意 phase==="downloading" 天然覆盖两种情形：
         (a) 发现新版本待用户确认（downloadStarted 未置、percent 为 0）——本次点击才该启动下载；
         (b) 下载已经跑起来了（downloadStarted 已置）——本次点击是重复触发，直接忽略。
       为什么用显式 downloadStarted 而不是 percent>0：下载刚开始的几秒 percent 还是 0，
       用户连点两下就会各启一次下载；electron-updater 对同一次下载有幂等保护，
       但**跨版本**（vA 下到一半又去下 vB）状态会乱，所以必须在入口就挡住。
       不做「替换目标版本」的智能处理：检查更新跑在 invokes 的 await 之外，
       让 installReadyUpdate 去并发地改检查目标会把两件事绞在一起；
       目标版本变了应由「检查更新」路径统一收口（见 manualCheckUpdate / update-available）。 */
    if (updateState.downloadStarted) {
      logMain("已在下载 v" + (updateState.version || "?") + "，忽略重复的安装请求");
      // 补发一次当前状态，让「立即安装」被连点时界面仍保持在下载态（按钮不会闪回可点）
      notifyWindow("app-event", { kind: "update", state: updateState });
      return;
    }
    logMain("用户确认安装，开始下载 v" + (updateState.version || "?"));
    // 先落标记再启动下载：downloadUpdate() 是异步的，若等它 resolve 再置位，
    // 中间这段窗口里的第二次点击仍会漏进去，等于没防。
    updateState = { ...updateState, downloadStarted: true };
    syncTray();
    autoUpdater.downloadUpdate().catch((e) => {
      updateState = { phase: "error", msg: String((e && e.message) || e).slice(0, 160) };
      syncTray();
      notifyWindow("app-event", { kind: "update", state: updateState });
    });
    return;
  }
  if (updateState.phase !== "ready") return;
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
  // 手动检查的「身份戳」——必须在任何分支/await 之前打下，update-available 才认得出这次是手动。
  // 原先它写在 try 里、且在两个 early-return 之后，会导致：
  //   自动检查已发现新版（state=downloading/ready，manual=false）时用户再点「检查更新」，
  //   走 early-return 重发旧 state，manual 仍是 false → 弹框不出现，用户又「什么都没看到」。
  manualCheckAt = Date.now();
  if (!autoUpdater) {
    notifyWindow("app-event", { kind: "check", text: "绿色/开发模式不支持自动更新，仅安装版可用", sticky: true });
    return;
  }
  /* v1.0.55 契约 2：不再「见到有待处理新版就 early-return 重发旧状态」。
     旧写法正是用户实拍 bug 的直接成因：
       下载 vA 的途中点「检查更新」→ early-return 把 **vA** 的 downloading 状态
       当手动事务重发（弹框写 vA），而随后真正的 checkForUpdates() 没被调用，
       新版本 vB 直到下一次检查才被发现——屏幕上于是并存两个事务的通知。
     新写法：无论当前有没有待处理事务，都真的去查一次远端。这样：
       - 远端仍是当前版本 → update-available 不会触发，走到下面的补发分支，
         仅把 manual 补成 true 重开弹框（保住既有「再点一次把弹框叫回来」的体验）；
       - 远端是**另一个**版本 → update-available 会带新 txid 开启新事务，
         旧事务被作废（收尾逻辑见 update-available / download-progress），
         屏幕上整体切到新版本，绝不并存。
     注意：这里不再提前 return，所以下面的补发分支要等检查结果出来后再判断。 */
  let rechecked = false;
  try {
    notifyWindow("app-event", { kind: "check", text: "正在检查更新…" });
    const r = await autoUpdater.checkForUpdates();
    rechecked = true;
    logMain("手动检查更新完成: " + (r ? (r.updateInfo ? `远端最新 v${r.updateInfo.version}` : JSON.stringify(r).slice(0, 120)) : "无返回值"));
    if (r && r.isUpdateAvailable === false) {
      notifyWindow("app-event", { kind: "check", text: "已是最新版本 v" + app.getVersion() });
    }
    // 有更新：update-available 事件已带 manual:true 上报，渲染层据此弹模态框
  } catch (e) {
    // 失败详情已由 au.on("error") 弹「更新失败」横幅（含重试/备用升级按钮），
    // 这里不再补发第二条，避免一次失败双横幅轰炸
    if (!updateState || updateState.phase !== "error") {
      notifyWindow("app-event", { kind: "check", text: "检查更新失败：" + String((e && e.message) || e).slice(0, 100) + "（多为网络/代理未就绪，开 Clash 后重试）", sticky: true });
    }
    return; // 失败时不补发旧事务，避免把错误态又拉回下载态
  }
  /* 检查已有结论但 update-available 没带来新事务（远端仍是当前在处理的那个版本，
     或已是最新）——此时若存在待处理事务，补上 manual:true 重发一次，
     保住既有体验：自动检查发现的版本，用户手动点一次「检查更新」也能把弹框叫回来。
     若刚才是新版本，update-available 已带着新 txid 发过事件，这里不再补发
     （补发会把同一次事务渲染两遍）。 */
  if (rechecked && updateState && (updateState.phase === "ready" || updateState.phase === "downloading")) {
    notifyWindow("app-event", { kind: "update", state: { ...updateState, manual: true } });
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
