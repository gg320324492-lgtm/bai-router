// scripts/ir-test.mjs —— ir.mjs 的测试
//
// 红线：这个模块是协议层的地基，**任何一条断言被改弱了，这个文件就失去意义**。
// 所以每一条断言都写成「旧代码必然让它红」的样子——把实现改坏，测试必须变红。
//
// 跑法：node --test scripts/ir-test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  KIND, EV,
  parseAnthropic, parseChat, buildChat, buildAnthropic,
  chatDecoder, anthropicDecoder, anthropicEncoder, chatEncoder,
  chatUsage, anthropicUsage,
  pairToolMessages, pairToolBlocks, collector, renderChat, renderAnthropic,
} from "../src/server/ir.mjs";

/* ---------- ① 请求体 → IR → 另一个协议 ---------- */

const ANTHROPIC_BODY = {
  model: "claude-sonnet-5",
  max_tokens: 1024,
  system: [{ type: "text", text: "你是助手" }],
  messages: [
    { role: "user", content: [{ type: "text", text: "北京天气？" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先查天气", signature: "SIG-abc-123" },
        { type: "text", text: "我查一下" },
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "北京" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "晴 25 度" }],
    },
  ],
  tools: [
    { name: "get_weather", description: "查天气", input_schema: { type: "object", properties: { city: { type: "string" } } } },
  ],
  tool_choice: { type: "auto" },
};

test("① Anthropic 请求 → IR → Chat 请求体：工具、system、max_tokens、多轮都对上", () => {
  const p = parseAnthropic(JSON.stringify(ANTHROPIC_BODY));
  assert.equal(p.ok, true, "合法请求体必须解析成功：" + p.error);

  const r = p.request;
  assert.equal(r.model, "claude-sonnet-5");
  assert.equal(r.system, "你是助手");
  assert.equal(r.maxTokens, 1024);
  assert.equal(r.messages.length, 3, "三条消息都要在");
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].name, "get_weather");
  assert.equal(r.toolChoice, "auto");

  const chat = buildChat(r, { model: "gpt-x" });
  assert.equal(chat.model, "gpt-x");
  assert.equal(chat.max_tokens, 1024);
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[0].content, "你是助手");

  // 用户消息
  const user = chat.messages.find((m) => m.role === "user" && typeof m.content === "string");
  assert.ok(user, "用户消息要在");
  assert.match(user.content, /北京天气/);

  // assistant 的工具调用
  const asst = chat.messages.find((m) => m.role === "assistant");
  assert.ok(asst, "assistant 消息要在");
  assert.equal(asst.tool_calls.length, 1);
  assert.equal(asst.tool_calls[0].function.name, "get_weather");
  assert.deepEqual(JSON.parse(asst.tool_calls[0].function.arguments), { city: "北京" });

  // 工具结果
  const tool = chat.messages.find((m) => m.role === "tool");
  assert.ok(tool, "工具结果消息要在");
  assert.equal(tool.tool_call_id, "toolu_1");
  assert.equal(tool.content, "晴 25 度");

  // 工具定义
  assert.equal(chat.tools.length, 1);
  assert.equal(chat.tools[0].type, "function");
  assert.equal(chat.tools[0].function.name, "get_weather");
  assert.equal(chat.tools[0].function.parameters.properties.city.type, "string");
});

test("① Chat 请求 → IR → Anthropic 请求体：system 合并、工具结果降成 user 块", () => {
  const chatBody = {
    model: "gpt-x",
    max_tokens: 512,
    messages: [
      { role: "system", content: "系统一" },
      { role: "developer", content: "系统二" },
      { role: "user", content: "你好" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{\"a\":1}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "结果" },
    ],
    tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
  };
  const p = parseChat(JSON.stringify(chatBody));
  assert.equal(p.ok, true);
  assert.equal(p.request.system, "系统一\n\n系统二", "两段 system 用空行隔开");
  assert.equal(p.request.messages.length, 3, "tool 消息也进 IR");

  const anth = buildAnthropic(p.request, { model: "claude-x" });
  assert.equal(anth.model, "claude-x");
  assert.equal(anth.system[0].text, "系统一\n\n系统二");
  assert.equal(anth.messages.length, 3);
  assert.equal(anth.messages[1].content[0].type, "tool_use");
  assert.equal(anth.messages[1].content[0].id, "call_1");
  assert.deepEqual(anth.messages[1].content[0].input, { a: 1 });
  // 工具结果落在 user 消息的 content 块里
  assert.equal(anth.messages[2].role, "user");
  assert.equal(anth.messages[2].content[0].type, "tool_result");
  assert.equal(anth.messages[2].content[0].tool_use_id, "call_1");
  assert.equal(anth.messages[2].content[0].content, "结果");
  assert.equal(anth.tools[0].name, "f");
});

/* ---------- ② 工具调用配对 ---------- */

test("② Anthropic 的 tool_use ↔ Chat 的 tool_calls 双向对齐", () => {
  const p = parseAnthropic(JSON.stringify(ANTHROPIC_BODY));
  const chat = buildChat(p.request, { model: "gpt-x" });
  const call = chat.messages.find((m) => m.tool_calls).tool_calls[0];
  assert.equal(call.id, "toolu_1");
  assert.equal(call.function.name, "get_weather");

  // 再走回来
  const back = parseChat(JSON.stringify({
    model: "gpt-x",
    messages: [
      { role: "user", content: "北京天气？" },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "晴 25 度" },
    ],
  }));
  const anth = buildAnthropic(back.request, { model: "claude-x" });
  const use = anth.messages.find((m) => m.content.some((b) => b.type === "tool_use"));
  assert.ok(use, "tool_use 要在");
  assert.equal(use.content[0].id, "toolu_1");
  assert.deepEqual(use.content[0].input, { city: "北京" });
});

test("② pairToolMessages：孤儿工具结果并进前一条 user 消息，不另起一条", () => {
  /* 孤儿结果回答的不是当前这轮在飞的调用。它不能插在两条 user 消息中间
     （有些模型的聊天模板拒绝连续两条 user），所以并进前一条 user 消息里。 */
  const out = pairToolMessages([
    { role: "user", content: "第一句" },
    { role: "tool", tool_call_id: "call_orphan", content: "没人问的结果" },
  ]);
  assert.equal(out.length, 1, "并进前一条，不新起一条");
  assert.equal(out[0].role, "user");
  assert.match(out[0].content, /第一句/);
  assert.match(out[0].content, /没人问的结果/);
});

test("② pairToolMessages：孤儿工具结果前面没有 user 消息时，自己成为一条 user 消息", () => {
  const out = pairToolMessages([
    { role: "tool", tool_call_id: "call_orphan", content: "没人问的结果" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
  assert.match(out[0].content, /没人问的结果/);
});

test("② pairToolMessages：没被回答的调用补一条占位结果", () => {
  const out = pairToolMessages([
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
  ]);
  const tool = out.find((m) => m.role === "tool");
  assert.ok(tool, "要补一条 tool 消息");
  assert.equal(tool.tool_call_id, "call_1");
  assert.match(tool.content, /unavailable/);
});

test("② pairToolMessages：答了两次的调用，以第一个为准", () => {
  const out = pairToolMessages([
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "第一个" },
    { role: "tool", tool_call_id: "call_1", content: "第二个" },
  ]);
  const tools = out.filter((m) => m.role === "tool");
  assert.equal(tools.length, 1, "答两次只留第一个");
  assert.equal(tools[0].content, "第一个");
});

test("② pairToolMessages：一条空 assistant 消息夹在调用与答案中间时被丢掉", () => {
  const out = pairToolMessages([
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "assistant", content: "   " },
    { role: "tool", tool_call_id: "call_1", content: "结果" },
  ]);
  const assistants = out.filter((m) => m.role === "assistant");
  assert.equal(assistants.length, 1, "空的 assistant 不该留着");
});

test("② pairToolBlocks：Anthropic 侧同样补齐没被回答的调用", () => {
  const out = pairToolBlocks([
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }] },
  ]);
  const user = out[out.length - 1];
  assert.equal(user.role, "user");
  assert.equal(user.content[0].type, "tool_result");
  assert.equal(user.content[0].tool_use_id, "toolu_1");
  assert.equal(user.content[0].is_error, true);
});

test("② 一轮的并行调用被拆进两条 assistant 消息时，Chat 侧先并成一轮", () => {
  /* Anthropic 原生就把连续的 assistant 消息当一轮，所以合并只发生在 Chat 侧
     （magpie 的 joinSplitCalls 也只挂在 buildChat 上）。 */
  const p = parseAnthropic(JSON.stringify({
    model: "m",
    messages: [
      { role: "user", content: "干活" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "a", input: {} }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "b", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "r1" },
        { type: "tool_result", tool_use_id: "toolu_2", content: "r2" },
      ] },
    ],
  }));
  const chat = buildChat(p.request, { model: "gpt-x" });
  const asst = chat.messages.filter((m) => m.role === "assistant");
  assert.equal(asst.length, 1, "两条 assistant 消息要并成一条");
  assert.equal(asst[0].tool_calls.length, 2, "两个调用都在同一条 assistant 消息里");
  const tools = chat.messages.filter((m) => m.role === "tool");
  assert.equal(tools.length, 2, "两个结果都在");
});

/* ---------- ③ 签名字节级往返（最容易被改坏的一条） ---------- */

test("★ ③ 带 signature 的 thinking 块，Anthropic→IR→Anthropic 后签名逐字节不变", () => {
  const sig = "EqQBCkYIBRgCKkBk3x1q2v9w==";
  const body = {
    model: "claude-sonnet-5",
    max_tokens: 100,
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "想一想", signature: sig },
        { type: "text", text: "答案" },
      ],
    }],
  };
  const p = parseAnthropic(JSON.stringify(body));
  assert.equal(p.ok, true);
  const think = p.request.messages[0].parts.find((x) => x.kind === KIND.THINKING);
  assert.ok(think, "thinking 块要在");
  assert.equal(think.signature, sig, "签名解析出来必须一模一样");

  const back = buildAnthropic(p.request, { model: "claude-sonnet-5" });
  const b2 = back.messages[0].content.find((x) => x.type === "thinking");
  assert.ok(b2, "thinking 块要回去");
  assert.equal(b2.signature, sig, "签名回去必须逐字节不变");
  assert.equal(b2.thinking, "想一想");
});

test("★ ③ redacted_thinking（密封推理）整块保留，别的协议上它什么都不是", () => {
  const body = {
    model: "claude-sonnet-5",
    max_tokens: 100,
    messages: [{
      role: "assistant",
      content: [{ type: "redacted_thinking", data: "ENCRYPTEDBLOB==" }],
    }],
  };
  const p = parseAnthropic(JSON.stringify(body));
  const think = p.request.messages[0].parts.find((x) => x.kind === KIND.THINKING);
  assert.ok(think, "密封块要在");
  assert.equal(think.sealedBy, "anthropic");
  assert.match(think.sealed, /ENCRYPTEDBLOB/, "密封内容要留着");

  const back = buildAnthropic(p.request, { model: "claude-sonnet-5" });
  const b2 = back.messages[0].content[0];
  assert.equal(b2.type, "redacted_thinking");
  assert.equal(b2.data, "ENCRYPTEDBLOB==", "密封内容逐字节回去");
});

/* ---------- ④ 流式：任意切分 ---------- */

const CHAT_SSE = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-x","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
  "",
  'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"想一下"},"finish_reason":null}]}',
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

function decodeAll(text) {
  const d = chatDecoder();
  const events = [];
  for (const ev of d.decode(text)) events.push(ev);
  for (const ev of d.flush()) events.push(ev);
  return events;
}

test("★ ④ 整块喂进去与切成任意片段喂进去，事件序列必须完全一致", () => {
  const whole = decodeAll(CHAT_SSE);
  assert.ok(whole.length >= 6, "整块至少要出这些事件，实际 " + whole.length);

  // 每一个可能的切点都试一遍：上游可能把任何一处切成两半
  for (let cut = 1; cut < CHAT_SSE.length; cut++) {
    const d = chatDecoder();
    const events = [];
    for (const ev of d.decode(CHAT_SSE.slice(0, cut))) events.push(ev);
    for (const ev of d.decode(CHAT_SSE.slice(cut))) events.push(ev);
    for (const ev of d.flush()) events.push(ev);
    assert.deepEqual(
      events.map((e) => [e.kind, e.text, e.id, e.name, e.stop]),
      whole.map((e) => [e.kind, e.text, e.id, e.name, e.stop]),
      "在第 " + cut + " 个字节切开，事件序列变了",
    );
  }
});

test("④ 流式解出来的事件：文本、思考、工具调用、结束、用量", () => {
  const events = decodeAll(CHAT_SSE);
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes(EV.START), "要有 start");
  assert.ok(kinds.includes(EV.TEXT), "要有 text");
  assert.ok(kinds.includes(EV.THINK), "要有 think");
  assert.ok(kinds.includes(EV.TOOL_START), "要有 tool_start");
  assert.ok(kinds.includes(EV.TOOL_ARGS), "要有 tool_args");
  assert.ok(kinds.includes(EV.STOP), "要有 stop");
  assert.ok(kinds.includes(EV.USAGE), "要有 usage");

  const toolStart = events.find((e) => e.kind === EV.TOOL_START);
  assert.equal(toolStart.id, "call_1");
  assert.equal(toolStart.name, "get_weather");
  // 参数分两片来，拼起来必须是一个完整 JSON
  const args = events.filter((e) => e.kind === EV.TOOL_ARGS).map((e) => e.text).join("");
  assert.deepEqual(JSON.parse(args), { city: "北京" });

  const stop = events.find((e) => e.kind === EV.STOP);
  assert.equal(stop.stop, "tool", "finish_reason=tool_calls 要归一成 tool");
  const usage = events.filter((e) => e.kind === EV.USAGE).pop();
  assert.equal(usage.usage.input, 10);
  assert.equal(usage.usage.output, 20);
});

test("★ ④b anthropicDecoder **真的解得动**（这条以前只 import 过，从没调用过）", () => {
  /* ⚠⚠ 本文件早前 import 了 anthropicDecoder 却**从没调用过** ——
   *   于是它里面「emit 只定义在 chatDecoder 闭包里」这个 bug 一直活着：
   *   第一次解事件就 ReferenceError（emit is not defined）。
   *   2026-10-22 由 Gemini 协议那轮的 agent 撞出来。
   *
   *   教训：**「import 了」不等于「跑过了」** —— 一个从没被调用的导出函数，
   *   它里面的一切都可能没被验证过。这条用例就是那道保险。 */
  const ANTHROPIC_SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m1","model":"hy3","usage":{"input_tokens":10}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    '',
  ].join("\n");
  const d = anthropicDecoder();
  let events = [];
  assert.doesNotThrow(() => { events = d.decode(ANTHROPIC_SSE); },
    "anthropicDecoder 一解事件就抛 —— 那说明它的闭包里有没定义的东西");
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes(EV.START), "要有 start");
  assert.ok(kinds.includes(EV.TEXT), "要有 text");
  assert.ok(kinds.includes(EV.STOP), "要有 stop");
  assert.ok(kinds.includes(EV.USAGE), "要有 usage");
  assert.equal(events.find((e) => e.kind === EV.TEXT).text, "你好");
  const usage = events.filter((e) => e.kind === EV.USAGE).pop();
  assert.equal(usage.usage.output, 5);
});

test("★ ⑦b 两种协议的用量口径必须一致（input 不含缓存）", () => {
  /* OpenAI 的 prompt_tokens 含缓存命中那部分，Anthropic 的 input_tokens 不含。
   * 口径不一样的话，同一段提示词换个协议上游，账本上的「输入 token」就差一截；
   * 面板把「输入」与「缓存读」摆成两格，含缓存的那份会让两者加起来**超过**真实提示词。 */
  const chat = chatUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } });
  const an = anthropicUsage({ input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40 });
  assert.equal(chat.input, 60, "chat 的 input 要扣掉缓存命中那部分");
  assert.equal(chat.cacheRead, 40);
  assert.equal(chat.input, an.input, "两种协议的 input 必须相等");
  assert.equal(chat.cacheRead, an.cacheRead, "两种协议的 cacheRead 必须相等");
  /* 没有缓存信息时不能凭空扣 */
  assert.equal(chatUsage({ prompt_tokens: 100 }).input, 100);
  /* 缓存比总数还大时不能出负数 */
  assert.equal(chatUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 99 } }).input, 0);
});

test("④ 工具调用开了却没带参数时，编码器补一个空对象", () => {
  const enc = anthropicEncoder({ model: "claude-x" });
  let out = enc.event({ kind: EV.START, msgId: "msg_1", model: "claude-x" });
  out += enc.event({ kind: EV.TOOL_START, id: "toolu_1", name: "f" });
  out += enc.flush();
  assert.match(out, /input_json_delta/, "要有参数增量");
  assert.match(out, /"partial_json":"\{\}"/, "空调用补 {}");
});

test("④ Anthropic 编码器：文本块、思考块、签名各自成块", () => {
  const enc = anthropicEncoder({ model: "claude-x" });
  let out = enc.event({ kind: EV.START, msgId: "msg_1", model: "claude-x" });
  out += enc.event({ kind: EV.THINK_START });
  out += enc.event({ kind: EV.THINK, text: "想一下" });
  out += enc.event({ kind: EV.SIG, text: "SIG-1" });
  out += enc.event({ kind: EV.TEXT, text: "答案" });
  out += enc.flush();

  assert.match(out, /event: message_start/);
  assert.match(out, /"type":"thinking_delta"/);
  assert.match(out, /"signature":"SIG-1"/, "签名要发出去");
  assert.match(out, /"type":"text_delta"/);
  assert.match(out, /event: message_stop/);
  // 思考块与文本块是两块
  const starts = out.match(/content_block_start/g) || [];
  assert.ok(starts.length >= 3, "message_start + thinking + text 三块，实际 " + starts.length);
});

/* ---------- ⑤ 非流式与事件管道共用 ---------- */

test("⑤ 非流式渲染与事件管道同源：事件流装配出的结果 == 整包渲染的结果", () => {
  const col = collector();
  col.add({ kind: EV.START, msgId: "chatcmpl-1", model: "gpt-x" });
  col.add({ kind: EV.TEXT, text: "你好" });
  col.add({ kind: EV.TOOL_START, id: "call_1", name: "f" });
  col.add({ kind: EV.TOOL_ARGS, text: '{"a":1}' });
  col.add({ kind: EV.STOP, stop: "tool" });
  const res = col.finish();

  const chat = renderChat(res, "gpt-x");
  assert.equal(chat.object, "chat.completion");
  assert.equal(chat.choices[0].message.content, "你好");
  assert.equal(chat.choices[0].finish_reason, "tool_calls");
  assert.equal(chat.choices[0].message.tool_calls[0].function.name, "f");
  assert.deepEqual(JSON.parse(chat.choices[0].message.tool_calls[0].function.arguments), { a: 1 });

  const anth = renderAnthropic(res, "claude-x");
  assert.equal(anth.type, "message");
  assert.equal(anth.content[0].type, "text");
  assert.equal(anth.content[1].type, "tool_use");
  assert.equal(anth.stop_reason, "tool_use");
});

/* ---------- ⑥ 错误路径 ---------- */

test("⑥ 非法 JSON 返回 { ok:false }，不抛异常", () => {
  const a = parseAnthropic("{ 不是 JSON");
  assert.equal(a.ok, false);
  assert.ok(a.error, "要带一句能给人看的错");
  const c = parseChat("[]");
  assert.equal(c.ok, false, "数组不是请求体");
});

test("⑥ 流里的错误块要变成 error 事件，而不是被跳过", () => {
  const d = chatDecoder();
  const events = d.decode('data: {"error":{"message":"上游炸了","code":"server_error"}}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, EV.ERROR);
  assert.equal(events[0].text, "上游炸了");
  assert.equal(events[0].code, "server_error");
});

/* ---------- ⑦ 一些边角 ---------- */

test("⑦ 推理档位归一：none/minimal 都算 low，ultra 算 max", () => {
  assert.equal(parseChat(JSON.stringify({ reasoning_effort: "none" })).request.thinkOff, true);
  assert.equal(parseChat(JSON.stringify({ reasoning_effort: "HIGH" })).request.effort, "high");
  assert.equal(parseChat(JSON.stringify({ reasoning_effort: "ultra" })).request.effort, "max");
});

test("⑦ Anthropic 的 budget_tokens 折成档位，output_config.effort 覆盖它", () => {
  const p = parseAnthropic(JSON.stringify({
    model: "m",
    thinking: { type: "enabled", budget_tokens: 24000 },
    output_config: { effort: "low" },
  }));
  assert.equal(p.request.thinking, true);
  assert.equal(p.request.effort, "low", "output_config 优先");
});

test("⑦ thinking 被关掉时，ThinkOff 为真、不当成开启", () => {
  const p = parseAnthropic(JSON.stringify({ model: "m", thinking: { type: "disabled" } }));
  assert.equal(p.request.thinkOff, true);
  assert.equal(p.request.thinking, false);
});

test("⑦ Chat 的 tool_choice 两种形状都认", () => {
  assert.equal(parseChat(JSON.stringify({ tool_choice: "none" })).request.toolChoice, "none");
  assert.equal(parseChat(JSON.stringify({ tool_choice: { type: "function", function: { name: "f" } } })).request.toolChoice, "name:f");
});

test("⑦ Anthropic 的 tool_choice：any 归成 required", () => {
  assert.equal(parseAnthropic(JSON.stringify({ tool_choice: { type: "any" } })).request.toolChoice, "required");
  assert.equal(parseAnthropic(JSON.stringify({ tool_choice: { type: "tool", name: "f" } })).request.toolChoice, "name:f");
});

test("⑦ 工具参数不是 JSON 时被包成 {input: …}，内容不丢", () => {
  const p = parseChat(JSON.stringify({
    messages: [{
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "不是 JSON" } }],
    }],
  }));
  const call = p.request.messages[0].parts.find((x) => x.kind === KIND.TOOL_CALL);
  assert.deepEqual(call.args, { input: "不是 JSON" });
});

test("⑦ data: URL 的图片拆成内联图片，普通 URL 原样留着", () => {
  const p = parseChat(JSON.stringify({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "image_url", image_url: { url: "https://x/y.png" } },
      ],
    }],
  }));
  const imgs = p.request.messages[0].parts.filter((x) => x.kind === KIND.IMAGE);
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].mediaType, "image/png");
  assert.equal(imgs[0].data, "AAA");
  assert.equal(imgs[1].url, "https://x/y.png");
});
