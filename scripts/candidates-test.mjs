/* 候选层（src/server/candidates.mjs）的口径测试。
 *
 * 这层是「对标 magpie 复刻」的第三步：把 WorkBuddy 账号池里那套**已经写对**的
 * 账号级路由机制（失败分类看响应体、两级休息、退避）提取成 provider-agnostic
 * 的通用层，让所有 provider 都能骑上去。
 *
 * 测的是 magpie 的三条核心语义：
 *   ① 失败分类**同时看状态码与响应体**（magpie 的 failure(status, body)）；
 *   ② **两级休息**：restKey 命中 ⇒ 整号休息；只有 restID 命中 ⇒ 只那个模型休息；
 *   ③ **退避**：连续失败 n 次 ⇒ 1m, 2m, 4m… 封顶 10m。
 *
 * 以及一条硬要求：failover.mjs 的**旧行为一字不变**（老调用方只传 status 时
 * 看到的结论必须与改动前逐字一致）。
 *
 * 时间一律由参数注入（opts.now），本文件不取 Date.now()。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  KINDS,
  classifyFailure,
  cooldownFor,
  backoffFor,
  restKeyOf,
  restIdOf,
  RestTable,
  makeCandidate,
  orderCandidates,
  pickCandidate,
  isResting,
} from "../src/server/candidates.mjs";
import {
  shouldFailover,
  providerRefusal,
  failoverCooldown,
  failoverAvailable,
  failoverQuotaBlocked,
  failoverClear,
  failoverSnapshot,
  failoverCooldownFor,
  restTable,
  FAILOVER_COOLDOWN_MS,
  FAILOVER_QUOTA_COOLDOWN_MS,
} from "../src/server/failover.mjs";
// 策略点只在这里引入：候选层**不 import routes.mjs**（策略由调用方传进去）。
import { Ordered, Smart } from "../src/server/routes.mjs";

const NOW = 1_700_000_000_000;
const MIN = 60 * 1000;

/* ====================================================================== *
 * ① 失败分类：同时看状态码与响应体
 * ====================================================================== */
describe("① 分类器 —— 状态码 + 响应体", () => {
  test("①a 400 + 「request illegal」⇒ 换一家有用，但谁也不休息", () => {
    const f = classifyFailure(400, "request illegal");
    assert.equal(f.kind, "auth", "属「供应商不接这个客户端」那一族");
    assert.equal(f.dead, false, "这不是凭据失效，不能判死");
    assert.equal(f.scope, "none", "magpie 的 failPrompt：换一家有用，账号本身没问题");
    assert.equal(f.failover, true, "必须转移 —— 2026-10-21 实测它终结了整条链");
    assert.equal(shouldFailover(400, "request illegal"), true);
    assert.equal(shouldFailover(400, "[WorkBuddy AI] request illegal"), true);
  });

  test("①b 400 + 「missing required field」⇒ 请求本身有问题，不转移", () => {
    const f = classifyFailure(400, '{"error":{"message":"missing required field: messages"}}');
    assert.equal(f.kind, "content");
    assert.equal(f.scope, "none", "不休息任何人");
    assert.equal(f.failover, false, "换几家都一样失败，只会白耗别家的额度");
    assert.equal(shouldFailover(400, "missing required field"), false);
    assert.equal(shouldFailover(400, "invalid request: malformed body"), false);
    assert.equal(shouldFailover(422, "参数类型不对"), false);
  });

  test("①c 429 + 额度词 ⇒ quota（整号）", () => {
    const f = classifyFailure(429, "你的额度不足，请稍后再试");
    assert.equal(f.kind, "quota");
    assert.equal(f.scope, "account", "额度用尽 ⇒ 整号休息");
    assert.equal(f.failover, true);
    assert.equal(shouldFailover(429, "额度不足"), true);
  });

  test("①d 429 + 「余额不足」⇒ credit（钱没了，等多久都不会好）", () => {
    const f = classifyFailure(429, "余额不足，请充值");
    assert.equal(f.kind, "credit", "magpie：429 里明说余额花完了是 credit，不是限流");
    assert.equal(f.scope, "account");
  });

  test("①e 403 + 「unapproved channel」⇒ auth/客户端那一族，不判死", () => {
    const f = classifyFailure(403, "Illegal API invocation from an unapproved channel");
    assert.equal(f.kind, "auth");
    assert.equal(f.dead, false, "客户端被拒 ≠ 凭据失效");
    assert.equal(f.scope, "none", "magpie 的 failPrompt：谁也不休息");
    assert.equal(f.failover, true);
    assert.equal(shouldFailover(403, "unapproved channel"), true);
  });

  test("①f 429 + 限流 ⇒ rate（只休息那个模型）", () => {
    const f = classifyFailure(429, "Rate limit exceeded");
    assert.equal(f.kind, "rate");
    assert.equal(f.scope, "model", "magpie：限流常只限某个模型 ⇒ 只休息 restID");
    assert.equal(f.failover, true);
    const zh = classifyFailure(429, "请求过于频繁，请稍后");
    assert.equal(zh.kind, "rate");
    assert.equal(zh.scope, "model");
    assert.equal(classifyFailure(429, "限流").kind, "rate");
  });

  test("①g 401 + 明说凭据失效 ⇒ auth，判死整号", () => {
    const f = classifyFailure(401, '{"error":{"message":"Invalid API key"}}');
    assert.equal(f.kind, "auth");
    assert.equal(f.dead, true);
    assert.equal(f.scope, "account");
  });

  test("①h 401/403 但文案不认识 ⇒ 不判死（wb-pool 的硬规矩）", () => {
    const f = classifyFailure(403, "Forbidden");
    assert.equal(f.dead, false, "401/403 一律判死是错的：网络抖动也打 401");
    assert.equal(f.failover, true, "但仍要换一家试");
  });

  test("①i 模型不被这家服务 ⇒ unserved，只休息那个模型", () => {
    const a = classifyFailure(404, "The model gpt-9 does not exist");
    assert.equal(a.kind, "unserved");
    assert.equal(a.scope, "model", "magpie 的 restID 语义：不牵连整号");
    const b = classifyFailure(403, "model is not available in the current token plan");
    assert.equal(b.kind, "unserved");
    assert.equal(b.scope, "model");
    assert.equal(classifyFailure(400, "该模型不存在").kind, "unserved");
    assert.equal(shouldFailover(404, "The model gpt-9 does not exist"), true);
  });

  test("①i2 「Model is unavailable」⇒ unserved（zen 真回过这句话）", () => {
    /* 实测 zen 的上游回 "Upstream request failed: Model is unavailable."。
     * magpie 那张 unservedWords 表里没有它 → 落进「其它」→ 判成**不转移**
     * → 整条链断在第一家。zen-probe 与 wb-pool 都单独认了这句话，只有这里漏了。 */
    const a = classifyFailure(400, "Upstream request failed: Model is unavailable.");
    assert.equal(a.kind, "unserved", "这句话说的是「这个模型不被服务」，必须转移");
    assert.equal(a.scope, "model");
    assert.equal(a.failover, true);
    /* 但「临时不可用」不是「不服务这个模型」—— 不该按模型级休息处理 */
    const b = classifyFailure(503, "model is temporarily unavailable, please retry");
    assert.notEqual(b.kind, "unserved", "临时抖动不是「这家不服务这个模型」");
  });

  test("①j 5xx 与网络错 ⇒ other（上游自己的问题）", () => {
    assert.equal(classifyFailure(500, "internal error").kind, "other");
    assert.equal(classifyFailure(500, "internal error").failover, true);
    assert.equal(classifyFailure(0, "").kind, "other", "没拿到状态码 = 网络层失败");
    assert.equal(classifyFailure(0, "").failover, true);
  });

  test("①k 分类结果永远落在 KINDS 里", () => {
    const bodies = ["", "request illegal", "missing required field", "额度不足", "Rate limit exceeded",
      "Invalid API key", "model_not_found", "余额不足", "internal error"];
    for (const st of [0, 400, 401, 402, 403, 404, 422, 429, 500, 503]) {
      for (const b of bodies) {
        const f = classifyFailure(st, b);
        assert.ok(KINDS.includes(f.kind), `status=${st} body=${b} ⇒ ${f.kind}`);
        assert.ok(["account", "model", "none"].includes(f.scope));
      }
    }
  });
});

/* ====================================================================== *
 * ② 冷却时长（照抄 magpie 的表）
 * ====================================================================== */
describe("② 冷却时长", () => {
  test("②a quota 15 分钟、credit 30 分钟、auth 30 分钟", () => {
    assert.equal(cooldownFor("quota"), 15 * MIN);
    assert.equal(cooldownFor("credit"), 30 * MIN);
    assert.equal(cooldownFor("auth"), 30 * MIN);
  });

  test("②b content 不冷却（不休息任何人）", () => {
    assert.equal(cooldownFor("content"), 0);
  });

  test("②c rate 退避封顶 10 分钟", () => {
    assert.equal(cooldownFor("rate"), 1 * MIN);
    assert.equal(cooldownFor("rate", { failures: 2 }), 2 * MIN);
    assert.equal(cooldownFor("rate", { failures: 3 }), 4 * MIN);
    assert.equal(cooldownFor("rate", { failures: 4 }), 8 * MIN);
    assert.equal(cooldownFor("rate", { failures: 5 }), 10 * MIN, "封顶");
    assert.equal(cooldownFor("rate", { failures: 99 }), 10 * MIN, "封顶");
  });

  test("②d unserved / other 从 1 分钟起", () => {
    assert.equal(cooldownFor("unserved"), 1 * MIN);
    assert.equal(cooldownFor("other"), 1 * MIN);
  });
});

/* ====================================================================== *
 * ③ 两级休息：restKey 命中 vs 只有 restID 命中
 * ====================================================================== */
describe("③ 两级休息", () => {
  const acct = makeCandidate({ provider: "wb", account: "u1@example.com", model: "glm-5" });
  const sibling = makeCandidate({ provider: "wb", account: "u1@example.com", model: "glm-4" });
  const other = makeCandidate({ provider: "wb", account: "u2@example.com", model: "glm-5" });

  test("③a 休息键的形状：provider@user 与 provider@user/model", () => {
    assert.equal(acct.restKey, "wb@u1@example.com");
    assert.equal(acct.restId, "wb@u1@example.com/glm-5");
    assert.equal(restKeyOf({ provider: "zen" }), "zen");
    assert.equal(restIdOf({ provider: "zen", model: "gpt-5" }), "zen/gpt-5");
  });

  test("③b restKey 命中 ⇒ 这个账号的所有模型都休息", () => {
    const table = new RestTable();
    table.rest(acct.restKey, NOW + 60_000, { kind: "quota", scope: "account" });
    assert.equal(isResting(acct, table, NOW), true);
    assert.equal(isResting(sibling, table, NOW), true, "同账号的其它模型也休息");
    assert.equal(isResting(other, table, NOW), false, "别的账号不受影响");
  });

  test("③c 只有 restID 命中 ⇒ 只那个模型休息，同账号其它模型照常可用", () => {
    const table = new RestTable();
    table.rest(acct.restId, NOW + 60_000, { kind: "unserved", scope: "model" });
    assert.equal(isResting(acct, table, NOW), true, "那个模型在休息");
    assert.equal(isResting(sibling, table, NOW), false, "★ 同账号的其它模型照常可用");
    assert.equal(isResting(other, table, NOW), false);
  });

  test("③d 休息到期 ⇒ 自动恢复", () => {
    const table = new RestTable();
    table.rest(acct.restId, NOW + 60_000, { kind: "unserved", scope: "model" });
    assert.equal(isResting(acct, table, NOW), true);
    assert.equal(isResting(acct, table, NOW + 60_000), false, "到期即恢复");
    assert.equal(table.due(acct.restId, NOW + 60_000), true);
    assert.equal(table.sweep(NOW + 60_000), 1, "sweep 清掉过期条目");
  });

  test("③e pickCandidate 会跳过在休息的那个", () => {
    const table = new RestTable();
    table.rest(acct.restId, NOW + 60_000, { kind: "unserved", scope: "model" });
    const picked = pickCandidate([acct, sibling], table, NOW, Ordered);
    assert.equal(picked, sibling, "glm-4 没在休息，先用它");
    assert.equal(pickCandidate([acct], table, NOW, Ordered), null, "全都休息着就挑不出");
  });
});

/* ====================================================================== *
 * ④ 退避
 * ====================================================================== */
describe("④ 退避", () => {
  test("④a 连续失败 n 次 ⇒ 1m, 2m, 4m, 8m… 封顶 10m", () => {
    assert.equal(backoffFor(1), 1 * MIN);
    assert.equal(backoffFor(2), 2 * MIN);
    assert.equal(backoffFor(3), 4 * MIN);
    assert.equal(backoffFor(4), 8 * MIN);
    assert.equal(backoffFor(5), 10 * MIN, "16m 被 10m 封顶");
    assert.equal(backoffFor(6), 10 * MIN);
    assert.equal(backoffFor(50), 10 * MIN);
  });

  test("④b 休息表记着连续失败次数，成功应答要清零", () => {
    const table = new RestTable();
    assert.equal(table.bump("x"), 1);
    assert.equal(table.bump("x"), 2);
    assert.equal(table.count("x"), 2);
    table.forget("x");
    assert.equal(table.count("x"), 0, "候选成功应答 ⇒ 不是「连续」失败");
  });
});

/* ====================================================================== *
 * ⑤ Retry-After
 * ====================================================================== */
describe("⑤ Retry-After", () => {
  test("⑤a 说了就按它来（抬高退避）", () => {
    const f = classifyFailure(429, "", { headers: { "retry-after": "300" } });
    assert.equal(f.retryAfterMs, 5 * MIN);
    assert.equal(cooldownFor("rate", { retryAfterMs: f.retryAfterMs }), 5 * MIN);
    assert.equal(cooldownFor("quota", { retryAfterMs: 60 * MIN }), 60 * MIN, "上游说要等更久就照办");
  });

  test("⑤b 超过 1 小时不可信 ⇒ 截断", () => {
    const f = classifyFailure(429, "", { headers: { "retry-after": "7200" } });
    assert.equal(f.retryAfterMs, 60 * MIN, "magpie 的 longestWait：1 小时封顶");
    assert.equal(cooldownFor("rate", { retryAfterMs: 2 * 60 * MIN }), 60 * MIN);
  });

  test("⑤c quota 的 15 分钟底线不被压低（额度等多久都不会好）", () => {
    assert.equal(cooldownFor("quota", { retryAfterMs: 30 * 1000 }), 15 * MIN);
    assert.equal(cooldownFor("quota"), 15 * MIN);
  });

  test("⑤d 没有 Retry-After 就是 null（不是 0）", () => {
    const f = classifyFailure(429, "too many requests");
    assert.equal(f.retryAfterMs, null);
  });
});

/* ====================================================================== *
 * ⑥ failover.mjs 的旧行为一字不变
 * ====================================================================== */
describe("⑥ failover.mjs 旧行为一字不变", () => {
  test("⑥a 没有响应体时，只看状态码的老结论逐字不变", () => {
    assert.equal(shouldFailover(400), false, "普通 400 是请求本身有问题，不该转移");
    assert.equal(shouldFailover(404), false);
    assert.equal(shouldFailover(422), false);
    assert.equal(shouldFailover(400, ""), false, "空正文＝没明说理由，不该转移");
    assert.equal(shouldFailover(429), true, "限流要转移");
    assert.equal(shouldFailover(401), true);
    assert.equal(shouldFailover(403), true);
    assert.equal(shouldFailover(500), true);
    assert.equal(shouldFailover(502), true);
    assert.equal(shouldFailover(0), true, "网络错/超时（还没拿到状态码）");
    assert.equal(shouldFailover(200), false);
  });

  test("⑥b providerRefusal 还是那个 providerRefusal", () => {
    assert.equal(providerRefusal("request illegal"), true);
    assert.equal(providerRefusal(""), false);
    assert.equal(providerRefusal(undefined), false);
    assert.equal(providerRefusal("missing required field"), false);
  });

  test("⑥c 两档冷却常量没动", () => {
    assert.equal(FAILOVER_COOLDOWN_MS, 90 * 1000);
    assert.equal(FAILOVER_QUOTA_COOLDOWN_MS, 30 * 60 * 1000);
  });

  test("⑥d failoverCooldown 的 90s / 30min 语义没动", () => {
    failoverClear("旧判据-p");
    failoverCooldown("旧判据-p", "boom");
    assert.equal(failoverAvailable("旧判据-p"), false, "冷却中");
    assert.equal(failoverQuotaBlocked("旧判据-p"), false, "这不是额度失败");
    failoverClear("旧判据-p");
    assert.equal(failoverAvailable("旧判据-p"), true, "清冷却后恢复");

    failoverClear("旧判据-q");
    failoverCooldown("旧判据-q", "no credit", { quota: true });
    assert.equal(failoverQuotaBlocked("旧判据-q"), true, "额度失败会让入口也让位");
    const snap = failoverSnapshot();
    assert.ok(snap["旧判据-q"], "快照里有它");
    assert.equal(snap["旧判据-q"].quota, true);
    failoverClear("旧判据-q");
  });

  test("⑥e 新增的账号级能力不影响旧的那套", () => {
    const before = failoverAvailable("旧判据-z");
    failoverCooldownFor("wb@新", "wb@新/glm-5", "quota", { now: NOW });
    assert.equal(failoverAvailable("旧判据-z"), before, "旧的 provider 级状态原样");
    assert.equal(failoverAvailable("wb@新"), true, "账号级休息写在另一张表里");
    assert.equal(restTable().has("wb@新"), true);
    restTable().clear();
  });
});

/* ====================================================================== *
 * ⑦ 新增的账号级冷却落点
 * ====================================================================== */
describe("⑦ failoverCooldownFor —— 写在哪一层", () => {
  test("⑦a account 作用域 ⇒ 写 restKey（整号休息）", () => {
    const t = restTable();
    t.clear();
    const r = failoverCooldownFor("wb@a1", "wb@a1/glm-5", "quota", { now: NOW, why: "额度用尽" });
    assert.equal(r.rested, true);
    assert.equal(r.id, "wb@a1");
    assert.equal(r.durationMs, 15 * MIN);
    assert.equal(t.has("wb@a1"), true);
    assert.equal(t.has("wb@a1/glm-5"), false, "整号休息不写模型级");
    t.clear();
  });

  test("⑦b model 作用域 ⇒ 写 restID（只那个模型休息）", () => {
    const t = restTable();
    t.clear();
    const r = failoverCooldownFor("wb@a2", "wb@a2/glm-5", "unserved", { now: NOW, scope: "model" });
    assert.equal(r.id, "wb@a2/glm-5");
    assert.equal(t.has("wb@a2"), false, "整号没休息");
    assert.equal(t.has("wb@a2/glm-5"), true);
    t.clear();
  });

  test("⑦c content 作用域 ⇒ 谁也不休息", () => {
    const t = restTable();
    t.clear();
    const r = failoverCooldownFor("wb@a3", "wb@a3/glm-5", "content", { now: NOW });
    assert.equal(r.rested, false);
    assert.equal(t.has("wb@a3"), false);
    assert.equal(t.has("wb@a3/glm-5"), false);
    t.clear();
  });

  test("⑦d 连续失败会退避", () => {
    const t = restTable();
    t.clear();
    const a = failoverCooldownFor("wb@a4", "wb@a4/glm-5", "other", { now: NOW });
    const b = failoverCooldownFor("wb@a4", "wb@a4/glm-5", "other", { now: NOW });
    assert.equal(a.durationMs, 1 * MIN);
    assert.equal(b.durationMs, 2 * MIN, "第二次失败 ⇒ 2 分钟");
    t.clear();
  });
});

/* ====================================================================== *
 * ⑧ 候选排序
 * ====================================================================== */
describe("⑧ 候选排序与挑选", () => {
  test("⑧a orderCandidates 用策略给的顺序", () => {
    const a = makeCandidate({ provider: "p", model: "m1" });
    const b = makeCandidate({ provider: "p", model: "m2" });
    const seat = (used) => ({
      key: "p", used, soon: [], weight: 1, resting: false, free: false,
      known: true, learns: false, account: false, pace: 0, tokens: 0,
    });
    // Smart 的分档：98 以上算「几乎用尽」，90-98 算「偏低」，其余算「还有余量」，
    // 顺序是 还有余量 → 偏低 → 几乎用尽。
    const ordered = orderCandidates([a, b], [seat(99), seat(95)], Smart, NOW);
    assert.equal(ordered.length, 2);
    assert.equal(ordered[0], b, "Smart：偏低的先于几乎用尽的");
    assert.equal(orderCandidates([a, b], [seat(99), seat(95)], Ordered, NOW)[0], a, "Ordered：原序");
  });

  test("⑧b 策略坏了 ⇒ 退回原序（失败开放，绝不漏掉一条路由）", () => {
    const a = makeCandidate({ provider: "p", model: "m1" });
    const b = makeCandidate({ provider: "p", model: "m2" });
    const broken = { order: () => { throw new Error("策略坏了"); } };
    const ordered = orderCandidates([a, b], null, broken, NOW);
    assert.deepEqual(ordered, [a, b], "退回原序");
    const badShape = { order: () => [0, 0] };
    assert.deepEqual(orderCandidates([a, b], null, badShape, NOW), [a, b]);
  });
});

test("⑩ 休息表有**容量上限**（键里含客户端可控的模型名）", () => {
  /* 网关模式下模型段是客户端送来的字面模型 → 休息表的键含它。
   * 不设上限的话，发一堆随机模型名就能让这张表无限增长。 */
  const table = new RestTable();
  for (let i = 0; i < 1200; i++) table.rest(`wb/随机模型-${i}`, NOW + 60000, { kind: "other" });
  assert.ok(table.entries().length <= 500, `表里塞了 ${table.entries().length} 条，没有上限`);
  assert.ok(table.entries().length > 0, "上限不该把表清空");
  /* 失败计数那张表同样要封顶 */
  for (let i = 0; i < 1200; i++) table.bump(`wb/随机模型-${i}`);
  assert.ok(table.count(`wb/随机模型-1199`) <= 1, "计数不该无限增长");
});

/* ====================================================================== *
 * ⑨ 反向对照：把「模型级 vs 账号级」的区分改坏，③ 必须红
 * ====================================================================== */
describe("⑨ 反向对照 —— 改坏两级休息，③ 必须红", () => {
  test("⑨a 退化成「只有账号级」⇒ ③c 会红", () => {
    const acct = makeCandidate({ provider: "wb", account: "u1@example.com", model: "glm-5" });
    const sibling = makeCandidate({ provider: "wb", account: "u1@example.com", model: "glm-4" });
    const table = new RestTable();
    table.rest(acct.restId, NOW + 60_000, { kind: "unserved", scope: "model" });

    // 正确实现：只休息那个模型，同号其它模型照常可用。
    assert.equal(isResting(acct, table, NOW), true);
    assert.equal(isResting(sibling, table, NOW), false);

    // 模拟「实现退化成只有账号级」：只看 restKey，忽略 restID。
    // 它认不出模型级休息 ⇒ 那个本该休息的模型会被继续选中 ⇒ ③c 的第一条断言会红。
    const brokenIsResting = (c) => table.has(c.restKey) && !table.due(c.restKey, NOW);
    assert.equal(brokenIsResting(acct), false, "退化实现认不出模型级休息");
    assert.notEqual(isResting(acct, table, NOW), brokenIsResting(acct),
      "两种实现必须给出不同结论，否则 ③c 这条判据等于没写");
    // 正确实现挑的是没在休息的那个；退化实现会把 acct 也当成可用。
    assert.equal(pickCandidate([acct, sibling], table, NOW, Ordered), sibling);
  });

  test("⑨b 退化成「只有模型级」⇒ ③b 会红", () => {
    const acct = makeCandidate({ provider: "wb", account: "u1@example.com", model: "glm-5" });
    const sibling = makeCandidate({ provider: "wb", account: "u1@example.com", model: "glm-4" });
    const table = new RestTable();
    table.rest(acct.restKey, NOW + 60_000, { kind: "quota", scope: "account" });

    // 正确实现：整号休息 ⇒ 所有模型都停。
    assert.equal(isResting(acct, table, NOW), true);
    assert.equal(isResting(sibling, table, NOW), true);

    // 模拟「实现退化成只有模型级」：只看 restID，忽略 restKey。
    const brokenIsResting = (c) => table.has(c.restId) && !table.due(c.restId, NOW);
    assert.equal(brokenIsResting(sibling), false, "退化实现看不出整号休息 ⇒ ③b 第二条断言会红");
    assert.notEqual(isResting(sibling, table, NOW), brokenIsResting(sibling),
      "两种实现必须给出不同结论，否则 ③b 这条判据等于没写");
  });
});
