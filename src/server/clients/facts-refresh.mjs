// src/server/clients/facts-refresh.mjs —— **模型真值表的后台刷表**（阶段 3）
//
// ## 这个模块补的是哪个洞
//
// `clients/model-facts.mjs` 的内置表是**源码里的常量** ⇒ 上游改了窗口，它就过时。
// `clients/facts-sources.mjs` 已经能拉渠道目录（wb/wbai 的 `/v3/config`、qd 的
// `qoder-models.json`）并落成**运行时覆盖层** —— 但**没有任何生产代码在调用它**。
// 本模块把那条链补齐：**拉 → 合并 → 落盘（原子写）→ 安静退回去**。
//
// ## ⚠ 进程边界（本模块最重要的一条纪律）
//
// 刷表跑在**独立进程**里 —— **不是** `server.mjs` 的定时器，**也不是**它的启动路径。
// 理由：
//
//   · `server.mjs` 是**中转热路径** —— 在那儿加定时器/网络请求 = 给每次请求加负担。
//   · 刷表要发网络请求、可能失败 ⇒ 放在同一个进程里就是给热路径多一件可能出错的事。
//   · 独立进程失败 ⇒ 只影响那一个进程；网关**照常服务**
//     （用内置表，或用上一次落盘的覆盖层）。
//
// ⇒ 因此 **`server.mjs` 只读内存里的覆盖层**：启动时 `loadFacts` 读一次（一次 IO），
//   请求路径**零 IO、零 await**。
//
// ## ⚠ 落盘的是什么
//
// `<数据目录>/model-facts.json` —— **只有窗口值与来源**
// （context / output / kind / source / at）⇒ **没有凭据**。
// 写之前还有一道**凭据守卫**（`refreshFacts` 里那道）：落盘内容里一旦出现
// 令牌字样 ⇒ **拒绝写**（宁可不刷，也不要把凭据写进文件）。
//
// ## ⚠ 失败怎么退（逐条 —— 拉取失败**不许**让客户端接不上）
//
// | 失败 | 退路 |
// | --- | --- |
// | 某家目录拉不到（网络 / 令牌 / 上游挂了） | `collectCatalogs` **逐个**来 ⇒ 那家**不写**、其余照写 |
// | 全都拉不到 | `catalogs.length === 0` ⇒ **不写文件** ⇒ 用上一次的覆盖层，没有就用内置表 |
// | 落盘失败 | `saveFacts` 返回 `{ok:false}`（**不抛**）⇒ 旧覆盖层原样留着 |
// | 覆盖层里混进了凭据 | **拒绝写** ⇒ 同上 |
// | 磁盘上的覆盖层是坏文件 | `loadFacts` 返回 **null**（不是空表）⇒ 用内置表 |
//
// ## ⚠ 触发方式（负责人定，本模块只提供「跑一次」的能力）
//
// 设计定的是「独立进程」，**触发方式待定**（计划任务？手动？开机自启？）。
// ⇒ 本模块提供的是**跑一次就退**的命令行入口：
//
//   ```bash
//   node src/server/clients/facts-refresh.mjs        # 开发/绿色模式
//   ```
//
// 安装版（用户数据在 %APPDATA%\bai-router，脚本在 resources/server/clients/）：
//
//   ```bash
//   set ELECTRON_RUN_AS_NODE=1
//   "…\B.AI Router.exe" "…\resources\server\clients\facts-refresh.mjs"
//   ```
//
// ⚠ **不要自己加面板入口**（那要改 `cards/`，且要决定按钮放哪）。
//
// ## 纪律
//
//   · 纯 ESM、零第三方依赖（只用 node 内置的 fs / path / url）。
//   · **凭据不进任何文件**（落盘前有守卫）。
//   · 失败**安静**：不抛、不改别人的文件、不半份文件。
//   · 本模块**不被 `server.mjs` import** —— 它要发网络请求，热路径不该带上它。

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODEL_FACTS, OUTLET_TIERS_AT } from "./model-facts.mjs";
import { collectCatalogs, mergeCatalogFacts, saveFacts } from "./facts-sources.mjs";

/** 覆盖层在数据目录下的**文件名**（`server.mjs` 的 `DATA_DIR` 里）。 */
export const MODEL_FACTS_FILE_NAME = "model-facts.json";

/**
 * server 目录（`server.mjs` 所在的那一层）。
 *
 * ⚠ **为什么不是本文件所在的目录**：本模块在 `clients/` 里，而 `server.mjs` 的
 *   `HERE`（也就是它 `DATA_DIR` 的兜底）是**上一层**。
 *   ⚠ 开发/绿色模式：`src/server`；安装版：`resources/server` —— 两处布局一致。
 */
function defaultServerDir() {
  try {
    return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    return "";
  }
}

/**
 * resolveDataDir —— 用户数据目录（**与 `server.mjs` 同口径**）。
 *
 * ⚠ **必须与 `server.mjs` 的 `DATA_DIR` 指向同一个地方**，否则刷新读的是
 *   一份配置、覆盖层写到另一个地方 ⇒ 刷了等于没刷。
 *   `server.mjs` 的口径是 `process.env.BAI_DATA_DIR || HERE`，
 *   但 **HERE 在开发模式与安装版不是同一个地方**：
 *   · 开发/绿色模式 ⇒ `HERE` = `src/server`（config.json 就在那儿）；
 *   · 安装版 ⇒ `BAI_DATA_DIR` 由 `src/main.js` 指到 `%APPDATA%\bai-router`，
 *     `resources/server/` 里**没有** config.json。
 *
 * ⇒ 这里的解析顺序（与上面两种情形都对得上）：
 *   ① `opts.dataDir`（测试与显式指定）；
 *   ② `BAI_DATA_DIR`（应用起进程时一定设了）；
 *   ③ `<server 目录>/config.json` 存在 ⇒ 用 server 目录（= server.mjs 的 HERE 兜底）；
 *   ④ `%APPDATA%/bai-router`（安装版的用户数据目录，与 `src/main.js` 的 DATA_DIR 同名）；
 *   ⑤ 都找不到 ⇒ server 目录（与 `server.mjs` 的最后兜底一致）。
 *
 * ⚠ **一个已知的边角**：开发模式下如果服务器**一次都没起过**
 *   （`src/server/config.json` 还没被种子文件生成），第 ③ 条不成立 ⇒
 *   刷表会去 `%APPDATA%/bai-router` 读配置，而开发中的服务器用的是 `src/server`。
 *   ⇒ **开发时给刷新进程带上 `BAI_DATA_DIR=src/server`**（或等服务器起过一次）就一致了。
 *   ⚠ 安装版没有这个问题（`resources/server/` 里**永远没有** config.json）。
 *
 * @param {object} [opts] · dataDir / serverDir / env（都可注入 ⇒ 便于测试）
 * @returns {string}
 */
export function resolveDataDir(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const env = o.env || process.env;
  const explicit = String(o.dataDir || "").trim();
  if (explicit) return explicit;
  const fromEnv = String(env.BAI_DATA_DIR || "").trim();
  if (fromEnv) return fromEnv;
  const serverDir = String(o.serverDir || defaultServerDir()).trim();
  if (serverDir && existsSync(path.join(serverDir, "config.json"))) return serverDir;
  const appData = String(env.APPDATA || "").trim();
  if (appData) return path.join(appData, "bai-router");
  return serverDir;
}

/**
 * 读一个 JSON 文件（读不到 / 坏掉 ⇒ null，**安静**）。
 *
 * @param {string} file
 * @returns {Promise<object|null>}
 */
async function readJson(file) {
  try {
    const raw = await readFile(file, "utf8");
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/**
 * secretsOf —— 从配置里挑出**凭据清单**（只留够长的字符串）。
 *
 * ⚠ 短的不算凭据（免得把 `""` 或某个普通短串当成令牌，误判成泄密）。
 *
 * @param {object} cfg
 * @returns {string[]}
 */
export function secretsOf(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const out = [];
  for (const v of [c.wb && c.wb.accessToken, c.wbai && c.wbai.accessToken]) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s.length >= 8 && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * loadRefreshCfg —— 读配置，**只取刷表要用的那几块**。
 *
 * ⚠ **只读需要的字段**（wb/wbai 的 upstream + 令牌、qd 的目录文件路径）：
 *   整份 config.json 递来递去没意义，而且**别的字段（apiKey 等）没必要进内存**。
 * ⚠ 令牌**只在内存里**，不进任何落盘文件（`refreshFacts` 有守卫盯着）。
 * ⚠ 出厂默认值（`config.defaults.json`）只作**兜底**：用户没配的那一项取默认。
 *   ⚠ 用户配了空字符串（= 登出了）⇒ **不拿默认值顶回去** ⇒ 宁可拉不到，
 *     也不拿一个「出厂令牌」去发请求。
 *
 * @param {object} [opts] · dataDir / serverDir / env
 * @returns {Promise<{cfg:object, secrets:string[], warnings:string[], dataDir:string}>}
 */
export async function loadRefreshCfg(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const dataDir = resolveDataDir(o);
  const serverDir = String(o.serverDir || defaultServerDir()).trim();
  const user = await readJson(path.join(dataDir, "config.json"));
  const defaults = await readJson(path.join(serverDir, "config.defaults.json"));
  const warnings = [];
  if (!user) warnings.push(`读不到 ${path.join(dataDir, "config.json")}`);

  /* ⚠ **凭据与地址的取值规则不一样**：
   *   · 凭据（accessToken）—— 用户写了**空串**就是「登出了」⇒ **拿用户的空串**，
   *     **不拿出厂默认值顶回去**（拿一个出厂令牌去发请求，是替用户做决定）。
   *     用户**没这个键** ⇒ 才用出厂值（通常也是空的）。
   *   · 地址（upstream / modelsFile）—— 空串 = 没配 ⇒ 用出厂值兜底。 */
  const CRED_KEYS = new Set(["accessToken", "token", "refreshToken", "deviceToken"]);
  const pick = (provider, keys) => {
    const u = (user && user[provider]) || {};
    const d = (defaults && defaults[provider]) || {};
    const out = {};
    for (const k of keys) {
      const has = u[k] !== undefined && u[k] !== null;
      if (has && (CRED_KEYS.has(k) || u[k] !== "")) {
        out[k] = u[k];
        continue;
      }
      out[k] = d[k];
    }
    return out;
  };

  const cfg = {
    wb: pick("wb", ["upstream", "accessToken"]),
    wbai: pick("wbai", ["upstream", "accessToken"]),
    qd: pick("qd", ["modelsFile"]),
  };
  /* ⚠ qd 的目录文件路径：出厂默认是空串 ⇒ 用 server.mjs 的同一处兜底
   *   （`path.join(os.tmpdir(), "qoder-models.json")`）。 */
  if (!String(cfg.qd.modelsFile || "").trim()) {
    cfg.qd.modelsFile = path.join(os.tmpdir(), "qoder-models.json");
  }

  /* ⚠ **凭据清单**（只留够长的字符串，短的不算凭据，免得误判）。 */
  const secrets = secretsOf(cfg);
  return { cfg, secrets, warnings, dataDir };
}

/**
 * 落盘内容里有没有凭据。
 *
 * ⚠ 判据是**字面包含**：令牌出现在落盘内容里就拒绝写。
 *   （令牌不可能是空串，也不可能短到 8 个字符以下。）
 *
 * @param {string} text 落盘内容（序列化之后）
 * @param {string[]} secrets
 * @returns {string|null} 命中的那个凭据（没命中 ⇒ null）
 */
export function findSecretIn(text, secrets) {
  const t = String(text || "");
  const list = Array.isArray(secrets) ? secrets : [];
  for (const s of list) {
    const v = typeof s === "string" ? s : "";
    if (v.length < 8) continue;
    if (t.includes(v)) return v;
  }
  return null;
}

/**
 * refreshFacts —— **刷一次**：拉目录 → 合并 → 守卫 → 落盘。
 *
 * ⚠ **失败一律安静**：返回 `{ ok:false, ... }` 而**不抛** —— 刷表是辅助，
 *   它失败不该带倒任何东西。
 * ⚠ **全都拉不到 ⇒ 绝不写文件**（否则会把「没拉到」写成「目录是空的」，
 *   把上一次的覆盖层清掉 —— 那正是 `facts-sources.mjs` 里「空目录陷阱」的同一类错）。
 * ⚠ 落盘用 `saveFacts`（**原子写**：先写临时文件再改名）。
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir] 数据目录（默认按 `resolveDataDir` 解析）
 * @param {string} [opts.file] 覆盖层文件路径（默认 `<dataDir>/model-facts.json`）
 * @param {object} [opts.cfg] 配置（不给就自己读）
 * @param {string[]} [opts.secrets] 凭据清单（不给就自己从 cfg 里挑）
 * @param {Function} [opts.collect] 目录拉取（默认 `collectCatalogs`；测试注入用）
 * @param {Function} [opts.fetchImpl] 注入的 fetch（测试用）
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.at] 时间戳（注入用）
 * @returns {Promise<{ok:boolean, wrote:boolean, file:string, reason?:string,
 *                    error?:string, entries?:number, providers?:string[],
 *                    errors?:Array<{provider:string,error:string}>, kept?:boolean}>}
 */
export async function refreshFacts(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const dataDir = resolveDataDir(o);
  const file = String(o.file || path.join(dataDir, MODEL_FACTS_FILE_NAME)).trim();

  let cfg = o.cfg;
  let secrets = Array.isArray(o.secrets) ? o.secrets : null;
  if (!cfg) {
    const loaded = await loadRefreshCfg({ ...o, dataDir });
    cfg = loaded.cfg;
    if (!secrets) secrets = loaded.secrets;
  }
  /* ⚠ **凭据清单从 cfg 里现挑** —— 调用方自己递了 cfg 却不递 secrets 时，
   *   守卫照样盯着（不然那道守卫就是个摆设）。 */
  if (!secrets) secrets = secretsOf(cfg);

  const collect = typeof o.collect === "function" ? o.collect : collectCatalogs;
  const { catalogs, errors } = await collect({
    cfg,
    fetchImpl: o.fetchImpl,
    timeoutMs: o.timeoutMs,
    at: o.at,
  });
  const list = Array.isArray(catalogs) ? catalogs : [];

  /* ⚠ **一条都没拉到 ⇒ 不写文件**：旧覆盖层原样留着，没有就用内置表。 */
  if (!list.length) {
    return { ok: false, wrote: false, kept: true, reason: "no-catalogs", file, errors: errors || [] };
  }

  /* 内置表打底，渠道目录覆盖上去（`mergeCatalogFacts` 是纯函数，不改内置表）。 */
  let facts = MODEL_FACTS;
  for (const c of list) facts = mergeCatalogFacts(facts, c);

  /* ⚠ **凭据守卫**：落盘内容里出现令牌 ⇒ 拒绝写。
   *   ⚠ 这道守卫**不是装饰** —— 覆盖层是要被人看、被别的东西读的，
   *   凭据一旦落进去就等于泄了。 */
  const hit = findSecretIn(JSON.stringify(facts), secrets);
  if (hit) {
    return {
      ok: false, wrote: false, kept: true, reason: "credential-leak", file,
      errors: errors || [],
    };
  }

  const w = await saveFacts(file, facts, { baseAt: OUTLET_TIERS_AT, at: o.at });
  if (!w || !w.ok) {
    return {
      ok: false, wrote: false, kept: true, reason: "save-failed", file,
      error: String((w && w.error) || "落盘失败").slice(0, 140),
      errors: errors || [],
    };
  }
  return {
    ok: true, wrote: true, file,
    entries: Object.keys(facts).length,
    providers: list.map((c) => String(c.provider || "")),
    errors: errors || [],
  };
}

/**
 * renderRefreshResult —— 把一次刷表结果说成**一行人话**。
 *
 * @param {object} r `refreshFacts` 的返回值
 * @returns {string}
 */
export function renderRefreshResult(r) {
  const x = r && typeof r === "object" ? r : {};
  const errs = Array.isArray(x.errors) ? x.errors : [];
  const errPart = errs.length
    ? `；${errs.map((e) => `${e.provider}：${e.error}`).join("；")}`
    : "";
  if (x.ok) {
    const n = Array.isArray(x.providers) ? x.providers.join("/") : "";
    return `模型真值表：刷新成功 —— 拉到 ${n || "（未知渠道）"}，合并后 ${x.entries} 条 → 已写入覆盖层`
      + `（${x.file}）${errPart}`;
  }
  const why = x.reason === "no-catalogs" ? "一条目录都没拉到"
    : (x.reason === "credential-leak" ? "落盘内容里出现了凭据 ⇒ 拒绝写"
      : (x.reason === "save-failed" ? `落盘失败（${x.error || ""}）` : "未知原因"));
  return `模型真值表：刷新没成（${why}）—— 保留旧覆盖层 / 内置表，客户端照常接得上${errPart}`;
}

/**
 * runRefresh —— **跑一次刷表**（命令行入口用它）。
 *
 * ⚠ 跑完就退（不是常驻）⇒ 触发方式交给外面（计划任务 / 手动 / 别的）。
 *
 * @param {object} [opts] 同 {@link refreshFacts}
 * @returns {Promise<object>} `refreshFacts` 的返回值
 */
export async function runRefresh(opts) {
  return refreshFacts(opts);
}

/**
 * isDirectRun —— 本文件是不是被**直接运行**（而不是被 import）。
 */
function isDirectRun() {
  try {
    const self = fileURLToPath(import.meta.url);
    const a1 = process.argv[1];
    if (!a1) return false;
    return path.resolve(self) === path.resolve(a1);
  } catch {
    return false;
  }
}

/* ── 命令行入口 ────────────────────────────────────────────────────────────
 * 独立进程：跑一次，拉目录，落盘，退出。
 * ⚠ 退出码恒为 0（除非本模块自己崩了）：**刷表失败不是应用失败** ——
 *   网关照常用内置表或上一次的覆盖层。失败详情在**打印的那一行**里。
 *   ⚠ 想监控的话，看那一行或覆盖层文件的 mtime，别看退出码。 */
if (isDirectRun()) {
  try {
    const r = await runRefresh({});
    process.stdout.write(renderRefreshResult(r) + "\n");
  } catch (e) {
    process.stdout.write(`模型真值表：刷新进程自己出错了（${String((e && e.message) || e).slice(0, 160)}）`
      + " —— 客户端照常接得上\n");
    process.exitCode = 1;
  }
}
