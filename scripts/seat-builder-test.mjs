/* seat-builder 的判据测试。
 *
 * 参照 magpie：internal/gateway/routing.go 的 weighRouted（把候选变成
 * routes.Seat）、internal/provider/routing.go 的 Allowance.For / Renewal / Pace。
 *
 * 全部时刻都是写死的（NOW），**没有一个 Date.now()** —— 座位表里每一项都相对
 * 「现在」算，所以「现在」必须由参数传进来（见 seat-builder.mjs 的硬规矩）。
 *
 * 这套测试要守住的，是那一条最容易写错的规矩：**不知道 ≠ 没有**。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildSeats,
  seatOf,
  signalsOf,
  FRESH_PACE,
} from "../src/server/seat-builder.mjs";
import { makeWindow, fromSignals } from "../src/server/allowance.mjs";
import { makeCandidate, restKeyOf, RestTable } from "../src/server/candidates.mjs";
import { Seat, Builtin, apply } from "../src/server/routes.mjs";

const NOW = 1_700_000_000_000;   // 固定的「现在」，epoch 毫秒
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** 一个带额度的候选。 */
function candWith(allowance, extra = {}) {
  return makeCandidate({
    provider: "wb",
    account: "u1",
    model: "sonnet",
    allowance,
    ...extra,
  });
}

describe("① used 是百分数（0..100），不是比例", () => {
  test("额度已知：用了 95% 就是 95，不是 0.95", () => {
    const c = candWith(makeWindow({ used: 95, limit: 100, resetsAt: NOW + 2 * HOUR }));
    const seat = seatOf(c, { now: NOW });
    assert.equal(seat.used, 95, "Seat.used 是 0–100 的百分数（90 = 用了九成）");
    assert.notEqual(seat.used, 0.95, "绝不能把比例当百分数传：口径错会静默算错路由");
    assert.equal(seat.known, true, "有额度窗口且知道用了多少 → 额度已知");
  });

  test("绝对计数也算成百分数（30/50 = 60%）", () => {
    const c = candWith(makeWindow({ used: 60, amount: 30, limit: 50 }));
    const seat = seatOf(c, { now: NOW });
    assert.equal(seat.used, 60, "QuotaWindow 的 used 本身就是百分数");
  });

  test("原始信号（used+limit）走 fromSignals：30/50 → 60%", () => {
    const c = candWith(null, { allowanceSignals: { used: 30, limit: 50, unit: "credits" } });
    const seat = seatOf(c, { now: NOW });
    assert.equal(seat.used, 60, "信号口径：used 是绝对计数，limit 是总量");
    assert.equal(seat.known, true);
  });
});

describe("② 额度未知 → used 是 0（不是 100），known 是 false", () => {
  test("压根没有额度信号：used=0、known=false", () => {
    const c = makeCandidate({ provider: "wb", account: "u2", model: "sonnet" });
    const seat = seatOf(c, { now: NOW });
    assert.equal(seat.used, 0, "不知道 ≠ 用完了：给 0，不给 100");
    assert.equal(seat.known, false, "额度没读到 → 不知道");
  });

  test("窗口只说了「什么时候重置」而没说用了多少 → 仍然算未知", () => {
    const c = candWith(makeWindow({ resetsAt: NOW + 2 * HOUR }));
    const seat = seatOf(c, { now: NOW });
    assert.equal(seat.used, 0, "只知道重置时刻 ≠ 知道额度");
    assert.equal(seat.known, false);
  });

  test("窗口只对别的模型生效 → 对这个模型仍是未知", () => {
    const c = candWith(makeWindow({ used: 95, model: "opus" }), { model: "sonnet" });
    const seat = seatOf(c, { now: NOW });
    assert.equal(seat.used, 0, "opus 的额度不该算到 sonnet 头上");
    assert.equal(seat.known, false);
    assert.deepEqual(seat.soon, [], "不适用的窗口也不该给 soon");
  });

  test("额度未知但「什么时候能用」知道（本地冷却到期）→ known 仍 false，soon 照样给", () => {
    const c = candWith(fromSignals({ now: NOW, cooldownUntilMs: NOW + 30 * MIN }));
    const seat = seatOf(c, { now: NOW });
    assert.equal(seat.known, false, "配额多少不知道，就是不知道");
    assert.equal(seat.used, 0);
    assert.deepEqual(seat.soon, [NOW + 30 * MIN], "但「冷却到什么时候」是真话，不该被抹掉");
  });
});

describe("③ soon：各窗口的续期时刻，大的窗口在前", () => {
  test("周窗口排在 5 小时窗口前面（magpie：先看周额度）", () => {
    const c = candWith([
      makeWindow({ used: 10, span: WEEK, resetsAt: NOW + 3 * DAY }),
      makeWindow({ used: 20, span: 5 * HOUR, resetsAt: NOW + 2 * HOUR }),
    ]);
    const seat = seatOf(c, { now: NOW });
    assert.deepEqual(seat.soon, [NOW + 3 * DAY, NOW + 2 * HOUR], "大的窗口在前");
  });

  test("同跨度的窗口按续期时刻从晚到早（magpie 的次级排序）", () => {
    const c = candWith([
      makeWindow({ used: 10, span: DAY, resetsAt: NOW + 1 * HOUR }),
      makeWindow({ used: 10, span: DAY, resetsAt: NOW + 5 * HOUR }),
    ]);
    const seat = seatOf(c, { now: NOW });
    assert.deepEqual(seat.soon, [NOW + 5 * HOUR, NOW + 1 * HOUR]);
  });

  test("续期时刻取不到就不进数组（数组里少一项 = 那一层未知）", () => {
    const c = candWith([makeWindow({ used: 10 })]);
    const seat = seatOf(c, { now: NOW });
    assert.deepEqual(seat.soon, [], "没有续期时刻就是没有，不塞占位");
  });

  test("重置已过的窗口按跨度往后推（allowance.renewalOf 的口径）", () => {
    const c = candWith(makeWindow({ used: 90, span: DAY, resetsAt: NOW - HOUR }));
    const seat = seatOf(c, { now: NOW });
    assert.deepEqual(seat.soon, [NOW + DAY], "已经重置过的窗口，下一次重置 = now + 跨度");
  });
});

describe("④ pace：额度未知时按一整周算，不是 0", () => {
  test("完全没有额度信号 → pace = FRESH_PACE（100/168）", () => {
    const c = makeCandidate({ provider: "wb", account: "u3", model: "sonnet" });
    const seat = seatOf(c, { now: NOW });
    assert.equal(seat.pace, FRESH_PACE, "magpie 的 FreshPace：整周还剩 100%");
    assert.ok(seat.pace > 0, "0 会被读成「完全不占」，方向反了");
    assert.equal(seat.pace, 100 / (7 * 24));
  });

  test("只有冷却时刻、额度未知 → 仍是整周（额度未知就是整周）", () => {
    const c = candWith(fromSignals({ now: NOW, cooldownUntilMs: NOW + 30 * MIN }));
    const seat = seatOf(c, { now: NOW });
    assert.equal(seat.pace, FRESH_PACE);
  });

  test("额度已知 → pace = 剩余百分比 ÷ 距续期的小时数", () => {
    // 用了 50%，2 小时后续期 → (100-50)/2 = 25 %/小时
    const c = candWith(makeWindow({ used: 50, limit: 100, resetsAt: NOW + 2 * HOUR }));
    const seat = seatOf(c, { now: NOW });
    assert.equal(seat.pace, 25);
    assert.ok(seat.pace > FRESH_PACE);
  });
});

describe("⑤ resting 由 candidates.isResting 判（两级休息）", () => {
  test("整号休息（restKey 命中）→ resting", () => {
    const c = makeCandidate({ provider: "wb", account: "u4", model: "sonnet" });
    const table = new RestTable();
    table.rest(restKeyOf(c), NOW + 10 * MIN, { kind: "rate", scope: "account" });
    const seat = seatOf(c, { now: NOW, restTable: table });
    assert.equal(seat.resting, true, "整号在休息");
  });

  test("只这个模型休息（restID 命中）→ 也算 resting", () => {
    const c = makeCandidate({ provider: "wb", account: "u5", model: "sonnet" });
    const table = new RestTable();
    table.rest(`${restKeyOf(c)}/sonnet`, NOW + 10 * MIN, { kind: "unserved", scope: "model" });
    const seat = seatOf(c, { now: NOW, restTable: table });
    assert.equal(seat.resting, true, "只休息这个模型 → 这个候选现在也用不了");
  });

  test("休息到期了 → 不算 resting", () => {
    const c = makeCandidate({ provider: "wb", account: "u6", model: "sonnet" });
    const table = new RestTable();
    table.rest(restKeyOf(c), NOW - MIN, { kind: "rate" });
    const seat = seatOf(c, { now: NOW, restTable: table });
    assert.equal(seat.resting, false, "到期即恢复");
  });

  test("没有休息表 → 不算 resting；候选自带 resting 则以候选为准", () => {
    const c = makeCandidate({ provider: "wb", account: "u7", model: "sonnet", resting: true });
    assert.equal(seatOf(c, { now: NOW }).resting, true);
    const c2 = makeCandidate({ provider: "wb", account: "u8", model: "sonnet" });
    assert.equal(seatOf(c2, { now: NOW }).resting, false);
  });
});

describe("⑥ 其它字段的搬运", () => {
  test("key 用休息键、account 是「是不是订阅账号」", () => {
    const c = makeCandidate({ provider: "wb", account: "u9", model: "sonnet" });
    const seat = seatOf(c, { now: NOW });
    assert.equal(seat.key, restKeyOf(c));
    assert.equal(seat.account, true);
    const keyOnly = makeCandidate({ provider: "wb", keyId: "k1", model: "sonnet" });
    assert.equal(seatOf(keyOnly, { now: NOW }).account, false, "API key 不是订阅账号");
  });

  test("weight 至少 1", () => {
    assert.equal(seatOf(makeCandidate({ provider: "p", weight: 0 }), { now: NOW }).weight, 1);
    assert.equal(seatOf(makeCandidate({ provider: "p", weight: 3 }), { now: NOW }).weight, 3);
    assert.equal(seatOf(makeCandidate({ provider: "p" }), { now: NOW }).weight, 1);
  });

  test("tokens 原样搬运（衰减由网关算好，这里不再衰减）", () => {
    const seat = seatOf(makeCandidate({ provider: "p", tokens: 1234 }), { now: NOW });
    assert.equal(seat.tokens, 1234);
  });

  test("free 原样搬运", () => {
    assert.equal(seatOf(makeCandidate({ provider: "p", free: true }), { now: NOW }).free, true);
    assert.equal(seatOf(makeCandidate({ provider: "p" }), { now: NOW }).free, false);
  });

  test("learns：额度未知但会自报剩余的账号（magpie 的 learns）排最前", () => {
    const c = makeCandidate({ provider: "p", account: "u", agent: "claude", model: "sonnet" });
    assert.equal(seatOf(c, { now: NOW }).learns, true);
    const known = makeCandidate({
      provider: "p", account: "u", agent: "claude", model: "sonnet",
      allowance: makeWindow({ used: 10, limit: 100 }),
    });
    assert.equal(seatOf(known, { now: NOW }).learns, false, "额度已知了就不算「在学」");
  });
});

describe("⑦ 喂给 routes.Builtin.smart：顺序符合 magpie 的语义", () => {
  /** 四个候选：会自报的未知号、续期早的号、续期晚的号、额度用尽的号。 */
  function fourSeats() {
    const list = [
      makeCandidate({ provider: "p", account: "learns", agent: "claude", model: "sonnet" }),
      makeCandidate({
        provider: "p", account: "soon", model: "sonnet",
        allowance: makeWindow({ used: 10, limit: 100, resetsAt: NOW + 1 * HOUR }),
      }),
      makeCandidate({
        provider: "p", account: "later", model: "sonnet",
        allowance: makeWindow({ used: 10, limit: 100, resetsAt: NOW + 5 * HOUR }),
      }),
      makeCandidate({
        provider: "p", account: "spent", model: "sonnet",
        allowance: makeWindow({ used: 99, limit: 100, resetsAt: NOW + 5 * HOUR }),
      }),
    ];
    const seats = buildSeats(list, { now: NOW });
    const order = apply(Builtin.smart, "p", seats, NOW);
    return { list, seats, order, keys: order.map((i) => seats[i].key) };
  }

  test("产出的是真座位，且与候选一一对应", () => {
    const { list, seats } = fourSeats();
    assert.equal(seats.length, list.length);
    for (const s of seats) assert.ok(s instanceof Seat);
  });

  test("额度用尽的排最后、续期早的排前面、会自报的排最前", () => {
    const { keys } = fourSeats();
    assert.equal(keys[0], "p@learns", "learns 的账号排最前（magpie 的 cmpSmartFine）");
    assert.equal(keys[1], "p@soon", "续期早的排前面");
    assert.equal(keys[2], "p@later", "续期晚的排后面");
    assert.equal(keys[3], "p@spent", "额度用尽的排最后");
  });

  test("未知额度（used=0）不会被当成「用尽」而排到最后", () => {
    const { seats, keys } = fourSeats();
    const learnsIdx = seats.findIndex((s) => s.key === "p@learns");
    const spentIdx = seats.findIndex((s) => s.key === "p@spent");
    assert.equal(seats[learnsIdx].used, 0);
    assert.ok(keys.indexOf("p@learns") < keys.indexOf("p@spent"),
      "额度未知的号必须排在用尽的号前面");
  });
});

describe("⑧ 反向对照：把「额度未知 → used=0」改成 used=100，测试必须红", () => {
  test("错误实现（未知 → 100）会让顺序翻过来，而本实现不会", () => {
    const list = [
      makeCandidate({ provider: "p", account: "learns", agent: "claude", model: "sonnet" }),
      makeCandidate({
        provider: "p", account: "soon", model: "sonnet",
        allowance: makeWindow({ used: 10, limit: 100, resetsAt: NOW + 1 * HOUR }),
      }),
      makeCandidate({
        provider: "p", account: "spent", model: "sonnet",
        allowance: makeWindow({ used: 99, limit: 100, resetsAt: NOW + 5 * HOUR }),
      }),
    ];

    /* 真实现。 */
    const good = buildSeats(list, { now: NOW });
    const goodOrder = apply(Builtin.smart, "p", good, NOW).map((i) => good[i].key);

    /* 错误实现：只把「额度未知」这一支的 used 从 0 改成 100，
     * 其余照抄 —— 模拟有人手滑把 unknown 当成「用满了」。 */
    const broken = buildSeats(list, { now: NOW }).map((s) => (s.known ? s : { ...s, used: 100 }));
    const brokenOrder = apply(Builtin.smart, "p", broken, NOW).map((i) => broken[i].key);

    /* ① 本实现的断言：未知额度就是 0。 */
    const unknown = good.find((s) => s.key === "p@learns");
    assert.equal(unknown.used, 0, "额度未知 → used=0");

    /* ② 错误实现会让这条断言变红（这就是「测试必须红」的意思）。 */
    const brokenUnknown = broken.find((s) => s.key === "p@learns");
    assert.equal(brokenUnknown.used, 100);
    assert.throws(() => assert.equal(brokenUnknown.used, 0),
      "错误实现必须让「未知 → 0」这条断言红掉");

    /* ③ 而且它确实会改掉路由顺序（所以这条断言不是摆设）。 */
    assert.notDeepEqual(brokenOrder, goodOrder, "把 unknown 当 100 会改变实际路由顺序");
    assert.equal(goodOrder[0], "p@learns", "真实现：未知额度不会被当成用尽");
    assert.equal(brokenOrder[brokenOrder.length - 1], "p@learns",
      "错误实现：未知额度被当成用尽，掉到最后");
  });
});

describe("⑨ signalsOf：把候选上的额度信号收成一份账", () => {
  test("账目：窗口 / known / used / soon / pace 都齐", () => {
    const c = candWith([
      makeWindow({ used: 10, limit: 100, span: WEEK, resetsAt: NOW + 3 * DAY }),
      makeWindow({ used: 20, limit: 100, span: 5 * HOUR, resetsAt: NOW + 2 * HOUR }),
    ]);
    const sig = signalsOf(c, { now: NOW });
    assert.equal(sig.windows.length, 2);
    assert.equal(sig.applicable.length, 2);
    assert.equal(sig.known, true);
    assert.equal(sig.used, 20, "最紧的那条窗口说了算（max used）");
    assert.equal(sig.usedShare, 0.2);
    assert.deepEqual(sig.soon, [NOW + 3 * DAY, NOW + 2 * HOUR]);
    // 额度已知 → pace 算得出：最紧的那条窗口（used=20，2 小时后续期）→ (100-20)/2 = 40
    assert.equal(sig.pace, 40, "额度已知就按剩余百分比摊到续期时刻，不给整周兜底");
  });

  test("一条信号都没有 → empty=true，账目全是「未知」", () => {
    const sig = signalsOf(makeCandidate({ provider: "p", model: "sonnet" }), { now: NOW });
    assert.equal(sig.empty, true);
    assert.equal(sig.known, false);
    assert.equal(sig.used, 0);
    assert.deepEqual(sig.soon, []);
    assert.equal(sig.pace, FRESH_PACE);
  });

  test("now 必填：不给就当场炸（绝不悄悄用 1970 年当现在）", () => {
    assert.throws(() => seatOf(makeCandidate({ provider: "p" }), {}), TypeError);
    assert.throws(() => buildSeats([makeCandidate({ provider: "p" })], {}), TypeError);
  });
});
