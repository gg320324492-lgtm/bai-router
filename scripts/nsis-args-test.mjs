/**
 * 静默安装时「装到哪儿」（scripts/nsis-args-test.mjs）
 *
 * ## 测的是 2026-10-25 那个「装上了但用不了」
 *
 * NSIS 安装器（electron-builder 产的）决定目录的顺序：
 *   ① 命令行 /D=<dir>（若给）  ② 注册表的 InstallLocation  ③ 默认目录
 *
 * ⚠ 还有一条容易踩的规矩（assistedInstaller.nsh 的 instFilesPre）：
 *   **目标目录名不含产品名时，安装器自动补一层** ⇒ 传 `G:\bai-router\app`
 *   变成 `G:\bai-router\app\B.AI Router`（多一层）⇒ 桌面图标指到不存在的文件
 *   ⇒ 症状是「用不了」。⇒ 所以传 dirname(exe)（它**已经含产品名**）。
 *
 * ## 测什么
 *
 * ★ ① 无空格 ⇒ `/D=<dir>`；含空格 ⇒ 整个参数引起来（不是放弃）。
 * ★ ② 没有 exe（绿色模式）⇒ 不传参数。
 * ★ ③ 含 cmd 元字符 ⇒ 不传（靠注册表兜底）。
 * ★ ④ **传的那个目录含产品名** ⇒ NSIS 不会补一层（那条规矩的判据）。
 * ★ ⑤ 反向对照：把「含空格就引起来」改坏 ⇒ ① 必须红。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDirArg, looksLikeAppDir } from "../src/server/nsis-args.cjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(REPO, "src", "server", "nsis-args.cjs"), "utf8");

describe("① 含空格的路径照样传（引起来），不是放弃", () => {
  test("①a 无空格 ⇒ /D= 直接给", () => {
    const a = installDirArg("G:\\bai-router\\app\\B.AI-Router\\B.AI-Router.exe");
    assert.equal(a, " /D=G:\\bai-router\\app\\B.AI-Router", `实际：${a}`);
  });
  test("①b 含空格 ⇒ 整个参数引起来（NSIS 的 /D= 必须是最后一个参数）", () => {
    const a = installDirArg("C:\\Program Files\\B.AI Router\\B.AI Router.exe");
    assert.equal(a, ' "/D=C:\\Program Files\\B.AI Router"', `实际：${a}`);
    /* ⚠ 引的是**整个参数**（`"/D=…"`），不是只引路径 —— NSIS 要的是
     *   一个 argv 项 `/D=<dir>`；只引路径会被 cmd 拆成两个参数。 */
    const t = a.trim();
    assert.ok(t.startsWith('"') && t.endsWith('"'), `★ 应当引起来整个参数：${t}`);
    assert.ok(/^"\/D=/.test(t), `★ 引号里应当是 /D= 开头：${t}`);
  });
});

describe("② 边界：不传参数的情形", () => {
  test("②a 没有 exe（绿色/开发模式）⇒ 不传", () => {
    assert.equal(installDirArg(""), "");
    assert.equal(installDirArg(undefined), "");
  });
  test("②b 含 cmd 元字符 ⇒ 不传（靠注册表兜底）", () => {
    for (const bad of ["C:\\a&b\\x.exe", "C:\\a|b\\x.exe", 'C:\\a"b\\x.exe']) {
      assert.equal(installDirArg(bad), "", `★ ${bad} 应当不传`);
    }
  });
});

describe("③ 「补一层」那条 NSIS 规矩的判据", () => {
  test("③a 传 dirname(exe) ⇒ 目录名含产品名 ⇒ 不会补一层", () => {
    const exe = "G:\\bai-router\\app\\B.AI Router\\B.AI Router.exe";
    const dir = exe.replace(/[\\/][^\\/]*$/, "");
    assert.ok(looksLikeAppDir(dir), `★ ${dir} 不含产品名 ⇒ 安装器会补一层（多一层目录）`);
  });
  test("③b 只传到 app ⇒ 不含产品名 ⇒ 会补一层（正是 2026-10-25 踩的那条）", () => {
    assert.equal(looksLikeAppDir("G:\\bai-router\\app"), false,
      "判据反了 ⇒ ③a 的断言恒真，测了个寂寞");
  });
});

describe("④ 接线处真的用上了这个判据", () => {
  test("④a apply.cmd 的 /S 后面带 dirArg，且它是最后一个参数", () => {
    const server = fs.readFileSync(path.join(REPO, "src", "server", "server.mjs"), "utf8");
    assert.match(server, /"\$\{SU_EXE\}" \/S\$\{dirArg\}/,
      "★ 静默安装不带 /D= ⇒ 装在自定义目录的用户升级会被搬回默认位置");
    assert.match(server, /const dirArg = installDirArg\(process\.env\.BAI_ROUTER_EXE/,
      "★ dirArg 没从当前 exe 反推 ⇒ 传的是默认目录");
  });
});

describe("⑤ 反向对照：改坏 ⇒ ① 必须红", () => {
  test("⑤a 把「含空格就引起来」改成「含空格就不传」⇒ ①b 的锚点必须失效", () => {
    const broken = SRC.replace(
      "return /\\s/.test(dir) ? ` \"/D=${dir}\"` : ` /D=${dir}`;",
      "return /\\s/.test(dir) ? \"\" : ` /D=${dir}`;   // SABOTAGE：含空格就放弃",
    );
    assert.notEqual(broken, SRC, "改坏的副本没改成 —— 这条反向对照失效了（锚点与源码脱节）");
    assert.ok(!/"\/D=\$\{dir\}"/.test(broken),
      "★ 改坏之后仍出现「引起来」的写法 ⇒ ①b 的判据是恒真的，测了个寂寞");
  });
});
