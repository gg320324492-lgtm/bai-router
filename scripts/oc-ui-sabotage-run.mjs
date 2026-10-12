/**
 * scripts/oc-ui-sabotage-run.mjs —— 反向对照的执行器（一次性工具，不进 npm test）。
 *
 *   node scripts/oc-ui-sabotage-run.mjs
 *   node scripts/oc-ui-test.mjs --list-sabotage
 *
 * 它把 scripts/oc-ui-test.mjs 里 SABOTAGE 那张表里的每一处「改坏」**真的**打到
 * 源码上，跑一遍测试，确认**必须红**，然后逐字还原。
 *
 * 为什么要有这个脚本：反向对照的判据只有一个——「改回改前行为，测试必须红」。
 * 手工改、手工跑、手工还原，十几次之后总会有人忘记还原，或者只跑了其中三条。
 * 这里把「打补丁 → 跑 → 必须红 → 还原 → 校验还原后与原始逐字相同」串成一条，
 * 任何一步不合规就退非零，并且**任何情况下都会还原**（finally 里做）。
 *
 * 本文件的用例跑得快（整轮约 3 秒，含一次真 server.mjs 起停），
 * 所以反向对照**不跳过**任何一组——端到端那组也参与，省得「守卫没被执行」造成假绿。
 *
 * 红线：只在工作区里临时改那三个源码文件，进程退出前逐字还原；不碰任何其它文件。
 * 不写真实 %APPDATA%\bai-router（用例自己用临时 BAI_DATA_DIR），端口由用例动态挑空闲。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const INFO = path.join(REPO, "src", "server", "oc-transport-info.mjs");
const CARD = path.join(REPO, "src", "server", "cards", "oc-transport.js");
const DEFAULTS = path.join(REPO, "src", "server", "config.defaults.json");
const TEST = path.join(REPO, "scripts", "oc-ui-test.mjs");

const ORIGINALS = new Map([
  [INFO, readFileSync(INFO, "utf8")],
  [CARD, readFileSync(CARD, "utf8")],
  [DEFAULTS, readFileSync(DEFAULTS, "utf8")],
]);

/* 与测试文件里那张表逐字对应。from 必须**恰好命中一次**——命中 0 次说明源码变了，
 * 命中多次说明锚点不唯一，两种都直接判失败（不猜、不硬改）。 */
const SABOTAGE = [
  {
    file: DEFAULTS, name: "factory-default-opencode",
    from: `"transport": "direct"`,
    to: `"transport": "opencode"`,
  },
  {
    file: INFO, name: "probe-error-as-missing",
    from: `      state: "error", path: "", source: null,`,
    to: `      state: "missing", path: "", source: null,`,
  },
  {
    file: INFO, name: "probe-missing-as-error",
    from: `        state: "missing", path: "", source: null,`,
    to: `        state: "error", path: "", source: null,`,
  },
  {
    file: INFO, name: "no-install-hint",
    from: `        hint: ocInstallHint(tried),`,
    to: `        hint: "",`,
  },
  {
    file: INFO, name: "status-always-direct",
    from: `  const transport = raw === ZEN_TRANSPORT_OPENCODE ? ZEN_TRANSPORT_OPENCODE : ZEN_TRANSPORT_DIRECT;`,
    to: `  const transport = ZEN_TRANSPORT_DIRECT;`,
  },
  {
    file: INFO, name: "no-effect-hint",
    from: `      + "不需要重启中转，也不需要重启本程序。"`,
    to: `      + "重启一下就好。"`,
  },
  {
    file: CARD, name: "card-err-as-missing",
    from: `<span class="v warn">检测失败</span></div>\``,
    to: `<span class="v err">未安装</span></div>\``,
  },
  {
    file: CARD, name: "swallow-server-reject",
    from: `      if (deps.onResult) deps.onResult(false, msg);`,
    to: `      if (deps.onResult) deps.onResult(true, "已保存");`,
  },
  {
    file: CARD, name: "payload-extra-field",
    from: `    return { provider: provider, transport: String(value == null ? "" : value) };`,
    to: `    return { provider: provider, transport: String(value == null ? "" : value), forced: true };`,
  },
  {
    file: CARD, name: "repaint-wipes-result",
    from: `      if (prevText && ctx.showResult) ctx.showResult(resultSlot(), prevText, prevGood);`,
    to: `      /* sabotage: 重画不保留上一条结果 */`,
  },
];

function runTests() {
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", TEST], { encoding: "utf8", cwd: REPO });
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
    console.error(base.out.split("\n").filter((l) => l.startsWith("✖")).slice(0, 6).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`基线：✔ ${base.pass} 条全绿\n`);
  }

  for (const s of SABOTAGE) {
    const original = ORIGINALS.get(s.file);
    const hits = original.split(s.from).length - 1;
    if (hits !== 1) {
      console.log(`✗ ${s.name.padEnd(24)} 锚点在源码里命中 ${hits} 次（必须恰好 1 次）—— 补丁没打上，这条不算数`);
      bad++;
      continue;
    }
    writeFileSync(s.file, original.replace(s.from, s.to), "utf8");
    let r;
    try { r = runTests(); }
    finally { writeFileSync(s.file, original, "utf8"); }   // 任何情况下都还原

    const restored = readFileSync(s.file, "utf8") === original;
    if (!restored) { console.log(`✗ ${s.name.padEnd(24)} 还原失败 —— 源码已脏！`); bad++; continue; }
    if (r.code === 0) {
      console.log(`✗ ${s.name.padEnd(24)} 打上补丁后测试**仍然全绿**（pass=${r.pass}）—— 这条反向对照是假的`);
      bad++;
      continue;
    }
    console.log(`✔ ${s.name.padEnd(24)} fail=${String(r.fail).padStart(2)}  ${r.failedNames.slice(0, 2).join(" | ")}`);
    results.push(s.name);
  }
} finally {
  for (const [f, orig] of ORIGINALS) writeFileSync(f, orig, "utf8");
}

const stillOk = runTests();
console.log(`\n还原后复跑：${stillOk.code === 0 ? `✔ ${stillOk.pass} 条全绿` : `✗ fail=${stillOk.fail}`}`);
console.log(`反向对照：${results.length}/${SABOTAGE.length} 条手法确认会把测试打红`);
if (bad || stillOk.code !== 0) process.exitCode = 1;