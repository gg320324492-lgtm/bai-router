/* 渠道状态计算层（src/server/channel-state.mjs）的口径测试。
 *
 * 这一层是面板改版的第一步（docs/ui-redesign.md 的 P1 地基）：**一个渠道 →
 * 六态之一 + 原因 + 数字**，全局面板都从这一处取。
 *
 * 测的是三件最容易错的事：
 *   ① **优先级是死的**（unconfigured > exhausted > resting > cooling > ok，
 *      unknown 只在没有任何可用信号时才出现）；
 *   ② **「探不到」不是「坏了」**（探不到 ⇒ unknown + 数字是 null，不是红色、
 *      不是 0）；
 *   ③ **缺注入项就是「不知道」**（绝不当成「好」）。
 *
 * 以及一条硬要求：必须包含**反向对照**用例 —— 把实现改坏（写到临时副本 import
 * 进来），证明对应的断言**真的会红**。只会绿的断言等于没写。
 *
 * 时间一律由 ctx.now 注入，本文件不取 Date.now()。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CHANNEL_STATES,
  CHANNEL_STATE_PRIORITY,
  channelState,
  statesOf,
} from "../src/server/channel-state.mjs";

const NOW = 1_700_000_000_000;
const MIN = 60 * 1000;

/* ══════════════════════════════════════════════════════════════════════
 * 夹具
 * ══════════════════════════════════════════════════════════════════════ */

/** 造一个 ctx：默认「什么都不知道」，要什么给什么。 */
function ctxOf(over = {}) {
  return {
    now: NOW,
    nameOf: (p) => (p && p.name) || "",
    busyOf: () => null,
    coolingOf: () => null,
    restingOf: () => null,
    budgetOf: () => null,
    credentialOf: () => null,
    probeOf: () => null,
    ...over,
  };
}

const P = { key: "ds", name: "DeepSeek" };

/** 一家「配好了、没额度预算、没在冷却、没在休息」的家。 */
const GOOD = ctxOf({
  credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
});

/** 一家「探过但读不出来」的家：凭据配好了，但上游读不到数。 */
const PROBE_FAILED = ctxOf({
  credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
  probeOf: () => ({ known: false, used: null, limit: null, resetAtMs: null, error: "上游探不到（超时）" }),
});

/** 预算用完 + 正在休息 + 正在冷却：三个信号同时成立。 */
const ctxThree = ctxOf({
  credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
  budgetOf: () => ({ exhausted: true, used: 2000, limit: 1000, ratio: 100, resetAtMs: NOW + 3600_000 }),
  restingOf: () => ({ resting: true, until: NOW + 15 * MIN, note: "上游额度用尽" }),
  coolingOf: () => ({ cooling: true, until: NOW + 60_000 }),
});

/* ══════════════════════════════════════════════════════════════════════
 * ① 六态清单与返回契约
 * ══════════════════════════════════════════════════════════════════════ */
describe("① 六态清单与返回契约", () => {
  test("①a 恰好六种，顺序如约", () => {
    assert.deepEqual(CHANNEL_STATES, ["ok", "cooling", "resting", "exhausted", "unconfigured", "unknown"]);
    assert.equal(CHANNEL_STATES.length, 6);
    assert.equal(new Set(CHANNEL_STATES).size, 6, "不许有重复");
  });

  test("①b 优先级链是死的：unconfigured > exhausted > resting > cooling > ok", () => {
    assert.deepEqual(
      CHANNEL_STATE_PRIORITY,
      ["unconfigured", "exhausted", "resting", "cooling", "ok"],
      "unknown 不在链上 —— 它是兜底，不是候选"
    );
  });

  test("①c 返回对象的字段与类型", () => {
    const s = channelState(P, GOOD);
    assert.equal(s.key, "ds");
    assert.equal(s.name, "DeepSeek");
    assert.equal(s.state, "ok");
    assert.equal(typeof s.reason, "string");
    assert.ok(s.reason.length > 0, "reason 必须是能给人看的一句话");
    assert.equal(s.busy, null);
    assert.equal(s.used, null);
    assert.equal(s.limit, null);
    assert.equal(s.ratio, null);
    assert.equal(typeof s.detail, "object");
  });

  test("①d 任何输入下 state 都落在六态里", () => {
    const ctxs = [
      {},
      GOOD,
      PROBE_FAILED,
      ctxThree,
      ctxOf({ credentialOf: () => ({ configured: false, missing: "API Key", accounts: [] }) }),
      ctxOf({ busyOf: () => 3 }),
    ];
    for (const c of ctxs) {
      for (const p of [P, { key: "x" }, {}, null]) {
        const st = channelState(p, c).state;
        assert.ok(CHANNEL_STATES.includes(st), `state=${st} 不在六态里`);
      }
    }
  });

  test("①e 显示名优先用 ctx.nameOf，其次 provider.name，最后退回 id", () => {
    assert.equal(channelState({ key: "a", name: "A 家" }, ctxOf({ nameOf: () => "注入名" })).name, "注入名");
    assert.equal(channelState({ key: "a", name: "A 家" }, ctxOf({ nameOf: () => "" })).name, "A 家");
    assert.equal(channelState({ key: "a" }, ctxOf({ nameOf: () => "" })).name, "a");
    assert.equal(channelState({ key: "a" }, ctxOf({ nameOf: () => { throw new Error("x"); } })).name, "a");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ② 优先级（钉死）
 * ══════════════════════════════════════════════════════════════════════ */
describe("② 优先级 —— 同时成立时谁赢", () => {
  test("②a 没配上压过一切（连预算用完、休息、冷却都压不住）", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: false, missing: "API Key", accounts: [] }),
      budgetOf: () => ({ exhausted: true, used: 10, limit: 10, ratio: 100, resetAtMs: 0 }),
      restingOf: () => ({ resting: true, until: NOW + MIN, note: "上游额度用尽" }),
      coolingOf: () => ({ cooling: true, until: NOW + MIN }),
    });
    const s = channelState(P, c);
    assert.equal(s.state, "unconfigured", "没配上的家谈不上休息或冷却");
    assert.match(s.reason, /API Key/, "reason 要说清缺什么");
    assert.equal(s.detail.credential.configured, false);
    assert.equal(s.detail.credential.missing, "API Key");
  });

  test("②b 预算用完压过休息中（更具体的原因压更笼统的容器）", () => {
    const s = channelState(P, ctxThree);
    assert.equal(s.state, "exhausted");
    assert.equal(s.used, 2000, "数字必须跟着结论走 —— 说预算用完了就显示预算的数");
    assert.equal(s.limit, 1000);
    assert.equal(s.ratio, 100);
  });

  test("②c 休息中压过冷却中（长的那个说了算）", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      restingOf: () => ({ resting: true, until: NOW + 15 * MIN, note: "上游额度用尽" }),
      coolingOf: () => ({ cooling: true, until: NOW + MIN }),
    });
    const s = channelState(P, c);
    assert.equal(s.state, "resting");
    assert.equal(s.detail.resting.note, "上游额度用尽");
    assert.equal(s.detail.resting.until, NOW + 15 * MIN);
    assert.equal(s.detail.cooling, undefined, "被压住的那个不是结论，不进 detail");
  });

  test("②d 冷却中压过可用", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      coolingOf: () => ({ cooling: true, until: NOW + MIN }),
    });
    const s = channelState(P, c);
    assert.equal(s.state, "cooling");
    assert.equal(s.detail.cooling.until, NOW + MIN);
  });

  test("②e 没有任何负面信号 ⇒ ok", () => {
    assert.equal(channelState(P, GOOD).state, "ok");
  });

  test("②f 什么都没有 ⇒ unknown（兜底，不是候选）", () => {
    const s = channelState(P, ctxOf({}));
    assert.equal(s.state, "unknown");
    assert.equal(s.used, null);
    assert.equal(s.limit, null);
    assert.equal(s.ratio, null);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ③ 探不到 ≠ 坏了
 * ══════════════════════════════════════════════════════════════════════ */
describe("③ 「探不到」与「坏了」必须分开", () => {
  test("③a 探过读不出来 ⇒ unknown，不是 exhausted、不是 resting", () => {
    const s = channelState(P, PROBE_FAILED);
    assert.equal(s.state, "unknown", "探不到不是坏了");
    assert.notEqual(s.state, "exhausted");
    assert.notEqual(s.state, "resting");
    assert.match(s.reason, /探不到/, "reason 要说清是「探不到」");
  });

  test("③b 探不到时数字全是 null（面板显示「—」），绝不拿 0 顶替", () => {
    const s = channelState(P, PROBE_FAILED);
    assert.equal(s.used, null);
    assert.equal(s.limit, null);
    assert.equal(s.ratio, null);
  });

  test("③c 「压根没有探测源」不是失败 —— probe 为 null 时仍算可用", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      probeOf: () => null,
    });
    assert.equal(channelState(P, c).state, "ok",
      "大多数家没有额度接口，不能因此全变 unknown");
  });

  test("③d 有在途请求 ⇒ 它这会儿就在服务，探不到也压不过这个事实", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      probeOf: () => ({ known: false, used: null, limit: null, resetAtMs: null, error: "读不到" }),
      busyOf: () => 2,
    });
    const s = channelState(P, c);
    assert.equal(s.state, "ok");
    assert.equal(s.busy, 2);
  });

  test("③e 探到了 ⇒ ok，数字取上游报的那一套", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      probeOf: () => ({ known: true, used: 10, limit: 100, resetAtMs: NOW + 3600_000, error: null }),
    });
    const s = channelState(P, c);
    assert.equal(s.state, "ok");
    assert.equal(s.used, 10);
    assert.equal(s.limit, 100);
    assert.equal(s.ratio, 10);
  });

  test("③f 没配上时，探不到也不改变结论（没配上是更重的那条）", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: false, missing: null, accounts: [] }),
      probeOf: () => ({ known: false, used: null, limit: null, resetAtMs: null, error: "读不到" }),
    });
    assert.equal(channelState(P, c).state, "unconfigured");
  });

  test("③g 预算用完时，探不到也不改变结论（exhausted 压 unknown）", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      budgetOf: () => ({ exhausted: true, used: 10, limit: 10, ratio: 100, resetAtMs: 0 }),
      probeOf: () => ({ known: false, used: null, limit: null, resetAtMs: null, error: "读不到" }),
    });
    assert.equal(channelState(P, c).state, "exhausted");
  });

  test("③h 探到的数是上游的权威值，压过账本估的预算数（但 budget 仍留在证据里）", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      budgetOf: () => ({ exhausted: false, used: 50, limit: 100, ratio: 50, resetAtMs: NOW }),
      probeOf: () => ({ known: true, used: 10, limit: 100, resetAtMs: NOW + 3600_000, error: null }),
    });
    const s = channelState(P, c);
    assert.equal(s.used, 10, "上游报的是硬事实");
    assert.equal(s.limit, 100);
    assert.equal(s.ratio, 10);
    assert.equal(s.detail.budget.used, 50, "我们估的那套不丢，留在 detail 里");
    assert.equal(s.detail.budget.ratio, 50);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ④ 数字不许编造
 * ══════════════════════════════════════════════════════════════════════ */
describe("④ 数字：读不到就是 null", () => {
  test("④a 没有任何额度来源 ⇒ 三个数字全是 null", () => {
    const s = channelState(P, GOOD);
    assert.equal(s.used, null);
    assert.equal(s.limit, null);
    assert.equal(s.ratio, null);
  });

  test("④b 「配了预算但还没花」是 0，不是 null（0 是合法读数）", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      budgetOf: () => ({ exhausted: false, used: 0, limit: 1000, ratio: 0, resetAtMs: NOW }),
    });
    const s = channelState(P, c);
    assert.equal(s.used, 0, "0 ≠ 不知道");
    assert.equal(s.limit, 1000);
    assert.equal(s.ratio, 0);
  });

  test("④c limit 为 0 视为「没设预算」（quota.mjs 的口径），不是「上限为零」", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      budgetOf: () => ({ exhausted: false, used: 0, limit: 0, ratio: 0, resetAtMs: 0 }),
    });
    const s = channelState(P, c);
    assert.equal(s.limit, null, "显示「0 / 0」会被读成「用完了」");
    assert.equal(s.used, null);
    assert.equal(s.ratio, null);
    assert.equal(s.detail.budget, undefined, "没设预算就没有预算这一格");
  });

  test("④d 预算没探到（known:false）同样不当成预算", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      budgetOf: () => ({ known: false, exhausted: false, used: 0, limit: 0, ratio: 0, resetAtMs: 0 }),
    });
    const s = channelState(P, c);
    assert.equal(s.used, null);
    assert.equal(s.limit, null);
  });

  test("④e ratio 是百分比并夹在 0–100（量条只画得下 0–100）", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      probeOf: () => ({ known: true, used: 200, limit: 100, resetAtMs: null, error: null }),
    });
    const s = channelState(P, c);
    assert.equal(s.ratio, 100, "超了也夹到 100");
    assert.equal(s.used, 200, "原始数不夹 —— 夹了就把「超了一倍」这件事抹掉了");
  });

  test("④f limit 缺失时算不出比例（不是 0%）", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      probeOf: () => ({ known: true, used: 200, limit: null, resetAtMs: null, error: null }),
    });
    const s = channelState(P, c);
    assert.equal(s.ratio, null);
    assert.equal(s.used, 200);
  });

  test("④g 在途数读不到就是 null，0 是「没有在途」", () => {
    assert.equal(channelState(P, GOOD).busy, null);
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      busyOf: () => 0,
    });
    assert.equal(channelState(P, c).busy, 0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 缺注入项 = 「不知道」
 * ══════════════════════════════════════════════════════════════════════ */
describe("⑤ 缺注入项就是不知道，绝不当成好", () => {
  test("⑤a ctx 整个是空的 ⇒ unknown + 全 null", () => {
    const s = channelState(P, {});
    assert.equal(s.state, "unknown");
    assert.equal(s.used, null);
    assert.equal(s.limit, null);
    assert.equal(s.ratio, null);
    assert.equal(s.busy, null);
  });

  test("⑤b 只有凭据这一项 ⇒ ok（配上了就是配上了）", () => {
    const c = { credentialOf: () => ({ configured: true }) };
    assert.equal(channelState(P, c).state, "ok");
  });

  test("⑤c 注入项抛异常不许掀桌子 —— 降级成「不知道」", () => {
    const c = ctxOf({
      credentialOf: () => { throw new Error("读配置炸了"); },
      probeOf: () => { throw new Error("探上游炸了"); },
    });
    const s = channelState(P, c);
    assert.equal(s.state, "unknown");
    assert.equal(s.used, null);
  });

  test("⑤d 注入项抛异常时，别的信号照样算数", () => {
    const c = ctxOf({
      credentialOf: () => { throw new Error("炸了"); },
      busyOf: () => 4,
    });
    const s = channelState(P, c);
    assert.equal(s.state, "ok", "有在途请求就是有在途请求");
    assert.equal(s.busy, 4);
  });

  test("⑤e 没有 ctx.now ⇒ 信调用方的冷却判定，不自己瞎判", () => {
    const c = {
      now: undefined,
      credentialOf: () => ({ configured: true }),
      coolingOf: () => ({ cooling: true, until: NOW + MIN }),
    };
    assert.equal(channelState(P, c).state, "cooling");
  });

  test("⑤f 冷却早已到期 ⇒ 不算冷却（调用方的布尔可能是上一轮留下的陈旧值）", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      coolingOf: () => ({ cooling: true, until: NOW - 1000 }),
    });
    assert.equal(channelState(P, c).state, "ok");
  });

  test("⑤g until 为 0 视为「没有到期时间」，不是「1970 年就到期了」", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      coolingOf: () => ({ cooling: true, until: 0 }),
    });
    assert.equal(channelState(P, c).state, "cooling");
  });

  test("⑤h 休息同样按 now 复核到期", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true, missing: null, accounts: [] }),
      restingOf: () => ({ resting: true, until: NOW - 1, note: "上游额度用尽" }),
    });
    assert.equal(channelState(P, c).state, "ok");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ reason 与 detail
 * ══════════════════════════════════════════════════════════════════════ */
describe("⑥ reason 与 detail（面板拿什么渲染）", () => {
  test("⑥a 每个态都有一句人话", () => {
    const cases = [
      [GOOD, "ok"],
      [ctxOf({ credentialOf: () => ({ configured: true }), coolingOf: () => ({ cooling: true, until: NOW + MIN }) }), "cooling"],
      [ctxOf({ credentialOf: () => ({ configured: true }), restingOf: () => ({ resting: true, until: NOW + MIN, note: "令牌过期" }) }), "resting"],
      [ctxOf({ credentialOf: () => ({ configured: true }), budgetOf: () => ({ exhausted: true, used: 1, limit: 1, ratio: 100, resetAtMs: 0 }) }), "exhausted"],
      [ctxOf({ credentialOf: () => ({ configured: false, missing: "登录态失效" }) }), "unconfigured"],
      [PROBE_FAILED, "unknown"],
    ];
    for (const [c, want] of cases) {
      const s = channelState(P, c);
      assert.equal(s.state, want);
      assert.equal(typeof s.reason, "string");
      assert.ok(s.reason.trim().length > 0, `${want} 的 reason 不能是空的`);
    }
  });

  test("⑥b reason 不含倒计时（会每帧重排），时刻放在 detail 里", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true }),
      coolingOf: () => ({ cooling: true, until: NOW + 42_000 }),
    });
    const s = channelState(P, c);
    assert.ok(!/42/.test(s.reason), "reason 里不该出现秒数");
    assert.equal(s.detail.cooling.until, NOW + 42_000);
  });

  test("⑥c 休息的 note 进 reason 与 detail", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true }),
      restingOf: () => ({ resting: true, until: NOW + MIN, note: "上游额度用尽" }),
    });
    const s = channelState(P, c);
    assert.match(s.reason, /上游额度用尽/);
    assert.equal(s.detail.resting.note, "上游额度用尽");
  });

  test("⑥d detail.budget 带齐四个数与重置时刻", () => {
    const c = ctxOf({
      credentialOf: () => ({ configured: true }),
      budgetOf: () => ({ exhausted: false, used: 5, limit: 10, ratio: 50, resetAtMs: NOW + 3600_000 }),
    });
    const s = channelState(P, c);
    assert.deepEqual(s.detail.budget, {
      exhausted: false, used: 5, limit: 10, ratio: 50, resetAtMs: NOW + 3600_000,
    });
  });

  test("⑥e detail.credential 如实反映注入（configured 读不出来就是 null，不是 false）", () => {
    const s1 = channelState(P, ctxOf({ credentialOf: () => ({ configured: true, missing: null, accounts: ["a"] }) }));
    assert.equal(s1.detail.credential.configured, true);
    assert.deepEqual(s1.detail.credential.accounts, ["a"]);

    const s2 = channelState(P, ctxOf({ credentialOf: () => ({ missing: "x" }) }));
    assert.equal(s2.detail.credential.configured, null, "没告诉我 ≠ 没配");
  });

  test("⑥f 没有凭据信息时，detail 里不出现 credential 这一格", () => {
    const s = channelState(P, ctxOf({}));
    assert.equal(s.detail.credential, undefined);
    assert.equal(s.detail.budget, undefined);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ statesOf
 * ══════════════════════════════════════════════════════════════════════ */
describe("⑦ statesOf —— 一批渠道一张表", () => {
  test("⑦a 按 id 索引，值与 channelState 逐字一致", () => {
    const providers = [
      { key: "ds", name: "DeepSeek" },
      { key: "kimi", name: "Kimi" },
    ];
    const c = ctxOf({
      credentialOf: (p) => ({ configured: p.key !== "kimi", missing: p.key === "kimi" ? "API Key" : null, accounts: [] }),
    });
    const all = statesOf(providers, c);
    assert.deepEqual(Object.keys(all).sort(), ["ds", "kimi"]);
    assert.deepEqual(all.ds, channelState(providers[0], c));
    assert.deepEqual(all.kimi, channelState(providers[1], c));
    assert.equal(all.kimi.state, "unconfigured");
    assert.equal(all.ds.state, "ok");
  });

  test("⑦b 不是数组 ⇒ 空表（不炸）", () => {
    assert.deepEqual(statesOf(null, GOOD), {});
    assert.deepEqual(statesOf(undefined, GOOD), {});
    assert.deepEqual(statesOf("x", GOOD), {});
  });

  test("⑦c 拿不到 id 的条目用下标占位，不静默丢掉一家", () => {
    const all = statesOf([{ name: "没 id 的" }], GOOD);
    assert.equal(Object.keys(all).length, 1);
    assert.equal(all["0"].key, "0");
  });

  test("⑦d 同一家在各处取到的状态必然一致（原则 1 的守门人）", () => {
    const providers = [{ key: "a" }, { key: "b" }, { key: "c" }];
    const c = ctxOf({
      credentialOf: (p) => ({ configured: p.key !== "c" }),
      coolingOf: (p) => ({ cooling: p.key === "b", until: NOW + MIN }),
    });
    const all = statesOf(providers, c);
    for (const p of providers) {
      assert.equal(all[p.key].state, channelState(p, c).state);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 反向对照：把实现改坏，②③④ 必须红
 * ══════════════════════════════════════════════════════════════════════ */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "server", "channel-state.mjs");
const TMP = [];

/** 把源码改坏，写到临时副本里 import 进来 —— 改坏的必须是**同一份代码**，
 *  否则证明不了生产跑的那一份真的依赖这条判据。 */
async function loadMutant(mutate) {
  const src = readFileSync(SRC, "utf8");
  const out = mutate(src);
  assert.notEqual(out, src, "变异没有改到源码 —— 锚点过期了（实现改了，这里也要跟着改）");
  const dir = mkdtempSync(join(tmpdir(), "channel-state-mutant-"));
  TMP.push(dir);
  const file = join(dir, "mutant.mjs");
  writeFileSync(file, out, "utf8");
  return await import(pathToFileURL(file).href);
}

process.on("exit", () => {
  for (const d of TMP) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录随系统清理也行 */ }
  }
});

describe("⑧ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  test("⑧a 把 exhausted 与 resting 的优先级对调 ⇒ ②b 会红", async () => {
    const mod = await loadMutant((s) => s.replace(
      'export const CHANNEL_STATE_PRIORITY = ["unconfigured", "exhausted", "resting", "cooling", "ok"];',
      'export const CHANNEL_STATE_PRIORITY = ["unconfigured", "resting", "exhausted", "cooling", "ok"];'
    ));
    const assertExhaustedWins = (m) => {
      const st = m.channelState(P, ctxThree);
      assert.equal(st.state, "exhausted");
    };
    assertExhaustedWins(await import("../src/server/channel-state.mjs"));
    assert.throws(() => assertExhaustedWins(mod), "改坏后这条断言必须红 —— 否则 ②b 是摆设");
  });

  test("⑧b 把 unconfigured 降到 exhausted 之下 ⇒ ②a 会红", async () => {
    const mod = await loadMutant((s) => s.replace(
      'export const CHANNEL_STATE_PRIORITY = ["unconfigured", "exhausted", "resting", "cooling", "ok"];',
      'export const CHANNEL_STATE_PRIORITY = ["exhausted", "unconfigured", "resting", "cooling", "ok"];'
    ));
    const c = ctxOf({
      credentialOf: () => ({ configured: false, missing: "API Key", accounts: [] }),
      budgetOf: () => ({ exhausted: true, used: 10, limit: 10, ratio: 100, resetAtMs: 0 }),
    });
    const assertUnconfiguredWins = (m) => {
      assert.equal(m.channelState(P, c).state, "unconfigured");
    };
    assertUnconfiguredWins(await import("../src/server/channel-state.mjs"));
    assert.throws(() => assertUnconfiguredWins(mod), "改坏后这条断言必须红 —— 否则 ②a 是摆设");
  });

  test("⑧c 把「有正面证据」判死（hasLiveness 恒假）⇒ ②e 会红", async () => {
    const mod = await loadMutant((s) => s.replace(
      "const hasLiveness = busyLive || probeKnown || (credOk && !probeFailed);",
      "const hasLiveness = false;"
    ));
    const assertOk = (m) => {
      assert.equal(m.channelState(P, GOOD).state, "ok");
    };
    assertOk(await import("../src/server/channel-state.mjs"));
    assert.throws(() => assertOk(mod), "改坏后这条断言必须红 —— 否则 ②e 是摆设");
  });

  test("⑧d 把「读不到」的数字从 null 换成 0 ⇒ ④a 会红", async () => {
    const mod = await loadMutant((s) => s.replace(
      "const UNKNOWN_NUM = null;",
      "const UNKNOWN_NUM = 0;"
    ));
    const assertNulls = (m) => {
      const st = m.channelState(P, GOOD);
      assert.equal(st.used, null, "探不到必须是 null —— 0 会被面板读成「用完了」");
      assert.equal(st.limit, null);
      assert.equal(st.ratio, null);
    };
    assertNulls(await import("../src/server/channel-state.mjs"));
    assert.throws(() => assertNulls(mod), "改坏后这条断言必须红 —— 否则 ④a 是摆设");
  });

  test("⑧e 把「探过读不出来」也算成可用 ⇒ ③a 会红", async () => {
    const mod = await loadMutant((s) => s.replace(
      "const hasLiveness = busyLive || probeKnown || (credOk && !probeFailed);",
      "const hasLiveness = busyLive || probeKnown || credOk;"
    ));
    const assertUnknown = (m) => {
      assert.equal(m.channelState(P, PROBE_FAILED).state, "unknown");
    };
    assertUnknown(await import("../src/server/channel-state.mjs"));
    assert.throws(() => assertUnknown(mod), "改坏后这条断言必须红 —— 否则 ③a 是摆设");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑨ 硬规矩：零 import、零时钟、零 IO
 * ══════════════════════════════════════════════════════════════════════ */
describe("⑨ 模块纪律", () => {
  test("⑨a 源码里不得出现 Date.now / new Date（时间一律由 ctx.now 注入）", () => {
    const src = readFileSync(SRC, "utf8");
    // 先把注释剥掉：注释里写着「不调 Date.now」是规矩本身，不是犯规。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/Date\s*\.\s*now/.test(code),
      "channel-state.mjs 内部取了真实时钟：同一份结论就没法被回放、被测试了");
    assert.ok(!/new\s+Date/.test(code),
      "内部 new Date 也是取真实时钟：倒计时的格式化是面板的事");
  });

  test("⑨b 零 import：不许依赖仓库任何模块，也不许碰 node 内置模块", () => {
    const src = readFileSync(SRC, "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, [],
      "一个依赖都不许有：多一个依赖就多一份「它到底改没改」的疑问");
    assert.ok(!/require\(/.test(code), "不许用 require 绕开 import 检查");
    assert.ok(!/node:/.test(code), "不许碰 node 内置模块（fs / path 那些）");
    assert.ok(!/\bfs\.|\bpath\.|\bprocess\.|\bglobalThis\./.test(code), "不许有 IO 或全局副作用");
  });
});
