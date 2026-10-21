/**
 * session-store —— 会话 → 账号/密钥的**持久化亲和层**（magpie affinity 的移植）
 *
 * 移植自 yetone/magpie 的 `internal/gateway/affinity.go`（Go）。
 *
 * ## 这个模块解决什么
 *
 * 供应商的 prompt cache 是**按账号/密钥**存的：同一个会话的上下文，只有发回给
 * **同一个号**，才能以「读缓存」的价钱算；换号就得整段重算（贵好几倍）。
 * 所以「一个会话粘在回答过它的那个号上」不是优化，是省钱的前提。
 *
 * magpie 的判据比「谁回答过」细一层（这一层是本模块存在的主要理由）：
 *
 *   - **缓存值不值得留**（`cacheWorth` / `cacheCold` / `cacheHour`）：
 *     上一轮读+写缓存不到 1024 token 的，会话不值得留在原处（留着也只是
 *     浪费一个号的位置）；缓存已经冷掉（5 分钟没读）也一样——供应商那边
 *     已经把它扔了，下一轮过去还是重算，不如换个号重新建缓存。
 *     供应商声明「这个缓存我留 1 小时」（Anthropic 的 `cache_control.ttl=1h`）
 *     时可以突破 5 分钟的限制。
 *   - **模式**：`auto / session / turn / off / strict`，见下面的 MODES。
 *   - **目标死了要解绑**：那个号的凭据失效 / 额度用尽之后，粘在它上面的会话
 *     不能再往那儿发——那是把请求送进一个注定失败的号。
 *
 * ## 与既有代码的关系
 *
 * `src/server/session-id.mjs` 负责**认出这是哪个会话**（`sessionKey(agent, id)`、
 * `conversationIdOf(messages)`）；本模块负责**记住这个会话归谁**。
 * 两者不重叠，也没有依赖关系：调用方把 session-id 给的 key 递进来即可。
 *
 * `src/server/wb-pool.mjs` 里有一份**内存版**的粘性（`stickyBind`/`stickyLookup`，
 * 200 条 LRU）——只在 WorkBuddy 一个供应商里、只在进程活着的时候。
 * 本模块是它的泛化版：跨供应商、跨进程重启、而且判据是 magpie 的那套。
 * （本模块**不**改动 wb-pool.mjs，两者可以并存。）
 *
 * ## ★ 纪律
 *
 *   ① **时间一律由 `now` 注入**，本模块内部绝不自己读墙上的钟。
 *      时间源不是「方便」而是**可测**：粘性的一切判据（缓存冷不冷、闲置多久、
 *      淘汰谁）都是时间的函数，注入时间才能把这些判据写成断言。
 *   ② **写失败不抛，读失败当空**。这是 magpie 那条「accounting must never break
 *      a call」的同一条纪律：这里的失败只是**丢亲和**，不是丢功能——粘性没了，
 *      请求照样发，只是这一轮没命中缓存、多花一点钱。反过来，用户配置读失败
 *      当空是**灾难**（会抹掉用户的配置），那种地方必须「读失败 = 未知，不是空」。
 *      本模块是**缓存**，不是用户配置，所以这里读失败当空是对的。
 *   ③ **零第三方依赖**（只用 node:fs / node:path 这类内置模块）。
 *
 * ## 判据的顺序（照抄 magpie，别调换）
 *
 * magpie 的 `affine()` 是一个 switch，**顺序即语义**：
 *
 *     off → first → gone → strict → resting → spent → session → turn → new-turn
 *         → no-cache → cold → cache
 *
 * 其中与本模块直接相关的是最后三段：
 *
 *     st.cacheRead + st.cacheWrite < cacheWorth  → "no-cache"（不留）
 *     距上次超过 cacheCold 且没有 1 小时的缓存还热着 → "cold"（不留）
 *     其余 → "cache"（留）
 *
 * 注意这两条是**并且**关系，不是「或者」：
 *
 *   - 「缓存值得留」= 读写 ≥ 1024 token；
 *   - 「缓存还热着」= 5 分钟内读过，**或者**供应商声明的 1 小时缓存还热着。
 *
 * 两条都满足才留。这与本模块顶部的说明一致：值得留但已经冷掉的，留着也只是
 * 占着那个号，等下一轮重新建缓存而已。
 *
 * 跑法：node --test scripts/session-store-test.mjs
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 亲和模式（magpie 的 `provider.Affinity*` 那一族）。
 *
 * - `auto`（默认）—— 粘着，但**那个号真用不了了**（休息中/额度用尽）就换；
 *   跨轮是否继续粘，看缓存值不值得留（magpie 的默认语义）。
 * - `session` —— 一个会话固定一个目标（缓存冷不冷都留在原处）。
 * - `turn` —— 每一轮重新选（**同一轮内**不换：agent 回传工具结果的那几轮必须
 *   走同一个号，否则这一轮的上下文就断了）。
 * - `off` —— 不粘。
 * - `strict` —— 粘住就绝不换，**哪怕那个号已经休息**（magpie #1797：
 *   严格亲和的会话宁可被那个号自己的限额挡下，也不换人）。
 */
export const MODES = Object.freeze(["auto", "session", "turn", "off", "strict"]);

/**
 * 缓存**值得留**的门槛：这次回复从供应商缓存里**读**了多少，或**写**了多少
 * （magpie 的 `cacheWorth`，affinity.go:51）。
 *
 * 为什么是 1024：低于这个量，缓存省下的钱抵不上「占着一个号的位置」的代价，
 * 而留着它并不能让下一轮真的省到钱——供应商的缓存是按前缀算的，
 * 几千 token 以下的复用收益可以忽略。
 */
export const CACHE_WORTH = 1024;

/**
 * 缓存**冷掉**的时间：供应商缓存多久没读就扔（magpie 的 `cacheCold`，
 * affinity.go:54；Anthropic 与 OpenAI 都是 5 分钟，取其中最短的）。
 */
export const CACHE_COLD_MS = 5 * 60 * 1000;

/**
 * 供应商声明「这个缓存我留一小时」时的有效期（magpie 的 `cacheHour`，
 * affinity.go:58；Anthropic 的 `cache_creation.ephemeral_1h_input_tokens`）。
 *
 * 有了它，缓存就可以突破上面那个 5 分钟的限制继续留着（magpie #2302：
 * Auto 模式在 1 小时写入后 5 分钟就把会话当「冷」挪走了）。
 */
export const CACHE_HOUR_MS = 60 * 60 * 1000;

/**
 * 一个会话的亲和最多记多久（magpie 的 `stickKeep`，affinity.go:60）。
 * 超过这个时间的记录算「闲置」，淘汰掉。
 */
export const STICK_KEEP_MS = 24 * 60 * 60 * 1000;

/** 最多记多少条会话亲和（magpie 的 `sticksKept`，affinity.go:62）。 */
export const DEFAULT_MAX = 512;

/** 取数字；不是有限数字就当 0（**不抛**：这是缓存，脏数据不该让网关崩）。 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 会话 key：非空字符串才作数（空 key 是「没有会话」，不是「会话名叫空」）。 */
function normKey(key) {
  if (typeof key !== "string") return "";
  const t = key.trim();
  return t ? t : "";
}

/** 目标（账号/密钥 id）：同上。 */
function normTarget(target) {
  if (typeof target === "string") {
    const t = target.trim();
    return t ? t : "";
  }
  if (target == null) return "";
  if (typeof target === "number" && Number.isFinite(target)) return String(target);
  return "";
}

/**
 * 1 小时缓存还热着吗（magpie 的 `hourCache.warm`，affinity.go:123）。
 *
 * 两条都要：token 数量得够（低于 `cacheWorth` 不值当），且时间没超。
 */
function hourWarm(hour, now) {
  if (!hour || typeof hour !== "object") return false;
  return num(hour.tokens) >= CACHE_WORTH && now - num(hour.at) <= CACHE_HOUR_MS;
}

/**
 * 这次回复之后，1 小时缓存还剩什么（magpie 的 `hourCache.after`，
 * affinity.go:112）。
 *
 * 三种情况：
 *   - 这次**写**了 1 小时的缓存 → 新的 1 小时缓存从这里开始计时，
 *     里面装的是「读到的 + 这次写的」。
 *   - 这次**读**回来的不少于上次留下的 → 旧缓存还在，顺手续期。
 *   - 其它（读得比留下的少：会话被压缩过、迁移过） → 旧的没了，就没了。
 */
function hourAfter(prev, meta, now) {
  const write1h = num(meta.cacheWrite1h);
  const read = num(meta.cacheRead);
  if (write1h > 0) return { tokens: read + write1h, at: now };
  const tokens = prev ? num(prev.tokens) : 0;
  const at = prev ? num(prev.at) : 0;
  if (tokens > 0 && now - at <= CACHE_HOUR_MS && read >= tokens) return { tokens, at: now };
  return { tokens: 0, at: 0 };
}

/**
 * 归一化模式。认不出来的模式**当场炸**，不当成 auto 悄悄跑。
 *
 * 为什么不容错：模式写错会静默改变「粘不粘、粘多久」，而这个后果是**账单**上的
 * （换号 = 缓存作废 = 重算）。宁可启动时炸掉，也不要悄悄按另一个模式跑。
 * 空串（magpie 那边模式可能是 ""）当成 auto。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeMode(raw) {
  const m = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (m === "") return "auto";
  if (!MODES.includes(m)) {
    throw new TypeError(
      `SessionStore.mode 期望 ${MODES.join(" / ")} 之一（空串当 auto），收到 ${JSON.stringify(raw)} —— 写错了就当场炸，别悄悄按别的模式跑`
    );
  }
  return m;
}

/**
 * 会话亲和表：会话 key → 那个回答过它的账号/密钥。
 *
 * 一条记录长这样：
 *
 *     { target: "acct-1", at: 1700000000000, used: 1700000000000, meta: {…} }
 *
 *   - `target` —— 它归谁（账号 id / 密钥 id）。
 *   - `at` —— **上次回答**的时刻（magpie 的 `stick.at`）。缓存冷不冷看它。
 *   - `used` —— 上次**被用到**的时刻。闲置淘汰看它（跟 `at` 分开是为了：
 *     「读了一下」不该把一个已经冷掉的缓存重新焐热）。
 *   - `meta` —— 这次回答的账：缓存读/写、1 小时缓存、轮次等（magpie 的
 *     `stick.cacheRead/cacheWrite/hour/turn`）。
 */
export class SessionStore {
  /** @type {Map<string, {target: string, at: number, used: number, meta: object}>} */
  #map = new Map();

  /** @type {(() => number)} */
  #now;

  /** @type {string} */
  #mode;

  /** 持久化文件路径；null = 只在内存里（测试/临时用）。 */
  file;

  /** 最多留多少条。 */
  max;

  /**
   * @param {object} opts
   * @param {string|null} [opts.file] 持久化路径（JSON 文件）。
   * @param {() => number|number} opts.now **必填**的时间源：函数，或一个固定的
   *        毫秒数。不给就炸——本模块不许自己读墙上的钟（理由见文件头纪律①）。
   * @param {number} [opts.max] 最多留多少条会话亲和（默认 512，magpie 同值）。
   * @param {string} [opts.mode] 亲和模式（默认 "auto"）。
   */
  constructor({ file = null, now, max = DEFAULT_MAX, mode = "auto" } = {}) {
    if (typeof now === "function") {
      this.#now = now;
    } else if (typeof now === "number" && Number.isFinite(now)) {
      // 给一个固定时刻也认：测试里「时间不动」是最常见的一种情形。
      this.#now = () => now;
    } else {
      throw new TypeError(
        "SessionStore 必须注入时间源 now（函数或一个毫秒数）—— 本模块不自己读墙上的钟，粘性的一切判据都是时间的函数"
      );
    }
    if (typeof max !== "number" || !Number.isFinite(max) || max < 1) {
      throw new TypeError(`SessionStore.max 期望至少 1 条，收到 ${JSON.stringify(max)}`);
    }
    this.file = typeof file === "string" && file.trim() ? file : null;
    this.max = Math.floor(max);
    this.#mode = normalizeMode(mode);
  }

  /** 当前亲和模式。 */
  get mode() {
    return this.#mode;
  }

  /** 改模式也要过一遍校验（写错当场炸）。 */
  set mode(v) {
    this.#mode = normalizeMode(v);
  }

  /** 现在表里有几条。 */
  get size() {
    return this.#map.size;
  }

  /**
   * 记住「这个会话归这个账号/密钥」。
   *
   * 对应 magpie 的 `answered()`（affinity.go:647）：**谁回答了这一轮**，
   * 以及这一轮从供应商缓存里读了多少、写了多少——后面「值不值得留着」的
   * 判据全靠这几个数。
   *
   * meta 里认这几个字段（其余原样留着，面板要显示）：
   *   - `cacheRead`  —— 从供应商缓存里**读**回来的 token 数
   *   - `cacheWrite` —— 这次**写**进供应商缓存的 token 数
   *   - `cacheWrite1h` —— 其中声明「留一小时」的那部分（Anthropic 的
   *                     `ephemeral_1h_input_tokens`）
   *   - `input`      —— 这次发出去的输入 token 数。**只在供应商既不报读也不报写
   *                     时**顶替缓存写入（magpie `answered()` 里那句
   *                     `if cacheRead == 0 && cacheWrite == 0 { cacheWrite = u.Input }`）：
   *                     OpenAI 的自动前缀缓存、Gemini 不报缓存读写，但它们**确实**
   *                     存了，发出去的那段就是下一轮要读的，不顶替的话下一轮会被
   *                     当成「没缓存」挪走，白白重建一次缓存。
   *   - `turn` / `within` / `model` / `effort` —— 轮次、是否同一轮内、模型等。
   *
   * @param {string} key 会话 key（`sessionKey(agent, id)` 或 `conversationIdOf(messages)`）
   * @param {string} target 账号/密钥 id
   * @param {object} [meta] 这一轮的账
   * @returns {{target: string, meta: object, at: number}|null}
   */
  bind(key, target, meta = {}) {
    // off 模式一律不粘：连记录都不留（magpie 的 `case mode == AffinityOff`）。
    if (this.#mode === "off") return null;
    const k = normKey(key);
    if (!k) return null;
    const t = normTarget(target);
    if (!t) {
      // 没目标 = 解绑（照 wb-pool 的 `stickyBind`：accountId 为空就是「松开」）。
      this.forget(k);
      return null;
    }
    const now = this.#now();
    const prev = this.#map.get(k);
    const m = meta && typeof meta === "object" ? { ...meta } : {};

    let cacheRead = num(m.cacheRead);
    let cacheWrite = num(m.cacheWrite);
    if (cacheRead === 0 && cacheWrite === 0) {
      // 供应商不报缓存：发出去的就算写进去（理由见上面 meta 的说明）。
      cacheWrite = num(m.input);
    }
    m.cacheRead = cacheRead;
    m.cacheWrite = cacheWrite;

    // 1 小时缓存是**那个号、那个模型**的那一份：换了号就不能继承
    // （magpie：`st.who == c.who && st.model == c.model` 才继承）。
    let prevHour = null;
    if (prev && prev.target === t) {
      const pm = prev.meta || {};
      const sameModel = m.model == null || pm.model == null || m.model === pm.model;
      if (sameModel) prevHour = pm.hour || null;
    }
    m.hour = hourAfter(prevHour, m, now);

    const rec = { target: t, at: now, used: now, meta: m };
    this.#map.set(k, rec);
    return { target: rec.target, meta: { ...rec.meta }, at: rec.at };
  }

  /**
   * 查这个会话现在归谁；不该粘的时候返回 `null`（调用方据此**换目标**）。
   *
   * 对应 magpie 的 `affine()`（affinity.go:457）里「该不该留」的那一段判定，
   * 模式语义照抄（见文件头与 `MODES`）。
   *
   * opts（都可省）：
   *   - `within` —— 当前这一轮**还没结束**（agent 在回传工具结果）。同一轮内
   *     不许换号：换号了这一轮的上下文就断了（magpie 的 `a.Within`）。
   *   - `usable` —— 粘住的那个目标**现在还能不能用**（false = 休息中 / 额度用尽 /
   *     凭据失效）。auto/session/turn 在这种时候这一轮不粘（换目标），
   *     但**绑定仍然留着**，等它缓过来还能接回去；`strict` 照样粘
   *     （magpie #1797：严格亲和的会话宁可被那个号挡下也不换人）。
   *
   * @param {string} key
   * @param {{within?: boolean, usable?: boolean}} [opts]
   * @returns {{target: string, meta: object, at: number}|null}
   */
  lookup(key, opts = {}) {
    const k = normKey(key);
    if (!k) return null;
    if (this.#mode === "off") return null;
    const rec = this.#map.get(k);
    if (!rec) return null;

    const within = !!(opts && opts.within);
    const usable = !(opts && opts.usable === false);
    const now = this.#now();

    let keep;
    if (this.#mode === "strict") {
      keep = true; // 绝不换，哪怕那个号已经休息
    } else if (!usable) {
      keep = false; // 目标真用不了了 → 这一轮换目标（绑定留着）
    } else if (this.#mode === "session") {
      keep = true; // 一个会话固定一个目标
    } else if (this.#mode === "turn") {
      keep = within; // 同一轮内不换；换一轮就重新选
    } else {
      // auto：同一轮内总是粘；跨轮看缓存值不值得留。
      keep = within || this.#worth(rec, now);
    }
    if (!keep) return null;
    return { target: rec.target, meta: { ...rec.meta }, at: rec.at };
  }

  /**
   * 续期：这次又用上了它。
   *
   * 只刷新「闲置时间」（`used`），**不动** `at`（上次回答的时刻）。
   * 为什么不动 `at`：`at` 是缓存冷不冷的基准，一 `touch` 就焐热一个已经冷掉的
   * 缓存，等于凭空造出一份并不存在的缓存（下一轮照样重算，钱白花）。
   *
   * @param {string} key
   * @returns {{target: string, meta: object, at: number}|null}
   */
  touch(key) {
    const k = normKey(key);
    if (!k) return null;
    const rec = this.#map.get(k);
    if (!rec) return null;
    rec.used = this.#now();
    return { target: rec.target, meta: { ...rec.meta }, at: rec.at };
  }

  /**
   * 忘掉一个会话的绑定。
   *
   * @param {string} key
   * @returns {boolean} 确实删掉了就是 true
   */
  forget(key) {
    const k = normKey(key);
    if (!k) return false;
    return this.#map.delete(k);
  }

  /**
   * **那个号死了 → 把它名下所有会话解绑。**
   *
   * 什么时候必须调：凭据失效 / 额度用尽 / 账号被移除。粘在一个用不了的号上的
   * 会话，继续往那儿发就是把请求送进一个注定失败的号（还会白等它的超时）。
   *
   * 注意这跟「目标暂时休息」不同：休息只是这一轮换个号（用 `lookup` 的
   * `usable:false`），**绑定要留着**；死了是**永久**的，绑定必须删——
   * 否则会话会在那个死号和别的号之间反复横跳。
   *
   * @param {string} target 账号/密钥 id
   * @returns {number} 解绑了几条
   */
  forgetTarget(target) {
    const t = normTarget(target);
    if (!t) return 0;
    let n = 0;
    for (const [k, rec] of this.#map) {
      if (rec.target !== t) continue;
      this.#map.delete(k);
      n++;
    }
    return n;
  }

  /**
   * 全部绑定（面板要显示「哪个会话粘在哪个号上」）。
   *
   * 按「最近用过的」排在前面（面板第一眼要看的就是刚发生的那几条）。
   *
   * @returns {Array<{key: string, target: string, at: number, used: number, meta: object}>}
   */
  entries() {
    const out = [];
    for (const [key, rec] of this.#map) {
      out.push({ key, target: rec.target, at: rec.at, used: rec.used, meta: { ...rec.meta } });
    }
    out.sort((a, b) => (b.used - a.used) || (b.at - a.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }

  /**
   * 淘汰：按闲置时间和条数上限。
   *
   *   - 闲置超过 `STICK_KEEP_MS`（24 小时）的删掉（magpie 的 `stickKeep`）。
   *   - 超过 `max` 条时，**按闲置时间从旧到新**删（magpie 落盘时是按 `At` 倒序
   *     取前 `sticksKept` 条，留最新的；这里同口径）。
   *
   * @returns {number} 淘汰后剩几条
   */
  prune() {
    const now = this.#now();
    for (const [k, rec] of this.#map) {
      if (now - rec.used > STICK_KEEP_MS) this.#map.delete(k);
    }
    if (this.#map.size > this.max) {
      const sorted = [...this.#map.entries()].sort((a, b) => a[1].used - b[1].used);
      for (const [k] of sorted) {
        if (this.#map.size <= this.max) break;
        this.#map.delete(k);
      }
    }
    return this.#map.size;
  }

  /**
   * 落盘（原子写）。
   *
   * 原子写 = 先写同目录的临时文件，再 rename 覆盖（同一文件系统上 rename 是原子的）：
   * 崩在半路不会留下半个文件——半个 JSON 读回来是废的，那等于把**全部**亲和
   * 一次丢掉（magpie 那边也是 tmp + rename，affinity.go:304）。
   *
   * **写失败不抛**：这一层只是缓存，写不进去的最坏后果是「下一轮没命中缓存，
   * 多花一点钱」，不该把一次正常的请求变成 500（纪律②）。
   *
   * @returns {{ok: boolean, count?: number, reason?: string}}
   */
  save() {
    const file = this.file;
    if (!file) {
      return { ok: false, reason: "没有配置持久化路径（file 为空），这一层只在内存里" };
    }
    let tmp = null;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      tmp = file + ".tmp";
      const payload = { version: 1, savedAt: this.#now(), entries: this.#snapshot() };
      writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      renameSync(tmp, file);
      tmp = null;
      return { ok: true, count: this.#map.size };
    } catch (e) {
      // 写失败：把临时文件清掉（别留垃圾在磁盘上），原文件一个字节都没动。
      if (tmp) {
        try { unlinkSync(tmp); } catch { /* 删不掉就算了，不是错误 */ }
      }
      return { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
    }
  }

  /**
   * 读回磁盘上的亲和表。
   *
   * **读失败当空**（纪律②）：这是缓存不是用户配置。文件坏了 / 没了 / 是垃圾，
   * 就当没有，重新粘一次而已；反过来，用户配置读失败当成空对象再写回去，
   * 会把用户的其它配置一起抹掉——那是 magpie 反复警告的那类事故。
   *
   * @returns {{ok: boolean, count: number, missing?: boolean, reason?: string}}
   */
  load() {
    const file = this.file;
    if (!file) {
      return { ok: false, count: 0, reason: "没有配置持久化路径（file 为空），这一层只在内存里" };
    }
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      this.#map = new Map();
      const missing = !!(e && e.code === "ENOENT");
      return {
        ok: false,
        count: 0,
        missing,
        reason: String((e && e.message) || e).slice(0, 200),
      };
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      this.#map = new Map();
      return { ok: false, count: 0, reason: "文件不是合法 JSON，当空表处理" };
    }
    const src = data && typeof data === "object" && data.entries && typeof data.entries === "object"
      ? data.entries
      : (data && typeof data === "object" ? data : {});
    const next = new Map();
    for (const [k, v] of Object.entries(src)) {
      if (!v || typeof v !== "object") continue;
      const target = normTarget(v.target);
      if (!target) continue; // 没有目标的记录是废的，跳过
      const at = num(v.at);
      const used = Number.isFinite(v.used) ? Number(v.used) : at;
      const meta = v.meta && typeof v.meta === "object" ? { ...v.meta } : {};
      if (meta.hour && typeof meta.hour === "object") {
        meta.hour = { tokens: num(meta.hour.tokens), at: num(meta.hour.at) };
      }
      next.set(k, { target, at, used, meta });
    }
    this.#map = next;
    // 读回来的也要过一遍淘汰：文件里可能有几个月前的陈货，也有超过上限的。
    this.prune();
    return { ok: true, count: this.#map.size };
  }

  /**
   * 缓存值不值得留（magpie 的 `no-cache` / `cold` 两条判据）。
   *
   * **两条是「并且」**：读写量够（≥1024）**且**缓存还热着（5 分钟内读过，
   * 或供应商声明的 1 小时缓存还热着）。见文件头「判据的顺序」。
   */
  #worth(rec, now) {
    const meta = rec.meta || {};
    const read = num(meta.cacheRead);
    const write = num(meta.cacheWrite);
    if (read + write < CACHE_WORTH) return false; // no-cache：留不住
    if (now - rec.at <= CACHE_COLD_MS) return true; // 没冷
    return hourWarm(meta.hour, now); // 供应商声明留一小时的，还热着
  }

  /** 落盘用的快照（key 排序，保证同样的内容写出来的文件一样，便于比对）。 */
  #snapshot() {
    const out = {};
    for (const key of [...this.#map.keys()].sort()) {
      const rec = this.#map.get(key);
      out[key] = { target: rec.target, at: rec.at, used: rec.used, meta: rec.meta };
    }
    return out;
  }
}

export default SessionStore;
