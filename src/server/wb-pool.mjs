/**
 * wb-pool.mjs —— WorkBuddy 专用账号池的**内核**（纯逻辑，零 IO、零网络）
 *
 * ## 这个模块解决什么
 *
 * 用户要的是「WorkBuddy 积分多账号自动轮换」，但**轮换本身是有代价的**：
 * 上游的 prompt 缓存是**按账号（租户）**隔离的，对话中途换号 = 整段历史缓存作废、
 * 每一轮都按全量 prompt 计费。所以正确的姿势是反过来的：
 *
 *   **同一段对话死粘在一个账号上，只有那个账号真的用不了时才换。**
 *
 * 「真的用不了」只有五种，而且**五种的处置方式两两相反**——这是本模块存在的全部理由。
 *
 * ## 五类失败，五种处置（★本模块最核心的一张表）
 *
 * | 触发                                   | 粒度          | 处置                        | 等得回来吗 |
 * |----------------------------------------|---------------|-----------------------------|------------|
 * | 429 限流                               | (账号, 模型)  | 短冷却，尊重 resetAt        | ✅ 等一会  |
 * | 402 / 额度用尽                         | 整号          | 长冷却                      | ❌ 不会    |
 * | 401/403 + `invalid_grant` / `Offline user session not found` | 整号 | **判死**         | ❌ 不会    |
 * | 401/403 + 文案不认识                  | 无            | **不判死**、不冷却、原样上报  | ❓未知     |
 * | 5xx / 网络错误                         | 无            | **不判死**、不冷却，交给外层  | ✅ 大概率  |
 *
 * ★★ **最容易写错的是最后两行**。参考实现 dsh-xdpool 1.7.7 在这里踩过：
 * 它把「本次请求内的临时限流记录」当成「这个号到底有没有被限流」，
 * 于是看不见**上一次请求**造成的冷却 → 判定「没有可用账号」→ 报 401
 * → 界面显示「API 密钥无效」→ **用户跑去重新登录**，而密钥根本没问题。
 *
 * 所以本模块有一条硬规矩：**失败原因必须直接问池子（unavailableReason），
 * 绝不允许从「本次响应」反推「这个号是不是坏了」**。`acquire()` 选不出号时
 * 直接把结构化原因带回来，就是为了让接线层没有反推的余地。
 *
 * 第二条同样重要：**401/403 一律判死是错的**。网络抖动、令牌临时异常、
 * 上游网关抽风都会打 401，一刀切判死等于把好账号永久踢出池子。
 * 判死**只认那两条明确文案**，见 {@link DEAD_PHRASES}。
 *
 * ## 凭据新鲜度为什么不能看 expiresAt
 *
 * 上游吊销一个 refresh token 时**不会回头改写 expiresAt**。于是：
 * 一份早就死了的备份凭据会声称「我过期得更晚」，被新鲜度排序长期选中，
 * 结果每一次上游调用都是 401 —— 而**能用的那份就在同一个目录里**。
 * 参考实现 dsh-xdpool src/accounts.ts:322-331 记的就是这一条。
 *
 * 所以 {@link credentialFreshness} 的信任顺序是
 * **lastRefreshTime > capturedAt > （expiresAt 只当最后垫底，且单独标成不可信档）**。
 *
 * ## 会话粘性（两套并存，别混）
 *
 *   ① **本模块的内存粘性**（`stickyBind`/`stickyLookup`，200 条 LRU）：老的那套。
 *      key 由**调用方**算好传进来（推荐：对话**首条 user 消息**的 sha256）。
 *      理由与 xdpool 相同：Claude Code 每轮都带完整历史，首条 user 消息在整段对话里
 *      恒定，而会话 id 每轮都变。
 *      语义：**无条件粘**（只要那个号还能用就一直用），且**进程退出就没了**。
 *
 *   ② **会话亲和层**（`session-store.mjs`，magpie affinity 的移植）：新的那套。
 *      判据多一层——「缓存值不值得留」（读+写 ≥1024 token 且缓存没冷），
 *      而且**跨进程重启**还在。接线层（wb-pool-wiring.mjs）持有它，
 *      选号时把结论递进来（`acquire` 的 `opts.affinityTarget`），
 *      判据本身在 {@link affinityDecision} 里。
 *
 * 两套的分工：**有原生会话头的请求走新那套，没有的走老那套**（接线层决定）。
 * 新那套的判据「值不值得留」比老那套严，所以它一旦接管某个会话，
 * 老那套对那条会话就让位（接线层负责让位，本模块不操心）。
 *
 * ## 边界：本模块**不做**什么（接线时才做的事）
 *
 *   · 不读磁盘、不联网、不解密 —— 凭据仍由运行期钩子注入（现有 wbEnsureToken 路线）。
 *     实测过读磁盘那条路走不通：密钥是 sha256(编译期内嵌常量) 而非 DPAPI，
 *     光有数据文件解不开。这里**不碰**那个常量。
 *   · 不生成 id、不生成会话 key —— 时间源/哈希/存储全部由调用方注入（见下）。
 *   · 不写 %APPDATA% 任何文件 —— 池子状态是内存对象，持久化由 server.mjs 负责。
 *
 * ## 红线
 *
 * 全文不出现任何真实令牌/API key，也不把它们写进返回值：错误文案里的上游正文
 * 一律先过 {@link redact} 洗过（长 base64/JWT 段整段抹掉），`why` 只用固定中文说明。
 */

// ==========================================================================
// 常量
// ==========================================================================

/**
 * 判死的**唯一**依据：上游亲口说的那两句。
 *
 * ⚠️ 刻意只收两条，不收第三条。参考实现还认一个 `session_dead` 内部标记，
 * 那是它自己写进状态机的，不是上游文案——我们不引入它：多一条猜测就多一次
 * 把网络抖动误判成账号失效的机会，而误判的代价是**用户的号永久掉出池子**。
 *
 * 5xx / 超时 / DNS 失败**一条都不在这里**——它们对凭据是否有效零信息量。
 */
export const DEAD_PHRASES = ["invalid_grant", "offline user session not found"];

/**
 * 429 的短冷却（默认 60 秒）。
 *
 * 短，是因为它**真的会自己好**：上游限流窗口通常几十秒到几分钟，等一下就能回。
 * 给它长冷却只会白白浪费池子里其它能用的账号。
 */
export const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

/**
 * 上游给的 resetAt 最远只认到这里（1 小时）。
 *
 * 上游偶尔会报出一个离谱的重置时刻（时区写错、秒当毫秒）。
 * 无上限地信它 = 一个坏的时间戳能让整个池子停摆一小时以上。
 */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * 额度用尽的整号冷却（30 分钟），同 failover.mjs 的 FAILOVER_QUOTA_COOLDOWN_MS。
 *
 * ⚠️ **它为什么不能等**（这是与 429 最本质的区别）：
 * 429 是「这个窗口内请求太多」，配额本身还在，所以窗口一过就恢复；
 * 402 是「这个账号的积分余额是 0」，余额不会因为时间流逝自己长回来 ——
 * 除非官方有周期性重置、或者用户去充值。给 60 秒冷却等于每分钟准点再撞一次
 * 已知没余额的号，把整池重试预算喂给一个注定失败的请求。
 *
 * 30 分钟是权衡：① 官方真重置了，最多半小时后自动恢复，用户不用手动清冷却；
 * ② 半小时才探一次，撞死号的代价可忽略。
 */
export const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * 判死后的整号冷却（30 分钟）。
 *
 * 同样**不是等得回来的**：上游拒了登录态，只有在 WorkBuddy 桌面端**重新登录**
 * 才会恢复。所以这里给的是「多久之后再自动给一次机会」而不是「多久会好」——
 * 半小时的语义是「别让一次请求把重试预算全喂给这个死号」，不是「半小时后它活了」。
 * 一次新鲜的捕获（lastRefreshTime 变新）会**立刻**清掉这个标记。
 */
export const DEAD_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * 凭据超过这么久没刷新，就算「该重新捕获了」。
 *
 * ⚠️ 这**不是判死判据**，只是给面板提个醒。它的作用是「别在一个三个月没刷新过
 * 的凭据上浪费一次请求」。是否真的失效只能靠 classifyFailure 的明确文案回答。
 * 取 7 天：WorkBuddy 客户端本身会周期性续签，7 天没动过说明要么没开客户端、
 * 要么钩子没抓到新的，按「提醒」而不是「禁用」处理。
 */
export const STALE_CREDENTIAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 粘性表（会话 key → 账号 id）最多记多少条。
 *
 * 依据：与参考实现一致取 **200**。它只是一个内存上界，语义很轻 ——
 * 淘汰一条绑定只意味着那个会话下一轮**重新选一次号**，既不会丢账号也不会丢请求，
 * 而缓存照样能续上（重选到的很可能还是同一个号）。
 *
 * 为什么 200 够：Claude Code 同时开着的会话 rarely 超过十几个，
 * 200 ≈ 10 倍余量；再大只是把内存换得毫无意义（一条绑定才几十字节）。
 * 为什么不能太小：低于会话数就会开始**周期性踢掉正在跑的对话的绑定**，
 * 那正好是我们要避免的「切号击穿 prompt cache」。
 */
export const STICKY_LIMIT = 200;

/** 401/403：凭据可能被拒。但**必须**配 DEAD_PHRASES 才能升级成判死。 */
const AUTH_STATUS_MODEL = new Set([401, 403]);

/**
 * 刷新令牌接口用的是 400 而不是 401 —— 参考实现的实测记录里，
 * `invalid_grant: Offline user session not found` 是以 HTTP 400 回来的。
 * 接线层在**刷新路径**上调用 classifyFailure 时传 `{context:"refresh"}`，
 * 否则一次真实的凭据吊销会被当成 transient，死号永远留在池子里烧重试。
 * 注意：**模型请求路径永远只认 401/403**，不因这个开关放宽。
 */
const AUTH_STATUS_REFRESH = new Set([400, 401, 403]);

/** 额度用尽的正文特征（429 里也可能是它——见 classifyFailure）。label 给人看。 */
const QUOTA_PATTERNS = [
  { label: "FreeUsageLimitError", rx: /freeusagelimiterror/i },
  { label: "insufficient credits/quota", rx: /insufficient[_\s-]?(?:quota|credits?|funds|balance)/i },
  { label: "quota exceeded/exhausted", rx: /quota[_\s-]?(?:exceeded|exhausted)/i },
  { label: "exceeded your current quota", rx: /exceeded your current quota/i },
  { label: "billing hard limit", rx: /billing[_\s-]?hard[_\s-]?limit/i },
  { label: "中文额度文案", rx: /积分不足|额度不足|额度用尽|余额不足|配额不足|超出配额/ },
];

/** 内容/请求本身不对：换账号、换模型、等待，全都没用。 */
const CONTENT_PATTERNS = [
  /context[_\s-]?length|too many tokens|maximum context/i,
  /invalid[_\s-]?request|invalid_request_error/i,
  /model is unavailable|model_not_found|no such model/i,
  /content[_\s-]?(?:filter|policy)|safety/i,
  /request[_\s-]?too large|payload too large/i,
  /unsupported[_\s-]?(?:parameter|value|model)/i,
  /content[_\s-]?filter/i,
];

const CONTENT_STATUS = new Set([400, 404, 413, 422]);

// ==========================================================================
// 小工具（全部纯函数）
// ==========================================================================

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
 * 上游偶尔会把请求里带的东西原样回显，而本模块拿到的是**完整请求上下文**。
 * 24 字符以上连续 base64/JWT 字符的一律替换 —— 短于此的是人话，留着有用。
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
 * 从上游答复里读「多久之后能再试」。
 *
 * 三处来源：Retry-After 头（秒数或 HTTP-date）、X-RateLimit-Reset 头（epoch 秒或毫秒）、
 * 正文里的 reset_at / resetAfter 之类字段。读不到就返回 null（不是 0）。
 */
function parseRetryAfterMs(headers, body, now) {
  const ra = headerGet(headers, "retry-after");
  if (ra != null) {
    const s = Number(String(ra).trim());
    if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
    const t = Date.parse(String(ra));
    if (Number.isFinite(t)) return t > now ? t - now : 0;
  }
  const reset = headerGet(headers, "x-ratelimit-reset");
  if (reset != null) {
    const t = toMs(String(reset).trim());
    if (t != null) return t > now ? t - now : 0;
  }
  const m = /(?:reset_at|resetAt|resets_at|reset_after|retry_after|retryAfter|resetsIn)"?\s*[:=]\s*"?([0-9][0-9.]*)/i.exec(String(body || ""));
  if (m) {
    const t = toMs(m[1]);
    if (t != null) return t > now ? t - now : 0;
  }
  return null;
}

/** 正文里命中了哪个额度特征（用于 why 说明，不把原文整段带出去）。 */
function matchedQuotaPhrase(body) {
  const s = String(body || "");
  for (const p of QUOTA_PATTERNS) if (p.rx.test(s)) return p.label;
  return null;
}

/** 正文里命中了哪条判死文案。返回命中的那一条（用于日志，不含凭据）。 */
export function matchedDeadPhrase(body) {
  const s = String(body || "").toLowerCase();
  for (const p of DEAD_PHRASES) if (s.includes(p)) return p;
  return null;
}

// ==========================================================================
// ① 凭据新鲜度
// ==========================================================================

/**
 * 一枚凭据有多「可信地新」。
 *
 * 信任顺序（**刻意不把 expiresAt 当主判据**）：
 *
 *   1. `lastRefreshTime` —— 上游签发的时刻。它变了就说明上游确实动过这枚凭据。
 *   2. `capturedAt` —— 本机捕获到的时刻。上游没给签发时间时的替代品，
 *      至少「什么时候拿到的」是本地可验证的事实。
 *   3. `expiresAt` —— ⚠️ **只当最后垫底，且单独标成不可信档**。
 *      上游吊销凭据时不会回头改写它，一份早死了的备份会声称「我过期得更晚」，
 *      按它排序会让每一次上游调用都是 401，而好凭据就在旁边（dsh-xdpool accounts.ts:322）。
 *
 * @param {object} acct 账号对象（凭据可放在 `acct.credential` 下，也可平铺）
 * @param {number|string|Date} now 时间源，由调用方注入
 * @returns {{basis:string, trusted:boolean, rank:number, secondary:number,
 *            issuedAtMs:number|null, capturedAtMs:number|null, expiresAtMs:number|null,
 *            ageMs:number|null, expiresInMs:number|null, stale:boolean}}
 */
export function credentialFreshness(acct, now) {
  const a = acct && typeof acct === "object" ? acct : {};
  const cred = a.credential && typeof a.credential === "object" ? a.credential : a;

  const issued = toMs(cred.lastRefreshTime);
  const captured = toMs(cred.capturedAt);
  const expires = toMs(cred.expiresAt);

  const basis = issued != null ? "lastRefreshTime" : captured != null ? "capturedAt" : "expiresAt";
  const trusted = basis !== "expiresAt";
  const basisMs = issued != null ? issued : captured != null ? captured : expires;

  const nowMs = toMs(now) ?? 0;
  return {
    basis,
    trusted,
    /** 可直接比较：越大越新。只有 trusted 的信号才给有限值，否则垫底。 */
    rank: trusted && basisMs != null ? basisMs : Number.NEGATIVE_INFINITY,
    /** 同档内部再比一次（两枚都不可信时，按 expiresAt 排——已经是最差的一档了）。 */
    secondary: basisMs == null ? Number.NEGATIVE_INFINITY : basisMs,
    issuedAtMs: issued,
    capturedAtMs: captured,
    expiresAtMs: expires,
    ageMs: basisMs == null ? null : nowMs - basisMs,
    expiresInMs: expires == null ? null : expires - nowMs,
    stale: basisMs != null && nowMs - basisMs > STALE_CREDENTIAL_MS,
  };
}

/** 新鲜度比较器（大 → 小，数组 sort 用）。account 之间按 rank → secondary 排。 */
function compareFreshness(a, b, now) {
  const fa = credentialFreshness(a, now);
  const fb = credentialFreshness(b, now);
  if (fa.rank !== fb.rank) return fa.rank < fb.rank ? 1 : -1;   // 降序
  if (fa.secondary !== fb.secondary) return fa.secondary < fb.secondary ? 1 : -1;
  return 0;
}

// ==========================================================================
// ② 失败分类：五类判据，五种处置
// ==========================================================================

/**
 * 把一次上游答复归到五类之一，并给出**结构化的处置指令**。
 *
 * 这是本模块最重要、也最容易写错的函数。返回值里的三个字段各有硬约定：
 *
 *   · `dead` —— **只有 kind==="auth_dead" 才可能为 true**。
 *     401/403 本身绝不足以判死：网络抖动、令牌临时异常、上游网关抽风都打 401，
 *     一刀切判死会把好账号永久踢出池子，用户还得重新登录一个没坏的号
 *     （这正是 dsh-xdpool 1.7.7 的事故形态）。
 *   · `scope` —— 冷却写在哪一层：`"account_model"` 只冷却这一个模型、
 *     `"account"` 冷却整号、`"none"` 根本不冷却。
 *   · `retryAfterMs` —— 上游说的「多久后再试」。**只对 429 有意义**；
 *     其它 kind 一律 null，因为「等多久」这个问题对它们根本不成立。
 *
 * @param {number|string|null} status HTTP 状态码；null/非数值 = 没拿到响应（网络错误）
 * @param {string} text 上游响应正文（只用于识别，输出里会被 redact 洗过）
 * @param {{headers?:any, now?:number, context?:("model"|"refresh")}} [opts]
 * @returns {{kind:string, dead:boolean, scope:string, retryAfterMs:number|null, why:string, evidence:string|null, deadPhrase:string|null, quotaPhrase:string|null}}
 */
export function classifyFailure(status, text, opts = {}) {
  const now = toMs(opts.now) ?? 0;
  const body = String(text == null ? "" : text);
  const st = normalizeStatus(status);
  const refreshPath = opts.context === "refresh";
  const base = { retryAfterMs: null, deadPhrase: null, quotaPhrase: null, evidence: null };

  /* ① 压根没拿到 HTTP 答复：网络错误 / 超时 / 连接被重置。
   *    对凭据有效性零信息量 → transient，绝不判死、绝不冷却。 */
  if (st === null) {
    return {
      ...base,
      kind: "transient", dead: false, scope: "none",
      why: "网络/连接层失败（没拿到上游答复）：这跟账号本身没关系，不判死也不冷却，等一下重试或让外层故障转移。",
    };
  }

  /* ② 5xx：上游自己坏了。判死等于把所有账号一次性冤杀。 */
  if (st >= 500) {
    return {
      ...base,
      kind: "transient", dead: false, scope: "none",
      why: `上游自身故障（HTTP ${st}）：不是账号的问题，不判死也不冷却，交给外层故障转移。`,
    };
  }

  /* ③ 429：两种含义完全相反，必须按正文分开。
   *    正文说额度/配额用尽 → 它其实是 quota（持续性），不是 rate_limit（瞬时）。 */
  if (st === 429) {
    const q = matchedQuotaPhrase(body);
    if (q) {
      return {
        ...base, quotaPhrase: q,
        kind: "quota", dead: false, scope: "account",
        retryAfterMs: parseRetryAfterMs(opts.headers, body, now),
        why: "HTTP 429 且正文指向额度/配额用尽：这是持续性的，冷却整号；换账号或等一会重试都没用。",
        evidence: redact(body),
      };
    }
    return {
      ...base,
      kind: "rate_limit", dead: false, scope: "account_model",
      retryAfterMs: parseRetryAfterMs(opts.headers, body, now),
      why: "HTTP 429 瞬时限流：只冷却 (账号, 模型) 这一格，同账号的其它模型照常可用。",
      evidence: redact(body),
    };
  }

  /* ④ 402：定义上就是「额度用尽」。整号、等多久都不会自己好。 */
  if (st === 402) {
    return {
      ...base, quotaPhrase: matchedQuotaPhrase(body) || "status-402",
      kind: "quota", dead: false, scope: "account",
      retryAfterMs: parseRetryAfterMs(opts.headers, body, now),
      why: "HTTP 402 额度用尽：整号长冷却。积分余额不会因为时间流逝长回来，必须充值或等官方重置。",
      evidence: redact(body),
    };
  }

  /* ⑤ 401/403（刷新路径上 400 也算）：**判不判死只正文说了算**。
   *    这是全模块最容易写错的一格，判据见 DEAD_PHRASES。 */
  const authSet = refreshPath ? AUTH_STATUS_REFRESH : AUTH_STATUS_MODEL;
  if (authSet.has(st)) {
    const phrase = matchedDeadPhrase(body);
    if (phrase) {
      return {
        ...base, deadPhrase: phrase,
        kind: "auth_dead", dead: true, scope: "account",
        why: `上游明确答复「${phrase}」：这是登录态被拒（不是抖动、不是网络问题），判死整号，只有重新登录/重新捕获才恢复。`,
        evidence: redact(body),
      };
    }
    // ★★★ 关键分支：401/403 但文案不认识 → **不判死**。
    return {
      ...base,
      kind: "transient", dead: false, scope: "none",
      why: `HTTP ${st} 但文案不匹配判死依据（只有 ${DEAD_PHRASES.join(" / ")} 才算死）：`
        + "可能是网络抖动或令牌临时异常，**不判死、不冷却**，原样上报给调用方。",
      evidence: redact(body),
    };
  }

  /* ⑥ 400/404/413/422：请求或内容本身不对。换号、等待、换凭据都救不了。 */
  if (CONTENT_STATUS.has(st) || CONTENT_PATTERNS.some((rx) => rx.test(body))) {
    return {
      ...base,
      kind: "content", dead: false, scope: "none",
      why: `HTTP ${st} 属于请求/内容本身的问题：换账号没用（会白耗别的账号的额度），应改请求或改模型。`,
      evidence: redact(body),
    };
  }

  return {
    ...base,
    kind: "transient", dead: false, scope: "none",
    why: `HTTP ${st} 未归类的失败：按瞬时处理，不判死也不冷却。`,
    evidence: redact(body),
  };
}

// ==========================================================================
// ③ 冷却时长与到期时刻
// ==========================================================================

/**
 * 这一类失败要休息多久、什么时候回来。
 *
 * 粒度**由 kind 决定**，这是五种处置相反的地方落地的唯一位置：
 *
 *   rate_limit → `account_model`，尊重上游 resetAt，**等得回来**；
 *   quota      → `account`，**无视** resetAt，等多久都不会恢复（余额不会自己长）；
 *   auth_dead  → `account`，同样等不回来，只能重新登录；
 *   transient  → `none`，不休息（0 毫秒）；
 *   content    → `none`，不休息。
 *
 * @param {string} kind classifyFailure 的 kind
 * @param {{resetAt?:(number|string|Date|null), now?:number}} opts 时间与重置时刻由调用方注入
 * @returns {{kind:string, scope:string, durationMs:number, untilMs:number,
 *            respectsResetAt:boolean, waitsHelps:boolean, recoveredBy:string,
 *            ignoredResetAt:number|null, why:string}}
 */
export function cooldownFor(kind, opts = {}) {
  const now = toMs(opts.now) ?? 0;
  const resetAt = toMs(opts.resetAt);

  const none = (k, why) => ({
    kind: k, scope: "none", durationMs: 0, untilMs: now,
    respectsResetAt: false, waitsHelps: true, recoveredBy: "none", ignoredResetAt: null, why,
  });

  if (kind === "rate_limit") {
    let ms = RATE_LIMIT_COOLDOWN_MS;
    if (resetAt != null) {
      if (resetAt <= now) ms = 0;                       // 上游说窗口已经过了 → 不冷却
      else ms = Math.min(resetAt - now, MAX_RATE_LIMIT_COOLDOWN_MS);  // 封顶，防坏时间戳
    }
    return {
      kind, scope: "account_model", durationMs: ms, untilMs: now + ms,
      respectsResetAt: true, waitsHelps: true, recoveredBy: "wait", ignoredResetAt: null,
      why: `限流冷却 ${Math.round(ms / 1000)} 秒（粒度：账号+模型）：这段时间该号该模型不选，同号其它模型不受影响。`,
    };
  }

  if (kind === "quota") {
    return {
      kind, scope: "account", durationMs: QUOTA_COOLDOWN_MS, untilMs: now + QUOTA_COOLDOWN_MS,
      respectsResetAt: false, waitsHelps: false, recoveredBy: "topup", ignoredResetAt: resetAt,
      why: `额度用尽，整号冷却 ${Math.round(QUOTA_COOLDOWN_MS / 60000)} 分钟：`
        + "**等多久都不会自己恢复**（积分余额不随时间增长），上游就算给了 resetAt 也一律不认；"
        + "只有充值或官方重置才能回得来。",
    };
  }

  if (kind === "auth_dead") {
    return {
      kind, scope: "account", durationMs: DEAD_COOLDOWN_MS, untilMs: now + DEAD_COOLDOWN_MS,
      respectsResetAt: false, waitsHelps: false, recoveredBy: "relogin", ignoredResetAt: resetAt,
      why: `登录态被拒，整号冷却 ${Math.round(DEAD_COOLDOWN_MS / 60000)} 分钟：`
        + "这半小时是「别让单次请求把重试预算全喂给这个死号」，**不是**「半小时后它活了」——"
        + "等再久也不会自己好，必须在 WorkBuddy 桌面端重新登录；一次新鲜捕获会立刻清掉这个标记。",
    };
  }

  if (kind === "content") return none(kind, "请求/内容本身的问题：不冷却，换号只会白耗别的账号的额度。");
  return none(kind, "瞬时失败：不判死、不冷却，交给外层故障转移。");
}

// ==========================================================================
// ④ 粘性绑定
// ==========================================================================

/**
 * 把会话粘到某个账号上（Map 的插入序即 LRU 序）。
 *
 * @param {Map<string,string>} stickyMap
 * @param {string|null} sessionKey 会话 key（调用方算好，通常是首条 user 消息的哈希）
 * @param {string|null} accountId 绑定的账号；传 null 表示**解绑**（粘性目标出池子了）
 * @param {number} now 时间源，由调用方注入。
 *        ⚠️ 淘汰**不**按它算：Map 的插入序就是 LRU 序，而 `stickyLookup` 命中时会
 *        先删后插，所以插入序已经等于「最近一次被用到」的顺序。保留这个形参是为了
 *        与本模块其它导出（时间源一律由调用方注入）保持同一套签名。
 * @returns {Map<string,string>} 同一个 map（方便链式调用）
 */
export function stickyBind(stickyMap, sessionKey, accountId, now) {
  if (!stickyMap || typeof stickyMap.set !== "function") return stickyMap;
  if (sessionKey == null || sessionKey === "") return stickyMap;
  // 先删后插 = 重新挂到最新鲜的一端（Map 保序，set 已存在时**不**改序，必须显式删）。
  stickyMap.delete(sessionKey);
  if (accountId == null || accountId === "") return stickyMap;
  stickyMap.set(sessionKey, String(accountId));
  while (stickyMap.size > STICKY_LIMIT) {
    const oldest = stickyMap.keys().next();
    if (oldest.done) break;
    stickyMap.delete(oldest.value);
  }
  return stickyMap;
}

/**
 * 查当前粘在哪个号上，命中即**刷新 LRU 位置**（读也算用）。
 *
 * @returns {string|null} 绑定的账号 id；没有绑定返回 null
 */
export function stickyLookup(stickyMap, sessionKey) {
  if (!stickyMap || typeof stickyMap.get !== "function") return null;
  if (sessionKey == null || sessionKey === "") return null;
  const id = stickyMap.get(sessionKey);
  if (id == null) return null;
  stickyMap.delete(sessionKey);
  stickyMap.set(sessionKey, id);
  return id;
}

// ==========================================================================
// ⑤ 为什么这个号不能用（★失败原因必须问池子，不能从响应反推）
// ==========================================================================

/**
 * 这五种「不能用」给**五种互不相同**的处置指引。
 *
 * 把它们混成一句「没有可用账号，请重新登录」是 dsh-xdpool 1.7.7 的事故根因：
 * 一次 429 被说成 401，用户跑去重新登录一个根本没坏的账号。所以：
 * 每种 reason 的 `remedy` 必须**动作不同**（等 / 充值 / 重新登录 / 打开开关 / 加回池子），
 * 且 `recoveredBy` 明确区分「等得回来」与「等不回来」。
 */
const REASONS = {
  ok: {
    remedy: "可用，无需处理。",
    recoveredBy: "none",
    why: "该账号当前可被选中。",
  },
  dead: {
    remedy: "去 WorkBuddy 桌面端重新登录这个账号再重新捕获令牌；等多久都不会自己恢复，重启本程序也没用。",
    recoveredBy: "relogin",
    why: "上游明确拒了它的登录态（invalid_grant / Offline user session not found），已退出轮换。",
  },
  quota: {
    remedy: "给这个账号充值或去领积分，也可以直接让它继续冷却到官方重置；本池已经在自动换号，不用手动干预。",
    recoveredBy: "topup",
    why: "整号额度用尽（HTTP 402 或 429+额度文案）：积分余额不会随时间自己长回来。",
  },
  cooling: {
    remedy: "等冷却到点自动恢复即可，不用做任何事；这段时间同号会被自动换走。",
    recoveredBy: "wait",
    why: "整号正在冷却（限流或额度），到点自动放行。",
  },
  cooling_model: {
    remedy: "只有这个模型在冷却：同一个账号换别的模型照常可用，也可以等冷却到点自动恢复。",
    recoveredBy: "wait",
    why: "只有 (账号, 模型) 这一格在冷却，同账号其它模型不受影响。",
  },
  disabled: {
    remedy: "你在面板上把这个账号关掉了：到面板的 WorkBuddy 页把它重新打开，它就会回到池子。",
    recoveredBy: "enable",
    why: "用户主动停用了这个账号。",
  },
  ignored: {
    remedy: "这个账号被移出池子了（不再扫描、不再冷却）：要恢复请到面板把它加回来。",
    recoveredBy: "rejoin",
    why: "用户把这个账号彻底移出了池子。",
  },
  stale: {
    remedy: "凭据太久没刷新了，建议重新捕获一次；这不是失效，现在仍然可用。",
    recoveredBy: "recapture",
    why: "距离上次刷新很久没动过（只是提醒，不是判死）。",
  },
  unknown_account: {
    remedy: "池子里没有这个账号（可能已被移除，或版本对不上）：检查国内版/国际版是否放反了。",
    recoveredBy: "rejoin",
    why: "按 id 在池子里找不到这个账号。",
  },
};

/** 已知 reason 的中文指引（面板/日志共用；未知 reason 不编，落到「无可用账号」）。 */
export function remedyOf(reason) {
  return (REASONS[reason] || REASONS.unknown_account).remedy;
}

/**
 * **一个**账号现在为什么不能用（以及该做什么）。
 *
 * 这就是接线层在 401 场景下必须问的东西 —— 而不是从「这次响应是不是 401」
 * 反推「这个号是不是坏了」。1.7.7 事故里两者混为一谈，用户被派去修一个没坏的东西。
 *
 * @param {object} pool 池子（含 accounts）
 * @param {string} accountId 查这一个账号
 * @param {number} now 时间源，由调用方注入
 * @param {string} [model] 问的是不是这个模型上的冷却（决定 cooling vs cooling_model）
 * @returns {{id:string, available:boolean, reason:string, scope:string,
 *            untilMs:number|null, retryAfterMs:number|null, stale:boolean,
 *            remedy:string, recoveredBy:string, why:string, label:string|null}}
 */
export function unavailableReason(pool, accountId, now, model) {
  const nowMs = toMs(now) ?? 0;
  const list = pool && Array.isArray(pool.accounts) ? pool.accounts : [];
  const acct = list.find((a) => a && a.id === accountId);
  if (!acct) {
    return {
      id: String(accountId), available: false, reason: "unknown_account", scope: "none",
      untilMs: null, retryAfterMs: null, stale: false,
      remedy: REASONS.unknown_account.remedy, recoveredBy: REASONS.unknown_account.recoveredBy,
      why: REASONS.unknown_account.why, label: null,
    };
  }

  const fill = (reason, extra) => {
    const r = REASONS[reason] || REASONS.unknown_account;
    return {
      id: acct.id, available: reason === "ok", reason, scope: extra.scope || "none",
      untilMs: extra.untilMs == null ? null : extra.untilMs,
      retryAfterMs: extra.retryAfterMs == null ? null : extra.retryAfterMs,
      stale: !!extra.stale,
      remedy: r.remedy, recoveredBy: r.recoveredBy, why: r.why,
      label: acct.label == null ? null : String(acct.label),
    };
  };

  if (acct.dead === true) {
    return fill("dead", { untilMs: acct.cooldownUntilMs == null ? null : toMs(acct.cooldownUntilMs) });
  }
  if (acct.ignored === true) return fill("ignored", {});
  if (acct.disabled === true) return fill("disabled", {});
  if ((toMs(acct.cooldownUntilMs) || 0) > nowMs) {
    // 整号冷却要区分「额度（等不回来）」与「限流（等得回来）」，处置完全不同。
    const reason = acct.quotaUntilMs != null && (toMs(acct.quotaUntilMs) || 0) > nowMs ? "quota" : "cooling";
    return fill(reason, {
      untilMs: toMs(acct.cooldownUntilMs),
      retryAfterMs: Math.max(0, (toMs(acct.cooldownUntilMs) || 0) - nowMs),
    });
  }
  const m = model == null ? null : String(model);
  if (m != null && (toMs((acct.modelCooldowns || {})[m]) || 0) > nowMs) {
    return fill("cooling_model", {
      untilMs: toMs(acct.modelCooldowns[m]),
      retryAfterMs: Math.max(0, (toMs(acct.modelCooldowns[m]) || 0) - nowMs),
    });
  }
  return fill("ok", { stale: credentialFreshness(acct, nowMs).stale });
}

// ==========================================================================
// ⑤' 会话亲和：这一轮粘不粘（magpie 的 affinity 判据落在这里）
// ==========================================================================

/**
 * 亲和表里那条记录（按 key 找）。
 *
 * ⚠ 为什么不能直接用 `store.lookup(key)` 找这条记录：
 * lookup 在「这条记录不值得留」时**也**返回 null（magpie 的 no-cache / cold
 * 两条判据），而**「没有记录」与「有记录但不留」是两件事**：
 *
 *   · 没有记录 → 这一层**根本不参与**，老那套无条件粘性照旧接管；
 *   · 有记录但不留 → 这一层**说了算**（换号，但绑定留着）。
 *
 * 分不开这两件事，就会把「缓存不值了」当成「从没粘过」——于是老那套被请回来，
 * 新那套的判据形同虚设（本模块最怕的那种「默默失效」）。
 *
 * @param {object} store 亲和表（SessionStore 或任何有 entries() 的等价物）
 * @param {string} key 会话 key
 * @returns {{key:string,target:string,at:number,used:number,meta:object}|null}
 */
function affinityRecord(store, key) {
  if (!store || typeof store.entries !== "function") return null;
  const list = store.entries();
  if (!Array.isArray(list)) return null;
  for (const e of list) if (e && e.key === key) return e;
  return null;
}

/**
 * ★ 亲和决策：**这个会话现在归谁、这一轮该不该继续用它**。
 *
 * 判据的顺序（magpie `affine()` 的同款语义，但只用得上的那几段）：
 *
 *   ① **那个号现在还能不能用？** —— 问池子（{@link unavailableReason}），
 *      **绝不**从「本次响应」反推（本章的老规矩：失败原因只问池子）。
 *      · 凭据**真的死了**（dead）→ **永久解绑**（`forgetTarget`）。
 *        「休息中」≠「死了」：休息的号等会儿还能用（绑定留着，缓过来还能接回去），
 *        死了的号再粘着就是**死等**（凭据不会自己活过来）。
 *      · 只是冷却 / 额度用尽 / 停用 → **绑定留着**，这一轮换号。
 *   ② **值不值得留？** —— 问亲和层自己（`store.lookup`）：magpie 的
 *      「读+写 ≥1024 token 且缓存没冷」。不值得留就换号（绑定仍留着，
 *      下一轮重新判）。
 *   ③ **「不知道缓存有多少」≠「缓存不值」**：调用方没报缓存量（全是 0）时，
 *      按「留着」处理（安全侧）—— 否则每条会话都会被判成「不值」，
 *      每轮重建一次 prompt 缓存，比不接亲和还糟。
 *
 * 「可用」由本函数判断（池子最懂 eligibility），「值不值得留」由亲和层判断
 * （它知道缓存冷不冷）——两边都同意，这一轮才粘住那个号。
 *
 * @param {object} pool 池子（含 accounts）
 * @param {object} store 亲和表；没有它 / 没有这条记录 → decision "none"
 * @param {string|null} key 会话 key（调用方给的，本模块不造）
 * @param {number} now 时间源，由调用方注入
 * @param {string|null} [model] 问的是不是这个模型上的冷却
 * @returns {{decision:"none"|"stick"|"switch", has:boolean, target:string|null,
 *            reason:string|null, dead:boolean, cacheKnown:boolean}}
 */
export function affinityDecision(pool, store, key, now, model) {
  const out = { decision: "none", has: false, target: null, reason: null, dead: false, cacheKnown: false };
  if (!store || typeof store.lookup !== "function") return out;
  const k = key == null ? "" : String(key);
  if (!k) return out;

  const rec = affinityRecord(store, k);
  if (!rec) return out;                 // ① 这一层没有这条记录 → 不参与
  out.has = true;

  /* ② 那个号现在还能不能用？——问池子。 */
  const st = unavailableReason(pool, rec.target, now, model);
  if (!st.available && st.reason === "dead") {
    /* 凭据真的死了 → 永久解绑。休息中的号不在这一支（它们走下面那支，绑定留着）。 */
    out.dead = true;
    out.decision = "switch";
    out.reason = "dead";
    try { store.forgetTarget(rec.target); } catch { /* 亲和表坏了不该让请求崩 */ }
    return out;
  }

  /* ③ 还活着（哪怕在冷却）→ 问亲和层「这一轮还粘不粘」。
     usable=false = 「它现在用不了」：这一轮换号，**绑定留着**。 */
  let looked = null;
  try { looked = store.lookup(k, { usable: st.available }); } catch { looked = null; }
  if (looked && looked.target === rec.target) {
    out.decision = "stick";
    out.target = rec.target;
    /* reason 给的是**池子自己的**原因（cooling / quota / …），
       这样 strict 模式（粘住就绝不换）能把「那个号现在为什么用不了」如实报出去，
       而不是自己编一个词。 */
    out.reason = st.available ? "ok" : (st.reason || "cooling");
    try { store.touch(k); } catch { /* 同上 */ }
    return out;
  }

  /* ④ 不粘了 → 本该换号。**但先分清「缓存不值」与「不知道缓存有多少」**：
   *
   *   · 「不值」= 知道，而且读写加起来不到 1024 token（magpie 的 no-cache 判据）；
   *   · 「不知道」= 调用方**没报**缓存量（全是 0）。
   *
   * 两者混为一谈的后果很具体：调用方忘了报 → 每一条会话都判成「不值」→
   * 会话永远不粘 → **每一轮都在重建 prompt 缓存**（比不接亲和还糟得多）。
   * 所以「不知道」按「留着」处理（安全侧），「知道且不值」才换。
   * 这也是本仓库的老纪律：读失败当空是灾难，「读失败 = 未知，不是空」。 */
  const meta = rec.meta && typeof rec.meta === "object" ? rec.meta : {};
  const cacheKnown = (Number(meta.cacheRead) || 0) + (Number(meta.cacheWrite) || 0) > 0;
  out.cacheKnown = cacheKnown;
  if (!cacheKnown && st.available) {
    out.decision = "stick";
    out.target = rec.target;
    out.reason = "unknown-cache";
    try { store.touch(k); } catch { /* 同上 */ }
    return out;
  }

  /* ⑤ 真的不粘了 → 换号。绑定**留着**（死掉的那一支已经解绑过了）。 */
  out.decision = "switch";
  out.reason = st.available ? "not-worth" : (st.reason || "unavailable");
  return out;
}

// ==========================================================================
// ⑥ 选号
// ==========================================================================

/** 该账号在这个 (版本, 模型) 组合下能不能用。复用 unavailableReason，避免两套判据。 */
function eligibility(pool, acct, model, now) {
  return unavailableReason(pool, acct.id, now, model);
}

/**
 * 选号：**粘性优先 → 手动指定 → 按模式**。
 *
 * 顺序是刻意的，不是随便排的：
 *
 *   ① 手动指定：用户明确点了某一个号，他点了就该照做 —— 连粘性也不让顶掉它。
 *   ② 粘性：这一段对话已经粘住的号，**只要它还能用就用它**。
 *      这一条是整个模块存在的理由 —— 换号 = 整段对话的 prompt 缓存作废。
 *      它不能用（冷却/停用/移出/判死）时才往下走，走了就会重新绑定。
 *      ②a **会话亲和层**（新那套，持久化 + 「缓存值不值得留」的判据）：
 *          调用方（接线层）已经问过 {@link affinityDecision}，把结论递进来
 *          （`opts.affinityTarget`）。这里只做最后一道检查：**它此刻在不在
 *          eligible 里**（不在 = 它在冷却/判死/停用 → 换号）。
 *          它与手动指定、与老那套粘性**同级**：手动指定仍然压过它
 *          （显式意图永远压过自动优化）。
 *   ③ 按模式选一个新的。
 *
 * 为什么手动指定排在粘性**前面**：粘性是系统为了省积分做的自动优化，
 * 而手动指定是用户此刻的显式意图。显式意图永远压过自动优化 ——
 * 何况用户点「用这个号」通常正是因为「我刚换了号，不想它又被拽回去」。
 *
 * 选不出号时**不返回 undefined 了事**，而是把结构化原因带回来 —— 接线层必须
 * 直接把 `reason` 报给用户，这正是 1.7.7 那条教训的解药。
 *
 * @param {object} pool {version, mode, accounts[], sticky?}
 * @param {{version?:string, model?:string|null, sessionKey?:string|null, now:number,
 *          prefer?:string|null, stickyMap?:Map, rand?:() => number,
 *          affinityTarget?:string|null}} opts
 *        `now` 是**必填**的时间源；`rand` 注入随机源（balanced 模式，保证可测）；
 *        `affinityTarget` 是**会话亲和层**给出的目标账号 id（见 ②a）
 * @returns {{ok:boolean, account?:object, bound?:boolean, preferred?:boolean,
 *            reason?:string, remedy?:string, how?:string, eligible?:number}}
 */
export function acquire(pool, opts = {}) {
  const now = toMs(opts.now) ?? 0;
  const version = opts.version == null ? (pool && pool.version) : String(opts.version);
  const model = opts.model == null ? null : String(opts.model);
  const sessionKey = opts.sessionKey == null ? null : String(opts.sessionKey);
  // 粘性表优先用调用方注入的，其次用池子上已有的；都没有就**建一个挂回池子上**。
  // 不建的话第一次 acquire 会把绑定悄悄丢掉（没有地方存），粘性形同虚设 ——
  // 而粘性正是这个模块存在的理由，默默失效是最坏的一种失效。
  const stickyMap = opts.stickyMap
    || (pool && pool.sticky)
    || (pool ? ((pool.sticky = new Map()), pool.sticky) : undefined);

  const all = pool && Array.isArray(pool.accounts) ? pool.accounts : [];
  // 分池不混：国内版（wb）与国际版（wbai）令牌**互不通用**（国内令牌打国际端点必然 401），
  // 所以版本对不上的账号在这里就出局，不进后面的判断。
  const sameVersion = version ? all.filter((a) => a && (a.version == null || a.version === version)) : all;

  const eligible = sameVersion.filter((a) => eligibility(pool, a, model, now).available);

  if (eligible.length === 0) {
    const agg = poolReason(sameVersion, all, model, now, version);
    return { ok: false, account: undefined, eligible: 0, reason: agg.reason, remedy: agg.remedy, how: agg.how };
  }

  /* ① 手动指定压过一切：用户点了哪个号就是哪个号，连粘性也不拦。
   *    判据是「在不在 eligible 里」—— 用户指定的号自己冷却了/被判死了，就**不**
   *    硬用它（那等于把用户按在一个已知用不了的号上），往下走粘性或模式，
   *    并如实告诉调用方 `preferSkipped`，别让它以为「我点的号被用上了」。 */
  let preferSkipped = false;
  if (opts.prefer) {
    const p = eligible.find((a) => a.id === opts.prefer);
    if (p) {
      bindIfSticky(stickyMap, sessionKey, p.id, now);
      return { ok: true, account: p, preferred: true, eligible: eligible.length, how: "prefer" };
    }
    preferSkipped = true;
  }
  const extra = preferSkipped ? { preferSkipped: true } : {};

  /* ②a 会话亲和层（新那套）：它说粘住就粘住 —— 但**只在这个号此刻真的可用时**。
   *    不可用（冷却/额度/判死/停用）就落空，往下走老那套粘性或按模式重选。 */
  if (opts.affinityTarget) {
    const a = eligible.find((x) => x.id === opts.affinityTarget);
    if (a) {
      bindIfSticky(stickyMap, sessionKey, a.id, now);
      return { ok: true, account: a, bound: true, eligible: eligible.length, how: "affinity", ...extra };
    }
  }

  /* ② 粘性优先 —— 保住 prompt 缓存的那一条。 */
  if (sessionKey != null && sessionKey !== "") {
    const boundId = stickyLookup(stickyMap, sessionKey);
    if (boundId != null) {
      const bound = eligible.find((a) => a.id === boundId);
      if (bound) return { ok: true, account: bound, bound: true, eligible: eligible.length, how: "sticky", ...extra };
      // 绑定指向的号已经出池（冷却/判死/停用）：粘性自动落空，下面重新选并**重绑**。
    }
  }

  /* ③ 按模式挑。 */
  const mode = normalizeMode(pool && pool.mode);
  const chosen = pickByMode(mode, eligible, pool, opts, now);
  if (!chosen) return { ok: false, account: undefined, eligible: eligible.length, reason: "none", remedy: remedyOf("none"), ...extra };

  bindIfSticky(stickyMap, sessionKey, chosen.id, now);
  return { ok: true, account: chosen, bound: false, eligible: eligible.length, how: mode, ...extra };
}

/** 只有真的传了会话 key 才绑定；没传 key 的请求（探测、健康检查）不污染粘性表。 */
function bindIfSticky(stickyMap, sessionKey, accountId, now) {
  if (!stickyMap) return;
  if (sessionKey == null || sessionKey === "") return;
  stickyBind(stickyMap, sessionKey, accountId, now);
}

/** 认不出来的模式一律按 priority（而不是抛错或随机行为）——配置写错不该让路由崩。 */
function normalizeMode(mode) {
  const m = String(mode == null ? "" : mode).toLowerCase();
  return ["priority", "round-robin", "balanced", "sticky"].includes(m) ? m : "priority";
}

/** `order` 小的优先；没有 order 的按池子里的原始次序（stable sort）。 */
function byOrder(a, b) {
  const oa = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
  const ob = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
  if (oa !== ob) return oa - ob;
  return 0;
}

function pickByMode(mode, eligible, pool, opts, now) {
  switch (mode) {
    case "round-robin": {
      // 游标在池子上，跨请求推进。步进一次就返回，方便连续调用均匀铺开。
      const cur = Number.isFinite(pool && pool.cursor) ? pool.cursor : 0;
      const acct = eligible[cur % eligible.length];
      if (pool) pool.cursor = (cur + 1) % Math.max(1, eligible.length);
      return acct;
    }
    case "balanced": {
      // 闲置越久越容易被选中，但**基础权重保底 1**：否则一个刚服务过的号可能被
      // 连续排除出池子，把流量钉死在别的号上。随机源可注入 → 测试可复现。
      const rand = typeof opts.rand === "function" ? opts.rand : Math.random;
      let total = 0;
      const w = eligible.map((a) => {
        const hours = a.lastUsedAt == null ? 24 : Math.max(0, (now - toMs(a.lastUsedAt)) / 3_600_000);
        const weight = 1 + Math.min(hours, 12) * 0.5;
        total += weight;
        return weight;
      });
      let r = rand() * total;
      for (let i = 0; i < eligible.length; i++) { r -= w[i]; if (r < 0) return eligible[i]; }
      return eligible[eligible.length - 1];
    }
    case "sticky":
    case "priority":
    default: {
      const sorted = eligible.slice();
      if (mode === "sticky") {
        /* sticky 模式下**新会话**的第一次选号按「凭据可信度」排，不按 order。
         *
         * 理由是粘性绑定的代价：绑上去就是长期绑定（为了缓存），所以第一次就得
         * 押在**最可能还活着**的凭据上，而不是最靠前的那个。新鲜度排序天然把
         * 「只会拿 expiresAt 吹牛」的死凭据压到最后 —— 哪怕它声称过期得更晚。
         * 已经有绑定的会话走上面的 ①，根本不会走到这里。
         */
        sorted.sort((a, b) => compareFreshness(a, b, now) || byOrder(a, b));
      } else {
        sorted.sort(byOrder);
      }
      return sorted[0];
    }
  }
}

/**
 * 全池都选不出号时的**聚合**原因。
 *
 * 优先级是「等不回来的压过等得来的」：死号 > 额度 > 冷却 > 停用 > 移出。
 * 理由很实在 —— 全被冷却时报「等一会儿」是对的；全被判死时报「等一会儿」是把
 * 用户送去等一个不会发生的事（dsh-xdpool CHANGELOG 1.8.x 那条「等待」和
 * 「重新登录」不能混着报）。
 */
function poolReason(sameVersion, all, model, now, version) {
  if (all.length === 0) {
    return { reason: "empty", remedy: "池子里一个账号都没有：请在 WorkBuddy 桌面端登录后重新捕获凭据。", how: "empty" };
  }
  if (sameVersion.length === 0) {
    return {
      reason: "empty",
      remedy: `池子里的账号都属于另一个版本（当前要 ${version || "未指定"}）：`
        + "国内版与国际版的令牌互不通用，别把两个版本的凭据装进同一个池子。",
      how: "version-mismatch",
    };
  }
  let dead = 0, quota = 0, cooling = 0, coolingModel = 0, disabled = 0, ignored = 0;
  for (const a of sameVersion) {
    const r = eligibility({ accounts: [a] }, a, model, now);
    if (r.reason === "dead") dead++;
    else if (r.reason === "quota") quota++;
    else if (r.reason === "cooling") cooling++;
    else if (r.reason === "cooling_model") coolingModel++;
    else if (r.reason === "disabled") disabled++;
    else if (r.reason === "ignored") ignored++;
  }
  if (dead > 0) return { reason: "dead", remedy: REASONS.dead.remedy, how: `dead ${dead}/${sameVersion.length}` };
  if (quota > 0) return { reason: "quota", remedy: REASONS.quota.remedy, how: `quota ${quota}/${sameVersion.length}` };
  if (cooling > 0 || coolingModel > 0) {
    const both = cooling > 0 && coolingModel > 0;
    return {
      reason: both ? "cooling" : cooling > 0 ? "cooling" : "cooling_model",
      remedy: both ? REASONS.cooling.remedy : cooling > 0 ? REASONS.cooling.remedy : REASONS.cooling_model.remedy,
      how: `cooling ${cooling + coolingModel}/${sameVersion.length}`,
    };
  }
  if (disabled > 0) return { reason: "disabled", remedy: REASONS.disabled.remedy, how: `disabled ${disabled}/${sameVersion.length}` };
  if (ignored > 0) return { reason: "ignored", remedy: REASONS.ignored.remedy, how: `ignored ${ignored}/${sameVersion.length}` };
  return { reason: "unknown_account", remedy: remedyOf("unknown_account"), how: "unknown" };
}

// ==========================================================================
// ⑦ 把失败落到池子上（接线层拿到一次上游答复后调它）
// ==========================================================================

/**
 * 分类 → 落盘到池子状态，一步做完。
 *
 * ⚠️ **transient / content 一律什么都不写。** 这是本函数最重要的行为：
 * 网络抖动绝不能留下任何冷却痕迹，否则一个健康号会被误伤半天。
 * 而且额度冷却**不允许被后续的限流降级**成短冷却 —— 那是把一个已知没余额的
 * 号放出去再撞一次。
 *
 * @param {object} pool
 * @param {{accountId:string, model?:string|null, status:number|string|null,
 *          text?:string, headers?:any, now:number, context?:string, kind?:string}} o
 * @returns {{failure:object, cooldown:object, changed:boolean, accountId:string}}
 */
export function applyFailure(pool, o) {
  const now = toMs(o.now) ?? 0;
  const acct = pool && Array.isArray(pool.accounts)
    ? pool.accounts.find((a) => a && a.id === o.accountId)
    : null;
  const failure = classifyFailure(o.status, o.text, { headers: o.headers, now, context: o.context });

  const out = { failure, cooldown: null, changed: false, accountId: o.accountId };
  if (!acct) return out;

  /* 瞬时 / 内容类：只留一条诊断痕迹，不动任何状态。 */
  if (failure.kind === "transient" || failure.kind === "content") {
    acct.lastFailure = { kind: failure.kind, at: now, why: failure.why, evidence: failure.evidence };
    return out;
  }

  const m = o.model == null ? null : String(o.model);
  if (failure.scope === "account_model") {
    if (m == null) return out;   // 没有模型就无从定位这一格，如实不写
    const resetAt = failure.retryAfterMs == null ? null : now + failure.retryAfterMs;
    const cd = cooldownFor(failure.kind, { resetAt, now });
    acct.modelCooldowns = acct.modelCooldowns && typeof acct.modelCooldowns === "object" ? acct.modelCooldowns : {};
    const prev = toMs(acct.modelCooldowns[m]) || 0;
    if (cd.untilMs > prev) { acct.modelCooldowns[m] = cd.untilMs; out.changed = true; }
    out.cooldown = cd;
  } else {
    // 整号。resetAt 只在 rate_limit（account 粒度）时才用得上，quota/dead 一律不认。
    const resetAt = failure.kind === "rate_limit" && failure.retryAfterMs != null ? now + failure.retryAfterMs : null;
    const cd = cooldownFor(failure.kind, { resetAt, now });
    const prev = toMs(acct.cooldownUntilMs) || 0;
    if (cd.untilMs > prev) { acct.cooldownUntilMs = cd.untilMs; out.changed = true; }
    if (failure.kind === "quota") acct.quotaUntilMs = Math.max(toMs(acct.quotaUntilMs) || 0, cd.untilMs);
    if (failure.kind === "auth_dead") {
      acct.dead = true;
      acct.deadAt = now;
      acct.deadWhy = failure.why;
      acct.deadPhrase = failure.deadPhrase;
    }
    out.cooldown = cd;
  }
  acct.lastFailure = { kind: failure.kind, at: now, why: failure.why, evidence: failure.evidence };
  return out;
}

/**
 * 手动清冷却（面板的「清除所有冷却」按钮）。
 *
 * 清 dead 时**顺带清掉判死标记**：用户已经在桌面端重新登录过一次了，
 * 没理由还把它关在门外。不传 accountId 就是整池清。
 */
export function clearCooldowns(pool, accountId) {
  const list = pool && Array.isArray(pool.accounts) ? pool.accounts : [];
  let n = 0;
  for (const a of list) {
    if (!a) continue;
    if (accountId != null && a.id !== accountId) continue;
    let touched = false;
    if (a.cooldownUntilMs) { a.cooldownUntilMs = 0; touched = true; }
    if (a.quotaUntilMs) { a.quotaUntilMs = 0; touched = true; }
    if (a.modelCooldowns && Object.keys(a.modelCooldowns).length) { a.modelCooldowns = {}; touched = true; }
    if (a.dead) {
      a.dead = false;
      a.deadAt = null;
      a.deadWhy = null;
      a.deadPhrase = null;
      touched = true;
    }
    if (touched) n++;
  }
  return n;
}