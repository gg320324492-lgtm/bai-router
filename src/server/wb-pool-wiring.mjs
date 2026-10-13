/**
 * wb-pool-wiring.mjs —— 把账号池内核（wb-pool.mjs）接进中转的**接线层**（纯逻辑，零 IO、零网络）
 *
 * ## 分工
 *
 *   wb-pool.mjs      内核：五类失败五种处置、凭据新鲜度、粘性、选号。**不改它**。
 *   本模块           接线：读配置 → 建池 → 选号 → 回灌 → 给面板。**零 IO、零网络**：
 *                    时间源（opts.now）、哈希、会话 key、刷新动作（opts.refresh）、
 *                    JWT 到期解码（opts.tokenExpOf）**全部由调用方注入**，
 *                    所以 scripts/wb-pool-wiring-test.mjs 能直接 import 本文件求值，
 *                    不起进程、不发网络、不碰 %APPDATA%。
 *   server.mjs      唯一知道「令牌续期要 POST 到哪、续期后要写回哪份 config」的地方。
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
} from "./wb-pool.mjs";

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
  if (p == null) { wbRuntime.clear(); wbSticky.clear(); return; }
  wbRuntime.delete(p); wbSticky.delete(p);
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
 * @param {string|null} [opts.sessionKey]   会话 key。**没有就别传**（探测/健康检查不污染粘性表）
 * @param {number} opts.now                 时间源（必填）
 * @param {Function} [opts.refresh]         `(p, account) => Promise<新令牌>`；不给就永不主动续期
 * @param {Function} [opts.tokenExpOf]      `(tok) => epoch ms | null`；不给就只认「没令牌」
 * @param {Function} [opts.onPersist]       续期成功后把新令牌写回配置用
 * @returns {Promise<object>} `{ok, accountId, token, ...}` 或 `{ok:false, reason, remedy, ...}`
 */
export async function wbPickAccount(cfg, p, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const pool = wbPoolOf(cfg, p);
  if (!pool) {
    return { ok: false, reason: "empty", remedy: "这个渠道还没有配置块：到面板里配置一次。", total: 0, eligible: 0, pool: null };
  }

  /* 合成池 + 压根没令牌 → 报**改动前那句一字不差的话**，不给「已停用」之类的新解释。 */
  if (pool.synthetic && !pool.accounts[0].accessToken) {
    return { ok: false, reason: "no_token", remedy: null, total: 1, eligible: 0, pool };
  }

  const r = acquire(pool, {
    version: p, model: opts.model, sessionKey: opts.sessionKey, now,
    prefer: opts.prefer || null,
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
 */
export function wbNoteFailure(cfg, p, o) {
  const pool = wbPoolOf(cfg, p);
  if (!pool || !o || !o.accountId) return null;
  return applyFailure(pool, {
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
  return applyFailure(pool, {
    accountId,
    model: null,
    status: err && err.status != null ? err.status : null,
    text: (err && (err.text || err.body)) || (err && err.message) || "",
    headers: err && err.headers,
    now: Number(opts.now) || Date.now(),
    context: "refresh",            // ★★★ 全仓库唯一一处
  });
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

/** 有几段对话正粘在这个账号上（面板显示「N 段对话」用；不显示凭据，只显示条数）。 */
function stickyHold(p, accountId) {
  if (!accountId) return 0;
  const m = wbSticky.get(p);
  if (!m) return 0;
  let n = 0;
  for (const v of m.values()) if (v === accountId) n++;
  return n;
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