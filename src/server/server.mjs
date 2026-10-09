// B.AI 路由台 —— 单进程双服务：
//   :relayPort  Anthropic 兼容中转（模型映射每次请求实时读 config.json，改了立即生效）
//   :panelPort  管理面板（UI + API：一键切换 / 一键恢复 / 映射编辑 / 状态体检）
// 启动方式任意：若缺 NODE_USE_ENV_PROXY 环境变量会自动以正确环境重启自己。
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, statSync, createWriteStream, readdirSync, rmSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import {
  CaptureRes, failoverCooldown, failoverClear, failoverAvailable, failoverSnapshot, failoverQuotaBlocked,
  shouldFailover, FAILOVER_COOLDOWN_MS,
} from "./failover.mjs";
import { qpApply, qpRevert, qpStatus } from "./qoder-patch.mjs";

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
  // 自动故障转移：Claude Code 只接一次线（指向当前提供方那个端口），之后由中转自己
  // 决定用谁。默认关闭——改变请求去向这种事得用户点头才开。
  failover: {
    enabled: false,
    // 转移顺序（当前提供方永远排第一，手动选的才是首选）。未配置凭据的会被自动跳过。
    // or（OpenRouter）**永远排最后**：用户原话「没有任何模型可用时的兜底」。
    chain: ["qd", "bai", "sn", "zen", "wb", "or"],
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
    // 实测（2026-10-03）能被外部 model server 调用的全集 = QD_EXTERNAL_OK 去掉服务端别名 lite
    // 后的那批；lite 是服务端别名，实际落到客户端目录里的免费档 qfmodel = Qwen3.8-Flash。
    // 全部付费档（price_factor>0）都列在这里，但**默认映射四个档位一律指向 lite（免费）**——
    // 用户不主动改映射就不会烧积分。ultimate 会被 Qoder 服务端间歇性拒（Bedrock 权限），
    // 已在 QD_FLAKY 标注，面板下拉里写明，别让人误以为是自己配错了。
    availableModels: ["lite", "auto", "performance", "ultimate", "qmodel", "kmodel", "dmodel", "mmodel", "gmodel"],
    mapping: defaultMapping("lite", "Qoder Lite"),
    token: "",
    tokenFile: path.join(os.tmpdir(), "qoder-token.json"),
    modelsFile: path.join(os.tmpdir(), "qoder-models.json"),
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

  // OpenRouter（v1.0.59）—— 第六个可路由提供方，**免费兜底区**（用户原话：没有任何
  // 模型可用时的兜底）。上游只讲 OpenAI 协议，复用通用协议桥；端口 15772。
  // 与前五家的三处不同：
  //  ① 凭据是 `keys[]`（最多 3 把，轮换用），不是单个 apiKey——明文只落 config.json，
  //     绝不进 config.defaults.json / providers.js / HANDOFF.md（安全红线）。
  //  ② 模型目录按 pricing 全 0 实测筛（不能只看 :free 后缀），见 orRefreshFreeModels。
  //  ③ 429 有两种 limit_source，必须分流换模型 / 换 key —— 见 orAdvance()。
  or: {
    upstream: "https://openrouter.ai/api/v1",
    relayPort: 15772,
    defaultModel: "openrouter/free",
    // 发布机种子（实测 2026-10-07：466 个模型中 18 个文本类免费模型；
    // 另两个 google/lyria-* 虽 pricing 全 0 但是音乐模型，不进对话下拉）。
    // 面板「刷新模型列表」会按 pricing 重筛并覆盖这份列表。
    availableModels: [
      "openrouter/free",
      "inclusionai/ling-3.1-flash",
      "apodex/apodex-1.1-mini:free",
      "inclusionai/ling-3.0-flash-sante:free",
      "dots-studio/dots-3-note-preview:free",
      "liquid/lfm-2.5-2.6b:free",
      "nvidia/nemotron-3.5-lightning:free",
      "thinkingmachines/inkling-small:free",
      "poolside/laguna-s-2.1:free",
      "thinkingmachines/inkling:free",
      "poolside/laguna-xs-2.1:free",
      "cohere/north-mini-code:free",
      "nvidia/nemotron-3.5-content-safety:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "google/gemma-4-26b-a4b-it:free",
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
    ],
    mapping: defaultMapping("openrouter/free", "OpenRouter Free"),
    keys: [],        // 最多 3 把 sk-or-v1…；本机 config.json 专属，种子里恒为空
    useProxy: false, // 实测 openrouter.ai 直连可达；被墙时在面板勾「走本机代理」
  },
};

// ---------- WorkBuddy 版别检测（v1.0.59）：按登录域名自动选上游 ----------
// WorkBuddy 分两版，令牌**不通用**——国内版令牌打国际端点必然 401：
//   国际版 workbuddy-desktop-ai → 登录域名 www.workbuddy.ai → 上游 https://www.workbuddy.ai
//   国内版 workbuddy-desktop    → 登录域名 www.workbuddy.cn → 上游 https://www.workbuddy.cn
// 判定依据（bundle 逆向）：客户端读 %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\
// <authentication.id>.info 的 auth.domain。本机只**读**该目录判版，绝不写（契约硬约束）；
// 注意 accessToken 落盘是 {$wbEncrypted:1, envelope:…} 加密信封，读盘取明文此路不通，
// 令牌仍走注入捕获——这里只取 domain 判版，不碰任何令牌字段。
const WB_UPSTREAM_INTL = "https://www.workbuddy.ai"; // 国际版默认（= DEFAULTS.wb.upstream，两处同步）
const WB_UPSTREAM_CN = "https://www.workbuddy.cn";    // 国内版默认
const WB_AUTH_IDS = ["workbuddy-desktop-ai", "workbuddy-desktop"]; // 两版 authentication.id

// auth 目录（可注入）：测试用 BAI_WB_AUTH_DIR 指向临时伪造目录即可做双向版别验证，
// 真实 auth 目录永远只读。
function wbAuthDir() {
  const inject = String(process.env.BAI_WB_AUTH_DIR || "").trim();
  if (inject) return inject;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "CodeBuddyExtension", "Data", "Public", "auth");
}

// 纯函数：登录域名 → 版别。语义对齐 product.json 的 external/internalDomain 分流：
//   *.workbuddy.ai（含 www.workbuddy.ai）→ "intl"；
//   其余非空域名（www.workbuddy.cn、copilot.tencent.com 等 internalDomain）→ "cn"；
//   空/缺失/读不出 → null（读不到登录态时不做任何上游翻转）。
function wbEditionOfDomain(domain) {
  const raw = String(domain == null ? "" : domain).trim().toLowerCase();
  if (!raw) return null;
  let host = "";
  try { host = new URL(raw.includes("://") ? raw : "https://" + raw).hostname; }
  catch { host = raw.split("/")[0].split(":")[0]; }
  host = host.replace(/\.+$/, "");
  if (!host) return null;
  return host === "workbuddy.ai" || host.endsWith(".workbuddy.ai") ? "intl" : "cn";
}

// 纯函数：读指定 auth 目录里「活跃」的登录文件（两版 id 都试）。
// 只认精确文件名 <id>.info——`*.logged-out`（已登出）与 `<id>.<ISO时间戳>….info`
// （历史快照，本机实测各有其例）一律排除；两版同时活跃时取 mtime 更新的那个（谁在用听谁的）。
// 返回 { id, file, domain } 或 null；文件损坏时顺位试下一个，都坏则 null。
function wbReadAuthDomain(authDir) {
  if (!authDir) return null;
  let names;
  try { names = readdirSync(authDir); } catch { return null; }
  const cands = [];
  for (const id of WB_AUTH_IDS) {
    const base = id + ".info";
    if (!names.includes(base)) continue;
    const f = path.join(authDir, base);
    try { cands.push({ id, f, mtime: statSync(f).mtimeMs }); } catch { /* 读不到就跳过 */ }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.mtime - a.mtime);
  for (const c of cands) {
    try {
      const j = JSON.parse(readFileSync(c.f, "utf8"));
      const d = j && j.auth && typeof j.auth.domain === "string" ? j.auth.domain.trim() : "";
      return { id: c.id, file: c.f, domain: d || null };
    } catch { /* 这份坏了就试下一份 */ }
  }
  return null;
}

// 版别检测入口（带 1.5s 进程内缓存：loadCfg 每请求都走到这里，别为判版反复打磁盘）
let wbAuthCache = { at: 0, dir: null, res: null };
function wbDetectAuth(authDir) {
  const dir = authDir || wbAuthDir();
  const now = Date.now();
  if (wbAuthCache.res && wbAuthCache.dir === dir && now - wbAuthCache.at < 1500) return wbAuthCache.res;
  const hit = wbReadAuthDomain(dir);
  const res = {
    authDir: dir,
    file: hit ? hit.file : null,
    domain: hit ? hit.domain : null,
    edition: hit && hit.domain ? wbEditionOfDomain(hit.domain) : null, // "cn" | "intl" | null
  };
  wbAuthCache = { at: now, dir, res };
  return res;
}

// 自愈覆盖（供 loadCfg 的两条返回路径共用）：**仅当当前 upstream 恰好等于另一版的默认值**
// 才翻转——用户显式改成过别的地址（自建中转等）一律不碰，与 fixQdFile「尊重用户设置」
// 同一哲学。只改内存里的合并结果，不主动回写 config.json；判不出版别（null）时保持原值。
function wbHealUpstream(w) {
  if (!w || typeof w !== "object") return w;
  const ed = wbDetectAuth().edition;
  if (ed === "cn" && w.upstream === WB_UPSTREAM_INTL) w.upstream = WB_UPSTREAM_CN;
  else if (ed === "intl" && w.upstream === WB_UPSTREAM_CN) w.upstream = WB_UPSTREAM_INTL;
  return w;
}

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
    // failover 深合并
    merged.failover = { ...DEFAULTS.failover, ...(c.failover || {}) };
    if (!Array.isArray(merged.failover.chain) || !merged.failover.chain.length) {
      merged.failover.chain = [...DEFAULTS.failover.chain];
    }
    // or（OpenRouter 兜底）**只追加、不重排**：存量 config.json 的 chain 是五家时代写的，
    // 没有 or。这里在末尾补一个（已有就不动），既不改变用户排好的顺序，也不破坏
    // ["qd","bai","sn","zen","wb"] 这份现值。注意：or 未配置 key 时会被自动跳过，
    // 追加它对存量行为零影响。
    if (Array.isArray(merged.failover.chain) && !merged.failover.chain.includes("or")) {
      merged.failover.chain = [...merged.failover.chain, "or"];
    }
    // or 深合并（同上：旧 config.json 没有 or 块时整块补默认）
    const orIn = c.or || {};
    merged.or = {
      ...DEFAULTS.or, ...orIn,
      mapping: { ...DEFAULTS.or.mapping, ...(orIn.mapping || {}) },
      availableModels: Array.isArray(orIn.availableModels) && orIn.availableModels.length ? orIn.availableModels : [...DEFAULTS.or.availableModels],
      keys: Array.isArray(orIn.keys) ? orIn.keys.filter((k) => typeof k === "string" && k.trim()) : [],
    };
    // qd 深合并（同上）
    const qdIn = c.qd || {};
    merged.qd = {
      ...DEFAULTS.qd, ...qdIn,
      mapping: { ...DEFAULTS.qd.mapping, ...(qdIn.mapping || {}) },
      availableModels: Array.isArray(qdIn.availableModels) && qdIn.availableModels.length ? qdIn.availableModels : [...DEFAULTS.qd.availableModels],
    };
    // 令牌/模型文件路径纠正（v1.0.57）：早期 config.defaults.json 把它写死成发布机的
    // 绝对路径（C:\Users\admin\…\Temp\qoder-token.json）。换一台电脑时这个路径既不属于
    // 该机的临时目录、也可能根本不存在，导致补丁写的文件与中转读的文件不是同一份，
    // 面板永远显示「未读到」。这里：空值、或「盘符/用户目录明显不是本机」的路径，
    // 一律改回本机 os.tmpdir()（与补丁写入位置一致）。
    const fixQdFile = (v, name) => {
      const def = path.join(os.tmpdir(), name);
      if (typeof v !== "string" || !v.trim()) return def;
      const norm = path.normalize(v.trim());
      // 已经是本机临时目录下的同名文件 → 尊重用户设置
      if (norm.toLowerCase() === def.toLowerCase()) return v;
      // 绝对路径但父目录在本机不存在 → 视为「从别的机器带过来的」，换回本机默认
      if (path.isAbsolute(norm) && !existsSync(path.dirname(norm))) return def;
      return v;
    };
    merged.qd.tokenFile = fixQdFile(merged.qd.tokenFile, "qoder-token.json");
    merged.qd.modelsFile = fixQdFile(merged.qd.modelsFile, "qoder-models.json");
    // 版别自愈（v1.0.59）：按登录域名把 wb.upstream 拨到对应版别的默认端点
    wbHealUpstream(merged.wb);
    return merged;
  } catch (e) {
    log("config.json 读取失败，用默认配置:", e.message);
    const fallback = { ...DEFAULTS, mapping: { ...DEFAULTS.mapping }, sn: { ...DEFAULTS.sn, mapping: { ...DEFAULTS.sn.mapping }, availableModels: [...DEFAULTS.sn.availableModels] }, zen: { ...DEFAULTS.zen, mapping: { ...DEFAULTS.zen.mapping }, availableModels: [...DEFAULTS.zen.availableModels] }, wb: { ...DEFAULTS.wb, mapping: { ...DEFAULTS.wb.mapping }, availableModels: [...DEFAULTS.wb.availableModels] }, qd: { ...DEFAULTS.qd, mapping: { ...DEFAULTS.qd.mapping }, availableModels: [...DEFAULTS.qd.availableModels] }, or: { ...DEFAULTS.or, mapping: { ...DEFAULTS.or.mapping }, availableModels: [...DEFAULTS.or.availableModels], keys: [] }, failover: { ...DEFAULTS.failover, chain: [...DEFAULTS.failover.chain] } };
    wbHealUpstream(fallback.wb);
    return fallback;
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
  // v1.0.59：wb 上游按登录版别在 .ai/.cn 之间自愈（loadCfg 的 wbHealUpstream），NO_PROXY 把
  // 两个版别的默认域**都**收进来——否则切到国内版后实际打的 www.workbuddy.cn 不在表里、
  // 直连语义失效；也免得 main.js（读原始 config）与本函数（读自愈结果）各算一张不一样的表。
  // 这三行 add 与 src/main.js 的 addNoProxyHost 三行**逐字同步**（顺序也要一致：先 intl、
  // 再 cn、再当前 upstream 值），否则精确比对判定漂移 → 警告/重启风险（历史事故同款）。
  const wbUseProxy = cfg.wb?.useProxy === true;
  add(hostOf(WB_UPSTREAM_INTL), wbUseProxy);
  add(hostOf(WB_UPSTREAM_CN), wbUseProxy);
  add(hostOf(cfg.wb?.upstream || DEFAULTS.wb.upstream), wbUseProxy);
  add(hostOf(cfg.sn?.upstream || DEFAULTS.sn.upstream), cfg.sn?.useProxy === true);
  add(hostOf(cfg.zen?.upstream || DEFAULTS.zen.upstream), cfg.zen?.useProxy === true);
  add(hostOf(cfg.qd?.upstream || DEFAULTS.qd.upstream), cfg.qd?.useProxy === true);
  // OpenRouter（第 6 家）：与上面四行**逐字同构**，且必须与 src/main.js 的
  // addNoProxyHost(cfg.or?.upstream || "https://openrouter.ai/api/v1", cfg.or?.useProxy)
  // 同序同条件——两边不对称 = NO_PROXY 漂移 = 自重启被看门狗计成崩溃（历史事故）。
  add(hostOf(cfg.or?.upstream || DEFAULTS.or.upstream), cfg.or?.useProxy === true);
  return list.join(",");
}
const cfg0 = loadCfg();
const wantNoProxy = computeNoProxy(cfg0);
const envNoProxy = process.env.NO_PROXY || "";
const noProxyMismatch = envNoProxy !== wantNoProxy;
const needEnvRestart =
  process.env.NODE_USE_ENV_PROXY !== "1" ||
  (process.env.BAI_ENV_FIXED !== "1" && noProxyMismatch);
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
// 壳进程已声明 env 就位（BAI_ENV_FIXED=1）却发现 NO_PROXY 对不上：只告警、绝不自动重启。
// 自动重启在这里是有害的——每次自重启都会 exit(0)，壳进程的看门狗把它计成崩溃并再拉起一个，
// 于是端口互抢 + "服务已自动恢复运行"弹窗反复弹出，形成死循环（v1.0.37 真实发生过）。
// 真要对齐，改 src/main.js 的 noProxyList 补上漏掉的提供方即可。
if (process.env.BAI_ENV_FIXED === "1" && noProxyMismatch) {
  log(`⚠ NO_PROXY 与本进程计算结果不一致：壳进程传入=${envNoProxy || "(空)"} / 应为=${wantNoProxy}。已跳过自动纠正以避免重启循环——请检查 src/main.js 的 noProxyList 是否漏了提供方。`);
}
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
        // OpenRouter 免费目录随版本进位推到存量机器（同样只增不删）
        if (def.or && Array.isArray(def.or.availableModels) && def.or.availableModels.length) {
          if (!cur.or) cur.or = { ...DEFAULTS.or };
          cur.or.availableModels = [...new Set([...(cur.or.availableModels || []), ...def.or.availableModels])];
        }
        cur._modelsSynced = APP_VERSION;
        saveCfg(cur);
        log(`可选模型已同步发布机（${merged.length} 个 + SenseNova ${cur.sn.availableModels.length} 个 + WorkBuddy ${cur.wb.availableModels.length} 个 + Qoder ${cur.qd.availableModels.length} 个 + OpenRouter ${((cur.or && cur.or.availableModels) || []).length} 个）`);
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
const recentCallsOr = [];   // OpenRouter（第 6 家）
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
  or: { kind: null, message: null, at: null },
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

// ---------- 上游失败的"人话"归因 ----------
// 上游的失败原因通常藏在响应体里（{"error": …}），而空响应体、HTML 拦截页被笼统说成
// "非 JSON"既自相矛盾（同一个括号里 Content-Type 还写着 application/json），又把这轮
// 真正的原因（key 没权限 / 模型名不对 / 额度用尽）全丢了。下面几个函数只负责把失败
// 翻译成一句能直接读懂的话；解析成功时 readProbeJson 照常返回原对象，
// 成功/失败判定与 HTTP 状态码透传一律不动。
// 这些状态码九成就是这几条原因，而上游在空响应体里一个字都不说。
const PROBE_HINTS = {
  400: "，常见原因是：模型名不被这个 Key 支持，或请求被上游校验拒绝",
  401: "，常见原因是：API Key 没填或填错",
  403: "，常见原因是：这个 Key 没有该模型权限，或额度已用尽",
  404: "，常见原因是：上游地址或模型名写错",
  429: "，常见原因是：免费渠道并发限流，等 30 秒左右再试",
};
// 响应体是合法 JSON 但带 error 字段——上游最常见的拒绝格式，写法有五六种：
//   {"error":{"message":…}} / {"error":"Forbidden"} / {"error":{"code":…,"type":…}} / {"message":…} / {"msg":…}
// 挨个试一遍，抠到就返回；抠不到返回 null（绝不用空串冒充"已说明"）。
function upstreamErrorText(j, max = 50) {
  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);
  if (typeof j === "string") return pick(j);
  if (!j || typeof j !== "object") return null;
  const e = j.error;
  if (e && typeof e === "object") return pick(e.message) || pick(e.detail) || pick(e.code) || pick(e.type) || null;
  if (e != null) return pick(e);
  return pick(j.message) || pick(j.msg) || pick(j.detail) || null;
}
// OpenAI 兼容上游（WorkBuddy / Zen / Qoder）非 2xx 时的正文归因。
// 旧写法是 `jj.msg || jj.message || jj.error.message || txt` —— 四个都取不到就把整段原始正文
// 原样交给用户：整页 HTML 拦截页、整段 JSON、几百字英文堆栈，一句话里说不清也读不动。
// 这里按"空 / HTML / JSON 无 error 字段 / 其它非 JSON"分级，一律换成人话并限长。
function upstreamBodyText(txt, max = 160) {
  const raw = String(txt || "").trim();
  if (!raw) return "上游返回空响应体，没给出任何错误信息";
  if (/^\s*</.test(raw)) {
    const title = (raw.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
    return `上游返回 HTML 页面而不是接口响应${title ? `（页面标题：${title.trim().slice(0, 60)}）` : ""}——多半被代理或 WAF 拦下，请确认代理通道与上游地址`;
  }
  try {
    const said = upstreamErrorText(JSON.parse(raw), max);
    if (said) return said;
    return `上游返回了 JSON 但里面没有 error 字段，无法判断原因：${raw.slice(0, 120)}`;
  } catch { /* 不是 JSON */ }
  return `上游返回了非 JSON 内容：${raw.slice(0, 120)}`;
}
// 解析失败（或根本没正文）时的归因：按"最可能的解释"分级，不再一律叫"非 JSON"。
function probeBodyError(response, raw) {
  const status = response.status;
  const type = response.headers.get("content-type") || "未知";
  const hint = PROBE_HINTS[status] || "";
  const body = String(raw || "").trim();
  if (!body) {
    // 上游返 4xx/5xx 却不给正文（B.AI 实测常这样）：它没告诉我们原因，
    // 只能把状态码和 request-id 摊开——后者拿去问上游/看日志能直接定位到那一次请求。
    // 刻意不带 Content-Type：正文为空时它没有任何信息量，正是它让旧文案自相矛盾。
    const rid = response.headers.get("x-request-id") || response.headers.get("request-id") || "";
    return new Error(`上游返回空响应体（HTTP ${status}${rid ? `，request-id ${String(rid).slice(0, 32)}` : ""}）——没带任何错误信息${hint}`);
  }
  if (/^\s*</.test(body)) {
    return new Error(`上游返回 HTML 页面而不是接口响应（HTTP ${status}）——多半被代理或 WAF 拦下，请确认代理通道与上游地址${hint}`);
  }
  return new Error(`上游返回的内容不是合法 JSON（HTTP ${status}，Content-Type: ${type}）：${body.slice(0, 120)}`);
}
async function readProbeJson(response) {
  const raw = await response.text();
  let j = null;
  try { j = JSON.parse(raw); } catch { j = null; }
  // 失败优先归因。三个调用点（/api/models 的 sn 与默认分支、/api/test 的档位探测）
  // 拿到 JSON 后都只会读 error.message，"Forbidden" 这类裸字符串错误就整条丢了。
  if (response.status >= 400) {
    if (j === null) throw probeBodyError(response, raw);
    const said = upstreamErrorText(j);
    if (!said) throw new Error(`上游返回 HTTP ${response.status}，但没带错误说明${PROBE_HINTS[response.status] || ""}`);
    // 上游已经把状态码和原因说全了（多半是本机中转转译过的 429/502），别再复述一遍
    if (said.includes(`HTTP ${response.status}`)) throw new Error(`上游错误：${said}`);
    throw new Error(`上游拒绝请求（HTTP ${response.status}${PROBE_HINTS[response.status] || ""}）：${said}`);
  }
  if (j === null) throw probeBodyError(response, raw);
  return j;
}

// 面板「上游」那盏灯的副行只有一行高度，错误文案必须自己收着。旧写法逐档原样拼接有两个毛病：
//   ① 配置里常有多个档位指向同一模型（Sonnet 与 Opus 都映射 HY3），同一句话会重复三遍；
//   ② 四档各带一段原因 → 副行被撑成三行高，把整排灯卡拉高、底边对不齐。
// 故：按 label 去重 → 优先给"几档中几档失败 + 哪些档位"的概览 → 原因最多列 2 项、
// 其余用数量收尾 → 总量硬性截到 120 字。
const TIER_ERR_MAX = 120;
function summarizeTierErrors(tiers) {
  const bad = tiers.filter((x) => !x.ok);
  if (!bad.length) return null;
  const uniq = new Map();
  for (const x of bad) if (!uniq.has(x.label)) uniq.set(x.label, String(x.error || "未知错误"));
  const labels = [...uniq.keys()];
  const reasons = [...new Set(uniq.values())];
  // 全部档位栽在同一件事上（key/额度/模型名整体不可用，最常见）→ 只说一次，别按档位复述
  const full = reasons.length === 1
    ? `${tiers.length} 档中 ${bad.length} 档失败（${labels.join("、")}）：${reasons[0]}`
    : `${tiers.length} 档中 ${bad.length} 档失败：${labels.join("、")}。${
      [...uniq].slice(0, 2).map(([label, err]) => `${label}: ${err}`).join("；")
    }${labels.length > 2 ? `；其余 ${labels.length - 2} 档的原因从略` : ""}`;
  if (full.length <= TIER_ERR_MAX) return full;
  // 概览优先保留（"几档中几档、哪些档位"才是用户要的第一眼信息），细节按剩余预算裁剪
  const head = `${tiers.length} 档中 ${bad.length} 档失败（${labels.join("、")}）`;
  const room = TIER_ERR_MAX - head.length - 2;
  return room > 4
    ? `${head}：${reasons.join(" / ").slice(0, room)}…`
    : head.slice(0, TIER_ERR_MAX);
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

// ---------- OpenCode Zen 模型目录（v1.0.42）----------
// 公开接口，无需鉴权也不需要任何补丁——这点与 Qoder 正好相反（Qoder 的目录要靠 worker
// 钩子导出明文）。但公开目录只给 id，没有价格/免费标记，可用性只能按实测结论标注。
//
// 实测（2026-10，用户 Free key）：84 个模型里 11 个标 -free，其中只有 space-bunny-free
// 能外部调用；其余 -free 一律返回 FreeTierError「only be used from within OpenCode」——
// 这是产品级封锁，没有服务端别名可绕，不像 Qoder 的 lite 恰好落在免费档上。
// 付费模型则需 key 有余额（当前为 0，一律 402 Insufficient account funds）。
const ZEN_EXTERNAL_OK = new Set(["space-bunny-free"]);
let zenCatCache = { at: 0, list: [] };
async function zenReadCatalog() {
  if (Date.now() - zenCatCache.at < 30 * 60 * 1000 && zenCatCache.list.length) return zenCatCache.list;
  try {
    const fr = await fetch("https://opencode.ai/zen/v1/models", { signal: AbortSignal.timeout(15000) });
    const jj = await fr.json();
    const list = (jj.data || []).map((m) => String(m.id || "").trim()).filter(Boolean);
    if (list.length) zenCatCache = { at: Date.now(), list };
    return zenCatCache.list;
  } catch {
    return zenCatCache.list;
  }
}

// ---------- Qoder 模型目录（v1.0.41）----------
// worker 拉回 /algo/api/v2/model/list 后在本地解密再 parse，补丁把那份**明文**目录写到
// qoderModelsFile；这里直接读，无需复刻 Cosy 签名或解磁盘上的加密缓存。
//
// 两套命名空间必须分清：
//   · 目录里的 key（qfmodel / qmodel_38max / dmodel …）是 Qoder **客户端内**用的模型 id，
//     其中 `qfmodel` = Qwen3.8-Flash、price_factor 0（免费）。
//   · 外部 model server（api2-v2.qoder.sh）只认其中一部分，外加 `lite` 这个服务端别名
//     ——实测 `lite` 落到通义千问 Qwen3，即客户端里那个免费的 Qwen3.8-Flash。
// 所以下拉框只放外部真能调通的（QD_EXTERNAL_OK），其余照实列出并标注"仅客户端内可用"，
// 免得用户选了必然 400 的模型。
//
// QD_EXTERNAL_OK 的依据（实测 2026-10-03，用 %TEMP%/qoder-token.json 的 jt- 令牌直连
// https://api2-v2.qoder.sh/model/v1/chat/completions，每个别名连测 3 次）：
//   3/3 通过：lite(0×) / qmodel / mmodel / auto / dmodel / kmodel / gmodel / performance
//   intermittent：ultimate(2×) 首次成功、第二次 All models failed —— 错误细节是
//     「arn:aws:iam::…:user/bedrock-test is not authorized to perform: bedrock:InvokeModel」，
//     即 **Qoder 服务端自己的 AWS Bedrock 权限问题**，与本机账号/积分无关。
//     故仍列入（它多数时候能用），但标注「Qoder 侧偶发失败」，别让用户以为是自己配错了。
//   被服务端直接拒（invalid_model_error: Unsupported model —— 服务端不认这些名字，非权限问题）：
//     smodel(8×) / cmodel(4×) / qmodel_38max / gfmodel(0.1×) / dfmodel(0.1×)
//   efficient(0.3×) → provider_error: All backends failed（后端全挂）
// 未实测、故**不列**的客户端目录项：qfmodel / qmodel_latest / kmodel_latest
//   （宁可漏列，也不要给用户一个必然报错的选项）
const QD_EXTERNAL_OK = new Set([
  "lite", "auto", "ultimate", "performance",
  "qmodel", "kmodel", "dmodel", "mmodel",
  // gmodel = GLM-5.3，付费档 0.8×（此前漏列，实测 3/3 通过）
  "gmodel",
]);
// 实测会间歇失败的付费档（Qoder 服务端 Bedrock 权限问题，见上）。下拉里如实标注。
const QD_FLAKY = new Set(["ultimate"]);
// 读不到客户端目录（Qoder 没开 / 补丁没生效）时的兜底价格表，取自
// %TEMP%/qoder-models.json 的 app 数组快照（实测 2026-10-03）。
// 只有下拉标注用，不参与路由——绝不能让"标注"变成"默认走付费"。
//
// ⚠ qmodel / qmodel_38max 有**错峰折扣**（每晚 22:00-08:00 打到 4 折），
// 所以它们的价格随时钟变：目录里 promotion.before_promotion_price_factor 是原价、
// price_factor 是当刻折后价。这张静态表记的是快照值，只在读不到目录时兜底；
// 标注里会带上原价，避免把夜间折后价当成全天价。
const QD_PRICE_FALLBACK = {
  lite: 0, auto: 0.5, performance: 1.1, ultimate: 2,
  qmodel: 0.04, mmodel: 0.2, dmodel: 0.5, kmodel: 0.8, gmodel: 0.8,
};
// 错峰折扣：key → 原价（快照 2026-10-03 23:58 UTC+8，���于折后窗口内）
const QD_PEAK_PRICE = { qmodel: 0.1, qmodel_38max: 0.5 };
// 目录读不到时也要如实标注价格，否则用户会以为下拉里都是一样的。
function qdStaticCatalog(S) {
  const models = [...(S.availableModels || DEFAULTS.qd.availableModels)];
  const all = models.map((key) => {
    const pf = QD_PRICE_FALLBACK[key];
    return {
      key,
      name: (key === "lite" ? "Qwen3.8-Flash" : key),
      free: pf === 0, price: pf ?? null, priceFactor: pf ?? null,
      peakPrice: QD_PEAK_PRICE[key] != null && pf !== QD_PEAK_PRICE[key] ? QD_PEAK_PRICE[key] : null,
      paid: typeof pf === "number" && pf > 0,
      flaky: QD_FLAKY.has(key),
      external: QD_EXTERNAL_OK.has(key),
    };
  });
  const labels = {};
  for (const m of all) {
    if (!m.external) continue;
    // 与目录路径同一套措辞：错峰折后价要把原价也写出来，别让夜间 4 折被当成全天价
    const cost = !m.paid ? "免费"
      : (m.peakPrice != null ? `${m.priceFactor}×积分（原价 ${m.peakPrice}×积分）` : `${m.priceFactor}×积分`);
    labels[m.key] = [m.name, cost, m.flaky ? "Qoder 侧偶发失败" : ""]
      .filter(Boolean).join(" · ");
  }
  return {
    ok: true, static: true, count: models.length, models, all, labels,
    paidCount: all.filter((m) => m.paid).length,
    freeCount: all.filter((m) => !m.paid).length,
    note: "尚未读到 Qoder 模型目录（需 Qoder 客户端在运行且补丁已生效），当前显示的是内置默认列表；"
      + "价格按 2026-10-03 实测快照标注，付费档请在客户端里核对倍率",
  };
}
let qdCatalogCache = { key: null, at: 0, val: null };
function qdReadCatalog(cfg) {
  const file = (cfg.qd && cfg.qd.modelsFile) || DEFAULTS.qd.modelsFile;
  try {
    const st = statSync(file);
    if (qdCatalogCache.key === st.mtimeMs && Date.now() - qdCatalogCache.at < 5000) return qdCatalogCache.val;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(raw && raw.app) ? raw.app : [];
    if (!list.length) return { ok: false };
    const all = list.map((m) => {
      const key = String(m.key || "");
      const pf = typeof m.price_factor === "number" ? m.price_factor : null;
      return {
        key,
        name: String(m.display_name || key || ""),
        free: m.is_free === true || pf === 0,
        // price_factor 原样透出（面板按它标注花费），paid 与 free 互斥且互为补集——
        // 免费档显示「免费」，其余一律带倍率，绝不把付费档显示成免费。
        price: pf,
        priceFactor: pf,
        // 错峰折扣：Qoder 每晚 22:00-08:00 给部分模型打到 4 折。此时 price_factor
        // 是折后价，原价在 promotion.before_promotion_price_factor。一并透出，
        // 让面板能写「0.04×（原价 0.1×）」而不是把夜间价当全天价。
        peakPrice: (m.promotion && typeof m.promotion.before_promotion_price_factor === "number")
          ? m.promotion.before_promotion_price_factor
          : (QD_PEAK_PRICE[key] != null && pf !== QD_PEAK_PRICE[key] ? QD_PEAK_PRICE[key] : null),
        promoBadge: (m.promotion && m.promotion.badge && String(m.promotion.badge.zh || m.promotion.badge.en || "")) || "",
        paid: pf != null && pf > 0,
        flaky: QD_FLAKY.has(key),
        isDefault: m.is_default === true,
        reasoning: m.is_reasoning === true,
        maxInput: m.max_input_tokens,
        external: QD_EXTERNAL_OK.has(key),
      };
    });
    // `lite` 不在客户端目录里（是服务端别名），单独补进去并注明它就是免费那档
    if (!all.some((m) => m.key === "lite")) {
      all.unshift({ key: "lite", name: "Qwen3.8-Flash", free: true, price: 0, priceFactor: 0,
        paid: false, flaky: false, isDefault: true, reasoning: false, maxInput: null,
        external: true, alias: true });
    }
    // 下拉框用 key（lite/qmodel/…）对用户毫无意义，换成看得懂的名字。
    // 目录里有的取 display_name；lite/auto/ultimate/performance 这类档位名补一句说明。
    const TIER_DESC = {
      lite: "免费档",
      auto: "自动选路",
      ultimate: "最强档",
      performance: "均衡档",
      efficient: "高效档",
    };
    // 倍率文案。price_factor 是 Qoder 计费的相对倍率：0=免费，0.8=按 0.8 倍扣积分。
    const factorText = (pf) => (pf != null && pf > 0 ? `${pf}×积分` : "免费");
    const labels = {};
    for (const m of all) {
      if (!m.external) continue;
      const base = m.name || m.key;
      const tier = TIER_DESC[m.key] || "";
      // 正在错峰打折时，把原价也写出来——否则用户会把夜间 4 折当成全天价。
      const cost = m.free
        ? "免费"
        : (m.peakPrice != null && m.peakPrice !== m.priceFactor
          ? `${factorText(m.priceFactor)}（原价 ${factorText(m.peakPrice)}）`
          : factorText(m.priceFactor));
      // 付费档把倍率写进显示名，用户在下拉里一眼看出哪个在烧积分；
      // ultimate 再��一句实测结论，别让人以为是本机配错了。
      labels[m.key] = [base, tier, cost, m.flaky ? "Qoder 侧偶发失败" : ""].filter(Boolean).join(" · ");
    }
    labels.lite = "Qwen3.8-Flash · 免费档 · 免费";
    const ext = all.filter((m) => m.external);
    const paidN = ext.filter((m) => m.paid).length;
    const val = {
      ok: true,
      count: all.length,
      models: ext.map((m) => m.key),
      labels,
      all,
      freeCount: all.filter((m) => m.free).length,
      paidCount: paidN,
      note: `目录共 ${all.length} 个，其中 ${ext.length} 个可从本中转调用`
        + `（免费 ${ext.length - paidN} 个、付费 ${paidN} 个）；`
        + `其余仅限 Qoder 客户端内使用（走 Cosy 签名通道，外部无法调用）。`
        + `付费档按倍率扣积分，默认映射用免费档，不会自动烧积分。`,
    };
    qdCatalogCache = { key: st.mtimeMs, at: Date.now(), val };
    return val;
  } catch {
    return { ok: false };
  }
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
    if (!qdTokCache.token) {
      // v1.0.57：区分「补丁没装」与「Qoder 没开」——这是新电脑上最常见的两种失败，
      // 提示必须不同，否则用户会照着错的方向折腾。
      let patched = 0;
      try { patched = qpStatus().patchedCount; } catch { }
      if (!patched) {
        throw new Error("未找到 Qoder 令牌——本机的 Qoder worker 还没打补丁。"
          + "请打开上方「令牌从哪来」卡片，点「一键装补丁」自动完成（无需装 Python）。");
      }
      throw new Error("未找到 Qoder 令牌——补丁已装，请启动 Qoder 桌面端并保持运行"
        + "（令牌会随 Qoder 启动写入 " + file + "）");
    }
  }
  if (!qdTokCache.token) throw new Error("Qoder 令牌文件为空——请启动 Qoder 桌面端后重试");
  return qdTokCache.token;
}

// qdPatchInfo：把补丁状态压成面板要用的几个字段（每次 /api/status 都会调，代价是
// 扫描几个 worker 副本读文件头——最多几 MB，可忽略；但加 3 秒缓存，避免状态轮询过密）。
let qdPatchCache = { at: 0, val: null };
function qdPatchInfo() {
  if (qdPatchCache.val && Date.now() - qdPatchCache.at < 3000) return qdPatchCache.val;
  let val;
  try {
    const s = qpStatus();
    val = {
      found: s.found,
      patched: s.patchedCount,
      ready: s.found > 0 && s.patchedCount > 0,
      tokenFresh: s.tokenFresh,
      tokenAt: s.tokenAt,
      cn: s.cn,
    };
  } catch {
    val = { found: 0, patched: 0, ready: false, tokenFresh: false, tokenAt: null, cn: 0 };
  }
  qdPatchCache = { at: Date.now(), val };
  return val;
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
  push(path.join(userLocal, "Programs", "CodeBuddy")); // v1.0.59 国内版常见：%LOCALAPPDATA%\Programs\CodeBuddy
  push(path.join(userLocal, "WorkBuddyAI"));
  // ② Program Files 系。v1.0.59 补国内版常见安装位：纯 `WorkBuddy`、`CodeBuddy`
  //    （国内版 workbuddy-desktop / CodeBuddyExtension 系常落在这两个名字下）。
  //    本机真实教训：注册表 InstallLocation 可以是空的——此时全靠候选目录，
  //    漏一个位置就直接「未找到 WorkBuddy 程序」，所以宁多勿漏。
  for (const k of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    if (process.env[k]) {
      for (const n of ["WorkBuddyAI", "WorkBuddy AI", "WorkBuddy", "CodeBuddy"]) push(path.join(process.env[k], n));
    }
  }
  // ③ 所有盘符（含 D:/E:/F:…）：\Users\<用户>\AppData\Local\Programs\WorkBuddyAI 及 \Program Files\WorkBuddyAI
  //    安装程序把 LOCALAPPDATA 重定向到别的盘时，实际路径就落在这些位置
  const user = process.env.USERNAME || "";
  const drives = [];
  for (let c = 67; c <= 90; c++) drives.push(String.fromCharCode(c) + ":"); // C: ~ Z:
  for (const d of drives) {
    if (user) {
      push(path.join(d, "Users", user, "AppData", "Local", "Programs", "WorkBuddyAI"));
      push(path.join(d, "Users", user, "AppData", "Local", "Programs", "CodeBuddy"));
    }
    push(path.join(d, "Program Files", "WorkBuddyAI"));
    push(path.join(d, "Program Files", "WorkBuddy"));
    push(path.join(d, "Program Files", "CodeBuddy"));
  }
  return out;
}
const WB_CAPTURE_HOOK = `
// === BAI-CAPTURE-HOOK (temporary, auto-removed) ===
try {
  const __fs = require("fs");
  const __out = __path_capture;
  const __grab = (txt) => { try { __fs.appendFileSync(__out, String(txt) + String.fromCharCode(10)); } catch (e) {} };
  // v1.0.58 根因修复：原来要求 Authorization 与 X-Refresh-Token「同时出现」才记录，
  // 但实测普通业务请求只带 Authorization；X-Refresh-Token 只在令牌续期
  // （/v2/auth/token/refresh、/account/switch）时才出现，而续期只在令牌过期时才发。
  // 于是「令牌没过期时点一键获取」永远等不到同时带两个头的请求，必然干等超时（两分半）。
  // 现在：只要拿到合法 Bearer（含点，像 JWT）就记录；刷新令牌有则一并带上、没有就留空。
  const __pick = (h) => {
    try {
      /* 取头。要同时吃下三种形态（实测漏抓过，故逐一覆盖）：
         ① 普通对象 {Authorization:"…"}：大小写都可能，故三种拼写都试
         ② Headers 实例（fetch(url,{headers:new Headers(…)})）——它不是普通对象，
            h[k] 恒为 undefined，必须走 .get()
         ③ 数组形式 [["Authorization","…"]]（较少见，Headers 构造器与 fetch 都接受）
         原先只做 ①，于是「调用方传 Headers 实例」或「头名全小写」时会静默漏抓——
         用户看到的就是「一键获取令牌一直转圈到超时」。 */
      const g = (k) => {
        const K = String(k);
        try {
          if (h && typeof h.get === "function") {          // Headers 实例
            const v = h.get(K) || h.get(K.toLowerCase()) || h.get(K.toUpperCase());
            if (typeof v === "string" && v) return v;
          }
          if (Array.isArray(h)) {                           // [[k,v],…]
            for (const e of h) {
              if (!Array.isArray(e)) continue;
              if (String(e[0]).toLowerCase() === K.toLowerCase()) return String(e[1] == null ? "" : e[1]);
            }
            return "";
          }
          const v = h && (h[K] || h[K.toLowerCase()] || h[K.toUpperCase()]);
          return typeof v === "string" ? v : "";
        } catch (e) { return ""; }
      };
      // 注意：这里是模板字面量，正则里的 "\\s" 会被转义掉、变成"字面反斜杠+s"，永远匹配不上空格。
      // 实测踩过这个坑：钩子抓到的 accessToken 会带上 "Bearer " 前缀，写进 config 后中转就会
      // 拼出 "Bearer Bearer xxx"。所以这里不用正则，改用字符串切分，避开模板转义陷阱。
      let tok = (g("authorization") || g("Authorization")).trim();
      const sp = tok.indexOf(" ");
      if (sp > 0 && tok.slice(0, sp).toLowerCase() === "bearer") tok = tok.slice(sp + 1).trim();
      const ref = g("x-refresh-token") || g("X-Refresh-Token");
      const dev = g("x-device-token") || g("X-Device-Token");
      const uid = g("x-user-id") || g("X-User-Id");
      if (!tok || tok.indexOf(".") <= 0) return;
      // 只在「拿到了上一次没有的东西」时才落盘，避免每个请求都追加、文件暴涨。
      const __key = tok + "|" + (ref || "");
      if (__key === globalThis.__BAI_LAST_GRAB) return;
      globalThis.__BAI_LAST_GRAB = __key;
      __grab(JSON.stringify({ accessToken: tok, refreshToken: ref, deviceToken: dev, userId: uid }));
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

// ---------- 备份落盘 + 异常退出自愈（v1.0.58 附带修复） ----------
// 隐患：捕获中途中转被 taskkill /F → finally 里的还原不跑 → 用户的 WorkBuddy CLI
// 脚本永久卡在打补丁状态，而备份只在内存 wbCapState.backup 里，进程死了就没了
// （真实发生过，逆回原状花了 5 次尝试）。原文件基准：11407 字节，md5 d3d1378b8efccc9dba2af9061cb3508d。
// 修法：注入前把干净备份**写到磁盘临时文件**；下次启动发现脚本还带钩子就用它还原。
const WB_BACKUP_FILE = path.join(os.tmpdir(), "bai-router-wb-codebuddy.bak.json");
function wbMd5(s) { return createHash("md5").update(Buffer.from(String(s), "utf8")).digest("hex"); }
function wbCaptureSelfHeal() {
  try {
    if (!existsSync(WB_BACKUP_FILE)) return;
    const meta = JSON.parse(readFileSync(WB_BACKUP_FILE, "utf8"));
    if (!meta || typeof meta.script !== "string" || typeof meta.content !== "string") {
      rmSync(WB_BACKUP_FILE, { force: true }); return;
    }
    if (existsSync(meta.script)) {
      const cur = readFileSync(meta.script, "utf8");
      if (cur.includes("BAI-CAPTURE-HOOK")) {
        writeFileSync(meta.script, meta.content, "utf8");
        log(`WorkBuddy 令牌捕获：上次捕获异常退出，检测到脚本仍带钩子，已从磁盘备份自愈还原：${meta.script}`);
      }
    }
    rmSync(WB_BACKUP_FILE, { force: true });
  } catch (e) { log("WorkBuddy 令牌捕获：启动自愈检查失败 " + e.message); }
}

// ---------- 注入后踢「常驻会话通道」（v1.0.58 主任务） ----------
// 根因：WorkBuddy 聊天出网走的是 sidecar 管的一个**长寿** CLI 进程
// （sessionId 前缀 __workbuddy_cli_host__，即 codebuddy --serve 的 host runtime）。
// 它启动时把 cli/bin/codebuddy 读进内存就不再重读——注入钩子后，只要它还活着，
// 钩子永远不会被加载，捕获必然干等 150 秒超时（用户实测现象）。
// 处置：注入之后，通过 sidecar 控制命名管道发 session.kill，**只杀这个常驻会话**
// （用户开的终端 PTY 是 sidecar 的其他 session，不动；更绝不碰 WorkBuddyAI.exe 主进程）。
// 主进程下次 getHostEndpoint 探测到端点没了会自动重建 → 新 CLI 进程读到带钩子的脚本。
//
// 踢的时机判断（契约要求说明）：**只要捕获在跑就踢，不做「有活跃会话就不踢」的条件**——
// 常驻会话在 WorkBuddy 打开期间永远存在（它本身就是 session），按「有会话就跳过」
// 等于永不生效、修复变死代码；而用户点「一键获取令牌」本来就是要动 WorkBuddy 的
// 维护动作，代价只是正在流式输出的那条回复被打断一次（对话历史在客户端，不丢）。
// 终端里跑着长任务的场景无法从这里体面地探测，故 phaseText 里如实告知已重启。
const WB_HOST_SESSION_PREFIX = "__workbuddy_cli_host__";
// 与 WorkBuddy 包内 process-cpu-sampler.js 的 sidecarRuntimeDir()/instanceToken() 同算法：
//   %TEMP%/<base>/<sha1(configDir).slice(0,12)>/sidecar.pid，Windows 下 base="wb"（无 uid）
function wbSidecarPidCandidates() {
  const out = [];
  const tmp = os.tmpdir();
  const cfgDir = (process.env.WORKBUDDY_CONFIG_DIR || "").trim()
    || (process.env.CODEBUDDY_CONFIG_DIR || "").trim()
    || path.join(os.homedir(), ".workbuddy");
  const token = createHash("sha1").update(cfgDir).digest("hex").slice(0, 12);
  out.push(path.join(tmp, "wb", token, "sidecar.pid"));
  return out;
}
async function wbSidecarPidFiles() {
  const out = [];
  const push = (p) => { if (p && !out.includes(p) && existsSync(p)) out.push(p); };
  for (const p of wbSidecarPidCandidates()) push(p);
  // 兜底扫描：WorkBuddy 进程的 WORKBUDDY_CONFIG_DIR 可能与本进程不同（算出的 token 对不上），
  // 直接扫 %TEMP%/wb*/ 下的 sidecar.pid。只认这个固定文件名，不碰别的。
  // 注意：精确路径可能留下**过期** PID 文件（进程已死），所以这里收集全部候选，
  // 由调用方按「进程还活着」挑，而不是见到第一个存在就用（否则会挡住扫描到的活侧车）。
  try {
    for (const name of readdirSync(os.tmpdir())) {
      if (!/^wb$|^wb-[0-9a-f]{4,}$/.test(name)) continue;
      const dir = path.join(os.tmpdir(), name);
      try {
        for (const sub of readdirSync(dir)) push(path.join(dir, sub, "sidecar.pid"));
      } catch { }
    }
  } catch { }
  return out;
}
// 控制管道 JSON-RPC：换行分隔的单条请求/响应（与 WorkBuddy 自带 requestRemoteShutdown 同款）
function wbSidecarRpc(pipePath, method, params, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipePath);
    let buf = "", settled = false;
    const timer = setTimeout(() => { settled = true; try { sock.destroy(); } catch { } reject(new Error(`sidecar RPC 超时: ${method}`)); }, timeoutMs);
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch { } reject(e); };
    sock.on("connect", () => {
      try { sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params === undefined ? undefined : params }) + "\n"); }
      catch (e) { fail(e); }
    });
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { sock.destroy(); } catch { }
      let msg; try { msg = JSON.parse(buf.slice(0, i)); } catch (e) { reject(e); return; }
      if (msg.error) reject(new Error(msg.error.message || "sidecar RPC 错误")); else resolve(msg.result);
    });
    sock.on("error", (e) => fail(new Error(`连接 sidecar 控制管道失败: ${e.message}`)));
    sock.on("close", () => fail(new Error("sidecar 控制管道连接被关闭")));
  });
}
// 返回 {action, detail, killed?, sessions?}：
//   killed       —— 已杀常驻会话（正常路径）
//   no_sidecar   —— WorkBuddy 后台没在跑（没 PID 文件 / 进程已死）
//   no_host      —— 后台在跑但没有常驻会话（下次发消息会自动新建，钩子届时就会加载）
//   pipe_fail    —— 管道连上了但 RPC 失败（**不杀任何进程**，如实报告）
//   sidecar_killed —— 管道连不上，兜底只杀 PID 文件里那个 sidecar 进程（绝不碰主进程）
async function wbKickHostSession() {
  // 在全部候选 PID 文件里挑第一个「进程确实活着」的——精确路径可能残留过期 PID 文件，
  // 见到存在就用会把扫描到的真正活侧车挡在后面（多实例/多 env 场景实测过这个坑）。
  const pidFiles = await wbSidecarPidFiles();
  let info = null, pidPath = null;
  for (const p of pidFiles) {
    let j = null;
    try { j = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    if (!j || !j.pid) continue;
    try {
      process.kill(j.pid, 0);
      info = j; pidPath = p; break;               // 活着
    } catch (e) {
      if (e && e.code === "ESRCH") continue;       // 过期残留 → 下一个候选
      info = j; pidPath = p; break;                // EPERM 等：进程在，只是不归本用户
    }
  }
  if (!info) {
    return {
      action: "no_sidecar",
      detail: pidFiles.length ? "WorkBuddy 后台（sidecar）PID 文件均为过期残留（进程已不在）" : "WorkBuddy 后台（sidecar）未在运行",
    };
  }
  // instanceToken 从 PID 文件所在目录名取，和 WorkBuddy 自己拼管道名的方式一致
  const inst = path.basename(path.dirname(pidPath));
  const uuid = typeof info.controlPipeUuid === "string" && info.controlPipeUuid ? info.controlPipeUuid : "";
  const pipePath = `\\\\.\\pipe\\workbuddy-${inst}-sidecar-control${uuid ? "-" + uuid : ""}`;
  try {
    const list = await wbSidecarRpc(pipePath, "session.list", null, 3000);
    const arr = Array.isArray(list) ? list : [];
    const hosts = arr.filter((s) => s && (s.sessionId === WB_HOST_SESSION_PREFIX || String(s.sessionId).startsWith(WB_HOST_SESSION_PREFIX + "-")));
    if (!hosts.length) {
      return { action: "no_host", detail: `WorkBuddy 后台在运行，但没有常驻会话通道（共 ${arr.length} 个会话）。直接发一条消息即可，无需重启`, sessions: arr.length };
    }
    let killed = 0, lastErr = "";
    for (const h of hosts) {
      try { await wbSidecarRpc(pipePath, "session.kill", { sessionId: h.sessionId }, 3000); killed++; }
      catch (e) { lastErr = e.message; }
    }
    if (killed > 0) {
      return { action: "killed", killed, sessions: arr.length, detail: `已重启 WorkBuddy 的常驻会话通道（${killed}/${hosts.length} 个旧 CLI 进程已终止，其余 ${arr.length - hosts.length} 个用户会话未动）。请在 WorkBuddy 里新建一个对话或发一条消息` };
    }
    return { action: "pipe_fail", detail: `常驻会话终止失败：${lastErr || "未知错误"}（未杀任何进程）`, sessions: arr.length };
  } catch (e) {
    // 管道连不上/超时：兜底只杀 sidecar 进程本身（PID 来自它自己的文件，且只杀这一个 PID）。
    // 主进程下次用到时会重建 sidecar → 重建常驻会话 → 新进程读到钩子。
    try {
      process.kill(info.pid);
      return { action: "sidecar_killed", detail: `控制管道无响应（${e.message}），已直接终止 sidecar 进程 ${info.pid}（仅此一个 PID；下次发消息时 WorkBuddy 会自动重建）` };
    } catch (e2) {
      return { action: "pipe_fail", detail: `无法触达 sidecar：${e.message}；终止也失败：${e2.message}（未杀任何进程）` };
    }
  }
}

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
  if (!script) throw new Error("未找到 WorkBuddy 程序（请确认本机已安装国内版 WorkBuddy 或国际版 WorkBuddy AI 客户端）");
  const outFile = path.join(DATA_DIR, "wb-captured-token.json");
  await fsPromises.rm(outFile, { force: true }).catch(() => { });
  const original = await fsPromises.readFile(script, "utf8");
  if (original.includes("BAI-CAPTURE-HOOK")) {
    // 上次异常残留：先清掉钩子再重来
    await fsPromises.writeFile(script, original.replace(/[\s\S]*?BAI-CAPTURE-HOOK[\s\S]*?\/BAI-CAPTURE-HOOK ===[\r\n]*/, ""), "utf8");
  }
  const backup = await fsPromises.readFile(script, "utf8");
  // 备份落盘（v1.0.58）：内存备份会随进程被强杀而消失，磁盘备份留给下次启动自愈还原
  try {
    writeFileSync(WB_BACKUP_FILE, JSON.stringify({
      script, md5: wbMd5(backup), savedAt: new Date().toISOString(), content: backup,
    }), "utf8");
  } catch (e) { log("WorkBuddy 令牌捕获：磁盘备份写入失败（本次内存备份仍有效）：" + e.message); }
  const hook = WB_CAPTURE_HOOK.replace("__path_capture", JSON.stringify(outFile));
  // 注入到 shebang 之后（保留首行 #!，Node 才能正常执行）
  const lines = backup.split("\n");
  const patched = lines[0] + "\n" + hook + "\n" + lines.slice(1).join("\n");
  wbCapState = {
    active: true, startedAt: Date.now(), error: null, script, backup, wrote: false, got: "",
    phase: "injecting", phaseText: "正在注入临时钩子…", kick: null,
  };
  await fsPromises.writeFile(script, patched, "utf8");
  wbCapState.wrote = true;
  wbCapState.phase = "injected";
  wbCapState.phaseText = "钩子已注入，正在重启 WorkBuddy 的常驻会话通道…";
  log(`WorkBuddy 令牌捕获：已注入临时钩子（${script}），等待客户端触发…`);
  // 踢侧车必须在注入**之后**：被重启拉起的新 CLI 进程才会读到带钩子的脚本
  try {
    const k = await wbKickHostSession();
    wbCapState.kick = k;
    wbCapState.phase = "waiting";
    wbCapState.phaseText = `${k.detail}。之后带鉴权的请求一出现就会被自动抓取（最长等 ${Math.round(timeoutMs / 1000)} 秒）`;
    log(`WorkBuddy 令牌捕获：踢侧车 → ${k.action}：${k.detail}`);
  } catch (e) {
    wbCapState.kick = { action: "error", detail: String(e.message || e) };
    wbCapState.phase = "waiting";
    wbCapState.phaseText = `后台重启未执行（${e.message}）。若 WorkBuddy 已开着，钩子要等它的进程下次重启才会被加载`;
    log("WorkBuddy 令牌捕获：踢侧车异常 " + e.message);
  }
  const deadline = Date.now() + timeoutMs;
  // 已捕获到的最新一条（accessToken 可能已抓到、刷新令牌还没有）——用于给前端实时进度
  let seen = null;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const raw = (await fsPromises.readFile(outFile, "utf8")).trim().split("\n").filter(Boolean).pop();
        if (raw) {
          const obj = JSON.parse(raw);
          if (obj && obj.accessToken) {
            seen = obj;
            wbCapState.got = obj.accessToken;
            wbCapState.phase = "got";
            wbCapState.phaseText = "已捕获到访问令牌，正在写入配置…";
            // v1.0.58：不再要求 accessToken 与 refreshToken 同时存在。
            // 只要抓到合法访问令牌就可以落盘——它才是真正用来打上游的凭证（有效期约一年）。
            // 刷新令牌的兜底策略（见下），保证「只带 Authorization 的普通请求」也能一次成功。
            const cfg = loadCfg();
            cfg.wb.accessToken = obj.accessToken;
            // 刷新令牌：优先用本次抓到的；本次没有（大多数情况：普通业务请求只带 Authorization）
            // 就保留配置里已有的，避免把一条好用的刷新令牌覆盖成空。两者都没有则留空
            // （仍可正常用，只是令牌过期后无法自动续期，返回的 hasRefresh/hints 会如实说明）。
            if (obj.refreshToken) cfg.wb.refreshToken = obj.refreshToken;
            if (obj.deviceToken) cfg.wb.deviceToken = obj.deviceToken;
            if (obj.userId) cfg.wb.userId = obj.userId;
            saveCfg(cfg);
            const exp = wbTokenExp(obj.accessToken);
            const hasRefresh = !!cfg.wb.refreshToken;
            // 抓到即还原：不等超时，立刻让 WorkBuddy 的脚本恢复原状
            await wbCaptureRestore();
            log(`WorkBuddy 令牌捕获：成功（钩子已立即还原）${hasRefresh ? "" : "，未含刷新令牌（将沿用配置里已有的，若无则到期需重新获取）"}`);
            return {
              ok: true,
              masked: keyFp(obj.accessToken),
              hasRefresh,
              expiresAt: exp || null,
              hints: hasRefresh ? [] : ["本次请求未携带刷新令牌（它只在令牌续期时才随请求发出）。访问令牌有效期约一年，到期后需重新点「一键获取令牌」。"],
            };
          }
        }
      } catch { /* 文件还没生成/还没写完整，继续等 */ }
    }
    // 超时：如实说明卡在哪一步（按踢侧车的实际结果分类，别再只说「请发一条消息」——
    // 实测证明钩子没被加载时光发消息也没用，怎么等都是白等）。
    if (seen && seen.accessToken) {
      throw new Error("等待超时：已捕获到访问令牌，但未能写入配置。请重试「一键获取令牌」。");
    }
    const kact = (wbCapState.kick && wbCapState.kick.action) || "unknown";
    const secs = Math.round(timeoutMs / 1000);
    let hint;
    if (kact === "killed" || kact === "sidecar_killed") {
      hint = `已重启 WorkBuddy 后台（旧的常驻 CLI 进程已终止），但这 ${secs} 秒内没有任何进程发起带 Authorization 的请求。请确认 WorkBuddy 客户端已打开并登录，然后新建一个对话或发一条消息（重启后的进程会自动加载钩子），再重试。`;
    } else if (kact === "no_sidecar") {
      hint = "WorkBuddy 客户端似乎没有在运行。钩子已注入：启动 WorkBuddy 并登录后随便发一条消息即可被自动抓取，再重试。";
    } else if (kact === "no_host") {
      hint = "WorkBuddy 后台在运行但还没有常驻会话通道——直接在客户端里发一条消息（会自动新建带钩子的进程）；若已发过消息仍失败，请重试一次。";
    } else if (kact === "pipe_fail" || kact === "error") {
      hint = `WorkBuddy 后台重启失败（${(wbCapState.kick && wbCapState.kick.detail) || "未知原因"}），钩子可能尚未被任何进程加载。可关闭并重新打开 WorkBuddy 客户端后重试。`;
    } else {
      hint = "请确认 WorkBuddy 客户端已打开并已登录，然后在里面随便发一条消息或新建一个对话（客户端会拉起内部 CLI 并带上 Authorization 头），再点一次「一键获取令牌」。";
    }
    throw new Error(`等待超时（${secs} 秒）：未捕获到任何令牌。${hint}若仍失败，可展开下方「手动填写令牌」作为备用方式。`);
  } finally {
    await wbCaptureRestore();
    await fsPromises.rm(outFile, { force: true }).catch(() => { });
    // 磁盘备份：确认脚本已干净才删；还原失败就留着，下次启动 wbCaptureSelfHeal() 自愈
    try {
      if (existsSync(script) && !readFileSync(script, "utf8").includes("BAI-CAPTURE-HOOK")) {
        rmSync(WB_BACKUP_FILE, { force: true });
      } else if (existsSync(WB_BACKUP_FILE)) {
        log("WorkBuddy 令牌捕获：还原后脚本仍带钩子，保留磁盘备份等待下次启动自愈");
      }
    } catch { }
    wbCapState.active = false;
    wbCapState.got = "";
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
// 这段桥被 wb / zen / qd 三个提供方共用（makeRelay 的 openai:true），前缀不能写死
// WorkBuddy——否则 Zen/Qoder 的报错会顶着 "[WorkBuddy]" 出现在用户面前。
let wbErrPrefix = "WorkBuddy";
function setErrProvider(name) { wbErrPrefix = name; }
// 提供方 → 展示名（中转端口自己答错时用：全局 wbErrPrefix 是别的请求留下的，
// 不重设会把 [Qoder] 的错误挂上 [WorkBuddy] 之类的前缀）
const RELAY_LABELS = { bai: "B.AI", sn: "SenseNova", wb: "WorkBuddy", zen: "OpenCode Zen", qd: "Qoder", or: "OpenRouter" };
function relayLabel(p) { return RELAY_LABELS[p] || p; }
function wbAnthroError(res, status, msg) {
  if (res.headersSent || res.writableEnded) { try { res.end(); } catch { } return; }
  const s = Number(status) >= 400 && Number(status) < 600 ? Number(status) : 502;
  const typeMap = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 500: "api_error", 503: "overloaded_error", 529: "overloaded_error" };
  const type = typeMap[s] || (s >= 500 ? "api_error" : "invalid_request_error");
  res.writeHead(s, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ type: "error", error: { type, message: `[${wbErrPrefix}] ${String(msg).slice(0, 400)}` } }));
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

// 给 promise 加时限（用于「首事件闸门」）。超时方返回 timedOut:true，
// 故意不取消原 promise——它还挂在响应体上，由调用方负责丢弃。
function withDeadline(p, ms) {
  if (!(ms > 0)) return p.then((v) => ({ ...v, timedOut: false }));
  let t;
  return Promise.race([
    p.then((v) => ({ ...v, timedOut: false })),
    new Promise((r) => { t = setTimeout(() => r({ value: undefined, done: true, timedOut: true }), ms); }),
  ]).finally(() => clearTimeout(t));
}
// 丢掉上游响应体：fetch 来的 body 有 cancel()，directHttp 的 node 流只有 destroy()。
async function dropBody(r) {
  try { if (!r || !r.body) return; if (typeof r.body.cancel === "function") await r.body.cancel(); else r.body.destroy(); } catch { }
}

// OpenAI SSE → Anthropic SSE（clientStream=false 时聚合成单条 Anthropic JSON 响应）
async function wbPipe(r, res, { model, clientStream, inputJson, timeoutMs }) {
  const inTok = Math.max(1, Math.ceil(JSON.stringify(inputJson || {}).length / 4));
  const msgId = "msg_wb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const lines = sseLines(r.body)[Symbol.asyncIterator]();
  let firstVal = null;
  // ---- 首事件闸门（v1.0.56）----
  // 实测 Qoder model server 把后端故障塞进 **HTTP 200 的 SSE 里**：
  // `event: error` + {"code":"provider_error","message":"All backends failed"}。
  // 若照旧先 writeHead(200)+message_start 再读上游，故障转移看到的就是一个
  // 漂亮的 200 —— CaptureRes 立刻固化、判为成功，**永远不会转移**，用户只拿到一句
  // "All backends failed"。这里把「首个有意义的上游事件」提上来当闸门：读到这里
  // 才知道是正常流还是伪装成 200 的错误，头也就还没发出去，仍可整段丢弃换渠道。
  const first = timeoutMs > 0 ? await withDeadline(lines.next(), timeoutMs) : await lines.next();
  if (first.timedOut) {
    noteRelayError("wb", "timeout", `${wbErrPrefix} 上游 ${Math.round(timeoutMs / 1000)}s 内未发出首个响应块`);
    await dropBody(r);
    return wbAnthroError(res, 504, `${wbErrPrefix} 上游 ${Math.round(timeoutMs / 1000)} 秒内没有返回任何内容，已中断本次请求`);
  }
  if (!first.done) firstVal = first.value;
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

  let sseEvent = "";   // 上游 SSE 的 event: 名字（error 等错误就靠它带出来）
  // bail(msg, kind, status)：在**头还没发出去**时（首事件闸门之前）把错误交给调用方，
  // 由 attemptWithFailover 的影子 res 判定要不要转移——这正是 provider_error
  // （Qoder 后端全挂）能被故障转移兜住的关键。头一旦发出（流式已 message_start），
  // 就只剩把错误事件交给客户端这一条路（和之前一样）。
  const bail = (msg, kind, status) => {
    noteRelayError(wbErrPrefix === "WorkBuddy" ? "wb" : "wb", "upstream_sse_error", msg.slice(0, 180));
    if (!res.headersSent) {
      // 影子 res：只记状态码与正文，由 attemptWithFailover 决定转移还是落盘
      res.writeHead(status || 502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ type: "error", error: { type: kind || "api_error", message: `[${wbErrPrefix}] ${msg}` } }));
      return true;
    }
    if (clientStream) {
      emit("error", { type: "error", error: { type: kind || "api_error", message: `[${wbErrPrefix}] ${msg}` } });
      try { res.end(); } catch { }
      return true;
    }
    wbAnthroError(res, 502, msg);
    return true;
  };
  try {
    // 首行（闸门外取到的那条）先走一遍，之后交给迭代器续上
    const iter = firstVal == null ? lines : (async function* () { yield firstVal; for (;;) { const n = await lines.next(); if (n.done) return; yield n.value; } })();
    for await (const raw of iter) {
      const line = raw.trimEnd();
      if (!line) continue;
      if (line.startsWith(":")) { emit("ping", { type: "ping" }); continue; } // 心跳
      if (line.startsWith("event:")) { sseEvent = line.slice(6).trim(); continue; }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break;
      let d;
      try { d = JSON.parse(payload); } catch { continue; }
      // OpenAI 兼容网关常把错误塞进 200 的 SSE 里（实测 Qoder model server 对不支持的
      // 模型就是 `event: error` + {"code":"invalid_model_error"}，HTTP 仍是 200）。
      // 不识别的话下面的 `if (!ch) continue` 会把它当成"没有内容"，静默产出一个空回复——
      // 用户只看到模型不吭声，完全不知道是模型名不被支持。这里必须显式转成 Anthropic 错误。
      {
        const evName = String(sseEvent || "").toLowerCase();
        const errObj = d && d.error;
        const hasErr = evName === "error" || (errObj && typeof errObj === "object")
          || (d && typeof d.code === "string" && /error/i.test(d.code));
        if (hasErr) {
          const em = (errObj && typeof errObj === "object")
            ? (errObj.message || JSON.stringify(errObj))
            : (d.message || String(errObj || d.code || "上游返回错误"));
          const code = String((errObj && errObj.type) || d.code || "");
          const kind = /invalid_model|model.*not|not.*support/i.test(code + em) ? "invalid_request_error"
            : /auth|permission|forbidden/i.test(code + em) ? "permission_error"
            : /rate|quota|too_many/i.test(code + em) ? "rate_limit_error" : "api_error";
          // 状态码选择：invalid_request_error = 请求本身有问题（换渠道也一样错，**不转移**）；
          // permission_error 403 / rate_limit_error 429 都可以转移；
          // 其余（含 provider_error「All backends failed」这类**上游后端挂了**）
          // 一律给 502，让 shouldFailover 判为"该换一家"，而不是把用户卡死在这一家。
          const st = kind === "invalid_request_error" ? 400
            : kind === "permission_error" ? 403
            : kind === "rate_limit_error" ? 429 : 502;
          if (bail(String(em).slice(0, 300), kind, st)) { await dropBody(r); return; }
        }
        sseEvent = "";
      }
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

  // 流跑完了却一个内容块都没有（既没有文本/思考/工具调用，也没有报错事件）：
  // 实测 Qoder 后端全挂时就是这种"200 + 空流"。当成上游失败(502)，
  // 让故障转移去下一家，而不是给用户一个空回复。
  if (idx < 0 && !usage) {
    if (bail(`${wbErrPrefix} 上游返回了空流（没有任何内容，可能是该模型后端当前不可用）`, "api_error", 502)) return;
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
// 上游错误诊断体落盘：固定文件名覆盖写（只留最近一份），并做单份大小上限。
// 翻译后的请求体实测到过 1.3MB，不设上限会把数据目录写爆；超限时截断并注明原始长度。
const DUMP_MAX_BYTES = 2 * 1024 * 1024; // 2MB（契约建议值：单份上限，覆盖写所以总量有界）
function dumpUpstreamBody(name, text) {
  try {
    const buf = Buffer.from(String(text == null ? "" : text), "utf8");
    if (buf.length > DUMP_MAX_BYTES) {
      writeFileSync(path.join(DATA_DIR, name),
        Buffer.concat([buf.subarray(0, DUMP_MAX_BYTES),
          Buffer.from(`\n/* 已截断：原始 ${buf.length} 字节，仅保留前 ${DUMP_MAX_BYTES} 字节 */`, "utf8")]));
    } else {
      writeFileSync(path.join(DATA_DIR, name), buf);
    }
  } catch { }
}

/* ===================== OpenRouter 免费兜底区：两层轮换（v1.0.59） =====================
 * 实测证据：docs/evidence/openrouter-free-tier-2026-10-07.md。OpenRouter 的 429 有
 * **两种 limit_source，处理方式相反**（做错整个轮换就白做）：
 *   upstream_provider_shared_pool  模型级：该模型上游池子满   → **换模型**（同 key 下一个）
 *   openrouter_free_tier_daily     账号级：免费模型 50 次/天  → **换 key**（1→2→3→1）
 * 换遍模型仍不行 → 也换 key（契约：「换遍了都不行 / 或遇 daily → 换下一个 key」）；
 * 三把 key 全在冷却 → **如实失败**，文案带 X-RateLimit-Reset 的重置时间。
 *
 * 冷却复用 failover.mjs 的 failoverCooldown(..., {quota:true}) 语义（30 分钟长冷却，
 * 让入口也让位），但**不改 failover.mjs 的导出**；(key, model) 的轮换状态全在本段维护。
 * ===================================================================================== */
const OR_KEYS_MAX = 3;
const orState = {
  keyIdx: 0,              // 当前 key 在 cfg.or.keys 里的下标
  modelIdx: 0,            // 当前模型在免费目录里的下标
  keyCool: new Map(),     // keyIdx → epoch ms（该 key 每日额度冷却到期）
  modelCool: new Map(),   // modelId → epoch ms（该模型共享池冷却到期）
  lastLimitSource: null,  // 最近一次 429 的 limit_source（面板显示）
  lastResetAt: null,      // 最近一次 429 的 X-RateLimit-Reset（epoch ms）
  lastSwitch: null,       // {at, kind, ...} 最近一次轮换（面板显示）
};
const orKeys = (cfg) => (((cfg && cfg.or && cfg.or.keys) || DEFAULTS.or.keys).filter((k) => typeof k === "string" && k.trim()));
const orActiveKey = (cfg) => { const ks = orKeys(cfg); if (!ks.length) return ""; return ks[Math.min(orState.keyIdx, ks.length - 1)]; };
function orModelList(cfg) {
  const m = cfg && cfg.or && cfg.or.availableModels;
  return Array.isArray(m) && m.length ? m : [...DEFAULTS.or.availableModels];
}
const orCoolLeft = (map, id, now) => Math.max(0, (map.get(id) || 0) - now);
function orNextResetAt() {
  let t = orState.lastResetAt || 0;
  for (const v of orState.keyCool.values()) if (v > t) t = v;
  for (const v of orState.modelCool.values()) if (v > t) t = v;
  return t || null;
}

/* 解析 OpenRouter 的 429 响应体 → {limitSource, resetAt, message}，认不出返回 null。
 * limit_source 优先取 metadata.limit_source；缺失时只按 message 猜「每日额度」这一种，
 * 猜不出就如实返回 null —— 轮换方向错了比不轮换更糟。 */
function orParse429(txt, resHeaders) {
  let j = null;
  try { j = JSON.parse(String(txt || "")); } catch { j = null; }
  const md = (j && j.error && j.error.metadata) || {};
  const hdrs = md.headers || {};
  let reset = Number(hdrs["X-RateLimit-Reset"]
    || (resHeaders && typeof resHeaders.get === "function" ? resHeaders.get("x-ratelimit-reset") : 0) || 0);
  // X-RateLimit-Reset 是 **epoch 毫秒**（实测 1791331200000）；若上游给了秒级值则换算
  if (reset > 0 && reset < 1e12) reset *= 1000;
  const msg = String((j && j.error && j.error.message) || "");
  let src = String(md.limit_source || "");
  if (!/^(openrouter_free_tier_daily|upstream_provider_shared_pool)$/.test(src)) {
    if (/free-models-per-day|free[- ]models[- ]per[- ]day/i.test(msg)) src = "openrouter_free_tier_daily";
    else return null;   // 未知类型的 429：不轮换，走通用 429 分支如实返回
  }
  return { limitSource: src, resetAt: reset || null, message: msg.slice(0, 240) };
}

/* 两层轮换的决策：给定这次 429 的 limit_source，返回下一个该试的 (key, model)。
 * 返回 {ok:true, keyIdx, key, model} 或 {ok:false, reason, resetAt}（三把 key 全在冷却）。 */
function orAdvance(cfg, info) {
  const keys = orKeys(cfg);
  const models = orModelList(cfg);
  const now = Date.now();
  orState.lastLimitSource = info.limitSource;
  if (info.resetAt) orState.lastResetAt = info.resetAt;
  if (!keys.length) return { ok: false, reason: "no_key", resetAt: null };
  if (orState.keyIdx >= keys.length) orState.keyIdx = 0;

  if (info.limitSource === "upstream_provider_shared_pool") {
    // ① 模型级：冷却当前模型，挑同 key 下一个没冷却的免费模型
    const cur = models[orState.modelIdx] || "(未知)";
    orState.modelCool.set(cur, info.resetAt || now + 5 * 60000);
    for (let i = 1; i <= models.length; i++) {
      const j = (orState.modelIdx + i) % models.length;
      if (!orCoolLeft(orState.modelCool, models[j], now)) {
        orState.modelIdx = j;
        orState.lastSwitch = { at: new Date().toISOString(), kind: "model", from: cur, to: models[j], keyNo: orState.keyIdx + 1 };
        return { ok: true, keyIdx: orState.keyIdx, key: keys[orState.keyIdx], model: models[j] };
      }
    }
    // 免费模型全被占满 → 按契约换 key
    return orAdvanceKey(cfg, info, "免费模型已换遍，改换 key");
  }
  // ② 账号级每日额度：换模型没用，直接换 key
  return orAdvanceKey(cfg, info, "该 key 的每日免费额度已用尽");
}
function orAdvanceKey(cfg, info, why) {
  const keys = orKeys(cfg);
  const models = orModelList(cfg);
  const now = Date.now();
  if (!keys.length) return { ok: false, reason: "no_key", resetAt: null };
  if (orState.keyIdx >= keys.length) orState.keyIdx = 0;
  orState.keyCool.set(orState.keyIdx, info.resetAt || now + 60 * 60000);
  for (let i = 1; i <= keys.length; i++) {
    const j = (orState.keyIdx + i) % keys.length;
    if (!orCoolLeft(orState.keyCool, j, now)) {
      const from = orState.keyIdx;
      orState.keyIdx = j;
      orState.lastSwitch = { at: new Date().toISOString(), kind: "key", from: from + 1, to: j + 1, why, model: models[orState.modelIdx] || null };
      return { ok: true, keyIdx: j, key: keys[j], model: models[orState.modelIdx] || null };
    }
  }
  return { ok: false, reason: "all_keys_cooling", resetAt: orNextResetAt() };
}

/* 每次请求开始时挑当前候选：key 要避开每日冷却，模型在 wantModel（映射解析结果）
 * 被冷却时退到下一个没冷却的。返回 {ok:false} 表示三把 key 全在冷却 / 一个模型都不剩。 */
function orPick(cfg, wantModel) {
  const keys = orKeys(cfg);
  const models = orModelList(cfg);
  const now = Date.now();
  if (!keys.length) return { ok: false, reason: "no_key" };
  if (orState.keyIdx >= keys.length) orState.keyIdx = 0;
  if (orCoolLeft(orState.keyCool, orState.keyIdx, now)) {
    let found = -1;
    for (let i = 1; i <= keys.length; i++) {
      const j = (orState.keyIdx + i) % keys.length;
      if (!orCoolLeft(orState.keyCool, j, now)) { found = j; break; }
    }
    if (found < 0) return { ok: false, reason: "all_keys_cooling", resetAt: orNextResetAt() };
    orState.keyIdx = found;
  }
  let model = wantModel || null;
  if (model && orCoolLeft(orState.modelCool, model, now)) model = null;
  if (!model || !models.includes(model)) {
    let found = -1;
    const start = models.length ? orState.modelIdx % models.length : 0;
    for (let i = 0; i < models.length; i++) {
      const j = (start + i) % models.length;
      if (!orCoolLeft(orState.modelCool, models[j], now)) { found = j; break; }
    }
    // 一个都没冷却的模型都挑不出来 → 退回首选模型照打（模型冷却只是启发式，
    // 真打不通上游还会 429 再轮）；**只有 key 全冷却才判定为失败**（账号级是硬额度）。
    if (found >= 0) { orState.modelIdx = found; model = models[found]; }
    else model = wantModel || models[0] || null;
  } else {
    const at = models.indexOf(model);
    if (at >= 0) orState.modelIdx = at;
  }
  if (!model) return { ok: false, reason: "no_model" };
  return { ok: true, keyIdx: orState.keyIdx, key: keys[orState.keyIdx], model };
}

/* GET /api/v1/models 后按 pricing 全 0 筛免费模型（**不能只看 :free 后缀**）。
 * 音乐/图像类模型（output_modalities 不含 text）排除，免得下拉里出现点了必失败的项。 */
async function orFetchFreeModels(cfg) {
  const base = ((cfg && cfg.or && cfg.or.upstream) || DEFAULTS.or.upstream).replace(/\/+$/, "");
  const key = orActiveKey(cfg) || orKeys(cfg)[0] || "";
  const r = await fetch(base + "/models", {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15000),
  });
  const j = await readProbeJson(r);
  const all = Array.isArray(j.data) ? j.data : [];
  const free = all.filter((m) => {
    const pr = m && m.pricing;
    if (!pr) return false;
    // 实测取值是字符串 "0"；用 Number() 兼容 "0.000000" 之类的写法
    if (Number(pr.prompt) !== 0 || Number(pr.completion) !== 0) return false;
    const arch = (m && m.architecture) || {};
    // 模态字段已从顶层挪进 architecture.output_modalities：顶层恒为 undefined 时旧写法
    // `!Array.isArray(outs)` 永远为真，过滤器静默退化成空操作，音乐模型会混进下拉框。
    // 判据是「输出**只有** text」而不是「包含 text」——lyria-3 是 ["text","audio"]，
    // contains 会误放行；顶层与 architecture 都拿不到时再从 modality 串的箭头右侧兜底。
    const outs = Array.isArray(arch.output_modalities) ? arch.output_modalities : m.output_modalities;
    if (Array.isArray(outs)) return outs.length === 1 && outs[0] === "text";
    const out = String(arch.modality || "").split("->")[1] || "";
    return !out || out === "text";
  });
  const ids = [...new Set(free.map((m) => String(m.id || "").trim().toLowerCase()).filter(Boolean))];
  if (!ids.length) throw new Error("OpenRouter 目录里一个 pricing 全 0 的模型都没筛出来（上游结构可能变了）");
  return { ids, total: all.length };
}

// 带 HTTP 状态码的错误：只有「or 拉取失败」和「没填 key」两种是 400（用户自己能改），
// 其余一律不设 httpStatus，照旧往上抛给外层 catch 记栈回 500——与抽函数前行为一致。
function catalogError(msg, httpStatus) {
  const e = new Error(msg);
  e.httpStatus = httpStatus;
  return e;
}

// v1.0.60：把「拉某一家真实模型目录」从 /api/models 的内联分支里抽出来，供
// /api/models/scan-all 一并复用。归一化成 { ok, models, count, ... }。
// **models 是六家唯一共同契约**，批量 diff 一律只看它——count 对 zen/qd 是全目录长度
// 而非 models.length，直接拿来比会算出假差异。
// 六家的怪癖全封在这里，调用方不必再分叉：
//   or  —— 网络，按 pricing 全 0 筛免费；失败一律 400
//   qd  —— 同步读本地明文目录，读不到退回静态内置（带 static:true，永不报错）
//   wb  —— 没有目录接口，就是把当前配置回显（永远「无变化」）
//   zen —— 公开目录但只有 space-bunny-free 能外部调用；拉不到时静默返回过期缓存
//   sn  —— 走 directHttp 境内直连，只留能输出 text 的
//   bai —— fetch 打上游 /v1/models
async function fetchCatalogFor(p, cfg) {
  const S = sliceOf(cfg, p);

  if (p === "or") {
    // OpenRouter 公开目录（无需鉴权也能拉，带 key 更稳）：按 pricing 全 0 筛免费模型。
    // 判据是 pricing 而**不是 `:free` 后缀**——实测 inclusionai/ling-3.1-flash 没有后缀
    // 但 pricing 全 0。模态判据（剔除 lyria 音乐模型）见 orFetchFreeModels。
    try {
      const r = await orFetchFreeModels(cfg);
      return {
        ok: true, count: r.ids.length, models: r.ids, freeCount: r.ids.length,
        note: `OpenRouter 公开目录共 ${r.total} 个模型，按 pricing.prompt/completion 全为 0 筛出 ${r.ids.length} 个免费文本模型（:free 后缀不是判据）。`,
      };
    } catch (e) {
      throw catalogError("拉取 OpenRouter 免费模型目录失败：" + String((e && e.message) || e).slice(0, 160), 400);
    }
  }

  if (p === "qd") {
    // Qoder 的目录没有公开接口，但 worker 拉回后在本地解密再 parse——补丁把那份明文
    // 写到了 tokenFile 同级的 qoder-models.json，这里直接读，不必复刻 Cosy 签名。
    const r = qdReadCatalog(cfg);
    // 读不到目录也要如实标注价格：下拉里付费档不能看起来和免费档一样。
    return r.ok ? r : qdStaticCatalog(S);
  }

  if (p === "wb") {
    // WorkBuddy 没有公开的模型目录接口（模型清单随客户端 product config 下发），
    // 返回当前可选列表即可——三款免费模型由发布机默认随版本推送
    return { ok: true, count: S.availableModels.length, models: [...S.availableModels], static: true };
  }

  if (p === "zen") {
    // Zen 提供公开模型目录（无需鉴权），但只给 id、没有价格与免费标记。
    // 全部列出来并按实测结论标注可用性——让用户看得见"上游有什么、为什么用不了"，
    // 而不是下拉框里只有孤零零一个模型。不可用的**不进下拉**，免得选了必然报错。
    const cat = await zenReadCatalog();
    const all = cat.map((id) => ({
      key: id, name: id, free: id.includes("free"), external: ZEN_EXTERNAL_OK.has(id),
    }));
    const freeN = all.filter((m) => m.free).length;
    const okN = all.filter((m) => m.external).length;
    return {
      ok: true, count: all.length,
      models: all.filter((m) => m.external).map((m) => m.key),
      all, freeCount: freeN,
      note: cat.length
        ? `Zen 公开目录共 ${all.length} 个模型，其中 ${freeN} 个标 free；实测只有 ${okN} 个能从中转调用。`
          + `其余 -free 会被服务端拒为 FreeTierError（"can only be used from within OpenCode"，产品级限制，非本机可绕），付费模型则需 API Key 有余额。`
        : "未读到 Zen 公开目录（网络或上游暂时不可达），当前显示内置列表",
    };
  }

  // 走到这里的只有 sn 与 bai 两家——qd/wb/zen 在上面各自的分支里已经 return：
  // qd 读本地明文目录、wb 返回静态列表、zen 是无需鉴权的公开目录，三家都不吃 key。
  // 这两家要带 Bearer 打上游，key 为空时上游只会回一句 401/403（SenseNova 干脆是
  // 光秃秃的 "Forbidden"），原样透出去就成了天书——用户看不出是自己的 key 没填。
  // 所以空 key 一律**不去打上游**，直接说人话。400 而非 200：让前端的 api() 抛错，
  // 错误才能浮到按钮旁边的结果槽，而不是被当成"拉取成功、0 个模型"。
  if (!S.key) {
    throw catalogError(`尚未填写 ${S.zh} API Key，无法拉取模型目录——请先在路由卡填入并点「保存映射」`, 400);
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
    if (r.status >= 400) throw new Error(upstreamErrorText(j, 120) || `上游返回 HTTP ${r.status}，但没带错误说明`);
    // SenseNova 目录带 modalities：只把能输出文本的模型作为可路由目标
    const chat = (j.data || []).filter((m) => (m.output_modalities || ["text"]).includes("text"));
    const models = [...new Set(chat.map((m) => String(m.id || "").trim().toLowerCase()).filter(Boolean))].sort();
    return { ok: true, count: models.length, models };
  }

  const r = await fetch(S.upstream + "/v1/models", {
    headers: { authorization: `Bearer ${S.key}`, "anthropic-version": "2023-06-01" },
    signal: AbortSignal.timeout(15000),
  });
  j = await readProbeJson(r);
  if (!r.ok) throw new Error(upstreamErrorText(j, 120) || `上游返回 HTTP ${r.status}，但没带错误说明`);
  const models = [...new Set((j.data || []).map((m) => String(m.id || "").trim().toLowerCase()).filter(Boolean))].sort();
  return { ok: true, count: models.length, models };
}

/* GET /api/v1/auth/key 的额度真相：面板显示 free_model_daily_requests 剩余次数。
 * 结果按 key 指纹缓存 60 秒——面板 5 秒一轮询，不能每轮都打上游。 */
let orQuotaCache = { at: 0, fp: null, data: null };
async function orFetchQuota(cfg, force) {
  const key = orActiveKey(cfg);
  if (!key) return null;
  const fp = keyFp(key);
  const now = Date.now();
  if (!force && orQuotaCache.data && orQuotaCache.fp === fp && now - orQuotaCache.at < 60000) return orQuotaCache.data;
  const base = ((cfg && cfg.or && cfg.or.upstream) || DEFAULTS.or.upstream).replace(/\/+$/, "");
  try {
    // 走 fetch：useProxy=false 时 openrouter.ai 在 NO_PROXY 里（直连），=true 时代理出海，
    // 两种情况都由启动期的 NO_PROXY 决定，与中转的直连语义一致。
    const r = await fetch(base + "/auth/key", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(12000),
    });
    const txt = await readAllBody(r);
    if (r.status >= 400) throw new Error(`HTTP ${r.status} ${String(txt).slice(0, 120)}`);
    const j = JSON.parse(txt);
    const data = {
      isFreeTier: j.is_free_tier === true,
      usage: typeof j.usage === "number" ? j.usage : null,
      daily: (j.free_model_daily_requests && typeof j.free_model_daily_requests === "object") ? {
        used: j.free_model_daily_requests.used,
        limit: j.free_model_daily_requests.limit,
        remaining: j.free_model_daily_requests.remaining,
      } : null,
      at: new Date().toISOString(),
    };
    orQuotaCache = { at: now, fp, data };
    return data;
  } catch (e) {
    if (orQuotaCache.fp === fp && orQuotaCache.data) return { ...orQuotaCache.data, stale: true, error: String(e.message).slice(0, 120) };
    return { error: String((e && e.message) || e).slice(0, 160), at: new Date().toISOString() };
  }
}

/* 额度快照：给 /api/status 用——**不 await**，缓存过期时后台刷一份，本轮先回旧值。
 * 否则上游慢一次，整块状态面板（5 秒一轮询）就跟着卡 12 秒。 */
let orQuotaPending = null;
function orQuotaSnapshot(cfg) {
  const fresh = orQuotaCache.data && Date.now() - orQuotaCache.at < 60000;
  if (!fresh && !orQuotaPending) {
    orQuotaPending = orFetchQuota(cfg, false).finally(() => { orQuotaPending = null; });
  }
  return orQuotaCache.data || null;
}

/* 面板「OpenRouter 免费流水区」用的状态快照（只出指纹，绝不回显 key 明文）。 */async function orStatusPayload(cfg, opts) {
  const keys = orKeys(cfg);
  const models = orModelList(cfg);
  const now = Date.now();
  const quota = (opts && opts.quota === false) ? null : await orFetchQuota(cfg, !!(opts && opts.refresh));
  return {
    keyCount: keys.length,
    keys: keys.map((k, i) => ({
      no: i + 1,
      fp: keyFp(k),
      active: i === Math.min(orState.keyIdx, Math.max(0, keys.length - 1)),
      coolingUntil: orCoolLeft(orState.keyCool, i, now) ? new Date((orState.keyCool.get(i) || 0)).toISOString() : null,
    })),
    activeKeyNo: keys.length ? Math.min(orState.keyIdx, keys.length - 1) + 1 : null,
    activeModel: models[Math.min(orState.modelIdx, Math.max(0, models.length - 1))] || null,
    modelCount: models.length,
    models: models,
    cooledModels: [...orState.modelCool.entries()]
      .filter(([, t]) => t > now).map(([m, t]) => ({ model: m, until: new Date(t).toISOString() })),
    limitSource: orState.lastLimitSource,
    lastResetAt: orState.lastResetAt ? new Date(orState.lastResetAt).toISOString() : null,
    resetCountdownMs: Math.max(0, (orNextResetAt() || 0) - now),
    lastSwitch: orState.lastSwitch,
    quota,
  };
}

async function openaiExchange(p, { cfg, S, j, isProbe, res, useProxy }) {
  const NAME = p === "zen" ? "OpenCode Zen" : p === "qd" ? "Qoder" : p === "or" ? "OpenRouter" : "WorkBuddy";
  setErrProvider(NAME);
  let token;
  if (p === "zen") {
    token = (cfg.zen && cfg.zen.apiKey) || "";
    if (!token) { noteRelayError(p, "auth", "未配置 OpenCode Zen API Key"); return wbAnthroError(res, 401, "未配置 OpenCode Zen API Key——请到「OpenCode Zen」页填写"); }
  } else if (p === "or") {
    // 凭据是轮换区：当前候选 key 由 orPick() 定（见下面的两层轮换）
    token = orActiveKey(cfg);
    if (!token) { noteRelayError(p, "auth", "未配置 OpenRouter API Key"); return wbAnthroError(res, 401, "未配置 OpenRouter API Key——请到「OpenRouter」页的「免费流水区」填 sk-or-v1 密钥（最多 3 把）"); }
  } else if (p === "qd") {
    try { token = qdEnsureToken(cfg); }
    catch (e) { noteRelayError(p, "auth", e.message); return wbAnthroError(res, 401, e.message); }
  } else {
    try { token = await wbEnsureToken(cfg); }
    catch (e) { noteRelayError(p, "auth", e.message); return wbAnthroError(res, 401, e.message); }
  }

  const ob = wbToOpenAI(j);
  const base = (S.upstream || (p === "zen" ? DEFAULTS.zen.upstream : p === "qd" ? DEFAULTS.qd.upstream : p === "or" ? DEFAULTS.or.upstream : DEFAULTS.wb.upstream)).replace(/\/+$/, "");
  const url = p === "wb" ? base + "/v2/chat/completions" : base + "/chat/completions";
  const mkHeaders = (tok) => {
    if (p === "zen") {
      return {
        "content-type": "application/json",
        authorization: `Bearer ${tok}`,
        "user-agent": `B.AI-Router/${APP_VERSION}`,
      };
    }
    if (p === "or") {
      // OpenRouter：标准 Bearer + SSE。HTTP-Referer/X-Title 只是统计用，可省。
      return {
        "content-type": "application/json",
        accept: "text/event-stream",
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
  let bodyStr = JSON.stringify(ob);   // OpenRouter 轮换会改写 model，故为 let
  const doCall = (tok) => useProxy
    ? fetch(url, { method: "POST", headers: mkHeaders(tok), body: bodyStr, signal: AbortSignal.timeout(isProbe ? 10000 : 30000) })
    : directHttp(url, { method: "POST", headers: mkHeaders(tok), body: bodyStr, timeoutMs: isProbe ? 10000 : 30000 });

  let r;
  // 声明必须在 try 之外：下面 try/catch 之后（r.status !== 200 分支）还要用它们，
  // 放进 try 里就成了块级作用域，那边引用不到（报 "is not defined"）。
  let consumed400 = "";
  let consumedBodyHint = "";
  let orStop = false;      // OpenRouter：两层轮换已判定「三把 key 全在冷却」→ 不许再重试

  try {
    // ---- OpenRouter（v1.0.59）：先挑当前候选 (key, model)，再打第一个请求 ----
    if (p === "or") {
      const pick = orPick(cfg, ob.model);
      if (!pick.ok) {
        const resetAt = orNextResetAt();
        const when = resetAt ? new Date(resetAt).toLocaleString("zh-CN", { hour12: false }) : "（未取得重置时间）";
        const msg = pick.reason === "no_key"
          ? "未配置 OpenRouter API Key——请到「OpenRouter」页的「免费流水区」填 sk-or-v1 密钥（最多 3 把）"
          : `${orKeys(cfg).length} 个 key 的每日免费额度都用完了（limit_source=openrouter_free_tier_daily），X-RateLimit-Reset 是 ${when}（epoch 毫秒），到点后自动轮回来，无需手动操作`;
        noteRelayError(p, "rate_limit_quota", msg);
        failoverCooldown(p, msg, { quota: true });   // 额度冷却语义：让入口也让位（failover.mjs 有闸）
        return wbAnthroError(res, 429, msg);
      }
      token = pick.key;
      if (pick.model && pick.model !== ob.model) { ob.model = pick.model; bodyStr = JSON.stringify(ob); }
    }
    r = await doCall(token);
    // ---- OpenRouter 两层轮换：429 分流后立刻换 (key, model) 重试 ----
    // 换模型（upstream_provider_shared_pool）/ 换 key（openrouter_free_tier_daily）由 orAdvance 决策；
    // 认不出 limit_source 的 429 直接 break，交通用分支如实返回（轮换方向错了比不轮换更糟）。
    if (p === "or") {
      const cap = Math.min(10, orModelList(cfg).length + orKeys(cfg).length + 2);
      for (let step = 0; step < cap && r.status === 429; step++) {
        const peek = await readAllBody(r).catch(() => "");
        consumedBodyHint = peek;
        const info = orParse429(peek, r.headers);
        if (!info) { orStop = true; break; }
        const next = orAdvance(cfg, info);
        if (!next.ok) { orStop = true; break; }
        token = next.key;
        if (next.model) { ob.model = next.model; bodyStr = JSON.stringify(ob); }
        log(`OpenRouter 429 两层轮换（limit_source=${info.limitSource}）→ key#${next.keyIdx + 1} / ${ob.model}`);
        r = await doCall(token);
      }
    }
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
    // OpenRouter 已在上面的两层轮换里重试过（orStop=额度耗尽/429 认不出），这里不再白打上游——
    // 每天只有 50 次免费额度，退避重试等于拿额度换一次多余的往返。
    for (let a = 0; r.status === 429 && isProbe && !orStop && a < 3; a++) {
      const peek = await readAllBody(r).catch(() => "");
      // FreeUsageLimitError = 免费额度用尽，是**持续性**的：退避再多次也还是 429，
      // 白打三次上游还把探测拖慢 2 秒。记下响应体直接跳出（下面归因要读它）。
      if (peek.includes("FreeUsageLimitError")) { consumedBodyHint = peek; break; }
      await new Promise((rr) => setTimeout(rr, 400 * (a + 1)));
      r = await doCall(token);
    }
    // Zen 限流很凶，且用 500 "Internal server error" 表达而不是 429——实测连发 11 个请求
    // 全部被顶掉，间隔 7s 不够、需 25s 以上。探测时退避重试一次，别让「测试连通」假失败。
    if (p === "zen" && r.status === 500 && isProbe) {
      const peek = await readAllBody(r).catch(() => "");
      if (/internal server error/i.test(peek)) {
        await new Promise((rr) => setTimeout(rr, 3000));
        r = await doCall(token);
      } else {
        consumedBodyHint = peek;
      }
    }
    // "unapproved channel" 偶发抖动：重试一次（确定性指纹已由 wbSanitizeSystem 剥除）。
    // 注意 400 响应体已被读走，若最终仍是错误，错误文案从 consumed400 兜底。
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
    const txt = (await readAllBody(r).catch(() => "")) || consumed400 || consumedBodyHint;
    // 只把翻译后的这句话给用户；下面的 Zen 归因仍按原始 txt 匹配，不受影响
    const msg = upstreamBodyText(txt, 200);

    // 归因：Zen 的几种典型拒绝各有明确含义，直接翻译成人话，别让用户对着裸错误码猜。
    let why = "";
    if (p === "zen") {
      // v1.0.58-T0：500 拆出**独立分支**（原先 500 和 429 挤在同一个外层 if，
      // 上游自己 500 会落到 429 的「限流、等 30 秒」文案上，误导用户白等）。
      if (r.status === 500) {
        why = " —— OpenCode Zen 上游自身故障（HTTP 500，典型响应体 internal server error）：不是你的配置问题，也不是限流，等 30 秒再试通常没有用。故障转移会自动改走其他渠道；持续出现时稍后再试或查看 Zen 服务状态。";
        noteRelayError(p, "upstream_500", `${NAME} 上游自身故障（HTTP 500 internal server error）`);
        // 冷却策略：500 是上游**瞬时**故障，走 attemptWithFailover 默认的 90 秒短冷却、
        // 保持 quota:false——下次请求很可能就好了。30 分钟长冷却是给「额度用尽」
        // （FreeUsageLimitError，等多久都没用）那类持续性失败留的，500 不该占用；
        // 也正因如此这里**不**调 failoverCooldown，让它走通用路径。
      } else if (r.status === 429) {
        // 同样是 429，两种含义完全相反，必须按上游错误体的 error.type 分开（v1.0.58）：
        //   FreeUsageLimitError = 这个 key 的免费额度用完了，**持续性**，等多久都不会恢复；
        //   没有该 type         = 真·瞬时限流（连发几次探测被顶掉），等 30 秒会好。
        // 实测真实响应体：{"type":"error","error":{"type":"FreeUsageLimitError", …}}
        if (/FreeUsageLimitError/.test(txt)) {
          why = " —— 这个 API Key 的 OpenCode Zen 免费额度已用尽（上游返回 FreeUsageLimitError），不是瞬时限流：等多久都不会恢复，官方也未公布重置时间。可换/重置 API Key；或开启自动故障转移，让请求改走 Qoder / B.AI 等其他渠道。";
          noteRelayError(p, "rate_limit_quota", `${NAME} 免费额度已用尽（FreeUsageLimitError）`);
          // 额度用尽走长冷却（30 分钟），并让**入口提供方也让位**——见 attemptWithFailover。
          failoverCooldown(p, `${NAME} 免费额度已用尽（FreeUsageLimitError）`, { quota: true });
        } else {
          why = " —— OpenCode Zen 限流很严（连发几次探测就会被顶掉）。等 30 秒左右再试，或只测当前档位别勾「测全部四档」。";
          noteRelayError(p, "rate_limit", `${NAME} 触发上游限流`);
        }
      } else if (r.status === 403 && /FreeTierError|only be used from within/i.test(txt)) {
        why = " —— 这是 Zen 的免费档，官方限定只能在 OpenCode 客户端内用（服务端返回 FreeTierError），外部无法调用。换 space-bunny-free，或用付费额度。";
        noteRelayError(p, "upstream_403", `${NAME} 免费档限客户端内使用`);
      } else if (r.status === 402 || /insufficient account funds/i.test(txt)) {
        why = " —— API Key 余额为 0，付费模型需要先充值；免费档里只有 space-bunny-free 能外部调用。";
        noteRelayError(p, "upstream_402", `${NAME} 余额不足`);
      } else if (r.status === 400 && /Model is unavailable/i.test(txt)) {
        why = " —— 该模型后端当前不可用（Zen 侧临时下线或未对免费档开放）。";
        noteRelayError(p, "upstream_400", `${NAME} 模型不可用`);
      } else if (r.status === 403 && /Model access is disabled/i.test(txt)) {
        why = " —— 该模型未对你的 Key 开放。";
        noteRelayError(p, "upstream_403", `${NAME} 模型未授权`);
      } else {
        noteRelayError(p, r.status === 429 ? "rate_limit" : `upstream_${r.status}`, `${NAME} 上游 HTTP ${r.status}`);
      }
    } else if (p === "or") {
      // OpenRouter：429 的两种 limit_source 已在上面的轮换里分流处理过，走到这里说明
      // 「换遍了仍被拒」或「三把 key 全在每日冷却」——如实把轮换过程与重置时间摊开，
      // 不要只丢一句 429 让用户以为是自己配错了。
      if (r.status === 429) {
        const resetAt = orNextResetAt();
        const when = resetAt ? new Date(resetAt).toLocaleString("zh-CN", { hour12: false }) : "上游未给出重置时间";
        const src = orState.lastLimitSource || "(未识别)";
        const sw = orState.lastSwitch;
        const swTxt = sw
          ? (sw.kind === "key" ? `第 ${sw.from} 把 key → 第 ${sw.to} 把 key` : `模型 ${sw.from} → ${sw.to}`)
          : "无";
        why = ` —— OpenRouter 免费区两层轮换已跑完仍被限流（limit_source=${src}，最近一次轮换：${swTxt}）。X-RateLimit-Reset 是 ${when}（到点自动轮回来）；想提额可在面板再填一把 key 分摊每日 50 次，或充 10 美元把每日额度提到 1000 次。`;
        noteRelayError(p, "rate_limit_quota", `OpenRouter 免费额度用尽（limit_source=${src}）`);
        failoverCooldown(p, `OpenRouter 免费额度用尽（${src}）`, { quota: true });
      } else {
        noteRelayError(p, `upstream_${r.status}`, `${NAME} 上游 HTTP ${r.status}`);
      }
    } else {
      noteRelayError(p, r.status === 429 ? "rate_limit" : `upstream_${r.status}`, `${NAME} 上游 HTTP ${r.status}`);
    }
    // 关键上下文（4xx/5xx 共用）：Qoder 的 500 只看 system 首行根本不够——必须带上
    // model / max_tokens / stream / messages 条数，下次一眼能看出是不是翻译层写错了参数。
    const ctx = `model=${ob && ob.model != null ? ob.model : "-"} max_tokens=${ob && ob.max_tokens != null ? ob.max_tokens : "-"} stream=${ob && ob.stream != null ? ob.stream : "-"} messages=${ob && Array.isArray(ob.messages) ? ob.messages.length : 0}｜system 首行：${String((ob.messages && ob.messages[0] && ob.messages[0].content) || "").split("\n")[0].slice(0, 120)}`;
    // 4xx 诊断：把被拒的翻译后请求体落一份，便于定位上游新增的校验/指纹规则
    if (r.status >= 400 && r.status < 500) {
      dumpUpstreamBody("wb-last-4xx.json", bodyStr);
      log(`${NAME} 上游 ${r.status} 拒绝了请求（4xx=请求被上游否决），翻译后请求体已存 wb-last-4xx.json：${String(msg).slice(0, 160)}｜${ctx}`);
    }
    // 5xx 诊断（Bug A）：500 是「上游自己出错」而不是「请求被否决」，措辞分开，
    // 否则 Qoder 的 internal server error 会被误读成校验/指纹问题。另存 wb-last-5xx.json，
    // 不覆盖 4xx 存证（同一次运行里两者都可能各发生多次，都要留着对照）。
    else if (r.status >= 500) {
      dumpUpstreamBody("wb-last-5xx.json", bodyStr);
      log(`${NAME} 上游 ${r.status} 服务端错误（5xx=上游自身故障），翻译后请求体已存 wb-last-5xx.json：${String(msg).slice(0, 160)}｜${ctx}`);
    }
    return wbAnthroError(res, r.status, String(msg).slice(0, 300) + why);
  }
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) {
    const txt = await readAllBody(r).catch(() => "");
    noteRelayError(p, "upstream_bad", `${NAME} 返回非流式响应（${ct || "无 Content-Type"}）`);
    return wbAnthroError(res, 502, String(`上游返回非 SSE 响应：${upstreamBodyText(txt, 140)}`).slice(0, 200));
  }
  // 首事件闸门的时限：比响应头超时宽（深度思考模型可能几十秒才吐第一个 token），
  // 但必须有上限——否则「上游连上了却一直不吐字」会永远挂着，转移也等不到。
  await wbPipe(r, res, {
    model: j.model, clientStream: j.stream === true, inputJson: j,
    timeoutMs: Math.max(60000, (isProbe ? 10000 : 30000) * 3),
  }); // Anthropic 默认非流式
}

// 中转核心工厂：B.AI(:relayPort) 与 SenseNova(:sn.relayPort) 复用同一套逻辑，只是
// 取哪份配置(slice)、是否走代理(useProxy)、把流量记到哪个 recentCalls(store) 不同。
// 按"故障转移链"依次尝试。fo 形如 {provider:"qd", slice, useProxy, opts}。
// 每家一次尝试都先写进影子 res：首个响应是错误就丢弃换下一家，是 200 才落盘。
async function attemptWithFailover(fo, req, res, cfg, body, rewritten, isProbe, tier0) {
  const foCfg = cfg.failover || {};
  if (!foCfg.enabled) {
    await dispatchOne(fo, req, res, cfg, body, rewritten, isProbe);
    return;
  }
  const order = (Array.isArray(foCfg.chain) && foCfg.chain.length ? foCfg.chain : [fo.provider])
    .filter(Boolean);
  // 当前提供方永远排第一——手动选的就是首选，不该被配置里的顺序顶掉
  const chain = [fo.provider, ...order.filter((x) => x !== fo.provider)];
  const tries = [];
  let lastErr = "";
  // 每个目标渠道都要按**它自己的**路由表重新把档位解析成模型名：主渠道的映射在别的
  // 渠道往往不存在（Qoder 的 lite / WorkBuddy 的 deepseek-* / Zen 的 space-bunny-free
  // 互不相通）。不重解析的话转移过去必然 400 "Model is unavailable"。
  const bodyFor = (target) => {
    if (!tier0 || !rewritten) return { body, rewritten };
    const m = resolveModel(tier0, {
      mapping: target.S.mapping, availableModels: target.S.availableModels, defaultModel: target.S.defaultModel,
    });
    return { body: Buffer.from(JSON.stringify({ ...rewritten, model: m })), rewritten: { ...rewritten, model: m } };
  };
  for (const provider of chain) {
    const isEntry = provider === fo.provider;
    // 额度用尽（非瞬时）时**入口也退到后面**：瞬时冷却期间入口仍然永远第一
    // （手动选的就是首选，90 秒的抖动不该改变用户的选择）；但额度用尽等多久都没用，
    // 继续把它排第一只是让每条请求都先白撞一次死渠道。冷却到期后自动回到第一。
    if (isEntry && failoverQuotaBlocked(provider)) { tries.push({ provider, skipped: "额度冷却中" }); continue; }
    if (!isEntry && !failoverAvailable(provider)) { tries.push({ provider, skipped: "冷却中" }); continue; }
    // 目标渠道必须已配置凭据，否则跳（避免拿一个必然 401 的渠道去试）
    if (!providerConfigured(provider, cfg)) { tries.push({ provider, skipped: "未配置" }); continue; }
    const target = provider === fo.provider ? fo : relaySpec(provider, cfg);
    if (!target) { tries.push({ provider, skipped: "未知渠道" }); continue; }
    const cap = new CaptureRes(res);
    const sub = bodyFor(target);
    try {
      await dispatchOne(target, req, cap, cfg, sub.body, sub.rewritten, isProbe);
    } catch (e) {
      cap.discard();
      lastErr = String((e && e.message) || e);
      tries.push({ provider, ok: false, err: lastErr.slice(0, 120) });
      failoverCooldown(provider, lastErr);
      noteRelayError(provider, "failover", `转移走（异常）：${lastErr.slice(0, 120)}`);
      continue;
    }
    if (cap.ok()) {
      failoverClear(provider);
      tries.push({ provider, ok: true });
      if (tries.length > 1) noteFailoverEvent(fo.provider, tries);
      return;
    }
    // 影子判定为失败：换一个
    const status = cap.status || 0;
    tries.push({ provider, ok: false, status, err: String(describeError(cap) || "").slice(0, 110) });
    if (!shouldFailover(status)) {
      // 不该转移（多半是 400 请求本身有问题）——把这次的真实错误原样还给客户端
      // 注意：这里是**没有发生转移**的分支（换渠道也没用，直接原样返回）。
      // 措辞必须与行为一致，否则排查时会被"故障转移"字样误导成渠道切换过。
      noteChannelAttempt(fo.provider, tries);
      if (cap.flushBuffered()) return;
      return wbAnthroError(res, status || 502,
        `${target.label} 返回 ${status || "网络错误"}，此错误重试其他渠道也不会好转：${describeError(cap)}`);
    }
    lastErr = describeError(cap) || `HTTP ${status}`;
    failoverCooldown(provider, lastErr); // 若刚才那次是额度用尽，这里不会把它降级成 90 秒（failover.mjs 有闸）
    // 刚试过的渠道若已被标成「额度用尽」，转移日志也要带上这个标签——
    // 否则状态面板只剩一个笼统的 failover，分不出"额度没了"和"抖了一下"。
    const quotaNow = failoverQuotaBlocked(provider);
    // T0（v1.0.58）：openaiExchange 刚在这次尝试里归因出的 upstream_NNN（如 Zen 500 →
    // upstream_500）要保留下来，别被笼统的 "failover" 覆盖——「未转移」分支（上面的 400）
    // 本来就不覆盖具体 kind，两个分支行为应当一致。判定用 at 新鲜度（本请求内刚写过），
    // 避免捡到上一条请求的陈旧 kind；quota 分支优先级不变（failover_quota 语义不动）。
    const prevKind = (relayErrors[provider] && relayErrors[provider].kind) || "";
    const prevAt = relayErrors[provider] && relayErrors[provider].at ? new Date(relayErrors[provider].at).getTime() : 0;
    const keepKind = !quotaNow && /^upstream_\d+$/.test(prevKind) && Date.now() - prevAt < 60000;
    noteRelayError(provider, quotaNow ? "failover_quota" : (keepKind ? prevKind : "failover"),
      `转移走（HTTP ${status}${quotaNow ? "，额度用尽" : ""}）：${String(lastErr).slice(0, 120)}`);
  }
  noteFailoverEvent(fo.provider, tries);
  return wbAnthroError(res, 502,
    `所有渠道都失败了。最后一次：${lastErr || "未知"}（链路：${tries.map((t) => t.provider + (t.ok ? "✓" : t.skipped ? "(" + t.skipped + ")" : "✗")).join(" → ")}）`);
}

function describeError(cap) {
  try {
    if (!cap.buf || !cap.buf.length) return `HTTP ${cap.status || 0}`;
    const txt = Buffer.concat(cap.buf).toString("utf8");
    const m = txt.match(/"message"\s*:\s*"([^"]{1,200})"/);
    if (m) return m[1];
    const m2 = txt.match(/"error"\s*:\s*"([^"]{1,200})"/);
    return m2 ? m2[1] : txt.slice(0, 160);
  } catch { return ""; }
}

// 下面两个函数共用同一种"试过哪些渠道"的描述，抽出来免得两处格式串各自漂移。
function describeTries(tries) {
  return tries.map((t) => `${t.provider}:${t.ok ? "成功" : t.skipped || ("失败[st=" + t.status + (t.err ? "/" + String(t.err).slice(0,40) : "") + "]")}`).join("；");
}

function noteFailoverEvent(from, tries) {
  log(`故障转移（入口 ${from}）→ ${describeTries(tries)}`);
}

// 与 noteFailoverEvent 的区别：这里**没有**发生渠道转移——命中不该转移的错误（如 400），
// 原错误被直接还给客户端。措辞刻意避开"故障转移"，只陈述试过哪些渠道。
function noteChannelAttempt(from, tries) {
  log(`渠道尝试（入口 ${from}，未转移）→ ${describeTries(tries)}`);
}

function dispatchOne(fo, req, res, cfg, body, rewritten, isProbe) {
  return handleUpstream(fo, req, res, cfg, body, rewritten, isProbe);
}

function providerConfigured(provider, cfg) {
  if (provider === "bai") return !!cfg.apiKey;
  if (provider === "sn") return !!cfg.sn?.apiKey;
  if (provider === "wb") return !!cfg.wb?.accessToken;
  if (provider === "zen") return !!cfg.zen?.apiKey;
  if (provider === "or") return orKeys(cfg).length > 0;   // 轮换区：至少 1 把 key 就算配置好
  if (provider === "qd") { try { qdEnsureToken(cfg); return true; } catch { return false; } }
  return false;
}

function relaySpec(provider, cfg) {
  const meta = {
    bai: ["B.AI", () => true, {}],
    sn: ["SenseNova", () => cfg.sn?.useProxy === true, {}],
    wb: ["WorkBuddy", () => cfg.wb?.useProxy === true, { openai: true }],
    zen: ["OpenCode Zen", () => cfg.zen?.useProxy === true, { openai: true }],
    qd: ["Qoder", () => cfg.qd?.useProxy === true, { openai: true }],
    or: ["OpenRouter", () => cfg.or?.useProxy === true, { openai: true }],
  }[provider];
  if (!meta) return null;
  return { provider, label: meta[0], useProxy: meta[1], opts: meta[2], S: sliceOf(cfg, provider) };
}

function makeRelay(p, store, getSlice, useProxy, opts = {}) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      // 准入门（Bug B）：openai 桥（wb/zen/qd）只承接「POST + /v1/*」的模型调用。
      // 以前这里对任何 path/method 都往下走模型调用逻辑：GET 没有 body → rewritten 为 null
      // → handleUpstream 里那句 400「请求体必须是 Anthropic messages JSON」把 /api/ping
      // 这类探测也当成坏请求体答了。真正的病根是「这压根不是一次模型调用」。
      // 注意：必须在 body 收完（本回调内）再应答——req.on("data") 已经在收集，
      // 提前 return 而不 res.end() 会让 socket 一直挂着。
      // 只门 openai 桥：bAI/SenseNova 是原样透传中转，非 /v1/ 路径交给上游自己答，保持原行为。
      if (opts.openai) {
        const pathOnly = String(req.url || "").split("?")[0];
        setErrProvider(relayLabel(p));
        if (!pathOnly.startsWith("/v1/")) {
          // 面板的 /api/* 注册在面板端口那个 server 上，中转端口本来就不服务它们
          return wbAnthroError(res, 404, `中转端口只承接 /v1/* 模型调用，不提供 ${pathOnly || "/"}（面板接口请走面板端口）`);
        }
        if (req.method !== "POST") {
          try { res.setHeader("Allow", "POST"); } catch { }
          return wbAnthroError(res, 405, `${req.method} 不是模型调用——本中转只接受 POST /v1/*`);
        }
      }
      const cfg = loadCfg(); // 每请求实时读：映射改完立即生效，无需重启
      const S = getSlice(cfg); // {upstream, mapping, defaultModel, availableModels}
      const sliceCfg = { mapping: S.mapping, availableModels: S.availableModels, defaultModel: S.defaultModel };
      let body = Buffer.concat(chunks);
      let rewritten = null; // 模型解析后的请求 JSON（OpenAI 桥用）
      let tier0 = null;      // 原始档位（故障转移时要按目标渠道的映射重新解析成模型名）
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (body.length && ct.includes("json")) {
        try {
          const j = JSON.parse(body.toString("utf8"));
          if (typeof j.max_tokens === "number" && j.max_tokens < 3) j.max_tokens = 3; // 桌面版健康探测兼容
          if (typeof j.model === "string") {
            const tier = normalizeModel(j.model);
            tier0 = tier; // 记下原始档位，转移时按新渠道的映射重解析
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
      // 探活级小请求（max_tokens≤8）：更短超时
      const isProbe = (() => { try { const j = JSON.parse(body.toString("utf8")); return typeof j.max_tokens === "number" && j.max_tokens <= 8; } catch { return false; } })();
      try {
        await attemptWithFailover({ provider: p, S, useProxy, opts }, req, res, cfg, body, rewritten, isProbe, tier0);
      } catch (e) {
        try { log('FODEBUG STACK: ' + String(e && e.stack)); } catch {}
        if (!res.headersSent) wbAnthroError(res, 502, String((e && e.message) || e));
        else try { res.end(); } catch { }
      }
    });
  });
}

// 一次尝试：把请求送到本渠道的上游并把响应写进 res（可能是影子 res）。
// 从 makeRelay 里原样抽出，只把闭合的 p/S/useProxy/opts 换成 fo.*。
async function handleUpstream(fo, req, res, cfg, body, rewritten, isProbe) {
        const headers = {};
        for (const k of PASS_HEADERS) if (req.headers[k]) headers[k] = req.headers[k];
        // isProbe 由入口算好后传入（同时决定中转观察与超时档位），这里不再重算
        const headerTimeoutMs = isProbe ? 10000 : 30000;
        // WorkBuddy（fo.opts.openai）：上游只讲 OpenAI 且仅流式——独立协议桥处理，
        // 请求（Anthropic→OpenAI）与响应（OpenAI SSE→Anthropic SSE）都在桥内翻译。
        if (fo.opts.openai) {
          // rewritten=null = 确实是一次模型调用（GET/非 /v1/ 已在 makeRelay 准入门被 404/405 挡掉），
          // 但 body 没解析出 JSON。文案必须如实说明**实际收到了什么**——
          // 「请求体为空」「Content-Type 不是 JSON」「JSON 解析失败」三件事以前共用一句话。
          if (!rewritten) {
            const ctv = String(req.headers["content-type"] || "(未带 Content-Type)");
            const len = body && body.length ? body.length : 0;
            const raw = len ? body.toString("utf8").replace(/\s+/g, " ").slice(0, 80) : "(空)";
            const why = !len ? "请求体为空"
              : !ctv.toLowerCase().includes("json") ? "Content-Type 不是 JSON"
              : "body 不是合法 JSON";
            setErrProvider(relayLabel(fo.provider));
            return wbAnthroError(res, 400, `请求体无法解析为 Anthropic messages JSON：${why}｜Content-Type=${ctv}｜长度=${len} 字节｜前 80 字节=${raw}`);
          }
          try {
            await openaiExchange(fo.provider, { cfg, S: fo.S, j: rewritten, isProbe, res, useProxy: fo.useProxy(cfg) });
          } catch (e) {
            noteRelayError(fo.provider, "network", String((e && e.message) || e));
            if (!res.headersSent) wbAnthroError(res, 502, (e && e.message) || e);
            else try { res.end(); } catch { }
          }
          return;
        }
        const UP = fo.S.upstream + req.url;
        const doCall = () => fo.useProxy(cfg)
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
            noteRelayError(fo.provider, "rate_limit", "上游 429 限流（免费渠道并发敏感）");
            return sendRateLimitError(res, r);
          }
          // Anthropic API 端点只应返回 JSON 或 SSE；其余类型通常是代理/WAF
          // 的 HTML 页面。转换为标准 JSON 错误，避免调用端误报 JSON 解析异常。
          if (req.url.startsWith("/v1/") && !isApiResponseType(r.headers.get("content-type"))) {
            return sendUnexpectedUpstreamResponse(res, r);
          }
          if (r.status >= 400) noteRelayError(fo.provider, `upstream_${r.status}`, `上游 HTTP ${r.status}（${req.url}）`);
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
          if (fo.useProxy(cfg) && msg.includes("fetch failed")) scheduleProxyCheck(0, "上游连接失败触发"); // 代理可能换了端口/挂了 → 自动探测
          // v1.0.19: 超时/网络错误给出人话归因，并记录到面板"本地中转"灯
          const timedOut = e?.name === "AbortError" || msg.toLowerCase().includes("abort");
          const friendly = timedOut
            ? `上游 ${fo.S.upstream} 在 ${isProbe ? 10 : 30}s 内未返回响应头（节点慢或被墙），已中断本次请求`
            : msg;
          noteRelayError(fo.provider, timedOut ? "timeout" : msg.includes("fetch failed") ? "proxy" : "network", friendly);
          if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "relay_error", message: friendly } }));
        }
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
// OpenRouter（第 6 家）：OpenAI 协议 + 通用桥；凭据是 keys[] 轮换区，由 openaiExchange 内的
// orPick/orAdvance 每请求现选（这里传的 slice 只提供 upstream/mapping/availableModels）。
const orRelay = makeRelay("or", recentCallsOr, (cfg) => ({ upstream: cfg.or.upstream, mapping: cfg.or.mapping, defaultModel: cfg.or.defaultModel, availableModels: cfg.or.availableModels }), (cfg) => cfg.or.useProxy === true, { openai: true });

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
  if (p === "or") {
    const o = cfg.or || {};
    return {
      // key = 轮换区里当前这把（供指纹展示 / 接线比对 / /api/test 的 Bearer）。
      // 绝不回显明文：面板只看 keyFp。
      p: "or", zh: "OpenRouter", key: orActiveKey(cfg), upstream: o.upstream || DEFAULTS.or.upstream,
      relayPort: o.relayPort || DEFAULTS.or.relayPort, defaultModel: o.defaultModel || DEFAULTS.or.defaultModel,
      availableModels: o.availableModels || [...DEFAULTS.or.availableModels], mapping: o.mapping || { ...DEFAULTS.or.mapping },
      useProxy: o.useProxy === true,
    };
  }
  return {
    p: "bai", zh: "B.AI", key: cfg.apiKey || "", upstream: cfg.upstream || DEFAULTS.upstream,
    relayPort: cfg.relayPort || DEFAULTS.relayPort, defaultModel: cfg.defaultModel || DEFAULTS.defaultModel,
    availableModels: cfg.availableModels || [...DEFAULTS.availableModels], mapping: cfg.mapping || { ...DEFAULTS.mapping },
    useProxy: true,
  };
}
const PROVIDERS = { bai: "B.AI", sn: "SenseNova", wb: "WorkBuddy", zen: "OpenCode Zen", qd: "Qoder", or: "OpenRouter" };
const isOurs = (mode) => mode === "bai" || mode === "sn" || mode === "wb" || mode === "zen" || mode === "qd" || mode === "or";
function hostOf(u) { try { return new URL(u).host; } catch { return ""; } }

// CLI 的 ANTHROPIC_BASE_URL 恒为提供方上游本体（B.AI=api.b.ai、sn=token.sensenova.cn），不经本地中转；
// 只有桌面版走 127.0.0.1:<relay>。故两者用不同的判据。
function cliMode(cfg, cfgKey, snKey, wbKey, zenKey, qdKey, orKey) {
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
    if (qdKey != null) r.keyMatchQd = key === qdKey;
    if (orKey != null) r.keyMatchOr = key === orKey;
    const bh = hostOf(c.upstream || DEFAULTS.upstream), sh = hostOf(c.sn?.upstream || DEFAULTS.sn.upstream);
    if (bh && u.includes(bh)) return { mode: "bai", ...r };
    if (sh && u.includes(sh)) return { mode: "sn", ...r };
    // WorkBuddy 的 CLI 直接指向本地协议桥（CLI 讲 Anthropic，上游讲 OpenAI，必须过桥）
    if (u.includes(`:${c.wb?.relayPort || DEFAULTS.wb.relayPort}`)) return { mode: "wb", ...r };
    if (u.includes(`:${c.zen?.relayPort || DEFAULTS.zen.relayPort}`)) return { mode: "zen", ...r };
    // Qoder 同理走本地协议桥；令牌会轮换，故只按端口判据，不做 key 匹配
    if (u.includes(`:${c.qd?.relayPort || DEFAULTS.qd.relayPort}`)) return { mode: "qd", ...r };
    // OpenRouter 同理走本地协议桥（OpenAI 协议 → 桥翻译）
    if (u.includes(`:${c.or?.relayPort || DEFAULTS.or.relayPort}`)) return { mode: "or", ...r };
    if (u.includes(":15721")) return { mode: "ccswitch", ...r };
    return { mode: "other", ...r };
  } catch {
    return { mode: "unknown", baseUrl: "" };
  }
}
function desktopMode(cfg, cfgKey, snKey, wbKey, zenKey, qdKey, orKey) {
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
    if (qdKey != null) r.keyMatchQd = key === qdKey;
    if (orKey != null) r.keyMatchOr = key === orKey;
    if (u.includes(`:${c.relayPort || DEFAULTS.relayPort}`)) return { mode: "bai", ...r };
    if (u.includes(`:${c.sn?.relayPort || DEFAULTS.sn.relayPort}`)) return { mode: "sn", ...r };
    if (u.includes(`:${c.wb?.relayPort || DEFAULTS.wb.relayPort}`)) return { mode: "wb", ...r };
    if (u.includes(`:${c.zen?.relayPort || DEFAULTS.zen.relayPort}`)) return { mode: "zen", ...r };
    // Qoder 同理走本地协议桥；令牌会轮换，故只按端口判据，不做 key 匹配
    if (u.includes(`:${c.qd?.relayPort || DEFAULTS.qd.relayPort}`)) return { mode: "qd", ...r };
    if (u.includes(`:${c.or?.relayPort || DEFAULTS.or.relayPort}`)) return { mode: "or", ...r };
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
  // WorkBuddy / Qoder / OpenRouter 必须走本地协议桥（CLI 是 Anthropic 协议，上游只讲 OpenAI）
  e.ANTHROPIC_BASE_URL = (S.p === "wb" || S.p === "qd" || S.p === "or") ? `http://127.0.0.1:${S.relayPort}` : S.upstream;
  e.ANTHROPIC_MODEL = S.mapping["claude-haiku-4-5"]?.target || S.defaultModel;
  for (const t of TIERS) {
    e[t.envKey] = S.mapping[t.key]?.target || S.defaultModel;
    delete e[t.envKey + "_NAME"];
  }
  e.API_TIMEOUT_MS = e.API_TIMEOUT_MS || "3000000";
  e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  e.NODE_USE_ENV_PROXY = "1";
  if (S.p === "bai" || S.p === "or") {
    // 出海渠道（B.AI / OpenRouter）：CLI 直连上游时靠 proxy env 出海。
    // OpenRouter 走的是本地桥（127.0.0.1），但桥自己出海仍要代理——env 留着没坏处。
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
  const orm = providerStatus(cfg, "or", recentCallsOr);
  let qdTok = null;
  try { qdTok = qdEnsureToken(cfg); } catch { }
  const wbExp = wbTokenExp(cfg.wb?.accessToken);
  // 版别（v1.0.59）：按登录域名判定 cn/intl（读不到登录文件 → null），面板要能
  // 一眼看出「现在配的是哪版的通道、实际上游拨到了哪个端点」
  const wbAuthNow = wbDetectAuth();
  // OpenRouter 的额度真相（/auth/key）：面板轮询走 60 秒缓存，不打上游
  const orQuota = orQuotaSnapshot(cfg);
  const orKeysNow = orKeys(cfg);
  return {
    now: new Date().toISOString(),
    service: { up: true, uptimeSec: Math.floor((Date.now() - BOOT) / 1000), pid: process.pid },
  failover: { enabled: cfg.failover?.enabled === true, chain: cfg.failover?.chain || [], cooling: failoverSnapshot() },
    panel: { port: cfg.panelPort, up: true },
    clash,
    proxy: cfg.proxy || "直连",
    ccswitch: { running: ccswitch },
    // 接线状态（两端各自归属哪个提供方）。keyMatch=对 B.AI key 的匹配，
    // keyMatchSn/keyMatchWb 分别是对 SenseNova / WorkBuddy 凭据的匹配——各页各取各的对比对象。
    cli: cliMode(cfg, cfg.apiKey, cfg.sn?.apiKey, cfg.wb?.accessToken, cfg.zen?.apiKey, cfg.qd?.token || "qd-local", orActiveKey(cfg)),
    desktop: desktopMode(cfg, cfg.apiKey, cfg.sn?.apiKey, cfg.wb?.accessToken, cfg.zen?.apiKey, cfg.qd?.token || "qd-local", orActiveKey(cfg)),
    // B.AI 灯/接线沿用旧字段名，SenseNova 灯挂 sn 下，WorkBuddy 灯挂 wb 下
    relay: bai.relay, relayLast: bai.relayLast, upstream: bai.upstream, recent: bai.recent,
    sn: { relay: sn.relay, relayLast: sn.relayLast, upstream: sn.upstream, recent: sn.recent, useProxy: cfg.sn?.useProxy === true },
    zen: { relay: zen.relay, relayLast: zen.relayLast, upstream: zen.upstream, recent: zen.recent, useProxy: cfg.zen?.useProxy === true, keyConfigured: !!cfg.zen?.apiKey },
    qd: {
      relay: qd.relay, relayLast: qd.relayLast, upstream: qd.upstream, recent: qd.recent,
      useProxy: cfg.qd?.useProxy === true,
      // 令牌是轮换的 jobToken，只有"当前有没有读到"这一态有意义（无到期时间可报）
      token: { configured: !!qdTok, tokenFile: cfg.qd?.tokenFile || DEFAULTS.qd.tokenFile },
      // v1.0.57：worker 补丁是否已装。新电脑上没装补丁 = 没令牌 = 面板显示「未读到」，
      // 前端据此把「请启动 Qoder」换成「点这里一键装补丁」——这才是用户真正能做的动作。
      patch: qdPatchInfo(),
    },
    wb: {
      relay: wb.relay, relayLast: wb.relayLast, upstream: wb.upstream, recent: wb.recent,
      useProxy: cfg.wb?.useProxy === true,
      // 版别（v1.0.59）："cn"=国内版 / "intl"=国际版 / null=读不到登录文件；
      // authDomain 为登录文件里的 auth.domain 原文（配合上游 host 即能看出是否已自动拨对）
      edition: wbAuthNow.edition,
      authDomain: wbAuthNow.domain,
      // 令牌体检：有无令牌、访问令牌到期时间、是否带刷新令牌
      token: {
        configured: !!cfg.wb?.accessToken,
        expAt: wbExp ? new Date(wbExp * 1000).toISOString() : null,
        expiresInDays: wbExp ? Math.max(0, Math.round((wbExp * 1000 - Date.now()) / 86400000)) : null,
        hasRefresh: !!cfg.wb?.refreshToken,
      },
    },
    // OpenRouter（第 6 家）：三盏灯 + 两层轮换状态 + 额度真相（「免费流水区」卡读这里）
    or: {
      relay: orm.relay, relayLast: orm.relayLast, upstream: orm.upstream, recent: orm.recent,
      useProxy: cfg.or?.useProxy === true,
      // 只回显指纹（keyFp），明文永不进 /api/status
      token: {
        configured: orKeysNow.length > 0,
        keyCount: orKeysNow.length,
        keys: orKeysNow.map((k, i) => ({
          no: i + 1, fp: keyFp(k),
          active: i === Math.min(orState.keyIdx, Math.max(0, orKeysNow.length - 1)),
          coolingUntil: orCoolLeft(orState.keyCool, i, Date.now()) ? new Date(orState.keyCool.get(i)).toISOString() : null,
        })),
      },
      rotation: (() => {
        const models = orModelList(cfg);
        const now = Date.now();
        return {
          activeKeyNo: orKeysNow.length ? Math.min(orState.keyIdx, orKeysNow.length - 1) + 1 : null,
          activeModel: models[Math.min(orState.modelIdx, Math.max(0, models.length - 1))] || null,
          modelCount: models.length,
          cooledModels: [...orState.modelCool.entries()].filter(([, t]) => t > now)
            .map(([m, t]) => ({ model: m, until: new Date(t).toISOString() })),
          limitSource: orState.lastLimitSource,
          lastResetAt: orState.lastResetAt ? new Date(orState.lastResetAt).toISOString() : null,
          resetCountdownMs: Math.max(0, (orNextResetAt() || 0) - now),
          lastSwitch: orState.lastSwitch,
        };
      })(),
      quota: orQuota,
    },
  };
}

const lastTest = {
  bai: { ok: null, model: null, ms: null, error: null, at: null },
  sn: { ok: null, model: null, ms: null, error: null, at: null },
  wb: { ok: null, model: null, ms: null, error: null, at: null },
  zen: { ok: null, model: null, ms: null, error: null, at: null },
  qd: { ok: null, model: null, ms: null, error: null, at: null },
  or: { ok: null, model: null, ms: null, error: null, at: null },
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
    // v1.0.46: 五家提供方页面收敛为**同一份模板** provider.html + 清单 providers.js。
    // 此前每家一份、54–70% 逐字重复，加到第五家时出了五处复制粘贴漂移（错配的文案、
    // 永远不亮的高亮、判断错 provider 的灯）。现在加一家 = 清单加一条。
    //
    // 回退：**不要**只把这几行改回读 ui/sn/wb/zen/qd.html —— panel-common.js 已重写成
    // 自带渲染层的整页驱动脚本，与旧页的内联渲染逻辑会同时驱动同一页、互相打架，
    // 旧页面并不能配新 panel-common.js 工作。正确回退是把整个重构一起退：
    // 该重构未拆成多次提交，故 `git checkout -- src/`（并删掉新增的 provider.html /
    // providers.js / panel-common.css / cards/）即回到 v1.0.45 的完整一致状态。
    // 别名一律 **302 重定向**到规范路径，绝不直接渲染模板。
    // 原因：provider.html + panel-common.js 是按「清单 path 与当前 pathname 精确相等」
    // 来认页面的（panel-common.js 顶部那个 for 循环）。别名若也返回模板，清单匹配不上 →
    // 渲染层在 `if (!P ...) return` 处整个退出，页面只剩外壳——导航和底栏在、所有
    // 交互都不在，且没有任何提示，比 404 难查得多。HEAD 上 /index.html 是完全可用的
    // （老 server.mjs 的第一个分支），直接发模板等于把它变成半死页。
    const PROVIDER_ALIAS = {
      "/index.html": "/", "/ui.html": "/",
      "/sensenova": "/sn", "/sn.html": "/sn",
      "/workbuddy": "/wb", "/wb.html": "/wb",
      "/opencode": "/zen", "/zen.html": "/zen",
      "/qoder": "/qd", "/qd.html": "/qd",
      "/openrouter": "/or", "/or.html": "/or",
    };
    if (req.method === "GET" && PROVIDER_ALIAS[u.pathname]) {
      res.writeHead(302, { location: PROVIDER_ALIAS[u.pathname], "cache-control": "no-store" });
      return res.end();
    }
    // 只认六个规范路径。这里写成显式比较而非数组 includes，是为了让
    // scripts/check-manifest.cjs 的 C1（清单 path 必须在服务端有对应分支）与
    // C10（渲染模板的路径必须有清单 path 匹配）能用字面量 grep 判断。
    if (req.method === "GET" && (
      u.pathname === "/" || u.pathname === "/sn" || u.pathname === "/wb" ||
      u.pathname === "/zen" || u.pathname === "/qd" || u.pathname === "/or"
    )) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "provider.html")));
    }

    // v1.0.40: 五个提供方页面共用的底栏/更新控件（单一来源，避免各页复制后漂移）
    // provider.html 引用的三样共享资源。缺任何一个，五个页面都会白屏。
    if (req.method === "GET" && u.pathname === "/panel-common.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "panel-common.css")));
    }
    if (req.method === "GET" && u.pathname === "/providers.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "providers.js")));
    }
    // 专属卡片模块：/cards/<name>.js，name 白名单化，避免变成任意文件读取
    if (req.method === "GET" && u.pathname.startsWith("/cards/") && u.pathname.endsWith(".js")) {
      const card = u.pathname.slice(7, -3);
      if (!/^[a-z][a-z0-9-]*$/.test(card)) return json(res, 400, { error: "bad card name" });
      const f = path.join(HERE, "cards", card + ".js");
      if (!existsSync(f)) return json(res, 404, { error: "no such card" });
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(f));
    }
    if (req.method === "GET" && u.pathname === "/panel-common.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "panel-common.js")));
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
      // v1.0.58：附带实时进度（phase/phaseText/kick）——前端如实显示「钩子注入了没、
      // 踢侧车结果、还差什么」，超时文案也由后端按卡点分类生成，不再一律转圈。
      return json(res, 200, {
        active: wbCapState.active,
        startedAt: wbCapState.startedAt,
        elapsedMs: wbCapState.active ? Date.now() - wbCapState.startedAt : 0,
        gotAccessToken: !!(wbCapState.active && wbCapState.got),
        phase: wbCapState.phase || null,
        phaseText: wbCapState.phaseText || null,
        kick: wbCapState.kick || null,
      });
    }

    // v1.0.57: Qoder worker 补丁——一键装/还原/查状（Node 内置实现，不需要用户装 Python）。
    // 背景见 qoder-patch.mjs 顶部注释：令牌只存在于 worker 进程内存，磁盘上没有明文持久化，
    // 出网流量里也没有 refresh_token，所以「运行时打补丁」是唯一可行方案。
    // 这三条 API 把原来「qoder-patch/patch_worker.py + 手装 Python + 每次升级重跑」
    // 收进面板一个按钮里，新电脑开箱即用。
    if (req.method === "GET" && u.pathname === "/api/qd/patch/status") {
      try { return json(res, 200, { ok: true, ...qpStatus() }); }
      catch (e) { return json(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }
    if (req.method === "POST" && u.pathname === "/api/qd/patch/apply") {
      try {
        const r = qpApply();
        log("Qoder 补丁 apply:", JSON.stringify(r.results.map((x) => x.ver + "=" + x.state)));
        // 补丁文件改动后，已缓存的令牌状态要重读一次
        try { qdEnsureToken(loadCfg(), true); } catch { }
        return json(res, 200, { ok: r.fail === 0, ...r });
      } catch (e) {
        return json(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    }
    if (req.method === "POST" && u.pathname === "/api/qd/patch/revert") {
      try {
        const r = qpRevert();
        log("Qoder 补丁 revert:", r.reverted + "/" + r.total);
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        return json(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
    }

    // v1.0.19: 拉取上游真实模型目录。模型会腐烂/新增（实测 mimo-v2.5 目录里有但实际 503），
    // 下拉框不能只靠发布机默认列表；UI 的「刷新模型列表」按钮走这里。
    // v1.0.28: ?p=sn 时从 SenseNova 拉（境内直连，不走代理）；只保留可对话模型（output 含 text）。
    if (req.method === "GET" && u.pathname === "/api/models") {
      const pRaw = u.searchParams.get("p");
      const p = pRaw === "sn" ? "sn" : pRaw === "wb" ? "wb" : pRaw === "zen" ? "zen" : pRaw === "qd" ? "qd" : pRaw === "or" ? "or" : "bai";
      const c2 = loadCfg();
      try {
        return json(res, 200, await fetchCatalogFor(p, c2));
      } catch (e) {
        // 只有带 httpStatus 的（or 拉取失败 / 没填 key）在这里回，前端 api() 会抛到
        // 按钮旁边的结果槽；其余原样往上抛，由外层 catch 记栈回 500——抽函数前后一致。
        if (!e || !e.httpStatus) throw e;
        return json(res, e.httpStatus, { error: String((e && e.message) || e).slice(0, 200) });
      }
    }

    // v1.0.60：六家提供方的顺序（扫描与批量写入都按这个顺序走，面板展示顺序一致）
    const ALL_PKEYS = ["bai", "sn", "wb", "zen", "qd", "or"];

    /* 一键刷新全部提供方 —— 扫描端。
     *
     * **本接口全程只读**：不调 saveCfg、不调 applyToCli/applyToDesktop，
     * 扫完 config.json 必须逐字节不变（用户没点确认之前，一个字节都不许落地）。
     *
     * 基线取 loadCfg() 的**当前内存快照**，而不是拉回来的原始结果——onActivated() 已经把
     * config.defaults.json 并进了每家的 availableModels，拿裸结果比会凭空多出一堆「新增」。
     *
     * 六家并行拉（allSettled，一家挂了不牵连其余），墙钟时间由最慢的那家（15s 超时）封顶。 */
    if (req.method === "POST" && u.pathname === "/api/models/scan-all") {
      const cfg = loadCfg();
      const settled = await Promise.allSettled(ALL_PKEYS.map((k) => fetchCatalogFor(k, cfg)));
      const providers = ALL_PKEYS.map((k, i) => {
        const S = sliceOf(cfg, k);
        const name = PROVIDERS[k] || k;
        const haveArr = Array.isArray(S.availableModels) ? S.availableModels : [];
        const base = { key: k, name, have: haveArr.length };
        const st = settled[i];
        if (st.status === "rejected") {
          return { ...base, status: "error", added: [], removed: [], count: 0,
            error: String((st.reason && st.reason.message) || st.reason || "").slice(0, 200) };
        }
        const r = st.value || {};
        // **只看 models，绝不用 result.count**：zen/qd 的 count 是上游全目录长度，
        // 而 models 是筛过可用性之后的子集（zen 只留实测能外部调用的那几个）。
        // 拿 count 当长度会算出几百条并不存在的「新增/删除」。
        const models = Array.isArray(r.models) ? r.models : [];
        // 状态四选一，让前端能区分「真没变化」和「压根没拿到可信数据」。
        let status = "ok";
        if (r.static === true) status = "static";        // qd 读不到本地目录退回内置静态表 / wb 本就只是回显配置
        else if (!models.length) status = "empty";      // zenReadCatalog() 会吞掉错误返回过期空缓存（HTTP 200），空列表是真故障
        // **只有 status==="ok" 才比差异。** 没拿到可信目录时算出来的 added/removed 是假的：
        //   empty —— 上游没给任何模型，「removed」会等于当前整张列表，照着应用就把配置洗成空；
        //   static —— qd 退回的是内置表，拿它跟真实配置比会凭空冒出差异。
        // 这层闸门放在服务端而不是前端：前端六个状态里漏判一个就是一次静默的数据丢失。
        if (status !== "ok") {
          return { ...base, status, added: [], removed: [], count: 0,
            ...(r.note ? { note: r.note } : {}) };
        }
        // 比对一律转小写：POST /api/config 存进去的都是小写，但 wb 是把配置原样回显、
        // qd 也未必归一，不转小写会把大小写差异当成模型增减。
        const cur = new Set(haveArr.map((x) => String(x).trim().toLowerCase()));
        const next = new Set(models.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
        const added = [...next].filter((x) => !cur.has(x));
        const removed = [...cur].filter((x) => !next.has(x));
        return { ...base, status, added, removed, count: next.size, ...(r.note ? { note: r.note } : {}) };
      });
      const changed = providers.some((x) => x.added.length || x.removed.length);
      return json(res, 200, { ok: true, changed, providers });
    }

    /* 一键刷新全部提供方 —— 写入端。
     *
     * 为什么必须单独一趟而不是让前端并发打六次 /api/config：saveCfg 走 writeAtomic 整文件
     * 重写且**没有锁**，六次并发各自读到不同快照，最后一次写会把另外五家的改动悄无声息地覆盖掉。
     * 所以这里 loadCfg() 一次、攒够六家再 saveCfg() 一次。 */
    if (req.method === "POST" && u.pathname === "/api/models/apply-all") {
      const b = await readBody(req);
      const apply = b && typeof b === "object" && b.apply && typeof b.apply === "object" && !Array.isArray(b.apply) ? b.apply : null;
      if (!apply) return json(res, 400, { error: "请求体需为 { apply: { 提供方键: [模型 id…] } }" });
      const cfg = loadCfg();
      const done = [], skipped = [];
      for (const k of ALL_PKEYS) {
        if (!Object.prototype.hasOwnProperty.call(apply, k)) continue;
        const ids = apply[k];
        // 未知键直接不认（ALL_PKEYS 之外的根本不会走到这里），非数组也只跳过不抛——
        // 这一趟是整批写入，宁可少写一家也不能因为一家的脏数据把其余五家一起拖下水
        if (!Array.isArray(ids)) { skipped.push(k); continue; }
        // 归一化与 POST /api/config 完全一致：去空白 → 转小写 → 去空 → 去重
        const arr = ids.map((x) => String(x == null ? "" : x).trim().toLowerCase()).filter(Boolean);
        // **空数组保持原列表不动**（沿用 /api/config 的既有语义）：宁可留着旧列表，
        // 也不能让一次误操作把某家的模型列表整个清空
        if (!arr.length) { skipped.push(k); continue; }
        // bai 是「扁平」的：它的字段就写在 cfg 顶层，没有 cfg.bai 这一层包装
        if (k !== "bai" && !cfg[k]) cfg[k] = { ...(DEFAULTS[k] || {}) };
        const sub = k === "bai" ? cfg : cfg[k];
        // 防呆：正在用的四档映射目标绝不能被刷掉。与面板单家刷新同一条规矩
        // （panel-common.js 的 refreshModels）——目标一旦不在下拉里，面板就会显示成
        // 「未映射」，等于这次刷新把用户的配置改坏了。
        const keep = Object.values(sub.mapping || {}).map((m) => String((m || {}).target || "").trim().toLowerCase()).filter(Boolean);
        sub.availableModels = [...new Set([...arr, ...keep])];
        done.push(k);
      }
      if (!done.length) {
        return json(res, 200, { ok: true, applied: [], needRestart: false, hints: ["没有可写入的提供方（空列表会被忽略，未知键会被跳过）"] });
      }
      saveCfg(cfg);
      // 端上已接到本次写入的某家提供方的话，立即同步新映射——**每端只做一次**，
      // 不按提供方逐个重写（写六遍同一个目标没有意义，还白白发出一堆外部快照告警）
      const applied = [];
      const curCli = cliMode(cfg).mode, curDesk = desktopMode(cfg).mode;
      if (done.includes(curCli)) { applyToCli(sliceOf(cfg, curCli)); applied.push("cli"); }
      if (done.includes(curDesk)) { applyToDesktop(sliceOf(cfg, curDesk)); applied.push("desktop"); }
      log(`批量模型列表已写入:`, done.join(",") + (skipped.length ? `（跳过:${skipped.join(",")}）` : ""), "重应用到:", applied.join(",") || "无");
      return json(res, 200, {
        ok: true,
        applied: done,
        skipped,
        // 只动 availableModels：中转每次请求实时读 config.json，映射即时生效，不需要重启
        needRestart: false,
        hints: [
          `已一次性写入 ${done.length} 家提供方的模型列表`,
          skipped.length ? `已跳过（空列表或非法值，保持原样）：${skipped.join("、")}` : null,
          applied.includes("cli") ? "CLI：新开的终端生效" : null,
          applied.includes("desktop") ? "桌面版：需完全退出并重开 Claude 生效" : null,
        ].filter(Boolean),
      });
    }

    if (req.method === "GET" && u.pathname === "/api/status") return json(res, 200, await statusPayload());

    // ---------- OpenRouter（第 6 家）专属接口：三把 key 的轮换区 + 额度真相 + 免费目录 ----------
    // 安全红线：key 明文只写 %APPDATA%\bai-router\config.json（本机、已 gitignore），
    // 绝不进 config.defaults.json / providers.js / HANDOFF.md；任何返回值都只给 keyFp 指纹。
    if (req.method === "GET" && u.pathname === "/api/or/status") {
      try {
        const payload = await orStatusPayload(loadCfg(), { refresh: u.searchParams.get("refresh") === "1" });
        return json(res, 200, { ok: true, ...payload });
      } catch (e) {
        return json(res, 200, { ok: false, error: String((e && e.message) || e).slice(0, 160) });
      }
    }
    if (req.method === "POST" && u.pathname === "/api/or/keys") {
      // body.keys：最多 3 把，空串/缺项 = 该格留空（即删除）。
      try {
        const b = await readBody(req);
        const raw = Array.isArray(b.keys) ? b.keys : [];
        if (raw.length > OR_KEYS_MAX) return json(res, 400, { error: `最多 ${OR_KEYS_MAX} 把 key` });
        const cleaned = [];
        for (const k of raw) {
          const v = String(k == null ? "" : k).trim();
          if (!v) continue;
          if (!/^sk-or-/.test(v)) return json(res, 400, { error: "OpenRouter 的 key 应以 sk-or- 开头（形如 sk-or-v1…）" });
          if (!cleaned.includes(v)) cleaned.push(v);
        }
        const cfg = loadCfg();
        if (!cfg.or) cfg.or = { ...DEFAULTS.or };
        cfg.or.keys = cleaned;
        // key 集合变了：轮换状态按新下标重置，别把上一把的每日冷却安到另一把头上
        orState.keyIdx = 0;
        orState.keyCool.clear();
        orQuotaCache = { at: 0, fp: null, data: null };
        saveCfg(cfg);
        failoverClear("or");   // 凭据换了，清掉可能残留的额度冷却，让新 key 立刻可用
        log(`OpenRouter key 区已更新：${cleaned.length} 把（仅存本机 config.json，返回值只含指纹）`);
        return json(res, 200, { ok: true, keys: cleaned.map((k, i) => ({ no: i + 1, fp: keyFp(k) })) });
      } catch (e) {
        return json(res, 400, { error: String((e && e.message) || e) });
      }
    }
    if (req.method === "POST" && u.pathname === "/api/or/refresh") {
      // 手动刷新：按 pricing 重筛免费模型目录（写回 availableModels）+ 强制重查额度
      try {
        const cfg = loadCfg();
        const r = await orFetchFreeModels(cfg);
        if (!cfg.or) cfg.or = { ...DEFAULTS.or };
        cfg.or.availableModels = r.ids;
        saveCfg(cfg);
        const quota = await orFetchQuota(cfg, true);
        return json(res, 200, { ok: true, count: r.ids.length, total: r.total, models: r.ids, quota });
      } catch (e) {
        return json(res, 400, { error: String((e && e.message) || e).slice(0, 200) });
      }
    }

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
      const P = ["sn", "zen", "qd", "or"].includes(b.provider) ? b.provider : b.provider === "wb" ? "wb" : "bai";
      const sub = P === "sn" ? cfg.sn : P === "wb" ? cfg.wb : P === "zen" ? cfg.zen : P === "qd" ? cfg.qd : P === "or" ? (cfg.or || (cfg.or = { ...DEFAULTS.or })) : cfg; // 共用字段（mapping/upstream/…）落点
      // —— API Key（仅 B.AI / SenseNova）——
      if (typeof b.apiKey === "string" && b.apiKey.trim()) {
        const k = b.apiKey.trim();
        // zen 的 key 是 oc_sk_ 开头（OpenCode Zen），其余提供方是 sk- 前缀
        if (P === "zen") { cfg.zen.apiKey = k; }
        else if (P === "or") { /* OpenRouter 是三把 key 的轮换区，只走 POST /api/or/keys，这里不收单个 key */ }
        else {
          if (!k.startsWith("sk-")) return json(res, 400, { error: "API Key 应以 sk- 开头" });
          if (P === "sn") cfg.sn.apiKey = k; else if (P === "bai") cfg.apiKey = k;
        }
      }
      // —— 故障转移开关与链路顺序（provider=bai 那一份顶层配置）——
      if (P === "bai" && b.failover) {
        if (typeof b.failover.enabled === "boolean") cfg.failover = { ...(cfg.failover || {}), enabled: b.failover.enabled };
        if (Array.isArray(b.failover.chain)) {
          cfg.failover = { ...(cfg.failover || {}), chain: b.failover.chain.filter((x) => ["bai","sn","wb","zen","qd","or"].includes(x)) };
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
      const P = ["sn", "zen", "qd", "or"].includes(b.provider) ? b.provider : b.provider === "wb" ? "wb" : "bai";
      const cfg = loadCfg();
      const S = sliceOf(cfg, P);
      const name = PROVIDERS[P];
      if (!S.key) {
        return json(res, 400, {
          error: P === "wb"
            ? "请先在「WorkBuddy」页粘贴访问令牌（JWT）——捕获方法见该页说明"
            : P === "or"
              ? "请先在「OpenRouter」页的「免费流水区」填入至少 1 个 sk-or-v1 API Key（最多 3 把）"
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
      if (P === "or") warns.push("OpenRouter 免费区：免费模型 50 次/天/把 key，用尽自动换模型、再换 key（最多 3 把）；重置时间看 X-RateLimit-Reset，面板显示倒计时与剩余次数");
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
      const P = ["sn", "zen", "qd", "or"].includes(b.provider) ? b.provider : b.provider === "wb" ? "wb" : "bai";
      const S = sliceOf(cfg, P);
      const store = P === "sn" ? recentCallsSn : P === "wb" ? recentCallsWb : P === "zen" ? recentCallsZen : P === "qd" ? recentCallsQd : P === "or" ? recentCallsOr : recentCallsBai;
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
            if (!r.ok) throw new Error(upstreamErrorText(j, 120) || `上游返回 HTTP ${r.status}，但没带错误说明`);
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
        error: summarizeTierErrors(tiers),
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
    if (!relay.listening && !snRelay.listening && !wbRelay.listening && !zenRelay.listening && !qdRelay.listening && !orRelay.listening && !panel.listening) {
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
// v1.0.58：上次捕获若中途被强杀（finally 没跑到），WorkBuddy 的 CLI 脚本会留在
// 打补丁状态——磁盘备份还在就立刻自愈还原（脚本里已无钩子则只清理备份文件）。
wbCaptureSelfHeal();
listenWithRetry(snRelay, cfg0.sn.relayPort, "SenseNova中转");
listenWithRetry(wbRelay, cfg0.wb.relayPort, "WorkBuddy中转");
listenWithRetry(zenRelay, cfg0.zen.relayPort, "OpenCodeZen中转");
listenWithRetry(qdRelay, cfg0.qd.relayPort, "Qoder中转");
listenWithRetry(orRelay, cfg0.or.relayPort, "OpenRouter中转");
listenWithRetry(panel, cfg0.panelPort, "面板");
// 成功绑定中转端口 = 本实例成为唯一的活跃服务者，此时才允许合并配置/跑周期探测
relay.once("listening", () => setTimeout(onActivated, 300));
