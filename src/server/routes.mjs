/**
 * routes —— 网关的「路由策略点」。
 *
 * 移植自 yetone/magpie 的 internal/routes（Go）。**语义照抄，不照抄代码**：
 * magpie 那边把「一个池子（某供应商的账号/密钥，或某路由组的成员头）按什么顺序试」
 * 抽成一个可注册的策略点，核心自带的只有 Smart，其余由插件注册。
 * 网关自己负责列池子、冷却、会话亲和与故障转移；策略只负责**给顺序**。
 *
 * 这里保持同样的分工：本模块只算顺序，不碰文件、网络与真实时钟。
 *
 * ── 量纲：与 Go 版一致，0–100 的百分数 ────────────────────
 *
 * Go 版 Seat.Used 是 0–100 的百分数（阈值 90 / 98），magpie 整个配额词汇表
 * （Allowance.For、Full(model, share, now)、SpentShareOf）也都是百分数。
 * 本移植**逐字对齐**：LOW_SHARE=90、SPENT_SHARE=98、used 取 0–100。
 * 将来这两个常量会被反复与 magpie 源码对照阅读，口径不一致就是长期的心智负担；
 * 接 magpie 的配额代码时也省掉每次换算。
 *
 * ── 为什么 Seat 构造器要硬校验（别把这段守卫删了）────────
 *
 * 口径定错有**两个镜像方向**：把百分数当比例传，或把比例当百分数传。
 * 两者都会**静默**算错：分档判据只在 90/98 两个点上有区别，传错了不一定当场
 * 看得出不对，而落到「几乎用尽」这个结论会直接改变请求该走哪个账号——
 * 错了就是「本来该走的那个账号被跳过」，用户只会看到莫名其妙的一次转移。
 *
 * 所以口径错必须**当场炸出来**，不能靠注释提醒——
 * 「注释说有守卫、代码里没有守卫」是最坏的一种：读代码的人以为安全，
 * 实际在静默地错。于是构造器对每个数值字段都做范围校验，越界直接抛错，
 * 错误消息里写明期望单位，让错口径炸在**调用方那一侧**，而不是变成一条错路由。
 * ------------------------------------------------------------------
 */

/** 额度低到这份之后，账号被留到「别的都接不了」才用（Go 版 LowShare=90）。 */
export const LOW_SHARE = 90;
/** 额度几乎用尽（Go 版 provider.SpentShare=98）。 */
export const SPENT_SHARE = 98;

const HOUR_MS = 3600 * 1000;

/**
 * 配额档位：0=还有余量，1=偏低（≥LOW_SHARE），2=几乎用尽（≥SPENT_SHARE）。
 * 与 magpie 的 tier() 一致：高档位覆盖低档位，所以先用 SPENT_SHARE 判。
 */
function tier(used) {
  if (used >= SPENT_SHARE) return 2;
  if (used >= LOW_SHARE) return 1;
  return 0;
}

/** 原序 [0,1,2,…]。策略给不出合法顺序时的兜底。 */
function identity(n) {
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  return idx;
}

/** 升序比较，浮点用显式比较而不是相减，避免 -0 与 NaN 混进排序。 */
function cmpAsc(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 降序比较。 */
function cmpDesc(a, b) {
  if (a > b) return -1;
  if (a < b) return 1;
  return 0;
}

/**
 * 截断到整点。
 *
 * 为什么截断：两条配额窗口相差几分钟，不该让它们在排序里换来换去——
 * 那样「谁先续期」这个问题每分钟都会给出不同答案，请求的落点就不稳。
 * Go 版用 time.Time.Truncate(time.Hour)，Unix 纪元正好落在整点上，
 * 所以「截到整点」等价于按 Unix 毫秒整除。
 */
function truncHour(ms) {
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/* ── 构造器的范围校验工具（理由见文件头）────────────────── */

/** 把值写进错误消息：NaN / Infinity 要能一眼看出来，而不是变成 "null" 或 "number"。 */
function fmtNum(v) {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null || v === undefined) return String(v);
  return Array.isArray(v) ? `数组(${v.length})` : typeof v;
}

/** 必须是一个有限数。 */
function needFinite(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new TypeError(`${name} 期望一个有限数，收到 ${fmtNum(v)}`);
  }
  return v;
}

/** 必须是一个非负有限数。 */
function needNonNegative(name, v) {
  needFinite(name, v);
  if (v < 0) throw new TypeError(`${name} 期望一个非负数，收到 ${fmtNum(v)}`);
  return v;
}

/**
 * Seat 是一个候选：某条路由在策略眼里的那份账。
 *
 * key —— 它是谁（账号/密钥的休息键），请求之间保持不变
 * account —— 是订阅账号，不是 API key
 * known —— 它的额度是已知的。Used/Soon/Pace 由此而来
 * learns —— 额度未知，但它会**边答边报**剩多少（Claude Code 的 rate_limit_event）
 * used —— 额度已用掉的百分数，0–100（与 Go 版同口径，见文件头）
 * soon —— 各配额窗口的续期时刻（毫秒时间戳），大的窗口在前
 * pace —— 离续期还有多少、每小时摊到多少；额度未知的账号按一整周算
 * weight —— 权重，至少 1
 * resting —— 刚失败过，正在冷却
 * tokens —— 最近发给它的量，按一小时半衰期衰减过（衰减由网关算好，策略只比大小）
 * free —— 在它那儿跑这个模型不花钱（厂商对订阅额度/积分不收费）
 */
export class Seat {
  constructor({
    key = "",
    account = false,
    known = false,
    learns = false,
    used = 0,
    soon = [],
    pace = 0,
    weight = 1,
    resting = false,
    tokens = 0,
    free = false,
  } = {}) {
    /* 范围校验（理由见文件头）：口径错了要当场炸，不能静默算错。
     * 错误消息写明期望单位，让调用方一眼看出是自己传错了口径。
     *
     * (0,1) 这一段被单独排除：0.95 在 [0,100] 里是**合法的**「已用 0.95%」，
     * 光靠区间检查抓不住「调用方把比例当百分数传」这个镜像脚枪。
     * 但真实的配额用量不会报到 0.5% 这种精度（厂商的额度本来就是整百分比或更粗），
     * 而放它过去的后果是**静默**把它当成「几乎没用」，白扔一个还满着的账号。
     * 所以这一段一律拒绝，错误消息直接点破「口径不对」。 */
    if (typeof used !== "number" || !Number.isFinite(used)
      || used < 0 || used > 100 || (used > 0 && used < 1)) {
      throw new TypeError(
        `Seat.used 期望 0–100 的百分数（90 = 用了九成），收到 ${fmtNum(used)} —— 口径不对，调用方有 bug`
      );
    }
    needNonNegative("Seat.pace", pace);
    needNonNegative("Seat.tokens", tokens);
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 1) {
      throw new TypeError(`Seat.weight 期望至少 1（Go 版 Seat.Weight 的契约），收到 ${fmtNum(weight)}`);
    }
    if (!Array.isArray(soon)) {
      throw new TypeError(`Seat.soon 期望一个时间戳数组，收到 ${fmtNum(soon)}`);
    }
    const soonList = soon.slice();
    for (let i = 0; i < soonList.length; i++) {
      needFinite(`Seat.soon[${i}]`, soonList[i]);
    }

    this.key = key;
    this.account = account;
    this.known = known;
    this.learns = learns;
    this.used = used;
    this.soon = soonList;
    this.pace = pace;
    this.weight = weight;
    this.resting = resting;
    this.tokens = tokens;
    this.free = free;
  }
}

/**
 * Strategy 给一个池子排序。
 *
 * order(pool, seats, now) —— 返回座位下标的排列
 *   pool 是池子名（供应商 id 或 "group/<id>"），给「每池一个轮次」的策略用
 *   now 是当前时刻（毫秒）。**策略自己绝不取 Date.now()**，时间一律由参数进来，
 *   这样排序是纯函数、可测、可回放
 * exact —— 它给的顺序就是最终顺序。否则在供应商的 API key 之间，
 *   更适合这次请求的那些会被提到前面，各自保持原有相对次序
 * byUse —— 它按 Tokens 计权，路由轨迹会显示出来
 * byFree —— 它按 Free 计权，于是网关需要算出「哪个座位的模型在那边不花钱」
 */
export class Strategy {
  constructor({ name = "", order, exact = false, byUse = false, byFree = false } = {}) {
    this.name = name;
    this.order = order;
    this.exact = exact;
    this.byUse = byUse;
    this.byFree = byFree;
  }
}

/* ────────────────────────── Smart ────────────────────────── */

/**
 * Smart 是默认策略。
 *
 * 核心直觉：**额度快用完的账号，其剩下的额度到点就白扔**；额度离续期还早的账号，
 * 剩下的额度能一直留着。所以「有富余的」里挑**续期最早**的那个先上。
 *
 * - 大窗口优先（看周额度，不是周里的那 5 小时）——周额度先到就全扔了
 * - 只有续期落在同一整点内才看下一个窗口（几分钟之差不该换来换去）
 * - 续期时间未知的排在已知的**后面**（已知续期时刻的先上）
 * - tier>0 的两档之间按已用比例升序：谁还没用满谁先上
 * - 同档同序的保持原序，顺带保住厂商的 prompt cache（别乱换账号）
 * - learns（额度未知但会自报）的先上——不然它永远轮不到、永远学不到额度
 */
function cmpSmartFine(a, b) {
  if (a.learns !== b.learns) return a.learns ? -1 : 1;
  const ri = a.soon;
  const rj = b.soon;
  for (let k = 0; k < ri.length || k < rj.length; k++) {
    const x = k < ri.length ? truncHour(ri[k]) : 0;
    const y = k < rj.length ? truncHour(rj[k]) : 0;
    if (x === y) continue;
    // 有一边续期时刻未知：已知的那边先上（Go 版 y.IsZero() 返回 true 表示 a 在前）
    if (x === 0 || y === 0) return y === 0 ? -1 : 1;
    return cmpAsc(x, y);
  }
  return 0;
}

export const Smart = new Strategy({
  name: "smart",
  order: (_pool, seats) => {
    const fine = [];
    const low = [];
    const spent = [];
    for (let i = 0; i < seats.length; i++) {
      switch (tier(seats[i].used)) {
        case 2: spent.push(i); break;
        case 1: low.push(i); break;
        default: fine.push(i);
      }
    }
    fine.sort((ia, ib) => cmpSmartFine(seats[ia], seats[ib]));
    const byUsed = (ia, ib) => cmpAsc(seats[ia].used, seats[ib].used);
    low.sort(byUsed);
    spent.sort(byUsed);
    return [...fine, ...low, ...spent];
  },
});

/* ────────────────────────── Ordered ────────────────────────── */

/** 原序试：第一个到它答不上来为止。 */
export const Ordered = new Strategy({
  name: "order",
  exact: true,
  order: (_pool, seats) => identity(seats.length),
});

/* ────────────────────────── Rotate ────────────────────────── */

/** 每个请求往后挪一格：轮流上。 */
const turns = new Map(); // pool → 已轮到的次数

export const Rotate = new Strategy({
  name: "rotate",
  order: (pool, seats) => {
    const n = seats.length;
    if (!n) return [];
    const c = turns.get(pool) || 0;
    const start = c % n;
    turns.set(pool, c + 1);
    const idx = identity(n);
    return [...idx.slice(start), ...idx.slice(0, start)];
  },
});

/* ───────────────────────── LeastUsed ───────────────────────── */

/**
 * 最少用优先：先按厂商报出来的已用比例升序，再按最近发给它的量升序。
 *
 * 注意「一小时半衰期」是**网关**在算 Tokens 时施加的（把一小时前的量减半），
 * 策略这一层只比大小——别在这里再衰减一次。
 */
export const LeastUsed = new Strategy({
  name: "usage",
  byUse: true,
  order: (_pool, seats) => {
    const idx = identity(seats.length);
    idx.sort((a, b) => {
      const sa = seats[a];
      const sb = seats[b];
      if (sa.used !== sb.used) return cmpAsc(sa.used, sb.used);
      return cmpAsc(sa.tokens, sb.tokens);
    });
    return idx;
  },
});

/* ────────────────────────── Pace ────────────────────────── */

/**
 * 按「每小时摊到多少」排：离续期越近、每小时摊到的越多，越先上。
 *
 * 为什么不能只看「剩余多少」：剩得多的先上也对，但一个剩 3% 且一小时后就重置的
 * 账号，和一个剩 90% 且两小时后重置的账号，损失不一样——前者到点就全扔。
 *
 * 档位沿用 Smart 的（0/1/2），其余按 pace 分档：**相差不到 10% 的算同一档**
 * （0.9 倍），同档内按最近发给它的量升序。
 *
 * 分档有个坑：若只写「两两相差不到十分之一算同档」，三个 1/12 间隔的 pace 会
 * 互相绕圈。所以这里先把按 pace 降序排好，再**自上而下逐个划档**：
 * 每档的 pace 都与该档的**最高值**相差不到 10%，一次定档，不再回看。
 */
export const Pace = new Strategy({
  name: "pace",
  byUse: true,
  order: (_pool, seats) => {
    const byPace = [];
    for (let i = 0; i < seats.length; i++) {
      if (tier(seats[i].used) === 0 && !seats[i].learns) byPace.push(i);
    }
    byPace.sort((a, b) => cmpDesc(seats[a].pace, seats[b].pace));

    const band = new Array(seats.length).fill(0);
    let top = 0;
    for (let k = 0; k < byPace.length; k++) {
      const i = byPace[k];
      const p = seats[i].pace;
      if (k === 0 || p < 0.9 * top) {
        top = p;
        if (k > 0) {
          band[i] = band[byPace[k - 1]] + 1;
          continue;
        }
      } else {
        band[i] = band[byPace[k - 1]];
      }
    }

    const idx = identity(seats.length);
    idx.sort((a, b) => {
      const sa = seats[a];
      const sb = seats[b];
      const ta = tier(sa.used);
      const tb = tier(sb.used);
      if (ta !== tb) return cmpAsc(ta, tb);
      if (ta > 0) {
        if (sa.used !== sb.used) return cmpAsc(sa.used, sb.used);
      } else if (sa.learns !== sb.learns) {
        return sa.learns ? -1 : 1;
      } else if (band[a] !== band[b]) {
        return cmpAsc(band[a], band[b]);
      }
      return cmpAsc(sa.tokens, sb.tokens);
    });
    return idx;
  },
});

/* ───────────────────────── Weighted ───────────────────────── */

/**
 * 按权重铺开（NGINX 的平滑加权轮询）：权重 3 和 1 的次序是
 * a,a,b,a,a,a,b,a…——比例在**一小段请求内**就成立，而不是只在平均上成立。
 *
 * 正在冷却的座位不参与轮次：它休息期间别人按自己的权重分它那份，
 * 它回来了再拿回自己那份。
 */
export const Weighted = new Strategy({
  name: "weight",
  order: (pool, seats) => {
    const keys = seats.map((s) => s.key);
    const weights = seats.map((s) => (s.weight > 1 ? s.weight : 1));
    const rests = seats.map((s) => s.resting);
    return first(round(pool, keys, weights, rests), seats.length);
  },
});

/**
 * best 排第一，其余按原序跟在其后。best 小于等于 0 时就是原序
 * （0 恰好是第一个，本来就等于原序；-1 是全在休息，没有 best）。
 */
export function first(best, n) {
  const idx = identity(n);
  if (best <= 0) return idx;
  return [best, ...idx.slice(0, best), ...idx.slice(best + 1)];
}

/* ───────────────────────── FreeFirst ───────────────────────── */

/**
 * 先花不花钱的：模型在厂商那边不耗订阅额度/积分的座位先上，按其列表序，
 * 其余跟在其后（也按列表序）。
 *
 * 只分一档，不像 Smart 那样因为「快用完」把免费座位压到付费座位后面——
 * 免费的那个跑干了也不花钱，没必要让位。
 * 付费座位之间保持列表序而不是 Smart 的续期加权序：这个路由本来就是为免费档设的；
 * 想让付费部分之间也聪明地花，给供应商/组自己设路由即可。
 *
 * 一个模型在哪儿都不免费的座位不算免费，它跟付费的一起——所以一个没有免费模型的
 * 池子，行为等同于「按序」。
 */
export const FreeFirst = new Strategy({
  name: "free",
  byFree: true,
  order: (_pool, seats) => {
    const free = [];
    const paid = [];
    for (let i = 0; i < seats.length; i++) {
      (seats[i].free ? free : paid).push(i);
    }
    return [...free, ...paid];
  },
});

/**
 * 内置路由表。Go 版的 Builtin 不含 smart（空串直接返回 Smart），
 * 这里把 smart 也列上，方便调用方遍历全部内置策略。
 */
export const Builtin = {
  smart: Smart,
  order: Ordered,
  rotate: Rotate,
  usage: LeastUsed,
  pace: Pace,
  weight: Weighted,
  free: FreeFirst,
};

/* ─────────────────── 策略注册表 ─────────────────── */

/**
 * routing → 已注册的策略列表，最后一个生效。
 *
 * Go 版用 map[string][]*Strategy + 指针身份删除；这里用 holder 包一层，
 * 靠 holder 的身份删除同一个注册项，语义一致（remove 可重复调用）。
 */
const registry = new Map(); // routing → holder[]

/**
 * 注册一个路由用的策略，返回注销函数。
 * 同一个 routing 可以叠着注册好几个，生效的是最后注册的那个；
 * 注销掉它之后回退到上一个（Go 版的行为）。
 */
export function register(routing, strategy) {
  const holder = { strategy };
  const list = registry.get(routing) || [];
  list.push(holder);
  registry.set(routing, list);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const l = registry.get(routing);
    if (!l) return;
    const i = l.indexOf(holder);
    if (i >= 0) l.splice(i, 1);
    if (!l.length) registry.delete(routing);
  };
}

/** 正在服务这个 routing 的策略：空串恒为 Smart，否则是最后注册的那个；没有则 undefined。 */
export function find(routing) {
  if (routing === "") return Smart;
  const l = registry.get(routing);
  if (!l || !l.length) return undefined;
  return l[l.length - 1].strategy;
}

/** 这个 routing 现在有没有策略在服务。 */
export function served(routing) {
  return find(routing) !== undefined;
}

/**
 * 策略给座位排的顺序——**带校验**。
 *
 * 策略只负责排序，所以它坏了必须**失败开放**：给出��是一个合法排列
 * （长度不对、越界、重复），或者它抛了异常，都退回原序——
 * 每条路由仍然都会被试到，绝不能因为排序出错就漏掉一条。
 */
export function apply(strategy, pool, seats, now) {
  const n = seats.length;
  if (!strategy || typeof strategy.order !== "function") return identity(n);
  let order;
  try {
    order = strategy.order(pool, seats, now);
  } catch {
    return identity(n);
  }
  if (!Array.isArray(order) || order.length !== n) return identity(n);
  const seen = new Array(n).fill(false);
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= n || seen[i]) return identity(n);
    seen[i] = true;
  }
  return order;
}

/* ─────────────────── 加权轮次 ─────────────────── */

/**
 * 每个池子一个轮次，记录各 key 的当前权重。
 * cur 是 Map（Go 版 map[string]int）——两个座位若 key 字符串相同，它们共享同一个计数器，
 * 与 Go 版一致。
 */
const rounds = new Map(); // pool → { cur: Map<string, number>, total, last }

export function round(pool, keys, weights, rests) {
  let r = rounds.get(pool);
  if (!r) {
    r = { cur: new Map(), total: 0, last: "" };
    rounds.set(pool, r);
  }
  // 已经不在池子里的 key 从轮次里摘掉
  const on = new Set(keys);
  for (const k of Array.from(r.cur.keys())) {
    if (!on.has(k)) r.cur.delete(k);
  }
  let best = -1;
  let total = 0;
  for (let i = 0; i < keys.length; i++) {
    if (rests[i]) continue;
    const w = Number.isFinite(weights[i]) ? weights[i] : 0;
    const next = (r.cur.get(keys[i]) || 0) + w;
    r.cur.set(keys[i], next);
    total += w;
    // 严格大于才换 best —— 平手时靠前的那个留下（与 Go 版一致）
    if (best < 0 || next > r.cur.get(keys[best])) best = i;
  }
  if (best < 0) return -1;
  r.cur.set(keys[best], r.cur.get(keys[best]) - total);
  r.total = total;
  r.last = keys[best];
  return best;
}

/**
 * 会话亲和把对话留给了 kept，于是这一轮算在 kept 头上：
 * 轮次统计的是各座位**实际**接了多少请求，新会话才能补回自己那份。
 */
export function moveRound(pool, picked, kept) {
  const r = rounds.get(pool);
  if (!r || r.last !== picked) return;
  if (!r.cur.has(kept)) return;
  r.cur.set(picked, r.cur.get(picked) + r.total);
  r.cur.set(kept, r.cur.get(kept) - r.total);
  r.last = kept;
}

/** 丢掉池子的轮次与轮转计数；不点名就全丢（测试用它让每个用例从头开始）。 */
export function forgetRound(...pools) {
  if (!pools.length) {
    rounds.clear();
    turns.clear();
    return;
  }
  for (const p of pools) {
    rounds.delete(p);
    turns.delete(p);
  }
}
