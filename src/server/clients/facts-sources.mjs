// src/server/clients/facts-sources.mjs —— **渠道目录接口作真源**（阶段 3）
//
// ## 这个模块补的是哪个洞
//
// `clients/model-facts.mjs` 的表是**人工核对**的快照 —— 上游改了窗口，表就过时。
// 离我们最近的真源是**渠道自己说的**：
//
//   · **wb / wbai** —— `GET {upstream}/v3/config`，模型对象带
//     `maxInputTokens` / `maxOutputTokens`（**驼峰**）。
//     ⚠ 实测 2026-10-23：UA 才是闸门（非 CLI 形态回 400 code=12403）；
//     ⚠ **落盘缓存里没有这两个字段**（本仓 `wbMapModel` 用它们做过滤却没存）
//       ⇒ 只能从**原始响应**拿。
//   · **qd** —— 补丁落盘的 `qoder-models.json` 的 `app[]`，带 `max_input_tokens`
//     （**蛇形**），**没有**输出上限。
//
// 拉得到就**覆盖表里的值并更新日期戳**；拉不到就用表里的。
//
// ## ⚠ 纪律：拉取**不许**成为关键路径的阻塞
//
//   · 每一个拉取函数都**返回 `{ ok: false, error }` 而不是抛** ——
//     调用方永远拿得到一个可用的表。
//   · 有超时（默认 8 秒），超时就是「拉不到」，不是「卡住」。
//   · 一个渠道失败**不影响**其它渠道（`collectCatalogs` 逐个来）。
//   · 空目录（上游回 200 但 `models:null`）算**失败** —— 上游的空目录陷阱。
//
// ## magpie 的对应
//
//   · `internal/agent/workbuddy.go:314-341`（`buddyModel`）：从渠道目录的
//     `maxInputTokens`/`maxOutputTokens` 取真值；`context == 0` ⇒ 兜底 200000；
//     **输出上限不知道就不写那个键**。
//   · `internal/catalog/catalog.go:421-431`（`LeastWindow` / `Window`）：
//     小于最小可信窗口的值**当不知道**。
//
// ## 纪律
//
//   · 纯 ESM、零第三方依赖（只用 node 内置的 fetch / fs）。
//   · **凭据不进任何文件**：令牌只在内存里用，只进 `Authorization` 头；
//     错误消息里绝不回显令牌。
//   · 合并是**纯函数**（不改传进来的表）。

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";

/**
 * 拉取超时（毫秒）。
 *
 * ⚠ 8 秒是「接线时用户还愿意等」的上限 —— 拉取是**辅助**，不是必经之路。
 */
export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * WorkBuddy 目录接口要 CLI 形态的 UA —— **UA 才是闸门**（实测 2026-10-23：
 * 非 CLI 形态上游回 400 `{"code":12403,"msg":"check ua, get coding copilot version error"}`）。
 *
 * ⚠ 这是一份**快照**：上游将来认新版本，形态就得跟着改。与 `server.mjs` 的
 *   `WB_UA_CLI` 同一份常量（那边是本仓的出处；这里复制一份是为了让这个模块
 *   **不 import server.mjs** —— server.mjs 是中转热路径，import 它会拉起整个服务）。
 */
const WB_UA_CLI = "CLI/2.63.2 CodeBuddy/2.63.2";

/** 目录接口的路径（WorkBuddy 独有）。 */
const WB_CONFIG_PATH = "/v3/config";

/**
 * windowOf —— 一个数是不是可信的窗口值（抄 magpie 的 `Window(n)`）。
 *
 * @param {unknown} n
 * @returns {number} 可信就取整后的值；不可信 ⇒ 0（不知道）
 */
function windowOf(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 2048) return 0;
  return Math.round(v);
}

/**
 * nowIso —— 现在的时刻（ISO）。**可注入**，测试里好定住。
 *
 * @param {string} [at]
 * @returns {string}
 */
function nowIso(at) {
  if (typeof at === "string" && at.trim()) return at.trim();
  return new Date().toISOString();
}

/**
 * fetchWbCatalog —— 拉一个 WorkBuddy 渠道的模型目录（只取窗口与输出上限）。
 *
 * ⚠ **失败安静**：返回 `{ ok: false, error }`，**不抛**。
 * ⚠ **凭据只进头**：令牌不出现在 URL、错误消息或返回值里。
 *
 * @param {object} o
 * @param {string} o.upstream 渠道上游（https://www.workbuddy.cn）
 * @param {string} o.token 访问令牌（Bearer）
 * @param {string} [o.ua] User-Agent（默认 CLI 形态）
 * @param {Function} [o.fetchImpl] 注入的 fetch（测试用）
 * @param {number} [o.timeoutMs] 超时
 * @param {string} [o.at] 时间戳（注入用）
 * @returns {Promise<{ok:boolean, entries?:Array<{id:string,context:number,output:number}>, at?:string, source?:string, error?:string}>}
 */
export async function fetchWbCatalog(o) {
  const opt = o && typeof o === "object" ? o : {};
  const upstream = String(opt.upstream || "").trim().replace(/\/+$/, "");
  const token = String(opt.token || "").trim();
  const at = nowIso(opt.at);
  const source = `${upstream || "(无 upstream)"}${WB_CONFIG_PATH}`;
  if (!upstream) return { ok: false, error: "没有渠道上游地址，跳过目录抓取", at, source };
  if (!token) return { ok: false, error: "没有访问令牌，跳过目录抓取", at, source };

  const doFetch = typeof opt.fetchImpl === "function" ? opt.fetchImpl : globalThis.fetch;
  if (typeof doFetch !== "function") return { ok: false, error: "这个运行环境没有 fetch", at, source };

  const url = upstream + WB_CONFIG_PATH;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "user-agent": String(opt.ua || "").trim() || WB_UA_CLI,
    origin: upstream,
    referer: `${upstream}/`,
  };

  let r, txt;
  try {
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(Number(opt.timeoutMs) > 0 ? Number(opt.timeoutMs) : DEFAULT_TIMEOUT_MS)
      : undefined;
    r = await doFetch(url, { headers, ...(signal ? { signal } : {}) });
    txt = await r.text();
  } catch (e) {
    /* ⚠ 错误消息里不许有令牌 —— 这里的 e.message 不含 URL 的头。 */
    return { ok: false, error: `请求目录失败：${String((e && e.message) || e).slice(0, 120)}`, at, source };
  }

  let j = null;
  try { j = JSON.parse(txt); } catch { /* 非 JSON —— 下面统一归因 */ }
  if (!j || typeof j !== "object") {
    return { ok: false, error: `上游返回的不是合法 JSON（HTTP ${r.status}）`, at, source };
  }
  /* 上游用自己的 code 报错（12403 = UA 不对），HTTP 状态可能仍是 200。 */
  if (r.status >= 400 || (typeof j.code === "number" && j.code !== 0)) {
    const said = String((j && (j.msg || j.message)) || "").slice(0, 120);
    return { ok: false, error: `上游报错（HTTP ${r.status}${said ? `，${said}` : ""}）`, at, source };
  }

  const models = (j.data && j.data.models) || j.models;
  if (!Array.isArray(models) || !models.length) {
    /* ⚠ 空目录陷阱：坏令牌时上游回 200 + `{"data":{"models":null}}` —— 成功码配空数据，
     * **必须当失败**（否则会把「没有目录」写成「目录是空的，把表清空」）。 */
    return { ok: false, error: "上游回了空目录（成功码但没有模型）", at, source };
  }

  const entries = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const id = String(m.id || "").trim();
    if (!id) continue;
    const context = windowOf(m.maxInputTokens);
    const output = windowOf(m.maxOutputTokens);
    /* 两个都不可信 ⇒ 这一条对我们没用（但目录本身是好的）⇒ 不进 entries。 */
    if (!context && !output) continue;
    entries.push({ id, context, output });
  }
  if (!entries.length) {
    return { ok: false, error: "目录里没有一条带可信窗口值的模型", at, source };
  }
  return { ok: true, entries, at, source };
}

/**
 * readQdCatalog —— 读 Qoder 客户端写的模型目录（`qoder-models.json`）。
 *
 * ⚠ 这是**本地文件**，不是网络接口 —— Qoder 客户端把它写在**数据目录**下（补丁落点），
 *   本仓只是去读。文件不在 / 读不了 / 形状不对 ⇒ `{ ok: false }`（安静）。
 *
 * ⚠ 目录里**只有输入窗口**（`max_input_tokens`），没有输出上限 ⇒
 *   `output` 一律 0（= 不知道）。
 *
 * @param {object} o
 * @param {string} o.file 文件路径
 * @param {string} [o.at] 时间戳（注入用）
 * @returns {Promise<{ok:boolean, entries?:Array<{id:string,context:number,output:number}>, at?:string, source?:string, error?:string}>}
 */
export async function readQdCatalog(o) {
  const opt = o && typeof o === "object" ? o : {};
  const file = String(opt.file || "").trim();
  const at = nowIso(opt.at);
  const source = file || "(无文件路径)";
  if (!file) return { ok: false, error: "没有目录文件路径", at, source };

  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    return { ok: false, error: `读不到目录文件：${String((e && e.code) || e).slice(0, 80)}`, at, source };
  }
  let j = null;
  try { j = JSON.parse(raw); } catch { /* 非 JSON */ }
  const list = j && Array.isArray(j.app) ? j.app : [];
  if (!list.length) return { ok: false, error: "目录里没有 app[] 数组", at, source };

  const entries = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const id = String(m.key || "").trim();
    if (!id) continue;
    const context = windowOf(m.max_input_tokens);
    if (!context) continue;
    /* ⚠ Qoder 目录没有输出上限 ⇒ output = 0（不知道），由调用方决定兜底。 */
    entries.push({ id, context, output: 0 });
  }
  if (!entries.length) return { ok: false, error: "目录里没有一条带可信窗口值的模型", at, source };
  return { ok: true, entries, at, source };
}

/**
 * mergeCatalogFacts —— 把一个渠道目录**覆盖**到事实表上（并更新日期戳）。
 *
 * ⚠ **纯函数**：不改传进来的表，返回**新表**。
 * ⚠ 覆盖的匹配键是 **`渠道 + 渠道目录里的 id`**（`sourceId`）——
 *   因为我们的键里是**最终模型名**，而渠道目录里的 id 可能带后缀
 *   （`hy4-preview` vs 我们的 `hy4-preview-f`）⇒ 靠 `sourceId` 对上号。
 * ⚠ **对不上的就新增**一条 `渠道/目录id` —— 渠道目录里有我们表里没有的模型时，
 *   它也该进得来（kind: measured）。
 * ⚠ 目录里没有的模型**留在表里不动**（拉取是补充，不是清仓）。
 *
 * @param {object} facts 事实表（`{ "渠道/模型": ModelFact }`）
 * @param {object} catalog `{ provider, entries, at, source }`
 * @returns {object} 新的事实表
 */
export function mergeCatalogFacts(facts, catalog) {
  const base = facts && typeof facts === "object" ? facts : {};
  const cat = catalog && typeof catalog === "object" ? catalog : {};
  const provider = String(cat.provider || "").trim();
  const entries = Array.isArray(cat.entries) ? cat.entries : [];
  if (!provider || !entries.length) return { ...base };

  const at = nowIso(cat.at);
  const source = String(cat.source || provider);
  const out = { ...base };

  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const id = String(e.id || "").trim();
    if (!id) continue;
    const context = windowOf(e.context);
    const output = windowOf(e.output);

    /* 找表里已经写着「我这个渠道的目录里它叫 id」的那些条。
     * ⚠ **可能不止一条**：同一个模型在同一个渠道里可能有两个键
     *   （`wbai/hy4-preview` 与 `wbai/hy4-preview-f` —— 出厂快照用带后缀的、
     *   用户配置用不带后缀的，而它们指的是**同一个模型**）⇒ 都要更新，
     *   否则先命中的那条更新了、另一条留在旧值上。 */
    const hits = [];
    for (const k of Object.keys(out)) {
      const f = out[k];
      if (!f || typeof f !== "object") continue;
      if (!k.startsWith(provider + "/")) continue;
      if (String(f.sourceId || "") === id) hits.push(k);
    }
    /* 一个都没对上 ⇒ 新增一条（键就是渠道目录里的 id —— 那也是最终模型名）。 */
    if (!hits.length) hits.push(`${provider}/${id}`);

    for (const key of hits) {
      const prev = out[key] && typeof out[key] === "object" ? out[key] : {};
      out[key] = {
        ...prev,
        context: context || 0,
        output: output || 0,
        kind: "measured",
        source,
        sourceId: id,
        at,
        note: prev.note || "",
      };
    }
  }
  return out;
}

/**
 * loadFacts —— 读**运行时覆盖层**（渠道目录拉下来的那份事实表）。
 *
 * ⚠ 读不到 / 读坏了 ⇒ **返回 null**（安静）—— 调用方就当「没有覆盖层」，
 *   用内置表。**绝不**把坏文件当空表（那会把已知的事实全丢掉）。
 *
 * ⚠ 这个文件里**只有窗口值与来源** ⇒ **没有凭据**（这是它能落盘的前提）。
 *
 * ⚠ **`baseAt` 不一致 ⇒ 覆盖层作废**（返回 null）：
 *   落盘时记下了「这份覆盖层是**哪一版内置表**的补丁」（`baseAt`）。
 *   人改了源码里的内置表（日期戳变了）⇒ 磁盘上那份覆盖层是**旧表**的补丁，
 *   它的模型集合可能已经对不上 ⇒ 宁可用新的内置表。
 *
 * @param {string} file 文件路径
 * @param {object} [opts] · baseAt —— **当前内置表的日期戳**（`model-facts.mjs`
 *   的 `OUTLET_TIERS_AT`）⇒ 给了就做「同批才用」的校验
 * @returns {Promise<object|null>} `{ "渠道/模型": ModelFact }` 或 null
 */
export async function loadFacts(file, opts) {
  const f = String(file || "").trim();
  if (!f) return null;
  const o = opts && typeof opts === "object" ? opts : {};
  let raw;
  try {
    raw = await readFile(f, "utf8");
  } catch {
    return null;
  }
  let j = null;
  try { j = JSON.parse(raw); } catch { return null; }
  const facts = j && typeof j === "object" && j.facts && typeof j.facts === "object" ? j.facts : null;
  if (!facts) return null;
  /* ⚠ 覆盖层是**哪一版内置表**的补丁 —— 对不上就作废。 */
  const wantBase = String(o.baseAt || "").trim();
  if (wantBase) {
    const gotBase = String((j && j.baseAt) || "").trim();
    if (gotBase !== wantBase) return null;
  }
  /* 只留形状对的条目 —— 坏条目比没有条目更危险。 */
  const out = {};
  for (const [k, v] of Object.entries(facts)) {
    if (!v || typeof v !== "object") continue;
    if (!Number.isFinite(Number(v.context)) && !Number.isFinite(Number(v.output))) continue;
    out[k] = { ...v };
  }
  return out;
}

/**
 * saveFacts —— 把**运行时覆盖层**落盘（原子写）。
 *
 * ⚠ 落盘的是**渠道目录拉下来的窗口值与来源** —— **没有凭据**。
 * ⚠ **原子写**：先写同目录的临时文件再改名 ⇒ 断电/崩溃不会留下半份文件
 *   （半份 JSON 会让下次 `loadFacts` 读成 null ⇒ 覆盖层整个消失）。
 * ⚠ 失败**不抛**（返回 `{ ok:false }`）—— 落盘是辅助，失败不该带倒主流程。
 *
 * @param {string} file 文件路径
 * @param {object} facts `{ "渠道/模型": ModelFact }`
 * @param {object} [opts] · at —— 写进去的时间戳；· baseAt —— **当前内置表的日期戳**
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function saveFacts(file, facts, opts) {
  const f = String(file || "").trim();
  if (!f) return { ok: false, error: "没有文件路径" };
  const o = opts && typeof opts === "object" ? opts : {};
  const body = {
    /* 落盘的东西自己说明白：这是**运行时覆盖层**，不是源码里的内置表。 */
    note: "运行时覆盖层：渠道目录拉下来的窗口值与来源（由 facts-sources.mjs 写）。"
      + "内置表在 src/server/clients/model-facts.mjs。",
    at: nowIso(o.at),
    /* 这一版覆盖层是**哪一版内置表**的补丁 ⇒ 内置表一改，旧覆盖层自动作废。 */
    baseAt: String(o.baseAt || "").trim(),
    facts: facts && typeof facts === "object" ? facts : {},
  };
  try {
    await mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(body, null, 2), "utf8");
    await rename(tmp, f);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 140) };
  }
}

/**
 * collectCatalogs —— 按 cfg 把各家的目录拉一遍（**逐个来，一个失败不影响别的**）。
 *
 * ⚠ 这一步**有网络**（wb / wbai）与**文件读**（qd）—— 所以它**不在**关键路径上：
 *   调用方应当「先按内置表把活干完，再顺手刷新一次表」。
 *
 * @param {object} o
 * @param {object} o.cfg 配置（取 wb/wbai 的 upstream + 令牌、qd 的 modelsFile）
 * @param {Function} [o.fetchImpl] 注入的 fetch
 * @param {number} [o.timeoutMs]
 * @param {string} [o.at] 时间戳（注入用）
 * @returns {Promise<{catalogs:Array<object>, errors:Array<{provider:string,error:string}>}>}
 */
export async function collectCatalogs(o) {
  const opt = o && typeof o === "object" ? o : {};
  const cfg = opt.cfg && typeof opt.cfg === "object" ? opt.cfg : {};
  const catalogs = [];
  const errors = [];

  for (const provider of ["wb", "wbai"]) {
    const s = cfg[provider] && typeof cfg[provider] === "object" ? cfg[provider] : {};
    const r = await fetchWbCatalog({
      upstream: s.upstream,
      token: s.accessToken,
      fetchImpl: opt.fetchImpl,
      timeoutMs: opt.timeoutMs,
      at: opt.at,
    });
    if (r.ok) catalogs.push({ provider, entries: r.entries, at: r.at, source: r.source });
    else errors.push({ provider, error: r.error });
  }

  {
    const s = cfg.qd && typeof cfg.qd === "object" ? cfg.qd : {};
    const r = await readQdCatalog({ file: s.modelsFile, at: opt.at });
    if (r.ok) catalogs.push({ provider: "qd", entries: r.entries, at: r.at, source: r.source });
    else errors.push({ provider: "qd", error: r.error });
  }

  return { catalogs, errors };
}
