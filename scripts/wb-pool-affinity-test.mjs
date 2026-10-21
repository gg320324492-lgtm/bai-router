/**
 * wb-pool-affinity-test.mjs —— 会话亲和（session-store）接进 WorkBuddy 账号池的选号路径
 *
 * ## 测什么
 *
 * 接的是 `src/server/wb-pool-wiring.mjs` 里的会话亲和那一段（**内核 wb-pool.mjs 另有
 * `wb-pool-test.mjs` 锁着**）。核心是四句话：
 *
 *   ① **同一段对话尽量落在同一个账号上**（保住上游的 prompt cache —— 换号 = 整段重算）。
 *   ② **那个号用不了了才换**：冷却 / 额度用尽 / 停用 → 换一个，但**绑定留着**
 *      （「休息」≠「死了」：休息的号等会儿还能用）。
 *   ③ **凭据真的死了 → 永久解绑**（`forgetTarget`）：死了的号再粘着就是**死等**。
 *   ④ **池子空了 / 只有冷却中的号 → 行为与改动前逐字一致**（失败原因只问池子）。
 *
 * ## 判据的形状（每条都配了「判据自己失效了」的对照）
 *
 *   · 亲和命中与老那套内存粘性**故意分开验**：用 round-robin 模式（模式选号一定换人）
 *     + 把老粘性手工指到别的号 —— 这样「第二次还落在同一个号上」只可能是新那套干的。
 *   · 「额度用尽 → 绑定还在」与「判死 → 绑定被清掉」是**两条方向相反**的断言，
 *     少一条都留得下「一律解绑」或「一律不解绑」的坏实现。
 *   · 「行为与改动前一致」不是靠嘴说的：真的把 **git HEAD 那一份接线层**取出来
 *     （改掉 import 路径后单独 import），同一个输入跑两遍逐字对比。
 *
 * ## 反向对照
 *
 *   文件末尾 `SABOTAGE` 一节列了全部「改坏」手法；配套执行器
 *   `node scripts/wb-pool-affinity-test.mjs --sabotage <名字>` 把每条真的打到
 *   **源码的一份临时拷贝**上（绝不碰仓库里的源码），跑一遍测试，确认**必须红**。
 *
 *   判据只有一个：**改回改前行为，测试必须红**。
 *
 * ## 红线
 *
 *   🔴 全文没有一个真实令牌/API key（夹具是明显假的占位串）。
 *   🔴 落盘只在 `os.tmpdir()` 下的临时目录 —— **绝不碰真实的 %APPDATA%\bai-router**。
 *   🔴 不起业务进程、不发网络请求（只有反向对照那一档会起一个 `node --test` 子进程，
 *      跑的是本文件自己）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  wbPoolOf, wbPickAccount, wbNoteFailure, wbNoteRefreshFailure, wbNoteSuccess,
  wbAffinityConfigure, wbAffinityEntries, wbAffinitySave, wbAffinityPath,
  wbResetRuntime,
} from "../src/server/wb-pool-wiring.mjs";
import { sessionKey, conversationIdOf } from "../src/server/session-id.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const WIRING = path.join(REPO, "src", "server", "wb-pool-wiring.mjs");
const POOL = path.join(REPO, "src", "server", "wb-pool.mjs");
const TEST_FILE = path.join(HERE, "wb-pool-affinity-test.mjs");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-wb-affinity-"));
/* 临时目录用完就删（🔴 绝不留在用户的临时目录里积灰）。 */
process.on("exit", () => {
  try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ }
});

/* 明显不是真令牌的假凭据。🔴 红线：绝不把真令牌写进任何文件/命令行/日志。 */
const DUMMY_A = "wbdummy-a.bbdummy-not-real.bbdummy-payload";
const DUMMY_B = "wbdummy-b.bbdummy-not-real.bbdummy-payload";
const DUMMY_C = "wbdummy-c.bbdummy-not-real.bbdummy-payload";

/** 固定时刻（比真实时钟早几个月，正好用来验「时间源由调用方注入」）。 */
const NOW = 1789000000000;
const MIN = 60 * 1000;

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 多账号配置：几条假令牌 + 明确的 order。 */
function poolCfg({ tokens = [DUMMY_A, DUMMY_B], extra = {}, version = "wb" } = {}) {
  const acc = tokens.map((t, i) => ({
    id: `a${i + 1}`, label: `假账号-${i + 1}`, version, order: i,
    accessToken: t, refreshToken: "", deviceToken: "", userId: "",
    credential: { lastRefreshTime: NOW - 10 * MIN, capturedAt: NOW - 10 * MIN },
    modelCooldowns: {},
  }));
  return { [version]: { accessToken: "", refreshToken: "", accounts: acc, ...extra } };
}

/** 永远返回「还没到期」的到期解码器。 */
const farFuture = () => NOW + 30 * 24 * 60 * MIN * 1000;
const pick = (cfg, o = {}) => wbPickAccount(cfg, "wb", {
  now: NOW, tokenExpOf: farFuture, model: null, sessionKey: null, ...o,
});

/**
 * 每个用例一份干净状态：**内存里的池/粘性/亲和表全清**，亲和表落盘到
 * 本用例专属的临时目录（🔴 绝不碰真实的 %APPDATA%\bai-router）。
 */
function fresh() {
  wbResetRuntime();
  const dir = mkdtempSync(path.join(TMPROOT, "case-"));
  wbAffinityConfigure({ dir, mode: "auto" });
  return dir;
}

/** 记一笔「这段对话归这个号」——**答完之后**调用方要做的那件事。 */
function answered(cfg, p, o) {
  return wbNoteSuccess(cfg, p, { cacheRead: 4096, cacheWrite: 4096, model: "hy4", now: NOW, ...o });
}

/* ================================================================== *
 * ① 同一段对话落在同一个账号上
 * ================================================================== */
describe("① 同一段对话落在同一个账号上（亲和优先）", () => {
  test("同会话第二次请求落在同一个账号上（round-robin 下也粘住）", async () => {
    fresh();
    /* round-robin：只看模式的话第二次**一定换人**（游标会推进）。
       所以「第二次还落在 a1」这件事，只可能是亲和层干的。 */
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B], extra: { poolMode: "round-robin" } });

    const first = await pick(cfg, { model: "hy4", sessionKey: "conv-1" });
    assert.equal(first.ok, true);
    assert.equal(first.accountId, "a1", "第一次按模式选，落 a1");

    const rec = answered(cfg, "wb", { sessionKey: "conv-1", accountId: first.accountId });
    assert.equal(rec.ok, true, "★ 答完之后必须记一笔");

    const second = await pick(cfg, { model: "hy4", sessionKey: "conv-1", now: NOW + MIN });
    assert.equal(second.accountId, "a1", "★ 同一段对话必须落在同一个账号上（保住 prompt cache）");
    assert.equal(second.how, "affinity", "必须是走亲和命中（不是模式轮换、也不是老那套粘性）");
    assert.equal(second.bound, true);
  });

  test("★ 反向对照：新层压过老那套内存粘性（老粘性指向别的号时仍用新层的目标）", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    const first = await pick(cfg, { model: "hy4", sessionKey: "conv-2" });
    assert.equal(first.accountId, "a1");

    answered(cfg, "wb", { sessionKey: "conv-2", accountId: "a1" });

    /* 手工把**老那套**内存粘性指到 a2（模拟两套已经漂移）。
       老那套是不讲「缓存值不值得留」的，它只会无脑粘住 a2 ——
       所以这一条能分开「谁做的决定」。 */
    const pool = wbPoolOf(cfg, "wb");
    pool.sticky.set("conv-2", "a2");

    const sel = await pick(cfg, { model: "hy4", sessionKey: "conv-2", now: NOW + MIN });
    assert.equal(sel.accountId, "a1", "★ 亲和层对这条会话说了算，老那套让位");
    assert.equal(sel.how, "affinity");
    assert.equal(pool.sticky.get("conv-2"), "a1", "老那套的绑定必须跟着回到同一个号");
  });

  test("调用方没报缓存量时按「留着」处理（信息缺失 ≠ 缓存不值）", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B], extra: { poolMode: "round-robin" } });
    const first = await pick(cfg, { model: "hy4", sessionKey: "conv-nocache" });
    /* ⚠ **没报**缓存量（cacheRead/cacheWrite/input 全空）——
       magpie 的判据这时无从判断。若把它当成「缓存不值」，
       每条会话都会每轮换号 → **每轮重建 prompt 缓存**（比不接亲和还糟）。 */
    const rec = wbNoteSuccess(cfg, "wb", { sessionKey: "conv-nocache", accountId: first.accountId, model: "hy4", now: NOW });
    assert.equal(rec.ok, true);

    const second = await pick(cfg, { model: "hy4", sessionKey: "conv-nocache", now: NOW + MIN });
    assert.equal(second.accountId, first.accountId, "★ 不知道缓存有多少时必须照粘");
    assert.equal(second.how, "affinity");
  });

  test("usage 对象能直接喂进去（Anthropic 与 OpenAI 两种字段名都认）", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B], extra: { poolMode: "round-robin" } });
    const first = await pick(cfg, { model: "hy4", sessionKey: "conv-usage" });
    const rec = wbNoteSuccess(cfg, "wb", {
      sessionKey: "conv-usage", accountId: first.accountId, model: "hy4", now: NOW,
      usage: { input_tokens: 5000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 3000 },
    });
    assert.equal(rec.ok, true);
    const e = wbAffinityEntries("wb").find((x) => x.key === "conv-usage");
    assert.equal(e.meta.cacheRead, 4000);
    assert.equal(e.meta.cacheWrite, 3000);
    assert.equal(e.meta.input, 5000);

    /* OpenAI 形状（WorkBuddy 的 /v2/chat/completions 走的是这一套）。 */
    wbNoteSuccess(cfg, "wb", {
      sessionKey: "conv-usage2", accountId: "a1", model: "hy4", now: NOW,
      usage: { prompt_tokens: 5000, prompt_tokens_details: { cached_tokens: 4000 } },
    });
    const e2 = wbAffinityEntries("wb").find((x) => x.key === "conv-usage2");
    assert.equal(e2.meta.cacheRead, 4000, "OpenAI 的 cached_tokens 也要认出来");
    assert.equal(e2.meta.input, 5000);
  });

  test("报告了「缓存很小」时按 magpie 的判据换号（no-cache ≠ 不粘）", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B], extra: { poolMode: "round-robin" } });
    const first = await pick(cfg, { model: "hy4", sessionKey: "conv-tiny" });
    /* 缓存只有 100 token：magpie 的 no-cache 判据（<1024）→ 不值得留 → 换号。 */
    wbNoteSuccess(cfg, "wb", {
      sessionKey: "conv-tiny", accountId: first.accountId, cacheRead: 100, cacheWrite: 0, model: "hy4", now: NOW,
    });
    const second = await pick(cfg, { model: "hy4", sessionKey: "conv-tiny", now: NOW + MIN });
    assert.equal(second.accountId, "a2", "★ 知道缓存很小 → 换号（magpie 的 no-cache 判据）");
    assert.equal(second.how, "round-robin", "换号后按模式选，不硬粘");
  });

  test("没有会话 key 的请求不留下任何绑定（池子自己不造会话 id）", async () => {
    fresh();
    const cfg = poolCfg();
    await pick(cfg, { model: "hy4", sessionKey: null });
    assert.equal(wbAffinityEntries("wb").length, 0, "★ 探测/健康检查不得占住一条亲和绑定");
    const st = wbPoolOf(cfg, "wb");
    assert.equal(st.sticky.size, 0, "老那套也不该留下绑定");
  });

  test("两套并存：key 空间分开时，老那套服务派生 key、新那套服务原生头", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    const native = sessionKey("claude-code", "sess-1");          // 有原生会话头
    const derived = conversationIdOf([{ role: "user", content: "hi" }]);   // 没有，靠派生

    /* 原生头的请求走**新那套**（持久化 + magpie 判据）。 */
    const a = await pick(cfg, { model: "hy4", sessionKey: native, stickyKey: null });
    answered(cfg, "wb", { sessionKey: native, accountId: a.accountId });
    const a2 = await pick(cfg, { model: "hy4", sessionKey: native, stickyKey: null, now: NOW + MIN });
    assert.equal(a2.accountId, a.accountId, "原生头的请求粘在新那套上");
    assert.equal(a2.how, "affinity");

    /* 派生 key 的请求走**老那套**（内存粘性，无条件粘）。 */
    const b = await pick(cfg, { model: "hy4", sessionKey: null, stickyKey: derived });
    const b2 = await pick(cfg, { model: "hy4", sessionKey: null, stickyKey: derived, now: NOW + MIN });
    assert.equal(b2.accountId, b.accountId, "派生 key 的请求粘在老那套上");
    assert.equal(b2.how, "sticky");

    /* 两套各记各的，谁也不污染谁。 */
    assert.equal(wbAffinityEntries("wb").some((e) => e.key === derived), false, "派生 key 不该进新那套");
    assert.equal(wbPoolOf(cfg, "wb").sticky.has(native), false, "原生 key 不该进老那套");
    assert.equal(wbPoolOf(cfg, "wb").sticky.get(derived), b.accountId);
  });

  test("会话 key 由调用方给（session-id 的两种来源都能用）", async () => {
    fresh();
    const cfg = poolCfg();
    /* 原生头来的会话 id */
    const k1 = sessionKey("claude-code", "abc-123");
    assert.equal(k1, "claude-code|abc-123");
    /* 没有原生头时，派生一份（首条 user 消息的哈希） */
    const k2 = conversationIdOf([{ role: "user", content: "hi" }]);
    assert.match(k2, /^magpie-[0-9a-f]{24}$/);
    /* 两者都不是的话：没有会话 */
    assert.equal(conversationIdOf([]), null);
    assert.equal(sessionKey("claude-code", ""), null);

    await pick(cfg, { model: "hy4", sessionKey: k1 });
    answered(cfg, "wb", { sessionKey: k1, accountId: "a1" });
    await pick(cfg, { model: "hy4", sessionKey: k2 });
    answered(cfg, "wb", { sessionKey: k2, accountId: "a1" });

    const keys = wbAffinityEntries("wb").map((e) => e.key).sort();
    assert.deepEqual(keys, [k1, k2].sort(), "两条会话各自绑定");
  });
});

/* ================================================================== *
 * ② 用不了了才换（休息 ≠ 死）
 * ================================================================== */
describe("② 那个号用不了了才换：休息留着绑定，死了清掉绑定", () => {
  test("粘着的账号额度用尽 → 换一个，且绑定还在（不是 forgetTarget）", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    const first = await pick(cfg, { model: "hy4", sessionKey: "conv-3" });
    assert.equal(first.accountId, "a1");
    answered(cfg, "wb", { sessionKey: "conv-3", accountId: "a1" });

    /* a1 额度用尽（402）：整号长冷却，但**不是死**。 */
    wbNoteFailure(cfg, "wb", { accountId: "a1", model: "hy4", status: 402, text: "insufficient credits", now: NOW });

    const second = await pick(cfg, { model: "hy4", sessionKey: "conv-3", now: NOW + 30 * 1000 });
    assert.equal(second.ok, true);
    assert.equal(second.accountId, "a2", "★ 额度用尽必须换一个号");

    const rec = wbAffinityEntries("wb").find((e) => e.key === "conv-3");
    assert.ok(rec, "★ 绑定必须还在（休息 ≠ 死：a1 充值/冷却到点就回来了）");
    assert.equal(rec.target, "a1", "解绑 ≠ 换号：换号不等于把这条会话从 a1 身上摘掉");
  });

  test("粘着的账号凭据失效（dead）→ 换一个，且绑定被清掉", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    const first = await pick(cfg, { model: "hy4", sessionKey: "conv-4" });
    assert.equal(first.accountId, "a1");
    answered(cfg, "wb", { sessionKey: "conv-4", accountId: "a1" });
    assert.ok(wbAffinityEntries("wb").some((e) => e.key === "conv-4"), "前置：有绑定");

    /* 凭据被吊销（刷新路径，invalid_grant —— 判死的唯一依据之一）。 */
    wbNoteRefreshFailure(cfg, "wb",
      Object.assign(new Error("x"), { status: 400, text: '{"error":"invalid_grant"}' }),
      { accountId: "a1", now: NOW });

    const gone = wbAffinityEntries("wb").filter((e) => e.key === "conv-4");
    assert.equal(gone.length, 0, "★ 凭据死了必须永久解绑（再粘着就是死等）");

    const second = await pick(cfg, { model: "hy4", sessionKey: "conv-4", now: NOW + 60 * 1000 });
    assert.equal(second.ok, true);
    assert.equal(second.accountId, "a2", "★ 死了必须换一个号");
  });

  test("★ 反向对照：把「休息」也当成「死」→ 上一条必然红", async () => {
    /* 判据自己失效的样子：额度用尽时把绑定也清掉。
       正确实现下「绑定还在」，坏实现下「绑定没了」——两条断言方向相反，
       所以「一律解绑」和「一律不解绑」都过不了。 */
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    await pick(cfg, { model: "hy4", sessionKey: "conv-3b" });
    answered(cfg, "wb", { sessionKey: "conv-3b", accountId: "a1" });
    wbNoteFailure(cfg, "wb", { accountId: "a1", model: "hy4", status: 402, text: "insufficient credits", now: NOW });
    assert.ok(wbAffinityEntries("wb").some((e) => e.key === "conv-3b"),
      "额度用尽不得解绑（这一条红 = 实现把「休息」当成「死」了）");

    /* 反过来：判死必须解绑（同一段代码，两种失败，两种处置）。 */
    const cfg2 = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    await pick(cfg2, { model: "hy4", sessionKey: "conv-3c" });
    answered(cfg2, "wb", { sessionKey: "conv-3c", accountId: "a1" });
    wbNoteRefreshFailure(cfg2, "wb",
      Object.assign(new Error("x"), { status: 400, text: "invalid_grant" }),
      { accountId: "a1", now: NOW });
    assert.equal(wbAffinityEntries("wb").some((e) => e.key === "conv-3c"), false,
      "判死必须解绑（这一条红 = 实现把「死」当成「休息」了）");
  });

  test("strict 模式：粘着的号休息中就如实报错，不偷偷换人", async () => {
    const dir = fresh();
    wbAffinityConfigure({ dir, mode: "strict" });
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    const first = await pick(cfg, { model: "hy4", sessionKey: "conv-strict" });
    answered(cfg, "wb", { sessionKey: "conv-strict", accountId: first.accountId });

    wbNoteFailure(cfg, "wb", { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: NOW });
    const sel = await pick(cfg, { model: "hy4", sessionKey: "conv-strict", now: NOW + 30 * 1000 });
    assert.equal(sel.ok, false, "★ strict 不许偷偷换人（magpie #1797）");
    assert.equal(sel.reason, "cooling_model", "报的是那个号自己的原因（池子给的）");
    assert.equal(sel.how, "strict");
  });

  test("亲和目标在冷却时不会被硬用（它不在可用名单里）", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    await pick(cfg, { model: "hy4", sessionKey: "conv-5" });
    answered(cfg, "wb", { sessionKey: "conv-5", accountId: "a1" });
    /* 只把 hy4 这一格冷却掉（限流），换模型仍可用。 */
    wbNoteFailure(cfg, "wb", { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: NOW });

    const same = await pick(cfg, { model: "hy4", sessionKey: "conv-5", now: NOW + 30 * 1000 });
    assert.equal(same.accountId, "a2", "冷却中的号不能被硬用（换号）");
    const rec = wbAffinityEntries("wb").find((e) => e.key === "conv-5");
    assert.ok(rec, "模型级冷却也是「休息」，绑定留着");
  });
});

/* ================================================================== *
 * ③ 池子空了 / 只有冷却中的号 → 行为与改动前一致
 * ================================================================== */
describe("③ 池子空了 / 只有冷却中的号 → 行为与改动前逐字一致", () => {
  /**
   * 改动前的接线层：真的从 git HEAD 取一份出来（改掉 import 路径后单独 import）。
   * 拿不到就返回 null —— 那几条「逐字对比」的断言自动跳过（其余硬编码断言照跑）。
   */
  async function loadBefore() {
    try {
      const r = spawnSync("git", ["show", "HEAD:src/server/wb-pool-wiring.mjs"], { cwd: REPO, encoding: "utf8" });
      if (!r || r.status !== 0 || !r.stdout) return null;
      if (r.stdout === readFileSync(WIRING, "utf8")) return null;   // HEAD 已经等于当前 → 没有「改动前」
      const abs = pathToFileURL(POOL).href;
      const patched = r.stdout.replace(/from "\.\/wb-pool\.mjs"/, `from "${abs}"`);
      const tmp = path.join(TMPROOT, "wb-pool-wiring-before.mjs");
      writeFileSync(tmp, patched, "utf8");
      return await import(pathToFileURL(tmp).href);
    } catch {
      return null;
    }
  }

  /** 选号结果里**可逐字比**的部分（pool 是对象引用，两份模块各有一份，比不了）。 */
  function comparable(sel) {
    if (!sel) return null;
    const { pool, ...rest } = sel;
    return rest;
  }

  test("空池 / 全冷却 / 全判死 → 失败原因与改动前一致", async () => {
    fresh();
    const before = await loadBefore();

    /** 同一套「故障布置」分别喂给新旧两份接线层（它们的池子各是各的，互不相干）。 */
    const coolBoth = (mod, cfg) => {
      for (const id of ["a1", "a2"]) {
        mod.wbNoteFailure(cfg, "wb", { accountId: id, model: "hy4", status: 429, text: "rate limited", now: NOW });
      }
    };
    const deadBoth = (mod, cfg) => {
      for (const id of ["a1", "a2"]) {
        mod.wbNoteRefreshFailure(cfg, "wb",
          Object.assign(new Error("x"), { status: 400, text: "invalid_grant" }),
          { accountId: id, now: NOW });
      }
    };
    const pickWith = (mod, cfg, o) => mod.wbPickAccount(cfg, "wb", {
      now: NOW, tokenExpOf: farFuture, model: "hy4", sessionKey: null, ...o,
    });

    /* 场景 1：压根没有这个渠道的配置块 */
    const empty = { };
    const nowEmpty = await pick(empty, { model: "hy4", sessionKey: "c-empty" });
    assert.equal(nowEmpty.ok, false);
    assert.equal(nowEmpty.reason, "empty");
    assert.equal(nowEmpty.total, 0);
    assert.equal(nowEmpty.eligible, 0);
    if (before) {
      const old = await pickWith(before, empty, { sessionKey: "c-empty" });
      assert.deepEqual(comparable(nowEmpty), comparable(old), "★ 与改动前逐字一致");
    }

    /* 场景 2：两个号全在冷却 → 报「等一会」，不是「请重新登录」。
       ⚠ 429 是**模型级**冷却（限流只压 (账号,模型) 那一格），所以 reason 是
       cooling_model —— 这正是「改动前就长这样」的那一份，别把它写成 cooling。 */
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    coolBoth({ wbNoteFailure }, cfg);
    const nowCool = await pick(cfg, { model: "hy4", sessionKey: "c-cool" });
    assert.equal(nowCool.ok, false);
    assert.equal(nowCool.reason, "cooling_model", "★ 全冷却要说「等一会」");
    assert.equal(nowCool.eligible, 0);
    if (before) {
      const cfgOld = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
      coolBoth(before, cfgOld);
      const old = await pickWith(before, cfgOld, { sessionKey: "c-cool" });
      assert.deepEqual(comparable(nowCool), comparable(old), "★ 与改动前逐字一致");
    }

    /* 场景 3：两个号额度都用尽 → 报「充值」，不是「等一会」 */
    const cfg2 = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    for (const id of ["a1", "a2"]) {
      wbNoteFailure(cfg2, "wb", { accountId: id, model: "hy4", status: 402, text: "insufficient credits", now: NOW });
    }
    const nowQuota = await pick(cfg2, { model: "hy4", sessionKey: "c-quota" });
    assert.equal(nowQuota.ok, false);
    assert.equal(nowQuota.reason, "quota", "★ 全额度用尽要说「充值」");
    assert.equal(nowQuota.eligible, 0);

    /* 场景 4：两个号全被判死 → 报「重新登录」，仍然不是「等一会」 */
    const cfg3 = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    deadBoth({ wbNoteRefreshFailure }, cfg3);
    const nowDead = await pick(cfg3, { model: "hy4", sessionKey: "c-dead" });
    assert.equal(nowDead.ok, false);
    assert.equal(nowDead.reason, "dead", "★ 全判死要说「重新登录」");
    assert.equal(nowDead.eligible, 0);
    if (before) {
      const cfgOld = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
      deadBoth(before, cfgOld);
      const old = await pickWith(before, cfgOld, { sessionKey: "c-dead" });
      assert.deepEqual(comparable(nowDead), comparable(old), "★ 与改动前逐字一致");
    }
  });

  test("亲和目标在冷却时，池子选不出号 → 报的还是池子给的原因", async () => {
    fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A] });
    const first = await pick(cfg, { model: "hy4", sessionKey: "c-one" });
    assert.equal(first.accountId, "a1");
    answered(cfg, "wb", { sessionKey: "c-one", accountId: "a1" });

    /* 唯一的号进了冷却 → 池子选不出号。亲和层**不能**绕过可用性判定
       （否则就是拿一枚明知用不了的号去发请求）。 */
    wbNoteFailure(cfg, "wb", { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: NOW });
    const sel = await pick(cfg, { model: "hy4", sessionKey: "c-one", now: NOW + 30 * 1000 });
    assert.equal(sel.ok, false);
    assert.equal(sel.reason, "cooling_model", "★ 失败原因只问池子");
    assert.equal(sel.eligible, 0);
  });
});

/* ================================================================== *
 * ④ 持久化
 * ================================================================== */
describe("④ 持久化：save → load → 绑定还在", () => {
  test("落盘 → 模拟重启 → 绑定还在，而且它还真的管用", async () => {
    const dir = fresh();
    const cfg = poolCfg({ tokens: [DUMMY_A, DUMMY_B] });
    const first = await pick(cfg, { model: "hy4", sessionKey: "conv-p" });
    answered(cfg, "wb", { sessionKey: "conv-p", accountId: first.accountId });

    const saved = wbAffinitySave("wb");
    assert.equal(saved.wb.ok, true, "★ 落盘必须成功");
    assert.equal(path.basename(wbAffinityPath("wb")), "wb-affinity.json");
    assert.ok(wbAffinityPath("wb").startsWith(dir), "落盘位置必须在配置的目录里");

    /* 「重启」：内存里的表全清（相当于进程退出再启动）。 */
    wbResetRuntime("wb");

    const entries = wbAffinityEntries("wb");
    assert.ok(entries.some((e) => e.key === "conv-p"), "★ 重启后绑定必须还在");
    assert.equal(entries.find((e) => e.key === "conv-p").target, "a1");

    /* 而且它还真的管用：下一轮仍然落在同一个号上。 */
    const sel = await pick(cfg, { model: "hy4", sessionKey: "conv-p", now: NOW + MIN });
    assert.equal(sel.accountId, "a1", "★ 重启后仍然粘在同一个号上");
    assert.equal(sel.how, "affinity");
  });

  test("写失败不抛（丢亲和不是丢功能）", () => {
    fresh();
    /* 指到一个**不可写**的位置（Windows 上用一个文件当目录）。 */
    const bad = path.join(TMPROOT, "not-a-dir");
    writeFileSync(bad, "x", "utf8");
    wbAffinityConfigure({ dir: path.join(bad, "sub") });
    const r = wbAffinitySave("wb");
    assert.equal(r.wb.ok, false, "写失败要说失败");
    assert.ok(r.wb.reason, "★ 失败原因要说人话");
    /* 关键：不能抛。上面这行能跑完就是证据。 */
  });
});

/* ================================================================== *
 * ⑤ 红线
 * ================================================================== */
describe("⑤ 红线", () => {
  test("接线层与内核里都没有看起来像真实凭据的串", () => {
    for (const [name, src] of [["wiring", readFileSync(WIRING, "utf8")], ["pool", readFileSync(POOL, "utf8")]]) {
      assert.equal(/\bsk-[A-Za-z0-9_-]{16,}/.test(src), false, name + " 里出现了 sk- 长串");
      assert.equal(/\bBearer\s+[A-Za-z0-9._-]{16,}/.test(src), false, name + " 里出现了 Bearer 长串");
    }
  });

  test("本文件没碰真实的 %APPDATA%\\bai-router", () => {
    const dir = fresh();
    assert.ok(dir.startsWith(os.tmpdir()), "落盘目录必须在临时目录里");
    assert.equal(/bai-router/i.test(path.basename(dir)), false);
  });
});

/* ================================================================== *
 * 反向对照的「把手册」：--list-sabotage / --sabotage <名字>
 * 配套执行器把每条真的打到**源码的一份临时拷贝**上跑一遍，确认必须红。
 * ================================================================== */
const SABOTAGE = [
  {
    name: "never-switch",
    file: "wb-pool.mjs",
    where: "affinityDecision —— 「值不值得留」那一段",
    from: "  if (looked && looked.target === rec.target) {",
    to: "  if (false && looked && looked.target === rec.target) {",
    reds: "① 同会话第二次还落在同一个账号上（永远换号 → 缓存被击穿）",
  },
  {
    name: "forget-on-rest",
    file: "wb-pool.mjs",
    where: "affinityDecision —— 判死才解绑",
    from: '  if (!st.available && st.reason === "dead") {',
    to: "  if (!st.available) {",
    reds: "② 额度用尽 → 换一个，**且绑定还在**（把「休息」当成「死」→ 绑定被清掉）",
  },
  {
    name: "never-forget-dead",
    file: "wb-pool-wiring.mjs",
    where: "wbNoteRefreshFailure —— 判死后永久解绑",
    from: "  if (res && res.failure && res.failure.dead === true) forgetAffinityTarget(p, accountId);\n  return res;\n}",
    to: "  return res;\n}",
    reds: "② 凭据失效（dead）→ 换一个，且**绑定被清掉**（不解绑 → 死等）",
  },
  {
    name: "drop-affinity-target",
    file: "wb-pool-wiring.mjs",
    where: "wbPickAccount —— 把亲和结论递给内核",
    from: "    affinityTarget: aff.target,",
    to: "    affinityTarget: null,",
    reds: "① 同会话第二次还落在同一个账号上（亲和层根本没被问）",
  },
  {
    name: "never-bind",
    file: "wb-pool-wiring.mjs",
    where: "wbNoteSuccess —— 答完之后记一笔",
    from: "  const rec = store.bind(key, accountId, {",
    to: "  const rec = null; void store.bind; void ({",
    reds: "① 同会话第二次还落在同一个账号上（从来没记过 → 没有亲和可言）",
  },
];

if (process.argv.includes("--list-sabotage")) {
  console.log(`wb-pool 亲和反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(22)} ${s.where}\n  ${"".padEnd(22)} → 会打红: ${s.reds}`);
  process.exit(0);
}

if (process.argv.includes("--sabotage")) {
  const i = process.argv.indexOf("--sabotage");
  const name = process.argv[i + 1];
  const s = SABOTAGE.find((x) => x.name === name);
  if (!s) {
    console.error(`没有这条手法：${name}。可用：${SABOTAGE.map((x) => x.name).join(", ")}`);
    process.exit(2);
  }
  /* 把源码复制一份到临时目录 → 打补丁 → 跑测试 → 必须红。
     ⚠ **绝不碰仓库里的源码**：改坏了还得还原，十次总会忘一次。 */
  const root = mkdtempSync(path.join(os.tmpdir(), "bai-affinity-sab-"));
  const srcDir = path.join(root, "src", "server");
  const scriptDir = path.join(root, "scripts");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(scriptDir, { recursive: true });
  for (const f of ["wb-pool.mjs", "wb-pool-wiring.mjs", "session-store.mjs", "session-id.mjs"]) {
    writeFileSync(path.join(srcDir, f), readFileSync(path.join(REPO, "src", "server", f), "utf8"));
  }
  writeFileSync(path.join(scriptDir, "wb-pool-affinity-test.mjs"), readFileSync(TEST_FILE, "utf8"));

  const target = path.join(srcDir, s.file);
  const src = readFileSync(target, "utf8");
  const hits = src.split(s.from).length - 1;
  if (hits !== 1) {
    console.error(`✗ ${s.name}：锚点在 ${s.file} 里命中 ${hits} 次（必须恰好 1 次）—— 补丁没打上，这条不算数`);
    process.exit(3);
  }
  writeFileSync(target, src.replace(s.from, s.to), "utf8");

  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(scriptDir, "wb-pool-affinity-test.mjs")], {
    encoding: "utf8", cwd: root,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((x) => x[1].trim());
  rmSync(root, { recursive: true, force: true });
  if (r.status === 0) {
    console.error(`✗ ${s.name}：打上补丁后测试**仍然全绿** —— 这条反向对照是假的`);
    process.exit(1);
  }
  console.log(`✔ ${s.name.padEnd(22)} [${s.file}] 会打红: ${failed.slice(0, 3).join(" | ")}`);
  process.exit(0);
}
