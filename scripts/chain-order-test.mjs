/* 转移链的排序（magpie 的路由组语义）：入口永远第一，其余按路由策略排。
 *
 * 这条链现在是**为配额探测（T9）预备**的：magpie 那边策略排出来的顺序是真按额度排的
 * （额度用尽的排后面、续期早的排前面），而 bai-router 的供应商大多不暴露配额接口，
 * 所以多数座位的额度是「未知」——「不知道」既不当成用尽、也不当成没用过，
 * 于是排序**保持配置里的顺序**。
 *
 * 所以本测试要证明三件事：
 *   ① 机制本身是对的：给真实的额度窗口，顺序**真的会按策略变**；
 *   ② 今天的信号不足时，顺序**一字不变**（不制造行为变化）；
 *   ③ 排序坏了**不许**让转移链崩（排序只决定「先试谁」）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply as applyRouteStrategy, Builtin } from "../src/server/routes.mjs";
import { seatOf } from "../src/server/seat-builder.mjs";
import { makeCandidate } from "../src/server/candidates.mjs";
import { applyQuotaToSeat, applyProbeToSeat } from "../src/server/quota.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "src/server/server.mjs"), "utf8");

/* 把 orderChain 从 server.mjs 里按锚点抠出来（server.mjs 一 import 就起服务，
 * 只能这么测本体）。依赖从外面注进去。 */
function sliceFn(src, anchor) {
  const i = src.indexOf(anchor);
  assert.ok(i >= 0, `源码里找不到锚点：${anchor}`);
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    const ch = src[k];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`锚点 ${anchor} 的大括号没配平`);
}
const SRC_ORDER_CHAIN = sliceFn(SRC, "function orderChain");

/**
 * 造一个 orderChain，依赖从外面注进去。
 *
 * ⚠⚠ **loadCfg 必须注入**：orderChain 内部第一件事就是 loadCfg()，
 *   而它整个函数体包在 try/catch 里 —— 之前这条测试**没有注入 loadCfg**，
 *   于是每次调用都在第一行 ReferenceError、被 catch 吞掉、直接 return 原序。
 *   也就是说：②「信号不足 → 顺序一字不变」与③「排序坏了不许崩」两条断言
 *   **恒真**（它们看到的永远是那条「什么都没做」的路径）。
 *   恒真的测试比没有测试更坏 —— 它会让人以为这条链验过了。
 *   现在把依赖补齐，orderChain 真的跑起来，断言才有意义。
 */
function makeOrderChain(opts = {}) {
  const factory = new Function(
    "seatOf", "makeCandidate", "applyRouteStrategy", "Builtin", "failoverAvailable", "restTable",
    "loadCfg", "budgetStates", "budgetExhausted", "applyQuotaToSeat", "applyProbeToSeat",
    "cachedProbeOf",
    `${SRC_ORDER_CHAIN}\nreturn orderChain;`,
  );
  return factory(
    seatOf,
    makeCandidate,
    opts.brokenStrategy ? () => { throw new Error("策略坏了"); } : applyRouteStrategy,
    Builtin,
    opts.cooling ? (p) => opts.cooling.includes(p) : () => true,
    () => ({ has: () => false, due: () => true, entry: () => null }),
    opts.loadCfg ? opts.loadCfg : () => ({}),
    opts.budgetStates ? opts.budgetStates : () => new Map(),
    opts.budgetExhausted ? opts.budgetExhausted : () => false,
    opts.applyQuotaToSeat ? opts.applyQuotaToSeat : applyQuotaToSeat,
    opts.applyProbeToSeat ? opts.applyProbeToSeat : applyProbeToSeat,
    opts.cachedProbeOf ? opts.cachedProbeOf : () => null,
  );
}

const NOW = 1_700_000_000_000;

describe("转移链排序", () => {
  test("① 机制是真的：给真实额度窗口，用尽的号排到最后", () => {
    /* 「用尽 99%」与「刚开 5%」两个 provider。Smart 的口径是额度用尽的排后面。 */
    const orderChain = makeOrderChain();
    /* orderChain 内部自己造候选，额度从哪来？—— 走 makeCandidate 的 allowance 字段。
     * 这里直接用 seat-builder + routes 验同一套判据（orderChain 的候选由它自己造，
     * 所以这条测的是「策略+座位表」这一层的正确性）。 */
    const seats = [
      seatOf(makeCandidate({ provider: "a", model: "", allowance: { used: 99, limit: 100, unit: "req" } }), { now: NOW }),
      seatOf(makeCandidate({ provider: "b", model: "", allowance: { used: 5, limit: 100, unit: "req" } }), { now: NOW }),
    ];
    assert.equal(seats[0].used, 99, "用尽的号没体现出 99%");
    assert.equal(seats[1].used, 5);
    const idx = applyRouteStrategy(Builtin.smart, "chain", seats, NOW);
    assert.equal(seats[idx[0]].key, "b", "额度富余的号没排到前面");
    assert.equal(seats[idx[1]].key, "a", "额度用尽的号没排到最后");
  });

  test("② 今天的信号不足 → 顺序一字不变（不制造行为变化）", () => {
    const orderChain = makeOrderChain();
    const list = ["bai", "sn", "zen", "wb"];
    const out = orderChain(list, NOW);
    assert.deepEqual(out, list, "没有额度信号时顺序被改了");
  });

  test("③ 排序坏了不许让转移链崩（fail open）", () => {
    const orderChain = makeOrderChain({ brokenStrategy: true });
    const list = ["bai", "sn", "zen"];
    let out = null;
    assert.doesNotThrow(() => { out = orderChain(list, NOW); });
    assert.deepEqual(out, list, "策略坏了之后顺序没退回原样");
  });

  test("④ 冷却中的 provider 照样进链（跳过是链循环的事，不是排序的事）", () => {
    const orderChain = makeOrderChain({ cooling: ["zen"] });
    const list = ["bai", "zen", "sn"];
    const out = orderChain(list, NOW);
    assert.equal(out.length, 3, "冷却中的 provider 被排序踢掉了");
    assert.ok(out.includes("zen"));
  });

  test("⑤ 只有一个 provider 时原样返回", () => {
    const orderChain = makeOrderChain();
    assert.deepEqual(orderChain(["bai"], NOW), ["bai"]);
    assert.deepEqual(orderChain([], NOW), []);
  });

  test("⑥ 上游真报的余额把「快用完的那家」排到最后（探测信号接进排序了）", () => {
    /* T9 的最后一块：排序除了「我们自己估的预算」，还要看「上游自己报的余额」。
     * 后者是真值，权威：上游说 zen 用了 99/100，zen 就该排到后面。 */
    const orderChain = makeOrderChain({
      cachedProbeOf: (p) => (p === "zen"
        ? { known: true, used: 99, limit: 100, unit: "requests" }
        : { known: true, used: 3, limit: 100, unit: "requests" }),
    });
    const out = orderChain(["zen", "sn"], NOW);
    assert.deepEqual(out, ["sn", "zen"],
      "上游说 zen 用了 99%，它就该排到后面（原来 zen 排在前面）");
  });

  test("⑦ 探不到 ≠ 用完：探不到的那家**不许**被挪到后面", () => {
    /* 这是最容易写反的一条：「探不到」被当成 0% → 排最前；被当成 100% → 排最后。
     * 两种都是把猜测变成行为。正确做法是：没有信号 = 不动。 */
    const orderChain = makeOrderChain({
      cachedProbeOf: (p) => (p === "zen"
        ? { known: false, used: null, limit: null, unit: "unknown", error: "探不到" }
        : null),
    });
    assert.deepEqual(orderChain(["zen", "sn"], NOW), ["zen", "sn"],
      "探不到的那家不该被挪到后面去");
  });

  test("⑧ 缓存里没有这一家 = 没有信号（不许当成 0%）", () => {
    const orderChain = makeOrderChain({ cachedProbeOf: () => null });
    assert.deepEqual(orderChain(["zen", "sn"], NOW), ["zen", "sn"]);
  });

  test("⑨ 探测信号与预算信号取 max（上游的真值压得住我们的估计）", () => {
    /* 预算说 zen 用了 30%，上游说 90% → 按 90% 走（上游是硬事实）。 */
    const orderChain = makeOrderChain({
      budgetStates: () => new Map([["zen", { known: true, usedPct: 30, weightFactor: 0.7, provider: "zen" }]]),
      cachedProbeOf: (p) => (p === "zen"
        ? { known: true, used: 90, limit: 100, unit: "requests" }
        : { known: true, used: 1, limit: 100, unit: "requests" }),
    });
    const out = orderChain(["zen", "sn"], NOW);
    assert.deepEqual(out, ["sn", "zen"], "上游说 zen 用了 90%，它就该排到后面");
  });
});
