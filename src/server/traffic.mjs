/**
 * traffic.mjs —— 流量页的纯逻辑：按天分桶 · 每家流量 · 会话亲和摘要
 *
 * ── 这个模块回答什么 ────────────────────────────────────────────────
 *   面板的「流量」屏要回答两件事：
 *     ① 钱花到哪儿了（按天、按家）；
 *     ② 哪些会话被钉在哪一家（会话亲和）。
 *   本模块把这两件事的**算术**做完，渲染层（cards/traffic-page.js）只负责画。
 *
 * ── 三条纪律 ───────────────────────────────────────────────────────
 *   ① **零 IO、零依赖**：不 import 仓库里任何模块，也不碰 fs/path。
 *      价格表在 pricing.mjs，价格会随厂商调价漂移 —— 把估价搬进来就得跟着搬
 *      那张表，搬一次就多一次「两份价格表不一致」的机会。费用由调用方用
 *      `costOf` 钩子算好传进来（见下面「费用为什么是钩子」）。
 *   ② **内部绝不读墙上的钟**（Date.now 一律不许出现）：时刻由参数传入。
 *      「今天花了多少」这句话，只有在「今天是哪天」可注入时才写得成断言。
 *   ③ **纯函数**：同样的输入必得同样的输出。不缓存、不改入参、不排序副作用。
 *
 * ── 时区口径（写死，别改）─────────────────────────────────────────
 *   按天分桶用**本机本地时区**的日历日（magpie 同款：
 *   internal/usage/shared.go 的 `r.Time.Local().Format(time.DateOnly)`，
 *   internal/usage/period_range.go 的 "in the local time zone"）。
 *   为什么不用 UTC：用户心里的「今天」是本机日历上的今天。UTC 会让「今天」
 *   在傍晚之后就变成昨天 —— 账单对不上，人也不信。
 *   **跨天的记录落在它自己那一刻的本地日历日**：UTC 2026-10-22T16:30Z 在
 *   UTC+8 是本地 10-23 00:30 ⇒ 落 **2026-10-23**，不落 10-22。
 *
 *   实现上按**每条记录那一刻**的偏移算（`-new Date(ms).getTimezoneOffset()`），
 *   这样夏令时切换那两天也不会把记录算到隔壁那天。
 *   调用方也可以用 `tzOffsetMinutes` 指定一个**固定偏移**（分钟，**东为正**：
 *   UTC+8 = 480）。固定偏移对测试最要紧 —— 断言不能随运行机器的时区翻来覆去。
 *
 * ── 三个数要分清：attempts / calls / failed ────────────────────────
 *   账本里**一次请求可能写好几行**：网关内部试了多家，每家各写一行。所以：
 *     attempts  记账条数 —— 账本里有多少行（含转交出去的尝试）
 *     calls     客户端请求数 —— 一次请求算一次（转交出去的那次尝试不算）
 *     failed    真失败 —— 状态码 ≥ 400，且不是「转交」、不是「本地拒掉」
 *   ★ **转交（handed_on）不算失败**：它已经在网关内部把活交给下一个候选了，
 *     但它**仍写了自己的记录**（可能已经被厂商计费了）。所以它进 attempts、
 *     进 token 与费用，**不进 calls、不进 failed**。
 *     （magpie 同款：usage.go 的 `Totals.count` 里 `if r.HandedOn { return }`，
 *     而 Credits 照收 —— "a try handed on is billed its credits too, though it
 *     is no request"。）
 *   ★ **被本地拒掉的（rejected）不算请求**：它压根没到厂商，没花钱也没占谁的名额。
 *     magpie 的 `IsRejected()`：`r.Rejected || (r.Provider == "" && r.Status >= 400)`。
 *     但它**要看得见**（单独一个计数），藏起来就是「不藏坏消息」那条被破了。
 *
 * ── req 与 served 是两件事 ────────────────────────────────────────
 *   `req` 是客户端问的模型，`served` 是厂商说它实际跑的模型，**常常不同**。
 *   厂商的账单按 served 对，所以凡是「按模型分组」的地方一律按 **served**
 *   （没有就退回 `model`）。`req` 只作为「客户端要的是什么」的旁证保留，
 *   不参与任何计费口径。
 *
 * ── 费用为什么是钩子而不是模块自己算 ──────────────────────────────
 *   估价要价格表（pricing.mjs），而价格表会随厂商调价漂移。本模块若 import
 *   它，就等于把「价格表的版本」也拖进这个纯逻辑层；更糟的是两边各存一份
 *   缓存时，页面上会出现两个不同口径的「今天花了多少」。
 *   所以：**模块只出 token 维度，费用由调用方算好传进来。**
 *   钩子的契约很小：`costOf(records) => number | null`。
 *     · 返回数字 → 这批记录的费用；
 *     · 返回 null → **估不出**（不是 0！一个错数字比没有数字更坏，用户要拿它对账）。
 *   调用方拿它接 pricing.mjs 的 `estimateCost`：
 *     `costOf: (recs) => { const e = estimateCost(recs); return e.known ? e.total : null; }`
 *   没给钩子 ⇒ 所有费用字段是 null（这一维「不知道」，不是「没花钱」）。
 *
 * 跑法：node --test scripts/traffic-test.mjs
 */

/* ══════════════════════════════════════════════════════════════════
 * 小工具
 * ══════════════════════════════════════════════════════════════════ */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 数字化：不是有限数字就当 0（账本里的数字要能求和；一个 NaN 会把整张表变成 NaN）。 */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** 布尔化：账本里它是布尔，但读回来的 JSON 也可能是 "true" / 1。 */
const boolOf = (v) => v === true || v === "true" || v === 1 || v === "1";

const pad2 = (n) => (n < 10 ? "0" + n : String(n));

/** 记录的时刻（epoch ms）。坏的一律 0 = 不知道 —— 不猜、也不补成「现在」。 */
function timeMs(t) {
  if (typeof t === "number") return Number.isFinite(t) ? t : 0;
  const n = Date.parse(String(t == null ? "" : t));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 那一刻的时区偏移（分钟，**东为正**：UTC+8 = 480）。
 *
 * 为什么不直接用「今天」的偏移：夏令时切换那两天，同一天里的两条记录可能
 * 处在两个不同的偏移上。按每条记录**自己那一刻**的偏移算，跨天那一条才不会
 * 被算到隔壁那天去。
 */
function offsetAt(ms, fixed) {
  if (fixed != null) {
    const f = Number(fixed);
    if (Number.isFinite(f)) return f;
  }
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return 0;
  // getTimezoneOffset 是「本地比 UTC 快多少分钟」（UTC+8 是 -480），取反成东为正。
  return -d.getTimezoneOffset();
}

/**
 * 那一刻的本地日历日（YYYY-MM-DD）。
 *
 * 做法：把时刻按那一刻的偏移推到「本地墙上时间」，再用 UTC 取年月日 ——
 * 推过去之后 UTC 的年月日就是本地的日历日，跨时区/跨夏令时都对。
 *
 * @param {number} ms epoch 毫秒
 * @param {{tzOffsetMinutes?: number}} [opts] 固定偏移（分钟，东为正）；不给就按本机时区
 * @returns {string} "YYYY-MM-DD"；时刻不对时返回空串
 */
export function dayKeyOf(ms, opts) {
  const o = opts || {};
  const t = Number(ms);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + offsetAt(t, o.tzOffsetMinutes) * 60000);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * 日历日加减（纯日历运算，走 UTC 所以不受夏令时影响）。
 * @param {string} day "YYYY-MM-DD"
 * @param {number} delta 天数（可负）
 */
export function shiftDay(day, delta) {
  const parts = String(day || "").split("-");
  if (parts.length !== 3) return "";
  const y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return "";
  const t = Date.UTC(y, m - 1, d) + delta * DAY_MS;
  const dt = new Date(t);
  if (!Number.isFinite(dt.getTime())) return "";
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/* ══════════════════════════════════════════════════════════════════
 * 记录怎么分类
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 这一条是不是「本地拒掉的」（压根没到厂商）。
 *
 * magpie 的 IsRejected()：`r.Rejected || (r.Provider == "" && r.Status >= 400)`。
 * 为什么单独分一类：它既不是请求（客户端没拿到答复），也不是失败（厂商没参与），
 * 但它是**看得见**的一次事件 —— 把它并进失败数，用户会去查厂商，而问题在本地。
 */
function isRejected(rec) {
  if (!rec) return false;
  if (boolOf(rec.rejected)) return true;
  const provider = String(rec.provider == null ? "" : rec.provider);
  return provider === "" && num(rec.status) >= 400;
}

/** 这一条是不是「转交给下一个候选」的尝试。 */
const isHandedOn = (rec) => boolOf(rec && rec.handed_on);

/**
 * 这条记录属于哪个会话。
 *
 * ⚠ 账本里**没有** magpie 的 `session` 字段；本仓把会话 id 写进了
 *   `session_provider`（server.mjs 里的 `sessionProvider: sessionOfReq(req)`）。
 *   那个字段名是历史包袱 —— 它装的是**会话 id**，不是渠道名，照着名字理解会读错。
 *   这里先认 magpie 的 `session`，再退回本仓的 `session_provider`：
 *   哪边有算哪边，将来字段名修好了这里不用跟着改。
 */
function sessionIdOf(rec) {
  if (!rec) return "";
  const s = String(rec.session == null ? "" : rec.session).trim();
  if (s) return s;
  return String(rec.session_provider == null ? "" : rec.session_provider).trim();
}

/* ══════════════════════════════════════════════════════════════════
 * 累加器
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 一个累加器。按天分桶时 key 是日历日，按渠道分桶时 key 是渠道 key ——
 * 两种用同一套字段，省得两处口径各写一遍然后漂掉。
 */
function newAcc(key) {
  return {
    key: key || "",
    calls: 0,        // 客户端请求数（不含转交、不含本地拒掉）
    attempts: 0,     // 记账条数（含转交）
    failed: 0,       // 真失败
    handedOn: 0,     // 转交下一候选的尝试
    rejected: 0,     // 本地拒掉（没到厂商）
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    msSum: 0,
    msSamples: 0,
    msMax: 0,
    firstAt: 0,
    lastAt: 0,
    records: [],     // 只给费用钩子用，不出现在对外形状里
  };
}

/**
 * 把一条记录记进累加器。
 *
 * ⚠ token 与费用：**转交出去的那次尝试也算** —— 它可能已经被厂商计费了
 *   （magpie 的 Credits 同口径："a try handed on is billed its credits too"）。
 *   本地拒掉的不算（压根没到厂商，没有 token 也没有钱）。
 */
function addTo(acc, rec, ms) {
  acc.attempts++;
  acc.records.push(rec);
  if (isHandedOn(rec)) {
    acc.handedOn++;
  } else if (isRejected(rec)) {
    acc.rejected++;
  } else {
    acc.calls++;
    if (num(rec.status) >= 400) acc.failed++;
  }
  if (!isRejected(rec)) {
    acc.tokensIn += num(rec.in);
    acc.tokensOut += num(rec.out);
    acc.cacheRead += num(rec.cache_read);
    acc.cacheWrite += num(rec.cache_write);
  }
  const dur = num(rec.ms);
  if (dur > 0) {
    acc.msSum += dur;
    acc.msSamples++;
    if (dur > acc.msMax) acc.msMax = dur;
  }
  if (!acc.firstAt || ms < acc.firstAt) acc.firstAt = ms;
  if (ms > acc.lastAt) acc.lastAt = ms;
}

/**
 * 累加器对外的形状（不含 key —— 键由调用方按「日」或「渠道」自己贴上去）。
 * @param {object} acc
 * @param {number|null} cost 费用（null = 估不出）
 */
function publicAcc(acc, cost) {
  return {
    calls: acc.calls,
    attempts: acc.attempts,
    failed: acc.failed,
    handedOn: acc.handedOn,
    rejected: acc.rejected,
    tokensIn: acc.tokensIn,
    tokensOut: acc.tokensOut,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    /* token 合计只算**进出**（不含缓存读写）：缓存读是折扣档、
       把它算进「用量」会让一条长对话的条数看着像暴增，而它其实没花多少钱。 */
    tokens: acc.tokensIn + acc.tokensOut,
    avgMs: acc.msSamples ? Math.round(acc.msSum / acc.msSamples) : null,
    maxMs: acc.msMax || null,
    lastAt: acc.lastAt || 0,
    cost: cost == null ? null : cost,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 窗口
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 时间窗口（按本地日历日）。
 *
 * 给了 `days` 与 `nowMs` ⇒ 窗口是「今天往前 days-1 天」到「今天」（含两端）。
 * 两者不给 ⇒ 不裁剪（全部记录都算）。
 *
 * 为什么窗口按**日历日**切而不是按「now - N×24 小时」切：同一栏里「今天」
 * 必须是一个完整的日历日，半天的「今天」和旁边的「昨天」没法比。
 */
function windowOf(o) {
  const days = Number.isFinite(Number(o.days)) ? Math.floor(Number(o.days)) : 30;
  const nowMs = Number(o.nowMs);
  if (days <= 0 || !Number.isFinite(nowMs) || nowMs <= 0) return { from: "", to: "" };
  const today = dayKeyOf(nowMs, o);
  if (!today) return { from: "", to: "" };
  return { from: shiftDay(today, -(days - 1)), to: today };
}

/** 一条记录在不在窗口里（没有窗口就都在）。 */
function inWindow(day, from, to) {
  if (!from || !to) return true;
  return day >= from && day <= to;
}

/* ══════════════════════════════════════════════════════════════════
 * 费用
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 这批记录的费用。
 * @param {object} acc
 * @param {(records: object[]) => (number|null)} [hook] 调用方给的估价钩子
 * @returns {number|null} null = 估不出（**不是 0**）
 */
function costOfAcc(acc, hook) {
  /* 那天没有记录 ⇒ 花了 0（**真的 0**，与有没有价格表无关：没调用就没开销）。
     这一条排在钩子检查前面，否则「没给钩子」会把空天也说成「不知道」。 */
  if (!acc.records.length) return 0;
  if (typeof hook !== "function") return null;   // 没给钩子 ⇒ 这一维「不知道」
  const v = hook(acc.records);
  if (v == null) return null;                   // 估不出
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ══════════════════════════════════════════════════════════════════
 * ① 按天分桶
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 把账本记录按本地日历日分桶。
 *
 * 返回的 days 是**升序**（从早到晚）—— 时间线就该按时间走；
 * 要「最近的在最上」由渲染层自己倒过来。
 *
 * @param {object[]} records 账本记录（usage-ledger 的形状）
 * @param {object} [opts]
 * @param {number} [opts.days=30] 最近多少天；0 = 不裁剪
 * @param {number} [opts.nowMs] 「现在」（epoch ms），算窗口与今天用
 * @param {number} [opts.tzOffsetMinutes] 固定时区偏移（分钟，东为正）
 * @param {(records: object[]) => (number|null)} [opts.costOf] 费用钩子
 * @returns {{days: object[], totals: object, skipped: number}}
 */
export function dailyBuckets(records, opts = {}) {
  const o = opts || {};
  const { from, to } = windowOf(o);
  const accs = new Map();
  let skipped = 0;

  for (const rec of Array.isArray(records) ? records : []) {
    const ms = timeMs(rec && rec.t);
    /* 时刻不明的记录不进时间线：不猜它是哪天 —— 猜出来的日子是假的，
       而时间线上的假点比少一个点坏得多。数目记在 skipped 里，不藏。 */
    if (!ms) { skipped++; continue; }
    const day = dayKeyOf(ms, o);
    if (!day || !inWindow(day, from, to)) continue;
    let acc = accs.get(day);
    if (!acc) { acc = newAcc(day); accs.set(day, acc); }
    addTo(acc, rec, ms);
  }

  /* 补齐中间没用的日子：时间线上一段空白与一段连续，读者理解起来完全不是一回事
     —— 前者像「数据丢了」，后者像「那天没用」。 */
  let lo = from, hi = to;
  if (!lo || !hi) {
    for (const k of accs.keys()) {
      if (!lo || k < lo) lo = k;
      if (!hi || k > hi) hi = k;
    }
  }
  if (lo && hi) {
    let cur = lo;
    let guard = 0;
    while (cur <= hi && guard++ < 4000) {
      if (!accs.has(cur)) accs.set(cur, newAcc(cur));
      cur = shiftDay(cur, 1);
    }
  }

  const keys = [...accs.keys()].sort();
  const days = [];
  let costKnown = true;
  let costSum = 0;
  for (const k of keys) {
    const acc = accs.get(k);
    const cost = costOfAcc(acc, o.costOf);
    if (cost == null) costKnown = false;
    else costSum += cost;
    days.push({ day: acc.key, ...publicAcc(acc, cost) });
  }

  const totals = sumDays(days);
  /* 只要有一天估不出，总价就是 null（不是「已知那几天的和」）：
     偏少的总价比没有总价更坏 —— 用户要拿它跟厂商账单对账。
     （与 pricing.mjs 的 `estimateCost` 同一口径。） */
  totals.cost = costKnown ? costSum : null;
  totals.costKnown = costKnown;
  totals.skipped = skipped;
  return { days, totals, skipped };
}

/** 把若干天的字段加起来（费用除外，费用在上面单独按「全known才给」处理）。 */
function sumDays(days) {
  const t = {
    calls: 0, attempts: 0, failed: 0, handedOn: 0, rejected: 0,
    tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, tokens: 0,
  };
  for (const d of days) {
    t.calls += d.calls; t.attempts += d.attempts; t.failed += d.failed;
    t.handedOn += d.handedOn; t.rejected += d.rejected;
    t.tokensIn += d.tokensIn; t.tokensOut += d.tokensOut;
    t.cacheRead += d.cacheRead; t.cacheWrite += d.cacheWrite;
    t.tokens += d.tokens;
  }
  return t;
}

/* ══════════════════════════════════════════════════════════════════
 * ② 每家流量
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 按渠道分：谁扛了请求、扛得怎么样、花了多少钱。
 *
 * 渠道 key 就是账本里的 `provider`（与清单里的 key 一一对应），
 * 显示名由渲染层用 nameOf 翻译 —— 本模块不认识任何渠道。
 *
 * @param {object[]} records
 * @param {object} [opts] 同 dailyBuckets
 * @returns {object[]} 按请求数倒序
 */
export function channelBreakdown(records, opts = {}) {
  const o = opts || {};
  const { from, to } = windowOf(o);
  const accs = new Map();

  for (const rec of Array.isArray(records) ? records : []) {
    const ms = timeMs(rec && rec.t);
    if (!ms) continue;
    const day = dayKeyOf(ms, o);
    if (!day || !inWindow(day, from, to)) continue;
    const key = String(rec.provider == null ? "" : rec.provider);
    let acc = accs.get(key);
    if (!acc) { acc = newAcc(key); accs.set(key, acc); }
    addTo(acc, rec, ms);
  }

  const out = [];
  for (const acc of accs.values()) {
    out.push({ key: acc.key, ...publicAcc(acc, costOfAcc(acc, o.costOf)) });
  }
  out.sort((a, b) => (b.calls - a.calls) || (b.attempts - a.attempts)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/* ══════════════════════════════════════════════════════════════════
 * ③ 会话亲和
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 会话 → 渠道 → 粘了多少次。
 *
 * 两边的数据源：
 *   · **账本**：这个会话在账本里真的被哪一家答过几次（粘住多少次）。
 *     会话 id 取自记录里的会话字段（见 sessionIdOf 的说明）。
 *   · **亲和表**（session-store.mjs 的 SessionStore.entries()）：这个会话
 *     **当前**钉在哪个账号上，以及为什么还钉着（缓存读写、用的哪个模型）。
 *     亲和表是「现在」的状态，所以不受天数窗口限制 —— 窗口管的是「次数」。
 *
 * ⚠ 亲和表存的是**最后一条**绑定，不是历史。所以「粘了多少次」只能从账本数，
 *   亲和表只能回答「现在粘在谁身上」。两者对不上是正常的：账本被裁剪过、
 *   会话刚建立、或亲和表刚重启 —— 那时这条记为 `seen:false`，
 *   **不是**「粘了 0 次」（探不到 ≠ 0）。
 *
 * @param {object[]} records 账本记录
 * @param {Array<{channel: string, entries: Array<{key: string, target: string, at: number, used: number, meta: object}>}>} affinity
 *        每个渠道一份亲和表（亲和表是**按渠道**分的：wbAffinityStore(p)）
 * @param {object} [opts] 同 dailyBuckets
 */
export function affinitySummary(records, affinity, opts = {}) {
  const o = opts || {};
  const { from, to } = windowOf(o);
  const rows = new Map();

  const rowOf = (session, channel) => {
    const k = session + "\u0000" + channel;
    let row = rows.get(k);
    if (!row) {
      row = {
        session, channel,
        account: "",        // 当前钉住的账号（不知道 ⇒ 空串，不是 "?"）
        pinned: false,      // 亲和表里有没有这条绑定
        seen: false,        // 账本里查不查得到这个会话
        calls: 0, attempts: 0, failed: 0,
        tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0,
        lastAt: 0,
        cacheReadMeta: 0,   // 亲和表里记的缓存读（为什么还值得粘着）
        cacheWriteMeta: 0,
        model: "",
      };
      rows.set(k, row);
    }
    return row;
  };

  /* ① 账本侧：次数 */
  for (const rec of Array.isArray(records) ? records : []) {
    const session = sessionIdOf(rec);
    if (!session) continue;
    const ms = timeMs(rec && rec.t);
    if (!ms) continue;
    const day = dayKeyOf(ms, o);
    if (!day || !inWindow(day, from, to)) continue;
    const channel = String(rec.provider == null ? "" : rec.provider);
    const row = rowOf(session, channel);
    row.seen = true;
    row.attempts++;
    if (!isHandedOn(rec) && !isRejected(rec)) {
      row.calls++;
      if (num(rec.status) >= 400) row.failed++;
      row.tokensIn += num(rec.in);
      row.tokensOut += num(rec.out);
      row.cacheRead += num(rec.cache_read);
      row.cacheWrite += num(rec.cache_write);
    }
    if (ms > row.lastAt) row.lastAt = ms;
  }

  /* ② 亲和表侧：现在钉在谁身上 */
  for (const group of Array.isArray(affinity) ? affinity : []) {
    if (!group || typeof group !== "object") continue;
    const channel = String(group.channel == null ? "" : group.channel);
    for (const e of Array.isArray(group.entries) ? group.entries : []) {
      if (!e || typeof e !== "object") continue;
      const session = String(e.key == null ? "" : e.key).trim();
      if (!session) continue;
      const row = rowOf(session, channel);
      row.pinned = true;
      row.account = String(e.target == null ? "" : e.target);
      const meta = e.meta && typeof e.meta === "object" ? e.meta : {};
      row.cacheReadMeta = num(meta.cacheRead);
      row.cacheWriteMeta = num(meta.cacheWrite);
      row.model = String(meta.model == null ? "" : meta.model);
      const at = num(e.at);
      if (at > row.lastAt) row.lastAt = at;
    }
  }

  const list = [...rows.values()];
  list.sort((a, b) => (b.lastAt - a.lastAt)
    || (b.calls - a.calls)
    || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));

  const totals = {
    sessions: new Set(list.map((r) => r.session)).size,
    pinned: list.filter((r) => r.pinned).length,
    unseen: list.filter((r) => !r.seen).length,
    sticks: list.reduce((n, r) => n + r.calls, 0),
    channels: new Set(list.map((r) => r.channel)).size,
  };
  return { sessions: list, totals };
}

/* ══════════════════════════════════════════════════════════════════
 * 汇总入口
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 一次算完流量页要的三块：按天 · 按家 · 会话亲和。
 *
 * @param {object[]} records 账本记录（usage-ledger.loadRecords 的返回）
 * @param {object} [opts]
 * @param {number} [opts.days=30] 最近多少天；0 = 不裁剪
 * @param {number} [opts.nowMs] 「现在」（epoch ms）
 * @param {number} [opts.tzOffsetMinutes] 固定时区偏移（分钟，东为正）
 * @param {(records: object[]) => (number|null)} [opts.costOf] 费用钩子
 * @param {Array} [opts.affinity] 各渠道的亲和表（见 affinitySummary）
 * @returns {{days: object[], totals: object, channels: object[], affinity: object}}
 */
export function buildTraffic(records, opts = {}) {
  const o = opts || {};
  const daily = dailyBuckets(records, o);
  return {
    days: daily.days,
    totals: daily.totals,
    channels: channelBreakdown(records, o),
    affinity: affinitySummary(records, o.affinity, o),
  };
}
