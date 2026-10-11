/* 日志轮转的负样本测试。
 *
 * v1.0.73 起轮转只发生在 **main.js**（server.mjs 已不再写任何日志文件）：
 *   · app.log           每次 logMain() 追加前查大小
 *   · server-child.log  spawn 之前查一次（追加发生在子进程里，主进程只能在这一瞬间干预）
 * 两处都用同一套阈值与「保留一份 .old」策略。
 *
 * 这里从 main.js 源码里**抠出** logMain 的轮转段跑（不重写），并在临时目录上操作，
 * 不碰真实的 %APPDATA%\bai-router。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bai-logrot-"));
const F = path.join(TMP, "app.log");

// —— 从 main.js 抠出 logMain 的真实轮转逻辑 ——
const src = fs.readFileSync("src/main.js", "utf8");
const i = src.indexOf("function logMain(msg) {");
if (i < 0) throw new Error("main.js 里找不到 logMain");
const j = src.indexOf("\n}", i);
const fnSrc = src.slice(i, j + 2);

// logMain 依赖 DATA_DIR 与 path；用可控的替身跑同一段源码
const mod = path.join(TMP, "logmain.mjs");
fs.writeFileSync(mod, `
import path from "node:path";
import fs from "node:fs";
const DATA_DIR = ${JSON.stringify(TMP)};
${fnSrc}
export { logMain };
`);
const { logMain } = await import("file://" + mod.replace(/\\/g, "/"));

const MB = 1024 * 1024;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else fail++; console.log(`  ${c ? "✔" : "✗"} ${m}`); };
const size = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };
const fresh = () => { fs.rmSync(F, { force: true }); fs.rmSync(F + ".old", { force: true }); };
const read = () => { try { return fs.readFileSync(F, "utf8"); } catch { return ""; } };

console.log("  临时目录 " + TMP + "\n");

// ① 小文件不滚
console.log("① 未到阈值不滚动");
fresh();
logMain("一行");
logMain("两行");
ok(size(F) > 0 && !fs.existsSync(F + ".old"), "写了 2 行，没有生成 .old");
ok(/一行/.test(read()) && /两行/.test(read()), "两行都在");

// ② 超阈值滚动，旧文进 .old
console.log("\n② 超阈值滚动，旧内容保留");
fresh();
fs.writeFileSync(F, "O".repeat(MB + 10));
const before = read();
logMain("新的一行");
ok(fs.existsSync(F + ".old"), "生成了 .old");
ok(read().indexOf(before.slice(0, 500)) < 0 && fs.readFileSync(F + ".old", "utf8").indexOf("O".repeat(500)) >= 0,
  ".old 里是上一份完整内容");
ok(read() === "新的一行\n" || /新的一行/.test(read()), "当前文件只剩新写的内容");
ok(size(F) < 200, "当前文件很小（" + size(F) + " 字节）");

// ③ 二次滚动替换而非累积
console.log("\n③ 二次滚动替换 .old（不无限累积）");
fresh();
fs.writeFileSync(F, "A".repeat(MB + 10));
logMain("x");
fs.writeFileSync(F, "B".repeat(MB + 10));
logMain("y");
ok(fs.readFileSync(F + ".old", "utf8").indexOf("B".repeat(500)) >= 0, ".old 是最新的那份（A 被替换掉）");
ok(!fs.existsSync(F + ".old.old"), "没有出现 .old.old（只保留一份）");
ok(size(F) < 200, "当前文件仍很小");

// ④ 时间戳格式没坏
console.log("\n④ 写的仍是带时间戳的一行");
fresh();
logMain("带戳的一行");
ok(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] 带戳的一行\n$/.test(read()), "格式不变：" + JSON.stringify(read()));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `\n  ✗ ${fail} 条失败` : `\n  ✔ 全部通过（${pass} 条）`);
process.exit(fail ? 1 : 0);
