// src/server/chat-protocol.mjs —— OpenAI Chat Completions 入向协议桥
//
// ## 补的是哪个洞
//
// 统一网关的入向只认三种话：Anthropic（Claude Code / 桌面版）、Responses（Codex）、
// Gemini（Gemini CLI）。但 **OpenAI Chat Completions** 这一族客户端最广 —— magpie
// 支持的 66 个 agent 里，**40 多个**说的是这一种话：
//
//   Qoder / Qoder CN、ZCode、Kimi Code、Qwen Code、MiniMax Code、CodeBuddy、
//   WorkBuddy、Droid、Cline、jcode、Goose、Crush、Pi、omp、StepCode、Aside、OmO、
//   Prime Agent、MothX、OpenCode、OpenChamber、MiMo、DevEco、Hermes、Muse Code、
//   Empryo、Ante、fx、Devin、Command Code、DeepSeek Harness、Reasonix、Cursor CLI、
//   Copilot CLI、Antigravity、Grok Build/App、AtomCode、Snow CLI ……
//
// 它们**连不上**本机网关：入口根本不认这个路径。
//
// 本模块是 `src/server/ir.mjs` 的**第三条腿**（Anthropic / Responses / Gemini 之外）：
//
//   · 入向 `parseChat(body)`          —— Chat 请求体 → IR（ir.mjs 早有，这里只是接上）
//   · 出向 `buildAnthropic(ir)`       —— IR → Anthropic 形状（交给中转，与另两条路同一套）
//   · 流式 `chatStreamDecoder(opts)`  —— 上游 Anthropic SSE → Chat SSE
//   · 非流式 `buildChatResponse(res)` —— IR 应答 → Chat 响应体
//
// ## 为什么零件大半是现成的
//
// `ir.mjs` 里 `parseChat` / `buildChat` / `chatDecoder` / `chatEncoder` / `renderChat`
// **早就在**（它们是「上游说 chat」那一侧用得着的）。早先没人给它们配一个**入向**，
// 于是这一族客户端一直连不上。这一模块做的事是：**把现成的零件按 Responses 那条路
// 的样子接起来**，不是另起炉灶。
//
// ## 与 magpie 的对应
//
// magpie `internal/gateway/chat.go` + `internal/gateway/ir.go` 的 Chat 那一对。
// magpie 把它做成「网关原生方言」（它的 Chat 路径就是主路径），本仓是「协议桥的
// 第三条腿」—— 结构一样：**入向解析 → IR → Anthropic 形状 → 交给中转**，回程再翻回来。
//
// ## 与 magpie **有意不同**的地方
//
//   ① **会改变语义、而我们做不到的 Chat 字段，我们报错**（magpie 是静默丢掉）：
//      `n>1`（多候选）、`logprobs`（拿不到 log概率）、`modalities` 里的 audio、
//      `audio` 参数、`prediction`（预测输出）。
//      理由与 Responses 那条路一致（见 responses.mjs）：丢掉之后客户端拿到的是
//      **一个看着正常、其实答的是另一个问题**的回复；报错至少让它知道自己没被接住。
//   ② **不影响正确性的采样参数我们忽略**（`temperature`/`top_p`/`stop`/`seed`/
//      `frequency_penalty`/`presence_penalty`/`logit_bias`/`user`/`stream_options`）。
//      Chat 的可选参数太多，逐个报错会让客户端**连都连不上** —— 那比少一个
//      采样参数糟糕得多。这一条与 ① 的界线是：**丢了会不会让回答变样**。
//      ⚠ 被忽略的字段在这里**逐个列明**，不是「悄悄」——「不静默丢字段」的纪律是
//      「知道自己丢了什么」，不是「一个字段都不许丢」。
//   ③ **上游一律是 Anthropic 形状**（与 Responses 那条路同一口径）：协议桥
//      （wb/qd/or/zen）已经在中转里把上游的 chat 形状翻成了 Anthropic；直连渠道
//      （bai/sn）本来就是 Anthropic。所以这里的解码器只接 Anthropic SSE。
//
// ## 工具调用 id 的往返（一个容易踩的坑）
//
//   客户端发 `tool_call_id: C` → IR 存 C → 发给上游时 `buildAnthropic` 把它安全化
//   （`anthropicOutID`）成 `mp_…` → 上游回 `mp_…` → 我们要**还原成 C** 再给客户端，
//   否则客户端下一轮发回来的 id 我们对不上（工具结果配不上对，模型会一直等）。
//   Anthropic 那条路靠 `renderAnthropic` 里的 `anthropicOutID` 兜住；
//   Chat 这条路没有那一层（`renderChat` 直接用 `p.id`），所以**本模块负责还原**。
//
// ## 纪律
//
//   · 纯 ESM、零依赖（除 `ir.mjs`）、零 IO、零时钟（时间由 `opts.now` 传入）。
//   · 非流式与流式同源：非流式的响应体就是同一套 IR 结果渲染出来的。

import {
  EV,
  parseChat, buildAnthropic, anthropicDecoder, chatEncoder, renderChat,
  anthropicInID, anthropicOutID,
} from "./ir.mjs";

/* ------------------------------------------------------------------ *
 * 一、我们做不到、而丢了会让回答变样的 Chat 字段
 * ------------------------------------------------------------------ */

/**
 * unsupportedChatField —— 扫一遍请求体，挑出「我们做不到、而丢掉会让回答变样」
 * 的字段。
 *
 * 返回空串是「没问题」，返回非空是一句能给人看的错。
 *
 * ⚠ 这里**只挑会改变语义的那几个**，不是「不认识就报错」：
 *   Chat 的可选参数有几十个（采样、日志、缓存、音频、预测输出……），逐个报错
 *   会让客户端**连都连不上**。界线是：**丢了会不会让这一轮答成另一个问题**。
 */
function unsupportedChatField(c) {
  if (typeof c.n === "number" && c.n > 1) {
    return `unsupported: n=${c.n} —— 本地中转一次只回一条候选；请改发 n:1`;
  }
  if (c.logprobs === true || (typeof c.top_logprobs === "number" && c.top_logprobs > 0)) {
    return "unsupported: logprobs —— 本地中转不产��逐 token 的概率；请改发 logprobs:false";
  }
  if (c.audio) {
    return "unsupported: audio —— 本地中转只回文字，不回音频；请去掉 audio 段";
  }
  if (Array.isArray(c.modalities) && c.modalities.some((m) => String(m) === "audio")) {
    return "unsupported: modalities 里的 audio —— 本地中转只回文字；请只留 text";
  }
  if (c.prediction) {
    return "unsupported: prediction —— 本地中转承载不了预测输出（它省的是客户端那边的"
      + "解码开销，不影响回答内容，但客户端会按它自己的形状等结果）；请去掉 prediction";
  }
  return "";
}

/**
 * chatProtocol —— Chat Completions 的入向协议描述。
 *
 * 形状与 `responsesProtocol` / `geminiProtocol` 完全一致（`makeProtocolHandler`
 * 靠这些字段把「客户端的话」翻成 Anthropic 形状，再把回程翻回去）。
 */
export const chatProtocol = {
  id: "chat",
  label: "OpenAI Chat Completions",
  /* ⚠ **两个路径都认**：`/v1/chat/completions` 与 `/chat/completions`。
   *   差一个 `/v1` 不是小事 —— 客户端的 base_url 常常是「不带 /v1 的根地址」，
   *   它自己拼 `/chat/completions`；另一些是「带 /v1 的地址」拼 `/chat/completions`。
   *   只认一个，那一半客户端连不上（magpie 也是两个都答：
   *   internal/gateway/gateway.go:698-699）。 */
  match: (path, method) => method === "POST"
    && (path === "/v1/chat/completions" || path === "/chat/completions"),
  /* 模型名在请求体的 `model` 字段里（与 Responses 一样，不在路径里）。 */
  modelIdOf: (path, body) => (body && typeof body.model === "string" ? body.model : ""),
  parse: (body) => {
    const p = parseChat(body);
    if (!p || p.ok === false) return p;
    const bad = unsupportedChatField(body);
    if (bad) return { ok: false, error: bad };
    return p;
  },
  /* 翻成 Anthropic 形状交给中转 —— 与另两条路**同一个**中转 handler，
     所以「到了那家之后」的行为逐字相同（一样的模型解析、一样的故障转移）。 */
  toAnthropic: (ir) => buildAnthropic(ir),
  /* 流不流由请求体的 `stream` 说了算（Chat 的模型名与流标志都在请求体里）。 */
  streamingOf: (ir) => !!(ir && ir.stream),
  /* ⚠ 上游**一律是 Anthropic 形状**（理由见文件头 ③），所以这里接 Anthropic SSE。 */
  decoder: (opts) => chatStreamDecoder(opts),
  buildJson: (ir, opts) => buildChatResponse(ir, opts),
  errorBody: (message, status) => ({
    error: {
      message: String(message || ""),
      type: Number(status) >= 500 ? "server_error" : "invalid_request_error",
      code: Number(status) || 500,
    },
  }),
};

/* ------------------------------------------------------------------ *
 * 二、流式：上游 Anthropic SSE → Chat SSE
 * ------------------------------------------------------------------ */

/**
 * chatStreamDecoder —— 上游的流 → Chat Completions 的 SSE。
 *
 * 内部先用 `ir.mjs` 的 `anthropicDecoder` 把上游的流变成 IR 事件，再用
 * `chatEncoder` 变成 Chat 的 SSE——**一条事件管道**，不是两套拼装逻辑
 * （与 `responsesDecoder` 同一写法）。
 *
 * `decode(text)` 收的是**原始 SSE 文本**，可以是一整段，也可以是任意切开的几段。
 */
export function chatStreamDecoder(opts = {}) {
  const dec = anthropicDecoder();
  const enc = chatEncoder(opts);
  return {
    /** decode —— 收一段上游的原始 SSE 文本，给出这一段带来的 Chat SSE。 */
    decode(text) {
      let out = "";
      for (const ev of dec.decode(text)) out += enc.event(restoreCallID(ev)) || "";
      return out;
    },
    /** flush —— 流结束，把还攒着的半行交出去，并收尾（末尾是 `data: [DONE]`）。 */
    flush() {
      let out = "";
      for (const ev of dec.flush()) out += enc.event(restoreCallID(ev)) || "";
      out += enc.flush();
      return out;
    },
  };
}

/**
 * restoreCallID —— 把工具调用 id 还原成客户端自己编的那个。
 *
 * 客户端发 `call_abc` → 我们发给上游时安全化成 `mp_…`（Anthropic 只收
 * `[A-Za-z0-9_-]`）→ 上游回 `mp_…` → 这里还原成 `call_abc`。
 * 不还原的话，客户端下一轮发回来的 `tool_call_id` 我们对不上，工具结果配不上对。
 */
function restoreCallID(ev) {
  if (ev && ev.kind === EV.TOOL_START && ev.id) ev.id = anthropicInID(ev.id);
  return ev;
}

/* ------------------------------------------------------------------ *
 * 三、非流式：IR 应答 → Chat 响应体
 * ------------------------------------------------------------------ */

/**
 * buildChatResponse —— IR 的**结果** → Chat 的非流式响应体。
 *
 * res 的形状就是 `ir.mjs` 里 `collector().finish()` 的结果：
 * `{ id, model, parts, stop, usage }`（`parseAnthropicResponse` 也产出同一形状）。
 * 这样非流式与流式同源——流式那边的输出项也是同一套 IR 结果装配出来的。
 */
export function buildChatResponse(res, opts = {}) {
  const body = renderChat(res, opts.model);
  /* `renderChat` 把 `created` 写死成 0（ir.mjs 不读时钟）。这里补上调用方给的时间。 */
  body.created = Number(opts.now) || 0;
  /* 工具调用 id 还原（与流式那侧同一件事，见 restoreCallID）。 */
  const msg = body.choices && body.choices[0] && body.choices[0].message;
  if (msg && Array.isArray(msg.tool_calls)) {
    for (const c of msg.tool_calls) if (c && c.id) c.id = anthropicInID(c.id);
  }
  return body;
}

/* ------------------------------------------------------------------ *
 * 四、模型清单（统一网关的 GET /v1/models）
 * ------------------------------------------------------------------ */

/**
 * chatModelsPayload —— 统一网关的模型清单，**一个形状同时满足两边**。
 *
 * OpenAI 侧读 `data[].object` 与 `data[].id`；Anthropic 侧读 `data[].type` 与
 * `data[].created_at`。两家读的字段不一样，但**多写的字段没人管**——所以两份
 * 都放，一份响应两种客户端都能用（少一份就有一边连不上）。
 *
 * entries：`[{ id: "sn/claude-opus-5", ownedBy: "sn", displayName: "Claude Opus 5" }]`
 */
export function chatModelsPayload(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return {
    object: "list",
    data: list.map((e) => ({
      id: String(e.id || ""),
      /* OpenAI 侧 */
      object: "model",
      created: 0,
      owned_by: String(e.ownedBy || ""),
      /* Anthropic 侧 */
      type: "model",
      created_at: "1970-01-01T00:00:00Z",
      display_name: String(e.displayName || e.id || ""),
    })),
    /* Anthropic 侧的分页字段 */
    has_more: false,
  };
}

/* ------------------------------------------------------------------ *
 * 六、给接线层用的小工具
 * ------------------------------------------------------------------ */

/**
 * chatSafeCallID —— 一个工具调用 id 出站时的安全化（与 Anthropic 那条路同一套）。
 *
 * 接线层（比如替某个客户端写配置）要给上游一个能认的 id 时用这个。
 */
export { anthropicOutID as chatSafeCallID };
