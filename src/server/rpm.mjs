/**
 * rpm.mjs —— 每家渠道的「每分钟请求数」上限（分钟闸门）
 *
 * ── 它补的是哪个洞 ──────────────────────────────────────────────────────
 * bai-router 现在只有「谁失败了换一家」（candidates.mjs 的两级休息 + 退避），
 * **没有一道「一分钟最多发几个」的闸门**。于是一个 Claude Code 长流式 + 用户
 * 手滑连点几次，就能在一分钟里把这一家打爆；上游按**每分钟请求数**限，我们
 * 这边看不见也管不着 —— 表现是随机的 429，而且**面板上什么都看不出来**
 * （不是哪家的模型坏了，是这一家当下被自己打爆了）。
 *
 * ⚠ 与并发闸门（concurrency.mjs）是**两件事**，别混：
 *   · 并发 = 「**同时**有几个在飞」→ 管的是**连接数 / 账号被占**；
 *   · RPM   = 「**一分钟**发出去几个」→ 管的是**请求频率**。
 *   一条请求完全可能并发不超（同时只有 1 个）却把 RPM 打爆（60 秒内发了 21 个）。
 *   所以两个闸门都要有，而且**各拒各的**。
 *
 * ── magpie 对应哪个文件 ────────────────────────────────────────────────
 * yetone/magpie `internal/gateway/rpm.go`（rpms / reserve / giveBack / wait /
 * prune / errRPM）。窗口口径照抄，见下面「窗口口径」。
 *
 * ── 窗口口径（照抄 magpie，别自己发明）────────────────────────────────
 *   · **滚动窗口**（不是固定窗口）：magpie 的 `rpms` 记的是每个请求的「发出去
 *     的时刻」，room 的判据是「**最近一分钟里**发出去的还不到 N 个」。
 *   · 窗口长 **60 秒 + 1 秒松弛**（magpie 的 `rpmWindow` + `rpmSlack`）。
 *     为什么要那 1 秒：magpie 原话 —— 请求是**我们发出**时计数的，而供应商是
 *     **收到**时计数的；连接上的第一个请求因为要拨号 + TLS 握手，到得比后面的
 *     晚。只用裸的 60 秒窗口，供应商自己那一分钟里就会看到比上限多一个。
 *     `TestMaxRPMWaitsForRoomInTheMinute` 在 CI 负载下就是这么红的。
 *   · 排队的时刻按**先来先服务**排：第 N+1 个请求的时刻 = 「倒数第 N 个已有
 *     请求的时刻 + 窗口长」（magpie 的 `ts[len(ts)-limit].Add(rpmSpan)`）。
 *   · 等不起就**当场拒**，拒的时候带 **Retry-After**（magpie 的 `errRPM`）：
 *     最多等 `rpmLongest`（2 分钟；provider 的 QueueWait 更短就用那个）。
 *
 * ── 与 magpie 的口径差异（以及为什么）──────────────────────────────────
 *   · **取消**：magpie 用 Go 的 `context`；我们在 JS 里用 `opts.signal`
 *     （AbortSignal）承担同一件事 —— 「客户端走了就别占着分钟里的位置」。
 *   · **时间戳按序插入**（magpie 直接 append）：magpie 靠「时刻只增不减」这条
 *     不变量保证列表有序；我们改成**插到该在的位置**，因为一旦有个未来时刻被
 *     插到中间，magpie 那个「从头裁掉过期项」的 prune 就会裁错位置 —— 剪掉
 *     的不是最老的那几个，整扇窗口的记账当场歪掉。口径不变（照样取
 *     `ts[len-limit]`），只是不再依赖那条脆弱的不变量。
 *   · **Retry-After 会被采纳**（magpie 没有这件事）：magpie 只**发出**
 *     Retry-After，不**读**上游的。我们的取舍：上游明说「N 秒后再来」时，
 *     这一家的下一次发送**不得早于**那个时刻（`noteRetryAfter`）。理由：
 *     上游给 Retry-After 是因为它知道自己的闸门在哪关着；无视它等于拿
 *     已知会失败的请求去撞墙。
 *   · **拒绝的语义与并发闸门区分开**：RPM 的拒 = 回给客户端的 **429 +
 *     Retry-After**（`retryAfterSec`，至少 1 秒）；并发的拒 = 本地决策
 *     （换一家就行，不必回 429）。上层不要把两者混在一个原因码上。
 *
 * ── 与并发闸门谁先判（顺序照抄 magpie）───────────────────────────────
 * **先拿并发名额，再等 RPM 的分钟里有空位**；而且 RPM 的等待必须发生在
 * **真的要发出去的那一刻之前**（magpie 的 `rpmTransport`：在 RoundTrip 之前
 * 才等）。理由：RPM 记的是「**真的发出去**」的那些请求（magpie 原话：
 * "so the time the minute counts is when it really goes"）。若先占 RPM 再去
 * 排队等并发名额，排队的那几十秒会被算进这一分钟 —— 白白浪费额度，还可能
 * 把本来能发的请求挤到下一分钟。
 *
 * 所以调用方的顺序必须是：
 * ```js
 * const slot = await conc.acquire(key);           // ① 先占并发名额
 * try {
 *   const rpm = await rpmLimiter.acquire(key);    // ② 再等分钟里有空位（这一步
 *   if (!rpm.ok) throw new TooManyRequests(rpm.retryAfterSec);  //    把请求「记进这一分钟」）
 *   await fetch(url, init);                       // ③ 此刻才真的发出去
 * } finally {
 *   slot.release();                               // ④ 无论成败都还并发名额
 * }
 * ```
 *
 * ── 边界（刻意不做的事）────────────────────────────────────────────────
 *   · **纯逻辑**：零依赖、不碰 fs、不联网、**内部绝不调 `Date.now()`**
 *     （时刻一律由 `opts.now` 传入；等待用的计时器也由 `opts.timer` 注入，
 *     所以测试可以完全确定地推进时间）。
 *   · **不 import 本仓库任何其它模块** —— 它能单独跑测试。
 *     （`parseRetryAfterMs` 与 allowance.mjs 的 `readResetSignals` 是同一件事的
 *     两份实现：那边那个还管 X-RateLimit-Reset，这里只需要 Retry-After，
 *     又不能 import 它，于是各写一份。等接线时可以把两边合并成一处。）
 *   · **不认识「哪家」**：key 是调用方给的字符串，本模块不关心它的含义。
 */

/* ========================================================================== *
 * 一、常量与原因码
 *
 * ⚠ 这些常量与 concurrency.mjs 的**刻意不共用**：并发闸门的「拒」是本地决策
 *    （换一家就行），RPM 的「拒」是要回给客户端的 429 + Retry-After。
 *    混成一套，上层就会把「这家满了」当成「被限流了」，回错状态码。
 * ========================================================================== */

/** 滚动窗口长：60 秒（magpie 的 `rpmWindow`）。 */
export const RPM_WINDOW_MS = 60 * 1000;

/**
 * 松弛：窗口再加 1 秒（magpie 的 `rpmSlack`）。
 *
 * 为什么要那 1 秒：请求是**我们发出**时计数的，而供应商是**收到**时计数的；
 * 连接上的第一个请求因为要拨号 + TLS 握手，到得比后面的晚。只用裸的 60 秒
 * 窗口，供应商自己那一分钟里就会看到比上限多一个。
 */
export const RPM_SLACK_MS = 1 * 1000;

/** 最多等多久（毫秒）—— magpie 的 `rpmLongest`（2 分钟）。 */
export const RPM_LONGEST_WAIT_MS = 2 * 60 * 1000;

/** 当场拒（等不起这一分钟里的位置）：回给客户端 429 + Retry-After。 */
export const REASON_RPM_EXCEEDED = "rpm-exceeded";

/** 等的过程中客户端走了：位置还回去（magpie 的 `giveBack`）。 */
export const REASON_ABORTED = "aborted";

/* ========================================================================== *
 * 二、小工具
 * ========================================================================== */

/** 时刻：函数就调用它，数字就用它；都不是就炸。 */
function toMs(v) {
  const n = typeof v === "function" ? v() : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new TypeError(`时刻必须是 epoch 毫秒（有限数字），收到 ${JSON.stringify(v)}`);
  }
  return n;
}

/**
 * 非负整数，缺省给 dflt。
 *
 * ⚠ 为什么这里要炸：口径错了（把「每分钟 20 个」传成 0.2、传成负数）**只会静默
 * 算错** —— 闸门一旦上限算错，表现是「莫名其妙 429」或「闸门根本不生效」，
 * 而这两种都很难在面板上归因。
 *
 * ⚠ 为什么**整数**也不放过：0.5 个每分钟不是合法配置，而 `Math.floor` 会把它
 *    悄悄变成 0 —— 那就是闸门彻底失效，且面板上显示的是「0」而不是「配错了」。
 */
function intOf(v, dflt, what) {
  if (v == null) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new TypeError(`${what} 必须是有限数字，收到 ${JSON.stringify(v)}`);
  }
  if (n < 0) {
    throw new TypeError(`${what} 不能是负数，收到 ${n}`);
  }
  if (!Number.isInteger(n)) {
    throw new TypeError(`${what} 必须是整数（个数 / 毫秒），收到 ${n}`);
  }
  return n;
}

/**
 * 默认计时器。
 *
 * ⚠ 为什么要 `unref()`：等「分钟里有空位」最长可能挂两分钟；不 unref 的话，
 * 一个早就发完请求的进程会被这个**没用的**计时器吊着不退出。
 */
function defaultTimer(ms, fn) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === "function") t.unref();
  return {
    cancel() {
      clearTimeout(t);
    },
  };
}

/** 取一个头（Map / 普通对象 / 键值数组 / Headers 都认）。 */
function headerGet(headers, name) {
  if (!headers) return null;
  const want = String(name).toLowerCase();
  if (typeof headers.get === "function") {
    const v = headers.get(name);
    return v == null ? null : v;
  }
  if (headers instanceof Map) {
    for (const [k, v] of headers) {
      if (String(k).toLowerCase() === want) return v;
    }
    return null;
  }
  if (Array.isArray(headers)) {
    for (const kv of headers) {
      if (Array.isArray(kv) && String(kv[0]).toLowerCase() === want) return kv[1];
    }
    return null;
  }
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return headers[k];
  }
  return null;
}

/* ========================================================================== *
 * 三、Retry-After
 * ========================================================================== */

/**
 * 读上游的 `Retry-After` → 「多久之后再试」（毫秒）。
 *
 * 两种写法（RFC 7231）：秒数，或 HTTP-date。
 *
 * ⚠ `Date.parse` 是**解析一个给定的时刻**，不是「取现在」—— 与本模块
 *   「内部绝不取真实时钟」的纪律不冲突（allowance.mjs 的 readResetSignals
 *   也是这么写的）。
 *
 * @param {object|Map|Array} headers
 * @param {number} [now] 当前时刻（算 HTTP-date 的差值用；不给就当 0）。
 * @returns {number|null} 毫秒；没有这个头就 null。
 */
export function parseRetryAfterMs(headers, now = null) {
  const raw = headerGet(headers, "retry-after");
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const secs = Number(s);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.round(secs * 1000);
  }
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    return Math.max(0, t - (Number.isFinite(now) ? now : 0));
  }
  return null;
}

/* ========================================================================== *
 * 四、分钟闸门
 * ========================================================================== */

/**
 * 每条 key 一扇「每分钟 N 次」的窗。
 *
 * 用法：
 * ```js
 * const r = await rpmLimiter.acquire(key);
 * if (!r.ok) → 回 429，头里带 Retry-After: r.retryAfterSec
 * // r.ok === true 之后，这一分钟里已经记上了这一次 → 此刻才真的发出去
 * ```
 */
export class RpmLimiter {
  /**
   * @param {object} [opts]
   * @param {number|function} opts.now  时刻（epoch 毫秒）或取时刻的函数。**必填**：
   *        本模块内部绝不取真实时钟 —— 掺了真实时间，分钟账目就没法被测试逐字断言。
   * @param {number} [opts.limit]         默认每分钟上限（0 = 不限）。
   * @param {number} [opts.longestWaitMs] 默认最多等多久（毫秒，0 = 不限等）。
   * @param {number} [opts.windowMs]      窗口长（毫秒，默认 60000）。
   * @param {number} [opts.slackMs]        松弛（毫秒，默认 1000）。
   * @param {function} [opts.timer]        计时器：`(ms, fn) => { cancel() }`。
   */
  constructor(opts = {}) {
    if (opts.now == null || (typeof opts.now !== "function" && typeof opts.now !== "number")) {
      throw new TypeError(
        "RpmLimiter：时间必须由 opts.now 传入（函数或 epoch 毫秒）。" +
        "本模块内部绝不取真实时钟 —— 否则分钟账目掺了真实时间，测试没法逐字断言。",
      );
    }
    this._now = opts.now;
    this._timer = typeof opts.timer === "function" ? opts.timer : defaultTimer;
    this._defaults = normalizeConfig(opts, "RpmLimiter 选项");
    this._configs = new Map();
    /** key → 升序的「发出去的时刻」列表（滚动窗口的账本）。 */
    this._windows = new Map();
    /** key → 上游说「最早什么时候再来」（Retry-After）。 */
    this._blocked = new Map();
  }

  /* ---------------------------------------------------------------- *
   * 配置
   * ---------------------------------------------------------------- */

  /** 给某条 key 定一份配置 { limit, longestWaitMs }。 */
  configure(key, cfg) {
    const k = String(key);
    const c = normalizeConfig(cfg, `key "${k}" 的配置`);
    this._configs.set(k, c);
    return c;
  }

  /** 某条 key 现在的配置。 */
  configOf(key) {
    return this._configs.get(String(key)) || this._defaults;
  }

  /** 某条 key 的每分钟上限。 */
  limitOf(key) {
    return this.configOf(key).limit;
  }

  /** 窗口长（含松弛）—— magpie 的 `rpmSpan()`。 */
  spanMs() {
    return this._defaults.windowMs + this._defaults.slackMs;
  }

  /* ---------------------------------------------------------------- *
   * 占位
   * ---------------------------------------------------------------- */

  /**
   * 预留「这一分钟里的一个位置」，**不等待**。
   *
   * @param {string} key
   * @param {object} [opts]
   * @param {number|function} [opts.now]
   * @param {number} [opts.limit] 本次的上限覆盖。
   * @param {number} [opts.longestWaitMs] 本次的等待上界覆盖。
   * @returns {object} 成了：{ ok:true, at, delayMs }；
   *          不成：{ ok:false, reason, afterMs, retryAfterMs, retryAfterSec }
   */
  reserve(key, opts = {}) {
    const k = String(key);
    const now = this._nowOf(opts);
    const cfg = this.configFor(k, opts);
    const limit = cfg.limit;

    /* 上限 0 = 不限（magpie：limit<=0 counts nothing）。 */
    if (limit <= 0) {
      return { ok: true, at: now, delayMs: 0, counted: false, limit: 0 };
    }

    const span = this.spanMs();
    const ts = this._prune(k, now);

    let at = now;
    /* 满了 → 排到「倒数第 limit 个已有请求的时刻 + 窗口长」之后（magpie 同款）。 */
    if (ts.length >= limit) {
      at = ts[ts.length - limit] + span;
    }
    /* 上游说了「N 秒后再来」→ 不得早于那个时刻（我们自己的取舍，magpie 没有）。 */
    const blocked = this._blockedUntil(k, now);
    if (blocked > at) at = blocked;

    const delay = at - now;
    if (cfg.longestWaitMs > 0 && delay > cfg.longestWaitMs) {
      return {
        ok: false,
        reason: REASON_RPM_EXCEEDED,
        afterMs: delay,
        limit,
        /* Retry-After：等它自己就好了要多久（秒，至少 1）。 */
        retryAfterMs: delay,
        retryAfterSec: retryAfterSecOf(delay),
      };
    }

    this._insert(k, at);
    return { ok: true, at, delayMs: delay, counted: true, limit };
  }

  /**
   * 预留并**等到**该发的那一刻。
   *
   * ⚠ 必须在**真的要发出去之前**调用（magpie 的 rpmTransport 就是这么做的）：
   *    这一分钟记的是「真的发出去的」那些请求。
   *
   * @param {string} key
   * @param {object} [opts]
   * @param {number|function} [opts.now]
   * @param {number} [opts.limit]
   * @param {number} [opts.longestWaitMs]
   * @param {AbortSignal} [opts.signal] 客户端走了就别等了（位置会还回去）。
   * @returns {Promise<object>} { ok, at, waited, reason, retryAfterMs, retryAfterSec }
   */
  async acquire(key, opts = {}) {
    const now = this._nowOf(opts);
    const r = this.reserve(key, { ...opts, now });
    if (!r.ok) {
      return {
        ok: false,
        key: String(key),
        at: null,
        waited: 0,
        reason: r.reason,
        afterMs: r.afterMs,
        retryAfterMs: r.retryAfterMs,
        retryAfterSec: r.retryAfterSec,
      };
    }
    if (r.delayMs <= 0) {
      return { ok: true, key: String(key), at: r.at, waited: 0, reason: null };
    }
    const outcome = await this._waitUntil(r.delayMs, opts.signal);
    if (outcome === "abort") {
      /* 客户端走了 → 位置还回去（magpie 的 giveBack）。 */
      this.giveBack(key, r.at);
      return {
        ok: false,
        key: String(key),
        at: r.at,
        waited: this._now() - now,
        reason: REASON_ABORTED,
        gaveBack: true,
      };
    }
    return { ok: true, key: String(key), at: r.at, waited: r.delayMs, reason: null };
  }

  /**
   * 把一个**没用上**的位置还回去（magpie 的 `rpms.giveBack`）。
   *
   * ⚠ 只有「等的过程中客户端走了」才该调：位置已经记上了、请求也确实发出去了
   *    的那些**不能**还 —— 还了就等于这一分钟白放一个额度出去。
   */
  giveBack(key, at) {
    const k = String(key);
    const ts = this._windows.get(k);
    if (!ts) return false;
    const t = Number(at);
    for (let i = ts.length - 1; i >= 0; i--) {
      if (ts[i] === t) {
        ts.splice(i, 1);
        if (ts.length === 0) this._windows.delete(k);
        return true;
      }
    }
    return false;
  }

  /* ---------------------------------------------------------------- *
   * 观察
   * ---------------------------------------------------------------- */

  /**
   * 这一分钟里已经占了几个位置（magpie 的 `rpms.used`）。
   */
  used(key) {
    const k = String(key);
    const now = this._now();
    return this._prune(k, now).length;
  }

  /**
   * 现在能不能立刻发（magpie 的 `rpms.free`）。
   *
   * 路由层用它挑「还有余量的另一个 key/账号」（magpie 的 `laneMate`/`ready`）。
   */
  free(key) {
    const k = String(key);
    const cfg = this.configOf(k);
    if (cfg.limit <= 0) return true;
    const now = this._now();
    if (this._blockedUntil(k, now) > now) return false;
    return this._prune(k, now).length < cfg.limit;
  }

  /** 这一分钟现在的样子。 */
  stats(key) {
    const k = String(key);
    const cfg = this.configOf(k);
    const now = this._now();
    const ts = this._prune(k, now);
    return {
      key: k,
      limit: cfg.limit,
      used: ts.length,
      free: cfg.limit <= 0 ? true : ts.length < cfg.limit,
      longestWaitMs: cfg.longestWaitMs,
      windowMs: this._defaults.windowMs,
      slackMs: this._defaults.slackMs,
      blockedUntil: this._blockedUntil(k, now),
      nextAt: ts.length >= cfg.limit && cfg.limit > 0 ? ts[ts.length - cfg.limit] + this.spanMs() : now,
    };
  }

  /** 所有 key 的快照。 */
  snapshot() {
    const out = {};
    const keys = new Set([...this._windows.keys(), ...this._configs.keys()]);
    for (const k of keys) out[k] = this.stats(k);
    return out;
  }

  /* ---------------------------------------------------------------- *
   * 上游的 Retry-After
   * ---------------------------------------------------------------- */

  /**
   * 记下上游说的「最早什么时候再来」。
   *
   * ⚠ 这是**我们自己的取舍**，magpie 没有：magpie 只**发** Retry-After，
   *    不**读**上游的。理由：上游给 Retry-After 是因为它知道自己的闸门在哪
   *    关着；无视它等于拿一个**已知会失败**的请求去撞墙，而且撞一次就多
   *    一次被记账的失败。
   *
   * @param {string} key
   * @param {object} o { retryAfterMs, now }  或直接给响应头 { headers, now }
   */
  noteRetryAfter(key, o = {}) {
    const k = String(key);
    const now = this._nowOf(o);
    let ms = o.retryAfterMs;
    if (ms == null && o.headers) ms = parseRetryAfterMs(o.headers, now);
    if (ms == null) return 0;
    const until = now + Math.max(0, Number(ms) || 0);
    const cur = this._blocked.get(k) || 0;
    /* 只往后推，不往前拉 —— 上游说的越久，就等越久。 */
    if (until > cur) this._blocked.set(k, until);
    return this._blocked.get(k);
  }

  /** 记下上游说的「最早什么时候再来」（直接吃响应头）。 */
  noteRetryAfterHeaders(key, headers, now = null) {
    return this.noteRetryAfter(key, { headers, now: now != null ? now : this._now() });
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  _nowOf(opts) {
    const v = opts && opts.now != null ? opts.now : this._now;
    return toMs(v);
  }

  configFor(key, opts) {
    const cfg = this.configOf(key);
    if (!opts || (opts.limit == null && opts.longestWaitMs == null)) return cfg;
    return normalizeConfig(
      {
        limit: opts.limit != null ? opts.limit : cfg.limit,
        longestWaitMs: opts.longestWaitMs != null ? opts.longestWaitMs : cfg.longestWaitMs,
        windowMs: this._defaults.windowMs,
        slackMs: this._defaults.slackMs,
      },
      `key "${key}" 的本次配置`,
    );
  }

  /**
   * 裁掉「窗口长（+松弛）之前」的时刻（magpie 的 `rpms.prune`）。
   *
   * ⚠ 依赖列表**升序**：magpie 直接 append 并靠「时刻只增不减」维持有序；
   *    我们靠 `_insert` 保证有序（见头注释的口径差异），所以这里从头裁是对的。
   */
  _prune(key, now) {
    const k = String(key);
    const ts = this._windows.get(k);
    if (!ts || ts.length === 0) return [];
    const cut = now - this.spanMs();
    let i = 0;
    while (i < ts.length && ts[i] <= cut) i++;
    if (i === 0) return ts;
    const kept = ts.slice(i);
    if (kept.length === 0) this._windows.delete(k);
    else this._windows.set(k, kept);
    return kept;
  }

  /**
   * 把一个时刻记进窗口，**保持升序**。
   *
   * ⚠ 为什么不直接 append（magpie 的做法）：magpie 靠「时刻只增不减」这条
   *    不变量维持有序。一旦有个未来时刻被插到中间（上游 Retry-After 把某个
   *    请求推后了，就会出现这种情况），append 就不再有序，`_prune` 从头裁的
   *    就会裁错 —— 剪掉的不是最老的那几个，整扇窗口的记账当场歪掉。
   */
  _insert(key, at) {
    const k = String(key);
    let ts = this._windows.get(k);
    if (!ts) {
      ts = [];
      this._windows.set(k, ts);
    }
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < at) lo = mid + 1;
      else hi = mid;
    }
    ts.splice(lo, 0, at);
  }

  /** 上游说的「最早什么时候再来」（没有或已过期就 0）。 */
  _blockedUntil(key, now) {
    const k = String(key);
    const until = this._blocked.get(k);
    if (until == null) return 0;
    if (until <= now) {
      this._blocked.delete(k);
      return 0;
    }
    return until;
  }

  /**
   * 等到某个时刻（可被 AbortSignal 打断）。
   * @returns {Promise<"timer"|"abort">}
   */
  _waitUntil(ms, signal) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const cleanup = () => {
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort);
        }
      };
      const finish = (v) => {
        if (done) return;
        done = true;
        if (timer) timer.cancel();
        cleanup();
        resolve(v);
      };
      const onAbort = () => finish("abort");
      if (signal) {
        if (signal.aborted) {
          resolve("abort");
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      timer = this._timer(ms, () => finish("timer"));
    });
  }
}

/* ========================================================================== *
 * 五、小工具与配置归一
 * ========================================================================== */

/**
 * Retry-After 的秒数（至少 1）。
 *
 * ⚠ 为什么至少 1：回 `Retry-After: 0` 等于叫客户端**立刻**重试 —— 那正是
 *    把一个已经被限流的上游再撞一次。这与 magpie 的 `errRPM.retryAfter()`
 *    一致（`max(ceil(after.Seconds()), 1)`）。
 */
function retryAfterSecOf(delayMs) {
  return Math.max(1, Math.ceil((Number(delayMs) || 0) / 1000));
}

/**
 * 归一一份配置。
 *
 * ⚠ 口径错了要当场炸（比例当个数、负数上限），理由见 intOf。
 */
function normalizeConfig(o, what) {
  const c = o || {};
  return {
    limit: intOf(c.limit, 0, `${what}.limit`),
    longestWaitMs: intOf(c.longestWaitMs, RPM_LONGEST_WAIT_MS, `${what}.longestWaitMs`),
    windowMs: intOf(c.windowMs, RPM_WINDOW_MS, `${what}.windowMs`),
    slackMs: intOf(c.slackMs, RPM_SLACK_MS, `${what}.slackMs`),
  };
}
