/**
 * scripts/panel-state-truth-test.mjs —— 面板两处「**说假话**」的钉死（纯前端，不起服务）。
 *
 * 两个 bug，同一家族：**界面拿到的状态不对，于是把一件事说成另一件事**。
 *
 *   ① 令牌捕获成功了，「正在等」的面板却不撤（POST 抢先走 settle()，那里原来不隐藏）
 *   ② 可用性探测明明在跑，却一直显示「正在排队/发起探测」（读的是模块级**陈旧**状态，
 *      且读失败时把「没读到」冒充成「在排队」）
 *
 * 为什么不抄一份逻辑进测试、而是**把真源码抠出来**跑：
 * 抄的那份证明不了产品代码的形状 —— 产品改坏了测试还照样绿，那比没有测试更坏。
 * 抠法沿用 api-timeout-budget-test.mjs 的既有做法（按注释锚点切片 + 最小沙箱注入）。
 *
 * 反向对照：本文件末尾 SABOTAGE 表 + scripts/panel-state-sabotage-run.mjs。
 * 判据只有一个——改回改前行为，测试必须红。
 *
 * 红线：不写真实 %APPDATA%\bai-router，不含任何真实令牌，不起服务、不发任何网络请求、
 * 不含本机绝对路径。计时器/时钟全是假的。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const TOKEN_CAPTURE = path.join(REPO, "src", "server", "cards", "token-capture.js");
const PANEL = path.join(REPO, "src", "server", "panel-common.js");

const TC_SRC = readFileSync(TOKEN_CAPTURE, "utf8");
const PANEL_SRC = readFileSync(PANEL, "utf8");

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

/* ====================================================================== *
 * 假 DOM / 假时钟 —— 只提供被抠出来那段真源码用到的东西
 * ====================================================================== */

/** 能记账的元素：textContent 每次被写都留痕，好证明「冻在最后一帧」而不是「压根没动过」。 */
function el(tag = "div") {
  const e = {
    tagName: tag, style: { display: "" }, disabled: false, checked: false,
    _writes: [], get textContent() { return this._t; }, set textContent(v) { this._t = String(v); this._writes.push(this._t); },
    _t: "",
  };
  return e;
}
/** 令牌捕获那张卡的 scope：$() 按 data-role 取节点，取不到返回 null（与 querySelector 一致）。 */
function makeScope() {
  const nodes = {
    '[data-role="prog"]': el(),
    '[data-role="ptitle"]': el(),
    '[data-role="pdesc"]': el(),
    '[data-role="res"]': el(),
    '[data-role="stat"]': el(),
    '[data-role="keys"]': el(),
    '[data-role="auto-restart"]': el(),
  };
  nodes['[data-role="prog"]'].style.display = "none";   // 模板里就是 display:none
  const btn = el("button");
  btn.textContent = "一键获取令牌";
  const sc = { $: (sel) => (sel in nodes ? nodes[sel] : null), btn, nodes };
  return sc;
}

/** 假时钟：记下活着的 setInterval，并能**手动推进**轮询那一拍。 */
function makeClock() {
  const live = new Map();
  let next = 1;
  return {
    setInterval(fn, ms) { const id = next++; live.set(id, { fn, ms }); return id; },
    clearInterval(id) { live.delete(id); },
    liveCount: () => live.size,
    /** 跑一拍「轮询」定时器（poll 那个是 2000ms 的那个），返回它的返回值以便 await。 */
    async firePoll() {
      for (const t of [...live.values()]) {
        if (t.ms === 2000) return await t.fn();
      }
      return undefined;
    },
  };
}

/* --- 抠真源码：token-capture.js 的 CAP_TIPS/timers/stopTimers/claimReport/settle/…/showProgress --- */
/** 从 `from`（含）一直切到 `to`（含）**之后那一行**为止——收尾要连函数最后的 `}` 一起吃进来。 */
function cutThrough(src, from, to, what) {
  const ls = lines(src);
  const a = ls.findIndex((l) => l.includes(from));
  if (a < 0) throw new Error(`${what}：锚点「${from}」在源码里找不到 —— 代码被挪走了？`);
  const b = ls.findIndex((l, i) => i >= a && l.includes(to));
  if (b < 0) throw new Error(`${what}：抠不出收尾「${to}」—— 锚点移位了`);
  if (b + 1 >= ls.length) throw new Error(`${what}：收尾后面没有行了 —— 锚点移位了`);
  return ls.slice(a, b + 2).join("\n");
}
function cutTokenCaptureFlow() {
  /* showProgress 的收尾是 `timers.set(...)` 紧跟的那个 `}`，所以切到它**之后**一行。 */
  return cutThrough(TC_SRC, "const CAP_TIPS = [", "timers.set(sc, { tick, poll });",
    "token-capture 的等待面板那一段");
}
const TC_FLOW = cutTokenCaptureFlow();

/** 把那段真源码挂进沙箱。ctx 由调用方给（桩），时钟也由调用方给。 */
function loadFlow(clock, ctx) {
  const sb = {
    console, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    ctx, Promise, Date, JSON, Math, Number, Object, String, Array,
  };
  vm.createContext(sb);
  const mod = new vm.Script(
    `(() => {\n${TC_FLOW}\n return { settle, finishFromPoll, claimReport, showProgress, stopTimers };\n})()`
  ).runInContext(sb);
  return mod;
}

/** 后端 capture/status 的假响应（形状照真接口，数字都是编的）。 */
const STATUS_RESTARTED = (remainMs) => ({
  done: false, startedAt: 1759000000000, restarted: true, active: true,
  remainMs, timeoutMs: 600000, provider: "wbai", phaseText: "WorkBuddy AI 客户端已重启，正在等待带鉴权的请求",
});

describe("① 令牌捕获：收摊必须把「进行中」的面板收掉", () => {
  /** 摆好一次「已经跑起来」的捕获：面板可见、两个定时器活着、倒计时已经跑到某一帧。 */
  function primeRun({ remainMs = 586000 } = {}) {
    const clock = makeClock();
    const sc = makeScope();
    const results = [];
    const ctx = {
      api: async () => STATUS_RESTARTED(remainMs),
      showResult: (el2, text, good) => results.push({ text: String(text), good: !!good }),
      refreshConfig: async () => { },
      poll: () => { },
    };
    const flow = loadFlow(clock, ctx);
    const run = {
      prevStartedAt: null, reported: false, settled: false,
      btn: sc.btn, old: "一键获取令牌", restartBox: sc.nodes['[data-role="auto-restart"]'], autoRestart: false,
    };
    flow.showProgress(sc, true, run);
    return { clock, sc, results, flow, run, box: sc.nodes['[data-role="prog"]'], pdesc: sc.nodes['[data-role="pdesc"]'] };
  }

  test("前置自检：轮询在跑时，倒计时**确实在跳**（证明后面「冻住」是真冻住）", async () => {
    const h = primeRun({ remainMs: 586000 });       // 9:46
    await h.clock.firePoll();
    const first = h.pdesc.textContent;
    assert.match(first, /还剩 9:46/, `第一帧应当是 9:46，实际：${first}`);

    h.clock.clearInterval;                          // 不动，只换一帧数据再拍一拍
    const clock2 = makeClock(); const sc2 = makeScope();
    const flow2 = loadFlow(clock2, { api: async () => STATUS_RESTARTED(586000 - 120000), showResult() { }, refreshConfig: async () => { }, poll() { } });
    const run2 = { prevStartedAt: null, reported: false, settled: false, btn: sc2.btn, old: "x", restartBox: null, autoRestart: false };
    flow2.showProgress(sc2, true, run2);
    await clock2.firePoll();
    const a = sc2.nodes['[data-role="pdesc"]'].textContent;
    const flow3 = loadFlow(makeClock(), { api: async () => STATUS_RESTARTED(586000 - 300000), showResult() { }, refreshConfig: async () => { }, poll() { } });
    assert.notEqual(a, first, "两次读到的 remainMs 不同，文案本该不同 —— 抓不到差异说明这桩断言没在测东西");
    assert.match(a, /还剩 7:46|还剩 9:4|还剩/, `文案应含剩余时间，实际：${a}`);
  });

  test("★ POST 抢先：settle() 之后 [data-role=prog] 必须不可见", async () => {
    const h = primeRun();
    await h.clock.firePoll();
    assert.equal(h.box.style.display, "flex", "前置：等待面板应当是显示着的");

    /* 这正是实测复现的那条路径：POST 的返回比轮询先到，于是它抢先 claimReport，
       走 finally → settle()（**不是** finishFromPoll，而那里原来根本不隐藏）。 */
    assert.equal(h.flow.claimReport(h.run), true, "POST 应当抢到报结果的权");
    h.results.push({ text: "✔ 令牌获取成功（eyJ…1234），已自动填入并保存。", good: true });
    await h.flow.settle(h.sc, h.run);

    assert.equal(h.box.style.display, "none",
      "POST 抢先成功后，转圈+倒计时的面板还挂着 —— 用户看到绿条说成功、面板说还在等");
  });

  test("★ settle() 之后倒计时不再更新（冻在最后一帧，不是还在跳）", async () => {
    const h = primeRun();
    await h.clock.firePoll();
    await h.flow.settle(h.sc, h.run);

    assert.equal(h.clock.liveCount(), 0,
      `settle 之后还剩 ${h.clock.liveCount()} 个定时器在跑 —— 页面关掉后仍在跑、野定时器`);
    const frozen = h.pdesc.textContent;
    assert.match(frozen, /还剩 9:46/, `冻结的那一帧应当是倒计时本身，实际：${frozen}`);

    /* 再怎么「等」也不会变：没有任何定时器活着。 */
    await new Promise((r) => setTimeout(r, 30));
    await h.clock.firePoll();
    assert.equal(h.pdesc.textContent, frozen,
      `settle 之后倒计时还在变：${frozen} → ${h.pdesc.textContent}`);
  });

  test("轮询抢先那条路（finishFromPoll）同样收得掉 —— 没被本次改动带坏", async () => {
    const h = primeRun();
    const up = {
      ok: true, masked: "eyJ…1234", hasRefresh: true, done: true,
      startedAt: h.run.prevStartedAt === null ? 1759000000000 : null,   // 与 prevStartedAt 不同 → 是本轮
    };
    h.run.prevStartedAt = 1759000000000;
    up.startedAt = 1759000009999;
    h.flow.finishFromPoll(h.sc, h.run, up);
    assert.equal(h.box.style.display, "none", "finishFromPoll 也必须收掉面板");
    assert.equal(h.clock.liveCount(), 0, "finishFromPoll 也必须停掉定时器");
    assert.ok(h.results.some((r) => /令牌获取成功/.test(r.text)), "应当报成功");
  });

  test("失败也要收（超时是有结论的失败，不能留个永远转的面板）", async () => {
    const h = primeRun();
    h.run.prevStartedAt = 1759000000000;
    h.flow.finishFromPoll(h.sc, h.run, { ok: false, error: "等待 10 分钟仍未捕获到令牌", done: true, startedAt: 1759000009999 });
    assert.equal(h.box.style.display, "none", "失败路径也必须收掉面板");
    assert.ok(h.results.some((r) => /✘ 获取失败/.test(r.text)), "应当如实报失败");
  });

  test("settle() 幂等：poll 路径先藏过一次，POST 路径再藏一遍无副作用", async () => {
    const h = primeRun();
    h.run.prevStartedAt = 1759000000000;
    h.flow.finishFromPoll(h.sc, h.run, { ok: true, masked: "x", done: true, startedAt: 1759000009999 });
    assert.equal(h.box.style.display, "none");
    await h.flow.settle(h.sc, h.run);            // 再来一次
    await h.flow.settle(h.sc, h.run);            // 再来一次
    assert.equal(h.box.style.display, "none", "重复 settle 不该把面板又翻出来");
  });

  test("不是一劳永逸的闩锁：下一轮捕获还能把面板放出来", async () => {
    const h = primeRun();
    await h.flow.settle(h.sc, h.run);
    assert.equal(h.box.style.display, "none");
    h.flow.showProgress(h.sc, true, { prevStartedAt: null, reported: false, settled: false, btn: h.sc.btn, old: "x", restartBox: null, autoRestart: false });
    assert.equal(h.box.style.display, "flex", "下一次点「重新获取令牌」必须还能看到等待面板");
  });
});

/* ====================================================================== *
 * ② 可用性探测：读本次响应、读失败不冒充「在排队」
 * ====================================================================== */
function cutSliceOf() {
  return cut(PANEL_SRC, "const sliceOf = (obj, key) =>", "};", "panel-common 的 sliceOf");
}
/** 从 panel-common.js 抠出 sliceOf + TEST_POLL_MS + waitTestDone 三个真定义。 */
function cutWaitTestDone() {
  const ls = lines(PANEL_SRC);
  const a = ls.findIndex((l) => l.includes("const TEST_POLL_MS ="));
  if (a < 0) throw new Error("panel-common.js 里找不到 TEST_POLL_MS —— 锚点移位了");
  /* TEST_WAIT_LIMIT_MS 夹在这两个之间，一并抠出来（waitTestDone 要用）。 */
  const b = ls.findIndex((l, i) => i > a && l === "  }");
  if (b < 0) throw new Error("抠不出 waitTestDone 的收尾 —— 锚点移位了");
  let src = ls.slice(a, b + 1).join("\n");
  /* 只改两件事：把 2 秒的轮询节奏缩到 5 毫秒、12 分钟的放弃窗口缩到 400 毫秒。
     测试等不起那两个数，而**反向验证要求失败必须快速变红** —— 否则把代码改坏之后
     那一轮会安静地轮询满 12 分钟才返回 null，看起来像「测试卡住了」而不是「测试红了」。
     ⚠ 缩小的前提是原文确实写着这两个数 —— 改写失败就当场炸，不许悄悄改别的。 */
  const before = src;
  src = src.replace("const TEST_POLL_MS = 2000;", "const TEST_POLL_MS = 5;")
    .replace("const TEST_WAIT_LIMIT_MS = 12 * 60 * 1000;", "const TEST_WAIT_LIMIT_MS = 400;");
  if (src === before) {
    throw new Error("抠出来的真源码里没有那两个常量 —— 轮询节奏/放弃窗口被改了？");
  }
  for (const must of ["const TEST_POLL_MS = 5;", "const TEST_WAIT_LIMIT_MS = 400;"]) {
    if (!src.includes(must)) throw new Error(`缩小没生效：${must}`);
  }
  return src;
}
const SLICE_OF = cutSliceOf();
const WAIT_SRC = cutWaitTestDone();

/**
 * 把 waitTestDone 真源码挂进沙箱。
 * @param api    真 api("/api/status") 的替身
 * @param stOf   **陷阱**：模块级陈旧状态的取法。真代码一次都不许碰它。
 */
function loadWait(api, stOf = null) {
  const results = [];
  const stOfCalls = [];
  const sb = {
    console, Promise, Date, JSON, Math, Number, Object, String, Array,
    api, setTimeout, clearTimeout,
    /* 陷阱：stOf(P) 是 poll() 五秒前的旧状态。真代码碰它 = 读到陈旧状态 = 本次要消灭的 bug。 */
    stOf: (k) => { stOfCalls.push(k); return stOf ? stOf(k) : {}; },
    showResult: (el2, text, good) => results.push({ text: String(text), good: !!good }),
  };
  vm.createContext(sb);
  const mod = new vm.Script(
    `(() => {\n${SLICE_OF}\n${WAIT_SRC}\n return { waitTestDone, TEST_POLL_MS };\n})()`
  ).runInContext(sb);
  return { ...mod, results, stOfCalls };
}
const timedOutErr = () => Object.assign(new Error("读取超时（超过 12 秒）"), { timedOut: true });
/** /api/status 的假响应。flat=true 走「平铺」那家（sliceOf 返回根对象），否则挂到 key 下。 */
function statusOf(up, P = "sn", flat = false) {
  return flat ? { upstream: up } : { [P]: { upstream: up } };
}

describe("② 可用性探测：读本次响应、且读失败不冒充「正在排队」", () => {
  test("★ 读的是**刚拿到的那份** s，不是模块级陈旧状态（stOf 一次都不许被碰）", async () => {
    /* 陈旧状态说「没在跑、也没本次结果」；这一轮真读到的 s 说「正在跑」。
       改前读 stOf → running 读到 false → 整整一轮轮地说「正在排队」。 */
    const stale = { sn: { upstream: { running: false, at: null } } };
    let calls = 0;
    const api = async () => {
      calls++;
      if (calls === 1) return statusOf({ running: true, active: true, at: null });
      return statusOf({ running: false, at: new Date().toISOString(), ok: true, tiers: [] });
    };
    const h = loadWait(api, (k) => stale[k] || {});
    const up = await h.waitTestDone("sn", {});

    assert.deepEqual(h.stOfCalls, [],
      `waitTestDone 读了 ${h.stOfCalls.length} 次模块级陈旧状态 —— 它必须只认这一轮刚拿到的响应`);
    assert.ok(h.results.some((r) => /正在逐档探测/.test(r.text)),
      `明明读到 running:true，却没显示「正在逐档探测」。实际文案：${JSON.stringify(h.results.map((r) => r.text))}`);
    assert.ok(!h.results.some((r) => /正在排队/.test(r.text)),
      `把正在跑的探测说成了「正在排队」：${JSON.stringify(h.results.filter((r) => /正在排队/.test(r.text)).map((r) => r.text))}`);
    assert.equal(up.ok, true, "应当返回这一轮的真实结论");
  });

  test("★ /api/status 读超时时，绝不显示成「正在排队/发起探测」", async () => {
    let calls = 0;
    const api = async () => {
      calls++;
      if (calls <= 3) throw timedOutErr();           // 前三轮全部读超时
      return statusOf({ running: false, at: new Date().toISOString(), ok: true, tiers: [] });
    };
    const h = loadWait(api);
    const up = await h.waitTestDone("sn", {});

    const queued = h.results.filter((r) => /正在排队/.test(r.text));
    assert.equal(queued.length, 0,
      `读失败时出现了 ${queued.length} 次「正在排队」：${JSON.stringify(queued.map((r) => r.text))}\n` +
      "—— 「没读到」被冒充成了「在排队」，用户只能一直干等");
    assert.ok(h.results.some((r) => /没读到本机状态/.test(r.text)),
      `应当如实说「这一轮没读到」。实际文案：${JSON.stringify(h.results.map((r) => r.text))}`);
    assert.equal(up.ok, true, "读失败不是失败：后面读到了就该把真实结论交出来");
  });

  test("读失败之后，下一轮读到了就自动接上真实状态（不是死路）", async () => {
    let calls = 0;
    const api = async () => {
      calls++;
      if (calls === 1) throw timedOutErr();
      if (calls === 2) return statusOf({ running: true, active: true, at: null });
      return statusOf({ running: false, at: new Date().toISOString(), ok: false, error: "上游 401", tiers: [] });
    };
    const h = loadWait(api);
    const up = await h.waitTestDone("sn", {});
    assert.ok(h.results.some((r) => /没读到本机状态/.test(r.text)), "第一轮读失败应当如实说");
    assert.ok(h.results.some((r) => /正在逐档探测/.test(r.text)), "第二轮读到 running:true 应当切到逐档探测");
    assert.equal(up.error, "上游 401", "最终应当交出这一轮的真实结论");
  });

  test("全程读得通时，行为与改前一致：跑着→逐档，跑完→真实结论", async () => {
    let calls = 0;
    const api = async () => {
      calls++;
      if (calls <= 2) return statusOf({ running: true, active: true, at: null });
      return statusOf({ running: false, at: new Date().toISOString(), ok: true, model: "m-x", tiers: [1, 2, 3, 4] });
    };
    const h = loadWait(api);
    const up = await h.waitTestDone("sn", {});
    assert.ok(h.results.filter((r) => /正在逐档探测/.test(r.text)).length >= 2, "每一轮都该显示逐档探测");
    assert.equal(up.model, "m-x", "应当返回这一轮 upstream 的原值");
    assert.equal(up.tiers.length, 4);
    const last = h.results[h.results.length - 1];
    assert.ok(!/读取超时|正在排队/.test(last.text), `最后一条是假文案：${last.text}`);
  });

  test("「平铺」那家（sliceOf 返回根对象）也读得对 —— 不许只对挂 key 的那几家生效", async () => {
    let calls = 0;
    const api = async () => {
      calls++;
      if (calls === 1) return statusOf({ running: true, active: true, at: null }, "bai", true);
      return statusOf({ running: false, at: new Date().toISOString(), ok: true }, "bai", true);
    };
    const h = loadWait(api);
    const up = await h.waitTestDone("bai", {});
    assert.equal(up.ok, true, "平铺形态那家也应当取到 upstream");
    assert.ok(!h.results.some((r) => /正在排队/.test(r.text)), "平铺形态不该掉进「正在排队」分支");
  });

  test("到点放弃时返回 null —— 把「放弃等待」说成失败正是要消灭的那类假报", async () => {
    /* 永远读超时 + 上一次留下的旧结论（at 在 t0 之前）→ 走不到返回点，
       只能由放弃窗口兜住。窗口在真源码里是 12 分钟；抠出来时缩到 400 毫秒，
       所以这桩断言跑得起来，而验的仍是**真代码**里那条 `return null`。 */
    const staleAt = new Date(Date.now() - 600000).toISOString();
    const api = async () => statusOf({ running: false, at: staleAt, ok: true, tiers: [] });
    const h = loadWait(api);
    const up = await h.waitTestDone("sn", {});
    assert.equal(up, null, "到点放弃必须返回 null（交给外层如实说「仍在服务端继续」）");
    assert.ok(!h.results.some((r) => /失败|✘/.test(r.text)),
      `放弃等待被说成了失败：${JSON.stringify(h.results.map((r) => r.text))}`);

    const src = lines(PANEL_SRC).find((l) => l.includes("const TEST_WAIT_LIMIT_MS"));
    assert.ok(src, "TEST_WAIT_LIMIT_MS 还在");
    assert.match(src, /12\s*\*\s*60\s*\*\s*1000/, `12 分钟上限被改了：${src}`);
  });
});

/* ====================================================================== *
 * 3. SABOTAGE 表（grep SABOTAGE 可定位）
 * ====================================================================== */
export const SABOTAGE = [
  {
    name: "settle-no-hide", file: "src/server/cards/token-capture.js",
    where: "把 settle() 里隐藏 [data-role=prog] 的那两行撤掉",
    from: `      const box = sc.$('[data-role="prog"]');\n      if (box) box.style.display = "none";\n      stopTimers(sc);`,
    to: `      stopTimers(sc);`,
    reds: "① POST 抢先后面板不收 + 倒计时冻结断言",
  },
  {
    name: "stale-stOf", file: "src/server/panel-common.js",
    where: "把读本次响应改回读模块级陈旧状态 stOf(P)",
    from: `if (s) lastUp = sliceOf(s, P).upstream || {};`,
    to: `if (s) lastUp = (stOf(P).upstream || {});`,
    reds: "② 读的是本次响应（stOf 陷阱）+ 平铺形态那条",
  },
  {
    name: "read-fail-as-queued", file: "src/server/panel-common.js",
    where: "把「读失败时如实说没读到」改回一句「正在排队/发起探测」",
    from: `      showResult(slot, s
        ? \`⏳ 正在排队/发起探测…（已 \${secs}s）\`
        : \`⏳ 这一轮没读到本机状态（已 \${secs}s），稍后重试。\\n\`
          + "探测在服务端跑着，面板不会掐断它，也不用刷新页面。", true);`,
    to: `      showResult(slot, \`⏳ 正在排队/发起探测…（已 \${secs}s）\`, true);`,
    reds: "② 读超时不冒充「正在排队」+ 接上真实状态那条",
  },
];

/* 反向对照执行器靠这个参数把表读出去（复制一份的迟早与源码脱节）。 */
if (process.argv.includes("--emit-sabotage")) {
  process.stdout.write(JSON.stringify(SABOTAGE));
  process.exit(0);
}