/**
 * wb-pool-wiring.mjs —— 把账号池内核（wb-pool.mjs）接进中转的**接线层**（纯逻辑，零 IO、零网络）
 *
 * ## 分工
 *
 *   wb-pool.mjs      内核：五类失败五种处置、凭据新鲜度、粘性、选号、亲和决策。
 *   本模块           接线：读配置 → 建池 → 选号 → 回灌 → 给面板。**零网络**：
 *                    时间源（opts.now）、哈希、会话 key、刷新动作（opts.refresh）、
 *                    JWT 到期解码（opts.tokenExpOf）**全部由调用方注入**，
 *                    所以 scripts/wb-pool-wiring-test.mjs 能直接 import 本文件求值，
 *                    不起进程、不发网络。
 *                    ⚠ **唯一的 IO**：会话亲和表的落盘（读一次、写一次）——
 *                    见下面「①' 会话亲和」那一节。没配置持久化时它**一次盘都不碰**。
 *   server.mjs      唯一知道「令牌续期要 POST 到哪、续期后要写回哪份 config」的地方。
 *
 * ## ①' 会话亲和（magpie affinity 的移植接线）
 *
 *   `src/server/session-store.mjs` 是**持久化那套**亲和层（判据：magpie 的
 *   「缓存值不值得留」+ 跨进程重启还在）。本模块把它接进选号路径：
 *
 *     选号前先问亲和层「这段对话归谁」→ 那个号**现在还能用**就用它 →
 *     它用不了了（冷却/额度/停用）才换，**绑定留着**（休息 ≠ 死）→
 *     凭据**真的死了**才 `forgetTarget` 永久解绑。
 *
 *   **老那套内存粘性（stickyMap）继续在**：亲和层**对某个会话有记录时**它说了算，
 *   没有记录时老那套照旧接管。两套并存的理由写在「为什么两套并存」那一段。
 *
 *   答完之后要记一笔（**调用方必须调**）：{@link wbNoteSuccess}。
 *
 * ## 三条不可让步的规矩（每条都有测试反向对照）
 *
 *   ① **失败原因只问池子。** 选不出号时直接把 {@link acquire} 的 reason/remedy 带回去，
 *      接线层**没有反推的余地**。这是 dsh-xdpool 1.7.7 的事故根因：它把「本次请求内的
 *      临时限流记录」当成「这个号到底有没有被限流」，于是看不见上一次请求造成的冷却 →
 *      报 401「API 密钥无效」→ 用户跑去重新登录一个根本没坏的账号。
 *
 *   ② **刷新路径必须传 `context:"refresh"`。** 刷新接口回的是 **400 而不是 401**，
 *      不传这个 context，一次真实的凭据吊销会被当成 content 类「请求本身有问题」，
 *      死号永远留在池子里烧重试。全仓库**只有** {@link wbNoteRefreshFailure} 一处传它。
 *
 *   ③ **绝不从响应文案反推账号好坏。** 429/402/401 的 `why` 一律取自
 *      {@link unavailableReason} / {@link applyFailure}，本文档不写任何一条
 *      「看到 XXX 就说明这个号坏了」的规则。
 *
 * ## 红线
 *
 * 全文不出现任何真实令牌/API key，也不把它们写进返回值：面板字段一律走
 * {@link redact} 或调用方注入的指纹函数（opts.fingerprint），`why` 只用固定中文说明。
 */
import {
  acquire, applyFailure, unavailableReason, remedyOf, redact, credentialFreshness,
  affinityDecision,
} from "./wb-pool.mjs";
import { SessionStore, MODES as AFFINITY_MODES } from "./session-store.mjs";
import path from "node:path";
import os from "node:os";

/* ==========================================================================
 * 池的运行期注册表
 * ========================================================================== */

/**
 * `cfg` 是**每次 loadCfg 重新 parse 出来的**（server.mjs 的 loadCfg 返回全新对象），
 * 所以池子不能挂在 `cfg.wb.accounts` 上按引用认——那样每次请求都会重建，
 * 冷却与判死标记一次都留不住。
 *
 * 所以池子按渠道常驻在这里，配置每次读进来只做**对账**：
 * 身份指纹没变就原样返回（保住状态与粘性），变了才重建并**按 id 把旧状态搬过去**。
 */
const wbRuntime = new Map();   // p -> { sig, pool, last }

/**
 * 粘性表按渠道常驻，**刻意挂在池子外面**：令牌续期成功会重写 `cfg.wb.accessToken`，
 * 合成池的指纹因此每次续期都变、池子会重建。粘性绑在池子上就等于每续一次丢一次绑定，
 * 而粘性正是这个模块存在的理由（保住 prompt cache），默默失效是最坏的一种失效。
 */
const wbSticky = new Map();    // p -> Map<sessionKey, accountId>

const WB_POOL_MODE_DEFAULT = "sticky";

/** 选号模式。认不出来的一律按默认（与内核 normalizeMode 同一条纪律：配置写错不该让路由崩）。 */
export function wbPoolModeOf(slice) {
  const m = String((slice && slice.poolMode) || "").toLowerCase();
  return ["priority", "round-robin", "balanced", "sticky"].includes(m) ? m : WB_POOL_MODE_DEFAULT;
}

/**
 * 账号身份指纹：条数 + 每条的 id + 令牌本身。
 *
 * ⚠ **令牌为什么可以进这个键**：它是模块私有的缓存键，从不写日志、不进面板、
 *   也不出现在任何返回值里；而令牌本来就已经在内存里（cfg 里就有一份）。
 *   刻意**不用长度**：两份「id 相同、令牌长度也相同」的池子会被判成同一个，
 *   于是上一轮的判死/冷却痕迹会漏到下一轮去 —— 那正是「换了一份配置却还
 *   看到上一份的死号」这种说不清的现象。
 */
function accountsSignature(list) {
  return list.map((a) => `${(a && a.id) || "?"}:${(a && a.accessToken) || ""}`).join("|");
}

function isAccountLike(a) {
  return !!a && typeof a === "object" && typeof a.id === "string" && a.id !== "";
}

/** 补齐一个来自 config.json 的账号条目的默认值。**不改用户已经写了的字段。 */
function normalizeAccount(a, p) {
  return {
    ...a,
    id: String(a.id),
    version: a.version == null ? p : String(a.version),
    label: a.label == null ? a.id : String(a.label),
    order: Number.isFinite(a.order) ? a.order : undefined,
    disabled: a.disabled === true,
    ignored: a.ignored === true,
    accessToken: a.accessToken == null ? "" : String(a.accessToken),
    refreshToken: a.refreshToken == null ? "" : String(a.refreshToken),
    deviceToken: a.deviceToken == null ? "" : String(a.deviceToken),
    userId: a.userId == null ? "" : String(a.userId),
    credential: a.credential && typeof a.credential === "object" ? a.credential : {},
    modelCooldowns: a.modelCooldowns && typeof a.modelCooldowns === "object" ? a.modelCooldowns : {},
  };
}

/**
 * ★ 向后兼容的那一步：旧配置只有 `accessToken`、没有 `accounts` 时，
 * **自动合成一个单条目池**。现有用户因此零改动、行为逐字一致——池是纯增量。
 *
 * 合成出来的条目 `synthetic:true`，且 id 固定为 `solo`：
 * 固定 id 的意义是每次合成出来都一样，冷却/判死才能跨请求留在同一个条目上。
 */
function synthAccount(slice, p) {
  return {
    id: "solo",
    label: "当前令牌",
    version: p,
    order: 0,
    synthetic: true,
    disabled: false,
    ignored: false,
    accessToken: String(slice.accessToken || ""),
    refreshToken: String(slice.refreshToken || ""),
    deviceToken: String(slice.deviceToken || ""),
    userId: String(slice.userId || ""),
    credential: {
      capturedAt: slice.capturedAt == null ? null : slice.capturedAt,
      lastRefreshTime: slice.lastRefreshAt == null ? null : slice.lastRefreshAt,
    },
    modelCooldowns: {},
  };
}

/**
 * 读池。**分池不混**：wb 与 wbai 各自一份，两版令牌互不通用（用户已明确决定）。
 *
 * @param {object} cfg 完整配置
 * @param {"wb"|"wbai"} p 渠道
 * @returns {object|null} `{version, mode, accounts[], sticky, synthetic?}`；cfg 里没这一家时 null
 */
export function wbPoolOf(cfg, p) {
  const slice = cfg && typeof cfg === "object" ? cfg[p] : null;
  if (!slice || typeof slice !== "object") return null;

  const sticky = wbSticky.get(p) || new Map();
  wbSticky.set(p, sticky);
  const rt = wbRuntime.get(p);
  const mode = wbPoolModeOf(slice);

  /* ---- 显式账号池 ---- */
  const raw = Array.isArray(slice.accounts) && slice.accounts.length
    ? slice.accounts.filter(isAccountLike)
    : null;
  if (raw) {
    const sig = "pool:" + accountsSignature(raw);
    if (rt && rt.sig === sig && rt.pool && rt.pool.accounts) {
      if (rt.pool.mode !== mode) rt.pool.mode = mode;
      return rt.pool;
    }
    /* 配置变了：重建，但**按 id 把旧状态搬过去**。
       否则「面板上点一次清除冷却」或一次 saveCfg 就会把冷却/判死痕迹全冲掉，
       而用户看到的明明是同一个池子。 */
    const prev = new Map((((rt && rt.pool && rt.pool.accounts) || [])).map((a) => [a.id, a]));
    const pool = {
      version: p, mode, accounts: [], sticky, cursor: rt && rt.pool ? rt.pool.cursor : 0,
    };
    for (const a of raw) {
      const old = prev.get(a.id);
      pool.accounts.push(old
        ? { ...old, ...normalizeAccount(a, p), modelCooldowns: { ...(old.modelCooldowns || {}), ...(a.modelCooldowns || {}) } }
        : normalizeAccount(a, p));
    }
    const rec = { sig, pool, last: (rt && rt.last) || null };
    wbRuntime.set(p, rec);
    return pool;
  }

  /* ---- 合成的单条目池（老配置） ---- */
  const tok = String(slice.accessToken || "");
  const rft = String(slice.refreshToken || "");
  const sig = "solo:" + tok + "|" + rft;
  if (rt && rt.sig === sig && rt.pool && rt.pool.synthetic) {
    /* 令牌没换 → 复用同一个对象（冷却/判死/粘性都在），只同步凭据字段。
       同步是**每次**都做的：面板改完 userId 立刻要生效，不能等令牌也换掉才生效。 */
    const a = rt.pool.accounts[0];
    a.accessToken = tok; a.refreshToken = rft;
    a.deviceToken = String(slice.deviceToken || "");
    a.userId = String(slice.userId || "");
    return rt.pool;
  }
  const pool = { version: p, mode, accounts: [synthAccount(slice, p)], sticky, synthetic: true, cursor: 0 };
  const rec = { sig, pool, last: rt ? rt.last : null };
  wbRuntime.set(p, rec);
  return pool;
}

/** 测试/换渠道时清掉运行期缓存（只在测试里用；生产路径靠指纹对账自愈）。 */
export function wbResetRuntime(p) {
  if (p == null) {
    wbRuntime.clear(); wbSticky.clear();
    wbAffinity.clear(); wbAffinityLoaded.clear(); wbAffinityTimers.clear();
    return;
  }
  wbRuntime.delete(p); wbSticky.delete(p);
  wbAffinity.delete(p); wbAffinityLoaded.delete(p);
  wbAffinityTimers.delete(p);
}

/* ==========================================================================
 * ①' 会话亲和（持久化那套 · magpie affinity 的移植）
 * ========================================================================== */

/**
 * 亲和表的时间源。
 *
 * ⚠ SessionStore **构造时**就要拿到时间源，而它自己**不许读墙上的钟**（纪律①）。
 * 接线层的 `now` 是**调用方注入**的（测试注入的是一个固定时刻，可能是几个月前），
 * 所以这里用一个**可更新的模块级时钟**：每次选号 / 记一笔都把调用方给的 now 写进去。
 *
 * 不这么做会怎样：store 内部用真实时钟，而记录上的 `at` 是注入的时刻 →
 * 「缓存冷不冷」（`now - at <= 5min`）会算出几十万毫秒 → 本该热着的缓存被判成冷的 →
 * 亲和层**永远不粘**。而这种错法在生产里表现为「粘性偶尔不生效」，极难归因。
 */
let wbClockNow = Date.now();
const wbClock = () => wbClockNow;

/** 亲和表的落盘基址；null = 没配置持久化（只在内存里，一次盘都不碰）。 */
let wbAffinityDir = null;
/** 亲和模式（magpie 那一族）：auto（默认）/ session / turn / off / strict。 */
let wbAffinityMode = "auto";
/** 最多记多少条（magpie 同值 512）。 */
let wbAffinityMax = 512;
/** 各渠道的亲和表：p -> SessionStore。 */
const wbAffinity = new Map();
/** 已经从磁盘读过的渠道（避免同一进程里重复读）。 */
const wbAffinityLoaded = new Set();
/** 待落盘（防抖）：p -> timer。 */
const wbAffinityTimers = new Map();
/** 「进程退出前 save()」的钩子只挂一次。 */
let wbAffinityExitHooked = false;

/**
 * 数据目录：%APPDATA%\bai-router（Electron 安装版通过 BAI_DATA_DIR 指过去；
 * 绿色/开发模式没有这个环境变量，就退回 %APPDATA%）。
 *
 * ⚠ **没有 BAI_DATA_DIR 时本模块一次盘都不碰**：亲和表只在**显式配置过**
 * （{@link wbAffinityConfigure}）或者 **BAI_DATA_DIR 有值**（= 生产环境）时才落盘。
 * 这么定是因为测试必须**绝不碰真实的 %APPDATA%\bai-router**（仓库红线），
 * 而生产（Electron）永远带 BAI_DATA_DIR —— 两个需求这样各归各。
 */
function defaultAffinityDir() {
  const env = process.env.BAI_DATA_DIR;
  if (env && String(env).trim()) return String(env);
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "bai-router");
  }
  return path.join(os.homedir(), ".bai-router");
}

/** 亲和表文件：<数据目录>/<渠道>-affinity.json（与 wb-catalog.json 同一目录）。 */
export function wbAffinityPath(p) {
  const dir = wbAffinityDir || defaultAffinityDir();
  return path.join(dir, `${p}-affinity.json`);
}

/** 持久化开着吗？（开着才有 file，save/load 才有意义） */
function affinityPersistOn() {
  if (wbAffinityDir != null) return true;
  return !!(process.env.BAI_DATA_DIR && String(process.env.BAI_DATA_DIR).trim());
}

/**
 * 取（必要时建）某渠道的亲和表。
 *
 * 建表时带不带 file，取决于 {@link affinityPersistOn}：带 file 的表**第一次被取到时
 * 自动读回磁盘**（「启动后 load()」），不带 file 的表一次盘都不碰。
 *
 * @param {"wb"|"wbai"} p
 * @returns {SessionStore}
 */
export function wbAffinityStore(p) {
  let st = wbAffinity.get(p);
  if (st) return st;
  const file = affinityPersistOn() ? wbAffinityPath(p) : null;
  try {
    st = new SessionStore({ file, now: wbClock, max: wbAffinityMax, mode: wbAffinityMode });
  } catch {
    // 模式写错之类：亲和坏了不该让整个池子不能用 —— 退回「不粘」。
    st = new SessionStore({ file, now: wbClock, max: wbAffinityMax, mode: "auto" });
  }
  wbAffinity.set(p, st);
  if (file && !wbAffinityLoaded.has(p)) {
    wbAffinityLoaded.add(p);
    st.load();          // 读失败当空（这一层是缓存，不是用户配置）
  }
  if (file) hookAffinityExitSave();
  return st;
}

/**
 * 「进程退出前 save()」：**只在真的要落盘时才挂**这个钩子。
 *
 * ⚠ 挂的是 `process.on("exit")` 而不是 `beforeExit`：exit 钩子里只许做**同步**的事，
 * 而落盘正好是同步的（tmp + rename）。beforeExit 可以是异步的，但进程随时可能
 * 被强杀，等它就靠不住了。
 *
 * 没开持久化时**不挂**：否则测试进程退出时会去写 %APPDATA%（仓库红线）。
 */
function hookAffinityExitSave() {
  if (wbAffinityExitHooked) return;
  wbAffinityExitHooked = true;
  process.on("exit", () => {
    try { wbAffinitySave(); } catch { /* 写失败不抛 */ }
  });
}

/**
 * 配置亲和层（落盘基址 / 模式 / 条数上限）。**幂等**：重配会把各渠道的表重建并读回。
 *
 * @param {{dir?:string|null, mode?:string, max?:number}} [opts]
 *   `dir` = 落盘基址目录；`null`/不给 = 只在内存里（一次盘都不碰）。
 * @returns {{ok:boolean, dir:string|null, mode:string, persist:boolean}}
 */
export function wbAffinityConfigure(opts = {}) {
  if (opts.dir != null) wbAffinityDir = String(opts.dir);
  if (opts.mode != null) {
    const m = String(opts.mode).trim().toLowerCase();
    if (!AFFINITY_MODES.includes(m)) {
      throw new TypeError(`wbAffinityConfigure: mode 期望 ${AFFINITY_MODES.join(" / ")} 之一，收到 ${JSON.stringify(opts.mode)}`);
    }
    wbAffinityMode = m;
  }
  if (opts.max != null) {
    const n = Number(opts.max);
    if (!Number.isFinite(n) || n < 1) throw new TypeError(`wbAffinityConfigure: max 期望至少 1，收到 ${JSON.stringify(opts.max)}`);
    wbAffinityMax = Math.floor(n);
  }
  wbAffinity.clear(); wbAffinityLoaded.clear();
  for (const p of ["wb", "wbai"]) {
    if (!affinityPersistOn()) continue;
    wbAffinityStore(p);       // 建表时自动读回
  }
  return { ok: true, dir: wbAffinityDir, mode: wbAffinityMode, persist: affinityPersistOn() };
}

/** 从磁盘读回（读失败当空 —— 这一层是缓存，不是用户配置）。 */
export function wbAffinityLoad(p) {
  const ps = p == null ? ["wb", "wbai"] : [String(p)];
  const out = {};
  for (const c of ps) {
    const st = wbAffinityStore(c);
    const r = st.load();
    wbAffinityLoaded.add(c);
    out[c] = r;
  }
  return out;
}

/**
 * 落盘（**写失败不抛**：丢亲和不是丢功能 —— 最坏后果只是下一轮没命中缓存、多花点钱）。
 */
export function wbAffinitySave(p) {
  const ps = p == null ? ["wb", "wbai"] : [String(p)];
  const out = {};
  for (const c of ps) {
    const st = wbAffinity.get(c);
    if (!st) continue;
    out[c] = st.save();       // save 内部已吞掉异常
  }
  return out;
}

/**
 * 落盘防抖：绑定变了之后合并成一次写（别每个请求都写一次盘）。
 * 定时器 unref —— 不许因为它把进程吊住。
 */
function scheduleAffinitySave(p, delayMs = 5000) {
  if (!affinityPersistOn()) return;
  const old = wbAffinityTimers.get(p);
  if (old) { try { clearTimeout(old); } catch { /* 清不掉就算了 */ } }
  const t = setTimeout(() => {
    wbAffinityTimers.delete(p);
    try { wbAffinitySave(p); } catch { /* 写失败不抛 */ }
  }, delayMs);
  try { if (typeof t.unref === "function") t.unref(); } catch { /* 老版本没有 unref */ }
  wbAffinityTimers.set(p, t);
}

/**
 * 亲和表里都有谁（面板/诊断用；不显示任何凭据）。
 *
 * 取的是**当前进程看到的那份**（含刚读回磁盘的）——所以它也是「重启后绑定还在吗」
 * 这条断言的入口：{@link wbResetRuntime} 清掉内存之后，这里再取一次，
 * 建表时会自动把磁盘上那份读回来。
 */
export function wbAffinityEntries(p) {
  return wbAffinityStore(p).entries();
}

/** 取数字；不是有限数字就当 0。 */
function affNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从上游的 usage 里认出「这次读了多少缓存 / 写了多少缓存 / 发出去多少输入」。
 *
 * 认几种常见的形状（Anthropic 与 OpenAI 两套字段名）：
 *   - `cache_read_input_tokens`（Anthropic）/ `prompt_tokens_details.cached_tokens`（OpenAI）
 *   - `cache_creation_input_tokens`（Anthropic）
 *   - `input_tokens`（Anthropic）/ `prompt_tokens`（OpenAI）
 *
 * 认不出就当 0 —— 而 0 在下游被当成「**不知道**」（不是「不值」），
 * 亲和层会照旧粘住（见 wb-pool.mjs 的 affinityDecision 第四步）。
 *
 * @param {object} usage 上游报出来的 usage 对象
 * @returns {{cacheRead:number, cacheWrite:number, cacheWrite1h:number, input:number}}
 */
export function wbCacheUsage(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const details = u.prompt_tokens_details && typeof u.prompt_tokens_details === "object" ? u.prompt_tokens_details : {};
  const creation = u.cache_creation && typeof u.cache_creation === "object" ? u.cache_creation : {};
  const cacheRead = affNum(u.cache_read_input_tokens != null ? u.cache_read_input_tokens : details.cached_tokens);
  const cacheWrite = affNum(u.cache_creation_input_tokens != null ? u.cache_creation_input_tokens : creation.total_tokens);
  const input = affNum(u.input_tokens != null ? u.input_tokens : u.prompt_tokens);
  /* 「声明留一小时」的那部分（Anthropic 的 ephemeral_1h_input_tokens）。
     两种字段名都认；认不出当 0（不影响主判据，只影响 1 小时缓存的续期）。 */
  const cacheWrite1h = affNum(u.cache_creation_1h_input_tokens != null
    ? u.cache_creation_1h_input_tokens
    : (creation.ephemeral_1h_input_tokens != null ? creation.ephemeral_1h_input_tokens : 0));
  return { cacheRead, cacheWrite, cacheWrite1h, input };
}

/**
 * ★★ **答完之后记一笔**：这段对话归这个账号了。
 *
 * **调用方（server.mjs）必须在上游答复成功后调它**，并把这次读写的缓存量带上来 ——
 * 「缓存值不值得留」（magpie 的 1024 token 门槛 + 5 分钟冷热）全靠这几个数。
 *
 * ⚠ **缓存量全是 0 也不会坏**：那被当成「**不知道**」（而不是「不值」），
 * 亲和层照旧粘住 —— 见 wb-pool.mjs 的 `affinityDecision` 第四步。
 * 但**报上来更好**：报了才知道这段对话值不值得占着一个号。
 *
 * meta 里认的字段（其余原样留着，面板要显示）：
 *   - `cacheRead`  —— 从供应商缓存里**读**回来的 token 数
 *   - `cacheWrite` —— 这次**写**进供应商缓存的 token 数
 *   - `cacheWrite1h` —— 其中声明「留一小时」的那部分
 *   - `input`      —— 这次发出去的输入 token 数（供应商既不报读也不报写时顶替缓存写入）
 *   - `model`      —— 这次用的模型（1 小时缓存是「那个号 + 那个模型」的那一份）
 *   - `usage`      —— 上游的 usage 对象；上面几个数没给时从它里认（见 {@link wbCacheUsage}）
 *
 * @param {object} cfg
 * @param {"wb"|"wbai"} p
 * @param {{sessionKey:string, accountId:string, cacheRead?:number, cacheWrite?:number,
 *          cacheWrite1h?:number, input?:number, usage?:object, model?:string|null,
 *          turn?:number, now?:number}} o
 * @returns {{ok:boolean, target?:string, at?:number, sessions?:number, reason?:string}}
 */
export function wbNoteSuccess(cfg, p, o = {}) {
  const now = Number(o.now) || Date.now();
  wbClockNow = now;                       // 亲和表的时间源跟着调用方走
  const key = o.sessionKey == null ? "" : String(o.sessionKey);
  const accountId = o.accountId == null ? "" : String(o.accountId);
  if (!key) return { ok: false, reason: "no-session" };
  if (!accountId) return { ok: false, reason: "no-account" };
  /* 显式给的数优先；没给才从 usage 里认。 */
  const fromUsage = o.usage ? wbCacheUsage(o.usage) : null;
  const pick0 = (explicit, fromU) => (explicit == null ? fromU : affNum(explicit));
  const store = wbAffinityStore(p);
  const rec = store.bind(key, accountId, {
    cacheRead: pick0(o.cacheRead, fromUsage ? fromUsage.cacheRead : 0),
    cacheWrite: pick0(o.cacheWrite, fromUsage ? fromUsage.cacheWrite : 0),
    cacheWrite1h: pick0(o.cacheWrite1h, fromUsage ? fromUsage.cacheWrite1h : 0),
    input: pick0(o.input, fromUsage ? fromUsage.input : 0),
    model: o.model == null ? null : String(o.model),
    turn: o.turn == null ? null : affNum(o.turn),
  });
  if (!rec) return { ok: false, reason: "not-bound" };
  scheduleAffinitySave(p);
  return { ok: true, target: rec.target, at: rec.at, sessions: store.size };
}

/**
 * **那个号死了 → 把它名下所有会话永久解绑。**
 *
 * ⚠ **只对「死了」调**。「休息中」（冷却 / 额度用尽 / 被停用）**不解绑** ——
 * 那些号等会儿还能用（充值或冷却到点就回来了），解绑等于白白丢掉已经建好的缓存；
 * 而死了的号再粘着就是**死等**（凭据不会自己活过来）。
 *
 * 老那套内存粘性里指向它的绑定也一并清掉：老那套自己也会落空（死号不在
 * eligible 里），但**显式清掉**才是一份诚实的状态 —— 否则「这个会话还归那个
 * 死号」这件事在内存里还留着，下一轮又要去查一遍才发现。
 */
function forgetAffinityTarget(p, accountId) {
  if (!accountId) return 0;
  let n = 0;
  const store = wbAffinity.get(p);
  if (store) {
    n = store.forgetTarget(accountId);
    if (n) scheduleAffinitySave(p);
  }
  const m = wbSticky.get(p);
  if (m) {
    for (const [k, v] of [...m.entries()]) if (v === accountId) m.delete(k);
  }
  return n;
}

/**
 * 选号前的**亲和查询**：这段对话现在归谁、这一轮该不该用它。
 *
 * 返回 `{target, decided}`：
 *   - `target` 非空 → 用它（它现在**还能用**，且缓存**值得留**）。
 *   - `decided` 为真 → 亲和层对这条会话**有记录**，它说了算：
 *     老那套内存粘性对**同一条会话**让位（删掉它对那条 key 的绑定），
 *     免得两套打架（老那套不查「缓存值不值得留」，只会无脑粘住）。
 *
 * @param {string} key 新那套的会话 key
 * @param {string|null} stickyKey 老那套的会话 key（与 key 相同 = 同一个 key 空间，
 *        此时老那套必须让位；不同 = 调用方刻意把两类请求分开，各走各的）
 * @returns {{target:string|null, decided:boolean, reason:string|null, dead:boolean,
 *            blocked:boolean}}
 */
function affinityPick(pool, p, key, stickyKey, now, model) {
  const out = { target: null, decided: false, reason: null, dead: false, blocked: false };
  if (!key) return out;
  const store = wbAffinityStore(p);
  const dec = affinityDecision(pool, store, key, now, model);
  if (!dec.has) return out;                    // 亲和层没有这条记录 → 老那套接管
  out.decided = true;
  out.reason = dec.reason;
  out.dead = dec.dead;
  if (dec.decision === "stick" && dec.target) {
    /* 接线层的口径：没填令牌的条目**不算可用**（内核只会说「停用」）。
       这种条目当「换号」处理，但绑定照旧留着（不是死了）。 */
    const t = (pool.accounts || []).find((a) => a && a.id === dec.target);
    if (t && t.accessToken) out.target = dec.target;
    /* ★ **strict 模式**（magpie #1797）：粘住就绝不换，**哪怕那个号已经休息**。
       池子只会选「可用」的账号，所以兑现 strict 的唯一诚实方式是**如实报错**
       （那个号自己的原因），而不是偷偷换一个 —— 偷偷换就是 strict 失效，
       而「默默失效」是最坏的一种失效（用户以为粘住了，其实在乱跳）。 */
    if (store.mode === "strict" && dec.reason && dec.reason !== "ok") {
      out.blocked = true;
      out.target = dec.target;
    }
  }
  /* 老那套让位：**同一个 key 空间**时才让（调用方刻意分开的两个 key 空间，
     那是「两类请求各走各的」，老那套的绑定跟新那套不冲突）。 */
  if (stickyKey && stickyKey === key) {
    const legacy = wbSticky.get(p);
    if (legacy) legacy.delete(key);
  }
  return out;
}

/* ==========================================================================
 * ① 选号（取代单令牌）
 * ========================================================================== */

/**
 * 「一个账号都没有可用」时的 HTTP 状态码。**不能一律 401**。
 *
 *   no_token          → 401（与改动前逐字一致：没配令牌就是没配令牌）
 *   cooling/quota     → 429（等得回来 / 要充值，让外层故障转移去试别家）
 *   其它（判死/停用/移出/空池）→ 503（本机池子坏了，不是客户端的问题，更不是「密钥无效」）
 *
 * 三种都在 shouldFailover 的白名单里（429/401/503），所以**外层故障转移的行为不变**。
 */
export function wbUnusableStatus(reason) {
  if (reason === "no_token" || reason === "expired") return 401;
  if (reason === "cooling" || reason === "cooling_model" || reason === "quota") return 429;
  return 503;
}

/** 令牌有没有临近过期（120 秒窗口，与改动前 wbEnsureToken 的判据一致）。 */
function tokenExpiring(expMs, now) {
  return Number.isFinite(expMs) && expMs - now <= 120000;
}

/**
 * 选一个账号并拿到它的凭据。**这是接线层唯一给中转提供令牌的地方。**
 *
 * @param {object} cfg
 * @param {"wb"|"wbai"} p
 * @param {object} opts
 * @param {string|null} [opts.model]        要调的模型（决定 (账号,模型) 那一格冷不冷）
 * @param {string|null} [opts.sessionKey]   会话 key —— **新那套**（持久化亲和层）用的。
 *        **没有就别传**（探测/健康检查不污染粘性表）。
 * @param {string|null} [opts.stickyKey]    **老那套**（内存 LRU 粘性）用的 key。
 *        不给 = 与 `sessionKey` 相同（老行为：两者共用一个 key）。
 *        显式分开 = 「两套并存」的那一刀：调用方拿**原生会话头**的请求走新那套，
 *        拿**派生 key**（首条 user 消息的哈希）的请求走老那套。
 * @param {number} opts.now                 时间源（必填）
 * @param {Function} [opts.refresh]         `(p, account) => Promise<新令牌>`；不给就永不主动续期
 * @param {Function} [opts.tokenExpOf]      `(tok) => epoch ms | null`；不给就只认「没令牌」
 * @param {Function} [opts.onPersist]       续期成功后把新令牌写回配置用
 * @returns {Promise<object>} `{ok, accountId, token, ...}` 或 `{ok:false, reason, remedy, ...}`
 */
export async function wbPickAccount(cfg, p, opts = {}) {
  const now = Number(opts.now) || Date.now();
  wbClockNow = now;            // 亲和表的时间源跟着调用方走（见 wbClock 那段注释）
  const pool = wbPoolOf(cfg, p);
  if (!pool) {
    return { ok: false, reason: "empty", remedy: "这个渠道还没有配置块：到面板里配置一次。", total: 0, eligible: 0, pool: null };
  }

  /* 合成池 + 压根没令牌 → 报**改动前那句一字不差的话**，不给「已停用」之类的新解释。 */
  if (pool.synthetic && !pool.accounts[0].accessToken) {
    return { ok: false, reason: "no_token", remedy: null, total: 1, eligible: 0, pool };
  }

  /* 两个 key 空间：新那套（亲和层）与老那套（内存粘性）。
     默认同一个（老行为）；调用方显式分开时，各走各的。 */
  const sessionKey = opts.sessionKey == null ? null : String(opts.sessionKey);
  const stickyKey = opts.stickyKey === undefined
    ? sessionKey
    : (opts.stickyKey == null ? null : String(opts.stickyKey));

  /* ★ 选号**之前**先问亲和层（magpie 的顺序：亲和优先 → 手动 → 模式）。
   *    「这段对话归谁」由 session-store 判（「缓存值不值得留」），
   *    「那个号现在还能用吗」由池子判（内核的 unavailableReason）。
   *    两边都同意才用它；它用不了了才换，**绑定那边自己留着**（休息 ≠ 死）。 */
  const aff = sessionKey
    ? affinityPick(pool, p, sessionKey, stickyKey, now, opts.model)
    : { target: null, decided: false, blocked: false };

  /* strict 模式：这个会话宁可被它自己的号挡下，也不换人（magpie #1797）。
     报出来的是**那个号自己的原因**（池子给的），不另编词。 */
  if (aff.blocked) {
    const reason = aff.reason || "cooling";
    notePick(p, pool, { ok: false, reason, remedy: remedyOf(reason), accountId: aff.target, how: "strict", eligible: 0, now });
    return {
      ok: false, reason, remedy: remedyOf(reason),
      how: "strict", total: pool.accounts.length, eligible: 0, pool,
      accountId: aff.target,
    };
  }

  const r = acquire(pool, {
    version: p, model: opts.model, sessionKey: stickyKey, now,
    prefer: opts.prefer || null,
    affinityTarget: aff.target,
  });

  if (!r.ok) {
    /* ★ 失败原因**原样**来自池子。这里不做任何「从响应/文案反推」的加工，
       接线层也就没有反推的余地（规矩①）。 */
    notePick(p, pool, { ok: false, reason: r.reason, remedy: r.remedy || remedyOf(r.reason), accountId: null, how: r.how, eligible: r.eligible, now });
    return {
      ok: false, reason: r.reason, remedy: r.remedy || remedyOf(r.reason),
      how: r.how, total: pool.accounts.length, eligible: r.eligible || 0, pool,
    };
  }

  const acct = r.account;
  /* 条目存在但没填令牌：它**仍算在池子计数里**（面板必须显示出来，否则就成了
     「配置里有 3 个、界面只显示 2 个」那种说不清的落差），但**不参与选号**。
     这里按「停用」处理是内核的选择语义，面板上显示的却是诚实原因「未填令牌」。 */
  if (!acct.accessToken) {
    notePick(p, pool, { ok: false, reason: "no_token", remedy: NO_TOKEN_REMEDY, accountId: null, how: "no_token", eligible: r.eligible, now });
    return {
      ok: false, reason: "no_token", remedy: NO_TOKEN_REMEDY,
      how: "no_token", total: pool.accounts.length, eligible: r.eligible || 0, pool,
      accountId: acct.id,
    };
  }

  let token = acct.accessToken;
  const expOf = typeof opts.tokenExpOf === "function" ? opts.tokenExpOf : () => null;

  /* ★ 与改动前逐字一致的一条：**已经过期且没有刷新令牌**时，直接报「已过期，
     请重新捕获」，而不是把一枚明知过期的令牌发出去换一个 401。
     （改动前 wbEnsureToken 就是这么判的；漏掉这一段，老用户令牌彻底过期之后
     会从「一句话说清」退化成「上游 401 + 一段猜谜」。） */
  const expMs = expOf(token);
  /* ⚠ 单位契约：opts.tokenExpOf **必须返回 epoch 毫秒**（wb-token.mjs 的 wbTokenExp
     已经乘过 1000）。这里跟 now 比、跟 tokenExpiring 的 120000 比，都是毫秒。
     v1.0.76 迁移这段时把旧代码里的 `* 1000` 丢了，而注入的解码器返回秒，
     于是 `1.79e9 <= 1.79e12` 恒真 —— 每一枚令牌都被判成已过期。
     scripts/wb-token-test.mjs 把真 wbTokenExp 接进这条路径，专门钉住它。 */
  if (Number.isFinite(expMs) && expMs <= now && !acct.refreshToken) {
    const reason = "expired";
    const remedy = "这枚访问令牌已经过期，而它没有配套的刷新令牌：到 WorkBuddy 桌面端重新登录并重新捕获一次。";
    notePick(p, pool, { ok: false, reason, remedy, accountId: acct.id, how: "expired", eligible: r.eligible, now, model: opts.model });
    return {
      ok: false, reason, remedy, accountId: acct.id,
      how: "expired", total: pool.accounts.length, eligible: r.eligible || 0, pool,
      status: 401,
    };
  }

  /* 临近过期且有刷新令牌 → 先续期再发。**续期失败要按刷新路径回灌**（规矩②）。 */
  if (acct.refreshToken && tokenExpiring(expOf(token), now) && typeof opts.refresh === "function") {
    try {
      token = await opts.refresh(p, acct);
      acct.accessToken = token;
      /* 凭据时刻：池子排序靠它（wb-pool 的新鲜度判据）。续期成功 = 上游确实动过这枚凭据，
         所以 lastRefreshTime 记**现在**——这正是内核文档里说的「一次新鲜捕获会立刻清掉判死标记」。 */
      acct.credential = { ...(acct.credential || {}), lastRefreshTime: now };
      if (acct.dead) { acct.dead = false; acct.deadAt = null; acct.deadWhy = null; acct.deadPhrase = null; }
      acct.cooldownUntilMs = 0; acct.quotaUntilMs = 0;
      if (typeof opts.onPersist === "function") opts.onPersist(p, acct, token);
    } catch (e) {
      const fed = wbNoteRefreshFailure(cfg, p, e, { accountId: acct.id, now });
      const st = wbUnusableStatus("dead");
      return {
        ok: false,
        reason: fed && fed.failure ? fed.failure.dead ? "dead" : (fed.failure.kind || "refresh_failed") : "refresh_failed",
        remedy: fed && fed.failure ? remedyOf(fed.failure.dead ? "dead" : (fed.failure.kind === "quota" ? "quota" : "cooling")) : null,
        refreshError: redact(String((e && e.message) || e), 160),
        accountId: acct.id,
        total: pool.accounts.length, eligible: 0, pool,
        status: st,
      };
    }
  }

  acct.lastUsedAt = now;
  notePick(p, pool, { ok: true, accountId: acct.id, how: r.how, eligible: r.eligible, bound: !!r.bound, now, model: opts.model });
  return {
    ok: true, accountId: acct.id, account: acct, token, pool,
    how: r.how, bound: r.bound === true, preferSkipped: r.preferSkipped === true,
    total: pool.accounts.length, eligible: r.eligible || 0,
  };
}

const NO_TOKEN_REMEDY = "这个账号还没填访问令牌——到面板把它填上（或重新捕获一次）就会自动回到池子里。";
/** 模型级冷却的面板措辞。与内核 cooling_model 的指引同一件事、同一层意思。 */
const REASONS_MODEL_COOL = "这几个模型正在冷却（限流等一会就好）：同一个账号换别的模型照常可用，也可以等冷却到点自动恢复。";

/** 记下「本次选号发生了什么」，面板的「本次被跳过」读它。 */
function notePick(p, pool, info) {
  const rt = wbRuntime.get(p);
  const model = info.model == null ? null : String(info.model);
  const now = info.now || 0;
  /* 被跳过 = 本次选号时**在这个模型上不可用**的那些条目。判据仍然是 unavailableReason，
     不是「它是不是被选中的那一个」——后者会把「本次没轮到它」也算成跳过，那是两回事。 */
  const skipped = [];
  for (const a of pool.accounts) {
    if (a.id === info.accountId) continue;
    const r = unavailableReason(pool, a.id, now, model);
    if (!r.available) skipped.push({ id: a.id, label: a.label == null ? a.id : String(a.label), reason: r.reason, remedy: r.remedy });
  }
  if (rt) rt.last = { ...info, at: now, skipped, total: pool.accounts.length };
}

/* ==========================================================================
 * ② 失败回灌
 * ========================================================================== */

/**
 * 把一次上游答复喂给池子（模型请求路径）。
 *
 * ⚠ 这里**不返回任何「这个号是不是坏了」的结论给调用方拼文案**——
 * 返回的是内核自己的结构化结果，措辞由 {@link remedyOf} 给。
 *
 * ★ **判死的那一支会顺带把会话亲和永久解绑**（`forgetTarget`）：
 * 粘在一个凭据已死的号上的会话，继续往那儿发就是往一个**注定失败**的号发
 * （还会白等它的超时）。而「额度用尽」「冷却中」**不解绑**——那些号等会儿
 * 还能用，解绑等于白白丢掉已经建好的缓存（休息 ≠ 死）。
 */
export function wbNoteFailure(cfg, p, o) {
  const pool = wbPoolOf(cfg, p);
  if (!pool || !o || !o.accountId) return null;
  const res = applyFailure(pool, {
    accountId: o.accountId,
    model: o.model == null ? null : o.model,
    status: o.status == null ? null : o.status,
    text: o.text == null ? "" : o.text,
    headers: o.headers,
    now: Number(o.now) || Date.now(),
    /* 模型请求路径**永远不传 refresh**——内核因此只认 401/403，判死只认那两条文案。
       放宽到 400 的只有下面那一个函数。 */
    context: "model",
  });
  if (res && res.failure && res.failure.dead === true) forgetAffinityTarget(p, o.accountId);
  return res;
}

/**
 * ★★ **刷新路径的唯一入口**，也是全仓库唯一传 `context:"refresh"` 的地方。
 *
 * 为什么单独一个函数而不是在 {@link wbNoteFailure} 里加个参数：
 * 内核的文档明确交代「刷新接口回的是 400 而不是 401」。漏传这个 context，
 * 一次真实的凭据吊销会落进 `content` 类（400 + CONTENT_PATTERNS 不匹配时）——
 * **死号永远留在池子里烧重试**，而用户什么都看不出来。
 *
 * 做成两个函数而不是一个布尔开关，就是为了让「该传的地方传了」这件事
 * 在源码里**看得见**：grep context: "refresh" 只会命中这一处，
 * 少传一眼看得出来，多传一处反而危险（模型请求路径绝不能放宽到 400）。
 *
 * @param {Error & {status?:number, text?:string, headers?:any}} err 刷新抛出的错误
 */
export function wbNoteRefreshFailure(cfg, p, err, opts = {}) {
  const pool = wbPoolOf(cfg, p);
  if (!pool) return null;
  const accountId = opts.accountId
    || (pool.accounts[0] && pool.accounts[0].id)
    || null;
  if (!accountId) return null;
  const res = applyFailure(pool, {
    accountId,
    model: null,
    status: err && err.status != null ? err.status : null,
    text: (err && (err.text || err.body)) || (err && err.message) || "",
    headers: err && err.headers,
    now: Number(opts.now) || Date.now(),
    context: "refresh",            // ★★★ 全仓库唯一一处
  });
  /* 刷新路径判死 = 登录态真的被拒了 → **永久解绑**那些粘在它上面的会话。
     （模型请求路径上判死也走同一支：两条路判出来的「死」是同一件事。） */
  if (res && res.failure && res.failure.dead === true) forgetAffinityTarget(p, accountId);
  return res;
}

/* ==========================================================================
 * ③ 面板可见（⑤ 计数必须与遍历到的账号数一致）
 * ========================================================================== */

/** reason → 面板上那一格的中文标签。**渲染层不认渠道名，也不认 reason 码。** */
export const WB_REASON_LABEL = {
  ok: "可用",
  dead: "登录态被判死",
  quota: "额度用尽",
  cooling: "冷却中",
  cooling_model: "该模型冷却中",
  disabled: "已停用",
  ignored: "已移出",
  stale: "可用（凭据很久没刷新）",
  no_token: "未填访问令牌",
  expired: "令牌已过期且无法续期",
  empty: "池子是空的",
  unknown_account: "池子里没有这个账号",
};

/** 面板文案：一个账号的完整状态。`token` 一律走指纹，绝不回显凭据。 */
function accountFields(pool, a, now, model, fingerprint) {
  const r = unavailableReason(pool, a.id, now, model);
  const noTok = !a.accessToken;
  /* 没有令牌的条目：内核只会说「停用」，这里如实改成「未填令牌」——
     用户看到的必须是他能执行的那句话，而两者的处置完全不同。 */
  let reason = noTok && r.available ? "no_token" : r.reason;
  let remedy = noTok && r.available ? NO_TOKEN_REMEDY : r.remedy;
  let available = r.available && !noTok;

  /* 模型级冷却：内核的 unavailableReason 只在**指定了模型**时才报 cooling_model，
     而面板这一次要展示的是「这个号整体怎么样」。所以这里另扫一遍 modelCooldowns：
     整号可用、但有几个模型在冷却时，如实说「这几个模型在冷却」而不是笼统的「可用」——
     否则用户看到绿灯、点下去却还是 429。 */
  const coolingModels = [];
  const mc = a.modelCooldowns && typeof a.modelCooldowns === "object" ? a.modelCooldowns : {};
  for (const k of Object.keys(mc)) if ((Number(mc[k]) || 0) > now) coolingModels.push(k);
  if (available && coolingModels.length && (model == null || !coolingModels.includes(String(model)))) {
    reason = "cooling_model";
    remedy = `${REASONS_MODEL_COOL}（当前：${coolingModels.join("、")}）`;
    available = false;
  }

  const untilMs = r.untilMs;
  return {
    id: a.id,
    no: pool.accounts.indexOf(a) + 1,
    label: a.label == null ? a.id : String(a.label),
    version: a.version == null ? pool.version : String(a.version),
    synthetic: a.synthetic === true,
    available,
    reason,
    reasonLabel: WB_REASON_LABEL[reason] || reason,
    coolingModels,
    scope: r.scope,
    until: untilMs == null ? null : new Date(untilMs).toISOString(),
    retryAfterMs: r.retryAfterMs == null ? null : r.retryAfterMs,
    stale: r.stale === true,
    recoveredBy: noTok && reason === "no_token" ? "fill" : (reason === "cooling_model" ? "wait" : r.recoveredBy),
    remedy,
    why: r.why,
    lastFailure: a.lastFailure ? { kind: a.lastFailure.kind, at: a.lastFailure.at } : null,
    token: fingerprint(a),
    freshness: (() => { const f = credentialFreshness(a, now); return { basis: f.basis, trusted: f.trusted, ageMs: f.ageMs, stale: f.stale }; })(),
  };
}

/**
 * 面板状态。**`total` 恒等于遍历到的账号条数**——
 * dsh-xdpool 作者的教训是「磁盘 4 个文件、界面 2 个账号」，那种落差用户是说不清的，
 * 所以这里刻意让计数与列表由**同一个数组**算出来，而不是各数一遍。
 *
 * @param {Function} [fp] 指纹函数（server.mjs 的 keyFp，与「凭据」页那三把 key 同一套）。
 *   **不给就用不可逆的默认**：本模块的默认值不许回显令牌的任何一段——
 *   redact 是给错误文案用的，对一枚 12 位的短令牌它会原样放过，
 *   而「面板上显示令牌前 8 位」这种事一旦发生就是红线破了。
 */
export function wbPoolStatus(cfg, p, now, opts = {}) {
  const pool = wbPoolOf(cfg, p);
  if (!pool) return null;
  const t = Number(now) || Date.now();
  const fp = typeof opts.fingerprint === "function"
    ? opts.fingerprint
    : (a) => (a && a.accessToken ? `已配置（${String(a.accessToken).length} 位）` : "未配置");
  const model = opts.model == null ? null : String(opts.model);
  const accounts = pool.accounts.map((a) => accountFields(pool, a, t, model, fp));

  const counts = { total: accounts.length, ok: 0, cooling: 0, cooling_model: 0, quota: 0, dead: 0, disabled: 0, ignored: 0, no_token: 0, stale: 0 };
  for (const a of accounts) {
    if (a.available && a.stale) counts.stale++;
    if (a.available) counts.ok++;
    else if (counts[a.reason] != null) counts[a.reason]++;
  }
  const rt = wbRuntime.get(p);
  const last = rt && rt.last ? rt.last : null;
  const held = last && last.ok ? stickyHold(p, last.accountId) : 0;

  return {
    version: pool.version,
    mode: pool.mode,
    /** 单条目池 = 老配置，行为与池化之前逐字一致；面板据此说明「还没用上多账号」。 */
    synthetic: pool.synthetic === true,
    total: counts.total,
    counts,
    accounts,
    heldSessions: held,
    /* 会话亲和（持久化那套）的状态。**不含任何凭据**，也不含本机绝对路径。 */
    affinity: {
      mode: wbAffinityMode,
      sessions: wbAffinity.has(p) ? wbAffinity.get(p).size : 0,
      persist: affinityPersistOn(),
    },
    last: last ? {
      at: last.at, ok: last.ok === true, accountId: last.accountId || null,
      label: last.accountId ? ((pool.accounts.find((a) => a.id === last.accountId) || {}).label || last.accountId) : null,
      how: last.how || null, eligible: last.eligible || 0, total: last.total == null ? counts.total : last.total,
      reason: last.ok === true ? null : (last.reason || null),
      reasonLabel: last.ok === true ? null : (WB_REASON_LABEL[last.reason] || last.reason || null),
      remedy: last.ok === true ? null : (last.remedy || null),
      skipped: Array.isArray(last.skipped) ? last.skipped : [],
    } : null,
    hint: pool.synthetic
      ? "当前是单账号（改动前的状态）：只有一个令牌，池化对它没有任何行为差异。加第二个账号到这一格才会开始轮换。"
      : `${counts.ok}/${counts.total} 个账号可用。同一段对话会一直粘在同一个账号上（保住上游的 prompt 缓存），只有它用不了才换。`
        + "冷却与判死是本机运行期状态，不写进 config.json，重启本程序会重新计；"
        + "真要救回一个死号，去 WorkBuddy 桌面端重新登录它。",
  };
}

/**
 * 有几段对话正粘在这个账号上（面板显示「N 段对话」用；不显示凭据，只显示条数）。
 *
 * ★ **两套都数，取并集**：新那套（持久化亲和层）与老那套（内存 LRU）里
 * 同一条会话只算一次 —— 它们记的是同一段对话，数两遍就成了「面板说有 3 段，
 * 其实只有 2 段」那种说不清的落差。
 */
function stickyHold(p, accountId) {
  if (!accountId) return 0;
  const keys = new Set();
  const m = wbSticky.get(p);
  if (m) for (const [k, v] of m) if (v === accountId) keys.add(k);
  const st = wbAffinity.get(p);
  if (st) for (const e of st.entries()) if (e && e.target === accountId) keys.add(e.key);
  return keys.size;
}

/* ==========================================================================
 * ④ 429 时点名同名付费行（⑥）
 * ========================================================================== */

/** "x0.79" / "0.79" / 0.79 → 数字；认不出来返回 null。 */
function creditsRate(c) {
  const v = parseFloat(String(c == null ? "" : c).replace(/^x/i, ""));
  return Number.isFinite(v) ? v : null;
}

/**
 * 同一个模型被限流时，**按显示名**在映射表里找同名的付费行。
 *
 * ## 为什么按显示名而不是按 id 前缀
 *
 * 用户在面板上认的是**显示名**（映射表那一列），不是 id。id 前缀（`hy4-` 与
 * `hy4-preview-f` 那一类）是上游的内部命名，改一次名就全废，而且用户根本看不见它。
 * 要回答「我该点哪一行」，唯一的稳定锚点就是用户眼前那串字。
 *
 * ## 为什么点名「付费」那一行
 *
 * 429 是免费档模型的**频率**限制（实测见 wbAdvanceModel 那段注释），
 * 而付费模型用同一枚令牌直接 200。所以能救场的动作是「换成付费档」，
 * 而说得清这件事只有一句：「你点的这个名字，同一格里还有个付费的，点它」。
 *
 * @param {object} o
 * @param {string} o.limitedModel 刚被限流的模型 id
 * @param {Array<{tier:string,target:string,label:string}>} o.rows 映射表的四行
 * @param {Array<{id:string,credits?:any,free?:boolean}>} o.catalog 倍率目录
 * @returns {{label:string, rows:Array, text:string}|null}
 */
export function wbPaidSameName(o = {}) {
  const limited = String(o.limitedModel || "");
  if (!limited) return null;
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const catalog = Array.isArray(o.catalog) ? o.catalog : [];
  const byId = new Map(catalog.map((m) => [String(m.id), m]));

  const hitRows = rows.filter((r) => r && String(r.target) === limited);
  if (!hitRows.length) return null;

  const paid = [];
  const seen = new Set();
  for (const r of hitRows) {
    const label = String(r.label == null ? r.target : r.label);
    for (const c of rows) {
      if (!c || String(c.target) === limited) continue;
      if (String(c.label == null ? c.target : c.label) !== label) continue;   // ★ 按显示名匹配
      const m = byId.get(String(c.target)) || {};
      const rate = creditsRate(m.credits);
      /* 「付费」= 目录明确给了倍率且 > 0，或明确不是 free。倍率读不出来就不点名——
         猜一次倍率等于让用户花冤枉钱，而这里本来就是给人一个可选动作。 */
      const isPaid = m.free === true ? false : (rate != null ? rate > 0 : false);
      if (!isPaid) continue;
      const key = `${c.tier}|${c.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      paid.push({ tier: String(c.tier), target: String(c.target), label, credits: m.credits == null ? null : String(m.credits), free: false });
    }
  }
  if (!paid.length) return null;
  const label = String(hitRows[0].label == null ? limited : hitRows[0].label);
  const where = paid.map((x) => `${x.tier} 行的「${x.label}」（${x.target}，倍率 ${x.credits}）`).join("、");
  return {
    label,
    rows: paid,
    text: `被限流的只是「${label}」这一档的免费额度，同名的付费档用同一枚令牌不受影响：可以改到 ${where} —— 点那一行的下拉换过去即可，不用改任何配置。`,
  };
}

/** 从 cfg 的 mapping 里取出四行（tier / target / label），供 {@link wbPaidSameName} 用。 */
export function wbMappingRows(slice) {
  const m = (slice && slice.mapping) || {};
  return Object.keys(m).map((tier) => {
    const v = m[tier] || {};
    return { tier, target: String(v.target == null ? "" : v.target), label: String(v.label == null ? (v.target || tier) : v.label) };
  });
}

export { redact };