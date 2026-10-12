/**
 * 反向对照的执行器（一次性工具，**不进 npm test**）。
 *
 *   node scripts/zen-probe-free-tier-sabotage-run.mjs
 *
 * 它把 scripts/zen-probe-free-tier-test.mjs 里 SABOTAGE 那张表里的每一处「改坏」**真的**
 * 打到源文件上，跑一遍测试，确认**必须红**，然后逐字还原。
 *
 * 为什么要有这个脚本：反向对照的判据只有一个——「改回改前行为，测试必须红」。
 * 手工改、手工跑、手工还原，十次之后总会有人忘记还原，或者只跑了其中三条。
 * 这里把「打补丁 → 跑 → 必须红 → 还原 → 校验还原后与原始逐字相同」串成一条，
 * 任何一步不合规就退非零，并且**任何情况下都会还原**（finally 里做）。
 *
 * 红线：只在工作区里临时改源文件，进程退出前逐字还原；不碰任何其它文件。
 * 不写任何真实凭据（打的是纯逻辑分支，不含凭据）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const TEST = path.join(REPO, "scripts", "zen-probe-free-tier-test.mjs");

/* 手法表直接问测试文件要——**不在这里抄一份**，抄一份迟早与测试文件漂移，
 * 而漂移的表现恰恰是「执行器说这条会打红，实际那条根本不覆盖它」，最难察觉的一种假绿。 */
const listed = spawnSync(process.execPath, [TEST, "--sabotage-json"], { encoding: "utf8", cwd: REPO });
if (listed.status !== 0) {
  console.error(`✗ 读不到 SABOTAGE 表（--sabotage-json 退出码 ${listed.status}）`);
  console.error(listed.stderr || "");
  process.exit(1);
}
const SABOTAGE = JSON.parse(listed.stdout);

/* 记住所有被临时改过的文件的原始内容，退出前一律逐字还原。 */
const ORIGINAL = new Map();
for (const s of SABOTAGE) {
  const abs = path.join(REPO, s.file);
  if (!ORIGINAL.has(abs)) ORIGINAL.set(abs, readFileSync(abs, "utf8"));
}

function runTests() {
  const r = spawnSync(process.execPath, ["--test", TEST], { encoding: "utf8", cwd: REPO });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /# fail (\d+)/.exec(out) || /ℹ fail (\d+)/.exec(out);
  const p = /# pass (\d+)/.exec(out) || /ℹ pass (\d+)/.exec(out);
  const failedNames = [...out.matchAll(/^✖ (.+?) \(\d/gm)].map((x) => x[1].trim());
  return { code: r.status, fail: m ? Number(m[1]) : -1, pass: p ? Number(p[1]) : -1, failedNames, out };
}

/**
 * 源文件是 **CRLF**，而 SABOTAGE 里的锚点写成 LF（人读起来那样顺）。
 * 所以先把锚点按文件的行尾风格对齐再匹配/替换——**两种风格都试**，
 * 命中哪套用哪套，绝不「顺手把整个文件转成 LF」（那会让 diff 炸成全文件重写，
 * 且还原后不再是逐字相同）。
 */
function styleOf(text) { return text.includes("\r\n") ? "crlf" : "lf"; }
function withEol(text, style) {
  const lf = text.replace(/\r\n/g, "\n");
  return style === "crlf" ? lf.replace(/\n/g, "\r\n") : lf;
}
function applyPatch(original, s) {
  for (const style of [styleOf(original), styleOf(original) === "crlf" ? "lf" : "crlf"]) {
    const from = withEol(s.from, style);
    const to = withEol(s.to, style);
    const hits = original.split(from).length - 1;
    if (hits === 1) return { patched: original.replace(from, to), hits };
  }
  return { patched: original, hits: 0 };
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
    const abs = path.join(REPO, s.file);
    const original = ORIGINAL.get(abs);
    const { patched, hits } = applyPatch(original, s);
    if (hits !== 1) {
      console.log(`✗ ${s.name.padEnd(26)} 锚点在 ${s.file} 里命中 ${hits} 次（必须恰好 1 次）—— 补丁没打上，这条不算数`);
      bad++;
      continue;
    }
    writeFileSync(abs, patched, "utf8");
    let r;
    try { r = runTests(); }
    finally { writeFileSync(abs, original, "utf8"); }   // 任何情况下都还原

    const restored = readFileSync(abs, "utf8") === original;
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
  for (const [abs, content] of ORIGINAL) writeFileSync(abs, content, "utf8");
}

const stillOk = runTests();
console.log(`\n还原后复跑：${stillOk.code === 0 ? `✔ ${stillOk.pass} 条全绿` : `✗ fail=${stillOk.fail}`}`);
console.log(`反向对照：${results.length}/${SABOTAGE.length} 条手法确认会把测试打红`);
if (bad || stillOk.code !== 0) process.exitCode = 1;
