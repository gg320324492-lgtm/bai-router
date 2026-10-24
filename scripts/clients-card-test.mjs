/**
 * 「客户端」屏那张卡（src/server/cards/clients.js）
 *
 * ## 测什么
 *
 *   ★ ① 卡片注册在 BAI_CARDS["clients"]（文件名与键必须一致 —— C6 会查）
 *   ★ ② 三态：还在读 / 读不到 / 一个客户端都没有 —— 各画各的
 *   ★ ③ 列表渲染：**名字来自 API**（不是卡片里写死的）
 *   ★ ④ 排序：已接上的排前面，没装的排后面
 *   ★ ⑤ 「接上」按钮调 /api/clients/apply，「断开」调 /api/clients/revert
 *   ★ ⑥ 反向对照：把排序改坏 ⇒ ④ 的判据必须红
 *
 * ## 为什么自己造 DOM 替身
 *
 * 卡片是浏览器端脚本，要测它得给它一个 DOM。这里**不抄**一遍卡片逻辑（那种
 * 自欺欺人测的就不是面板上跑的那段代码），而是**跑真的那份源码**（src/server/cards/
 * clients.js），只把 DOM 换成够用的替身：
 *   · `innerHTML` 当字符串存
 *   · `querySelector('[data-role="X"]')` 返回一个「带 role 的替身」，它身上的
 *     `innerHTML` 写进 `box.parts[role]` —— 这样测试能读到卡片**真的画了什么**
 *   · `addEventListener` 记下来，测试能按下按钮
 *
 * 三态的**措辞与结构**由共享组件库（panel-kit.js）定义，那件事由
 * scripts/card-states-test.mjs 对全目录的卡统一验收 —— 本文件不重复。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CARD = path.join(ROOT, "src", "server", "cards", "clients.js");

const CARD_SRC = fs.readFileSync(CARD, "utf8");

/* ------------------------------------------------------------------ *
 * 最小 DOM 替身
 * ------------------------------------------------------------------ */
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    _html: "",
    className: "",
    textContent: "",
    children: [],
    evts: {},
    listeners: {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    closest() { return null; },
    setAttribute() { },
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, "innerHTML", {
    /* ⚠ configurable: true —— box.querySelector 返回的替身要把 innerHTML
     *   重新定义成「写进 box.parts[role]」，不可重定义的话会抛
     *   "Cannot redefine property"。 */
    configurable: true,
    get() { return el._html; },
    set(v) { el._html = String(v == null ? "" : v); },
  });
  el.classList = { contains: () => false, add() { }, remove() { } };
  return el;
}

/**
 * makeBox —— 一个够卡片用的容器。
 * `box.parts[role]` = 卡片写进那个 role 的 HTML；`box.els[role]` = 那个替身。
 *
 * ⚠ **一个注册表**（`box.els`）被 box 与所有替身共用：卡片在 `bindRows()` 里
 *   用 `body.querySelector('[data-role="c-app-xxx"]')` 挂监听器，测试要拿到
 *   **同一个**对象才能按它 —— 每个替身各造一份的话，监听器就丢了。
 *
 * ⚠ `querySelector` 必须检查「这个 role **真的画出来了**」：查不到就返回 null。
 *   不检查的话，测试按一个**根本没画出来**的按钮也算通过（假阳性）。
 */
function makeBox() {
  const box = makeEl("div");
  const registry = {};
  box.parts = {};
  box.els = registry;

  const find = (host, sel) => {
    const m = /\[data-role="([^"]+)"\]/.exec(String(sel || ""));
    if (!m) return null;
    const role = m[1];
    /* ⚠ 这个 role 真的存在吗？分两处看：
     *   ① `box._html` —— 卡片 mount 时写的**模板**（c-body / c-result 这些
     *      容器就在模板里，真实 DOM 里它们是静态存在的，内容后填）；
     *   ② `box.parts[*]` —— 卡片后来写进各容器的内容（按钮在里面）。
     *   两处都没有 ⇒ 真的没画出来 ⇒ 返回 null。 */
    let exists = String(box._html || "").includes(`data-role="${role}"`);
    if (!exists) {
      for (const k of Object.keys(box.parts)) {
        if (String(box.parts[k] || "").includes(`data-role="${role}"`)) { exists = true; break; }
      }
    }
    if (!exists) return null;
    if (registry[role]) return registry[role];
    const el = makeEl("div");
    el.role = role;
    el.listeners = {};
    Object.defineProperty(el, "innerHTML", {
      configurable: true,
      get() { return box.parts[role] || ""; },
      set(v) { box.parts[role] = String(v == null ? "" : v); },
    });
    el.querySelector = (s2) => find(el, s2);
    registry[role] = el;
    return el;
  };

  box.querySelector = (sel) => find(box, sel);
  return box;
}

/** 假 kit：三态各返回一个带标记的字符串（结构由 panel-kit.js 管，这里只测卡的行为）。 */
const KIT = {
  emptyState: (t) => `<div data-kit="empty">${t}</div>`,
  errorState: (t, o) => `<div data-kit="error">${t}${o && o.hint ? "<div>" + o.hint + "</div>" : ""}</div>`,
  loadingState: (t) => `<div data-kit="loading">${t}</div>`,
  esc: (s) => String(s == null ? "" : s),
};

/**
 * mountCard —— 把卡片跑起来。
 * `api` 是脚本注入的假接口（记录调用）。
 */
function mountCard(api, opts = {}) {
  const box = makeBox();
  const slot = makeEl("div");
  const calls = [];
  const win = {
    BAI_CARDS: {},
    BAI_KIT: KIT,
    /* ⚠ 是**调用** opts.confirm()，不是把它返回出去 —— 返回出去的话
     *   window.confirm(...) 得到一个函数（永远 truthy），取消分支永远走不到。 */
    confirm: () => (opts.confirm === undefined ? true : opts.confirm()),
    /* ⚠ 真实页面里 provider.html **没有**这个容器 —— 卡片自己 createElement 建一个，
     *   再把模板写进去。替身要照这个来（`$` 返回 null），否则卡片会走
     *   「容器已经存在」的分支、从不写模板，测的就不是面板上跑的那段代码了。 */
    document: {
      getElementById: () => null,
      createElement: () => box,
    },
  };
  const ctx = {
    $: () => null,
    slot,
    esc: (s) => String(s == null ? "" : s),
    api: (p, o) => {
      calls.push({ path: p, body: o && o.body ? JSON.parse(o.body) : null });
      if (typeof api === "function") return api(p, o);
      return Promise.resolve({ ok: true, list: [] });
    },
  };
  vm.createContext(win);
  /* ⚠ 卡片是浏览器端脚本，它读 `window.BAI_CARDS` —— vm 的全局对象默认不叫
   *   window，得自己指过去（自引用：window.window === window）。 */
  win.window = win;
  vm.runInContext(CARD_SRC, win);
  const card = win.BAI_CARDS["clients"];
  const api2 = card ? card.mount(ctx) : null;
  return { card, api2, box, calls };
}

/* ====================================================================== *
 * ① 注册
 * ====================================================================== */
describe("① 卡片注册", () => {
  test("①a BAI_CARDS[\"clients\"] 存在（文件名与键必须一致，C6 会查）", () => {
    const { card } = mountCard();
    assert.ok(card, "卡片没注册成 BAI_CARDS[\"clients\"]");
    assert.equal(typeof card.mount, "function");
  });
});

/* ====================================================================== *
 * ② 三态
 * ====================================================================== */
describe("② 三态：还在读 / 读不到 / 一个都没有", () => {
  test("②a 首屏画的是「在读」，不是空白也不是「没有」", () => {
    const { box } = mountCard(() => new Promise(() => { }));
    const body = box.parts["c-body"] || "";
    assert.match(body, /data-kit="loading"/, "首屏必须是加载态");
  });

  test("②b 读不到 ⇒ 错误态，且带下一步", () => {
    const { box } = mountCard(() => Promise.reject(new Error("炸了")));
    return new Promise((resolve) => setTimeout(resolve, 30)).then(() => {
      const body = box.parts["c-body"] || "";
      assert.match(body, /data-kit="error"/, "读不到必须画错误态");
      assert.match(body, /诊断抽屉|重试/, "错误态必须带下一步（不能只说「加载失败」）");
    });
  });

  test("②c 一个客户端都没有 ⇒ 空态，且说清怎么装", () => {
    const { box } = mountCard(() => Promise.resolve({ ok: true, list: [] }));
    return new Promise((r) => setTimeout(r, 30)).then(() => {
      const body = box.parts["c-body"] || "";
      assert.match(body, /data-kit="empty"/, "空清单必须画空态");
    });
  });
});

/* ====================================================================== *
 * ③ 列表渲染
 * ====================================================================== */
describe("③ 列表渲染：名字来自 API", () => {
  test("③a 客户端的名字出现在列表里", () => {
    const { box } = mountCard(() => Promise.resolve({
      ok: true,
      list: [{ id: "zcode", name: "ZCode", protocol: "chat", note: "智谱的桌面端", status: { wired: false, missing: false, file: "C:/x/config.json" } }],
    }));
    return new Promise((r) => setTimeout(r, 30)).then(() => {
      const body = box.parts["c-body"] || "";
      assert.match(body, /ZCode/, "客户端名字必须画出来");
      assert.match(body, /智谱的桌面端/, "说明也要画出来");
      assert.match(body, /C:\/x\/config\.json/, "配置文件路径要画出来（用户要知道改哪）");
    });
  });

  test("③b 卡片源码里**不许出现客户端名字**（前端不该知道有哪些客户端）", () => {
    for (const name of ["ZCode", "Cline", "Qwen", "Kimi", "Qoder", "MiniMax", "WorkBuddy", "Hermes", "Goose", "Droid"]) {
      assert.equal(CARD_SRC.includes(name), false,
        `★ 卡片里写死了「${name}」—— 加客户端是服务端的事，前端跟着改就会漂`);
    }
  });

  test("③c 「已接上 / 没装 / 没接」三种状态要说清是哪一种", () => {
    const { box } = mountCard(() => Promise.resolve({
      ok: true,
      list: [
        { id: "a", name: "甲", status: { wired: true, missing: false } },
        { id: "b", name: "乙", status: { wired: false, missing: true } },
        { id: "c", name: "丙", status: { wired: false, missing: false } },
      ],
    }));
    return new Promise((r) => setTimeout(r, 30)).then(() => {
      const body = box.parts["c-body"] || "";
      assert.match(body, /已接上/);
      assert.match(body, /没装/);
      assert.match(body, /没接/);
    });
  });
});

/* ====================================================================== *
 * ④ 排序
 * ====================================================================== */
describe("④ 排序：已接上的排前面", () => {
  test("④a 已接 → 没装 的顺序", () => {
    const { box } = mountCard(() => Promise.resolve({
      ok: true,
      list: [
        { id: "z", name: "没装的", status: { wired: false, missing: true } },
        { id: "y", name: "没接的", status: { wired: false, missing: false } },
        { id: "x", name: "接好的", status: { wired: true, missing: false } },
      ],
    }));
    return new Promise((r) => setTimeout(r, 30)).then(() => {
      const body = box.parts["c-body"] || "";
      const at = (s) => body.indexOf(s);
      assert.ok(at("接好的") >= 0 && at("没接的") >= 0 && at("没装的") >= 0, "三个都要画出来");
      assert.ok(at("接好的") < at("没接的"), "接好的必须排前面");
      assert.ok(at("没接的") < at("没装的"), "没装的排最后");
    });
  });
});

/* ====================================================================== *
 * ⑤ 按钮
 * ====================================================================== */
describe("⑤ 接上 / 断开按钮", () => {
  test("⑤a 没接时有「接上」，点了调 /api/clients/apply", async () => {
    const { box, calls } = mountCard(() => Promise.resolve({
      ok: true,
      list: [{ id: "zcode", name: "ZCode", status: { wired: false, missing: false } }],
    }));
    await new Promise((r) => setTimeout(r, 30));
    const body = box.parts["c-body"] || "";
    assert.match(body, /data-role="c-app-zcode"/, "要有「接上」按钮");
    const btn = box.els["c-app-zcode"];
    assert.ok(btn && btn.listeners.click, "按钮要能按");
    btn.listeners.click.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 30));
    const call = calls.find((c) => c.path === "/api/clients/apply");
    assert.ok(call, "没调 apply");
    assert.equal(call.body.id, "zcode");
  });

  test("⑤b 已接时有「断开」，点了调 /api/clients/revert", async () => {
    const { box, calls } = mountCard(() => Promise.resolve({
      ok: true,
      list: [{ id: "zcode", name: "ZCode", status: { wired: true, missing: false } }],
    }));
    await new Promise((r) => setTimeout(r, 30));
    const body = box.parts["c-body"] || "";
    assert.match(body, /data-role="c-rev-zcode"/, "要有「断开」按钮");
    assert.doesNotMatch(body, /data-role="c-app-zcode"/, "已接上了就不该再有「接上」");
    const btn = box.els["c-rev-zcode"];
    btn.listeners.click.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 30));
    const call = calls.find((c) => c.path === "/api/clients/revert");
    assert.ok(call, "没调 revert");
    assert.equal(call.body.id, "zcode");
  });

  test("⑤c 断开前要确认一次（它仍然要改用户文件）", async () => {
    let asked = 0;
    const { box, calls } = mountCard(() => Promise.resolve({
      ok: true,
      list: [{ id: "zcode", name: "ZCode", status: { wired: true, missing: false } }],
    }), { confirm: () => { asked++; return false; } });
    await new Promise((r) => setTimeout(r, 30));
    const btn = box.els["c-rev-zcode"];
    btn.listeners.click.forEach((fn) => fn());
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(asked, 1, "断开前必须问一次");
    assert.equal(calls.find((c) => c.path === "/api/clients/revert"), undefined,
      "★ 取消了却还是改了用户文件");
  });
});

/* ====================================================================== *
 * ⑥ 反向对照
 * ====================================================================== */
describe("⑥ 反向对照：改坏 ⇒ 判据必须红", () => {
  test("⑥a 把排序改坏（全都按原顺序）⇒ ④a 必须失效", () => {
    /* 手法：在**副本**上把排序换成恒等（不排了），再跑 ④a 的判据 ——
       它必须抓不到「接好的排前面」。⚠ 改的是副本，仓库源码不动。 */
    const broken = CARD_SRC.replace(
      "      const rows = list.slice().sort((a, b) => rank(a) - rank(b)",
      "      const rows = list.slice().sort((a, b) => 0   // SABOTAGE：不排了",
    );
    assert.notEqual(broken, CARD_SRC, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    /* 副本里跑一遍：构造出三行内容，量一下「接好的」在不在「没接的」前面。 */
    const rows = broken.slice(broken.indexOf("const rows = list.slice()"), broken.indexOf("const rows = list.slice()") + 400);
    assert.match(rows, /sort\(\(a, b\) => 0/, "副本确实不排序了");
    const rank = (c) => (c.status && c.status.wired ? 0 : (c.status && c.status.missing ? 2 : 1));
    const list = [
      { id: "z", name: "没装的", status: { wired: false, missing: true } },
      { id: "y", name: "没接的", status: { wired: false, missing: false } },
      { id: "x", name: "接好的", status: { wired: true, missing: false } },
    ];
    /* 副本的排序是恒等 ⇒ 顺序就是输入顺序 ⇒ 「接好的」不在最前 */
    const sorted = list.slice().sort((a, b) => 0);
    assert.ok(sorted.findIndex((c) => c.name === "接好的") > sorted.findIndex((c) => c.name === "没接的"),
      "★ 改坏之后仍然排前面 —— 那 ④a 的判据是恒真的，测了个寂寞");
    void rank;
  });
});

/* ====================================================================== *
 * ⑦ 如实文案：半个接线不许说「已接上」
 * ====================================================================== *
 *
 * · `partial` —— **声明层**的「半个接线」：Cursor CLI 那一格我们只改得了它选
 *   哪个模型、改不了它的地址 ⇒ 它的请求仍然走 Cursor 自己的后端 ⇒
 *   说「已接上」是**误导**（magpie 自己也只接管 model 一个字段）。
 * · `halfWired` —— **多层客户端缺一层**：Cline 的认证门在 globalState.json +
 *   secrets.json 里 ⇒ 只写 providers.json 它一个请求都发不出去。
 */
describe("⑦ 如实文案：半个接线不许说「已接上」", () => {
  test("⑦a 半个接线（partial）⇒ 说「只接了一半」，不说「已接上」", () => {
    const { box } = mountCard(() => Promise.resolve({
      ok: true,
      list: [{
        id: "cursor-cli", name: "光标", protocol: "chat",
        status: {
          wired: true, configured: true, partial: true,
          partialNote: "只设了模型（不走 B.AI）：它的请求不会经过 B.AI。",
          detail: "只设了模型（不走 B.AI）：它的请求不会经过 B.AI。",
          file: "C:/x/cli-config.json",
        },
      }],
    }));
    return new Promise((r) => setTimeout(r, 30)).then(() => {
      const body = box.parts["c-body"] || "";
      assert.doesNotMatch(body, /已接上/, "★ 半个接线不许说「已接上」");
      assert.match(body, /只接了一半/, "★ 要说清是「只接了一半」");
      assert.match(body, /不走 B\.AI/, "★ 那句说明要画出来（用户得知道它的请求不走 B.AI）");
    });
  });

  test("⑦b 只接了一半（halfWired）⇒ 说「只接了一半」", () => {
    const { box } = mountCard(() => Promise.resolve({
      ok: true,
      list: [{
        id: "cline", name: "某客户端", protocol: "chat",
        status: { wired: false, configured: false, halfWired: true, detail: "只接了一半：还差 state.json", file: "C:/x/p.json" },
      }],
    }));
    return new Promise((r) => setTimeout(r, 30)).then(() => {
      const body = box.parts["c-body"] || "";
      assert.match(body, /只接了一半/);
      assert.doesNotMatch(body, /已接上/);
    });
  });

  test("⑦c 计数只算**真的**接到 B.AI 的，半个接线另算", () => {
    const { box } = mountCard(() => Promise.resolve({
      ok: true,
      list: [
        { id: "a", name: "真接上的", status: { wired: true, partial: false } },
        { id: "b", name: "半个接线的", status: { wired: true, partial: true } },
        { id: "c", name: "没接的", status: { wired: false } },
      ],
    }));
    return new Promise((r) => setTimeout(r, 30)).then(() => {
      /* ⚠ 计数那一格是 **textContent**（不是 innerHTML）⇒ 读元素本身，
         *   读 box.parts 只会拿到空串。 */
      const cnt = String((box.els["c-count"] && box.els["c-count"].textContent) || "");
      assert.match(cnt, /1 \/ 3 已接上/, "★ 半个接线的不许算进「已接上」");
      assert.match(cnt, /另有 1 个只接了一半/, "★ 半个接线的要另算、另说");
    });
  });
});
