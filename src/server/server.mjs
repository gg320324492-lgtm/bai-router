// B.AI 路由台 —— 单进程双服务：
//   :relayPort  Anthropic 兼容中转（模型映射每次请求实时读 config.json，改了立即生效）
//   :panelPort  管理面板（UI + API：一键切换 / 一键恢复 / 映射编辑 / 状态体检）
// 启动方式任意：若缺 NODE_USE_ENV_PROXY 环境变量会自动以正确环境重启自己。
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, statSync } from "node:fs";
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
const DEFAULTS = {
  apiKey: "",
  upstream: "https://api.b.ai",
  proxy: "http://127.0.0.1:7890",
  relayPort: 15722,
  panelPort: 15723,
  defaultModel: "qwen3.8-flash",
  availableModels: ["qwen3.8-flash", "glm-5.3-flash", "deepseek-v4-flash"],
  mapping: Object.fromEntries(TIERS.map((t) => [t.key, { target: "qwen3.8-flash", label: t.zh }])),
};
function loadCfg() {
  try {
    const c = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return { ...DEFAULTS, ...c, mapping: { ...DEFAULTS.mapping, ...(c.mapping || {}) } };
  } catch (e) {
    log("config.json 读取失败，用默认配置:", e.message);
    return { ...DEFAULTS, mapping: { ...DEFAULTS.mapping } };
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

// ---------- 启动环境自检：缺代理环境变量则以正确环境重启自己 ----------
const cfg0 = loadCfg();
if (process.env.NODE_USE_ENV_PROXY !== "1") {
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
        ...(cfg0.proxy ? { HTTPS_PROXY: cfg0.proxy, HTTP_PROXY: cfg0.proxy } : {}), // 空代理 = 直连(TUN/全局模式)
        NO_PROXY: "127.0.0.1,localhost",
      },
    }
  );
  child.unref();
  log(`缺 NODE_USE_ENV_PROXY，已以正确环境重启自己 -> pid ${child.pid}`);
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
  const args = ["-s", "--ssl-no-revoke", "-m", "4", "-o", "NUL", "-w", "%{http_code}", "https://www.gstatic.com/generate_204"];
  if (proxy !== "DIRECT") args.splice(1, 0, "-x", proxy);
  return new Promise((res) => execFile("curl", args, { windowsHide: true, timeout: 8000 }, (e, so) => res(!e && /^(204|200|302)/.test(String(so).trim()))));
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
      const c = loadCfg();
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        detached: true, stdio: "ignore", windowsHide: true, cwd: HERE,
        env: { ...process.env, NODE_USE_ENV_PROXY: "1", ...(c.proxy ? { HTTPS_PROXY: c.proxy, HTTP_PROXY: c.proxy } : {}), NO_PROXY: "127.0.0.1,localhost" },
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
    const found = await detectWorkingProxy();
    if (found) applyProxy(found, reason);
  }, delay);
}
// 启动后探测一次；此后周期性自检；上游 fetch 失败时立刻触发
setTimeout(() => scheduleProxyCheck(0, "启动探测"), 2500);
setInterval(() => scheduleProxyCheck(0, "周期探测"), 10 * 60 * 1000);

// 发布机模型同步（每版本一次性、只增不删）：把 config.defaults.json 里的可选模型并进本机列表
try {
  const defaultsPath = path.join(HERE, "config.defaults.json");
  if (DATA_DIR !== HERE && existsSync(defaultsPath)) {
    const cur = loadCfg();
    if (cur._modelsSynced !== APP_VERSION) {
      const def = JSON.parse(readFileSync(defaultsPath, "utf8"));
      const merged = [...new Set([...(cur.availableModels || []), ...(def.availableModels || [])])];
      cur.availableModels = merged;
      cur._modelsSynced = APP_VERSION;
      saveCfg(cur);
      log(`可选模型已同步发布机（${merged.length} 个）`);
    }
  }
} catch (e) { log("模型同步跳过: " + e.message); }

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
const recentCalls = []; // {tier, served, at}
function recordCall(tier, served) {
  if (recentCalls[0] && recentCalls[0].tier === tier && Date.now() - recentCalls[0].at < 2000) {
    recentCalls[0].at = Date.now(); // 密集请求合并，只刷新时间
    return;
  }
  recentCalls.unshift({ tier, served, at: Date.now() });
  if (recentCalls.length > 30) recentCalls.pop();
}
function activeTier() {
  // 最近 30 分钟内被"真实会话"用过的档位；没有观察则返回 null（不再默认猜 Haiku）
  if (recentCalls.length && Date.now() - recentCalls[0].at < 30 * 60000) return recentCalls[0].tier;
  return null;
}

const relay = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const cfg = loadCfg(); // 每请求实时读：映射改完立即生效，无需重启
    let body = Buffer.concat(chunks);
    const ct = (req.headers["content-type"] || "").toLowerCase();
    if (body.length && ct.includes("json")) {
      try {
        const j = JSON.parse(body.toString("utf8"));
        if (typeof j.max_tokens === "number" && j.max_tokens < 3) j.max_tokens = 3; // 桌面版健康探测兼容
        if (typeof j.model === "string") {
          const tier = normalizeModel(j.model);
          j.model = resolveModel(j.model, cfg);
          // 只观察"真实会话"流量：max_tokens≥512 的对话请求。
          // 桌面版后台小请求(健康探测/起标题/摘要, max_tokens 通常 ≤128)不算"用户正在用的档位"
          if (req.method === "POST" && req.url.startsWith("/v1/messages") && typeof j.max_tokens === "number" && j.max_tokens >= 512) recordCall(tier, j.model);
        }
        body = Buffer.from(JSON.stringify(j));
      } catch { /* 非 JSON 原样透传 */ }
    }
    const headers = {};
    for (const k of PASS_HEADERS) if (req.headers[k]) headers[k] = req.headers[k];
    try {
      const { Readable } = await import("node:stream");
      // 探活级小请求（max_tokens≤8，桌面版健康检查/模型探测）遇 429 静默退避重试，
      // 避免限速窗口抖动被放大成桌面端的 "Gateway returned an error" 卡片
      let r;
      const isProbe = (() => { try { const j = JSON.parse(body.toString("utf8")); return typeof j.max_tokens === "number" && j.max_tokens <= 8; } catch { return false; } })();
      for (let attempt = 0; ; attempt++) {
        r = await fetch(cfg.upstream + req.url, { method: req.method, headers, body: body.length ? body : undefined });
        if (!isProbe || r.status !== 429 || attempt >= 3) break;
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      }
      const h = {};
      // fetch 已自动解压响应体，content-encoding 必须剥掉，否则客户端按 gzip 解明文会炸
      r.headers.forEach((v, k) => { if (!["content-length", "transfer-encoding", "connection", "content-encoding"].includes(k)) h[k] = v; });
      res.writeHead(r.status, h);
      if (r.body) {
        const stream = Readable.fromWeb(r.body);
        stream.pipe(res);
        stream.on("error", () => res.end());
      } else res.end();
    } catch (e) {
      if (String((e && e.message) || e).includes("fetch failed")) scheduleProxyCheck(0, "上游连接失败触发"); // 代理可能换了端口/挂了 → 自动探测
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "relay_error", message: String((e && e.message) || e) } }));
    }
  });
});

// ---------- 文件级操作 ----------
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
function desktopConfigFile() {
  try {
    const meta = readJson(META_FILE);
    if (meta.appliedId) return path.join(CFG_LIB, meta.appliedId + ".json");
  } catch {}
  return null;
}
function cliMode() {
  try {
    const u = readJson(SETTINGS)?.env?.ANTHROPIC_BASE_URL || "";
    if (u.includes("api.b.ai")) return { mode: "bai", baseUrl: u };
    if (u.includes(":15721")) return { mode: "ccswitch", baseUrl: u };
    return { mode: "other", baseUrl: u };
  } catch {
    return { mode: "unknown", baseUrl: "" };
  }
}
function desktopMode() {
  try {
    const f = desktopConfigFile();
    if (!f || !existsSync(f)) return { mode: "unknown", baseUrl: "" };
    const u = readJson(f)?.inferenceGatewayBaseUrl || "";
    if (u.includes(":15722")) return { mode: "bai", baseUrl: u };
    if (u.includes(":15721")) return { mode: "ccswitch", baseUrl: u };
    return { mode: "other", baseUrl: u };
  } catch {
    return { mode: "unknown", baseUrl: "" };
  }
}
// 把「当前非 B.AI 的配置」快照下来，作为将来一键恢复的还原点
function snapshotExternal() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const warns = [];
  const cm = cliMode();
  if (cm.mode !== "bai" && existsSync(SETTINGS)) {
    copyFileSync(SETTINGS, path.join(BACKUP_DIR, "external-cli.json"));
  } else if (cm.mode === "bai" && !existsSync(path.join(BACKUP_DIR, "external-cli.json"))) {
    warns.push("CLI 没有可恢复的 CC Switch 快照（当前已是 B.AI 且从未快照过）");
  }
  const dm = desktopMode();
  const df = desktopConfigFile();
  if (dm.mode !== "bai" && df && existsSync(df)) {
    copyFileSync(df, path.join(BACKUP_DIR, "external-desktop.json"));
  } else if (dm.mode === "bai" && !existsSync(path.join(BACKUP_DIR, "external-desktop.json"))) {
    warns.push("桌面版没有可恢复的 CC Switch 快照");
  }
  return warns;
}

function applyBaiToCli(cfg) {
  let s = {};
  try { s = readJson(SETTINGS); } catch { s = {}; }
  s.env = s.env || {};
  const e = s.env;
  e.ANTHROPIC_AUTH_TOKEN = cfg.apiKey;
  e.ANTHROPIC_BASE_URL = cfg.upstream;
  e.ANTHROPIC_MODEL = cfg.mapping["claude-haiku-4-5"]?.target || cfg.defaultModel;
  for (const t of TIERS) {
    e[t.envKey] = cfg.mapping[t.key]?.target || cfg.defaultModel;
    delete e[t.envKey + "_NAME"];
  }
  e.API_TIMEOUT_MS = e.API_TIMEOUT_MS || "3000000";
  e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  e.NODE_USE_ENV_PROXY = "1";
  e.HTTPS_PROXY = cfg.proxy;
  e.HTTP_PROXY = cfg.proxy;
  e.NO_PROXY = "127.0.0.1,localhost";
  writeAtomic(SETTINGS, JSON.stringify(s, null, 2) + "\n");
}
function applyBaiToDesktop(cfg) {
  const f = desktopConfigFile();
  if (!f) throw new Error("找不到桌面版配置文件（configLibrary/_meta.json）");
  writeAtomic(
    f,
    JSON.stringify(
      {
        coworkEgressAllowedHosts: ["*"],
        disableDeploymentModeChooser: true,
        inferenceGatewayApiKey: cfg.apiKey,
        inferenceGatewayAuthScheme: "bearer",
        inferenceGatewayBaseUrl: `http://127.0.0.1:${cfg.relayPort}`,
        inferenceModels: TIERS.map((t) => ({
          labelOverride: cfg.mapping[t.key]?.label || t.zh,
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
  if (target === "cli") {
    const bak = path.join(BACKUP_DIR, "external-cli.json");
    if (existsSync(bak)) {
      copyFileSync(bak, SETTINGS);
      return "已从快照恢复 CLI";
    }
    if (cliMode().mode === "bai") {
      writeAtomic(SETTINGS, JSON.stringify(FALLBACK_CC_CLI, null, 2) + "\n");
      return "CLI 无快照，已写入内置 CC Switch 兜底配置";
    }
    return "CLI 当前不是 B.AI 模式，无需恢复";
  }
  if (target === "desktop") {
    const bak = path.join(BACKUP_DIR, "external-desktop.json");
    const f = desktopConfigFile();
    if (existsSync(bak) && f) {
      copyFileSync(bak, f);
      return "已从快照恢复桌面版";
    }
    if (f && desktopMode().mode === "bai") {
      writeAtomic(f, JSON.stringify(FALLBACK_CC_DESK, null, 2) + "\n");
      return "桌面版无快照，已写入内置 CC Switch 兜底配置";
    }
    return "桌面版当前不是 B.AI 模式，无需恢复";
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

async function statusPayload() {
  const cfg = loadCfg();
  const [clash, ccswitch] = await Promise.all([checkClash(cfg), checkCcSwitch()]);
  return {
    now: new Date().toISOString(),
    service: { up: true, uptimeSec: Math.floor((Date.now() - BOOT) / 1000), pid: process.pid },
    relay: { port: cfg.relayPort, up: true },
    panel: { port: cfg.panelPort, up: true },
    clash,
    proxy: cfg.proxy || "直连",
    ccswitch: { running: ccswitch },
    upstream: { host: cfg.upstream, tested: lastTest.ok, ok: lastTest.ok, model: lastTest.model || null, ms: lastTest.ms || null, error: lastTest.error || null, at: lastTest.at || null },
    recent: (() => {
      const t = activeTier();
      if (!t) return { tier: null };
      const m = cfg.mapping?.[t] || {};
      const obs = recentCalls.find((x) => x.tier === t);
      return { tier: t, label: m.label || t, target: m.target || cfg.defaultModel, observedAt: obs ? obs.at : null };
    })(),
    cli: cliMode(),
    desktop: desktopMode(),
  };
}

const lastTest = { ok: null, model: null, ms: null, error: null, at: null };

const panel = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "http://127.0.0.1:" + loadCfg().panelPort);
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "ui.html")));
    }
    if (req.method === "GET" && u.pathname === "/api/ping") return json(res, 200, { ok: true });
    if (req.method === "GET" && u.pathname === "/api/version") return json(res, 200, { version: APP_VERSION });

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

    if (req.method === "POST" && u.pathname === "/api/config") {
      const b = await readBody(req);
      const cfg = loadCfg();
      if (typeof b.apiKey === "string" && b.apiKey.trim()) {
        const k = b.apiKey.trim();
        if (!k.startsWith("sk-")) return json(res, 400, { error: "API Key 应以 sk- 开头" });
        cfg.apiKey = k;
      }
      if (typeof b.proxy === "string") {
        const p = b.proxy.trim();
        if (p && !/^https?:\/\/127\.0\.0\.1:\d+$/.test(p)) return json(res, 400, { error: "代理格式应为 http://127.0.0.1:端口，留空表示直连" });
        cfg.proxy = p; // 留空 = 直连（TUN/全局模式）
      }
      if (b.mapping && typeof b.mapping === "object") {
        for (const t of TIERS) {
          const m = b.mapping[t.key];
          if (!m) continue;
          const target = String(m.target || "").trim().toLowerCase();
          const label = String(m.label || "").trim() || t.zh;
          if (!target) return json(res, 400, { error: `${t.key} 的目标模型不能为空` });
          cfg.mapping[t.key] = { target, label };
        }
      }
      if (Array.isArray(b.availableModels)) {
        const arr = b.availableModels.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
        if (arr.length) cfg.availableModels = [...new Set(arr)];
      }
      // ---- 可移植设置（跨机器编辑）----
      let needRestart = false;
      if (typeof b.proxy === "string" && b.proxy.trim()) {
        const p = b.proxy.trim();
        if (!/^https?:\/\/.+:\d+$/.test(p)) return json(res, 400, { error: "代理地址格式应为 http://127.0.0.1:端口" });
        if (p !== cfg.proxy) { cfg.proxy = p; needRestart = true; }
      }
      if (typeof b.upstream === "string" && b.upstream.trim()) {
        const up = b.upstream.trim().replace(/\/+$/, "");
        if (!/^https?:\/\//.test(up)) return json(res, 400, { error: "上游地址需以 http(s):// 开头" });
        if (up !== cfg.upstream) { cfg.upstream = up; needRestart = false; /* 中转每请求读取，无需重启 */ }
      }
      for (const portKey of ["relayPort", "panelPort"]) {
        if (b[portKey] != null && b[portKey] !== "") {
          const n = Number(b[portKey]);
          if (!Number.isInteger(n) || n < 1024 || n > 65535) return json(res, 400, { error: `${portKey} 需为 1024-65535 的整数` });
          if (n !== cfg[portKey]) { cfg[portKey] = n; needRestart = true; }
        }
      }
      if (typeof b.defaultModel === "string" && b.defaultModel.trim()) cfg.defaultModel = b.defaultModel.trim().toLowerCase();
      saveCfg(cfg);
      // 已处于 B.AI 模式的端立即同步新映射
      const applied = [];
      if (cliMode().mode === "bai") { applyBaiToCli(cfg); applied.push("cli"); }
      if (desktopMode().mode === "bai") { applyBaiToDesktop(cfg); applied.push("desktop"); }
      log("配置已保存，重应用到:", applied.join(",") || "无", needRestart ? "(需重启)" : "");
      return json(res, 200, {
        ok: true,
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

    if (req.method === "POST" && u.pathname === "/api/apply") {
      const b = await readBody(req);
      const cfg = loadCfg();
      if (!cfg.apiKey) return json(res, 400, { error: "请先在路由表里填写 API Key" });
      const doCli = b.cli !== false;
      const doDesk = b.desktop !== false;
      const warns = [];
      if (doCli) { const w = snapshotExternal(); warns.push(...w.filter((x) => x.startsWith("桌面"))); }
      if (doDesk) { const w = snapshotExternal(); warns.push(...w.filter((x) => x.startsWith("CLI"))); }
      if (doCli) applyBaiToCli(cfg);
      if (doDesk) applyBaiToDesktop(cfg);
      if (cfg.ccswitch?.running) warns.push("CC Switch 正在运行，它可能随时把配置改回去；切换前建议先退出它");
      warns.push("桌面版需完全退出并重开 Claude 才生效；CLI 新开终端生效");
      log(`一键切到 B.AI: cli=${doCli} desktop=${doDesk}`);
      return json(res, 200, { ok: true, warnings: warns, snapshot: "已自动快照切换前的配置（可用于一键恢复）" });
    }

    if (req.method === "POST" && u.pathname === "/api/restore") {
      const b = await readBody(req);
      const msgs = [];
      if (b.cli !== false) msgs.push(restoreExternal("cli", loadCfg()));
      if (b.desktop !== false) msgs.push(restoreExternal("desktop", loadCfg()));
      log("一键恢复:", msgs.join(" | "));
      return json(res, 200, { ok: true, messages: msgs, hints: ["桌面版需完全退出并重开 Claude 才生效；CLI 新开终端生效"] });
    }

    if (req.method === "POST" && u.pathname === "/api/test") {
      // 默认只测 Claude Code 当前真实使用的档位（与用户看到的名字对齐）；body.all=true 测全部
      const cfg = loadCfg();
      const b = await readBody(req).catch(() => ({}));
      const active = b.all ? null : activeTier();
      const targets = active ? [active] : TIERS.map((t) => t.key);
      const tierInfo = (key) => {
        const m = cfg.mapping[key] || {};
        return { label: m.label || key, target: m.target || cfg.defaultModel };
      };
      const probe = async (tier) => {
        const info = tierInfo(tier);
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) { // 上游偶发截断/挂起，测活流量重试两次
          const t0 = Date.now();
          try {
            const r = await fetch(`http://127.0.0.1:${cfg.relayPort}/v1/messages`, {
              method: "POST",
              headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json", "anthropic-version": "2023-06-01" },
              body: JSON.stringify({ model: tier + "[1M]", max_tokens: 8, messages: [{ role: "user", content: "ok" }] }),
              signal: AbortSignal.timeout(45000),
            });
            const j = await r.json();
            const ms = Date.now() - t0;
            if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
            return { tier, label: info.label, target: info.target, served: j.model, ok: true, ms, error: null };
          } catch (e) { lastErr = String(e?.message || e).slice(0, 100); }
        }
        return { tier, label: info.label, target: info.target, served: null, ok: false, ms: null, error: lastErr || "unknown" };
      };
      const tiers = await Promise.all(targets.map(probe));
      const pass = tiers.filter((x) => x.ok).length;
      Object.assign(lastTest, {
        ok: pass === tiers.length,
        model: tiers[0]?.label || null,
        ms: tiers[0]?.ms || null,
        error: pass === tiers.length ? null : tiers.filter((x) => !x.ok).map((x) => `${x.label}: ${x.error}`).join("；"),
        at: new Date().toISOString(),
      });
      return json(res, 200, { ok: pass === tiers.length, tiers, pass, total: tiers.length, active });
    }

    if (req.method === "POST" && u.pathname === "/api/service/stop") {
      json(res, 200, { ok: true, message: "服务即将停止（中转 15722 一并停止）" });
      log("收到停止指令，进程退出");
      setTimeout(() => process.exit(0), 300);
      return;
    }

    if (req.method === "POST" && u.pathname === "/api/service/restart") {
      // 浏览器模式下"保存并重启"用：以最新 config 起一个新实例然后自我退出。
      // Electron 托管时子进程退出会被主进程自动重拉，这里同样安全。
      const cfg = loadCfg();
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        detached: true, stdio: "ignore", windowsHide: true, cwd: HERE,
        env: { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: cfg.proxy, HTTP_PROXY: cfg.proxy, NO_PROXY: "127.0.0.1,localhost" },
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
// 端口被占 = 本进程无法工作，硬退出（exit 2），由 Electron 壳负责回收旧占用并进诊断页。
// 不再用"ping 面板端口判断已有实例"——那会被自己的面板骗到（自判 attached 死循环，v1.0.10 修复）
relay.on("error", (e) => { log(`relay 端口错误: ${e.message} —— :${cfg0.relayPort} 被其他程序占用，进程退出`); process.exit(e.code === "EADDRINUSE" ? 2 : 1); });
panel.on("error", (e) => { log(`panel 端口错误: ${e.message} —— :${cfg0.panelPort} 被其他程序占用，进程退出`); process.exit(e.code === "EADDRINUSE" ? 2 : 1); });
relay.listen(cfg0.relayPort, "127.0.0.1", () => log(`中转就绪 http://127.0.0.1:${cfg0.relayPort}`));
panel.listen(cfg0.panelPort, "127.0.0.1", () => log(`面板就绪 http://127.0.0.1:${cfg0.panelPort}`));
