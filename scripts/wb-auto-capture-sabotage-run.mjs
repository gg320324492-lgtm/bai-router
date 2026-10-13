#!/usr/bin/env node
/**
 * scripts/wb-auto-capture-sabotage-run.mjs —— 反向对照执行器。
 *
 *   node scripts/wb-auto-capture-sabotage-run.mjs           跑全部手法
 *   node scripts/wb-auto-capture-sabotage-run.mjs <name>    只跑一条
 *   node scripts/wb-auto-capture-test.mjs --list-sabotage   只看清单
 *
 * ## 干什么
 *   把 wb-auto-capture-test.mjs 里的 SABOTAGE 表**逐条真的打到源码上**，
 *   跑一次测试，确认**对应用例变红**，然后逐字还原。
 *   判据只有一个 —— 改坏之后测试必须失败。测试还绿 = 那条断言没有判别力。
 *
 * ## 🔴 红线
 *   · **绝不 git stash、不动用户的共享工作区**：改之前先把文件整份备份到
 *     os.tmpdir() 下的独立目录，finally 里逐字拷回，最后比对 md5 一致。
 *   · 手法本身只改 src/ 下的一行；万一中途崩了，finally 仍然还原。
 *   · 全程不碰 .research/、不碰真实 %APPDATA%\bai-router、不碰任何 WorkBuddy 进程。
 */
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const TEST = path.join(HERE, "wb-auto-capture-test.mjs");
const md5 = (p) => createHash("md5").update(readFileSync(p)).digest("hex");

// 只读取手法表，不 import 测试（import 会顺带注册并运行整套测试）。
const table = readFileSync(TEST, "utf8").match(/export const SABOTAGE = (\[[\s\S]*?\n\]);/);
if (!table) throw new Error("找不到反向对照手法表");
const ALL = vm.runInNewContext("(" + table[1] + ")");
const only = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const list = only ? ALL.filter((s) => s.name === only) : ALL;
if (!list.length) { console.error(`没有这条手法：${only}`); process.exit(2); }

const backupDir = mkdtempSync(path.join(os.tmpdir(), "bai-wbsab-"));
// 在独立副本上破坏代码，共享工作区始终不变。
for (const rel of ["scripts/wb-auto-capture-test.mjs", "src/server/server.mjs", "src/server/cards/token-capture.js", "src/server/proc-identity.cjs"]) {
  const target = path.join(backupDir, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(REPO, rel), target);
}
const isolatedTest = path.join(backupDir, "scripts", "wb-auto-capture-test.mjs");
for (const s of list) s.path = path.join(backupDir, s.file);
const results = [];
try {
  const baseline = spawnSync(process.execPath,
    ["--test", "--test-concurrency=1", "--test-reporter=tap", isolatedTest],
    { cwd: backupDir, encoding: "utf8", timeout: 300000 });
  if (baseline.status !== 0) throw new Error("原始代码测试未全绿，拒绝把原有失败当作反向对照成功：\n" + baseline.stdout);
  console.log("✔ 未改坏的基线全部通过");
  for (const s of list) {
    const src = readFileSync(s.path, "utf8");
    if (!src.includes(s.from)) {
      console.error(`✖ ${s.name}：手法锚点在源码里找不到（源码已经变了？）\n  ${s.from.split("\n")[0]}`);
      results.push({ name: s.name, ok: false, why: "锚点找不到" });
      continue;
    }
    const backup = path.join(backupDir, path.basename(s.path));
    copyFileSync(s.path, backup);
    const before = md5(s.path);
    try {
      writeFileSync(s.path, src.replace(s.from, s.to), "utf8");
      const r = spawnSync(process.execPath,
        ["--test", "--test-concurrency=1", "--test-reporter=tap", isolatedTest],
        { cwd: backupDir, encoding: "utf8", timeout: 300000 });
      const out = String(r.stdout || "") + String(r.stderr || "");
      const red = /\bnot ok\b/.test(out) && r.status !== 0;
      const crashed = /SyntaxError|抠源码失败|找不到终点|Identifier .* has already been declared/.test(out);
      const which = (out.match(/^# Subtest: .*$/gm) || []).join("|");
      results.push({
        name: s.name, ok: red && !crashed,
        why: red ? (crashed ? "测试崩了（不是断言红，不算判别力）" : `变红 ✔`) : "改坏之后测试仍然全绿 —— 这条断言没有判别力",
        status: r.status,
      });
    } finally {
      copyFileSync(backup, s.path);         // 逐字还原
      const after = md5(s.path);
      if (after !== before) throw new Error(`还原失败：${s.path} 的 md5 变了`);
      rmSync(backup, { force: true });
    }
  }
} finally {
  if (path.dirname(path.resolve(backupDir)) !== path.resolve(os.tmpdir())) throw new Error("临时副本路径异常，拒绝清理");
  rmSync(backupDir, { recursive: true, force: true });
}

/* 跑完之后源码里必须一条 SABOTAGE 标记都搜不到 */
const left = list.map((s) => path.join(REPO, s.file))
  .filter((p, i, a) => a.indexOf(p) === i)
  .filter((p) => /SABOTAGE (?!手法)|SABOTAGE [a-z-]+/.test(readFileSync(p, "utf8")));
console.log("");
for (const r of results) console.log(`${r.ok ? "✔" : "✖"} ${r.name.padEnd(26)} ${r.why}`);
if (left.length) {
  console.error(`\n🔴 源码里还残留 SABOTAGE 标记：${left.join(", ")}`);
  process.exit(1);
}
const bad = results.filter((r) => !r.ok);
console.log(`\n反向对照：${results.length - bad.length}/${results.length} 条真的能把测试打红`);
process.exit(bad.length ? 1 : 0);
