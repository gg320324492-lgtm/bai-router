/**
 * CLI 接线：ANTHROPIC_BASE_URL 的两个缺陷（v1.0.78）
 *
 * ## 背景
 *
 * 桌面版（applyToDesktop）**一律**写 `http://127.0.0.1:<relayPort>`，所以桌面版没事。
 * 问题全在 applyToCli：
 *
 *   ① Zen 的默认上游**自带 /v1**（https://opencode.ai/zen/v1），而 Claude Code 会在
 *      BASE_URL 后面自己拼 `/v1/messages` → `/zen/v1/v1/messages`。实测那条 URL 返回的是
 *      404 的 SPA 兜底 **HTML**（压根不是 API 响应），去掉 /v1 之后才是正确的
 *      FreeTierError JSON。
 *   ② `transport=opencode`（v1.0.75 加的）在命令行里是**死的**：zen 不在 isBridgeChannel
 *      的静态名单里，CLI 的 BASE_URL 永远直连上游，压根不经过我们的中转。
 *
 * ## 测什么
 *
 *   ① BASE_URL 拼上 /v1/messages 后绝不许出现 /v1/v1/（zen / bai / sn 各一次）
 *   ② cfg.zen.upstream 逐字未变，**且中转内部仍拿它拼 /zen/v1/chat/completions**（假上游录路径）
 *   ③ transport=opencode → CLI 指向中转端口 + PROXY_MANAGED
 *   ④ transport=direct 仍直连上游（修 ② 不能把这一格改掉）+ 切回去不用重启
 *   ⑤ 其余六家的 env 块与**改动前**逐字一致（与 git HEAD 基线对拍，端口归一化后 deepEqual）
 *   ⑥ 反向对照：真起一个「去尾部 /v1 那步被删掉」的突变体 server，① 的判据必须当场变红
 *
 * ## 「改动前」基线怎么来的
 *
 * `git show HEAD:src/server/...` 把 HEAD 那份 src/server 原样落到临时目录起一份真 server，
 * 与工作区那份跑**完全相同**的一串接线，逐字对拍。不 stash、不改工作区、不 checkout。
 *
 * ## 红线
 *
 * 🔴 全文没有一个真实令牌/API key（全是 `*-dummy-not-a-real-*` 之类的占位）。
 * 🔴 落盘只在 os.tmpdir() 下的临时目录：**BAI_DATA_DIR**（配置）与 **USERPROFILE**
 *    （`.claude/settings.json` 落点）都被指到临时目录，**绝不碰真实的 %APPDATA%\bai-router
 *    与真实的 ~/.claude**。起进程前会先断言「子进程里的 os.homedir() 确实被改道」，
 *    断言不成立就**拒绝起进程**（Windows 上 os.homedir() 认 USERPROFILE，已实测）。
 * ⚠ 起 server.mjs 一律带 BAI_NO_PROXY_AUTODETECT=1（否则会自探测代理并自重启换实例）。
 * ⚠ 进程只按 **PID** 收（taskkill /PID），绝不用 /IM。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SRC_DIR = path.join(REPO, "src", "server");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-cli-baseurl-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 明显不是真凭据的占位值。红线：绝不把真 Key 写进任何文件 / 命令行 / 日志。 */
const DUMMY = {
  bai: "bai_dummy-not-a-real-key",
  sn: "sn_dummy-not-a-real-key",
  zen: "zen_dummy-not-a-real-key",
  wb: "wb_dummy.not-a-real-jwt",
  wbai: "wbai_dummy.not-a-real-jwt",
  qd: "qd_dummy-not-a-real-token",
  or: "sk-or-v1-dummy-not-a-real-key",
};
const PROXY_MANAGED = "PROXY_MANAGED";
const ZEN_UPSTREAM = "https://opencode.ai/zen/v1";
/** 去掉尾部 /v1 之后，Claude Code 拼出来的地址必须正好是这一条。 */
const ZEN_WANTED = "https://opencode.ai/zen/v1/messages";
/** 反向对照要删掉的**那一步**（源文件里必须逐字存在，否则本文件自己就失效了）。 */
const STRIP_STEP = `.replace(/\\/v1$/i, "")`;

const SPAWNED_PIDS = new Set();
function killByPid(pid) {
  try { spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* 已退出 */ }
}
process.on("exit", () => { for (const pid of [...SPAWNED_PIDS]) killByPid(pid); });

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

async function freePorts(n) {
  const servers = [], ports = [];
  for (let i = 0; i < n; i++) {
    const s = http.createServer();
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    ports.push(s.address().port);
    servers.push(s);
  }
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}
function live(port) {
  return new Promise((r) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.on("connect", () => { s.destroy(); r(true); });
    s.on("error", () => r(false));
    setTimeout(() => { try { s.destroy(); } catch { } r(false); }, 1500);
  });
}
function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else writeFileSync(d, readFileSync(s));   // Buffer 进 Buffer 出，二进制也不失真
  }
}

/**
 * ① 的判据。单独抽出来，⑥ 反向对照复用**同一份**——否则"测试自己也会红"就成了空话。
 * 返回拼好的完整地址，方便直接断言它到底是哪一条。
 */
function assertNoDoubleV1(env, label) {
  const url = String(env.ANTHROPIC_BASE_URL || "") + "/v1/messages";
  assert.ok(!/\/v1\/v1\//.test(url), `★ ${label}：BASE_URL 拼上 /v1/messages 之后出现了 /v1/v1/ —— ${url}`);
  return url;
}

/* ------------------------------------------------------------------ *
 * 三份 server 树
 *   before = git HEAD 的 src/server   （改动的逐字基线）
 *   after  = 工作区的 src/server     （本次改动）
 *   mutant = 工作区去掉「去尾部 /v1」那一步（⑥ 的反向对照）
 * ------------------------------------------------------------------ */

const TREES = {};
function snapshotHead(dir) {
  const files = execFileSync("git", ["-C", REPO, "ls-tree", "-r", "HEAD", "--name-only", "--", "src/server"], { encoding: "utf8" })
    .split("\n").filter(Boolean);
  for (const f of files) {
    const out = execFileSync("git", ["-C", REPO, "show", `HEAD:${f}`], { maxBuffer: 64 << 20 });   // Buffer，别转字符串
    const dst = path.join(dir, f.slice("src/server/".length));
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, out);
  }
  return files.length;
}

/* ------------------------------------------------------------------ *
 * 起一份真 server.mjs（临时 DATA_DIR + 临时 USERPROFILE + 17xxx 段端口）
 * ------------------------------------------------------------------ */

async function bootServer(treeDir, tag, mutate) {
  const ports = await freePorts(10);
  const P = {
    bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3],
    zen: ports[4], qd: ports[5], or: ports[6], panel: ports[7], fake: ports[8],
  };
  const root = path.join(TMPROOT, tag);
  const dataDir = path.join(root, "data");
  const home = path.join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(home, ".claude"), { recursive: true });   // applyToCli 不会自己建目录

  const cfg = JSON.parse(readFileSync(path.join(treeDir, "config.defaults.json"), "utf8"));
  cfg.failover = { ...(cfg.failover || {}), enabled: false };
  /* cfg.proxy 预置：applyProxy 首行会因「没变」短路，不自重启换实例（与 oc-wiring-test 同一条纪律）。 */
  cfg.proxy = "http://127.0.0.1:7897";
  cfg.apiKey = DUMMY.bai;
  cfg.sn = { ...cfg.sn, apiKey: DUMMY.sn };
  cfg.zen = { ...cfg.zen, apiKey: DUMMY.zen };
  cfg.wb = { ...cfg.wb, accessToken: DUMMY.wb };
  cfg.wbai = { ...cfg.wbai, accessToken: DUMMY.wbai };
  cfg.qd = { ...cfg.qd, token: DUMMY.qd };        // 手动令牌：/api/apply 不用再去读令牌文件
  cfg.or = { ...cfg.or, keys: [DUMMY.or] };
  if (mutate) mutate(cfg, P);
  /* 端口**最后**统一改写：mutate 若整块替换了某个渠道子对象，会把出厂端口（157xx，真实
   * 装机正在用的）带回来 —— 那绝不能去抢。 */
  cfg.relayPort = P.bai; cfg.panelPort = P.panel;
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "or"]) cfg[k] = { ...cfg[k], relayPort: P[k] };
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));
  /* 可选：先在临时 HOME 里放一份「已经接到 zen 中转上」的 settings.json，让 cliMode 认得
   * 当前接的是 zen（面板保存配置后的自动重应用走的就是这条「curCli === P」判据）。 */
  if (mutate && mutate.__seedCliToZen) {
    writeFileSync(path.join(home, ".claude", "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${P.zen}`, ANTHROPIC_AUTH_TOKEN: PROXY_MANAGED } }, null, 2) + "\n");
  }

  const env = {
    ...process.env,
    BAI_DATA_DIR: dataDir,
    USERPROFILE: home,                  // ← os.homedir() 在 Windows 上认它 → SETTINGS 落点被改道
    NODE_USE_ENV_PROXY: "1",
    BAI_ENV_FIXED: "1",
    BAI_NO_PROXY_AUTODETECT: "1",       // ⚠ 硬性要求：不设它会自探测代理并自重启
  };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
  env.NO_PROXY = "127.0.0.1,localhost";

  /* 🔴 红线闸门：先证明子进程里的 HOME 确实被改道了，再允许它起。
   * 万一哪天 Node 改了 homedir() 的取值顺序，这里当场拒绝 —— 宁可测试失败，
   * 也绝不能让测试往用户真实的 ~/.claude/settings.json 里写。 */
  const probeHome = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"], { env }).toString();
  assert.equal(path.resolve(probeHome), path.resolve(home),
    `子进程的 os.homedir() 没被改道（拿到 ${probeHome}，期望 ${home}）——拒绝起进程，绝不写用户的真实 ~/.claude`);

  const out = [], err = [];
  const child = spawn(process.execPath, [path.join(treeDir, "server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => err.push(String(d)));
  SPAWNED_PIDS.add(child.pid);

  const api = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${P.panel}${p}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const settingsFile = path.join(home, ".claude", "settings.json");
  const readEnv = () => (existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")).env || {}) : {});
  const readCfg = () => JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8"));

  const kill = () => {
    killByPid(child.pid);
    SPAWNED_PIDS.delete(child.pid);
    /* 杀掉子进程后**必须拆管道**：挂着的话本文件的 event loop 一直有活干，
     * node --test 的子进程退不出来，外层永远等不到汇总行。 */
    try { child.stdout.destroy(); child.stderr.destroy(); } catch { }
    try { child.removeAllListeners("data"); } catch { }
  };

  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 60000) {
    try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json())).service?.up) { up = true; break; } } catch { /* 还没起来 */ }
    await sleep(300);
  }
  if (!up) { kill(); throw new Error(`server.mjs(${tag}) 60 秒内没把面板端口起起来。\nstdout 尾：${out.join("").slice(-1500)}\nstderr 尾：${err.join("").slice(-1500)}`); }
  while (!(await live(P.zen)) && Date.now() - t0 < 90000) await sleep(200);
  if (!(await live(P.zen))) { kill(); throw new Error(`中转端口 ${P.zen} 没起来（${tag}）。\nstdout 尾：${out.join("").slice(-1500)}`); }

  return { P, dataDir, home, out, api, readEnv, readCfg, kill };
}

/** 走真实的 /api/apply 接口接线一家，并把接线后的 env 块记下来。 */
async function applyProvider(srv, provider) {
  const r = await srv.api("/api/apply", { provider, cli: true, desktop: false });
  assert.equal(r.status, 200, `/api/apply ${provider} 失败（${r.status}）：${JSON.stringify(r.json).slice(0, 300)}`);
  return srv.readEnv();
}

/** 改动前后跑**完全相同**的一串接线，产出可逐字对拍的快照。 */
async function runApplySeq(srv) {
  const snap = {};
  snap.zenDirect = await applyProvider(srv, "zen");          // 出厂 transport=direct
  for (const p of ["bai", "sn", "wb", "wbai", "qd", "or"]) snap[p] = await applyProvider(srv, p);

  let r = await srv.api("/api/config", { provider: "zen", transport: "opencode" });
  assert.equal(r.status, 200, `保存 transport=opencode 失败：${JSON.stringify(r.json).slice(0, 200)}`);
  snap.zenOpencode = await applyProvider(srv, "zen");

  r = await srv.api("/api/config", { provider: "zen", transport: "direct" });
  assert.equal(r.status, 200, `保存 transport=direct 失败：${JSON.stringify(r.json).slice(0, 200)}`);
  snap.zenDirectAgain = await applyProvider(srv, "zen");    // 切回来不用重启
  return snap;
}

/** 端口是每次随机挑的，对拍前先归一化——其余字段必须逐字相同。 */
function normalize(env, P) {
  let s = JSON.stringify(env);
  for (const k of ["bai", "sn", "wb", "wbai", "zen", "qd", "or", "panel"]) s = s.split(String(P[k])).join(`<port:${k}>`);
  return JSON.parse(s);
}

/* ================================================================== *
 * ①②③④⑤：真 server.mjs，接线前后逐字对拍
 * ================================================================== */
describe("CLI 接线：BASE_URL 与传输开关（真 server.mjs × 2：HEAD 基线 vs 工作区）", () => {
  let base, work;
  before(async () => {
    base = await bootServer(TREES.before, "before");
    work = await bootServer(TREES.after, "after");
    base.snap = await runApplySeq(base);
    work.snap = await runApplySeq(work);
  }, { timeout: 240000 });
  after(() => { try { base && base.kill(); } catch { } try { work && work.kill(); } catch { } });

  test("① 证据表：改动前后各家 BASE_URL 拼上 /v1/messages 之后到底是什么", () => {
    const row = (tag, snap, P) => [
      `  ${tag.padEnd(7)}`,
      `zen:direct     ${(snap.zenDirect.ANTHROPIC_BASE_URL + "/v1/messages").padEnd(42)}`,
      `zen:opencode   ${(snap.zenOpencode.ANTHROPIC_BASE_URL + "/v1/messages").replace(new RegExp(String(P.zen)), "<zen中转>").padEnd(42)}`,
      `bai ${(snap.bai.ANTHROPIC_BASE_URL + "/v1/messages").padEnd(39)}`,
      `sn  ${(snap.sn.ANTHROPIC_BASE_URL + "/v1/messages").padEnd(39)}`,
      `wb/wbai/qd/or → ${snap.wb.ANTHROPIC_BASE_URL} / ${snap.wbai.ANTHROPIC_BASE_URL} / ${snap.qd.ANTHROPIC_BASE_URL} / ${snap.or.ANTHROPIC_BASE_URL}`,
    ].join(" ");
    const tok = (e) => (e === PROXY_MANAGED ? "PROXY_MANAGED(托管)" : "真key(占位)");
    console.log("\n[BASE_URL + '/v1/messages']\n"
      + row("HEAD", base.snap, base.P) + "\n"
      + row("工作区", work.snap, work.P) + "\n"
      + "  token  zen:direct=" + tok(work.snap.zenDirect.ANTHROPIC_AUTH_TOKEN)
      + " zen:opencode=" + tok(work.snap.zenOpencode.ANTHROPIC_AUTH_TOKEN)
      + " （HEAD 的 zen:opencode=" + tok(base.snap.zenOpencode.ANTHROPIC_AUTH_TOKEN) + "）\n"
      + "  cfg.zen.upstream  HEAD/工作区 = " + ZEN_UPSTREAM + "（逐字未变，中转仍拼 /zen/v1/chat/completions）");
    assert.ok(true);
  });

  test("① zen 直连：BASE_URL 去掉尾部 /v1，拼出来正好是 /zen/v1/messages", () => {
    const env = work.snap.zenDirect;
    assert.equal(env.ANTHROPIC_BASE_URL, "https://opencode.ai/zen", "BASE_URL 必须去掉尾部 /v1（尾部斜杠也一并去掉）");
    assert.equal(assertNoDoubleV1(env, "zen"), ZEN_WANTED, "拼 /v1/messages 之后必须正好是 /zen/v1/messages");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, DUMMY.zen, "直连必须带 Zen 的真 key（不是占位符）");

    // 改动前的样子也要留证：这才是「改之前确实是坏的」的事实，不是推断
    assert.equal(base.snap.zenDirect.ANTHROPIC_BASE_URL, ZEN_UPSTREAM,
      "HEAD 基线里 zen 的 BASE_URL 应当仍带 /v1 —— 如果基线本身就已经是修好的，这个测试就没有对照意义了");
    assert.equal(base.snap.zenDirect.ANTHROPIC_BASE_URL + "/v1/messages", "https://opencode.ai/zen/v1/v1/messages");
  });

  test("① bai / sn：本就没有 /v1，不许被这次改动误伤", () => {
    for (const [p, want, wantUrl] of [
      ["bai", "https://api.b.ai", "https://api.b.ai/v1/messages"],
      ["sn", "https://token.sensenova.cn", "https://token.sensenova.cn/v1/messages"],
    ]) {
      const env = work.snap[p];
      assert.equal(env.ANTHROPIC_BASE_URL, want, `${p} 的 BASE_URL 必须逐字不变`);
      assert.equal(assertNoDoubleV1(env, p), wantUrl, `${p} 拼 /v1/messages 的结果不对`);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, DUMMY[p], `${p} 直连必须带自己的真 key`);
    }
  });

  test("② cfg.zen.upstream 逐字未变（接线走了一整圈之后）", () => {
    assert.equal(TREES.afterDefaultZenUpstream, ZEN_UPSTREAM, "config.defaults.json 的 zen.upstream 不该被这次改动碰到");
    assert.equal(work.readCfg().zen.upstream, ZEN_UPSTREAM,
      "★ 接线 + 两次 transport 切换之后，落盘配置里的 zen.upstream 必须逐字未变（只准改写给客户端的那一份）");
    assert.equal(base.readCfg().zen.upstream, ZEN_UPSTREAM, "HEAD 基线同样是这一条");
    assert.notEqual(work.snap.zenDirect.ANTHROPIC_BASE_URL, ZEN_UPSTREAM, "客户端那份才是被改的那一份");
  });

  test("③ transport=opencode：CLI 指向中转端口 + 托管令牌（改动前是死的）", () => {
    const env = work.snap.zenOpencode;
    assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${work.P.zen}`,
      "opencode 档的 CLI 必须指向 zen 自己的中转端口——不经过中转，这个传输开关在命令行里就是死的");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, PROXY_MANAGED, "走桥时写占位符，不写真凭据");
    assert.equal(env.ANTHROPIC_BASE_URL + "/v1/messages", `http://127.0.0.1:${work.P.zen}/v1/messages`);

    // 改动前：同一个配置下 CLI 仍然直连上游（bug ② 的事实）
    assert.equal(base.snap.zenOpencode.ANTHROPIC_BASE_URL, ZEN_UPSTREAM,
      "HEAD 基线里 transport=opencode 也只是直连上游 —— 这正是本次要修的第二个缺陷");
    assert.equal(base.snap.zenOpencode.ANTHROPIC_AUTH_TOKEN, DUMMY.zen, "改动前写的是 Zen 的真 key");
  });

  test("④ transport=direct 仍直连上游，切回去不用重启", () => {
    const env = work.snap.zenDirectAgain;
    assert.equal(env.ANTHROPIC_BASE_URL, "https://opencode.ai/zen", "direct 档必须是直连上游本体（修 ③ 不能把这一格改掉）");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, DUMMY.zen);
    assert.deepEqual(env, work.snap.zenDirect, "direct → opencode → direct 之后必须与一开始逐字一致");
  });

  test("⑤ 其余六家：与改动前逐字一致（端口归一化后整块 deepEqual）", () => {
    for (const p of ["bai", "sn", "wb", "wbai", "qd", "or"]) {
      assert.deepEqual(normalize(work.snap[p], work.P), normalize(base.snap[p], base.P),
        `★ ${p} 的接线结果与改动前不一致 —— 本次改动只允许影响 zen`);
      if (p === "bai" || p === "sn") continue;
      assert.equal(work.snap[p].ANTHROPIC_BASE_URL, `http://127.0.0.1:${work.P[p]}`, `${p} 必须继续指向自己的中转端口`);
      assert.equal(work.snap[p].ANTHROPIC_AUTH_TOKEN, PROXY_MANAGED, `${p} 必须继续写占位符`);
    }
  });

  test("⑤b zen 的差异**只有** BASE_URL 与占位符那两处", () => {
    const a = normalize(work.snap.zenOpencode, work.P), b = normalize(base.snap.zenOpencode, base.P);
    const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    assert.deepEqual(diff.sort(), ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
      `opencode 档下 zen 多出来的差异不该有别的字段（实际：${diff.join("、")}）`);
  });
});

/* ================================================================== *
 * ② 的另一半：中转内部**仍然**用带 /v1 的 upstream（假上游录路径）
 * ================================================================== */

/** 有内容的 OpenAI SSE（空流会被 wbPipe 判成上游失败）。 */
const SSE_BODY = (marker) => [
  `data: ${JSON.stringify({ choices: [{ delta: { content: marker } }] })}`,
  "",
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 2 } })}`,
  "",
  "data: [DONE]",
  "", "",
].join("\n");

describe("② 中转内部仍然用带 /v1 的上游（不是同一份）", () => {
  let srv, fake, seen;
  before(async () => {
    srv = await bootServer(TREES.after, "relay", (cfg, P) => {
      /* 上游指向本机假服务；**认不出来的 transport 值**（手改配置才可能出现的坏值）
         一并覆盖：zenTransportOf 的兜底必须是 direct，绝不能因为一个坏值就把 CLI 拨到中转。 */
      cfg.zen.upstream = `http://127.0.0.1:${P.fake}/zen/v1`;
      cfg.zen.transport = "opencode-weird-value";
    });
    seen = [];
    fake = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization || "" });
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(SSE_BODY("假上游标记"));
      });
    });
    await new Promise((r) => fake.listen(srv.P.fake, "127.0.0.1", r));
  }, { timeout: 180000 });
  after(async () => {
    try { srv && srv.kill(); } catch { }
    try { fake && fake.closeAllConnections && fake.closeAllConnections(); } catch { }
    try { fake && await new Promise((r) => fake.close(r)); } catch { }
  });

  test("一个请求打进去，上游收到的是 /zen/v1/chat/completions（/v1 仍由中转自己带）", async () => {
    const r = await fetch(`http://127.0.0.1:${srv.P.zen}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "接线自检" }] }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${text.slice(0, 200)}`);
    assert.equal(seen.length, 1, `应当只向上游发一次，实际 ${seen.length} 次：${JSON.stringify(seen.map((s) => s.url))}`);
    assert.equal(seen[0].url, "/zen/v1/chat/completions",
      "★ 中转必须仍然用带 /v1 的 upstream 拼 /chat/completions —— 去掉 /v1 的只是「写给客户端的那一份」");
    assert.match(text, /假上游标记/, "回包应当来自直连上游这条路径");
    console.log(`  [假上游录到的路径] ${seen[0].url}（cfg.zen.upstream=${srv.readCfg().zen.upstream} → 中转自己带 /chat/completions）`);
  }, { timeout: 60000 });

  test("坏 transport 值退化成 direct：CLI 仍直连上游、仍带真 key", async () => {
    const env = await applyProvider(srv, "zen");
    assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${srv.P.fake}/zen`,
      "认不出来的 transport 值必须落到 direct（CLI 直连上游），不能悄悄把 CLI 拨到中转");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, DUMMY.zen, "direct 档写的是 Zen 的真 key");
  });
});

/* ================================================================== *
 * ⑥ 反向对照：把「去尾部 /v1」那一步删掉，① 必须变红
 * ================================================================== */
describe("⑥ 反向对照：删掉「去尾部 /v1」那一步", () => {
  let srv;
  before(async () => {
    /* mutant 树 = 工作区代码，只删 STRIP_STEP 这一处（树在文件顶部生成时已校验只此一处）。
     * 真起一个进程走完整套接线，不是纸面推演。 */
    srv = await bootServer(TREES.mutant, "mutant");
  }, { timeout: 180000 });
  after(() => { try { srv && srv.kill(); } catch { } });

  test("突变体确实复现了 /v1/v1/：① 的判据在它身上当场变红", async () => {
    const env = await applyProvider(srv, "zen");
    assert.equal(env.ANTHROPIC_BASE_URL, ZEN_UPSTREAM, "突变体应当把 /v1 原样写出去（这才复现了缺陷 ①）");
    assert.equal(env.ANTHROPIC_BASE_URL + "/v1/messages", "https://opencode.ai/zen/v1/v1/messages");
    assert.throws(() => assertNoDoubleV1(env, "突变体"),
      "★ ① 的判据在突变体上竟然没红 —— 那说明 ① 是空断言，对它绿灯没有任何意义");
    console.log(`  [突变体] BASE_URL=${env.ANTHROPIC_BASE_URL} → ${env.ANTHROPIC_BASE_URL}/v1/messages`);
  }, { timeout: 60000 });
});

/* ================================================================== *
 * ③ 的边角：opencode 档本来就不需要 Zen Key（「没配 Key 也算已配置」）
 * ================================================================== */
describe("③ 边角：zen 一个 Key 都没配时，CLI 接线仍然成立", () => {
  let srv;
  before(async () => {
    const mutate = (cfg) => {
      cfg.zen.apiKey = "";            // 一把 Key 都没有 —— 这正是 opencode 档的常态
      cfg.zen.transport = "direct";   // 出厂档；下面那条用例现把它切成 opencode
    };
    mutate.__seedCliToZen = true;
    srv = await bootServer(TREES.after, "nokey", mutate);
  }, { timeout: 180000 });
  after(() => { try { srv && srv.kill(); } catch { } });

  test("已知缺口：/api/apply 仍然要求先填 Key（面板「一键接线」按钮会被 400 挡住）", async () => {
    const r = await srv.api("/api/apply", { provider: "zen", cli: true, desktop: false });
    assert.equal(r.status, 400, "当前实现：没 Key 就 400（本条是**记录现状**，不是给这个行为背书）");
    assert.match(JSON.stringify(r.json), /API Key/);
    console.log("  [已知缺口] /api/apply zen(无 Key) → 400：" + String(r.json && r.json.error).slice(0, 60));
  }, { timeout: 60000 });

  test("但走「保存配置」这条路（面板同样在用）接线照样成功，且一个 Key 都不需要", async () => {
    const r = await srv.api("/api/config", { provider: "zen", transport: "opencode" });
    assert.equal(r.status, 200, `保存失败：${JSON.stringify(r.json).slice(0, 200)}`);
    const env = srv.readEnv();
    assert.equal(env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${srv.P.zen}`, "无 Key 也必须指向中转端口");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, PROXY_MANAGED, "无 Key 时写占位符，不写空串");
    assert.equal(srv.readCfg().zen.apiKey, "", "全程没往配置里塞过任何 Key");
  }, { timeout: 60000 });
});

/* ------------------------------------------------------------------ *
 * 反向对照的「把手册」：--list-sabotage / --sabotage
 *
 * 每条都是**真实跑过的**（本文件末尾的 ⑥ 就是其中第一条的活体对照）。
 * 判据只有一个：改了之后测试真的会红。
 * ------------------------------------------------------------------ */
const SABOTAGE = [
  {
    name: "keep-trailing-v1", where: "server.mjs · cliBaseUrlFor",
    from: `String(S.upstream || "").replace(/\\/+$/, "")${STRIP_STEP}`,
    to: `String(S.upstream || "").replace(/\\/+$/, "")`,
    reds: "① zen / bai / sn 的 /v1/v1 判据 / ④",
  },
  {
    name: "zen-never-bridges", where: "server.mjs · cliViaRelay",
    from: `const cliViaRelay = (S) => isBridgeChannel(S.p) || (S.p === "zen" && S.transport === ZEN_TRANSPORT_OPENCODE);`,
    to: `const cliViaRelay = (S) => isBridgeChannel(S.p);`,
    reds: "③ transport=opencode 仍直连上游（= 改动前的死开关）",
  },
  {
    name: "zen-always-bridges", where: "server.mjs · cliViaRelay",
    from: `const cliViaRelay = (S) => isBridgeChannel(S.p) || (S.p === "zen" && S.transport === ZEN_TRANSPORT_OPENCODE);`,
    to: `const cliViaRelay = (S) => isBridgeChannel(S.p) || S.p === "zen";`,
    reds: "④ direct 档被误拨到中转 / ②-b 的坏值兜底",
  },
  {
    name: "strip-upstream-in-cfg", where: "server.mjs · sliceOf(zen)",
    from: `p: "zen", zh: "OpenCode Zen", key: z.apiKey || "", upstream: z.upstream || DEFAULTS.zen.upstream,`,
    to: `p: "zen", zh: "OpenCode Zen", key: z.apiKey || "", upstream: (z.upstream || DEFAULTS.zen.upstream).replace(/\\/v1$/, ""),`,
    reds: "② 中转内部会打 /zen/chat/completions（假上游录到错的路径）",
  },
];

if (process.argv.includes("--list-sabotage")) {
  console.log(`cli-base-url 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(22)} ${s.where}\n  ${"".padEnd(22)} → 会打红: ${s.reds}`);
  process.exit(0);
}
if (process.argv.includes("--sabotage")) {
  const name = process.argv[process.argv.indexOf("--sabotage") + 1];
  const s = SABOTAGE.find((x) => x.name === name);
  if (!s) { console.error(`没有这条手法：${name}。可用：${SABOTAGE.map((x) => x.name).join(", ")}`); process.exit(2); }
  console.log(JSON.stringify({ file: "src/server/server.mjs", ...s }, null, 2));
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 树快照在 import 之后立刻生成（模块顶层）：所有 describe 共用同一份
 * ------------------------------------------------------------------ */
{
  TREES.before = path.join(TMPROOT, "before", "server");
  const n = snapshotHead(TREES.before);
  assert.ok(n >= 10, `HEAD 的 src/server 只取出 ${n} 个文件，基线快照多半没成功`);
  TREES.after = path.join(TMPROOT, "after", "server");
  copyDir(SRC_DIR, TREES.after);
  TREES.mutant = path.join(TMPROOT, "mutant", "server");
  copyDir(SRC_DIR, TREES.mutant);

  const mFile = path.join(TREES.mutant, "server.mjs");
  const mSrc = readFileSync(mFile, "utf8");
  const aSrc = readFileSync(path.join(TREES.after, "server.mjs"), "utf8");
  const count = (s, sub) => s.split(sub).length - 1;
  /* 两道保险：锚点在工作区必须**只有一处**（否则突变体不止改了一处，红了也说不清是谁干的），
     且 HEAD 那份里应当**没有**它（说明这一步确实是这次新增的）。 */
  assert.equal(count(aSrc, STRIP_STEP), 1, `工作区里「去尾部 /v1」这一步出现了 ${count(aSrc, STRIP_STEP)} 处，期望恰好 1 处`);
  assert.equal(count(readFileSync(path.join(TREES.before, "server.mjs"), "utf8"), STRIP_STEP), 0,
    "HEAD 基线里已经有这一步 —— 那它就不是这次改动引入的，反向对照失去意义");
  TREES.afterDefaultZenUpstream = JSON.parse(readFileSync(path.join(SRC_DIR, "config.defaults.json"), "utf8")).zen.upstream;
  writeFileSync(mFile, mSrc.replace(STRIP_STEP, ""));
}

after(() => { try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });