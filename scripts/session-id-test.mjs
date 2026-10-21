// scripts/session-id-test.mjs —— session-id.mjs 的测试
//
// 红线：这个模块只做一件事——**认出请求属于哪个会话**，而且**绝不编造**。
// 「绝不编造」是最容易被赶工破坏的一条：一旦有人为了「让它总有值」而返回
// 空串 / "unknown" / IP / key，不同对话的用量就会混到同一行里，而且不会有
// 任何报错。所以下面每一条断言都写成「改坏实现必然让它红」的样子。
//
// 跑法：node --test scripts/session-id-test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  SESSION_HEADER,
  MAX_SESSION_LEN,
  NATIVE_SESSION_HEADERS,
  sessionOf,
  nativeSessionOf,
  conversationIdOf,
  isNativeSession,
  sessionKey,
} from "../src/server/session-id.mjs";

/* ========================================================================== *
 * ① 会话头的识别
 * ========================================================================== */

/** magpie 的原生头清单（gateway.go:6405），照抄——顺序也是语义。 */
const MAGPIE_NATIVE_HEADERS = [
  "x-opencode-session",
  "x-session-affinity",
  "x-session-id",
  "session_id",
  "session-id",
  "x-claude-code-session-id",
  "x-conversation-id",
  "x-deepseek-harness-session-id",
];

test("① 原生头清单：8 个，一个不多一个不少，顺序照抄 magpie", () => {
  assert.deepEqual([...NATIVE_SESSION_HEADERS], MAGPIE_NATIVE_HEADERS);
  // 表里的头名必须都是小写（本模块内部一律小写比较）
  for (const h of NATIVE_SESSION_HEADERS) assert.equal(h, h.toLowerCase());
});

test("① 客户端头 X-Magpie-Session：取得到，source 是 client", () => {
  const got = sessionOf({ "x-magpie-session": "client-session" });
  assert.deepEqual(got, { id: "client-session", source: "client" });
  // 原生的头一个都没有 → 没有原生身份
  assert.equal(nativeSessionOf({ "x-magpie-session": "client-session" }), "");
});

test("① 每个原生头都能被认出来，source 是 native", () => {
  for (const h of MAGPIE_NATIVE_HEADERS) {
    const got = sessionOf({ [h]: "native-session" });
    assert.deepEqual(got, { id: "native-session", source: "native" }, `头 ${h} 没被认出来`);
    assert.equal(nativeSessionOf({ [h]: "native-session" }), "native-session", `头 ${h} 没被认出来`);
  }
});

test("① 客户端头与原生头同时存在：客户端赢（magpie 的 sessionOf 把 SessionHeader 排在前面）", () => {
  // 证据：gateway.go:6439 `append([]string{SessionHeader}, sessionHeaders...)`，
  // 以及 magpie 的 TestWorkBuddySessionHeader：客户端写 override，原生仍是 workbuddy-session。
  const both = { "x-magpie-session": "client-id", "x-conversation-id": "native-id" };
  const got = sessionOf(both);
  assert.deepEqual(got, { id: "client-id", source: "client" });
  // 但原生身份没丢——客户端改的是「网关记在哪一行」，不是 agent 自己那份会话文件。
  assert.equal(nativeSessionOf(both), "native-id");
});

test("① 两个原生头同时存在：表里靠前的赢", () => {
  // magpie 的 sessionHeaders 是有序表，遍历时先命中的赢。
  assert.equal(sessionOf({ "x-opencode-session": "a", "x-conversation-id": "b" }).id, "a");
  assert.equal(sessionOf({ "x-conversation-id": "b", "x-deepseek-harness-session-id": "c" }).id, "b");
  assert.equal(sessionOf({ "x-session-id": "a", "session-id": "b" }).id, "a");
  assert.equal(sessionOf({ "session_id": "a", "session-id": "b" }).id, "a");
});

test("① 头名大小写不敏感", () => {
  assert.deepEqual(sessionOf({ "X-MAGPIE-SESSION": "s1" }), { id: "s1", source: "client" });
  assert.deepEqual(sessionOf({ "X-Magpie-Session": "s1" }), { id: "s1", source: "client" });
  assert.deepEqual(sessionOf({ "X-Conversation-ID": "s2" }), { id: "s2", source: "native" });
  assert.deepEqual(sessionOf({ "x-DeepSeek-Harness-Session-Id": "s3" }), { id: "s3", source: "native" });
  // Fetch 的 Headers 实例同样认（Headers 规范本身就大小写不敏感）
  const h = new Headers();
  h.set("X-Conversation-ID", "s4");
  assert.deepEqual(sessionOf(h), { id: "s4", source: "native" });
});

test("① 没有任何会话头 → 返回 null（不是空串，不是 \"unknown\"）", () => {
  const got = sessionOf({});
  assert.equal(got, null);
  assert.notEqual(got, "");
  assert.notEqual(got, "unknown");
  assert.equal(sessionOf({ "user-agent": "curl/8.0", "content-type": "application/json" }), null);
  assert.equal(sessionOf(null), null);
  assert.equal(sessionOf(undefined), null);
  // 账本那一侧同样：没有 id 就没有会话键
  assert.equal(sessionKey("codex", ""), null);
  assert.equal(sessionKey("", "abc"), null);
});

test("① 每轮 / 每条消息 / 父会话的头都不算会话", () => {
  // magpie 的 TestWorkBuddySessionHeader 专门锁死了这条：turn-only / message-only /
  // parent-only 都不能变成当前会话。
  const got = sessionOf({
    "x-conversation-request-id": "turn-only",
    "x-conversation-message-id": "message-only",
    "x-parent-conversation-id": "parent-only",
  });
  assert.equal(got, null);
  assert.equal(nativeSessionOf({
    "x-conversation-request-id": "turn-only",
    "x-conversation-message-id": "message-only",
  }), "");
});

test("① 空白的值不算会话；超长的值截到 128", () => {
  assert.equal(sessionOf({ "x-conversation-id": "   " }), null);
  assert.equal(sessionOf({ "x-magpie-session": "  " }), null);
  const long = "s".repeat(140);
  assert.equal(sessionOf({ "x-magpie-session": long }).id.length, MAX_SESSION_LEN);
  assert.equal(nativeSessionOf({ "x-conversation-id": long }).length, MAX_SESSION_LEN);
  // 去空白在截断之前：140 个 s 前面塞空格，截出来仍然是 128 个 s
  assert.equal(sessionOf({ "x-conversation-id": "  " + "s".repeat(140) + "  " }).id, "s".repeat(128));
});

/* ========================================================================== *
 * ② 派生会话 id（conversationIdOf / isNativeSession）
 * ========================================================================== */

test("② conversationIdOf：同一段对话稳定，不同对话不同", () => {
  const turn1 = [{ role: "system", content: "s" }, { role: "user", content: "fix the bug" }];
  const turn2 = [
    { role: "system", content: "s" },
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: "done" },
    { role: "user", content: "thanks" },
  ];
  const other = [{ role: "system", content: "s" }, { role: "user", content: "write docs" }];
  const a = conversationIdOf(turn1);
  const b = conversationIdOf(turn2);
  const c = conversationIdOf(other);
  assert.equal(a, b, "同一段对话的两轮派生出同一个 id");
  assert.notEqual(a, c, "不同的对话派生出不同的 id");
});

test("② conversationIdOf：空消息数组 → null", () => {
  assert.equal(conversationIdOf([]), null);
  assert.equal(conversationIdOf(null), null);
  assert.equal(conversationIdOf(undefined), null);
  assert.equal(conversationIdOf("not an array"), null);
});

test("② 派生 id 的形状：magpie- + 24 位 hex（sha256 前 12 字节，不是 16 位）", () => {
  const id = conversationIdOf([{ role: "user", content: "fix the bug" }]);
  assert.match(id, /^magpie-[0-9a-f]{24}$/);
  // 长度锁死：magpie 是 hex.EncodeToString(sum[:12]) → 12 字节 → 24 位 hex
  assert.equal(id.length, "magpie-".length + 24);
  // 黄金值：锁定「哈希的是整条消息对象的 JSON」这个口径
  assert.equal(id, "magpie-3b5a026529bd4164b7f8000b");
});

test("② 锚点：第一条 user 消息；一条 user 都没有才退回第一条消息（magpie 同款）", () => {
  // magpie 的 conversationID（gateway.go:6507-6520）：先把 first 置成 items[0]，
  // 再遍历全部 items 找第一条 role=="user" 的，找到就用它。找到过就是它的，
  // 不是第一条 user 之前那些条。
  const noUser = conversationIdOf([{ role: "assistant", content: "done" }]);
  const noUserMore = conversationIdOf([
    { role: "assistant", content: "done" },
    { role: "assistant", content: "more" },
  ]);
  assert.equal(noUser, noUserMore, "一条 user 都没有时锚点是第一条消息");

  // 一旦有了 user 消息，锚点就是它（哪怕它在第 2 位）
  const withUser = conversationIdOf([
    { role: "assistant", content: "done" },
    { role: "user", content: "hi" },
  ]);
  assert.notEqual(noUser, withUser);
  assert.equal(withUser, conversationIdOf([
    { role: "assistant", content: "done" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
  ]), "第一条 user 消息在整段对话里不变");
});

test("② isNativeSession：真会话 id 是真的，派生 id 不是", () => {
  assert.equal(isNativeSession("client-session"), true);
  assert.equal(isNativeSession("workbuddy-session"), true);
  assert.equal(isNativeSession(conversationIdOf([{ role: "user", content: "hi" }])), false);
  assert.equal(isNativeSession(""), false);
  assert.equal(isNativeSession("   "), false);
  assert.equal(isNativeSession(null), false);
  assert.equal(isNativeSession(undefined), false);
  assert.equal(isNativeSession(123), false);
});

/* ========================================================================== *
 * ③ 账本里的会话键
 * ========================================================================== */

test("③ sessionKey：同 agent 同 id → 同键；不同 agent → 不同键", () => {
  assert.equal(sessionKey("codex", "abc"), sessionKey("codex", "abc"));
  assert.equal(sessionKey("codex", "abc"), "codex|abc");
  assert.notEqual(sessionKey("codex", "abc"), sessionKey("claude", "abc"));
  assert.notEqual(sessionKey("codex", "abc"), sessionKey("codex", "xyz"));
});

test("③ sessionKey：会话身份是 agent + id 合成（magpie 的 AgentOf(Agent) + Session）", () => {
  const got = sessionOf({ "x-conversation-id": "abc" });
  assert.equal(sessionKey("codex", got.id), "codex|abc");
  assert.notEqual(sessionKey("codex", got.id), sessionKey("claude", got.id));
});

/* ========================================================================== *
 * ★ 反向对照：把实现改坏，这些断言必须打红
 * ========================================================================== */

test("★ 反向对照①：「没有 session 就返回 null」改成返回空串 → 同一条断言打红", () => {
  const headers = { "user-agent": "curl/8.0" }; // 没有任何会话头

  // 真实实现：满足断言。
  assert.equal(sessionOf(headers), null);

  // 改坏的实现：只把「return null」换成「return ""」，其余一模一样。
  const broken = (h) => {
    const s = sessionOf(h);
    return s === null ? "" : s; // ← 唯一的改动
  };
  assert.equal(broken(headers), "", "改坏的那个确实返回了空串");

  // 同一条断言问它：必须失败。**失败才是本测试通过**——
  // 它证明这条断言真的能抓住「null 变成空串」这个回归。
  assert.throws(() => assert.equal(broken(headers), null), assert.AssertionError);
});

test("★ 反向对照②：把「客户端头优先」反过来 → 同一条断言打红", () => {
  const both = { "x-magpie-session": "client-id", "x-conversation-id": "native-id" };

  // 真实实现：客户端赢。
  assert.equal(sessionOf(both).source, "client");

  // 改坏的实现：原生优先。
  const nativeFirst = (h) => {
    const n = nativeSessionOf(h);
    if (n) return { id: n, source: "native" };
    return sessionOf(h);
  };
  assert.equal(nativeFirst(both).source, "native", "改坏的那个确实让原生赢了");

  // 同一条断言问它：必须失败。
  assert.throws(() => assert.equal(nativeFirst(both).source, "client"), assert.AssertionError);
});

test("★ 反向对照③：把派生哈希从 24 位改成 16 位 → 同一条断言打红", () => {
  const id = conversationIdOf([{ role: "user", content: "fix the bug" }]);
  const shortened = id.slice(0, "magpie-".length + 16);
  // 24 位锁死
  assert.equal(id.length, "magpie-".length + 24);
  assert.notEqual(id, shortened);
  assert.throws(() => assert.match(shortened, /^magpie-[0-9a-f]{24}$/), assert.AssertionError);
});
