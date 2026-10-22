/**
 * concurrency.mjs —— 每家渠道的「同时在途」上限（并发闸门）
 *
 * ── 它补的是哪个洞 ──────────────────────────────────────────────────────
 * bai-router 现在只有「谁失败了换一家」（candidates.mjs 的两级休息 + 退避），
 * **没有一道「同时最多发几个」的闸门**。于是一条 Claude Code 长流式请求占着
 * 上游不放，用户再开第二个窗口就被上游顶回去 —— 上游是按账号/并发限的，
 * 我们这边**看不见也管不着**，表现是随机的 429 / 半路断连，而且**面板上什么都
 * 看不出来**（不是某家坏了，是这一家当下满了；面板只看得见「哪家在休息」）。
 *
 * ── magpie 对应哪个文件 ────────────────────────────────────────────────
 * yetone/magpie `internal/gateway/concurrency.go`（lanes / lane / take / grant /
 * releaser）。语义照抄三件事：
 *   ① **粒度 = 渠道的 key 或账号**（magpie 的 `candidate.who()`），不是供应商级：
 *      同一家有两个 key，就是两条独立的道，互不相欠。
 *   ② **满员时排队**（先来先服务），而且**排队不算失败** —— magpie 原话
 *      "Waiting is not failing"：排队的请求不会被当成「这家不行，要换一家」。
 *   ③ **队列有上界、等待有上界**，两个上界都能把请求**当场请走**
 *      （magpie 的 `errQueueFull` / `errQueueWait`）。
 *
 * ── 与 magpie 的口径差异（以及为什么）──────────────────────────────────
 *   · **取消**：magpie 用 Go 的 `context`（`ctx.Done()`）承担「客户端走了就别
 *     排了」（magpie 原话：A request whose agent goes away while it waits
 *     leaves the queue and is never sent）；我们在 JS 里用 `opts.signal`
 *     （AbortSignal）承担同一件事。
 *   · **默认等多久**：magpie 的 QueueWait 默认 0（无上界）。**我们不照抄那个
 *     默认值**（默认 2 分钟，见 {@link DEFAULT_WAIT_MS}）—— 桌面端把用户的
 *     请求挂在本地队列里无限等，用户看到的是「Claude Code 卡死了」：既没报错
 *     也没换一家。要「无限等」就显式写 `waitMs: 0`（magpie 的语义，一个字不差）。
 *   · **上限被撤掉时**（limit<=0）：magpie 给排队者发一个名额（`busy++`）；
 *     我们改成**直接放行、不占名额** —— 名额的语义是「上限之内」，上限没了
 *     就没有名额可占；magpie 那样会让 `Busy` 与实际上限脱节（上限 0 却有占用）。
 *   · **「快速失败」这一档是我们自己的取舍**：magpie 的「立刻请走」只发生在
 *     队列满时；我们加了 `mode:"reject"` —— **满员当场拒，不排队**。桌面端
 *     有时宁可立刻告诉用户「这家满了，换一家」，也不愿让请求在本地排一分钟
 *     才失败（排一分钟的请求，用户早就以为卡死了）。
 *   · **释放**：magpie 靠 Go 的 `defer` 保证；JS 没有 defer，所以本模块自己
 *     造了四道保险（见下）。这是本模块与 magpie **最实质**的差别。
 *
 * ── 释放必须可靠（本模块最要紧的一条）─────────────────────────────────
 * 漏一次 release = 永久占一个坑 = 这一家从此再也发不出请求，而且**面板上看
 * 不出来**（占用数只增不减，没有事件、没有日志、没有任何地方会说「少了谁」）。
 * 所以这里给四道保险：
 *   ① **try/finally 语义**：`withSlot(key, fn)` 把「拿名额 → 跑 fn → 还名额」
 *      封成一次调用，fn 抛异常也照样还。这是**首选用法**。
 *   ② **release 幂等**：`acquire()` 返回的 release 闭包调几次都只还一次
 *      （magpie 用 `sync.Once`，我们用闭包里的 `done` 标志）。这一条挡的是
 *      「还了两次」把占用数减成负数 —— 那比漏还隐蔽（负数会让上限形同虚设）。
 *   ③ **外部显式 release**：`release(key, token)` 让上层在**拿不到 acquire 的
 *      返回值**时也能还名额（流式响应被客户端掐断、上游半路断开、
 *      进程收到 SIGTERM 前的清场）。
 *   ④ **泄漏兜底（lease）**：acquire 时可以声明 `leaseMs` —— 「我保证这个请求
 *      活不过这么久」（调用方通常拿上游超时预算来填）。过了 lease 还没还的
 *      名额由 `sweep()` 收走并记成 `leaked`。
 *      ⚠ 为什么必须有 lease、而不能只看「占了多久」：一条**正常的长流式响应**
 *      占几分钟完全正常，光看年龄会把活着的请求当成泄漏杀掉。lease 是调用方
 *      的**承诺**，过了承诺还没还，那一定是漏了。
 *
 * ── 边界（刻意不做的事）────────────────────────────────────────────────
 *   · **纯逻辑**：零依赖、不碰 fs、不联网、**内部绝不调 `Date.now()`**
 *     （时刻一律由 `opts.now` 传入；等待用的计时器也由 `opts.timer` 注入，
 *     所以测试可以完全确定地推进时间）。
 *   · **不 import 本仓库任何其它模块** —— 它能单独跑测试。
 *   · **不认识「哪家」**：key 是调用方给的字符串（我们这边形如
 *     `provider@user` / `provider#key`），本模块不关心它的含义。
 *   · **不决定「换谁」**：满了之后是排队、是拒、还是换一家，是上层的事
 *     （magpie 那部分在 `laneMate`/`ready`，属于路由层，不在本模块）。
 */

/* ========================================================================== *
 * 一、常量与原因码
 *
 * ⚠ 这几个原因码与 rpm.mjs 的原因码**刻意不共用**：并发闸门的「拒」是本地
 * 决策（换一家就行），RPM 的「拒」是要回给客户端的 429 + Retry-After。
 * 混成一套，上层就会把「这家满了」当成「被限流了」，回错状态码。
 * 唯一共用的是 "aborted" —— 两边都是同一个意思：客户端自己走了。
 * ========================================================================== */

/** 同时在途几个。0 = 不限（magpie：limit<=0 不占名额）。 */
export const DEFAULT_LIMIT = 0;

/** 最多几个在排队。0 = 不限（magpie 的 QueueLimit，0 即无上界）。 */
export const DEFAULT_QUEUE_LIMIT = 0;

/**
 * 不设等待上界（magpie 的 QueueWait=0："as long as it takes"）。
 *
 * ⚠ 想要「等到天荒地老」就显式写 `waitMs: 0`；不写的话走
 *   {@link DEFAULT_WAIT_MS}。
 */
export const NO_WAIT_BOUND = 0;

/**
 * 默认排队等多久（毫秒）。
 *
 * ⚠ **这是我们自己的取舍**，magpie 的 QueueWait 默认是 0（无上界）。
 *   我们不照抄那个默认值，理由：桌面端的中继把用户的请求挂在本地队列里
 *   无限等下去，用户看到的是「Claude Code 卡死了」——既没有报错、也没有
 *   换一家；而两分钟后判超时、上层还能换一家重来，用户至少知道发生了什么。
 *   真要「无限等」，显式写 `waitMs: 0`（magpie 的语义，一个字不差）。
 */
export const DEFAULT_WAIT_MS = 120 * 1000;

/** 租约：调用方自认的最长在途时长（毫秒）。0 = 不设租约（不做泄漏兜底）。 */
export const DEFAULT_LEASE_MS = 0;

/** 当场拒绝（`mode:"reject"`）：满员即拒，不排队。 */
export const REASON_FAST_REJECT = "rejected";
/** 队列已满（magpie 的 `errQueueFull`）。 */
export const REASON_QUEUE_FULL = "queue-full";
/** 等超时（magpie 的 `errQueueWait`）。 */
export const REASON_WAIT_TIMEOUT = "wait-timeout";
/** 客户端在排队时走了（magpie 的 ctx.Done()）。 */
export const REASON_ABORTED = "aborted";

/* ========================================================================== *
 * 二、小工具
 * ========================================================================== */

/**
 * 非负整数，缺省给 dflt。
 *
 * ⚠ 为什么这里要炸：口径错了（把「每分钟 20 个」传成 0.2、传成负数）**只会静默
 * 算错** —— 限流闸门一旦上限算错，表现是「莫名其妙 429」或「闸门根本不生效」，
 * 而这两种都很难在面板上归因。所以让错口径炸在调用方那一侧。
 *
 * ⚠ 为什么**整数**也不放过：2.5 个并发 / 0.5 个每分钟都不是合法配置，
 *    而 `Math.floor` 会把它悄悄变成 2 和 0 —— 后者尤其毒（上限归零 = 闸门
 *    彻底失效，且面板上显示的是「0」而不是「配错了」）。
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

/** 时刻：函数就调用它，数字就用它；都不是就炸。 */
function toMs(v) {
  const n = typeof v === "function" ? v() : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new TypeError(`时刻必须是 epoch 毫秒（有限数字），收到 ${JSON.stringify(v)}`);
  }
  return n;
}

/**
 * 默认计时器。
 *
 * ⚠ 为什么要 `unref()`：排队等名额的计时器最长可能挂几十秒；不 unref 的话，
 * 一个已经拿到名额、请求早就发完的进程会被这个**没用的**计时器吊着不退出
 * （桌面端关窗、Node 进程收尾都会卡住）。
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

/** 一条道的全部记账。 */
function newLane() {
  return {
    limit: 0,
    /** 占住名额的在途请求：token → { since, leaseUntil }。`busy` 就是它的 size。 */
    slots: new Map(),
    /** 在途总数（含「不限额」那种没占名额的）。 */
    inflight: 0,
    /** 排队中的等待者，先来先服务。 */
    waiting: [],
    acquired: 0,
    queued: 0,
    rejected: 0,
    rejectedFast: 0,
    rejectedFull: 0,
    rejectedTimeout: 0,
    /** 排队时客户端走了（magpie 的 ctx.Done()）—— 不算「被拒」，是它自己不要了。 */
    aborted: 0,
    released: 0,
    /** 名额已经不在了（被外部提前还了，或被泄漏兜底收走了）—— 只记账，不动计数。 */
    lateRelease: 0,
    leaked: 0,
  };
}

/* ========================================================================== *
 * 三、限流闸门
 * ========================================================================== */

/**
 * 每条 key 一道的并发闸门。
 *
 * 用法（三选一，按可靠程度排）：
 *   ① `await limiter.withSlot(key, () => doRequest())`   ← 首选，try/finally 兜底
 *   ② `const s = await limiter.acquire(key); try { … } finally { s.release(); }`
 *   ③ `const s = await limiter.acquire(key); … ; limiter.release(key, s.token)`
 *      ← 上层拿不到 `s` 时（流被掐断）用这条
 */
export class ConcurrencyLimiter {
  /**
   * @param {object} [opts]
   * @param {number|function} opts.now  时刻（epoch 毫秒）或取时刻的函数。**必填**：
   *        本模块内部绝不取真实时钟 —— 掺了真实时间，限流账目就没法被测试
   *        逐字断言，回放也没法复现。
   * @param {number} [opts.limit]       默认同时在途上限（0 = 不限）。
   * @param {number} [opts.queueLimit]  默认队列上界（0 = 不限）。
   * @param {number} [opts.waitMs]      默认等待上界（毫秒，0 = 不限）。
   * @param {number} [opts.leaseMs]     默认租约（毫秒，0 = 不设）。
   * @param {"queue"|"reject"} [opts.mode] 默认排队还是当场拒。
   * @param {function} [opts.timer]     计时器：`(ms, fn) => { cancel() }`，
   *        注入它测试才能确定地推进时间。
   */
  constructor(opts = {}) {
    if (opts.now == null || (typeof opts.now !== "function" && typeof opts.now !== "number")) {
      throw new TypeError(
        "ConcurrencyLimiter：时间必须由 opts.now 传入（函数或 epoch 毫秒）。" +
        "本模块内部绝不取真实时钟 —— 否则限流账目掺了真实时间，测试没法逐字断言。",
      );
    }
    this._now = opts.now;
    this._timer = typeof opts.timer === "function" ? opts.timer : defaultTimer;
    this._defaults = normalizeConfig(opts, "ConcurrencyLimiter 选项");
    /** 每条 key 的配置覆盖。 */
    this._configs = new Map();
    /** 每条 key 的道。 */
    this._lanes = new Map();
    this._seq = 0;
  }

  /* ---------------------------------------------------------------- *
   * 配置
   * ---------------------------------------------------------------- */

  /**
   * 给某条 key 定一份配置。
   *
   * @param {string} key
   * @param {object} cfg { limit, queueLimit, waitMs, leaseMs, mode }
   */
  configure(key, cfg) {
    const k = String(key);
    const c = normalizeConfig(cfg, `key "${k}" 的配置`);
    this._configs.set(k, c);
    const lane = this._lanes.get(k);
    if (lane) {
      lane.limit = c.limit;
      /* 上限调大了 → 让排着的人先走（magpie 的 take 里也是先设 limit 再 grant）。 */
      this._grant(k, lane, this._now());
    }
    return c;
  }

  /** 某条 key 现在的配置（没单独定过就是默认的）。 */
  configOf(key) {
    return this._configs.get(String(key)) || this._defaults;
  }

  /** 某条 key 的同时在途上限。 */
  limitOf(key) {
    return this.configOf(key).limit;
  }

  /* ---------------------------------------------------------------- *
   * 占用
   * ---------------------------------------------------------------- */

  /**
   * 拿一个名额。拿到就返回 ok:true + 一个幂等的 release；拿不到（当场拒 / 队列满 /
   * 等超时）就返回 ok:false + 一个原因码。
   *
   * ⚠ 调用方**必须**在 finally 里 release —— 更好的做法是用 {@link withSlot}。
   *
   * @param {string} key
   * @param {object} [opts]
   * @param {number|function} [opts.now]      覆盖构造时的时刻。
   * @param {number} [opts.leaseMs]          本次占用的租约（毫秒）：调用方自认的
   *        最长在途时长；超时未还由 sweep() 收走。
   * @param {number} [opts.limit]            本次的上限覆盖。
   * @param {AbortSignal} [opts.signal]      客户端走人时**立刻离开队列**
   *        （magpie 的 ctx.Done()），不占队列位置，也不算「被拒」。
   * @returns {Promise<object>} { ok, key, token, slot, release, waited, reason, limit }
   */
  async acquire(key, opts = {}) {
    const k = String(key);
    const now = this._nowOf(opts);
    /* 泄漏兜底先跑：闸门不能因为上一次漏还而永远卡住。 */
    this.sweep(now, opts);

    const cfg = this.configFor(k, opts);
    const lane = this._lane(k);
    lane.limit = cfg.limit;

    /* 客户端已经走了 → 根本不用排队（magpie：ctx ended first）。 */
    const signal = opts.signal;
    if (signal && signal.aborted) {
      lane.aborted++;
      return {
        ok: false,
        key: k,
        token: null,
        slot: false,
        release: null,
        waited: 0,
        reason: REASON_ABORTED,
        limit: cfg.limit,
        queued: 0,
      };
    }

    /* 上限 0 = 不限（magpie：limit<=0 不占名额）。 */
    if (cfg.limit <= 0) {
      const token = this._nextToken();
      lane.inflight++;
      lane.acquired++;
      return {
        ok: true,
        key: k,
        token,
        slot: false,
        release: this._releaser(k, lane, token, false),
        waited: 0,
        reason: null,
        limit: 0,
      };
    }

    /* 有空位且没人排队 → 立刻拿走（magpie：`ln.busy < limit && len(ln.queue) == 0`）。 */
    if (lane.slots.size < cfg.limit && lane.waiting.length === 0) {
      return this._occupy(k, lane, cfg, now, 0);
    }

    /* 满员。快失败模式：当场拒，不排队。 */
    if (cfg.mode === "reject") {
      lane.rejected++;
      lane.rejectedFast++;
      return {
        ok: false,
        key: k,
        token: null,
        slot: false,
        release: null,
        waited: 0,
        reason: REASON_FAST_REJECT,
        limit: cfg.limit,
        queued: 0,
      };
    }

    /* 队列已满 → 当场拒（magpie 的 errQueueFull）。 */
    if (cfg.queueLimit > 0 && lane.waiting.length >= cfg.queueLimit) {
      lane.rejected++;
      lane.rejectedFull++;
      return {
        ok: false,
        key: k,
        token: null,
        slot: false,
        release: null,
        waited: 0,
        reason: REASON_QUEUE_FULL,
        limit: cfg.limit,
        queued: 0,
      };
    }

    /* 排队。 */
    const token = this._nextToken();
    const waiter = {
      token,
      key: k,
      enqueuedAt: now,
      leaseUntil: cfg.leaseMs > 0 ? now + cfg.leaseMs : 0,
      settle: null,
    };
    lane.waiting.push(waiter);
    lane.queued++;

    const outcome = await this._wait(waiter, lane, cfg, k, signal);
    if (outcome.kind === "aborted") {
      /* 客户端走了：这个请求**不算被拒**（是它自己不要了），但要从队列里摘掉。 */
      lane.aborted++;
      return {
        ok: false,
        key: k,
        token: null,
        slot: false,
        release: null,
        waited: outcome.waited,
        reason: REASON_ABORTED,
        limit: cfg.limit,
        queued: 1,
      };
    }
    if (outcome.kind !== "granted") {
      lane.rejected++;
      lane.rejectedTimeout++;
      return {
        ok: false,
        key: k,
        token: null,
        slot: false,
        release: null,
        waited: outcome.waited,
        reason: REASON_WAIT_TIMEOUT,
        limit: cfg.limit,
        queued: 1,
      };
    }

    const isSlot = outcome.slot !== false;
    return {
      ok: true,
      key: k,
      token,
      slot: isSlot,
      release: this._releaser(k, lane, token, isSlot),
      waited: outcome.waited,
      reason: null,
      limit: cfg.limit,
    };
  }

  /**
   * 还名额 —— 显式、带 token。
   *
   * 什么时候用它：`acquire()` 的返回值丢了（异常发生在拿到返回值之前、流被客户端
   * 掐断后只有 key 没有 token）。**不要**拿它去还别人的名额。
   *
   * @param {string} key
   * @param {string|number} [token] 不给就还这条道上**最老的**那一个。
   * @returns {boolean} 真的还掉了返回 true；本来就没名额（已还过 / 不存在）返回 false。
   */
  release(key, token, opts = {}) {
    const k = String(key);
    const lane = this._lanes.get(k);
    if (!lane) return false;
    let t = token;
    if (t == null) {
      const first = lane.slots.keys().next();
      if (first.done) return false;
      t = first.value;
    } else {
      t = String(t);
      if (!lane.slots.has(t)) return false;
    }
    lane.slots.delete(t);
    lane.inflight--;
    lane.released++;
    this._grant(k, lane, this._nowOf(opts));
    return true;
  }

  /**
   * 拿名额 → 跑 fn → 还名额。**首选用法**：fn 抛异常也照样还（finally）。
   *
   * ⚠ 为什么不让它抛「拿不到名额」的错：上层要区分「这一家满了」（换一家）
   *    与「请求本身有问题」（不要换），两种处理完全不同；返回 ok:false 让上层
   *    按自己的策略决定，而不是本模块替它决定。
   *
   * @returns {Promise<object>} { ok, value?, reason?, waited? }
   */
  async withSlot(key, fn, opts = {}) {
    const slot = await this.acquire(key, opts);
    if (!slot.ok) {
      return { ok: false, reason: slot.reason, waited: slot.waited, limit: slot.limit };
    }
    try {
      const value = await fn(slot);
      return { ok: true, value, waited: slot.waited, token: slot.token };
    } finally {
      /* 这一行是整个模块存在的理由：漏了就永久占一个坑。 */
      slot.release();
    }
  }

  /* ---------------------------------------------------------------- *
   * 观察
   * ---------------------------------------------------------------- */

  /**
   * 这条道现在的样子：占用 / 上限 / 排队 / 被拒各多少。
   *
   * @returns {object} { key, limit, busy, inflight, waiting, acquired, queued,
   *                    rejected, rejectedFast, rejectedFull, rejectedTimeout,
   *                    aborted, released, lateRelease, leaked, mode }
   */
  stats(key) {
    const k = String(key);
    const cfg = this.configOf(k);
    const lane = this._lanes.get(k);
    const base = {
      key: k,
      limit: cfg.limit,
      busy: 0,
      inflight: 0,
      waiting: 0,
      acquired: 0,
      queued: 0,
      rejected: 0,
      rejectedFast: 0,
      rejectedFull: 0,
      rejectedTimeout: 0,
      aborted: 0,
      released: 0,
      lateRelease: 0,
      leaked: 0,
      mode: cfg.mode,
    };
    if (!lane) return base;
    return {
      ...base,
      busy: lane.slots.size,
      inflight: lane.inflight,
      waiting: lane.waiting.length,
      acquired: lane.acquired,
      queued: lane.queued,
      rejected: lane.rejected,
      rejectedFast: lane.rejectedFast,
      rejectedFull: lane.rejectedFull,
      rejectedTimeout: lane.rejectedTimeout,
      aborted: lane.aborted,
      released: lane.released,
      lateRelease: lane.lateRelease,
      leaked: lane.leaked,
    };
  }

  /** 所有道的快照（面板要看全局时用）。 */
  snapshot() {
    const out = {};
    for (const k of this._lanes.keys()) out[k] = this.stats(k);
    return out;
  }

  /** 在途的持有者（谁占了多久、租约到什么时候）—— 排查「谁漏了」用。 */
  holders(key) {
    const lane = this._lanes.get(String(key));
    if (!lane) return [];
    return [...lane.slots.entries()].map(([token, h]) => ({
      token,
      since: h.since,
      leaseUntil: h.leaseUntil,
    }));
  }

  /**
   * 这条道现在能不能立刻发（magpie 的 `lanes.free`）。
   *
   * 路由层用它挑「还有空位的另一个 key/账号」（magpie 的 `laneMate`/`ready`）。
   */
  free(key) {
    const cfg = this.configOf(key);
    if (cfg.limit <= 0) return true;
    const lane = this._lanes.get(String(key));
    if (!lane) return true;
    return lane.slots.size < cfg.limit && lane.waiting.length === 0;
  }

  /* ---------------------------------------------------------------- *
   * 泄漏兜底
   * ---------------------------------------------------------------- */

  /**
   * 收走过了租约还没还的名额（泄漏兜底）。
   *
   * ⚠ 为什么按**租约**收、不按「占了多久」收：一条正常的长流式响应占几分钟
   *    很常见，光看年龄会把活着的请求杀掉。租约是调用方的承诺 —— 过了它
   *    还没还，那一定是漏了。
   * ⚠ 租约为 0（没声明）的一律不收：宁可不收，也不能错杀活着的请求。
   *
   * @param {number} [now] 时刻（不给就用构造时的钟）。
   * @returns {number} 收走了几个。
   */
  sweep(now, opts = {}) {
    const t = this._nowOf({ ...opts, now: now != null ? now : opts.now });
    let n = 0;
    for (const [k, lane] of [...this._lanes]) {
      for (const [token, h] of [...lane.slots]) {
        if (h.leaseUntil > 0 && t > h.leaseUntil) {
          lane.slots.delete(token);
          lane.inflight--;
          lane.leaked++;
          n++;
          this._grant(k, lane, t);
        }
      }
    }
    return n;
  }

  /** 清掉一条道的全部记账（测试与「这家被删了」的场合用）。 */
  clear(key) {
    const k = String(key);
    this._lanes.delete(k);
    this._configs.delete(k);
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  _lane(key) {
    const k = String(key);
    let lane = this._lanes.get(k);
    if (!lane) {
      lane = newLane();
      this._lanes.set(k, lane);
    }
    return lane;
  }

  _nowOf(opts) {
    const v = opts && opts.now != null ? opts.now : this._now;
    return toMs(v);
  }

  /**
   * 下一个名额的编号。
   *
   * ⚠ 为什么是**字符串**：`lane.slots` 是 Map，用的是 SameValueZero 比较 ——
   *    数字 1 和字符串 "1" 是**两个不同的键**。若这里发数字、别处发字符串，
   *    `release(key, token)` 就找不到那个名额，表现为「明明还了，占用却不降」。
   *    统一成字符串就绕开了这个坑。
   */
  _nextToken() {
    this._seq += 1;
    return String(this._seq);
  }

  /** 这一次用的配置（per-key 配置 + 单次覆盖）。 */
  configFor(key, opts) {
    const cfg = this.configOf(key);
    if (!opts || (opts.limit == null && opts.queueLimit == null && opts.waitMs == null && opts.leaseMs == null && opts.mode == null)) {
      return cfg;
    }
    return normalizeConfig(
      {
        limit: opts.limit != null ? opts.limit : cfg.limit,
        queueLimit: opts.queueLimit != null ? opts.queueLimit : cfg.queueLimit,
        waitMs: opts.waitMs != null ? opts.waitMs : cfg.waitMs,
        leaseMs: opts.leaseMs != null ? opts.leaseMs : cfg.leaseMs,
        mode: opts.mode != null ? opts.mode : cfg.mode,
      },
      `key "${key}" 的本次配置`,
    );
  }

  /** 立刻占一个名额。 */
  _occupy(key, lane, cfg, now, waited) {
    const token = this._nextToken();
    lane.slots.set(token, {
      since: now,
      leaseUntil: cfg.leaseMs > 0 ? now + cfg.leaseMs : 0,
    });
    lane.inflight++;
    lane.acquired++;
    return {
      ok: true,
      key,
      token,
      slot: true,
      release: this._releaser(key, lane, token, true),
      waited,
      reason: null,
      limit: cfg.limit,
    };
  }

  /**
   * 让排着的人走（有名额就走）。
   *
   * magpie 的 `grant()`：`for len(queue)>0 && (limit<=0 || busy<limit) { busy++; close(...) }`
   * —— 先来先服务，且**在唤醒之前就把名额记上**（否则两个等待者会同时醒、
   * 抢同一个名额）。
   */
  _grant(key, lane, now) {
    const t = now != null ? now : this._now();
    if (lane.limit <= 0) {
      /* 上限没了：排队的人直接放行，且不占名额（见头注释的口径差异）。 */
      const rest = lane.waiting.splice(0);
      for (const w of rest) {
        lane.inflight++;
        lane.acquired++;
        w.settle({ kind: "granted", waited: t - w.enqueuedAt, slot: false });
      }
      return;
    }
    while (lane.waiting.length > 0 && lane.slots.size < lane.limit) {
      const w = lane.waiting.shift();
      lane.slots.set(w.token, { since: t, leaseUntil: w.leaseUntil });
      lane.inflight++;
      lane.acquired++;
      w.settle({ kind: "granted", waited: t - w.enqueuedAt, slot: true });
    }
  }

  /**
   * 等名额（或等到超时 / 客户端走人）。
   *
   * ⚠ 超时、客户端走人、与「刚好被授予」是同一个竞态的三个方向，
   *    **每一边都要善后**：
   *    · 还在队列里 → 摘掉自己，判超时（或判走人）；
   *    · 已经被授予了（名额记上了）→ 把名额还回去并转给下一个，
   *      否则会凭空多占一个坑（比漏还难查：占用数对不上任何请求）。
   */
  _wait(waiter, lane, cfg, key, signal) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const onAbort = () => {
        if (settled) return;
        const i = lane.waiting.indexOf(waiter);
        if (i >= 0) lane.waiting.splice(i, 1);
        finish({ kind: "aborted", waited: this._now() - waiter.enqueuedAt });
      };
      const cleanup = () => {
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort);
        }
      };
      const finish = (v) => {
        if (settled) return;
        settled = true;
        if (timer) timer.cancel();
        cleanup();
        resolve(v);
      };
      waiter.settle = (v) => finish(v);
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (cfg.waitMs > 0) {
        timer = this._timer(cfg.waitMs, () => {
          if (settled) return;
          const i = lane.waiting.indexOf(waiter);
          if (i >= 0) {
            lane.waiting.splice(i, 1);
            finish({ kind: "timeout", waited: this._now() - waiter.enqueuedAt });
          } else {
            /* 已经被授予了：把名额还回去，转给下一个。 */
            lane.slots.delete(waiter.token);
            lane.inflight--;
            this._grant(key, lane, this._now());
            finish({ kind: "timeout", waited: this._now() - waiter.enqueuedAt });
          }
        });
      }
    });
  }

  /**
   * release 闭包 —— **幂等**（magpie 的 `sync.Once`）。
   *
   * ⚠ 为什么幂等是硬要求：上层常见写法是「正常路径还一次 + 出错路径又还一次」。
   *    不幂等就会把占用数减成负数 —— 负数会让上限**永远形同虚设**（`size < limit`
   *    恒真），闸门直接失效，而且占用数显示成负数才被人发现。
   */
  _releaser(key, lane, token, isSlot) {
    let done = false;
    return () => {
      if (done) return false;
      done = true;
      if (isSlot) {
        if (!lane.slots.delete(token)) {
          /* 名额已经不在了：被外部提前还过，或被泄漏兜底收走了。只记账。 */
          lane.lateRelease++;
          return false;
        }
        lane.inflight--;
        lane.released++;
        this._grant(key, lane, this._now());
        return true;
      }
      lane.inflight--;
      lane.released++;
      return true;
    };
  }
}

/* ========================================================================== *
 * 四、配置归一
 * ========================================================================== */

/**
 * 归一一份配置。
 *
 * ⚠ 口径错了要当场炸：上限传成 0.2（比例当个数）、上限传负数，这些**只会静默
 * 算错** —— 闸门要么形同虚设、要么莫名其妙拒人，而面板上归因不到「配置写错」。
 */
function normalizeConfig(o, what) {
  const c = o || {};
  const mode = c.mode == null ? "queue" : String(c.mode);
  if (mode !== "queue" && mode !== "reject") {
    throw new TypeError(`${what}：mode 只能是 "queue" 或 "reject"，收到 ${JSON.stringify(c.mode)}`);
  }
  return {
    limit: intOf(c.limit, DEFAULT_LIMIT, `${what}.limit`),
    queueLimit: intOf(c.queueLimit, DEFAULT_QUEUE_LIMIT, `${what}.queueLimit`),
    waitMs: intOf(c.waitMs, DEFAULT_WAIT_MS, `${what}.waitMs`),
    leaseMs: intOf(c.leaseMs, DEFAULT_LEASE_MS, `${what}.leaseMs`),
    mode,
  };
}
