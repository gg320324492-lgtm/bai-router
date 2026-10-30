/**
 * Qoder 补丁的**补丁态**与**活跃版本**判据（scripts/qoder-patch-state-test.mjs）
 *
 * ## 为什么单独开一份
 *
 * 2026-10-30 两个真缺陷，都只能靠真机踩到：
 *
 * **① 旧补丁态打不上补丁。**
 *   补丁把**落点路径硬编码进产物字节**（preamble）⇒ 落点一改（临时目录 → 数据目录）
 *   preamble 就变 ⇒ 旧补丁副本的 `isPatched` 变成 false ⇒ 而旧补丁已经把源码里的
 *   补丁点**替换掉**了 ⇒ 在那份文件上再找补丁点必然 0 处 ⇒ 「一键装补丁」会把
 *   每一份旧补丁副本报成「失败：该版本结构可能已改变」。
 *   ⇒ 修法是「认出旧补丁态 → 先从 .orig 还原 → 再打」。这个分支以前**没有测试能碰**
 *   （要 33MB 的真 worker 才走得到），所以把「补丁态」抽成纯函数 `patchState` 来测。
 *
 * **② 就绪判据问错了对象。**
 *   Qoder 升级会新增版本目录（`.qoder-versions/<新版本>/…`），补丁不会自动跟过去。
 *   面板原先只看「有几份副本带补丁」⇒ 老版本那份还带着、实际在跑的新版本没有 ⇒
 *   报「补丁已装」＝ 误报 ⇒ 令牌永远抓不到。
 *   ⇒ 判据改成「**版本号最大的那份**（活跃版本）也得带补丁」。
 *
 * ## ⚠ 活跃版本为什么不能按文件 mtime 判
 *
 * 打补丁本身会 writeFileSync ⇒ mtime 变成「现在」⇒ 刚打完补丁时「最新 mtime」
 * 指向的是**最后被打的那份**（根 resources 那份旧副本），而不是真正在跑的版本目录。
 * 版本号是稳定的 ⇒ 用版本号比大小。（实测本机：根 resources 那份带补丁、
 * 当天刚装的 0.5.1 那份没带 —— 按 mtime 判会挑错。）
 *
 * ## 红线
 *
 * 不 spawn、不联网、不碰真机上的 Qoder 安装。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(pathToFileURL(path.join(REPO, "src", "server", "qoder-patch.mjs")).href);
const { patchState, verCompare, qdFilePath, qpApply, PATCH_PREAMBLE, QODER_PATCH_PATHS } = mod;

/* 一个**能被 patchBytes 处理**的最小样本：它含补丁点按内容定位用的那个形状
 * （RX_ZRI）。真 worker 有 33MB，测试里造不出来 ⇒ 取一个形状相同的最小片段。 */
const PATCHABLE_ORIG = 'if(a&&b)return{url:c(d,e),path:e,authMode:"authenticated",headers:{...await f(a),"x-gw-user-id":b}};';

/* 「旧版补丁」的 preamble：与当前的不同（落点换了），但仍带 MARKER ⇒ 判为 stale。 */
const OLD_PREAMBLE = PATCH_PREAMBLE.replace(
  JSON.stringify(QODER_PATCH_PATHS.TOKFILE),
  JSON.stringify("C:\\Users\\pc\\AppData\\Local\\Temp\\qoder-token.json"));

/* 旧补丁样本：**带**补丁痕迹、但 preamble 与当前不同。
 * 真机上就是这样 —— 落点还是临时目录时打的那一份。 */
const STALE_SAMPLE = 'import{appendFileSync as __qHf,writeFileSync as __qWw}from"node:fs";'
  + 'const __qOut="C:\\Users\\pc\\AppData\\Local\\Temp\\qoder-hdr.jsonl",'
  + '__qTok="C:\\Users\\pc\\AppData\\Local\\Temp\\qoder-token.json";'
  + '__qW({t:Date.now(),note:"WORKER RUNTIME PATCHED",pid:process.pid});';

describe("① 补丁态：current / stale / none 三态分得清", () => {
  test("当前补丁产物 ⇒ current（会跳过，不重复打）", () => {
    assert.equal(patchState(PATCH_PREAMBLE + "rest of worker"), "current");
    assert.equal(patchState(PATCH_PREAMBLE), "current");
  });

  test("旧补丁产物（落点还是临时目录时打的）⇒ stale（要还原再重打）", () => {
    assert.equal(patchState(STALE_SAMPLE + "rest of worker"), "stale");
  });

  test("没打过补丁的原始文件 ⇒ none（直接打）", () => {
    assert.equal(patchState("var a=1;function f(){return a}"), "none");
    assert.equal(patchState(""), "none");
  });

  test("非字符串（Buffer 之类）⇒ none，不炸", () => {
    assert.equal(patchState(Buffer.from("x")), "none");
    assert.equal(patchState(null), "none");
    assert.equal(patchState(undefined), "none");
  });

  test("★ 旧补丁态必须判成 stale 而不是 current —— 否则改了落点就打不上补丁", () => {
    /* 回归钉子：这条判错的现象是「一键装补丁全部报失败」，只在真机上才看得见。 */
    assert.notEqual(patchState(STALE_SAMPLE), "current");
    assert.equal(patchState(STALE_SAMPLE), "stale");
  });
});

describe("② 补丁产物里的落点就是数据目录（落点写在字节里）", () => {
  test("preamble 里硬编码的令牌/模型路径 == 导出的落点", () => {
    /* ⚠ preamble 里嵌的是 **JSON.stringify 过的**路径（反斜杠被转义）⇒ 比对要
     *   同样 stringify 一遍。补丁运行时那一串是 JS 字面量，JSON.parse 得回原路径。 */
    assert.ok(PATCH_PREAMBLE.includes(JSON.stringify(QODER_PATCH_PATHS.TOKFILE)),
      "★ 补丁产物里没写令牌文件的落点 ⇒ 补丁写到别处去了");
    assert.ok(PATCH_PREAMBLE.includes(JSON.stringify(QODER_PATCH_PATHS.MODELFILE)),
      "★ 补丁产物里没写模型目录的落点");
  });

  test("三个产物都在同一个目录里（数据目录）", () => {
    const dir = path.dirname(QODER_PATCH_PATHS.TOKFILE);
    assert.equal(path.dirname(QODER_PATCH_PATHS.MODELFILE), dir);
    assert.equal(path.dirname(QODER_PATCH_PATHS.OUT), dir);
    assert.equal(path.basename(QODER_PATCH_PATHS.TOKFILE), "qoder-token.json");
    assert.equal(path.basename(QODER_PATCH_PATHS.MODELFILE), "qoder-models.json");
    assert.equal(path.basename(QODER_PATCH_PATHS.OUT), "qoder-hdr.jsonl");
  });
});

describe("③ 活跃版本判据：按版本号比大小，不按文件 mtime", () => {
  test("版本号大的那份算活跃版本", () => {
    assert.ok(verCompare("0.5.1", "0.4.11") > 0, "0.5.1 应比 0.4.11 新");
    assert.ok(verCompare("0.4.11", "0.4.8") > 0, "0.4.11 应比 0.4.8 新");
    assert.ok(verCompare("0.10.0", "0.9.9") > 0, "0.10.0 应比 0.9.9 新（别按字符串比）");
    assert.equal(verCompare("0.5.1", "0.5.1"), 0);
  });

  test("根 resources 那份（记作 (root)）永远算最旧", () => {
    assert.ok(verCompare("0.4.8", "(root)") > 0, "版本目录里的任何一份都比根副本新");
    assert.ok(verCompare("(root)", "(root)") === 0);
  });

  test("★ 活跃版本必须比根副本新 —— 根 resources 那份带着补丁不代表在跑的那份带着", () => {
    /* 回归钉子：本机实测根 resources 带补丁、当天装的 0.5.1 没带。
     * 只按份数报「补丁已装」就会误报。 */
    assert.ok(verCompare("0.5.1", "(root)") > 0);
  });
});

describe("④ 路径归位规则（qdFilePath）：落点只有一处出处", () => {
  /* 这一组是「落点分叉」的正面防线。分叉过一次的现象是：新机上补丁明明装好了，
   * 面板永远显示「未读到」—— 因为补丁写临时目录、中转读数据目录。 */
  const DATA = path.join(REPO, "src", "server");   // 拿源码目录当"数据目录"
  const def = path.join(DATA, "qoder-token.json");

  test("空串 / 非字符串 ⇒ 默认落点（出厂种子就是空串）", () => {
    assert.equal(qdFilePath("", "qoder-token.json", DATA), def);
    assert.equal(qdFilePath("   ", "qoder-token.json", DATA), def);
    assert.equal(qdFilePath(undefined, "qoder-token.json", DATA), def);
    assert.equal(qdFilePath(null, "qoder-token.json", DATA), def);
  });

  test("已经是默认落点 ⇒ 原样留着（幂等）", () => {
    assert.equal(qdFilePath(def, "qoder-token.json", DATA), def);
  });

  test("★ 旧落点（本机临时目录下的同名文件）⇒ 归位", () => {
    /* 这条是核心：config.json 里躺着旧配置时，不归位就永远读不到令牌。 */
    const old = path.join(os.tmpdir(), "qoder-token.json");
    assert.equal(qdFilePath(old, "qoder-token.json", DATA), def);
  });

  test("从别的机器带来的死路径（父目录在本机不存在）⇒ 归位", () => {
    const dead = path.join(path.parse(process.cwd()).root, "no-such-dir-for-qd-test", "qoder-token.json");
    assert.equal(qdFilePath(dead, "qoder-token.json", DATA), def);
  });

  test("★ 临时目录下的旧落点 ⇒ 归位（不依赖 os.tmpdir() 的当前值）", () => {
    /* ⚠ 判据不能依赖 os.tmpdir()：TEMP 环境变量一改（用户改、别的软件改、
     *   跑在别的壳里）就判不中 ⇒ 老配置继续指着死路径 ⇒ 白归位。
     *   所以规则是「一律归位」，不是「看形状猜」。 */
    const old = path.join(os.tmpdir(), "qoder-token.json");
    assert.equal(qdFilePath(old, "qoder-token.json", DATA), def);
    const other = path.join("C:\\Users\\someone-else\\AppData\\Local\\Temp", "qoder-token.json");
    assert.equal(qdFilePath(other, "qoder-token.json", DATA), def);
  });

  test("用户自己指的一个目录 ⇒ 也归位（补丁落点硬编码在补丁字节里，不读 config）", () => {
    /* 这个字段不是用户能设的：面板只显示不可编辑、种子与 publish-seed 每次清空它。
     * 而补丁的落点硬编码在补丁字节里 ⇒ 用户把它指到别处，补丁也不写在那儿
     * ⇒ 尊重它只会得到「读不到令牌」。 */
    const dir = path.join(os.tmpdir(), "qd-own-dir-test");
    fs.mkdirSync(dir, { recursive: true });
    const own = path.join(dir, "qoder-token.json");
    assert.equal(qdFilePath(own, "qoder-token.json", DATA), def);
  });

  test("临时目录下的**别的**文件名 ⇒ 也归位（规则不按文件名挑食）", () => {
    const other = path.join(os.tmpdir(), "some-other-file.json");
    assert.equal(qdFilePath(other, "qoder-token.json", DATA), def);
  });
});

describe("⑤ 一键装补丁：旧补丁态会自动「先还原再重打」", () => {
  /* 这是改落点后**必走**的一条路：落点写在补丁字节里 ⇒ 落点一改，preamble 就变
   * ⇒ 旧补丁副本的补丁点早已被替换掉 ⇒ 直接在上面找补丁点必然 0 处。
   * 少了「认出旧补丁态 → 从 .orig 还原 → 再打」这一步，改落点后第一次点
   * 「一键装补丁」会把所有旧补丁副本报成「失败：该版本结构可能已改变」。
   *
   * ⚠ 真 worker 有 33MB，测试里造不出来 ⇒ 这里造**形状相同**的最小样本，
   *   走的是同一段代码路径（qpApply 的 targetsOverride 注入入口）。 */
  let dir = "";
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "qd-patch-test-")); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } });

  test("带旧补丁 + 有 .orig 备份 ⇒ 还原后重打成功", () => {
    const file = path.join(dir, "worker.mjs");
    fs.writeFileSync(file, OLD_PREAMBLE + "/* 已被旧补丁改过的源码 */", "latin1");
    fs.writeFileSync(file + ".orig", PATCHABLE_ORIG, "latin1");

    const r = qpApply([{ ver: "test", file }]);
    assert.equal(r.fail, 0, `★ 旧补丁态被打成失败：${JSON.stringify(r.results)}`);
    assert.equal(r.ok, 1);
    assert.equal(r.refreshed, 1, "★ 没认出这是旧补丁态（该先还原再重打）");

    const after = fs.readFileSync(file, "latin1");
    assert.ok(after.startsWith(PATCH_PREAMBLE), "★ 重打后不是当前版本的补丁");
    assert.equal(patchState(after), "current");
  });

  test("带旧补丁 + 没有 .orig 备份 ⇒ 明确报错，并告诉用户下一步", () => {
    const file = path.join(dir, "worker2.mjs");
    fs.writeFileSync(file, OLD_PREAMBLE + "x", "latin1");
    const r = qpApply([{ ver: "test", file }]);
    assert.equal(r.ok, 0);
    assert.equal(r.fail, 1);
    assert.ok(/还原/.test(r.results[0].note || ""),
      `★ 报错没告诉用户下一步做什么：${r.results[0].note}`);
  });

  test("已经是当前补丁 ⇒ 跳过，不重打（幂等）", () => {
    const file = path.join(dir, "worker3.mjs");
    fs.writeFileSync(file, PATCH_PREAMBLE + "x", "latin1");
    const r = qpApply([{ ver: "test", file }]);
    assert.equal(r.already, 1);
    assert.equal(r.refreshed, 0);
    assert.equal(r.fail, 0);
  });

  test("从没打过补丁的原始文件 ⇒ 直接打，不还原", () => {
    const file = path.join(dir, "worker4.mjs");
    fs.writeFileSync(file, PATCHABLE_ORIG, "latin1");
    const r = qpApply([{ ver: "test", file }]);
    assert.equal(r.fail, 0, `★ 原始文件打不上：${JSON.stringify(r.results)}`);
    assert.equal(r.ok, 1);
    assert.equal(r.refreshed, 0, "★ 不该走还原路径");
    assert.equal(patchState(fs.readFileSync(file, "latin1")), "current");
  });
});
