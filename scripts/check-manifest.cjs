#!/usr/bin/env node
/* check-manifest.cjs —— 提供方面板的「构建期一致性闸门」。
 *
 *   node scripts/check-manifest.cjs        独立跑；全部通过退 0，有问题退 1
 *
 * 背景：v1.0.46 把五份 4467 行的 HTML 收敛成「一份模板 provider.html + 一份清单
 * providers.js + 共享 CSS/JS + cards/*.js」。收敛本身做完了，但**加第六家时漏改
 * 一处仍会静默出错**（上一轮就出了五处：Zen 页表头写着 WorkBuddy、状态卡叫
 * 「JWT 有效期」、四页接线徽章都判 m.mode === "wb"、cliMode 少一个字段…）。
 * 本脚本把「漏改一处」从运行期 bug 变成构建期失败。
 *
 * 十三类检查（v17 单页改版后重新对齐，逐条对应 REFACTOR-CONTRACT-v17.md 第五节）：
 *   C1 清单完整性（渠道字段）+ key/path 与 server.mjs 注册路由一致 + 声明序 = 转移链序
 *   C2 【已退役】原 guide 结构检查，其检查点并入 C1 的 credential 结构 —— 见该节
 *   C3 诊断结论文案：conclusion（就绪怎么判断）/ remedy（未就绪给什么建议）
 *   C4 契约 id 在 provider.html 里各出现且仅出现一次（= 契约 id 处置表的落地结果）
 *   C5 反向检查：id 引用无悬空（$() 以及 onClick/applyText/has 的字符串参数形式）
 *   C6 视图级卡片表 window.BAI_VIEWS[].cards 与 cards/*.js 双向对账
 *   C7 状态语义色（--ok/--warn/--err/--idle/--brand）深浅两套都有值，且不再有
 *      per-provider 的 --accent 块
 *   C8 清单 models 与 config.defaults.json 的 availableModels 逐项一致
 *   C9 视图分段：#navViews 里的 data-view ↔ BAI_VIEWS[].id ↔ 模板里的视图容器
 *   C10 凡是「直接返回模板」的路由，都必须能在清单里 path 精确匹配上
 *   C11 panel-common.js 不得再按提供方名字硬编码（清单化收尾；cards/*.js 与注释不扫）
 *   C12 渲染层必读的**新增渠道字段**每家都要有，并与 C1 的必填表保持交集（防两处漂移）
 *   C13 种子配置不得带本机路径/用户名
 *
 * 零依赖：只用 Node 内置模块。
 *
 * 约定：本脚本**只读**。它不修任何东西——修哪个文件、填什么值，全部打在输出里。
 *
 * ---------------------------------------------------------------------------
 * 在途台账（v17 阶段一「分棒实施」造成的中间态，唯一一处降级机制）
 * ---------------------------------------------------------------------------
 * 契约 v17 的五个里程碑是串行的，本次实施按棒拆开：清单 + 模板 + 闸门先落地，
 * 样式（里程碑 3）与渲染层（里程碑 4）随后。中间态下有两类事实是**预期内**的：
 *   ① panel-common.js 还在读已被处置表删掉的 id（模板里没有了）；
 *   ② cards/overview.js 还在磁盘上，但视图表已不再引用它；
 *   ③ panel-common.css 还是旧的 per-provider --accent 调色板。
 * 这三类都登记在下面 IN_FLIGHT / PALETTE_V17_READY 里，命中后**从 error 降级为 warn**
 * 并点名负责的里程碑。判别力没有被削弱：未登记的悬空 id、未登记的死卡、
 * 状态色缺失（在严格模式下）仍然是 error，且台账条目一旦过期会被报出来要求删除。
 * 里程碑 3 / 4 落地后，这三本账应当清空 —— 见各自的定义处。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRV = path.join(ROOT, "src", "server");
const CARDS_DIR = path.join(SRV, "cards");

const F = {
  providers: path.join(SRV, "providers.js"),
  html: path.join(SRV, "provider.html"),
  commonJs: path.join(SRV, "panel-common.js"),
  commonCss: path.join(SRV, "panel-common.css"),
  server: path.join(SRV, "server.mjs"),
  defaults: path.join(SRV, "config.defaults.json"),
};

/* ============================================================================
 * 输出
 * ==========================================================================*/

const findings = [];           // {check, level:"error"|"warn"|"ok"|"info", text}
let currentCheck = "?";
const setCheck = (id) => { currentCheck = id; };

const err = (text) => findings.push({ check: currentCheck, level: "error", text });
const warn = (text) => findings.push({ check: currentCheck, level: "warn", text });
const info = (text) => findings.push({ check: currentCheck, level: "info", text });
const ok = (text) => findings.push({ check: currentCheck, level: "ok", text });

/* Windows 控制台可能是 GBK，中文会变乱码。结构性文字（检查名/字段名/id/路径）本来就
 * 是 ASCII；只有「当前值」可能含中文，这里把非 ASCII 压成 '?'，保证形状可读
 * （残留的 '{' 照样看得出来），真实文字请看源文件。 */
const show = (v) => {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  let s;
  try { s = typeof v === "string" ? v : JSON.stringify(v); }
  catch { s = String(v); }
  s = s.replace(/[^\x20-\x7e\n]/g, "?");
  if (s.length > 72) s = s.slice(0, 69) + "...";
  return s;
};

const typeOf = (v) => {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) {
    const bad = v.filter((x) => typeof x !== "string" || !x.trim()).length;
    return `array(${v.length})` + (bad ? ` with ${bad} non-string/empty item(s)` : "");
  }
  if (typeof v === "string") return v.trim() ? `string "${show(v)}"` : "empty string";
  return typeof v;
};

/* ============================================================================
 * 工具
 * ==========================================================================*/

const read = (f) => fs.readFileSync(f, "utf8");

/* 在沙箱里真求值一个浏览器侧的纯数据脚本（providers.js / cards/*.js）。
 * 只给 window/document 的最小桩；卡片文件在顶层只做 window.BAI_CARDS[name] = {...}，
 * 所有 DOM 访问都在 mount() 内部，所以顶层求值是安全的。 */
function evalInSandbox(file, sandboxExtra) {
  const code = read(file);
  const noop = () => {};
  const fakeEl = new Proxy({}, {
    get: (t, k) => (k === "style" || k === "dataset" || k === "classList" ? fakeEl
      : k === "textContent" || k === "innerHTML" || k === "value" || k === "title" ? ""
      : k === Symbol.toPrimitive ? () => "" : noop),
    set: () => true,
  });
  const sandbox = Object.assign({
    window: {},
    document: {
      createElement: () => fakeEl,
      createTextNode: () => fakeEl,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      body: fakeEl, head: fakeEl, documentElement: fakeEl,
    },
    location: { pathname: "/", href: "http://127.0.0.1/" },
    navigator: { userAgent: "node", platform: "win32" },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    fetch: () => Promise.reject(new Error("offline")),
    setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
    console,
  }, sandboxExtra || {});
  sandbox.window = sandbox.window || {};
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: file, timeout: 5000 });
  return sandbox;
}

/* 剥掉 JS 注释（行注释 + 块注释），让「提供方字面量等值判断」的扫描不被注释里的
 * 举例骗到（panel-common.js 顶部注释就写着 `m.mode === "wb"` 这种历史事故）。 */
const stripJsComments = (js) => js
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

/* 剥掉 HTML 注释，免得注释里写的 id="x" 被数成真元素 */
const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

/* 同样剥掉 CSS 注释：panel-common.css 顶部的用法说明里就写着
 * `html[data-provider="x"]`（讲怎么加第 6 家），那是示例不是配色块。 */
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const countId = (html, id) => {
  const re = new RegExp("id\\s*=\\s*[\"']" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\"']", "g");
  return (html.match(re) || []).length;
};

const uniq = (a) => [...new Set(a)];
const setEq = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/* CSS 最内层规则块 {selector, body} —— 只认不含嵌套花括号的叶子块。
   @media 里的规则会以 "@media (...) \n .sel" 的形式出现，用选择器前缀匹配即可。 */
function cssBlocks(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ sel: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  return out;
}
const cssVars = (body) => {
  const m = new Map();
  for (const mm of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;}]*)/g)) {
    if (!m.has(mm[1])) m.set(mm[1], mm[2].trim());
  }
  return m;
};

/* ============================================================================
 * 在途台账（v17 阶段一分棒实施的中间态，见文件头说明）
 *
 * 三本账都已清空：里程碑 3（panel-common.css 重建）与里程碑 4（渲染层重写 +
 * 卡片迁移）落地后，渲染层不再读任何一个被删的 id、死卡已删、调色板已切到
 * 状态语义色。空数组 = 没有在途豁免，C5/C6/C7 恢复为全 error 严格模式。
 * 账目本身保留（而不是整段删掉）：下一次再有人加一个 id 又忘了同步渲染层，
 * 闸门会**直接报错**而不是默默放过——这正是这三本账存在的意义。
 * ==========================================================================*/

/* ① 已从模板删除、但旧渲染层仍在引用的 id。
 *    里程碑 4 落地后渲染层不再读它们，台账已清空。
 *    下面是本轮实际清掉的 25 个，作为「哪些 id 是渲染层曾经读过」的记录。 */
const IN_FLIGHT_IDS = {
  owner: "里程碑 4（panel-common.js 重写）—— 已清空",
  cleared: [
    /* 两步引导卡 */
    "step1", "step2", "state1", "state2", "guideAux", "eyebGuide", "ttlGuide",
    "slot-step1", "btnApply", "ckCli", "ckDesk",
    /* 接线卡的编号与标题（已并入状态带；ttlPatch 从未被渲染层读取，故不在在途台账里） */
    "eyebPatch",
    /* 路由表卡的编号、目标列表头与说明（已并入映射编辑区；auxRoute 未被读取） */
    "eyebRoute", "ttlRoute", "thTarget", "routeHint", "slot-route",
    /* 一排信号灯的扩展插槽（已并入状态带的单元栅格） */
    "slot-lamps",
    /* 设置卡的编号、标题、副行与「可选模型列表」文本域 */
    "eyebSys", "ttlSys", "sysAux", "fModels",
    /* 「走代理」整行（勾选框本身保留在设置视图） */
    "useProxyRow", "useProxyText",
  ],
  ids: [],
};

/* ② 视图表已不再引用、但文件还在磁盘上的卡。里程碑 4 已删卡片文件，台账清空。 */
const IN_FLIGHT_CARDS = {
  owner: "里程碑 4（删 cards/overview.js）—— 已清空",
  cleared: ["overview"],
  names: [],
};

/* ③ 调色板模式开关。
 *   false = 里程碑 3 尚未重建 panel-common.css，仍是 per-provider --accent 旧调色板：
 *     「状态语义色缺失」与「仍有 --accent 块」只报 warn，不拦路。
 *   true  = 里程碑 3 已落地：五色必须在深浅两套里都有值，且不得再有 --accent 块，
 *     两条断言全部升级为 error。
 *   **里程碑 3 的验收人必须把这里改成 true** —— 否则 C7 会永远停在只警告模式。
 *   本文件每次运行都会打印当前模式，不会有人看不见。 */
const PALETTE_V17_READY = true;

/* ============================================================================
 * 契约常量（改这里 = 改 REFACTOR-CONTRACT-v17.md，两边要一起改）
 * ==========================================================================*/

/* C4：契约 id 处置表（REFACTOR-CONTRACT-v17.md 第二节）的落地结果，分三组按处置分类排列。
 * 注意 #bnrUpdate / #updBtn / #btnSelfUpd / #stopBtn **不在**这里——契约写明它们由
 * panel-common.js 注入，模板里本就不该有。（见 provider.html 顶部注释同一句。）
 *
 *   保留原样 28 个 · 保留但换语义 18 个 · 新增 14 个 = 60 个
 * （契约正文写的是「删 25、新增 15 → 42」，与逐条表对不上：删除那一栏实际列出 24 个 id，
 *   其中只有 9 个原本在旧 CONTRACT_IDS 里；新增那一栏实际列出 14 个。
 *   本数组以**逐条表**为准 —— 见 check-manifest 运行时的 [C4] 段落会把这个差异打印出来。） */
const IDS_KEPT_AS_IS = [
  "svc",
  "themeBtn", "themeIcon", "themeText",
  "winMin", "winMax", "winClose",
  "patchTime", "patchCli", "cliBadge", "patchDesk", "deskBadge",
  "btnRestore",
  "routeBody", "btnSave", "btnTest", "ckAllTiers", "testResult",
  "cardSys", "headSys", "sysResult",
  "footPaths", "verTxt",
  "bnrInfo", "bnrInfoTitle", "bnrInfoMsg", "bnrInfoX",
  "slot-extra",
];
const IDS_KEPT_NEW_MEANING = [
  "ledRelay", "txtRelay", "subRelay",          // → 状态带「服务」单元
  "ledUp", "txtUp", "subUp",                  // → 状态带「可用渠道」单元
  "ledTok", "txtTok", "subTok",               // → 状态带「接线 / 凭据」单元
  "applyResult",                              // → 状态带下方的结果行
  "fUpstream", "fRelayPort", "lblUpstream", "lblRelayPort", "ckUseProxy",   // → 设置视图
  "btnSaveSys", "btnDeploy",                  // → 设置视图
  "btnResetModels",                           // → 映射编辑区
];
const IDS_NEW = [
  "navViews", "statusBand", "statusSentence", "btnBest", "btnRestore2", "btnDiag",
  "viewConsole", "viewCred", "viewFo", "viewSettings",
  "matrixGrid", "mapPanel", "diagBar", "diagList",
];
const CONTRACT_IDS = [...IDS_KEPT_AS_IS, ...IDS_KEPT_NEW_MEANING, ...IDS_NEW];

/* C4：处置表「删除」一栏的原样转录（契约第二节，24 个，顺序即表内顺序）。
 * 与 IN_FLIGHT_IDS 的区别：那是「渲染层还在读、等待里程碑 4 删除」的**在途引用**清单
 * （因此多了 eyebGuide/ttlGuide 两个从未进过 CONTRACT_IDS 的旧 id，又少了
 * auxRoute/ttlPatch 两个从来没人读的）；本表是**契约的删除清单**，一字不差。
 * C4 的「不得少删也不许多删」用它对账，IN_FLIGHT_IDS 只服务 C5 的降级。 */
const DELETED_IDS = [
  "step1", "state1", "step2", "state2", "guideAux",
  "btnApply", "ckCli", "ckDesk",
  "auxRoute", "thTarget", "routeHint", "slot-route", "slot-lamps", "slot-step1",
  "eyebPatch", "ttlPatch", "fModels",
  "eyebRoute", "ttlRoute", "eyebSys", "ttlSys",
  "sysAux", "useProxyRow", "useProxyText",
];

/* C1/C12：Claude 四档档位 id（panel-common.js 的 TIERS、config.defaults.json 的 mapping
 * 键、清单 mappingDefaults 的键，三处必须是同一组）。 */
const TIER_KEYS = ["claude-fable-5", "claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"];

/* C1：渠道字段必填表。type 见 typeOf() 的返回风格。
 * path 允许 null，但只允许 chainable:false 的条目（目前只有交还区 ccswitch）——
 * 它不是独立页面，不该有 URL。 */
const REQUIRED_FIELDS = [
  { name: "key", type: "str" },
  { name: "path", type: "pathOrNull" },
  { name: "tab", type: "str" },
  { name: "h1", type: "str" },
  { name: "title", type: "str" },
  { name: "shortName", type: "str" },
  { name: "letter", type: "str" },
  { name: "name", type: "str" },
  { name: "tagline", type: "str" },
  { name: "badge", type: "obj" },
  { name: "chainable", type: "bool" },
  { name: "credential", type: "obj" },
  { name: "models", type: "strArr" },
  { name: "mappingDefaults", type: "obj" },
  { name: "brands", type: "obj" },
  { name: "defaultModels", type: "strArr" },
  { name: "settingsLabels", type: "obj" },
];

/* C1 并入的 credential 结构检查（原 C2 guide 检查的归宿，契约第五节明写）。
 * kind 是**分派开关**：凭据视图按它决定给输入框、给状态+重取、还是给三行指纹，
 * 渲染层因此不需要认识任何渠道名（C11 的前提就是这里枚举封闭）。 */
const CRED_KINDS = ["apiKey", "jwt", "jobToken", "keys3", "none"];
const BADGE_KINDS = ["free", "paid", "cn", "intl", "neutral"];

/* 规范路径（七个 URL 全部保留，见契约第一节的产品决策 1）。 */
const EXPECTED_PATHS = { bai: "/bai", sn: "/sn", wb: "/wb", zen: "/zen", qd: "/qd", or: "/or" };
const ROOT_PATH = "/";

/* ============================================================================
 * 载入
 * ==========================================================================*/

let manifest, views, html, htmlNoComment, commonJs, commonCss, serverJs, defaults;
try {
  const sandbox = evalInSandbox(F.providers);
  manifest = sandbox.window.BAI_PROVIDERS;
  views = sandbox.window.BAI_VIEWS;
  if (!manifest || typeof manifest !== "object") throw new Error("providers.js did not set window.BAI_PROVIDERS");
  html = read(F.html); htmlNoComment = stripHtmlComments(html);
  commonJs = read(F.commonJs);
  commonCss = stripCssComments(read(F.commonCss));
  serverJs = read(F.server);
  defaults = JSON.parse(read(F.defaults));
} catch (e) {
  console.log("check-manifest: FATAL cannot load inputs -- " + e.message);
  console.log("  expected: " + path.relative(ROOT, F.providers) + " (must be evaluable standalone)");
  process.exit(1);
}

const keys = Object.keys(manifest);
if (!keys.length) {
  console.log("check-manifest: FATAL window.BAI_PROVIDERS is empty in src/server/providers.js");
  process.exit(1);
}
if (!Array.isArray(views) || !views.length) {
  console.log("check-manifest: FATAL window.BAI_VIEWS is missing or empty in src/server/providers.js");
  console.log("  it is the view-level card table consumed by C6/C9 (single-page console)");
  process.exit(1);
}

/* ============================================================================
 * C1 渠道字段完整性 + key/path 与 server.mjs 注册路由一致 + 声明序 = 转移链序
 *   （原 C2「guide 结构」的检查点已并入本节的 credential 结构）
 * ==========================================================================*/
setCheck("C1");
const C1_START = findings.length;
{
  const seenPath = new Map();
  for (const key of keys) {
    const P = manifest[key];
    if (!P || typeof P !== "object" || Array.isArray(P)) {
      err(`${key}: manifest entry is ${typeOf(P)} -- expected a plain object`);
      continue;
    }

    /* 对象键与 key 字段必须一致——加第七家最容易在这里只改一半 */
    if (P.key !== key) {
      err(`${key}: field "key" is ${show(P.key)} -- expected "${key}" (the manifest object key; rename both together)`);
    }

    for (const f of REQUIRED_FIELDS) {
      const v = P[f.name];
      if (f.type === "str") {
        if (typeof v !== "string" || !v.trim()) {
          err(`${key}: field "${f.name}" is ${typeOf(v)} -- expected a non-empty string`);
        }
      } else if (f.type === "pathOrNull") {
        if (v !== null && (typeof v !== "string" || !v.trim())) {
          err(`${key}: field "path" is ${typeOf(v)} -- expected a non-empty string, or null for a channel with no URL of its own`);
        }
      } else if (f.type === "strArr") {
        if (!Array.isArray(v)) {
          err(`${key}: field "${f.name}" is ${typeOf(v)} -- expected an array of non-empty strings (may be empty)`);
        } else if (v.some((x) => typeof x !== "string" || !x.trim())) {
          err(`${key}: field "${f.name}" is ${typeOf(v)} -- expected every item to be a non-empty string`);
        }
      } else if (f.type === "obj") {
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          err(`${key}: field "${f.name}" is ${typeOf(v)} -- expected a plain object`);
        }
      } else if (f.type === "bool") {
        if (typeof v !== "boolean") {
          err(`${key}: field "${f.name}" is ${typeOf(v)} -- expected true or false`);
        }
      }
    }

    /* path 形状：key 即路径（/bai…）；null 只留给「没有自己 URL 的渠道」，即交还区。
       这条规则是 C7/C9/C10 都依赖的地基，形状过了才查硬编码表，免得同一处报两遍。 */
    if (P.path === null) {
      if (P.chainable !== false) {
        err(`${key}: field "path" is null but "chainable" is ${show(P.chainable)} -- only a non-chainable channel (the hand-back cell) may have no URL of its own`);
      }
    } else if (typeof P.path === "string" && P.path) {
      const want = ROOT_PATH + key;
      if (P.path !== want) {
        err(`${key}: field "path" is ${show(P.path)} -- expected "${want}" (key 即路径)`);
      } else if (EXPECTED_PATHS[key] && P.path !== EXPECTED_PATHS[key]) {
        err(`${key}: field "path" is ${show(P.path)} -- expected ${show(EXPECTED_PATHS[key])} (hard-coded contract in check-manifest.cjs)`);
      }
      if (seenPath.has(P.path)) {
        err(`${key}: field "path" is ${show(P.path)} -- already used by "${seenPath.get(P.path)}"; two channels on one route`);
      } else seenPath.set(P.path, key);

      /* path 必须在 server.mjs 的 GET 路由里真的注册，否则打开就是 404 */
      const routeRe = new RegExp("u\\.pathname\\s*===\\s*[\"']" + P.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\"']");
      if (!routeRe.test(serverJs)) {
        err(`${key}: path ${show(P.path)} is not registered in server.mjs (no 'u.pathname === "${P.path}"' branch) -- the page would 404`);
      }
    }

    /* letter：卡片左上角的字母徽标。
       契约第一节写的是「2 字」，但已采纳的设计稿（a-console.html）对这两家用的是
       BAI / ZEN 三个字母 —— 砍成 BA / ZE 会把两家标错，所以这里放行 2–3 个字母。
       真正的坑是长度不齐导致徽标宽度跳变，所以上下界都卡死。 */
    if (typeof P.letter === "string" && !/^[A-Za-z]{2,3}$/.test(P.letter)) {
      err(`${key}: field "letter" is ${show(P.letter)} -- expected 2 or 3 letters (matrix cell badge; the accepted design mock uses BAI / ZEN, hence 3 is allowed)`);
    }

    /* badge：{text, kind}，kind 落在封闭枚举里（矩阵格与状态带的着色靠它） */
    const B = P.badge;
    if (B && typeof B === "object" && !Array.isArray(B)) {
      if (typeof B.text !== "string" || !B.text.trim()) {
        err(`${key}: badge.text is ${typeOf(B.text)} -- expected a non-empty string`);
      }
      if (!BADGE_KINDS.includes(B.kind)) {
        err(`${key}: badge.kind is ${show(B.kind)} -- expected one of ${BADGE_KINDS.join("/")}`);
      }
      const extra = Object.keys(B).filter((k) => k !== "text" && k !== "kind");
      if (extra.length) err(`${key}: badge has unexpected key(s) ${extra.join(",")} -- only text+kind are read`);
    }

    /* credential：原 C2 的检查点并到这里。kind 是渲染层的分派开关，必须封闭。 */
    const C = P.credential;
    if (C && typeof C === "object" && !Array.isArray(C)) {
      if (!CRED_KINDS.includes(C.kind)) {
        err(`${key}: credential.kind is ${show(C.kind)} -- expected one of ${CRED_KINDS.join("/")} (the credential view dispatches on this; an unknown kind renders nothing and, worse, would force a provider name into panel-common.js)`);
      }
      for (const f of ["label", "hint"]) {
        if (typeof C[f] !== "string" || !C[f].trim()) {
          err(`${key}: credential.${f} is ${typeOf(C[f])} -- expected a non-empty string`);
        }
      }
      const extra = Object.keys(C).filter((k) => !["kind", "label", "hint"].includes(k));
      if (extra.length) err(`${key}: credential has unexpected key(s) ${extra.join(",")} -- only kind/label/hint are read`);
    }

    /* mappingDefaults：可接通渠道必须覆盖四档（面板「恢复默认」的种子）；
       不可接通的（交还区）必须为空对象——它没有映射编辑区。 */
    const MD = P.mappingDefaults;
    if (MD && typeof MD === "object" && !Array.isArray(MD)) {
      const mdKeys = Object.keys(MD);
      if (P.chainable === false) {
        if (mdKeys.length) {
          err(`${key}: mappingDefaults has ${mdKeys.length} entr(ies) but the channel is not chainable (no mapping editor on that cell) -- expected {}`);
        }
      } else {
        const miss = TIER_KEYS.filter((t) => !(t in MD));
        const extraT = mdKeys.filter((t) => !TIER_KEYS.includes(t));
        if (miss.length) err(`${key}: mappingDefaults is missing tier(s) ${miss.join(",")} -- expected exactly the four ${TIER_KEYS.join(", ")}`);
        if (extraT.length) err(`${key}: mappingDefaults has unknown tier key(s) ${extraT.join(",")} -- panel-common.js only renders ${TIER_KEYS.join(", ")}`);
        for (const t of mdKeys) {
          if (typeof MD[t] !== "string" || !MD[t].trim()) {
            err(`${key}: mappingDefaults["${t}"] is ${typeOf(MD[t])} -- expected a non-empty default label`);
          }
        }
      }
    }

    /* 真实映射值只来自 config.json；清单里出现 URL / 绝对路径 / 疑似密钥一律拦下。 */
    for (const f of ["tagline", "name", "title", "h1"]) {
      const v = P[f];
      if (typeof v !== "string") continue;
      if (/https?:\/\//i.test(v)) err(`${key}: ${f} contains a URL ("${show(v)}") -- upstream addresses are read from config at runtime, never written into the manifest`);
      if (/[A-Za-z]:[\\/]/.test(v)) err(`${key}: ${f} contains a drive-absolute path ("${show(v)}") -- machine-specific paths must never ship in the manifest`);
      if (/\b(?:sk|oc_sk|jt)-[A-Za-z0-9_-]{6,}/.test(v)) err(`${key}: ${f} looks like it carries a credential ("${show(v)}") -- the manifest ships with the app`);
    }
  }

  /* 根路径 / 仍然是七条 URL 之一（契约：/ 打开单页，默认选中当前接线的那家）。
     home 条目已删除，所以这条检查落在服务端路由上，而不是清单里。 */
  if (!/u\.pathname\s*===\s*["']\/["']/.test(serverJs)) {
    err(`server.mjs no longer serves ${ROOT_PATH} (no 'u.pathname === "/"' branch) -- contract keeps all seven URLs openable`);
  }
  if (!serverJs.includes("provider.html")) {
    err(`server.mjs never serves provider.html -- the whole page is unreachable`);
  }

  /* 声明序 = 故障转移链序（矩阵格序就是优先顺序）。真实链序的出厂值在
     config.defaults.json 的 failover.chain，两者漂移就会让「第一格 = 首选」变成假话。 */
  const declared = keys.filter((k) => manifest[k].chainable !== false);
  const chain = Array.isArray((defaults.failover || {}).chain) ? defaults.failover.chain : null;
  if (!chain) {
    err(`config.defaults.json has no failover.chain -- cannot check that the manifest order matches the failover priority order`);
  } else {
    const miss = declared.filter((k) => !chain.includes(k));
    const extra = chain.filter((k) => !declared.includes(k));
    if (miss.length || extra.length) {
      err(`manifest chainable channels [${declared.join(",")}] do not match config.defaults.json failover.chain [${chain.join(",")}]` +
        (miss.length ? ` -- absent from the chain: ${miss.join(",")}` : "") +
        (extra.length ? ` -- not in the manifest: ${extra.join(",")}` : ""));
    } else if (!setEq(declared, chain)) {
      err(`manifest declaration order [${declared.join(",")}] differs from config.defaults.json failover.chain [${chain.join(",")}] -- the matrix cell order IS the failover priority order (contract 2), so the two must be declared in the same sequence`);
    } else {
      ok(`manifest order == failover.chain priority: ${declared.join(" > ")}`);
    }
  }

  if (!findings.slice(C1_START).some((f) => f.level === "error")) {
    ok(`${keys.length} channels (${declared.length} chainable), ${REQUIRED_FIELDS.length} required fields each; key/path agree with each other and with server.mjs routes`);
  }
}

/* ============================================================================
 * C2 【已退役】原 guide 结构检查
 *   单页取消了「两步引导卡」，guide 字段与其结构检查一并消失；原本由它把关的
 *   credential 结构（kind ∈ 五值枚举 + label 非空）已并入 C1，见上面的 C1 段。
 *   这里保留一个可见的空检查，让 C 编号与契约第五节的表格逐行对得上，
 *   也让「它是被有意退役的、不是被漏掉的」这件事留在输出里。
 * ==========================================================================*/
setCheck("C2");
{
  const stillThere = keys.filter((k) => "guide" in manifest[k]);
  if (stillThere.length) {
    err(`${stillThere.join(",")}: field "guide" is still present -- the two-step guide card was removed by the single-page redesign; drop the field (step 1/2 of the flow now live in the credential view)`);
  } else {
    ok(`retired into C1 (credential.kind ∈ ${CRED_KINDS.join("/")} + non-empty label); no channel declares "guide" any more`);
  }
}

/* ============================================================================
 * C3 诊断结论文案：conclusion（就绪怎么判断）/ remedy（未就绪给什么建议）
 *   旧版这里是 notices 的结构与 {btn} 占位符。单页取消了一排提示条，
 *   换来诊断抽屉里的「结论 + 建议」——两段必填文案，缺一段抽屉就少一半信息。
 * ==========================================================================*/
setCheck("C3");
{
  for (const key of keys) {
    const P = manifest[key];
    let bad = 0;
    for (const f of ["conclusion", "remedy"]) {
      const v = P[f];
      if (typeof v !== "string" || !v.trim()) {
        err(`${key}: field "${f}" is ${typeOf(v)} -- expected a non-empty string (${f === "conclusion" ? "how to tell whether this channel is ready" : "what to do when it is not"}; the diagnostic drawer renders both)`);
        bad++;
        continue;
      }
      /* 占位符没人替换就会在页面上露出裸花括号 */
      const left = v.match(/\{[^}]*\}/g);
      if (left) {
        err(`${key}: ${f} has unresolved placeholder ${show(uniq(left).join(","))} -- nothing substitutes these in the diagnostic drawer; write the text literally`);
        bad++;
      }
    }
    /* 阶段一不编数据：这两段是判据与建议，不是状态快照。 */
    for (const f of ["conclusion", "remedy"]) {
      const v = P[f];
      if (typeof v !== "string") continue;
      if (/\b\d+\s*(?:分钟前|小时前|天前|次错误|条错误)/.test(v)) {
        err(`${key}: ${f} states a historical count/time ("${show(v)}") -- stage one has no error-history source; the drawer may only report what is currently known`);
        bad++;
      }
    }
    if (!bad) ok(`${key}: conclusion + remedy present (${String(P.conclusion).length} + ${String(P.remedy).length} chars)`);
  }
}

/* ============================================================================
 * C4 契约 id：各出现且仅出现一次（数组 = 契约 id 处置表的落地结果，顺序即核对顺序）
 * ==========================================================================*/
setCheck("C4");
{
  info(`CONTRACT_IDS = ${IDS_KEPT_AS_IS.length} kept-as-is + ${IDS_KEPT_NEW_MEANING.length} kept-with-new-semantics + ${IDS_NEW.length} new = ${CONTRACT_IDS.length}; the contract prose says "52 - 25 + 15 = 42" but its own per-id table lists 24 deletions (only 9 of which were in the old list) and 14 additions -- this array follows the per-id table, do not "fix" it to 42`);
  let bad = 0;
  for (const id of CONTRACT_IDS) {
    const n = countId(htmlNoComment, id);
    if (n === 0) { err(`id "${id}" (REFACTOR-CONTRACT-v17.md id 处置表) is missing from provider.html -- panel-common.js reads it, the element would be null`); bad++; }
    else if (n > 1) { err(`id "${id}" appears ${n} times in provider.html -- expected exactly 1 (getElementById returns only the first)`); bad++; }
  }
  if (bad) {
    err(`CONTRACT_IDS currently has ${CONTRACT_IDS.length} entries and at least one id failed the presence/uniqueness check -- if that is because the array itself was edited, remember the disposition table in REFACTOR-CONTRACT-v17.md 第二节, not the "42" in the prose`);
  }
  /* 处置表明确删掉的 id 必须真的不在模板里（红线：只许按那张表删，不许少删也不许多删）。
     用 DELETED_IDS（契约删除栏的原样转录）而不是 IN_FLIGHT_IDS：后者是 C5 的在途引用
     清单，范围与契约表不完全一致（多两个从未被契约追踪的旧 id，少两个从没人读的）。 */
  const ghosts = DELETED_IDS.filter((id) => countId(htmlNoComment, id) > 0);
  if (ghosts.length) {
    err(`id(s) ${ghosts.join(", ")} are on the disposition table's DELETE list but still present in provider.html -- the table is the only sanctioned removal list; either delete them here or amend the table in REFACTOR-CONTRACT-v17.md`);
    bad++;
  }
  if (!bad) ok(`${CONTRACT_IDS.length} contract ids, each exactly once in provider.html; none of the ${DELETED_IDS.length} deleted ids is present`);
}

/* ============================================================================
 * C5 反向检查：$("x") 引用无悬空
 * ==========================================================================*/
setCheck("C5");
{
  const htmlIds = new Set([...htmlNoComment.matchAll(/id\s*=\s*["']([A-Za-z0-9_-]+)["']/g)].map((m) => m[1]));

  /* 「由 JS 造出来」的 id：不在模板里，但确实会被 innerHTML / .id = / mk() / LAMP_DEFS
   * 插进 DOM。允许这些名字，否则检查会淹在假警报里。 */
  const created = new Set();
  const addCreated = (src) => {
    for (const m of src.matchAll(/\bid\s*=\s*["']([A-Za-z0-9_-]+)["']/g)) created.add(m[1]);
    for (const m of src.matchAll(/\.id\s*=\s*["']([A-Za-z0-9_-]+)["']/g)) created.add(m[1]);
    for (const m of src.matchAll(/\bmk\(\s*["']([A-Za-z0-9_-]+)["']/g)) created.add(m[1]);   // panel-common.js 的 mk() 造底栏按钮
    for (const m of src.matchAll(/(?:box|name|led|txt|sub):\s*["']([A-Za-z0-9_-]+)["']/g)) created.add(m[1]);  // LAMP_DEFS
  };
  const cardFiles = fs.existsSync(CARDS_DIR) ? fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith(".js")) : [];
  addCreated(commonJs);
  addCreated(read(F.providers));           // wireHint 里内嵌了 <span id="hintRelayPort">
  for (const f of cardFiles) addCreated(read(path.join(CARDS_DIR, f)));

  /* `q(".notice") || $("notice")` 这种写法本身就是「没有也行的兜底」，不算悬空 */
  const optional = new Set();
  for (const m of commonJs.matchAll(/[A-Za-z_$][\w.$]*\(\s*["'][^"']*["']\s*\)\s*\|\|\s*\$\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g)) optional.add(m[1]);

  const sources = [
    ["panel-common.js", commonJs],
    ["provider.html", htmlNoComment],
  ];
  /* id 也可能当字符串参数传给包装过的助手（onClick/applyText/has/on）而不走 $()。
   * 只收「第一个参数是 id」的那几个，别把 addEventListener("click", …) 之类算进来。 */
  const CALL_FORMS = [
    [/\$\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g, "$(\"id\")"],
    [/\b(?:onClick|applyText|has|on)\(\s*["']([A-Za-z0-9_-]+)["']\s*[,)]/g, "helper(\"id\", …)"],
  ];
  let bad = 0, tolerated = 0, scanned = 0;
  const inFlight = new Set(IN_FLIGHT_IDS.ids);
  const hitInFlight = new Set();
  for (const [name, src] of sources) {
    for (const [re, form] of CALL_FORMS) {
      for (const m of src.matchAll(re)) {
        const id = m[1];
        scanned++;
        if (htmlIds.has(id) || created.has(id)) continue;
        if (optional.has(id)) { tolerated++; continue; }
        /* 在途：处置表已把这个 id 从模板里删掉，但里程碑 4 还没跟上渲染层的删除。
           降级为 warn 并点名负责人 —— 未登记的悬空引用仍然是 error，判别力不变。 */
        if (inFlight.has(id)) { hitInFlight.add(id); continue; }
        err(`${name}: ${form.replace("$(\"id\")", '$("' + id + '")').replace("helper(\"id\", …)", id + " (string arg)")} targets an id that exists in neither provider.html nor any JS-injected markup -- dangling reference, the call is a silent no-op`);
        bad++;
      }
    }
  }
  if (hitInFlight.size) {
    warn(`${hitInFlight.size} in-flight reference(s) to id(s) removed by the disposition table: ${[...hitInFlight].sort().join(", ")} -- ${IN_FLIGHT_IDS.owner} must stop reading them; delete them from IN_FLIGHT_IDS once it does`);
  }
  /* 台账本身也要体检：登记了却没人引用的条目是过期豁免，会让闸门白白松一块，必须报出来。 */
  const staleLedger = IN_FLIGHT_IDS.ids.filter((id) => !hitInFlight.has(id) && !htmlIds.has(id));
  if (staleLedger.length) {
    warn(`IN_FLIGHT_IDS lists ${staleLedger.join(", ")} but nothing references them any more -- stale exemption, remove them from the ledger (check-manifest.cjs)`);
  }
  if (!bad) ok(`every id reference in panel-common.js / provider.html resolves (${scanned} scanned, ${tolerated} guarded by a "querySelector || $()" fallback, ${hitInFlight.size} in-flight per IN_FLIGHT_IDS)`);
}

/* ============================================================================
 * C6 视图级卡片表 ↔ cards/*.js 双向对账
 *   旧架构每页一份 extraCards，同一张卡在总览页挂一份、各家页挂另一份，天然会漂移。
 *   单页改版后卡片属于**视图**：window.BAI_VIEWS[].cards 是唯一清单。
 * ==========================================================================*/
setCheck("C6");
const C6_START = findings.length;
{
  const cardFiles = fs.existsSync(CARDS_DIR) ? fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith(".js")).sort() : [];
  if (!cardFiles.length) { err(`src/server/cards/ is missing or empty -- the view card slots have nothing to load`); }
  const exportsOf = new Map();
  for (const f of cardFiles) {
    const name = f.replace(/\.js$/, "");
    const full = path.join(CARDS_DIR, f);
    let sandbox;
    try { sandbox = evalInSandbox(full); }
    catch (e) {
      err(`cards/${f}: cannot be evaluated standalone -- ${e.message} (it must only touch the DOM inside mount())`);
      exportsOf.set(name, { ok: false }); continue;
    }
    const C = (sandbox.window && sandbox.window.BAI_CARDS) || {};
    const mod = C[name];
    if (!mod) {
      err(`cards/${f}: does not register window.BAI_CARDS["${name}"] -- the file name and the registry key must match (the renderer loads /cards/${name}.js then reads BAI_CARDS["${name}"])`);
      exportsOf.set(name, { ok: false }); continue;
    }
    if (typeof mod.mount !== "function") {
      err(`cards/${f}: window.BAI_CARDS["${name}"].mount is ${typeOf(mod.mount)} -- expected a function (the renderer calls it as mount(ctx))`);
      exportsOf.set(name, { ok: false }); continue;
    }
    /* 服务端 /cards/<name>.js 有白名单，卡名必须是小写 kebab，否则线上 400 */
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      err(`cards/${f}: card name "${name}" is not lowercase-kebab -- server.mjs only serves /cards/<name>.js matching /^[a-z][a-z0-9-]*$/, this would 400`);
      exportsOf.set(name, { ok: false }); continue;
    }
    exportsOf.set(name, { ok: true });
    ok(`cards/${f}: exports window.BAI_CARDS["${name}"].mount`);
  }

  /* 清单侧：视图表引用的名字必须有文件、必须是合法字符串、不得跨视图重复挂载 */
  const referenced = new Map();   // name -> [viewId]
  const viewIds = new Set();
  for (const v of views) {
    if (!v || typeof v !== "object" || Array.isArray(v)) { err(`BAI_VIEWS entry is ${typeOf(v)} -- expected { id, nav, dom, cards }`); continue; }
    if (typeof v.id !== "string" || !v.id.trim()) { err(`BAI_VIEWS entry has id ${typeOf(v.id)} -- expected a non-empty string`); continue; }
    if (viewIds.has(v.id)) { err(`BAI_VIEWS has two entries with id "${v.id}" -- view ids double as the URL hash segment`); }
    viewIds.add(v.id);
    const cs = v.cards;
    if (!Array.isArray(cs)) { err(`BAI_VIEWS[${v.id}].cards is ${typeOf(cs)} -- expected an array of card names (may be empty)`); continue; }
    for (const c of cs) {
      if (typeof c !== "string" || !c.trim()) { err(`BAI_VIEWS[${v.id}].cards contains ${typeOf(c)} -- expected non-empty card names`); continue; }
      if (!referenced.has(c)) referenced.set(c, []);
      if (referenced.get(c).includes(v.id)) {
        err(`BAI_VIEWS lists card "${c}" twice in view "${v.id}" -- it would be mounted twice`);
      }
      referenced.get(c).push(v.id);
      if (!exportsOf.has(c)) {
        err(`BAI_VIEWS[${v.id}].cards references "${c}" but src/server/cards/${c}.js does not exist -- the slot would silently render nothing`);
      }
    }
  }

  /* 反向：文件在、没人引用 = 死卡。里程碑 4 待删的已登记在 IN_FLIGHT_CARDS，降级为 warn。 */
  const retired = new Set(IN_FLIGHT_CARDS.names);
  for (const name of exportsOf.keys()) {
    if (referenced.has(name)) {
      ok(`card "${name}" is mounted by view(s) ${uniq(referenced.get(name)).join(", ")}`);
      continue;
    }
    if (retired.has(name)) {
      warn(`cards/${name}.js is referenced by no view and is registered in IN_FLIGHT_CARDS -- ${IN_FLIGHT_CARDS.owner}; delete the file and the ledger entry together`);
    } else {
      err(`cards/${name}.js is referenced by no view in BAI_VIEWS -- dead card, or a view forgot to list it`);
    }
  }
  const staleCards = IN_FLIGHT_CARDS.names.filter((n) => !exportsOf.has(n) || referenced.has(n));
  if (staleCards.length) {
    warn(`IN_FLIGHT_CARDS lists ${staleCards.join(", ")} but ${staleCards.map((n) => (exportsOf.has(n) ? "it is now referenced by a view" : "the file is already gone")).join("; ")} -- stale exemption, remove it from the ledger`);
  }
  if (!findings.slice(C6_START).some((f) => f.level === "error")) {
    ok(`view card table and cards/ agree: ${views.length} views, ${referenced.size} mounted card(s), ${exportsOf.size} file(s) on disk`);
  }
}

/* ============================================================================
 * C7 状态语义色：深浅两套主题都必须定义五色，且不得再有 per-provider 的 --accent 块
 *   旧版这里是「html[data-provider="x"] 配色块与清单 key 一一对应」——每家一套强调色。
 *   单页改版取消了它：颜色只承载状态（--ok 就绪 / --warn 需留意 / --err 故障 /
 *   --idle 未配置）与「本台自己的品牌 + 当前选中」（--brand）。
 *   html[data-provider] 属性本身保留（模板引导脚本仍在设它），只是不再定义 accent。
 * ==========================================================================*/
setCheck("C7");
const C7_START = findings.length;
{
  const SEMANTIC = ["--ok", "--warn", "--err", "--idle", "--brand"];
  const blocks = cssBlocks(commonCss);
  const themeVars = (re) => {
    const m = new Map();
    for (const b of blocks) if (re.test(b.sel)) for (const [k, v] of cssVars(b.body)) if (!m.has(k)) m.set(k, v);
    return m;
  };
  /* 深色 = :root（默认那一套）；浅色 = html[data-theme="light"]。两套都要自己给全五色。 */
  const darkVars = themeVars(/^:root$|^html\[data-theme=["']?dark/);
  const lightVars = themeVars(/^html\[data-theme=["']light/);

  const report = (themeName, vars) => {
    const missing = SEMANTIC.filter((c) => !vars.has(c) || !String(vars.get(c)).trim());
    if (!missing.length) return true;
    const what = `panel-common.css defines no value for ${missing.join(", ")} in the ${themeName} theme`;
    if (PALETTE_V17_READY) err(`${what} -- every state colour must exist in BOTH themes (contract 3: 状态语义色 + 品牌色)`);
    else warn(`${what} -- ${PALETTE_V17_READY ? "" : "milestone 3 (panel-common.css rebuild) has not landed yet, so this only warns; flip PALETTE_V17_READY to true in check-manifest.cjs when it has"}`);
    return false;
  };
  const darkOk = report("dark (:root)", darkVars);
  const lightOk = report("light (html[data-theme=\"light\"])", lightVars);

  /* 反向断言：不得再有 per-provider 的强调色块 */
  const accentBlocks = blocks.filter((b) => /data-provider\s*=/.test(b.sel) && /--accent\s*:/.test(b.body));
  if (accentBlocks.length) {
    const who = uniq(accentBlocks.map((b) => (b.sel.match(/data-provider=["']([A-Za-z0-9_-]+)["']/) || [])[1] || b.sel)).join(", ");
    if (PALETTE_V17_READY) {
      err(`panel-common.css still defines --accent inside ${accentBlocks.length} html[data-provider=…] block(s) (${who}) -- the per-provider accent palette is cancelled (contract 3); colour now carries state only`);
    } else {
      warn(`panel-common.css still defines --accent inside ${accentBlocks.length} html[data-provider=…] block(s) (${who}) -- legacy palette; milestone 3 removes it, then flip PALETTE_V17_READY to true`);
    }
  }

  const strict = PALETTE_V17_READY;
  if (darkOk && lightOk) {
    ok(strict
      ? `status semantic colours ${SEMANTIC.join(" ")} defined in both themes; no per-provider --accent block`
      : `status semantic colours ${SEMANTIC.join(" ")} (transition mode: warnings only until PALETTE_V17_READY is flipped by milestone 3)`);
  }
  if (!strict && !findings.slice(C7_START).some((f) => f.level === "error")) {
    info(`C7 is in TRANSITION mode (PALETTE_V17_READY=false): missing state colours and leftover --accent blocks warn instead of failing. Milestone 3 must set it to true.`);
  }
}

/* ============================================================================
 * C8 模型清单：providers.js 的 models 与 config.defaults.json 的 availableModels 逐项一致
 *   旧版只查 defaultModels 是不是个合法字符串数组。清单驱动之后，映射编辑区的下拉
 *   直接以清单 models 为准 —— 它与种子配置漂移，就等于「面板上写着一个种子配置里
 *   不存在的模型」。深色浅色不存在两套模型，所以「深浅与 qd 都不例外」在这里没有
 *   额外维度；真正不能例外的是**每一个渠道**（含默认模型为空的 bai/sn 与交还区）。
 * ==========================================================================*/
setCheck("C8");
{
  const missingCfg = [];
  for (const key of keys) {
    const P = manifest[key];
    const models = P.models;
    if (!Array.isArray(models)) { err(`${key}: field "models" is ${typeOf(models)} -- expected an array`); continue; }
    if (new Set(models).size !== models.length) {
      err(`${key}: field "models" has duplicate entries -- every id appears at most once in the dropdown`);
      continue;
    }
    /* bai 是 flat 形状：它的 availableModels 在种子配置顶层。
       不可接通的渠道（交还区）没有种子块，也就没有可比对的清单 —— 那是合法的。 */
    if (P.chainable === false) {
      if (models.length) {
        err(`${key}: field "models" has ${models.length} entries but the channel is not chainable (it has no mapping editor and no config block) -- expected []`);
      } else {
        ok(`${key}: not chainable, models = [] (no seed config block to reconcile against)`);
      }
      continue;
    }
    const cfgBlock = key === "bai" ? defaults : (defaults[key] || null);
    if (!cfgBlock || !Array.isArray(cfgBlock.availableModels)) {
      missingCfg.push(key);
      continue;
    }
    const cfgModels = cfgBlock.availableModels;
    const onlyManifest = models.filter((m) => !cfgModels.includes(m));
    const onlyCfg = cfgModels.filter((m) => !models.includes(m));
    if (onlyManifest.length || onlyCfg.length) {
      err(`${key}: models disagree with config.defaults.json${key === "bai" ? "" : "." + key}.availableModels` +
        (onlyManifest.length ? ` -- in the manifest only: ${show(onlyManifest.join(","))}` : "") +
        (onlyCfg.length ? ` -- in the seed config only: ${show(onlyCfg.join(","))}` : "") +
        `. The mapping dropdown renders the manifest list, so a model offered here could not be routed`);
    } else {
      ok(`${key}: ${models.length} model(s) identical to config.defaults.json${key === "bai" ? "" : "." + key}.availableModels`);
    }
    /* 「恢复默认模型」的种子必须来自同一份清单，否则按钮会把下拉里没有的模型装上去 */
    const dm = P.defaultModels;
    if (!Array.isArray(dm)) {
      err(`${key}: field "defaultModels" is ${typeOf(dm)} -- expected an array of model ids (may be [] when the channel has no reset button)`);
    } else {
      const stray = dm.filter((m) => !models.includes(m));
      if (stray.length) {
        err(`${key}: defaultModels ${show(stray.join(","))} not present in its own models list -- "reset to defaults" would install an un-routable target`);
      }
    }
  }
  if (missingCfg.length) {
    err(`config.defaults.json has no availableModels for chainable channel(s) ${missingCfg.join(", ")} -- the manifest list cannot be reconciled against the seed (${missingCfg.map((k) => `config.defaults.json.${k}`).join(", ")} missing)`);
  }
}

/* ============================================================================
 * C9（附加）视图分段：#navViews 的 data-view ↔ BAI_VIEWS[].id ↔ 模板里的视图容器
 *   单页改版后顶栏从 7 个页签变成 4 个视图分段。清单里少一个视图 = 那个视图的卡片
 *   永远不会被挂载；模板里少一个 data-view = 那一屏点不进去。三边必须一一对应。
 * ==========================================================================*/
setCheck("C9");
{
  const navEl = /<nav\b[^>]*\bid=["']navViews["'][^>]*>/.exec(htmlNoComment);
  if (!navEl) {
    err(`provider.html has no <nav id="navViews"> -- the view segment control is missing, so no view is reachable`);
  } else {
    /* 只取 navViews 容器内部（到匹配的 </nav> 为止）的 data-view，别把别处的 data-view 算进来 */
    const from = navEl.index + navEl[0].length;
    const inner = htmlNoComment.slice(from, from + (htmlNoComment.slice(from).indexOf("</nav>") + 6));
    const segs = [...inner.matchAll(/data-view\s*=\s*["']([A-Za-z0-9_-]+)["']/g)].map((m) => m[1]);
    const segLabels = [...inner.matchAll(/<button\b[^>]*data-view\s*=\s*["'][A-Za-z0-9_-]+["'][^>]*>([\s\S]*?)<\/button>/g)]
      .map((m) => m[1].replace(/<[^>]*>/g, "").trim());
    const dup = segs.filter((s, i) => segs.indexOf(s) !== i);
    if (dup.length) err(`navViews has duplicate data-view segment(s): ${uniq(dup).join(", ")} -- one click would land on two views`);

    const viewIds = views.map((v) => v && v.id).filter(Boolean);
    for (const id of viewIds) {
      if (!segs.includes(id)) {
        err(`BAI_VIEWS declares view "${id}" but navViews has no data-view="${id}" segment -- that view is unreachable from the header`);
      }
    }
    for (const s of segs) {
      if (!viewIds.includes(s)) {
        err(`navViews has a data-view="${s}" segment but BAI_VIEWS has no "${s}" entry -- clicking it would render an empty view`);
      }
    }
    /* 顶栏的中文标签也来自清单，两处各写一遍就会漂移 */
    views.forEach((v, i) => {
      if (!v || !v.id || !segs.includes(v.id)) return;
      const label = segLabels[segs.indexOf(v.id)];
      if (label !== undefined && v.nav !== undefined && label !== v.nav) {
        err(`nav segment data-view="${v.id}" shows "${show(label)}" but BAI_VIEWS[${v.id}].nav is ${show(v.nav)} -- the header label is written twice`);
      }
    });

    /* 每个视图都必须有对应的 DOM 容器，且容器里不能塞别的视图的内容 */
    const htmlIds = new Set([...htmlNoComment.matchAll(/id\s*=\s*["']([A-Za-z0-9_-]+)["']/g)].map((m) => m[1]));
    for (const v of views) {
      if (!v || !v.id) continue;
      const dom = v.dom || v.id;
      if (!htmlIds.has(dom)) {
        err(`BAI_VIEWS[${v.id}].dom is ${show(dom)} but provider.html has no id="${dom}" -- the view has no container to render into`);
      }
    }
    if (setEq(viewIds, uniq(segs))) ok(`view segments match: navViews [${segs.join(", ")}] == BAI_VIEWS [${viewIds.join(", ")}], each with a DOM container`);
  }
}

/* ============================================================================
 * C10（附加）凡是「直接返回模板」的路由，都必须能在清单里 path 精确匹配上
 *   panel-common.js 认页面靠清单 path 匹配当前 pathname，对不上就在入口处整个退出
 *   —— 页面只剩外壳，导航和底栏在、所有交互都不在，且没有任何提示。这比 404 难查得多。
 *   真发生过：重构初期 15 条路径里有 10 条都直接发模板，其中 10 条变成半死页。
 *   现在别名一律 302 重定向，这条检查用来防它复发。
 * ==========================================================================*/
setCheck("C10");
{
  /* 找出 server.mjs 里「直接 res.end(readFileSync(HERE/provider.html))」那条路由的路径集合 */
  const renderBlock = serverJs.match(/if \(req\.method === "GET"[\s\S]{0,400}?provider\.html\)\)\s*\{[\s\S]{0,300}?\}\s*\}/);
  const aliasMap = serverJs.match(/const PROVIDER_ALIAS = \{([\s\S]*?)\n\s*\};/);
  const served = renderBlock
    ? [...renderBlock[0].matchAll(/u\.pathname === "([^"]+)"/g)].map((m) => m[1])
    : [];
  const aliased = aliasMap ? [...aliasMap[1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]) : [];
  const normP = (p) => (p || "/").replace(/\/+$/, "") || "/";
  const manifestPaths = new Set(keys.map((k) => normP(manifest[k].path)));
  const canonical = new Set(["/", "/sn", "/wb", "/zen", "/qd", "/or"]);

  for (const pth of served) {
    if (canonical.has(normP(pth))) ok(`template route "${pth}" -> manifest path ${pth}`);
    else err(`server.mjs serves provider.html for "${pth}", but no manifest path matches it -- panel-common.js will bail out at "if (!P) return" and the page goes silently half-dead (shell renders, nothing is wired). Serve a canonical path or add a 302 alias.`);
  }
  for (const [from, to] of aliased) {
    if (manifestPaths.has(normP(to))) ok(`alias "${from}" -> "${to}" (has manifest path)`);
    else err(`alias "${from}" -> "${to}" has no matching manifest path -- the redirect lands on a page that cannot identify itself`);
  }
  const covered = new Set([...served.map(normP), ...aliased.map(([, to]) => normP(to))]);
  const missing = [...canonical].filter((c) => !covered.has(c));
  if (missing.length) err(`canonical path(s) ${missing.join(",")} are neither served nor reachable via an alias`);
}

/* ============================================================================
 * C11 渲染层不得再按提供方名字硬编码（v1.0.48 清单化收尾）
 *   panel-common.js 是全渠道共用渲染层，它一旦出现 `key === "bai"` 这类渠道字面量
 *   等值判断，就意味着「加第七家会漏改一处」的老毛病没根除——本轮就是来拔掉它们的。
 *   白名单：cards/*.js 不扫（卡的 PROVIDER 判断是它自己的事）；注释先剥掉再扫。
 * ==========================================================================*/
setCheck("C11");
{
  const PROVIDER_KEYS = Object.keys(EXPECTED_PATHS);   // bai/sn/wb/zen/qd
  const code = stripJsComments(commonJs);
  const quoted = PROVIDER_KEYS.map((k) => `(?:["']${k}["'])`).join("|");
  /* 空白类必须写成 [ \\t] 而不是模板串里的 \\s：\\s 在模板字面量里是**无效转义**，
     会退化成字母 s —— 那样正则就成了 /===s*"wb"/，永远匹配不到 === "wb"，
     这个闸门会变成永远绿灯（曾经的写法就踩了这条，用负样本才测出来）。 */
  const WS = "[ \\t]";
  /* 命中形态：===/!== 两侧任一侧是提供方字面量；或 [] 里用提供方字面量当下标 */
  const eqRe = new RegExp(`(?:===|!==)${WS}*(?:${quoted})|(?:${quoted})${WS}*(?:===|!==)`, "g");
  const idxRe = new RegExp(`\\[\\s*(?:${quoted})\\s*\\]`, "g");
  /* BAI_OURS 名单本身是允许的（它就是清单键集的投影），但必须是清单驱动；这里只在
     发现「字面量数组里排了一串提供方名」时报错——那是本契约要消灭的硬编码。 */
  const arrRe = new RegExp(`\\[\\s*(?:${quoted}\\s*,\\s*){2,}${quoted}\\s*\\]`, "g");

  const hits = [];
  const lineOf = (idx) => code.slice(0, idx).split("\n").length;
  for (const [re, what] of [[eqRe, "provider equality test"], [idxRe, "provider literal used as index"], [arrRe, "hard-coded provider name list"]]) {
    for (const m of code.matchAll(re)) {
      hits.push(`line ${lineOf(m.index)}: ${what} -> ${show(m[0].replace(/\s+/g, " "))}`);
    }
  }
  if (hits.length) {
    err(`panel-common.js still hard-codes provider names (${hits.length}):\n    ` + hits.slice(0, 12).join("\n    ") + `\n    -- move the branch into providers.js (shape/sys/keyMatch/modelsEndpoint/settingsLabels ...) so the renderer knows no provider by name`);
  } else {
    ok(`panel-common.js contains no provider-name equality test / literal index / name array (comments excluded; cards/*.js out of scope)`);
  }
}

/* ============================================================================
 * C12 渲染层必读的**新增渠道字段**每家都要有（清单化收尾的最后一层）
 *   C11 保证渲染层不认识渠道名，代价是「清单漏字段」不再报错、只是静默不渲染。
 *   C12 把里程碑 1 新增的那批字段补回来：缺一个就是矩阵格少一块、凭据行少一栏。
 *   同时断言这份表是 C1 必填表的**子集** —— 两处各写一份字段名时，漂移是最容易发生的。
 * ==========================================================================*/
setCheck("C12");
{
  const NEEDED = [
    { name: "letter", test: (v) => typeof v === "string" && /^[A-Za-z]{2,3}$/.test(v), want: '2 or 3 letters ("QD" / "BAI")' },
    { name: "name", test: (v) => typeof v === "string" && !!v.trim(), want: "non-empty string (matrix cell title)" },
    { name: "tagline", test: (v) => typeof v === "string" && !!v.trim(), want: "non-empty string (one-line subtitle)" },
    { name: "badge", test: (v) => v && typeof v === "object" && !Array.isArray(v) && typeof v.text === "string" && !!v.text.trim() && BADGE_KINDS.includes(v.kind), want: `{ text, kind } with kind ∈ ${BADGE_KINDS.join("/")}` },
    { name: "chainable", test: (v) => typeof v === "boolean", want: "boolean (is it in the failover chain?)" },
    { name: "credential", test: (v) => v && typeof v === "object" && !Array.isArray(v) && CRED_KINDS.includes(v.kind) && typeof v.label === "string" && !!v.label.trim(), want: `{ kind ∈ ${CRED_KINDS.join("/")}, label, hint }` },
    { name: "models", test: (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim()), want: "string array (may be empty for a non-chainable cell)" },
    { name: "mappingDefaults", test: (v) => v && typeof v === "object" && !Array.isArray(v), want: `object keyed by the four tiers (${TIER_KEYS.join(", ")})` },
  ];
  /* 防漂移：C12 的每一项都必须同时是 C1 的必填字段，否则两处会各说各话 */
  const notInC1 = NEEDED.map((f) => f.name).filter((n) => !REQUIRED_FIELDS.some((g) => g.name === n));
  if (notInC1.length) {
    err(`C12 requires ${notInC1.join(", ")} but C1's REQUIRED_FIELDS does not list ${notInC1.length === 1 ? "it" : "them"} -- the two field tables drifted; a channel could pass one check and fail the other for the same field`);
  }
  for (const key of keys) {
    const P = manifest[key];
    const miss = [];
    for (const f of NEEDED) {
      if (!f.test(P[f.name])) miss.push(`${f.name} (${typeOf(P[f.name])}; want ${f.want})`);
    }
    if (miss.length) {
      err(`${key}: renderer-critical manifest field(s) missing or malformed -- ${miss.join("; ")}. The renderer reads these unconditionally; a 7th channel that omits one renders silently wrong`);
    } else {
      ok(`${key}: letter/name/tagline/badge/chainable/credential/models/mappingDefaults all present and well-formed`);
    }
  }
}

/* ============================================================================
 * C13 种子配置不得带本机环境（发布陷阱）
 *
 *   config.defaults.json 是**随包的种子**：新机器首次启动时 DATA_DIR 下没有
 *   config.json，server.mjs 就把它当默认值读（server.mjs:29 的 seed 回退）。
 *   所以它一旦带上**本机的绝对路径 / 用户名**，就会随包发出去，所有新装机器
 *   都读到一条指向「发布机」的死路径。
 *
 *   实际踩过：qd.tokenFile 被写成 'C:\Users\admin\AppData\Local\Temp\qoder-token.json'
 *   （2026-10-06 实测发现）。幸而 server.mjs 的 fixQdFile() 读 config.json 时会自愈
 *   （父目录不存在就换回本机 os.tmpdir()），但那只是**运行期补丁、只覆盖 qd 两个字段**；
 *   别的字段（relayPort / upstream / wb.accessToken…）写脏了没人兜。
 *   所以这里在**构建期**拦一道。
 *
 *   判据：JSON 的字符串值里不得出现
 *     ① Windows 盘符绝对路径（X:\ 或 X:/）
 *     ② UNC 路径（\\server\share）
 *     ③ /Users/<name> 或 /home/<name>（macOS / Linux 家目录）
 *   合法的相对文件名（'qoder-token.json'）与空串都不受影响。
 * ==========================================================================*/
setCheck("C13");
{
  let raw = null;
  try {
    raw = fs.readFileSync(F.defaults, "utf8");
  } catch (e) {
    err(`config.defaults.json 读不到：${e.message}`);
  }
  if (raw !== null) {
    // 只在**字符串值**里找，避免把 JSON 结构本身误判
    const ABS_PATTERNS = [
      { rx: /^[A-Za-z]:[\\/]/, what: "Windows drive-absolute path" },
      { rx: /^\\\\[^\\]/, what: "UNC path" },
      { rx: /^\/(?:Users|home)\//i, what: "macOS/Linux home path" },
      { rx: /[A-Za-z]:[\\/](?:Users|Program Files|Windows|Temp)[\\/]/i, what: "machine-specific path fragment" },
    ];
    let hits = 0;
    const walk = (node, trail) => {
      if (typeof node === "string") {
        for (const p of ABS_PATTERNS) {
          if (p.rx.test(node)) {
            err(`${trail || "(root)"}: seed config carries a machine-specific path (${p.what}) -- "${show(node)}". config.defaults.json ships inside the installer, so a hard-coded path makes every fresh machine read the publisher's path. Use "" or a bare filename`);
            hits++;
            break;
          }
        }
        return;
      }
      if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${trail}[${i}]`)); return; }
      if (node && typeof node === "object") {
        for (const k of Object.keys(node)) walk(node[k], trail ? `${trail}.${k}` : k);
      }
    };
    try {
      walk(JSON.parse(raw), "");
    } catch (e) {
      err(`config.defaults.json 不是合法 JSON：${e.message}`);
    }
    // 同类陷阱的另一个入口：字符串里直接出现本机用户名（多半是被拼进路径或标识）
    const uname = process.env.USERNAME || "";
    if (uname && uname.length >= 3) {
      const lower = uname.toLowerCase();
      const walkUser = (node, trail) => {
        if (typeof node === "string") {
          if (node.toLowerCase().includes(lower)) {
            err(`${trail || "(root)"}: seed config mentions the build machine's username "${uname}" -- "${show(node)}". It will mis-bind on every other machine`);
            hits++;
          }
          return;
        }
        if (Array.isArray(node)) { node.forEach((v, i) => walkUser(v, `${trail}[${i}]`)); return; }
        if (node && typeof node === "object") {
          for (const k of Object.keys(node)) walkUser(node[k], trail ? `${trail}.${k}` : k);
        }
      };
      try { walkUser(JSON.parse(raw), ""); } catch { /* JSON 错误上面已报过，不重复 */ }
    }
    if (!hits) ok("config.defaults.json carries no machine-specific paths or usernames");
  }
}

/* ============================================================================
 * 打印
 * ==========================================================================*/

const CHECK_TITLES = {
  C1: "channel manifest completeness + key/path vs server.mjs routes + declaration order == failover chain",
  C2: "guide structure (RETIRED -- folded into C1's credential structure check)",
  C3: "diagnostic conclusion + remedy text",
  C4: "contract ids in provider.html (exactly once each; = the id disposition table)",
  C5: "reverse check: no dangling id reference ($ / onClick / applyText / has)",
  C6: "view card table (BAI_VIEWS[].cards) vs cards/*.js",
  C7: "status semantic colours in both themes + no per-provider --accent blocks",
  C8: "manifest models == config.defaults.json availableModels",
  C9: "view segments: navViews data-view vs BAI_VIEWS[].id vs DOM containers",
  C10: "every server route that renders the template has a matching manifest path",
  C11: "panel-common.js must not hard-code channel names",
  C12: "renderer-critical channel fields present for every channel",
  C13: "seed config must not carry machine-specific paths/usernames",
};
const ORDER = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "C11", "C12", "C13"];

console.log("check-manifest -- provider panel manifest/template consistency gate");
console.log("root: " + ROOT);
console.log("(non-ASCII characters are printed as '?' -- the Windows console is GBK; read the source file for exact text)");
console.log("");

const MARK = { ok: "  ok  ", info: "  -   ", warn: "  WARN", error: "  FAIL" };
let errors = 0, warns = 0;
for (const id of ORDER) {
  const rows = findings.filter((f) => f.check === id);
  const nErr = rows.filter((r) => r.level === "error").length;
  const nWarn = rows.filter((r) => r.level === "warn").length;
  errors += nErr; warns += nWarn;
  console.log(`[${id}] ${CHECK_TITLES[id] || ""}  (${nErr} error, ${nWarn} warn)`);
  for (const r of rows) console.log(MARK[r.level] + " " + r.text);
  if (!rows.length) console.log("  -    (no data to check)");
  console.log("");
}

console.log(`--- ${errors} error(s), ${warns} warn(s) ---`);
if (errors) {
  console.log("check-manifest FAILED -- fix the files named above, then re-run. Nothing was modified.");
  process.exit(1);
}
console.log("check-manifest OK -- manifest, template, cards and palette agree.");
process.exit(0);
