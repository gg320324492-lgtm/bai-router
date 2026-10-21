/* 额度模型（allowance）的判据测试。
 *
 * 这套判据是「配额感知路由」的地基：路由要用它回答三个问题——
 *   ① 这个号还能不能接这个模型？（fullAt / pooledAt）
 *   ② 什么时候能再接？（renewalOf / runsOutAt）
 *   ③ 它的额度摊得有多快，要不要早点让出去？（paceOf）
 *
 * 参照 magpie：internal/provider/routing.go 的 Allowance、
 * internal/provider/codex_switch.go 的 SpentShare。
 *
 * 全部时刻都是写死的（NOW），**没有一个 Date.now()** —— 窗口里的时间一律由参数
 * 传进来，这是这个模块的硬规矩之一（见 allowance.mjs 的文件头）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  makeWindow,
  windowShare,
  estimateShare,
  runsOutAt,
  renewalOf,
  paceOf,
  fullAt,
  pooledAt,
  appliesTo,
  fromSignals,
  mergeWindows,
  readResetSignals,
  SPENT_SHARE,
  SPENT_SHARE_OF,
} from "../src/server/allowance.mjs";

const NOW = 1_700_000_000_000;   // 固定的「现在」，epoch 毫秒
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe("fromSignals —— 把已有的信号归一成一条窗口", () => {
  test("① resetsAt（X-RateLimit-Reset 来的）→ resetsAt + 距今秒数 + 跨度", () => {
    const w = fromSignals({ now: NOW, resetsAt: NOW + 6 * HOUR, span: 24 * HOUR });
    assert.equal(w.resetsAt, NOW + 6 * HOUR, "重置时刻要如实落下来");
    assert.equal(w.resetSecs, 6 * 3600, "距今多少秒也要算出来（magpie 的 ResetSecs）");
    assert.equal(w.span, 24 * HOUR, "窗口跨度（若可知）");
  });

  test("② retryAfterMs（Retry-After 来的）→ 没有别的重置时刻时，重置时刻 = now + 重试等待", () => {
    const w = fromSignals({ now: NOW, retryAfterMs: 90 * 1000 });
    assert.equal(w.resetsAt, NOW + 90 * 1000, "Retry-After 说「多久之后再试」→ 那之前这个号用不了");
    assert.equal(w.resetSecs, 90);
  });

  test("②b 显式的 resetsAt 优先于 retryAfterMs（重试等待 ≠ 配额重置）", () => {
    const w = fromSignals({ now: NOW, resetsAt: NOW + 6 * HOUR, retryAfterMs: 30 * 1000 });
    assert.equal(w.resetsAt, NOW + 6 * HOUR, "配额什么时候重置，以配额重置为准");
    assert.equal(w.resetSecs, 6 * 3600);
  });

  test("③ used + limit（供应商自己的用量字段）→ amount / limit / unit，并推出已用百分比", () => {
    const w = fromSignals({ now: NOW, used: 30, limit: 50, unit: "credits" });
    assert.equal(w.amount, 30, "已用计数");
    assert.equal(w.limit, 50, "总量");
    assert.equal(w.unit, "credits", "单位");
    assert.equal(w.used, 60, "已用百分比 = 30/50 = 60（magpie：Used 是 Amount 占 Limit 的份额）");
    assert.equal(windowShare(w), 0.6, "对外给的比例是 0..1");
  });

  test("④ model + cooldownUntilMs → model（供 pooledAt 用）+ runsOutAt（这个号到时之前用不了）", () => {
    const w = fromSignals({ now: NOW, model: "opus", cooldownUntilMs: NOW + 30 * MIN });
    assert.equal(w.model, "opus", "这条窗口只算 opus");
    assert.equal(w.runsOutAt, NOW + 30 * MIN, "本地冷却到期 = 剩下的东西没了");
  });

  test("⑤ 只给 resetSecs（有 now）→ 换算成绝对时刻", () => {
    const w = fromSignals({ now: NOW, resetSecs: 900 });
    assert.equal(w.resetsAt, NOW + 900 * 1000);
    assert.equal(w.resetSecs, 900);
  });

  test("⑥ 直接丢响应头进来：X-RateLimit-Reset 给绝对时刻，Retry-After 给等待时长", () => {
    const w = fromSignals({ now: NOW, headers: { "X-RateLimit-Reset": String(NOW + 3600 * 1000) } });
    assert.equal(w.resetsAt, NOW + 3600 * 1000, "epoch 毫秒不该被当成秒再乘一次");

    const ra = fromSignals({ now: NOW, headers: { "retry-after": "60" } });
    assert.equal(ra.resetsAt, NOW + 60 * 1000, "Retry-After: 60 → 60 秒后");
  });

  test("⑦ 正文里的 resets_in / reset_at 也认（大小写与下划线两种写法）", () => {
    const a = fromSignals({ now: NOW, body: '{"resets_in": 120}' });
    assert.equal(a.resetsAt, NOW + 120 * 1000, "resets_in 是「还有 120 秒」，不是绝对时刻");

    const abs = Math.floor((NOW + 3600 * 1000) / 1000);
    const b = fromSignals({ now: NOW, body: `{"reset_at": ${abs}}` });
    assert.equal(b.resetsAt, abs * 1000, "reset_at 是 epoch 秒");
  });

  test("⑧ 什么都不给 → 一条「什么都不知道」的窗口，不是「一切正常」的窗口", () => {
    const w = fromSignals({ now: NOW });
    assert.equal(w.resetsAt, null);
    assert.equal(w.runsOutAt, null);
    assert.equal(w.used, 0);
    assert.equal(w.model, "");
  });

  test("⑨ 给了 retryAfterMs 却没给 now → 明确报错，不猜", () => {
    assert.throws(() => fromSignals({ retryAfterMs: 1000 }), /now/);
  });
});

describe("runsOutAt —— 用完的时刻 vs 重置的时刻，取更早的", () => {
  test("① 两个都知道 → 取更早的（更早的那个才是「这条窗口不再约束我」的时刻）", () => {
    const w = makeWindow({ resetsAt: NOW + 3600 * 1000, runsOutAt: NOW + 60 * 1000 });
    assert.equal(runsOutAt(w), NOW + 60 * 1000, "用完（60 秒）比重置（1 小时）早 → 取用完");

    const other = makeWindow({ resetsAt: NOW + 60 * 1000, runsOutAt: NOW + 3600 * 1000 });
    assert.equal(runsOutAt(other), NOW + 60 * 1000, "重置更早 → 取重置");
  });

  test("② 只知道一个 → 就用它", () => {
    assert.equal(runsOutAt(makeWindow({ resetsAt: NOW + 3600 * 1000 })), NOW + 3600 * 1000);
    assert.equal(runsOutAt(makeWindow({ runsOutAt: NOW + 120 * 1000 })), NOW + 120 * 1000);
  });

  test("③ 都不知道 → null（是「不知道」，不是「马上」）", () => {
    assert.equal(runsOutAt(makeWindow({})), null);
    assert.equal(runsOutAt(makeWindow({ used: 50 })), null);
  });

  test("④ 只知道 resetSecs 时，给了 now 也能换算", () => {
    assert.equal(runsOutAt(makeWindow({ resetSecs: 60 }), NOW), NOW + 60 * 1000);
    assert.equal(runsOutAt(makeWindow({ resetSecs: 60 })), null, "没有 now 就不换算");
  });
});

describe("renewalOf —— 续期时刻", () => {
  test("① 重置还没到 → 就是重置时刻", () => {
    assert.equal(renewalOf(makeWindow({ resetsAt: NOW + 3600 * 1000 }), NOW), NOW + 3600 * 1000);
  });

  test("② 重置已经过去 → 这条窗口又空了：知道跨度就按跨度往后推一个窗口", () => {
    assert.equal(renewalOf(makeWindow({ resetsAt: NOW - 1000, span: 5 * HOUR }), NOW), NOW + 5 * HOUR);
  });

  test("③ 重置已经过去、跨度也不知道 → null（真的不知道下一次是什么时候）", () => {
    assert.equal(renewalOf(makeWindow({ resetsAt: NOW - 1000 }), NOW), null);
  });

  test("④ 用完比重置早 → 续期取用完（magpie 的 Renewal 同理：credits 先没就是先没）", () => {
    const w = makeWindow({ resetsAt: NOW + 3600 * 1000, runsOutAt: NOW + 600 * 1000 });
    assert.equal(renewalOf(w, NOW), NOW + 600 * 1000);
  });
});

describe("paceOf —— 每小时摊到多少", () => {
  test("① 剩余 ÷ 距重置的小时数", () => {
    const w = makeWindow({ used: 50, resetsAt: NOW + 2 * HOUR });
    assert.equal(paceOf(w, NOW), 25, "还剩 50%，两小时用完 → 每小时摊 25%");
  });

  test("② 重置时刻已经过了 → 不能是 Infinity，也不能是负数", () => {
    const w = makeWindow({ used: 80, resetsAt: NOW - 3600 * 1000, span: 5 * HOUR });
    const p = paceOf(w, NOW);
    assert.ok(Number.isFinite(p), `不该是 Infinity，实际是 ${p}`);
    assert.ok(p >= 0, `不该是负数，实际是 ${p}`);
    assert.equal(p, 100 / 5, "窗口又空了（已用按 0 算），按跨度往后推 5 小时 → 100/5");
  });

  test("③ 什么都不知道 → 按一周算（magpie 的 weekSpan），不炸也不判死", () => {
    const p = paceOf(makeWindow({ used: 0 }), NOW);
    assert.ok(Number.isFinite(p) && p > 0, `实际是 ${p}`);
    assert.equal(p, 100 / (7 * 24), "供应商什么都不说时，就当有一周的额度");

    const spent = paceOf(makeWindow({ used: 100 }), NOW);
    assert.ok(Number.isFinite(spent) && spent >= 0, `实际是 ${spent}`);
    assert.equal(spent, 0, "已经用满 → 摊速 0（不是 Infinity，也不是负数）");
  });

  test("④ 距重置不足一小时 → 按一小时算（magpie: max(until, time.Hour)）", () => {
    const w = makeWindow({ used: 0, resetsAt: NOW + 60 * 1000 });
    assert.equal(paceOf(w, NOW), 100, "一分钟后就重置的窗口不能摊得比谁都凶");
  });

  test("⑤ 没给 now → 明确报错（时刻一律由外面传进来）", () => {
    assert.throws(() => paceOf(makeWindow({ used: 10 })), /now/);
  });
});

describe("fullAt —— 到 SPENT_SHARE 就算用尽", () => {
  test("① 默认就是 magpie 的 SPENT_SHARE = 98", () => {
    assert.equal(SPENT_SHARE, 98, "magpie 的 SpentShare 是 98");
    assert.equal(SPENT_SHARE_OF("smart"), 98);
    assert.equal(SPENT_SHARE_OF("order"), 100, "magpie：按顺序发请求的供应商要等到 100%");
  });

  test("② share 到达 98 → 用尽；差一点 → 没用尽", () => {
    assert.equal(fullAt(makeWindow({ used: 98 })), true);
    assert.equal(fullAt(makeWindow({ used: 97.9 })), false);
    assert.equal(fullAt(makeWindow({ used: 98 }), SPENT_SHARE), true);
  });

  test("③ 换了别的 share 就按别的算", () => {
    assert.equal(fullAt(makeWindow({ used: 100 }), 100), true);
    assert.equal(fullAt(makeWindow({ used: 99 }), 100), false);
  });

  test("④ 重置已经过去 → 窗口又空了，不算用尽", () => {
    const w = makeWindow({ used: 100, resetsAt: NOW - 1000 });
    assert.equal(fullAt(w, SPENT_SHARE, NOW), false);
  });

  test("⑤ aside 的窗口用完也不让账号停 → 不算用尽", () => {
    assert.equal(fullAt(makeWindow({ used: 100, aside: true }), SPENT_SHARE), false);
  });
});

describe("pooledAt —— 只对某些模型生效的窗口，别算到别的模型头上", () => {
  const scoped = makeWindow({ used: 100, model: "opus" });

  test("① 有作用域的窗口：作用域外的模型不受它约束", () => {
    assert.equal(pooledAt(scoped, "gpt-4o"), true, "opus 的额度用尽，与 gpt-4o 无关");
    assert.equal(pooledAt(scoped, "claude-opus-4"), false, "opus 的额度就管 opus");
  });

  test("② 整号窗口（model 为空）→ 不是「只对某些模型生效」", () => {
    assert.equal(pooledAt(makeWindow({ used: 100 }), "gpt-4o"), false);
    assert.equal(pooledAt(makeWindow({ used: 100 }), "claude-opus-4"), false);
  });

  test("③ 反过来看：appliesTo 说这条窗口管不管这个模型", () => {
    assert.equal(appliesTo(scoped, "claude-opus-4"), true);
    assert.equal(appliesTo(scoped, "gpt-4o"), false);
    assert.equal(appliesTo(makeWindow({ used: 100 }), "gpt-4o"), true);
  });
});

describe("mergeWindows —— 多条窗口取最紧的那条", () => {
  test("① 用得多的更紧", () => {
    const loose = makeWindow({ used: 20, resetsAt: NOW + HOUR });
    const tight = makeWindow({ used: 90, resetsAt: NOW + 2 * HOUR });
    const merged = mergeWindows([loose, tight]);
    assert.equal(merged.used, 90, "取用得多的那条");
    assert.equal(merged.resetsAt, NOW + 2 * HOUR, "重置时刻也跟着那条走");
  });

  test("② 用得一样多 → 更早用完的更紧", () => {
    const early = makeWindow({ used: 90, resetsAt: NOW + 10 * MIN });
    const late = makeWindow({ used: 90, resetsAt: NOW + 2 * HOUR });
    assert.equal(mergeWindows([late, early]).resetsAt, NOW + 10 * MIN);
  });

  test("③ 空 / 全是 aside → null（没有能约束账号的窗口）", () => {
    assert.equal(mergeWindows([]), null);
    assert.equal(mergeWindows(null), null);
    assert.equal(mergeWindows([makeWindow({ used: 100, aside: true })]), null);
  });

  test("④ 不改调用方的对象，且保留作用域（合并出来的窗口仍带 model）", () => {
    const tight = makeWindow({ used: 90, model: "opus" });
    const merged = mergeWindows([makeWindow({ used: 10 }), tight]);
    assert.notEqual(merged, tight, "返回的是副本");
    assert.equal(merged.model, "opus", "作用域要留着：调用方才知道它只管 opus");
    assert.equal(tight.used, 90, "原对象没被改");
  });
});

describe("estimateShare / windowShare —— 比例换算", () => {
  test("① 已用 ÷ 总量，夹在 0..1", () => {
    assert.equal(estimateShare(30, 50), 0.6);
    assert.equal(estimateShare(80, 50), 1, "超了也不能超过 1");
    assert.equal(estimateShare(-5, 50), 0, "负数夹到 0");
  });

  test("② 总量不知道 → 0（「不知道」不等于「用完了」）", () => {
    assert.equal(estimateShare(30, 0), 0);
    assert.equal(estimateShare(30, null), 0);
  });

  test("③ windowShare：给了绝对已用量就按它算，没给就用窗口自己的百分比折算", () => {
    const w = makeWindow({ used: 60, amount: 30, limit: 50 });
    assert.equal(windowShare(w), 0.6, "窗口自己的 60% → 0.6");
    assert.equal(windowShare(w, 30), 0.6, "绝对计数 30/50 → 0.6");
    assert.equal(windowShare(makeWindow({ used: 120 }), 30), 1, "超 100% 夹到 1");
  });
});

describe("反向对照 —— 改坏实现，测试必须红", () => {
  test("① 把「用完 vs 重置取更早」改坏（取更晚），判据必须失败", () => {
    const w = makeWindow({ resetsAt: NOW + 3600 * 1000, runsOutAt: NOW + 60 * 1000 });
    assert.equal(runsOutAt(w), NOW + 60 * 1000, "正确实现：取更早的（用完）");

    /* 改坏：取更晚的（重置） */
    const broken = Math.max(w.resetsAt, w.runsOutAt);
    assert.equal(broken, NOW + 3600 * 1000, "坏实现：取更晚的");
    assert.notEqual(broken, runsOutAt(w), "两者必须不同 —— 否则这条判据等于没写");
    assert.ok(runsOutAt(w) < broken, "正确实现必须严格早于坏实现");
  });

  test("② 把「作用域外就不算它头上」改坏（只看 model 非空），判据必须失败", () => {
    const scoped = makeWindow({ used: 100, model: "opus" });
    assert.equal(pooledAt(scoped, "gpt-4o"), true, "正确实现：opus 的额度跟 gpt-4o 无关");

    /* 改坏：只要有作用域就算「池化」，不再看模型在不在作用域里 */
    const broken = (w) => !!(w && w.model);
    assert.equal(broken(scoped), true, "坏实现分不出作用域内外");
    assert.notEqual(broken(scoped), pooledAt(scoped, "claude-opus-4"),
      "坏实现会把作用域内的模型也算成无关 —— 正是「算到别的模型头上」的那个错");
  });

  test("③ 把「取最紧的那条」改坏（取用得最少的那条），判据必须失败", () => {
    const loose = makeWindow({ used: 20, resetsAt: NOW + HOUR });
    const tight = makeWindow({ used: 90, resetsAt: NOW + 2 * HOUR });
    assert.equal(mergeWindows([loose, tight]).used, 90, "正确实现：取最紧（用得多的）");

    const broken = (list) => list.reduce((a, b) => (b.used < a.used ? b : a));
    assert.equal(broken([loose, tight]).used, 20, "坏实现：取最松的");
    assert.notEqual(broken([loose, tight]).used, mergeWindows([loose, tight]).used,
      "两者必须不同 —— 否则「最紧」是空话");
  });

  test("④ 把 paceOf 的「小时数不低于 1」改坏，判据必须失败", () => {
    const w = makeWindow({ used: 0, resetsAt: NOW + 60 * 1000 });
    assert.equal(paceOf(w, NOW), 100, "正确实现：一分钟后就重置的窗口按一小时算");

    /* 改坏：直接用「距重置 1 分钟 = 1/60 小时」算 */
    const broken = 100 / ((60 * 1000) / (60 * 60 * 1000));
    assert.equal(broken, 6000, "坏实现：一分钟的窗口摊出每小时 6000%");
    assert.notEqual(broken, paceOf(w, NOW), "两者必须不同 —— 否则它能压过所有别的号");
  });
});
