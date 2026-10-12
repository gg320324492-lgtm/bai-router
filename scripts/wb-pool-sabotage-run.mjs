/**
 * 反向对照的执行器（一次性工具，**不进 npm test**）。
 *
 *   node scripts/wb-pool-sabotage-run.mjs
 *
 * 它把 scripts/wb-pool-test.mjs 里 SABOTAGE 那张表里的每一处「改坏」**真的**
 * 打到 src/server/wb-pool.mjs 上，跑一遍测试，确认**必须红**，然后逐字还原。
 *
 * 为什么要有这个脚本：反向对照的判据只有一个——「改回改前行为，测试必须红」。
 * 手工改、手工跑、手工还原，十次之后总会有人忘记还原，或者只跑了其中三条。
 * 这里把「打补丁 → 跑 → 必须红 → 还原 → 校验还原后与原始逐字相同」串成一条，
 * 任何一步不合规就退非零，并且**任何情况下都会还原**（finally 里做）。
 *
 * 红线：只在工作区里临时改一个源码文件，进程退出前逐字还原；不碰任何其它文件。
 * 不写任何真实凭据（打的是纯逻辑分支，不含凭据）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MOD = path.join(REPO, "src", "server", "wb-pool.mjs");
const TEST = path.join(REPO, "scripts", "wb-pool-test.mjs");

const ORIGINAL = readFileSync(MOD, "utf8");

/* 与测试文件里那张表逐字对应。from 必须**恰好命中一次**——
 * 命中 0 次说明源码变了，命中多次说明锚点不唯一，两种都直接判失败（不猜、不硬改）。 */
const SABOTAGE = [
  {
    name: "dead-on-any-401",
    from: "    const phrase = matchedDeadPhrase(body);\n    if (phrase) {",
    to: "    const phrase = matchedDeadPhrase(body);\n    if (true) {",
  },
  {
    name: "trust-expires-at",
    from: 'const basis = issued != null ? "lastRefreshTime" : captured != null ? "capturedAt" : "expiresAt";',
    to: 'const basis = "expiresAt";',
  },
  {
    name: "rate-limit-account-scope",
    from: 'kind: "rate_limit", dead: false, scope: "account_model",',
    to: 'kind: "rate_limit", dead: false, scope: "account",',
  },
  {
    name: "quota-respect-reset",
    from: 'respectsResetAt: false, waitsHelps: false, recoveredBy: "topup", ignoredResetAt: resetAt,',
    to: 'respectsResetAt: true, waitsHelps: true, recoveredBy: "wait", ignoredResetAt: null,',
  },
  {
    name: "sticky-ignore-binding",
    from: '      const bound = eligible.find((a) => a.id === boundId);\n      if (bound) return { ok: true, account: bound, bound: true, eligible: eligible.length, how: "sticky", ...extra };',
    to: '      const bound = undefined;\n      if (bound) return { ok: true, account: bound, bound: true, eligible: eligible.length, how: "sticky", ...extra };',
  },
  {
    name: "no-rebind-after-death",
    from: "  bindIfSticky(stickyMap, sessionKey, chosen.id, now);\n  return { ok: true, account: chosen, bound: false, eligible: eligible.length, how: mode, ...extra };",
    to: "  return { ok: true, account: chosen, bound: false, eligible: eligible.length, how: mode, ...extra };",
  },
  {
    name: "same-remedy-for-all",
    from: '    remedy: "去 WorkBuddy 桌面端重新登录这个账号再重新捕获令牌；等多久都不会自己恢复，重启本程序也没用。",\n    recoveredBy: "relogin",',
    to: '    remedy: "请稍后重试。",\n    recoveredBy: "wait",',
  },
  {
    name: "unlimited-lru",
    from: "while (stickyMap.size > STICKY_LIMIT) {",
    to: "while (false) {",
  },
  {
    name: "transient-cools-anyway",
    from: 'if (failure.kind === "transient" || failure.kind === "content") {',
    to: 'if (failure.kind === "content") {',
  },
  {
    name: "quota-downgrade",
    from: "if (cd.untilMs > prev) { acct.cooldownUntilMs = cd.untilMs; out.changed = true; }",
    to: "acct.cooldownUntilMs = cd.untilMs; out.changed = true;",
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
    writeFileSync(MOD, ORIGINAL.replace(s.from, s.to), "utf8");
    let r;
    try { r = runTests(); }
    finally { writeFileSync(MOD, ORIGINAL, "utf8"); }   // 任何情况下都还原

    const restored = readFileSync(MOD, "utf8") === ORIGINAL;
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
  writeFileSync(MOD, ORIGINAL, "utf8");
}

const stillOk = runTests();
console.log(`\n还原后复跑：${stillOk.code === 0 ? `✔ ${stillOk.pass} 条全绿` : `✗ fail=${stillOk.fail}`}`);
console.log(`反向对照：${results.length}/${SABOTAGE.length} 条手法确认会把测试打红`);
if (bad || stillOk.code !== 0) process.exitCode = 1;