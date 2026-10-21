/**
 * usage-writer.mjs —— 用量账本的「写入侧」
 *
 * 移植自 yetone/magpie：internal/usage（Append）+ internal/gateway（账本在什么时候被写）
 *
 * ── 分工 ──────────────────────────────────────────────────────────
 *
 *   usage-ledger.mjs   账本本身：字段表、追加写一行、读回、CSV。
 *   usage-writer.mjs   本文件：把「一次调用 / 一次尝试」变成账本里的那几行。
 *
 * magpie 那边账本是在三个时机被写的（internal/gateway/gateway.go）：
 *   ① 请求在本地就被拒了（还没问过任何上游） → 记一条 rejected；
 *   ② 某次尝试失败、被转交给下一个候选      → 记一条 handed_on；
 *   ③ 请求最终有了结果                      → 记一条（这才是「这个请求」）。
 *
 * 本文件把 ②③ 收成两个入口（① 与 ③ 在账本里是同一张表，区别只在 rejected 标记，
 * 所以不另开入口，调用方 record({ rejected: true }) 即可）：
 *
 *   writer.record(event)        ③ 这个请求的结果
 *   writer.recordAttempt(event) ② 失败但已转交下一候选的那次尝试
 *   writer.snapshot()           内存里最近 N 条（面板读，不落盘）
 *
 * ── 三条 magpie 的设计，原样保住 ───────────────────────────────────
 *
 * ① **req vs served** —— agent 问的模型（req）与厂商说答的模型（served）是两件事。
 *    厂商的账单按 served 对，agent 以为自己订的是 req；合成一个字段 = 账单对不上，
 *    事后也无从查证（magpie 原话：a ledger to set beside the vendor's own bill）。
 *    → 落点：FIELD_MAP 里 req / served 是**两个独立条目**，中间没有任何推导。
 *
 * ② **tier_asked / tier_sent / tier_served 三段** —— 客户端要的档次、发出去时
 *    实际用的档次、厂商回复里说它跑的档次，是三件不同的事。
 *    ★ **tier_served 只从回复取**，绝不能从 tier_asked/tier_sent 猜：
 *    请求里要了 priority 而厂商降级跑了 default，这是要看见的事；猜出来就看不见了。
 *    （magpie internal/usage/usage.go，#1784）
 *    → 落点：FIELD_MAP 里三段各占一行；buildRecord 里刻意**不做任何回填**，
 *      账本模块（usage-ledger.mjs）也不做 —— 两处都不做，才叫「保住」。
 *
 * ③ **handed_on** —— 失败但已转交下一候选的那次 try **仍写自己的记录**
 *    （它可能已经被厂商计费了：记它计费了什么、为什么失败），
 *    但它**不是这个请求的结果**，所以**不计入失败数**
 *    （magpie: Totals.count 里 `if r.HandedOn { return }`；
 *      LostRequest() = Failed() && !HandedOn）。
 *    → 落点：recordAttempt() 强制 handed_on = true；record() 保留调用方给的值
 *      （缺省 false —— 一个请求的**结果**不该是「转交」）。
 *
 * ── 事件契约：camelCase ────────────────────────────────────────────
 *
 * 调用方填的键是 **camelCase**（cacheWrite1h、tierAsked、ttftMs …），
 * 写进账本的是 magpie 的 json tag（cache_write_1h、tier_asked、ttft_ms …），
 * 由 FIELD_MAP 改名。
 *
 * ★ 顺带**也认**账本自己的 json 名（tier_asked、cache_read、session_provider …）：
 *   调用方要是已经用了那些名字，它们本来就该原样进去。账本那边只认自己那张表，
 *   不认识的键**静默丢掉**还不报错 —— 而「用错了名字」和「这个字段本来就是空的」
 *   在账本里长得一模一样，一分不出来。所以这里兜一手：camelCase 优先，账本原名作底。
 *
 * ── 硬约束：写账本失败绝不能让一次正常的模型调用失败 ────────────────
 *
 * magpie 的原话是 "accounting must never break a call."
 * （internal/usage/usage.go 的 Append："Errors are swallowed: accounting must
 * never break a call."）
 *
 * 账本写不进去（磁盘满、目录没了、权限不对）**绝不能**让一次本来成功的模型调用
 * 跟着失败。所以本文件里：
 *   · 组装记录、推快照、写盘，**每一段各自裹 try/catch**，任何一段炸了都只是
 *     记一条日志，然后返回 { ok:false, error }；
 *   · 记日志用的 logger 自己也裹 try/catch —— 一个坏 logger 同样不许弄坏调用；
 *   · record() / recordAttempt() **永远不抛**，只返回 { ok, error?, record }。
 *
 * （appendRecord 本身也不抛，只返回 { ok:false, error } —— usage-ledger.mjs 已保证。
 *   但本文件还要再兜一层：万一将来有人换了个会抛的 append 实现，调用也不能挂。
 *   这正是 append 这个注入口存在的理由。）
 *
 * ── 注入进来的东西 ────────────────────────────────────────────────
 *
 *   dir     账本在哪个目录（<dir>/usage.jsonl）。本模块**不建目录**、
 *           不知道 ~/.config 在哪；路径由调用方给（与 usage-ledger.mjs 同一条规矩：
 *           一个本该报错的路径被悄悄建出来，「写不进去」就从失败变成「成功」）。
 *   now     取时间的函数（返回 epoch ms）。**内部绝不调 Date.now()** ——
 *           时间源必须由调用方注入，否则测试只能测到「大概现在」。
 *           不给 now 时时间由账本自己补（usage-ledger.mjs 的 makeRecord），
 *           与 magpie 的 Append（r.Time.IsZero() → Clock()）同。
 *   logger  写日志的函数，或带 .error / .warn 的对象。写失败时用它报一声。
 *
 * 另有两个可选项：
 *   append  落盘函数 append(dir, rec)，默认就是 usage-ledger.mjs 的 appendRecord。
 *           这是**测试要用的注入口**：把它换成会抛的替身，才能证明「写失败不抛」。
 *   keep    快照保留多少条，默认 200（SNAPSHOT_KEEP_DEFAULT）。
 */
import { appendRecord as ledgerAppend, makeRecord } from "./usage-ledger.mjs";

/**
 * 事件字段（调用方填的 camelCase）→ 账本里的 json 键（magpie 的 json tag）。
 *
 * ★ 这一张表是本模块**唯一**的字段知识来源，写进去的每个键都由它改名而来；
 *   账本那边（usage-ledger.mjs 的 FIELDS）只认 json 键，**多出来的键会被丢掉**——
 *   所以这里少写一个键，那个字段就会**静默消失**，还不报错。
 *   （这就是为什么 scripts/usage-writer-test.mjs 里有一张独立抄写的对照表。）
 *
 * ⚠ 注意账本的 json 名本身是**混着的**（照抄 magpie 的 Go json tag）：
 *   providerKeyId / providerKeyName / providerAccount / callerKeyId / callerKeyName
 *   是 camelCase，而 session_provider / cache_read / tier_asked / ttft_ms /
 *   handed_on 是 snake。别拿 CSV 的列名（provider_key_id 那一套）来对账——
 *   那是 csvHeader() 的第三列，不是账本里那个键。
 *
 * 顺序无关紧要（makeRecord 会按账本的字段表重排），但 req/served、三段 tier
 * 各自相邻放着，是为了看一眼就能确认它们是**各自独立的条目**。
 */
const FIELD_MAP = [
  ["provider", "provider"],
  ["providerAccount", "providerAccount"],
  ["providerKeyName", "providerKeyName"],
  ["providerKeyId", "providerKeyId"],
  ["callerKeyName", "callerKeyName"],
  ["callerKeyId", "callerKeyId"],
  ["agent", "agent"],
  ["sessionProvider", "session_provider"],
  ["sessionAccount", "session_account"],
  ["sessionOfficialLogin", "session_official_login"],
  ["model", "model"],
  ["req", "req"],           // ① agent 问的模型
  ["served", "served"],     // ① 厂商说答的模型 —— 与 req 各自独立，谁也不推谁
  ["upstream", "upstream"],
  ["host", "host"],         // 额外：账本有这一列（调用 went 去的那个 host），调用方不填就是空
  ["in", "in"],
  ["out", "out"],
  ["cacheRead", "cache_read"],
  ["cacheWrite", "cache_write"],
  ["cacheWrite1h", "cache_write_1h"],
  ["reasoning", "reasoning"],
  ["effort", "effort"],
  ["tierAsked", "tier_asked"],   // ② 三段
  ["tierSent", "tier_sent"],     // ②
  ["tierServed", "tier_served"], // ② 只从回复取
  ["status", "status"],
  ["error", "error"],
  ["tries", "tries"],
  ["ms", "ms"],
  ["ttftMs", "ttft_ms"],
  ["source", "source"],
  ["kind", "kind"],
  ["rejected", "rejected"],
  ["handedOn", "handed_on"],     // ③ 转交了下一候选
];

/** 快照默认保留多少条。面板只看最近这些，账本里的全量历史是账本那边的事。 */
export const SNAPSHOT_KEEP_DEFAULT = 200;

/* ---------- 小工具 ---------- */

/** 把一个异常变成一句话（不抛，logger 自己炸了也不能连带出事）。 */
function describe(e) {
  if (e instanceof Error) return e.message || e.name || "未知错误";
  if (typeof e === "string") return e;
  try {
    return String(e);
  } catch {
    return "未知错误";
  }
}

/**
 * 把调用方给的 logger 收成一个「报一句」的函数。
 *
 * 接受三种形状：函数、带 .error 的对象、带 .warn 的对象，都没有就用 console.warn。
 * ★ 调 logger 的那一行自己也要裹 try/catch —— 一个坏 logger 同样不许弄坏调用。
 */
function makeReporter(logger) {
  if (typeof logger === "function") {
    return (msg) => { try { logger(msg); } catch { /* 坏 logger 不许弄坏调用 */ } };
  }
  if (logger && typeof logger.error === "function") {
    return (msg) => { try { logger.error(msg); } catch { } };
  }
  if (logger && typeof logger.warn === "function") {
    return (msg) => { try { logger.warn(msg); } catch { } };
  }
  return (msg) => { try { console.warn(msg); } catch { } };
}

/** 快照保留条数：不给就给缺省；给负数/非数也回缺省（别让一个手滑的入参把快照清空）。 */
function normalizeKeep(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return SNAPSHOT_KEEP_DEFAULT;
  return Math.floor(n);
}

/* ---------- writer ---------- */

/**
 * 造一个用量账本的写入器。
 *
 * @param {object} [options]
 * @param {string} [options.dir]     账本所在目录（<dir>/usage.jsonl）。不建目录。
 * @param {() => number} [options.now] 取时间的函数（epoch ms）。不给则由账本补。
 * @param {Function|{error?:Function,warn?:Function}} [options.logger] 写失败时报一声。
 * @param {(dir: string, rec: object) => {ok: boolean, error?: string}} [options.append]
 *        落盘函数，默认 usage-ledger.mjs 的 appendRecord。**测试的注入口。**
 * @param {number} [options.keep]    快照保留条数，缺省 200。
 */
export function makeUsageWriter(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const dir = opts.dir;
  const now = typeof opts.now === "function" ? opts.now : null;
  const append = typeof opts.append === "function" ? opts.append : ledgerAppend;
  const keep = normalizeKeep(opts.keep);
  const report = makeReporter(opts.logger);

  /** 活快照：最近 keep 条。**只给面板读，不落盘。** */
  const snap = [];

  /**
   * 取「现在」的 epoch ms（可接受的还有 ISO 字符串）。
   * 取不到就返回 undefined —— 那就让账本自己补时间，跟 magpie 的 Append 一样。
   */
  function currentMs() {
    if (!now) return undefined;
    let v;
    try {
      v = now();
    } catch {
      return undefined; // 时间源自己炸了，不许连带弄坏记账
    }
    if (v instanceof Date) v = v.getTime();
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (typeof v === "string" && v !== "" && Number.isFinite(Date.parse(v))) return v;
    return undefined;
  }

  /**
   * 把调用方填的事件变成一条字段齐全的记录。
   *
   * 只做**改名**（camelCase 事件键 → magpie 的 json tag）与**补缺省值**，
   * 一处推导都没有 —— 尤其 tier_served 不从 tier_asked/tier_sent 回填。
   *
   * @param {object} event 调用方填的事件
   * @param {boolean|undefined} forcedHandedOn 强制写 handed_on；
   *        undefined = 听调用方的（record 的情形），true = 强制（recordAttempt 的情形）
   */
  function buildRecord(event, forcedHandedOn) {
    const src = event && typeof event === "object" ? event : {};
    /* 先把调用方的键**原样**带过来：调用方要是已经用了账本自己的 json 名
       （tier_asked、cache_write_1h、session_provider …），那些名字本来就该原样进去。
       不这么兜一手的话，账本那边（只认自己那张表）会**静默丢掉**这个字段还不报错——
       而「用错了名字」和「这个字段本来就是空的」在账本里长得一模一样。
       账本不认识的键它自己会丢，所以带进去不会污染记录。 */
    const fields = { ...src };
    /* 再按事件契约改名覆盖一遍：camelCase（事件契约）**优先**于账本原名。 */
    for (const [from, to] of FIELD_MAP) {
      if (src[from] !== undefined) fields[to] = src[from];
    }
    /* ★ handed_on：recordAttempt 强制 true（这个方法的意义就是「这条是转交的」）；
       record() 听调用方的，缺省 false —— 一个请求的**结果**不该是「转交」。 */
    fields.handed_on = forcedHandedOn === undefined ? src.handedOn : forcedHandedOn;
    /* 时间：调用方自己给了 t 就用它（那是「这次调用开始的时候」）；
       否则用注入的 now。now 也没有就让账本补（magpie 的 Append 同）。 */
    const t = currentMs();
    if (t !== undefined && (fields.t == null || fields.t === "" || fields.t === 0)) fields.t = t;
    /* ★ 这里刻意**不做任何回填**：tier_served 不从 tier_asked/tier_sent 猜，
       served 不从 req 猜，req 不从 model 猜。账本模块也不做，两处都不做。 */
    return makeRecord(fields);
  }

  /**
   * 写一条记录。**全程不抛**（accounting must never break a call）。
   *
   * @returns {{ok: boolean, error?: string, record: object|null}}
   */
  function write(event, forcedHandedOn) {
    let rec;
    try {
      rec = buildRecord(event, forcedHandedOn);
    } catch (e) {
      report(`用量账本：组装记录失败，本次不记（${describe(e)}）`);
      return { ok: false, error: describe(e), record: null };
    }

    /* 快照先入：面板看到的是「这一次调用确实发生过、确实花了 token」。
       就算写盘失败也不从面板里抹掉它 —— 这次调用确实发生了，抹掉等于说它没发生过。
       （账本那一侧记不进去是另一回事，那由下面 report() 报出来。）
       快照里放的是 writer **自己**的那一份；返回给调用方的是副本，
       调用方改了它也碰不到 writer 的内部状态。 */
    try {
      snap.push(rec);
      if (snap.length > keep) snap.splice(0, snap.length - keep);
    } catch (e) {
      report(`用量账本：快照更新失败（${describe(e)}）`);
    }

    /* ★ 写盘：这一段必须裹在 try/catch 里。
       appendRecord 自己不抛（只返回 { ok:false, error }），但那是被测模块的保证，
       不是本模块可以依赖的契约 —— 依赖别人的不抛，就是把「一次调用挂掉」的风险
       交给了一个将来可能改的实现。 */
    let res;
    try {
      res = append(dir, rec);
    } catch (e) {
      report(`用量账本：写盘抛异常，已吞掉（${describe(e)}）`);
      return { ok: false, error: describe(e), record: { ...rec } };
    }
    if (!res || res.ok !== true) {
      const msg = res && typeof res.error === "string" && res.error ? res.error : "未知原因";
      report(`用量账本：写盘失败（${msg}）`);
      return { ok: false, error: msg, record: { ...rec } };
    }
    return { ok: true, record: { ...rec } };
  }

  return {
    /**
     * 写「这个请求的结果」那一条。
     *
     * handed_on 听调用方的（缺省 false）：这是请求的**结果**，不是某次转交。
     */
    record(event) {
      return write(event, undefined);
    },

    /**
     * 写「失败但已转交下一候选」的那一次尝试（handed_on）。
     *
     * 这条记录**照样写**：它可能已经被厂商计费了（记它计费了什么、为什么失败），
     * 但它**不是这个请求的结果**，所以不计入失败数。
     * ★ forcedHandedOn = true 是这里写死的，调用方传什么都不改 ——
     *   否则「转交」这个语义就由调用方的入参决定了，那就没有约束力了。
     */
    recordAttempt(event) {
      return write(event, true);
    },

    /**
     * 内存里最近 N 条（面板读，**不落盘**）。
     *
     * 返回的是**副本**（每条记录也复制一份）：面板改了它，也影响不到 writer
     * 内部的状态，更影响不到已经写进账本的那一份。
     */
    snapshot() {
      return snap.map((r) => ({ ...r }));
    },

    /** 账本所在目录（诊断用）。 */
    dir,
    /** 快照保留条数（诊断用）。 */
    keep,
  };
}
