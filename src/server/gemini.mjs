// src/server/gemini.mjs —— Google Gemini API ↔ 统一协议 IR
//
// ## 补的是哪个洞
//
// 统一网关的入口只认 Anthropic 规范（见 src/server/gateway.mjs），所以用 Gemini
// 规范的客户端（Gemini CLI、Google 的各语言 SDK）连不上：它们打的是
// `POST /v1beta/models/{model}:generateContent`，请求体里是 `contents` /
// `parts` / `functionCall` / `functionResponse`——跟 Anthropic 的 messages 是
// 两套叫法，同一件事。
//
// 本模块是 ir.mjs 的「第三条腿」。ir.mjs 已经有 Anthropic 与 OpenAI Chat 两个
// 方向，这里补上第三个协议：
//
//   · 入向  parseGemini(body)      Gemini 请求体 → IR
//   · 出向  buildGemini(ir, opts)   IR 的结果 → Gemini 的非流式响应体
//   · 流式  geminiDecoder(opts)     上游的事件流 → Gemini 的流式响应
//
// ## magpie 的对应
//
//   · internal/gateway/gemini.go —— 本文件的三个函数分别对应它的 parseGemini、
//     renderGemini、geminiEncoder；字段处理（functionResponse 的 id 配对、
//     functionResponse 的 {output}/{error} 拆包、schema 的 OpenAPI→JSON Schema
//     改写、thoughtSignature 的往返）都照它抄。
//   · internal/gateway/ir.go —— IR 本身。本文件只 import 仓库里的 ir.mjs。
//
// ## 与 magpie 有意不同的点
//
//   1. **magpie 静默丢字段，我们报错。** magpie 用 Go 的结构体接请求，
//      不认识的字段一律丢掉（Go 的 json.Unmarshal 就是这样），客户端以为设置
//      生效了。**本仓库最在意的是不丢用户的配置**，所以凡是「我们认得出这个
//      Gemini 字段而我们又做不到」的，一律如实报错（清单见下）。宁可 400，
//      也不能让用户以为安全设置、缓存、采样参数生效了。
//   2. **toolChoice 的未知 mode 报错**，magpie 落到 default 变成 auto —— 那是
//      猜。猜错了就是模型调错了工具。
//   3. **thinkingConfig 里的 includeThoughts 我们也读**：它管的是「推理要不要
//      回给客户端」，跟「上游要不要思考」是两件事，magpie 只折了 effort。
//      我们的 r.thinking 记的是「客户端要可见推理」，r.effort 记的是档位。
//      （IR 里没有「回复里带不带思考块」这个开关的位置——回复侧由
//      buildGemini 的 opts.includeThoughts 决定，默认带，magpie 也是这样。）
//   4. **函数名叫 geminiDecoder，magpie 叫 geminiEncoder。** 它对 IR 事件的作用
//      与 ir.mjs 里的 anthropicEncoder / chatEncoder 完全一样（事件 → 客户端
//      SSE）；叫 decoder 是站在「上游那条流」的角度——它把上游的流解码成 Gemini
//      客户端要看的形状。文件末尾同时导出 geminiEncoder 这个别名，免得接线时
//      按 ir.mjs 的习惯找错名字。
//   5. **usage 的口径**：照 magpie 的 prompt()（input + cacheRead + cacheWrite）。
//      已知偏差：ir.mjs 的 chatUsage 把 OpenAI 的 prompt_tokens（**已含**缓存）
//      原样放进 input，而 anthropicUsage 里的 input_tokens（**不含**缓存）与
//      cache_read_input_tokens 是分开的——同一个字段在两条上游上口径不同，
//      这是 ir.mjs 自己的事（见报告），本模块不在地基上动手。
//   6. **Anthropic SSE 的解码自带了一份最小实现**，没有直接用 ir.mjs 的
//      anthropicDecoder——**它有个从未被跑过的 bug**：它的 decodePayload 里调
//      emit(...)，而 emit 只在 chatDecoder 的闭包里定义过，于是第一次解事件
//      就 ReferenceError（ir-test.mjs import 了它却从没调用过，所以一直没被
//      发现）。地基是只读的，改不了，所以本模块自己带一份；地基修好之后
//      换回 anthropicDecoder() 即可（见报告）。
//
// ## 明确判为「不支持」的字段（收到就报错，不静默丢）
//
//   顶层        cachedContent、safetySettings（非空）
//   generationConfig
//               topK、seed、presencePenalty、frequencyPenalty、logprobs、
//               responseModalities、candidateCount（≠1）、speechConfig、
//               audioTimestamp、mediaResolution、imageConfig、routingConfig、
//               modelConfig、serviceOptions
//   thinkingConfig
//               除 thinkingLevel / thinkingBudget / includeThoughts 之外的一切
//   tools       除 functionDeclarations / googleSearch 之外的一切
//               （codeExecution、googleMaps、urlContext、enterpriseWebSearch、
//                 computerUse、retrieval…）
//   part        除 text / thought / thoughtSignature / inlineData / fileData /
//               functionCall / functionResponse 之外的一切
//               （executableCode、codeExecutionResult、videoMetadata…）
//   functionResponse.parts
//               Gemini 3 的多模态工具结果。magpie 把它挂成 Part.Images（工具结果
//               可以带图片），**本仓库的 IR 没有这个字段**（makePart 里没有
//               images），所以我们判为不支持，而不是把图片悄悄丢掉。
//
// 不认识的字段（Google 以后新加的）同样报错：报错的字句里带着字段名，
// 运维一眼就知道该补哪里。静默丢掉才是真的坑。
//
// ## 硬约束
//
//   · 纯 ESM，零依赖（除了 ir.mjs），不碰 fs / 网络 / 时钟。
//   · 时间只能由 opts.now 进来。

import {
  KIND, EV, SEAL_ANTHROPIC,
  makePart, makeMessage, makeTool, makeRequest, makeEvent,
  parseArgs, argsOf, emptyUsage, effortOf, effortOfBudget, newID,
  stopFromAnthropic, anthropicUsage, carriedError, refusedCode, streamErrorText,
  collector, chatDecoder,
} from "./ir.mjs";

/* ------------------------------------------------------------------ *
 * 本模块认得的字段
 * ------------------------------------------------------------------ */

const TOP_FIELDS = new Set([
  "contents", "systemInstruction", "generationConfig", "tools", "toolConfig",
  "model", "stream", "labels",
]);

const TOP_UNSUPPORTED = {
  cachedContent: "上下文的缓存引用——要它成立就得能把那份内容取回来，我们做不到",
  safetySettings: "安全设置——放过它就等于悄悄改了用户的安全配置",
};

const GEN_FIELDS = new Set([
  "maxOutputTokens", "temperature", "topP", "stopSequences",
  "thinkingConfig", "responseMimeType", "responseSchema", "responseJsonSchema",
]);

const GEN_UNSUPPORTED = {
  candidateCount: "候选数——一条回复只有一条候选，其余的会被丢掉",
  topK: "采样时的 topK——IR 里没有它的位置",
  seed: "随机种子——IR 里没有它的位置",
  presencePenalty: "重复惩罚",
  frequencyPenalty: "频率惩罚",
  logprobs: "logprobs",
  responseModalities: "输出模态（图像/音频）",
  speechConfig: "语音输出配置",
  audioTimestamp: "音频时间戳",
  mediaResolution: "媒体分辨率",
  imageConfig: "图像输出配置",
  routingConfig: "自动模型路由",
  modelConfig: "模型配置",
  serviceOptions: "服务选项",
};

const THINK_FIELDS = new Set(["thinkingLevel", "thinkingBudget", "includeThoughts"]);
const PART_FIELDS = new Set([
  "text", "thought", "thoughtSignature", "inlineData", "fileData",
  "functionCall", "functionResponse",
]);
const CALL_FIELDS = new Set(["id", "name", "args"]);
const RESULT_FIELDS = new Set(["id", "name", "response"]);
const TOOL_FIELDS = new Set(["functionDeclarations", "googleSearch"]);
const CALLING_FIELDS = new Set(["mode", "allowedFunctionNames"]);

const bad = (msg) => ({ ok: false, error: String(msg) });

/** GeminiError —— partKind 抛的，parseContents 接住变成 ok:false。 */
class GeminiError extends Error {}

/* ------------------------------------------------------------------ *
 * 键名归一：proto JSON 的字段名 camelCase 与 snake_case 都收
 * ------------------------------------------------------------------ */

/**
 * Gemini 自己的字段名是 camelCase，但 Google 的 proto JSON 也认 snake_case，
 * 而且客户端真的会发 snake_case（Python SDK 的裸调用、agy）。只读 camelCase
 * 的话，一张图片或一个 PDF 就被漏掉，模型只好自己编（magpie #934）。
 *
 * 有一批字段的值是**调用方自己的**（工具的参数、工具的结果、schema），
 * 里面的键名是用户的业务字段，绝不能改。所以它们整棵子树都不动。
 */
const GEMINI_OWN_KEYS = new Set([
  "args", "response", "parameters", "parametersJsonSchema",
  "responseSchema", "responseJsonSchema", "labels",
]);

function snakeToCamel(s) {
  const parts = String(s).split("_");
  for (let i = 1; i < parts.length; i++) {
    if (parts[i]) parts[i] = parts[i][0].toUpperCase() + parts[i].slice(1);
  }
  return parts.join("");
}

function camelKeys(v) {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const k of Object.keys(v)) {
    const nk = k.includes("_") ? snakeToCamel(k) : k;
    const val = GEMINI_OWN_KEYS.has(nk) ? v[k] : camelKeys(v[k]);
    if (nk === k) {
      out[k] = val;
      continue;
    }
    // 两种写法都发了，camelCase 的留下（Google 的 proto JSON 以它为准）
    if (!Object.prototype.hasOwnProperty.call(out, nk)) out[nk] = val;
  }
  // 每一层都重建：嵌套里的 snake_case 也得跟着换掉，
  // 只在「本层没变」时返回原对象的话，父层会把换过的子树丢掉
  return out;
}

/* ------------------------------------------------------------------ *
 * 入向：Gemini 请求体 → IR
 * ------------------------------------------------------------------ */

/**
 * parseGemini —— 一个 Gemini generateContent 请求体 → IR。
 * 失败返回 `{ ok:false, error }`，**不抛异常**（与 ir.mjs 的 parseAnthropic 同规矩）。
 *
 * 模型名不在请求体里（它在路径 `/v1beta/models/{model}:generateContent` 上），
 * 流式 likewise（路径是 `:streamGenerateContent`）——所以 model 与 stream
 * 都要**接线时**从路径上写进 request.model / request.stream。
 */
export function parseGemini(body) {
  let g;
  try {
    g = typeof body === "string" ? JSON.parse(body) : body;
  } catch (e) {
    return bad(`invalid request: ${e.message}`);
  }
  if (!g || typeof g !== "object" || Array.isArray(g)) {
    return bad("invalid request: 请求体必须是一个 JSON 对象");
  }
  g = camelKeys(g);

  for (const k of Object.keys(g)) {
    if (TOP_FIELDS.has(k)) continue;
    const why = TOP_UNSUPPORTED[k];
    if (why) {
      // 空的东西没什么可 honored 的：放过（Gemini CLI 发的 safetySettings
      // 常常就是空的，为它报错会把能用的客户端挡在门外）
      if (k === "safetySettings" && Array.isArray(g[k]) && g[k].length === 0) continue;
      if (k === "cachedContent" && !g[k]) continue;
      return bad(`不支持的字段 "${k}"：${why}`);
    }
    return bad(`不认识的字段 "${k}"——本模块只认 ${Array.from(TOP_FIELDS).join("、")}`);
  }

  const r = makeRequest({
    model: typeof g.model === "string" ? g.model : "",
    stream: !!g.stream,
  });
  r.system = geminiText(g.systemInstruction);

  const gc = g.generationConfig;
  if (gc !== undefined && gc !== null) {
    const gerr = parseGenerationConfig(gc, r);
    if (gerr) return gerr;
  }

  const cerr = parseContents(g, r);
  if (cerr) return cerr;

  const terr = parseTools(g, r);
  if (terr) return terr;

  const kerr = parseToolConfig(g, r);
  if (kerr) return kerr;

  return { ok: true, request: r };
}

/* --- systemInstruction -------------------------------------------------- */

/**
 * geminiText —— systemInstruction 的文本。它可能是一个 Content（parts 数组），
 * 也可能只是一个字符串；多个文本块之间空行隔开（与 magpie 一致）。
 */
function geminiText(raw) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  const parts = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? raw.parts : null);
  if (!Array.isArray(parts)) return "";
  let b = "";
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    if (p.thought) continue;
    if (typeof p.text !== "string" || p.text === "") continue;
    if (b) b += "\n\n";
    b += p.text;
  }
  return b;
}

/* --- generationConfig --------------------------------------------------- */

function parseGenerationConfig(gc, r) {
  if (typeof gc !== "object" || Array.isArray(gc)) {
    return bad("generationConfig 必须是一个对象");
  }
  for (const k of Object.keys(gc)) {
    if (GEN_FIELDS.has(k)) continue;
    const why = GEN_UNSUPPORTED[k];
    if (why) return bad(`不支持的字段 "generationConfig.${k}"：${why}`);
    return bad(`不认识的字段 "generationConfig.${k}"`);
  }

  if (typeof gc.maxOutputTokens === "number") r.maxTokens = gc.maxOutputTokens;
  if (typeof gc.temperature === "number") r.temp = gc.temperature;
  if (typeof gc.topP === "number") r.topP = gc.topP;
  if (Array.isArray(gc.stopSequences)) {
    r.stop = gc.stopSequences.filter((s) => typeof s === "string");
  }
  if (gc.candidateCount !== undefined && gc.candidateCount !== 1) {
    return bad(`不支持的字段 "generationConfig.candidateCount"：${GEN_UNSUPPORTED.candidateCount}`);
  }

  const tc = gc.thinkingConfig;
  if (tc !== undefined && tc !== null) {
    if (typeof tc !== "object" || Array.isArray(tc)) {
      return bad("generationConfig.thinkingConfig 必须是一个对象");
    }
    for (const k of Object.keys(tc)) {
      if (!THINK_FIELDS.has(k)) {
        return bad(`不支持的字段 "generationConfig.thinkingConfig.${k}"`);
      }
    }
    let effort = "";
    if (tc.thinkingLevel !== undefined) {
      effort = effortOf(tc.thinkingLevel);
      if (!effort) {
        return bad(`generationConfig.thinkingConfig.thinkingLevel "${tc.thinkingLevel}" 认不出的档位`);
      }
    } else if (typeof tc.thinkingBudget === "number") {
      if (tc.thinkingBudget < 0) {
        effort = "medium"; // -1：让模型自己定
      } else if (tc.thinkingBudget > 0) {
        effort = effortOfBudget(tc.thinkingBudget);
      } else {
        r.thinkOff = true; // 预算 0 = 不要思考
      }
    }
    if (effort) {
      r.effort = effort;
      // includeThoughts 管的是「推理回不回给客户端」，thinkingBudget 管的是
      // 「上游要不要思考」——两件事，分开记
      r.thinking = tc.includeThoughts !== false;
    }
  }

  if (gc.responseMimeType !== undefined) {
    const mime = gc.responseMimeType;
    if (typeof mime !== "string") return bad("generationConfig.responseMimeType 必须是一个字符串");
    if (mime.startsWith("application/json")) {
      // 结构化输出：IR 的 format 记着它，同时把要求写进系统提示——
      // Gemini 客户端不知道 OpenAI 的「json_object 的提示里要写 JSON」这条规矩
      let tail = "Respond with a single JSON value and nothing else";
      r.format = { type: "json_object" };
      const schema = gc.responseJsonSchema !== undefined && gc.responseJsonSchema !== null
        ? gc.responseJsonSchema
        : gc.responseSchema;
      if (schema !== undefined && schema !== null) {
        const s = jsonSchema(schema);
        tail += ", matching this JSON schema:\n" + JSON.stringify(s);
        r.format = { type: "json_schema", name: "response", schema: s };
      }
      r.system = r.system ? r.system + "\n\n" + tail + "." : tail + ".";
    } else if (mime !== "text/plain") {
      return bad(`不支持的字段 "generationConfig.responseMimeType"："${mime}"`);
    }
  }
  return null;
}

/**
 * jsonSchema —— Gemini 自己的 schema 是 OpenAPI 味的（type 大写、多一个
 * nullable），别的协议只认 JSON Schema。把 type 压成小写、nullable 变成
 * x-nullable、丢掉 Gemini 自家的两个扩展（照 magpie）。
 */
function jsonSchema(raw) {
  if (raw === undefined || raw === null) return null;
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return raw; }
  }
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== "object") return x;
    const out = {};
    for (const k of Object.keys(x)) {
      if (k === "type") {
        const t = x[k];
        if (typeof t === "string") out[k] = t.toLowerCase();
        else if (Array.isArray(t)) {
          out[k] = t.map((e) => (typeof e === "string" ? e.toLowerCase() : e));
        } else out[k] = t;
      } else if (k === "nullable") {
        if (x[k] === true) out["x-nullable"] = true;
      } else if (k === "propertyOrdering" || k === "example") {
        // Gemini 自己的扩展，别的协议不认
      } else {
        out[k] = walk(x[k]);
      }
    }
    return out;
  };
  return walk(v);
}

/* --- contents ----------------------------------------------------------- */

/**
 * parseContents —— contents 数组 → IR 的消息。
 *
 * **最容易搞反的一处**：Gemini 的 functionResponse 是「工具的结果」，
 * 在 Anthropic 规范里对应 **tool_result 块，放在 user 消息里**；
 * functionCall 才是 tool_use，放在 assistant 消息里。搞反了整条对话就错位。
 *
 * 另外：工具结果不管客户端把它挂在哪个 role 下（Antigravity CLI 挂在
 * "model" 下，magpie #650），它永远是这一轮里用户那一边——留在 model 下面
 * 会让整条请求以模型的回合收尾，对面直接把它当成一次助手发言。
 */
function parseContents(g, r) {
  const names = {};   // 函数名 → 最近一次调用的 id
  const open = {};    // 函数名 → 还没被回答的调用 id（按调用顺序排队）
  const contents = Array.isArray(g.contents) ? g.contents : [];
  if (g.contents !== undefined && !Array.isArray(g.contents)) {
    return bad("contents 必须是一个数组");
  }

  for (const c of contents) {
    if (!c || typeof c !== "object") continue;
    for (const k of Object.keys(c)) {
      if (k !== "role" && k !== "parts") {
        return bad(`不认识的字段 "contents[].${k}"`);
      }
    }
    const role = c.role === "model" ? "assistant" : "user";
    let msg = makeMessage(role);
    const turn = (want) => {
      if (msg.role === want) return;
      if (msg.parts.length) r.messages.push(msg);
      msg = makeMessage(want);
    };
    const parts = Array.isArray(c.parts) ? c.parts : [];
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      let kind;
      try {
        kind = partKind(p);
      } catch (e) {
        return bad(e instanceof GeminiError ? e.message : String(e && e.message || e));
      }
      if (kind === "result") turn("user");
      else turn(role);

      switch (kind) {
        case "call": {
          const fc = p.functionCall;
          let id = typeof fc.id === "string" ? fc.id : "";
          if (!id) id = "call_" + newID();
          names[fc.name] = id;
          if (!open[fc.name]) open[fc.name] = [];
          open[fc.name].push(id);
          msg.parts.push(makePart({
            kind: KIND.TOOL_CALL,
            id,
            name: typeof fc.name === "string" ? fc.name : "",
            args: geminiArgs(fc.args),
            signature: typeof p.thoughtSignature === "string" ? p.thoughtSignature : "",
          }));
          break;
        }
        case "result": {
          const fr = p.functionResponse;
          const name = typeof fr.name === "string" ? fr.name : "";
          let id = typeof fr.id === "string" ? fr.id : "";
          if (!id) {
            // 客户端没带 id：按名字找那个还没被回答的调用——Gemini 把一轮里的
            // 结果按调用的顺序列出来，所以先答的配先问的
            const q = open[name] || [];
            id = q.length ? q[0] : (names[name] || "");
          }
          const q = open[name];
          if (q) {
            const at = q.indexOf(id);
            if (at >= 0) q.splice(at, 1);
          }
          const out = functionResponseText(fr.response);
          msg.parts.push(makePart({
            kind: KIND.TOOL_RESULT,
            callId: id,
            name,
            text: out.text,
            isError: out.isError,
          }));
          break;
        }
        case "image":
        case "file": {
          const d = p.inlineData || p.fileData;
          msg.parts.push(makePart({
            kind: kind === "image" ? KIND.IMAGE : KIND.FILE,
            mediaType: typeof d.mimeType === "string" ? d.mimeType : "",
            data: typeof d.data === "string" ? d.data : "",
            url: p.fileData ? (typeof p.fileData.fileUri === "string" ? p.fileData.fileUri : "") : "",
          }));
          break;
        }
        case "think": {
          msg.parts.push(makePart({
            kind: KIND.THINKING,
            text: typeof p.text === "string" ? p.text : "",
            signature: typeof p.thoughtSignature === "string" ? p.thoughtSignature : "",
          }));
          break;
        }
        case "text": {
          msg.parts.push(makePart({
            kind: KIND.TEXT,
            text: typeof p.text === "string" ? p.text : "",
            signature: typeof p.thoughtSignature === "string" ? p.thoughtSignature : "",
          }));
          break;
        }
        default:
          break;
      }
    }
    if (msg.parts.length) r.messages.push(msg);
  }
  return null;
}

/**
 * partKind —— 一个 Gemini 的 part 是什么。顺便把不认识的字段挑出来。
 */
function partKind(p) {
  for (const k of Object.keys(p)) {
    if (!PART_FIELDS.has(k)) {
      throw new GeminiError(`不支持的字段 "contents[].parts[].${k}"`);
    }
  }
  if (p.functionCall !== undefined && p.functionCall !== null) {
    const fc = p.functionCall;
    if (typeof fc !== "object" || Array.isArray(fc)) throw new GeminiError("functionCall 必须是一个对象");
    for (const k of Object.keys(fc)) {
      if (!CALL_FIELDS.has(k)) throw new GeminiError(`不支持的字段 "functionCall.${k}"`);
    }
    return "call";
  }
  if (p.functionResponse !== undefined && p.functionResponse !== null) {
    const fr = p.functionResponse;
    if (typeof fr !== "object" || Array.isArray(fr)) throw new GeminiError("functionResponse 必须是一个对象");
    for (const k of Object.keys(fr)) {
      if (!RESULT_FIELDS.has(k)) {
        if (k === "parts") {
          throw new GeminiError(
            '不支持的字段 "functionResponse.parts"：Gemini 3 的多模态工具结果——' +
            "工具结果带图片这件事本仓库的 IR 里没有位置（magpie 的 Part.Images）");
        }
        throw new GeminiError(`不支持的字段 "functionResponse.${k}"`);
      }
    }
    return "result";
  }
  if (p.inlineData !== undefined && p.inlineData !== null) {
    const d = p.inlineData;
    if (typeof d !== "object" || Array.isArray(d)) throw new GeminiError("inlineData 必须是一个对象");
    return String(d.mimeType || "").startsWith("image/") ? "image" : "file";
  }
  if (p.fileData !== undefined && p.fileData !== null) {
    const d = p.fileData;
    if (typeof d !== "object" || Array.isArray(d)) throw new GeminiError("fileData 必须是一个对象");
    return String(d.mimeType || "").startsWith("image/") ? "image" : "file";
  }
  if (p.thought === true) return "think";
  if (typeof p.text === "string" && p.text !== "") return "text";
  if (typeof p.thoughtSignature === "string" && p.thoughtSignature !== "") return "text";
  return "none";
}

/**
 * geminiArgs —— functionCall 的参数。Gemini 传的是对象，但也有客户端传
 * 一段 JSON 字符串；非 JSON 的字符串按 ir.mjs 的规矩包成 {input: …}，
 * 这样内容不会凭空消失。
 */
function geminiArgs(args) {
  if (args === undefined || args === null) return {};
  if (typeof args === "string") return parseArgs(args);
  if (typeof args !== "object" || Array.isArray(args)) return { input: args };
  return args;
}

/**
 * functionResponseText —— 工具说了什么。
 * Gemini CLI 把输出包在 {output} 里、出错包在 {error} 里；别的形状就是
 * 那个结果对象本身（照 magpie）。
 */
function functionResponseText(raw) {
  if (raw === undefined || raw === null) return { text: "", isError: false };
  if (typeof raw === "string") return { text: raw, isError: false };
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    if (keys.length === 1 && keys[0] === "error") {
      const e = raw.error;
      return { text: typeof e === "string" ? e : JSON.stringify(e), isError: true };
    }
    if (keys.length === 1 && keys[0] === "output") {
      const o = raw.output;
      return { text: typeof o === "string" ? o : JSON.stringify(o), isError: false };
    }
  }
  return { text: JSON.stringify(raw), isError: false };
}

/* --- tools -------------------------------------------------------------- */

/**
 * parseTools —— tools 数组 → IR 的工具表。
 * googleSearch 记成「客户端提供了联网检索」，别的协议自己决定能不能接。
 */
function parseTools(g, r) {
  const allowed = new Set();
  let hasAllowed = false;
  const fc = callingConfig(g);
  if (fc && (String(fc.mode || "").toUpperCase() === "ANY" || String(fc.mode || "").toUpperCase() === "VALIDATED")) {
    const list = Array.isArray(fc.allowedFunctionNames) ? fc.allowedFunctionNames : [];
    if (list.length) {
      for (const n of list) allowed.add(n);
      hasAllowed = true;
    }
  }

  const tools = Array.isArray(g.tools) ? g.tools : [];
  if (g.tools !== undefined && !Array.isArray(g.tools)) {
    return bad("tools 必须是一个数组");
  }
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    for (const k of Object.keys(t)) {
      if (!TOOL_FIELDS.has(k)) {
        return bad(`不支持的字段 "tools[].${k}"：只有 functionDeclarations 与 googleSearch 我们接得住`);
      }
    }
    if (t.googleSearch) r.webSearch = true;
    const decls = Array.isArray(t.functionDeclarations) ? t.functionDeclarations : [];
    for (const f of decls) {
      if (!f || typeof f !== "object") continue;
      const name = typeof f.name === "string" ? f.name : "";
      // ANY/VALIDATED 可以把声明限到几个名字上
      if (hasAllowed && !allowed.has(name)) continue;
      const schema = f.parametersJsonSchema !== undefined && f.parametersJsonSchema !== null
        ? f.parametersJsonSchema
        : jsonSchema(f.parameters);
      r.tools.push(makeTool({
        name,
        description: typeof f.description === "string" ? f.description : "",
        schema: schema === undefined ? null : schema,
      }));
    }
  }
  return null;
}

/* --- toolConfig --------------------------------------------------------- */

function callingConfig(g) {
  if (!g.toolConfig || typeof g.toolConfig !== "object") return null;
  const fc = g.toolConfig.functionCallingConfig;
  if (!fc || typeof fc !== "object") return null;
  return fc;
}

/**
 * parseToolConfig —— toolConfig.functionCallingConfig → IR 的 toolChoice。
 * 认不出的 mode 直接报错：猜成 auto 就是模型调错了工具。
 */
function parseToolConfig(g, r) {
  if (g.toolConfig === undefined || g.toolConfig === null) return null;
  if (typeof g.toolConfig !== "object" || Array.isArray(g.toolConfig)) {
    return bad("toolConfig 必须是一个对象");
  }
  for (const k of Object.keys(g.toolConfig)) {
    if (k !== "functionCallingConfig") {
      return bad(`不支持的字段 "toolConfig.${k}"`);
    }
  }
  const fc = callingConfig(g);
  if (!fc) return null;
  for (const k of Object.keys(fc)) {
    if (!CALLING_FIELDS.has(k)) {
      return bad(`不支持的字段 "toolConfig.functionCallingConfig.${k}"`);
    }
  }
  const mode = String(fc.mode || "AUTO").toUpperCase();
  if (mode === "NONE") {
    r.toolChoice = "none";
  } else if (mode === "ANY") {
    const list = Array.isArray(fc.allowedFunctionNames) ? fc.allowedFunctionNames : [];
    // 能指定到唯一一个函数时，指定它；指定不到就只能「必须调某个」
    if (list.length === 1 && r.tools.length === 1 && r.tools[0].name === list[0]) {
      r.toolChoice = "name:" + list[0];
    } else {
      r.toolChoice = "required";
    }
  } else if (mode === "AUTO" || mode === "VALIDATED") {
    r.toolChoice = "auto";
  } else {
    return bad(`不认识的 toolConfig.functionCallingConfig.mode "${fc.mode}"`);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 出向：IR 的结果 → Gemini 的响应体
 * ------------------------------------------------------------------ */

/**
 * buildGemini —— IR 的结果（collector().finish() 的产物）→ Gemini 的
 * generateContent 响应体。字段名与形状照 Gemini 官方的响应。
 *
 * opts.model     覆盖结果里的模型名
 * opts.responseId 覆盖 responseId
 * opts.now       没有上游 id 时用它造一个可复现的 responseId（模块内部不取时钟）
 * opts.includeThoughts  是否把推理块回给客户端（默认 true，magpie 的做法）
 */
export function buildGemini(ir, opts = {}) {
  const res = ir && typeof ir === "object" ? ir : {};
  const model = opts.model || res.model || "";
  const id = opts.responseId || res.id || responseIdOf(opts.now);
  const parts = [];
  const queries = [];
  const chunks = [];

  for (const p of res.parts || []) {
    switch (p.kind) {
      case KIND.TEXT: {
        if (p.text === "" && !p.signature) break;
        const part = { text: p.text || "" };
        // 文本上的签名是 Gemini 自己的 thoughtSignature，原样回去
        if (p.signature) part.thoughtSignature = p.signature;
        parts.push(part);
        break;
      }
      case KIND.THINKING: {
        if (opts.includeThoughts === false) break;
        // 思考块上的签名是 Anthropic 的思考签名，不是 Gemini 的
        // thoughtSignature——发过去下一轮会被 Google 拒，所以不带
        if (p.text) parts.push({ text: p.text, thought: true });
        break;
      }
      case KIND.IMAGE:
      case KIND.FILE: {
        parts.push(filePart(p));
        break;
      }
      case KIND.TOOL_CALL: {
        const part = {
          functionCall: {
            id: p.id || "call_" + newID(),
            name: p.name || "",
            args: argsOf(p),
          },
        };
        if (p.signature) part.thoughtSignature = p.signature;
        parts.push(part);
        break;
      }
      case KIND.SEARCH: {
        if (p.text) queries.push(p.text);
        for (const h of p.hits || []) {
          const web = {};
          if (h.url) web.uri = h.url;
          if (h.title) web.title = h.title;
          chunks.push({ web });
        }
        break;
      }
      default:
        break;
    }
  }

  const cand = {
    content: { role: "model", parts },
    finishReason: stopToGemini(res.stop),
    index: 0,
  };
  const grounding = {};
  if (queries.length) grounding.webSearchQueries = queries;
  if (chunks.length) grounding.groundingChunks = chunks;
  if (Object.keys(grounding).length) cand.groundingMetadata = grounding;

  return {
    candidates: [cand],
    usageMetadata: geminiUsage(res.usage || emptyUsage()),
    modelVersion: model,
    responseId: id,
  };
}

/** 渲染成 Gemini 响应体——与 ir.mjs 里 renderChat / renderAnthropic 同一个位置。 */
export const renderGemini = buildGemini;

/** filePart —— 一个图片/文件块 → Gemini 的 inlineData 或 fileData。 */
function filePart(p) {
  if (p.data) {
    return { inlineData: { mimeType: p.mediaType || "", data: p.data } };
  }
  return { fileData: { mimeType: p.mediaType || "", fileUri: p.url || "" } };
}

/** responseIdOf —— 没有上游 id 时造一个。时钟只能由 opts.now 进来。 */
function responseIdOf(now) {
  if (typeof now === "number" && Number.isFinite(now)) return "resp_" + now.toString(36);
  return "resp_" + newID();
}

/** stopToGemini —— IR 的 stop → Gemini 的 finishReason。 */
export function stopToGemini(s) {
  switch (s) {
    case "length": return "MAX_TOKENS";
    case "filter": return "SAFETY";
    default: return "STOP";
  }
}

/**
 * geminiUsage —— IR 的用量 → Gemini 的 usageMetadata。
 * 照 magpie：提示里的数含缓存，思考单独算，总数是提示加回答。
 */
export function geminiUsage(u) {
  const usage = u && typeof u === "object" ? u : emptyUsage();
  const input = usage.input || 0;
  const output = usage.output || 0;
  const reasoning = usage.reasoning || 0;
  const cacheRead = usage.cacheRead || 0;
  const cacheWrite = usage.cacheWrite || 0;
  const prompt = input + cacheRead + cacheWrite;
  const out = {
    promptTokenCount: prompt,
    candidatesTokenCount: Math.max(output - reasoning, 0),
    totalTokenCount: prompt + output,
  };
  if (cacheRead) out.cachedContentTokenCount = cacheRead;
  if (reasoning) out.thoughtsTokenCount = reasoning;
  return out;
}

/* ------------------------------------------------------------------ *
 * 流式：上游的事件流 → Gemini 的流式响应
 * ------------------------------------------------------------------ */

/**
 * anthropicEvents —— 上游的 Anthropic SSE → IR 事件。
 *
 * 为什么不用 ir.mjs 的 anthropicDecoder：**它有个从未被跑过的 bug**——
 * 它的 decodePayload 里调 emit(...)，而 emit 只在 chatDecoder 的闭包里定义过，
 * 于是第一次解事件就 ReferenceError（ir-test.mjs import 了它却从没调用过，
 * 所以这个 bug 一直没被发现）。地基是只读的，改不了，所以这里自带一个最小实现，
 * 行为照着 ir.mjs 的那份抄。**地基修好之后，换回 anthropicDecoder() 即可。**
 */
function anthropicEvents() {
  let buf = "";
  const server = {};   // 哪些下标是 Anthropic 自己的服务端工具（不是客户端的调用）
  const whole = {};    // 哪些 tool_use 的参数在 start 里就整个来了
  const emit = (events, ev) => { events.push(ev); };

  const decodePayload = (events, data) => {
    const s = String(data || "").trim();
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
        if (cb.type === "tool_use") {
          emit(events, makeEvent({ kind: EV.TOOL_START, id: cb.id || "", name: cb.name || "" }));
          const input = cb.input;
          if (input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length) {
            whole[ev.index] = true;
            emit(events, makeEvent({ kind: EV.TOOL_ARGS, text: JSON.stringify(input) }));
          }
        } else if (cb.type === "text") {
          if (cb.text) emit(events, makeEvent({ kind: EV.TEXT, text: cb.text }));
        } else if (cb.type === "thinking") {
          emit(events, makeEvent({ kind: EV.THINK_START }));
          if (cb.thinking) emit(events, makeEvent({ kind: EV.THINK, text: cb.thinking }));
          if (cb.signature) emit(events, makeEvent({ kind: EV.SIG, text: cb.signature }));
        } else if (cb.type === "redacted_thinking") {
          emit(events, makeEvent({ kind: EV.SEALED, name: SEAL_ANTHROPIC, text: JSON.stringify(cb) }));
        }
        break;
      }
      case "content_block_delta": {
        if (server[ev.index]) break;
        const d = ev.delta || {};
        if (whole[ev.index] && d.type === "input_json_delta") break;
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

/**
 * geminiDecoder —— IR 事件 → Gemini 的流式响应（SSE，每行 data: 一个 chunk）。
 *
 * 形状照 Gemini 官方的 streamGenerateContent：
 *   { candidates:[{ content:{role:"model",parts:[…]}, index:0, finishReason? }],
 *     modelVersion, responseId, usageMetadata? }
 *
 * 用法有两种：
 *   · event(ev) —— 拿 ir.mjs 的 chatDecoder / anthropicDecoder 解出来的事件喂它；
 *   · decode(text) —— 直接把上游的原始 SSE 喂给它（自己认 Anthropic 还是 Chat）。
 *
 * opts.source  "anthropic" | "chat"：指定上游的规范；不指定就自己认。
 * opts.model   回给客户端的模型名（上游报了就用上游的）。
 * opts.includeThoughts  是否把推理块发给客户端（默认 true）。
 */
export function geminiDecoder(opts = {}) {
  let id = "";
  let model = opts.model || "";
  let started = false;
  let tool = null;      // 还在攒参数的工具调用
  let args = "";
  const col = collector();

  let src = opts.source || "";   // "anthropic" | "chat" | ""
  let inner = null;              // 对应的上游解码器
  let probe = "";                // 还没认出来时的探针

  const chunk = (parts, finish, usage, extra) => {
    const list = parts || [];
    if (!list.length && !finish && !usage && !extra) return "";
    const cand = { content: { role: "model", parts: list }, index: 0 };
    if (finish) cand.finishReason = finish;
    if (extra) Object.assign(cand, extra);
    const msg = { candidates: [cand], modelVersion: model, responseId: id };
    if (usage) msg.usageMetadata = usage;
    return "data: " + JSON.stringify(msg) + "\n\n";
  };

  const start = (ev) => {
    if (started) return;
    started = true;
    id = ev.msgId || "resp_" + newID();
    if (ev.model) model = ev.model;
  };

  /** flushTool —— 参数攒齐了才发出去：Gemini 的 functionCall 是一次性的。 */
  const flushTool = () => {
    if (!tool) return "";
    const part = {
      functionCall: {
        id: tool.id || "call_" + newID(),
        name: tool.name || "",
        args: parseArgs(args),
      },
    };
    tool = null;
    args = "";
    return chunk([part]);
  };

  const event = (ev) => {
    let out = "";
    if (ev.kind !== EV.START && !started) start({});
    switch (ev.kind) {
      case EV.START:
        start(ev);
        break;
      case EV.TEXT:
        out += flushTool();
        if (ev.text) out += chunk([{ text: ev.text }]);
        break;
      case EV.THINK:
        out += flushTool();
        if (ev.text && opts.includeThoughts !== false) out += chunk([{ text: ev.text, thought: true }]);
        break;
      case EV.TEXT_SIG:
        // Gemini 自己的 thoughtSignature：文本上的那个，原样回去
        out += flushTool();
        if (ev.text) out += chunk([{ text: "", thoughtSignature: ev.text }]);
        break;
      case EV.SIG:
        // Anthropic 的思考签名不是 Gemini 的 thoughtSignature：发过去下一轮
        // 会被 Google 拒，所以不发（丢掉的是 Anthropic 专有的东西）
        break;
      case EV.IMAGE:
        out += flushTool();
        out += chunk([{ inlineData: { mimeType: ev.name || "", data: ev.text || "" } }]);
        break;
      case EV.TOOL_START:
        out += flushTool();
        tool = { id: ev.id || "", name: ev.name || "" };
        args = "";
        break;
      case EV.TOOL_ARGS:
        if (tool) args += ev.text || "";
        break;
      case EV.SEARCH: {
        out += flushTool();
        const grounding = {};
        if (ev.text) grounding.webSearchQueries = [ev.text];
        const chunks = [];
        for (const h of ev.hits || []) {
          const web = {};
          if (h.url) web.uri = h.url;
          if (h.title) web.title = h.title;
          chunks.push({ web });
        }
        if (chunks.length) grounding.groundingChunks = chunks;
        out += chunk([], "", null, { groundingMetadata: grounding });
        break;
      }
      case EV.ERROR: {
        out += flushTool();
        const failed = { code: 502, message: ev.text || "", status: "UNAVAILABLE" };
        out += "data: " + JSON.stringify({ error: failed }) + "\n\n";
        break;
      }
      default:
        break;
    }
    col.add(ev);
    return out;
  };

  const feed = (raw) => {
    if (!inner) inner = src === "anthropic" ? anthropicEvents() : chatDecoder();
    let out = "";
    for (const ev of inner.decode(raw)) out += event(ev);
    return out;
  };

  return {
    /** event —— 一个 IR 事件 → Gemini 的 SSE 文本（没有就空串）。 */
    event,
    /** decode —— 上游的原始 SSE → Gemini 的 SSE 文本。 */
    decode(text) {
      const s = String(text === undefined || text === null ? "" : text);
      if (!src) {
        probe += s;
        const found = sniff(probe);
        if (!found) return "";
        src = found;
        const whole = probe;
        probe = "";
        return feed(whole);
      }
      return feed(s);
    },
    /** flush —— 收尾：上游剩下的事件、攒着的工具调用、结束理由与用量。 */
    flush() {
      let out = "";
      if (inner) {
        for (const ev of inner.flush()) out += event(ev);
      }
      if (!started) start({});
      out += flushTool();
      const res = col.finish();
      out += chunk([], stopToGemini(res.stop), geminiUsage(res.usage));
      return out;
    },
  };
}

/** 同名别名——接线时按 ir.mjs 的习惯找 encoder，别找错名字。 */
export const geminiEncoder = geminiDecoder;

/**
 * sniff —— 上游那条流是 Anthropic 还是 Chat。
 * Anthropic 的每个事件都带 type（message_start…），Chat 的每个 chunk 都带
 * choices。认不出来就当 Chat（错认成 Anthropic 会把整条流丢掉）。
 */
function sniff(buf) {
  const lines = buf.split("\n");
  lines.pop(); // 最后一段可能还没收全
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.startsWith("data:")) continue;
    const s = line.slice(5).replace(/^ /, "").trim();
    if (!s || s === "[DONE]") continue;
    let v;
    try { v = JSON.parse(s); } catch { continue; }
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v.choices)) return "chat";
    if (v.object === "chat.completion.chunk" || v.object === "chat.completion") return "chat";
    if (typeof v.type === "string") return "anthropic";
    if (v.error) return "chat";
  }
  return "";
}
