/**
 * scripts/api-timeout-budget-test.mjs —— 「预算倒挂」：后端肯等 45 秒，前端只肯等 12 秒。
 *
 * ## 病根（一句话）
 *   `panel-common.js` 的 `api()` 有一条全局默认值 `const ms = o.timeoutMs || 12000`，
 *   而后端凡是打上游，一律给自己 **15 秒以上**的预算。上游只要用满自己那份，
 *   前端 100% 先断 —— 然后把一次**成功**报成「✘ 读取超时（超过 12 秒）」。
 *   这是同一族缺陷的第三次复发：v1.0.79 修 /api/config、v1.0.80 修 /api/wb/capture、
 *   本次修 /api/test、/api/models、/api/models/scan-all、/api/or/refresh。
 *
 * ## 为什么要有这个文件
 *   修了四处只是止血。**下次再加一个打上游的接口，照样会倒挂**——因为新代码不会去翻
 *   这次的提交记录。所以这里做的是**可扩展的机械检查**，而不是四条 if。
 *
 * ## ★ 判定规则（怕误报的人先读这段）
 *   检查分三步，每一步都从**源码**里读数，不是从注释里抄数：
 *
 *   (1) 后端预算 = 按「声明的拓扑」把**真实源码里的 `AbortSignal.timeout(N)` /
 *        `execFile(..., { timeout: N })` 字面量**加起来。
 *        拓扑（谁串谁、谁并、串几次）是读代码得到的事实，必须声明；
 *        **数字一律当场从源码解析** —— 有人把 45000 改成 90000，本检查立刻跟着变红。
 *        规则：串行步骤之间**求和**，同一并行步骤内**取最大**。
 *
 *   (2) 前端预算 = 从 `panel-common.js` 与 `cards/*.js` 的**每一个**
 *        `api(` / `postJSON(` / `ctx.postJSON(` 调用点解析 `timeoutMs`；
 *        没写就取 `api()` 的默认值 —— 而那个默认值也是从源码解析的（不是写死的 12000）。
 *        调用点是**扫出来的**，不是列出来的：以后新增的调用点自动进检查。
 *
 *   (3) 断言：对每个「会打上游且前端真的在调」的端点，
 *          前端预算 ≥ 后端预算。
 *        唯一的例外是「非阻塞范式」（POST 立刻回包 + 轮询 status 取结果），
 *        而**这个例外不是自封的**：本文件会从 server.mjs 里把那个 handler 的源码抠出来，
 *        逐行检查——凡是「能走到上游函数」的那一行都带 `await` 或 `return` 的，一律判为阻塞。
 *        换句话说，想豁免就必须真的把 `await` 去掉；偷偷加回来，本文件立刻变红。
 *
 *   **另外两条防漏**（它们决定这个检查会不会随时间失效）：
 *     · 每个端点声明的「会打上游的函数集合」必须与「从它的 handler 出发实际可达的集合」
 *       **逐个相等**。新加一个上游调用却没登记预算 → 集合不等 → 变红。
 *     · 每一个源码里含 `AbortSignal.timeout` / `execFile timeout` 的顶层函数，
 *       要么出现在某个端点的声明里，要么出现在 NOT_A_PANEL_ENDPOINT 的豁免表里（带理由）。
 *       新加一个抓上游的函数却忘了归类 → 变红。
 *
 *   **已知不覆盖的**：非 `AbortSignal.timeout` 形态的等待（zen-probe.mjs 内部的循环、
 *   自升级下载的分片读取等）。它们已由各自的测试覆盖；本文件只在 §EXTRA 里显式登记
 *   两条推导不出来的（/api/models/probe-zen 与其「无上限常量」的事实），不假装覆盖。
 *
 * ## 反向对照
 *   文件末尾 SABOTAGE 表 + `grep SABOTAGE` 可定位。四条修复各有一条「撤掉修复 → 必须变红」。
 *   另有 scripts/api-timeout-budget-sabotage-run.mjs 把五条一起跑一遍。
 *
 * ## 红线
 *   🔴 全文没有一个真实令牌 / API key（夹具里只有明显假的占位串）。
 *   🔴 落盘只在 os.tmpdir() 下的临时目录 + BAI_DATA_DIR，**绝不碰真实 %APPDATA%\bai-router**；
 *      端口动态挑空闲且全部落在 17xxx 段；进程只按 **PID** 收，绝不用 /IM。
 *   🔴 本文件**只读产品源码**（不启动服务也能跑完 §1~§2、§5）；只有 §3 那个
 *      「非阻塞形状」的 e2e 会真起一份 server.mjs，跑在临时目录里。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRV = path.join(REPO, "src", "server");
const SERVER_PATH = path.join(SRV, "server.mjs");
const PANEL_PATH = path.join(SRV, "panel-common.js");
const ZEN_PROBE_PATH = path.join(SRV, "zen-probe.mjs");
const CARDS_DIR = path.join(SRV, "cards");

const SERVER_SRC = readFileSync(SERVER_PATH, "utf8");
const PANEL_SRC = readFileSync(PANEL_PATH, "utf8");
const ZEN_PROBE_SRC = readFileSync(ZEN_PROBE_PATH, "utf8");
const MODEL_SYNC_SRC = readFileSync(path.join(CARDS_DIR, "model-sync.js"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ====================================================================== *
 * 0. 源码解析工具
 * ====================================================================== */

/** 去掉块注释与行注释，让「函数引用图」不被注释里的函数名带偏。
 *  判据自检在下面 makeFunctions() 里：剥完仍必须能定位到每个已知 fetcher。 */
function stripComments(src) {
  const lines = src.split(/\r?\n/);
  let inBlock = false;
  return lines.map((raw) => {
    let out = "", i = 0;
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf("*/", i);
        if (end < 0) { i = raw.length; out += " "; break; }
        inBlock = false; i = end + 2; out += " ";
        continue;
      }
      const two = raw.slice(i, i + 2);
      if (two === "/*") { inBlock = true; i += 2; out += " "; continue; }
      if (two === "//") {
        /* `://` 出现在 URL 里，不是注释。只在行首或空白之后才当注释。 */
        const prev = i === 0 ? " " : raw[i - 1];
        if (/\s/.test(prev)) break;
        out += two; i += 2; continue;
      }
      out += raw[i]; i += 1;
    }
    return out;
  }).join("\n");
}

const SERVER_CODE = stripComments(SERVER_SRC);
const PANEL_CODE = stripComments(PANEL_SRC);
const CARDS_CODE = stripComments(MODEL_SYNC_SRC);

/** 顶层 `function` 声明 → { name, startLine, endLine, body, code }。
 *  只认行首的声明（顶格），嵌套的同名不算。
 *  ⚠ 两种收尾都要处理：
 *    · 多行函数：扫到「恰好等于 } 的那一行」；
 *    · **一行写完**的函数（`function readSuState() { try {…} catch {…} }`）：
 *      声明行自身花括号就配平了。若不认这一种，后面的扫描会一路找下去，
 *      把后面十几个函数全吞进来（曾经真吞过）。 */
function makeFunctions(src) {
  const lines = src.split(/\r?\n/);
  const map = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) continue;
    let depth = 0;
    for (const ch of lines[i]) {
      if (ch === "{") depth++; else if (ch === "}") depth--;
    }
    let end = i;
    if (depth !== 0) {
      end = i + 1;
      while (end < lines.length && lines[end] !== "}") end++;
    }
    map.set(m[1], {
      name: m[1], startLine: i + 1, endLine: end + 1,
      body: lines.slice(i, end + 1).join("\n"),
      code: stripComments(lines.slice(i, end + 1).join("\n")),
    });
    i = end;   // 跳过函数体，避免把嵌套声明登记进来
  }
  return map;
}

const SERVER_FNS = makeFunctions(SERVER_CODE);

/* 常量表：`const NAME = 12345;` 与 `export const NAME = 12345;` 都收。
 * 跨文件找（server.mjs 从 zen-probe.mjs import 过来的 ZEN_PROBE_TIMEOUT_MS 就是这种）。 */
function makeConsts(srcs) {
  const map = new Map();
  for (const src of srcs) {
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=\s*(\d+)\s*[;,]/g)) {
      map.set(m[1], Number(m[2]));
    }
  }
  return map;
}
const CONSTS = makeConsts([SERVER_SRC, PANEL_SRC, ZEN_PROBE_SRC, MODEL_SYNC_SRC]);

/** 解析一个超时实参：字面量 / 全大写常量名（可带 ctx. 前缀）→ 毫秒数。 */
function resolveMs(expr, where) {
  const e = String(expr).trim();
  if (/^\d+$/.test(e)) return Number(e);
  const name = e.replace(/^ctx\./, "");
  if (/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    if (CONSTS.has(name)) return CONSTS.get(name);
    throw new Error(`无法解析的 timeoutMs 表达式 ${JSON.stringify(e)}（${where}）：${name} 不在常量表里`);
  }
  return null;   // 动态表达式，交给调用点自己声明
}

/* --- 上游 fetcher：含真实等待预算的函数 --- */
/* 两种形态都收，因为它们都是「后端肯等、前端未必肯等」的钱：
     · AbortSignal.timeout(N)   —— 上游 HTTP
     · execFile(..., { timeout: N }) —— 本机子进程（curl / tasklist）          */
const FETCHERS = new Map();   // name -> { kind, ms, calls: [{expr, ms}] }
for (const fn of SERVER_FNS.values()) {
  const calls = [];
  for (const m of fn.code.matchAll(/AbortSignal\.timeout\(\s*([A-Za-z0-9_.]+)\s*\)/g)) {
    const ms = resolveMs(m[1], fn.name);
    if (ms != null) calls.push({ expr: m[1], ms, kind: "http" });
  }
  /* ⚠ 只认**跟在 execFile / spawn 后面**的 timeout 选项。裸 `{ timeout: N }` 太常见
     （net.connect 的 connectTimeout 等），把它们算成「后端肯等 N 秒」会造出一堆假倒挂。 */
  for (const m of fn.code.matchAll(/\b(?:execFile|execFileSync|spawn|spawnSync|exec)\s*\([\s\S]{0,400}?\btimeout\s*:\s*([0-9]+)/g)) {
    calls.push({ expr: m[1], ms: Number(m[1]), kind: "exec" });
  }
  if (calls.length) {
    calls.sort((a, b) => b.ms - a.ms);
    FETCHERS.set(fn.name, { kind: calls[0].kind, ms: calls[0].ms, calls });
  }
}

/* --- 函数可达图（并查集式闭包，带环保护） --- */
function closureOf(start) {
  const seen = new Set(), stack = [...start];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    const fn = SERVER_FNS.get(n);
    if (!fn) continue;
    for (const m of fn.code.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (SERVER_FNS.has(m[0]) && !seen.has(m[0])) stack.push(m[0]);
    }
  }
  return seen;
}
const _closureCache = new Map();
const closure = (start) => {
  const key = [...start].sort().join("|");
  if (!_closureCache.has(key)) _closureCache.set(key, closureOf(start));
  return _closureCache.get(key);
};
/** 从一个 handler 的源码里，取出它**直接提到**的顶层函数（闭包的种子）。 */
function handlerFns(method, pathname) {
  const out = new Set();
  for (const id of handlerBody(method, pathname).match(/[A-Za-z_$][\w$]*/g) || []) {
    if (SERVER_FNS.has(id)) out.add(id);
  }
  return [...out];
}
const reachableFetchers = (start) => {
  const out = new Set();
  for (const n of closure(start)) if (FETCHERS.has(n)) out.add(n);
  return out;
};
/** 端点 → 它能走到的全部上游等待函数。 */
const endpointFetchers = (ep) => reachableFetchers(handlerFns(...ep.handler));

/* ====================================================================== *
 * 1. ★ 预算倒挂扫描
 * ====================================================================== */

/** 从 server.mjs 里把某个路由 handler 的源码抠出来。
 *  两种形态都要收：多行块（`if (...) { … }`）与单行早返回（`if (...) return …;`）。 */
function handlerBody(method, pathname) {
  const lines = SERVER_CODE.split(/\r?\n/);
  const head = `if (req.method === "${method}" && u.pathname === "${pathname}")`;
  const i = lines.findIndex((l) => l.trim().startsWith(head));
  if (i < 0) throw new Error(`server.mjs 里找不到路由 ${method} ${pathname} —— 路由被改名/挪走了？`);
  if (!lines[i].trim().endsWith("{")) return lines[i];   // 单行早返回
  let end = i + 1;
  while (end < lines.length && lines[end] !== "    }") end++;
  if (end >= lines.length) throw new Error(`${method} ${pathname} 的 handler 收尾没找到`);
  return lines.slice(i + 1, end).join("\n");
}

/** 「提到 callee 的那些行，全部都不带 await / return」——fire-and-forget 的结构判据。 */
function calledWithoutAwait(viaFn, callee) {
  const fn = SERVER_FNS.get(viaFn);
  if (!fn) throw new Error(`server.mjs 里定位不到 ${viaFn}`);
  const lines = fn.code.split(/\r?\n/).filter((l) => new RegExp(`\\b${callee}\\b`).test(l));
  return { ok: lines.length > 0 && lines.every((l) => !/\bawait\b/.test(l) && !/\breturn\b/.test(l)), lines };
}

/** 「非阻塞」的结构判据：从 handler 源码逐行看——凡是**能走到上游函数**的行，
 *  一律不许带 await / return。全程没有这样一行，才算真的不阻塞。
 *  ⚠ 这条判据故意是「宁可判阻塞」的方向：把 `void run()` 写回 `await run()` 必红。 */
function handlerIsNonBlocking(method, pathname) {
  const body = handlerBody(method, pathname);
  const blockers = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    if (!/\bawait\b/.test(line) && !/\breturn\b/.test(line)) continue;
    for (const id of line.match(/[A-Za-z_$][\w$]*/g) || []) {
      if (!SERVER_FNS.has(id)) continue;
      if (reachableFetchers([id]).size > 0) { blockers.push(line); break; }
    }
  }
  return { nonBlocking: blockers.length === 0, blockers };
}

/* --- 端点表：只声明**拓扑**，数字一律当场从源码解析 --- */
/* steps 的读法：一串**串行**步骤；每个步骤内是**并行**的成员（取最大）。
   串行求和 / 并行取最大 —— 与 Promise.all / 顺序 await 的语义一致。       */
const ENDPOINTS = {
  "GET /api/models": {
    handler: ["GET", "/api/models"],
    steps: [["wbRefreshToken"], ["wbFetchConfig"], ["wbFetchConfig"]],
    /* also = **互斥**的备选分支：可达、也要归类，但它们不会和 steps 串起来
       （?p=sn 走 fetchCatalogFor 自带的 15s，?p=wb 走上面那三次串行，二选一）。 */
    also: ["fetchCatalogFor", "orFetchFreeModels", "zenReadCatalog"],
    why: "wb/wbai 是最坏的一家，三次**串行**：令牌续期 15s → CLI 形态 15s → App 形态 15s = 45s。" +
      "其余渠道走 orFetchFreeModels / zenReadCatalog / fetchCatalogFor 自带的 15s，都更短。",
  },
  "POST /api/models/scan-all": {
    handler: ["POST", "/api/models/scan-all"],
    steps: [["wbRefreshToken"], ["wbFetchConfig"], ["wbFetchConfig"]],
    also: ["fetchCatalogFor", "orFetchFreeModels", "zenReadCatalog"],
    why: "六家 allSettled 并行，墙钟 = 最慢的那家 = 上面同一条 45s。",
  },
  "POST /api/or/refresh": {
    handler: ["POST", "/api/or/refresh"],
    steps: [["orFetchFreeModels"], ["orFetchQuota"]],
    why: "orFetchFreeModels(15s) 顺序 await orFetchQuota(12s)。",
  },
  "POST /api/test": {
    handler: ["POST", "/api/test"],
    steps: [["runTierProbe"], ["runTierProbe"], ["runTierProbe"]],
    nonBlocking: true,   // 例外**不是自封的**：由 handlerIsNonBlocking() 从源码验
    why: "单档 3 次重试 × 45s（probe 里的 for attempt < 3）；勾「测全部四档」再串 4 档 ≈545s。" +
      "v1.0.81 起 POST 立刻回包、探测在后台，前端轮 /api/status 取结果，所以前端不再等它。",
  },
  "GET /api/status": {
    handler: ["GET", "/api/status"],
    steps: [["probeVia", "checkCcSwitch"]],
    /* async = 能走到、但**不 await**（fire-and-forget）的上游等待：它不占本次响应的墙钟。 */
    async_: [{ name: "orFetchQuota", via: "orQuotaSnapshot", why: "额度快照过期时顺手起一次后台补拉（60 秒缓存），不 await —— 面板 5 秒一轮询，等它才叫慢" }],
    why: "checkClash→probeVia 的 execFile timeout 9000 与 checkCcSwitch 的 5000 并行，取 9000。" +
      "离前端默认 12 秒只剩 3 秒余量，但失败被 catch 吃掉、不会误报成「已停止」，故不改。",
  },
  "POST /api/models/probe-zen": {
    handler: ["POST", "/api/models/probe-zen"],
    steps: [["zenReadCatalog"], ["zenProbeSend"]],
    declaredBudgetMs: 300000,
    why: "⚠ 这一条的**推导不出来**：zen-probe.mjs 里没有「最多探几个模型」的常量，" +
      "上限取决于账号的免费模型数。所以预算取前端已显式声明的 300000，原样放行、不做推导。",
  },
};

/* 通用端点表之外的等待：启动、中转及令牌捕获的专用动态预算。
   每个都要写明理由，令牌捕获另由 wb-capture-report-test 验证前端窗口及终局。 */
const NOT_A_PANEL_ENDPOINT = {
  openaiExchange: "中转出站（relay server），面板不可达，没有前端读它",
  handleUpstream: "中转出站（同上），最长等待来自请求头预算，不是面板动作",
  downloadLatestInstaller: "备用自升级：POST /api/selfupdate 调它但**不 await**（已在 §1 结构判据里验过）",
  listenWithRetry: "启动期的看门狗 ping 自身面板，与面板动作无关",
  findWbCliScript: "令牌捕获路径里定位客户端安装目录（powershell/where 子进程），" +
    "走 /api/wb/capture 专用长请求预算（后端捕获窗口 + 前端60s余量）",
  wbClientEarliestStartMs: "同上：令牌捕获路径里用 powershell 读客户端进程启动时间（8s），" +
    "只喂给 /api/wb/capture 专用动态预算",
  wbClientProcessTable: "捕获专用的进程查询（12s），在捕获截止时间内执行；前端使用捕获窗口+60s余量",
  wbTerminatePidOnly: "捕获专用的退出请求（每次10s），正常退出/强制退出等待有上限；位于捕获截止时间内",
};

/* --- 解析前端的每一个调用点 --- */
function parseCallSites() {
  const files = [
    { file: "panel-common.js", src: PANEL_CODE, raw: PANEL_SRC },
    { file: "cards/model-sync.js", src: CARDS_CODE, raw: MODEL_SYNC_SRC },
  ];
  const sites = [];
  for (const { file, src } of files) {
    const re = /\b(?:ctx\.)?(api|postJSON)\s*\(\s*(["'`])((?:[^"'`\\]|\\.)*)\2/g;
    for (const m of src.matchAll(re)) {
      /* 从这次调用的左括号起，数到配对的右括号，取出整段参数。 */
      let i = m.index + m[0].indexOf("(");
      let depth = 0, end = i;
      for (; end < src.length; end++) {
        if (src[end] === "(") depth++;
        else if (src[end] === ")") { depth--; if (depth === 0) break; }
      }
      const args = src.slice(i, end + 1);
      const pathLit = m[3];
      const base = pathLit.split("?")[0];
      let ms = null, expr = null;
      const tm = args.match(/\btimeoutMs\s*:\s*([^,}]+)/);
      if (tm) { expr = tm[1].trim(); ms = resolveMs(expr, `${file} → ${pathLit}`); }
      sites.push({ file, fn: m[1], pathLit, base, ms, expr, args });
    }
  }
  return sites;
}
const CALL_SITES = parseCallSites();

/** api() 的默认值 —— 从源码解析，不是写死的 12000。 */
function defaultTimeoutMs() {
  const m = PANEL_CODE.match(/const\s+ms\s*=\s*o\.timeoutMs\s*\|\|\s*(\d+)/);
  if (!m) throw new Error("panel-common.js 里读不到 api() 的默认超时 —— 那一行被改了？");
  return Number(m[1]);
}
const DEFAULT_MS = defaultTimeoutMs();

/** 声明过「动态预算」的调用点（表达式算不出来，必须自带下界声明）。 */
const DYNAMIC_FLOORS = {
  /* capTimeoutMs(后端给的窗口) = 兜底窗口 + 余量；后端 WB_CAPTURE_TIMEOUT_MS 是 10 分钟。 */
  "/api/wb/capture": {
    floor: CONSTS.get("WB_CAPTURE_TIMEOUT_MS") + 60 * 1000,
    why: "capTimeoutMs() = 后端捕获窗口 + 60s 余量，先问 /api/wb/capture/status 再发",
  },
};

/** 拓扑 → 预算毫秒。串行步骤求和，同一步骤内取最大。 */
function backendBudget(steps) {
  const parts = steps.map((step) => {
    const vals = step.map((name) => {
      const f = FETCHERS.get(name);
      if (!f) throw new Error(`steps 里点名了 ${name}，但源码里它不是 fetcher（没有超时字面量）`);
      return f.ms;
    });
    return Math.max(...vals);
  });
  return { total: parts.reduce((a, b) => a + b, 0), parts };
}

/* ====================================================================== *
 * 2. 四条修复 · 逐条钉住
 * ====================================================================== */

/** 端点 → 前端调用点实际拿到的预算（含默认值兜底）。取**最小**的那个：
 *  同一个端点若有多处调用，任何一处预算不够就还是倒挂。 */
function frontendBudgetsFor(basePath) {
  const hits = CALL_SITES.filter((s) => s.base === basePath);
  const out = [];
  for (const s of hits) {
    let ms = s.ms;
    let how = ms != null ? "显式" : "默认值";
    if (ms == null && DYNAMIC_FLOORS[s.base]) { ms = DYNAMIC_FLOORS[s.base].floor; how = "动态下界"; }
    if (ms == null) ms = DEFAULT_MS;
    out.push({ ...s, budget: ms, how });
  }
  return out;
}

describe("★ ① 预算倒挂机械扫描（可扩展，防复发）", () => {
  test("扫描器本身没瞎：源码里真的能找到已知 fetcher 与它们的超时字面量", () => {
    /* 这条是给扫描器做的自检。扫描器要是没真读到源码，下面所有断言都会「因为扫不到
       东西」而恒真通过——那是最危险的假绿。 */
    for (const name of ["runTierProbe", "wbRefreshToken", "wbFetchConfig",
      "orFetchFreeModels", "orFetchQuota", "zenReadCatalog", "probeVia", "checkCcSwitch"]) {
      assert.ok(SERVER_FNS.has(name), `server.mjs 里定位不到顶层函数 ${name}（解析器坏了？）`);
      assert.ok(FETCHERS.has(name), `${name} 被登记成 fetcher 了吗？它应该含超时字面量`);
    }
    assert.equal(FETCHERS.get("runTierProbe").ms, 45000, "探测的 45 秒预算应当被解析出来");
    assert.equal(FETCHERS.get("wbRefreshToken").ms, 15000);
    assert.equal(FETCHERS.get("orFetchQuota").ms, 12000);
    assert.equal(FETCHERS.get("probeVia").ms, 9000, "execFile 的 timeout:9000 也算上游等待");
    assert.equal(FETCHERS.get("zenProbeSend").ms, 10000, "ZEN_PROBE_TIMEOUT_MS 要能跨文件解析");
  });

  test("防漏①：每个端点声明的 fetcher 集合 == 从它的 handler 实际可达的集合", () => {
    for (const [label, ep] of Object.entries(ENDPOINTS)) {
      const declared = new Set([...ep.steps.flat(), ...(ep.also || []), ...(ep.async_ || []).map((x) => x.name)]);
      const actual = endpointFetchers(ep);
      const missing = [...actual].filter((n) => !declared.has(n)).sort();
      const extra = [...declared].filter((n) => !actual.has(n)).sort();
      assert.deepEqual(missing, [],
        `${label} 的 handler 能走到这些上游等待函数，但预算表里没登记：` +
        `${JSON.stringify(missing)}。新增上游调用必须把它的预算算进来，否则就是新的倒挂。`);
      assert.deepEqual(extra, [],
        `${label} 的预算表里点名了这些函数，但 handler 走不到它们（表与代码漂移了）：` +
        `${JSON.stringify(extra)}`);
    }
  });

  test("防漏②：源码里每个上游等待函数都有归处（端点声明 or 写明理由的豁免）", () => {
    const claimed = new Set(Object.values(ENDPOINTS).flatMap((e) =>
    [...e.steps.flat(), ...(e.also || []), ...(e.async_ || []).map((x) => x.name)]));
    for (const name of [...FETCHERS.keys()].sort()) {
      if (claimed.has(name)) continue;
      assert.ok(Object.prototype.hasOwnProperty.call(NOT_A_PANEL_ENDPOINT, name),
        `server.mjs 里新出现了带超时等待的函数 ${name}（${FETCHERS.get(name).ms}ms），` +
        `但它既不在任何端点的预算表里，也没有写明豁免理由。新增上游调用必须归类。`);
    }
  });

  test("★ 判定：不存在「后端预算 > 前端预算」的组合", () => {
    const problems = [];
    const rows = [];
    for (const [label, ep] of Object.entries(ENDPOINTS)) {
      const basePath = label.split(" ")[1];
      const be = ep.declaredBudgetMs != null ? ep.declaredBudgetMs : backendBudget(ep.steps).total;
      /* 互斥的备选分支单独算一遍：它不该比最坏的那条串行链还长。
         若不然，说明拓扑把一条本可以并行的路写成了串行的 —— 那会凭空抬高预算、
         把一个本来没问题的调用点判成倒挂（假红的来源）。 */
      for (const name of ep.also || []) {
        const ms = FETCHERS.get(name).ms;
        assert.ok(ms <= be,
          `${label} 的备选分支 ${name} 自己就 ${ms}ms，比声明的最坏路径 ${be}ms 还长 —— ` +
          `拓扑写错了。`);
      }
      /* async_（fire-and-forget）不进预算：它不占本次响应的墙钟。
         但「不 await」这个说法同样要从源码验 —— 偷偷加个 await 就得变红。 */
      for (const a of ep.async_ || []) {
        const r = calledWithoutAwait(a.via, a.name);
        assert.equal(r.ok, true,
          `${label} 把 ${a.name} 登记成「不 await」，可 ${a.via} 里这些行带 await/return：` +
          `${JSON.stringify(r.lines)}\n—— 那它就真的要算进墙钟预算。`);
      }
      if (ep.nonBlocking) {
        /* 豁免要从源码里验，验不过就当没豁免。 */
        const nb = handlerIsNonBlocking(...ep.handler);
        assert.equal(nb.nonBlocking, true,
          `${label} 声明为非阻塞，但 handler 里这些行「能走到上游函数」却带了 await/return：` +
          `${JSON.stringify(nb.blockers, null, 2)}\n` +
          `—— 真阻塞就不能走例外，前端必须给够预算。`);
        rows.push({ label, backend: be, frontend: "非阻塞（已从源码验）", ok: true });
        continue;
      }
      const fe = frontendBudgetsFor(basePath);
      if (!fe.length) { rows.push({ label, backend: be, frontend: "前端不调", ok: true }); continue; }
      for (const s of fe) {
        const ok = s.budget >= be;
        rows.push({ label, backend: be, frontend: `${s.budget}ms(${s.how}) @ ${s.file}`, ok });
        if (!ok) problems.push(
          `${label}：后端肯等 ${be}ms，前端只给 ${s.budget}ms（${s.how}，${s.file} → ${s.pathLit}）\n` +
          `    → 上游一用满预算，前端必先断，一次成功会被报成「读取超时（超过 ${Math.round(s.budget / 1000)} 秒）」`);
      }
    }
    if (problems.length) assert.fail(`检出 ${problems.length} 处预算倒挂：\n  · ` + problems.join("\n  · "));
    assert.ok(rows.length >= 6, "扫描到的端点数不该这么少（表本身没加载？）");
  });

  test("★ 修复后的四笔账，数字得能当场说出来", () => {
    const say = (label) => {
      const ep = ENDPOINTS[label];
      const be = ep.declaredBudgetMs != null ? ep.declaredBudgetMs : backendBudget(ep.steps).total;
      const fe = frontendBudgetsFor(label.split(" ")[1]);
      return { be, fe: fe.map((s) => ({ ms: s.budget, how: s.how, file: s.file })) };
    };
    assert.deepEqual(say("GET /api/models").fe.map((x) => x.ms), [60000, 60000],
      "「刷新模型列表」前面那一步（拉目录）必须 ≥60s，且两个调用点都要给");
    assert.deepEqual(say("POST /api/models/scan-all").fe.map((x) => x.ms), [60000]);
    assert.deepEqual(say("POST /api/or/refresh").fe.map((x) => x.ms), [45000]);
    assert.equal(say("POST /api/test").be, 45000 * 3, "探测单档最坏 3 次重试 × 45s");
  });

  test("🔴 没顺手把默认值也改大（那是诱惑，也是错的）", () => {
    /* api() 的 12000 是共享层的安全网：值没变/接口快时立刻返回，接口死了不会干等两分钟。
       改默认值会让所有慢接口一起失去保护。正解是逐个调用点声明 —— 就是上面那条判定。 */
    assert.equal(DEFAULT_MS, 12000, "api() 里的默认值被改了 —— 必须原样保留");
    assert.match(PANEL_SRC, /const\s+ms\s*=\s*o\.timeoutMs\s*\|\|\s*12000;/,
      "api() 那一行必须逐字保持 `const ms = o.timeoutMs || 12000;`");
  });

  test("快接口仍然走默认值，没被顺手加上大 timeout", () => {
    for (const p of ["/api/status", "/api/config", "/api/apply", "/api/restore",
      "/api/wb/capture/status", "/api/selfupdate/status"]) {
      for (const s of frontendBudgetsFor(p)) {
        assert.equal(s.budget, DEFAULT_MS,
          `${p} 在 ${s.file} 上被加了 timeoutMs=${s.budget} —— 它是快接口，不需要`);
      }
    }
  });
});

describe("② 四条修复 · 逐条钉住", () => {
  test("② 前端每一个调用点的预算都能被解析（没有「解析不出来就跳过」的洞）", () => {
    for (const s of CALL_SITES) {
      if (s.ms != null) continue;
      assert.ok(DYNAMIC_FLOORS[s.base] || s.expr === null,
        `${s.file} → ${s.pathLit} 的 timeoutMs=${JSON.stringify(s.expr)} 既不是字面量也不是常量，` +
        `也没登记下界。解析不出来就不能参与倒挂判定 —— 那等于没检查。`);
      if (s.expr === null) {
        /* 没写 timeoutMs 的，走默认值。这是绝大多数调用点。 */
      }
    }
    /* 兜底：调用点数量不得为零（正则一旦失配，下面所有判定都会空转）。 */
    assert.ok(CALL_SITES.length >= 25,
      `只扫到 ${CALL_SITES.length} 个调用点，正则多半失配了（改动过 api/postJSON 的写法？）`);
  });

  test("② 撤掉 /api/models 的 timeoutMs → 判定必须变红（SABOTAGE #1）", () => {
    /* 修复前的字节：const r = await api("/api/models?p=" + selected);
       预算掉回默认 12000 < 后端 45000 → 倒挂成立。 */
    const before = backendBudget(ENDPOINTS["GET /api/models"].steps).total;
    const reverted = DEFAULT_MS;   // ← 改回改前行为
    assert.equal(before, 45000, "后端最坏 45s（15+15+15 串行）");
    assert.ok(reverted < before,
      "改前行为下前端预算确实小于后端预算 —— 这正是「刷新模型列表」会假报失败的原因");
    assert.match(PANEL_SRC, /api\("\/api\/models\?p=" \+ selected, \{ timeoutMs: CATALOG_TIMEOUT_MS \}\)/,
      "当前必须显式给足");
  });

  test("② 撤掉 /api/models/scan-all 的 timeoutMs → 变红（SABOTAGE #2）", () => {
    const before = backendBudget(ENDPOINTS["POST /api/models/scan-all"].steps).total;
    assert.ok(DEFAULT_MS < before, "改前 12s < 45s");
    assert.match(CARDS_CODE, /ctx\.postJSON\("\/api\/models\/scan-all", \{\}, \{ timeoutMs: ctx\.SCAN_ALL_TIMEOUT_MS \}\)/);
    assert.ok(CONSTS.has("SCAN_ALL_TIMEOUT_MS"), "卡片用的这个常量必须在 panel-common.js 里定义");
  });

  test("② 撤掉 /api/or/refresh 的 timeoutMs → 变红（SABOTAGE #3）", () => {
    const before = backendBudget(ENDPOINTS["POST /api/or/refresh"].steps).total;
    assert.equal(before, 27000, "orFetchFreeModels 15000 + orFetchQuota 12000");
    assert.ok(DEFAULT_MS < before, "改前 12s < 27s");
    assert.match(PANEL_CODE, /postJSON\("\/api\/or\/refresh", \{\}, \{ timeoutMs: OR_REFRESH_TIMEOUT_MS \}\)/,
      "/api/or/refresh 必须显式给足");
  });

  test("② 把 /api/test 改回阻塞（加回 await）→ 非阻塞豁免当场失效（SABOTAGE #4）", () => {
    /* 豁免是从源码验的。这里把同一段 body 换成「await runTierProbe(...)」的写法，
       判据必须改口 —— 否则那条 nonBlocking:true 就是自封的。 */
    const blockingBody = handlerBody("POST", "/api/test")
      .replace(/void\s+runTierProbe/, "const r = await runTierProbe");
    const lines = blockingBody.split(/\r?\n/);
    let blocking = [];
    for (const line of lines) {
      if (!/\bawait\b/.test(line) && !/\breturn\b/.test(line)) continue;
      for (const id of line.match(/[A-Za-z_$][\w$]*/g) || []) {
        if (!SERVER_FNS.has(id)) continue;
        if (reachableFetchers([id]).size > 0) { blocking.push(line.trim()); break; }
      }
    }
    assert.ok(blocking.length > 0,
      "把 await 加回去，判据却还说它不阻塞 —— 那这条豁免就是自封的，整个检查形同虚设");
  });
});

/* ====================================================================== *
 * 3. ★ POST /api/test 的非阻塞形状（端到端，真 server.mjs）
 * ====================================================================== */

const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-timeout-"));

/* 从 panel-common.js 里把**真源码**抠出来：waitTestDone + testTiers + 两个常量。
 * 抠出来而不是抄一份重写：抄的那份证明不了产品代码的形状。 */
function cutFrontendTestSource() {
  const lines = PANEL_SRC.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("「测试连通」的轮询节奏与放弃条件"));
  if (start < 0) throw new Error("panel-common.js 里找不到 TEST_POLL_MS 那一段的起始注释 —— 锚点移位了");
  const end = lines.findIndex((l, i) => i > start &&
    l.includes("lines.join(\"\\n\") + (tail ? \"\\n\" + tail : \"\"), !!up.ok)"));
  if (end < 0) throw new Error("抠不出 testTiers 的收尾 —— 锚点移位了");
  /* 往回吃到那个函数的收尾 } */
  let stop = end;
  while (stop < lines.length && lines[stop] !== "  }") stop++;
  let src = lines.slice(start, stop + 1).join("\n");
  /* 只改一件事：把「放弃窗口」从 12 分钟缩到 25 秒。测试等不了 12 分钟，
     而失败时要能**快速红**（否则一次回归会把整个套件挂住）。
     ⚠ 缩小的前提是它确实写着 12 分钟 —— 改写失败就当场炸，不许悄悄改别的。 */
  const before = src;
  src = src.replace("const TEST_WAIT_LIMIT_MS = 12 * 60 * 1000;",
    "const TEST_WAIT_LIMIT_MS = 25000;");
  if (src === before) {
    throw new Error("抠出来的真源码里没有 `const TEST_WAIT_LIMIT_MS = 12 * 60 * 1000;` —— " +
      "12 分钟那个兜底窗口被改了/挪走了？");
  }
  return src;
}

/** 把抠出来的真源码挂进一个最小沙箱：只注入它用得到的依赖，其余一律 undefined。
 *  返回 { testTiers, results } —— results 是 showResult 收到的所有文案与好坏。
 *
 *  ⚠ sliceOf 也**必须抠真的**：waitTestDone 读的是「刚拿到的那份 s」经 sliceOf 切片，
 *    注入一份仿造的实现等于把「读哪一份状态」这个断言本身架空了。
 *    stOf 仍留在 ctx 里：testTiers 以外的同段代码不碰它，留着是无害的冗余注入。 */
function cutSliceOf() {
  const lines = PANEL_SRC.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("const sliceOf = (obj, key) =>"));
  if (start < 0) throw new Error("panel-common.js 里找不到 sliceOf —— 锚点移位了");
  let stop = start;
  while (stop < lines.length && lines[stop].trim() !== "};") stop++;
  if (stop >= lines.length) throw new Error("抠不出 sliceOf 的收尾 —— 锚点移位了");
  return lines.slice(start, stop + 1).join("\n");
}
function makeFrontendHarness(api, postJSON, stOf) {
  const src = cutFrontendTestSource();
  const results = [];
  const ctxObj = {
    has: (id) => id === "ckAllTiers",
    $: (id) => (id === "ckAllTiers" ? { checked: true } : null),
    selected: "sn",
    api, postJSON,
    showResult: (el, text, good) => results.push({ text: String(text), good: !!good }),
    stOf, TIER_ZH: {},
    console, Promise, setTimeout, clearTimeout, Date, JSON, Math,
  };
  const fn = new vm.Script(
    `(() => {\n${cutSliceOf()}\n${src}\n return { testTiers, TEST_POLL_MS, TEST_WAIT_LIMIT_MS };\n})()`
  ).runInNewContext(vm.createContext(ctxObj));
  return { ...fn, results };
}

async function freePorts(n) {
  const servers = [], ports = [];
  for (let i = 0; i < n; i++) {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    ports.push(s.address().port);
    servers.push(s);
  }
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

describe("③ POST /api/test：提交 + 轮询（不阻塞、能看见 running、报真实结果）", () => {
  let child, dataDir, panel;

  before(async () => {
    const [bai, sn, wb, wbai, zen, qd, or, pnl, dead, mm] = await freePorts(10);
    panel = pnl;
    dataDir = path.join(TMPROOT, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    const cfg = JSON.parse(readFileSync(path.join(SRV, "config.defaults.json"), "utf8"));
    cfg.relayPort = bai; cfg.panelPort = panel;
    Object.assign(cfg, {
      sn: { ...cfg.sn, relayPort: sn, upstream: `http://127.0.0.1:${dead}/v1` },
      wb: { ...cfg.wb, relayPort: wb }, wbai: { ...cfg.wbai, relayPort: wbai },
      zen: { ...cfg.zen, relayPort: zen }, qd: { ...cfg.qd, relayPort: qd },
      mm: { ...cfg.mm, relayPort: mm }, or: { ...cfg.or, relayPort: or },
    });
    cfg.failover.enabled = false;
    /* ⚠ 必须预置 cfg.proxy，否则启动后会跑代理探测、探到本机 7897 就写进配置并自重启。 */
    cfg.proxy = "http://127.0.0.1:7897";
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

    child = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env, BAI_DATA_DIR: dataDir,
        NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1", BAI_NO_PROXY_AUTODETECT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    child.stdout.resume(); child.stderr.resume();

    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      try { if ((await fetch(`http://127.0.0.1:${panel}/api/status`).then((r) => r.json())).service?.up) return; }
      catch { }
      await sleep(300);
    }
    throw new Error("server.mjs 40 秒内没把面板端口起起来");
  }, { timeout: 60000 });

  after(() => {
    try { child && child.kill(); } catch { }               // 只按 PID
    try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { }
  });

  const statusJson = () => fetch(`http://127.0.0.1:${panel}/api/status`).then((r) => r.json());
  const upOf = (s, p) => (s[p] || s).upstream || {};

  test("★ POST 立刻回包（探测转后台），且 /api/status 期间能看到 running", async () => {
    const t0 = Date.now();
    const post = await fetch(`http://127.0.0.1:${panel}/api/test`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "sn", all: true }), signal: AbortSignal.timeout(20000),
    }).then((r) => r.json());
    const postMs = Date.now() - t0;
    assert.equal(post.started, true, `POST 应回 started:true，实际 ${JSON.stringify(post)}`);
    assert.ok(postMs < 3000,
      `POST 用了 ${postMs}ms 才回 —— 那还是阻塞的。前端 api() 默认 12 秒，四档串行必然被掐断。`);

    /* 后端探测还在跑（档间有 1.5s 间隔，总共 ≥4.5s），至少要观测到一次 running:true。 */
    let sawRunning = false, sawStale = false;
    const t1 = Date.now();
    let last;
    while (Date.now() - t1 < 60000) {
      const s = await statusJson();
      const up = upOf(s, "sn");
      if (up.running) { sawRunning = true; sawStale = sawStale || up.at === null; }
      last = up;
      if (!up.running && up.at) break;
      await sleep(80);
    }
    assert.equal(sawRunning, true,
      "从头到尾没观测到 upstream.running===true —— 前端轮询没有进度出口，这条修复等于没做");
    assert.equal(sawStale, true,
      "running 期间 at 已经写上了新值 —— 那说明 lastTest 在探测中途被改了，" +
      "前端会把半成品当结论报出去");
    assert.ok(Array.isArray(last.tiers) && last.tiers.length === 4,
      `跑完应留下四档结果，实际 ${JSON.stringify(last.tiers && last.tiers.length)}`);
    assert.equal(last.running, false, "跑完后 running 必须落回 false，否则前端会永远转圈");
  }, { timeout: 90000 });

  test("★ 前端 testTiers 的真源码：全程不抛、看得见 running、最后报真实结果", async () => {
    /* 跑**真源码**（抠自 panel-common.js），只把三个 IO 依赖换成指向真 server 的桩。 */
    let curStatus = null;
    const api = async () => { curStatus = await statusJson(); return curStatus; };
    const postJSON = async (p, body) => fetch(`http://127.0.0.1:${panel}${p}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(20000),
    }).then((r) => r.json());
    /* stOf 要复刻 sliceOf 的形状（bai 挂在顶层、其余挂在各自 key 下）——
       传成函数的话 waitTestDone 会读到 undefined，一路轮询到放弃窗口才返回。 */
    const stOf = (k) => {
      const sub = curStatus ? curStatus[k] : null;
      return (sub && typeof sub === "object" && !Array.isArray(sub)) ? sub : (curStatus || {});
    };

    const h = makeFrontendHarness(api, postJSON, stOf);
    assert.equal(typeof h.testTiers, "function", "抠不出 testTiers 的真源码");
    assert.equal(h.TEST_POLL_MS, 2000, "轮询节奏被改了");

    const t0 = Date.now();
    await h.testTiers();                       // ⚠ 不该抛
    const totalMs = Date.now() - t0;

    const texts = h.results.map((r) => r.text);
    assert.ok(texts.some((t) => /正在逐档探测|正在排队/.test(t)),
      `整个过程没有出现过任何「正在…」文案 —— 用户会以为卡死了。实际收到：${JSON.stringify(texts)}`);
    assert.ok(texts.some((t) => /⏳ 仍在服务端继续|这不是失败/.test(t) === false),
      "不该在探测正常跑完时走「仍在继续」那条兜底");
    const final = h.results[h.results.length - 1];
    assert.ok(!/读取超时/.test(final.text),
      `最终文案里出现「读取超时」：${JSON.stringify(final.text)}\n` +
      `—— 那正是本次要消灭的假报失败。`);
    assert.ok(/✘|✔/.test(final.text),
      `最终结果应当是逐档的真实结论，实际：${JSON.stringify(final.text)}`);

    /* 总耗时必然超过任何一次单读的预算（12s 默认），却仍然拿到了结论 ——
       这就是「不靠把 timeout 调大」的证据：每个 api() 调用都只花几毫秒。 */
    assert.ok(totalMs > 3000,
      `整轮只花了 ${totalMs}ms —— 探测根本没在跑，测试没测到东西`);
  }, { timeout: 120000 });

  test("快路径零变化：GET /api/status 照旧是快接口，没被加上大 timeout", async () => {
    const t0 = Date.now();
    const s = await statusJson();
    const ms = Date.now() - t0;
    assert.equal(s.service.up, true, "服务应当是起来的");
    assert.ok(ms < 12000, `/api/status 用了 ${ms}ms —— 它不该慢`);
    /* upstream 既有字段一个都不能少（面板各处在读） */
    const up = upOf(s, "sn");
    for (const k of ["tested", "ok", "model", "ms", "error", "at",
      "expected", "expectedKind", "expectedWhy", "expectedTiers"]) {
      assert.ok(k in up, `/api/status 的 upstream 少了既有字段 ${k} —— 面板会读不到`);
    }
    /* 新增字段只多这几个，且都有理由 */
    for (const k of ["running", "runningAt", "tiers", "all", "active"]) {
      assert.ok(k in up, `v1.0.81 新增的 upstream.${k} 不在了`);
    }
    assert.equal(up.running, false, "没有探测在跑时 running 必须是 false");
    /* ⚠ 用**没被任何一条测试探测过**的渠道验「没测过就是空」——
       前面那两条刚把 sn 探过一遍，拿 sn 验这条只会自相矛盾。 */
    assert.deepEqual(upOf(s, "or").tiers, [], "没测过的渠道 tiers 应是空数组");
    assert.equal(upOf(s, "or").running, false);
  }, { timeout: 30000 });
});

/* ====================================================================== *
 * 4. SABOTAGE 表（grep SABOTAGE 可定位）
 * ====================================================================== */
/* 每条 = 一个「改回改前行为」的手法。由 scripts/api-timeout-budget-sabotage-run.mjs
   真打到源码上跑一遍测试，确认**必须红**，再逐字还原。 */
const SABOTAGE = [
  {
    name: "models-timeout-drop", file: "src/server/panel-common.js",
    where: "「刷新模型列表」前面那一步（GET /api/models）去掉 timeoutMs",
    from: 'api("/api/models?p=" + selected, { timeoutMs: CATALOG_TIMEOUT_MS })',
    to: 'api("/api/models?p=" + selected)',
    reds: "倒挂判定（45000 > 12000）+ ② SABOTAGE #1",
  },
  {
    name: "catalog-source-timeout-drop", file: "src/server/panel-common.js",
    where: "切渠道时拉目录出处那一步去掉 timeoutMs",
    from: 'api("/api/models?p=" + key, { timeoutMs: CATALOG_TIMEOUT_MS })',
    to: 'api("/api/models?p=" + key)',
    reds: "倒挂判定（两个调用点取最小预算）",
  },
  {
    name: "scan-all-timeout-drop", file: "src/server/cards/model-sync.js",
    where: "六家扫描去掉 timeoutMs",
    from: 'ctx.postJSON("/api/models/scan-all", {}, { timeoutMs: ctx.SCAN_ALL_TIMEOUT_MS })',
    to: 'ctx.postJSON("/api/models/scan-all", {})',
    reds: "倒挂判定（45000 > 12000）+ ② SABOTAGE #2",
  },
  {
    name: "or-refresh-timeout-drop", file: "src/server/panel-common.js",
    where: "重查 OpenRouter 额度去掉 timeoutMs",
    from: 'postJSON("/api/or/refresh", {}, { timeoutMs: OR_REFRESH_TIMEOUT_MS })',
    to: 'postJSON("/api/or/refresh", {})',
    reds: "倒挂判定（27000 > 12000）+ ② SABOTAGE #3",
  },
  {
    name: "test-blocking-again", file: "src/server/server.mjs",
    where: "把 POST /api/test 改回同步探测（加回 await）",
    from: "void runTierProbe(loadCfg(), P, !!b.all)",
    to: "await runTierProbe(loadCfg(), P, !!b.all)",
    reds: "非阻塞豁免失效 + ② SABOTAGE #4 + ③「POST 立刻回包」",
  },
  {
    name: "default-timeout-bumped", file: "src/server/panel-common.js",
    where: "把 api() 的默认 12000 抬到 60000（那个诱惑）",
    from: "const ms = o.timeoutMs || 12000;",
    to: "const ms = o.timeoutMs || 60000;",
    reds: "🔴 默认超时没被动过",
  },
  {
    name: "catalog-chain-hidden", file: "src/server/server.mjs",
    where: "让 wb 目录那条链路不再经过 wbFetchConfig（好让预算表与实际调用脱节）",
    from: "const cat = await wbReadCatalog(cfg, p, acct);",
    to: "const cat = wbBuiltinCatalog(cfg, p);",
    reds: "防漏①：预算表里登记了 wbFetchConfig 的 15s，handler 却已经走不到它",
  },
  {
    name: "running-flag-dropped", file: "src/server/server.mjs",
    where: "从 /api/status 的 upstream 里删掉 running（前端就没有进度出口了）",
    from: "running: !!testRun && testRun.p === p,",
    to: "running: false,",
    reds: "③「POST 立刻回包…能看到 running」",
  },
];

/* 反向对照执行器靠这个参数把表读出去（复制一份的迟早与源码脱节）。 */
if (process.argv.includes("--emit-sabotage")) {
  process.stdout.write(JSON.stringify(SABOTAGE));
  process.exit(0);
}
