/* 审计台账（src/server/audit.mjs）的口径测试。
 *
 * 台账是**事后**用的：用户报「昨天 Claude 卡了」，得能翻出那段时间每条请求
 * 去了哪、哪一家在拖后腿、失败都被归成了什么。所以它有四条硬要求：
 *
 *   ① **一条对外交互一条记** —— 谁、什么时候、哪个渠道、哪个模型、什么结果、
 *      耗时多少、失败归成哪一类，一个都不能少；
 *   ② **凭据绝不进台账** —— 上游的错误正文常把请求里的东西原样回显，
 *      而台账要落盘、要在面板上给人看；
 *   ③ **内存里的条数有上界** —— 台账是常驻进程里的，长跑不能把它吃光；
 *   ④ **查得到** —— 按渠道筛、按时间筛、拿最近的 n 条、汇总统计。
 *
 * ⚠ 夹具里的凭据**一律是现造的假货**（明写着 test / fake / 0000…）。
 * ⚠ 时间一律由 opts.now 注入 —— 本文件不取 Date.now()，断言才能逐字对。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAudit, classifyAuditOutcome, AUDIT_KINDS } from "../src/server/audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT_SRC = path.join(ROOT, "src/server/audit.mjs");
const REDACT_SRC = path.join(ROOT, "src/server/redact.mjs");

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

/* ── 假凭据：一律现造 ─────────────────────────────────────────────── */
const FAKE_SK = "sk-test-0000000000000000000000000000";
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiIsImtpZCI6ImZha2UifQ." +
  "eyJzdWIiOiJmYWtlLWFjY291bnQtMDAwMSIsImV4cCI6OTk5OTk5OTk5OX0." +
  "ZmFrZS1zaWduYXR1cmUtdmFsdWUtaW5pLXBsYWNlaG9sZC1ub3Qtc2VjcmV0";

/** 一个时刻可控的台账。 */
function ledgerAt(opts = {}) {
  let t = opts.start ?? NOW;
  return createAudit({ now: () => (t += opts.step ?? 1000), ...opts });
}

/* ====================================================================== *
 * ① 一条记录：字段齐全、时刻由参数注入
 * ====================================================================== */
describe("① 一条记录该有什么", () => {
  test("①a 字段一个不缺、一个不少", () => {
    const a = createAudit({ now: NOW });
    const rec = a.record({
      agent: "claude-code",
      session: "sess-0001",
      provider: "bai",
      model: "claude-opus-4-5",
      status: 200,
      ms: 1234,
    });
    assert.deepEqual(
      Object.keys(rec).sort(),
      ["agent", "error", "handedOn", "kind", "model", "ms", "outcome", "provider", "session", "status", "t", "ts"].sort(),
    );
    for (const [k, v] of Object.entries(rec)) {
      assert.notEqual(v, undefined, `字段 ${k} 是 undefined —— JSON.stringify 会把它整个丢掉`);
    }
    assert.equal(rec.agent, "claude-code");
    assert.equal(rec.provider, "bai");
    assert.equal(rec.model, "claude-opus-4-5");
    assert.equal(rec.status, 200);
    assert.equal(rec.ms, 1234);
    assert.equal(rec.outcome, "ok");
    assert.equal(rec.kind, "ok");
    assert.equal(rec.handedOn, false);
  });

  test("①b 时刻由 opts.now 注入（不许偷用 Date.now）", () => {
    const a = createAudit({ now: NOW });
    const rec = a.record({ provider: "bai" });
    assert.equal(rec.ts, NOW);
    assert.equal(rec.t, "2023-11-14T22:13:20.000Z");
  });

  test("①c 不给 now 时是「不知道」，不是 1970", () => {
    const a = createAudit();
    const rec = a.record({ provider: "bai" });
    assert.equal(rec.ts, 0, "把「不知道」写成了某个时刻");
    assert.equal(rec.t, "", "1970 那一天不是「不知道」");
  });

  test("①d 缺字段时补缺省值，不留 undefined", () => {
    const a = createAudit({ now: NOW });
    const rec = a.record({});
    assert.equal(rec.agent, "");
    assert.equal(rec.session, "");
    assert.equal(rec.provider, "");
    assert.equal(rec.model, "");
    assert.equal(rec.status, 0);
    assert.equal(rec.ms, 0);
    assert.equal(rec.error, "");
    assert.equal(rec.handedOn, false);
  });
});

/* ====================================================================== *
 * ② 凭据绝不进台账
 * ====================================================================== */
describe("② 台账里绝不能出现凭据", () => {
  test("②a 错误正文里的 key 必须被抹掉", () => {
    const a = createAudit({ now: NOW });
    a.record({ provider: "bai", status: 401, error: `上游说 key=${FAKE_SK} 无效` });
    const dump = JSON.stringify(a.list());
    assert.ok(!dump.includes(FAKE_SK), `台账里留着凭据：${dump}`);
    assert.ok(dump.includes("key="), "连字段名都抹了 —— 这条记录没法读了");
  });

  test("②b JWT 也不许留在台账里", () => {
    const a = createAudit({ now: NOW });
    a.record({ provider: "wb", status: 401, error: `token ${FAKE_JWT} 过期` });
    const dump = JSON.stringify(a.list());
    assert.ok(!dump.includes(FAKE_JWT), "台账里留着 JWT");
  });

  test("②c 面板那条硬规则：台账里不得出现形似 JWT 的长串", () => {
    /* 面板状态接口的响应里不许出现任何形似 JWT 的长串。
     * 台账将来要接到面板上，所以它自己就得先满足这条。 */
    const a = createAudit({ now: NOW });
    a.record({ provider: "wb", status: 401, error: FAKE_JWT });
    const dump = JSON.stringify(a.list());
    assert.ok(
      !/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/.test(dump),
      `台账里出现了形似 JWT 的长串：${dump}`,
    );
  });

  test("②d 调用方多传的字段一律丢掉（不许夹带凭据进来）", () => {
    const a = createAudit({ now: NOW });
    const rec = a.record({ provider: "bai", rawHeaders: { authorization: FAKE_SK } });
    assert.equal(rec.rawHeaders, undefined, "多传的字段被收下了 —— 一个 rawHeaders 就能把凭据带进台账");
    assert.ok(!JSON.stringify(a.list()).includes(FAKE_SK));
  });

  test("②e session / agent 字段同样过闸门", () => {
    const a = createAudit({ now: NOW });
    a.record({ provider: "bai", session: FAKE_SK, agent: "claude-code" });
    assert.ok(!JSON.stringify(a.list()).includes(FAKE_SK), "session 字段没过闸门");
    assert.equal(a.list()[0].agent, "claude-code", "agent 字段被抹了 —— 「谁发的」这条没了");
  });

  test("②f 模型名不许被抹（抹了就没法按模型查账）", () => {
    const a = createAudit({ now: NOW });
    const rec = a.record({ provider: "bai", model: "anthropic/claude-opus-4-1-20250805" });
    assert.equal(rec.model, "anthropic/claude-opus-4-1-20250805", "模型名被抹了 —— 台账没法按模型查");
  });

  test("②g 错误正文有长度上限（台账不是日志归档）", () => {
    const a = createAudit({ now: NOW });
    const rec = a.record({ provider: "bai", error: "x".repeat(5000) });
    assert.ok(rec.error.length <= 300, `错误正文没截断：${rec.error.length}`);
  });
});

/* ====================================================================== *
 * ③ 上界：内存里的条数有硬上限
 * ====================================================================== */
describe("③ 上界 —— 内存不能被吃光", () => {
  test("③a 写超上限后只留最新的那些", () => {
    const a = createAudit({ max: 5, now: NOW });
    for (let i = 0; i < 20; i++) a.record({ provider: `p${i}` });
    assert.equal(a.size, 5, "条数没封顶 —— 长跑会把内存吃光");
    const names = a.list().map((r) => r.provider);
    assert.ok(!names.includes("p0"), "最老的还在");
    assert.ok(names.includes("p19"), "最新的没了");
    assert.ok(names.includes("p15"), "最新的几条不在");
  });

  test("③b 默认上限也是有限的", () => {
    const a = createAudit();
    assert.ok(a.max > 0 && a.max <= 100000, `默认上限不对劲：${a.max}`);
    assert.equal(a.size, 0);
  });

  test("③c clear 之后归零", () => {
    const a = createAudit({ max: 5, now: NOW });
    a.record({ provider: "bai" });
    a.clear();
    assert.equal(a.size, 0);
    assert.deepEqual(a.list(), []);
  });
});

/* ====================================================================== *
 * ④ 查得到
 * ====================================================================== */
describe("④ 查询", () => {
  function seeded() {
    const a = ledgerAt({ start: NOW });
    a.record({ agent: "claude-code", session: "s1", provider: "bai", model: "m1", status: 200, ms: 100 });
    a.record({ agent: "claude-code", session: "s2", provider: "sn", model: "m2", status: 500, ms: 200 });
    a.record({ agent: "claude-desktop", session: "s3", provider: "wb", model: "m3", status: 429, ms: 300 });
    a.record({ agent: "claude-desktop", session: "s4", provider: "bai", model: "m4", status: 200, ms: 400 });
    return a;
  }

  test("④a 按渠道筛", () => {
    const a = seeded();
    const bai = a.list({ provider: "bai" });
    assert.equal(bai.length, 2);
    assert.ok(bai.every((r) => r.provider === "bai"));
    assert.deepEqual(a.list({ provider: "nope" }), []);
  });

  test("④b 按时间筛（含端点）", () => {
    const a = seeded();
    const times = a.list().map((r) => r.ts);
    const from = times[2];
    const to = times[1];
    const got = a.list({ since: from, until: to });
    assert.deepEqual(
      got.map((r) => r.ts).sort((x, y) => x - y),
      [from, to],
      "时间边界不对（含端点）",
    );
  });

  test("④c 最近的 n 条，最新的在前", () => {
    const a = seeded();
    const r = a.recent(2);
    assert.equal(r.length, 2);
    assert.ok(r[0].ts > r[1].ts, "不是最新的在前");
    assert.equal(r[0].provider, "bai");
  });

  test("④d limit 生效", () => {
    const a = seeded();
    assert.equal(a.list({ limit: 3 }).length, 3);
    assert.equal(a.list({ limit: 99 }).length, 4);
  });

  test("④e 按 agent / outcome / kind 筛", () => {
    const a = seeded();
    assert.equal(a.list({ agent: "claude-code" }).length, 2);
    assert.equal(a.list({ outcome: "error" }).length, 2);
    assert.equal(a.list({ kind: "rate" }).length, 1);
  });

  test("④f 时刻未知的记录，在给了时间边界时不作数", () => {
    const a = createAudit({ now: 0 });
    a.record({ provider: "bai" });
    assert.equal(a.list().length, 1, "不限时间时它该在");
    assert.equal(a.list({ since: NOW }).length, 0, "拿一个不知道时刻的记录去回答「这十分钟里发生了什么」是骗人");
  });
});

/* ====================================================================== *
 * ⑤ 汇总
 * ====================================================================== */
describe("⑤ 汇总统计", () => {
  test("⑤a 总数 / 成败 / 转交", () => {
    const a = ledgerAt({ start: NOW });
    a.record({ provider: "bai", status: 200, ms: 100 });
    a.record({ provider: "sn", status: 500, ms: 200 });
    a.record({ provider: "sn", status: 429, ms: 300, handedOn: true });
    const s = a.summary();
    assert.equal(s.total, 3);
    assert.equal(s.ok, 1);
    assert.equal(s.failed, 2);
    assert.equal(s.handedOn, 1);
  });

  test("⑤b 按渠道分组", () => {
    const a = ledgerAt({ start: NOW });
    a.record({ provider: "bai", status: 200, ms: 100 });
    a.record({ provider: "bai", status: 200, ms: 300 });
    a.record({ provider: "sn", status: 500, ms: 500 });
    const s = a.summary();
    assert.equal(s.byProvider.length, 2);
    const bai = s.byProvider.find((x) => x.name === "bai");
    assert.equal(bai.total, 2);
    assert.equal(bai.ok, 2);
    assert.equal(bai.avgMs, 200);
    const sn = s.byProvider.find((x) => x.name === "sn");
    assert.equal(sn.failed, 1);
    assert.equal(sn.avgMs, 500);
  });

  test("⑤c 按失败类别分组", () => {
    const a = ledgerAt({ start: NOW });
    a.record({ provider: "sn", status: 401 });
    a.record({ provider: "sn", status: 401 });
    a.record({ provider: "sn", status: 429 });
    const s = a.summary();
    const auth = s.byKind.find((x) => x.name === "auth");
    assert.equal(auth.total, 2);
    assert.equal(s.byKind.find((x) => x.name === "rate").total, 1);
  });

  test("⑤d 耗时统计", () => {
    const a = ledgerAt({ start: NOW });
    for (const ms of [100, 200, 300, 400, 5000]) a.record({ provider: "bai", status: 200, ms });
    const s = a.summary();
    assert.equal(s.maxMs, 5000);
    assert.equal(s.minMs, 100);
    assert.equal(s.avgMs, 1200);
    assert.equal(s.p50Ms, 300);
    assert.equal(s.p95Ms, 5000);
  });

  test("⑤e 时间范围", () => {
    const a = ledgerAt({ start: NOW });
    a.record({ provider: "bai" });
    a.record({ provider: "bai" });
    const s = a.summary();
    assert.ok(s.since < s.until, "since/until 反了");
    assert.equal(s.until - s.since, 1000);
  });
});

/* ====================================================================== *
 * ⑥ 失败归类
 * ====================================================================== */
describe("⑥ 失败归类", () => {
  test("⑥a 状态码口径", () => {
    assert.equal(classifyAuditOutcome({ status: 401 }), "auth");
    assert.equal(classifyAuditOutcome({ status: 403 }), "auth");
    assert.equal(classifyAuditOutcome({ status: 402 }), "credit");
    assert.equal(classifyAuditOutcome({ status: 429 }), "rate");
    assert.equal(classifyAuditOutcome({ status: 500 }), "other");
    assert.equal(classifyAuditOutcome({ status: 502 }), "other");
    assert.equal(classifyAuditOutcome({ status: 200 }), "ok");
  });

  test("⑥b 429 里带额度字样的是 quota，不是 rate", () => {
    assert.equal(classifyAuditOutcome({ status: 429, error: "insufficient_quota" }), "quota");
    assert.equal(classifyAuditOutcome({ status: 429, error: "余额不足" }), "quota");
    assert.equal(classifyAuditOutcome({ status: 429, error: "too many requests" }), "rate");
  });

  test("⑥c 4xx 里明说「不服务这个模型」的是 unserved", () => {
    assert.equal(classifyAuditOutcome({ status: 404, error: "model_not_found" }), "unserved");
    assert.equal(classifyAuditOutcome({ status: 400, error: "the model gpt-9 does not exist" }), "unserved");
    assert.equal(classifyAuditOutcome({ status: 400, error: "missing required field: messages" }), "content");
  });

  test("⑥d 归类名是仓库那一套（跟冷却表用同一个词）", () => {
    assert.deepEqual([...AUDIT_KINDS].sort(), ["auth", "content", "credit", "ok", "other", "quota", "rate", "unserved"]);
  });

  test("⑥e 调用方给了 kind 就用调用方的（权威口径是 candidates.mjs）", () => {
    const a = createAudit({ now: NOW });
    const rec = a.record({ provider: "sn", status: 429, kind: "quota", error: "配额用尽" });
    assert.equal(rec.kind, "quota");
  });
});

/* ====================================================================== *
 * ⑦ sink：落盘是接线层的事，但不许把调用方带崩
 * ====================================================================== */
describe("⑦ sink", () => {
  test("⑦a sink 拿得到记好的那条", () => {
    const seen = [];
    const a = createAudit({ now: NOW, sink: (rec) => seen.push(rec) });
    a.record({ provider: "bai", status: 200 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].provider, "bai");
  });

  test("⑦b sink 抛异常不许把调用方带崩", () => {
    const a = createAudit({
      now: NOW,
      sink: () => {
        throw new Error("磁盘满了");
      },
    });
    assert.doesNotThrow(() => a.record({ provider: "bai" }));
    assert.equal(a.size, 1, "记录本身还是该在");
  });
});

/* ====================================================================== *
 * ⑧ 反向对照：把实现改坏，对应断言必须真的会红
 * ====================================================================== */

/** 把 audit.mjs 改坏（连 redact.mjs 一起复制过去，它 import 得到）。 */
async function loadMutated(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bai-audit-mut-"));
  const src = fs.readFileSync(AUDIT_SRC, "utf8");
  const out = mutate(src);
  assert.notEqual(out, src, "变异没有生效 —— 反向对照就是空转");
  fs.writeFileSync(path.join(dir, "redact.mjs"), fs.readFileSync(REDACT_SRC, "utf8"), "utf8");
  fs.writeFileSync(path.join(dir, "audit.mjs"), out, "utf8");
  return import(pathToFileURL(path.join(dir, "audit.mjs")).href);
}

async function reverseControl(mutate, check, label) {
  const mutated = await loadMutated(mutate);
  let threw = false;
  try {
    check(mutated);
  } catch {
    threw = true;
  }
  assert.ok(threw, `${label}：把实现改坏之后断言居然还是绿的 —— 这条反向对照是空转的`);
}

describe("⑧ 反向对照 —— 改坏实现，对应断言必须红", () => {
  test("⑧a 把错误正文的脱敏去掉，②a 必须红", async () => {
    await reverseControl(
      (src) =>
        src.replace(
          "error: cut(redact(asText(src.error)), MAX_TEXT),",
          "error: cut(asText(src.error), MAX_TEXT),",
        ),
      (m) => {
        const a = m.createAudit({ now: NOW });
        a.record({ provider: "bai", status: 401, error: `上游说 key=${FAKE_SK} 无效` });
        assert.ok(
          !JSON.stringify(a.list()).includes(FAKE_SK),
          "错误正文没过脱敏闸门 —— 台账里留着凭据",
        );
      },
      "错误正文的脱敏",
    );
  });

  test("⑧b 把上界去掉，③a 必须红", async () => {
    await reverseControl(
      (src) =>
        src.replace(
          "if (records.length > max) records.splice(0, records.length - max);",
          "if (false) records.splice(0, records.length - max);",
        ),
      (m) => {
        const a = m.createAudit({ max: 5, now: NOW });
        for (let i = 0; i < 20; i++) a.record({ provider: `p${i}` });
        assert.equal(a.size, 5, "上界没了 —— 长跑会把内存吃光");
      },
      "内存上界",
    );
  });

  test("⑧c 把时刻改成偷用 Date.now()，①b 必须红", async () => {
    await reverseControl(
      (src) => src.replace("const v = asNum(nowFn());", "const v = Date.now();"),
      (m) => {
        const a = m.createAudit({ now: NOW });
        const rec = a.record({ provider: "bai" });
        assert.equal(rec.ts, NOW, "时刻不是从 opts.now 来的 —— 测不了「那一刻」");
      },
      "时刻来源",
    );
  });

  test("⑧d 把 401 的归类改掉，⑥a 必须红", async () => {
    await reverseControl(
      (src) =>
        src.replace(
          'if (status === 401 || status === 403) return "auth";',
          'if (status === 401 || status === 403) return "other";',
        ),
      (m) => {
        assert.equal(m.classifyAuditOutcome({ status: 401 }), "auth", "401 不该归成 auth");
      },
      "401 的归类",
    );
  });

  test("⑧e 把「多传的字段一律丢掉」改成照收，②d 必须红", async () => {
    /* 这一条守的是「字段封闭」这条防线：不然调用方随手塞一个 rawHeaders，
     * 凭据就跟着进了台账。
     * 变异要改两处 —— 白名单（FIELDS）与取值（values）—— 少改一处，
     * 字段照样进不来，这条反向对照就成空转了。 */
    await reverseControl(
      (src) =>
        src
          .replace(
            '["handedOn", "bool"],',
            '["handedOn", "bool"],\n  ["rawHeaders", "string"],',
          )
          .replace(
            "handedOn: Boolean(src.handedOn),",
            "handedOn: Boolean(src.handedOn),\n    rawHeaders: src.rawHeaders,",
          ),
      (m) => {
        const a = m.createAudit({ now: NOW });
        const rec = a.record({ provider: "bai", rawHeaders: { authorization: FAKE_SK } });
        assert.equal(rec.rawHeaders, undefined, "多传的字段被收下了 —— 一个 rawHeaders 就能把凭据带进台账");
      },
      "字段封闭",
    );
  });
});
