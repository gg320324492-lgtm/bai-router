/**
 * 反向对照的执行器（一次性工具，不进 npm test）。
 *
 *   node scripts/oc-bridge-sabotage-run.mjs
 *
 * 它把 scripts/oc-bridge-test.mjs 里 SABOTAGE 那张表里的每一处「改坏」**真的**
 * 打到 src/server/oc-bridge.mjs 上，跑一遍测试，确认**必须红**，然后逐字还原。
 *
 * 为什么要有这个脚本：反向对照的判据只有一个——「改回改前行为，测试必须红」。
 * 手工改、手工跑、手工还原，十二次之后总会有人忘记还原，或者只跑了其中三条。
 * 这里把「打补丁 → 跑 → 必须红 → 还原 → 校验还原后与原始逐字相同」串成一条，
 * 任何一步不合规就退非零，并且**任何情况下都会还原**（finally 里做）。
 *
 * 红线：只在工作区里临时改一个源码文件，进程退出前逐字还原；不碰任何其它文件。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const BRIDGE = path.join(REPO, "src", "server", "oc-bridge.mjs");
const TEST = path.join(REPO, "scripts", "oc-bridge-test.mjs");

const ORIGINAL = readFileSync(BRIDGE, "utf8");

/* 与测试文件里那张表逐字对应。from 必须**恰好命中一次**——命中 0 次说明源码变了，
 * 命中多次说明锚点不唯一，两种都直接判失败（不猜、不硬改）。 */
const SABOTAGE = [
  {
    name: "drop-const",
    from: 'name: { type: "string", const: t.name }, arguments: t.schema',
    to: 'name: { type: "string" }, arguments: t.schema',
  },
  {
    name: "drop-maxitems-parallel",
    from: "if (parallel === false) calls.maxItems = 1;",
    to: "/* sabotage: 并行收紧删掉 */",
  },
  {
    name: "drop-minitems-any",
    from: "  } else if (choice.type === CHOICE_ANY) {\n    minItems = 1;",
    to: "  } else if (choice.type === CHOICE_ANY) {\n    minItems = 0;",
  },
  {
    name: "keep-forced-unsupported",
    from: "    allowed = hit;\n    minItems = hit.length ? 1 : 0;",
    to: "    allowed = list;\n    minItems = hit.length ? 1 : 0;",
  },
  {
    name: "drop-empty-maxitems",
    from: "    calls.maxItems = 0;\n    calls.items = { type: \"object\" };",
    to: "    calls.maxItems = 99;\n    calls.items = { type: \"object\" };",
  },
  {
    name: "throw-on-unparsed",
    from: "    diagnostics.push(diag(DIAG.ENVELOPE_UNPARSED,",
    to: "    throw new Error(\"invalid model output\");\n    diagnostics.push(diag(DIAG.ENVELOPE_UNPARSED,",
  },
  {
    name: "structured-only",
    from: "  let envelope = null;\n  if (r.structured != null) {",
    to: "  let envelope = null;\n  if (false && r.structured != null) {",
  },
  {
    name: "no-text-json-fallback",
    from: "  if (!envelope) {\n    const fromText = envelopeFromText(text);",
    to: "  if (false) {\n    const fromText = envelopeFromText(text);",
  },
  {
    name: "drop-system-suffix",
    from: "const system = base ? `${base}\\n${STRUCTURED_OUTPUT_INSTRUCTION}` : STRUCTURED_OUTPUT_INSTRUCTION;",
    to: "const system = base;",
  },
  {
    name: "drop-format-when-no-tools",
    from: "    format: { type: \"json_schema\", retryCount: 0, schema },",
    to: "    ...(!list0.length ? {} : { format: { type: \"json_schema\", retryCount: 0, schema } }),",
  },
  {
    name: "drop-cache-from-input",
    from: "    input_tokens: input + read + write,",
    to: "    input_tokens: input,",
  },
  {
    name: "no-tooluse-stop",
    from: '  } else if (hasToolUse) {\n    stopReason = "tool_use";',
    to: '  } else if (false) {\n    stopReason = "tool_use";',
  },
  /* ↓ 以下两条是 2026-10-12 真实集成测试抓出来的 bug 的反向对照。
     它们对应的两个 bug 曾让 66 条测试全绿、真实上游三轮 0 token。 */
  {
    name: "fallback-to-j-model",
    from: "  const model = resolveModel(options.model, diagnostics);",
    to: "  const model = resolveModel(options.model ?? body.model, diagnostics);",
  },
  {
    name: "emit-empty-model",
    from: "    ...(model ? { model } : {}),",
    to: "    model: model || { providerID: \"opencode\", modelID: \"\" },",
  },
  {
    name: "json-transcript",
    from: "  const text = renderTranscript(flat) + (images.length",
    to: "  const text = JSON.stringify({ messages: flat }) + (images.length",
  },
  {
    name: "prefix-single-user-message",
    from: "      return only.content;",
    to: "      return `user: ${only.content}`;",
  },
  {
    name: "drop-transcript-turns",
    from: "  return lines.join(\"\\n\\n\");",
    to: "  return lines.length ? lines[lines.length - 1] : \"\";",
  },
];

function runTests() {
  const r = spawnSync(process.execPath, ["--test", TEST], { encoding: "utf8", cwd: REPO });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /# fail (\d+)/.exec(out) || /ℹ fail (\d+)/.exec(out);
  const p = /# pass (\d+)/.exec(out) || /ℹ pass (\d+)/.exec(out);
  const failedNames = [...out.matchAll(/^✖ (.+?) \(\d/gm)].map((x) => x[1].trim());
  return { code: r.status, fail: m ? Number(m[1]) : -1, pass: p ? Number(p[1]) : -1, failedNames, out };
}

let bad = 0;
const results = [];

try {
  /* 基线：不打任何补丁必须是全绿，否则后面的「红」没有意义。 */
  const base = runTests();
  if (base.code !== 0) {
    console.error(`✗ 基线就不绿（fail=${base.fail}）—— 反向对照无从谈起，先修好测试`);
    process.exitCode = 1;
  } else {
    console.log(`基线：✔ ${base.pass} 条全绿\n`);
  }

  for (const s of SABOTAGE) {
    const hits = ORIGINAL.split(s.from).length - 1;
    if (hits !== 1) {
      console.log(`✗ ${s.name.padEnd(26)} 锚点在源码里命中 ${hits} 次（必须恰好 1 次）—— 补丁没打上，这条不算数`);
      bad++;
      continue;
    }
    writeFileSync(BRIDGE, ORIGINAL.replace(s.from, s.to), "utf8");
    let r;
    try { r = runTests(); }
    finally { writeFileSync(BRIDGE, ORIGINAL, "utf8"); }   // 任何情况下都还原

    const restored = readFileSync(BRIDGE, "utf8") === ORIGINAL;
    if (!restored) { console.log(`✗ ${s.name.padEnd(26)} 还原失败 —— 源码已脏！`); bad++; continue; }
    if (r.code === 0) {
      console.log(`✗ ${s.name.padEnd(26)} 打上补丁后测试**仍然全绿**（pass=${r.pass}）—— 这条反向对照是假的`);
      bad++;
      continue;
    }
    console.log(`✔ ${s.name.padEnd(26)} fail=${String(r.fail).padStart(2)}  ${r.failedNames.slice(0, 3).join(" | ")}`);
    results.push(s.name);
  }
} finally {
  writeFileSync(BRIDGE, ORIGINAL, "utf8");
}

const stillOk = runTests();
console.log(`\n还原后复跑：${stillOk.code === 0 ? `✔ ${stillOk.pass} 条全绿` : `✗ fail=${stillOk.fail}`}`);
console.log(`反向对照：${results.length}/${SABOTAGE.length} 条手法确认会把测试打红`);
if (bad || stillOk.code !== 0) process.exitCode = 1;
