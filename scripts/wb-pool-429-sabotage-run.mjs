/**
 * 反向对照的执行器（一次性工具，**不进 npm test**）。
 *
 *   node scripts/wb-pool-429-sabotage-run.mjs
 *
 * 它把 scripts/wb-pool-rotation-e2e.mjs 末尾 SABOTAGE 那张表里的每一处「改坏」
 * **真的**打到 src/server/server.mjs 上，跑一遍那个测试文件，确认**必须红**，
 * 然后逐字还原。
 *
 * 为什么要有这个脚本：反向对照的判据只有一个——「改回改前行为，测试必须红」。
 * 手工改、手工跑、手工还原，十次之后总会有人忘记还原，或者只跑了其中几条。
 * 这里把「打补丁 → 跑 → 必须红 → 还原 → 校验还原后与原始逐字相同」串成一条，
 * 任何一步不合规就退非零，并且**任何情况下都会还原**（finally 里做）。
 *
 * ⚠ 打的是**真实 server.mjs**：那套测试里有一组是真起进程的端到端用例，
 *   所以「改了会不会被测出来」不是靠 grep 猜的，是跑出来的。
 *
 * 红线：只在工作区里临时改源码，进程退出前逐字还原；不碰任何其它文件；
 * 不写任何真实凭据；测试自己起的 server.mjs 由测试的 after 钩子按 PID 收掉。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const TEST = path.join(REPO, "scripts", "wb-pool-rotation-e2e.mjs");

/** 运行结束时用来证明「一个字节都没被留下改动」的对照物。 */
const START_SRC = readFileSync(SERVER, "utf8");

/* 与测试文件里那张表逐字对应。from 必须**恰好命中一次**——
 * 命中 0 次说明源码变了，命中多次说明锚点不唯一，两种都直接判失败（不猜、不硬改）。 */
const SABOTAGE = [
  {
    name: "drop-429-feedback",
    from: [
      "    let wbFed = null;",
      "    if (isWk(p) && wbActiveAccountId) {",
      "      wbFed = wbNoteFailure(cfg, p, {",
      "        accountId: wbActiveAccountId, model: ob.model, status: r.status,",
      "        text: txt, headers: r.headers, now: Date.now(),",
      "      });",
      "    }",
    ].join("\n"),
    to: [
      "    let wbFed = null;",
      "    if (false) {",
      "      wbFed = wbNoteFailure(cfg, p, {",
      "        accountId: wbActiveAccountId, model: ob.model, status: r.status,",
      "        text: txt, headers: r.headers, now: Date.now(),",
      "      });",
      "    }",
    ].join("\n"),
    expect: "★ A 429 之后池子必须记上冷却",
  },
  {
    name: "drop-http-status-gate",
    from: [
      "  const httpStatus = Number(p.httpStatus);",
      '  if (Number.isFinite(httpStatus) && (httpStatus < 200 || httpStatus >= 300)) return "upstream_rejected";',
    ].join("\n"),
    to: [
      "  const httpStatus = Number(p.httpStatus);",
      "  void httpStatus;",
    ].join("\n"),
    expect: "★ B2 判空枚举先看状态码",
  },
];

function runTests() {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", TEST], { encoding: "utf8", cwd: REPO });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /^# fail (\d+)$/m.exec(out);
  const p = /^# pass (\d+)$/m.exec(out);
  const failedNames = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((x) => x[1].trim());
  return { code: r.status, fail: m ? Number(m[1]) : -1, pass: p ? Number(p[1]) : -1, failedNames, out };
}

let bad = 0;
const results = [];

/* ⚠ 每轮**现读原文**，而不是用启动时的快照：用快照的话，运行期间任何一次外部编辑
 *   都会被后面的「还原」按**旧内容**覆盖回去，源码会被悄悄改坏——那比测试失败严重得多。
 *   代价是：跑到一半不要去动 server.mjs。真动过的话收尾会报「被本进程之外的东西改过」。 */
let currentOriginal = null;
function restoreCurrent() {
  if (currentOriginal != null) writeFileSync(SERVER, currentOriginal, "utf8");
  currentOriginal = null;
}

try {
  const base = runTests();
  if (base.code !== 0) {
    console.error(`✗ 基线就不绿（fail=${base.fail}）—— 反向对照无从谈起，先修好测试`);
    process.exitCode = 1;
  } else {
    console.log(`基线：✔ ${base.pass} 条全绿\n`);
  }

  for (const s of SABOTAGE) {
    const original = readFileSync(SERVER, "utf8");
    const hits = original.split(s.from).length - 1;
    if (hits !== 1) {
      console.log(`✗ ${s.name.padEnd(26)} 锚点命中 ${hits} 次（必须恰好 1 次）—— 补丁没打上，这条不算数`);
      bad++;
      continue;
    }
    currentOriginal = original;
    writeFileSync(SERVER, original.replace(s.from, s.to), "utf8");
    let r;
    try { r = runTests(); }
    finally { restoreCurrent(); }

    const restored = readFileSync(SERVER, "utf8") === original;
    if (!restored) { console.log(`✗ ${s.name.padEnd(26)} 还原失败 —— 源码已脏！`); bad++; continue; }
    if (r.code === 0) {
      console.log(`✗ ${s.name.padEnd(26)} 打上补丁后测试**仍然全绿**（pass=${r.pass}）—— 这条反向对照是假的`);
      bad++;
      continue;
    }
    const hitExpect = r.failedNames.some((n) => n.includes(s.expect.replace(/^★\s*/, "")));
    console.log(`✔ ${s.name.padEnd(26)} fail=${String(r.fail).padStart(2)}  ${r.failedNames.join(" | ")}`);
    if (!hitExpect) {
      console.log(`  ⚠ 变红的是别的断言（期望含「${s.expect}」）—— 判据可能没落在刀刃上`);
      bad++;
      continue;
    }
    results.push(s.name);
  }
} finally {
  restoreCurrent();
}

const stillOk = runTests();
const dirty = readFileSync(SERVER, "utf8") !== START_SRC;
if (dirty) console.log("⚠ 运行期间 server.mjs 被本进程之外的东西改过 —— 收尾核对不通过，请自己看一遍 diff");
console.log(`\n还原后复跑：${stillOk.code === 0 ? `✔ ${stillOk.pass} 条全绿` : `✗ fail=${stillOk.fail}`}`);
console.log(`反向对照：${results.length}/${SABOTAGE.length} 条手法确认会把测试打红`);
if (bad || stillOk.code !== 0 || dirty) process.exitCode = 1;