/* scripts/cred-accordion-test.mjs —— 凭据视图手风琴（docs/ui-redesign.md 的 P3）的口径测试。
 *
 * ## 测什么
 *
 * 凭据屏从「八家各占一整块」改成「一家一行，点开才看细节」。这一改动的风险
 * 不在样式，在**结构**：凭据行是卡片（cards/*.js）的挂载点，谁动了它的骨架，
 * 那几张卡就悄悄不再有地方挂 —— 而卡片不会报错，只是不见了。
 *
 *   ★ ① **行的钩子一个都不能少**：class=credrow、data-k、data-role="detail"
 *        （卡片挂点）、data-role="state"、data-role="act"。
 *   ★ ② **状态是数据，不是装饰**：折叠那一行上的药丸必须由 credState 决定
 *        （措辞 + 语义色都从数据来），不许各画各的；一行只许有一个药丸。
 *   ★ ③ **不藏坏消息**：warn / err 的原因在**收起时**也要看得见。
 *   ★ ④ **按钮契约不许变**：data-act 的名字与接线（尤其 toggle 的单独接线、
 *        「轮换区编辑器打开时不重新接线」那条）一字不改。
 *   ★ ⑤ **C7 语义色**：新样式里不许写死颜色。
 *
 * ## 怎么测的
 *
 * 渲染层里**新加的那几个函数是纯字符串函数**（不碰 DOM），所以这一层**不需要浏览器**：
 * 把它们从 panel-common.js 真源码里抠出来在 vm 里求值，剩下的都是结构断言。
 * 抠的是**真源码**而不是抄一份重写 —— 抄的那份会与实现慢慢脱节。
 * 需要 DOM 的部分（手风琴的开关）用一个最小桩，桩只实现用到的那几个方法。
 *
 * 最后一段是**反向对照**：把实现改坏（只改内存里的文本，不落盘），证明上面那些断言
 * 真的会红 —— 不然这些断言只是摆设。
 *
 * ## 红线
 *
 * 🔴 全文没有真实令牌/API key。
 * 🔴 断言不依赖任何一家渠道的名字：夹具里的 key 是假的（k1/k2），源码里也**不许**
 *    出现任何真渠道键名（C11）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const PANEL_PATH = path.join(REPO, "src", "server", "panel-common.js");
const CSS_PATH = path.join(REPO, "src", "server", "panel-common.css");
const PANEL_SRC = fs.readFileSync(PANEL_PATH, "utf8");
const CSS_SRC = fs.readFileSync(CSS_PATH, "utf8");

/* ====================================================================== *
 * 工具
 * ====================================================================== */

/** 从源码里抠出一段（按文本锚点）。抠的是真源码，不是抄一份。 */
function sliceBetween(src, startAnchor, endAnchor) {
  const i = src.indexOf(startAnchor);
  assert.ok(i >= 0, `抠源码失败：找不到 ${JSON.stringify(startAnchor)}`);
  const j = src.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(j > i, `抠源码失败：找不到终点 ${JSON.stringify(endAnchor)}`);
  const out = src.slice(i, j);
  assert.equal((out.match(/\/\*/g) || []).length, (out.match(/\*\//g) || []).length,
    `切片停在注释中间：${JSON.stringify(startAnchor)}`);
  return out;
}

/** 剥掉注释（块注释 + 行注释）。注释里出现的类名不算结构。 */
function stripComments(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

const has = (html, needle) => html.indexOf(needle) >= 0;

/** 写死颜色 detector：十六进制色值、rgb()/hsl()、以及 inline style 里的颜色属性。 */
const HEX_RX = /#[0-9a-fA-F]{3,8}\b/g;
const FN_COLOR_RX = /\b(?:rgba?|hsla?)\s*\(/g;
const INLINE_COLOR_RX = /style\s*=\s*"[^"]*(?:color|background|border-color)\s*:/gi;

function assertNoHardcodedColors(text, what) {
  assert.equal((text.match(HEX_RX) || []).length, 0,
    `${what} 里出现了写死的十六进制颜色（深浅两套主题会各走各的）`);
  assert.equal((text.match(FN_COLOR_RX) || []).length, 0,
    `${what} 里出现了 rgb()/hsl() 颜色函数`);
  assert.equal((text.match(INLINE_COLOR_RX) || []).length, 0,
    `${what} 的 inline style 里塞了颜色`);
}

/* ====================================================================== *
 * 在 vm 里求值真源码
 * ====================================================================== */

/* 假清单：key 是假的（k1/k2），**不许**用真渠道键名 —— 这一层自己也要守 C11。 */
const FAKE_MANIFEST = {
  k1: {
    letter: "AA",
    name: "示例甲",
    path: "/tmp/alpha",
    credential: { kind: "apiKey", label: "API Key", hint: "在上游生成，形如 sk-…" },
  },
  k2: {
    letter: "BB",
    name: "示例乙",
    credential: { kind: "jwt", label: "访问令牌", hint: "从本机客户端捕获" },
  },
};

/* esc 直接从渲染层源码里抠出来用（转义规则必须一致，所以不另写一份）。 */
const ESC_FN = sliceBetween(PANEL_SRC,
  "  const esc = (s) => String(s == null ? \"\" : s).replace(/[&<>\"']/g,",
  "  const clsx = (el, on, name) =>");

/* 手风琴开关那部分要 DOM，给一个最小桩：只实现用到的那几个方法。 */
function makeFakeClassList() {
  const set = new Set();
  return {
    set,
    contains: (n) => set.has(n),
    toggle: (n, on) => {
      if (on === undefined) { if (set.has(n)) set.delete(n); else set.add(n); }
      else if (on) set.add(n); else set.delete(n);
    },
  };
}
function makeFakeRow() {
  const attrs = {};
  return {
    classList: makeFakeClassList(),
    head: {
      attrs,
      setAttribute: (k, v) => { attrs[k] = v; },
      getAttribute: (k) => attrs[k],
    },
  };
}

/**
 * 从（可能被改坏的）源码里求值出这几个函数。
 * ⚠ body 一律用**字符串拼接**拼，不许用模板串 —— 被抠出来的源码里含有 `${…}`
 *   模板占位，套进模板串会被外层当表达式求值（那是个 ReferenceError）。
 */
function loadCredModuleFrom(src) {
  const fakeRows = [makeFakeRow(), makeFakeRow(), makeFakeRow()];
  const box = { rows: fakeRows };
  const body = [
    "(() => {",
    ESC_FN,
    "const MANIFEST = " + JSON.stringify(FAKE_MANIFEST) + ";",
    "const fakeRows = box.rows;",
    "const nameOf = (key) => (MANIFEST[key] || {}).name || key;",
    'const $ = (id) => (id === "credList" ? box : null);',
    'const qa = (sel, root) => (sel === ".credrow" ? root.rows : []);',
    'const q = (sel, root) => (sel === ".credhead" ? root.head : null);',
    sliceBetween(src, "  function credRowHtml(key) {", "  function buildCredList() {"),
    "return { credRowHtml, credPillHtml, credWhyHtml, toggleCredRow, fakeRows };",
    "})()",
  ].join("\n");
  const sandbox = { console, box };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return vm.runInContext(body, sandbox, { filename: "panel-cred-accordion" });
}

const MOD = loadCredModuleFrom(PANEL_SRC);

/* ====================================================================== *
 * ① 行的结构：钩子一个都不能少
 * ====================================================================== */
describe("① 凭据行的结构 —— 钩子一个都不能少", () => {
  const html = MOD.credRowHtml("k1");

  test("①a 行本身仍然是 credrow + data-k（别的代码按这两个找行）", () => {
    const build = sliceBetween(PANEL_SRC, "  function buildCredList() {", "  function paintCredList() {");
    assert.match(build, /row\.className = "credrow"/, "行必须还带 class=credrow");
    assert.match(build, /row\.dataset\.k = key/, "行必须还带 data-k");
    assert.match(build, /for \(const key of ALL_KEYS\)/, "顺序必须还是清单顺序（ALL_KEYS），不许自己排");
  });

  test("①b 卡片挂点 data-role=\"detail\" 必须在行里", () => {
    assert.ok(has(html, 'data-role="detail"'),
      "★ 卡片（plugins / mm-member / or-rotation / token-capture…）靠它挂载，丢了卡就悄悄不见了");
    /* rowsOfKind 取的就是它 —— 那一处必须还在按 data-role 找。 */
    const rowsOfKind = sliceBetween(PANEL_SRC, "  function rowsOfKind(kind) {", "  const ctx = {");
    assert.match(rowsOfKind, /q\('\[data-role="detail"\]', row\)/,
      "★ rowsOfKind 必须仍然按 data-role=\"detail\" 取挂点");
  });

  test("①c 状态区与操作区也必须在行里（data-role=\"state\" / \"act\"）", () => {
    assert.ok(has(html, 'data-role="state"'), "状态区钩子不能少");
    assert.ok(has(html, 'data-role="act"'), "操作区钩子不能少");
    /* 操作区是 credAction 往里塞编辑器的地方。 */
    assert.match(PANEL_SRC, /const actBox = row \? q\('\[data-role="act"\]', row\) : null;/,
      "★ credAction 必须仍然按 data-role=\"act\" 取操作区");
  });

  test("①d 折叠态那一行必须有：字母、名字、凭据类型徽章、状态药丸、箭头", () => {
    const head = html.slice(html.indexOf('class="credhead"'), html.indexOf('class="credbody"'));
    assert.ok(has(head, 'class="letter"'), "头一行要有字母");
    assert.ok(has(head, 'class="clname"'), "头一行要有名字");
    assert.ok(has(head, 'class="kindbadge"'), "头一行要有凭据类型徽章");
    assert.ok(has(head, 'data-role="pill"'), "★ 头一行要有状态药丸的落点");
    assert.ok(has(head, 'class="chev"'), "头一行要有箭头");
    /* 这几样必须**都在头一行里**（收起时看得见的就是它们）。 */
    assert.ok(has(head, "示例甲"), "★ 名字必须在头一行里");
    assert.ok(has(head, "API Key"), "★ 凭据类型必须在头一行里");
  });

  test("①e 展开后那一块要有：路径、说明、状态区、操作区、卡片挂点", () => {
    const body = html.slice(html.indexOf('class="credbody"'));
    assert.ok(has(body, 'class="cpath"'), "展开后要能看到路径");
    assert.ok(has(body, 'class="chint"'), "★ 展开后要能看到凭据说明");
    assert.ok(has(body, "形如 sk-"), "★ 说明文字要真的被画出来（不是空占位）");
    assert.ok(has(body, 'data-role="state"'));
    assert.ok(has(body, 'data-role="act"'));
    assert.ok(has(body, 'data-role="detail"'));
    /* 说明**不在**头一行里 —— 收起时不该占地方。 */
    const head = html.slice(html.indexOf('class="credhead"'), html.indexOf('class="credbody"'));
    assert.equal(has(head, "形如 sk-"), false, "★ 说明文字不许出现在折叠的那一行里");
  });

  test("①f 头一行是键盘可达的按钮（role / tabindex / aria-expanded / aria-controls 对得上）", () => {
    const m = /class="credhead"([^>]*)>/.exec(html);
    assert.ok(m, "头一行要有 credhead");
    assert.match(m[1], /role="button"/, "头一行要能被读屏当成按钮");
    assert.match(m[1], /tabindex="0"/, "头一行要能用键盘 Tab 到");
    assert.match(m[1], /aria-expanded="false"/, "★ 折叠态的 aria-expanded 必须是 false");
    const ctrl = /aria-controls="([^"]+)"/.exec(m[1]);
    assert.ok(ctrl, "★ aria-controls 要指向展开后那一块");
    assert.ok(has(html, 'id="' + ctrl[1] + '"'), "★ aria-controls 指的那个 id 必须真的存在");
  });

  test("①g 渲染层不许认识渠道名（C11）：新写的这几个函数里一个渠道键名都不许出现", () => {
    const fn = sliceBetween(PANEL_SRC, "  function credRowHtml(key) {", "  function buildCredList() {");
    const code = stripComments(fn);
    for (const k of ["bai", "sn", "wb", "wbai", "zen", "qd", "mm", "or", "ccswitch"]) {
      assert.equal(new RegExp("[\"'`]" + k + "[\"'`]").test(code), false,
        `★ 新代码里不许出现渠道名 ${k}（数据一律从清单来）`);
    }
  });
});

/* ====================================================================== *
 * ② 状态是数据，不是装饰
 * ====================================================================== */
describe("② 状态药丸 —— 措辞与颜色都从 credState 来", () => {
  test("②a 药丸的类名来自状态本身，文字也来自状态本身", () => {
    const html = MOD.credPillHtml({ s: "warn", txt: "令牌陈旧" });
    assert.ok(has(html, 'class="pill warn"'), `语义色必须来自 st.s。实际 ${html}`);
    assert.ok(has(html, "令牌陈旧"), `文字必须来自 st.txt。实际 ${html}`);
  });

  test("②b 四种语义色都认，别把「探不到」画成「坏了」", () => {
    for (const s of ["ok", "warn", "err", "idle"]) {
      const html = MOD.credPillHtml({ s, txt: "x" });
      assert.ok(has(html, 'class="pill ' + s + '"'), `状态 ${s} 应当画成 pill ${s}。实际 ${html}`);
    }
  });

  test("②c 上游来的文字一律转义", () => {
    const html = MOD.credPillHtml({ s: "err", txt: "<img src=x onerror=alert(1)>" });
    const text = /class="pill err">([^<]*)<\/span>/.exec(html);
    assert.ok(text, "药丸应当有文字");
    assert.equal(text[1].indexOf("<"), -1, "药丸里的标签不许原样进 HTML");
    assert.ok(text[1].indexOf("&") >= 0, "应当看到转义后的实体");
  });

  test("②d 药丸在头一行里，行内那块只剩「证据」—— 全页一份药丸，不许出现两个", () => {
    const paint = sliceBetween(PANEL_SRC, "  function paintCredList() {", "  /* 令牌捕获的流程所有者登记表");
    /* 药丸只画一次：画进 data-role="pill"（头一行）。 */
    const pills = paint.match(/class="pill/g) || [];
    assert.equal(pills.length, 0,
      `★ 状态区里不许再画药丸（否则一行两个状态）。实际出现 ${pills.length} 次`);
    assert.match(paint, /pillBox\.innerHTML = credPillHtml\(st\)/,
      "★ 药丸必须画进头一行的 data-role=\"pill\"");
  });
});

/* ====================================================================== *
 * ③ 不藏坏消息
 * ====================================================================== */
describe("③ 坏消息不许藏在收起的行后面", () => {
  test("③a warn / err 的原因在收起时也要看得见", () => {
    assert.notEqual(MOD.credWhyHtml({ s: "warn", txt: "令牌陈旧", detail: "读到的是上次运行留下的文件" }), "",
      "★ 黄色状态的原因必须画出来");
    assert.notEqual(MOD.credWhyHtml({ s: "err", txt: "凭据已失效", detail: "请重新登录" }), "",
      "★ 红色状态的原因必须画出来");
    assert.ok(has(MOD.credWhyHtml({ s: "err", txt: "x", detail: "请重新登录" }), "请重新登录"),
      "原因原文要出现在那一行里");
  });

  test("③b ok / idle 不摆原因（证据与噪声都在展开后的那一块里）", () => {
    assert.equal(MOD.credWhyHtml({ s: "ok", txt: "已就绪", detail: "有效期至 2026/12/31" }), "",
      "★ 正常状态的 detail 是证据，不该摆在这一行里");
    assert.equal(MOD.credWhyHtml({ s: "idle", txt: "未配置", detail: "API Key" }), "",
      "★ 未配置的药丸已经说清楚了，不该再补一句噪声");
  });

  test("③c 原因里的标签必须转义", () => {
    const out = MOD.credWhyHtml({ s: "err", txt: "x", detail: "<script>alert(1)</script>" });
    assert.equal(out.indexOf("<"), -1, "原因里的标签不许原样进 HTML");
    assert.ok(out.indexOf("&") >= 0, "应当看到转义后的实体");
  });

  test("③d 状态不许藏在收起的行后面：药丸的落点必须在**折叠态**那一行里", () => {
    const html = MOD.credRowHtml("k1");
    const head = html.slice(html.indexOf('class="credhead"'), html.indexOf('class="credbody"'));
    assert.ok(has(head, 'data-role="pill"'),
      "★ 状态药丸的落点必须在头一行（收起也看得见的那一行）里");
    /* CSS：药丸不许被 flex 压扁。 */
    assert.match(CSS_SRC, /\.credhead \.credpill \{[^}]*flex:\s*none/,
      "药丸不许被 flex 压扁");
  });
});

/* ====================================================================== *
 * ④ 手风琴：点一下展开，再点收起
 * ====================================================================== */
describe("④ 手风琴开关", () => {
  test("④a 点一下展开、再点一下收起（class 与 aria 同步）", () => {
    const rows = MOD.fakeRows;
    const row = rows[0];
    MOD.toggleCredRow(row);
    assert.equal(row.classList.contains("open"), true, "第一次点必须展开");
    assert.equal(row.head.getAttribute("aria-expanded"), "true", "aria-expanded 必须跟着变成 true");
    MOD.toggleCredRow(row);
    assert.equal(row.classList.contains("open"), false, "再点一下必须收起");
    assert.equal(row.head.getAttribute("aria-expanded"), "false", "aria-expanded 必须跟着回到 false");
  });

  test("④b 同时只开一行（开着的那行就是「正在动的那一家」）", () => {
    const rows = MOD.fakeRows;
    rows.forEach((r) => { r.classList.set.clear(); });
    MOD.toggleCredRow(rows[0]);
    MOD.toggleCredRow(rows[1]);
    assert.equal(rows[0].classList.contains("open"), false, "★ 开第二行时第一行必须收起来");
    assert.equal(rows[1].classList.contains("open"), true);
    assert.equal(rows[0].head.getAttribute("aria-expanded"), "false",
      "★ 收起来的那行 aria-expanded 也必须回到 false");
  });

  test("④c 头一行的点击与键盘都必须能开关（Enter / 空格）", () => {
    const build = sliceBetween(PANEL_SRC, "  function buildCredList() {", "  function paintCredList() {");
    assert.match(build, /head\.addEventListener\("click", \(\) => toggleCredRow\(row\)\)/,
      "★ 点头一行必须能展开/收起");
    assert.match(build, /head\.addEventListener\("keydown"/, "★ 头一行必须能用键盘操作");
    assert.match(build, /e\.key === "Enter" \|\| e\.key === " "/, "★ Enter 与空格都要能开关");
  });
});

/* ====================================================================== *
 * ⑤ CSS：折叠态看不见细节，展开态看得见；不许写死颜色
 * ====================================================================== */
describe("⑤ 样式", () => {
  const credCss = sliceBetween(CSS_SRC, "   11. 凭据视图的行", "   12. 故障转移视图");

  test("⑤a 收起时展开块必须藏起来，展开时必须露出来", () => {
    assert.match(credCss, /\.credbody \{[^}]*display:\s*none/, "折叠态的展开块必须是 display:none");
    assert.match(credCss, /\.credrow\.open \.credbody \{[^}]*display:\s*flex/, "★ 展开态必须露出来");
  });

  test("⑤b 展开后原因那一行要收掉（同一句话说两遍没意思）", () => {
    assert.match(credCss, /\.credrow\.open \.credwhy \{[^}]*display:\s*none/,
      "★ 展开后原因那一行必须让位给行内那块");
    assert.match(credCss, /\.credwhy:empty \{[^}]*display:\s*none/, "空的原因那一行不许占地方");
  });

  test("⑤c 新样式里不许写死颜色（C7）", () => {
    assertNoHardcodedColors(credCss, "凭据行的新样式");
    /* 语义变量得用起来 —— 状态色不许走别的道。 */
    assert.match(credCss, /var\(--line\)/);
    assert.match(credCss, /var\(--dim\)/);
  });

  test("⑤d 箭头要指向「展开后会变」的方向", () => {
    assert.match(credCss, /\.credrow\.open \.credhead \.chev \{[^}]*rotate\(/,
      "★ 展开时箭头必须转过去（不然用户不知道收起来往哪点）");
  });
});

/* ====================================================================== *
 * ⑥ 按钮契约：data-act 的名字与接线一字不改
 * ====================================================================== */
describe("⑥ 按钮契约", () => {
  const ACTS = ["reread", "savekey", "toggle", "capture", "manual", "patch", "revert", "keys", "quota"];
  /* toggle 是**单独**接的（显示/隐藏明文），不走 credAction 的分派 —— 这条不许被「统一」掉。 */
  const DISPATCHED = ACTS.filter((a) => a !== "toggle");

  test("⑥a 九个 data-act 名字都得在（分发器与卡片都靠它们）", () => {
    const paint = sliceBetween(PANEL_SRC, "  function paintCredList() {", "  /* 令牌捕获的流程所有者登记表");
    for (const a of ACTS) {
      assert.ok(has(paint, 'data-act="' + a + '"'), `★ data-act="${a}" 必须还在`);
    }
    /* 分发器要认得每一个（toggle 除外：它是单独接的，见 ⑥c）。 */
    const act = sliceBetween(PANEL_SRC, "  async function credAction(key, btn) {", "  function modelIdentityItems(S, name) {");
    for (const a of DISPATCHED) {
      assert.ok(has(act, '"' + a + '"'), `★ credAction 必须还分派 ${a}`);
    }
    assert.equal(has(act, '"toggle"'), false,
      "★ toggle 不该被并进 credAction 的分派（它是单独接线的那一个）");
  });

  test("⑥b 操作区的按钮必须还在 data-role=\"act\" 容器里", () => {
    const paint = sliceBetween(PANEL_SRC, "  function paintCredList() {", "  /* 令牌捕获的流程所有者登记表");
    assert.match(paint, /act\.innerHTML = `?<button[^>]*data-act="reread"/,
      "★ 按钮必须画进操作区容器");
    assert.match(paint, /act\.innerHTML = `?<input[^>]*data-role="key"/,
      "★ 输入框必须画进操作区容器");
  });

  test("⑥c toggle 的显示/隐藏接线必须还在，而且仍然是单独接的", () => {
    const paint = sliceBetween(PANEL_SRC, "  function paintCredList() {", "  /* 令牌捕获的流程所有者登记表");
    assert.match(paint, /q\('button\[data-act="toggle"\]', act\)/,
      "★ toggle 按钮必须仍然单独取出来接线");
    assert.match(paint, /inp\.type = showNow \? "text" : "password"/, "★ 显示/隐藏的逻辑必须还在");
    assert.match(paint, /tg\.textContent = showNow \? "隐藏" : "显示"/, "★ 按钮文案必须还会变");
  });

  test("⑥d 「轮换区编辑器打开时不重新接线」那条不许丢（否则点一次发两次请求）", () => {
    const paint = sliceBetween(PANEL_SRC, "  function paintCredList() {", "  /* 令牌捕获的流程所有者登记表");
    assert.match(paint, /if \(btn && !q\("\.keybox", act\)\)/,
      "★ 通用按钮接线必须仍然跳过轮换区编辑器打开的那一行");
    assert.match(paint, /if \(!q\("\.keybox", act\)\) \{/, "★ 轮换区的按钮不许被反复重建");
  });

  test("⑥e 行内按钮被点到时要先把这一行展开（折叠时那些按钮是看不见的）", () => {
    const build = sliceBetween(PANEL_SRC, "  function buildCredList() {", "  function paintCredList() {");
    assert.match(build, /closest\("\[data-act\]"\)/, "★ 要按 data-act 找到被点的按钮");
    assert.match(build, /toggleCredRow\(r\)/, "★ 点到行内按钮时先展开那一行");
  });
});

/* ====================================================================== *
 * ⑦ 反向对照：把实现改坏，对应断言必须真的会红
 * ====================================================================== */
describe("⑦ 反向对照 —— 改坏实现，对应断言必须红", () => {
  const broken = (src, from, to, label) => {
    assert.ok(src.includes(from), `手法 ${label} 的锚点已经对不上源码了（实现改了？）`);
    return src.replace(from, to);
  };

  test("⑦a 把药丸从头一行挪走 ⇒ ②d 必须红", () => {
    const src = broken(PANEL_SRC,
      "      pillBox.innerHTML = credPillHtml(st);",
      "      pillBox.innerHTML = \"\";",
      "pill-moved");
    const paint = sliceBetween(src, "  function paintCredList() {", "  /* 令牌捕获的流程所有者登记表");
    assert.throws(() => {
      assert.match(paint, /pillBox\.innerHTML = credPillHtml\(st\)/,
        "★ 药丸必须画进头一行的 data-role=\"pill\"");
    }, "药丸落点的断言必须红");
  });

  test("⑦b 让行内那块也画一个药丸 ⇒ ②d 必须红（一行两个状态）", () => {
    const src = broken(PANEL_SRC,
      "        stBox.innerHTML = (shown ? `<span class=\"fp mono\">${shown}</span>` : \"\");",
      "        stBox.innerHTML = `<span class=\"pill ${st.s}\">${esc(st.txt)}</span>` + (shown ? `<span class=\"fp mono\">${shown}</span>` : \"\");",
      "double-pill");
    const paint = sliceBetween(src, "  function paintCredList() {", "  /* 令牌捕获的流程所有者登记表");
    assert.throws(() => {
      const pills = paint.match(/class="pill/g) || [];
      assert.equal(pills.length, 0, "★ 状态区里不许再画药丸（否则一行两个状态）");
    }, "一行两个状态的断言必须红");
  });

  test("⑦c 收起时把坏消息藏起来 ⇒ ③a 必须红", () => {
    const src = broken(PANEL_SRC,
      "    if (st.s !== \"warn\" && st.s !== \"err\") return \"\";",
      "    return \"\";",
      "why-hidden");
    const mod = loadCredModuleFrom(src);
    assert.equal(mod.credWhyHtml({ s: "err", txt: "x", detail: "请重新登录" }), "",
      "改坏的副本应当真的把原因藏起来");
    assert.throws(() => {
      assert.notEqual(mod.credWhyHtml({ s: "err", txt: "凭据已失效", detail: "请重新登录" }), "",
        "★ 红色状态的原因必须画出来");
    }, "坏消息可见性的断言必须红");
  });

  test("⑦d 把卡片挂点删掉 ⇒ ①b 必须红", () => {
    const src = broken(PANEL_SRC,
      "        <div class=\"crow\" data-role=\"detail\"></div>",
      "        <div class=\"crow\"></div>",
      "detail-gone");
    const mod = loadCredModuleFrom(src);
    const html = mod.credRowHtml("k1");
    assert.equal(has(html, 'data-role="detail"'), false, "改坏的副本应当真的没有挂点了");
    assert.throws(() => {
      assert.ok(has(html, 'data-role="detail"'),
        "★ 卡片靠它挂载，丢了卡就悄悄不见了");
    }, "挂点的断言必须红");
  });

  test("⑦e 收起时展开块还露着 ⇒ ⑤a 必须红", () => {
    const src = broken(CSS_SRC,
      ".credbody { display: none;",
      ".credbody { display: flex;",
      "body-always-open");
    const credCss = sliceBetween(src, "   11. 凭据视图的行", "   12. 故障转移视图");
    assert.throws(() => {
      assert.match(credCss, /\.credbody \{[^}]*display:\s*none/, "折叠态的展开块必须是 display:none");
    }, "折叠态必须藏住展开块的断言必须红");
  });

  test("⑦f 各自独立开（开第二行不收第一行）⇒ ④b 必须红", () => {
    const src = broken(PANEL_SRC,
      "      const on = (r === row) && open;",
      "      const on = r === row ? open : r.classList.contains(\"open\");",
      "multi-open");
    const mod = loadCredModuleFrom(src);
    mod.fakeRows.forEach((r) => { r.classList.set.clear(); });
    mod.toggleCredRow(mod.fakeRows[0]);
    mod.toggleCredRow(mod.fakeRows[1]);
    assert.equal(mod.fakeRows[0].classList.contains("open"), true, "改坏的副本应当真的能同时开两行");
    assert.throws(() => {
      assert.equal(mod.fakeRows[0].classList.contains("open"), false, "★ 开第二行时第一行必须收起来");
    }, "同时只开一行的断言必须红");
  });
});
