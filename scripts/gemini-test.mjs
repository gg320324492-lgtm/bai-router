// scripts/gemini-test.mjs —— gemini.mjs 的测试
//
// 红线：Gemini ↔ IR 这一层一旦被改弱，Gemini 客户端连上来就是「连上了但答错」
// ——比连不上更坏。所以每一条断言都写成「旧代码必然让它红」的样子，并把
// 「把实现改坏」的那几种改法真的跑一遍，证明对应的断言**真的会红**。
//
// 跑法：node --test scripts/gemini-test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { KIND, EV, collector, buildAnthropic } from "../src/server/ir.mjs";
import {
  parseGemini, buildGemini, geminiDecoder, geminiUsage, stopToGemini,
} from "../src/server/gemini.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src", "server", "gemini.mjs");
const IR_URL = pathToFileURL(join(HERE, "..", "src", "server", "ir.mjs")).href;

/**
 * mutated —— 把实现改坏，跑一遍，证明对应的断言会红。
 * 改坏的副本写到临时目录，import 里的相对路径改成 ir.mjs 的绝对地址，
 * 所以副本一样能跑，而且**没有动仓库里的源码**。
 */
let mutSeq = 0;
async function mutated(pairs) {
  let src = readFileSync(SRC, "utf8");
  src = src.replace('from "./ir.mjs"', `from "${IR_URL}"`);
  for (const [from, to] of pairs) {
    assert.ok(src.includes(from), `锚点不在源码里，改坏的方式已经失效：${from}`);
    src = src.replace(from, to);
  }
  const dir = mkdtempSync(join(tmpdir(), "gemini-mut-"));
  const file = join(dir, "gemini.mjs");
  writeFileSync(file, src, "utf8");
  mutSeq += 1;
  const mod = await import(pathToFileURL(file).href + "#" + mutSeq);
  // 模块已经装进内存了，临时目录可以收走——别在系统临时目录里堆垃圾
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 收不走就算了 */ }
  return mod;
}

/* ---------- ① 请求体 → IR ---------- */

const GEMINI_BODY = {
  contents: [
    { role: "user", parts: [{ text: "北京天气？" }] },
    {
      role: "model",
      parts: [{ functionCall: { id: "fc_1", name: "get_weather", args: { city: "北京" } } }],
    },
    {
      // 工具结果挂在 "model" 底下——Antigravity CLI 就是这么发的（magpie #650）。
      // 它必须是 **user** 消息里的 tool_result：留在 model 下面会让整条请求
      // 以模型的回合收尾，对面把它当成一次助手发言。
      role: "model",
      parts: [{ functionResponse: { id: "fc_1", name: "get_weather", response: { output: "晴 25 度" } } }],
    },
  ],
  systemInstruction: { parts: [{ text: "你是助手" }] },
  generationConfig: { maxOutputTokens: 1024, temperature: 0.5, topP: 0.9, stopSequences: ["再见了"] },
  tools: [{
    functionDeclarations: [{
      name: "get_weather",
      description: "查天气",
      parameters: { type: "OBJECT", properties: { city: { type: "STRING" } } },
    }],
  }],
  toolConfig: { functionCallingConfig: { mode: "AUTO" } },
};

test("① Gemini 请求 → IR：system、生成参数、工具、tool_choice 都对上", () => {
  const p = parseGemini(JSON.stringify(GEMINI_BODY));
  assert.equal(p.ok, true, "合法请求体必须解析成功：" + p.error);

  const r = p.request;
  assert.equal(r.system, "你是助手");
  assert.equal(r.maxTokens, 1024);
  assert.equal(r.temp, 0.5);
  assert.equal(r.topP, 0.9);
  assert.deepEqual(r.stop, ["再见了"]);
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].name, "get_weather");
  assert.equal(r.tools[0].description, "查天气");
  assert.equal(r.toolChoice, "auto");
  assert.equal(r.messages.length, 3, "三条消息都要在");
});

test("① Gemini 的 schema 是 OpenAPI 味的：type 压小写，nullable 变 x-nullable", () => {
  const p = parseGemini(JSON.stringify({
    tools: [{
      functionDeclarations: [{
        name: "f",
        parameters: {
          type: "OBJECT",
          properties: { a: { type: "STRING", nullable: true }, b: { type: "NUMBER" } },
          propertyOrdering: ["a", "b"],
        },
      }],
    }],
  }));
  const s = p.request.tools[0].schema;
  assert.equal(s.type, "object");
  assert.equal(s.properties.a.type, "string");
  assert.equal(s.properties.a["x-nullable"], true);
  assert.equal(s.properties.b.type, "number");
  assert.equal(s.propertyOrdering, undefined, "Gemini 自家的扩展别的协议不认，要丢掉");
});

test("① snake_case 的字段名也认：只读 camelCase 的话图片就漏了（magpie #934）", () => {
  const p = parseGemini(JSON.stringify({
    contents: [{
      role: "user",
      parts: [
        { text: "看图" },
        { inline_data: { mime_type: "image/png", data: "AAA" } },
      ],
    }],
  }));
  assert.equal(p.ok, true, p.error);
  const img = p.request.messages[0].parts.find((x) => x.kind === KIND.IMAGE);
  assert.ok(img, "图片块要在——snake_case 的 inline_data 也得认");
  assert.equal(img.mediaType, "image/png");
  assert.equal(img.data, "AAA");
});

test("① inlineData 的图片与文件要分开：图片是 image，其余是 file", () => {
  const p = parseGemini(JSON.stringify({
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/png", data: "AAA" } },
        { inlineData: { mimeType: "application/pdf", data: "BBB" } },
        { fileData: { mimeType: "image/jpeg", fileUri: "https://x/y.jpg" } },
      ],
    }],
  }));
  const parts = p.request.messages[0].parts;
  assert.equal(parts[0].kind, KIND.IMAGE);
  assert.equal(parts[0].data, "AAA");
  assert.equal(parts[1].kind, KIND.FILE, "PDF 不是图片");
  assert.equal(parts[1].mediaType, "application/pdf");
  assert.equal(parts[2].kind, KIND.IMAGE);
  assert.equal(parts[2].url, "https://x/y.jpg", "fileData 留的是地址，不是字节");
});

test("① thought 块与 thoughtSignature：签名字节级保留，丢了下一轮就 400", () => {
  const sig = "EqQBCkYIBRgCKkBk3x1q2v9w==";
  const p = parseGemini(JSON.stringify({
    contents: [{
      role: "model",
      parts: [
        { text: "想一想", thought: true, thoughtSignature: sig },
        { text: "答案", thoughtSignature: sig },
      ],
    }],
  }));
  const parts = p.request.messages[0].parts;
  assert.equal(parts[0].kind, KIND.THINKING, "thought:true 是推理块");
  assert.equal(parts[0].text, "想一想");
  assert.equal(parts[0].signature, sig);
  assert.equal(parts[1].kind, KIND.TEXT);
  assert.equal(parts[1].signature, sig, "文本上的签名也要留着");
});

/* ---------- ② 工具调用：最容易搞反的一处 ---------- */

test("★ ② functionCall 是 tool_use（在 assistant 消息里），functionResponse 是 tool_result（在 user 消息里）", () => {
  const p = parseGemini(JSON.stringify(GEMINI_BODY));
  const [user, model, result] = p.request.messages;

  assert.equal(user.role, "user");
  assert.equal(user.parts[0].kind, KIND.TEXT);

  assert.equal(model.role, "assistant", "模型的调用在 assistant 消息里");
  assert.equal(model.parts[0].kind, KIND.TOOL_CALL, "functionCall 是工具调用");
  assert.equal(model.parts[0].id, "fc_1");
  assert.equal(model.parts[0].name, "get_weather");
  assert.deepEqual(model.parts[0].args, { city: "北京" });

  assert.equal(result.role, "user", "工具结果在 user 消息里——搞反了整条对话就错位");
  assert.equal(result.parts[0].kind, KIND.TOOL_RESULT, "functionResponse 是工具结果");
  assert.equal(result.parts[0].callId, "fc_1");
  assert.equal(result.parts[0].text, "晴 25 度");
});

test("★ ② 工具结果挂在 role=model 底下也一样要落进 user 消息（Antigravity CLI 这么发，magpie #650）", () => {
  const p = parseGemini(JSON.stringify({
    contents: [
      { role: "user", parts: [{ text: "干活" }] },
      { role: "model", parts: [{ functionCall: { id: "c1", name: "f" } }] },
      { role: "model", parts: [{ functionResponse: { id: "c1", name: "f", response: { output: "好了" } } }] },
    ],
  }));
  const last = p.request.messages[p.request.messages.length - 1];
  assert.equal(last.role, "user", "留在 model 下面会让请求以模型的回合收尾");
  assert.equal(last.parts[0].kind, KIND.TOOL_RESULT);
});

test("★ ② Gemini 请求 → IR → Anthropic 请求体：tool_use 与 tool_result 落在该落的位置", () => {
  const p = parseGemini(JSON.stringify(GEMINI_BODY));
  const anth = buildAnthropic(p.request, { model: "claude-x" });
  const use = anth.messages.find((m) => m.content.some((b) => b.type === "tool_use"));
  assert.ok(use, "tool_use 要在");
  assert.equal(use.role, "assistant");
  assert.equal(use.content[0].id, "fc_1");
  assert.deepEqual(use.content[0].input, { city: "北京" });

  const res = anth.messages.find((m) => m.content.some((b) => b.type === "tool_result"));
  assert.ok(res, "tool_result 要在");
  assert.equal(res.role, "user", "Anthropic 的工具结果也在 user 消息里");
  assert.equal(res.content[0].tool_use_id, "fc_1");
  assert.equal(res.content[0].content, "晴 25 度");
});

test("★ ② 工具结果没带 id 时，按名字配到那个还没被回答的调用上", () => {
  const p = parseGemini(JSON.stringify({
    contents: [
      { role: "model", parts: [{ functionCall: { name: "f", args: { a: 1 } } }] },
      { role: "user", parts: [{ functionResponse: { name: "f", response: { output: "结果" } } }] },
    ],
  }));
  const call = p.request.messages[0].parts[0];
  const result = p.request.messages[1].parts[0];
  assert.equal(result.kind, KIND.TOOL_RESULT);
  assert.equal(result.callId, call.id, "结果要配到它回答的那个调用上");
  assert.ok(call.id, "调用没带 id 时我们自己要造一个");
});

test("★ ② 一轮里两个同名调用：结果按顺序各配一个，不串", () => {
  const p = parseGemini(JSON.stringify({
    contents: [
      { role: "model", parts: [
        { functionCall: { id: "c1", name: "f", args: {} } },
        { functionCall: { id: "c2", name: "f", args: {} } },
      ] },
      { role: "user", parts: [
        { functionResponse: { id: "c1", name: "f", response: { output: "一" } } },
        { functionResponse: { id: "c2", name: "f", response: { output: "二" } } },
      ] },
    ],
  }));
  const results = p.request.messages[1].parts;
  assert.equal(results[0].callId, "c1");
  assert.equal(results[1].callId, "c2");
});

test("② 工具结果包在 {output} 里是输出，包在 {error} 里是出错", () => {
  const p = parseGemini(JSON.stringify({
    contents: [
      { role: "model", parts: [{ functionCall: { id: "c1", name: "f" } }] },
      { role: "user", parts: [{ functionResponse: { id: "c1", name: "f", response: { error: "炸了" } } }] },
      { role: "user", parts: [{ functionResponse: { id: "c2", name: "g", response: { code: 7 } } }] },
    ],
  }));
  const first = p.request.messages[1].parts[0];
  assert.equal(first.text, "炸了");
  assert.equal(first.isError, true, "包在 error 里的结果要标成出错");
  const second = p.request.messages[2].parts[0];
  assert.equal(second.text, '{"code":7}', "别的形状就是那个对象本身");
  assert.equal(second.isError, false);
});

/* ---------- ③ toolConfig 与 toolChoice ---------- */

test("③ toolConfig 的四种 mode：NONE/ANY/AUTO/VALIDATED", () => {
  const mode = (m, allowed) => parseGemini(JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "x" }] }],
    tools: [{ functionDeclarations: [{ name: "f" }, { name: "g" }] }],
    toolConfig: { functionCallingConfig: { mode: m, allowedFunctionNames: allowed } },
  })).request.toolChoice;

  assert.equal(mode("NONE"), "none");
  assert.equal(mode("ANY"), "required");
  assert.equal(mode("AUTO"), "auto");
  assert.equal(mode("VALIDATED"), "auto");
});

test("③ ANY 只留一个函数时，指定到它；留几个就只能「必须调某个」", () => {
  const one = parseGemini(JSON.stringify({
    tools: [{ functionDeclarations: [{ name: "f" }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] } },
  }));
  assert.equal(one.request.toolChoice, "name:f");
  assert.equal(one.request.tools.length, 1);

  const two = parseGemini(JSON.stringify({
    tools: [{ functionDeclarations: [{ name: "f" }, { name: "g" }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f", "g"] } },
  }));
  assert.equal(two.request.toolChoice, "required");
});

test("③ ANY 的 allowedFunctionNames 把声明限到那几个名字上", () => {
  const p = parseGemini(JSON.stringify({
    tools: [{ functionDeclarations: [{ name: "f" }, { name: "g" }, { name: "h" }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["g"] } },
  }));
  assert.equal(p.request.tools.length, 1, "限了就只剩一个声明");
  assert.equal(p.request.tools[0].name, "g");
});

/* ---------- ④ 不支持的字段：必须报错，不能静默丢 ---------- */

test("★ ④ 明确不支持的字段要报错，不能静默丢（丢了就等于改了用户的配置）", () => {
  const cases = [
    [{ contents: [], cachedContent: "cachedContents/abc" }, /cachedContent/],
    [{ contents: [], safetySettings: [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }] }, /safetySettings/],
    [{ contents: [], generationConfig: { topK: 40 } }, /topK/],
    [{ contents: [], generationConfig: { seed: 7 } }, /seed/],
    [{ contents: [], generationConfig: { responseModalities: ["IMAGE"] } }, /responseModalities/],
    [{ contents: [], generationConfig: { candidateCount: 3 } }, /candidateCount/],
    [{ contents: [], tools: [{ codeExecution: {} }] }, /codeExecution/],
    [{ contents: [{ role: "user", parts: [{ executableCode: { language: "PYTHON" } }] }] }, /executableCode/],
    [{ contents: [], toolConfig: { functionCallingConfig: { mode: "MAYBE" } } }, /MAYBE/],
  ];
  for (const [body, re] of cases) {
    const p = parseGemini(JSON.stringify(body));
    assert.equal(p.ok, false, "这个字段必须报错：" + JSON.stringify(body));
    assert.match(p.error, re, "报错要带着字段名：" + p.error);
  }
});

test("★ ④ functionResponse.parts（Gemini 3 的多模态工具结果）判为不支持：IR 里没有位置放", () => {
  const p = parseGemini(JSON.stringify({
    contents: [{
      role: "user",
      parts: [{
        functionResponse: {
          name: "f",
          response: { output: "看图" },
          parts: [{ inlineData: { mimeType: "image/png", data: "AAA" } }],
        },
      }],
    }],
  }));
  assert.equal(p.ok, false, "不能把图片悄悄丢掉");
  assert.match(p.error, /functionResponse\.parts/);
});

test("④ 不认识的字段也要报错（报错的字句里带着字段名，运维一眼知道该补哪）", () => {
  const p = parseGemini(JSON.stringify({ contents: [], someNewGoogleField: 1 }));
  assert.equal(p.ok, false);
  assert.match(p.error, /someNewGoogleField/);
});

test("④ 非法 JSON 与非对象请求体：返回 {ok:false}，不抛异常", () => {
  const a = parseGemini("{ 不是 JSON");
  assert.equal(a.ok, false);
  assert.ok(a.error, "要带一句能给人看的错");
  const b = parseGemini("[]");
  assert.equal(b.ok, false, "数组不是请求体");
});

/* ---------- ⑤ generationConfig 的思考与结构化输出 ---------- */

test("⑤ thinkingConfig：档位与预算折成 effort，预算 0 是不要思考", () => {
  const lvl = parseGemini(JSON.stringify({
    generationConfig: { thinkingConfig: { thinkingLevel: "high" } },
  })).request;
  assert.equal(lvl.effort, "high");
  assert.equal(lvl.thinking, true);

  const budget = parseGemini(JSON.stringify({
    generationConfig: { thinkingConfig: { thinkingBudget: 20000 } },
  })).request;
  assert.equal(budget.effort, "high");

  const off = parseGemini(JSON.stringify({
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  })).request;
  assert.equal(off.thinkOff, true, "预算 0 = 不要思考");
  assert.equal(off.thinking, false);

  const dyn = parseGemini(JSON.stringify({
    generationConfig: { thinkingConfig: { thinkingBudget: -1 } },
  })).request;
  assert.equal(dyn.effort, "medium", "-1 是让模型自己定");
});

test("⑤ includeThoughts=false：上游照样思考，但推理不当作「要可见」", () => {
  const p = parseGemini(JSON.stringify({
    generationConfig: { thinkingConfig: { thinkingBudget: 8000, includeThoughts: false } },
  }));
  assert.equal(p.request.effort, "medium");
  assert.equal(p.request.thinking, false, "客户端没说要看见推理");
});

test("⑤ responseMimeType=application/json：format 记下来，要求写进系统提示", () => {
  const p = parseGemini(JSON.stringify({
    systemInstruction: { parts: [{ text: "你是助手" }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", properties: { a: { type: "STRING" } } },
    },
  }));
  assert.equal(p.request.format.type, "json_schema");
  assert.equal(p.request.format.schema.type, "object");
  assert.match(p.request.system, /JSON/);
  assert.match(p.request.system, /你是助手/, "原来的系统提示要留着");
});

/* ---------- ⑥ IR → Gemini 响应体 ---------- */

function resultOf(events) {
  const col = collector();
  for (const ev of events) col.add(ev);
  return col.finish();
}

test("⑥ buildGemini 的形状：candidates / content.parts / finishReason / usageMetadata", () => {
  const res = resultOf([
    { kind: EV.START, msgId: "resp-1", model: "gemini-x" },
    { kind: EV.TEXT, text: "你好" },
    { kind: EV.STOP, stop: "stop" },
  ]);
  const body = buildGemini(res, { model: "gemini-x" });
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0].content.role, "model");
  assert.deepEqual(body.candidates[0].content.parts, [{ text: "你好" }]);
  assert.equal(body.candidates[0].finishReason, "STOP");
  assert.equal(body.candidates[0].index, 0);
  assert.equal(body.modelVersion, "gemini-x");
  assert.equal(body.responseId, "resp-1");
  assert.ok(body.usageMetadata, "用量要报");
});

test("⑥ 工具调用 → functionCall，参数是对象", () => {
  const res = resultOf([
    { kind: EV.START, msgId: "r", model: "m" },
    { kind: EV.TOOL_START, id: "call_1", name: "f" },
    { kind: EV.TOOL_ARGS, text: '{"city":"北京"}' },
    { kind: EV.STOP, stop: "tool" },
  ]);
  const body = buildGemini(res, {});
  const parts = body.candidates[0].content.parts;
  assert.equal(parts[0].functionCall.id, "call_1");
  assert.equal(parts[0].functionCall.name, "f");
  assert.deepEqual(parts[0].functionCall.args, { city: "北京" });
});

test("⑥ 用量的换算：提示含缓存，思考单独算，总数是提示加回答", () => {
  const u = geminiUsage({ input: 60, output: 20, reasoning: 8, cacheRead: 40 });
  assert.equal(u.promptTokenCount, 100, "提示的数含缓存");
  assert.equal(u.candidatesTokenCount, 12, "思考不算进候选");
  assert.equal(u.thoughtsTokenCount, 8);
  assert.equal(u.cachedContentTokenCount, 40);
  assert.equal(u.totalTokenCount, 120);
});

test("⑥ finishReason 的映射：截断是 MAX_TOKENS，被拦是 SAFETY", () => {
  assert.equal(stopToGemini("length"), "MAX_TOKENS");
  assert.equal(stopToGemini("filter"), "SAFETY");
  assert.equal(stopToGemini("stop"), "STOP");
  assert.equal(stopToGemini("tool"), "STOP", "Gemini 的函数调用回合也是 STOP");
});

/* ---------- ⑦ 流式 ---------- */

const CHAT_SSE = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-x","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"f","arguments":""}}]},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"北京\\"}"}}]},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":20}}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","usage":{"input_tokens":10,"output_tokens":1}}}',
  "",
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
  "",
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}',
  "",
  'event: message_stop',
  'data: {"type":"message_stop"}',
  "",
  "",
].join("\n");

function chunksOf(sse) {
  const out = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const s = line.slice(6).trim();
    if (!s || s === "[DONE]") continue;
    out.push(JSON.parse(s));
  }
  return out;
}

test("★ ⑦ 流式：文本增量、functionCall、usageMetadata、finishReason 的形状照 Gemini 官方", () => {
  const dec = geminiDecoder();
  const out = dec.decode(CHAT_SSE) + dec.flush();
  const chunks = chunksOf(out);

  const textChunk = chunks.find((c) => c.candidates[0].content.parts.some((p) => p.text === "你好"));
  assert.ok(textChunk, "文本增量要在");
  assert.equal(textChunk.candidates[0].content.role, "model");
  assert.equal(textChunk.candidates[0].index, 0);
  assert.equal(textChunk.modelVersion, "gpt-x");
  assert.ok(textChunk.responseId, "每块都要带 responseId");

  const callChunk = chunks.find((c) => c.candidates[0].content.parts.some((p) => p.functionCall));
  assert.ok(callChunk, "函数调用要在");
  const call = callChunk.candidates[0].content.parts.find((p) => p.functionCall).functionCall;
  assert.equal(call.id, "call_1");
  assert.equal(call.name, "f");
  assert.deepEqual(call.args, { city: "北京" }, "参数要攒齐了才发");

  const last = chunks[chunks.length - 1];
  assert.equal(last.candidates[0].finishReason, "STOP");
  assert.equal(last.usageMetadata.promptTokenCount, 10);
  assert.equal(last.usageMetadata.candidatesTokenCount, 20);
  assert.equal(last.usageMetadata.totalTokenCount, 30);
});

test("★ ⑦ 上游的流整个喂进去与切成任意片段喂进去，Gemini 的输出必须完全一致", () => {
  const one = geminiDecoder();
  const whole = one.decode(CHAT_SSE) + one.flush();
  assert.ok(whole.length > 0);

  for (let cut = 1; cut < CHAT_SSE.length; cut++) {
    const dec = geminiDecoder();
    const out = dec.decode(CHAT_SSE.slice(0, cut)) + dec.decode(CHAT_SSE.slice(cut)) + dec.flush();
    assert.equal(out, whole, "在第 " + cut + " 个字节切开，输出变了");
  }
});

test("⑦ Anthropic 的 SSE 也能直接喂：自己认出上游的规范", () => {
  const dec = geminiDecoder();
  const out = dec.decode(ANTHROPIC_SSE) + dec.flush();
  const chunks = chunksOf(out);
  const textChunk = chunks.find((c) => c.candidates[0].content.parts.some((p) => p.text === "你好"));
  assert.ok(textChunk, "Anthropic 的文本增量要变成 Gemini 的 text");
  assert.equal(textChunk.responseId, "msg_1");
  const last = chunks[chunks.length - 1];
  assert.equal(last.usageMetadata.promptTokenCount, 10);
});

test("⑦ 联网检索的结果 → groundingMetadata（别把检索结果悄悄丢掉）", () => {
  const dec = geminiDecoder();
  const out = dec.event({
    kind: EV.SEARCH,
    text: "北京天气",
    hits: [{ title: "天气", url: "https://x/weather" }],
  });
  const c = JSON.parse(out.slice(6).trim());
  const g = c.candidates[0].groundingMetadata;
  assert.deepEqual(g.webSearchQueries, ["北京天气"]);
  assert.deepEqual(g.groundingChunks, [{ web: { uri: "https://x/weather", title: "天气" } }]);
});

test("⑥ 非流式回复里的检索结果也要落到 groundingMetadata", () => {
  const res = resultOf([
    { kind: EV.START, msgId: "r", model: "m" },
    { kind: EV.SEARCH, text: "查天气", hits: [{ title: "天气", url: "https://x/weather" }] },
    { kind: EV.TEXT, text: "晴" },
  ]);
  const body = buildGemini(res, {});
  const g = body.candidates[0].groundingMetadata;
  assert.deepEqual(g.webSearchQueries, ["查天气"]);
  assert.equal(g.groundingChunks.length, 1);
  assert.equal(body.candidates[0].content.parts[0].text, "晴");
});

test("⑥ 没有上游 id 时，responseId 由 opts.now 造出来（模块内部不取时钟）", () => {
  const res = resultOf([{ kind: EV.START, model: "m" }, { kind: EV.TEXT, text: "x" }]);
  const a = buildGemini(res, { now: 1000 });
  const b = buildGemini(res, { now: 1000 });
  assert.equal(a.responseId, b.responseId, "同一个 now 要给出同一个 id");
  assert.notEqual(a.responseId, buildGemini(res, { now: 2000 }).responseId);
  assert.ok(a.responseId);
});

test("⑦ 流里的错误块要变成 Gemini 的 error，不是被跳过", () => {
  const dec = geminiDecoder();
  const out = dec.event({ kind: EV.ERROR, text: "上游炸了" });
  const c = JSON.parse(out.slice(6).trim());
  assert.equal(c.error.message, "上游炸了");
  assert.equal(c.error.status, "UNAVAILABLE");
});

test("⑦ 推理块是 thought:true，思考的签名（EV.SIG）不发——那不是 Gemini 的签名", () => {
  const dec = geminiDecoder();
  const think = dec.event({ kind: EV.THINK, text: "想一下" });
  const c = JSON.parse(think.slice(6).trim());
  assert.deepEqual(c.candidates[0].content.parts, [{ text: "想一下", thought: true }]);

  const sig = dec.event({ kind: EV.SIG, text: "ANTHROPIC-SIG" });
  assert.equal(sig, "", "Anthropic 的思考签名发过去下一轮会被 Google 拒，所以不发");
});

test("⑦ 文本上的签名（EV.TEXT_SIG）是 Gemini 自己的 thoughtSignature，要原样回去", () => {
  const dec = geminiDecoder();
  const out = dec.event({ kind: EV.TEXT_SIG, text: "SIG-1" });
  const c = JSON.parse(out.slice(6).trim());
  assert.equal(c.candidates[0].content.parts[0].thoughtSignature, "SIG-1");
});

/* ---------- ⑧ 反向对照：把实现改坏，断言必须红 ---------- */

test("★ ⑧ 反向对照：把 functionResponse 映射成 tool_call，「它是 tool_result」这条断言必须红", async () => {
  const bad = await mutated([["kind: KIND.TOOL_RESULT", "kind: KIND.TOOL_CALL"]]);
  const good = parseGemini(JSON.stringify(GEMINI_BODY)).request;
  assert.equal(good.messages[2].parts[0].kind, KIND.TOOL_RESULT, "好的实现");

  const broken = bad.parseGemini(JSON.stringify(GEMINI_BODY)).request;
  assert.notEqual(broken.messages[2].parts[0].kind, KIND.TOOL_RESULT, "改坏之后这条断言必须红");
});

test("★ ⑧ 反向对照：工具结果不转成 user 消息，「它在 user 消息里」这条断言必须红", async () => {
  const bad = await mutated([['turn("user")', "turn(role)"]]);
  const good = parseGemini(JSON.stringify(GEMINI_BODY)).request;
  assert.equal(good.messages[2].role, "user", "好的实现");

  const broken = bad.parseGemini(JSON.stringify(GEMINI_BODY)).request;
  assert.notEqual(broken.messages[2].role, "user", "改坏之后这条断言必须红");
});

test("★ ⑧ 反向对照：snake_case 不归一，「图片块要在」这条断言必须红", async () => {
  const bad = await mutated([["const nk = k.includes(\"_\") ? snakeToCamel(k) : k;", "const nk = k;"]]);
  const body = {
    contents: [{ role: "user", parts: [{ inline_data: { mime_type: "image/png", data: "AAA" } }] }],
  };
  const good = parseGemini(JSON.stringify(body));
  assert.equal(good.ok, true, "好的实现");
  assert.equal(good.request.messages[0].parts[0].kind, KIND.IMAGE);

  const broken = bad.parseGemini(JSON.stringify(body));
  assert.equal(broken.ok, false, "改坏之后这条断言必须红");
  assert.match(broken.error, /inline_data/);
});

test("★ ⑧ 反向对照：usage 少算缓存，「提示含缓存」这条断言必须红", async () => {
  const bad = await mutated([
    ["const prompt = input + cacheRead + cacheWrite;", "const prompt = input;"],
  ]);
  const good = geminiUsage({ input: 60, output: 20, reasoning: 8, cacheRead: 40 });
  assert.equal(good.promptTokenCount, 100, "好的实现");

  const broken = bad.geminiUsage({ input: 60, output: 20, reasoning: 8, cacheRead: 40 });
  assert.notEqual(broken.promptTokenCount, good.promptTokenCount, "改坏之后这条断言必须红");
});

test("★ ⑧ 反向对照：finishReason 映射错，「截断是 MAX_TOKENS」这条断言必须红", async () => {
  const bad = await mutated([['case "length": return "MAX_TOKENS";', 'case "length": return "STOP";']]);
  assert.equal(stopToGemini("length"), "MAX_TOKENS", "好的实现");
  assert.notEqual(bad.stopToGemini("length"), "MAX_TOKENS", "改坏之后这条断言必须红");
});

test("★ ⑧ 反向对照：流里攒工具参数被吞，「参数要攒齐了才发」这条断言必须红", async () => {
  const bad = await mutated([['if (tool) args += ev.text || "";', 'if (tool) args += "";']]);

  const goodDec = geminiDecoder();
  const good = chunksOf(goodDec.decode(CHAT_SSE) + goodDec.flush());
  const goodCall = good.find((c) => c.candidates[0].content.parts.some((p) => p.functionCall));
  assert.deepEqual(
    goodCall.candidates[0].content.parts.find((p) => p.functionCall).functionCall.args,
    { city: "北京" },
    "好的实现",
  );

  const badDec = bad.geminiDecoder();
  const broken = chunksOf(badDec.decode(CHAT_SSE) + badDec.flush());
  const brokenCall = broken.find((c) => c.candidates[0].content.parts.some((p) => p.functionCall));
  assert.notDeepEqual(
    brokenCall.candidates[0].content.parts.find((p) => p.functionCall).functionCall.args,
    { city: "北京" },
    "改坏之后这条断言必须红",
  );
});

test("★ ⑧ 反向对照：把「不支持的字段」改成静默放过，报错这条断言必须红", async () => {
  const bad = await mutated([
    ["return bad(`不支持的字段 \"${k}\"：${why}`);", "continue;"],
  ]);
  assert.equal(parseGemini(JSON.stringify({ contents: [], safetySettings: [] })).ok, true,
    "空数组的 safetySettings 不拦（没什么可 honored 的）");
  assert.equal(parseGemini(JSON.stringify({ contents: [], cachedContent: "x" })).ok, false, "好的实现");

  const broken = bad.parseGemini(JSON.stringify({ contents: [], cachedContent: "x" }));
  assert.equal(broken.ok, true, "改坏之后这条断言必须红");
});

test("★ ⑧ 反向对照：把「不支持的字段」整个检查删掉，不认识字段这条断言必须红", async () => {
  const bad = await mutated([
    ["if (TOP_FIELDS.has(k)) continue;", "continue;"],
  ]);
  assert.equal(parseGemini(JSON.stringify({ contents: [], someNewGoogleField: 1 })).ok, false, "好的实现");
  const broken = bad.parseGemini(JSON.stringify({ contents: [], someNewGoogleField: 1 }));
  assert.equal(broken.ok, true, "改坏之后这条断言必须红");
});

/* ---------- ⑨ 仓库规矩 ---------- */

test("⑨ 模块只依赖 ir.mjs：不 import 仓库里别的模块，也不自己取时刻", () => {
  const src = readFileSync(SRC, "utf8");
  const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(specs.length > 0, "总得有点 import");
  for (const s of specs) {
    assert.equal(s, "./ir.mjs", "只准 import ir.mjs，实际：" + s);
  }
  assert.ok(!/Date\.now|new Date\(/.test(src), "模块内部不许取时刻——时间由 opts.now 进来");
  assert.ok(!/\bprocess\./.test(src), "不许摸进程");
  assert.ok(!/\brequire\(/.test(src), "纯 ESM");
  assert.ok(!/\bfrom\s+"node:/.test(src), "不许碰 fs / 计时器");
});
