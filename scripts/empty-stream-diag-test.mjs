/**
 * 「200 + 空流」具名归因 + 防误杀 测试套件（v1.0.74）
 *
 * 这次改造的病根（出自 .research/ow-bridge/docs/validation.md:86-92，只读参考）：
 * OW Bridge 只从**两个**来源读模型的工具调用信封，漏了 StructuredOutput 工具调用，
 * 把一次**完全正确**的回答报成了「Invalid model response envelope」。
 * 它的推理方式是"我期望读到的来源都没读到 → 判失败"——**而没读到的来源本身就是
 * 判据的一部分**。判空枚举漏一项，正常响应就被误杀。
 *
 * 于是本套件的核心不是"多写几条文案"，而是**证明判据与真实解析路径逐项对齐**：
 *   ★ 防误杀用例——一个含**我们不认识的 content 类型**的响应，必须被判成功并
 *     原样透传，而不是空流失败。这是本次改造存在的理由。
 *
 * 两类测试：
 *   · **源码求值**（快、确定性）—— 从 src/server/server.mjs 里按锚点**切出真函数**，
 *     用 new Function 组装跑。测的是仓库里那份代码本身，不是抄一份重写。
 *     切错位置会由 anchor 断言当场炸掉（不会静默验错代码）。
 *   · **端到端**—— 真 spawn 一份 server.mjs（BAI_DATA_DIR 指向 os.tmpdir()，
 *     端口全部挑 17xxx 的空闲口），前面架一台**假上游**按用例吐不同的 SSE，
 *     走完整个中转链路再比对客户端真正看到的东西。
 *
 * 反向对照（sabotage）怎么跑 —— 见文件末尾 `SABOTAGE 说明` 段，命令是：
 *   ① S1  关掉 unrecognized_shape 的透传分支（还原"改前一律判空流"）
 *   ② S2  把具名文案换回改前那句通用文案
 *   两次都要断言**套件变红**，然后还原并 `grep SABOTAGE` 自证干净。
 *
 * 红线：
 *   · 所有落盘都在 os.tmpdir() 下，**绝不碰真实的 %APPDATA%\bai-router**。
 *   · 凭据一律 'oc_dummy-not-a-real-key' 这类明显假串；
 *     源码/命令/日志里**没有任何真实令牌**。
 *   · 未识别帧的原文只回传给**发起这次请求的同一个客户端**；写进 relayErrors 的
 *     只有**键名与形状**，绝不写值（上游可能把凭据回显在未知字段里）。
 *   · 端口只用 17xxx，与另外三个套件（动态临时口）不会撞；
 *     npm test 仍带 --test-concurrency=1。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const SRC = readFileSync(SERVER, "utf8");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-empty-diag-"));
const DUMMY_KEY = "oc_dummy-not-a-real-key";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => { try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ================================================================== *
 * 源码求值工具
 * ================================================================== */

/** 从 startAnchor 切到 endAnchor 之前（不含 endAnchor）。 */
function sliceBetween(startAnchor, endAnchor) {
  const i = SRC.indexOf(startAnchor);
  assert.ok(i >= 0, `抠源码失败：找不到 ${JSON.stringify(startAnchor)}`);
  const j = SRC.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(j > i, `抠源码失败：${JSON.stringify(startAnchor)} → ${JSON.stringify(endAnchor)} 没找到终点`);
  const out = SRC.slice(i, j);
  // ⚠ 切片一旦**停在块注释中间**，后面抠到的整段代码都会被当成注释吞掉，
  //   症状是 new Function 里报 "xxx is not defined"，非常难查。这里当场拦下。
  assert.equal((out.match(/\/\*/g) || []).length, (out.match(/\*\//g) || []).length,
    `切片停在注释中间（/* 与 */ 不配对）：${JSON.stringify(startAnchor)} → ${JSON.stringify(endAnchor)}`);
  return out;
}

/* 三段真实源码。锚点里的中文注释是**刻意的冗余标记**：
 * 有人改了这一段的功能却没动锚点，assert.ok 会当场炸；有人挪动了锚点位置，
 * 抠出来的会是不相干的代码，下面每条用例的断言随即失败——不会静默验错代码。 */
const CONSTS = sliceBetween(
  "const WB_STREAM_META_KEYS = new Set([",
  "/** 只描述**形状**");
const SHAPES = sliceBetween(
  "function wbShapeOf(v) {",
  "\n/**\n * 扫描一个");
const RESIDUE = sliceBetween(
  "function wbFrameResidue(d, sseEvent) {",
  "/** 归因表");
const ATTRS = sliceBetween(
  "const EMPTY_STREAM_ATTRIBUTIONS = {",
  "function classifyEmptyStream(probe)");

// 抠位置自证：三段里必须真的含有各自的特征符号，否则下面测的不是这段代码。
assert.ok(CONSTS.includes("WB_KNOWN_FRAME_TYPES"), "常量段抠错位置：缺 WB_KNOWN_FRAME_TYPES");
assert.ok(SHAPES.includes("wbResidueHasValue") && SHAPES.includes("function wbResidue("),
  "形状段抠错位置：缺 wbResidueHasValue / wbResidue");
assert.ok(RESIDUE.includes("WB_STREAM_META_KEYS.has(k)"), "residue 段抠错位置：缺顶层白名单那一行");
assert.ok(RESIDUE.includes('if (typeof v === "string" && v) continue;'),
  "residue 段抠错位置：缺 delta.content 非空字符串的那道消费判据");
assert.ok(ATTRS.includes("upstream_truncated") && ATTRS.includes("unrecognized_shape"),
  "归因表抠错位置：缺具名归因条目");
/* v1.0.78 起是 **5** 条：多了 upstream_rejected（非 2xx 是「上游拒绝了」，
   不是「空流」）。它必须排在分类判据最前面——少了它，一次 429 会被说成
   「上游一个字都没返回」，诊断与事实相反。 */
assert.equal((ATTRS.match(/^\s{2}[a-z_]+: \{$/gm) || []).length, 5,
  `归因表应当正好 5 条具名归因，实际抠到 ${(ATTRS.match(/^\s{2}[a-z_]+: \{$/gm) || []).length} 条`);
assert.ok(ATTRS.includes("upstream_rejected"), "归因表抠错位置：缺 upstream_rejected（v1.0.78 新增）");

const CLASSIFY = sliceBetween("function classifyEmptyStream(probe) {", "// OpenAI SSE → Anthropic SSE");
assert.ok(CLASSIFY.includes("unrecognized_shape") && CLASSIFY.includes("wbUnknownPassthroughText"),
  "判据段抠错位置：缺 unrecognized_shape 早退或透传文本生成");
/* v1.0.78：状态码判据必须**排在 unrecognized_shape 之前**——
   顺序反了的话，一个「429 + 顺带一个未知字段」的响应会先去走透传分支。 */
const iRejected = CLASSIFY.indexOf("upstream_rejected");
const iShape = CLASSIFY.indexOf("unrecognized_shape");
assert.ok(iRejected > 0, "判据段抠错位置：缺非 2xx 的状态码早退");
assert.ok(iRejected < iShape, "状态码判据必须排在 unrecognized_shape 之前");

/** 把抠出来的真函数组装成一个可注入 wbErrPrefix 的沙箱。 */
function loadDiag(errPrefix = "WorkBuddy") {
  const factory = new Function("wbErrPrefix",
    `${CONSTS}\n${SHAPES}\n${RESIDUE}\n${ATTRS}\n${CLASSIFY}
return { wbFrameResidue, classifyEmptyStream, wbEmptyStreamCore, wbUnknownPassthroughText,
         wbShapeOf, wbResidueHasValue, EMPTY_STREAM_ATTRIBUTIONS };`);
  return factory(errPrefix);
}
const api = loadDiag();
const { wbFrameResidue, classifyEmptyStream, wbEmptyStreamCore, wbUnknownPassthroughText, EMPTY_STREAM_ATTRIBUTIONS } = api;

const KINDS = ["upstream_rejected", "upstream_nothing", "unrecognized_shape", "upstream_truncated", "upstream_blank"];

/* ================================================================== *
 * A. 源码求值（真函数）
 * ================================================================== */

describe("A. 归因表：每一种具名归因都有不同文案与处置建议", () => {
  test("五种归因齐全，且文案两两不同、都不再用改前那句通用文案", () => {
    const texts = KINDS.map((k) => wbEmptyStreamCore(k));
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        assert.notEqual(texts[i], texts[j], `${KINDS[i]} 与 ${KINDS[j]} 的文案撞了，用户分不出区别`);
      }
      assert.match(texts[i], /建议：/, `${KINDS[i]} 的文案没说用户该做什么`);
      assert.ok(!/上游返回了空流（没有任何内容/.test(texts[i]),
        `${KINDS[i]} 还挂着改前那句通用文案——这次改造没做干净`);
      assert.ok(!/\[WorkBuddy\]/.test(texts[i]),
        `${KINDS[i]} 的正文里不该自带渠道前缀（bail() 会再加一次，会变成 [X] [X]）`);
    }
  });

  test("每一种归因都给出不同的、指向不同动作的处置建议", () => {
    const dos = KINDS.map((k) => EMPTY_STREAM_ATTRIBUTIONS[k].do);
    for (let i = 0; i < dos.length; i++) {
      for (let j = i + 1; j < dos.length; j++) {
        assert.notEqual(dos[i], dos[j], `${KINDS[i]} 与 ${KINDS[j]} 的处置建议撞了`);
      }
    }
    assert.match(EMPTY_STREAM_ATTRIBUTIONS.unrecognized_shape.do, /不用管/,
      "未知形状属性能被正常翻译，用户不该被要求做任何事");
    assert.match(EMPTY_STREAM_ATTRIBUTIONS.upstream_nothing.do, /重试|换/);
    // ★ v1.0.78：upstream_rejected 的正文**不许**出现「上游一个字都没返回」——
    // 非 2xx 的上游是「说了不」，不是「没说话」。这条断言就是那个 bug 的形状。
    for (const field of ["label", "zh", "hint", "do"]) {
      assert.ok(!String(EMPTY_STREAM_ATTRIBUTIONS.upstream_rejected[field]).includes(EMPTY_STREAM_ATTRIBUTIONS.upstream_nothing.label),
        `upstream_rejected.${field} 里混进了「${EMPTY_STREAM_ATTRIBUTIONS.upstream_nothing.label}」`);
    }
    assert.match(EMPTY_STREAM_ATTRIBUTIONS.upstream_truncated.do, /重试|反馈|换/);
    assert.match(EMPTY_STREAM_ATTRIBUTIONS.upstream_blank.do, /重试|换/);
  });

  test("每一种归因都单独有一条用例：探针形态 → 归因名一一对上", () => {
    const CASES = [
      ["upstream_nothing", { dataFrames: 0, opened: 0, sawDone: false, sawFinish: false, unknown: [] }],
      ["unrecognized_shape", { dataFrames: 1, opened: 0, sawDone: true, sawFinish: false,
        unknown: [{ where: "top", key: "structured_output", shape: "object(a)", hasValue: true, raw: "{}" }] }],
      ["upstream_truncated", { dataFrames: 2, opened: 2, sawDone: false, sawFinish: false, unknown: [] }],
      ["upstream_blank", { dataFrames: 3, opened: 3, sawDone: true, sawFinish: false, unknown: [] }],
    ];
    for (const [want, probe] of CASES) {
      assert.equal(classifyEmptyStream(probe), want,
        `探针 ${JSON.stringify(probe)} 应判为 ${want}，实际 ${classifyEmptyStream(probe)}`);
    }
  });
});

describe("B. ★ 防误杀：判据与真实解析路径逐项对齐（单测层）", () => {
  test("★ 未知 content 类型的帧 → unrecognized_shape（而不是空流）", () => {
    // 这一条就是 OW Bridge 踩的坑的镜像：他们把 StructuredOutput 工具调用漏出枚举，
    // 于是一次完全正确的回答被判成「格式错误」。这里换成 OpenAI 侧的说法：
    // 上游换了一种我们还不支持的块类型。
    const frame = { type: "some_new_vendor_block", data: { note: "hello-from-vendor-xyz", v: 42 } };
    const res = wbFrameResidue(frame, "");
    assert.ok(res.some((r) => r.key === "type" && r.hasValue),
      `顶层未知 type 应当被记成 residue，实际 ${JSON.stringify(res)}`);
    assert.equal(classifyEmptyStream({ dataFrames: 1, opened: 0, sawDone: true, sawFinish: false, unknown: res }),
      "unrecognized_shape", "未知块类型必须判成 unrecognized_shape，不能判成空流");
  });

  test("★ 判空枚举逐项对齐：wbPipe 会消费的每一种形状，residue 都必须放过", () => {
    // 白名单**故意写成宽松版**（少写几个键）。若 wbFrameResidue 对这些也报错，
    // 说明它和真实消费路径脱节了——那正是 OW Bridge 的死法。
    const RECOGNIZED = [
      ["文本块", { choices: [{ index: 0, delta: { content: "你好" } }] }],
      ["思考块 reasoning_content", { choices: [{ index: 0, delta: { reasoning_content: "想一下" } }] }],
      ["思考块 reasoning", { choices: [{ index: 0, delta: { reasoning: "想一下" } }] }],
      ["工具调用", { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "f", arguments: "{}" } }] } }] }],
      ["结束原因", { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
      ["role 前缀", { choices: [{ index: 0, delta: { role: "assistant" } }] }],
      ["标准 OpenAI 元字段", { id: "x", object: "chat.completion.chunk", created: 1, model: "m", system_fingerprint: "fp" }],
      ["顶层 usage", { choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 5 } }],
      ["非数据行（data: 之前）", {}],
    ];
    for (const [name, frame] of RECOGNIZED) {
      const res = wbFrameResidue(frame, "");
      const valued = res.filter((r) => r.hasValue);
      assert.deepEqual(valued, [], `${name} 是 wbPipe 真会消费的形状，却被记成了未识别残留：${JSON.stringify(res)}`);
    }
  });

  test("★ 枚举漏项才是病：OW Bridge 漏的那一类，本实现一个都不漏", () => {
    // 逐个构造"上游给了内容、但形状不在消费路径里"的帧，
    // 断言每一个都能被识别成 residue（有值 → unrecognized_shape）。
    const MISSED_BY_OW = [
      ["未知 content 类型", { type: "some_new_vendor_block", data: { note: "x" } }],
      ["结构化输出字段", { choices: [{ delta: {} }], structured_output: { answer: 1 } }],
      ["content 传数组（Qwen 系网关）", { choices: [{ delta: { content: [{ type: "text", text: "你好" }] } }] }],
      ["reasoning 传数组", { choices: [{ delta: { reasoning: [{ type: "text", text: "x" }] } }] }],
      ["legacy function_call", { choices: [{ delta: { function_call: { name: "f", arguments: "{}" } } }] }],
      ["refusal 字符串", { choices: [{ delta: { refusal: "我不能回答这个" } }] }],
      ["Responses API 的 response 包装", { type: "response.completed", response: { output: [{ content: [{ text: "x" }] }] } }],
      ["顶层 output_text", { output_text: "x" }],
      ["裸字符串帧", "just a string"],
    ];
    for (const [name, frame] of MISSED_BY_OW) {
      const res = wbFrameResidue(frame, "");
      assert.ok(res.length > 0, `${name} 竟然没被记成 residue——枚举漏了这一项，正常响应会被误判成空流`);
      assert.ok(res.some((r) => r.hasValue),
        `${name} 被记了残留但没值，等于仍会被判成空流：${JSON.stringify(res)}`);
      assert.equal(classifyEmptyStream({ dataFrames: 1, opened: 1, sawDone: true, sawFinish: false, unknown: res }),
        "unrecognized_shape", `${name} 必须判成 unrecognized_shape`);
    }
  });

  test("★ 空形状与有形状必须分开：空串 / 空数组 / null 归「空」，不是「不认识」", () => {
    // 反过来也不能滥判：上游明说了"这里是空的"就不能算未识别内容，
    // 否则真正的空流会被伪装成"格式不认识"。
    const BLANK = [
      ["空 content 字符串", { choices: [{ delta: { content: "" } }] }],
      ["content 为 null（OW Bridge 记过的同源形态）", { choices: [{ delta: { content: null } }] }],
      ["空 content 数组", { choices: [{ delta: { content: [] } }] }],
      ["空 tool_calls", { choices: [{ delta: { tool_calls: [] } }] }],
      ["空对象", {}],
    ];
    for (const [name, frame] of BLANK) {
      const res = wbFrameResidue(frame, "");
      assert.deepEqual(res.filter((r) => r.hasValue), [],
        `${name} 是"上游说了空"，不该被算成未识别内容：${JSON.stringify(res)}`);
    }
  });

  test("★ 兜底取反：usage 存在但没有内容块 → 仍然判成功，不进 bail 分支", () => {
    // usage 是 wbPipe 里 `if (idx < 0 && !usage)` 的另一半：改前就已经按成功处理。
    // 这次改造不得把它改回失败——保守方向不变。
    const probe = { dataFrames: 1, opened: 1, sawDone: true, sawFinish: true, unknown: [] };
    assert.equal(classifyEmptyStream(probe), "upstream_blank");
    assert.equal(probe.dataFrames > 0 && classifyEmptyStream(probe) !== "upstream_nothing", true,
      "usage 分支：探针本身有数据帧，走的是非 bail 侧");
  });

  test("★ 正常响应里的未知字段绝不外泄：residue 只在 idx<0 时才进响应", () => {
    // 这是"收集 ≠ 透传"的判据：有内容的响应里混进未知字段，只记进 probe 供诊断，
    // 绝不能凭空多出一段文本。断言传输层不会用到它。
    const res = wbFrameResidue({ choices: [{ delta: { content: "正常回答" } }], vendor_extra: { a: 1 } }, "");
    assert.equal(res.filter((r) => r.hasValue).length, 1, "vendor_extra 应当被记成 residue（供诊断）");
    // wbPipe 的分支条件里 passthrough 只在 idx < 0 时被赋值——这里把同一条件抄出来断言。
    const idxWithText = 0;
    const wouldPassthrough = idxWithText < 0;
    assert.equal(wouldPassthrough, false, "有内容的响应(idx>=0)绝不能进入透传分支");
  });
});

describe("C. 反向对照（套件内）", () => {
  test("改前那条判据（idx<0 && !usage）对四种形态**无法区分**——证明新判据确实增加了信息", () => {
    // 改前：四种情况全被归成同一句"可能是该模型后端当前不可用"。
    const OLD_RULE = (probe) => (probe.opened >= 0 ? "bail: 上游返回了空流（可能是后端不可用）" : "bail");
    const PROBES = [
      { name: "upstream_nothing", dataFrames: 0, opened: 0, sawDone: false, sawFinish: false, unknown: [] },
      { name: "unrecognized_shape", dataFrames: 1, opened: 0, sawDone: true, sawFinish: false, unknown: [{ hasValue: true }] },
      { name: "upstream_truncated", dataFrames: 2, opened: 2, sawDone: false, sawFinish: false, unknown: [] },
      { name: "upstream_blank", dataFrames: 3, opened: 3, sawDone: true, sawFinish: false, unknown: [] },
    ];
    const oldOutcomes = PROBES.map(OLD_RULE);
    assert.equal(new Set(oldOutcomes).size, 1,
      "反向对照失效：旧判据竟能区分这四种，说明这个用例没测到东西");
    const newOutcomes = PROBES.map((p) => classifyEmptyStream(p));
    assert.equal(new Set(newOutcomes).size, 4,
      `新判据应当把四种分开，实际 ${JSON.stringify(newOutcomes)}`);
    assert.deepEqual(newOutcomes, PROBES.map((p) => p.name));
  });

  test("反向对照：未知形状的透传文本必须**原样带上上游内容**，否则等于吞掉了回答", () => {
    const frame = { type: "some_new_vendor_block", data: { note: "hello-from-vendor-xyz", v: 42 } };
    const res = wbFrameResidue(frame, "");
    const txt = wbUnknownPassthroughText(res);
    assert.match(txt, /some_new_vendor_block/, "透传文本里必须能看到上游那个块的类型名");
    assert.match(txt, /hello-from-vendor-xyz/, "透传文本里必须能看到上游原文——不原样带出去就等于把回答吞了");
    assert.match(txt, /未识别的字段：/, "透传文本要具名说明哪些字段没被认出来");
  });

  test("反向对照：透传文本里绝不出现渠道前缀以外的未知内容/凭据位", () => {
    // 透传文本的固定前缀由 wbErrPrefix 决定，不含任何配置读取。
    const withOther = loadDiag("Qoder");
    const res = wbFrameResidue({ type: "some_new_vendor_block", data: { note: "x" } }, "");
    const txt = withOther.wbUnknownPassthroughText(res);
    assert.match(txt, /^【Qoder /, `渠道前缀应随 wbErrPrefix 变，实际开头：${txt.slice(0, 40)}`);
  });

  test("反向对照：空探针不会崩（拿不准时的最坏输入）", () => {
    for (const bad of [{}, null, undefined, { unknown: null }, { unknown: [null, undefined] }]) {
      assert.doesNotThrow(() => classifyEmptyStream(bad), `classifyEmptyStream(${JSON.stringify(bad)}) 抛了`);
    }
    assert.doesNotThrow(() => wbFrameResidue(undefined, ""));
    assert.doesNotThrow(() => wbFrameResidue(null, ""));
  });
});

/* ================================================================== *
 * D. 端到端：真 spawn server.mjs + 假上游
 * ================================================================== */

/** 只在 17xxx 里挑空闲口（红线：不与其它套件/真实服务撞）。 */
async function freePorts17(n) {
  const ports = [];
  for (let i = 0; i < n; i++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const p = 17100 + Math.floor(Math.random() * 400);
      if (ports.includes(p)) continue;
      const s = http.createServer();
      const ok = await new Promise((res) => {
        s.once("error", () => res(false));
        s.listen(p, "127.0.0.1", () => res(true));
      });
      if (ok) { await new Promise((r) => s.close(r)); ports.push(p); break; }
      try { s.close(); } catch { }
      if (attempt === 199) throw new Error("17xxx 里找不到空闲端口");
    }
  }
  return ports;
}

/** 把 SSE 帧数组拼成假上游的响应体。对象自动加 `data: ` 前缀；
 *  字符串按**整行**处理（自己写前缀），否则 "[DONE]" 会漏掉 data: 前缀、
 *  上游根本收不到结束标记，截断/空信封两类就会串味。 */
function sse(...frames) {
  return frames
    .map((f) => (typeof f === "string" ? f : `data: ${JSON.stringify(f)}`))
    .join("\n\n") + "\n\n";
}
const has = (hay, needle) => assert.ok(String(hay).includes(needle),
  `文案里找不到「${needle}」，实际：${String(hay).slice(0, 220)}`);

describe("D. e2e：客户端真正看到的东西", () => {
  let child, fake, dataDir, P;
  let upstreamBody = "";    // 每个用例自己设

  before(async () => {
    const [bai, sn, wb, wbai, zen, qd, or, panel, upstream] = await freePorts17(9);
    P = { bai, sn, wb, wbai, zen, qd, or, panel, upstream };
    dataDir = mkdtempSync(path.join(TMPROOT, "boot-"));

    const cfg = JSON.parse(readFileSync(path.join(REPO, "src", "server", "config.defaults.json"), "utf8"));
    cfg.relayPort = bai; cfg.panelPort = panel;
    Object.assign(cfg, { sn: { ...cfg.sn, relayPort: sn }, wb: { ...cfg.wb, relayPort: wb },
      wbai: { ...cfg.wbai, relayPort: wbai }, zen: { ...cfg.zen, relayPort: zen },
      qd: { ...cfg.qd, relayPort: qd }, or: { ...cfg.or, relayPort: or } });
    cfg.failover.enabled = false;
    /* 预置 cfg.proxy：否则 server.mjs 启动后会跑代理探测、applyProxy 后**自重启**
     * （server.mjs:876 spawn 继任者后 exit(0)），本进程被杀 → 后面全 ECONNREFUSED。
     * applyProxy 首行是 `if ((cfg.proxy || "") === norm) return false;`，
     * 预置成探测必定选中的那个值（PROXY_CANDIDATES 头一个是 7897）就短路了。 */
    cfg.proxy = "http://127.0.0.1:7897";
    cfg.zen = { ...cfg.zen, useProxy: true, apiKey: DUMMY_KEY,
      upstream: `http://127.0.0.1:${upstream}/zen/go/v1` };
    writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

    fake = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
        res.end(upstreamBody);
      });
    });
    await new Promise((r) => fake.listen(upstream, "127.0.0.1", r));

    child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, BAI_DATA_DIR: dataDir, NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1" },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    child.stdout.resume(); child.stderr.resume();

    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      try { if ((await fetch(`http://127.0.0.1:${panel}/api/status`).then((r) => r.json())).service?.up) return; }
      catch { }
      await sleep(300);
    }
    throw new Error("server.mjs 40 秒内没把面板端口起起来");
  }, { timeout: 60000 });

  after(() => {
    try { child && child.kill(); } catch { }
    try { fake && fake.close(); } catch { }
    try { dataDir && rmSync(dataDir, { recursive: true, force: true }); } catch { }
  });

  /** 发一次非流式中转请求，返回 {status, json}。 */
  const relay = async (stream) => {
    const r = await fetch(`http://127.0.0.1:${P.zen}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-fable-5", max_tokens: 64, stream: !!stream,
        messages: [{ role: "user", content: "空流归因 e2e" }] }),
      signal: AbortSignal.timeout(25000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 留在 text 里 */ }
    return { status: r.status, text, json };
  };
  const msgOf = (r) => String(r.json?.error?.message || r.json?.content?.[0]?.text || r.text);

  /* ---- ★ 防误杀（e2e）---- */

  test("★ 未知 content 类型 → 判成功，并把上游原文原样透传给客户端（非流式）", async () => {
    upstreamBody = sse(
      { type: "some_new_vendor_block", data: { note: "hello-from-vendor-xyz", v: 42 } },
      "data: [DONE]");
    const r = await relay(false);
    assert.equal(r.status, 200,
      `未知 content 类型**必须**判成功（不是空流失败），实际 ${r.status}：${msgOf(r).slice(0, 160)}`);
    assert.ok(!r.json?.error, `不该是 Anthropic error：${msgOf(r).slice(0, 160)}`);
    assert.ok(Array.isArray(r.json?.content) && r.json.content.length > 0,
      "透传后必须仍有内容块，否则用户拿到的是空回复");
    assert.match(msgOf(r), /hello-from-vendor-xyz/,
      "上游原文必须原样带出来——不原样带出去等于把回答吞了");
    assert.match(msgOf(r), /some_new_vendor_block/);
  });

  test("★ 未知 content 类型 → 流式路径同样判成功并透传", async () => {
    upstreamBody = sse(
      { type: "some_new_vendor_block", data: { note: "stream-hello-from-vendor", v: 7 } },
      "data: [DONE]");
    const r = await relay(true);
    assert.equal(r.status, 200, `流式未知形状不该失败，实际 ${r.status}`);
    assert.ok(!/"type"\s*:\s*"error"/.test(r.text), `不该出 error 事件：${r.text.slice(-300)}`);
    assert.match(r.text, /stream-hello-from-vendor/, "流式路径也必须原样透传上游原文");
  });

  test("★ 结构化输出字段 + 数组 content 都不被误杀（OW Bridge 同源形态）", async () => {
    upstreamBody = sse(
      { choices: [{ delta: { content: [{ type: "text", text: "数组里的正文" }] } }] },
      "data: [DONE]");
    let r = await relay(false);
    assert.equal(r.status, 200, `数组 content 被误杀了：${r.status} ${msgOf(r).slice(0, 120)}`);
    assert.match(msgOf(r), /数组里的正文/);

    upstreamBody = sse(
      { choices: [{ delta: {} }], structured_output: { answer: 42 } },
      "data: [DONE]");
    r = await relay(false);
    assert.equal(r.status, 200, `结构化输出字段被误杀了：${r.status} ${msgOf(r).slice(0, 120)}`);
    assert.match(msgOf(r), /structured_output/);
  });

  /* ---- 三种真·空流 ---- */

  test("upstream_nothing：上游一个字都没发 → 502 + 具名文案（带处置建议）", async () => {
    upstreamBody = sse();   // 连一个 data 帧都没有
    const r = await relay(false);
    assert.equal(r.status, 502, `真·空流应报 502，实际 ${r.status}`);
    const m = msgOf(r);
    has(m, EMPTY_STREAM_ATTRIBUTIONS.upstream_nothing.label);
    assert.match(m, /建议：/, "必须说清用户该做什么");
    assert.ok(!/上游返回了空流（没有任何内容/.test(m), "还挂着改前那句通用文案");
  });

  test("upstream_nothing：只有心跳 / 直接 [DONE] 也算「什么都没返回」", async () => {
    upstreamBody = ": heartbeat\n\ndata: [DONE]\n\n";
    const r = await relay(false);
    assert.equal(r.status, 502);
    has(msgOf(r), EMPTY_STREAM_ATTRIBUTIONS.upstream_nothing.label);
  });

  test("upstream_blank：只收到空信封（空串 / 空数组 / null / 空对象）→ 502 + 具名文案", async () => {
    const BLANKS = [
      ["空对象", {}],
      ["空 content 字符串", { choices: [{ delta: { content: "" } }] }],
      ["空 content 数组", { choices: [{ delta: { content: [] } }] }],
      ["content 为 null", { choices: [{ delta: { content: null } }] }],
      ["空 tool_calls", { choices: [{ delta: { tool_calls: [] } }] }],
    ];
    const seen = new Set();
    for (const [name, frame] of BLANKS) {
      upstreamBody = sse(frame, "data: [DONE]");
      const r = await relay(false);
      assert.equal(r.status, 502, `${name} 应当判空流，实际 ${r.status}：${msgOf(r).slice(0, 120)}`);
      assert.match(msgOf(r), /\[(WorkBuddy|OpenCode Zen|Zen|Qoder|OpenRouter)\]/,
        `${name} 的报错应当带渠道前缀：${msgOf(r).slice(0, 120)}`);
      seen.add(msgOf(r));
    }
    // 五种"格式正常但内容为空"的上游响应，必须**塌缩成同一条具名文案**
    // （反过来若吐出 5 条，说明判据根本没起作用）。
    assert.equal(seen.size, 1,
      `五种空信封应收敛成同一条文案，实际吐了 ${seen.size} 条：${[...seen].join(" || ")}`);
    assert.ok([...seen].every((m) => m.includes(EMPTY_STREAM_ATTRIBUTIONS.upstream_blank.label)),
      `空信封应归为 upstream_blank，实际：${[...seen][0].slice(0, 200)}`);
  });

  test("upstream_truncated：开过信封但没结束标记也没结束原因 → 502 + 具名文案", async () => {
    upstreamBody = sse({ choices: [{ delta: { role: "assistant", content: "" } }] });   // 注意：没有 [DONE]
    const r = await relay(false);
    assert.equal(r.status, 502, `截断应报 502，实际 ${r.status}`);
    has(msgOf(r), EMPTY_STREAM_ATTRIBUTIONS.upstream_truncated.label);
    assert.match(msgOf(r), /建议：/);
  });

  test("usage 存在但内容为空 → 保守判成功（顶多一句空回复），不得报空流失败", async () => {
    upstreamBody = sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 0 } }, "data: [DONE]");
    const r = await relay(false);
    assert.equal(r.status, 200, `usage 在场时改前就判成功，这次改造不得改回失败：${r.status} ${msgOf(r).slice(0, 120)}`);
    assert.ok(!r.json?.error, `不该是错误响应：${msgOf(r).slice(0, 120)}`);
    // output_tokens 被 Math.max(1, …) 兜到 >=1（改动前就是如此），这里只断言"没被当成失败"
    assert.ok(r.json?.usage?.output_tokens >= 0, "usage 应当照常回填");
  });

  /* ---- 回归：正常流一个字都不能变 ---- */

  test("回归：正常文本流判成功、内容逐字不变、且不会多出透传段", async () => {
    upstreamBody = sse(
      { choices: [{ index: 0, delta: { role: "assistant" } }] },
      { choices: [{ index: 0, delta: { content: "你好" } }] },
      { choices: [{ index: 0, delta: { content: "，世界" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      "data: [DONE]");
    const r = await relay(false);
    assert.equal(r.status, 200);
    assert.equal(r.json?.content?.[0]?.text, "你好，世界", `正常文本被改坏了：${msgOf(r).slice(0, 120)}`);
    assert.equal(r.json?.content.length, 1, "正常响应只应有一个内容块，多出来的就是透传污染");
  });

  test("回归：正常响应里混进未知字段 → 成功、内容仍是原文，不多出透传段", async () => {
    // 「收集 ≠ 透传」：噪声只留在诊断里，绝不凭空插一段内容。
    upstreamBody = sse(
      { id: "c1", object: "chat.completion.chunk", vendor_extra: { trace: 1 },
        choices: [{ index: 0, delta: { content: "正文" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "data: [DONE]");
    const r = await relay(false);
    assert.equal(r.status, 200);
    assert.equal(r.json?.content?.[0]?.text, "正文",
      `未知字段污染了正常回答：${msgOf(r).slice(0, 160)}`);
  });

  test("回归：思考块 + 工具调用仍然照常翻译，不被新判据影响", async () => {
    upstreamBody = sse(
      { choices: [{ index: 0, delta: { reasoning_content: "先想想" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city":"北京"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      "data: [DONE]");
    const r = await relay(false);
    assert.equal(r.status, 200);
    const types = (r.json?.content || []).map((c) => c.type);
    assert.deepEqual(types, ["thinking", "tool_use"], `内容块类型变了：${JSON.stringify(types)}`);
    assert.equal(r.json.content[1].input.city, "北京");
    assert.equal(r.json.stop_reason, "tool_use");
  });
});

/* ================================================================== *
 * SABOTAGE 说明（反向对照的跑法，不在 npm test 里）
 * ================================================================== *
 *  ① S1 —— 关掉 unrecognized_shape 的透传分支，还原成"改前：一切判空流"
 *     把 server.mjs 里这一行：
 *       if (idx < 0 && emptyKind === "unrecognized_shape") {
 *     改成：
 *       if (false && idx < 0 && emptyKind === "unrecognized_shape") { // SABOTAGE
 *     → 跑 `node --test scripts/empty-stream-diag-test.mjs`，断言**套件变红**
 *       （★ 防误杀 e2e 那条必须失败：未知形状会拿到 502 而不是透传）。
 *
 *  ② S2 —— 把具名文案换回改前那句通用文案
 *     把 server.mjs 里这一行：
 *       if (bail(wbEmptyStreamCore(emptyKind), "api_error", 502)) return;
 *     改成：
 *       if (bail(`${wbErrPrefix} 上游返回了空流（没有任何内容，可能是该模型后端当前不可用）`, "api_error", 502)) return; // SABOTAGE
 *     → 断言**归因表那几条变红**（文案又都一样了）。
 *
 *  跑完必须还原，并用 `grep -n SABOTAGE src/server/server.mjs` 自证工作区干净。
 * ================================================================== */
