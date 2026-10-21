import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { assertCleanSource, assertRemoteSource } = require("./publish-source.cjs");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const TAG_OBJECT = "c".repeat(40);
const repository = "https://github.com/example/router.git";

test("干净工作区返回完整 HEAD，检查包含未追踪源码", () => {
  const calls = [];
  const head = assertCleanSource((args) => {
    calls.push(args);
    return args[0] === "rev-parse" ? HEAD + "\n" : "";
  });
  assert.equal(head, HEAD);
  assert.deepEqual(calls[1], ["status", "--porcelain", "--untracked-files=all"]);
});

for (const dirty of [" M src/server/server.mjs", "M  package.json", "?? src/server/new-bridge.mjs"]) {
  test(`未提交来源必须拒绝：${dirty}`, () => {
    assert.throws(() => assertCleanSource((args) => args[0] === "rev-parse" ? HEAD : dirty), /提交并推送后重试/);
  });
}

test("无有效 HEAD 与构建期间 HEAD 改变必须拒绝", () => {
  assert.throws(() => assertCleanSource(() => ""), /无法确认本地 HEAD/);
  assert.throws(() => assertCleanSource(() => OLD, HEAD), /HEAD 已改变/);
});

test("查询发布仓库实时 main；缺失或落后拒绝", () => {
  const expected = ["ls-remote", repository, "refs/heads/main", "refs/tags/v1.0.82", "refs/tags/v1.0.82^{}"];
  const inspect = (output) => assertRemoteSource((args) => {
    assert.deepEqual(args, expected);
    return output;
  }, { repository, head: HEAD, tag: "v1.0.82" });
  inspect(`${HEAD}\trefs/heads/main\n`);
  assert.throws(() => inspect(""), /main 与本地 HEAD 不一致/);
  assert.throws(() => inspect(`${OLD}\trefs/heads/main\n`), /main 与本地 HEAD 不一致/);
});

test("已有 lightweight 与 annotated tag 必须对应发布 HEAD", () => {
  const inspect = (tagRefs) => assertRemoteSource(() => `${HEAD}\trefs/heads/main\n${tagRefs}`, { repository, head: HEAD, tag: "v1.0.82" });
  inspect(`${HEAD}\trefs/tags/v1.0.82\n`);
  inspect(`${TAG_OBJECT}\trefs/tags/v1.0.82\n${HEAD}\trefs/tags/v1.0.82^{}\n`);
  assert.throws(() => inspect(`${OLD}\trefs/tags/v1.0.82\n`), /指向其他提交/);
  assert.throws(() => inspect(`${TAG_OBJECT}\trefs/tags/v1.0.82\n${OLD}\trefs/tags/v1.0.82^{}\n`), /指向其他提交/);
});

test("无效远端响应与 Git 查询失败不能放行", () => {
  const options = { repository, head: HEAD, tag: "v1.0.82" };
  assert.throws(() => assertRemoteSource(() => "invalid", options), /远端引用响应无效/);
  assert.throws(() => assertRemoteSource(() => `${HEAD}\trefs/heads/main\n${OLD}\trefs/heads/main`, options), /远端引用响应无效/);
  assert.throws(() => assertRemoteSource(() => { throw new Error("network unavailable"); }, options), /network unavailable/);
});

// 执行真实 publish.cjs，但 fs/Git/构建/gh 全部注入假实现，绝不真正读配置、打包或发布。
const scriptPath = fileURLToPath(new URL("./publish.cjs", import.meta.url));
const script = readFileSync(scriptPath, "utf8");

function simulatePublish(options = {}) {
  const state = { built: false, dirty: Boolean(options.initialDirty), head: HEAD, remote: options.initialRemote || HEAD, writes: [], releases: [], queries: [], renames: [] };
  const fsFake = {
    existsSync(file) {
      if (String(file).endsWith(path.join("bai-router", "config.json"))) return Boolean(options.seedChanges);
      if (["ui.html", "sn.html", "wb.html", "zen.html", "qd.html"].some((old) => String(file).endsWith(path.sep + old))) return false;
      return true;
    },
    readFileSync(file) {
      if (String(file).endsWith("package.json")) return JSON.stringify({ version: options.version || "1.0.82", build: { publish: [{ owner: "example", repo: "router" }] } });
      if (String(file).endsWith("release-notes.md")) return "v1.0.82 test notes";
      return JSON.stringify({ availableModels: [] });
    },
    writeFileSync(file) { state.writes.push(file); state.dirty = true; },
    copyFileSync() { throw new Error("unexpected copy"); },
    /* 预发布版要把 dist/latest.yml 改名成 dist/beta.yml（清单内容不变，
     * 通道只由文件名决定）。这里记下来，好断言「改名这一步真的发生了」。 */
    renameSync(from, to) { state.renames.push([String(from), String(to)]); },
  };
  const childProcessFake = {
    execFileSync(command, args) {
      if (command === "git") {
        state.queries.push(args);
        if (args[0] === "rev-parse") return state.head;
        if (args[0] === "status") return state.dirty ? " M src/server/config.defaults.json\n" : "";
        if (args[0] === "ls-remote") return `${state.remote}\trefs/heads/main\n` + (options.tagHead ? `${options.tagHead}\trefs/tags/v1.0.82\n` : "");
        throw new Error("unexpected Git operation: " + args[0]);
      }
      if (command === "gh") { state.releases.push(args); return ""; }
      if (command === process.execPath && args[0].endsWith("check-manifest.cjs")) return "";
      throw new Error("unexpected command: " + command);
    },
    execSync(command) {
      if (command === "npx electron-builder --win nsis") {
        state.built = true;
        if (options.buildDirty) state.dirty = true;
        if (options.buildChangesHead) state.head = OLD;
        if (options.buildChangesRemote) state.remote = OLD;
        return Buffer.from("");
      }
      if (command.startsWith("npx --yes @electron/asar l ")) return Buffer.from("/src/main.js\n/src/preload.js\n/src/install-consistency.js\n");
      throw new Error("unexpected shell operation");
    },
  };
  const sandbox = {
    __dirname: path.dirname(scriptPath),
    process: { execPath: process.execPath, env: { APPDATA: path.join(path.dirname(scriptPath), "fake-user") }, argv: ["node", scriptPath] },
    console: { log() {}, error() {} },
    require(name) {
      if (name === "child_process") return childProcessFake;
      if (name === "fs") return fsFake;
      if (name === "path") return path;
      if (name === "./publish-source.cjs") return { assertCleanSource, assertRemoteSource };
      /* publish-seed.cjs 是**纯函数模块**（不碰文件、不联网、不读环境变量），
       * 所以这里直接用**真的**那份——替身只会让「快照同步」这段测不到真逻辑。
       * ⚠ 它的存在本身就是那 8 个用例的依赖：publish.cjs 一 require 它，
       *   替身没这一条就会抛 "unexpected dependency"，全部用例一起红。 */
      if (name === "./publish-seed.cjs") return require("./publish-seed.cjs");
      /* src/update-channel.js 同样是**纯函数模块**（不碰文件、不联网、不读环境变量），
       * 它只管「版本号算通道」这一个判据，所以直接用真的那份。 */
      if (name === "../src/update-channel.js") return require("../src/update-channel.js");
      if (name === "./publish-proxy.cjs") return { decideProxyUse: () => ({ useProxy: false, reason: "fake probe" }), buildGhEnv: (env) => ({ ...env }), runDirectProbe: () => ({ ok: true }) };
      throw new Error("unexpected dependency");
    },
  };
  try { vm.runInNewContext(script, sandbox, { filename: scriptPath, timeout: 2000 }); }
  catch (error) { state.error = error; }
  return state;
}

test("真实发布入口在干净且同步时构建，并用 --target 绑定完整本地 HEAD", () => {
  const state = simulatePublish();
  assert.equal(state.error, undefined);
  assert.equal(state.built, true);
  assert.equal(state.releases.length, 1);
  const args = state.releases[0];
  assert.equal(args[args.indexOf("--target") + 1], HEAD);
  assert.equal(state.queries.filter((args) => args[0] === "status").length, 3);
  assert.equal(state.queries.filter((args) => args[0] === "ls-remote").length, 2);
});

test("稳定版上传 latest.yml，不标 prerelease", () => {
  const state = simulatePublish({ version: "1.0.93" });
  assert.equal(state.error, undefined);
  const args = state.releases[0];
  assert.ok(args.includes("dist/latest.yml"), "稳定版必须上传 latest.yml");
  assert.ok(!args.includes("dist/beta.yml"), "稳定版不该上传 beta.yml");
  assert.ok(!args.includes("--prerelease"), "稳定版不该标 prerelease");
  assert.ok(args.includes("dist/rollback.ps1"), "回退脚本要随每个版本发布");
});

test("预发布版只上传 beta.yml 并标 prerelease——绝不能碰 latest.yml", () => {
  const state = simulatePublish({ version: "1.0.93-beta.1" });
  assert.equal(state.error, undefined);
  const args = state.releases[0];
  assert.ok(args.includes("dist/beta.yml"), "预发布版要上传 beta.yml");
  /* ⚠ 这条最要紧：latest.yml 是**稳定版用户唯一读的那份**。预发布版要是也上传了
   * latest.yml，就等于把测试版推给了所有稳定版用户——那不叫「选择性升级」。 */
  assert.ok(!args.includes("dist/latest.yml"), "预发布版绝不能上传 latest.yml");
  assert.ok(args.includes("--prerelease"), "预发布版要在 GitHub 上标 prerelease，免得占住 Latest");
  /* 改名这一步本身也要发生：electron-builder 产的是 latest.yml（文件名跟的是
   * publish.channel，不是版本号），发布脚本得把它改名成 beta.yml 才上传得动。 */
  const renamed = state.renames.find(([from, to]) => /latest\.yml$/.test(from) && /beta\.yml$/.test(to));
  assert.ok(renamed, `预发布版必须把 dist/latest.yml 改名成 dist/beta.yml，实际改名记录：${JSON.stringify(state.renames)}`);
});

test("稳定版不改名，也不碰 beta.yml", () => {
  const state = simulatePublish({ version: "1.0.93" });
  assert.equal(state.error, undefined);
  assert.equal(state.renames.length, 0, "稳定版不该改名——latest.yml 就是稳定版用户读的那份");
  const args = state.releases[0];
  assert.ok(args.includes("dist/latest.yml"), "稳定版必须上传 latest.yml");
  assert.ok(!args.includes("dist/beta.yml"), "稳定版不该上传 beta.yml");
});

for (const [name, options, expectedError, built] of [
  ["初始工作区脏", { initialDirty: true }, /提交并推送后重试/, false],
  ["远端 main 落后", { initialRemote: OLD }, /main 与本地 HEAD 不一致/, false],
  ["快照同步产生未提交源码", { seedChanges: true }, /config.defaults.json/, false],
  ["构建期间源码改变", { buildDirty: true }, /提交并推送后重试/, true],
  ["构建期间 HEAD 改变", { buildChangesHead: true }, /HEAD 已改变/, true],
  ["构建期间远端 main 改变", { buildChangesRemote: true }, /main 与本地 HEAD 不一致/, true],
  ["既有 tag 指向旧源码", { tagHead: OLD }, /指向其他提交/, false],
]) {
  test(`真实发布入口拒绝 ${name}，gh release create 不会执行`, () => {
    const state = simulatePublish(options);
    assert.match(state.error?.message || "", expectedError);
    assert.equal(state.built, built);
    assert.equal(state.releases.length, 0);
    if (options.seedChanges) assert.equal(state.writes.length, 1, "先同步 seed，再要求提交重试");
  });
}
