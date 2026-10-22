/**
 * audit.mjs —— 审计台账（每次对外发请求 / 收响应，记一条）
 *
 * ## 它补的是哪个洞
 *
 * 仓库里已有的两本账都**不是**审计：
 *   · src/server/usage-ledger.mjs —— 用量账本：记 token 数与厂商答了什么，
 *     是拿去跟厂商账单并排看的；
 *   · src/server/candidates.mjs —— 失败分类与冷却表：记「这次失败是什么性质、
 *     该休息谁」，是**当下**的决策依据，记完就散。
 *
 * 缺的是**第三本**：一条链路上到底发生了什么，按时间顺序排着，谁在什么时候
 * 走了哪一家、问了哪个模型、结果如何、耗时多少、失败被归成哪一类。
 * 用途是**事后**的：用户报「昨天 Claude 卡了」，得能翻出那段时间每条请求去了哪、
 * 哪一家在拖后腿、失败都被归成了什么。
 *
 * 最要紧的一条纪律在文件头：**台账里绝不能出现凭据**。
 * 上游的错误正文常把请求里的东西原样回显（连 `authorization` 都可能吐回来），
 * 而台账是要落盘、要在面板上给人看的。所以这里每一个字符串字段都过一遍
 * src/server/redact.mjs —— 那是本仓库唯一的脱敏闸门。
 *
 * ## magpie 的对应物
 *
 * yetone/magpie 的 internal/maskrec/（maskrec.go + summary.go）：
 *   记「这次请求遮掉了哪些值、是什么类、谁遮的、发给了谁」，
 *   落盘按天一个文件（~/.config/magpie/masking/YYYY-MM-DD.jsonl），
 *   内存里留最近 400 条带上下文片段，按 provider/agent/kind 过滤，
 *   还有一份按天汇总（次数、种类、按小时分布、最常被遮的值）。
 *
 * ## 与 magpie 的差异（三处，都是有意的）
 *
 * ① **记的是「请求本身」，不是「遮掉了什么」。**
 *    magpie 的 maskrec 是脱敏功能的**副产品**：只有当脱敏开着的时候才有记录，
 *    记的是值被换成了哪个占位符。本模块记的是**每一次对外交互**本身 ——
 *    哪怕这一条里一个凭据都没有（大多数情况），它也该在册。
 *    脱敏在这里不是主角，是**义务**：台账必须干净，而不是台账必须记得脱敏。
 *
 * ② **不落盘，只在内存里，且有上界。**
 *    magpie 每天一个 JSONL 文件、留 30 天 / 100MB。
 *    本模块**不碰磁盘**：落盘路径、保留天数、要不要分文件，是**接线层**的决定
 *    （跟 usage-ledger 一样，目录由调用方给）。这里只保证一件事 ——
 *    **内存里的条数有硬上界**，因为台账是常驻进程里的，长跑不能把它吃光。
 *    想落盘的调用方传 `sink` 回调即可（自己决定写哪儿、写什么）。
 *
 * ③ **失败归类沿用本仓库的 KINDS，不另起一套。**
 *    magpie 的 maskrec 不归类失败（它不关心失败）。
 *    本模块归类，但**用 candidates.mjs 的那套**（credit/quota/rate/auth/content/
 *    unserved/other）—— 台账里的 kind 必须和冷却表里的 kind 是同一个词，
 *    否则看台账的人得在两套词汇之间来回翻译。
 *    **权威的分类器是 candidates.mjs 的 classifyFailure()**，本模块只提供一个
 *    兜底的粗分类（调用方没给 kind 时用），两者口径不完全一样，这是刻意的。
 *
 * ## 边界
 *
 *   · **零依赖、零 IO、零时钟** —— 时间一律由 opts.now 传进来（数字或函数），
 *     这样测试能逐字断言「那一刻」到底是什么。
 *   · **不 import 本仓库其它模块** —— 只 import 本次的 redact.mjs
 *     （脱敏闸门是台账的一部分，不是「别的模块」）。
 *   · **写台账绝不抛** —— accounting must never break a call（magpie 的原话）：
 *     台账写不下去绝不能让一次本来成功的模型调用失败，所以 sink 的异常被吞掉。
 *   · **字段是封闭的** —— 只认固定的那几个字段，调用方多传的键一律丢掉。
 *     这是「台账里不会出现凭据」的**兜底**：不然调用方随手塞一个
 *     `rawHeaders` 进来，凭据就进来了。
 */

import { redact } from "./redact.mjs";

/** 失败归类。与 src/server/candidates.mjs 的 KINDS 同一套词，外加 "ok"。 */
export const AUDIT_KINDS = Object.freeze([
  "ok",
  "credit",
  "quota",
  "rate",
  "auth",
  "content",
  "unserved",
  "other",
]);

/**
 * 台账的字段表：名字 → 类型。
 *
 * 类型决定缺省值：字符串 ""、数字 0、布尔 false。
 * 缺省值**明确**（没有一个字段是 undefined）—— JSON.stringify 会把 undefined
 * 的键整个丢掉，一来往返不相等，二来看台账的人会以为「这个字段没有值」
 * 和「这个字段不存在」是一回事。
 */
const FIELDS = [
  ["t", "time"], // ISO 时间戳；不知道就是 ""（不是 1970）
  ["ts", "number"], // epoch 毫秒；不知道就是 0
  ["agent", "string"], // 谁发出去的
  ["session", "string"], // 哪个会话
  ["provider", "string"], // 哪个渠道
  ["model", "string"], // 问了哪个模型
  ["outcome", "string"], // ok | error
  ["status", "number"], // 上游状态码；没拿到答复就是 0
  ["ms", "number"], // 耗时（毫秒）
  ["kind", "string"], // 失败原因归类
  ["error", "string"], // 失败原因（已脱敏、已截断）
  ["handedOn", "bool"], // 转交给了下一候选（仍算它自己的一条，但不算最终结果）
];

/** 一条记录里正文文本的截断上限。台账是给人翻的，不是日志归档。 */
const MAX_TEXT = 300;

/** session 之类标识的截断上限：够认人，不够还原。 */
const MAX_ID = 64;

/**
 * 「这家不服务这个模型」的措辞（照抄 candidates.mjs 的 UNSERVED_WORDS）。
 *
 * 口径必须跟仓库里那一处一致：台账里的 unserved 与冷却表里的 unserved
 * 要指的是同一件事，否则看台账的人会以为「不服务」和「不休息」是两码事。
 */
const UNSERVED_RE =
  /model.{0,80}(not (supported|accessible|available|found|enabled|allowed)|unsupported|does ?n[o']t exist|unknown|invalid|is unavailable)|(no such|unknown|invalid|unsupported) model|model_not_found|模型.{0,12}(不存在|不支持|无权|未开通)|request illegal/i;

/**
 * 粗分类（**兜底**）：调用方没给 kind 时用。
 *
 * ⚠ 权威口径是 candidates.mjs 的 classifyFailure() —— 它看响应体、
 * 分得清「额度用尽」和「慢下来」，本函数只看状态码和几个关键词。
 * 所以本模块的分类**更粗**：能用，但别拿它当冷却的依据。
 */
export function classifyAuditOutcome(entry = {}) {
  const status = Number.isFinite(entry.status) ? Math.trunc(entry.status) : 0;
  const text = String(entry.error == null ? "" : entry.error);
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "credit";
  if (status === 429) {
    return /quota|insufficient|余额|额度|欠费/i.test(text) ? "quota" : "rate";
  }
  if (status >= 500) return "other";
  if (status >= 400) {
    return UNSERVED_RE.test(text) ? "unserved" : "content";
  }
  return "ok";
}

/** 归一：任何东西都能变成一个确定的字符串。 */
function asText(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

/** 归一：数字收不住（NaN、Infinity、字符串）一律 0 —— 台账的数字要能求和。 */
function asNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 截断（按 UTF-16 码元，别把代理对劈开）。 */
function cut(s, max) {
  if (s.length <= max) return s;
  let end = max;
  const code = s.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/**
 * 造一条字段齐全、**已脱敏**的记录。
 *
 * 脱敏放在这一层（而不是让调用方记得调用）—— 忘了调用一次就是一次凭据落盘，
 * 这种错不能靠人的记性来防。
 *
 * 只认 FIELDS 里的字段：调用方多传的键一律丢掉。
 */
function buildRecord(entry, ts) {
  const src = entry && typeof entry === "object" ? entry : {};
  const status = asNum(src.status);
  const outcome =
    src.outcome === "ok" || src.outcome === "error"
      ? src.outcome
      : status >= 400 || status === 0
        ? "error"
        : "ok";
  const kind = src.kind ? asText(src.kind) : outcome === "ok" ? "ok" : classifyAuditOutcome(src);
  const values = {
    t: ts > 0 ? new Date(ts).toISOString() : "",
    ts: ts > 0 ? ts : 0,
    agent: cut(redact(asText(src.agent)), MAX_ID),
    session: cut(redact(asText(src.session)), MAX_ID),
    provider: cut(redact(asText(src.provider)), MAX_ID),
    model: cut(redact(asText(src.model)), MAX_ID),
    outcome,
    status,
    ms: asNum(src.ms),
    kind,
    error: cut(redact(asText(src.error)), MAX_TEXT),
    handedOn: Boolean(src.handedOn),
  };
  // 白名单是从 FIELDS 走的：往 values 里加一个键而忘了往 FIELDS 里加，
  // 它就进不了记录 —— 「多传的键一律丢掉」这条得由表来保证，不是靠记性。
  const rec = {};
  for (const [name] of FIELDS) rec[name] = values[name];
  return rec;
}

/**
 * 造一台台账。
 *
 * @param {{max?: number, now?: number|(() => number), sink?: (rec: object) => void}} [options]
 *   max  内存里最多留几条（默认 1000）。超出的从最老的开始丢。
 *   now  时刻：数字（epoch 毫秒）或函数（每次取一个）。**不给就是「不知道」**
 *        （ts=0、t=""），不偷用 Date.now() —— 偷用就测不了「那一刻」。
 *   sink 落盘回调：调用方自己决定写哪儿（appendFile…）。
 *        本模块不碰磁盘。
 */
export function createAudit(options = {}) {
  const max =
    Number.isFinite(options.max) && options.max > 0 ? Math.floor(options.max) : 1000;
  const nowFn =
    typeof options.now === "function"
      ? options.now
      : () => (Number.isFinite(options.now) ? options.now : 0);
  const sink = typeof options.sink === "function" ? options.sink : null;

  /** 内存里的记录。新的 push 老的丢 —— 有界是这个模块的第一条纪律。 */
  const records = [];

  function now() {
    const v = asNum(nowFn());
    return v > 0 ? v : 0;
  }

  /**
   * 记一条。
   *
   * 绝不抛：台账出问题不能把调用方带崩（accounting must never break a call）。
   */
  function record(entry) {
    const rec = buildRecord(entry, now());
    records.push(rec);
    if (records.length > max) records.splice(0, records.length - max);
    if (sink) {
      try {
        sink(rec);
      } catch {
        /* 吞掉：台账写不下去不该让一次成功的调用失败 */
      }
    }
    return rec;
  }

  /**
   * 查。
   *
   * @param {{provider?: string, agent?: string, model?: string, outcome?: string,
   *          kind?: string, since?: number, until?: number, limit?: number}} [filter]
   *   空串 = 不限。since/until 是 epoch 毫秒，含端点。
   * @returns {object[]} 最新的在前
   */
  function list(filter = {}) {
    const f = filter && typeof filter === "object" ? filter : {};
    const limit = Number.isFinite(f.limit) && f.limit > 0 ? Math.floor(f.limit) : 50;
    const since = asNum(f.since);
    const until = asNum(f.until);
    const out = [];
    for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
      const r = records[i];
      if (f.provider && r.provider !== f.provider) continue;
      if (f.agent && r.agent !== f.agent) continue;
      if (f.model && r.model !== f.model) continue;
      if (f.outcome && r.outcome !== f.outcome) continue;
      if (f.kind && r.kind !== f.kind) continue;
      // 时间未知（ts=0）的记录：一旦给了时间边界就不要它 ——
      // 拿一个不知道时刻的记录去回答「这十分钟里发生了什么」是骗人。
      if ((since > 0 || until > 0) && r.ts === 0) continue;
      if (since > 0 && r.ts < since) continue;
      if (until > 0 && r.ts > until) continue;
      out.push(r);
    }
    return out;
  }

  /** 最近的 n 条，最新的在前。 */
  function recent(n = 10) {
    const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
    return list({ limit: count });
  }

  /**
   * 汇总。
   *
   * 形状照 magpie 的 maskrec/summary.go（按维度分组 + 每组的次数），
   * 但统计的是**请求**而不是被遮掉的值。
   */
  function summary(filter = {}) {
    const rows = list({ ...filter, limit: Number.MAX_SAFE_INTEGER });
    const byProvider = new Map();
    const byKind = new Map();
    const byAgent = new Map();
    const byModel = new Map();
    let total = 0;
    let ok = 0;
    let failed = 0;
    let handedOn = 0;
    let msSum = 0;
    let msMax = 0;
    let msMin = Infinity;
    const times = [];

    for (const r of rows) {
      total++;
      if (r.outcome === "ok") ok++;
      else failed++;
      if (r.handedOn) handedOn++;
      if (r.ms > 0) {
        msSum += r.ms;
        times.push(r.ms);
        if (r.ms > msMax) msMax = r.ms;
        if (r.ms < msMin) msMin = r.ms;
      }
      bump(byProvider, r.provider, r);
      bump(byKind, r.kind, r);
      bump(byAgent, r.agent, r);
      bump(byModel, r.model, r);
    }

    times.sort((a, b) => a - b);
    const pct = (p) =>
      times.length ? times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] : 0;
    // 桶里的累加字段（msSum 之类）只是算 avgMs 的中间量，不该出现在给面板看的结果里
    const ranked = (m) =>
      [...m.values()]
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
        .map((b) => ({
          name: b.name,
          total: b.total,
          ok: b.ok,
          failed: b.failed,
          avgMs: b.avgMs,
          maxMs: b.msMax,
        }));

    return {
      total,
      ok,
      failed,
      handedOn,
      avgMs: times.length ? Math.round(msSum / times.length) : 0,
      minMs: times.length ? msMin : 0,
      maxMs: times.length ? msMax : 0,
      p50Ms: pct(50),
      p95Ms: pct(95),
      since: rows.length ? rows[rows.length - 1].ts : 0,
      until: rows.length ? rows[0].ts : 0,
      byProvider: ranked(byProvider),
      byKind: ranked(byKind),
      byAgent: ranked(byAgent),
      byModel: ranked(byModel),
    };
  }

  function clear() {
    records.length = 0;
  }

  return {
    record,
    list,
    recent,
    summary,
    clear,
    get size() {
      return records.length;
    },
    get max() {
      return max;
    },
  };
}

/**
 * 把一条记录归到一个维度桶里。
 *
 * 「空名字」不单独成桶 —— 那是一条没说是谁的记录，混进统计里只会稀释。
 * 但它仍然计入 total。
 */
function bump(map, name, rec) {
  const key = name || "";
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { name: key, total: 0, ok: 0, failed: 0, msSum: 0, msCount: 0, msMax: 0, avgMs: 0 };
    map.set(key, bucket);
  }
  bucket.total++;
  if (rec.outcome === "ok") bucket.ok++;
  else bucket.failed++;
  if (rec.ms > 0) {
    bucket.msSum += rec.ms;
    bucket.msCount++;
    if (rec.ms > bucket.msMax) bucket.msMax = rec.ms;
  }
  bucket.avgMs = bucket.msCount ? Math.round(bucket.msSum / bucket.msCount) : 0;
}
