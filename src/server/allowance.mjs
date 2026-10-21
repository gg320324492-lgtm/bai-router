/* ==========================================================================
 * 额度模型（allowance）：把 magpie 的 quota window 搬过来，给「配额感知路由」当数据基础。
 *
 * ── 为什么要有这个模块 ─────────────────────────────────────────────────────
 * magpie 的额度模型建立在「供应商主动报告配额」这件事上：它拿着登录态去问
 * Anthropic / OpenAI / GitHub 的私有额度接口，拿到一组 QuotaWindow（每条窗口说清：
 * 用了多少、什么时候重置、这条窗口只算哪些模型），routing 再用这组窗口决定
 * 「这个账号还能不能接这个模型」（internal/provider/routing.go 的 Allowance）。
 *
 * bai-router 拿不到那些东西：供应商大多不暴露配额 API，账号也不是登录态 OAuth。
 * 但 bai-router **已经有**别的信号 —— 上游 429 的 Retry-After / X-RateLimit-Reset、
 * 本地记着的冷却到期时刻、供应商偶尔在正文里给的 resets_in。这些信号比 magpie 的
 * 窗口「薄」（常常只知道「什么时候能用」，不知道「用了多少」），但**形状是同一个**：
 * 一条带重置时刻的额度窗口。
 *
 * 所以本模块做的是**同一套抽象、换一套数据来源**：字段照抄 magpie 的 QuotaWindow，
 * 判定（用尽 / 续期 / 摊速 / 是否只对某些模型生效）照抄 magpie 的语义，
 * **但不假设能查供应商配额 API**。没有的信号就是没有，不编。
 *
 * ── 字段对照（magpie 的 QuotaWindow → 这里的字段）─────────────────────────
 *   Used      → used       已用**百分比** 0..100（magpie: Limit.Used "share used, 0–100"）
 *   ResetsAt  → resetsAt   窗口重置时刻，**epoch 毫秒**（magpie: *time.Time）
 *   ResetSecs → resetSecs  距重置的**秒数**（magpie: int64；当绝对时刻不可知时用）
 *   Span      → span       窗口跨度，**毫秒**（magpie: time.Duration，纳秒；这里统一毫秒）
 *   Model     → model      这条窗口**只算哪些模型**（模型 id 里的一个词，magpie 同义）
 *   Amount    → amount     窗口自己的计数（已用），单位是 unit（magpie: float64）
 *   Limit     → limit      窗口自己的计数（总量），单位是 unit（magpie: float64）
 *   Unit      → unit       amount / limit 的单位（magpie: string）
 *   RunsOutAt → runsOutAt  「剩下的东西没了」的时刻，**epoch 毫秒**（magpie: *time.Time）
 *   Aside     → aside      用完这条窗口**不让账号停**（magpie: bool）
 *   Pool      → pool       共享同一份额度的模型组（magpie: string）
 *
 *   magpie 的 QuotaWindow 还有 Name / Display / Family / Unlimited / Holds 等字段：
 *   前三个是给面板看的（bai-router 面板另有一套显示逻辑），Family 是 Antigravity 那种
 *   「模型族」归并（bai-router 这边没有这种供应商），Unlimited / Holds 需要供应商的
 *   配额接口才谈得上 —— **在这里一律不做**，不假装有。
 *
 * ── 刻度约定（两套，别混）─────────────────────────────────────────────────
 *   · 窗口的 `used` 字段是**百分比 0..100**（与 magpie 一致，也与 SPENT_SHARE=98
 *     直接可比：98% 即「几乎用尽」）。
 *   · 对外的 `windowShare` / `estimateShare` 给的是**比例 0..1**（题面要求）。
 *
 * ── 硬规矩 ────────────────────────────────────────────────────────────────
 *   · 零依赖，不碰 fs / 网络。
 *   · **内部绝不调 Date.now()**：所有时刻都由参数传入（now），这样同一份逻辑可以
 *     被回放、被测试、被并发调用而不互相污染。
 * ========================================================================== */

/* ==========================================================================
 * ① 常量
 * ========================================================================== */

/**
 * magpie 的 SpentShare（internal/provider/codex_switch.go）：额度用到这个百分比就算
 * 「用尽」——Smart 路由开始躲它，登录切换也开始换号。
 * 之所以不是 100：供应商的计数往往有延迟，等真到 100% 早就被拒了。
 */
export const SPENT_SHARE = 98;

/**
 * magpie 的 SpentShareOf：按名单顺序发请求的供应商（magpie 的 Ordered = "order"）
 * 要等到 100% 才算用尽 —— 它是「先把第一个账号用到不能用了才换下一个」的策略，
 * 98% 就换等于还没用完就放弃（#530）。
 */
export function SPENT_SHARE_OF(routing) {
  return String(routing || "").trim().toLowerCase() === "order" ? 100 : SPENT_SHARE;
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * magpie 的 weekSpan（routing.go）：供应商什么都不说时，就当这条账户有一周的额度
 * —— 一个刚开的号不可能比这更空。
 */
const WEEK_MS = 7 * 24 * MS_PER_HOUR;

/* ==========================================================================
 * ② 小工具
 * ========================================================================== */

/** 只认有限数字；null / undefined / NaN / Infinity 一律当作「没有」。 */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampPct(x) {
  return x < 0 ? 0 : x > 100 ? 100 : x;
}

/** 取不到就当 0（magpie 的 max(0, …) 口径）。 */
function numOr0(v) {
  const n = num(v);
  return n == null ? 0 : n;
}

/** 窗口对象的自我保护：调用方传了别的东西进来时不要炸。 */
function asWindow(w) {
  return w && typeof w === "object" ? w : {};
}

/**
 * 一个数是不是「绝对时刻」：>= 1e11 当作 epoch 毫秒，>= 1e9 当作 epoch 秒，
 * 更小的当作「还有多少秒」（不是时刻）。
 *
 * 为什么要分这三档：X-RateLimit-Reset 有时给秒有时给毫秒（server.mjs 里
 * 「reset > 0 && reset < 1e12 就乘 1000」是同一个口径的另一种写法），而正文里的
 * resets_in 给的是「还有 N 秒」—— 三者混在一个字段里，必须按数量级分家，
 * 否则「还有 1800 秒」会被当成 1970 年的时刻。
 */
function epochMsOf(v) {
  const n = typeof v === "string" && v.trim() !== "" && /^[0-9]+(\.[0-9]+)?$/.test(v.trim())
    ? Number(v.trim())
    : num(v);
  if (n == null || n <= 0) return null;
  if (n >= 1e11) return Math.round(n);
  if (n >= 1e9) return Math.round(n * 1000);
  return null;
}

/** 大小写不敏感地取一个响应头（headers 可能是 Map、对象或 fetch 的 Headers）。 */
function headerGet(headers, lower) {
  if (headers == null) return null;
  if (typeof headers.get === "function") {
    const v = headers.get(lower);
    if (v != null) return String(v);
    return null;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && String(pair[0] || "").toLowerCase() === lower) return String(pair[1]);
    }
    return null;
  }
  if (typeof headers === "object") {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) {
        const v = headers[k];
        if (v != null) return String(v);
      }
    }
  }
  return null;
}

/* ==========================================================================
 * ③ 窗口本身
 * ========================================================================== */

/**
 * 造一条额度窗口（magpie 的 QuotaWindow）。
 *
 * 字段含义见文件头的对照表。这里只做**归一**：把缺的值补成「没有」的表示
 * （null / 0 / ""），不猜、不填默认值 —— 一个「不知道重置时刻」的窗口，
 * 不该被伪装成一个「马上重置」的窗口。
 *
 * @param {object} fields
 * @returns {object} 额度窗口
 */
export function makeWindow(fields = {}) {
  const f = fields && typeof fields === "object" ? fields : {};
  return {
    /** Used：已用百分比 0..100 */
    used: clampPct(numOr0(f.used)),
    /** ResetsAt：重置时刻（epoch 毫秒），null = 不知道 */
    resetsAt: num(f.resetsAt),
    /** ResetSecs：距重置的秒数（绝对时刻不可知时用），0 = 不知道 */
    resetSecs: numOr0(f.resetSecs),
    /** Span：窗口跨度（毫秒），0 = 不知道 */
    span: numOr0(f.span),
    /** Model：这条窗口只算哪些模型（模型 id 里的一个词），"" = 整号都算 */
    model: f.model == null ? "" : String(f.model),
    /** Amount：窗口自己的计数（已用），配合 limit / unit */
    amount: numOr0(f.amount),
    /** Limit：窗口自己的计数（总量） */
    limit: numOr0(f.limit),
    /** Unit：amount / limit 的单位 */
    unit: f.unit == null ? "" : String(f.unit),
    /** RunsOutAt：「剩下的东西没了」的时刻（epoch 毫秒），null = 不知道 */
    runsOutAt: num(f.runsOutAt),
    /** Aside：用完这条窗口不让账号停 */
    aside: !!f.aside,
    /** Pool：共享同一份额度的模型组，"" = 没有 */
    pool: f.pool == null ? "" : String(f.pool),
  };
}

/**
 * 这条窗口的「已用比例」，**0..1**。
 *
 * @param {object} w 窗口
 * @param {number} [used] 该窗口自己计数口径下的「已用量」（供应商那样报数时用）
 * @returns {number} 0..1
 */
export function windowShare(w, used) {
  const win = asWindow(w);
  const u = num(used);
  const lim = num(win.limit);
  // 供应商按绝对计数报数时（WorkBuddy 的积分），份额由「已用 / 总量」算
  if (u != null && lim != null && lim > 0) return estimateShare(u, lim);
  // 否则用窗口自己记的百分比（0..100）折成比例
  return clamp01(numOr0(win.used) / 100);
}

/**
 * 已用比例（0..1）= used / limit。
 *
 * 总量不可知（limit <= 0）或已用量不是数 → 返回 0：**「不知道」不等于「用完了」**，
 * 也不等于「一点没���」—— 但路由只关心「有没有用完」，0 是安全的那个方向
 * （宁可多试一个号，别把好号提前判死）。
 */
export function estimateShare(used, limit) {
  const u = num(used);
  const l = num(limit);
  if (u == null || l == null || l <= 0) return 0;
  return clamp01(u / l);
}

/**
 * 这条窗口管不管这个模型（magpie 的 Limit.applies）。
 *
 * magpie 的口径是「模型 id 里有那个词就算」（strings.Contains）：窗口写 model="opus"，
 * 那么 claude-opus-… 都算它管。窗口的 model 为空 = 整号都算。
 */
export function appliesTo(w, model) {
  const scope = String(asWindow(w).model || "").trim().toLowerCase();
  if (!scope) return true;
  const m = String(model == null ? "" : model).toLowerCase();
  return m.includes(scope);
}

/* ==========================================================================
 * ④ 时刻：什么时候用完 / 什么时候续期
 * ========================================================================== */

/**
 * 窗口的**重置时刻**：有绝对时刻就用它；只有「距今多少秒」且知道 now 时才换算。
 */
function resetMomentOf(w, now) {
  const win = asWindow(w);
  const abs = num(win.resetsAt);
  if (abs != null) return abs;
  const secs = num(win.resetSecs);
  const n = num(now);
  if (secs != null && secs > 0 && n != null) return n + secs * 1000;
  return null;
}

/**
 * 这条窗口**什么时候用完**（epoch 毫秒）——「用完」的两个时刻取更早的：
 *
 *   · 配额用完的时刻（RunsOutAt）：剩下的东西没了。bai-router 这边最常见的来源是
 *     **本地冷却到期时刻**：配额是多少不知道，但这个号到那一刻之前用不了。
 *   · 重置的时刻（ResetsAt）：窗口重来，里面的东西又有了。
 *
 * 取更早的那个：**更早的那个才是「这条窗口不再约束我」的时刻**。两个都知道就取
 * 早的；只知道一个就取那一个；都不知道 → null（真的不知道，不是「马上」）。
 *
 * 对应 magpie：`Limit.RunsOut` + `QuotaWindow.RunsOutAt` 是同一件事的一半，另一半
 * （重置）在 magpie 的 Allowance.Renewal 里和它取早。这里把两半合到一个函数里，
 * 因为调用方问的就是「这条窗口什么时候不再是问题」。
 *
 * @param {object} w 窗口
 * @param {number} [now] 当前时刻（epoch 毫秒）；给了才能把 resetSecs 换算成时刻
 * @returns {number|null}
 */
export function runsOutAt(w, now = null) {
  const win = asWindow(w);
  const reset = resetMomentOf(win, now);
  const out = num(win.runsOutAt);
  if (reset == null) return out;
  if (out == null) return reset;
  return Math.min(reset, out);
}

/**
 * 这条窗口**什么时候续期**（epoch 毫秒）—— 也就是「我什么时候能重新按这条窗口判断」。
 *
 * 与 runsOutAt 的差别在两种情形：
 *   · **重置时刻已经过了** → 这条窗口已经又空了，不能再拿旧的「已用 98%」说事。
 *     这时按 magpie 的 Renewal：知道跨度就按跨度往后推一个窗口（now + span），
 *     不知道跨度就说不知道（null）。
 *   · **只知道 resetSecs** → 换算成绝对时刻。
 *
 * 「用完」比「重置」早时，取用完（magpie 的 Renewal 同理：credits 先没就是先没）。
 *
 * @param {object} w 窗口
 * @param {number} [now] 当前时刻（epoch 毫秒）
 * @returns {number|null}
 */
export function renewalOf(w, now = null) {
  const win = asWindow(w);
  const n = num(now);
  let base = resetMomentOf(win, now);
  // 重置时刻已过 → 窗口已经重来，下一次重置按跨度推
  if (n != null && base != null && base <= n) {
    const span = num(win.span);
    base = span != null && span > 0 ? n + span : null;
  }
  const out = num(win.runsOutAt);
  if (out != null && (n == null || out > n) && (base == null || out < base)) base = out;
  return base;
}

/* ==========================================================================
 * ⑤ 判定：用尽了没有 / 每小时摊到多少 / 只对某些模型生效吗
 * ========================================================================== */

/**
 * 这条窗口在给定 share 下**算不算用尽**。
 *
 * @param {object} w 窗口
 * @param {number} [share] 判定线（百分比），默认 magpie 的 SPENT_SHARE=98
 * @param {number} [now] 当前时刻（epoch 毫秒）；给了才知道窗口是不是已经重置过
 * @returns {boolean}
 */
export function fullAt(w, share = SPENT_SHARE, now = null) {
  const win = asWindow(w);
  // aside：用完这条窗口也不让账号停（magpie 的 usedPast 跳过 Aside）
  if (win.aside) return false;
  const line = num(share) == null ? SPENT_SHARE : share;
  const used = numOr0(win.used);
  const n = num(now);
  // 重置时刻已经过了 → 这条窗口又空了，不是「用尽」
  if (n != null) {
    const reset = resetMomentOf(win, n);
    if (reset != null && reset <= n) return false;
  }
  return used >= line;
}

/**
 * 每小时摊到多少：**剩余百分比 ÷ 距重置的小时数**（magpie 的 Allowance.Pace）。
 *
 * 「摊到多少」= 按现在的余量摊到重置那一刻，每小时要烧掉多少 —— 摊得越快，
 * 掉得越快，路由越该早点把这个号让出去。
 *
 * 三条不能省的规矩：
 *   · **小时数永不低于 1**（magpie: max(until, time.Hour)）：一个一分钟后就重置的
 *     窗口不能因为「摊得飞快」而压过所有别的号。
 *   · **重置时刻过了不算数**：那条窗口已经又空了（已用按 0 算），并按跨度往后推
 *     一个窗口；于是结果永远是有限非负的数，不会是 Infinity 或负数。
 *   · **什么都不知道时按一周算**（magpie 的 weekSpan）：新号不可能比一周更空，
 *     也不该因为「不知道」就被判成最差。
 *
 * @param {object} w 窗口
 * @param {number} now 当前时刻（epoch 毫秒）—— 必填
 * @returns {number} 每小时摊掉的百分比
 */
export function paceOf(w, now) {
  const win = asWindow(w);
  const n = num(now);
  if (n == null) {
    throw new TypeError("paceOf 需要 now（epoch 毫秒）：「每小时摊到多少」取决于距重置还有多久");
  }
  let used = clampPct(numOr0(win.used));
  let end = runsOutAt(win, n);
  if (end != null && end <= n) {
    // 窗口已经重置过了 → 又空了
    used = 0;
    const span = num(win.span);
    end = span != null && span > 0 ? n + span : null;
  }
  let hours;
  if (end != null) {
    hours = (end - n) / MS_PER_HOUR;
  } else {
    const span = num(win.span);
    hours = span != null && span > 0 ? span / MS_PER_HOUR : WEEK_MS / MS_PER_HOUR;
  }
  if (!Number.isFinite(hours) || hours < 1) hours = 1;
  return Math.max(0, 100 - used) / hours;
}

/**
 * 这条窗口是不是**只对某些模型生效**（magpie 的 Allowance.Pooled 的单窗口形式）。
 *
 * magpie 的 Pooled 问的是账号级的事：「model 被拒了，别的模型还能不能用」。
 * 这里给的是它的单窗口形式：一条**有作用域**的窗口（model 非空）**不该算到
 * 作用域外的模型头上** —— 那是 Cursor「Other Models」那类池子用尽一个模型、
 * 别的模型照跑的那回事。
 *
 *   · 整号窗口（model 为空）→ false：它本来就管所有模型，不是「只对某些模型生效」。
 *   · 有作用域的窗口，model 落在作用域**外** → true：跟这个模型无关。
 *   · 有作用域的窗口，model 落在作用域**内** → false：它正管着这个模型。
 */
export function pooledAt(w, model) {
  const scope = String(asWindow(w).model || "").trim().toLowerCase();
  if (!scope) return false;
  const m = String(model == null ? "" : model).toLowerCase();
  return !m.includes(scope);
}

/* ==========================================================================
 * ⑥ 合并：多条窗口取最紧的那条
 * ========================================================================== */

/**
 * 合并多条窗口：**取最紧的那条**。
 *
 * 「紧」怎么判：
 *   1. **已用得多**的更紧 —— 这是 magpie 的 Allowance.For 的口径（取 used 的最大值）。
 *   2. 已用一样多 → **更早用完**的更紧（重置与用完取早的那个）。
 *   3. 还一样 → 一个已知结束时刻、一个不知道的，**已知的更紧**（有确定约束的
 *      那个更值得当依据）；再一样就保持顺序（先来的那条）。
 *
 * aside 的窗口用完也不让账号停，合并时不算数（magpie 的 allowanceOf 也是直接丢掉
 * Aside）。全是 aside → null：**没有能约束账号的窗口**，这是实话。
 *
 * 返回的是那条窗口的**副本**（不改调用方的对象），并**保留它的作用域**（model）：
 * 合并出来的窗口若带作用域，调用方要先用 pooledAt 判一下它管不管自己要发的模型，
 * 别把「某个模型的额度」当成「整个账号的额度」。
 *
 * @param {Array<object>} list 窗口数组
 * @returns {object|null}
 */
export function mergeWindows(list) {
  const ws = Array.isArray(list) ? list.filter((w) => w && typeof w === "object") : [];
  const live = ws.filter((w) => !w.aside);
  if (!live.length) return null;
  let best = null;
  for (const w of live) {
    if (best == null || tighter(w, best)) best = w;
  }
  return { ...best };
}

/** a 是否比 b 更紧（见 mergeWindows 的注释）。 */
function tighter(a, b) {
  const ua = numOr0(a.used);
  const ub = numOr0(b.used);
  if (ua !== ub) return ua > ub;
  const ea = runsOutAt(a, null);
  const eb = runsOutAt(b, null);
  if (ea !== eb) {
    if (ea == null) return false;   // 不知道结束时刻 → 不如知道的那个紧
    if (eb == null) return true;
    return ea < eb;                 // 都已知 → 更早用完的更紧
  }
  return false;
}

/* ==========================================================================
 * ⑦ 信号 → 窗口
 * ========================================================================== */

/**
 * 从上游答复里读两个信号：**配额什么时候重置**、**多久之后能再试**。
 *
 * 口径照抄 wb-pool.mjs 的 parseRetryAfterMs（那个函数没导出，这里按同样的约定
 * 重写一遍；等路由那边接线时，可以把两边合并成一处）。
 *
 *   · `Retry-After`：秒数或 HTTP-date → 「多久之后再试」。
 *   · `X-RateLimit-Reset`：epoch 秒或毫秒 → 配额重置时刻（绝对）。
 *   · 正文里的 `resets_in` / `reset_at` / `retry_after` 等字段。
 *
 * @param {object|Map|Array} headers 响应头
 * @param {string} [body] 响应正文
 * @param {number} [now] 当前时刻（epoch 毫秒），用来算「还有多久」
 * @returns {{resetsAt: number|null, retryAfterMs: number|null}}
 */
export function readResetSignals(headers, body, now = null) {
  const out = { resetsAt: null, retryAfterMs: null };
  const n = num(now) || 0;

  const ra = headerGet(headers, "retry-after");
  if (ra != null) {
    const raw = String(ra).trim();
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) {
      out.retryAfterMs = Math.round(secs * 1000);
    } else {
      const t = Date.parse(raw);   // HTTP-date（纯解析，不是「现在」）
      if (Number.isFinite(t)) out.retryAfterMs = Math.max(0, t - n);
    }
  }

  const reset = headerGet(headers, "x-ratelimit-reset");
  if (reset != null) {
    const t = epochMsOf(String(reset).trim());
    if (t != null) out.resetsAt = t;
  }

  const m = /(?:resets_in|resetsIn|reset_at|resetAt|resets_at|reset_after|retry_after|retryAfter)"?\s*[:=]\s*"?([0-9][0-9.]*)/i
    .exec(String(body || ""));
  if (m) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v >= 0) {
      const abs = epochMsOf(v);
      // 像绝对时刻（>= 1e9）就当重置时刻；否则是「还有 N 秒」
      if (abs != null && abs > n) out.resetsAt = abs;
      else out.retryAfterMs = Math.round(v * 1000);
    }
  }
  return out;
}

/**
 * 从**已有的信号**造一条额度窗口 —— 这是本模块与 bai-router 的接口。
 *
 * 支持的信号（都可选，但 `now` 在用到相对时间时必填）：
 *
 *   | 信号 | 来自 | 落到哪个字段 |
 *   |---|---|---|
 *   | `resetsAt` | `X-RateLimit-Reset` 头 / 正文里的 `reset_at` | resetsAt（并推出 resetSecs） |
 *   | `resetSecs` | 供应商说「还有 N 秒重置」 | resetSecs（有 now 则同时推出 resetsAt） |
 *   | `retryAfterMs` | `Retry-After` 头 / 正文里的 `retry_after` | 没别的重置时刻时当 resetsAt |
 *   | `used` + `limit` (+ `unit`) | 供应商自己的用量字段 | amount / limit / unit（并推出 used 百分比） |
 *   | `usedPercent` / `usedShare` | 供应商直接给的百分比 | used |
 *   | `model` | 这次被拒的模型 / 窗口的作用域 | model（供 pooledAt 用） |
 *   | `cooldownUntilMs` | 本地冷却到期时刻（wb-pool 的 acct.cooldownUntilMs / modelCooldowns[m]） | runsOutAt |
 *   | `span` / `spanMs` | 窗口跨度（若可知） | span |
 *   | `aside` / `pool` | — | aside / pool |
 *
 * 另外可以直接丢 `headers` / `body` 进来（readResetSignals 会读），
 * 与显式给的字段冲突时**显式的优先**。
 *
 * 两条要说清的近似：
 *   · **Retry-After 不是配额重置**，它说的是「多久之后再试」。在没有别的重置时刻
 *     时把它当作这条窗口的有效重置（那个时刻之前这个号确实用不了），并在
 *     resetsAt 里如实记下来 —— 宁可粗一点，也不要假装知道。
 *   · **cooldownUntilMs 落到 runsOutAt**：配额是多少不知道，但**那个号到那时之前
 *     用不了**，语义上正对应 magpie 的 RunsOut（「剩下的东西没了」）。
 *
 * @param {object} sig 信号
 * @returns {object} 额度窗口
 */
export function fromSignals(sig = {}) {
  const s = sig && typeof sig === "object" ? sig : {};
  const now = num(s.now);

  let resetsAt = num(s.resetsAt);
  let resetSecs = num(s.resetSecs);
  let span = num(s.span) != null ? num(s.span) : num(s.spanMs);

  // 响应头 / 正文里读到的信号（显式字段优先）
  let retryAfter = num(s.retryAfterMs);
  if (s.headers != null || s.body != null) {
    const read = readResetSignals(s.headers, s.body, now);
    if (resetsAt == null) resetsAt = read.resetsAt;
    if (retryAfter == null) retryAfter = read.retryAfterMs;
  }

  // 只有「距今多少秒」→ 换算成绝对时刻（magpie 的 allowanceOf 同款）
  if (resetsAt == null && resetSecs != null && resetSecs > 0 && now != null) {
    resetsAt = now + resetSecs * 1000;
  }

  // Retry-After：没有别的重置时刻时，它就是「多久之后这个号能用」的近似
  const retryAfterMs = retryAfter;
  if (resetsAt == null && retryAfterMs != null) {
    if (now == null) {
      throw new TypeError("fromSignals：给了 retryAfterMs 却没给 now，无法换算成时刻");
    }
    resetsAt = now + retryAfterMs;
  }

  // 有了绝对时刻就算出「距今多少秒」（magpie 的 ResetSecs）
  if (resetsAt != null && now != null && resetSecs == null) {
    resetSecs = Math.max(0, Math.round((resetsAt - now) / 1000));
  }

  // 绝对计数（供应商按数报额度时）：used/limit → amount/limit + 已用百分比
  const amount = num(s.amount) != null ? num(s.amount) : num(s.used);
  const limit = num(s.limit);
  const unit = s.unit == null ? "" : String(s.unit);

  let used = num(s.usedPercent);            // 直接给的百分比（0..100）
  if (used == null) {
    const share = num(s.usedShare);          // 或比例（0..1）
    if (share != null) used = share * 100;
  }
  if (used == null && amount != null && limit != null && limit > 0) {
    used = estimateShare(amount, limit) * 100;   // magpie：Used 是 Amount 占 Limit 的份额
  }

  return makeWindow({
    used,
    resetsAt,
    resetSecs,
    span,
    model: s.model,
    amount,
    limit,
    unit,
    // 本地冷却到期 = 这个号到那时之前用不了（配额未知，但「用不了」是知道的）
    runsOutAt: num(s.cooldownUntilMs),
    aside: s.aside,
    pool: s.pool,
  });
}
