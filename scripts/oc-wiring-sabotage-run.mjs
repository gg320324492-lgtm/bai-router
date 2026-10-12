/**
 * 反向对照的执行器（一次性工具，不进 npm test）。
 *
 *   node scripts/oc-wiring-sabotage-run.mjs
 *
 * 它把 scripts/oc-wiring-test.mjs 里 SABOTAGE 那张表里的每一处「改坏」**真的**
 * 打到 src/server/oc-wiring.mjs 或 src/server/server.mjs 上，跑一遍测试，
 * 确认**必须红**，然后逐字还原。
 *
 * 为什么要有这个脚本：反向对照的判据只有一个——「改回改前行为，测试必须红」。
 * 手工改、手工跑、手工还原，十几次之后总会有人忘记还原，或者只跑了其中三条。
 * 这里把「打补丁 → 跑 → 必须红 → 还原 → 校验还原后与原始逐字相同」串成一条，
 * 任何一步不合规就退非零，并且**任何情况下都会还原**（finally 里做）。
 *
 * 只跑**不起真进程、不打真上游**的那部分用例（跳过 ⑧⑨ 两组端到端）：
 * 反向对照要证明的是「这条断言真的在盯着那段代码」，端到端既慢又依赖上游，
 * 拿它当反向对照的判据只会把「上游抖了」误判成「断言有效」。
 *
 * 红线：只在工作区里临时改那一个源码文件，进程退出前逐字还原；不碰任何其它文件。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const WIRING = path.join(REPO, "src", "server", "oc-wiring.mjs");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const TEST = path.join(REPO, "scripts", "oc-wiring-test.mjs");

const ORIGINALS = new Map([[WIRING, readFileSync(WIRING, "utf8")], [SERVER, readFileSync(SERVER, "utf8")]]);

/* 与测试文件里那张表逐字对应。from 必须**恰好命中一次**——命中 0 次说明源码变了，
 * 命中多次说明锚点不唯一，两种都直接判失败（不猜、不硬改）。 */
const SABOTAGE = [
  {
    file: WIRING, name: "transport-fallback-opencode",
    from: "  return raw === ZEN_TRANSPORT_OPENCODE ? ZEN_TRANSPORT_OPENCODE : ZEN_TRANSPORT_DIRECT;",
    to: "  return raw === undefined ? ZEN_TRANSPORT_DIRECT : ZEN_TRANSPORT_OPENCODE;",
  },
  {
    file: WIRING, name: "spawnable-exists-always-false",
    from: "  const base = typeof realExists === \"function\" ? realExists : fs.existsSync;",
    to: "  const base = typeof realExists === \"function\" ? realExists : (() => false);",
  },
  {
    file: WIRING, name: "drop-opts-model-req",
    from: "      model: target,",
    to: "      /* sabotage: 不传目标模型 */",
  },
  {
    file: WIRING, name: "drop-opts-model-res",
    from: "    const back = openCodeToAnthropic(json, { model: target, tools });",
    to: "    const back = openCodeToAnthropic(json, { tools });",
  },
  {
    file: WIRING, name: "no-session-reuse",
    from: "    const key = isProbe === true ? OC_PROBE_SESSION_KEY : sessionKeyOf(first && first.content);",
    to: "    const key = isProbe === true ? OC_PROBE_SESSION_KEY : (\"k\" + Math.random().toString(36).slice(2, 10));",
  },
  {
    file: WIRING, name: "write-before-ready",
    from: "    const inTok = Math.max(1, Math.ceil(JSON.stringify(j || {}).length / 4));",
    to: "    writeAnthropicMessage(res, { id: \"m0\", model: target, content: [], stop_reason: \"end_turn\", usage: {} }, j && j.stream === true, {});\n    const inTok = Math.max(1, Math.ceil(JSON.stringify(j || {}).length / 4));",
  },
  {
    file: WIRING, name: "empty-is-success",
    from: "    if (!Array.isArray(message.content) || !message.content.length) {",
    to: "    if (false) {",
  },
  {
    file: WIRING, name: "no-install-hint",
    from: "        ? \"\\n\\n\" + ocInstallHint(sess && sess.tried)",
    to: "        ? \"\"",
  },
  {
    file: WIRING, name: "drop-sse-message-stop",
    from: "  sse(res, \"message_stop\", { type: \"message_stop\" });",
    to: "  /* sabotage: 不收尾 */",
  },
  {
    file: WIRING, name: "sse-wrong-order",
    from: "  sse(res, \"message_delta\", {",
    to: "  sse(res, \"message_stop\", { type: \"message_stop\" });\n  sse(res, \"message_delta\", {",
  },
  {
    file: SERVER, name: "always-opencode",
    from: "  if (p === \"zen\" && zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE) {",
    to: "  if (p === \"zen\") {",
  },
  {
    file: SERVER, name: "zen-needs-key-anyway",
    from: "    return !!cfg.zen?.apiKey || zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE;",
    to: "    return !!cfg.zen?.apiKey;",
  },
  {
    file: SERVER, name: "accept-garbage-transport", only: "非法取值被拒",
    from: "        if (!ZEN_TRANSPORTS.includes(t)) {",
    to: "        if (false) {",
  },
];

function runTests(only) {
  /* 默认只跑不起真进程、不打真上游的那部分用例；个别手法的守卫用例在端到端组里，
   * 用 `only` 单独点名跑它（否则这条反向对照会因为「守卫没被执行」而假绿）。 */
  const args = only
    ? ["--test", "--test-name-pattern", only, TEST]
    : ["--test", "--test-skip-pattern", "^(⑧|⑨)", TEST];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
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
    console.error(base.out.split("\n").filter((l) => l.startsWith("✖")).slice(0, 5).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`基线：✔ ${base.pass} 条全绿（只跑 ①②③ 组，端到端两组不参与反向对照）\n`);
  }

  for (const s of SABOTAGE) {
    const original = ORIGINALS.get(s.file);
    const hits = original.split(s.from).length - 1;
    if (hits !== 1) {
      console.log(`✗ ${s.name.padEnd(26)} 锚点在源码里命中 ${hits} 次（必须恰好 1 次）—— 补丁没打上，这条不算数`);
      bad++;
      continue;
    }
    writeFileSync(s.file, original.replace(s.from, s.to), "utf8");
    let r;
    try { r = runTests(s.only); }
    finally { writeFileSync(s.file, original, "utf8"); }   // 任何情况下都还原

    const restored = readFileSync(s.file, "utf8") === original;
    if (!restored) { console.log(`✗ ${s.name.padEnd(26)} 还原失败 —— 源码已脏！`); bad++; continue; }
    if (r.code === 0) {
      console.log(`✗ ${s.name.padEnd(26)} 打上补丁后测试**仍然全绿**（pass=${r.pass}）—— 这条反向对照是假的`);
      bad++;
      continue;
    }
    console.log(`✔ ${s.name.padEnd(26)} fail=${String(r.fail).padStart(2)}  ${r.failedNames.slice(0, 2).join(" | ")}`);
    results.push(s.name);
  }
} finally {
  for (const [f, orig] of ORIGINALS) writeFileSync(f, orig, "utf8");
}

const stillOk = runTests();
console.log(`\n还原后复跑：${stillOk.code === 0 ? `✔ ${stillOk.pass} 条全绿` : `✗ fail=${stillOk.fail}`}`);
console.log(`反向对照：${results.length}/${SABOTAGE.length} 条手法确认会把测试打红`);
if (bad || stillOk.code !== 0) process.exitCode = 1;