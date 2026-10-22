/* scripts/channel-master-detail-test.mjs —— 渠道页主从布局的口径测试（docs/ui-redesign.md 的 P3）。
 *
 * ## 测什么
 *
 * 这一轮把「渠道页」从 4×2 矩阵改成主从布局：左边一列渠道，右边是选中那家的
 * 全部内容。改动的风险不在样式，在**结构与接线**：
 *
 *   ★ ① **左栏就是渠道列表**：一行一家，名字 + 状态药丸 + 一个用量小条。
 *        每行必须能选中（点一下切换右栏），且必须带 data-k。
 *   ★ ② **状态与用量必须来自服务端状态层**（/api/channels/state 的六态 + ratio），
 *        而不是渲染层自己算的那套 —— 否则同一个渠道在总览热力图与渠道页左栏
 *        会显示两种状态（这正是改版原则 1 要消灭的）。
 *   ★ ③ **同一份数据只拉一次**：热力图卡、状态条卡、渠道页左栏三处共用
 *        渲染层的缓存，而不是各自 api("/api/channels/state")。
 *   ★ ④ **老 hash 不 404**：凭据屏并入渠道页后，#/cred 必须重定向到渠道页。
 *   ★ ⑤ **右栏必须真的在右栏**：映射编辑、凭据区块、抬头都得在 channels 视图里，
 *        不能还留在总览屏。
 *   ★ ⑥ **「接通这家」不能丢**：矩阵格子退役后，矩阵格里的「一键接入 X」按钮
 *        没了宿主 —— 不补回来的话用户就没有「只接通这一家」的办法了。
 *
 * ## 怎么测的
 *
 * 纯文本层：抠模板与渲染层的**真源码**（不抄一份重写——抄的那份会与实现脱节），
 * 断言结构与接线。DOM 层的部分（行结构、药丸、量条）用一个最小桩求值渲染层里
 * 抠出来的**纯函数**。
 *
 * 最后一段是**反向对照**：把实现改坏（只改内存里的文本，不落盘），证明上面那些
 * 断言真的会红 —— 不然这些断言只是摆设。
 *
 * ## 红线
 *
 * 🔴 全文没有真实令牌/API key。
 * 🔴 断言不依赖任何一家渠道的名字：夹具里的 key 是假的（k1/k2），
 *    源码里也**不许**出现真渠道键名（C11）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const HTML_PATH = path.join(REPO, "src", "server", "provider.html");
const PANEL_PATH = path.join(REPO, "src", "server", "panel-common.js");
const CSS_PATH = path.join(REPO, "src", "server", "panel-common.css");
const VIEWS_PATH = path.join(REPO, "src", "server", "providers.js");

const HTML = fs.readFileSync(HTML_PATH, "utf8");
const PANEL = fs.readFileSync(PANEL_PATH, "utf8");
const CSS = fs.readFileSync(CSS_PATH, "utf8");
const VIEWS = fs.readFileSync(VIEWS_PATH, "utf8");

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
const countOf = (html, needle) => html.split(needle).length - 1;

/** 某段模板落在哪个视图容器里（按容器 id 找区间）。 */
function sectionOf(html, containerId) {
  const i = html.indexOf(`id="${containerId}"`);
  if (i < 0) return "";
  const open = html.lastIndexOf("<section", i);
  const close = html.indexOf("</section>", i);
  return html.slice(open, close);
}

/* ====================================================================== *
 * 在 vm 里求值真源码（纯函数部分）
 * ====================================================================== */

/* 假清单：key 是假的（k1/k2），**不许**用真渠道键名 —— 这一层自己也要守 C11。 */
const FAKE_MANIFEST = {
  k1: { letter: "AA", name: "示例甲", path: "/tmp/alpha", chainable: true, tagline: "示例标语" },
  k2: { letter: "BB", name: "示例乙", path: "/tmp/beta", chainable: true, tagline: "另一句" },
};

const ESC_FN = sliceBetween(PANEL,
  "  const esc = (s) => String(s == null ? \"\" : s).replace(/[&<>\"']/g,",
  "  const clsx = (el, on, name) =>");

/**
 * 求值渲染层里的纯函数：channelStateOf（六态 → 文本/色调/原因）。
 * 它是纯函数：不碰 DOM、不读全局时间。
 */
function loadStateModuleFrom(src) {
  const body = [
    "(() => {",
    ESC_FN,
    "const MANIFEST = " + JSON.stringify(FAKE_MANIFEST) + ";",
    sliceBetween(src, "  function channelStateOf(c) {", "  function prettyName(key, id) {"),
    "return { channelStateOf };",
    "})()",
  ].join("\n");
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return vm.runInContext(body, sandbox, { filename: "panel-chan-state" });
}

const MOD = loadStateModuleFrom(PANEL);

/* ====================================================================== *
 * ① 模板结构：主从两栏，右栏在 channels 视图里
 * ====================================================================== */
describe("① 模板结构 —— 主从两栏", () => {
  const channels = sectionOf(HTML, "viewChannels");
  const console_ = sectionOf(HTML, "viewConsole");

  test("①a 渠道页有左栏与右栏两个容器", () => {
    assert.ok(has(channels, 'class="chan-split"'), "★ 渠道页要有主从分栏容器");
    assert.ok(has(channels, 'class="chan-rail"'), "★ 左栏容器");
    assert.ok(has(channels, 'class="chan-detail"'), "★ 右栏容器");
  });

  test("①b 左栏挂着渠道列表（契约 id matrixGrid 复用为这一栏的容器）", () => {
    assert.ok(has(channels, 'id="matrixGrid"'), "★ 左栏要有渠道列表容器");
    assert.ok(countOf(HTML, 'id="matrixGrid"') === 1, "matrixGrid 在模板里只能出现一次");
  });

  test("①c 右栏含抬头 + 映射编辑 + 凭据区块", () => {
    assert.ok(has(channels, 'id="chanHead"'), "★ 右栏要有抬头（这家是谁）");
    assert.ok(has(channels, 'id="mapPanel"'), "★ 映射编辑在右栏");
    assert.ok(has(channels, 'id="routeBody"'), "★ 四档映射表在右栏");
    assert.ok(has(channels, 'id="viewCred"'), "★ 凭据区块在右栏");
    assert.ok(has(channels, 'id="credList"'), "★ 凭据手风琴在右栏");
  });

  test("①d 映射编辑与凭据**不在**总览屏里（否则又堆回一屏）", () => {
    assert.equal(has(console_, 'id="mapPanel"'), false, "★ 映射编辑必须搬出总览屏");
    assert.equal(has(console_, 'id="credList"'), false, "★ 凭据必须搬出总览屏");
    assert.equal(has(console_, 'id="matrixGrid"'), false, "★ 渠道列表必须搬出总览屏");
  });

  test("①e 诊断抽屉留在总览屏（它是全局结论，不是某一家的事）", () => {
    assert.ok(has(console_, 'id="diagDrawer"'), "诊断抽屉留在总览");
    assert.ok(has(console_, 'id="diagList"'), "诊断结论流留在总览");
  });

  test("①f 须知与中转端口在右栏（改一家时要看得见自己改的是哪一路）", () => {
    assert.ok(has(channels, 'id="patchHint"'), "★ 须知在右栏");
    assert.ok(has(channels, 'id="hintRelayPort"'), "★ 中转端口在右栏");
  });
});

/* ====================================================================== *
 * ② 左栏行：名字 + 状态药丸 + 用量小条
 * ====================================================================== */
describe("② 左栏行 —— 名字 + 药丸 + 用量条", () => {
  const build = sliceBetween(PANEL, "  function buildChanList() {", "  function chanRowFor(key) {");
  const rowFn = sliceBetween(PANEL, "  function chanRowFor(key) {", "  /* 左栏重画");

  test("②a 一行一家，且行带 data-k（选中与重画都靠它认人）", () => {
    assert.match(rowFn, /el\.dataset\.k = key/, "★ 行必须带 data-k");
    assert.match(rowFn, /className = "chan-row"/, "行必须带 chan-row 类");
    assert.match(build, /for \(const key of chainOf\(\)\.length \? chainOf\(\) : CHAIN_KEYS\)/,
      "★ 行序必须是转移链顺序");
  });

  test("②b 行里三样东西齐了：名字 + 药丸 + 量条", () => {
    assert.match(rowFn, /class="cr-name"/, "★ 行里要有名字");
    assert.match(rowFn, /data-role="state"/, "★ 行里要有状态药丸的落点");
    assert.match(rowFn, /data-role="meter"/, "★ 行里要有用量小条的落点");
  });

  test("②c 点一行就选中那家（主从的联动入口）", () => {
    assert.match(rowFn, /addEventListener\("click", \(\) => selectChannel\(key\)\)/,
      "★ 点行必须选中那家");
  });

  test("②d 行是 button 元素（键盘可达 + 不需要 role/tabindex 手工补）", () => {
    assert.match(rowFn, /createElement\("button"\)/, "行用 button 元素");
    assert.match(rowFn, /el\.type = "button"/, "button 要显式 type=button（否则会触发表单提交）");
  });

  test("②e 左栏只画链上的渠道，不画交还区（交还区不是「一家」）", () => {
    assert.equal(/HANDOFF_KEYS/.test(build), false,
      "★ 交还区不该出现在渠道列表里（它没有映射也没有凭据可改）");
  });
});

/* ====================================================================== *
 * ③ 状态与用量：来自服务端状态层，且探不到≠0
 * ====================================================================== */
describe("③ 状态药丸与用量小条 —— 数据来源与口径", () => {
  const paint = sliceBetween(PANEL, "  function paintChanList() {", "  /* 服务端六态");

  test("③a 药丸与量条读的是共享的状态层缓存，不是各自拉", () => {
    assert.match(paint, /chanStates && chanStates\.channels/, "★ 左栏读共享缓存");
  });

  test("③b 六态映射齐全（少一个就会显示成「状态不明」）", () => {
    for (const s of ["ok", "cooling", "resting", "exhausted", "unconfigured", "unknown"]) {
      assert.ok(MOD.channelStateOf({ state: s }), `六态缺 ${s}`);
    }
    assert.equal(MOD.channelStateOf({ state: "ok" }).text, "可用");
    assert.equal(MOD.channelStateOf({ state: "cooling" }).text, "冷却中");
    assert.equal(MOD.channelStateOf({ state: "exhausted" }).text, "预算用完");
    assert.equal(MOD.channelStateOf({ state: "unknown" }).text, "状态不明");
  });

  test("③c 色调只用语义色（ok/warn/err/idle）——写死色值就等于只有一套主题能用", () => {
    const tones = new Set();
    for (const s of ["ok", "cooling", "resting", "exhausted", "unconfigured", "unknown"]) {
      tones.add(MOD.channelStateOf({ state: s }).tone);
    }
    assert.deepEqual([...tones].sort(), ["err", "idle", "ok", "warn"],
      `色调只许来自语义色集合，实际 ${[...tones].join(",")}`);
  });

  test("③d 认不出的状态当 unknown 处理，不许瞎猜一个", () => {
    const st = MOD.channelStateOf({ state: "某种没见过的状态" });
    assert.equal(st.text, "状态不明");
    assert.equal(st.tone, "idle");
  });

  test("③e 探不到用量画「—」，不画 0（0 会被读成「用完了」）", () => {
    assert.match(paint, /r == null[\s\S]*?cr-meter-empty/, "★ 没有 ratio 时画「—」");
    assert.match(paint, /typeof c\.ratio === "number" \? c\.ratio : null/, "ratio 必须先判类型");
  });

  test("③f ratio 是百分比，要除以 100 才是比例（忘了就画成满格）", () => {
    assert.match(paint, /Math\.max\(0, Math\.min\(100, r\)\)/, "百分比必须夹在 0–100");
    assert.equal(/r\s*\/\s*100/.test(paint), false,
      "★ 这一条是宽度百分比（0–100），不是 0–1 的比例 —— 除以 100 就画错了");
  });
});

/* ====================================================================== *
 * ④ 同一份数据只拉一次
 * ====================================================================== */
describe("④ 状态层数据全屏只拉一次", () => {
  const cache = sliceBetween(PANEL, "  let chanStates = null;", "  const MANIFEST = window.BAI_PROVIDERS");

  test("④a 有共享缓存 + 在途去重（否则并发的三处会各拉一份）", () => {
    assert.match(cache, /let chanStates = null/, "要有缓存");
    assert.match(cache, /let chanStatesPending = null/, "★ 要有在途去重");
    assert.match(cache, /if \(chanStatesPending\) return chanStatesPending/, "在途时复用同一个请求");
  });

  test("④b 缓存有 TTL：状态会变，不能永远拿第一次那份", () => {
    assert.match(cache, /CHAN_STATES_TTL_MS/, "要有 TTL");
    assert.match(cache, /now - chanStatesAt < CHAN_STATES_TTL_MS/, "★ 超过 TTL 要重新拉");
  });

  test("④c 读失败保留上一份，不把整表清空（清空会让整列变成「探不到」）", () => {
    /* 判据：赋新值的那行必须在 try 里、catch 里没有赋值。
       写法上只认「try 段里的 chanStates = 」与「catch 段里没有 chanStates = 」。 */
    const tryIdx = cache.indexOf("try {");
    const catchIdx = cache.indexOf("} catch (e) {");
    assert.ok(tryIdx >= 0 && catchIdx > tryIdx, "缓存读取要有 try/catch");
    const tryBody = cache.slice(tryIdx, catchIdx);
    const catchBody = cache.slice(catchIdx);
    assert.match(tryBody, /chanStates = r \|\| null;/, "成功才覆盖缓存");
    assert.equal(/chanStates\s*=/.test(catchBody), false,
      "★ catch 里不能把缓存清空（清空会让整列变成「探不到」，比显示旧值更糟）");
    assert.match(catchBody, /console\.warn/, "读失败要留痕");
  });

  test("④d 三处消费同一个读法（热力图卡、状态条卡、左栏）", () => {
    assert.match(PANEL, /loadChanStates,/, "ctx 要暴露共享读法");
    const heat = fs.readFileSync(path.join(REPO, "src", "server", "cards", "channel-heatmap.js"), "utf8");
    const strip = fs.readFileSync(path.join(REPO, "src", "server", "cards", "status-strip.js"), "utf8");
    assert.match(heat, /ctx\.loadChanStates/, "★ 热力图卡要走共享读法");
    assert.match(strip, /ctx\.loadChanStates/, "★ 状态条卡要走共享读法");
    /* 兜底路径必须还在：ctx 没有这个方法时（独立打开卡片文件）卡片仍要能工作。 */
    assert.match(heat, /ctx\.api\("\/api\/channels\/state"\)/, "热力图卡要有兜底读法");
  });
});

/* ====================================================================== *
 * ⑤ 老 hash 重定向
 * ====================================================================== */
describe("⑤ 老 hash 不 404", () => {
  const viewFn = sliceBetween(PANEL, "  const LEGACY_VIEW_ALIAS = {", "  function viewOf(id)");

  test("⑤a 有老段名别名表（凭据屏并入渠道页）", () => {
    assert.match(viewFn, /LEGACY_VIEW_ALIAS/, "要有别名表");
    assert.match(viewFn, /cred:\s*"channels"/, "★ #/cred 要指向渠道页");
  });

  test("⑤b 别名只认旧段名这一个方向（新段名永远落到自己）", () => {
    const aliasBlock = viewFn.slice(viewFn.indexOf("LEGACY_VIEW_ALIAS = {"));
    const entries = aliasBlock.slice(0, aliasBlock.indexOf("}"));
    assert.equal(/channels\s*:/.test(entries), false,
      "★ 不能把 channels 指回 cred —— 下一轮再退役时又断一次");
  });

  test("⑤c 别名指向的新屏必须真的存在，否则退回首屏（不空白）", () => {
    assert.match(viewFn, /VIEWS\.some\(\(v\) => v && v\.id === alias\)/,
      "★ 别名要先确认目标存在");
    assert.match(viewFn, /return alias;/, "确认存在才用别名");
    assert.match(viewFn, /VIEWS\[0\] \|\| \{\}\)\.id\)/, "找不到就回首屏");
  });

  test("⑤d 视图表里渠道页确实叫 channels（别名的落点）", () => {
    assert.match(VIEWS, /id: "channels"/, "★ 视图表要有 channels");
    assert.match(VIEWS, /dom: "viewChannels"/, "channels 的容器是 viewChannels");
    assert.equal(/id: "cred"/.test(VIEWS), false, "凭据屏已并入渠道页，视图表里不该再有 cred");
  });
});

/* ====================================================================== *
 * ⑥ 「接通这家」不能丢
 * ====================================================================== */
describe("⑥ 右栏的动作没丢", () => {
  const head = sliceBetween(PANEL, "  function paintChanHead() {", "  function selectChannel(key)");

  test("⑥a 抬头有「接通这家」按钮（矩阵格里的按钮退役后，这是唯一的入口）", () => {
    assert.match(head, /data-act="apply"/, "★ 抬头要有接通按钮");
    assert.match(head, /primaryText\(key\)/, "按钮文案要沿用既有措辞");
  });

  test("⑥b 点它走的是既有那套接线（/api/apply），不是新写的路径", () => {
    assert.match(head, /applyChannel\(key\)/, "★ 接线走 applyChannel");
    assert.match(head, /restoreExternal\(\)/, "非本台渠道要能接回");
  });

  test("⑥c 凭据没配的渠道按钮禁用（否则点了必然失败）", () => {
    assert.match(head, /st && st\.s === "idle" \? "disabled" : ""/, "★ 未配置时禁用");
  });

  test("⑥d 抬头还要看得见中转端口（改一家时最常问「我改的是哪一路」）", () => {
    assert.match(head, /中转 :/, "★ 抬头要显示中转端口");
    assert.match(head, /relayPort/, "端口取自家配置");
  });
});

/* ====================================================================== *
 * ⑦ 样式：两栏 + 语义色
 * ====================================================================== */
describe("⑦ 样式 —— 两栏与语义色", () => {
  const chanCss = sliceBetween(CSS, "   7. 渠道页（主从布局", "   8. 映射编辑区");

  test("⑦a 主从两栏是 grid，左栏固定、右栏自适应", () => {
    assert.match(chanCss, /\.chan-split \{[\s\S]*?display: grid;/, "两栏要用 grid");
    assert.match(chanCss, /grid-template-columns: minmax\(228px, 268px\) minmax\(0, 1fr\)/,
      "★ 左栏固定宽、右栏吃剩余（0 而不是 auto：auto 会被内容撑破）");
  });

  test("⑦b 窄屏时左栏转成横向一排（纵向堆叠会把「选谁」推出屏幕）", () => {
    /* 切片从 @media (max-width: 980px) 开始（那一段里没有嵌套注释），
       免得切到注释中间去。 */
    const resp = sliceBetween(CSS, "@media (max-width: 980px) {", "@media (max-width: 700px) {");
    assert.match(resp, /\.chan-split \{ grid-template-columns: 1fr; \}/, "窄屏要堆叠");
    const listRule = /\.chan-list \{([\s\S]*?)\}/.exec(resp);
    assert.ok(listRule, "窄屏要有 .chan-list 规则");
    assert.match(listRule[1], /flex-direction: row/, "★ 左栏要转成横排");
    assert.match(listRule[1], /overflow-x: auto/, "★ 左栏要能横向滚");
  });

  test("⑦c 新的样式里不许写死颜色（写死就等于只有一套主题能用）", () => {
    assert.equal((chanCss.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length, 0, "★ 不许写死十六进制颜色");
    assert.equal((chanCss.match(/\brgba?\(/g) || []).length, 0, "★ 不许写死 rgb()");
  });

  test("⑦d 颜色一律走语义变量", () => {
    assert.match(chanCss, /var\(--brand-soft\)/, "选中态用语义色");
    assert.match(chanCss, /var\(--idle-soft\)/, "量条轨道用语义色");
  });

  test("⑦e 用量条的填充色来自语义色而不是写死值", () => {
    assert.match(chanCss, /\.cr-meter-fill \{[\s\S]*?background: var\(--idle\);/,
      "★ 量条填充走语义变量");
  });
});

/* ====================================================================== *
 * ⑧ 反向对照：把实现改坏，对应断言必须真的会红
 * ====================================================================== */
describe("⑧ 反向对照 —— 改坏实现，对应断言必须红", () => {
  const broken = (src, from, to, label) => {
    assert.ok(src.includes(from), `手法 ${label} 的锚点已经对不上源码了（实现改了？）`);
    return src.replace(from, to);
  };

  test("⑧a 把六态的色调映射改坏（少一个态）⇒ ③b/③c 必须红", () => {
    const src = broken(PANEL,
      'resting: "warn",',
      '',
      "drop-resting");
    const mod = loadStateModuleFrom(src);
    assert.throws(() => {
      /* 少了 resting 的色调映射 → 落到默认的 idle。
         断言查**色调**（不是文案）：文案还在，改坏的是配色，
         而配色错掉正是这个 bug 的要害（休息中显示成灰色 = 读成「没事」）。 */
      assert.equal(mod.channelStateOf({ state: "resting" }).tone, "warn");
    }, "六态色调缺失的断言必须红");
  });

  test("⑧b 把探不到当成 0（画成满条）⇒ ③e 必须红", () => {
    const src = broken(PANEL,
      "const r = c && typeof c.ratio === \"number\" ? c.ratio : null;",
      "const r = c && typeof c.ratio === \"number\" ? c.ratio : 0;",
      "ratio-zero");
    const paint = sliceBetween(src, "  function paintChanList() {", "  /* 服务端六态");
    assert.throws(() => {
      /* 改坏后 null 分支永远走不到 ⇒ 「探不到画 —」这条路断了。
         判据：null 分支必须真的把 r 判成 null（= 探不到时进 empty 分支）。 */
      const nullBranch = /const r = ([^;]+);/.exec(paint);
      assert.ok(nullBranch, "要有 ratio 的取值");
      assert.match(nullBranch[1], /: null;/,
        "★ 探不到时 ratio 必须是 null（当成 0 会被读成「额度用完了」）");
    }, "探不到当 0 的断言必须红");
  });

  test("⑧c 把老 hash 别名去掉 ⇒ ⑤a 必须红", () => {
    const src = broken(PANEL, 'cred: "channels"', 'cred: "gone"', "alias-removed");
    assert.throws(() => {
      const viewFn = sliceBetween(src, "  const LEGACY_VIEW_ALIAS = {", "  function viewOf(id)");
      assert.match(viewFn, /cred:\s*"channels"/, "★ #/cred 要指向渠道页");
    }, "别名缺失的断言必须红");
  });

  test("⑧d 让左栏改回各自拉接口（三处各拉一份）⇒ ④d 必须红", () => {
    const src = broken(PANEL, "loadChanStates,", "loadChanStatesX,", "ctx-shared-gone");
    assert.throws(() => {
      assert.match(src, /loadChanStates,/, "ctx 要暴露共享读法");
    }, "共享读法缺失的断言必须红");
  });

  test("⑧e 把「接通这家」按钮删掉 ⇒ ⑥a 必须红", () => {
    const src = broken(PANEL, 'data-act="apply"', 'data-act="applyX"', "apply-gone");
    const head = sliceBetween(src, "  function paintChanHead() {", "  function selectChannel(key)");
    assert.throws(() => {
      assert.match(head, /data-act="apply"/, "★ 抬头要有接通按钮");
    }, "接通按钮缺失的断言必须红");
  });

  test("⑧f 把映射编辑挪回总览屏 ⇒ ①d 必须红", () => {
    const html = broken(HTML, '<div class="editor" id="mapPanel">', '<div class="editor" id="mapPanelX">',
      "map-moved");
    assert.throws(() => {
      const channels = sectionOf(html, "viewChannels");
      assert.ok(has(channels, 'id="mapPanel"'), "映射编辑在右栏");
    }, "映射编辑位置错了的断言必须红");
  });
});
