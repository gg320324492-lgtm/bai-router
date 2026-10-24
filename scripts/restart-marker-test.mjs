/**
 * 「主动退出」标记（scripts/restart-marker-test.mjs）
 *
 * ## 这测的是「老是被杀掉」的修法
 *
 * 桌面壳的看门狗只看「子进程退出」⇒ 分不清「它自己决定重启」与「它崩了」⇒
 * 于是代理切换（每 10 分钟探测一次，那台机器上 Clash 占了 7890 与 7897 两个端口，
 * 探测在两者之间来回跳）被计成崩溃 ⇒ 弹「服务已自动恢复运行」横幅 + 端口互抢。
 *
 * ## 测什么
 *
 * ★ ① **判定的行为**（真跑模块，不是看源码）：
 *   写 → 读 → 认得出；读完即删（一次性）；过期/坏 JSON/未来时间戳 ⇒ **不认**
 *   （宁可多报一次崩溃，也不许把真崩溃藏起来）。
 * ★ ② **接线**（源码断言）：服务端每个「自己决定退出」的点都留了标记；
 *   壳读到标记 ⇒ 不计崩溃、不弹横幅、仍然重拉。
 * ★ ③ **端到端**：真的 spawn 一个子进程 —— 它写标记后 exit(0) ⇒ 父进程读得到。
 *
 * ## 红线
 *
 * 落盘只在 os.tmpdir() 下的临时目录；不碰真实 %APPDATA%；不联网。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { readRestartReason, markIntentionalExit, markerPath, FRESH_MS } = require(
  path.join(REPO, "src", "server", "restart-marker.cjs")
);
const MAIN = fs.readFileSync(path.join(REPO, "src", "main.js"), "utf8");
const SERVER = fs.readFileSync(path.join(REPO, "src", "server", "server.mjs"), "utf8");

/** 一次性临时目录（用完就删）。 */
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bai-rm-${tag}-`));
  return d;
}

describe("主动退出标记：判定的行为", () => {
  test("① 写完能读回来，读完即删（一次性）", () => {
    const dir = tmpDir("basic");
    try {
      assert.equal(markIntentionalExit(dir, "proxy-changed"), true);
      assert.ok(fs.existsSync(markerPath(dir)), "标记文件应当在数据目录里");

      const m = readRestartReason(dir);
      assert.equal(m.intentional, true);
      assert.equal(m.reason, "proxy-changed");
      assert.equal(m.why, "ok");

      // 一次性：读完就删 ⇒ 再读就是「没有标记」
      assert.ok(!fs.existsSync(markerPath(dir)), "★ 读过的标记必须被删掉（一次性）");
      const m2 = readRestartReason(dir);
      assert.equal(m2.intentional, false);
      assert.equal(m2.why, "no-marker");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("② 没有标记 ⇒ 按崩溃处理（不是主动退出）", () => {
    const dir = tmpDir("none");
    try {
      const m = readRestartReason(dir);
      assert.equal(m.intentional, false);
      assert.equal(m.why, "no-marker");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("③ 过期标记不认（不许遮住真崩溃）", () => {
    const dir = tmpDir("stale");
    try {
      fs.writeFileSync(markerPath(dir),
        JSON.stringify({ reason: "proxy-changed", at: Date.now() - (FRESH_MS + 60000) }), "utf8");
      const m = readRestartReason(dir);
      assert.equal(m.intentional, false, "★ 过期的标记必须按崩溃处理");
      assert.equal(m.why, "stale");
      // 过期的也要删掉 —— 不然它会一直赖在那儿
      assert.ok(!fs.existsSync(markerPath(dir)), "过期标记也要删");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("④ 坏 JSON / 缺 reason / 未来时间戳 ⇒ 都不认", () => {
    const dir = tmpDir("bad");
    try {
      fs.writeFileSync(markerPath(dir), "{ 这不是 JSON", "utf8");
      assert.equal(readRestartReason(dir).why, "bad-json");

      fs.writeFileSync(markerPath(dir), JSON.stringify({ at: Date.now() }), "utf8");
      assert.equal(readRestartReason(dir).why, "no-reason");

      fs.writeFileSync(markerPath(dir), JSON.stringify({ reason: "x", at: Date.now() + 600000 }), "utf8");
      const m = readRestartReason(dir);
      assert.equal(m.intentional, false, "★ 未来时间戳（时钟跳变）不认");
      assert.equal(m.why, "stale");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("⑤ 写不出去也不抛（标记不该挡住退出）", () => {
    const dir = path.join(tmpDir("nowrite"), "根本不存在", "更深");
    assert.doesNotThrow(() => markIntentionalExit(dir, "proxy-changed"));
    assert.equal(markIntentionalExit(dir, "proxy-changed"), false);
  });
});

describe("主动退出标记：接线", () => {
  test("⑥ 服务端每个「自己决定退出」的点都留了标记", () => {
    /* 三类：代理切换 / NO_PROXY 自检 / 用户点的重启与停止（+ 升级安装）。 */
    for (const reason of ["proxy-changed", "no-proxy-selfcheck", "user-restart", "user-stop", "selfupdate-install"]) {
      assert.ok(SERVER.includes(`markIntentionalExit("${reason}")`),
        `★ 服务端没有在 ${reason} 处留标记`);
    }
    /* 标记必须写在 exit 之前（顺序反了就白搭）。 */
    for (const m of SERVER.matchAll(/markIntentionalExit\("([a-z-]+)"\);[\s\S]{0,120}?process\.exit\(0\)/g)) {
      assert.ok(m[1], "标记与 exit 的先后顺序反了");
    }
    const exits = (SERVER.match(/process\.exit\(0\)/g) || []).length;
    const marks = (SERVER.match(/markIntentionalExit\("/g) || []).length;
    assert.ok(marks >= 5, `★ 主动退出的标记点太少（${marks} 处）`);
    assert.ok(marks <= exits, `标记点比 exit 还多（${marks} > ${exits}）—— 有 exit 忘了留标记`);
  });

  test("⑦ 壳读到标记 ⇒ 不计崩溃、不弹横幅、仍然重拉", () => {
    const exitBlock = MAIN.slice(MAIN.indexOf('child.on("exit"'), MAIN.indexOf('child.on("exit"') + 3000);
    assert.ok(exitBlock.includes("readRestartReason()"), "★ 壳的 exit 处理没读标记");
    /* 主动退出的分支必须在崩溃计数**之前** return ⇒ 崩溃计数不碰它。 */
    const readAt = exitBlock.indexOf("readRestartReason()");
    const ifAt = exitBlock.indexOf("if (intentional)");
    const crashAt = exitBlock.indexOf("crashStreak++");
    assert.ok(ifAt > readAt && crashAt > ifAt,
      "★ 主动退出的分支必须排在崩溃计数之前（否则照样计崩溃）");
    /* 主动退出 ⇒ 静默重拉（不弹「服务已自动恢复运行」）。 */
    assert.ok(/if \(intentional\) \{[\s\S]{0,200}?respawnWithNotice\(true\)/.test(exitBlock),
      "★ 主动退出必须静默重拉（respawnWithNotice(true)）");
    /* 静默参数在 respawnWithNotice 里真的生效。 */
    assert.ok(/async function respawnWithNotice\(silent\) \{[\s\S]{0,400}?if \(silent\) return;/.test(MAIN),
      "★ respawnWithNotice 没认 silent ⇒ 主动退出照样弹「服务已自动恢复运行」");
  });

  test("⑧ 壳与服务端用的是**同一个**模块文件（形状不会漂）", () => {
    assert.ok(MAIN.includes("restart-marker.cjs"), "main.js 没收用共享模块");
    assert.ok(SERVER.includes('from "./restart-marker.cjs"'), "server.mjs 没收用共享模块");
    /* 打包时 server 目录整份复制 ⇒ 该文件必须在 extraResources 的白名单里。 */
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
    const filter = pkg.build.extraResources.find((x) => x.from === "src/server").filter;
    assert.ok(filter.includes("restart-marker.cjs"),
      "★ restart-marker.cjs 不在打包白名单里 ⇒ 装出来的版本壳读不到标记");
  });
});

describe("主动退出标记：端到端", () => {
  test("⑨ 真子进程写标记后退出 ⇒ 父进程读得到「主动退出」", async () => {
    const dir = tmpDir("e2e");
    try {
      /* 子进程：写标记 → exit(0)（与 server.mjs 的「主动退出」一模一样）。 */
      const script = `
        const { markIntentionalExit } = require(${JSON.stringify(path.join(REPO, "src", "server", "restart-marker.cjs"))});
        markIntentionalExit(${JSON.stringify(dir)}, "proxy-changed");
        process.exit(0);
      `;
      const code = await new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ["-e", script], { windowsHide: true });
        p.on("exit", (c) => resolve(c));
        p.on("error", reject);
      });
      assert.equal(code, 0);

      const m = readRestartReason(dir);
      assert.equal(m.intentional, true, "★ 端到端读不到主动退出标记");
      assert.equal(m.reason, "proxy-changed");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("⑩ 崩掉的子进程（没写标记）⇒ 父进程判定为崩溃", async () => {
    const dir = tmpDir("crash");
    try {
      const script = `process.exit(1);`;
      const code = await new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ["-e", script], { windowsHide: true });
        p.on("exit", (c) => resolve(c));
        p.on("error", reject);
      });
      assert.equal(code, 1);
      const m = readRestartReason(dir);
      assert.equal(m.intentional, false, "★ 崩溃被误判成主动退出 ⇒ 真崩溃会被藏起来");
      assert.equal(m.why, "no-marker");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
