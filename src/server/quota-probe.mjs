/**
 * quota-probe.mjs —— 供应商配额的「真探测」（纯逻辑：IO 由调用方注入、零时钟、零依赖）
 *
 * ── 它补的是哪个洞 ────────────────────────────────────────────────────────
 *
 * quota.mjs 是**被动信号**：用户自己设一个 token 预算，我们拿**账本里已记的数**
 * 去对照，超了就让那家歇着。它问的是「我们花了多少」，**不知道上游还剩多少** ——
 * 于是有两种真实的失败它看不见：
 *   ① 账本漏记（换客户端、换机器、手工改过账本）⇒ 阀永远不开，而上游额度早用完了；
 *   ② 用户在别处（网页控制台、另一台机器）把额度花掉了 ⇒ 同样看不见。
 *
 * magpie 的 internal/provider/quotas.go 走的是另一条路：**拿登录态去问供应商**
 * 「你还剩多少」。本模块补的就是这一半。
 *
 * ── magpie 的对应物 ────────────────────────────────────────────────────────
 *
 *   · internal/provider/quotas.go   —— 额度的**形状**（SubscriptionQuota / QuotaSpan：
 *     used / remaining / resetsAt / unit），本模块的返回结构照它对齐。
 *   · internal/provider/balance.go  —— **问厂商**的那层：每家一张「端点 + 读法」的表
 *     （balanceSourceOf）；OpenRouter 的读法在 readOpenRouter（第 431 行）。
 *   · internal/provider/planquota.go —— 套餐窗口（planQuotaSourceOf）：OpenCode Go 的
 *     /zen/go/v1/usage、MiniMax 的 /v1/token_plan/remains。
 *
 * ── 每家的探测接口与字段（探到的 = 有出处；没出处的写「候选」）────────────
 *
 *   or（OpenRouter）—— **探得到，两处**：
 *     ① GET /api/v1/credits → data.total_credits（总额）/ data.total_usage（已用）
 *        出处：magpie internal/provider/balance.go:65 与 readOpenRouter；
 *        OpenRouter 官方文档「Get remaining credits」。
 *        ⚠ 只有**管理密钥**能查；普通推理密钥回 403（本仓 or 用的就是推理密钥）。
 *     ② GET /api/v1/auth/key → free_model_daily_requests.limit / .used
 *        出处：**本仓** server.mjs 的 orFetchQuota —— 已经在真跑的那一处，不是猜的。
 *
 *   zen（OpenCode Zen）—— **Go 档探得到，免费档探不到**：
 *     GET /zen/go/v1/usage → usage.rolling.percent / usage.weekly.percent /
 *     usage.monthly.percent（各自带 resetsAt）
 *     出处：magpie internal/provider/planquota.go:44 与 readOpenCodeGo。
 *     免费档**没有**这个接口：magpie 实测 /zen/v1/usage 与 /inference/v1/usage 都是 404，
 *     额度只在 OpenCode 控制台（https://opencode.ai/console → Overview → Credits）。
 *
 *   mm / qd / wb / wbai / sn / bai —— **候选端点**（表里逐条标了「候选」）。
 *     这些厂商没有公开文档；端点是从**本仓已在用的基址与鉴权方式**推断的，
 *     字段名同样是候选。所以本模块**只有真的读到了那个字段才算数** ——
 *     读不到就标 unknown，**绝不**拿别的数（别家的、账本的）顶替。
 *
 * ── 探不到的那些怎么表现 ──────────────────────────────────────────────────
 *
 *   一律 `known:false` + `used:null, limit:null` + 一句人话原因。
 *   ⚠ **绝不**把「探不到」写成「额度是 0」：那会让用户以为账号被封了，
 *     而真相可能只是这条网络不通、令牌没续期、或厂商根本没有这个接口。
 *   ⚠ 上游**真的**报 0（used=0）是 `known:true, used:0` —— 与「探不到」是两件事，
 *     面板必须能分开（靠 resolveQuota 的 origin / originLabel）。
 *
 * ── 与 magpie 有意不同的三点 ───────────────────────────────────────────────
 *
 *   ① **magpie 把厂商的读法编译进 Go 表；我们把它做成数据。**
 *      候选表是纯 JSON（端点、字段路径、读法），调用方能在配置里改 —— 因为我们
 *      这七家没有文档、官方随时会改（实测过的结论明天就可能过期）。写死成代码
 *      就等于把「过期」这件事留给一次发版。
 *   ② **magpie 报的是「一串金额」（$12.34）；我们只报「已用 / 上限」。**
 *      本仓的口径是 token 数（quota.mjs 的 QUOTA_UNIT），这里冒出美元就会与那条
 *      口径打架。所以**只有余额、没有上限**的来源一律不采用（见下节）。
 *   ③ **magpie 的窗口是「已用百分比」；我们多报一层「单位」。**
 *      只有百分比时 limit 记 100 —— 那是这个百分数的**分母**，不是绝对额度；
 *      unit 记 unknown，免得下游把 37/100 当成「37 个 token 用了 100」。
 *
 * ── 余额为什么不算数（②的展开）───────────────────────────────────────────
 *
 *   契约是「已用 / 上限」。有些厂商只报**余额**（还剩多少），报不出「买过多少」——
 *   把它塞进 limit，面板就会显示成「上限 = 余额」，于是 used/limit 变成胡话。
 *   所以余额型来源**一律不采用**：宁可显示 unknown，也不显示一个算不出比例的数。
 *
 * ── 硬规矩 ────────────────────────────────────────────────────────────────
 *
 *   · **只读**：只发 GET/HEAD，白名单见 {@link READ_ONLY_METHODS}，且**在发请求
 *     之前**再查一遍 —— 非白名单的方法根本不会发出去（配置写错也不行）。
 *   · **零依赖**：不 import 本仓库任何其它模块。脱敏自己写一份：redact.mjs 的
 *     口径是给**文本**设计的（等长掩码），而这里要洗的是**结构**。
 *   · **零时钟**：现在几点一律由 opts.now 传入，模块内不出现 Date.now()。
 *   · **绝不猜**：读不到就是读不到。
 */

/* ══════════════════════════════════════════════════════════════════════
 * ① 常量
 * ══════════════════════════════════════════════════════════════════════ */

/** 计量单位。unknown = 上游只给了百分比/无量纲，不是「忘了填」。 */
export const UNIT_TOKENS = "tokens";
export const UNIT_REQUESTS = "requests";
export const UNIT_CREDITS = "credits";
export const UNIT_MONEY = "money";
export const UNIT_UNKNOWN = "unknown";

/** 数字的来源：上游亲口说的 vs 我们按账本估的。 */
export const ORIGIN_UPSTREAM = "upstream";
export const ORIGIN_LEDGER = "ledger";
export const ORIGIN_NONE = "none";

/** 来源的人话标签（面板照它显示，用户要能一眼看出这个数有多可信）。 */
export const ORIGIN_LABELS = Object.freeze({
  [ORIGIN_UPSTREAM]: "上游报的",
  [ORIGIN_LEDGER]: "按账本估的",
  [ORIGIN_NONE]: "探不到",
});

/**
 * 只读闸：探测只许这两种方法。
 *
 * 为什么是硬闸而不是注释：探测是本模块唯一会碰网络的部分，而「探一下额度」
 * 这种需求最容易被人顺手加成 POST（有些厂商的额度查询确实是 POST）。
 * 一次 POST 可能就改状态或消耗额度 —— 而用户只是想看一眼还剩多少。
 */
export const READ_ONLY_METHODS = Object.freeze(["GET", "HEAD"]);

/** 渠道 id 的别名 → 本仓的渠道 id。 */
const PROVIDER_ALIASES = Object.freeze({
  bai: "bai", "b.ai": "bai", baipass: "bai",
  sn: "sn", sensenova: "sn",
  wb: "wb", workbuddy: "wb",
  wbai: "wbai", "workbuddy-ai": "wbai", "workbuddy_ai": "wbai",
  zen: "zen", opencode: "zen",
  qd: "qd", qoder: "qd",
  mm: "mm", minimax: "mm",
  or: "or", openrouter: "or",
});

/** 归一渠道 id；认不出就原样返回（小写去空白），由上层报「不认识的渠道」。 */
function normProvider(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return PROVIDER_ALIASES[s] || s;
}

/** 只认有限数；null / undefined / NaN / Infinity 一律当「没有」。 */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 数字或 null：字符串数字也收（上游有时给 "12"）。 */
function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 字段读法：点分路径 + 若干算术
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 字段规格：一条「这个数在应答的哪儿、怎么算」的说法。
 *
 *   path   —— 必填。点分路径，数组下标用数字段名（"0"），"*" 表示数组的每一项。
 *   plus   —— 可选。加上另一个路径的值（"总额 = 余额 + 已用" 这类）。
 *   minus  —— 可选。减去另一个路径的值。
 *   scale  —— 可选。乘数（把厂商的单位换算成我们报的 unit）。
 *   pick   —— 可选。路径里用了 "*"（拿到一组值）时取哪个："first"(默认)/
 *             "max"/"min"/"sum"。
 *   percent—— 可选。true 表示这个数**本身就是百分比**（0–100），不是绝对量。
 *
 * ⚠ 为什么用「数据」而不是函数：候选表要能进配置文件（见文件头 ①）。
 *   一旦读法写成函数，用户就没法在配置里改端点与字段名了。
 */
function splitPath(path) {
  return String(path == null ? "" : path).split(".").filter((s) => s !== "");
}

/** 路径上的所有取值（"*" 会展开成多个）。 */
function pathValues(node, segs, i) {
  if (i >= segs.length) return [node];
  const seg = segs[i];
  if (seg === "*") {
    const items = Array.isArray(node)
      ? node
      : (node && typeof node === "object" ? Object.values(node) : []);
    const out = [];
    for (const it of items) out.push(...pathValues(it, segs, i + 1));
    return out;
  }
  if (Array.isArray(node)) {
    const idx = Number(seg);
    if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return [];
    return pathValues(node[idx], segs, i + 1);
  }
  if (node && typeof node === "object") {
    if (!Object.prototype.hasOwnProperty.call(node, seg)) return [];
    return pathValues(node[seg], segs, i + 1);
  }
  return [];
}

function pickVal(vals, pick) {
  if (!vals.length) return null;
  if (pick === "max") return Math.max(...vals);
  if (pick === "min") return Math.min(...vals);
  if (pick === "sum") return vals.reduce((a, b) => a + b, 0);
  return vals[0];
}

/** 一组规格（允许并列多个，第一个读得出数的胜出）。 */
function specList(slot) {
  if (slot == null) return [];
  if (Array.isArray(slot)) return slot.filter((s) => s && typeof s === "object" && s.path != null);
  if (typeof slot === "object" && slot.path != null) return [slot];
  return [];
}

/**
 * 读一个数出来。
 *
 * ⚠ **读不到就是 null** —— 绝不退化成 0。0 是一个有意义的答案（上游说「你还没用」），
 *   而 null 是「它没说」。把两者混起来，面板就会把「厂商没接口」显示成「额度是 0」，
 *   用户会以为账号被封了。
 */
function readSlot(body, slot) {
  for (const s of specList(slot)) {
    const vals = pathValues(body, splitPath(s.path), 0).map(toNum).filter((v) => v !== null);
    if (!vals.length) continue;
    let v = pickVal(vals, s.pick || "first");
    if (s.plus) {
      const p = readSlot(body, { path: s.plus, pick: s.pick });
      if (p.value === null) continue;
      v += p.value;
    }
    if (s.minus) {
      const m = readSlot(body, { path: s.minus, pick: s.pick });
      if (m.value === null) continue;
      v -= m.value;
    }
    if (typeof s.scale === "number" && Number.isFinite(s.scale)) v *= s.scale;
    return { value: v, path: s.path, spec: s };
  }
  return { value: null, path: null, spec: null };
}

/**
 * 时刻：把上游给的各种写法归一成 epoch 毫秒。
 *
 * ⚠ `Date.parse` 是**解析**，不是取「现在」—— 零时钟的规矩不破。
 */
function toMs(raw, unit, now) {
  if (raw == null) return null;
  if (unit === "iso") {
    if (typeof raw !== "string") return null;
    const n = Date.parse(raw);
    return Number.isFinite(n) ? n : null;
  }
  const n = toNum(raw);
  if (n === null) return null;
  if (unit === "epoch_s") return Math.round(n * 1000);
  if (unit === "epoch_ms") return Math.round(n);
  if (unit === "secs_from_now") {
    if (!Number.isFinite(now)) return null;
    return Math.round(now + n * 1000);
  }
  return null;
}

/** 读一个重置时刻出来。 */
function readReset(body, slot, now) {
  for (const s of specList(slot)) {
    for (const raw of pathValues(body, splitPath(s.path), 0)) {
      const ms = toMs(raw, s.unit || "epoch_ms", now);
      if (ms !== null) return { value: ms, path: s.path };
    }
  }
  return { value: null, path: null };
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 脱敏：raw 落盘前必须洗过
 * ══════════════════════════════════════════════════════════════════════ */

/** 键名归一：去掉 - 与 _，全小写。 */
function normKey(k) {
  return String(k == null ? "" : k).toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * 哪些键名算「凭据」。
 *
 * ⚠ "key" 也算：有些上游用 "key" 装 API Key，而本仓的红线是「真实 Key 绝不落盘」。
 *   宁可多洗一个无害的字段，也不可漏洗一个真凭据。
 */
const SECRET_KEYS = new Set([
  "authorization", "proxyauthorization", "auth", "authtoken", "bearer",
  "token", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "jwt",
  "apikey", "apisecret", "xapikey", "key", "keys", "secret", "clientsecret",
  "password", "passwd", "pwd", "cookie", "setcookie", "session", "sessionid",
  "credential", "credentials", "privatekey", "sign", "signature", "apitoken",
]);

/** 把字符串里的明文凭据换掉（上游常把请求里的东西原样回显在错误正文里）。 */
function scrubSecrets(value, secrets) {
  const list = (secrets || []).map((s) => String(s || "")).filter((s) => s.length >= 6);
  if (typeof value === "string") {
    let out = value;
    for (const s of list) out = out.split(s).join("[已脱敏]");
    // 上游的错误正文常把整个 Authorization 头原样贴回来：即便调用方忘了把
    // 令牌列进 secrets，也不能让它原样落进台账。
    return out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [已脱敏]");
  }
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, list));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = scrubSecrets(value[k], list);
    return out;
  }
  return value;
}

/**
 * 洗一份上游应答。
 *
 * @param {any} raw 上游应答（结构化）
 * @param {string[]} [secrets] 已知明文（如本次用的 key）：出现即抹
 * @returns {any} 脱敏后的副本（**不改原对象**）
 */
export function redactAnswer(raw, secrets) {
  if (raw === null || typeof raw !== "object") return scrubSecrets(raw, secrets);
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null;          // 循环引用：留个 null，别无限递归
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v)) {
      out[k] = SECRET_KEYS.has(normKey(k)) ? "[已脱敏]" : walk(v[k]);
    }
    return out;
  };
  return scrubSecrets(walk(raw), secrets);
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 候选表：每家的「端点 + 读法」
 * ══════════════════════════════════════════════════════════════════════ */

/** 通用「已用」的候选字段名（按最像的排前面）。 */
const GENERIC_USED = Object.freeze([
  { path: "data.used" }, { path: "data.used_quota" }, { path: "data.usedQuota" },
  { path: "data.usage" }, { path: "data.consumed" }, { path: "data.total_used" },
  { path: "used" }, { path: "usedQuota" }, { path: "used_quota" },
  { path: "quota.used" }, { path: "usage" }, { path: "consumed" }, { path: "total_used" },
]);

/** 通用「上限」的候选字段名。 */
const GENERIC_LIMIT = Object.freeze([
  { path: "data.limit" }, { path: "data.total" }, { path: "data.quota" },
  { path: "data.total_limit" }, { path: "data.max" },
  { path: "limit" }, { path: "quota" }, { path: "total" }, { path: "total_limit" }, { path: "max" },
]);

/**
 * 每家的默认候选表。
 *
 * ⚠ **只有 or 与 zen(Go 档) 的端点是有出处的**；其余各家的条目都标了「候选」，
 *   端点是**推断**的、字段名也是**候选**。所以「探到」的定义必须是
 *   「真的在应答里读到了那个字段」，而不是「那个端点回了 200」。
 *   表是数据（纯 JSON），调用方可以在配置里改端点与字段名。
 */
export const PROBE_SPECS = Object.freeze({
  or: {
    base: "https://openrouter.ai/api/v1",
    candidates: [
      {
        id: "credits",
        url: "{base}/credits",
        source: "GET /api/v1/credits → data.total_credits / data.total_usage",
        unit: UNIT_MONEY,
        used: [{ path: "data.total_usage" }],
        limit: [{ path: "data.total_credits" }],
        note: "只有管理密钥能查；普通推理密钥回 403（此时自动退到下一条）",
      },
      {
        id: "auth-key",
        url: "{base}/auth/key",
        source: "GET /api/v1/auth/key → free_model_daily_requests.limit / .used",
        unit: UNIT_REQUESTS,
        used: [{ path: "free_model_daily_requests.used" }],
        limit: [{ path: "free_model_daily_requests.limit" }],
        note: "本仓 server.mjs 的 orFetchQuota 已经在真跑这个接口",
      },
    ],
  },

  zen: {
    base: "https://opencode.ai/zen/v1",
    candidates: [
      {
        id: "go-usage",
        url: "{base}/usage",
        // 只有 Go 档有这个接口；免费档的 /zen/v1/usage 实测 404。
        onlyWhenBaseContains: ["/zen/go/"],
        source: "GET /zen/go/v1/usage → usage.rolling.percent / usage.weekly.percent / usage.monthly.percent",
        unit: UNIT_UNKNOWN,
        windows: [
          {
            name: "rolling",
            used: [{ path: "usage.rolling.percent", percent: true }],
            resetAt: [{ path: "usage.rolling.resetsAt", unit: "iso" }],
          },
          {
            name: "weekly",
            used: [{ path: "usage.weekly.percent", percent: true }],
            resetAt: [{ path: "usage.weekly.resetsAt", unit: "iso" }],
          },
          {
            name: "monthly",
            used: [{ path: "usage.monthly.percent", percent: true }],
            resetAt: [{ path: "usage.monthly.resetsAt", unit: "iso" }],
          },
        ],
        note: "上游只给百分比，没有绝对额度：limit 记 100（百分数的分母），unit 记 unknown",
      },
    ],
    noEndpoint: [
      {
        when: { baseContains: ["/zen/go/"] },
        reason: "Go 档的 /zen/go/v1/usage 没读到额度字段（应答形状可能变了）",
      },
      {
        when: {},
        reason: "OpenCode Zen 的免费档没有额度查询接口（magpie 实测 /zen/v1/usage 与 /inference/v1/usage 都是 404）；"
          + "额度只在 OpenCode 控制台（https://opencode.ai/console → Overview → Credits）显示",
      },
    ],
  },

  mm: {
    base: "https://agent.minimax.cn/mavis/api/v1/llm",
    candidates: [
      {
        id: "token-plan-remains",
        url: "{origin}/v1/token_plan/remains",
        source: "候选端点 GET /v1/token_plan/remains → model_remains[0].current_interval_usage_count / .current_interval_total_count",
        unit: UNIT_REQUESTS,
        used: [{ path: "model_remains.0.current_interval_usage_count" }],
        limit: [{ path: "model_remains.0.current_interval_total_count" }],
        resetAt: [{ path: "model_remains.0.end_time", unit: "epoch_s" }],
        note: "候选：字段名抄 magpie 的 readMiniMaxPlan，但那是 MiniMax Coding Plan 的接口"
          + "（api.minimaxi.com），本仓 mm 是会员档（agent.minimax.cn），两边不一定通用；"
          + "只取第一个模型桶",
      },
    ],
  },

  qd: {
    base: "https://api2-v2.qoder.sh/model/v1",
    candidates: [
      {
        id: "me-quota",
        url: "https://openapi.qoder.sh/sash/api/v1/me/quota",
        source: "候选端点 GET /sash/api/v1/me/quota → （字段名待实测）",
        unit: UNIT_UNKNOWN,
        used: GENERIC_USED,
        limit: GENERIC_LIMIT,
        note: "候选：magpie 实测过同族的 /sash/api/v1/me/campaigns（签到），"
          + "但 me/quota 是推断的",
      },
      {
        id: "me-usage",
        url: "https://openapi.qoder.sh/sash/api/v1/me/usage",
        source: "候选端点 GET /sash/api/v1/me/usage → （字段名待实测）",
        unit: UNIT_UNKNOWN,
        used: GENERIC_USED,
        limit: GENERIC_LIMIT,
        note: "候选：同上",
      },
      {
        id: "me-quota-cn",
        url: "https://openapi.qoder.com.cn/sash/api/v1/me/quota",
        source: "候选端点 GET /sash/api/v1/me/quota（国内版）→ （字段名待实测）",
        unit: UNIT_UNKNOWN,
        used: GENERIC_USED,
        limit: GENERIC_LIMIT,
        note: "候选：magpie 的国内版签到端点是 openapi.qoder.com.cn",
      },
    ],
  },

  wb: {
    base: "https://www.workbuddy.cn",
    candidates: [
      {
        id: "v3-user-quota",
        url: "{base}/v3/user/quota",
        source: "候选端点 GET /v3/user/quota → （字段名待实测）",
        unit: UNIT_UNKNOWN,
        used: GENERIC_USED,
        limit: GENERIC_LIMIT,
        note: "候选：本仓已实测的 WorkBuddy 接口只有 /v3/config（模型目录与倍率）与 "
          + "/v2/plugin/auth/token/refresh（续期，POST）；额度端点是推断的",
      },
      {
        id: "v2-plugin-auth-quota",
        url: "{base}/v2/plugin/auth/quota",
        source: "候选端点 GET /v2/plugin/auth/quota → （字段名待实测）",
        unit: UNIT_UNKNOWN,
        used: GENERIC_USED,
        limit: GENERIC_LIMIT,
        note: "候选：同上",
      },
    ],
  },

  wbai: {
    base: "https://www.workbuddy.ai",
    candidates: [
      {
        id: "v3-user-quota",
        url: "{base}/v3/user/quota",
        source: "候选端点 GET /v3/user/quota → （字段名待实测）",
        unit: UNIT_UNKNOWN,
        used: GENERIC_USED,
        limit: GENERIC_LIMIT,
        note: "候选：同 wb（国际版）。⚠ 结果不能给 .cn 用、也不能反过来 —— 两版是两个域",
      },
      {
        id: "v2-plugin-auth-quota",
        url: "{base}/v2/plugin/auth/quota",
        source: "候选端点 GET /v2/plugin/auth/quota → （字段名待实测）",
        unit: UNIT_UNKNOWN,
        used: GENERIC_USED,
        limit: GENERIC_LIMIT,
        note: "候选：同 wb（国际版）",
      },
    ],
  },

  sn: {
    base: "https://token.sensenova.cn",
    candidates: [
      {
        id: "v1-user-info",
        url: "{origin}/v1/user/info",
        source: "候选端点 GET /v1/user/info → （字段名待实测）",
        unit: UNIT_UNKNOWN,
        used: GENERIC_USED,
        limit: GENERIC_LIMIT,
        note: "候选：SenseNova 的控制台在别处，token.sensenova.cn 只管发令牌；额度端点是推断的",
      },
      {
        id: "v1-quota",
        url: "{origin}/v1/quota",
        source: "候选端点 GET /v1/quota → （字段名待实测）",
        unit: UNIT_UNKNOWN,
        used: GENERIC_USED,
        limit: GENERIC_LIMIT,
        note: "候选：同上",
      },
    ],
  },

  bai: {
    base: "https://api.b.ai",
    candidates: [
      {
        id: "usage-token",
        url: "{origin}/api/usage/token",
        source: "候选端点 GET /api/usage/token → （中转口径，字段名待实测）",
        unit: UNIT_MONEY,
        used: [{ path: "data.used_quota", scale: 1 / 500000 }, { path: "data.used", scale: 1 / 500000 }],
        limit: [{ path: "data.quota", plus: "data.used_quota", scale: 1 / 500000 }, { path: "data.limit", scale: 1 / 500000 }],
        note: "候选：new-api/one-api 中转的余额查询（magpie internal/provider/balance.go 的 "
          + "newAPIKeyUsage）；中转的额度单位是 1 美元 = 500000（magpie 同款换算）",
      },
      {
        id: "user-self",
        url: "{origin}/api/user/self",
        source: "候选端点 GET /api/user/self → （中转口径，字段名待实测）",
        unit: UNIT_MONEY,
        used: [{ path: "data.used_quota", scale: 1 / 500000 }, { path: "data.used", scale: 1 / 500000 }],
        limit: [{ path: "data.quota", plus: "data.used_quota", scale: 1 / 500000 }, { path: "data.limit", scale: 1 / 500000 }],
        note: "候选：new-api 的账号查询要**访问令牌**（不是推理密钥），本仓的 bai 用的可能不是它",
      },
    ],
  },
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 规格解析：默认表 + 配置覆盖
 * ══════════════════════════════════════════════════════════════════════ */

/** 基址：配置里的上游优先 —— 用户改过上游，探测必须跟着走。 */
function baseFor(id, opts) {
  if (!opts || typeof opts !== "object") return null;
  const bases = opts.bases;
  if (bases && typeof bases === "object" && bases[id] != null) return String(bases[id]).trim();
  if (typeof opts.base === "string" && opts.base.trim()) return opts.base.trim();
  return null;
}

/**
 * 这一家的探测规格（默认表 + 配置覆盖）。
 *
 * ⚠ 覆盖是**整块替换 candidates**：半替换（配置里只写一条，结果默认的两条还在）
 *   会让用户以为「我配的端点没生效」，实际是它排在后面被前一条挡住了。
 */
function specFor(id, opts) {
  const def = PROBE_SPECS[id] || null;
  const over = opts && opts.specs && typeof opts.specs === "object" ? opts.specs[id] : null;
  let spec = def
    ? { ...def }
    : { base: "", candidates: [] };
  if (over && typeof over === "object") {
    spec = { ...spec, ...over };
    if (Array.isArray(over.candidates)) spec.candidates = over.candidates;
  }
  const base = baseFor(id, opts);
  if (base) spec.base = base;
  return spec;
}

/** 模板替换：{base}（去尾斜杠的基址）与 {origin}（基址的协议 + 主机）。 */
function fillTemplate(url, base, origin) {
  return String(url == null ? "" : url)
    .split("{base}").join(base)
    .split("{origin}").join(origin);
}

/** 基址的 origin（协议 + 主机 + 端口）。 */
function originOf(base) {
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 探测
 * ══════════════════════════════════════════════════════════════════════ */

/** 候选要不要用（按基址里的标记筛）。 */
function candidateApplies(cand, base) {
  const marks = Array.isArray(cand.onlyWhenBaseContains) ? cand.onlyWhenBaseContains : [];
  if (!marks.length) return true;
  const b = String(base || "").toLowerCase();
  return marks.some((m) => b.includes(String(m).toLowerCase()));
}

/** 规格里的「没有端点」说明（按 when 挑第一条匹配的）。 */
function noEndpointReason(spec, base) {
  const list = Array.isArray(spec.noEndpoint) ? spec.noEndpoint : [];
  const b = String(base || "").toLowerCase();
  for (const item of list) {
    const when = item && item.when ? item.when : {};
    const marks = Array.isArray(when.baseContains) ? when.baseContains : [];
    if (!marks.length || marks.some((m) => b.includes(String(m).toLowerCase()))) {
      return String(item.reason || "这家没有可用的额度查询接口");
    }
  }
  return "这家没有可用的额度查询接口";
}

/** 请求头（调用方注入；这里只取出来用）。 */
function resolveHeaders(opts, id) {
  const h = opts && opts.headers;
  let raw = {};
  if (typeof h === "function") {
    try { raw = h(id) || {}; } catch { raw = {}; }
  } else if (h && typeof h === "object") {
    raw = h;
  }
  const out = {};
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (v == null) continue;
    out[String(k).toLowerCase()] = String(v);
  }
  return out;
}

/** 有没有可用的凭据 —— 没有就不该发请求（发了也只是白挨一个 401）。 */
function hasCredential(headers, spec) {
  const names = Array.isArray(spec && spec.authHeaders) && spec.authHeaders.length
    ? spec.authHeaders
    : ["authorization", "x-api-key", "api-key", "cookie"];
  return names.some((n) => {
    const v = headers[String(n).toLowerCase()];
    return typeof v === "string" && v.trim() !== "";
  });
}

/** 本次要抹掉的明文（调用方给：本次用的 key / 令牌）。 */
function secretList(opts, id) {
  const s = opts && opts.secrets;
  let list = [];
  if (typeof s === "function") {
    try { list = s(id) || []; } catch { list = []; }
  } else if (Array.isArray(s)) {
    list = s;
  }
  return list.map((x) => String(x || "")).filter((x) => x.length > 0);
}

/** 上游应答体（结构化）。解析不出来就是 null —— 不猜。 */
function bodyOf(res) {
  if (!res || typeof res !== "object") return null;
  if (res.json !== undefined && res.json !== null) return res.json;
  const text = typeof res.text === "string" ? res.text : "";
  if (!text.trim()) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/** 一句人话（截断 + 脱敏）。 */
function shortText(s, max = 160) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 一条候选的标称（用于错误串与 source）。 */
function labelOf(cand) {
  return shortText(cand.source || cand.id || "额度接口", 90);
}

/**
 * 出错时带上上游自己说的那句话。
 *
 * ⚠ 只取 JSON 应答的片段：HTML 错误页对用户没有意义（magpie 同一个判断：
 *   「a page of HTML says nothing」），而 JSON 里那句「只有管理密钥能查」
 *   恰恰是用户下一步该做什么的唯一线索。
 */
function excerptOf(res) {
  const t = res && typeof res.text === "string" ? res.text.trim() : "";
  if (!t.startsWith("{")) return "";
  const s = shortText(t, 120);
  return s ? `：${s}` : "";
}

/**
 * 读一个窗口。
 *
 * ⚠ **只有「已用」与「上限」都读到（或已用本身是百分比）才算数**：
 *   只有一个孤零零的 limit（比如某个模型的 max context）会被当成额度上限，
 *   那比「探不到」更坏 —— 它会显示成一个看着很真的假数。
 */
function evalWindow(body, w, now) {
  const usedR = readSlot(body, w.used);
  const limitR = readSlot(body, w.limit);
  const resetR = readReset(body, w.resetAt, now);
  const percent = !!(usedR.spec && usedR.spec.percent);
  let used = usedR.value;
  let limit = limitR.value;
  if (percent && limit === null) limit = 100;   // 百分数的分母，不是绝对额度
  if (used === null) return null;
  if (limit === null && !percent) return null;
  return {
    name: w.name || "",
    used,
    limit,
    resetAtMs: resetR.value,
    percent,
    usedPath: usedR.path,
    limitPath: limitR.path,
  };
}

/** 哪条窗口更紧（比例高的那条；一样则先重置的那条）。 */
function tighter(a, b) {
  const pct = (w) => {
    if (w.used == null) return 0;
    if (w.limit != null && w.limit > 0) return w.used / w.limit;
    if (w.percent) return w.used / 100;
    return 0;
  };
  const pa = pct(a);
  const pb = pct(b);
  if (pa !== pb) return pa > pb;
  const ra = a.resetAtMs == null ? Infinity : a.resetAtMs;
  const rb = b.resetAtMs == null ? Infinity : b.resetAtMs;
  return ra < rb;
}

/** 从应答里挑出最紧的那条窗口。 */
function pickWindow(body, cand, now) {
  const wins = Array.isArray(cand.windows) && cand.windows.length
    ? cand.windows
    : [{ name: "", used: cand.used, limit: cand.limit, resetAt: cand.resetAt }];
  let best = null;
  for (const w of wins) {
    const e = evalWindow(body, w, now);
    if (!e) continue;
    if (!best || tighter(e, best)) best = e;
  }
  if (!best) return null;
  return {
    ...best,
    unit: best.percent ? UNIT_UNKNOWN : (cand.unit || UNIT_UNKNOWN),
  };
}

/** source：哪个接口、哪个字段（面板照它显示，用户要能核对）。 */
function sourceOf(cand, win) {
  const bits = [String(cand.source || "")];
  if (win.name) bits.push(`窗口 ${win.name}`);
  const usedLabel = win.usedPath ? `${win.usedPath}${win.percent ? "（百分比）" : ""}` : "—";
  const limitLabel = win.limitPath
    ? win.limitPath
    : (win.percent ? "100（这个百分数的分母，不是绝对额度）" : "—");
  bits.push(`实读 ${usedLabel} / ${limitLabel}`);
  if (cand.note) bits.push(`注意：${cand.note}`);
  return bits.filter(Boolean).join("｜");
}

/** raw 太大就整个丢掉 —— 台账不该被一个巨型应答撑爆。 */
function rawOf(body, secrets) {
  let text;
  try {
    text = JSON.stringify(body);
  } catch {
    return null;
  }
  if (text.length > 32768) return null;
  return redactAnswer(body, secrets);
}

/**
 * 探一家的额度。
 *
 * @param {string} provider 渠道 id（bai/sn/wb/wbai/zen/qd/mm/or；也认别名）
 * @param {object} opts
 *   · now      —— **必填**，epoch 毫秒（模块自己不取时刻）
 *   · get      —— **必填**，IO 注入：async ({url, method, headers}) →
 *                 { status, text } 或 { status, json }。模块只发只读请求。
 *   · headers  —— 请求头：对象，或 function(provider) → 对象
 *   · secrets  —— 要从应答/错误里抹掉的明文：数组，或 function(provider) → 数组
 *   · bases    —— { provider: 基址 }，覆盖默认基址（用配置里的上游）
 *   · base     —— 单家探测时的基址字符串
 *   · specs    —— { provider: 规格 }，覆盖默认候选表（**整块替换 candidates**）
 * @returns {Promise<object>} 契约见文件头
 */
export async function probeQuota(provider, opts = {}) {
  const id = normProvider(provider);
  const now = num(opts.now);
  if (now === null) {
    throw new TypeError(
      "probeQuota 需要 opts.now（epoch 毫秒）：重置时刻与「已过期」的判断都以「现在」为基准"
    );
  }

  const base = { provider: id, known: false, used: null, limit: null, resetAtMs: null, unit: UNIT_UNKNOWN, source: "", raw: null, error: null };

  const spec = specFor(id, opts);
  const rawBase = String(spec.base || "").replace(/\/+$/, "");
  const origin = originOf(rawBase);
  const secrets = secretList(opts, id);

  const candidates = Array.isArray(spec.candidates) ? spec.candidates : [];
  if (!candidates.length) {
    return { ...base, error: noEndpointReason(spec, rawBase) };
  }

  const get = opts.get;
  if (typeof get !== "function") {
    return { ...base, error: "没有注入 IO（opts.get）：本模块是纯逻辑，探测请求由调用方发起" };
  }

  const headers = resolveHeaders(opts, id);
  if (!hasCredential(headers, spec)) {
    return {
      ...base,
      error: "没有可用的登录态（缺 authorization / x-api-key / cookie 头），跳过探测 —— "
        + "未登录就发探测请求只会被算成一次失败请求",
    };
  }

  const reasons = [];
  for (const cand of candidates) {
    if (!cand || typeof cand !== "object") continue;
    if (!candidateApplies(cand, rawBase)) continue;

    const url = fillTemplate(cand.url, rawBase, origin);
    const method = String(cand.method || "GET").toUpperCase();

    // 只读硬闸：**在发请求之前**查。配置写错成 POST 也不能发出去。
    if (!READ_ONLY_METHODS.includes(method)) {
      reasons.push(`${labelOf(cand)} 的方法 ${method} 不在只读白名单（GET/HEAD）里，已跳过`);
      continue;
    }
    if (!/^https?:\/\//i.test(url)) {
      reasons.push(`${labelOf(cand)} 的地址不是 http(s)，已跳过`);
      continue;
    }

    let res = null;
    try {
      res = await get({ url, method, headers: { ...headers }, provider: id, candidate: cand.id });
    } catch (e) {
      reasons.push(`${labelOf(cand)} 请求失败：${shortText((e && e.message) || e)}`);
      continue;
    }

    const status = num(res && res.status);
    if (status !== null && status >= 400) {
      reasons.push(`${labelOf(cand)} 返回 HTTP ${status}${excerptOf(res)}`);
      continue;
    }

    const body = bodyOf(res);
    if (body === null) {
      reasons.push(`${labelOf(cand)} 的应答不是 JSON 对象`);
      continue;
    }

    const win = pickWindow(body, cand, now);
    if (!win) {
      reasons.push(`${labelOf(cand)} 的应答里没有可用的额度字段（已用/上限都没读到）`);
      continue;
    }

    return {
      provider: id,
      known: true,
      used: win.used,
      limit: win.limit,
      resetAtMs: win.resetAtMs,
      unit: win.unit,
      source: sourceOf(cand, win),
      raw: rawOf(body, secrets),
      error: null,
    };
  }

  const reason = reasons.length
    ? reasons.join("；")
    : noEndpointReason(spec, rawBase);
  return { ...base, error: scrubSecrets(reason, secrets) };
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 与被动预算并存
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 真探测与被动预算合并成一个视图。
 *
 * ⚠ **来源必须写清楚**：探到的数是上游说的硬事实，账本估的是我们的推算 ——
 *   两者混在一起显示，用户会以为「按账本估的」也是上游说的。
 * ⚠ **探不到就退到账本**，但**不许**因此说成「额度是 0」：探不到时 used 是 null，
 *   退到账本后 used 是账本那个窗口的用量 —— 两者含义不同，所以 origin 分开标。
 *
 * @param {string} provider 渠道 id
 * @param {object} probe probeQuota 的结果
 * @param {object} [passive] quota.mjs 的 quotaState 结果（{known, used, limit, unit, resetAtMs}）
 */
export function resolveQuota(provider, probe, passive) {
  const id = normProvider(provider);
  const p = probe && typeof probe === "object" ? probe : {};
  const ps = passive && typeof passive === "object" ? passive : {};

  const upstreamOk = p.known === true && (num(p.used) !== null || num(p.limit) !== null);
  if (upstreamOk) {
    return {
      provider: id,
      known: true,
      used: num(p.used),
      limit: num(p.limit),
      resetAtMs: num(p.resetAtMs),
      unit: p.unit || UNIT_UNKNOWN,
      source: String(p.source || ""),
      origin: ORIGIN_UPSTREAM,
      originLabel: ORIGIN_LABELS[ORIGIN_UPSTREAM],
      raw: p.raw === undefined ? null : p.raw,
      error: null,
      upstream: p,
      ledger: null,
    };
  }

  const ledgerOk = ps.known === true && (num(ps.used) !== null || num(ps.limit) !== null);
  if (ledgerOk) {
    const why = p.error ? `上游探不到（${shortText(p.error, 120)}）` : "上游探不到";
    return {
      provider: id,
      known: true,
      used: num(ps.used),
      limit: num(ps.limit),
      resetAtMs: num(ps.resetAtMs),
      unit: ps.unit || UNIT_UNKNOWN,
      source: "本地额度预算：按用量账本估算（不是上游额度）",
      origin: ORIGIN_LEDGER,
      originLabel: ORIGIN_LABELS[ORIGIN_LEDGER],
      raw: null,
      error: `${why}；这里显示的是按账本估的数`,
      upstream: null,
      ledger: ps,
    };
  }

  return {
    provider: id,
    known: false,
    used: null,
    limit: null,
    resetAtMs: null,
    unit: UNIT_UNKNOWN,
    source: "",
    origin: ORIGIN_NONE,
    originLabel: ORIGIN_LABELS[ORIGIN_NONE],
    raw: null,
    error: p.error ? String(p.error) : "上游探不到，也没有本地额度预算",
    upstream: null,
    ledger: null,
  };
}
