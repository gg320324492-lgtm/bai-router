/**
 * scripts/routes-test.mjs —— 路由策略内核（src/server/routes.mjs）
 *
 * ## 这块是什么
 *
 *   magpie 把「一个池子（某供应商的账号/密钥，或某路由组的成员头）按什么顺序试」
 *   抽成一个可注册的策略点：核心自带的只有 Smart，其余由插件注册。
 *   本文件验的是从 magpie 的 internal/routes（Go）移植过来的语义。
 *
 * ## 量纲
 *
 *   Seat.used 是 **0–100 的百分数**，与 Go 版逐字一致（LowShare=90、SpentShare=98）。
 *   magpie 整个配额词汇表都是百分数，本移植跟着走，将来对照阅读不用换算。
 *
 * ## 纪律
 *
 *   ★ **真实现、不注入替身**：策略函数从 src/server/routes.mjs 原样 import 调用。
 *     仓库里 v1.0.76 的教训就是「测试全程注入自己的替身，生产用的函数从没被接进过
 *     测试」——658/658 全绿而生产 100% 是坏的。
 *   ★ **策略不许自己取时间**：整个模块不得调用 Date.now()，时间一律由参数传入。
 *     这条有专门的断言（把 Date.now 换成会抛错的桩，策略仍要跑通）。
 *   ★ **口径错了要当场炸**：Seat 构造器对每个数值字段做范围校验，越界抛错。
 *     口径定错有两个镜像方向（把比例当百分数、把百分数当比例），两者都只会**静默**
 *     算错——分档只在 90/98 两点上分岔，传错了不一定当场看得出，而落到「几乎用尽」
 *     会直接改变请求该走哪个账号。所以让错口径炸在调用方那一侧。
 *   ★ **每条关键断言都配反向对照**：见文件末尾「反向对照」一节——把源码里某个
 *     判定改坏，本文件的断言必须立刻变红，否则说明断言是空的。
 *   ★ **同档/同分/同刻的稳定性**：稳定排序是策略的一部分（保住厂商的 prompt cache），
 *     所以「同条件下保持原序」本身就是一条断言，不只是顺带。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LOW_SHARE, SPENT_SHARE,
  Seat, Strategy,
  Smart, Ordered, Rotate, LeastUsed, Pace, Weighted, FreeFirst, Builtin,
  register, find, served, apply, first, round, moveRound, forgetRound,
} from "../src/server/routes.mjs";

const HOUR = 3600 * 1000;
/** 整点基准：截断到整点的行为在非整点基准上不好读。 */
const T0 = Math.floor(1_700_000_000_000 / HOUR) * HOUR;
const at = (h) => T0 + h * HOUR;

/** 每次用例之前把轮次/轮转状态清干净——它们是模块级的。 */
function reset() { forgetRound(); }

/* ══════════════════════════════════════════════════════════════
 * ① Smart —— 默认策略
 * ══════════════════════════════════════════════════════════════ */

test("Smart：额度有富余的先上，其中续期最早的排最前", () => {
  reset();
  const seats = [
    new Seat({ key: "a", used: 50, soon: [at(2)] }),
    new Seat({ key: "b", used: 50, soon: [at(1)] }),
    new Seat({ key: "c", used: 95, soon: [at(3)] }),
    new Seat({ key: "d", used: 99, soon: [at(4)] }),
  ];
  // b 的额度一小时后就续期（到点白扔），所以先上；a 随后；
  // c 已用 95% 进「低」档、d 已用 99% 进「几乎用尽」档，都排后面。
  assert.deepEqual(apply(Smart, "p", seats, T0), [1, 0, 2, 3]);
});

test("Smart：分档边界——正好 90 进低档，正好 98 进几乎用尽档", () => {
  reset();
  const seats = [
    new Seat({ key: "b2", used: 97.9, soon: [at(5)] }),   // 低档
    new Seat({ key: "b0", used: 89, soon: [at(5)] }),     // 富余档
    new Seat({ key: "b3", used: 98, soon: [at(5)] }),     // 几乎用尽（达到即算）
    new Seat({ key: "b1", used: 90, soon: [at(5)] }),     // 低档（达到即算）
  ];
  // 富余档先；低档内按已用升序（90 < 97.9）；几乎用尽档垫底。
  assert.deepEqual(apply(Smart, "p", seats, T0), [1, 3, 0, 2]);
  assert.equal(LOW_SHARE, 90);
  assert.equal(SPENT_SHARE, 98);
});

test("Smart：额度未知但会自报剩余的（learns）排在同档最前", () => {
  reset();
  const seats = [
    new Seat({ key: "plain", used: 50, soon: [at(1)] }),
    new Seat({ key: "learner", used: 50, learns: true, soon: [at(5)] }),
  ];
  // learner 自己的续期时刻比 plain 晚，但 learns 优先——不然它永远轮不到、
  // 永远学不到额度（Anthropic 的 usage 接口能把 magpie 挡上几小时）。
  assert.deepEqual(apply(Smart, "p", seats, T0), [1, 0]);
});

test("Smart：续期时刻已知的排在未知的前面", () => {
  reset();
  const seats = [
    new Seat({ key: "unknown", used: 50, soon: [] }),
    new Seat({ key: "known", used: 50, soon: [at(9)] }),
  ];
  assert.deepEqual(apply(Smart, "p", seats, T0), [1, 0]);
});

test("Smart：续期时刻截断到整点——同一小时内的先后不算数，保持原序", () => {
  reset();
  // 原始顺序是 later 在前、earlier 在后。截断到整点后两者同刻，
  // 于是稳定排序保持原序（later 仍在前）。若不截断，earlier 会排到前面。
  const seats = [
    new Seat({ key: "later", used: 50, soon: [at(1) + 50 * 60000] }),
    new Seat({ key: "earlier", used: 50, soon: [at(1) + 10 * 60000] }),
  ];
  assert.deepEqual(apply(Smart, "p", seats, T0), [0, 1]);
});

test("Smart：完全同条件的座位保持原序（保住厂商的 prompt cache）", () => {
  reset();
  const seats = [
    new Seat({ key: "x", used: 50, soon: [at(3)] }),
    new Seat({ key: "y", used: 50, soon: [at(3)] }),
    new Seat({ key: "z", used: 50, soon: [at(3)] }),
  ];
  assert.deepEqual(apply(Smart, "p", seats, T0), [0, 1, 2]);
});

test("Smart：不同小时的续期时刻仍按先后排", () => {
  reset();
  const seats = [
    new Seat({ key: "late", used: 50, soon: [at(2)] }),
    new Seat({ key: "early", used: 50, soon: [at(1)] }),
  ];
  assert.deepEqual(apply(Smart, "p", seats, T0), [1, 0]);
});

/* ══════════════════════════════════════════════════════════════
 * ② Ordered / Rotate
 * ══════════════════════════════════════════════════════════════ */

test("Ordered：原序试", () => {
  reset();
  const seats = [new Seat({ key: "a" }), new Seat({ key: "b" }), new Seat({ key: "c" })];
  assert.deepEqual(apply(Ordered, "p", seats, T0), [0, 1, 2]);
  assert.equal(Ordered.exact, true);
});

test("Rotate：每个请求往后挪一格", () => {
  reset();
  const seats = [new Seat({ key: "a" }), new Seat({ key: "b" }), new Seat({ key: "c" })];
  assert.deepEqual(apply(Rotate, "p", seats, T0), [0, 1, 2]);
  assert.deepEqual(apply(Rotate, "p", seats, T0), [1, 2, 0]);
  assert.deepEqual(apply(Rotate, "p", seats, T0), [2, 0, 1]);
  assert.deepEqual(apply(Rotate, "p", seats, T0), [0, 1, 2]);
});

test("Rotate：不同池子各转各的", () => {
  reset();
  const seats = [new Seat({ key: "a" }), new Seat({ key: "b" })];
  assert.deepEqual(apply(Rotate, "p1", seats, T0), [0, 1]);
  assert.deepEqual(apply(Rotate, "p2", seats, T0), [0, 1]);
});

/* ══════════════════════════════════════════════════════════════
 * ③ LeastUsed（usage）
 * ══════════════════════════════════════════════════════════════ */

test("LeastUsed：先按已用比例，再用最近发出的量", () => {
  reset();
  const seats = [
    new Seat({ key: "halfMore", used: 50, tokens: 500 }),
    new Seat({ key: "halfLess", used: 50, tokens: 100 }),
    new Seat({ key: "fresh", used: 20, tokens: 900 }),
  ];
  // fresh 用得最少排第一；两个都用了 50% 时，发出去的量少的排前面。
  assert.deepEqual(apply(LeastUsed, "p", seats, T0), [2, 1, 0]);
});

test("LeastUsed：用量相同时保持原序", () => {
  reset();
  const seats = [
    new Seat({ key: "a", used: 50, tokens: 100 }),
    new Seat({ key: "b", used: 50, tokens: 100 }),
  ];
  assert.deepEqual(apply(LeastUsed, "p", seats, T0), [0, 1]);
});

/* ══════════════════════════════════════════════════════════════
 * ④ Pace
 * ══════════════════════════════════════════════════════════════ */

test("Pace：相差不到 10% 的算同一档，同档内按发出的量排", () => {
  reset();
  const seats = [
    new Seat({ key: "p0", used: 10, pace: 100, tokens: 100 }),
    new Seat({ key: "p1", used: 10, pace: 90, tokens: 5 }),    // 正好 0.9 倍 → 同档
    new Seat({ key: "p2", used: 10, pace: 89, tokens: 1 }),    // 跌破 0.9 倍 → 另起一档
    new Seat({ key: "p3", used: 10, pace: 50, tokens: 1 }),
  ];
  // p0 与 p1 同档（同档内 tokens 少的 p1 在前）；p2 落到第二档、p3 第三档。
  // 若 p1 被误判成另起一档，结果会变成 [p0,p1,…]；若 p2 被误判成同档，
  // tokens=1 的 p2 会插到 p1 前面。两处都红。
  assert.deepEqual(apply(Pace, "p", seats, T0), [1, 0, 2, 3]);
});

test("Pace：额度偏低的座位排到最后，哪怕它的 pace 很高", () => {
  reset();
  const seats = [
    new Seat({ key: "rich", used: 10, pace: 1, tokens: 1 }),
    new Seat({ key: "low", used: 95, pace: 999, tokens: 1 }),
  ];
  assert.deepEqual(apply(Pace, "p", seats, T0), [0, 1]);
});

test("Pace：额度未知但会自报的，在富余档里排最前", () => {
  reset();
  const seats = [
    new Seat({ key: "plain", used: 10, pace: 500, tokens: 1 }),
    new Seat({ key: "learner", used: 10, learns: true, pace: 0, tokens: 1 }),
  ];
  assert.deepEqual(apply(Pace, "p", seats, T0), [1, 0]);
});

/* ══════════════════════════════════════════════════════════════
 * ⑤ Weighted（weight）—— NGINX 平滑加权轮询
 * ══════════════════════════════════════════════════════════════ */

test("Weighted：权重 3 和 1 的轮次次序是 a,a,b,a,a,a,b,a…", () => {
  reset();
  const keys = ["a", "b"];
  const weights = [3, 1];
  const rests = [false, false];
  const got = [];
  for (let i = 0; i < 8; i++) got.push(round("w-pool", keys, weights, rests));
  // magpie 的注释原话就是这个次序：a, a, b, a, a, a, b, a…
  assert.deepEqual(got, [0, 0, 1, 0, 0, 0, 1, 0]);
});

test("Weighted：比例在 16 轮里正好是 3:1", () => {
  reset();
  const keys = ["a", "b"];
  const weights = [3, 1];
  const rests = [false, false];
  const counts = { a: 0, b: 0 };
  for (let i = 0; i < 16; i++) counts[keys[round("w-ratio", keys, weights, rests)]]++;
  assert.deepEqual(counts, { a: 12, b: 4 });
});

test("Weighted：休息中的座位不参与轮次，别的按自己的权重分它那份", () => {
  reset();
  const keys = ["a", "b"];
  const weights = [3, 1];
  const got = [];
  for (let i = 0; i < 4; i++) got.push(round("w-rest", keys, weights, [false, true]));
  assert.deepEqual(got, [0, 0, 0, 0]);
});

test("Weighted：轮次挑中的那个排最前，其余按原序跟在后面", () => {
  reset();
  const seats = [
    new Seat({ key: "a", weight: 3 }),
    new Seat({ key: "b", weight: 1 }),
    new Seat({ key: "c", weight: 1 }),
  ];
  const order = apply(Weighted, "w-order", seats, T0);
  assert.equal(order.length, 3);
  assert.deepEqual([...order].sort((x, y) => x - y), [0, 1, 2], "必须是个排列");
  assert.equal(order[0], 0, "轮次挑中的 a 排最前");
});

test("moveRound：会话亲和把这一轮改记到留下的那个座位上", () => {
  reset();
  const keys = ["a", "b"];
  const weights = [1, 1];
  const rests = [false, false];
  // 没有 moveRound 时，两轮会分别挑 a、b（平手时靠前的先）。
  assert.equal(round("mr", keys, weights, rests), 0);
  assert.equal(round("mr", keys, weights, rests), 1);

  // 做了 moveRound：这一轮算在 b 头上，b 的权重被扣掉，下一轮 a 连续。
  reset();
  assert.equal(round("mr2", keys, weights, rests), 0);
  moveRound("mr2", "a", "b");
  assert.equal(round("mr2", keys, weights, rests), 0, "扣到 b 头上之后，下一轮该是 a");
});

test("moveRound：挑错的、或 kept 不在轮次里，都是空操作", () => {
  reset();
  const keys = ["a", "b"];
  const weights = [1, 1];
  const rests = [false, false];
  assert.equal(round("mr3", keys, weights, rests), 0);
  moveRound("mr3", "b", "a");   // last 是 a，不是 b → 空操作
  assert.equal(round("mr3", keys, weights, rests), 1, "没被 move 走，下一轮仍是 b");
  reset();
  round("mr4", keys, weights, rests);
  moveRound("mr4", "a", "zzz"); // kept 不在轮次里 → 空操作
  assert.equal(round("mr4", keys, weights, rests), 1);
});

/* ══════════════════════════════════════════════════════════════
 * ⑥ FreeFirst
 * ══════════════════════════════════════════════════════════════ */

test("FreeFirst：不花钱的座位先上，其余按原序跟在后面", () => {
  reset();
  const seats = [
    new Seat({ key: "paid1", free: false }),
    new Seat({ key: "free1", free: true }),
    new Seat({ key: "paid2", free: false }),
    new Seat({ key: "free2", free: true }),
  ];
  assert.deepEqual(apply(FreeFirst, "p", seats, T0), [1, 3, 0, 2]);
});

test("FreeFirst：一个都不免费时，行为等同于按序", () => {
  reset();
  const seats = [new Seat({ key: "a" }), new Seat({ key: "b" }), new Seat({ key: "c" })];
  assert.deepEqual(apply(FreeFirst, "p", seats, T0), [0, 1, 2]);
});

test("FreeFirst：只分一档——免费座位不会因为「快用完」被压到付费后面", () => {
  reset();
  const seats = [
    new Seat({ key: "paid", free: false, used: 10 }),
    new Seat({ key: "freeLow", free: true, used: 99 }),
  ];
  assert.deepEqual(apply(FreeFirst, "p", seats, T0), [1, 0]);
});

/* ══════════════════════════════════════════════════════════════
 * ⑦ 注册表
 * ══════════════════════════════════════════════════════════════ */

test("注册表：空串恒为 Smart，没注册过的路由没有策略", () => {
  reset();
  assert.equal(find(""), Smart);
  assert.equal(find("nobody-serves-this"), undefined);
  assert.equal(served(""), true);
  assert.equal(served("nobody-serves-this"), false);
});

test("注册表：同名后注册的先生效，注销后回退到上一个", () => {
  reset();
  const a = new Strategy({ name: "a", order: (_p, s) => s.map((_, i) => i) });
  const b = new Strategy({ name: "b", order: (_p, s) => s.map((_, i) => i) });
  const offA = register("x", a);
  assert.equal(find("x"), a);
  const offB = register("x", b);
  assert.equal(find("x"), b, "后注册的先生效");
  offB();
  assert.equal(find("x"), a, "注销后回退到上一个");
  offA();
  assert.equal(find("x"), undefined);
});

test("注册表：注销函数可以重复调用", () => {
  reset();
  const a = new Strategy({ name: "a", order: (_p, s) => s.map((_, i) => i) });
  const off = register("y", a);
  off();
  off();
  assert.equal(find("y"), undefined);
});

test("Builtin：七种内置路由名都能查到对应的策略", () => {
  reset();
  assert.equal(Builtin.smart, Smart);
  assert.equal(Builtin.order, Ordered);
  assert.equal(Builtin.rotate, Rotate);
  assert.equal(Builtin.usage, LeastUsed);
  assert.equal(Builtin.pace, Pace);
  assert.equal(Builtin.weight, Weighted);
  assert.equal(Builtin.free, FreeFirst);
});

/* ══════════════════════════════════════════════════════════════
 * ⑧ apply 的失败开放
 * ══════════════════════════════════════════════════════════════ */

test("apply：策略给的顺序不合法时退回原序（失败开放，绝不漏掉一条路由）", () => {
  reset();
  const seats = [new Seat({ key: "a" }), new Seat({ key: "b" }), new Seat({ key: "c" })];
  const bad = [
    { order: () => [0, 0, 1] },          // 重复
    { order: () => [0, 2] },             // 长度不对
    { order: () => [0, 1, 5] },          // 越界
    { order: () => [0, -1, 2] },         // 负数
    { order: () => "not an array" },     // 压根不是数组
    { order: () => { throw new Error("炸了"); } }, // 抛异常
    undefined,                            // 没有策略
  ];
  for (const s of bad) {
    assert.deepEqual(apply(s, "p", seats, T0), [0, 1, 2], `策略 ${JSON.stringify(s && s.name)} 应失败开放回原序`);
  }
});

test("apply：把 now 透传给策略", () => {
  reset();
  let seen = null;
  const s = new Strategy({ name: "spy", order: (_p, _seats, now) => { seen = now; return [0]; } });
  apply(s, "p", [new Seat({ key: "a" })], 12345);
  assert.equal(seen, 12345);
});

test("策略不得自己取真实时间（Date.now 被换成会抛错的桩也必须跑得通）", () => {
  reset();
  const real = Date.now;
  Date.now = () => { throw new Error("策略内部不许取真实时间"); };
  try {
    const seats = [
      new Seat({ key: "a", used: 50, soon: [at(2)] }),
      new Seat({ key: "b", used: 50, soon: [at(1)], weight: 3 }),
      new Seat({ key: "c", used: 20, free: true }),
    ];
    for (const s of [Smart, Ordered, LeastUsed, Pace, Weighted, FreeFirst]) {
      apply(s, "p", seats, T0);
    }
    apply(Rotate, "p", seats, T0);
  } finally {
    Date.now = real;
  }
});

/* ══════════════════════════════════════════════════════════════
 * ⑨ Seat 构造器的范围校验 —— 口径错了要当场炸
 *
 * 口径定错有两个镜像方向（把比例当百分数、把百分数当比例），两者都只会**静默**
 * 算错：分档只在 90/98 两点上分岔，传错了不一定当场看得出，而落到「几乎用尽」
 * 会直接改变请求该走哪个账号——错了就是「本来该走的那个账号被跳过」。
 * 所以必须让错口径炸在调用方那一侧，错误消息还得写出期望单位。
 * ══════════════════════════════════════════════════════════════ */

test("Seat.used 越界必须抛错，且错误消息写明期望单位", () => {
  // 传 0.95：调用方本意是「已用 95%」的比例口径，与本模块的百分数口径不符
  assert.throws(() => new Seat({ key: "a", used: 0.95 }), (e) => {
    assert.ok(e instanceof TypeError, "应是 TypeError");
    assert.match(e.message, /Seat\.used/, "要指名是哪个字段");
    assert.match(e.message, /百分数/, "要写明期望单位");
    assert.match(e.message, /100/, "要写明上界");
    assert.match(e.message, /0\.95/, "要把收到的值写出来");
    return true;
  });
  // 传 150：超出百分数上界
  assert.throws(() => new Seat({ key: "a", used: 150 }), (e) => {
    assert.match(e.message, /Seat\.used/);
    assert.match(e.message, /150/);
    return true;
  });
  // 负数与非有限数同样要炸
  assert.throws(() => new Seat({ key: "a", used: -1 }), /Seat\.used/);
  assert.throws(() => new Seat({ key: "a", used: NaN }), /Seat\.used/);
  assert.throws(() => new Seat({ key: "a", used: Infinity }), /Seat\.used/);
  // (0,1) 这一段单独拒绝：0.95 在 [0,100] 里合法，光靠区间抓不住「比例当百分数」
  assert.throws(() => new Seat({ key: "a", used: 0.5 }), /Seat\.used/);
});

test("Seat.used 在 0–100 之内（含端点）不抛错", () => {
  assert.doesNotThrow(() => new Seat({ key: "a", used: 0 }));
  assert.doesNotThrow(() => new Seat({ key: "a", used: 1 }));
  assert.doesNotThrow(() => new Seat({ key: "a", used: 100 }));
  assert.doesNotThrow(() => new Seat({ key: "a", used: 90 }));
  assert.doesNotThrow(() => new Seat({ key: "a", used: 98 }));
  assert.doesNotThrow(() => new Seat({ key: "a", used: 97.9 }));
});

test("Seat 的其它数值字段各有各的范围，越界都抛错", () => {
  assert.throws(() => new Seat({ key: "a", pace: -1 }), /Seat\.pace/);
  assert.throws(() => new Seat({ key: "a", pace: NaN }), /Seat\.pace/);
  assert.throws(() => new Seat({ key: "a", pace: Infinity }), /Seat\.pace/);
  assert.throws(() => new Seat({ key: "a", tokens: -1 }), /Seat\.tokens/);
  assert.throws(() => new Seat({ key: "a", tokens: NaN }), /Seat\.tokens/);
  assert.throws(() => new Seat({ key: "a", weight: 0 }), /Seat\.weight/);
  assert.throws(() => new Seat({ key: "a", weight: -3 }), /Seat\.weight/);
  assert.throws(() => new Seat({ key: "a", weight: NaN }), /Seat\.weight/);
  assert.throws(() => new Seat({ key: "a", soon: [NaN] }), /Seat\.soon\[0\]/);
  assert.throws(() => new Seat({ key: "a", soon: [at(1), Infinity] }), /Seat\.soon\[1\]/);
  assert.throws(() => new Seat({ key: "a", soon: "not an array" }), /Seat\.soon/);
});

test("Seat 的合法取值不抛错（默认字段也是合法的）", () => {
  assert.doesNotThrow(() => new Seat({ key: "a" }));
  assert.doesNotThrow(() => new Seat({ key: "a", used: 50, pace: 3.5, weight: 2, tokens: 1200, soon: [at(1)] }));
});

/* ══════════════════════════════════════════════════════════════
 * 反向对照：把源码里的判定改坏，本文件的断言必须变红
 *
 * 做法：把 src/server/routes.mjs 复制一份到临时目录，改坏其中一处，
 * import 那份副本，重跑关键断言——结果必须与原模块不同。
 * 「不同」即证明上面那些断言不是空的：源码一坏，它们就会红。
 * ══════════════════════════════════════════════════════════════ */

async function sabotage(replacements) {
  const src = readFileSync(new URL("../src/server/routes.mjs", import.meta.url), "utf8");
  let out = src;
  for (const [from, to] of replacements) {
    assert.ok(out.includes(from), `待破坏的片段在源码里找不到：${from}`);
    out = out.replace(from, to);
  }
  const dir = mkdtempSync(join(tmpdir(), "routes-sabotage-"));
  const file = join(dir, "routes.mjs");
  writeFileSync(file, out);
  return import(pathToFileURL(file).href);
}

test("反向对照①：改坏分档阈值（LOW_SHARE 90→10），Smart 的顺序必须变", async () => {
  reset();
  const seats = [
    new Seat({ key: "a", used: 50, soon: [at(2)] }),
    new Seat({ key: "b", used: 50, soon: [at(1)] }),
    new Seat({ key: "c", used: 95, soon: [at(3)] }),
    new Seat({ key: "d", used: 99, soon: [at(4)] }),
  ];
  const good = apply(Smart, "p", seats, T0);

  const bad = await sabotage([["export const LOW_SHARE = 90;", "export const LOW_SHARE = 10;"]]);
  const broken = bad.apply(bad.Smart, "p", seats, T0);
  assert.notDeepEqual(broken, good, "阈值一坏，Smart 的顺序就该不一样——否则上面的断言是空的");
});

test("反向对照②：改坏截断到整点（不再截断），同小时的同刻判定必须失效", async () => {
  reset();
  const seats = [
    new Seat({ key: "later", used: 50, soon: [at(1) + 50 * 60000] }),
    new Seat({ key: "earlier", used: 50, soon: [at(1) + 10 * 60000] }),
  ];
  const good = apply(Smart, "p", seats, T0);

  const bad = await sabotage([["return Math.floor(ms / HOUR_MS) * HOUR_MS;", "return ms;"]]);
  const broken = bad.apply(bad.Smart, "p", seats, T0);
  assert.notDeepEqual(broken, good, "不截断到整点就不再是同刻——否则上面那条断言是空的");
});

test("反向对照③：改坏加权轮询的扣减（不再扣 total），轮次分布必须变", async () => {
  reset();
  const keys = ["a", "b"];
  const weights = [3, 1];
  const rests = [false, false];
  const good = [];
  for (let i = 0; i < 8; i++) good.push(round("sab-w", keys, weights, rests));

  const bad = await sabotage([["r.cur.set(keys[best], r.cur.get(keys[best]) - total);", "/* 不扣减 */"]]);
  const broken = [];
  for (let i = 0; i < 8; i++) broken.push(bad.round("sab-w", keys, weights, rests));
  assert.notDeepEqual(broken, good, "不扣减权重就轮不平——否则上面那条断言是空的");
});

test("反向对照④：改坏「续期时刻已知的先上」，Smart 的顺序必须变", async () => {
  reset();
  const seats = [
    new Seat({ key: "unknown", used: 50, soon: [] }),
    new Seat({ key: "known", used: 50, soon: [at(9)] }),
  ];
  const good = apply(Smart, "p", seats, T0);

  const bad = await sabotage([["return y === 0 ? -1 : 1;", "return y === 0 ? 1 : -1;"]]);
  const broken = bad.apply(bad.Smart, "p", seats, T0);
  assert.notDeepEqual(broken, good, "已知优先这条判反了，顺序就该不一样——否则上面那条断言是空的");
});
