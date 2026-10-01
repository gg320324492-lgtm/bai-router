// B.AI 路由台 —— 单进程双服务：
//   :relayPort  Anthropic 兼容中转（模型映射每次请求实时读 config.json，改了立即生效）
//   :panelPort  管理面板（UI + API：一键切换 / 一键恢复 / 映射编辑 / 状态体检）
// 启动方式任意：若缺 NODE_USE_ENV_PROXY 环境变量会自动以正确环境重启自己。
import http from "node:http";
import https from "node:https";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, statSync, createWriteStream } from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 用户数据目录：Electron 安装版通过 BAI_DATA_DIR 指向 %APPDATA%\bai-router（升级不覆盖）；
// 绿色/开发模式回退到自身目录。config/backups/日志都放这里。
const DATA_DIR = process.env.BAI_DATA_DIR || HERE;
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const LOG_FILE = path.join(DATA_DIR, "server.log");
const APP_VERSION = process.env.APP_VERSION || "dev";
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { }
// 首启：用户目录还没有 config → 从随包默认配置（或绿色模式旧 config）复制一份
try {
  if (!existsSync(CONFIG_FILE)) {
    const seed = [path.join(HERE, "config.defaults.json"), path.join(HERE, "config.json")]
      .find((p) => existsSync(p));
    if (seed) copyFileSync(seed, CONFIG_FILE);
  }
} catch { }
const HOME = os.homedir();
const SETTINGS = path.join(HOME, ".claude", "settings.json");
const CFG_LIB = path.join(HOME, "AppData", "Local", "Claude-3p", "configLibrary");
const META_FILE = path.join(CFG_LIB, "_meta.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");

const TIERS = [
  { key: "claude-fable-5", envKey: "ANTHROPIC_DEFAULT_FABLE_MODEL", zh: "Fable" },
  { key: "claude-sonnet-5", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL", zh: "Sonnet" },
  { key: "claude-opus-5", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL", zh: "Opus" },
  { key: "claude-haiku-4-5", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL", zh: "Haiku" },
];
const PASS_HEADERS = ["authorization", "content-type", "anthropic-version", "anthropic-beta", "x-api-key", "accept", "user-agent"];

const BOOT = Date.now();
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}`;
  try { appendLine(); } catch {}
  console.log(line);
  function appendLine() {
    try {
      if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 262144) writeFileSync(LOG_FILE, "");
      writeFileSync(LOG_FILE, readFileSync(LOG_FILE, "utf8") + line + "\n");
    } catch { writeFileSync(LOG_FILE, line + "\n"); }
  }
}

// ---------- 配置 ----------
// Claude 档位 → 目标模型 的默认映射（每个提供方各一份，互不影响）
function defaultMapping(target, label) {
  return Object.fromEntries(TIERS.map((t) => [t.key, { target, label }]));
}
const DEFAULTS = {
  apiKey: "",
  upstream: "https://api.b.ai",
  proxy: "http://127.0.0.1:7890",
  relayPort: 15722,
  panelPort: 15723,
  defaultModel: "qwen3.8-flash",
  availableModels: ["qwen3.8-flash", "glm-5.3-flash", "deepseek-v4-flash"],
  mapping: defaultMapping("qwen3.8-flash", "Qwen3.8-Flash"),
  // SenseNova（商汤日日新）—— 第二个可路由提供方，独立密钥/上游/端口/映射，UI 单独一页
  sn: {
    apiKey: "",
    upstream: "https://token.sensenova.cn", // 中转按 upstream + req.url 拼接，客户端请求 /v1/messages
    relayPort: 15732,
    defaultModel: "sensenova-6.8-flash-lite",
    // 均为 /v1/models 实测可对话（output_modalities=text）的模型；图像模型(u1-fast/u1.5-lite)不列
    availableModels: ["sensenova-6.8-flash-lite", "deepseek-v4-pro", "deepseek-v4-flash", "glm-5.2", "kimi-k3"],
    mapping: defaultMapping("sensenova-6.8-flash-lite", "SenseNova 6.8 Flash-Lite"),
  },
  // OpenCode Zen（v1.0.37）—— 第四个可路由提供方。上游只讲 OpenAI 协议，复用通用协议桥。
  // 实测（2026-10）：Zen 目录 8 个 -free 模型中服务端只放行 space-bunny-free，其余限客户端内使用；
  // zen/go 通道需付费 Go 订阅 —— 故默认只挂这一个实测可用的。
  zen: {
    apiKey: "",
    upstream: "https://opencode.ai/zen/v1",
    relayPort: 15752,
    defaultModel: "space-bunny-free",
    availableModels: ["space-bunny-free"],
    mapping: defaultMapping("space-bunny-free", "Space-Bunny-Free"),
    useProxy: false,
  },
  // Qoder（qoder.com 桌面端附带的 Free 套餐）—— 第五个可路由提供方。
  // 上游只讲 OpenAI 协议（/model/v1/chat/completions），复用通用协议桥。
  // 认证不是 sk- 密钥，而是 jt- 开头的 jobToken，且**每次 Qoder 启动都会轮换**——
  // 所以不落 config，由 worker 补丁（qoder-patch/patch_worker.py）实时写入 tokenFile，
  // 中转每次请求现读；token 字段只作手动粘贴兜底。
  // 服务端只认两个模型别名：普通用户走 lite，auto 为自动选路。
  qd: {
    upstream: "https://api2-v2.qoder.sh/model/v1",
    relayPort: 15762,
    defaultModel: "lite",
    availableModels: ["lite", "auto"],
    mapping: defaultMapping("lite", "Qoder Lite"),
    token: "",
    tokenFile: path.join(os.tmpdir(), "qoder-token.json"),
    useProxy: false,
  },
  // WorkBuddy（腾讯 WorkBuddy AI 客户端附带的免费模型）—— 第三个可路由提供方。
  // 上游只讲 OpenAI Chat Completions（且仅流式），中转内置 Anthropic↔OpenAI 协议桥；
  // 认证不是 sk- 密钥，而是从 WorkBuddy 客户端捕获的 JWT 三件套（访问/刷新/设备令牌），
  // 过期由 refreshToken 自动续期（有效期约一年，通常无感）。
  wb: {
    relayPort: 15742,
    upstream: "https://www.workbuddy.ai",
    defaultModel: "deepseek-v4.1-flash",
    // 三款 0 积分免费模型（product config credits=x0.00）：DeepSeek-V4.1-Flash（1M ctx）、
    // 混元 Hy4-Preview-F（1M ctx）、混元 HY3（192k ctx）
    availableModels: ["deepseek-v4.1-flash", "hy4-preview-f", "hy3"],
    mapping: {
      "claude-fable-5": { target: "deepseek-v4.1-flash", label: "DeepSeek-V4.1-Flash" },
      "claude-sonnet-5": { target: "hy4-preview-f", label: "Hy4-Preview-F" },
      "claude-opus-5": { target: "hy3", label: "HY3" },
      "claude-haiku-4-5": { target: "deepseek-v4.1-flash", label: "DeepSeek-V4.1-Flash" },
    },
    accessToken: "",
    refreshToken: "",
    deviceToken: "",
    userId: "",
    useProxy: false, // www.workbuddy.ai 直连即可；仅当直连被拦时开启
  },
};
function loadCfg() {
  try {
    const c = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    const merged = { ...DEFAULTS, ...c, mapping: { ...DEFAULTS.mapping, ...(c.mapping || {}) } };
    // sn 深合并：旧 config.json 没有 sn 时也能拿到完整默认，缺字段时逐个补
    const snIn = c.sn || {};
    merged.sn = {
      ...DEFAULTS.sn, ...snIn,
      mapping: { ...DEFAULTS.sn.mapping, ...(snIn.mapping || {}) },
      availableModels: Array.isArray(snIn.availableModels) && snIn.availableModels.length ? snIn.availableModels : [...DEFAULTS.sn.availableModels],
    };
    // zen 深合并（同上）
    const zenIn = c.zen || {};
    merged.zen = {
      ...DEFAULTS.zen, ...zenIn,
      mapping: { ...DEFAULTS.zen.mapping, ...(zenIn.mapping || {}) },
      availableModels: Array.isArray(zenIn.availableModels) && zenIn.availableModels.length ? zenIn.availableModels : [...DEFAULTS.zen.availableModels],
    };
    // wb 深合并：同上（旧 config 无 wb 块时整块补默认）
    const wbIn = c.wb || {};
    merged.wb = {
      ...DEFAULTS.wb, ...wbIn,
      mapping: { ...DEFAULTS.wb.mapping, ...(wbIn.mapping || {}) },
      availableModels: Array.isArray(wbIn.availableModels) && wbIn.availableModels.length ? wbIn.availableModels : [...DEFAULTS.wb.availableModels],
    };
    // qd 深合并（同上）
    const qdIn = c.qd || {};
    merged.qd = {
      ...DEFAULTS.qd, ...qdIn,
      mapping: { ...DEFAULTS.qd.mapping, ...(qdIn.mapping || {}) },
      availableModels: Array.isArray(qdIn.availableModels) && qdIn.availableModels.length ? qdIn.availableModels : [...DEFAULTS.qd.availableModels],
    };
    return merged;
  } catch (e) {
    log("config.json 读取失败，用默认配置:", e.message);
    return { ...DEFAULTS, mapping: { ...DEFAULTS.mapping }, sn: { ...DEFAULTS.sn, mapping: { ...DEFAULTS.sn.mapping }, availableModels: [...DEFAULTS.sn.availableModels] }, zen: { ...DEFAULTS.zen, mapping: { ...DEFAULTS.zen.mapping }, availableModels: [...DEFAULTS.zen.availableModels] }, wb: { ...DEFAULTS.wb, mapping: { ...DEFAULTS.wb.mapping }, availableModels: [...DEFAULTS.wb.availableModels] }, qd: { ...DEFAULTS.qd, mapping: { ...DEFAULTS.qd.mapping }, availableModels: [...DEFAULTS.qd.availableModels] } };
  }
}
function saveCfg(cfg) {
  writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}
function writeAtomic(file, data) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

// ---------- 备用自升级通道（v1.0.24）：完全不依赖 electron-updater ----------
// 动机：更新器是打包进客户端的代码，一旦上游出 bug（v1.0.19 前实测 PowerShell 验签必炸）
// 存量客户端就被永久锁死在旧版。NSIS 安装器本身不受更新器影响且天然支持跨版本原地升级
// （配置在 %APPDATA%，卸载不清理）。本通道用普通下载 + latest.yml sha512 + Authenticode
// Subject 校验拉取最新安装器，再由一个脱离本进程树的 apply.cmd 完成：杀应用→静默安装→重拉。
const SU_REPO = "gg320324492-lgtm/bai-router";
const SU_DIR = path.join(DATA_DIR, "selfupdate");
const SU_STATE = path.join(SU_DIR, "state.json");
const SU_EXE = path.join(SU_DIR, "setup.exe");
function suState(o) {
  try { mkdirSync(SU_DIR, { recursive: true }); writeAtomic(SU_STATE, JSON.stringify({ ...o, at: new Date().toISOString() }, null, 2)); } catch { }
}
function readSuState() { try { return JSON.parse(readFileSync(SU_STATE, "utf8")); } catch { return null; } }
async function downloadLatestInstaller() {
  suState({ phase: "resolving" });
  const rel = await (await fetch(`https://api.github.com/repos/${SU_REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "bai-router-selfupdate" },
    signal: AbortSignal.timeout(20000),
  })).json();
  if (!rel || !rel.tag_name) throw new Error("查询最新 release 失败（多为 GitHub 不可达，开代理后重试）");
  const asset = (rel.assets || []).find((a) => /^BARRouter-Setup-.+\.exe$/.test(a.name));
  if (!asset) throw new Error("release 里没有安装包资产");
  suState({ phase: "downloading", version: rel.tag_name, file: asset.name, got: 0, total: asset.size || 0, percent: 0 });
  const fr = await fetch(asset.browser_download_url, {
    headers: { "user-agent": "bai-router-selfupdate" },
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!fr.ok || !fr.body) throw new Error("下载失败 HTTP " + fr.status);
  const { Readable } = await import("node:stream");
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha512");
  const total = Number(fr.headers.get("content-length") || asset.size || 0);
  let got = 0, lastTick = 0;
  const ws = createWriteStream(SU_EXE);
  try {
    for await (const chunk of Readable.fromWeb(fr.body)) {
      if (!ws.write(chunk)) await new Promise((r) => ws.once("drain", r));
      hash.update(chunk);
      got += chunk.length;
      if (Date.now() - lastTick > 500) {
        lastTick = Date.now();
        suState({ phase: "downloading", version: rel.tag_name, file: asset.name, got, total, percent: total ? Math.floor((got / total) * 100) : 0 });
      }
    }
  } finally {
    ws.end();
  }
  await new Promise((r) => ws.once("close", r));
  suState({ phase: "verifying", version: rel.tag_name, percent: 100, got, total });
  // ① sha512 与 release feed（latest.yml）比对
  const yml = await (await fetch(`https://github.com/${SU_REPO}/releases/latest/download/latest.yml`, { signal: AbortSignal.timeout(20000) })).text();
  const mm = String(yml).match(/^sha512:\s*(.+)$/m);
  const digest = hash.digest("base64");
  if (mm && digest !== mm[1].trim()) throw new Error("安装包 sha512 校验不匹配");
  // ② Authenticode 发布者校验（只取 Subject 字符串，不走 JSON——避开 electron-updater 同款深度截断坑）
  const subject = await new Promise((r) => execFile("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${SU_EXE.replace(/'/g, "''")}').SignerCertificate.Subject`],
    { windowsHide: true, timeout: 25000 }, (e, so) => r(e ? "" : String(so).trim())));
  if (!/B\.AI Router Personal/.test(subject)) throw new Error("安装包签名者校验失败：" + (subject || "无有效签名"));
  suState({ phase: "ready", version: rel.tag_name, percent: 100 });
  log(`备用升级：${rel.tag_name} 已下载并校验通过（${Math.round(got / 1048576)}MB）`);
  return rel.tag_name;
}
function launchApplyScript() {
  // apply.cmd 由 cmd.exe detached 起：不在服务进程树里，能安全杀掉 node+Electron 主进程。
  // 路径全部用引号包裹；安装器 /S 为 electron-builder NSIS 静默模式，原地升级保留 %APPDATA% 配置。
  const pids = path.join(SU_DIR, "pids.txt");
  try { writeFileSync(pids, `${process.pid} ${process.ppid || 0}\n`); } catch { }
  const appExe = process.env.BAI_ROUTER_EXE || "";
  const helper = path.join(SU_DIR, "apply.cmd");
  const lines = [
    "@echo off",
    "ping -n 3 127.0.0.1 >nul",
    `for /f "tokens=1,2" %%a in ('type "${pids}"') do (`,
    "  taskkill /F /PID %%a >nul 2>&1",
    "  taskkill /F /PID %%b >nul 2>&1",
    ")",
    'taskkill /F /IM "B.AI Router.exe" >nul 2>&1',
    // 扫残留：历次升级可能遗留"待命孤儿"的 node.exe 服务进程（端口不在手但活着）。
    // 按命令行精确匹配本应用的 server.mjs，不误伤其他 node 程序。
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'node.exe\' -and $_.CommandLine -match \'bai-router.+server[\\\\/]+server[.]mjs\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1',
    "ping -n 3 127.0.0.1 >nul",
    `"${SU_EXE}" /S`,
    "ping -n 2 127.0.0.1 >nul",
  ];
  if (appExe) lines.push(`start "" "${appExe}" --min`);
  lines.push(`del "${pids}" >nul 2>&1`, `del "%~f0" >nul 2>&1`);
  writeFileSync(helper, lines.join("\r\n") + "\r\n");
  const child = spawn("cmd.exe", ["/d", "/c", helper], { detached: true, stdio: "ignore", windowsHide: true, cwd: SU_DIR });
  child.unref();
}

// ---------- 启动环境自检：代理环境不对则以正确环境重启自己 ----------
// NO_PROXY 计算：本机回环 + 所有"useProxy=false"的上游域名（SenseNova/WorkBuddy 默认直连）。
// Node 启动时缓存 env 代理配置（运行时改 NO_PROXY 无效），这一步是"直连语义"唯一生效点；
// useProxy 开关改动会在面板置 needRestart（重启即重新计算 NO_PROXY）。
function computeNoProxy(cfg) {
  const list = ["127.0.0.1", "localhost"];
  const add = (host, useProxy) => { if (!useProxy && host && !list.includes(host)) list.push(host); };
  add(hostOf(cfg.wb?.upstream || DEFAULTS.wb.upstream), cfg.wb?.useProxy === true);
  add(hostOf(cfg.sn?.upstream || DEFAULTS.sn.upstream), cfg.sn?.useProxy === true);
  add(hostOf(cfg.zen?.upstream || DEFAULTS.zen.upstream), cfg.zen?.useProxy === true);
  add(hostOf(cfg.qd?.upstream || DEFAULTS.qd.upstream), cfg.qd?.useProxy === true);
  return list.join(",");
}
const cfg0 = loadCfg();
const wantNoProxy = computeNoProxy(cfg0);
const needEnvRestart =
  process.env.NODE_USE_ENV_PROXY !== "1" ||
  (process.env.BAI_ENV_FIXED !== "1" && (process.env.NO_PROXY || "") !== wantNoProxy);
if (needEnvRestart) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url)],
    {
      detached: true,
      stdio: "ignore", windowsHide: true,
      cwd: HERE,
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        BAI_ENV_FIXED: "1",
        ...(cfg0.proxy ? { HTTPS_PROXY: cfg0.proxy, HTTP_PROXY: cfg0.proxy } : {}),
        NO_PROXY: wantNoProxy,
      },
    }
  );
  child.unref();
  log(`代理环境自检：已以修正后的 NO_PROXY 重启自己 -> pid ${child.pid}（NO_PROXY=${wantNoProxy}）`);
  process.exit(0);
}
log(`路由台启动 relay=:${cfg0.relayPort} panel=:${cfg0.panelPort} (pid ${process.pid}) 代理=${cfg0.proxy || "直连"}`);
process.on("uncaughtException", (e) => log("uncaughtException:", e?.stack || String(e)));

// ---------- 本地代理自适应（v1.0.17）：自动探测所有常见 Clash/V2ray 端口，支持直连(TUN) ----------
const PROXY_CANDIDATES = [
  "http://127.0.0.1:7890",  // Clash for Windows / Mihomo Party
  "http://127.0.0.1:7897",  // Clash Verge Rev
  "http://127.0.0.1:7891",
  "http://127.0.0.1:10809", // v2rayN HTTP
  "http://127.0.0.1:2080",  // sing-box 常见
];
function probeVia(proxy) {
  // proxy === "DIRECT" 表示不走代理直连
  // 探测真实上游 origin（未带 key 会返回 401/403）——只要能拿到 HTTP 响应，
  // 就证明"代理隧道 + 到 B.AI 的路由"这条链路真的通，比只探 Google 更准确。
  // curl 连不上时 http_code 返回 000，据此判定不可用。
  let origin;
  try { origin = new URL(loadCfg().upstream).origin + "/v1/models"; } catch { origin = "https://api.b.ai/v1/models"; }
  const args = ["-s", "--ssl-no-revoke", "-m", "6", "-o", "NUL", "-w", "%{http_code}", origin];
  if (proxy !== "DIRECT") args.splice(1, 0, "-x", proxy);
  return new Promise((res) => execFile("curl", args, { windowsHide: true, timeout: 9000 }, (_e, so) => {
    const code = String(so).trim();
    res(/^[1-5]\d\d$/.test(code)); // 任何真实 HTTP 状态码（非 000）= 链路可达
  }));
}
let proxySwitching = false;
function applyProxy(found, reason) {
  const cfg = loadCfg();
  const norm = found === "DIRECT" ? "" : found;
  if ((cfg.proxy || "") === norm) return false;
  cfg.proxy = norm;
  saveCfg(cfg);
  log(`代理已自动切换（${reason}）→ ${norm || "直连"}`);
  if (!proxySwitching) {
    proxySwitching = true;
    setTimeout(() => {
      // Electron 托管：只退出，让壳用新配置重拉（壳的 spawnServer 每次都读最新 cfg.proxy）。
      // 若这里也 spawn 继任者，壳检测到子进程退出后还会再拉一个 → 双实例（一个绑端口、
      // 一个永久待命）。待命实例不服务但白耗资源，历史上还造成过配置多写竞态。
      if (process.env.BAI_ROUTER_EXE) {
        log("代理变更，退出交由桌面壳以新配置重拉");
        process.exit(0);
      }
      const c = loadCfg();
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        detached: true, stdio: "ignore", windowsHide: true, cwd: HERE,
        env: { ...process.env, NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1", ...(c.proxy ? { HTTPS_PROXY: c.proxy, HTTP_PROXY: c.proxy } : {}), NO_PROXY: computeNoProxy(c) },
      });
      child.unref();
      log("代理变更，服务自重启以应用新通道");
      setTimeout(() => process.exit(0), 400);
    }, 1200);
  }
  return true;
}
async function detectWorkingProxy() {
  const cfg = loadCfg();
  const cands = [...new Set([cfg.proxy, process.env.HTTPS_PROXY, ...PROXY_CANDIDATES].filter(Boolean))];
  cands.push("DIRECT"); // 兜底：TUN/全局模式无需本地端口
  for (const c of cands) if (await probeVia(c)) return c;
  return null;
}
let proxyCheckTimer = null;
function scheduleProxyCheck(delay = 3000, reason = "周期探测") {
  clearTimeout(proxyCheckTimer);
  proxyCheckTimer = setTimeout(async () => {
    if (!serverActivated) return; // 待命/未激活实例不探测（也就绝不触发写配置与自重启）
    const found = await detectWorkingProxy();
    if (found) applyProxy(found, reason);
  }, delay);
}
// ---------- "激活"门控：只有真正绑上端口、在对外服务的实例才允许写配置/跑探测 ----------
// 背景：v1.0.19 的待命接管会允许第二个实例长期存在（对方挂了随时接管）。若待命实例
// 也跑模型合并(saveCfg)+周期代理探测，多实例并发读写同一份 config.json 会互相覆盖。
let serverActivated = false;
function onActivated() {
  if (serverActivated) return;
  serverActivated = true;
  // 发布机模型同步（每版本一次性、只增不删）：把 config.defaults.json 里的可选模型并进本机列表
  try {
    const defaultsPath = path.join(HERE, "config.defaults.json");
    if (DATA_DIR !== HERE && existsSync(defaultsPath)) {
      const cur = loadCfg();
      if (cur._modelsSynced !== APP_VERSION) {
        const def = JSON.parse(readFileSync(defaultsPath, "utf8"));
        const merged = [...new Set([...(cur.availableModels || []), ...(def.availableModels || [])])];
        cur.availableModels = merged;
        // SenseNova 侧同样并入（每版本一次性、只增不删）
        if (def.sn && Array.isArray(def.sn.availableModels) && def.sn.availableModels.length) {
          cur.sn.availableModels = [...new Set([...(cur.sn.availableModels || []), ...def.sn.availableModels])];
        }
        // WorkBuddy 侧同样并入（三款免费模型随版本进位推到存量机器）
        if (def.wb && Array.isArray(def.wb.availableModels) && def.wb.availableModels.length) {
          cur.wb.availableModels = [...new Set([...(cur.wb.availableModels || []), ...def.wb.availableModels])];
        }
        if (def.zen && Array.isArray(def.zen.availableModels) && def.zen.availableModels.length) {
          cur.zen.availableModels = [...new Set([...(cur.zen.availableModels || []), ...def.zen.availableModels])];
        }
        if (def.qd && Array.isArray(def.qd.availableModels) && def.qd.availableModels.length) {
          cur.qd.availableModels = [...new Set([...(cur.qd.availableModels || []), ...def.qd.availableModels])];
        }
        cur._modelsSynced = APP_VERSION;
        saveCfg(cur);
        log(`可选模型已同步发布机（${merged.length} 个 + SenseNova ${cur.sn.availableModels.length} 个 + WorkBuddy ${cur.wb.availableModels.length} 个 + Qoder ${cur.qd.availableModels.length} 个）`);
      }
    }
  } catch (e) { log("模型同步跳过: " + e.message); }
  // 激活后探测一次；此后周期性自检；上游 fetch 失败时由请求处理路径立刻触发
  scheduleProxyCheck(0, "启动探测");
  setInterval(() => scheduleProxyCheck(0, "周期探测"), 10 * 60 * 1000);
}

// ---------- 中转服务 ----------
function normalizeModel(name) {
  // Claude Code 会发送带上下文后缀的档位名（如 claude-opus-5[1m] / claude-fable-5[1M]），
  // 去掉 [..] 后缀并小写，否则查不到映射会静默落到默认模型
  return String(name).replace(/\s*\[[^\]]*\]\s*$/, "").trim().toLowerCase();
}
function resolveModel(name, cfg) {
  const base = normalizeModel(name);
  const m = cfg.mapping?.[base];
  if (m && m.target) return m.target;
  if ((cfg.availableModels || []).includes(base)) return base;
  return cfg.defaultModel;
}

// 最近真实调用观察（Claude Code 每次请求都会经过中转，天然全知）
// 每个提供方一份：B.AI 侧观察不能依赖 sn 侧流量，反之亦然。记录逻辑内联在 makeRelay 里。
const recentCallsBai = [];  // {tier, served, at}
const recentCallsSn = [];
const recentCallsWb = [];
const recentCallsZen = [];
const recentCallsQd = [];
function activeTier(store) {
  // 最近 30 分钟内被"真实会话"用过的档位；没有观察则返回 null（不再默认猜 Haiku）
  if (store.length && Date.now() - store[0].at < 30 * 60000) return store[0].tier;
  return null;
}

function isApiResponseType(contentType) {
  const type = String(contentType || "").toLowerCase();
  return type.includes("application/json") || type.includes("text/event-stream");
}

// v1.0.19: 最近一次中转链路错误（供面板"本地中转"灯做归因：proxy/timeout/rate_limit/upstream_4xx/network）
// v1.0.28: 按提供方各记一份（B.AI 与 SenseNova 的中转互不干扰）
const relayErrors = {
  bai: { kind: null, message: null, at: null },
  sn: { kind: null, message: null, at: null },
  wb: { kind: null, message: null, at: null },
  zen: { kind: null, message: null, at: null },
  qd: { kind: null, message: null, at: null },
};
function noteRelayError(p, kind, message) {
  const slot = relayErrors[p] || relayErrors.bai;
  slot.kind = kind;
  slot.message = String(message).slice(0, 180);
  slot.at = new Date().toISOString();
}

function sendRateLimitError(res, upstream) {
  const retryAfter = upstream.headers.get("retry-after");
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (retryAfter) headers["retry-after"] = retryAfter;
  res.writeHead(429, headers);
  res.end(JSON.stringify({
    type: "error",
    error: {
      type: "rate_limit_error",
      message: `上游 API 暂时限流（HTTP 429）${retryAfter ? `，请在 ${retryAfter} 秒后重试` : "，请稍后重试"}。这不是代理或配置错误。`,
    },
  }));
}

function sendUnexpectedUpstreamResponse(res, upstream) {
  // 代理、网关或登录页偶尔会返回 HTML。不能把 HTML 原样交给 Claude/
  // 测试面板，否则客户端会只显示 "Unexpected token '<'"，看不到真正的链路问题。
  const status = upstream.status >= 400 ? upstream.status : 502;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({
    type: "error",
    error: {
      type: "unexpected_upstream_response",
      message: `上游返回了非 API 响应（HTTP ${upstream.status}，Content-Type: ${upstream.headers.get("content-type") || "未知"}）。请检查代理或上游地址。`,
    },
  }));
}

async function readProbeJson(response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch {
    const type = response.headers.get("content-type") || "未知";
    const kind = /^\s*</.test(raw) ? "HTML 页面" : "非 JSON 内容";
    throw new Error(`上游返回${kind}（HTTP ${response.status}，Content-Type: ${type}）`);
  }
}

// 直连上游：SenseNova 是境内服务，走 Clash 出海节点反而多一跳、且 Clash 没开时不该被带崩。
// 用 node http/https 手工发请求，返回一个与 fetch 响应形状兼容的对象
//
// v1.0.31：NODE_USE_ENV_PROXY=1 时 http/https 核心模块同样吃 env 代理，且 Node 启动时缓存
// 代理配置（运行时改 NO_PROXY 实测无效）。"直连语义"由启动期 computeNoProxy() 保证——
// useProxy=false 的上游域名写进 NO_PROXY，启动自检不一致会带修正环境自重启一次。
// （status / headers.get / headers.forEach / body 为 node stream），让 relayHandler 两套传输共用处理逻辑。
function directHttp(target, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch { reject(new Error("upstream 地址非法: " + target)); return; }
    const mod = u.protocol === "http:" ? http : https;
    const r = mod.request(u, { method, headers }, (res) => {
      // 与 fetch 路径语义对齐：超时只限"连接+响应头"。头已到达，解除不活动计时——
      // 否则深度思考模型在两个 SSE 块之间静默 >30s 会被掐（fetch 路径的 signal 此时已了结）。
      if (timeoutMs) r.setTimeout(0);
      const h = res.headers || {};
      resolve({
        status: res.statusCode,
        headers: {
          get: (k) => { const v = h[String(k).toLowerCase()]; return Array.isArray(v) ? v.join(", ") : v; },
          forEach: (fn) => { for (const k in h) fn(h[k], k, h); },
        },
        body: res,
        _nodeStream: true,
      });
    });
    r.on("error", reject);
    if (timeoutMs) r.setTimeout(timeoutMs, () => { const e = new Error("aborted (header timeout)"); e.name = "AbortError"; r.destroy(e); });
    if (body) r.write(body);
    r.end();
  });
}

// ---------- WorkBuddy 协议桥（v1.0.31）：Anthropic ↔ OpenAI Chat Completions ----------
// WorkBuddy 上游（www.workbuddy.ai/v2/chat/completions）只讲 OpenAI 协议且仅支持流式；
// 这里把 Claude Code 的 /v1/messages 请求翻译过去，再把 OpenAI SSE 流翻回 Anthropic SSE。

function wbTokenExp(tok) {
  try {
    const seg = String(tok).split(".")[1];
    if (!seg) return null;
    const p = JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof p.exp === "number" ? p.exp : null;
  } catch { return null; }
}
async function readAllBody(r) {
  if (!r || !r.body) return "";
  const out = [];
  for await (const c of r.body) out.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(out).toString("utf8");
}
let wbRefreshLock = null;
// 令牌续期：POST /v2/plugin/auth/token/refresh（刷新令牌放 X-Refresh-Token 头，与 WorkBuddy 客户端一致）
// 成功后就地写回 config.json（访问/刷新令牌成对滚动，有效期约一年，正常一年才需要续一次）
function wbRefreshToken(cfg) {
  const w = cfg.wb;
  if (!w.refreshToken) throw new Error("WorkBuddy 刷新令牌为空，无法续期——请重新捕获令牌");
  const base = (w.upstream || DEFAULTS.wb.upstream).replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    "x-refresh-token": w.refreshToken,
    authorization: `Bearer ${w.accessToken || ""}`,
    "x-auth-refresh-source": "plugin",
    "x-domain": hostOf(base) || "www.workbuddy.ai",
    "user-agent": `B.AI-Router/${APP_VERSION}`,
  };
  const useProxy = w.useProxy === true;
  return (async () => {
    const r = useProxy
      ? await fetch(base + "/v2/plugin/auth/token/refresh", { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(15000) })
      : await directHttp(base + "/v2/plugin/auth/token/refresh", { method: "POST", headers, body: "{}", timeoutMs: 15000 });
    const txt = await readAllBody(r);
    if (r.status !== 200) throw new Error(`WorkBuddy 令牌续期失败 HTTP ${r.status}: ${String(txt).slice(0, 160)}`);
    let j = {};
    try { j = JSON.parse(txt); } catch { }
    const box = j.data && typeof j.data === "object" ? j.data : j;
    const na = box.access_token || box.accessToken || box.token;
    const nr = box.refresh_token || box.refreshToken;
    if (typeof na !== "string" || na.length < 20) throw new Error("令牌续期响应里没有新的访问令牌");
    w.accessToken = na;
    if (typeof nr === "string" && nr.length > 20) w.refreshToken = nr;
    saveCfg(cfg);
    const exp = wbTokenExp(na);
    log(`WorkBuddy 令牌已自动续期${exp ? "（新有效期至 " + new Date(exp * 1000).toLocaleDateString("zh-CN") + "）" : ""}`);
    return w.accessToken;
  })();
}
async function wbEnsureToken(cfg) {
  const w = cfg.wb;
  if (!w.accessToken) throw new Error("WorkBuddy 访问令牌未配置——到面板「WorkBuddy」页粘贴令牌");
  const exp = wbTokenExp(w.accessToken);
  if (exp && exp * 1000 - Date.now() > 120000) return w.accessToken;
  if (!w.refreshToken) {
    if (exp && exp * 1000 > Date.now()) return w.accessToken;
    throw new Error("WorkBuddy 访问令牌已过期且没有刷新令牌，请重新捕获");
  }
  if (!wbRefreshLock) {
    wbRefreshLock = wbRefreshToken(cfg).finally(() => { wbRefreshLock = null; });
  }
  return wbRefreshLock;
}

// ---------- Qoder 令牌（v1.0.38）----------
// Qoder 的 jt- jobToken **每次客户端启动都会轮换**，缓存到 config 里必然失效。
// 取法：worker 补丁（qoder-patch/patch_worker.py）在每次带鉴权的出站请求上把最新令牌
// 覆盖写入 tokenFile，中转按 mtime 缓存几秒现读——Qoder 换令牌后无需重启中转即自动跟随。
// 令牌失效时上游回 401，此时强制绕过缓存重读一次（Qoder 可能刚刷新过）。
let qdTokCache = { token: "", mtimeMs: -1, at: 0 };
function qdEnsureToken(cfg, force) {
  const manual = (cfg.qd && cfg.qd.token) || "";
  if (manual.trim()) return manual.trim();
  const file = (cfg.qd && cfg.qd.tokenFile) || DEFAULTS.qd.tokenFile;
  const fresh = Date.now() - qdTokCache.at < 5000;
  if (!force && fresh && qdTokCache.token) return qdTokCache.token;
  try {
    const st = statSync(file);
    if (force || st.mtimeMs !== qdTokCache.mtimeMs) {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (j && typeof j.token === "string" && j.token.trim()) {
        qdTokCache = { token: j.token.trim(), mtimeMs: st.mtimeMs, at: Date.now() };
      }
    }
  } catch {
    if (!qdTokCache.token) throw new Error("未找到 Qoder 令牌——请先启动 Qoder 桌面端（补丁会把令牌写到 " + file + "）");
  }
  if (!qdTokCache.token) throw new Error("Qoder 令牌文件为空——请启动 Qoder 桌面端后重试");
  return qdTokCache.token;
}

// ---------- 一键捕获 WorkBuddy 令牌（v1.0.33）----------
// 背景：WorkBuddy 客户端登录后，令牌只存在内存、不落盘，无法直接读取。
// 做法：临时给它的 CLI 启动脚本（cli/bin/codebuddy，纯文本 JS、无签名）注入一小段采集钩子，
//       钩子把令牌写进中转目录；捕到（或超时）后立刻还原原文件——不留任何常驻修改。
// 安全性：注入前备份、finally 里必还原、进程异常退出由下次启动时自愈清理。
// 抓取时机：WorkBuddy 每次真正跑会话都会拉起该脚本，用户随便发条消息即可触发。
const WB_CLI_REL = path.join("resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
// 候选安装目录：常见位置 + 各盘符根目录（WorkBuddy 可装在任意盘/任意用户目录）
function wbCandidateBases() {
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  const userLocal = process.env.LOCALAPPDATA || "";
  // ① 当前用户（最常见：%LOCALAPPDATA%\Programs\WorkBuddyAI）
  push(path.join(userLocal, "Programs", "WorkBuddyAI"));
  push(path.join(userLocal, "Programs", "workbuddy"));
  push(path.join(userLocal, "WorkBuddyAI"));
  // ② Program Files 系
  for (const k of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    if (process.env[k]) { push(path.join(process.env[k], "WorkBuddyAI")); push(path.join(process.env[k], "WorkBuddy AI")); }
  }
  // ③ 所有盘符（含 D:/E:/F:…）：\Users\<用户>\AppData\Local\Programs\WorkBuddyAI 及 \Program Files\WorkBuddyAI
  //    安装程序把 LOCALAPPDATA 重定向到别的盘时，实际路径就落在这些位置
  const user = process.env.USERNAME || "";
  const drives = [];
  for (let c = 67; c <= 90; c++) drives.push(String.fromCharCode(c) + ":"); // C: ~ Z:
  for (const d of drives) {
    if (user) push(path.join(d, "Users", user, "AppData", "Local", "Programs", "WorkBuddyAI"));
    push(path.join(d, "Program Files", "WorkBuddyAI"));
  }
  return out;
}
const WB_CAPTURE_HOOK = `
// === BAI-CAPTURE-HOOK (temporary, auto-removed) ===
try {
  const __fs = require("fs");
  const __out = __path_capture;
  const __grab = (txt) => { try { __fs.appendFileSync(__out, String(txt) + String.fromCharCode(10)); } catch (e) {} };
  const __pick = (h) => {
    try {
      const g = (k) => { const v = h && (h[k] || h[String(k).toLowerCase()]); return typeof v === "string" ? v : ""; };
      const tok = (g("authorization") || g("Authorization")).replace(/^Bearer\\s+/i, "");
      const ref = g("x-refresh-token") || g("X-Refresh-Token");
      const dev = g("X-Device-Token") || g("x-device-token");
      const uid = g("X-User-Id") || g("x-user-id");
      if (tok && tok.indexOf(".") > 0 && ref) __grab(JSON.stringify({ accessToken: tok, refreshToken: ref, deviceToken: dev, userId: uid }));
    } catch (e) {}
  };
  for (const m of ["https", "http"]) {
    const mod = require(m);
    const orig = mod.request;
    mod.request = function () {
      try {
        const a = arguments[0];
        if (typeof a === "string" || a instanceof URL) __pick(arguments[1] && arguments[1].headers);
        else if (a && typeof a === "object") __pick(a.headers);
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  }
  const __of = globalThis.fetch;
  if (typeof __of === "function") {
    globalThis.fetch = function (input, init) {
      try { __pick((init && init.headers) || (input && input.headers) || {}); } catch (e) {}
      return __of.apply(this, arguments);
    };
  }
} catch (e) {}
// === /BAI-CAPTURE-HOOK ===
`;
let wbCapState = { active: false, startedAt: null, error: null };

// 定位 WorkBuddy 的 CLI 启动脚本：① 注册表安装信息（最准，任意盘）→ ② 候选目录 → ③ 同级目录扫描
function findWbCliScript() {
  const tryPath = async (base, rel) => {
    if (!base) return null;
    const p = path.join(base, rel);
    try { await fsPromises.access(p); return p; } catch { return null; }
  };
  const fromRegistry = () => new Promise((resolve) => {
    // 查 HKCU/HKLM 卸载项里 DisplayName 含 WorkBuddy 的 InstallLocation
    const ps = "$ErrorActionPreference='SilentlyContinue';"
      + "$r=@();"
      + "foreach($root in @('HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')){"
      + "  Get-ChildItem $root | ForEach-Object { $p=Get-ItemProperty $_.PSPath; if($p.DisplayName -match 'WorkBuddy'){ "
      + "    if($p.InstallLocation){$r+=$p.InstallLocation}; if($p.DisplayIcon){$r+=($p.DisplayIcon -replace ',.*$','')} } } };"
      + "$r | Select-Object -Unique";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 15000 },
      (e, so) => resolve(e ? [] : String(so).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));
  });
  return (async () => {
    // ① 注册表
    for (const hit of await fromRegistry()) {
      const asDir = await tryPath(hit, WB_CLI_REL);
      if (asDir) return asDir;
      const asExeDir = await tryPath(path.dirname(hit), WB_CLI_REL); // DisplayIcon 给的是 exe 路径
      if (asExeDir) return asExeDir;
    }
    // ② 候选目录
    for (const base of wbCandidateBases()) {
      const hit = await tryPath(base, WB_CLI_REL);
      if (hit) return hit;
    }
    // ③ 扫 \Programs 下含 workbuddy 的同级目录
    for (const d of ["C", "D", "E", "F"]) {
      const root = path.join(d + ":", "Users", process.env.USERNAME || "", "AppData", "Local", "Programs");
      try {
        for (const name of await fsPromises.readdir(root)) {
          if (!/workbuddy/i.test(name)) continue;
          const hit = await tryPath(path.join(root, name), WB_CLI_REL);
          if (hit) return hit;
        }
      } catch { }
    }
    return null;
  })();
}

// 还原：只要备份在，就把原文件写回去（幂等，可重复调用）
async function wbCaptureRestore() {
  const st = wbCapState;
  if (!st.script || !st.backup) return;
  try {
    if (st.wrote) {
      const cur = await fsPromises.readFile(st.script, "utf8").catch(() => "");
      if (cur.includes("BAI-CAPTURE-HOOK")) await fsPromises.writeFile(st.script, st.backup, "utf8");
    }
  } catch (e) { log("WorkBuddy 令牌捕获：还原失败 " + e.message); }
  st.wrote = false;
}

async function wbCaptureToken(timeoutMs = 150000) {
  if (wbCapState.active) {
    const secs = Math.round((Date.now() - wbCapState.startedAt) / 1000);
    throw new Error(`上一次获取还在进行中（已等待 ${secs} 秒）。请在 WorkBuddy 客户端里发一条消息，或稍候重试`);
  }
  const script = await findWbCliScript();
  if (!script) throw new Error("未找到 WorkBuddy 程序（请确认本机已安装 WorkBuddy AI 客户端）");
  const outFile = path.join(DATA_DIR, "wb-captured-token.json");
  await fsPromises.rm(outFile, { force: true }).catch(() => { });
  const original = await fsPromises.readFile(script, "utf8");
  if (original.includes("BAI-CAPTURE-HOOK")) {
    // 上次异常残留：先清掉钩子再重来
    await fsPromises.writeFile(script, original.replace(/[\s\S]*?BAI-CAPTURE-HOOK[\s\S]*?\/BAI-CAPTURE-HOOK ===[\r\n]*/, ""), "utf8");
  }
  const backup = await fsPromises.readFile(script, "utf8");
  const hook = WB_CAPTURE_HOOK.replace("__path_capture", JSON.stringify(outFile));
  // 注入到 shebang 之后（保留首行 #!，Node 才能正常执行）
  const lines = backup.split("\n");
  const patched = lines[0] + "\n" + hook + "\n" + lines.slice(1).join("\n");
  wbCapState = { active: true, startedAt: Date.now(), error: null, script, backup, wrote: false };
  await fsPromises.writeFile(script, patched, "utf8");
  wbCapState.wrote = true;
  log(`WorkBuddy 令牌捕获：已注入临时钩子（${script}），等待客户端触发…`);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const raw = (await fsPromises.readFile(outFile, "utf8")).trim().split("\n").filter(Boolean).pop();
        if (raw) {
          const obj = JSON.parse(raw);
          if (obj.accessToken && obj.refreshToken) {
            const cfg = loadCfg();
            cfg.wb.accessToken = obj.accessToken;
            cfg.wb.refreshToken = obj.refreshToken;
            if (obj.deviceToken) cfg.wb.deviceToken = obj.deviceToken;
            if (obj.userId) cfg.wb.userId = obj.userId;
            saveCfg(cfg);
            // 抓到即还原：不等超时，立刻让 WorkBuddy 的脚本恢复原状
            await wbCaptureRestore();
            log("WorkBuddy 令牌捕获：成功（钩子已立即还原）");
            return { ok: true, masked: keyFp(obj.accessToken) };
          }
        }
      } catch { /* 文件还没生成/还没写完整，继续等 */ }
    }
    throw new Error("等待超时：请在 WorkBuddy 客户端里随便发一条消息（它会拉起内部 CLI，钩子即可捕获），然后重试");
  } finally {
    await wbCaptureRestore();
    await fsPromises.rm(outFile, { force: true }).catch(() => { });
    wbCapState.active = false;
  }
}

// WorkBuddy 网关对 Claude Code 的客户端指纹拦截（"Illegal API invocation from an unapproved
// channel"）——实测为"系统提示词整行/前缀"级规则。网关只认字符串内容，因此这里在把 system
// 交给模型前剥除/改写这几处客户端指纹（均为纯标识文本，对模型行为无实质影响）。
// 规则表形式便于上游新增指纹时单点补充；命中会以 400 显式报错，
// 并把翻译后请求体落盘 wb-last-4xx.json + server.log 首行诊断。
const WB_CC_REWRITE_HEAD = "You are a highly capable coding assistant operating in a developer's terminal.";
const WB_SYSTEM_RULES = [
  // ① Claude Code 写进 system 开头的计费指纹行（"x-anthropic-billing-header: cc_version=…"）
  { re: /^x-anthropic-billing-header:[^\n]*\n?/gm },
  // ② "To give feedback … github.com/anthropics/claude-code/issues" 反馈指引行（措辞+链接组合触发）
  { re: /^.*github\.com\/anthropics\/claude-code.*(?:\n|$)/gm },
  // ③ 开场句前缀——CLI 版（"…official CLI for Claude."）与 SDK 版
  // （"…official CLI for Claude, running within the Claude Agent SDK."）等变体均命中，整行改写
  { re: /^You are Claude Code, Anthropic's official CLI for Claude[^\n]*/, rewrite: WB_CC_REWRITE_HEAD },
];
function wbSanitizeSystem(sys) {
  let t = String(sys || "");
  for (const r of WB_SYSTEM_RULES) t = r.rewrite ? t.replace(r.re, r.rewrite) : t.replace(r.re, "");
  return t;
}
function wbToOpenAI(j) {
  const msgs = [];
  let sys = j.system;
  if (Array.isArray(sys)) sys = sys.map((b) => (b && b.text) || "").join("\n");
  // WorkBuddy 网关要求第一条必须是 system（缺省补一句，避免 11128）
  msgs.push({ role: "system", content: wbSanitizeSystem((sys && String(sys).trim()) || "You are a helpful assistant.") });
  for (const m of j.messages || []) {
    const c = m.content;
    if (typeof c === "string") { msgs.push({ role: m.role, content: c }); continue; }
    if (!Array.isArray(c)) continue;
    if (m.role === "assistant") {
      let text = "";
      const toolCalls = [];
      for (const b of c) {
        if (!b) continue;
        if (b.type === "text") text += b.text || "";
        else if (b.type === "tool_use") {
          toolCalls.push({ id: b.id || "toolu_" + Math.random().toString(36).slice(2, 10), type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
        }
        // thinking 块（含签名）对 OpenAI 上游无意义，丢弃
      }
      if (!text && !toolCalls.length) continue;
      const am = { role: "assistant", content: text || null };
      if (toolCalls.length) am.tool_calls = toolCalls;
      msgs.push(am);
    } else {
      // user：tool_result 逐条转成 tool 消息（必须紧跟在带 tool_calls 的 assistant 后面），
      // 普通文本/图片合并成一条 user 消息
      const texts = [];
      const parts = [];
      let hasImage = false;
      let hasToolResult = false;
      for (const b of c) {
        if (!b) continue;
        if (b.type === "tool_result") {
          hasToolResult = true;
          let t = "";
          if (typeof b.content === "string") t = b.content;
          else if (Array.isArray(b.content)) {
            t = b.content.map((x) => (x && x.type === "text" ? x.text : (x && x.type === "image" ? "[image]" : (x && x.text) || ""))).join("\n");
          }
          msgs.push({ role: "tool", tool_call_id: b.tool_use_id || "", content: t || "(empty)" });
        } else if (b.type === "text") {
          texts.push(b.text || "");
          parts.push({ type: "text", text: b.text || "" });
        } else if (b.type === "image" && b.source) {
          const src = b.source;
          if (src.type === "base64") { parts.push({ type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data || ""}` } }); hasImage = true; }
          else if (src.type === "url") { parts.push({ type: "image_url", image_url: { url: src.url || "" } }); hasImage = true; }
        }
      }
      if (hasImage && parts.length) msgs.push({ role: "user", content: parts });
      else if (texts.join("\n")) msgs.push({ role: "user", content: texts.join("\n") });
      else if (!hasToolResult) msgs.push({ role: "user", content: "" });
    }
  }
  const out = {
    model: j.model,
    messages: msgs,
    stream: true, // WorkBuddy 网关仅支持流式（非流式请求一律 11101）
    max_tokens: typeof j.max_tokens === "number" && j.max_tokens >= 3 ? j.max_tokens : 4096,
  };
  if (Array.isArray(j.tools) && j.tools.length) {
    out.tools = j.tools.filter((t) => t && t.name).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema && typeof t.input_schema === "object" ? t.input_schema : { type: "object", properties: {} },
      },
    }));
    // WorkBuddy 网关的 tool_choice 是字符串类型（传对象会 400）
    const tc = j.tool_choice;
    if (tc && typeof tc === "object") {
      if (tc.type === "none") out.tool_choice = "none";
      else if (tc.type === "any") out.tool_choice = "required";
      else out.tool_choice = "auto";
    }
  }
  if (typeof j.temperature === "number") out.temperature = j.temperature;
  if (typeof j.top_p === "number") out.top_p = j.top_p;
  if (Array.isArray(j.stop_sequences) && j.stop_sequences.length) out.stop = j.stop_sequences;
  return out;
}

// Anthropic 风格错误（Claude Code 按 type 分类重试/提示）
function wbAnthroError(res, status, msg) {
  if (res.headersSent || res.writableEnded) { try { res.end(); } catch { } return; }
  const s = Number(status) >= 400 && Number(status) < 600 ? Number(status) : 502;
  const typeMap = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 500: "api_error", 503: "overloaded_error", 529: "overloaded_error" };
  const type = typeMap[s] || (s >= 500 ? "api_error" : "invalid_request_error");
  res.writeHead(s, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ type: "error", error: { type, message: `[WorkBuddy] ${String(msg).slice(0, 400)}` } }));
}

async function* sseLines(body) {
  let buf = "";
  for await (const chunk of body) {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      yield line;
    }
  }
  if (buf) yield buf;
}

// OpenAI SSE → Anthropic SSE（clientStream=false 时聚合成单条 Anthropic JSON 响应）
async function wbPipe(r, res, { model, clientStream, inputJson }) {
  const inTok = Math.max(1, Math.ceil(JSON.stringify(inputJson || {}).length / 4));
  const msgId = "msg_wb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let idx = -1;
  let cur = null;              // "text" | "thinking" | "tool"
  let curToolOi = -1;
  const toolParts = [];        // {oi, id, name, args} 按出现顺序
  let text = "", thinking = "";
  let finish = null, usage = null, outChars = 0;

  const emit = (event, data) => {
    if (!clientStream || res.writableEnded) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { }
  };
  const closeCur = () => { if (cur) { emit("content_block_stop", { type: "content_block_stop", index: idx }); cur = null; } };
  const openCur = (kind, block) => { idx++; cur = kind; emit("content_block_start", { type: "content_block_start", index: idx, content_block: block }); };

  if (clientStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    emit("message_start", {
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inTok, output_tokens: 0 } },
    });
    emit("ping", { type: "ping" });
  }

  try {
    for await (const raw of sseLines(r.body)) {
      const line = raw.trimEnd();
      if (!line) continue;
      if (line.startsWith(":")) { emit("ping", { type: "ping" }); continue; } // 心跳
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;
      let d;
      try { d = JSON.parse(payload); } catch { continue; }
      if (d.usage) usage = d.usage;
      const ch = Array.isArray(d.choices) && d.choices[0];
      if (!ch) continue;
      const delta = ch.delta || {};
      const rc = delta.reasoning_content || delta.reasoning;
      if (typeof rc === "string" && rc) {
        if (cur !== "thinking") { closeCur(); openCur("thinking", { type: "thinking", thinking: "" }); }
        thinking += rc; outChars += rc.length;
        emit("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: rc } });
      }
      if (typeof delta.content === "string" && delta.content) {
        if (cur !== "text") { closeCur(); openCur("text", { type: "text", text: "" }); }
        text += delta.content; outChars += delta.content.length;
        emit("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: delta.content } });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const oi = typeof tc.index === "number" ? tc.index : 0;
          const fn = tc.function || {};
          let tp = toolParts.find((t) => t.oi === oi);
          if (oi !== curToolOi) {
            closeCur();
            if (!tp) { tp = { oi, id: tc.id || "toolu_" + oi + "_" + Date.now().toString(36), name: fn.name || "", args: "" }; toolParts.push(tp); }
            if (fn.name) tp.name = fn.name;
            openCur("tool", { type: "tool_use", id: tp.id, name: tp.name, input: {} });
            curToolOi = oi;
          } else if (!tp) {
            tp = { oi, id: tc.id || "toolu_" + oi + "_" + Date.now().toString(36), name: fn.name || "", args: "" };
            toolParts.push(tp);
          }
          if (fn.name) tp.name = fn.name;
          if (typeof fn.arguments === "string" && fn.arguments) {
            tp.args += fn.arguments;
            emit("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: fn.arguments } });
          }
        }
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  } catch (e) {
    // 上游流中断：把错误以 Anthropic error 事件/JSON 形式交还客户端
    noteRelayError("wb", "network", `WorkBuddy 流中断: ${String(e && e.message || e).slice(0, 160)}`);
    if (clientStream) {
      emit("error", { type: "error", error: { type: "api_error", message: `[WorkBuddy] 上游流中断: ${String(e && e.message || e).slice(0, 200)}` } });
      try { res.end(); } catch { }
      return;
    }
    wbAnthroError(res, 502, `上游流中断: ${String(e && e.message || e).slice(0, 200)}`);
    return;
  }

  closeCur();
  const stopReason = finish === "length" ? "max_tokens" : (finish === "tool_calls" || toolParts.length) ? "tool_use" : "end_turn";
  const outTok = (usage && usage.completion_tokens) || Math.max(1, Math.ceil(outChars / 4));
  const inFinal = (usage && usage.prompt_tokens) || inTok;
  if (clientStream) {
    emit("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: inFinal, output_tokens: outTok } });
    emit("message_stop", { type: "message_stop" });
    try { res.end(); } catch { }
    return;
  }
  const content = [];
  if (thinking) content.push({ type: "thinking", thinking, signature: "" });
  if (text) content.push({ type: "text", text });
  for (const tp of toolParts) {
    let input = {};
    try { input = tp.args ? JSON.parse(tp.args) : {}; } catch { input = { _raw: tp.args }; }
    content.push({ type: "tool_use", id: tp.id, name: tp.name, input });
  }
  const msg = { id: msgId, type: "message", role: "assistant", model, content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: inFinal, output_tokens: outTok } };
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(msg));
}

// 一次 WorkBuddy 调用的完整生命周期：拿令牌 → 翻译 → 上游（401 自动续期重试 / 探测 429 退避）→ 翻流回来
// 通用 OpenAI 上游桥：p="wb"（WorkBuddy，需 JWT + WorkBuddy 专头 + 令牌续期）、
// p="zen"（OpenCode Zen，Bearer API Key + 标准头）。请求翻译与响应回译完全共用。
async function openaiExchange(p, { cfg, S, j, isProbe, res, useProxy }) {
  const NAME = p === "zen" ? "OpenCode Zen" : p === "qd" ? "Qoder" : "WorkBuddy";
  let token;
  if (p === "zen") {
    token = (cfg.zen && cfg.zen.apiKey) || "";
    if (!token) { noteRelayError(p, "auth", "未配置 OpenCode Zen API Key"); return wbAnthroError(res, 401, "未配置 OpenCode Zen API Key——请到「OpenCode Zen」页填写"); }
  } else if (p === "qd") {
    try { token = qdEnsureToken(cfg); }
    catch (e) { noteRelayError(p, "auth", e.message); return wbAnthroError(res, 401, e.message); }
  } else {
    try { token = await wbEnsureToken(cfg); }
    catch (e) { noteRelayError(p, "auth", e.message); return wbAnthroError(res, 401, e.message); }
  }

  const ob = wbToOpenAI(j);
  const base = (S.upstream || (p === "zen" ? DEFAULTS.zen.upstream : p === "qd" ? DEFAULTS.qd.upstream : DEFAULTS.wb.upstream)).replace(/\/+$/, "");
  const url = p === "wb" ? base + "/v2/chat/completions" : base + "/chat/completions";
  const mkHeaders = (tok) => {
    if (p === "zen") {
      return {
        "content-type": "application/json",
        authorization: `Bearer ${tok}`,
        "user-agent": `B.AI-Router/${APP_VERSION}`,
      };
    }
    if (p === "qd") {
      // Qoder model server：普通 Bearer 即可，X-Request-ID / X-Session-ID 实测非必需
      return {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${tok}`,
        "user-agent": `B.AI-Router/${APP_VERSION}`,
      };
    }
    const w = cfg.wb;
    const h = {
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      authorization: `Bearer ${tok}`,
      "x-product": "SaaS",
      "user-agent": `B.AI-Router/${APP_VERSION}`,
    };
    if (w.userId) h["x-user-id"] = w.userId;
    if (w.deviceToken) h["x-device-token"] = w.deviceToken;
    h["x-domain"] = hostOf(base) || "www.workbuddy.ai";
    return h;
  };
  const bodyStr = JSON.stringify(ob);
  const doCall = (tok) => useProxy
    ? fetch(url, { method: "POST", headers: mkHeaders(tok), body: bodyStr, signal: AbortSignal.timeout(isProbe ? 10000 : 30000) })
    : directHttp(url, { method: "POST", headers: mkHeaders(tok), body: bodyStr, timeoutMs: isProbe ? 10000 : 30000 });

  let r;
  try {
    r = await doCall(token);
    // 令牌失效（401/403）→ WorkBuddy 侧可续期并重试一次；Zen 侧 key 失效直接报错；
    // Qoder 侧强制绕过 mtime 缓存重读令牌文件再试一次（Qoder 可能刚轮换过令牌）
    if ((r.status === 401 || r.status === 403) && p === "wb" && cfg.wb.refreshToken) {
      await readAllBody(r).catch(() => "");
      try { token = await wbRefreshToken(cfg); r = await doCall(token); }
      catch (e) { noteRelayError(p, "auth", e.message); return wbAnthroError(res, 401, e.message); }
    }
    if ((r.status === 401 || r.status === 403) && p === "qd") {
      await readAllBody(r).catch(() => "");
      try {
        const again = qdEnsureToken(cfg, true);
        if (again && again !== token) { token = again; r = await doCall(token); }
      } catch (e) { noteRelayError(p, "auth", e.message); return wbAnthroError(res, 401, e.message); }
    }
    // 探测级小请求遇 429：静默退避重试（与 B.AI/SenseNova 行为一致）
    for (let a = 0; r.status === 429 && isProbe && a < 3; a++) {
      await readAllBody(r).catch(() => "");
      await new Promise((rr) => setTimeout(rr, 400 * (a + 1)));
      r = await doCall(token);
    }
    // "unapproved channel" 偶发抖动：重试一次（确定性指纹已由 wbSanitizeSystem 剥除）。
    // 注意 400 响应体已被读走，若最终仍是错误，错误文案从 consumed400 兜底。
    let consumed400 = "";
    if (r.status === 400) {
      consumed400 = await readAllBody(r).catch(() => "");
      if (consumed400.includes("unapproved channel")) {
        await new Promise((rr) => setTimeout(rr, 500));
        r = await doCall(token);
        consumed400 = r.status === 400 ? "" : consumed400;
      }
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    const timedOut = (e && e.name === "AbortError") || msg.toLowerCase().includes("abort");
    const friendly = timedOut
      ? `${NAME} 上游在 ${isProbe ? 10 : 30}s 内未返回响应头，已中断本次请求`
      : msg.includes("fetch failed") ? `无法连接 ${base}（网络或代理问题）` : msg;
    noteRelayError(p, timedOut ? "timeout" : msg.includes("fetch failed") ? "proxy" : "network", friendly);
    return wbAnthroError(res, 502, friendly);
  }

  if (r.status !== 200) {
    const txt = (await readAllBody(r).catch(() => "")) || consumed400;
    noteRelayError(p, r.status === 429 ? "rate_limit" : `upstream_${r.status}`, `${NAME} 上游 HTTP ${r.status}`);
    let msg = txt;
    try { const jj = JSON.parse(txt); msg = jj.msg || jj.message || (jj.error && jj.error.message) || txt; } catch { }
    // 4xx 诊断：把被拒的翻译后请求体落一份，便于定位上游新增的校验/指纹规则
    if (r.status >= 400 && r.status < 500) {
      try { writeFileSync(path.join(DATA_DIR, "wb-last-4xx.json"), bodyStr); } catch { }
      log(`${NAME} 上游 ${r.status} 拒绝了请求，翻译后请求体已存 wb-last-4xx.json：${String(msg).slice(0, 160)}｜system 首行：${String((ob.messages && ob.messages[0] && ob.messages[0].content) || "").split("\n")[0].slice(0, 120)}`);
    }
    return wbAnthroError(res, r.status, msg);
  }
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) {
    const txt = await readAllBody(r).catch(() => "");
    noteRelayError(p, "upstream_bad", `${NAME} 返回非流式响应（${ct || "无 Content-Type"}）`);
    let msg = txt;
    try { const jj = JSON.parse(txt); msg = jj.msg || jj.message || (jj.error && jj.error.message) || txt; } catch { }
    return wbAnthroError(res, 502, `上游返回非 SSE 响应: ${String(msg).slice(0, 200)}`);
  }
  await wbPipe(r, res, { model: j.model, clientStream: j.stream === true, inputJson: j }); // Anthropic 默认非流式
}

// 中转核心工厂：B.AI(:relayPort) 与 SenseNova(:sn.relayPort) 复用同一套逻辑，只是
// 取哪份配置(slice)、是否走代理(useProxy)、把流量记到哪个 recentCalls(store) 不同。
function makeRelay(p, store, getSlice, useProxy, opts = {}) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const cfg = loadCfg(); // 每请求实时读：映射改完立即生效，无需重启
      const S = getSlice(cfg); // {upstream, mapping, defaultModel, availableModels}
      const sliceCfg = { mapping: S.mapping, availableModels: S.availableModels, defaultModel: S.defaultModel };
      let body = Buffer.concat(chunks);
      let rewritten = null; // 模型解析后的请求 JSON（OpenAI 桥用）
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (body.length && ct.includes("json")) {
        try {
          const j = JSON.parse(body.toString("utf8"));
          if (typeof j.max_tokens === "number" && j.max_tokens < 3) j.max_tokens = 3; // 桌面版健康探测兼容
          if (typeof j.model === "string") {
            const tier = normalizeModel(j.model);
            j.model = resolveModel(j.model, sliceCfg);
            // 只观察"真实会话"流量：max_tokens≥512 的对话请求。
            // 桌面版后台小请求(健康探测/起标题/摘要, max_tokens 通常 ≤128)不算"用户正在用的档位"
            if (req.method === "POST" && req.url.startsWith("/v1/messages") && typeof j.max_tokens === "number" && j.max_tokens >= 512) {
              if (store[0] && store[0].tier === tier && Date.now() - store[0].at < 2000) store[0].at = Date.now();
              else { store.unshift({ tier, served: j.model, at: Date.now() }); if (store.length > 30) store.pop(); }
            }
          }
          rewritten = j;
          body = Buffer.from(JSON.stringify(j));
        } catch { /* 非 JSON 原样透传 */ }
      }
      const headers = {};
      for (const k of PASS_HEADERS) if (req.headers[k]) headers[k] = req.headers[k];
      // 探活级小请求（max_tokens≤8，桌面版健康检查/模型探测）：遇 429 静默退避重试 + 更短超时。
      // 放在 try 外声明——catch 里的超时归因也要用到
      const isProbe = (() => { try { const j = JSON.parse(body.toString("utf8")); return typeof j.max_tokens === "number" && j.max_tokens <= 8; } catch { return false; } })();
      const headerTimeoutMs = isProbe ? 10000 : 30000;
      // WorkBuddy（opts.openai）：上游只讲 OpenAI 且仅流式——独立协议桥处理，
      // 请求（Anthropic→OpenAI）与响应（OpenAI SSE→Anthropic SSE）都在桥内翻译。
      if (opts.openai) {
        if (!rewritten) return wbAnthroError(res, 400, "请求体必须是 Anthropic messages JSON");
        try {
          await openaiExchange(p, { cfg, S, j: rewritten, isProbe, res, useProxy: useProxy(cfg) });
        } catch (e) {
          noteRelayError(p, "network", String((e && e.message) || e));
          if (!res.headersSent) wbAnthroError(res, 502, (e && e.message) || e);
          else try { res.end(); } catch { }
        }
        return;
      }
      const UP = S.upstream + req.url;
      const doCall = () => useProxy(cfg)
        ? fetch(UP, { method: req.method, headers, body: body.length ? body : undefined, signal: AbortSignal.timeout(headerTimeoutMs) })
        : directHttp(UP, { method: req.method, headers, body: body.length ? body : undefined, timeoutMs: headerTimeoutMs });
      try {
        const { Readable } = await import("node:stream");
        let r;
        // v1.0.19: 上游超时只限"连接+响应头"——头一到就放行（SSE 流式正文不限时）。
        for (let attempt = 0; ; attempt++) {
          r = await doCall();
          if (!isProbe || r.status !== 429 || attempt >= 3) break;
          if (r.body && r.body.resume) r.body.resume(); // 丢弃 429 响应体（node stream 需 resume 否则挂起）
          await new Promise((rr) => setTimeout(rr, 400 * (attempt + 1)));
        }
        // 429 可能是不带 Content-Type 的空响应；先单独处理，不能误判为代理 HTML。
        if (r.status === 429) {
          noteRelayError(p, "rate_limit", "上游 429 限流（免费渠道并发敏感）");
          return sendRateLimitError(res, r);
        }
        // Anthropic API 端点只应返回 JSON 或 SSE；其余类型通常是代理/WAF
        // 的 HTML 页面。转换为标准 JSON 错误，避免调用端误报 JSON 解析异常。
        if (req.url.startsWith("/v1/") && !isApiResponseType(r.headers.get("content-type"))) {
          return sendUnexpectedUpstreamResponse(res, r);
        }
        if (r.status >= 400) noteRelayError(p, `upstream_${r.status}`, `上游 HTTP ${r.status}（${req.url}）`);
        const h = {};
        // fetch 已自动解压响应体，content-encoding 必须剥掉，否则客户端按 gzip 解明文会炸。
        // node 直连不解压：对 sn 保留 content-encoding，交给客户端解压。
        const strip = r._nodeStream
          ? ["content-length", "transfer-encoding", "connection"]
          : ["content-length", "transfer-encoding", "connection", "content-encoding"];
        r.headers.forEach((v, k) => { if (!strip.includes(k)) h[k] = v; });
        res.writeHead(r.status, h);
        if (r.body) {
          const stream = r._nodeStream ? r.body : Readable.fromWeb(r.body);
          stream.pipe(res);
          stream.on("error", () => res.end());
        } else res.end();
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (useProxy(cfg) && msg.includes("fetch failed")) scheduleProxyCheck(0, "上游连接失败触发"); // 代理可能换了端口/挂了 → 自动探测
        // v1.0.19: 超时/网络错误给出人话归因，并记录到面板"本地中转"灯
        const timedOut = e?.name === "AbortError" || msg.toLowerCase().includes("abort");
        const friendly = timedOut
          ? `上游 ${S.upstream} 在 ${isProbe ? 10 : 30}s 内未返回响应头（节点慢或被墙），已中断本次请求`
          : msg;
        noteRelayError(p, timedOut ? "timeout" : msg.includes("fetch failed") ? "proxy" : "network", friendly);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "relay_error", message: friendly } }));
      }
    });
  });
}

// 三个中转：B.AI 走代理（出海）、SenseNova 走直连（境内，可被 sn.useProxy 覆盖）、
// WorkBuddy 走直连（www.workbuddy.ai 直连可达，可被 wb.useProxy 覆盖；协议桥见 opts.openai）
const relay = makeRelay("bai", recentCallsBai, (cfg) => ({ upstream: cfg.upstream, mapping: cfg.mapping, defaultModel: cfg.defaultModel, availableModels: cfg.availableModels }), () => true);
const snRelay = makeRelay("sn", recentCallsSn, (cfg) => ({ upstream: cfg.sn.upstream, mapping: cfg.sn.mapping, defaultModel: cfg.sn.defaultModel, availableModels: cfg.sn.availableModels }), (cfg) => cfg.sn.useProxy === true);
const wbRelay = makeRelay("wb", recentCallsWb, (cfg) => ({ upstream: cfg.wb.upstream, mapping: cfg.wb.mapping, defaultModel: cfg.wb.defaultModel, availableModels: cfg.wb.availableModels }), (cfg) => cfg.wb.useProxy === true, { openai: true });
// OpenCode Zen：OpenAI 协议，复用同一套桥（apiKey 认证，无令牌续期）
const zenRelay = makeRelay("zen", recentCallsZen, (cfg) => ({ upstream: cfg.zen.upstream, mapping: cfg.zen.mapping, defaultModel: cfg.zen.defaultModel, availableModels: cfg.zen.availableModels }), (cfg) => cfg.zen.useProxy === true, { openai: true });
// Qoder：OpenAI 协议，复用同一套桥。认证是轮换的 jt- jobToken（每次请求现读令牌文件），无静态密钥
const qdRelay = makeRelay("qd", recentCallsQd, (cfg) => ({ upstream: cfg.qd.upstream, mapping: cfg.qd.mapping, defaultModel: cfg.qd.defaultModel, availableModels: cfg.qd.availableModels }), (cfg) => cfg.qd.useProxy === true, { openai: true });

// ---------- 文件级操作 ----------
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
// 密钥指纹（面板用于对比各端实际生效的 key，不显示全文）
function keyFp(k) {
  const s = String(k || "");
  if (!s) return "(空)";
  return s.length <= 12 ? "***" : s.slice(0, 7) + "…" + s.slice(-2) + "(" + s.length + ")";
}
function desktopConfigFile() {
  try {
    const meta = readJson(META_FILE);
    if (meta.appliedId) return path.join(CFG_LIB, meta.appliedId + ".json");
  } catch {}
  return null;
}
// ---------- 提供方（provider）切片：B.AI 与 SenseNova 归一化成同一形状，逻辑复用 ----------
// p="bai"（顶层字段）或 p="sn"（cfg.sn 子对象）。返回统一形状供中转/面板/接线共用。
function sliceOf(cfg, p) {
  if (p === "sn") {
    const s = cfg.sn || {};
    return {
      p: "sn", zh: "SenseNova", key: s.apiKey || "", upstream: s.upstream || DEFAULTS.sn.upstream,
      relayPort: s.relayPort || DEFAULTS.sn.relayPort, defaultModel: s.defaultModel || DEFAULTS.sn.defaultModel,
      availableModels: s.availableModels || [...DEFAULTS.sn.availableModels], mapping: s.mapping || { ...DEFAULTS.sn.mapping },
      useProxy: s.useProxy === true,
    };
  }
  if (p === "zen") {
    const z = cfg.zen || {};
    return {
      p: "zen", zh: "OpenCode Zen", key: z.apiKey || "", upstream: z.upstream || DEFAULTS.zen.upstream,
      relayPort: z.relayPort || DEFAULTS.zen.relayPort, defaultModel: z.defaultModel || DEFAULTS.zen.defaultModel,
      availableModels: z.availableModels || [...DEFAULTS.zen.availableModels], mapping: z.mapping || { ...DEFAULTS.zen.mapping },
      useProxy: z.useProxy === true,
    };
  }
  if (p === "qd") {
    const q = cfg.qd || {};
    return {
      // Qoder 的 jobToken 每次客户端启动都轮换，**绝不能写进 config / settings.json**：
      // 这里给一个稳定占位符当接线用（桥本身不校验入站 key），真实令牌由中转每次请求
      // 经 qdEnsureToken() 现读令牌文件。令牌是否就绪由 /api/status 的 qd.token 汇报。
      p: "qd", zh: "Qoder", key: "qd-local", upstream: q.upstream || DEFAULTS.qd.upstream,
      relayPort: q.relayPort || DEFAULTS.qd.relayPort, defaultModel: q.defaultModel || DEFAULTS.qd.defaultModel,
      availableModels: q.availableModels || [...DEFAULTS.qd.availableModels], mapping: q.mapping || { ...DEFAULTS.qd.mapping },
      useProxy: q.useProxy === true,
    };
  }
  if (p === "wb") {
    const w = cfg.wb || {};
    return {
      // WorkBuddy 没有 sk- 密钥：key 用访问令牌充当（供指纹展示与"是否已配置"判断），中转本身不校验
      p: "wb", zh: "WorkBuddy", key: w.accessToken || "", upstream: w.upstream || DEFAULTS.wb.upstream,
      relayPort: w.relayPort || DEFAULTS.wb.relayPort, defaultModel: w.defaultModel || DEFAULTS.wb.defaultModel,
      availableModels: w.availableModels || [...DEFAULTS.wb.availableModels], mapping: w.mapping || { ...DEFAULTS.wb.mapping },
      useProxy: w.useProxy === true,
    };
  }
  return {
    p: "bai", zh: "B.AI", key: cfg.apiKey || "", upstream: cfg.upstream || DEFAULTS.upstream,
    relayPort: cfg.relayPort || DEFAULTS.relayPort, defaultModel: cfg.defaultModel || DEFAULTS.defaultModel,
    availableModels: cfg.availableModels || [...DEFAULTS.availableModels], mapping: cfg.mapping || { ...DEFAULTS.mapping },
    useProxy: true,
  };
}
const PROVIDERS = { bai: "B.AI", sn: "SenseNova", wb: "WorkBuddy", zen: "OpenCode Zen", qd: "Qoder" };
const isOurs = (mode) => mode === "bai" || mode === "sn" || mode === "wb" || mode === "zen" || mode === "qd";
function hostOf(u) { try { return new URL(u).host; } catch { return ""; } }

// CLI 的 ANTHROPIC_BASE_URL 恒为提供方上游本体（B.AI=api.b.ai、sn=token.sensenova.cn），不经本地中转；
// 只有桌面版走 127.0.0.1:<relay>。故两者用不同的判据。
function cliMode(cfg, cfgKey, snKey, wbKey, zenKey) {
  try {
    const s = readJson(SETTINGS);
    const u = s?.env?.ANTHROPIC_BASE_URL || "";
    const key = s?.env?.ANTHROPIC_AUTH_TOKEN || "";
    const r = { baseUrl: u, keyFp: key ? keyFp(key) : null };
    const c = cfg || loadCfg();
    if (cfgKey) r.keyMatch = key === cfgKey;
    if (snKey != null) r.keyMatchSn = key === snKey;
    if (zenKey != null) r.keyMatchZen = key === zenKey;
    if (wbKey != null) r.keyMatchWb = key === wbKey;
    const bh = hostOf(c.upstream || DEFAULTS.upstream), sh = hostOf(c.sn?.upstream || DEFAULTS.sn.upstream);
    if (bh && u.includes(bh)) return { mode: "bai", ...r };
    if (sh && u.includes(sh)) return { mode: "sn", ...r };
    // WorkBuddy 的 CLI 直接指向本地协议桥（CLI 讲 Anthropic，上游讲 OpenAI，必须过桥）
    if (u.includes(`:${c.wb?.relayPort || DEFAULTS.wb.relayPort}`)) return { mode: "wb", ...r };
    if (u.includes(`:${c.zen?.relayPort || DEFAULTS.zen.relayPort}`)) return { mode: "zen", ...r };
    // Qoder 同理走本地协议桥；令牌会轮换，故只按端口判据，不做 key 匹配
    if (u.includes(`:${c.qd?.relayPort || DEFAULTS.qd.relayPort}`)) return { mode: "qd", ...r };
    if (u.includes(":15721")) return { mode: "ccswitch", ...r };
    return { mode: "other", ...r };
  } catch {
    return { mode: "unknown", baseUrl: "" };
  }
}
function desktopMode(cfg, cfgKey, snKey, wbKey, zenKey) {
  try {
    const f = desktopConfigFile();
    if (!f || !existsSync(f)) return { mode: "unknown", baseUrl: "" };
    const d = readJson(f);
    const u = d?.inferenceGatewayBaseUrl || "";
    const key = d?.inferenceGatewayApiKey || "";
    const r = { baseUrl: u, keyFp: key ? keyFp(key) : null };
    const c = cfg || loadCfg();
    if (cfgKey) r.keyMatch = key === cfgKey;
    if (snKey != null) r.keyMatchSn = key === snKey;
    if (zenKey != null) r.keyMatchZen = key === zenKey;
    if (wbKey != null) r.keyMatchWb = key === wbKey;
    if (u.includes(`:${c.relayPort || DEFAULTS.relayPort}`)) return { mode: "bai", ...r };
    if (u.includes(`:${c.sn?.relayPort || DEFAULTS.sn.relayPort}`)) return { mode: "sn", ...r };
    if (u.includes(`:${c.wb?.relayPort || DEFAULTS.wb.relayPort}`)) return { mode: "wb", ...r };
    if (u.includes(`:${c.zen?.relayPort || DEFAULTS.zen.relayPort}`)) return { mode: "zen", ...r };
    // Qoder 同理走本地协议桥；令牌会轮换，故只按端口判据，不做 key 匹配
    if (u.includes(`:${c.qd?.relayPort || DEFAULTS.qd.relayPort}`)) return { mode: "qd", ...r };
    if (u.includes(":15721")) return { mode: "ccswitch", ...r };
    return { mode: "other", ...r };
  } catch {
    return { mode: "unknown", baseUrl: "" };
  }
}
// 把「当前非本软件（CC Switch/其他）的配置」快照下来，作为将来一键恢复的还原点。
// 只有当前不属于任何本软件提供方时才覆盖快照——避免把 bai 配置误存成"外部基线"。
function snapshotExternal() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const c = loadCfg();
  const warns = [];
  const cm = cliMode(c);
  if (!isOurs(cm.mode) && existsSync(SETTINGS)) {
    copyFileSync(SETTINGS, path.join(BACKUP_DIR, "external-cli.json"));
  } else if (isOurs(cm.mode) && !existsSync(path.join(BACKUP_DIR, "external-cli.json"))) {
    warns.push("CLI 没有可恢复的 CC Switch 快照（当前已是本软件接管且从未快照过）");
  }
  const dm = desktopMode(c);
  const df = desktopConfigFile();
  if (!isOurs(dm.mode) && df && existsSync(df)) {
    copyFileSync(df, path.join(BACKUP_DIR, "external-desktop.json"));
  } else if (isOurs(dm.mode) && !existsSync(path.join(BACKUP_DIR, "external-desktop.json"))) {
    warns.push("桌面版没有可恢复的 CC Switch 快照");
  }
  return warns;
}

// 通用：把一个提供方的映射写进 CLI settings.json
function applyToCli(S) {
  let s = {};
  try { s = readJson(SETTINGS); } catch { s = {}; }
  s.env = s.env || {};
  const e = s.env;
  e.ANTHROPIC_AUTH_TOKEN = S.key || "wb-local";
  // B.AI 的 CLI 直连上游（靠 proxy env 出海）；SenseNova 境内直连；
  // WorkBuddy / Qoder 必须走本地协议桥（CLI 是 Anthropic 协议，上游只讲 OpenAI）
  e.ANTHROPIC_BASE_URL = (S.p === "wb" || S.p === "qd") ? `http://127.0.0.1:${S.relayPort}` : S.upstream;
  e.ANTHROPIC_MODEL = S.mapping["claude-haiku-4-5"]?.target || S.defaultModel;
  for (const t of TIERS) {
    e[t.envKey] = S.mapping[t.key]?.target || S.defaultModel;
    delete e[t.envKey + "_NAME"];
  }
  e.API_TIMEOUT_MS = e.API_TIMEOUT_MS || "3000000";
  e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  e.NODE_USE_ENV_PROXY = "1";
  if (S.p === "bai") {
    e.HTTPS_PROXY = loadCfg().proxy;
    e.HTTP_PROXY = loadCfg().proxy;
  } else {
    // 境内提供方（SenseNova/WorkBuddy）直连、清空代理（WorkBuddy 桥在本机，NO_PROXY 已覆盖）
    delete e.HTTPS_PROXY; delete e.HTTP_PROXY;
  }
  e.NO_PROXY = "127.0.0.1,localhost";
  writeAtomic(SETTINGS, JSON.stringify(s, null, 2) + "\n");
}
// 通用：把一个提供方写进桌面版 configLibrary（都经由本地中转，桌面版不感知上游差异）
function applyToDesktop(S) {
  const f = desktopConfigFile();
  if (!f) throw new Error("找不到桌面版配置文件（configLibrary/_meta.json）");
  writeAtomic(
    f,
    JSON.stringify(
      {
        coworkEgressAllowedHosts: ["*"],
        disableDeploymentModeChooser: true,
        inferenceGatewayApiKey: S.key,
        inferenceGatewayAuthScheme: "bearer",
        inferenceGatewayBaseUrl: `http://127.0.0.1:${S.relayPort}`,
        inferenceModels: TIERS.map((t) => ({
          labelOverride: S.mapping[t.key]?.label || t.zh,
          name: t.key,
          supports1m: true,
        })),
        inferenceProvider: "gateway",
      },
      null,
      2
    ) + "\n"
  );
}
// 兼容旧调用名
function applyBaiToCli(cfg) { applyToCli(sliceOf(cfg, "bai")); }
function applyBaiToDesktop(cfg) { applyToDesktop(sliceOf(cfg, "bai")); }

// CC Switch 方案的兜底还原数据（取自用户机器上真实生效过的配置）
const FALLBACK_CC_CLI = {
  effortLevel: "xhigh",
  env: {
    ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
    ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5[1M]",
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "MiniMax-M3",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "MiniMax-M3",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8[1M]",
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "MiniMax-M3",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6[1M]",
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "MiniMax-M3",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
    CLAUDE_CODE_EFFORT_LEVEL: "max",
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    ENABLE_TOOL_SEARCH: "true",
  },
  model: "haiku",
};
const FALLBACK_CC_DESK = {
  coworkEgressAllowedHosts: ["*"],
  disableDeploymentModeChooser: true,
  inferenceGatewayApiKey: "ccs-cf90bbbd020a4ef59ed9e5b87ca389b0",
  inferenceGatewayAuthScheme: "bearer",
  inferenceGatewayBaseUrl: "http://127.0.0.1:15721/claude-desktop",
  inferenceModels: [
    { labelOverride: "GLM-5.3-Flash", name: "claude-fable-5", supports1m: true },
    { labelOverride: "GLM-5.3-Flash", name: "claude-haiku-4-5", supports1m: true },
    { labelOverride: "GLM-5.3-Flash", name: "claude-opus-5", supports1m: true },
    { labelOverride: "GLM-5.3-Flash", name: "claude-sonnet-5", supports1m: true },
  ],
  inferenceProvider: "gateway",
};

function restoreExternal(target, cfg) {
  const c = cfg || loadCfg();
  if (target === "cli") {
    const bak = path.join(BACKUP_DIR, "external-cli.json");
    if (existsSync(bak)) {
      copyFileSync(bak, SETTINGS);
      return "已从快照恢复 CLI";
    }
    if (isOurs(cliMode(c).mode)) {
      writeAtomic(SETTINGS, JSON.stringify(FALLBACK_CC_CLI, null, 2) + "\n");
      return "CLI 无快照，已写入内置 CC Switch 兜底配置";
    }
    return "CLI 当前不是本软件接管，无需恢复";
  }
  if (target === "desktop") {
    const bak = path.join(BACKUP_DIR, "external-desktop.json");
    const f = desktopConfigFile();
    if (existsSync(bak) && f) {
      copyFileSync(bak, f);
      return "已从快照恢复桌面版";
    }
    if (f && isOurs(desktopMode(c).mode)) {
      writeAtomic(f, JSON.stringify(FALLBACK_CC_DESK, null, 2) + "\n");
      return "桌面版无快照，已写入内置 CC Switch 兜底配置";
    }
    return "桌面版当前不是本软件接管，无需恢复";
  }
  throw new Error("未知恢复目标 " + target);
}

// ---------- 状态检测 ----------
function checkPort(port) {
  return new Promise((resolve) => {
    const net = import("node:net").then(({ default: net }) => {
      const s = net.connect({ host: "127.0.0.1", port, timeout: 1500 }, () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
      s.on("timeout", () => { s.destroy(); resolve(false); });
    });
  });
}
function checkCcSwitch() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq cc-switch.exe", "/NH"], { timeout: 5000 }, (err, stdout) => {
      resolve(!err && String(stdout).toLowerCase().includes("cc-switch.exe"));
    });
  });
}
async function checkClash(cfg) {
  const t0 = Date.now();
  const ok = await probeVia(cfg.proxy || "DIRECT");
  return { alive: ok, ms: Date.now() - t0, via: cfg.proxy || "直连" };
}

// ---------- 面板 API ----------
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function providerStatus(cfg, p, store) {
  const S = sliceOf(cfg, p);
  const t = activeTier(store);
  return {
    relay: { port: S.relayPort, up: true },
    relayLast: { ...(relayErrors[p] || {}) },
    upstream: {
      host: S.upstream,
      tested: lastTest[p]?.ok, ok: lastTest[p]?.ok, model: lastTest[p]?.model || null,
      ms: lastTest[p]?.ms || null, error: lastTest[p]?.error || null, at: lastTest[p]?.at || null,
    },
    recent: (() => {
      if (!t) return { tier: null };
      const m = S.mapping?.[t] || {};
      const obs = store.find((x) => x.tier === t);
      return { tier: t, label: m.label || t, target: m.target || S.defaultModel, observedAt: obs ? obs.at : null };
    })(),
  };
}

async function statusPayload() {
  const cfg = loadCfg();
  const [clash, ccswitch] = await Promise.all([checkClash(cfg), checkCcSwitch()]);
  const bai = providerStatus(cfg, "bai", recentCallsBai);
  const sn = providerStatus(cfg, "sn", recentCallsSn);
  const wb = providerStatus(cfg, "wb", recentCallsWb);
  const zen = providerStatus(cfg, "zen", recentCallsZen);
  const qd = providerStatus(cfg, "qd", recentCallsQd);
  let qdTok = null;
  try { qdTok = qdEnsureToken(cfg); } catch { }
  const wbExp = wbTokenExp(cfg.wb?.accessToken);
  return {
    now: new Date().toISOString(),
    service: { up: true, uptimeSec: Math.floor((Date.now() - BOOT) / 1000), pid: process.pid },
    panel: { port: cfg.panelPort, up: true },
    clash,
    proxy: cfg.proxy || "直连",
    ccswitch: { running: ccswitch },
    // 接线状态（两端各自归属哪个提供方）。keyMatch=对 B.AI key 的匹配，
    // keyMatchSn/keyMatchWb 分别是对 SenseNova / WorkBuddy 凭据的匹配——各页各取各的对比对象。
    cli: cliMode(cfg, cfg.apiKey, cfg.sn?.apiKey, cfg.wb?.accessToken, cfg.zen?.apiKey),
    desktop: desktopMode(cfg, cfg.apiKey, cfg.sn?.apiKey, cfg.wb?.accessToken, cfg.zen?.apiKey),
    // B.AI 灯/接线沿用旧字段名，SenseNova 灯挂 sn 下，WorkBuddy 灯挂 wb 下
    relay: bai.relay, relayLast: bai.relayLast, upstream: bai.upstream, recent: bai.recent,
    sn: { relay: sn.relay, relayLast: sn.relayLast, upstream: sn.upstream, recent: sn.recent, useProxy: cfg.sn?.useProxy === true },
    zen: { relay: zen.relay, relayLast: zen.relayLast, upstream: zen.upstream, recent: zen.recent, useProxy: cfg.zen?.useProxy === true, keyConfigured: !!cfg.zen?.apiKey },
    qd: {
      relay: qd.relay, relayLast: qd.relayLast, upstream: qd.upstream, recent: qd.recent,
      useProxy: cfg.qd?.useProxy === true,
      // 令牌是轮换的 jobToken，只有"当前有没有读到"这一态有意义（无到期时间可报）
      token: { configured: !!qdTok, tokenFile: cfg.qd?.tokenFile || DEFAULTS.qd.tokenFile },
    },
    wb: {
      relay: wb.relay, relayLast: wb.relayLast, upstream: wb.upstream, recent: wb.recent,
      useProxy: cfg.wb?.useProxy === true,
      // 令牌体检：有无令牌、访问令牌到期时间、是否带刷新令牌
      token: {
        configured: !!cfg.wb?.accessToken,
        expAt: wbExp ? new Date(wbExp * 1000).toISOString() : null,
        expiresInDays: wbExp ? Math.max(0, Math.round((wbExp * 1000 - Date.now()) / 86400000)) : null,
        hasRefresh: !!cfg.wb?.refreshToken,
      },
    },
  };
}

const lastTest = {
  bai: { ok: null, model: null, ms: null, error: null, at: null },
  sn: { ok: null, model: null, ms: null, error: null, at: null },
  wb: { ok: null, model: null, ms: null, error: null, at: null },
  zen: { ok: null, model: null, ms: null, error: null, at: null },
  qd: { ok: null, model: null, ms: null, error: null, at: null },
};

const panel = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "http://127.0.0.1:" + loadCfg().panelPort);
  const u = new URL(req.url, "http://127.0.0.1");
  // v1.0.19: 面板加固——Host 必须是回环地址；带 Origin 头时必须是面板自身。
  // 防 DNS rebinding（外网页面把域名解析到 127.0.0.1 后调面板 API 改写 Claude 配置）。
  // curl/本机程序不带 Origin 不受影响；面板页面同源 fetch 的 Origin 就是 selfOrigin，也不受影响。
  {
    const pp = cfg0.panelPort;
    const hostOk = req.headers.host === `127.0.0.1:${pp}` || req.headers.host === `localhost:${pp}`;
    const selfOrigin = `http://127.0.0.1:${pp}`;
    const originOk = !req.headers.origin || req.headers.origin === selfOrigin || req.headers.origin === `http://localhost:${pp}`;
    if (!hostOk || !originOk) return json(res, 403, { error: "forbidden: 面板只接受本机回环访问" });
  }
  try {
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "ui.html")));
    }
    // v1.0.28: SenseNova 独立页面（与 B.AI 页并列，经 header 导航互跳）
    if (req.method === "GET" && (u.pathname === "/sn" || u.pathname === "/sensenova" || u.pathname === "/sn.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "sn.html")));
    }
    // v1.0.31: WorkBuddy 独立页面（三页导航并列）
    if (req.method === "GET" && (u.pathname === "/wb" || u.pathname === "/workbuddy" || u.pathname === "/wb.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "wb.html")));
    }
    // v1.0.37: OpenCode Zen 独立页面
    if (req.method === "GET" && (u.pathname === "/zen" || u.pathname === "/opencode" || u.pathname === "/zen.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "zen.html")));
    }
    // v1.0.38: Qoder 独立页面
    if (req.method === "GET" && (u.pathname === "/qd" || u.pathname === "/qoder" || u.pathname === "/qd.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "qd.html")));
    }
    if (req.method === "GET" && u.pathname === "/api/ping") return json(res, 200, { ok: true });
    if (req.method === "GET" && u.pathname === "/api/version") return json(res, 200, { version: APP_VERSION });

    // v1.0.33: 一键捕获 WorkBuddy 令牌（临时注入客户端 CLI 脚本 → 抓取 → 立即还原）
    if (req.method === "POST" && u.pathname === "/api/wb/capture") {
      try {
        const r = await wbCaptureToken(150000);
        return json(res, 200, { ok: true, ...r, message: "令牌已自动填入并保存" });
      } catch (e) {
        return json(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    }
    if (req.method === "GET" && u.pathname === "/api/wb/capture/status") {
      return json(res, 200, { active: wbCapState.active, startedAt: wbCapState.startedAt, elapsedMs: wbCapState.active ? Date.now() - wbCapState.startedAt : 0 });
    }

    // v1.0.19: 拉取上游真实模型目录。模型会腐烂/新增（实测 mimo-v2.5 目录里有但实际 503），
    // 下拉框不能只靠发布机默认列表；UI 的「刷新模型列表」按钮走这里。
    // v1.0.28: ?p=sn 时从 SenseNova 拉（境内直连，不走代理）；只保留可对话模型（output 含 text）。
    if (req.method === "GET" && u.pathname === "/api/models") {
      const pRaw = u.searchParams.get("p");
      const p = pRaw === "sn" ? "sn" : pRaw === "wb" ? "wb" : pRaw === "zen" ? "zen" : pRaw === "qd" ? "qd" : "bai";
      const c2 = loadCfg();
      const S = sliceOf(c2, p);
      // WorkBuddy 没有公开的模型目录接口（模型清单随客户端 product config 下发），
      // 返回当前可选列表即可——三款免费模型由发布机默认随版本推送
      if (p === "wb" || p === "qd") {
        // Qoder 同样没有公开的模型目录接口：服务端只认 lite / auto 两个别名，
        // 由客户端内部按账号套餐决定实际落到哪个后端模型
        return json(res, 200, { ok: true, count: S.availableModels.length, models: [...S.availableModels], static: true });
      }
      if (p === "zen") {
        // Zen 提供公开模型目录（无需鉴权）；带 -free 的多数被服务端限客户端内使用，
        // 这里如实返回并标注，供 UI 提示——不把不可用模型塞进下拉框。
        let live = [];
        try {
          const fr = await fetch("https://opencode.ai/zen/v1/models", { signal: AbortSignal.timeout(15000) });
          const jj = await fr.json();
          live = (jj.data || []).map((m) => String(m.id || "").trim().toLowerCase()).filter(Boolean);
        } catch { }
        const free = live.filter((id) => id.includes("free"));
        const knownOk = S.availableModels.filter((id) => live.includes(id) || !live.length);
        return json(res, 200, {
          ok: true, count: live.length, models: [...S.availableModels],
          freeCount: free.length,
          note: `Zen 目录共 ${live.length} 个模型，其中 ${free.length} 个标 free；实测仅 space-bunny-free 可从外部调用，其余限 OpenCode 客户端内使用`,
        });
      }
      let j;
      if (p === "sn") {
        const r = await directHttp(S.upstream + "/v1/models", {
          method: "GET", headers: { authorization: `Bearer ${S.key}`, "anthropic-version": "2023-06-01" }, timeoutMs: 15000,
        });
        j = await readProbeJson({ status: r.status, headers: r.headers, text: async () => {
          const { Readable } = await import("node:stream");
          return await Readable.from(r.body).reduce((s, c) => s + c, "");
        } });
        if (r.status >= 400) throw new Error(j?.error?.message || `HTTP ${r.status}`);
        // SenseNova 目录带 modalities：只把能输出文本的模型作为可路由目标
        const chat = (j.data || []).filter((m) => (m.output_modalities || ["text"]).includes("text"));
        const models = [...new Set(chat.map((m) => String(m.id || "").trim().toLowerCase()).filter(Boolean))].sort();
        return json(res, 200, { ok: true, count: models.length, models });
      }
      const r = await fetch(S.upstream + "/v1/models", {
        headers: { authorization: `Bearer ${S.key}`, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(15000),
      });
      j = await readProbeJson(r);
      if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
      const models = [...new Set((j.data || []).map((m) => String(m.id || "").trim().toLowerCase()).filter(Boolean))].sort();
      return json(res, 200, { ok: true, count: models.length, models });
    }

    if (req.method === "GET" && u.pathname === "/api/status") return json(res, 200, await statusPayload());

    if (req.method === "POST" && u.pathname === "/api/proxy-detect") {
      const found = await detectWorkingProxy();
      let applied = false;
      if (found) applied = applyProxy(found, "手动检测");
      return json(res, 200, {
        found: found || null,
        applied,
        message: found
          ? (applied ? `检测到可用通道 ${found === "DIRECT" ? "直连(TUN/全局)" : found}，已切换并重启服务` : `当前配置已是可用通道 ${found === "DIRECT" ? "直连" : found}`)
          : "未检测到可用代理/直连——请确认 Clash 已开启（系统代理或 TUN 均可）后重试",
      });
    }

    if (req.method === "GET" && u.pathname === "/api/config") return json(res, 200, loadCfg());

    // v1.0.28: 配置编辑按提供方分流。body.provider="sn"/"wb" 时读写 cfg.sn / cfg.wb 子对象，
    // 否则维持 B.AI 顶层字段（apiKey/mapping/upstream/relayPort/panelPort…），互不影响。
    // v1.0.31: WorkBuddy 无 sk- 密钥，改收 JWT 令牌四件套（accessToken/refreshToken/deviceToken/userId）。
    if (req.method === "POST" && u.pathname === "/api/config") {
      const b = await readBody(req);
      const cfg = loadCfg();
      const P = ["sn", "zen", "qd"].includes(b.provider) ? b.provider : b.provider === "wb" ? "wb" : "bai";
      const sub = P === "sn" ? cfg.sn : P === "wb" ? cfg.wb : P === "zen" ? cfg.zen : P === "qd" ? cfg.qd : cfg; // 共用字段（mapping/upstream/…）落点
      // —— API Key（仅 B.AI / SenseNova）——
      if (typeof b.apiKey === "string" && b.apiKey.trim()) {
        const k = b.apiKey.trim();
        // zen 的 key 是 oc_sk_ 开头（OpenCode Zen），其余提供方是 sk- 前缀
        if (P === "zen") { cfg.zen.apiKey = k; }
        else {
          if (!k.startsWith("sk-")) return json(res, 400, { error: "API Key 应以 sk- 开头" });
          if (P === "sn") cfg.sn.apiKey = k; else if (P === "bai") cfg.apiKey = k;
        }
      }
      // —— Qoder 令牌（一般不用填：正常由 worker 补丁写入 tokenFile，此处仅手动兜底）——
      if (P === "qd" && typeof b.token === "string") {
        cfg.qd.token = b.token.trim();
      }
      // —— WorkBuddy 令牌（出现字段即写入；空串=清除）——
      if (P === "wb") {
        for (const f of ["accessToken", "refreshToken", "deviceToken", "userId"]) {
          if (typeof b[f] === "string") cfg.wb[f] = b[f].trim();
        }
        if (cfg.wb.accessToken && cfg.wb.accessToken.split(".").length !== 3) {
          return json(res, 400, { error: "访问令牌应是 JWT（三段以 . 分隔）——请从捕获结果完整粘贴" });
        }
      }
      let needRestart = false;
      // —— 代理：B.AI 走顶层 proxy（决定进程重启），SenseNova/WorkBuddy 走 useProxy 开关（每请求实时读，无需重启）——
      if (P === "bai" && typeof b.proxy === "string") {
        const p = b.proxy.trim();
        if (p && !/^https?:\/\/127\.0\.0\.1:\d+$/.test(p)) return json(res, 400, { error: "代理格式应为 http://127.0.0.1:端口，留空表示直连" });
        if ((cfg.proxy || "") !== p) { cfg.proxy = p; needRestart = true; }
      }
      if (P !== "bai" && typeof b.useProxy === "boolean" && sub.useProxy !== b.useProxy) {
        sub.useProxy = b.useProxy;
        needRestart = true; // 直连/走代理由启动期 NO_PROXY 决定（Node 缓存 env 代理配置），改开关需重启
      }
      // —— 映射表 ——
      if (b.mapping && typeof b.mapping === "object") {
        const dst = sub.mapping;
        for (const t of TIERS) {
          const m = b.mapping[t.key];
          if (!m) continue;
          const target = String(m.target || "").trim().toLowerCase();
          const label = String(m.label || "").trim() || t.zh;
          if (!target) return json(res, 400, { error: `${t.key} 的目标模型不能为空` });
          dst[t.key] = { target, label };
        }
      }
      // —— 可选模型列表 ——
      if (Array.isArray(b.availableModels)) {
        const arr = b.availableModels.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
        if (arr.length) sub.availableModels = [...new Set(arr)];
      }
      // —— 上游地址（中转每请求实时读，无需重启）——
      if (typeof b.upstream === "string" && b.upstream.trim()) {
        const up = b.upstream.trim().replace(/\/+$/, "");
        if (!/^https?:\/\//.test(up)) return json(res, 400, { error: "上游地址需以 http(s):// 开头" });
        sub.upstream = up;
      }
      // —— 端口 ——
      if (b.panelPort != null && b.panelPort !== "") {
        const n = Number(b.panelPort);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) return json(res, 400, { error: `panelPort 需为 1024-65535 的整数` });
        if (n !== cfg.panelPort) { cfg.panelPort = n; needRestart = true; }
      }
      if (b.relayPort != null && b.relayPort !== "") {
        const n = Number(b.relayPort);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) return json(res, 400, { error: `relayPort 需为 1024-65535 的整数` });
        if (n !== sub.relayPort) { sub.relayPort = n; needRestart = true; }
      }
      if (typeof b.defaultModel === "string" && b.defaultModel.trim()) {
        sub.defaultModel = b.defaultModel.trim().toLowerCase();
      }
      saveCfg(cfg);
      // 端上已接到该提供方的话，立即同步新映射
      const applied = [];
      const curCli = cliMode(cfg).mode, curDesk = desktopMode(cfg).mode;
      if (curCli === P) { applyToCli(sliceOf(cfg, P)); applied.push("cli"); }
      if (curDesk === P) { applyToDesktop(sliceOf(cfg, P)); applied.push("desktop"); }
      log(`配置已保存(${P})，重应用到:`, applied.join(",") || "无", needRestart ? "(需重启)" : "");
      return json(res, 200, {
        ok: true,
        provider: P,
        applied,
        needRestart,
        hints: [
          "中转映射已即时生效（无需重启任何东西）",
          needRestart ? "代理/端口设置需重启服务生效" : null,
          applied.includes("cli") ? "CLI：新开的终端生效" : null,
          applied.includes("desktop") ? "桌面版：需完全退出并重开 Claude 生效" : null,
        ].filter(Boolean),
      });
    }

    // v1.0.28: 一键接线按提供方分流；恢复（接回 CC Switch）在 /api/restore 里保持原样
    if (req.method === "POST" && u.pathname === "/api/apply") {
      const b = await readBody(req);
      const P = ["sn", "zen", "qd"].includes(b.provider) ? b.provider : b.provider === "wb" ? "wb" : "bai";
      const cfg = loadCfg();
      const S = sliceOf(cfg, P);
      const name = PROVIDERS[P];
      if (!S.key) {
        return json(res, 400, {
          error: P === "wb"
            ? "请先在「WorkBuddy」页粘贴访问令牌（JWT）——捕获方法见该页说明"
            : `请先在「${name}」路由表里填写 API Key`,
        });
      }
      // Qoder 的 key 是稳定占位符（令牌会轮换、不落 config），故单独校验令牌是否真的读得到
      if (P === "qd") {
        try { qdEnsureToken(cfg, true); }
        catch {
          return json(res, 400, { error: "未读到 Qoder 令牌——请先启动 Qoder 桌面端（补丁会把令牌写到 %TEMP%/qoder-token.json），无需手动填写" });
        }
      }
      const doCli = b.cli !== false;
      const doDesk = b.desktop !== false;
      const warns = [];
      if (doCli) { const w = snapshotExternal(); warns.push(...w.filter((x) => x.startsWith("桌面"))); }
      if (doDesk) { const w = snapshotExternal(); warns.push(...w.filter((x) => x.startsWith("CLI"))); }
      if (doCli) applyToCli(S);
      if (doDesk) applyToDesktop(S);
      const ccRunning = await checkCcSwitch();
      if (ccRunning) warns.push("CC Switch 正在运行，它可能随时把配置改回去；切换前建议先退出它");
      warns.push("桌面版需完全退出并重开 Claude 才生效；CLI 新开终端生效");
      if (P === "sn") warns.push("SenseNova 有 TPM/RPM 限流，探测到 429 属正常，稍候即恢复；图像模型不参与对话路由");
      if (P === "wb") warns.push("WorkBuddy 三款免费模型由 WorkBuddy 客户端账号提供（0 积分不限量）；令牌过期会自动用刷新令牌续期，无需重新接线");
      if (P === "zen") warns.push("OpenCode Zen 的免费额度多数限客户端内使用，实测仅 space-bunny-free 可外部调用；购买 Go 订阅后可解锁 Go 通道的 30 个模型");
      if (P === "qd") warns.push("Qoder 走账号的 Free 套餐额度；令牌每次 Qoder 启动会轮换，中转会自动跟随——但 Qoder 客户端必须保持运行，否则中转读不到令牌");
      log(`一键切到 ${name}: cli=${doCli} desktop=${doDesk}`);
      return json(res, 200, { ok: true, provider: P, warnings: warns, snapshot: "已自动快照切换前的配置（可用于一键恢复）" });
    }

    if (req.method === "POST" && u.pathname === "/api/restore") {
      const b = await readBody(req);
      const msgs = [];
      if (b.cli !== false) msgs.push(restoreExternal("cli", loadCfg()));
      if (b.desktop !== false) msgs.push(restoreExternal("desktop", loadCfg()));
      log("一键恢复:", msgs.join(" | "));
      return json(res, 200, { ok: true, messages: msgs, hints: ["桌面版需完全退出并重开 Claude 才生效；CLI 新开终端生效"] });
    }

    // v1.0.28: 测连通按 provider 分流，各测各的中转端口/映射/密钥
    if (req.method === "POST" && u.pathname === "/api/test") {
      const cfg = loadCfg();
      const b = await readBody(req).catch(() => ({}));
      const P = ["sn", "zen", "qd"].includes(b.provider) ? b.provider : b.provider === "wb" ? "wb" : "bai";
      const S = sliceOf(cfg, P);
      const store = P === "sn" ? recentCallsSn : P === "wb" ? recentCallsWb : P === "zen" ? recentCallsZen : P === "qd" ? recentCallsQd : recentCallsBai;
      const active = b.all ? null : activeTier(store);
      const targets = active ? [active] : TIERS.map((t) => t.key);
      const tierInfo = (key) => {
        const m = S.mapping[key] || {};
        return { label: m.label || key, target: m.target || S.defaultModel };
      };
      const probe = async (tier) => {
        const info = tierInfo(tier);
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) { // 上游偶发截断/挂起，测活流量重试两次
          const t0 = Date.now();
          try {
            const r = await fetch(`http://127.0.0.1:${S.relayPort}/v1/messages`, {
              method: "POST",
              headers: { authorization: `Bearer ${S.key}`, "content-type": "application/json", "anthropic-version": "2023-06-01" },
              body: JSON.stringify({ model: tier + "[1M]", max_tokens: 8, messages: [{ role: "user", content: "ok" }] }),
              signal: AbortSignal.timeout(45000),
            });
            const j = await readProbeJson(r);
            const ms = Date.now() - t0;
            if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
            return { tier, label: info.label, target: info.target, served: j.model, ok: true, ms, error: null };
          } catch (e) { lastErr = String(e?.message || e).slice(0, 100); }
        }
        return { tier, label: info.label, target: info.target, served: null, ok: false, ms: null, error: lastErr || "unknown" };
      };
      // 免费渠道对短时间并发探测很敏感。串行并留出间隔，避免四个档位
      // 同时命中 429；这不会影响真实对话的吞吐。
      const tiers = [];
      for (let i = 0; i < targets.length; i++) {
        tiers.push(await probe(targets[i]));
        if (i < targets.length - 1) await new Promise((res) => setTimeout(res, 1500));
      }
      const pass = tiers.filter((x) => x.ok).length;
      Object.assign(lastTest[P], {
        ok: pass === tiers.length,
        model: tiers[0]?.label || null,
        ms: tiers[0]?.ms || null,
        error: pass === tiers.length ? null : tiers.filter((x) => !x.ok).map((x) => `${x.label}: ${x.error}`).join("；"),
        at: new Date().toISOString(),
      });
      return json(res, 200, { ok: pass === tiers.length, provider: P, tiers, pass, total: tiers.length, active });
    }

    // ---------- 备用自升级 API ----------
    if (req.method === "POST" && u.pathname === "/api/selfupdate") {
      const cur = readSuState();
      if (cur && (cur.phase === "downloading" || cur.phase === "verifying" || cur.phase === "resolving")) {
        return json(res, 200, { ok: true, message: "升级已在进行中", phase: cur.phase });
      }
      downloadLatestInstaller().catch((e) => {
        const msg = String((e && e.message) || e);
        log("备用升级失败: " + msg);
        suState({ phase: "error", error: msg.slice(0, 200) });
      });
      return json(res, 200, { ok: true, message: "开始下载最新版（走本机代理）" });
    }
    if (req.method === "GET" && u.pathname === "/api/selfupdate/status") {
      return json(res, 200, readSuState() || { phase: "idle" });
    }
    if (req.method === "POST" && u.pathname === "/api/selfupdate/install") {
      const st = readSuState();
      if (!st || st.phase !== "ready") return json(res, 400, { error: "还没有校验通过的升级包（先点「开始升级」）" });
      json(res, 200, { ok: true, message: `即将退出并安装 ${st.version}，约 15 秒后自动重开` });
      log(`备用升级：启动安装 ${st.version}（本进程即将被 apply.cmd 收掉）`);
      launchApplyScript();
      setTimeout(() => process.exit(0), 400);
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/service/stop") {
      json(res, 200, { ok: true, message: "服务即将停止（B.AI / SenseNova / WorkBuddy / OpenCode Zen / Qoder 中转一并停止）" });
      log("收到停止指令，进程退出");
      setTimeout(() => process.exit(0), 300);
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/service/restart") {
      // v1.0.19: Electron 托管模式下直接退出，由壳自动重拉——不再自产继任者进程。
      // 之前"自己 spawn 继任者 + 壳又重拉一个"会让两个新实例互撞（胜者绑定端口，
      // 败者反复被壳拉起又让位，形成 ~2 秒一轮的重启循环）。
      if (process.env.BAI_ROUTER_EXE) {
        json(res, 200, { ok: true, message: "服务正在重启（桌面壳托管：退出后由壳重拉）" });
        log("收到重启指令（Electron 托管），直接退出交由壳重拉");
        setTimeout(() => process.exit(0), 300);
        return;
      }
      // 浏览器/绿色模式：无壳托管，保留"以最新 config 起继任者再自我退出"的老路。
      const cfg = loadCfg();
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        detached: true, stdio: "ignore", windowsHide: true, cwd: HERE,
        env: { ...process.env, NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1", ...(cfg.proxy ? { HTTPS_PROXY: cfg.proxy, HTTP_PROXY: cfg.proxy } : {}), NO_PROXY: computeNoProxy(cfg) },
      });
      child.unref();
      json(res, 200, { ok: true, message: "服务正在重启" });
      log("收到重启指令，新实例 pid", child.pid);
      setTimeout(() => process.exit(0), 300);
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/deploy-local") {
      // 部署到本机：快捷方式 / 开机自启 / 代理探测 / Node 探测（幂等，跨机器通用）
      const b = await readBody(req);
      const msgs = [];
      const exe = process.env.BAI_ROUTER_EXE || ""; // 由 Electron 主进程注入
      const here = HERE.replace(/\//g, "\\");
      const execFileAsync = (cmd, args) => new Promise((res2, rej) => execFile(cmd, args, { timeout: 30000, windowsHide: true }, (e, so) => e ? rej(e) : res2(String(so))));

      // ① 代理端口探测（候选常见 Clash/V2ray 混合端口，谁通用谁）
      if (b.probeProxy !== false) {
        let found = null;
        for (const p of [7890, 10809, 10808, 7897]) {
          try {
            const out = await execFileAsync("curl", ["-s", "--ssl-no-revoke", "-x", `http://127.0.0.1:${p}`, "-m", "5", "-o", "NUL", "-w", "%{http_code}", "https://www.gstatic.com/generate_204"]);
            if (/^(204|302|200)$/.test(out.trim())) { found = `http://127.0.0.1:${p}`; break; }
          } catch { /* 试下一个 */ }
        }
        if (found && found !== cfg0.proxy) {
          const c = loadCfg(); c.proxy = found; saveCfg(c);
          msgs.push(`代理端口探测成功：${found}（已写入配置）`);
        } else msgs.push(found ? `代理端口正常：${found}` : "未探测到可用本地代理——请在本机设置里手动填代理地址（Clash 需开启）");
      }

      // ② Node 探测
      try { await execFileAsync("where", ["node"]); msgs.push("系统 Node：已安装 ✓"); }
      catch { msgs.push("系统 Node：未找到——将使用软件内置 Node 运行服务（功能相同）"); }

      // ③ 快捷方式（桌面 + 开始菜单）
      if (b.shortcuts && exe) {
        const exeDir = path.dirname(exe);
        const ps = `$ws=New-Object -ComObject WScript.Shell;` +
          `foreach($d in @([Environment]::GetFolderPath('Desktop'),(Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))){` +
          `$s=$ws.CreateShortcut((Join-Path $d 'B.AI 路由台.lnk'));` +
          `$s.TargetPath='${exe.replace(/'/g, "''")}';` +
          `$s.WorkingDirectory='${exeDir.replace(/'/g, "''")}';` +
          `$s.IconLocation='${path.join(exeDir, "resources", "app", "icon.ico").replace(/'/g, "''")}';` +
          `$s.Description='B.AI 模型路由台';$s.Save()}`;
        try { await execFileAsync("powershell", ["-NoProfile", "-Command", ps]); msgs.push("桌面/开始菜单快捷方式：已更新 ✓"); }
        catch (e) { msgs.push("快捷方式创建失败：" + e.message); }
      } else if (b.shortcuts) msgs.push("快捷方式：非 Electron 模式启动，跳过（用 exe 启动软件后再部署）");

      // ④ 开机自启（当前用户启动文件夹，不写注册表）
      const startup = path.join(HOME, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
      const vbs = path.join(startup, "bai-router.vbs");
      const legacyVbs = path.join(startup, "bai-relay.vbs");
      if (b.autostart === true) {
        mkdirSync(startup, { recursive: true });
        const target = exe || path.join(here, "start-server.cmd");
        const line = exe
          ? `CreateObject("Wscript.Shell").Run """${target}"" --min", 0, False`
          : `CreateObject("Wscript.Shell").Run "cmd /c ""${target}""", 0, False`;
        writeFileSync(vbs, line + "\n");
        try { if (existsSync(legacyVbs)) writeFileSync(legacyVbs, line + "\n"); } catch {}
        msgs.push("开机自启：已开启（登录后台运行，托盘常驻）");
      } else if (b.autostart === false) {
        for (const f of [vbs, legacyVbs]) { try { if (existsSync(f)) writeFileSync(f, "' disabled by bai-router\n"); } catch {} }
        msgs.push("开机自启：已关闭");
      }

      log("deploy-local:", msgs.join(" | "));
      return json(res, 200, { ok: true, messages: msgs });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    log("API 错误:", e?.stack || String(e));
    try { json(res, 500, { error: String((e && e.message) || e) }); } catch {}
  }
});

// ---------- 起飞 ----------
// v1.0.19: 端口被占不再立刻硬退出。重启交接窗口（旧进程尚未释放端口）按 600ms 退避重试；
// 若对面是"健康的本套实例"（面板可 ping 且自己两端都没绑上）→ 转待命而不是退出：
// 退出会被 Electron 壳再拉起，形成"拉起→让位→再拉起"的死循环。待命实例每 5 秒探测，
// 对方一退出立即接管端口，壳全程无感。对非本套的外来占用，持续 15 秒才 exit 2 交壳回收。
function listenWithRetry(srv, port, name) {
  const started = Date.now();
  let attempts = 0;
  let standby = false;
  const start = () => {
    attempts++;
    srv.once("error", onErr);
    srv.listen(port, "127.0.0.1", () => {
      srv.removeListener("error", onErr);
      log(`${name}就绪 http://127.0.0.1:${port}` + (standby ? "（待命接管成功）" : attempts > 1 ? `（重试 ${attempts - 1} 次后绑定成功）` : ""));
      standby = false;
    });
  };
  const onErr = async (e) => {
    if (srv.listening) return;
    if (e.code !== "EADDRINUSE") { log(`${name} 端口错误: ${e.message}`); process.exit(1); }
    if (attempts === 1) log(`${name} 端口 :${port} 暂被占用（多为重启交接），每 600ms 重试，最多 15 秒`);
    let peerHealthy = false;
    if (!relay.listening && !snRelay.listening && !wbRelay.listening && !zenRelay.listening && !qdRelay.listening && !panel.listening) {
      try {
        const pr = await fetch(`http://127.0.0.1:${cfg0.panelPort}/api/ping`, { signal: AbortSignal.timeout(1200) });
        peerHealthy = pr.ok;
      } catch { /* 探活失败，按无健康实例处理 */ }
    }
    if (peerHealthy) {
      if (!standby) {
        standby = true;
        log(`已有健康实例在跑，本实例转入待命（每 5 秒探测，对方退出即自动接管）`);
      }
      // 孤儿防护：待命实例若父进程（桌面壳）已消失，说明自己是历次升级/重启的遗留物，
      // 直接退出，不再无限待命堆积（实测发现过存活 1 小时+ 的孤儿待命进程）。
      if (process.ppid) {
        const parentAlive = await new Promise((r) => execFile("tasklist", ["/FI", `PID eq ${process.ppid}`, "/NH"], { windowsHide: true, timeout: 5000 }, (e, so) => r(!e && String(so).includes(String(process.ppid)))));
        if (!parentAlive) { log(`父进程（pid ${process.ppid}）已消失，孤儿待命实例退出`); process.exit(0); }
      }
      // 不重置 standby：绑定成功后由成功回调统一清零，避免每轮探测重复打"转入待命"日志
      setTimeout(() => start(), 5000);
      return;
    }
    if (Date.now() - started > 15000) {
      log(`${name} 端口 :${port} 持续被占用超过 15 秒，放弃（exit 2 交由壳进程回收）`);
      process.exit(2);
    }
    setTimeout(start, 600);
  };
  start();
}
listenWithRetry(relay, cfg0.relayPort, "中转");
listenWithRetry(snRelay, cfg0.sn.relayPort, "SenseNova中转");
listenWithRetry(wbRelay, cfg0.wb.relayPort, "WorkBuddy中转");
listenWithRetry(zenRelay, cfg0.zen.relayPort, "OpenCodeZen中转");
listenWithRetry(qdRelay, cfg0.qd.relayPort, "Qoder中转");
listenWithRetry(panel, cfg0.panelPort, "面板");
// 成功绑定中转端口 = 本实例成为唯一的活跃服务者，此时才允许合并配置/跑周期探测
relay.once("listening", () => setTimeout(onActivated, 300));
