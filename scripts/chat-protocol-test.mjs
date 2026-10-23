/**
 * Chat 入向协议桥（src/server/chat-protocol.mjs）
 *
 * ## 测什么
 *
 *   ★ ① 协议匹配：/v1/chat/completions 认得；GET 不认；Anthropic 路径不受影响
 *   ★ ② Chat 请求体 → IR → Anthropic 形状（交给中转的就是这个）
 *   ★ ③ 工具调用往返：Chat → Anthropic → Chat，id 与参数都在
 *   ★ ④ **做不到而会改变语义的字段 ⇒ 报错**（n>1 / logprobs / audio / prediction）
 *   ★ ⑤ **不影响正确性的采样参数 ⇒ 忽略**（temperature/top_p/stop/seed…）
 *   ★ ⑥ usage 口径：Chat 的 prompt_tokens **含**缓存命中（与 chatUsage 互逆）
 *   ★ ⑦ 流式：上游 Anthropic SSE → Chat SSE（role/内容/tool_calls/[DONE]）
 *   ★ ⑧ 模型清单：一份响应两种客户端都能读（OpenAI 的 object / Anthropic 的 type）
 *   ★ ⑨ 活体：真 makeProtocolHandler + 假中转 ⇒ 客户端发 Chat、收到 Chat
 *   ★ ⑩ **反向对照**：改坏还原/口径 ⇒ 对应判据必须红
 *
 * ## 为什么 ⑩ 是「改副本再跑」而不是「改仓库源码」
 *
 * 与 scripts/gateway-test.mjs 同一手法：把 src/server **复制**到临时目录，在
 * **副本**上把某处改坏，再 import 副本 —— 仓库源码一个字都不动，所以不存在
 * 「测完忘了还原」这种事故。锚点对不上就当场抛错（手法与源码脱节时这条对照
 * 就是假的，必须让它响）。
 *
 * ## 红线
 *
 * 🔴 全文没有一个真实令牌/API key（夹具里的凭据形态串是明显假的占位串）。
 * 🔴 落盘只在 os.tmpdir() 下的临时目录；端口动态挑空闲；进程只按 PID 收。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { pickProtocol, PROTOCOLS } from "../src/server/protocols.mjs";
import { makeProtocolHandler, GATEWAY_BODY } from "../src/server/gateway.mjs";
import { chatProtocol, chatModelsPayload, chatStreamDecoder, buildChatResponse } from "../src/server/chat-protocol.mjs";
import { parseChat, buildAnthropic, emptyUsage, makePart, KIND } from "../src/server/ir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER_DIR = path.join(REPO, "src", "server");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-chatproto-"));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/** 把 src/server 整个复制到临时目录，供「改坏副本」用。 */
function copyServerDir(tag) {
  const dst = path.join(TMPROOT, tag, "server");
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(SERVER_DIR)) {
    if (!f.endsWith(".mjs") && !f.endsWith(".js")) continue;
    fs.copyFileSync(path.join(SERVER_DIR, f), path.join(dst, f));
  }
  return dst;
}

/* ====================================================================== *
 * ① 协议匹配
 * ====================================================================== */
describe("① 协议匹配：Chat 路径认得，别的一概不猜", () => {
  test("①a POST /v1/chat/completions → 认得，且是 chat 那一条", () => {
    const p = pickProtocol("/v1/chat/completions", "POST");
    assert.ok(p, "Chat 的入向路径必须认得");
    assert.equal(p.id, "chat");
  });

  test("①b GET /v1/chat/completions → 不认（只有 POST 是模型调用）", () => {
    assert.equal(pickProtocol("/v1/chat/completions", "GET"), null);
  });

  test("①c Anthropic 那条路不受影响（/v1/messages 不归协议桥管）", () => {
    assert.equal(pickProtocol("/v1/messages", "POST"), null);
  });

  test("①d 另外两条协议还在（注册 chat 不能把别的挤掉）", () => {
    assert.equal(pickProtocol("/v1/responses", "POST")?.id, "responses");
    assert.equal(pickProtocol("/v1beta/models/sn/claude-opus-5:generateContent", "POST")?.id, "gemini");
  });

  test("①e 不带 /v1 的 /chat/completions 也认（OpenAI 兼容客户端的老拼法）", () => {
    /* magpie 也是两个都答（internal/gateway/gateway.go:698-699）：
     *   客户端的 base_url 常常是「不带 /v1 的根地址」，它自己拼 /chat/completions。
     *   只认一个 ⇒ 一半客户端连不上。 */
    assert.equal(chatProtocol.match("/chat/completions", "POST"), true);
    assert.equal(pickProtocol("/chat/completions", "POST")?.id, "chat");
    assert.equal(pickProtocol("/v1/chat/completions", "POST")?.id, "chat");
  });

  test("①f PROTOCOLS 里三条都在，且 id 不重复", () => {
    const ids = PROTOCOLS.map((p) => p.id);
    assert.deepEqual(ids.slice().sort(), ["chat", "gemini", "responses"]);
    assert.equal(new Set(ids).size, ids.length, "协议 id 不能重复（否则日志与错误信息会分不清是谁）");
  });
});

/* ====================================================================== *
 * ② 请求体 → IR → Anthropic 形状
 * ====================================================================== */
describe("② Chat 请求体 → IR → Anthropic 形状", () => {
  test("②a 文本消息与 system 都翻到位", () => {
    const p = parseChat(JSON.stringify({
      model: "sn/claude-opus-5",
      messages: [
        { role: "system", content: "你是助手" },
        { role: "user", content: "北京天气？" },
      ],
      max_tokens: 100,
    }));
    assert.equal(p.ok, true, `解析失败：${p.error}`);
    const a = buildAnthropic(p.request);
    assert.equal(a.model, "sn/claude-opus-5");
    assert.deepEqual(a.system, [{ type: "text", text: "你是助手" }]);
    assert.equal(a.messages.length, 1);
    assert.equal(a.messages[0].role, "user");
    assert.equal(a.messages[0].content[0].text, "北京天气？");
    assert.equal(a.max_tokens, 100);
  });

  test("②b 多模态：image_url 翻成 Anthropic 的 image 块", () => {
    const p = parseChat(JSON.stringify({
      model: "sn/x",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "这是什么" },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      }],
    }));
    assert.equal(p.ok, true);
    const a = buildAnthropic(p.request);
    const kinds = a.messages[0].content.map((b) => b.type);
    assert.deepEqual(kinds, ["text", "image"], "图片块不能丢（丢了模型就少看一样东西）");
    assert.equal(a.messages[0].content[1].source.type, "url");
  });

  test("②c 工具定义翻成 Anthropic 的 input_schema", () => {
    const p = parseChat(JSON.stringify({
      model: "sn/x",
      messages: [{ role: "user", content: "查天气" }],
      tools: [{
        type: "function",
        function: { name: "get_weather", description: "查天气", parameters: { type: "object", properties: { city: { type: "string" } } } },
      }],
    }));
    assert.equal(p.ok, true);
    const a = buildAnthropic(p.request);
    assert.equal(a.tools.length, 1);
    assert.equal(a.tools[0].name, "get_weather");
    assert.deepEqual(a.tools[0].input_schema, { type: "object", properties: { city: { type: "string" } } });
  });
});

/* ====================================================================== *
 * ③ 工具调用往返
 * ====================================================================== */
describe("③ 工具调用：Chat → Anthropic → Chat", () => {
  const CHAT_WITH_CALL = {
    model: "sn/x",
    messages: [
      { role: "user", content: "查天气" },
      {
        role: "assistant",
        tool_calls: [{ id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{"city":"BJ"}' } }],
      },
      { role: "tool", tool_call_id: "call_abc", content: "晴 25℃" },
    ],
  };

  test("③a assistant 的 tool_calls 翻成 Anthropic 的 tool_use", () => {
    const p = parseChat(JSON.stringify(CHAT_WITH_CALL));
    assert.equal(p.ok, true);
    const a = buildAnthropic(p.request);
    const use = a.messages[1].content.find((b) => b.type === "tool_use");
    assert.ok(use, "assistant 的工具调用不能丢");
    assert.equal(use.name, "get_weather");
    assert.deepEqual(use.input, { city: "BJ" }, "参数要从 arguments 字符串解析成对象");
  });

  test("③b tool 消息翻成 Anthropic 的 tool_result，且 id 对得上", () => {
    const p = parseChat(JSON.stringify(CHAT_WITH_CALL));
    const a = buildAnthropic(p.request);
    const res = a.messages[2].content.find((b) => b.type === "tool_result");
    assert.ok(res, "工具结果不能丢");
    assert.equal(res.tool_use_id, "call_abc", "结果必须挂在**同一个**调用 id 上");
    assert.equal(res.content, "晴 25℃");
  });

  test("③c 回程：Anthropic 的 tool_use → Chat 的 tool_calls，id 与参数都在", () => {
    const res = {
      id: "msg_1", model: "sn/x", stop: "tool",
      usage: emptyUsage(),
      parts: [makePart({ kind: KIND.TOOL_CALL, id: "call_abc", name: "get_weather", args: { city: "BJ" } })],
    };
    const body = buildChatResponse(res, { model: "sn/x" });
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    const call = body.choices[0].message.tool_calls[0];
    assert.equal(call.id, "call_abc", "id 必须是客户端自己编的那个（下一轮它要拿这个来配对）");
    assert.equal(call.function.name, "get_weather");
    assert.deepEqual(JSON.parse(call.function.arguments), { city: "BJ" });
  });
});

/* ====================================================================== *
 * ④ 做不到而会改变语义的字段 ⇒ 报错
 * ====================================================================== */
describe("④ 做不到的字段 ⇒ 如实报错（不静默丢）", () => {
  const bad = [
    ["n=2（多候选）", { n: 2 }],
    ["logprobs（逐 token 概率）", { logprobs: true }],
    ["top_logprobs", { top_logprobs: 3 }],
    ["audio（音频输出）", { audio: { voice: "alloy" } }],
    ["modalities 里的 audio", { modalities: ["text", "audio"] }],
    ["prediction（预测输出）", { prediction: { type: "content", content: "x" } }],
  ];
  for (const [label, extra] of bad) {
    test(`④ ${label} → 报错，且说清是哪个字段`, () => {
      const body = { model: "sn/x", messages: [{ role: "user", content: "hi" }], ...extra };
      const p = chatProtocol.parse(body);
      assert.equal(p.ok, false, `${label} 不该被接受`);
      assert.match(String(p.error || ""), /unsupported/, `${label} 的错误要说清「不支持」`);
    });
  }

  test("④b 合法的 n=1 不报错（别把正常请求也拦下）", () => {
    const p = chatProtocol.parse({ model: "sn/x", messages: [{ role: "user", content: "hi" }], n: 1 });
    assert.equal(p.ok, true, `不该报错：${p.error}`);
  });
});

/* ====================================================================== *
 * ⑤ 不影响正确性的采样参数 ⇒ 忽略
 * ====================================================================== */
describe("⑤ 采样类参数 ⇒ 忽略（不报错，否则客户端连都连不上）", () => {
  test("⑤a 一堆常见可选参数一起发，也不报错", () => {
    const p = chatProtocol.parse({
      model: "sn/x",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9,
      stop: ["\n\n"],
      seed: 42,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      logit_bias: { "1": 2 },
      user: "someone",
      stream_options: { include_usage: true },
      parallel_tool_calls: true,
    });
    assert.equal(p.ok, true, `不该报错：${p.error}`);
  });

  test("⑤b temperature 真的落进了 IR（不是「忽略」成丢掉）", () => {
    const p = parseChat(JSON.stringify({
      model: "sn/x", messages: [{ role: "user", content: "hi" }], temperature: 0.3,
    }));
    assert.equal(p.request.temp, 0.3);
  });
});

/* ====================================================================== *
 * ⑥ usage 口径
 * ====================================================================== */
describe("⑥ usage 口径：Chat 的 prompt_tokens 含缓存命中", () => {
  test("⑥a prompt_tokens = input + cacheRead（与 chatUsage 互逆）", () => {
    const res = {
      id: "msg_1", model: "sn/x", stop: "stop",
      usage: { ...emptyUsage(), input: 60, output: 20, cacheRead: 40, reasoning: 5 },
      parts: [makePart({ kind: KIND.TEXT, text: "你好" })],
    };
    const body = buildChatResponse(res, { model: "sn/x" });
    assert.equal(body.usage.prompt_tokens, 100, "60 提示 + 40 缓存命中 = 100（Chat 的口径是含缓存）");
    assert.equal(body.usage.completion_tokens, 20);
    assert.equal(body.usage.total_tokens, 120);
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 40);
    assert.equal(body.usage.completion_tokens_details.reasoning_tokens, 5);
  });

  test("⑥b 「输入 + 缓存读」必须正好等于 prompt_tokens（面板那个「加起来超过」的坑）", () => {
    const res = {
      id: "msg_1", model: "sn/x", stop: "stop",
      usage: { ...emptyUsage(), input: 60, output: 20, cacheRead: 40 },
      parts: [makePart({ kind: KIND.TEXT, text: "你好" })],
    };
    const u = buildChatResponse(res, { model: "sn/x" }).usage;
    assert.equal(u.prompt_tokens, u.prompt_tokens_details.cached_tokens + 60,
      "两格加起来必须等于真实的提示词长度");
  });
});

/* ====================================================================== *
 * ⑦ 流式
 * ====================================================================== */
describe("⑦ 流式：上游 Anthropic SSE → Chat SSE", () => {
  const UPSTREAM_SSE = [
    "event: message_start\ndata: " + JSON.stringify({
      type: "message_start",
      message: { id: "msg_1", model: "sn/x", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } },
    }) + "\n\n",
    "event: content_block_start\ndata: " + JSON.stringify({
      type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
    }) + "\n\n",
    "event: content_block_delta\ndata: " + JSON.stringify({
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "北京晴" },
    }) + "\n\n",
    "event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: 0 }) + "\n\n",
    "event: message_delta\ndata: " + JSON.stringify({
      type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 4 },
    }) + "\n\n",
    "event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n",
  ].join("");

  test("⑦a 每一片都是 Chat 的 chunk，且最后是 [DONE]", () => {
    const dec = chatStreamDecoder({ model: "sn/x" });
    let out = dec.decode(UPSTREAM_SSE);
    out += dec.flush();
    assert.match(out, /"object":"chat\.completion\.chunk"/, "必须是 Chat 的 chunk 形状");
    assert.match(out, /"role":"assistant"/, "第一片必须带 role（Chat 客户端靠它起头）");
    assert.match(out, /北京晴/, "正文必须原样带过去");
    assert.match(out, /"finish_reason":"stop"/, "收尾必须带 finish_reason");
    assert.match(out, /data: \[DONE\]/, "末尾必须是 [DONE]（Chat 客户端靠它知道流完了）");
  });

  test("⑦b usage 也带过去（且口径含缓存）", () => {
    const dec = chatStreamDecoder({ model: "sn/x" });
    let out = dec.decode(UPSTREAM_SSE);
    out += dec.flush();
    assert.match(out, /"usage":\{/, "收尾那一片必须带 usage");
    assert.match(out, /"prompt_tokens":10/, "usage 的口径要与 Anthropic 侧一致（input 10，缓存 0）");
  });

  test("⑦c 工具调用：上游的 tool_use → Chat 的 tool_calls", () => {
    const sse = [
      "event: message_start\ndata: " + JSON.stringify({
        type: "message_start", message: { id: "m", model: "sn/x", role: "assistant", content: [], usage: {} },
      }) + "\n\n",
      "event: content_block_start\ndata: " + JSON.stringify({
        type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_xyz", name: "f", input: {} },
      }) + "\n\n",
      "event: content_block_delta\ndata: " + JSON.stringify({
        type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":1}' },
      }) + "\n\n",
      "event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: 0 }) + "\n\n",
      "event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n",
    ].join("");
    const dec = chatStreamDecoder({ model: "sn/x" });
    let out = dec.decode(sse);
    out += dec.flush();
    assert.match(out, /"tool_calls"/, "工具调用必须翻成 tool_calls");
    assert.match(out, /call_xyz/, "调用 id 必须带过去");
    assert.match(out, /"name":"f"/, "工具名必须带过去");
  });

  test("⑦d 上游切成两半发来也不会丢（解码器按行攒事件）", () => {
    const dec = chatStreamDecoder({ model: "sn/x" });
    const half = Math.floor(UPSTREAM_SSE.length / 2);
    let out = dec.decode(UPSTREAM_SSE.slice(0, half));
    out += dec.decode(UPSTREAM_SSE.slice(half));
    out += dec.flush();
    assert.match(out, /北京晴/, "切开的 SSE 不能丢内容");
  });
});

/* ====================================================================== *
 * ⑧ 模型清单
 * ====================================================================== */
describe("⑧ 模型清单：一份响应两种客户端都能读", () => {
  const entries = [
    { id: "sn/claude-opus-5", ownedBy: "sn", displayName: "Claude Opus 5" },
    { id: "sn/claude-sonnet-5", ownedBy: "sn", displayName: "Claude Sonnet 5" },
  ];

  test("⑧a OpenAI 侧读得到 object/created/owned_by", () => {
    const p = chatModelsPayload(entries);
    assert.equal(p.object, "list");
    assert.equal(p.data.length, 2);
    assert.equal(p.data[0].id, "sn/claude-opus-5");
    assert.equal(p.data[0].object, "model");
    assert.equal(p.data[0].owned_by, "sn");
    assert.equal(typeof p.data[0].created, "number");
  });

  test("⑧b Anthropic 侧读得到 type/created_at/display_name", () => {
    const p = chatModelsPayload(entries);
    assert.equal(p.data[0].type, "model");
    assert.equal(typeof p.data[0].created_at, "string");
    assert.equal(p.data[0].display_name, "Claude Opus 5");
    assert.equal(p.has_more, false);
  });

  test("⑧c 模型 id 就是网关入向要用的那个写法（provider/档位）", () => {
    const p = chatModelsPayload(entries);
    for (const m of p.data) assert.match(m.id, /^[a-z0-9]+\//, "清单里的 id 必须能直接当模型 id 用");
  });

  test("⑧d 空清单也不炸", () => {
    const p = chatModelsPayload([]);
    assert.deepEqual(p.data, []);
    assert.equal(p.object, "list");
  });
});

/* ====================================================================== *
 * ⑨ 活体：真协议入口 + 假中转
 * ====================================================================== */
async function withProtocolServer(handler, fn) {
  const srv = http.createServer(makeProtocolHandler({ handlers: { sn: handler } }));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try { return await fn(port); } finally { await new Promise((r) => srv.close(r)); }
}
const postJson = (port, p, obj) => fetch(`http://127.0.0.1:${port}${p}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(obj), signal: AbortSignal.timeout(15000),
}).then(async (r) => {
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { }
  return { status: r.status, text, json };
});

describe("⑨ 活体：客户端发 Chat、收到 Chat", () => {
  test("⑨a 非流式：中转收到的是 Anthropic 形状，客户端收到的是 Chat 形状", async () => {
    let seen = null;
    await withProtocolServer((req, res) => {
      const body = JSON.parse(req[GATEWAY_BODY].toString("utf8"));
      seen = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_1", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: "北京晴 25℃" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 6 },
      }));
    }, async (port) => {
      const r = await postJson(port, "/v1/chat/completions", {
        model: "sn/claude-opus-5",
        messages: [{ role: "user", content: "北京天气？" }],
        max_tokens: 100,
      });
      assert.equal(r.status, 200, `实际 ${r.status}：${r.text.slice(0, 300)}`);
      assert.equal(r.json.object, "chat.completion");
      assert.equal(r.json.choices[0].message.content, "北京晴 25℃");
      assert.equal(r.json.choices[0].finish_reason, "stop");
      assert.equal(r.json.usage.prompt_tokens, 12);
    });
    assert.ok(seen, "中转必须被调用");
    assert.equal(seen.model, "claude-opus-5", "中转收到的是剥掉前缀的模型名");
    assert.equal(seen.messages[0].role, "user", "中转收到的是 Anthropic 形状");
    assert.equal(seen.messages[0].content[0].text, "北京天气？");
  });

  test("⑨b 流式：客户端拿到的是 Chat 的 SSE", async () => {
    await withProtocolServer((req, res) => {
      req[GATEWAY_BODY].toString("utf8");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: " + JSON.stringify({
        type: "message_start", message: { id: "msg_1", model: "sn/x", role: "assistant", content: [], usage: {} },
      }) + "\n\n");
      res.write("event: content_block_start\ndata: " + JSON.stringify({
        type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
      }) + "\n\n");
      res.write("event: content_block_delta\ndata: " + JSON.stringify({
        type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "晴" },
      }) + "\n\n");
      res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: 0 }) + "\n\n");
      res.write("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n");
      res.end();
    }, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "sn/x", messages: [{ role: "user", content: "hi" }], stream: true }),
      });
      const text = await r.text();
      assert.match(text, /"object":"chat\.completion\.chunk"/);
      assert.match(text, /晴/);
      assert.match(text, /data: \[DONE\]/);
    });
  });

  test("⑨c 模型名没 provider 前缀 → 400（说清缺前缀）", async () => {
    await withProtocolServer(() => { throw new Error("不该被调用"); }, async (port) => {
      const r = await postJson(port, "/v1/chat/completions", {
        model: "claude-opus-5", messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(r.status, 400, `实际 ${r.status}：${r.text.slice(0, 200)}`);
      assert.match(r.text, /provider/);
    });
  });

  test("⑯ 做不到的字段 → 400，且错误说清是哪个字段", async () => {
    await withProtocolServer(() => { throw new Error("不该被调用"); }, async (port) => {
      const r = await postJson(port, "/v1/chat/completions", {
        model: "sn/x", messages: [{ role: "user", content: "hi" }], n: 3,
      });
      assert.equal(r.status, 400, `实际 ${r.status}：${r.text.slice(0, 200)}`);
      assert.match(r.text, /unsupported/);
    });
  });
});

/* ====================================================================== *
 * ⑩ 反向对照
 * ====================================================================== */
describe("⑩ 反向对照：改坏 ⇒ 对应判据必须红", () => {
  test("⑩a 把「还原工具调用 id」改坏 ⇒ ③c 的 id 断言必须失效", async () => {
    const dir = copyServerDir("break-restore");
    const file = path.join(dir, "chat-protocol.mjs");
    const src = fs.readFileSync(file, "utf8");
    const broken = src.replace(
      "  if (ev && ev.kind === EV.TOOL_START && ev.id) ev.id = anthropicInID(ev.id);",
      "  if (ev && ev.kind === EV.TOOL_START && ev.id) { /* SABOTAGE：不还原 */ }",
    );
    assert.notEqual(broken, src, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(file, broken, "utf8");
    /* ⚠ Windows 上动态 import 绝对路径要 **file:// URL**（直接给 "C:\\…" 会被
     *   ESM loader 拒掉：ERR_UNSUPPORTED_ESM_URL_SCHEME）。 */
    const mod = await import(pathToFileURL(path.join(dir, "chat-protocol.mjs")).href + `?v=${Date.now()}`);
    const res = {
      id: "msg_1", model: "sn/x", stop: "tool", usage: emptyUsage(),
      parts: [makePart({ kind: KIND.TOOL_CALL, id: "mp_ZmFsbGUtc2FmZQ", name: "f", args: {} })],
    };
    const body = mod.buildChatResponse(res, { model: "sn/x" });
    const got = body.choices[0].message.tool_calls[0].id;
    assert.notEqual(got, "call_abc",
      "★ 改坏之后 id 仍被还原 —— 那 ③c 的判据是恒真的，测了个寂寞");
  });

  test("⑩b 把 usage 口径改坏（少加缓存）⇒ ⑥a 必须失效", async () => {
    const dir = copyServerDir("break-usage");
    const file = path.join(dir, "ir.mjs");
    const src = fs.readFileSync(file, "utf8");
    const broken = src.replace(
      "    prompt_tokens: input + cached,",
      "    prompt_tokens: input,   // SABOTAGE：少加缓存",
    );
    assert.notEqual(broken, src, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    fs.writeFileSync(file, broken, "utf8");
    const mod = await import(pathToFileURL(path.join(dir, "ir.mjs")).href + `?v=${Date.now()}`);
    const usage = mod.usageToChat({ ...mod.emptyUsage(), input: 60, output: 20, cacheRead: 40 });
    assert.equal(usage.prompt_tokens, 60,
      "★ 改坏之后口径仍是 100 —— 那 ⑥a 的判据是恒真的，测了个寂寞");
  });
});
