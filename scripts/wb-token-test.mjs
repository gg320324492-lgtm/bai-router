/**
 * scripts/wb-token-test.mjs —— 「WorkBuddy 令牌被无条件判成已过期，wb/wbai 两个渠道经中转全挂」
 *
 * ## 这条缺陷是怎么溜过去的（v1.0.76 / commit 93ce3fe 起）
 *
 *   wb-token.mjs 的 wbTokenExp 返回的是 JWT 原生的 `exp`，单位**秒**；
 *   wb-pool-wiring.mjs 的契约是**毫秒**（`tokenExpOf` 的签名注释、参数名 `expMs`、
 *   `expMs <= now`、`tokenExpiring(expMs, now)` 四处都按毫秒写，`now` = Date.now()）。
 *   池化迁移时旧代码里的 `* 1000` 掉了，于是
 *     `1.79e9 (秒) <= 1.79e12 (毫秒)` 恒为真 —— 每一枚令牌都被判 expired，
 *     而 `expired` 又直接映射成 401「令牌已过期且没有刷新令牌，请重新捕获」。
 *   接线层没写错，是**传进去的实现违约**。
 *
 *   为什么测试没抓到：scripts/wb-pool-wiring-test.mjs 第 70 行 `const NOW = 1789000000000`
 *   （毫秒），并全程注入自己的替身 `tokenExpOf: () => NOW ± 1000`。
 *   **生产的 wbTokenExp 从没被接进过测试**——判据被替身顶替，等于没有判据。
 *
 * ## 本文件怎么补上这一条
 *
 *   ★ **真实现接真路径**：从 src/server/wb-token.mjs import 的 wbTokenExp（不是替身）
 *     直接喂给 wb-pool-wiring.mjs 的 wbPickAccount 的 `tokenExpOf`——正是 server.mjs
 *     在 wbEnsureTokenPooled 里那一行 `tokenExpOf: wbTokenExp`。夹具是**现造的合成 JWT**
 *     （自己 base64url 编 payload），过期时间按秒给。
 *   ★ **同量纲守卫**（机械检查）：断言 wbTokenExp() 的返回值与 Date.now() 处在同一数量级。
 *     比任何具体数字都耐用——以后谁再顺手去掉 ×1000，比值会从 ≈1 掉到 ≈0.001，当场红。
 *   ★ **跨调用点一致性**：从 server.mjs 源码里**抠出真的** expAt / expiresInDays 表达式
 *     求值，断言天数落在 1~400 天、expAt 落在预期的那个瞬间。wb 与 wbai 两组共四处全查。
 *   ★ **接线完整性**：断言 server.mjs 确实 `import ... from "./wb-token.mjs"`，
 *     且确实把 `wbTokenExp` 传给了 `tokenExpOf`——否则被测的实现与生产用的会是两个。
 *
 * ## 反向对照
 *
 *   本文件没有配套 sabotage 执行器（红线限定只许新增这一个脚本）。反向验证靠手工回退：
 *   把 wb-token.mjs 里的 `p.exp * 1000` 改回 `p.exp`，下面 ①②④ 三条当场红；
 *   把 server.mjs 那四行的 `* 1000` 加回去，⑥ 当场红。判据只有一个：**改回去必须红**。
 *   严禁恒真断言——每条断言都在文件末尾配了「判据自己失效了」的对照。
 *
 * ## 红线
 *
 *   🔴 全文没有一个真实令牌 / API key / 用户名 / 本机绝对路径。
 *      夹具里的 JWT 是现造的：`payload` 由本文件的 b64u() 编出来，签名段是一句假话，
 *      `sub` 是 `wb-dummy-account-0001` 这种明显假的占位串。
 *   🔴 本文件**零 IO、零网络、不起进程**（纯逻辑模块求值），不碰 %APPDATA%\bai-router。
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { wbJwtPayload, wbTokenExp, wbTokenSub } from "../src/server/wb-token.mjs";
import { wbPickAccount, wbResetRuntime } from "../src/server/wb-pool-wiring.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER_SRC = readFileSync(path.join(REPO, "src", "server", "server.mjs"), "utf8");

/* ====================================================================== *
 * 夹具：合成 JWT。🔴 自己编，不含任何真实凭据。
 * ====================================================================== */

const b64u = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 造一枚三段式假 JWT。`payload` 就是 exp 所在的声明；签名段只是占位（解 payload 用不到它）。 */
const synthJwt = (payload) =>
  `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u(payload)}.this-is-not-a-real-signature`;

const DAY = 24 * 60 * 60 * 1000;
/** n 天之后的到期时刻，**按秒给**（JWT 原生单位，正是本次要钉住的那个单位）。 */
const expSecondsIn = (days) => Math.floor((Date.now() + days * DAY) / 1000);

/** 一枚「远在将来」的合法令牌，配套一个假账号 id。 */
const futureJwt = (days = 30) => synthJwt({ sub: "wb-dummy-account-0001", exp: expSecondsIn(days) });
/** 一枚「明显在过去」的合法令牌，且**没有**配套刷新令牌（否则会走续期分支而不是 expired）。 */
const pastJwt = (days = 30) => synthJwt({ sub: "wb-dummy-account-0002", exp: Math.floor((Date.now() - days * DAY) / 1000) });

/* 池配置。形态照着生产来：显式 accounts（多账号池），条目字段与 wb-pool-wiring 的
   normalizeAccount 对得上。token 与 refreshToken 成对给，用例里显式控制。 */
function poolCfg({ version = "wb", tokens, refresh = "", labels } = {}) {
  return {
    [version]: {
      accessToken: "",
      refreshToken: "",
      accounts: tokens.map((t, i) => ({
        id: `a${i + 1}`,
        label: (labels && labels[i]) || `假账号-${i + 1}`,
        version,
        order: i,
        accessToken: t,
        refreshToken: refresh,
        deviceToken: "",
        userId: "",
        credential: { lastRefreshTime: Date.now(), capturedAt: Date.now() },
        modelCooldowns: {},
      })),
    },
  };
}

/** 走真实路径：tokenExpOf 传的是**真的** wbTokenExp，不是替身。 */
const pick = (cfg, o = {}) => wbPickAccount(cfg, o.version || "wb", {
  now: Date.now(), tokenExpOf: wbTokenExp, model: null, sessionKey: null, ...o,
});

/* ====================================================================== *
 * ① ⭐ 核心回归：真 wbTokenExp + 真选号路径 + 一枚远在将来的合成 JWT
 * ====================================================================== */
describe("① 真 wbTokenExp 接进真实选号路径（v1.0.76 漏掉的那条）", () => {
  beforeEach(() => { wbResetRuntime(); });

  test("远在将来的令牌 → 判成可用、选得出号、发得出去原令牌", async () => {
    const tok = futureJwt(30);
    const cfg = poolCfg({ tokens: [tok] });
    const r = await pick(cfg);

    assert.equal(r.ok, true,
      `★ 真 wbTokenExp 应当判这枚令牌没过期。实际 reason=${r.reason} —— `
      + "若为 expired，说明 wbTokenExp 返回的还是秒（漏了 * 1000）");
    assert.equal(r.accountId, "a1");
    assert.equal(r.token, tok, "发出去的必须是这枚令牌本身");
    assert.ok(Number.isInteger(r.eligible) && r.eligible >= 1, `池里应当有可选条目，实际 eligible=${r.eligible}`);
  });

  test("wbai 国际版走同一条路（两个渠道曾经一起全挂）", async () => {
    const tok = futureJwt(90);
    const cfg = poolCfg({ version: "wbai", tokens: [tok] });
    const r = await pick(cfg, { version: "wbai" });
    assert.equal(r.ok, true, `wbai 同样判可用。实际 reason=${r.reason}`);
    assert.equal(r.token, tok);
  });

  test("多账号池里每一枚都判可用（不止第一条）", async () => {
    const toks = [futureJwt(200), futureJwt(31), futureJwt(400)];
    const cfg = poolCfg({ tokens: toks });
    const r = await pick(cfg);
    assert.equal(r.ok, true, `实际 reason=${r.reason}`);
    assert.equal(r.total, 3);
    assert.equal(r.eligible, 3, "三枚都该在可选范围内");
  });

  test("带刷新令牌的号也判可用（临期才续期，far-future 不该触发续期）", async () => {
    let refreshed = false;
    const cfg = poolCfg({ tokens: [futureJwt(300)], refresh: "wb-dummy-refresh-not-real" });
    const r = await pick(cfg, { refresh: () => { refreshed = true; return "should-not-happen"; } });
    assert.equal(r.ok, true, `实际 reason=${r.reason}`);
    assert.equal(refreshed, false, "还有 300 天才到期，不该走续期分支");
  });

  test("旧的单令牌配置（合成池）也判可用 —— 池化对老用户是纯增量", async () => {
    const tok = futureJwt(45);
    const cfg = { wb: { accessToken: tok, refreshToken: "", deviceToken: "", userId: "" } };
    const r = await pick(cfg);
    assert.equal(r.ok, true, `合成池上同样判可用。实际 reason=${r.reason}`);
    assert.equal(r.token, tok);
  });
});

/* ====================================================================== *
 * ② 过去的令牌仍必须判 expired（防「改成永不过期」）
 * ====================================================================== */
describe("② 过期令牌仍判 expired", () => {
  beforeEach(() => { wbResetRuntime(); });

  test("exp 明确在过去、且没有刷新令牌 → expired（并映射成 401）", async () => {
    const cfg = poolCfg({ tokens: [pastJwt(30)] });
    const r = await pick(cfg);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "expired", `必须是 expired，实际 reason=${r.reason}`);
    assert.equal(r.status, 401, "expired 仍映射成 401（与池化之前一致）");
    assert.ok(r.remedy && r.remedy.length > 0, "要给一句能照做的建议，不是一句猜谜");
  });

  test("exp 在 1 秒前也算过期（边界不吃一个身位）", async () => {
    const cfg = poolCfg({ tokens: [synthJwt({ sub: "wb-dummy-account-0003", exp: Math.floor(Date.now() / 1000) - 1 })] });
    const r = await pick(cfg);
    assert.equal(r.reason, "expired");
  });

  test("wbai 的过期令牌同样判 expired", async () => {
    const cfg = poolCfg({ version: "wbai", tokens: [pastJwt(2)] });
    const r = await pick(cfg, { version: "wbai" });
    assert.equal(r.reason, "expired");
  });

  test("有刷新令牌的过期号不直接判死（先续期）—— 判据仍认秒/毫秒", async () => {
    const cfg = poolCfg({ tokens: [pastJwt(30)], refresh: "wb-dummy-refresh-not-real" });
    let called = false;
    const r = await pick(cfg, {
      refresh: async () => { called = true; return futureJwt(300); },
    });
    assert.equal(called, true, "过期 + 有刷新令牌 → 先续期再发，不是直接判死");
    assert.equal(r.ok, true, `续期成功后应当可用。实际 reason=${r.reason}`);
  });
});

/* ====================================================================== *
 * ③ 取不到 exp → null，且**不判过期**（「读不出」与「已过期」不是一回事）
 * ====================================================================== */
describe("③ exp 缺失 / 不是数字 / 不是 JWT", () => {
  beforeEach(() => { wbResetRuntime(); });

  /* pickExpect 那一列是**接真实路径之后**应当拿到的原因，分两类，不能混：
   *   ok        —— 令牌在、但到期时刻读不出来。既有语义是「读不出就不知道」，
   *               所以照常放行发出去，**不许**判 expired。
   *   no_token  —— 条目里压根没有令牌（空串 / null）。这是另一个诚实原因，
   *               接线层本来就报 no_token（401「访问令牌未配置」），同样不是 expired。
   *                 把它单列出来，是因为「没有令牌」与「不知道令牌还能用多久」是两件事，
   *                 混成一条断言就等于把这个区分放弃了。 */
  const CASES = [
    { name: "payload 里没有 exp", tok: synthJwt({ sub: "wb-dummy-account-0004" }), pickExpect: "ok" },
    { name: "exp 是字符串（JWT 原生应为数字）", tok: synthJwt({ sub: "wb-dummy-account-0005", exp: String(expSecondsIn(30)) }), pickExpect: "ok" },
    { name: "exp 是 null", tok: synthJwt({ sub: "wb-dummy-account-0006", exp: null }), pickExpect: "ok" },
    { name: "payload 不是 JSON", tok: "eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24tYXQtYWxs.sig", pickExpect: "ok" },
    { name: "根本不是 JWT（没有点分段）", tok: "wb-dummy-opaque-token-not-a-jwt", pickExpect: "ok" },
    { name: "空串（压根没配令牌）", tok: "", pickExpect: "no_token" },
    { name: "null（压根没配令牌）", tok: null, pickExpect: "no_token" },
  ];

  for (const c of CASES) {
    test(`${c.name} → wbTokenExp 返回 null`, () => {
      assert.equal(wbTokenExp(c.tok), null);
    });

    test(`${c.name} → 不判过期（拿到的是 ${c.pickExpect}，绝不是 expired）`, async () => {
      const cfg = poolCfg({ tokens: [c.tok] });
      const r = await pick(cfg);
      assert.notEqual(r.reason, "expired",
        `取不到 exp 不等于已过期。实际 reason=${r.reason} —— `
        + "「读不出」与「很旧」必须分开处理");
      if (c.pickExpect === "ok") {
        assert.equal(r.ok, true, `应当照常放行，实际 reason=${r.reason}`);
        assert.equal(r.token, c.tok);
      } else {
        assert.equal(r.reason, "no_token", `没配令牌应当报 no_token，实际 reason=${r.reason}`);
      }
    });
  }

  test("wbJwtPayload 对「根本解不出载荷」的输入一律 null（不抛）", () => {
    const UNPARSEABLE = [
      { name: "payload 不是 JSON", tok: "eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24tYXQtYWxs.sig" },
      { name: "没有点分段", tok: "wb-dummy-opaque-token-not-a-jwt" },
      { name: "空串", tok: "" },
      { name: "null / undefined", tok: null },
    ];
    for (const c of UNPARSEABLE) {
      assert.equal(wbJwtPayload(c.tok), null, `${c.name} 应当解析失败而不是抛异常`);
    }
  });

  test("载荷是 JSON 数组：wbJwtPayload 照原样交出（typeof 判据的老行为），但仍取不到 exp", () => {
    /* 记一笔**既有行为**，本次不动它（改 wbJwtPayload 的语义不在本次范围内）：
       载荷守卫写的是 `typeof p === "object"`，而数组的 typeof 也是 "object"，
       所以数组会原样穿过。生产上无害——数组上没有 exp，wbTokenExp 照样给 null。 */
    const arr = synthJwt(["wb-dummy-account-0008"]);
    assert.ok(Array.isArray(wbJwtPayload(arr)), "前提：数组确实会穿过载荷守卫");
    assert.equal(wbTokenExp(arr), null, "但数组取不到 exp，仍然按「不知道」处理");
  });

  test("载荷解得出、只是没有 exp —— wbJwtPayload 照样交出载荷（不是它不认，是 exp 不在那）", () => {
    /* 这条把「解不出来」与「解出来了但没 exp」分开，免得有人拿 wbJwtPayload
       一起去背「exp 缺失」那条锅。 */
    assert.deepEqual(wbJwtPayload(synthJwt({ sub: "wb-dummy-account-0004" })), { sub: "wb-dummy-account-0004" });
    assert.equal(wbTokenExp(synthJwt({ sub: "wb-dummy-account-0004" })), null);
  });
});

/* ====================================================================== *
 * ④ ⭐ 同量纲守卫：返回值与 Date.now() 处在同一数量级
 *    —— 机械检查，比任何具体数字都耐用
 * ====================================================================== */
describe("④ 同量纲守卫（防「以后有人又去掉 ×1000」）", () => {
  test("wbTokenExp 的返回值与 Date.now() 比，比值落在 [0.1, 10]", () => {
    const expMs = wbTokenExp(futureJwt(30));
    assert.equal(typeof expMs, "number", "必须是数字");
    const now = Date.now();
    assert.ok(expMs > now, `到期时刻必须晚于现在（30 天后），实际 expMs=${expMs} now=${now}`);
    const ratio = expMs / now;
    assert.ok(ratio > 0.1 && ratio < 10,
      `★ wbTokenExp 必须返回**毫秒**：实测比值 ${ratio.toExponential(3)}。`
      + "返回秒的话比值约 1e-3，落在带外；这条红了就说明 ×1000 又被去掉了");
  });

  test("判据自己没失效：对一枚**秒**级时间戳，同一条量纲检查必须红", () => {
    const SECONDS_ONLY = synthJwt({ sub: "wb-dummy-account-0007", exp: expSecondsIn(30) });
    const raw = wbJwtPayload(SECONDS_ONLY).exp;          // 秒 —— 正是 v1.0.76 传进去的东西
    const ratio = raw / Date.now();
    assert.ok(!(ratio > 0.1 && ratio < 10),
      `负样本失效：秒级时间戳 ${raw} 的比值 ${ratio.toExponential(3)} 竟然落在带内，`
      + "量纲守卫失灵，后面那条就成了恒真断言");
  });

  test("wbTokenSub 不受单位改动影响（它返回字符串 sub，不是时间）", () => {
    assert.equal(wbTokenSub(futureJwt(30)), "wb-dummy-account-0001");
    assert.equal(wbTokenSub("not-a-jwt"), null);
    assert.equal(typeof wbTokenExp(futureJwt(30)), "number", "别把 sub 也改成数字");
  });
});

/* ====================================================================== *
 * ⑤ ⭐ 跨调用点一致性：server.mjs 里那四处 expAt / expiresInDays
 *    —— 从**真源码**抠出表达式求值，不是抄一份在测试里重写
 * ====================================================================== */
describe("⑤ 跨调用点一致性（server.mjs 的 expAt / expiresInDays）", () => {
  /* 刻意按 key 与变量名定位，**不按整行文本**做锚点——否则修好了（* 1000 被删）
     锚点就失效，测试自己先崩，测不出真正的回归。 */
  function grabExpr(key, varName) {
    const hits = [];
    for (const line of SERVER_SRC.split("\n")) {
      if (!line.includes(varName)) continue;
      const m = /^\s*[A-Za-z_$][\w$]*\s*:\s*(.+?)\s*,?\s*$/.exec(line);
      if (m && m[1].includes(varName) && m[1].includes(key === "expAt" ? "Date(" : "Math.")) hits.push(m[1].replace(/,\s*$/, ""));
    }
    assert.equal(hits.length, 1,
      `server.mjs 里应当恰好有一处 ${varName} 的 ${key} 表达式，实际找到 ${hits.length} 处`);
    return hits[0];
  }

  /* Date 用**真**构造器（不能注入桩：表达式里写着 `new Date(...)`），
     天数用真 Date.now() 对齐，因此断言给区间而不是给一个具体值。 */
  const evaluate = (varName, expMs) => {
    const src = `return { expAt: ${grabExpr("expAt", varName)}, expiresInDays: ${grabExpr("expiresInDays", varName)} };`;
    let fields;
    try {
      // eslint-disable-next-line no-new-func
      fields = new Function(varName, src)(expMs);
    } catch (e) {
      assert.fail(`抠出来的 ${varName} 表达式求值炸了：${e.message} —— `
        + "多半是有人把 * 1000 加回去了（值大到 new Date 抛 RangeError）");
    }
    return fields;
  };

  for (const varName of ["wbExp", "wbaiExp"]) {
    test(`${varName}: expAt / expiresInDays 对一枚 300 天后的令牌给出合理值`, () => {
      const expMs = expSecondsIn(300) * 1000;
      const got = evaluate(varName, expMs);
      assert.equal(got.expAt, new Date(expMs).toISOString(),
        `expAt 必须是那枚令牌真实的到期瞬间。实际 ${got.expAt}`);
      assert.ok(Number.isFinite(got.expiresInDays), "expiresInDays 必须是有限数");
      assert.ok(got.expiresInDays >= 1 && got.expiresInDays <= 400,
        `★ expiresInDays 应落在 1~400 天量级，实际 ${got.expiresInDays} —— `
        + "少了 ×1000 会是负数/0，多了 ×1000 会是几千万天，两种都落在这条带外");
    });

    test(`${varName}: 令牌早已过期时 expiresInDays 不为负（Math.max(0, …) 那道夹仍在）`, () => {
      const got = evaluate(varName, (Date.now() - 10 * DAY));
      assert.equal(got.expiresInDays, 0, "过期的令牌应报 0 天，而不是负数");
    });

    test(`${varName}: 取不到 exp 时两字段都为 null（不能是 0 或 Invalid Date）`, () => {
      const got = evaluate(varName, null);
      assert.equal(got.expAt, null);
      assert.equal(got.expiresInDays, null);
    });
  }

  test("扣分对照：把 ×1000 加回去，这两组断言必须红", () => {
    const expMs = expSecondsIn(300) * 1000;
    const broke = { expAt: new Date(expMs * 1000).toISOString(), expiresInDays: Math.max(0, Math.round((expMs * 1000 - Date.now()) / 86400000)) };
    /* ×1000 加回去后 new Date 仍能求出值（1.8e15 还在 JS 的日期范围内），
       所以红的方式不是抛异常，而是**值跑到带子外**：日期落到公元五万多年、天数上千万。 */
    assert.notEqual(broke.expAt, new Date(expMs).toISOString(), "前提：×1000 加回去后 expAt 必须是另一个瞬间");
    assert.ok(!Number.isFinite(new Date(broke.expAt).getTime()) || new Date(broke.expAt).getUTCFullYear() > 9999,
      `前提：×1000 加回去后 expAt 应落到公元 9999 年之后，实际 ${broke.expAt}`);
    assert.ok(!(broke.expiresInDays >= 1 && broke.expiresInDays <= 400),
      `前提：×1000 加回去后 expiresInDays（${broke.expiresInDays}）应当跑出 1~400 的带子`);
  });
});

/* ====================================================================== *
 * ⑥ 接线完整性：被测的实现 == 生产用的实现
 *    （否则 ①~⑤ 全在验一个没人用的函数，等于白验）
 * ====================================================================== */
describe("⑥ 接线完整性", () => {
  test("server.mjs 从 ./wb-token.mjs import 这三个函数", () => {
    assert.match(SERVER_SRC, /import\s*\{[^}]*\bwbTokenExp\b[^}]*\}\s*from\s*"\.\/wb-token\.mjs"/,
      "server.mjs 必须 import wbTokenExp —— 不 import 就还在用它自己那份，本文件全白验");
    assert.match(SERVER_SRC, /import\s*\{[^}]*\bwbTokenSub\b[^}]*\}\s*from\s*"\.\/wb-token\.mjs"/);
    assert.match(SERVER_SRC, /import\s*\{[^}]*\bwbJwtPayload\b[^}]*\}\s*from\s*"\.\/wb-token\.mjs"/);
  });

  test("server.mjs 把 wbTokenExp 原样传给 wbPickAccount 的 tokenExpOf", () => {
    assert.match(SERVER_SRC, /tokenExpOf\s*:\s*wbTokenExp/,
      "★ 接线那一行必须还在。删掉它 ⇒ 解码器不再被调用 ⇒ 取不到 exp ⇒ "
      + "「读不出」被当「已过期」，同一个故障换个形状回来");
  });

  test("server.mjs 里不再有自己那份 wbTokenExp 定义（搬家要搬干净）", () => {
    assert.doesNotMatch(SERVER_SRC, /\bfunction\s+wbTokenExp\b/,
      "server.mjs 里还留着一份本地定义 —— import 的会被它遮住，两份各说各话");
    assert.doesNotMatch(SERVER_SRC, /\bfunction\s+wbJwtPayload\b/);
    assert.doesNotMatch(SERVER_SRC, /\bfunction\s+wbTokenSub\b/);
  });

  test("server.mjs 对 wbTokenExp 的返回值不再补乘 1000", () => {
    const bad = SERVER_SRC.split("\n")
      .filter((l) => /\b(?:wbExp|wbaiExp)\b/.test(l) && /\*\s*1000/.test(l));
    assert.deepEqual(bad, [],
      `这几行又把 ×1000 加回来了：\n${bad.join("\n")}`);
  });
});