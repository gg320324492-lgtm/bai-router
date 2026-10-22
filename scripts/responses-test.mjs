// scripts/responses-test.mjs —— responses.mjs 的测试
//
// 红线：这个模块补的是「入口认不认得 OpenAI Responses 规范」的那条腿，
// **任何一条断言被改弱了，这个文件就失去意义**。
//
// 跑法：node --test scripts/responses-test.mjs
//
// 反向对照（⑧）在本文件内部：把源码改坏一份**临时副本**，import 进来，
// 证明对应的断言**真的会红**。恒真的测试比没有测试更坏。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as R from "../src/server/responses.mjs";
import { KIND, EV, collector, chatDecoder, buildChat, buildAnthropic } from "../src/server/ir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src", "server", "responses.mjs");
const IR = path.join(HERE, "..", "src", "server", "ir.mjs");

/**
 * normalize —— 把随机生成的输出项 id 抹平。
 *
 * 为什么：输出项的 id 是现场生成的（`newID()`），两次运行必然不同；
 * 比对事件序列时要把它们看成同一个东西，比的才是**事件本身**。
 */
function normalize(s) {
  return String(s).replace(/"(msg|fc|rs|ws)_[a-z0-9]+"/g, '"$1_X"');
}

/* ------------------------------------------------------------------ *
 * 共用的断言（主测试与反向对照跑的是**同一条**）
 * ------------------------------------------------------------------ */

/** 断言：带 previous_response_id 的请求必须被明确拒绝。 */
function assertPreviousRejected(mod) {
  const p = mod.parseResponses(JSON.stringify({
    model: "m", input: "hi", previous_response_id: "resp_1",
  }));
  assert.equal(p.ok, false, "带 previous_response_id 必须报不支持，不能静默丢掉");
  assert.match(p.error, /previous_response_id/, "错里要点名这个字段");
}

/** 断言：store / background / conversation / text.format 都必须被拒绝。 */
function assertStateFieldsRejected(mod) {
  for (const [field, body] of [
    ["store", { model: "m", input: "hi", store: true }],
    ["background", { model: "m", input: "hi", background: true }],
    ["conversation", { model: "m", input: "hi", conversation: "conv_1" }],
    ["text.format", { model: "m", input: "hi", text: { format: { type: "json_schema", name: "x", schema: {} } } }],
  ]) {
    const p = mod.parseResponses(JSON.stringify(body));
    assert.equal(p.ok, false, field + " 必须报不支持");
    assert.match(p.error, /unsupported/, field + " 的错里要写明 unsupported");
  }
}

/** 断言：不认识的内容块类型必须报错，不能悄悄丢掉。 */
function assertUnknownPartRejected(mod) {
  const p = mod.parseResponses(JSON.stringify({
    model: "m",
    input: [{ type: "message", role: "user", content: [{ type: "input_audio", audio_url: "x" }] }],
  }));
  assert.equal(p.ok, false, "不认识的内容块必须报不支持");
  assert.match(p.error, /input_audio/);
}

/** 断言：不认识的工具类型必须报错。 */
function assertUnknownToolRejected(mod) {
  const p = mod.parseResponses(JSON.stringify({
    model: "m",
    input: "hi",
    tools: [{ type: "local_shell", name: "bash" }],
  }));
  assert.equal(p.ok, false, "不认识的工具类型必须报不支持");
  assert.match(p.error, /local_shell/);
}

/** 断言：refusal 的话必须留下。 */
function assertRefusalKept(mod) {
  const p = mod.parseResponses(JSON.stringify({
    model: "m",
    input: [{
      type: "message", role: "assistant",
      content: [{ type: "refusal", refusal: "我不能做这件事" }],
    }],
  }));
  assert.equal(p.ok, true, p.error || "");
  const part = p.request.messages[0].parts[0];
  assert.equal(part.kind, KIND.TEXT);
  assert.equal(part.text, "我不能做这件事", "拒答的话一个字都不能少");
}

/** 断言：一轮之后的 developer 消息不能被提到系统提示词里。 */
function assertRepliedDeveloperStaysInPlace(mod) {
  const p = mod.parseResponses(JSON.stringify({
    model: "m",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "问题" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "答" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "补充设定" }] },
    ],
  }));
  assert.equal(p.ok, true, p.error || "");
  assert.equal(p.request.system, "", "说过一轮之后的 developer 不是系统提示词");
  const last = p.request.messages[p.request.messages.length - 1];
  assert.equal(last.role, "user");
  assert.match(last.parts[0].text, /补充设定/);
}

/** 断言：流式必须发出那几个官方事件名。 */
function assertStreamEventNames(mod) {
  const d = mod.responsesDecoder({ source: "chat", model: "gpt-x", now: 1700000000 });
  const out = d.decode(CHAT_SSE) + d.flush();
  for (const name of [
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.completed",
  ]) {
    assert.ok(out.includes(`"type":"${name}"`), "流里必须有 " + name);
  }
}

/** 断言：正文一个字都不能少，工具参数要拼成完整 JSON。 */
function assertStreamContent(mod) {
  const d = mod.responsesDecoder({ source: "chat", model: "gpt-x", now: 1700000000 });
  const out = d.decode(CHAT_SSE) + d.flush();
  const deltas = [...out.matchAll(/"type":"response\.output_text\.delta"[^}]*"delta":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse(`"${m[1]}"`));
  assert.equal(deltas.join(""), "你好", "正文增量拼起来要等于原文");
  const args = [...out.matchAll(/"type":"response\.function_call_arguments\.delta"[^}]*"delta":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse(`"${m[1]}"`));
  assert.equal(args.join(""), "{\"city\":\"北京\"}", "工具参数增量要拼成原文");
}

/** 断言：response.completed 里带着整份输出与用量。 */
function assertCompletedPayload(mod) {
  const d = mod.responsesDecoder({ source: "chat", model: "gpt-x", now: 1700000000 });
  const out = d.decode(CHAT_SSE) + d.flush();
  const line = out.split("\n").find((l) => l.startsWith("data: ") && l.includes('"type":"response.completed"'));
  assert.ok(line, "要有 response.completed");
  const ev = JSON.parse(line.slice(6));
  assert.equal(ev.response.status, "completed");
  assert.equal(ev.response.usage.input_tokens, 10);
  assert.equal(ev.response.usage.output_tokens, 20);
  assert.equal(ev.response.usage.total_tokens, 30);
  const msg = ev.response.output.find((o) => o.type === "message");
  assert.ok(msg, "输出里要有 message 项");
  assert.equal(msg.content[0].text, "你好");
  const call = ev.response.output.find((o) => o.type === "function_call");
  assert.ok(call, "输出里要有 function_call 项");
  assert.equal(call.call_id, "call_1");
  assert.equal(call.name, "get_weather");
  assert.deepEqual(JSON.parse(call.arguments), { city: "北京" });
}

/** 断言：created_at 只能来自 opts.now。 */
function assertCreatedAtFromNow(mod) {
  const d = mod.responsesDecoder({ source: "chat", model: "gpt-x", now: 1700000000 });
  const out = d.decode(CHAT_SSE) + d.flush();
  assert.ok(out.includes('"created_at":1700000000'), "created_at 要用传进来的时刻");
  assert.equal(out.includes('"created_at":' + Math.floor(Date.now() / 1000)), false, "不许自己读时钟");
}

/** 断言：空的工具调用要补一个空对象。 */
function assertEmptyCallGetsObject(mod) {
  const enc = mod.responsesEncoder({ model: "gpt-x", now: 1 });
  let out = enc.event({ kind: EV.START, msgId: "x", model: "gpt-x" }) || "";
  out += enc.event({ kind: EV.TOOL_START, id: "call_1", name: "f" }) || "";
  out += enc.flush();
  assert.match(out, /"arguments":"\{\}"/, "没带参数的调用要补 {}");
}

/** 断言：切在任意一处，事件序列都不变。 */
function assertCutStable(mod) {
  const one = mod.responsesDecoder({ source: "chat", model: "gpt-x", now: 1 });
  const whole = normalize(one.decode(CHAT_SSE) + one.flush());
  for (let cut = 1; cut < CHAT_SSE.length; cut++) {
    const d = mod.responsesDecoder({ source: "chat", model: "gpt-x", now: 1 });
    const got = normalize(d.decode(CHAT_SSE.slice(0, cut)) + d.decode(CHAT_SSE.slice(cut)) + d.flush());
    assert.equal(got, whole, "在第 " + cut + " 个字节切开，事件序列变了");
  }
}

/** 断言：上游说 Anthropic 规范时也接得住。 */
function assertAnthropicSource(mod) {
  const d = mod.responsesDecoder({ source: "anthropic", model: "claude-x", now: 1700000000 });
  const out = d.decode(ANTHROPIC_SSE) + d.flush();
  assert.ok(out.includes('"type":"response.output_text.delta"'));
  assert.ok(out.includes('"delta":"你好"'));
  assert.ok(out.includes('"type":"response.completed"'));
}

/** 断言：非流式与流式同源——同一个 IR 结果渲染出的输出项一致。 */
function assertStreamAndNonStreamAgree(mod) {
  const d = mod.responsesDecoder({ source: "chat", model: "gpt-x", now: 1700000000 });
  const out = d.decode(CHAT_SSE) + d.flush();
  const line = out.split("\n").find((l) => l.startsWith("data: ") && l.includes('"type":"response.completed"'));
  const streamed = JSON.parse(line.slice(6)).response.output;

  const col = collector();
  const dec = chatDecoder();
  for (const ev of dec.decode(CHAT_SSE)) col.add(ev);
  for (const ev of dec.flush()) col.add(ev);
  const body = mod.buildResponses(col.finish(), { model: "gpt-x", now: 1700000000 });

  assert.equal(body.output.length, streamed.length, "两边的输出项数量要一样");
  assert.equal(body.output[0].content[0].text, streamed[0].content[0].text);
  assert.equal(body.output[1].arguments, streamed[1].arguments);
  assert.equal(body.usage.input_tokens, 10);
  assert.equal(body.usage.output_tokens, 20);
}

/* ------------------------------------------------------------------ *
 * ① 请求体 → IR
 * ------------------------------------------------------------------ */

const RESPONSES_BODY = {
  model: "gpt-5.5",
  instructions: "你是助手",
  max_output_tokens: 512,
  temperature: 0.4,
  top_p: 0.9,
  stream: true,
  input: [
    {
      type: "message", role: "user",
      content: [
        { type: "input_text", text: "北京天气？" },
        { type: "input_image", image_url: "data:image/png;base64,AAA" },
      ],
    },
    {
      type: "message", role: "assistant",
      content: [
        { type: "output_text", text: "我查一下" },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{\"city\":\"北京\"}" },
      ],
    },
    { type: "function_call_output", call_id: "call_1", output: "晴 25 度" },
  ],
  tools: [
    { type: "function", name: "get_weather", description: "查天气", parameters: { type: "object", properties: { city: { type: "string" } } }, strict: true },
  ],
  tool_choice: { type: "function", name: "get_weather" },
  parallel_tool_calls: false,
  service_tier: "priority",
  prompt_cache_key: "k1",
  include: ["reasoning.encrypted_content"],
};

test("① Responses 请求 → IR：每个字段都要落在该落的地方", () => {
  const p = R.parseResponses(JSON.stringify(RESPONSES_BODY));
  assert.equal(p.ok, true, "合法请求体必须解析成功：" + p.error);

  const r = p.request;
  assert.equal(r.model, "gpt-5.5");
  assert.equal(r.system, "你是助手");
  assert.equal(r.maxTokens, 512);
  assert.equal(r.temp, 0.4);
  assert.equal(r.topP, 0.9);
  assert.equal(r.stream, true);
  assert.equal(r.parallel, false);
  assert.equal(r.tier, "priority");
  assert.equal(r.cacheKey, "k1");
  assert.deepEqual(r.include, ["reasoning.encrypted_content"]);

  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].name, "get_weather");
  assert.equal(r.tools[0].description, "查天气");
  assert.equal(r.tools[0].strict, true);
  assert.equal(r.tools[0].schema.properties.city.type, "string");
  assert.equal(r.toolChoice, "name:get_weather");

  // 三条消息
  assert.equal(r.messages.length, 3);
  const user = r.messages[0];
  assert.equal(user.role, "user");
  assert.equal(user.parts.length, 2);
  assert.equal(user.parts[0].kind, KIND.TEXT);
  assert.equal(user.parts[0].text, "北京天气？");
  assert.equal(user.parts[1].kind, KIND.IMAGE);
  assert.equal(user.parts[1].mediaType, "image/png");
  assert.equal(user.parts[1].data, "AAA");

  const asst = r.messages[1];
  assert.equal(asst.role, "assistant");
  const call = asst.parts.find((x) => x.kind === KIND.TOOL_CALL);
  assert.ok(call, "工具调用要在");
  assert.equal(call.id, "call_1");
  assert.equal(call.name, "get_weather");
  assert.deepEqual(call.args, { city: "北京" });

  const result = r.messages[2];
  assert.equal(result.role, "user");
  assert.equal(result.parts[0].kind, KIND.TOOL_RESULT);
  assert.equal(result.parts[0].callId, "call_1");
  assert.equal(result.parts[0].text, "晴 25 度");
});

test("① input 是字符串时，就是一条 user 消息", () => {
  const p = R.parseResponses(JSON.stringify({ model: "m", input: "你好" }));
  assert.equal(p.ok, true, p.error || "");
  assert.equal(p.request.messages.length, 1);
  assert.equal(p.request.messages[0].role, "user");
  assert.equal(p.request.messages[0].parts[0].text, "你好");
});

test("① reasoning.effort 折成档位，none 是「关掉思考」", () => {
  const on = R.parseResponses(JSON.stringify({ model: "m", input: "x", reasoning: { effort: "HIGH" } }));
  assert.equal(on.request.effort, "high");
  assert.equal(on.request.thinking, true);
  assert.equal(on.request.thinkOff, false);

  const off = R.parseResponses(JSON.stringify({ model: "m", input: "x", reasoning: { effort: "none" } }));
  assert.equal(off.request.thinkOff, true);
  assert.equal(off.request.effort, "low", "none 的档位归一后是 low");
});

test("① 密封的 reasoning 整块留着（逐字节回去时用得上）", () => {
  const item = {
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "想一想" }],
    encrypted_content: "ENCRYPTEDBLOB==",
  };
  const p = R.parseResponses(JSON.stringify({
    model: "m",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }, item],
  }));
  assert.equal(p.ok, true, p.error || "");
  const think = p.request.messages[1].parts[0];
  assert.equal(think.kind, KIND.THINKING);
  assert.equal(think.sealedBy, "responses");
  assert.match(think.sealed, /ENCRYPTEDBLOB/);
});

test("① tool_choice：字符串与对象两种形状都认，allowed_tools 只留白名单里的工具", () => {
  const a = R.parseResponses(JSON.stringify({ model: "m", input: "x", tool_choice: "required" }));
  assert.equal(a.request.toolChoice, "required");

  const b = R.parseResponses(JSON.stringify({
    model: "m",
    input: "x",
    tools: [
      { type: "function", name: "f1" },
      { type: "function", name: "f2" },
    ],
    tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: "f2" }] },
  }));
  assert.equal(b.request.toolChoice, "auto");
  assert.deepEqual(b.request.tools.map((t) => t.name), ["f2"], "白名单外的工具要去掉");
});

test("① web_search 工具记成「要联网检索」", () => {
  const p = R.parseResponses(JSON.stringify({
    model: "m", input: "x", tools: [{ type: "web_search_preview" }],
  }));
  assert.equal(p.ok, true, p.error || "");
  assert.equal(p.request.webSearch, true);
});

test("① 顶层 item 形状的 function_call / function_call_output 也要认", () => {
  const p = R.parseResponses(JSON.stringify({
    model: "m",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "干活" }] },
      { type: "function_call", call_id: "call_9", name: "f", arguments: "{\"a\":1}" },
      { type: "function_call_output", call_id: "call_9", output: "结果" },
    ],
  }));
  assert.equal(p.ok, true, p.error || "");
  assert.equal(p.request.messages.length, 3);
  const call = p.request.messages[1].parts[0];
  assert.equal(call.kind, KIND.TOOL_CALL);
  assert.equal(call.id, "call_9");
  assert.equal(call.name, "f");
  assert.deepEqual(call.args, { a: 1 });
  const out = p.request.messages[2].parts[0];
  assert.equal(out.kind, KIND.TOOL_RESULT);
  assert.equal(out.callId, "call_9");
  assert.equal(out.text, "结果");
});

test("① 自定义工具的调用（custom_tool_call）认得，参数包成 input", () => {
  const p = R.parseResponses(JSON.stringify({
    model: "m",
    input: [
      { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Begin Patch" },
    ],
  }));
  assert.equal(p.ok, true, p.error || "");
  const call = p.request.messages[0].parts[0];
  assert.equal(call.kind, KIND.TOOL_CALL);
  assert.equal(call.name, "apply_patch");
  assert.deepEqual(call.args, { input: "*** Begin Patch" });
});

test("① input_file 认得，落到附件块上", () => {
  const p = R.parseResponses(JSON.stringify({
    model: "m",
    input: [{
      type: "message", role: "user",
      content: [{ type: "input_file", file_id: "file-1" }],
    }],
  }));
  assert.equal(p.ok, true, p.error || "");
  const part = p.request.messages[0].parts[0];
  assert.equal(part.kind, KIND.FILE);
  assert.equal(part.url, "file-1");
});

test("① 模块导出的那套 API 一个都不能少", () => {
  for (const name of ["parseResponses", "buildResponses", "buildResponsesRequest", "responsesDecoder", "responsesEncoder"]) {
    assert.equal(typeof R[name], "function", name + " 必须导出");
  }
});

test("① 自定义工具（Codex 的 apply_patch）当成一个只收 input 字符串的函数", () => {
  const p = R.parseResponses(JSON.stringify({
    model: "m",
    input: "x",
    tools: [{ type: "custom", name: "apply_patch", description: "打补丁" }],
  }));
  assert.equal(p.ok, true, p.error || "");
  assert.equal(p.request.tools[0].name, "apply_patch");
  assert.equal(p.request.tools[0].schema.properties.input.type, "string");
  assert.match(p.request.tools[0].description, /apply_patch|打补丁/);
});

/* ------------------------------------------------------------------ *
 * ② 明确判为「不支持」的字段
 * ------------------------------------------------------------------ */

test("② previous_response_id：明确报不支持，不能静默丢掉", () => {
  assertPreviousRejected(R);
});

test("② store / background / conversation / text.format：明确报不支持", () => {
  assertStateFieldsRejected(R);
});

test("② 不认识的内容块类型：报错，不悄悄丢掉", () => {
  assertUnknownPartRejected(R);
});

test("② 不认识的工具类型：报错", () => {
  assertUnknownToolRejected(R);
});

test("② tool_choice 的怪值：报错", () => {
  const a = R.parseResponses(JSON.stringify({ model: "m", input: "x", tool_choice: "sometimes" }));
  assert.equal(a.ok, false);
  const b = R.parseResponses(JSON.stringify({ model: "m", input: "x", tool_choice: { type: "whatever" } }));
  assert.equal(b.ok, false);
});

test("② 请求体坏掉时返回 { ok:false }，不抛异常", () => {
  const a = R.parseResponses("{ 不是 JSON");
  assert.equal(a.ok, false);
  assert.ok(a.error);
  const b = R.parseResponses("[]");
  assert.equal(b.ok, false, "数组不是请求体");
  const c = R.parseResponses(JSON.stringify({ model: "m" }));
  assert.equal(c.ok, false, "缺 input 不是合法请求");
});

test("② refusal 的话要留下", () => {
  assertRefusalKept(R);
});

test("② 说过一轮之后的 developer 消息留在原处，不提到系统提示词里", () => {
  assertRepliedDeveloperStaysInPlace(R);
});

/* ------------------------------------------------------------------ *
 * ③ IR → 别的协议（这条腿存在的意义）
 * ------------------------------------------------------------------ */

test("③ Responses 请求 → IR → Chat 请求体：消息、工具、工具选择都对上", () => {
  const p = R.parseResponses(JSON.stringify(RESPONSES_BODY));
  const chat = buildChat(p.request, { model: "gpt-x" });
  assert.equal(chat.model, "gpt-x");
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[0].content, "你是助手");

  const user = chat.messages.find((m) => m.role === "user" && typeof m.content === "string");
  assert.ok(user, "用户消息要在");
  assert.match(user.content, /北京天气/);

  const asst = chat.messages.find((m) => m.role === "assistant");
  assert.ok(asst, "assistant 消息要在");
  assert.equal(asst.tool_calls.length, 1);
  assert.equal(asst.tool_calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(asst.tool_calls[0].function.arguments), { city: "北京" });

  const tool = chat.messages.find((m) => m.role === "tool");
  assert.ok(tool, "工具结果消息要在");
  assert.equal(tool.tool_call_id, "call_1");
  assert.equal(tool.content, "晴 25 度");

  assert.equal(chat.tools.length, 1);
  assert.equal(chat.tools[0].type, "function");
  assert.equal(chat.tools[0].function.name, "get_weather");
});

test("③ Responses 请求 → IR → Anthropic 请求体：工具结果落成 user 块", () => {
  const p = R.parseResponses(JSON.stringify(RESPONSES_BODY));
  const anth = buildAnthropic(p.request, { model: "claude-x" });
  assert.equal(anth.model, "claude-x");
  assert.equal(anth.system[0].text, "你是助手");
  const use = anth.messages.find((m) => m.content.some((b) => b.type === "tool_use"));
  assert.ok(use, "tool_use 要在");
  const useBlock = use.content.find((b) => b.type === "tool_use");
  assert.equal(useBlock.id, "call_1");
  assert.deepEqual(useBlock.input, { city: "北京" });
  const res = anth.messages.find((m) => m.content.some((b) => b.type === "tool_result"));
  assert.ok(res, "tool_result 要在");
  assert.equal(res.content[0].tool_use_id, "call_1");
  assert.equal(res.content[0].content, "晴 25 度");
});

test("③ IR 请求 → Responses 请求体：镜像回来，形状对得上", () => {
  const p = R.parseResponses(JSON.stringify(RESPONSES_BODY));
  const back = R.buildResponsesRequest(p.request, { model: "gpt-x" });
  assert.equal(back.model, "gpt-x");
  assert.equal(back.instructions, "你是助手");
  assert.equal(back.max_output_tokens, 512);
  assert.equal(back.temperature, 0.4);
  assert.equal(back.top_p, 0.9);
  assert.equal(back.stream, true);
  assert.equal(back.store, false);
  assert.deepEqual(back.tool_choice, { type: "function", name: "get_weather" });
  assert.equal(back.tools[0].type, "function");
  assert.equal(back.tools[0].name, "get_weather");

  const kinds = back.input.map((x) => x.type);
  assert.ok(kinds.includes("message"));
  assert.ok(kinds.includes("function_call"));
  assert.ok(kinds.includes("function_call_output"));
  const call = back.input.find((x) => x.type === "function_call");
  assert.equal(call.call_id, "call_1");
  assert.equal(call.name, "get_weather");
});

/* ------------------------------------------------------------------ *
 * ④ IR 结果 → Responses 响应体（非流式）
 * ------------------------------------------------------------------ */

function makeResult(over = {}) {
  return {
    id: "chatcmpl-9",
    model: "gpt-x",
    parts: [
      makeText("你好"),
      { kind: KIND.TOOL_CALL, id: "call_1", name: "f", args: { a: 1 } },
    ],
    stop: "tool",
    usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 0, cacheWrite1h: 0, reasoning: 5 },
    ...over,
  };
}

function makeText(t) {
  return {
    kind: KIND.TEXT, text: t, mediaType: "", data: "", url: "", id: "", name: "",
    args: null, callId: "", isError: false, signature: "", sealed: "", sealedBy: "", hits: [],
  };
}

test("④ 非流式响应体：字段照 OpenAI 的 Responses 来", () => {
  const body = R.buildResponses(makeResult(), { now: 1700000000 });
  assert.equal(body.object, "response");
  assert.equal(body.id, "resp_chatcmpl-9");
  assert.equal(body.created_at, 1700000000, "时刻只能由参数给");
  assert.equal(body.status, "completed");
  assert.equal(body.model, "gpt-x");
  assert.equal(body.error, null);
  assert.equal(body.incomplete_details, null);

  assert.equal(body.output.length, 2);
  const msg = body.output[0];
  assert.equal(msg.type, "message");
  assert.equal(msg.role, "assistant");
  assert.equal(msg.status, "completed");
  assert.equal(msg.content[0].type, "output_text");
  assert.equal(msg.content[0].text, "你好");

  const call = body.output[1];
  assert.equal(call.type, "function_call");
  assert.equal(call.status, "completed");
  assert.equal(call.call_id, "call_1");
  assert.equal(call.name, "f");
  assert.deepEqual(JSON.parse(call.arguments), { a: 1 });

  assert.equal(body.usage.input_tokens, 10);
  assert.equal(body.usage.output_tokens, 20);
  assert.equal(body.usage.total_tokens, 30);
  assert.equal(body.usage.input_tokens_details.cached_tokens, 3);
  assert.equal(body.usage.output_tokens_details.reasoning_tokens, 5);
});

test("④ 撞上长度上限是 incomplete，过滤是 content_filter", () => {
  const len = R.buildResponses(makeResult({ stop: "length", parts: [makeText("半句")] }), { now: 1 });
  assert.equal(len.status, "incomplete");
  assert.deepEqual(len.incomplete_details, { reason: "max_output_tokens" });

  const filt = R.buildResponses(makeResult({ stop: "filter", parts: [makeText("") ] }), { now: 1 });
  assert.equal(filt.status, "incomplete");
  assert.deepEqual(filt.incomplete_details, { reason: "content_filter" });
});

test("④ 思考变成 reasoning 输出项", () => {
  const think = { ...makeText("想一想"), kind: KIND.THINKING };
  const body = R.buildResponses(makeResult({ parts: [think] }), { now: 1 });
  assert.equal(body.output.length, 1);
  assert.equal(body.output[0].type, "reasoning");
  assert.equal(body.output[0].summary[0].type, "summary_text");
  assert.equal(body.output[0].summary[0].text, "想一想");
});

/* ------------------------------------------------------------------ *
 * ⑤ 流式
 * ------------------------------------------------------------------ */

const CHAT_SSE = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-x","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
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
  'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-x","usage":{"input_tokens":5}}}',
  "",
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  "",
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
  "",
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  "",
  "",
].join("\n");

test("⑤ 流式：官方那几个事件名都要发出来", () => {
  assertStreamEventNames(R);
});

test("★ ⑤ 流式：正文与工具参数一个字都不能少", () => {
  assertStreamContent(R);
});

test("★ ⑤ 流式：response.completed 里带着整份输出与用量", () => {
  assertCompletedPayload(R);
});

test("⑤ 流式：created_at 只能来自 opts.now，不许自己读时钟", () => {
  assertCreatedAtFromNow(R);
});

test("★ ⑤ 整块喂进去与切成任意片段喂进去，事件序列必须完全一致", () => {
  assertCutStable(R);
});

test("⑤ 上游说 Anthropic 规范时也接得住", () => {
  assertAnthropicSource(R);
});

test("⑤ 空的工具调用要补一个空对象", () => {
  assertEmptyCallGetsObject(R);
});

test("⑤ 上游报错时发 response.failed", () => {
  const enc = R.responsesEncoder({ model: "gpt-x", now: 1 });
  let out = enc.event({ kind: EV.START, msgId: "x", model: "gpt-x" }) || "";
  out += enc.event({ kind: EV.ERROR, text: "上游炸了", code: "server_error" }) || "";
  assert.match(out, /"type":"response.failed"/);
  assert.match(out, /上游炸了/);
});

test("★ ⑤ 非流式与流式同源：同一个 IR 结果渲染出的输出项一致", async () => {
  await assertStreamAndNonStreamAgree(R);
});

/* ------------------------------------------------------------------ *
 * ⑥ 纪律
 * ------------------------------------------------------------------ */

test("⑥ 模块内部不读时钟，也不 import 仓库里别的模块", () => {
  const src = readFileSync(SRC, "utf8");
  assert.equal(/Date\.now|new Date\b|getTime\(\)/.test(src), false, "responses.mjs 里不许读时钟");
  const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["./ir.mjs"], "只能 import ir.mjs");
});

/* ------------------------------------------------------------------ *
 * ⑧ 反向对照：把实现改坏，对应断言必须真的会红
 * ------------------------------------------------------------------ */

const SABOTAGE = [
  {
    name: "previous_response_id 被静默丢掉",
    from: "if (q.previous_response_id) {",
    to: "if (false && q.previous_response_id) {",
    expect: assertPreviousRejected,
  },
  {
    name: "store/background/conversation 不再报错",
    from: "if (q.store === true) {",
    to: "if (false && q.store === true) {",
    expect: assertStateFieldsRejected,
  },
  {
    name: "text.format 不再报错",
    from: 'if (format && format.type && format.type !== "text") {',
    to: 'if (false && format && format.type && format.type !== "text") {',
    expect: assertStateFieldsRejected,
  },
  {
    name: "不认识的内容块被悄悄丢掉",
    from: 'return { error: `unsupported content part type: ${it.type} —— 我们认 input_text / output_text / text / input_image / input_file / refusal / function_call / function_call_output / reasoning` };',
    to: 'break; /* sabotage: 不认识的内容块被悄悄丢掉 */',
    expect: assertUnknownPartRejected,
  },
  {
    name: "不认识的工具类型被悄悄丢掉",
    from: 'return `unsupported tool type: ${type || "(空)"} —— 我们认 function / custom / namespace / web_search`;',
    to: 'continue; /* sabotage: 不认识的工具类型被悄悄丢掉 */',
    expect: assertUnknownToolRejected,
  },
  {
    name: "refusal 的话被丢掉",
    from: 'case "refusal":',
    to: 'case "refusal_never":',
    expect: assertRefusalKept,
  },
  {
    name: "一轮之后的 developer 被提到系统提示词里",
    from: "if (replied) {",
    to: "if (false) {",
    expect: assertRepliedDeveloperStaysInPlace,
  },
  {
    name: "流式事件名发错",
    from: '"response.output_text.delta"',
    to: '"response.output_text.deltaz"',
    expect: assertStreamEventNames,
  },
  {
    name: "正文增量被吞掉",
    from: "content_index: 0, delta: ev.text, logprobs: [],",
    to: 'content_index: 0, delta: "", logprobs: [],',
    expect: assertStreamContent,
  },
  {
    name: "工具参数增量被吞掉",
    from: "output_index: outIndex, delta: ev.text,",
    to: 'output_index: outIndex, delta: "",',
    expect: assertStreamContent,
  },
  {
    name: "response.completed 不带输出与用量",
    from: 'const extra = { usage: usageToResponses(res.usage) };',
    to: 'const extra = { usage: usageToResponses(res.usage), output: [] };',
    expect: assertCompletedPayload,
  },
  {
    name: "created_at 自己读时钟",
    from: "const created = Number(opts.now) || 0;\n  let seq = 0;",
    to: "const created = Math.floor(Date.now() / 1000);\n  let seq = 0;",
    expect: assertCreatedAtFromNow,
  },
  {
    name: "空的工具调用不补空对象",
    from: 'const args = text.trim() === "" ? "{}" : text;',
    to: "const args = text;",
    expect: assertEmptyCallGetsObject,
  },
  {
    name: "流被切成两半就丢内容",
    from: "    decode(text) {\n      let out = \"\";",
    to: "    decode(text) {\n      let out = \"\";\n      if (!String(text).endsWith(\"\\n\\n\")) return out; /* sabotage: 半截就丢 */",
    expect: assertCutStable,
  },
  {
    name: "Anthropic 上游接不住",
    from: "const dec = source === \"anthropic\" ? anthropicDecoder() : chatDecoder();",
    to: "const dec = chatDecoder();",
    expect: assertAnthropicSource,
  },
  {
    name: "非流式与流式答出两个不同的东西",
    from: 'content: [{ type: "output_text", text: p.text || "", annotations: [] }],',
    to: 'content: [{ type: "output_text", text: "", annotations: [] }],',
    expect: assertStreamAndNonStreamAgree,
  },
];

/** 把源码改坏一份临时副本，import 进来。改的是副本，原件一个字都不动。 */
async function patched(s) {
  const src = readFileSync(SRC, "utf8");
  const hits = src.split(s.from).length - 1;
  assert.equal(hits, 1, `「${s.name}」的锚点在源码里命中 ${hits} 次（必须恰好 1 次）—— 补丁没打上`);
  const dir = mkdtempSync(path.join(tmpdir(), "bai-responses-"));
  const file = path.join(dir, "responses.mjs");
  const code = src
    .replace(s.from, s.to)
    .replace('"./ir.mjs"', JSON.stringify(pathToFileURL(IR).href));
  writeFileSync(file, code, "utf8");
  const mod = await import(pathToFileURL(file).href);
  return { mod, dir };
}

test("⑧ 反向对照：每一处改坏都要把对应断言打红（恒真的测试比没有测试更坏）", async () => {
  for (const s of SABOTAGE) {
    const { mod, dir } = await patched(s);
    let red = false;
    let why = "";
    try {
      s.expect(mod);
    } catch (e) {
      red = true;
      why = String((e && e.message) || e).slice(0, 120);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(red, true, `「${s.name}」改坏之后对应断言仍然是绿的 —— 这条反向对照是假的`);
    assert.ok(why.length > 0, `「${s.name}」的红灯没有理由`);
  }
});
