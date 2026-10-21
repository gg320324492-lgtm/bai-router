// src/ir.mjs —— 统一协议中间表示（IR）
//
// 这套表示是 magpie `internal/gateway/ir.go` 的移植。移植它只有一个理由：
// **把协议差异收敛到一个地方**，而不是散落在每一条通道路径里。
//
// magpie 的四种协议（OpenAI Chat Completions / OpenAI Responses / Anthropic Messages /
// Gemini）彼此是近亲，但每家的叫法都不一样：工具调用在 Anthropic 是 content 里的
// `tool_use` 块、在 Chat 是 message 上的 `tool_calls` 数组、在 Gemini 是
// `functionCall`；思考块在 Anthropic 是 `thinking`、在 Chat 是 `reasoning_content`、
// 在 Gemini 是 `thought`。magpie 把这些全部落成同一批 Part，于是每个协议只需要
// 「解析进来」和「构造出去」两个方向的函数，共四对，而不是四×四。
//
// **流式与非流式共用一条事件管道**——这是 magpie 少写一半代码的关键。非流式不是另
// 写一遍，而是把上游的事件流装配成一个 Result 再渲染成整包 JSON。所以本模块的
// collector（事件流 → 结果）既是编码器的内部状态，也是非流式渲染的入口。
//
// 硬约束：
//   · 纯 ESM，零依赖，不碰 fs / 网络 / Date.now()（时间由调用方传入）。
//   · 签名（signature）与密封推理（sealed）**逐字节保留**——上游会校验，丢了就 400。
//   · 语义照抄 Go 版，不做「优化」。Go 里那些看着奇怪的规则多半是踩坑换来的。

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** Part.kind —— 一条消息里一个块的种类。全部协议差异的收敛点。 */
export const KIND = {
  TEXT: "text",
  IMAGE: "image",
  FILE: "file",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  THINKING: "thinking",
  SEARCH: "search",
};

/** Event.kind —— 流式回复里一件事的种类。 */
export const EV = {
  START: "start",        // MsgID、Model、Usage（输入侧）
  TEXT: "text",          // Text
  THINK: "think",        // Text（推理）
  SIG: "sig",            // Text（思考块的签名）
  TOOL_START: "tool_start",  // ID、Name
  TOOL_ARGS: "tool_args",    // Text（参数的半截 JSON）
  STOP: "stop",          // Stop
  USAGE: "usage",        // Usage
  ERROR: "error",        // Text
  SEARCH: "search",      // Text（检索词）、Hits（结果）
  IMAGE: "image",        // Name（媒体类型）、Text（base64）
  THINK_START: "think_start",  // 一段新的推理开始
  SEALED: "sealed",      // Text（上游密封的推理原文）、Name（哪个 API 封的）
  TEXT_SIG: "text_sig",  // Text（Gemini 的 thoughtSignature，挂在文本上）
  ALIVE: "alive",        // 什么都没说，只是上游还活着
};

/** 密封推理的归属 API。 */
export const SEAL_ANTHROPIC = "anthropic";
export const SEAL_RESPONSES = "responses";

/* ------------------------------------------------------------------ *
 * 构造器
 * ------------------------------------------------------------------ */

export function makePart(fields = {}) {
  return {
    kind: fields.kind || KIND.TEXT,
    text: fields.text || "",
    mediaType: fields.mediaType || "",
    data: fields.data || "",
    url: fields.url || "",
    id: fields.id || "",
    name: fields.name || "",
    args: fields.args === undefined ? null : fields.args,
    callId: fields.callId || "",
    isError: !!fields.isError,
    signature: fields.signature || "",
    sealed: fields.sealed || "",
    sealedBy: fields.sealedBy || "",
    hits: fields.hits || [],
  };
}

export function makeMessage(role, parts) {
  return { role, parts: parts || [] };
}

export function makeTool(fields = {}) {
  return {
    name: fields.name || "",
    description: fields.description || "",
    schema: fields.schema === undefined ? null : fields.schema,
    strict: !!fields.strict,
    deferred: !!fields.deferred,
  };
}

export function makeRequest(fields = {}) {
  return {
    model: fields.model || "",
    system: fields.system || "",
    messages: fields.messages || [],
    tools: fields.tools || [],
    toolChoice: fields.toolChoice || "",
    maxTokens: fields.maxTokens || 0,
    temp: fields.temp === undefined ? null : fields.temp,
    topP: fields.topP === undefined ? null : fields.topP,
    stop: fields.stop || [],
    stream: !!fields.stream,
    effort: fields.effort || "",
    thinking: !!fields.thinking,
    thinkOff: !!fields.thinkOff,
    parallel: fields.parallel === undefined ? null : fields.parallel,
    webSearch: !!fields.webSearch,
    fast: !!fields.fast,
    ultrafast: !!fields.ultrafast,
    tier: fields.tier || "",
    cacheKey: fields.cacheKey || "",
    include: fields.include || [],
    format: fields.format === undefined ? null : fields.format,
    namespaced: fields.namespaced || {},
    lastIsTurn: !!fields.lastIsTurn,
    resume: !!fields.resume,
    loadedInPlace: !!fields.loadedInPlace,
    grok: !!fields.grok,
  };
}

export function makeEvent(fields = {}) {
  return {
    kind: fields.kind || EV.TEXT,
    status: fields.status || 0,
    text: fields.text || "",
    id: fields.id || "",
    name: fields.name || "",
    msgId: fields.msgId || "",
    model: fields.model || "",
    stop: fields.stop || "",
    code: fields.code || "",
    requestId: fields.requestId || "",
    usage: fields.usage || emptyUsage(),
    hits: fields.hits || [],
    wait: fields.wait || 0,
    said: fields.said || "",
  };
}

/** Usage —— token 计数。字段名与 Go 的 json tag 同义，便于两边对照。 */
export function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    served: "",
    upstream: "",
    tier: "",
    stop: "",
    requestId: "",
    responseId: "",
    errType: "",
  };
}

/* ------------------------------------------------------------------ *
 * 共享工具 —— parse 与 build 两侧都用它们
 * ------------------------------------------------------------------ */

/**
 * stringOrText —— 一个可能是字符串、也可能是 Anthropic 那种
 * `[{type:"text",text:…}]` 块数组的值，取成字符串。
 */
export function stringOrText(raw) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  let b = "";
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    switch (x.type) {
      case "text":
      case "input_text":
      case "output_text":
        if (typeof x.text === "string") b += x.text;
        break;
      case "tool_reference":
        // Claude Code 的 ToolSearch 加载了一个延迟工具：每个工具都已经以别处
        // 报给过模型，所以这里只告诉模型「这个工具在」，而不是塞一个空结果
        if (b.length > 0) b += "\n";
        b += `[The tool "${x.tool_name || ""}" is available.]`;
        break;
      default:
        break;
    }
  }
  return b;
}

/**
 * toolOutput —— 一个工具结果：它的文本，外加它带的图片。
 * Anthropic 的 tool_result 装图片块，Chat 的 tool 消息装 image_url 段。
 */
export function toolOutput(raw) {
  const text = stringOrText(raw);
  const images = [];
  if (Array.isArray(raw)) {
    for (const b of raw) {
      if (!b || typeof b !== "object") continue;
      switch (b.type) {
        case "image": {
          const s = b.source || {};
          if (s.data) images.push(makePart({ kind: KIND.IMAGE, mediaType: s.media_type || "", data: s.data }));
          else if (s.url) images.push(makePart({ kind: KIND.IMAGE, url: s.url }));
          break;
        }
        case "input_image":
        case "image_url": {
          const u = typeof b.image_url === "string" ? b.image_url : (b.image_url && b.image_url.url) || "";
          if (u) images.push(imagePart(u));
          break;
        }
        default:
          break;
      }
    }
  }
  return { text, images };
}

/** imagePart —— 一个 data: URL 拆成内联图片，一个普通 URL 原样留着。 */
export function imagePart(url) {
  const u = String(url || "");
  if (u.startsWith("data:")) {
    const i = u.indexOf(",");
    if (i > 0) {
      const meta = u.slice(5, i);
      const mediaType = meta.replace(/;base64$/, "");
      return makePart({ kind: KIND.IMAGE, mediaType, data: u.slice(i + 1) });
    }
  }
  return makePart({ kind: KIND.IMAGE, url: u });
}

/** dataURL —— 图片块还原成 data: URL。 */
export function dataURL(part) {
  if (part.url && !part.data) return part.url;
  return `data:${part.mediaType};base64,${part.data}`;
}

/** textOf —— 一条消息里所有文本块拼起来。 */
export function textOf(parts) {
  let b = "";
  for (const p of parts || []) if (p.kind === KIND.TEXT) b += p.text || "";
  return b;
}

/** argsOf —— 一个工具调用的参数，永远是个对象（没有就是 {}）。 */
export function argsOf(part) {
  const a = part && part.args;
  if (a === undefined || a === null) return {};
  if (typeof a === "string") {
    const s = a.trim();
    return s ? s : {};
  }
  return a;
}

/** argsString —— 同上，但给要字符串的 API（Chat 的 arguments 字段）。 */
export function argsString(part) {
  const a = argsOf(part);
  if (typeof a === "string") return a;
  return JSON.stringify(a);
}

/**
 * parseArgs —— 参数的字符串形式转成对象。**不是 JSON 的字符串**被包成
 * `{"input": s}`，这样一个非 JSON 的参数不会凭空丢掉内容。
 */
export function parseArgs(s) {
  const t = String(s === undefined || s === null ? "" : s).trim();
  if (!t) return {};
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      return { input: t };
    }
  }
  return { input: t };
}

/** effortOf —— 各家推理档位的名字归一。 */
export function effortOf(s) {
  switch (String(s || "").trim().toLowerCase()) {
    case "minimal":
    case "none":
      return "low";
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return String(s).trim().toLowerCase();
    case "ultra": // Codex 的 max，它给自己的 agent 派活时用
      return "max";
    default:
      return "";
  }
}

/** budgetOf —— 一个档位对应的 Anthropic 思考预算。 */
export function budgetOf(effort) {
  switch (effort) {
    case "low": return 4096;
    case "medium": return 10000;
    case "high": return 24000;
    case "xhigh":
    case "max": return 32000;
    default: return 10000;
  }
}

/** effortOfBudget —— 思考预算反推档位。 */
export function effortOfBudget(n) {
  if (!n || n <= 0) return "";
  if (n <= 4096) return "low";
  if (n <= 12000) return "medium";
  if (n <= 24000) return "high";
  return "xhigh";
}

/** stopFromAnthropic —— Anthropic 的 stop_reason 归一成 IR 的 stop。 */
export function stopFromAnthropic(s) {
  switch (s) {
    case "max_tokens":
    case "model_context_window_exceeded":
      // 后者是 Claude 4.5+ 在 max_tokens 之前撞上上下文窗口：回复照样是截断的
      return "length";
    case "tool_use":
      // 一个 Anthropic 形状的中转在别家模型前面，照传 OpenAI 的理由
    case "tool_calls":
    case "function_call":
      return "tool";
    case "length":
      return "length";
    case "refusal":
    case "content_filter":
      return "filter";
    default:
      return "stop";
  }
}

/** stopToAnthropic —— IR 的 stop 转回 Anthropic 的 stop_reason。 */
export function stopToAnthropic(s) {
  switch (s) {
    case "length": return "max_tokens";
    case "tool": return "tool_use";
    case "filter": return "refusal";
    default: return "end_turn";
  }
}

/** stopToChat —— IR 的 stop 转成 Chat 的 finish_reason。 */
export function stopToChat(s) {
  switch (s) {
    case "length": return "length";
    case "tool": return "tool_calls";
    case "filter": return "content_filter";
    default: return "stop";
  }
}

/** hasCalls —— 一组块里有没有工具调用。 */
export function hasCalls(parts) {
  for (const p of parts || []) if (p.kind === KIND.TOOL_CALL) return true;
  return false;
}

/**
 * joinSplitCalls —— 把 assistant 消息接到它前面那条 assistant 消息上，
 * 当后者调了工具时。Anthropic 的 Messages 把连续的 assistant 消息当成一轮，
 * 而 agent 可能把一轮里并行的 tool_use 拆到两条 assistant 消息上（#1275）。
 * 一个在下一个 assistant 消息处就收尾一轮的构造器，会把前几个调用当成被打断的，
 * 丢掉它们真正的结果。
 */
export function joinSplitCalls(messages) {
  const out = [];
  for (const m of messages || []) {
    const n = out.length;
    if (n > 0 && m.role === "assistant" && out[n - 1].role === "assistant" && hasCalls(out[n - 1].parts)) {
      out[n - 1].parts = out[n - 1].parts.concat(m.parts || []);
      continue;
    }
    out.push(makeMessage(m.role, (m.parts || []).slice()));
  }
  return out;
}

/* --- 调用 id 的安全化 ---------------------------------------------------- */

/*
 * Anthropic 的 Messages API（以及 Claude Code）只接受 [A-Za-z0-9_-] 的
 * tool_use id：带别的字符的调用（Devin 的 "Bash:0#a65b…"）会被 Claude Code
 * 丢掉，那一轮报 "could not be parsed"（#1304）。所以出去的路上把 id 编码成
 * 安全字符，回来时解回去——**同一个 id 从任何一次请求回来都是同一个**，
 * 不靠任何状态。
 */
const ANTHROPIC_ID_MARK = "mp_";
const SAFE_ID_CHARS = /^[A-Za-z0-9_-]+$/;

export function safeCallID(mark, id) {
  if (!id) return id;
  if (SAFE_ID_CHARS.test(id) && !id.startsWith(mark)) return id;
  return mark + base64url(Buffer.from(String(id), "utf8"));
}

export function rawCallID(mark, id) {
  if (!id || !id.startsWith(mark) || !SAFE_ID_CHARS.test(id)) return id;
  try {
    const raw = Buffer.from(id.slice(mark.length), "base64url").toString("utf8");
    if (!raw || safeCallID(mark, raw) !== id) return id;
    return raw;
  } catch {
    return id;
  }
}

export function anthropicOutID(id) {
  if (!id) return id;
  return safeCallID(ANTHROPIC_ID_MARK, id);
}

export function anthropicInID(id) {
  return rawCallID(ANTHROPIC_ID_MARK, id);
}

/** anthropicID —— 一条回复的 id 变成 Anthropic 那种 msg_…。 */
export function anthropicID(id) {
  if (!id) return "msg_" + newID();
  if (id.startsWith("msg_")) return id;
  return "msg_" + id.replace(/^chatcmpl-/, "");
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let idCounter = 0;

/** newID —— 一个够用的随机 id。不含时间戳，测试里可复现。 */
export function newID() {
  idCounter = (idCounter + 1) % 0xffffff;
  let s = "";
  for (let i = 0; i < 3; i++) s += Math.floor(Math.random() * 0xffffffff).toString(36);
  return s + idCounter.toString(36);
}

/* ------------------------------------------------------------------ *
 * 解析：入向协议 → IR
 * ------------------------------------------------------------------ */

/**
 * parseAnthropic —— Anthropic Messages 的请求体 → IR。
 * 失败返回 `{ ok:false, error }`，**不抛异常**：调用方要能区分「这个请求体是坏的」
 * 和「网关自己坏了」，前者要给客户端一个像样的 400。
 */
export function parseAnthropic(body) {
  let a;
  try {
    a = typeof body === "string" ? JSON.parse(body) : body;
  } catch (e) {
    return { ok: false, error: `invalid request: ${e.message}` };
  }
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    return { ok: false, error: "invalid request: not an object" };
  }

  const r = makeRequest({
    model: a.model || "",
    system: stringOrText(a.system),
    maxTokens: a.max_tokens || 0,
    temp: typeof a.temperature === "number" ? a.temperature : null,
    topP: typeof a.top_p === "number" ? a.top_p : null,
    stop: Array.isArray(a.stop_sequences) ? a.stop_sequences : [],
    stream: !!a.stream,
    fast: a.speed === "fast",
  });

  const messages = Array.isArray(a.messages) ? a.messages : [];
  for (const m of messages) {
    const msg = makeMessage(m && m.role === "assistant" ? "assistant" : "user");
    const content = m ? m.content : undefined;
    if (typeof content === "string") {
      if (content !== "") msg.parts.push(makePart({ kind: KIND.TEXT, text: content }));
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        switch (b.type) {
          case "text":
            msg.parts.push(makePart({ kind: KIND.TEXT, text: b.text || "" }));
            break;
          case "image":
            if (b.source) {
              msg.parts.push(makePart({
                kind: KIND.IMAGE,
                mediaType: b.source.media_type || "",
                data: b.source.data || "",
                url: b.source.url || "",
              }));
            }
            break;
          case "tool_use":
            msg.parts.push(makePart({
              kind: KIND.TOOL_CALL,
              id: anthropicInID(b.id || ""),
              name: b.name || "",
              args: b.input === undefined ? null : b.input,
            }));
            break;
          case "tool_result": {
            const out = toolOutput(b.content);
            msg.parts.push(makePart({
              kind: KIND.TOOL_RESULT,
              callId: anthropicInID(b.tool_use_id || ""),
              text: out.text,
              isError: !!b.is_error,
            }));
            break;
          }
          case "thinking":
            // 签名**逐字节保留**：上游会校验，丢了这一轮就 400
            msg.parts.push(makePart({
              kind: KIND.THINKING,
              text: b.thinking || "",
              signature: b.signature || "",
            }));
            break;
          case "redacted_thinking":
            // Claude 的安全系统封起来的推理：整块原样回到 Messages，
            // 对别的 API 什么都不是（#1445）
            msg.parts.push(makePart({
              kind: KIND.THINKING,
              sealed: JSON.stringify(b),
              sealedBy: SEAL_ANTHROPIC,
            }));
            break;
          default:
            break;
        }
      }
    }
    r.messages.push(msg);
  }

  for (const t of Array.isArray(a.tools) ? a.tools : []) {
    if (!t || typeof t !== "object") continue;
    if (t.type && t.type !== "custom" && !t.input_schema) {
      // 服务端工具在别的 API 上毫无意义；只有联网检索是要记下来的
      if (String(t.type).startsWith("web_search")) r.webSearch = true;
      continue;
    }
    if (t.name === "DeferredToolPlaceholder") continue;
    r.tools.push(makeTool({
      name: t.name || "",
      description: t.description || "",
      schema: t.input_schema === undefined ? null : t.input_schema,
      deferred: !!t.defer_loading,
    }));
  }

  const tc = a.tool_choice;
  if (tc && typeof tc === "object") {
    if (tc.type === "auto" || tc.type === "none") r.toolChoice = tc.type;
    else if (tc.type === "any") r.toolChoice = "required";
    else if (tc.type === "tool") r.toolChoice = "name:" + (tc.name || "");
    if (tc.disable_parallel_tool_use) r.parallel = false;
  }

  // thinking 的开关与档位：Anthropic 用 budget_tokens 表示档位，
  // output_config.effort 更直接。两个都认，output_config 优先。
  const th = a.thinking;
  if (th && (th.type === "disabled" || th.type === "between_tools")) {
    r.thinkOff = true;
  } else if (th && (th.type === "enabled" || th.type === "adaptive")) {
    r.thinking = true;
    r.effort = effortOfBudget(th.budget_tokens);
    const oc = a.output_config;
    if (oc && typeof oc === "object") {
      const e = effortOf(oc.effort);
      if (e) r.effort = e;
    }
  }
  if (a.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata)) {
    r.metadata = a.metadata;
  }
  return { ok: true, request: r };
}

/**
 * parseChat —— OpenAI Chat Completions 的请求体 → IR。
 */
export function parseChat(body) {
  let c;
  try {
    c = typeof body === "string" ? JSON.parse(body) : body;
  } catch (e) {
    return { ok: false, error: `invalid request: ${e.message}` };
  }
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    return { ok: false, error: "invalid request: not an object" };
  }

  const r = makeRequest({
    model: c.model || "",
    maxTokens: c.max_completion_tokens || c.max_tokens || 0,
    temp: typeof c.temperature === "number" ? c.temperature : null,
    topP: typeof c.top_p === "number" ? c.top_p : null,
    stream: !!c.stream,
    effort: effortOf(c.reasoning_effort),
    parallel: typeof c.parallel_tool_calls === "boolean" ? c.parallel_tool_calls : null,
    fast: c.service_tier === "priority" || c.service_tier === "ultrafast",
    ultrafast: c.service_tier === "ultrafast",
    tier: c.service_tier || "",
    cacheKey: c.prompt_cache_key || "",
  });
  if (r.effort) r.thinking = true;
  r.thinkOff = String(c.reasoning_effort || "").trim().toLowerCase() === "none";

  if (typeof c.stop === "string" && c.stop) r.stop = [c.stop];
  else if (Array.isArray(c.stop)) r.stop = c.stop;

  const sys = [];
  for (const m of Array.isArray(c.messages) ? c.messages : []) {
    if (!m || typeof m !== "object") continue;
    switch (m.role) {
      case "system":
      case "developer":
        sys.push(stringOrText(m.content));
        break;
      case "user":
        r.messages.push(makeMessage("user", chatParts(m.content)));
        break;
      case "assistant": {
        const msg = makeMessage("assistant");
        // 上一轮的思考有三种叫法：reasoning_content（DeepSeek 的，
        // OpenCode 与多数客户端发这个）、reasoning（OpenRouter 的）、
        // reasoning_details（OpenRouter 的结构化那个）。谁的思考有自己
        // 的字段，就不再从文本里找一遍。
        const think = reasoningText(m);
        if (think) msg.parts.push(makePart({ kind: KIND.THINKING, text: think }));
        msg.parts.push(...chatParts(m.content));
        for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
          if (!tc || typeof tc !== "object") continue;
          msg.parts.push(makePart({
            kind: KIND.TOOL_CALL,
            id: tc.id || "",
            name: (tc.function && tc.function.name) || "",
            args: parseArgs(tc.function ? tc.function.arguments : ""),
          }));
        }
        r.messages.push(msg);
        break;
      }
      case "tool": {
        const out = toolOutput(m.content);
        r.messages.push(makeMessage("user", [makePart({
          kind: KIND.TOOL_RESULT,
          callId: m.tool_call_id || "",
          text: out.text,
        })]));
        break;
      }
      default:
        break;
    }
  }
  r.system = sys.join("\n\n");

  if (c.web_search_options) r.webSearch = true;
  for (const t of Array.isArray(c.tools) ? c.tools : []) {
    if (!t || typeof t !== "object") continue;
    if (String(t.type || "").startsWith("web_search")) r.webSearch = true;
    if (t.type && t.type !== "function") continue;
    const fn = t.function || {};
    r.tools.push(makeTool({
      name: fn.name || "",
      description: fn.description || "",
      schema: fn.parameters === undefined ? null : fn.parameters,
      strict: !!fn.strict,
    }));
  }

  if (typeof c.tool_choice === "string") {
    r.toolChoice = c.tool_choice;
  } else if (c.tool_choice && typeof c.tool_choice === "object" && c.tool_choice.function) {
    r.toolChoice = "name:" + (c.tool_choice.function.name || "");
  }
  return { ok: true, request: r };
}

/** chatParts —— 一条消息的内容：字符串，或一批内容块。 */
export function chatParts(raw) {
  if (typeof raw === "string") {
    return raw === "" ? [] : [makePart({ kind: KIND.TEXT, text: raw })];
  }
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    switch (it.type) {
      case "text":
        out.push(makePart({ kind: KIND.TEXT, text: it.text || "" }));
        break;
      case "image_url": {
        const u = typeof it.image_url === "string" ? it.image_url : (it.image_url && it.image_url.url) || "";
        if (u) out.push(imagePart(u));
        break;
      }
      case "file": {
        const f = it.file || {};
        if (f.file_data) {
          out.push(makePart({ kind: KIND.FILE, mediaType: "application/octet-stream", data: f.file_data }));
        } else if (f.file_id) {
          out.push(makePart({ kind: KIND.FILE, mediaType: "application/octet-stream", url: f.file_id }));
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * reasoningText —— 一条消息带回来的思考。三个字段名按顺序取，
 * reasoning_details 的每一项取 text，没有就取 summary。
 */
export function reasoningText(m) {
  for (const f of ["reasoning_content", "reasoning"]) {
    const s = m ? m[f] : undefined;
    if (typeof s === "string" && s !== "") return s;
  }
  const details = m ? m.reasoning_details : undefined;
  if (Array.isArray(details)) {
    let b = "";
    for (const d of details) {
      if (!d || typeof d !== "object") continue;
      if (typeof d.text === "string" && d.text) b += d.text;
      else if (typeof d.summary === "string") b += d.summary;
    }
    return b;
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * 构造：IR → 出向协议
 * ------------------------------------------------------------------ */

/**
 * buildChat —— IR → OpenAI Chat Completions 的请求体。
 *
 * opts.model 覆盖 req.model（上游那家的模型名往往不一样）；
 * opts.host 决定几个跟厂商有关的取舍；opts.rejectTemp 拒绝带 temperature。
 */
export function buildChat(req, opts = {}) {
  const model = opts.model || req.model || "";
  const host = String(opts.host || "");
  const out = { model, messages: [] };
  if (req.system) out.messages.push({ role: "system", content: req.system });

  const turns = joinSplitCalls(req.messages);
  // 工具消息只能装文本，所以工具带回来的图片另起一条 user 消息放在工具消息后面——
  // 接着用户的下一条消息开头：有些模型的聊天模板拒绝连续两条 user 消息。
  const seen = [];
  const names = {};
  const showSeen = () => {
    if (!seen.length) return;
    out.messages.push({ role: "user", content: seen.slice() });
    seen.length = 0;
  };

  for (const m of turns) {
    if (m.role === "assistant") {
      showSeen();
      const am = { role: "assistant" };
      const calls = [];
      let think = "";
      for (const p of m.parts || []) {
        if (p.kind === KIND.TOOL_CALL) {
          const id = p.id || "call_" + newID();
          names[id] = p.name;
          calls.push({ id, type: "function", function: { name: p.name, arguments: argsString(p) } });
        } else if (p.kind === KIND.THINKING) {
          think += p.text || "";
        }
      }
      const t = textOf(m.parts);
      am.content = t;
      if (calls.length) am.tool_calls = calls;
      // 思考要不要回传：DeepSeek 之类的上游要（#388）。这里不按厂商分，
      // 由 opts.replayReasoning 决定——那是调用方按上游知道的。
      if (think && opts.replayReasoning) am.reasoning_content = think;
      out.messages.push(am);
      continue;
    }
    // 用户消息（含工具结果）
    const content = [];
    let plain = true;
    const flush = () => {
      if (!content.length) return;
      if (seen.length) {
        content.unshift(...seen.splice(0, seen.length));
        plain = false;
      }
      if (plain) {
        let b = "";
        for (const c of content) b += c.text || "";
        out.messages.push({ role: "user", content: b });
      } else {
        out.messages.push({ role: "user", content: content.slice() });
      }
      content.length = 0;
      plain = true;
    };
    for (const p of m.parts || []) {
      switch (p.kind) {
        case KIND.TEXT:
          content.push({ type: "text", text: p.text || "" });
          break;
        case KIND.IMAGE:
          content.push({ type: "image_url", image_url: { url: dataURL(p) } });
          break;
        case KIND.FILE:
          content.push({ type: "text", text: attachmentText(p) });
          break;
        case KIND.TOOL_RESULT: {
          flush();
          out.messages.push({ role: "tool", tool_call_id: p.callId || "", content: p.text || "" });
          break;
        }
        case KIND.TOOL_CALL:
          break;
        case KIND.THINKING:
          break;
        default:
          break;
      }
    }
    flush();
  }
  showSeen();

  if (req.tools && req.tools.length) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.schema || { type: "object", properties: {} } },
    }));
  }
  if (req.toolChoice) out.tool_choice = req.toolChoice;
  if (req.maxTokens) out.max_tokens = req.maxTokens;
  if (req.temp !== null && req.temp !== undefined && !opts.rejectTemp) out.temperature = req.temp;
  if (req.topP !== null && req.topP !== undefined) out.top_p = req.topP;
  if (req.stop && req.stop.length) out.stop = req.stop;
  if (req.stream) out.stream = true;
  if (req.effort) out.reasoning_effort = req.effort;
  if (req.thinkOff) out.reasoning_effort = "none";
  if (req.parallel !== null && req.parallel !== undefined) out.parallel_tool_calls = req.parallel;
  if (req.tier) out.service_tier = req.tier;
  if (req.cacheKey) out.prompt_cache_key = req.cacheKey;
  if (req.webSearch) out.web_search_options = {};
  void host;
  return out;
}

/**
 * buildAnthropic —— IR → Anthropic Messages 的请求体。
 */
export function buildAnthropic(req, opts = {}) {
  const model = opts.model || req.model || "";
  const out = { model, messages: [], stream: !!req.stream };
  if (req.system) out.system = [{ type: "text", text: req.system }];

  const msgs = [];
  const push = (role, blocks) => {
    if (!blocks || !blocks.length) return;
    const n = msgs.length;
    if (n > 0 && msgs[n - 1].role === role) {
      msgs[n - 1].content.push(...blocks);
      return;
    }
    msgs.push({ role, content: blocks });
  };

  for (const m of req.messages || []) {
    const results = [];
    const rest = [];
    for (const p of m.parts || []) {
      switch (p.kind) {
        case KIND.TEXT:
          if (String(p.text || "").trim() !== "") rest.push({ type: "text", text: p.text });
          break;
        case KIND.FILE:
          rest.push({ type: "text", text: attachmentText(p) });
          break;
        case KIND.IMAGE:
          rest.push(imageBlock(p));
          break;
        case KIND.TOOL_CALL:
          rest.push({
            type: "tool_use",
            id: anthropicOutID(p.id || ""),
            name: p.name || "",
            input: argsOf(p),
          });
          break;
        case KIND.TOOL_RESULT:
          results.push({
            type: "tool_result",
            tool_use_id: anthropicOutID(p.callId || ""),
            content: p.text || "",
            is_error: !!p.isError,
          });
          break;
        case KIND.THINKING:
          if (p.sealedBy === SEAL_ANTHROPIC && p.sealed) {
            rest.push({ type: "redacted_thinking", ...safeParse(p.sealed) });
          } else if (p.signature) {
            rest.push({ type: "thinking", thinking: p.text || "", signature: p.signature });
          } else if (opts.replayThinking && p.text) {
            rest.push({ type: "thinking", thinking: p.text });
          }
          break;
        default:
          break;
      }
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    push(role, results.concat(rest));
  }
  // 客户端把一段对话弄断了（被中断的一轮、丢了的结果）就地补上，
  // Anthropic 不肯收这样的对话
  out.messages = pairToolBlocks(msgs);
  if (req.tools && req.tools.length) {
    out.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema || { type: "object", properties: {} },
    }));
  }
  if (req.toolChoice) {
    if (req.toolChoice === "auto" || req.toolChoice === "none") out.tool_choice = { type: req.toolChoice };
    else if (req.toolChoice === "required") out.tool_choice = { type: "any" };
    else if (req.toolChoice.startsWith("name:")) out.tool_choice = { type: "tool", name: req.toolChoice.slice(5) };
  }
  if (req.maxTokens) out.max_tokens = req.maxTokens;
  if (req.temp !== null && req.temp !== undefined) out.temperature = req.temp;
  if (req.topP !== null && req.topP !== undefined) out.top_p = req.topP;
  if (req.stop && req.stop.length) out.stop_sequences = req.stop;
  if (req.thinkOff) out.thinking = { type: "disabled" };
  else if (req.thinking || req.effort) {
    const budget = budgetOf(req.effort);
    out.thinking = { type: "enabled", budget_tokens: budget };
  }
  return out;
}

/** attachmentText —— 协议带不动一个附件时的替身文字。 */
export function attachmentText(p) {
  if (p.url) return `[attachment ${p.mediaType}: ${p.url}]`;
  return `[attachment ${p.mediaType}]`;
}

/** imageBlock —— 一个图片块变 Anthropic 的 source 块。 */
export function imageBlock(p) {
  if (p.url) return { type: "image", source: { type: "url", url: p.url } };
  return { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } };
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ *
 * 工具调用配对完整性
 * ------------------------------------------------------------------ */

/** 一条工具消息的 tool_call_id。 */
export function toolMsgID(m) {
  return (m && m.tool_call_id) || "";
}

/** 一条 assistant 消息是不是什么都没带：没有文本、没有调用、没有推理。 */
export function emptyAssistant(m) {
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) return false;
  if (String((m && m.reasoning_content) || "").trim() !== "") return false;
  return String((m && m.content) || "").trim() === "";
}

/**
 * pairToolMessages —— Chat 消息数组里的工具调用配对。
 *
 * 修三件事：
 *   · 一轮的并行调用被拆进两条 assistant 消息 —— 先并成一轮；
 *   · 一个工具结果回答的是**别的**调用（另一个请求带来的、已经收过工的、
 *     或者压根没有的）—— 降级成一条 user 消息，带着它的文本；
 *   · 一个调用没有结果（那一轮被打断了）—— 补一条占位结果，
 *     不然模型看到半个调用会一直等下去。
 */
export function pairToolMessages(msgs) {
  const out = [];
  let pending = [];              // 最后一条带 tool_calls 的 assistant 消息的调用
  let order = {};                // 一个待答调用在它们里的位置
  let answered = {};             // 待答调用里哪些已经有结果了
  let tools = [];                // 攒着的答案，flush 时按调用顺序排

  const flushTools = () => {
    if (!tools.length) return;
    tools.sort((a, b) => (order[toolMsgID(a)] || 0) - (order[toolMsgID(b)] || 0));
    out.push(...tools);
    tools = [];
  };
  const flushPending = () => {
    flushTools();
    for (const id of pending) {
      if (!answered[id]) {
        out.push({
          role: "tool",
          tool_call_id: id,
          content: "[The result of this tool call is unavailable: the turn was interrupted.]",
        });
      }
    }
    pending = [];
    order = {};
    answered = {};
  };
  const toolAsUser = (m) => {
    let text = m.content || "";
    if (String(text).trim() === "") text = "Tool result received.";
    const n = out.length;
    if (n > 0 && out[n - 1].role === "user" && typeof out[n - 1].content === "string") {
      out[n - 1].content = out[n - 1].content + "\n\n" + text;
      return;
    }
    out.push({ role: "user", content: text });
  };

  for (const m of msgs || []) {
    if (m.role === "assistant") {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (!calls.length) {
        if (pending.length && emptyAssistant(m)) {
          // 一条空 assistant 消息夹在待答的调用和它们的答案中间，
          // 会在那儿卡住整个来回。丢掉它，这一轮仍然开着。
          continue;
        }
        flushPending();
        out.push(m);
        continue;
      }
      flushPending();
      out.push(m);
      calls.forEach((c, i) => {
        const id = (c && c.id) || "";
        pending.push(id);
        order[id] = i;
      });
    } else if (m.role === "tool") {
      const id = toolMsgID(m);
      if (!(id in order)) {
        // 回答的不是当前这轮在飞的调用：在飞的这一轮先收掉，
        // 这样 user 消息不会插在它中间，id 也不会被别处用掉
        flushPending();
        toolAsUser(m);
        continue;
      }
      if (answered[id]) continue; // 答了两次的，以第一个为准
      answered[id] = true;
      tools.push(m);
    } else {
      flushPending();
      out.push(m);
    }
  }
  flushPending();
  return out;
}

/**
 * pairToolBlocks —— Anthropic 块数组里的工具调用配对。跟 pairToolMessages
 * 同一件事，只是 Anthropic 把结果放在 user 消息的 content 块里。
 */
export function pairToolBlocks(msgs) {
  const out = [];
  let pending = [];
  const open = {};
  const answered = {};

  const synthetic = (id) => ({
    type: "tool_result",
    tool_use_id: id,
    content: "[The result of this tool call is unavailable: the turn was interrupted.]",
    is_error: true,
  });
  const closeExchange = () => {
    const blocks = [];
    for (const id of pending) if (!answered[id]) blocks.push(synthetic(id));
    if (blocks.length) out.push({ role: "user", content: blocks });
    pending = [];
    for (const k of Object.keys(open)) delete open[k];
    for (const k of Object.keys(answered)) delete answered[k];
  };

  for (const m of msgs || []) {
    if (m.role === "assistant") {
      closeExchange();
      for (const b of m.content || []) {
        if (b.type === "tool_use") {
          pending.push(b.id);
          open[b.id] = true;
        }
      }
      out.push(m);
      continue;
    }
    const kept = [];
    const rest = [];
    for (const b of m.content || []) {
      if (b.type !== "tool_result") {
        rest.push(b);
        continue;
      }
      if (!open[b.tool_use_id]) {
        // 回答的不是当前这轮的调用：留下它的文本，别丢
        rest.push(...resultSaid(b));
        continue;
      }
      if (answered[b.tool_use_id]) continue; // 答了两次的，以第一个为准
      answered[b.tool_use_id] = true;
      kept.push(b);
    }
    for (const id of pending) if (!answered[id]) kept.push(synthetic(id));
    out.push({ role: "user", content: kept.concat(rest) });
    pending = [];
    for (const k of Object.keys(open)) delete open[k];
    for (const k of Object.keys(answered)) delete answered[k];
  }
  closeExchange();
  return out;
}

/** resultSaid —— 一个回答不了任何调用的工具结果，留下的样子。 */
export function resultSaid(b) {
  const c = b.content;
  if (typeof c === "string") {
    const s = c.trim() === "" ? "Tool result received." : c;
    return [{ type: "text", text: s }];
  }
  if (Array.isArray(c) && c.length) return c;
  return [{ type: "text", text: "Tool result received." }];
}

/* ------------------------------------------------------------------ *
 * 事件流：上游 SSE → Event
 * ------------------------------------------------------------------ */

/**
 * chatDecoder —— OpenAI Chat Completions 的 SSE → Event。
 *
 * decode(text) 收的是**原始 SSE 文本**，可以是一整段，也可以是任意切开的
 * 几段：内部按 SSE 规范攒行（data 行攒到空行才是一个事件），所以上游把
 * 一个事件切成两半发来也不会丢。
 */
export function chatDecoder() {
  let buf = "";
  let started = false;
  let tool = -1;          // 当前开着的工具调用的下标，-1 是没有
  let toolID = "";       // 当前开着的工具调用的 id（有些中转每个片段都重复它）
  let choice = "";       // 锁定的 choice 下标；空串是还没见到
  let lead = "";         // 文本开头可能是 <think> 标签，攒着等它成型
  let thought = false;   // 已经在思考块里
  let thoughtClose = ""; // 结束思考块的标签
  let past = false;      // 正文已经开始，不再找标签了

  const emit = (events, ev) => { events.push(ev); };

  const text = (events, s) => {
    if (!past && !thought) {
      lead += s;
      const trimmed = lead.replace(/^[ \n]+/, "");
      for (const open of ["<thought>", "<think>"]) {
        if (trimmed.length < open.length && open.startsWith(trimmed)) return;
      }
      let open = "";
      for (const o of ["<thought>", "<think>"]) {
        if (trimmed.startsWith(o)) open = o;
      }
      if (!open) {
        past = true;
        emit(events, makeEvent({ kind: EV.TEXT, text: lead }));
        lead = "";
        return;
      }
      s = trimmed.slice(open.length);
      lead = "";
      thought = true;
      thoughtClose = open === "<thought>" ? "</thought>" : "</think>";
    }
    if (thought) {
      s = lead + s;
      lead = "";
      const at = s.indexOf(thoughtClose);
      if (at >= 0) {
        if (at > 0) emit(events, makeEvent({ kind: EV.THINK, text: s.slice(0, at) }));
        thought = false;
        past = true;
        s = s.slice(at + thoughtClose.length);
      } else {
        // 结束标签可能被切在两半之间：留着尾巴等下一片
        emit(events, makeEvent({ kind: EV.THINK, text: s }));
        return;
      }
    }
    if (s !== "") emit(events, makeEvent({ kind: EV.TEXT, text: s }));
  };

  const end = (events) => {
    if (lead === "") return;
    emit(events, makeEvent({ kind: thought ? EV.THINK : EV.TEXT, text: lead }));
    lead = "";
  };

  const decodePayload = (events, data) => {
    const s = data.trim();
    if (!s || s === "[DONE]") return;
    let ch;
    try {
      ch = JSON.parse(s);
    } catch {
      // 自己一种形状的错误（{"error":"…"}）仍然是这条回复的结尾，
      // 不是可以跳过的分片（#1933）
      const carried = carriedError(s);
      if (carried) emit(events, carried);
      return;
    }
    if (!ch || typeof ch !== "object") return;
    if (ch.error) {
      emit(events, makeEvent({
        kind: EV.ERROR,
        text: (ch.error && ch.error.message) || streamErrorText(s),
        code: refusedCode(s),
      }));
      return;
    }
    if (!started) {
      started = true;
      tool = -1;
      // 多数流在结尾才报用量，但有的在第一块就报（Anthropic 的
      // message_start 那样，#1887）
      let prompt = emptyUsage();
      if (ch.usage && ch.usage.prompt_tokens > 0) {
        const u = chatUsage(ch.usage);
        prompt.input = u.input;
        prompt.cacheRead = u.cacheRead;
        prompt.cacheWrite = u.cacheWrite;
      }
      emit(events, makeEvent({ kind: EV.START, msgId: ch.id || "", model: ch.model || "", usage: prompt }));
    }
    for (const c of Array.isArray(ch.choices) ? ch.choices : []) {
      // 一次翻译只有一条回复：锁定第一个读得懂的 choice 下标。
      // 缺失/null/畸形的下标说明不了这个分片属于哪条，所以既不选也不排除。
      const index = chatChoiceIndex(c.index);
      if (index !== null) {
        if (choice === "") choice = index;
        else if (index !== choice) continue;
      }
      const d = c.delta || {};
      // 有些中转把同一段思考用两个字段名各发一次，一份就够
      let t = d.reasoning_content || "";
      if (!t) t = d.reasoning || "";
      let content = "";
      if (typeof d.content === "string") {
        content = d.content;
      } else if (Array.isArray(d.content)) {
        // Mistral 的内容是带类型的分片，思考混在里面（#483）
        content = partsText(d.content).text;
        t += partsText(d.content).think;
      }
      if (t) {
        emit(events, makeEvent({ kind: EV.THINK, text: t }));
        if (!thought && lead === "") {
          // 思考有自己的字段的回复，不会同时在文本里再给一份：
          // 文本里那个 <think> 是模型自己的话（#2634）
          past = true;
        }
      }
      if (content !== "") text(events, content);
      const calls = Array.isArray(d.tool_calls) ? d.tool_calls : [];
      if (calls.length) end(events);
      calls.forEach((tc, i) => {
        const idx = tc && typeof tc.index === "number" ? tc.index : i;
        // 带着**开着那个调用已有的 id** 的分片（有些中转每个片段都重复它，
        // 而规范只在第一片发）或者开着那个下标的下一片，是同一个调用的继续；
        // 只有新的 id 或新的下标才是下一个调用。
        if (idx !== tool || (tc.id && tc.id !== toolID)) {
          tool = idx;
          toolID = tc.id || "";
          emit(events, makeEvent({
            kind: EV.TOOL_START,
            id: tc.id || "",
            name: (tc.function && tc.function.name) || "",
          }));
        }
        if (tc.function && tc.function.arguments) {
          emit(events, makeEvent({ kind: EV.TOOL_ARGS, text: tc.function.arguments }));
        }
      });
      if (c.finish_reason) {
        end(events);
        emit(events, makeEvent({ kind: EV.STOP, stop: stopFromChat(c.finish_reason) }));
      }
    }
    if (ch.usage) {
      emit(events, makeEvent({ kind: EV.USAGE, usage: chatUsage(ch.usage) }));
    }
  };

  return {
    /** decode —— 收一段原始 SSE 文本，给出这一段带来的事件。 */
    decode(text2) {
      const events = [];
      buf += String(text2 === undefined || text2 === null ? "" : text2);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") continue; // 空行是事件的界，这里按行处理，不依赖它
        if (line.startsWith("data:")) {
          const data = line.slice(5).replace(/^ /, "");
          decodePayload(events, data);
        }
        // event: / id: / retry: / 注释行一律不理会
      }
      return events;
    },
    /** flush —— 流结束，把还攒着的半行交出去。 */
    flush() {
      const events = [];
      if (buf.trim() !== "") {
        const line = buf.replace(/\r$/, "");
        buf = "";
        if (line.startsWith("data:")) decodePayload(events, line.slice(5).replace(/^ /, ""));
      }
      end(events);
      return events;
    },
  };
}

/**
 * anthropicDecoder —— Anthropic Messages 的 SSE → Event。
 * 收的同样是原始 SSE 文本。
 */
export function anthropicDecoder() {
  let buf = "";
  const server = {};   // 哪些下标是 Anthropic 自己的服务端工具（不是客户端的调用）
  const whole = {};    // 哪些 tool_use 的参数在 start 里就整个来了

  const decodePayload = (events, data) => {
    const s = data.trim();
    if (!s) return;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      const carried = carriedError(s);
      if (carried) emit(events, carried);
      return;
    }
    if (!ev || typeof ev !== "object") return;
    switch (ev.type) {
      case "message_start":
        emit(events, makeEvent({
          kind: EV.START,
          msgId: (ev.message && ev.message.id) || "",
          model: (ev.message && ev.message.model) || "",
          usage: anthropicUsage(ev.message && ev.message.usage),
        }));
        break;
      case "content_block_start": {
        const cb = ev.content_block || {};
        server[ev.index] = cb.type === "server_tool_use";
        whole[ev.index] = false;
        if (cb.type === "tool_use" && fullInput(cb.input)) {
          // 一个 tool_use 的 start 就带着整个参数（别家模型前面套一层中转时
          // 会这样，后面没有 input_json_delta）
          emit(events, makeEvent({ kind: EV.TOOL_START, id: cb.id || "", name: cb.name || "" }));
          whole[ev.index] = true;
          emit(events, makeEvent({ kind: EV.TOOL_ARGS, text: JSON.stringify(cb.input) }));
        } else if (cb.type === "tool_use") {
          emit(events, makeEvent({ kind: EV.TOOL_START, id: cb.id || "", name: cb.name || "" }));
        } else if (cb.type === "text") {
          if (cb.text) emit(events, makeEvent({ kind: EV.TEXT, text: cb.text }));
        } else if (cb.type === "thinking") {
          // 一段自己的思考，哪怕一个字都没有、或者紧跟着上一段（#1445）
          emit(events, makeEvent({ kind: EV.THINK_START }));
          if (cb.thinking) emit(events, makeEvent({ kind: EV.THINK, text: cb.thinking }));
          if (cb.signature) emit(events, makeEvent({ kind: EV.SIG, text: cb.signature }));
        } else if (cb.type === "redacted_thinking") {
          // 整块封着的：原样发给 Messages
          emit(events, makeEvent({
            kind: EV.SEALED,
            name: SEAL_ANTHROPIC,
            text: JSON.stringify(cb),
          }));
        }
        break;
      }
      case "content_block_delta": {
        if (server[ev.index]) break; // Anthropic 自己的服务端工具，客户端不关心
        const d = ev.delta || {};
        if (whole[ev.index] && d.type === "input_json_delta") break; // 参数已经整个来了
        if (d.type === "text_delta") emit(events, makeEvent({ kind: EV.TEXT, text: d.text || "" }));
        else if (d.type === "input_json_delta") emit(events, makeEvent({ kind: EV.TOOL_ARGS, text: d.partial_json || "" }));
        else if (d.type === "thinking_delta") emit(events, makeEvent({ kind: EV.THINK, text: d.thinking || "" }));
        else if (d.type === "signature_delta") emit(events, makeEvent({ kind: EV.SIG, text: d.signature || "" }));
        break;
      }
      case "message_delta": {
        const d = ev.delta || {};
        if (d.stop_reason) emit(events, makeEvent({ kind: EV.STOP, stop: stopFromAnthropic(d.stop_reason) }));
        emit(events, makeEvent({ kind: EV.USAGE, usage: anthropicUsage(ev.usage) }));
        break;
      }
      case "error":
        emit(events, makeEvent({
          kind: EV.ERROR,
          text: (ev.error && ev.error.message) || (ev.error && ev.error.type) || streamErrorText(s),
          code: refusedCode(s),
        }));
        break;
      default:
        break;
    }
  };

  return {
    decode(text) {
      const events = [];
      buf += String(text === undefined || text === null ? "" : text);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) decodePayload(events, line.slice(5).replace(/^ /, ""));
      }
      return events;
    },
    flush() {
      const events = [];
      if (buf.trim() !== "") {
        const line = buf.replace(/\r$/, "");
        buf = "";
        if (line.startsWith("data:")) decodePayload(events, line.slice(5).replace(/^ /, ""));
      }
      return events;
    },
  };
}

/* --- 用量与错误的小工具 ------------------------------------------------- */

/** chatUsage —— Chat 的 usage 字段。 */
export function chatUsage(u) {
  if (!u || typeof u !== "object") return emptyUsage();
  const out = emptyUsage();
  out.input = u.prompt_tokens || 0;
  out.output = u.completion_tokens || 0;
  const d = u.prompt_tokens_details || {};
  out.cacheRead = d.cached_tokens || 0;
  out.reasoning = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0;
  return out;
}

/** anthropicUsage —— Anthropic 的 usage 字段，缓存写按 TTL 拆开。 */
export function anthropicUsage(u) {
  const out = emptyUsage();
  if (!u || typeof u !== "object") return out;
  out.input = u.input_tokens || 0;
  out.output = u.output_tokens || 0;
  out.cacheRead = u.cache_read_input_tokens || 0;
  out.cacheWrite = u.cache_creation_input_tokens || 0;
  const c = u.cache_creation;
  if (c && typeof c === "object") {
    const five = c.ephemeral_5m_input_tokens || 0;
    const hour = c.ephemeral_1h_input_tokens || 0;
    out.cacheWrite = Math.max(out.cacheWrite, five + hour);
    out.cacheWrite1h = hour;
  }
  return out;
}

/** usageToAnthropic —— IR 的用量转成 Anthropic 的形状。 */
export function usageToAnthropic(u) {
  const out = {
    input_tokens: u.input || 0,
    output_tokens: u.output || 0,
    cache_read_input_tokens: u.cacheRead || 0,
    cache_creation_input_tokens: u.cacheWrite || 0,
  };
  const h = Math.min(u.cacheWrite1h || 0, u.cacheWrite || 0);
  if (h > 0) {
    out.cache_creation = { ephemeral_5m_input_tokens: (u.cacheWrite || 0) - h, ephemeral_1h_input_tokens: h };
  }
  return out;
}

/** usageToChat —— IR 的用量转成 Chat 的形状。 */
export function usageToChat(u) {
  return {
    prompt_tokens: u.input || 0,
    completion_tokens: u.output || 0,
    total_tokens: (u.input || 0) + (u.output || 0),
    prompt_tokens_details: { cached_tokens: u.cacheRead || 0 },
  };
}

function chatChoiceIndex(index) {
  if (index === undefined || index === null) return null;
  if (typeof index === "number") return String(index);
  if (typeof index === "string") return index;
  return null;
}

function fullInput(input) {
  return !!input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length > 0;
}

function partsText(raw) {
  if (!Array.isArray(raw)) return { text: "", think: "" };
  let t = "";
  let k = "";
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text") t += p.text || "";
    else if (p.type === "thinking") {
      if (typeof p.thinking === "string") k += p.thinking;
      else if (Array.isArray(p.thinking)) for (const inner of p.thinking) k += (inner && inner.text) || "";
    }
  }
  return { text: t, think: k };
}

/** stopFromChat —— Chat 的 finish_reason 归一成 IR 的 stop。 */
export function stopFromChat(s) {
  switch (s) {
    case "length": return "length";
    case "tool_calls":
    case "function_call": return "tool";
    case "content_filter": return "filter";
    default: return "stop";
  }
}

/** carriedError —— 藏在流里的错误。 */
export function carriedError(data) {
  const s = String(data || "");
  let v;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const e = v.error;
  if (!e) return null;
  const text = typeof e === "string" ? e : (e.message || e.type || streamErrorText(s));
  return makeEvent({ kind: EV.ERROR, text, code: refusedCode(s) });
}

/** streamErrorText —— 从一段错误原文里取出能给人看的话。 */
export function streamErrorText(data) {
  const s = String(data || "");
  let v;
  try {
    v = JSON.parse(s);
  } catch {
    return s.slice(0, 200);
  }
  if (v && typeof v === "object") {
    if (v.error && typeof v.error === "object" && v.error.message) return String(v.error.message);
    if (v.error && typeof v.error === "string") return v.error;
    if (v.message) return String(v.message);
  }
  return s.slice(0, 200);
}

/** refusedCode —— 上游错误里的类型码（rate_limit、content_filter…）。 */
export function refusedCode(data) {
  const s = String(data || "");
  let v;
  try {
    v = JSON.parse(s);
  } catch {
    return "";
  }
  if (!v || typeof v !== "object") return "";
  const e = v.error;
  if (e && typeof e === "object") {
    if (typeof e.code === "string") return e.code;
    if (typeof e.type === "string") return e.type;
  }
  if (typeof e === "string" && /rate_limit|content_filter|server_error/.test(e)) return e;
  return "";
}

/* ------------------------------------------------------------------ *
 * 事件流：Event → 客户端 SSE
 * ------------------------------------------------------------------ */

/**
 * anthropicEncoder —— Event → Anthropic 的事件流。
 *
 * event(ev) 给出一段 SSE 文本（不用输出时给 null）；flush() 给出收尾的部分。
 */
export function anthropicEncoder(opts = {}) {
  let id = "";
  let model = opts.model || "";
  let index = 0;
  let open = "";        // 当前开着的块是哪一种
  let args = false;     // 开着的工具块收到过参数
  let fresh = false;    // 上游开始了一段新的思考
  let started = false;
  const col = collector();

  const sse = (name, data) => {
    let b = "";
    if (name) b += "event: " + name + "\n";
    b += "data: " + (typeof data === "string" ? data : JSON.stringify(data)) + "\n\n";
    return b;
  };

  const start = (ev) => {
    if (started) return;
    started = true;
    id = anthropicID(ev.msgId);
    if (ev.model) model = ev.model;
    const msg = {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: usageToAnthropic(ev.usage || emptyUsage()),
    };
    return sse("message_start", { type: "message_start", message: msg });
  };

  const close = () => {
    if (!open) return "";
    let b = "";
    if (open === KIND.TOOL_CALL && !args) {
      // 工具块开了却一个参数都没来：补一个空对象，
      // 不然客户端那边这个调用永远等不到结果
      b += sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: "{}" },
      });
    }
    b += sse("content_block_stop", { type: "content_block_stop", index });
    index++;
    open = "";
    return b;
  };

  const openBlock = (k, block) => {
    if (open === k && k !== KIND.TOOL_CALL) return "";
    let b = close();
    args = false;
    fresh = false;
    const type = { [KIND.TEXT]: "text", [KIND.THINKING]: "thinking", [KIND.TOOL_CALL]: "tool_use" }[k] || "text";
    block.type = type;
    b += sse("content_block_start", { type: "content_block_start", index, content_block: block });
    open = k;
    return b;
  };

  const thinking = () => {
    let b = "";
    if (fresh) {
      b += close();
      fresh = false;
    }
    b += openBlock(KIND.THINKING, { thinking: "" });
    return b;
  };

  const delta = (d) => sse("content_block_delta", { type: "content_block_delta", index, delta: d });

  return {
    event(ev) {
      let b = "";
      if (ev.kind !== EV.START && !started) b += start(emptyEvent());
      switch (ev.kind) {
        case EV.START:
          b += start(ev);
          break;
        case EV.TEXT:
          if (!ev.text) break;
          b += openBlock(KIND.TEXT, { text: "" });
          b += delta({ type: "text_delta", text: ev.text });
          break;
        case EV.THINK_START:
          // 用它说的第一句话开块：一段什么都不说的思考不算一段
          fresh = true;
          col.add(ev);
          return b;
        case EV.THINK:
          if (!ev.text) break;
          b += thinking();
          b += delta({ type: "thinking_delta", thinking: ev.text });
          break;
        case EV.SIG:
          // 一个没有文字的签名块也照样是块（#1445）
          if (open === KIND.THINKING || fresh) {
            b += thinking();
            b += delta({ type: "signature_delta", signature: ev.text });
          }
          break;
        case EV.SEALED:
          if (ev.name === SEAL_ANTHROPIC) {
            // 一个 redacted_thinking 块，整个按 Anthropic 写的样子回去
            b += close();
            fresh = false;
            b += sse("content_block_start", {
              type: "content_block_start",
              index,
              content_block: safeParse(ev.text),
            });
            b += sse("content_block_stop", { type: "content_block_stop", index });
            index++;
          }
          break;
        case EV.TOOL_START: {
          const tid = ev.id || "toolu_" + newID();
          b += openBlock(KIND.TOOL_CALL, { id: anthropicOutID(tid), name: ev.name, input: {} });
          break;
        }
        case EV.TOOL_ARGS:
          if (open === KIND.TOOL_CALL && ev.text) {
            args = true;
            b += delta({ type: "input_json_delta", partial_json: ev.text });
          }
          break;
        case EV.SEARCH: {
          b += close();
          const sid = "srvtoolu_" + newID();
          b += sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "server_tool_use", id: sid, name: "web_search", input: {} },
          });
          b += delta({ type: "input_json_delta", partial_json: JSON.stringify({ query: ev.text }) });
          b += sse("content_block_stop", { type: "content_block_stop", index });
          index++;
          b += sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: searchResultBlock(sid, ev.hits),
          });
          b += sse("content_block_stop", { type: "content_block_stop", index });
          index++;
          break;
        }
        case EV.ERROR: {
          b += close();
          let type = "api_error";
          if (ev.status === 413 && ev.code !== "context_length_exceeded") {
            // 与 413 的 JSON 体同一个类型（writeErrorSaid）
            type = "request_too_large";
          }
          const failed = { type, message: ev.text };
          if (ev.code) failed.code = ev.code; // 上游的错误类型要留着，拒绝也算
          if (ev.said) Object.assign(failed, safeParse(ev.said));
          b += sse("error", { type: "error", error: failed });
          break;
        }
        default:
          break;
      }
      col.add(ev);
      return b || null;
    },
    flush() {
      let b = "";
      if (!started) b += start(emptyEvent());
      b += close();
      const res = col.finish();
      b += sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopToAnthropic(res.stop), stop_sequence: null },
        usage: usageToAnthropic(res.usage),
      });
      b += sse("message_stop", { type: "message_stop" });
      return b;
    },
  };
}

/**
 * chatEncoder —— Event → OpenAI Chat Completions 的事件流。
 */
export function chatEncoder(opts = {}) {
  let id = "";
  let model = opts.model || "";
  const created = opts.created || 0;
  let started = false;
  let tool = -1;
  const col = collector();

  const chunk = (delta, finish, usage) => {
    const choices = [];
    if (delta !== null || finish !== null) {
      choices.push({ index: 0, delta: delta || {}, finish_reason: finish });
    }
    const body = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices,
    };
    if (usage) body.usage = usage;
    return "data: " + JSON.stringify(body) + "\n\n";
  };

  const start = (ev) => {
    if (started) return "";
    started = true;
    tool = -1;
    id = ev.msgId || "chatcmpl-" + newID();
    if (!id.startsWith("chatcmpl-")) id = "chatcmpl-" + id;
    if (ev.model) model = ev.model;
    return chunk({ role: "assistant", content: "" }, null, null);
  };

  return {
    event(ev) {
      let b = "";
      if (ev.kind !== EV.START && !started) b += start(emptyEvent());
      switch (ev.kind) {
        case EV.START:
          b += start(ev);
          break;
        case EV.TEXT:
          if (ev.text) b += chunk({ content: ev.text }, null, null);
          break;
        case EV.THINK:
          if (ev.text) b += chunk({ reasoning_content: ev.text }, null, null);
          break;
        case EV.TOOL_START: {
          tool++;
          const tid = ev.id || "call_" + newID();
          b += chunk({ tool_calls: [{ index: tool, id: tid, type: "function", function: { name: ev.name, arguments: "" } }] }, null, null);
          break;
        }
        case EV.TOOL_ARGS:
          if (tool >= 0 && ev.text) {
            b += chunk({ tool_calls: [{ index: tool, function: { arguments: ev.text } }] }, null, null);
          }
          break;
        case EV.ERROR: {
          let type = "api_error";
          if (ev.status === 413 && ev.code !== "context_length_exceeded") type = "request_too_large";
          const failed = { message: ev.text, type };
          if (ev.code) failed.code = ev.code;
          if (ev.said) Object.assign(failed, safeParse(ev.said));
          b += "data: " + JSON.stringify({ error: failed }) + "\n\n";
          break;
        }
        default:
          break;
      }
      col.add(ev);
      return b || null;
    },
    flush() {
      let b = "";
      if (!started) b += start(emptyEvent());
      const res = col.finish();
      b += chunk(null, stopToChat(res.stop), null);
      b += chunk(null, null, usageToChat(res.usage));
      b += "data: [DONE]\n\n";
      return b;
    },
  };
}

function emptyEvent() {
  return makeEvent({ kind: EV.START });
}

/* ------------------------------------------------------------------ *
 * 事件流 → 整包结果
 * ------------------------------------------------------------------ */

/**
 * collector —— 把事件流装配成一个结果。编码器用同一套逻辑知道自己
 * 到目前为止收到了什么，非流式的渲染就是它的结果。
 */
export function collector() {
  const res = { id: "", model: "", parts: [], stop: "", usage: emptyUsage() };
  let args = "";    // 开着的工具调用的参数
  let fresh = false; // KThinkStart 说了接下来是另一段自己的推理
  let err = "";
  let errStatus = 0;
  let errCode = "";
  let errSaid = "";

  const last = (k) => {
    const n = res.parts.length;
    return n > 0 && res.parts[n - 1].kind === k ? res.parts[n - 1] : null;
  };
  const open = () => {
    if (fresh) return null;
    const p = last(KIND.THINKING);
    return p && !p.sealed ? p : null;
  };
  const closeTool = () => {
    const p = last(KIND.TOOL_CALL);
    if (p && p.args === null) {
      const s = args.trim();
      p.args = s === "" ? {} : safeParse(s);
      args = "";
    }
  };
  const add = (ev) => {
    switch (ev.kind) {
      case EV.START:
        res.id = ev.msgId;
        res.model = ev.model;
        addUsage(res.usage, ev.usage);
        break;
      case EV.TEXT: {
        const p = last(KIND.TEXT);
        if (p) p.text += ev.text;
        else {
          closeTool();
          res.parts.push(makePart({ kind: KIND.TEXT, text: ev.text }));
        }
        break;
      }
      case EV.THINK_START:
        fresh = true;
        return;
      case EV.THINK: {
        const p = open();
        if (p) p.text += ev.text;
        else {
          closeTool();
          res.parts.push(makePart({ kind: KIND.THINKING, text: ev.text }));
        }
        break;
      }
      case EV.SIG: {
        const p = open();
        if (p) {
          p.signature += ev.text;
        } else if (fresh) {
          // 一个没有文字的签名块也还是一块（Claude 的思考不显示时就是它，#1445）
          closeTool();
          res.parts.push(makePart({ kind: KIND.THINKING, signature: ev.text }));
        }
        break;
      }
      case EV.SEALED: {
        const p = open();
        if (p && ev.name === SEAL_RESPONSES && !p.signature) {
          p.sealed = ev.text;
          p.sealedBy = ev.name;
        } else {
          closeTool();
          res.parts.push(makePart({ kind: KIND.THINKING, sealed: ev.text, sealedBy: ev.name }));
        }
        break;
      }
      case EV.TEXT_SIG: {
        const p = last(KIND.TEXT);
        if (p && !p.signature) p.signature = ev.text;
        else {
          closeTool();
          res.parts.push(makePart({ kind: KIND.TEXT, signature: ev.text }));
        }
        break;
      }
      case EV.TOOL_START:
        closeTool();
        res.parts.push(makePart({ kind: KIND.TOOL_CALL, id: ev.id, name: ev.name }));
        break;
      case EV.TOOL_ARGS:
        args += ev.text;
        break;
      case EV.STOP:
        closeTool();
        res.stop = ev.stop;
        break;
      case EV.USAGE:
        addUsage(res.usage, ev.usage);
        break;
      case EV.ERROR:
        err = ev.text;
        errStatus = ev.status;
        errCode = ev.code;
        errSaid = ev.said;
        break;
      case EV.SEARCH:
        closeTool();
        res.parts.push(makePart({ kind: KIND.SEARCH, text: ev.text, hits: ev.hits }));
        break;
      case EV.IMAGE:
        closeTool();
        res.parts.push(makePart({ kind: KIND.IMAGE, mediaType: ev.name, data: ev.text }));
        break;
      default:
        break;
    }
    if (ev.kind !== EV.START && ev.kind !== EV.USAGE && ev.kind !== EV.ERROR && ev.kind !== EV.ALIVE) {
      // 开始了的东西有了第一块内容，或者别的来了
      fresh = false;
    }
  };

  return {
    add,
    finish() {
      closeTool();
      // 一条只有工具调用的回复是「stop」（某些中转在 tool_use 块旁边还写
      // end_turn），但对客户端来说这一轮是它去跑那些调用
      if (!res.stop || res.stop === "stop") {
        res.stop = "stop";
        for (const p of res.parts) {
          if (p.kind === KIND.TOOL_CALL) {
            res.stop = "tool";
            break;
          }
        }
      }
      return res;
    },
    error() {
      return { text: err, status: errStatus, code: errCode, said: errSaid };
    },
  };
}

function addUsage(dst, src) {
  if (!src) return;
  if (src.input) dst.input = src.input;
  if (src.output) dst.output = src.output;
  if (src.cacheRead) dst.cacheRead = src.cacheRead;
  if (src.cacheWrite) dst.cacheWrite = src.cacheWrite;
  if (src.cacheWrite1h) dst.cacheWrite1h = src.cacheWrite1h;
  if (src.reasoning) dst.reasoning = src.reasoning;
  if (src.served) dst.served = src.served;
  if (src.upstream) dst.upstream = src.upstream;
  if (src.tier) dst.tier = src.tier;
  if (src.stop) dst.stop = src.stop;
}

/** saidAnything —— 一条回复除了思考之外还有没有东西。 */
export function saidAnything(parts) {
  for (const p of parts || []) if (p.kind !== KIND.THINKING) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * 非流式渲染
 * ------------------------------------------------------------------ */

/** renderAnthropic —— 一个结果渲染成 Anthropic 的整包 JSON。 */
export function renderAnthropic(res, model) {
  const content = [];
  for (const p of res.parts || []) {
    switch (p.kind) {
      case KIND.TEXT:
        if (p.text === "" && p.signature) continue; // 只有 Gemini 的签名，是 Gemini 的
        content.push({ type: "text", text: p.text });
        break;
      case KIND.THINKING:
        if (p.sealedBy === SEAL_ANTHROPIC) content.push(safeParse(p.sealed));
        else if (p.text === "" && !p.signature) {
          // 别的 API 封的推理，Messages 上什么都不是
        } else content.push({ type: "thinking", thinking: p.text, signature: p.signature });
        break;
      case KIND.TOOL_CALL:
        content.push({
          type: "tool_use",
          id: anthropicOutID(p.id || "toolu_" + newID()),
          name: p.name,
          input: argsOf(p),
        });
        break;
      default:
        break;
    }
  }
  const reply = {
    id: anthropicID(res.id),
    type: "message",
    role: "assistant",
    model: res.model || model || "",
    content,
    stop_reason: stopToAnthropic(res.stop),
    stop_sequence: null,
    usage: usageToAnthropic(res.usage || emptyUsage()),
  };
  return reply;
}

/** renderChat —— 一个结果渲染成 Chat 的整包 JSON。 */
export function renderChat(res, model) {
  const msg = { role: "assistant", content: null };
  const calls = [];
  let think = "";
  for (const p of res.parts || []) {
    switch (p.kind) {
      case KIND.TEXT:
        if (p.text === "" && p.signature) continue;
        msg.content = msg.content === null ? p.text : msg.content + p.text;
        break;
      case KIND.THINKING:
        think += p.text;
        break;
      case KIND.TOOL_CALL:
        calls.push({
          id: p.id || "call_" + newID(),
          type: "function",
          function: { name: p.name, arguments: argsString(p) },
        });
        break;
      default:
        break;
    }
  }
  if (calls.length) msg.tool_calls = calls;
  if (think) msg.reasoning_content = think;
  let id = res.id || newID();
  if (!id.startsWith("chatcmpl-")) id = "chatcmpl-" + id;
  return {
    id,
    object: "chat.completion",
    created: 0,
    model: res.model || model || "",
    choices: [{ index: 0, message: msg, finish_reason: stopToChat(res.stop) }],
    usage: usageToChat(res.usage || emptyUsage()),
  };
}

/** searchResultBlock —— 一次联网检索的结果块。 */
export function searchResultBlock(id, hits) {
  return {
    type: "web_search_tool_result",
    tool_use_id: id,
    content: (hits || []).map((h) => ({
      type: "web_search_result",
      title: h.title || "",
      url: h.url || "",
      ...(h.pageAge ? { page_age: h.pageAge } : {}),
    })),
  };
}
