/**
 * scripts/silent-jump-test.mjs —— 「你选的是 A，回答你的是 B」必须看得见（纯逻辑，不起服务）。
 *
 * 这是一桩真实事故：用户在另一台机器上把 OpenCode Zen 配成入口，链序里紧跟着 WorkBuddy。
 * Zen 免费档约 75% 的请求会挂起（上游不吐首 token），中转在**还没发出响应头**时判失败、
 * 自动改投 WorkBuddy —— WorkBuddy 正常应答，于是每一次对话都在 WorkBuddy 上真实计费
 * （实测每发约 $0.049），而面板上一切正常。跳转早被 noteFailoverEvent 记进了日志，
 * 只是那只是 `log()`，谁都不会去看。
 *
 * 本文件钉死三件事：
 *   ① 服务端留痕：有跳转就记、没有就不记、内存**有界**（不是无限增长）
 *   ② 面板文案：入口 ≠ 实际服务时必须提示；两者相同时**一个字都不许报**
 *   ③ 故障转移开关不会被 5 秒轮询悄悄改回去（本轮一起修的另一个真 bug）
 *
 * 为什么不抄一份逻辑进测试、而是**抠真源码**跑：抄的那份证明不了产品代码的形状 ——
 * 产品改坏了测试还照样绿。抠法沿用 panel-state-truth-test.mjs 的既有做法（锚点切片 +
 * vm 沙箱）。产品侧删掉 jumpAdvice 的收尾锚点，本文件会在加载时当场炸，不是安静地少测。
 *
 * 反向对照：本文件末尾 SABOTAGE 表 + scripts/silent-jump-sabotage-run.mjs。
 * 判据只有一个——改回改前行为，测试必须红。
 *
 * 红线：不写真实 %APPDATA%\bai-router，不含任何真实令牌/密钥，不含本机绝对路径，
 * 不起服务、不发任何网络请求。时刻全是显式注入的假值。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  noteSilentJump, silentJumpSnapshot, _resetSilentJumpForTest,
  SILENT_JUMP_LOG, SILENT_JUMP_WINDOW_MIN, SILENT_JUMP_MAX_PAIRS,
} from "../src/server/failover.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CARD = path.join(REPO, "src", "server", "cards", "failover.js");
const CARD_SRC = readFileSync(CARD, "utf8");

const lines = (src) => src.split(/\r?\n/);
/** 从 `from`（含）切到 `to`（含）为止；锚点对不上就**当场炸**，不猜、不悄悄改别的。 */
function cut(src, from, to, what) {
  const ls = lines(src);
  const a = ls.findIndex((l) => l.includes(from));
  if (a < 0) throw new Error(`${what}：锚点「${from}」在源码里找不到 —— 代码被挪走了？`);
  const b = ls.findIndex((l, i) => i >= a && l.trim() === to);
  if (b < 0) throw new Error(`${what}：抠不出收尾「${to}」—— 锚点移位了`);
  return ls.slice(a, b + 1).join("\n");
}
/** 从 `from`（含）切到 `to`（含）**之后那一行**为止——收尾要连函数最后的 `}` 一起吃进来。 */
function cutThrough(src, from, to, what) {
  return cutN(src, from, to, what, 1);
}
/** 同上，但多带 extra 行（收尾是「字面量的 };」+「函数的 }」时用 extra=2）。 */
function cutN(src, from, to, what, extra) {
  const ls = lines(src);
  const a = ls.findIndex((l) => l.includes(from));
  if (a < 0) throw new Error(`${what}：锚点「${from}」在源码里找不到 —— 代码被挪走了？`);
  const b = ls.findIndex((l, i) => i >= a && l.includes(to));
  if (b < 0) throw new Error(`${what}：抠不出收尾「${to}」—— 锚点移位了`);
  if (b + extra >= ls.length) throw new Error(`${what}：收尾后面没有行了 —— 锚点移位了`);
  return ls.slice(a, b + 1 + extra).join("\n");
}

/* ====================================================================== *
 * ① 服务端留痕（failover.mjs —— 直接 import 真模块，不是复制品）
 * ====================================================================== */

/** 假时刻：显式传进去，产品代码的 Date.now() 不参与，测试不受跑得快慢影响。 */
const at = (base, minutes) => base + minutes * 60000;
const BASE = 1760000000000;   // 固定基准（编的，不是真实时间）
const iso = (ms) => new Date(ms).toISOString();

/** 一次成功的转移尝试表：入口 ok:false（挂起），目标 ok:true。 */
const triesJump = (to, model) => [{ provider: "zen", ok: false, status: 0 }, { provider: to, ok: true, model }];
/** 记录 + 读快照都钉在假时刻 BASE 上：产品代码的 Date.now() 不参与，测试与跑得多快无关。 */
const jumpAt = (from, to, model, now, costs) => noteSilentJump(from, triesJump(to, model), model, costs ?? null, now ?? BASE);
const snapAt = (now) => silentJumpSnapshot(now ?? BASE);

describe("① 服务端留痕：有跳转就记，没有就不记", () => {
  test("★ 入口≠实际服务 → 记一条，次数/模型/时刻都对得上", () => {
    _resetSilentJumpForTest();
    const r = jumpAt("zen", "wb", "hy3");
    assert.deepEqual(r, { from: "zen", to: "wb" });

    const s = snapAt();
    assert.equal(s.total, 1, "应当记成 1 次");
    assert.equal(s.active.length, 1);
    assert.equal(s.active[0].from, "zen");
    assert.equal(s.active[0].to, "wb");
    assert.equal(s.active[0].count, 1, "窗口内次数应当是 1");
    assert.equal(s.active[0].total, 1);
    assert.equal(s.active[0].model, "hy3", "**钱花到哪个模型上**必须一起记下来");
    assert.equal(s.active[0].lastAt, iso(BASE));
    assert.equal(s.recent.length, 1);
    assert.equal(s.recent[0].to, "wb");
  });

  test("★ 没有跳转就不产生任何记录（三条都试过）", () => {
    _resetSilentJumpForTest();
    /* ① 成功的就是入口本身 */
    assert.equal(noteSilentJump("zen", [{ provider: "zen", ok: true }], "space-bunny-free"), null);
    /* ② 全线失败：没人服务过。记下来会变成「实际回答你的是 X」而事实上没人回答——是编造。 */
    assert.equal(noteSilentJump("zen", [
      { provider: "zen", ok: false, status: 0 },
      { provider: "wb", ok: false, status: 503 },
    ], null), null);
    /* ③ 入口被跳过、后面全被跳过：还是没人回答 */
    assert.equal(noteSilentJump("zen", [
      { provider: "zen", skipped: "额度冷却中" },
      { provider: "wb", skipped: "冷却中" },
    ], null), null);

    const s = snapAt();
    assert.equal(s.total, 0, `不该有任何记录，却记了 ${s.total} 次`);
    assert.equal(s.active.length, 0, `不该有活跃组合，却有 ${JSON.stringify(s.active)}`);
    assert.equal(s.recent.length, 0);
    assert.equal(s.lastAt, null);
    assert.equal(s.firstAt, null);
  });

  test("连跳几家：只认**第一个真的接了手的**，且入口被跳过也算数", () => {
    _resetSilentJumpForTest();
    /* 入口因为额度冷却被跳过 → 用户选了 zen，实际是 wbai 在回答。这必须记。 */
    const r = noteSilentJump("zen", [
      { provider: "zen", skipped: "额度冷却中" },
      { provider: "or", skipped: "冷却中" },
      { provider: "wbai", ok: true },
    ], "step-5-preview", BASE);
    assert.deepEqual(r, { from: "zen", to: "wbai" });
    const s = snapAt();
    assert.equal(s.active[0].to, "wbai");
    assert.equal(s.active[0].model, "step-5-preview");
  });

  test("同一组合重复跳：次数累加，明细是倒序的", () => {
    _resetSilentJumpForTest();
    /* 五次分别落在五个不同的分钟上，好验倒序（同一分钟里排序本来就无从分辨）。 */
    for (let i = 0; i < 5; i++) jumpAt("zen", "wb", "hy3", at(BASE, i));
    const s = snapAt(at(BASE, 5));
    assert.equal(s.total, 5);
    assert.equal(s.active.length, 1, "同一组合不该拆成五条");
    assert.equal(s.active[0].count, 5);
    assert.equal(s.active[0].total, 5);
    assert.equal(s.recent.length, 5);
    /* 倒序：最新的在 [0]。at 是 ISO 字符串（与 active[].lastAt 同一形状）。 */
    assert.ok(Date.parse(s.recent[0].at) > Date.parse(s.recent[4].at),
      `明细不是倒序的：${JSON.stringify(s.recent.map((r) => r.at))}`);
    assert.equal(s.recent[0].at, iso(at(BASE, 4)));
  });

  test("★ 内存有界：连打 5000 次也不能长大（最坏占用是个常数）", () => {
    _resetSilentJumpForTest();
    /* 5000 次跳转，按**时间先后**落在 7 家渠道的所有有序对上、跨约 7 小时。
       ⚠ 必须顺着时间记：留痕记的是「这一对最后一次发生在什么时候」，乱序记会让
         lastAt 落到很早的分钟，测的就不是真实情形了。 */
    const CH = ["qd", "bai", "sn", "zen", "wb", "wbai", "or"];
    const LAST_MIN = 420;
    let n = 0;
    for (let i = 0; i < 5000; i++) {
      const from = CH[i % CH.length];
      const to = CH[(i * 3 + 1) % CH.length];
      if (from === to) continue;
      if (jumpAt(from, to, "m-" + (i % 50), at(BASE, Math.floor((i * LAST_MIN) / 5000)))) n++;
    }
    const s = snapAt(at(BASE, LAST_MIN));

    /* ① 明细环是定长的。⚠ 看 kept（环里此刻的条数）而不是 recent（那边本来就 slice 到 8，
       拿它断言是恒真的 —— 那正是本条反向对照第一次没打红的原因）。 */
    assert.ok(s.kept <= SILENT_JUMP_LOG,
      `明细环留了 ${s.kept} 条 > 上界 ${SILENT_JUMP_LOG} —— 这是在无限增长`);
    assert.equal(s.kept, SILENT_JUMP_LOG, `连打 5000 次之后环应当正好是满的 ${SILENT_JUMP_LOG}`);
    assert.ok(s.recent.length <= 8, "recent 是给面板看的那几条，不该把整个环倒出去");
    /* ② 组合表是**按渠道对**开的，不是按流量开的：7 家最多 49 对。 */
    assert.ok(s.active.length <= SILENT_JUMP_MAX_PAIRS,
      `组合 ${s.active.length} 个 > 兜底上界 ${SILENT_JUMP_MAX_PAIRS}`);
    assert.ok(s.active.length <= 49,
      `7 家渠道最多 49 对，却记了 ${s.active.length} 对 —— 说明它是按流量而不是按渠道对开的`);
    /* ③ 快照整体不能随运行时长变大：序列化后仍然是个小对象。 */
    assert.ok(JSON.stringify(s).length < 40 * 1024,
      `快照 ${JSON.stringify(s).length} 字节，太大了`);
    /* ④ 但**计数不许丢**：累计仍然是真实发生过的次数（明细环淘汰的是明细，不是账）。 */
    assert.equal(s.total, n, `累计对不上：面板报 ${s.total}，实际发生 ${n} 次`);
    const kept = s.active.reduce((a, e) => a + e.total, 0);
    assert.ok(kept > 0, "最近一小时内明明还在换人，active 却是空的");
    assert.ok(kept <= n, "active 里的账比实际发生的还多");
  });

  test("组合表的兜底上界真的会生效（万一 from/to 变成动态值也不失控）", () => {
    _resetSilentJumpForTest();
    /* 模拟「渠道集合不再是封闭的」：每条都来自一个全新 key。 */
    for (let i = 0; i < SILENT_JUMP_MAX_PAIRS * 3; i++) {
      noteSilentJump("dyn-" + i, [{ provider: "dyn-" + i, ok: false }, { provider: "dyn-out-" + i, ok: true }], null, null, at(BASE, i));
    }
    const s = snapAt(at(BASE, SILENT_JUMP_MAX_PAIRS * 3));
    assert.ok(s.active.length <= SILENT_JUMP_MAX_PAIRS,
      `兜底上界没生效：记了 ${s.active.length} 个组合，上界 ${SILENT_JUMP_MAX_PAIRS}`);
    assert.equal(s.kept <= SILENT_JUMP_LOG, true, "明细环也必须仍是定长的");
    assert.ok(s.kept <= SILENT_JUMP_LOG, `明细环留了 ${s.kept} 条 > 上界 ${SILENT_JUMP_LOG}`);
  });

  test("分钟桶环本身也是定长的（不是无限 append）", () => {
    _resetSilentJumpForTest();
    /* 一分钟一跳，跑满窗口的两倍。假时刻由参数注入，不靠真时钟。 */
    for (let i = 0; i < SILENT_JUMP_WINDOW_MIN * 3; i++) {
      noteSilentJump("zen", triesJump("wb", "hy3"), "hy3", null, at(BASE, i));
      silentJumpSnapshot(at(BASE, i));
    }
    const s = silentJumpSnapshot(at(BASE, SILENT_JUMP_WINDOW_MIN * 3));
    assert.equal(s.active[0].total, SILENT_JUMP_WINDOW_MIN * 3, "累计不受桶环淘汰影响");
    /* 窗口内次数最多只能是窗口长度（每分钟只有一跳）——多出来的说明窗口判据坏了。 */
    assert.ok(s.active[0].count <= SILENT_JUMP_WINDOW_MIN,
      `窗口内 ${s.active[0].count} 次 > 窗口 ${SILENT_JUMP_WINDOW_MIN} 分钟（每分钟只有一跳）`);
  });

  test("时间窗：早于整个窗口的组合不算「当前」，不再出现在面板里", () => {
    _resetSilentJumpForTest();
    noteSilentJump("zen", triesJump("wb", "hy3"), "hy3", null, BASE);
    assert.equal(silentJumpSnapshot(BASE).active.length, 1, "3 小时前那次当时算当前");

    const later = at(BASE, 180);                                    // 3 小时后
    const s = silentJumpSnapshot(later);
    assert.equal(s.active.length, 0,
      `窗口外的老组合还在面板上：${JSON.stringify(s.active)} —— 抽屉只讲当前状况，历史不该一直占位`);
    assert.equal(s.recent.length, 1, "明细可以留着（那是历史），只是不该再被当成「现在正在换」");
  });

  test("窗口内计数只算窗口内的：窗外的那 3 次不算进「最近 1 小时」", () => {
    _resetSilentJumpForTest();
    /* 前 3 次在两小时前（落在窗口外），此刻再跳 2 次。 */
    for (let i = 0; i < 3; i++) noteSilentJump("zen", triesJump("wb", "hy3"), "hy3", null, at(BASE, i));
    const now = at(BASE, 120);        // 两小时后
    for (let i = 0; i < 2; i++) noteSilentJump("zen", triesJump("wb", "hy3"), "hy3", null, now);
    const s = silentJumpSnapshot(now);
    assert.equal(s.active[0].count, 2,
      `窗口内应当只有此刻的 2 次，却把两小时前那 3 次也算进来了（count=${s.active[0].count}）`);
    assert.equal(s.active[0].total, 5, "累计仍是 5 —— 窗口只影响「最近」，不该影响「一共发生过几次」");
  });

  test("空态：一次都没换过人时快照是干净的零值（面板据此不报）", () => {
    _resetSilentJumpForTest();
    const s = silentJumpSnapshot(BASE);
    assert.deepEqual(
      { total: s.total, firstAt: s.firstAt, lastAt: s.lastAt, active: s.active.length, recent: s.recent.length },
      { total: 0, firstAt: null, lastAt: null, active: 0, recent: 0 });
    assert.equal(s.windowMin, 60, "窗口长度要告诉面板，否则它写不出「最近 1 小时」");
  });

  test("脏输入不炸也不记（defensive：tries 不是数组 / 字段缺失）", () => {
    _resetSilentJumpForTest();
    assert.equal(noteSilentJump("zen", null, null), null);
    assert.equal(noteSilentJump("zen", [], null), null);
    assert.equal(noteSilentJump("", triesJump("wb", "x"), null), null);
    assert.equal(noteSilentJump("zen", [{ provider: "zen", ok: true }, null, { ok: true }], null), null);
    assert.equal(snapAt().total, 0);
  });
});

/* ====================================================================== *
 * ② 面板文案（cards/failover.js 的 jumpAdvice —— 抠真源码跑）
 * ====================================================================== */

/** jumpAdvice 的收尾锚点：advice 三元表达式的最后一行，独此一家。
 *  它后面是 `  };`（关 return 的字面量）与 `}`（关函数本身），两行都要带上。 */
const JUMP_ADVICE_END = "或者关掉「自动故障转移」——关掉之后失败会原样报给你，不会有人替你接手。`,";
const JUMP_ADVICE_SRC = cutN(CARD_SRC, "function jumpAdvice(", JUMP_ADVICE_END, "failover 卡里的 jumpAdvice", 2);

/** 抠出来的真源码挂进沙箱。 */
function loadJumpAdvice(nowMs) {
  const sb = { console, JSON, Math, Number, Object, String, Array, isFinite };
  /* 只给一个可推进的 Date.now，让「3 分钟前」这类相对时间可断言。 */
  sb.Date = new Proxy(Date, {
    construct(t, a) { return a.length ? new t(...a) : new t(nowMs); },
    get(t, p) { return p === "now" ? () => nowMs : t[p]; },
  });
  vm.createContext(sb);
  /* ⚠ 拼脚本必须用字符串加号，不能用模板字符串：抠出来的真源码里满是 `${…}`，
     放进模板字面量会被**本文件**求值一遍（nameOf 恰好在本文件有定义，于是拼出一段
     别的脚本，报的还是 SyntaxError，排查起来极费劲）。 */
  const script = "(() => {\n" + JUMP_ADVICE_SRC + "\n return jumpAdvice; })()";
  return new vm.Script(script, { filename: "jumpAdvice-from-cards/failover.js" }).runInContext(sb);
}

/** 清单的最小切片：只给 badge（判计费）与 name（显示名），形状照 providers.js。 */
const MINI = {
  qd: { name: "Qoder", badge: { text: "免费", kind: "free" } },
  bai: { name: "B.AI", badge: { text: "付费", kind: "paid" } },
  sn: { name: "SenseNova", badge: { text: "境内付费", kind: "cn" } },
  zen: { name: "OpenCode Zen", badge: { text: "免费 · 海外", kind: "intl" } },
  wb: { name: "WorkBuddy", badge: { text: "0 积分", kind: "cn" } },
  wbai: { name: "WorkBuddy AI", badge: { text: "0 积分 · 海外", kind: "intl" } },
  or: { name: "OpenRouter", badge: { text: "免费 · 海外", kind: "intl" } },
};
const nameOf = (k) => (MINI[k] && MINI[k].name) || k;
const badgeKindOf = (k) => ((MINI[k] || {}).badge || {}).kind || "";

/** 一条 sj（服务端 silentJump 快照）的假数据。 */
const sj = (act, extra) => Object.assign({ windowMin: 60, total: 0, recent: [] }, extra || {}, { active: act });
const JUMP = (from, to, count, extra) => Object.assign(
  { from, to, count, total: count, lastAt: iso(BASE), model: "hy3" }, extra || {});

describe("② 面板文案：说人话，且不误报", () => {
  test("★ 入口 ≠ 实际服务 → 必须出提示，标题里两个渠道名都要有", () => {
    const f = loadJumpAdvice(BASE);
    const a = f(sj([JUMP("zen", "wb", 47, { costs: true })], { total: 112 }), nameOf, badgeKindOf);
    assert.ok(a, "入口 zen、实际 wb —— 一条都不提示等于没修");
    assert.match(a.title, /OpenCode Zen/, `标题没点名用户选的那家：${a.title}`);
    assert.match(a.title, /WorkBuddy/, `标题没点名真正回答的那家：${a.title}`);
    assert.match(a.title, /你选的是 .*实际回答你的是 /, `标题没说清「谁选、谁答」：${a.title}`);
  });

  test("★ 次数与时间窗必须在正文里（用户扫一眼要知道多频繁）", () => {
    const f = loadJumpAdvice(BASE);
    const a = f(sj([JUMP("zen", "wb", 47, { costs: true })], { total: 112 }), nameOf, badgeKindOf);
    const body = a.lines.join(" | ");
    assert.match(body, /最近 1 小时发生 47 次/, `正文没给窗口内次数：${body}`);
    assert.match(body, /累计 112 次/, `正文没给累计：${body}`);
    assert.match(body, /刚刚/, `正文没给最近一次的时刻：${body}`);
    assert.match(body, /hy3/, `正文没摆出实际发出去的模型名（用户要靠它对账）：${body}`);
  });

  test("★ 入口 = 实际服务 → 返回 null，一个字都不许报", () => {
    const f = loadJumpAdvice(BASE);
    /* 三种「不该报」的形态都试一遍 */
    assert.equal(f(null, nameOf, badgeKindOf), null, "没有数据时不得凭空报");
    assert.equal(f(sj([]), nameOf, badgeKindOf), null, "空列表不得凭空报");
    assert.equal(f(sj([JUMP("zen", "zen", 3)]), nameOf, badgeKindOf), null,
      "入口与实际服务是同一家 —— 这是最典型的误报，天天误报的告警用户会学会无视");
    assert.equal(f(sj([{ from: "zen" }]), nameOf, badgeKindOf), null, "字段不全不得报错");
  });

  test("★ 免费 → 计费：红（err），并明说「记在它的账上」", () => {
    const f = loadJumpAdvice(BASE);
    const a = f(sj([JUMP("zen", "wb", 47, { costs: true })], { total: 112 }), nameOf, badgeKindOf);
    assert.equal(a.level, "err", "免费档掉进计费档是**扣钱**，不能只给个黄色提醒");
    const all = [a.title, ...a.lines, a.advice].join(" | ");
    assert.match(all, /计费/, `扣钱场景没说要花钱：${all}`);
    assert.match(all, /账/, `没点明这些对话算在谁头上：${all}`);
  });

  test("免费 → 免费（都在免费档）：黄色（warn），不谎报扣钱", () => {
    const f = loadJumpAdvice(BASE);
    const a = f(sj([JUMP("zen", "wbai", 3)]), nameOf, badgeKindOf);
    assert.equal(a.level, "warn", "免费跳免费不该吓人成红");
    assert.ok(!/计费/.test([a.title, ...a.lines, a.advice].join(" ")),
      "没花钱却说要花钱 —— 这种误报会把真告警一起废掉");
  });

  test("入口本来就在付费档 → 不升级语气（用户本来就在花钱）", () => {
    const f = loadJumpAdvice(BASE);
    const a = f(sj([JUMP("bai", "sn", 3)]), nameOf, badgeKindOf);
    assert.equal(a.level, "warn", "入口自己就是付费档，不该报成扣钱");
  });

  test("判据挑对那一条：多条组合并存时，扣钱的那条优先被摆出来", () => {
    const f = loadJumpAdvice(BASE);
    const a = f(sj([
      JUMP("qd", "wbai", 999, { costs: false }),   // 免费跳免费，次数超多
      JUMP("zen", "wb", 1, { costs: true }),      // 确实计费，只有 1 次
    ]), nameOf, badgeKindOf);
    assert.equal(a.level, "err");
    assert.match(a.title, /WorkBuddy/, `应当优先摆扣钱那条，实际：${a.title}`);
    assert.ok(!/Qoder/.test(a.title) && !/WorkBuddy AI/.test(a.title),
      `摆错了那一条：${a.title}`);
    assert.ok(a.lines.some((l) => /另有 1 种组合/.test(l)),
      `没告诉用户还有别的组合：${JSON.stringify(a.lines)}`);
  });

  test("建议要可执行：点明「删掉谁」或「关掉」，而不是只描述现象", () => {
    const f = loadJumpAdvice(BASE);
    const a = f(sj([JUMP("zen", "wb", 47, { costs: true })], { total: 112 }), nameOf, badgeKindOf);
    assert.match(a.advice, /关掉/, `没给可执行的下一步：${a.advice}`);
    assert.match(a.advice, /WorkBuddy/, `没点名该动哪一家：${a.advice}`);
  });

  /* ★★ v1.0.88 事故回归：WorkBuddy 的 0 积分模型（实测 hy3 / step-5-preview 都是
   * credits=x0.00）**不许**被说成「在你的账上花钱」。
   * 起因：判据曾用 providers.js 的 badge.kind，而 kind:"cn" 同时挂在
   * 「境内付费」(sn) 和「0 积分」(wb) 两家身上 —— 它表示**境内**不是**收费**。
   * 结果用户被告知「每发 $0.0493 在扣钱」，而那批对话根本没花钱。
   * 误报比不报更坏：它会让人为一个不存在的扣费去排查、去改配置。 */
  test("★ 免费模型被换人接手时，绝不能说成在扣钱", () => {
    const f = loadJumpAdvice(BASE);
    /* costs:false = 服务端查到这个模型 credits=x0.00（免费） */
    const a = f(sj([JUMP("zen", "wb", 47, { costs: false })], { total: 112 }), nameOf, badgeKindOf);
    assert.equal(a.level, "warn", `免费模型不该报红：${a.level}`);
    const all = [a.title, ...a.lines, a.advice].join(" | ");
    assert.ok(!/计费/.test(all), `把免费模型说成计费了：${all}`);
    assert.ok(!/账上/.test(all), `把免费模型说成记在它账上了：${all}`);
  });

  test("★ 查不到那个模型的 credits 时，宁可不下结论也不说扣钱", () => {
    const f = loadJumpAdvice(BASE);
    /* costs:null = 上游没给这个模型的 credits，**不知道** */
    const a = f(sj([JUMP("zen", "wb", 47, { costs: null })], { total: 112 }), nameOf, badgeKindOf);
    assert.notEqual(a.level, "err", "查不到就报红 = 编造扣费");
    const all = [a.title, ...a.lines, a.advice].join(" | ");
    assert.ok(!/计费/.test(all), `查不到却下了计费结论：${all}`);
  });

  test("「最近一次 X 前」的时间话术分档正确", () => {
    const t = (mins) => loadJumpAdvice(at(BASE, mins))(sj([JUMP("zen", "wb", 0, { lastAt: iso(BASE) })]), nameOf, badgeKindOf);
    assert.match(t(0).lines.join(" "), /刚刚/);
    assert.match(t(3).lines.join(" "), /3 分钟前/);
    assert.match(t(90).lines.join(" "), /2 小时前/);
    assert.match(t(60 * 30).lines.join(" "), /1 天前/);
  });

  test("窗口内为 0 时改说累计 + 最近一次，不写「最近 1 小时发生 0 次」", () => {
    const f = loadJumpAdvice(at(BASE, 40));
    const a = f(sj([JUMP("zen", "wb", 0, { lastAt: iso(BASE), total: 12 })], { total: 12 }), nameOf, badgeKindOf);
    const body = a.lines.join(" | ");
    assert.ok(!/发生 0 次/.test(body), `写了「发生 0 次」这种自相矛盾的话：${body}`);
    assert.match(body, /累计 12 次/);
    assert.match(body, /40 分钟前/);
  });
});

/* ====================================================================== *
 * ③ 故障转移开关：5 秒轮询不许把用户刚点的开关改回去（v1.0.88 修的真 bug）
 * ====================================================================== */

/* --- 最小假 DOM：只提供 cards/failover.js 真源码用到的东西 --- */
/** 能记账的元素。innerHTML / hidden / className / textContent 都留痕，好断言。 */
function el(tag = "div") {
  const e = {
    tagName: tag, hidden: false, className: "", _t: "",
    style: {}, dataset: {}, attrs: {}, handlers: {},
    get textContent() { return this._t; }, set textContent(v) { this._t = String(v); },
    _writes: [],
    innerHTML: "",
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
    fire(t, ev) { for (const fn of this.handlers[t] || []) fn(ev); },
  };
  return e;
}

/** 清单的最小切片：卡片只读 chainable / name / badge。 */
const CARD_MANIFEST = {
  qd: { key: "qd", name: "Qoder", badge: { text: "免费", kind: "free" }, chainable: true },
  bai: { key: "bai", name: "B.AI", badge: { text: "付费", kind: "paid" }, chainable: true },
  sn: { key: "sn", name: "SenseNova", badge: { text: "境内付费", kind: "cn" }, chainable: true },
  zen: { key: "zen", name: "OpenCode Zen", badge: { text: "免费 · 海外", kind: "intl" }, chainable: true },
  wb: { key: "wb", name: "WorkBuddy", badge: { text: "0 积分", kind: "cn" }, chainable: true },
  wbai: { key: "wbai", name: "WorkBuddy AI", badge: { text: "0 积分 · 海外", kind: "intl" }, chainable: true },
  or: { key: "or", name: "OpenRouter", badge: { text: "免费 · 海外", kind: "intl" }, chainable: true },
  ccswitch: { key: "ccswitch", name: "交还区", badge: { text: "非本台渠道", kind: "neutral" }, chainable: false },
};
const CHAIN = ["qd", "bai", "sn", "zen", "wb", "wbai", "or"];

/**
 * 把**整份** cards/failover.js 挂进沙箱并 mount 一次。
 * 返回 { card, nodes, ctx }，其中 card 是 mount() 的返回值（含 update / _isDirty）。
 */
function mountCard({ serverChain = CHAIN.slice(), serverEnabled = true } = {}) {
  const nodes = {};
  for (const id of ["foPanel", "ckFailover", "foSeq", "foCool", "foAux", "foResult", "btnSaveFo", "foJump"]) {
    nodes[id] = el(id === "ckFailover" || id === "btnSaveFo" ? "button" : "div");
  }
  const sb = {
    console,
    document: { getElementById: (id) => nodes[id] || null },
    Date, JSON, Math, Number, Object, String, Array, isFinite, Error,
    window: { BAI_PROVIDERS: CARD_MANIFEST, BAI_CARDS: {} },
  };
  vm.createContext(sb);
  new vm.Script(CARD_SRC, { filename: "cards/failover.js" }).runInContext(sb);

  let chain = serverChain.slice();
  const posted = [];
  const shown = [];
  const ctx = {
    channels: Object.keys(CARD_MANIFEST),
    slot: nodes.foPanel,
    esc: (s) => String(s == null ? "" : s),
    chainOf: () => chain.slice(),
    channelState: () => ({ s: "ok" }),
    nameOf: (k) => (CARD_MANIFEST[k] || {}).name || k,
    showResult: (_e, text, good) => shown.push({ text: String(text), good: !!good }),
    /* 保存成功即代表服务端已经收下；把 chain 更新成用户刚存的那份，模拟真实后端。 */
    postJSON: async (_p, body) => { posted.push(body); chain = body.failover.chain.slice(); return {}; },
    withBusy: (_b, fn) => fn(),
    poll: () => { },
  };
  const card = sb.window.BAI_CARDS.failover.mount(ctx) || {};
  const setChain = (c) => { chain = c.slice(); };
  return { card, nodes, ctx, posted, shown, setChain };
}

/** /api/status 的 failover 切片（形状照 server.mjs 真代码）。 */
const STATUS = (enabled, extra) => ({
  failover: Object.assign({ enabled, chain: CHAIN.slice(), cooling: {} }, extra || {}),
});

describe("③ 故障转移开关：轮询不许把用户刚点的开关改回去", () => {
  test("★ 用户点关 → 跑一轮 update() → 开关必须仍然是关（这就是回归本体）", () => {
    const h = mountCard({ serverEnabled: true });
    h.card.update(STATUS(true));
    assert.equal(h.nodes.ckFailover.getAttribute("aria-checked"), "true", "前置：服务端说开着");

    h.nodes.ckFailover.fire("click");
    assert.equal(h.nodes.ckFailover.getAttribute("aria-checked"), "false", "前置：用户点了关闭");
    assert.equal(h.card._isDirty(), true, "点完开关必须是脏的");

    /* 模拟 5 秒后的那一轮轮询：服务端**还没**收到保存，读回的还是旧值 true。 */
    h.card.update(STATUS(true));
    assert.equal(h.nodes.ckFailover.getAttribute("aria-checked"), "false",
      "点完开关最多 5 秒就被服务端旧值盖回开启 —— 这正是用户报的「关掉之后会自动打开」");
    assert.match(h.nodes.foAux.textContent, /已关闭/);
  });

  test("★ 保存成功后清脏，下一轮起重新听服务端的", async () => {
    const h = mountCard({ serverEnabled: true });
    h.card.update(STATUS(true));
    h.nodes.ckFailover.fire("click");           // 关掉
    assert.equal(h.card._isDirty(), true);

    h.nodes.btnSaveFo.fire("click");
    await new Promise((r) => setImmediate(r));

    assert.equal(h.posted.length, 1, "保存请求没发出去");
    assert.equal(h.posted[0].failover.enabled, false, "保存发出去的是「开启」——用户明明点了关");
    assert.equal(h.card._isDirty(), false, "保存成功后必须清脏");
    assert.ok(h.shown.some((s) => /已保存/.test(s.text)), "没给保存反馈");

    /* 清脏之后：服务端这时已经改成 false，照常同步；若服务端另有变更也要能跟回来。 */
    h.card.update(STATUS(false));
    assert.equal(h.nodes.ckFailover.getAttribute("aria-checked"), "false");
    h.card.update(STATUS(true));                // 别的进程/手动改了配置
    assert.equal(h.nodes.ckFailover.getAttribute("aria-checked"), "true",
      "清脏之后 update 必须恢复同步能力 —— 别把同步一起禁了");
  });

  test("★ 链序草稿同样受 dirty 保护（不是靠「恰好没被写」的巧合）", () => {
    const h = mountCard({ serverChain: ["qd", "bai", "zen", "wb"] });
    h.card.update(STATUS(true));
    assert.match(h.nodes.foSeq.innerHTML, /Qoder/);

    /* 模拟用户点「▲」：按钮与节点由 fake event 提供（真 handler 自己算 i/j）。 */
    const btn = el("button"); btn.dataset.mv = "up";
    const node = el("span"); node.setAttribute("data-i", "2");
    /* 真 handler 走的是 e.target.closest("button[data-mv]") 再 btn.closest(".node")。 */
    btn.closest = (sel) => (sel === "button[data-mv]" ? btn : (sel === ".node" ? node : null));
    node.closest = (sel) => (sel === ".node" ? node : null);
    h.nodes.foSeq.fire("click", { target: btn });

    const afterEdit = h.nodes.foSeq.innerHTML;
    assert.equal(h.card._isDirty(), true, "调完顺序必须是脏的");
    /* 把第 3 位（OpenCode Zen）往上挪一位 ⇒ 顺序应当变成 Qoder → Zen → B.AI。 */
    assert.ok(afterEdit.indexOf("OpenCode Zen") < afterEdit.indexOf("B.AI"),
      `调序没生效（Zen 仍在 B.AI 后面）：${afterEdit.replace(/\s+/g, " ").slice(0, 240)}`);

    /* 服务端此时回报一个**不同的**链序（别处改了配置）。草稿不能被它覆盖。 */
    h.card.update(STATUS(true, { chain: ["zen", "wb", "qd", "bai"] }));
    assert.equal(h.nodes.foSeq.innerHTML, afterEdit,
      "用户还没保存的链序被服务端读数盖掉了 —— 以后谁在 update 里补一行 draft=order() 就会重蹈覆辙");
  });

  test("无本地改动时，update 照常同步服务端状态（别把同步一起禁了）", () => {
    const h = mountCard({ serverEnabled: true });
    h.card.update(STATUS(true));
    assert.equal(h.nodes.ckFailover.getAttribute("aria-checked"), "true");

    h.card.update(STATUS(false));
    assert.equal(h.nodes.ckFailover.getAttribute("aria-checked"), "false",
      "没有本地改动时，开关必须跟着服务端走 —— 这条红了说明 dirty 闸把同步也堵死了");

    h.card.update(STATUS(true));
    assert.equal(h.nodes.ckFailover.getAttribute("aria-checked"), "true");
  });

  test("静默换人提示**不**受 dirty 保护（它是服务端事实，不是用户正在编辑的草稿）", () => {
    const h = mountCard({ serverEnabled: true });
    h.card.update(STATUS(true));
    h.nodes.ckFailover.fire("click");           // 置脏

    h.card.update(STATUS(true, {
      silentJump: {
        windowMin: 60, total: 112, active: [JUMP("zen", "wb", 47)], recent: [],
      },
    }));
    assert.equal(h.nodes.foJump.hidden, false, "用户正在编辑草稿，就把扣钱告警藏起来了？");
    assert.match(h.nodes.foJump.innerHTML, /OpenCode Zen/);
    assert.match(h.nodes.foJump.innerHTML, /WorkBuddy/);
    assert.match(h.nodes.foJump.innerHTML, /最近 1 小时发生 47 次/);
  });

  test("告警块画在开关**之前**、且没有跳人时彻底隐藏", () => {
    const h = mountCard({ serverEnabled: true });
    h.card.update(STATUS(true));
    assert.equal(h.nodes.foJump.hidden, true, "没有换过人时不该占版面");
    assert.equal(h.nodes.foJump.innerHTML, "");

    h.card.update(STATUS(true, { silentJump: { windowMin: 60, total: 1, active: [JUMP("zen", "wb", 1)], recent: [] } }));
    assert.equal(h.nodes.foJump.hidden, false);
    /* 模板里 #foJump 必须是 slot.innerHTML 的**第一个**孩子 —— 放在开关后面
       就不是「一眼看见」了。 */
    const idx = h.nodes.foPanel.innerHTML.indexOf('id="foJump"');
    const swIdx = h.nodes.foPanel.innerHTML.indexOf('id="ckFailover"');
    assert.ok(idx >= 0, "模板里没有 #foJump");
    assert.ok(idx < swIdx, `#foJump(${idx}) 排在开关(${swIdx}) 后面 —— 这条提示会被当成配文而不是警报`);

    h.card.update(STATUS(true, { silentJump: { windowMin: 60, total: 0, active: [], recent: [] } }));
    assert.equal(h.nodes.foJump.hidden, true, "换人停了还一直挂着 —— 又是一个天天误报的告警");
  });
});

/* ====================================================================== *
 * 4. SABOTAGE 表（grep SABOTAGE 可定位）
 * ====================================================================== */
export const SABOTAGE = [
  {
    name: "no-jump-record",
    file: "src/server/failover.mjs",
    where: "把「入口 ≠ 实际服务」这一条判据去掉，让 noteSilentJump 对任何 tries 都留痕",
    from: `  const served = tries.find((t) => t && t.ok === true && t.provider && t.provider !== from);`,
    to: `  const served = tries.find((t) => t && t.ok === true && t.provider);`,
    reds: "① 入口=实际服务不产生记录（不误报那条）+ 面板不报那条",
  },
  {
    name: "unbounded-log",
    file: "src/server/failover.mjs",
    where: "把明细环的溢出淘汰摘掉（模拟「忘了加上界」）",
    from: `  if (silentJumpLog.length > SILENT_JUMP_LOG) silentJumpLog.length = SILENT_JUMP_LOG;`,
    to: `  // sabotage: 无界`,
    reds: "① 内存有界（5000 次之后 recent 不得 > 50）",
  },
  {
    name: "silent-in-card",
    file: "src/server/cards/failover.js",
    where: "把面板提示整段换成占位（模拟「又只写进日志了」）",
    from: `      box.innerHTML = \`
        <div class="jhead"><span class="jico">!</span><b>\${esc(adv.title)}</b></div>
        <div class="jlines">\${adv.lines.map((l) => \`<div>\${esc(l)}</div>\`).join("")}</div>
        <div class="jadvice">\${esc(adv.advice)}</div>\`;`,
    to: `      box.innerHTML = "";`,
    reds: "③ 告警块画在开关之前 + 入口≠实际必出提示",
  },
  {
    name: "no-dirty-guard",
    file: "src/server/cards/failover.js",
    where: "把 dirty 闸摘掉（回到「每 5 秒轮询覆盖用户刚点的开关」）",
    from: `        if (!dirty && typeof f.enabled === "boolean") enabled = f.enabled;`,
    to: `        if (typeof f.enabled === "boolean") enabled = f.enabled;`,
    reds: "③ 点关后 update 一轮仍保持关 + 清脏后恢复同步",
  },
];

/* 反向对照执行器靠这个参数把表读出去（复制一份的迟早与源码脱节）。 */
if (process.argv.includes("--emit-sabotage")) {
  process.stdout.write(JSON.stringify(SABOTAGE));
  process.exit(0);
}
