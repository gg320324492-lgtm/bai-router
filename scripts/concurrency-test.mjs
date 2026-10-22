/**
 * scripts/concurrency-test.mjs —— 每家渠道的「同时在途」上限
 * （src/server/concurrency.mjs）
 *
 * ## 这份测试在守什么
 *
 * 这个模块补的洞是：bai-router 只有「谁失败了换一家」，**没有「同时最多发几个」
 * 的闸门**。缺了它，上游按账号/并发限流时我们看不见也管不着 —— 表现是随机的
 * 429 / 半路断连，而面板上什么都看不出来。
 *
 * 它守四件事：
 *   ① **上限真的挡得住**：占用数、上限、排队数都要如实报出来。
 *   ② **排队与拒绝要分得清**（magpie 的 lanes.take 三种结局）：立刻拿到 /
 *      排队等 / 当场拒（队列满、等超时、快失败模式）。magpie 原话
 *      "Waiting is not failing" —— 排队不算失败。
 *   ③ **释放必须可靠**（本模块最要紧的一条）：漏一次 = 永久占一个坑 =
 *      这一家从此发不出请求，而面板上看不出来。所以要验：幂等、异常也还、
 *      外部能还、泄漏兜底能收。
 *   ④ **内部绝不取真实时间**：Date.now 换成会抛错的桩也必须跑得通。
 *
 * ## 纪律
 *   ★ **时间与计时器都注入**：opts.now 给时刻，opts.timer 给计时器，
 *     测试用一个假时钟把时间**逐字**推进，所以「等了 61 秒」这种断言是精确的。
 *   ★ **不 import 仓库其它模块**：本模块必须能单独跑测试。
 *   ★ **每条关键断言都配反向对照**：见文件末尾「反向对照」一节 —— 把源码里
 *     某个判定改坏，本文件的断言必须立刻变红，否则说明断言是空的。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ConcurrencyLimiter,
  REASON_FAST_REJECT,
  REASON_QUEUE_FULL,
  REASON_WAIT_TIMEOUT,
  REASON_ABORTED,
  DEFAULT_WAIT_MS,
  NO_WAIT_BOUND,
} from "../src/server/concurrency.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "src/server/concurrency.mjs");
const MODULE_SRC = fs.readFileSync(MODULE_PATH, "utf8");

const T0 = 1_700_000_000_000;

/** 让微任务跑完（promise 的续体）。 */
const tick = () => new Promise((r) => setImmediate(r));

/**
 * 假时钟：时刻与计时器都在我们手里，所以「等了 61 秒」能逐字断言。
 *
 * ⚠ 为什么连**计时器**都要注入：模块内部要计时（排队等多久就超时），
 *    用真 setTimeout 就得靠 sleep 等真实时间，测试既慢又不确定。
 */
function fakeClock(start = T0) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    timer(ms, fn) {
      const h = { at: t + ms, fn, cancelled: false };
      timers.push(h);
      return {
        cancel() {
          h.cancelled = true;
        },
      };
    },
    /** 推进时间并把到点的计时器打掉。 */
    async advance(ms) {
      t += ms;
      const due = timers.filter((h) => !h.cancelled && h.at <= t).sort((a, b) => a.at - b.at);
      for (const h of due) {
        h.cancelled = true;
        h.fn();
      }
      await tick();
    },
    get time() {
      return t;
    },
  };
}

/* ========================================================================== *
 * ① 上限：占用数与放行
 * ========================================================================== */

describe("① 上限 —— 占用数 / 上限 / 放行", () => {
  test("①a limit=2：两个立刻拿到，第三个排队", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 2 });
    const a = await c.acquire("sn");
    const b = await c.acquire("sn");
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);

    const p = c.acquire("sn");           // 第三个 → 排队
    await tick();

    const s = c.stats("sn");
    assert.equal(s.limit, 2, "上限要如实报出来");
    assert.equal(s.busy, 2, "占用数 = 2");
    assert.equal(s.waiting, 1, "第三个在排队");
    assert.equal(s.inflight, 2, "在途总数只算占着名额的（第三个还没拿到名额）");

    a.release();
    b.release();
    const third = await p;
    assert.equal(third.ok, true, "有名额释放就该轮到它");
    third.release();
    assert.equal(c.stats("sn").busy, 0);
  });

  test("①b limit=0 = 不限：busy 恒 0，但在途总数要记着", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 0 });
    const a = await c.acquire("sn");
    const b = await c.acquire("sn");
    const s = c.stats("sn");
    assert.equal(s.limit, 0);
    assert.equal(s.busy, 0, "不限额就不占名额（magpie: limit<=0 takes no slot）");
    assert.equal(s.inflight, 2, "但在途总数要记着 —— 面板要看「现在有几个在飞」");
    a.release();
    b.release();
    assert.equal(c.stats("sn").inflight, 0);
  });

  test("①c 每条 key 各算各的（粒度 = key/账号，不是供应商级）", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    const a = await c.acquire("sn@u1");
    const r = await c.acquire("sn@u2");
    assert.equal(r.ok, true, "另一个 key 有自己的名额，不该被 sn@u1 占着");
    assert.equal(c.stats("sn@u1").busy, 1);
    assert.equal(c.stats("sn@u2").busy, 1);
    a.release();
    r.release();
  });

  test("①d free()：还有空位才算 free（magpie 的 lanes.free）", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    assert.equal(c.free("sn"), true);
    const a = await c.acquire("sn");
    assert.equal(c.free("sn"), false, "占满了就不 free");
    a.release();
    assert.equal(c.free("sn"), true);
  });

  test("①e 有人排队时不算 free（magpie: busy<limit && len(queue)==0）", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    const a = await c.acquire("sn");
    const p = c.acquire("sn");
    await tick();
    assert.equal(c.free("sn"), false, "前面有人在等，就不该把新请求塞进去");
    a.release();
    (await p).release();
  });
});

/* ========================================================================== *
 * ② 排队：先来先服务
 * ========================================================================== */

describe("② 排队 —— 先来先服务（magpie 的 lanes.grant）", () => {
  test("②a 先排队的先拿到名额", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    const first = await c.acquire("sn");
    const order = [];
    const p2 = c.acquire("sn").then((r) => { order.push("second"); return r; });
    const p3 = c.acquire("sn").then((r) => { order.push("third"); return r; });
    await tick();
    assert.equal(c.stats("sn").waiting, 2);

    first.release();
    const second = await p2;
    await tick();
    assert.deepEqual(order, ["second"], "第二个请求先拿到名额 —— 排队是先来先服务");
    assert.equal(c.stats("sn").busy, 1);

    second.release();
    const third = await p3;
    assert.deepEqual(order, ["second", "third"]);
    third.release();
  });

  test("②b 排队不算失败（magpie: waiting is not failing）", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    const a = await c.acquire("sn");
    const p = c.acquire("sn");
    await tick();
    const s = c.stats("sn");
    assert.equal(s.queued, 1, "排队要单独记账");
    assert.equal(s.rejected, 0, "排队中的请求**不算被拒** —— 它还在等，不是失败");
    a.release();
    (await p).release();
  });

  test("②c 等到了要报出等了多久", async () => {
    const clock = fakeClock();
    const c = new ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    const a = await c.acquire("sn");
    const p = c.acquire("sn");
    await tick();
    await clock.advance(4200);
    a.release();
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(r.waited, 4200, "等了多久要能逐字断言");
    r.release();
  });

  test("②d 客户端走了 → 排队的人离开队列（magpie 的 ctx.Done()）", async () => {
    const clock = fakeClock();
    const c = new ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    const a = await c.acquire("sn");
    const ac = new AbortController();
    const p = c.acquire("sn", { signal: ac.signal });
    await tick();
    assert.equal(c.stats("sn").waiting, 1);
    ac.abort();
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASON_ABORTED);
    const s = c.stats("sn");
    assert.equal(s.waiting, 0, "走掉的那个必须离开队列 —— 否则它白占一个队列位置");
    assert.equal(s.aborted, 1);
    assert.equal(s.rejected, 0, "客户端自己走的**不算被拒** —— 那不是这家的问题");
    a.release();
  });

  test("②e 已经走掉的客户端连队都不用排", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    const ac = new AbortController();
    ac.abort();
    const r = await c.acquire("sn", { signal: ac.signal });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASON_ABORTED);
    assert.equal(c.stats("sn").waiting, 0);
    assert.equal(c.stats("sn").busy, 0);
  });

  test("②f 等待默认有上界（不许让请求永远挂着）", () => {
    assert.equal(DEFAULT_WAIT_MS, 120_000, "默认等两分钟 —— 桌面端不能让请求无限期挂着");
    assert.equal(NO_WAIT_BOUND, 0, "0 = 不设上界（magpie 的 QueueWait=0）");
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    assert.equal(c.configOf("sn").waitMs, DEFAULT_WAIT_MS, "不写就用默认上界");
    c.configure("sn", { limit: 1, waitMs: 0 });
    assert.equal(c.configOf("sn").waitMs, 0, "显式写 0 = 无限等（magpie 的语义）");
  });
});

/* ========================================================================== *
 * ③ 三种拒法要分得清
 * ========================================================================== */

describe("③ 拒 —— 三种结局（magpie 的 errQueueFull / errQueueWait）", () => {
  test("③a mode:'reject'：满员当场拒，不排队（我们自己的取舍）", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1, mode: "reject" });
    const a = await c.acquire("sn");
    const r = await c.acquire("sn");
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASON_FAST_REJECT);
    assert.equal(r.release, null, "没拿到名额就没有 release");
    const s = c.stats("sn");
    assert.equal(s.waiting, 0, "快失败模式不许排队");
    assert.equal(s.rejected, 1);
    assert.equal(s.rejectedFast, 1);
    a.release();
  });

  test("③b queueLimit：队列满了当场拒（magpie 的 errQueueFull）", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1, queueLimit: 1 });
    const a = await c.acquire("sn");
    const p2 = c.acquire("sn");
    await tick();
    const r3 = await c.acquire("sn");
    assert.equal(r3.ok, false);
    assert.equal(r3.reason, REASON_QUEUE_FULL);
    assert.equal(c.stats("sn").waiting, 1, "被拒的那个**不进**队列");
    assert.equal(c.stats("sn").rejectedFull, 1);
    a.release();
    (await p2).release();
  });

  test("③c waitMs：等太久当场拒（magpie 的 errQueueWait）", async () => {
    const clock = fakeClock();
    const c = new ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1, waitMs: 5000 });
    const a = await c.acquire("sn");
    const p = c.acquire("sn");
    await tick();
    await clock.advance(5000);
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASON_WAIT_TIMEOUT);
    assert.equal(r.waited, 5000);
    const s = c.stats("sn");
    assert.equal(s.waiting, 0, "超时的那个必须从队列里摘掉 —— 否则它会一直占着位置");
    assert.equal(s.rejectedTimeout, 1);
    assert.equal(s.busy, 1, "在途的那个还占着名额（它自己还没结束）");
    a.release();
  });

  test("③d 三种拒法的原因码互不相同（上层要靠它们区分处理）", () => {
    assert.notEqual(REASON_FAST_REJECT, REASON_QUEUE_FULL);
    assert.notEqual(REASON_FAST_REJECT, REASON_WAIT_TIMEOUT);
    assert.notEqual(REASON_QUEUE_FULL, REASON_WAIT_TIMEOUT);
    /* 与 RPM 的原因码也不许混：RPM 的拒要回 429 + Retry-After。 */
    assert.ok(!String(REASON_FAST_REJECT).includes("rpm"));
    assert.ok(!String(REASON_QUEUE_FULL).includes("rpm"));
    assert.ok(!String(REASON_WAIT_TIMEOUT).includes("rpm"));
  });
});

/* ========================================================================== *
 * ④ 释放必须可靠（本模块最要紧的一条）
 * ========================================================================== */

describe("④ 释放 —— 漏一次就永久占一个坑", () => {
  test("④a release 幂等：还两次也只还一次（magpie 的 sync.Once）", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    const a = await c.acquire("sn");
    assert.equal(a.release(), true);
    assert.equal(a.release(), false, "第二次必须是无操作");
    const s = c.stats("sn");
    assert.equal(s.busy, 0, "占用数不能被减成负数 —— 负数会让上限永远形同虚设");
    assert.equal(s.inflight, 0);
    assert.equal(s.lateRelease, 0, "幂等地重复调用不算「迟到的释放」");
  });

  test("④b withSlot：fn 抛异常也照样还名额（try/finally 语义）", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    await assert.rejects(
      () => c.withSlot("sn", async () => {
        throw new Error("上游炸了");
      }),
      /上游炸了/,
    );
    const s = c.stats("sn");
    assert.equal(s.busy, 0, "抛异常必须还名额 —— 漏了就永久占一个坑");
    assert.equal(s.inflight, 0);
  });

  test("④c withSlot：正常返回也还名额", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    const r = await c.withSlot("sn", async () => "ok");
    assert.equal(r.ok, true);
    assert.equal(r.value, "ok");
    assert.equal(c.stats("sn").busy, 0);
  });

  test("④d 外部显式 release：拿不到返回值也能还", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    const a = await c.acquire("sn");
    assert.equal(c.release("sn", a.token), true);
    assert.equal(c.stats("sn").busy, 0);
    assert.equal(c.release("sn", a.token), false, "同一个 token 只能还一次");
    assert.equal(c.stats("sn").busy, 0);
    assert.equal(c.stats("sn").inflight, 0, "不能把在途总数减成负数");
  });

  test("④e 不给 token 的 release 还的是最老的那一个", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 2 });
    const a = await c.acquire("sn");
    const b = await c.acquire("sn");
    assert.equal(c.release("sn"), true);
    const holders = c.holders("sn");
    assert.equal(holders.length, 1);
    assert.equal(holders[0].token, b.token, "还的应该是最老的那个");
    a.release();
    b.release();
  });

  test("④f 泄漏兜底：过了租约还没还的名额由 sweep 收走", async () => {
    const clock = fakeClock();
    const c = new ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    await c.acquire("sn", { leaseMs: 30000 });
    assert.equal(c.stats("sn").busy, 1);
    await clock.advance(31000);
    assert.equal(c.sweep(clock.now()), 1, "过了租约还没还 → 收走");
    const s = c.stats("sn");
    assert.equal(s.busy, 0, "收走之后闸门必须能再放人");
    assert.equal(s.leaked, 1);
    const again = await c.acquire("sn");
    assert.equal(again.ok, true, "漏了一个也不能把这一家永久卡死");
    again.release();
  });

  test("④g 没声明租约的**不许**按年龄收（宁可漏收也不能错杀活着的请求）", async () => {
    const clock = fakeClock();
    const c = new ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    const a = await c.acquire("sn");
    await clock.advance(3600000);
    assert.equal(c.sweep(clock.now()), 0, "没声明租约就不许按年龄收 —— 长流式响应占几分钟很正常");
    assert.equal(c.stats("sn").busy, 1);
    a.release();
  });

  test("④h acquire 自己也会先扫一遍泄漏（不能等别人想起来调 sweep）", async () => {
    const clock = fakeClock();
    const c = new ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    await c.acquire("sn", { leaseMs: 1000 });
    await clock.advance(2000);
    const again = await c.acquire("sn");
    assert.equal(again.ok, true, "上一个漏了，下一个不该被它堵死");
    assert.equal(c.stats("sn").leaked, 1);
    again.release();
  });
});

/* ========================================================================== *
 * ⑤ 内部绝不取真实时间
 * ========================================================================== */

describe("⑤ 纪律 —— 内部绝不取真实时间", () => {
  test("⑤a Date.now 被换成会抛错的桩也必须跑得通", async () => {
    const real = Date.now;
    Date.now = () => {
      throw new Error("内部不许取真实时间");
    };
    try {
      const clock = fakeClock();
      const c = new ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
      const a = await c.acquire("sn");
      a.release();
      assert.equal(c.stats("sn").busy, 0);
    } finally {
      Date.now = real;
    }
  });

  test("⑤b 构造时不给 now 必须当场炸（不许默默退回到 Date.now）", () => {
    assert.throws(() => new ConcurrencyLimiter({ limit: 1 }), /opts\.now/);
    assert.throws(() => new ConcurrencyLimiter({ now: "now", limit: 1 }), /opts\.now/);
  });

  test("⑤c 配置口径错了要当场炸（比例当个数 / 负数 / 非法 mode）", () => {
    assert.throws(() => new ConcurrencyLimiter({ now: () => T0, limit: -1 }), /limit/);
    assert.throws(() => new ConcurrencyLimiter({ now: () => T0, limit: 0.5 }), /limit/);
    assert.throws(() => new ConcurrencyLimiter({ now: () => T0, limit: NaN }), /limit/);
    assert.throws(() => new ConcurrencyLimiter({ now: () => T0, queueLimit: -3 }), /queueLimit/);
    assert.throws(() => new ConcurrencyLimiter({ now: () => T0, waitMs: 1.5 }), /waitMs/);
    assert.throws(() => new ConcurrencyLimiter({ now: () => T0, mode: "nope" }), /mode/);
    const c = new ConcurrencyLimiter({ now: () => T0 });
    assert.throws(() => c.configure("sn", { limit: -1 }), /limit/);
  });
});

/* ========================================================================== *
 * ⑥ 可观测性
 * ========================================================================== */

describe("⑥ 可观测 —— 面板要看的东西", () => {
  test("⑥a snapshot()：所有道的快照", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 2 });
    const a = await c.acquire("sn");
    await c.acquire("wb");
    const snap = c.snapshot();
    assert.deepEqual(Object.keys(snap).sort(), ["sn", "wb"]);
    assert.equal(snap.sn.busy, 1);
    assert.equal(snap.sn.limit, 2);
    assert.equal(snap.wb.busy, 1);
    a.release();
  });

  test("⑥b holders()：谁占了多久、租约到什么时候", async () => {
    const clock = fakeClock();
    const c = new ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    const a = await c.acquire("sn", { leaseMs: 30000 });
    await clock.advance(1000);
    const hs = c.holders("sn");
    assert.equal(hs.length, 1);
    assert.equal(hs[0].token, a.token);
    assert.equal(hs[0].since, T0);
    assert.equal(hs[0].leaseUntil, T0 + 30000);
    a.release();
  });

  test("⑥c 没碰过的 key 也要报得出形状（面板不能因为没数据就崩）", () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 3 });
    const s = c.stats("never-seen");
    assert.equal(s.key, "never-seen");
    assert.equal(s.busy, 0);
    assert.equal(s.limit, 3);
    assert.equal(s.waiting, 0);
    assert.equal(s.rejected, 0);
  });

  test("⑥d configure 改上限后，排着的人立刻放行（magpie 的 take：先设 limit 再 grant）", async () => {
    const c = new ConcurrencyLimiter({ now: () => T0, limit: 1 });
    const a = await c.acquire("sn");
    const p = c.acquire("sn");
    await tick();
    assert.equal(c.stats("sn").waiting, 1);
    c.configure("sn", { limit: 2 });
    const r = await p;
    assert.equal(r.ok, true, "上限调大 → 排队的人立刻拿到名额");
    assert.equal(c.stats("sn").busy, 2);
    a.release();
    r.release();
  });
});

/* ========================================================================== *
 * 反向对照：把源码里的判定改坏，本文件的断言必须变红
 *
 * 做法：把 src/server/concurrency.mjs 复制一份到临时目录，改坏其中一处，
 * import 那份副本，重跑关键断言 —— 结果必须与原模块不同。
 * 「不同」即证明上面那些断言不是空的：源码一坏，它们就会红。
 * ========================================================================== */

/** 契约断言：正向必须全绿；改坏之后必须至少红一条。 */
async function contractChecks(mod) {
  const clock = fakeClock();
  const c = new mod.ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });

  /* ① 释放必须真的还名额 */
  const a = await c.acquire("sn");
  assert.equal(c.stats("sn").busy, 1);
  a.release();
  assert.equal(c.stats("sn").busy, 0, "释放之后必须没有占用");
  assert.equal(c.stats("sn").inflight, 0, "在途总数也要归零");

  /* ② release 必须幂等 */
  a.release();
  assert.equal(c.stats("sn").busy, 0, "还两次不能把占用数减成负数");
  assert.equal(c.stats("sn").inflight, 0);

  /* ③ try/finally：抛异常也还 */
  await assert.rejects(
    () => c.withSlot("sn", async () => {
      throw new Error("上游炸了");
    }),
    /上游炸了/,
  );
  assert.equal(c.stats("sn").busy, 0, "抛异常必须还名额");

  /* ④ 先来先服务 */
  const c2 = new mod.ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
  const first = await c2.acquire("sn");
  const order = [];
  /* ⚠ 这里**不能** await p2：改坏成后进先出之后，p2 永远不会被唤醒，
     await 它就把测试挂死了。改成「放掉第一个之后看谁醒了」。 */
  c2.acquire("sn").then(() => { order.push("second"); });
  c2.acquire("sn").then(() => { order.push("third"); });
  await tick();
  first.release();
  await tick();
  await tick();
  assert.deepEqual(order, ["second"], "先排队的先拿到名额");

  /* ⑤ 快失败模式：满员当场拒，不排队 */
  const c3 = new mod.ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1, mode: "reject" });
  const held = await c3.acquire("sn");
  /* ⚠ 这里**不能**直接 await：改坏之后它会一直排队等下去，await 就把测试挂死了。 */
  let outcome = null;
  c3.acquire("sn").then((r) => { outcome = r; });
  await tick();
  await tick();
  assert.ok(outcome !== null, "快失败模式必须立刻有结果（不能挂着等）");
  assert.equal(outcome.ok, false, "快失败模式必须拒");
  assert.equal(c3.stats("sn").waiting, 0, "快失败模式不许排队");
  held.release();

  /* ⑥ 泄漏兜底：过了租约没收掉的名额必须被 sweep 收走 */
  const c4 = new mod.ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
  await c4.acquire("sn", { leaseMs: 1000 });
  await clock.advance(2000);
  assert.equal(c4.sweep(clock.now()), 1, "过了租约还没还 → 收走");
  assert.equal(c4.stats("sn").busy, 0, "收走之后闸门必须能再放人");
  assert.equal(c4.stats("sn").leaked, 1);

  /* ⑦ 排队不算失败 */
  const c5 = new mod.ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
  const held5 = await c5.acquire("sn");
  const waiting5 = c5.acquire("sn");
  await tick();
  assert.equal(c5.stats("sn").rejected, 0, "排队中的请求不算被拒");
  held5.release();
  (await waiting5).release();

  /* ⑧ 客户端走了要离开队列（magpie 的 ctx.Done()） */
  const c6 = new mod.ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
  const held6 = await c6.acquire("sn");
  const ac6 = new AbortController();
  const waiting6 = c6.acquire("sn", { signal: ac6.signal });
  await tick();
  ac6.abort();
  const out6 = await withTimeout(waiting6, 500, "客户端走了的判定");
  assert.equal(out6.ok, false, "客户端走了 → 不该拿到名额");
  assert.equal(out6.reason, mod.REASON_ABORTED);
  assert.equal(c6.stats("sn").waiting, 0, "走掉的那个必须离开队列 —— 否则它白占一个队列位置");
  held6.release();
}

/**
 * 给契约检查加个超时。
 *
 * ⚠ 为什么需要：改坏之后有可能**永远等不到**某个 promise（例如下面 ⑪ 那个
 *    「后进先出」的改法，先排队的那个就再也醒不过来了）。没有超时的话，
 *    反向对照会把整个测试进程挂死 —— 那不是「断言红了」，是「测试没了」。
 */
function withTimeout(promise, ms = 5000, what = "契约检查") {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}超时（${ms}ms）—— 断言挂住了`)), ms);
    }),
  ]).finally(() => {
    /* 赢了也要把计时器撤掉 —— 否则每个反向对照都会白吊住进程好几秒。 */
    if (timer) clearTimeout(timer);
  });
}

/**
 * 造一个「改坏之后」的模块：改源码 → 写到临时目录 → import 进来。
 * ⚠ 改的是**副本**，仓库里的源码一个字都不动。
 */
async function mutant(name, from, to) {
  assert.equal(MODULE_SRC.includes(from), true,
    `锚点对不上源码了（手法或源码变了，这条反向对照失效）：${from}`);
  const src = MODULE_SRC.replace(from, to);
  const file = path.join(os.tmpdir(), `bai-concurrency-mutant-${name}.mjs`);
  fs.writeFileSync(file, src, "utf8");
  return import(pathToFileURL(file).href);
}

describe("反向对照（改坏源码，断言必须红）", () => {
  test("⑨ 正向：契约全绿", async () => {
    await contractChecks({
      ConcurrencyLimiter,
      REASON_ABORTED,
    });
  });

  test("⑩ 把 release 改坏（名额不还）→ 必须打红", async () => {
    const bad = await mutant(
      "release-noop",
      "if (!lane.slots.delete(token)) {",
      "if (true) {",
    );
    await assert.rejects(() => withTimeout(contractChecks(bad)),
      "release 改坏之后断言竟然还绿 —— 那这些断言是恒真的");
    /* 说清是哪一条红的：占用数下不去 */
    const c = new bad.ConcurrencyLimiter({ now: () => T0, limit: 1 });
    const a = await c.acquire("sn");
    a.release();
    assert.equal(c.stats("sn").busy, 1, "改坏之后名额真的没还 —— 这一家从此发不出请求");
  });

  test("⑪ 把队列改成后进先出 → 必须打红", async () => {
    const bad = await mutant(
      "lifo",
      "const w = lane.waiting.shift();",
      "const w = lane.waiting.pop();",
    );
    await assert.rejects(() => withTimeout(contractChecks(bad)),
      "队列顺序改坏之后断言竟然还绿 —— 那「先来先服务」是空话");
    /* 说清是哪一条红的：先醒的是后到的那个 */
    const clock = fakeClock();
    const c = new bad.ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    const first = await c.acquire("sn");
    const order = [];
    c.acquire("sn").then(() => { order.push("second"); });
    c.acquire("sn").then(() => { order.push("third"); });
    await tick();
    first.release();
    await tick();
    await tick();
    assert.deepEqual(order, ["third"], "改坏之后先醒的是后到的那个 —— 这就是「插队」");
  });

  test("⑫ 把 withSlot 的 finally 去掉 → 必须打红", async () => {
    const bad = await mutant(
      "no-finally",
      "slot.release();",
      "void 0;",
    );
    await assert.rejects(() => withTimeout(contractChecks(bad)),
      "finally 去掉之后断言竟然还绿 —— 那「异常也还名额」是空话");
    const c = new bad.ConcurrencyLimiter({ now: () => T0, limit: 1 });
    await assert.rejects(() => c.withSlot("sn", async () => {
      throw new Error("上游炸了");
    }));
    assert.equal(c.stats("sn").busy, 1, "改坏之后抛异常就漏了名额 —— 永久占一个坑");
  });

  test("⑬ 把快失败模式改坏（也排队）→ 必须打红", async () => {
    const bad = await mutant(
      "reject-mode",
      'if (cfg.mode === "reject") {',
      "if (false) {",
    );
    await assert.rejects(() => withTimeout(contractChecks(bad)),
      "快失败模式改坏之后断言竟然还绿 —— 那「满员当场拒」是空话");
    const c = new bad.ConcurrencyLimiter({ now: () => T0, limit: 1, mode: "reject" });
    const a = await c.acquire("sn");
    let r = null;
    c.acquire("sn").then((x) => { r = x; });
    await tick();
    await tick();
    assert.equal(r, null, "改坏之后那个请求去排队了 —— 它不会立刻有结果");
    assert.equal(c.stats("sn").waiting, 1, "改坏之后竟然排队了");
    a.release();
  });

  test("⑭ 把泄漏兜底改坏（不收走）→ 必须打红", async () => {
    const bad = await mutant(
      "leak",
      "lane.slots.delete(token);\n          lane.inflight--;\n          lane.leaked++;",
      "lane.inflight--;\n          lane.leaked++;",
    );
    await assert.rejects(() => withTimeout(contractChecks(bad)),
      "泄漏兜底改坏之后断言竟然还绿 —— 那「漏了也不会卡死这家」是空话");
    const clock = fakeClock();
    const c = new bad.ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    await c.acquire("sn", { leaseMs: 1000 });
    await clock.advance(2000);
    assert.equal(c.sweep(clock.now()), 1);
    assert.equal(c.stats("sn").busy, 1, "改坏之后名额没被收走 —— 闸门永久卡死");
  });

  test("⑮ 把「客户端走了就出队」改坏 → 必须打红", async () => {
    const bad = await mutant(
      "ignore-abort",
      'signal.addEventListener("abort", onAbort, { once: true });',
      "void 0;",
    );
    await assert.rejects(() => withTimeout(contractChecks(bad)),
      "出队改坏之后断言竟然还绿 —— 那「客户端走了不白占队列位置」是空话");
    const clock = fakeClock();
    const c = new bad.ConcurrencyLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    const a = await c.acquire("sn");
    const ac = new AbortController();
    const p = c.acquire("sn", { signal: ac.signal });
    await tick();
    ac.abort();
    await tick();
    assert.equal(c.stats("sn").waiting, 1, "改坏之后那个走掉的请求还占着队列位置");
    a.release();
  });
});
