/**
 * usage-writer.mjs 的测试
 *
 *   node --test scripts/usage-writer-test.mjs
 *
 * ── 这个模块测什么、不测什么 ────────────────────────────────────────
 *
 * 账本（usage-ledger.mjs）已经有了，写入侧（usage-writer.mjs）负责的是
 * 「一次调用 / 一次尝试 → 账本里的那几行」。它真正要守住的只有四件事：
 *
 *   ① **写进去的字段对得上。** 事件用 camelCase（cacheWrite1h、ttftMs），
 *      账本用 magpie 的 json tag（cache_write_1h、ttft_ms）。名字对不上，
 *      账本那边**静默丢掉**那个字段还不报错（它的 build() 只认自己那张表）——
 *      所以这张对照表在本文件里**独立抄了一份**，不 import 被测模块的表。
 *
 *   ② **写账本失败绝不能让一次正常的模型调用失败。** magpie 的原话
 *      "accounting must never break a call"。这条要真的被测到，就**必须**
 *      换一个会抛的 append 替身进去 —— 不然测的是「appendRecord 本来就不抛」，
 *      而那是被测模块的保证，不是写入侧自己的保证。
 *
 *   ③ **三条 magpie 的设计不能被「顺手简化」掉**：req 与 served 各记各的；
 *      tier_served 只从回复取（绝不被 tier_asked 顶替）；handed_on 的尝试
 *      照样写自己的记录、且带 handed_on: true。
 *
 *   ④ **snapshot 只留最近 N 条**，且只给面板读、不落盘。
 *
 * ── 反向对照在本文件里自足 ──────────────────────────────────────────
 *
 * 本项目的惯例是用「手法表 + 执行器」做反向对照（改坏源码 → 测试必须红）。
 * 手法表和执行器都在这个文件里：把源码**抄一份**到临时目录、打上补丁、
 * 动态 import 它，然后拿**同一个判定体**去跑它，断言它必须挂。
 * 源文件一个字节都不动（别的测试文件也不会被波及）。
 *
 * ⚠ 抄出来的副本里 `import ... from "./usage-ledger.mjs"` 的相对路径在临时目录里
 *   是断的，所以抄写时把那个说明符**改写成真实账本文件的 file:// 绝对地址**——
 *   变体必须用**真的**账本，不能用一份副本，否则测的就不是同一个东西了。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeUsageWriter } from "../src/server/usage-writer.mjs";
import { appendRecord, loadRecords } from "../src/server/usage-ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(HERE, "..", "src", "server", "usage-writer.mjs");
const LEDGER_PATH = path.resolve(HERE, "..", "src", "server", "usage-ledger.mjs");

/* ── 小工具 ───────────────────────────────────────────────────────── */

/** 造一个临时目录；给了 test 上下文就自动在测完后删掉。 */
function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "usage-writer-test-"));
  if (t && typeof t.after === "function") {
    t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ } });
  }
  return d;
}

/**
 * 事件字段（调用方填的 camelCase）→ 账本里的 json 键（magpie 的 json tag）。
 *
 * ★ 这张表是**独立抄写**的（不 import 被测模块的 FIELD_MAP）：
 *   抄一份，测的才是「事件 → 账本」这条映射本身；import 自己的表，等于
 *   拿被测模块的答案去对被测模块的答案，改坏了也测不出来。
 *
 * ⚠ 账本的 json 名本身是**混着的**（照抄 magpie 的 Go json tag）：
 *   providerKeyId / callerKeyId / providerAccount 一族是 camelCase，
 *   session_provider / cache_read / tier_asked / ttft_ms / handed_on 一族是 snake。
 *   **别拿 CSV 的列名**（provider_key_id 那一套）来对账 —— 那是 csvHeader() 的
 *   第三列，不是账本里那个键。
 */
const EXPECT = {
  provider: "provider",
  providerAccount: "providerAccount",
  providerKeyName: "providerKeyName",
  providerKeyId: "providerKeyId",
  callerKeyName: "callerKeyName",
  callerKeyId: "callerKeyId",
  agent: "agent",
  sessionProvider: "session_provider",
  sessionAccount: "session_account",
  sessionOfficialLogin: "session_official_login",
  model: "model",
  req: "req",
  served: "served",
  upstream: "upstream",
  host: "host",
  in: "in",
  out: "out",
  cacheRead: "cache_read",
  cacheWrite: "cache_write",
  cacheWrite1h: "cache_write_1h",
  reasoning: "reasoning",
  effort: "effort",
  tierAsked: "tier_asked",
  tierSent: "tier_sent",
  tierServed: "tier_served",
  status: "status",
  error: "error",
  tries: "tries",
  ms: "ms",
  ttftMs: "ttft_ms",
  source: "source",
  kind: "kind",
  rejected: "rejected",
  handedOn: "handed_on",
};

/** 一个把每个字段都填满的事件（用来逐字段对账）。 */
const FULL_EVENT = {
  provider: "openai",
  providerAccount: "me@example.com",
  providerKeyName: "主号",
  providerKeyId: "pk-1",
  callerKeyName: "工作机",
  callerKeyId: "ck-1",
  agent: "claude-code",
  sessionProvider: "openai",
  sessionAccount: "me@example.com",
  sessionOfficialLogin: true,
  model: "gpt-5",
  req: "alias/gpt-5",
  served: "gpt-5-2026-03-01",
  upstream: "azure",
  host: "api.openai.com",
  in: 120,
  out: 34,
  cacheRead: 900,
  cacheWrite: 56,
  cacheWrite1h: 20,
  reasoning: 7,
  effort: "high",
  tierAsked: "priority",
  tierSent: "priority",
  tierServed: "flex",
  status: 200,
  error: "",
  tries: 2,
  ms: 1234,
  ttftMs: 210,
  source: "",
  kind: "",
  rejected: false,
  handedOn: false,
};

/* ── 判定体（真实测试与反向对照共用同一份） ───────────────────────── */

/**
 * 「写失败不抛」的判定。
 *
 * ★ 判定体里用的是 assert.doesNotThrow —— 它抛出来的 AssertionError 里，
 *   `actual` 是**原来那个异常**（Node 的 assert 会把它挂上去），
 *   反向对照那边正好拿它核对「挂的理由对不对」。
 *
 * @param {Function} record 调一次就写一次的 record
 */
function assertWriteFailureSwallowed(record) {
  let res;
  assert.doesNotThrow(
    () => { res = record(); },
    "★ 写盘抛异常时 record() 绝不许抛 —— accounting must never break a call",
  );
  assert.equal(res.ok, false, "写失败必须如实报失败");
  assert.match(res.error, /磁盘满了/, "失败原因要带出来");
}

/**
 * 「tier 三段」的判定：tier_served 不许从 tier_asked/tier_sent 顶替。
 *
 * @param {Function} makeRecordFor 造一条记录并返回它（真账本 / 变体都行）
 */
function assertTierServedNotFilled(makeRecordFor) {
  const a = makeRecordFor({ tierAsked: "priority", tierSent: "default", tierServed: "flex" });
  assert.equal(a.tier_asked, "priority", "tier_asked 要照记");
  assert.equal(a.tier_sent, "default", "tier_sent 要照记");
  assert.equal(a.tier_served, "flex", "★ tier_served 只从回复取，要照记送进来的那个");

  const b = makeRecordFor({ tierAsked: "priority" });
  assert.equal(b.tier_sent, "", "tier_sent 不能自己冒出来");
  assert.equal(b.tier_served, "", "★ tier_served 只从回复取，不能被 tier_asked 顶替");
}

/**
 * 「handed_on 的尝试照样写」的判定。
 *
 * @param {Function} recordAttempt writer.recordAttempt
 * @param {Function} load 读回账本的函数
 * @param {string} dir 账本目录
 */
function assertAttemptWritten(recordAttempt, load, dir) {
  recordAttempt({ provider: "openai", status: 429, error: "rate limited", in: 12, out: 0, tries: 1 });
  const got = load(dir, 0);
  assert.equal(got.length, 1, "★ 转交的那次尝试也照样写自己的记录");
  const r = got[0];
  assert.equal(r.handed_on, true, "★ handed_on 必须为 true");
  assert.equal(r.status, 429, "失败的样子要记下来");
  assert.equal(r.error, "rate limited", "失败的原因要记下来");
  assert.equal(r.in, 12, "它计费了什么要记下来");
}

/* ══════════════════════════════════════════════════════════════════
 * ① 写一条 → 读回一条，字段逐个相等
 * ══════════════════════════════════════════════════════════════════ */

test("① 写一条 → 账本里读回来，字段逐个相等", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  const res = w.record(FULL_EVENT);
  assert.equal(res.ok, true, `写失败：${res.error || ""}`);

  const got = loadRecords(dir, 0);
  assert.equal(got.length, 1, "写一条就该有一条");
  for (const [from, to] of Object.entries(EXPECT)) {
    assert.deepEqual(got[0][to], FULL_EVENT[from], `字段 ${from} → ${to} 往返后不相等`);
  }
});

test("① 事件字段名 → 账本 json 键的映射（camelCase 一个都不能错）", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  w.record({
    cacheRead: 11, cacheWrite: 22, cacheWrite1h: 33,
    sessionProvider: "sp", sessionAccount: "sa", sessionOfficialLogin: true,
    ttftMs: 44, callerKeyId: "ck", callerKeyName: "cn",
    providerKeyId: "pk", providerKeyName: "pn", providerAccount: "pa",
  });
  const r = loadRecords(dir, 0)[0];
  assert.equal(r.cache_read, 11);
  assert.equal(r.cache_write, 22);
  assert.equal(r.cache_write_1h, 33);
  assert.equal(r.session_provider, "sp");
  assert.equal(r.session_account, "sa");
  assert.equal(r.session_official_login, true);
  assert.equal(r.ttft_ms, 44);
  assert.equal(r.callerKeyId, "ck");
  assert.equal(r.callerKeyName, "cn");
  assert.equal(r.providerKeyId, "pk");
  assert.equal(r.providerKeyName, "pn");
  assert.equal(r.providerAccount, "pa");
});

test("① 事件用账本自己的 json 名（tier_asked 那一族）也认，不静默丢掉", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  w.record({ tier_asked: "priority", cache_read: 5, session_provider: "sp" });
  const r = loadRecords(dir, 0)[0];
  assert.equal(r.tier_asked, "priority", "用了账本原名也要记进去（不能静默丢掉）");
  assert.equal(r.cache_read, 5);
  assert.equal(r.session_provider, "sp");
});

test("① 时间由注入的 now 决定（内部不自己取钟）", (t) => {
  const dir = tmpDir(t);
  const stamp = Date.parse("2026-03-04T05:06:07.008Z");
  const w = makeUsageWriter({ dir, now: () => stamp });
  w.record({ agent: "x" });
  const r = loadRecords(dir, 0)[0];
  assert.equal(r.t, "2026-03-04T05:06:07.008Z", "t 必须就是 now() 给的那个时刻");
});

test("① 不给 now 时，时间由账本补（仍然是个能解析的时间）", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  w.record({ agent: "x" });
  const r = loadRecords(dir, 0)[0];
  assert.ok(Number.isFinite(Date.parse(r.t)), "t 必须是个能解析的时间");
});

/* ══════════════════════════════════════════════════════════════════
 * ② 三条不许丢的 magpie 设计
 * ══════════════════════════════════════════════════════════════════ */

test("★ ② req 与 served 各记各的，谁也不推谁", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  w.record({ req: "alias/gpt-5", served: "gpt-5-2026-03-01" });
  const [r] = loadRecords(dir, 0);
  assert.equal(r.req, "alias/gpt-5", "req = agent 问的");
  assert.equal(r.served, "gpt-5-2026-03-01", "served = 厂商说答的");

  const dir2 = tmpDir(t);
  const w2 = makeUsageWriter({ dir: dir2 });
  w2.record({ req: "alias/gpt-5" });
  const [r2] = loadRecords(dir2, 0);
  assert.equal(r2.served, "", "★ served 不能从 req 推出来");
  assert.equal(r2.req, "alias/gpt-5");
});

test("★ ② tier_asked / tier_sent / tier_served 三段：served 只从回复取", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  assertTierServedNotFilled((fields) => {
    const res = w.record(fields);
    assert.equal(res.ok, true);
    return res.record;
  });
});

test("★ ② tier_served 送进来什么，写出去就是什么（不被顶替）", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  w.record({ tierAsked: "priority", tierSent: "default", tierServed: "flex" });
  const [r] = loadRecords(dir, 0);
  assert.equal(r.tier_served, "flex", "★ 写出去的是送进来的那个");
  assert.equal(r.tier_asked, "priority");
  assert.equal(r.tier_sent, "default");
});

test("★ ② tier_served 只给 tier_asked 时必须还是空（不许猜）", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  w.record({ tierAsked: "priority" });
  const [r] = loadRecords(dir, 0);
  assert.equal(r.tier_served, "", "★ tier_served 只从回复取，不能从 tier_asked 猜出来");
});

test("★ ③ handed_on 的尝试照样写自己的记录，且带 handed_on: true", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  assertAttemptWritten((e) => w.recordAttempt(e), loadRecords, dir);
});

test("★ ③ recordAttempt 强制 handed_on: true（调用方传 false 也不行）", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  w.recordAttempt({ agent: "a", handedOn: false, status: 500 });
  const [r] = loadRecords(dir, 0);
  assert.equal(r.handed_on, true, "★ recordAttempt 的意义就是「这条是转交的」");
});

test("③ record() 写的是「请求的结果」，缺省 handed_on: false", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  w.record({ agent: "a", status: 200 });
  const [r] = loadRecords(dir, 0);
  assert.equal(r.handed_on, false, "一个请求的结果不该是「转交」");
});

/* ══════════════════════════════════════════════════════════════════
 * ③ 写失败不抛（accounting must never break a call）
 * ══════════════════════════════════════════════════════════════════ */

test("★ ③ 写盘抛异常时 record() 不抛，且不影响后续调用", (t) => {
  const dir = tmpDir(t);
  const logs = [];
  let boom = true;
  const append = (d, rec) => {
    if (boom) throw new Error("磁盘满了");
    return appendRecord(d, rec);
  };
  const w = makeUsageWriter({ dir, append, logger: (m) => logs.push(m) });

  assertWriteFailureSwallowed(() => w.record({ agent: "a" }));
  assert.ok(logs.length >= 1, "写失败必须报一声（走 logger），不能悄悄吞掉");

  /* 一次写失败不该让 writer 变成坏的后续状态。 */
  boom = false;
  const res2 = w.record({ agent: "b" });
  assert.equal(res2.ok, true, "写失败之后，后续调用必须照常写");
  assert.deepEqual(loadRecords(dir, 0).map((r) => r.agent), ["b"], "账本里该有且只有写成功的那条");
});

test("★ ③ 写盘返回 ok:false 时 record() 不抛、如实报失败", (t) => {
  const dir = tmpDir(t);
  const logs = [];
  const append = () => ({ ok: false, error: "权限不对" });
  const w = makeUsageWriter({ dir, append, logger: (m) => logs.push(m) });

  let res;
  assert.doesNotThrow(() => { res = w.record({ agent: "a" }); });
  assert.equal(res.ok, false);
  assert.match(res.error, /权限不对/);
  assert.ok(logs.length >= 1, "写失败必须报一声");
});

test("★ ③ 目录不存在时 record() 不抛，也不偷偷把目录建出来", (t) => {
  const dir = tmpDir(t);
  const missing = path.join(dir, "并不存在的目录");
  const logs = [];
  const w = makeUsageWriter({ dir: missing, logger: (m) => logs.push(m) });
  let res;
  assert.doesNotThrow(() => { res = w.record({ agent: "a" }); });
  assert.equal(res.ok, false);
  assert.ok(!fs.existsSync(missing), "不许偷偷把目录建出来");
});

test("③ logger 自己炸了也不许弄坏调用", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({
    dir,
    append: () => ({ ok: false, error: "写不进去" }),
    logger: () => { throw new Error("logger 坏了"); },
  });
  assert.doesNotThrow(() => { w.record({ agent: "a" }); });
});

test("③ record() 不带参数也不炸（写一条空记录）", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  let res;
  assert.doesNotThrow(() => { res = w.record(); });
  assert.equal(res.ok, true);
  assert.equal(loadRecords(dir, 0).length, 1);
});

/* ══════════════════════════════════════════════════════════════════
 * ④ snapshot：只留最近 N 条，只给面板读，不落盘
 * ══════════════════════════════════════════════════════════════════ */

test("④ snapshot() 超过 N 条时只留最近 N 条", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir, keep: 3 });
  for (let i = 0; i < 10; i++) w.record({ agent: `a${i}` });
  const snap = w.snapshot();
  assert.equal(snap.length, 3, "只留最近 3 条");
  assert.deepEqual(snap.map((r) => r.agent), ["a7", "a8", "a9"], "留的是最近的，不是最前面的");
  void dir;
});

test("④ snapshot() 默认留 200 条", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir, append: () => ({ ok: true }) });
  for (let i = 0; i < 205; i++) w.record({ agent: `a${i}` });
  const snap = w.snapshot();
  assert.equal(snap.length, 200, "缺省就是 200 条");
  assert.equal(snap[0].agent, "a5", "砍掉的是最前面的 5 条");
  assert.equal(snap[199].agent, "a204", "最后一条必须是最近的");
});

test("④ snapshot() 返回的是副本：改了它不影响 writer 的状态", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir });
  w.record({ agent: "a" });
  const snap = w.snapshot();
  snap[0].agent = "被改坏了";
  assert.equal(w.snapshot()[0].agent, "a", "面板不该能改坏 writer 的内部状态");
});

test("④ snapshot 只在内存里：账本里没有的东西，账本里还是没有", (t) => {
  const dir = tmpDir(t);
  const w = makeUsageWriter({ dir, append: () => ({ ok: false, error: "写不进去" }) });
  w.record({ agent: "a" });
  assert.equal(w.snapshot().length, 1, "快照是内存里的活事实");
  assert.equal(loadRecords(dir, 0).length, 0, "写不进去的，账本里当然没有");
});

/* ══════════════════════════════════════════════════════════════════
 * ⑤ 反向对照：改坏源码，同一个判定体必须打红
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 手法表：**改坏源码的手法**就是这里的 from → to。
 *
 * 这一张表是唯一的出处：下面的反向对照测试按名字从这里取补丁，
 * 末尾的 --sabotage 也打印它 —— 一处定义，不会漂。
 */
const SABOTAGE = [
  {
    name: "写盘不兜 try/catch",
    from: "    let res;\n" +
      "    try {\n" +
      "      res = append(dir, rec);\n" +
      "    } catch (e) {\n" +
      "      report(`用量账本：写盘抛异常，已吞掉（${describe(e)}）`);\n" +
      "      return { ok: false, error: describe(e), record: { ...rec } };\n" +
      "    }",
    to: "    const res = append(dir, rec);",
    where: "record() 不再吞掉写盘的异常",
    reds: "★ ③ 写盘抛异常时 record() 不抛，且不影响后续调用",
  },
  {
    name: "tier_served 从 tier_asked 顶替",
    from: "    return makeRecord(fields);",
    to: "    fields.tier_served = fields.tier_sent || fields.tier_asked;\n" +
      "    return makeRecord(fields);",
    where: "写入侧从请求猜 tier_served",
    reds: "★ ② tier_asked / tier_sent / tier_served 三段：served 只从回复取",
  },
  {
    name: "recordAttempt 不强制 handed_on",
    from: "    recordAttempt(event) {\n" +
      "      return write(event, true);\n" +
      "    },",
    to: "    recordAttempt(event) {\n" +
      "      return write(event, undefined);\n" +
      "    },",
    where: "「转交」这个语义由调用方的入参说了算",
    reds: "★ ③ handed_on 的尝试照样写自己的记录，且带 handed_on: true",
  },
];

/** 按名字取一条手法。 */
function sabotage(name) {
  const s = SABOTAGE.find((x) => x.name === name);
  assert.ok(s, `手法表里没有「${name}」`);
  return s;
}

/**
 * 把源码抄一份、打上补丁、动态 import 它，拿来跑判定体。
 * 源文件一个字节都不动。
 *
 * ⚠ 抄出来的副本里 `from "./usage-ledger.mjs"` 的相对路径在临时目录里是断的，
 *   所以要把那个说明符改写成**真实**账本文件的 file:// 地址 —— 变体必须用真的账本。
 */
async function withMutant(from, to, fn) {
  const src = fs.readFileSync(MODULE_PATH, "utf8");
  const hits = src.split(from).length - 1;
  assert.equal(hits, 1, `手法失效：锚点在源码里命中 ${hits} 次（必须恰好 1 次）`);
  const mutated = src.replace(from, to);
  const anchor = 'from "./usage-ledger.mjs"';
  assert.equal(mutated.split(anchor).length - 1, 1, "手法失效：账本 import 锚点必须恰好命中一次");
  const rewritten = mutated.replace(anchor, `from "${pathToFileURL(LEDGER_PATH).href}"`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-writer-mutant-"));
  try {
    const file = path.join(dir, `mutant-${process.pid}-${Math.floor(Math.random() * 1e9)}.mjs`);
    fs.writeFileSync(file, rewritten, "utf8");
    const mod = await import(pathToFileURL(file).href);
    return await fn(mod, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("★ ⑤ 反向对照 A：把「写盘不兜 try/catch」改坏 → 同一判定体必须打红", async () => {
  const s = sabotage("写盘不兜 try/catch");
  await withMutant(s.from, s.to, async (mod, dir) => {
    const w = mod.makeUsageWriter({
      dir,
      append: () => { throw new Error("磁盘满了"); },
      logger: () => {},
    });
    /* 断言它挂的理由要**对**：是因为写盘抛异常不再被吞而挂，不是因为别的什么坏了。
       否则「打红」也可能是个假的（比如模块根本没 import 成功）。
       assert.doesNotThrow 抛出来的 AssertionError 里，actual 是原来那个异常。 */
    assert.throws(
      () => assertWriteFailureSwallowed(() => w.record({ agent: "a" })),
      (err) => {
        assert.match(err.message, /绝不许抛/, "挂的理由要是「record() 把异常抛出来了」");
        assert.match(String(err.actual?.message ?? ""), /磁盘满了/, "挂的理由要是「写盘的异常冒出来了」");
        return true;
      },
      "改坏了竟然还过 —— 这条反向对照是假的",
    );
  });
});

test("★ ⑤ 反向对照 B：把 tier_served 从 tier_asked 顶替 → 同一判定体必须打红", async () => {
  const s = sabotage("tier_served 从 tier_asked 顶替");
  await withMutant(s.from, s.to, async (mod, dir) => {
    const w = mod.makeUsageWriter({ dir });
    /* 断言它挂的理由要**对**：是因为 tier_served 被 tier_sent 顶替而挂，
       不是因为别的什么坏了（比如模块根本没 import 成功）。 */
    assert.throws(
      () => assertTierServedNotFilled((fields) => w.record(fields).record),
      (err) => {
        assert.match(err.message, /tier_served 只从回复取/, "挂的理由要是「tier_served 被顶替了」");
        assert.equal(err.actual, "default", "挂的理由要是「tier_served 被 tier_sent 顶替了」");
        return true;
      },
      "改坏了竟然还过 —— 这条反向对照是假的",
    );
  });
});

test("★ ⑤ 反向对照 C：把 recordAttempt 的 handed_on 强制去掉 → 同一判定体必须打红", async () => {
  const s = sabotage("recordAttempt 不强制 handed_on");
  await withMutant(s.from, s.to, async (mod, dir) => {
    const w = mod.makeUsageWriter({ dir });
    assert.throws(
      () => assertAttemptWritten((e) => w.recordAttempt(e), loadRecords, dir),
      /handed_on 必须为 true/,
      "改坏了竟然还过 —— 这条反向对照是假的",
    );
  });
});

/* ── 手法表（给人看的）：node scripts/usage-writer-test.mjs --sabotage ── */
if (process.argv.includes("--sabotage")) {
  console.log(`usage-writer 反向对照手法（${SABOTAGE.length} 条）：`);
  for (const s of SABOTAGE) {
    console.log(`  ${s.name.padEnd(22)} ${s.where}`);
    console.log(`  ${"".padEnd(22)} → 会打红: ${s.reds}`);
  }
  process.exit(0);
}
