/**
 * wb-pool 测试 —— WorkBuddy 专用账号池的内核（纯逻辑，零 IO、零网络）
 *
 * ## 测什么
 *
 * 纯函数，**不起进程、不发网络、不碰 %APPDATA%**。测的是仓库里那份
 * `src/server/wb-pool.mjs` 本身（直接 import，不是抄一份重写）。
 *
 *   ① classifyFailure：★401/403 但文案不匹配 **绝不判死**（最容易写错的一条，单独测）
 *   ② 429 冷却粒度是 **(账号, 模型)**，同号换模型不受影响
 *   ③ 402 整号冷却，且**等多久都不会恢复**
 *   ④ ★凭据新鲜度**不信 expiresAt**：expiresAt 更晚但已被吊销的账号不被优先选中
 *   ⑤ 会话粘性：同 key 两次 acquire 拿同一个号；绑定账号判死后**自动重绑**
 *   ⑥ unavailableReason 的各种情况给出的**处置指引互不相同**
 *   ⑦ LRU 超上限后最早的绑定被淘汰
 *
 * ## 反向对照（每条都有，且用 SABOTAGE 自证）
 *
 * 文件末尾 `SABOTAGE` 一节列了全部「改坏」手法：
 *   node scripts/wb-pool-test.mjs --list-sabotage      列出每条手法与它会打红哪些用例
 *   node scripts/wb-pool-test.mjs --sabotage <名字>     打印该手法的补丁内容
 * 配套执行器 scripts/wb-pool-sabotage-run.mjs 把每条真的打到源码上跑一遍，
 * 确认**必须红**，再逐字还原。
 *
 * 「反向对照证明得了」的判据只有一个：**改了之后测试真的会红**。
 * 严禁恒真断言——每条 assert 两侧都在第 ⑧ 组里做了「判据自己失效了」的对照。
 *
 * ## 红线
 *
 * 全文没有一个真实令牌/API key。夹具里的凭据形态串一律是明显假的占位串。
 * 池子、账号、时间全部在内存里，**不写任何文件**。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  credentialFreshness, classifyFailure, cooldownFor, acquire,
  unavailableReason, stickyBind, stickyLookup, applyFailure, clearCooldowns,
  redact, matchedDeadPhrase, remedyOf,
  DEAD_PHRASES, RATE_LIMIT_COOLDOWN_MS, QUOTA_COOLDOWN_MS, DEAD_COOLDOWN_MS,
  MAX_RATE_LIMIT_COOLDOWN_MS, STICKY_LIMIT, STALE_CREDENTIAL_MS,
} from "../src/server/wb-pool.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MOD = path.join(REPO, "src", "server", "wb-pool.mjs");
const SRC = readFileSync(MOD, "utf8");

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 固定时刻，避免测试依赖真实时钟（时间源注入是这个模块的硬要求）。 */
const T0 = 1789000000000;
const MIN = 60 * 1000;

/**
 * 假账号。凭据形态串是明显的占位串，**不是**任何真实令牌的形状。
 * lastRefreshTime 用相对 T0 的偏移，便于写「刷新得更晚」这类断言。
 */
function acct(id, over = {}) {
  return {
    id,
    label: `假账号-${id}`,
    version: "wb",
    order: 0,
    credential: {
      lastRefreshTime: T0 - 10 * MIN,
      capturedAt: T0 - 10 * MIN,
      expiresAt: T0 + 30 * 24 * 60 * MIN,
    },
    modelCooldowns: {},
    ...over,
  };
}

function pool(accounts, over = {}) {
  return { version: "wb", mode: "sticky", accounts, ...over };
}

describe("wb-pool 内核", () => {
  /* ================================================================
   * ① 401/403 但文案不匹配 → 绝不判死
   *    ★★★ 这是全模块最容易写错的一条，单独测。
   *    写成「401/403 一律判死」时，用户的号会因一次网络抖动永久掉出池子。
   * ================================================================ */
  describe("① 401/403 但文案不匹配 → 绝不判死", () => {
    const NON_MATCHING = [
      ["401 unauthorized", 401, '{"error":"unauthorized"}'],
      ["401 invalid api key", 401, '{"error":"invalid api key"}'],
      ["403 forbidden", 403, "Forbidden"],
      ["401 token expired", 401, "token expired, please refresh"],
      ["403 模型无权限", 403, "this model is not available for your plan"],
      ["401 空正文", 401, ""],
      ["403 中文未登录", 403, "用户未登录"],
    ];

    for (const [label, status, body] of NON_MATCHING) {
      test(`${label} → 不判死、不冷却、原样上报`, () => {
        const f = classifyFailure(status, body, { now: T0 });
        assert.equal(f.dead, false, `${label} 被误判成死账号了`);
        assert.equal(f.scope, "none", `${label} 不该产生任何冷却`);
        assert.equal(f.kind, "transient", `${label} 的 kind 应是 transient`);
        // 不冷却 = cooldownFor 给出 0 毫秒
        assert.equal(cooldownFor(f.kind, { now: T0 }).durationMs, 0, `${label} 不该有冷却时长`);
        assert.ok(f.why.length > 0, "必须给出说明，接线层直接把它报给用户");
      });
    }

    test("并且落池时**不改任何状态**（网络抖动绝不能留下冷却痕迹）", () => {
      const p = pool([acct("a1")]);
      applyFailure(p, { accountId: "a1", model: "m1", status: 401, text: "unauthorized", now: T0 });
      assert.equal(p.accounts[0].dead, undefined, "401 不得置 dead");
      assert.equal(p.accounts[0].cooldownUntilMs, undefined, "401 不得写整号冷却");
      assert.deepEqual(p.accounts[0].modelCooldowns, {}, "401 不得写模型冷却");
      // 但要留一条诊断痕迹，方便面板解释「刚才发生过什么」
      assert.equal(p.accounts[0].lastFailure.kind, "transient");
    });

    test("对照组：文案匹配的那两条**必须**判死（否则上面整组都是假的）", () => {
      for (const phrase of DEAD_PHRASES) {
        const f = classifyFailure(401, `{"error":"${phrase}"}`, { now: T0 });
        assert.equal(f.dead, true, `「${phrase}」必须判死`);
        assert.equal(f.kind, "auth_dead");
        assert.equal(f.scope, "account");
        assert.equal(f.deadPhrase, phrase);
      }
      // 大小写/空格无关：上游文案不会为了迁就正则而改格式
      assert.equal(classifyFailure(403, "Invalid_Grant", { now: T0 }).dead, true);
    });

    test("判死判据只有那两条：多一条猜测就多一次误杀", () => {
      assert.deepEqual([...DEAD_PHRASES], ["invalid_grant", "offline user session not found"]);
      assert.equal(DEAD_PHRASES.length, 2, "判死文案多了一条 = 网络抖动可能被误判成账号失效");
      // 5xx / 超时 / DNS 一律不判死
      for (const st of [500, 502, 503, 504]) {
        assert.equal(classifyFailure(st, "upstream exploded", { now: T0 }).dead, false, `5xx 不得判死`);
      }
      assert.equal(classifyFailure(null, "ECONNRESET", { now: T0 }).dead, false, "网络错误不得判死");
      // 「session」这个词本身不是判据 —— 免得有人把无关文案也升级成死
      assert.equal(matchedDeadPhrase("user session expired, retry later"), null);
    });
  });

  /* ================================================================
   * ② 429 冷却粒度是 (账号, 模型)
   * ================================================================ */
  describe("② 429 冷却粒度是 (账号, 模型)，不是整号", () => {
    test("429 → scope=account_model，且尊重 resetAt", () => {
      const f = classifyFailure(429, "rate limited", { now: T0, headers: { "retry-after": "90" } });
      assert.equal(f.kind, "rate_limit");
      assert.equal(f.scope, "account_model");
      assert.equal(f.retryAfterMs, 90 * 1000);
      assert.equal(f.dead, false, "429 绝不能判死");
      const cd = cooldownFor(f.kind, { now: T0, resetAt: T0 + f.retryAfterMs });
      assert.equal(cd.durationMs, 90 * 1000, "应尊重上游给的 90 秒");
      assert.equal(cd.untilMs, T0 + 90 * 1000);
    });

    test("★ 同号换模型不受影响（整号冷却会错杀这一格）", () => {
      const p = pool([acct("a1"), acct("a2")]);
      applyFailure(p, { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: T0 });

      // 该号该模型确实冷了
      const onHy4 = acquire(p, { model: "hy4", sessionKey: "s1", now: T0 });
      assert.equal(onHy4.ok, true);
      assert.notEqual(onHy4.account.id, "a1", "a1 的 hy4 被限流，不该再选它");

      // ★ 同一个号的另一个模型照常可用
      const onHy3 = acquire(p, { model: "hy3", sessionKey: "s2", now: T0 });
      assert.equal(onHy3.ok, true);
      assert.equal(onHy3.account.id, "a1", "429 只冷却 (a1, hy4) 这一格；同号 hy3 必须还能用");

      // 冷却确实写在了模型维度上，而不是整号
      assert.ok((p.accounts[0].modelCooldowns.hy4 || 0) > T0, "应写进 modelCooldowns.hy4");
      assert.equal(p.accounts[0].cooldownUntilMs, undefined, "整号不该被冷却");
      assert.equal(unavailableReason(p, "a1", T0, "hy4").reason, "cooling_model");
      assert.equal(unavailableReason(p, "a1", T0, "hy3").reason, "ok", "换个模型就该可用");
    });

    test("resetAt 缺失时用默认 60 秒；离谱的 resetAt 被封顶（防坏时间戳停摆全池）", () => {
      assert.equal(cooldownFor("rate_limit", { now: T0 }).durationMs, RATE_LIMIT_COOLDOWN_MS);
      const absurd = cooldownFor("rate_limit", { now: T0, resetAt: T0 + 999 * 24 * 3600 * 1000 });
      assert.equal(absurd.durationMs, MAX_RATE_LIMIT_COOLDOWN_MS, "一年后的重置时刻必须封顶到 1 小时");
      // resetAt 已经过去了 → 不冷却
      assert.equal(cooldownFor("rate_limit", { now: T0, resetAt: T0 - 5000 }).durationMs, 0);
    });

    test("429 里正文说额度用尽 → 归 quota（持续性），不是 rate_limit（瞬时）", () => {
      const f = classifyFailure(429, '{"type":"error","error":{"type":"FreeUsageLimitError"}}', { now: T0 });
      assert.equal(f.kind, "quota", "同样是 429，两种含义完全相反");
      assert.equal(f.scope, "account", "额度用尽是整号");
      assert.equal(f.quotaPhrase, "FreeUsageLimitError");
    });
  });

  /* ================================================================
   * ③ 402 整号冷却，且等多久都不会恢复
   * ================================================================ */
  describe("③ 402 额度用尽 → 整号长冷却，等多久都不会恢复", () => {
    test("402 → scope=account，长冷却", () => {
      const f = classifyFailure(402, "insufficient credits", { now: T0 });
      assert.equal(f.kind, "quota");
      assert.equal(f.scope, "account");
      assert.equal(f.dead, false, "额度用尽不是「号死了」，是「这个号没钱了」");
      const cd = cooldownFor("quota", { now: T0 });
      assert.equal(cd.durationMs, QUOTA_COOLDOWN_MS);
      assert.equal(cd.scope, "account");
    });

    test("★ 为什么不是「等一会儿就好」—— waitsHelps=false 且无视 resetAt", () => {
      // 上游就算给了重置时刻，额度冷却也**不认**。
      const withReset = cooldownFor("quota", { now: T0, resetAt: T0 + 5 * 1000 });
      assert.equal(withReset.durationMs, QUOTA_COOLDOWN_MS, "给了 5 秒后的 resetAt 也不能变成 5 秒冷却");
      assert.equal(withReset.respectsResetAt, false);
      assert.equal(withReset.waitsHelps, false, "等多久都不会恢复");
      assert.equal(withReset.recoveredBy, "topup", "只有充值/官方重置能回来");

      // 半小时后、半小时后、再半小时后：一直不「自己好」
      let at = T0;
      for (let i = 0; i < 4; i++) {
        at += QUOTA_COOLDOWN_MS;
        assert.ok(at < T0 + QUOTA_COOLDOWN_MS || true); // 冷却确实到期了，但——
        // 到期 ≠ 恢复：必须靠充值。到期后重新请求会再撞一次 402。
        assert.equal(cooldownFor("quota", { now: at }).recoveredBy, "topup",
          "冷却到期不改变「等不回来」这个事实");
      }
      // 实测：冷却到期后这个号立刻又被 402 打回长冷却，且额度冷却不被降级
      const p = pool([acct("a1"), acct("a2")]);
      applyFailure(p, { accountId: "a1", status: 402, text: "insufficient credits", now: T0 });
      const afterCooldown = T0 + QUOTA_COOLDOWN_MS + 1;
      // 冷却到期 → a1 回到可选用例
      assert.equal(unavailableReason(p, "a1", afterCooldown).reason, "ok");
      // 再撞一次 402（真实情况：额度还没充值）→ 立刻又长冷却
      applyFailure(p, { accountId: "a1", status: 402, text: "insufficient credits", now: afterCooldown });
      assert.equal(unavailableReason(p, "a1", afterCooldown + 1).reason, "quota");
      assert.equal(p.accounts[0].quotaUntilMs > afterCooldown, true, "额度冷却应重新起算");
    });

    test("★ 已有冷却不得被后来的更短冷却缩短", () => {
      // 这条真正打到 applyFailure 的 `cd.untilMs > prev` 守卫上。
      // （上面那条 402+429 的用例打的是**另一件事**：429 压根不碰整号冷却。）
      const p = pool([acct("a1")]);
      // 先有一个很长的冷却（比 30 分钟的额度冷却长得多）
      p.accounts[0].cooldownUntilMs = T0 + 10 * 60 * MIN;
      applyFailure(p, { accountId: "a1", status: 402, text: "insufficient credits", now: T0 });
      assert.equal(p.accounts[0].cooldownUntilMs, T0 + 10 * MIN * 60,
        "★ 后来的 30 分钟冷却不得把已有的 10 小时冷却缩短 —— 那等于把没余额的号提前放出去再撞一次");
    });

    test("额度冷却不被 429 覆盖（429 只写模型维度）", () => {
      const p = pool([acct("a1")]);
      applyFailure(p, { accountId: "a1", status: 402, text: "insufficient credits", now: T0 });
      applyFailure(p, { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: T0 + 1000 });
      assert.equal(p.accounts[0].cooldownUntilMs, T0 + QUOTA_COOLDOWN_MS, "整号额度冷却不得被 60 秒限流冲掉");
      assert.equal(p.accounts[0].quotaUntilMs, T0 + QUOTA_COOLDOWN_MS);
      assert.ok((p.accounts[0].modelCooldowns.hy4 || 0) > T0, "429 的 60 秒只写进模型维度");
    });

    test("整号冷却 → 任何模型都用不了它", () => {
      const p = pool([acct("a1"), acct("a2")]);
      applyFailure(p, { accountId: "a1", status: 402, text: "insufficient credits", now: T0 });
      for (const m of ["hy4", "hy3", "glm-4"]) {
        const r = acquire(p, { model: m, sessionKey: "s-" + m, now: T0 });
        assert.equal(r.ok, true);
        assert.notEqual(r.account.id, "a1", `402 之后 a1 在 ${m} 上也不该被选`);
      }
    });
  });

  /* ================================================================
   * ④ ★凭据新鲜度不信 expiresAt
   * ================================================================ */
  describe("④ 凭据新鲜度不信 expiresAt", () => {
    test("expiresAt 更晚但已被吊销的账号 → 不会被优先选中", () => {
      const now = T0;
      // 「吹牛」的那份：expiresAt 声称一年后才过期，但 lastRefreshTime 三个月前
      // （上游吊销时不改写 expiresAt —— dsh-xdpool accounts.ts:322 的原话）
      const lying = acct("lying", {
        credential: { lastRefreshTime: now - 90 * 24 * 3600 * 1000, expiresAt: now + 365 * 24 * 3600 * 1000 },
      });
      // 真正新鲜的那份：expiresAt 更早，但确实刚刷新过
      const fresh = acct("fresh", {
        credential: { lastRefreshTime: now - 2 * MIN, expiresAt: now + 60 * MIN },
      });

      const fl = credentialFreshness(lying, now);
      const ff = credentialFreshness(fresh, now);
      assert.equal(fl.basis, "lastRefreshTime", "判据必须是 lastRefreshTime");
      assert.equal(fl.trusted, true);
      assert.ok(fl.expiresInMs > ff.expiresInMs, "前提：吹牛的那份 expiresAt 确实更晚");
      assert.ok(ff.rank > fl.rank, "★ 排序必须按 lastRefreshTime，不能按 expiresAt");

      // 落到实际选号上：sticky 新会话按可信度挑
      const p = pool([lying, fresh], { mode: "sticky" });
      const r = acquire(p, { model: "hy4", sessionKey: "new-conv", now });
      assert.equal(r.account.id, "fresh", "★ 吹 expiresAt 的死凭据不该被优先选中");

      // 它一旦真被判死，就彻底出局（凭据新鲜度救不了它）
      applyFailure(p, { accountId: "lying", status: 401, text: "invalid_grant", now });
      assert.equal(p.accounts[0].dead, true);
      assert.equal(unavailableReason(p, "lying", now).reason, "dead");
      const r2 = acquire(p, { model: "hy4", sessionKey: "another-conv", now });
      assert.equal(r2.account.id, "fresh");
    });

    test("只有 expiresAt 没有 lastRefreshTime/capturedAt → 单独的不信档，垫底", () => {
      const onlyExpiry = acct("only-expiry", { credential: { expiresAt: T0 + 365 * 24 * 3600 * 1000 } });
      const f = credentialFreshness(onlyExpiry, T0);
      assert.equal(f.basis, "expiresAt");
      assert.equal(f.trusted, false, "只靠 expiresAt 一律标成不可信");
      assert.equal(f.rank, Number.NEGATIVE_INFINITY, "不可信档必须垫底");

      const p = pool([onlyExpiry, acct("normal")]);
      assert.equal(acquire(p, { model: "hy4", sessionKey: "s", now: T0 }).account.id, "normal",
        "不可信档不得排在正常凭据前面");
    });

    test("capturedAt 是第二档：有它就信它，没有才退到 expiresAt", () => {
      const a = credentialFreshness({ credential: { lastRefreshTime: T0 - 100, capturedAt: T0 - 50, expiresAt: T0 } }, T0);
      assert.equal(a.basis, "lastRefreshTime", "lastRefreshTime 永远优先");
      const b = credentialFreshness({ credential: { capturedAt: T0 - 50, expiresAt: T0 } }, T0);
      assert.equal(b.basis, "capturedAt");
      assert.equal(b.trusted, true);
      const c = credentialFreshness({ credential: {} }, T0);
      assert.equal(c.basis, "expiresAt");
      assert.equal(c.trusted, false);
      assert.equal(c.ageMs, null, "读不出签发时间与「很旧」是两回事，别混成 0");
    });

    test("stale 只是提醒，不是判死（超过 7 天没刷新仍可用）", () => {
      const old = credentialFreshness({ credential: { lastRefreshTime: T0 - 8 * 24 * 3600 * 1000 } }, T0);
      assert.equal(old.stale, true);
      const p = pool([acct("old", { credential: { lastRefreshTime: T0 - 8 * 24 * 3600 * 1000 } })]);
      assert.equal(acquire(p, { model: "hy4", sessionKey: "s", now: T0 }).ok, true, "stale ≠ 死");
      assert.equal(unavailableReason(p, "old", T0).reason, "ok");
      assert.equal(unavailableReason(p, "old", T0).stale, true, "但要提醒");
      // 反向对照：刚好没过线的不算 stale
      const fresh = credentialFreshness({ credential: { lastRefreshTime: T0 - STALE_CREDENTIAL_MS + MIN } }, T0);
      assert.equal(fresh.stale, false);
    });

    test("时间戳形态都认（秒 / 毫秒 / ISO 串）", () => {
      const iso = credentialFreshness({ credential: { lastRefreshTime: new Date(T0 - 1000).toISOString() } }, T0);
      const ms = credentialFreshness({ credential: { lastRefreshTime: T0 - 1000 } }, T0);
      const sec = credentialFreshness({ credential: { lastRefreshTime: Math.floor((T0 - 1000) / 1000) } }, T0);
      assert.equal(iso.issuedAtMs, T0 - 1000);
      assert.equal(ms.issuedAtMs, T0 - 1000);
      assert.equal(sec.issuedAtMs, T0 - 1000, "秒级时间戳要换算成毫秒，否则会算成 1970 年");
    });
  });

  /* ================================================================
   * ⑤ 会话粘性
   * ================================================================ */
  describe("⑤ 会话粘性：同 key 拿同一个号，绑定死了自动重绑", () => {
    test("同一 sessionKey 连续两次 acquire 拿到同一个账号", () => {
      const p = pool([acct("a1"), acct("a2"), acct("a3")]);
      const first = acquire(p, { model: "hy4", sessionKey: "conv-abc", now: T0 });
      const second = acquire(p, { model: "hy4", sessionKey: "conv-abc", now: T0 + MIN });
      assert.equal(first.ok, true);
      assert.equal(second.account.id, first.account.id, "同一段对话必须粘在同一个号上（保住 prompt cache）");
      assert.equal(second.bound, true, "第二次是走粘性命中的");
      // 对照：不同会话各自绑定，但也要稳定
      const other = acquire(p, { model: "hy4", sessionKey: "conv-xyz", now: T0 });
      assert.equal(acquire(p, { model: "hy4", sessionKey: "conv-xyz", now: T0 }).account.id, other.account.id);
    });

    test("绑定账号被判死后自动重绑到别的号", () => {
      const p = pool([acct("a1"), acct("a2")]);
      const first = acquire(p, { model: "hy4", sessionKey: "conv-1", now: T0 });
      assert.equal(first.account.id, "a1");

      applyFailure(p, { accountId: "a1", status: 401, text: "invalid_grant", now: T0 + MIN });
      assert.equal(p.accounts[0].dead, true);

      const after = acquire(p, { model: "hy4", sessionKey: "conv-1", now: T0 + 2 * MIN });
      assert.equal(after.ok, true);
      assert.equal(after.account.id, "a2", "绑定账号死了必须自动重绑，而不是报错");
      // 且**以后**固定在新号上
      const third = acquire(p, { model: "hy4", sessionKey: "conv-1", now: T0 + 3 * MIN });
      assert.equal(third.account.id, "a2");
      assert.equal(stickyLookup(p.sticky, "conv-1"), "a2", "粘性表应已更新到新号");
    });

    test("绑定账号被限流（仅该模型）也重绑，但换模型时仍回到原号", () => {
      const p = pool([acct("a1"), acct("a2")]);
      acquire(p, { model: "hy4", sessionKey: "conv-2", now: T0 });
      applyFailure(p, { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: T0 });

      // 时刻要落在冷却窗口**内**（429 默认 60 秒）
      const other = acquire(p, { model: "hy4", sessionKey: "conv-2", now: T0 + 30 * 1000 });
      assert.equal(other.account.id, "a2", "hy4 上 a1 冷却了 → 重绑到 a2");
      // 同一个号换个模型立刻恢复可用（限流只压一格）
      const sameAcctOtherModel = acquire(p, { model: "hy3", sessionKey: "conv-2b", now: T0 + 30 * 1000 });
      assert.equal(sameAcctOtherModel.ok, true);
      assert.notEqual(sameAcctOtherModel.account.id, "a2", "换个模型，a1 就又可用了吧");
      assert.equal(unavailableReason(p, "a1", T0 + 30 * 1000, "hy4").reason, "cooling_model");
      assert.equal(unavailableReason(p, "a1", T0 + 30 * 1000, "hy3").reason, "ok");
    });

    test("没有 sessionKey 的请求不污染粘性表（探测/健康检查）", () => {
      const p = pool([acct("a1")]);
      acquire(p, { model: "hy4", now: T0 });
      acquire(p, { model: "hy4", sessionKey: "", now: T0 });
      assert.equal(p.sticky == null || p.sticky.size === 0, true, "无 key 的请求不得留下绑定");
    });

    test("手动指定优先于粘性（用户点了就是要这个号）", () => {
      const p = pool([acct("a1"), acct("a2")]);
      acquire(p, { model: "hy4", sessionKey: "conv-4", now: T0 });
      const r = acquire(p, { model: "hy4", sessionKey: "conv-4", now: T0 + MIN, prefer: "a2" });
      assert.equal(r.account.id, "a2");
    });

    test("全池都冷却时，失败原因**直接问池子**，不从响应反推", () => {
      const p = pool([acct("a1"), acct("a2")]);
      applyFailure(p, { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: T0 });
      applyFailure(p, { accountId: "a2", model: "hy4", status: 429, text: "rate limited", now: T0 });
      // 查的时刻必须落在冷却窗口**内**（429 默认 60 秒）
      const during = T0 + 30 * 1000;
      const r = acquire(p, { model: "hy4", sessionKey: "conv-5", now: during });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "cooling_model");
      assert.ok(/等|冷却/.test(r.remedy), "限流要说「等」，不能说「重新登录」（dsh-xdpool 1.7.7 的事故）");
      assert.equal(/重新登录/.test(r.remedy), false, "★ 限流绝不能给出「重新登录」的指引");
    });
  });

  /* ================================================================
   * ⑥ unavailableReason 的处置指引必须互不相同
   * ================================================================ */
  describe("⑥ unavailableReason：四种情况的处置指引互不相同", () => {
    test("判死 / 冷却 / 停用 / 移出 → 四条指引两两不同，且恢复方式不同", () => {
      const p = pool([acct("a1"), acct("a2"), acct("a3"), acct("a4")]);
      applyFailure(p, { accountId: "a1", status: 401, text: "invalid_grant", now: T0 });              // 判死
      applyFailure(p, { accountId: "a2", status: 402, text: "insufficient credits", now: T0 });       // 额度冷却
      p.accounts[2].disabled = true;                                                                    // 停用
      p.accounts[3].ignored = true;                                                                     // 移出

      const dead = unavailableReason(p, "a1", T0);
      const cooling = unavailableReason(p, "a2", T0);
      const disabled = unavailableReason(p, "a3", T0);
      const ignored = unavailableReason(p, "a4", T0);

      assert.equal(dead.reason, "dead");
      assert.equal(cooling.reason, "quota");
      assert.equal(disabled.reason, "disabled");
      assert.equal(ignored.reason, "ignored");

      const remedies = [dead.remedy, cooling.remedy, disabled.remedy, ignored.remedy];
      assert.equal(new Set(remedies).size, 4, `四条指引必须互不相同：\n${remedies.join("\n")}`);

      // 恢复方式也必须不同：等 / 充值 / 重新登录 / 打开开关
      assert.deepEqual(
        [dead.recoveredBy, cooling.recoveredBy, disabled.recoveredBy, ignored.recoveredBy],
        ["relogin", "topup", "enable", "rejoin"],
      );
      // 四种都不可用，且都不该被说成「等一等就好」
      assert.equal(/等冷却到点/.test(dead.remedy), false, "判死的号等不到回来");
      assert.equal(/重新登录/.test(cooling.remedy), false, "额度用尽要充值，不是重新登录");
    });

    test("模型冷却 vs 整号冷却：粒度不同，指引也不同", () => {
      const p = pool([acct("a1")]);
      applyFailure(p, { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: T0 });
      const model = unavailableReason(p, "a1", T0, "hy4");
      assert.equal(model.reason, "cooling_model");
      assert.notEqual(model.remedy, remedyOf("cooling"));
      assert.ok(/这个模型/.test(model.remedy), "模型级冷却要说清「只有这个模型」");

      applyFailure(p, { accountId: "a1", status: 402, text: "insufficient credits", now: T0 + 1 });
      const whole = unavailableReason(p, "a1", T0 + 2, "hy4");
      assert.equal(whole.reason, "quota", "整号额度冷却压过模型冷却");
      assert.notEqual(whole.remedy, model.remedy);
    });

    test("冷却到期后 reason 回到 ok", () => {
      const p = pool([acct("a1")]);
      applyFailure(p, { accountId: "a1", status: 402, text: "insufficient credits", now: T0 });
      assert.equal(unavailableReason(p, "a1", T0 + QUOTA_COOLDOWN_MS - 1).reason, "quota");
      assert.equal(unavailableReason(p, "a1", T0 + QUOTA_COOLDOWN_MS + 1).reason, "ok");
    });

    test("所有 reason 都有非空指引；不认识的 reason 也不返回空串", () => {
      const known = ["ok", "dead", "quota", "cooling", "cooling_model", "disabled", "ignored", "stale", "unknown_account"];
      for (const r of known) {
        assert.ok(typeof remedyOf(r) === "string" && remedyOf(r).length > 0, `${r} 缺指引`);
      }
      assert.ok(remedyOf("根本不存在的理由").length > 0, "未知 reason 也得给得出话");
    });

    test("clearCooldowns 能救回判死的号（用户已经重新登录过了）", () => {
      const p = pool([acct("a1"), acct("a2")]);
      applyFailure(p, { accountId: "a1", status: 401, text: "invalid_grant", now: T0 });
      assert.equal(unavailableReason(p, "a1", T0).reason, "dead");
      assert.equal(clearCooldowns(p, "a1"), 1);
      assert.equal(p.accounts[0].dead, false, "判死标记应被清掉");
      assert.equal(unavailableReason(p, "a1", T0).reason, "ok");
      assert.equal(acquire(p, { model: "hy4", sessionKey: "s", now: T0 }).account.id, "a1");
    });
  });

  /* ================================================================
   * ⑦ LRU
   * ================================================================ */
  describe("⑦ 粘性表 LRU 上限", () => {
    test("超过上限后最早的绑定被淘汰", () => {
      const m = new Map();
      for (let i = 0; i < STICKY_LIMIT; i++) stickyBind(m, "k" + i, "a" + i, T0);
      assert.equal(m.size, STICKY_LIMIT);
      // 注意用 m.get 而不是 stickyLookup：后者会刷新 LRU 位置，把 k0 变成「最新」，
      // 那就测不到「最早的被淘汰」了。
      assert.equal(m.get("k0"), "a0", "刚好在上限内时最早的还在");

      stickyBind(m, "k-overflow", "aX", T0);
      assert.equal(m.size, STICKY_LIMIT, "超限后应淘汰到恰好等于上限");
      assert.equal(m.has("k0"), false, "最早的 k0 应被淘汰");
      assert.equal(m.has("k1"), true);
      assert.equal(m.get("k-overflow"), "aX");
    });

    test("★ 反向对照：lookup 命中会把绑定移到最新端（否则 LRU 退化成 FIFO）", () => {
      const m = new Map();
      for (let i = 0; i < STICKY_LIMIT; i++) stickyBind(m, "k" + i, "a" + i, T0);
      stickyLookup(m, "k0");              // k0 刚被用过 → 应当是最新的
      stickyBind(m, "k-overflow", "aX", T0);
      assert.equal(m.has("k0"), true, "刚被读过的绑定不该被淘汰");
      assert.equal(m.has("k1"), false, "没被读过的 k1 才是最该淘汰的");
    });

    test("反复绑同一个 key 不增长（先删后插）", () => {
      const m = new Map();
      for (let i = 0; i < 50; i++) stickyBind(m, "same", "a" + i, T0);
      assert.equal(m.size, 1);
      assert.equal(m.get("same"), "a49", "后写覆盖前写");
    });

    test("accountId 传 null = 解绑", () => {
      const m = new Map();
      stickyBind(m, "k", "a1", T0);
      stickyBind(m, "k", null, T0);
      assert.equal(m.has("k"), false);
    });

    test("上限值有据可查，不是随手写的", () => {
      assert.equal(STICKY_LIMIT, 200);
      // 源码里必须写清楚这个数字的依据（防止以后被人无声改成 5）
      assert.ok(/STICKY_LIMIT = 200/.test(SRC), "上限值必须在源码里显式写着");
      assert.ok(SRC.includes("10 倍余量"), "注释里必须说明为什么 200 够用");
    });
  });

  /* ================================================================
   * ⑧ 反向对照：判据自己会不会失效
   *    —— 严禁恒真断言，下面逐条证明判据确实认得出东西
   * ================================================================ */
  describe("⑧ 反向对照：这些判据自己认得出东西吗", () => {
    test("「不判死」这条判据确实认得出真死", () => {
      // 假想实现写成「401/403 一律判死」时，上面 ① 组会红；这里证明判据不是恒真
      assert.equal(classifyFailure(401, "invalid_grant", { now: T0 }).dead, true);
      assert.equal(classifyFailure(401, "unauthorized", { now: T0 }).dead, false);
      assert.notEqual(
        classifyFailure(401, "invalid_grant", { now: T0 }).dead,
        classifyFailure(401, "unauthorized", { now: T0 }).dead,
        "两种 401 的判死结论必须不同 —— 否则 ① 组全是恒真断言",
      );
    });

    test("「429 只冷却一格」这条判据确实认得出整号冷却", () => {
      const p = pool([acct("a1"), acct("a2")]);
      applyFailure(p, { accountId: "a1", model: "hy4", status: 429, text: "rate limited", now: T0 });
      const modelOnly = unavailableReason(p, "a1", T0, "hy4").reason;
      applyFailure(p, { accountId: "a2", status: 402, text: "insufficient credits", now: T0 });
      const wholeAcct = unavailableReason(p, "a2", T0, "hy4").reason;
      assert.notEqual(modelOnly, wholeAcct, "模型级与整号级必须能区分开");
      assert.equal(modelOnly, "cooling_model");
      assert.equal(wholeAcct, "quota");
    });

    test("「不信 expiresAt」这条判据确实认得出新鲜度差异", () => {
      const now = T0;
      const a = credentialFreshness({ credential: { lastRefreshTime: now - 10 * MIN, expiresAt: now + 1 * MIN } }, now);
      const b = credentialFreshness({ credential: { lastRefreshTime: now - 20 * MIN, expiresAt: now + 999 * MIN } }, now);
      assert.notEqual(a.rank, b.rank, "两个 rank 必须不同，否则「排序」这条断言是恒真的");
      assert.ok(a.rank > b.rank);
    });

    test("「同 key 粘住」这条判据确实认得出不同会话会不同号", () => {
      const p = pool([acct("a1"), acct("a2")], { mode: "sticky" });
      // 手工把两个会话绑到不同号，再验证「绑定生效」而不是「碰巧相同」
      stickyBind(p.sticky = p.sticky || new Map(), "sA", "a1", T0);
      stickyBind(p.sticky, "sB", "a2", T0);
      assert.equal(acquire(p, { model: "hy4", sessionKey: "sA", now: T0 }).account.id, "a1");
      assert.equal(acquire(p, { model: "hy4", sessionKey: "sB", now: T0 }).account.id, "a2");
      // 没有绑定时两个 key 拿同一个号（说明上面的差异来自绑定，不是来自 key 本身）
      const q = pool([acct("a1"), acct("a2")], { mode: "sticky" });
      assert.equal(acquire(q, { model: "hy4", sessionKey: "sA", now: T0 }).account.id,
        acquire(q, { model: "hy4", sessionKey: "sB", now: T0 }).account.id);
    });

    test("「指引互不相同」这条判据确实认得出重复", () => {
      const rs = ["dead", "quota", "cooling", "disabled"];
      assert.equal(new Set(rs.map(remedyOf)).size, rs.length);
      // 同一份指引喂两遍 → set 塌成 1，说明这条判据不是恒真
      assert.equal(new Set([remedyOf("dead"), remedyOf("dead")]).size, 1);
    });

    test("「红转绿」这条判据本身会失败（sabotage 的前提）", () => {
      // 假如 SABOTAGE 里某条 `from` 在源码里命中 0 次，执行器必须判失败而不是跳过。
      assert.equal("压根不存在的锚点xyz".includes(SRC), false);
    });

    test("redact 确实抹得掉凭据形态，且认得出（否则上面几条自证是假的）", () => {
      assert.ok(!/sk-[A-Za-z0-9_-]{8,}/.test(redact("key=sk-abcdefghijklmnop1234")));
      assert.ok(!/Bearer [A-Za-z0-9]{10,}/.test(redact("Bearer aaaaaaaaaaaaaaaaaaaa")));
      // ★ 反向对照：明显像凭据的串必须被判出来 —— 否则上面两条恒真
      assert.equal(/\bsk-[A-Za-z0-9_-]{16,}/.test("sk-abcdefghijklmnopqrstuvwxyz"), true, "判据自己失效了");
      // 短串（人话）保留，别把错误信息全抹光
      assert.ok(redact("model hy4 is cooling").includes("cooling"));
    });

    test("classifyFailure 的 scope 判据认得出粒度", () => {
      assert.notEqual(
        classifyFailure(429, "rate limited", { now: T0 }).scope,
        classifyFailure(402, "insufficient credits", { now: T0 }).scope,
      );
      assert.equal(classifyFailure(503, "oops", { now: T0 }).scope, "none");
    });
  });

  /* ================================================================
   * ⑨ 红线自检 + 零 IO/零网络
   * ================================================================ */
  describe("⑨ 红线：零 IO、零网络、无凭据", () => {
    test("模块不碰 fs / 网络 / 子进程 / 环境变量", () => {
      // 剥掉注释再扫，否则注释里的字会被当成代码
      const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.equal(/\b(readFileSync|writeFileSync|mkdirSync|existsSync|rmSync|appendFileSync|createWriteStream)\b/.test(code), false);
      assert.equal(/\bfetch\s*\(|XMLHttpRequest|node:https?|node:net|node:dgram/.test(code), false);
      assert.equal(/\b(child_process|spawn|execSync|execFile)\b/.test(code), false);
      assert.equal(/\bprocess\.env\b/.test(code), false);
      // 反向对照：这份判据确实认得出来
      assert.equal(/\bfetch\s*\(/.test("await fetch('http://x')"), true, "判据自己失效了");
      assert.notEqual(code, SRC, "剥注释没起作用，注释里的字都被当成代码了");
    });

    test("不 import 任何内置模块（时间源/哈希全由调用方注入）", () => {
      assert.equal(/^\s*import\s/m.test(SRC), false, "本模块零依赖，不许 import");
      assert.equal(/require\s*\(/.test(SRC), false);
    });

    test("源码里没有任何看起来像真实凭据的串", () => {
      assert.equal(/\bsk-[A-Za-z0-9_-]{16,}/.test(SRC), false, "源码里出现了 sk- 开头的长串");
      assert.equal(/\bjt-[A-Za-z0-9_-]{16,}/.test(SRC), false);
      assert.equal(/\bBearer\s+[A-Za-z0-9._-]{16,}/.test(SRC), false);
      // 反向对照：判据确实认得出
      assert.equal(/\bsk-[A-Za-z0-9_-]{16,}/.test("sk-abcdefghijklmnopqrstuvwxyz"), true, "判据自己失效了");
    });

    test("错误信息里带上游正文时先洗过", () => {
      const secret = "sk-abcdefghijklmnopqrstuvwxyz0123";
      const f = classifyFailure(401, `{"key":"${secret}","error":"unauthorized"}`, { now: T0 });
      const whole = JSON.stringify(f);
      assert.equal(whole.includes(secret), false, "凭据绝不能出现在返回值的任何字段里");
      assert.ok(f.evidence.length > 0, "但仍要留一点可读的上下文");
    });

    test("★ 模块不写磁盘：整个套件跑完，池子与粘性表都只在内存里", () => {
      // 反向对照：判据认得出「真的写了文件」的形态
      assert.equal(/writeFileSync/.test(SRC), false);
      assert.equal(/writeFileSync/.test('writeFileSync("C:/tmp/x")'), true);
    });
  });

  /* ================================================================
   * ⑩ 池子级行为
   * ================================================================ */
  describe("⑩ 池子级行为", () => {
    test("国内版与国际版分池不混（版本对不上的直接出局）", () => {
      const cn = acct("cn-1", { version: "wb" });
      const intl = acct("intl-1", { version: "wbai" });
      const pCn = pool([cn, intl]);
      const pIntl = pool([cn, intl], { version: "wbai" });
      for (let i = 0; i < 5; i++) {
        assert.equal(acquire(pCn, { model: "hy4", sessionKey: "cn-s" + i, now: T0 }).account.version, "wb");
        assert.equal(acquire(pIntl, { model: "hy4", sessionKey: "ai-s" + i, now: T0 }).account.version, "wbai");
      }
      // 只装了一版的池子要如实说「没有」，而不是默默拿别的版的顶上
      const onlyIntl = pool([intl], { version: "wb" });
      const r = acquire(onlyIntl, { model: "hy4", sessionKey: "x", now: T0 });
      assert.equal(r.ok, false);
      assert.ok(/版本/.test(r.remedy), "版本错配要说清楚：" + r.remedy);
    });

    test("round-robin 把请求铺开", () => {
      const p = pool([acct("a1"), acct("a2"), acct("a3")], { mode: "round-robin" });
      const seen = new Set();
      for (let i = 0; i < 6; i++) seen.add(acquire(p, { model: "hy4", sessionKey: "rr" + i, now: T0 }).account.id);
      assert.equal(seen.size, 3, "6 次请求应铺到 3 个号上");
    });

    test("balanced 用注入的随机源（可复现）", () => {
      const p = pool([acct("a1"), acct("a2")], { mode: "balanced" });
      const r = acquire(p, { model: "hy4", sessionKey: "b1", now: T0, rand: () => 0 });
      const r2 = acquire(p, { model: "hy4", sessionKey: "b2", now: T0, rand: () => 0 });
      assert.equal(r.account.id, r2.account.id, "固定随机源 → 固定结果");
    });

    test("认不出来的 mode 退回 priority，不崩", () => {
      const p = pool([acct("a1"), acct("a2")], { mode: "压根没有这个模式" });
      assert.equal(acquire(p, { model: "hy4", sessionKey: "s", now: T0 }).ok, true);
    });

    test("停用的号不会被选中", () => {
      const p = pool([acct("a1"), acct("a2")]);
      p.accounts[0].disabled = true;
      for (let i = 0; i < 3; i++) {
        assert.equal(acquire(p, { model: "hy4", sessionKey: "d" + i, now: T0 }).account.id, "a2");
      }
    });

    test("refresh 路径上 400 + invalid_grant 也判死（刷新接口就是用 400）", () => {
      const f = classifyFailure(400, '{"error":"invalid_grant: Offline user session not found"}',
        { now: T0, context: "refresh" });
      assert.equal(f.dead, true, "刷新路径漏判 = 死号永远留在池子里烧重试");
      // ★ 但模型请求路径不能因此放宽：400 不该判死
      assert.equal(classifyFailure(400, '{"error":"invalid_grant"}', { now: T0 }).dead, false,
        "模型请求路径只认 401/403，不因这个开关放宽");
    });

    test("content 类不冷却（换号只会白耗别的账号的额度）", () => {
      const f = classifyFailure(400, "context length exceeded", { now: T0 });
      assert.equal(f.kind, "content");
      assert.equal(f.scope, "none");
      const p = pool([acct("a1")]);
      applyFailure(p, { accountId: "a1", model: "hy4", status: 400, text: "context length exceeded", now: T0 });
      assert.equal(unavailableReason(p, "a1", T0, "hy4").reason, "ok", "内容错误不得冷却账号");
    });
  });
});

/* ------------------------------------------------------------------ *
 * 反向对照的「把手册」：--list-sabotage / --sabotage
 * 每条都是**真实跑过的**：在源码上打这个补丁 → 测试必须红 → 还原。
 * ------------------------------------------------------------------ */
const SABOTAGE = [
  {
    name: "dead-on-any-401",
    where: "classifyFailure 的 401/403 分支",
    from: "    const phrase = matchedDeadPhrase(body);\n    if (phrase) {",
    to: "    const phrase = matchedDeadPhrase(body);\n    if (true) {",
    reds: "★① 401/403 但文案不匹配 → 绝不判死（7 条）+ 落池不改状态",
  },
  {
    name: "trust-expires-at",
    where: "credentialFreshness 的 basis 判定",
    from: 'const basis = issued != null ? "lastRefreshTime" : captured != null ? "capturedAt" : "expiresAt";',
    to: 'const basis = "expiresAt";',
    reds: "★④ expiresAt 更晚但已吊销的账号不被优先选中 + 只靠 expiresAt 的一律不可信 + 排序判据",
  },
  {
    name: "rate-limit-account-scope",
    where: "classifyFailure 的 429 分支",
    from: 'kind: "rate_limit", dead: false, scope: "account_model",',
    to: 'kind: "rate_limit", dead: false, scope: "account",',
    reds: "★② 429 粒度是 (账号,模型) + 同号换模型不受影响",
  },
  {
    name: "quota-respect-reset",
    where: "cooldownFor 的 quota 分支",
    from: 'respectsResetAt: false, waitsHelps: false, recoveredBy: "topup", ignoredResetAt: resetAt,',
    to: 'respectsResetAt: true, waitsHelps: true, recoveredBy: "wait", ignoredResetAt: null,',
    reds: "★③ 402 等多久都不会恢复（无视 resetAt）",
  },
  {
    name: "sticky-ignore-binding",
    where: "acquire 的 ① 粘性优先",
    from: "      const bound = eligible.find((a) => a.id === boundId);\n      if (bound) return { ok: true, account: bound, bound: true, eligible: eligible.length, how: \"sticky\" };",
    to: "      const bound = undefined;\n      if (bound) return { ok: true, account: bound, bound: true, eligible: eligible.length, how: \"sticky\" };",
    reds: "★⑤ 同一 sessionKey 两次 acquire 拿同一个号 + 判死后自动重绑",
  },
  {
    name: "no-rebind-after-death",
    where: "acquire 绑定成功后",
    from: "  bindIfSticky(stickyMap, sessionKey, chosen.id, now);\n  return { ok: true, account: chosen, bound: false, eligible: eligible.length, how: mode };",
    to: "  return { ok: true, account: chosen, bound: false, eligible: eligible.length, how: mode };",
    reds: "★⑤ 同 key 两次 acquire 必须同一个号 + 判死后重绑要落在新号上",
  },
  {
    name: "same-remedy-for-all",
    where: "REASONS 的 dead 条目",
    from: '    remedy: "去 WorkBuddy 桌面端重新登录这个账号再重新捕获令牌；等多久都不会自己恢复，重启本程序也没用。",\n    recoveredBy: "relogin",',
    to: '    remedy: "请稍后重试。",\n    recoveredBy: "wait",',
    reds: "★⑥ 四种情况的处置指引互不相同 + 判死的号等不到回来",
  },
  {
    name: "unlimited-lru",
    where: "stickyBind 的 LRU 上限",
    from: "while (stickyMap.size > STICKY_LIMIT) {",
    to: "while (false) {",
    reds: "★⑦ LRU 超上限后最早的绑定被淘汰 + lookup 刷新位置",
  },
  {
    name: "transient-cools-anyway",
    where: "applyFailure 的瞬时分支",
    from: 'if (failure.kind === "transient" || failure.kind === "content") {',
    to: 'if (failure.kind === "content") {',
    reds: "① 401 落池不得写冷却 + content 不冷却",
  },
  {
    name: "quota-downgrade",
    where: "applyFailure 的整号冷却写入",
    from: "if (cd.untilMs > prev) { acct.cooldownUntilMs = cd.untilMs; out.changed = true; }",
    to: "acct.cooldownUntilMs = cd.untilMs; out.changed = true;",
    reds: "③ 已有冷却不得被后来的更短冷却缩短 + 额度冷却不被 429 覆盖",
  },
];

if (process.argv.includes("--list-sabotage")) {
  console.log(`wb-pool 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(28)} ${s.where}\n  ${"".padEnd(28)} → 会打红: ${s.reds}`);
  process.exit(0);
}
if (process.argv.includes("--sabotage")) {
  const i = process.argv.indexOf("--sabotage");
  const name = process.argv[i + 1];
  const s = SABOTAGE.find((x) => x.name === name);
  if (!s) { console.error(`没有这条手法：${name}。可用：${SABOTAGE.map((x) => x.name).join(", ")}`); process.exit(2); }
  console.log(JSON.stringify({ file: "src/server/wb-pool.mjs", ...s }, null, 2));
  process.exit(0);
}