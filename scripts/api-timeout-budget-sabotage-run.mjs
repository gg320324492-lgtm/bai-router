/**
 * scripts/api-timeout-budget-sabotage-run.mjs —— 「预算倒挂」检查的**反向对照执行器**
 *
 * ## 这份文件干什么
 *
 * 把 `scripts/api-timeout-budget-test.mjs` 末尾 `SABOTAGE` 表里的每一条手法
 * **真的打到源码上**，跑一遍测试，确认**必须红**，然后逐字还原，
 * 最后 `grep SABOTAGE` 自证干净。
 *
 *   node scripts/api-timeout-budget-sabotage-run.mjs            # 跑全部，逐条还原
 *   node scripts/api-timeout-budget-sabotage-run.mjs --list     # 只列手法
 *   node scripts/api-timeout-budget-sabotage-run.mjs <名字>     # 只跑一条
 *
 * **判据只有一个：改回改前行为，测试真的会红。** 一条都没红，
 * 说明对应那条断言是恒真的 —— 那种测试比没有测试更坏，因为它给人虚假的安全感。
 *
 * ## 红线
 *
 * 🔴 只改 `src/` 下的源码并**逐字还原**（还原后比字节；不一致直接退出码 4）。
 * 🔴 绝不写 `%APPDATA%\bai-router`：测试自己用的是 os.tmpdir() + BAI_DATA_DIR。
 * 🔴 绝不 `git stash`：共享工作区不能动别人的未提交改动。
 * 🔴 进程只按 **PID** 收，绝不用按镜像名的 /IM。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const TEST = path.join(HERE, "api-timeout-budget-test.mjs");

/* 从测试文件里把 SABOTAGE 表原样读出来（不复制一份——复制的那份迟早与源码脱节）。
   用一次求值把它取出来：进程参数 --emit-sabotage 只做这件事然后退出。 */
function readSabotage() {
  const r = spawnSync(process.execPath, [TEST, "--emit-sabotage"], { encoding: "utf8", cwd: REPO });
  if (r.status !== 0) {
    console.error("从测试文件里读 SABOTAGE 表失败：\n" + (r.stderr || r.stdout || "").slice(0, 800));
    process.exit(3);
  }
  return JSON.parse(r.stdout);
}

const SABOTAGE = readSabotage();

if (process.argv.includes("--list")) {
  console.log(`预算倒挂 · 反向对照手法（${SABOTAGE.length} 条）`);
  for (const s of SABOTAGE) {
    console.log(`  ${s.name.padEnd(26)} ${s.where}\n  ${"".padEnd(26)} → 会打红: ${s.reds}`);
  }
  process.exit(0);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = only.length ? SABOTAGE.filter((s) => only.includes(s.name)) : SABOTAGE;
if (!list.length) { console.error(`没有匹配的手法：${only.join(", ")}`); process.exit(2); }

function runTests() {
  const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", TEST],
    { encoding: "utf8", cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

let failed = 0;
for (const s of list) {
  const file = path.join(REPO, s.file);
  const before = fs.readFileSync(file, "utf8");

  let patched;
  if (s.all) {
    if (!before.includes(s.from)) {
      console.error(`✖ ${s.name}：锚点已经对不上 ${s.file} 的源码了（手法或源码变了，这条对照失效）`);
      failed++;
      continue;
    }
    patched = before.split(s.from).join(s.to);
  } else {
    if (!before.includes(s.from)) {
      console.error(`✖ ${s.name}：锚点已经对不上 ${s.file} 的源码了（手法或源码变了，这条对照失效）`);
      failed++;
      continue;
    }
    patched = before.replace(s.from, s.to);
  }

  /* 先记一份**原始字节**，还原时按字节写回并逐字比对。 */
  fs.writeFileSync(file, patched);
  const res = runTests();
  fs.writeFileSync(file, before);
  const restored = fs.readFileSync(file, "utf8");
  if (restored !== before) {
    console.error(`✖ ${s.name}：还原之后源码与动手前不一致！请立刻 git diff ${s.file}`);
    process.exit(4);
  }

  const reds = res.code !== 0;
  console.log(`${reds ? "✔" : "✖"} ${s.name.padEnd(26)} ${reds ? "打红了（符合预期）" : "★ 没红 —— 这条断言是恒真的！"}`);
  console.log(`    手法：${s.where}`);
  console.log(`    应红：${s.reds}`);
  if (reds) {
    const names = res.out.split("\n")
      .filter((l) => /^✖ /.test(l.trim()) || /^not ok/.test(l))
      .map((l) => l.trim().replace(/^✖\s*/, "").split("(")[0].trim())
      .filter(Boolean).slice(0, 4);
    if (names.length) console.log(`    实际红在：${names.join(" / ")}`);
  }
  if (!reds) {
    const tail = res.out.split("\n").filter((l) => /✖|failing tests|AssertionError|not ok/.test(l)).slice(0, 8).join("\n      ");
    console.log(`    实际输出里没有失败项。tail:\n      ${tail || "(无)"}`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} 条手法没有证明测试会红——对照失败。`);
  process.exit(1);
}
console.log(`\n全部 ${list.length} 条反向对照通过：改回改前行为，测试都红了；源码已逐字还原。`);