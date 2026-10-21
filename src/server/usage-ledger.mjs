/**
 * usage-ledger.mjs —— 用量账本（JSONL 追加日志）
 *
 * 移植自 yetone/magpie 的 internal/usage（Go）：
 *   - internal/usage/usage.go  的 Record / Append / Load
 *   - internal/usage/ledger.go 的 CSVHeader
 *
 * ── 这个模块只做「账本」本身 ────────────────────────────────────────
 *
 * 账本是「一次调用一行」的追加日志。写进来的和读出去的是同一件事：
 * 谁（agent）、去了哪个 provider、问了什么模型、厂商答了什么、token 多少、
 * 怎么结束的（成功 / 失败 / 转交下一候选）。
 *
 * 定价、窗口用量估算、面板展示**本轮不做**（Go 那边在 catalog.Pricer、
 * usage.Summarize、usage.Breakdown 和 GUI 里，依赖价格表与 settings）。
 * 这里只把地基铺好：字段的含义、写入的原子性、读时的容错。
 *
 * ── 三条必须原样保住的 magpie 设计（照抄，不许动）────────────────────
 *
 * ① **req vs served** —— `req` 是 agent 问的模型（可能是一个别名、一个路由组、
 *    一个 provider/model），`served` 是厂商回复里说「实际答了」的模型。
 *    两者**常常不同**：厂商的账单按 served 对，agent 以为自己订的是 req。
 *    合成一个字段 = 账单对不上，而且事后无从查证。
 *    （Go: usage.Record.Requested / .Served，注释原话 "a ledger to set beside
 *    the vendor's own bill"）
 *
 * ② **tier_asked / tier_sent / tier_served 三段** —— 客户端要的档次、发出去时
 *    实际用的档次、厂商回复里说它跑的档次，是三件不同的事。
 *    ★ `tier_served` **只从回复取**，绝不能从 tier_asked/tier_sent 猜：
 *    请求里要了 priority 而厂商降级跑了 default，这是要看见的事；猜出来就看不见了。
 *    （Go: usage.go 里 tier_served 的注释，#1784）
 *
 * ③ **handed_on** —— 一次请求在网关内部试了多个候选。某个 try 失败了、被转交给
 *    下一个候选时，它**仍然写自己的记录**（它可能已经被厂商计费了：记它计费了
 *    什么、为什么失败），但它**不是这个请求的结果**，所以**不计入失败数**。
 *    「一个请求 = 一条记录，按它怎么结束只数一次」的落地就在这个字段上。
 *    （Go: usage.Record.HandedOn；Totals.count 里 `if r.HandedOn { return }`；
 *    LostRequest() = Failed() && !HandedOn）
 *
 * ── 两条「不许出错」的规矩 ─────────────────────────────────────────
 *
 * ① **Append 吞掉错误：accounting must never break a call.**
 *    账本写不进去（磁盘满、目录没了、权限不对）**绝不能**让一次本来成功的模型
 *    调用失败。所以 appendRecord 不抛异常，只返回 { ok:false, error }——
 *    调用方可以完全不看返回值，调用照样成功。
 *    （Go: usage.go 的 Append 注释原话 "Errors are swallowed: accounting must
 *    never break a call."）
 *
 * ② **读时跳过坏行，而不是让整份账本作废。**
 *    这跟 settings 的规矩**恰好相反**，而且是有意的：
 *    settings 读不出来是「不知道」，把它当「空」会把用户其余配置一起抹掉，
 *    所以那边宁可中止也不猜；
 *    账本这边读不出来的是**一行**，不是整份文件，而且**末尾半行是常态**
 *    （别的进程正写到它一半）。一行坏掉不影响其它行——为它把整份账本作废，
 *    丢的是用户全部用量历史，换来的只是「让调用方重试」。
 *    所以：坏行只跳过那一行；整份文件读不出来（文件不存在）返回空列表，
 *    那不是「猜」，是「账本还没有，调用还没发生过」的事实。
 *
 * ── 路径由参数注入 ─────────────────────────────────────────────────
 *
 * 本模块不知道账本在哪：目录由调用方给（<dir>/usage.jsonl）。
 * 不硬编码任何 ~/.config/... 之类的位置，也不替调用方建目录——
 * 一个本该报错的路径被悄悄建出来，「账本写不进去」就从 ok:false 变成 ok:true，
 * 而那个目录里别的配置照样缺。这个模块只管账本，不管目录。
 */
import fs from "node:fs";
import path from "node:path";

/** 账本文件名：<dir>/usage.jsonl。目录由调用方给，我们不替它建。 */
const LEDGER_FILE = "usage.jsonl";

/**
 * 字段表：[json 名, 类型, csv 列名]。
 *
 * 顺序 = csvHeader() 的顺序 = 写进 JSONL 的键序，**稳定**：
 * 账本是拿去跟厂商的账单并排看的，列序一改，两份文件就没法对齐着看。
 *
 * 类型决定缺省值：字符串 ""、数字 0、布尔 false、时间取现在。
 * 缺省值**明确**（没有一个字段是 undefined）：Go 那边靠 `omitempty` 让空值不出
 * 现在文件里，那是因为 Go 的零值天然如此；JS 里没有这个默认，字段缺了就是
 * undefined，JSON.stringify 会把它整个丢掉——读回来就少一个键，往返不再相等。
 * 这里反过来：所有字段都写出来，写进去的每一行都是自描述的。
 *
 * csv 列名沿用 magpie 的 ledger.go 里那套（requested_model / input_tokens …），
 * 因为 CSV 是给人看的、要跟厂商账单对齐；JSONL 的键名保持 Go 的 json tag。
 *
 * 两处**有意**的出入（记在这里，免得日后有人以为是抄漏了）：
 *   - 错误文本的 json 名这里是 `error`，Go 那边是 `err`。本模块的字段名以
 *     bai-router 自己定的那张表为准，不改调用方的用法。
 *   - CSV 的 `error` 列装的是**错误文本**。Go 那边同名的那一列装的是「这次调用
 *     是不是失败了」的 true/false（错误文本另有一列 error_message）——那是 Go
 *     那边的列名安排，容易看岔；这里一列一义，不沿用那个歧义。
 */
const FIELDS = [
  ["t", "time", "time"],
  ["agent", "string", "agent"],
  ["provider", "string", "provider"],
  ["host", "string", "host"],
  ["providerKeyId", "string", "provider_key_id"],
  ["providerKeyName", "string", "provider_key_name"],
  ["providerAccount", "string", "provider_account"],
  ["callerKeyId", "string", "caller_key_id"],
  ["callerKeyName", "string", "caller_key_name"],
  ["session_provider", "string", "session_provider"],
  ["session_account", "string", "session_account"],
  ["session_official_login", "bool", "session_official_login"],
  ["model", "string", "model"],
  ["req", "string", "requested_model"], // ① agent 问的
  ["served", "string", "served_model"], // ① 厂商说答的；**不从 req 推**
  ["upstream", "string", "upstream"],
  ["in", "number", "input_tokens"],
  ["out", "number", "output_tokens"],
  ["cache_read", "number", "cache_read_tokens"],
  ["cache_write", "number", "cache_write_tokens"],
  ["cache_write_1h", "number", "cache_write_1h_tokens"],
  ["reasoning", "number", "reasoning_tokens"],
  ["effort", "string", "effort"],
  ["tier_asked", "string", "tier_asked"], // ② 三段，别合成一段
  ["tier_sent", "string", "tier_sent"],
  ["tier_served", "string", "tier_served"], // ② 只从回复取
  ["status", "number", "status"],
  ["error", "string", "error"],
  ["tries", "number", "tries"],
  ["ms", "number", "duration_ms"],
  ["ttft_ms", "number", "ttft_ms"],
  ["source", "string", "source"],
  ["kind", "string", "kind"],
  ["rejected", "bool", "rejected"],
  ["handed_on", "bool", "handed_on"], // ③ 转交了下一候选：仍写自己的记录，但不算失败
];

/**
 * 值的归一：把传进来的东西变成该类型的确定值。
 * 数字收不住（NaN、Infinity、字符串 "abc"）就落回 0 —— 账本里的数字要能求和，
 * 一个 NaN 会把整张表变成 NaN。
 */
function coerce(kind, v) {
  switch (kind) {
    case "number": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    case "bool": {
      if (typeof v === "boolean") return v;
      if (typeof v === "string") return v === "true" || v === "1";
      return Boolean(v);
    }
    case "string": {
      if (v == null) return "";
      return typeof v === "string" ? v : String(v);
    }
    default:
      return "";
  }
}

/**
 * 时间的归一。
 *
 * 接受的写法：ISO 字符串（原样保留，往返不丢格式）、epoch 毫秒数字。
 * 缺省时取 nowMs；nowMs = 0 表示「不给，缺省就是不知道」——读账本时用这个，
 * 因为一条没有时间的记录属于「时间未知」，把它补成「现在」等于凭空造了一次
 * 刚刚发生的调用，还会让 since 过滤把它放进来。
 */
function normalizeTime(v, nowMs) {
  if (v == null || v === "" || v === 0) {
    return nowMs > 0 ? new Date(nowMs).toISOString() : "";
  }
  if (typeof v === "number") {
    return Number.isFinite(v) ? new Date(v).toISOString() : "";
  }
  if (typeof v === "string") return v;
  return "";
}

/** 记录的时间戳（epoch ms）；缺坏一律 0（= 不知道）。 */
function timeMs(t) {
  if (typeof t === "number") return Number.isFinite(t) ? t : 0;
  const n = Date.parse(String(t ?? ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 按字段表拼出一条字段齐全的记录。
 * 多余的键（文件里有、这张表里没有的）直接丢掉——Go 的 encoding/json 也一样
 * （未知的键不报错，也进不了结构体），这样新版本写的字段不会把老版本读崩。
 */
function build(fields, nowMs) {
  const src = fields && typeof fields === "object" ? fields : {};
  const rec = {};
  for (const [name, kind] of FIELDS) {
    rec[name] = kind === "time" ? normalizeTime(src[name], nowMs) : coerce(kind, src[name]);
  }
  /* ★ tier_served 只从回复取，不从请求猜：任何从 tier_asked/tier_sent 的回填都是错的
     （Go: usage.go 里 tier_served 的注释，#1784）。这里刻意不做任何回填。 */
  return rec;
}

/**
 * 造一条字段齐全的记录。
 *
 * @param {object} [fields] 已有字段，缺的在表里按类型补缺省值
 * @returns {object} 全部字段都在、没有一个是 undefined 的记录
 */
export function makeRecord(fields) {
  return build(fields, Date.now());
}

/**
 * 追加一行到 <dir>/usage.jsonl。
 *
 * 写失败**不抛**：返回 { ok:false, error }。理由见文件头「不许出错的规矩 ①」
 * ——accounting must never break a call。调用方可以完全忽略返回值。
 *
 * 一次 write 一整行（O_APPEND + 单次 write）：POSIX 保证追加写的偏移更新与写入
 * 是原子的，所以另一个进程读到的永远是一整行，不会是半行。半行只可能来自
 * 写一半就断电的进程——那种行读的时候跳过就是（见 loadRecords）。
 *
 * @returns {{ok: boolean, error?: string}}
 */
export function appendRecord(dir, rec) {
  try {
    if (typeof dir !== "string" || dir === "") {
      return { ok: false, error: "账本目录不是一个路径" };
    }
    // build 一遍：字段补齐、t 缺省成现在（Go 的 Append 也是这样补的）
    const line = JSON.stringify(build(rec, Date.now())) + "\n";
    const fd = fs.openSync(path.join(dir, LEDGER_FILE), "a");
    try {
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true };
  } catch (e) {
    /* ★ 吞掉错误（Go: Append 的 "Errors are swallowed"）。
       账本写不进去绝不能让一次本来成功的模型调用失败，所以这里只有返回值，
       没有异常。 */
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 读回 <dir>/usage.jsonl 里的记录。
 *
 * 容错规矩（见文件头「不许出错的规矩 ②」）：
 *   - 坏行（不是合法 JSON、或者不是个对象）**只跳过那一行**，其余照读；
 *   - 末尾那一段（没有以换行收尾）也照样试着读：它是别的进程正写到一半时剩下的
 *     半截 JSON，多半解析不了，解析不了就当坏行跳过；万一它已经是完整的，
 *     就当它写完了——我们宁可多读一条完整记录，也不因为少一个换行就丢掉它。
 *     （Go 版 Load 用 ReadBytes('\n')，尾巴读不到就整个不读；这里放宽一档，
 *     因为本项目的账本只有一个写者，一行是一次 write 写完的，半截的尾巴必然
 *     解析不了，两种做法对真正的半行结果一致。）
 *   - 文件不存在 → 空列表：那不是「读不出来」，是「还没有任何调用过」。
 *
 * @param {string} dir 账本所在目录
 * @param {number} [sinceMs] 只取这一刻及之后的记录（含等于这一刻，Go 版同）；
 *                          不给/0 = 全取
 * @returns {object[]} 记录数组，按文件里的先后
 */
export function loadRecords(dir, sinceMs) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, LEDGER_FILE), "utf8");
  } catch {
    return [];
  }
  const since = Number.isFinite(sinceMs) && Number(sinceMs) > 0 ? Number(sinceMs) : 0;
  const out = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // 坏行：跳过它，其余照读
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue; // 解析得出来但不是一条记录（数字/字符串/数组）：同样是坏行
    }
    const rec = build(raw, 0); // 读的时候不给「现在」这个缺省
    if (since > 0 && timeMs(rec.t) < since) continue;
    out.push(rec);
  }
  return out;
}

/**
 * CSV 表头（稳定顺序）。
 *
 * 列名沿用 magpie ledger.go 的 CSVHeader：账本是给人看的、要跟厂商账单并排，
 * 列序和列名都别自己发明。magpie 那张表里有的列（cost_usd、session、
 * route_id、swapped…）属于定价/会话/路由追踪，本轮不做，故不在这里。
 */
export function csvHeader() {
  return FIELDS.map(([, , csv]) => csv);
}

/** 一个 CSV 单元格的转义：含逗号/引号/换行的要加引号，引号翻倍。 */
function csvCell(v) {
  const s = typeof v === "boolean" ? (v ? "true" : "false") : String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 把一条记录写成一行 CSV（不含换行符），列数与列序与 csvHeader() 一致。
 * 字段缺了按缺省值补（跟 makeRecord 同一套规矩），所以列数永远是齐的。
 */
export function toCsvRow(rec) {
  const r = build(rec, Date.now());
  return FIELDS.map(([name]) => csvCell(r[name])).join(",");
}

/**
 * 调用被分开的维度（Go: usage.Dimensions，顺序照抄）。
 *   - provider：去了哪个 provider
 *   - agent：哪个 agent 发的
 *   - model：模型 id
 *   - modelAt：模型在哪个 provider 上（"provider/model"，Go: ModelAtKey）——
 *     同一个模型在不同 provider 上的速度与价格是可以比的，所以单列一个维度
 *   - callerKey：调用方带的网关 key（Go: callerKey；没带 key 的调用在 Go 里算 "none"）
 *
 * 本轮只把这份词汇表定下来；按维度分组求和（Go: Breakdown）属于「展示」，
 * 与定价、面板一起往后放。**不要改这个数组的顺序** —— 顺序进了持久化的东西。
 */
export const DIMENSIONS = ["provider", "agent", "model", "modelAt", "callerKey"];
