/* scripts/card-states-test.mjs —— 卡片三态（空 / 错 / 加载）与键盘可达的验收。
 *
 * ── 这一层测的是什么 ──────────────────────────────────────────────
 *   改版 P5 的验收项是「每张卡三态都有」。这句话有三层意思，缺一层都不算过：
 *
 *   ① **三态都在**：还在读 / 没有数据 / 读不到，三种情况各画各的。
 *      把「没读到」画成「没有」，用户会以为出了故障，去查一个根本没发生的事；
 *      把「还在读」画成「没有」，用户会以为配置丢了。
 *
 *   ② **措辞与结构全站统一**：三态由共享组件库（src/server/panel-kit.js）一处定义。
 *      卡片只负责给内容，不许自己另起一套（同一件事二十种说法，用户得自己翻译）。
 *
 *   ③ **错误态必须带下一步**：一句「加载失败」是猜谜。
 *      「读不到额度信息 —— 看诊断抽屉」才是能执行的。
 *
 *   外加一条：**可点元素键盘也要够得着**。只给 tabindex 不够 ——
 *   键盘用户按 Space 不会有反应，那比不可达更糟：它看起来能聚焦，却按不动。
 *
 * ── 为什么用真源码 + 最小 DOM 替身，而不是抄一份逻辑 ─────────────
 *   卡片的渲染逻辑必须跑**真的那份源码**（src/server/cards/*.js）。
 *   抄一份到测试里那种自欺欺人，测的就不是面板上跑的那段代码了。
 *   替身只提供卡片真正用到的那几个 DOM 方法，够画一张盒子就够。
 *
 * ── 反向对照（文件末尾 ⑤） ──────────────────────────────────────
 *   判据只有一个：把实现改坏，对应断言必须**真的红**。
 *   恒真的断言比没有断言更坏 —— 它给人一个假的安全感。
 *
 * 红线：本文件不写真实 %APPDATA%\bai-router，不碰 ~/.claude/settings.json，
 *      不含任何真实令牌；落盘只在 os.tmpdir() 里（反向对照的临时副本）。
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
const CARDS_DIR = path.join(ROOT, "src", "server", "cards");
const KIT_PATH = path.join(ROOT, "src", "server", "panel-kit.js");

const KIT_SRC = fs.readFileSync(KIT_PATH, "utf8");
const readCard = (name) => fs.readFileSync(path.join(CARDS_DIR, name + ".js"), "utf8");

/* ====================================================================== *
 * ① 最小 DOM 替身
 * ====================================================================== */

const VOID_TAGS = new Set(["input", "br", "hr", "img", "meta", "link", "source"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const unesc = (s) => String(s).replace(/&(#?\w+);/g, (_, e) => (ENTITIES[e] != null ? ENTITIES[e] : _));
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseAttrs(s) {
  const out = {};
  const re = /([a-zA-Z_:@][-\w:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s || ""))) {
    out[m[1]] = unesc(m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] != null ? m[5] : "")));
  }
  return out;
}

/* 简单选择器：tag / #id / .class / [attr] / [attr="v"]，可以用空格连成后代序列。
   卡片用到的选择器全在这个范围里（[data-role="x"]、.msync-row[data-k]…）。 */
function parseSimple(sel) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([^\]=]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(sel))) {
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push({ k: m[4], v: m[5] });
  }
  return out;
}

class FakeNode {
  constructor(tag, attrs, doc) {
    this.tagName = String(tag || "div").toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.listeners = {};
    this.doc = doc || null;
    this._text = "";
    this.dataset = {};
    for (const k of Object.keys(this.attrs)) {
      if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = this.attrs[k];
    }
    this.className = this.attrs.class || "";
    /* classList：卡片会用它加/减 class（如展开态的 show）。 */
    const self = this;
    this.classList = {
      add(n) { const cur = self._classes(); cur.add(n); self._setClasses(cur); },
      remove(n) { const cur = self._classes(); cur.delete(n); self._setClasses(cur); },
      contains(n) { return self._classes().has(n); },
      toggle(n, on) {
        const cur = self._classes();
        const want = on === undefined ? !cur.has(n) : !!on;
        if (want) cur.add(n); else cur.delete(n);
        self._setClasses(cur);
        return want;
      },
    };
  }
  _classes() { return new Set(String(this.className || "").split(/\s+/).filter(Boolean)); }
  _setClasses(set) {
    this.className = [...set].join(" ");
    this.attrs.class = this.className;
  }
  get id() { return this.attrs.id || ""; }
  set id(v) {
    this.attrs.id = String(v);
    if (this.doc) this.doc.byId[String(v)] = this;
  }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "class") this.className = String(v);
    if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
  }
  removeAttribute(k) { delete this.attrs[k]; }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }
  set textContent(v) { this._text = String(v == null ? "" : v); this.children = []; }
  get innerHTML() { return this.children.map(serialize).join(""); }
  set innerHTML(v) {
    this.children = [];
    this._text = "";
    parseHTML(String(v == null ? "" : v), this);
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  /** insertBefore 的另一头：模型同步那块用它把按钮插到提示前面。 */
  before(node) {
    const i = this.parentNode ? this.parentNode.children.indexOf(this) : -1;
    if (i < 0 || !this.parentNode) return;
    this.parentNode.children.splice(i, 0, node);
    node.parentNode = this.parentNode;
  }
  insertBefore(c, ref) {
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  get firstElementChild() { return this.children.find((c) => c instanceof FakeNode) || null; }
  get parentElement() { return this.parentNode; }
  matches(sel) {
    const s = parseSimple(String(sel).trim());
    if (s.tag && this.tagName !== s.tag) return false;
    if (s.id && this.getAttribute("id") !== s.id) return false;
    for (const c of s.classes) {
      if (String(this.className || "").split(/\s+/).indexOf(c) < 0) return false;
    }
    for (const a of s.attrs) {
      if (a.v === undefined) { if (this.getAttribute(a.k) == null) return false; }
      else if (this.getAttribute(a.k) !== a.v) return false;
    }
    return true;
  }
  _walk(fn) {
    for (const c of this.children) { if (c instanceof FakeNode) { fn(c); c._walk(fn); } }
  }
  querySelectorAll(sel) {
    const parts = String(sel).trim().split(/\s+/);
    const last = parts[parts.length - 1];
    const out = [];
    this._walk((e) => { if (e.matches(last)) out.push(e); });
    /* 后代选择器只支持最朴素的一层（够卡片用了）：把祖先也一起匹配上。 */
    if (parts.length > 1) {
      const anc = parts[parts.length - 2];
      return out.filter((e) => {
        let p = e.parentNode;
        while (p) { if (p.matches(anc)) return true; p = p.parentNode; }
        return false;
      });
    }
    return out;
  }
  querySelector(sel) {
    const parts = String(sel).trim().split(/\s+/);
    const last = parts[parts.length - 1];
    let hit = null;
    this._walk((e) => { if (!hit && e.matches(last)) hit = e; });
    if (!hit) return null;
    if (parts.length > 1) {
      const anc = parts[parts.length - 2];
      let p = hit.parentNode;
      while (p) { if (p.matches(anc)) return hit; p = p.parentNode; }
      return null;
    }
    return hit;
  }
  closest(sel) {
    let e = this;
    while (e) { if (e instanceof FakeNode && e.matches(sel)) return e; e = e.parentNode; }
    return null;
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    const l = this.listeners[type] || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  /** 派发一个事件：会**冒泡**到祖先（卡片把监听器挂在容器上，靠委托）。 */
  dispatch(type, extra) {
    const ev = Object.assign({
      type,
      target: this,
      key: "",
      preventDefault() { this.defaultPrevented = true; },
      defaultPrevented: false,
      stopPropagation() { this._stopped = true; },
    }, extra || {});
    let node = this;
    while (node) {
      for (const fn of (node.listeners[type] || []).slice()) {
        fn(ev);
        if (ev._stopped) return ev;
      }
      node = node.parentNode;
    }
    return ev;
  }
}

/* 文本节点：真 DOM 里文本也是子节点，序列化时必须出现 ——
   漏掉它的话「卡片到底写了什么字」全都测不出来（只剩标签）。 */
class FakeText {
  constructor(t) { this._t = String(t); this.parentNode = null; }
  get textContent() { return this._t; }
  set textContent(v) { this._t = String(v == null ? "" : v); }
  get innerHTML() { return this._t; }
}

function serialize(el) {
  if (el instanceof FakeText) return el._t;
  if (!(el instanceof FakeNode)) return String(el == null ? "" : el);
  const attrs = Object.keys(el.attrs)
    .filter((k) => k !== "id" || el.attrs.id)
    .map((k) => ` ${k}="${String(el.attrs[k]).replace(/"/g, "&quot;")}"`).join("");
  const tag = el.tagName.toLowerCase();
  if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${el.innerHTML}</${tag}>`;
}

function parseHTML(html, parent) {
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z0-9-]+)((?:\s[^>]*?)?)(\/)?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    if (m[5] != null) {
      const node = new FakeText(unesc(m[5]));
      node.parentNode = top();
      top().children.push(node);
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = parseAttrs(m[3] || "");
    const selfClose = m[4] === "/" || VOID_TAGS.has(tag);
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const node = new FakeNode(tag, attrs, parent.doc);
    /* 带 id 的元素要登记进 byId —— 真 DOM 里 getElementById 找的就是它们。 */
    if (node.attrs.id && parent.doc) parent.doc.byId[node.attrs.id] = node;
    top().appendChild(node);
    if (!selfClose) stack.push(node);
  }
}

class FakeDoc {
  constructor() {
    this.byId = {};
    this.body = new FakeNode("body", {}, this);
  }
  createElement(tag) { return new FakeNode(tag, {}, this); }
  getElementById(id) { return this.byId[id] || null; }
  querySelector(sel) { return this.body.querySelector(sel); }
  querySelectorAll(sel) { return this.body.querySelectorAll(sel); }
  addEventListener() { }
}

/* ====================================================================== *
 * ② 卡片夹具：真源码 + 真共享组件库，挂到同一个 window 上
 * ====================================================================== */

/* 清单的最小切片：卡片在 mount 时读 window.BAI_PROVIDERS（清单先加载）。
   这里用**假名**（甲家/乙家…）—— 免得测试里出现的名字被误当成「渠道名写死」。 */
const NAMES = { alpha: "甲家", beta: "乙家", gamma: "丙家", delta: "丁家", epsilon: "戊家" };
const MANIFEST_FIXTURE = {
  alpha: { key: "alpha", name: NAMES.alpha, shortName: NAMES.alpha, badge: { text: "免费", kind: "free" }, chainable: true, credential: { kind: "jobToken" } },
  beta: { key: "beta", name: NAMES.beta, shortName: NAMES.beta, badge: { text: "付费", kind: "paid" }, chainable: true, credential: { kind: "apiKey" } },
  gamma: { key: "gamma", name: NAMES.gamma, shortName: NAMES.gamma, badge: { text: "有免费款", kind: "cn" }, chainable: true, credential: { kind: "jwt" }, accountPool: true },
  delta: { key: "delta", name: NAMES.delta, shortName: NAMES.delta, badge: { text: "有免费款", kind: "intl" }, chainable: true, credential: { kind: "jwt" }, accountPool: true },
  epsilon: { key: "epsilon", name: NAMES.epsilon, shortName: NAMES.epsilon, badge: { text: "会员额度", kind: "cn" }, chainable: true, credential: { kind: "jobToken" }, credentialReadonly: { api: "/api/x/reread", label: "重新读取登录态" }, memberQuota: true },
  zeta: { key: "zeta", name: "己家", shortName: "己家", badge: { text: "免费", kind: "intl" }, chainable: true, credential: { kind: "keys3" } },
  eta: { key: "eta", name: "庚家", shortName: "庚家", badge: { text: "免费", kind: "intl" }, chainable: true, credential: { kind: "apiKey" }, transportSwitch: true, transportOptions: [{ value: "direct", label: "直连", desc: "d", need: "n" }, { value: "via", label: "经客户端", desc: "d", need: "n" }] },
  theta: { key: "theta", name: "辛家", shortName: "辛家", badge: { text: "交还区", kind: "neutral" }, chainable: false, credential: { kind: "none" } },
};

function evalScript(src, filename, win, doc) {
  const sandbox = {
    window: win,
    document: doc,
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
  return sandbox;
}

/* 造一行凭据：.credrow[data-k=…] 里带一个宿主元素（凭据类卡片往里画自己的面板）。 */
function makeCredRow(doc, key, kind) {
  const row = new FakeNode("div", { class: "credrow", "data-k": key }, doc);
  const host = new FakeNode("span", { "data-host": kind }, doc);
  row.appendChild(host);
  doc.body.appendChild(row);
  return host;
}

/**
 * 装一张卡。
 * @param {string} name  卡名（= 文件名）
 * @param {object} opts
 *   opts.api(path)   读接口的假数据（返回空数据 ⇒ 空态）
 *   opts.fail        非空 ⇒ 读接口抛这个错（错误态）
 *   opts.stOf(key)   /api/status 里那一家的切片（状态驱动的卡用）
 *   opts.status     整份 status（状态驱动的卡用）
 *   opts.src         卡片的源码（反向对照用：传改坏的副本）
 */
function mountCard(name, opts = {}) {
  const doc = new FakeDoc();
  /* 页面骨架：这几处是卡片会去找的落点。 */
  const mapPanel = new FakeNode("div", { id: "mapPanel" }, doc);
  doc.body.appendChild(mapPanel);
  const statusBand = new FakeNode("div", { id: "statusBand" }, doc);
  const acts = new FakeNode("div", { class: "acts" }, doc);
  acts.appendChild(new FakeNode("span", { class: "hintx" }, doc));
  statusBand.appendChild(acts);
  doc.body.appendChild(statusBand);
  doc.body.appendChild(new FakeNode("div", { class: "banner-wrap" }, doc));

  const win = { BAI_PROVIDERS: MANIFEST_FIXTURE, BAI_CARDS: {} };
  evalScript(KIT_SRC, KIT_PATH, win, doc);      // 组件库与卡片必须在同一个 window 上
  evalScript(opts.src || readCard(name), name + ".js", win, doc);

  const card = (win.BAI_CARDS || {})[name];
  assert.ok(card && typeof card.mount === "function", `卡片 ${name} 必须导出 mount(ctx)`);

  const calls = [];
  const picked = [];
  const results = [];
  const rows = {};
  const ctx = {
    channels: opts.channels || Object.keys(MANIFEST_FIXTURE),
    channel: opts.channel || "gamma",
    view: "console",
    get cfg() { return opts.cfg || {}; },
    get status() { return opts.status === undefined ? (opts.stOf ? { alpha: opts.stOf("alpha") } : null) : opts.status; },
    nameOf: (k) => (MANIFEST_FIXTURE[k] || {}).name || String(k),
    cfgOf: () => (opts.cfg || {}),
    stOf: (k) => (opts.stOf ? (opts.stOf(k) || {}) : {}),
    sliceOf: (cfg, k) => (cfg && cfg[k]) || cfg || {},
    channelState: () => ({ s: "ok", txt: "可用", reason: "", detail: "" }),
    credState: () => ({}),
    chainOf: () => (opts.chain || ["alpha", "beta", "gamma"]),
    rowsOfKind: (kind) => {
      if (!rows[kind]) rows[kind] = [makeCredRow(doc, "alpha", kind)];
      return rows[kind];
    },
    esc: (s) => String(s == null ? "" : s),
    api: async (p, o) => {
      calls.push({ path: p, opts: o || {} });
      if (opts.fail) throw new Error(opts.fail);
      return opts.api ? opts.api(p) : {};
    },
    postJSON: async (p, b) => {
      calls.push({ path: p, body: b });
      if (opts.fail) throw new Error(opts.fail);
      return opts.postData ? opts.postData(p, b) : {};
    },
    loadChanStates: async () => {
      calls.push({ path: "/api/channels/state" });
      if (opts.fail) throw new Error(opts.fail);
      return opts.api ? opts.api("/api/channels/state") : {};
    },
    showResult: (el, text, good) => {
      results.push({ text: String(text), good: !!good });
      if (el) { el.textContent = text; el.className = "result show " + (good ? "good" : "bad"); }
    },
    showInfo: () => { },
    setLed: () => { },
    /* withBusy 要**接住**异常并写进落点（真实共享层就是这样）：
       卡片自己把失败 rethrow 出来，是交给 withBusy 显示的，不是让它炸掉整屏。 */
    withBusy: async (_btn, fn, errSlot) => {
      try { await fn(); } catch (e) {
        if (errSlot) {
          errSlot.textContent = String((e && e.message) || e);
          errSlot.className = "result show bad";
        }
      }
    },
    poll: () => { },
    refreshConfig: async () => { },
    selectChannel: (k) => picked.push(k),
    setView: (v) => picked.push("view:" + v),
    registerCapture: () => { },
    capTimeoutMs: () => 1000,
    CATALOG_TIMEOUT_MS: 1000,
    SCAN_ALL_TIMEOUT_MS: 1000,
    OR_REFRESH_TIMEOUT_MS: 1000,
    TIERS: [], TIER_ZH: {}, MODE_TXT: {},
    $: (id) => doc.getElementById(id),
    q: (sel, root) => (root || doc.body).querySelector(sel),
    qa: (sel, root) => (root || doc.body).querySelectorAll(sel),
    slot: doc.body,
  };

  const view = card.mount(ctx) || {};
  return { doc, win, ctx, card, view, calls, picked, results };
}

/** 把卡片画出来的东西全量导出成一段文本（用来断言三态类名）。 */
const dump = (doc) => doc.body.innerHTML;

/* 等一拍：卡片在 mount 时就把第一次读发出去了，那次读是异步的 ——
   断言「读到了之后画成什么样」之前必须让它落地。 */
const tick = () => new Promise((r) => setTimeout(r, 10));

/* 取出某一种状态块（从 bkit-state-<kind> 到该块结束）。
   断言要落在**块内**：整页里另有一块加载态也有 hint，
   拿整页去断「错误态带没带下一步」会被那一块蒙混过关。 */
function stateBlock(html, kind) {
  const at = html.indexOf("bkit-state-" + kind);
  if (at < 0) return "";
  const end = html.indexOf("</div></div>", at);
  return html.slice(at, end > 0 ? end : html.length);
}
const hasHint = (html, kind) => stateBlock(html, kind).indexOf("bkit-state-hint") >= 0;

/* 每张卡「空数据」的假数据：读了但没有内容 ⇒ 应当画**空态**。 */
const EMPTY = {
  "status-strip": () => ({ ok: true, channels: [] }),
  "channel-heatmap": () => ({ ok: true, channels: [] }),
  "usage-ledger": () => ({ ok: true, totals: {}, rows: [], byProvider: [], byModel: [] }),
  "audit-ledger": () => ({ ok: true, summary: { total: 0, failed: 0 }, records: [] }),
  "traffic-page": () => ({ ok: true, totals: {}, days: [], channels: [], affinity: { sessions: [] } }),
  "price-table": () => ({ ok: true, pricedAt: "", entries: [], unpriced: [] }),
  "quota-panel": () => ({ ok: true, providers: [] }),
  "account-list": () => ({ ok: true, providers: [] }),
  "plugins": () => ({ ok: true, plugins: [], errors: [], dir: "D:/plug" }),
  "limits": () => ({ ok: true, limits: { concurrency: 0, rpm: 0 }, stats: {} }),
  "remote-sync": () => ({ ok: true, kind: "local", configured: false }),
  "config-backup": () => ({ ok: true, dir: "D:/bk", files: [] }),
  "gateway-switch": () => ({ ok: true, mode: "off", port: 1234, providers: [] }),
};

/* 走接口取数的那些卡（它们的空/错场景靠 api 造）。 */
const API_CARDS = Object.keys(EMPTY);

/* ====================================================================== *
 * ③ 三态：逐张卡断言
 * ====================================================================== */
describe("① 三态 —— 每张卡都有空态 / 错误态 / 加载态", () => {
  for (const name of API_CARDS) {
    test(`① ${name}：还在读 / 没有数据 / 读不到，三种情况各画各的`, async () => {
      /* --- 加载态：刚挂上、还没读到数据 --- */
      const loading = mountCard(name, { api: EMPTY[name] });
      const loadingHtml = dump(loading.doc);
      assert.ok(loadingHtml.indexOf("bkit-state-loading") >= 0,
        `${name}：第一次渲染必须显示「正在读…」，不能把上一轮的空态留在屏幕上`);
      assert.ok(loadingHtml.indexOf("aria-busy") >= 0,
        `${name}：加载态要能被读屏软件读出来（aria-busy）`);

      /* --- 空态：读到了，但没有内容 --- */
      const empty = mountCard(name, { api: EMPTY[name], chain: [] });
      await empty.view.update();
      await tick();
      const emptyHtml = dump(empty.doc);
      assert.ok(emptyHtml.indexOf("bkit-state-empty") >= 0,
        `${name}：没有内容时要画空态（不是错误态，也不是空白）`);
      assert.ok(emptyHtml.indexOf("bkit-state-error") < 0,
        `${name}：空态不许长成错误态 ——「还没发生过」与「读不到」是两件事`);
      assert.ok(hasHint(emptyHtml, "empty"),
        `${name}：空态必须说清「怎么才会出现」，否则用户不知道该等什么`);

      /* --- 错误态：读不到 --- */
      const bad = mountCard(name, { api: EMPTY[name], fail: "模拟的读失败原因" });
      await bad.view.update();
      await tick();
      const badHtml = dump(bad.doc);
      assert.ok(badHtml.indexOf("bkit-state-error") >= 0,
        `${name}：读不到时要画错误态`);
      assert.ok(hasHint(badHtml, "error"),
        `${name}：错误态**必须带下一步** —— 一句「加载失败」是猜谜`);
      assert.ok(stateBlock(badHtml, "error").indexOf("bkit-state-detail") >= 0,
        `${name}：错误态要把原始报错放进 detail，别把技术黑话当主句`);
      assert.ok(badHtml.indexOf("模拟的读失败原因") >= 0,
        `${name}：原始报错要看得见（用户要拿它去查）`);
    });
  }
});

/* ====================================================================== *
 * ④ 状态驱动的卡（数据来自 /api/status，不是自己发请求）
 * ====================================================================== */
describe("② 状态驱动的卡：加载 / 空 / 错 三态", () => {
  test("②a failover：还没读到状态 ⇒ 加载态；链上没有候选 ⇒ 空态；状态缺这一段 ⇒ 错误态", () => {
    /* 加载态 */
    const loading = mountCard("failover", { status: null, channel: "alpha" });
    assert.ok(dump(loading.doc).indexOf("bkit-state-loading") >= 0, "failover：首屏必须说在读");

    /* 空态：清单里一个能进链的渠道都没有（链序自然为空） */
    const empty = mountCard("failover", {
      status: { failover: { enabled: true, chain: [], cooling: {} } },
      channel: "alpha", chain: [], channels: [],
    });
    empty.view.update({ failover: { enabled: true, chain: [], cooling: {} } });
    const html = dump(empty.doc);
    assert.ok(html.indexOf("bkit-state-empty") >= 0, "failover：链上没有候选 ⇒ 空态");
    assert.ok(html.indexOf("bkit-state-hint") >= 0, "failover：空态要说清怎么才会出现");

    /* 错误态：状态里没有 failover 这一段 */
    const bad = mountCard("failover", { status: {}, channel: "alpha" });
    bad.view.update({});
    const badHtml = dump(bad.doc);
    assert.ok(badHtml.indexOf("bkit-state-error") >= 0, "failover：读不到 ⇒ 错误态");
    assert.ok(badHtml.indexOf("bkit-state-hint") >= 0, "failover：错误态必须带下一步");
  });

  test("②b mm-member：登录态失效 ⇒ 错误态；没读到登录态 ⇒ 空态", () => {
    const bad = mountCard("mm-member", {
      channel: "epsilon",
      status: { epsilon: { token: { configured: false, invalid: true, error: "登录态已失效" } } },
      stOf: (k) => (k === "epsilon" ? { token: { configured: false, invalid: true, error: "登录态已失效" } } : {}),
    });
    bad.view.update({});
    const badHtml = dump(bad.doc);
    assert.ok(badHtml.indexOf("bkit-state-error") >= 0, "mm-member：登录态失效 ⇒ 错误态");
    assert.ok(badHtml.indexOf("bkit-state-hint") >= 0, "mm-member：错误态必须带下一步");

    const empty = mountCard("mm-member", {
      channel: "epsilon",
      status: { epsilon: { token: { configured: false, invalid: false } } },
      stOf: (k) => (k === "epsilon" ? { token: { configured: false, invalid: false } } : {}),
    });
    empty.view.update({});
    const emptyHtml = dump(empty.doc);
    assert.ok(emptyHtml.indexOf("bkit-state-empty") >= 0, "mm-member：没读到登录态 ⇒ 空态（**不是出错**）");
    assert.ok(emptyHtml.indexOf("bkit-state-hint") >= 0, "mm-member：空态要说清怎么才会出现");
  });

  test("②c wb-pool：池子里一把都没有 ⇒ 空态；上次选号失败 ⇒ 错误态且带处置指引", () => {
    const empty = mountCard("wb-pool", {
      channel: "gamma",
      status: { gamma: { pool: { total: 0, accounts: [], hint: "池子是空的" } } },
      stOf: (k) => (k === "gamma" ? { pool: { total: 0, accounts: [], hint: "池子是空的" } } : {}),
    });
    empty.view.update({});
    const emptyHtml = dump(empty.doc);
    assert.ok(emptyHtml.indexOf("bkit-state-empty") >= 0, "wb-pool：池子空 ⇒ 空态");
    assert.ok(emptyHtml.indexOf("池子是空的") >= 0, "wb-pool：服务端给的那句提示要留着");

    const bad = mountCard("wb-pool", {
      channel: "gamma",
      status: { gamma: { pool: { total: 1, accounts: [{ no: 1, label: "A", available: false, reasonLabel: "额度用尽", remedy: "充值" }], last: { ok: false, reasonLabel: "额度用尽", remedy: "充值" } } } },
      stOf: (k) => (k === "gamma" ? { pool: { total: 1, accounts: [{ no: 1, label: "A", available: false, reasonLabel: "额度用尽", remedy: "充值" }], last: { ok: false, reasonLabel: "额度用尽", remedy: "充值" } } } : {}),
    });
    bad.view.update({});
    const badHtml = dump(bad.doc);
    assert.ok(badHtml.indexOf("bkit-state-error") >= 0, "wb-pool：上次选号失败 ⇒ 错误态");
    assert.ok(badHtml.indexOf("充值") >= 0, "wb-pool：错误态必须带「该做什么」（处置指引不能丢）");
  });

  test("②d model-catalog：没找到客户端 ⇒ 错误态且带下一步；令牌文件还没刷新 ⇒ 空态", () => {
    const notFound = mountCard("model-catalog", {
      status: { alpha: { patch: { found: 0 } } },
      stOf: (k) => (k === "alpha" ? { patch: { found: 0 } } : {}),
    });
    notFound.view.update({ alpha: { patch: { found: 0 } } });
    const badHtml = dump(notFound.doc);
    assert.ok(badHtml.indexOf("bkit-state-error") >= 0, "model-catalog：没找到客户端 ⇒ 错误态");
    assert.ok(badHtml.indexOf("bkit-state-hint") >= 0, "model-catalog：错误态必须带下一步");

    const noToken = mountCard("model-catalog", {
      status: { alpha: { patch: { found: 2, ready: true, patched: 2 }, token: {} } },
      stOf: (k) => (k === "alpha" ? { patch: { found: 2, ready: true, patched: 2 }, token: {} } : {}),
    });
    noToken.view.update({ alpha: { patch: { found: 2, ready: true, patched: 2 }, token: {} } });
    const emptyHtml = dump(noToken.doc);
    assert.ok(emptyHtml.indexOf("bkit-state-empty") >= 0,
      "model-catalog：令牌文件还没刷新是「还没发生」，不是出错 ⇒ 空态");
    assert.ok(emptyHtml.indexOf("bkit-state-hint") >= 0, "model-catalog：空态要说清怎么才会出现");
  });

  test("②e token-capture：还没捕获到令牌 ⇒ 空态；没读到状态 ⇒ 加载态", () => {
    const empty = mountCard("token-capture", {
      status: { alpha: { token: { configured: false } } },
      stOf: (k) => (k === "alpha" ? { token: { configured: false } } : {}),
    });
    empty.view.update({ alpha: { token: { configured: false } } });
    const emptyHtml = dump(empty.doc);
    assert.ok(emptyHtml.indexOf("bkit-state-empty") >= 0, "token-capture：未捕获 ⇒ 空态（**不是出错**）");
    assert.ok(emptyHtml.indexOf("bkit-state-hint") >= 0, "token-capture：空态要说清怎么才会出现");

    const loading = mountCard("token-capture", { status: null, stOf: () => ({}) });
    assert.ok(dump(loading.doc).indexOf("bkit-state-loading") >= 0, "token-capture：没读到状态 ⇒ 加载态");
  });

  test("②f or-rotation：轮换区里一把 key 都没有 ⇒ 空态；没读到状态 ⇒ 加载态", () => {
    const empty = mountCard("or-rotation", {
      status: { alpha: { token: { keys: [] } } },
      stOf: (k) => (k === "alpha" ? { token: { keys: [] } } : {}),
    });
    empty.view.update({ alpha: { token: { keys: [] } } });
    const emptyHtml = dump(empty.doc);
    assert.ok(emptyHtml.indexOf("bkit-state-empty") >= 0, "or-rotation：没有 key ⇒ 空态");
    assert.ok(emptyHtml.indexOf("bkit-state-hint") >= 0, "or-rotation：空态要说清怎么才会出现");

    const loading = mountCard("or-rotation", { status: null, stOf: () => ({}) });
    assert.ok(dump(loading.doc).indexOf("bkit-state-loading") >= 0, "or-rotation：没读到状态 ⇒ 加载态");
  });

  test("②g oc-transport：探测结果还没到 ⇒ 加载态；没装 ⇒ 空态（缺前置条件，不是出错）", () => {
    const loading = mountCard("oc-transport", {
      channel: "eta",
      status: { eta: { transport: "direct", transportProbe: null } },
      stOf: (k) => (k === "eta" ? { transport: "direct", transportProbe: null } : {}),
    });
    loading.view.update({});
    const loadingHtml = dump(loading.doc);
    assert.ok(loadingHtml.indexOf("bkit-state-loading") >= 0, "oc-transport：还没读到探测结果 ⇒ 加载态");

    const missing = mountCard("oc-transport", {
      channel: "eta",
      status: { eta: { transport: "direct", transportProbe: { state: "missing", path: "", source: null, hint: "先装：npm i -g opencode-ai", error: "" } } },
      stOf: (k) => (k === "eta" ? { transport: "direct", transportProbe: { state: "missing", path: "", source: null, hint: "先装：npm i -g opencode-ai", error: "" } } : {}),
    });
    missing.view.update({});
    const missingHtml = dump(missing.doc);
    assert.ok(missingHtml.indexOf("bkit-state-empty") >= 0,
      "oc-transport：没装客户端 ⇒ 空态（这一档没有任何本地客户端可用）");
    assert.ok(missingHtml.indexOf("bkit-state-hint") >= 0, "oc-transport：空态要说清怎么才会出现");
  });

  test("②h model-sync：一家都没扫到 ⇒ 空态；扫描失败 ⇒ 错误态且带下一步", async () => {
    const empty = mountCard("model-sync", {
      status: {},
      postData: () => ({ ok: true, changed: false, providers: [] }),
    });
    empty.view.update({});
    /* model-sync 的面板是用户点了按钮才出现的：先点一下「刷新全部模型」。 */
    const btn = empty.doc.getElementById("btnModelSync");
    assert.ok(btn, "model-sync：必须有那个按钮");
    btn.dispatch("click");
    await tick();
    const emptyHtml = dump(empty.doc);
    assert.ok(emptyHtml.indexOf("bkit-state-empty") >= 0, "model-sync：一家都没扫到 ⇒ 空态");
    assert.ok(hasHint(emptyHtml, "empty"), "model-sync：空态要说清怎么才会出现");

    /* 扫描失败 ⇒ 错误态，且必须带下一步。 */
    const bad = mountCard("model-sync", { status: {}, fail: "模拟的扫描失败" });
    const badBtn = bad.doc.getElementById("btnModelSync");
    badBtn.dispatch("click");
    await tick();
    const badHtml = dump(bad.doc);
    assert.ok(badHtml.indexOf("bkit-state-error") >= 0, "model-sync：扫描失败 ⇒ 错误态");
    assert.ok(hasHint(badHtml, "error"), "model-sync：错误态必须带下一步");
  });
});

/* ====================================================================== *
 * ⑤ 键盘可达
 * ====================================================================== */
describe("③ 键盘可达 —— 可点元素必须按得动", () => {
  test("③a 热力图格子：能聚焦（role + tabindex），Enter 与 Space 都切到那家", async () => {
    const h = mountCard("channel-heatmap", {
      api: () => ({ ok: true, channels: [{ key: "alpha", name: NAMES.alpha, state: "ok", reason: "", busy: 0, used: 0, limit: 0, ratio: 0, detail: "" }] }),
    });
    await h.view.update();
    await tick();
    const cells = h.doc.body.querySelectorAll("[data-channel]");
    assert.equal(cells.length, 1, "热力图要画出一格");
    const cell = cells[0];
    assert.equal(cell.getAttribute("role"), "button", "格子能点，就必须告诉读屏软件它是个按钮");
    assert.equal(cell.getAttribute("tabindex"), "0", "格子必须能被 Tab 聚焦");

    cell.dispatch("keydown", { key: "Enter" });
    assert.ok(h.picked.indexOf("alpha") >= 0, "Enter 必须和点一下一样：切到那家");

    h.picked.length = 0;
    cell.dispatch("keydown", { key: " " });
    assert.ok(h.picked.indexOf("alpha") >= 0, "Space 也必须切到那家（键盘用户按的常是 Space）");
  });

  test("③b 模型同步的行：能聚焦（role + tabindex），Enter 展开明细", async () => {
    const m = mountCard("model-sync", {
      status: {},
      postData: () => ({
        ok: true, changed: true,
        providers: [{ key: "alpha", name: NAMES.alpha, status: "ok", added: ["x"], removed: [], count: 2, have: 1 }],
      }),
    });
    const btn = m.doc.getElementById("btnModelSync");
    btn.dispatch("click");
    await tick();
    const rows = m.doc.body.querySelectorAll(".msync-row");
    assert.ok(rows.length >= 1, "要画出每一家一行");
    const row = rows.find((r) => r.getAttribute("data-k"));
    assert.ok(row, "有变化的那一行才可展开");
    assert.equal(row.getAttribute("role"), "button", "能点开的行必须告诉读屏软件它是个按钮");
    assert.equal(row.getAttribute("tabindex"), "0", "行必须能被 Tab 聚焦");
    row.dispatch("keydown", { key: "Enter" });
    const notes = m.doc.getElementById("msyncNotesWrap");
    assert.ok(notes && notes.style.display !== "none", "Enter 必须展开明细（和点一下一样）");
  });
});

/* ====================================================================== *
 * ⑥ 源码纪律：三态只由共享组件库定义，卡片不许自己另起一套
 * ====================================================================== */
describe("④ 源码纪律", () => {
  const ALL_CARDS = fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));

  test("④a 每一张卡的源码里都出现三种状态组件（不许自己写三态）", () => {
    for (const name of ALL_CARDS) {
      const src = readCard(name);
      for (const fn of ["emptyState", "errorState", "loadingState"]) {
        assert.ok(hasStateCall(src, fn),
          `${name}.js 里没有 ${fn}( —— 三态必须走共享组件，不许自己另写一套`);
      }
    }
  });

  test("④b 错误态每一次调用都必须带 hint（下一步）", () => {
    for (const name of ALL_CARDS) {
      const src = readCard(name);
      const calls = stateCalls(src, "errorState");
      assert.ok(calls.length >= 1, `${name}.js 里一处 errorState 都没有`);
      calls.forEach((args, i) => {
        assert.ok(/hint\s*:/.test(args),
          `${name}.js 的第 ${i + 1} 处 errorState 没带 hint —— 一句「加载失败」是猜谜`);
      });
    }
  });

  test("④c 空态每一次调用都必须带 hint（怎么才会出现）", () => {
    for (const name of ALL_CARDS) {
      const src = readCard(name);
      const calls = stateCalls(src, "emptyState");
      assert.ok(calls.length >= 1, `${name}.js 里一处 emptyState 都没有`);
      calls.forEach((args, i) => {
        assert.ok(/hint\s*:/.test(args),
          `${name}.js 的第 ${i + 1} 处 emptyState 没带 hint —— 空态必须说清「怎么才会出现」`);
      });
    }
  });

  test("④d 卡片里不许写死颜色（浅深两套主题都要能读）", () => {
    for (const name of ALL_CARDS) {
      const src = readCard(name);
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
      assert.equal((code.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length, 0, `${name}.js 写了十六进制色值`);
      assert.equal((code.match(/\b(?:rgba?|hsla?)\s*\(/g) || []).length, 0, `${name}.js 写了 rgb()/hsl() 色值`);
      /* inline style 里只许放几何与**变量引用**（color:var(--ink) 是可以的 ——
         变量在两套主题里各自取值）；写死一个具体颜色才是违规。 */
      const inlineColor = code.match(/style\s*=\s*"[^"]*(?:color|background|border-color)\s*:\s*(?!var\()[^"]*"/gi) || [];
      assert.equal(inlineColor.length, 0,
        `${name}.js 的 inline style 里塞了写死的颜色（要用语义类名 ok/warn/err/idle/brand）：${inlineColor[0]}`);
    }
  });

  test("④e 卡片源码必须是 LF 行尾（按文本锚点抠源码的测试会被 CRLF 弄崩）", () => {
    for (const name of ALL_CARDS) {
      const text = fs.readFileSync(path.join(CARDS_DIR, name + ".js"), "utf8");
      assert.equal(text.indexOf("\r") < 0, true, `${name}.js 里有 CRLF —— 仓库的文本锚点测试会全崩`);
    }
  });
});

/* 取一次函数调用的参数块（paren 是左括号的下标；跳过字符串里的括号）。 */
function callArgs(src, paren) {
  if (paren < 0 || src[paren] !== "(") return "";
  let depth = 0;
  let quote = "";
  for (let i = paren; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return src.slice(paren + 1, i); }
  }
  return src.slice(paren + 1);
}

/* 卡片里三态有两种写法：直接 kit.emptyState(...)，
   或者经本卡的小助手 S3("emptyState", ...)。两种都算。 */
function stateCallSpots(src, fn) {
  const spots = [];
  const re = new RegExp("kit\\." + fn + "\\(|S3\\(\\s*\"" + fn + "\"", "g");
  let m;
  while ((m = re.exec(src))) {
    /* 左括号的位置：kit.emptyState( 的括号在匹配串末尾；S3("emptyState" 的括号在 S3( 之后。 */
    const paren = src[m.index + m[0].length - 1] === "("
      ? m.index + m[0].length - 1
      : src.indexOf("(", m.index);
    spots.push({ at: m.index, paren });
  }
  return spots;
}
const hasStateCall = (src, fn) => stateCallSpots(src, fn).length > 0;
const stateCalls = (src, fn) => stateCallSpots(src, fn).map((s) => callArgs(src, s.paren));

/* ====================================================================== *
 * ⑦ 反向对照：把实现改坏，对应断言必须红
 * ====================================================================== */
describe("⑤ 反向对照 —— 改坏实现，对应断言必须真的红", () => {
  test("⑤a 把「错误态」改成「空态」⇒ ① 的错误态断言必须红", async () => {
    const broken = readCard("channel-heatmap").replace(
      'kit.errorState("读不到渠道状态"',
      'kit.emptyState("读不到渠道状态"',
    );
    assert.notEqual(broken, readCard("channel-heatmap"), "锚点没对上源码 —— 这条反向对照已经失效");
    const h = mountCard("channel-heatmap", {
      src: broken,
      api: () => ({ ok: true, channels: [] }),
      fail: "模拟的读失败原因",
    });
    await h.view.update();
    const html = dump(h.doc);
    assert.ok(html.indexOf("bkit-state-error") < 0, "改坏的副本应当真的不再是错误态");
    assert.throws(() => {
      assert.ok(html.indexOf("bkit-state-error") >= 0, "channel-heatmap：读不到时要画错误态");
    }, "错误态的断言必须红");
  });

  test("⑤b 把「错误态的 hint」删掉 ⇒ ① 的「必须带下一步」断言必须红", async () => {
    const src = readCard("account-list");
    const broken = src.replace(/\n\s*hint: "看诊断抽屉[^"]*",/, "");
    assert.notEqual(broken, src, "锚点没对上源码 —— 这条反向对照已经失效");
    const h = mountCard("account-list", {
      src: broken,
      api: () => ({ ok: true, providers: [] }),
      fail: "模拟的读失败原因",
    });
    await h.view.update();
    await tick();
    const html = dump(h.doc);
    assert.ok(html.indexOf("bkit-state-error") >= 0, "改坏的副本仍然画错误态（只少了下一步）");
    assert.ok(!hasHint(html, "error"), "改坏的副本应当真的没有下一步了");
    assert.throws(() => {
      assert.ok(hasHint(html, "error"), "account-list：错误态**必须带下一步**");
    }, "「必须带下一步」的断言必须红");
  });

  test("⑤c 把可点元素的 tabindex 删掉 ⇒ ③ 的「能聚焦」断言必须红", async () => {
    const broken = readCard("channel-heatmap").replace(
      'cell.setAttribute("tabindex", "0");',
      '/* sabotage: 不给 tabindex */',
    );
    assert.notEqual(broken, readCard("channel-heatmap"), "锚点没对上源码 —— 这条反向对照已经失效");
    const h = mountCard("channel-heatmap", {
      src: broken,
      api: () => ({ ok: true, channels: [{ key: "alpha", name: NAMES.alpha, state: "ok", reason: "", busy: 0, used: 0, limit: 0, ratio: 0, detail: "" }] }),
    });
    await h.view.update();
    await tick();
    const cell = h.doc.body.querySelectorAll("[data-channel]")[0];
    assert.ok(cell, "热力图要画出一格");
    assert.equal(cell.getAttribute("tabindex"), null, "改坏的副本应当真的不可聚焦");
    assert.throws(() => {
      assert.equal(cell.getAttribute("tabindex"), "0", "格子必须能被 Tab 聚焦");
    }, "「能聚焦」的断言必须红");
  });

  test("⑤d 把 Enter/Space 的处理删掉 ⇒ ③ 的「按得动」断言必须红", async () => {
    const broken = readCard("channel-heatmap").replace(
      'if (!ev || (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar")) return;',
      'return;',
    );
    assert.notEqual(broken, readCard("channel-heatmap"), "锚点没对上源码 —— 这条反向对照已经失效");
    const h = mountCard("channel-heatmap", {
      src: broken,
      api: () => ({ ok: true, channels: [{ key: "alpha", name: NAMES.alpha, state: "ok", reason: "", busy: 0, used: 0, limit: 0, ratio: 0, detail: "" }] }),
    });
    await h.view.update();
    await tick();
    const cell = h.doc.body.querySelectorAll("[data-channel]")[0];
    assert.ok(cell, "热力图要画出一格");
    cell.dispatch("keydown", { key: "Enter" });
    assert.equal(h.picked.length, 0, "改坏的副本应当真的按不动");
    assert.throws(() => {
      assert.ok(h.picked.indexOf("alpha") >= 0, "Enter 必须和点一下一样：切到那家");
    }, "「按得动」的断言必须红");
  });

  test("⑤e 把「加载态」换成「空态」⇒ ① 的加载态断言必须红", async () => {
    const broken = readCard("usage-ledger").replace(
      'S3("loadingState", "正在读用量账本…", { hint: "读完这一块就能看到钱花到哪儿去了。" })',
      'S3("emptyState", "正在读用量账本…", { hint: "读完这一块就能看到钱花到哪儿去了。" })',
    );
    assert.notEqual(broken, readCard("usage-ledger"), "锚点没对上源码 —— 这条反向对照已经失效");
    const h = mountCard("usage-ledger", { src: broken, api: EMPTY["usage-ledger"] });
    const html = dump(h.doc);
    assert.ok(html.indexOf("bkit-state-loading") < 0, "改坏的副本应当真的不再是加载态");
    assert.throws(() => {
      assert.ok(html.indexOf("bkit-state-loading") >= 0, "usage-ledger：第一次渲染必须显示「正在读…」");
    }, "加载态的断言必须红");
  });
});
