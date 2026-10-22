/* scripts/pricing-refresh-module-test.mjs —— 价格表「用户点了才更新」的**模块与卡片**口径测试
 * （src/server/pricing-refresh.mjs + src/server/cards/price-table.js）。
 *
 * ## 这块是什么
 *
 *   价格是**漂移**的（厂商随时调价），所以单价表必须带快照日期；
 *   但它**绝不自动更新** —— 自动更新会让「今天我花了多少钱」这句话的含义
 *   在某天悄悄变掉，而用户是拿它跟厂商账单对账的。
 *   于是更新只能是「用户点了才发生」的事。
 *
 *   本文件验四件事：
 *   ① **远端表怎么变成本仓这张表**（buildRemoteTable）
 *   ② **远端与现在谁说了算**（chooseTable：远端更新就用远端，比现在旧就用现在，不合格就用现在）
 *   ③ **这张表有多旧、哪些估不出**（staleInfo / describeTable）
 *   ④ **面板上画出来的东西对不对**（cards/price-table.js）
 *
 *   ⚠ **端点接线**（POST /api/pricing/refresh 非阻塞、落盘、费用真的用上了新表）
 *     在 scripts/pricing-refresh-test.mjs —— 那是接线层的用例，不在本文件。
 *
 * ## 纪律
 *
 *   ★ **真实现、不注入替身**：断言的是那两个文件原样 import / 求值的那两份。
 *   ★ **每条关键判定都配反向对照**：见最后一节 —— 把判定改坏（写临时副本再加载），
 *     对应断言必须立刻变红。恒真的测试比没有测试更坏。
 *   ★ **零时钟、零 IO**：模块内部不得出现 Date.now / fetch / fs。
 *   ★ **「估不出」与「估出 0」永远分开**：0 是真的免费，null 是查不到。
 *     magpie 的 CostSplit 把「源里没列」当 0（缓存费被当成免费），本仓改成 null。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  STALE_AFTER_DAYS,
  UNPRICED_WHY,
  DEFAULT_WHY,
  buildRemoteTable,
  chooseTable,
  staleInfo,
  describeTable,
} from "../src/server/pricing-refresh.mjs";
import { priceTable } from "../src/server/pricing.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const MOD_PATH = path.join(ROOT, "src", "server", "pricing-refresh.mjs");
const CARD_PATH = path.join(ROOT, "src", "server", "cards", "price-table.js");
const MOD_SRC = fs.readFileSync(MOD_PATH, "utf8");
const CARD_SRC = fs.readFileSync(CARD_PATH, "utf8");

const DAY = 24 * 60 * 60 * 1000;
/** 「现在」：内置表快照是 2026-10-22，所以此刻是 3 天后。 */
const NOW = Date.parse("2026-10-25T00:00:00Z");

/** 本仓的渠道（key → 显示名）。测试自己写一份，不抄清单的实现。 */
const CHANNELS = [
  { key: "sn", name: "商汤 SenseNova" },
  { key: "zen", name: "OpenCode Zen" },
  { key: "mm", name: "MiniMax 国内站" },
  { key: "or", name: "OpenRouter" },
  { key: "bai", name: "B.AI" },
  { key: "qd", name: "Qoder" },
  { key: "wb", name: "WorkBuddy" },
  { key: "wbai", name: "WorkBuddy 国际版" },
];
const nameOf = (k) => (CHANNELS.find((c) => c.key === k) || {}).name || k;

/** models.dev 的 api.json 形状（只留认得的几家）。 */
const MD_RAW = {
  sensenova: { models: { "glm-5.2": { cost: { input: 0, output: 0, cache_read: 0 } } } },
  opencode: { models: { "space-bunny-free": { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } } },
  "minimax-cn": { models: { "MiniMax-M3.1-Flash": { cost: { input: 0.1494, output: 0.5976, cache_read: 0.0149 } } } },
  openrouter: { models: { "x/y:free": { cost: { input: 0, output: 0 } } } },
};

/* ══════════════════════════════════════════════════════════════════════
 * ① 远端表 —— api.json 变成本仓这张表
 * ══════════════════════════════════════════════════════════════════════ */
describe("① 远端表 —— 不合格就不给，说清为什么", () => {
  test("①a 没给快照日期 ⇒ 不合格（价格会漂移，没日期的表不能对账）", () => {
    const r = buildRemoteTable(MD_RAW, {});
    assert.equal(r.ok, false);
    assert.equal(r.table, null);
    assert.match(r.reason, /快照|日期/);
    assert.ok(r.reason.length > 8, "理由要是一句人话，不是一个 error code");
  });

  test("①b 快照日期不是真日期 ⇒ 不合格", () => {
    const r = buildRemoteTable(MD_RAW, { pricedAt: "2026-13-45" });
    assert.equal(r.ok, false);
    assert.equal(r.table, null);
  });

  test("①c 压根没拉到数据 ⇒ 不合格，且说得出是「没拉到」", () => {
    for (const bad of [null, undefined, 42, "not json"]) {
      const r = buildRemoteTable(bad, { pricedAt: "2026-11-01" });
      assert.equal(r.ok, false, `拉到 ${JSON.stringify(bad)} 时不该判合格`);
      assert.match(r.reason, /没拉到|不是 JSON/);
    }
  });

  test("①d 拉回来的数据里一家认识的厂商都没有 ⇒ 判形状变了，不许用", () => {
    const r = buildRemoteTable({ openai: { models: {} }, anthropic: { models: {} } }, { pricedAt: "2026-11-01" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /形状/);
  });

  test("①e 合格时：条目翻成「厂商/模型」，日期就是给的那天", () => {
    const r = buildRemoteTable(MD_RAW, { pricedAt: "2026-11-01" });
    assert.equal(r.ok, true);
    assert.equal(r.reason, "");
    assert.equal(r.table.pricedAt, "2026-11-01");
    assert.equal(r.table.currency, "USD");
    assert.ok(r.table.entries["sn/glm-5.2"], "键必须是「本仓渠道/真实模型名」");
    assert.ok(r.table.entries["mm/MiniMax-M3.1-Flash"]);
    assert.ok(r.table.entries["or/x/y:free"]);
  });

  test("①f 源里没列的通道是 null（不知道），不是 0", () => {
    const r = buildRemoteTable(MD_RAW, { pricedAt: "2026-11-01" });
    assert.equal(r.table.entries["mm/MiniMax-M3.1-Flash"].cacheWrite, null,
      "源里没列缓存写单价 = 不知道；当成 0 就是把猜的东西当成实测的东西");
    assert.equal(r.table.entries["sn/glm-5.2"].cacheWrite, 0,
      "输入输出都是 0 的那一款，缓存写按 0（数据层做一次推断）");
  });

  test("①g 远端只覆盖了本仓的一部分 ⇒ **不拦**（那是正常的远端表）", () => {
    /* 远端源只列一家是常事（源有几百家，本仓只要四家）。
     * 把它判成不合格会误伤 —— 真正要拦的是「一条单价都没有」。 */
    const onlyOne = { openrouter: { models: { "x/y:free": { cost: { input: 0, output: 0 } } } } };
    const r = buildRemoteTable(onlyOne, { pricedAt: "2026-11-01" });
    assert.equal(r.ok, true, "只覆盖一部分不是形状变了");
    assert.ok(r.table.entries["or/x/y:free"]);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ② 远端 vs 现在 —— 谁说了算
 * ══════════════════════════════════════════════════════════════════════ */
describe("② 谁说了算 —— 三种情况各有一句人话", () => {
  test("②a 远端不合格 ⇒ 继续用现在这张", () => {
    const r = chooseTable(buildRemoteTable(null, { pricedAt: "2026-11-01" }));
    assert.equal(r.changed, false);
    assert.equal(r.table.pricedAt, "2026-10-22", "用的是内置那张，不许因为拉不到就换");
    assert.match(r.reason, /继续用/);
    assert.match(r.reason, /2026-10-22/);
  });

  test("②b 远端比现在这张旧 ⇒ 继续用现在这张", () => {
    const old = buildRemoteTable(MD_RAW, { pricedAt: "2026-10-01" });
    const r = chooseTable(old);
    assert.equal(r.changed, false);
    assert.equal(r.table.pricedAt, "2026-10-22");
    assert.match(r.reason, /继续用/);
  });

  test("②c 远端与现在这张一样新 ⇒ 也换（用户点了刷新，不能什么都没发生）", () => {
    const same = buildRemoteTable(MD_RAW, { pricedAt: "2026-10-22" });
    const r = chooseTable(same);
    assert.equal(r.changed, true);
    assert.equal(r.source, "remote");
    assert.match(r.reason, /已换上/);
  });

  test("②d 远端更新 ⇒ 换上，来源变成 remote", () => {
    const newer = buildRemoteTable(MD_RAW, { pricedAt: "2026-11-01" });
    const r = chooseTable(newer);
    assert.equal(r.changed, true);
    assert.equal(r.source, "remote");
    assert.equal(r.table.pricedAt, "2026-11-01");
    assert.match(r.reason, /已换上/);
  });

  test("②e 现在这张已经是远端来的 ⇒ 保留它的来源", () => {
    const cur = {
      pricedAt: "2026-11-01", currency: "USD", unit: "per-1M-tokens",
      entries: { "sn/glm-5.2": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    };
    const r = chooseTable(buildRemoteTable(MD_RAW, { pricedAt: "2026-10-01" }), { current: cur, currentSource: "remote" });
    assert.equal(r.changed, false);
    assert.equal(r.source, "remote", "没换表，来源还是远端那张");
    assert.equal(r.table.pricedAt, "2026-11-01");
  });

  test("②f 裸表（没经过 buildRemoteTable）也要被校验：没日期照样不换", () => {
    const r = chooseTable({ entries: { "sn/glm-5.2": { input: 1, output: 2 } } });
    assert.equal(r.changed, false);
    assert.equal(r.table.pricedAt, "2026-10-22");
    assert.match(r.reason, /继续用/);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ③ 这张表有多旧
 * ══════════════════════════════════════════════════════════════════════ */
describe("③ 有多旧 —— 陈旧只是提醒，不影响估价", () => {
  test("③a 给了 now ⇒ 算得出天数", () => {
    const s = staleInfo(priceTable(), { now: NOW });
    assert.equal(s.pricedAt, "2026-10-22");
    assert.equal(s.ageDays, 3);
    assert.equal(s.stale, false);
  });

  test("③b 超过 30 天算陈旧", () => {
    const s = staleInfo(priceTable(), { now: NOW + 40 * DAY });
    assert.equal(s.ageDays, 43);
    assert.equal(s.stale, true);
    assert.equal(STALE_AFTER_DAYS, 30);
  });

  test("③c 正好 30 天**不算**陈旧（与 pricing.mjs 的判定逐字一致）", () => {
    const s = staleInfo(priceTable(), { now: NOW + 27 * DAY });
    assert.equal(s.ageDays, 30);
    assert.equal(s.stale, false, "边界是「大于」，不是「大于等于」");
  });

  test("③d 不给 now ⇒ 不知道多旧，但表还在（不影响估价）", () => {
    const s = staleInfo(priceTable(), {});
    assert.equal(s.ageDays, null);
    assert.equal(s.stale, false);
  });

  test("③e maxAgeDays 可覆盖", () => {
    const s = staleInfo(priceTable(), { now: NOW + 10 * DAY, maxAgeDays: 5 });
    assert.equal(s.stale, true);
    assert.equal(s.maxAgeDays, 5);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ④ 可读描述 —— 面板要显示的东西
 * ══════════════════════════════════════════════════════════════════════ */
describe("④ 可读描述 —— 0 与「估不出」分得开", () => {
  const d = describeTable(priceTable(), { channels: CHANNELS, nameOf, now: NOW });

  test("④a 快照日期 / 币种 / 陈旧都带着", () => {
    assert.equal(d.pricedAt, "2026-10-22");
    assert.equal(d.currency, "USD");
    assert.equal(d.stale, false);
    assert.equal(d.ageDays, 3);
  });

  test("④b 每条都有四个单价与显示名", () => {
    const mm = d.entries.find((e) => e.key === "mm/MiniMax-M3.1-Flash");
    assert.ok(mm, "表里应有 MiniMax 那一款");
    assert.equal(mm.channel, "mm");
    assert.equal(mm.model, "MiniMax-M3.1-Flash");
    assert.equal(mm.name, "MiniMax 国内站", "显示名走清单，不写死渠道名");
    assert.equal(mm.input, 0.1494);
    assert.equal(mm.output, 0.5976);
    assert.equal(mm.cacheRead, 0.0149);
  });

  test("④c ★ null 不许折成 0（估不出 ≠ 估出 0）", () => {
    const mm = d.entries.find((e) => e.key === "mm/MiniMax-M3.1-Flash");
    assert.equal(mm.cacheWrite, null, "源里没列 = 不知道；折成 0 就把缓存费当免费了");
    assert.equal(mm.partial, true, "partial 标出这一条有格子查不到");
  });

  test("④d 0 保留成 0，并标出「这一款真的免费」", () => {
    const sn = d.entries.find((e) => e.key === "sn/glm-5.2");
    assert.equal(sn.input, 0);
    assert.equal(sn.output, 0);
    assert.equal(sn.free, true, "四个数都是 0 = 免费");
    assert.equal(sn.partial, false);
  });

  test("④e ★ 表里没有条目的那几家 ⇒ 进 unpriced，各带一句为什么", () => {
    const keys = d.unpriced.map((u) => u.key);
    assert.deepEqual(keys.sort(), ["bai", "qd", "wb", "wbai"],
      "表里没条目的四家都要列出来 —— 列少了用户就以为它们免费");
    const bai = d.unpriced.find((u) => u.key === "bai");
    assert.equal(bai.name, "B.AI", "显示名走清单");
    assert.equal(bai.why, UNPRICED_WHY.bai);
    assert.ok(bai.why.length > 3, "理由要是一句人话");
    const qd = d.unpriced.find((u) => u.key === "qd");
    assert.match(qd.why, /积分/);
  });

  test("④f 估得出的那几家不该出现在 unpriced 里", () => {
    for (const k of ["sn", "zen", "mm", "or"]) {
      assert.equal(d.unpriced.some((u) => u.key === k), false, `${k} 表里有条目，不该算估不出`);
    }
  });

  test("④g 清单里没登记的一家 ⇒ 兜底理由，不许空着", () => {
    const d2 = describeTable(priceTable(), {
      channels: [{ key: "zz", name: "某家" }],
      nameOf: () => "某家",
      billing: {},
    });
    assert.equal(d2.unpriced.length, 1);
    assert.equal(d2.unpriced[0].why, DEFAULT_WHY);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 卡片 —— 面板上画出来的东西
 * ══════════════════════════════════════════════════════════════════════ */

/* 最小 DOM 桩：卡片只在 mount() 里碰 DOM，桩只要够它画一张盒子就够。 */
function fakeEl(tag) {
  const el = {
    tagName: tag || "div",
    className: "",
    id: "",
    innerHTML: "",
    textContent: "",
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
      if (this.innerHTML.indexOf('data-role="' + key + '"') < 0) return null;
      if (!this._kids) this._kids = new Map();
      if (!this._kids.has(key)) this._kids.set(key, fakeEl("div"));
      return this._kids.get(key);
    },
  };
  return el;
}

function evalCard(src, filename) {
  const sandbox = {
    window: {},
    document: {
      createElement: (t) => fakeEl(t),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    console,
    location: { pathname: "/", href: "http://127.0.0.1/" },
    navigator: { userAgent: "node" },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: filename || "price-table.js", timeout: 5000 });
  return sandbox.window;
}

/** 服务端 GET /api/pricing 的真实形状（见 server.mjs 的 pricingOverview）。 */
const PRICING_PAYLOAD = {
  ok: true,
  pricedAt: "2026-10-22",
  currency: "USD",
  unit: "perMillion",
  source: "builtin",
  ageDays: 3,
  stale: false,
  builtinPricedAt: "2026-10-22",
  entries: [
    { key: "sn/glm-5.2", name: "商汤 SenseNova · glm-5.2", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    { key: "mm/MiniMax-M3.1-Flash", name: "MiniMax 国内站 · MiniMax-M3.1-Flash", input: 0.1494, output: 0.5976, cacheRead: 0.0149, cacheWrite: null },
  ],
  refreshing: false,
  lastError: "",
  lastRefreshedAt: 0,
};

/** 装一张卡（可以是改坏过的副本）。 */
function mountCard(src, opts = {}) {
  const win = evalCard(src, opts.filename || "price-table.js");
  const card = (win.BAI_CARDS || {})["price-table"];
  assert.ok(card && typeof card.mount === "function", "卡片必须导出 mount(ctx)");
  const slot = fakeEl("div");
  const calls = [];
  const api = opts.api || (async (p, o) => {
    calls.push({ path: p, opts: o });
    return PRICING_PAYLOAD;
  });
  const ctx = {
    $: () => null,
    slot,
    api,
    esc: (s) => String(s == null ? "" : s),
    nameOf,
    channels: CHANNELS.map((c) => c.key),
    chainOf: () => CHANNELS.map((c) => c.key),
    view: "settings",
  };
  const view = card.mount(ctx);
  const box = slot.children[0];
  const q = (role) => box.querySelector('[data-role="' + role + '"]');
  return { card, view, box, q, calls, ctx };
}

describe("⑤ 卡片 —— 面板上画出来的东西", () => {
  test("⑤a 读的是 /api/pricing", async () => {
    const { view, calls } = mountCard(CARD_SRC);
    await view.update();
    assert.ok(calls.some((c) => c.path === "/api/pricing"), "卡片要读价格表");
  });

  test("⑤b 画得出快照日期与陈旧提示", async () => {
    const { view, q } = mountCard(CARD_SRC);
    await view.update();
    const head = q("pt-head").innerHTML;
    assert.match(head, /2026-10-22/, "快照日期必须显示出来");
    assert.match(head, /pill/, "陈旧与否要用语义药丸说");
    assert.equal(head.indexOf("陈旧") < 0, true, "3 天前还不算陈旧");
  });

  test("⑤c 陈旧时明说陈旧", async () => {
    const stale = Object.assign({}, PRICING_PAYLOAD, { stale: true, ageDays: 47 });
    const { view, q } = mountCard(CARD_SRC, { api: async () => stale });
    await view.update();
    const head = q("pt-head").innerHTML;
    assert.match(head, /陈旧/);
    assert.match(head, /47/);
    assert.match(head, /pill warn/, "陈旧用 warn 色（语义类名，不写死色值）");
  });

  test("⑤d 单价用清单里的显示名，不写死渠道名", async () => {
    const { view, q } = mountCard(CARD_SRC);
    await view.update();
    const body = q("pt-body").innerHTML;
    assert.match(body, /商汤 SenseNova/, "厂商列走显示名");
    assert.match(body, /MiniMax 国内站/);
    assert.match(body, /0\.1494/);
  });

  test("⑤e ★ 「估不出」画成「—」，「免费」画成 0 —— 两者不一样", async () => {
    const { view, q } = mountCard(CARD_SRC);
    await view.update();
    const body = q("pt-body").innerHTML;
    const rows = body.split("<tr>");
    const mm = rows.find((r) => r.indexOf("MiniMax-M3.1-Flash") >= 0) || "";
    const sn = rows.find((r) => r.indexOf("glm-5.2") >= 0) || "";
    assert.ok(mm && sn, "两条都要在画面上");
    assert.match(mm, /—/, "查不到的那一格要画成「—」");
    assert.equal(mm.indexOf(">0<") < 0, true, "★ 查不到的那一格绝不能画成 0（那就把缓存费当免费了）");
    assert.match(sn, /title="源里明说是 0 —— 这一款真的免费"/, "0 要说明它是真免费");
  });

  test("⑤f 估不出的渠道与原因都画出来", async () => {
    /* 服务端给了 unpriced 就用它给的（它知道每一家为什么估不出）。 */
    const payload = Object.assign({}, PRICING_PAYLOAD, {
      unpriced: [
        { key: "bai", name: "B.AI", why: "公开渠道查不到转售价" },
        { key: "qd", name: "Qoder", why: "按积分倍率算，不是按 token" },
      ],
    });
    const { view, q } = mountCard(CARD_SRC, { api: async () => payload });
    await view.update();
    const u = q("pt-unpriced").innerHTML;
    assert.match(u, /B\.AI/);
    assert.match(u, /公开渠道查不到转售价/);
    assert.match(u, /按积分倍率算/);
  });

  test("⑤g 服务端没给 unpriced ⇒ 自己按「表里没条目」推出来", async () => {
    const { view, q } = mountCard(CARD_SRC);
    await view.update();
    const u = q("pt-unpriced").innerHTML;
    assert.match(u, /B\.AI/, "表里没有条目的那几家要列出来");
    assert.match(u, /WorkBuddy/);
    assert.equal(u.indexOf("商汤 SenseNova") < 0, true, "估得出的那几家不该出现在这一张表里");
  });

  test("⑤h 图例说清 0 与「—」的区别", async () => {
    const { view, q } = mountCard(CARD_SRC);
    await view.update();
    const legend = q("pt-legend").innerHTML;
    assert.match(legend, /每百万 token/);
    assert.match(legend, /免费/);
    assert.match(legend, /查不到/);
  });

  test("⑤i 点「更新价格表」⇒ POST /api/pricing/refresh", async () => {
    const { view, q, calls } = mountCard(CARD_SRC);
    await view.update();
    const btn = q("pt-refresh");
    assert.ok(btn, "要有那个按钮");
    const click = (btn.listeners.click || [])[0];
    assert.equal(typeof click, "function", "按钮要绑得上");
    await click();
    const post = calls.find((c) => c.path === "/api/pricing/refresh");
    assert.ok(post, "要发 POST /api/pricing/refresh");
    assert.equal(post.opts.method, "POST");
  });

  test("⑤j 刷新是非阻塞的 ⇒ POST 回来之后轮 GET 看 refreshing", async () => {
    let getAfterPost = 0;
    const api = async (p) => {
      if (p === "/api/pricing/refresh") return { ok: true, started: true };
      getAfterPost++;
      /* 第一次还在跑，第二次跑完了 —— 卡片必须轮，不能只读一次。 */
      if (getAfterPost === 1) return Object.assign({}, PRICING_PAYLOAD, { refreshing: true });
      return Object.assign({}, PRICING_PAYLOAD, { refreshing: false, pricedAt: "2026-11-01", source: "remote" });
    };
    const { view, q } = mountCard(CARD_SRC, { api });
    await view.update();
    await (q("pt-refresh").listeners.click || [])[0]();
    const res = q("pt-result");
    assert.match(res.textContent, /已更新/, "跑完了要说更新成了什么");
    assert.match(res.textContent, /2026-11-01/);
    assert.ok(getAfterPost >= 2, "刷新期间要轮 GET /api/pricing");
  });

  test("⑤k ★ 刷新失败 ⇒ 继续用旧表，绝不清空", async () => {
    const api = async (p) => {
      if (p === "/api/pricing/refresh") throw new Error("拉不到 models.dev");
      return PRICING_PAYLOAD;
    };
    const { view, q } = mountCard(CARD_SRC, { api });
    await view.update();
    await (q("pt-refresh").listeners.click || [])[0]();
    const res = q("pt-result");
    assert.match(res.textContent, /继续用现在这张/, "失败要说清「继续用哪一张」");
    assert.match(res.textContent, /拉不到 models\.dev/);
    assert.match(res.className, /bad/);
    /* ★ 关键：表还在，费用不会被清成「—」或 0。 */
    const body = q("pt-body").innerHTML;
    assert.match(body, /0\.1494/, "刷新失败后表必须还在（清空 = 用户以为今天没花钱）");
  });

  test("⑤l 服务端说「没换表」⇒ 卡片把那句原因原样说给用户", async () => {
    const api = async (p) => {
      if (p === "/api/pricing/refresh") return { ok: true, started: true };
      return Object.assign({}, PRICING_PAYLOAD, {
        refreshing: false,
        lastError: "拉不到价格表：网络不通 —— 继续用旧的那张",
      });
    };
    const { view, q } = mountCard(CARD_SRC, { api });
    await view.update();
    await (q("pt-refresh").listeners.click || [])[0]();
    const res = q("pt-result");
    assert.match(res.textContent, /没有更新/);
    assert.match(res.textContent, /继续用旧的那张/);
    /* 服务端记下的原因要一直看得见（它��理解「为什么表没换」的唯一线索）。 */
    assert.match(q("pt-note").innerHTML, /继续用旧的那张/);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 源码锚点 —— 纯逻辑、零时钟、无渠道字面量、无写死颜色
 * ══════════════════════════════════════════════════════════════════════ */
describe("⑥ 源码锚点", () => {
  const stripComments = (js) => js
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

  test("⑥a 模块：零 IO、零时钟，只 import pricing.mjs", () => {
    const code = stripComments(MOD_SRC);
    assert.ok(!/Date\.now\s*\(/.test(code), "内部不许取时钟（时间由 opts.now 传入）");
    assert.ok(!/\bfetch\s*\(/.test(code), "模块不联网");
    assert.ok(!/require\s*\(/.test(code), "不许用 require");
    assert.ok(!/node:fs|node:http|node:net/.test(code), "不许碰 IO");
    const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["./pricing.mjs"], "只许 import pricing.mjs");
  });

  test("⑥b 模块头注释写清了关键的几件事", () => {
    for (const kw of ["用户点了才更新", "自动更新", "估不出", "null", "pricing.mjs"]) {
      assert.ok(MOD_SRC.includes(kw), `头注释里应当提到「${kw}」`);
    }
  });

  test("⑥c 卡片：不认识任何渠道名", () => {
    const code = stripComments(CARD_SRC);
    const keys = ["bai", "sn", "zen", "mm", "or", "qd", "wb", "wbai"];
    for (const k of keys) {
      const re = new RegExp("[\"'`]" + k + "[\"'`]");
      assert.equal(re.test(code), false, `卡片里出现了渠道字面量「${k}」—— 显示名要走清单`);
    }
  });

  test("⑥d 卡片：不许写死颜色", () => {
    const code = stripComments(CARD_SRC);
    assert.equal((code.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length, 0, "不许写死十六进制颜色");
    assert.equal((code.match(/\b(?:rgba?|hsla?)\s*\(/g) || []).length, 0, "不许写死 rgb()/hsl()");
    assert.equal((code.match(/style\s*=\s*"[^"]*(?:color|background|border-color)\s*:/gi) || []).length, 0,
      "inline style 里不许塞颜色（要用语义类名 ok/warn/err/idle/brand）");
  });

  test("⑥e 卡片：用的都是语义类名", () => {
    const code = stripComments(CARD_SRC);
    /* 语义色只经类名给：ok / warn / err / idle / brand。
     * （err 这一格由 .result bad 承担 —— 那也是 CSS 里的语义类，不是写死的色值。）*/
    for (const t of ["ok", "warn", "idle", "brand"]) {
      assert.ok(code.indexOf(`pill ${t}`) >= 0, `卡片应当用到语义类 ${t}`);
    }
    assert.ok(code.indexOf("result show bad") >= 0, "出错那一格走 .result bad（语义类）");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 反向对照 —— 改坏判定，对应的断言必须真的会红
 *
 * 做法：把实现复制到临时目录、改坏其中一处、import/求值那份副本，
 * 重跑关键断言 —— 结果必须与原实现不同。「不同」即证明上面那些断言不是空的。
 * ══════════════════════════════════════════════════════════════════════ */

async function sabotageModule(replacements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pricing-refresh-sabotage-"));
  let out = MOD_SRC;
  for (const [from, to] of replacements) {
    assert.ok(out.includes(from), `待破坏的片段在源码里找不到：${from}`);
    out = out.replace(from, to);
  }
  fs.writeFileSync(path.join(dir, "pricing-refresh.mjs"), out, "utf8");
  fs.writeFileSync(path.join(dir, "pricing.mjs"),
    fs.readFileSync(path.join(ROOT, "src", "server", "pricing.mjs"), "utf8"), "utf8");
  return import(`file:///${path.join(dir, "pricing-refresh.mjs").replace(/\\/g, "/")}`);
}

test("反向对照①：改坏「一样新也换」，同一天的远端表就不会被换上", async () => {
  const good = chooseTable(buildRemoteTable(MD_RAW, { pricedAt: "2026-10-22" }));
  assert.equal(good.changed, true);

  const bad = await sabotageModule([
    ["if (remoteAt === null || currentAt === null || remoteAt < currentAt) {",
      "if (remoteAt === null || currentAt === null || remoteAt <= currentAt) {"],
  ]);
  const broken = bad.chooseTable(bad.buildRemoteTable(MD_RAW, { pricedAt: "2026-10-22" }));
  assert.notEqual(broken.changed, good.changed,
    "边界判据一坏，用户点了刷新就什么都不发生 —— 断言必须抓得住");
});

test("反向对照②：改坏「远端比现在旧就不换」，旧表会被换上", async () => {
  const good = chooseTable(buildRemoteTable(MD_RAW, { pricedAt: "2026-10-01" }));
  assert.equal(good.changed, false);

  const bad = await sabotageModule([
    ["if (remoteAt === null || currentAt === null || remoteAt < currentAt) {",
      "if (remoteAt === null || currentAt === null) {"],
  ]);
  const broken = bad.chooseTable(bad.buildRemoteTable(MD_RAW, { pricedAt: "2026-10-01" }));
  assert.notEqual(broken.changed, good.changed,
    "旧表一换上，用户对的就是一张过期快照 —— 断言必须抓得住");
});

test("反向对照③：改坏「没日期的远端表不合格」，它会被换上", async () => {
  /* 远端数据是好的，但**没给快照日期** —— 这种表一律不许用。 */
  const good = chooseTable(buildRemoteTable(MD_RAW, {}));
  assert.equal(good.changed, false);
  assert.equal(good.table.pricedAt, "2026-10-22");

  const bad = await sabotageModule([
    ["if (dateMs(pricedAt) === null) {", "if (false) {"],
  ]);
  const broken = bad.chooseTable(bad.buildRemoteTable(MD_RAW, {}));
  assert.notEqual(broken.changed, good.changed,
    "一张没有日期的表被换上，用户对的就不是一个知道自己多旧的数 —— 断言必须抓得住");
});

test("反向对照④：改坏「null 不折成 0」，缓存费会被当成免费", async () => {
  const good = describeTable(priceTable(), { channels: CHANNELS, nameOf, now: NOW });
  const mm = good.entries.find((e) => e.key === "mm/MiniMax-M3.1-Flash");
  assert.equal(mm.cacheWrite, null);

  const bad = await sabotageModule([
    ['if (v === null || v === undefined || v === "") return null;',
      'if (v === undefined || v === "") return 0;'],
  ]);
  const broken = bad.describeTable(priceTable(), { channels: CHANNELS, nameOf, now: NOW });
  const bmm = broken.entries.find((e) => e.key === "mm/MiniMax-M3.1-Flash");
  assert.notEqual(bmm.cacheWrite, mm.cacheWrite,
    "把「不知道」折成 0，缓存费就被算成免费 —— 断言必须抓得住");
});

test("反向对照⑤：改坏「陈旧是严格大于 30 天」，边界就翻了", async () => {
  const good = staleInfo(priceTable(), { now: NOW + 27 * DAY });
  assert.equal(good.stale, false);

  const bad = await sabotageModule([
    ["stale: ageDays !== null && ageDays > maxAgeDays", "stale: ageDays !== null && ageDays >= maxAgeDays"],
  ]);
  const broken = bad.staleInfo(priceTable(), { now: NOW + 27 * DAY });
  assert.notEqual(broken.stale, good.stale, "边界判据一坏，30 天整就翻脸 —— 断言必须抓得住");
});

test("反向对照⑥：改坏「估不出的那几家要列出来」，它们就从画面上消失", async () => {
  const good = describeTable(priceTable(), { channels: CHANNELS, nameOf, now: NOW });
  assert.equal(good.unpriced.length, 4);

  const bad = await sabotageModule([
    ["if (!key || priced.has(key)) continue;", "if (!key) continue;"],
  ]);
  const broken = bad.describeTable(priceTable(), { channels: CHANNELS, nameOf, now: NOW });
  assert.notEqual(broken.unpriced.length, good.unpriced.length,
    "列少了用户就以为那几家免费 —— 断言必须抓得住");
});

test("反向对照⑦：改坏卡片的「— 不许画成 0」，查不到就变成免费了", async () => {
  const good = mountCard(CARD_SRC);
  await good.view.update();
  const goodBody = good.q("pt-body").innerHTML;
  assert.match(goodBody, /<span class="dim">—<\/span>/);

  const bad = mountCard(CARD_SRC.replace(
    "if (v === null || v === undefined) {", "if (false) {"), { filename: "price-table.broken.js" });
  await bad.view.update();
  const badBody = bad.q("pt-body").innerHTML;
  assert.notEqual(badBody, goodBody, "卡片一改坏，画面就变了 —— 断言必须抓得住");
  assert.equal(badBody.indexOf('<span class="dim">—<\/span>') < 0, true,
    "查不到的那一格被画成了 0 —— 那正是最贵的错法");
});
