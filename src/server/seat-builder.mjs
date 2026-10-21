/* ==========================================================================
 * seat-builder —— 把「额度信号」变成「路由策略能用的座位表」。
 *
 * ── 它在整条链上的位置 ───────────────────────────────────────────────────
 *
 *   上游答复 / 本地冷却
 *        │
 *        ▼
 *   allowance.mjs —— 额度模型（QuotaWindow：用了多少、什么时候续期）
 *        │
 *        ▼
 *   seat-builder.mjs（本模块）—— QuotaWindow ⇒ routes.Seat
 *        │
 *        ▼
 *   routes.mjs —— 策略（Builtin.smart 等 7 种）：只负责给顺序
 *
 * magpie 的对应物是 internal/gateway/routing.go 的 weighRouted：它把候选变成
 * routes.Seat，再交给 internal/routes 的策略排。这里照抄它的**语义**，
 * 不照抄它的代码 —— magpie 那边额度是查供应商私有接口拿到的，bai-router 这边
 * 只能从上游答复与本地冷却里凑，所以「拿不到」这件事本身成了主要矛盾。
 *
 * ── 一条硬规矩：不知道 ≠ 没有 ──────────────────────────────────────────
 *
 * magpie 的原话是 *a failed read means unknown, never empty*：读不到额度，
 * 不等于额度是零。这条规矩落到代码上是三件具体的事：
 *
 *   1. 额度未知 → used 给 **0**（不是 100）。给 100 会让未知账号被当成
 *      「几乎用尽」（SPENT_SHARE=98）而排到最后 —— 那正是「把不知道当没有」
 *      的老毛病：明明什么都不知道，却因为「装作很满」而被永远跳过。
 *   2. 额度未知 → pace 给**整周**（FRESH_PACE），不给 0。0 在策略里读作
 *      「完全不占」，方向正好反了。
 *   3. 额度未知但「什么时候能用」是知道的（本地冷却到期时刻）→ known 仍然是
 *      false，**但 soon 照样给**。那一项是真话，不该跟着「额度未知」一起被抹掉。
 *
 * ── 硬规矩 ──────────────────────────────────────────────────────────────
 *   · 零依赖（只 import 本仓的兄弟模块，不碰 npm、不碰 fs、不碰网络）。
 *   · **内部绝不调 Date.now()**：现在几点一律由 opts.now 传入。这样同一份逻辑
 *     可以被回放、被测试、被并发调用而不互相污染（与 allowance.mjs 同款规矩）。
 * ========================================================================== */

import { Seat } from "./routes.mjs";
import { isResting, restKeyOf } from "./candidates.mjs";
import {
  makeWindow,
  appliesTo,
  mergeWindows,
  paceOf,
  renewalOf,
  fromSignals,
} from "./allowance.mjs";

/* ==========================================================================
 * ① 常量
 * ========================================================================== */

/**
 * magpie 的 provider.FreshPace：额度**完全未知**的账号，按「还有整整一周」算，
 * 每小时摊掉多少。
 *
 * 为什么不是 0：pace 在策略里是「摊速」，0 读作「完全不占」—— 方向反了。
 * 为什么不是 100（每小时烧光）：那会把未知账号说成「马上就没了」，同样是编造。
 *
 * 数值上它恰好等于 allowance.paceOf(空窗口, now)：paceOf 在什么都不知道时
 * 按一整周兜底（allowance.mjs 的 weekSpan），算出来正是 100/168。
 */
export const FRESH_PACE = 100 / (7 * 24);

/* ==========================================================================
 * ② 小工具
 * ========================================================================== */

/** 只认有限数；null / undefined / NaN / Infinity 一律当作「没有」。 */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function clampPct(x) {
  return x < 0 ? 0 : x > 100 ? 100 : x;
}

/**
 * 现在几点 —— 一律由调用方给。
 *
 * 为什么不给默认值：座位表里每一项（续期时刻、摊速、还在不在冷却）都是相对
 * 「现在」算的。悄悄用 0（1970 年）当默认值，出来的排序看着有模有样，
 * 却是彻底错的 —— 这种错比抛错难查得多。所以宁可当场炸。
 */
function needNow(opts, why) {
  const now = num(opts.now);
  if (now == null) {
    throw new TypeError(`seat-builder 需要 now（epoch 毫秒）：${why}`);
  }
  return now;
}

/* ==========================================================================
 * ③ 收集额度信号
 * ========================================================================== */

/**
 * 候选上「已经建好的额度窗口」。
 *
 * ⚠ `candidate.allowance` 装的是 **QuotaWindow**（allowance.mjs 的形状），
 * 它的 `used` 是**百分数**（0..100）；不是原始信号。原始信号请放
 * `candidate.allowanceSignals`（走 fromSignals 解析）。
 *
 * 两者的区别不是抠字眼：`fromSignals({used:30, limit:50})` 里的 used 是
 * **绝对计数**（算出 60%），而 QuotaWindow 里的 used 就是 **60**（百分数）。
 * 拿错解释器，30% 与 60% 就差了一倍 —— 而这种错是静默的。
 */
function windowListOf(candidate) {
  const out = [];
  const push = (w) => {
    if (w && typeof w === "object") out.push(makeWindow(w));  // 对 QuotaWindow 幂等
  };
  const pushAll = (v) => {
    if (Array.isArray(v)) v.forEach(push);
    else push(v);
  };
  pushAll(candidate.allowance);
  pushAll(candidate.windows);
  pushAll(candidate.allowances);
  return out;
}

/**
 * 候选上「原始信号」（还没成窗口的那种）：Retry-After / X-RateLimit-Reset /
 * cooldownUntilMs / used+limit…… 交给 allowance.fromSignals 解析。
 */
function signalListOf(candidate, now) {
  const out = [];
  const raw = candidate.allowanceSignals ?? candidate.quotaSignals;
  if (!raw) return out;
  const one = (s) => {
    if (s && typeof s === "object") out.push(fromSignals({ ...s, now }));
  };
  if (Array.isArray(raw)) raw.forEach(one);
  else one(raw);
  return out;
}

/* ==========================================================================
 * ④ signalsOf —— 候选身上的额度信号，收集成一份「可判定」的账
 * ========================================================================== */

/**
 * 把一个候选身上的额度信号收拢成一份账：哪些窗口算数、额度知不知道、
 * 用了多少、什么时候续期、摊得多快。
 *
 * 与 magpie 的 weighRouted 对位：那边是 `a.For(model, now)` 给
 * (used, renews)、`a.Pace(model, now)` 给摊速、`a.Renewal(model, now)` 给
 * 「策略排的那个续期次序」。这里把这三件事合成一次收集，因为它们读的是同一批
 * 窗口，分开做只会让调用方有机会拿到互相矛盾的答案。
 *
 * @param {object} candidate candidates.mjs 的 makeCandidate 产物
 * @param {{now:number, model?:string}} opts
 *        now 必填（epoch 毫秒）；model 用来覆盖候选自己的 model（按模型分额度时用）
 * @returns {{model:string, windows:object[], applicable:object[], known:boolean,
 *            used:number, usedShare:number, soon:number[], pace:number, empty:boolean}}
 */
export function signalsOf(candidate, opts = {}) {
  const c = candidate && typeof candidate === "object" ? candidate : {};
  const now = needNow(opts, "额度信号的续期时刻与摊速都以「现在」为基准");
  const model = opts.model != null ? String(opts.model) : String(c.model || "");

  const windows = [...windowListOf(c), ...signalListOf(c, now)];

  /* 「算数」的窗口 = 管这个模型的 + 不是「用完也不让账号停」的。
   * aside 的窗口用完不该让账号停（allowance.mjs 的 aside 语义，magpie 同款），
   * 所以它既不算 used，也不进 soon。 */
  const applicable = windows.filter((w) => !w.aside && appliesTo(w, model));

  /* 额度「已知」= 有一条算数的窗口说得出**用了多少**：
   *   · limit > 0  → 供应商按绝对计数报数（WorkBuddy 那种积分），份额算得出；
   *   · used > 0   → 供应商直接报了百分数。
   * 一条窗口只说了「什么时候重置」而没说用了多少 → 那不是「额度已知」，
   * 只是「窗口已知」（soon 照样给）。 */
  const usageKnown = applicable.some((w) => w.limit > 0 || w.used > 0);
  /* 候选自带 known 时以候选为准（调用方比我们知道得清楚，比如它清楚这条窗口
   * 只是「冷却到几点」而不是额度）；否则按上面推出来的算。 */
  const known = typeof c.known === "boolean" ? c.known : usageKnown;

  /* used：0..100 的**百分数**（与 SPENT_SHARE=98、routes.Seat 同一口径）。
   *
   * 取最紧的那条窗口的已用（mergeWindows 按 used 最大选，与 magpie 的
   * `used = max(l.Used)` 同义）。没有算数的窗口 → 0，也就是「不知道」而不是
   * 「用光了」—— 见文件头第一条规矩。 */
  const merged = mergeWindows(applicable);
  const rawUsed = merged ? num(merged.used) || 0 : 0;
  /* 取整到整百分比：厂商本来就报整百分比，而 routes.Seat 的构造器**拒绝**
   * (0,1) 这一段（那是给「把比例当百分数传」的镜像脚枪留的哨兵）。
   * 0.5% 这种真值取整成 0 或 1 都无损 —— 但绝不能把 0.5 原样塞进去炸掉整条路由。 */
  const used = clampPct(Math.round(rawUsed));

  /* soon：各窗口的续期时刻，**大的窗口在前**（magpie 的排序口径：
   * 先按窗口跨度从大到小，同跨度再按续期时刻从晚到早）。
   * magpie 的原话是「the week before the five hours in it」—— 先看周额度，
   * 因为周额度先到就全扔了。
   *
   * 续期时刻取 allowance.renewalOf（它负责「重置已过就按跨度往后推」与
   * 「用完比重置早就取用完」这两件事）。取不到的时刻**不进数组**：routes.Seat
   * 只收有限数，而数组里少一个元素正好表示「这一层的续期时刻未知」
   * （routes.mjs 的 cmpSmartFine 把缺失当成 0 = 未知，已知的先上）。 */
  const soon = applicable
    .map((w) => {
      const rawSpan = num(w.span);
      return { span: rawSpan != null && rawSpan > 0 ? rawSpan : 0, at: renewalOf(w, now) };
    })
    .filter((x) => x.at != null && Number.isFinite(x.at))
    .sort((a, b) => (b.span - a.span) || (b.at - a.at))
    .map((x) => x.at);

  /* pace：每小时摊掉多少。
   *
   * 额度已知 → allowance.paceOf(最紧的那条窗口, now)：剩余百分比 ÷ 距续期的小时数。
   * 额度未知 → FRESH_PACE（整周）。magpie 的 weighRouted 也是这么分的：
   *   pace := l.pace; if !known && account { pace = provider.FreshPace }
   * ⚠ 唯一的分歧：magpie 对**没有额度信息的 API key** 留 0（l.pace 的零值），
   *   这里统一给 FRESH_PACE —— 0 会被读成「完全不占」，正是本仓要治的毛病。 */
  const pace = known && merged ? paceOf(merged, now) : FRESH_PACE;

  return {
    model,
    windows,
    applicable,
    known,
    used,
    usedShare: used / 100,
    soon,
    pace,
    empty: windows.length === 0,
  };
}

/* ==========================================================================
 * ⑤ seatOf —— 一个候选 ⇒ 一个座位
 * ========================================================================== */

/**
 * 造一个座位（routes.Seat）。
 *
 * 与 magpie weighRouted 里那行 Seat 字面量一一对应：
 *
 *   magpie                                 这里
 *   ──────────────────────────────────     ──────────────────────────────────────
 *   Key:   c.rest                          key    ← restKeyOf(candidate)
 *   Account: c.p.Account != nil             account ← !!candidate.account
 *   Known: 查得到额度窗口                   known  ← signalsOf().known
 *   Learns: 未知但会自报剩余的账号           learns  ← candidate.learns / agent=="claude"
 *   Used:   l.used（0..100 的百分数）        used   ← signalsOf().used
 *   Soon:   l.soon（大的窗口在前）           soon   ← signalsOf().soon
 *   Pace:   l.pace / FreshPace               pace   ← signalsOf().pace
 *   Weight: keyWeight(c)（至少 1）           weight ← candidate.weight（至少 1）
 *   Resting: resting(c)                    resting ← candidates.isResting
 *   Tokens: 近一小时发出去的量（已衰减）      tokens ← candidate.tokens（**不再衰减**）
 *   Free:   c.p.FreeModel(model)            free   ← candidate.free
 *
 * ⚠ **tokens 不在这里衰减**：magpie 的衰减（半小时衰期）是网关在记的，
 *   策略这一层只比大小。这里再衰减一次就衰减两次了。
 *
 * @param {object} candidate candidates.mjs 的 makeCandidate 产物
 * @param {{now:number, model?:string, restTable?:object}} opts
 *        now 必填；restTable 给了就用 candidates.isResting 判「还在不在休息」，
 *        不给就以候选自带的 resting 字段为准（两者都没有 → 不在休息）
 * @returns {Seat}
 */
export function seatOf(candidate, opts = {}) {
  const c = candidate && typeof candidate === "object" ? candidate : {};
  const now = needNow(opts, "座位表要判断冷却与续期");
  const sig = signalsOf(c, { ...opts, now });

  /* key：它是誰（账号/密钥的休息键），请求之间保持不变。 */
  const key = c.restKey != null ? String(c.restKey) : restKeyOf(c);

  /* account：它是订阅账号，不是 API key。 */
  const account = !!c.account;

  /* learns：额度未知，但它会**边答边报**剩多少（Claude Code 的 rate_limit_event）。
   * magpie 的 learns()：未知 + 是账号 + agent 是 claude。
   * 候选自带 learns 时以候选为准（调用方比我们会知道）。 */
  const learns = typeof c.learns === "boolean"
    ? c.learns
    : (!sig.known && account && String(c.agent || "").toLowerCase() === "claude");

  /* resting：现在还在休息吗？
   * 候选自带 resting 就用它；否则拿休息表问 candidates.isResting（两级休息：
   * restKey 命中 = 整号休息，restID 命中 = 只这个模型休息）。 */
  const resting = typeof c.resting === "boolean"
    ? c.resting
    : (opts.restTable ? isResting(c, opts.restTable, now) : false);

  /* weight：至少 1（routes.Seat 的契约，与 magpie 的 max(KeyWeight, 1) 同义）。 */
  const rawWeight = num(c.weight);
  const weight = rawWeight == null ? 1 : Math.max(1, Math.trunc(rawWeight));

  /* tokens：最近发给它的量（衰减由网关算好，这里只搬运）。 */
  const rawTokens = num(c.tokens);
  const tokens = rawTokens == null ? 0 : Math.max(0, rawTokens);

  return new Seat({
    key,
    account,
    known: sig.known,
    learns,
    used: sig.used,
    soon: sig.soon,
    pace: sig.pace,
    weight,
    resting,
    tokens,
    free: !!c.free,
  });
}

/* ==========================================================================
 * ⑥ buildSeats —— 一批候选 ⇒ 一批座位
 * ========================================================================== */

/**
 * 把一批候选变成一批座位（routes.Seat[]），顺序与候选一一对应。
 *
 * 「顺序一一对应」是刻意的：策略（routes.apply）按**下标**给顺序，网关再用
 * 下标取回候选。这里若偷偷重排，两边就对不上了 —— 那是 magpie weighRouted
 * 结尾那段 out = append(out, cs[i]) 做的事，**在策略之后**，不在这里。
 *
 * @param {object[]} candidates candidates.mjs 的 makeCandidate 产物
 * @param {{now:number, model?:string, restTable?:object}} opts
 * @returns {Seat[]}
 */
export function buildSeats(candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!list.length) return [];
  const now = needNow(opts, "座位表要判断冷却与续期");
  return list.map((c) => seatOf(c, { ...opts, now }));
}
