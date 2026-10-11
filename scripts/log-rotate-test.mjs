/* 日志轮转器的负样本测试。
 * 只测 server.mjs 里的 rotateIfNeeded / appendLog —— 它们是新增的、且有状态的逻辑。
 * main.js 那两处刻意与它重复（CJS/ESM 不通），这里不重复测。
 * 不写真实 DATA_DIR：用系统临时目录 + 独立的文件名。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bai-logrot-"));
const F = path.join(TMP, "server.log");

// —— 把真实函数抠出来（源码，不是重写） ——
const src = fs.readFileSync("src/server/server.mjs", "utf8");
const grab = (start, end) => {
  const s = src.indexOf(start);
  if (s < 0) throw new Error("找不到 " + start);
  const e = src.indexOf(end, s);
  if (e < 0) throw new Error("找不到结尾 " + end);
  return src.slice(s, e);
};
const block = grab("const ROTATE_BYTES", "function log(...a)");
const code = block + "\nexport { rotateIfNeeded, appendLog, ROTATE_BYTES };\n"
  + 'import { writeFileSync, appendFileSync, existsSync, statSync, mkdirSync, rmSync, renameSync } from "node:fs";\n';
// import 提到最前
const finalCode = 'import { writeFileSync, appendFileSync, existsSync, statSync, mkdirSync, rmSync, renameSync } from "node:fs";\n'
  + block + "\nexport { rotateIfNeeded, appendLog, ROTATE_BYTES };\n";
const mod = path.join(TMP, "rot.mjs");
fs.writeFileSync(mod, finalCode);
const { rotateIfNeeded, appendLog, ROTATE_BYTES } = await import("file://" + mod.replace(/\\/g, "/"));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✔ " + msg); } else { fail++; console.log("  ✗ " + msg); } };
const size = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };
const fresh = () => { fs.rmSync(F, { force: true }); fs.rmSync(F + ".old", { force: true }); fs.rmSync(F + ".old.1", { force: true }); fs.rmSync(F + ".old.2", { force: true }); };

console.log(`  临时目录 ${TMP}   阈值 ${ROTATE_BYTES} 字节\n`);

// ① 小文件不滚动
console.log("① 未到阈值不滚动");
fresh();
fs.writeFileSync(F, "x".repeat(100));
ok(rotateIfNeeded(F) === false && size(F) === 100, "100 字节时不滚，文件原样");

// ② 到阈值就滚，且旧内容进 .old
console.log("\n② 到阈值滚动，旧内容保留");
fresh();
fs.writeFileSync(F, "O".repeat(ROTATE_BYTES));   // 先造一个已满的文件
appendLog(F, "新一行");                          // 这一行触发滚动
ok(fs.existsSync(F + ".old"), "出现了 .old");
ok(fs.readFileSync(F + ".old", "utf8") === "O".repeat(ROTATE_BYTES), ".old 里是上一份完整内容");
ok(fs.readFileSync(F, "utf8") === "新一行\n", "当前文件从新的一行开始");
ok(size(F) < 100, "当前文件很小");

// ③ 再滚一次：.old 被替换，不是累积
console.log("\n③ 二次滚动替换 .old（不无限累积）");
fresh();
fs.writeFileSync(F, "A".repeat(ROTATE_BYTES));
appendLog(F, "line1");
fs.writeFileSync(F, "B".repeat(ROTATE_BYTES));
appendLog(F, "line2");
ok(fs.readFileSync(F + ".old", "utf8") === "B".repeat(ROTATE_BYTES), ".old 是最新的那份（A 被替换掉）");
ok(size(F) < 100, "当前文件仍很小");
ok(!fs.existsSync(F + ".old.2"), "没有 .old.2");

// ④ 目录不可写时不抛
console.log("\n④ 写入失败不抛（日志不能拖垮主流程）");
fresh();
fs.rmSync(F, { force: true });
// 指向一个不存在的目录下的文件
const badPath = path.join(TMP, "no-such-dir", "x.log");
let threw = false;
try { appendLog(badPath, "hello"); } catch { threw = true; }
ok(!threw, "目录不存在时 appendLog 静默失败，不抛异常");

// ⑤ 并发安全性（同一进程内串行调用，至少不该损坏）
console.log("\n⑤ 连续追加保持行完整");
fresh();
for (let i = 0; i < 200; i++) appendLog(F, `line-${i}`);
const lines = fs.readFileSync(F, "utf8").trim().split("\n");
ok(lines.length === 200 && lines[0] === "line-0" && lines[199] === "line-199", "200 行全部完整且有序");

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n  ${fail ? `✗ ${fail} 条失败` : "✔ 全部通过"}（${pass} 条）`);
process.exit(fail ? 1 : 0);
