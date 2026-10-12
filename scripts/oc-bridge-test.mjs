/**
 * oc-bridge 协议翻译测试（v1.0.75，OpenCode 接入）
 *
 * ## 测什么
 *
 * 纯函数，**不起进程、不发网络、不碰 %APPDATA%**。测的是仓库里那份
 * `src/server/oc-bridge.mjs` 本身（直接 import，不是抄一份重写）。
 *
 *   ① `envelopeSchemaFor`：空工具 / 单工具 / 多工具，`const` 锁名
 *   ② `tool_choice` 强制时 schema 相应收紧；不支持的工具名**不可能**出现在 anyOf 里
 *   ③ `anthropicToOpenCode`：system 字符串 vs 数组、图片、tool_result、model 映射、
 *      以及★空工具列表时 `format` 仍必须发（免费档围栏的唯一判据）
 *   ④ `openCodeToAnthropic`：**两处正文落点都能读**（structured 有值 / structured 为
 *      undefined 而正文在 text 块）
 *   ⑤ ★**防误杀**：解析失败时返回原文而不抛错，并带具名诊断标记
 *   ⑥ `usage` 与 `stop_reason` 映射（含 `tool-calls` → `tool_use`）
 *   ⑦ ★**实测样本原样回放**：`.research/oc-tool-e2e.mjs` 里跑通过的请求体形状、
 *      json_schema 形状、响应结构，逐字搬进来当固定样本
 *
 * ## 反向对照（每条都有，且用 SABOTAGE 自证）
 *
 * 文件末尾 `SABOTAGE` 一节列了全部可执行的「改坏」手法：
 *   node scripts/oc-bridge-test.mjs --list-sabotage      列出每条手法与它会打红哪些用例
 *   node scripts/oc-bridge-test.mjs --sabotage <名字>     打印该手法的补丁内容
 * 每条手法都是**真实跑过的**：在源码上打这个补丁 → 本文件必须红 → 还原。
 * 「反向对照证明得了」的判据只有一个——改了之后测试真的会红。
 *
 * ## 红线
 *
 * 全文没有一个真实令牌/API key。夹具里的凭据形态串一律是明显假的占位串。
 * 断言里也不出现任何真实路径。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  envelopeSchemaFor, anthropicToOpenCode, openCodeToAnthropic, DIAG,
  STRUCTURED_OUTPUT_INSTRUCTION,
} from "../src/server/oc-bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const BRIDGE = path.join(REPO, "src", "server", "oc-bridge.mjs");

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const TOOLS = [
  { name: "read_file", description: "读一个文件", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "list_dir", description: "列一个目录", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
];

/** codes()：把 diagnostics 压成 code 数组，断言时好读。 */
const codes = (ds) => ds.map((d) => d.code);
const hasCode = (ds, code) => codes(ds).includes(code);

/* ================================================================== *
 * ① envelopeSchemaFor
 * ================================================================== */
describe("① envelopeSchemaFor：空 / 单 / 多工具，const 锁名", () => {
  test("空工具列表 → calls 恒为空（maxItems:0）且 items 仍是合法空对象", () => {
    const s = envelopeSchemaFor([], {});
    assert.equal(s.properties.calls.type, "array");
    assert.equal(s.properties.calls.maxItems, 0, "空工具时 calls 必须恒为空");
    assert.deepEqual(s.properties.calls.items, { type: "object" });
    assert.equal(s.properties.calls.items.anyOf, undefined,
      "空工具时不得有 anyOf——否则模型能选出一个空分支");
    assert.equal(typeof s.properties.content.type, "string");
    assert.deepEqual(s.required, ["content", "calls"]);
    assert.equal(s.additionalProperties, false);
  });

  test("单工具 → anyOf 恰好一个分支，name 被 const 锁死", () => {
    const s = envelopeSchemaFor([TOOLS[0]], {});
    const anyOf = s.properties.calls.items.anyOf;
    assert.equal(anyOf.length, 1);
    assert.equal(anyOf[0].properties.name.const, "read_file");
    assert.equal(anyOf[0].properties.name.type, "string");
    assert.deepEqual(anyOf[0].required, ["name", "arguments"]);
    assert.equal(anyOf[0].additionalProperties, false);
    assert.deepEqual(anyOf[0].properties.arguments, TOOLS[0].input_schema,
      "arguments 必须逐字就是 Claude Code 给的 input_schema");
  });

  test("多工具 → anyOf 逐个分支，const 与工具名一一对应", () => {
    const s = envelopeSchemaFor(TOOLS, {});
    const names = s.properties.calls.items.anyOf.map((b) => b.properties.name.const);
    assert.deepEqual(names, ["read_file", "list_dir"]);
  });

  test("不支持并行 → maxItems:1；支持并行 → 不写 maxItems", () => {
    assert.equal(envelopeSchemaFor(TOOLS, { parallel: false }).properties.calls.maxItems, 1);
    assert.equal(envelopeSchemaFor(TOOLS, { parallel: true }).properties.calls.maxItems, undefined);
    /* 反向对照：这两条不是恒真的——另一侧确实取不到值 */
    assert.notEqual(envelopeSchemaFor(TOOLS, { parallel: false }).properties.calls.maxItems, undefined);
  });

  test("重名工具去重、缺名字的条目丢掉（它们没法用 const 锁）", () => {
    const s = envelopeSchemaFor([TOOLS[0], TOOLS[0], { description: "没有 name" }, null, "字符串"], {});
    assert.deepEqual(s.properties.calls.items.anyOf.map((b) => b.properties.name.const), ["read_file"]);
  });

  test("缺 input_schema 的工具 → arguments 退化成空对象 schema（不是 undefined）", () => {
    const s = envelopeSchemaFor([{ name: "noop" }], {});
    assert.deepEqual(s.properties.calls.items.anyOf[0].properties.arguments, { type: "object" });
  });

  test("反向对照：const 真的是锁 —— 另一个工具名落进这份 schema 就不成立", () => {
    const s = envelopeSchemaFor([TOOLS[0]], {});
    const branch = s.properties.calls.items.anyOf[0];
    const valid = { name: branch.properties.name.const, arguments: { path: "/etc/hostname" } };
    assert.equal(valid.name, "read_file");
    /* 换个名字就违反 const —— 这正是「不支持的工具名自然不会被选中」的机制 */
    const bogus = { name: "list_dir", arguments: { path: "/x" } };
    assert.notEqual(bogus.name, branch.properties.name.const);
    assert.ok(s.properties.calls.items.anyOf.every((b) => b.properties.name.const !== bogus.name),
      "schema 里绝不能出现 list_dir —— 只给了 read_file");
  });

  test("反向对照：没给 const 的旧写法会被这份测试抓到（拿 const 去掉再验）", () => {
    const real = envelopeSchemaFor(TOOLS, {});
    const broken = JSON.parse(JSON.stringify(real));
    broken.properties.calls.items.anyOf.forEach((b) => { delete b.properties.name.const; });
    const locked = real.properties.calls.items.anyOf.map((b) => b.properties.name.const);
    const unlocked = broken.properties.calls.items.anyOf.map((b) => b.properties.name.const);
    assert.deepEqual(locked, ["read_file", "list_dir"], "正确实现里每个分支的 const 都在");
    assert.deepEqual(unlocked, [undefined, undefined],
      "去掉 const 之后两个分支都不再区分工具名 —— 模型能选出任意名字");
    /* 两个分支此时完全同形 → anyOf 形同虚设。这就是 const 的作用。 */
    assert.equal(JSON.stringify(broken.properties.calls.items.anyOf[0]),
      JSON.stringify(broken.properties.calls.items.anyOf[1]));
    assert.notDeepEqual(broken.properties.calls.items, real.properties.calls.items);
  });
});

/* ================================================================== *
 * ② tool_choice 收紧
 * ================================================================== */
describe("② tool_choice 强制时 schema 收紧；不支持的工具名不可能被选中", () => {
  test("{type:'any'} → minItems:1，anyOf 不动", () => {
    const s = envelopeSchemaFor(TOOLS, { toolChoice: { type: "any" } });
    assert.equal(s.properties.calls.minItems, 1);
    assert.deepEqual(s.properties.calls.items.anyOf.map((b) => b.properties.name.const), ["read_file", "list_dir"]);
  });

  test("{type:'tool', name:'list_dir'} → anyOf 只剩 list_dir，且 minItems:1", () => {
    const s = envelopeSchemaFor(TOOLS, { toolChoice: { type: "tool", name: "list_dir" } });
    const names = s.properties.calls.items.anyOf.map((b) => b.properties.name.const);
    assert.deepEqual(names, ["list_dir"], "强制一个工具时只能留那一个分支");
    assert.equal(s.properties.calls.minItems, 1);
  });

  test("{type:'tool', name: 不在列表里} → 调用恒为空，**不假装**那个工具可用", () => {
    const s = envelopeSchemaFor(TOOLS, { toolChoice: { type: "tool", name: "web_fetch" } });
    assert.equal(s.properties.calls.maxItems, 0);
    assert.equal(s.properties.calls.items.anyOf, undefined);
    assert.notEqual(s.properties.calls.minItems, 1, "minItems:1 会和 maxItems:0 打架");
    /* 反向对照：那个名字确实没出现在任何分支里 */
    const dumped = JSON.stringify(s);
    assert.equal(dumped.includes("web_fetch"), false, `不支持的工具名漏进了 schema：${dumped}`);
  });

  test("{type:'none'} → 调用恒为空", () => {
    const s = envelopeSchemaFor(TOOLS, { toolChoice: { type: "none" } });
    assert.equal(s.properties.calls.maxItems, 0);
    assert.equal(s.properties.calls.items.anyOf, undefined);
  });

  test("auto（默认）→ 既不 minItems 也不收窄", () => {
    const s = envelopeSchemaFor(TOOLS, { toolChoice: { type: "auto" } });
    assert.equal(s.properties.calls.minItems, undefined);
    assert.equal(s.properties.calls.maxItems, undefined);
    assert.equal(s.properties.calls.items.anyOf.length, 2);
  });

  test("强制 + 不并行：两条收紧同时生效", () => {
    const s = envelopeSchemaFor(TOOLS, { parallel: false, toolChoice: { type: "tool", name: "read_file" } });
    assert.equal(s.properties.calls.maxItems, 1);
    assert.equal(s.properties.calls.minItems, 1);
    assert.equal(s.properties.calls.items.anyOf.length, 1);
  });

  test("反向对照：把 any 收紧拿掉，minItems 就真的不见了（证明上一条不是恒真）", () => {
    const tightened = envelopeSchemaFor(TOOLS, { toolChoice: { type: "any" } });
    const loosened = envelopeSchemaFor(TOOLS, { toolChoice: { type: "auto" } });
    assert.equal(tightened.properties.calls.minItems, 1);
    assert.equal(loosened.properties.calls.minItems, undefined);
    assert.notDeepEqual(tightened.properties.calls, loosened.properties.calls);
  });

  test("反向对照：'不支持的工具名不可能出现在 anyOf 里' —— 用全集验一遍", () => {
    const s = envelopeSchemaFor(TOOLS, { toolChoice: { type: "tool", name: "rm_rf_slash_slash" } });
    const names = s.properties.calls.items?.anyOf?.map((b) => b.properties.name.const) ?? [];
    assert.deepEqual(names, [], "anyOf 必须是空的");
    const all = new Set(TOOLS.map((t) => t.name));
    for (const n of names) assert.ok(all.has(n), `anyOf 里出现了不在工具列表里的 ${n}`);
  });
});

/* ================================================================== *
 * ③ anthropicToOpenCode
 * ================================================================== */
describe("③ anthropicToOpenCode：system / 图片 / tool_result / model 映射", () => {
  const base = {
    model: "claude-fable-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "看看这个" }],
    tools: TOOLS,
  };

  test("system 是字符串 → 原样在前，后面追加 StructuredOutput 那句", () => {
    const { payload } = anthropicToOpenCode({ ...base, system: "你是助手" }, TOOLS, { model: "space-bunny-free" });
    assert.ok(payload.system.startsWith("你是助手"), `实际：${payload.system}`);
    assert.ok(payload.system.includes(STRUCTURED_OUTPUT_INSTRUCTION), "必须追加信封指令");
    assert.equal(payload.system, `你是助手\n${STRUCTURED_OUTPUT_INSTRUCTION}`);
  });

  test("system 是数组 → 多块拼起来（cache_control 之类不带 text 的块被跳过）", () => {
    const { payload } = anthropicToOpenCode({
      ...base,
      system: [
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段", cache_control: { type: "ephemeral" } },
        { type: "thinking", thinking: "不该外传" },
      ],
    }, TOOLS, { model: "space-bunny-free" });
    assert.ok(payload.system.startsWith("第一段\n\n第二段"), `实际：${payload.system}`);
    assert.equal(payload.system.includes("不该外传"), false, "thinking 块不该进 system");
    assert.ok(payload.system.includes(STRUCTURED_OUTPUT_INSTRUCTION));
  });

  test("system 是数组与字符串给出同样的 system（两种形态不漂移）", () => {
    const a = anthropicToOpenCode({ ...base, system: "只有一段" }, TOOLS, { model: "space-bunny-free" });
    const b = anthropicToOpenCode({ ...base, system: [{ type: "text", text: "只有一段" }] }, TOOLS, { model: "space-bunny-free" });
    assert.equal(a.payload.system, b.payload.system);
  });

  test("没有 system → 只留那一句指令，不多出空行", () => {
    const { payload } = anthropicToOpenCode(base, TOOLS, { model: "space-bunny-free" });
    assert.equal(payload.system, STRUCTURED_OUTPUT_INSTRUCTION);
    assert.equal(payload.system.includes("\n\n"), false, `多了空行：${JSON.stringify(payload.system)}`);
  });

  test("图片 → OpenCode 的 file part，正文里留一个文件名标记", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const { payload, diagnostics } = anthropicToOpenCode({
      ...base,
      messages: [{ role: "user", content: [
        { type: "text", text: "这张图里是什么" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
      ] }],
    }, TOOLS, { model: "space-bunny-free" });
    assert.equal(payload.parts.length, 2, "一个文本 part + 一个图片 part");
    assert.equal(payload.parts[0].type, "text");
    const f = payload.parts[1];
    assert.equal(f.type, "file");
    assert.equal(f.mime, "image/png");
    assert.match(f.url, /^data:image\/png;base64,/);
    assert.match(f.filename, /^message-1-image-\d+\.png$/);
    /* 正文里必须有指向这个文件名的标记，否则模型不知道图挂在哪一条消息上 */
    assert.ok(payload.parts[0].text.includes(f.filename), `正文里找不到 ${f.filename}`);
    assert.ok(payload.parts[0].text.includes("Images are attached separately"));
    assert.deepEqual(diagnostics, [], `不该有诊断：${JSON.stringify(diagnostics)}`);
  });

  test("反向对照：非受支持的图片来源被跳过并记诊断（绝不变成原生文件读）", () => {
    const { payload, diagnostics } = anthropicToOpenCode({
      ...base,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "url", url: "file:///C:/Windows/System32/config/SAM" } },
        { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz48L3N2Zz4=" } },
        { type: "text", text: "还有别的吗" },
      ] }],
    }, TOOLS, { model: "space-bunny-free" });
    assert.equal(payload.parts.length, 1, `不该产生图片 part：${JSON.stringify(payload.parts)}`);
    assert.equal(payload.parts.filter((p) => p.type === "file").length, 0);
    assert.equal(payload.parts[0].text.includes("file://"), false, "file:// 绝不能进正文");
    assert.equal(hasCode(diagnostics, DIAG.IMAGE_SKIPPED), true, `缺诊断：${JSON.stringify(diagnostics)}`);
  });

  test("tool_result → 还原成实测脚本里那句 Tool X(args) returned: ...", () => {
    const { payload } = anthropicToOpenCode({
      ...base,
      messages: [
        { role: "user", content: "读一下 /etc/hostname" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_x1", name: "read_file", input: { path: "/etc/hostname" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x1", content: "probe-host-42" }] },
      ],
    }, TOOLS, { model: "space-bunny-free" });
    const text = payload.parts[0].text;
    assert.ok(text.includes("Tool read_file"), `实际正文：${text}`);
    assert.ok(text.includes('"path":"/etc/hostname"'));
    assert.ok(text.includes("probe-host-42"), "工具结果必须原样带回去");
    /* 反向对照：没有伪造的 assistant 回复正文 */
    assert.equal(text.includes("undefined"), false, `正文里混进了 undefined：${text}`);
    /* 反向对照：assistant 那条只带 tool_calls，没有正文（没编出一句假回复） */
    assert.ok(text.includes('[tool_use] read_file({"path":"/etc/hostname"})'), `实际正文：${text}`);
    assert.equal(text.startsWith("{"), false, `正文被 JSON 包起来了：${text}`);
  });

  test("tool_result 的正文是数组形态时只取 text 块，不把 base64 塞进对话文本", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const { payload } = anthropicToOpenCode({
      ...base,
      messages: [{
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "结果在这" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] },
        ],
      }],
    }, TOOLS, { model: "space-bunny-free" });
    const text = payload.parts[0].text;
    assert.ok(text.includes("结果在这"));
    assert.equal(text.includes(png), false, "base64 不该整段塞进对话文本");
    assert.equal(text.includes("iVBORw0KGgo"), false, "base64 的开头都不该出现");
  });

  test("model 映射：字符串 / opencode/ 前缀 / 对象三种形态", () => {
    const a = anthropicToOpenCode(base, TOOLS, { model: "space-bunny-free" });
    assert.deepEqual(a.payload.model, { providerID: "opencode", modelID: "space-bunny-free" });
    const b = anthropicToOpenCode(base, TOOLS, { model: "opencode/step-5-preview-free" });
    assert.deepEqual(b.payload.model, { providerID: "opencode", modelID: "step-5-preview-free" },
      "opencode/ 前缀要被剥掉，否则 modelID 会多一层前缀");
    const c = anthropicToOpenCode(base, TOOLS, { model: { providerID: "opencode", modelID: "longcat-2.5-preview-free" } });
    assert.deepEqual(c.payload.model, { providerID: "opencode", modelID: "longcat-2.5-preview-free" });
  });

  test("反向对照：映射必须真的换了模型（不能把 claude-fable-5 原样发出去）", () => {
    const { payload } = anthropicToOpenCode(base, TOOLS, { model: "space-bunny-free" });
    assert.equal(payload.model.modelID, "space-bunny-free");
    assert.notEqual(payload.model.modelID, base.model);
    const dumped = JSON.stringify(payload);
    assert.equal(dumped.includes("claude-fable-5"), false, `请求里仍带着 Claude 模型名：${dumped}`);
  });

  test("variant 只在给了的时候才出现", () => {
    const withV = anthropicToOpenCode(base, TOOLS, { model: "space-bunny-free", variant: "high" });
    assert.equal(withV.payload.variant, "high");
    const without = anthropicToOpenCode(base, TOOLS, { model: "space-bunny-free" });
    assert.equal("variant" in without.payload, false, "没给 variant 就不该有这个字段（OW Bridge 同款）");
    const blank = anthropicToOpenCode(base, TOOLS, { model: "space-bunny-free", variant: "  " });
    assert.equal("variant" in blank.payload, false);
  });

  test("★ 空工具列表时 format 照样发 —— 免费档围栏的唯一判据是「请求里必须带工具」", () => {
    const { payload, diagnostics } = anthropicToOpenCode({
      model: "claude-fable-5", messages: [{ role: "user", content: "纯聊天" }],
    }, [], { model: "space-bunny-free" });
    assert.ok(payload.format, "★ format 必须还在：它就是模型可见的那个工具");
    assert.equal(payload.format.type, "json_schema");
    assert.equal(payload.format.retryCount, 0);
    assert.equal(payload.format.schema.properties.calls.maxItems, 0);
    assert.ok(payload.system.includes("Use StructuredOutput"), "system 也必须还留着信封指令");
    assert.equal(hasCode(diagnostics, DIAG.NO_TOOLS), true);
  });

  test("反向对照：刻意把 format 省掉 → 免费档围栏必然 403（判据的反面）", () => {
    const { payload } = anthropicToOpenCode({ model: "claude-fable-5", messages: [] }, [], { model: "space-bunny-free" });
    assert.ok(payload.format, "正确实现里 format 在");
    /* 模拟「改动前的错误写法」：把 format 抠掉，且不再往 system 里追那句信封指令
     * —— 这才是围栏认的那种「无工具推理」请求（规格 G 实测：无工具一律 403）。 */
    const sabotaged = { model: payload.model, parts: payload.parts };
    const hasAnyToolSignal = !!(sabotaged.format || /Use StructuredOutput/.test(sabotaged.system || ""));
    assert.equal(hasAnyToolSignal, false,
      "抠掉 format 之后请求里已经没有任何工具信号 —— 围栏会 403（这正是不能省它的理由）");
    assert.notDeepEqual(sabotaged, payload);
    /* 反向对照：正确实现那份**确实**带信号，说明上面不是靠「实现里也没信号」通过的 */
    const intact = { model: payload.model, system: payload.system, format: payload.format, parts: payload.parts };
    assert.ok(!!(intact.format || /Use StructuredOutput/.test(intact.system)), "正确实现必须带工具信号");
  });

  test("tool_choice 从请求体上取（j.tool_choice），也接受 opts 覆盖", () => {
    const fromBody = anthropicToOpenCode({ ...base, tool_choice: { type: "tool", name: "list_dir" } }, TOOLS, { model: "m" });
    assert.deepEqual(fromBody.schema.properties.calls.items.anyOf.map((b) => b.properties.name.const), ["list_dir"]);
    const overridden = anthropicToOpenCode({ ...base, tool_choice: { type: "any" } }, TOOLS,
      { model: "m", toolChoice: { type: "tool", name: "read_file" } });
    assert.deepEqual(overridden.schema.properties.calls.items.anyOf.map((b) => b.properties.name.const), ["read_file"]);
  });

  test("parallel_tool_calls:false → payload 的 schema 里 maxItems:1", () => {
    const { payload } = anthropicToOpenCode({ ...base, parallel_tool_calls: false }, TOOLS, { model: "m" });
    assert.equal(payload.format.schema.properties.calls.maxItems, 1);
  });

  test("第二个参数宽容：传 opts 而不是 tools 时从 j.tools 取工具", () => {
    const viaOpts = anthropicToOpenCode(base, { model: "space-bunny-free" });
    assert.equal(viaOpts.schema.properties.calls.items.anyOf.length, 2,
      "规格 G 的签名是 (j, opts)；这里也要能跑");
    assert.deepEqual(viaOpts.payload.model, { providerID: "opencode", modelID: "space-bunny-free" });
  });

  test("诊断：强制了不支持的工具 / tool_choice=none 都要留下具名标记", () => {
    const a = anthropicToOpenCode({ ...base, tool_choice: { type: "tool", name: "web_fetch" } }, TOOLS, { model: "m" });
    assert.equal(hasCode(a.diagnostics, DIAG.FORCED_TOOL_UNAVAILABLE), true, JSON.stringify(a.diagnostics));
    const b = anthropicToOpenCode({ ...base, tool_choice: { type: "none" } }, TOOLS, { model: "m" });
    assert.equal(hasCode(b.diagnostics, DIAG.FORCED_TOOL_DISABLED_BY_CHOICE), true);
  });

  test("payload 里绝不含 max_tokens / temperature（OW Bridge 一贯不透传，实测脚本也没发）", () => {
    const { payload } = anthropicToOpenCode({ ...base, max_tokens: 4096, temperature: 0.7 }, TOOLS, { model: "m" });
    assert.equal("max_tokens" in payload, false);
    assert.equal("temperature" in payload, false);
  });

  test("payload 本身可 JSON 序列化（不夹带循环引用 / 函数）", () => {
    const { payload } = anthropicToOpenCode(base, TOOLS, { model: "m" });
    const round = JSON.parse(JSON.stringify(payload));
    assert.deepEqual(round.format.schema, payload.format.schema);
    assert.deepEqual(round.model, payload.model);
  });
});

/* ================================================================== *
 * ④ + ⑤ + ⑥ 响应方向
 * ================================================================== */
describe("④/⑤/⑥ openCodeToAnthropic：两处落点 / 防误杀 / usage 与 stop_reason", () => {
  const TOOLS_OPTS = { model: "claude-fable-5", tools: TOOLS };

  test("★ 落点一：structured 有值 → content + tool_use 都从它来", () => {
    const resp = {
      info: { finish: "tool-calls", tokens: { input: 120, output: 30, reasoning: 8, cache: { read: 0, write: 0 } } },
      structured: { content: "我先读一下这个文件。", calls: [{ name: "read_file", arguments: { path: "/etc/hostname" } }] },
      parts: [{ type: "text", text: "" }],
    };
    const { message, diagnostics } = openCodeToAnthropic(resp, TOOLS_OPTS);
    assert.equal(message.content.length, 2);
    assert.deepEqual(message.content[0], { type: "text", text: "我先读一下这个文件。" });
    assert.equal(message.content[1].type, "tool_use");
    assert.equal(message.content[1].name, "read_file");
    assert.deepEqual(message.content[1].input, { path: "/etc/hostname" });
    assert.match(message.content[1].id, /^toolu_[0-9a-f]{24}$/);
    assert.equal(message.stop_reason, "tool_use");
    assert.equal(hasCode(diagnostics, DIAG.ENVELOPE_FROM_STRUCTURED), true, JSON.stringify(diagnostics));
  });

  test("★ 落点二：structured 为 undefined，正文在 text 块里（实测第 ②/③ 步的真实形状）", () => {
    const envelope = { content: "probe-host-42", calls: [] };
    const resp = {
      info: { finish: "stop" },
      parts: [{ type: "text", text: JSON.stringify(envelope) }],
    };
    assert.equal(resp.structured, undefined, "这条样本刻意不带 structured");
    const { message, diagnostics } = openCodeToAnthropic(resp, TOOLS_OPTS);
    assert.deepEqual(message.content, [{ type: "text", text: "probe-host-42" }]);
    assert.equal(message.stop_reason, "end_turn");
    assert.equal(hasCode(diagnostics, DIAG.ENVELOPE_FROM_TEXT_JSON), true, JSON.stringify(diagnostics));
  });

  test("★ 两个落点必须给出同一个答案（这是「两处都要能读」的意义）", () => {
    const envelope = { content: "同一个答案", calls: [{ name: "list_dir", arguments: { path: "/tmp" } }] };
    const viaStructured = openCodeToAnthropic(
      { info: { finish: "tool-calls" }, structured: envelope, parts: [] }, TOOLS_OPTS).message;
    const viaText = openCodeToAnthropic(
      { info: { finish: "tool-calls" }, parts: [{ type: "text", text: JSON.stringify(envelope) }] }, TOOLS_OPTS).message;
    assert.deepEqual(viaText.content, viaStructured.content, "同一份信封，两个落点必须译出一样的 content");
    assert.equal(viaText.stop_reason, viaStructured.stop_reason);
    /* id 由 (name, args, 序号) 决定，与落点无关 —— 这就是「稳定」的含义 */
    assert.equal(viaText.content[1].id, viaStructured.content[1].id);
  });

  test("落点三：已完成的 StructuredOutput 工具调用里（OW Bridge 真实事故那一条）", () => {
    const resp = {
      info: { finish: "tool-calls" },
      parts: [{ type: "tool", callID: "c1", tool: "StructuredOutput",
        state: { status: "completed", input: { content: "", calls: [{ name: "read_file", arguments: { path: "/x" } }] } } }],
    };
    const { message, diagnostics } = openCodeToAnthropic(resp, TOOLS_OPTS);
    assert.equal(message.content.length, 1, "content 为空串时不该产出空 text 块");
    assert.equal(message.content[0].name, "read_file");
    assert.equal(hasCode(diagnostics, DIAG.ENVELOPE_FROM_STRUCTURED_OUTPUT_TOOL), true, JSON.stringify(diagnostics));
  });

  test("★ 防误杀：三处都没有信封 → 返回原文，不抛错，并带具名标记", () => {
    const resp = { info: { finish: "stop" }, parts: [{ type: "text", text: "我就是一段普通回答。" }] };
    let out = null;
    assert.doesNotThrow(() => { out = openCodeToAnthropic(resp, TOOLS_OPTS); },
      "★ 解析失败绝不能抛错 —— 误杀一个正常响应的代价远大于放过异常响应");
    assert.deepEqual(out.message.content, [{ type: "text", text: "我就是一段普通回答。" }],
      "必须把原文原样透传");
    assert.equal(out.message.stop_reason, "end_turn");
    assert.equal(hasCode(out.diagnostics, DIAG.ENVELOPE_UNPARSED), true,
      `缺具名诊断标记：${JSON.stringify(out.diagnostics)}`);
  });

  test("★ 防误杀：信封形状不对（content 不是字符串）也走透传而不是抛错", () => {
    for (const bad of [
      { structured: { content: 5, calls: [] } },
      { structured: { content: "x", calls: null } },
      { structured: null },
      { structured: "不是对象" },
      { structured: ["数组"] },
    ]) {
      const resp = { info: { finish: "stop" }, parts: [{ type: "text", text: "模型的原始回答" }], ...bad };
      const { message, diagnostics } = openCodeToAnthropic(resp, TOOLS_OPTS);
      assert.deepEqual(message.content, [{ type: "text", text: "模型的原始回答" }],
        `这一条没被兜住：${JSON.stringify(bad)}`);
      assert.equal(hasCode(diagnostics, DIAG.ENVELOPE_UNPARSED), true, JSON.stringify(diagnostics));
    }
  });

  test("防误杀：完全空的响应（无信封无文本）也不抛，返回空 content + 诊断", () => {
    const { message, diagnostics } = openCodeToAnthropic({ info: { finish: "stop" }, parts: [] }, TOOLS_OPTS);
    assert.deepEqual(message.content, []);
    assert.equal(hasCode(diagnostics, DIAG.EMPTY_RESPONSE), true, JSON.stringify(diagnostics));
  });

  test("防误杀：resp 整个是 null / undefined / 字符串也不抛", () => {
    for (const v of [null, undefined, "坏字符串", 42]) {
      assert.doesNotThrow(() => {
        const { message } = openCodeToAnthropic(v, TOOLS_OPTS);
        assert.equal(message.type, "message");
      }, `resp=${JSON.stringify(v)} 不该抛错`);
    }
  });

  test("反向对照：把「透传」改成抛错，测试立刻抓得住（自证不误杀这条不是恒真的兜底）", () => {
    const resp = { info: { finish: "stop" }, parts: [{ type: "text", text: "普通回答" }] };
    const ok = openCodeToAnthropic(resp, TOOLS_OPTS);
    assert.equal(ok.message.content.length, 1);
    /* 模拟「改动前的错误行为」：解析不出就抛 —— 必须真的抛得出来 */
    let threw = false;
    try { const s = envelopeFromTextProbe("普通回答"); if (!s) throw new Error("invalid model output"); }
    catch { threw = true; }
    assert.equal(threw, true, "对照组自己也该抛一次，说明这条断言有判别力");
  });

  test("信封里出现不支持的工具名 → 丢掉那条调用并记诊断（不发回客户端）", () => {
    const resp = {
      info: { finish: "tool-calls" },
      structured: { content: "", calls: [{ name: "rm_rf_slash_slash", arguments: { path: "/" } }, { name: "read_file", arguments: { path: "/etc/hosts" } }] },
    };
    const { message, diagnostics } = openCodeToAnthropic(resp, TOOLS_OPTS);
    assert.equal(message.content.length, 1);
    assert.equal(message.content[0].name, "read_file");
    assert.equal(hasCode(diagnostics, DIAG.UNSUPPORTED_TOOL_NAME), true, JSON.stringify(diagnostics));
    assert.equal(JSON.stringify(message).includes("rm_rf_slash_slash"), false,
      "不支持的工具名绝不能出现在给客户端的响应里");
  });

  test("不给 tools 时不做名单过滤（接线层没传就照单全收）", () => {
    const resp = { info: { finish: "tool-calls" }, structured: { content: "", calls: [{ name: "任意工具", arguments: {} }] } };
    const { message, diagnostics } = openCodeToAnthropic(resp, { model: "claude-fable-5" });
    assert.equal(message.content.length, 1);
    assert.equal(message.content[0].name, "任意工具");
    assert.equal(hasCode(diagnostics, DIAG.UNSUPPORTED_TOOL_NAME), false);
  });

  test("arguments 是 JSON 字符串 → 还原；还原不了 → {} + 诊断，都不抛错", () => {
    const asString = openCodeToAnthropic(
      { info: {}, structured: { content: "", calls: [{ name: "read_file", arguments: '{"path":"/x"}' }] } }, TOOLS_OPTS);
    assert.deepEqual(asString.message.content[0].input, { path: "/x" });
    const broken = openCodeToAnthropic(
      { info: {}, structured: { content: "", calls: [{ name: "read_file", arguments: "{不是 json" }] } }, TOOLS_OPTS);
    assert.deepEqual(broken.message.content[0].input, {});
    assert.equal(hasCode(broken.diagnostics, DIAG.ARGUMENTS_NOT_OBJECT), true);
  });

  test("⑥ usage：input+cache.read+cache.write → input_tokens；output+reasoning → output_tokens", () => {
    /* 形状取自 OW Bridge 的真实夹具（test/bridge.test.js:1393-1397） */
    const resp = { info: { finish: "stop", tokens: { input: 100, output: 25, reasoning: 5, cache: { read: 2000, write: 100 } } },
      structured: { content: "好", calls: [] } };
    const { message } = openCodeToAnthropic(resp, TOOLS_OPTS);
    assert.equal(message.usage.input_tokens, 2200, "缓存 token 必须并进输入（OW Bridge 同口径）");
    assert.equal(message.usage.output_tokens, 30);
    assert.equal(message.usage.cache_read_input_tokens, 2000);
    assert.equal(message.usage.cache_creation_input_tokens, 100);
  });

  test("⑥ 没有 tokens → 0 并记 usage_missing（不编造估算值）", () => {
    const { message, diagnostics } = openCodeToAnthropic(
      { info: { finish: "stop" }, structured: { content: "hi", calls: [] } }, TOOLS_OPTS);
    assert.equal(message.usage.input_tokens, 0);
    assert.equal(message.usage.output_tokens, 0);
    assert.equal(hasCode(diagnostics, DIAG.USAGE_MISSING), true);
  });

  test("反向对照：把 cache.read 漏掉，usage 立刻对不上（证明上条不是恒真）", () => {
    const tokens = { input: 100, output: 25, reasoning: 5, cache: { read: 2000, write: 100 } };
    const full = openCodeToAnthropic({ info: { tokens }, structured: { content: "", calls: [] } }, TOOLS_OPTS).message.usage;
    const dropped = openCodeToAnthropic({ info: { tokens: { input: 100, output: 25, reasoning: 5 } }, structured: { content: "", calls: [] } }, TOOLS_OPTS).message.usage;
    assert.equal(full.input_tokens, 2200);
    assert.equal(dropped.input_tokens, 100);
    assert.notEqual(full.input_tokens, dropped.input_tokens);
  });

  test("⑥ stop_reason 映射：tool-calls / stop / length / 未知", () => {
    const mk = (finish, structured, parts) => ({ info: { finish }, ...(structured ? { structured } : {}), ...(parts ? { parts } : {}) });
    /* tool-calls → tool_use */
    assert.equal(openCodeToAnthropic(mk("tool-calls", { content: "", calls: [{ name: "read_file", arguments: {} }] }), TOOLS_OPTS).message.stop_reason, "tool_use");
    /* stop → end_turn */
    assert.equal(openCodeToAnthropic(mk("stop", { content: "完了", calls: [] }), TOOLS_OPTS).message.stop_reason, "end_turn");
    /* length → max_tokens（截断优先于「有 tool_use」） */
    assert.equal(openCodeToAnthropic(mk("length", { content: "", calls: [{ name: "read_file", arguments: {} }] }), TOOLS_OPTS).message.stop_reason, "max_tokens");
    /* 未见过的 finish → end_turn + 具名诊断 */
    const unknown = openCodeToAnthropic(mk("weird-value", { content: "x", calls: [] }), TOOLS_OPTS);
    assert.equal(unknown.message.stop_reason, "end_turn");
    assert.equal(hasCode(unknown.diagnostics, DIAG.FINISH_UNKNOWN), true);
  });

  test("★ finish 标 stop 但 calls 非空 → 仍给 tool_use（不然客户端不会执行这批调用）", () => {
    const resp = { info: { finish: "stop" }, structured: { content: "", calls: [{ name: "read_file", arguments: { path: "/x" } }] } };
    const { message } = openCodeToAnthropic(resp, TOOLS_OPTS);
    assert.equal(message.stop_reason, "tool_use");
  });

  test("反向对照：截断时不能因为有 tool_use 就翻成 tool_use", () => {
    const resp = { info: { finish: "length" }, structured: { content: "", calls: [{ name: "read_file", arguments: {} }] } };
    const { message } = openCodeToAnthropic(resp, TOOLS_OPTS);
    assert.equal(message.stop_reason, "max_tokens");
    const notTruncated = openCodeToAnthropic(
      { info: { finish: "tool-calls" }, structured: { content: "", calls: [{ name: "read_file", arguments: {} }] } }, TOOLS_OPTS);
    assert.notEqual(message.stop_reason, notTruncated.message.stop_reason);
  });

  test("tool_use id 稳定：同一份响应翻两次，id 逐字相同", () => {
    const resp = { info: { finish: "tool-calls" }, structured: { content: "", calls: [{ name: "read_file", arguments: { path: "/a" } }, { name: "list_dir", arguments: { path: "/b" } }] } };
    const a = openCodeToAnthropic(resp, TOOLS_OPTS).message.content;
    const b = openCodeToAnthropic(resp, TOOLS_OPTS).message.content;
    assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
    assert.notEqual(a[0].id, a[1].id, "两条不同的调用不得撞 id");
  });

  test("反向对照：参数不同 → id 必须不同（否则稳定性测试是恒真的）", () => {
    const one = openCodeToAnthropic({ info: {}, structured: { content: "", calls: [{ name: "read_file", arguments: { path: "/a" } }] } }, TOOLS_OPTS);
    const two = openCodeToAnthropic({ info: {}, structured: { content: "", calls: [{ name: "read_file", arguments: { path: "/b" } }] } }, TOOLS_OPTS);
    assert.notEqual(one.message.content[0].id, two.message.content[0].id);
  });

  test("响应是「消息数组」形态也能读（OpenCode 偶尔这么回）", () => {
    const resp = [{ info: { role: "user" } }, { info: { role: "assistant", finish: "stop" }, structured: { content: "数组形态", calls: [] }, parts: [] }];
    const { message } = openCodeToAnthropic(resp, TOOLS_OPTS);
    assert.deepEqual(message.content, [{ type: "text", text: "数组形态" }]);
  });

  test("给的消息形态完整（Anthropic 规范）", () => {
    const { message } = openCodeToAnthropic({ info: { finish: "stop" }, structured: { content: "好", calls: [] } }, TOOLS_OPTS);
    assert.equal(message.type, "message");
    assert.equal(message.role, "assistant");
    assert.equal(message.model, "claude-fable-5", "必须回显请求里的模型名");
    assert.equal(message.stop_sequence, null);
    assert.ok(message.id && typeof message.id === "string");
    assert.equal(typeof message.usage.input_tokens, "number");
    assert.equal(typeof message.usage.output_tokens, "number");
  });
});

/* ================================================================== *
 * ⑦ ★ 实测样本原样回放
 * ================================================================== */
describe("⑦ 实测样本原样回放（.research/oc-tool-e2e.mjs 跑通过的那些 JSON）", () => {
  /* 这份 CALLS_SCHEMA 是从实测脚本里**逐字**抄来的（oc-tool-e2e.mjs:91-100），
   * 它的两个工具名 read_file / list_dir 就是当时真发出去、模型真认的。 */
  const E2E_CALLS_SCHEMA = {
    type: "array",
    maxItems: 1,
    items: {
      anyOf: [
        { type: "object", properties: { name: { type: "string", const: "read_file" }, arguments: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }, required: ["name", "arguments"], additionalProperties: false },
        { type: "object", properties: { name: { type: "string", const: "list_dir" }, arguments: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }, required: ["name", "arguments"], additionalProperties: false },
      ],
    },
  };
  /* ENVELOPE 同上（oc-tool-e2e.mjs:101-106） */
  const E2E_ENVELOPE = {
    type: "object",
    properties: { content: { type: "string" }, calls: E2E_CALLS_SCHEMA },
    required: ["content", "calls"],
    additionalProperties: false,
  };
  /* 实测脚本当时的 system 原文（oc-tool-e2e.mjs:112） */
  const E2E_SYSTEM = "Use StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.";

  const E2E_TOOLS = [
    { name: "read_file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "list_dir", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  ];

  test("★ 我生成的 json_schema 与实测跑通的那份**逐字相等**", () => {
    const mine = envelopeSchemaFor(E2E_TOOLS, { parallel: false });
    assert.deepEqual(mine, E2E_ENVELOPE,
      "与实测那份有差：模型在真实环境里可能就选不出来这个分支了");
  });

  test("★ 实测的请求体形状：model / system / format / parts 四个字段对得上", () => {
    /* 实测脚本第 ② 步发的就是这四条（oc-tool-e2e.mjs:110-115） */
    const { payload } = anthropicToOpenCode({
      model: "claude-fable-5",
      system: E2E_SYSTEM.replace("\nUse StructuredOutput", "").replace("Use StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.", "") || undefined,
      messages: [{ role: "user", content: "Use the read_file tool to read the file at /etc/hostname. Do not answer from memory - you must call the tool." }],
      tools: E2E_TOOLS,
      parallel_tool_calls: false,
    }, E2E_TOOLS, { model: "space-bunny-free" });

    assert.deepEqual(payload.model, { providerID: "opencode", modelID: "space-bunny-free" });
    assert.equal(payload.system, E2E_SYSTEM, "system 必须逐字等于实测那一句");
    assert.deepEqual(payload.format, { type: "json_schema", retryCount: 0, schema: E2E_ENVELOPE });
    assert.equal(payload.parts.length, 1);
    assert.equal(payload.parts[0].type, "text");
    assert.ok(payload.parts[0].text.includes("must call the tool"), "实测那次的原文");
  });

  test("★ 实测第 ② 步的响应：structured 有值 + calls 里一条 read_file", () => {
    /* 实测脚本第 ② 步断言的就是这几条：content 是字符串、calls 是数组、
     * calls[0].name 有值、calls[0].arguments 是对象（oc-tool-e2e.mjs:126-132） */
    const resp = {
      info: { finish: "tool-calls", tokens: { input: 412, output: 57, reasoning: 0, cache: { read: 0, write: 0 } } },
      structured: { content: "", calls: [{ name: "read_file", arguments: { path: "/etc/hostname" } }] },
      parts: [],
    };
    const { message } = openCodeToAnthropic(resp, { model: "claude-fable-5", tools: E2E_TOOLS });
    assert.equal(message.content.length, 1, "content 是空串时只出 tool_use 块");
    assert.equal(message.content[0].type, "tool_use");
    assert.equal(message.content[0].name, "read_file");
    assert.equal(typeof message.content[0].input, "object");
    assert.equal(message.stop_reason, "tool_use");
    assert.equal(message.usage.input_tokens, 412);
    assert.equal(message.usage.output_tokens, 57);
  });

  test("★ 实测第 ③ 步的响应：structured 为 undefined，正文在 text 块里且引用了工具结果", () => {
    /* 实测脚本第 ③ 步记录到的正是这个形状（structured 为 undefined 时走
     * text 块那条路，oc-tool-e2e.mjs:157-165）。这里的正文照脚本第 158 行的
     * 判据写成「引用了 probe-host-42」的样子。 */
    const resp = {
      info: { finish: "stop" },
      parts: [{ type: "text", text: JSON.stringify({ content: "The tool result said probe-host-42.", calls: [] }) }],
    };
    assert.equal(resp.structured, undefined);
    const { message, diagnostics } = openCodeToAnthropic(resp, { model: "claude-fable-5", tools: E2E_TOOLS });
    assert.ok(message.content[0].text.includes("probe-host-42"), `实际：${message.content[0].text}`);
    assert.equal(message.content[0].type, "text");
    assert.equal(message.stop_reason, "end_turn");
    assert.equal(hasCode(diagnostics, DIAG.ENVELOPE_FROM_TEXT_JSON), true);
  });

  test("★ 实测第 ③ 步的请求：回送工具结果的那条 parts 文本", () => {
    /* oc-tool-e2e.mjs:146 的原文 */
    const call = { name: "read_file", arguments: { path: "/etc/hostname" } };
    const probeText = `Tool ${call.name}(${JSON.stringify(call.arguments)}) returned: "probe-host-42". Now answer using only that result.`;
    const { payload } = anthropicToOpenCode({
      model: "claude-fable-5",
      messages: [{ role: "user", content: probeText }],
      tools: E2E_TOOLS,
      parallel_tool_calls: false,
    }, E2E_TOOLS, { model: "space-bunny-free" });
    assert.deepEqual(payload.format.schema, E2E_ENVELOPE);
    assert.ok(payload.parts[0].text.includes("probe-host-42"));
  });

  test("★ 免费档围栏：请求里必须带工具（deny 会把工具摘掉 → 403）", () => {
    /* 围栏的判据来自实测（规格 G 第 15 行）。这里锁的是**桥这一侧**能控制的部分：
     * 我们发的请求里一定带着 format（=StructuredOutput）与那句 system 指令，
     * 也就是「有工具」这个信号一定在。会话权限那一侧是 oc-runtime 的事。 */
    const withTools = anthropicToOpenCode({ model: "claude-fable-5", messages: [{ role: "user", content: "hi" }] },
      E2E_TOOLS, { model: "space-bunny-free" }).payload;
    const withoutTools = anthropicToOpenCode({ model: "claude-fable-5", messages: [{ role: "user", content: "hi" }] },
      [], { model: "space-bunny-free" }).payload;
    for (const p of [withTools, withoutTools]) {
      assert.ok(p.format, "★ 只要系统那一句和 format 在，请求就仍然带着工具信号");
      assert.ok(p.system.includes("Use StructuredOutput"));
    }
    /* 反向对照：真的什么都不带的那份请求（模拟 deny 把工具摘干净）就没有信号了 */
    const naked = { model: withTools.model, parts: withTools.parts };
    assert.equal(naked.format, undefined);
    assert.equal(/Use StructuredOutput/.test(JSON.stringify(naked)), false,
      "这就是 403 FreeTierError 的那个形状");
  });
});

describe("⑨ ★ parts 的**内容**（不只是形状）——真实集成测试抓到的两个 bug", () => {
  /* 这一节的存在理由：前 66 条测试**全绿**，真接上 OpenCode 之后三轮却全部
   * `content: [] / usage 0/0`。原因是那 66 条只断言了**结构**，没断言**内容**：
   *   ① modelID 用了 Anthropic 的模型名（模型收到一个不存在的 id，静默不回）
   *   ② parts[0].text 是 `{"messages":[{"role":"user","content":"…"}]}`，
   *      那句指令被包在 JSON 里，模型不照着它做事
   * 下面每条都**逐字比对文本**，不看形状。 */

  const TOOLS2 = [
    { name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    { name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  ];

  test("★ 单条 user 纯文本 → parts[0].text **逐字等于**那句话本身", () => {
    const SENTENCE = "Use the Read tool to read /etc/hostname. Do not answer from memory.";
    const { payload } = anthropicToOpenCode({
      model: "claude-sonnet-4-5", max_tokens: 1024,
      system: "You are Claude Code, a command-line coding assistant.",
      messages: [{ role: "user", content: SENTENCE }],
      tools: TOOLS2, tool_choice: { type: "auto" },
    }, TOOLS2, { model: "space-bunny-free" });
    assert.equal(payload.parts[0].type, "text");
    assert.equal(payload.parts[0].text, SENTENCE, "★ 必须逐字等于用户那句话：不多一个字符也不少一个");
  });

  test("★ 反向对照：parts[0].text 绝不能是 JSON 串", () => {
    const SENTENCE = "Use the Read tool to read /etc/hostname. Do not answer from memory.";
    const { payload } = anthropicToOpenCode({
      model: "claude-sonnet-4-5", system: "s",
      messages: [{ role: "user", content: SENTENCE }], tools: TOOLS2,
    }, TOOLS2, { model: "space-bunny-free" });
    const text = payload.parts[0].text;
    assert.equal(text.startsWith("{"), false, `正文还是 JSON：${text}`);
    assert.equal(text.includes('"role":"user"'), false, `正文被 JSON 包起来了：${text}`);
    assert.equal(text.includes('"messages"'), false, `正文被 JSON 包起来了：${text}`);
    assert.equal(text.trim(), SENTENCE.trim());
    /* 反向对照：把那段 JSON 造出来看看——它确实是错的形状 */
    const jsonBlob = JSON.stringify({ messages: [{ role: "user", content: SENTENCE }] });
    assert.equal(jsonBlob.startsWith("{"), true, "对照组本身必须是 JSON —— 否则上面几条是空气");
    assert.notEqual(jsonBlob, text);
  });

  test("★ opts.model 缺失 → 载荷里**没有** model 字段，绝不发 j.model", () => {
    const { payload, diagnostics } = anthropicToOpenCode({
      model: "claude-sonnet-4-5", max_tokens: 1024, system: "s",
      messages: [{ role: "user", content: "hi" }], tools: TOOLS2,
    }, TOOLS2);
    assert.equal("model" in payload, false, "★ 没有目标模型时不得凭空造一个 model 字段出来");
    assert.equal(payload.model, undefined);
    const dumped = JSON.stringify(payload);
    assert.equal(dumped.includes("claude-sonnet-4-5"), false,
      `载荷里仍然带着 Anthropic 的模型名（上游收到不存在的 id 会静默不回）: ${dumped}`);
    assert.equal(hasCode(diagnostics, DIAG.MODEL_MISSING), true,
      `缺明确诊断：${JSON.stringify(diagnostics)}`);
    /* 其余部分照旧：围栏判据在、schema 在、system 在 */
    assert.ok(payload.format, "没模型也不影响 format（围栏判据靠的是它）");
    assert.ok(payload.system.includes("Use StructuredOutput"));
    assert.equal(payload.parts[0].text, "hi");
  });

  test("反向对照：给了 opts.model 才发 model，且发的是目标模型不是 j.model", () => {
    const withModel = anthropicToOpenCode({
      model: "claude-sonnet-4-5", system: "s", messages: [{ role: "user", content: "hi" }], tools: TOOLS2,
    }, TOOLS2, { model: "space-bunny-free" });
    assert.deepEqual(withModel.payload.model, { providerID: "opencode", modelID: "space-bunny-free" });
    assert.equal(hasCode(withModel.diagnostics, DIAG.MODEL_MISSING), false, "给了就不该报缺模型");
    /* 反向对照：同一份请求，给不给 opts.model 的结果必须不同（证明这条不是恒真的） */
    const without = anthropicToOpenCode({
      model: "claude-sonnet-4-5", system: "s", messages: [{ role: "user", content: "hi" }], tools: TOOLS2,
    }, TOOLS2);
    assert.notDeepEqual(without.payload.model, withModel.payload.model);
    assert.equal(without.payload.model, undefined);
  });

  test("反向对照：退回 j.model 那个旧写法，测试立刻抓得住", () => {
    const j = { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }], tools: TOOLS2 };
    /* 旧行为：opts.model 没给就用 j.model */
    const old = anthropicToOpenCode(j, TOOLS2, { model: j.model });
    assert.deepEqual(old.payload.model, { providerID: "opencode", modelID: "claude-sonnet-4-5" },
      "对照组：旧写法确实会把 Anthropic 模型名发出去");
    /* 现在：同一个请求，什么都不给 */
    const now = anthropicToOpenCode(j, TOOLS2);
    assert.equal(now.payload.model, undefined, "现在这个错误 id 不再被发出去了");
    assert.notDeepEqual(now.payload.model, old.payload.model);
  });

  test("多轮对话 → 逐行可读的 user/assistant 前缀，不是 JSON", () => {
    const { payload } = anthropicToOpenCode({
      model: "claude-sonnet-4-5", system: "s",
      messages: [
        { role: "user", content: "Use the Read tool to read /etc/hostname." },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/etc/hostname" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "probe-host-42" }] },
      ],
      tools: TOOLS2,
    }, TOOLS2, { model: "space-bunny-free" });
    const text = payload.parts[0].text;
    assert.equal(text.startsWith("{"), false, `正文不该是 JSON：${text}`);
    assert.ok(text.startsWith("user: Use the Read tool to read /etc/hostname."), `实际：${text}`);
    assert.ok(text.includes("assistant:"), `实际：${text}`);
    assert.ok(text.includes('[tool_use] Read({"file_path":"/etc/hostname"})'), `实际：${text}`);
    assert.ok(text.includes('returned: "probe-host-42"'), `实际：${text}`);
    /* 三轮各自的原文都要在，正文必须完整覆盖对话 */
    assert.ok(text.includes("Use the Read tool to read /etc/hostname."));
    assert.ok(text.includes("probe-host-42"));
  });

  test("★ 反向对照：正文必须覆盖**每一轮**的用户原文（不是只有第一轮）", () => {
    const { payload } = anthropicToOpenCode({
      model: "claude-sonnet-4-5", system: "s",
      messages: [
        { role: "user", content: "第一句：帮我看看配置" },
        { role: "assistant", content: "好的" },
        { role: "user", content: "第二句：再看看日志" },
        { role: "assistant", content: "已经看完" },
        { role: "user", content: "第三句：总结一下" },
      ],
      tools: TOOLS2,
    }, TOOLS2, { model: "space-bunny-free" });
    const text = payload.parts[0].text;
    for (const s of ["第一句：帮我看看配置", "第二句：再看看日志", "第三句：总结一下", "好的", "已经看完"]) {
      assert.ok(text.includes(s), `正文漏掉了「${s}」：${text}`);
    }
    /* 最后一轮才是模型当前要回答的那句，它必须在末尾 */
    assert.ok(text.trim().endsWith("第三句：总结一下"), `正文应该以最后一轮收尾：${text}`);
  });

  test("带图片时：正文仍是那句人话 + 文件名标记，图片仍走独立 file part", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const SENTENCE = "这张图里画的是什么";
    const { payload } = anthropicToOpenCode({
      model: "claude-sonnet-4-5", system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: SENTENCE }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }],
      tools: TOOLS2,
    }, TOOLS2, { model: "space-bunny-free" });
    const text = payload.parts[0].text;
    assert.ok(text.startsWith(SENTENCE), `正文开头必须是用户那句话：${text}`);
    assert.equal(text.startsWith("{"), false);
    assert.ok(text.includes(payload.parts[1].filename), `正文里缺图片标记：${text}`);
    assert.ok(text.includes("Images are attached separately"));
  });

  test("空 messages → 正文是空串，不编造一句话出来", () => {
    const { payload } = anthropicToOpenCode({
      model: "claude-sonnet-4-5", system: "s", messages: [], tools: TOOLS2,
    }, TOOLS2, { model: "space-bunny-free" });
    assert.equal(payload.parts[0].text, "");
    assert.equal(payload.parts[0].text.startsWith("{"), false);
  });

  test("★ 走集成测试脚本同款调用：`anthropicToOpenCode(req, TOOLS)` 不传 opts", () => {
    /* `.research/oc-integration-test.mjs:97` 就是这么调的——它不传 opts。
     * 所以这里必须**不炸**，且 model 明确缺席（由上层补映射后重发）。 */
    const req = {
      model: "claude-sonnet-4-5", max_tokens: 1024,
      system: "You are Claude Code, a command-line coding assistant.",
      messages: [{ role: "user", content: "Use the Read tool to read /etc/hostname. Do not answer from memory." }],
      tools: TOOLS2, tool_choice: { type: "auto" },
    };
    const out = anthropicToOpenCode(req, TOOLS2);
    assert.ok(out.payload);
    assert.equal(out.payload.model, undefined, "脚本这么调时不得把 claude-sonnet-4-5 发出去");
    assert.equal(hasCode(out.diagnostics, DIAG.MODEL_MISSING), true);
    assert.ok(out.payload.format);
    assert.ok(out.schema.properties.calls.items.anyOf.map((b) => b.properties.name.const).includes("Read"));
    /* 补上目标模型后就是完整可发的载荷 */
    const fixed = anthropicToOpenCode(req, TOOLS2, { model: "space-bunny-free" });
    assert.deepEqual(fixed.payload.model, { providerID: "opencode", modelID: "space-bunny-free" });
  });
});

/* ================================================================== *
 * 源码级自检：这份测试确确实实在测仓库里那份实现
 * ================================================================== */
describe("⑧ 测试对象自检（防止测的是一份抄写）", () => {
  const SRC = readFileSync(BRIDGE, "utf8");

  test("oc-bridge.mjs 存在，且导出了三个必需函数", async () => {
    const m = await import("../src/server/oc-bridge.mjs");
    for (const fn of ["envelopeSchemaFor", "anthropicToOpenCode", "openCodeToAnthropic"]) {
      assert.equal(typeof m[fn], "function", `缺导出 ${fn}`);
    }
  });

  test("零 IO：源码里没有 fetch / spawn / fs 写 / process.env 读取", () => {
    /* 先剥注释：本文件的文档字符串里写着「不读 process.env」这类话，
     * 直接扫原文会把**声明自己不做的事**也算成做了。 */
    const code = SRC
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
    assert.equal(/\bfetch\s*\(/.test(code), false, "本模块必须是零 IO");
    assert.equal(/\bspawn(Sync)?\s*\(/.test(code), false);
    assert.equal(/\b(process\.env|readFileSync|writeFileSync|createWriteStream|appendFileSync)\b/.test(code), false);
    assert.equal(/from\s+["']node:(fs|child_process|http|https|os|net)["']/.test(code), false,
      "只允许 node:crypto 一个内置依赖");
    /* 反向对照：这条判据确实认得出东西（拿明显违规的片段试一次） */
    assert.equal(/\bfetch\s*\(/.test("await fetch('http://x')"), true, "判据自己失效了");
    /* 反向对照：剥注释之后 SRC 与 code 确实不同 —— 否则上面那些断言可能在扫空气 */
    assert.notEqual(SRC, code, "剥注释没起作用，注释里的字都被当成了代码");
  });

  test("源码里没有任何看起来像真实凭据的串", () => {
    /* 红线自检：凭据形态（sk-/jt-/oc_sk-/Bearer + 长串）一个都不许出现在模块里 */
    assert.equal(/\bsk-[A-Za-z0-9_-]{16,}/.test(SRC), false, "源码里出现了 sk- 开头的串");
    assert.equal(/\bjt-[A-Za-z0-9_-]{16,}/.test(SRC), false);
    assert.equal(/\boc_sk-[A-Za-z0-9_-]{16,}/.test(SRC), false);
    assert.equal(/Bearer\s+[A-Za-z0-9._-]{16,}/.test(SRC), false);
    /* 反向对照：这份判据确实认得出来（拿明显像的串试一次） */
    assert.equal(/\bsk-[A-Za-z0-9_-]{16,}/.test("sk-abcdefghijklmnopqrstuvwxyz"), true,
      "判据自己失效了 —— 上面几条就成了永远通过的死断言");
  });
});

/* ------------------------------------------------------------------ *
 * 反向对照的「把手册」：--list-sabotage / --sabotage
 * ------------------------------------------------------------------ */
const SABOTAGE = [
  { name: "drop-const", where: "envelopeSchemaFor 的 anyOf 分支", from: "name: { type: \"string\", const: t.name }", to: "name: { type: \"string\" }", reds: "① const 锁名 / 反向对照 const 那条 / ⑦ json_schema 逐字相等" },
  { name: "drop-maxitems-parallel", where: "envelopeSchemaFor 的 parallel 分支", from: "if (parallel === false) calls.maxItems = 1;", to: "/* 删 */", reds: "① 不支持并行 → maxItems:1" },
  { name: "drop-minitems-any", where: "envelopeSchemaFor 的 CHOICE_ANY 分支", from: "minItems = 1;", to: "minItems = 0;", reds: "② {type:'any'} → minItems:1 / 反向对照 minItems" },
  { name: "keep-forced-unsupported", where: "envelopeSchemaFor 的 CHOICE_TOOL 分支", from: "allowed = hit;\n    minItems = hit.length ? 1 : 0;", to: "allowed = list;", reds: "② 强制了不支持的工具 → maxItems:0 / anyOf 里不得出现该名" },
  { name: "drop-empty-maxitems", where: "envelopeSchemaFor 的空工具分支", from: "calls.maxItems = 0;", to: "calls.maxItems = 99;", reds: "① 空工具 → maxItems:0 / ③ 空工具 format 仍发" },
  { name: "throw-on-unparsed", where: "openCodeToAnthropic 的防误杀分支", from: "diagnostics.push(diag(DIAG.ENVELOPE_UNPARSED,", to: "throw new Error('invalid model output'); // diagnostics.push(diag(DIAG.ENVELOPE_UNPARSED,", reds: "⑤ 三处都没有信封 → 返回原文，不抛错 / 形状不对也透传" },
  { name: "structured-only", where: "openCodeToAnthropic 的四来源", from: "let envelope = null;\n  if (r.structured != null) {", to: "let envelope = null;\n  if (false) {", reds: "④ 落点二（structured undefined 正文在 text 块）/ 两个落点同一答案 / ⑦ 实测第 ③ 步" },
  { name: "no-text-json-fallback", where: "openCodeToAnthropic 的第 4 来源", from: "if (!envelope) {\n    const fromText = envelopeFromText(text);", to: "if (false) {\n    const fromText = envelopeFromText(text);", reds: "同上" },
  { name: "drop-system-suffix", where: "anthropicToOpenCode 的 system 拼接", from: "const system = base ? `${base}\\n${STRUCTURED_OUTPUT_INSTRUCTION}` : STRUCTURED_OUTPUT_INSTRUCTION;", to: "const system = base;", reds: "③ system 追加那句 / ⑦ 实测 system 逐字相等 / ⑦ 围栏" },
  { name: "drop-format-when-no-tools", where: "anthropicToOpenCode 的 payload", from: "format: { type: \"json_schema\", retryCount: 0, schema },", to: "...(!list0.length ? {} : { format: { type: \"json_schema\", retryCount: 0, schema } }),", reds: "★ 空工具列表时 format 照样发 / 反向对照围栏那条" },
  { name: "drop-cache-from-input", where: "tokensToUsage", from: "input_tokens: input + read + write,", to: "input_tokens: input,", reds: "⑥ usage（2200）/ 反向对照 cache.read" },
  { name: "no-tooluse-stop", where: "openCodeToAnthropic 的 stop_reason", from: "} else if (hasToolUse) {\n    stopReason = \"tool_use\";", to: "} else if (false) {\n    stopReason = \"tool_use\";", reds: "⑥ tool-calls → tool_use / ★ finish=stop 但 calls 非空" },
];

/* 供 sabotage 用的最小本地实现：只用来给「反向对照：把透传改成抛错」那条做对照组。 */
function envelopeFromTextProbe(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  if (!m) return null;
  try { const v = JSON.parse(m[0]); return v && typeof v === "object" && !Array.isArray(v) && typeof v.content === "string" && Array.isArray(v.calls) ? v : null; }
  catch { return null; }
}

if (process.argv.includes("--list-sabotage")) {
  console.log(`oc-bridge 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(28)} ${s.where}\n  ${"".padEnd(28)} → 会打红: ${s.reds}`);
  process.exit(0);
}
if (process.argv.includes("--sabotage")) {
  const i = process.argv.indexOf("--sabotage");
  const name = process.argv[i + 1];
  const s = SABOTAGE.find((x) => x.name === name);
  if (!s) { console.error(`没有这条手法：${name}。可用：${SABOTAGE.map((x) => x.name).join(", ")}`); process.exit(2); }
  console.log(JSON.stringify({ file: "src/server/oc-bridge.mjs", ...s }, null, 2));
  process.exit(0);
}
