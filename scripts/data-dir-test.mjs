/**
 * 本项目的落点：**不许在系统盘留文件**（scripts/data-dir-test.mjs）
 *
 * ## 为什么有这条
 *
 * 2026-10-23 用户要求：「把本项目在 C 盘中的所有文件都挪动到本项目文件夹，
 * 并且禁止再在 C 盘产生任何本项目文件」。
 *
 * ⇒ 落点从 `os.tmpdir()`（Windows 上是 `%TEMP%`，在 C 盘）挪到**数据目录**
 *   （`BAI_DATA_DIR`，没设时是 `%APPDATA%\bai-router`；用户那台机器上把它指到
 *   项目文件夹下的 `.data/`）。
 *
 * ## ★ 为什么这条测试曾经**没抓到一个真缺陷**（2026-10-30）
 *
 * 它原来只扫 `server.mjs` ⇒ 漏了 `qoder-patch.mjs` —— 而那恰恰是**真正写文件的
 * 那一侧**（worker 补丁把令牌快照、模型目录、抓包日志写进去）。
 * 于是 2026-10-23 那次搬家只改了**中转侧**的落点，补丁侧仍写临时目录 ⇒
 * 两边分叉 ⇒ 新机上「补丁明明装好了，中转永远读不到令牌」。
 * ⇒ 现在这份测试把**每一个写我们自己的文件的地方**都列进清单，
 *   并多钉一条：**补丁写的落点 == 中转读的落点**（真 import 两个模块比对）。
 *
 * ## 测什么
 *
 * ★ ① **我们写的文件不许落在系统盘的临时目录** —— 落点必须在数据目录下
 *   （`DATA_DIR`）。
 * ★ ② **数据目录可以被指定**（`BAI_DATA_DIR`）⇒ 用户能把本项目整个挪到别的盘。
 * ★ ③ **没指定时行为一字不变**（仍是 `%APPDATA%\bai-router`）⇒ 分发给别人的
 *   机器不受影响。
 * ★ ④ **别家的文件不许动**（WorkBuddy 的 sidecar.pid 仍在临时目录）。
 * ★ ⑤ **补丁的落点与中转读的落点必须是同一个目录**（端到端比对，不是看源码）。
 *
 * ## ⚠ 有一类**不是**我们的文件，不能动
 *
 * `%TEMP%\wb*\sidecar.pid` 是 **WorkBuddy 自己写的**（它的 sidecar 进程记号）
 * ⇒ 搬走会让 WorkBuddy 找不到自己的侧车 ⇒ **不许碰**。
 * 同样地，开始菜单 / 开机自启的快捷方式必须留在 `%APPDATA%\Microsoft\Windows\…`
 * （Windows 的约定位置，挪了会破坏开始菜单与开机自启）。
 *
 * ## 红线
 *
 * 纯源码断言：不 spawn、不联网、不落盘。
 * ⚠ 唯一的例外是 ⑤ 那条要 `import` qoder-patch.mjs —— 它在模块加载时
 *   `mkdirSync(DATA_DIR, {recursive:true})`，而该目录**本就存在** ⇒ 不写任何东西。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = fs.readFileSync(path.join(REPO, "src", "server", "server.mjs"), "utf8");
const MAIN = fs.readFileSync(path.join(REPO, "src", "main.js"), "utf8");
const PATCH = fs.readFileSync(path.join(REPO, "src", "server", "qoder-patch.mjs"), "utf8");
const FRESH = fs.readFileSync(path.join(REPO, "src", "server", "clients", "facts-refresh.mjs"), "utf8");

/** 源码里「我们自己写的文件」的落点长什么样。**每一处都要列全** ——
 *  漏一处就是漏一个真缺陷（见文件头「为什么这条测试曾经没抓到一个真缺陷」）。 */
const OURS = [
  { file: "server.mjs", src: SERVER, name: "qoder 令牌快照", re: /tokenFile:\s*QODER_PATCH_PATHS\.TOKFILE/ },
  { file: "server.mjs", src: SERVER, name: "qoder 模型快照", re: /modelsFile:\s*QODER_PATCH_PATHS\.MODELFILE/ },
  { file: "server.mjs", src: SERVER, name: "WorkBuddy 脚本备份", re: /WB_BACKUP_FILE\s*=\s*path\.join\(\s*DATA_DIR/ },
  { file: "server.mjs", src: SERVER, name: "fixQdFile 委托给 qdFilePath（落点规则只有一处出处）", re: /const fixQdFile = \(v, name\) => qdFilePath\(v, name, DATA_DIR\)/ },
  { file: "qoder-patch.mjs", src: PATCH, name: "qdFilePath 的默认落点", re: /const def = path\.join\(\s*dataDir,\s*name\)/ },
  { file: "qoder-patch.mjs", src: PATCH, name: "补丁写的令牌文件", re: /const TOKFILE = path\.join\(\s*DATA_DIR,\s*"qoder-token\.json"\)/ },
  { file: "qoder-patch.mjs", src: PATCH, name: "补丁写的模型目录", re: /const MODELFILE = path\.join\(\s*DATA_DIR,\s*"qoder-models\.json"\)/ },
  { file: "qoder-patch.mjs", src: PATCH, name: "补丁写的抓包日志", re: /const OUT = path\.join\(\s*DATA_DIR,\s*"qoder-hdr\.jsonl"\)/ },
  { file: "qoder-patch.mjs", src: PATCH, name: "补丁的数据目录", re: /const DATA_DIR = process\.env\.BAI_DATA_DIR \|\| HERE/ },
  { file: "facts-refresh.mjs", src: FRESH, name: "刷新模型真值时的 qd 目录兜底", re: /cfg\.qd\.modelsFile = path\.join\(\s*dataDir,\s*"qoder-models\.json"\)/ },
];

/** 会写我们自己的文件的源码（兜底检查要全扫）。 */
const WRITERS = [
  { file: "server.mjs", src: SERVER },
  { file: "qoder-patch.mjs", src: PATCH },
  { file: "facts-refresh.mjs", src: FRESH },
];

describe("本项目的落点：不在系统盘留文件", () => {
  test("① 我们自己写的文件，落点都在数据目录（不是系统盘的临时目录）", () => {
    for (const o of OURS) {
      assert.ok(o.re.test(o.src), `★ ${o.name} 的落点不在 DATA_DIR 下（${o.file}）`);
    }
    /* ⚠ 兜底：**不许**出现「我们自己写的文件落在 os.tmpdir()」这种形状。
     *   （WorkBuddy 自己的 sidecar.pid 那几处是**别家**写的，不在此列。） */
    for (const w of WRITERS) {
      const bad = w.src.match(/path\.join\(\s*os\.tmpdir\(\)\s*,\s*"(?:bai-|qoder-)[^"]*"/g);
      assert.equal(bad, null, `★ ${w.file} 还有文件落在系统盘临时目录：${JSON.stringify(bad)}`);
    }
  });

  test("② 数据目录可以被指定（BAI_DATA_DIR）—— 用户能把本项目整个挪到别的盘", () => {
    assert.ok(/const DATA_DIR = process\.env\.BAI_DATA_DIR \|\| HERE/.test(SERVER),
      "server.mjs 认 BAI_DATA_DIR");
    assert.ok(/const DATA_DIR = process\.env\.BAI_DATA_DIR \|\| HERE/.test(PATCH),
      "★ qoder-patch.mjs 认 BAI_DATA_DIR（不然补丁与中转会算出两个不同的目录）");
    assert.ok(/process\.env\.BAI_DATA_DIR/.test(MAIN),
      "main.js 认 BAI_DATA_DIR（Electron 的 userData 也要能被指走）");
  });

  test("③ 没指定时行为一字不变（仍是 %APPDATA%\\bai-router）", () => {
    assert.ok(/app\.setPath\("userData", custom \|\| path\.join\(app\.getPath\("appData"\), "bai-router"\)\)/.test(MAIN),
      "没设 BAI_DATA_DIR 时仍用 %APPDATA%\\bai-router");
  });

  test("④ 别家的文件不许动：WorkBuddy 的 sidecar.pid 仍在临时目录", () => {
    /* 它是 **WorkBuddy 自己**写的进程记号 ⇒ 搬走 WorkBuddy 就找不到自己的侧车。 */
    assert.ok(/wbSidecarPidCandidates[\s\S]{0,300}?os\.tmpdir\(\)/.test(SERVER),
      "★ WorkBuddy 的 sidecar.pid 落点被改了 ⇒ 会破坏 WorkBuddy");
  });

  test("⑤ 补丁写的落点 == 中转读的落点（端到端：真算出两个目录来比）", async () => {
    /* 这条是 2026-10-30 补上的：分叉过一次（补丁写临时目录、中转读数据目录），
     * 而源码断言看不出分叉 —— 只有**把两个模块都算一遍再比**才抓得住。 */
    const mod = await import(pathToFileURL(path.join(REPO, "src", "server", "qoder-patch.mjs")).href);
    const serverDir = path.join(REPO, "src", "server");
    const expect = String(process.env.BAI_DATA_DIR || "").trim() || serverDir;
    assert.equal(path.dirname(mod.QODER_PATCH_PATHS.TOKFILE), expect,
      "★ 补丁写的令牌文件不在中转读的那个目录里 ⇒ 两边分叉，中转永远读不到令牌");
    assert.equal(path.dirname(mod.QODER_PATCH_PATHS.MODELFILE), expect,
      "★ 补丁写的模型目录不在中转读的那个目录里");
    assert.equal(path.dirname(mod.QODER_PATCH_PATHS.OUT), expect,
      "★ 补丁写的抓包日志不在数据目录里");
    /* 中转侧不许自己另算一份落点 —— 只有一个出处（补丁模块的常量）。 */
    assert.ok(/tokenFile:\s*QODER_PATCH_PATHS\.TOKFILE/.test(SERVER),
      "★ 中转侧的令牌落点没引用补丁模块的常量");
    assert.ok(!/tokenFile:\s*path\.join\(\s*DATA_DIR/.test(SERVER),
      "★ 中转侧又自己算了一份令牌落点（会有第二处出处）");
  });

  test("⑥ 补丁的运行时产物不许进版本库（开发模式下它们落在 src/server 里）", () => {
    /* ⚠ 开发/绿色模式的 DATA_DIR 就是 `src/server` ⇒ 补丁的产物落在**源码目录**里。
     *   其中 qoder-token.json 是真令牌、qoder-hdr.jsonl 是抓到的请求头原文
     *   （里面也有真令牌）⇒ git add -A 一把就能把它们提交上去。
     *   ⇒ 这三个必须进 .gitignore（与 config.json / cli-apply.json 同一类问题）。 */
    const ignore = fs.readFileSync(path.join(REPO, ".gitignore"), "utf8");
    for (const f of ["src/server/qoder-token.json", "src/server/qoder-models.json", "src/server/qoder-hdr.jsonl"]) {
      assert.ok(ignore.includes(f), `★ ${f} 没进 .gitignore —— 它含真令牌，git add -A 会带进仓库`);
    }
  });
});
