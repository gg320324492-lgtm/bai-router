/* Qoder（qd）额度探测的口径测试 —— src/server/quota-probe.mjs 的 qd 那一家。
 *
 * 背景（2026-10-23 实测）：qd 原来的候选表全是**猜**的
 * （/sash/api/v1/me/quota 与 /sash/api/v1/me/usage），面板上显示「探不到：401」。
 * 手工实测之后结论变了：
 *
 *   ① 端点在**另一个域**：openapi.qoder.sh（账号 API），与推理基址
 *      api2-v2.qoder.sh/model/v1 不是一路 —— 所以规格里写绝对地址，不拼 {base}。
 *   ② 真的端点是 GET https://openapi.qoder.sh/api/v2/quota/usage，
 *      鉴权只要一条 `Authorization: Bearer <jt-令牌>`（实测带不带 x-gw-user-id
 *      都回同一份应答）。
 *   ③ 应答里有两个额度桶：addOnQuota（加购积分）与 userQuota（套餐积分），
 *      形状都是 {total,used,remaining,percentage,unit}，unit 是**积分 credits**。
 *   ④ 旧的猜测端点在**有效令牌下是 404**：401 只说明鉴权层先于路由拦下来了，
 *      不说明路由存在 —— 这条教训固化成断言，免得下一个人又被 401 骗一次。
 *
 * 测的是这几条性质：
 *   ① 规格里写的是**实测**的端点与字段名，不是猜的；
 *   ② 实测形状能读出数，且单位是积分；
 *   ③ 上限为 0 的桶**不算额度池**（不许显示成 0/0）；
 *   ④ 没有令牌就一个请求都不发；
 *   ⑤ 头拼成上游要的样子（Bearer 前缀）。
 *
 * 反向对照在最后一节：把实现改坏（复制到临时目录改一改再 import 进来），
 * 证明前面那些断言**真的会红** —— 不会红的断言等于没写。
 *
 * 网络一律由假的 get 注入 —— 本文件绝不发真请求、绝不用真令牌。
 * 夹具里的令牌是明显假的占位串。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { probeQuota, PROBE_SPECS, UNIT_CREDITS, qdQuotaHeaders } from "../src/server/quota-probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "server", "quota-probe.mjs");

const NOW = 1_700_000_000_000;

/* 一把**明显是假的**令牌：真令牌绝不许进这个文件（它会被提交进仓库）。 */
const FAKE_TOKEN = "jt-fake-000000-not-a-real-token";
const FAKE_HEADERS = qdQuotaHeaders(FAKE_TOKEN);

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
    return { status: 404, text: JSON.stringify({ errorCode: "NotFound", errorMessage: "Not found" }) };
  };
  get.calls = calls;
  return get;
}

const json = (obj, status = 200) => ({ status, text: JSON.stringify(obj) });

/**
 * 实测到的应答形状（脱敏后照抄，2026-10-23）。
 *
 * ⚠ 里面的 uid / 邮箱之类是**假的占位值** —— 真值不许进仓库。
 *   两个额度桶：userQuota 是套餐额度（Free 档 = 0/0），addOnQuota 是加购积分（600/0）。
 */
const MEASURED_BODY = {
  userId: "00000000-0000-4000-8000-000000000000",
  userType: "personal_standard",
  usageType: "credits",
  totalUsagePercentage: 0,
  isQuotaExceeded: false,
  expiresAt: 253402214400000,
  upgradeUrl: "https://qoder.com/pricing?client=qoder",
  outerProviders: [],
  userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "credits" },
  addOnQuota: { total: 600, used: 0, remaining: 600, percentage: 0, unit: "credits", detailUrl: "https://qoder.com/account/usage" },
  isPlanQuotaProrated: false,
};

/* ====================================================================== *
 * ① 规格形状：写的是实测的端点与字段名
 * ====================================================================== */
describe("① qd 的候选表必须是实测出来的", () => {
  const spec = PROBE_SPECS.qd;

  test("①a 第一条候选就是实测那个端点（openapi.qoder.sh + /api/v2/quota/usage）", () => {
    const first = (spec.candidates || [])[0];
    assert.ok(first, "qd 必须有候选表");
    assert.equal(first.url, "https://openapi.qoder.sh/api/v2/quota/usage",
      "qd 的额度端点实测在 openapi.qoder.sh（账号 API），与推理基址不是一路");
  });

  test("①b 老猜测的 v1 端点不许再出现（有效令牌下实测是 404）", () => {
    for (const c of spec.candidates || []) {
      assert.ok(!/\/sash\/api\/v1\/me\/(quota|usage)\b/.test(String(c.url || "")),
        `401 只说明鉴权层先拦了，不说明路由存在 —— 实测这些 v1 路径是 404：${c.url}`);
    }
  });

  test("①c 端点不许拼 {base}/{origin}（那是推理基址，拼出来必 404）", () => {
    for (const c of spec.candidates || []) {
      const u = String(c.url || "");
      assert.ok(!u.includes("{base}") && !u.includes("{origin}"),
        `qd 的额度端点在另一个域，不许拼推理基址：${u}`);
    }
  });

  test("①d 实测那条：字段路径是 addOnQuota / userQuota，单位是积分", () => {
    const c = (spec.candidates || []).find((x) => x.source && /实测/.test(x.source));
    assert.ok(c, "qd 必须有标着「实测」的候选端点");
    assert.equal(c.unit, UNIT_CREDITS, "Qoder 的额度单位是积分（credits），不是 token");
    const paths = (c.windows || []).flatMap((w) => [
      ...(w.used || []).map((s) => s.path),
      ...(w.limit || []).map((s) => s.path),
    ]);
    assert.deepEqual([...paths].sort(), [
      "addOnQuota.total", "addOnQuota.used",
      "userQuota.total", "userQuota.used",
    ], "实测的字段名就是这两个桶的 used/total");
  });

  test("①e 每条候选都要写明是实测还是候选（不许含糊）", () => {
    for (const c of spec.candidates || []) {
      assert.match(String(c.source || ""), /实测|候选/,
        "候选端点必须在 source 里写明是实测还是候选");
    }
    assert.ok((spec.candidates || []).some((c) => /实测/.test(String(c.source || ""))),
      "qd 必须至少有一条实测端点");
  });
});

/* ====================================================================== *
 * ② 实测形状能读出数
 * ====================================================================== */
describe("② 实测形状 ⇒ 算数", () => {
  test("②a 读出加购额度：used 0 / limit 600，单位是积分", async () => {
    const get = fakeGet([{ match: "/api/v2/quota/usage", reply: json(MEASURED_BODY) }]);
    const r = await probeQuota("qd", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, true);
    assert.equal(r.used, 0, "上游真的报 0 就要是 0（与「探不到」是两件事）");
    assert.equal(r.limit, 600);
    assert.equal(r.unit, UNIT_CREDITS);
    assert.match(r.source, /api\/v2\/quota\/usage/, "来源要写明是哪个接口");
    assert.match(r.source, /加购额度/, "来源要写明是哪个桶");
  });

  test("②b 只发一个请求（第一条候选就命中）", async () => {
    const get = fakeGet([{ match: "/api/v2/quota/usage", reply: json(MEASURED_BODY) }]);
    await probeQuota("qd", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(get.calls.length, 1);
    assert.equal(get.calls[0].method, "GET", "探测只许 GET/HEAD");
  });

  test("②c 请求头带的是 Bearer 令牌（上游要的就是这个）", async () => {
    const get = fakeGet([{ match: "/api/v2/quota/usage", reply: json(MEASURED_BODY) }]);
    await probeQuota("qd", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(get.calls[0].headers.authorization, `Bearer ${FAKE_TOKEN}`);
  });

  test("②d 第一条失灵时，第二条（sash 版）能顶上", async () => {
    const get = fakeGet([
      { match: "/api/v2/quota/usage", reply: { status: 404, text: JSON.stringify({ errorCode: "NotFound" }) } },
      {
        match: "/sash/api/v2/me/usage",
        reply: json({ displayMode: "qoder", qoderUsage: MEASURED_BODY }),
      },
    ]);
    const r = await probeQuota("qd", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, true);
    assert.equal(r.limit, 600);
    assert.match(r.source, /sash\/api\/v2\/me\/usage/);
  });
});

/* ====================================================================== *
 * ③ 上限为 0 的桶不是额度池
 * ====================================================================== */
describe("③ 0/0 的桶不许报出去", () => {
  test("③a 两个桶都是 0/0 ⇒ 探不到（绝不显示成 0/0）", async () => {
    const body = {
      ...MEASURED_BODY,
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "credits" },
      addOnQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "credits" },
    };
    const get = fakeGet([{ match: "/api/v2/quota/usage", reply: json(body) }]);
    const r = await probeQuota("qd", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, false, "上游没给可用的额度池 ⇒ 探不到，不许显示 0/0");
    assert.equal(r.used, null);
    assert.equal(r.limit, null);
    assert.ok(r.error && r.error.length > 0, "必须给出原因");
  });

  test("③b 套餐桶 0/0 时，报的是加购那个桶（600）", async () => {
    const get = fakeGet([{ match: "/api/v2/quota/usage", reply: json(MEASURED_BODY) }]);
    const r = await probeQuota("qd", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.limit, 600, "Free 档的 userQuota 是 0/0，不许拿它当上限");
  });

  test("③c 套餐桶有值时，报更紧的那条窗口", async () => {
    const body = {
      ...MEASURED_BODY,
      userQuota: { total: 10000, used: 3000, remaining: 7000, percentage: 30, unit: "credits" },
      addOnQuota: { total: 600, used: 0, remaining: 600, percentage: 0, unit: "credits" },
    };
    const get = fakeGet([{ match: "/api/v2/quota/usage", reply: json(body) }]);
    const r = await probeQuota("qd", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.used, 3000, "30% 比 0% 更紧，报更紧的那条");
    assert.equal(r.limit, 10000);
    assert.match(r.source, /套餐额度/);
  });
});

/* ====================================================================== *
 * ④ 没有令牌 ⇒ 一个请求都不发
 * ====================================================================== */
describe("④ 没有登录态就不发请求", () => {
  test("④a 空头 ⇒ 零请求 + 探不到", async () => {
    const get = fakeGet([{ match: "/", reply: json(MEASURED_BODY) }]);
    const r = await probeQuota("qd", { now: NOW, get, headers: {} });
    assert.equal(get.calls.length, 0, "没令牌就发探测，只会被算成一次失败请求");
    assert.equal(r.known, false);
    assert.match(r.error, /登录态/);
  });

  test("④b 只有 x-api-key 不算 qd 的凭据（上游只认 Authorization）", async () => {
    const get = fakeGet([{ match: "/", reply: json(MEASURED_BODY) }]);
    const r = await probeQuota("qd", { now: NOW, get, headers: { "x-api-key": FAKE_TOKEN } });
    assert.equal(get.calls.length, 0, "qd 的端点只认 Authorization，别拿别的头去撞");
    assert.equal(r.known, false);
  });

  test("④c 上游说令牌不生效 ⇒ 如实报 401 的那句话", async () => {
    const get = fakeGet([{
      match: "/api/v2/quota/usage",
      reply: { status: 401, text: JSON.stringify({ code: "TOKEN_EXPIRE", message: "token is not active" }) },
    }]);
    const r = await probeQuota("qd", { now: NOW, get, headers: FAKE_HEADERS });
    assert.equal(r.known, false);
    assert.match(r.error, /401/, "要把上游自己的话带给用户");
    assert.match(r.error, /token is not active/);
  });
});

/* ====================================================================== *
 * ⑤ 鉴权头的形状
 * ====================================================================== */
describe("⑤ Qoder 的鉴权头", () => {
  test("⑤a 拼成 Bearer <令牌>", () => {
    assert.deepEqual(qdQuotaHeaders(FAKE_TOKEN), { authorization: `Bearer ${FAKE_TOKEN}` });
  });

  test("⑤b 没有令牌 ⇒ 空对象（调用方据此不发请求）", () => {
    assert.deepEqual(qdQuotaHeaders(""), {});
    assert.deepEqual(qdQuotaHeaders(null), {});
    assert.deepEqual(qdQuotaHeaders("   "), {}, "空白也算没有");
  });
});

/* ====================================================================== *
 * ⑥ 反向对照：把实现改坏，证明前面的断言真的会红
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
  const dir = mkdtempSync(path.join(tmpdir(), "qd-quota-mutant-"));
  const file = path.join(dir, "quota-probe.mjs");
  writeFileSync(file, out, "utf8");
  return import(pathToFileURL(file).href);
}

/** 断言「改坏之后这条检查会红」。 */
async function mustGoRed(mod, check, why) {
  let threw = false;
  try {
    await check(mod);
  } catch {
    threw = true;
  }
  assert.equal(threw, true, `改坏之后这条断言竟然还过：${why}`);
}

describe("⑥ 反向对照 —— 改坏实现，对应断言必须真的会红", () => {
  test("⑥a 把「上限为 0 的桶不算额度池」拆掉 ⇒ ③a 会红", async () => {
    const mod = await mutant([
      ["if (!percent && minLimit !== null && limit < minLimit) return null;", "if (false) {}"],
    ]);
    await mustGoRed(mod, async (m) => {
      const body = {
        ...MEASURED_BODY,
        userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "credits" },
        addOnQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "credits" },
      };
      const get = fakeGet([{ match: "/api/v2/quota/usage", reply: json(body) }]);
      const r = await m.probeQuota("qd", { now: NOW, get, headers: FAKE_HEADERS });
      assert.equal(r.known, false, "0/0 的桶不许报出去");
    }, "minLimit 那道闸被拆掉之后，③a 竟然还过");
  });

  test("⑥b 把字段路径改坏 ⇒ ②a 会红（读不到就是读不到）", async () => {
    /* ⚠ 三条候选都要改坏：只改第一条的话，**后面的候选会顶上**（候选表本来就是
     *   「多条并列、谁先读出数算谁」），断言就不会红 —— 那样这条对照等于没写。 */
    const mod = await mutant([
      ['{ path: "addOnQuota.used" }', '{ path: "addOnQuota.usedTypo" }'],
      ['{ path: "qoderUsage.addOnQuota.used" }', '{ path: "qoderUsage.addOnQuota.usedTypo" }'],
    ]);
    await mustGoRed(mod, async (m) => {
      const get = fakeGet([{ match: "/api/v2/quota/usage", reply: json(MEASURED_BODY) }]);
      const r = await m.probeQuota("qd", { now: NOW, get, headers: FAKE_HEADERS });
      assert.equal(r.known, false, "字段名猜错就不算数，不许拿别的数顶替");
      assert.equal(r.limit, null);
    }, "字段路径被改坏之后，②a 竟然还过");
  });

  test("⑥c 把 Bearer 前缀去掉 ⇒ ⑤a 会红", async () => {
    const mod = await mutant([
      ['return { authorization: "Bearer " + t };', "return { authorization: t };"],
    ]);
    await mustGoRed(mod, async (m) => {
      assert.deepEqual(m.qdQuotaHeaders(FAKE_TOKEN), { authorization: `Bearer ${FAKE_TOKEN}` });
    }, "Bearer 前缀被去掉之后，⑤a 竟然还过");
  });

  test("⑥d 把 qd 的 authHeaders 去掉 ⇒ ④b 会红", async () => {
    const mod = await mutant([
      ['authHeaders: ["authorization"],', ""],
    ]);
    await mustGoRed(mod, async (m) => {
      const get = fakeGet([{ match: "/", reply: json(MEASURED_BODY) }]);
      const r = await m.probeQuota("qd", { now: NOW, get, headers: { "x-api-key": FAKE_TOKEN } });
      assert.equal(get.calls.length, 0, "qd 只认 Authorization");
    }, "authHeaders 被去掉之后，④b 竟然还过");
  });

  test("⑥e 把端点改回老猜测 ⇒ ①a 会红", async () => {
    const mod = await mutant([
      ['url: "https://openapi.qoder.sh/api/v2/quota/usage"', 'url: "https://openapi.qoder.sh/sash/api/v1/me/quota"'],
    ]);
    await mustGoRed(mod, async (m) => {
      const first = (m.PROBE_SPECS.qd.candidates || [])[0];
      assert.equal(first.url, "https://openapi.qoder.sh/api/v2/quota/usage");
    }, "端点被改回老猜测之后，①a 竟然还过");
  });

  test("⑥f 把 source 里的「实测」抹掉 ⇒ ①e 会红", async () => {
    const mod = await mutant([
      ['source: "实测 GET https://openapi.qoder.sh/api/v2/quota/usage', 'source: "GET https://openapi.qoder.sh/api/v2/quota/usage'],
    ]);
    await mustGoRed(mod, async (m) => {
      for (const c of m.PROBE_SPECS.qd.candidates || []) {
        assert.match(String(c.source || ""), /实测|候选/, "每条都要写明是实测还是候选");
      }
    }, "实测/候选的标注被抹掉之后，①e 竟然还过");
  });

  test("⑥g 把一条 limit 路径改坏 ⇒ ①d 会红", async () => {
    const mod = await mutant([
      ['{ path: "addOnQuota.total" }', '{ path: "addOnQuota.totalTypo" }'],
    ]);
    await mustGoRed(mod, async (m) => {
      const c = (m.PROBE_SPECS.qd.candidates || []).find((x) => x.source && /实测/.test(x.source));
      const paths = (c.windows || []).flatMap((w) => [
        ...(w.used || []).map((s) => s.path),
        ...(w.limit || []).map((s) => s.path),
      ]);
      assert.deepEqual([...paths].sort(), [
        "addOnQuota.total", "addOnQuota.used",
        "userQuota.total", "userQuota.used",
      ]);
    }, "字段路径被改坏之后，①d 竟然还过");
  });

  test("⑥h 把规格里的 minLimit 删掉 ⇒ ③a 会红", async () => {
    /* 引擎里那道闸（⑥a）与规格里写的那个数（这里）**两处都要在**：
     *   少了任何一处，0/0 的桶就会被报出去，面板上显示成「0 / 0（0%）」。 */
    const mod = await mutant([
      ["minLimit: 1,", ""],
    ]);
    await mustGoRed(mod, async (m) => {
      const body = {
        ...MEASURED_BODY,
        userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "credits" },
        addOnQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "credits" },
      };
      const get = fakeGet([{ match: "/api/v2/quota/usage", reply: json(body) }]);
      const r = await m.probeQuota("qd", { now: NOW, get, headers: FAKE_HEADERS });
      assert.equal(r.known, false, "0/0 的桶不许报出去");
    }, "规格里的 minLimit 被删掉之后，③a 竟然还过");
  });
});
