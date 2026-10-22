/**
 * pricing-refresh.mjs —— 价格表的「用户点了才更新」
 *
 * ── 补的是哪个洞 ───────────────────────────────────────────────────────
 * pricing.mjs 已经有了一张内置价格表（快照 2026-10-22），也已经有「远端表
 * 不合格就用旧表」的兜底。但它**只管算钱**，不管「这张表是哪天的快照、
 * 远端那张要不要换上、面板上该怎么跟用户说」。
 *
 * 面板要能回答三个问题，缺一个用户就没法对账：
 *   ① 我现在用的这张单价表，是哪天的快照？（价格会漂移，没日期的表不能对账）
 *   ② 刚从 models.dev 拉回来的那张，要不要换上？换/不换都得说清为什么。
 *   ③ 哪些渠道估不出？为什么估不出？（估不出 ≠ 估出 0）
 *
 * 本模块把这三件事做成**纯函数**：远端数据与时刻从参数进来，判定与人话出去。
 *
 * ── 为什么绝不自动更新 ─────────────────────────────────────────────────
 * 自动更新会让「今天我花了多少钱」这句话的**含义**在某天悄悄变掉。
 * 用户是拿面板上的费用跟厂商账单对账的：昨天算得出、今天算不出，
 * 他不会想到是厂商改了口径，只会觉得路由台在骗他。
 * 所以「更新」只能是**用户点了才发生**的事 —— 本模块不联网、不取时钟，
 * 由调用方（服务端）在用户点按钮的那一刻把远端数据递进来。
 *
 * ── 与 magpie 有意不同（及原因）────────────────────────────────────────
 *   ① magpie 的 catalog.Sync 是后台重拉 models.dev 落到 CachePath，
 *      拉失败就报错、旧缓存继续用（internal/catalog/catalog.go 的 Sync）。
 *      本仓**不后台重拉**：价格是用户对账的依据，不是后台状态。
 *      同一个「拉失败继续用旧表」的兜底，两边都要有 —— 差别只在谁来按那个钮。
 *   ② magpie 的 CostSplit 把「源里没列」当 0（缓存费被当成免费）；
 *      本仓沿用 pricing.mjs 的 null（不知道）。本模块只负责把 null 原样传下去。
 *
 * ── 「远端表只覆盖了一部分厂商」不拦 ───────────────────────────────────
 *   远端源本来就可能只列本仓关心的那几家（models.dev 有几百家，本仓只要四家），
 *   把「少了几家」判成不合格会误伤这种**正常**的远端表。
 *   真正要拦的是「一条单价都没有」—— 那由 normalizeTable 与
 *   「一家认识的厂商都没有」两道拦住了（前者拒空表，后者拒形状变了）。
 *
 * ── 这一层不做什么 ─────────────────────────────────────────────────────
 *   · **不替服务端联网**：拉取是服务端的事，本模块只判「这张远端表能不能用」。
 *   · **不替服务端落盘**：远端表存在哪、什么时候存，是接线层的事。
 *   · **不替面板画**：卡片只负责把这里判定好的东西画出来。
 *
 * ── 硬规矩 ────────────────────────────────────────────────────────────
 *   · **纯逻辑**：零 IO、零时钟；只 import pricing.mjs（那张表也是零依赖纯模块）。
 *   · **内部绝不调 Date.now()**：现在几点一律由 opts.now 传入。
 *   · **人话优先**：每个判定都要有一句中文说明「为什么用这张」。
 *     面板把那句话原样显示给用户 —— 「invalid schema」对用户毫无意义。
 *   · **估不出 ≠ 估出 0**：null 一路传到底；0 是真的免费，两者不许混。
 */

import {
  MODELS_DEV_CHANNELS,
  priceTable,
  normalizeTable,
  tableFromModelsDev,
} from "./pricing.mjs";

/* ══════════════════════════════════════════════════════════════════════
 * ① 常量与小工具
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 快照超过多少天算「陈旧」。与 pricing.mjs 的 STALE_AFTER_DAYS 同口径（30 天）。
 * 陈旧**不影响估价** —— 宁可给一个带日期的旧数，也不要给一个没有的数；
 * 它只是让面板能提一句「这张表多久没更新了」。
 */
export const STALE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 估不出的渠道，各家「为什么估不出」。
 *
 * 这是**计费口径**，不是展示文案：换一家渠道进来，口径就不同（按 token 还是
 * 按积分），面板上那句「为什么估不出」就得跟着变。所以它跟价格表住在一起，
 * 而不是散在面板的各个角落。
 *
 *   · bai       —— B.AI 转发站：它卖的是「转发」，公开渠道查不到它的转售价
 *   · qd/wb/wbai —— 按积分倍率（price_factor）算，压根不是按 token
 */
export const UNPRICED_WHY = {
  bai: "公开渠道查不到转售价",
  qd: "按积分倍率算，不是按 token",
  wb: "按积分倍率算，不是按 token",
  wbai: "按积分倍率算，不是按 token",
};

/** 兜底原因：清单里有、但这里没登记的一家。 */
export const DEFAULT_WHY = "表里没有这一家的单价";

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** 取一个数值：null / undefined / 非数一律当「不知道」（null），不当 0。 */
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 把「现在」折成 epoch ms；取不到就是「不知道」（不给就不算陈旧）。 */
function nowMs(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = str(v);
  if (!s) return null;
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}

/** 快照日期折成 epoch ms；不是 YYYY-MM-DD 或不是真日期就是 null。 */
function dateMs(d) {
  const s = str(d);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const n = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(n) ? n : null;
}

/** 这像一张表吗？有条目、有日期，才谈得上「用哪张」。 */
function isTable(t) {
  return !!t && typeof t === "object" && !Array.isArray(t)
    && !!t.entries && typeof t.entries === "object" && !Array.isArray(t.entries);
}

/**
 * 把「远端」这个东西收成一种统一的形状：{ ok, table, reason }。
 * 收拢在这儿，是为了 chooseTable 只认一种输入 —— 调用方忘了先调
 * buildRemoteTable 也不会静默走错分支。
 */
function asChecked(remote) {
  if (!remote || typeof remote !== "object") {
    return { ok: false, table: null, reason: "没拿到远端表（还没拉过，或拉取失败）" };
  }
  if (Object.prototype.hasOwnProperty.call(remote, "ok")) {
    return {
      ok: !!remote.ok,
      table: remote.table || null,
      reason: str(remote.reason) || "远端表不合格",
    };
  }
  /* 裸表（没经过 buildRemoteTable）也认，但照样要过一遍校验：
     没过就当不合格，绝不因为「形状像表」就放行。 */
  return normalizeTable(remote);
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 远端表：models.dev 的 api.json → 本仓这张表
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把远端拉回来的 api.json 变成一张**合格**的表；不合格就说清为什么。
 *
 * @param {object} raw models.dev 的 api.json（{ "<provider id>": { models: {...} } }）
 * @param {object} [opts]
 * @param {string} [opts.pricedAt] 这张表的快照日期（= 抓取那天）。
 *        本模块不取时钟，所以这个日期必须由调用方给 —— 给不出就别装作有日期。
 * @param {object} [opts.channelMap] 本仓渠道 → models.dev provider id
 * @param {object} [opts.baseline] 参照表（默认内置表）：用来发现「少了一整家厂商」
 * @param {function} [opts.nameOf] 渠道 key → 显示名（理由里要给人看的是显示名）
 * @returns {{ok: boolean, table: object|null, reason: string}}
 */
export function buildRemoteTable(raw, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, table: null, reason: "没拉到 models.dev 的数据（网络不通，或回来的不是 JSON 对象）" };
  }

  const pricedAt = str(o.pricedAt);
  if (dateMs(pricedAt) === null) {
    return { ok: false, table: null, reason: "说不出这张表是哪天的快照 —— 价格会漂移，没有日期的表不能用" };
  }

  const map = (o.channelMap && typeof o.channelMap === "object") ? o.channelMap : MODELS_DEV_CHANNELS;
  const known = Object.values(map).filter((x) => typeof x === "string" && x);
  const hit = known.filter((id) => raw[id] && typeof raw[id] === "object");
  if (!hit.length) {
    return {
      ok: false,
      table: null,
      reason: `拉回来的数据里一家本仓要的厂商都没有（认得 ${known.join(" / ")}）—— 多半是数据源改了形状`,
    };
  }

  const checked = normalizeTable(tableFromModelsDev(raw, map, pricedAt));
  if (!checked.ok) {
    return { ok: false, table: null, reason: `拉回来的单价表不合格：${checked.reason}` };
  }

  return { ok: true, table: checked.table, reason: "" };
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 远端 vs 现在：谁说了算
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 远端表与现在在用的那张，谁说了算。
 *
 * 判据是**快照日期**，不是内容：日期是这张表唯一可靠的版本号
 * （条目会因厂商增删模型而变，日期不会）。
 *
 *   · 远端不合格（拉不到 / 没有日期 / 形状不对）⇒ 继续用现在这张
 *   · 远端**比现在这张旧** ⇒ 继续用现在这张
 *   · 远端不比现在这张旧（更新或同一天）⇒ 换上远端那张
 *
 * 「同一天」也换：用户点了「更新价格表」，什么都没发生是最难解释的一种结果 ——
 * 而同一天抓回来的表本来就该比内置那份更贴近当下。
 *
 * @param {object} remote buildRemoteTable 的返回值；也认一张裸表（照样先校验）
 * @param {object} [opts]
 * @param {object} [opts.current] 现在在用的那张表；不给就用内置表
 * @param {string} [opts.currentSource] 现在这张的来源（"builtin" | "remote"）
 * @returns {{table: object, source: string, changed: boolean, pricedAt: string, reason: string}}
 */
export function chooseTable(remote, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const current = isTable(o.current) ? o.current : priceTable();
  const currentSource = o.currentSource === "remote" ? "remote" : "builtin";
  const currentDate = str(current.pricedAt) || "（无日期）";
  const currentAt = dateMs(str(current.pricedAt));

  const checked = asChecked(remote);
  if (!checked.ok) {
    return {
      table: current,
      source: currentSource,
      changed: false,
      pricedAt: str(current.pricedAt),
      reason: `${checked.reason} —— 继续用 ${currentDate} 那张`,
    };
  }

  const remoteTable = checked.table;
  const remoteDate = str(remoteTable.pricedAt);
  const remoteAt = dateMs(remoteDate);

  if (remoteAt === null || currentAt === null || remoteAt < currentAt) {
    return {
      table: current,
      source: currentSource,
      changed: false,
      pricedAt: str(current.pricedAt),
      reason: `远端表比现在这张旧（远端 ${remoteDate} · 现在 ${currentDate}）—— 继续用现在这张`,
    };
  }

  return {
    table: remoteTable,
    source: "remote",
    changed: true,
    pricedAt: remoteDate,
    reason: `远端表更新（${remoteDate}）—— 已换上`,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 这张表有多旧
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 这张表有多旧（多旧算陈旧）。
 *
 * ★ 不给 now 就**不知道**多旧（ageDays = null），但这**不影响估价** ——
 *   不知道日期照样能算钱，只是不提「陈旧」那一句。
 * ★ 天数的算法与 pricing.mjs 的 estimateCost 逐字一致，两边不许算出两个数。
 *
 * @param {object} table 一张表
 * @param {object} [opts]
 * @param {number|string|Date} [opts.now] 「现在」（epoch ms / ISO 串）
 * @param {number} [opts.maxAgeDays] 超过多少天算陈旧（缺省 30）
 * @returns {{pricedAt: string, ageDays: number|null, stale: boolean, maxAgeDays: number}}
 */
export function staleInfo(table, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const pricedAt = str(table && table.pricedAt);
  const maxAgeDays = Number.isFinite(o.maxAgeDays) ? Number(o.maxAgeDays) : STALE_AFTER_DAYS;
  const now = nowMs(o.now);
  const priced = dateMs(pricedAt);
  let ageDays = null;
  if (now !== null && priced !== null) ageDays = Math.floor((now - priced) / DAY_MS);
  return { pricedAt, ageDays, stale: ageDays !== null && ageDays > maxAgeDays, maxAgeDays };
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 给面板看的一份可读描述
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把一张表翻成面板能直接显示的东西。
 *
 * 三件事：
 *   ① 每条「厂商/模型」的四个单价 —— **数字**与**null**分开摆：
 *      0 是「真的免费」，null 是「源里没列，查不到」。两者混起来，
 *      缓存费就会被当成免费（magpie 的 CostSplit 栽在这里）。
 *   ② 估不出的渠道，以及**为什么**估不出。
 *   ③ 快照日期与陈不陈旧。
 *
 * @param {object} table 一张表
 * @param {object} [opts]
 * @param {string[]} [opts.channels] 本仓的渠道 key（清单里的那些）
 * @param {function} [opts.nameOf] 渠道 key → 显示名
 * @param {object} [opts.billing] 渠道 key → 「为什么估不出」；默认用 UNPRICED_WHY
 * @param {number|string|Date} [opts.now] 「现在」
 * @param {number} [opts.maxAgeDays] 超过多少天算陈旧（缺省 30）
 */
export function describeTable(table, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const t = isTable(table) ? table : priceTable();
  const nameOf = typeof o.nameOf === "function" ? o.nameOf : (k) => str(k);
  const billing = (o.billing && typeof o.billing === "object") ? o.billing : UNPRICED_WHY;

  const entries = [];
  for (const [key, v] of Object.entries(t.entries || {})) {
    const i = key.indexOf("/");
    const channel = i > 0 ? key.slice(0, i) : "";
    const model = i > 0 ? key.slice(i + 1) : key;
    const e = v && typeof v === "object" ? v : {};
    const input = numOrNull(e.input);
    const output = numOrNull(e.output);
    const cacheRead = numOrNull(e.cacheRead);
    const cacheWrite = numOrNull(e.cacheWrite);
    entries.push({
      key,
      channel,
      model,
      name: nameOf(channel) || channel,
      input,
      output,
      cacheRead,
      cacheWrite,
      /* 四格都是 0 = 这一款真的免费；有一格是 null = 那一格查不到。
       * 这两个 flag 是给面板区分「0」与「—」用的，绝不许互相顶替。 */
      free: input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0,
      partial: input === null || output === null || cacheRead === null || cacheWrite === null,
    });
  }
  entries.sort((a, b) => (a.channel === b.channel
    ? (a.model < b.model ? -1 : a.model > b.model ? 1 : 0)
    : (a.channel < b.channel ? -1 : 1)));

  /* 估不出的渠道 = 表里一条条目都没有的那几家。 */
  const priced = new Set(entries.map((e) => e.channel));
  const unpriced = [];
  for (const raw of Array.isArray(o.channels) ? o.channels : []) {
    const key = typeof raw === "string" ? raw : str(raw && raw.key);
    if (!key || priced.has(key)) continue;
    const own = typeof raw === "object" && raw ? str(raw.name) : "";
    unpriced.push({
      key,
      name: own || nameOf(key) || key,
      why: str(billing[key]) || DEFAULT_WHY,
    });
  }

  const stale = staleInfo(t, o);
  return {
    pricedAt: stale.pricedAt,
    currency: str(t.currency) || "USD",
    unit: str(t.unit) || "per-1M-tokens",
    stale: stale.stale,
    ageDays: stale.ageDays,
    maxAgeDays: stale.maxAgeDays,
    entries,
    unpriced,
    pricedCount: entries.length,
    unpricedCount: unpriced.length,
  };
}
