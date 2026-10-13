/**
 * OpenCode 原生工具交接回归：只用假 fetch，不起进程、不读用户文件、不请求网络。
 * 挂起的 message POST 必须被权限轮询解开；只能拒绝原生执行，不能授权 once/always。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { externalCallFor, postMessageWithToolGuard } from "../src/server/oc-tool-guard.mjs";

const SESSION = "session-current";
const OTHER = "session-other";
const BASE = "http://fake-opencode.invalid";
const schemaTool = (name, properties, required) => ({ name,
  input_schema: { type: "object", properties, required, additionalProperties: false } });
const string = { type: "string" };
const TOOLS = [
  schemaTool("Read", { file_path: string, offset: { type: "number" }, limit: { type: "number" } }, ["file_path"]),
  schemaTool("Bash", { command: string, description: string }, ["command"]),
  schemaTool("Edit", { file_path: string, old_string: string, new_string: string, replace_all: { type: "boolean" } },
    ["file_path", "old_string", "new_string"]),
  schemaTool("Write", { file_path: string, content: string }, ["file_path", "content"]),
];
const partFor = (tool = "read", input = { filePath: "/fake/project/data.txt" }, callID = "call-current") => ({
  type: "tool", id: "part-current", sessionID: SESSION, messageID: "message-current",
  tool, callID, state: { status: "running", input },
});
const permissionFor = (sessionID = SESSION, callID = "call-current", id = "permission-current") => ({
  id, sessionID, permission: "read", patterns: ["*"], metadata: {}, tool: { callID, messageID: "message-current" },
});
const PAYLOAD = { model: { providerID: "opencode", modelID: "fake-model" },
  system: "Only StructuredOutput may execute natively.",
  parts: [{ type: "text", text: "请读取文件。" }],
  format: { type: "json_schema", schema: { type: "object" } } };
const NORMAL_JSON = { info: { role: "assistant", finish: "stop" },
  structured: { content: "这是模型继续返回的正文。", calls: [] } };
const respond = (json, status = 200) => new Response(JSON.stringify(json), {
  status, headers: { "content-type": "application/json" },
});

/** 假服务保留全部调用轨迹；非本轮路由属于测试失败，绝不偷偷兜底。 */
function fakeService({ permission = permissionFor(), nativePart = partFor(), extraPermissions = [],
  extraParts = [], finishOnReject = false, immediate = null, postError = null,
  permissionError = null, lookupError = null, replyError = null } = {}) {
  const trace = [];
  let pending = !!permission;
  let postStarted = false;
  let nativeExecutions = 0;
  let releasePost = null;
  let postSignal = null;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    assert.equal(u.origin, BASE, "不得访问真实网络或改变目标服务");
    const route = u.pathname;
    const method = String(opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    trace.push({ method, route, search: u.search, body });
    if (route === `/session/${SESSION}/message` && method === "POST") {
      postStarted = true;
      postSignal = opts.signal;
      if (postError) throw postError;
      if (immediate) return new Response(immediate.rawText, { status: immediate.status,
        headers: { "content-type": "application/json" } });
      return new Promise((resolve, reject) => {
        releasePost = () => resolve(respond(NORMAL_JSON));
        const cancel = () => reject(new DOMException("假 POST 已取消", "AbortError"));
        if (opts.signal?.aborted) cancel();
        else opts.signal?.addEventListener("abort", cancel, { once: true });
      });
    }
    if (route === "/permission" && method === "GET") {
      if (permissionError) throw permissionError;
      return respond([...extraPermissions, ...(pending && postStarted && permission ? [permission] : [])]);
    }
    if (route === `/session/${SESSION}/message` && method === "GET") {
      assert.equal(u.searchParams.get("limit"), "3", "按约定查询最近三个消息");
      if (lookupError) throw lookupError;
      return respond([{ info: { id: "message-current", role: "assistant", sessionID: SESSION },
        parts: [...extraParts, ...(nativePart ? [nativePart] : [])] }]);
    }
    if (route.startsWith("/permission/") && route.endsWith("/reply") && method === "POST") {
      assert.equal(route, `/permission/${permission?.id}/reply`, "只允许处理本轮权限请求");
      if (body?.reply !== "reject") nativeExecutions++;
      pending = false;
      if (replyError) throw replyError;
      if (finishOnReject) releasePost?.();
      return respond(true);
    }
    if (route === `/session/${SESSION}/abort` && method === "POST") {
      releasePost?.();
      return respond(true);
    }
    assert.fail(`不允许的假服务请求：${method} ${route}`);
  };
  return { fetchImpl, trace, get nativeExecutions() { return nativeExecutions; },
    get postSignal() { return postSignal; }, release: () => releasePost?.() };
}

function runGuard(service, overrides = {}) {
  return postMessageWithToolGuard({ base: BASE, sessionId: SESSION, payload: PAYLOAD,
    tools: TOOLS, toolChoice: { type: "auto" }, fetchImpl: service.fetchImpl,
    timeoutMs: 700, pollMs: 5, log() {}, ...overrides });
}
const aborts = (service) => service.trace.filter((r) => r.route.endsWith("/abort"));
const replies = (service) => service.trace.filter((r) => r.route.endsWith("/reply"));
function assertNoNativeExecution(service) {
  assert.equal(service.nativeExecutions, 0, "原生工具不得获得执行许可");
  assert.ok(replies(service).every((r) => r.body.reply === "reject"), "不得授权 once / always");
  assert.ok(aborts(service).every((r) => r.route === `/session/${SESSION}/abort`), "不得中止其他会话");
}
async function requireFailure(service, overrides) {
  let result;
  let error;
  try { result = await runGuard(service, overrides); } catch (e) { error = e; }
  assert.ok(error || Number(result?.status) >= 400,
    `失败不能伪装成功，实际 ${JSON.stringify(result)}`);
  assert.ok(aborts(service).length >= 1, "失败必须中止当前会话，释放挂起推理");
  assertNoNativeExecution(service);
  return { result, error };
}

describe("externalCallFor：按当前外部工具和参数模式交接", () => {
  const cases = [
    ["read", { filePath: "/fake/a", offset: 0, limit: 30 }, "Read", { file_path: "/fake/a", offset: 0, limit: 30 }],
    ["bash", { command: "echo fake", description: "假命令" }, "Bash", { command: "echo fake", description: "假命令" }],
    ["edit", { filePath: "/fake/a", oldString: "before", newString: "after", replaceAll: false }, "Edit",
      { file_path: "/fake/a", old_string: "before", new_string: "after", replace_all: false }],
    ["write", { filePath: "/fake/a", content: "fake content" }, "Write", { file_path: "/fake/a", content: "fake content" }],
  ];
  for (const [native, input, name, args] of cases) {
    test(`${native} 映射成 ${name}，保留零值和 false`, () => {
      assert.deepEqual(externalCallFor(partFor(native, input), permissionFor(), TOOLS, { type: "auto" }),
        { name, arguments: args });
    });
  }
  test("缺必填字段不得凭权限类别或文件模式猜参数", () => {
    for (const [native, input] of [["read", {}], ["bash", {}],
      ["edit", { filePath: "/fake/a", newString: "after" }], ["write", { filePath: "/fake/a" }]]) {
      assert.equal(externalCallFor(partFor(native, input), permissionFor(), TOOLS, { type: "auto" }), null);
    }
  });
  test("编辑/删除内容和空文件允许空串，缺参数与空内容有区别", () => {
    assert.deepEqual(externalCallFor(partFor("edit", { filePath: "/fake/a", oldString: "", newString: "", replaceAll: false }),
      permissionFor(), TOOLS, { type: "auto" }),
    { name: "Edit", arguments: { file_path: "/fake/a", old_string: "", new_string: "", replace_all: false } });
    assert.deepEqual(externalCallFor(partFor("write", { filePath: "/fake/a", content: "" }), permissionFor(), TOOLS, {}),
      { name: "Write", arguments: { file_path: "/fake/a", content: "" } });
  });
  test("不存在的外部工具、未知原生工具和 tool_choice:none 均不能交接", () => {
    assert.equal(externalCallFor(partFor(), permissionFor(), [], {}), null);
    assert.equal(externalCallFor(partFor("webfetch", { url: "https://fake.invalid" }), permissionFor(), TOOLS, {}), null);
    assert.equal(externalCallFor(partFor(), permissionFor(), TOOLS, { type: "none" }), null);
    assert.equal(externalCallFor(partFor(), permissionFor(), TOOLS, { type: "tool", name: "Bash" }), null);
    assert.deepEqual(externalCallFor(partFor(), permissionFor(), TOOLS, { type: "tool", name: "Read" }),
      { name: "Read", arguments: { file_path: "/fake/project/data.txt" } });
  });
  test("不向外部工具传递 schema 未声明的原生内部参数", () => {
    const p = partFor("read", { filePath: "/fake/a", internalFlag: "not-a-tool-argument" });
    assert.deepEqual(externalCallFor(p, permissionFor(), TOOLS, {}), { name: "Read", arguments: { file_path: "/fake/a" } });
  });
  test("必填参数类型不符或外部同名工具有歧义时不交接", () => {
    for (const filePath of [null, 123, [], {}]) {
      assert.equal(externalCallFor(partFor("read", { filePath }), permissionFor(), TOOLS, {}), null);
    }
    assert.equal(externalCallFor(partFor(), permissionFor(), [TOOLS[0], TOOLS[0]], {}), null);
    assert.equal(externalCallFor({ ...partFor(), callID: "another-call" }, permissionFor(), TOOLS, {}), null);
  });
});

describe("postMessageWithToolGuard：挂起 POST、拒绝原生执行、交接给外部客户端", () => {
  test("轮询中从正确 callID 读取参数，拒绝并 abort 后直接交接", { timeout: 3000 }, async () => {
    const service = fakeService({ extraPermissions: [permissionFor(OTHER, "call-other", "permission-other")],
      extraParts: [partFor("bash", { command: "wrong call must not escape" }, "call-unrelated")] });
    const result = await runGuard(service);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.structured, { content: "", calls: [
      { name: "Read", arguments: { file_path: "/fake/project/data.txt" } },
    ] });
    assert.equal(result.json.info.finish, "tool-calls");
    assert.deepEqual(JSON.parse(result.rawText), result.json, "原文也必须是交接信封，不能留下已中止 POST 的旧正文");
    assert.equal(replies(service).length, 1, "同一权限只拒绝一次");
    assert.equal(replies(service)[0].route, "/permission/permission-current/reply");
    assert.ok(aborts(service).length >= 1);
    assert.equal(service.trace.filter((r) => r.method === "POST" && r.route.endsWith("/message")).length, 1,
      "成功交接不得发起额外模型续写，避免重复消耗");
    assertNoNativeExecution(service);
  });

  test("交接后外部工具结果能在同一会话继续下一轮，载荷不被改写", { timeout: 3000 }, async () => {
    const firstService = fakeService();
    const first = await runGuard(firstService);
    assert.equal(first.json.info.finish, "tool-calls");
    assert.equal(first.json.structured.calls[0].name, "Read");
    const continuation = { ...PAYLOAD, parts: [{ type: "text",
      text: "外部客户端已执行 Read，工具结果：fake file contents。请据此继续回答。" }] };
    const secondRaw = JSON.stringify(NORMAL_JSON);
    const secondService = fakeService({ permission: null, immediate: { status: 200, rawText: secondRaw } });
    const second = await runGuard(secondService, { payload: continuation });
    assert.deepEqual(second.json, NORMAL_JSON);
    assert.deepEqual(secondService.trace.find((r) => r.method === "POST" && r.route.endsWith("/message")).body,
      continuation);
    assert.equal(aborts(secondService).length, 0, "下一轮不能沿用前一轮已中止的状态");
    assertNoNativeExecution(firstService);
    assertNoNativeExecution(secondService);
  });

  for (const [name, options, overrides] of [
    ["模型选错未提供的外部工具", {}, { tools: TOOLS.filter((t) => t.name !== "Read") }],
    ["tool_choice 禁止工具", {}, { toolChoice: { type: "none" } }],
    ["原生工具缺必填参数", { nativePart: partFor("edit", { filePath: "/fake/a" }) }, {}],
    ["找不到匹配 callID", { nativePart: partFor("read", { filePath: "/wrong" }, "call-unrelated") }, {}],
    ["没有 callID 的权限", { permission: { ...permissionFor(), tool: undefined } }, {}],
  ]) {
    test(`${name}：reject 反馈 StructuredOutput，允许模型继续正常返回`, { timeout: 3000 }, async () => {
      const service = fakeService({ ...options, finishOnReject: true });
      const result = await runGuard(service, overrides);
      assert.equal(result.status, 200);
      assert.deepEqual(result.json, NORMAL_JSON);
      assert.equal(replies(service).length, 1);
      assert.match(replies(service)[0].body.message || "", /StructuredOutput/i,
        "拒绝必须指导模型使用结构化信封，不能让它反复执行原生工具");
      assertNoNativeExecution(service);
    });
  }

  test("只有其他会话的权限时完全不 reply，超时仅清理当前会话", { timeout: 3000 }, async () => {
    const service = fakeService({ permission: null, extraPermissions: [permissionFor(OTHER, "other", "other-permission")] });
    await requireFailure(service, { timeoutMs: 75 });
    assert.equal(replies(service).length, 0);
    assert.equal(service.trace.some((r) => r.route.includes(OTHER)), false);
    assert.ok(service.postSignal?.aborted, "超时必须取消本地挂起 POST");
  });

  test("没有权限事件的挂起推理也必须超时清理", { timeout: 3000 }, async () => {
    const service = fakeService({ permission: null });
    await requireFailure(service, { timeoutMs: 75 });
    assert.ok(service.postSignal?.aborted);
  });

  test("message POST 网络异常仍清理当前会话", { timeout: 3000 }, async () => {
    const service = fakeService({ permission: null, postError: new Error("fake transport failure") });
    await requireFailure(service, { timeoutMs: 100 });
  });

  test("持续权限查询异常不得永远挂住，截止后 abort 清理", { timeout: 3000 }, async () => {
    const service = fakeService({ permissionError: new Error("fake permission failure") });
    await requireFailure(service, { timeoutMs: 75 });
    assert.ok(service.postSignal?.aborted);
  });

  test("权限拒绝请求失败不能当作交接成功，截止后必须清理", { timeout: 3000 }, async () => {
    const service = fakeService({ replyError: new Error("fake rejection failure") });
    await requireFailure(service, { timeoutMs: 75 });
    assert.ok(replies(service).length >= 1);
    assert.ok(service.postSignal?.aborted);
  });

  test("正常正文原样返回，不能改 rawText、状态码或消息载荷", { timeout: 3000 }, async () => {
    const rawText = "{\n  \"info\": {\"finish\":\"stop\"}, \"structured\": {\"content\":\"normal\",\"calls\":[]}\n}";
    const service = fakeService({ permission: null, immediate: { status: 201, rawText } });
    const result = await runGuard(service);
    assert.equal(result.status, 201);
    assert.equal(result.rawText, rawText);
    assert.deepEqual(result.json, JSON.parse(rawText));
    assert.deepEqual(service.trace.find((r) => r.method === "POST" && r.route.endsWith("/message")).body, PAYLOAD);
    assert.equal(replies(service).length, 0);
    assert.equal(aborts(service).length, 0, "正常完成不应中止会话");
    assertNoNativeExecution(service);
  });
});
