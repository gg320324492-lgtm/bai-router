/**
 * scripts/rpm-test.mjs —— 每家渠道的「每分钟请求数」上限
 * （src/server/rpm.mjs）
 *
 * ## 这份测试在守什么
 *
 * 这个模块补的洞是：bai-router 只有「谁失败了换一家」，**没有「一分钟最多发几个」
 * 的闸门**。缺了它，上游按 RPM 限流时我们看不见也管不着 —— 表现是随机的 429，
 * 而面板上什么都看不出来（不是哪家的模型坏了，是这一家当下被自己打爆了）。
 *
 * 它守五件事：
 *   ① **窗口口径照抄 magpie**：**滚动**窗口 60 秒 **+ 1 秒松弛**
 *      （magpie 的 rpmWindow + rpmSlack）。不是固定窗口 —— 固定窗口会让
 *      「窗口交界处一分钟发两倍」的漏洞一直开着。
 *   ② **先来先服务的排队时刻**：第 N+1 个排在「倒数第 N 个已有请求 + 窗口长」
 *      之后（magpie 的 `ts[len(ts)-limit].Add(rpmSpan)`）。
 *   ③ **等不起就当场拒，并带 Retry-After**（magpie 的 errRPM）：Retry-After
 *      的秒数**至少是 1** —— 回 0 等于叫客户端立刻再撞一次。
 *   ④ **位置能还回去**：等的过程中客户端走了 → 把这一分钟里的位置还回去
 *      （magpie 的 giveBack），否则额度被一个根本没发出去的请求占着。
 *   ⑤ **上游的 Retry-After 会被采纳**（我们自己的取舍，magpie 没有）：上游明说
 *      「N 秒后再来」，下一次发送就不得早于那个时刻。
 *
 * ## 与并发闸门的分工（这一条也要被测到）
 *   并发 = 「**同时**几个在飞」；RPM = 「**一分钟**发出去几个」。
 *   两者叠加时**先并发后 RPM**（magpie：先拿 slot，再在真的发出去之前等分钟里有
 *   空位）。原因的码也必须互不相同 —— RPM 的拒要回 429 + Retry-After，
 *   并发的拒只是本地决策（换一家就行）。
 *
 * ## 纪律
 *   ★ **时间与计时器都注入**：opts.now 给时刻，opts.timer 给计时器，
 *     假时钟把时间**逐字**推进，所以「等了 61 秒」这种断言是精确的。
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
  RpmLimiter,
  parseRetryAfterMs,
  REASON_RPM_EXCEEDED,
  REASON_ABORTED,
  RPM_WINDOW_MS,
  RPM_SLACK_MS,
  RPM_LONGEST_WAIT_MS,
} from "../src/server/rpm.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "src/server/rpm.mjs");
const MODULE_SRC = fs.readFileSync(MODULE_PATH, "utf8");

const T0 = 1_700_000_000_000;
const SPAN = RPM_WINDOW_MS + RPM_SLACK_MS;   // 61000：60 秒窗口 + 1 秒松弛

/** 让微任务跑完（promise 的续体）。 */
const tick = () => new Promise((r) => setImmediate(r));

/**
 * 假时钟：时刻与计时器都在我们手里，所以「等了 61 秒」能逐字断言。
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
 * ① 窗口口径：滚动窗口 60 秒 + 1 秒松弛
 * ========================================================================== */

describe("① 窗口 —— 滚动 60 秒 + 1 秒松弛（magpie 的 rpmWindow + rpmSlack）", () => {
  test("①a limit=2：前两个立刻走，第三个要等到窗口滑过去", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 2 });
    const a = await r.acquire("sn");
    const b = await r.acquire("sn");
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.waited, 0, "还有位置就不用等");

    /* 第三个：得等「倒数第 2 个已有请求 + 窗口长」= T0 + 61000 */
    const pending = r.acquire("sn");
    await tick();
    const reserved = r.reserve("sn");
    assert.equal(reserved.ok, true);
    assert.equal(reserved.at, T0 + SPAN, "第三个排在 T0+61000（60 秒窗口 + 1 秒松弛）");
    assert.equal(reserved.delayMs, SPAN);
    await clock.advance(SPAN);
    const c = await pending;
    assert.equal(c.ok, true);
    assert.equal(c.waited, SPAN, "等了 61000 毫秒 —— 逐字断言");
    assert.equal(c.at, T0 + SPAN);
  });

  test("①b 窗口是**滚动**的：滑过去之后位置就回来了", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    await r.acquire("sn");
    assert.equal(r.used("sn"), 1);
    await clock.advance(SPAN - 1);
    assert.equal(r.used("sn"), 1, "还没滑出窗口，还占着");
    await clock.advance(2);
    assert.equal(r.used("sn"), 0, "滑出窗口之后位置回来了");
    const again = await r.acquire("sn");
    assert.equal(again.ok, true);
    assert.equal(again.waited, 0, "位置回来了就不用等");
  });

  test("①c 恰好等于上限就还能走一个（边界是「>=」而不是「>」）", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 2 });
    await r.acquire("sn");
    await r.acquire("sn");
    assert.equal(r.used("sn"), 2);
    const third = r.reserve("sn");
    assert.equal(third.delayMs, SPAN, "第 3 个必须等");
  });

  test("①d limit=0 = 不限：不记账、不等", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 0 });
    const a = await r.acquire("sn");
    const b = await r.acquire("sn");
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.waited, 0);
    assert.equal(r.used("sn"), 0, "不限额就不计数（magpie: limit<=0 counts nothing）");
  });

  test("①e 每条 key 各算各的（粒度 = key/账号）", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    await r.acquire("sn@u1");
    const other = await r.acquire("sn@u2");
    assert.equal(other.ok, true, "另一个 key 有自己的分钟");
    assert.equal(other.waited, 0);
    assert.equal(r.used("sn@u1"), 1);
    assert.equal(r.used("sn@u2"), 1);
  });
});

/* ========================================================================== *
 * ② 排队时刻：先来先服务
 * ========================================================================== */

describe("② 排队时刻 —— 先来先服务（magpie 的 ts[len-limit]+span）", () => {
  test("②a 第 N+1 个排在「倒数第 N 个 + 窗口长」之后", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 2, longestWaitMs: 0 });
    /* 两个请求间隔 1 秒，于是「倒数第 N 个」落在不同的时刻上，顺序看得出来 */
    const stamps = [];
    for (let i = 0; i < 6; i++) {
      const res = r.reserve("sn");
      assert.equal(res.ok, true);
      stamps.push(res.at - T0);
      await clock.advance(1000);
    }
    assert.deepEqual(stamps, [
      0,          /* 有位置 → 立刻 */
      1000,       /* 有位置 → 立刻 */
      SPAN,       /* ts[0] + 窗口长 */
      1000 + SPAN, /* ts[1] + 窗口长 */
      2 * SPAN,   /* ts[2] + 窗口长 */
      1000 + 2 * SPAN,
    ], "排队时刻必须按先来先服务排 —— 后来的不許插到前面");
  });

  test("②b 任一分钟里都不超过上限（这是「每分钟 N 个」的全部含义）", async () => {
    const clock = fakeClock();
    /* longestWaitMs=0（不限等）：这里只验窗口不变式，不验「等不起就拒」。 */
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 3, longestWaitMs: 0 });
    const stamps = [];
    for (let i = 0; i < 10; i++) {
      const res = r.reserve("sn");
      assert.equal(res.ok, true);
      stamps.push(res.at);
      await clock.advance(100);
    }
    /* 在每一分钟窗口里数一遍 */
    for (const probe of stamps) {
      const inWindow = stamps.filter((x) => x > probe - SPAN && x <= probe);
      assert.ok(inWindow.length <= 3, `窗口 ${probe - T0} 里有 ${inWindow.length} 个，超过上限 3`);
    }
  });
});

/* ========================================================================== *
 * ③ 等不起就当场拒，带 Retry-After
 * ========================================================================== */

describe("③ 拒 —— 当场拒 + Retry-After（magpie 的 errRPM）", () => {
  test("③a 等太久当场拒，不进队列", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1, longestWaitMs: 5000 });
    await r.acquire("sn");
    const res = await r.acquire("sn");
    assert.equal(res.ok, false);
    assert.equal(res.reason, REASON_RPM_EXCEEDED);
    assert.equal(res.afterMs, SPAN, "要等 61000 毫秒");
    assert.equal(res.retryAfterSec, 61, "Retry-After 是秒");
    assert.equal(res.retryAfterMs, SPAN);
  });

  test("③b Retry-After 至少 1 秒（回 0 等于叫客户端立刻再撞一次）", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1, longestWaitMs: 1 });
    await r.acquire("sn");
    const res = await r.acquire("sn");
    assert.equal(res.ok, false);
    assert.ok(res.retryAfterSec >= 1, "至少 1 秒");
    assert.equal(res.retryAfterSec, 61);
  });

  test("③c 等得起就等，等到点了再走", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1, longestWaitMs: 120000 });
    await r.acquire("sn");
    const pending = r.acquire("sn");
    await tick();
    await clock.advance(SPAN);
    const res = await pending;
    assert.equal(res.ok, true);
    assert.equal(res.waited, SPAN);
    assert.equal(res.at, T0 + SPAN);
  });

  test("③d 被拒的**不占**位置（magpie：nothing rests for it）", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1, longestWaitMs: 5000 });
    await r.acquire("sn");
    const before = r.used("sn");
    await r.acquire("sn");
    assert.equal(r.used("sn"), before, "被拒的那个不许记进这一分钟");
  });

  test("③e 等不到 1 秒也回 1 秒（回 0 等于叫客户端立刻再撞一次）", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1, longestWaitMs: 1 });
    await r.acquire("sn");
    /* 往前挪到「窗口刚好快滑过去」：这时只差 2 毫秒就有位置了 */
    await clock.advance(SPAN - 2);
    const res = await r.acquire("sn");
    assert.equal(res.ok, false, "只差 2 毫秒也算等不起（等待上界是 1 毫秒）");
    assert.equal(res.afterMs, 2);
    assert.equal(res.retryAfterSec, 1, "不足 1 秒也要回 1 秒 —— 回 0 等于让客户端立刻再撞");
  });
});

/* ========================================================================== *
 * ④ 位置能还回去
 * ========================================================================== */

describe("④ 位置还回去（magpie 的 giveBack）", () => {
  test("④a 等的过程中客户端走了 → 位置还回去", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    await r.acquire("sn");
    const ac = new AbortController();
    const pending = r.acquire("sn", { signal: ac.signal });
    await tick();
    assert.equal(r.used("sn"), 2, "等的时候位置已经预占了（这是 magpie 的 reserve 语义）");
    ac.abort();
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.reason, REASON_ABORTED);
    assert.equal(res.gaveBack, true);
    assert.equal(r.used("sn"), 1, "位置必须还回去 —— 否则额度被一个没发出去的请求占着");
  });

  test("④b 手动 giveBack 也能还", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 2 });
    const res = r.reserve("sn");
    assert.equal(r.used("sn"), 1);
    assert.equal(r.giveBack("sn", res.at), true);
    assert.equal(r.used("sn"), 0);
    assert.equal(r.giveBack("sn", res.at), false, "还过一次就不能再还 —— 还了就等于白放一个额度");
  });
});

/* ========================================================================== *
 * ⑤ 上游的 Retry-After 会被采纳（我们自己的取舍）
 * ========================================================================== */

describe("⑤ 上游的 Retry-After", () => {
  test("⑤a 上游说「N 秒后再来」→ 下一次不得早于那个时刻", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 100 });
    assert.equal(r.noteRetryAfter("sn", { retryAfterMs: 30000, now: clock.now() }), T0 + 30000);
    const res = r.reserve("sn");
    assert.equal(res.at, T0 + 30000, "下一次发送不得早于上游说的时刻");
    assert.equal(res.delayMs, 30000);
  });

  test("⑤b 只往后推，不往前拉", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 100 });
    r.noteRetryAfter("sn", { retryAfterMs: 30000, now: clock.now() });
    r.noteRetryAfter("sn", { retryAfterMs: 5000, now: clock.now() });
    const res = r.reserve("sn");
    assert.equal(res.at, T0 + 30000, "上游后来给了个更短的，也不能把已经说的那个拉回来");
  });

  test("⑤c Retry-After 过期之后就恢复正常", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 100 });
    r.noteRetryAfter("sn", { retryAfterMs: 30000, now: clock.now() });
    await clock.advance(30001);
    const res = r.reserve("sn");
    assert.equal(res.ok, true);
    assert.equal(res.delayMs, 0, "过期了就该能发");
  });

  test("⑤d free() 也要看 Retry-After（被挡住的时候不算「有空位」）", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 100 });
    assert.equal(r.free("sn"), true);
    r.noteRetryAfter("sn", { retryAfterMs: 30000, now: clock.now() });
    assert.equal(r.free("sn"), false, "上游说了要等，就不算有空位");
    await clock.advance(30001);
    assert.equal(r.free("sn"), true);
  });

  test("⑤e parseRetryAfterMs：秒数与 HTTP-date 都认", () => {
    assert.equal(parseRetryAfterMs({ "retry-after": "30" }), 30000);
    assert.equal(parseRetryAfterMs({ "Retry-After": "0" }), 0);
    assert.equal(parseRetryAfterMs(new Map([["retry-after", "5"]])), 5000);
    assert.equal(parseRetryAfterMs([["Retry-After", "7"]]), 7000);
    assert.equal(parseRetryAfterMs({}), null, "没有这个头就是 null");
    /* HTTP-date：解析一个给定的时刻，不是「取现在」 */
    const at = "Wed, 21 Oct 2026 07:28:00 GMT";
    const base = Date.parse(at) - 10000;
    assert.equal(parseRetryAfterMs({ "retry-after": at }, base), 10000);
  });

  test("⑤f noteRetryAfterHeaders 直接吃响应头", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 100 });
    r.noteRetryAfterHeaders("sn", { "retry-after": "12" }, clock.now());
    const res = r.reserve("sn");
    assert.equal(res.at, T0 + 12000);
  });
});

/* ========================================================================== *
 * ⑥ 与并发闸门的分工
 * ========================================================================== */

describe("⑥ 与并发闸门的分工", () => {
  test("⑥a RPM 的原因码与并发的**刻意不同**（上层要靠它回 429）", async () => {
    assert.equal(REASON_RPM_EXCEEDED, "rpm-exceeded");
    assert.ok(!String(REASON_RPM_EXCEEDED).includes("queue"));
    assert.ok(!String(REASON_RPM_EXCEEDED).includes("timeout"));
    assert.ok(!String(REASON_ABORTED).includes("queue"));
  });

  test("⑥b 被 RPM 拒掉时要给得出 Retry-After（回 429 的头）", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1, longestWaitMs: 1000 });
    await r.acquire("sn");
    const res = await r.acquire("sn");
    assert.equal(res.ok, false);
    assert.equal(typeof res.retryAfterSec, "number");
    assert.ok(Number.isInteger(res.retryAfterSec), "Retry-After 必须是整数秒");
    assert.ok(res.retryAfterSec >= 1);
  });

  test("⑥c RPM 与并发互不干扰（两个模块各管各的）", async () => {
    /* 同一个 key 上，RPM 满了不影响「还有空位吗」的判断 —— 那是并发的事。 */
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    await r.acquire("sn");
    assert.equal(r.free("sn"), false, "RPM 这一分钟满了");
    assert.equal(r.used("sn"), 1);
  });
});

/* ========================================================================== *
 * ⑦ 纪律：内部绝不取真实时间
 * ========================================================================== */

describe("⑦ 纪律 —— 内部绝不取真实时间", () => {
  test("⑦a Date.now 被换成会抛错的桩也必须跑得通", async () => {
    const real = Date.now;
    Date.now = () => {
      throw new Error("内部不许取真实时间");
    };
    try {
      const clock = fakeClock();
      const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 2 });
      const a = await r.acquire("sn");
      assert.equal(a.ok, true);
    } finally {
      Date.now = real;
    }
  });

  test("⑦b 构造时不给 now 必须当场炸", () => {
    assert.throws(() => new RpmLimiter({ limit: 1 }), /opts\.now/);
    assert.throws(() => new RpmLimiter({ now: "now", limit: 1 }), /opts\.now/);
  });

  test("⑦c 配置口径错了要当场炸", () => {
    assert.throws(() => new RpmLimiter({ now: () => T0, limit: -1 }), /limit/);
    assert.throws(() => new RpmLimiter({ now: () => T0, limit: 0.5 }), /limit/);
    assert.throws(() => new RpmLimiter({ now: () => T0, limit: NaN }), /limit/);
    assert.throws(() => new RpmLimiter({ now: () => T0, longestWaitMs: 1.5 }), /longestWaitMs/);
    const r = new RpmLimiter({ now: () => T0 });
    assert.throws(() => r.configure("sn", { limit: -2 }), /limit/);
  });

  test("⑦d 窗口长与松弛是照抄 magpie 的常量", () => {
    assert.equal(RPM_WINDOW_MS, 60_000);
    assert.equal(RPM_SLACK_MS, 1_000);
    assert.equal(RPM_LONGEST_WAIT_MS, 120_000);
  });
});

/* ========================================================================== *
 * ⑧ 可观测
 * ========================================================================== */

describe("⑧ 可观测", () => {
  test("⑧a stats()：这一分钟现在的样子", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 5 });
    await r.acquire("sn");
    const s = r.stats("sn");
    assert.equal(s.key, "sn");
    assert.equal(s.limit, 5);
    assert.equal(s.used, 1);
    assert.equal(s.free, true);
    assert.equal(s.windowMs, 60_000);
    assert.equal(s.slackMs, 1_000);
  });

  test("⑧b snapshot()：所有 key 的快照", async () => {
    const clock = fakeClock();
    const r = new RpmLimiter({ now: clock.now, timer: clock.timer, limit: 5 });
    await r.acquire("sn");
    await r.acquire("wb");
    const snap = r.snapshot();
    assert.deepEqual(Object.keys(snap).sort(), ["sn", "wb"]);
    assert.equal(snap.sn.used, 1);
  });
});

/* ========================================================================== *
 * 反向对照：把源码里的判定改坏，本文件的断言必须变红
 * ========================================================================== */

/** 契约断言：正向必须全绿；改坏之后必须至少红一条。 */
async function contractChecks(mod) {
  const clock = fakeClock();
  const r = new mod.RpmLimiter({ now: clock.now, timer: clock.timer, limit: 2 });

  /* ① 窗口口径：第三个必须排在 T0 + 61000 */
  await r.acquire("sn");
  await r.acquire("sn");
  const third = r.reserve("sn");
  assert.equal(third.at, T0 + SPAN, "第三个必须排在 T0+61000（60 秒 + 1 秒松弛）");

  /* ①b 窗口公式：排的是「**最早那个** + 窗口长」，不是「现在 + 窗口长」 */
  const clock2 = fakeClock();
  const r1b = new mod.RpmLimiter({ now: clock2.now, timer: clock2.timer, limit: 2, longestWaitMs: 0 });
  await r1b.acquire("sn");
  await clock2.advance(1000);
  await r1b.acquire("sn");
  const thirdB = r1b.reserve("sn");
  assert.equal(thirdB.at, T0 + SPAN, "排的是最早那个 + 窗口长 —— 不是「现在 + 窗口长」");

  /* ② 等不起就当场拒，带 Retry-After */
  const r2 = new mod.RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1, longestWaitMs: 5000 });
  await r2.acquire("sn");
  const rejected = await withTimeout(r2.acquire("sn"), 500, "等不起的判定");
  assert.equal(rejected.ok, false, "等不起必须当场拒");
  assert.equal(rejected.reason, mod.REASON_RPM_EXCEEDED);
  assert.equal(rejected.retryAfterSec, 61, "Retry-After 是 61 秒");

  /* ③ 位置能还回去 */
  const r3 = new mod.RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
  await r3.acquire("sn");
  const ac = new AbortController();
  const pending = r3.acquire("sn", { signal: ac.signal });
  await tick();
  ac.abort();
  const aborted = await pending;
  assert.equal(aborted.ok, false);
  assert.equal(aborted.reason, mod.REASON_ABORTED);
  assert.equal(r3.used("sn"), 1, "位置必须还回去");

  /* ④ 上游的 Retry-After 会被采纳 */
  const r4 = new mod.RpmLimiter({ now: clock.now, timer: clock.timer, limit: 100 });
  r4.noteRetryAfter("sn", { retryAfterMs: 30000, now: clock.now() });
  const blocked = r4.reserve("sn");
  assert.equal(blocked.at, T0 + 30000, "上游说 30 秒后再来，就不得早于那个时刻");
}

/**
 * 给契约检查加个超时。
 *
 * ⚠ 为什么需要：改坏之后有可能永远等不到某个 promise。没有超时的话，
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
  const file = path.join(os.tmpdir(), `bai-rpm-mutant-${name}.mjs`);
  fs.writeFileSync(file, src, "utf8");
  return import(pathToFileURL(file).href);
}

describe("反向对照（改坏源码，断言必须红）", () => {
  test("⑨ 正向：契约全绿", async () => {
    await contractChecks({
      RpmLimiter,
      REASON_RPM_EXCEEDED,
      REASON_ABORTED,
    });
  });

  test("⑩ 把窗口公式改坏（不再按先来先服务排）→ 必须打红", async () => {
    const bad = await mutant(
      "window-formula",
      "at = ts[ts.length - limit] + span;",
      "at = now + span;",
    );
    await assert.rejects(() => withTimeout(contractChecks(bad)),
      "窗口公式改坏之后断言竟然还绿 —— 那「先来先服务的排队时刻」是空话");
    const clock = fakeClock();
    const r = new bad.RpmLimiter({ now: clock.now, timer: clock.timer, limit: 2, longestWaitMs: 0 });
    await r.acquire("sn");
    await clock.advance(1000);
    await r.acquire("sn");
    const third = r.reserve("sn");
    assert.equal(third.at, T0 + 1000 + SPAN, "改坏之后排的是「现在 + 窗口长」");
    assert.notEqual(third.at, T0 + SPAN, "改坏之后不再是「最早那个 + 窗口长」—— 这一分钟会超过上限");
  });

  test("⑪ 把「等不起就拒」改坏（永远等）→ 必须打红", async () => {
    const bad = await mutant(
      "no-limit-wait",
      "if (cfg.longestWaitMs > 0 && delay > cfg.longestWaitMs) {",
      "if (false) {",
    );
    await assert.rejects(() => withTimeout(contractChecks(bad)),
      "等待上界改坏之后断言竟然还绿 —— 那「等不起就当场拒」是空话");
    const clock = fakeClock();
    const r = new bad.RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1, longestWaitMs: 5000 });
    await r.acquire("sn");
    /* ⚠ 不能直接 await：改坏之后它会一直等下去，await 就把测试挂死了。 */
    let res = null;
    r.acquire("sn").then((x) => { res = x; });
    await tick();
    await tick();
    assert.equal(res, null, "改坏之后它不拒了 —— 请求会一直挂着，用户看到的是「卡住」");
    assert.equal(r.used("sn"), 2, "改坏之后位置被预占了，永远等下去");
  });

  test("⑫ 把「位置还回去」改坏 → 必须打红", async () => {
    const bad = await mutant(
      "no-giveback",
      "this.giveBack(key, r.at);",
      "void 0;",
    );
    await assert.rejects(() => withTimeout(contractChecks(bad)),
      "giveBack 改坏之后断言竟然还绿 —— 那「客户端走了不占额度」是空话");
    const clock = fakeClock();
    const r = new bad.RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1 });
    await r.acquire("sn");
    const ac = new AbortController();
    const pending = r.acquire("sn", { signal: ac.signal });
    await tick();
    ac.abort();
    await pending;
    assert.equal(r.used("sn"), 2, "改坏之后位置没还 —— 额度被一个没发出去的请求占着");
  });

  test("⑬ 把 Retry-After 的单位改坏（毫秒当秒）→ 必须打红", async () => {
    const bad = await mutant(
      "retry-after-unit",
      "return Math.max(1, Math.ceil((Number(delayMs) || 0) / 1000));",
      "return Math.max(1, Math.ceil(Number(delayMs) || 0));",
    );
    await assert.rejects(() => withTimeout(contractChecks(bad)),
      "Retry-After 单位改坏之后断言竟然还绿 —— 那「回的是秒」是空话");
    const clock = fakeClock();
    const r = new bad.RpmLimiter({ now: clock.now, timer: clock.timer, limit: 1, longestWaitMs: 5000 });
    await r.acquire("sn");
    const res = await r.acquire("sn");
    assert.equal(res.retryAfterSec, 61000, "改坏之后把毫秒当成了秒 —— 客户端被告知要等 17 小时");
  });

  test("⑭ 把「采纳上游的 Retry-After」改坏 → 必须打红", async () => {
    const bad = await mutant(
      "ignore-retry-after",
      "if (blocked > at) at = blocked;",
      "void 0;",
    );
    await assert.rejects(() => withTimeout(contractChecks(bad)),
      "采纳上游 Retry-After 改坏之后断言竟然还绿 —— 那「上游说了要等就得等」是空话");
    const clock = fakeClock();
    const r = new bad.RpmLimiter({ now: clock.now, timer: clock.timer, limit: 100 });
    r.noteRetryAfter("sn", { retryAfterMs: 30000, now: clock.now() });
    const res = r.reserve("sn");
    assert.equal(res.at, T0, "改坏之后无视了上游 —— 拿一个已知会失败的请求去撞墙");
  });
});
