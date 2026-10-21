/**
 * candidates.mjs —— provider-agnostic 的「候选层」内核
 * （纯逻辑、零依赖、零 IO、零时钟）
 *
 * ## 它解决什么
 *
 * bai-router 原来有两套「换一家」的逻辑：
 *   · failover.mjs —— **通用但粗**：冷却只到 provider 级、两档（90s / 30min）、
 *     判定只看状态码、不看响应体；
 *   · wb-pool.mjs —— WorkBuddy 账号池专用的那套**已经写对**的：失败分类看响应体、
 *     两级休息（账号级 / 模型级）、退避。
 *
 * 本模块把后者**提取**成 provider-agnostic 的层，让所有 provider 都能骑上去。
 * 它照抄 magpie（yetone/magpie）的候选层，不是重新发明：
 *   internal/gateway/fallback.go —— restKey()/restID()、failure()、两级休息
 *   internal/gateway/routing.go  —— 冷却时长表、退避公式、失败分类的正则表
 *
 * ## magpie 的三条核心语义（照抄）
 *
 * 1. **候选粒度 = 账号/密钥级**（不是 provider 级）。
 *    一个 provider 有多个订阅账号或多个密钥时，每个账号/密钥是**独立的候选**，
 *    失败也只休息它自己。见 {@link restKeyOf}。
 *
 * 2. **两级休息**：
 *      restKey = "provider@user"（没有账号时就是 "provider"）→ **整号休息**，
 *                这一号的所有模型都停；
 *      restID  = restKey + "/" + model              → **只休息这一个模型**，
 *                同账号的其它模型照常可用。
 *    这正是 magpie 的 restKey()/restID()（fallback.go:102 / :124）。
 *
 * 3. **失败分类看响应体**（不只看状态码）：magpie 的 failure(status, body)
 *    有十几条正则，归成 credit/quota/rate/auth/content/unserved/other。
 *    其中最要紧的一条：**unserved（这家不服务这个模型）只休息那个模型**，
 *    不牵连整号（magpie 的 modelRefused，fallback.go:1057）。
 *
 * ## 边界（刻意不做的事）
 *
 *   · **不 import routes.mjs** —— 策略由调用方传进来（{@link orderCandidates} 收
 *     一个 strategy 对象），免得这一层反过来依赖策略点。
 *   · **不读磁盘、不联网、不取 Date.now()** —— 时间一律由参数传入（opts.now），
 *     这样整个模块是纯函数、可测、可回放。
 *   · **不决定「换谁」** —— 那是调用方与 routes.mjs 的事。本模块只回答三件事：
 *     「这次失败是什么性质」「要休息谁」「休息多久」。
 *   · **不写盘、不记日志** —— 失败原因怎么落盘、怎么上报，交给调用方。
 */

/* ====================================================================== *
 * 常量：冷却时长表（照抄 magpie internal/gateway/routing.go:154-186）
 * ====================================================================== */

/**
 * 退避的第一档：1 分钟（magpie 的 fallbackCooldown）。
 *
 * 为什么是 1 分钟：一次故障不该让每条请求都先等一遍死渠道的超时 ——
 * 冷却期让一次故障只付一次超时代价。
 */
export const FALLBACK_COOLDOWN_MS = 60 * 1000;

/**
 * credit（账号没钱了）休息 30 分钟（magpie 的 creditRest）。
 *
 * 等多久都不会自己好：余额不会因为时间流逝长回来，只有充值或官方重置才回得来。
 */
export const CREDIT_REST_MS = 30 * 60 * 1000;

/**
 * quota（套餐额度用尽）休息 15 分钟（magpie 的 quotaRest）。
 *
 * 比 credit 短一档：套餐额度通常有周期重置（每日/每周），15 分钟后探一次
 * 代价可以忽略，且官方真重置了不用等太久。
 */
export const QUOTA_REST_MS = 15 * 60 * 1000;

/**
 * auth（凭据被判死）休息 30 分钟（magpie 的 verifyRest/dead 档）。
 *
 * 这半小时的语义是「别让一次请求把重试预算全喂给这个死号」，
 * **不是**「半小时后它活了」—— 等再久也不会自己好，必须重新登录/重新授权。
 */
export const AUTH_REST_MS = 30 * 60 * 1000;

/**
 * 最长可信的「上游说多久后再试」（magpie 的 longestWait）。
 *
 * 上游偶尔会报出一个离谱的时刻（时区写错、秒当毫秒）。无上限地信它 =
 * 一个坏的时间戳能让整个池子停摆一小时以上，所以 **1 小时封顶**。
 */
export const LONGEST_WAIT_MS = 60 * 60 * 1000;

/**
 * 「上游说了额度什么时候回来」的最长可信值（magpie 的 longestQuota）。
 *
 * 8 天 = 一周窗口再加一天余量。magpie 的注释写得很直白：一个把 /usage 的
 * 日期读错一年的值，会让账号一直坐到有人发现为止。
 */
export const LONGEST_QUOTA_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * 退避的封顶（magpie 的 longestRetry）：一连失败就退避到 10 分钟为止。
 *
 * 再往上加没有意义：睡 30 分钟不叫退避，叫把账号忘了。
 */
export const LONGEST_RETRY_MS = 10 * 60 * 1000;

/**
 * 限流之后多久算「新的一次」（magpie 的 rateForget）。
 *
 * 限流窗口过去很久之后又限一次，那是新的一次，重新从 1 分钟起算；
 * 不这样的话，一个偶发限流的账号会一路退避到 10 分钟再下不来。
 */
export const RATE_FORGET_MS = 30 * 60 * 1000;

/** 失败分类的七种（magpie 的 failCredit/failQuota/failRate/failAuth/failOther + bai-router 的两类）。 */
export const KINDS = ["credit", "quota", "rate", "auth", "content", "unserved", "other"];

/** 休息的作用域：整号 / 只这个模型 / 谁也不休息。 */
export const SCOPES = ["account", "model", "none"];

/* ====================================================================== *
 * 失败分类的正则表（照抄 magpie）
 * ====================================================================== */

/**
 * 「额度用尽」或「慢下来」的措辞（magpie 的 quotaWords，fallback.go:1036）。
 *
 * ⚠ 这是**宽口径**的表：它同时装着「没钱了」「额度用完了」「太频繁了」，
 * 因为 magpie 在「没有状态码可依据」时只需要知道「这家说它不行」。
 * 要**分类**成 credit/quota/rate，用下面三张更细的表。
 *
 * 导出它是为了让别处也能用同一口径问一句「这家说它不行吗」；
 * ⚠ 但**不要**拿它当「模型不被服务」的护栏（见 {@link saysQuota} 的说明）。
 */
export const QUOTA_WORDS = /quota|insufficient|balance|credit|billing|out of budget|budget (exceeded|exhausted)|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i;

/**
 * 「这个号没钱了」（magpie 的 creditWords，routing.go:190）。
 * 余额/欠费/充值/billing/payment/arrear/overdue/suspended。
 */
const CREDIT_WORDS = /insufficient.?(balance|credit|fund)|balance|credit|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.*(不足|停)/i;

/**
 * 429 里说「余额真的花完了」（magpie 的 brokeWords，routing.go:196）。
 *
 * 为什么单独一张表：magpie 把「429 + 出现 credit 字样」判成 credit 是**有条件的**
 * —— 必须同时命中这张表。因为 429 的英文文案里常混着 credit 字样却只是限流，
 * 一刀切会把限流误判成没钱了。
 */
const BROKE_WORDS = /insufficient.?(balance|credit|fund)|\bcredits? (are )?exhausted\b|余额不足|欠费|请充值/i;

/**
 * 「套餐里的额度用完了」（magpie 的 usedUpWords，routing.go:198）。
 * quota/usage limit/out of budget/limit reached/额度/用量/套餐/上限。
 */
const USED_UP_WORDS = /quota|usage.?limit|out of budget|budget (exceeded|exhausted)|limit.?reached|hit your .*limit|limit.{0,24}resets|exceeded.*(plan|limit)|额度|用量|套餐|上限/i;

/**
 * 「你太频繁了」（magpie 的 rateWords，routing.go:204）。
 * rate limit / too many requests / 每秒每分钟 / rpm / 频率 / 太频繁。
 */
const RATE_WORDS = /rate.?limit|too many requests|per.?(second|sec|minute|min)\b|\b[rt]pm\b|频率|太频繁/i;

/**
 * 「本期的额度用完了」（magpie 的 plannedWords，routing.go:209）。
 * 每日/每周/每月额度、"limit reached"、"限额已用完"……
 *
 * 为什么单独一张表：magpie 的 429 判定里，「rate 字样」与「本期额度」是**相反**的
 * 两种意思（一个会自己好，一个要等重置），而很多厂商把两者写在同一句里。
 */
const PLANNED_WORDS = /quota|usage.?limit|hit your .*limit|limit.{0,24}resets|per.?(day|week|month)|daily|weekly|monthly|额度|用量|套餐|限额已用完/i;

/**
 * 「这家不服务这个模型」（magpie 的 unservedWords，fallback.go:1048）。
 *
 * ⚠ 必须与「额度」措辞互斥（magpie 的 modelRefused：`unserved && !quota`）——
 * 一条消息里同时说了「模型不支持」和「额度用完」，那是**额度**问题（整号），
 * 不是模型问题（只休息那个模型）。判错方向会把整个账号停掉。
 */
const UNSERVED_WORDS = /model.{0,80}(not (supported|accessible|available|found|enabled|allowed)|unsupported|does ?n[o']t exist|unknown|invalid)|(no such|unknown|invalid|unsupported) model|model_not_found|模型.{0,12}(不存在|不支持|无权|未开通)/i;

/**
 * 「说得确实像额度问题」——用**窄**口径的额度措辞。
 *
 * ⚠ 为什么不用 magpie 那张宽口径的 quotaWords 当护栏：它带着一个裸的
 *   "exceeded"，而 "exceeded" 在正文里太常见了（"exceeded: model not supported"）。
 *   用它当护栏会把大半个「模型不被服务」都吞成额度问题 —— 判错方向是把
 *   整个账号停掉，代价大得多。
 *   窄口径只认真正在谈额度的那几张表（用量/上限/本期额度/余额）。
 */
function saysQuota(body) {
  return USED_UP_WORDS.test(body) || PLANNED_WORDS.test(body)
    || CREDIT_WORDS.test(body) || BROKE_WORDS.test(body);
}


/**
 * 「这家不接这个客户端」（magpie 的 refusedWords，fallback.go:1128）。
 *
 * magpie 把它叫 failPrompt：供应商拒的是**客户端**（WorkBuddy 的
 * "Illegal API invocation from an unapproved channel"），不是账号、不是模型。
 * 处置是「换一家有用，谁也不休息」。
 */
const REFUSED_WORDS = /unapproved channel|illegal api invocation/i;

/**
 * bai-router 实测追加的一句（WorkBuddy AI / MiniMax 会员都回它）。
 *
 * 同属 failPrompt 家族：供应商明说「这个请求我不接」，换一家有用。
 * 2026-10-21 实测：它出现在倒数第二个渠道上，却因为「400 不转移」直接终结了
 * 整条链，最后一个渠道根本没被试。
 */
const REQUEST_ILLEGAL_RE = /request illegal/i;

/**
 * 5xx 里说「这是额度问题」（magpie 的 quotaCodes，routing.go:241）。
 *
 * ⚠ 刻意**不抄** magpie 的 `\d{10}\b`：一串 10 位数字不是证据（magpie 用它
 * 是为了从 Claude Code 的「usage limit reached|<时间戳>」那一行里抠出重置时刻，
 * 那是另一处解析）。这里只留真正的代码/短语。
 */
const QUOTA_CODES = /usage_limit_reached|RESOURCE_EXHAUSTED|limit reached/i;

/**
 * 凭据被判死的措辞。
 *
 * 前两条是 wb-pool.mjs 已经在生产里验证过的（DEAD_PHRASES）：上游亲口说的。
 * 其余是同类明说凭据失效的常见措辞 —— 一律要求**明说**，宁可漏判也不误判：
 * 误判的代价是用户的号永久掉出池子，而漏判只是多冷却一次。
 */
const DEAD_PHRASES = [
  "invalid_grant",
  "offline user session not found",
  "invalid api key",
  "invalid_api_key",
  "incorrect api key",
  "invalid authentication",
  "token expired",
  "expired_token",
  "account suspended",
  "account has been suspended",
  "密钥无效",
  "密钥已失效",
  "令牌已过期",
  "登录已过期",
  "账号已被封禁",
  "账号不存在",
];

/**
 * 上游说了「什么时候回来」（magpie 的 resetsWhen，routing.go:220）。
 *
 * 只认「重置」措辞**紧挨着**一个带时区偏移的完整时刻的那种写法：
 * "将在 2026-10-11 20:16:02 UTC+8重置"。这样别家正文里顺带提一句日期
 * （"deprecated on …"）就不会被当成重置时刻。
 */
const RESETS_WHEN_RE = /(?:\bresets? at|将在|将于)\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})\s*(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?(?:\s*(?:重置|[,.;，。；]))/i;

/**
 * 「Try again in 23h 59m」这类相对时长（magpie 的 tryAgainIn，routing.go:235）。
 */
const TRY_AGAIN_IN_RE = /\btry again in (?:(\d+)\s*d(?:ays?)?\b\s*)?(?:(\d+)\s*h(?:ours?|rs?)?\b\s*)?(?:(\d+)\s*m(?:in(?:utes?|s)?)?\b)?/i;

/* ====================================================================== *
 * 小工具（纯函数）
 * ====================================================================== */

/**
 * 归一化时间戳 → epoch ms。认数字（秒/毫秒自动分辨）、数字串、ISO 串、Date。
 * 读不出就返回 null —— **读不出与「很旧」不是一回事**，调用方必须分开处理。
 */
function toMs(v) {
  if (v == null) return null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    // 1e11 ms ≈ 1973 年；epoch 秒（约 1.7e9）远小于它。阈值取在两者之间。
    return Math.round(v < 1e11 ? v * 1000 : v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return null;
    if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s));
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** HTTP 状态码归一化。拿不到（网络错误 / 没响应头）→ null，那本身就是一种失败。 */
function normalizeStatus(status) {
  if (typeof status === "number" && Number.isFinite(status) && status >= 100 && status <= 599) {
    return Math.trunc(status);
  }
  if (typeof status === "string" && /^\d{3}$/.test(status.trim())) return Number(status.trim());
  return null;
}

/**
 * 上游正文洗敏：**长**的凭据形态段整段抹掉，只留可读的骨架。
 *
 * 存在的理由不是洁癖：错误的 `why` 会被写进日志、面板、甚至错误响应体。
 * 上游偶尔会把请求里带的东西原样回显，而本模块拿到的是**完整响应体**。
 */
export function redact(text, max = 160) {
  let s = String(text == null ? "" : text);
  s = s.replace(/\b(?:sk|jt|oc_sk|api_key|apikey|bearer)[-_][A-Za-z0-9._~+/=-]{8,}/gi, "<凭据已抹除>");
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <凭据已抹除>");
  s = s.replace(/[A-Za-z0-9._~+/=-]{24,}/g, "<长串已抹除>");
  s = s.replace(/[\r\n\t]+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 从 headers（Headers / 普通对象 / Map 都认）里取一个头。 */
function headerGet(headers, name) {
  if (!headers) return null;
  const lower = String(name).toLowerCase();
  try {
    if (typeof headers.get === "function") { const v = headers.get(name); return v == null ? null : String(v); }
  } catch { /* 不是 Headers */ }
  if (typeof headers.forEach === "function" && typeof headers.get !== "function") {
    let out = null;
    headers.forEach((v, k) => { if (String(k).toLowerCase() === lower) out = String(v); });
    return out;
  }
  if (typeof headers === "object") {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) return String(headers[k]);
  }
  return null;
}

/**
 * 从上游答复里读「多久之后能再试」。三处来源：
 *   ① Retry-After 头（秒数或 HTTP-date）
 *   ② X-RateLimit-Reset / *ratelimit*reset* 头（epoch）
 *   ③ 正文里的 reset_at / retry_after 之类字段
 *
 * ⚠ **一律封顶 LONGEST_WAIT_MS（1 小时）**：magpie 的 longestWait。
 * 上游偶尔会报出一个离谱的重置时刻（时区写错、秒当毫秒），无上限地信它
 * 等于让一个坏时间戳把整个池子停摆一小时以上。
 *
 * @returns {number|null} 毫秒；读不到返回 null（**不是 0** —— 0 表示「立刻」）
 */
export function parseRetryAfterMs(headers, body, now = 0) {
  const ra = headerGet(headers, "retry-after");
  if (ra != null) {
    const s = Number(String(ra).trim());
    if (Number.isFinite(s) && s >= 0) return Math.min(Math.round(s * 1000), LONGEST_WAIT_MS);
    const t = Date.parse(String(ra));
    if (Number.isFinite(t)) return Math.min(Math.max(0, t - now), LONGEST_WAIT_MS);
  }
  // 各种 ratelimit-reset 头（OpenAI/Anthropic 那种）
  let reset = headerGet(headers, "x-ratelimit-reset");
  if (reset == null && headers && typeof headers.forEach === "function") {
    try {
      headers.forEach((v, k) => {
        const lk = String(k).toLowerCase();
        if (reset == null && lk.includes("ratelimit") && lk.includes("reset")) reset = String(v);
      });
    } catch { /* 不是可遍历的 headers */ }
  }
  if (reset != null) {
    const t = toMs(String(reset).trim());
    if (t != null) return Math.min(Math.max(0, t - now), LONGEST_WAIT_MS);
  }
  // 正文里的字段：reset_at/resets_at 是**绝对**时刻，retry_after/reset_after 是**相对**秒数
  const abs = /(?:reset_at|resetAt|resets_at|resetsAt)"?\s*[:=]\s*"?([0-9][0-9.]*)/i.exec(String(body || ""));
  if (abs) {
    const t = toMs(abs[1]);
    if (t != null) return Math.min(Math.max(0, t - now), LONGEST_WAIT_MS);
  }
  const rel = /(?:retry_after|retryAfter|reset_after|resetsIn|resets_in)"?\s*[:=]\s*"?([0-9][0-9.]*)/i.exec(String(body || ""));
  if (rel) {
    const n = Number(rel[1]);
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.round(n * 1000), LONGEST_WAIT_MS);
  }
  return null;
}

/**
 * 上游说了「额度什么时候回来」（绝对时刻）。
 *
 * 两个来源：magpie 的 resetsWhen（「将在 2026-10-11 20:16:02 UTC+8重置」）
 * 与 tryAgainIn（「Try again in 23h 59m」）。
 *
 * ⚠ 封顶 LONGEST_QUOTA_MS（8 天）：magpie 的 longestQuota —— 一个把日期读错
 * 一年的值会让账号一直坐到有人发现为止。
 *
 * @returns {number|null} epoch ms；没有就说 null
 */
export function parseResetAtMs(body, now = 0) {
  const s = String(body || "");
  const m = RESETS_WHEN_RE.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, sec, sign, oh, om] = m;
    const off = `${sign}${String(oh).padStart(2, "0")}:${String(om || "0").padStart(2, "0")}`;
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      + `T${String(h).padStart(2, "0")}:${mi}:${sec}${off}`;
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return Math.min(t, now + LONGEST_QUOTA_MS);
  }
  const r = TRY_AGAIN_IN_RE.exec(s);
  if (r) {
    const d = Number(r[1] || 0), h = Number(r[2] || 0), mi = Number(r[3] || 0);
    if (d || h || mi) {
      return now + Math.min((d * 24 + h) * 60 * 60 * 1000 + mi * 60 * 1000, LONGEST_QUOTA_MS);
    }
  }
  return null;
}

/** 正文里命中了哪个判死措辞（用于日志与 why，不含凭据）。 */
export function matchedDeadPhrase(body) {
  const s = String(body || "").toLowerCase();
  for (const p of DEAD_PHRASES) if (s.includes(p.toLowerCase())) return p;
  return null;
}

/* ====================================================================== *
 * ① 失败分类
 * ====================================================================== */

/**
 * 把一次上游答复归到七类之一，并给出**结构化的处置指令**。
 *
 * 核心是 magpie 的 failure(status, body)（internal/gateway/routing.go:350）：
 * **同时看状态码与响应体**。只有正文**明说**了拒绝理由，才归到对应的类；
 * 正文含糊的，一律按最保守的方式处理。
 *
 * 返回值里每个字段的硬约定：
 *
 *   · `kind` —— 七类之一（{@link KINDS}）。
 *   · `scope` —— 休息写在哪一层：
 *       `"account"` 整号休息（这一号的所有模型都停）；
 *       `"model"`   只休息这一个模型（同号其它模型照常用）；
 *       `"none"`    谁也不休息（请求本身有问题，换谁都一样）。
 *   · `dead` —— **只有 kind==="auth" 且上游明说凭据失效时才可能为 true**。
 *     401/403 本身绝不足以判死：网络抖动、令牌临时异常、上游网关抽风都打 401，
 *     一刀切判死会把好账号永久踢出池子（wb-pool.mjs 记的 1.7.7 事故形态）。
 *   · `failover` —— 换一家有没有用。content 类是 false（请求本身有问题，
 *     换几家都一样失败，只会白耗别家的额度还把真实报错埋掉）。
 *   · `retryAfterMs` —— 上游说的「多久后再试」。**只对 rate/quota 有意义**。
 *   · `resetAtMs` —— 上游说的「额度什么时候回来」。只对 quota 有意义。
 *
 * @param {number|string|null} status HTTP 状态码；null/非数值 = 没拿到响应（网络错误）
 * @param {string} text 上游响应正文（只用于识别，输出里会被 redact 洗过）
 * @param {{headers?:any, now?:number}} [opts]
 * @returns {{kind:string, dead:boolean, scope:string, failover:boolean,
 *            retryAfterMs:number|null, resetAtMs:number|null,
 *            why:string, evidence:string|null, label:string|null}}
 */
export function classifyFailure(status, text, opts = {}) {
  const now = toMs(opts.now) ?? 0;
  const body = String(text == null ? "" : text);
  const st = normalizeStatus(status);
  const headers = opts.headers;

  const base = {
    kind: "other", dead: false, scope: "none", failover: false,
    retryAfterMs: null, resetAtMs: null, why: "", evidence: null, label: null,
  };

  /* ① 不是失败（2xx/3xx）：不该走到这里，但真走到了也不能当成失败去休息谁。 */
  if (st !== null && st < 400) {
    return { ...base, why: `HTTP ${st} 不是失败，不休息任何人。` };
  }

  /* ② 压根没拿到 HTTP 答复：网络错误 / 超时 / 连接被重置。
   *    magpie 把这类算 failOther（走默认那档：一分钟退避，休息 restKey）。 */
  if (st === null) {
    return {
      ...base, kind: "other", scope: "account", failover: true,
      why: "网络/连接层失败（没拿到上游答复）：这跟账号本身没关系，但按 magpie 的口径它也算一次失败——"
        + "退避冷却，免得每条请求都先撞一遍这个死地址。",
      evidence: redact(body) || null,
    };
  }

  /* ③ 5xx：上游自己坏了。判死等于把所有账号一次冤杀。
   *    例外：正文里带着上游自己的额度代码（usage_limit_reached / RESOURCE_EXHAUSTED），
   *    那是「额度用尽」而不是「服务故障」。 */
  if (st >= 500) {
    if (QUOTA_CODES.test(body)) {
      return {
        ...base, kind: "quota", scope: "account", failover: true,
        why: `HTTP ${st} 但正文带着上游的额度代码（usage_limit_reached / RESOURCE_EXHAUSTED）：`
          + "这是「额度用尽」而不是「服务故障」，整号长冷却。",
        evidence: redact(body),
      };
    }
    return {
      ...base, kind: "other", scope: "account", failover: true,
      why: `上游自身故障（HTTP ${st}）：不是账号的问题，按退避冷却（1 分钟起，连着失败越来越久，最多 10 分钟）。`,
      evidence: redact(body),
    };
  }

  /* ④ 402：定义上就是「额度用尽」。magpie 的细分：说了「用量上限」却没提钱
   *    → 是套餐池（quota，15 分钟）；否则是没钱了（credit，30 分钟）。 */
  if (st === 402) {
    const quotaPhrase = USED_UP_WORDS.test(body);
    const creditPhrase = CREDIT_WORDS.test(body);
    const insufficientQuota = body.toLowerCase().includes("insufficient_quota");
    if (quotaPhrase && !creditPhrase && !insufficientQuota) {
      return {
        ...base, kind: "quota", scope: "account", failover: true,
        why: "HTTP 402 且正文说的是套餐用量/上限（没提钱）：按「额度用尽」处理，整号冷却 15 分钟。",
        evidence: redact(body),
      };
    }
    return {
      ...base, kind: "credit", scope: "account", failover: true,
      why: "HTTP 402 额度用尽：整号冷却 30 分钟。余额不会因为时间流逝长回来，必须充值或等官方重置。",
      evidence: redact(body),
    };
  }

  /* ⑤ 429：两种含义完全相反，必须按正文分开。
   *    magpie 的顺序（routing.go:373-387）：
   *      credit（明说余额花完）→ quota（说了何时重置 / 本期额度）→ rate（太频繁）→ rate（默认）。 */
  if (st === 429) {
    if (CREDIT_WORDS.test(body) && BROKE_WORDS.test(body)) {
      return {
        ...base, kind: "credit", scope: "account", failover: true,
        retryAfterMs: parseRetryAfterMs(headers, body, now),
        why: "HTTP 429 且正文明说余额/额度花完了：这是持续性的，整号长冷却；换账号或等一会重试都没用。",
        evidence: redact(body),
      };
    }
    const resetAtMs = parseResetAtMs(body, now);
    if (resetAtMs != null) {
      return {
        ...base, kind: "quota", scope: "account", failover: true,
        retryAfterMs: parseRetryAfterMs(headers, body, now), resetAtMs,
        why: "HTTP 429 且正文说了什么时候重置：按那个时刻休息（最多 8 天），整号冷却。",
        evidence: redact(body),
      };
    }
    if (RATE_WORDS.test(body) && !PLANNED_WORDS.test(body)) {
      return {
        ...base, kind: "rate", scope: "model", failover: true,
        retryAfterMs: parseRetryAfterMs(headers, body, now),
        why: "HTTP 429 瞬时限流：只冷却 (账号, 模型) 这一格，同账号的其它模型照常可用。",
        evidence: redact(body),
      };
    }
    if (PLANNED_WORDS.test(body)) {
      return {
        ...base, kind: "quota", scope: "account", failover: true,
        retryAfterMs: parseRetryAfterMs(headers, body, now),
        why: "HTTP 429 且正文说的是本期额度/用量上限：等重置也不会自己好，整号冷却。",
        evidence: redact(body),
      };
    }
    return {
      ...base, kind: "rate", scope: "model", failover: true,
      retryAfterMs: parseRetryAfterMs(headers, body, now),
      why: "HTTP 429（正文没说清是额度）：按瞬时限流处理，只冷却 (账号, 模型) 这一格。",
      evidence: redact(body),
    };
  }

  /* ⑥ 401/403：凭据可能被拒。但**判不判死只正文说了算**。 */
  if (st === 401 || st === 403) {
    // ⑥a 供应商拒的是**客户端**，不是这个账号（magpie 的 failPrompt）。
    if (REFUSED_WORDS.test(body) || REQUEST_ILLEGAL_RE.test(body)) {
      return {
        ...base, kind: "auth", scope: "none", failover: true, label: "client-refused",
        why: `HTTP ${st} 且正文说的是「不接这个客户端」（unapproved channel / illegal api invocation / request illegal）：`
          + "换一家有用，但这个账号本身没问题——**谁也不休息**（magpie 的 failPrompt 口径）。",
        evidence: redact(body),
      };
    }
    // ⑥b 模型不被这家服务（magpie 的 modelRefused 覆盖 403）。
    if (UNSERVED_WORDS.test(body) && !saysQuota(body)) {
      return {
        ...base, kind: "unserved", scope: "model", failover: true,
        why: `HTTP ${st} 且正文明说这个模型不被这家服务：只休息这个模型，`
          + "同账号的其它模型照常可用（magpie 的 restID 语义）。",
        evidence: redact(body),
      };
    }
    // ⑥c 额度 / 限流。
    if (CREDIT_WORDS.test(body) && BROKE_WORDS.test(body)) {
      return {
        ...base, kind: "credit", scope: "account", failover: true,
        retryAfterMs: parseRetryAfterMs(headers, body, now),
        why: `HTTP ${st} 且正文明说余额/额度花完了：整号长冷却。`,
        evidence: redact(body),
      };
    }
    if (USED_UP_WORDS.test(body) || PLANNED_WORDS.test(body)) {
      return {
        ...base, kind: "quota", scope: "account", failover: true,
        retryAfterMs: parseRetryAfterMs(headers, body, now),
        why: `HTTP ${st} 且正文说的是套餐额度/用量上限：整号冷却。`,
        evidence: redact(body),
      };
    }
    if (RATE_WORDS.test(body)) {
      return {
        ...base, kind: "rate", scope: "model", failover: true,
        retryAfterMs: parseRetryAfterMs(headers, body, now),
        why: `HTTP ${st} 且正文说的是太频繁：只冷却 (账号, 模型) 这一格。`,
        evidence: redact(body),
      };
    }
    // ⑥d 上游明说凭据失效 → 判死。
    const dead = matchedDeadPhrase(body);
    if (dead) {
      return {
        ...base, kind: "auth", dead: true, scope: "account", failover: true, label: dead,
        why: `上游明确答复「${dead}」：这是登录态/凭据被拒（不是抖动、不是网络问题），`
          + "判死整号，只有重新登录/重新授权才恢复。",
        evidence: redact(body),
      };
    }
    // ⑥e 什么都不说：magpie 的 plainForbidden → failOther（普通 403）。
    //    401/403 一律判死是错的（wb-pool.mjs 的硬规矩），但也不该完全当没事发生。
    return {
      ...base, kind: "other", scope: "account", failover: true,
      why: `HTTP ${st} 且正文说不清为什么：**不判死**（网络抖动也会打 401/403），`
        + "按普通失败退避冷却，交给外层故障转移。",
      evidence: redact(body),
    };
  }

  /* ⑦ 400/404/413/422 以及其它 4xx：请求或内容本身不对 → 不休息任何人。
   *    但正文明说了别的东西时，按别的东西算。 */
  if (st === 400 || st === 404 || st === 413 || st === 422 || (st >= 400 && st < 500)) {
    // ⑦a 供应商拒的是客户端（magpie 的 failPrompt）。
    if (REFUSED_WORDS.test(body) || REQUEST_ILLEGAL_RE.test(body)) {
      return {
        ...base, kind: "auth", scope: "none", failover: true, label: "client-refused",
        why: `HTTP ${st} 且正文明说「这家不接这个请求」（request illegal / unapproved channel / illegal api invocation）：`
          + "换一家有用，但这个账号本身没问题——**谁也不休息**。",
        evidence: redact(body),
      };
    }
    // ⑦b 模型不被这家服务 → 只休息那个模型（magpie 的 restID 语义）。
    if (UNSERVED_WORDS.test(body) && !saysQuota(body)) {
      return {
        ...base, kind: "unserved", scope: "model", failover: true,
        why: `HTTP ${st} 且正文明说这个模型不被这家服务：只休息这个模型，`
          + "同账号的其它模型照常可用（magpie 的 restID 语义）。",
        evidence: redact(body),
      };
    }
    // ⑦c 明说额度 / 没钱了。
    if (body.toLowerCase().includes("insufficient_quota")
      || (CREDIT_WORDS.test(body) && BROKE_WORDS.test(body))) {
      return {
        ...base, kind: "credit", scope: "account", failover: true,
        retryAfterMs: parseRetryAfterMs(headers, body, now),
        why: `HTTP ${st} 且正文明说余额/额度花完了：整号长冷却。`,
        evidence: redact(body),
      };
    }
    if (USED_UP_WORDS.test(body) || PLANNED_WORDS.test(body)) {
      return {
        ...base, kind: "quota", scope: "account", failover: true,
        retryAfterMs: parseRetryAfterMs(headers, body, now),
        why: `HTTP ${st} 且正文说的是套餐额度/用量上限：整号冷却。`,
        evidence: redact(body),
      };
    }
    if (RATE_WORDS.test(body)) {
      return {
        ...base, kind: "rate", scope: "model", failover: true,
        retryAfterMs: parseRetryAfterMs(headers, body, now),
        why: `HTTP ${st} 且正文说的是太频繁：只冷却 (账号, 模型) 这一格。`,
        evidence: redact(body),
      };
    }
    // ⑦d 真的只是请求本身有问题 → 不休息任何人。
    return {
      ...base, kind: "content", scope: "none", failover: false,
      why: `HTTP ${st} 属于请求/内容本身的问题：换账号没用（会白耗别的账号的额度），应改请求或改模型。`,
      evidence: redact(body),
    };
  }

  return { ...base, kind: "other", scope: "none", failover: false, why: `HTTP ${st} 未归类。` };
}

/**
 * 这一类失败默认休息在哪一层。
 *
 * ⚠ auth 有两个子形态：凭据被判死时是整号（account），
 * 而「供应商拒的是客户端」时是**谁也不休息**（none）。调用方拿到的是
 * {@link classifyFailure} 的 scope 时用那个；这里给的是**默认值**。
 */
export function scopeOfKind(kind) {
  switch (kind) {
    case "credit":
    case "quota":
    case "auth":
      return "account";
    case "rate":
    case "unserved":
      return "model";
    case "content":
      return "none";
    default:
      return "account";
  }
}

/* ====================================================================== *
 * ② 冷却时长
 * ====================================================================== */

/**
 * 连续失败 n 次要休息多久（magpie 的退避公式，routing.go:930）。
 *
 *   d = min(1m << min(n-1, 10), 10m)
 *
 * 即 1m → 2m → 4m → 8m → 10m → …… 封顶 10 分钟（magpie 的 longestRetry）。
 *
 * 为什么封顶：再往上加不叫退避，叫把账号忘了 —— 一个偶发失败的账号
 * 不该因为「凑巧又失败了一次」就再也回不来。
 *
 * @param {number} n 连续失败次数（从 1 起）
 * @param {{baseMs?:number, capMs?:number}} [opts]
 * @returns {number} 毫秒
 */
export function backoffFor(n, opts = {}) {
  const base = Number.isFinite(opts.baseMs) ? opts.baseMs : FALLBACK_COOLDOWN_MS;
  const cap = Number.isFinite(opts.capMs) ? opts.capMs : LONGEST_RETRY_MS;
  const count = Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));
  const shifted = base * Math.pow(2, Math.min(count - 1, 10));
  return Math.min(shifted, cap);
}

/**
 * 这一类失败要休息多久（毫秒）。
 *
 * 时长表（照抄 magpie）：
 *
 *   credit   30 分钟 —— 余额不会自己长回来，只有充值/官方重置；
 *   quota    15 分钟 —— 套餐额度通常有周期重置；
 *   rate     退避 1m→2m→…→10m 封顶 —— 它会自己好；
 *   auth     30 分钟 —— 半小时是「别把重试预算喂给这个死号」，不是「它会活」；
 *   content  0 —— 请求本身有问题，谁也不休息；
 *   unserved 退避 1m 起 —— 只休息那个模型；
 *   other    退避 1m 起 —— 整号。
 *
 * **Retry-After 的地位**：上游说了就按它来（但封顶 1 小时，magpie 的 longestWait），
 * 且**只用来抬高、不用来压低**：rate 的退避与 quota 的 15 分钟底线都不会被它缩短
 * （理由见下面两个分支的注释）。只有 rate 与 quota 认它 —— 其余几类的时长是
 * 「等也没用 / 等自己好」，上游的一个 Retry-After 头改不了那个事实。
 *
 * @param {string} kind {@link KINDS} 之一
 * @param {{now?:number, failures?:number, retryAfterMs?:number|null,
 *          resetAtMs?:number|null}} [opts]
 * @returns {number} 毫秒
 */
export function cooldownFor(kind, opts = {}) {
  const now = toMs(opts.now) ?? 0;
  const n = Number.isFinite(opts.failures) ? opts.failures : 1;
  const retry = Number.isFinite(opts.retryAfterMs) ? opts.retryAfterMs : null;
  const resetAt = Number.isFinite(opts.resetAtMs) ? opts.resetAtMs : null;

  switch (kind) {
    case "credit":
      // 不认 Retry-After：钱不会因为「等 60 秒」就长回来。
      return CREDIT_REST_MS;

    case "quota": {
      // 上游说了「什么时候回来」就按它来（封顶 8 天，magpie 的 longestQuota）。
      if (resetAt != null) return Math.min(Math.max(0, resetAt - now), LONGEST_QUOTA_MS);
      // 否则认 Retry-After（封顶 1 小时），但**只用来抬高**。
      // ⚠ 不用来压低到 15 分钟以下：「额度用尽等多久都不会好」是本仓的硬规矩
      //   （failover.mjs 里同一条：额度冷却不允许被降级成短冷却）。压到 60 秒
      //   等于每分钟准点再撞一次已知没额度的账号，把整池重试预算喂给它。
      //   上游说要等**更久**（比如 1 小时）时照办 —— 那是它在说自己的窗口。
      if (retry != null) return Math.max(QUOTA_REST_MS, Math.min(retry, LONGEST_WAIT_MS));
      return QUOTA_REST_MS;
    }

    case "rate": {
      const d = backoffFor(n, opts);
      // Retry-After 只用来**抬高**退避，不用来压低：magpie 的 rateRest
      // 是 `if (said > 0 && said >= d)` —— 上游说得比退避长才采信。
      if (retry != null) {
        const said = Math.min(retry, LONGEST_WAIT_MS);
        if (said >= d) return said;
      }
      return d;
    }

    case "auth":
      return AUTH_REST_MS;

    case "content":
      return 0;

    case "unserved":
    case "other":
    default:
      return backoffFor(n, opts);
  }
}

/* ====================================================================== *
 * ③ 两级休息的键
 * ====================================================================== */

/**
 * 这个候选按什么休息（整号那一层）。
 *
 * 照抄 magpie 的 restKey()（fallback.go:102）：
 *   · 有订阅账号 → "provider@user"（user 小写 —— 大小写不同就是两个账号，
 *     但对上游来说它们是同一个）；
 *   · 有多把密钥（调用方给了 keyId）→ "provider#keyId"，
 *     每把密钥各自休息（magpie 的 perKey：rest = p.ID + "#" + KeyID）；
 *   · 都没有 → "provider"。
 *
 * ⚠ 多密钥的 provider 必须传 keyId（magpie 的 provider.KeyID）：
 * 不传就退化成「整家一起休息」，一把密钥坏了全家下线。
 *
 * @param {object} candidate {@link makeCandidate} 的产物
 * @returns {string}
 */
export function restKeyOf(candidate) {
  const c = candidate && typeof candidate === "object" ? candidate : {};
  if (c.rest) return String(c.rest);
  const provider = String(c.provider == null ? "" : c.provider);
  const account = c.account == null ? "" : String(c.account);
  if (account) return `${provider}@${account.toLowerCase()}`;
  const keyId = c.keyId == null ? "" : String(c.keyId);
  if (keyId) return `${provider}#${keyId}`;
  return provider;
}

/**
 * 这个候选按什么休息（模型那一层）。
 *
 * 照抄 magpie 的 restID()（fallback.go:124）：restKey + "/" + model。
 * 一个模型额度耗尽 / 不被服务，只让**那个模型**休息，同账号其它模型照常可用。
 *
 * @param {object} candidate {@link makeCandidate} 的产物
 * @returns {string}
 */
export function restIdOf(candidate) {
  const c = candidate && typeof candidate === "object" ? candidate : {};
  const key = restKeyOf(c);
  const model = c.model == null ? "" : String(c.model);
  return `${key}/${model}`;
}

/* ====================================================================== *
 * ④ 休息表
 * ====================================================================== */

/** note 归一：字符串也包成对象，省得调用方到处判类型。 */
function normalizeNote(note) {
  if (note == null) return { kind: null, scope: null, why: "" };
  if (typeof note === "string") return { kind: null, scope: null, why: note };
  if (typeof note === "object") return { ...note };
  return { kind: null, scope: null, why: String(note) };
}

/**
 * 休息表：谁在休息、休息到什么时候、为什么。
 *
 * ★ **两级休息就落在这张表上**：
 *   · 写入 **restKey**（"provider@user"）⇒ 这一号的所有模型都休息；
 *   · 写入 **restID**（"provider@user/model"）⇒ 只那个模型休息。
 *
 * 表里还存着**连续失败计数**（magpie 的 routed.failures）——
 * 退避要用它，而且它**成功一次就清零**（magpie 的 served()），
 * 所以「连续失败 n 次」才是真的连续。
 */
export class RestTable {
  constructor() {
    this._rests = new Map();     // id → { id, until, note }
    this._failures = new Map();  // id → 连续失败次数
  }

  /** 这个 id 有休息记录吗（不看是否已到期；要判断是否还在休息用 {@link isResting}）。 */
  has(id) { return this._rests.has(String(id)); }

  /** 这条休息的原因（结构化 note，或 null）。 */
  reason(id) { const e = this._rests.get(String(id)); return e ? e.note : null; }

  /** 这条休息的完整记录（{id, until, note}），没有就 null。 */
  entry(id) { return this._rests.get(String(id)) || null; }

  /** 写入/覆盖一条休息。until 是 epoch ms。 */
  rest(id, until, note) {
    const k = String(id);
    const rec = { id: k, until: Number(until) || 0, note: normalizeNote(note) };
    this._rests.set(k, rec);
    return rec;
  }

  /** 这条休息到期了吗（没有记录也算「到期」）。 */
  due(id, now) {
    const e = this._rests.get(String(id));
    if (!e) return true;
    return now >= e.until;
  }

  /** 清掉所有已到期的条目，返回清掉了几条。 */
  sweep(now) {
    let n = 0;
    for (const [k, e] of this._rests) {
      if (now >= e.until) { this._rests.delete(k); n++; }
    }
    return n;
  }

  /** 当前所有条目（按到期时刻升序）。 */
  entries() {
    return [...this._rests.values()].sort((a, b) => a.until - b.until);
  }

  /** 这个 id 连续失败了几次（magpie 的 routed.failures[id]）。 */
  count(id) { return this._failures.get(String(id)) || 0; }

  /** 连续失败 +1，返回新的次数。 */
  bump(id) {
    const k = String(id);
    const n = this.count(k) + 1;
    this._failures.set(k, n);
    return n;
  }

  /** 清掉连续失败计数（候选成功应答时调它 —— magpie 的 served()）。 */
  forget(id) { this._failures.delete(String(id)); }

  /** 全清（测试与「手动清冷却」用）。 */
  clear() { this._rests.clear(); this._failures.clear(); }
}

/**
 * 这个候选现在还在休息吗？
 *
 * ★ **两级休息的判定口**：
 *   · **restKey 命中** ⇒ 整号休息 ⇒ 这个账号的所有模型都不可用；
 *   · **只有 restID 命中** ⇒ 只那个模型休息 ⇒ 同账号的其它模型照常可用。
 *
 * @param {object} candidate {@link makeCandidate} 的产物
 * @param {RestTable} table 休息表
 * @param {number} now 当前时刻（由调用方注入）
 */
export function isResting(candidate, table, now) {
  if (!table || typeof table.has !== "function") return false;
  const c = candidate && typeof candidate === "object" ? candidate : {};
  const key = c.restKey != null ? String(c.restKey) : restKeyOf(c);
  if (table.has(key) && !table.due(key, now)) return true;
  const id = c.restId != null ? String(c.restId) : restIdOf(c);
  if (id !== key && table.has(id) && !table.due(id, now)) return true;
  return false;
}

/* ====================================================================== *
 * ⑤ 候选
 * ====================================================================== */

/**
 * 造一个候选。
 *
 * 候选 = 「一次请求可以投给谁」：某家 provider 的某个账号（或某把密钥），
 * 跑某个模型。**粒度是账号/密钥级**，不是 provider 级 —— 这是 magpie 的核心。
 *
 * @param {{provider?:string, account?:string, key?:string, keyId?:string,
 *          model?:string, rest?:string, seat?:object}} [spec]
 *        `account` 是订阅账号标识（通常是用户名/邮箱）；
 *        `keyId` 是密钥的稳定 id（多密钥的 provider 必须给，否则整家一起休息）；
 *        `key` 是真正的密钥 —— 只留在候选上供调用方发起请求，
 *        **绝不进入休息键、也绝不进入任何 why/evidence**。
 * @returns {object} 候选（含算好的 restKey / restId）
 */
export function makeCandidate(spec = {}) {
  const s = spec && typeof spec === "object" ? spec : {};
  const c = {
    provider: String(s.provider == null ? "" : s.provider),
    account: s.account == null ? "" : String(s.account),
    key: s.key == null ? "" : String(s.key),
    keyId: s.keyId == null ? "" : String(s.keyId),
    model: s.model == null ? "" : String(s.model),
    rest: s.rest == null ? "" : String(s.rest),
    seat: s.seat || null,
  };
  // 其余字段原样带过去（weight、free、used…调用方自己塞的东西）
  for (const k of Object.keys(s)) {
    if (!(k in c)) c[k] = s[k];
  }
  c.restKey = restKeyOf(c);
  c.restId = restIdOf(c);
  return c;
}

/**
 * 没有显式座位时，造一个「什么都不知道」的座位（routes.mjs 的 Seat 的字段形状）。
 *
 * 用普通对象而不是真的 Seat：routes.mjs 的策略只**读**字段，
 * 而且本模块不 import routes.mjs（见文件头）。
 */
function defaultSeat(candidate) {
  const c = candidate || {};
  return {
    key: c.restKey != null ? String(c.restKey) : restKeyOf(c),
    account: !!c.account,
    known: false,
    learns: false,
    used: 0,
    soon: [],
    pace: 0,
    weight: 1,
    resting: false,
    tokens: 0,
    free: false,
  };
}

/** 池名：策略用它做内部状态的名字（同 provider 用 provider id，混的用 group/…）。 */
function poolNameOf(list) {
  const ps = [...new Set(list.map((c) => String(c.provider || "")))];
  if (ps.length === 1) return ps[0] || "";
  return `group/${ps.sort().join("+")}`;
}

/**
 * 调策略拿顺序，**失败开放**。
 *
 * 语义与 routes.mjs 的 apply() 一致（那里也做同样的校验）：
 * 策略只负责排序，所以它坏了必须**退回原序** —— 每条路由仍然都会被试到，
 * 绝不能因为排序出错就漏掉一条。
 *
 * ⚠ 这里**不 import routes.mjs**：策略由调用方传进来。调用方传的是
 * routes.mjs 的 Strategy（它有 .order(pool, seats, now)），也接受一个裸函数。
 */
function applyStrategy(strategy, pool, seats, now) {
  const n = seats.length;
  const identity = () => Array.from({ length: n }, (_, i) => i);
  if (!strategy) return identity();
  const fn = typeof strategy === "function"
    ? strategy
    : (typeof strategy.order === "function" ? strategy.order.bind(strategy) : null);
  if (!fn) return identity();
  let order;
  try {
    order = fn(pool, seats, now);
  } catch {
    return identity();
  }
  if (!Array.isArray(order) || order.length !== n) return identity();
  const seen = new Array(n).fill(false);
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= n || seen[i]) return identity();
    seen[i] = true;
  }
  return order;
}

/**
 * 按策略给候选排序。
 *
 * @param {object[]} candidates 候选
 * @param {object[]} [seats] 与候选一一对应的座位（routes.mjs 的 Seat）。
 *        不给或数量对不上时，用「什么都不知道」的默认座位。
 * @param {object|Function} strategy routes.mjs 的 Strategy 对象（或裸的 order 函数）
 * @param {number} now 当前时刻（策略自己绝不取时钟）
 * @param {{pool?:string}} [opts] 池名（策略用它记内部状态）
 * @returns {object[]} 排好序的候选
 */
export function orderCandidates(candidates, seats, strategy, now, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return [];
  const seatList = Array.isArray(seats) && seats.length === list.length
    ? seats
    : list.map((c) => defaultSeat(c));
  const pool = opts.pool != null ? String(opts.pool) : poolNameOf(list);
  const order = applyStrategy(strategy, pool, seatList, now);
  return order.map((i) => list[i]);
}

/**
 * 挑第一个能用的候选。
 *
 * 「能用」= **不在休息**：整号没在休息（restKey），且这个模型也没在休息（restID）。
 *
 * @param {object[]} candidates 候选
 * @param {RestTable} table 休息表
 * @param {number} now 当前时刻（由调用方注入）
 * @param {object|Function} [strategy] 排序策略；不给就按原序
 * @param {{pool?:string}} [opts]
 * @returns {object|null} 挑中的候选；全都休息着就 null
 */
export function pickCandidate(candidates, table, now, strategy, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return null;
  // 座位上的 resting 与休息表对齐：策略（Weighted 等）要知道谁在休息。
  const seats = list.map((c) => {
    const s = c.seat && typeof c.seat === "object" ? c.seat : defaultSeat(c);
    if (s.resting === true) return s;
    return { ...s, resting: isResting(c, table, now) };
  });
  const ordered = orderCandidates(list, seats, strategy, now, opts);
  for (const c of ordered) {
    if (!isResting(c, table, now)) return c;
  }
  return null;
}
