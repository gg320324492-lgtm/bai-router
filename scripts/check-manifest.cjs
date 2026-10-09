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
 * 十二类检查（C1–C8 对应约定的八项，C9–C12 是后续补的）：
 *   C1 清单完整性 + key/path 与 server.mjs 注册路由一致
 *   C2 guide 结构
 *   C3 notices 结构 + {btn} 占位符可替换 + 死键（没人读的 notice）
 *   C4 契约 id 在 provider.html 里各出现且仅出现一次
 *   C5 反向检查：id 引用无悬空（$() 以及 onClick/applyText/has 的字符串参数形式）
 *   C6 插槽契约：cards/*.js 都导出 mount，extraCards 双向对账
 *   C7 配色：html[data-provider="x"] 与清单 key 一一对应
 *   C8 模型列表：每家的 defaultModels 都是清单里的字符串数组（v1.0.48 起只认清单；
 *      允许空数组——bai/sn 本就没有「恢复默认模型」按钮，见该检查处的说明）
 *   C9 导航 tab 与清单 key/path 一一对应——加了清单忘了加 tab，页面上根本点不到
 *   C10 凡是「直接返回模板」的路由，都必须能在清单里 path 精确匹配上
 *   C11 panel-common.js 不得再按提供方名字硬编码（清单化收尾；cards/*.js 与注释不扫）
 *   C12 渲染层无条件读取的形状字段（shape/keyMatch/sys/brands/defaultModels/settingsLabels）
 *       每家都要有——加第六家漏改的新防线
 *
 * 零依赖：只用 Node 内置模块。
 *
 * 约定：本脚本**只读**。它不修任何东西——修哪个文件、填什么值，全部打在输出里。
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

/* ============================================================================
 * 契约常量（改这里 = 改 docs/contracts/REFACTOR-CONTRACT.md，两边要一起改）
 * ==========================================================================*/

/* C4：docs/contracts/REFACTOR-CONTRACT.md「元素 id 约定」里逐条列出的 id。
 * 注意 #bnrUpdate / #updBtn / #btnSelfUpd / #stopBtn **不在**这里——契约写明它们由
 * panel-common.js 注入，模板里本就不该有。（见 provider.html 顶部注释同一句。） */
const CONTRACT_IDS = [
  "svc",
  "themeBtn", "themeIcon", "themeText",
  "winMin", "winMax", "winClose",
  "ledRelay", "txtRelay", "subRelay",
  "ledUp", "txtUp", "subUp",
  "ledTok", "txtTok", "subTok",
  "patchTime", "patchCli", "cliBadge", "patchDesk", "deskBadge",
  "btnApply", "btnRestore", "ckCli", "ckDesk", "applyResult",
  "guideAux", "step1", "state1", "step2", "state2",
  "routeBody", "btnSave", "btnTest", "ckAllTiers", "testResult",
  "slot-extra",
  "cardSys", "headSys", "fUpstream", "fRelayPort", "fModels", "ckUseProxy",
  "btnSaveSys", "btnDeploy", "sysResult",
  "footPaths", "verTxt",
  "bnrInfo", "bnrInfoTitle", "bnrInfoMsg", "bnrInfoX",
];

/* C1：清单必填字段。type 见 typeOf() 的返回风格。 */
const REQUIRED_FIELDS = [
  { name: "key", type: "str" },
  { name: "path", type: "str" },
  { name: "tab", type: "str" },
  { name: "h1", type: "str" },
  { name: "sub", type: "str" },
  { name: "title", type: "str" },
  { name: "accentLabel", type: "str" },
  { name: "targetName", type: "str" },
  { name: "lamps", type: "strArr" },
  { name: "guide", type: "any" },        // 结构另由 C2 把关
  { name: "notices", type: "obj" },     // 结构另由 C3 把关
  { name: "extraCards", type: "strArr" },  // 允许为空数组
  { name: "settingsTitle", type: "str" },
];

const EXPECTED_PATHS = { home: "/", bai: "/bai", sn: "/sn", wb: "/wb", zen: "/zen", qd: "/qd", or: "/or" };

/* ============================================================================
 * 载入
 * ==========================================================================*/

let manifest, html, htmlNoComment, commonJs, commonCss, serverJs, defaults;
try {
  manifest = evalInSandbox(F.providers).window.BAI_PROVIDERS;
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

/* primaryBtn 的算法与 panel-common.js 逐字一致（SHORT = shortName || lampNames.relay），
 * 否则 C3 会用错误的按钮名去验 {btn} 替换。 */
const primaryBtnOf = (key) => {
  const P = manifest[key];
  const SHORT = P.shortName || String((P.lampNames && P.lampNames.relay) || "");
  return P.primaryBtn || `${P.accentLabel || "接通"} ${SHORT}`;
};

/* ============================================================================
 * C1 清单完整性 + key/path 与 server.mjs 注册路由一致
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

    /* 对象键与 key 字段必须一致——加第六家最容易在这里只改一半 */
    if (P.key !== key) {
      err(`${key}: field "key" is ${show(P.key)} -- expected "${key}" (the manifest object key; rename both together)`);
    }

    for (const f of REQUIRED_FIELDS) {
      const v = P[f.name];
      if (f.type === "str") {
        if (typeof v !== "string" || !v.trim()) {
          err(`${key}: field "${f.name}" is ${typeOf(v)} -- expected a non-empty string`);
        }
      } else if (f.type === "strArr") {
        if (!Array.isArray(v)) {
          err(`${key}: field "${f.name}" is ${typeOf(v)} -- expected an array of non-empty strings (may be empty for extraCards)`);
        } else if (v.some((x) => typeof x !== "string" || !x.trim())) {
          err(`${key}: field "${f.name}" is ${typeOf(v)} -- expected every item to be a non-empty string`);
        }
      } else if (f.type === "obj") {
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          err(`${key}: field "${f.name}" is ${typeOf(v)} -- expected a plain object`);
        }
      }
    }

    /* path 形状：home 是 "/"，其余（含 bai）都是 "/" + key */
    if (typeof P.path === "string" && P.path) {
      const want = key === "home" ? "/" : "/" + key;
      const shapeOk = P.path === want;
      if (!shapeOk) {
        err(`${key}: field "path" is ${show(P.path)} -- expected "${want}"`);
      } else if (EXPECTED_PATHS[key] && P.path !== EXPECTED_PATHS[key]) {
        /* EXPECTED_PATHS 是本轮定下的五家硬约定；形状规则已过才查它，免得同一处报两遍 */
        err(`${key}: field "path" is ${show(P.path)} -- expected ${show(EXPECTED_PATHS[key])} (hard-coded contract in check-manifest.cjs)`);
      }
      if (seenPath.has(P.path)) {
        err(`${key}: field "path" is ${show(P.path)} -- already used by "${seenPath.get(P.path)}"; two providers on one route`);
      } else seenPath.set(P.path, key);
    }

    /* path 必须在 server.mjs 的 GET 路由里真的注册，否则打开就是 404 */
    const routeRe = new RegExp("u\\.pathname\\s*===\\s*[\"']" + P.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\"']");
    if (!routeRe.test(serverJs)) {
      err(`${key}: path ${show(P.path)} is not registered in server.mjs (no 'u.pathname === "${P.path}"' branch) -- the page would 404`);
    }
  }

  if (!serverJs.includes("provider.html")) {
    err(`server.mjs never serves provider.html -- the whole page is unreachable`);
  }
  if (!findings.slice(C1_START).some((f) => f.level === "error")) {
    ok(`${keys.length} providers, ${REQUIRED_FIELDS.length} required fields each; key/path agree with each other and with server.mjs routes`);
  }
}

/* ============================================================================
 * C2 guide 结构
 * ==========================================================================*/
setCheck("C2");
{
  for (const key of keys) {
    const g = manifest[key].guide;
    if (!Array.isArray(g)) { err(`${key}: field "guide" is ${typeOf(g)} -- expected an array`); continue; }
    if (g.length === 0) {
      /* 模板只有 #step1/#step2 两步；清单写 [] = 本页没有引导卡，panel-common.js 会
       * 用 HAS_GUIDE 跳过整张卡（providers.js 里 bai/sn 就是这样）。所以 0 是合法的，
       * 1 才是「写了一半」的漂移。 */
      info(`${key}: guide is [] (no guide card on this page -- allowed; panel-common.js hides the card)`);
      continue;
    }
    if (g.length !== 2) {
      err(`${key}: field "guide" has ${g.length} item(s) -- expected 0 (no guide card) or 2 (template only has #step1/#step2), got ${show(g)}`);
      continue;
    }
    let bad = 0;
    g.forEach((step, i) => {
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        err(`${key}: guide[${i}] is ${typeOf(step)} -- expected { title, desc }`); bad++; return;
      }
      for (const f of ["title", "desc"]) {
        if (typeof step[f] !== "string" || !step[f].trim()) {
          err(`${key}: guide[${i}].${f} is ${typeOf(step[f])} -- expected a non-empty string`);
          bad++;
        }
      }
    });
    if (!bad) ok(`${key}: guide has 2 steps, both with title+desc`);
  }
}

/* ============================================================================
 * C3 notices 结构 + {btn} 占位符
 * ==========================================================================*/
setCheck("C3");
{
  /* panel-common.js 读 notice 的两种方式：
   *   1. 静态键     txt = fill(NT.ccBoth, {}) / NT.keyMismatch / NT.other / NT.ccSwitch / NT.stale
   *   2. 动态键     txt = fill(NT[other.mode] || NT.other || NT.stale, {}) —— 「另一端接在谁
   *      身上」就取以那个 provider key 命名的文案。
   * 所以合法的 notice 键 = 上面那批静态键 ∪ 所有 provider key。写了别的（比如把 onWb 打成
   * onWbb）就是死键，提示条永远不显示——而这正是「漏改一处」最难自己发现的一类。 */
  const staticKeys = new Set([...commonJs.matchAll(/\bNT\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const dynamicLookup = /NT\[\s*other\s*\.\s*mode\s*\]/.test(commonJs);

  /* panel-common.js 按 NT[other.mode] 动态取文案，缺键就掉到通用 stale —— 这本身没问题，
   * **只要 stale 真的是通用的**。真事故是：bai 的 stale 里装的是 SenseNova 专属文案，于是
   * 另一端接在 zen/qd 上时也显示「接在 SenseNova 上」，点名了错的一家。
   * 所以规则是：stale 一旦点了某家的名，就必须为**每一家**都备好分列文案。 */
  const PROVIDER_WORDS = {
    bai: "B.AI", sn: "SenseNova", wb: "WorkBuddy", zen: "OpenCode Zen", qd: "Qoder",
  };
  if (dynamicLookup) {
    for (const key of keys) {
      const N = manifest[key].notices || {};
      const stale = String(N.stale || "");
      /* stale 里点名了别家（不含自己）→ 说明它不是通用兜底，必须分列齐全 */
      const named = Object.keys(PROVIDER_WORDS)
        .filter((k) => k !== key && stale.includes(PROVIDER_WORDS[k]));
      if (!named.length) continue;
      const missing = keys
        .filter((k) => k !== key && !(N[k] && String(N[k]).trim()))
        .filter((k) => named.includes(k) || true);
      if (missing.length) {
        err(`${key}: notices.stale names a specific provider (${named.map((k) => PROVIDER_WORDS[k]).join("/")}) but has no per-channel text for ${missing.join(",")} -- panel-common.js reads NT[other.mode]; those channels would fall back to stale and be told they are on the wrong provider`);
      }
    }
  }

  for (const key of keys) {
    const P = manifest[key];
    const N = P.notices;
    if (!N || typeof N !== "object" || Array.isArray(N)) { err(`${key}: field "notices" is ${typeOf(N)} -- expected an object with stale + ccSwitch`); continue; }
    const btn = primaryBtnOf(key);
    let bad = 0;
    for (const f of ["stale", "ccSwitch"]) {
      const v = N[f];
      if (typeof v !== "string" || !v.trim()) {
        err(`${key}: notices.${f} is ${typeOf(v)} -- expected a non-empty string (both notices are rendered on every page)`);
        bad++; continue;
      }
      /* panel-common.js 的 fill() 只替换 {btn}，别的占位符没人管——所以替换后残留 '{'
       * 就是「写了占位符但渲染层填不上」，页面上会露出一个裸的花括号。 */
      const filled = v.replace(/\{btn\}/g, btn);
      const left = filled.match(/\{[^}]*\}/g);
      if (left) {
        err(`${key}: notices.${f} has unresolved placeholder ${show(uniq(left).join(","))} after {btn} -> "${show(btn)}" -- panel-common.js fill() only substitutes {btn}; write the button text literally or use {btn}`);
        bad++;
      }
    }
    /* 死键检查：{btn} 残留也照样跑，坏键要一起报出来 */
    for (const nk of Object.keys(N)) {
      if (nk === "stale" || nk === "ccSwitch") continue;
      const readable = staticKeys.has(nk) || (dynamicLookup && keys.includes(nk));
      if (!readable) {
        const how = staticKeys.size ? `panel-common.js reads ${[...staticKeys].sort().map((x) => "NT." + x).join("/")}` : "panel-common.js reads no static NT.* keys";
        warn(`${key}: notices.${nk} is never read -- ${how}${dynamicLookup ? `, plus NT[other.mode] for ${keys.join("/")}` : ""}; rename it to one of those or delete it`);
      }
    }
    if (!bad) ok(`${key}: notices.stale + notices.ccSwitch present, {btn} -> "${show(btn)}" resolves cleanly`);
  }
}

/* ============================================================================
 * C4 契约 id：各出现且仅出现一次
 * ==========================================================================*/
setCheck("C4");
{
  let bad = 0;
  for (const id of CONTRACT_IDS) {
    const n = countId(htmlNoComment, id);
    if (n === 0) { err(`id "${id}" (docs/contracts/REFACTOR-CONTRACT.md "element id" list) is missing from provider.html -- panel-common.js reads it, the element would be null`); bad++; }
    else if (n > 1) { err(`id "${id}" appears ${n} times in provider.html -- expected exactly 1 (getElementById returns only the first)`); bad++; }
  }
  if (!bad) ok(`${CONTRACT_IDS.length} contract ids, each exactly once in provider.html`);
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
  for (const [name, src] of sources) {
    for (const [re, form] of CALL_FORMS) {
      for (const m of src.matchAll(re)) {
        const id = m[1];
        scanned++;
        if (htmlIds.has(id) || created.has(id)) continue;
        if (optional.has(id)) { tolerated++; continue; }
        err(`${name}: ${form.replace("$(\"id\")", '$("' + id + '")').replace("helper(\"id\", …)", id + " (string arg)")} targets an id that exists in neither provider.html nor any JS-injected markup -- dangling reference, the call is a silent no-op`);
        bad++;
      }
    }
  }
  if (!bad) ok(`every id reference in panel-common.js / provider.html resolves (${scanned} scanned, ${tolerated} guarded by a "querySelector || $()" fallback)`);
}

/* ============================================================================
 * C6 插槽契约：cards/*.js 都导出 mount；extraCards 双向对账
 * ==========================================================================*/
setCheck("C6");
{
  const cardFiles = fs.existsSync(CARDS_DIR) ? fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith(".js")).sort() : [];
  if (!cardFiles.length) { err(`src/server/cards/ is missing or empty -- extraCards slots have nothing to load`); }
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
      err(`cards/${f}: does not register window.BAI_CARDS["${name}"] -- the file name and the registry key must match (panel-common.js loads /cards/${name}.js then reads BAI_CARDS["${name}"])`);
      exportsOf.set(name, { ok: false }); continue;
    }
    if (typeof mod.mount !== "function") {
      err(`cards/${f}: window.BAI_CARDS["${name}"].mount is ${typeOf(mod.mount)} -- expected a function (panel-common.js calls it as mount(ctx))`);
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

  /* 清单侧：引用的名字必须有文件 */
  const referenced = new Map();   // name -> [keys]
  for (const key of keys) {
    const ec = manifest[key].extraCards;
    if (!Array.isArray(ec)) continue;
    for (const c of ec) {
      if (typeof c !== "string" || !c.trim()) continue;
      if (!referenced.has(c)) referenced.set(c, []);
      referenced.get(c).push(key);
      if (!exportsOf.has(c)) {
        err(`${key}: extraCards references "${c}" but src/server/cards/${c}.js does not exist -- the slot would silently render nothing`);
      }
    }
  }
  /* 反向：文件在、没人引用 -> 只提示（可能是有意留下的公共模块） */
  for (const name of exportsOf.keys()) {
    if (!referenced.has(name)) {
      warn(`cards/${name}.js is never referenced by any provider's extraCards -- dead card, or a provider forgot to list it`);
    }
  }
}

/* ============================================================================
 * C7 配色：html[data-provider="x"] 与清单 key 一一对应
 * ==========================================================================*/
setCheck("C7");
{
  const cssProviders = uniq([...commonCss.matchAll(/html\[[^\]]*data-provider\s*=\s*["']([A-Za-z0-9_-]+)["'][^\]]*\]/g)].map((m) => m[1]));

  for (const key of keys) {
    const dark = new RegExp('html\\[data-provider="' + key + '"\\]\\s*\\{([^}]*)\\}').exec(commonCss);
    if (!dark) {
      err(`no html[data-provider="${key}"] block in panel-common.css -- this page falls back to the default palette silently (palette blocks currently defined: ${cssProviders.length ? cssProviders.join(", ") : "none"})`);
    } else if (!/--accent\s*:/.test(dark[1])) {
      err(`html[data-provider="${key}"] defines no --accent -- the page would render with an undefined accent color`);
    } else {
      const light = new RegExp('html\\[data-theme="light"\\]\\[data-provider="' + key + '"\\]\\s*\\{').test(commonCss);
      if (!light) warn(`no html[data-theme="light"][data-provider="${key}"] block -- light theme keeps the dark accent`);
      else ok(`html[data-provider="${key}"] (dark + light) present`);
    }
  }
  for (const p of cssProviders) {
    if (!keys.includes(p)) {
      err(`panel-common.css has html[data-provider="${p}"] but no provider "${p}" in providers.js -- orphaned palette (renamed provider? stale block?)`);
    }
  }
  if (setEq(keys, cssProviders)) ok(`palette blocks match manifest keys exactly: ${keys.join(", ")}`);
}

/* ============================================================================
 * C8 模型列表：每家都能拿到非空列表
 * ==========================================================================*/
setCheck("C8");
{
  /* v1.0.48：panel-common.js 的 FB 兜底表已删，defaultModels 只认清单。
     契约原文要求「非空数组」，但 bai/sn 本就没有固定默认清单（FB 里也没有 defaultModels，
     旧页的「恢复默认模型」按钮对这两家一直是隐藏的）。为不改用户可见行为，这里放宽为
     **必须存在且是合法字符串数组（允许为空 []）**：[] 表示本页没有「恢复默认模型」按钮，
     与旧行为一致；真正要防的是「加第六家漏写这个字段」。 */
  for (const key of keys) {
    const P = manifest[key];
    const dm = P.defaultModels;
    if (!Array.isArray(dm)) {
      err(`${key}: field "defaultModels" is ${typeOf(dm)} -- expected an array of non-empty model ids in providers.js (may be [] when the page has no reset-defaults button; panel-common.js reads it directly, the fallback table FB is gone)`);
    } else if (dm.some((x) => typeof x !== "string" || !x.trim())) {
      err(`${key}: field "defaultModels" is ${typeOf(dm)} -- expected every item to be a non-empty string`);
    } else {
      const fromManifest = Array.isArray(P.availableModels) && P.availableModels.length
        && P.availableModels.every((x) => typeof x === "string" && x.trim()) ? P.availableModels : null;
      if (P.availableModels !== undefined && !fromManifest) {
        err(`${key}: field "availableModels" is ${typeOf(P.availableModels)} -- expected a non-empty array of non-empty model ids`);
      }
      const cfgBlock = key === "bai" ? defaults : (defaults[key] || {});
      const cfgModels = Array.isArray(cfgBlock.availableModels) ? cfgBlock.availableModels : null;
      const sources = [
        fromManifest && "providers.js:availableModels",
        "providers.js:defaultModels",
        cfgModels && `config.defaults.json:${key === "bai" ? "" : key + "."}availableModels`,
      ].filter(Boolean);
      ok(`${key}: defaultModels from providers.js (${dm.length}: ${show(dm.join(","))}); model list also from ${sources.join(" + ")}`);
    }
  }
}

/* ============================================================================
 * C9（附加）导航 tab 与清单 key/path 一一对应
 *   加了第六家却忘了在模板里加 .prov-tab -> 页面上根本点不到，而所有检查都还是绿的
 * ==========================================================================*/
/* ============================================================================
 * C10（附加）凡是「直接返回模板」的路由，都必须能在清单里 path 精确匹配上
 *   panel-common.js 认页面靠 `normPath(MANIFEST[k].path) === location.pathname`，
 *   对不上就在 `if (!P ...) return` 处整个退出 —— 页面只剩外壳，导航和底栏在、
 *   所有交互都不在，且没有任何提示。这比 404 难查得多。
 *   真发生过：重构初期 15 条路径里有 10 条（含 /index.html、/sensenova…）都直接发模板，
 *   其中 10 条变成半死页。现在别名一律 302 重定向，这条检查用来防它复发。
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

setCheck("C9");
{
  const tabs = [...htmlNoComment.matchAll(/<a\s[^>]*class="[^"]*prov-tab[^"]*"[^>]*>/g)].map((m) => m[0]);
  const tabKeys = tabs.map((t) => (t.match(/data-key\s*=\s*["']([A-Za-z0-9_-]+)["']/) || [])[1]).filter(Boolean);
  const tabHrefs = tabs.map((t) => (t.match(/href\s*=\s*["']([^"']*)["']/) || [])[1]).filter(Boolean);

  for (const key of keys) {
    if (!tabKeys.includes(key)) {
      err(`provider.html has no <a class="prov-tab" data-key="${key}"> -- the page exists but is unreachable from the nav bar`);
    } else {
      const href = tabHrefs[tabKeys.indexOf(key)];
      if (href !== manifest[key].path) {
        err(`nav tab data-key="${key}" has href="${show(href)}" -- expected the manifest path "${show(manifest[key].path)}"`);
      }
    }
  }
  for (const k of tabKeys) {
    if (!keys.includes(k)) err(`provider.html has a nav tab data-key="${k}" but providers.js has no "${k}" entry -- clicking it would render a blank page`);
  }
  if (setEq(keys, uniq(tabKeys))) ok(`nav tabs match manifest keys and hrefs: ${tabKeys.join(", ")}`);
}

/* ============================================================================
 * C11 渲染层不得再按提供方名字硬编码（v1.0.48 清单化收尾）
 *   panel-common.js 是五页共用渲染层，它一旦出现 `key === "bai"` 这类提供方字面量
 *   等值判断，就意味着「加第六家会漏改一处」的老毛病没根除——本轮就是来拔掉它们的。
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
 * C12 每家必须给出渲染层依赖的形状字段（加第六家漏改的新防线）
 *   C11 保证渲染层不认识提供方名字，代价是「清单漏字段」不再报错、只是静默不渲染。
 *   C12 把 panel-common.js 无条件读取的那批字段补回来：缺了就是加第六家时的漏改。
 * ==========================================================================*/
setCheck("C12");
{
  const NEEDED = [
    { name: "shape", test: (v) => v === "flat" || v === "nested", want: '"flat" or "nested"' },
    { name: "keyMatch", test: (v) => typeof v === "string" && v.trim() !== "", want: "non-empty string (status field to compare credentials)" },
    { name: "sys", test: (v) => v && typeof v === "object" && !Array.isArray(v), want: "plain object (button/field visibility switches)" },
    { name: "brands", test: (v) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0, want: "non-empty object (model-prefix -> display name)" },
    { name: "defaultModels", test: (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim()), want: "string array (may be empty; [] = no reset-defaults button)" },
    { name: "settingsLabels", test: (v) => v && typeof v === "object" && typeof v.relayPort === "string" && v.relayPort.trim() !== "", want: "object with a non-empty relayPort label" },
  ];
  for (const key of keys) {
    const P = manifest[key];
    const miss = [];
    for (const f of NEEDED) {
      if (!f.test(P[f.name])) miss.push(`${f.name} (${typeOf(P[f.name])}; want ${f.want})`);
    }
    if (miss.length) {
      err(`${key}: renderer-critical manifest field(s) missing or malformed -- ${miss.join("; ")}. panel-common.js reads these unconditionally; a 6th provider that omits one renders silently wrong`);
    } else {
      ok(`${key}: shape/keyMatch/sys/brands/defaultModels/settingsLabels all present`);
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
  C1: "manifest completeness + key/path vs server.mjs routes",
  C2: "guide structure",
  C3: "notices structure + {btn} placeholder",
  C4: "contract ids in provider.html (exactly once each)",
  C5: "reverse check: no dangling id reference ($ / onClick / applyText / has)",
  C6: "card slot contract (cards/*.js export mount)",
  C7: "palette: html[data-provider] blocks vs manifest keys",
  C8: "model list available for every provider",
  C9: "nav tabs vs manifest keys/paths",
  C10: "every server route that renders the template has a matching manifest path",
  C11: "panel-common.js must not hard-code provider names",
  C12: "renderer-critical manifest fields present for every provider",
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
