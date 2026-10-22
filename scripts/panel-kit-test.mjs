/* scripts/panel-kit-test.mjs —— 面板共享组件库（src/server/panel-kit.js）的口径测试。
 *
 * 这层测的是面板改版的一条硬纪律：**状态是数据，不是装饰**。
 *   ① 同一个状态在任何地方都必须是同一句话、同一个颜色 —— 所以措辞与语义色
 *      只能有一处定义（panel-kit.js），卡片自己写就是漂移的开始。
 *   ② 颜色只经语义类名给（ok/warn/err/idle/brand），不许写死 —— 深浅两套主题
 *      的颜色都定义在 CSS 变量里，写死就等于只有一套主题能用。
 *   ③ 面板要显示上游返回的字符串，所以所有用户可见文字都要转义。
 *
 * 组件是纯函数（返回 HTML 字符串），所以这一层**不需要浏览器**：
 * 把脚本在 vm 里求值出 window.BAI_KIT，剩下的都是字符串断言。
 *
 * 最后一段是**反向对照**：把实现改坏（写临时副本再加载），证明上面那些断言
 * 真的会红 —— 不然这些断言只是摆设。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const KIT_PATH = path.join(ROOT, "src", "server", "panel-kit.js");
const CARD_HEATMAP = path.join(ROOT, "src", "server", "cards", "channel-heatmap.js");
const CARD_STRIP = path.join(ROOT, "src", "server", "cards", "status-strip.js");

const KIT_SRC = fs.readFileSync(KIT_PATH, "utf8");
const HEATMAP_SRC = fs.readFileSync(CARD_HEATMAP, "utf8");
const STRIP_SRC = fs.readFileSync(CARD_STRIP, "utf8");

/* 六种状态的中文措辞 —— **测试自己写一份**是有意的：
   这里是「独立复核」，不是抄实现。实现里多写一次、少写一次，这里都会红。 */
const STATE_LABELS = {
  ok: "可用",
  cooling: "冷却中",
  resting: "休息中",
  exhausted: "预算用完",
  unconfigured: "未配置",
  unknown: "状态不明",
};
/* 措辞 → 语义色：探不到（unknown）与坏了（err）必须分开，
   混起来会让用户以为账号被封了，而真相可能只是这条网络不通。 */
const STATE_TONES = {
  ok: "ok",
  cooling: "warn",
  resting: "warn",
  exhausted: "err",
  unconfigured: "idle",
  unknown: "idle",
};
const ALL_LABELS = Object.values(STATE_LABELS);

/* ====================================================================== *
 * 工具
 * ====================================================================== */

/* 剥掉 JS 注释（块注释 + 行注释）。
   注释里出现「冷却中」是在解释问题，不是在定义措辞 —— 计数时必须剥掉。 */
function stripComments(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* 数一个措辞作为**字符串字面量**出现了几次。
   用字面量而不是裸子串：「不可用」里也含「可用」，裸子串会把两者搞混。 */
function countLiterals(src, label) {
  const re = new RegExp("[\"'`]" + escapeRx(label) + "[\"'`]", "g");
  return (src.match(re) || []).length;
}

/* 写死颜色 detector：十六进制色值、rgb()/hsl()、以及 inline style 里的颜色属性。 */
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

/* 上游字符串必须被转义掉的判据（正反对照共用同一个函数）。 */
function assertEscaped(html, raw, what) {
  assert.ok(html.indexOf(raw) < 0, `${what}：上游原文没有被转义，仍以原样出现在 HTML 里`);
  assert.ok(html.indexOf("&lt;") >= 0 || html.indexOf("&amp;") >= 0
    || html.indexOf("&quot;") >= 0 || html.indexOf("&#39;") >= 0,
  `${what}：没有看到转义后的实体`);
}

/* 最小 DOM 桩：卡片只在 mount() 里碰 DOM，桩只要够卡片画一张盒子就够。 */
function fakeEl(tag) {
  const el = {
    tagName: tag || "div",
    className: "",
    id: "",
    innerHTML: "",
    children: [],
    listeners: {},
    attrs: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    closest() { return null; },
    querySelector(sel) {
      const m = /data-role="([^"]+)"/.exec(sel);
      const key = m ? m[1] : sel;
      if (this.innerHTML.indexOf("data-role=\"" + key + "\"") < 0) return null;
      if (!this._kids) this._kids = new Map();
      if (!this._kids.has(key)) this._kids.set(key, { innerHTML: "" });
      return this._kids.get(key);
    },
  };
  return el;
}

function fakeDocument() {
  return {
    createElement: (tag) => fakeEl(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
}

/* 在沙箱里真求值一个浏览器脚本，返回它挂到 window 上的东西。
   卡片文件顶层只做 window.BAI_CARDS[name] = {...}，所有 DOM 访问都在 mount() 里。
   传入 win 就复用同一个 window —— 组件库与卡片必须在同一个 window 上，
   否则卡片读不到 window.BAI_KIT（这正是 provider.html 里静态引入的效果）。 */
function evalScript(src, filename, win) {
  const w = win || {};
  const sandbox = {
    window: w,
    document: fakeDocument(),
    console,
    location: { pathname: "/", href: "http://127.0.0.1/" },
    navigator: { userAgent: "node" },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error("offline")),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: filename || "inline.js", timeout: 5000 });
  return { win: w, sandbox };
}

/* 加载组件库（正式源）。 */
function loadKit(src, filename) {
  const { win } = evalScript(src, filename || "panel-kit.js");
  assert.ok(win.BAI_KIT, "组件库必须挂在 window.BAI_KIT 上");
  return win.BAI_KIT;
}

const KIT = loadKit(KIT_SRC, KIT_PATH);

/* 写临时副本再加载 —— 反向对照用它：改坏的实现必须真的被求值、真的让断言红。 */
function withBrokenCopy(src, label, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-kit-bad-"));
  const file = path.join(dir, label);
  const brokenSrc = mutate(src);
  fs.writeFileSync(file, brokenSrc, "utf8");
  try {
    return { src: brokenSrc, kit: loadKit(fs.readFileSync(file, "utf8"), file) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* import detector：组件库是浏览器端的普通 <script>，一旦开始 import 就坏了。 */
function hasModuleImport(src) {
  const code = stripComments(src);
  return /(^|[^\w$.])(?:import|export)\s[^;]*?\sfrom\s*["']/.test(code)
    || /(^|[^\w$.])import\s*["']/.test(code)
    || /(^|[^\w$.])require\s*\(\s*["']/.test(code);
}

/* ====================================================================== *
 * ① 组件库本身：纯函数、不碰 DOM、不 import 任何东西
 * ====================================================================== */
describe("① 组件库的边界 —— 纯函数，不碰 DOM，不 import", () => {
  test("①a 求值时不碰 document / fetch —— 组件库是纯字符串工厂", () => {
    const boom = new Proxy({}, {
      get() { throw new Error("组件库在求值时碰了 DOM"); },
    });
    const sandbox = {
      window: {},
      document: boom,
      fetch: () => { throw new Error("组件库不许发请求"); },
      console,
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    assert.doesNotThrow(() => vm.runInContext(KIT_SRC, sandbox, { filename: KIT_PATH, timeout: 5000 }),
      "组件库在浏览器端是纯脚本：求值时不得访问 DOM，也不得发请求");
    assert.ok(sandbox.window.BAI_KIT, "求值后应当挂上 window.BAI_KIT");
  });

  test("①b 不 import 任何东西 —— 浏览器端的普通 <script>", () => {
    assert.equal(hasModuleImport(KIT_SRC), false,
      "组件库不许 import：它由 provider.html 用普通 <script> 静态引入");
  });

  test("①c 四个组件都在，签名对", () => {
    for (const fn of ["stateBadge", "meter", "statusStrip", "heatmap"]) {
      assert.equal(typeof KIT[fn], "function", `缺组件 ${fn}`);
    }
    assert.equal(typeof KIT.esc, "function", "必须有 esc() 助手");
    assert.equal(KIT.stateBadge.length, 3, "stateBadge(state, text, opts)");
    assert.equal(KIT.meter.length, 2, "meter(ratio, opts)");
    assert.equal(KIT.statusStrip.length, 1, "statusStrip(data)");
    assert.equal(KIT.heatmap.length, 2, "heatmap(channels, opts)");
  });
});

/* ====================================================================== *
 * ② 状态徽章：措辞与颜色一处定义
 * ====================================================================== */
describe("② 状态徽章 —— 六态一处定义", () => {
  test("②a 六种状态各自的措辞与语义色都对得上", () => {
    for (const [state, label] of Object.entries(STATE_LABELS)) {
      const html = KIT.stateBadge(state);
      assert.ok(html.indexOf(label) >= 0, `${state} 徽章里没有「${label}」`);
      assert.ok(html.indexOf(STATE_TONES[state]) >= 0,
        `${state} 的语义色应是 ${STATE_TONES[state]}（探不到与坏了必须分开）`);
      assert.ok(html.indexOf("led") >= 0, "徽章要有一个色点");
    }
  });

  test("②b 不认识的 state 退化成 unknown —— 宁可说「不明」也不说错", () => {
    const html = KIT.stateBadge("someBrandNewState");
    assert.ok(html.indexOf(STATE_LABELS.unknown) >= 0, "不认识的状态应按 unknown 显示");
    assert.ok(html.indexOf("idle") >= 0, "unknown 的语义色是 idle，不是 err");
  });

  test("②c text 参数能覆盖措辞，但覆盖的也必须转义", () => {
    const html = KIT.stateBadge("ok", "<b>自己写的</b>", {});
    assert.ok(html.indexOf("<b>") < 0, "覆盖文案必须转义");
    assert.ok(html.indexOf("&lt;b&gt;") >= 0);
  });

  test("②d 六态的措辞在本文件里各只出现一次（作为字符串字面量）", () => {
    const code = stripComments(KIT_SRC);
    for (const [state, label] of Object.entries(STATE_LABELS)) {
      const n = countLiterals(code, label);
      assert.equal(n, 1, `「${label}」（${state}）应当只定义一次，实际 ${n} 次`);
    }
  });

  test("②e STATE_TEXT / STATE_TONE 暴露的六态与措辞表一致", () => {
    assert.deepEqual(Object.keys(KIT.STATE_TEXT).sort(), Object.keys(STATE_LABELS).sort());
    for (const [state, label] of Object.entries(STATE_LABELS)) {
      assert.equal(KIT.STATE_TEXT[state], label);
      assert.equal(KIT.STATE_TONE[state], STATE_TONES[state]);
    }
  });
});

/* ====================================================================== *
 * ③ 量条：百分比 + 阈值着色
 * ====================================================================== */
describe("③ 量条 —— 百分比与阈值", () => {
  test("③a 0.5 → 50%，绿色", () => {
    const html = KIT.meter(0.5);
    assert.ok(html.indexOf("50%") >= 0, "量条要显示百分比");
    assert.ok(html.indexOf("bkit-meter-fill ok") >= 0, "一半不该是黄或红");
  });

  test("③b 越线先黄后红 —— 一眼看得出「快满了」", () => {
    assert.ok(KIT.meter(0.8).indexOf("warn") >= 0, "80% 应转黄");
    assert.ok(KIT.meter(0.95).indexOf("err") >= 0, "95% 应转红");
    assert.ok(KIT.meter(0.75).indexOf("warn") >= 0, "正好 75% 应转黄");
  });

  test("③c 没有数据画成「—」—— 「没有」与「是 0」是两件事", () => {
    const html = KIT.meter(null);
    assert.ok(html.indexOf("—") >= 0, "读不到比例要显示「—」");
    assert.ok(html.indexOf("idle") >= 0, "读不到比例不该画成红色（会让人以为用光了）");
    /* 百分比那一格显示的是「—」而不是「0%」：0% 是真的用光了。 */
    const shown = /bkit-meter-pct">([^<]*)</.exec(html);
    assert.ok(shown, "量条要有一格显示百分比");
    assert.equal(shown[1], "—", "读不到比例不能报成 0%");
  });

  test("③d max 可以声明单位（百分比）", () => {
    const html = KIT.meter(42, { max: 100 });
    assert.ok(html.indexOf("42%") >= 0, "max=100 时 42 就是 42%");
  });

  test("③e 比例被夹在 0..100 之间 —— 越界不许画出一根溢出的条", () => {
    assert.ok(KIT.meter(5).indexOf("100%") >= 0, "ratio 大于 max 应夹到 100%");
    assert.ok(KIT.meter(-1).indexOf("0%") >= 0, "负比例应夹到 0%");
  });

  test("③f 量条输出里不许有写死的颜色", () => {
    assertNoHardcodedColors(KIT.meter(0.42), "量条输出");
  });
});

/* ====================================================================== *
 * ④ 顶部横条：五格
 * ====================================================================== */
describe("④ 顶部横条 —— 五格", () => {
  const data = {
    service: { tone: "ok", text: "运行中", sub: "已运行 2 小时" },
    current: { tone: "brand", text: "WorkBuddy", sub: "" },
    traffic: { tone: "brand", text: "3 在途", sub: "2 家在扛" },
    usage: { tone: "ok", text: "12k", sub: "已用 token" },
    quota: { tone: "warn", text: "剩 22%", sub: "780k / 1M" },
  };

  test("④a 五格都在，格名固定", () => {
    const html = KIT.statusStrip(data);
    for (const cap of ["服务", "当前接的", "流量", "用量", "额度"]) {
      assert.ok(html.indexOf(cap) >= 0, `横条缺「${cap}」这一格`);
    }
  });

  test("④b 每格的颜色由 tone 决定，且只用语义类名", () => {
    const html = KIT.statusStrip(data);
    assert.ok(html.indexOf("led ok") >= 0, "服务格是绿色");
    assert.ok(html.indexOf("led brand") >= 0, "当前接的那格是品牌色");
    assert.ok(html.indexOf("led warn") >= 0, "额度格是黄色");
    assertNoHardcodedColors(html, "横条输出");
  });

  test("④c 缺格不塌 —— 画成「—」，不编数字", () => {
    const html = KIT.statusStrip({ service: { tone: "ok", text: "运行中" } });
    assert.ok(html.indexOf("—") >= 0, "缺的格要显示「—」");
    assert.ok(html.indexOf("idle") >= 0, "缺的格是 idle，不是错色");
  });

  test("④d 传给横条的文字一律转义", () => {
    const html = KIT.statusStrip({ service: { tone: "err", text: "<script>x</script>" } });
    assertEscaped(html, "<script>x</script>", "横条文字");
  });
});

/* ====================================================================== *
 * ⑤ 渠道热力图：一家一格
 * ====================================================================== */
describe("⑤ 渠道热力图 —— 一家一格", () => {
  const channels = [
    { key: "wb", name: "WorkBuddy", state: "cooling", reason: "429 限流", busy: 2, used: 300, limit: 1000, ratio: 30, detail: "还差 30 秒" },
    { key: "sn", name: "SenseNova", state: "ok", reason: "", busy: 0, used: 10, limit: 100, ratio: 10, detail: "" },
  ];

  test("⑤a 一家一格，格数对得上", () => {
    const html = KIT.heatmap(channels);
    assert.equal((html.match(/bkit-heat-cell/g) || []).length, 2, "两个渠道 = 两格");
    assert.ok(html.indexOf("WorkBuddy") >= 0);
    assert.ok(html.indexOf("SenseNova") >= 0);
  });

  test("⑤b 每格带状态徽章与可点回渠道的 key", () => {
    const html = KIT.heatmap(channels);
    assert.ok(html.indexOf("data-channel=\"wb\"") >= 0, "格子要带 data-channel，卡片靠它做事件委托");
    assert.ok(html.indexOf(STATE_LABELS.cooling) >= 0, "冷却中的渠道要显示中央措辞");
    assert.ok(html.indexOf(STATE_LABELS.ok) >= 0);
  });

  test("⑤c 上游字符串（渠道名 / 原因 / 详情）全部转义", () => {
    const evil = [{
      key: "<img src=x onerror=alert(1)>",
      name: "<script>alert(1)</script>",
      state: "ok",
      reason: "\"><b>坑</b>",
      busy: 0, used: 0, limit: 0, ratio: 0,
      detail: "<i>detail</i>",
    }];
    const html = KIT.heatmap(evil);
    assert.ok(html.indexOf("<script>") < 0, "渠道名里的标签不许原样进 HTML");
    assert.ok(html.indexOf("<img src=x") < 0, "key 里的标签不许原样进 HTML");
    assert.ok(html.indexOf("<b>坑</b>") < 0, "原因里的标签不许原样进 HTML");
    assert.ok(html.indexOf("&lt;script&gt;") >= 0, "应当看到转义后的实体");
  });

  test("⑤d 没有渠道是空态，不是报错", () => {
    const html = KIT.heatmap([], { empty: "还没有渠道信息" });
    assert.ok(html.indexOf("还没有渠道信息") >= 0);
    assert.equal((html.match(/bkit-heat-cell/g) || []).length, 0);
  });

  test("⑤e 非数组入参不炸（面板拿到的可能是 null）", () => {
    assert.equal(typeof KIT.heatmap(null), "string");
    assert.equal(typeof KIT.heatmap(undefined), "string");
  });
});

/* ====================================================================== *
 * ⑥ 两张卡真的用上了共享组件
 * ====================================================================== */
describe("⑥ 两张卡用共享组件画", () => {
  const CHANNELS_PAYLOAD = {
    ok: true,
    channels: [
      { key: "wb", name: "WorkBuddy", state: "cooling", reason: "429 限流", busy: 2, used: 300, limit: 1000, ratio: 30, detail: "" },
      { key: "sn", name: "SenseNova", state: "ok", reason: "", busy: 0, used: 10, limit: 100, ratio: 10, detail: "" },
    ],
  };

  function mountCard(cardSrc, cardFile, ctxExtra) {
    /* 组件库必须先在同一个 window 上就位 —— provider.html 里静态引入，
       卡片是运行时动态加载的，它加载时组件库早就在页面上了。 */
    const { win } = evalScript(KIT_SRC, KIT_PATH);
    evalScript(cardSrc, cardFile, win);
    const slot = fakeEl("div");
    const calls = [];
    const picked = [];
    const ctx = Object.assign({
      $: () => null,
      slot,
      api: async (p) => { calls.push(p); return CHANNELS_PAYLOAD; },
      esc: (s) => String(s == null ? "" : s),
      nameOf: (k) => ({ wb: "WorkBuddy", sn: "SenseNova" }[k] || k),
      selectChannel: (k) => picked.push(k),
    }, ctxExtra || {});
    const name = Object.keys(win.BAI_CARDS || {})[0];
    const card = (win.BAI_CARDS || {})[name];
    assert.equal(typeof card.mount, "function", "卡片必须导出 mount(ctx)");
    const view = card.mount(ctx);
    const box = slot.children[0];
    const body = box.querySelector('[data-role="hm-body"]') || box.querySelector('[data-role="ss-body"]');
    return { card, view, box, body, calls, picked, ctx };
  }

  test("⑥a 热力图卡：读对接口、画的是共享组件的热力图", async () => {
    const { view, box, body, calls, picked } = mountCard(HEATMAP_SRC, CARD_HEATMAP);
    await view.update();
    assert.ok(calls.indexOf("/api/channels/state") >= 0, "要读 /api/channels/state");
    assert.ok(body.innerHTML.indexOf("bkit-heat") >= 0, "格子必须是共享组件画的");
    assert.ok(body.innerHTML.indexOf("WorkBuddy") >= 0);
    assert.ok(body.innerHTML.indexOf(STATE_LABELS.cooling) >= 0, "状态措辞走中央那一份");
    /* 点格子要能切到那家 —— 靠 data-channel 事件委托。 */
    const click = (box.listeners.click || [])[0];
    assert.equal(typeof click, "function", "热力图卡要能接点击");
    click({ target: { closest: () => ({ getAttribute: () => "wb" }) } });
    assert.deepEqual(picked, ["wb"], "点格子应当切到那家");
  });

  test("⑥b 横条卡：五格齐，且格名由共享组件定", async () => {
    const { view, body } = mountCard(STRIP_SRC, CARD_STRIP, {
      get status() {
        return {
          service: { up: true, uptimeSec: 3600 },
          cli: { mode: "wb" },
          desktop: { mode: "wb" },
        };
      },
    });
    await view.update();
    assert.ok(body.innerHTML.indexOf("bkit-strip") >= 0, "横条必须是共享组件画的");
    for (const cap of ["服务", "当前接的", "流量", "用量", "额度"]) {
      assert.ok(body.innerHTML.indexOf(cap) >= 0, `横条缺「${cap}」这一格`);
    }
    assert.ok(body.innerHTML.indexOf("运行中") >= 0, "服务格应当说服务在跑");
    assert.ok(body.innerHTML.indexOf("WorkBuddy") >= 0, "当前接的应当说真正在用的那家");
    assert.ok(body.innerHTML.indexOf("2 在途") >= 0, "流量格应当汇总各家的在途数");
  });

  test("⑥c 热力图卡：读回来之前画的是「正在读」，不是空白也不是「没有渠道」", () => {
    const { body, view } = mountCard(HEATMAP_SRC, CARD_HEATMAP);
    assert.ok(body.innerHTML.indexOf("正在读") >= 0, "首屏要先说在读，别拿空白冒充没有渠道");
    assert.equal(body.innerHTML.indexOf("还没有渠道信息") < 0, true, "还没读回来不等于没有渠道");
    return view.update();
  });

  test("⑥d 两张卡都不得自己写状态措辞", () => {
    for (const [label, src] of [["热力图卡", HEATMAP_SRC], ["横条卡", STRIP_SRC]]) {
      for (const w of ALL_LABELS) {
        assert.equal(src.indexOf(w) < 0, true,
          `${label}里出现了「${w}」—— 状态措辞只能在 panel-kit.js 里定义一次`);
      }
    }
  });

  test("⑥e 两张卡不许写死颜色", () => {
    assertNoHardcodedColors(HEATMAP_SRC, "热力图卡");
    assertNoHardcodedColors(STRIP_SRC, "横条卡");
  });

  test("⑥f 两张卡必须引用共享组件（不许自己另起一套）", () => {
    assert.ok(HEATMAP_SRC.indexOf("BAI_KIT") >= 0, "热力图卡要用 BAI_KIT");
    assert.ok(STRIP_SRC.indexOf("BAI_KIT") >= 0, "横条卡要用 BAI_KIT");
  });
});

/* ====================================================================== *
 * ⑦ 源码层面的纪律：颜色只走语义类名、措辞只在一处
 * ====================================================================== */
describe("⑦ 源码层面的纪律", () => {
  test("⑦a 组件库源码里没有写死的颜色", () => {
    assertNoHardcodedColors(stripComments(KIT_SRC), "组件库源码");
  });

  test("⑦b 组件库只经语义类名给颜色（ok/warn/err/idle/brand）", () => {
    const code = stripComments(KIT_SRC);
    const tones = ["ok", "warn", "err", "idle", "brand"];
    for (const t of tones) {
      assert.ok(code.indexOf(t) >= 0, `语义色 ${t} 应当出现在组件库里`);
    }
    /* 状态 → 颜色的对应关系也只在这里定一次。 */
    for (const [state, tone] of Object.entries(STATE_TONES)) {
      assert.equal(KIT.STATE_TONE[state], tone, `${state} 的语义色应当是 ${tone}`);
    }
  });

  test("⑦c 组件库里 inline style 只许放几何（宽度），不许放颜色", () => {
    const code = stripComments(KIT_SRC);
    const styles = code.match(/style=\\"[^"]*\\"/g) || [];
    for (const s of styles) {
      assert.ok(/width:\s*\d+(\.\d+)?%/.test(s), `inline style 里有非几何内容：${s}`);
    }
  });

  test("⑦d 六态的措辞在组件库里各定义一次", () => {
    const code = stripComments(KIT_SRC);
    for (const [state, label] of Object.entries(STATE_LABELS)) {
      assert.equal(countLiterals(code, label), 1, `「${label}」（${state}）应当只定义一次`);
    }
  });
});

/* ====================================================================== *
 * ⑧ 反向对照：把实现改坏，对应断言必须真的会红
 * ====================================================================== */
describe("⑧ 反向对照 —— 改坏实现，对应断言必须红", () => {
  test("⑧a 把转义改坏 ⇒ ②c / ⑤c 的转义断言必须红", () => {
    const broken = withBrokenCopy(KIT_SRC, "no-esc.js", (src) =>
      src.replace('String(s == null ? "" : s).replace(/[&<>"\']/g, (c) => ESC_MAP[c])',
        'String(s == null ? "" : s)'));
    assert.notEqual(broken.kit.esc("<b>"), "&lt;b&gt;", "改坏的副本应当真的不转义");
    assert.throws(() => assertEscaped(broken.kit.stateBadge("ok", "<img src=x onerror=1>", {}),
      "<img src=x onerror=1>", "热力图卡"), "转义断言必须红");
    assert.throws(() => assertEscaped(broken.kit.heatmap([{ key: "k", name: "<script>alert(1)</script>" }]),
      "<script>alert(1)</script>", "热力图"), "热力图的转义断言必须红");
  });

  test("⑧b 把颜色写死 ⇒ 颜色纪律断言必须红", () => {
    const broken = withBrokenCopy(KIT_SRC, "hard-color.js", (src) =>
      src.replace('style=\\"width:" + (known ? pct : 0) + "%\\"',
        'style=\\"width:" + (known ? pct : 0) + "%;background:#ff0000\\"'));
    const html = broken.kit.meter(0.5);
    assert.ok(html.indexOf("#ff0000") >= 0, "改坏的副本应当真的写死了颜色");
    assert.throws(() => assertNoHardcodedColors(html, "量条输出"), "颜色纪律断言必须红");
    assert.throws(() => assertNoHardcodedColors(stripComments(broken.src), "组件库源码"),
      "源码层的颜色断言必须红");
  });

  test("⑧c 在卡片里自己写状态措辞 ⇒ ⑥d 必须红", () => {
    const broken = HEATMAP_SRC.replace('const kit = window.BAI_KIT || null;',
      'const kit = window.BAI_KIT || null;\n    const LOCAL_WORD = "冷却中";');
    const hit = ALL_LABELS.filter((w) => broken.indexOf(w) >= 0);
    assert.deepEqual(hit, ["冷却中"], "改坏的卡片应当被抓出自己写的措辞");
    assert.throws(() => {
      assert.equal(broken.indexOf("冷却中") < 0, true,
        "状态措辞只能在 panel-kit.js 里定义一次");
    }, "卡片措辞纪律的断言必须红");
  });

  test("⑧d 同一措辞定义两次 ⇒ ②d / ⑦d 必须红", () => {
    const broken = withBrokenCopy(KIT_SRC, "dup-state.js", (src) =>
      src.replace("const STATES = [", "const DUP = \"冷却中\";\n  const STATES = ["));
    const code = stripComments(broken.src);
    assert.equal(countLiterals(code, "冷却中"), 2, "改坏的副本应当把措辞定义成两次");
    assert.throws(() => {
      assert.equal(countLiterals(code, "冷却中"), 1, "「冷却中」（cooling）应当只定义一次");
    }, "措辞唯一性断言必须红");
  });

  test("⑧e 状态与颜色对不上（unknown 画成 err）⇒ ②a 必须红", () => {
    const broken = withBrokenCopy(KIT_SRC, "wrong-tone.js", (src) =>
      src.replace('unknown: "idle",', 'unknown: "err",'));
    assert.equal(broken.kit.STATE_TONE.unknown, "err", "改坏的副本应当把「探不到」画成红色");
    assert.notEqual(broken.kit.STATE_TONE.unknown, STATE_TONES.unknown,
      "探不到与坏了必须分开 —— 混起来会让用户以为账号被封了");
    assert.throws(() => {
      assert.equal(broken.kit.STATE_TONE.unknown, STATE_TONES.unknown, "unknown 的语义色应当是 idle");
    }, "状态→颜色对应关系的断言必须红");
  });

  test("⑧f 组件库若开始 import ⇒ ①b 必须红", () => {
    const brokenSrc = KIT_SRC.replace("(function (global) {", "import x from './y.js';\n(function (global) {");
    assert.equal(hasModuleImport(brokenSrc), true,
      "改坏的副本应当真的 import 了东西");
    assert.throws(() => {
      assert.equal(hasModuleImport(brokenSrc), false, "组件库不许 import");
    }, "「不许 import」的断言必须红");
  });
});
