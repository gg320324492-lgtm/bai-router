/**
 * scripts/quota-test.mjs —— 配额预算与配额感知排序（src/server/quota.mjs）
 *
 * ## 这块是什么
 *
 *   magpie 的 T9 是**查供应商的配额接口**（internal/provider/quotas.go）：拿着
 *   登录态去问 Anthropic / OpenAI / GitHub，拿到一组 QuotaWindow，routing 再拿它
 *   排（internal/provider/routing.go 的 Allowance）。
 *
 *   bai-router 没有那个前提（渠道不是 OAuth 登录态，供应商也不暴露配额 API），
 *   所以本文件验的是**被动信号版**：用户给每家设一个额度预算，我们拿账本里
 *   已经记着的 token 去对照，超了让那家休息。
 *
 * ## 单位与口径
 *
 *   · 预算的单位是 **token 数**（不是钱）：账本里没有价格字段，算钱要外挂价格表，
 *     而价格表会随厂商调价漂移。
 *   · 计入 in + out + cache_write；**不计 cache_read**（读缓存是折扣档，
 *     Claude Code 这类客户端的缓存读取量极大，算进去预算一次长对话就打满）。
 *   · `ratio` 是**百分比 0–100**，与 routes.Seat.used 同一口径（不是 0–1 比例）。
 *
 * ## 纪律
 *
 *   ★ **真实现、不注入替身**：断言的是 src/server/quota.mjs 与 src/server/routes.mjs
 *     原样 import 的那两份。
 *   ★ **排序不另写一套**：文件里用真的 routes.Builtin.smart 验证「配额压力喂进
 *     Seat.used 之后顺序确实变了」—— 这正是本模块不许自造排序器的根据。
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
  QUOTA_UNIT,
  BUDGET_KIND,
  budgetOf,
  usageInWindow,
  usagePartsInWindow,
  quotaState,
  quotaWeights,
  applyQuotaToSeat,
  applyProbeToSeat,
  budgetRestNote,
  budgetRestUntil,
  budgetRestDecision,
} from "../src/server/quota.mjs";
import { Seat, Smart, apply } from "../src/server/routes.mjs";

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

/** 整点基准：小时窗口的边界在非整点基准上不好读。 */
const T0 = Math.floor(1_700_000_000_000 / HOUR) * HOUR;
const at = (h) => T0 + h * HOUR;

/**
 * 本地凌晨两点：做「天窗口」用例的基准。
 * 为什么不用 T0：本地时间在凌晨两点时，now-1h 一定还在同一天里 —— 若基准落在
 * 午夜前后一小时，「一小时前那条记录算不算今天」就会随运行环境的时区翻来覆去。
 */
const D0 = (() => {
  const d = new Date(T0);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 2, 0, 0, 0).getTime();
})();

/** 造一条账本记录（usage-ledger 的形状：t 是 ISO 串，token 字段是 snake_case）。 */
function rec(provider, ms, tk = {}) {
  return {
    t: new Date(ms).toISOString(),
    provider,
    in: tk.in || 0,
    out: tk.out || 0,
    cache_read: tk.cacheRead || 0,
    cache_write: tk.cacheWrite || 0,
    status: tk.status == null ? 200 : tk.status,
  };
}

/** 一份只给 bai 设了预算的配置。 */
const CFG = {
  quota: {
    bai: { unit: "tokens", hourly: 1000, daily: 10000 },
  },
};

/* ══════════════════════════════════════════════════════════════════════
 * ① 预算：budgetOf
 * ══════════════════════════════════════════════════════════════════════ */

describe("budgetOf —— 从配置里读这一家的额度预算", () => {
  test("① 没配预算 → null（不是一个上限为 0 的对象）", () => {
    assert.equal(budgetOf("sn", CFG), null);
    assert.equal(budgetOf("bai", {}), null);
    assert.equal(budgetOf("bai", { quota: {} }), null);
  });

  test("② 对象写法 → provider / unit / hourly / daily", () => {
    assert.deepEqual(budgetOf("bai", CFG), {
      provider: "bai", unit: "tokens", hourly: 1000, daily: 10000,
    });
  });

  test("③ 裸数字 → 当成每天的上限（一个数只配一个窗口时「每天」更不容易误伤）", () => {
    assert.deepEqual(budgetOf("sn", { quota: { sn: 5000 } }), {
      provider: "sn", unit: "tokens", hourly: null, daily: 5000,
    });
  });

  test("④ 上限是 0 或负数 → 当「没设」（猜错方向是灾难：整家永久休息）", () => {
    assert.equal(budgetOf("sn", { quota: { sn: { hourly: 0 } } }), null);
    assert.equal(budgetOf("sn", { quota: { sn: { hourly: -5 } } }), null);
    assert.equal(budgetOf("sn", { quota: { sn: { hourly: 0, daily: 10 } } }).hourly, null);
  });

  test("⑤ 单位写错 → 当场炸（静默忽略等于让用户以为预算生效了）", () => {
    assert.throws(
      () => budgetOf("bai", { quota: { bai: { unit: "usd", hourly: 10 } } }),
      /只认 "tokens"/,
    );
  });

  test("⑥ 渠道 id 大小写/空白归一（账本里写 Bai、配置里写 bai 也算同一家）", () => {
    assert.equal(budgetOf(" BAI ", CFG).provider, "bai");
  });

  test("⑦ 次位置：渠道自己的块里带 quota 也认（顶层 quota 优先）", () => {
    const cfg = { sn: { quota: { hourly: 700 } }, quota: { sn: { hourly: 300 } } };
    assert.equal(budgetOf("sn", cfg).hourly, 300, "两处都写了以顶层为准");
    assert.equal(budgetOf("wb", { wb: { quota: { hourly: 700 } } }).hourly, 700);
    assert.equal(budgetOf("sn", { sn: { quota: 5000 } }).daily, 5000);
  });

  test("⑧ 数字串的上限按数字收（手改 JSON 的常见手滑），但读不出数就炸", () => {
    assert.equal(budgetOf("sn", { quota: { sn: { hourly: "1000" } } }).hourly, 1000);
    assert.throws(() => budgetOf("sn", { quota: { sn: { hourly: "一千" } } }), /上限要是一个数/);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ② 用量折算：usageInWindow
 * ══════════════════════════════════════════════════════════════════════ */

describe("usageInWindow —— 账本 → 窗口内的 token 数", () => {
  test("① 只算本 provider、只算窗口内的", () => {
    const recs = [
      rec("bai", T0 - 2 * HOUR, { in: 100 }),     // 窗口外
      rec("bai", T0 + 30 * MIN, { out: 50 }),     // 窗口内
      rec("sn", T0 + 30 * MIN, { in: 999 }),      // 别的 provider
    ];
    // 窗口起点 = T0：第一条（两小时前）不在窗口里，第三条不是这一家。
    assert.equal(usageInWindow(recs, "bai", T0), 50);
    assert.equal(usageInWindow(recs, "sn", T0 - 2 * HOUR), 999);
  });

  test("② 计入 in + out + cache_write，**不计 cache_read**", () => {
    const recs = [rec("bai", T0, { in: 10, out: 20, cacheWrite: 30, cacheRead: 9999 })];
    assert.equal(usageInWindow(recs, "bai", T0), 60);
    const parts = usagePartsInWindow(recs, "bai", T0);
    assert.equal(parts.cacheRead, 9999, "缓存读取照样如实记下来，只是不计入预算");
    assert.equal(parts.total, 60);
  });

  test("③ 失败的尝试照算（上游可能已经计费了）", () => {
    const recs = [rec("bai", T0, { in: 40, status: 500 })];
    assert.equal(usageInWindow(recs, "bai", T0), 40);
  });

  test("④ 时间读不出的记录照算（宁可早休息，也不要多花）", () => {
    const recs = [{ provider: "bai", in: 7, out: 3 }];
    assert.equal(usageInWindow(recs, "bai", T0), 10);
  });

  test("⑤ 空账本 / 不认识的一家 → 0", () => {
    assert.equal(usageInWindow([], "bai", T0), 0);
    assert.equal(usageInWindow([rec("sn", T0, { in: 5 })], "bai", T0), 0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ③ 预算判定：quotaState
 * ══════════════════════════════════════════════════════════════════════ */

describe("quotaState —— 预算还剩多少", () => {
  test("① ratio 是百分比 0–100（与 Seat.used 同一口径，不是 0–1 比例）", () => {
    const st = quotaState("bai", CFG, [rec("bai", T0, { in: 250 })], T0);
    assert.equal(st.used, 250);
    assert.equal(st.limit, 1000);
    assert.equal(st.ratio, 25);
    assert.equal(st.exhausted, false);
    assert.equal(st.window, "hourly");
  });

  test("② 用满了 → exhausted（used ≥ limit，不看浮点 ratio）", () => {
    const st = quotaState("bai", CFG, [rec("bai", T0, { in: 1000 })], T0);
    assert.equal(st.exhausted, true);
    assert.equal(st.ratio, 100);
  });

  test("③ 两条窗口都配 → 取**更紧**的那条（ratio 高的）", () => {
    // 小时：900/1000 = 90%；天：900/10000 = 9% → 小时更紧
    const st = quotaState("bai", CFG, [rec("bai", T0, { in: 900 })], T0);
    assert.equal(st.window, "hourly");
    assert.equal(st.ratio, 90);
    assert.equal(st.windows.daily.ratio, 9, "另一条窗口的明细也在返回值里");
  });

  test("④ 两条一样紧 → 取更早重置的那条（magpie 的 mergeWindows 口径）", () => {
    const cfg = { quota: { bai: { hourly: 100, daily: 100 } } };
    const st = quotaState("bai", cfg, [rec("bai", D0, { in: 50 })], D0);
    assert.equal(st.ratio, 50);
    assert.equal(st.window, "hourly", "小时窗口先到，就按它");
  });

  test("⑤ 小时窗口的 resetAtMs = 下一个整点", () => {
    const st = quotaState("bai", CFG, [], T0 + 17 * MIN);
    assert.equal(st.resetAtMs, T0 + HOUR);
  });

  test("⑥ 过了边界自动恢复（新窗口从零算，不必谁去撤销休息）", () => {
    const cfg = { quota: { bai: { hourly: 1000 } } };
    const recs = [rec("bai", T0, { in: 1000 })];
    assert.equal(quotaState("bai", cfg, recs, T0).exhausted, true);
    // 一小时后：那条记录已经不在新窗口里 → 预算重新可用
    const after = quotaState("bai", cfg, recs, T0 + HOUR);
    assert.equal(after.exhausted, false);
    assert.equal(after.used, 0);
    assert.equal(after.resetAtMs, T0 + 2 * HOUR);
  });

  test("⑦ 天窗口：resetAtMs 是下一个本地午夜", () => {
    const cfg = { quota: { bai: { daily: 10000 } } };
    const st = quotaState("bai", cfg, [], D0);
    const d = new Date(st.resetAtMs);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
    assert.ok(st.resetAtMs > D0);
    assert.ok(st.resetAtMs - D0 <= 24 * HOUR);
  });

  test("⑧ 天窗口只算今天（昨天那条不算）", () => {
    const cfg = { quota: { bai: { daily: 1000 } } };
    const st = quotaState("bai", cfg, [rec("bai", D0 - 3 * HOUR, { in: 900 })], D0);
    assert.equal(st.used, 0, "昨天凌晨三点的那条不在今天里");
    const st2 = quotaState("bai", cfg, [rec("bai", D0, { in: 900 })], D0);
    assert.equal(st2.used, 900);
  });

  test("⑨ 没配预算 → 不是用尽，也没有窗口", () => {
    const st = quotaState("sn", CFG, [rec("sn", T0, { in: 99999 })], T0);
    assert.equal(st.exhausted, false);
    assert.equal(st.window, "");
    assert.equal(st.ratio, 0);
    assert.equal(st.resetAtMs, null);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ④ 配额压力：quotaWeights + applyQuotaToSeat
 * ══════════════════════════════════════════════════════════════════════ */

describe("quotaWeights / applyQuotaToSeat —— 压力喂进 routes 的座位", () => {
  test("① quotaWeights 给每一家配了预算的渠道算一条", () => {
    const cfg = { quota: { bai: { hourly: 1000 }, sn: { daily: 500 } } };
    const w = quotaWeights([rec("bai", T0, { in: 200 })], cfg, T0);
    assert.deepEqual(Object.keys(w).sort(), ["bai", "sn"]);
    assert.equal(w.bai.used, 200);
    assert.equal(w.bai.limit, 1000);
    assert.equal(w.bai.ratio, 20);
    assert.equal(w.bai.usedPct, 20);
    assert.equal(w.bai.exhausted, false);
    assert.equal(w.bai.resetAtMs, T0 + HOUR);
  });

  test("② usedPct 取整到整百分比（Seat 拒绝 (0,1) 这一段：那是比例当百分数传的哨兵）", () => {
    const cfg = { quota: { bai: { hourly: 100000 } } };
    const w = quotaWeights([rec("bai", T0, { in: 50 })], cfg, T0);   // 0.05%
    assert.equal(w.bai.ratio, 0.05);
    assert.equal(w.bai.usedPct, 0);
    const seat = applyQuotaToSeat(new Seat({ key: "bai" }), w.bai);
    assert.equal(seat.used, 0, "取整后不可能落进 (0,1)");
  });

  test("③ 权重系数随压力下降", () => {
    const cfg = { quota: { bai: { hourly: 1000 } } };
    const w = quotaWeights([rec("bai", T0, { in: 250 })], cfg, T0);
    assert.equal(w.bai.weightFactor, 0.75);
  });

  test("④ applyQuotaToSeat：used 取 max（上游的硬事实与自己估的，取更紧的）", () => {
    const seat = new Seat({ key: "bai", used: 90 });
    const out = applyQuotaToSeat(seat, { usedPct: 30, known: true, weightFactor: 1 });
    assert.equal(out.used, 90, "上游说 90% 就是 90%，不能被我们自己的估算拉低");

    const seat2 = new Seat({ key: "bai", used: 10 });
    const out2 = applyQuotaToSeat(seat2, { usedPct: 95, known: true, weightFactor: 0.05 });
    assert.equal(out2.used, 95, "自己估的更紧就按更紧的走");
  });

  test("⑤ applyQuotaToSeat：weight 按压力缩，且不低于 1", () => {
    const seat = new Seat({ key: "bai", weight: 4 });
    assert.equal(applyQuotaToSeat(seat, { usedPct: 50, weightFactor: 0.5 }).weight, 2);
    assert.equal(applyQuotaToSeat(seat, { usedPct: 99, weightFactor: 0.1 }).weight, 1);
  });

  test("⑥ applyQuotaToSeat：不动 pace 与 soon（pace 的方向是反的）", () => {
    const seat = new Seat({ key: "bai", used: 5, soon: [at(3)], pace: 12 });
    const out = applyQuotaToSeat(seat, { usedPct: 90, weightFactor: 0.2 });
    assert.deepEqual(out.soon, [at(3)], "续期次序是上游额度窗口的事，不塞预算的重置时刻");
    assert.equal(out.pace, 12, "routes 的 pace 是「摊得快先用掉」，与预算压力方向相反");
  });

  test("⑦ 没有配额信息 → 座位原样返回", () => {
    const seat = new Seat({ key: "bai", used: 42 });
    assert.equal(applyQuotaToSeat(seat, null), seat);
  });

  test("⑧ ★ 排序不另写一套：压力喂进 Seat.used 后，routes.Builtin.smart 的顺序真的变了", () => {
    const seats = [
      new Seat({ key: "bai", used: 0, soon: [at(5)] }),
      new Seat({ key: "sn", used: 0, soon: [at(5)] }),
    ];
    // 同样条件下：稳定排序保持原序
    assert.deepEqual(apply(Smart, "chain", seats, T0), [0, 1]);

    // bai 的预算烧到 95% → 它的 used 变成 95 → 进「低」档 → 排到 sn 后面
    const cfg = { quota: { bai: { hourly: 1000 } } };
    const w = quotaWeights([rec("bai", T0, { in: 950 })], cfg, T0);
    const pressured = seats.map((s, i) => applyQuotaToSeat(s, w[s.key]));
    assert.equal(pressured[0].used, 95);
    assert.deepEqual(apply(Smart, "chain", pressured, T0), [1, 0],
      "预算压力靠 routes 已有的分档机制生效，没有另写排序器");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 休息：预算耗尽 → 让这家歇到窗口重置
 * ══════════════════════════════════════════════════════════════════════ */

describe("休息：预算耗尽的归因必须与「上游额度用尽」分开", () => {
  test("① 归因标签是 budget，**不是** candidates 里的 quota/credit", () => {
    const st = quotaState("bai", CFG, [rec("bai", T0, { in: 1000 })], T0);
    const note = budgetRestNote(st, "bai");
    assert.equal(note.kind, BUDGET_KIND);
    assert.equal(note.kind, "budget");
    assert.notEqual(note.kind, "quota", "混用会让面板显示一个没发生过的上游额度耗尽");
    assert.notEqual(note.kind, "credit");
  });

  test("② why 说清楚是自己的估算、到点自动恢复", () => {
    const st = quotaState("bai", CFG, [rec("bai", T0, { in: 1000 })], T0);
    const note = budgetRestNote(st, "bai");
    assert.match(note.why, /本地额度预算/);
    assert.match(note.why, /不是上游额度用尽/);
    assert.equal(note.scope, "account", "预算是按渠道设的 → 整号休息");
    assert.equal(note.budget.limit, 1000);
  });

  test("③ 休息到窗口重置的那一刻（到点即自动恢复）", () => {
    const st = quotaState("bai", CFG, [rec("bai", T0, { in: 1000 })], T0);
    assert.equal(budgetRestUntil(st), st.resetAtMs);
    assert.equal(budgetRestUntil(st), T0 + HOUR);
  });

  test("④ budgetRestDecision：没耗尽不休息；耗尽才休息", () => {
    const ok = budgetRestDecision("bai", CFG, [rec("bai", T0, { in: 10 })], T0);
    assert.equal(ok.rest, false);
    assert.equal(ok.note, null);

    const bad = budgetRestDecision("bai", CFG, [rec("bai", T0, { in: 1000 })], T0);
    assert.equal(bad.rest, true);
    assert.equal(bad.untilMs, T0 + HOUR);
    assert.equal(bad.note.kind, BUDGET_KIND);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑤b 上游真报的余额 → 座位（applyProbeToSeat）
 *
 * 这是 T9 的最后一块：转移链的排序除了「我们自己估的预算」，还要看
 * 「上游自己报的余额」—— 后者是真值，权威。
 *
 * ⚠ 最容易写反的一条：**探不到 ≠ 0，也 ≠ 100**。
 *   把「探不到」当成 0% → 那家看起来「额度富余」被排到最前（真相可能是欠费了）；
 *   把它当成 100% → 一家好渠道因为网络不通被踢到最后。
 *   正确做法：没有信号 = 一个字节都不改。
 * ══════════════════════════════════════════════════════════════════════ */

describe("applyProbeToSeat —— 上游真报的余额折进座位", () => {
  const base = () => new Seat({ key: "sn", used: 0, weight: 1 });

  test("① 上游说用了 99% → 座位 used 变成 99", () => {
    const s = applyProbeToSeat(base(), { known: true, used: 99, limit: 100, unit: "requests" });
    assert.equal(s.used, 99);
  });

  test("② 探不到 → 座位一个字都不改（不是 0，也不是 100）", () => {
    const b = base();
    const s = applyProbeToSeat(b, { known: false, used: null, limit: null, unit: "unknown", error: "探不到" });
    assert.equal(s.used, 0, "探不到不许变成 0%（那会让它显得额度富余）");
    assert.equal(s.known, false, "探不到不许变成「我们知道了」");
    assert.equal(s, b, "探不到时原样返回同一个座位");
  });

  test("③ 没有分母（limit 为 0 或缺失）→ 没有信号", () => {
    const b = base();
    assert.equal(applyProbeToSeat(b, { known: true, used: 5, limit: 0 }).used, 0,
      "limit 为 0 时没有比例可言（0/0 不是 0%）");
    assert.equal(applyProbeToSeat(b, { known: true, used: 5, limit: null }).used, 0);
  });

  test("④ 取 max：上游报的更高时，不能被我们自己的估计压低", () => {
    const s = applyProbeToSeat(new Seat({ key: "sn", used: 30 }), { known: true, used: 90, limit: 100 });
    assert.equal(s.used, 90, "上游是硬事实，我们的估计不能把它压低");
  });

  test("⑤ 上游说用完了 → 排到最后，但不踢出候选", () => {
    const s = applyProbeToSeat(base(), { known: true, used: 100, limit: 100 });
    assert.equal(s.used, 100, "routes 的 smart 策略把 used≥98 算「spent」档 → 排最后");
    assert.equal(s.resting, false,
      "不许踢出候选：所有渠道都冷却时会变成「没有渠道」，用户看到的是一句没有出处的失败");
  });

  test("⑥ 只给百分比的上游（limit=100 是分母）也算得出来", () => {
    const s = applyProbeToSeat(base(), { known: true, used: 37, limit: 100, unit: "unknown" });
    assert.equal(s.used, 37);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 硬规矩：内部不取时钟
 * ══════════════════════════════════════════════════════════════════════ */

test("模块源码里不得出现 Date.now（时间一律由参数传入）", () => {
  const src = readFileSync(new URL("../src/server/quota.mjs", import.meta.url), "utf8");
  // 先把注释剥掉：注释里写着「不调 Date.now」是规矩本身，不是犯规。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/Date\s*\.\s*now/.test(code),
    "quota.mjs 内部取了真实时钟：同一份逻辑就没法被回放、被测试了");
});

test("模块只许 import routes.mjs（纯逻辑、零依赖；别的模块一概不许）", () => {
  const src = readFileSync(new URL("../src/server/quota.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["./routes.mjs"],
    "只许依赖 routes.mjs：多一个依赖就多一份「它到底改没改」的疑问");
  assert.ok(!/require\(|node:/.test(code), "不许碰 node 内置模块（fs / path 那些）");
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 反向对照：把源码里的判定改坏，本文件的断言必须变红
 *
 * 做法：把 src/server/quota.mjs 复制一份到临时目录，改坏其中一处，import 那份
 * 副本，重跑关键断言 —— 结果必须与原模块不同。「不同」即证明上面那些断言不是
 * 空的：源码一坏，它们就会红。
 *
 * （routes.mjs 一并拷过去：quota.mjs 要 import 它。）
 * ══════════════════════════════════════════════════════════════════════ */

async function sabotage(replacements) {
  const dir = mkdtempSync(join(tmpdir(), "quota-sabotage-"));
  let out = readFileSync(new URL("../src/server/quota.mjs", import.meta.url), "utf8");
  for (const [from, to] of replacements) {
    assert.ok(out.includes(from), `待破坏的片段在源码里找不到：${from}`);
    out = out.replace(from, to);
  }
  writeFileSync(join(dir, "quota.mjs"), out);
  writeFileSync(join(dir, "routes.mjs"),
    readFileSync(new URL("../src/server/routes.mjs", import.meta.url), "utf8"));
  return import(pathToFileURL(join(dir, "quota.mjs")).href);
}

test("反向对照①：改坏「取更紧的那条窗口」，判定结果必须变", async () => {
  const recs = [rec("bai", T0, { in: 90 })];
  const good = quotaState("bai", CFG, recs, T0);
  assert.equal(good.window, "hourly");

  const bad = await sabotage([
    ["if (a.ratio !== b.ratio) return a.ratio > b.ratio;", "if (a.ratio !== b.ratio) return a.ratio < b.ratio;"],
  ]);
  const broken = bad.quotaState("bai", CFG, recs, T0);
  assert.notEqual(broken.window, good.window, "挑窗口的判据一坏，结果就该不一样——否则上面的断言是空的");
});

test("反向对照②：改坏「缓存读取不计入」，用量必须变", async () => {
  const recs = [rec("bai", T0, { in: 10, out: 20, cacheWrite: 30, cacheRead: 9999 })];
  const good = usageInWindow(recs, "bai", T0);
  assert.equal(good, 60);

  const bad = await sabotage([
    ["out.total = out.in + out.out + out.cacheWrite;",
      "out.total = out.in + out.out + out.cacheWrite + out.cacheRead;"],
  ]);
  const broken = bad.usageInWindow(recs, "bai", T0);
  assert.notEqual(broken, good, "把缓存读取算进去，预算的含义就变了——否则上面的断言是空的");
});

test("反向对照③：改坏「用满即耗尽」的判定，exhausted 必须变", async () => {
  const recs = [rec("bai", T0, { in: 1000 })];
  const good = quotaState("bai", CFG, recs, T0);
  assert.equal(good.exhausted, true);

  const bad = await sabotage([["c.exhausted = c.used >= c.limit;", "c.exhausted = false;"]]);
  const broken = bad.quotaState("bai", CFG, recs, T0);
  assert.notEqual(broken.exhausted, good.exhausted, "耗尽判定一坏，休息与排序都跟着坏——否则上面的断言是空的");
});

test("反向对照④：改坏 ratio 的口径（百分比 → 比例），必须现形", async () => {
  const recs = [rec("bai", T0, { in: 250 })];
  const good = quotaState("bai", CFG, recs, T0);
  assert.equal(good.ratio, 25);

  const bad = await sabotage([
    ["c.ratio = clampPct((c.used / c.limit) * 100);", "c.ratio = clampPct(c.used / c.limit);"],
  ]);
  const broken = bad.quotaState("bai", CFG, recs, T0);
  assert.notEqual(broken.ratio, good.ratio, "比例与百分比混用是静默的口径错——断言必须抓得住");
});

test("反向对照⑤：改坏「小时窗口从整点起算」，resetAtMs 必须变", async () => {
  const good = quotaState("bai", CFG, [], T0 + 17 * MIN);
  assert.equal(good.resetAtMs, T0 + HOUR);

  const bad = await sabotage([
    ["const start = Math.floor(now / HOUR_MS) * HOUR_MS;", "const start = now;"],
  ]);
  const broken = bad.quotaState("bai", CFG, [], T0 + 17 * MIN);
  assert.notEqual(broken.resetAtMs, good.resetAtMs, "窗口边界一坏，休息的到期时刻就跟着错——否则上面的断言是空的");
});

test("反向对照⑥：改坏「探不到 = 不动」，判定必须现形", async () => {
  const good = applyProbeToSeat(new Seat({ key: "sn" }), { known: false, used: null, limit: null });
  assert.equal(good.used, 0, "正向：探不到 → 座位不动");

  const bad = await sabotage([
    ["if (!probe || probe.known !== true) return s;",
      "if (!probe || probe.known !== true) return new Seat({ key: s.key, used: 100, weight: 1 }); // SABOTAGE"],
  ]);
  const broken = bad.applyProbeToSeat(new Seat({ key: "sn" }), { known: false, used: null, limit: null });
  assert.equal(broken.used, 100,
    "改坏之后「探不到」被当成用完了 —— 正是「探不到 ≠ 0 也 ≠ 100」那条要防的");
  assert.notEqual(broken.used, good.used, "否则上面那些断言是空的");
});

test("反向对照⑦：改坏「取 max」，上游的真值必须能压过我们的估计", async () => {
  const good = applyProbeToSeat(new Seat({ key: "sn", used: 30 }), { known: true, used: 90, limit: 100 });
  assert.equal(good.used, 90);

  const bad = await sabotage([
    ["const merged = Math.max(Math.round(clampPct(num(s.used) ?? 0)), pct);",
      "const merged = Math.round(clampPct(num(s.used) ?? 0)); // SABOTAGE: 不取 max"],
  ]);
  const broken = bad.applyProbeToSeat(new Seat({ key: "sn", used: 30 }), { known: true, used: 90, limit: 100 });
  assert.equal(broken.used, 30, "改坏之后上游的真值被我们自己的估计盖住了");
  assert.notEqual(broken.used, good.used, "否则上面那些断言是空的");
});
