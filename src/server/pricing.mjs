/**
 * pricing.mjs —— 价格表与费用估算
 *
 * ── 补的是哪个洞 ───────────────────────────────────────────────────────
 * 用量账本（usage-ledger.mjs 的 FIELDS）记着每次调用的 in / out /
 * cache_read / cache_write，**唯独没有价格** —— 面板上的「费用」一格至今
 * 只能写「服务端未统计」（cards/usage-ledger.js 的 s-cost 文案）。
 * 本模块补的就是这一格：按厂商单价把 token 数折成钱。
 *
 * ── magpie 的对应物 ───────────────────────────────────────────────────
 *   internal/catalog/catalog.go    Price 结构 + CostSplit（单价是「每百万 token 多少美元」）
 *   internal/usage/usage.go        Record.CostAt / Totals.add（估不出 ≠ 0，单独记 unpriced）
 *   internal/usage/ledger.go       Row.Cost + Row.Priced（一条记录一个「估得出没有」）
 *   internal/settings/settings.go  ModelPrices（用户自己写的单价，按 "<厂商>/<模型>" 索引）
 *   internal/provider/modelprefs.go SetModelPrice（同上，用户覆盖表里的）
 *   internal/catalog/catalog.go    modelsDevURL = https://models.dev/api.json（价格数据源）
 *
 * ── 价格快照日期：2026-10-22 ──────────────────────────────────────────
 * 数据抓自 models.dev 的 api.json（magpie 读的就是同一个源）。抓取那天就是
 * 快照日期，表里的数字只对这一天成立。
 * ★ **价格是漂移的**：厂商随时调价，所以表**必须**带日期，面板要能显示
 *   「单价表是 2026-10-22 的快照」。一张没有日期的表，用户无从判断它还准不准。
 *
 * ── 哪些估得出、哪些估不出 ───────────────────────────────────────────
 * 估得出（表里有条目）：
 *   · sn/*   商汤 SenseNova（token.sensenova.cn）—— 平台免费领用，五款全是 0
 *   · zen/*  OpenCode Zen —— space-bunny-free，0
 *   · mm/*   MiniMax 国内站 —— MiniMax-M3.1-Flash（有实价，但**缓存写单价查不到**）
 *   · or/*   OpenRouter —— 十五款免费模型是 0；ling-3.1-flash 有实价
 * 估不出（表里没有 ⇒ 面板显示「—」，**绝不拿别家的价顶替**）：
 *   · bai/*        B.AI 转发站 —— 公开渠道查不到它的转售价（models.dev 也没有这一家）
 *   · qd/*         Qoder —— 按积分倍率（price_factor）算，不是按 token
 *   · wb/*, wbai/* WorkBuddy —— 同样按积分倍率算
 *   · sn/deepseek-flash、or/apodex/apodex-1.1-mini:free —— 源里就没这一条
 *   · 以及**任何不在表里的模型** —— 用户可以用 overrides 自己写单价
 *
 * ── 与 magpie 有意不同的点（及原因）──────────────────────────────────
 * ① **按「厂商 + 真实模型名」索引，不按档位**：本仓的档位（claude-opus-5 …）
 *    与厂商无关，各家把档位映射到自己的模型名（config.defaults.json 的
 *    cfg[厂商].mapping）。厂商账单按真实模型名走；按档位索引会串味 ——
 *    同是 claude-opus-5，sn 是 glm-5.2、wb 是 hy3，价格差着几个量级。
 * ② **「源里没列的通道」是 null（不知道），不是 0**：magpie 的 Price 结构里
 *    0 即「没给」，CostSplit 直接乘 0 —— 缓存费被当成免费。本仓改成 null：
 *    一条真用了未知通道的记录 ⇒ 这个模型估不出 ⇒ 面板显示「—」。
 *    原因：少算的缓存费**也是一个错数字**，而用户会拿这个数字对账。
 * ③ **没有「长上下文阶梯价」**：magpie 有 Price.Tiers（prompt 超过某个长度整单换价）。
 *    本仓的表是「每百万 token 四个数」的扁平结构，装不下阶梯；估的时候按基准价算，
 *    阶梯带来的偏差在长上下文场景会偏小，但方向是**偏少**，不是偏多。
 * ④ **不做「同价模型推导」**：magpie 有 SamePriceIn（同一个模型在别家卖，
 *    就按那家的价算）。本仓刻意不做 —— 那正是「拿别家的价冒充」的那条路。
 * ⑤ **估不出时 total 是 null，不是「已知部分之和」**：面板要能显示「—」，
 *    而不是显示一个少了零头的数字（一个偏少的总价比没有总价更坏）。
 * ⑥ **一条记录零 token 就跳过**（不算钱也不算「估不出」）：magpie 判的是
 *    in+out==0，缓存有量而输入输出为零的记录它会整条不算。这里按四个通道
 *    全零才算跳过 —— 缓存读的量本身是要钱的。
 *
 * ── 硬规矩 ────────────────────────────────────────────────────────────
 *   · **纯逻辑**：零 IO、零依赖，**不 import 仓库里任何其它模块**。
 *   · **内部绝不调 Date.now()**：现在几点一律由 opts.now 传入。
 *   · **远端表拉失败就用旧的**：本模块不联网。远端表由调用方拉来后经
 *     opts.table 传进来；**传不进来就继续用内置表** —— 费用绝不因为
 *     拉不到而清空（清空 = 面板上的费用一夜之间变成 0，用户以为没花钱）。
 *   · **未知就是未知**：返回 null / 列进 unknownModels，绝不用 0、
 *     绝不用「同类模型大概这个价」顶替。
 *
 * ── 用户覆盖单价的形状（接线层从配置里读，传进 opts.overrides）────────
 *   {
 *     "bai/claude-opus-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
 *     "bai/*":             { input: 1, output: 2 }        // 这一家所有还没被精确覆盖的模型
 *   }
 *   字段名也认 models.dev 的写法（cache_read / cache_write）；只写一部分时，
 *   没写的字段沿用表里的值 —— 用户改的是「这个模型的输出价」，不是把整条表抹掉。
 */

/* ══════════════════════════════════════════════════════════════════════
 * ① 常量
 * ══════════════════════════════════════════════════════════════════════ */

/** 这张表的快照日期。改表 = 改数据 = 改这个日期。 */
const PRICED_AT = "2026-10-22";

/** 币种。面板上的「$」由它决定；换币种是换一张表的事，不是换算法的事。 */
const CURRENCY = "USD";

/** 表里数字的单位。写死是刻意的：单位一旦含糊，1.4 是「每千 token」还是
 *  「每百万 token」就没人说得清了，而这种错会差 1000 倍。 */
const UNIT = "per-1M-tokens";

/** 单位换算：表里是「每 100 万 token 多少美元」，账本里是「多少个 token」。 */
const TOKENS_PER_UNIT = 1_000_000;

/** 快照超过多少天算「陈旧」。陈旧**不影响估价**（宁可给个带日期的旧数，
 *  也不要给个没有的数），只是让面板能提一句「这张表多久没更新了」。 */
const STALE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 本仓渠道 → models.dev 的 provider id。
 *
 * 存在的意义是「表要能被更新而不改代码」：远端拉回 models.dev 的 api.json，
 * 传进 tableFromModelsDev()，就得到一张同格式的新表 —— 换价不用改代码。
 * bai / qd / wb / wbai **不在这里**：models.dev 没有这几家（Qoder 与
 * WorkBuddy 按积分算，压根不是按 token），列进来只会让人以为查得到。
 */
export const MODELS_DEV_CHANNELS = {
  sn: "sensenova",
  zen: "opencode",
  mm: "minimax-cn",
  or: "openrouter",
};

/* ══════════════════════════════════════════════════════════════════════
 * ② 内置价格表（快照 2026-10-22 · models.dev api.json）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 表本身。键是「厂商/真实模型名」，值是四个通道的单价（美元 / 百万 token）。
 *
 * ★ null = **源里没列这一项**（不知道）；0 = **源里明说是 0**（免费）。
 *   这两件事长得几乎一样，混起来就是「把猜的东西当成实测的东西」。
 *
 * ★ 输入输出都是 0 的条目，缓存两通道也写 0：源里没列，但一款输入输出都
 *   白给的模型不可能另收缓存写的钱 —— 这个推断只在**这一处数据**里做一次，
 *   运行时不做（运行时只认表里写好的数）。
 */
const ENTRIES = {
  /* ── 商汤 SenseNova（token.sensenova.cn）────────────────────────────
     models.dev 的 sensenova 一栏把这几款列为 0：平台免费领用，**是真的 0**，
     不是「查不到」。 */
  "sn/deepseek-v4-flash": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "sn/deepseek-v4.1-flash": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "sn/glm-5.2": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "sn/kimi-k3": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "sn/sensenova-6.8-flash-lite": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },

  /* ── OpenCode Zen（opencode.ai/zen）─────────────────────────────────
     只上了 space-bunny-free 一款，源里明说是 0。 */
  "zen/space-bunny-free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },

  /* ── MiniMax 国内站（agent.minimax.cn）──────────────────────────────
     ★ cacheWrite 是 null：源里只列了输入/输出/缓存读，**缓存写单价查不到**。
       真用到缓存写的记录会因此被列进 unknownModels —— 这是如实，
       比按 0 算出一个偏少的总价强。 */
  "mm/MiniMax-M3.1-Flash": { input: 0.1494, output: 0.5976, cacheRead: 0.0149, cacheWrite: null },

  /* ── OpenRouter（openrouter.ai）────────────────────────────────────
     十五款免费模型源里明说是 0；ling-3.1-flash 是按量计费的实价，
     但源里同样没列缓存写单价 ⇒ cacheWrite 为 null。 */
  "or/dots-studio/dots-3-note-preview:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/liquid/lfm-2.5-2.6b:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/nvidia/nemotron-3.5-lightning:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/thinkingmachines/inkling-small:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/poolside/laguna-s-2.1:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/thinkingmachines/inkling:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/poolside/laguna-xs-2.1:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/cohere/north-mini-code:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/nvidia/nemotron-3.5-content-safety:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/nvidia/nemotron-3-ultra-550b-a55b:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/google/gemma-4-26b-a4b-it:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/google/gemma-4-31b-it:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/nvidia/nemotron-3-super-120b-a12b:free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/openrouter/free": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  "or/inclusionai/ling-3.1-flash": { input: 0.075, output: 0.225, cacheRead: 0.015, cacheWrite: null },
};

/* ══════════════════════════════════════════════════════════════════════
 * ③ 小工具
 * ══════════════════════════════════════════════════════════════════════ */

/** 取一个字符串字段；null / undefined / 非字符串都算「没有」。 */
function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * 取一个数值字段，认两种写法：账本的 json 名（cache_read）与调用方的
 * camelCase（cacheRead）。两种都认，是因为记录既可能来自账本（已改名），
 * 也可能直接来自调用方给的事件（还没改名）。
 *
 * @returns {number} 取不到就是 0（账本缺数字就是 0，不是「不知道」——
 *          账本那边已经把这个口径定死了）
 */
function pickNum(rec, ...names) {
  for (const name of names) {
    const v = rec[name];
    if (v === undefined || v === null) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * 读一条价格里的某个通道。
 *
 * 三种结果必须分得清：
 *   · number   —— 有单价
 *   · null     —— **明说**不知道（字段在，值是 null）：不许拿别的来源顶替
 *   · undefined —— 这个来源没给（可以往下一个来源找）
 *
 * 「写了但不是数」（用户手滑把 3 写成 "abc"）算作**没给**，而不是 0：
 * 按 0 = 悄悄少算钱；按「没给」则可以退到表里那个已知正确的价。
 */
function readChannel(v, ...names) {
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(v, name)) continue;
    const raw = v[name];
    if (raw === null || raw === undefined) return null;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) return n;
    /* 写了但不是数 ⇒ 当作这个来源没给，继续看下一个别名 */
  }
  return undefined;
}

/** 把一条价格整理成四个通道；四个都没有的条目等于没有条目。 */
function normalizeEntry(v) {
  if (!v || typeof v !== "object") return null;
  const input = readChannel(v, "input");
  const output = readChannel(v, "output");
  const cacheRead = readChannel(v, "cacheRead", "cache_read");
  const cacheWrite = readChannel(v, "cacheWrite", "cache_write");
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite };
}

/** 覆盖优先级：精确键 > 渠道通配 > 表。每个通道各按这个顺序取第一个有的。 */
function pickChannel(...candidates) {
  for (const c of candidates) {
    if (c !== undefined) return c;
  }
  return undefined;
}

/**
 * 取某个来源的某个通道；来源本身不存在时给 undefined（=「这个来源没给」），
 * **不能给 null** —— null 是「明说不知道」，两者在合并时的待遇完全不同。
 */
function channelOf(entry, field) {
  return entry ? entry[field] : undefined;
}

/** 拷一份表出来（表是模块私有的，调用方改了它不该影响下一次调用）。 */
function cloneEntries(entries) {
  const out = {};
  for (const [k, v] of Object.entries(entries)) {
    out[k] = { input: v.input, output: v.output, cacheRead: v.cacheRead, cacheWrite: v.cacheWrite };
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 价格表
 * ══════════════════════════════════════════════════════════════════════ */

/** 内置表（每次给一份拷贝，调用方改不坏模块里的那张）。 */
const BUILTIN_TABLE = {
  pricedAt: PRICED_AT,
  currency: CURRENCY,
  unit: UNIT,
  entries: cloneEntries(ENTRIES),
};

/**
 * 这张内置价格表。
 *
 * @returns {{pricedAt: string, currency: string, unit: string,
 *            entries: object}} pricedAt 是快照日期（这张表是哪天的价）
 */
export function priceTable() {
  return {
    pricedAt: BUILTIN_TABLE.pricedAt,
    currency: BUILTIN_TABLE.currency,
    unit: BUILTIN_TABLE.unit,
    entries: cloneEntries(BUILTIN_TABLE.entries),
  };
}

/**
 * 校验一张**外来的**价格表（远端拉回来的），合格才交给 estimateCost 用。
 *
 * ★ **必须带 pricedAt**：一张没有日期的表，用户无从判断它还准不准；
 *   而价格是会漂移的 —— 没日期的表等于让用户拿一个不知道多旧的数字去对账。
 *   所以日期缺失的表一律**拒绝**，由调用方继续用旧表（拉不到就用旧的，
 *   不许因为拉不到就把费用清空）。
 *
 * ★ 条目缺一半就不要：只给了输入价、没给输出价的条目，算出来的总价是残的，
 *   而残的总价看起来像个真数。
 *
 * @param {object} raw 形如 { pricedAt, currency, unit, entries: { "厂商/模型": {...} } }
 * @returns {{ok: boolean, table: object|null, reason: string}} 不合格时 table 为 null
 */
export function normalizeTable(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, table: null, reason: "不是一个对象" };
  }
  const pricedAt = str(raw.pricedAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pricedAt)) {
    return { ok: false, table: null, reason: "缺 pricedAt（或不是 YYYY-MM-DD）：价格会漂移，没日期的表不能用" };
  }
  if (!Number.isFinite(Date.parse(`${pricedAt}T00:00:00Z`))) {
    return { ok: false, table: null, reason: `pricedAt 不是真的日期：${pricedAt}` };
  }
  const src = raw.entries;
  if (!src || typeof src !== "object" || Array.isArray(src)) {
    return { ok: false, table: null, reason: "缺 entries" };
  }
  const entries = {};
  for (const [key, v] of Object.entries(src)) {
    const e = normalizeEntry(v);
    if (!e) continue;
    if (typeof e.input !== "number" || typeof e.output !== "number") continue;
    entries[key] = {
      input: e.input,
      output: e.output,
      cacheRead: typeof e.cacheRead === "number" ? e.cacheRead : null,
      cacheWrite: typeof e.cacheWrite === "number" ? e.cacheWrite : null,
    };
  }
  /* 一张**空的**表多半是拉坏了，不是一张「所有模型都免费」的表。
     放它过去 = 把费用清成 0（用户以为没花钱）。宁可用旧的。 */
  if (Object.keys(entries).length === 0) {
    return { ok: false, table: null, reason: "entries 里没有一条可用的单价（多半是拉坏了）" };
  }
  return {
    ok: true,
    reason: "",
    table: {
      pricedAt,
      currency: str(raw.currency) || CURRENCY,
      unit: UNIT,
      entries,
    },
  };
}

/**
 * 把 models.dev 的 api.json 翻成本仓这张表的格式。
 *
 * 存在的意义是「表要能被更新而不改代码」：远端拉一份 models.dev 的 api.json，
 * 调它就得到一张新表（价格、模型清单都跟着更新），**不用改代码**。
 * 拉不到就不调 —— 继续用旧表，费用不清空。
 *
 * ★ 键是「本仓渠道/真实模型名」：models.dev 的 provider id 与本仓渠道名
 *   不是一回事（SenseNova 在那边叫 sensenova），由 MODELS_DEV_CHANNELS 对上。
 * ★ 本仓没在 map 里出现的渠道，一个条目都不会有 —— 宁可没有，不要错。
 *
 * @param {object} raw models.dev 的 api.json（{ "<provider id>": { models: {...} } }）
 * @param {object} [channelMap] 本仓渠道 → models.dev provider id；不给就用内置映射
 * @param {string} [pricedAt] 这张表的快照日期（= 抓取那天）；本模块**不取时钟**，
 *        所以这个日期必须由调用方给 —— 给不出就别装作有日期
 * @returns {{pricedAt: string, currency: string, unit: string, entries: object}}
 */
export function tableFromModelsDev(raw, channelMap, pricedAt) {
  const map = channelMap && typeof channelMap === "object" ? channelMap : MODELS_DEV_CHANNELS;
  const entries = {};
  if (raw && typeof raw === "object") {
    for (const [channel, mdProvider] of Object.entries(map)) {
      const prov = raw[mdProvider];
      if (!prov || typeof prov !== "object") continue;
      const models = prov.models;
      if (!models || typeof models !== "object") continue;
      for (const [modelId, model] of Object.entries(models)) {
        const cost = model && typeof model === "object" ? model.cost : null;
        if (!cost || typeof cost !== "object") continue;
        const input = typeof cost.input === "number" ? cost.input : Number(cost.input);
        const output = typeof cost.output === "number" ? cost.output : Number(cost.output);
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
        const free = input === 0 && output === 0;
        const cr = cost.cache_read;
        const cw = cost.cache_write;
        entries[`${channel}/${modelId}`] = {
          input,
          output,
          /* 一款输入输出都白给的模型不可能另收缓存写的钱 —— 这个推断在数据
             这一层做一次，运行时只认表里写好的数。 */
          cacheRead: free ? 0 : typeof cr === "number" && Number.isFinite(cr) ? cr : null,
          cacheWrite: free ? 0 : typeof cw === "number" && Number.isFinite(cw) ? cw : null,
        };
      }
    }
  }
  /* 快照日期是**抓取那天**—— 本模块不取时钟，所以由调用方给；给不出就退回
     内置表的日期（总比空着强：空着的表 normalizeTable 会直接拒收）。 */
  return { pricedAt: str(pricedAt) || PRICED_AT, currency: CURRENCY, unit: UNIT, entries };
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 费用估算
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 一条记录里与钱有关的四个通道（外加一小时的缓存写，它是缓存写的子集）。
 *
 * 键既认账本的 json 名，也认调用方的 camelCase。
 */
function tokensOf(rec) {
  const input = pickNum(rec, "in");
  const output = pickNum(rec, "out");
  const cacheRead = pickNum(rec, "cache_read", "cacheRead");
  const cacheWrite = pickNum(rec, "cache_write", "cacheWrite");
  const cacheWrite1h = pickNum(rec, "cache_write_1h", "cacheWrite1h");
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    any: input !== 0 || output !== 0 || cacheRead !== 0 || cacheWrite !== 0,
    total: input + output + cacheRead + cacheWrite,
  };
}

/**
 * 这条记录该按哪个键找价：厂商 + **真实模型名**。
 *
 * ★ 不用 req 当键：req 是**档位**（claude-opus-5），与厂商无关，同一个档位
 *   在不同厂商是不同模型、不同价。按档位估价必然串味。
 * ★ model 空了才退到 served（厂商回报的那个）：那是真实模型名，比档位强。
 */
function priceKeyOf(rec) {
  const provider = str(rec.provider);
  const model = str(rec.model) || str(rec.served);
  if (!provider || !model) return "";
  return `${provider}/${model}`;
}

/** 这条记录能不能按这个价目估：输入输出必须有价，用到的缓存通道也必须有价。 */
function priceable(entry, tok) {
  if (!entry) return false;
  if (typeof entry.input !== "number" || typeof entry.output !== "number") return false;
  if (tok.cacheRead > 0 && typeof entry.cacheRead !== "number") return false;
  if (tok.cacheWrite > 0 && typeof entry.cacheWrite !== "number") return false;
  return true;
}

/**
 * 一小时缓存写的单价：Anthropic 对它的每个模型都按 **2 倍输入价**收
 * （magpie 的 catalog.OneHourFor 同一口径）。别的厂商没有这一档，
 * 一小时缓存写就按普通缓存写算 —— 它本来就是缓存写的一部分。
 */
function oneHourRate(entry, modelName) {
  if (typeof entry.cacheWrite !== "number") return 0;
  if (/claude/i.test(modelName)) return entry.input * 2;
  return entry.cacheWrite;
}

/**
 * 一条记录多少钱。
 *
 * 公式与 magpie 的 catalog.CostSplit 同：四段各自乘自己的单价再除以 100 万。
 * 缓存读与缓存写**分开算** —— 两者通常差着好几倍，混成一个数就是错数。
 */
function costOf(entry, tok, modelName) {
  /* 一小时缓存写是缓存写的子集，不能重复计（magpie 的 clamp 同）。 */
  const oneHourTokens = Math.min(Math.max(tok.cacheWrite1h, 0), tok.cacheWrite);
  const plainCacheWrite = tok.cacheWrite - oneHourTokens;
  const usd =
    tok.input * entry.input +
    tok.output * entry.output +
    tok.cacheRead * entry.cacheRead +
    plainCacheWrite * entry.cacheWrite +
    oneHourTokens * oneHourRate(entry, modelName);
  return usd / TOKENS_PER_UNIT;
}

/**
 * 找一条记录的价目：表里的 + 用户覆盖的，按「精确键 > 渠道通配 > 表」取。
 */
function lookupPrice(table, overrides, key) {
  const slash = key.indexOf("/");
  const provider = slash > 0 ? key.slice(0, slash) : "";
  const tableEntry = normalizeEntry(table.entries && table.entries[key]);
  const exact = normalizeEntry(overrides && overrides[key]);
  const wildcard = provider ? normalizeEntry(overrides && overrides[`${provider}/*`]) : null;
  const input = pickChannel(channelOf(exact, "input"), channelOf(wildcard, "input"), channelOf(tableEntry, "input"));
  const output = pickChannel(channelOf(exact, "output"), channelOf(wildcard, "output"), channelOf(tableEntry, "output"));
  const cacheRead = pickChannel(
    channelOf(exact, "cacheRead"), channelOf(wildcard, "cacheRead"), channelOf(tableEntry, "cacheRead"),
  );
  const cacheWrite = pickChannel(
    channelOf(exact, "cacheWrite"), channelOf(wildcard, "cacheWrite"), channelOf(tableEntry, "cacheWrite"),
  );
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return null;
  }
  return {
    input: typeof input === "number" ? input : null,
    output: typeof output === "number" ? output : null,
    cacheRead: typeof cacheRead === "number" ? cacheRead : null,
    cacheWrite: typeof cacheWrite === "number" ? cacheWrite : null,
  };
}

/** 把 opts.now（epoch ms / Date / ISO 串）折成 epoch ms；取不到就是「不知道」。 */
function nowMs(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = str(v);
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 估一批记录一共多少钱。
 *
 * @param {object[]} records 账本记录（usage-ledger.mjs 的 loadRecords 出来的那种）
 * @param {object} [opts]
 * @param {object} [opts.overrides] 用户自己写的单价，按「厂商/模型」索引；
 *        「厂商/*」管这一家所有还没被精确覆盖的模型
 * @param {object} [opts.table] 远端拉来的新表（先过 normalizeTable）；不给就用内置表
 * @param {number|string|Date} [opts.now] 「现在」（epoch ms / ISO 串）——
 *        用来算这张表有多旧；**不给就不算陈旧，不影响估价**
 * @param {number} [opts.maxAgeDays] 超过多少天算陈旧（缺省 30）
 * @returns {{total: number|null, known: boolean, byModel: object,
 *            unknownModels: string[], pricedAt: string, currency: string,
 *            stale: boolean, ageDays: number|null}}
 */
export function estimateCost(records, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  /* ★ 传进来的表不合格就用内置表 —— 拉坏了一张表不该把费用清成 0，
     而「拉不到就用旧的」正是这条。空的表尤其危险：它会让所有模型变成
     「估不出」，面板上的费用一夜之间变成「—」。
     ★ 没带 pricedAt 的表也不收：价格会漂移，一张没日期的表用户无从判断
       它还准不准，宁可用旧的（旧的至少有个日子）。 */
  const given = o.table && typeof o.table === "object" ? o.table : null;
  const givenEntries = given && given.entries && typeof given.entries === "object" ? given.entries : null;
  const givenDated = given
    && /^\d{4}-\d{2}-\d{2}$/.test(str(given.pricedAt))
    && Number.isFinite(Date.parse(`${str(given.pricedAt)}T00:00:00Z`));
  const table = givenEntries && Object.keys(givenEntries).length > 0 && givenDated ? given : BUILTIN_TABLE;
  const overrides = o.overrides && typeof o.overrides === "object" ? o.overrides : {};

  const byModel = new Map();
  const unknown = new Set();

  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== "object") continue;
    const key = priceKeyOf(rec);
    if (!key) continue;
    const tok = tokensOf(rec);
    /* 四个通道都是 0 ⇒ 这条记录没什么可估的：既不计钱，也不算「估不出」
       （把「没花钱」说成「估不出」是吵用户）。 */
    if (!tok.any) continue;

    const entry = lookupPrice(table, overrides, key);
    const modelName = key.slice(key.indexOf("/") + 1);

    if (!priceable(entry, tok)) {
      /* ★ 估不出就**记下来**，不按 0 混进总数（magpie 的 unpriced 同一口径）。
         用户要知道自己付的钱里有一笔是黑箱。 */
      unknown.add(key);
      const cur = byModel.get(key) || { cost: null, tokens: 0, known: false };
      cur.tokens += tok.total;
      cur.known = false;
      cur.cost = null;
      byModel.set(key, cur);
      continue;
    }

    const c = costOf(entry, tok, modelName);
    const cur = byModel.get(key) || { cost: 0, tokens: 0, known: true };
    if (cur.known === false) {
      /* 同一个模型有的记录估得出、有的估不出 ⇒ 整个模型估不出：
         报一个「部分已知」的总价，比报一个完整的总价更像在糊弄人。 */
      cur.tokens += tok.total;
      byModel.set(key, cur);
      continue;
    }
    cur.cost += c;
    cur.tokens += tok.total;
    byModel.set(key, cur);
  }

  const unknownModels = Array.from(unknown).sort();
  let total = 0;
  for (const v of byModel.values()) {
    if (v.known && typeof v.cost === "number") total += v.cost;
  }
  /* ★ 只要有一个模型估不出，这批的总价就是 **null**（不是「已知部分之和」）：
     偏少的总价比没有总价更坏 —— 用户会拿它去对账。 */
  const unknownCount = unknownModels.length > 0;
  if (unknownCount) total = null;

  const pricedAt = str(table.pricedAt) || BUILTIN_TABLE.pricedAt;
  const currency = str(table.currency) || BUILTIN_TABLE.currency;

  /* 表有多旧：让面板能提一句「这张表 47 天没更新了」。**陈旧不影响估价**。 */
  const now = nowMs(o.now);
  const pricedAtMs = Date.parse(`${pricedAt}T00:00:00Z`);
  let ageDays = null;
  if (now !== null && Number.isFinite(pricedAtMs)) {
    ageDays = Math.floor((now - pricedAtMs) / DAY_MS);
  }
  const maxAgeDays = Number.isFinite(o.maxAgeDays) ? Number(o.maxAgeDays) : STALE_AFTER_DAYS;
  const stale = ageDays !== null && ageDays > maxAgeDays;

  const out = {};
  for (const [k, v] of byModel) {
    out[k] = { cost: v.known ? v.cost : null, tokens: v.tokens, known: v.known };
  }

  return {
    total,
    known: !unknownCount,
    byModel: out,
    unknownModels,
    pricedAt,
    currency,
    stale,
    ageDays,
  };
}
