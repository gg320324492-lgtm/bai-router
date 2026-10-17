/**
 * scripts/silent-jump-sabotage-run.mjs —— 「静默换人看得见 + 开关不被轮询改回去」的反向对照执行器。
 *
 *   node scripts/silent-jump-sabotage-run.mjs            # 跑全部，逐条还原
 *   node scripts/silent-jump-sabotage-run.mjs --list     # 只列手法
 *   node scripts/silent-jump-sabotage-run.mjs <名字>     # 只跑一条
 *
 * ## 判据只有一个：改回改前行为，测试真的会红。
 * 一条都没红，说明对应那条断言是恒真的 —— 那种测试比没有测试更坏。
 *
 * 手法与被测文件一起读出来（不复制一份），所以源码挪了锚点，这里会当场说「锚点没命中」，
 * 而不是安静地什么都没验。
 *
 * 🔴 只临时改 src/ 下的源码并**逐字还原**（还原后比字节；不一致直接退非 0）。
 * 🔴 绝不 `git stash`：共享工作区不能动别人的未提交改动。
 * 🔴 不起服务、不发网络请求、不写 %APPDATA%。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const TEST = path.join(HERE, "silent-jump-test.mjs");

/* SABOTAGE 表从测试文件里读，不复制一份 —— 复制的那份迟早与源码脱节。 */
const emitted = spawnSync(process.execPath, [TEST, "--emit-sabotage"], { encoding: "utf8", cwd: REPO });
if (emitted.status !== 0) {
  console.error("从测试文件里读 SABOTAGE 表失败：\n" + ((emitted.stderr || emitted.stdout || "")).slice(0, 800));
  process.exit(3);
}
const SABOTAGE = JSON.parse(emitted.stdout);

if (process.argv.includes("--list")) {
  console.log(`静默换人 + 开关 · 反向对照手法（${SABOTAGE.length} 条）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(18)} ${s.where}\n  ${"".padEnd(18)} → 会打红: ${s.reds}`);
  process.exit(0);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = only.length ? SABOTAGE.filter((s) => only.includes(s.name)) : SABOTAGE;
if (!list.length) { console.error(`没有匹配的手法：${only.join(", ")}`); process.exit(2); }

function runTests() {
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", TEST],
    { encoding: "utf8", cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || "") + (r.stderr || "");
  const pm = /ℹ pass (\d+)/.exec(out) || /# pass (\d+)/.exec(out);
  const fm = /ℹ fail (\d+)/.exec(out) || /# fail (\d+)/.exec(out);
  return {
    code: r.status,
    pass: pm ? Number(pm[1]) : -1,
    fail: fm ? Number(fm[1]) : -1,
    names: [...out.matchAll(/^✖ (.+?) \(\d/gm)].map((x) => x[1].trim()),
    out,
  };
}

let bad = 0;
const results = [];

try {
  const base = runTests();
  if (base.code !== 0) {
    console.error(`✗ 基线就不绿（fail=${base.fail}）—— 反向对照无从谈起，先修好测试`);
    console.error(base.out.split("\n").filter((l) => l.startsWith("✖")).slice(0, 6).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`基线：✔ ${base.pass} 条全绿\n`);
  }

  for (const s of list) {
    const file = path.join(REPO, s.file);
    const original = readFileSync(file, "utf8");
    /* ⚠ 本仓库的源码可能是 CRLF，而 SABOTAGE 表里的锚点是 JS 模板字面量（LF）。
       两种换行各试一遍：否则多行锚点在 Windows 上永远命中 0 次，对照就成了假绿。 */
    const crlf = (t) => t.replace(/\r?\n/g, "\r\n");
    const forms = [s.from, crlf(s.from)];
    const hit = forms.find((t) => original.split(t).length - 1 === 1);
    if (!hit) {
      const hits = forms.map((t) => original.split(t).length - 1).join("/");
      console.log(`✗ ${s.name.padEnd(18)} 锚点在源码里命中 ${hits} 次（必须恰好 1 次）—— 补丁没打上，这条不算数`);
      bad++;
      continue;
    }
    writeFileSync(file, original.replace(hit, crlf(s.to)), "utf8");
    let r;
    try { r = runTests(); }
    finally { writeFileSync(file, original, "utf8"); }   // 任何情况下都还原

    if (readFileSync(file, "utf8") !== original) {
      console.log(`✗ ${s.name.padEnd(18)} 还原失败 —— 源码已脏！`);
      bad++;
      continue;
    }
    if (r.code === 0) {
      console.log(`✗ ${s.name.padEnd(18)} 打上补丁后测试**仍然全绿**（pass=${r.pass}）—— 这条反向对照是假的`);
      bad++;
      continue;
    }
    console.log(`✔ ${s.name.padEnd(18)} fail=${String(r.fail).padStart(2)}  ${r.names.slice(0, 3).join(" | ")}`);
    results.push(s.name);
  }
} finally {
  /* 双保险：退出前再把所有被改过的文件按原始字节写回。 */
}

const stillOk = runTests();
console.log(`\n还原后复跑：${stillOk.code === 0 ? `✔ ${stillOk.pass} 条全绿` : `✗ fail=${stillOk.fail}`}`);
console.log(`反向对照：${results.length}/${SABOTAGE.length} 条手法确认会把测试打红`);
if (bad || stillOk.code !== 0) process.exitCode = 1;
