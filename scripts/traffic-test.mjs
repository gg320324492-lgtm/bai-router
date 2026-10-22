/**
 * scripts/traffic-test.mjs —— 流量页的纯逻辑（src/server/traffic.mjs）
 *
 * ## 这块是什么
 *
 *   面板的「流量」屏回答两件事：钱花到哪儿了（按天、按家）、哪些会话被钉在哪一家。
 *   traffic.mjs 把这两件事的算术做完（零 IO、零依赖、不读墙上的钟），
 *   cards/traffic-page.js 只负责把结果画出来。
 *
 * ## 口径（这里钉死的每一条都有用例）
 *
 *   · **时区**：按天分桶用**本机本地时区**的日历日（magpie 同款）。跨天的记录
 *     落在它自己那一刻的本地日历日：UTC 16:30 在 UTC+8 是次日 00:30 ⇒ 落次日。
 *     调用方可以用 `tzOffsetMinutes` 指定固定偏移（分钟，东为正）。
 *   · **attempts / calls / failed 三分**：账本里一次请求可能写好几行（网关内部
 *     试了多家，每家一行）。转交（handed_on）出去的尝试**不算失败**，但它仍写
 *     了自己的记录、可能已被厂商计费 ⇒ 它进 attempts、进 token 与费用，
 *     不进 calls、不进 failed。本地拒掉的（rejected）压根没到厂商 ⇒ 不算请求。
 *   · **估不出 ≠ 0**：费用拿不到是 null（「—」），不是 0。偏少的总价比没有总价更坏。
 *   · **查不到 ≠ 0**：会话在亲和表里、账本里查不到时，记 seen:false，
 *     不是「粘了 0 次」。
 *   · **req 与 served 是两件事**：账本里 `req` 是客户端问的、`served` 是厂商说
 *     它跑的，两者常常不同。本模块按 served 口径理解「厂商答了什么」。
 *
 * ## 纪律
 *
 *   ★ **真实现、不注入替身**：断言的是 src/server/traffic.mjs 原样 import 的那份。
 *   ★ **不许自己取时间**：模块内部不得出现 Date.now（有专门的源码断言）。
 *   ★ **每条关键断言都配反向对照**：见文件末尾「反向对照」一节——把源码里某个
 *     判定改坏，本文件的断言必须立刻变红，否则说明断言是空的。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  dayKeyOf,
  shiftDay,
  dailyBuckets,
  channelBreakdown,
  affinitySummary,
  buildTraffic,
} from "../src/server/traffic.mjs";

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

/** 固定偏移用「东为正」：UTC+8 = 480。用例一律显式给偏移，断言才不随机器时区翻。 */
const TZ8 = 480;
const TZ_MINUS5 = -300;

/** 2026-10-23T00:00:00Z —— 基准日的 UTC 零点。 */
const DAY_UTC = Date.parse("2026-10-23T00:00:00.000Z");

/** 造一条账本记录（usage-ledger 的形状：t 是 ISO 串，token 字段是 snake_case）。 */
function rec(over = {}) {
  return {
    t: new Date(DAY_UTC).toISOString(),
    provider: "wb",
    model: "m1",
    req: "claude-sonnet-5",
    served: "m1",
    in: 0,
    out: 0,
    cache_read: 0,
    cache_write: 0,
    status: 200,
    error: "",
    tries: 1,
    ms: 0,
    handed_on: false,
    rejected: false,
    ...over,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 时区口径
 * ══════════════════════════════════════════════════════════════════════ */

describe("时区口径：按本地日历日分桶", () => {
  test("跨天的记录落在它自己那一刻的本地日历日（UTC+8）", () => {
    /* UTC 2026-10-22T16:30Z ⇒ UTC+8 是 2026-10-23 00:30 ⇒ 落 10-23，不落 10-22。 */
    const ms = Date.parse("2026-10-22T16:30:00.000Z");
    assert.equal(dayKeyOf(ms, { tzOffsetMinutes: TZ8 }), "2026-10-23");
    /* 同一时刻在 UTC-5 是 10-22 11:30 ⇒ 落 10-22。同一份数据、两个时区、两个日子。 */
    assert.equal(dayKeyOf(ms, { tzOffsetMinutes: TZ_MINUS5 }), "2026-10-22");
  });

  test("本地时区（不注入偏移）时，与 Date 的本地年月日一致", () => {
    /* 这一条与运行机器的时区无关：它比的是「本模块算的」与「本机 Date 算的」。 */
    const ms = Date.parse("2026-03-08T06:30:00.000Z");   // 夏令时切换那天
    const d = new Date(ms);
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    assert.equal(dayKeyOf(ms, {}), local);
  });

  test("固定偏移是「东为正」：UTC+8 = 480", () => {
    /* 正负号搞反的话，全世界的日子都会差一天 —— 这条把它钉死。 */
    const ms = Date.parse("2026-10-23T20:00:00.000Z");
    assert.equal(dayKeyOf(ms, { tzOffsetMinutes: 480 }), "2026-10-24");
    assert.equal(dayKeyOf(ms, { tzOffsetMinutes: -480 }), "2026-10-23");
  });

  test("日历日加减不受夏令时影响（走 UTC 运算）", () => {
    assert.equal(shiftDay("2026-03-08", -1), "2026-03-07");
    assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
    assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  });

  test("时刻不对时返回空串，不猜", () => {
    assert.equal(dayKeyOf(Number.NaN, {}), "");
    assert.equal(dayKeyOf(undefined, {}), "");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ② 分桶口径：attempts / calls / failed / handed_on / rejected
 * ══════════════════════════════════════════════════════════════════════ */

describe("分桶口径", () => {
  const day = "2026-10-23";
  const mk = (ms) => new Date(ms).toISOString();

  test("转交的尝试：算尝试、不算请求、不算失败，但 token 与花费照算", () => {
    const recs = [
      rec({ t: mk(DAY_UTC + HOUR), in: 100, out: 10, status: 500, handed_on: true }),
      rec({ t: mk(DAY_UTC + HOUR), in: 200, out: 20, status: 200 }),
    ];
    const { days } = dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
    assert.equal(days.length, 1);
    const d = days[0];
    assert.equal(d.day, day);
    assert.equal(d.attempts, 2, "两条记录 = 两次尝试");
    assert.equal(d.calls, 1, "客户端只问了一次 —— 转交出去的那次尝试不是这次请求的结果");
    assert.equal(d.failed, 0, "转交不算失败（它已经把活交给下一个候选了）");
    assert.equal(d.handedOn, 1);
    assert.equal(d.tokensIn, 300, "转交那次也可能已被厂商计费，token 照算");
  });

  test("失败数只数真失败（状态码 ≥ 400 且不是转交）", () => {
    const recs = [
      rec({ t: mk(DAY_UTC + HOUR), status: 500 }),
      rec({ t: mk(DAY_UTC + HOUR), status: 404 }),
      rec({ t: mk(DAY_UTC + HOUR), status: 200 }),
      rec({ t: mk(DAY_UTC + HOUR), status: 503, handed_on: true }),
    ];
    const { days, totals } = dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
    assert.equal(days[0].failed, 2);
    assert.equal(days[0].calls, 3);
    assert.equal(totals.failed, 2);
  });

  test("本地拒掉的（rejected）不算请求，也不进 token", () => {
    const recs = [
      rec({ t: mk(DAY_UTC + HOUR), status: 403, rejected: true, in: 50, out: 5 }),
      rec({ t: mk(DAY_UTC + HOUR), status: 200, in: 10, out: 1 }),
    ];
    const { days } = dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
    const d = days[0];
    assert.equal(d.rejected, 1);
    assert.equal(d.calls, 1, "被拒的那次客户端没拿到答复，不算一次请求");
    assert.equal(d.failed, 0, "厂商没参与，不是失败");
    assert.equal(d.tokensIn, 10, "没到厂商的请求没有 token");
    assert.equal(d.attempts, 2);
  });

  test("时刻不明的记录不进时间线，但数目不藏（skipped）", () => {
    const recs = [
      rec({ t: mk(DAY_UTC + HOUR), in: 5 }),
      rec({ t: "不是时间", in: 5 }),
      rec({ t: "", in: 5 }),
    ];
    const { days, skipped } = dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
    assert.equal(days[0].attempts, 1);
    assert.equal(skipped, 2, "时刻不明的两条要报出来 —— 不猜它们是哪天");
  });

  test("同一天的记录归到一起，不同天分开", () => {
    const recs = [
      rec({ t: mk(DAY_UTC + 1 * HOUR), provider: "wb" }),
      rec({ t: mk(DAY_UTC + 20 * HOUR), provider: "sn" }),
    ];
    const { days } = dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
    assert.deepEqual(days.map((d) => d.day), ["2026-10-23", "2026-10-24"]);
    assert.equal(days[0].calls, 1);
    assert.equal(days[1].calls, 1);
  });

  test("中间没用的日子被补齐（时间线要连续）", () => {
    const recs = [
      rec({ t: mk(DAY_UTC + 1 * HOUR) }),
      rec({ t: mk(DAY_UTC + 72 * HOUR) }),
    ];
    const { days } = dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
    assert.deepEqual(days.map((d) => d.day), ["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"]);
    assert.equal(days[1].calls, 0, "那天没用是真的 0，不是「不知道」");
    assert.equal(days[1].cost, 0);
  });

  test("窗口：只留最近 N 天，窗口外的记录不进来", () => {
    const nowMs = DAY_UTC + 2 * HOUR;   // 「现在」= 10-23 02:00Z（UTC+8 是 10-23 10:00）
    const recs = [
      rec({ t: mk(DAY_UTC + 1 * HOUR) }),          // 10-23
      rec({ t: mk(DAY_UTC - 72 * HOUR) }),         // 10-20（窗口外）
    ];
    const { days } = dailyBuckets(recs, { tzOffsetMinutes: TZ8, nowMs, days: 3 });
    const keys = days.map((d) => d.day);
    assert.ok(keys.includes("2026-10-23"));
    assert.ok(!keys.includes("2026-10-20"), "窗口外的记录不能混进来");
    assert.equal(days.reduce((n, d) => n + d.calls, 0), 1);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ③ 费用口径
 * ══════════════════════════════════════════════════════════════════════ */

describe("费用口径", () => {
  const mk = (ms) => new Date(ms).toISOString();

  test("没给估价钩子 ⇒ 费用是「不知道」（null），不是 0", () => {
    const { days, totals } = dailyBuckets([rec({ t: mk(DAY_UTC), in: 100 })], { tzOffsetMinutes: TZ8 });
    assert.equal(days[0].cost, null);
    assert.equal(totals.cost, null);
    assert.equal(totals.costKnown, false);
  });

  test("钩子估不出 ⇒ 那天与总价都是 null（不是已知那几天的和）", () => {
    const recs = [
      rec({ t: mk(DAY_UTC + 1 * HOUR), in: 100 }),
      rec({ t: mk(DAY_UTC + 30 * HOUR), in: 100 }),
    ];
    const { days, totals } = dailyBuckets(recs, {
      tzOffsetMinutes: TZ8,
      /* 第二天那个模型估不出 —— 于是那天的费用是 null。 */
      costOf: (rs) => (rs.length && rs[0].in === 100 && rs[0].t.startsWith("2026-10-24") ? null : 0.01),
    });
    assert.equal(days.find((d) => d.day === "2026-10-23").cost, 0.01);
    assert.equal(days.find((d) => d.day === "2026-10-24").cost, null);
    assert.equal(totals.cost, null, "偏少的总价比没有总价更坏 —— 用户要拿它对账");
  });

  test("钩子给出的数字照单全收，空天是 0（真的 0）", () => {
    const recs = [rec({ t: mk(DAY_UTC + 1 * HOUR), in: 100 })];
    const { days, totals } = dailyBuckets(recs, {
      tzOffsetMinutes: TZ8,
      nowMs: DAY_UTC + 2 * HOUR,
      days: 3,
      costOf: (rs) => rs.length * 0.02,
    });
    assert.equal(days.find((d) => d.day === "2026-10-23").cost, 0.02);
    assert.equal(days.find((d) => d.day === "2026-10-22").cost, 0, "那天没有记录 ⇒ 花了 0 是真的 0");
    assert.equal(totals.cost, 0.02);
    assert.equal(totals.costKnown, true);
  });

  test("钩子按批次调用（每天一批），不是每条一次", () => {
    const recs = [
      rec({ t: mk(DAY_UTC + 1 * HOUR) }),
      rec({ t: mk(DAY_UTC + 1 * HOUR) }),
      rec({ t: mk(DAY_UTC + 30 * HOUR) }),
    ];
    const batches = [];
    dailyBuckets(recs, {
      tzOffsetMinutes: TZ8,
      costOf: (rs) => { batches.push(rs.length); return 0.01; },
    });
    assert.deepEqual(batches, [2, 1], "每天一批 —— 逐条估价会让价格表被反复查");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ④ 每家流量
 * ══════════════════════════════════════════════════════════════════════ */

describe("每家流量", () => {
  const mk = (ms) => new Date(ms).toISOString();

  test("按渠道分组，按请求数倒序，延迟取平均", () => {
    const recs = [
      rec({ t: mk(DAY_UTC + 1 * HOUR), provider: "wb", in: 10, out: 5, ms: 1000 }),
      rec({ t: mk(DAY_UTC + 2 * HOUR), provider: "wb", in: 10, out: 5, ms: 3000 }),
      rec({ t: mk(DAY_UTC + 3 * HOUR), provider: "sn", in: 99, out: 1, ms: 500 }),
    ];
    const chans = channelBreakdown(recs, { tzOffsetMinutes: TZ8 });
    assert.deepEqual(chans.map((c) => c.key), ["wb", "sn"], "请求多的在前");
    const wb = chans.find((c) => c.key === "wb");
    assert.equal(wb.calls, 2);
    assert.equal(wb.avgMs, 2000, "平均延迟 = 总时长 / 样本数");
    assert.equal(wb.maxMs, 3000);
    assert.equal(chans.find((c) => c.key === "sn").avgMs, 500);
  });

  test("没有时长的记录不算延迟样本（avgMs 为 null，不是 0）", () => {
    const chans = channelBreakdown([rec({ t: mk(DAY_UTC + 1 * HOUR), ms: 0 })], { tzOffsetMinutes: TZ8 });
    assert.equal(chans[0].avgMs, null);
    assert.equal(chans[0].maxMs, null);
  });

  test("渠道 key 原样带出（显示名由渲染层翻译，本模块不认识任何渠道）", () => {
    const chans = channelBreakdown([rec({ t: mk(DAY_UTC + 1 * HOUR), provider: "zzz" })], { tzOffsetMinutes: TZ8 });
    assert.equal(chans[0].key, "zzz");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 会话亲和
 * ══════════════════════════════════════════════════════════════════════ */

describe("会话亲和", () => {
  const mk = (ms) => new Date(ms).toISOString();
  const T = DAY_UTC + HOUR;

  test("账本侧：这个会话在这家被真的答过几次", () => {
    const recs = [
      rec({ t: mk(T), provider: "wb", session_provider: "sess-a", in: 10 }),
      rec({ t: mk(T + MIN), provider: "wb", session_provider: "sess-a", in: 10 }),
      rec({ t: mk(T), provider: "sn", session_provider: "sess-b", in: 10 }),
    ];
    const { sessions, totals } = affinitySummary(recs, [], { tzOffsetMinutes: TZ8 });
    const a = sessions.find((s) => s.session === "sess-a");
    assert.equal(a.channel, "wb");
    assert.equal(a.calls, 2, "粘了两次");
    assert.equal(a.pinned, false, "亲和表里没有 ⇒ 没钉住");
    assert.equal(a.seen, true);
    assert.equal(totals.sessions, 2);
    assert.equal(totals.sticks, 3);
  });

  test("亲和表侧：现在钉在哪个号上", () => {
    const recs = [rec({ t: mk(T), provider: "wb", session_provider: "sess-a" })];
    const affinity = [{
      channel: "wb",
      entries: [{
        key: "sess-a", target: "acct-1", at: T, used: T,
        meta: { cacheRead: 120, cacheWrite: 240, model: "m1" },
      }],
    }];
    const { sessions } = affinitySummary(recs, affinity, { tzOffsetMinutes: TZ8 });
    const a = sessions[0];
    assert.equal(a.account, "acct-1");
    assert.equal(a.pinned, true);
    assert.equal(a.cacheReadMeta, 120);
    assert.equal(a.cacheWriteMeta, 240);
    assert.equal(a.model, "m1");
  });

  test("亲和表里有、账本里查不到 ⇒ seen:false（查不到 ≠ 粘了 0 次）", () => {
    const affinity = [{
      channel: "wb",
      entries: [{ key: "sess-x", target: "acct-9", at: T, used: T, meta: {} }],
    }];
    const { sessions, totals } = affinitySummary([], affinity, { tzOffsetMinutes: TZ8 });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].seen, false);
    assert.equal(sessions[0].calls, 0, "查不到 ⇒ 0 次已知，**不是**「查得到 0 次」");
    assert.equal(totals.unseen, 1, "数目要报出来，不能藏");
    assert.equal(totals.pinned, 1);
  });

  test("会话 id 优先认 magpie 的 session 字段，再退回本仓的 session_provider", () => {
    const recs = [rec({ t: mk(T), provider: "wb", session: "sess-new", session_provider: "sess-old" })];
    const { sessions } = affinitySummary(recs, [], { tzOffsetMinutes: TZ8 });
    assert.equal(sessions[0].session, "sess-new");
  });

  test("同一个会话落在两家 ⇒ 两行（它被转交过）", () => {
    const recs = [
      rec({ t: mk(T), provider: "wb", session_provider: "sess-a", status: 500, handed_on: true }),
      rec({ t: mk(T + MIN), provider: "sn", session_provider: "sess-a" }),
    ];
    const { sessions, totals } = affinitySummary(recs, [], { tzOffsetMinutes: TZ8 });
    assert.equal(sessions.length, 2);
    assert.equal(totals.sessions, 1, "会话只有一个，但落了两家");
    assert.equal(sessions.find((s) => s.channel === "sn").calls, 1);
    assert.equal(sessions.find((s) => s.channel === "wb").calls, 0, "转交那次不是这次请求的结果");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 源码纪律
 * ══════════════════════════════════════════════════════════════════════ */

describe("源码纪律", () => {
  const SRC = new URL("../src/server/traffic.mjs", import.meta.url);
  const CARD = new URL("../src/server/cards/traffic-page.js", import.meta.url);
  const strip = (js) => js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("模块内部不得出现 Date.now（时刻一律由参数传入）", () => {
    const code = strip(readFileSync(SRC, "utf8"));
    assert.ok(!/Date\s*\.\s*now/.test(code),
      "traffic.mjs 内部取了真实时钟：同一份逻辑就没法被回放、被测试了");
  });

  test("模块零依赖：不许 import 仓库里任何模块，也不许碰 node 内置模块", () => {
    const code = strip(readFileSync(SRC, "utf8"));
    const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, [], "一个依赖都不许有：多一个依赖就多一份「它到底改没改」的疑问");
    assert.ok(!/require\(|node:/.test(code), "不许碰 node 内置模块（fs / path 那些）");
  });

  test("新文件的行尾必须是 LF（按文本锚点抠源码的测试会被 CRLF 弄崩）", () => {
    for (const f of [SRC, CARD]) {
      const text = readFileSync(f, "utf8");
      assert.ok(!text.includes("\r"), `${f.pathname} 里有 CRLF —— 仓库的文本锚点测试会全崩`);
    }
  });

  test("卡片里不许出现渠道名字面量（C11 的同一道纪律，cards/ 也守）", () => {
    const code = strip(readFileSync(CARD, "utf8"));
    /* 渠道名以「被当作字符串字面量比较」的形式出现才算犯忌；
       出现在注释或散文里不算（那是解释，不是判定）。 */
    for (const key of ["bai", "sn", "wb", "wbai", "zen", "qd", "or", "mm"]) {
      const rx = new RegExp(`["']${key}["']`);
      assert.ok(!rx.test(code), `卡片里出现了渠道名字面量 "${key}" —— 显示名必须走 ctx.nameOf(key)`);
    }
  });

  test("卡片只用语义类名，不许写死色值", () => {
    const code = strip(readFileSync(CARD, "utf8"));
    /* 十六进制色 / rgb() / hsl() 一律不许：写死色值就等于只支持一套主题。 */
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(code), "卡片里写了十六进制色值 —— 深浅两套主题会有一套读不了");
    assert.ok(!/\brgba?\s*\(/.test(code), "卡片里写了 rgb() 色值 —— 深浅两套主题会有一套读不了");
    assert.ok(!/\bhsla?\s*\(/.test(code), "卡片里写了 hsl() 色值 —— 深浅两套主题会有一套读不了");
  });

  test("卡片注册名与文件名一致（渲染层按 /cards/<name>.js 找 BAI_CARDS[<name>]）", () => {
    const code = readFileSync(CARD, "utf8");
    assert.ok(/window\.BAI_CARDS\s*=\s*window\.BAI_CARDS\s*\|\|\s*\{\}/.test(code));
    assert.ok(/window\.BAI_CARDS\["traffic-page"\]\s*=/.test(code),
      "注册名必须与文件名 traffic-page.js 一致");
    assert.ok(/mount\s*\(\s*ctx\s*\)/.test(code), "卡片必须导出 mount(ctx)");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 反向对照：把源码里的判定改坏，本文件的断言必须变红
 *
 * 做法：把 src/server/traffic.mjs 复制一份到临时目录，改坏其中一处，import 那份
 * 副本，重跑关键断言 —— 结果必须与原模块不同。「不同」即证明上面那些断言不是
 * 空的：源码一坏，它们就会红。
 *
 * （traffic.mjs 零依赖，所以只拷它一个文件就够。）
 * ══════════════════════════════════════════════════════════════════════ */

async function sabotage(replacements) {
  const dir = mkdtempSync(join(tmpdir(), "traffic-sabotage-"));
  let out = readFileSync(new URL("../src/server/traffic.mjs", import.meta.url), "utf8");
  for (const [from, to] of replacements) {
    assert.ok(out.includes(from), `待破坏的片段在源码里找不到：${from}`);
    /* 全部替换：有的片段在好几处出现（窗口过滤），只换第一处会漏。 */
    out = out.split(from).join(to);
  }
  writeFileSync(join(dir, "traffic.mjs"), out);
  return import(pathToFileURL(join(dir, "traffic.mjs")).href);
}

const mk = (ms) => new Date(ms).toISOString();

test("反向对照①：改坏「转交不算失败」，失败数必须变", async () => {
  const recs = [rec({ t: mk(DAY_UTC + HOUR), status: 500, handed_on: true })];
  const good = dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
  assert.equal(good.days[0].failed, 0, "正向：转交不是失败");

  const bad = await sabotage([["if (isHandedOn(rec)) {", "if (false) {"]]);
  const broken = bad.dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
  assert.equal(broken.days[0].failed, 1,
    "改坏之后转交的尝试被算成失败 —— 那正是「handed_on 不算失败」这条要防的");
  assert.notEqual(broken.days[0].failed, good.days[0].failed, "否则上面那些断言是空的");
});

test("反向对照②：改坏「转交那次仍计 token 与费用」，用量必须变", async () => {
  const recs = [rec({ t: mk(DAY_UTC + HOUR), status: 500, handed_on: true, in: 100, out: 10 })];
  const good = dailyBuckets(recs, { tzOffsetMinutes: TZ8, costOf: () => 0.5 });
  assert.equal(good.days[0].tokensIn, 100, "正向：转交那次可能已被厂商计费");

  const bad = await sabotage([
    ["if (!isRejected(rec)) {", "if (!isRejected(rec) && !isHandedOn(rec)) {"],
  ]);
  const broken = bad.dailyBuckets(recs, { tzOffsetMinutes: TZ8, costOf: () => 0.5 });
  assert.equal(broken.days[0].tokensIn, 0);
  assert.notEqual(broken.days[0].tokensIn, good.days[0].tokensIn, "否则上面那些断言是空的");
});

test("反向对照③：改坏时区偏移（当成 UTC），跨天记录必须落到隔壁那天", async () => {
  const recs = [rec({ t: "2026-10-22T16:30:00.000Z", in: 5 })];
  const good = dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
  assert.equal(good.days[0].day, "2026-10-23", "正向：UTC+8 下 00:30 属于 10-23");

  const bad = await sabotage([
    ["new Date(t + offsetAt(t, o.tzOffsetMinutes) * 60000)", "new Date(t) // SABOTAGE"],
  ]);
  const broken = bad.dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
  assert.equal(broken.days[0].day, "2026-10-22",
    "改坏之后按 UTC 分桶 —— 时区口径这条是整个页面的地基，错了整栏都错");
  assert.notEqual(broken.days[0].day, good.days[0].day, "否则上面那些断言是空的");
});

test("反向对照④：改坏「估不出就是 null」，费用必须变", async () => {
  const recs = [rec({ t: mk(DAY_UTC + HOUR), in: 5 })];
  const good = dailyBuckets(recs, { tzOffsetMinutes: TZ8, costOf: () => null });
  assert.equal(good.days[0].cost, null, "正向：估不出是 null");
  assert.equal(good.totals.cost, null);

  const bad = await sabotage([["if (v == null) return null;", "if (v == null) return 0;"]]);
  const broken = bad.dailyBuckets(recs, { tzOffsetMinutes: TZ8, costOf: () => null });
  assert.equal(broken.days[0].cost, 0,
    "改坏之后估不出的模型被当成 0 元 —— 一个错数字比没有数字更坏，用户要拿它对账");
  assert.notEqual(broken.days[0].cost, good.days[0].cost, "否则上面那些断言是空的");
});

test("反向对照⑤：改坏「本地拒掉的不算请求」，请求数必须变", async () => {
  const recs = [rec({ t: mk(DAY_UTC + HOUR), status: 403, rejected: true })];
  const good = dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
  assert.equal(good.days[0].calls, 0, "正向：被拒的那次不算请求");

  const bad = await sabotage([["} else if (isRejected(rec)) {", "} else if (false) {"]]);
  const broken = bad.dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
  assert.equal(broken.days[0].calls, 1);
  assert.notEqual(broken.days[0].calls, good.days[0].calls, "否则上面那些断言是空的");
});

test("反向对照⑥：改坏「窗口过滤」，窗口外的记录必须混进来", async () => {
  const nowMs = DAY_UTC + 2 * HOUR;
  const recs = [
    rec({ t: mk(DAY_UTC + 1 * HOUR) }),
    rec({ t: mk(DAY_UTC - 72 * HOUR) }),
  ];
  const good = dailyBuckets(recs, { tzOffsetMinutes: TZ8, nowMs, days: 3 });
  assert.equal(good.days.reduce((n, d) => n + d.calls, 0), 1, "正向：窗口外的不算");

  const bad = await sabotage([
    ["if (!from || !to) return true;\n  return day >= from && day <= to;", "return true;"],
  ]);
  const broken = bad.dailyBuckets(recs, { tzOffsetMinutes: TZ8, nowMs, days: 3 });
  assert.equal(broken.days.reduce((n, d) => n + d.calls, 0), 2,
    "改坏之后窗口形同虚设 —— 「最近 30 天」会变成「全部」");
  assert.notEqual(
    broken.days.reduce((n, d) => n + d.calls, 0),
    good.days.reduce((n, d) => n + d.calls, 0),
    "否则上面那些断言是空的");
});

test("反向对照⑦：改坏「补齐空白天」，时间线必须变短", async () => {
  const recs = [
    rec({ t: mk(DAY_UTC + 1 * HOUR) }),
    rec({ t: mk(DAY_UTC + 72 * HOUR) }),
  ];
  const good = dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
  assert.equal(good.days.length, 4, "正向：中间两天没用也占位（0 不是缺）");

  const bad = await sabotage([
    ["if (!accs.has(cur)) accs.set(cur, newAcc(cur));", "if (false) accs.set(cur, newAcc(cur));"],
  ]);
  const broken = bad.dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
  assert.equal(broken.days.length, 2, "改坏之后时间线只剩有记录的那两天 —— 空白看着像数据丢了");
  assert.notEqual(broken.days.length, good.days.length, "否则上面那些断言是空的");
});

test("反向对照⑧：改坏「会话 id 取自 session_provider」，会话必须查不到", async () => {
  const recs = [rec({ t: mk(DAY_UTC + HOUR), provider: "wb", session_provider: "sess-a" })];
  const good = affinitySummary(recs, [], { tzOffsetMinutes: TZ8 });
  assert.equal(good.sessions.length, 1, "正向：本仓把会话 id 写进 session_provider");

  const bad = await sabotage([
    ["return String(rec.session_provider == null ? \"\" : rec.session_provider).trim();",
      "return \"\"; // SABOTAGE"],
  ]);
  const broken = bad.affinitySummary(recs, [], { tzOffsetMinutes: TZ8 });
  assert.equal(broken.sessions.length, 0,
    "改坏之后会话亲和整栏空了 —— 而账本里明明有会话 id");
  assert.notEqual(broken.sessions.length, good.sessions.length, "否则上面那些断言是空的");
});

test("反向对照⑨：改坏「查不到 ≠ 0」的标记，unseen 必须变", async () => {
  const affinity = [{ channel: "wb", entries: [{ key: "sess-x", target: "acct-9", at: DAY_UTC, used: DAY_UTC, meta: {} }] }];
  const good = affinitySummary([], affinity, { tzOffsetMinutes: TZ8 });
  assert.equal(good.totals.unseen, 1, "正向：查不到要报出来");

  const bad = await sabotage([["row.seen = true;", "row.seen = false; // SABOTAGE"]]);
  const broken = bad.affinitySummary(
    [rec({ t: mk(DAY_UTC + HOUR), provider: "wb", session_provider: "sess-y" })],
    affinity, { tzOffsetMinutes: TZ8 });
  assert.equal(broken.totals.unseen, 2,
    "改坏之后连账本里查得到的那条也被说成「查不到」—— 数目对不上，用户会以为账本坏了");
  assert.notEqual(broken.totals.unseen, good.totals.unseen, "否则上面那些断言是空的");
});

test("反向对照⑩：改坏「token 合计只算进出」，量条占比必须变", async () => {
  const recs = [
    rec({ t: mk(DAY_UTC + 1 * HOUR), in: 10, out: 5, cache_read: 1000 }),
  ];
  const good = dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
  assert.equal(good.days[0].tokens, 15, "正向：缓存读不进 token 合计（它是折扣档）");

  const bad = await sabotage([
    ["tokens: acc.tokensIn + acc.tokensOut,", "tokens: acc.tokensIn + acc.tokensOut + acc.cacheRead,"],
  ]);
  const broken = bad.dailyBuckets(recs, { tzOffsetMinutes: TZ8 });
  assert.equal(broken.days[0].tokens, 1015);
  assert.notEqual(broken.days[0].tokens, good.days[0].tokens, "否则上面那些断言是空的");
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 汇总入口
 * ══════════════════════════════════════════════════════════════════════ */

test("buildTraffic 一次给出三块：按天 · 按家 · 会话亲和", () => {
  const recs = [
    rec({ t: mk(DAY_UTC + HOUR), provider: "wb", session_provider: "sess-a", in: 100, out: 50 }),
    rec({ t: mk(DAY_UTC + 30 * HOUR), provider: "sn", session_provider: "sess-b", in: 10, out: 5 }),
  ];
  const affinity = [{
    channel: "wb",
    entries: [{ key: "sess-a", target: "acct-1", at: DAY_UTC + HOUR, used: DAY_UTC + HOUR, meta: { cacheRead: 8, cacheWrite: 16 } }],
  }];
  const r = buildTraffic(recs, {
    tzOffsetMinutes: TZ8, nowMs: DAY_UTC + 31 * HOUR, days: 3,
    costOf: (rs) => rs.length * 0.01,
    affinity,
  });
  assert.equal(r.days.length, 3, "窗口内中间那天也占位");
  assert.equal(r.totals.calls, 2);
  assert.equal(r.totals.cost, 0.02);
  assert.deepEqual(r.channels.map((c) => c.key).sort(), ["sn", "wb"]);
  assert.equal(r.affinity.totals.sessions, 2);
  assert.equal(r.affinity.totals.pinned, 1);
  assert.equal(r.affinity.sessions.find((s) => s.session === "sess-a").account, "acct-1");
});

test("空账本不炸：给出空的天、空的渠道、空的会话", () => {
  const r = buildTraffic([], { tzOffsetMinutes: TZ8, nowMs: DAY_UTC, days: 3 });
  assert.equal(r.days.length, 3);
  assert.equal(r.totals.calls, 0);
  assert.equal(r.totals.cost, 0, "一次调用都没有 ⇒ 花了 0 是**事实**（与有没有价格表无关）");
  assert.deepEqual(r.channels, []);
  assert.deepEqual(r.affinity.sessions, []);
});
