/**
 * OpenCode Zen **逐模型能力探测**（T3+T6）
 *
 * ## 为什么要有这个模块
 *
 * `server.mjs` 里原有一行硬编码的白名单：
 *
 *     const ZEN_EXTERNAL_OK = new Set(["space-bunny-free"]);   // 注释写「实测 2026-10」
 *
 * 2026-10-12 用**同一把真 key** 复核（`.research/reports/T5-probe-result.md`）：
 * `space-bunny-free` 打 `/zen/v1/messages` 与 `/zen/v1/chat/completions` **都是 403
 * `FreeTierError`**，连付费模型都逐字相同。也就是**这行白名单今天一条都不成立**，
 * 而它让一个调不通的模型堂而皇之地躺在用户下拉框里。
 *
 * 结论不能由常量或注释里的历史结论决定，只能由**实测**决定——所以有了这个模块。
 * 「这个模型到底能不能调通 / 能不能用工具」这种问题，Claude Code 离了 tool_use
 * 基本没法干活，答错的代价是用户以为能用、实际每次都报错。
 *
 * ## 三个维度（一次检测，缓存复用）
 *
 * | 维度 | 判据 | 请求 |
 * |---|---|---|
 * | 外部可调 | 最小对话请求是否 2xx | 文本 + 一个合成工具 |
 * | 工具调用 | 是否回 `tool_calls` | 同上（不额外发请求） |
 * | 图片输入 | 1×1 PNG data URL 是否被接受 | **先哨兵后真图**两发（它失败**不得**拖垮前两者） |
 *
 * ## 图片维度为什么必须先发哨兵（假阳性洞，v1.0.77 修）
 *
 * 原写法是「真图不报错 → 支持图片」。但**「没报错」不等于「解析过」**：一个把
 * image 字段整个忽略、照样回 200 的上游会被记成 `yes`——纯假阳性，用户据此选了
 * 一个根本看不了图的模型。对照**工具**维度就知道差距在哪：那边要求**真的看到
 * tool_use** 才记 `yes`，判据是正面的；图片维度却拿了「没报错」当正面证据。
 *
 * 修法（OW Bridge 同源思路，见 `.research/dsh-wb/src/probe.ts:159-199` 的哨兵设计，
 * 那边叫 `validation: 'validating' | 'non-validating'`）：
 *
 *   ① **哨兵**：先发一张**故意畸形**的图（`ZEN_PROBE_PNG_SENTINEL`，base64 根本
 *      不合法）。**被拒** → 这个字段是真的被解析了 → ② 那一发的 yes/no 才有意义。
 *   ② **真图**：只在哨兵被拒后才发。
 *   ③ 哨兵**被接受** → 说明判不出来（对什么都回 200）→ 记 `unknown` 并写明原因，
 *      **绝不记 yes**。
 *   ④ 哨兵被拒**不算失败**（它本来就该被拒），也不进 ok/tools 判定。
 *
 * ⚠️ 哨兵多花一次请求配额。只在用户显式点按钮、且只对 `-free` 模型时发生。
 *
 * ## 照抄 OW Bridge 的两条纪律（`.research/ow-bridge/src/`）
 *
 * ① **`calls:0` 只算观测，不算判决**（`model-status.js:14-26`）。
 *    「模型回了文本但没调工具，可能是没找到该调的机会」——所以 `tool_calls` 为 0
 *    一律记成 `tools:"unverified"`，**绝不**据此断言"不支持工具"。
 *    只有**信封层**的证据（上游拒收带 tools 的请求 / 响应里连 tool_calls 字段都没有）
 *    才判 `tools:"no"`（= OW 的 `formatUnsupported()` → chat-only）。
 *
 * ② **区分能力性错误与内容性错误**（`main.js:88`）。
 *    401/403/429/订阅缺失/余额不足 → **探不通**，如实标注；
 *    格式不合、内容截断、模型跑偏 → **只记录，不改判定**（`ok` 保持 `null` 未知，
 *    既不升也不降）。否则一次输出跑偏就误伤一个好模型。
 *
 * ## ⚠️ 探测请求的 max_tokens 陷阱（本模块存在的主要理由之一）
 *
 * 入口判定 `isProbe` 的**唯一**依据是 `max_tokens <= 8`（server.mjs 的
 * `isProbeRequest`）。而实测**部分模型拒 `max_tokens < 16`**（gpt-* 系一律回
 * 400 `Invalid request parameters`）。于是有两个必须同时成立的约束：
 *
 *   - 首轮用 `max_tokens: 8` → 走判据档，拿到 10 秒短超时与 429/500 退避重试；
 *   - 若**因为 max_tokens** 被拒，**重试 16**，但 **`isProbe` 必须仍是 true**。
 *
 * 本模块的写法是让 `isProbe` 成为 `send()` 的**显式第二参数**，由调用方（探针运行器）
 * 恒定传 `true`，**任何地方都不从 `body.max_tokens` 反推**。抬到 16 之后探测仍然是探测：
 * 短超时与重试一条都不少。反过来若为了迁就上游把 `max_tokens` 抬到 ≥16 却让
 * `isProbe` 变 false，探测就变成了真实对话——连带禁掉全部重试与短超时，**本末倒置**。
 *
 * ## 配额纪律
 *
 * - **只探免费模型**（id 含 `-free`）；付费模型一次请求都不发（探了要花钱）。
 * - **只在用户显式触发时跑**，本模块不注册任何定时器、没有任何后台调度。
 * - 并发上限 2，单探针超时 10 秒（复用 isProbe 档位）。
 * - 会话 id 固定 `bai-probe`（复用 server.mjs 的 zenSessionId），**不每探一次造一个新会话**。
 *
 * 本模块**不含任何网络代码**：HTTP 由调用方注入 `send()`，所以它可以被测试直接求值，
 * 断言的是仓库里这份代码本身而不是抄一份重写。
 */

import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

/* ---------- 常量 ---------- */

/** 探测会话 id：固定值。每次探测都造一个新会话等于凭空给上游灌会话记录，
 *  那正是官方点名监控滥用的东西。与 server.mjs 的 zenSessionId(isProbe=true) 同值。 */
export const ZEN_PROBE_SESSION = "bai-probe";

/** 首轮 max_tokens。刻意取 8：<= 8 是入口 `isProbe` 的判据，探测因此拿到短超时与重试。 */
export const ZEN_PROBE_MAX_TOKENS = 8;

/** 抬到 16 后重试（实测 gpt-* 系拒 <16）。**只抬这一处，且不抬 isProbe。** */
export const ZEN_PROBE_MAX_TOKENS_RETRY = 16;

/** 与 openaiExchange 的 `isProbe ? 10000 : 30000` 同一个短超时档位。 */
export const ZEN_PROBE_TIMEOUT_MS = 10000;

/** 并发上限。硬编码在这里而不是由调用方传，是为了让「并发不超过 2」可被断言。 */
export const ZEN_PROBE_CONCURRENCY = 2;

/** 1×1 透明 PNG（67 字节）。图片维度只问「上游收不收」，不关心内容。 */
export const ZEN_PROBE_PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * 哨兵：**故意畸形**的图片，base64 载荷根本不是合法 base64（`!` 不在 base64 字母表里）。
 *
 * 它唯一的作用就是「让上游拒掉」：一个真的解析 image 字段的上游，在解码这一步
 * 就必然报错。**能拒它**，才说明这个字段不是摆设，后一发的 yes/no 才可信。
 *
 * 反过来，**收了它**（2xx）说明这个上游对什么都回 200——那种情况下真图那发
 * 无论成功还是失败都只是噪声，所以记 `unknown`，绝不记 `yes`。
 */
export const ZEN_PROBE_PNG_SENTINEL =
  "data:image/png;base64,!!!not-valid-base64!!!";

/** 最简单的合成工具：一个无副作用的单参数函数。 */
export const ZEN_PROBE_TOOL = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: "probe_ping",
    description: "Report a value. Never has any side effect.",
    parameters: {
      type: "object",
      properties: { value: { type: "string", description: "The value to report." } },
      required: ["value"],
    },
  }),
});

/**
 * 同一个合成工具的 **Anthropic Messages 形状**（`/v1/messages` 用），语义与上面逐字一致。
 *
 * ⚠ 为什么要两种形状：`ZEN_PROBE_TOOL` 是 OpenAI 形状（`type/function/parameters`），
 *   能力探测走的是 openaiExchange → 上游 `/chat/completions`；而 `/api/test` 的连通性
 *   探测打的是本机中转的 `/v1/messages`，那边按 Anthropic 形状收（`name/input_schema`），
 *   再由 wbToOpenAI 转成 OpenAI 形状发给上游。**同一个字段名不能两用**——
 *   发错形状上游直接 400，于是「带工具」这个修复会自己把自己变成一次新的假阳性。
 *
 * 为什么 `/api/test` 也要带工具（v1.0.78）：Zen 免费档的围栏判据是
 * **「发给模型的请求里必须带工具」**。不带工具的探测请求会被同一个 FreeTierError 403 拒掉，
 * 于是**真实对话完全正常，面板却显示成红色故障**——探测方式造成的假阳性，不是渠道坏了。
 * Claude Code 的真实流量本来就带工具，所以带工具的探测才代表真实可用性。
 *
 * 刻意**不带** `tool_choice`：我们只想问「这个请求形状上游收不收」，**不想让模型真的去调工具**
 * （`required` 会逼出一段 tool_call，白花配额）。它回文本就够了——能返回就是通。
 */
export const ZEN_PROBE_TOOL_ANTHROPIC = Object.freeze({
  name: "probe_ping",
  description: "Report a value. Never has any side effect.",
  input_schema: Object.freeze({
    type: "object",
    properties: { value: { type: "string", description: "The value to report." } },
    required: ["value"],
  }),
});

/** 落盘文件名（DATA_DIR 下）。带时间戳的是**内容里的 at 字段**，不是文件名——
 *  固定文件名才能让「上次检测时间」有地方读。 */
export const ZEN_PROBE_FILE = "zen-capability.json";

/* ---------- 判定：能力性错误 vs 内容性错误（纪律②） ---------- */

/**
 * 把一次 HTTP 结果归类。
 *
 * 返回 `{ cls, reachable, why }`：
 *   · `cls`        归类标签，进 `why` 文案与落盘结果
 *   · `reachable`  **true** = 探不通（能力性错误，判定成立）
 *                 **false** = 探通了
 *                 **null**  = 内容性错误：**未知，不改判定**
 *
 * 纪律②就落在第三种返回值上：内容性错误不许把 ok 判成 false。
 */
export function zenProbeClassify(status, txt) {
  const s = Number(status) || 0;
  const t = String(txt || "");

  if (s >= 200 && s < 300) return { cls: "reachable", reachable: false, why: "" };

  /* —— 以下全部是**能力性错误**：说明这把 key / 这个模型调不通，如实标注 —— */
  // 免费档围栏 / 模型未授权 / 需订阅 —— 文案比状态码更可靠，两个端点的形状还不一样
  if (/An active OpenCode Go subscription is required/i.test(t))
    return { cls: "auth", reachable: true, why: "需要 OpenCode Go 订阅（上游原文 An active OpenCode Go subscription is required to use Go models.）。Key 已被上游正常解析，缺的是订阅本身。" };
  if (/FreeTierError|only be used from within/i.test(t))
    /* ⚠ 文案更正（v1.0.75，2026-10-12）：这里原先写「免费档被官方封死在 OpenCode 客户端内、
     * 换模型无效」——**那个说法是错的**，而且是我自己一次配错的实验造成的（探针会话用了全 deny
     * 权限）。实测证明判据是「发给模型的请求里必须带工具」：deny 会把工具从模型可见列表里
     * 整个摘掉，于是请求退化成「无工具推理」而被拒。`ask` 保留工具则一切正常。
     * 而本程序直连中转时请求里没有工具（执行权在 Claude Code 那边），所以走直连必然被拒。
     * 换模型确实无效，但「被封死」的说法会让人以为无解——它有解，见下。 */
    return {
      cls: "auth", reachable: true,
      why: "上游要求「发给模型的请求里必须带工具」（FreeTierError）。本程序直连中转时请求不带工具"
        + "——执行权在 Claude Code 那边，工具由它执行——所以走直连这一档必然被拒。"
        + "换模型无效；解法是改走 OpenCode 客户端中转（这样模型手上就有工具），或切到 Go 档。",
    };
  if (/Model access is disabled/i.test(t))
    return { cls: "auth", reachable: true, why: "该模型未对这把 Key 开放（上游 Model access is disabled）。" };
  if (s === 401 || s === 403)
    return { cls: "auth", reachable: true, why: `鉴权被拒（HTTP ${s}）——Key 无效或没有该模型的权限。` };

  // 额度 / 余额：等多久都不会恢复，和瞬时限流是两回事
  if (/FreeUsageLimitError|insufficient account funds|insufficient[_ ]quota|out of credits/i.test(t))
    return { cls: "quota", reachable: true, why: "这把 Key 的免费额度/余额已用尽（持续性，等多久都不会恢复）。" };
  if (s === 402)
    return { cls: "quota", reachable: true, why: "余额不足（HTTP 402）——付费模型需要先充值。" };
  // 429 一律算「探不通」：配额有限，宁可标成不可用也不要拿用户的钱反复试
  if (s === 429)
    return { cls: "rate_limit", reachable: true, why: "限流（HTTP 429）——本次探不通。注意这可能是瞬时的，隔一会儿重试可能就好了。" };

  if (s >= 500)
    return { cls: "upstream", reachable: true, why: `上游自身故障（HTTP ${s}）——不是你的配置问题。` };

  // 模型不在这一档的清单里 / 模型名不认
  if (/Model is unavailable|not supported|model_not_found|does not exist/i.test(t) || s === 404)
    return { cls: "unavailable", reachable: true, why: "该模型不在当前档位的清单里（免费档与 Go 档是两套独立目录）。" };

  /* —— 400 细分 —— */
  if (s === 400) {
    /* 顺序要紧：**先**判工具、**再**判 max_tokens。
     * 上游拒收带工具的请求时，文案往往也带 "Invalid request parameters"
     * （实测 "only auto supported tool_choice" 就是这么回的）。若顺序反过来，
     * 一次工具拒绝会被误当成"max_tokens 下限"去抬档重发——白花一份配额，
     * 而且第二次还是同样的拒绝，"仅对话"这个结论就永远出不来。 */
    if (/tool_choice|"tools"|tools is not|function calling|tool use/i.test(t))
      return { cls: "tool_format", reachable: null, why: `上游拒收带工具的请求（HTTP 400）——判为「仅对话」。${t.slice(0, 120)}` };
    // ⚠️ 探针参数不被接受（**不是**模型不可用）。实测 gpt-* 系一律回这个，
    //    所以这一类必须能触发 max_tokens 抬到 16 的重试，而不是直接判死。
    if (/Invalid request parameters|max_tokens|max_completion_tokens/i.test(t))
      return { cls: "probe_params", reachable: null, why: `探针参数不被接受（HTTP 400：${t.slice(0, 120)}）——这不是模型不可用，是上游有 max_tokens 下限。` };
    return { cls: "content", reachable: null, why: `上游以 400 拒绝了这次探测请求，但原因既不是鉴权也不是限流：${t.slice(0, 120)}` };
  }

  // 其余（含 404 之外的 3xx、无法归类的 4xx）：内容性，**不改判定**
  return { cls: "content", reachable: null, why: `HTTP ${s}，原因无法归类：${t.slice(0, 120)}` };
}

/** 网络层失败（超时 / 连不上）：探不通，但要说清是网络而不是模型。 */
export function zenProbeNetwork(reason) {
  return { cls: "network", reachable: true, why: `连不上上游（${String(reason || "网络错误").slice(0, 120)}）——不是模型的问题。` };
}

/* ---------- 预期内的产品级拒绝 ≠ 故障（v1.0.78） ---------- */

/** 「免费档 + 直连」这一组合的 kind 标签。面板据此**不**把它算成故障。 */
export const ZEN_FREE_TIER_DIRECT_KIND = "free_tier_direct";

/**
 * 判断一次失败是不是**产品级的预期拒绝**——即「这一档在这个传输方式下本来就会被拒」，
 * 而不是渠道坏了。
 *
 * ⚠ 分类**不另造一套**：`cls` 直接取自 `zenProbeClassify`，本函数只回答一个**新的**问题——
 *   「这个已经归好类的结果，要不要**升级成故障**？」
 *   归因（是什么错）与归责（算不算故障）是两件事，混在一起就会出现本次要修的那个现象：
 *   一条**已知且预期内**的拒绝被当成渠道故障，面板亮红灯，用户去查一个根本没坏的东西。
 *
 * 判据刻意很窄，**四个条件同时成立**才认：
 *   ① provider 必须是 zen —— **别的渠道的 403 照旧按故障报**（如 WorkBuddy 的令牌失效、
 *      模型未授权，那是真的坏了）。放宽这一条就会把真实故障洗成「预期内」，比原 bug 更危险。
 *   ② **状态码必须是 403** —— 上游只有这一条拒绝会带 FreeTierError。少了这道闸，一个碰巧
 *      复述了同样措辞的 401/429/500 也会被判成「预期内」，把真故障洗白。
 *   ③ 必须是免费档（isGo 为假）—— Go 档的 403 是「需要订阅」，另一条产品级限制，
 *      由 go_subscription_required 单独归因，不在这里吞掉。
 *   ④ 上游原文命中 FreeTierError / only be used from within —— 只认**文案**不认状态码，
 *      与本文件其余判据一致（两个端点的同一拒绝状态码并不统一）。
 *   ⑤ 直连传输 —— 走 OpenCode 客户端中转时模型手上就有工具，本来就不该被拒；
 *      那条路还报这个错就说明是真故障，绝不能被洗白。
 *
 * 返回 `{ expected, kind, cls, why }`。`expected` 为假时 `kind`/`why` 为空串——
 * 调用方据此走原来的故障分支，一行都不用改。
 */
export function zenExpectedRejection(status, txt, {
  provider = "zen", isGo = false, transport = "direct",
} = {}) {
  const base = { expected: false, kind: "", cls: "", why: "" };
  if (provider !== "zen") return base;
  if (Number(status) !== 403) return base;
  if (isGo) return base;
  if (transport !== "direct") return base;
  const t = String(txt || "");
  if (!/FreeTierError|only be used from within/i.test(t)) return base;
  return {
    expected: true,
    kind: ZEN_FREE_TIER_DIRECT_KIND,
    // cls 复用同一套分类，不重写：这里如实记成 auth（Key 没问题，是这一档在直连下被围栏拒）。
    cls: zenProbeClassify(status, t).cls || "auth",
    why: "这一档在直连下本来就会被拒，不是渠道故障。"
      + "OpenCode Zen 免费档要求「发给模型的请求里必须带工具」；"
      + "本程序直连中转时执行权在 Claude Code 那边，请求不带工具，于是被同一个 FreeTierError 403 拒掉。"
      + "下一步二选一：①把传输方式切成「OpenCode 客户端中转」（需本机已装 OpenCode，npm i -g opencode-ai）；"
      + "②把上游地址改成 Go 档 https://opencode.ai/zen/go/v1 并订阅 OpenCode Go（$10/月，https://opencode.ai/auth），再点「刷新模型列表」。",
  };
}

/* ---------- 工具维度：calls:0 只算观测（纪律①） ---------- */

/**
 * 从响应里数出 tool_calls。两种信封都认：OpenAI 的
 * `choices[0].message.tool_calls`，Anthropic 的 `content[].type === "tool_use"`。
 * 返回 `{ calls, envelope }`；`envelope` 用来回答「上游到底有没有给工具调用这个位置」。
 */
export function zenProbeToolCalls(j) {
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  if (msg && Array.isArray(msg.tool_calls)) return { calls: msg.tool_calls.length, envelope: "openai" };
  const content = j && Array.isArray(j.content) ? j.content : null;
  if (content) return { calls: content.filter((c) => c && c.type === "tool_use").length, envelope: "anthropic" };
  if (msg) return { calls: 0, envelope: "none" };      // 有 message 但没有工具调用这个位置
  return { calls: 0, envelope: "none" };
}

/** 一次响应的综合解析。 */
export function zenProbeReadResponse(status, txt) {
  const c = zenProbeClassify(status, txt);
  let json = null;
  if (c.reachable === false) { try { json = JSON.parse(String(txt || "")); } catch { json = null; } }
  const tc = json ? zenProbeToolCalls(json) : { calls: 0, envelope: "none" };
  return { ...c, json, calls: tc.calls, envelope: tc.envelope };
}

/* ---------- 图片维度：哨兵前置校验 ---------- */

/**
 * 哨兵一发的判定：这一次畸形图，**到底证明了什么**。
 *
 * 返回 `{ parsed, why }`，三态是刻意的：
 *   `true`   **解析了**——上游拒了这张不可能存在的图 → 真图那一发的 yes/no 有意义
 *   `false`  **没解析**——上游 2xx 收了 → 它对什么都回 200，判不出来 → 记 unknown
 *   `null`   **无法验证**——拒绝原因与图片无关（鉴权/额度/限流/上游故障/网络），
 *            或根本读不出进程外信息。此时也记 unknown，且**绝不**升级成 yes。
 *
 * ⚠️ `false` 那个分支就是原假阳性的堵口：旧写法在这里直接把真图那发的 2xx 记成
 *    「支持图片」，于是「忽略 image 字段的上游」被误判成支持图。绝不能退化回去。
 */
export function zenProbeImageSentinel(status, txt) {
  const c = zenProbeClassify(status, txt);
  if (c.reachable === false) {
    return {
      parsed: false, cls: c.cls,
      why: "哨兵校验未通过：上游把一张**故意畸形的图片**也照收不误（HTTP 2xx）——"
        + "说明它根本没解析 image 字段，对任何内容都回 200。这种上游的探测结果判不出来，"
        + "本次不记「支持图片」（宁可未知，也不要一个假阳性）。",
    };
  }
  /* 拒绝原因与图片无关 → 说明不了字段有没有被解析 → 无法验证，仍不记 yes。 */
  if (["auth", "quota", "rate_limit", "upstream", "network"].includes(c.cls)) {
    return {
      parsed: null, cls: c.cls,
      why: `哨兵无法验证：畸形图确实被拒了，但原因与图片无关（${c.cls}）——${c.why}判不出这个上游是否真的解析 image 字段，本次不记「支持图片」。`,
    };
  }
  /* 拒在内容/参数层（content、probe_params 等）= 上游真的去解这张图了。 */
  return { parsed: true, cls: c.cls, why: `哨兵按预期被拒（${c.cls}）——image 字段确实被解析。` };
}

/* ---------- 判定合成 ---------- */

/**
 * 把三个维度的观测合成一条结论。
 *
 * `ok` 的三态是有意的：
 *   `true`  探通了（有 2xx 为证）
 *   `false` 探不通（能力性错误，纪律②要求如实标注）
 *   `null`  **未知**——只撞上内容性错误。null **不改判定**：调用方据此保留原有结论。
 *
 * `tools` 的三态同样是有意的：
 *   `"yes"`         真拿到了 tool_calls
 *   `"no"`          **信封层**证据判定的 chat-only（OW 的 formatUnsupported）
 *   `"unverified"`  没观察到调用 —— 这是**观测**，不是判决
 */
export function zenProbeVerdict({ chat, tools, image } = {}) {
  const rec = {
    ok: chat && chat.reachable === false ? true : (chat && chat.reachable === true ? false : null),
    cls: (chat && chat.cls) || "unprobed",
    why: (chat && chat.why) || "",
    tools: "unverified",
    calls: tools ? tools.calls : 0,
    envelope: tools ? tools.envelope : "none",
    image: image || "unknown",
  };
  if (tools) {
    /* 判「仅对话」只有一种依据：**上游拒收带工具的请求**（OW 的 formatUnsupported）。
     * 反过来，「回了文本、tool_calls 为 0」**不是**判「仅对话」的依据——那是纪律①说的
     * 「没找到该调的机会」，只记观测（unverified）。曾经在这里多写一条
     * `envelope === "none" → no`，那会把每一个只回文本的好模型误标成仅对话，
     * 正好是纪律①要防的那件事。 */
    if (tools.cls === "tool_format") {
      rec.tools = "no";
      /* 参数级拒绝**不是**内容性错误：上游能对"带 tools 的这个请求"给出针对性答复，
       * 说明它解析了请求、鉴权也过了——端点是通的，只是这个信封装不下工具。
       * 纪律②针对的是内容跑偏/截断那种，不是这种。所以这里可以安全地判 ok=true。 */
      if (rec.ok === null) { rec.ok = true; rec.cls = "tool_format"; rec.why = tools.why; }
    } else if (tools.cls === "reachable" && tools.calls > 0) rec.tools = "yes";
    else rec.tools = "unverified";                                  // calls:0 —— 只算观测
  }
  rec.label = zenCapLabel(rec);
  return rec;
}

/**
 * 面板文案。与 OW Bridge 的措辞一致（它用的是「可用 · 仅对话」）。
 *
 * `ok === null`（撞上内容性错误，纪律②要求**不改判定**）单独占两个标签：
 * 它既不是「可用」也不是「探不通」。若图省事把它显示成「探不通」，
 * 一次模型输出跑偏就会把一个好模型从下拉框里踢掉——那正是纪律②要防的事。
 */
export function zenCapLabel(rec) {
  if (!rec) return "未检测";
  if (rec.ok === true) {
    if (rec.tools === "yes") return "可用 · 支持工具";
    if (rec.tools === "no") return "可用 · 仅对话";
    return "可用 · 工具未验证";
  }
  if (rec.ok === false) return "探不通";
  return rec.cls === "probe_params" ? "未判定 · 探针参数被拒" : "未判定";
}

/** 给「工具未验证」补一句人话，别让用户以为我们测出来它不会调工具。 */
export function zenCapHint(rec) {
  if (!rec) return "";
  if (rec.ok === null) {
    return `本次探测没能得出结论（${rec.why || "上游既没成功也没给出可归因的错误"}）。`
      + "按 OW Bridge 的同一条纪律，这种结果**只记录、不改判定**——原结论保留，不把这个模型踢出下拉框。";
  }
  if (rec.ok !== true) return rec.why || "";
  if (rec.tools === "unverified") {
    return "本次探测没有观察到工具调用，但这**不等于**不支持工具——模型可能只是没找到该调的机会"
      + "（OW Bridge 的同一条纪律：calls:0 只算观测，不算判决）。需要工具请在真实对话里试一次。";
  }
  return rec.why || "";
}

/* ---------- 目标筛选 + 并发 ---------- */

/** 只探免费模型。付费模型**一次请求都不许发**（探了要花钱）。 */
export function zenProbeTargets(catalog) {
  const list = Array.isArray(catalog) ? catalog : [];
  return list.map((id) => String(id || "").trim()).filter(Boolean).filter((id) => id.includes("-free"));
}

/**
 * 固定并发的 worker 池。`limit` 有硬上限（ZEN_PROBE_CONCURRENCY），调用方传再大也压不下去。
 * 顺带返回 `peak`，让测试能断言"并发不超过 2"——只断言"跑完了"证明不了这件事。
 */
export async function zenProbePool(items, worker, limit = ZEN_PROBE_CONCURRENCY) {
  const cap = Math.max(1, Math.min(Number(limit) || ZEN_PROBE_CONCURRENCY, ZEN_PROBE_CONCURRENCY));
  const out = new Array(items.length);
  let next = 0;
  let live = 0;
  let peak = 0;
  const run = async () => {
    live++;
    if (live > peak) peak = live;
    try {
      for (;;) {
        const i = next++;
        if (i >= items.length) break;
        out[i] = await worker(items[i], i);
      }
    } finally {
      live--;
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, items.length || 1) }, run));
  return { out, peak };
}

/* ---------- 单模型探测（含 max_tokens 抬档） ---------- */

/** 构造请求体。工具维度与可达维度**共用同一个请求**（配额有限，不为一个问题发两次）。
 *
 * `png` 只给图片维度用：默认是那张 1×1 透明图，哨兵那一发传 `ZEN_PROBE_PNG_SENTINEL`
 * （故意畸形）。**两者的报文形状完全一样**，只有那个 data URL 不同——哨兵要验的就是
 * 「同样的形状、换张坏图，上游会不会变脸」。 */
export function zenProbeBody(model, { maxTokens = ZEN_PROBE_MAX_TOKENS, image = false, tools = true, png = ZEN_PROBE_PNG_1PX } = {}) {
  const content = image
    ? [{ type: "text", text: "Reply with the single word: ok." },
    { type: "image_url", image_url: { url: png } }]
    : "Call the probe_ping tool with value \"ok\". Do not answer with plain text.";
  const b = { model, stream: false, max_tokens: maxTokens, messages: [{ role: "user", content }] };
  if (tools) {
    b.tools = [ZEN_PROBE_TOOL];
    // tool_choice:"required" = 给足一次明确的调用机会。OW Bridge 当年**弃用**它是因为
    // 它只验传输、验不出"模型会不会动手"；我们要问的是更窄也更硬的问题——
    // **响应信封里到底有没有 tool_calls 这个位置**，那正是 Claude Code 能不能干活的前提。
    b.tool_choice = "required";
    b.parallel_tool_calls = false;
  }
  return b;
}

/**
 * 探一个模型。返回三个维度的观测（不合成，合成留给 zenProbeVerdict）。
 *
 * ⚠️ `send` 的第二个参数 `isProbe` **恒为 true**，且**从不**从 `body.max_tokens` 反推。
 *    这是本模块最重要的一行代码：max_tokens 抬到 16 时 isProbe 仍然是 true，
 *    短超时与重试一条不少。反过来（抬高 max_tokens 却让 isProbe 变 false）会把
 *    探测变成真实对话，连带禁掉全部重试——**本末倒置**。
 */
export async function zenProbeOne(model, { send, imageSend } = {}) {
  const post = async (maxTokens) => {
    const body = zenProbeBody(model, { maxTokens });
    /* ↑ isProbe: 显式传 true，不靠 body 推导。这是本函数存在的理由。 */
    const r = await send(body, { isProbe: true });
    return { r, maxTokens, body };
  };

  let { r, maxTokens, body } = await post(ZEN_PROBE_MAX_TOKENS);
  let escalated = false;

  /* 探针参数不被接受（典型：上游有 max_tokens 下限，实测 gpt-* 系拒 <16）。
   * **这不是模型不可用**——所以这里只抬 max_tokens 重试一次，绝不据此判死。
   * 抬的只有 max_tokens，`isProbe` 照样显式传 true。
   * 判据必须先归类：send() 返回的是原始 {status,text}，没有 cls。 */
  if (zenProbeClassify(r.status, r.text).cls === "probe_params") {
    escalated = true;
    ({ r, maxTokens, body } = await post(ZEN_PROBE_MAX_TOKENS_RETRY));
  }

  const chat = zenProbeReadResponse(r.status, r.text);

  // 图片维度独立请求，且**失败不得拖垮前两者**（不支持图片的模型照样能对话）
  let image = "unknown";
  let imageWhy = "";
  /* ⚠️ 哨兵**多花一次请求**（配额纪律：只探 -free、只在用户点按钮时才跑）。
   *    这一发是图片维度唯一的真阳性保障，别为了省配额把它删掉。 */
  let sent = [body];
  if (typeof imageSend === "function") {
    const postImage = (png) => zenProbeBody(model, { maxTokens, image: true, tools: false, png });
    // ① 哨兵：故意畸形的图。能拒它，才说明这个字段是真的被解析了。
    let sv;
    try {
      const sb = postImage(ZEN_PROBE_PNG_SENTINEL);
      sent.push(sb);
      const sr = await imageSend(sb, { isProbe: true });
      sv = zenProbeImageSentinel(sr.status, sr.text);
    } catch (e) {
      sv = { parsed: null, cls: "network", why: zenProbeNetwork((e && e.message) || e).why };
    }

    if (sv.parsed !== true) {
      /* 哨兵被收了 / 无法验证 → 判不出来。**绝不记 yes**，也不浪费第二发去问一个
       * 注定没意义的问题——旧代码的假阳性正是从这一步直接跳到「2xx 即 yes」来的。 */
      image = "unknown";
      imageWhy = sv.why;
    } else {
      // ② 哨兵被拒 → 真图这一发才问「收不收」。哨兵被拒**不是失败**，它本来就该被拒。
      const ib = postImage(ZEN_PROBE_PNG_1PX);
      sent.push(ib);
      try {
        const ir = await imageSend(ib, { isProbe: true });
        const ic = zenProbeReadResponse(ir.status, ir.text);
        if (ic.reachable === false) image = "yes";
        else if (ic.cls === "content" || ic.cls === "probe_params") { image = "unknown"; imageWhy = ic.why; }
        else if (/image|vision|multimodal|multi-modal/i.test(ir.text || "")) { image = "no"; imageWhy = ic.why; }
        else { image = "unknown"; imageWhy = ic.why; }
      } catch (e) {
        image = "unknown";
        imageWhy = zenProbeNetwork((e && e.message) || e).why;
      }
    }
  }

  return {
    chat, image, imageWhy,
    tools: { cls: chat.cls, calls: chat.calls, envelope: chat.envelope, reachable: chat.reachable },
    maxTokens, escalated,
    /* 自证用：真实发出去的 body，测试据此断言 max_tokens ∈ {8,16} 且不含凭据 */
    sent,
  };
}

/* ---------- 落盘 ---------- */

export function zenProbePath(dataDir) { return path.join(dataDir || ".", ZEN_PROBE_FILE); }

/** 空结果（没探过 / 读不出来）。 */
function zenProbeEmpty(upstream, tier) {
  return { at: null, upstream: upstream || null, tier: tier || null, models: {} };
}

/**
 * 读缓存。**上游变了就整份作废**：免费档的结论不能拿去说明 Go 档，两档是两回事
 * （83 个 vs 38 个，连 FreeTierError 围栏的有无都不同）。
 */
export function zenProbeLoad(dataDir, upstream, tier) {
  let raw = null;
  try { raw = readFileSync(zenProbePath(dataDir), "utf8"); } catch { return zenProbeEmpty(upstream, tier); }
  let j = null;
  try { j = JSON.parse(raw); } catch { return zenProbeEmpty(upstream, tier); }
  if (!j || typeof j !== "object" || typeof j.models !== "object" || !j.models) return zenProbeEmpty(upstream, tier);
  if (upstream && j.upstream && j.upstream !== upstream) {
    return { ...zenProbeEmpty(upstream, tier), at: j.at || null, stale: true, staleFrom: j.upstream };
  }
  return { at: j.at || null, upstream: j.upstream || upstream || null, tier: j.tier || tier || null, models: j.models, stale: false };
}

export function zenProbeSave(dataDir, payload) {
  const f = zenProbePath(dataDir);
  try { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(payload, null, 2)); return true; }
  catch { return false; }
}

/* ---------- 编排 ---------- */

/**
 * 跑一轮完整检测。**只在用户显式触发时被调用**，本模块不注册任何定时器。
 *
 * `send` / `imageSend` 由 server.mjs 注入（真发 HTTP）；测试注入假的，
 * 于是「只探 -free / 并发 ≤2 / isProbe 恒 true」这几条都能在**真代码**上断言。
 */
export async function zenRunCapabilityProbe({ catalog, upstream, tier, dataDir, send, imageSend, onProgress } = {}) {
  const startedAt = new Date().toISOString();
  const targets = zenProbeTargets(catalog);
  const skippedPaid = (Array.isArray(catalog) ? catalog : []).map(String).filter((id) => id && !id.includes("-free"));

  let done = 0;
  const { out, peak } = await zenProbePool(targets, async (id) => {
    let obs = null;
    try {
      obs = await zenProbeOne(id, { send, imageSend });
    } catch (e) {
      obs = {
        chat: zenProbeNetwork((e && e.message) || e), tools: { cls: "network", calls: 0, envelope: "none", reachable: true },
        image: "unknown", imageWhy: "", maxTokens: ZEN_PROBE_MAX_TOKENS, escalated: false, sent: [],
      };
    }
    const rec = zenProbeVerdict(obs);
    rec.probedAt = new Date().toISOString();
    rec.maxTokens = obs.maxTokens;
    rec.escalated = !!obs.escalated;
    if (obs.imageWhy) rec.imageWhy = obs.imageWhy;
    done++;
    if (typeof onProgress === "function") onProgress({ id, done, total: targets.length, label: rec.label });
    return [id, rec];
  });

  const models = {};
  for (const pair of out) if (Array.isArray(pair)) models[pair[0]] = pair[1];
  const payload = { at: new Date().toISOString(), startedAt, upstream: upstream || null, tier: tier || null, models, peakConcurrency: peak };
  if (dataDir) zenProbeSave(dataDir, payload);
  return { ...payload, probed: targets.length, skippedPaid, peakConcurrency: peak };
}