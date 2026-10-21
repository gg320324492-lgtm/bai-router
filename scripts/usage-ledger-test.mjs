/**
 * usage-ledger.mjs 的测试
 *
 *   node --test scripts/usage-ledger-test.mjs
 *
 * ── 这个模块测什么、不测什么 ────────────────────────────────────────
 *
 * 账本本身很简单：一行一条记录，写进去，读出来。但它踩的坑不简单：
 *
 *   ① **坏行不许拖垮整份账本。** 账本是多个进程可能同时在写的文件，末尾半行是
 *      常态。一行坏了只跳过那一行；把整份作废，丢的是用户全部用量历史。
 *      （这条跟 settings 的「读不出来 = 不知道，绝不当空」是**相反**的，
 *      理由见 src/server/usage-ledger.mjs 的文件头。）
 *   ② **写失败绝不能让调用失败。** 磁盘满、目录没了、权限不对，账本写不进去
 *      不能让一次本来成功的模型调用跟着失败。所以 appendRecord 不抛，只返回 ok:false。
 *   ③ **三条 magpie 的设计不能被"顺手简化"掉**：req 与 served 各记各的；
 *      tier_served 只从回复取；handed_on 的 try 仍写自己的记录但不算失败。
 *
 * ── 反向对照在本文件里自足 ──────────────────────────────────────────
 *
 * 本项目的惯例是用「手法表 + 执行器」做反向对照（改坏源码 → 测试必须红）。
 * 这次手法表和执行器都在同一个文件里：把源码**抄一份**到临时目录、打上补丁、
 * 动态 import 它，然后拿**同一个判定体**去跑它，断言它必须挂。
 * 源文件一个字节都不动（别的测试文件也不会被波及）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  makeRecord, appendRecord, loadRecords, csvHeader, toCsvRow, DIMENSIONS,
} from "../src/server/usage-ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(HERE, "..", "src", "server", "usage-ledger.mjs");

/** 账本在目录里的文件名（magpie: ~/.config/magpie/usage.jsonl）。 */
const LEDGER_FILE = "usage.jsonl";

/** 记录应有的全部 json 键（照 magpie 的 json tag 抄，不多不少）。 */
const FIELD_NAMES = [
  "t", "agent", "provider", "host", "providerKeyId", "providerKeyName", "providerAccount",
  "callerKeyId", "callerKeyName", "session_provider", "session_account", "session_official_login",
  "model", "req", "served", "upstream",
  "in", "out", "cache_read", "cache_write", "cache_write_1h", "reasoning", "effort",
  "tier_asked", "tier_sent", "tier_served", "status", "error", "tries", "ms", "ttft_ms",
  "source", "kind", "rejected", "handed_on",
];

/* ── 小工具 ───────────────────────────────────────────────────────── */

/** 造一个临时目录；给了 test 上下文就自动在测完后删掉。 */
function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "usage-ledger-test-"));
  if (t && typeof t.after === "function") {
    t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ } });
  }
  return d;
}

function ledgerFile(dir) {
  return path.join(dir, LEDGER_FILE);
}

/**
 * 把一行 CSV 拆成单元格（RFC4180：双引号内的逗号不算分隔，引号翻倍解转义）。
 * 测试里自己写一份，不去依赖被测模块的转义函数——否则转义写错了两边一起错，
 * 测出来的「列数一致」就是假的。
 */
function splitCsv(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/* ── 判定体（真实测试与反向对照共用同一份） ───────────────────────── */

/** 「中间一行坏了」的判定：坏行跳过，前后两条一条不少。 */
function assertSkipsBadLine(load, dir) {
  const got = load(dir, 0);
  assert.equal(got.length, 2, "坏行之外的两条都要读出来");
  assert.deepEqual(got.map((r) => r.agent), ["before", "after"]);
}

/** 「末尾半行」的判定：半行跳过，前面的完整记录一条不少。 */
function assertToleratesHalfLine(load, dir) {
  const got = load(dir, 0);
  assert.equal(got.length, 2, "半行之前的完整记录一条不少");
  assert.deepEqual(got.map((r) => r.agent), ["a", "b"]);
}

/** 「写失败不抛」的判定：目录不存在 → ok:false + 有 error 消息，不抛。 */
function assertWriteFailureSwallowed(append, missingDir) {
  const r = append(missingDir, makeRecord({ agent: "x" }));
  assert.equal(r.ok, false, "目录不存在时必须是 ok:false（不建目录、不假装成功）");
  assert.equal(typeof r.error, "string", "失败要给出原因");
  assert.ok(r.error.length > 0, "失败原因不能是空串");
}

/** 「tier 三段」的判定：tier_sent / tier_served 不许从 tier_asked 冒出来。 */
function assertThreeTiersIndependent(make) {
  const rec = make({ tier_asked: "priority" });
  assert.equal(rec.tier_sent, "", "tier_sent 不能自己冒出来");
  assert.equal(rec.tier_served, "", "★ tier_served 只从回复取，不能从 tier_asked 猜出来");
}

/* ══════════════════════════════════════════════════════════════════
 * ① makeRecord：字段齐全，缺省值明确
 * ══════════════════════════════════════════════════════════════════ */

test("① makeRecord 的字段齐全：一个不缺、一个不是 undefined", () => {
  const rec = makeRecord({});
  assert.deepEqual(
    Object.keys(rec).sort(),
    [...FIELD_NAMES].sort(),
    "字段集合必须与 magpie 的 json tag 一致（不多不少）",
  );
  for (const k of Object.keys(rec)) {
    assert.notEqual(rec[k], undefined, `字段 ${k} 是 undefined —— 写进 JSONL 会被 JSON.stringify 丢掉`);
  }
});

test("① makeRecord 的缺省值明确：字符串空、数字 0、布尔 false、时间=现在", () => {
  const rec = makeRecord({});
  assert.equal(rec.agent, "");
  assert.equal(rec.provider, "");
  assert.equal(rec.model, "");
  assert.equal(rec.error, "");
  assert.equal(rec.in, 0);
  assert.equal(rec.out, 0);
  assert.equal(rec.cache_read, 0);
  assert.equal(rec.cache_write, 0);
  assert.equal(rec.cache_write_1h, 0);
  assert.equal(rec.reasoning, 0);
  assert.equal(rec.status, 0);
  assert.equal(rec.tries, 0);
  assert.equal(rec.ms, 0);
  assert.equal(rec.ttft_ms, 0);
  assert.equal(rec.rejected, false);
  assert.equal(rec.handed_on, false);
  assert.equal(rec.session_official_login, false);
  assert.equal(typeof rec.t, "string");
  assert.ok(Number.isFinite(Date.parse(rec.t)), "t 必须是个能解析的时间");
});

test("① makeRecord 认得 epoch 毫秒与 ISO 字符串", () => {
  const ms = Date.parse("2026-03-04T05:06:07.008Z");
  assert.equal(makeRecord({ t: ms }).t, "2026-03-04T05:06:07.008Z");
  assert.equal(makeRecord({ t: "2026-03-04T05:06:07.008Z" }).t, "2026-03-04T05:06:07.008Z");
});

test("① makeRecord 把收不住的数字落回 0（不让一个 NaN 毁掉整张表）", () => {
  assert.equal(makeRecord({ in: "abc" }).in, 0);
  assert.equal(makeRecord({ in: NaN }).in, 0);
  assert.equal(makeRecord({ in: Infinity }).in, 0);
  assert.equal(makeRecord({ in: "42" }).in, 42);
});

/* ══════════════════════════════════════════════════════════════════
 * ② 三条不许丢的 magpie 设计
 * ══════════════════════════════════════════════════════════════════ */

test("★ ② req 与 served 各记各的，谁也不推谁", () => {
  const a = makeRecord({ req: "alias/my-model" });
  assert.equal(a.served, "", "served 不能从 req 推出来（厂商答的常常不一样）");
  assert.equal(a.req, "alias/my-model");

  const b = makeRecord({ served: "vendor/real-model" });
  assert.equal(b.req, "", "req 不能从 served 推出来");
  assert.equal(b.served, "vendor/real-model");
});

test("★ ② tier_asked / tier_sent / tier_served 三段：served 只从回复取", () => {
  assertThreeTiersIndependent(makeRecord);

  const rec = makeRecord({ tier_asked: "priority", tier_sent: "default", tier_served: "flex" });
  assert.equal(rec.tier_asked, "priority");
  assert.equal(rec.tier_sent, "default");
  assert.equal(rec.tier_served, "flex");
});

test("★ ② handed_on 的 try 仍写自己的记录（记它计费了什么、为什么失败）", () => {
  const rec = makeRecord({ agent: "claude", status: 429, error: "rate limited", handed_on: true, in: 12, out: 0 });
  assert.equal(rec.handed_on, true);
  assert.equal(rec.status, 429);
  assert.equal(rec.error, "rate limited");
  assert.equal(rec.in, 12);
});

/* ══════════════════════════════════════════════════════════════════
 * ③ 写 → 读：往返相等、顺序不乱
 * ══════════════════════════════════════════════════════════════════ */

test("③ 写一条 → 读回一条，字段逐个相等", (t) => {
  const dir = tmpDir(t);
  const rec = makeRecord({
    agent: "claude-code", provider: "openai", host: "api.openai.com",
    providerKeyId: "pk-1", providerKeyName: "主号", providerAccount: "me@example.com",
    callerKeyId: "ck-1", callerKeyName: "工作机",
    session_provider: "openai", session_account: "me@example.com", session_official_login: true,
    model: "gpt-5", req: "alias/gpt-5", served: "gpt-5-2026-03-01", upstream: "azure",
    in: 120, out: 34, cache_read: 900, cache_write: 56, cache_write_1h: 20, reasoning: 7,
    effort: "high", tier_asked: "priority", tier_sent: "priority", tier_served: "flex",
    status: 200, error: "", tries: 2, ms: 1234, ttft_ms: 210,
    source: "", kind: "", rejected: false, handed_on: false,
  });

  const r = appendRecord(dir, rec);
  assert.equal(r.ok, true, `写失败：${r.error || ""}`);
  assert.ok(fs.existsSync(ledgerFile(dir)), "账本应写在 <dir>/usage.jsonl");

  const got = loadRecords(dir, 0);
  assert.equal(got.length, 1);
  assert.deepEqual(Object.keys(got[0]).sort(), Object.keys(rec).sort());
  for (const k of Object.keys(rec)) {
    assert.deepEqual(got[0][k], rec[k], `字段 ${k} 往返后不相等`);
  }
  assert.deepEqual(got[0], rec);
});

test("③ 追加多条 → 顺序不乱", (t) => {
  const dir = tmpDir(t);
  const agents = ["a0", "a1", "a2", "a3", "a4"];
  for (const agent of agents) {
    const r = appendRecord(dir, makeRecord({ agent }));
    assert.equal(r.ok, true);
  }
  const got = loadRecords(dir, 0);
  assert.equal(got.length, agents.length);
  assert.deepEqual(got.map((x) => x.agent), agents, "读回来的顺序必须跟写进去的一样");
});

/* ══════════════════════════════════════════════════════════════════
 * ④ 读时的容错：坏行跳过、末尾半行跳过
 * ══════════════════════════════════════════════════════════════════ */

test("★ ④ 中间一行坏了 → 跳过那一行，其余照读", (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(
    ledgerFile(dir),
    JSON.stringify(makeRecord({ agent: "before" })) + "\n" +
    "{ 这不是 JSON\n" +
    JSON.stringify(makeRecord({ agent: "after" })) + "\n",
  );
  assertSkipsBadLine(loadRecords, dir);
});

test("★ ④ 解析得出来但不是个对象 → 同样是坏行", (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(
    ledgerFile(dir),
    JSON.stringify(makeRecord({ agent: "before" })) + "\n" +
    "123\n" +
    JSON.stringify(makeRecord({ agent: "after" })) + "\n",
  );
  assertSkipsBadLine(loadRecords, dir);
});

test("★ ④ 末尾半行 → 跳过它，前面的完整记录一条不少", (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(
    ledgerFile(dir),
    JSON.stringify(makeRecord({ agent: "a" })) + "\n" +
    JSON.stringify(makeRecord({ agent: "b" })) + "\n" +
    '{"t":"2026-03-04T05:06:07.008Z","agent":"half', // 别的进程正写到一半
  );
  assertToleratesHalfLine(loadRecords, dir);
});

test("④ 末尾那一行没有换行、但内容是完整的 → 照样读出来", (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(
    ledgerFile(dir),
    JSON.stringify(makeRecord({ agent: "a" })) + "\n" +
    JSON.stringify(makeRecord({ agent: "b" })), // 少了最后一个换行
  );
  const got = loadRecords(dir, 0);
  assert.deepEqual(got.map((r) => r.agent), ["a", "b"]);
});

test("④ 账本文件还不存在 → 空列表（不是「读不出来」，是还没有调用过）", (t) => {
  const dir = tmpDir(t);
  assert.deepEqual(loadRecords(dir, 0), []);
});

/* ══════════════════════════════════════════════════════════════════
 * ⑤ sinceMs 过滤
 * ══════════════════════════════════════════════════════════════════ */

test("⑤ sinceMs 过滤生效（含等于那一刻，Go 版同）", (t) => {
  const dir = tmpDir(t);
  const t1 = Date.parse("2026-03-01T00:00:00.000Z");
  const t2 = Date.parse("2026-03-02T00:00:00.000Z");
  const t3 = Date.parse("2026-03-03T00:00:00.000Z");
  appendRecord(dir, makeRecord({ t: t1, agent: "old" }));
  appendRecord(dir, makeRecord({ t: t2, agent: "mid" }));
  appendRecord(dir, makeRecord({ t: t3, agent: "new" }));

  assert.deepEqual(loadRecords(dir, t2).map((r) => r.agent), ["mid", "new"], "since 那一刻及之后的都要");
  assert.deepEqual(loadRecords(dir, t3).map((r) => r.agent), ["new"]);
  assert.deepEqual(loadRecords(dir, 0).map((r) => r.agent), ["old", "mid", "new"], "不给 since = 全取");
});

/* ══════════════════════════════════════════════════════════════════
 * ⑥ CSV
 * ══════════════════════════════════════════════════════════════════ */

test("⑥ csvHeader 顺序稳定，两次调用一模一样", () => {
  const h1 = csvHeader();
  const h2 = csvHeader();
  assert.deepEqual(h1, h2);
  assert.equal(h1[0], "time");
  assert.ok(h1.includes("requested_model"), "req 的列名沿用 magpie 的 requested_model");
  assert.ok(h1.includes("served_model"));
  assert.ok(h1.includes("handed_on"));
  /* 顺序本身也是契约：账本是拿去跟厂商账单并排看的。 */
  assert.deepEqual(h1, [
    "time", "agent", "provider", "host", "provider_key_id", "provider_key_name", "provider_account",
    "caller_key_id", "caller_key_name", "session_provider", "session_account", "session_official_login",
    "model", "requested_model", "served_model", "upstream",
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cache_write_1h_tokens",
    "reasoning_tokens", "effort",
    "tier_asked", "tier_sent", "tier_served", "status", "error", "tries", "duration_ms", "ttft_ms",
    "source", "kind", "rejected", "handed_on",
  ]);
});

test("⑥ toCsvRow 的列数与表头一致", () => {
  const header = csvHeader();
  const row = toCsvRow(makeRecord({ agent: "claude-code", provider: "openai", in: 10, out: 20, status: 200 }));
  const cells = splitCsv(row);
  assert.equal(cells.length, header.length, "列数必须与表头一致");
  assert.ok(!row.endsWith("\n"), "一行 CSV 不带换行符");
  assert.equal(cells[0], makeRecord({ t: cells[0] }).t, "第一列是时间");
  assert.equal(cells[header.indexOf("agent")], "claude-code");
  assert.equal(cells[header.indexOf("input_tokens")], "10");
  assert.equal(cells[header.indexOf("status")], "200");
});

test("⑥ toCsvRow 对含逗号/引号/换行的值做 CSV 转义", () => {
  const header = csvHeader();
  const row = toCsvRow(makeRecord({ agent: 'say "hi", now', provider: "a\nb" }));
  const cells = splitCsv(row);
  assert.equal(cells.length, header.length, "转义之后列数仍然要对得上");
  assert.equal(cells[header.indexOf("agent")], 'say "hi", now');
  assert.equal(cells[header.indexOf("provider")], "a\nb");
});

test("⑥ toCsvRow 对缺字段的记录照样给齐列数", () => {
  const header = csvHeader();
  assert.equal(splitCsv(toCsvRow({ agent: "只有 agent" })).length, header.length);
});

/* ══════════════════════════════════════════════════════════════════
 * ⑦ 写失败不抛
 * ══════════════════════════════════════════════════════════════════ */

test("★ ⑦ 目录不存在时 appendRecord 返回 ok:false，不抛", (t) => {
  const dir = tmpDir(t);
  const missing = path.join(dir, "并不存在的目录");
  assertWriteFailureSwallowed(appendRecord, missing);
  assert.ok(!fs.existsSync(ledgerFile(missing)), "不许偷偷把目录建出来");
});

test("★ ⑦ 写失败绝不会抛异常（accounting must never break a call）", () => {
  for (const bad of [null, undefined, "", 123, {}]) {
    const r = appendRecord(bad, makeRecord({}));
    assert.equal(r.ok, false, `目录=${String(bad)} 时应当 ok:false`);
    assert.equal(typeof r.error, "string");
  }
});

test("⑦ 写失败之后，账本里的旧记录一条不少", (t) => {
  const dir = tmpDir(t);
  appendRecord(dir, makeRecord({ agent: "good" }));
  const r = appendRecord(path.join(dir, "坏路径"), makeRecord({ agent: "lost" }));
  assert.equal(r.ok, false);
  assert.deepEqual(loadRecords(dir, 0).map((x) => x.agent), ["good"], "一次写失败不该毁掉已有的账本");
});

/* ══════════════════════════════════════════════════════════════════
 * ⑧ DIMENSIONS
 * ══════════════════════════════════════════════════════════════════ */

test("⑧ DIMENSIONS 就是 magpie 那五个，顺序照抄", () => {
  assert.deepEqual(DIMENSIONS, ["provider", "agent", "model", "modelAt", "callerKey"]);
});

/* ══════════════════════════════════════════════════════════════════
 * ⑨ 反向对照：改坏源码，同一个判定体必须打红
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 把源码抄一份、打上补丁、动态 import 它，拿来跑判定体。
 * 源文件一个字节都不动。
 */
async function withMutant(from, to, fn) {
  const src = fs.readFileSync(MODULE_PATH, "utf8");
  const hits = src.split(from).length - 1;
  assert.equal(hits, 1, `手法失效：锚点在源码里命中 ${hits} 次（必须恰好 1 次）`);
  const mutated = src.replace(from, to);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-ledger-mutant-"));
  try {
    const file = path.join(dir, `mutant-${process.pid}-${Math.floor(Math.random() * 1e9)}.mjs`);
    fs.writeFileSync(file, mutated, "utf8");
    const mod = await import(pathToFileURL(file).href);
    return await fn(mod, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("★ ⑨ 反向对照 A：把「跳过坏行」改成整份作废 → 同一判定体必须打红", async () => {
  await withMutant(
    "      continue; // 坏行：跳过它，其余照读",
    "      throw new Error(\"坏行：整份账本作废\"); // 坏行：跳过它，其余照读",
    async (mod, dir) => {
      fs.writeFileSync(
        ledgerFile(dir),
        JSON.stringify(makeRecord({ agent: "before" })) + "\n" +
        "{ 这不是 JSON\n" +
        JSON.stringify(makeRecord({ agent: "after" })) + "\n",
      );
      /* 断言它挂的理由要**对**：是因为坏行不再被跳过而挂，不是因为别的什么坏了。
         否则「打红」也可能是个假的（比如模块根本没 import 成功）。 */
      assert.throws(
        () => assertSkipsBadLine(mod.loadRecords, dir),
        /整份账本作废/,
        "改坏了竟然还过 —— 这条反向对照是假的",
      );
    },
  );
});

test("★ ⑨ 反向对照 B：把「不替调用方建目录」改成建目录 → 同一判定体必须打红", async () => {
  await withMutant(
    '    const fd = fs.openSync(path.join(dir, LEDGER_FILE), "a");',
    '    fs.mkdirSync(dir, { recursive: true });\n    const fd = fs.openSync(path.join(dir, LEDGER_FILE), "a");',
    async (mod, dir) => {
      const missing = path.join(dir, "并不存在的目录");
      assert.throws(
        () => assertWriteFailureSwallowed(mod.appendRecord, missing),
        /必须是 ok:false/,
        "改坏了竟然还过 —— 这条反向对照是假的",
      );
    },
  );
});

test("★ ⑨ 反向对照 C：把 tier_served 从 tier_asked 猜出来 → 同一判定体必须打红", async () => {
  await withMutant(
    "  /* ★ tier_served 只从回复取，不从请求猜：任何从 tier_asked/tier_sent 的回填都是错的\n" +
    "     （Go: usage.go 里 tier_served 的注释，#1784）。这里刻意不做任何回填。 */\n" +
    "  return rec;",
    "  rec.tier_served = rec.tier_sent || rec.tier_asked;\n" +
    "  return rec;",
    async (mod) => {
      assert.throws(
        () => assertThreeTiersIndependent(mod.makeRecord),
        /tier_served 只从回复取/,
        "改坏了竟然还过 —— 这条反向对照是假的",
      );
    },
  );
});

/* ── 手法表（给人看的）：node scripts/usage-ledger-test.mjs --sabotage ── */
const SABOTAGE = [
  {
    name: "坏行改成整份作废",
    from: "      continue; // 坏行：跳过它，其余照读",
    to: "      throw new Error(\"坏行：整份账本作废\"); // 坏行：跳过它，其余照读",
    where: "loadRecords 不再跳过坏行",
    reds: "★ ④ 中间一行坏了 → 跳过那一行，其余照读",
  },
  {
    name: "偷偷建目录",
    from: '    const fd = fs.openSync(path.join(dir, LEDGER_FILE), "a");',
    to: '    fs.mkdirSync(dir, { recursive: true });\n    const fd = fs.openSync(path.join(dir, LEDGER_FILE), "a");',
    where: "appendRecord 替调用方建目录",
    reds: "★ ⑦ 目录不存在时 appendRecord 返回 ok:false，不抛",
  },
  {
    name: "tier_served 从请求猜",
    from: "  /* ★ tier_served 只从回复取，不从请求猜：任何从 tier_asked/tier_sent 的回填都是错的\n" +
      "     （Go: usage.go 里 tier_served 的注释，#1784）。这里刻意不做任何回填。 */\n" +
      "  return rec;",
    to: "  rec.tier_served = rec.tier_sent || rec.tier_asked;\n  return rec;",
    where: "makeRecord 从 tier_asked/tier_sent 回填 tier_served",
    reds: "★ ② tier 三段：served 只从回复取",
  },
];
if (process.argv.includes("--sabotage")) {
  console.log(`usage-ledger 反向对照手法（${SABOTAGE.length} 条）：`);
  for (const s of SABOTAGE) {
    console.log(`  ${s.name.padEnd(22)} ${s.where}`);
    console.log(`  ${"".padEnd(22)} → 会打红: ${s.reds}`);
  }
  process.exit(0);
}
