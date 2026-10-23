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
 * ## 测什么
 *
 * ★ ① **我们写的文件不许落在系统盘的临时目录** —— 落点必须在数据目录下
 *   （`DATA_DIR`）。
 * ★ ② **数据目录可以被指定**（`BAI_DATA_DIR`）⇒ 用户能把本项目整个挪到别的盘。
 * ★ ③ **没指定时行为一字不变**（仍是 `%APPDATA%\bai-router`）⇒ 分发给别人的
 *   机器不受影响。
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
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = fs.readFileSync(path.join(REPO, "src", "server", "server.mjs"), "utf8");
const MAIN = fs.readFileSync(path.join(REPO, "src", "main.js"), "utf8");

/** 源码里「我们自己写的文件」的落点长什么样。 */
const OURS = [
  { name: "qoder 令牌快照", re: /tokenFile:\s*path\.join\(\s*DATA_DIR/ },
  { name: "qoder 模型快照", re: /modelsFile:\s*path\.join\(\s*DATA_DIR/ },
  { name: "WorkBuddy 脚本备份", re: /WB_BACKUP_FILE\s*=\s*path\.join\(\s*DATA_DIR/ },
  { name: "fixQdFile 的默认落点", re: /const fixQdFile[\s\S]{0,400}?const def = path\.join\(\s*DATA_DIR/ },
];

describe("本项目的落点：不在系统盘留文件", () => {
  test("① 我们自己写的文件，落点都在数据目录（不是系统盘的临时目录）", () => {
    for (const o of OURS) {
      assert.ok(o.re.test(SERVER), `★ ${o.name} 的落点不在 DATA_DIR 下`);
    }
    /* ⚠ 兜底：**不许**出现「我们自己写的文件落在 os.tmpdir()」这种形状。
     *   （WorkBuddy 自己的 sidecar.pid 那几处是**别家**写的，不在此列。） */
    const bad = SERVER.match(/path\.join\(\s*os\.tmpdir\(\)\s*,\s*"(?:bai-|qoder-)[^"]*"/g);
    assert.equal(bad, null, `★ 还有文件落在系统盘临时目录：${JSON.stringify(bad)}`);
  });

  test("② 数据目录可以被指定（BAI_DATA_DIR）—— 用户能把本项目整个挪到别的盘", () => {
    assert.ok(/const DATA_DIR = process\.env\.BAI_DATA_DIR \|\| HERE/.test(SERVER),
      "server.mjs 认 BAI_DATA_DIR");
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
});
