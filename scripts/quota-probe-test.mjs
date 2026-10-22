/* 供应商配额「真探测」（src/server/quota-probe.mjs）的口径测试。
 *
 * 这一层是「对标 magpie 复刻」的 T9 另一半：quota.mjs 是**被动信号**（拿账本里
 * 已记的数去对照用户自设的预算），本模块是**真探测**（拿登录态去问供应商
 * 「你还剩多少」）。
 *
 * 测的是四条不可让步的性质：
 *   ① **探不到就说探不到**：known:false + 人话原因；**绝不**把「探不到」写成
 *      「额度是 0」（那会让用户以为账号被封了）。反过来，上游**真的**报 0 时
 *      必须是 known:true / used:0 —— 两件事必须能分开。
 *   ② **绝不猜**：候选端点回 200 不算数，只有真的读到了那个字段才算数；
 *      字段名猜错 ⇒ unknown。余额型来源（只有「还剩多少」、没有上限）不算数。
 *   ③ **只读**：探测只发 GET/HEAD，白名单是**硬闸**（在发请求之前查）——
 *      配置里写成 POST 也不能发出去。
 *   ④ **来源要分清**：探到的数是上游说的，退回账本估的数是另一回事，
 *      面板必须能一眼分清（origin / originLabel）。
 *
 * 另外：候选表必须是**数据**（配置里能改）、模块必须**零依赖零时钟**（不 import
 * 本仓任何别的模块、内部不取时刻）、raw 必须**已脱敏**。
 *
 * 时间一律由参数注入（opts.now），本文件不取 Date.now()。
 * 网络一律由 opts.get 注入**假的**应答 —— 本文件绝不发真请求、绝不用真令牌。
 *
 * 最后一节是**反向对照**：把实现改坏（复制到临时目录改一改再 import 进来），
 * 证明前面那些断言**真的会红** —— 不会红的断言等于没写。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  probeQuota,
  resolveQuota,
  redactAnswer,
  PROBE_SPECS,
  READ_ONLY_METHODS,
  UNIT_CREDITS,
  UNIT_MONEY,
  UNIT_REQUESTS,
  UNIT_UNKNOWN,
  ORIGIN_UPSTREAM,
  ORIGIN_LEDGER,
  ORIGIN_NONE,
  ORIGIN_LABELS,
} from "../src/server/quota-probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "server", "quota-probe.mjs");

const NOW = 1_700_000_000_000;

/* ── 假凭据与假应答 ────────────────────────────────────────────────────────
 * 一律用明显是假的值：真令牌绝不许进这个文件（它会被提交进仓库）。 */
const FAKE_KEY = "sk-fake-000000-not-a-real-key";
const FAKE_HEADERS = { authorization: `Bearer ${FAKE_KEY}` };

/** 假的 IO：按 URL 后缀派应答，记下每一次请求（用来断言「一个请求都不该发」）。 */
function fakeGet(routes) {
  const calls = [];
  const get = async (req) => {
    calls.push(req);
    for (const r of routes) {
      if (typeof r.match === "string" ? req.url.endsWith(r.match) : r.match(req)) {
        return typeof r.reply === "function" ? r.reply(req) : r.reply;
      }
    }
    return { status: 404, text: JSON.stringify({ error: "no such endpoint" }) };
  };
  get.calls = calls;
  return get;
}

const json = (obj, status = 200) => ({ status, text: JSON.stringify(obj) });

/**
 * 去掉注释，只留代码。
 *
 * ⚠ 为什么要这一步：头注释里就写着「不许调 Date.now()」这句话本身 —— 不去掉注释
 *   就查，等于让注释把自己告了。行注释的 "//" 要避开 "://"（URL 里的），
 *   否则会把一整行代码连同后面的真调用一起吃掉。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/* ====================================================================== *
 * ① 契约与形状
 * ====================================================================== */
describe("① 契约 —— 归一化后的探测结果", () => {
  test("①a OpenRouter 的 /api/v1/credits：已用与上限都读得到", async () => {
    const get = fakeGet([{
      match: "/credits",
      reply: json({ data: { total_credits: 20, total_usage: 3.5 } }),
    }]);
    const r = await probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, true, "这是有出处的端点（magpie balance.go:65 + 官方文档），必须探得到");
    assert.equal(r.provider, "or");
    assert.equal(r.used, 3.5);
    assert.equal(r.limit, 20);
    assert.equal(r.unit, UNIT_MONEY);
    assert.equal(r.resetAtMs, null, "这个接口不报重置时刻 —— 没有就是 null（不是 0）");
    assert.equal(r.error, null);
    assert.match(r.source, /\/api\/v1\/credits/, "source 必须写清是哪个接口");
    assert.match(r.source, /total_credits/, "source 必须写清是哪个字段");
    assert.equal(r.raw.data.total_credits, 20);
  });

  test("①b OpenRouter 的 /api/v1/auth/key：免费模型当日次数", async () => {
    const get = fakeGet([{
      match: "/auth/key",
      reply: json({
        is_free_tier: true,
        usage: 3.5,
        free_model_daily_requests: { used: 12, limit: 50, remaining: 38 },
      }),
    }]);
    const r = await probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, true);
    assert.equal(r.used, 12);
    assert.equal(r.limit, 50);
    assert.equal(r.unit, UNIT_REQUESTS);
    assert.match(r.source, /\/api\/v1\/auth\/key/);
  });

  test("①c /credits 被拒（403）时自动退到 /auth/key", async () => {
    const get = fakeGet([
      { match: "/credits", reply: { status: 403, text: JSON.stringify({ error: { message: "Only management keys can perform this operation" } }) } },
      {
        match: "/auth/key",
        reply: json({ free_model_daily_requests: { used: 1, limit: 50 } }),
      },
    ]);
    const r = await probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, true, "第一个端点被拒不该让整家探不到");
    assert.equal(r.used, 1);
    assert.match(r.source, /\/api\/v1\/auth\/key/, "结果的来源必须指到真正读到的那个接口");
    assert.equal(get.calls.length, 2, "两个端点都要试过");
  });

  test("①d 返回的字段不多不少（契约就是那九个）", async () => {
    const get = fakeGet([{ match: "/credits", reply: json({ data: { total_credits: 20, total_usage: 3.5 } }) }]);
    const r = await probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
    assert.deepEqual(
      Object.keys(r).sort(),
      ["error", "known", "limit", "provider", "raw", "resetAtMs", "source", "unit", "used"].sort(),
    );
  });
});

/* ====================================================================== *
 * ② 「探不到」与「0」是两件事
 * ====================================================================== */
describe("② 探不到 ≠ 额度是 0", () => {
  test("②a 两个端点都探不到 ⇒ known:false + 人话原因", async () => {
    const get = fakeGet([]);
    const r = await probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, false);
    assert.equal(r.unit, UNIT_UNKNOWN);
    assert.equal(typeof r.error, "string");
    assert.ok(r.error.length > 0, "探不到必须给一句人话原因，不能是空串");
    assert.match(r.error, /credits/, "原因里要说得清是哪个端点没成");
  });

  test("②b 探不到时绝不能返回 0（这是最贵的一条）", async () => {
    const get = fakeGet([]);
    const r = await probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, false);
    assert.equal(r.used, null, "「探不到」不是「额度是 0」—— 写成 0 会让用户以为账号被封了");
    assert.equal(r.limit, null);
    assert.notEqual(r.used, 0);
  });

  test("②c 上游真的报 0 ⇒ known:true / used:0（与 ②b 是两件事）", async () => {
    const get = fakeGet([{ match: "/credits", reply: json({ data: { total_credits: 0, total_usage: 0 } }) }]);
    const r = await probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, true, "上游说的 0 是事实，要与「探不到」分开");
    assert.equal(r.used, 0);
    assert.equal(r.limit, 0);
    assert.equal(r.error, null);
  });

  test("②d 字段名猜错 ⇒ unknown（端点回 200 不算数）", async () => {
    const get = fakeGet([{ match: "/credits", reply: json({ data: { foo: 1, bar: "x" } }) }]);
    const r = await probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, false, "字段不在就是没读到 —— 不许拿别的数顶替");
    assert.equal(r.used, null);
    assert.equal(r.limit, null);
    assert.match(r.error, /额度字段|没有/);
  });

  test("②e 只读到一个孤零零的 limit ⇒ 不算数（余额型来源不算）", async () => {
    // 只有「上限」没有「已用」：那多半是某个模型的 max context，不是额度。
    const get = fakeGet([{ match: "/credits", reply: json({ data: { limit: 200000 } }) }]);
    const r = await probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, false, "只有一个 limit 时算不出比例，宁可 unknown");
    assert.equal(r.limit, null);
  });

  test("②f 原因里带上上游自己说的那句话（用户下一步该做什么）", async () => {
    const get = fakeGet([{
      match: "/credits",
      reply: { status: 403, text: JSON.stringify({ error: { message: "Only management keys can perform this operation" } }) },
    }]);
    const r = await probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
    assert.match(r.error, /403/, "要说得清是哪个状态码");
    assert.match(r.error, /management keys/, "上游自己说的那句话要带出来");
  });

  test("②g 错误正文里回显的令牌不许漏出去", async () => {
    const get = fakeGet([{
      match: "/credits",
      reply: { status: 401, text: JSON.stringify({ error: { message: `bad key: Bearer ${FAKE_KEY}` } }) },
    }]);
    const r = await probeQuota("or", {
      now: NOW,
      get,
      headers: FAKE_HEADERS,
      secrets: [FAKE_KEY],
    });
    assert.equal(r.error.includes(FAKE_KEY), false, "错误正文会进台账，令牌不能在里面");
  });
});

/* ====================================================================== *
 * ③ 只读硬闸
 * ====================================================================== */
describe("③ 只读 —— 探测不许改状态、不许消耗额度", () => {
  test("③a 候选写成 POST ⇒ 一个请求都不发", async () => {
    const get = fakeGet([{ match: "/anything", reply: json({ data: { used: 1, limit: 2 } }) }]);
    const r = await probeQuota("or", {
      now: NOW,
      get,
      headers: FAKE_HEADERS,
      specs: {
        or: {
          candidates: [{
            id: "bad",
            url: "{base}/anything",
            method: "POST",
            source: "GET /anything",
            unit: UNIT_REQUESTS,
            used: [{ path: "data.used" }],
            limit: [{ path: "data.limit" }],
          }],
        },
      },
    });
    assert.equal(get.calls.length, 0, "白名单外的请求**根本不能发出去**（一次都不行）");
    assert.equal(r.known, false);
    assert.match(r.error, /只读|GET/i);
  });

  test("③b 非 http(s) 的地址被跳过", async () => {
    const get = fakeGet([]);
    const r = await probeQuota("or", {
      now: NOW,
      get,
      headers: FAKE_HEADERS,
      specs: {
        or: {
          candidates: [{
            id: "file",
            url: "file:///etc/passwd",
            source: "file 端点",
            unit: UNIT_REQUESTS,
            used: [{ path: "data.used" }],
            limit: [{ path: "data.limit" }],
          }],
        },
      },
    });
    assert.equal(get.calls.length, 0);
    assert.equal(r.known, false);
    assert.match(r.error, /http/);
  });

  test("③c 白名单本身只有 GET/HEAD", () => {
    assert.deepEqual([...READ_ONLY_METHODS].sort(), ["GET", "HEAD"]);
  });
});

/* ====================================================================== *
 * ④ 候选表是数据（配置里能改）
 * ====================================================================== */
describe("④ 候选表可配置", () => {
  test("④a 配置的端点与字段生效", async () => {
    const get = fakeGet([{ match: "/my/quota", reply: json({ q: { spent: 7, cap: 70 } }) }]);
    const r = await probeQuota("or", {
      now: NOW,
      get,
      headers: FAKE_HEADERS,
      specs: {
        or: {
          candidates: [{
            id: "custom",
            url: "{base}/my/quota",
            source: "GET /my/quota → q.spent / q.cap",
            unit: UNIT_CREDITS,
            used: [{ path: "q.spent" }],
            limit: [{ path: "q.cap" }],
          }],
        },
      },
    });
    assert.equal(r.known, true);
    assert.equal(r.used, 7);
    assert.equal(r.limit, 70);
    assert.match(r.source, /my\/quota/);
  });

  test("④b 配置里的基址优先（用户改过上游，探测必须跟着走）", async () => {
    const get = fakeGet([{ match: "/credits", reply: json({ data: { total_credits: 5, total_usage: 1 } }) }]);
    await probeQuota("or", {
      now: NOW,
      get,
      headers: FAKE_HEADERS,
      bases: { or: "https://mirror.example.com/api/v1" },
    });
    assert.equal(get.calls[0].url, "https://mirror.example.com/api/v1/credits");
  });

  test("④c 配置的候选**整块替换**默认表（不是追加）", async () => {
    const get = fakeGet([{ match: "/credits", reply: json({ data: { total_credits: 5, total_usage: 1 } }) }]);
    await probeQuota("or", {
      now: NOW,
      get,
      headers: FAKE_HEADERS,
      specs: {
        or: {
          candidates: [{
            id: "only",
            url: "{base}/credits",
            source: "GET /credits",
            unit: UNIT_MONEY,
            used: [{ path: "data.total_usage" }],
            limit: [{ path: "data.total_credits" }],
          }],
        },
      },
    });
    assert.equal(get.calls.length, 1, "默认表里的 /auth/key 不该再被请求（否则用户改不动）");
  });
});

/* ====================================================================== *
 * ⑤ 探不到的那些怎么表现
 * ====================================================================== */
describe("⑤ 没有出处的那些 —— 候选端点与「就是探不到」", () => {
  test("⑤a OpenCode Zen 免费档：没有额度接口 ⇒ unknown + 指向控制台", async () => {
    const get = fakeGet([]);
    const r = await probeQuota("zen", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, false);
    assert.equal(r.used, null);
    assert.equal(r.limit, null);
    assert.equal(get.calls.length, 0, "免费档根本没有那个接口，一个请求都不该白打");
    assert.match(r.error, /控制台/, "要告诉用户去哪儿看");
  });

  test("⑤b OpenCode Zen 的 Go 档：/zen/go/v1/usage 读得到百分比窗口", async () => {
    const get = fakeGet([{
      match: "/zen/go/v1/usage",
      reply: json({
        usage: {
          rolling: { percent: 37, resetsAt: "2026-10-25T14:12:03.000Z" },
          weekly: { percent: 12, resetsAt: "2026-10-28T00:00:00.000Z" },
          monthly: { percent: 5 },
        },
      }),
    }]);
    const r = await probeQuota("zen", {
      now: NOW,
      get,
      headers: FAKE_HEADERS,
      bases: { zen: "https://opencode.ai/zen/go/v1" },
    });
    assert.equal(r.known, true);
    assert.equal(r.used, 37, "取最紧的那条窗口");
    assert.equal(r.limit, 100, "上游只给百分比，100 是分母不是绝对额度");
    assert.equal(r.unit, UNIT_UNKNOWN, "百分比没有单位");
    assert.equal(r.resetAtMs, Date.parse("2026-10-25T14:12:03.000Z"));
    assert.match(r.source, /zen\/go\/v1\/usage/);
    assert.match(r.source, /percent/);
  });

  test("⑤c 没有登录态 ⇒ 一个请求都不发", async () => {
    const get = fakeGet([{ match: "/", reply: json({ data: { total_credits: 1, total_usage: 1 } }) }]);
    const r = await probeQuota("or", { now: NOW, get });
    assert.equal(get.calls.length, 0, "没登录就发探测，只会被算成一次失败请求");
    assert.equal(r.known, false);
    assert.match(r.error, /登录态/);
  });

  test("⑤d 候选端点探不到 ⇒ unknown（不许猜）", async () => {
    for (const p of ["mm", "qd", "wb", "wbai", "sn", "bai"]) {
      const get = fakeGet([]);
      const r = await probeQuota(p, { now: NOW, get, headers: FAKE_HEADERS });
      assert.equal(r.known, false, `${p} 探不到就该是 unknown`);
      assert.equal(r.used, null, `${p} 探不到时 used 必须是 null`);
      assert.equal(r.limit, null, `${p} 探不到时 limit 必须是 null`);
      assert.ok(r.error && r.error.length > 0, `${p} 必须给出原因`);
    }
  });

  test("⑤e 候选端点真探到了 ⇒ 算数（判据是「读到了字段」，不是「端点回 200」）", async () => {
    // MiniMax Coding Plan 的应答形状（magpie readMiniMaxPlan）：插进去看会不会被读出来。
    const get = fakeGet([{
      match: "/v1/token_plan/remains",
      reply: json({
        base_resp: { status_code: 0, status_msg: "ok" },
        model_remains: [{
          model_name: "MiniMax-M2.7",
          start_time: 1750000000,
          end_time: 1760000000,
          current_interval_remaining_percent: 80,
          current_interval_total_count: 100,
          current_interval_usage_count: 20,
        }],
      }),
    }]);
    const r = await probeQuota("mm", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, true);
    assert.equal(r.used, 20);
    assert.equal(r.limit, 100);
    assert.equal(r.resetAtMs, 1760000000 * 1000, "end_time 是 epoch 秒");
    assert.match(r.source, /token_plan/);
  });

  test("⑤f 默认候选表里，没出处的那些都标着「候选」", () => {
    for (const p of ["mm", "qd", "wb", "wbai", "sn", "bai"]) {
      const spec = PROBE_SPECS[p];
      assert.ok(spec && spec.candidates && spec.candidates.length, `${p} 应当有候选表`);
      for (const c of spec.candidates) {
        assert.match(String(c.source || ""), /候选/, `${p} 的候选端点必须在 source 里写明是候选`);
      }
    }
    // 有出处的两家：source 里必须有出处，不许含糊
    assert.match(PROBE_SPECS.or.candidates[0].source, /\/api\/v1\/credits/);
    assert.match(PROBE_SPECS.zen.candidates[0].source, /\/zen\/go\/v1\/usage/);
  });
});

/* ====================================================================== *
 * ⑥ 时间：零时钟
 * ====================================================================== */
describe("⑥ 时刻由参数注入", () => {
  test("⑥a epoch 秒 / ISO / 「几秒后」三种写法都归一成毫秒", async () => {
    const specs = {
      or: {
        candidates: [{
          id: "t",
          url: "{base}/t",
          source: "GET /t",
          unit: UNIT_REQUESTS,
          used: [{ path: "data.used" }],
          limit: [{ path: "data.limit" }],
          resetAt: [{ path: "data.reset", unit: "epoch_s" }],
        }],
      },
    };
    const get = fakeGet([{ match: "/t", reply: json({ data: { used: 1, limit: 2, reset: 1760000000 } }) }]);
    const r1 = await probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS, specs });
    assert.equal(r1.resetAtMs, 1760000000000);

    const get2 = fakeGet([{ match: "/t", reply: json({ data: { used: 1, limit: 2, reset: "2026-10-25T14:12:03.000Z" } }) }]);
    const r2 = await probeQuota("or", { now: NOW, get: get2, headers: FAKE_HEADERS, specs: { or: { candidates: [{ ...specs.or.candidates[0], resetAt: [{ path: "data.reset", unit: "iso" }] }] } } });
    assert.equal(r2.resetAtMs, Date.parse("2026-10-25T14:12:03.000Z"));

    const get3 = fakeGet([{ match: "/t", reply: json({ data: { used: 1, limit: 2, reset: 3600 } }) }]);
    const r3 = await probeQuota("or", { now: NOW, get: get3, headers: FAKE_HEADERS, specs: { or: { candidates: [{ ...specs.or.candidates[0], resetAt: [{ path: "data.reset", unit: "secs_from_now" }] }] } } });
    assert.equal(r3.resetAtMs, NOW + 3600 * 1000, "「几秒后」必须相对 opts.now 算，不是相对真实时间");
  });

  test("⑥b 缺 now ⇒ 抛错（模块自己不取时刻）", async () => {
    await assert.rejects(
      () => probeQuota("or", { get: fakeGet([]), headers: FAKE_HEADERS }),
      /now/,
    );
  });
});

/* ====================================================================== *
 * ⑦ 与被动预算并存
 * ====================================================================== */
describe("⑦ 真探测与被动预算并存，来源必须分清", () => {
  const probeKnown = {
    provider: "or", known: true, used: 3.5, limit: 20, resetAtMs: null,
    unit: UNIT_MONEY, source: "GET /api/v1/credits → …", raw: {}, error: null,
  };
  const probeUnknown = {
    provider: "sn", known: false, used: null, limit: null, resetAtMs: null,
    unit: UNIT_UNKNOWN, source: "", raw: null, error: "两个候选端点都返回 404",
  };
  const passive = {
    provider: "sn", known: true, used: 120000, limit: 200000, unit: "tokens",
    resetAtMs: NOW + 3600_000, window: "hourly",
  };

  test("⑦a 探到了 ⇒ 来源是「上游报的」", () => {
    const v = resolveQuota("or", probeKnown, passive);
    assert.equal(v.origin, ORIGIN_UPSTREAM);
    assert.equal(v.originLabel, "上游报的");
    assert.equal(v.used, 3.5);
    assert.equal(v.known, true);
  });

  test("⑦b 探不到 ⇒ 退回账本，来源是「按账本估的」", () => {
    const v = resolveQuota("sn", probeUnknown, passive);
    assert.equal(v.origin, ORIGIN_LEDGER);
    assert.equal(v.originLabel, "按账本估的");
    assert.equal(v.used, 120000, "退回的是账本那个窗口的用量");
    assert.equal(v.limit, 200000);
    assert.equal(v.resetAtMs, NOW + 3600_000);
    assert.match(v.error, /上游探不到/, "要写明这是回退来的");
    assert.match(v.originLabel, /估/, "「估」字不能少 —— 用户要知道这个数有多可信");
  });

  test("⑦c 两边都没有 ⇒ unknown，**不是** 0", () => {
    const v = resolveQuota("sn", probeUnknown, null);
    assert.equal(v.known, false);
    assert.equal(v.used, null);
    assert.equal(v.limit, null);
    assert.equal(v.origin, ORIGIN_NONE);
    assert.equal(v.originLabel, "探不到");
  });

  test("⑦d 回退时口径不串（上限与重置时刻都取账本那一路）", () => {
    const v = resolveQuota("sn", probeUnknown, passive);
    assert.notEqual(v.limit, probeUnknown.limit, "不能用上游那路的 null 覆盖账本的数");
    assert.equal(v.limit, passive.limit);
  });
});

/* ====================================================================== *
 * ⑧ 反向对照：把实现改坏，证明前面的断言真的会红
 * ====================================================================== */

/**
 * 复制一份源码到临时目录、按锚点改坏，再 import 进来。
 *
 * ⚠ 锚点必须真的在源码里（改不到就当场炸）—— 否则「改坏」这一步悄悄没生效，
 *   后面的「断言会红」就成了自欺欺人。
 */
async function mutant(replacements) {
  const src = readFileSync(SRC, "utf8");
  let out = src;
  for (const [from, to] of replacements) {
    assert.ok(out.includes(from), `改坏用的锚点不在源码里：${JSON.stringify(from)}`);
    out = out.replace(from, to);
  }
  const dir = mkdtempSync(path.join(tmpdir(), "quota-probe-mutant-"));
  const file = path.join(dir, "quota-probe.mjs");
  writeFileSync(file, out, "utf8");
  return import(pathToFileURL(file).href);
}

/** 断言「改坏之后这条检查会红」。 */
async function mustGoRed(mod, check, why) {  let threw = false;
  try {
    await check(mod);
  } catch {
    threw = true;
  }
  assert.equal(threw, true, `改坏之后这条断言竟然还过：${why}`);
}

describe("⑧ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  test("⑧a 把「探不到」写成「额度是 0」⇒ ②b 会红", async () => {
    const mod = await mutant([
      [
        "return { ...base, error: scrubSecrets(reason, secrets) };",
        "return { ...base, known: true, used: 0, limit: 0, error: scrubSecrets(reason, secrets) };",
      ],
    ]);
    await mustGoRed(mod, async (m) => {
      const get = fakeGet([]);
      const r = await m.probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
      assert.equal(r.known, false);
      assert.equal(r.used, null, "「探不到」不是「额度是 0」");
    }, "探不到被写成 0 之后，②b 竟然还过");
  });

  test("⑧b 把只读闸拆掉 ⇒ ③a 会红", async () => {
    const mod = await mutant([
      ["if (!READ_ONLY_METHODS.includes(method)) {", "if (false) {"],
    ]);
    await mustGoRed(mod, async (m) => {
      const get = fakeGet([{ match: "/anything", reply: json({ data: { used: 1, limit: 2 } }) }]);
      await m.probeQuota("or", {
        now: NOW,
        get,
        headers: FAKE_HEADERS,
        specs: {
          or: {
            candidates: [{
              id: "bad", url: "{base}/anything", method: "POST", source: "POST /anything",
              unit: UNIT_REQUESTS, used: [{ path: "data.used" }], limit: [{ path: "data.limit" }],
            }],
          },
        },
      });
      assert.equal(get.calls.length, 0, "白名单外的请求根本不能发出去");
    }, "只读闸被拆掉之后，③a 竟然还过");
  });

  test("⑧c 把脱敏拆掉 ⇒ raw 里不该有令牌那条会红", async () => {
    const mod = await mutant([
      ['out[k] = SECRET_KEYS.has(normKey(k)) ? "[已脱敏]" : walk(v[k]);', "out[k] = walk(v[k]);"],
    ]);
    await mustGoRed(mod, async (m) => {
      const get = fakeGet([{
        match: "/credits",
        reply: json({ data: { total_credits: 20, total_usage: 3.5 }, authorization: `Bearer ${FAKE_KEY}` }),
      }]);
      const r = await m.probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
      assert.ok(r.raw, "raw 应当留着");
      assert.equal(r.raw.authorization, "[已脱敏]");
      assert.ok(!JSON.stringify(r.raw).includes(FAKE_KEY), "raw 里不许有令牌");
    }, "脱敏被拆掉之后，raw 那条竟然还过");
  });

  test("⑧d 把「字段读不到」当成 0 ⇒ ②d 会红", async () => {
    const mod = await mutant([
      ["let used = usedR.value;", "let used = usedR.value === null ? 0 : usedR.value;"],
      ["let limit = limitR.value;", "let limit = limitR.value === null ? 0 : limitR.value;"],
    ]);
    await mustGoRed(mod, async (m) => {
      const get = fakeGet([{ match: "/credits", reply: json({ data: { foo: 1 } }) }]);
      const r = await m.probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
      assert.equal(r.known, false, "字段名猜错必须是不算数");
      assert.equal(r.used, null);
    }, "读不到字段被当成 0 之后，②d 竟然还过");
  });

  test("⑧e 把来源改成永远说「上游报的」⇒ ⑦b 会红", async () => {
    const mod = await mutant([
      ["origin: ORIGIN_LEDGER,", "origin: ORIGIN_UPSTREAM,"],
    ]);
    await mustGoRed(mod, async (m) => {
      const v = m.resolveQuota(
        "sn",
        { provider: "sn", known: false, used: null, limit: null, resetAtMs: null, unit: UNIT_UNKNOWN, source: "", raw: null, error: "404" },
        { provider: "sn", known: true, used: 120000, limit: 200000, unit: "tokens", resetAtMs: NOW + 3600_000 },
      );
      assert.equal(v.origin, ORIGIN_LEDGER, "回退到账本时来源必须标成「按账本估的」");
      assert.equal(v.originLabel, "按账本估的");
    }, "来源被改坏之后，⑦b 竟然还过");
  });

  test("⑧f 把「读到了字段」判据拆掉（回 200 就算数）⇒ ②d 会红", async () => {
    // 另一种改坏：让 evalWindow 不再要求「已用」存在（只回 200 的空应答也算数）。
    const mod = await mutant([
      ["if (used === null) return null;", "if (used === null) used = 0;"],
      ["if (limit === null && !percent) return null;", "if (limit === null && !percent) limit = 0;"],
    ]);
    await mustGoRed(mod, async (m) => {
      const get = fakeGet([{ match: "/credits", reply: json({ data: { foo: 1 } }) }]);
      const r = await m.probeQuota("or", { now: NOW, get, headers: FAKE_HEADERS });
      assert.equal(r.known, false, "应答里没有额度字段就不能算数");
    }, "判据被拆掉之后，②d 竟然还过");
  });
});

/* ====================================================================== *
 * ⑨ 源码纪律：零依赖、零时钟、UTF-8 无 BOM
 * ====================================================================== */
describe("⑨ 源码纪律", () => {
  const src = readFileSync(SRC, "utf8");

  test("⑨a 不 import 本仓库任何其它模块（纯逻辑、零依赖）", () => {
    assert.equal(/^\s*import\s/m.test(src), false, "不许 import 仓库里任何别的模块");
    assert.equal(/\brequire\s*\(/m.test(src), false);
  });

  test("⑨b 内部不取时刻（时间由 opts.now 传入）", () => {
    // 先去掉注释再查 —— 头注释里写着「不许 Date.now()」这句话本身不该被当成调用。
    const code = stripComments(src);
    assert.equal(code.includes("Date.now("), false, "内部不许调 Date.now()");
    assert.equal(/\bnew Date\s*\(\s*\)/.test(code), false, "不许拿无参 new Date() 取当下");
  });

  test("⑨c UTF-8 且无 BOM", () => {
    const bytes = readFileSync(SRC);
    assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, false, "不许带 BOM");
    assert.equal(src.includes(String.fromCharCode(0xfffd)), false, "必须是合法的 UTF-8（不该有解码失败的替换字符）");
  });

  test("⑨d 脱敏函数本身会把凭据洗掉", () => {
    const out = redactAnswer(
      { authorization: "Bearer sk-x", nested: { api_key: "sk-y", ok: 1 }, list: [{ token: "sk-z" }] },
      ["sk-w"],
    );
    assert.equal(out.authorization, "[已脱敏]");
    assert.equal(out.nested.api_key, "[已脱敏]");
    assert.equal(out.nested.ok, 1, "不该误伤普通字段");
    assert.equal(out.list[0].token, "[已脱敏]");
    assert.equal(out.authorization.includes("sk-x"), false);
  });
});
