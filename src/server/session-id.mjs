/**
 * session-id —— 会话身份识别（magpie 的 sessionHeaders 移植）
 *
 * 移植自 yetone/magpie 的 internal/gateway/gateway.go（Go）：
 *   - `sessionHeaders`  gateway.go:6405  —— 各 agent 自报会话的头清单
 *   - `sessionOf`       gateway.go:6438  —— 客户端头优先的会话取值
 *   - `nativeSessionOf` gateway.go:6471  —— 只认 agent 自己的头
 *   - `conversationID`  gateway.go:6483  —— 原生 id，否则首条 user 消息的派生哈希
 *
 * ## ★ 铁律：magpie 从不为没有 session id 的请求编造 id
 *
 * 这条是本模块最容易被赶工破坏的地方，所以单独立一条写在这里：
 *
 *   **没有可用来源时返回 `null`**——不许返回空串、不许返回 "unknown"、不许拿
 *   IP / 调用方 key / 提示词文本顶替。
 *
 * 为什么这么严：
 *   - 会话 id 是**账本的主键**（`AgentOf(record.Agent) + record.Session`）。
 *     编造出来的 id 会把不同对话的用量混到同一行里，也会让「这段提示词属于哪次
 *     对话」变成猜的——magpie 的原话是 "text kept under an id nothing lists
 *     couldn't be opened"（记在一个谁也列不出来的 id 下的文本，是读不出来的）。
 *   - 提示词文本、调用方 key、网络地址**绝不用于猜测会话归属**。这不是保守，
 *     是因为它们都会误判：两个对话的第一句话可能一模一样（`conversationID` 的
 *     派生办法正是因此才只是「派生身份」），同一个 key 后面可能跑几十个会话，
 *     而同一个 IP 上的更是毫无关系。
 *
 * 对应到代码：`sessionOf` 的两个分支都落空时 `return null`（不是 `""`）；
 * `conversationIdOf` 在没有消息时 `return null`；`sessionKey` 在 agent 或 id
 * 缺一个时 `return null`。**这三处 return null 就是那条铁律的落点**，改它们
 * 之前先读本段。
 *
 * ## 派生身份 ≠ 原生身份（magpie 里两者是分开的）
 *
 * `conversationIdOf` 给出的 `magpie-<hash>` 是**派生身份**：它由首条 user 消息
 * 哈希而来，只能在「确定需要一个对话身份」时用（亲和性、路由分组），
 * **不能冒充原生 session id**。magpie 那边原生会话优先，派生出来的会话投影被
 * 省掉（`usage.GatewaySessions` 的 nativeKeys 抑制）。
 *
 * 因此本模块把两者分开：`sessionOf` 给真 id，`conversationIdOf` 给派生 id，
 * `isNativeSession` 负责把派生 id 认出来。
 *
 * ## 哈希长度（以源码为准，别照抄旧笔记）
 *
 * magpie 的 `conversationID`（gateway.go:6524）：
 *
 *     sum := sha256.Sum256(first)
 *     return "magpie-" + hex.EncodeToString(sum[:12])
 *
 * `sum[:12]` 是 sha256 的**前 12 字节**，hex 编码后是 **24 位 hex**（不是 16 位）。
 * 下面 `DERIVED_HASH_BYTES = 12` 与 `DERIVED_ID_RE` 里的 `{24}` 就是照这个来的。
 *
 * ## 纪律
 *
 * 纯 ESM、零第三方依赖（只用 node:crypto 的哈希），不读文件、不发网络、不读环境
 * 变量。头名一律小写比较（HTTP 头大小写不敏感，magpie 那边靠 Go 的
 * `http.Header.Get` 自动规范化）。
 */

import { createHash } from "node:crypto";

/**
 * 客户端自报的会话头（magpie 的 `SessionHeader`，gateway.go:6428）。
 * **小写**：本模块内部一律小写比较。
 */
export const SESSION_HEADER = "x-magpie-session";

/**
 * 会话 id 的长度上限（magpie 的 `sessionOf` / `nativeSessionOf` 都截到 128）。
 *
 * 为什么要有上限：会话 id 会被写进账本的行、会进 `?session=` 查询串、会进日志。
 * 一个几 MB 的头塞进来，既撑爆账本行也让日志没法看。
 */
export const MAX_SESSION_LEN = 128;

/**
 * 各 agent 自己命名会话的头（magpie 的 `sessionHeaders`，gateway.go:6405）。
 *
 * 照抄那张表，**顺序也是语义**：magpie 遍历这张表，**先命中的赢**。
 * 每个头属于谁：
 *   - `x-opencode-session`          OpenCode（发给自己网关，也发给所有别人）
 *   - `x-session-affinity`           Pi 的 provider block（omp 16.0.6+ 的
 *                                   `compat.promptCacheSessionHeader`）
 *   - `x-session-id`                 通用会话头
 *   - `session_id`                   Codex（Responses 协议自带）
 *   - `session-id`                   Codex CLI 0.162 之后的形式（带连字符）
 *   - `x-claude-code-session-id`     Claude Code
 *   - `x-conversation-id`            WorkBuddy / CodeBuddy Code（#1903）
 *   - `x-deepseek-harness-session-id` DeepSeek Harness（#2505）
 *
 * **不在表里的头就不是会话**：`X-Conversation-Request-ID`（每轮）、`
 * X-Conversation-Message-ID`（每条消息）、`X-Parent-Conversation-ID`（父会话）
 * 都不能标识当前会话——magpie 的 `TestWorkBuddySessionHeader` 专门锁死了这条。
 */
export const NATIVE_SESSION_HEADERS = Object.freeze([
  "x-opencode-session",
  "x-session-affinity",
  "x-session-id",
  "session_id",
  "session-id",
  "x-claude-code-session-id",
  "x-conversation-id",
  "x-deepseek-harness-session-id",
]);

/** 派生会话 id 的前缀（magpie 的 `"magpie-" + ...`）。 */
const DERIVED_PREFIX = "magpie-";

/**
 * 派生哈希取 sha256 的前几个字节。
 *
 * magpie：`hex.EncodeToString(sum[:12])` → 12 字节 → **24 位 hex**。
 */
const DERIVED_HASH_BYTES = 12;

/** 派生 id 的形状：`magpie-` + 24 位小写 hex。 */
const DERIVED_ID_RE = /^magpie-[0-9a-f]{24}$/;

/**
 * 取一个头的原始值，找不到就是空串。
 *
 * 收两种形状：
 *   - 普通对象（Node 的 `req.headers`，键名已小写，但这里仍然逐个转小写比较，
 *     以防有人手写 `{ "X-Conversation-ID": ... }`）
 *   - Fetch 的 `Headers` 实例（`get()` 本身就大小写不敏感）
 *
 * 多值时取第一个（Go 的 `http.Header.Get` 也只取第一个值）。
 *
 * @param {object|Headers|null|undefined} headers
 * @param {string} name 小写头名
 * @returns {string}
 */
function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  // Headers 实例：规范本身就规定名字大小写不敏感。
  if (typeof headers.get === "function" && typeof headers.has === "function") {
    const v = headers.get(name);
    return v == null ? "" : String(v);
  }
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== want) continue;
    const v = headers[key];
    if (Array.isArray(v)) return v.length > 0 && v[0] != null ? String(v[0]) : "";
    return v == null ? "" : String(v);
  }
  return "";
}

/**
 * 归一化一个会话 id：去空白、空的作废、超长截断。
 *
 * 顺序照 magpie（gateway.go:6439-6443）：先 TrimSpace，空的当没有，再截到 128。
 * 截断放在去空白之后，所以 `"  " + 140 个 s` 截出来是 128 个 s 而不是 126 个。
 *
 * @param {string} raw
 * @returns {string} 归一后的 id，空串表示「没有」
 */
function normalize(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return "";
  return t.length > MAX_SESSION_LEN ? t.slice(0, MAX_SESSION_LEN) : t;
}

/**
 * 请求自报的会话：客户端的 `X-Magpie-Session` 优先，其次是各 agent 自己的头。
 *
 * 优先级是 magpie 的真实顺序（gateway.go:6439）：
 *
 *     for _, h := range append([]string{SessionHeader}, sessionHeaders...) {
 *
 * —— `SessionHeader`（`X-Magpie-Session`）排在 `sessionHeaders` **前面**，
 * 所以客户端显式指定的会话**赢过** agent 自报的那个。反过来，agent 的原生身份
 * 并没有丢：`nativeSessionOf` 仍然能把它读出来（magpie 的
 * `TestWorkBuddySessionHeader`：客户端写了 `override`，原生仍是
 * `workbuddy-session`）。
 *
 * @param {object|Headers|null|undefined} headers 头集合本身（`req.headers` 或 `Headers`）
 * @returns {{id: string, source: "client"|"native"}|null} 没有会话就是 `null`
 */
export function sessionOf(headers) {
  const client = normalize(headerValue(headers, SESSION_HEADER));
  if (client) return { id: client, source: "client" };
  for (const h of NATIVE_SESSION_HEADERS) {
    const v = normalize(headerValue(headers, h));
    if (v) return { id: v, source: "native" };
  }
  // ★ 铁律落点①：没有来源就是没有会话。返回 null，不返回空串、不返回 "unknown"、
  // 不拿 IP 或调用方 key 顶替。空串会被下游当成「有一个叫空的会话」。
  return null;
}

/**
 * agent 自报的会话（原生身份）：只认 `NATIVE_SESSION_HEADERS` 里的头，
 * **不看** `X-Magpie-Session`。
 *
 * 为什么要单列一个函数（magpie 的 `nativeSessionOf`，gateway.go:6471）：
 * 客户端可以在 `X-Magpie-Session` 里改会话名（那是**网关这一侧**记在哪一行），
 * 但改不了 agent 自己那份会话文件的身份。magpie 两边都记：
 * `usage.Record.Session`（客户端优先）与 `usage.Record.NativeSession`（原生）。
 * 亲和性、转发到远端 magpie、OTel 上报用的是原生那份。
 *
 * 头之间按 `NATIVE_SESSION_HEADERS` 的顺序，**先命中的赢**。
 *
 * @param {object|Headers|null|undefined} headers
 * @returns {string} 原生会话 id，没有就是空串
 */
export function nativeSessionOf(headers) {
  for (const h of NATIVE_SESSION_HEADERS) {
    const v = normalize(headerValue(headers, h));
    if (v) return v;
  }
  return "";
}

/**
 * 派生会话 id：首条 user 消息的哈希，形如 `magpie-<24 位 hex>`。
 *
 * 对应 magpie 的 `conversationID`（gateway.go:6483）。magpie 那边先找原生头，
 * 有就返回原生值；**本函数是纯派生那一半**——它只接受消息数组，
 * 不看头，这样调用方不会把派生身份和原生身份混在一起（magpie 里两者分开）。
 *
 * 取哪一条消息：
 *   - **第一条 `role === "user"` 的消息**（magpie 同款）。同一段对话的每一轮
 *     请求都带着那条同样的首条 user 消息，所以派生 id 在整段对话里恒定；
 *     两段不同的对话自然不同。
 *   - 一条 user 都没有时，退回**第一条消息**（magpie 同款：`first = items[0]`）。
 *   - 一条消息都没有 → `null`。
 *
 * 哈希的是**整条消息对象**（magpie 哈希的是那条消息的原始 JSON 字节），
 * 不是它的文本：消息里还带着工具调用、附件这些结构，它们同属一次对话。
 *
 * @param {Array<unknown>|null|undefined} messages
 * @returns {string|null} `magpie-<24 位 hex>`，没有消息就是 `null`
 */
export function conversationIdOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) {
    // ★ 铁律落点②：没有消息就没有可派生的身份，返回 null。
    return null;
  }
  let anchor = null;
  for (const m of list) {
    if (m && typeof m === "object" && !Array.isArray(m) && m.role === "user") {
      anchor = m;
      break;
    }
  }
  if (anchor === null) anchor = list[0];
  if (anchor === null || anchor === undefined) return null;
  let bytes;
  try {
    bytes = JSON.stringify(anchor);
  } catch {
    // 循环引用等病态输入：算不出锚点就不给 id（宁可没有，不要编一个）。
    return null;
  }
  if (typeof bytes !== "string") bytes = String(anchor);
  const sum = createHash("sha256").update(bytes, "utf8").digest();
  return DERIVED_PREFIX + sum.subarray(0, DERIVED_HASH_BYTES).toString("hex");
}

/**
 * 这个 id 是不是**真会话 id**（而不是派生出来的）。
 *
 * 判据只有形状：派生 id 恒为 `magpie-` + 24 位小写 hex（`conversationIdOf` 的
 * 产物），别的都是真 id。magpie 那边是**两套机制**分开的：原生会话优先，
 * 派生出来的会话投影被省掉（`usage.GatewaySessions` 用 nativeKeys 抑制重复的
 * 投影行）。这里用形状把同一个区分做出来。
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isNativeSession(id) {
  if (typeof id !== "string") return false;
  const t = id.trim();
  if (!t) return false;
  return !DERIVED_ID_RE.test(t);
}

/**
 * 账本 / 路由里的会话键：agent 与 id 合成。
 *
 * 对应 magpie 的 `AgentOf(record.Agent) + record.Session`
 * （docs/subsystems/gateway-sessions.md 第 5 行），实现上就是
 * `Agent + "|" + ID`（usage/gateway_sessions.go:72、gui/sessions.go:105 等处
 * 一律用这个 `|` 拼法当 map 的键）。
 *
 * 为什么要 agent 参与：会话 id **只在它自己的 agent 里唯一**。Codex 的
 * `abc` 和 Claude Code 的 `abc` 是两回事，同 agent 的两个 `abc` 才可能是一回事。
 *
 * 缺 agent 或缺 id 一律 `null`（★ 铁律落点③）：半个身份拼出来的键是一个
 * 编造出来的身份，比没有键更糟。
 *
 * @param {string} agent
 * @param {string} id
 * @returns {string|null} `agent|id`，缺一个就是 `null`
 */
export function sessionKey(agent, id) {
  const a = typeof agent === "string" ? agent.trim() : "";
  const i = typeof id === "string" ? id.trim() : "";
  if (!a || !i) return null;
  return a + "|" + i;
}
