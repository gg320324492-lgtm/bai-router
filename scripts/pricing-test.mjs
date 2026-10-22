/* 价格表与费用估算（src/server/pricing.mjs）的口径测试。
 *
 * 这层是「对标 magpie 复刻」T9 的一部分：用量账本记着每次调用的 token 数，
 * 但没有价格，面板上的「费用」一格至今只能写「服务端未统计」。本测试盯住
 * 补上这一格之后**最不能错的几条**：
 *
 *   ① 价格表必须带**快照日期**（价格是漂移的，一张没日期的表用户无从判断准不准）
 *   ② **未知模型 → 不估价**（返回 null，列进 unknownModels），绝不猜、
 *      绝不用「同类模型大概这个价」顶替；一个错数字比没有数字更坏
 *   ③ 缓存读与缓存写**分开**算（两者通常差着好几倍）
 *   ④ **失败但已被计费的尝试（handed_on）照样算钱**（magpie 同一口径）
 *   ⑤ **时间读不出来的记录也要算**（宁可多算，不要少算）
 *   ⑥ 远端表**拉失败就用旧的**（不许因为拉不到就把费用清空）
 *
 * 时间一律由参数注入（opts.now），本文件不取 Date.now()。
 *
 * 最后一大节是**反向对照**：把实现改坏（写到临时副本 import 进来），证明
 * 对应的断言**真的会红** —— 一条从没红过的断言等于没写。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  priceTable,
  estimateCost,
  normalizeTable,
  tableFromModelsDev,
  MODELS_DEV_CHANNELS,
} from "../src/server/pricing.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRICING_PATH = path.join(SCRIPT_DIR, "..", "src", "server", "pricing.mjs");

/** 2026-10-22T00:00:00Z —— 内置表的快照日当天。 */
const NOW = 1792627200000;
const DAY = 24 * 60 * 60 * 1000;

/** 浮点数比较：钱是加出来的，不能用 === 比。 */
function near(actual, expected, msg = "", eps = 1e-12) {
  assert.ok(
    typeof actual === "number" && Math.abs(actual - expected) <= eps,
    msg || `${actual} 不等于 ${expected}`,
  );
}

/** 判据在变异体上会不会红（红 = 这条断言真的有鉴别力）。 */
function goesRed(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/**
 * 把实现改坏：读源码 → 按锚点替换 → 写进临时目录 → import 进来。
 *
 * 走**真源码**而不是重抄一遍：重抄的那份一改就与实现脱节，测的就不是
 * 真的那份代码了。锚点没命中会直接抛错 —— 静默改不成比改坏更坏。
 */
let mutantSeq = 0;
async function mutant(replacements) {
  const src = await fs.readFile(PRICING_PATH, "utf8");
  let out = src;
  for (const [from, to] of replacements) {
    if (!out.includes(from)) {
      throw new Error(`变异锚点没命中：${from.slice(0, 70)}`);
    }
    out = out.replace(from, to);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pricing-mutant-"));
  const file = path.join(dir, `pricing-${mutantSeq++}.mjs`);
  await fs.writeFile(file, out, "utf8");
  return import(pathToFileURL(file).href);
}

/** 一条 mm 记录（MiniMax-M3.1-Flash 是表里唯一有实价的那款）。 */
const mmRec = (extra = {}) => ({
  provider: "mm",
  model: "MiniMax-M3.1-Flash",
  in: 1000,
  out: 500,
  ...extra,
});

/* ══════════════════════════════════════════════════════════════════════
 * ① 价格表本身
 * ══════════════════════════════════════════════════════════════════════ */
describe("① 价格表 —— 快照日期 / 单位 / 形状", () => {
  test("①a 表带快照日期、单位写明是「每百万 token」", () => {
    const t = priceTable();
    assert.equal(t.pricedAt, "2026-10-22", "价格会漂移，没日期的表不能用");
    assert.match(t.pricedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(t.currency, "USD");
    assert.equal(t.unit, "per-1M-tokens", "单位含糊就差 1000 倍");
  });

  test("①b 每条都有四个通道，输入输出是数，缓存两通道是「数或 null」", () => {
    const entries = priceTable().entries;
    assert.ok(Object.keys(entries).length > 0, "表不该是空的");
    for (const [key, e] of Object.entries(entries)) {
      assert.match(key, /^[^/]+\/.+/, `键得是「厂商/模型」：${key}`);
      assert.equal(typeof e.input, "number", `${key} 的输入价必须是数`);
      assert.equal(typeof e.output, "number", `${key} 的输出价必须是数`);
      for (const f of ["cacheRead", "cacheWrite"]) {
        const v = e[f];
        assert.ok(v === null || typeof v === "number", `${key} 的 ${f} 只能是数或 null`);
      }
    }
  });

  test("①c 免费模型的缓存两通道写 0（源里明说免费，不该是 null）", () => {
    for (const [key, e] of Object.entries(priceTable().entries)) {
      if (e.input === 0 && e.output === 0) {
        assert.equal(e.cacheRead, 0, `${key} 是免费的，缓存读不该是「不知道」`);
        assert.equal(e.cacheWrite, 0, `${key} 是免费的，缓存写不该是「不知道」`);
      }
    }
  });

  test("①d 表里的键没有「档位」—— 档位与厂商无关，按它估价必然串味", () => {
    const tiers = ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5"];
    for (const key of Object.keys(priceTable().entries)) {
      const model = key.slice(key.indexOf("/") + 1);
      for (const t of tiers) {
        assert.notEqual(model, t, `表里不该按档位索引：${key}`);
      }
    }
  });

  test("①e priceTable() 给的是拷贝，改它改不坏模块里的表", () => {
    const a = priceTable();
    a.entries["mm/MiniMax-M3.1-Flash"].input = 999;
    const b = priceTable();
    assert.equal(b.entries["mm/MiniMax-M3.1-Flash"].input, 0.1494, "表必须是拷出来的");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ② 算术：单位换算与四通道
 * ══════════════════════════════════════════════════════════════════════ */
describe("② 算术 —— 每百万 token 换算 / 四个通道各算各的", () => {
  test("②a 输入输出按「每百万 token」换算", () => {
    const r = estimateCost([mmRec()], { now: NOW });
    /* (1000×0.1494 + 500×0.5976) / 1e6 = (149.4 + 298.8) / 1e6 */
    near(r.total, 0.0004482, "费用算错了");
    assert.equal(r.known, true);
    assert.equal(r.byModel["mm/MiniMax-M3.1-Flash"].tokens, 1500, "tokens 是四个通道的总数");
  });

  test("②b 缓存读与缓存写**分开**算，不能混成一个数", () => {
    const ov = { "bai/claude-opus-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
    const base = { provider: "bai", model: "claude-opus-5", in: 1000, out: 100 };
    const readOnly = estimateCost([{ ...base, cache_read: 2000, cache_write: 0 }], { overrides: ov });
    const writeOnly = estimateCost([{ ...base, cache_read: 0, cache_write: 2000 }], { overrides: ov });
    /* 读：3000 + 1500 + 600 = 5100 → 0.0051；写：3000 + 1500 + 7500 = 12000 → 0.012 */
    near(readOnly.total, 0.0051);
    near(writeOnly.total, 0.012);
    assert.notEqual(readOnly.total, writeOnly.total, "缓存读与缓存写单价不同，混起来就错了");
  });

  test("②c 四通道一起算", () => {
    const ov = { "bai/claude-opus-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
    const r = estimateCost(
      [{ provider: "bai", model: "claude-opus-5", in: 1000, out: 100, cache_read: 2000, cache_write: 500 }],
      { overrides: ov },
    );
    /* 3000 + 1500 + 600 + 1875 = 6975 → 0.006975 */
    near(r.total, 0.006975);
    assert.equal(r.byModel["bai/claude-opus-5"].tokens, 3600);
  });

  test("②d 零 token 的记录不算钱，也不算「估不出」", () => {
    const r = estimateCost([{ provider: "bai", model: "claude-opus-5", in: 0, out: 0 }], { now: NOW });
    assert.equal(r.total, 0);
    assert.equal(r.known, true);
    assert.deepEqual(r.unknownModels, [], "没花什么 ≠ 估不出");
    assert.deepEqual(r.byModel, {});
  });

  test("②e 空批次 ⇒ 0 元，不是 null", () => {
    const r = estimateCost([], { now: NOW });
    assert.equal(r.total, 0);
    assert.equal(r.known, true);
    assert.deepEqual(r.unknownModels, []);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ③ 未知模型 → 不估价
 * ══════════════════════════════════════════════════════════════════════ */
describe("③ 未知模型 —— 返回 null，绝不猜", () => {
  test("③a 表里没有的模型 ⇒ total 是 null（不是 0，也不是已知部分之和）", () => {
    const r = estimateCost([{ provider: "bai", model: "claude-opus-5", in: 1000, out: 100 }], { now: NOW });
    assert.equal(r.total, null, "★ 估不出就是 null，不是 0");
    assert.equal(r.known, false);
    assert.deepEqual(r.unknownModels, ["bai/claude-opus-5"], "要列出来，而不是混在总数里");
    assert.equal(r.byModel["bai/claude-opus-5"].cost, null);
    assert.equal(r.byModel["bai/claude-opus-5"].known, false);
    assert.equal(r.byModel["bai/claude-opus-5"].tokens, 1100, "token 数照样记着");
  });

  test("③b 一批里混着已知的与未知的 ⇒ 总价仍然是 null（偏少的总价更坏）", () => {
    const r = estimateCost(
      [mmRec(), { provider: "bai", model: "claude-opus-5", in: 1000, out: 100 }],
      { now: NOW },
    );
    assert.equal(r.total, null, "★ 不能报一个少了零头的总价");
    assert.equal(r.known, false);
    assert.deepEqual(r.unknownModels, ["bai/claude-opus-5"]);
    assert.equal(r.byModel["mm/MiniMax-M3.1-Flash"].known, true, "已知的那部分照样给得出");
    near(r.byModel["mm/MiniMax-M3.1-Flash"].cost, 0.0004482);
  });

  test("③c 中国那几家查不到价的就是查不到 —— 不许拿别家的价顶替", () => {
    /* qd（Qoder）按积分算、wb/wbai（WorkBuddy）按积分倍率算、bai 是转发站：
       它们的单价在公开渠道查不到，所以表里没有它们 ⇒ 面板显示「—」。 */
    for (const [provider, model] of [
      ["qd", "lite"],
      ["wb", "hy3"],
      ["wbai", "hy3"],
      ["bai", "qwen3.8-flash"],
      ["sn", "deepseek-flash"],
      ["or", "apodex/apodex-1.1-mini:free"],
    ]) {
      const r = estimateCost([{ provider, model, in: 1000, out: 100 }], { now: NOW });
      assert.equal(r.total, null, `${provider}/${model} 估不出就必须是 null`);
      assert.deepEqual(r.unknownModels, [`${provider}/${model}`]);
    }
  });

  test("③d 源里没列的通道（缓存写）⇒ 用到了就估不出", () => {
    /* mm/MiniMax-M3.1-Flash 的缓存写单价源里没列（cacheWrite 是 null）。 */
    const withWrite = estimateCost([mmRec({ cache_write: 100 })], { now: NOW });
    assert.equal(withWrite.total, null, "★ 用了未知通道 ⇒ 估不出（不是按 0 算）");
    assert.deepEqual(withWrite.unknownModels, ["mm/MiniMax-M3.1-Flash"]);
    /* 没用缓存写 ⇒ 估得出 */
    const without = estimateCost([mmRec({ cache_write: 0, cache_read: 0 })], { now: NOW });
    near(without.total, 0.0004482);
    assert.equal(without.known, true);
  });

  test("③e 同一个模型有的记录估得出、有的估不出 ⇒ 整个模型算估不出", () => {
    const r = estimateCost([mmRec({ cache_write: 0 }), mmRec({ cache_write: 100 })], { now: NOW });
    assert.equal(r.known, false);
    assert.equal(r.byModel["mm/MiniMax-M3.1-Flash"].cost, null);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ④ 覆盖机制
 * ══════════════════════════════════════════════════════════════════════ */
describe("④ 覆盖 —— 用户自己写的单价", () => {
  test("④a 覆盖能让本来估不出的模型估得出", () => {
    const ov = { "bai/claude-opus-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
    const r = estimateCost([{ provider: "bai", model: "claude-opus-5", in: 1000, out: 100 }], { overrides: ov });
    near(r.total, 0.0045);
    assert.equal(r.known, true);
    assert.deepEqual(r.unknownModels, []);
  });

  test("④b 覆盖压过表里的价", () => {
    const r = estimateCost([mmRec()], { overrides: { "mm/MiniMax-M3.1-Flash": { input: 1, output: 2 } } });
    /* (1000×1 + 500×2) / 1e6 = 0.002 */
    near(r.total, 0.002);
  });

  test("④c 只写一部分 ⇒ 没写的沿用表里的值", () => {
    const r = estimateCost([mmRec()], { overrides: { "mm/MiniMax-M3.1-Flash": { output: 2 } } });
    /* 输入仍用表里的 0.1494，输出用覆盖的 2：(1000×0.1494 + 500×2)/1e6 */
    near(r.total, (149.4 + 1000) / 1e6);
  });

  test("④d 「厂商/*」管这一家所有还没被精确覆盖的模型", () => {
    const ov = { "bai/*": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
    const r = estimateCost([{ provider: "bai", model: "claude-opus-5", in: 1000, out: 100 }], { overrides: ov });
    near(r.total, (1000 + 200) / 1e6);
    /* 精确覆盖压过通配 */
    const r2 = estimateCost([{ provider: "bai", model: "claude-opus-5", in: 1000, out: 100 }], {
      overrides: { ...ov, "bai/claude-opus-5": { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } },
    });
    near(r2.total, (10000 + 2000) / 1e6);
  });

  test("④e 覆盖写成不是数 ⇒ 当「没给」，不按 0 算", () => {
    /* 用户手滑把 15 写成 "abc"：输出价退到表里的值，而不是变成 0。 */
    const r = estimateCost([mmRec()], { overrides: { "mm/MiniMax-M3.1-Flash": { output: "abc" } } });
    near(r.total, 0.0004482, "写坏了的覆盖应当被忽略，而不是当成 0");
  });

  test("④f 覆盖字段名也认 models.dev 的写法", () => {
    const ov = { "bai/claude-opus-5": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } };
    const r = estimateCost(
      [{ provider: "bai", model: "claude-opus-5", in: 1000, out: 100, cache_read: 2000, cache_write: 500 }],
      { overrides: ov },
    );
    near(r.total, 0.006975);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 失败与转交的尝试、时间读不出来的记录
 * ══════════════════════════════════════════════════════════════════════ */
describe("⑤ 该算的都算上", () => {
  test("⑤a handed_on 的那次尝试照样算钱（它可能已经被厂商计费了）", () => {
    const r = estimateCost(
      [
        mmRec({ in: 1000, out: 0, handed_on: true, status: 500, error: "上游 500" }),
        mmRec({ in: 1000, out: 0, handed_on: false, status: 200 }),
      ],
      { now: NOW },
    );
    /* 两次都算：(1000×0.1494)×2 / 1e6 */
    near(r.total, (149.4 * 2) / 1e6, "★ 转交出去的那次也要算钱");
  });

  test("⑤b 不按 status 二次过滤：失败与网络错照样算", () => {
    const r = estimateCost(
      [
        mmRec({ in: 1000, out: 0, status: 200 }),
        mmRec({ in: 1000, out: 0, status: 500, error: "boom" }),
        mmRec({ in: 1000, out: 0, status: 0, error: "网络错" }),
      ],
      { now: NOW },
    );
    near(r.total, (149.4 * 3) / 1e6);
  });

  test("⑤c 时间读不出来的记录也要算（宁可多算，不要少算）", () => {
    const r = estimateCost(
      [
        mmRec({ in: 1000, out: 0, t: "2026-10-22T00:00:00Z" }),
        mmRec({ in: 1000, out: 0, t: "乱码" }),
        mmRec({ in: 1000, out: 0, t: "" }),
        mmRec({ in: 1000, out: 0 }),
      ],
      { now: NOW },
    );
    near(r.total, (149.4 * 4) / 1e6, "★ 时间读不出来不等于这条不存在");
  });

  test("⑤d 记录没有厂商/模型名 ⇒ 跳过（没有身份就没有价可对）", () => {
    const r = estimateCost([{ in: 1000, out: 100 }], { now: NOW });
    assert.equal(r.total, 0);
    assert.deepEqual(r.unknownModels, []);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 远端表：带日期才收、拉坏就用旧的
 * ══════════════════════════════════════════════════════════════════════ */
describe("⑥ 远端表 —— 更新不改代码，拉失败用旧的", () => {
  test("⑥a 没 pricedAt 的表一律拒绝（价格会漂移，没日期的表不能用）", () => {
    const bad = normalizeTable({ entries: { "mm/x": { input: 1, output: 2 } } });
    assert.equal(bad.ok, false);
    assert.equal(bad.table, null);
    assert.match(bad.reason, /pricedAt/);
  });

  test("⑥b pricedAt 不是真日期 ⇒ 拒绝", () => {
    const bad = normalizeTable({ pricedAt: "2026-13-45", entries: { "mm/x": { input: 1, output: 2 } } });
    assert.equal(bad.ok, false);
    assert.equal(bad.table, null);
  });

  test("⑥c 缺 entries / 条目空 ⇒ 拒绝（多半是拉坏了）", () => {
    assert.equal(normalizeTable({ pricedAt: "2026-10-22" }).ok, false);
    assert.equal(normalizeTable({ pricedAt: "2026-10-22", entries: {} }).ok, false);
    assert.equal(normalizeTable({ pricedAt: "2026-10-22", entries: { "a/b": { input: 1 } } }).ok, false,
      "只给一半单价的条目没法用");
  });

  test("⑥d 合格的表：日期与条目都在", () => {
    const good = normalizeTable({
      pricedAt: "2026-11-01",
      entries: { "mm/MiniMax-M3.1-Flash": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    });
    assert.equal(good.ok, true);
    assert.equal(good.table.pricedAt, "2026-11-01");
    assert.equal(good.table.unit, "per-1M-tokens");
    assert.equal(good.table.entries["mm/MiniMax-M3.1-Flash"].input, 1);
  });

  test("⑥e 新表换上 ⇒ 按新价算，日期也跟着换", () => {
    const table = normalizeTable({
      pricedAt: "2026-11-01",
      entries: { "mm/MiniMax-M3.1-Flash": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
    }).table;
    const r = estimateCost([mmRec()], { table, now: NOW });
    near(r.total, (1000 * 1 + 500 * 2) / 1e6);
    assert.equal(r.pricedAt, "2026-11-01", "面板要显示的是这张表的快照日期");
  });

  test("⑥f ★ 拉失败就用旧的 —— 费用绝不清空", () => {
    /* 远端拉回来一张坏表（entries 是空的）：绝不能因此把所有费用变成 0 或「—」。 */
    const broken = { pricedAt: "2026-11-01", entries: {} };
    const r = estimateCost([mmRec()], { table: broken, now: NOW });
    near(r.total, 0.0004482, "★ 拉坏了就用旧表，费用不许被清空");
    assert.equal(r.pricedAt, "2026-10-22", "用的还是内置那张表");
  });

  test("⑥g 远端表不带日期 ⇒ 干脆不认它（旧表继续用）", () => {
    const noDate = { entries: { "mm/MiniMax-M3.1-Flash": { input: 1, output: 2 } } };
    const r = estimateCost([mmRec()], { table: noDate, now: NOW });
    near(r.total, 0.0004482);
  });

  test("⑥h models.dev 的形状翻成本仓的形状（换价不用改代码）", () => {
    const raw = {
      sensenova: { models: { "glm-5.2": { cost: { input: 0, output: 0, cache_read: 0 } } } },
      opencode: { models: { "space-bunny-free": { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } } },
      "minimax-cn": { models: { "MiniMax-M3.1-Flash": { cost: { input: 0.1494, output: 0.5976, cache_read: 0.0149 } } } },
      openrouter: { models: { "x/y:free": { cost: { input: 0, output: 0 } } } },
    };
    const t = tableFromModelsDev(raw, undefined, "2026-11-01");
    assert.equal(t.pricedAt, "2026-11-01", "快照日期由调用方给（抓取那天）");
    assert.equal(t.entries["sn/glm-5.2"].cacheWrite, 0, "免费模型的缓存写按 0");
    assert.equal(t.entries["mm/MiniMax-M3.1-Flash"].cacheWrite, null, "源里没列的通道 = 不知道");
    assert.equal(t.entries["or/x/y:free"].cacheRead, 0);
    assert.equal(t.entries["or/x/y:free"].cacheWrite, 0);
    assert.ok(normalizeTable(t).ok, "翻出来的表得能过校验（带日期才收）");
  });

  test("⑥i models.dev 没有的几家（中国那几家）不在映射里 —— 列进去只会让人以为查得到", () => {
    assert.deepEqual(Object.keys(MODELS_DEV_CHANNELS).sort(), ["mm", "or", "sn", "zen"]);
    for (const p of ["bai", "qd", "wb", "wbai"]) {
      assert.ok(!(p in MODELS_DEV_CHANNELS), `${p} 不该出现在 models.dev 映射里`);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 陈旧
 * ══════════════════════════════════════════════════════════════════════ */
describe("⑦ 快照有多旧", () => {
  test("⑦a 给了 now ⇒ 算得出天数；超期算陈旧", () => {
    const r = estimateCost([mmRec()], { now: NOW });
    assert.equal(r.ageDays, 0);
    assert.equal(r.stale, false);
    const old = estimateCost([mmRec()], { now: NOW + 60 * DAY });
    assert.equal(old.ageDays, 60);
    assert.equal(old.stale, true);
  });

  test("⑦b ★ 陈旧只是提醒，不许把费用清空", () => {
    const old = estimateCost([mmRec()], { now: NOW + 365 * DAY });
    assert.equal(old.stale, true);
    near(old.total, 0.0004482, "陈旧也要给出钱");
  });

  test("⑦c 不给 now ⇒ 不知道多旧，但照样算钱", () => {
    const r = estimateCost([mmRec()]);
    assert.equal(r.ageDays, null);
    assert.equal(r.stale, false);
    near(r.total, 0.0004482);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 源码锚点：零依赖、零时钟、头注释写清了该写清的
 * ══════════════════════════════════════════════════════════════════════ */
describe("⑧ 源码锚点", () => {
  test("⑧a 纯逻辑：不 import 任何模块，内部不取时钟", async () => {
    const src = await fs.readFile(PRICING_PATH, "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/^\s*import\s/m.test(code), "不许 import 仓库里任何其它模块");
    assert.ok(!/require\s*\(/.test(code), "不许用 require");
    assert.ok(!/Date\.now\s*\(/.test(code), "内部不许取时钟（时间由 opts.now 传入）");
  });

  test("⑧b 头注释写清了：补的哪个洞 / magpie 对应哪个文件 / 快照日期 / 覆盖范围 / 差异", async () => {
    const src = await fs.readFile(PRICING_PATH, "utf8");
    for (const kw of [
      "pricing.mjs",
      "internal/catalog/catalog.go",
      "internal/usage/usage.go",
      "2026-10-22",
      "models.dev",
      "sn/*",
      "zen/*",
      "mm/*",
      "or/*",
      "bai/*",
      "qd/*",
      "wb/*",
      "wbai/*",
      "与 magpie 有意不同",
    ]) {
      assert.ok(src.includes(kw), `头注释里应当提到「${kw}」`);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑨ 反向对照：把实现改坏，对应的断言必须真的会红
 * ══════════════════════════════════════════════════════════════════════ */
describe("⑨ 反向对照 —— 改坏实现，对应断言必须红", () => {
  test("⑨a 拿「档位」当模型名 ⇒ ②/③ 的判据会红", async () => {
    const bad = await mutant([
      ["const model = str(rec.model) || str(rec.served);", "const model = str(rec.req) || str(rec.served);"],
    ]);
    const recs = [mmRec({ req: "claude-opus-5" })];
    const check = (m) => near(m.estimateCost(recs, { now: NOW }).total, 0.0004482);
    assert.doesNotThrow(() => check({ estimateCost }), "真实现必须过这条判据");
    assert.ok(goesRed(() => check(bad)), "★ 变异体必须让这条判据变红");
  });

  test("⑨b 把「估不出」按 0 混进总数 ⇒ ③a 会红", async () => {
    const bad = await mutant([["if (unknownCount) total = null;", "if (unknownCount) { /* 变异：混进总数 */ }"]]);
    const recs = [{ provider: "bai", model: "claude-opus-5", in: 1000, out: 100 }];
    const check = (m) => assert.equal(m.estimateCost(recs, { now: NOW }).total, null);
    assert.doesNotThrow(() => check({ estimateCost }));
    assert.ok(goesRed(() => check(bad)), "★ 变异体必须让这条判据变红");
  });

  test("⑨c 把缓存读按输出价算 ⇒ ②b 会红", async () => {
    const bad = await mutant([["tok.cacheRead * entry.cacheRead +", "tok.cacheRead * entry.output +"]]);
    const ov = { "bai/claude-opus-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
    const recs = [{ provider: "bai", model: "claude-opus-5", in: 1000, out: 100, cache_read: 2000, cache_write: 500 }];
    const check = (m) => near(m.estimateCost(recs, { overrides: ov }).total, 0.006975);
    assert.doesNotThrow(() => check({ estimateCost }));
    assert.ok(goesRed(() => check(bad)), "★ 变异体必须让这条判据变红");
  });

  test("⑨d 把「未知通道」按 0 算 ⇒ ③d 会红", async () => {
    const bad = await mutant([
      [
        'if (tok.cacheWrite > 0 && typeof entry.cacheWrite !== "number") return false;',
        'if (tok.cacheWrite > 0 && typeof entry.cacheWrite !== "number") { entry.cacheWrite = 0; }',
      ],
    ]);
    const recs = [mmRec({ cache_write: 100 })];
    const check = (m) => assert.equal(m.estimateCost(recs, { now: NOW }).total, null);
    assert.doesNotThrow(() => check({ estimateCost }));
    assert.ok(goesRed(() => check(bad)), "★ 变异体必须让这条判据变红");
  });

  test("⑨e 把失败/转交的记录剔掉 ⇒ ⑤a 会红", async () => {
    const bad = await mutant([
      [
        "for (const rec of Array.isArray(records) ? records : []) {",
        "for (const rec of (Array.isArray(records) ? records : []).filter((r) => !(r && (r.handed_on === true || (typeof r.status === 'number' && r.status >= 400))))) {",
      ],
    ]);
    const recs = [
      mmRec({ in: 1000, out: 0, handed_on: true, status: 500 }),
      mmRec({ in: 1000, out: 0, handed_on: false, status: 200 }),
    ];
    const check = (m) => near(m.estimateCost(recs, { now: NOW }).total, (149.4 * 2) / 1e6);
    assert.doesNotThrow(() => check({ estimateCost }));
    assert.ok(goesRed(() => check(bad)), "★ 变异体必须让这条判据变红");
  });

  test("⑨f 把时间读不出来的记录剔掉 ⇒ ⑤c 会红", async () => {
    const bad = await mutant([
      [
        "for (const rec of Array.isArray(records) ? records : []) {",
        "for (const rec of (Array.isArray(records) ? records : []).filter((r) => { const t = r && r.t; if (t == null || t === '') return true; return Number.isFinite(Date.parse(String(t))); })) {",
      ],
    ]);
    const recs = [mmRec({ in: 1000, out: 0, t: "2026-10-22T00:00:00Z" }), mmRec({ in: 1000, out: 0, t: "乱码" })];
    const check = (m) => near(m.estimateCost(recs, { now: NOW }).total, (149.4 * 2) / 1e6);
    assert.doesNotThrow(() => check({ estimateCost }));
    assert.ok(goesRed(() => check(bad)), "★ 变异体必须让这条判据变红");
  });

  test("⑨g 不看用户的覆盖 ⇒ ④a 会红", async () => {
    const bad = await mutant([["const exact = normalizeEntry(overrides && overrides[key]);", "const exact = null;"]]);
    const ov = { "bai/claude-opus-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
    const recs = [{ provider: "bai", model: "claude-opus-5", in: 1000, out: 100 }];
    const check = (m) => near(m.estimateCost(recs, { overrides: ov }).total, 0.0045);
    assert.doesNotThrow(() => check({ estimateCost }));
    assert.ok(goesRed(() => check(bad)), "★ 变异体必须让这条判据变红");
  });

  test("⑨h 拉坏表就把费用清空 ⇒ ⑥f 会红", async () => {
    const bad = await mutant([
      [
        "const table = givenEntries && Object.keys(givenEntries).length > 0 && givenDated ? given : BUILTIN_TABLE;",
        "const table = givenEntries && givenDated ? given : BUILTIN_TABLE;",
      ],
    ]);
    const broken = { pricedAt: "2026-11-01", entries: {} };
    const check = (m) => near(m.estimateCost([mmRec()], { table: broken, now: NOW }).total, 0.0004482);
    assert.doesNotThrow(() => check({ estimateCost }));
    assert.ok(goesRed(() => check(bad)), "★ 变异体必须让这条判据变红");
  });
});
