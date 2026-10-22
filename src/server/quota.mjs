/**
 * quota.mjs —— 配额预算与配额感知排序（纯逻辑、零 IO、零时钟）
 *
 * ── 它补的是哪个洞 ────────────────────────────────────────────────────────
 *
 * 路由内核（routes.mjs）早就备好了「按额度排序」这套机制：Seat.used 是 0–100 的
 * 百分数，Builtin.smart 按它分三档（90 / 98）再排。缺的不是机制，是**信号** ——
 * server.mjs 的 orderChain 里写着「今天的信号还很少 …… 等配额探测（T9）接上，
 * 它自己就会开始按额度重排」。本模块就是那个「接上」的半边：把用户自己设的
 * 额度预算，换算成 Seat 能直接吃的百分数。
 *
 * ── magpie 的对应物，以及我们为什么做不到它那一版 ─────────────────────────
 *
 * magpie 的 T9 是**查供应商的配额接口**（internal/provider/quotas.go）：拿着
 * 登录态去问 Anthropic / OpenAI / GitHub 的私有接口，拿到一组 QuotaWindow
 * （used / resetsAt / model 作用域），routing 再拿它排
 * （internal/provider/routing.go 的 Allowance）。
 *
 * ★ **我们做不了那一版**：bai-router 的渠道不是 OAuth 登录态，供应商也不暴露
 *   配额 API —— 没有那个前提，就不能假装有。硬造一个「查配额」的接口形状、
 *   里面填我们自己的估算，只会让下游以为那是供应商说的实话。
 *
 * 所以这里是**被动信号版**：用户给每家设一个额度预算，我们拿**用量账本里已经
 * 记着的 token**去对照，超了就主动让那家休息。
 *
 * ── 有意与 magpie 不同的三点（我们的取舍）──────────────────────────────
 *
 * ① **被动 vs 主动**：magpie 问供应商「你还有多少」；我们问自己「我们花了多少」。
 *    后者的准确度取决于账本记全了没有（漏记 = 少算 = 阀晚开），前者取决于供应商
 *    准不准。少算的代价是**晚一点休息**，方向是安全的；反过来（把估算当上游
 *    的实话）会让面板显示一个根本没发生过的失败。
 * ② **预算是我们自己定的**：magpie 的窗口是供应商给的既定事实；我们的预算是
 *    用户的一个意图（"这家每小时给我留 200 万 token"）。所以它**只能**当估算，
 *    归因上要与「上游额度用尽」彻底分开（见 {@link BUDGET_KIND}）。
 * ③ **重置的边界由用户设的窗口决定**（整点 / 本地午夜），不是供应商报的时刻 ——
 *    供应商报的时刻我们拿不到，能拿到的只有自己定的窗口边界。
 *
 * ── 单位为什么是 token 数（不是钱）──────────────────────────────────────
 *
 * 账本（usage-ledger.mjs 的 FIELDS）里**没有价格字段** —— 只有 in / out /
 * cache_read / cache_write 几个 token 数。算钱必须外挂一张价格表，而价格表会
 * 随厂商调价漂移：同一份预算，厂商一调价就悄悄变了含义，而用户毫无察觉。
 * token 数是账本里**直接记着**的量，用户自己就能对着账本核。
 *
 * ⚠ 缓存读取**不计入**（只计 in + out + cache_write）：读缓存是厂商的折扣档
 *   （多数近乎免费），而 Claude Code 这类客户端的缓存读取量极大（单次请求
 *   十万 token 起步）。把它算进去，预算会在第一次长对话里就被打满，阀等于没有。
 *   真正占住上游额度的是输入、输出与缓存写入。
 *
 * ── 硬规矩 ────────────────────────────────────────────────────────────────
 *   · 零依赖：只 import routes.mjs（它也是纯逻辑）。不碰 fs / 网络。
 *   · **内部绝不调 Date.now()**：现在几点一律由参数传入（now）。
 *   · **不排序**：排序是 routes.mjs 的事。本模块只把预算折算成 Seat 的字段，
 *     由策略去排 —— 另写一套排序器就等于有两套真相，两套真相迟早打架。
 */

import { Seat } from "./routes.mjs";

/* ══════════════════════════════════════════════════════════════════════
 * ① 常量
 * ══════════════════════════════════════════════════════════════════════ */

/** 预算的计量单位：本模块只认 token 数（理由见文件头）。 */
export const QUOTA_UNIT = "tokens";

/**
 * 预算耗尽在休息表里的归因标签。
 *
 * ⚠ **刻意不叫 "quota"**：candidates.KINDS 里的 "quota" 是「上游额度用尽」
 *   （上游亲口说的），而预算耗尽是我们自己的估算。两者混用会让面板显示一个
 *   假的失败原因 —— 用户会以为这家供应商真的没额度了，而事实是我们替他省着花。
 *   所以这里另起一个标签，休息表里能一眼分清「上游说的」与「我们估的」。
 */
export const BUDGET_KIND = "budget";

const HOUR_MS = 60 * 60 * 1000;

/* ══════════════════════════════════════════════════════════════════════
 * ② 小工具
 * ══════════════════════════════════════════════════════════════════════ */

/** 只认有限数；null / undefined / NaN / Infinity 一律当作「没有」。 */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clampPct(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 100 ? 100 : x;
}

/**
 * 渠道 id 归一：去空白 + 小写。
 *
 * 为什么要小写：账本里的 provider 是调用方写进去的（"Bai" / "bai" 都可能），
 * 而配置里的键是手写的。归一之后两边的比较才是可靠的 —— 否则「配置了 bai 的预算、
 * 账本里记的是 Bai」会被当成两家，预算永远不触发。
 */
function normId(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

/**
 * 上限：必须是正的有限数；0 与负数当作「没设」。
 *
 * 为什么把 0 当「没设」而不是「不许用」：「上限 0」既可以读成「这家不许用了」，
 * 也可以读成「手滑写了 0」。两种读法的后果差到天上（前者让整家永久休息，
 * 后者什么也不做），猜错方向就是灾难 —— 所以不猜，按「没设」处理。
 *
 * 数字串（"1000"）按数字收：config.json 是手改的，写成字符串是很常见的一手滑，
 * 而「静默当成没设」= 用户的预算根本没生效，且他看不见。
 * 但**读不出数**（"一千"、"1000abc"）是另一种性质 —— 那不是手滑，是写错了，
 * 当场炸掉，别让它悄悄变成「没设」。
 */
function limitOf(v) {
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n)) {
      throw new TypeError(`配额预算的上限要是一个数，收到 "${v}"`);
    }
    return n > 0 ? n : null;
  }
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

/**
 * 记录的时刻（epoch ms）；读不出就 null（**不是 0** —— 0 是 1970 年，
 * 而「读不出时刻」与「很早以前」是两件事）。
 *
 * 账本的 t 字段是 ISO 串（usage-ledger 的 normalizeTime），但手工造的记录可能
 * 直接给毫秒数或 Date，所以三种都认。
 */
function timeMsOf(rec) {
  const t = rec.t != null ? rec.t : rec.time;
  if (t == null || t === "") return null;
  if (t instanceof Date) {
    const n = t.getTime();
    return Number.isFinite(n) ? n : null;
  }
  if (typeof t === "number") return Number.isFinite(t) ? t : null;
  const s = String(t).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}

/** 账本里的 token 字段（snake_case 与 camelCase 都认）。 */
function tokensOf(rec) {
  return {
    in: num(rec.in) ?? 0,
    out: num(rec.out) ?? 0,
    cacheWrite: num(rec.cache_write) != null ? num(rec.cache_write) : (num(rec.cacheWrite) ?? 0),
    cacheRead: num(rec.cache_read) != null ? num(rec.cache_read) : (num(rec.cacheRead) ?? 0),
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 预算：从配置里读这一家的额度预算
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 配置里这一家的预算放在哪。
 *
 * 主位置是**顶层 `quota` 一节**（按渠道 id 分组），因为 bai 的配置是摊在顶层的
 * （没有 cfg.bai 子对象），其余七家各有子对象 —— 按渠道分组比按渠道嵌套更齐。
 * 次位置是 `cfg[渠道].quota`（就近放在渠道自己的块里），两处都写了以顶层为准。
 *
 * ⚠ 这一节是**用户自设的预算**，不是供应商报出来的配额（后者走 allowance.mjs
 *   的 QuotaWindow）。名字都叫「额度」，但来源与可信度完全不同，混用会出事。
 */
function quotaEntryOf(cfg, provider) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const id = normId(provider);
  if (!id) return null;
  const top = c.quota && typeof c.quota === "object" ? c.quota : null;
  if (top) {
    for (const k of Object.keys(top)) {
      if (normId(k) === id) return top[k];
    }
  }
  const own = c[id] && typeof c[id] === "object" ? c[id].quota : null;
  if (own != null) return own;
  return null;
}

/** 配置里哪些渠道设了预算（顶层 quota 的键 + 自家带 quota 的渠道块）。 */
function quotaProvidersOf(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const ids = new Set();
  const top = c.quota && typeof c.quota === "object" ? c.quota : null;
  if (top) {
    for (const k of Object.keys(top)) {
      const id = normId(k);
      if (id) ids.add(id);
    }
  }
  for (const k of Object.keys(c)) {
    const v = c[k];
    if (v && typeof v === "object" && v.quota != null) {
      const id = normId(k);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * 这一家的额度预算。
 *
 * 认两种写法：
 *   · 对象：`{ unit:"tokens", hourly: 2000000, daily: 20000000 }`
 *   · 裸数字：`20000000` —— 当成**每天**的上限（一个数只配一个窗口时，
 *     「每天」比「每小时」更不容易误伤：小时窗一超就整小时不可用）。
 *
 * ⚠ 单位写错**当场炸**：只认 "tokens"。写成 "usd" 之类时静默忽略等于让用户
 *   以为自己设了预算（实际没有），而静默忽略是这里最坏的一种失败 ——
 *   用户看不见「没生效」这件事。
 *
 * @param {string} provider 渠道 id
 * @param {object} cfg 整份配置
 * @returns {{provider:string, unit:string, hourly:number|null, daily:number|null}|null}
 *          没设预算就是 null（**不是**一个上限为 0 的对象）
 */
export function budgetOf(provider, cfg) {
  const id = normId(provider);
  if (!id) return null;
  const raw = quotaEntryOf(cfg, id);
  if (raw == null) return null;

  if (typeof raw === "number") {
    const daily = limitOf(raw);
    if (daily == null) return null;
    return { provider: id, unit: QUOTA_UNIT, hourly: null, daily };
  }
  if (typeof raw !== "object") return null;

  const unit = raw.unit == null ? QUOTA_UNIT : normId(raw.unit);
  if (unit !== QUOTA_UNIT) {
    throw new TypeError(
      `配额预算的单位只认 "${QUOTA_UNIT}"，收到 "${raw.unit}" —— 账本里没有价格字段，`
      + "算钱要外挂价格表，而价格表会随厂商调价漂移（预算会悄悄变含义）。"
    );
  }
  const hourly = limitOf(raw.hourly);
  const daily = limitOf(raw.daily);
  if (hourly == null && daily == null) return null;
  return { provider: id, unit, hourly, daily };
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 用量折算：账本 → 窗口内的 token 数
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 某一家的用量在一个窗口里是多少（分项）。
 *
 * 计数规则（**这一节是整个模块的口径所在，改它等于改预算的含义**）：
 *   · 计入 in + out + cache_write；
 *   · **不计 cache_read**（理由见文件头「单位」一节）；
 *   · 失败的那次尝试（status 4xx/5xx、handed_on）**照算** —— 上游可能已经计费了，
 *     账本记了多少就算多少，不按 status 二次过滤（magpie 的 handed_on 记录同样
 *     保留 token 数：它可能已经被厂商计费了）；
 *   · **时间读不出的记录也照算** —— 宁可早一点休息，也不要多花。账本自己写的
 *     记录总是带时刻，这条只针对手工塞进来的记录。
 *
 * @param {object[]} records 账本记录（usage-ledger 的形状）
 * @param {string} provider 渠道 id
 * @param {number} [sinceMs] 窗口起点（含）；不给 = 不按时间过滤
 * @returns {{in:number, out:number, cacheWrite:number, cacheRead:number, total:number, count:number}}
 */
export function usagePartsInWindow(records, provider, sinceMs) {
  const out = { in: 0, out: 0, cacheWrite: 0, cacheRead: 0, total: 0, count: 0 };
  const id = normId(provider);
  if (!id) return out;
  const since = num(sinceMs);
  const list = Array.isArray(records) ? records : [];
  for (const rec of list) {
    if (!rec || typeof rec !== "object") continue;
    if (normId(rec.provider) !== id) continue;
    const t = timeMsOf(rec);
    if (since != null && t != null && t < since) continue;
    const tk = tokensOf(rec);
    out.in += tk.in;
    out.out += tk.out;
    out.cacheWrite += tk.cacheWrite;
    out.cacheRead += tk.cacheRead;
    out.count += 1;
  }
  out.total = out.in + out.out + out.cacheWrite;
  return out;
}

/**
 * 某一家的用量在一个窗口里是多少（token 数）。
 *
 * @param {object[]} records 账本记录
 * @param {string} provider 渠道 id
 * @param {number} [sinceMs] 窗口起点（含）；不给 = 不按时间过滤
 * @returns {number} token 数
 */
export function usageInWindow(records, provider, sinceMs) {
  return usagePartsInWindow(records, provider, sinceMs).total;
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 窗口边界
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 小时窗口：从**整点**起算（[start, end)）。
 *
 * 为什么要整点：路由那边把续期时刻截断到整点（routes.mjs 的 truncHour），
 * 理由是「两条配额窗口相差几分钟不该在排序里换来换去」。预算窗口跟着整点走，
 * 两边的口径才对得上；不整点的话，排序结果每分钟都在动。
 */
function hourlyWindow(now) {
  const start = Math.floor(now / HOUR_MS) * HOUR_MS;
  return { start, end: start + HOUR_MS };
}

/**
 * 天窗口：从**本地午夜**起算（[start, end)）。
 *
 * 为什么是本地午夜而不是 UTC 零点：用户心里的「一天」是本地的一天。UTC 零点
 * 在东八区是早上八点 —— 那样「每天的预算」会在早上八点重置，用户的体感是
 * 「莫名其妙清零了」。
 *
 * 用 Date 的本地构造器（new Date(y, m, d)）而不是算术，是因为夏令时会让
 * 一天变成 23 或 25 小时，算术会算错一天的长度；Date 的本地构造器会自己归一。
 */
function dailyWindow(now) {
  const d = new Date(now);
  const y = d.getFullYear();
  const mo = d.getMonth();
  const da = d.getDate();
  const start = new Date(y, mo, da, 0, 0, 0, 0).getTime();
  const end = new Date(y, mo, da + 1, 0, 0, 0, 0).getTime();
  return { start, end };
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 判定：这一家现在还剩多少预算
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 哪条窗口更紧（magpie 的 mergeWindows 口径：used 取最大；一样则更早结束的更紧）。
 *
 * 为什么要挑一条而不是两条都算：预算是**一个**闸门，得有一个明确的「到点就休息」
 * 的时刻。同时挂着小时与每天两条时，用户心里的「用完了」是**先撞到的那条**。
 */
function tighterWindow(a, b) {
  if (a.ratio !== b.ratio) return a.ratio > b.ratio;
  return a.end < b.end;
}

/**
 * 这一家的预算现在是什么状况。
 *
 * 返回的字段：
 *   · `used`     —— 生效窗口内已用的 **token 数**
 *   · `limit`    —— 生效窗口的上限（token 数）
 *   · `ratio`    —— 已用**百分比** 0–100（与 routes.Seat.used 同一口径；
 *                   不是 0–1 的比例 —— 那两种口径混用是本仓最贵的一类 bug）
 *   · `exhausted`—— 预算用尽（used ≥ limit）。⚠ 这是**我们自己的估算**，
 *                   与「上游额度用尽」是两回事，归因上必须分开（见 BUDGET_KIND）
 *   · `resetAtMs`—— 窗口重置时刻（epoch ms）；过了这一刻，新窗口的用量从零算，
 *                   于是预算**自动恢复**，不需要谁去撤销休息
 *
 * 没设预算时：window 为 ""、exhausted 为 false、limit 为 0（这里的 0 表示
 * 「没有预算」，不是「上限为零」）。
 *
 * @param {string} provider 渠道 id
 * @param {object} cfg 整份配置
 * @param {object[]} records 账本记录
 * @param {number} now 当前时刻（epoch 毫秒）
 */
export function quotaState(provider, cfg, records, now) {
  const id = normId(provider);
  const budget = budgetOf(provider, cfg);
  const base = {
    provider: id,
    unit: QUOTA_UNIT,
    window: "",
    used: 0,
    limit: 0,
    ratio: 0,
    exhausted: false,
    resetAtMs: null,
    known: false,
    windows: { hourly: null, daily: null },
  };
  if (!budget) return base;

  const n = num(now);
  if (n == null) {
    throw new TypeError(
      "quotaState 需要 now（epoch 毫秒）：预算的窗口边界与重置时刻都以「现在」为基准"
    );
  }

  const cands = [];
  if (budget.hourly != null) {
    const w = hourlyWindow(n);
    cands.push({ name: "hourly", limit: budget.hourly, start: w.start, end: w.end });
  }
  if (budget.daily != null) {
    const w = dailyWindow(n);
    cands.push({ name: "daily", limit: budget.daily, start: w.start, end: w.end });
  }
  if (!cands.length) return base;

  for (const c of cands) {
    c.used = usageInWindow(records, id, c.start);
    c.ratio = clampPct((c.used / c.limit) * 100);
    // 耗尽与否按「用量 ≥ 上限」判，不按 ratio ≥ 100 判：ratio 是浮点除法，
    // 1000000/1000000 未必精确等于 100（浮点会掉到 99.99999999…），
    // 而「用满了」这件事不该因为一次浮点误差而不算数。
    c.exhausted = c.used >= c.limit;
    c.resetAtMs = c.end;
  }

  let best = cands[0];
  for (const c of cands) if (tighterWindow(c, best)) best = c;

  const windows = { hourly: null, daily: null };
  for (const c of cands) {
    windows[c.name] = {
      limit: c.limit, used: c.used, ratio: c.ratio, exhausted: c.exhausted,
      startMs: c.start, resetAtMs: c.end,
    };
  }

  return {
    provider: id,
    unit: budget.unit,
    window: best.name,
    used: best.used,
    limit: best.limit,
    ratio: best.ratio,
    exhausted: best.exhausted,
    resetAtMs: best.end,
    known: true,
    windows,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 配额压力：喂给 routes.mjs 的座位
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 各家现在的「配额压力」。
 *
 * ⚠ **这里不排序**：排序是 routes.mjs 的事（{@link applyQuotaToSeat} 只把压力
 *   折算成 Seat 的字段）。另写一套排序器就等于有两套真相 —— 上游的额度、冷却、
 *   权重、免费档全都要一起看，而那套信息只有 routes.mjs 手里有。
 *
 * 返回值是一个**普通对象**（不是 Map）：面板要把它 JSON 出去给人看，
 * 而「谁压着谁」在几秒钟内就会变，没必要为此多一层类型。
 *
 * @param {object[]} records 账本记录
 * @param {object} cfg 整份配置
 * @param {number} now 当前时刻（epoch 毫秒）
 * @returns {Object<string, object>} 渠道 id → 压力条目
 */
export function quotaWeights(records, cfg, now) {
  const out = {};
  for (const id of quotaProvidersOf(cfg)) {
    const st = quotaState(id, cfg, records, now);
    if (!st.window) continue;   // 这一家没设上限 → 没有配额压力可言
    const ratio = clampPct(st.ratio);
    out[id] = {
      provider: id,
      unit: st.unit,
      window: st.window,
      used: st.used,
      limit: st.limit,
      ratio,
      // 取整到整百分比：Seat 的构造器拒绝 (0,1) 这一段（那是给「把比例当百分数
      // 传」的镜像脚枪留的哨兵）。真实的预算用量报到 0.5% 这种精度是不现实的，
      // 而放它过去的后果是**静默**地把它当成「几乎没用」。
      usedPct: Math.round(ratio),
      exhausted: st.exhausted,
      resetAtMs: st.resetAtMs,
      known: true,
      // 权重系数：额度还剩多少（1 = 一点没占，0 = 占满了）。
      // 用在 Weighted 策略上：额度快用完的渠道少分一点。
      weightFactor: Math.max(0, 1 - ratio / 100),
    };
  }
  return out;
}

/**
 * 把配额压力折算进一个座位（routes.mjs 的 Seat）。
 *
 * 折算成**哪些字段**，以及为什么就这几个：
 *   · `used`  —— 配额压力喂进 Seat.used。这是 routes.mjs 已经用着的字段：
 *     smart / usage / pace 三种策略都按它分档（90 / 98）。压力取 **max**：
 *     上游说「用了 90%」与自己估「用了 30%」，该按 90% 走（上游是硬事实）；
 *     反过来上游说 30%、我们估 90%，也该按 90% 走（我们替用户省着花）。
 *   · `weight`—— 按压力系数往下缩（至少 1，Seat 的契约）。给 Weighted 策略用。
 *   · `known` —— 补成「我们知道自己花了多少」。策略其实一个都不读它
 *     （routes.mjs 的七种策略没有哪个用 known），补它只是把信息补全。
 *
 * ⚠ **刻意不动 `pace`**：routes.mjs 的 pace 语义是「每小时摊到多少，摊得快的
 *   **先用掉**（免得它的额度到点白扔）」—— 与本模块「预算快用完 ⇒ 少用」的
 *   方向**正好相反**。喂进去会让预算快见底的渠道被排到最前面，正好搞反。
 *   「预算什么时候恢复」由 `resetAtMs` 单独给调用方，不走 pace。
 *
 * @param {object} seat 原来的座位（routes.Seat）
 * @param {object} quota {@link quotaWeights} 里的那一条
 * @param {{scaleWeight?:boolean}} [opts] scaleWeight 默认 true
 * @returns {Seat} 新座位（原座位不动）
 */
export function applyQuotaToSeat(seat, quota, opts = {}) {
  const s = seat && typeof seat === "object" ? seat : {};
  if (!quota || typeof quota !== "object") return s;

  const used = Math.round(clampPct(Math.max(num(s.used) ?? 0, num(quota.usedPct) ?? 0)));
  const known = !!s.known || !!quota.known;

  let weight = num(s.weight) ?? 1;
  if (opts.scaleWeight !== false) {
    const f = num(quota.weightFactor);
    if (f != null) weight = Math.max(1, Math.round(weight * f));
  }

  return new Seat({
    key: s.key == null ? "" : String(s.key),
    account: !!s.account,
    known,
    learns: !!s.learns,
    used,
    soon: Array.isArray(s.soon) ? s.soon.slice() : [],
    pace: num(s.pace) ?? 0,
    weight,
    resting: !!s.resting,
    tokens: num(s.tokens) ?? 0,
    free: !!s.free,
  });
}

/**
 * 把**上游自己报的余额**折算进一个座位（routes.mjs 的 Seat）。
 *
 * 与 {@link applyQuotaToSeat} 的分工：那个吃的是**我们自己估的预算**
 * （账本 + 用户设的上限），这个吃的是**上游探回来的真值**。
 * 真值更权威，所以取 max —— 上游说 90%、我们估 30%，该按 90% 走
 * （上游是硬事实）；上游说 30%、我们估 90%，也该按 90% 走（我们替用户省着花）。
 *
 * ⚠⚠ **探不到 ≠ 用完，也 ≠ 没用过**：探不到时**原样返回座位**，一个字节都不改。
 *   把「探不到」当成 0% → 这一家看起来「额度很富余」被排到最前，而真相可能是
 *   它已经欠费了；把它当成 100% → 一家好渠道因为网络不通被踢出候选。
 *   **没有信号就是没有信号**，两种猜法都会把猜测变成行为。
 *
 * ⚠ **只折进 used，不动 resting**：额度用完的那家仍然**留在候选里**，
 *   只是排到最后（routes.mjs 的 smart 把 used≥98 的算「spent」档）。
 *   直接踢掉的话，「所有渠道都冷却」会变成「没有渠道」，用户看到的是一句
 *   没有出处的失败，而不是上游真实的 402/429 —— 宁可试一次拿到真错误。
 *
 * ⚠ **分母必须是正的**：上游只给百分比时 limit 记 100（百分数的分母），
 *   那是能算的；但 limit 为 0 或缺失时**没有比例可言**，按「没有信号」处理。
 *
 * @param {object} seat 原来的座位（routes.Seat）
 * @param {object} probe 探测结果 { known, used, limit, unit }
 * @returns {Seat} 新座位；没有信号时原样返回
 */
export function applyProbeToSeat(seat, probe) {
  const s = seat && typeof seat === "object" ? seat : {};
  if (!probe || probe.known !== true) return s;
  const used = num(probe.used);
  const limit = num(probe.limit);
  if (used == null || limit == null || limit <= 0) return s;   // 没有分母 = 没有比例
  const pct = Math.round(clampPct((used / limit) * 100));
  const merged = Math.max(Math.round(clampPct(num(s.used) ?? 0)), pct);
  const weight = Math.max(1, Math.round((num(s.weight) ?? 1) * Math.max(0, 1 - merged / 100)));
  return new Seat({
    key: s.key == null ? "" : String(s.key),
    account: !!s.account,
    known: true,                  // 上游报了真值 = 我们知道这家用了多少
    learns: !!s.learns,
    used: merged,
    soon: Array.isArray(s.soon) ? s.soon.slice() : [],
    pace: num(s.pace) ?? 0,
    weight,
    resting: !!s.resting,
    tokens: num(s.tokens) ?? 0,
    free: !!s.free,
  });
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 休息：预算耗尽 → 让这家歇到窗口重置
 * ══════════════════════════════════════════════════════════════════════ */

/** 窗口的中文标签（写进面板给人看）。 */
function windowLabel(name) {
  return name === "hourly" ? "每小时" : name === "daily" ? "每天" : "";
}

/**
 * 预算耗尽时写进休息表的那条 note。
 *
 * ⚠ **归因必须与「上游额度用尽」分开**：kind 用 {@link BUDGET_KIND}（"budget"），
 *   不是 candidates.KINDS 里的 "quota"/"credit"。面板照着 kind 显示失败原因，
 *   混用就会显示一个**根本没发生过**的上游额度耗尽。
 *   why 里也要把这件事说清楚：是我们自己的估算，窗口重置后自动恢复。
 *
 * @param {object} state {@link quotaState} 的结果
 * @param {string} [provider] 渠道 id（缺省取 state.provider）
 */
export function budgetRestNote(state, provider) {
  const st = state && typeof state === "object" ? state : {};
  const p = String(provider || st.provider || "");
  const label = windowLabel(st.window);
  const reset = num(st.resetAtMs);
  const iso = reset == null ? "下个窗口边界" : new Date(reset).toISOString();
  return {
    kind: BUDGET_KIND,
    scope: "account",
    why: `本地额度预算用尽（${p}：${label}已用 ${st.used} / ${st.limit} ${st.unit}）：`
      + "这是我们自己设的预算，不是上游额度用尽；到 " + iso + " 窗口重置后自动恢复。",
    model: null,
    budget: {
      provider: p,
      unit: st.unit,
      window: st.window,
      used: st.used,
      limit: st.limit,
      ratio: st.ratio,
      resetAtMs: reset,
    },
  };
}

/**
 * 预算耗尽 → 休息到什么时候。
 *
 * 就是窗口重置时刻：那一刻起新窗口的用量从零算，预算自动恢复，休息也自动到期
 * （休息表按 until 判定，到点即失效，不必有人去撤销）。
 */
export function budgetRestUntil(state) {
  const st = state && typeof state === "object" ? state : {};
  return num(st.resetAtMs);
}

/**
 * 「要不要让这家休息」的完整决定。
 *
 * 调用方拿到 rest=true 时，把 untilMs 与 note 写进休息表即可（写 restKey 那一层，
 * 于是 isResting 能看见它，两级休息的机制照旧生效）。
 *
 * @returns {{rest:boolean, untilMs:number|null, note:object|null, state:object}}
 */
export function budgetRestDecision(provider, cfg, records, now) {
  const state = quotaState(provider, cfg, records, now);
  if (!state.exhausted) {
    return { rest: false, untilMs: null, note: null, state };
  }
  return {
    rest: true,
    untilMs: budgetRestUntil(state),
    note: budgetRestNote(state, provider),
    state,
  };
}
