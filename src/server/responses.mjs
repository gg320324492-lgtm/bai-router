// src/server/responses.mjs —— OpenAI Responses API ↔ 统一协议 IR
//
// ## 补的是哪个洞
//
// 统一网关的入口**只认 Anthropic 规范**：Claude Code / Claude 桌面版连得上，
// 但用 OpenAI **Responses API**（`POST /v1/responses`，Codex 与新版 OpenAI SDK
// 说话的方式）的客户端**连不上**——它发的请求体里根本没有 `messages`，中转读
// 不到模型，整条链路死掉。
//
// 本模块是 `src/server/ir.mjs` 的**第三条腿**。Anthropic 规范与 OpenAI chat
// 规范各有一条腿（parseAnthropic/parseChat + buildChat/buildAnthropic），
// 这里补上 Responses 这一条：
//
//   · 入向 `parseResponses(body)`            —— Responses 请求体 → IR
//   · 出向 `buildResponses(res, opts)`        —— IR 结果 → Responses 非流式响应体
//   · 流式 `responsesDecoder(opts)`           —— 上游 SSE（Anthropic / chat）→ Responses SSE
//   · 附带 `buildResponsesRequest(req, opts)`  —— IR 请求 → Responses 请求体
//
// 附带的那条腿现在没人用得到（八家上游都不说 Responses 规范），但「请求/响应
// ↔ IR」两条腿齐了才叫一条腿；将来接一个说 Responses 的上游时不用重写。
//
// ## magpie 对应哪里
//
// 对应 magpie `internal/gateway/responses.go`：
//   · `parseResponses`（responses.go:310）      → 本文件的 `parseResponses`
//   · `buildResponses`（responses.go:1089）     → 本文件的 `buildResponsesRequest`
//   · `renderResponses`（responses.go:2019）    → 本文件的 `buildResponses`
//   · `responsesEncoder`（responses.go:1650）   → 本文件的 `responsesEncoder`
//   · `responsesDecoder`（responses.go:1386/1482）→ 本文件的 `responsesDecoder`
//     （magpie 的是「上游说 Responses」那一侧；本文件这一侧是「上游说
//       Anthropic/chat、客户端说 Responses」，所以把上游的解码器接在前面）
//
// ## 这是我们自己的取舍（magpie 没覆盖，或它做了而我们另做）
//
//   · **`refusal` 内容块**：magpie 的 `responsesParts`（responses.go:862）只认
//     `input_text` / `output_text` / `text` / `input_image`，**没有 refusal**。
//     我们把拒答的话**留成普通文本**——本地 IR 里没有「拒答」这一类，硬造一个
//     会让下游协议都不认；丢掉更糟（模型拒答了，客户端收到一片空白）。
//   · **不认识的内容块/工具类型一律报错**（magpie 是静默跳过）。这是本仓库
//     「不静默丢字段」的纪律：丢一个块 = 模型少看一样东西还以为看见了。
//   · **`responsesDecoder` 一步到位**：magpie 把「上游 SSE → Event」与
//     「Event → 客户端 SSE」分成两个编码器，由调用方接线；本文件把上游的
//     解码器接在自己的编码器前面，一个对象吃上游的原始 SSE、吐 Responses 的
//     SSE（`source` 选上游说哪种规范）。
//   · **`buildResponses` 这个名字**：magpie 的 `buildResponses` 是「IR → 上游
//     请求体」，渲染回复的那个叫 `renderResponses`。本文件的 `buildResponses`
//     按任务书渲染**非流式响应体**（对应 magpie 的 `renderResponses`），
//     IR → 请求体的那条腿另起名叫 `buildResponsesRequest`，免得同名不同义。
//
// ## 与 magpie **有意不同**的地方（及原因）
//
// ① `previous_response_id`：**我们报错，magpie 静默丢掉**。magpie 的
//    `rRequest` 结构里根本没这个字段（responses.go:259），于是它被丢掉，
//    模型看不到上一轮——客户端以为在接续，其实在重新开一轮，还答得像模像样。
//    本地中继没有 Responses 的响应存储，拿不到历史就**明确报「不支持」**。
// ② `store: true` / `background: true` / `conversation`：**我们报错**。三者都要
//    服务端存状态或异步跑，本地中转一样都做不到（magpie 有自己的会话存储，
//    所以它不报）。
// ③ `text.format`（结构化输出 / json_schema）：**我们报错**。本地 IR 里没有
//    承载「输出格式」的位置，悄悄丢掉 = 客户端拿到一段自由文本再 JSON.parse
//    失败，错误现场还留在客户端那边，更难查。
// ④ 不认识的**顶层**字段一律忽略：OpenAI 会持续加字段，为不认识的新字段拒绝
//    服务比丢字段更糟。**会改变语义**的字段在 ①②③ 里，一律报错。
// ⑤ 用量口径：magpie 的 IR 把 `Usage.Input` 记成**未命中缓存**的那部分
//    （ir.go:408 的 `prompt()` 才把它加回去），而本地 `ir.mjs` 的 `input` 是
//    **整个提示词**（`chatUsage`/`anthropicUsage` 都是总量）。所以本文件直接
//    输出 `input_tokens: u.input`，**不再把缓存加回来**（加了就是重复计费）。
// ⑥ magpie 会剥掉工具 schema 里的 `"encrypted"` 标记（responses.go:167）——
//    那是 Codex 的 MultiAgentV2 专用，本仓库八家上游没人认这个标记，不剥。
// ⑦ magpie 的 `mergeTurns` 把同角色相邻消息并成一条；本地 `ir.mjs` 的
//    `buildChat`/`buildAnthropic` 自己会并，所以这里保持一条消息一条 item，
//    不重复并（并两遍会让 assistant 的两段话变成一段）。
// ⑧ 上游说 Anthropic 规范时，我们**直连 `ir.mjs` 的 `anthropicDecoder`**。
//    写这个模块时撞见过它的一个洞：它里面调用 `emit(events, …)`，而 `emit`
//    只定义在 `chatDecoder` 的闭包里（ir.mjs:1193），于是它一收到第一个事件
//    就抛 `ReferenceError: emit is not defined`（`ir-test.mjs` import 了它却
//    从没调用过，所以这个洞一直活着）。工作区里已经有那份修复（`emitEvent`
//    提上来、两个解码器共用），所以这里直接用它——**地基是只读的，缺口在
//    报告里说，不自己绕**。那份修复若被回退，本模块的 Anthropic 上游那条
//    路会跟着抛同样的错。
//
// ## 明确判为「不支持」的字段（报错，不静默丢）
//
//   · `previous_response_id`        —— 拿不到上一轮
//   · `store: true`                 —— 我们不存响应
//   · `background: true`            —— 我们不做异步响应
//   · `conversation`                —— 服务端会话 id
//   · `text.format`（非 `text`）    —— 结构化输出承载不了
//   · 内容块 `input_audio` 及其它不认识的内容块类型 —— 音频/新块型我们读不懂，
//     丢掉等于让模型少看一样东西还装作看见了
//   · 工具类型 `local_shell` / `computer` / `file_search` / `image_generation`
//     / `code_interpreter` / `mcp` 等 —— 认不了就不认（function / custom /
//     namespace / web_search 认）
//   · `tool_choice` 的字符串形态里除 `auto` / `none` / `required` 以外的值
//   · `tool_choice` 的对象形态里除 `function` / `allowed_tools` 以外的 type
//
// ## 纪律
//
//   · 纯 ESM、零依赖（除 `ir.mjs`）、零 IO、零时钟（时间由 `opts.now` 传入）。
//   · 不静默丢字段：不认识的东西要么报错，要么留下痕迹。
//   · 非流式与流式同源：非流式的响应体就是同一套 IR 结果渲染出来的，
//     不另写一遍装配逻辑（magpie 的核心省法）。

import {
  KIND, EV, SEAL_RESPONSES,
  makePart, makeMessage, makeTool, makeRequest, emptyUsage, newID,
  toolOutput, imagePart, dataURL, textOf, argsString, parseArgs, effortOf,
  attachmentText, chatDecoder, anthropicDecoder, collector,
} from "./ir.mjs";

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** respID —— 一个回复 id 变成 Responses 那种 `resp_…`。 */
function respID(id) {
  const s = String(id || "");
  if (!s) return "resp_" + newID();
  if (s.startsWith("resp_")) return s;
  return "resp_" + s;
}

/** flatName —— 命名空间里的工具被摊平后的名字（magpie 的 provider.FlatName）。 */
function flatName(ns, name) {
  return String(ns || "") + "__" + String(name || "");
}

/** safeParse —— 解析不了就当空对象（密封推理块原样透传时用）。 */
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** customSchema —— 自定义工具（Codex 的 apply_patch）被当成函数时它的参数形状。
 *  它吃的是自由文本，不是 JSON：所以只有一个 `input` 字符串。 */
const CUSTOM_SCHEMA = {
  type: "object",
  properties: {
    input: { type: "string", description: "The tool's free-form input, the whole of it, exactly as it is to be run." },
  },
  required: ["input"],
  additionalProperties: false,
};

/** customDescription —— 自定义工具的描述，改写成「函数」的说法。 */
function customDescription(t) {
  let d = String(t.description || "").trim();
  if (d) d += "\n\n";
  d += "Put the tool's whole free-form input, as it is to be run, in the `input` string; "
    + "it is passed on as written, so it is not itself JSON.";
  const f = t.format;
  if (f && typeof f === "object" && f.type === "grammar" && String(f.definition || "").trim() !== "") {
    d += "\n\nThe input follows this " + (f.syntax || "the") + " grammar:\n" + String(f.definition).trim();
  }
  return d;
}

/** usageToResponses —— IR 的用量转成 Responses 的形状。 */
export function usageToResponses(u) {
  const usage = u || emptyUsage();
  const input = usage.input || 0;
  const output = usage.output || 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: {
      cached_tokens: usage.cacheRead || 0,
      cache_write_tokens: usage.cacheWrite || 0,
    },
    output_tokens_details: { reasoning_tokens: usage.reasoning || 0 },
  };
}

/** searchItem —— 一次联网检索在 Responses 里是什么样子。 */
function searchItem(query, hits) {
  const sources = [];
  for (const h of hits || []) {
    if (h && h.url) sources.push({ type: "url", url: h.url });
  }
  const q = String(query || "");
  return {
    id: "ws_" + newID(),
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query: q, queries: q ? [q] : [], sources },
  };
}

/* ------------------------------------------------------------------ *
 * 入向：Responses 请求体 → IR
 * ------------------------------------------------------------------ */

/**
 * parseResponses —— OpenAI Responses 的请求体 → IR。
 *
 * 失败返回 `{ ok:false, error }`，**不抛异常**：调用方要能区分「这个请求体是坏的」
 * 与「网关自己坏了」，前者要给客户端一个像样的 400。
 */
export function parseResponses(body) {
  let q;
  try {
    q = typeof body === "string" ? JSON.parse(body) : body;
  } catch (e) {
    return { ok: false, error: `invalid request: ${e.message}` };
  }
  if (!q || typeof q !== "object" || Array.isArray(q)) {
    return { ok: false, error: "invalid request: not an object" };
  }

  const blocked = unsupportedField(q);
  if (blocked) return { ok: false, error: blocked };

  const r = makeRequest({
    model: q.model || "",
    system: typeof q.instructions === "string" ? q.instructions : "",
    maxTokens: typeof q.max_output_tokens === "number" ? q.max_output_tokens : 0,
    temp: typeof q.temperature === "number" ? q.temperature : null,
    topP: typeof q.top_p === "number" ? q.top_p : null,
    stream: !!q.stream,
    effort: q.reasoning && typeof q.reasoning === "object" ? effortOf(q.reasoning.effort) : "",
    parallel: typeof q.parallel_tool_calls === "boolean" ? q.parallel_tool_calls : null,
    fast: q.service_tier === "priority" || q.service_tier === "ultrafast",
    ultrafast: q.service_tier === "ultrafast",
    tier: typeof q.service_tier === "string" ? q.service_tier : "",
    cacheKey: typeof q.prompt_cache_key === "string" ? q.prompt_cache_key : "",
    include: Array.isArray(q.include) ? q.include.slice() : [],
  });
  if (r.effort) r.thinking = true;
  if (q.reasoning && typeof q.reasoning === "object") {
    r.thinkOff = String(q.reasoning.effort || "").trim().toLowerCase() === "none";
  }
  if (q.metadata && typeof q.metadata === "object" && !Array.isArray(q.metadata)) {
    r.metadata = q.metadata;
  }

  const input = q.input;
  if (input === undefined || input === null) {
    return { ok: false, error: "invalid input: 缺少 input（Responses 的请求体必须带 input）" };
  }
  if (typeof input === "string") {
    r.messages.push(makeMessage("user", [makePart({ kind: KIND.TEXT, text: input })]));
  } else if (Array.isArray(input)) {
    const bad = parseInputItems(input, r);
    if (bad) return { ok: false, error: bad };
  } else {
    return { ok: false, error: "invalid input: input 必须是字符串或数组" };
  }

  const badTools = parseTools(q.tools, r);
  if (badTools) return { ok: false, error: badTools };

  const badChoice = parseToolChoice(q.tool_choice, r);
  if (badChoice) return { ok: false, error: badChoice };

  return { ok: true, request: r };
}

/**
 * unsupportedField —— 会改变语义、而我们做不到的顶层字段。
 *
 * 为什么要报错而不是丢：丢掉之后客户端拿到的是**一个看着正常、其实答的是另一
 * 个问题**的回复；报错至少让它知道自己没被接住。
 */
function unsupportedField(q) {
  if (q.previous_response_id) {
    return "unsupported: previous_response_id —— 本地中继不保存上一轮对话，"
      + "拿不到历史就接不了这一轮；请把历史放进 input 再发";
  }
  if (q.store === true) {
    return "unsupported: store=true —— 本地中继不保存响应；请改发 store:false";
  }
  if (q.background === true) {
    return "unsupported: background —— 本地中继不做异步响应；请改发 background:false";
  }
  if (q.conversation) {
    return "unsupported: conversation —— 本地中继没有服务端会话 id；请改用 input 自带历史";
  }
  const text = q.text && typeof q.text === "object" ? q.text : null;
  const format = text && typeof text.format === "object" ? text.format : null;
  if (format && format.type && format.type !== "text") {
    return `unsupported: text.format（${format.type}）—— 本地中继承载不了结构化输出；`
      + "请改用 text.format.type=text 并在自己这边校验";
  }
  return "";
}

/**
 * parseInputItems —— Responses 的 input 数组 → IR 的消息。
 *
 * 返回空串是「没问题」，返回非空是一句能给人看的错。
 */
function parseInputItems(items, r) {
  // 说过一轮之后的 system/developer 是「就地补充」，提到 system 会把整段对话
  // 挪到提示词最前面，上下文一变，模型答的东西就变了。
  let replied = false;

  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const type = typeof it.type === "string" ? it.type : "";
    const role = typeof it.role === "string" ? it.role : "";

    if (type === "message" || (!type && role)) {
      if (role === "assistant") replied = true;
      const parts = responsesParts(it.content);
      if (parts.error) return parts.error;
      if (role === "system" || role === "developer") {
        const t = textOf(parts.parts);
        if (replied) {
          if (t) {
            r.messages.push(makeMessage("user", [makePart({
              kind: KIND.TEXT,
              text: "<system-reminder>\n" + t + "\n</system-reminder>",
            })]));
          }
        } else if (t) {
          r.system = r.system ? r.system + "\n\n" + t : t;
        }
        continue;
      }
      // 工具结果永远是「用户那头的话」（Anthropic/Chat 都这么放），
      // 哪怕客户端把它塞在一条 assistant 消息里
      const hasResult = parts.parts.some((x) => x.kind === KIND.TOOL_RESULT);
      r.messages.push(makeMessage(role === "assistant" && !hasResult ? "assistant" : "user", parts.parts));
      continue;
    }

    switch (type) {
      case "function_call":
      case "custom_tool_call": {
        // 模型调过工具 = 它已经说过话了：后面那条 system/developer 是「就地补充」
        replied = true;
        r.messages.push(makeMessage("assistant", [toolCallPart(it)]));
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        r.messages.push(makeMessage("user", toolResultParts(it)));
        break;
      }
      case "reasoning": {
        const part = reasoningPart(it);
        if (part) {
          replied = true;
          r.messages.push(makeMessage("assistant", [part]));
        }
        break;
      }
      default:
        // 别的 item（宿主工具的调用记录等）我们没有对应的 IR 形状，丢掉
        break;
    }
  }
  return "";
}

/** toolCallPart —— 一个「模型调了工具」的项（顶层 item 与内容块共用）。 */
function toolCallPart(it) {
  if (it.type === "custom_tool_call") {
    return makePart({
      kind: KIND.TOOL_CALL,
      id: it.call_id || it.id || "",
      name: it.name || "",
      args: { input: typeof it.input === "string" ? it.input : "" },
    });
  }
  return makePart({
    kind: KIND.TOOL_CALL,
    id: it.call_id || it.id || "",
    name: it.name || "",
    args: parseArgs(typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments || {})),
  });
}

/** toolResultParts —— 一个「工具的结果」项（顶层 item 与内容块共用）。 */
function toolResultParts(it) {
  const out = toolOutput(it.output);
  const parts = [makePart({
    kind: KIND.TOOL_RESULT,
    callId: it.call_id || "",
    text: out.text,
  })];
  // 工具结果带的图片不能丢：丢了模型就少看一样东西（本地 IR 的 makePart
  // 没有「结果里的图片」这个位置，只能拆成同一条消息里的图片块）。
  for (const im of out.images || []) parts.push(im);
  return parts;
}

/** reasoningPart —— 一个「模型想过了」的项（顶层 item 与内容块共用）。 */
function reasoningPart(it) {
  let b = "";
  for (const c of Array.isArray(it.content) ? it.content : []) {
    if (c && typeof c === "object" && c.type === "reasoning_text") b += c.text || "";
  }
  if (!b) {
    for (const s of Array.isArray(it.summary) ? it.summary : []) {
      if (s && typeof s === "object") b += s.text || "";
    }
  }
  const part = makePart({ kind: KIND.THINKING, text: b });
  if (it.encrypted_content) {
    // 密封的推理：整块原样带着走，回到 Responses 时逐字还原（magpie #1445）
    part.sealed = JSON.stringify(it);
    part.sealedBy = SEAL_RESPONSES;
  }
  if (!b && !part.sealed) return null;
  return part;
}

/**
 * responsesParts —— 一条 Responses 消息的 content → IR 的块。
 *
 * 不认识的内容块类型**报错**：丢掉它等于让模型少看一样东西还以为看见了。
 */
function responsesParts(raw) {
  if (typeof raw === "string") {
    return { parts: raw === "" ? [] : [makePart({ kind: KIND.TEXT, text: raw })] };
  }
  if (raw === undefined || raw === null) return { parts: [] };
  if (!Array.isArray(raw)) return { parts: [] };

  const out = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    switch (it.type) {
      case "input_text":
      case "output_text":
      case "text":
        out.push(makePart({ kind: KIND.TEXT, text: it.text || "" }));
        break;
      case "input_image": {
        const u = typeof it.image_url === "string"
          ? it.image_url
          : (it.image_url && typeof it.image_url === "object" ? it.image_url.url : "") || "";
        if (u) out.push(imagePart(u));
        break;
      }
      case "input_file": {
        // 文件：本地 IR 的 FILE 只带得动「名字 + 字节」，file_id 只有名字
        const f = it.file && typeof it.file === "object" ? it.file : it;
        if (f.file_data) {
          out.push(makePart({ kind: KIND.FILE, mediaType: "application/octet-stream", data: f.file_data }));
        } else if (f.file_id) {
          out.push(makePart({ kind: KIND.FILE, mediaType: "application/octet-stream", url: f.file_id }));
        } else if (it.filename) {
          out.push(makePart({ kind: KIND.FILE, mediaType: "application/octet-stream", url: it.filename }));
        }
        break;
      }
      case "refusal":
        // 拒答：本地 IR 没有「拒答」这一类，只能留下它说的话
        out.push(makePart({ kind: KIND.TEXT, text: it.refusal || "" }));
        break;
      case "function_call":
      case "custom_tool_call":
        // 有些客户端把工具调用放进 assistant 消息的 content 里，而不是
        // 单独一个顶层 item —— 两种都认，不然这类客户端直接连不上
        out.push(toolCallPart(it));
        break;
      case "function_call_output":
      case "custom_tool_call_output":
        for (const p of toolResultParts(it)) out.push(p);
        break;
      case "reasoning": {
        const p = reasoningPart(it);
        if (p) out.push(p);
        break;
      }
      default:
        return { error: `unsupported content part type: ${it.type} —— 我们认 input_text / output_text / text / input_image / input_file / refusal / function_call / function_call_output / reasoning` };
    }
  }
  return { parts: out };
}

/** parseTools —— Responses 的 tools → IR 的工具表。 */
function parseTools(tools, r) {
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t !== "object") continue;
    const type = typeof t.type === "string" ? t.type : "";
    if (type.startsWith("web_search")) {
      r.webSearch = true;
      continue;
    }
    if (type === "function") {
      r.tools.push(makeTool({
        name: t.name || "",
        description: t.description || "",
        schema: t.parameters === undefined ? null : t.parameters,
        strict: !!t.strict,
      }));
      continue;
    }
    if (type === "custom") {
      // 自定义工具吃自由文本：当成一个只收 input 字符串的函数
      r.tools.push(makeTool({
        name: t.name || "",
        description: customDescription(t),
        schema: CUSTOM_SCHEMA,
      }));
      continue;
    }
    if (type === "namespace") {
      for (const nt of Array.isArray(t.tools) ? t.tools : []) {
        if (!nt || typeof nt !== "object") continue;
        if (nt.type !== "function") continue;
        r.tools.push(makeTool({
          name: flatName(t.name, nt.name),
          description: nt.description || "",
          schema: nt.parameters === undefined ? null : nt.parameters,
          strict: !!nt.strict,
        }));
      }
      continue;
    }
    return `unsupported tool type: ${type || "(空)"} —— 我们认 function / custom / namespace / web_search`;
  }
  return "";
}

/** parseToolChoice —— Responses 的 tool_choice → IR 的写法。 */
function parseToolChoice(tc, r) {
  if (tc === undefined || tc === null) return "";
  if (typeof tc === "string") {
    if (tc === "auto" || tc === "none" || tc === "required") {
      r.toolChoice = tc;
      return "";
    }
    return `unsupported tool_choice: ${tc} —— 只认 auto / none / required`;
  }
  if (typeof tc !== "object") {
    return `unsupported tool_choice: ${typeof tc}`;
  }
  if (tc.type === "function") {
    r.toolChoice = "name:" + (tc.name || "");
    return "";
  }
  if (tc.type === "allowed_tools") {
    const mode = tc.mode || "auto";
    if (mode !== "auto" && mode !== "required") {
      return `invalid allowed_tools mode: ${mode}`;
    }
    r.toolChoice = mode;
    // 白名单里的工具之外的都要从工具表里去掉：留着等于允许模型去调它
    const allowed = {};
    let webSearch = false;
    for (const t of Array.isArray(tc.tools) ? tc.tools : []) {
      if (!t || typeof t !== "object") continue;
      if (typeof t.type === "string" && t.type.startsWith("web_search")) {
        webSearch = true;
        continue;
      }
      if ((t.type === "function" || t.type === "custom") && t.name) {
        allowed[t.namespace ? flatName(t.namespace, t.name) : t.name] = true;
      }
    }
    r.tools = r.tools.filter((x) => allowed[x.name]);
    if (!webSearch) r.webSearch = false;
    return "";
  }
  return `unsupported tool_choice type: ${tc.type || "(空)"} —— 只认 function / allowed_tools`;
}

/* ------------------------------------------------------------------ *
 * 出向：IR → Responses
 * ------------------------------------------------------------------ */

/**
 * buildResponsesRequest —— IR 的请求 → Responses 的请求体。
 *
 * 上游自己说 Responses 规范时才用得到；八家上游都不说，所以这条腿平时是死的。
 */
export function buildResponsesRequest(req, opts = {}) {
  const model = opts.model || req.model || "";
  const input = [];

  for (const m of req.messages || []) {
    let content = [];
    const flush = () => {
      if (!content.length) return;
      input.push({ type: "message", role: m.role, content: content.slice() });
      content = [];
    };
    for (const p of m.parts || []) {
      switch (p.kind) {
        case KIND.TEXT: {
          const t = m.role === "assistant" ? "output_text" : "input_text";
          content.push({ type: t, text: p.text || "" });
          break;
        }
        case KIND.IMAGE:
          content.push({ type: "input_image", detail: "auto", image_url: dataURL(p) });
          break;
        case KIND.FILE:
          content.push({ type: "input_text", text: attachmentText(p) });
          break;
        case KIND.TOOL_CALL:
          flush();
          input.push({
            type: "function_call",
            call_id: p.id || "call_" + newID(),
            name: p.name || "",
            arguments: argsString(p),
          });
          break;
        case KIND.TOOL_RESULT:
          flush();
          input.push({
            type: "function_call_output",
            call_id: p.callId || "",
            output: p.text || "",
          });
          break;
        case KIND.THINKING:
          if (p.sealedBy === SEAL_RESPONSES && p.sealed && sealedReasoning(p)) {
            // Responses 自己封的推理：原样回去（id、summary、encrypted_content）
            flush();
            input.push(safeParse(p.sealed));
          }
          break;
        default:
          break;
      }
    }
    flush();
  }

  const out = { model, input, stream: !!req.stream, store: false };
  if (req.system) out.instructions = req.system;
  if (req.maxTokens) out.max_output_tokens = req.maxTokens;
  if (req.temp !== null && req.temp !== undefined) out.temperature = req.temp;
  if (req.topP !== null && req.topP !== undefined) out.top_p = req.topP;
  if (req.tools && req.tools.length) {
    out.tools = req.tools.map((t) => {
      const tool = { type: "function", name: t.name, description: t.description, strict: !!t.strict };
      if (t.schema) tool.parameters = t.schema;
      return tool;
    });
  }
  if (req.toolChoice) {
    if (req.toolChoice === "auto" || req.toolChoice === "none" || req.toolChoice === "required") {
      out.tool_choice = req.toolChoice;
    } else if (req.toolChoice.startsWith("name:")) {
      out.tool_choice = { type: "function", name: req.toolChoice.slice(5) };
    }
  }
  if (req.parallel !== null && req.parallel !== undefined) out.parallel_tool_calls = req.parallel;
  if (req.tier) out.service_tier = req.tier;
  if (req.cacheKey) out.prompt_cache_key = req.cacheKey;
  if (req.include && req.include.length) out.include = req.include.slice();
  if (req.effort) out.reasoning = { effort: req.effort, summary: "auto" };
  else if (req.thinking) out.reasoning = { summary: "auto" };
  if (req.metadata && typeof req.metadata === "object") out.metadata = req.metadata;
  return out;
}

/** sealedReasoning —— 一个推理块是不是「Responses 自己封的、只能原样回去」的那种。 */
function sealedReasoning(p) {
  if (!p || p.sealedBy !== SEAL_RESPONSES || !p.sealed) return false;
  const it = safeParse(p.sealed);
  // 带 reasoning 文字的不能原样回去：OpenAI 的 Responses 收不下（magpie #1411）
  return !!it.encrypted_content && !(Array.isArray(it.content) && it.content.length);
}

/**
 * buildResponses —— IR 的**结果** → Responses 的非流式响应体。
 *
 * res 的形状就是 `ir.mjs` 里 `collector().finish()` 的结果：
 * `{ id, model, parts, stop, usage }`。这样非流式与流式同源——流式那边的
 * 输出项也是同一套 IR 结果装配出来的，两条路不会答出两个不同的东西。
 */
export function buildResponses(res, opts = {}) {
  const r = res || {};
  const model = opts.model || r.model || "";
  const id = respID(opts.responseId || r.id || "");
  const created = Number(opts.now) || 0;

  const output = [];
  for (const p of r.parts || []) {
    switch (p.kind) {
      case KIND.TEXT:
        // 只有 Gemini 的签名（空文本 + 签名）在 Responses 上什么都不是
        if (p.text === "" && p.signature) break;
        output.push({
          id: "msg_" + newID(),
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: p.text || "", annotations: [] }],
        });
        break;
      case KIND.THINKING:
        if (p.sealedBy === SEAL_RESPONSES && p.sealed) {
          output.push(safeParse(p.sealed));
          break;
        }
        if (!p.text) break; // 别的 API 封的推理，Responses 客户端读不懂
        output.push({
          id: "rs_" + newID(),
          type: "reasoning",
          status: "completed",
          summary: [{ type: "summary_text", text: p.text }],
        });
        break;
      case KIND.TOOL_CALL:
        output.push({
          id: "fc_" + newID(),
          type: "function_call",
          status: "completed",
          call_id: p.id || "call_" + newID(),
          name: p.name || "",
          arguments: argsString(p),
        });
        break;
      case KIND.SEARCH:
        output.push(searchItem(p.text, p.hits));
        break;
      default:
        break;
    }
  }

  const status = r.stop === "length" || r.stop === "filter" ? "incomplete" : "completed";
  const body = {
    id,
    object: "response",
    created_at: created,
    status,
    model,
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: usageToResponses(r.usage),
    incomplete_details: status === "incomplete"
      ? { reason: r.stop === "filter" ? "content_filter" : "max_output_tokens" }
      : null,
    error: null,
  };
  if (opts.instructions) body.instructions = opts.instructions;
  if (opts.maxOutputTokens) body.max_output_tokens = opts.maxOutputTokens;
  if (opts.temperature !== undefined && opts.temperature !== null) body.temperature = opts.temperature;
  if (opts.topP !== undefined && opts.topP !== null) body.top_p = opts.topP;
  if (opts.metadata) body.metadata = opts.metadata;
  return body;
}

/* ------------------------------------------------------------------ *
 * 流式：IR 事件 → Responses SSE
 * ------------------------------------------------------------------ */

/**
 * responsesEncoder —— IR 的事件流 → Responses 的 SSE。
 *
 * 事件名与字段形状照 OpenAI 官方的 Responses 流式事件（magpie 的
 * responsesEncoder 也是照它写的）：
 *   response.created / response.in_progress
 *   response.output_item.added / response.output_item.done
 *   response.content_part.added / response.content_part.done
 *   response.output_text.delta / response.output_text.done
 *   response.reasoning_summary_part.added / response.reasoning_summary_text.delta
 *   response.reasoning_summary_text.done / response.reasoning_summary_part.done
 *   response.function_call_arguments.delta / response.function_call_arguments.done
 *   response.completed / response.incomplete / response.failed
 *
 * 时间由 `opts.now` 传入（不读时钟）。
 */
export function responsesEncoder(opts = {}) {
  let id = respID(opts.responseId || "");
  let model = opts.model || "";
  const created = Number(opts.now) || 0;
  let seq = 0;
  let started = false;
  let outIndex = -1;   // 当前输出项的下标
  let open = "";       // 当前开着的输出项是哪一种：text / reasoning / call
  let itemID = "";
  let text = "";       // 当前输出项攒下的文本
  let call = null;     // 当前开着的工具调用 {id, name}
  let thinkFresh = false; // 上游说「接下来是另一段自己的推理」
  const output = [];   // 已经收完的输出项
  const col = collector();

  const sse = (type, fields) => {
    const body = { type, sequence_number: seq++ };
    Object.assign(body, fields);
    return "event: " + type + "\ndata: " + JSON.stringify(body) + "\n\n";
  };

  const responseObj = (status, extra) => {
    const out = {
      id,
      object: "response",
      created_at: created,
      status,
      model,
      output: output.slice(),
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [],
      usage: null,
      incomplete_details: null,
      error: null,
    };
    if (extra) Object.assign(out, extra);
    return out;
  };

  const start = (ev) => {
    if (started) return "";
    started = true;
    if (opts.responseId) id = respID(opts.responseId);
    else if (ev && ev.msgId) id = respID(ev.msgId);
    if (ev && ev.model) model = ev.model;
    let b = sse("response.created", { response: responseObj("in_progress") });
    b += sse("response.in_progress", { response: responseObj("in_progress") });
    return b;
  };

  const closeItem = () => {
    if (!open) return "";
    let b = "";
    if (open === "text") {
      b += sse("response.output_text.done", {
        item_id: itemID, output_index: outIndex, content_index: 0, text, logprobs: [],
      });
      const part = { type: "output_text", text, annotations: [], logprobs: [] };
      b += sse("response.content_part.done", {
        item_id: itemID, output_index: outIndex, content_index: 0, part,
      });
      const item = {
        id: itemID, type: "message", role: "assistant", status: "completed", content: [part],
      };
      b += sse("response.output_item.done", { output_index: outIndex, item });
      output.push(item);
    } else if (open === "reasoning") {
      b += sse("response.reasoning_summary_text.done", {
        item_id: itemID, output_index: outIndex, summary_index: 0, text,
      });
      const part = { type: "summary_text", text };
      b += sse("response.reasoning_summary_part.done", {
        item_id: itemID, output_index: outIndex, summary_index: 0, part,
      });
      const item = { id: itemID, type: "reasoning", status: "completed", summary: [part] };
      b += sse("response.output_item.done", { output_index: outIndex, item });
      output.push(item);
    } else if (open === "call") {
      // 一个开了却没带参数的调用：补一个空对象，不然客户端那边永远等不到结果
      const args = text.trim() === "" ? "{}" : text;
      b += sse("response.function_call_arguments.done", {
        item_id: itemID, output_index: outIndex, call_id: call.id, arguments: args,
      });
      const item = {
        id: itemID, type: "function_call", status: "completed",
        call_id: call.id, name: call.name, arguments: args,
      };
      b += sse("response.output_item.done", { output_index: outIndex, item });
      output.push(item);
    }
    open = "";
    text = "";
    call = null;
    return b;
  };

  const openItem = (kind, id, item) => {
    let b = closeItem();
    outIndex++;
    open = kind;
    itemID = id;
    text = "";
    b += sse("response.output_item.added", { output_index: outIndex, item });
    return b;
  };

  return {
    /** event —— 收一个 IR 事件，给出这一段 Responses SSE（没有就 null）。 */
    event(ev) {
      let b = "";
      if (!ev || !ev.kind) return null;
      if (ev.kind !== EV.START && !started) b += start({});
      switch (ev.kind) {
        case EV.START:
          b += start(ev);
          break;
        case EV.TEXT: {
          if (!ev.text) break;
          if (open !== "text") {
            const mid = "msg_" + newID();
            b += openItem("text", mid, {
              id: mid, type: "message", role: "assistant", status: "in_progress", content: [],
            });
            b += sse("response.content_part.added", {
              item_id: mid, output_index: outIndex, content_index: 0,
              part: { type: "output_text", text: "", annotations: [], logprobs: [] },
            });
          }
          text += ev.text;
          b += sse("response.output_text.delta", {
            item_id: itemID, output_index: outIndex, content_index: 0, delta: ev.text, logprobs: [],
          });
          break;
        }
        case EV.THINK: {
          if (!ev.text) break;
          if (open !== "reasoning" || thinkFresh) {
            const rid = "rs_" + newID();
            b += openItem("reasoning", rid, { id: rid, type: "reasoning", summary: [] });
            b += sse("response.reasoning_summary_part.added", {
              item_id: rid, output_index: outIndex, summary_index: 0,
              part: { type: "summary_text", text: "" },
            });
            thinkFresh = false;
          }
          text += ev.text;
          b += sse("response.reasoning_summary_text.delta", {
            item_id: itemID, output_index: outIndex, summary_index: 0, delta: ev.text,
          });
          break;
        }
        case EV.THINK_START:
          // 上游说「接下来是另一段自己的推理」：下一段思考另起一个输出项
          thinkFresh = true;
          break;
        case EV.TOOL_START: {
          const cid = ev.id || "call_" + newID();
          const fid = "fc_" + newID();
          b += openItem("call", fid, {
            id: fid, type: "function_call", status: "in_progress", call_id: cid, name: ev.name, arguments: "",
          });
          call = { id: cid, name: ev.name || "" };
          break;
        }
        case EV.TOOL_ARGS: {
          if (open !== "call" || !ev.text) break;
          text += ev.text;
          b += sse("response.function_call_arguments.delta", {
            item_id: itemID, output_index: outIndex, delta: ev.text,
          });
          break;
        }
        case EV.SEALED: {
          if (ev.name !== SEAL_RESPONSES) break; // 别的 API 的，Responses 客户端读不懂
          const raw = safeParse(ev.text);
          b += closeItem();
          outIndex++;
          b += sse("response.output_item.added", { output_index: outIndex, item: raw });
          b += sse("response.output_item.done", { output_index: outIndex, item: raw });
          output.push(raw);
          break;
        }
        case EV.SEARCH: {
          b += closeItem();
          outIndex++;
          const item = searchItem(ev.text, ev.hits);
          b += sse("response.output_item.added", { output_index: outIndex, item });
          b += sse("response.web_search_call.completed", { output_index: outIndex, item_id: item.id });
          b += sse("response.output_item.done", { output_index: outIndex, item });
          output.push(item);
          break;
        }
        case EV.ERROR: {
          b += closeItem();
          const code = ev.code || "server_error";
          b += sse("response.failed", {
            response: responseObj("failed", { error: { code, message: ev.text || "" } }),
          });
          break;
        }
        default:
          break;
      }
      col.add(ev);
      return b || null;
    },

    /** flush —— 流结束：收掉开着的输出项，再发 response.completed。 */
    flush() {
      let b = "";
      if (!started) b += start({});
      b += closeItem();
      const res = col.finish();
      let status = "completed";
      let type = "response.completed";
      const extra = { usage: usageToResponses(res.usage) };
      if (res.stop === "length" || res.stop === "filter") {
        status = "incomplete";
        type = "response.incomplete";
        extra.incomplete_details = { reason: res.stop === "filter" ? "content_filter" : "max_output_tokens" };
      }
      b += sse(type, { response: responseObj(status, extra) });
      return b;
    },
  };
}

/**
 * responsesDecoder —— 上游的流 → Responses 的 SSE。
 *
 * 上游说哪种规范就接哪种（`opts.source`）：
 *   · "chat"（默认）—— OpenAI Chat Completions 的 SSE
 *   · "anthropic"   —— Anthropic Messages 的 SSE
 *
 * 内部先用 `ir.mjs` 的解码器把上游的流变成 IR 事件，再用 `responsesEncoder`
 * 变成 Responses 的 SSE——**一条事件管道**，不是两套拼装逻辑。
 *
 * `decode(text)` 收的是**原始 SSE 文本**，可以是一整段，也可以是任意切开的
 * 几段：上游把一个事件切成两半发来也不会丢。
 */
export function responsesDecoder(opts = {}) {
  const source = opts.source || "chat";
  if (source !== "chat" && source !== "anthropic") {
    throw new Error(`unsupported source: ${source} —— 我们只接上游的 chat 与 anthropic 两种 SSE`);
  }
  const dec = source === "anthropic" ? anthropicDecoder() : chatDecoder();
  const enc = responsesEncoder(opts);

  return {
    /** decode —— 收一段上游的原始 SSE 文本，给出这一段带来的 Responses SSE。 */
    decode(text) {
      let out = "";
      for (const ev of dec.decode(text)) out += enc.event(ev) || "";
      return out;
    },
    /** flush —— 流结束，把还攒着的半行交出去，并收尾。 */
    flush() {
      let out = "";
      for (const ev of dec.flush()) out += enc.event(ev) || "";
      out += enc.flush();
      return out;
    },
    /** event —— 直接喂一个 IR 事件（不经上游 SSE 解码时用）。 */
    event(ev) {
      return enc.event(ev) || "";
    },
  };
}
