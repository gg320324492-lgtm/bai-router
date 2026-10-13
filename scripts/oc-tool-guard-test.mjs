/**
 * OpenCode 原生工具交接回归：只用假 fetch，不起进程、不读用户文件、不请求网络。
 * 挂起的 message POST 必须被权限轮询解开；只能拒绝原生执行，不能授权 once/always。
 */
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
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
  permissionError = null, lookupError = null, replyError = null, emptyHistoryPolls = 0 } = {}) {
  const trace = [];
  let pending = !!permission;
  let postStarted = false;
  let nativeExecutions = 0;
  let releasePost = null;
  let postSignal = null;
  let historyPolls = 0;
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
      /* 实测（真 opencode serve，E2E_DUMP 见 oc-native-tool-e2e.mjs）：权限对象**先于**
       * 它那条 assistant 消息出现——权限一到，`/message?limit=3` 往往还是 0 条，
       * 几百毫秒后才补上。只查一次的实现在这里必然查不到 part，交接那条路永远走不到。 */
      historyPolls++;
      if (historyPolls <= emptyHistoryPolls) return respond([]);
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

/* ========================================================================== *
 * ★ 交接这条路能不能真的走到（真 opencode 上测出来的时序，E2E_DUMP 存档在
 *   scripts/oc-native-tool-e2e.mjs 里）。这一组全是「单测以前够不到、接上去才发现」的地方。
 * ========================================================================== */
describe("★ 交接时序：权限先于消息出现时，仍必须有界地等到那个 part", () => {
  test("历史先是空的，几次之后才出现 → 必须等它，而不是退化成拒绝", { timeout: 3000 }, async () => {
    /* finishOnReject：万一退化成「拒绝」，挂起的 POST 会被放行，于是拿到的是
     * NORMAL_JSON —— 断言直接打在 finish 上，失败是一条干净的断言，
     * 而不是靠整条用例超时才判红（超时的红看不出到底是哪一步错了）。 */
    const service = fakeService({ emptyHistoryPolls: 3, finishOnReject: true });
    const result = await runGuard(service, { timeoutMs: 3000 });
    assert.equal(result.status, 200);
    assert.equal(result.json.info.finish, "tool-calls",
      `退化成拒绝时拿到的是 ${JSON.stringify(result.json)}`);
    assert.deepEqual(result.json.structured.calls, [{ name: "Read", arguments: { file_path: "/fake/project/data.txt" } }],
      "等到了 part 就必须交接，而不是把「暂时查不到」当成「映射不上」直接拒绝");
    assert.equal(replies(service).length, 1);
    assert.match(replies(service)[0].body.message || "", /executed by Claude Code/i,
      "交接时给模型的反馈应当说明「由 Claude Code 执行」，而不是「用 StructuredOutput」");
    assertNoNativeExecution(service);
  });

  test("等待 part 的次数有界：查满上限仍查不到就拒绝，绝不无限等", { timeout: 3000 }, async () => {
    /* 永远查不到（emptyHistoryPolls 给一个天文数字）→ 必须在有限次查询后收口。 */
    const service = fakeService({ emptyHistoryPolls: 10 ** 6, finishOnReject: true });
    const started = Date.now();
    const result = await runGuard(service, { partLookupTries: 3, timeoutMs: 5000 });
    const ms = Date.now() - started;
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, NORMAL_JSON, "查不到就退回「拒绝 + 引导」，模型继续正常回答");
    assert.equal(replies(service).length, 1, "只拒绝一次");
    assert.match(replies(service)[0].body.message || "", /StructuredOutput/i);
    assert.ok(ms < 4000, `等待必须有界，实际 ${ms} ms`);
    assertNoNativeExecution(service);
  });

  test("权限连 callID 都没有时立刻拒绝，不做无谓等待", { timeout: 3000 }, async () => {
    const service = fakeService({ permission: { ...permissionFor(), tool: undefined }, finishOnReject: true });
    const started = Date.now();
    const result = await runGuard(service, { partLookupTries: 50, timeoutMs: 5000 });
    assert.deepEqual(result.json, NORMAL_JSON);
    assert.equal(replies(service).length, 1);
    assert.ok(Date.now() - started < 2000, "没有 callID 就没有可等的东西，必须立刻拒绝");
    assertNoNativeExecution(service);
  });

  test("查到了 part 但映射不上时立刻拒绝，不陪着等", { timeout: 3000 }, async () => {
    /* 原生工具缺必填参数：part 在第一次查询就有，重试没有意义。 */
    const service = fakeService({ nativePart: partFor("edit", { filePath: "/fake/a" }), finishOnReject: true });
    const result = await runGuard(service, { partLookupTries: 50, timeoutMs: 5000 });
    assert.deepEqual(result.json, NORMAL_JSON);
    assert.match(replies(service)[0].body.message || "", /StructuredOutput/i);
    assert.equal(service.trace.filter((r) => r.route.endsWith("/message") && r.method === "GET").length, 1,
      "part 已经查到了就不该再查第二次");
    assertNoNativeExecution(service);
  });
});

/* ========================================================================== *
 * 接线纪律：守卫必须接在真实中转路径上，且绝不能变成「本地执行」。
 * ========================================================================== */
const WIRING = readFileSync(new URL("../src/server/oc-wiring.mjs", import.meta.url), "utf8");
const GUARD = readFileSync(new URL("../src/server/oc-tool-guard.mjs", import.meta.url), "utf8");

describe("★ 接线：守卫必须接在真实中转路径上，且不存在本地执行分支", () => {
  test("oc-wiring 的消息那一发真的走了守卫，不再是裸 POST", () => {
    assert.match(WIRING, /import\s*\{[^}]*postMessageWithToolGuard[^}]*\}\s*from\s*"\.\/oc-tool-guard\.mjs"/,
      "oc-wiring 必须 import 守卫");
    /* 判据不能只认某一种写法——早先只匹配模板字面量，结果「base + \"/session/\" + ... + \"/message\"
     * 这种等价的裸 POST 照样全绿（真跑过一次）。现在按「任何指向 /message 的 URL 字面量」一刀切：
     * 发送已经全在守卫内部，oc-wiring 里再出现一个就是又开了一条没有权限处理的旁路。
     * 唯一豁免是文件头那段画链路图的注释（/v1/messages，不是 /message）。 */
    const sansComments = WIRING.replace(/^\s*\*.*$/gm, "");
    assert.doesNotMatch(sansComments, /["'`][^"'`]*\/message(?![a-zA-Z])/,
      "oc-wiring 里不得再出现指向 /message 的 URL 字面量（发送必须全部经守卫）");
    assert.match(WIRING, /await postMessageWithToolGuard\(\{/, "真实发送必须调用守卫");
  });

  test("守卫全文件没有把原生工具当成本地动作执行的路径", () => {
    for (const banned of [/child_process/, /\bspawnSync?\s*\(/, /\bexecSync?\s*\(/, /shell\s*:\s*true/,
      /node:fs\b/, /writeFile/, /readFileSync/]) {
      assert.doesNotMatch(GUARD, banned, `守卫里出现本地执行面：${banned}`);
    }
    /* 交接的唯一出口是那个信封，且 rawText 必须与 json 一致（不能留空串）。 */
    assert.match(GUARD, /structured:\s*\{\s*content:\s*'',\s*calls:\s*\[call\]\s*\}/,
      "交接必须产出 calls 信封");
    /* 权限回复只有 reject 一个取值：绝不能出现授权分支。 */
    const replyBodies = [...GUARD.matchAll(/reply:\s*'([^']*)'/g)].map((m) => m[1]);
    assert.ok(replyBodies.length >= 1, "必须真的回复权限");
    assert.deepEqual([...new Set(replyBodies)], ["reject"], "权限回复只能是 reject，不能有 once/always 分支");
  });

  test("每个等待分支都带截止；截止后 abort 被调用且不留野定时器", { timeout: 8000 }, async () => {
    assert.match(GUARD, /AbortSignal\.timeout\(timeoutMs\)/, "总截止必须来自 timeoutMs");
    const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const before = timeouts();
    /* 三种死法都要能收口：挂起无权限、只有别的会话的权限、权限查询持续异常。 */
    for (const [name, svc, over] of [
      ["挂起且无权限事件", fakeService({ permission: null }), { timeoutMs: 80 }],
      ["只有别的会话的权限", fakeService({ permission: null,
        extraPermissions: [permissionFor(OTHER, "other", "other-permission")] }), { timeoutMs: 80 }],
      ["权限查询持续异常", fakeService({ permissionError: new Error("fake") }), { timeoutMs: 80 }],
    ]) {
      await requireFailure(svc, over);
      assert.ok(svc.postSignal?.aborted, `${name}：截止后必须取消挂起的 POST`);
      assert.ok(aborts(svc).length >= 1, `${name}：截止后必须 abort 当前会话`);
      assertNoNativeExecution(svc);
    }
    /* 截止必须真的到点，而不是被别的竞速抢跑。 */
    const started = Date.now();
    await requireFailure(fakeService({ permission: null }), { timeoutMs: 350 });
    assert.ok(Date.now() - started >= 300, "截止不得早于设定时间触发");
    /* 交接这条路同样不能留野定时器（它比截止更早结束）。 */
    const handed = fakeService();
    await runGuard(handed, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(timeouts() <= before + 1,
      `守卫结束后仍有野定时器：${timeouts()} 个（跑之前 ${before} 个）`);
  });
});
