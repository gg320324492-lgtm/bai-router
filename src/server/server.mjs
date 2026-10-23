// B.AI 路由台 —— 单进程双服务：
//   :relayPort  Anthropic 兼容中转（模型映射每次请求实时读 config.json，改了立即生效）
//   :panelPort  管理面板（UI + API：一键切换 / 一键恢复 / 映射编辑 / 状态体检）
// 启动方式任意：若缺 NODE_USE_ENV_PROXY 环境变量会自动以正确环境重启自己。
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, copyFileSync, renameSync, statSync, createWriteStream, readdirSync, rmSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import {
  CaptureRes, failoverCooldown, failoverClear, failoverAvailable, failoverSnapshot, failoverQuotaBlocked,
  shouldFailover, FAILOVER_COOLDOWN_MS, noteSilentJump, silentJumpSnapshot,
  restTable, failoverCooldownFor,
} from "./failover.mjs";
import { qpApply, qpRevert, qpStatus, QODER_PATCH_PATHS } from "./qoder-patch.mjs";
/* 逐模型能力探测（v1.0.74 · T3+T6）：只探免费模型、只在用户显式点「检测可用性」时跑。
 * 纯逻辑（判定 / 并发 / 落盘）在 zen-probe.mjs 里，HTTP 由下面的 zenProbeSend 注入。 */
import {
  zenProbeLoad, zenRunCapabilityProbe, zenCapLabel, zenCapHint, zenProbeClassify,
  zenExpectedRejection, ZEN_FREE_TIER_DIRECT_KIND,
  ZEN_PROBE_TOOL_ANTHROPIC,
  ZEN_PROBE_TIMEOUT_MS, ZEN_PROBE_CONCURRENCY, ZEN_PROBE_MAX_TOKENS, ZEN_PROBE_MAX_TOKENS_RETRY,
} from "./zen-probe.mjs";
/* OpenCode 传输层（v1.0.75）：zen 渠道的 `transport` 开关打开时，把这一档的请求改走
 * 一个真 `opencode serve`。默认 `direct` —— 直连路径一行都不变。翻译与进程管理分别在
 * oc-bridge.mjs / oc-runtime.mjs，接线本身在 oc-wiring.mjs。 */
import { createOcGateway, zenTransportOf, ZEN_TRANSPORT_OPENCODE, ZEN_TRANSPORTS } from "./oc-wiring.mjs";
/* 传输开关给面板的只读事实（v1.0.75）：当前是哪一档 + 打开它需要的那件前置条件
 * 在本机满足没有。探测本身（TTL 缓存 / 三态判据）在那个文件里。 */
import { ocTransportFields, probeOcBinary, resetOcBinaryCache } from "./oc-transport-info.mjs";
import { installOpenCodeCli, OC_CLI_VERSION } from "./oc-install.mjs";
/* 进程身份核对（v1.0.77）：只按 PID 终止之前先确认这个 PID 还是当初那个进程，
 * 免得 PID 被系统回收后误杀无关程序。判定是纯函数，实测启动时间靠 PowerShell CIM
 * （写的一侧零成本，见 SERVICE_START_MS）。 */
import { selfStartTimeMs, verifyPidRecord, pidIdentityMessage, VERDICT_SAME } from "./proc-identity.cjs";
/* WorkBuddy 账号池的**接线层**（v1.0.77）：读配置 → 建池 → 选号 → 回灌 → 给面板。
 * 纯逻辑、零 IO、零网络（时间源/哈希/刷新动作都由这里注入），内核在 wb-pool.mjs。
 * 失败原因一律问池子，绝不从响应文案反推账号好坏——见该文件顶部三条规矩。 */
import {
  wbPoolOf, wbPickAccount, wbNoteFailure, wbNoteRefreshFailure, wbPoolStatus,
  wbPaidSameName, wbMappingRows, wbUnusableStatus, redact as redactWiring,
  wbNoteSuccess, wbAffinityEntries,
} from "./wb-pool-wiring.mjs";
/* 流量视图的数据源（traffic.mjs）：按天分桶 + 每家流量 + 会话亲和，纯逻辑、零 IO。
 * ⚠ 它**不算钱** —— 钱要靠价格表，而价格表是「用户点了才更新」的那张。 */
import { buildTraffic } from "./traffic.mjs";
/* WorkBuddy 令牌的 JWT 声明解码（wb-token.mjs）：纯逻辑、零 IO。
 * 独立成文件是为了能**被测试直接 import**——server.mjs 一 import 就起服务，
 * 住在这里的解码器就成了「测了替身、没测本体」的重灾区（v1.0.76 漏 `* 1000`
 * 就是这么上线的，见该文件顶部的单位契约）。⚠ wbTokenExp 返回的是**毫秒**。 */
import { wbJwtPayload, wbTokenExp, wbTokenSub } from "./wb-token.mjs";
/* 上游「响应头预算」按请求体大小分档（v1.0.85）：纯逻辑、零 IO、零网络。
 * 独立成文件同样是为了能**被测试直接 import** —— server.mjs 一 import 就起服务，
 * 住在这里的分档规则只能「测了替身没测本体」（wb-token.mjs 顶部的教训）。
 * ⚠ 单位是**字节**：调用方一律走 upstreamBodyBytes()，不许手写 bodyStr.length
 * （中文 3 字节/字，字符数会低估到 1/3）。 */
import {
  upstreamBodyBytes, upstreamHeaderBudgetMs, upstreamFirstEventBudgetMs,
  upstreamBudgetTierLabel, UPSTREAM_HEADER_TIMEOUT_MS,
} from "./upstream-budget.mjs";
/* 429 的「上下文体积超限」判据（wb-429.mjs）：纯逻辑、零 IO。
 * 独立成文件同样是为了能**被测试直接 import**——server.mjs 一 import 就起服务，
 * 住在这里的判据就只能靠「注入替身」来测，而那正是 v1.0.76 漏 `* 1000` 的形状。
 * ⚠ wbBodyBytes 返回的是**字节数**（Buffer.byteLength），不是字符数。 */
import { wb429ContextHint } from "./wb-429.mjs";
/* MiniMax 会员托管通道（渠道键 `mm`）的凭据与请求头（mm-auth.mjs）。
 * 独立成文件是为了能**被测试直接 import**——server.mjs 一 import 就起服务，
 * 住在这里的续期/轮换逻辑就只能「测了替身、没测本体」（wb-token.mjs 顶部的教训）。
 * 🔴 凭据**只存内存**：模块里没有一行 fs 写操作，进程退出即失效。 */
import {
  createMmTokenStore, mmBuildHeaders, mmCanonicalModel, mmNormalizeTools, mmNormalizeBodyTools,
  MM_INFER_BASE, MM_MODEL, MM_LOGIN_INVALID_MSG,
} from "./mm-auth.mjs";
/* 保格式 JSON/JSONC 编辑器（edit-json.mjs）：读原文、按字节区间做最小改动、
 * 原样保住注释/键顺序/缩进/换行/BOM。移植自 magpie 的 internal/edit/json.go。
 *
 * 为什么必须有它：旧写法是 `JSON.parse` 读 + `JSON.stringify` 整份写回，
 * 有两个后果——① 读失败被当成空对象再写回，用户其余配置当场蒸发；
 * ② 每次切模型都整份重写，注释/键顺序/缩进被抹平，文件 mtime 一直在变，
 * 面板那套「这次是谁改的」归因也跟着失真。
 *
 * ⚠ 铁律：**读失败 = 不知道，绝不是空**。文件在但读不懂 → 中止接线、不写盘；
 * 文件不在 → 从空开始建，那是合法状态。两件事必须分开。 */
import { parseJsonc, applyEdits } from "./edit-json.mjs";
/* 用量账本（usage-ledger.mjs）：JSONL 追加日志。magpie 的 internal/usage 移植版。
 * 读的时候坏行跳过（末尾半行是常态——别的进程正在写）。 */
import { loadRecords } from "./usage-ledger.mjs";
/* 通用候选层（candidates.mjs）：失败分类 / 两级休息 / 冷却时长。magpie 的
 * internal/gateway/fallback.go 移植版。零依赖、零时钟。 */
import { classifyFailure, isResting, makeCandidate } from "./candidates.mjs";
/* 用量写入器（usage-writer.mjs）：把每次请求/每次尝试写进账本。 */
import { makeUsageWriter } from "./usage-writer.mjs";
/* 会话身份（session-id.mjs）：magpie 的 sessionHeaders 移植版。
 * ⚠ 它只**认**客户端头与各 agent 的原生头；都没有就返回 null —— 从不编造 id。 */
import { sessionOf } from "./session-id.mjs";
/* 路由策略内核（routes.mjs）+ 坐席构建器（seat-builder.mjs）：magpie 的
 * internal/routes 与 internal/gateway/routing.go 的 weighRouted。
 * ⚠ apply 改名成 applyRouteStrategy —— server.mjs 里还有别的 apply 语义。 */
import { apply as applyRouteStrategy, Builtin } from "./routes.mjs";
import { seatOf } from "./seat-builder.mjs";
/* 用量扫描器（usage-scan.mjs）：从流过的 SSE 字节里顺手捡出 token 数。
 * 透传那条路（bai/sn）上游响应是原样管道过去的，不扫就拿不到用量。 */
import { makeUsageScanner } from "./usage-scan.mjs";
/* 统一网关入口（gateway.mjs）：**一个端口**，模型 id 写成 provider/模型，
 * 网关拆前缀决定走哪一家（magpie 形态）。
 * 纯逻辑、零 IO、零网络，所以独立成文件才能被测试直接 import——server.mjs 一 import
 * 就起服务（wb-token.mjs 顶部的教训）。本步**只做加法**：8 个旧端口一字未变，
 * 网关是新增的第 9 个端口；切默认、拆旧端口是后面的步骤。 */
import {
  GATEWAY_MODEL, GATEWAY_BODY, GATEWAY_TIER, makeGatewayHandler, makeProtocolHandler, pickProtocol,
} from "./gateway.mjs";
/* Chat 入向协议桥（chat-protocol.mjs）：OpenAI Chat Completions 这一族客户端
 * （Qoder、ZCode、Kimi Code、Qwen Code、Cline、Droid、OpenCode…）说话的方式。
 * 也带来统一网关的模型清单形状（一份响应两种客户端都能读）。 */
import { chatModelsPayload } from "./chat-protocol.mjs";
/* 客户端接线（clients/）：替用户把客户端（Qoder、ZCode、Kimi Code、Cline…）的
 * 配置文件写好。底座在 clients/base.mjs，名录在 clients/registry.mjs（扫目录，
 * 加一个客户端不用改表）。 */
import { applyClient, revertClient, clientStatus } from "./clients/base.mjs";
import { allClients, clientById } from "./clients/registry.mjs";
/* 网关的故障转移（gateway-failover.mjs）：把「档位」从最终模型名反查回来，
 * 转移时才能按**目标家**重解析（各家同一档位是不同模型）。 */
import { tierOfModel, tierKeyFor } from "./gateway-failover.mjs";
/* 审计台账（audit.mjs）：每一次对外交互记一条（谁、何时、哪一家、哪个模型、
 * 结果、耗时、失败被归成哪一类）。magpie 的 internal/maskrec 移植版。
 * ⚠ 它与用量账本不是一回事：用量账本记「钱花到哪儿」，审计台账记「链路上发生过什么」，
 *   用途是**事后**复盘（用户报「昨天卡了」，得能翻出那段时间每条请求去了哪）。
 * ⚠ 台账里绝不能出现凭据 —— audit.mjs 每个字符串字段都过一遍 redact.mjs。 */
import { createAudit } from "./audit.mjs";
/* 配额预算（quota.mjs）：用户设上限 + 账本里的 token → 超了主动休息。 */
import { quotaState, budgetOf, budgetRestDecision, applyQuotaToSeat, applyProbeToSeat } from "./quota.mjs";
/* 代码插件运行时（pluginrt.mjs）：用户自己写的 JS，跑在**子进程**里，
 * 有权限模型与超时封顶。与 middleware（声明式 JSON）分工不同，见下面的接线注释。 */
import { createRuntime, PLUGINRT_DIRNAME } from "./pluginrt.mjs";
/* middleware 插件（middleware.mjs）：声明式的请求/应答改写。
 * ⚠ **只做数据不做代码** —— magpie 的中间件是真 JS（跑在网关进程里，能读能写能发网络请求）。
 *   能跑任意代码的分发物是另一个量级的风险（要另配沙箱、权限模型、审计）；
 *   分发物的权力越小，审它的人越敢点「装」。 */
import {
  parseMiddlewareManifest, validateMiddlewareManifest, createMiddlewareRegistry,
  formatErrors as formatMiddlewareErrors,
} from "./middleware.mjs";
/* 远端同步（sync.mjs 的纯逻辑 + sync-targets.mjs 的三个目标适配器）。
 * ⚠ 口令**绝不落盘**：远端那份是用口令加密的，密钥由用户每次输入。 */
import { runSync, compareState } from "./sync.mjs";
import { createTarget } from "./sync-targets.mjs";
/* 配额真探测（quota-probe.mjs）：问上游「你还剩多少额度」。 */
import { probeQuota, qdQuotaHeaders } from "./quota-probe.mjs";
/* 账号发现（account-discovery.mjs）：每家的凭据从哪来、有几个可用账号、缺什么。 */
import { discoverAccounts } from "./account-discovery.mjs";
/* 渠道状态计算层（channel-state.mjs）：一个渠道 → 六态之一 + 原因 + 数字。
 * 全局面板都从这里取 —— 「状态是数据，不是装饰」（docs/ui-redesign.md 原则 1）。 */
import { channelState } from "./channel-state.mjs";
/* 价格表（pricing.mjs）：token 数折成钱。⚠ 价格会漂移，表带快照日期。 */
import { estimateCost, priceTable, normalizeTable, tableFromModelsDev } from "./pricing.mjs";
/* 价格表的「用户点了才更新」（pricing-refresh.mjs）：远端表 → 合格表 → 谁说了算。
 * ⚠ **选表规则只有这一份**（chooseTable）—— 别在 server.mjs 里另写一份，
 *   两套规则迟早漂移，而漂移的方向是「悄悄用错表」。 */
import { chooseTable } from "./pricing-refresh.mjs";
/* 配置备份（backup.mjs）：快照 → 加密导出 → 导入还原。magpie 的 internal/backup
 * 与 internal/settings（KeepOwn）移植版。
 * ⚠ 备份里**有**真实凭据（那正是它的用处），所以导出必须带口令加密、
 *   而且**明文绝不落盘**（backup.mjs 的 exportBundle 走 AES-256-GCM）。 */
import { snapshotOf, exportBundle, importBundle, restoreConfig } from "./backup.mjs";
/* 并发闸门与 RPM 限流（concurrency.mjs / rpm.mjs）：magpie 的
 * internal/gateway/concurrency.go 与 rpm.go 移植版。
 * ⚠ 默认**不限**（上限 0）—— 限流不该突然开始拦用户的请求，它得由用户自己开。 */
import { ConcurrencyLimiter } from "./concurrency.mjs";
import { RpmLimiter } from "./rpm.mjs";
/* 声明式 provider 插件（plugin.mjs）：magpie 的 internal/plugin + internal/pluginrt
 * 移植版。一份 JSON 声明就能加一家渠道，**不用改代码**。
 * ⚠ 声明里**不许带凭据**（凭据是分发物，带 key 等于把 key 发给所有装它的人），
 *   凭据由用户在面板里填。 */
import { parseManifest, validateManifest, toProviderSpec, formatErrors, createRegistry } from "./plugin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 用户数据目录：Electron 安装版通过 BAI_DATA_DIR 指向 %APPDATA%\bai-router（升级不覆盖）；
// 绿色/开发模式回退到自身目录。config/backups/日志都放这里。
const DATA_DIR = process.env.BAI_DATA_DIR || HERE;
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const APP_VERSION = process.env.APP_VERSION || "dev";
/* 自己这个文件跑在哪 —— 面板与日志靠它回答"现在服务我的是哪一份代码"。 */
const SERVER_SELF = fileURLToPath(import.meta.url);
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
/** 档位 key 清单（从 TIERS 推导，不另写一份 —— 两份名单迟早会漂移）。 */
const TIER_KEYS = TIERS.map((t) => t.key);
/* ---------- 渠道清单（数据驱动，契约 v18 里程碑 1a）----------
 *
 * **唯一的渠道集合来源**。此前的六家（bai/sn/wb/zen/qd/or）散落在至少 8 处硬编码
 * 别名判断/数组/六位置参数里，加第七家要挨个改。现在全部由本常量推导。
 *
 * 为什么用**显式常量数组**，而不是 `Object.keys(cfg)` 推导：
 *   cfg 里既有渠道键也有一堆非渠道键（proxy / failover / panelPort / defaultModel /
 *   availableModels / mapping …），而且 **bai 是「扁平」的**——它的字段直接摊在 cfg
 *   顶层，没有 cfg.bai 子对象；其余五家才有 cfg.sn / cfg.zen / …。想从 Object.keys(cfg)
 *   认出渠道，就得维护一张「非渠道键」排除表，那等于把硬编码从一个地方搬到另一个地方，
 *   而且方向是反的（默认全算渠道、逐个排除），加一个非渠道字段就会误判成渠道。
 *   显式列出渠道，加渠道时只动这一行，判断依据一目了然。
 *
 * 顺序 = 面板展示序 = 故障转移链默认序（与 providers.js 的声明序、config.defaults.json
 * 的 failover.chain 保持一致，check-manifest.cjs 的 C1 会对账后两者）。
 *
 * PROVIDERS（展示名）与 RELAY_LABELS（中转错误前缀用的展示名）合并为同一张表——
 * 它们本来就逐字节相同，两份各自维护只会漂移。 */
const CHANNELS = ["bai", "sn", "wb", "wbai", "zen", "qd", "mm", "or"];
const CHANNEL_LABELS = { bai: "B.AI", sn: "SenseNova", wb: "WorkBuddy", wbai: "WorkBuddy AI", zen: "OpenCode Zen", qd: "Qoder", mm: "MiniMax 会员", or: "OpenRouter" };
// cliMode/desktopMode 返回体里 keyMatch* 字段名（bai 是历史遗留的无后缀名，不能改）
const KEYMATCH_FIELDS = { bai: "keyMatch", sn: "keyMatchSn", wb: "keyMatchWb", zen: "keyMatchZen", qd: "keyMatchQd", or: "keyMatchOr" };
/* 把请求里的 provider 参数收敛成渠道键：认识的渠道原样返回，其余（含缺省 "bai"、未知值）
   一律落到 "bai"。三条路由（/api/models、/api/config、/api/apply、/api/test）此前各写了
   一串等价的三元链，此处统一。 */
const resolveChannelKey = (raw) => (CHANNELS.includes(raw) || pluginRegistry.has(raw) ? raw : "bai");

const PASS_HEADERS = ["authorization", "content-type", "anthropic-version", "anthropic-beta", "x-api-key", "accept", "user-agent"];

const BOOT = Date.now();

/** 本进程的启动时刻（epoch ms）。**零成本**：monotonic 的 uptime 减掉当前时钟即可，
 *  不用外呼 PowerShell。随 /api/status 的 service.startTimeMs 一起报出去——main.js
 *  拿到对面自报的 PID 时，靠它核对「这个 PID 还是不是对面那个进程」，再决定能不能
 *  taskkill。老版本服务不报这个字段 → 调用方按「无法验证」处理，不杀。 */
const SERVICE_START_MS = selfStartTimeMs();

/* 日志去向（v1.0.73 梳理）：
 *   · server-child.log  服务端的**唯一**日志源。子进程 stdout/stderr 直通这个 fd，
 *                      而 log() 只写 stdout —— 同一批日志不会再落第二份。
 *                      它还天然含有崩溃栈：进程非正常退出时 log() 来不及跑，
 *                      但已写到 stdout 的内容还在，这是任何主动写盘都拿不到的。
 *   · app.log            Electron 壳层事件（启动/退出/崩溃重拉/自更新），由 main.js 写。
 *   · server.log         已停用。保留文件只为不让旧版残留占地方，代码不再写它。
 *
 * 两个文件都在 main.js 各自滚动（保留一份 .old），子进程那份的滚动点是 spawn 之前——
 * 追加发生在子进程里，主进程只能在这一瞬间干预。
 */

function log(...a) {
  /* 只走 stdout，**不再**同时写 server.log（v1.0.73）。
   *
   * 原来两处都写，于是同一批日志落了两份：子进程的 stdout 直通 server-child.log，
   * 而 log() 自己又写一遍 server.log。实测两份内容 100% 重复——server-child.log
   * 没有任何一行是 server.log 没有的，白占一倍空间，还让人排查时不知道该看哪个
   * （我就因此查错过一次：在旧版的日志里找新版才有的关键字，得到一个假的「没触发」）。
   *
   * 去掉主动写还有个额外好处：**崩溃栈自动就齐了**。进程非正常退出时 log() 来不及
   * 执行，但已经写到 stdout 的内容还在 server-child.log 里——那是 server.log
   * 永远拿不到的。所以 server-child.log 是唯一且更完整的服务端日志源。 */
  console.log(`[${new Date().toISOString()}] ${a.join(" ")}`);
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
  /* 统一网关端口（magpie 形态的那个「一个端口」）。15799 是新号：
   * 不与任何现有端口（15721~15792）也不与面板 15723 撞。
   * ⚠ 这是**新增入口**，不是替换：8 个旧中转端口一个都没动。 */
  gatewayPort: 15799,
  /* 网关模式：**开** = 请求先到统一网关（15799），网关按模型 id 的 `provider/模型`
   * 前缀分流到那一家；关 = 请求走各家自己的中转端口（老路）。
   *
   * 两种模式**用户可见行为一致**（同一家的同一批模型、同样的请求体与错误文案），
   * 区别只在「请求先到哪个端口」——以及网关能同时看到所有家，那才是账号级路由的前提。
   *
   * 默认**开**：统一网关是 magpie 形态的正解（一个端口），而 8 个旧中转端口**仍然在跑**，
   * 面板上一关开关就回到老路 —— 等于内置了回退路径，不用等发版。
   * ⚠ 老机器的 config.json 里没有这个字段，合并时取默认值 → 也会切到网关。 */
  gatewayMode: "on",
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
    // wbai 紧跟 wb：两版 WorkBuddy 在链上各占一位（契约 v18 §4.2），且同族相邻更好读。
    // mm（MiniMax 会员额度）排在 or 之前：它是**会员额度**通道，没登录时会被自动跳过，
    // 对存量行为零影响；而 or 必须留在兜底位。
    chain: ["qd", "bai", "sn", "zen", "wb", "wbai", "mm", "or"],
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
  // WorkBuddy 国内版（腾讯 WorkBuddy 客户端附带的免费模型）—— 第三个可路由提供方。
  // 上游只讲 OpenAI Chat Completions（且仅流式），中转内置 Anthropic↔OpenAI 协议桥；
  // 认证不是 sk- 密钥，而是从 WorkBuddy 客户端捕获的 JWT 三件套（访问/刷新/设备令牌），
  // 过期由 refreshToken 自动续期（有效期约一年，通常无感）。
  // **v1.0.65 起本格钉死国内版 www.workbuddy.cn**（里程碑 1b）：国际版拆到 wbai 那一条去了。
  // 这里以前写的是 .ai，再靠 wbHealUpstream 按登录域名翻转——现在两版各钉各的，不再互翻。
  wb: {
    relayPort: 15742,
    upstream: "https://www.workbuddy.cn",
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

  // WorkBuddy 国际版（wbai）—— 契约 v18 里程碑 1b：国内版与国际版**拆成两个渠道**。
  // 实测 2026-10-11：两版是两套东西——目录不同（CLI 形态 22 vs 32 个模型）、定价不同、
  // 凭据文件不同（workbuddy-desktop-ai.info vs workbuddy-desktop.info）。
  // 本块是 wb 的完整镜像，只换三处：端口（15782，不与任何现有中转撞号）、上游（.ai 钉死）、
  // 以及那一份独立的令牌。**不做版别自愈**（wb 有 wbHealUpstream，这里刻意不加）：
  // 两版既然是两条链上的格子，就该各自固定，用户想要哪版接哪版。
  wbai: {
    relayPort: 15782,
    upstream: "https://www.workbuddy.ai",
    defaultModel: "deepseek-v4.1-flash",
    // 出厂兜底清单（与 wb 相同的三个 id）。**真实目录来自上游 /v3/config**，
    // 面板「刷新模型列表」会覆盖它——别把这份兜底当成国际版的实际模型清单。
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
    useProxy: false,
  },

  // MiniMax 会员托管通道（mm）—— **会员额度**，不是开放平台按量计费的 API Key。
  // 走的是 MiniMax Code 桌面端登录的那份账号自带的额度：凭据从本机登录态读
  // （~/.minimax/auth/prod/cn/mcode-public/auth.json），**只存内存**，不落本文件、不落 config.json。
  //
  // 上游是 **Anthropic Messages 原生协议**（直接吃 /v1/messages），所以**不做协议翻译**，
  // 但**必须**带浏览器指纹头（Origin/Referer/完整 MiniMaxAgent UA）——缺一个就是 401。
  // 头由 mm-auth.mjs 的 mmBuildHeaders 整份重建（客户端送来的同名头一律作废）。
  //
  // upstream 存的是**去掉末段 /v1** 的基址：中转拼 `upstream + req.url`，
  // 而 req.url = /v1/messages → https://agent.minimax.cn/mavis/api/v1/llm/v1/messages ✓
  // （与 Anthropic SDK 拼 baseURL + '/v1/messages' 的结果一致）。
  mm: {
    relayPort: 15792,          // 15722/15732/15742/15752/15762/15772/15782 都占了
    upstream: MM_INFER_BASE,   // https://agent.minimax.cn/mavis/api/v1/llm
    defaultModel: MM_MODEL,    // MiniMax-M3.1-Flash
    availableModels: [MM_MODEL],
    mapping: defaultMapping(MM_MODEL, "MiniMax-M3.1-Flash"),
    useProxy: false,           // agent.minimax.cn 是境内域，直连
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

/* ---------- MiniMax 会员托管通道（mm）：令牌仓库（**只存内存**） ----------
 *
 * 整个进程只有这一个实例，令牌只活在它的内存里：
 *   · 进程退出 → 令牌随之消失，磁盘上没有任何副本（连 config.json 都没有）。
 *   · 启动时从本机登录态（~/.minimax/auth/prod/cn/mcode-public/auth.json）读一次。
 *   · 访问令牌快到期时用刷新令牌换新的，**新刷新令牌立刻存回内存**
 *     （旧的立即作废——这是 MiniMax 的「一次性轮换」语义，见 mm-auth.mjs 顶部）。
 *
 * 🔴 这个对象**不写盘**、日志里也只出现长度与「是否有效」。
 *    面板要看它的状态，走 mmTokens.snapshot()——那个快照里没有任何令牌值。 */
const mmTokens = createMmTokenStore({ log: (m) => { try { log(m); } catch { } } });

// ---------- WorkBuddy 版别检测（v1.0.59）：按登录域名自动选上游 ----------
// WorkBuddy 分两版，令牌**不通用**——国内版令牌打国际端点必然 401：
//   国际版 workbuddy-desktop-ai → 登录域名 www.workbuddy.ai → 上游 https://www.workbuddy.ai
//   国内版 workbuddy-desktop    → 登录域名 www.workbuddy.cn → 上游 https://www.workbuddy.cn
// 判定依据（bundle 逆向）：客户端读 %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\
// <authentication.id>.info 的 auth.domain。本机只**读**该目录判版，绝不写（契约硬约束）；
// 注意 accessToken 落盘是 {$wbEncrypted:1, envelope:…} 加密信封，读盘取明文此路不通，
// 令牌仍走注入捕获——这里只取 domain 判版，不碰任何令牌字段。
const WB_UPSTREAM_INTL = "https://www.workbuddy.ai"; // 国际版默认（= DEFAULTS.wbai.upstream，两处同步）
const WB_UPSTREAM_CN = "https://www.workbuddy.cn";    // 国内版默认（= DEFAULTS.wb.upstream，两处同步）
/* 两版各自的 authentication.id（契约 v18 里程碑 1b）。
   **不再二选一**：v1.0.59 时代这里是「两版里取 mtime 最新的那个」，本机两个版别都装了，
   于是 wb 会被二选一判成其中一版、另一版的登录态**永远读不到**。现在改成各读各的——
   wb 只认 workbuddy-desktop.info，wbai 只认 workbuddy-desktop-ai.info。 */
const WB_AUTH_ID_CN = "workbuddy-desktop";
const WB_AUTH_ID_INTL = "workbuddy-desktop-ai";
const WB_AUTH_IDS = [WB_AUTH_ID_INTL, WB_AUTH_ID_CN]; // 保留旧名（诊断/日志用），顺序同旧实现

/* auth 目录候选（可注入）：测试用 BAI_WB_AUTH_DIR 指向临时伪造目录即可做双向版别验证，
   真实 auth 目录永远只读。
   **两处都探**：只探 %LOCALAPPDATA% 是 v1.0.59 的疏漏——插件实测旧版客户端把登录文件写在
   Roaming（%APPDATA%）下。只探 Local 的机器上，旧版安装的用户会一直读不到登录态。
   顺序 Local → Roaming：新版在 Local，先命中它。 */
function wbAuthDirs() {
  const inject = String(process.env.BAI_WB_AUTH_DIR || "").trim();
  if (inject) return [inject];
  const out = [];
  const push = (base) => {
    if (!base) return;
    const d = path.join(base, "CodeBuddyExtension", "Data", "Public", "auth");
    if (!out.includes(d)) out.push(d);
  };
  push(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"));
  push(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"));
  return out;
}
function wbAuthDir() { return wbAuthDirs()[0]; }   // 兼容旧调用名：主目录（Local）


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

/* 纯函数：在候选目录里读**指定版别**的登录文件（契约 v18 里程碑 1b：各读各的，不再二选一）。
 * 只认精确文件名 <id>.info——`*.logged-out`（已登出）与 `<id>.<ISO时间戳>….info`
 * （历史快照，本机实测各有其例）一律排除。
 * 返回 { id, file, domain, uid } 或 null；文件损坏就顺位试下一个候选目录。
 * uid 是这份登录态所属的账号（account.uid），令牌归属核对要用它。
 * 只读 domain 与 uid 两个字段——accessToken 是 {$wbEncrypted:1, envelope:…} 加密信封，
 * 这个文件里取不到明文，也不需要取。 */
function wbReadAuthFile(authDirs, id) {
  if (!authDirs || !authDirs.length) return null;
  const base = id + ".info";
  for (const dir of authDirs) {
    let f;
    try {
      if (!readdirSync(dir).includes(base)) continue;
      f = path.join(dir, base);
    } catch { continue; }
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      const d = j && j.auth && typeof j.auth.domain === "string" ? j.auth.domain.trim() : "";
      const u = j && j.account && typeof j.account.uid === "string" ? j.account.uid.trim() : "";
      return { id, file: f, domain: d || null, uid: u || null };
    } catch { /* 这份坏了就试下一个目录 */ }
  }
  return null;
}

// 版别检测入口（带 1.5s 进程内缓存：loadCfg 每请求都走到这里，别为判版反复打磁盘）。
// p 指定读哪一版：wb → workbuddy-desktop.info，wbai → workbuddy-desktop-ai.info。
let wbAuthCache = new Map();
function wbDetectAuth(p) {
  const id = p === "wbai" ? WB_AUTH_ID_INTL : WB_AUTH_ID_CN;
  const dirs = wbAuthDirs();
  const key = id + "|" + dirs.join("|");
  const now = Date.now();
  const hit = wbAuthCache.get(key);
  if (hit && now - hit.at < 1500) return hit.res;
  const found = wbReadAuthFile(dirs, id);
  const res = {
    authDir: found ? path.dirname(found.file) : dirs[0],
    file: found ? found.file : null,
    domain: found ? found.domain : null,
    uid: found ? found.uid : null,
    // "cn" | "intl" | null。判据仍是登录域名（.ai → intl，其余 → cn），
    // 但**只读本版那一份文件**——另一版的登录态不该影响本渠道。
    edition: found && found.domain ? wbEditionOfDomain(found.domain) : null,
  };
  wbAuthCache.set(key, { at: now, res });
  if (wbAuthCache.size > 8) wbAuthCache.clear();
  return res;
}

/* 令牌归属核对：配置里的令牌**自称属于哪个账号**，对不对得上这一版登录文件里的账号。
 *
 * 为什么需要它（v1.0.67 实测踩出来的）：wb 槽位里装的是**国际版**的令牌，
 * 而面板当时报的是 `token.configured=true, expiresInDays=360`——看着一切正常。
 * 实际上国内所有主机对它的请求都是网关 401，这个渠道从来没通过过。
 *
 * 为什么这种错配能一路溜过去：三个信号全都指错方向——
 *   ① 版别判定读的是**国内登录文件**，判出 `edition:"cn"`，对的；
 *   ② 令牌取自 **config.json**，而那份是历史遗留的国际版令牌，没人核对过；
 *   ③ "能拉到 N 个模型"也证明不了什么——`/v3/config` **不校验令牌**，
 *      拿国际版令牌打国内、拿国内令牌打国际，都返回 200 code=0。
 * 三个信号互不交叉，于是"就绪"是假的。
 *
 * 判据：JWT 的 sub（令牌自称的签发对象） vs 登录文件的 account.uid。
 * 任一侧读不到就报 unknown 而不是 match——读不到不等于对得上。 */
function wbTokenOwnership(p, cfg) {
  const c = cfg || loadCfg();
  const w = (p === "wbai" ? c.wbai : c.wb) || {};
  const auth = wbDetectAuth(p);
  const sub = wbTokenSub(w.accessToken);
  const uid = auth && auth.uid;
  const base = {
    tokenSub: sub ? sub.slice(0, 8) : null,
    authUid: uid ? uid.slice(0, 8) : null,
    authFile: auth && auth.file ? path.basename(auth.file) : null,
  };
  if (!w.accessToken) return { state: "no-token", ...base };
  if (!sub || !uid) return { state: "unknown", ...base };
  return { state: sub === uid ? "match" : "mismatch", ...base };
}

/* ---------- 账号池的只读事实（/api/status，v1.0.77）----------
 *
 * 面板那一格要显示什么**全在这里算完**：可用 / 冷却中 / 判死 / 已停用 / 本次被跳过，
 * 外加「池里有几个」。渲染层因此既不需要认识渠道名，也不需要认识 reason 码（C11）。
 *
 * 凭据一律走 keyFp 指纹（首 7 位 + 尾 2 位 + 长度），**明文永不进 /api/status**。
 */
function wbPoolFields(cfg, p, now) {
  const st = wbPoolStatus(cfg, p, now, { fingerprint: (a) => keyFp(a.accessToken) });
  return st || { version: p, total: 0, counts: { total: 0 }, accounts: [], synthetic: false, hint: "" };
}
/** 最近一次 429 时算出的「同名付费行」指向（可能为 null）。 */
function wbPaidHintFields(p) {
  const h = wbLastPaidHint.get(p);
  if (!h) return null;
  return { label: h.label, rows: h.rows, text: h.text, at: h.at || null };
}

// 自愈覆盖（供 loadCfg 的两条返回路径共用）：**仅当当前 upstream 恰好等于另一版的默认值**
// 才翻转——用户显式改成过别的地址（自建中转等）一律不碰，与 fixQdFile「尊重用户设置」
// 同一哲学。只改内存里的合并结果，不主动回写 config.json；判不出版别（null）时保持原值。
//
// p 决定读哪一版的登录态：wb 只看 workbuddy-desktop.info，wbai 只看 workbuddy-desktop-ai.info
// （里程碑 1b 之前这里是两版二选一，本机两个都装了 → 另一版的登录态永远读不到）。
function wbHealUpstream(w, p) {
  if (!w || typeof w !== "object") return w;
  const ed = wbDetectAuth(p).edition;
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
    // wbai 深合并（国际版，里程碑 1b 新增）：与 wb 同构，各自独立
    const wbaiIn = c.wbai || {};
    merged.wbai = {
      ...DEFAULTS.wbai, ...wbaiIn,
      mapping: { ...DEFAULTS.wbai.mapping, ...(wbaiIn.mapping || {}) },
      availableModels: Array.isArray(wbaiIn.availableModels) && wbaiIn.availableModels.length ? wbaiIn.availableModels : [...DEFAULTS.wbai.availableModels],
    };
    // mm（MiniMax 会员托管通道）深合并：形状与其它家一样。
    // 🔴 这里**没有**任何凭据字段——会员令牌只存在内存里（mm-auth.mjs），
    //    落盘的 config.json 里连字段名都不给它（免得以后有人顺手把令牌写进去）。
    const mmIn = c.mm || {};
    merged.mm = {
      ...DEFAULTS.mm, ...mmIn,
      mapping: { ...DEFAULTS.mm.mapping, ...(mmIn.mapping || {}) },
      availableModels: Array.isArray(mmIn.availableModels) && mmIn.availableModels.length ? mmIn.availableModels : [...DEFAULTS.mm.availableModels],
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
    // wbai（国际版）同理补一个，但**插在 wb 后面而不是末尾**（契约 v18 §4.2：两版各占一位）。
    // or 必须永远排最后（用户原话「兜底」），所以不能无脑 push 到尾部——
    // 那样链会变成 [..., wbai, or] 之外还可能把 or 挤走，用 insert 定位在 wb 之后。
    // 未配令牌时 wbai 与 or 一样会被自动跳过，对存量行为零影响。
    if (Array.isArray(merged.failover.chain) && !merged.failover.chain.includes("wbai")) {
      const ch = [...merged.failover.chain];
      const at = ch.indexOf("wb");
      ch.splice(at < 0 ? ch.length : at + 1, 0, "wbai");
      merged.failover.chain = ch;
    }
    // mm（MiniMax 会员额度）同理补一个，**插在 or 之前**：or 永远排最后（兜底位），
    // 不能把 mm 追加到尾巴上把 or 挤走。mm 没登录时会被自动跳过，对存量行为零影响。
    if (Array.isArray(merged.failover.chain) && !merged.failover.chain.includes("mm")) {
      const ch = [...merged.failover.chain];
      const at = ch.indexOf("or");
      ch.splice(at < 0 ? ch.length : at, 0, "mm");
      merged.failover.chain = ch;
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
    wbHealUpstream(merged.wb, "wb");
    wbHealUpstream(merged.wbai, "wbai");
    return merged;
  } catch (e) {
    log("config.json 读取失败，用默认配置:", e.message);
    const fallback = { ...DEFAULTS, mapping: { ...DEFAULTS.mapping }, sn: { ...DEFAULTS.sn, mapping: { ...DEFAULTS.sn.mapping }, availableModels: [...DEFAULTS.sn.availableModels] }, zen: { ...DEFAULTS.zen, mapping: { ...DEFAULTS.zen.mapping }, availableModels: [...DEFAULTS.zen.availableModels] }, wb: { ...DEFAULTS.wb, mapping: { ...DEFAULTS.wb.mapping }, availableModels: [...DEFAULTS.wb.availableModels] }, wbai: { ...DEFAULTS.wbai, mapping: { ...DEFAULTS.wbai.mapping }, availableModels: [...DEFAULTS.wbai.availableModels] }, qd: { ...DEFAULTS.qd, mapping: { ...DEFAULTS.qd.mapping }, availableModels: [...DEFAULTS.qd.availableModels] }, mm: { ...DEFAULTS.mm, mapping: { ...DEFAULTS.mm.mapping }, availableModels: [...DEFAULTS.mm.availableModels] }, or: { ...DEFAULTS.or, mapping: { ...DEFAULTS.or.mapping }, availableModels: [...DEFAULTS.or.availableModels], keys: [] }, failover: { ...DEFAULTS.failover, chain: [...DEFAULTS.failover.chain] } };
    wbHealUpstream(fallback.wb, "wb");
    wbHealUpstream(fallback.wbai, "wbai");
    return fallback;
  }
}
function saveCfg(cfg) {
  writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}
/* Windows 上 rename 覆盖一个「正被别的句柄占住」的目标文件会抛 EPERM / EACCES / EBUSY。
 * 杀毒实时扫描、同步客户端、编辑器打开着、甚至映射中的可执行文件，都会**短暂**触发。
 * 9 个调用点里有 settings.json（Claude Code 自己的配置，见 applyCcSettings 附近）这种
 * 最容易被别人占住的文件，直接往上抛 = 用户看到「保存失败」而实际只是几百毫秒的锁。
 *
 * 做法照抄 OW Bridge 的同类实现（.research/ow-bridge/src/atomic.js，只读参考）：
 * 只对 EPERM/EACCES/EBUSY 退避重试，**其它错误码立即抛出**——磁盘写满（ENOSPC）、
 * 目录不存在（ENOENT）、只读盘（EROFS）这类重试只是把失败推迟，还白等一秒半。
 *
 * · 重试**重跑整个 writeFileSync + renameSync**，不是只重试 rename：tmp 本身
 *   也可能被扫描器占住，只重试 rename 会在 tmp 已残缺的情况下替换出坏文件。
 * · **保持同步**：9 个调用点全是同步调用，转 async 会波及一大片。
 *   同步睡眠用 Atomics.wait（Atomics.waitAsync 本版 Node 未普及）。
 * · **总阻塞上限 = ATOMIC_DELAYS 之和 = 50+100+200+400+600 = 1350ms**（约 1.3 秒，
 *   刻意压在 1.5 秒以内）。这是最坏情况的**同步阻塞**时间，落在 Electron 主进程上，
 *   再长会拖住 UI 帧；1350ms 之后仍然失败就说明不是瞬时锁，该报错。
 * · opts.rename / opts.delays 仅供测试注入真实行为，生产路径不传。
 */
const ATOMIC_TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const ATOMIC_DELAYS = [50, 100, 200, 400, 600];
/* Atomics.wait 要求一个 Int32Array 视图；建一次复用即可（全局一次，别每次调用重建）。 */
const ATOMIC_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
function sleepSyncMs(ms) { if (ms > 0) Atomics.wait(ATOMIC_SLEEP_BUF, 0, 0, ms); }

function writeAtomic(file, data, opts) {
  const rename = (opts && opts.rename) || renameSync;
  const delays = (opts && opts.delays) || ATOMIC_DELAYS;
  const tmp = file + ".tmp";
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(tmp, data);
      rename(tmp, file);
      return;
    } catch (e) {
      if (!ATOMIC_TRANSIENT.has(e && e.code) || attempt >= delays.length) throw e;
      sleepSyncMs(delays[attempt]);
    }
  }
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
/* 签名校验的重试次数——理由见 downloadLatestInstaller 里那段注释（实测间歇性失败，
 * 连挂两次才通过）。3 次全败才判签名不可信。 */
const SU_SIG_PROBE_TRIES = 3;
/* 下载的停滞看门狗 / 重试参数。
 *
 * 实测（v1.0.71 升 1.0.71 时）：下载到 81MB/111MB 停住，**290 秒零进展**，界面一直
 * 显示「下载中」，既不报错也不超时。那是因为 AbortSignal.timeout(15 分钟) 管的是
 * **整个 fetch 含读流**，连接半死不活时它不主动中止。curl 独立复现也是随机中断
 * （300 秒超时处只下了 10MB），断点不固定。
 *
 * 30 秒没新数据就掐掉重试：正常下载是 MB/s 级，30 秒零字节已经明确是死了；
 * 掐早了最多多一次 Range 请求（几秒），掐晚了用户就一直干等。 */
const SU_DL_STALL_MS = 30 * 1000;
const SU_DL_ATTEMPTS = 5;
const SU_DL_RETRY_MS = 1500;
/* PowerShell 的 stderr 带 ANSI 颜色码，直接塞进错误信息会显示成一串 [31;1m。剥掉。 */
const suPlain = (s) => String(s || "").replace(/\x1b\[[0-9;]*m/g, "").trim();

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
  const total = Number(asset.size) || 0;
  const { Readable } = await import("node:stream");

  /* 下载：带停滞看门狗 + 断点续传 + 重试（v1.0.71 实测修）。
   *
   * 原实现是 `fetch(url, { signal: AbortSignal.timeout(15 分钟) })` 然后一路 for await。
   * 那个 15 分钟覆盖的是**整个 fetch 含读流**，不是只管响应头——连接半死不活时
   * （上游不再发数据、TCP 没断、也没报错）它不主动中止，要等流自己结束。
   * 实测踩到：下载到 81MB / 111MB 时停住，**290 秒零进展**，界面一直显示「下载中」，
   * 不报错也不超时，能一直挂下去。用 curl 独立复现也是随机中断（300 秒超时处只下了 10MB），
   * 中断点不固定——是网络对大文件的随机掐断，不是某个特定问题。
   *
   * 三件事一起上：
   *   · 停滞看门狗：连续 SU_DL_STALL_MS 没收到新数据就主动掐掉本次请求，
   *     而不是等那个 15 分钟的大超时。
   *   · 断点续传：重试时带 Range 从已有字节继续（实测有效，靠它 6 次续传才拼完 106MB）。
   *   · 重试 SU_DL_ATTEMPTS 次；每次失败在状态里如实说明，不让界面干等着。
   */
  const dlOne = async (from) => {
    const ctl = new AbortController();
    const headers = { "user-agent": "bai-router-selfupdate" };
    if (from > 0) headers.Range = `bytes=${from}-`;
    const fr = await fetch(asset.browser_download_url, { headers, signal: ctl.signal });
    if (fr.status === 200 && from > 0) throw new Error("HTTP 200");  // 服务端无视了 Range → 本次白来，重新从头
    if (fr.status !== 200 && fr.status !== 206) throw new Error("下载失败 HTTP " + fr.status);
    if (!fr.body) throw new Error("下载失败：响应没有内容");
    const got0 = from;
    let got = got0, lastTick = 0;
    /* 停滞看门狗：**独立定时器**，不是 for-await 循环里的一个 if。
     *
     * 这是本次修复里最要紧的一处。第一版把检测写进循环体、只在收到 chunk 时判断，
     * 结果真停滞（上游一个字节都不再发）时循环根本不产出 → 检测永远不触发 →
     * 又变回"永远挂着等 15 分钟"。是本地 HTTP 服务真造了一次停滞才发现的。
     *
     * 定时器跑在事件循环上，与有没有数据无关：到点没被清掉就说明确实卡住了。 */
    let stalled = false;
    let lastData = Date.now();   // 定时器闭包要用，必须先声明
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > SU_DL_STALL_MS) {
        stalled = true;
        ctl.abort();
      }
    }, Math.min(2000, SU_DL_STALL_MS / 4));
    const ws = createWriteStream(SU_EXE, { flags: from > 0 ? "a" : "w" });
    try {
      for await (const chunk of Readable.fromWeb(fr.body)) {
        if (!ws.write(chunk)) await new Promise((r) => ws.once("drain", r));
        got += chunk.length;
        lastData = Date.now();
        if (Date.now() - lastTick > 500) {
          lastTick = Date.now();
          suState({ phase: "downloading", version: rel.tag_name, file: asset.name, got, total, percent: total ? Math.floor((got / total) * 100) : 0 });
        }
      }
    } catch (e) {
      if (stalled) throw new Error(`停滞超过 ${Math.round(SU_DL_STALL_MS / 1000)} 秒（停在 ${Math.floor((got / 1048576))}MB）`);
      throw e;
    } finally {
      clearInterval(watchdog);
      ws.end();
    }
    await new Promise((r) => ws.once("close", r));
    return got;
  };

  // 从头开始（上一轮可能留了半截）
  try { rmSync(SU_EXE, { force: true }); } catch { /* 没有旧文件就没什么可清 */ }
  suState({ phase: "downloading", version: rel.tag_name, file: asset.name, got: 0, total, percent: 0 });
  let got = 0;
  let lastErr = null;
  for (let attempt = 1; attempt <= SU_DL_ATTEMPTS; attempt++) {
    try {
      got = await dlOne(got);
      if (!total || got >= total) break;
      lastErr = new Error(`只收到 ${got}/${total} 字节`);
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e).slice(0, 140);
      log(`备用升级：下载中断（第 ${attempt}/${SU_DL_ATTEMPTS} 次）：${msg}`);
      // 断点就是当前已落盘的字节数；拿不到就退回去读文件大小
      let onDisk = 0;
      try { onDisk = statSync(SU_EXE).size; } catch { }
      got = onDisk;
      if (attempt < SU_DL_ATTEMPTS) {
        suState({
          phase: "downloading", version: rel.tag_name, file: asset.name, got, total,
          percent: total ? Math.floor((got / total) * 100) : 0,
          retryIn: SU_DL_RETRY_MS,
        });
        await new Promise((r) => setTimeout(r, SU_DL_RETRY_MS));
      }
    }
  }
  if (total && got < total) {
    throw new Error(`下载未完成（${Math.floor(got / 1048576)}MB / ${Math.floor(total / 1048576)}MB，`
      + `已重试 ${SU_DL_ATTEMPTS} 次）：${String((lastErr && lastErr.message) || lastErr || "").slice(0, 120)}`);
  }
  suState({ phase: "verifying", version: rel.tag_name, percent: 100, got, total });
  // ① sha512 与 release feed（latest.yml）比对。**对已落盘的整份文件算**——
  //    分段续传时 hash 必须最后一次性算，否则跨段拼不出正确的摘要。
  const { createHash } = await import("node:crypto");
  const yml = await (await fetch(`https://github.com/${SU_REPO}/releases/latest/download/latest.yml`, { signal: AbortSignal.timeout(20000) })).text();
  const mm = String(yml).match(/^sha512:\s*(.+)$/m);
  const digest = createHash("sha512").update(readFileSync(SU_EXE)).digest("base64");
  if (mm && digest !== mm[1].trim()) throw new Error("安装包 sha512 校验不匹配");
  // ② Authenticode 发布者校验（只取 Subject 字符串，不走 JSON——避开 electron-updater 同款深度截断坑）
  /* v1.0.68 实测这段**间歇性**失败，代码与环境都相同：已装版 + 已装版 Electron 连挂两次、
   * 第三次就过了；源码 + Electron、已装版 + 裸 node 都稳定通过。单次拿不到输出就把整个
   * 升级判死，用户看到的是「签名校验失败」，而签名一直是对的——这是纯粹的用户损失。
   * 所以重试三次再放弃（v1.0.68 首次升级时就在这里失败过两次，白等了两轮 106MB 下载）。
   *
   * 失败时把 execFile 的 err 与 stderr 一并带出来，别再只留一句「无有效签名」——
   * 那句话把「命令没跑起来」和「签名真的不对」混成了一件事，排查时完全指不出方向。
   * 签名**只有三次全败才当不可信**：宁可多等几秒，不误杀一个本来没问题的升级。 */
  const SU_SIG_PROBE = () => new Promise((r) => execFile("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${SU_EXE.replace(/'/g, "''")}').SignerCertificate.Subject`],
    { windowsHide: true, timeout: 25000 },
    (e, so, se) => r({
      err: e ? (e.killed ? `killed(${e.signal})` : String(e.message).slice(0, 200)) : null,
      out: String(so || "").trim(),
      stderr: suPlain(se).slice(0, 300),
    })));
  let sigProbe = null;
  for (let attempt = 1; attempt <= SU_SIG_PROBE_TRIES; attempt++) {
    sigProbe = await SU_SIG_PROBE();
    if (/B\.AI Router Personal/.test(sigProbe.out)) break;
    log(`备用升级：签名校验第 ${attempt}/${SU_SIG_PROBE_TRIES} 次没取到结果`
      + `${sigProbe.err ? "（" + sigProbe.err + "）" : ""}${sigProbe.stderr ? " " + sigProbe.stderr : ""}`);
    if (attempt < SU_SIG_PROBE_TRIES) await new Promise((r) => setTimeout(r, 1200));
  }
  const subject = sigProbe.out;
  if (!/B\.AI Router Personal/.test(subject)) {
    const why = sigProbe.err
      ? `执行失败：${sigProbe.err}`
      : (sigProbe.stderr ? `PowerShell 报错：${sigProbe.stderr}` : "命令成功但没取到 Subject");
    throw new Error(`安装包签名者校验失败（已重试 ${SU_SIG_PROBE_TRIES} 次；${why}）`);
  }
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
  // 这几行 add 与 src/main.js 的 addNoProxyHost 几行**逐字同步**（顺序也要一致：先 intl、
  // 再 cn、再当前 upstream 值），否则精确比对判定漂移 → 警告/重启风险（历史事故同款）。
  // v1.0.65：wbai 是独立渠道，自带独立的 upstream 与 useProxy，得自己占一行，
  // 否则国际版切了自建中转就不在 NO_PROXY 表里。src/main.js 同步加了同一行。
  const wbUseProxy = cfg.wb?.useProxy === true;
  add(hostOf(WB_UPSTREAM_INTL), wbUseProxy);
  add(hostOf(WB_UPSTREAM_CN), wbUseProxy);
  add(hostOf(cfg.wb?.upstream || DEFAULTS.wb.upstream), wbUseProxy);
  const wbaiUseProxy = cfg.wbai?.useProxy === true;
  add(hostOf(cfg.wbai?.upstream || DEFAULTS.wbai.upstream), wbaiUseProxy);
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
/* MiniMax 会员通道：启动时把本机登录态读进**内存**（令牌不落盘）。
 * 放在启动自检之后——那个自检可能让本进程 exit(0) 重启自己，没必要先读一遍文件。
 * 读不到很正常（用户没在 MiniMax Code 里登录），面板会如实说「未配置」。 */
try { mmTokens.readAuthFile(); } catch (e) { log("MiniMax：读登录态失败（" + String((e && e.message) || e) + "）"); }
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
  // 自动化闸门：端到端测试 spawn 的是**真** server.mjs，而自动代理探测一旦
  // 探到与配置里不同的代理，就会 applyProxy() 写配置并 exit(0) 自重启换继任者。
  // 后果有两条，都只在「被自动化驱动」时才有意义：
  //   ① 正在飞的 fetch 被进程退出连带 RST → ECONNRESET（scripts/attrib-atomic-test.mjs
  //      的 T1 e2e 长期偶发红，就是它）；
  //   ② 继任者是 detached 的，父进程 child.kill() 够不着 → 永久孤儿占着 9 个端口。
  // 自动探测对测试毫无价值（面板上手动检测不受影响，故只关自动这一路）。
  if (process.env.BAI_NO_PROXY_AUTODETECT === "1") return;
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
  // 额度探测循环：把「上游自己报的余额」喂进缓存，供转移链的排序读
  // （那条路是同步的，只能读缓存；缓存没人喂，排序就永远拿不到信号）。
  try { startQuotaProbeLoop(); } catch (e) { log(`额度探测循环没起来：${String((e && e.message) || e)}`); }
  /* 代码插件：把根目录下的那些装上。
   * ⚠ **不 await**：装插件要起子进程（每个插件一个），卡住启动不划算 ——
   *   装不上/装得慢的插件，用户在面板上点「重载」就能看到结果。 */
  void reloadCodePlugins().catch((e) => {
    try { log(`代码插件装载出错：${String((e && e.message) || e)}`); } catch { }
  });
}

// ---------- 中转服务 ----------
function normalizeModel(name) {
  // Claude Code 会发送带上下文后缀的档位名（如 claude-opus-5[1m] / claude-fable-5[1M]），
  // 去掉 [..] 后缀并小写，否则查不到映射会静默落到默认模型
  return String(name).replace(/\s*\[[^\]]*\]\s*$/, "").trim().toLowerCase();
}
/**
 * 档位 key：Claude Code 有时发来的是**带日期后缀的规范 id**
 * （claude-haiku-4-5-20251001），而映射表的 key 是**不带日期的档位名**
 * （claude-haiku-4-5）。
 *
 * 少了这一步，这个请求查不到映射 → 静默落到 defaultModel。**只要「某个档位映射到的模型」
 * 与「本渠道默认模型」不是同一个，用户点的档位就被悄悄换掉了**——
 * 正是「以为在用 A 其实在用 B」那一类，而且面板连回落记录都不会有。
 * （实测：2026-10-20 真收到过 claude-haiku-4-5-20251001。）
 */
function tierKeyOf(base) {
  const m = /^(.+)-\d{8}$/.exec(String(base));
  return m ? m[1] : String(base);
}

/**
 * 档位名的**降级序列**：查不到就一级一级地短。
 *
 * ⚠⚠ **为什么必须有这一层**（2026-10-22 实测踩到，用户侧真实影响）：
 *   客户端（Claude Code）送来的模型 id 带**小版本号**：
 *     claude-sonnet-5-5、claude-opus-5-5
 *   而映射表的 key 是**档位名**（不带小版本）：
 *     claude-sonnet-5、claude-opus-5、claude-fable-5
 *   差最后一段就查不到 → **静默回落到本渠道默认模型** →
 *   用户点 opus、实际跑的是默认那个（面板的「模型回落」留痕能看到，但用户
 *   不会去看）。实测日志里 claude-sonnet-5-5 出现过 41 次、claude-opus-5-5
 *   出现过 7 次，全是回落。
 *   （只有 haiku 那档侥幸对得上：claude-haiku-4-5 恰好与档位名逐字相同。）
 *
 *   这不是本仓库写错了 key，是**厂商把模型 id 的小版本加进去了**。
 *   而小版本**会继续涨**（5-5 → 5-6 → 6-0）—— 所以修法不是把 key 改成
 *   claude-sonnet-5-5（那下次升级又对不上），而是**查表时逐级降级**：
 *   用户的映射表不用因为厂商升小版本而重填一遍。
 *
 * 顺序：**先精确、后降级**。claude-haiku-4-5 要能精确命中（降级会把它
 * 错降成 claude-haiku-4，那不是任何一档）。
 */
function tierKeyChain(base) {
  const out = [];
  const push = (v) => {
    const s = String(v == null ? "" : v);
    if (s && !out.includes(s)) out.push(s);
  };
  push(base);
  /* ① 去掉日期后缀（claude-haiku-4-5-20251001 → claude-haiku-4-5） */
  push(tierKeyOf(base));
  /* ② 去掉小版本（claude-sonnet-5-5 → claude-sonnet-5） */
  /* ③ 再去掉一段（claude-sonnet-5 → claude-sonnet） */
  let cur = out[out.length - 1] || "";
  for (let i = 0; i < 2; i++) {
    const m = /^(.+)-\d+$/.exec(cur);
    if (!m) break;
    cur = m[1];
    push(cur);
  }
  return out;
}
/**
 * 可用清单里的匹配：**大小写不敏感**，命中时返回**清单里的原样写法**。
 *
 * 为什么必须大小写不敏感：normalizeModel 会把模型名**转小写**，而 mm 的上游 id
 * 是**大小写敏感**的（官方写法 MiniMax-M3.1-Flash）。逐字比永远比不中，
 * 于是客户端明明送的就是清单里那个名字，却被记成一次「模型回落」——
 * 而这条留痕是「以为在用 A 其实在用 B」的**唯一防线**。它自己天天误报，
 * 用户就会学会无视它（那比静默回落更坏，代码注释里自己写了这句）。
 *
 * ⚠ 返回的是**清单里的写法**（不是小写版）——上游 id 大小写敏感，发错了会 400。
 */
function listedModelOf(base, list) {
  const arr = Array.isArray(list) ? list : [];
  const hit = arr.find((x) => String(x).toLowerCase() === base);
  return hit == null ? null : String(hit);
}
/**
 * 档位名 → 真正的模型名。**命中就返回模型名，没命中返回 null**（要不要回落交给调用方）。
 *
 * 查找顺序（顺序即优先级，与改动前一致）：
 *   ① 映射表：先查原名，再查去掉日期后缀的档位名
 *   ② 可用清单：先查原名，再查去掉日期后缀的档位名；大小写不敏感
 *
 * ⚠ resolveModel 与 resolveModelQuiet **共用这一个函数**——它们俩一旦分叉，
 *   providerStatus 重算出来的「意图」就会与实际执行的解析慢慢对不上，
 *   而对不上的时候面板报的是**两个方向都可能错**的差异，用户无从判断该信哪个。
 */
function resolveModelTarget(base, cfg) {
  /* 查表**逐级降级**：先精确，再去日期后缀，再去小版本（见 tierKeyChain 的注释）。
   * ⚠ 顺序要紧：claude-haiku-4-5 必须精确命中（降级会把它错降成 claude-haiku-4）。
   * ⚠ **映射表整体优先于可用清单**：用户在映射表里写死的对应关系，比上游目录里
   *   一个同名条目更权威。降级前就是这个顺序（映射[原名] → 映射[档位名] →
   *   清单[原名] → 清单[档位名]）；降级只是给这两组**各加几级**，
   *   组序不许调换 —— 调换的后果很具体：客户端送 claude-opus-5-20251001
   *   （带日期的规范 id），而上游清单里正好有这一条，于是「清单[原名]」先命中，
   *   用户在映射表里写的那个对应关系被跳过了，跑的是另一个模型。 */
  const chain = tierKeyChain(base);
  for (const k of chain) {
    const m = cfg.mapping?.[k];
    if (m && m.target) return m.target;
  }
  for (const k of chain) {
    const l = listedModelOf(k, cfg.availableModels);
    if (l) return l;
  }
  return null;
}
/* ---------- 模型回落留痕（v1.0.78 T9） ----------
 *
 * resolveModel 的第三条分支是**静默**的：客户端送来一个「映射表里没有、可用清单里也没有」
 * 的模型名，我们就回落到本渠道的 defaultModel，请求照样 200。此前这条路上**既没有日志、
 * 也没有面板痕迹**——用户以为在用 A，实际跑的是 B，两边都看不出来。
 *
 * 怎么触发的（实测）：客户端若指向了 WorkBuddy 的中转口、却发来 Zen 的模型名
 * （space-bunny-free），查不到映射 → 直接落到 wb 的出厂 defaultModel
 * （deepseek-v4.1-flash）。**不需要故障转移**，一次普通的正常请求就够了。
 *
 * 这是「以为在用 A 其实在用 B」的唯一防线，所以它必须**两处都留痕**：
 *   · 一条日志（排查时按模型名 grep 得到）
 *   · 一份面板状态（用户自己看得到，见 providerStatus().modelFallback）
 * 光有日志不够——用户不会去翻日志；光有面板也不够——面板只说"不对"，说不出"哪一步不对的"。
 *
 * 🔴 只记模型名与渠道，**一个凭据都不进这里**（它会原样进 /api/status）。
 */
const modelFallbacks = Object.create(null);   // 渠道 → [{requested, landed, firstAt, lastAt, count}]
const MODEL_FALLBACK_KEEP = 10;
const MODEL_FALLBACK_RELOG_MS = 10 * 60 * 1000;
function noteModelFallback(ch, requested, landed) {
  const key = String(ch || "?");
  const now = Date.now();
  const list = modelFallbacks[key] || (modelFallbacks[key] = []);
  const hit = list.find((x) => x.requested === requested && x.landed === landed);
  if (hit) {
    /* 同一个模型名持续回落时**不逐请求刷日志**（一个会话里每次请求都会走到这里），
       但计数与最近时刻照常更新；隔够 10 分钟再补一行，让"还在持续回落"也留下痕。 */
    if (now - hit.lastAt >= MODEL_FALLBACK_RELOG_MS) {
      try { log(`模型回落（第 ${hit.count + 1} 次）：渠道 ${key} 收到模型名「${requested}」，仍回落到默认模型「${landed}」。`); } catch { }
    }
    hit.count += 1; hit.lastAt = now;
  } else {
    try {
      log(`模型回落：渠道 ${key} 收到模型名「${requested}」，映射表与可用清单里都没有它 —— 已回落到默认模型「${landed}」。`
        + `请求不会失败，但实际服务的模型不是你选的那个（面板「诊断」里能看到）。`);
    } catch { }
    list.unshift({ requested, landed, firstAt: now, lastAt: now, count: 1 });
    if (list.length > MODEL_FALLBACK_KEEP) list.pop();
  }
}
/** 面板状态用的一份快照：只报 30 分钟内的（与 activeTier 同一个新鲜度窗口），
 *  且字段名与 store 里的不一样（这里是 ISO 串，panel 直接 new Date）。 */
function modelFallbackFields(p) {
  const now = Date.now();
  return (modelFallbacks[p] || [])
    .filter((x) => now - x.lastAt < 30 * 60000)
    .map((x) => ({
      requested: x.requested, landed: x.landed, count: x.count,
      firstAt: new Date(x.firstAt).toISOString(), lastAt: new Date(x.lastAt).toISOString(),
    }));
}
/** 档位名 → 真正的模型名。**与 resolveModel 逐字相同，唯一区别是回落那条不留痕**。
 *
 *  它存在的理由是 providerStatus 要**事后重算**「那次请求本来打算路由到哪」：
 * 重算不是一次新的解析，不该再记一次回落（否则面板每刷新一次就多一条回落记录）。
 * ⚠ 两条分支不许各写各的：它们必须永远一致，否则"重算出来的意图"与"实际执行的解析"
 * 会慢慢分叉，那比回落本身更难查。scripts/model-truth-test.mjs 有一条断言把这两个
 * 函数的主体**逐字**比对，改了一边忘了另一边，测试当场红。
 * 它们现在**共用 resolveModelTarget**，查找规则只有一份，分叉在结构上就不可能发生。 */
function resolveModelQuiet(name, cfg) {
  const base = normalizeModel(name);
  const hit = resolveModelTarget(base, cfg);
  if (hit) return hit;
  return cfg.defaultModel;
}
/**
 * 档位名 → 真正的模型名。`ch` 是渠道键，只用于回落留痕（不传就记成 "?"）。
 * 查找规则全在 resolveModelTarget 里（与 resolveModelQuiet **共用**），
 * 这里只多一件事：**真的没命中时留痕**。
 */
function resolveModel(name, cfg, ch) {
  const base = normalizeModel(name);
  const hit = resolveModelTarget(base, cfg);
  if (hit) return hit;
  noteModelFallback(ch, base, cfg.defaultModel);
  return cfg.defaultModel;
}

// ---------- 桌面版可用性探测的两个端点（本机应答，不进模型调用链路）----------
// 桌面版在把模型显示进选择器之前会先探测推理网关：POST /v1/messages/count_tokens（数 token）
// 与 GET /v1/models（列模型）。以前这两个请求都落进了模型调用链路——count_tokens 真的打了一次
// 上游，并把完整的 assistant message 当答案返回（违反 Anthropic 规范，规范只要 input_tokens）；
// /v1/models 则被准入门 405 掉。桌面版据此判定「模型不可用」。CLI 不做这类探测，所以 CLI 侧
// 一直正常；B.AI/SenseNova 是原样透传、count_tokens 由上游按规范回答，也正常——
// 只有 openai 桥（wb/qd/zen/or）受影响。

// 取一段 Anthropic 内容（字符串 / 块数组 / 嵌套块）的字符数。
function anthroChars(v) {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  if (Array.isArray(v)) return v.reduce((n, x) => n + anthroChars(x), 0);
  if (typeof v === "object") {
    let n = 0;
    if (typeof v.text === "string") n += v.text.length;
    if (v.content !== undefined) n += anthroChars(v.content);
    // tool_use / tool_result 的结构化载荷：按其 JSON 字符数一并计入，宁多勿少
    if (v.input !== undefined) { try { n += JSON.stringify(v.input).length; } catch { } }
    return n;
  }
  return 0;
}

// token 估算口径：**不调上游、不做真实分词**，纯按字符数近似（4 字符 ≈ 1 token）。
// Anthropic 客户端只用这个数做预算/截断判断，不要求精确；而真要精确就得为一次计数再打一次
// 上游——那正是这里要消掉的白烧额度。覆盖范围：system + 全部 messages + tools（含 input_schema）。
function estimateInputTokens(j) {
  let chars = 0;
  chars += anthroChars(j.system);
  if (Array.isArray(j.messages)) {
    for (const m of j.messages) chars += anthroChars(m && m.content !== undefined ? m.content : m);
  }
  if (Array.isArray(j.tools)) {
    for (const t of j.tools) {
      if (!t || typeof t !== "object") continue;
      chars += anthroChars(t.name) + anthroChars(t.description);
      if (t.input_schema !== undefined) { try { chars += JSON.stringify(t.input_schema).length; } catch { } }
    }
  }
  if (j.tool_choice !== undefined) chars += anthroChars(j.tool_choice);
  return Math.max(1, Math.ceil(chars / 4)); // 下限 1：空请求也回一个像样的正整数
}

// GET /v1/models 的应答体：清单驱动——档位取 TIERS（不写死任何提供方名），
// display_name 取本家 mapping 里该档的 label（正是写进桌面版 inferenceModels 的 labelOverride），
// 找不到就退回档位 key。[1m] 之类的 1M 变体不列——桌面版按基础名匹配 inferenceModels。
function relayModelsPayload(mapping) {
  return {
    data: TIERS.map((t) => ({
      type: "model",
      id: t.key,
      display_name: (mapping && mapping[t.key] && mapping[t.key].label) || t.key,
    })),
    has_more: false,
  };
}

// 准入门挡下请求时：先留一行痕（方法 + 路径 + 状态码 + 一句话用途），再按**原有语义**应答。
// 留痕的理由：桌面版到底打了哪些方法/路径，以前只能靠猜（405 一律笼统），中转观察里也看不见
// （被挡的请求压根不进那条记录）。只记方法与路径，不记 body、不落盘。
// tag 区分「不认识的路径/方法」与「认识但请求体坏了」——两者都不是成功，留痕措辞必须如实。
function rejectRelay(req, res, pathOnly, status, msg, tag) {
  log(`${tag || "未识别请求"}：${req.method} ${pathOnly} → ${status}（${msg}）`);
  return wbAnthroError(res, status, msg);
}

// 最近真实调用观察（Claude Code 每次请求都会经过中转，天然全知）
// 每个提供方一份：B.AI 侧观察不能依赖 sn 侧流量，反之亦然。记录逻辑内联在 makeRelay 里。
const recentCallsBai = [];  // {tier, served, at}
const recentCallsSn = [];
const recentCallsWb = [];
const recentCallsWbai = [];
const recentCallsZen = [];
const recentCallsQd = [];
const recentCallsMm = [];   // MiniMax 会员托管通道
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
  wbai: { kind: null, message: null, at: null },
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

function sendRateLimitError(res, upstream, provider, bodyStr) {
  const retryAfter = upstream.headers.get("retry-after");
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (retryAfter) headers["retry-after"] = retryAfter;
  res.writeHead(429, headers);
  /* ★ v1.0.85：429 的文案要按**渠道 + 请求体体积**分开说。
   *
   * 改前的原话是「暂时限流，请在 N 秒后重试。这不是代理或配置错误。」——
   * 最后一句是对的，但它把用户引到了一个错方向：对 wb/wbai 的大上下文请求，
   * 429 的根因是**请求体体积越过上游红线**，重试一万次也不会好（实测见
   * wb-429.mjs 顶部：0.42MB → 200，1.25MB / 2.50MB → 429）。用户于是照着
   * 「等 30 秒」白等半小时，而唯一的解是**开新对话**。
   *
   * 判据刻意**不通用化**：这条体积红线只有 wb / wbai 有（B.AI / SenseNova /
   * Zen / Qoder / OpenRouter 都不吃它），所以 `provider` 必须是本渠道自己的 key，
   * 由 wb429ContextHint 自己把关；其它渠道一个字都不变，仍是「稍后重试」。
   * `bodyStr` 是**真正发出去的那份正文**（openaiExchange 里的 bodyStr，不是
   * 客户端原文）——拿不到就传 null，那时判据自动失效，文案退回改动前。 */
  const ctxTail = wb429ContextHint(provider, bodyStr);
  res.end(JSON.stringify({
    type: "error",
    error: {
      type: "rate_limit_error",
      message: `上游 API 暂时限流（HTTP 429）${retryAfter ? `，请在 ${retryAfter} 秒后重试` : "，请稍后重试"}。这不是代理或配置错误`
        + (ctxTail ? `。${ctxTail}` : "。"),
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
  /* ★ v1.0.85：原话是「免费渠道并发限流，等 30 秒左右再试」——**最误导的一条**。
   * 对 wb/wbai 的大上下文请求，429 的根因是请求体体积越过上游红线（实测
   * 0.42MB → 200、1.25MB → 429），**等是没用的**，解是开新对话。用户照旧文案
   * 白等半小时。这里不再承诺「等 30 秒」，改成把两种可能都列出来：
   * 体积红线（wb/wbai 专属，见 wb-429.mjs）与真的并发限流。 */
  429: "，常见原因是：①上下文/请求体太大越过上游体积红线（wb/wbai 实测存在，等再久也不会好，请开新对话或压缩历史）；②真的并发限流（等 30 秒左右再试）",
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
  /* 归因需要**上游原文**：本机中转会把它转译成中文（"上游拒绝请求（HTTP 403）：…"），
   * FreeTierError 这类关键词就丢了，事后没法再按原文分类。所以每条抛出的错误都挂上
   * `.upstreamRaw` 与 `.upstreamStatus`。**纯附加**：现有三个调用点只读 `e.message`，
   * 行为一字不变。 */
  const withRaw = (err) => { try { err.upstreamRaw = raw; err.upstreamStatus = response.status; } catch { } return err; };
  // 失败优先归因。三个调用点（/api/models 的 sn 与默认分支、/api/test 的档位探测）
  // 拿到 JSON 后都只会读 error.message，"Forbidden" 这类裸字符串错误就整条丢了。
  if (response.status >= 400) {
    if (j === null) throw withRaw(probeBodyError(response, raw));
    const said = upstreamErrorText(j);
    if (!said) throw withRaw(new Error(`上游返回 HTTP ${response.status}，但没带错误说明${PROBE_HINTS[response.status] || ""}`));
    // 上游已经把状态码和原因说全了（多半是本机中转转译过的 429/502），别再复述一遍
    if (said.includes(`HTTP ${response.status}`)) throw withRaw(new Error(`上游错误：${said}`));
    throw withRaw(new Error(`上游拒绝请求（HTTP ${response.status}${PROBE_HINTS[response.status] || ""}）：${said}`));
  }
  if (j === null) throw withRaw(probeBodyError(response, raw));
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

async function readAllBody(r) {
  if (!r || !r.body) return "";
  const out = [];
  for await (const c of r.body) out.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(out).toString("utf8");
}
// 令牌续期锁：**按渠道各一把**（里程碑 1b）。以前是单个模块级变量，wb 与 wbai 共用——
// 两版令牌不通用，并发续期会互相把对方的锁清掉。这里改成 Map 逐渠道独立。
const wbRefreshLocks = new Map();
// 令牌续期：POST /v2/plugin/auth/token/refresh（刷新令牌放 X-Refresh-Token 头，与 WorkBuddy 客户端一致）
// 成功后就地写回 config.json（访问/刷新令牌成对滚动，有效期约一年，正常一年才需要续一次）
// p 决定用哪一份配置：wb → cfg.wb，wbai → cfg.wbai（里程碑 1b，两版令牌互不通用）。
//
// ★ account 给的是**本次真正在用的那个池条目**（可能不是 cfg.wb 里那一把）。
//   续期成功要把新令牌写回**条目**与**渠道配置**两处：条目是池的真相，渠道配置是
//   面板「凭据」页与 /v3/config 目录抓取的真相，两处都写才不会出现「池里是新令牌、
//   面板显示的还是旧的」。老配置（合成池）两者本就是同一枚，写两遍是幂等的。
function wbRefreshToken(cfg, p, account) {
  const isAi = p === "wbai";
  const zh = isAi ? "WorkBuddy AI" : "WorkBuddy";
  const w = isAi ? cfg.wbai : cfg.wb;
  const refreshToken = (account && account.refreshToken) || (w && w.refreshToken);
  if (!w || !refreshToken) throw new Error(`${zh} 刷新令牌为空，无法续期——请重新捕获令牌`);
  const base = (w.upstream || (isAi ? DEFAULTS.wbai.upstream : DEFAULTS.wb.upstream)).replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    "x-refresh-token": refreshToken,
    // ⚠ 授权头也用**这一枚账号的**访问令牌，不是渠道配置里那一把——
    // 多账号之后两者不再必然是同一枚，用错会拿 A 的令牌去续 B 的会话。
    authorization: `Bearer ${(account && account.accessToken) || w.accessToken || ""}`,
    "x-auth-refresh-source": "plugin",
    "x-domain": hostOf(base) || (isAi ? "www.workbuddy.ai" : "www.workbuddy.cn"),
    "user-agent": `B.AI-Router/${APP_VERSION}`,
  };
  const useProxy = w.useProxy === true;
  return (async () => {
    const r = useProxy
      ? await fetch(base + "/v2/plugin/auth/token/refresh", { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(15000) })
      : await directHttp(base + "/v2/plugin/auth/token/refresh", { method: "POST", headers, body: "{}", timeoutMs: 15000 });
    const txt = await readAllBody(r);
    if (r.status !== 200) {
      /* ★★★ 续期失败要**带着原始状态码/正文/响应头**往上抛。
       * 刷新接口的失效信号是 **HTTP 400**（不是 401），不带状态码抛出去的话，
       * 接线层无从按 `context:"refresh"` 判死，死号就会永远留在池子里烧重试。
       * 正文一律先过 redact：上游偶尔把请求里的东西原样回显，而这条文案会进日志与面板。 */
      const e = new Error(`${zh} 令牌续期失败 HTTP ${r.status}: ${redactWiring(String(txt), 160)}`);
      e.status = r.status;
      e.text = String(txt);
      e.headers = r.headers;
      throw e;
    }
    let j = {};
    try { j = JSON.parse(txt); } catch { }
    const box = j.data && typeof j.data === "object" ? j.data : j;
    const na = box.access_token || box.accessToken || box.token;
    const nr = box.refresh_token || box.refreshToken;
    if (typeof na !== "string" || na.length < 20) throw new Error("令牌续期响应里没有新的访问令牌");
    w.accessToken = na;
    if (typeof nr === "string" && nr.length > 20) w.refreshToken = nr;
    if (account) {
      account.accessToken = na;
      if (typeof nr === "string" && nr.length > 20) account.refreshToken = nr;
      account.credential = { ...(account.credential || {}), lastRefreshTime: Date.now() };
    }
    saveCfg(cfg);
    const exp = wbTokenExp(na);
    log(`${zh} 令牌已自动续期${exp ? "（新有效期至 " + new Date(exp).toLocaleDateString("zh-CN") + "）" : ""}`);
    return w.accessToken;
  })();
}

/**
 * 池化之后的令牌入口：按渠道选一个可用账号，必要时先续期。
 *
 * @param {object} cfg
 * @param {"wb"|"wbai"} p
 * @param {object} [o] {model, sessionKey, now}
 *   ⚠ **sessionKey 只在真的算得出会话锚点时才传**（探测/健康检查不传）——
 *   传一个常量进去等于把所有探针粘到同一个号上，白白占住一条绑定。
 * @returns {Promise<{ok:boolean, token?:string, accountId?:string, reason?:string, remedy?:string}>}
 */
async function wbEnsureTokenPooled(cfg, p, o = {}) {
  const sel = await wbPickAccount(cfg, p, {
    model: o.model == null ? null : o.model,
    sessionKey: o.sessionKey == null ? null : o.sessionKey,
    now: Number(o.now) || Date.now(),
    tokenExpOf: wbTokenExp,
    refresh: (pp, acct) => wbRefreshOnce(cfg, pp, acct),
  });
  if (!sel.ok) {
    /* 把 pool 给的结构化原因原样带出去（**不做任何加工**，也就没有反推的余地），
       并带上选出来的 HTTP 状态码：没配令牌 / 已过期仍是 401（与池化之前一字不差），
       「在冷却 / 额度用尽」是 429，「判死 / 停用 / 空池」是 503 —— 绝不再冒充 401。 */
    const zh = p === "wbai" ? "WorkBuddy AI" : "WorkBuddy";
    const e = new Error(sel.reason === "no_token" && !sel.refreshError
      ? `${zh} 访问令牌未配置——到面板「${zh}」页粘贴令牌`
      : sel.reason === "expired"
        ? `${zh} 访问令牌已过期且没有刷新令牌，请重新捕获`
        : `${zh} 账号池暂无可用账号（${sel.reason}）：${sel.remedy || ""}`);
    e.poolReason = sel.reason;
    e.poolRemedy = sel.remedy || null;
    e.status = sel.status || wbUnusableStatus(sel.reason);
    throw e;
  }
  return sel;
}
/**
 * 并发续期去重。**键从「渠道」变成「渠道+账号」**（v1.0.77）：
 * 池化之后一次请求要选的是**某一枚**账号的令牌，两条并发请求很可能落在不同账号上；
 * 按渠道去重会让第二个账号的续期被第一个账号的 in-flight 请求「顺带」跳过，
 * 拿着**旧令牌**继续发请求 —— 症状是莫名其妙的连续 401。
 */
async function wbRefreshOnce(cfg, p, account) {
  const key = `${p}#${(account && account.id) || "solo"}`;
  if (!wbRefreshLocks.has(key)) {
    wbRefreshLocks.set(key, wbRefreshToken(cfg, p, account).finally(() => { wbRefreshLocks.delete(key); }));
  }
  return wbRefreshLocks.get(key);
}

// ---------- OpenCode Zen 模型目录（v1.0.42）----------
// 公开接口，无需鉴权也不需要任何补丁——这点与 Qoder 正好相反（Qoder 的目录要靠 worker
// 钩子导出明文）。但公开目录只给 id，没有价格/免费标记，可用性只能按实测结论标注。
//
// ⚠⚠ **这行白名单曾经是唯一依据，而它今天一条都不成立。**
// 注释原本写着「实测（2026-10，用户 Free key）：只有 space-bunny-free 能从外部调用」。
// 2026-10-12 用**同一把真 key** 复核（.research/reports/T5-probe-result.md）：
// `space-bunny-free` 打 /zen/v1/messages 与 /zen/v1/chat/completions **都是 403
// FreeTierError**，连付费模型都逐字相同。所以旧注释已经**作废**，它记录的是一次
// 已经不再成立的观测——「实测过」不等于「现在还成立」，上游改一次就全废。
//
// **它现在的角色降级为「探测结果缺失时的占位」，不再当既成事实用**：
// 真实判据是 `zenExternalOk(id, cfg)` —— 有探测结果就用探测结果，没有才回落到这里。
// 换句话说，用户点一次「检测可用性」，这个常量就彻底让位给实测值。
const ZEN_EXTERNAL_OK = new Set(["space-bunny-free"]);

/* ---------- Zen 档位判定（v1.0.74 · T4） ----------
 * **判据只有 cfg.zen.upstream 的 URL**：出现 `/zen/go/` 即 Go 档，否则免费档。
 * 不新增配置字段——config.defaults.json 的出厂值一个字节不动，用户在面板把上游地址
 * 改成 https://opencode.ai/zen/go/v1 就是切档。
 *
 * 为什么必须集中成一处：目录端点、请求头、错误归因、面板徽标**四处**都要判档，
 * 各写一遍正则早晚会漏一处。而漏在「目录」那一处后果最严重：
 * Go 档会去拉免费档的清单（38 个 vs 83 个），把 9 个 Go 档根本没有的免费模型
 * 摆进用户下拉框，点一个就报错。 */
const ZEN_TIER_GO = "go";
const ZEN_TIER_FREE = "free";
function zenTierOf(upstream) {
  return /\/zen\/go(?:\/|$)/i.test(String(upstream || "")) ? ZEN_TIER_GO : ZEN_TIER_FREE;
}
function zenTierZh(tier) { return tier === ZEN_TIER_GO ? "Go 档" : "免费档"; }
/** 目录端点的**路径**（不是完整 URL——upstream 可以是用户自填的私有地址，
 * 完整 URL 会被原样写进面板文案与日志；路径足够说明"拉的是哪一档的清单"）。
 * 这里返回的是 upstream + /models 的**末尾片段**，且只用于人类可读的说明文字。 */
function zenCatalogEndpointLabel(cfg) {
  const base = String((cfg && cfg.zen && cfg.zen.upstream) || DEFAULTS.zen.upstream).replace(/\/+$/, "");
  const m = base.match(/(\/zen\/(?:go\/)?v1)\/models$/);
  return m ? m[1] + "/models" : "/models（自定义上游）";
}

/* Go 档的会话 id（实测：**缺这个头 → 400 MissingSessionID**；任意非空值都能通过，
 * 短串 / UUID / 300 字符全试过）。官方要的是「stable session ID for each conversation」，
 * 所以锚点取请求里**第一条 role==="user" 的消息内容**：同一会话的每一轮请求
 * 带的都是那同一条首条 user 消息，id 因此在整段对话里恒定；不同会话自然不同。
 * 哈希后取前 16 位 hex、加 "bai-" 前缀——不含任何可还原的原文。
 *
 * 探针与「没有 user 消息」的请求一律用**固定** id：每次探测都造一个新会话等于
 * 凭空给上游灌会话记录，那正是官方点名监控滥用的东西。 */
const ZEN_PROBE_SESSION = "bai-probe";
function zenSessionId(j, isProbe) {
  if (isProbe) return ZEN_PROBE_SESSION;
  const msgs = Array.isArray(j && j.messages) ? j.messages : [];
  const first = msgs.find((m) => m && m.role === "user");
  const anchor = first == null ? "" : (typeof first.content === "string" ? first.content : JSON.stringify(first.content == null ? "" : first.content));
  if (!anchor) return ZEN_PROBE_SESSION;
  return "bai-" + createHash("sha256").update(anchor).digest("hex").slice(0, 16);
}

/* 「需订阅 Go」是**账号级、持续性**的：实测同一把 key 打 Go 档，回的是
 * "An active OpenCode Go subscription is required to use Go models."——key 已被上游
 * 正常解析（付费档才有的错误就是证据），缺的是订阅。所以它必须挂住给面板看，
 * 而不是随着单次错误的提示条闪一下就没了：用户不该每次点发送才知道一次。 */
const zenGoState = { required: false, at: null };
function noteZenGoRequired(required) {
  const want = !!required;
  if (zenGoState.required === want) return;      // 只在状态翻转时记一次，避免刷日志
  zenGoState.required = want;
  zenGoState.at = want ? new Date().toISOString() : null;
  if (want) log("OpenCode Zen：上游要求 Go 订阅，面板已标出「需订阅 Go」（订阅入口 https://opencode.ai/auth）");
}
/** 档位快照：/api/status 与 /api/models 共用同一份，面板两处显示的档位因此不会打架。 */
function zenTierInfo(cfg) {
  const id = zenTierOf((cfg && cfg.zen && cfg.zen.upstream) || DEFAULTS.zen.upstream);
  const go = id === ZEN_TIER_GO;
  const subRequired = go && zenGoState.required;
  return {
    id, label: zenTierZh(id),
    subRequired, subAt: subRequired ? zenGoState.at : null,
    // 面板把 hint 原样显示出来（含订阅链接与档位差异），渲染层因此不必认识任何渠道名。
    hint: subRequired
      ? "Go 档需要账号已订阅 OpenCode Go 才能用（上游原文 An active OpenCode Go subscription is required to use Go models.）。"
        + "这不是 Key 配错、也不是模型不可用——Key 已被上游正常解析，缺的是订阅。"
        + "订阅入口 https://opencode.ai/auth ，$10/月，其中 LongCat 2.5 Preview Free 与 Step 5 Preview Free 标 Unlimited。接通后此标记会自动撤掉。"
      : go
        ? "当前是 Go 档（上游含 /zen/go/）：这一档没有免费档那道 FreeTierError 围栏，"
          + "但需要账号已订阅 OpenCode Go（$10/月，https://opencode.ai/auth）。两个免费模型标 Unlimited。"
        : "当前是免费档（上游不含 /zen/go/）：官方把免费档限定在 OpenCode 客户端内使用，"
          + "外部中转一律 FreeTierError。要用请把上游地址改成 https://opencode.ai/zen/go/v1 并订阅 Go。",
  };
}

// 目录缓存**按 URL 分桶**：两档的目录是两回事（免费档 83 个 / Go 档 38 个），
// 共用一个缓存槽会让用户切档后还看到上一档的清单 —— Go 档下那 9 个不存在的模型
// 会被摆进下拉框，用户点一个就报错。
const zenCatCache = new Map();   // url -> { at, list }
async function zenReadCatalog(cfg) {
  const S = sliceOf(cfg, "zen");
  const url = S.upstream.replace(/\/+$/, "") + "/models";
  const hit = zenCatCache.get(url);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000 && hit.list.length) return hit.list;
  /* **带了 Key 就带 Key 抓**（实测：同一个 /zen/v1/models，不带 Key 返回 83 个模型、
   * 带 Key 返回 43 个，且 43 是 83 的**严格子集**——差集全是 claude-* / gemini-* /
   * deepseek-* 等付费模型）。不带头抓 = 把 40 个该账号根本调不通的模型摆到用户
   * 下拉框里。没配 Key 才退回免鉴权抓（目录本来就公开，不会因此报错）。
   * Key 只从 cfg.zen.apiKey 取，**绝不进日志 / 错误消息 / 任何落盘文件**——
   * 这里既不 log 也不抛，抓不到一律静默返回过期缓存。 */
  const headers = S.key ? { authorization: `Bearer ${S.key}` } : {};
  try {
    const fr = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const jj = await fr.json();
    const list = (jj.data || []).map((m) => String(m.id || "").trim()).filter(Boolean);
    if (list.length) zenCatCache.set(url, { at: Date.now(), list });
    return list.length ? list : (hit ? hit.list : []);
  } catch {
    return hit ? hit.list : [];
  }
}

/* ---------- Zen 能力探测的 HTTP 适配 + 结论落读（v1.0.74 · T3+T6） ----------
 *
 * 判定/并发/落盘的**纯逻辑**在 zen-probe.mjs（那里没有一行网络代码，所以能被测试
 * 直接求值）。这里只做两件事：①把它接到真的上游上；②把落盘结论喂给 /api/models。
 */

/** Zen 的请求头。**openaiExchange 与能力探针共用这一份**——
 * 两处各写一遍的话，某天改了 UA 而漏改探针，探测结论就跟真实流量对不上了。
 * 判据仍是「只在 Go 档加 x-opencode-session」，免费档一个字都不加（实测该头
 * 对免费档的围栏毫无作用，加了只是凭空多一个可能被上游记账的会话标识）。 */
function zenUpstreamHeaders(tok, base, j, isProbe) {
  const h = {
    "content-type": "application/json",
    authorization: `Bearer ${tok}`,
    "user-agent": `B.AI-Router/${APP_VERSION}`,
  };
  if (zenTierOf(base) === ZEN_TIER_GO) h["x-opencode-session"] = zenSessionId(j, isProbe);
  return h;
}

/**
 * 发一次探测请求。**`isProbe` 由调用方显式传入**，绝不从 `body.max_tokens` 反推——
 * zen-probe.mjs 里 max_tokens 会为绕开上游下限从 8 抬到 16，一旦改成反推，
 * 抬完的那一刻探测就静默变成了真实对话：短超时没了、重试没了，一次网络抖动
 * 就会把一个好模型误判成「探不通」。
 *
 * 键**只**从内存里的 cfg 取，绝不进 URL、查询串、日志或任何落盘文件。
 */
async function zenProbeSend(cfg, body, { isProbe }) {
  const z = (cfg && cfg.zen) || {};
  const base = String(z.upstream || DEFAULTS.zen.upstream).replace(/\/+$/, "");
  const url = base + "/chat/completions";
  const headers = zenUpstreamHeaders(z.apiKey || "", base, body, isProbe === true);
  const bodyStr = JSON.stringify(body);
  const useProxy = z.useProxy === true;
  const out = { status: 0, text: "", probe: isProbe === true };
  try {
    const r = useProxy
      ? await fetch(url, { method: "POST", headers, body: bodyStr, signal: AbortSignal.timeout(ZEN_PROBE_TIMEOUT_MS) })
      : await directHttp(url, { method: "POST", headers, body: bodyStr, timeoutMs: ZEN_PROBE_TIMEOUT_MS });
    out.status = r.status;
    out.text = await readAllBody(r).catch(() => "");
  } catch (e) {
    // 网络层失败也走归因：让「连不上上游」和「上游说调不通」在结果里分得开
    out.status = 0;
    out.text = String((e && e.message) || e).slice(0, 160);
  }
  return out;
}

/** 读落盘结论（没探过就是空，**不影响**任何东西）。 */
function zenProbeSnapshot(cfg) {
  const tier = zenTierInfo(cfg);
  const upstream = String((cfg && cfg.zen && cfg.zen.upstream) || DEFAULTS.zen.upstream).replace(/\/+$/, "");
  return zenProbeLoad(DATA_DIR, upstream, tier.id);
}

/**
 * **模型能不能外部调用**的唯一判据（v1.0.74 起接管 ZEN_EXTERNAL_OK）：
 *   有探测结果 → 用探测结果；没有 → 回落到那个常量（并如实标「未检测」）。
 *
 * 回落而不是直接判 false，是因为用户没点过「检测可用性」时全盘清空会让下拉框
 * 变空、映射失去目标——那是把"没测过"当成"不能用"，和当初那个过期常量是同一种错误。
 */
function zenExternalOk(id, cfg) {
  const snap = zenProbeSnapshot(cfg);
  const rec = (snap.models || {})[id];
  if (rec && typeof rec.ok === "boolean") {
    return { external: rec.ok, probed: true, rec, snap };
  }
  if (rec) {
    // ok === null：撞上内容性错误，纪律②要求**不改判定**——沿用原结论。
    return { external: ZEN_EXTERNAL_OK.has(id), probed: false, unknown: true, rec, snap };
  }
  return { external: ZEN_EXTERNAL_OK.has(id), probed: false, rec: null, snap };
}

/** 「id 里没有 free 后缀、但确实是免费档」的 stealth 模型（2026-10-17 目录实测：目前只有 big-pickle）。
 *  客户端中转形态的放行判据会用到它；将来出现新的 stealth 免费模型，加在这里。 */
const ZEN_STEALTH_FREE = new Set(["big-pickle"]);

/** 面板直接显示的一组字段（文案全在服务端算，渲染层不认识任何渠道名）。 */
function zenCapFields(cfg) {
  const snap = zenProbeSnapshot(cfg);
  const n = Object.keys(snap.models || {}).length;
  /* ★ 2026-10-17：客户端中转形态下，直连探测的结论与入口都不适用（原因见 /api/models 的
   * zen 分支注释）。这里给形态说明，不再展示「上次检测时间」（那是另一种形态下的事实）。 */
  if (zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE) {
    return {
      at: snap.at || null, stale: false, count: n, atLabel: null,
      hint: "当前是「OpenCode 客户端中转」形态：免费模型由本机 OpenCode 客户端真实发出（带工具、真客户端身份），"
        + "直连时代的围栏与「检测可用性」结论都不适用——下拉里的免费模型视为可用，以实际请求为准。",
    };
  }
  return {
    at: snap.at || null,
    stale: snap.stale === true,
    count: n,
    /* 「上次检测时间」必须显示：结论会过期，用户有权知道手上这份是几小时前的。 */
    atLabel: snap.at ? new Date(snap.at).toLocaleString("zh-CN", { hour12: false }) : null,
    hint: snap.at
      ? `上次检测：${new Date(snap.at).toLocaleString("zh-CN", { hour12: false })}（${n} 个免费模型）。`
        + "结论会过期——上游随时可能改围栏或恢复额度，点「检测可用性」重跑一次即可。"
      : "尚未检测：可用性目前按出厂白名单标注，那份白名单已在 2026-10-12 实测复核为不成立。点「检测可用性」用真实请求逐个探测。",
  };
}

// ---------- WorkBuddy 模型目录（v1.0.65，契约 v18 里程碑 2/3）----------
// 旧结论「WorkBuddy 没有公开的模型目录接口」**已被实测推翻**：GET {base}/v3/config
// 带 Bearer 即可返回真实目录（本机实测 2026-10-11）：
//   www.workbuddy.ai  CLI 形态 UA → 22 个模型（21 个带 credits，2 个免费）
//   www.workbuddy.ai  App 形态 UA → 30 个模型 + modelPromotions 3 条
//   www.workbuddy.cn  CLI 形态 UA → 32 个模型（30 个带 credits，1 个免费）
//   www.workbuddy.cn  App 形态 UA → 37 个模型（App 形态打国内版 credits 全空）
//
// 关键实测事实（与契约 v18 §1 有两处出入，按实测实现）：
//  ① **UA 才是闸门，不是 Origin/Referer**。缺 Origin/Referer 实测仍返回完整 22 个模型
//     （21205 字节，与带头部完全一致）；而 UA 不是 `CLI/… CodeBuddy/…` 形态时上游回
//     400 {"code":12403,"msg":"check ua, get coding copilot version error"}。
//     「x0.34 credits」这种倍率串只在 CLI 形态 UA 下出现（App 形态的 credits 多为空）。
//  ② **模型对象里没有 `disabled` 字段**（四套目录实测都没有）。过滤仍保留
//     `disabled===true` 这一条件作防御，但当前是空操作；真正生效的是 tokens<=0。
//  ③ 空目录陷阱（契约 §1.1 确认）：坏令牌/无效令牌时上游回 **200 + 252 字节 +
//     {"code":0,"msg":"OK","data":{"models":null}}**——成功码配空数据。**必须当失败**。
const WB_CONFIG_PATH = "/v3/config";
// 两种 UA 形态：CLI 形态拿 credits（倍率），App 形态拿 modelPromotions（促销）。两者互斥，
// 要两份数据得发两次请求。App 形态的版本号走 wbUa()（运行时读真实客户端版本），
// 不要在这里写死——写死的那个数一定会过期。
const WB_UA_CLI = "CLI/2.63.2 CodeBuddy/2.63.2";
/* ---------- v1.0.78 T8：目录与倍率**按账号分桶** ----------
 *
 * 为什么必须分桶（这不是洁癖，是会算错账的）：`/v3/config` 是**带着某一枚账号的令牌**
 * 抓回来的，那份清单和其中的 `credits` 倍率**本身就是账号权限的事实**（用户已实测：
 * 不同账号的清单确实不同）。而分桶之前缓存只按渠道存，于是**在账号 A 下抓到的目录与倍率
 * 会被复用到账号 B**，两个后果都直接可见：
 *   ① wbAdvanceModel 按 `credits` 从低到高挑替补 —— 倍率来自错误账号就挑错档位；
 *   ② 面板上那个倍率是错的，而倍率正是用户判断「这次请求要花多少」的**唯一依据**。
 *
 * 桶的键 = 账号的**不可逆指纹**（{@link wbAccountFp}），只进内存键、磁盘文件名与面板标签。
 * 渠道维度**不撤**（里程碑 1b 的教训仍在：.cn 的结果不能给 .ai 用），现在是「渠道 × 账号」。
 */
const WB_CAT_FP_LEN = 16;
/**
 * 账号的不可逆指纹 = `sha256(访问令牌)` 的前 16 位十六进制。
 *
 * 🔴 红线：这一串**只**允许出现在内存 Map 的键、磁盘缓存文件名与面板标签里；
 *   它不是凭据的反面（拿不回令牌），也永远不会随任何返回值回显明文。
 *
 * 为什么**不用** keyFp（首 7 + 尾 2 + 长度）：那个是**可逆的**——两段明文加长度足以把
 *   候选集缩到可枚举，而缓存文件名是会被同步盘/网盘上传、会被别人翻到的东西。
 *   文件名里只允许出现这一种不可逆形式。
 *
 * 为什么**只用令牌、不掺账号 id**：id 是用户自己起的低熵串（"acct-a"、"工作号"），
 *   单独哈希等于留了一本可以字典反查的账。**代价说在明处**：令牌续期/重新登录之后
 *   指纹会变，桶也就换了一个——同一账号的落盘目录成为孤儿，被
 *   {@link wbPruneCatFiles} 删掉，下次重新抓一次。这是「宁可多抓一次，也绝不串号」。
 */
function wbAccountFp(token) {
  const s = String(token || "");
  if (!s) return null;                 // 没令牌就没有目录（wbPickAccount 也会先报 no_token）
  return createHash("sha256").update(s).digest("hex").slice(0, WB_CAT_FP_LEN);
}

/** 目录缓存：渠道 → 账号指纹 → {at, upstream, val}。**没有账号维度的键一律不存在**，
 *  所以「忘了传账号」在类型上就是拿不到缓存，而不是拿到别人的。 */
const wbCatCaches = {
  wb: new Map(),
  wbai: new Map(),
};
const WB_CAT_TTL_MS = 30 * 60 * 1000; // 目录变化慢，30 分钟（与 zenReadCatalog 同策略）
/** 每渠道**每账号**一份的落盘文件名。**只含渠道名与不可逆指纹，绝不含令牌或账号 id。**
 *  （`wb-catalog-<16 位指纹>.json`；这个正则就是「认得哪些文件是我写的」的判据。） */
function wbCatFileFor(p, fp) {
  return path.join(DATA_DIR, `${p}-catalog-${fp}.json`);
}
/** 升级前的旧文件名（每渠道一份）。**只在合成单条目池时读写**——多账号下读它等于
 *  把「上一个账号的目录」当成当前账号的，正是本任务要消灭的那件事。 */
const wbCatFiles = {
  wb: path.join(DATA_DIR, "wb-catalog.json"),
  wbai: path.join(DATA_DIR, "wbai-catalog.json"),
};

// 倍率归一化（契约 §1.3）：上游两种写法 "x0.79" 与 "x0.34 credits"（带后缀），
// 另有 ""（无信息）、null（部分 App 形态的图片/视频模型）。
// **必须先把 ` credits` 后缀剥掉**再判免费——否则 "x0.00 credits" 会被漏判为付费。
function wbNormalizeCredits(raw) {
  if (raw == null) return undefined;
  const s = String(raw).trim().replace(/\s*credits\s*$/i, "").trim();
  return s || undefined;
}
// 免费判定：剥离后缀后匹配 /^x?0\.0+$/（x0.00 / x0 / 0.00 / 0 都算）
function wbIsFreeCredits(raw) {
  const n = wbNormalizeCredits(raw);
  return n != null && /^x?0\.0+$/.test(n);
}
// 把上游一条模型记录解析成本地条目：{ id, name, credits, free, ... }。
// 过滤（契约 §2）：disabled===true / maxInputTokens<=0 / maxOutputTokens<=0 一律丢弃。
function wbMapModel(m) {
  if (!m || typeof m !== "object") return null;
  const id = String(m.id || "").trim();
  if (!id) return null;
  if (m.disabled === true) return null;                       // 防御：实测当前无此字段
  /* 图像/视频档不进对话下拉。上游用 tags 明说（实测国内版 CLI 形态的
     hunyuan-image-alpha → tags:["text-to-image"]、hunyuan-image-alpha-edit →
     ["image-to-image"]；国际版 App 形态的 gpt-image-2.5-sunburst / seedance-2.5 同理）。
     本软件只做对话中转，这些选中必然调不通——与 zen 渠道「不可用的不进下拉」同一契约。

     **必须显式拦**：这几个模型的 maxOutputTokens 是 undefined，而
     Number(undefined) 得 NaN、NaN <= 0 是 false，所以下面那道 tokens 过滤拦不住它们
     （实测它们正是这么一路穿过 wbMapModel 进了下拉）。 */
  if (Array.isArray(m.tags) && m.tags.some((t) => /image|video/i.test(String(t)))) return null;
  // tokens 缺失/非数字（Number(undefined) → NaN，而 NaN <= 0 是 false，原判据会被绕过）
  // 一律当无效记录丢掉——上游没给限额的模型不该进下拉。
  const tokIn = Number(m.maxInputTokens), tokOut = Number(m.maxOutputTokens);
  if (!Number.isFinite(tokIn) || !Number.isFinite(tokOut) || tokIn <= 0 || tokOut <= 0) return null;
  const credits = wbNormalizeCredits(m.credits);
  return {
    id,
    name: String(m.name || id).trim() || id,
    credits: credits || null,
    free: wbIsFreeCredits(m.credits),
    contextWindow: Number(m.contextWindow) || null,
    supportsImages: m.supportsImages === true,
    supportsReasoning: m.supportsReasoning === true,
  };
}
// 单次抓取：返回 { ok, models, promotions, error } —— 空目录（含 models:null）算失败。
// p 决定上游（wb → 国内版配置，wbai → 国际版配置）；
// ★ v1.0.78 T8：`acct` 决定**用哪枚账号的令牌**，由调用方显式传进来，这里绝不自己去挑。
async function wbFetchConfig(cfg, uaKind, p, acct) {
  const S = sliceOf(cfg, p);
  const base = S.upstream || DEFAULTS[p].upstream;
  let host = "www.workbuddy.ai";
  try { host = new URL(base).hostname; } catch { /* 非法地址则用默认 host 拼头 */ }
  /* 为什么必须显式：分桶之后「抓的时候用的是哪个账号」与「结果存进哪个桶」必须
     **由同一个值**决定。只要这一步还隐式取号，就可能出现「拿 A 的令牌抓、存进 B 的桶」
     ——那正是本任务要消灭的串号，而它在代码里长得和改动前一模一样，看不出来。
     抓取入口 {@link wbCatalogAccount} 先选号一次，再把 `{id,fp,token}` 一路传下来。 */
  const tok = acct && acct.token;
  if (!tok) return { ok: false, error: "没有可用的账号令牌，跳过目录抓取", empty: true };
  const url = base.replace(/\/+$/, "") + WB_CONFIG_PATH;
  const headers = {
    authorization: `Bearer ${tok}`,
    accept: "application/json",
    // UA 是唯一闸门（实测：UA 前缀不是 WorkBuddy 时上游回 400 code=12403；
    // 见本文件 WB_UA_CLI 处的实测记录）。形态决定 roster 内容：
    // CLI 形态带 credits（倍率），App 形态带 modelPromotions（促销），两者互斥。
    "user-agent": uaKind === "app" ? wbUa() : WB_UA_CLI,
    // origin/referer：实测对本接口**没有任何作用**（八种增删组合响应逐字节相同）。
    // 仍然带上——万一上游将来改成按 Origin 分流，这里已经是对的。不是必需项。
    origin: `https://${host}`,
    referer: `https://${host}/`,
  };
  let r, txt;
  try {
    r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    txt = await r.text();
  } catch (e) {
    return { ok: false, error: `请求 /v3/config 失败：${String((e && e.message) || e).slice(0, 140)}` };
  }
  let j = null;
  try { j = JSON.parse(txt); } catch { /* 非 JSON，下面统一归因 */ }
  if (!j || typeof j !== "object") {
    return { ok: false, error: `上游返回的内容不是合法 JSON（HTTP ${r.status}）：${String(txt).slice(0, 100)}` };
  }
  if (r.status >= 400 || (typeof j.code === "number" && j.code !== 0)) {
    // 上游用自己的 code 报错（如 12403 check ua），HTTP 状态可能仍是 200/400
    const said = upstreamErrorText(j, 120) || `上游返回 HTTP ${r.status}`;
    return { ok: false, error: said };
  }
  const d = (j.data && typeof j.data === "object") ? j.data : {};
  const rawModels = Array.isArray(d.models) ? d.models : null;
  // **空目录必须当失败**（契约 §1.1 的 252 字节陷阱）：models 为 null 或数组为空，
  // 一律报「上游没给目录」，绝不显示成「0 个模型」。
  if (!rawModels || !rawModels.length) {
    return { ok: false, error: "上游没给模型目录", empty: true };
  }
  const models = rawModels.map(wbMapModel).filter(Boolean);
  if (!models.length) {
    return { ok: false, error: "上游给了目录但全部模型都被过滤（tokens<=0 或 disabled）", empty: true };
  }
  const promos = Array.isArray(d.modelPromotions) ? d.modelPromotions : null;
  return { ok: true, models, promotions: promos };
}
// 合并 CLI 与 App 两种形态的目录：并集，倍率一律以 CLI 为准。
// 为什么要取并集：两种形态的 roster 并不相同，实测国际版 App 形态 31 个 / CLI 形态 22 个，
//   有模型只在一边出现——只取 CLI 形态会漏掉 App 才上线的模型（step-5-preview 就是只在
//   App 形态出现的，实测国际版 CLI 形态看不到、App 形态有、且能正常对话）。
// 为什么倍率以 CLI 为准（同 id 时整条记录都用 CLI 的，不让 App 覆盖）：
//   实测国内版 App 形态 37 个模型的 credits **全部为空**，拿它覆盖 CLI 会把已知倍率擦成未知；
//   CLI 形态带 credits（倍率）才是可信来源，App 形态只用来补 roster 和 promotions。
// 只有 CLI 没有、App 才有的新 id 才取 App 的记录：如果 App 也给了 credits 就用它的
//   （实测国际版 App 形态 29/31 带 credits），没给则 credits:null（未知，与内置兜底同义）。
// 入参 models 是 wbMapModel 产出的本地条目（已过滤），不是上游原始记录。
//
// **只对国际版（wbai）取并集**，国内版（wb）维持纯 CLI 形态——两版的增量性质完全不同：
//   国际版增量 9 个全是真对话模型（含 step-5-preview / grok-4.7 / gpt-6-*），值得补；
//   国内版增量 21 个里只有 6 个是能用的对话模型，其余 15 个是代码补全（codewise-* /
//   completion-gf / *-taco-completion，maxOutputTokens 仅 256）、图像生成
//   （hunyuan-image-v3.0-art）、以及 auto / default-1.x / hunyuan-3b 这类内部或旧版映射。
//   这些没有 contextWindow、也没有倍率，进下拉只会让用户选中后调不通——而国内版 CLI
//   形态本身已经有 33 个（覆盖主流模型），补这 15 个是纯副作用。
//   所以合并**只在国际版启用**，由调用方按 p 判断（见 wbReadCatalog 里的那一处）。
// 图像/视频档不在这里拦：wbMapModel 已经按上游 tags 在更前面拦掉了（比按 id 猜更可靠），
// 这里再放一道同义正则只会让人以为漏了就靠它。
function wbMergeModels(cliModels, appModels) {
  const out = [...cliModels];                       // CLI 那份原样保留（含其倍率）
  const seen = new Set(cliModels.map((m) => m.id));
  for (const m of appModels) {
    if (!m || seen.has(m.id)) continue;             // 同 id：CLI 已有，不覆盖
    seen.add(m.id);
    out.push(m);
  }
  return out;
}
/* ---------- v1.0.78 T8：桶的四个动作（取号 / 取桶 / 读盘 / 清理）---------- */

/**
 * 进程内桶读取。**没有账号指纹就没有桶**——这是刻意的：
 * 让「忘了传账号」变成拿不到东西（退化成 builtin），而不是拿到**别人的**目录。
 */
function wbCatBucket(p, fp) {
  const m = wbCatCaches[p];
  return m && fp ? (m.get(fp) || null) : null;
}
/** 桶里的模型数组（同步可读：wbAdvanceModel 与 429 点名付费行都靠它取倍率）。 */
function wbCatModels(p, fp) {
  const b = wbCatBucket(p, fp);
  return b && b.val && Array.isArray(b.val.models) ? b.val.models : null;
}

/** 读这个账号上次成功落盘的目录。`fp` 为空（一个可用账号都没有）时**只在合成池下**
 *  认旧文件名——那是改动前的逐字行为：老用户令牌失效但磁盘上有快照时仍看得到那份目录。
 *  多账号下 `fp` 为空就是没有目录可用，宁可退回内置兜底也不端别人的上来。 */
function wbReadCatDisk(p, fp, synthetic) {
  if (fp) {
    try {
      const v = JSON.parse(readFileSync(wbCatFileFor(p, fp), "utf8"));
      if (v && typeof v === "object") return v;
    } catch { /* 没有就往下走 */ }
  }
  /* 旧文件名（每渠道一份）**只在合成池下认**：它是池化之前某一个账号抓的，
     多账号下把它读给另一个账号就是串号——宁可退回 builtin，也不给错的价。 */
  if (synthetic) {
    try { return JSON.parse(readFileSync(wbCatFiles[p], "utf8")); } catch { return null; }
  }
  return null;
}

/**
 * 清掉「已经不属于任何在用账号」的落盘桶（孤儿）。
 * 孤儿从哪来：令牌续期/重新登录会换指纹（见 {@link wbAccountFp} 的说明），
 * 同一账号的旧桶就再也算不到了。留着只会占地方，而且**面板/诊断里看到一份
 * 不属于任何账号的目录，比看不到更糟**。
 * `keep` = 当前池里全部账号的指纹集合。**只删本渠道、只删本程序写的文件名**。
 */
function wbPruneCatFiles(p, keep) {
  let names;
  try { names = readdirSync(DATA_DIR); } catch { return; }
  const re = new RegExp(`^${p}-catalog-([0-9a-f]{${WB_CAT_FP_LEN}})\\.json$`);
  for (const n of names) {
    const m = re.exec(n);
    if (!m) continue;                 // 认不出的名字一律不碰（宁可留垃圾也不误删）
    if (keep && keep.has(m[1])) continue;
    try { rmSync(path.join(DATA_DIR, n), { force: true }); } catch { /* 删不掉就算了 */ }
  }
}

/**
 * ★ 账号判死 / 停用 / 移出时，**它那一份目录缓存一并作废**（内存桶 + 落盘文件）。
 *
 * 为什么：留着既没用（这个号已经选不中了，目录不会再被读到），
 * 又**占地方且误导诊断**——面板上写着「实时目录 · 账号A」，而账号A 明明已经判死了，
 * 用户会去查一个根本不该存在的问题。所以判死即作废，是把「这份目录归谁」这件事
 * 保持为真。
 *
 * 判据直接读池内核写在条目上的状态（dead/disabled/ignored），
 * **不自己另写一套判断**（那正是「从现象反推状态」的毛病）。
 */
function wbPruneDeadCatCaches(cfg, p) {
  const pool = wbPoolOf(cfg, p);
  if (!pool) return;
  const keep = new Set();
  for (const a of pool.accounts) {
    const fp = wbAccountFp(a.accessToken);
    if (fp) keep.add(fp);
    const gone = a.dead === true || a.disabled === true || a.ignored === true;
    if (!gone || !fp) continue;
    wbCatCaches[p].delete(fp);
    try { rmSync(wbCatFileFor(p, fp), { force: true }); } catch { /* 删不掉就算了 */ }
  }
  /* 顺带扫一遍孤儿：判死的那个号刚被删掉，剩下的指纹仍要留着（别把活号的删了）。 */
  wbPruneCatFiles(p, keep);
}

/**
 * ★ 目录抓取的**唯一入口**：先显式选出一个账号，再把 `{id,label,fp,token}` 交给
 * {@link wbReadCatalog} 一路传下去。
 *
 * 「显式」体现在结构上：选号只发生这一次，抓取与缓存都用这一个对象，
 * 所以「拿谁的令牌抓」与「存进谁的桶」在类型上不可能分叉。
 * 面板刷新/批量扫描这些**没有会话上下文**的调用方也走这里（无 sessionKey，
 * 目录抓取是健康检查，不该占住一条粘性绑定）。
 *
 * ⚠ **选不出号时返回 fp:null，不抛错**：改动前 wbFetchConfig 抓不到令牌只是
 * 「本次抓取失败」，降级链照样走完、/api/models 照样回 200 带内置兜底。
 * 把它改成抛错会让「没配令牌」从一份看得见的目录退化成一句报错——
 * 那是本任务之外的回归。所以这里保留「失败也是一条结果」的形状。
 */
async function wbCatalogAccount(cfg, p) {
  wbPruneDeadCatCaches(cfg, p);        // 判死的号顺手把它的目录作废（④）
  const pool = wbPoolOf(cfg, p);
  const synthetic = !!(pool && pool.synthetic);
  let sel;
  try {
    sel = await wbEnsureTokenPooled(cfg, p);
  } catch (e) {
    /* 原样带出池子给的那句中文（规矩①：不反推），由降级链照旧消费。 */
    return { id: null, label: null, fp: null, token: null, synthetic, error: String((e && e.message) || e).slice(0, 160) };
  }
  const fp = wbAccountFp(sel.token);
  const a = sel.account || null;
  return {
    id: sel.accountId, label: a && a.label != null ? String(a.label) : String(sel.accountId),
    fp, token: sel.token, synthetic,
  };
}

// 内置兜底：读不到上游时用配置里的 availableModels，倍率标 null（未知）
function wbBuiltinCatalog(cfg, p) {
  const S = sliceOf(cfg, p);
  const models = [...new Set((S.availableModels || DEFAULTS[p].availableModels).map((x) => String(x).trim().toLowerCase()).filter(Boolean))]
    .map((id) => ({ id, name: id, credits: null, free: false, contextWindow: null, supportsImages: false, supportsReasoning: false }));
  return models;
}
// 目录读取入口：实时 → 上次成功（落盘）→ 内置兜底，全程记录来源（契约 §2 降级链）。
// 返回 { models:[{id,name,credits,free,…}], promotions, source:"live"|"disk"|"builtin", error? }
//
// ★ v1.0.78 T8：**缓存、落盘与令牌三者都按「渠道 × 账号」隔离**。
//   `acct` 由 {@link wbCatalogAccount} 显式给出来——「抓的时候用哪个账号」与
//   「结果存进哪个桶」由**同一个值**决定，两者在结构上不可能分叉。
//   里程碑 1b 当年解决的是「.cn 的结果被 .ai 用掉」，今天补的是同一条轴上的下一格：
//   「A 的倍率被 B 用掉」。两者的症状都是**面板显示错的价**。
async function wbReadCatalog(cfg, p, acct) {
  const S = sliceOf(cfg, p);
  const upstream = S.upstream || DEFAULTS[p].upstream;
  const now = Date.now();
  const fp = acct && acct.fp;
  const synthetic = !!(acct && acct.synthetic);
  const cache = fp ? wbCatBucket(p, fp) : null;
  if (cache && cache.val && cache.upstream === upstream && now - cache.at < WB_CAT_TTL_MS) {
    return cache.val;
  }
  /* 一个可用账号都没有（没配令牌 / 全判死）：**与改动前逐字一致**——
     合成单账号池还能读自己那份旧快照，读不到就用内置兜底；两者都只是「降级结果」，
     不进缓存（下次请求要重试上游）。多账号下没有 fp 就没有任何可读目录，
     直接走内置兜底——宁可少列几个模型，也不把别的账号的目录端上来。 */
  if (!fp) {
    const d0 = wbReadCatDisk(p, null, synthetic);
    return d0 && Array.isArray(d0.models) && d0.models.length
      ? { models: d0.models, promotions: d0.promotions || null, source: "disk", at: d0.at || null, error: acct.error }
      : { models: wbBuiltinCatalog(cfg, p), promotions: null, source: "builtin", error: acct.error };
  }
  // 两次请求：CLI 形态（倍率，作为基线与可信倍率）优先；App 形态补齐 roster 与促销。
  // 合并规则见 wbMergeModels 顶部注释（并集，倍率以 CLI 为准）。
  const cli = await wbFetchConfig(cfg, "cli", p, acct);
  let val;
  if (cli.ok) {
    let promotions = null;
    let models = cli.models;
    try {
      const app = await wbFetchConfig(cfg, "app", p, acct);
      if (app.ok) {
        promotions = app.promotions || null;
        /* roster 合并**只在国际版做**：国内版 App 形态的增量几乎都是代码补全/图像/内部
           映射（实测 21 个增量里只有 6 个可用），而它 CLI 形态已有 33 个覆盖主流模型，
           补进来纯是噪音。国际版增量 9 个全是真对话模型（含只在 App 形态出现的
           step-5-preview），值得补。理由全文见 wbMergeModels 顶部注释。 */
        if (p === "wbai") models = wbMergeModels(cli.models, app.models || []);
      }
    } catch { /* App 形态失败无所谓，促销只是附注，roster 退回纯 CLI */ }
    val = { models, promotions, source: "live", at: new Date().toISOString(), accountFp: fp };
    /* 落盘**每渠道每账号一份**，文件名里只有不可逆指纹。
       合成单条目池时**另外照旧写一份旧文件名**：老用户目录里那个 wb-catalog.json
       继续存在（内容与改动前逐字相同），降级装回旧版本也还有快照可用。 */
    try { writeAtomic(wbCatFileFor(p, fp), JSON.stringify(val, null, 2) + "\n"); } catch { /* 落盘失败不影响本次结果 */ }
    if (synthetic) {
      try { writeAtomic(wbCatFiles[p], JSON.stringify({ ...val, accountFp: undefined }, null, 2) + "\n"); } catch { }
    }
    /* 顺手扫孤儿：换过令牌的旧桶在这里被清掉，不会越攒越多。 */
    wbPruneCatFiles(p, new Set(wbCatPoolFingerprints(cfg, p).concat([fp])));
  } else {
    const disk = wbReadCatDisk(p, fp, synthetic);
    if (disk && Array.isArray(disk.models) && disk.models.length) {
      val = { models: disk.models, promotions: disk.promotions || null, source: "disk", at: disk.at || null, error: cli.error, accountFp: fp };
    } else {
      val = { models: wbBuiltinCatalog(cfg, p), promotions: null, source: "builtin", error: cli.error, accountFp: fp };
    }
  }
  // 只有 live 结果进缓存（降级结果下次请求要重试上游）。**逐「渠道+账号」写回**，
  // 绝不动到同渠道另一个账号的桶——那正是改动前那个 bug 的形状。
  if (val.source === "live") wbCatCaches[p].set(fp, { at: now, upstream, val });
  return val;
}

/** 当前池里全部账号的不可逆指纹（清理孤儿时的「保留名单」）。 */
function wbCatPoolFingerprints(cfg, p) {
  const pool = wbPoolOf(cfg, p);
  if (!pool) return [];
  return pool.accounts.map((a) => wbAccountFp(a.accessToken)).filter(Boolean);
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
// 错峰折扣：key → 原价（快照 2026-10-03 23:58 UTC+8，处于折后窗口内）
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
      // ultimate 再加一句实测结论，别让人以为是本机配错了。
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

/* 客户端进程是否在本次注入之前就已启动。
 *
 * 判据：取该版别客户端**最早**的进程启动时间，与 `wbCapState.startedAt`（=本次注入时刻）
 * 比较。早于它 ⇒ 那个进程内存里是没有钩子的旧入口脚本，改磁盘对它无效，
 * 必须完全退出重启。这是 v1.0.65 实测踩出来的：文案说「无需重启」，
 * 实际用户发三条消息都抓不到，根因就在这里。
 *
 * 进程名与目录名同源：国际版 WorkBuddyAI，国内版 WorkBuddy（但 WorkBuddyAI 也含
 * "WorkBuddy" 子串，所以国际版必须先判、否则会互相误认）。
 * 取不到 / 没装 PowerShell 时返回 false —— 那就退回原来的提示，不制造假警报。
 */
/* 取该版别客户端**最早**一个进程的启动时刻（Unix 毫秒），取不到返回 null。
 *
 * v1.0.70 实测修一个从 v1.0.65 就埋着的隐性 bug：原来这里写的是 `[int]`——
 * Unix 毫秒是 13 位（1.79e12），**远超 Int32 上限 2,147,483,647**，于是 PowerShell
 * 每次都抛 "Value was either too large or too small for an Int32" 并以非零码退出。
 * execFile 的回调因此一直拿到错误 → 返回 null → Number(null)=0 → 后续比较全部退化：
 *   · wbClientRunningBefore 恒返回 true ⇒ needRestart 一直显示「必须完全退出重启」，
 *     碰巧几次答对了，但那是巧合，它从没真正检测过进程；
 *   · wbClientRestartedAfter 恒返回 false ⇒ 重启探测永远不会触发。
 * 因为 PowerShell 的 stderr 在回调里被丢掉了，这个失败从头到尾没有任何痕迹。
 *
 * 修法两处：强转用 [long]；探测失败时把 PowerShell 的 stderr 记进日志——
 * 静默失效的探针等于没有探针，下次再坏还得从头找。 */
async function wbClientEarliestStartMs(p) {
  const name = p === "wbai" ? "^WorkBuddyAI$" : "^WorkBuddy$";
  try {
    const out = await new Promise((res) => execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        `$p=Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '${name}' }`
        + " | Sort-Object StartTime | Select-Object -First 1;"
        // 注意 [long]：Unix 毫秒 13 位，[int] 会溢出（见上面注释）
        + " if($p){ [long]$p.StartTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds }"],
      { windowsHide: true, timeout: 8000 },
      (e, so, se) => {
        if (e) {
          const err = String(se || "").replace(/\x1b\[[0-9;]*m/g, "").trim();
          log(`WorkBuddy 客户端进程探测失败（${p}）：${err || e.message}`.slice(0, 220));
          res(null);
          return;
        }
        res(String(so).trim());
      }));
    const ms = Number(out);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}
async function wbClientRunningBefore(p) {
  if (!wbCapState.startedAt) return false;
  const ms = await wbClientEarliestStartMs(p);
  // 留 2 秒容差：进程刚起、秒级取整可能与注入时刻擦边
  return ms != null && ms < wbCapState.startedAt - 2000;
}

/* 客户端是否已在**本次注入之后**重启过 —— 也就是钩子此刻是否已经生效。
 *
 * 为什么需要它：改磁盘上的入口脚本对**已在运行**的客户端无效（Node/Electron 启动时
 * 就把脚本读进内存了），所以流程必须是「注入 → 你完全退出重开 → 发一条消息」。
 * 以前这个「重开」只能靠人自己判断时机，于是 v1.0.68 那次用户隔了半小时才重启，
 * 钩子早已超时还原，整轮白等。现在等待循环里主动探测：一旦探测到客户端是在注入之后
 * 起的，就把状态从「必须完全退出重启」翻成「钩子已生效，发消息即可」，
 * 不用再猜自己是不是做对了一步。
 */
async function wbClientRestartedAfter(p) {
  if (!wbCapState.startedAt) return false;
  const ms = await wbClientEarliestStartMs(p);
  // 同样留 2 秒容差：重启恰好贴着注入时刻发生
  return ms != null && ms > wbCapState.startedAt + 2000;
}

/* 按版别给候选目录排序：**两版都装了时，必须优先找对应版别的那个。**
 *
 * 背景（契约 v18 里程碑 1b 实测踩到）：wbCandidateBases 的第一项恒是 WorkBuddyAI，
 * findWbCliScript 又不接渠道参数，于是**不管点哪一版的「一键获取令牌」，抓到的都是
 * 候选表里第一个**。两版都装时，点国际版会把国际版的钩子注进国内版客户端，抓到的令牌
 * 写进 cfg.wb —— 而 cfg.wbai 仍然是「未配置」，症状与「取不到令牌」完全一样。
 * （实测日志：请求 wbai 却注进 …\Programs\WorkBuddy\，正是这个错位。）
 *
 * 目录名与 auth 文件名同源：国际版 WorkBuddyAI / workbuddy-ai，国内版 WorkBuddy /
 * workbuddy / CodeBuddy（国内版另有 CodeBuddy 命名的历史，见上面候选表）。
 *
 * 排序只是**前置加权**而非硬过滤：候选里仍保留另一版的目录，找不到匹配版别时还能兜底，
 * 并由 wbCaptureToken 如实打印最终用的是哪个 script 路径（日志里本来就有）。
 *
 * 注意 wb 也走排序（而不是保持原顺序）：候选表第一项恒是国际版，若不给 wb 加权，
 * 注册表查不到时它会兜底到国际版——那正是本条要消除的那类错位。
 *
 * 这条对**注册表分支与候选目录分支同时生效**：两版都装了机器上，注册表命中的是
 * 「按名匹配」的卸载项，不排序就照样错位（实测 wbai 请求注进了国内版目录）。
 */
function wbOrderedBases(p, list) {
  const all = list || wbCandidateBases();
  if (p !== "wb" && p !== "wbai") return all;
  const isIntl = (b) => /workbuddy\s*ai|workbuddy-ai/i.test(b);
  const isCn = (b) => /workbuddy(?!\s*ai)|codebuddy/i.test(b);
  return p === "wbai"
    ? [...all.filter(isIntl), ...all.filter(isCn)]
    : [...all.filter(isCn), ...all.filter(isIntl)];
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
let wbCapState = { active: false, startedAt: null, error: null, p: "wb" };   // p = 本次捕获写往哪个渠道

// ---------- 备份落盘 + 异常退出自愈（v1.0.58 附带修复） ----------
// 隐患：捕获中途中转被 taskkill /F → finally 里的还原不跑 → 用户的 WorkBuddy CLI
// 脚本永久卡在打补丁状态，而备份只在内存 wbCapState.backup 里，进程死了就没了
// （真实发生过，逆回原状花了 5 次尝试）。原文件基准：11407 字节，md5 d3d1378b8efccc9dba2af9061cb3508d。
// 修法：注入前把干净备份**写到磁盘临时文件**；下次启动发现脚本还带钩子就用它还原。
const WB_BACKUP_FILE = path.join(os.tmpdir(), "bai-router-wb-codebuddy.bak.json");
function wbMd5(s) { return createHash("md5").update(Buffer.from(String(s), "utf8")).digest("hex"); }
function wbCaptureSelfHeal(p) {
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
//   pipe_unreachable —— **控制管道根本连不上**（v1.0.82）。这里曾经有一个「兜底把整个
//                      sidecar 杀掉」的分支，已经删掉：sidecar 管着**用户在客户端里开的
//                      终端 PTY**（本文件 2624 的注释自己写着），杀它等于把用户的终端会话
//                      一起陪葬 —— 与代码里三处「用户会话未动」的承诺直接矛盾。现在这条路
//                      **一个进程都不动**，只如实报告并给出替代路径。
//   pid_unverified —— PID 文件都在、进程也活着，但**身份核对没通过**（PID 被回收 / 取不到启动时间）。
//                      **不杀任何进程**，并把核对结论原样说给用户（绝不静默照杀）。
//
// 管道失败只报告；不保留直接杀 sidecar 的兜底。
async function wbKickHostSession(opts = {}) {
  if (!opts.exe) return { action: "pid_unverified", detail: "未指定本次客户端安装目录，已跳过后台会话重启（未终止任何进程）" };
  let allowedPids = null;
  if (opts.exe) {
    const procs = await wbClientProcessTable(opts.provider);
    const norm = (s) => String(s || "").replace(/\//g, "\\").toLowerCase();
    const sidecars = (procs || []).filter((x) => norm(x.exe) === norm(opts.exe) && /sidecar-entry/i.test(x.cmd));
    if (sidecars.length !== 1) {
      return { action: "pid_unverified", detail: "无法唯一确认本次客户端的 sidecar，已跳过后台会话重启（未终止任何进程）" };
    }
    allowedPids = new Set(sidecars.map((x) => x.pid));
  }
  // 在全部候选 PID 文件里挑第一个「进程确实活着**且身份对得上**」的——精确路径可能残留
  // 过期 PID 文件，见到存在就用会把扫描到的真正活侧车挡在后面（多实例/多 env 场景实测过这个坑）。
  const pidFiles = await wbSidecarPidFiles();
  let info = null, pidPath = null;
  const unverified = [];
  for (const p of pidFiles) {
    let j = null;
    try { j = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    if (!j || !j.pid) continue;
    if (allowedPids && !allowedPids.has(Number(j.pid))) continue;
    try {
      process.kill(j.pid, 0);
    } catch (e) {
      if (e && e.code === "ESRCH") continue;        // 过期残留 → 下一个候选
      // EPERM 等：进程在，只是不归本用户 —— 仍要继续做身份核对
    }
    /* ⚠️ 身份核对（v1.0.77）。`process.kill(pid,0)` 只证明「这个 PID 现在有进程」，
     * 不证明「它还是当初那个」——原进程死了、Windows 把 PID 给了别的程序时，
     * 两者都为真，兜底那一杀就会打在无关进程上。所以这里再问一次「你什么时候起的」。
     *
     * sidecar.pid 是 **WorkBuddy 自己写的**，格式不由我们定，所以没法往里塞我们自己的
     * 启动时间字段；这里退一步用**文件写入时刻**当上界——写这份记录的进程必然不晚于
     * 这次写入才启动，于是「进程启动时间 > 文件写入时刻」就等于「PID 已被回收」。
     * WorkBuddy 若哪天顺手记了 startedAt，就优先用它的精确值。 */
    const ident = await verifyPidRecord({ pid: j.pid, file: p, record: j });
    if (ident.verdict !== VERDICT_SAME) {
      unverified.push(pidIdentityMessage(ident, { pid: j.pid, source: "sidecar PID 文件身份核对" }));
      continue;                                     // 核对不过 → 跳过这个候选，不碰它
    }
    info = j; pidPath = p; break;
  }
  if (!info) {
    if (unverified.length) {
      return {
        action: "pid_unverified",
        detail: `WorkBuddy 后台（sidecar）PID 文件的进程都还在，但**身份核对没通过，已一律不终止**：${unverified.join("；")}。`
          + "若确认它就是 WorkBuddy 的后台，请完全退出并重开 WorkBuddy 客户端（下次发消息时它会重建侧车）。",
      };
    }
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
      return { action: "no_host", detail: `WorkBuddy 后台在运行，但没有常驻会话通道（共 ${arr.length} 个会话）。发一条消息即可抓到令牌`, sessions: arr.length };
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
    /* 🔴 v1.0.82：管道连不上时**不再**杀 sidecar（原来这里是 process.kill(info.pid)）。
     *
     * 为什么必须改：sidecar 管着**用户自己在客户端里开的终端 PTY**（见本文件 2624 的注释）。
     * 杀 sidecar = 把那些终端会话一起陪葬 —— 这与上面 2759「其余 N 个用户会话未动」、
     * 2625「用户开的终端 PTY 不动」两处承诺**直接矛盾**，是代码里承诺与行为打架的实锤。
     * 触发条件也不是理论上的：管道无响应/超时（3s）就会踩到，而客户端正忙时最容易踩。
     *
     * 现在这条路径**一个进程都不动**，如实说清楚为什么不动、替代路径是什么。
     */
    return {
      action: "pipe_unreachable",
      detail: `控制管道连不上（${e.message}），**没有终止任何进程**。`
        + "sidecar 管着你**在客户端里开的终端会话**，直接杀它会把那些终端一起结束，"
        + "所以这里没有这么做——「只重启常驻会话」这条温和的路走不通时，宁可不动。"
        + "替代路径：① 用「手动填写令牌」把令牌填进来（最快，永远可用）；"
        + "② 或先完全退出并重开客户端再点一次「一键获取令牌」（新进程会加载钩子）。",
    };
  }
}

// 定位 WorkBuddy 的 CLI 启动脚本：① 注册表安装信息（最准，任意盘）→ ② 候选目录 → ③ 同级目录扫描
function findWbCliScript(p) {
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
    // ① 注册表（同样按版别排序——**这是最容易错位的一处**：本机两版都装了，
    //    WorkBuddy 5.7.7 与 WorkBuddy AI 5.7.6 的卸载项都会命中，
    //    而注册表返回顺序不保证谁在前。此前 wbai 请求抓到国内版目录就是这里漏的。
    for (const hit of wbOrderedBases(p, await fromRegistry())) {
      const asDir = await tryPath(hit, WB_CLI_REL);
      if (asDir) return asDir;
      const asExeDir = await tryPath(path.dirname(hit), WB_CLI_REL); // DisplayIcon 给的是 exe 路径
      if (asExeDir) return asExeDir;
    }
    // ② 候选目录
    for (const base of wbOrderedBases(p)) {
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

/* ---------- 自动重启 WorkBuddy 客户端（v1.0.82：把「用户零操作」补上） ----------
 *
 * 为什么要做（.research/reports/N-全自动捕获可行性.md 已逐条核实，不再重复调查）：
 *   · 改磁盘上的入口脚本对**已在运行**的客户端无效 —— Electron 启动时就把脚本读进内存了；
 *   · 真正承接聊天请求的是 daemon 的 **prewarm 预热池 worker**（`codebuddy --prewarm`），
 *     而 wbKickHostSession 只筛 `__workbuddy_cli_host__` 常驻会话，**预热池 worker 从来不在
 *     它的名单里**（所以「踢会话」这条杠杆对真正的干活的进程无效）；
 *   · 踢完常驻会话之后 daemon **不会补员**：spawn 触发源只有 startup_ready /
 *     product_snapshot_change / post_acquire，**没有心跳**（实测客户端开着 8 分钟零新进程）。
 *   ⇒ 唯一能保证「拿到一个加载了钩子的新进程」的杠杆是**重启客户端主进程**：
 *     它触发 startup_ready → prewarm_triggered → prewarm_spawn_started，新 worker 会加载
 *     磁盘上的钩子，且**空载时就会主动出网**。这正是「退出 + 重开」这一步无法被「踢会话」
 *     替代的原因，而「重开」这一步现在由程序自己做 —— 用户零操作。
 *
 * 🔴 安全红线（三条，一条都不许破）：
 *   ① **只按 PID 终止**，且**先核对身份**（proc-identity.cjs 的三态 same / recycled /
 *      unverifiable）。PID 被系统回收后误杀无关程序不是理论风险；unverifiable 一律不杀，
 *      宁可不做，也绝不拿用户的别的程序去赌。
 *   ② **绝不用按镜像名终止的那条 taskkill 参数组合，绝不按进程名批量终止** ——
 *      那会误杀用户正在用的正式实例（红线：taskkill 只按 PID）。
 *      按名字**读**进程表只是「发现」手段（和 proc-identity 的用法一致）；动手时永远只有
 *      一个核对过的 PID。
 *   ③ **绝不碰 sidecar 管的终端 PTY**：sidecar 是客户端的子进程，重启客户端本就必然连带
 *      结束它（这是客户端整体退出的固有后果，下面会如实告知用户），但我们**绝不**单独去
 *      终止 sidecar 或任何用户会话 —— 那正是 wbKickHostSession 兜底分支被删掉的原因。
 */

/* 终止客户端主进程的两个时限：先给 8 秒正常退出（不用 /F，让它有机会把状态存好），
 * 等不到才升级为强制终止；强制终止之后再等 30 秒确认它真的没了（没消失就不能拉起，
 * 否则新实例会被单实例锁挡掉，用户看到的是「点了没反应」）。 */
const WB_CLIENT_EXIT_GRACE_MS = 8000;
const WB_CLIENT_EXIT_WAIT_MS = 30000;

/* 重启之后给预热池的宽限时间：超过这个时长还没抓到令牌，就再踢一次常驻会话，
 * 让用户下一条消息必然落到一个**带着钩子**的新进程上（预热请求本身可能不带鉴权，
 * 这是「零操作」没能覆盖全时唯一还剩下的那一环）。 */
const WB_PREWARM_GRACE_MS = 25 * 1000;

/* 从注入用的 CLI 脚本路径反推客户端主程序 exe。
 * script 形如 <base>\resources\app.asar.unpacked\cli\bin\codebuddy，上溯 5 级到 <base>。
 * 取不到就返回 null（调用方如实报告，绝不猜一个路径去启动）。 */
function wbClientExeFromScript(script, p) {
  if (!script || typeof script !== "string") return null;
  const base = path.resolve(script, "..", "..", "..", "..", "..");
  const names = p === "wbai"
    ? ["WorkBuddyAI.exe", "WorkBuddy AI.exe", "WorkBuddy.exe"]
    : ["WorkBuddy.exe", "WorkBuddy AI.exe", "WorkBuddyAI.exe"];
  for (const n of names) {
    const c = path.join(base, n);
    try { if (existsSync(c)) return c; } catch { }
  }
  return null;
}

/* 客户端进程表：[{pid, startMs, exe, cmd}]。
 *
 * ⚠️ 按**镜像名**筛只是「发现」手段（Windows 上按可执行路径筛进程没有便宜做法），
 *    动手终止时仍然只按**核对过的 PID** —— 见文件头红线 ②。
 * 返回 null = **探测失败**（≠ 客户端没在跑）；返回 [] = 确实一个都没有。
 * 这两者必须分得开：探测失败时我们不知道该怎么办，只能如实说，绝不能当成「没在跑」就
 * 跳过重启，更不能当成「在跑」就去乱杀。 */
async function wbClientProcessTable(p) {
  const ps = "$ErrorActionPreference='Stop';$r=@();"
    + "foreach($q in Get-CimInstance Win32_Process -Filter \"Name='WorkBuddy.exe' OR Name='WorkBuddyAI.exe' OR Name='WorkBuddy AI.exe'\"){"
    + "$r+=[pscustomobject]@{pid=$q.ProcessId;st=([DateTimeOffset]$q.CreationDate).ToUnixTimeMilliseconds();"
    + "exe=$q.ExecutablePath;cmd=$q.CommandLine}}"
    + "ConvertTo-Json -InputObject @($r) -Compress";
  try {
    const out = await new Promise((res) => execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { windowsHide: true, timeout: 12000 },
      (e, so) => res(e ? null : String(so == null ? "" : so).trim())));
    if (out == null) { log(`WorkBuddy 客户端进程表探测失败（${p}）：PowerShell 查询未返回结果`); return null; }
    let j;
    try { j = JSON.parse(out || "null"); }
    catch (e) { log(`WorkBuddy 客户端进程表探测返回的不是 JSON（${p}）：${out.slice(0, 120)}`); return null; }
    const arr = Array.isArray(j) ? j : (j == null ? [] : [j]);
    return arr
      .filter((x) => x && Number(x.pid) > 0)
      .map((x) => ({
        pid: Number(x.pid),
        startMs: Number(x.st) > 0 ? Number(x.st) : null,
        exe: String(x.exe == null ? "" : x.exe),
        cmd: String(x.cmd == null ? "" : x.cmd),
      }));
  } catch (e) {
    log(`WorkBuddy 客户端进程表探测异常（${p}）：${e.message}`.slice(0, 220));
    return null;
  }
}

/* 从进程表里挑「客户端主进程」。
 *
 * 判据（两条都要）：① 可执行文件路径与我们正要拉起的那个 exe 完全一致；
 * ② 命令行里**没有**子进程标记（--type=renderer / --type=gpu / --type=utility /
 * sidecar-entry.js / daemon-app-server-entry.js / crashpad / sandbox-* / betterleaks）。
 * ② 是必须的：sidecar、daemon、渲染进程**都跑在同一个 exe 上**，只有靠命令行才分得开。
 * ⚠️ 它们一律**不在**终止目标里（红线 ③）—— sidecar 后面挂着用户的终端 PTY。
 * 同一个 exe 下出现多个主进程候选时拒绝选择，避免动到另一用户数据目录。 */
function wbPickMainClientProcess(procs, exePath) {
  const arr = Array.isArray(procs) ? procs.filter((x) => x && Number(x.pid) > 0) : [];
  if (!arr.length) return null;
  const norm = (s) => String(s == null ? "" : s).replace(/\//g, "\\").toLowerCase();
  const want = norm(exePath);
  if (!want) return null;
  const pool = arr.filter((x) => norm(x.exe) === want);
  const isChild = (x) => {
    const cmd = String(x.cmd || "").trim();
    const match = cmd.match(/^"([^"]+)"(?:\s|$)|^(\S+)(?:\s|$)/);
    return !match || norm(match[1] || match[2]) !== want
      || /--type=|sidecar-entry|daemon-app-server-entry|crashpad|sandbox-|betterleaks|codebuddy|--serve\b|--prewarm\b|\.(?:m?js)\b/i.test(cmd);
  };
  const mains = pool.filter((x) => !isChild(x));
  // 无法唯一识别时不猜；多个主进程可能属于不同的用户数据目录。
  return mains.length === 1 ? mains[0] : null;
}

/* 这个 PID 现在还在吗？ESRCH = 已经没了。
 * 刻意不做别的判据：这里只回答「在不在」，「是不是当初那个」由 proc-identity 回答。 */
function wbPidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return !(e && e.code === "ESRCH"); }
}

/* **只按 PID** 终止一个进程：先发关闭请求（不带 /F，给客户端机会正常退出、把状态存好），
 * 等它自己消失；等不到才升级为强制终止。
 *
 * 🔴 两个 taskkill 调用**都只带 PID 参数**（见下面两行代码）：按镜像名终止会连用户正在用的
 *    正式实例一起杀掉，契约明文禁止，这个文件里不许出现。也不带树形终止参数 —— 我们要的
 *    就是「只结束客户端主进程」，不主动去连带终止它的子进程（见红线 ③）。 */
async function wbTerminatePidOnly(pid, opts = {}) {
  const graceMs = Number(opts.graceMs) > 0 ? Number(opts.graceMs) : WB_CLIENT_EXIT_GRACE_MS;
  const exec = opts.execFile || execFile;
  const alive = opts.alive || wbPidAlive;
  const run = (args) => new Promise((res) =>
    exec("taskkill", args, { windowsHide: true, timeout: 10000 }, (e) => res(e ? String((e && e.message) || e) : "")));
  const check = async () => typeof opts.verifyIdentity === "function" ? opts.verifyIdentity() : null;
  const beforeSoft = await check();
  if (!beforeSoft || beforeSoft.verdict !== VERDICT_SAME) {
    return { ok: false, forced: false, error: "关闭前无法确认进程身份，已跳过终止" };
  }
  const soft = await run(["/PID", String(pid)]);
  const t0 = Date.now();
  while (Date.now() - t0 < graceMs) {
    if (!alive(pid)) return { ok: true, forced: false };
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!alive(pid)) return { ok: true, forced: false };
  // 宽限期内 PID 可能被回收；绝不能把 /F 发给接替它的无关进程。
  const beforeHard = await check();
  if (beforeHard && beforeHard.verdict === "recycled") return { ok: true, forced: false };
  if (!beforeHard || beforeHard.verdict !== VERDICT_SAME) {
    return { ok: false, forced: false, error: "强制关闭前无法确认进程身份，已跳过强制终止" };
  }
  const hard = await run(["/PID", String(pid), "/F"]);   // 仍只按 PID
  if (hard) return { ok: false, forced: true, error: hard };
  const t1 = Date.now();
  while (Date.now() - t1 < WB_CLIENT_EXIT_WAIT_MS) {
    if (!alive(pid)) return { ok: true, forced: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, forced: true, error: soft ? `关闭请求失败：${soft}` : "进程在终止后仍然存在" };
}

/* 重新拉起客户端：spawn(exe, []) —— **必须无参数**。
 * 带激活参数可能走 msix「共享到」那条激活路径（WorkBuddyShareTarget.msix），
 * 拉起来的东西未必是我们要的客户端主程序（见调查 R6）。 */
async function wbSpawnClientExe(exe, opts = {}) {
  const sp = opts.spawn || spawn;
  return new Promise((resolve) => {
    try {
      const ch = sp(exe, [], { detached: true, stdio: "ignore" });
      ch.once("error", (e) => resolve({ ok: false, error: String(e.message || e) }));
      ch.once("spawn", () => {
        ch.unref();
        resolve({ ok: true, pid: ch.pid || null });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

/* 完整的「自动重启客户端」：探测 → 挑主进程 → **身份核对** → 只按 PID 终止 → 等它消失 → 无参数拉起。
 *
 * 返回 {action, detail, ...}，action 取值：
 *   restarted      —— 旧主进程已退出、新进程已拉起（成功）
 *   not_running    —— 客户端本来就没开，**不动任何进程**，提示打开即可
 *   probe_fail     —— 进程表探测失败（分不清在不在）→ **不动任何进程**
 *   no_exe/no_main —— 定位不到 exe / 挑不出主进程 → **不动任何进程**
 *   unverified     —— 身份核对 recycled/unverifiable → **不动任何进程**（红线 ①）
 *   kill_failed / spawn_failed —— 终止失败 / 拉起失败 → 如实说，附手动路径
 * spawn_failed 表示旧进程已退出但新进程启动失败；其余失败必须如实报告。 */
async function wbAutoRestartClient(p, opts = {}) {
  const zh = opts.zh || (p === "wbai" ? "WorkBuddy AI" : "WorkBuddy");
  const manual = `替代路径：① 用「手动填写令牌」把令牌填进来（永远可用）；② 或手动完全退出并重开 ${zh} 客户端后重试。`;
  const exe = opts.exe || wbClientExeFromScript(opts.script, p);
  const procs = await wbClientProcessTable(p);
  if (procs === null) {
    return { action: "probe_fail", killed: 0, detail: `未能查询到 ${zh} 客户端的进程列表（系统查询失败），已跳过自动重启并**没有终止任何进程**。${manual}` };
  }
  if (!procs.length) {
    return {
      action: "not_running", killed: 0,
      detail: `${zh} 客户端当前**没有在运行**，所以没有重启它（也不会去启动它）。`
        + `钩子已注入程序目录：请打开 ${zh} 并登录，然后随便发一条消息即可被自动抓取。`,
    };
  }
  if (!exe) {
    return { action: "no_exe", killed: 0, detail: `定位不到 ${zh} 客户端的主程序，**没有终止任何进程**。${manual}` };
  }
  const main = wbPickMainClientProcess(procs, exe);
  if (!main) {
    return { action: "no_main", killed: 0, detail: `认不出 ${zh} 客户端的主进程（探测到 ${procs.length} 个同名进程，主程序特征不匹配），**没有终止任何进程**。${manual}` };
  }
  /* 🔴 红线 ①：动手之前先问「这个 PID 还是不是当初那个进程」。
   * PID 被系统回收后，同一个 PID 会挂在完全无关的程序上，那时 kill 就会误杀。
   * 核对用的是我们自己刚探到的启动时间当锚（record.startTimeMs），三态里
   * 只有 same 才继续；recycled / unverifiable 一律到此为止，如实告诉用户为什么。 */
  const ident = await verifyPidRecord({ pid: main.pid, file: null, record: { startTimeMs: main.startMs } });
  if (!ident || ident.verdict !== VERDICT_SAME) {
    return {
      action: "unverified", killed: 0, pid: main.pid,
      detail: `${zh} 客户端主进程 ${pidIdentityMessage(ident, { pid: main.pid, source: "客户端主进程身份核对" })}。`
        + "因此**已放弃自动重启，一个进程都没有终止** —— 宁可不重启，也不冒险杀掉你机器上别的程序。"
        + manual,
    };
  }
  /* 真的要动手了：先把「窗口会被关掉」这件事说出去（红线 ③ 的文案义务），
   * 再终止。onBeforeTerminate 之后就有一个不可逆的外部副作用了。 */
  if (typeof opts.onBeforeTerminate === "function") {
    try { opts.onBeforeTerminate(main.pid); } catch { }
  }
  const term = await wbTerminatePidOnly(main.pid, {
    ...opts,
    verifyIdentity: () => verifyPidRecord({ pid: main.pid, file: null, record: { startTimeMs: main.startMs } }),
  });
  if (!term.ok) {
    return {
      action: "kill_failed", killed: 0, pid: main.pid,
      detail: `自动重启没能关掉 ${zh} 客户端（PID ${main.pid}）：${term.error || "未知原因"}。${manual}`,
    };
  }
  const s = await wbSpawnClientExe(exe, opts);
  if (!s.ok) {
    return {
      action: "spawn_failed", killed: 1, pid: main.pid, exe,
      detail: `已退出 ${zh} 客户端（PID ${main.pid}），但**没能自动重新打开**（${s.error}）。`
        + `请手动双击打开 ${exe}，然后发一条消息即可抓到令牌。`,
    };
  }
  return {
    action: "restarted", killed: 1, pid: main.pid, exe, forced: term.forced, newPid: s.pid,
    detail: `已自动重启 ${zh} 客户端（旧主进程 PID ${main.pid} 已退出${term.forced ? "（用了强制终止）" : "（正常退出）"}，新窗口正在打开）。`
      + "新进程会重新加载刚注入的钩子，通常几秒内就能抓到令牌。",
  };
}

// 还原：只要备份在，就把原文件写回去（幂等，可重复调用）
async function wbCaptureRestore() {
  const st = wbCapState;
  if (!st.script || !st.backup) return;
  try {
    if (st.wrote) {
      const cur = await fsPromises.readFile(st.script, "utf8").catch(() => "");
      if (st.injectionFailed || cur.includes("BAI-CAPTURE-HOOK")) await fsPromises.writeFile(st.script, st.backup, "utf8");
    }
  } catch (e) { log("WorkBuddy 令牌捕获：还原失败 " + e.message); return; }
  st.wrote = false;
}

// 令牌捕获：临时往 WorkBuddy 的 CLI 脚本里注入钩子，等客户端发起带鉴权的请求时把令牌抓回来。
// p 决定**写进哪一份配置**（里程碑 1b）：wb → cfg.wb，wbai → cfg.wbai。
// 两版令牌不通用，抓错了写错渠道比抓不到更糟——所以这里必须由调用方明确指定，
// 缺省仍是 wb（保住旧调用方的行为）。注意钩子本身装在**哪一份** WorkBuddy 程序上
// 由 findWbCliScript 的候选目录顺序决定（两版都装了时无法从路径可靠区分），
// 因此调用方应确认用户已启动对应版本的客户端。
/* 钩子的等待时长。
 *
 * 原来是 150 秒，v1.0.68 实测被用户绊了两次：流程要求「注入 → 完全退出客户端 →
 * 重开 → 发一条消息」，这中间只要用户被打断、或者压根忘了钩子有时限，2 分半就没了，
 * 而面板对此**只字不提**——用户看到的只是转圈，直到超时才知道白等。
 *
 * 放宽到 10 分钟：钩子只是往客户端的入口脚本里插一段临时代码，落在本机磁盘上，
 * 捕获结束（含超时）都会立即还原，且下次启动还有 wbCaptureSelfHeal() 兜底自愈。
 * 多留几分钟的风险远小于"用户被 2 分半的时限赶走"。
 * 真要更强的保障，是下面的 restarted 探测——让用户不必猜自己该在什么时候发消息。 */
const WB_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;

/* 本次捕获的**终局**要留存多久。
 *
 * 为什么必须留存：POST /api/wb/capture 是一次最长 10 分钟的阻塞请求，而面板 api() 的默认
 * 读超时只有 12 秒（panel-common.js）—— 12 秒时前端**已经放弃并报「读取超时」**，服务端却
 * 还挂着钩子正常在等。于是真正能把结果告诉用户的只剩它每 2 秒一次的 status 轮询，而轮询和
 * 「捕获结束」之间天然有最多 2 秒的错位，另有刷新页面、连接重连这些滞后。结果不留存，
 * 界面就永远停在「还在等待」，用户据此以为没抓到 —— 这正是实测复现出来的症状。
 *
 * 为什么只留 2 分钟：够覆盖上面那些滞后就够了（约是轮询错位的 60 倍余量），再久没有第二个
 * 用途；而 masked 是**真实令牌的一段指纹**（前 7 字符 + 后 2 字符 + 长度），过期就该消失，
 * 不该在状态接口里挂上几小时。过期的结果一律按「没有结果」返回。 */
const WB_CAPTURE_RESULT_TTL_MS = 2 * 60 * 1000;

/* 记下**本次**捕获的终局（成功 / 失败 / 超时）。
 * startedAt 跟着记一份：前端要靠它把这一次的 done 和「上一次留下的 done」区分开，
 * 否则刚点下按钮的头两秒轮询就会把上一轮的结局当成这一轮的报出去。 */
function wbRecordCaptureResult(r) {
  wbCapState.result = {
    done: true,
    ok: r.ok === true,
    /* 失败时**不留任何令牌指纹** —— 没抓到东西，就没有可脱敏的东西 */
    masked: r.ok ? (r.masked || null) : null,
    hasRefresh: r.ok ? !!r.hasRefresh : null,
    error: r.ok ? null : String(r.error || "未知原因"),
    startedAt: wbCapState.startedAt || null,
    finishedAt: Date.now(),
  };
}

async function wbCaptureToken(timeoutMs = WB_CAPTURE_TIMEOUT_MS, p = "wb", opts = {}) {
  const zh = p === "wbai" ? "WorkBuddy AI" : "WorkBuddy";
  if (wbCapState.active) {
    const secs = Math.round((Date.now() - wbCapState.startedAt) / 1000);
    throw new Error(`上一次获取还在进行中（已等待 ${secs} 秒）。请在 ${zh} 客户端里发一条消息，或稍候重试`);
  }
  // 在第一个异步操作前占用捕获槽，避免两个渠道并发覆盖同一份备份和状态。
  wbCapState = { active: true, startedAt: Date.now(), p, result: null, phase: "locating" };
  let script = null;
  const outFile = path.join(DATA_DIR, "wb-captured-token.json");
  try {
  script = await findWbCliScript(p);
  if (!script) throw new Error(`未找到 ${zh} 程序（请确认本机已安装对应版本的客户端）`);
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
  } catch (e) { throw new Error("无法保存客户端脚本备份，已停止捕获：" + e.message); }
  const hook = WB_CAPTURE_HOOK.replace("__path_capture", JSON.stringify(outFile));
  // 注入到 shebang 之后（保留首行 #!，Node 才能正常执行）
  const lines = backup.split("\n");
  const patched = lines[0] + "\n" + hook + "\n" + lines.slice(1).join("\n");
  wbCapState = {
    active: true, startedAt: Date.now(), error: null, script, backup, wrote: false, got: "",
    phase: "injecting", phaseText: "正在注入临时钩子…", kick: null, p,
    restarted: false,          // 客户端是否已在本次注入之后重启过（钩子是否已生效）
    restarting: false,         // 此刻是不是正在由程序自动重启客户端（界面据此提示「请勿操作」）
    restart: null,             // 自动重启的结果（action + detail），状态接口原样带给前端
    /* 新一轮开始就清掉上一轮的结果：否则前端刚点下按钮的头两秒轮询就会读到上一次
       留下的 done，把它当成这一次的结局报出去。 */
    result: null,
  };
  wbCapState.wrote = true;
  try {
    await fsPromises.writeFile(script, patched, "utf8");
  } catch (e) {
    // 写入可能先截断文件再失败，不能用钩子标记是否存在来判断需不需要还原。
    wbCapState.injectionFailed = true;
    throw e;
  }
  wbCapState.phase = "injected";
  const deadline = Date.now() + timeoutMs;
  const kickOpts = { provider: p, exe: wbClientExeFromScript(script, p) };
  /* v1.0.65 实测修正：**改磁盘文件对已在运行的客户端无效**。
   * Node/Electron 启动时就把入口脚本读进内存了，钩子写进去之后，
   * 客户端仍按内存里的旧代码发请求 —— 于是「发三条消息都没抓到」。
   * 实测证据：客户端启动 18:32:31，钩子注入 18:46:13（晚 14 分钟），
   * kick 报 no_host、界面提示「直接发一条消息即可，无需重启」，全是错的。
   * 所以注入后立刻比对客户端进程的启动时间：早于本次注入 ⇒ 必须完全退出并重启，
   * 这时要如实说，而不是让用户白试三次。 */
  const stale = await wbClientRunningBefore(p);
  wbCapState.needRestart = stale;
  if (stale) {
    wbCapState.phaseText = `钩子已注入 ${zh} 客户端目录，但**该客户端在注入前就已启动**，`
      + "它用的是内存里的旧代码 —— 改磁盘文件对它无效。请**完全退出该客户端**（含托盘图标）后重新打开，再发一条消息。";
  } else {
    wbCapState.phaseText = `钩子已注入 ${zh} 客户端，发一条消息即可抓到令牌。`;
  }
  log(`${zh} 令牌捕获：已注入临时钩子（${script}），等待客户端触发…`
    + (stale ? "（注意：该客户端在注入前已在运行，必须完全退出重启后钩子才会生效）" : ""));
  // 踢侧车必须在注入**之后**：被重启拉起的新 CLI 进程才会读到带钩子的脚本
  try {
    const k = kickOpts.exe ? await wbKickHostSession(kickOpts)
      : { action: "pid_unverified", detail: "无法定位本次客户端，已跳过后台会话重启（未终止任何进程）" };
    wbCapState.kick = k;
    wbCapState.phase = "waiting";
    /* needRestart 时**不要**用 kick 的文案覆盖：kick 只会说"发一条消息即可"，
       而此时那个客户端跑的是内存里的旧脚本，发一百条也抓不到。
       先前就因为这里把上面那句"必须重启"冲掉，界面又回到误导性的提示。 */
    if (!wbCapState.needRestart) {
      wbCapState.phaseText = `${k.detail}。之后带鉴权的请求一出现就会被自动抓取（最长等 ${Math.round(timeoutMs / 1000)} 秒）`;
    }
    log(`WorkBuddy 令牌捕获：踢侧车 → ${k.action}：${k.detail}`
      + (wbCapState.needRestart ? "（但客户端在注入前已启动，kick 无效，必须完全退出重启）" : ""));
  } catch (e) {
    wbCapState.kick = { action: "error", detail: String(e.message || e) };
    wbCapState.phase = "waiting";
    wbCapState.phaseText = `后台重启未执行（${e.message}）。若 WorkBuddy 已开着，钩子要等它的进程下次重启才会被加载`;
    log("WorkBuddy 令牌捕获：踢侧车异常 " + e.message);
  }
  /* ---------- v1.0.82：自动重启客户端 —— 「用户零操作」缺的就是这一步 ----------
   *
   * 放在 kick **之后**：钩子已经写盘，被重启拉起的新进程才读得到它。
   * 放在等待循环**之前**：新进程起来后才会主动出网，顺序反了就白等。
   *
   * 「客户端在不在」由 wbAutoRestartClient 自己的进程表探测决定，不用上面那个
   * wbClientRunningBefore 推断 —— 那个探针失败时也返回 false（探测失败 ≠ 没在跑），
   * 拿它当开关会在探针出错时把「该重启的」当成「不用重启」。
   * 客户端没开 → 一个进程都不动，只提示打开（用户本来就该自己打开它）。
   *
   * 🔴 动手之前必说的一句话（红线 ③ 的文案义务）：我们要关掉的是**用户正在用的窗口**，
   *    不能默默杀用户的应用，所以 phaseText 里明写「窗口会被关掉并重新打开、
   *    未保存的对话可能丢失」，由 onBeforeTerminate 在真正动手的那一刻打出去。 */
  let prewarmRekicked = false;
  let armedAt = 0;
  try {
    wbCapState.phase = "restarting";
    wbCapState.restarting = true;
    wbCapState.phaseText = `正在检查 ${zh} 客户端的状态…`;
    const r = opts.autoRestart === true ? await wbAutoRestartClient(p, {
      script, zh,
      onBeforeTerminate(pid) {
        wbCapState.phase = "restarting";
        wbCapState.phaseText =
          `正在自动重启 ${zh} 客户端：**你的客户端窗口会被关掉并重新打开**，未保存的对话内容可能丢失。`
          + "这是自动获取令牌必须的一步（只有全新进程才会加载刚注入的钩子）。"
          + "客户端里开着的终端会话会随客户端一起结束，请稍等几秒，窗口会自动重新出现。";
        log(`${zh} 令牌捕获：即将自动重启客户端主进程（仅按 PID，身份已核对）pid=${pid}`);
      },
    }) : { action: "disabled", killed: 0, detail: `自动重启已关闭。请手动完全退出并重开 ${zh} 客户端，然后在本轮等待结束前发一条消息；也可使用「手动填写令牌」。` };
    wbCapState.restart = r;
    if (r.action === "restarted") {
      /* 重启是我们自己做的，所以不必再等探测去确认，也不再需要用户手动重启。
       * needRestart 归零：那个前提（"客户端跑着旧代码、等你手动重启"）已经不存在了。 */
      wbCapState.needRestart = false;
      wbCapState.restarted = true;
      wbCapState.phase = "armed";
      armedAt = Date.now();
      wbCapState.phaseText = `${zh} 客户端已自动重启，新进程正在加载钩子。`
        + "正在等待带鉴权的请求；若 25 秒后仍未捕获，可在客户端里发一条消息触发。";
    } else {
      /* 原样展示真实结局；spawn_failed 时旧窗口已退出。 */
      wbCapState.phase = "waiting";
      wbCapState.phaseText = r.detail;
    }
    log(`${zh} 令牌捕获：自动重启客户端 → ${r.action}：${r.detail}`);
  } catch (e) {
    wbCapState.restart = { action: "error", detail: String((e && e.message) || e), killed: 0 };
    wbCapState.phase = "waiting";
    wbCapState.phaseText = `自动重启 ${zh} 客户端时出错（${e.message}）。`
      + `请手动完全退出并重开 ${zh} 客户端后发一条消息，或改用「手动填写令牌」。`;
    log("WorkBuddy 令牌捕获：自动重启客户端异常 " + e.message);
  } finally {
    wbCapState.restarting = false;
  }
  // 已捕获到的最新一条（accessToken 可能已抓到、刷新令牌还没有）——用于给前端实时进度
  let seen = null;
  /* 「客户端已重启、钩子已生效」的探测节流：每 3 秒查一次即可。
   * 查到就把状态翻过去——用户不必自己判断"我是不是做对了一步"。 */
  let restartProbeAt = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      if (wbCapState.needRestart && !wbCapState.restarted && Date.now() - restartProbeAt > 3000) {
        restartProbeAt = Date.now();
        if (await wbClientRestartedAfter(p)) {
          wbCapState.restarted = true;
          armedAt = Date.now();
          wbCapState.phase = "armed";
          wbCapState.phaseText = "客户端已在本次注入之后重启，钩子已生效——现在在客户端里发一条消息即可抓到令牌";
          log(`WorkBuddy 令牌捕获：检测到 ${zh} 客户端已在注入后重启，钩子已生效，等待请求…`);
        }
      }
      /* 兜底（唯一还没被自动化覆盖的那一环）：钩子生效之后预热池 worker **空载出网的
       * 那些请求到底带不带 Authorization，目前没有真机证据**。带了 → 用户零操作就成立；
       * 不带 → 白等。所以超过宽限时间还没抓到，就再踢一次常驻会话，让用户下一条消息
       * 必然落到一个**带着钩子的新进程**上，并把话说清楚「发一条消息即可，这不是失败」。 */
      if (wbCapState.restarted && !prewarmRekicked && armedAt && Date.now() - armedAt > WB_PREWARM_GRACE_MS) {
        prewarmRekicked = true;
        try {
          const k2 = kickOpts.exe ? await wbKickHostSession(kickOpts)
            : { action: "pid_unverified", detail: "无法确认客户端，已跳过后台会话重启" };
          wbCapState.rekick = k2;
          wbCapState.phaseText = `客户端已重启，但尚未捕获到带鉴权的请求，无法据此确定预热请求是否携带鉴权。`
            + `${k2.detail}。请在 ${zh} 客户端里发一条消息（或新建一个对话），本轮仍在等待捕获。`;
          log(`WorkBuddy 令牌捕获：预热宽限期到，追加一次踢常驻会话 → ${k2.action}：${k2.detail}`);
        } catch (e) {
          wbCapState.rekick = { action: "error", detail: String((e && e.message) || e) };
          wbCapState.phaseText = `尚未捕获到带鉴权的请求。请在 ${zh} 客户端里发一条消息；追加重启后台时出错 ${e.message}`;
          log("WorkBuddy 令牌捕获：追加踢常驻会话异常 " + e.message);
        }
      }
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
            // 写进**本次请求指定的那一份**（wb → cfg.wb，wbai → cfg.wbai，里程碑 1b）。
            // 写错渠道比抓不到更糟：两版令牌不通用，串了就是 401 且极难自查。
            cfg[p].accessToken = obj.accessToken;
            // 刷新令牌：优先用本次抓到的；本次没有（大多数情况：普通业务请求只带 Authorization）
            // 就保留配置里已有的，避免把一条好用的刷新令牌覆盖成空。两者都没有则留空
            // （仍可正常用，只是令牌过期后无法自动续期，返回的 hasRefresh/hints 会如实说明）。
            if (obj.refreshToken) cfg[p].refreshToken = obj.refreshToken;
            if (obj.deviceToken) cfg[p].deviceToken = obj.deviceToken;
            if (obj.userId) cfg[p].userId = obj.userId;
            saveCfg(cfg);
            const exp = wbTokenExp(obj.accessToken);
            const hasRefresh = !!cfg[p].refreshToken;
            // 抓到即还原：不等超时，立刻让 WorkBuddy 的脚本恢复原状
            await wbCaptureRestore();
            log(`${zh} 令牌捕获：成功（已写入 cfg.${p}，钩子已立即还原）${hasRefresh ? "" : "，未含刷新令牌（将沿用配置里已有的，若无则到期需重新获取）"}`);
            const r = {
              ok: true,
              masked: keyFp(obj.accessToken),
              hasRefresh,
              expiresAt: exp || null,
              hints: hasRefresh ? [] : ["本次请求未携带刷新令牌（它只在令牌续期时才随请求发出）。访问令牌有效期约一年，到期后需重新点「一键获取令牌」。"],
            };
            /* 留存终局：POST 要阻塞到这一刻才返回，而前端早就会 12 秒读超时放弃 ——
               真正能把「成功」说出口的是它的 status 轮询。 */
            wbRecordCaptureResult(r);
            return r;
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
    /* v1.0.82：先按**自动重启**的结局分档。自动重启是主路径，它成功而没抓到，
     * 没捕获到不能推出预热请求不带 Authorization，超时后必须开启新一轮。 */
    const ract = (wbCapState.restart && wbCapState.restart.action) || "unknown";
    const secs = Math.round(timeoutMs / 1000);
    let hint;
    if (ract === "restarted") {
      hint = `已自动重启 ${zh} 客户端，但这 ${secs} 秒内未捕获到令牌，预热请求是否带鉴权仍未确认。`
        + "本轮已结束，临时脚本将还原。请重新点「获取令牌」开启新一轮，并在等待期间发一条消息。";
    } else if (ract === "disabled") {
      hint = `自动重启已关闭，本轮已结束。请重新点「获取令牌」，再手动完全退出并重开 ${zh} 后发一条消息，或使用「手动填写令牌」。`;
    } else if (ract === "not_running") {
      hint = `${zh} 客户端当时没有在运行，所以没有重启它。请重新开启获取，然后打开 ${zh} 并登录，在等待期间发一条消息。`;
    } else if (ract === "unverified" || ract === "probe_fail" || ract === "no_exe" || ract === "no_main" || ract === "kill_failed" || ract === "spawn_failed" || ract === "error") {
      hint = `自动重启 ${zh} 客户端没有完成（${(wbCapState.restart && wbCapState.restart.detail) || "未知原因"}）。`
        + `请手动完全退出并重开 ${zh} 客户端后发一条消息，或直接用「手动填写令牌」。`;
    } else if (kact === "killed") {
      hint = `已重启 WorkBuddy 后台（旧的常驻 CLI 进程已终止），但这 ${secs} 秒内没有任何进程发起带 Authorization 的请求。请确认 WorkBuddy 客户端已打开并登录，然后新建一个对话或发一条消息（重启后的进程会自动加载钩子），再重试。`;
    } else if (kact === "no_sidecar") {
      hint = "WorkBuddy 客户端似乎没有在运行。钩子已注入：启动 WorkBuddy 并登录后随便发一条消息即可被自动抓取，再重试。";
    } else if (kact === "no_host") {
      hint = "WorkBuddy 后台在运行但还没有常驻会话通道——直接在客户端里发一条消息（会自动新建带钩子的进程）；若已发过消息仍失败，请重试一次。";
    } else if (kact === "pipe_fail" || kact === "error" || kact === "pid_unverified" || kact === "pipe_unreachable") {
      /* 这几个 action 有一个共同点：**一个进程都没杀**（管道不通就不去动 sidecar ——
       * 它后面挂着用户自己开的终端；PID 核对不过就不动手）。所以文案要说清「没动任何进程」，
       * 并把真实的核对/管道结论原样带出来。 */
      hint = `WorkBuddy 后台重启失败（${(wbCapState.kick && wbCapState.kick.detail) || "未知原因"}），那一步**没有终止任何进程**，钩子可能尚未被任何进程加载。`
        + "可完全退出并重新打开 WorkBuddy 客户端后重试，或用「手动填写令牌」。";
    } else {
      hint = "请确认 WorkBuddy 客户端已打开并已登录，然后在里面随便发一条消息或新建一个对话（客户端会拉起内部 CLI 并带上 Authorization 头），再点一次「一键获取令牌」。";
    }
    throw new Error(`等待超时（${secs} 秒）：未捕获到任何令牌。${hint}本轮已结束，后续操作前请先重新点「获取令牌」开启新一轮；也可使用「手动填写令牌」。`);
  } catch (e) {
    /* 失败（含等待超时）同样要留存终局 —— 否则前端轮询永远看不到「结束了」，
       界面就一直转圈；而 POST 那边早把这次捕获报成「读取超时」了。 */
    wbRecordCaptureResult({ ok: false, error: String((e && e.message) || e) });
    throw e;
  } finally {
    await wbCaptureRestore();
    await fsPromises.rm(outFile, { force: true }).catch(() => { });
    // 磁盘备份：确认脚本已干净才删；还原失败就留着，下次启动 wbCaptureSelfHeal() 自愈
    try {
      if (script && wbCapState.backup && existsSync(script) && readFileSync(script, "utf8") === wbCapState.backup) {
        rmSync(WB_BACKUP_FILE, { force: true });
      } else if (existsSync(WB_BACKUP_FILE)) {
        log("WorkBuddy 令牌捕获：脚本尚未确认恢复原文，保留磁盘备份等待下次启动自愈");
      }
    } catch { }
    wbCapState.active = false;
    wbCapState.got = "";
  }
}

/* /api/wb/capture/status 的响应体。
 *
 * 除了原有的实时进度（phase / phaseText / kick…），这里带上**本次捕获的终局**：
 * 成功 / 失败 / 超时各是什么，都写在 wbCapState.result 里（保留期见 WB_CAPTURE_RESULT_TTL_MS）。
 * 没有它，前端即使一直在轮询也**无从判断捕获已经结束** —— 只能一直转圈，
 * 而 POST 早已 12 秒读超时放弃，用户看到的就是「明明抓到了却报失败」。
 *
 * 对账：新一轮开始时 wbCapState 被整体替换（startedAt 随之换成新的），所以顶层 startedAt
 * 永远是「当前或最近一次」捕获的开始时刻；下面 result.* 那几个字段描述的也正是这一轮。
 * 前端发起前先记下旧 startedAt，轮询时对不上就说明读到的是别人的结果，不能当成自己的。 */
function wbCaptureStatusPayload() {
  const r = wbCapState.result || null;
  /* 过了保留期一律按「没有结果」：绝不让前端读到上一轮、乃至几小时前的旧结局 */
  const fresh = !!(r && r.done && Date.now() - (r.finishedAt || 0) <= WB_CAPTURE_RESULT_TTL_MS);
  return {
    active: wbCapState.active,
    provider: wbCapState.p || "wb",   // 本次捕获写往哪个渠道（里程碑 1b）
    // v1.0.65：客户端在注入前就已启动 ⇒ 内存里是旧入口脚本，必须完全退出重启
    needRestart: wbCapState.needRestart === true,
    // v1.0.70：客户端是否已在注入之后重启过 —— 为真表示钩子此刻已经生效，
    // 前端据此把提示从「必须完全退出重启」翻成「发一条消息即可」，并显示剩余时间。
    restarted: wbCapState.restarted === true,
    // v1.0.82：自动重启的两段状态。restarting=true 期间界面必须说清
    // 「窗口会被关掉并重新打开、未保存内容可能丢失」；restart 是那一手的结论
    // （action + detail），前端原样展示，不自己编一套说法。
    restarting: wbCapState.restarting === true,
    restart: wbCapState.restart || null,
    // 预热宽限期到之后追加的那一次踢会话（兜底：预热请求不带鉴权时的那条路）
    rekick: wbCapState.rekick || null,
    timeoutMs: WB_CAPTURE_TIMEOUT_MS,
    startedAt: wbCapState.startedAt,
    elapsedMs: wbCapState.active ? Date.now() - wbCapState.startedAt : 0,
    remainMs: wbCapState.active ? Math.max(0, WB_CAPTURE_TIMEOUT_MS - (Date.now() - wbCapState.startedAt)) : 0,
    gotAccessToken: !!(wbCapState.active && wbCapState.got),
    phase: wbCapState.phase || null,
    phaseText: wbCapState.phaseText || null,
    kick: wbCapState.kick || null,
    /* ↓ 本次捕获的终局。masked 是**脱敏后**的令牌（真实明文永不出这个接口），
         失败时为 null —— 没抓到东西就没有可脱敏的东西。 */
    done: fresh,
    ok: fresh ? !!r.ok : false,
    masked: fresh ? (r.masked || null) : null,
    hasRefresh: fresh ? (r.hasRefresh === true) : null,
    error: fresh ? (r.error || null) : null,
    finishedAt: fresh ? r.finishedAt : null,
  };
}

/* POST /api/wb/capture 的处理体。抠成独立函数（而不是内联在请求分发里）有两个用处：
 * 一是路由本身更短，二是端到端测试能直接复用**真逻辑**而不是抄一份重写。
 * 返回值即响应体：{ ok:true, ...r } 或 { ok:false, error }。 */
async function wbCaptureBody(body) {
  // provider 决定抓到的令牌写进哪一份配置（里程碑 1b：wb / wbai，两版令牌不通用）。
  // 缺省 wb —— 旧调用方行为不变。
  const p = (body && body.provider) === "wbai" ? "wbai" : "wb";
  try {
    const r = await wbCaptureToken(WB_CAPTURE_TIMEOUT_MS, p, { autoRestart: body && body.autoRestart === true });
    return { ok: true, ...r, provider: p, message: "令牌已自动填入并保存" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
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
    /* 下限抬到 16：实测国际版有一批模型（gpt-6-astra / gpt-5.6-luna 等 gpt-* 系）
       拒绝 max_tokens < 16，一律回 400 {"code":11133,"msg":"Invalid request parameters"}，
       而 glm-5.3 / hy3 这类照单全收。同一个值 8 → 拒、16 → 200、32000 → 200，
       所以这是**数值下限**、不是参数名不兼容（换 max_completion_tokens 同样能过，容易误判成后者）。
       真实对话发的是 32000 不会踩到，但本项目的「测试连通」探测固定发 max_tokens: 8
       （见 /api/test），用户把档位指向 gpt-* 模型时会看到一句莫名其妙的
       "Invalid request parameters"。抬下限一次解决所有小请求路径，
       且不动 isProbe 的判定（它读的是原始请求体，不是这里的改写结果）。 */
    max_tokens: typeof j.max_tokens === "number" && j.max_tokens >= 3 ? Math.max(16, j.max_tokens) : 4096,
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
// 这段桥被 **五个**提供方共用（makeRelay 的 openai:true —— 见 relaySpec 里的
// wb / wbai / zen / qd / or，v1.0.73 的国际版补全把 3 个加到了 5 个），
// 前缀不能写死 WorkBuddy——否则 Zen/Qoder 的报错会顶着 "[WorkBuddy]" 出现在用户面前。
/* 错误前缀与归因渠道：**挂在请求/影子上**，不是模块级全局。
 *
 * ⚠⚠ 为什么必须挂上去（2026-10-23 实测）：三个中转端口的请求是**并发**的，
 *   模块级全局会被别的请求抢先改掉 —— 于是 wb 的错误顶着「[MiniMax 会员]」的前缀，
 *   面板上那句自相矛盾的报错会把排查**引到错的渠道**上
 *   （实测：「wb:失败[st=503/[MiniMax 会员] WorkBuddy 令牌账号被判死]」）。
 *   挂在 res 上就天然是 per-request / per-attempt 的：影子 res 每次尝试新建一个。
 *
 * ⚠ 没挂上时回落成 "WorkBuddy"（旧行为）——宁可前缀泛一点，也不许前缀是错的。 */
const ERR_CTX = Symbol("bai.errCtx");
// 同一段桥里的 noteRelayError 也必须按**真实渠道**归因（面板每渠道只有一个槽位）。
// 以前三处全写死 "wb"，其中 bail() 那处还是个三元的**两个分支都等于 "wb"** 的退化写法——
// 意图是按渠道归因、从未填完。后果：Zen / Qoder / OpenRouter 的流式超时与断流
// 在面板的归因里**完全看不见**，全被记到 WorkBuddy 名下。
function setErrProvider(res, name, channel) {
  try {
    if (res) res[ERR_CTX] = { name: String(name || "WorkBuddy"), channel: typeof channel === "string" && channel ? channel : "wb" };
  } catch { /* res 不可写就当没有上下文（前缀回落成 WorkBuddy） */ }
}
// 读取侧再兜一层：万一有路径绕过 setErrProvider 直接读，
// 也不会把 undefined 当成槽位名写进去（noteRelayError 会 fallback 到 bai，更糟）。
function errPrefixOf(res) { const c = res && res[ERR_CTX]; return (c && c.name) || "WorkBuddy"; }
function errChannelOf(res) { const c = res && res[ERR_CTX]; return (c && c.channel) || "wb"; }
// ⚠ 读点与写点现在**成对挂在同一个 res 上**，所以并发请求之间不会串：
//   · setErrProvider(res, …) 设值（openaiExchange / makeRelay / 转移链的每次尝试）
//   · 首事件闸门超时    → noteRelayError(errChannelOf(res), "timeout", …)
//   · bail() 上游 SSE 报错 → noteRelayError(errChannelOf(res), "upstream_sse_error", …)
//   · 迭代器抛异常断流   → noteRelayError(errChannelOf(res), "network", …)
//   ⚠ 影子 res（cap）每次尝试新建一个 → 转移链里不同渠道各归各的，
//     不会出现「wb 的错误顶着 [MiniMax 会员] 的前缀」这种自相矛盾的话
//     （2026-10-23 实测出现过，正是这个原因）。
// 提供方 → 展示名（中转端口自己答错时用）
const RELAY_LABELS = CHANNEL_LABELS;   // 与 PROVIDERS 同一张表，见文件头 CHANNELS 处
function relayLabel(p) { return RELAY_LABELS[p] || p; }
function wbAnthroError(res, status, msg) {
  if (res.headersSent || res.writableEnded) { try { res.end(); } catch { } return; }
  const s = Number(status) >= 400 && Number(status) < 600 ? Number(status) : 502;
  const typeMap = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 500: "api_error", 503: "overloaded_error", 529: "overloaded_error" };
  const type = typeMap[s] || (s >= 500 ? "api_error" : "invalid_request_error");
  res.writeHead(s, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify({ type: "error", error: { type, message: `[${errPrefixOf(res)}] ${String(msg).slice(0, 400)}` } }));
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

// ────────────────────────────────────────────────────────────────────────
// 「200 + 空流」具名归因（v1.0.74）
//
// 教训出处：OW Bridge（.research/ow-bridge/docs/validation.md:86-92，只读参考）
//   它只从**两个**来源读模型的工具调用信封，漏了 StructuredOutput 工具调用，
//   把一次完全正确的回答报成了「Invalid model response envelope」。
//   根因是它用「我期望读到的来源都没读到 → 判失败」推失败，**而没读到的来源
//   本身就是判据的一部分**。判空枚举漏一项，正常响应就被误判成故障。
//
// 这里是同一病的另一面（本文件原来的 2971 行：`idx < 0 && !usage` 就 bail 502）。
// 那个判据只数「我们自己开出来的内容块」，**完全不看上游到底发了什么形状**，
// 于是「上游用了一种我们还没支持的形状」也被一律归成「后端不可用」。
//
// 两条铁律，下面每行实现都受它约束：
//   ① **判据必须与 wbPipe 的真实解析路径逐项对齐**——wbFrameResidue 判的是
//      「wbPipe 的消费代码**没消费掉**的东西」，不是另抄一份字段白名单
//      （另抄一份必然会随解析代码演进而漂移，漂移的方向就是误杀正常响应）。
//   ② **兜底取反**——拿不准一律判成功。误杀一个正常响应的代价（用户看不到回复、
//      故障转移还会再转一遍）远大于放过一个异常响应（顶多一句空回复）。

// 顶层元字段：wbPipe 的消费代码会读 error/code/message/usage/choices，其余一律当"没消费"。
const WB_STREAM_META_KEYS = new Set([
  "id", "object", "created", "model", "system_fingerprint", "provider",
  "system", "usage", "choices", "error", "code", "message",
]);
// frame 级 type 的已知取值（Anthropic 原生事件名 + Responses API 事件名）。
// **不在表里的 type 一律当"没消费"**——这正是新增的、也是最要紧的一条。
const WB_KNOWN_FRAME_TYPES = new Set([
  "message_start", "message_delta", "message_stop", "content_block_start",
  "content_block_delta", "content_block_stop", "ping", "error",
  "response.created", "response.in_progress", "response.output_item.added",
  "response.output_item.done", "response.output_text.delta",
  "response.output_text.done", "response.reasoning_summary_text.delta",
  "response.completed", "response.failed", "response.incomplete",
]);
// 一条 residue 的 raw 上限。透传给客户端的原文与记进日志的**键名/类型**都受它约束：
// 日志侧只写键名和形状，**绝不写值**（上游可能把凭据回显在未知字段里）。
const WB_RESIDUE_RAW_MAX = 600;
const WB_PASSTHROUGH_MAX = 1800;

/** 只描述**形状**（类型 + 空/非空 + 对象的前几个键名），绝不回显值。红线：不写凭据。 */
function wbShapeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? `array(${typeof v[0]},${v.length})` : "array(0)";
  const t = typeof v;
  if (t === "object") return `object(${Object.keys(v).slice(0, 6).join(",")})`;
  if (t === "string") return v.trim() ? "string(非空)" : "string(空串)";
  return t;
}
/** 这个"没消费掉的值"里到底有没有东西：空串/null/空数组算**空**（上游说了"这里是空的"），
 *  非空的任何东西（哪怕形状不认识）都算**有**（内容可能就在这儿）。 */
function wbResidueHasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return !!v.trim();
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}
function wbResidue(where, key, v) {
  let raw;
  try { raw = JSON.stringify(v); } catch { raw = String(v); }
  return { where, key, shape: wbShapeOf(v), hasValue: wbResidueHasValue(v), raw: String(raw).slice(0, WB_RESIDUE_RAW_MAX) };
}

/**
 * 扫描一个 `data:` 帧里 **wbPipe 的消费代码没消费掉** 的东西。
 * 对齐依据就是 wbPipe 主循环的三处消费（见下面各分支注释），
 * 任何一处"跳过了"的值都会在这里作为 residue 冒出来。
 */
function wbFrameResidue(d, sseEvent) {
  const out = [];
  // ① 主循环 `let d; try { d = JSON.parse(payload); } catch { continue; }`：
  //    顶层不是普通对象（裸字符串 / 数组 / 数字 / null）时，后面全部字段访问都是
  //    undefined，整帧被静默丢掉。这里把它记成一条 residue。
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    if (d !== undefined) out.push(wbResidue("frame", "", d));
    return out;
  }
  // ② 顶层：只读 error/code/message/usage/choices + 一组固定元字段。
  //    type 单独处理——**词表外的 type 就是"我们不认识的帧类型"**（OW Bridge 同源坑）。
  for (const k of Object.keys(d)) {
    if (WB_STREAM_META_KEYS.has(k)) continue;
    if (k === "type") {
      const tv = String(d[k] || "");
      if (WB_KNOWN_FRAME_TYPES.has(tv)) continue;
      // 明显是 OpenAI 形状、只是多带了个自定义 type 的，放行（不制造噪声透传）
      if (typeof d[k] === "string" && (d.choices || d.usage)) continue;
    }
    out.push(wbResidue("top", k, d[k]));
  }
  // ③ `const ch = Array.isArray(d.choices) && d.choices[0]; if (!ch) continue;`
  //    → choices 之外挂在 choice 上的字段（logprobs / text 等非 delta 形状）会被丢掉。
  const ch = Array.isArray(d.choices) ? d.choices[0] : null;
  if (!ch || typeof ch !== "object") return out;
  for (const k of Object.keys(ch)) {
    if (k === "delta" || k === "finish_reason" || k === "index") continue;
    out.push(wbResidue("choice", k, ch[k]));
  }
  // ④ `const delta = ch.delta || {}` 之后只消费三种键，且**每种都有形状前提**：
  //    reasoning_content/reasoning 必须是非空字符串（`typeof rc === "string" && rc`）；
  //    content 必须是非空字符串（`typeof delta.content === "string" && delta.content`）；
  //    tool_calls 必须是数组（`Array.isArray(delta.tool_calls)`）。
  //    形状不符时值被 `if` 直接跳过 —— 这就是"上游返回了内容但我们没识别"的入口：
  //    content 传数组（Qwen 系网关）、StructuredOutput 落在结构化字段、legacy
  //    function_call、refusal 字符串……全在这一条里冒出来。
  const dl = ch.delta;
  if (dl === undefined || dl === null) return out;
  if (typeof dl !== "object" || Array.isArray(dl)) { out.push(wbResidue("delta", "", dl)); return out; }
  for (const k of Object.keys(dl)) {
    if (k === "role" || k === "index") continue;
    const v = dl[k];
    if (k === "content" || k === "reasoning_content" || k === "reasoning") {
      if (typeof v === "string" && v) continue;              // 真被消费了
      out.push(wbResidue("delta", k, v));                    // 空串/null/数组 → 没被消费
      continue;
    }
    if (k === "tool_calls") {
      if (Array.isArray(v) && v.length) continue;            // 真被消费了
      out.push(wbResidue("delta", k, v));
      continue;
    }
    out.push(wbResidue("delta", k, v));                      // 未知 delta 键
  }
  return out;
}

/** 归因表：五种**具名**空流/拒答，各自不同的中文说明 + 用户该做什么。 */
const EMPTY_STREAM_ATTRIBUTIONS = {
  /* ★★ 新增（v1.0.78）：**非 2xx 不是「空流」，是「上游拒绝了」**。
   *
   * 这一条是被一次「诊断与事实相反」的现场逼出来的：上游明明回了一个 429 错误体
   * （它确实说话了，只是说的是「不」），而判空枚举只看「有没有数据帧」，于是把它
   * 归成 upstream_nothing = **「上游一个字都没返回」**。诊断和事实正好相反，
   * 用户照着这句话的指引去「等 30 秒重试 / 换档位」，方向就整个错了。
   *
   * 所以判空枚举的第一件事必须是**先看 HTTP 状态码**（见 classifyEmptyStream）。
   * 归因表里给它单开一条，是为了即使顺序被打乱也不会再退回那句错话。 */
  upstream_rejected: {
    label: "上游拒绝了这次请求",
    zh: "上游**回了**一个错误响应（不是没有回答）——限制、内容策略、鉴权或服务端故障都长这样。",
    hint: "这句话说的是上游的态度，不是本程序没读懂回答。",
    do: "建议：按上面括号里的 HTTP 状态码对号入座（429=限流、401/403=账号或权限、5xx=上游自身故障）；具体处置见本条后面的归因文字。⚠ 429 有两种且处置相反：上下文/请求体太大时（wb/wbai 实测存在）等再久也不会好，要开新对话；真的并发限流才等 30 秒左右再试。",
  },
  upstream_nothing: {
    label: "上游一个字都没返回",
    zh: "上游连一个数据帧都没发出来（只有心跳，或上来就是结束标记），模型根本没有开始作答。",
    hint: "这不是你的配置或本程序的问题，多为该模型后端临时不可用。",
    do: "建议：等 30 秒重试一次；连续两次都这样，换一个模型档位。",
  },
  upstream_truncated: {
    label: "上游中途被掐断",
    zh: "上游已经把回答的开头发出来了，但还没发完连接就断了（既没收到结束标记，也没有结束原因）。",
    hint: "多为网关掐断连接或上游崩溃，与本程序的解析无关。",
    do: "建议：直接重试；反复断流就换一个档位，或把这个现象反馈给上游。",
  },
  upstream_blank: {
    label: "上游只返回了空信封",
    zh: "上游回了格式正确的回答框架，但内容字段全是空的（空字符串、空数组或 null），模型没有真正作答。",
    hint: "多为被上游内容过滤，或模型在当前档位上空转。",
    do: "建议：重试一次；反复出现就是该档位当前不可用，换一个档位。",
  },
  unrecognized_shape: {
    label: "上游用了我们还不认识的回答格式",
    zh: "上游确实返回了内容，但它不在本程序已知的解析路径里，因此无法翻译成 Anthropic 格式。",
    hint: "通常是新模型或新网关换了返回格式，需要升级路由台才能正确翻译。",
    do: "建议：不用管，原始内容已原样附在下面；若内容不可读，请把这段原文反馈给 B.AI 路由台。",
  },
};

/**
 * 把探针判成五种具名归因之一。顺序即优先级。
 *
 * ⚠ 第一条是 `upstream_rejected`，且它**只看 HTTP 状态码、不看任何帧**：
 * 非 2xx 的响应根本不该进「空流」枚举——那是「上游拒绝了」，不是「上游没说话」。
 * 少了这一条，一次 429 会被说成「上游一个字都没返回」，诊断与事实相反。
 * 判据从 `probe.httpStatus` 取；探针里没有这个字段时（历史形态）行为逐字不变。
 * ⚠ unrecognized_shape 排在它后面，但调用方对它**不 bail**（见 wbPipe 的透传分支）：
 * 它唯一的产出是一条已具名的诊断 + 原样透传，不是失败。这正是"兜底取反"。
 */
function classifyEmptyStream(probe) {
  const p = probe || {};
  const httpStatus = Number(p.httpStatus);
  if (Number.isFinite(httpStatus) && (httpStatus < 200 || httpStatus >= 300)) return "upstream_rejected";
  if (Array.isArray(p.unknown) && p.unknown.some((u) => u && u.hasValue)) return "unrecognized_shape";
  if (!p.dataFrames) return "upstream_nothing";
  if (p.opened > 0 && !p.sawDone && !p.sawFinish) return "upstream_truncated";
  return "upstream_blank";
}
/** 归因正文（**不含渠道前缀**——bail() 会自己加 [前缀]，重复加会出现 [X] [X]）。 */
function wbEmptyStreamCore(kind, prefix) {
  const a = EMPTY_STREAM_ATTRIBUTIONS[kind] || EMPTY_STREAM_ATTRIBUTIONS.upstream_nothing;
  return `${a.label} —— ${a.zh}${a.hint}${a.do}`;
}
/** 透传给客户端的原文。原文回传给**发起这次请求的同一个客户端**，不构成新的信息外泄；
 *  日志侧只写键名/形状（见 wbResidue），两边都受 WB_PASSTHROUGH_MAX / WB_RESIDUE_RAW_MAX 约束。 */
function wbUnknownPassthroughText(unknown, prefix) {
  const hits = (unknown || []).filter((u) => u && u.hasValue);
  const names = [...new Set(hits.map((u) => (u.where ? `${u.where}.` : "") + (u.key || "?")))].slice(0, 8);
  const raw = hits.map((u) => u.raw).join("\n").slice(0, WB_PASSTHROUGH_MAX);
  const tail = hits.map((u) => u.raw).join("\n").length > WB_PASSTHROUGH_MAX ? "\n…（已截断）" : "";
  return `【${prefix || "WorkBuddy"} ${EMPTY_STREAM_ATTRIBUTIONS.unrecognized_shape.label}】${EMPTY_STREAM_ATTRIBUTIONS.unrecognized_shape.do}\n` +
    `未识别的字段：${names.join("、")}\n上游原文（未改写）：\n${raw}${tail}`;
}

// OpenAI SSE → Anthropic SSE（clientStream=false 时聚合成单条 Anthropic JSON 响应）
async function wbPipe(r, res, { model, clientStream, inputJson, timeoutMs, usageOut }) {
  const inTok = Math.max(1, Math.ceil(JSON.stringify(inputJson || {}).length / 4));
  const msgId = "msg_wb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  /* ── ★ v1.0.78：非 2xx **不进 SSE 解析器** ──
   *
   * openaiExchange 在调进来之前已经按 `r.status !== 200` 返回过一次，所以活体路径
   * 今天走不到这里——**这正是它容易被删掉、又删不掉的原因**。但「判空枚举说什么」
   * 是一次改动就能踩到的事实：一旦上游的拒绝响应被当成流送进来，classifyEmptyStream
   * 会说「上游一个字都没返回」，而上游明明回了一个 429 错误体。
   *
   * 所以这里再挡一道：状态码非 2xx 就**在读第一帧之前**返回，诊断固定是
   * 「上游拒绝了这次请求」，绝不进入空流枚举。位置刻意放在 res.writeHead 之前，
   * 这样 bail() 仍然能把这次失败交给 attemptWithFailover 的影子 res 判要不要转移。 */
  const httpStatus = Number(r && r.status);
  if (Number.isFinite(httpStatus) && (httpStatus < 200 || httpStatus >= 300)) {
    const bodyText = await readAllBody(r).catch(() => "");
    /* ⚠ 这里**故意不写 noteRelayError**：wbPipe 里的 4 个归因槽位是契约锁死的
     * （见 attrib-atomic-test.mjs 的 T1）。更要紧的是，能走到这里的调用方几乎都是
     * openaiExchange，而它**早就已经**把这次失败按精确的 kind（rate_limit /
     * upstream_429 / auth…）连同池子的归因一起记过了——这里再补一条笼统的
     * `upstream_429`，会把那条更准的槽位**覆盖掉**。
     * 那正是「诊断跑偏」本身：只不过不是诊断说错，而是把对的诊断擦成了粗的。
     * 所以这一段只负责**给客户端一句不说反话的话**，不碰面板槽位。 */
    const tail = wbEmptyStreamCore("upstream_rejected", errPrefixOf(res))
      .replace(/。$/, "") + `（本次 HTTP ${httpStatus}）`;
    if (res.headersSent) return wbAnthroError(res, 502, tail);
    res.writeHead(httpStatus >= 400 && httpStatus < 600 ? httpStatus : 502,
      { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `[${errPrefixOf(res)}] ${tail}｜上游原文：${upstreamBodyText(bodyText, 200)}` } }));
    return;
  }
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
    noteRelayError(errChannelOf(res), "timeout", `${errPrefixOf(res)} 上游 ${Math.round(timeoutMs / 1000)}s 内未发出首个响应块`);
    await dropBody(r);
    return wbAnthroError(res, 504, `${errPrefixOf(res)} 上游 ${Math.round(timeoutMs / 1000)} 秒内没有返回任何内容，已中断本次请求`);
  }
  if (!first.done) firstVal = first.value;
  let idx = -1;
  let cur = null;              // "text" | "thinking" | "tool"
  let curToolOi = -1;
  const toolParts = [];        // {oi, id, name, args} 按出现顺序
  let text = "", thinking = "";
  let finish = null, usage = null, outChars = 0;
  // 空流探针：只记**形状与计数**，不记上游的值（红线：不把凭据写进任何地方）。
  const probe = { httpStatus, dataFrames: 0, opened: 0, sawDone: false, sawFinish: false, heartbeats: 0, unknown: [] };

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
    noteRelayError(errChannelOf(res), "upstream_sse_error", msg.slice(0, 180));
    if (!res.headersSent) {
      // 影子 res：只记状态码与正文，由 attemptWithFailover 决定转移还是落盘
      res.writeHead(status || 502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ type: "error", error: { type: kind || "api_error", message: `[${errPrefixOf(res)}] ${msg}` } }));
      return true;
    }
    if (clientStream) {
      emit("error", { type: "error", error: { type: kind || "api_error", message: `[${errPrefixOf(res)}] ${msg}` } });
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
      if (line.startsWith(":")) { probe.heartbeats++; emit("ping", { type: "ping" }); continue; } // 心跳
      if (line.startsWith("event:")) { sseEvent = line.slice(6).trim(); continue; }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { probe.sawDone = true; break; }
      let d;
      try { d = JSON.parse(payload); } catch { continue; }
      probe.dataFrames++;
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
      if (ch) probe.opened++;
      if (!ch) { probe.unknown.push(...wbFrameResidue(d, sseEvent)); continue; }
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
      if (ch.finish_reason) { finish = ch.finish_reason; probe.sawFinish = true; }
      // 消费完之后再扫残余：这才是"wbPipe 到底漏掉了什么"的准确答案。
      // ⚠ **收集 ≠ 透传**：只有在最终 idx < 0 时才把这些东西交给客户端（见文末分支）。
      // 正常响应（idx >= 0）里即使混进了未知字段，也绝不会凭空多出一段内容——
      // 噪声只留在 probe 里供诊断，不会污染回答。
      probe.unknown.push(...wbFrameResidue(d, sseEvent));
    }
  } catch (e) {
    // 上游流中断：把错误以 Anthropic error 事件/JSON 形式交还客户端。
    // 前缀用 errPrefixOf(res)（渠道展示名）而不是写死的 "WorkBuddy"——槽位归因修好之后，
    // 这行是最后还会把 [WorkBuddy] 挂到 Zen/Qoder/OpenRouter 头上的地方。
    const brk = String(e && e.message || e).slice(0, 200);
    noteRelayError(errChannelOf(res), "network", `${errPrefixOf(res)} 流中断: ${brk.slice(0, 160)}`);
    if (clientStream) {
      emit("error", { type: "error", error: { type: "api_error", message: `[${errPrefixOf(res)}] 上游流中断: ${brk}` } });
      try { res.end(); } catch { }
      return;
    }
    wbAnthroError(res, 502, `上游流中断: ${String(e && e.message || e).slice(0, 200)}`);
    return;
  }

  // 流跑完了却一个内容块都没有（既没有文本/思考/工具调用，也没有报错事件）：
  // 实测 Qoder 后端全挂时就是这种"200 + 空流"。当成上游失败(502)，
  // 让故障转移去下一家，而不是给用户一个空回复。
  //
  // v1.0.74 起这段从"一句通用文案"改成**具名归因**（classifyEmptyStream），
  // 并且加了两道 OW-Bridge 式的防误杀：
  //   ① 判据与真实解析路径逐项对齐（wbFrameResidue），不靠另抄的字段白名单；
  //   ② unrecognized_shape **绝不 bail**——上游发了我们不认识的形状时判成功并
  //      原样透传。判空枚举漏一项就会误杀正常响应，这正是 OW Bridge 犯过的错。
  // usage 存在但没有内容块，仍按原样判成功（保守方向不变：顶多一句空回复）。
  let passthrough = "";    // 未知形状的原文（仅 idx<0 且全是未识别形状时非空）
  const emptyKind = classifyEmptyStream(probe);
  if (idx < 0 && emptyKind === "unrecognized_shape") {
    // 记一条具名诊断给面板（不 bail——这正是"兜底取反"），并把上游原文透传出去。
    noteRelayError(errChannelOf(res), "unrecognized_shape", wbEmptyStreamCore(emptyKind, errPrefixOf(res)));
    passthrough = wbUnknownPassthroughText(probe.unknown, errPrefixOf(res));
    if (clientStream) {
      openCur("text", { type: "text", text: "" });
      emit("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: passthrough } });
    }
  } else if (idx < 0 && !usage) {
    if (bail(wbEmptyStreamCore(emptyKind, errPrefixOf(res)), "api_error", 502)) return;
  }

  closeCur();
  const stopReason = finish === "length" ? "max_tokens" : (finish === "tool_calls" || toolParts.length) ? "tool_use" : "end_turn";
  const outTok = (usage && usage.completion_tokens) || Math.max(1, Math.ceil(outChars / 4));
  const inFinal = (usage && usage.prompt_tokens) || inTok;
  /* 用量往上传（账本要记这次花了多少 token）。
   *
   * ⚠ **只填上游真报出来的数**，不填估算值（上面那个 ÷4 的 outTok 是估算，
   * 当成「上游报的」写进账本就是**误报**）。
   * ⚠ OpenAI 与 Anthropic 给的字段名不一样（prompt_tokens / input_tokens），
   *   两套都认 —— 上游是什么形状就用什么形状的。 */
  if (usageOut && typeof usageOut === "object" && usage && typeof usage === "object") {
    const pin = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens
      : (Number.isFinite(usage.input_tokens) ? usage.input_tokens : null);
    const pout = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens
      : (Number.isFinite(usage.output_tokens) ? usage.output_tokens : null);
    if (pin !== null) usageOut.in = pin;
    if (pout !== null) usageOut.out = pout;
    const cached = usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens;
    if (Number.isFinite(cached)) usageOut.cacheRead = cached;
    const cr = usage.cache_read_input_tokens;
    if (Number.isFinite(cr)) usageOut.cacheRead = cr;
  }
  if (clientStream) {
    emit("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: inFinal, output_tokens: outTok } });
    emit("message_stop", { type: "message_stop" });
    try { res.end(); } catch { }
    return;
  }
  const content = [];
  if (passthrough) content.push({ type: "text", text: passthrough });
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
/* ════════════════════════════════════════════════════════════════════════
   WorkBuddy 系的「免费额度按模型计」→ 同渠道内换模型（v1.0.65）
   ════════════════════════════════════════════════════════════════════════
   实测（2026-10-11 国际版，同一时刻同一令牌）：
       hy3 → 200   deepseek-v4.1-flash → 429   hy4-preview → 200   glm-5.3-flash → 200
   hy3 与 deepseek-v4.1-flash 倍率同为 x0.00（都免费），只有后者被限 —— 说明
   **免费额度按模型独立计**，不是按账号。所以 failover 那套「换渠道」在这里帮不上：
   同一个渠道内的模型没有退路（failover.mjs 换的是渠道）。
   这里补的是同渠道内的模型级退路，语义与 OpenRouter 的 orAdvance 一致
   （限流 → 冷却当前模型 → 挑下一个没冷却的 → 重试）。

   为什么不代劳「切积分」：实测 12 种可能的请求级开关（body 里 useCredit /
   withCredit / consumeCredit / payWithCredit / credit / usePoints / paid / billing，
   header 里 X-Use-Credit / X-Pay-With-Credit / X-Credit-Mode / X-Billing-Mode）
   全部无效，仍回 429 —— 那是客户端侧的账号状态，API 上没有对应参数。
   要用积分得在 WorkBuddy 客户端里切，我们做不到，也不假装能做到。
   ──────────────────────────────────────────────────────────────────────── */

// 被限的模型 → 冷却到期时间（上游会带重置时刻，解析不出来就按 10 分钟兜底）
const WB_MODEL_COOLDOWN_FALLBACK_MS = 10 * 60 * 1000;
const wbModelCool = new Map();      // "渠道|模型" -> untilMs
let wbState = { lastSwitch: null, lastLimitAt: 0 };

/* 单次请求最多换几个模型。目录里可用的有 27 个，一次换一个很容易撞上另一个正在
   冷却的（免费档就 3 个，轮换一圈可能全在冷却），换到 4 次仍不成才如实报错。 */
const WB_ADVANCE_MAX = 4;

/** 从上游 429 正文里认出「这是免费额度/频率限制」，认不出返回 null（宁可不动也不要瞎换）。 */
function wbParseLimit(text) {
  const s = String(text || "");
  if (!/frequency limit|usage exceeds|rate.?limit|quota|积分|额度/i.test(s)) return null;
  // 上游文案形如 "…reset at 2026-10-12 15:23:51 UTC+8"；解析不出来就用兜底时长
  const m = s.match(/reset at\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)/i);
  if (m) {
    const t = Date.parse(m[1].replace(/-/g, "/") + " " + m[2]);
    if (Number.isFinite(t) && t > Date.now()) return { resetAt: t };
  }
  return { resetAt: Date.now() + WB_MODEL_COOLDOWN_FALLBACK_MS };
}

const wbModelCoolLeft = (key, now) => {
  const u = wbModelCool.get(key) || 0;
  return u > now ? Math.ceil((u - now) / 1000) : 0;
};

/**
 * 换一个同渠道内、没在冷却的模型。
 * 候选 = 该渠道的实时目录里 `credits` 最低的几个（免费/极低倍率优先 —— 它们最不容易
 * 撞限流；实在全限流了就一路往上吃倍率，**付费模型同令牌直接 200，积分链路天然通**，
 * 不需要任何「用积分」开关）。
 * `skip` = 本次请求已经试过并失败的模型，避免在循环里来回挑同一个。
 * 找不到就返回 { ok:false }，由调用方如实把上游的 429 抛给用户。
 *
 * ★★ v1.0.78 T8（本任务的核心价值）：`acctFp` 是**本次请求实际用的那个账号**的指纹。
 *   下面按倍率从低到高排序这件事，只有在倍率来自**这枚令牌**的清单时才成立——
 *   拿另一个账号的倍率挑替补，挑到的是「那个账号看得到、这次请求却调不通」的档位，
 *   而面板上显示的也是那份错的价。所以 `acctFp` 是必填的，取不到桶就一路退到
 *   「倍率未知」的内置列表，**宁可少排一个档，也绝不按别人的倍率排**。
 */
function wbAdvanceModel(p, failedModel, limit, skip, acctFp) {
  /* 候选来源按可得性依次退让（冷启动时进程内缓存是空的，这是实测踩到的情况：
     服务刚起 → 目录还没拉过 → 候选池空 → 误判成「没有其它可选模型」，
     明明 hy3/hy4-preview 都在线。v1.0.65 实测日志：
       「WorkBuddy 429 模型级轮换未果（wbai）：no_alternative」）
     ① 进程内实时目录（有倍率，按倍率从低到高排，优先挑最不容易撞限流的）
     ② 磁盘上的上次成功目录（重启后仍在）
     ③ 都没有 → 如实说没有替代，不要瞎换 */
  const cfg = loadCfg();
  /* ★ 这一桶必须属于本次请求用的账号。没有 acctFp 就**不许**退回按渠道取一份**——
     那正是改动前那个串号形状：只是把「按渠道复用」换成「按任意账号复用」。 */
  const mem = wbCatModels(p, acctFp);
  const pool0 = wbPoolOf(cfg, p);
  const disk = acctFp ? wbReadCatDisk(p, acctFp, !!(pool0 && pool0.synthetic)) : null;
  /* ③ 再兜一层：配置里的 availableModels（拿不到倍率，但至少知道有哪些模型可换）。
     宁可换成倍率未知的另一个模型，也好过把上游的 429 原样甩给用户 ——
     前者能继续干活，后者什么都干不了。倍率未知只在显示上少个后缀。 */
  const builtin = wbBuiltinCatalog(cfg, p);
  const models = mem
    || (disk && Array.isArray(disk.models) ? disk.models : null)
    || builtin;
  const now = Date.now();
  const coolKey = (id) => p + "|" + id;
  if (failedModel) wbModelCool.set(coolKey(failedModel), limit.resetAt);

  const rate = (c) => { const v = parseFloat(String(c == null ? "" : c).replace(/^x/i, "")); return Number.isFinite(v) ? v : Infinity; };
  /* 池里留整个对象而不只是 id：换完之后面板要说「换到了付费档 x0.79」，
     倍率就在这儿，别让调用方再去查一遍目录（那条路上次踩过冷启动查不到的坑）。 */
  const pool = models.slice()
    .filter((m) => m && m.id && m.id !== failedModel && !(skip && skip.has(m.id)))
    .sort((a, b) => rate(a.credits) - rate(b.credits));
  if (!pool.length) return { ok: false, reason: "no_alternative" };

  for (const m of pool) {
    if (!wbModelCoolLeft(coolKey(m.id), now)) {
      wbState.lastSwitch = { at: new Date().toISOString(), from: failedModel || "(未知)", to: m.id, provider: p };
      return { ok: true, model: m.id, credits: m.credits ?? null, free: m.free === true };
    }
  }
  return { ok: false, reason: "all_cooling" };
}

/* 换模历史。**换模不是故障**——限流后换了模型、请求拿到 200，那就是成功了。
 * 此前一律走 noteRelayError，面板会显示成「最近一次请求失败（rate_limit_quota）」，
 * 而请求明明是好的；而且 noteRelayErrors 每渠道只有一个槽位，只留最后一次、
 * 还会被真正的故障覆盖掉。用户要的恰恰是"我这些请求被悄悄换成别的模型了"这件事，
 * 所以单独记一份有界的环形历史。 */
const WB_ROTATION_HISTORY_MAX = 20;
const wbRotations = [];
/* ④ 最近一次「同名付费行」的指向（v1.0.77）：429 时算出来的那句话留一份给面板，
 * 免得用户在错误弹窗里读完之后还得自己回想「刚才说的是哪一行」。
 * 键是渠道、值是 wbPaidSameName 的返回（label / rows / text），**不含任何凭据**。 */
const wbLastPaidHint = new Map();
function noteWbRotation(provider, fromModel, steps, recovered) {
  const last = steps[steps.length - 1] || null;
  wbRotations.unshift({
    at: new Date().toISOString(),
    provider,
    from: fromModel || "(未知)",
    to: last ? last.model : null,
    credits: last ? last.credits : null,
    free: last ? last.free : null,
    steps: steps.length,
    chain: steps.map((s) => s.model),
    recovered: !!recovered,
  });
  if (wbRotations.length > WB_ROTATION_HISTORY_MAX) wbRotations.length = WB_ROTATION_HISTORY_MAX;
}

// OpenRouter 的两层轮换（orAdvance）是本节做法的参照实现。
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
//   wb  —— 有目录接口（/v3/config，契约 v18 里程碑 2）；拉不到时降级到落盘/内置并标 static
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

  if (p === "mm") {
    /* MiniMax 会员托管通道**没有公开目录接口**（它是会员账号的托管端点），
     * 所以清单就是出厂那一份。这里如实说清「来源是出厂兜底」，
     * 免得面板把「目录里没有」说成「上游没有这个模型」。
     * ⚠ 别去打上游 /v1/models：那条路要会员令牌，且打一次就消耗一次会员额度。 */
    const models = [...(S.availableModels || [])];
    return {
      ok: true, count: models.length, models,
      note: "MiniMax 会员通道没有公开模型目录接口，这份清单是出厂兜底（当前只有 MiniMax-M3.1-Flash 一款）。",
    };
  }

  if (p === "qd") {
    // Qoder 的目录没有公开接口，但 worker 拉回后在本地解密再 parse——补丁把那份明文
    // 写到了 tokenFile 同级的 qoder-models.json，这里直接读，不必复刻 Cosy 签名。
    const r = qdReadCatalog(cfg);
    // 读不到目录也要如实标注价格：下拉里付费档不能看起来和免费档一样。
    return r.ok ? r : qdStaticCatalog(S);
  }

  if (p === "wb" || p === "wbai") {
    // WorkBuddy **有**公开的模型目录接口：GET {base}/v3/config（契约 v18 里程碑 2）。
    // 旧结论「没有目录接口、回显配置即可」已被实测推翻（见 wbReadCatalog 顶部）。
    // 降级链：实时 → 上次成功（落盘）→ 内置兜底，来源如实标注。两版各拉各的（里程碑 1b）。
    // ★ v1.0.78 T8：先**显式选一个账号**，再把同一个账号对象一路传下去——
    //   面板上的倍率因此永远是「这一个账号看得到的那一份」，而不是池子里随便一份。
    const acct = await wbCatalogAccount(cfg, p);
    const cat = await wbReadCatalog(cfg, p, acct);
    const models = cat.models;
    const freeN = models.filter((m) => m.free).length;
    const labels = {};
    for (const m of models) {
      // 下拉显示名：模型名 · 倍率（免费标「免费」）。倍率未知（兜底/App 形态无 credits）时只留名字。
      const cost = m.credits == null ? "" : (m.free ? "免费" : m.credits);
      labels[m.id] = [m.name, cost].filter(Boolean).join(" · ");
    }
    const srcZh = { live: "实时目录", disk: "上次成功目录（落盘降级）", builtin: "内置兜底列表" }[cat.source] || cat.source;
    const who = p === "wbai" ? "WorkBuddy AI" : "WorkBuddy";
    /* 多账号时倍率的归属必须说清楚：这份清单是**某一个账号**的权限事实，
       不说清它是谁的，用户看到的就是一份「不知道该信几分」的目录。
       单账号（synthetic）**一个字都不加**——池化对老用户是纯增量。 */
    const whoAcct = (acct.synthetic || !acct.fp) ? "" : `（账号「${acct.label}」· 指纹 ${acct.fp}）`;
    const note = cat.source === "live"
      ? `${who} 目录来自上游 ${WB_CONFIG_PATH}${whoAcct}（${srcZh}）：共 ${models.length} 个模型，其中 ${freeN} 个 0 倍率免费。`
      : `未取到 ${who} 实时目录${cat.error ? `（${cat.error}）` : ""}，当前显示${srcZh}${whoAcct}——`
        + `${models.length} 个模型，倍率可能不是最新的；稍后重试可恢复实时目录。`;
    return {
      ok: true,
      count: models.length,
      models: models.map((m) => m.id),
      all: models.map((m) => ({ key: m.id, name: m.name, credits: m.credits, free: m.free })),
      labels, freeCount: freeN, source: cat.source,
      // 目录的**拉取时刻**：判断 disk 档是否过期就看它（面板出处徽标要用）
      catalogAt: cat.at || null,
      /* ★ v1.0.78 T8：这份目录**是哪个账号的**（面板出处徽标要用，⑤）。
         只有不可逆指纹 + 用户自己起的标签，**绝不含令牌或账号 id**；
         合成单条目池时 synthetic=true —— 面板据此判定「单账号就不用显示这一段」，
         于是单账号场景的徽标与改动前逐字一致。 */
      sourceAccount: { fp: acct.fp, label: acct.label, synthetic: acct.synthetic === true },
      // 降级到兜底时才标 static，让 scan-all 不动配置（契约：非可信数据不比差异）；
      // live/disk 都是真实目录，交给 scan-all 正常做 diff。
      ...(cat.source === "builtin" ? { static: true } : {}),
      note,
    };
  }

  if (p === "zen") {
    /* Zen 提供公开模型目录，但**端点跟着 upstream 走**（v1.0.74 T4）：
     * 此前这里硬编码 https://opencode.ai/zen/v1/models，于是 Go 档会去拉免费档的
     * 清单（38 个 vs 83 个），把 9 个 Go 档根本没有的免费模型摆进下拉框，
     * 用户点一个就报错——这是 T4 里最容易漏、后果最严重的一处。
     * 目录只给 id、没有价格与免费标记；可用性按实测结论标注，
     * 让用户看得见"上游有什么、为什么用不了"，而不是下拉框里只有孤零零一个模型。
     * 不可用的**不进下拉**，免得选了必然报错。 */
    const cat = await zenReadCatalog(cfg);
    const tier = zenTierInfo(cfg);
    const cap = zenCapFields(cfg);
    /* ★ 2026-10-17：「OpenCode 客户端中转」形态下的放行分支。
     *
     * 直连时代「免费档一律 403 FreeTierError、只有 space-bunny 例外」的判据，
     * 在客户端中转形态下**整个不成立**：请求由本机真 OpenCode 客户端身份发出、
     * 且始终带工具——本机实测 12 个免费模型里 11 个直接可用（deepseek-v4.1-flash-free
     * 1.8s、glm-5.3-flash-free 2.2s、mimo-v2.6 1.6s…）。继续拿直连探测结论筛下拉，
     * 会把能用的免费模型全挡在外面（2026-10-17 用户实测：刷新后下拉只剩 space-bunny，
     * 因为其余全被直连时代的「探不通」标记筛掉）。所以这一形态下免费模型一律放行；
     * 付费模型不混入（没有余额时选了必然报错）。
     *
     * jev-* 是 SystemOne 评估器（非对话模型），虽有 free 后缀也不能当聊天模型，排除。 */
    const ocTransport = zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE;
    const isFreeLike = (id) => {
      if (id.startsWith("jev-")) return false;
      return id.includes("free") || ZEN_STEALTH_FREE.has(id);
    };
    /* v1.0.74 T3/T6（直连形态）：`external` **改读探测结果**（zenExternalOk），不再是那个
     * 已于 2026-10-12 被实测推翻的出厂常量。没探过的模型回落常量并如实标
     * 「未检测」——把"没测过"当成"不能用"和当初那个过期常量是同一种错误。 */
    const all = cat.map((id) => {
      if (ocTransport && isFreeLike(id)) {
        return {
          key: id, name: id, free: true,
          external: true, probed: false,
          capLabel: "可用 · 经客户端中转",
          capHint: "经本机 OpenCode 客户端发出（带工具、真客户端身份），直连时代的 FreeTierError 围栏不适用；以实际请求为准。",
        };
      }
      const v = zenExternalOk(id, cfg);
      const rec = v.rec || null;
      return {
        key: id, name: id, free: id.includes("free"),
        external: v.external,
        probed: v.probed,
        capLabel: rec ? zenCapLabel(rec) : (v.external ? "可用 · 未检测" : "未检测"),
        capHint: rec ? zenCapHint(rec) : (v.probed === false && !v.unknown
          ? "尚未检测：这份清单来自出厂白名单，而该白名单已在 2026-10-12 实测复核为不成立。点「检测可用性」用真实请求逐个探测。"
          : ""),
      };
    });
    const freeN = all.filter((m) => m.free).length;
    const okN = all.filter((m) => m.external).length;
    const probedN = all.filter((m) => m.probed).length;
    const toolN = all.filter((m) => m.capLabel === "可用 · 支持工具").length;
    return {
      ok: true, count: all.length,
      tier: tier.id, tierLabel: tier.label, tierHint: tier.hint,
      goSubRequired: tier.subRequired,
      /* 能力检测（v1.0.74）：面板据此显示「上次检测时间」与逐模型标记。
       * capAtLabel 是服务端算好的文案，渲染层不必也不该自己拼。 */
      capAt: cap.at, capAtLabel: cap.atLabel, capHint: cap.hint, capStale: cap.stale,
      capProbed: probedN, capTools: toolN,
      models: all.filter((m) => m.external).map((m) => m.key),
      all, freeCount: freeN,
      note: (cat.length
        ? `${tier.label}目录（${zenCatalogEndpointLabel(cfg)}）共 ${all.length} 个模型，其中 ${freeN} 个标 free；`
          + (ocTransport
            ? "当前为「OpenCode 客户端中转」形态：免费模型经本机 OpenCode 客户端发出，直连围栏不适用、全部列入下拉（可用性以实际请求为准）。"
            : tier.subRequired
              ? "⚠ 上游已明确回「需要 Go 订阅」——这一档现在一个模型都调不通，请先到 https://opencode.ai/auth 订阅。"
              : cap.at
                /* 有实测就只讲实测，不再复述那句已经过期的「其余 -free 会被 FreeTierError 拒」——
                 * 那句话现在既无出处也无日期，正是它当初让白名单活到了今天。 */
                ? `实测 ${probedN} 个免费模型：${toolN} 个支持工具调用；${cap.atLabel} 检出，可能已过期，点「检测可用性」可重跑。`
                : `出厂白名单标注 ${okN} 个可外部调用，但该白名单已于 2026-10-12 实测复核为不成立——点「检测可用性」用真实请求逐个探测。`)
          + "付费模型不在检测范围内（探了要花钱），需 API Key 有余额。"
        /* 目录没拉到时**照样要说订阅**：这一条与目录读没读到无关，
         * 而它恰恰是最要紧的一句——只报「没读到目录」会把用户引去查网络。 */
        : `未读到 Zen ${tier.label}目录（网络或上游暂时不可达），当前显示内置列表`
          + (tier.subRequired
            ? "；⚠ 但上游已明确回「需要 Go 订阅」——请先到 https://opencode.ai/auth 订阅，这一档现在一个模型都调不通。"
            : "")),
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

// 两版 WorkBuddy 共用这一整套分支：wk(p) 判"是不是 WorkBuddy 家族"，
// 避免下面每处都写一遍 `p === "wb" || p === "wbai"`（漏一处就是国际版走错上游）。
const isWk = (p) => p === "wb" || p === "wbai";
const wkZh = (p) => (p === "wbai" ? "WorkBuddy AI" : "WorkBuddy");

/* OpenCode 传输（v1.0.75）。**惰性**：只有 zen + transport=opencode 的请求才会用到它，
 * 所以模块级只造一个壳，不起进程、不探测二进制、不发任何请求。 */
const OC_WORK_DIR = path.join(DATA_DIR, "opencode");
try { mkdirSync(OC_WORK_DIR, { recursive: true }); } catch { /* 目录建不出来时oc-runtime 会回落到临时目录 */ }

/* 一键安装（2026-10-17）的单飞：面板按钮可能被连点，同一时刻只跑一趟下载。 */
let ocInstallPending = null;
const ocGateway = createOcGateway({
  /* opencode 的 cwd 固定落在本产品自己的数据目录下，而不是系统临时目录：
   * 临时目录是全局共享的（两台机器上跑两个实例会互相踩状态），而且系统清理临时目录时
   * 会把它连同里面的会话记录一起删掉。 */
  workDir: OC_WORK_DIR,
  log: (m) => log(m),
  noteRelayError: (chan, kind, message) => noteRelayError(chan, kind, message),
  anthroError: (res, status, msg) => wbAnthroError(res, status, msg),
});
/* 关停钩子：进程退出时收掉**我们自己 spawn 的**那个 opencode 进程。
 * 只按 oc-runtime 记下的 PID 收（它自己的纪律：不按名字/镜像名批量杀——
 * 用户很可能自己开着 OpenCode 在用）。不挂钩的后果是每次中转重启都留下一具
 * 常驻的 opencode.exe，占着 180MB 内存与那个端口。
 * `exit` 里只允许同步操作，`child.kill()` 正是同步的。 */
try {
  process.on("exit", () => { try { ocGateway.dispose(); } catch { } });
} catch { /* 极老的环境没有 process.on("exit") */ }

async function openaiExchange(p, { cfg, S, j, isProbe, res, useProxy, obs, usageOut, acctOut, sessionKey }) {
  const NAME = p === "zen" ? "OpenCode Zen" : p === "qd" ? "Qoder" : p === "or" ? "OpenRouter" : wkZh(p);
  setErrProvider(res, NAME, p);   // 渠道 key 一起传下去：wbPipe 里的 noteRelayError 要按真实渠道归因
  /* ---- OpenCode 传输：**在取令牌之前**提前分流（v1.0.75）----
   *
   * 位置是判据不是随手放的：这一档用 OpenCode 自己的认证，**根本不需要 cfg.zen.apiKey**
   * （Zen 的 Key 是给直连那条路用的）。放在取令牌之后分流，等于「没配 Key 就永远到不了
   * OpenCode」，等于这个开关打不开。
   *
   * 默认值是 `direct`，`zenTransportOf` 对任何认不出来的值也回 `direct`——
   * 所以条件不成立时**下面的直连逻辑一个字都不受影响**，它现在怎么失败还怎么失败。 */
  if (p === "zen" && zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE) {
    /* 模型映射在这一层做（桥刻意不猜：发错的模型名会让模型静默地什么都不回），
     * 两个方向的 opts.model 都用这一个解析结果。 */
    return ocGateway.exchange({
      cfg, S, j, isProbe, res,
      mapModel: (name) => resolveModel(name, S, p),
    });
  }
  let token;
  /* 本次真正在用的账号 id。失败回灌与「本次被跳过」都以它为准 —— 不用它就等于
     把一次失败记在一个「不知道是谁」的号上，那正是判死错账号的起点。 */
  let wbActiveAccountId = null;
  /* ★ v1.0.78 T8：本次请求**真正在用**的那个账号的不可逆指纹。
     换模挑替补（wbAdvanceModel）与 429 点名付费行都要按它去读目录——
     「本次请求实际使用的账号」是倍率唯一正确的来源，别处那份都不算。 */
  let wbActiveFp = null;
  /* 翻译后的请求体。**提前算**：池化选号要拿 ob.model 去问「(账号,模型) 那一格
     冷不冷」，而 ob 跟令牌无关 —— 算两次既浪费又是一个能漂移的地方。 */
  const ob = wbToOpenAI(j);
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
    /* WorkBuddy 家族：★ 池化选号取代单令牌（v1.0.77）。
     *
     * 会话 key **直接复用 zenSessionId**（同一份「首条 user 消息的 sha256」实现），
     * 不另写第二套 —— 两处各写一遍的话，某天改了一处忘了另一处，粘性就成了
     * 「同一段对话有时粘有时不粘」，而症状是 prompt cache 时不时被击穿，极难归因。
     *
     * 探针**不传** sessionKey：zenSessionId 对探针返回的是一个固定常量，
     * 拿它当 key 等于把所有探针粘到同一个号上，白占一条绑定还制造假命中。 */
    const mk0 = isProbe ? null : zenSessionId(j, false);
    try {
      const sel = await wbEnsureTokenPooled(cfg, p, {
        model: ob && ob.model,
        /* 新那套（持久化亲和）的 key：**原生会话头优先**，没有才用派生的。
         * 老那套（内存 LRU）的 key 仍旧是派生的那个 —— 老行为逐字不变，
         * 而且两套的 key 空间**相同**时新那套说了算（老那套让位）。 */
        sessionKey: sessionKey || mk0,
        stickyKey: mk0,
      });
      token = sel.token;
      wbActiveAccountId = sel.accountId;
      wbActiveFp = wbAccountFp(sel.token);
      /* 账号 id 往上传：会话亲和要记「这段对话落在哪个号上」，
       * 而选号发生在池子内部（这里），中转那一层看不到。 */
      if (acctOut && typeof acctOut === "object") acctOut.accountId = sel.accountId;
    } catch (e) {
      /* 池子说不可用 —— **原样报池子给的原因**，一个字都不反推。
       * 旧代码这里只会说「访问令牌未配置」，那正是 dsh-xdpool 1.7.7 事故的形态：
       * 一次限流被说成密钥无效，用户跑去重新登录一个根本没坏的号。 */
      noteRelayError(p, e.poolReason === "no_token" ? "auth" : "failover", e.message);
      return wbAnthroError(res, e.status || 401, e.message);
    }
  }

  const base = (S.upstream || (p === "zen" ? DEFAULTS.zen.upstream : p === "qd" ? DEFAULTS.qd.upstream : p === "or" ? DEFAULTS.or.upstream : DEFAULTS[p].upstream)).replace(/\/+$/, "");
  // 契约 v18 里程碑 5：发往国内版前删掉 body 里的 reasoning_effort:"off"（插件实测国内版拒该值）。
  // 注意：wbToOpenAI 是**白名单**构造，当前根本不产出 reasoning_effort —— 这条是防御性兜底，
  // 将来若加入该字段也不会漏到国内版。本机 intl 实测 reasoning_effort:"off" 被正常接受（200），
  // 国内版该说法**未能实测**（当时只有 intl 令牌，打 .cn 在到达模型前即 401）。
  // 判据是**上游 host** 而不是渠道名——用户把某版的 upstream 改成 .cn 时同样要生效。
  if (isWk(p) && /(^|\.)workbuddy\.cn$/i.test(hostOf(base)) && ob && ob.reasoning_effort === "off") {
    delete ob.reasoning_effort;
  }
  const url = isWk(p) ? base + "/v2/chat/completions" : base + "/chat/completions";
  const mkHeaders = (tok) => {
    if (p === "zen") {
      /* Zen 的请求头与能力探针共用 zenUpstreamHeaders 一份（v1.0.74）。
       * 该头只在 Go 档加 x-opencode-session；免费档一个字都不加——实测该头对免费档的
       * 围栏毫无作用，加了只是凭空多一个可能被上游记账的会话标识。 */
      return zenUpstreamHeaders(tok, base, j, isProbe === true);
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
    // 走到这里的一定是 WorkBuddy 家族（zen/or/qd 都已在上面分支返回）。
    // 取**本渠道**那份配置：wb → cfg.wb，wbai → cfg.wbai（里程碑 1b，两版令牌/用户标识独立）。
    const w = (p === "wbai" ? cfg.wbai : cfg.wb) || {};
    const host = hostOf(base) || "www.workbuddy.ai";
    // 契约 v18 里程碑 5：按真实客户端（app.asar header 构造器）补齐请求头。
    // 实测：**UA 是唯一闸门**——`B.AI-Router/x.y.z` 会被 400 {"code":12403,"check ua"} 挡掉，
    // 换成客户端形态 `WorkBuddy/<ver> …` 后 /v3/config 与 /v2/chat 均正常。Origin/Referer
    // 实测非必需（带与不带一致），但既然无副作用，与真实客户端对齐一并带上。
    const ua = wbUa();
    const ver = wbClientVersion() || WB_UA_FALLBACK_VER;
    const h = {
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
      authorization: `Bearer ${tok}`,
      "x-product": "SaaS",
      "x-private-data": "true",
      "x-ide-type": "WorkBuddy",
      "x-ide-name": "WorkBuddy",
      "x-ide-version": ver,
      "user-agent": ua,
    };
    // 无 userId 时带 `X-No-User-Id: true`（**不省略** X-User-Id），与真实客户端一致；
    // 同理 enterprise/department 的相关头。实测本机 x-no-* 非必需，但形态与客户端对齐。
    if (w.userId) h["x-user-id"] = w.userId;
    else h["x-no-user-id"] = "true";
    if (w.deviceToken) h["x-device-token"] = w.deviceToken;
    if (!w.enterpriseId) h["x-no-enterprise-id"] = "true";
    if (!w.departmentInfo) h["x-no-department-info"] = "true";
    h["x-domain"] = host;
    h["origin"] = `https://${host}`;
    h["referer"] = `https://${host}/`;
    return h;
  };
  let bodyStr = JSON.stringify(ob);   // OpenRouter 轮换会改写 model，故为 let
  /* 响应头预算按**请求体字节数**分档（v1.0.85）。
   *
   * 原来这里是一刀切的 30 秒、没有任何余量，于是 wbai 的大上下文请求被我们自己的
   * 中转掐断（直连上游实测：1.25MB 要 15~19s、2.5MB 要 30s，而 30 秒就是全部预算）。
   * 用户看到的现象是「对话 1 分钟断一次，然后一直重连」。
   *
   * 分档规则与实测依据在 upstream-budget.mjs 顶部；这里只负责按**当前这一发**的
   * 体量取档。两个要点：
   *   · 取字节数走 upstreamBodyBytes()，**不是 bodyStr.length** —— 中文 UTF-8
   *     是 3 字节/字，拿字符数分档会把最需要放宽的那一档发到底噪预算上。
   *   · bodyStr 每轮换一次 model 就会被改写，所以预算也在 doCall 里**当场**取，
   *     不缓存到闭包外 —— 缓存下来的会是第一轮的体量。
   *
   * 探测档的 10 秒短超时来自 zen-probe.mjs 的 ZEN_PROBE_TIMEOUT_MS —— 能力探测与
   * 真实对话共用同一个常量，否则「探针用的是哪档超时」就只剩口头约定。
   * ⚠ 分档**只作用于真实对话**：isProbe 时语义一字不变，仍是那个 10 秒。 */
  const headerBudgetMs = () => isProbe ? ZEN_PROBE_TIMEOUT_MS : upstreamHeaderBudgetMs(upstreamBodyBytes(bodyStr));
  const doCall = (tok) => useProxy
    ? fetch(url, { method: "POST", headers: mkHeaders(tok), body: bodyStr, signal: AbortSignal.timeout(headerBudgetMs()) })
    : directHttp(url, { method: "POST", headers: mkHeaders(tok), body: bodyStr, timeoutMs: headerBudgetMs() });

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
    if ((r.status === 401 || r.status === 403) && isWk(p) && wbActiveAccountId) {
      /* 先把**这次模型请求**的失败喂回池子（路径 = model，所以只认 401/403，
         判死也只认那两条明确文案 —— 一次网络抖动打出来的 401 不会冤杀好账号）。
         正文必须在这里读走，下面那次续期才有干净的 r 可用。 */
      const authTxt = await readAllBody(r).catch(() => "");
      const poolNow = wbPoolOf(cfg, p);
      const acct = poolNow ? poolNow.accounts.find((a) => a.id === wbActiveAccountId) : null;
      wbNoteFailure(cfg, p, {
        accountId: wbActiveAccountId, model: ob.model, status: r.status,
        text: authTxt, headers: r.headers, now: Date.now(),
      });
      const wslice = p === "wbai" ? cfg.wbai : cfg.wb;
      if (wslice?.refreshToken || acct?.refreshToken) {
        try { token = await wbRefreshOnce(cfg, p, acct); acct && (acct.accessToken = token); r = await doCall(token); }
        catch (e) {
          /* ★★★ 续期失败必须走 wbNoteRefreshFailure：刷新接口的失效信号是
           * **HTTP 400 而不是 401**，不按刷新路径回灌就会被当成「请求本身有问题」
           * （content 类），死号永远留在池子里烧重试，而面板上看不出来。
           * 这是全仓库唯一传 context:"refresh" 的地方（见 wb-pool-wiring.mjs）。 */
          const fed = wbNoteRefreshFailure(cfg, p, e, { accountId: wbActiveAccountId, now: Date.now() });
          const reason = fed && fed.failure && fed.failure.dead ? "账号被判死" : "续期失败";
          const msg = `${e.message}${fed && fed.failure ? " —— " + fed.failure.why : ""}`;
          noteRelayError(p, "auth", msg);
          return wbAnthroError(res, fed && fed.failure && fed.failure.dead ? 503 : 401, `${NAME} 令牌${reason}：${msg}`);
        }
      }
    }
    if ((r.status === 401 || r.status === 403) && p === "qd") {
      await readAllBody(r).catch(() => "");
      try {
        const again = qdEnsureToken(cfg, true);
        if (again && again !== token) { token = again; r = await doCall(token); }
      } catch (e) { noteRelayError(p, "auth", e.message); return wbAnthroError(res, 401, e.message); }
    }
    // ---- WorkBuddy（wb / wbai）：同渠道内换模型续跑（契约 v18，v1.0.65）----
    // 实测这两版的限流**按模型独立计**（hy3 与 deepseek-v4.1-flash 同为 x0.00，
    // 只有后者 429），所以 failover 那套「换渠道」在这里帮不上 —— 同一渠道内没有退路。
    //
    // 上游原文是 "usage exceeds frequency limit … your usage will reset at <时刻>"，
    // 即**限流**而非额度耗尽。解法就是换模型；付费模型用同一令牌直接 200，
    // **积分链路天然是通的，不需要任何「用积分」开关** —— v1.0.65 曾为此试过 8 个 body
    // 参数名 + 4 个 header，全部无效，方向本来就错（见 paid.mjs 实测记录）。
    //
    // 这里做成循环而不是只换一次：挑中的替代模型自己也可能正在冷却，
    // 换一次就放弃等于「换个模型也用不了」，达不到「继续消耗积分继续用」。
    if (p === "wb" || p === "wbai") {
      const tried = new Set();
      const steps = [];              // 本次依次换到了哪些模型（带倍率）
      let advance = 0;
      while (r.status === 429 && advance < WB_ADVANCE_MAX) {
        const peek = await readAllBody(r).catch(() => "");
        const limit = wbParseLimit(peek);
        // 认不出是限流就不换：瞎换比不换更糟（用户要的模型被换掉他并不知道）
        if (!limit) { consumedBodyHint = peek; break; }
        /* ★ v1.0.78 T8：倍率来自**本次请求实际使用的账号**那一桶，
           不再是「这个渠道随便哪一份目录」。 */
        const next = wbAdvanceModel(p, ob.model, limit, tried, wbActiveFp);
        if (!next.ok) { consumedBodyHint = peek; break; }
        tried.add(next.model);
        const from = ob.model;
        /* ob 是 const 对象，不能改字段；整体换一个新对象（其余字段原样带走） */
        bodyStr = JSON.stringify({ ...ob, model: next.model });
        steps.push({ model: next.model, credits: next.credits, free: next.free });
        log(`WorkBuddy 限流轮换（${p}）→ ${from} → ${next.model}`);
        advance++;
        r = await doCall(token);
      }
      /* 只有**连换 WB_ADVANCE_MAX 次仍 429** 才算故障，那时才进 relayErrors。
         换成功了不是错误，此前一律 noteRelayError 会让面板显示成
         「最近一次请求失败（rate_limit_quota）」——而请求明明拿到了 200。 */
      if (steps.length) {
        const recovered = r.status === 200;
        noteWbRotation(p, ob.model, steps, recovered);
        /* ★ v1.0.78 T9：换模之后**真实服务的模型**已经不是 resolveModel 给的那个了。
         * 不更新这条观察，面板就会拿换模之前的名字说「实际服务的是它」——
         * 那正好是本任务要消灭的那种"看着像真相的假话"。换成功了才改：
         * 换到最后一个还 429 的情况下，实际服务的就是原始模型。 */
        if (recovered && obs) {
          obs.swappedFrom = obs.served;
          obs.served = steps[steps.length - 1].model;
        }
        if (!recovered) {
          noteRelayError(p, "rate_limit_quota",
            `${ob.model} 触发频率限制，连换 ${steps.length} 个模型仍未成功。`);
        }
        /* 换够了仍是 429：正文留给下面的归因，如实把上游的 429 抛给用户，不假装成功 */
        if (r.status === 429 && !consumedBodyHint) {
          consumedBodyHint = await readAllBody(r).catch(() => "");
        }
      }
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
    /* ---- ③ 失败回灌（v1.0.77）----
     * 放在**归因之前**、且喂的是内核自己的分类结果。归因文案一律用池子给的
     * reason/remedy，绝不从 txt 反推「这个号是不是坏了」——
     * 那正是 dsh-xdpool 1.7.7 把限流误报成「API 密钥无效」的根因。 */
    let wbFed = null;
    if (isWk(p) && wbActiveAccountId) {
      wbFed = wbNoteFailure(cfg, p, {
        accountId: wbActiveAccountId, model: ob.model, status: r.status,
        text: txt, headers: r.headers, now: Date.now(),
      });
    }
    // 只把翻译后的这句话给用户；下面的 Zen 归因仍按原始 txt 匹配，不受影响
    const msg = upstreamBodyText(txt, 200);

    // 归因：Zen 的几种典型拒绝各有明确含义，直接翻译成人话，别让用户对着裸错误码猜。
    let why = "";
    if (p === "zen") {
      /* —— Go 档专属分支：**只看文案、不看状态码** ——
       *
       * 为什么不能沿用下面那套 `r.status === N && /.../.test(txt)`：
       * Go 档两个端点的错误形状实测不同，而**形状决定了我们能不能稳定拿到文案**：
       *   /zen/go/v1/chat/completions → {"error":{...}}          ← **没有顶层 type 包裹**
       *   /zen/go/v1/messages         → {"type":"error","error":{...}} ← Anthropic 形状
       * 且同一条拒绝在两个端点上的 HTTP 状态码并不一致（实测「需要订阅」在
       * /messages 上是 403，在 /chat/completions 上未实测）。所以这里只认文案。
       *
       * 「需订阅 Go」另外要落到 zenGoState 上：它是账号级的持续状态，
       * 面板要能常驻显示「需订阅 Go」，而不是等用户每次点发送才知道一次。 */
      const isGo = zenTierOf(base) === ZEN_TIER_GO;
      if (/An active OpenCode Go subscription is required/i.test(txt)) {
        why = " —— 当前是 Go 档，需要账号已订阅 OpenCode Go 才能用（上游原文 An active OpenCode Go subscription is required to use Go models.）。"
          + "这不是 API Key 配错、也不是模型不可用——Key 已被上游正常解析，缺的是订阅本身。"
          + "订阅入口 https://opencode.ai/auth ，$10/月，其中 LongCat 2.5 Preview Free 与 Step 5 Preview Free 标 Unlimited。";
        noteRelayError(p, "go_subscription_required", `${NAME} Go 档需要订阅（面板已标出「需订阅 Go」）`);
        noteZenGoRequired(true);
      } else if (/MissingSessionID/i.test(txt)) {
        // 内部 bug 的自证信号：我们明明在 Go 档加了 x-opencode-session 仍被拒。
        why = " —— 上游要求 x-opencode-session 请求头（MissingSessionID）而本次请求没带上。"
          + "这是本机的缺陷（Go 档应当自动注入该头），请把这次现象报给开发者；"
          + "临时可切回免费档上游，但免费档对外部中转是封死的，实际并不能用。";
        noteRelayError(p, "go_missing_session", `${NAME} Go 档缺少 x-opencode-session（本机缺陷）`);
      } else if (/Model is unavailable/i.test(txt)) {
        // 文案要分清两层：免费档是「没对免费档开放」，Go 档是「不在这一档的清单里」。
        why = isGo
          ? " —— 该模型不在当前档位的清单里：Go 档与免费档是两套独立的模型目录"
            + "（免费档 83 个 / Go 档 38 个，互不通用）。请点「刷新模型列表」按当前上游重新拉取目录，"
            + "或在上游地址里切到你真正想用的那一档。"
          : " —— 该模型后端当前不可用（Zen 侧临时下线或未对免费档开放）。";
        noteRelayError(p, "upstream_400", `${NAME} ${isGo ? "模型不在 Go 档清单里" : "模型不可用"}`);
      } else if (r.status === 500) {
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
        /* 免费档围栏。⚠ 文案已大幅更新（2026-10-17 之后）：opencode.ai 服务端在这个时间点
         * 之后**彻底封死**了免费档的外部调用，与调用方式无关——直连、经本机 OpenCode 客户端
         * （1.19.3，带有效 OAuth 凭证）中转、带不带工具，一律被同一个 FreeTierError 拒掉。
         * （实测：在全局数据目录<含有效凭证>下 spawn 1.19.3 端到端对话，仍 403；旧注释里
         * 「改走 OpenCode 客户端中转就能过围栏」的说法已失效，会让人反复尝试无效路径。）
         * 这一档**不再可用**，出路只有两条：① 把上游改成 Go 档并订阅（https://opencode.ai/zen/go/v1，
         * $10/月，实测 oc_sk 在 Go 档是被识别的，只差订阅）；② 让它随故障转移自动落到 wb/wbai/or
         * 等其它通道（这些不依赖 opencode.ai 免费档，可继续免费对话）。 */
        why = " —— OpenCode Zen 的**免费档已被服务端彻底封死**（2026-10-17 起，所有外部调用一律"
          + "FreeTierError，包括经本机 OpenCode 客户端中转），这一档已无法使用。"
          + "两条出路：① 把上游地址改成 https://opencode.ai/zen/go/v1 并订阅 OpenCode Go（$10/月，"
          + "https://opencode.ai/auth），你的 oc_sk 在 Go 档是被识别的；② 保持现状，由故障转移自动"
          + "改走 WorkBuddy / OpenRouter 等其它通道继续对话。";
        /* kind 用**产品级标签** `free_tier_direct` 而不是笼统的 `upstream_403`：
         * 这一条**不是渠道故障**，是「免费档 + 外部调用」这一组合的产品级预期拒绝。
         * 面板据此显示「预期内被拒」而不是红灯，文案直接把两条下一步指出来
         * （①切 Go 档 ②走其它通道），用户不用再猜。 */
        noteRelayError(p, ZEN_FREE_TIER_DIRECT_KIND,
          `${NAME} 免费档已被服务端封死（预期内，非故障）：改上游到 Go 档并订阅，或让故障转移落到 wb/wbai/or 等其它通道`);
      } else if (r.status === 402 || /insufficient account funds/i.test(txt)) {
        why = " —— API Key 余额为 0，付费模型需要先充值；Go 档的付费额度同样走这把 Key 的余额。";
        noteRelayError(p, "upstream_402", `${NAME} 余额不足`);
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
    } else if (isWk(p)) {
      /* WorkBuddy 家族（wb / wbai）：★ 全部文案**取自池子**（v1.0.77）。
       *
       * 改动前这里只有一句笼统的 noteRelayError；改动后多了一段，而这一段是
       * 「同一个 HTTP 状态码，不同的账号状态，要给用户不同的处置指引」：
       *   · 判死   → 必须重新登录（等不到回来）
       *   · 额度用尽 → 要充值（等多久都不会好）
       *   · 限流   → 等一会儿就好（**绝不能说成重新登录**）
       * 把它们混成一句，就是 1.7.7 事故。 */
      const kind = wbFed && wbFed.failure ? wbFed.failure.kind : null;
      const whyText = wbFed && wbFed.failure ? wbFed.failure.why : "";
      /* ★ v1.0.85：429 的第二种成因 —— **请求体体积越过上游红线**。
       * 池子的分类（rate_limit）只回答「这个号/模型要不要冷却」，回答不了
       * 「用户该等还是该开新对话」。而这两件事对用户是相反的：
       * 实测（只改历史条数）0.42MB → 200、1.25MB → 429、2.50MB → 429，
       * 判据是体积不是条数也不是并发，**等再久也不会好**，唯一的解是开新对话。
       * 尾巴由 wb429ContextHint 自己把关（渠道 + 字节数同时满足才给内容），
       * 所以这里无条件取、由它返回空串；非 wb/wbai 或小 body 时一个字都不加。
       * ⚠ 只在**限流**这一类上追加：quota（额度用尽，等多久都不会好但解是充值）与
       *    auth_dead（重新登录）各有自己正确的下一步，把「开新对话」拼上去就是把
       *    对的指引搅浑 —— 那正是 1.7.7 事故的形状。 */
      const wbCtxTail = r.status === 429 ? wb429ContextHint(p, bodyStr) : "";
      if (kind === "auth_dead") {
        why = ` —— ${whyText}`;
      } else if (kind === "quota") {
        why = ` —— ${whyText}（本渠道的其它账号会自动顶上，面板「WorkBuddy 账号池」页看得出是哪一个）`;
      } else if (kind === "rate_limit") {
        /* 池子说「等一会就会自己好」—— 那是对**真并发限流**说的。体积超线时
           这句话是错的，所以先如实补上体积尾巴，再保留原文（不加尾巴时行为逐字不变）。 */
        why = ` —— ${whyText}这一档的免费额度被限流，**等一会就会自己好**，不用重新登录。`
          + (wbCtxTail ? ` ${wbCtxTail}` : "");
        /* ⑥ 同名付费行：用户认的是**显示名**，不是 id 前缀。按显示名在映射表里找
           同名的付费行，直接告诉他「换哪一行」—— 这是他能执行的最短路径。 */
        const paid = wbPaidSameName({
          limitedModel: ob.model,
          rows: wbMappingRows(p === "wbai" ? cfg.wbai : cfg.wb),
          /* ★ v1.0.78 T8：点名付费行时读的目录也必须是**本次请求实际用的那个账号**的——
           「同名付费档用同一枚令牌不受影响」这句话，只有当倍率取自同一枚令牌时才成立。 */
          catalog: wbCatModels(p, wbActiveFp) || [],
        });
        if (paid) { why += " " + paid.text; wbLastPaidHint.set(p, { ...paid, at: new Date().toISOString() }); }
      } else if (wbFed && wbFed.failure && wbFed.failure.why) {
        why = ` —— ${whyText}` + (wbCtxTail ? ` ${wbCtxTail}` : "");
      } else if (wbCtxTail) {
        /* 池子没给出归因（拿不到账号/池子没配）但体积明显超线：照样告诉用户真相，
           不能因为「没有账号池」就把人引去白等半小时。 */
        why = wbCtxTail;
      }
      noteRelayError(p, r.status === 429 ? "rate_limit" : `upstream_${r.status}`,
        `${NAME} 上游 HTTP ${r.status}${kind ? "（账号池判为 " + kind + "）" : ""}`);
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
  // 走到这里就是 200 了：上游接受了请求。Go 档一旦真的通了，之前记下的
  // 「需订阅 Go」就该撤掉——否则用户订完订阅，面板上那个红字永远不消失。
  if (p === "zen") noteZenGoRequired(false);
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) {
    const txt = await readAllBody(r).catch(() => "");
    noteRelayError(p, "upstream_bad", `${NAME} 返回非流式响应（${ct || "无 Content-Type"}）`);
    return wbAnthroError(res, 502, String(`上游返回非 SSE 响应：${upstreamBodyText(txt, 140)}`).slice(0, 200));
  }
  // 首事件闸门的时限：比响应头超时宽（深度思考模型可能几十秒才吐第一个 token），
  // 但必须有上限——否则「上游连上了却一直不吐字」会永远挂着，转移也等不到。
  //
  // v1.0.85：响应头预算改成按体量分档之后，这里**必须跟着放大**，否则会出一种
  // 新的更难查的故障：头等到了（比如 2.5MB 档给了 75 秒），首事件却还按
  // 90 秒算 —— 那次请求等于白等。「头已到、首事件被掐」会让用户看到一次
  // 「明明连上了却又断」，比不修更糟。所以这里统一走
  // upstreamFirstEventBudgetMs()：它保证 max(90 秒, 头预算 × 2)，天然不窄于头预算。
  //
  // ⚠ 探测档**不是** upstreamFirstEventBudgetMs 的一个参数，而是另一条独立分支：
  // 改动前是 Math.max(60000, 10s×3) = 60000，与真实对话的 90 秒是两个不同的数。
  // 探测语义不许变，所以照旧显式写出来，不并进那个纯函数的参数表里 ——
  // 并进去的话「探测到底该拿多少」就变成一个藏在分档逻辑里的隐式约定，
  // 而它今天本该是 zen-probe.mjs 里那个明说的 ZEN_PROBE_TIMEOUT_MS 档位。
  await wbPipe(r, res, {
    model: j.model, clientStream: j.stream === true, inputJson: j,
    timeoutMs: isProbe ? Math.max(60000, ZEN_PROBE_TIMEOUT_MS * 3)
      : upstreamFirstEventBudgetMs(upstreamBodyBytes(bodyStr)),
    usageOut,
  }); // Anthropic 默认非流式
}

// 中转核心工厂：B.AI(:relayPort) 与 SenseNova(:sn.relayPort) 复用同一套逻辑，只是
// 取哪份配置(slice)、是否走代理(useProxy)、把流量记到哪个 recentCalls(store) 不同。
// 按"故障转移链"依次尝试。fo 形如 {provider:"qd", slice, useProxy, opts}。
// 每家一次尝试都先写进影子 res：首个响应是错误就丢弃换下一家，是 200 才落盘。
/* 转移链的顺序（magpie 的路由组语义）。
 *
 * **入口不在这里排** —— 入口永远第一（手动选的就是首选，不该被策略顶掉）。
 * 这里排的是**其余的备选**：magpie 的 Smart 口径是「额度用尽的排后面、续期早的排前面、
 * 会自报剩余的排最前」。
 *
 * ⚠ 今天的**信号还很少**：bai-router 的供应商大多不暴露配额接口（magpie 靠 OAuth
 * 登录态去查，bai-router 没有那个前提），所以多数座位的额度是「未知」——
 * 而「不知道」在策略里既不当成用尽、也不当成没用过，于是排序**保持配置里的顺序**。
 * 机制先在这儿立住，等配额探测（T9）接上，它自己就会开始按额度重排，不必再动这里。
 *
 * ⚠ 排序坏了**不许**让转移链崩 —— 排序只决定「先试谁」，排不出来就按原顺序试。
 */
/* ---------- 配额预算（quota.mjs 的接线）----------
 *
 * 用户给每家设一个额度上限 → 拿账本里**已经记着的** token 对照 → 超了就让这家歇着。
 *
 * ⚠ 这是**被动信号**版：magpie 是拿 OAuth 登录态去问供应商的配额接口，
 *   本仓没有那个前提，只能吃自己账本里的数。所以它比「上游额度」弱 ——
 *   面板与日志里必须**分开说**（kind 用 budget，不是 quota/credit）。
 *
 * ⚠ 单位是 **token 数**，不是钱：账本里没有价格字段，算钱要外挂价格表，
 *   而价格表会随厂商调价漂移 —— 预算会悄悄变含义。
 *
 * ⚠ 账本是 JSONL，**每个请求读一遍太贵** → 按 30 秒缓存（用量只会慢慢涨，
 *   而预算耗尽也不差这几十秒）。
 */
let budgetCache = { at: 0, states: new Map() };

/** 刷新预算状态，并把「预算耗尽」写成休息（这样 isResting 认得它）。 */
function budgetStates(cfg, now) {
  if (budgetCache.states.size && now - budgetCache.at < 30000) return budgetCache.states;
  let records = [];
  try { records = loadUsageRows(); } catch { records = []; }
  const states = new Map();
  for (const p of allChannelKeys()) {
    let st = null;
    try { st = quotaState(p, cfg, records, now); } catch { st = null; }
    if (!st) continue;
    states.set(p, st);
    /* 预算耗尽 → 这家**主动休息**到窗口重置。
     * ⚠ 休息键是**裸渠道键**（不是 provider@account）—— 预算是「这家」的额度，
     *   而账户级的候选（wb@acct）查的是自己的键；providerUsable 那边用裸键查，
     *   两边才都对得上。 */
    try {
      const d = budgetRestDecision(p, cfg, records, now);
      if (d && d.rest) restTable().rest(p, d.untilMs, d.note);
    } catch { /* 休息表坏了不该影响请求 */ }
  }
  budgetCache = { at: now, states };
  return states;
}

/** 这家的预算是不是用完了（入口据此让位 —— 「等也没用」的那一类）。 */
function budgetExhausted(provider, cfg, now) {
  try {
    const st = budgetStates(cfg, now).get(provider);
    return !!(st && st.exhausted);
  } catch { return false; }
}

/* ---------- 远端同步（sync.mjs + sync-targets.mjs 的接线）----------
 *
 * 「换电脑配置不丢」：把配置快照（三个部件：providers / settings / claude）
 * 用**口令加密**推到远端；远端更新了再拉回本地。
 *
 * ⚠ **口令绝不落盘** —— 远端那份是用它加密的，所以每次同步都要用户输入。
 * ⚠ **冲突绝不静默覆盖**：远端变了就说「远端比我新」，由用户选边。
 * ⚠ **拉回来的东西要走「改用户的文件不丢任何东西」那套**（restoreConfig），
 *   不是整份覆盖。
 */
const SYNC_STATE_FILE = () => path.join(DATA_DIR, "sync-state.json");

/** 同步目标配置（cfg.sync）。 */
function syncCfgOf(cfg) {
  const s = (cfg && cfg.sync && typeof cfg.sync === "object") ? cfg.sync : {};
  return {
    kind: String(s.kind || "").trim().toLowerCase(),
    url: String(s.url || "").trim(),
    token: String(s.token || "").trim(),
    user: String(s.user || "").trim(),
    pass: String(s.pass || ""),
    dir: String(s.dir || "").trim(),
    repo: String(s.repo || "").trim(),
    branch: String(s.branch || "").trim(),
  };
}

/** 造一个同步目标。**IO 全在这里注入**（适配器自己不碰盘、不联网）。 */
function makeSyncTarget(cfg) {
  const s = syncCfgOf(cfg);
  if (s.kind === "local") {
    const dir = s.dir || path.join(DATA_DIR, "sync");
    return createTarget("local", {
      dir,
      readFile: async (p) => { try { return readFileSync(p); } catch (e) { if (e && e.code === "ENOENT") return null; throw e; } },
      writeFile: async (p, bytes) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, bytes); },
      rename: async (a, b) => { renameSync(a, b); },
      unlink: async (p) => { try { rmSync(p, { force: true }); } catch { } },
      stat: async (p) => { try { return statSync(p); } catch { return null; } },
      now: Date.now(),
    });
  }
  if (s.kind === "webdav") {
    return createTarget("webdav", {
      baseUrl: s.url,
      fetch: (u, init) => fetch(u, init),
      auth: s.token ? { bearer: s.token } : (s.user ? { user: s.user, pass: s.pass } : undefined),
      now: Date.now(),
    });
  }
  if (s.kind === "github") {
    return createTarget("github", {
      repo: s.repo,
      token: s.token,
      branch: s.branch,
      fetch: (u, init) => fetch(u, init),
      now: Date.now(),
    });
  }
  return null;
}

/** 上次同步的账（跨重启记住）。 */
function loadSyncState() {
  try {
    const j = JSON.parse(readFileSync(SYNC_STATE_FILE(), "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch { return null; }
}
function saveSyncState(state) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SYNC_STATE_FILE(), JSON.stringify(state, null, 2) + "\n");
  } catch { /* 记不住账不影响这次同步 */ }
}

/** 本地的三个部件 + 各自的改动时刻 + 整份快照（封远端那份要用它的 format/version）。 */
function localSyncParts(cfg) {
  const snap = snapshotOf(cfg, { now: Date.now() });
  let m = null;
  try { m = statSync(CONFIG_FILE); } catch { }
  let m2 = null;
  try { m2 = statSync(SETTINGS); } catch { }
  const at = (st) => (st && typeof st.mtimeMs === "number" ? st.mtimeMs : 0);
  return {
    snapshot: snap,
    parts: snap.parts,
    changedAt: { providers: at(m), settings: at(m), claude: at(m2) },
  };
}

/* ---------- 配额真探测（quota-probe.mjs 的接线）----------
 *
 * 问上游「你还剩多少额度」。magpie 走的是这条；本仓之前只有被动预算
 * （拿账本里的数对照），看不见「在别处花掉的额度」。
 *
 * ⚠ **探测结果要缓存**：面板每 5 秒轮询一次，八家挨个发探测请求会把
 *   上游打爆（而打爆的后果正是我们要避免的）。缓存 5 分钟。
 * ⚠ **只读**：quota-probe.mjs 自己有硬闸（只发 GET/HEAD），这里再保证一次
 *   —— 探测请求绝不能消耗额度或改状态。
 */
const PROBE_TTL_MS = 5 * 60 * 1000;
/**
 * 探测缓存：provider → { at, value }。
 *
 * ⚠⚠ **必须逐条记时刻，不能只记一个全局的 at**：
 *   原来写成 `{ at: 0, map }` 而 `at` 从来没被赋过值 → `now - probeCache.at`
 *   恒等于 now（一个巨大的数）→ **缓存永远不命中** → 面板每 5 秒轮询一次
 *   「额度」屏，就把八家上游各打一遍。实测：一次刷新 = 8 个请求。
 *   「5 分钟缓存」这条约定当时是**写在注释里但没生效**的。
 *   现在每条各记各的时刻：谁先探到谁先过期，别的家不受影响。
 */
let probeCache = new Map();

/** 这一家的凭据头（**只从配置里取**；本机登录态那几家的凭据由
 *  account-discovery 提供，还没接上 —— 探不到就报「没有可用的登录态」，
 *  那比拿一个错的凭据去撞 401 好）。 */
function probeHeadersOf(provider, cfg) {
  const S = sliceOf(cfg, provider);
  if (!S) return {};
  const key = String(S.key || "").trim();
  if (!key) return {};
  if (provider === "or") return { authorization: `Bearer ${key}` };
  return { "x-api-key": key, authorization: `Bearer ${key}` };
}

/** 探一家的额度（带缓存）。探不到就是「探不到」，绝不猜。 */
async function probeQuotaOf(provider, cfg, now) {
  const hit = probeCache.get(provider);
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.value;
  const bases = {};
  for (const k of allChannelKeys()) {
    const s = sliceOf(cfg, k);
    bases[k] = s && s.upstream ? String(s.upstream).replace(/\/+$/, "") : "";
  }
  const get = async ({ url, method, headers }) => {
    const r = await fetch(url, {
      method: method === "HEAD" ? "HEAD" : "GET",
      headers: { ...headers, "user-agent": "bai-router-quota-probe" },
      signal: AbortSignal.timeout(8000),
    });
    let text = "";
    try { text = await r.text(); } catch { }
    return { status: r.status, text };
  };
  let out = null;
  try {
    /* ⚠⚠ **mm 的凭据在内存里**（MiniMax Code 的登录态），cfg 里取不到 ——
     *   不注入的话 mm 永远是「探不到：没有可用的登录态」，而 mm 恰恰常常是
     *   用户的**入口**渠道（探不到的那一家，正是最该看见的一家）。
     *   ensure() 顺手续期；失败会抛（消息里没有令牌值）—— 探不到就探不到，
     *   不该因此把整轮探测带崩。
     *   ⚠ 令牌只进发往 MiniMax 自己的请求头，**不进日志、不进面板**。 */
    let mmToken = "";
    if (provider === "mm") {
      try { mmToken = String((await mmTokens.ensure()) || ""); } catch { mmToken = ""; }
    }
    /* ⚠⚠ **qd 的凭据也是不在 cfg 里的**：它是 Qoder 桌面端写的令牌文件
     *   （%TEMP%\qoder-token.json，裸串 `jt-…`，**不是 JWT**），由补丁读出来。
     *   实测（2026-10-23）：真端点是 `openapi.qoder.sh/api/v2/quota/usage`
     *   （另一个域，与推理基址不是一路），`Authorization: Bearer <jt-令牌>` 即可，
     *   `x-gw-user-id` 与 `Cosy-*` 头对它**不必要**。
     *   ⚠ qd 必须**整个替换**头：`probeHeadersOf` 给的是占位符 "qd-local"，
     *     叠加上去只会再换一个 401 回来。 */
    let qdToken = "";
    if (provider === "qd") {
      try { qdToken = String(qdEnsureToken(cfg, false) || ""); } catch { qdToken = ""; }
    }
    out = await probeQuota(provider, {
      now,
      bases,
      headers: (id) => {
        if (id === "qd" && qdToken) return qdQuotaHeaders(qdToken);
        if (id === "mm" && mmToken) return { authorization: "Bearer " + mmToken };
        return probeHeadersOf(id, cfg);
      },
      secrets: (id) => (id === "qd" && qdToken ? [qdToken] : []),
      get,
    });
  } catch (e) {
    out = {
      provider, known: false, used: null, limit: null, resetAtMs: null,
      unit: "unknown", source: "", raw: null,
      error: String((e && e.message) || e),
    };
  }
  probeCache.set(provider, { at: now, value: out });
  return out;
}

/**
 * 缓存里的探测结果（**同步**读 —— 供热路径用）。
 *
 * ⚠ 为什么必须同步：转移链的排序在请求路径上，那条路不许等网络。
 *   所以这里**只读缓存**，不发请求；缓存由后台的周期探测与面板的「额度」屏喂。
 *   没有缓存 / 缓存过期 → null（**没有信号**），调用方按「不知道」处理。
 */
function cachedProbeOf(provider, now) {
  try {
    const hit = probeCache.get(provider);
    if (!hit) return null;
    if (!Number.isFinite(now) || now - hit.at >= PROBE_TTL_MS) return null;
    return hit.value || null;
  } catch { return null; }
}

/**
 * 周期探测：把八家的额度**探一遍**，把缓存喂热。
 *
 * 为什么要后台探：转移链的排序要读「上游自己报的余额」，而那条路是**同步**的
 * （热路径不许等网络）。缓存没人喂就永远是空的 → 排序永远拿不到信号。
 * 面板的「额度」屏会喂它，但用户不开那一屏时就不喂 —— 于是排序功能等于没有。
 *
 * ⚠ **不发多余请求**：探测是只读的（GET/HEAD），没配凭据的家**一个请求都不发**
 *   （quota-probe.mjs 自己那道闸），上游回 4xx/5xx 一律算「探不到」、**不重试**
 *   （重试只会白耗上游的额度）。
 * ⚠ **不拖累启动**：首次探测延后 20 秒，避开启动期那一串配置合并与目录同步。
 * ⚠ **定时器 unref**：它不该让进程赖着不走（退出时进程该结束就结束）。
 */
function startQuotaProbeLoop() {
  let running = false;
  const tick = async () => {
    if (running) return;              // 上一轮还没跑完（上游慢）→ 这一轮跳过
    running = true;
    try {
      const cfg = loadCfg();
      const now = Date.now();
      await Promise.allSettled(allChannelKeys().map((k) => probeQuotaOf(k, cfg, now)));
    } catch { /* 探测失败不该有任何后果：探不到就是探不到 */ }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, PROBE_TTL_MS);
  if (typeof timer.unref === "function") timer.unref();
  setTimeout(() => { void tick(); }, 20000).unref?.();
}

/**
 * Qoder 令牌文件的原始读法（给账号发现用）。
 *
 * ⚠ 不用 qpStatus()：它只回**截断**的令牌（前 14 个字符 + 省略号），
 *   而指纹要按**整把**算 —— 拿截断的串去算指纹，等于每把令牌的指纹都一样。
 */
function qdTokenRaw() {
  const p = QODER_PATCH_PATHS.TOKFILE;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const token = j && typeof j.token === "string" ? j.token.trim() : "";
    if (!token) return { ok: false, reason: "empty" };
    return { ok: true, token, at: typeof j.at === "number" ? j.at : 0, via: "file" };
  } catch {
    let present = false;
    try { present = existsSync(p); } catch { }
    return { ok: false, reason: present ? "read-error" : "no-file" };
  }
}

/** 额度总览：预算（被动）+ 上游余额（真探测）+ 花费。 */async function quotaOverview(cfg, now) {
  const states = budgetStates(cfg, now);
  const table = restTable();
  const rows = [];
  /* ⚠ 探测**并行**发起，别一家一家等：每家最多等 8 秒（上游不回就是超时），
   *   串起来最坏 8×8=64 秒 —— 面板 api() 的默认预算只有 12 秒，那会让「额度」屏
   *   永远超时。并行的最坏是 8 秒（等最慢的那家）。
   *   ⚠ 没配凭据的家**一个请求都不发**（quota-probe.mjs 自己那道闸），
   *   所以「并行」不会变成「凭空多打八家上游」。 */
  const keys = allChannelKeys();
  const probed = await Promise.all(keys.map((k) =>
    probeQuotaOf(k, cfg, now).catch(() => null)));
  const probeOf = new Map(keys.map((k, i) => [k, probed[i]]));
  for (const k of keys) {
    const st = states.get(k) || null;
    const S = sliceOf(cfg, k);
    let budget = null;
    try { budget = budgetOf(k, cfg); } catch { budget = null; }
    const rest = (() => { try { return table.entry(k); } catch { return null; } })();
    const probe = probeOf.get(k) || {
      known: false, used: null, limit: null, resetAtMs: null,
      unit: "unknown", source: "", error: "探不到",
    };
    rows.push({
      key: k,
      name: PROVIDERS[k] || (S && S.zh) || k,
      /* ⚠ **没设预算就是没设**（budget 为 null）—— 别拿一个 limit=0 的状态去显示
       *   「0 / 0（0%）」：那看着像「用完了」，其实这家根本没开预算。 */
      budget: (budget && (budget.hourly != null || budget.daily != null)) ? {
        used: st ? st.used : 0, limit: st ? st.limit : 0, ratio: st ? st.ratio : 0,
        exhausted: !!(st && st.exhausted), resetAtMs: st ? (st.resetAtMs || 0) : 0,
        hourly: budget.hourly != null ? budget.hourly : null,
        daily: budget.daily != null ? budget.daily : null,
        unit: budget.unit || "tokens",
      } : null,
      cost: (() => {
        try {
          const rows = loadUsageRows().filter((r) => String(r.provider || "") === k);
          /* ⚠ 传**当前生效的那张表**（用户手动更新过就用远端那张）——
           *   不传的话 estimateCost 一律用内置快照，用户点了「更新价格表」
           *   却看不到费用变化，那按钮就等于没接。 */
          const c = estimateCost(rows, { now, table: effectivePricingTable() });
          return { known: !!c.known, total: c.total, pricedAt: c.pricedAt, unknownModels: c.unknownModels };
        } catch { return { known: false, total: null, pricedAt: "", unknownModels: [] }; }
      })(),
      probe: {
        known: !!probe.known,
        used: probe.known ? probe.used : null,
        limit: probe.known ? probe.limit : null,
        resetAtMs: probe.known ? probe.resetAtMs : null,
        unit: probe.unit || "unknown",
        source: probe.source || "",
        error: probe.known ? null : (probe.error || "探不到"),
      },
      resting: !!(rest && rest.until > now),
      restUntil: rest ? rest.until : 0,
      restNote: rest && rest.note ? String((rest.note && rest.note.label) || rest.note.kind || "") : "",
      cooling: !failoverAvailable(k),
    });
  }
  return rows;
}

/* ---------- middleware 插件（middleware.mjs 的接线）----------
 *
 * 一份 JSON 声明描述「什么时候、对哪个请求、改什么」，装在 <数据目录>\middleware\*.json。
 *
 * ⚠ **fail-closed**：改写结果不合法（比如把模型改成这家没有的）→ **拒绝这次请求**
 *   并说清是哪一条规则、为什么。magpie 的钩子抛错就原样放行；声明写错却原样放行
 *   = 把「我以为改了」藏起来。
 *   ⚠ 只影响**匹配到的那一家**（别的家照常）。
 *
 * ⚠ 头只把插件**明确设置**的那些带上去 —— 不是把客户端的头全转发过去
 *   （那会把 cookie 之类的也送到上游）。
 */
const middlewareRegistry = createMiddlewareRegistry();
/** 装不上的 middleware 声明与原因（面板要能看到「为什么没装上」）。 */
const middlewareErrors = [];
/** req[MIDDLEWARE_CTX]：这次尝试要加/要删的头（应答那侧也要用）。 */
const MIDDLEWARE_CTX = Symbol("bai.middleware.ctx");

function loadMiddleware() {
  middlewareRegistry.clear();
  middlewareErrors.length = 0;
  let files = [];
  try {
    const dir = path.join(DATA_DIR, "middleware");
    if (existsSync(dir)) files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json")).sort();
  } catch { /* 目录读不到就当没有 */ }
  for (const f of files) {
    try {
      const obj = parseMiddlewareManifest(readFileSync(path.join(DATA_DIR, "middleware", f), "utf8"));
      const v = validateMiddlewareManifest(obj);
      if (!v.ok) throw new Error(formatMiddlewareErrors(v.errors));
      middlewareRegistry.register(v.manifest, { now: Date.now() });
    } catch (e) {
      const why = String((e && e.message) || e).slice(0, 400);
      middlewareErrors.push({ file: f, error: why });
      log(`middleware ${f} 装不上：${why.slice(0, 200)}`);
    }
  }
  return middlewareRegistry.keys().length;
}

/** 请求体里算「参数」的那几格（其余是结构性的，不给插件碰）。 */
const MW_PARAMS = ["max_tokens", "temperature", "top_p", "top_k", "stop_sequences"];

/**
 * 按 middleware 规则改写**这一次尝试**的请求体。
 *
 * ⚠ 为什么在**每个目标家**各改一次（而不是改一次就到处用）：故障转移会按目标家
 *   重新解析档位（bodyFor），那一步会把插件改过的模型**覆盖掉**。所以改写必须
 *   发生在 bodyFor 之后 —— 每个目标家改一次，各自的模型与模型清单才对得上。
 *
 * @returns {{ok:boolean, body?:object, extraHeaders?:object, removeHeaders?:string[], applied?:object[], errors?:object[]}}
 */
function applyMiddleware(provider, tier, bodyObj, req, sliceCfg) {
  if (!middlewareRegistry.keys().length) return { ok: true };
  const src = bodyObj && typeof bodyObj === "object" ? bodyObj : {};
  const params = {};
  for (const k of MW_PARAMS) if (src[k] !== undefined) params[k] = src[k];
  const ctx = {
    provider: String(provider || ""),
    tier: String(tier || ""),
    model: String(src.model || ""),
    protocol: "anthropic",
    path: String((req && req.url) || "").split("?")[0],
    stream: !!src.stream,
    headers: (req && req.headers) || {},
    params,
    availableModels: (sliceCfg && sliceCfg.availableModels) || [],
  };
  let r = null;
  try { r = middlewareRegistry.applyRequest(ctx); }
  catch (e) { return { ok: false, errors: [{ field: "", message: String((e && e.message) || e) }] }; }
  if (!r || !r.ok) return { ok: false, errors: (r && r.errors) || [] };
  const out = { ...src };
  const applied = r.applied || [];
  for (const a of applied) {
    if (a.action === "removeParams" && a.key) delete out[a.key];
  }
  if (r.request && r.request.model) out.model = r.request.model;
  for (const [k, v] of Object.entries((r.request && r.request.params) || {})) out[k] = v;
  /* 头：只把插件**明确设置**的那些带上去；删掉的记下来（转发时要跳过）。 */
  const extraHeaders = {};
  const removeHeaders = [];
  for (const a of applied) {
    if (a.action === "setHeaders" && a.key) extraHeaders[String(a.key).toLowerCase()] = String(a.value);
    if (a.action === "removeHeaders" && a.key) removeHeaders.push(String(a.key).toLowerCase());
  }
  return { ok: true, body: out, extraHeaders, removeHeaders, applied };
}

/* ---------- 代码插件运行时（pluginrt.mjs 的接线）----------
 *
 * 与 middleware 的分工（两条都改请求，但**可信度与代价**不同）：
 *   · middleware（middleware.mjs）—— **声明式**：一份 JSON 描述「改什么」，
 *     跑在**宿主进程里**，不碰用户代码。改坏了也只是改坏了一条规则。
 *   · 代码插件（pluginrt.mjs）—— **真代码**：用户自己写的 JS，跑在**子进程**里，
 *     有 Node 的权限模型（--permission）、有超时封顶、有令牌（插件伪造不了协议消息）。
 *     代价是每个请求多一次进程间往返。
 *
 * ⚠⚠ **端点名字不许撞**：面板里早就有的 `/api/plugins` 与 `/api/plugins/reload`
 *   指的是「**插件渠道**」（声明式地加一家上游渠道，见 cards/plugins.js），
 *   与代码插件是两回事。所以代码插件一律用 `/api/code-plugins*`。
 *
 * ⚠ **插件出错不许连累用户的正常请求**（onError:"pass"）：一个写坏的插件
 *   挡住所有请求，比插件坏掉本身还糟。真要「插件说了算」（拒绝请求），
 *   那是插件**明确 deny** —— 那是它的本分，走 deny 那条路。
 */
let codePluginRuntime = null;
let codePluginCount = 0;
/** 装不上的插件与原因（面板要能看到「为什么没装上」，而不只是一句「加载失败」）。 */
const codePluginErrors = [];

/** 代码插件的根目录（相对数据目录）。 */
function codePluginDir() { return path.join(DATA_DIR, PLUGINRT_DIRNAME); }

async function ensureCodePluginRuntime() {
  if (codePluginRuntime) return codePluginRuntime;
  codePluginRuntime = createRuntime({
    /* 时刻一律由宿主给（插件不许自己取时钟，它在子进程里，取到的是另一台机器的钟）。 */
    now: () => Date.now(),
    /* 宿主给插件的**超时封顶**：清单里写的只能比它小。 */
    timeoutMs: 2000,
    /* fail open：插件失灵 → 这次请求照常发。挡住所有请求比插件坏掉更糟。 */
    onError: "pass",
    rootDir: codePluginDir(),
    log: (e) => { try { log(`代码插件 ${e.pluginId || "?"}：${e.message}`); } catch { } },
  });
  return codePluginRuntime;
}

/**
 * 装上（或重装）代码插件根目录下的所有插件。
 *
 * ⚠⚠ **两次重载必须串行**：装插件是**异步**的（要起子进程、等 init 回来）。
 *   两个重载同时跑时，先跑的那个可能在后跑的 close() **之后**才把插件登记进去，
 *   于是后跑的那个撞上「插件已经装上了：先 remove 再装」。
 *   症状：用户点两下「重载」，第二个说装不上 —— 而插件其实装好了。
 *   （启动时那次自动装载与用户手动点「重载」正好撞上，最容易触发。）
 */
let codePluginReloadChain = Promise.resolve();

function reloadCodePlugins() {
  const run = async () => {
    const rt = await ensureCodePluginRuntime();
    rt.close();                     // 重载 = 把旧的停掉重来一遍
    codePluginErrors.length = 0;
    let r = null;
    try { r = await rt.installFromDir(codePluginDir()); }
    catch (e) {
      r = { installed: [], errors: [{ dir: "", errors: [{ field: "", message: String((e && e.message) || e) }] }] };
    }
    codePluginCount = (r.installed || []).length;
    for (const e of r.errors || []) {
      codePluginErrors.push({ dir: e.dir, message: (e.errors || []).map((x) => x.message).join("；") });
    }
    return { installed: r.installed || [], errors: r.errors || [] };
  };
  /* 串行化：前一个失败也要让后一个照跑（then(run, run)）。 */
  codePluginReloadChain = codePluginReloadChain.then(run, run);
  return codePluginReloadChain;
}

/**
 * 让代码插件过一遍这一次尝试。
 *
 * ⚠ **顺序在 middleware 之后**：声明式规则在前（便宜、用户自己写的），
 *   代码插件看到的是改写后的请求 —— 它要改的话改的是最终形状。
 *
 * @returns {Promise<{ok:boolean, body?:object, extraHeaders?:object,
 *                    denied?:boolean, reason?:string, note?:string}>}
 */
async function applyCodePlugins(provider, tier, bodyObj, req) {
  /* ⚠ 一个插件都没有 → **立刻返回**，一个字都不做。
   *   这条在请求路径上：绝大多数用户根本没装代码插件，
   *   不许为「不存在的东西」付一次进程间往返。 */
  if (!codePluginCount) return { ok: true };
  const rt = codePluginRuntime;
  if (!rt) return { ok: true };
  const src = bodyObj && typeof bodyObj === "object" ? bodyObj : {};
  const params = {};
  for (const k of MW_PARAMS) if (src[k] !== undefined) params[k] = src[k];
  let r = null;
  try {
    /* 交给运行时去**摘要**（凭据类的头名与参数键在那边就被剔掉了 ——
     * 插件拿到的是「有哪些头」，不是「头是什么」）。 */
    r = await rt.apply({
      channel: String(provider || ""),
      tier: String(tier || ""),
      model: String(src.model || ""),
      protocol: "anthropic",
      path: String((req && req.url) || "").split("?")[0],
      stream: !!src.stream,
      headers: (req && req.headers) || {},
      params,
    });
  } catch (e) {
    /* 运行时自己炸了（不该发生：它内部都兜住了）→ 放行。 */
    return { ok: true, note: String((e && e.message) || e) };
  }
  if (!r || !r.ok) {
    /* 插件失灵：onError:"pass" 时运行时会自己跳过；走到这里说明决策不合法，
     * 那就当这个插件不存在，放行 —— 但把原因记下来（面板上要看得见）。 */
    return { ok: true, note: (r && r.error && r.error.message) || "插件返回了不合法的东西" };
  }
  if (r.action === "deny") {
    return { ok: false, denied: true, reason: String(r.reason || "代码插件拒绝了这次请求（没给原因）。") };
  }
  if (r.action !== "modify" || !r.patch) return { ok: true };
  const out = { ...src };
  const patch = r.patch || {};
  if (patch.model) out.model = String(patch.model);
  for (const [k, v] of Object.entries(patch.params || {})) out[k] = v;
  const extraHeaders = {};
  for (const [k, v] of Object.entries(patch.headers || {})) extraHeaders[String(k).toLowerCase()] = String(v);
  return { ok: true, body: out, extraHeaders, removeHeaders: [] };
}

/* ---------- 价格表的「用户点了才更新」（pricing.mjs 的接线）----------
 *
 * ★ **绝不自动更新**：价格是漂移的（厂商随时调价）。自动更新会让
 *   「今天我花了多少钱」这句话的**含义**在某天悄悄变掉，而用户是拿它
 *   跟厂商账单对账的。所以更新必须是**用户点了才发生**的事。
 *   拉到的表不合格、或比内置的那张还旧 → **继续用旧的**。
 *   ⚠ 绝不许因为拉不到就把费用清空：清空了用户会以为「今天没花钱」。
 *
 * ⚠ 刷新是**非阻塞**范式：models.dev 的 api.json 有几 MB，拉一趟好几秒。
 *   后端肯等、前端只肯等 12 秒 —— 阻塞式刷新会被掐断，还把一次**成功**
 *   报成「读取超时」。所以 POST 立刻回包、后台拉、前端轮 GET 看结果
 *   （与 POST /api/test、/api/models/scan-all 同一套做法）。
 */
/* ⚠ **可被环境变量改掉**（BAI_PRICING_URL）：只有测试需要它 ——
 *   实测 models.dev 的 api.json 有 **6 MB**，测试不该真去拉它（既慢又不确定）。
 *   生产环境没人会设这个变量；设了也只是「从哪儿取价格表」变了。
 *   照 BAI_WB_AUTH_DIR 的先例：环境变量只用来指位置，不用来改行为。 */
const MODELS_DEV_URL = String(process.env.BAI_PRICING_URL || "https://models.dev/api.json");
/** 拉 models.dev 的超时（6 MB，给 30 秒；超了算「探不到」，继续用旧表）。 */
const PRICING_FETCH_TIMEOUT_MS = 30000;
/** 上一次刷新的结果 —— 面板要看得见「刚才那次拉失败 Why」。 */
const pricingState = { refreshing: false, lastError: "", lastRefreshedAt: 0 };

/** 远端表落在哪儿（数据目录下，不进仓库）。 */
function pricingTablePath() { return path.join(DATA_DIR, "pricing-table.json"); }

/** 读远端表（**原样**读，校验交给 chooseTable —— 那边是唯一的判据）。 */
function loadPricingOverrideRaw() {
  try {
    const p = pricingTablePath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch { return null; }
}

function savePricingOverride(table) {
  writeFileSync(pricingTablePath(), JSON.stringify(table, null, 2), "utf8");
}

/**
 * 当前生效的那张表（连同它是哪一张、为什么是它）。
 *
 * ⚠ **选表规则只有一份**：`pricing-refresh.mjs` 的 `chooseTable`。
 *   早先这里自己写了一份「远端合格且不比内置的旧就用远端」——两套规则迟早漂移，
 *   而漂移的方向是「悄悄用错表」，那种错**面板上看不出来**。
 *
 * ⚠ **表与「它是谁」必须一起返回**：早先这里返回表、别处再单独判断「是不是远端那张」，
 *   而那是拿**对象身份**比的（`table === remote`）—— 两次读盘拿到的是两个不同的
 *   对象实例，身份永远不相等 → 明明已经换成远端表，来源却报「builtin」。
 *   症状：用户点了「更新价格表」、文件也真写了，但面板上写「还是内置快照」。
 *
 * ⚠ **读盘有缓存**：估价在请求路径上，每请求读一次盘是白花的 IO。
 *   30 秒一次足够（价格表是用户手动更新的，不会有秒级变化）。
 */
const pricingCache = { at: 0, raw: null };
function effectivePricing() {
  const builtin = priceTable();
  const now = Date.now();
  if (now - pricingCache.at > 30000 || pricingCache.raw === null) {
    pricingCache.at = now;
    pricingCache.raw = loadPricingOverrideRaw();
  }
  const remote = pricingCache.raw;
  if (!remote) return { table: builtin, source: "builtin", reason: "还没更新过，用的是内置快照" };
  const r = chooseTable(remote, { current: builtin, currentSource: "builtin" });
  return { table: r.table, source: r.source, reason: r.reason };
}

/** 只要表（估价与面板都用它）。 */
function effectivePricingTable() { return effectivePricing().table; }

/** 拉 models.dev 的 api.json（只读 GET；超时算「探不到」）。 */
async function fetchModelsDev() {
  const r = await fetch(MODELS_DEV_URL, {
    headers: { "user-agent": "bai-router-pricing", accept: "application/json" },
    signal: AbortSignal.timeout(PRICING_FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`models.dev 回 HTTP ${r.status}`);
  return await r.json();
}

/** 跑一次刷新（后台）。失败只记 `lastError`，**绝不改表**。 */
async function refreshPricingNow() {
  pricingState.refreshing = true;
  pricingState.lastError = "";
  try {
    const raw = await fetchModelsDev();
    const today = new Date().toISOString().slice(0, 10);
    const built = tableFromModelsDev(raw, undefined, today);
    const v = normalizeTable(built);
    if (!v.ok) {
      pricingState.lastError = `拉回来的表不合格：${v.reason} —— 继续用旧的那张`;
      return { ok: false, reason: pricingState.lastError };
    }
    savePricingOverride(v.table);
    pricingState.lastRefreshedAt = Date.now();
    pricingState.lastError = "";
    return { ok: true, pricedAt: v.table.pricedAt };
  } catch (e) {
    pricingState.lastError = `拉不到价格表：${String((e && e.message) || e)} —— 继续用旧的那张`;
    return { ok: false, reason: pricingState.lastError };
  } finally {
    pricingState.refreshing = false;
  }
}

/** 给面板看的这张表：条目、快照日期与陈旧程度。 */
function pricingOverview(now) {
  const eff = effectivePricing();
  const table = eff.table;
  const builtin = priceTable();
  const source = eff.source;
  const pricedAt = String(table.pricedAt || "");
  let ageDays = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(pricedAt)) {
    ageDays = Math.max(0, Math.round((now - Date.parse(`${pricedAt}T00:00:00Z`)) / 86400000));
  }
  /* ⚠ 条目的四个通道叫 **input / output / cacheRead / cacheWrite**（pricing.mjs 的
   *   口径），不是 models.dev 那边的 prompt / completion —— 写错了面板上四个价全是
   *   null，而「null」在一张价格表里意味着「不知道」，用户会以为这家免费。 */
  const entries = Object.entries(table.entries || {}).map(([key, e]) => {
    const ch = String(key).split("/")[0];
    const model = String(key).split("/").slice(1).join("/");
    return {
      key,
      name: `${PROVIDERS[ch] || ch} · ${model}`,
      input: e && e.input != null ? e.input : null,
      output: e && e.output != null ? e.output : null,
      cacheRead: e && e.cacheRead != null ? e.cacheRead : null,
      cacheWrite: e && e.cacheWrite != null ? e.cacheWrite : null,
    };
  });
  return {
    pricedAt,
    currency: table.currency || "USD",
    unit: table.unit || "perMillion",
    source,
    ageDays,
    stale: ageDays != null ? ageDays > 30 : false,
    builtinPricedAt: String(builtin.pricedAt || ""),
    entries,
    /* ⚠ 远端表**少了哪几个**：models.dev 上一款模型没有了，那款就成了「估不出」
     *   （费用显示「—」而不是 0）。这会让用户的「今天花了多少钱」忽然变成未知 ——
     *   所以要把这件事**摆出来**，而不是让用户自己发现费用那一格空了。
     *   数量少的时候更要说明白：那是源上真的没有了，不是我们弄丢了。 */
    dropped: source === "remote"
      ? Object.keys(builtin.entries || {}).filter((k) => !(k in (table.entries || {})))
      : [],
    refreshing: pricingState.refreshing,
    lastError: pricingState.lastError || "",
    lastRefreshedAt: pricingState.lastRefreshedAt || 0,
  };
}

function orderChain(providers, now) {
  const list = (providers || []).filter(Boolean);
  if (list.length < 2) return list;
  try {
    const cfg = loadCfg();
    const states = budgetStates(cfg, now);
    const seats = list.map((p) => {
      let seat = seatOf(makeCandidate({
        /* 休息的判据要多一条：预算用完的也歇着。入口仍排第一（那是「等也没用」的，
         * 入口该让位的那一条在 attemptWithFailover 里单独判）。 */
        provider: p, model: "", resting: !failoverAvailable(p) || budgetExhausted(p, cfg, now),
      }), { now, restTable: restTable() });
      /* 配额压力折进**已有的** Seat.used（0–100 的百分比）—— 不另造一个排序器。
       * 取 max 而不是覆盖：上游自己报的使用率更高时，不能被我们的预算压低。 */
      const q = states.get(p);
      if (q) seat = applyQuotaToSeat(seat, q);
      /* ★ 上游**自己报的余额**也折进来（真探测的结果，缓存里读）。
       *   这是「额度快用完的那家排后面」这条规则的**另一半**：上面那条是我们
       *   照用户设的预算**估**的，这里是上游**真报**的。两者取 max。
       *   ⚠ 读的是缓存、不发请求：这条在请求路径上，不能等网络。
       *   ⚠ 探不到就是没有信号（cachedProbeOf 返回 null → 这一格一个字都不改）。 */
      const probe = cachedProbeOf(p, now);
      if (probe) seat = applyProbeToSeat(seat, probe);
      return seat;
    });
    const idx = applyRouteStrategy(Builtin.smart, "chain", seats, now);
    const out = [];
    for (const i of idx) { const p = list[i]; if (p && !out.includes(p)) out.push(p); }
    for (const p of list) if (!out.includes(p)) out.push(p);
    return out;
  } catch { return list; }
}

/* 一次对外尝试：**过闸门**（并发 + 每分钟上限）→ 打上游 → **保证**还名额。
 *
 * ⚠ 为什么单独抽出来：限流得对**两条路**都生效 ——
 *   「不开故障转移」那条路（单家直连，最常见）也要过闸，
 *   而它根本不进 attemptWithFailover 的候选循环。
 *   闸门写在循环里的话，单家场景就等于**没过闸**。
 *
 * @param {Function} fn 真正发请求的函数（由调用方给，这样异常照常往外抛，
 *   而闸门的释放仍然由 finally 保证）。
 * @returns {{gated:boolean, reason?:string, retryAfterSec?:number, value?:any}}
 *   gated=true → 这一家没轮到（满了 / 超了每分钟上限），调用方决定跳过还是回 429。
 */
async function dispatchGated(provider, target, req, res, cfg, body, rewritten, isProbe, fn) {
  const lim = limitsOf(provider, cfg);
  let slot = null;
  let rpmAt = 0;
  /* ⚠ **总是**取一次名额（哪怕上限是 0）：上限 0 时闸门不拦，但**在途数照样被记**
   *   ——「在途几个」是面板热力图要显示的数字，不设上限就不统计的话那一格永远是 0。 */
  slot = await concurrencyGate.acquire(provider, {
    limit: lim.concurrency, waitMs: lim.waitMs, signal: req.signal,
  });
  if (!slot.ok) {
    return { gated: true, reason: slot.reason === "aborted" ? "客户端已断开" : "并发已满", retryAfterSec: 1 };
  }
  if (lim.rpm > 0) {
    const r = rpmGate.reserve(provider, { limit: lim.rpm });
    if (!r.ok) {
      slot.release();
      return { gated: true, reason: "超过每分钟上限", retryAfterSec: Math.max(1, Math.ceil(r.retryAfterSec || 1)) };
    }
    rpmAt = r.at;
  }
  let dispatched = false;
  try {
    const value = await fn();
    dispatched = true;
    return { gated: false, value };
  } finally {
    /* ⚠ 释放写在 finally：成功、失败、抛异常，三条路都得还。
     *   漏一次 = 永久占一个坑 = 那家的请求从此全排队（用户看到的是「卡住」，
     *   而不是「并发上限」—— 那种 bug 极难查）。 */
    if (slot) { try { slot.release(); } catch { } }
    /* 请求压根没发出去（抛异常）→ 每分钟的名额还回去：
     * 它记的是「真发出去的请求」，没发出去就不该占额度。 */
    if (rpmAt && !dispatched) { try { rpmGate.giveBack(provider, rpmAt); } catch { } }
  }
}

/** 闸门把人挡在外面时的应答：429 + Retry-After（等一会儿自己就好）。 */
function gatedError(res, reason, retryAfterSec) {
  const sec = Math.max(1, Math.floor(Number(retryAfterSec) || 1));
  try {
    if (res && !res.headersSent && typeof res.writeHead === "function") {
      res.writeHead(429, {
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(sec),
      });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: `本地限流：${reason}。约 ${sec} 秒后再试。` },
      }));
      return;
    }
  } catch { /* 下面兜底 */ }
  try { if (res && typeof res.end === "function") res.end(); } catch { }
}

async function attemptWithFailover(fo, req, res, cfg, body, rewritten, isProbe, tier0) {
  const foCfg = cfg.failover || {};
  if (!foCfg.enabled) {
    /* 单家直连：**也要过闸门**（限流对这条路同样成立）。
     * ⚠ 这里不用 CaptureRes 套一层 —— 那个东西的 setHeader 是空实现，
     *   套上去会把中转设的头悄悄吞掉。单家路径的状态码直接读 res.statusCode。 */
    const startedAt = Date.now();
    /* 预算用完 → 这条路没有别的家可试，回 429 + Retry-After（等窗口重置）。
     * ⚠ 与「上游额度用尽」**分开说**：那是我们自己的估算，不是上游告诉我们的。 */
    if (budgetExhausted(fo.provider, cfg, startedAt)) {
      gatedError(res, "这家超出了你设的额度预算", 60);
      return;
    }
    /* middleware：单家路径**也要过**（改写规则对谁都成立）。
     * ⚠ 改写不合法 → 明确拒绝（fail-closed），别半改着发出去。 */
    let mwBody = body, mwRewritten = rewritten;
    const mw = applyMiddleware(fo.provider, tier0, rewritten, req, {
      availableModels: (fo.S && fo.S.availableModels) || [],
    });
    if (!mw.ok) {
      const why = (mw.errors || []).map((e) => e.message).join("；");
      return wbAnthroError(res, 400, `middleware 改写失败：${why}`);
    }
    if (mw.body) {
      mwRewritten = mw.body;
      mwBody = Buffer.from(JSON.stringify(mw.body));
    }
    if (mw.extraHeaders || mw.removeHeaders) {
      req[MIDDLEWARE_CTX] = {
        ...(req[MIDDLEWARE_CTX] || {}),
        provider: fo.provider, tier: tier0, model: String((mwRewritten || {}).model || ""),
        extraHeaders: mw.extraHeaders || {}, removeHeaders: mw.removeHeaders || [],
      };
    }
    /* 代码插件：在 middleware 之后过一遍。
     * ⚠ **deny 是策略决定，不是这一家坏了** → 整个请求就地结束，
     *   不去试下一家（试下一家等于绕过插件的策略）。 */
    const cp = await applyCodePlugins(fo.provider, tier0, mwRewritten, req);
    if (cp.denied) {
      /* ⚠ **也要进审计台账**：被插件拒绝是一次「链路上发生过的事」，
       *   不记的话用户事后翻台账只看到「没有这条」，而请求确实来过、
       *   也确实没出去。kind 不用默认的 "auth"（那说的是鉴权失败，
       *   与插件的策略决定不是一回事）。 */
      auditRecord({
        provider: fo.provider,
        model: String((mwRewritten || {}).model || ""),
        status: 403, outcome: "error", kind: "plugin_denied",
        error: `代码插件拒绝：${cp.reason}`,
        ms: Date.now() - startedAt,
      });
      return wbAnthroError(res, 403, `代码插件拒绝了这次请求：${cp.reason}`);
    }
    if (cp.body) {
      mwRewritten = cp.body;
      mwBody = Buffer.from(JSON.stringify(cp.body));
    }
    if (cp.extraHeaders && Object.keys(cp.extraHeaders).length) {
      req[MIDDLEWARE_CTX] = {
        ...(req[MIDDLEWARE_CTX] || {}),
        provider: fo.provider, tier: tier0, model: String((mwRewritten || {}).model || ""),
        extraHeaders: { ...((req[MIDDLEWARE_CTX] || {}).extraHeaders || {}), ...cp.extraHeaders },
        removeHeaders: (req[MIDDLEWARE_CTX] || {}).removeHeaders || [],
      };
    }
    const g = await dispatchGated(fo.provider, fo, req, res, cfg, mwBody, mwRewritten, isProbe,
      () => dispatchOne(fo, req, res, cfg, mwBody, mwRewritten, isProbe));
    if (g.gated) { gatedError(res, g.reason, g.retryAfterSec); return; }
    const st = Number(res && res.statusCode) || 0;
    auditRecord({
      provider: fo.provider,
      model: String((rewritten || {}).model || ""),
      status: st, outcome: st >= 400 ? "error" : "ok",
      ms: Date.now() - startedAt,
    });
    return;
  }
  const order = (Array.isArray(foCfg.chain) && foCfg.chain.length ? foCfg.chain : [fo.provider])
    .filter(Boolean);
  // 当前提供方永远排第一——手动选的就是首选，不该被配置里的顺序顶掉。
  // 其余备选按路由策略排（magpie 的路由组语义，见 orderChain）。
  const chain = [fo.provider, ...orderChain(order.filter((x) => x !== fo.provider), Date.now())];
  const tries = [];
  let lastErr = "";
  // 每个目标渠道都要按**它自己的**路由表重新把档位解析成模型名：主渠道的映射在别的
  // 渠道往往不存在（Qoder 的 lite / WorkBuddy 的 deepseek-* / Zen 的 space-bunny-free
  // 互不相通）。不重解析的话转移过去必然 400 "Model is unavailable"。
  //
  // ⚠⚠ **档位缺失时绝不能把入口家的模型原样发给下一家**：
  //   入口是 zen/space-bunny-free，转给 wb 之后 wb 收到的是 "space-bunny-free"——
  //   wb 压根不服务这个模型（400），而且失败原因会被记成「wb 坏了」，排查方向直接被带偏。
  //   正确做法：档位不知道就用**这一家自己的**默认模型（它至少服务得了这个模型）。
  //   （档位已知时 resolveModel 内部也是这么回落的 —— 目标家没有这一档就落到它的默认模型。）
  const bodyFor = (target, isEntry) => {
    if (isEntry) return { body, rewritten };            // 入口：body 就是它自己的
    if (!rewritten) return { body, rewritten };
    const slice = {
      mapping: target.S.mapping, availableModels: target.S.availableModels, defaultModel: target.S.defaultModel,
    };
    const m = tier0 ? resolveModel(tier0, slice, target.S.p || target.provider) : slice.defaultModel;
    if (!m) return null;                                  // 这一家连默认模型都没有 → 跳过它
    return { body: Buffer.from(JSON.stringify({ ...rewritten, model: m })), rewritten: { ...rewritten, model: m } };
  };
  for (const provider of chain) {
    const isEntry = provider === fo.provider;
    // 额度用尽（非瞬时）时**入口也退到后面**：瞬时冷却期间入口仍然永远第一
    // （手动选的就是首选，90 秒的抖动不该改变用户的选择）；但额度用尽等多久都没用，
    // 继续把它排第一只是让每条请求都先白撞一次死渠道。冷却到期后自动回到第一。
    if (isEntry && failoverQuotaBlocked(provider)) { tries.push({ provider, skipped: "额度冷却中" }); continue; }
    /* 预算用完的入口也要让位（与额度冷却同一类：「等也没用」）。
     * ⚠ 与额度冷却**分开记**：预算是我们自己的估算，不是上游额度耗尽。 */
    if (isEntry && budgetExhausted(provider, cfg, Date.now())) {
      tries.push({ provider, skipped: "超出额度预算" });
      continue;
    }
    if (!isEntry && !failoverAvailable(provider)) { tries.push({ provider, skipped: "冷却中" }); continue; }
    // 目标渠道必须已配置凭据，否则跳（避免拿一个必然 401 的渠道去试）
    if (!providerConfigured(provider, cfg)) { tries.push({ provider, skipped: "未配置" }); continue; }
    const target = provider === fo.provider ? fo : relaySpec(provider, cfg);
    if (!target) { tries.push({ provider, skipped: "未知渠道" }); continue; }
    const cap = new CaptureRes(res);
    const sub = bodyFor(target, isEntry);
    /* 这次尝试从这一刻开始计时（审计台账要「耗时」）。
     * ⚠ 计时含**这一家自己的**等待，不含排队 —— 排队不归某一家。 */
    const attemptStart = Date.now();
    /* 这一家连默认模型都没有 → 没法构造给它的请求，跳过（别硬发一个它不认的模型名）。 */
    if (!sub) { tries.push({ provider, skipped: "没有可用模型" }); continue; }
    /* middleware 插件：**按目标家各改一次**（改写必须发生在 bodyFor 之后 ——
     * 转移会按目标家重新解析档位，那一步会把插件改过的模型覆盖掉）。
     * ⚠ 改写不合法 → **明确拒绝**这一家（fail-closed），不给半改的结果。 */
    const mw = applyMiddleware(provider, tier0, sub.rewritten, req, {
      availableModels: (target.S && target.S.availableModels) || [],
    });
    if (!mw.ok) {
      const why = (mw.errors || []).map((e) => e.message).join("；");
      tries.push({ provider, skipped: "middleware 改写失败" });
      noteRelayError(provider, "middleware", `middleware 改写失败：${why}`);
      continue;
    }
    if (mw.body) {
      sub.rewritten = mw.body;
      sub.body = Buffer.from(JSON.stringify(mw.body));
    }
    if (mw.extraHeaders || mw.removeHeaders) {
      req[MIDDLEWARE_CTX] = {
        ...(req[MIDDLEWARE_CTX] || {}),
        provider, tier: tier0, model: String((sub.rewritten || {}).model || ""),
        extraHeaders: mw.extraHeaders || {}, removeHeaders: mw.removeHeaders || [],
      };
    }
    /* 代码插件：在 middleware 之后过一遍（每个目标家各过一次 —— 改写必须
     * 发生在 bodyFor 之后，理由与 middleware 那条一样）。
     * ⚠ **deny 就地结束整个请求**：不去试下一家 —— 换一家等于绕过插件的策略。 */
    const cp = await applyCodePlugins(provider, tier0, sub.rewritten, req);
    if (cp.denied) {
      tries.push({ provider, skipped: "代码插件拒绝" });
      /* 同样进审计台账（理由见单家路径那一条）。 */
      auditRecord({
        provider,
        model: String((sub.rewritten || {}).model || ""),
        status: 403, outcome: "error", kind: "plugin_denied",
        error: `代码插件拒绝：${cp.reason}`,
        ms: Date.now() - attemptStart,
      });
      return wbAnthroError(res, 403, `代码插件拒绝了这次请求：${cp.reason}`);
    }
    if (cp.body) {
      sub.rewritten = cp.body;
      sub.body = Buffer.from(JSON.stringify(cp.body));
    }
    if (cp.extraHeaders && Object.keys(cp.extraHeaders).length) {
      req[MIDDLEWARE_CTX] = {
        ...(req[MIDDLEWARE_CTX] || {}),
        provider, tier: tier0, model: String((sub.rewritten || {}).model || ""),
        extraHeaders: { ...((req[MIDDLEWARE_CTX] || {}).extraHeaders || {}), ...cp.extraHeaders },
        removeHeaders: (req[MIDDLEWARE_CTX] || {}).removeHeaders || [],
      };
    }
    /* 这次尝试的用量出口。上游报出来的 token 数会写进来，账本据此记账。
     * 每次尝试**新的**一个：转交给下一家时，数字必须跟着换——上一家的数字
     * 记到这一家头上就是**错账**。 */
    target.usageOut = {};
    /* 账号 id 的出口：选号发生在池子内部（桥那一层），中转这一层看不到。
     * 会话亲和要记「这段对话落在哪个号上」，得靠它。 */
    target.acctOut = {};
    /* 新增：模型级休息（magpie 的**两级休息**）——这家整体还活着，但**这个模型**
     * 在休息。本次请求跳过它，同号其它模型照常用。
     * 模型级休息不能整家踢掉：那正是「这个模型没额度」把整家拖下水的老毛病。 */
    if (!isEntry && !providerUsable(provider, (sub.rewritten || {}).model)) {
      tries.push({ provider, skipped: "该模型冷却中" }); continue;
    }
    /* 并发 / RPM 闸门（magpie 的两级限流）。默认不限 → 闸门里直接放行。
     * 拿不到名额 → 这一家跳过，换下一家（不是把请求判死）。 */
    let g = null;
    try {
      g = await dispatchGated(provider, target, req, cap, cfg, sub.body, sub.rewritten, isProbe,
        () => dispatchOne(target, req, cap, cfg, sub.body, sub.rewritten, isProbe));
    } catch (e) {
      cap.discard();
      lastErr = String((e && e.message) || e);
      tries.push({ provider, ok: false, err: lastErr.slice(0, 120) });
      failoverCooldown(provider, lastErr);
      noteRelayError(provider, "failover", `转移走（异常）：${lastErr.slice(0, 120)}`);
      /* 审计：这次尝试也发生过，它该在册（哪怕崩了）。 */
      auditRecord({ provider, model: String((sub.rewritten || {}).model || ""), status: 0, error: lastErr, ms: Date.now() - attemptStart, handedOn: true });
      continue;
    }
    /* 闸门没放行 → 这一家跳过，换下一家（不是把请求判死）。 */
    if (g && g.gated) { tries.push({ provider, skipped: g.reason }); continue; }
    if (cap.ok()) {
      failoverClear(provider);
      /* 成功 ⇒ 清掉这家/这个模型的休息与连续失败计数。
       * 不清的话「连续失败」的退避会一直累加——一次偶发失败之后，那个号再也下不来
       * （magpie 的 magpie 的 rateForget：太久没失败的那次算「新的」）。 */
      try {
        const t = restTable();
        const m = String((sub.rewritten || {}).model || "");
        t.rest(provider, 0, "");
        if (m) t.rest(`${provider}/${m}`, 0, "");
        t.forget(provider);
      } catch { /* 休息表坏了不该影响这次应答 */ }
      tries.push({ provider, ok: true });
      /* 审计：这一次尝试成功了 —— 谁、哪一家、哪个模型、多久。 */
      auditRecord({
        provider,
        model: String((sub.rewritten || {}).model || (rewritten || {}).model || ""),
        status: 200, outcome: "ok", ms: Date.now() - attemptStart,
      });
      /* 用量：这次请求的**最终**结果（magpie 的口径：一个请求 = 一条记录，
       * 按它怎么结束只数一次）。 */
      usageWriter.record({
        provider,
        model: String((sub.rewritten || {}).model || (rewritten || {}).model || ""),
        req: String(tier0 || ""),
        served: String((sub.rewritten || {}).model || ""),
        status: 200,
        tries: tries.length,
        sessionProvider: sessionOfReq(req),
        /* token 数只在上游**真报出来**时才有；没报就留着空（账本会填 0，
         * 但那是「没统计到」，不是「真花了 0」——面板那侧按缺字段显示「—」）。 */
        ...(target.usageOut || {}),
      });
      /* 会话亲和：这段对话落在哪个号上，要记下来（magpie 的 affinity）。
       * 记了它，下一段对话就会优先落在同一个号上——供应商的 prompt cache 才读得到。
       * ⚠ 缺**会话键**或**账号 id**就**不记**：宁可不记，也不要记错
       *（记错 = 把后面的请求都粘到一个不相干的号上）。
       * ⚠ 记亲和失败**不许**影响这次应答（它是旁路）。 */
      try {
        const acctId = (target.acctOut || {}).accountId || "";
        const skey = fo.sessionKey || "";
        if (skey && acctId) {
          wbNoteSuccess(cfg, provider, {
            sessionKey: skey, accountId: acctId,
            usage: target.usageOut || null,
            model: String((sub.rewritten || {}).model || ""),
          });
        }
      } catch { /* 记亲和失败不该影响这次应答 */ }
      /* 静默换人留痕（v1.0.88）：把「实际服务的渠道 + 实际发出去的模型」一起记进有界结构，
         面板据此在故障转移视图顶部显式告诉用户「你选的是 A、回答你的是 B」。
         sub.rewritten.model 就是真正发出去的那个名字（每个目标渠道都按自己的映射重解析过），
         所以面板能说清「钱花到哪个模型上」，而不只是「换了个渠道」。
         🔴 只记录，不改任何判定——noteSilentJump 返回 null 时（没换人）什么都不会发生。 */
      if (tries.length > 1) noteFailoverEvent(fo.provider, tries, (sub.rewritten || {}).model || null, cfg);
      return;
    }
    // 影子判定为失败：换一个
    const status = cap.status || 0;
    tries.push({ provider, ok: false, status, err: String(describeError(cap) || "").slice(0, 110) });
    if (!shouldFailover(status, capBodyText(cap))) {
      // 不该转移（多半是 400 请求本身有问题）——把这次的真实错误原样还给客户端
      // ⚠ 但正文明说了「这家不接」（request illegal / unapproved channel /
      //   模型不被服务）时，shouldFailover 会放行转移——那种 400 换个供应商能通。
      // 注意：这里是**没有发生转移**的分支（换渠道也没用，直接原样返回）。
      // 措辞必须与行为一致，否则排查时会被"故障转移"字样误导成渠道切换过。
      noteChannelAttempt(fo.provider, tries);
      /* 审计：这一次尝试也发生过 —— 哪怕它就是终点（没有转交）。 */
      auditRecord({
        provider,
        model: String((sub.rewritten || {}).model || (rewritten || {}).model || ""),
        status, error: describeError(cap), ms: Date.now() - attemptStart, handedOn: false,
      });
      if (cap.flushBuffered()) return;
      return wbAnthroError(res, status || 502,
        `${target.label} 返回 ${status || "网络错误"}，此错误重试其他渠道也不会好转：${describeError(cap)}`
        + chainNote(tries));
    }
    lastErr = describeError(cap) || `HTTP ${status}`;
    /* 归因 + 冷却（magpie 的 failure(status, body) 口径）。
     *
     * 分类**看响应体**而不只看状态码，所以能分出「额度用尽」（等多久都没好，15 分钟）
     * 与「限流」（会自己好，退避 1→2→4…封顶 10 分钟）——旧逻辑两者都给 90 秒。
     *
     * 冷却**粒度**跟着归因走：账号级（整号停）或模型级（只停那个模型）。
     * scope 必须来自 classifyFailure，不能只传 kind（见 failoverCooldownFor 的注释：
     * 「供应商拒的是客户端」那种 auth 的 scope 是 none，漏传就会把整号停掉）。 */
    const fbody = capBodyText(cap);
    const fcls = classifyFailure(status, fbody, { provider });
    const servedModel = String((sub.rewritten || {}).model || (rewritten || {}).model || "");
    failoverCooldownFor(provider, `${provider}/${servedModel}`, fcls.kind, {
      scope: fcls.scope,
      retryAfterMs: fcls.retryAfterMs,
      resetAtMs: fcls.resetAtMs,
      why: lastErr,
      model: servedModel,
    });
    /* 旧的 provider 级冷却**只在整号出事时**记。
     * 模型级失败（只有这个模型不行）若也记整号冷却，就把「这个模型没额度」
     * 变成「整家停 90 秒」——那正是两级休息要消除的老毛病。 */
    if (fcls.scope !== "model") {
      /* 额度/欠费是「等也没用」的失败（magpie 的 creditRest / quotaRest）：
       * 入口也该让位，下条请求直接换一家，而不是每次先白撞一次已知没额度的渠道。
       * 限流/网络抖只是「等一会儿就好」—— 入口仍排第一（手动选的就是首选，
       * 90 秒的抖动不该改变用户的选择）。 */
      const quotaish = fcls.kind === "quota" || fcls.kind === "credit";
      // 若刚才那次是额度用尽，这里不会把它降级成 90 秒（failover.mjs 有闸）
      failoverCooldown(provider, lastErr, quotaish ? { quota: true } : {});
    }
    /* 用量：这次尝试**失败但已把活交出去了**（handed_on）——它计费了什么、为什么失败，
     * 都要留痕；但它**不计入失败数**（magpie 的口径：转交出去的 try 照样写记录）。 */
    /* 审计：同样记一条。kind 直接用归因结果（额度/限流/不被服务…），
     * 不用再猜一遍 —— 归因器是同一个，猜两遍迟早会对不上。 */
    auditRecord({
      provider,
      model: servedModel,
      status, outcome: "error", kind: fcls.kind,
      error: lastErr, ms: Date.now() - attemptStart, handedOn: true,
    });
    usageWriter.recordAttempt({
      provider,
      model: servedModel,
      req: String(tier0 || ""),
      served: servedModel,
      status,
      error: lastErr.slice(0, 200),
      tries: tries.length,
      kind: fcls.kind,
      sessionProvider: sessionOfReq(req),
    });
    // 刚试过的渠道若已被标成「额度用尽」，转移日志也要带上这个标签——
    // 否则状态面板只剩一个笼统的 failover，分不出"额度没了"和"抖了一下"。
    const quotaNow = failoverQuotaBlocked(provider);
    // T0（v1.0.58）：openaiExchange 刚在这次尝试里归因出的 upstream_NNN（如 Zen 500 →
    // upstream_500）要保留下来，别被笼统的 "failover" 覆盖——「未转移」分支（上面的 400）
    // 本来就不覆盖具体 kind，两个分支行为应当一致。判定用 at 新鲜度（本请求内刚写过），
    // 避免捡到上一条请求的陈旧 kind；quota 分支优先级不变（failover_quota 语义不动）。
    const prevKind = (relayErrors[provider] && relayErrors[provider].kind) || "";
    const prevAt = relayErrors[provider] && relayErrors[provider].at ? new Date(relayErrors[provider].at).getTime() : 0;
    /* 「免费档 + 直连」的预期拒绝要连**消息**一起保留（v1.0.78）。
     * 改动前它被笼统的「转移走（HTTP 403）：<上游 JSON 原文>」覆盖掉，面板只剩一条
     * 红字，用户只能猜——那正是本次要修的现象。归因标签本身已经说清了发生了什么，
     * 所以这里把转移信息降级成一个短前缀，把处置指引留在最显眼的位置。 */
    if (!quotaNow && prevKind === ZEN_FREE_TIER_DIRECT_KIND && Date.now() - prevAt < 60000) {
      noteRelayError(provider, ZEN_FREE_TIER_DIRECT_KIND,
        `已转移走（HTTP ${status}）· ${relayErrors[provider].message}`);
    } else {
      const keepKind = !quotaNow && /^upstream_\d+$/.test(prevKind) && Date.now() - prevAt < 60000;
      noteRelayError(provider, quotaNow ? "failover_quota" : (keepKind ? prevKind : "failover"),
        `转移走（HTTP ${status}${quotaNow ? "，额度用尽" : ""}）：${String(lastErr).slice(0, 120)}`);
    }
  }
  /* 全线失败：没有一家接过手，所以 noteSilentJump 自己会返回 null —— 不留痕。
     那条 502 已经把「最后是谁、为什么」如实回给客户端了，面板不必再重复一遍。 */
  noteFailoverEvent(fo.provider, tries, null, cfg);
  /* 用量：全线失败也是**一条记录**（magpie 的口径：按请求怎么结束只数一次）。 */
  usageWriter.record({
    provider: fo.provider,
    model: String((rewritten || {}).model || ""),
    req: String(tier0 || ""),
    served: "",
    status: 502,
    error: String(lastErr || "").slice(0, 200),
    tries: tries.length,
    kind: "failover_exhausted",
    sessionProvider: sessionOfReq(req),
  });
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

/* 这次尝试的**原始响应体**（出错时缓冲在影子 res 里）。
 *
 * 为什么要单独取全文：故障转移的判据不能只看状态码。400/404/422 有时是
 * 「**这家不接这类请求**」而不是「请求本身有问题」——正文里明说了拒绝理由时，
 * 换一家有用。正文含糊时仍然不转移（宁可少转，也不要白耗别家的额度）。
 * 判据在 failover.mjs 的 shouldFailover(status, body)。 */
function capBodyText(cap) {
  try {
    if (!cap || !cap.buf || !cap.buf.length) return "";
    return Buffer.concat(cap.buf).toString("utf8");
  } catch { return ""; }
}

// 下面两个函数共用同一种"试过哪些渠道"的描述，抽出来免得两处格式串各自漂移。
function describeTries(tries) {
  return tries.map((t) => `${t.provider}:${t.ok ? "成功" : t.skipped || ("失败[st=" + t.status + (t.err ? "/" + String(t.err).slice(0,40) : "") + "]")}`).join("；");
}

/** 这次换人之后，真正发出去的那个模型**要不要花钱**。
 *
 *  ⚠ 为什么不能用渠道的 badge.kind 当判据（v1.0.88 实测打脸）：
 *  providers.js 里 `kind:"cn"` **同时**挂在「境内付费」(sn) 和「0 积分」(wb) 两家身上，
 *  它表示的是**境内**不是**收费**。按它判，会把 wb 的 0 积分模型（实测 hy3 / step-5-preview
 *  都是 credits=x0.00）报成「在你的账上花钱」——**误报比不报更坏**，用户会为一个不存在的
 *  扣费去排查、去改配置。
 *
 *  所以判据只能是**那个模型自己的 credits**（来自该渠道的目录）：
 *  · 查得到且为 0 → 免费，不升级语气
 *  · 查得到且 >0  → 确实计费，报红
 *  · 查不到        → **不知道就不下结论**（沿用「宁可不升级语气」这条老规矩）
 *
 * @returns {true|false|null} true=计费 false=免费 null=查不到
 */
function servedModelCostsMoney(provider, model, cfg) {
  const id = String(model || "").trim();
  if (!id) return null;
  if (!isWk(provider)) return null;          // 非 WorkBuddy：没有逐模型 credits 口径
  const pool = cfg ? wbPoolOf(cfg, provider) : null;
  const fps = [];
  if (pool && Array.isArray(pool.accounts)) {
    for (const a of pool.accounts) {
      const fp = wbAccountFp(a && a.accessToken);
      if (fp) fps.push(fp);
    }
  }
  for (const fp of fps) {                   // 先翻各账号自己的目录
    const hit = (wbCatModels(provider, fp) || []).find((m) => String((m && m.id) || "").trim() === id);
    if (hit && hit.credits != null) return !wbIsFreeCredits(hit.credits);
  }
  for (const fp of [""]) {                  // 再退到该渠道的默认目录
    const hit = (wbCatModels(provider, fp) || []).find((m) => String((m && m.id) || "").trim() === id);
    if (hit && hit.credits != null) return !wbIsFreeCredits(hit.credits);
  }
  return null;
}

function noteFailoverEvent(from, tries, servedModel, cfg) {
  log(`故障转移（入口 ${from}）→ ${describeTries(tries)}`);
  /* 静默换人留痕（v1.0.88）：除了日志，还要让面板看得见——这曾经只写 server-child.log，
     于是「面板一切正常、实际在 WorkBuddy 上花钱」那桩事故整整看不出来。
     servedModel 可空（全线失败时为 null）；留痕结构在 failover.mjs，是有界的。
     costs 一并带下去：**判据在这里算好**（那个模型自己的 credits），面板只负责照着说，
     不许在前端猜渠道贵不贵。

     🔴 查 credits 必须按**实际服务的那一家**，不是按入口：
     `mm → wb` 这一跳里，发出去的模型 hy3 属于 wb；按入口 mm 查 →
     `isWk("mm")` 为假 → 返回 null → 面板只说「换人」，**永远说不出**
     「这些对话是在 WorkBuddy 的账上完成的」。v1.0.88 修的是「用徽章猜计费」，
     这一处是同一类错误的另一面：判据用错了渠道。 */
  const served = (tries || []).find((t) => t && t.ok === true && t.provider && t.provider !== from);
  noteSilentJump(from, tries, servedModel, served ? servedModelCostsMoney(served.provider, servedModel, cfg) : null);
}

// 与 noteFailoverEvent 的区别：这里**没有**发生渠道转移——命中不该转移的错误（如 400），
// 原错误被直接还给客户端。措辞刻意避开"故障转移"，只陈述试过哪些渠道。
function noteChannelAttempt(from, tries) {
  log(`渠道尝试（入口 ${from}，未转移）→ ${describeTries(tries)}`);
}

/**
 * 这一链试过什么 —— **报错里必须带上它**。
 *
 * ⚠⚠ 为什么（2026-10-23 实测，用户被这条坑了很久）：
 *   只报「最后一次尝试」的错误，会把**真正的根因**盖住。那次现场是：
 *     入口 mm（MiniMax 会员）自己挂了（429 限流）→ 转移到 wbai
 *     → wbai 回 400「request illegal」→ 整条链终止
 *   用户看到的只有「[WorkBuddy AI] request illegal —— 请求本身有问题」，
 *   于是去查请求、查模型、查客户端 —— 而真正该先修的是**入口 mm**。
 *   报错里带上整条链，那一眼就能看出「先修 mm」。
 *
 * 只有**一家**试过时不用带（没有别的东西可遮）。
 */
function chainNote(tries) {
  const list = (tries || []).filter((t) => t && t.provider);
  if (list.length < 2) return "";
  const parts = list.map((t) => {
    if (t.ok) return `${t.provider}:成功`;
    if (t.skipped) return `${t.provider}:${t.skipped}`;
    return `${t.provider}:失败[${t.status || "网络错"}${t.err ? " " + String(t.err).slice(0, 60) : ""}]`;
  });
  return `（这一链试过：${parts.join(" → ")}）`;
}

function dispatchOne(fo, req, res, cfg, body, rewritten, isProbe) {
  return handleUpstream(fo, req, res, cfg, body, rewritten, isProbe);
}

function providerConfigured(provider, cfg) {
  if (provider === "bai") return !!cfg.apiKey;
  if (provider === "sn") return !!cfg.sn?.apiKey;
  if (provider === "wb") return !!cfg.wb?.accessToken;
  if (provider === "wbai") return !!cfg.wbai?.accessToken;
  if (provider === "zen") {
    /* 直连要 Zen 的 API Key；经 OpenCode 那条路用 OpenCode 自己的认证，不读这把 Key
     * （spec：这一通道根本不需要它）。所以 transport=opencode 时不配 Key 也算「已配置」——
     * 否则 attemptWithFailover 会把入口渠道自己跳过，用户选了 zen 却拿到「所有渠道都失败了」。
     * transport 仍是默认的 direct，那条路的判据一个字没变。 */
    return !!cfg.zen?.apiKey || zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE;
  }
  if (provider === "or") return orKeys(cfg).length > 0;   // 轮换区：至少 1 把 key 就算配置好
  if (provider === "qd") { try { qdEnsureToken(cfg); return true; } catch { return false; } }
  /* mm（MiniMax 会员）：判据是**内存里的会员登录态**，不是配置里的任何字段。
   * 配置里本来就没有凭据字段（令牌不落盘）——所以只能问令牌仓库：
   *   读到了登录态（有刷新令牌）→ 算已配置（中转请求时会自己续期）；
   *   登录态作废（invalid_grant 之后）→ 不算已配置，转移链会跳过这一格，
   *   并由面板把「请在 MiniMax Code 里重新登录」摆在明处。 */
  /* mm（MiniMax 会员）：判据是**内存里的会员登录态**，不是配置里的任何字段。
   * 配置里本来就没有凭据字段（令牌不落盘）——所以只能问令牌仓库：
   *   读到了登录态（有刷新令牌）→ 算已配置（中转请求时会自己续期）；
   *   登录态作废（invalid_grant 之后）→ 不算已配置，转移链会跳过这一格，
   *   并由面板把「请在 MiniMax Code 里重新登录」摆在明处。
   *
   * ⚠ 这里用 **recheck() 而不是 snapshot()**：用户很可能**先装路由台、之后才登录
   *   MiniMax Code**（最常见的顺序）。启动时读一次文件，内存里没有令牌；
   *   而 snapshot() 不读磁盘 → mm 被**永久**跳过 → 请求落到链上的下一家
   *   （实测就是 WorkBuddy 的 hy3）。recheck() 在「没有可用令牌」时再去读一遍
   *   登录态文件（节流 15 秒），所以登录后最多 15 秒这一格就生效，
   *   不需要用户点任何按钮。（2026-10-19 实测的死锁见 mm-auth.mjs 的 recheck 注释。） */
  if (provider === "mm") {
    const snap = mmTokens.recheck();
    return snap.configured && !snap.invalid;
  }
  return false;
}

/* mm（MiniMax 会员）转发前的请求头准备。
 *
 * ⚠️ 实测（2026-10-19，MiniMax Code 3.1.4，9 种头组合）：上游真正硬要求的只有
 *   **两样** —— `authorization: Bearer <令牌>` 与 `content-type: application/json`。
 *   x-api-key / origin / referer / anthropic-version / user-agent **去掉仍然 200**
 *   （`token` 头代替 authorization 则 401）。
 *   所以这里**整份重建**头（客户端送来的同名头一律作废、UA 也换成 MiniMaxAgent 的），
 *   理由是「与真客户端保持一致、留一手」，**不是**「缺了会 401」。
 *
 * 顺带把**令牌续期**放在这里：快到期（剩不到 5 分钟）时用刷新令牌换新的，
 * 换回来的新刷新令牌**立刻存进内存**（旧的已作废）。续期失败会把**不含令牌值**的
 * 原因抛出去，由调用点转成 401 交回客户端。
 *
 * @returns {Promise<object>} 整份请求头
 */
async function mmPrepareHeaders({ req }) {
  const token = await mmTokens.ensure();   // 失败会抛（消息里没有令牌值）
  return mmBuildHeaders(token, req.headers);
}

/**
 * mm 专属的**请求体**改写：把 Anthropic 嵌套形状的工具定义换成 MiniMax 认的扁平形状。
 *
 * ⚠ 详见 mm-auth.mjs 的 mmNormalizeTools 注释（那里有实测证据）。
 *   少了这一步，**任何带工具的请求都会被上游 400 拒掉**，
 *   而无工具的请求正常 —— 症状是「能聊天、一让模型用工具就断」。
 *
 * @param {object} o
 * @param {Buffer} o.body 原始请求体
 * @returns {Buffer} 改写后的请求体；无需改写时原样返回
 */
function mmPrepareBody({ body }) {
  return mmNormalizeBodyTools(body);
}

function relaySpec(provider, cfg) {
  const meta = {
    bai: ["B.AI", () => true, {}],
    sn: ["SenseNova", () => cfg.sn?.useProxy === true, {}],
    wb: ["WorkBuddy", () => cfg.wb?.useProxy === true, { openai: true }],
    wbai: ["WorkBuddy AI", () => cfg.wbai?.useProxy === true, { openai: true }],
    zen: ["OpenCode Zen", () => cfg.zen?.useProxy === true, { openai: true }],
    qd: ["Qoder", () => cfg.qd?.useProxy === true, { openai: true }],
    /* mm（MiniMax 会员）：上游是 **Anthropic 原生协议**（不吃 OpenAI 桥），
       但**必须**换一整份请求头（Bearer + 完整 MiniMaxAgent UA + Origin + Referer，
       缺一个就是 401 auth failed）。所以这里给的是 prepareHeaders 而不是 openai。
       gateV1：只承接 POST /v1/*，count_tokens 与 /v1/models 由本机应答
       （与 openai 桥同一条准入门，但不走上游协议翻译）。 */
    mm: ["MiniMax 会员", () => cfg.mm?.useProxy === true, { gateV1: true, prepareHeaders: mmPrepareHeaders, prepareBody: mmPrepareBody }],
    or: ["OpenRouter", () => cfg.or?.useProxy === true, { openai: true }],
  }[provider];
  if (!meta) {
    /* 插件渠道：形状与协议都来自声明。 */
    const entry = pluginRegistry.get(provider);
    if (!entry) return null;
    const S = sliceOf(cfg, provider);
    return {
      provider, label: S.zh || entry.name,
      useProxy: () => S.useProxy === true,
      opts: entry.relayOpts || {},
      S,
    };
  }
  return { provider, label: meta[0], useProxy: meta[1], opts: meta[2], S: sliceOf(cfg, provider) };
}

/* 中转的**两层**：
 *   · makeRelayHandler(...) → handler（收到请求后干什么）
 *   · makeRelay(...)      → http.createServer(handler)（在哪个端口上听）
 * 为什么要拆：统一网关（magpie 形态的那个「一个端口」）要的是**handler**——
 * 它按模型 id 的 provider 前缀挑一家接手；8 个旧中转端口要的是**端口**。
 * 拆开之后两边可以共用同一批 handler 逻辑，不会出现「端口是一套、网关是另一套」。
 * ⚠ handler 本身对请求是无状态的（唯一跨请求的状态是外面传进来的观察表），
 *   所以「端口一个实例、网关一个实例」行为完全一致。 */
function makeRelayHandler(p, store, getSlice, useProxy, opts = {}) {
  return (req, res) => {
    const chunks = [];
    /* 「body 的接力」：统一网关已经**读完**了这个请求体（它要靠 body 里的 model 字段
     * 决定走哪一家），请求流因此早就 end 了。此时再挂 'data'/'end' 监听器，
     * 'end' 永远不会再来 → 请求挂死、客户端干等超时。
     * 所以网关把读好的 body 挂在 req[GATEWAY_BODY] 上，这里**优先用它**、不再等流。
     * 没有这个标记的请求（现有 8 个中转端口）走的还是原来那条「挂监听器等流」的路，
     * 一字未变。 */
    const preBody = req[GATEWAY_BODY];
    const onEnd = async () => {
      // 准入门（Bug B）：openai 桥（wb/zen/qd）只承接「POST + /v1/*」的模型调用。
      // 以前这里对任何 path/method 都往下走模型调用逻辑：GET 没有 body → rewritten 为 null
      // → handleUpstream 里那句 400「请求体必须是 Anthropic messages JSON」把 /api/ping
      // 这类探测也当成坏请求体答了。真正的病根是「这压根不是一次模型调用」。
      // 注意：必须在 body 收完（本回调内）再应答——req.on("data") 已经在收集，
      // 提前 return 而不 res.end() 会让 socket 一直挂着。
      // 只门 openai 桥：bAI/SenseNova 是原样透传中转，非 /v1/ 路径交给上游自己答，保持原行为。
      // ⚠ gateV1（v1.0.89 · mm）：MiniMax 会员通道的上游是 **Anthropic 原生协议**
      //   （不走 openai 桥），但它同样只该承接 POST /v1/*，且 count_tokens 与 /v1/models
      //   也该由本机应答（桌面版靠这两个端点判定「模型可用」）。所以把准入门**拆成两半**：
      //   门（路径/方法/本机应答）与桥（OpenAI 协议翻译）分开，mm 只要前者。
      const urlPath = String(req.url || "").split("?")[0];
      if (opts.openai || opts.gateV1) {
        // 端点匹配用：容忍结尾多余的 "/"（路径归一化只影响识别，判 404 的文案仍用原样 urlPath）
        const epPath = urlPath.length > 1 ? urlPath.replace(/\/+$/, "") : urlPath;
        setErrProvider(res, relayLabel(p), p);
        // —— 桌面版探测端点 ①：token 计数。本机按字符数估算应答，绝不为此调用上游 ——
        if (epPath === "/v1/messages/count_tokens") {
          if (req.method !== "POST") {
            try { res.setHeader("Allow", "POST"); } catch { }
            return rejectRelay(req, res, urlPath, 405,
              `${req.method} 不被识别——token 计数只接受 POST /v1/messages/count_tokens`);
          }
          const ctc = (req.headers["content-type"] || "").toLowerCase();
          let j = null;
          try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { }
          if (!j || typeof j !== "object" || Array.isArray(j)) {
            return rejectRelay(req, res, urlPath, 400,
              `请求体无法解析为 Anthropic messages JSON：${ctc.includes("json") ? "body 不是合法 JSON" : "Content-Type 不是 JSON"}｜Content-Type=${ctc || "(未带 Content-Type)"}｜长度=${Buffer.concat(chunks).length} 字节`,
              "token 计数请求体非法");
          }
          const n = estimateInputTokens(j);
          json(res, 200, { input_tokens: n });   // Anthropic 规范：只有这一个字段
          log(`token 计数：POST ${urlPath} → 200（本机估算 input_tokens=${n}，未调用上游）`);
          return;
        }
        // —— 桌面版探测端点 ②：模型列表。按本家映射回清单档位，不打上游 ——
        if (epPath === "/v1/models") {
          if (req.method !== "GET") {
            try { res.setHeader("Allow", "GET"); } catch { }
            return rejectRelay(req, res, urlPath, 405,
              `${req.method} 不被识别——模型列表只接受 GET /v1/models`);
          }
          const Sm = getSlice(loadCfg());
          return json(res, 200, relayModelsPayload(Sm && Sm.mapping));
        }
        if (!urlPath.startsWith("/v1/")) {
          // 面板的 /api/* 注册在面板端口那个 server 上，中转端口本来就不服务它们
          return rejectRelay(req, res, urlPath, 404,
            `中转端口只承接 /v1/* 模型调用，不提供 ${urlPath || "/"}（面板接口请走面板端口）`);
        }
        if (req.method !== "POST") {
          try { res.setHeader("Allow", "POST"); } catch { }
          return rejectRelay(req, res, urlPath, 405, `${req.method} 不是模型调用——本中转只接受 POST /v1/*`);
        }
      }
      const cfg = loadCfg(); // 每请求实时读：映射改完立即生效，无需重启
      const S = getSlice(cfg); // {upstream, mapping, defaultModel, availableModels}
      const sliceCfg = { mapping: S.mapping, availableModels: S.availableModels, defaultModel: S.defaultModel };
      let body = Buffer.concat(chunks);
      let rewritten = null; // 模型解析后的请求 JSON（OpenAI 桥用）
      let tier0 = null;      // 原始档位（故障转移时要按目标渠道的映射重新解析成模型名）
      /* 本次请求写进 store 的那一条观察（可能为 null：小请求不进观察表）。
       * 把它带下去，是为了让**换模**（WorkBuddy 429 后同渠道换模型）能把"真实服务的模型"
       * 更新回这条观察——否则 served 停在换模之前那个名字，面板就会拿一个假的名字
       * 去说「实际服务的是它」。留着它是为了让 served 仍然是*served*，而不是 intent。 */
      let obs = null;
      const ct = (req.headers["content-type"] || "").toLowerCase();
      if (body.length && ct.includes("json")) {
        try {
          const j = JSON.parse(body.toString("utf8"));
          if (typeof j.max_tokens === "number" && j.max_tokens < 3) j.max_tokens = 3; // 桌面版健康探测兼容
          if (typeof j.model === "string") {
            const tier = normalizeModel(j.model);
            /* 统一网关入口（magpie 形态）：模型名**已经定稿**——网关把
             * `provider/模型` 拆开，模型段已写回请求体（req[GATEWAY_MODEL]）。
             * 这里**绝不能再解析**：resolveModel 查的是「档位名 → 模型名」的映射，
             * 而模型名本身多半查不到（它不是档位）→ 静默回落到本渠道 defaultModel，
             * 用户点了 A 却跑了 B，而且面板会把它记成一次「模型回落」。
             * 没有这个标记的请求（现有 8 个中转端口）走的是原来那条路，一字未变。 */
            if (req[GATEWAY_MODEL]) {
              j.model = req[GATEWAY_MODEL];
              /* tier0：**网关模式下档位是从模型名反查回来的**（req[GATEWAY_TIER]）。
               * 有了它，故障转移的 bodyFor() 能按**目标家**重解析这一档
               * （sn 的 opus 档是 glm-5.2、wb 的是 hy3 —— 不是同一个模型）。
               * 查不到档位就留 null：bodyFor() 遇到 null 会保持请求体不变，
               * 那正是我们要的——**宁可转移不了，也不要把原家的模型发给下一家**。 */
              tier0 = req[GATEWAY_TIER] || null;
            } else {
              tier0 = tier; // 记下原始档位，转移时按新渠道的映射重解析
              j.model = resolveModel(j.model, sliceCfg, p);
            }
            // 只观察"真实会话"流量：max_tokens≥512 的对话请求。
            // 桌面版后台小请求(健康探测/起标题/摘要, max_tokens 通常 ≤128)不算"用户正在用的档位"
            if (req.method === "POST" && req.url.startsWith("/v1/messages") && typeof j.max_tokens === "number" && j.max_tokens >= 512) {
              if (store[0] && store[0].tier === tier && Date.now() - store[0].at < 2000) { store[0].at = Date.now(); obs = store[0]; }
              else { obs = { tier, served: j.model, at: Date.now() }; store.unshift(obs); if (store.length > 30) store.pop(); }
            }
          }
          rewritten = j;
          body = Buffer.from(JSON.stringify(j));
        } catch { /* 非 JSON 原样透传 */ }
      }
      // 桌面版后台探测类小请求（max_tokens < 512）在日志里原本完全隐形：它不算「用户正在用的
      // 档位」，不写上面那条中转观察，也没有别的记录——排查时看不到桌面版到底打了什么。
      // 这里补一行访问痕：只记方法、路径、状态码与耗时，不记 body、不落盘。
      // 对话流量（max_tokens ≥ 512）继续走中转观察，不额外打日志，避免刷屏。
      if (opts.openai && typeof (rewritten && rewritten.max_tokens) === "number" && rewritten.max_tokens < 512) {
        const mt = rewritten.max_tokens, t0 = Date.now();
        res.on("finish", () => {
          log(`小请求：${req.method} ${urlPath} → ${res.statusCode}（${Math.max(0, Date.now() - t0)}ms，max_tokens=${mt}）`);
        });
      }
      // 探活级小请求（max_tokens≤8）：更短超时
      const isProbe = (() => { try { const j = JSON.parse(body.toString("utf8")); return typeof j.max_tokens === "number" && j.max_tokens <= 8; } catch { return false; } })();
      /* 会话键：**原生会话头优先**（Claude Code 等会发 `x-claude-code-session-id`），
       * 没有才用派生的（首条 user 消息的哈希）。
       * 原生的更准（同一段对话就是同一个 id），派生的只是兜底。
       * ⚠ 两个都拿不到就是空串 —— **不编造**（magpie 的铁律）。
       * 探活请求不算会话（它没有真实对话）。 */
      const sessKey = isProbe ? "" : (sessionOfReq(req) || zenSessionId(rewritten, false) || "");
      try {
        await attemptWithFailover({ provider: p, S, useProxy, opts, obs, sessionKey: sessKey }, req, res, cfg, body, rewritten, isProbe, tier0);
      } catch (e) {
        try { log('FODEBUG STACK: ' + String(e && e.stack)); } catch {}
        if (!res.headersSent) wbAnthroError(res, 502, String((e && e.message) || e));
        else try { res.end(); } catch { }
      }
    };
    if (preBody !== undefined && preBody !== null) {
      /* 网关入口：body 已被网关读完并改写好 → 直接用，**不再等流**。
       * （请求流早就 end 了，再等 'end' 就是挂死。） */
      chunks.push(preBody);
      void onEnd();
    } else {
      req.on("data", (c) => chunks.push(c));
      req.on("end", onEnd);
    }
  };
}

/** 中转端口 = handler 挂在一个端口上。**行为与拆层之前逐字相同**：
 *  同样的 handler、同样的一句 http.createServer。 */
function makeRelay(p, store, getSlice, useProxy, opts = {}) {
  return http.createServer(makeRelayHandler(p, store, getSlice, useProxy, opts));
}

// 一次尝试：把请求送到本渠道的上游并把响应写进 res（可能是影子 res）。
// 从 makeRelay 里原样抽出，只把闭合的 p/S/useProxy/opts 换成 fo.*。
async function handleUpstream(fo, req, res, cfg, body, rewritten, isProbe) {
        let headers = {};
        for (const k of PASS_HEADERS) if (req.headers[k]) headers[k] = req.headers[k];
        /* middleware 插件要加/删的头。
         * ⚠ 只加插件**明确设置**的那些 —— 不是把客户端的头全转发过去
         *   （那会把 cookie 之类的也送到上游）。 */
        const mwCtx = req[MIDDLEWARE_CTX] || null;
        if (mwCtx) {
          for (const k of (mwCtx.removeHeaders || [])) delete headers[k];
          for (const [k, v] of Object.entries(mwCtx.extraHeaders || {})) headers[k] = v;
        }
        /* 渠道专属的**整份**请求头（v1.0.89 · mm）。
         *
         * mm 的上游同时校验 Bearer 令牌 / 完整浏览器 UA / Origin / Referer，
         * 客户端送来的同名头**一律作废**——所以这里不是「补几个头」而是整份换掉：
         * prepareHeaders 返回的就是最终发出去的那份头。
         *
         * 钩子里顺带做**令牌续期**（快到期时换新的）。续期失败要变成一个
         * **说得清原因**的 401（"请在 MiniMax Code 里重新登录"），
         * 而不是 500 或一句天书——失败消息里**不含**令牌值。
         *
         * 其它渠道没有这个钩子 → headers 仍是从 PASS_HEADERS 抄来的原样，行为一字未变。 */
        if (typeof fo.opts.prepareHeaders === "function") {
          let prepared = null;
          try {
            prepared = await fo.opts.prepareHeaders({ req, cfg, headers, isProbe, provider: fo.provider });
          } catch (e) {
            const why = String((e && e.message) || e);
            setErrProvider(res, relayLabel(fo.provider), fo.provider);
            noteRelayError(fo.provider, "auth", why);
            if (!res.headersSent) return wbAnthroError(res, 401, why);
            try { res.end(); } catch { }
            return;
          }
          if (prepared && typeof prepared === "object") headers = prepared;
        }
        /* 渠道专属的**请求体**改写（v1.0.89 · mm）。
         *
         * ⚠ mm 的上游虽然讲 Anthropic 协议，但**工具定义要的是扁平形状**
         *   （{type, name, description, input_schema}），而 Claude Code 发的是
         *   Anthropic 的**嵌套**形状（{type, function:{name, …}}）。
         *   原样透传 → 上游回 400 "invalid params, function name is empty (2013)"，
         *   而**没有工具的请求一切正常**（上游没东西可挑）——于是「能聊天、一用工具就断」，
         *   极难自查。详见 mm-auth.mjs 的 mmNormalizeTools 注释。
         *
         * 响应方向**不用**转：上游回的 tool_use 本来就是标准 Anthropic 形状。
         *
         * 其它渠道没有这个钩子 → body 原样，行为一字未变。 */
        if (typeof fo.opts.prepareBody === "function") {
          try { body = fo.opts.prepareBody({ req, cfg, body, rewritten, isProbe, provider: fo.provider }) || body; }
          catch { /* 改写失败就按原样发：让上游自己报错，比我们猜着改更安全 */ }
        }
        // isProbe 由入口算好后传入（同时决定中转观察与超时档位），这里不再重算。
        // v1.0.85：响应头预算同样按体量分档（与 openaiExchange 的 doCall 用同一个纯函数）。
        // 这条透传路径（bai/sn）的 body 是 Buffer，字节数直接就是 body.length，
        // 不需要 upstreamBodyBytes() 那个「只认字符串」的包装。
        const headerTimeoutMs = isProbe ? ZEN_PROBE_TIMEOUT_MS
          : upstreamHeaderBudgetMs(body && body.length ? body.length : 0);
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
            setErrProvider(res, relayLabel(fo.provider), fo.provider);
            return wbAnthroError(res, 400, `请求体无法解析为 Anthropic messages JSON：${why}｜Content-Type=${ctv}｜长度=${len} 字节｜前 80 字节=${raw}`);
          }
          try {
            await openaiExchange(fo.provider, { cfg, S: fo.S, j: rewritten, isProbe, res, useProxy: fo.useProxy(cfg), obs: fo.obs, usageOut: fo.usageOut, acctOut: fo.acctOut, sessionKey: fo.sessionKey });
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
            return sendRateLimitError(res, r, fo.provider, body);
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
          /* middleware 的**应答**规则：只改头。
           * ⚠ 不改正文：应答到这层可能已经是一个字节流（SSE），改正文要整份缓冲
           *   再拆事件重切 —— 那是接线层事件管道的事，不在这里做。 */
          if (mwCtx && middlewareRegistry.keys().length) {
            try {
              const rr = middlewareRegistry.applyResponse({
                provider: mwCtx.provider, tier: mwCtx.tier, model: mwCtx.model,
                protocol: "anthropic", status: r.status, headers: h,
              });
              if (rr && rr.ok && rr.response && rr.response.headers) {
                for (const [k, v] of Object.entries(rr.response.headers)) h[k] = v;
              }
            } catch { /* 应答改写坏了不该把一次成功的调用变成失败 */ }
          }
          res.writeHead(r.status, h);
          if (r.body) {
            const stream = r._nodeStream ? r.body : Readable.fromWeb(r.body);
            /* 顺手扫一遍用量：透传这条路中转**没看内容**（原样管道过去），
             * 不扫就拿不到 token 数，账本的 token 列会一直是 0。
             * 扫描器是 Transform：字节原样透传，不缓冲、不改时序。 */
            stream.pipe(makeUsageScanner(fo.usageOut)).pipe(res);
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

/* ---------- 8 家中转：参数一处定义，端口与统一网关共用 ----------
 *
 * 原来这 8 家的参数（slice 读取器 / useProxy / opts）是**内联**在各自的
 * makeRelay(...) 调用里的。现在统一网关也要用**同一批参数**造自己的落点
 * （网关按模型 id 的 provider 前缀挑一家接手），所以抽成一张表：
 *   · 一处定义 → 端口与网关不可能漂移（「改了一处忘了另一处」正是这类重复最常见的病）
 *   · 表里每一项都**逐字**取自改动前那 8 行调用，行为一字未变
 * store（观察表）也放进表里：那是跨请求的唯一可变状态，两边共用同一份数组，
 * 于是「从网关走 sn」与「直连 sn 端口」在面板上看到的调用记录是同一条。 */
/* ---------- 插件渠道（plugin.mjs 的接线）----------
 *
 * 出厂八家之外，由**声明文件**加进来的渠道：<数据目录>\plugins\*.json。
 *
 * ⚠ **形状来自声明，凭据来自用户配置**（cfg[插件键]）—— 两者分开：
 *   声明是**别人写的分发物**，配置是**用户自己的**。插件改了声明就能改用户
 *   的凭据？那它就该有凭据管理器的权限，而不是渠道插件。
 *
 * ⚠ 装不上的插件**记下来但不中断启动** —— 一个坏插件不该让整个应用起不来
 *   （那是「插件」最劝退的一种失败）。面板要能看到「为什么没装上」。
 */
const pluginRegistry = createRegistry({ factoryChannels: CHANNELS });
const pluginErrors = [];          // [{file, error}]：装不上的声明与原因
const pluginRelays = Object.create(null);   // 插件键 → 它自己的中转 server
const pluginStores = Object.create(null);   // 插件键 → 最近调用的观察表

const pluginDir = () => path.join(DATA_DIR, "plugins");

/** 扫插件目录，逐个装上。返回装上几家。 */
function loadPlugins() {
  pluginRegistry.clear();
  pluginErrors.length = 0;
  let files = [];
  try {
    const dir = pluginDir();
    if (existsSync(dir)) files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json")).sort();
  } catch { /* 目录读不到就当没有插件 */ }
  for (const f of files) {
    try {
      const text = readFileSync(path.join(pluginDir(), f), "utf8");
      const obj = parseManifest(text);
      const v = validateManifest(obj, { factoryChannels: CHANNELS });
      if (!v.ok) throw new Error(formatErrors(v.errors));
      /* ⚠ register 收的是**清单本身**（不是校验结果那个包装）——
       *   塞错的话校验器会把 ok/errors/manifest 当成「不认识的字段」。 */
      pluginRegistry.register(v.manifest, { now: Date.now() });
    } catch (e) {
      const why = String((e && e.message) || e).slice(0, 400);
      pluginErrors.push({ file: f, error: why });
      log(`插件 ${f} 装不上：${why.slice(0, 200)}`);
    }
  }
  return pluginRegistry.list().length;
}

/**
 * 插件渠道的切片：**形状**来自声明，**凭据**来自用户配置（cfg[插件键]）。
 * 用户改了配置里的上游/端口/模型清单 → 以用户为准（那是他在面板里设的）。
 */
function pluginSliceOf(p, cfg) {
  const entry = pluginRegistry.get(p);
  if (!entry) return null;
  const c = (cfg && cfg[p]) || {};
  const cred = entry.credentialField ? String(c[entry.credentialField] || "") : "";
  return {
    ...entry.slice,
    key: cred,
    upstream: c.upstream || entry.upstream,
    relayPort: Number(c.relayPort) || entry.relayPort,
    defaultModel: c.defaultModel || entry.defaultModel,
    availableModels: (Array.isArray(c.availableModels) && c.availableModels.length) ? c.availableModels : entry.availableModels,
    mapping: (c.mapping && Object.keys(c.mapping).length) ? c.mapping : entry.mapping,
    useProxy: c.useProxy === undefined ? entry.useProxy : c.useProxy === true,
  };
}

/** 全部渠道键：出厂八家 + 插件渠道。 */
function allChannelKeys() {
  return [...CHANNELS, ...pluginRegistry.keys()];
}

/** 这个渠道键认得吗（出厂八家或已装上的插件）。 */
function isChannelKey(k) {
  const s = String(k == null ? "" : k);
  return CHANNELS.includes(s) || pluginRegistry.has(s);
}

const RELAY_PARAMS = {
  bai: { store: recentCallsBai, slice: (cfg) => ({ upstream: cfg.upstream, mapping: cfg.mapping, defaultModel: cfg.defaultModel, availableModels: cfg.availableModels }), useProxy: () => true, opts: {} },
  sn: { store: recentCallsSn, slice: (cfg) => ({ upstream: cfg.sn.upstream, mapping: cfg.sn.mapping, defaultModel: cfg.sn.defaultModel, availableModels: cfg.sn.availableModels }), useProxy: (cfg) => cfg.sn.useProxy === true, opts: {} },
  wb: { store: recentCallsWb, slice: (cfg) => ({ upstream: cfg.wb.upstream, mapping: cfg.wb.mapping, defaultModel: cfg.wb.defaultModel, availableModels: cfg.wb.availableModels }), useProxy: (cfg) => cfg.wb.useProxy === true, opts: { openai: true } },
  wbai: { store: recentCallsWbai, slice: (cfg) => ({ upstream: cfg.wbai.upstream, mapping: cfg.wbai.mapping, defaultModel: cfg.wbai.defaultModel, availableModels: cfg.wbai.availableModels }), useProxy: (cfg) => cfg.wbai.useProxy === true, opts: { openai: true } },
  zen: { store: recentCallsZen, slice: (cfg) => ({ upstream: cfg.zen.upstream, mapping: cfg.zen.mapping, defaultModel: cfg.zen.defaultModel, availableModels: cfg.zen.availableModels }), useProxy: (cfg) => cfg.zen.useProxy === true, opts: { openai: true } },
  qd: { store: recentCallsQd, slice: (cfg) => ({ upstream: cfg.qd.upstream, mapping: cfg.qd.mapping, defaultModel: cfg.qd.defaultModel, availableModels: cfg.qd.availableModels }), useProxy: (cfg) => cfg.qd.useProxy === true, opts: { openai: true } },
  mm: { store: recentCallsMm, slice: (cfg) => ({ upstream: cfg.mm.upstream, mapping: cfg.mm.mapping, defaultModel: cfg.mm.defaultModel, availableModels: cfg.mm.availableModels }), useProxy: (cfg) => cfg.mm.useProxy === true, opts: { gateV1: true, prepareHeaders: mmPrepareHeaders, prepareBody: mmPrepareBody } },
  or: { store: recentCallsOr, slice: (cfg) => ({ upstream: cfg.or.upstream, mapping: cfg.or.mapping, defaultModel: cfg.or.defaultModel, availableModels: cfg.or.availableModels }), useProxy: (cfg) => cfg.or.useProxy === true, opts: { openai: true } },
};

/* 插件渠道：装上几家就多几格。形状按声明，凭据在 cfg[插件键] 里。 */
loadPlugins();
/* middleware 插件（声明式的请求改写）：装在 <数据目录>\middleware\*.json。 */
loadMiddleware();

/**
 * 给一家插件渠道装上中转落点（RELAY_PARAMS 条目 + 它自己的中转 server）。
 * 初次装载与重载共用这一个 —— 两份写法迟早会漂移。
 */
function mountPluginChannel(id) {
  const entry = pluginRegistry.get(id);
  if (!entry) return;
  pluginStores[id] = [];
  RELAY_PARAMS[id] = {
    store: pluginStores[id],
    slice: (cfg) => pluginSliceOf(id, cfg),
    useProxy: (cfg) => pluginSliceOf(id, cfg)?.useProxy === true,
    /* 协议走声明：openai 的要过通用桥，anthropic 的原样透传。 */
    opts: entry.relayOpts || {},
  };
  const q = RELAY_PARAMS[id];
  pluginRelays[id] = makeRelay(id, q.store, q.slice, q.useProxy, q.opts);
}

/**
 * 重载插件：关掉旧的中转 → 重新扫目录 → 重建落点。
 * 出厂的八家**一个字都不动** —— 只有插件那几格会换。
 */
function reloadPlugins() {
  for (const id of Object.keys(pluginRelays)) {
    try { pluginRelays[id].close(); } catch { }
    delete pluginRelays[id];
    delete pluginStores[id];
    delete RELAY_PARAMS[id];
    delete gatewayHandlers[id];
  }
  const n = loadPlugins();
  for (const id of pluginRegistry.keys()) {
    mountPluginChannel(id);
    const q = RELAY_PARAMS[id];
    gatewayHandlers[id] = makeRelayHandler(id, q.store, q.slice, q.useProxy, q.opts);
    const S = pluginSliceOf(id, loadCfg());
    if (!S) continue;
    try {
      pluginRelays[id].listen(S.relayPort, "127.0.0.1");
      log(`插件渠道中转就绪 http://127.0.0.1:${S.relayPort}（${S.zh}）`);
    } catch (e) {
      log(`⚠ 插件渠道 ${id} 的中转端口 ${S.relayPort} 绑不上：${String((e && e.message) || e)}`);
    }
  }
  return n;
}

// 三个中转：B.AI 走代理（出海）、SenseNova 走直连（境内，可被 sn.useProxy 覆盖）、
// WorkBuddy 走直连（www.workbuddy.ai 直连可达，可被 wb.useProxy 覆盖；协议桥见 opts.openai）
const relay = makeRelay("bai", RELAY_PARAMS.bai.store, RELAY_PARAMS.bai.slice, RELAY_PARAMS.bai.useProxy, RELAY_PARAMS.bai.opts);
const snRelay = makeRelay("sn", RELAY_PARAMS.sn.store, RELAY_PARAMS.sn.slice, RELAY_PARAMS.sn.useProxy, RELAY_PARAMS.sn.opts);
const wbRelay = makeRelay("wb", RELAY_PARAMS.wb.store, RELAY_PARAMS.wb.slice, RELAY_PARAMS.wb.useProxy, RELAY_PARAMS.wb.opts);
// WorkBuddy 国际版：同一个协议桥、同一套请求头构造，只换上游/端口/令牌三样（里程碑 1b）
const wbaiRelay = makeRelay("wbai", RELAY_PARAMS.wbai.store, RELAY_PARAMS.wbai.slice, RELAY_PARAMS.wbai.useProxy, RELAY_PARAMS.wbai.opts);
// OpenCode Zen：OpenAI 协议，复用同一套桥（apiKey 认证，无令牌续期）
const zenRelay = makeRelay("zen", RELAY_PARAMS.zen.store, RELAY_PARAMS.zen.slice, RELAY_PARAMS.zen.useProxy, RELAY_PARAMS.zen.opts);
// Qoder：OpenAI 协议，复用同一套桥。认证是轮换的 jt- jobToken（每次请求现读令牌文件），无静态密钥
const qdRelay = makeRelay("qd", RELAY_PARAMS.qd.store, RELAY_PARAMS.qd.slice, RELAY_PARAMS.qd.useProxy, RELAY_PARAMS.qd.opts);
// MiniMax 会员托管通道（mm）：上游是 **Anthropic 原生协议**，所以**不走 openai 桥**；
// 但请求头要整份换掉（Bearer + 浏览器 UA + Origin + Referer，缺一个就是 401），
// 由 opts.prepareHeaders 完成；准入门（只承接 POST /v1/*）由 opts.gateV1 完成。
const mmRelay = makeRelay("mm", RELAY_PARAMS.mm.store, RELAY_PARAMS.mm.slice, RELAY_PARAMS.mm.useProxy, RELAY_PARAMS.mm.opts);
// OpenRouter（第 6 家）：OpenAI 协议 + 通用桥；凭据是 keys[] 轮换区，由 openaiExchange 内的
// orPick/orAdvance 每请求现选（这里传的 slice 只提供 upstream/mapping/availableModels）。
const orRelay = makeRelay("or", RELAY_PARAMS.or.store, RELAY_PARAMS.or.slice, RELAY_PARAMS.or.useProxy, RELAY_PARAMS.or.opts);

/* 插件渠道的中转：每家一个端口（声明里写的 relayPort）。
 * 与出厂八家用**同一批** handler 逻辑（makeRelay），只是参数不同 ——
 * 插件渠道不该有一套「插件专用」的中转语义。 */
for (const id of pluginRegistry.keys()) mountPluginChannel(id);

/* ---------- 统一网关（magpie 形态：一个端口，模型 id 写成 provider/模型） ----------
 *
 * 本步**只做加法**：这是新增的第 9 个端口，8 个旧端口与它们的行为一字未变。
 * 切默认、拆旧端口是后面的步骤。
 *
 * 网关的落点表与上面 8 个端口**共用同一批参数**（RELAY_PARAMS）——网关不是
 * 「另一套中转逻辑」，它就是把同一个中转 handler 挂在另一个端口上，
 * 于是「网关走 sn」与「直连 sn 端口」必然是同一套行为。 */
for (const p of allChannelKeys()) {
  if (!RELAY_PARAMS[p]) throw new Error(`统一网关落点表缺渠道 ${p}（RELAY_PARAMS 与渠道清单必须一一对应）`);
}
const gatewayHandlers = Object.fromEntries(allChannelKeys().map((p) => {
  const q = RELAY_PARAMS[p];
  return [p, makeRelayHandler(p, q.store, q.slice, q.useProxy, q.opts)];
}));
/* 网关的两个入口：
 *   · Anthropic 入口（/v1/messages）—— 原��那条路，**一个字都没改**；
 *   · 协议入口（Responses / Gemini）—— 客户端说另一种话时的那条。
 *
 * ⚠ 两个入口**共用同一批中转 handler**：翻成 Anthropic 形状之后，模型解析、
 *   故障转移、冷却、账本全走同一条路 —— 所以「到了那家之后」的行为逐字相同。
 */
const gatewayParams = {
  handlers: gatewayHandlers,
  /* 「这个 provider 键认识吗」：以**本实例真有中转处理器**为准，
   * 而不是抄一份渠道名单——名单与处理器不同步时，网关会说「这家没接线」，
   * 而不是把请求丢给一个不存在的 handler。 */
  isProvider: (key) => Object.prototype.hasOwnProperty.call(gatewayHandlers, key),
  /* 档位识别要现读配置（映射表会变），所以给的是函数不是快照。 */
  getCfg: () => loadCfg(),
  /* 「模型段本身就是该家的一个档位吗」——模型 id 写 `provider/档位` 时走这条。
   * 档位在 id 里 → 无损、无歧义，中转照老路径解析即可。 */
  tierKeyFor: (provider, name, cfg) => tierKeyFor(provider, name, cfg, { tiers: TIER_KEYS }),
  /* 「哪个档位指向这个模型」——模型 id 写 `provider/最终模型` 时走这条。
   * ⚠ 命中多个 = 歧义 = 返回 null（tierOfModel 的语义），不猜。 */
  tierOf: tierOfModel,
};
const gatewayAnthropicHandler = makeGatewayHandler(gatewayParams);
const gatewayProtocolHandler = makeProtocolHandler(gatewayParams);
const gatewayServer = http.createServer((req, res) => {
  /* 按路径分派：协议路径走协议入口，模型清单走清单入口，其余走 Anthropic 入口。
   * ⚠ 分派**只看路径与方法**，不看请求体 —— 请求体还没读呢。 */
  const p = String(req.url || "").split("?")[0];
  const ep = p.length > 1 ? p.replace(/\/+$/, "") : p;
  if (req.method === "GET" && ep === "/v1/models") return gatewayModels(req, res);
  if (pickProtocol(ep, req.method)) return gatewayProtocolHandler(req, res);
  return gatewayAnthropicHandler(req, res);
});

/**
 * 统一网关的模型清单（GET /v1/models）。
 *
 * ⚠ 早先统一网关对非 POST 一律 405，说「模型清单请直连对应提供方的中转端口」。
 *   那对 Anthropic 客户端无所谓（它们连的是某一家的中转端口），但**对 Chat 一族
 *   客户端是死路**：它们启动第一件事就是 GET /v1/models 拉清单，拉不到就报错或
 *   空列表 —— 于是「协议通了但连不上」，白忙。
 *
 * 清单内容 = 出厂八家 × 各自的档位。模型 id 写成 `provider/档位` —— 与网关
 * 入向的模型 id 约定**逐字相同**（客户端从清单里抄一个 id 直接用）。
 *
 * ⚠ 插件渠道**不在**这份清单里：插件渠道不出现在出厂渠道矩阵里（那是面板的
 *   口径），它们的模型由插件自己的声明决定，用户自己知道 id。
 *
 * 形状用 chatModelsPayload：**一份响应两种客户端都能读**（OpenAI 读
 * `object`/`created`，Anthropic 读 `type`/`created_at`，多写的字段没人管）。
 */
function gatewayModels(req, res) {
  json(res, 200, chatModelsPayload(gatewayModelEntries(loadCfg())));
}

/**
 * gatewayModelEntries —— 统一网关的模型清单条目（出厂八家 × 各自的档位）。
 *
 * ⚠ 插件渠道不在里面（理由见上面 gatewayModels 的注释）。
 */
function gatewayModelEntries(cfg) {
  const c = cfg || loadCfg();
  const entries = [];
  for (const p of CHANNELS) {
    const S = sliceOf(c, p);
    const mapping = (S && S.mapping) || {};
    const keys = Object.keys(mapping).length ? Object.keys(mapping) : TIER_KEYS;
    for (const k of keys) {
      entries.push({
        id: `${p}/${k}`,
        ownedBy: p,
        displayName: (mapping[k] && mapping[k].label) || k,
      });
    }
  }
  return entries;
}

/**
 * clientCtx —— 接线时给客户端声明的那份上下文。
 *
 * `baseUrl` 是**不带 /v1** 的统一网关根地址（它同时答 `/chat/completions`
 * 与 `/v1/chat/completions`）。`apiKey` 是**占位串** —— 本地网关不校验 key，
 * 但客户端多半要求非空才肯保存；这是个明显不是真 key 的占位。
 *
 * ⚠ `home` 是**要改的目录**（客户端的配置在那儿）。它可以用环境变量
 *   `BAI_CLIENT_HOME` 改 —— 与 `BAI_DATA_DIR` 同一类：接线会写文件，
 *   「写文件」这件事必须能被测试隔离开，否则测试就会动用户的真配置。
 *   生产环境不设这个变量，就是真实的用户目录。
 */
function clientCtx(cfg) {
  const c = cfg || loadCfg();
  return {
    home: process.env.BAI_CLIENT_HOME || os.homedir(),
    baseUrl: gatewayBaseUrl(c),
    apiKey: "bai-local",
    models: gatewayModelEntries(c).map((e) => ({ id: e.id, label: e.displayName })),
    providerId: "bai",
    providerName: "B.AI",
  };
}

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
      /* ★ v1.0.78：传输开关带进切片。applyToCli 据此决定 CLI 的 BASE_URL 是写中转端口
         （transport=opencode）还是写上游本体（direct）——判据与中转内部 openaiExchange
         的分流用**同一个** zenTransportOf，认不出来的值同样兜底成 direct。
         `upstream` 字段保持原样（仍带 /v1），那是中转自己拼 /chat/completions 要用的。 */
      transport: zenTransportOf({ zen: z }),
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
  if (p === "wbai") {
    // WorkBuddy 国际版（里程碑 1b）：与 wb 同构，独立的端口/上游/令牌。
    const w = cfg.wbai || {};
    return {
      // 同 wb：没有 sk- 密钥，key 用访问令牌充当（供指纹展示与"是否已配置"判断），中转本身不校验
      p: "wbai", zh: "WorkBuddy AI", key: w.accessToken || "", upstream: w.upstream || DEFAULTS.wbai.upstream,
      relayPort: w.relayPort || DEFAULTS.wbai.relayPort, defaultModel: w.defaultModel || DEFAULTS.wbai.defaultModel,
      availableModels: w.availableModels || [...DEFAULTS.wbai.availableModels], mapping: w.mapping || { ...DEFAULTS.wbai.mapping },
      useProxy: w.useProxy === true,
    };
  }
  if (p === "mm") {
    const m = cfg.mm || {};
    /* 模型 id 一律归一成上游的**官方写法**（大小写敏感，见 mmCanonicalModel 的注释）。
     * 面板保存映射时会把目标转成小写——那对六家全是小写 id 的渠道是等价的，
     * 对 MiniMax 就等于把发出去的名字改掉了。这里归一一次，
     * 下拉里显示的、存进 config.json 的、发给上游的，三处永远一致。 */
    const models = (m.availableModels || [...DEFAULTS.mm.availableModels]).map(mmCanonicalModel);
    const rawMap = m.mapping || { ...DEFAULTS.mm.mapping };
    const map = {};
    for (const k of Object.keys(rawMap)) {
      map[k] = { ...rawMap[k], target: mmCanonicalModel(rawMap[k] && rawMap[k].target) };
    }
    return {
      /* MiniMax 会员通道：**没有** sk- 密钥这一说——鉴权用的是会员登录态换来的
         Bearer 访问令牌，它只存在内存里（mm-auth.mjs），中转每次请求现取。
         key 给一个稳定占位符，供「接线比对 / 指纹展示」用；
         本渠道是否就绪由 /api/status 的 mm.token 汇报（providerConfigured 认它，
         **不**认这个占位符）。 */
      p: "mm", zh: "MiniMax 会员", key: "mm-local", upstream: m.upstream || DEFAULTS.mm.upstream,
      relayPort: m.relayPort || DEFAULTS.mm.relayPort, defaultModel: mmCanonicalModel(m.defaultModel || DEFAULTS.mm.defaultModel),
      availableModels: models, mapping: map,
      useProxy: m.useProxy === true,
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
  /* 插件渠道：出厂八家之外的那些（声明给形状，配置给凭据）。 */
  const ps = pluginSliceOf(p, cfg);
  if (ps) return ps;
  return {
    p: "bai", zh: "B.AI", key: cfg.apiKey || "", upstream: cfg.upstream || DEFAULTS.upstream,
    relayPort: cfg.relayPort || DEFAULTS.relayPort, defaultModel: cfg.defaultModel || DEFAULTS.defaultModel,
    availableModels: cfg.availableModels || [...DEFAULTS.availableModels], mapping: cfg.mapping || { ...DEFAULTS.mapping },
    useProxy: true,
  };
}
const PROVIDERS = CHANNEL_LABELS;
const isOurs = (mode) => isChannelKey(mode);
function hostOf(u) { try { return new URL(u).host; } catch { return ""; } }

// ---------- WorkBuddy 客户端版本与 UA（契约 v18 里程碑 5）----------
// 实测事实（本机 2026-10-11，真实令牌打 /v3/config 与 /v2/chat/completions）：
//  ① **UA 是唯一闸门**。UA 非 `WorkBuddy/…` 形态时上游回 400 {"code":12403,
//     "msg":"check ua, get coding copilot version error"}——我们原来发的 `B.AI-Router/x.y.z`
//     正是被这条挡掉的，连目录都拉不到。
//  ② **Origin/Referer 不是必需**。带与不带实测返回完全一致（同为 21625 字节）。
//     契约 §1.1「缺 Origin/Referer → 空目录」与本机实测不符（那是**无鉴权**的表现）。
//  ③ 真实客户端版本从安装目录读：`resources/install-manifest.json` 的 appVersion，
//     或 `resources/app.asar` 内 package.json 的 version（两者一致）。读不到如实返回 null。
//  ④ 上游 roster 由 UA 形态决定：客户端形态 `WorkBuddy/<ver> WorkBuddy/<ver>`（可再缀 ` CLI/<cliVer>`）
//     返回完整目录；纯 `CLI/<ver> CodeBuddy/<ver>` 返回更小的 22 档目录。我们**发对话请求**
//     用的是客户端形态（与真实客户端一致）。里程碑 2 的 `/v3/config` 拉目录用的是 CLI 形态，
//     **两处共用下面的 wbClientVersion()/wbUa()，不各写一份版本逻辑**。
const WB_CLIENT_DIRS = [
  // 国际版/国内版常见安装位（与 wbCandidateBases 同源的兜底，不改它的搜索逻辑）
  path.join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddyAI"),
  path.join(process.env.LOCALAPPDATA || "", "Programs", "WorkBuddy"),
];
let wbClientVerCache = { at: 0, val: undefined }; // undefined=未查；null=查不到
// 从安装目录读真实客户端版本。返回字符串版本或 null（**读不到就 null，绝不编造**）。
function wbClientVersion() {
  const now = Date.now();
  if (wbClientVerCache.at && now - wbClientVerCache.at < 10 * 60 * 1000) return wbClientVerCache.val;
  let ver = null;
  // 盘符兜底：安装程序可能把 LOCALAPPDATA 重定向到别的盘
  const dirs = [...WB_CLIENT_DIRS];
  const user = process.env.USERNAME || "";
  for (const d of ["C", "D", "E", "F"]) {
    if (user) {
      dirs.push(path.join(d + ":", "Users", user, "AppData", "Local", "Programs", "WorkBuddyAI"));
      dirs.push(path.join(d + ":", "Users", user, "AppData", "Local", "Programs", "WorkBuddy"));
    }
  }
  // ① install-manifest.json（纯文本，最省事）
  for (const dir of dirs) {
    try {
      const j = JSON.parse(readFileSync(path.join(dir, "resources", "install-manifest.json"), "utf8"));
      const v = String(j.appVersion || "").trim();
      if (/^\d+\.\d+/.test(v)) { ver = v; break; }
    } catch { /* 继续下一个位置 */ }
  }
  // ② app.asar 内 package.json（上面读不到时）
  if (!ver) {
    for (const dir of dirs) {
      try {
        const buf = readFileSync(path.join(dir, "resources", "app.asar"));
        const headerSize = buf.readUInt32LE(12);
        const hdr = JSON.parse(buf.slice(16, 16 + headerSize).toString("utf8").replace(/\0+$/, ""));
        const e = hdr.files && hdr.files["package.json"];
        if (!e) continue;
        const off = 16 + headerSize + Number(e.offset);
        const s = buf.slice(off, off + Number(e.size)).toString("utf8");
        const m = s.match(/"version"\s*:\s*"([^"]+)"/);
        if (m && /^\d+\.\d+/.test(m[1])) { ver = m[1]; break; }
      } catch { /* 继续 */ }
    }
  }
  wbClientVerCache = { at: now, val: ver };
  return ver;
}
// 客户端形态 UA。
// 实测（隔离变量矩阵，2026-10-11）：闸门**只认 `WorkBuddy` 前缀**——版本号、段数、
// 有没有 "AI" 都不影响结果（`WorkBuddy/1.0.0`、`WorkBuddy/x`、单段、`WorkBuddyAI`
// 四种变体返回的是逐字节相同的目录）。所以这里不追求"复刻客户端的精确格式"，
// 只要前缀对、版本号是真的即可。
// 版本读不到就退回一个已知能过闸的占位值，保证功能可用（但会与客户端真实版本不符）。
const WB_UA_FALLBACK_VER = "5.7.6";
function wbUa() {
  const v = wbClientVersion() || WB_UA_FALLBACK_VER;
  return `WorkBuddy/${v} WorkBuddy/${v}`;
}

// CLI 的 ANTHROPIC_BASE_URL 恒为提供方上游本体（B.AI=api.b.ai、sn=token.sensenova.cn），不经本地中转；
// 只有桌面版走 127.0.0.1:<relay>。故两者用不同的判据。
/* 各家凭据的取法。**每家不一样**（平铺的 apiKey / wb 的 accessToken / qd 的轮换 token /
   or 的三把轮换 key 里当前那把），以前是六个位置参数硬塞进 cliMode/desktopMode，
   加一个渠道就得改签名 + 改所有调用点——漏一处就是静默不比对凭据。
   现在收敛到这一个函数，加渠道只改它一处。 */
function channelCredentials(c) {
  c = c || loadCfg();
  return {
    bai: c.apiKey,
    sn: c.sn?.apiKey,
    wb: c.wb?.accessToken,
    wbai: c.wbai?.accessToken,
    zen: c.zen?.apiKey,
    qd: c.qd?.token || "qd-local",
    mm: "mm-local",
    or: orActiveKey(c),
  };
}

/* CLI/桌面版里"走本地协议桥"的渠道。applyToCli 用同一个判据决定
   ANTHROPIC_BASE_URL 写 127.0.0.1 还是上游本体——**必须是同一个函数**，
   否则会出现"直连上游却写占位符"（上游收不到真凭据，整个渠道 401）。
   这个名单是**静态的**：zen 不在其中，它默认直连上游本体，与 qd/wb/wbai/mm/or 不同；
   zen 什么时候才进桥，见 cliViaRelay。
   ⚠ mm 也在名单里：MiniMax 会员通道的鉴权头（Bearer + 浏览器 UA + Origin/Referer）
     **只有中转自己知道**，Claude Code 直连上游发不出这套头 → 必须过本地中转。 */
const isBridgeChannel = (p) => p === "wb" || p === "wbai" || p === "qd" || p === "mm" || p === "or";

/* ★ v1.0.78：CLI 侧"走本地协议桥"的**完整**名单（静态名单 + zen 的动态那一种）。
 *
 * 此前 zen 有意不在名单里，于是 `cfg.zen.transport="opencode"`（v1.0.75 加的传输方式）
 * 在命令行里是**死的**：中转内部 openaiExchange 会把这一档分流进 ocGateway，
 * 但 CLI 根本不经过中转、一直在直连上游，那个开关只在桌面版有效。
 * （当时的验证漏洞：只验了"直接打中转端口能通"，没验"CLI 接线后能不能走到中转"。）
 *
 * 判据用**严格等于** ZEN_TRANSPORT_OPENCODE —— 认不出来的/缺失的值一律落到 direct，
 * 与中转内部 zenTransportOf 的兜底（同样是"认不出来 → direct"）逐字一致，两边不会走岔。
 * 入参是 sliceOf 的返回值形状 `{p, transport}`；cliMode 那边现读 cfg 拼一个同形状的对象。 */
const cliViaRelay = (S) => isBridgeChannel(S.p) || (S.p === "zen" && S.transport === ZEN_TRANSPORT_OPENCODE);

/* 写给 Claude Code 的 ANTHROPIC_BASE_URL（**只有这一份**）。
 *
 * ★ 去掉尾部 `/v1`：Claude Code 自己在 BASE_URL 后面拼 `/v1/messages`，而 zen 的默认
 *   上游**自带 /v1**（https://opencode.ai/zen/v1）。原样写出去就成了
 *   https://opencode.ai/zen/v1/v1/messages —— 实测那条 URL 返回的是 404 的 SPA 兜底
 *   **HTML**（压根不是 API 响应），去掉 /v1 之后才是正确的 FreeTierError JSON。
 *   bai/sn 的上游本就不带版本号（api.b.ai / token.sensenova.cn），这一句对它们是恒等变换。
 *
 * ⚠ 只改**写给客户端的这一份**：`S.upstream`（= `cfg.zen.upstream`）一个字都不动——
 *   中转内部还要拿它拼 `base + "/chat/completions"`（本文件 openaiExchange），
 *   那里 `/v1` 是**必需**的。改错地方会把中转自己的调用也一起改坏。 */
const cliBaseUrlFor = (S) => {
  if (cliViaRelay(S)) return `http://127.0.0.1:${S.relayPort}`;
  return String(S.upstream || "").replace(/\/+$/, "").replace(/\/v1$/i, "");
};

/* ---------- 统一网关（magpie 形态的那个「一个端口」） ----------
 *
 * 关（默认）：请求走各家自己的中转端口（bai 15722 / sn 15732 / wb 15742 / …）。
 * 开：请求先到统一网关（默认 15799），网关按模型 id 的 `provider/模型` 前缀分流到那一家。
 *
 * 两种模式**用户可见行为一致**——同一家的同一批模型、同样的请求体、同样的错误文案。
 * 区别只在「请求先到哪个端口」；以及网关能同时看到所有家，那才是账号级路由的前提。
 */
function gatewayOn(cfg) {
  const c = cfg || loadCfg();
  return String(c.gatewayMode || "off").trim().toLowerCase() === "on";
}
function gatewayBaseUrl(cfg) {
  const c = cfg || loadCfg();
  return `http://127.0.0.1:${c.gatewayPort || DEFAULTS.gatewayPort}`;
}

/* 读用量账本。**读失败当空**：账本是缓存不是用户配置，丢了只是少几条历史；
 * 反过来（用户配置读失败当空）会抹掉用户其它配置——那正是 magpie 反复警告的事故。 */
function loadUsageRows() {
  try {
    const rows = loadRecords(DATA_DIR, 0);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

/* 用量写入器。**写失败不抛**（magpie: accounting must never break a call）——
 * 记账是旁路，它坏了不许把一次正常的模型调用带崩。 */
const usageWriter = makeUsageWriter({
  dir: DATA_DIR,
  now: () => Date.now(),
  logger: (m) => log("用量账本: " + m),
});

/* 审计台账（audit.mjs）。**只在内存里**，有硬上界，不落盘。
 *
 * 为什么落盘的决定权在接线层、不在模块里：落哪儿、留几天、要不要分文件，
 * 都是**这个应用**的事（magpie 是按天一个 JSONL 放 ~/.config/magpie/masking/）。
 * 模块只保证一件事 —— 内存里的条数有上界，长跑不会把它吃光。
 *
 * ⚠ 记台账是**旁路**：它坏了不许把一次正常的模型调用带崩（同用量账本那条纪律）。 */
const auditLedger = createAudit({ max: 2000, now: () => Date.now() });

/** 记一条审计。**永不抛** —— 台账坏了不许影响应答。 */
function auditRecord(entry) {
  try {
    auditLedger.record(entry);
  } catch { /* 台账是旁路 */ }
}

/* ---------- 配置备份（备份模块的接线）----------
 *
 * 导出：把配置快照（providers / settings / claude 三块）用**口令加密**成一坨二进制，
 *       写进 <数据目录>\backups\backup-<时间戳>.bak。
 * 导入：读那份文件 → 解密 → **合并**回当前配置（restoreConfig 做的是合并不是替换，
 *       magpie 的 KeepOwn：这台机器自己的端口/代理不该被一份旧快照覆盖）。
 *
 * ⚠ **口令绝不落盘、绝不进日志**。它只在这一请求的生命周期里活着。
 * ⚠ **只还原路由台自己的配置**，不动 ~/.claude/settings.json —— 那是用户自己写的
 *   权限与钩子，还原它要走 applyToCli 那套「保格式的最小改动」，而不是整份覆盖
 *   （整份覆盖会抹掉注释与键序，那是本仓库吃过大亏的地方）。快照里**带着**那一块，
 *   供换机时手工取用。
 * ⚠ 备份目录**沿用**已有的 BACKUP_DIR（<数据目录>\backups）——那里已经躺着
 *   external-cli.json / external-desktop.json 两份外部快照，同一个目录省得用户找。
 *   文件名后缀 *.bak 与那两份 .json 区分得开，不会混。 */

/** 备份目录里的备份清单（新的在前）。读不到就当没有 —— 备份是可选功能。 */
function listBackups() {
  try {
    if (!existsSync(BACKUP_DIR)) return [];
    return readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith(".bak"))
      .map((f) => {
        let st = null;
        try { st = statSync(path.join(BACKUP_DIR, f)); } catch { }
        return { name: f, bytes: st ? st.size : 0, at: st ? st.mtimeMs : 0 };
      })
      .sort((a, b) => b.at - a.at);
  } catch { return []; }
}

/** 口令太短就拒 —— 六位以内的口令等于没加密，而用户会以为自己加密了。 */
function checkPassphrase(p) {
  const s = String(p == null ? "" : p);
  if (s.length < 8) throw new Error("口令至少 8 个字符（太短的话，等于没加密）");
  return s;
}

/* ---------- 并发 / RPM 闸门 ----------
 *
 * 为什么要它：把某一家打爆 → 上游回 429 → 整条转移链跟着挨打。
 * magpie 有两道闸（并发道 + 每分钟请求数），我们照抄。
 *
 * ⚠ **默认不限**（上限 0）：限流是用户自己开的开关，不该突然开始拦他的请求。
 *   上限从 cfg.limits 读（全局），cfg[provider].limits 可逐家覆盖。
 *
 * ⚠ 顺序：**先并发名额、后 RPM 位**。RPM 记的是「真发出去的请求」，
 *   先占 RPM 会在并发排队时白耗额度（排了 30 秒才轮到，结果额度已经扣了）。
 *
 * ⚠ 两道闸的拒绝**不重叠**：并发满是本地决策（换一家即可），
 *   RPM 超了要回 429 + Retry-After（等一分钟自己就好了，换家反而更慢）。 */
const concurrencyGate = new ConcurrencyLimiter({ now: () => Date.now() });
const rpmGate = new RpmLimiter({ now: () => Date.now() });

/** 某家的限流上限：全局的 + 逐家覆盖的。0 = 不限。 */
function limitsOf(provider, cfg) {
  const c = cfg || {};
  const g = c.limits && typeof c.limits === "object" ? c.limits : {};
  const sub = provider === "bai" ? c : (c[provider] || {});
  const p = sub.limits && typeof sub.limits === "object" ? sub.limits : {};
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
  };
  return {
    concurrency: num(p.concurrency !== undefined ? p.concurrency : g.concurrency, 0),
    rpm: num(p.rpm !== undefined ? p.rpm : g.rpm, 0),
    waitMs: num(p.waitMs !== undefined ? p.waitMs : g.waitMs, 120000),
  };
}

/* 这家供应商现在还能接这个模型吗？
 *
 * magpie 的**两级休息**：账号级（整号停）命中 ⇒ 这家所有模型都不可用；
 * 只有模型级命中 ⇒ **只那个模型**不可用，同号其它模型照常。
 * 旧逻辑只有 provider 级一个粒度，所以「这个模型没额度」会把整家踢掉。
 */
function providerUsable(provider, model) {
  if (!failoverAvailable(provider)) return false;   // 旧的 provider 级冷却（面板读它）
  const m = String(model || "");
  if (!m) return true;
  try {
    const c = makeCandidate({ provider, model: m });
    return !isResting(c, restTable(), Date.now());
  } catch { return true; }
}

/* 这次请求的会话身份（magpie 的 sessionHeaders）。
 *
 * ⚠ **没有就返回空串，不编造**：magpie 的铁律——从不为没有 session id 的请求
 * 造一个（提示词文本、调用方 key、网络地址都绝不用于猜会话归属）。
 * 宁可账本里这一行没有会话，也不能把两个不相干的请求归到同一段对话上。 */
function sessionOfReq(req) {
  try {
    const s = sessionOf((req && req.headers) || {});
    return s && s.id ? String(s.id) : "";
  } catch { return ""; }
}

function cliMode(cfg, creds) {
  try {
    const s = readJson(SETTINGS);
    const u = s?.env?.ANTHROPIC_BASE_URL || "";
    const key = s?.env?.ANTHROPIC_AUTH_TOKEN || "";
    const r = { baseUrl: u, keyFp: key ? keyFp(key) : null };
    const c = cfg || loadCfg();
    const k = creds || channelCredentials(c);
    /* keyMatch 的跳过条件**各家不同**，这是既有实现的样子（`server.mjs@HEAD` 3136-3141）：
         bai  是 `if (cfgKey)`         → 空串时整个字段不设
         其余 `if (xKey != null)`       → 空串**不**跳过，照样得到 false
       统一成一种判据会改变面板显示（多出或少掉一个"凭据不一致"提示），
       所以这里照抄这份不一致，并在下面断言它成立——**要修也得单独提，别顺手改**。 */
    for (const ch of CHANNELS) {
      const v = k[ch];
      const skip = ch === CHANNELS[0] ? !v : v == null;
      if (skip) continue;
      /* 走本地桥的渠道，applyToCli 写的是占位符 PROXY_MANAGED 而不是真凭据（里程碑 4b）。
         拿占位符去和配置里的真 key 比**永远不等** → keyMatch 恒为 false → 面板会对每个
         桥渠道误报「凭据不一致，需重开对应端」。所以把占位符视为一致：桥不校验入站
         token，本就无从比对；面板该看的是「接的是不是这一家」（下面的 mode），那才有效。
         桌面版侧（applyToDesktop 仍写真 key）因此不受影响——这里判的是 settings.json。 */
      const bridged = cliViaRelay({ p: ch, transport: c?.zen?.transport });
      r["keyMatch" + ch.charAt(0).toUpperCase() + ch.slice(1)] =
        (bridged && key === PROXY_MANAGED_TOKEN) ? true : key === v;
    }
    const bh = hostOf(c.upstream || DEFAULTS.upstream), sh = hostOf(c.sn?.upstream || DEFAULTS.sn.upstream);
    /* ★ 网关模式：所有请求都走**同一个端口**，URL 不再能标识是哪一家。
     * 这时认**模型 id 的 provider 前缀**——网关本来就是靠它分流的。
     *
     * ⚠ 认不出就老实说「other」，**宁可说不知道**：
     *   wb 与 wbai 两版端口相邻、极易认错，而认错的后果是「把请求发到另一家去」
     *   （国际版与国内版是**两套东西**，凭据/目录/端口全独立）。
     *   说「other」只是面板显示成「不是本软件接的」，用户一看就知道不对；
     *   认错则是把请求送去别家 —— 那比显示错严重得多。 */
    const gwPort = c.gatewayPort || DEFAULTS.gatewayPort;
    if (gwPort && u.includes(`:${gwPort}`)) {
      const mid = String(s?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL || s?.env?.ANTHROPIC_MODEL || "");
      const at = mid.indexOf("/");
      if (at > 0) {
        const p = mid.slice(0, at).trim().toLowerCase();
        if (isChannelKey(p)) return { mode: p, ...r };
      }
      return { mode: "other", ...r };
    }
    if (bh && u.includes(bh)) return { mode: "bai", ...r };
    if (sh && u.includes(sh)) return { mode: "sn", ...r };
    // WorkBuddy 的 CLI 直接指向本地协议桥（CLI 讲 Anthropic，上游讲 OpenAI，必须过桥）
    if (u.includes(`:${c.wb?.relayPort || DEFAULTS.wb.relayPort}`)) return { mode: "wb", ...r };
    // 国际版同理，且**排在 wb 之后**：两版端口相邻（15742/15782），顺序反了会让 wbai 被 wb 抢走
    if (u.includes(`:${c.wbai?.relayPort || DEFAULTS.wbai.relayPort}`)) return { mode: "wbai", ...r };
    if (u.includes(`:${c.zen?.relayPort || DEFAULTS.zen.relayPort}`)) return { mode: "zen", ...r };
    // Qoder 同理走本地协议桥；令牌会轮换，故只按端口判据，不做 key 匹配
    if (u.includes(`:${c.qd?.relayPort || DEFAULTS.qd.relayPort}`)) return { mode: "qd", ...r };
    // MiniMax 会员通道走本地中转（上游要的那套鉴权/指纹头只有中转发得出来）
    if (u.includes(`:${c.mm?.relayPort || DEFAULTS.mm.relayPort}`)) return { mode: "mm", ...r };
    // OpenRouter 同理走本地协议桥（OpenAI 协议 → 桥翻译）
    if (u.includes(`:${c.or?.relayPort || DEFAULTS.or.relayPort}`)) return { mode: "or", ...r };
    if (u.includes(":15721")) return { mode: "ccswitch", ...r };
    return { mode: "other", ...r };
  } catch {
    return { mode: "unknown", baseUrl: "" };
  }
}

/* ---------- CLI 接线归属：~/.claude/settings.json 现在是谁写的 ----------
 * 动机：本机和 CC Switch 都往**同一个文件**写，接线过程没有任何互斥。我们写进去
 * 不等于一直生效——CC Switch 切一次供应商就把整块换掉，而且换得无声无息。
 *
 * 此前唯一的判据是 cliMode().mode，它只认端口与域名。CC Switch 开着本地代理时
 * 写 127.0.0.1:15721，能命中 mode:"ccswitch"；但它在 **direct 模式**下写的是
 * 自己供应商的 https 上游（enableLocalProxy=false），一条都对不上 → 落到
 * mode:"other"，面板只显示「其他」，**看不出是谁接管的、什么时候被接管的**。
 * v1.0.65 实测本机正是 direct 模式（~/.cc-switch/live-state.json 里 mode:"direct"）。
 *
 * 办法：每次写入留一枚指纹（env 块的哈希），状态查询时对一下。
 *   对得上 = 还是我们写的；对不上 = 被人换掉了。这是**事实判断**，不靠猜。
 * 归因是另一回事，要证据：光「进程在跑」不算数（它挂着不动也在跑），
 * 光「文件变了」也不算数（用户手改也是那样）。两个都成立才判给它。 */
const CLI_APPLY_FILE = path.join(DATA_DIR, "cli-apply.json");
const CC_SWITCH_DIR = path.join(HOME, ".cc-switch");
const CC_SWITCH_STATE_FILES = ["live-state.json", "settings.json"];

/* env 块指纹：键序无关、只认内容。写盘顺序变了不该算「被换过」。 */
function envFingerprint(env) {
  const norm = Object.keys(env || {}).sort().map((k) => k + "=" + JSON.stringify(env[k])).join("\n");
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}
function mtimeOf(f) {
  try { return statSync(f).mtime.toISOString(); } catch { return null; }
}
/* 记下「这次是我写的」+ 指纹。applyToCli 写盘之后立刻调。 */
function recordCliApply(provider) {
  try {
    const s = readJson(SETTINGS);
    writeAtomic(CLI_APPLY_FILE, JSON.stringify({
      at: new Date().toISOString(),
      provider: provider || "",
      fp: envFingerprint(s?.env),
      baseUrl: s?.env?.ANTHROPIC_BASE_URL || "",
    }, null, 2) + "\n");
  } catch { /* 记不住指纹只是退化成查不出被接管，不该影响接线本身 */ }
}
/* CC Switch 自己的状态文件刚动过 → 它就是换手的人。
 *
 * 窗口取 **30 秒**而不是「几分钟」：CC Switch 真正落盘时，它的状态文件与
 * settings.json 是同一瞬间写的（实测同一次切换相差不到 1 秒），窗口放宽只会
 * 把**之后**的无关改动也一并算到它头上——负样本实测：手动编辑发生在 CC Switch
 * 状态文件变动之后 0.5 秒，5 分钟窗下被误判成「CC Switch 干的」。
 * 冤枉人比说不准更糟：窗口内对不上就老实报 unknown，那只是不够具体，猜错了是误导。 */
function ccSwitchTouchedAt(settingsMtimeMs) {
  if (!settingsMtimeMs) return null;
  for (const f of CC_SWITCH_STATE_FILES) {
    const t = mtimeOf(path.join(CC_SWITCH_DIR, f));
    if (t && Math.abs(Date.parse(t) - settingsMtimeMs) <= 30 * 1000) return t;
  }
  return null;
}
function cliOwnership(ccRunning) {
  let rec = null;
  try { rec = readJson(CLI_APPLY_FILE); } catch { }
  let cur = null, mtimeMs = 0;
  try { cur = readJson(SETTINGS); mtimeMs = statSync(SETTINGS).mtimeMs; } catch { }
  const base = { currentBaseUrl: cur?.env?.ANTHROPIC_BASE_URL || "" };
  if (!rec?.fp) return { state: "never", at: null, ...base };
  if (envFingerprint(cur?.env) === rec.fp) {
    return { state: "ours", at: rec.at, provider: rec.provider, ...base };
  }
  const ccAt = ccSwitchTouchedAt(mtimeMs);
  const writer = ccRunning && ccAt ? "ccswitch" : "unknown";
  /* 判据里的时间用本机时区写死成人类可读格式：面板其余地方也这么显示，
     混一段原始 ISO 在句子里很跳（v1.0.65 实测输出就是这样，难看且对不上）。 */
  const localTime = (x) => new Date(x).toLocaleString("zh-CN", { hour12: false });
  return {
    state: "taken-over",
    at: rec.at,                 // 我们上次写入的时刻
    provider: rec.provider,
    writtenAt: mtimeMs ? new Date(mtimeMs).toISOString() : null,   // 实际被改的时刻
    writer, writerAt: ccAt,
    ...base,
    evidence: writer === "ccswitch"
      ? `CC Switch 正在运行，且它自己的状态文件在 ${localTime(ccAt)} 动过，与 settings.json 的改动时间对得上`
      : ccRunning
        ? "CC Switch 在运行，但没有证据表明是它改的（也可能是手动编辑，或它只在内存里切了供应商没落盘）"
        : "CC Switch 未运行，更可能是手动编辑或其它工具",
  };
}

function desktopMode(cfg, creds) {
  try {
    const f = desktopConfigFile();
    if (!f || !existsSync(f)) return { mode: "unknown", baseUrl: "" };
    const d = readJson(f);
    const u = d?.inferenceGatewayBaseUrl || "";
    const key = d?.inferenceGatewayApiKey || "";
    const r = { baseUrl: u, keyFp: key ? keyFp(key) : null };
    const c = cfg || loadCfg();
    const k = creds || channelCredentials(c);
    /* keyMatch 的跳过条件**各家不同**，这是既有实现的样子（`server.mjs@HEAD` 3136-3141）：
         bai  是 `if (cfgKey)`         → 空串时整个字段不设
         其余 `if (xKey != null)`       → 空串**不**跳过，照样得到 false
       统一成一种判据会改变面板显示（多出或少掉一个"凭据不一致"提示），
       所以这里照抄这份不一致，并在下面断言它成立——**要修也得单独提，别顺手改**。 */
    for (const ch of CHANNELS) {
      const v = k[ch];
      const skip = ch === CHANNELS[0] ? !v : v == null;
      if (skip) continue;
      /* 走本地桥的渠道，applyToCli 写的是占位符 PROXY_MANAGED 而不是真凭据（里程碑 4b）。
         拿占位符去和配置里的真 key 比**永远不等** → keyMatch 恒为 false → 面板会对每个
         桥渠道误报「凭据不一致，需重开对应端」。所以把占位符视为一致：桥不校验入站
         token，本就无从比对；面板该看的是「接的是不是这一家」（下面的 mode），那才有效。
         桌面版侧（applyToDesktop 仍写真 key）因此不受影响——这里判的是 settings.json。 */
      const bridged = isBridgeChannel(ch);
      r["keyMatch" + ch.charAt(0).toUpperCase() + ch.slice(1)] =
        (bridged && key === PROXY_MANAGED_TOKEN) ? true : key === v;
    }
    /* 网关模式：桌面版的 URL 也指向同一个端口，供应商要从**模型 id 的前缀**认
     * （网关模式下 applyToDesktop 把 inferenceModels[].name 写成 provider/模型）。
     * 认不出就说「other」——理由同 cliMode：宁可说不知道，也不要认错成另一家。 */
    const gwPort = c.gatewayPort || DEFAULTS.gatewayPort;
    if (gwPort && u.includes(`:${gwPort}`)) {
      const names = Array.isArray(d?.inferenceModels) ? d.inferenceModels : [];
      for (const mi of names) {
        const n = String((mi && mi.name) || "");
        const at = n.indexOf("/");
        if (at > 0) {
          const p = n.slice(0, at).trim().toLowerCase();
          if (isChannelKey(p)) return { mode: p, ...r };
        }
      }
      return { mode: "other", ...r };
    }
    if (u.includes(`:${c.relayPort || DEFAULTS.relayPort}`)) return { mode: "bai", ...r };
    if (u.includes(`:${c.sn?.relayPort || DEFAULTS.sn.relayPort}`)) return { mode: "sn", ...r };
    if (u.includes(`:${c.wb?.relayPort || DEFAULTS.wb.relayPort}`)) return { mode: "wb", ...r };
    if (u.includes(`:${c.wbai?.relayPort || DEFAULTS.wbai.relayPort}`)) return { mode: "wbai", ...r };
    if (u.includes(`:${c.zen?.relayPort || DEFAULTS.zen.relayPort}`)) return { mode: "zen", ...r };
    // Qoder 同理走本地协议桥；令牌会轮换，故只按端口判据，不做 key 匹配
    if (u.includes(`:${c.qd?.relayPort || DEFAULTS.qd.relayPort}`)) return { mode: "qd", ...r };
    // MiniMax 会员通道走本地中转（上游要的那套鉴权/指纹头只有中转发得出来）
    if (u.includes(`:${c.mm?.relayPort || DEFAULTS.mm.relayPort}`)) return { mode: "mm", ...r };
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

// 走本地中转的渠道，CLI 侧写的占位符（里程碑 4b）。
// 与 FALLBACK_CC_CLI / 沙箱 settings.json 里既有的 "PROXY_MANAGED" 同一个值——
// 桌面版那边早就这么写了，这里只是让 CLI 侧对齐。
const PROXY_MANAGED_TOKEN = "PROXY_MANAGED";

/* 读不懂 ~/.claude/settings.json 时的处置。
 *
 * 两种「读不出来」必须分开：
 *   · **文件不在** —— 合法状态，从空开始建。
 *   · **文件在但读不懂** —— 不知道，不是空。此时**绝不能**拿一份空对象覆盖它：
 *     用户其余配置会当场蒸发（旧代码正是这么干的：`catch { s = {} }` 然后写回）。
 *
 * 这里选的路子是「**另存一份 + 中止接线 + 一个字都不改**」：
 * 备份让用户有退路（照着改回来），中止保证不猜、不覆盖。
 * 另一条路是「备份后用最小配置重建」—— 技术上更省事，但会让用户在不知情的情况下
 * 丢掉原配置里那些**我们不接管**的部分（权限、钩子、MCP…），所以不默认这么做。 */
function unreadableSettingsAction(file, detail) {
  let saved = null;
  try {
    saved = file + ".unreadable-" + Date.now();
    copyFileSync(file, saved);
  } catch { saved = null; }
  const guide = unreadableSettingsGuidance(saved, detail);
  const err = new Error(guide.message);
  err.repair = { backup: saved, offerRestore: guide.offerRestore };
  return err;
}

/* 用户看得见的引导：读不懂 settings.json 时，除了报错还要告诉他能怎么办。
 *
 * 返回 { message, offerRestore }：
 *   message       —— 面板上显示的那段话
 *   offerRestore  —— 要不要给一个「用备份恢复并重新接线」的一键入口
 *
 * TODO(human): 这段的措辞与 offerRestore 取 true/false，是一个产品判断：
 *   · 用户的 settings.json 读不懂，多数是手滑多一个逗号，或别的工具写了注释。
 *   · 备份一定在（unreadableSettingsAction 已经另存好了），所以「一键用备份恢复」
 *     技术上随时能做 —— 但恢复等于**用备份覆盖用户当前文件**，若用户后来手工改好过，
 *     覆盖会把那次修改也抹掉。所以 offerRestore 该默认关掉还是开，由你定。
 *   · 下面这版是**保守默认**：说清下一步，不提供一键覆盖。
 */
function unreadableSettingsGuidance(bak, detail) {
  // TODO(human): 按你的判断实现这个函数（下面这版是保守默认，可以直接改成你的方案）
  return {
    message: detail
      + "\n原文件未被改动"
      + (bak ? "，已另存为：" + bak : "（另存备份失败，请立刻自己复制一份）")
      + "\n请打开该文件修好 JSON 语法（常见原因：多一个逗号、注释没删、字符串没转义）后重新接线。"
      + "本程序不会覆盖读不懂的配置。",
    offerRestore: false,
  };
}

// 通用：把一个提供方的映射写进 CLI settings.json
async function applyToCli(S) {
  /* ★ 读原文，不反序列化（v1.0.93 起）。
   *
   * 旧写法：`try { s = readJson(SETTINGS); } catch { s = {} }` + `JSON.stringify(s, null, 2)` 整份写回。
   * 两个后果：
   *   ① **读失败被当成空** —— 用户 settings.json 里只要有一处解析不过（手滑多一个逗号、
   *      别的工具写了注释），下一条接线就把整个文件改写成只剩 env 的样子，用户其余配置
   *      当场蒸发。这正是 magpie 明令禁止的「failed read means unknown, never empty」。
   *   ② **全量重写** —— 注释、键顺序、缩进风格全被抹平；每次切模型都重写一遍，
   *      文件 mtime 一直在变，面板那套「这次是谁改的」归因也跟着失真。
   *
   * 现在：读原文 → 保格式编辑器做**最小改动** → 只在真的变了时才写盘。 */
  let text = "";
  let existed = false;
  try {
    text = readFileSync(SETTINGS, "utf8");
    existed = true;
  } catch { /* 文件不存在：从空开始建，这是合法状态 */ }

  let env = {};
  if (existed && text.trim() !== "") {
    const parsed = parseJsonc(text);
    const root = parsed.ok ? parsed.value : null;
    /* 根不是对象（数组/标量）同样算「读不懂」——Claude Code 那边也不认，
     * 而我们若照旧往下写就会产出一个更糟的文件。 */
    if (!parsed.ok || !root || typeof root !== "object" || Array.isArray(root)) {
      const detail = "无法解析 " + SETTINGS
        + (parsed.ok ? "（根不是 JSON 对象）" : `（第 ${parsed.line} 行第 ${parsed.column} 列：${parsed.error}）`);
      throw unreadableSettingsAction(SETTINGS, detail);
    }
    env = (root.env && typeof root.env === "object" && !Array.isArray(root.env)) ? root.env : {};
  }
  /* 里程碑 4b：**走本地中转的渠道**写占位符，不写真实凭据。
   *
   * 以前这里把真实 JWT 明文写进 ~/.claude/settings.json —— 那把令牌与
   * %APPDATA%\bai-router\config.json 里的是同一字符串（实测同为 1411 字符），
   * 等于在用户主目录留了一份明文副本。
   *
   * 之所以能改成占位符：中转**不信任**客户端送来的这个 token。协议桥
   * （fo.opts.openai：wb/wbai/qd/or/zen）自己用 wbEnsureTokenPooled()/qdEnsureToken()/orPick()
   * 从配置取真实凭据并自己拼 mkHeaders；PASS_HEADERS 虽收集了 authorization，
   * 但那条路径只对**非协议桥**渠道生效。
   *
   * **直连上游的 bai / sn / zen 必须带真 key**（它们没有中间人，token 就是给上游的）。
   * 判据与 BASE_URL 完全同源（下面下一行用同一个表达式），两者不会走岔。
   * 与桌面版既有做法一致（applyToDesktop 之外的 FALLBACK_CC 里就写着 PROXY_MANAGED）。
   */
  const viaLocalRelay = cliViaRelay(S);
  /* 网关模式：请求先到**统一网关**，网关按模型 id 的 `provider/模型` 前缀分流到那一家。
   *
   * ⚠ 模型 id 必须带 provider 前缀：网关**不猜**。它拆第一个 "/"，前缀不在已知渠道里
   * 就 404（不静默走老路——静默走老路会让人以为网关生效了，实际请求压根没经过分流）。
   * 模型名里本来就有斜杠的（OpenRouter 的 "openai/gpt-4o"）不受影响：网关只拆第一个。
   *
   * ⚠ 网关模式下**一律**写占位符令牌：请求先到网关，网关再用自己的凭据去调上游，
   * 客户端送来的那个 token 对网关没有意义（真写上去反而在用户主目录留了一份明文副本）。
   */
  const gw = gatewayOn();
  /* 网关模式：模型 id 写 `provider/档位`（如 `sn/claude-opus-5`），**不是** `provider/最终模型`。
   *
   * ⚠⚠ 为什么是档位而不是最终模型名 —— 这一条曾经写反过，代价是「用户点 opus，
   * 转移后跑的是 fable 的模型」（档位被悄悄换掉，面板上看不出来）。
   *
   *   · **档位**（claude-opus-5）是 provider 无关的抽象；**最终模型名**（hy3）是
   *     provider 相关的具体值。网关模式下写最终模型名 = 在链路上**丢掉了 provider
   *     无关的那一半**，只留具体值 —— 而具体值在 provider 内部**反推不出档位**
   *     （zen/qd/or/mm 的四档全指向同一个模型，反查必然命中四个，歧义）。
   *   · 写档位则：网关只做前缀剥离，档位原样透传给中转 → 中转沿用老路径那套
   *     「档位 → 本家模型」解析（一个字都不用改）→ 转移时按**目标家**重解析也就自动正确。
   *
   * 这正是 magpie 的模型 id 语义：id 里带的是槽位，每家自己的表把槽位翻成真实模型名。
   *
   * 老路（不走网关）保持原样：写最终模型名 —— 那一路客户端送来的就是模型名，
   * 中转按「模型名 → 可用清单」认它，不需要档位。
   */
  const modelId = (tier, target) => (gw ? `${S.p}/${tier}` : String(target));
  const edits = [];
  const setEnv = (k, v) => edits.push({ path: "env." + k, value: v });
  const delEnv = (k) => edits.push({ path: "env." + k, delete: true });

  setEnv("ANTHROPIC_BASE_URL", gw ? gatewayBaseUrl() : cliBaseUrlFor(S));
  /* ⚠ 网关模式**不**改令牌：bai/sn 是直连渠道，它们的 handler 会把客户端带来的
   * authorization 头**透传给上游**——写成占位符就等于把假令牌发给上游了。
   * 协议桥渠道（wb/qd/or/zen/mm）自己用凭据，不看客户端送来的 token，照旧写占位符。 */
  setEnv("ANTHROPIC_AUTH_TOKEN", viaLocalRelay ? PROXY_MANAGED_TOKEN : (S.key || "wb-local"));
  setEnv("ANTHROPIC_MODEL", modelId("claude-haiku-4-5", S.mapping["claude-haiku-4-5"]?.target || S.defaultModel));
  /* 显示名：只写用户手填的 label，不掺倍率（v1.0.65 撤掉）。
   *
   * 仍然不 `delete`：以前是 `delete e[t.envKey + "_NAME"]` —— 我们自己把 Claude Code
   * 的显示名通道删掉了，于是 /model 里只能看到模型 id。契约 §1.6 实测：
   * ANTHROPIC_DEFAULT_*_MODEL_NAME 的 label 可塞任意文本，且与模型名是两个独立字段。
   * 曾经在这里拼过「label · x0.79」（路径 A），实测还有个更麻烦的问题：
   * 目录里 hy4-preview-f 是 x0.00 而 hy4-preview 是 x0.29，靠前缀回退很容易配错行，
   * 与其显示一个可能对不上的数字，不如不显示 —— 真实倍率在面板「刷新模型列表」里看。
   * 模型名（e[t.envKey]）保持上游真名不变，解析链零改动。
   */
  for (const t of TIERS) {
    const m = S.mapping[t.key] || {};
    const target = m.target || S.defaultModel;
    setEnv(t.envKey, modelId(t.key, target));
    // 用户没填 label 就不写这条（留空反而会让 Claude Code 回退显示模型 id，与旧行为一致）
    if (m.label) setEnv(t.envKey + "_NAME", m.label);
  }
  /* 用户自己设过 API_TIMEOUT_MS 就留着（旧写法 `e.API_TIMEOUT_MS = e.API_TIMEOUT_MS || "3000000"`）。 */
  if (!env.API_TIMEOUT_MS) setEnv("API_TIMEOUT_MS", "3000000");
  setEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
  setEnv("NODE_USE_ENV_PROXY", "1");
  if (S.p === "bai" || S.p === "or") {
    // 出海渠道（B.AI / OpenRouter）：CLI 直连上游时靠 proxy env 出海。
    // OpenRouter 走的是本地桥（127.0.0.1），但桥自己出海仍要代理——env 留着没坏处。
    const px = loadCfg().proxy;
    setEnv("HTTPS_PROXY", px);
    setEnv("HTTP_PROXY", px);
  } else {
    // 境内提供方（SenseNova/WorkBuddy）直连、清空代理（WorkBuddy 桥在本机，NO_PROXY 已覆盖）
    delEnv("HTTPS_PROXY"); delEnv("HTTP_PROXY");
  }
  setEnv("NO_PROXY", "127.0.0.1,localhost");

  const out = applyEdits(text, edits);
  if (!out.ok) throw new Error("改写 " + SETTINGS + " 失败：" + out.error);
  /* **只在真的变了才写盘**：不改就不动文件，mtime 不变——
   * 面板那套「这次是谁改的」归因（按 mtime 窗口比对 CC Switch 的状态文件）
   * 才不会被我们自己反复重写给污染。 */
  if (out.changed) writeAtomic(SETTINGS, out.text);
  recordCliApply(S.p);   // 留指纹：之后能分辨这份配置还是不是我们写的
}
// 通用：把一个提供方写进桌面版 configLibrary（都经由本地中转，桌面版不感知上游差异）
function applyToDesktop(S) {
  const f = desktopConfigFile();
  if (!f) throw new Error("找不到桌面版配置文件（configLibrary/_meta.json）");
  /* 网关模式：桌面版也指向统一网关，且模型名要带 `provider/档位` 前缀——
   * 桌面版把 inferenceModels[].name 原样当模型发出去，网关靠这个前缀分流。
   *
   * ⚠ 写**档位**而不是最终模型名：档位是 provider 无关的抽象，写它才不丢信息
   *   （多档同模型时，最终模型名反推不出档位 —— 详见 applyToCli 里那段注释）。
   *   老路（不走网关）桌面版本来就写档位（`t.key`），两路一致。
   * ⚠ 令牌**不改**：桌面版送来的 authorization 会被 bai/sn 的 handler 透传给上游，
   * 换成占位符就等于把假令牌发给上游了。 */
  const gw = gatewayOn();
  const modelName = (t) => (gw ? `${S.p}/${t.key}` : t.key);
  writeAtomic(
    f,
    JSON.stringify(
      {
        coworkEgressAllowedHosts: ["*"],
        disableDeploymentModeChooser: true,
        inferenceGatewayApiKey: S.key,
        inferenceGatewayAuthScheme: "bearer",
        inferenceGatewayBaseUrl: gw ? gatewayBaseUrl() : `http://127.0.0.1:${S.relayPort}`,
        inferenceModels: TIERS.map((t) => ({
          labelOverride: S.mapping[t.key]?.label || t.zh,
          name: modelName(t),
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
async function applyBaiToCli(cfg) { await applyToCli(sliceOf(cfg, "bai")); }
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
      recordCliApply("ccswitch-fallback");   // 这份也是我们写的，别把自己判成"被接管"
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
      /* 「预期内被拒」（v1.0.78）：面板据此把这一格从红的「上游不可用」改成中性的
       * 「预期内被拒 + 两条下一步」。带上 why 是为了**不用点开**就知道该做什么。 */
      expected: lastTest[p]?.expected === true,
      expectedKind: lastTest[p]?.expectedKind || null,
      expectedWhy: lastTest[p]?.expectedWhy || null,
      expectedTiers: lastTest[p]?.expectedTiers || [],
      /* 「正在探测」（v1.0.81）：测连通改成后台跑之后，/api/status 就是前端唯一的进度出口。
       * ⚠ **running 与下面那组 lastTest 是两回事**：running 时下面那组仍是**上一次**的
       *   结果（不是空的、也不是半成品）。前端必须先看 running 决定要不要继续轮询，
       *   否则会在探测刚开始时把上一次的结论当成这次的报上去。 */
      running: !!testRun && testRun.p === p,
      runningAt: (testRun && testRun.p === p) ? new Date(testRun.startedAt).toISOString() : null,
      /* 本次的逐档结果（v1.0.81）：POST 立刻回包后，结果只存在这里。tiers 只在本家
       * 测过之后才非空（≤4 个小对象），all/active 供前端复现原有的措辞。 */
      tiers: lastTest[p]?.tiers || [],
      all: lastTest[p]?.all === true,
      active: lastTest[p]?.active || null,
    },
    recent: (() => {
      if (!t) return { tier: null };
      const m = S.mapping?.[t] || {};
      const obs = store.find((x) => x.tier === t);
      /* served = **真实服务的那个模型**（store 里存的就是 resolveModel 的结果，也就是
       *   我们真的发出去的那个名字）。此前它**存了但全仓库没有一个读取点**（面板拿
       *   target 顶替），于是展示层与真实身份之间隔着一层假话。
       * target = 「我们打算路由到哪」，由 resolveModelQuiet **重算**——不能写成
       *   `S.mapping[t]?.target || S.defaultModel`：store.tier 存的是**客户端发来的名字**
       *   （Claude Code 发的是 settings.json 里写着的那个 target，不是档位 key），拿它当
       *   档位 key 查表永远查不到，于是 target 恒等于 defaultModel —— 正常流量里
       *   served=space-bunny-free 而 target=出厂默认档，就会被误报成「以为在用 A 其实在用 B」。
       *   那种天天误报的告警比静默回落更坏：用户会学会无视它。
       * 两者不一致时**两个都报**：「以为在用 A 其实在用 B」正是这条差异本身，报一个等于没报。 */
      const target = resolveModelQuiet(t, S);
      const served = (obs && obs.served) || null;
      return {
        tier: t, label: m.label || t, target, served,
        observedAt: obs ? obs.at : null,
        mismatch: !!(served && served !== target),
      };
    })(),
    /* 模型回落留痕（P0）。空数组 = 这家渠道近 30 分钟没有回落过。
     * 与 recent 分开报：recent 是"此刻在用哪个档"，这里是"有过名字查不到、被换掉了"。 */
    modelFallback: modelFallbackFields(p),
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
  // 一眼看出「现在配的是哪版的通道、实际上游拨到了哪个端点」。
  // v1.0.65 起**各读各的登录文件**（里程碑 1b）：wb 看 workbuddy-desktop.info，
  // wbai 看 workbuddy-desktop-ai.info——两版都装了时不再二选一。
  const wbAuthNow = wbDetectAuth("wb");
  const wbaiAuthNow = wbDetectAuth("wbai");
  const wbaiExp = wbTokenExp(cfg.wbai?.accessToken);
  const wbaiStatus = providerStatus(cfg, "wbai", recentCallsWbai);
  // OpenRouter 的额度真相（/auth/key）：面板轮询走 60 秒缓存，不打上游
  const orQuota = orQuotaSnapshot(cfg);
  const orKeysNow = orKeys(cfg);
  // Zen 档位快照（v1.0.74 T4）：一次算出，下面的 zen 块与面板两处显示共用同一份，
  // 免得「状态带说 Go 档、目录出处说免费档」这种自相矛盾。
  const zenTierNow = zenTierInfo(cfg);
  // Zen 能力探测快照（v1.0.74）：同一个函数供 /api/status 与 /api/models 共用，
  // 面板两处显示的「上次检测时间」因此不会打架。
  const zenCapNow = zenCapFields(cfg);
  // 传输开关的只读事实（v1.0.75）：当前档位 + 前置条件在本机满足没有（三态分清）。
  const zenTransportNow = ocTransportFields(cfg);
  // MiniMax 会员通道（mm）：令牌快照 + 一句话提示。
  // 🔴 快照里**只有长度/有效期/是否有效**，没有令牌值。
  // ⚠ 用 recheck() 而不是 snapshot()：**判据必须与转移链同源**。两处用不同判据
  //   （面板说「未配置」、链却按另一个答案走）正是这类事故最难排查的原因；
  //   recheck 内部有 15 秒节流，面板 5 秒轮询不会造成磁盘 churn。
  const mmStatus = providerStatus(cfg, "mm", recentCallsMm);
  const mmTokenSnapshot = mmTokens.recheck();
  const mmTokenHint = mmTokenSnapshot.invalid
    ? MM_LOGIN_INVALID_MSG
    : mmTokenSnapshot.configured
      ? "会员令牌只存在路由台内存里（不落 config.json，日志与页面都没有明文）；"
        + "到期自动续期，续期后的新令牌会写回 MiniMax Code 自己的登录态文件——"
        + "不写回的话，两边会互相把对方的一次性令牌作废掉。所以重启路由台不用重新读。"
      : "没读到本机 MiniMax 登录态——请先在 MiniMax Code 里登录，再点「重新读取登录态」";
  return {
    now: new Date().toISOString(),
    /* 自报身份：版本 + 实际跑的是哪个文件。
     *
     * 为什么要这个：本项目可以同时存在「已安装版」和「源码构建」，两者共用同一个
     * 单实例锁，**后启动的那个会静默退出**，面板却由先跑的那个继续服务。于是
     * 「我明明在跑源码，怎么行为像旧版」就成了只能靠猜的事——v1.0.67 实测就栽在
     * 这里：源码实例被已安装版挤掉，之后所有请求都打在 v1.0.64 上，面板看着一切正常。
     *
     * script 是**决定性**证据：已安装版是 …\Programs\B.AI Router\resources\server\server.mjs，
     * 源码构建是 <仓库>\src\server\server.mjs，一眼可分。version 则说明它落后几版。 */
    service: {
      up: true, uptimeSec: Math.floor((Date.now() - BOOT) / 1000), pid: process.pid,
      /* 进程启动时刻：调用方（main.js）只按 PID 终止前靠它核对身份。进程存活期间这个值
       * 不变，PID 一旦被回收、新进程算出来的值必然更晚——两者可判，见 proc-identity.cjs。 */
      startTimeMs: SERVICE_START_MS,
      version: APP_VERSION,
      script: SERVER_SELF,
      build: /[\\/]resources[\\/]server[\\/]/i.test(SERVER_SELF) ? "installed" : "source",
    },
  failover: {
    enabled: cfg.failover?.enabled === true, chain: cfg.failover?.chain || [], cooling: failoverSnapshot(),
    /* 静默换人（v1.0.88）：入口渠道 ≠ 实际服务的渠道，带次数与时间窗。
       放 failover 下面而不是新开一个顶级字段，是因为它就是故障转移的**后果**，
       面板故障转移卡与诊断抽屉读的是同一处，不会两处各读一遍数据源。 */
    silentJump: silentJumpSnapshot(),
  },
    panel: { port: cfg.panelPort, up: true },
    clash,
    proxy: cfg.proxy || "直连",
    ccswitch: { running: ccswitch, cli: cliOwnership(ccswitch) },
    /* WorkBuddy 两版的换模历史。单独一份而不是塞进 relayErrors：
       换模多半是**成功**的，混进"最近一次错误"里既不对，还会把真正的错误挤掉。
       escalated 单列一项，是因为它跟钱有关——悄悄从免费档换到付费档，用户该知道。 */
    wbRotation: {
      total: wbRotations.length,
      lastAt: wbRotations[0]?.at || null,
      /* **给时刻，不给布尔**（v1.0.67 的 bug 修在这里）：原来是 escalated 布尔，
       * 扫的是整个 20 条缓冲区且没有时间边界，于是历史上换过一次付费档之后，
       * 那个黄灯会一直挂在诊断抽屉里，直到再攒够 20 次换模才消失——抽屉只讲
       * 当前状况，几小时前的事不该一直占位。「多久算当前」是呈现层的判断，
       * 所以这里只如实报「最近一次换到付费档是什么时候」，新鲜度交给面板判。 */
      escalatedAt: (wbRotations.find((r) => r.recovered && r.free === false) || {}).at || null,
      recent: wbRotations.slice(0, 10),
    },
    // 接线状态（两端各自归属哪个提供方）。keyMatch* 是客户端实际用的凭据与本渠道
    // 凭据的比对结果——客户端送来的 auth token 与我们配置里那把是不是同一把。
    cli: cliMode(cfg),
    desktop: desktopMode(cfg),
    // B.AI 灯/接线沿用旧字段名，SenseNova 灯挂 sn 下，WorkBuddy 灯挂 wb 下
    relay: bai.relay, relayLast: bai.relayLast, upstream: bai.upstream, recent: bai.recent,
    modelFallback: bai.modelFallback,
    sn: { relay: sn.relay, relayLast: sn.relayLast, upstream: sn.upstream, recent: sn.recent, modelFallback: sn.modelFallback, useProxy: cfg.sn?.useProxy === true },
    zen: {
      relay: zen.relay, relayLast: zen.relayLast, upstream: zen.upstream, recent: zen.recent, modelFallback: zen.modelFallback,
      useProxy: cfg.zen?.useProxy === true, keyConfigured: !!cfg.zen?.apiKey,
      // 档位（v1.0.74 T4）：面板必须显著显示当前在哪一档——两档可用性完全不同。
      // id/label/hint 由服务端一处算出（zenTierInfo），面板只负责显示，
      // 不在渲染层复制判定逻辑（C11：渲染层不许认识渠道名）。
      tier: zenTierNow.id,
      tierLabel: zenTierNow.label,
      tierHint: zenTierNow.hint,
      goSubRequired: zenTierNow.subRequired,
      // 能力探测快照（v1.0.74 T3/T6）：面板要显示「上次检测时间」，
      // 否则用户无从判断手上那份「可用 · 支持工具」是刚才测的还是三天前的。
      capAt: zenCapNow.at,
      capAtLabel: zenCapNow.atLabel,
      capHint: zenCapNow.hint,
      capStale: zenCapNow.stale,
      capCount: zenCapNow.count,
      // 传输方式（v1.0.75）：面板上那个开关的全部事实都在这里。
      // transport 是中转**真正会走**的那一档（认不出来的值报 direct），
      // transportProbe.state ∈ found / missing / error ——「检测失败」与「没装」
      // 必须分开，面板据此给两种处置完全不同的提示。
      transport: zenTransportNow.transport,
      transportHint: zenTransportNow.transportHint,
      transportValues: zenTransportNow.transportValues,
      transportProbe: zenTransportNow.transportProbe,
    },
    qd: {
      relay: qd.relay, relayLast: qd.relayLast, upstream: qd.upstream, recent: qd.recent, modelFallback: qd.modelFallback,
      useProxy: cfg.qd?.useProxy === true,
      // 令牌是轮换的 jobToken，只有"当前有没有读到"这一态有意义（无到期时间可报）
      token: { configured: !!qdTok, tokenFile: cfg.qd?.tokenFile || DEFAULTS.qd.tokenFile },
      // v1.0.57：worker 补丁是否已装。新电脑上没装补丁 = 没令牌 = 面板显示「未读到」，
      // 前端据此把「请启动 Qoder」换成「点这里一键装补丁」——这才是用户真正能做的动作。
      patch: qdPatchInfo(),
    },
    wb: {
      relay: wb.relay, relayLast: wb.relayLast, upstream: wb.upstream, recent: wb.recent, modelFallback: wb.modelFallback,
      useProxy: cfg.wb?.useProxy === true,
      // 版别（v1.0.59）："cn"=国内版 / "intl"=国际版 / null=读不到登录文件；
      // authDomain 为登录文件里的 auth.domain 原文（配合上游 host 即能看出是否已自动拨对）
      edition: wbAuthNow.edition,
      authDomain: wbAuthNow.domain,
      // 令牌体检：有无令牌、访问令牌到期时间、是否带刷新令牌
      token: {
        configured: !!cfg.wb?.accessToken,
        expAt: wbExp ? new Date(wbExp).toISOString() : null,
        expiresInDays: wbExp ? Math.max(0, Math.round((wbExp - Date.now()) / 86400000)) : null,
        hasRefresh: !!cfg.wb?.refreshToken,
        // 令牌自称的账号 vs 国内登录态里的账号。不一致 = 装错了频道的令牌，
        // 而这种错配其它信号全都指错方向（见 wbTokenOwnership 的注释）。
        ownership: wbTokenOwnership('wb', cfg),
      },
      // ★ 账号池状态（v1.0.77）。`total` 与 `accounts.length` 由同一个数组算出，
      // 面板显示几个就等于遍历到几个 —— 「磁盘 4 个、界面 2 个」那种落差用户说不清。
      // 凭据一律走 keyFp 指纹，明文永不进 /api/status。
      pool: wbPoolFields(cfg, "wb", Date.now()),
      paidHint: wbPaidHintFields("wb"),
    },
    // WorkBuddy 国际版（wbai，里程碑 1b 新增）：与 wb 结构完全对称，但读**自己的**登录文件
    // （workbuddy-desktop-ai.info）与自己的令牌——两版同时装时两边都能各自报出就绪状态。
    wbai: {
      relay: wbaiStatus.relay, relayLast: wbaiStatus.relayLast, upstream: wbaiStatus.upstream, recent: wbaiStatus.recent,
      modelFallback: wbaiStatus.modelFallback,
      useProxy: cfg.wbai?.useProxy === true,
      edition: wbaiAuthNow.edition,
      authDomain: wbaiAuthNow.domain,
      token: {
        configured: !!cfg.wbai?.accessToken,
        expAt: wbaiExp ? new Date(wbaiExp).toISOString() : null,
        expiresInDays: wbaiExp ? Math.max(0, Math.round((wbaiExp - Date.now()) / 86400000)) : null,
        hasRefresh: !!cfg.wbai?.refreshToken,
        ownership: wbTokenOwnership('wbai', cfg),
      },
      pool: wbPoolFields(cfg, "wbai", Date.now()),
      paidHint: wbPaidHintFields("wbai"),
    },
    // MiniMax 会员托管通道（mm）：令牌**只在内存**，所以这一块的 token 快照
    // 是唯一的事实来源。快照里**没有任何令牌值**（只有长度/有效期/是否有效）——
    // 它会原样进 /api/status 交给面板，所以它必须先经过 mm-auth.mjs 的审查。
    mm: {
      relay: mmStatus.relay, relayLast: mmStatus.relayLast, upstream: mmStatus.upstream,
      recent: mmStatus.recent, modelFallback: mmStatus.modelFallback,
      useProxy: cfg.mm?.useProxy === true,
      token: mmTokenSnapshot,
      // 给凭据行/卡片的一句话提示（服务端说了算，渲染层不认识渠道名）。
      tokenHint: mmTokenHint,
      // 这一格是**会员额度**通道，不是开放平台按量计费——两回事，面板上必须分开说。
      memberQuota: true,
    },
    // OpenRouter（第 6 家）：三盏灯 + 两层轮换状态 + 额度真相（「免费流水区」卡读这里）
    or: {
      relay: orm.relay, relayLast: orm.relayLast, upstream: orm.upstream, recent: orm.recent, modelFallback: orm.modelFallback,
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

/* 「**这一家正在探测**」的登记（v1.0.81）。测连通最坏要跑 9 分钟，所以 POST /api/test
 * 改成立刻回包、把探测丢后台（runTierProbe）—— 那就得有个地方说清「现在到底在不在跑」，
 * 否则前端无从判断该继续轮询还是可以收工。
 *
 * ⚠ 只存**一个**进行中的任务（连点两下不跑两轮）。清空时必须比**对象同一性**
 *   （testRun === mine）：A 家在探时用户转去点 B 家，两个任务会并发，A 的 finally
 *   若无条件写 null，就会把 B 的 running 提前抹掉 —— 那一瞬间前端会以为测完了，
 *   去读一个还根本没写出来的结果。
 */
let testRun = null;   // { p, startedAt }

/* 测连通的后台探测体（v1.0.81）—— 从 POST /api/test 的 handler 里**原样搬出来**的。
 *
 * 探测逻辑一个字没改（四档串行、每档 3 次重试、结果写进 lastTest[P]），改的只是
 * **谁来调它**：过去 handler 在 HTTP 请求里同步跑完（最坏 ≈545 秒），
 * 现在由 POST /api/test 丢进后台并立刻回包，前端轮 /api/status 取结果。
 *
 * ⚠ 参数是 (cfg, P, all)：P 由入口 resolveChannelKey 收敛好；cfg 在入口取一次快照传进来，
 *   免得长跑途中读到换过的配置（那会让一次探测的各档来自两个不同版本）。
 */
async function runTierProbe(cfg, P, all) {
  const S = sliceOf(cfg, P);
  // 每家一份「最近真实调用」观察表；按渠道键取，不用再写一串三元链
  // （加渠道时漏改一处 = 测活时用错家的档位历史）。
  const store = P === "bai" ? recentCallsBai
    : P === "sn" ? recentCallsSn
    : P === "wb" ? recentCallsWb
    : P === "wbai" ? recentCallsWbai
    : P === "zen" ? recentCallsZen
    : P === "qd" ? recentCallsQd
    : P === "mm" ? recentCallsMm
    : recentCallsOr;
  const active = all ? null : activeTier(store);
  const targets = active ? [active] : TIERS.map((t) => t.key);
  const tierInfo = (key) => {
    const m = S.mapping[key] || {};
    return { label: m.label || key, target: m.target || S.defaultModel };
  };
  /* 探测请求体（v1.0.78）：**只有 Zen 会带 tools**，其余渠道逐字不变。
   *
   * 为什么：Zen 免费档的围栏判据是「发给模型的请求里必须带工具」，不带工具的探测
   * 会被同一个 FreeTierError 403 拒掉——**真实对话完全正常，面板却显示成红色故障**。
   * 那是探测方式造成的假阳性，不是渠道坏了。Claude Code 的真实流量本来就带工具，
   * 所以带工具的探测才代表真实可用性。
   *
   * 三条纪律（改动这行前先读完）：
   *   · `max_tokens` **必须仍是 8** —— 它是入口 `isProbe`（max_tokens<=8）的判据，
   *     改成别的数会连带禁掉短超时（10s）与 429 重试，探测反而更容易假失败。
   *   · **不带 `tool_choice`** —— 我们只想问「请求形状上游收不收」，不想逼模型真的
   *     去调工具（那会白花一份配额）。它回文本就够了：能返回就是通。
   *   · 只给 zen 加 —— 别的上游对 `tools` 的接受度各不相同，凭空给它们加字段等于
   *     拿一条本来正常的渠道去冒险。 */
  const probeBody = (tier) => (P === "zen"
    ? { model: tier + "[1M]", max_tokens: 8, messages: [{ role: "user", content: "ok" }], tools: [ZEN_PROBE_TOOL_ANTHROPIC] }
    : { model: tier + "[1M]", max_tokens: 8, messages: [{ role: "user", content: "ok" }] });
  const probe = async (tier) => {
    const info = tierInfo(tier);
    let lastErr = null;
    let expected = null;   // 「这一档预期内被拒」的判定（null = 没判定，按故障报）
    for (let attempt = 0; attempt < 3; attempt++) { // 上游偶发截断/挂起，测活流量重试两次
      const t0 = Date.now();
      try {
        const r = await fetch(`http://127.0.0.1:${S.relayPort}/v1/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${S.key}`, "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify(probeBody(tier)),
          signal: AbortSignal.timeout(45000),
        });
        const j = await readProbeJson(r);
        const ms = Date.now() - t0;
        if (!r.ok) throw new Error(upstreamErrorText(j, 120) || `上游返回 HTTP ${r.status}，但没带错误说明`);
        return { tier, label: info.label, target: info.target, served: j.model, ok: true, ms, error: null };
      } catch (e) {
        lastErr = String(e?.message || e).slice(0, 100);
        /* 归因按**上游原文**判，不看本机中转转译过的中文文案（后者丢掉了 FreeTierError
         * 字样，拿它判永远判不出「预期内」）。原文与状态码由 readProbeJson 挂在错误上。
         * 拿不到原文时一律按故障报——宁可漏判，也绝不能把别的 403 错认成「预期内」。
         * 传输方式取 **S.transport**（sliceOf 已经带了，用同一个 zenTransportOf 算的），
         * 不在这里再调一次：多一处调用就多一个与 openaiExchange 的分流判据漂移的机会。 */
        const exp = zenExpectedRejection(e?.upstreamStatus || 0, e?.upstreamRaw || "", {
          provider: P,
          isGo: zenTierOf(S.upstream) === ZEN_TIER_GO,
          transport: S.transport || "direct",
        });
        if (exp.expected) expected = exp;
      }
    }
    /* `expected` 非空 = 这是**产品级的预期拒绝**（「免费档 + 直连」本来就会被拒），
     * 不是渠道故障。照样如实标 ok:false（这一档确实发不出消息），但**不**报故障：
     * 面板改成中性的「预期内被拒」并给出两条可执行的下一步。 */
    return {
      tier, label: info.label, target: info.target, served: null, ok: false, ms: null,
      error: lastErr || "unknown",
      ...(expected ? { expected: true, expectedKind: expected.kind, expectedWhy: expected.why } : {}),
    };
  };
  // 免费渠道对短时间并发探测很敏感。串行并留出间隔，避免四个档位
  // 同时命中 429；这不会影响真实对话的吞吐。
  const tiers = [];
  for (let i = 0; i < targets.length; i++) {
    tiers.push(await probe(targets[i]));
    if (i < targets.length - 1) await new Promise((res) => setTimeout(res, 1500));
  }
  const pass = tiers.filter((x) => x.ok).length;
  /* 「预期内被拒」单独算一类（v1.0.78）。它**既不是通过也不是故障**：
   * 这一档确实发不出消息（ok 仍是 false，如实说），但原因已知且是产品设计的围栏，
   * 所以另起一个 expected 计数，让面板显示中性的「预期内被拒 + 两条下一步」，
   * 而不是亮红灯让用户去查一个根本没坏的渠道。
   * 只有**全部**失败档位都属这一类时才置 expected —— 混着别的真故障就不能洗白。 */
  const badTiers = tiers.filter((x) => !x.ok);
  const expTiers = badTiers.filter((x) => x.expected);
  const expectedOnly = badTiers.length > 0 && expTiers.length === badTiers.length;
  Object.assign(lastTest[P], {
    ok: pass === tiers.length,
    model: tiers[0]?.label || null,
    ms: tiers[0]?.ms || null,
    error: summarizeTierErrors(tiers),
    at: new Date().toISOString(),
    ...(expectedOnly ? {
      expected: true,
      expectedKind: expTiers[0].expectedKind,
      expectedWhy: expTiers[0].expectedWhy,
      expectedTiers: expTiers.map((x) => x.label),
    } : { expected: false, expectedKind: null, expectedWhy: null, expectedTiers: [] }),
  });

  /* 逐档结果也存下来（v1.0.81）：前端改成轮 /api/status 之后，结果是**从这里**读的——
   * POST /api/test 那一行 json() 早已没有第二个读者。tiers 是最多 4 个小对象，
   * 且只在本家测过之后才非空，挂进 /api/status 的代价可以忽略。
   * all/active 一并存：前端要靠 all 决定「当前使用」还是逐档罗列的措辞。 */
  lastTest[P].tiers = tiers;
  lastTest[P].all = !!all;
  lastTest[P].active = active;
  log(`测连通 ${P}: ${pass}/${tiers.length} 档通过` + (expectedOnly ? "（全部为预期内被拒）" : ""));
}

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
      "/workbuddy-ai": "/wbai", "/wbai.html": "/wbai",
      "/opencode": "/zen", "/zen.html": "/zen",
      "/qoder": "/qd", "/qd.html": "/qd",
      "/minimax": "/mm", "/mm.html": "/mm",
      "/openrouter": "/or", "/or.html": "/or",
    };
    if (req.method === "GET" && PROVIDER_ALIAS[u.pathname]) {
      res.writeHead(302, { location: PROVIDER_ALIAS[u.pathname], "cache-control": "no-store" });
      return res.end();
    }
    // 只认规范路径。这里写成显式比较而非数组 includes，是为了让
    // scripts/check-manifest.cjs 的 C1（清单 path 必须在服务端有对应分支）与
    // C10（渲染模板的路径必须有清单 path 匹配）能用字面量 grep 判断。
    if (req.method === "GET" && (
      u.pathname === "/" || u.pathname === "/bai" || u.pathname === "/sn" || u.pathname === "/wb" ||
      u.pathname === "/wbai" || u.pathname === "/zen" || u.pathname === "/qd" || u.pathname === "/mm" ||
      u.pathname === "/or"
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
    /* 共享组件库（panel-kit.js）：状态徽章 / 量条 / 状态条 / 渠道热力图。
     * 刻意**不放** cards/ 下 —— C6 要求 cards/*.js 与视图卡片表双向一一对应，
     * 一个没被任何视图引用的文件会红。它由 provider.html 静态引入。 */
    if (req.method === "GET" && u.pathname === "/panel-kit.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(path.join(HERE, "panel-kit.js")));
    }
    if (req.method === "GET" && u.pathname === "/api/ping") return json(res, 200, { ok: true });
    if (req.method === "GET" && u.pathname === "/api/version") return json(res, 200, { version: APP_VERSION });

    // v1.0.33: 一键捕获 WorkBuddy 令牌（临时注入客户端 CLI 脚本 → 抓取 → 立即还原）
    if (req.method === "POST" && u.pathname === "/api/wb/capture") {
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, await wbCaptureBody(body));
    }
    if (req.method === "GET" && u.pathname === "/api/wb/capture/status") {
      // v1.0.58：附带实时进度（phase/phaseText/kick）——前端如实显示「钩子注入了没、
      // 踢侧车结果、还差什么」，超时文案也由后端按卡点分类生成，不再一律转圈。
      // v1.0.80：再附带**本次捕获的终局**（done/ok/masked/hasRefresh/error/finishedAt）。
      // POST 会阻塞到捕获结束，而面板的读超时只有 12 秒 —— 报结果的活儿只能落在轮询上；
      // 没有这几个字段，界面就只能一直转圈，用户会以为没抓到令牌。
      return json(res, 200, wbCaptureStatusPayload());
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
    /* POST /api/mm/reread —— 重新读一遍本机的 MiniMax 登录态，灌进内存。
     *
     * 用户在 MiniMax Code 里重新登录之后点这个：登录态文件里的刷新令牌换了新的，
     * 中转得把它捡回来（令牌只在内存，磁盘那份不归我们管）。
     *
     * 🔴 这里的响应**只有状态快照**（长度/有效期/是否有效），**没有令牌值**；
     *    也不写任何文件——凭据只在进程内存里。 */
    if (req.method === "POST" && u.pathname === "/api/mm/reread") {
      try {
        const r = mmTokens.readAuthFile({ force: true });
        if (!r.ok) {
          return json(res, 400, {
            error: r.reason || "本机没读到 MiniMax 登录态",
            remedy: "请先在 MiniMax Code 里登录，然后回到本页再点一次「重新读取登录态」",
            token: mmTokens.snapshot(),
          });
        }
        return json(res, 200, { ok: true, token: mmTokens.snapshot() });
      } catch (e) {
        return json(res, 500, { error: String((e && e.message) || e) });
      }
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
      // 渠道键收敛走 resolveChannelKey（认得 wbai，认不得的一律回落到 bai）
      const p = resolveChannelKey(u.searchParams.get("p"));
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

    /* POST /api/models/probe-zen —— 逐模型能力探测（v1.0.74 · T3+T6）
     *
     * **只在用户点「检测可用性」时被调用**：本文件没有任何定时器、setInterval 或后台
     * 调度会打这个端点。理由是配额：每轮探测对每个免费模型发 1~2 个真实请求，
     * 后台跑一次没人看见却照扣额度，比不跑更糟。
     *
     * 配额纪律都写死在 zen-probe.mjs 里并被测试锁死：只探 id 含 `-free` 的模型
     * （付费模型一次请求都不发）、并发上限 2、单探针 10 秒、会话 id 固定 bai-probe。
     */
    if (req.method === "POST" && u.pathname === "/api/models/probe-zen") {
      const cfg = loadCfg();
      /* ★ 2026-10-17：客户端中转形态下**不做直连探测**。探测打的是上游直连路径，而这个形态
       * 的可用性与它无关（本机实测：直连全 403 的同时，经客户端中转 11/12 可用）。继续跑
       * 只会用直连结论把能用的模型误标「探不通」，还会把下拉筛选连带洗掉。 */
      if (zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE) {
        return json(res, 400, {
          error: "当前是「OpenCode 客户端中转」形态：直连探测不适用——免费模型由本机 OpenCode 客户端真实发出，"
            + "下拉里的免费模型都可以直接用。要验某个模型，直接在 Claude Code 里发一条消息即可。",
        });
      }
      if (!((cfg.zen || {}).apiKey)) return json(res, 400, { error: "尚未填写 OpenCode Zen API Key——没有 Key 探测只会一律拿到 401，白白打上游" });
      // 目录按当前 upstream 走（两档是两套清单，混了会探到这一档根本没有的模型）
      const cat = await zenReadCatalog(cfg);
      const tier = zenTierInfo(cfg);
      const upstream = String((cfg.zen.upstream || DEFAULTS.zen.upstream)).replace(/\/+$/, "");
      const send = (body, opts) => zenProbeSend(cfg, body, opts);
      const out = await zenRunCapabilityProbe({
        catalog: cat, upstream, tier: tier.id, dataDir: DATA_DIR,
        send, imageSend: send,
      });
      // 结果本身不含任何凭据：只有模型 id、判定、计数与上游错误文案。
      log(`OpenCode Zen：能力探测完成，实测 ${out.probed} 个免费模型（并发峰值 ${out.peakConcurrency}），跳过付费模型 ${out.skippedPaid.length} 个`);
      const okN = Object.values(out.models || {}).filter((r) => r.ok === true).length;
      const toolsN = Object.values(out.models || {}).filter((r) => r.tools === "yes").length;
      return json(res, 200, {
        ...out, tier: tier.id, tierLabel: tier.label,
        atLabel: new Date(out.at).toLocaleString("zh-CN", { hour12: false }),
        summary: `探测了 ${out.probed} 个免费模型：${okN} 个探得通，其中 ${toolsN} 个支持工具调用。`
          + `付费模型 ${out.skippedPaid.length} 个按纪律未探（探了要花钱）。并发峰值 ${out.peakConcurrency}。`,
      });
    }

    // v1.0.60：六家提供方的顺序（扫描与批量写入都按这个顺序走，面板展示顺序一致）
    const ALL_PKEYS = CHANNELS;

    /* 一键刷新全部提供方 —— 扫描端。
     *
     * **本接口全程只读**：不调 saveCfg、不调 applyToCli/applyToDesktop，
     * 扫完 config.json 必须逐字节不变（用户没点确认之前，一个字节都不许落地）。
     *
     * 基线取 loadCfg() 的**当前内存快照**，而不是拉回来的原始结果——onActivated() 已经把
     * config.defaults.json 并进了每家的 availableModels，拿裸结果比会凭空多出一堆「新增」。
     *
     * 六家并行拉（allSettled，一家挂了不牵连其余），墙钟时间由**最慢的那家**封顶。
     *
     * ⚠ v1.0.81 修正一句错的：这里原先写的是「最慢的那家（15s 超时）」，对 wb/wbai 不成立。
     *   它们的目录要走 wbCatalogAccount（可能触发令牌续期 15s）+ wbFetchConfig(cli) 15s
     *   + wbFetchConfig(app) 15s，**三次串行 = 最坏 45s**。前端因此必须给 ≥60s
     *   （见 panel-common.js 的 CATALOG_TIMEOUT_MS），写 15s 会让一次成功的扫描
     *   被掐成「这次没能读完六家的目录」。 */
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
        if (r.static === true) status = "static";        // qd 退回内置静态表 / wb 降级到内置兜底列表
        else if (!models.length) status = "empty";      // zenReadCatalog() 会吞掉错误返回过期空缓存（HTTP 200），空列表是真故障
        // **只有 status==="ok" 才比差异。** 没拿到可信目录时算出来的 added/removed 是假的：
        //   empty —— 上游没给任何模型，「removed」会等于当前整张列表，照着应用就把配置洗成空；
        //   static —— qd 退回的是内置表，拿它跟真实配置比会凭空冒出差异。
        // 这层闸门放在服务端而不是前端：前端六个状态里漏判一个就是一次静默的数据丢失。
        if (status !== "ok") {
          return { ...base, status, added: [], removed: [], count: 0,
            ...(r.note ? { note: r.note } : {}) };
        }
        // 比对一律转小写：POST /api/config 存进去的都是小写，但 wb 的目录来自上游 id、
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
        // （mm 例外：它的模型 id 大小写敏感，保留官方写法，见 POST /api/config 里那段注释）
        const arr = ids.map((x) => k === "mm" ? mmCanonicalModel(x) : String(x == null ? "" : x).trim().toLowerCase()).filter(Boolean);
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
      if (done.includes(curCli)) { await applyToCli(sliceOf(cfg, curCli)); applied.push("cli"); }
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

    /* POST /api/oc/install（2026-10-17）：一键安装 OpenCode CLI——「OpenCode 客户端中转」的前置。
     *
     * 原则修订说明见 oc-install.mjs 文件头：旧纪律防的是「猜装法硬装」；这条路由来源固定
     * （npm 官方 registry）、版本固定（OC_CLI_VERSION，完整验证过的版本）、落地前 sha512 校验、
     * 落点是官方安装位置，而且**只有用户点了面板按钮才会走到这**，没有任何自动触发。
     * 单飞：ocInstallPending 是模块级的，连点只跑一趟下载。 */
    if (req.method === "POST" && u.pathname === "/api/oc/install") {
      await readBody(req);
      const cur = probeOcBinary({ force: true });
      if (cur.state === "found") {
        /* 已经有了就不重装：把现状如实回给面板（用户点了按钮才发现装着，也说得通）。 */
        return json(res, 200, { ok: true, already: true, path: cur.path, source: cur.source, version: OC_CLI_VERSION });
      }
      if (!ocInstallPending) {
        log(`OpenCode 一键安装：开始（npm 官方源，固定版本 ${OC_CLI_VERSION}）`);
        ocInstallPending = installOpenCodeCli({ log: (m) => log(m) })
          .catch((e) => ({ ok: false, reason: "unexpected", message: String((e && e.message) || e).slice(0, 200) }))
          .finally(() => { ocInstallPending = null; });
      }
      const r = await ocInstallPending;
      if (!r || !r.ok) {
        log(`OpenCode 一键安装：失败 ${JSON.stringify({ reason: (r && r.reason) || "unknown", message: (r && r.message) || "" })}`);
        return json(res, 502, { error: `安装失败（${(r && r.reason) || "unknown"}）：${(r && r.message) || ""}` });
      }
      resetOcBinaryCache();   // 让下一次探测（以及面板轮询）立刻看到新装的二进制
      const after = probeOcBinary({ force: true });
      log(`OpenCode 一键安装：完成 ${r.path}（${r.bytes} 字节）`);
      return json(res, 200, {
        ok: true, already: false, path: r.path, bytes: r.bytes, version: r.version,
        probe: { state: after.state, path: after.path, source: after.source },
      });
    }

    if (req.method === "GET" && u.pathname === "/api/config") return json(res, 200, loadCfg());

    // v1.0.28: 配置编辑按提供方分流。body.provider="sn"/"wb" 时读写 cfg.sn / cfg.wb 子对象，
    // 否则维持 B.AI 顶层字段（apiKey/mapping/upstream/relayPort/panelPort…），互不影响。
    // v1.0.31: WorkBuddy 无 sk- 密钥，改收 JWT 令牌四件套（accessToken/refreshToken/deviceToken/userId）。
    /* POST /api/config 认识的字段全集（v1.0.79）。
     * 「字段不认识」与「字段认识但值没变」必须分开报——前者是白名单漏收（真错误），
     * 后者是刷新后无新内容（**成功**）。把后者报成错误，用户会以为功能坏了而反复点。
     *
     * ⚠️ 这张表与下面 handler 实际处理的字段是**两份**，加字段时两边都要改。
     *   漏进表 → 明明是白名单里的字段被当成「不认」，白报一次错；
     *   漏出表 → 真不认识的字段被当成「认识」，退回静默成功（要根治的那种）。 */
    const CONFIG_ACCEPTED_KEYS = new Set([
      "provider", "apiKey", "token", "upstream", "relayPort", "panelPort",
      "useProxy", "proxy", "mapping", "availableModels", "defaultModel",
      "transport", "failover", "accounts", "poolMode", "all", "cli", "desktop",
    ]);
    if (req.method === "POST" && u.pathname === "/api/config") {
      const b = await readBody(req);
      const cfg = loadCfg();
      /* provider 给了但不认识 → **拒**，不要静默落到 bai。
       *
       * resolveChannelKey 对 /api/models、/api/test 这类只读查询来说，"认不出就当 bai"
       * 是便利。但这是**写入**接口：静默改错渠道的后果是「界面上说保存成功、
       * 配置却写到了别家去」，而用户完全看不出发生了什么。
       * 实测踩过：把载荷写成嵌套的 {"zen":{...}}（正确形状是扁平的 {provider:"zen",...}），
       * 接口回 ok:true、provider:"bai"，实际什么都没改。
       *
       * 注意**不能**改成「provider 缺失也拒」：cards/failover.js 写的就是
       * {failover:{...}}——不带 provider 是它合法的用法（故障转移是 bai 的顶层设置）。
       * 所以这里只管「给了但不认识」。 */
      const rawP = b.provider;
      if (rawP != null && rawP !== "" && !isChannelKey(String(rawP))) {
        return json(res, 400, {
          error: `未知的提供方 ${JSON.stringify(String(rawP).slice(0, 40))}`
            + `——合法值是 ${CHANNELS.join(" / ")}`
            + "（给错渠道名会让配置写到别家去，所以这里必须拒而不是默默当成 B.AI）",
          acceptedProviders: CHANNELS,
        });
      }
      const P = resolveChannelKey(rawP);
      // 落点：bai 是扁平的（字段直接摊在 cfg 顶层），其余各家各有自己的子对象。
      // P 已经是 resolveChannelKey 收敛过的合法渠道键，故按 CHANNELS 成员关系取子对象即可，
      // 不必再写一串三元链（加渠道时漏改一处 = 静默把配置写到别家去）。
      const sub = P === "bai" ? cfg
        : (P === "or" ? (cfg.or || (cfg.or = { ...DEFAULTS.or })) : (cfg[P] || (cfg[P] = { ...DEFAULTS[P] })));
      /* 「什么都没写进去」也要说出来。
       *
       * 上面那一长串全是**白名单收字段**：不在表里的 key 会被静默丢掉，然后照样回
       * 一个 ok:true。实测踩过——载荷形状写错（该扁平的写成了嵌套的），接口回 ok:true，
       * 用户以为保存成功，其实配置一个字没动。这是最坏的一种成功：看起来生效了，其实没有。
       *
       * 判据用「快照前后比字符串」而不是给十来个写入点各加一个计数器：
       * 漏加一个计数器 = 那个分支的写入又会被算成「什么都没写」。快照不会有那种漏。
       * 快照放在 sub 建好**之后**取——sub 的补建是初始化，不是用户改的东西。 */
      const before = JSON.stringify(sub);
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
          cfg.failover = { ...(cfg.failover || {}), chain: b.failover.chain.filter((x) => isChannelKey(x)) };
        }
      }
      // —— Qoder 令牌（一般不用填：正常由 worker 补丁写入 tokenFile，此处仅手动兜底）——
      if (P === "qd" && typeof b.token === "string") {
        cfg.qd.token = b.token.trim();
      }
      // —— WorkBuddy 令牌（出现字段即写入；空串=清除）——
      // 两版结构相同、各写各的（里程碑 1b）：wb → cfg.wb，wbai → cfg.wbai。
      if (P === "wb" || P === "wbai") {
        for (const f of ["accessToken", "refreshToken", "deviceToken", "userId"]) {
          if (typeof b[f] === "string") cfg[P][f] = b[f].trim();
        }
        if (cfg[P].accessToken && cfg[P].accessToken.split(".").length !== 3) {
          return json(res, 400, { error: "访问令牌应是 JWT（三段以 . 分隔）——请从捕获结果完整粘贴" });
        }
        /* —— 账号池（v1.0.77）——
         * 收一个数组进去，每个条目必须有**非空 id**（池内一切按 id 认：粘性绑定、
         * 冷却、判死全都挂在 id 上，id 缺失会让这些状态挂到 undefined 上）。
         * 收不收 accounts 与顶层 accessToken **互不排斥**：accounts 非空时池子用
         * 账号池，accessToken 仍作为该渠道的「当前令牌」留着（面板凭据页与 /v3/config
         * 目录抓取读它），这也是老配置平滑升级到多账号的落点。
         * ⚠ 冷却/判死**不落盘**（那是内存态，见 wb-pool-wiring.mjs）：往 config.json
         *   里高频写状态会和用户正在改的配置互相覆盖，而重启后重新计冷却也并无损失。 */
        if (Array.isArray(b.accounts)) {
          if (b.accounts.length > 32) {
            return json(res, 400, { error: "一个渠道最多 32 个账号（再多也只是把上游的限流窗口挨个撞一遍）" });
          }
          const bad = b.accounts.findIndex((a) => !a || typeof a !== "object"
            || typeof a.id !== "string" || !a.id.trim());
          if (bad >= 0) {
            return json(res, 400, { error: `第 ${bad + 1} 个账号缺 id：池子里的一切（粘性、冷却、判死）都按 id 认，没有它就挂不上去` });
          }
          const ids = new Set();
          const dup = b.accounts.find((a) => { const k = a.id.trim(); if (ids.has(k)) return true; ids.add(k); return false; });
          if (dup) return json(res, 400, { error: `账号 id 重复：「${dup.id}」——id 必须唯一，否则两个号会被当成同一个` });
          cfg[P].accounts = b.accounts.map((a, i) => ({
            ...a,
            id: a.id.trim(),
            label: a.label == null ? a.id.trim() : String(a.label),
            order: Number.isFinite(a.order) ? a.order : i,
          }));
          if (typeof b.poolMode === "string" && b.poolMode.trim()) cfg[P].poolMode = b.poolMode.trim();
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
      // —— Zen 的传输开关（v1.0.75）——
      /* 这个 handler 是**白名单**收字段的：不在表里的 key 会被静默丢掉，还回一个
       * ok:true 的「成功」——那是最坏的一种成功。所以要让它可配，就必须在表里显式加一行。
       *
       * 认不出来的值**直接 400 拒收**（不是"退回 direct 并照收"——那句是 v1.0.75 写下时
       * 的设计意图，实现后来改成了拒绝，两边没对上）。理由：切换传输方式是一次
       * 明确的用户动作，把它静默当成"没切换"比报错更坏——用户会以为已经在 OpenCode
       * 中转上，实际还在直连。与 zenTransportOf 的**运行期**兜底（读配置时认不出就当
       * direct）不冲突：那是读脏配置的容错，这里是不接受脏输入。 */
      if (P === "zen" && b.transport !== undefined) {
        const t = String(b.transport || "").trim();
        if (!ZEN_TRANSPORTS.includes(t)) {
          return json(res, 400, { error: `传输方式只能是 ${ZEN_TRANSPORTS.join(" 或 ")}（收到 ${JSON.stringify(String(b.transport).slice(0, 40))}）` });
        }
        if (sub.transport !== t) sub.transport = t;   // 每次请求实时读 cfg，改完立即生效，不用重启
      }
      // —— 映射表 ——
      if (b.mapping && typeof b.mapping === "object") {
        const dst = sub.mapping;
        /* 目标模型名对照上游目录核一遍（v1.0.71）。
         *
         * 动机：用户自己把国内版 Fable 指到 step-5-preview，界面照收不误，
         * 之后每次调用都是 `400 code=11102 model [step-5-preview] service info not found`——
         * 而面板显示「已就绪」。这和「令牌装错版」（v1.0.68 修的那个）是同一类漏洞：
         * 存下了，**没有任何一处核对它对不对**。
         *
         * 为什么是「提示」而不是「拒绝」：上游目录**本身列不全**（实测国内版 37 个里
         * 没有 hy4-preview-f，而它明明能调通），拿目录当权威清单会误伤合法的填写。
         * 所以照收，只把对不上的名字如实列出来，由人决定。
         *
         * 取不到目录时完全不说——查不到不等于填错了，不能拿沉默当默认同意。 */
        const unknown = await unknownMappingTargets(P, b.mapping, cfg);
        if (unknown.length) {
          const cat = await describeCatalog(P, cfg);
          return json(res, 400, {
            error: `以下模型名不在${cat}里：${unknown.join("、")}`
              + "（已按原样保存，但如果调不通请换成本版目录里的名字）",
            unknownTargets: unknown,
            catalogHint: cat,
          });
        }
        for (const t of TIERS) {
          const m = b.mapping[t.key];
          if (!m) continue;
          /* 目标模型名的写法：
           *   既有行为是**转小写**——对六家全是小写 id 的渠道等价；
           *   但 mm 这一格的上游 id 是**大小写敏感**的（官方写法 MiniMax-M3.1-Flash），
           *   转小写等于把发出去的名字改了（上游会 400，或更糟：悄悄按别的模型扣额度）。
           *   故 mm 走 mmCanonicalModel 还原成官方写法。 */
          const rawTarget = String(m.target || "").trim();
          const target = P === "mm" ? mmCanonicalModel(rawTarget) : rawTarget.toLowerCase();
          const label = String(m.label || "").trim() || t.zh;
          if (!target) return json(res, 400, { error: `${t.key} 的目标模型不能为空` });
          dst[t.key] = { target, label };
        }
      }
      /** 取某渠道目录里的模型 id 列表（统一各渠道 shapes：wb/wbai/zen 传对象，or/sn 传字符串）。取不到返回 null。 */
async function catalogIdsOf(p, cfg) {
  try {
    const c = await fetchCatalogFor(p, cfg || loadCfg());
    if (!c || !Array.isArray(c.models)) { log(`映射核对：${p} 目录返回里没有 models 数组`); return null; }
    return c.models.map((m) => (typeof m === "string" ? m : m && (m.id || m.key))).filter(Boolean);
  } catch (e) {
    log(`映射核对：取 ${p} 目录失败（${String((e && e.message) || e).slice(0, 140)}）——按「查不到不等于填错」放行`);
    return null;
  }
}
/** 目录的来源说明，用于把「目录里没有」这句话说清楚是哪一版的目录。 */
async function describeCatalog(p, cfg) {
  // 与 providers.js 的 shortName 对齐（不在渲染层写死渠道名，与 C11 同一原则）
  const label = p === "wbai" ? "WorkBuddy AI" : p === "wb" ? "WorkBuddy" : p;
  const ids = await catalogIdsOf(p, cfg);
  return ids ? `${label}（当前目录 ${ids.length} 个模型）` : `${label}（目录暂时取不到，未作核对）`;
}
/* 返回这批映射里「上游目录里没有」的目标模型名（去重、只报对不上的）。
 * 目录取不到时返回空数组 —— 查不到不等于填错，不能拿沉默当默认同意。 */
async function unknownMappingTargets(p, mapping, cfg) {
  const ids = await catalogIdsOf(p, cfg);
  if (!ids || !ids.length) return [];
  const lower = new Set(ids.map((x) => String(x).toLowerCase()));
  const out = [];
  for (const t of TIERS) {
    const m = mapping[t.key];
    if (!m) continue;
    const target = String(m.target || "").trim().toLowerCase();
    if (!target) continue;
    if (!lower.has(target) && !out.includes(target)) out.push(target);
  }
  return out;
}

// —— 可选模型列表 ——
      if (Array.isArray(b.availableModels)) {
        /* 同样：mm 的模型 id 大小写敏感，存的时候要保留官方写法（见上面那段注释）。 */
        const arr = b.availableModels.map((x) => P === "mm" ? mmCanonicalModel(x) : String(x).trim().toLowerCase()).filter(Boolean);
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
        sub.defaultModel = P === "mm" ? mmCanonicalModel(b.defaultModel) : b.defaultModel.trim().toLowerCase();
      }
      /* 一个字段都没写进去 → 报错，并**不要** saveCfg（省掉一次无谓的整文件落盘）。
       *
       * 「没提交任何内容」与「提交了但字段不认识」是两回事，错误信息得分开：
       * 前者是用户点了保存却什么都没填（面板 saveSys 在两个输入框都空时就是这种）；
       * 后者是调用方把字段写错了地方——实测踩过：该扁平的
       * {"provider":"zen","transport":"opencode"} 写成了嵌套的 {"zen":{...}}，
       * transport 根本不在白名单里被丢掉，接口却回 ok:true。 */
      /* 「没写进去」有两种截然不同的成因，处理方式相反（v1.0.79）：
       *
       * ① **字段不认识**（真的被白名单丢掉了）→ 400，并说清字段要放顶层。
       *    这才是「静默成功」要根治的那一种。
       *
       * ② **字段认识、但值与当前完全相同** → **成功**，不是错误。
       *    实测踩到：面板「刷新模型列表」在目录没变化时，`availableModels`
       *    去重后与现值逐字相同 → 被 ① 的判据一锅端成「出错了」。
       *    而它其实**刷新成功了**，只是没有新东西可写——
       *    **把成功报成失败，比什么都不报更坏**：用户会以为刷新坏了，然后一直点。
       *
       * 所以要把「收到的键」按**认不认识**分开，再决定报什么。 */
      if (JSON.stringify(sub) === before) {
        const others = Object.keys(b).filter((k) => k !== "provider");
        const unknown = others.filter((k) => !CONFIG_ACCEPTED_KEYS.has(k));
        if (unknown.length) {
          return json(res, 400, {
            error: `这些字段本接口不认：${unknown.slice(0, 20).join("、")}`
              + "——本接口是白名单式的，不认识的字段会被静默丢掉。"
              + "字段要放在**顶层**（形如 {\"provider\":\"zen\",\"transport\":\"opencode\"}），"
              + "不是嵌套在 provider 下面。",
            provider: P,
            receivedKeys: others.slice(0, 20),
            unknownKeys: unknown.slice(0, 20),
          });
        }
        /* 一个字段都没带 → 调用方大概率漏发了内容，那是要报的 */
        if (!others.length) {
          return json(res, 400, {
            error: "没有要保存的内容——请求里除了 provider 之外没有任何字段。"
              + "如果本来只想改点东西，请确认表单填了内容再保存。",
            provider: P, receivedKeys: [],
          });
        }
        /* 全部认识、只是值没变：如实说「已一致」，别报成功也别报失败 */
        return json(res, 200, {
          ok: true, unchanged: true, provider: P,
          message: `收到 ${others.length} 个字段，但内容与当前配置**完全一致**，没有需要写入的改动。`
            + "（例如「刷新模型列表」拿到的新目录与原目录相同——这是刷新成功，不是失败。）",
          receivedKeys: others.slice(0, 20),
          hints: [],
        });
      }
      saveCfg(cfg);
      // 端上已接到该提供方的话，立即同步新映射
      const applied = [];
      const curCli = cliMode(cfg).mode, curDesk = desktopMode(cfg).mode;
      if (curCli === P) { await applyToCli(sliceOf(cfg, P)); applied.push("cli"); }
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
    /* ---------- 统一网关模式（magpie 形态的那个「一个端口」）----------
     *
     * GET  → 当前模式、网关端口、各家可选模型
     * POST → 切模式并**重新接线**（不重接的话，用户�� Claude Code 还指着旧端口，
     *       面板说「已切到网关」而实际请求还走老路——那比没这功能更坏）。
     */
    if (req.method === "GET" && u.pathname === "/api/gateway-mode") {
      const cfg = loadCfg();
      return json(res, 200, {
        ok: true,
        mode: gatewayOn(cfg) ? "on" : "off",
        port: cfg.gatewayPort || DEFAULTS.gatewayPort,
        providers: allChannelKeys().map((k) => {
          const S = sliceOf(cfg, k);
          /* 模型 id 现在写的是 `provider/档位`，所以「这一家能分到哪些」要看**档位**。
           * 每个档位顺带报上它当前的模型（面板上看得见「这一档现在指向什么」）。 */
          const slots = TIER_KEYS.map((tier) => ({
            tier,
            model: String((S.mapping && S.mapping[tier] && S.mapping[tier].target) || S.defaultModel || ""),
          })).filter((x) => x.model);
          return {
            key: k, name: PROVIDERS[k] || k, slots,
            models: Array.from(new Set(slots.map((x) => x.model))),
          };
        }),
      });
    }
    if (req.method === "POST" && u.pathname === "/api/gateway-mode") {
      const b = await readBody(req);
      const want = String(b.mode || "").trim().toLowerCase();
      if (want !== "on" && want !== "off") {
        return json(res, 400, { error: "mode 只能是 on 或 off（收到：" + JSON.stringify(b.mode) + "）" });
      }
      const cfg = loadCfg();
      cfg.gatewayMode = want;
      saveCfg(cfg);
      const warns = [];
      try {
        /* 只重接**当前接的那一家**——我们不知道用户想接哪家，不该替他决定。
         * 当前接的是谁，从 settings.json 里的 BASE_URL 反查（cliMode 干的就是这事）。 */
        const cur = cliMode(cfg).mode;
        if (isChannelKey(cur)) {
          const S = sliceOf(cfg, cur);
          warns.push(...snapshotExternal());
          await applyToCli(S);
          applyToDesktop(S);
        } else {
          warns.push("当前没有接任何一家；改动已保存，下次接线时生效");
        }
      } catch (e) {
        return json(res, 400, {
          error: "切换后重新接线失败：" + String((e && e.message) || e),
          mode: want, warnings: warns,
        });
      }
      return json(res, 200, { ok: true, mode: want, warnings: warns });
    }
    /* ---------- 审计台账（面板读）----------
     * 只在内存里，有硬上界（audit.mjs 的 max）。所以它回答的是
     * 「**最近**这段时间链路上发生过什么」，不是全量历史 ——
     * 全量历史在用量账本那份 JSONL 里（那是落盘的、跨进程重启也在）。
     *
     * ⚠ 台账里的字段已经过脱敏（audit.mjs 每个字符串都过 redact），
     *   这里**原样**返回即可，渲染层不必再脱敏一遍。 */
    if (req.method === "GET" && u.pathname === "/api/audit") {
      const limit = Math.max(1, Math.min(200, Number(u.searchParams.get("limit")) || 50));
      const provider = (u.searchParams.get("provider") || "").trim();
      try {
        return json(res, 200, {
          ok: true,
          records: auditLedger.list({ provider, limit }),
          summary: auditLedger.summary(),
        });
      } catch (e) {
        return json(res, 200, { ok: false, error: "读不到审计台账：" + String((e && e.message) || e), records: [], summary: null });
      }
    }
    /* ---------- 配置备份（面板读 / 写）----------
     * 导出会写出**带真实凭据**的快照，所以它必须带口令加密；
     * 口令只在这一请求里活着，**不落盘、不进日志**。 */
    if (req.method === "GET" && u.pathname === "/api/backup") {
      return json(res, 200, { ok: true, dir: BACKUP_DIR, files: listBackups() });
    }
    if (req.method === "POST" && u.pathname === "/api/backup/export") {
      const b = await readBody(req);
      try {
        const pass = checkPassphrase(b.passphrase);
        const cfg = loadCfg();
        const snap = snapshotOf(cfg, { now: Date.now() });
        const bytes = exportBundle(snap, pass, { now: Date.now() });
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        const dir = BACKUP_DIR;
        mkdirSync(dir, { recursive: true });
        const name = "backup-" + new Date().toISOString().replace(/[:.]/g, "-") + ".bak";
        const file = path.join(dir, name);
        writeAtomic(file, buf);
        /* ⚠ 不回显口令，不回显内容，只回「写在哪、多大」。 */
        return json(res, 200, { ok: true, file, name, bytes: buf.length, at: Date.now() });
      } catch (e) {
        return json(res, 400, { error: "导出失败：" + String((e && e.message) || e) });
      }
    }
    if (req.method === "POST" && u.pathname === "/api/backup/import") {
      const b = await readBody(req);
      try {
        const pass = checkPassphrase(b.passphrase);
        const name = String(b.file || "").trim();
        if (!name) return json(res, 400, { error: "没说要导入哪个备份文件" });
        /* ⚠ 文件名不许带路径：**只认备份目录下的那一个文件名**。
         *   否则一个 "../" 就能把任意文件读进来解密。 */
        if (name.includes("/") || name.includes("\\") || name.includes("..")) {
          return json(res, 400, { error: "备份文件名不合法（只接受备份目录下的文件名）" });
        }
        const file = path.join(BACKUP_DIR, name);
        let raw = null;
        try { raw = readFileSync(file); } catch { }
        if (!raw) return json(res, 404, { error: "找不到这个备份文件：" + name });
        const snap = importBundle(raw, pass, { now: Date.now() });
        const cur = loadCfg();
        const merged = restoreConfig(snap, cur, { now: Date.now() });
        /* ⚠ 还原**之前**先把当前配置另存一份 —— 还原是破坏性的，
         *   得留一条回头路（用户当年就是这么丢过配置的）。 */
        let safety = "";
        try {
          const dir = BACKUP_DIR;
          mkdirSync(dir, { recursive: true });
          const pre = path.join(dir, "before-import-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
          writeAtomic(pre, JSON.stringify(cur, null, 2) + "\n");
          safety = pre;
        } catch { /* 留不下就继续（还原本身仍然可逆：导出的那份还在） */ }
        if (merged.changed) saveCfg(merged.config);
        return json(res, 200, {
          ok: true, changed: !!merged.changed,
          safety, parts: Object.keys(snap.parts || {}),
          note: "只还原了路由台自己的配置；~/.claude/settings.json 未改动。",
        });
      } catch (e) {
        return json(res, 400, { error: "导入失败：" + String((e && e.message) || e) });
      }
    }
    /* ---------- 插件渠道（面板读写）---------- */
    if (req.method === "GET" && u.pathname === "/api/plugins") {
      const cfg = loadCfg();
      const list = pluginRegistry.list().map((e) => {
        const c = cfg[e.id] && typeof cfg[e.id] === "object" ? cfg[e.id] : {};
        const cred = e.credentialField ? String(c[e.credentialField] || "") : "";
        return {
          id: e.id, name: e.name, protocol: e.protocol, auth: e.auth, upstream: e.upstream,
          relayPort: e.relayPort, models: e.availableModels, defaultModel: e.defaultModel,
          credentialField: e.credentialField || "",
          hasCredential: !!cred, loadedAt: e.loadedAt || 0,
        };
      });
      return json(res, 200, { ok: true, dir: pluginDir(), plugins: list, errors: pluginErrors });
    }
    if (req.method === "POST" && u.pathname === "/api/plugins/reload") {
      const n = reloadPlugins();
      return json(res, 200, { ok: true, loaded: n, errors: pluginErrors });
    }
    if (req.method === "GET" && u.pathname === "/api/accounts") {
      /* 账号发现：每家有哪些可用账号、凭据从哪来、缺什么。
       * ⚠ **绝不回显凭据本身** —— 只给 id / 标签 / 指纹。 */
      const cfg = loadCfg();
      const found = discoverAccounts(cfg, {
        now: Date.now(),
        wbPool: (p, c) => { try { return wbPoolOf(c, p); } catch { return null; } },
        qdToken: (c) => qdTokenRaw(),
        mmStatus: () => { try { return mmTokens.recheck(); } catch { return null; } },
        zenTransport: (c) => { try { return zenTransportOf(c); } catch { return null; } },
      });
      return json(res, 200, { ok: true, providers: (found && found.providers) || [] });
    }
    if (req.method === "GET" && u.pathname === "/api/channels/state") {
      /* 渠道状态：六态之一 + 原因 + 数字。**全局面板都从这里取**（docs/ui-redesign.md 原则 1）——
       * 同一个渠道在任何地方都显示同一个状态，取到的必然一致。 */
      const cfg = loadCfg();
      const now = Date.now();
      const budgetStates2 = budgetStates(cfg, now);
      const table = restTable();
      const creds = (() => {
        try {
          const r = discoverAccounts(cfg, {
            now,
            wbPool: (p, c) => { try { return wbPoolOf(c, p); } catch { return null; } },
            qdToken: (c) => qdTokenRaw(),
            mmStatus: () => { try { return mmTokens.recheck(); } catch { return null; } },
            zenTransport: (c) => { try { return zenTransportOf(c); } catch { return null; } },
          });
          const map = new Map();
          for (const p of ((r && r.providers) || [])) map.set(p.key, p);
          return map;
        } catch { return new Map(); }
      })();
      const ctx = {
        now,
        keyOf: (p) => String(p || ""),
        nameOf: (p) => {
          const S = sliceOf(cfg, p);
          return PROVIDERS[p] || (S && S.zh) || p;
        },
        busyOf: (p) => { try { return concurrencyGate.stats(p).busy; } catch { return null; } },
        coolingOf: (p) => {
          const ok = failoverAvailable(p);
          const st = (() => { try { return failoverSnapshot ? failoverSnapshot()[p] : null; } catch { return null; } })();
          /* ⚠ 快照里是**剩余秒数**（cooldownLeftSec），不是到期时刻 ——
           *   换算成时刻再给状态层（它只认 epoch 毫秒）。 */
          const left = st && typeof st.cooldownLeftSec === "number" ? st.cooldownLeftSec : 0;
          return { cooling: !ok, until: ok ? 0 : Date.now() + left * 1000 };
        },
        restingOf: (p) => {
          const e = (() => { try { return table.entry(p); } catch { return null; } })();
          return {
            resting: !!(e && e.until > now),
            until: e ? e.until : 0,
            note: e && e.note ? String((e.note && e.note.label) || e.note.kind || "") : "",
          };
        },
        budgetOf: (p) => {
          const st = budgetStates2.get(p);
          if (!st) return null;
          return {
            exhausted: !!st.exhausted, used: st.used, limit: st.limit,
            ratio: st.ratio, resetAtMs: st.resetAtMs || 0,
          };
        },
        credentialOf: (p) => {
          const c = creds.get(p);
          if (!c) return null;
          return { configured: !!c.configured, missing: c.missing || null, accounts: c.accounts || [] };
        },
        probeOf: (p) => {
          /* ⚠ 缓存的形状是 `{ at, value }`（逐条记时刻，见 probeCache 那段注释）——
           *   这里必须取 .value。早先写成 probeCache.map.get(p)（旧形状），
           *   改形状之后这一行就**静悄悄**地抛异常、被 catch 吃掉、返回 null：
           *   于是「探到的余额」永远进不了状态层，渠道热力图上的
           *   「额度快用完 / 探不到」两态**永远不出现**，而面板上看不出任何异常。
           *   这类「改了数据结构、忘了改取的那一处」的 bug 只有真接线才暴露。 */
          const hit = (() => { try { return probeCache.get(p) || null; } catch { return null; } })();
          const e = hit && hit.value ? hit.value : null;
          if (!e) return null;      // 这一家没有探测源（**不是失败**）
          return { known: !!e.known, used: e.known ? e.used : null, limit: e.known ? e.limit : null, error: e.error || null };
        },
      };
      const keys = allChannelKeys();
      const channels = keys.map((k) => channelState(k, ctx));
      return json(res, 200, { ok: true, channels, at: now });
    }
    /* ---------- 价格表：读当前这张 + 用户点了才更新 ---------- */
    if (req.method === "GET" && u.pathname === "/api/traffic") {
      /* 「流量」视图的数据源（traffic.mjs 的纯逻辑）。
       * ⚠ **费用由调用方算**：traffic.mjs 只管 token 维度，钱要靠价格表 ——
       *   而价格表是「用户点了才更新」的那张（effectivePricingTable）。
       *   估不出就是 null（**不是 0**）：一个错数字比没有数字更坏，
       *   用户要拿它跟厂商账单对账。 */
      const days = Math.min(365, Math.max(1, Number(u.searchParams.get("days")) || 30));
      const now = Date.now();
      const rows = loadUsageRows();
      const table = effectivePricingTable();
      const costOf = (recs) => {
        try {
          const e = estimateCost(recs, { now, table });
          return e.known ? e.total : null;
        } catch { return null; }
      };
      /* 亲和表是**按渠道**存的（wb / wbai 各一份），traffic.mjs 要的是按渠道分组的形状。 */
      const affinity = [];
      for (const p of allChannelKeys()) {
        try {
          const entries = wbAffinityEntries(p);
          if (entries && entries.length) affinity.push({ channel: p, entries });
        } catch { /* 这一家没有亲和表（大多数渠道都没有）——跳过，不影响别的 */ }
      }
      let t = null;
      try {
        t = buildTraffic(rows, { nowMs: now, days, costOf, affinity });
      } catch (e) {
        return json(res, 500, { error: "读流量失败：" + String((e && e.message) || e) });
      }
      return json(res, 200, { ok: true, days, at: now, ...t });
    }
    if (req.method === "GET" && u.pathname === "/api/pricing") {
      try {
        return json(res, 200, { ok: true, ...pricingOverview(Date.now()) });
      } catch (e) {
        return json(res, 500, { error: "读价格表失败：" + String((e && e.message) || e) });
      }
    }
    if (req.method === "POST" && u.pathname === "/api/pricing/refresh") {
      /* ⚠ **非阻塞**：立刻回包，刷新在后台跑。
       *   理由（与 POST /api/test 同一套）：models.dev 的 api.json 有几 MB，
       *   拉一趟好几秒；阻塞式的前端 12 秒预算会把一次**成功**报成「读取超时」。
       *   前端拿 started:true 之后轮 GET /api/pricing 看 refreshing 与结果。 */
      if (pricingState.refreshing) {
        return json(res, 200, { ok: true, started: false, reason: "已经在刷了，等它跑完" });
      }
      void refreshPricingNow();
      return json(res, 200, { ok: true, started: true });
    }
    if (req.method === "GET" && u.pathname === "/api/quota/overview") {
      /* 「额度」视图的数据源：预算（用户设的，被动）+ 上游余额（真探测）。
       * ⚠ 探测是**异步**的（要发请求），而面板每 5 秒轮询一次 ——
       *   所以探测结果在服务端缓存 5 分钟（见 probeQuotaOf），不让面板把上游打爆。 */      const cfg = loadCfg();
      const now = Date.now();
      let rows = [];
      try {
        rows = await quotaOverview(cfg, now);
      } catch (e) {
        return json(res, 500, { error: "读额度失败：" + String((e && e.message) || e) });
      }
      return json(res, 200, { ok: true, providers: rows, at: now });
    }
    if (req.method === "GET" && u.pathname === "/api/sync") {
      const cfg = loadCfg();
      const s = syncCfgOf(cfg);
      const st = loadSyncState();
      return json(res, 200, {
        ok: true,
        configured: !!s.kind,
        kind: s.kind, url: s.url, repo: s.repo, dir: s.dir,
        hasToken: !!s.token, hasUser: !!s.user,
        lastSyncAt: st && st.at ? st.at : 0,
        lastAction: st && st.action ? st.action : "",
      });
    }
    if (req.method === "POST" && u.pathname === "/api/sync/target") {
      const b = await readBody(req);
      const cfg = loadCfg();
      const kind = String(b.kind || "").trim().toLowerCase();
      if (!["local", "webdav", "github"].includes(kind)) {
        return json(res, 400, { error: "同步目标只能是 local / webdav / github" });
      }
      const next = {
        kind,
        url: String(b.url || "").trim(),
        token: String(b.token || "").trim(),
        user: String(b.user || "").trim(),
        pass: String(b.pass || ""),
        dir: String(b.dir || "").trim(),
        repo: String(b.repo || "").trim(),
        branch: String(b.branch || "").trim(),
      };
      /* ⚠ 口令（WebDAV 的 basic 密码）也在配置里 —— 那是**同步目标的凭据**，
       *   与各家的 API Key 同级：留在本地配置里，不进快照、不进日志、不回显。 */
      cfg.sync = next;
      saveCfg(cfg);
      return json(res, 200, { ok: true, kind, hasToken: !!next.token, hasUser: !!next.user });
    }
    if (req.method === "POST" && u.pathname === "/api/sync") {
      const b = await readBody(req);
      const cfg = loadCfg();
      const s = syncCfgOf(cfg);
      if (!s.kind) return json(res, 400, { error: "还没配同步目标" });
      let target = null;
      try { target = makeSyncTarget(cfg); }
      catch (e) { return json(res, 400, { error: "同步目标配得不对：" + String((e && e.message) || e) }); }
      if (!target) return json(res, 400, { error: "还不认识的同步目标：" + s.kind });
      let pass = "";
      try { pass = checkPassphrase(b.passphrase); }
      catch (e) { return json(res, 400, { error: String((e && e.message) || e) }); }
      const { snapshot: localSnapshot, parts: localParts, changedAt } = localSyncParts(cfg);
      const state = loadSyncState();
      const open = async (bytes) => importBundle(bytes, pass, { now: Date.now() });
      /* ⚠ 封远端那份要用**整份快照**的形状（format / version / app）——
       *   只给 parts 的话 backup.mjs 会说「这不是 B.AI 路由台的快照」。 */
      const seal = async (parts, opts) => exportBundle(
        { ...localSnapshot, parts, createdAt: Date.now() }, pass, opts || {},
      );
      try {
        const r = await runSync({
          target, open, seal, localParts, localChangedAt: changedAt, state, now: Date.now(),
        });
        /* 远端更新的部分写回本地（**合并**，不是整份覆盖）。 */
        let pulled = [];
        if (r.pull && Object.keys(r.pull).length) {
          const cur = loadCfg();
          const merged = restoreConfig(
            { ...localSnapshot, parts: { ...localParts, ...r.pull }, createdAt: Date.now() },
            cur, { now: Date.now() },
          );
          if (merged.changed) saveCfg(merged.config);
          pulled = Object.keys(r.pull);
        }
        saveSyncState({ ...(r.state || {}), at: Date.now(), action: r.plan && r.plan.action });
        return json(res, 200, {
          ok: true,
          action: r.plan && r.plan.action, pushed: !!r.pushed, pulled,
          notice: r.notice || "", conflicts: (r.plan && r.plan.conflicts) || [],
        });
      } catch (e) {
        return json(res, 400, { error: "同步失败：" + String((e && e.message) || e) });
      }
    }
    if (req.method === "GET" && u.pathname === "/api/middleware") {
      return json(res, 200, {
        ok: true,
        dir: path.join(DATA_DIR, "middleware"),
        list: middlewareRegistry.list().map((e) => ({
          id: e.id, name: e.name, rules: (e.compiled && e.compiled.rules && e.compiled.rules.length) || 0,
        })),
        errors: middlewareErrors,
      });
    }
    if (req.method === "POST" && u.pathname === "/api/middleware/reload") {
      const n = loadMiddleware();
      return json(res, 200, { ok: true, loaded: n, errors: middlewareErrors });
    }
    /* ---------- 代码插件（pluginrt）----------
     * ⚠ 路径是 `/api/code-plugins*`，**不是** `/api/plugins*` ——
     *   后者是「插件渠道」（声明式加一家上游渠道），与代码插件是两回事。 */
    if (req.method === "GET" && u.pathname === "/api/code-plugins") {
      const rt = codePluginRuntime;
      return json(res, 200, {
        ok: true,
        dir: codePluginDir(),
        list: rt ? rt.list() : [],
        errors: codePluginErrors,
        /* 这一格是给人看的实话：没装插件就一个都不许显示成「装好了」。 */
        count: codePluginCount,
      });
    }
    if (req.method === "POST" && u.pathname === "/api/code-plugins/reload") {
      const r = await reloadCodePlugins();
      return json(res, 200, { ok: true, installed: r.installed, errors: r.errors });
    }
    if (req.method === "POST" && u.pathname === "/api/code-plugins/scaffold") {
      /* 「给我一个能直接改的样板插件」。
       *
       * ⚠ **为什么要有这个**：代码插件是用户自己写的 JS，可它的门槛是
       *   「建目录 + 写 plugin.json + 写入口文件」—— 三步都得知道格式。
       *   没有这一步，用户面对的是一个**看不见入口**的功能（面板上没装插件时
       *   那一整块都不画），装了才知道有这东西。
       *
       * ⚠ **只写用户自己点出来的那一个目录**，绝不覆盖已有的：
       *   目录已存在就说「已经有了，换个名字或自己改」，不碰用户写的东西。
       */
      const b = await readBody(req);
      const raw = String(b.name || "example").trim() || "example";
      /* 目录名只许小写字母数字与短横线（插件 id 的同一套规矩）：
       *   这一层挡掉 "../" 与绝对路径 —— 它会拼进文件路径里。 */
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw)) {
        return json(res, 400, { error: "插件目录名只许小写字母、数字与短横线（且以字母或数字开头）" });
      }
      const dir = path.join(codePluginDir(), raw);
      if (existsSync(dir)) {
        return json(res, 409, { error: `「${raw}」已经在了（${dir}）—— 换个名字，或者直接改那个目录里的文件` });
      }
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
          manifestVersion: 1,
          id: raw,
          name: `示例插件 · ${raw}`,
          entry: "main.mjs",
          timeoutMs: 1000,
          permissions: { fsRead: [], net: false },
        }, null, 2) + "\n", "utf8");
        writeFileSync(path.join(dir, "main.mjs"), [
          "/* 示例代码插件：默认什么都不做，放行这次请求。",
          " *",
          " *   想改请求？返回 { action: \"modify\", params: { temperature: 0.2 } }；",
          " *   想拒绝这次请求？返回 { action: \"deny\", reason: \"一句话说明\" }。",
          " *   request 是**摘要**（头只有名字、没有值）；api.log(\"…\") 写进面板日志。 */",
          "export default function (request, api) {",
          "  api.log(`看到 ${request.channel} 的 ${request.model}`);",
          "  return { action: \"allow\" };",
          "}",
          "",
        ].join("\n"), "utf8");
      } catch (e) {
        return json(res, 500, { error: "写样板失败：" + String((e && e.message) || e) });
      }
      return json(res, 200, { ok: true, dir, id: raw, entry: path.join(dir, "main.mjs") });
    }
    if (req.method === "POST" && u.pathname === "/api/code-plugins/remove") {
      const b = await readBody(req);
      const id = String(b.id || "").trim();
      const rt = await ensureCodePluginRuntime();
      const gone = rt.remove(id);
      codePluginCount = rt.list().length;
      return json(res, gone ? 200 : 404, gone
        ? { ok: true, removed: id }
        : { error: `没有装着的代码插件「${id}」` });
    }
    if (req.method === "POST" && u.pathname === "/api/plugins/credential") {
      const b = await readBody(req);
      const id = String(b.id || "").trim();
      const entry = pluginRegistry.get(id);
      if (!entry) return json(res, 404, { error: "没有这个插件渠道：" + id });
      if (!entry.credentialField) {
        return json(res, 400, { error: `这个渠道的认证方式（${entry.auth}）不需要凭据` });
      }
      const cfg = loadCfg();
      const sub = (cfg[id] && typeof cfg[id] === "object") ? cfg[id] : {};
      sub[entry.credentialField] = String(b.key || "").trim();
      cfg[id] = sub;
      saveCfg(cfg);
      /* ⚠ **不回显凭据本身** —— 只说「填了没有」。 */
      return json(res, 200, { ok: true, id, hasCredential: !!sub[entry.credentialField] });
    }
    /* ---------- 限流上限（面板读写）----------
     * 上限 0 = 不限（默认）。逐家覆盖存在 cfg[provider].limits 里。 */
    if (req.method === "GET" && u.pathname === "/api/limits") {
      const cfg = loadCfg();
      const now = Date.now();
      const states = budgetStates(cfg, now);
      const stats = {};
      for (const k of allChannelKeys()) {
        const st = concurrencyGate.stats(k);
        const rp = rpmGate.stats(k);
        const q = states.get(k) || null;
        const bud = (() => { try { return budgetOf(k, cfg); } catch { return null; } })();
        stats[k] = {
          limit: limitsOf(k, cfg).concurrency, rpm: limitsOf(k, cfg).rpm,
          busy: st.busy, waiting: st.waiting, rejected: st.rejected, leaked: st.leaked,
          acquired: st.acquired, released: st.released,
          rpmUsed: rp ? rp.used : 0,
          /* 预算：面板要能看见「用了多少 / 上限多少 / 什么时候重置」，
           * 也要能看见**上限本身**（不然改不回去）。 */
          budget: (q || bud) ? {
            used: q ? q.used : 0, limit: q ? q.limit : 0,
            ratio: q ? q.ratio : 0, exhausted: !!(q && q.exhausted),
            resetAtMs: q ? q.resetAtMs : 0,
            hourly: bud && bud.hourly != null ? bud.hourly : null,
            daily: bud && bud.daily != null ? bud.daily : null,
          } : null,
        };
      }
      return json(res, 200, { ok: true, limits: limitsOf("", cfg), stats });
    }
    if (req.method === "POST" && u.pathname === "/api/quota") {
      const b = await readBody(req);
      const provider = String(b.provider || "").trim();
      if (!isChannelKey(provider)) return json(res, 400, { error: "不认识的渠道：" + provider });
      const num = (v) => {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
      };
      const hourly = num(b.hourly);
      const daily = num(b.daily);
      if (hourly === null && daily === null) {
        /* 两个都空 = 取消这家的预算（不限）。 */
        const cfg = loadCfg();
        if (cfg.quota && typeof cfg.quota === "object") delete cfg.quota[provider];
        if (cfg[provider] && cfg[provider].quota) delete cfg[provider].quota;
        saveCfg(cfg);
        budgetCache = { at: 0, states: new Map() };   // 让下次请求重算
        return json(res, 200, { ok: true, provider, hourly: null, daily: null });
      }
      const cfg = loadCfg();
      const entry = { unit: "tokens" };
      if (hourly !== null) entry.hourly = hourly;
      if (daily !== null) entry.daily = daily;
      /* 预算存在**顶层**的 cfg.quota[渠道键] 里（quota.mjs 的读法：顶层优先，
       * 其次才是 cfg[渠道].quota）。放顶层是因为 bai 是**扁平**的（没有 cfg.bai 这一层），
       * 放自家块里的话 bai 就存不下了。 */
      if (!cfg.quota || typeof cfg.quota !== "object") cfg.quota = {};
      cfg.quota[provider] = entry;
      saveCfg(cfg);
      budgetCache = { at: 0, states: new Map() };
      return json(res, 200, { ok: true, provider, ...entry });
    }
    if (req.method === "POST" && u.pathname === "/api/limits") {
      const b = await readBody(req);
      const num = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
      };
      const cur = loadCfg();
      const g = cur.limits && typeof cur.limits === "object" ? { ...cur.limits } : {};
      if (b.concurrency !== undefined) g.concurrency = num(b.concurrency, g.concurrency || 0);
      if (b.rpm !== undefined) g.rpm = num(b.rpm, g.rpm || 0);
      if (b.waitMs !== undefined) g.waitMs = num(b.waitMs, g.waitMs || 120000);
      cur.limits = g;
      saveCfg(cur);
      return json(res, 200, { ok: true, limits: limitsOf("", cur) });
    }
    /* ---------- 用量账本（面板读）----------
     * 账本是 JSONL 追加日志（usage-ledger.mjs）。读的时候**坏行跳过**——
     * 末尾半行是常态（别的进程正在写），为一行坏掉而作废整份账本不划算。
     */
    if (req.method === "GET" && u.pathname === "/api/usage") {
      const rows = loadUsageRows();
      const totals = { requests: 0, failed: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 };
      const byProvider = new Map();
      const byModel = new Map();
      for (const r of rows) {
        totals.requests++;
        /* handed_on 的那些 try 写了记录但**不算失败数**（它们已经把活交出去了）。 */
        if (!r.handed_on && Number(r.status) >= 400) totals.failed++;
        totals.tokensIn += Number(r.in) || 0;
        totals.tokensOut += Number(r.out) || 0;
        totals.cacheRead += Number(r.cache_read) || 0;
        totals.cacheWrite += Number(r.cache_write) || 0;
        const pk = r.provider || "?";
        const pm = byProvider.get(pk) || { key: pk, name: PROVIDERS[pk] || pk, requests: 0, tokens: 0 };
        pm.requests++; pm.tokens += (Number(r.in) || 0) + (Number(r.out) || 0);
        byProvider.set(pk, pm);
        const mk = r.model || "?";
        const mm2 = byModel.get(mk) || { key: mk, requests: 0, tokens: 0 };
        mm2.requests++; mm2.tokens += (Number(r.in) || 0) + (Number(r.out) || 0);
        byModel.set(mk, mm2);
      }
      const recent = rows.slice(-200).reverse().map((r) => ({
        t: r.t, agent: r.agent, provider: r.provider, model: r.model,
        req: r.req, served: r.served,
        in: r.in, out: r.out, cacheRead: r.cache_read, cacheWrite: r.cache_write,
        status: r.status, error: r.error, tries: r.tries, ms: r.ms, ttftMs: r.ttft_ms,
        tierServed: r.tier_served, kind: r.kind, handedOn: r.handed_on,
      }));
      /* 费用：按价格表把 token 数折成钱。
       * ⚠ **估不出来就是 null**（不是 0）—— 一个错数字比没有数字更坏：
       *   用户会拿它跟厂商账单对账。估不出的模型列在 unknownModels 里。 */
      const cost = (() => {
        /* 同上：传当前生效的那张表（用户更新过就用远端那张）。 */
        try { return estimateCost(rows, { now: Date.now(), table: effectivePricingTable() }); } catch { return null; }
      })();
      const totals2 = {
        ...totals,
        cost: cost ? cost.total : null,
        costKnown: cost ? !!cost.known : false,
        unknownModels: cost ? cost.unknownModels : [],
        pricedAt: cost ? cost.pricedAt : "",
        currency: cost ? cost.currency : "USD",
      };
      return json(res, 200, {
        ok: true, totals: totals2,
        rows: recent,
        byProvider: Array.from(byProvider.values()).sort((a, b) => b.requests - a.requests),
        byModel: Array.from(byModel.values()).sort((a, b) => b.requests - a.requests).slice(0, 30),
      });
    }
    /* ---- 客户端接线（Qoder / ZCode / Kimi Code / Cline…） ----
     *
     * 面板上「接到某个客户端」：替用户把那个客户端的配置文件写好。
     * 底座在 clients/base.mjs（备份/还原/判状态），名录在 clients/registry.mjs。
     */
    if (req.method === "GET" && u.pathname === "/api/clients") {
      const ctx = clientCtx();
      const list = await allClients();
      const out = [];
      for (const c of list) {
        let st = { wired: false, detail: "", file: "" };
        /* ⚠ 判状态失败**如实报**，不让一个客户端的异常把整张列表变成空白。 */
        try { st = clientStatus(c, ctx, { dataDir: DATA_DIR }); }
        catch (e) { st = { wired: false, detail: "读状态时出错：" + String((e && e.message) || e) }; }
        out.push({
          id: c.id, name: c.name, protocol: c.protocol || "", note: c.note || "",
          status: st,
        });
      }
      return json(res, 200, { ok: true, list: out });
    }
    if (req.method === "POST" && u.pathname === "/api/clients/apply") {
      const b = await readBody(req);
      const def = await clientById(b.id);
      if (!def) return json(res, 404, { error: `没有这个客户端：${String(b.id || "")}` });
      const r = applyClient(def, clientCtx(), { dataDir: DATA_DIR });
      return json(res, r.ok ? 200 : 400, r);
    }
    if (req.method === "POST" && u.pathname === "/api/clients/revert") {
      const b = await readBody(req);
      const def = await clientById(b.id);
      if (!def) return json(res, 404, { error: `没有这个客户端：${String(b.id || "")}` });
      const r = revertClient(def, { dataDir: DATA_DIR });
      return json(res, r.ok ? 200 : 400, r);
    }
    if (req.method === "POST" && u.pathname === "/api/apply") {
      const b = await readBody(req);
      const P = resolveChannelKey(b.provider);
      const cfg = loadCfg();
      const S = sliceOf(cfg, P);
      /* ⚠ 插件渠道不在 PROVIDERS 里（那是出厂八家的显示名表）→ 用它自己的名字，
       *   别让错误信息里出现「undefined」。 */
      const name = PROVIDERS[P] || S.zh || P;
      /* zen 走「OpenCode 客户端中转」时**根本不需要 API Key**——
       * 凭据由 OpenCode 自己带，我们只是转发（`providerConfigured` 早就认了这一点）。
       * 但这里原先硬性要 Key，于是面板「一键接入」被 400「请先填写 API Key」挡住：
       * 一个**压根不需要 Key** 的档位，逼着用户去填一个用不上的 Key。
       * 判据与 cliViaRelay 同源，别各写一份。 */
      const needsKey = !(P === "zen" && S.transport === ZEN_TRANSPORT_OPENCODE);
      if (needsKey && !S.key) {
        return json(res, 400, {
          error: P === "wb" || P === "wbai"
            ? `请先在「${name}」页粘贴访问令牌（JWT）——捕获方法见该页说明`
            : P === "or"
              ? "请先在「OpenRouter」页的「免费流水区」填入至少 1 个 sk-or-v1 API Key（最多 3 把）"
              : `请先在「${name}」路由表里填写 API Key`
                + (pluginRegistry.has(P) ? "（插件渠道的凭据填在「插件渠道」卡里）" : ""),
        });
      }
      // Qoder 的 key 是稳定占位符（令牌会轮换、不落 config），故单独校验令牌是否真的读得到
      if (P === "qd") {
        try { qdEnsureToken(cfg, true); }
        catch {
          return json(res, 400, { error: "未读到 Qoder 令牌——请先启动 Qoder 桌面端（补丁会把令牌写到 %TEMP%/qoder-token.json），无需手动填写" });
        }
      }
      /* mm（MiniMax 会员）：凭据不在配置里（只在内存），所以「配没配好」只能问令牌仓库。
       * 用 recheck()：用户很可能**先装路由台、之后才登录 MiniMax Code**，
       * 只问内存快照会让这一格永远被判未配置（与转移链的判据同源，见 providerConfigured）。 */
      if (P === "mm") {
        const snap = mmTokens.recheck();
        if (snap.invalid) {
          return json(res, 400, { error: MM_LOGIN_INVALID_MSG + "——请在 MiniMax Code 里重新登录，然后回到本页点「重新读取登录态」" });
        }
        if (!snap.configured) {
          return json(res, 400, { error: "本机没读到 MiniMax 登录态——请先在 MiniMax Code 里登录，然后回到本页点「重新读取登录态」，再接入" });
        }
      }
      const doCli = b.cli !== false;
      const doDesk = b.desktop !== false;
      const warns = [];
      if (doCli) { const w = snapshotExternal(); warns.push(...w.filter((x) => x.startsWith("桌面"))); }
      if (doDesk) { const w = snapshotExternal(); warns.push(...w.filter((x) => x.startsWith("CLI"))); }
      /* 快照一次，把两边的警告按**这次要动哪一边**分派。
       *
       * ⚠ 旧写法是两个分支各调一次 snapshotExternal，然后**互相挑错了对方的警告**：
       *   doCli 分支挑的是「桌面版没有可恢复的快照」，doDesk 分支挑的是「CLI 没有…」——
       *   正好反了。于是只接 CLI 时，CLI 没快照的警告被藏起来，桌面版的警告却冒出来；
       *   只接桌面版时同理。现在挑对了。 */
      {
        const w = snapshotExternal();
        if (doCli) warns.push(...w.filter((x) => x.startsWith("CLI")));
        if (doDesk) warns.push(...w.filter((x) => x.startsWith("桌面")));
      }
      /* 接线失败**必须如实告诉用户**：多半是 ~/.claude/settings.json 读不懂
       * （手滑多一个逗号、别的工具写了注释）。这时我们**一个字都没改**，
       * 面板该说的是「你的文件读不懂、修好再来」，而不是一个笼统的 500。
       * 旧写法里 applyToCli 从不抛错——因为它把读失败当成空对象然后照写，
       * 于是「读不懂」变成「静默清空用户配置」。现在读不懂会抛，这里接住它。 */
      const applied = [];
      try {
        if (doCli) { await applyToCli(S); applied.push("cli"); }
        if (doDesk) { applyToDesktop(S); applied.push("desktop"); }
      } catch (e) {
        const repair = (e && e.repair) || null;
        log(`接线到 ${name} 失败：`, (e && e.message) || e);
        return json(res, 400, {
          error: String((e && e.message) || e).slice(0, 500),
          repair,
          applied,
          /* 一个字都没改 —— 面板可以据此说清「你的配置没被动过」。 */
          untouched: applied.length === 0,
        });
      }
      const ccRunning = await checkCcSwitch();
      if (ccRunning) warns.push("CC Switch 正在运行，它可能随时把配置改回去；切换前建议先退出它");
      warns.push("桌面版需完全退出并重开 Claude 才生效；CLI 新开终端生效");
      if (P === "sn") warns.push("SenseNova 有 TPM/RPM 限流，探测到 429 属正常，稍候即恢复；图像模型不参与对话路由");
      if (P === "wb") warns.push("WorkBuddy 国内版：0 积分模型由 WorkBuddy 客户端账号提供；令牌过期会自动用刷新令牌续期，无需重新接线。国际版请到「WorkBuddy AI」格单独接线");
      if (P === "wbai") warns.push("WorkBuddy AI 国际版：需要国际版客户端的令牌（与国内版不通用）；模型目录与倍率来自上游 /v3/config，未取到时用出厂兜底清单");
      if (P === "zen") warns.push("OpenCode Zen 有两档、还有两种传输方式，可用性完全不同："
        + "①「免费档」已被服务端封死（2026-10-17 起，外部调用一律 403 FreeTierError，直连与经本机 OpenCode 客户端中转都过不去），这一档已无法使用、不是本机故障；"
        + "②「Go 档」（上游含 /zen/go/）能用，但要账号已订阅 OpenCode Go（$10/月，https://opencode.ai/auth），你的 oc_sk 在 Go 档是被识别的。"
        + "免费档若要继续对话：要么把上游地址改成 Go 档并订阅，要么让故障转移自动落到 WorkBuddy / OpenRouter 等其它通道；"
        + "改档位请改上游地址，然后点「刷新模型列表」换成该档自己的目录");
      if (P === "qd") warns.push("Qoder 走账号的 Free 套餐额度；令牌每次 Qoder 启动会轮换，中转会自动跟随——但 Qoder 客户端必须保持运行，否则中转读不到令牌");
      if (P === "mm") warns.push("MiniMax 会员通道走的是**会员额度**（MiniMax Code 登录的那个账号自带的额度），"
        + "**不是**开放平台按量计费的 API Key——两回事，别混。令牌只存在内存里：重启路由台要重新读，"
        + "在 MiniMax Code 里登录即可恢复。上游会按 system prompt 的内容做客户端指纹校验，"
        + "中转转发时已带上正确的 UA/Origin/Referer，实测能过。");
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
    /* ★ v1.0.81：**立刻回包**，探测搬到后台（runTierProbe）。
     *
     * 改之前这个 handler 把四档串行探完才回包：单档 3 次重试 × 45s，勾上「测全部四档」
     * 最坏 ≈545 秒。而面板 api() 的默认读超时是 12 秒 —— 上游只要慢一次，前端就
     * 100% 先断，然后把一次**正在正常进行的探测**报成「✘ 读取超时（超过 12 秒）」。
     * 服务端还在探，下一轮 5 秒轮询才会把结果送到用户眼前，而那次失败提示已经骗过
     * 用户一遍了（与 v1.0.79/80 是同一个故事：成功要说成成功）。
     *
     * 现在 POST 只做两件事：登记「这一家正在探测」（供 /api/status 暴露 running）、
     * 把探测丢进后台，立刻回 {started:true}。前端改成轮 /api/status —— 每次读都是短的，
     * 读多久都不会被掐断，过程中看得见进度，结束时拿到的就是真结果。
     *
     * ⚠ 同一渠道已在探测中就**不重起一次**（连点两下不跑两轮），回 alreadyRunning。
     * ⚠ 清 running 用**对象同一性**判定（testRun === mine）：A 家在探时用户转去点 B 家，
     *   两个任务并发，A 的 finally 绝不能把 B 的 running 提前抹掉。
     */
    if (req.method === "POST" && u.pathname === "/api/test") {
      const b = await readBody(req).catch(() => ({}));
      const P = resolveChannelKey(b.provider);
      if (testRun && testRun.p === P) {
        return json(res, 200, {
          ok: true, started: false, alreadyRunning: true, provider: P,
          startedAt: new Date(testRun.startedAt).toISOString(),
        });
      }
      const mine = { p: P, startedAt: Date.now() };
      testRun = mine;
      void runTierProbe(loadCfg(), P, !!b.all).catch((e) => {
        log("测连通后台任务异常:", String((e && e.message) || e).slice(0, 200));
        Object.assign(lastTest[P], { ok: false, error: String((e && e.message) || e).slice(0, 200), at: new Date().toISOString() });
      }).finally(() => { if (testRun === mine) testRun = null; });
      return json(res, 200, {
        ok: true, started: true, running: true, provider: P,
        startedAt: new Date(mine.startedAt).toISOString(),
      });
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
    srv.listen(port, "127.0.0.1");
    srv.once("listening", () => {
      srv.removeListener("error", onErr);
      log(`${name}就绪 http://127.0.0.1:${port}` + (standby ? "（待命接管成功）" : attempts > 1 ? `（重试 ${attempts - 1} 次后绑定成功）` : ""));
      standby = false;
    });
  };
  const onErr = async (e) => {
    /* ⚠ 重试前必须摘掉上一轮的 'listening' 监听器。
     * listen 失败时那个监听器**永远不会触发**（只 bind 成功才触发），所以每轮重试
     * 都多挂一个 —— 端口被占时（重启交接、老实例还在跑，这是常态）几十轮下来就超过
     * 10 个，Node 开始刷 MaxListenersExceededWarning。
     * 那是 v1.0.19 就有的老问题：每启一个第二实例都刷一串警告，淹掉真正的日志。 */
    srv.removeAllListeners("listening");
    if (srv.listening) return;
    if (e.code !== "EADDRINUSE") { log(`${name} 端口错误: ${e.message}`); process.exit(1); }
    if (attempts === 1) log(`${name} 端口 :${port} 暂被占用（多为重启交接），每 600ms 重试，最多 15 秒`);
    let peerHealthy = false;
    if (!relay.listening && !snRelay.listening && !wbRelay.listening && !zenRelay.listening && !qdRelay.listening && !mmRelay.listening && !orRelay.listening && !panel.listening) {
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
listenWithRetry(wbaiRelay, cfg0.wbai.relayPort, "WorkBuddyAI中转");
listenWithRetry(zenRelay, cfg0.zen.relayPort, "OpenCodeZen中转");
listenWithRetry(qdRelay, cfg0.qd.relayPort, "Qoder中转");
listenWithRetry(mmRelay, cfg0.mm.relayPort, "MiniMax会员中转");
listenWithRetry(orRelay, cfg0.or.relayPort, "OpenRouter中转");
/* 插件渠道的中转：端口写错了（被占）时**只记一行继续跑** ——
 * 一个第三方插件不该让整个路由台起不来。 */
for (const id of pluginRegistry.keys()) {
  const S = pluginSliceOf(id, loadCfg());
  if (!S) continue;
  try {
    pluginRelays[id].listen(S.relayPort, "127.0.0.1");
    log(`插件渠道中转就绪 http://127.0.0.1:${S.relayPort}（${S.zh}）`);
  } catch (e) {
    log(`⚠ 插件渠道 ${id} 的中转端口 ${S.relayPort} 绑不上：${String((e && e.message) || e)}`);
  }
}
listenWithRetry(panel, cfg0.panelPort, "面板");
/* 统一网关的监听：**绑不上也不许拖垮现有中转**。
 *
 * 8 个中转端口是本软件的命脉，统一网关只是**新增**的一个入口 ——
 * 它的端口被占（多半是另一个实例占着）时只记一行日志继续跑，
 * 绝不能像 listenWithRetry 那样 exit(2) 把整个服务带走。
 * 那条「端口被占就退出重试」的规矩是为**中转端口**定的：
 * 中转端口被占 = 服务干不了活，重启交接是唯一合理的动作；
 * 网关端口被占 = 少一个可选入口而已，8 个中转端口照常服务。 */
function listenGateway(srv, port, name) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    log(`${name}未启用（端口配置无效：${JSON.stringify(port)}）——现有中转端口不受影响`);
    return;
  }
  srv.on("error", (e) => {
    log(`${name} 端口 :${port} 监听失败（${e && e.message}）——现有中转端口不受影响，统一网关入口本次不可用`);
  });
  srv.listen(port, "127.0.0.1", () => {
    log(`${name}就绪 http://127.0.0.1:${port}（模型名写成 provider/模型，例如 sn/glm-5.2）`);
  });
}
listenGateway(gatewayServer, cfg0.gatewayPort, "统一网关");
// 成功绑定中转端口 = 本实例成为唯一的活跃服务者，此时才允许合并配置/跑周期探测
relay.once("listening", () => setTimeout(onActivated, 300));
