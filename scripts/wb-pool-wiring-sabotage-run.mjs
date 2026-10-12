/**
 * 反向对照的执行器（一次性工具，**不进 npm test**）。
 *
 *   node scripts/wb-pool-wiring-sabotage-run.mjs
 *
 * 它把 scripts/wb-pool-wiring-test.mjs 里 SABOTAGE 那张表里的每一处「改坏」**真的**
 * 打到源码上（接线层 wb-pool-wiring.mjs **或** server.mjs，两者互不影响），
 * 跑一遍测试，确认**必须红**，然后逐字还原。
 *
 * 为什么要有这个脚本：反向对照的判据只有一个——「改回改前行为，测试必须红」。
 * 手工改、手工跑、手工还原，十次之后总会有人忘记还原，或者只跑了其中几条。
 * 这里把「打补丁 → 跑 → 必须红 → 还原 → 校验还原后与原始逐字相同」串成一条，
 * 任何一步不合规就退非零，并且**任何情况下都会还原**（finally 里做）。
 *
 * ⚠ 打补丁的是**真实 server.mjs**：接线测试里有一组是真起进程的端到端用例，
 *   所以「改了 server.mjs 会不会被测出来」不是靠源码 grep 猜的，是跑出来的。
 *
 * 红线：只在工作区里临时改源码，进程退出前逐字还原；不碰任何其它文件。
 * 不写任何真实凭据（打的是纯逻辑分支，不含凭据）。不 spawn 任何业务进程，
 * 测试自己起的 server.mjs 由测试的 after 钩子按 PID 收掉。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const WIRING = path.join(REPO, "src", "server", "wb-pool-wiring.mjs");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const TEST = path.join(REPO, "scripts", "wb-pool-wiring-test.mjs");

const ORIGINALS = { wiring: readFileSync(WIRING, "utf8"), server: readFileSync(SERVER, "utf8") };
/** 运行结束时用来证明「一个字节都没被留下改动」的对照物。 */
const START_SHA = { wiring: ORIGINALS.wiring, server: ORIGINALS.server };

/* 与测试文件里那张表逐字对应。from 必须**恰好命中一次**——
 * 命中 0 次说明源码变了，命中多次说明锚点不唯一，两种都直接判失败（不猜、不硬改）。 */
const SABOTAGE = [
  {
    name: "drop-refresh-context", file: "wiring",
    from: 'context: "refresh",            // ★★★ 全仓库唯一一处',
    to: 'context: "model",',
  },
  {
    name: "synthesize-from-nowhere", file: "wiring",
    from: 'accessToken: String(slice.accessToken || ""),\n    refreshToken: String(slice.refreshToken || ""),',
    to: 'accessToken: "",\n    refreshToken: "",',
  },
  {
    name: "drop-legacy-synthesis", file: "wiring",
    from: "const pool = { version: p, mode, accounts: [synthAccount(slice, p)], sticky, synthetic: true, cursor: 0 };",
    to: "const pool = { version: p, mode, accounts: [], sticky, synthetic: true, cursor: 0 };",
  },
  {
    // ★ 打的是**返回给用户的那一份**，不是面板快照那一行：
    //   面板快照记错了用户看不见，而返回值的 reason/remedy 直接进错误文案 ——
    //   「一次限流被说成请重新登录」正是 dsh-xdpool 1.7.7 事故的形态。
    name: "reason-from-response", file: "wiring",
    from: "ok: false, reason: r.reason, remedy: r.remedy || remedyOf(r.reason),\n      how: r.how,",
    to: 'ok: false, reason: "dead", remedy: "请重新登录。",\n      how: r.how,',
  },
  {
    name: "dead-on-any-400", file: "wiring",
    from: 'context: "model",',
    to: 'context: "refresh",',
  },
  {
    name: "hide-unavailable", file: "wiring",
    from: "const accounts = pool.accounts.map((a) => accountFields(pool, a, t, model, fp));",
    to: "const accounts = pool.accounts.filter((a) => !a.disabled && !a.ignored).map((a) => accountFields(pool, a, t, model, fp));",
  },
  {
    name: "match-by-id-prefix", file: "wiring",
    from: 'if (String(c.label == null ? c.target : c.label) !== label) continue;   // ★ 按显示名匹配',
    to: 'if (String(c.target).startsWith(String(limited).replace(/-(free|paid)$/, "")) === false) continue;',
  },
  {
    name: "guess-paid-rate", file: "wiring",
    from: "const isPaid = m.free === true ? false : (rate != null ? rate > 0 : false);",
    to: "const isPaid = m.free !== true;",
  },
  {
    name: "own-second-session-key", file: "server",
    from: "const mk0 = isProbe ? null : zenSessionId(j, false);",
    to: 'const mk0 = "bai-" + createHash("sha256").update(String(j && j.messages && j.messages[0] && j.messages[0].content || "")).digest("hex").slice(0, 16);',
  },
  {
    name: "bind-probe-to-constant", file: "server",
    from: "const mk0 = isProbe ? null : zenSessionId(j, false);",
    to: "const mk0 = zenSessionId(j, isProbe);",
  },
];

const PATHS = { wiring: WIRING, server: SERVER };

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

/* ⚠ **为什么每轮现读原文，而不是启动时的快照**：
 *   用启动快照的话，运行期间任何一次外部编辑（哪怕是有人把这个脚本 Ctrl-C 掉、
 *   补丁已经打上而还原还没跑到）都会被后面的「还原」按**旧内容**覆盖回去，
 *   结果就是源码被悄悄改坏 —— 那比测试失败严重得多。
 *
 *   代价是：**跑到一半不要去动那两个源码文件**。真动过的话收尾会报
 *   「被本进程之外的东西改过」，那时以 git diff 为准，别信这里的还原。
 *   （本文件被强杀时 finally 跑不掉，源码会停在补丁状态；重新跑一次本脚本
 *   会把基线判成红并逐条报出来，据此手工还原即可。） */
const CURRENT = { file: null, original: null };

function restoreCurrent() {
  if (CURRENT.file && CURRENT.original != null) {
    writeFileSync(PATHS[CURRENT.file], CURRENT.original, "utf8");
  }
  CURRENT.file = null;
  CURRENT.original = null;
}

try {
  /* 基线：不打任何补丁必须全绿，否则后面的「红」没有意义。 */
  const base = runTests();
  if (base.code !== 0) {
    console.error(`✗ 基线就不绿（fail=${base.fail}）—— 反向对照无从谈起，先修好测试`);
    process.exitCode = 1;
  } else {
    console.log(`基线：✔ ${base.pass} 条全绿\n`);
  }

  for (const s of SABOTAGE) {
    const original = readFileSync(PATHS[s.file], "utf8");
    const hits = original.split(s.from).length - 1;
    if (hits !== 1) {
      console.log(`✗ ${s.name.padEnd(26)} 锚点在 ${s.file} 里命中 ${hits} 次（必须恰好 1 次）—— 补丁没打上，这条不算数`);
      bad++;
      continue;
    }
    CURRENT.file = s.file; CURRENT.original = original;
    writeFileSync(PATHS[s.file], original.replace(s.from, s.to), "utf8");
    let r;
    try { r = runTests(); }
    finally { restoreCurrent(); }   // 任何情况下都还原

    const restored = readFileSync(PATHS[s.file], "utf8") === original;
    if (!restored) { console.log(`✗ ${s.name.padEnd(26)} 还原失败 —— 源码已脏！`); bad++; continue; }
    if (r.code === 0) {
      console.log(`✗ ${s.name.padEnd(26)} 打上补丁后测试**仍然全绿**（pass=${r.pass}）—— 这条反向对照是假的`);
      bad++;
      continue;
    }
    console.log(`✔ ${s.name.padEnd(26)} [${s.file}] fail=${String(r.fail).padStart(2)}  ${r.failedNames.slice(0, 2).join(" | ")}`);
    results.push(s.name);
  }
} finally {
  restoreCurrent();
}

const stillOk = runTests();
/* 收尾核对：两个被改过的源码必须与运行开始时**逐字相同**。
   这一条是给「有人在我跑的时候改了源码」兜底的 —— 真发生了要立刻看得见，
   而不是等下一次 git diff 里多出一处莫名的回退。 */
const dirty = Object.keys(START_SHA).filter((k) => readFileSync(PATHS[k], "utf8") !== START_SHA[k]);
if (dirty.length) console.log(`⚠ 运行期间 ${dirty.join("、")} 被本进程之外的东西改过 —— 收尾核对不通过，请自己看一遍 diff`);
console.log(`\n还原后复跑：${stillOk.code === 0 ? `✔ ${stillOk.pass} 条全绿` : `✗ fail=${stillOk.fail}`}`);
console.log(`反向对照：${results.length}/${SABOTAGE.length} 条手法确认会把测试打红`);
if (bad || stillOk.code !== 0 || dirty.length) process.exitCode = 1;