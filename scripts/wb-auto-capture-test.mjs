/**
 * scripts/wb-auto-capture-test.mjs —— 「令牌捕获全自动、用户零操作」的三条红线。
 *
 * ## 用户要的
 *     点一次「重新获取令牌」，然后 **完全退出客户端 → 重开 → 发一条消息**。
 *     现在这三步里，只有「重开」能被程序自己做 —— 而且必须自己做：
 *     改磁盘上的入口脚本对已运行的客户端无效（Electron 启动时就把脚本读进内存了），
 *     真正承接聊天的是 daemon 的 prewarm 预热池 worker，`wbKickHostSession` 只筛
 *     `__workbuddy_cli_host__` 常驻会话、压根不在它的名单里，踢完又没有补员心跳。
 *     详见 .research/reports/N-全自动捕获可行性.md（结论已核实，本文件不重复调查）。
 *
 * ## 本文件钉住的事
 *   ★ ① 管道连不上时**不许杀 sidecar**（它后面挂着用户自己开的终端 PTY，
 *        与代码里三处「用户会话未动」的承诺直接矛盾）—— 改成如实报告 + 给替代路径。
 *   ★ ② 自动重启**只按 PID**，且**先核对身份**（三态 same / recycled / unverifiable，
 *        后两者一律不杀：PID 被系统回收后误杀无关程序不是理论风险）。
 *   ★ ③ 自动重启**绝不碰终端 PTY / sidecar**，也**绝不按进程名批量杀**。
 *   ★ ④ 动手那一刻必须把「窗口会被关掉并重新打开、未保存内容可能丢失」说出去。
 *   外加：零操作路径（整条捕获跑通）、预热不带鉴权时的兜底、用户已关客户端时不乱重启。
 *
 * ## 本文件怎么验的
 *   ★ 被测代码是 **server.mjs 的真源码**（按锚点切出来，不抄一份重写；锚点对不上当场炸）。
 *   ★ **假进程表 + 假 spawn**：WorkBuddy 的进程表是注入的 JSON，重新拉起是注入的假 spawn
 *     —— 全程**不会真的启动或终止任何 WorkBuddy 进程**。
 *   ★ **唯一的真实动作**是 taskkill 打到**本文件自己 spawn 的假客户端进程**上
 *     （node -e setInterval，不是 WorkBuddy），且只按 PID —— 于是「只杀了一个、别的没动」
 *     是被真的验证过，而不是靠桩自说自话。
 *   ★ 身份判定跑的是**真的** proc-identity 三态，只把「PID 现在的启动时间」这一步换成假的。
 *
 * ## 反向对照
 *   文件末尾 SABOTAGE 表 + scripts/wb-auto-capture-sabotage-run.mjs（grep SABOTAGE 可定位）。
 *   判据只有一个 —— 改回改前行为，对应用例必须红。严禁恒真断言。
 *
 * ## 红线
 *   🔴 全文没有一个真实令牌/API key。夹具里的令牌是明显假的占位串。
 *   🔴 落盘只在 os.tmpdir() 下的临时目录 + BAI_DATA_DIR；**绝不碰真实 %APPDATA%\bai-router**。
 *   🔴 **绝不真杀 / 真启 WorkBuddy**：进程表是假的，重启是假 spawn，真 taskkill 的目标
 *      只可能是本文件自己拉起来的 node 子进程。
 *   🔴 taskkill 只按 PID，绝不用按镜像名的 /IM。
 */
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile as REAL_EXEC_FILE, spawn as REAL_SPAWN } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER_PATH = path.join(REPO, "src", "server", "server.mjs");
const CARD_PATH = path.join(REPO, "src", "server", "cards", "token-capture.js");
const SERVER_SRC = readFileSync(SERVER_PATH, "utf8");
const CARD_SRC = readFileSync(CARD_PATH, "utf8");
const PID_ID = createRequire(import.meta.url)(path.join(REPO, "src", "server", "proc-identity.cjs"));
const { verifyPidRecord: REAL_VERIFY_PID_RECORD, pidIdentityVerdict } = PID_ID;
const { VERDICT_SAME, VERDICT_RECYCLED, VERDICT_UNVERIFIABLE } = PID_ID;

const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-wbauto-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT_FILE = path.join(TMPROOT, "wb-captured-token.json");

/* 明显不是真令牌的假凭据（红线：绝不写真实令牌） */
const TOK_FAKE = "eyJhbGciOiJIUzI1NiJ9.FAKE-DUMMY-ACCESS-TOKEN-AUTO-CAPTURE-000111222333444555666777";
const REFRESH_FAKE = "fake-refresh-token-not-real-at-all";

/* ====================================================================== *
 * 0. 抠真源码（不是抄一份重写）。锚点对不上当场炸，不会静默验错代码。
 * ====================================================================== */
function commentBalance(src) {
  let open = 0, close = 0;
  const OPEN = new RegExp("^\\s*/\\*", "g");
  const CLOSE = new RegExp("(?:^|\\s)\\*\\/", "g");
  const IN_RE = new RegExp("\\]\\*\\/", "g");
  for (const l of src.split("\n")) {
    open += (l.match(OPEN) || []).length;
    close += (l.match(CLOSE) || []).length - (l.match(IN_RE) || []).length;
  }
  return { open, close };
}
function sliceBetween(src, startAnchor, endAnchor) {
  const i = src.indexOf(startAnchor);
  assert.ok(i >= 0, `抠源码失败：找不到 ${JSON.stringify(startAnchor)}`);
  const j = src.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(j > i, `抠源码失败：找不到终点 ${JSON.stringify(endAnchor)}`);
  const out = src.slice(i, j);
  const bal = commentBalance(out);
  assert.equal(bal.open, bal.close,
    `切片停在注释中间（/*=${bal.open} */=${bal.close}）：${JSON.stringify(startAnchor)}`);
  return out;
}

/* 踢常驻会话那一整段（PID 候选 → 控制管道 → kick）。 */
const SRV_KICK = sliceBetween(SERVER_SRC,
  'const WB_HOST_SESSION_PREFIX = "__workbuddy_cli_host__";',
  "// 定位 WorkBuddy 的 CLI 启动脚本");
/* 自动重启那一整段（进程表 → 挑主进程 → 身份核对 → 只按 PID 终止 → 无参数拉起）。 */
const SRV_RESTART_RAW = sliceBetween(SERVER_SRC,
  "/* ---------- 自动重启 WorkBuddy 客户端",
  "// 还原：只要备份在");
/* 还原 + 捕获主流程。 */
const SRV_RESTORE = sliceBetween(SERVER_SRC,
  "async function wbCaptureRestore() {",
  "const WB_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;");
const SRV_CAPTURE_RAW = sliceBetween(SERVER_SRC,
  "const WB_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;",
  "/* /api/wb/capture/status 的响应体。");
const SRV_STATUS = sliceBetween(SERVER_SRC,
  "/* /api/wb/capture/status 的响应体。",
  "/* POST /api/wb/capture 的处理体。");
const SRV_KEYFP = sliceBetween(SERVER_SRC, "function keyFp(k) {", "function desktopConfigFile() {");

/* 只把三个**时间常量**换成注入值，其余逐字是生产源码 ——
   「等 10 分钟 / 等 8 秒退出 / 等 25 秒预热宽限」与「等 9 秒 / 200ms / 300ms」
   走的是同一段代码，否则测不出生产那三个数字背后真正的逻辑。 */
const SRV_RESTART = SRV_RESTART_RAW
  .replace("const WB_CLIENT_EXIT_GRACE_MS = 8000;", "const WB_CLIENT_EXIT_GRACE_MS = D.graceMs;")
  .replace("const WB_PREWARM_GRACE_MS = 25 * 1000;", "const WB_PREWARM_GRACE_MS = D.prewarmGraceMs;");
assert.notEqual(SRV_RESTART, SRV_RESTART_RAW, "重启段的时间常量参数化没打上");
assert.ok(SRV_RESTART.includes("D.graceMs") && SRV_RESTART.includes("D.prewarmGraceMs"));
const SRV_CAPTURE = SRV_CAPTURE_RAW
  .replace("const WB_CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;", "const WB_CAPTURE_TIMEOUT_MS = D.windowMs;");
assert.notEqual(SRV_CAPTURE, SRV_CAPTURE_RAW, "捕获窗口参数化没打上");

/* 切片里引用的、**不由切片自己定义**的东西一律由 D 注入。
   process 也注入（记账 + 真转发），于是「有没有调 kill」是可断言的。
   withKick=false 时不拼 kick 那一段 —— 那时 wbKickHostSession 由 D 注入（要数调用次数）。
   两种工厂的其余代码逐字相同，锚点对不上当场炸。 */
const moduleBody = (withKick) => `
  "use strict";
  const { fsPromises, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, path, os, net,
          createHash, log, execFile, spawn, WB_BACKUP_FILE, findWbCliScript, wbMd5, WB_CAPTURE_HOOK,
          DATA_DIR, ${withKick ? "" : "wbKickHostSession,"} wbClientRunningBefore, wbClientRestartedAfter, loadCfg, saveCfg,
          wbTokenExp, verifyPidRecord, pidIdentityMessage, VERDICT_SAME,
          windowMs, graceMs, prewarmGraceMs } = D;
  const process = D.process;
  let wbCapState = { active: false, startedAt: null, error: null, p: "wb" };
  ${withKick ? SRV_KICK : ""}
  ${SRV_RESTART}
  ${SRV_RESTORE}
  ${SRV_CAPTURE}
  ${SRV_STATUS}
  ${SRV_KEYFP}
  return {
    wbKickHostSession, wbAutoRestartClient, wbClientProcessTable, wbPickMainClientProcess,
    wbTerminatePidOnly, wbSpawnClientExe, wbClientExeFromScript, wbCaptureToken, wbCaptureStatusPayload, keyFp,
    state: () => wbCapState,
  };
`;
const makeModule = new Function("D", moduleBody(true));
const makeCaptureModule = new Function("D", moduleBody(false));

/* ====================================================================== *
 * 1. 假环境：假进程表 / 假 spawn / 只按 PID 的真 taskkill
 * ====================================================================== */
const REAL_PROCESS = process;

/* 本文件自己拉起来的假「客户端 / sidecar / 用户终端」——全是 node 子进程，
   **没有一个是 WorkBuddy**。真 taskkill 只会打到它们头上。 */
const kids = new Map();
function startFakeProc(role) {
  const ch = REAL_SPAWN(process.execPath, ["-e", "setInterval(()=>{},1000)"],
    { stdio: "ignore", windowsHide: true });
  kids.set(ch.pid, { role, proc: ch });
  return ch.pid;
}
function aliveNow(pid) {
  try { REAL_PROCESS.kill(Number(pid), 0); return true; }
  catch (e) { return !(e && e.code === "ESRCH"); }
}
after(() => {
  for (const { proc } of kids.values()) {
    try { if (aliveNow(proc.pid)) REAL_PROCESS.kill(proc.pid); } catch { }
  }
  kids.clear();
  try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { }
});

/* 一个假的 WorkBuddy 安装目录：<base>/resources/app.asar.unpacked/cli/bin/codebuddy + <base>/WorkBuddy.exe */
function makeFakeInstall() {
  const dir = mkdtempSync(path.join(TMPROOT, "inst-"));
  const base = path.join(dir, "WorkBuddy");
  const script = path.join(base, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
  const exe = path.join(base, "WorkBuddy.exe");
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, "#!/usr/bin/env node\nconsole.log('fake codebuddy CLI')\n", "utf8");
  writeFileSync(exe, "MZ fake exe", "utf8");   // 只为让 existsSync 成立，永远不会被执行
  return { base, script, exe };
}

/** 一条假的客户端进程表记录（形状与 wbClientProcessTable 的解析结果一致）。 */
function procRow(pid, exe, cmd, startMs) {
  return { pid, st: startMs, exe, cmd };
}

/**
 * 造一套注入环境。
 *   procs   —— 假的客户端进程表（PowerShell 查询返回它；真的绝不去查 WorkBuddy 的进程）
 *   starts  —— pid → 该 PID「现在」的启动时间，喂给**真**的身份核对做判定
 *   verdict —— 直接指定判定结果（反向对照「短路成永远 same」时用）
 */
function makeEnv(o = {}) {
  const rec = [];
  const cfg = Object.assign({
    procs: [],
    starts: {},
    verdict: null,
    windowMs: 9000,
    graceMs: 200,          // 终止时的正常退出宽限（生产 8000ms）
    prewarmGraceMs: 300,   // 预热宽限（生产 25s）
    taskkillDelayMs: 0,    // 让「正在重启」这个窗口可被观测到
    kick: null,
    withKick: true,        // true = 用真源码的 kick；false = 用注入桩（要数调用次数时）
    clientRunningBefore: true,
  }, o);

  const execFileShim = (cmd, args, opts, cb) => {
    if (cmd === "powershell.exe") {
      rec.push({ kind: "ps", cmd, args });
      if (cfg.queryFail) return setImmediate(() => cb(new Error("query failed")));
      return setImmediate(() => cb(null, JSON.stringify(cfg.procs), ""));
    }
    if (cmd === "taskkill") {
      assert.equal(args[0], "/PID");
      assert.ok(kids.has(Number(args[1])), "测试只能终止自己创建的假进程");
      assert.ok(args.length === 2 || (args.length === 3 && args[2] === "/F"), "测试禁止按名称或进程树终止");
      rec.push({ kind: "taskkill", cmd, args: Array.from(args) });
      // 真执行 —— 但目标只可能是本文件自己拉起来的 node 子进程，且只按 PID。
      return setTimeout(() => REAL_EXEC_FILE(cmd, args, opts, cb), cfg.taskkillDelayMs);
    }
    rec.push({ kind: "other", cmd, args: Array.from(args || []) });
    return setImmediate(() => cb(null, "", ""));
  };
  const spawnShim = (exe, args, opts) => {
    rec.push({ kind: "spawn", exe, args: Array.from(args || []), opts });
    const ch = Object.assign(new EventEmitter(), { pid: 999001, unref() { } });
    setImmediate(() => ch.emit(cfg.spawnError ? "error" : "spawn", cfg.spawnError ? new Error("fake ENOENT") : undefined));
    return ch;
  };
  /* process 探针：所有 kill 调用都记账，然后**真的转发** —— 于是反向对照把 kill 放回去时，
     那个假进程会真的死掉，「没调 kill」与「进程还活着」两条断言同时变红。 */
  const processShim = {
    kill(pid, sig) {
      rec.push({ kind: sig === 0 ? "probe" : "KILL", pid: Number(pid), sig });
      return REAL_PROCESS.kill(pid, sig);
    },
    env: REAL_PROCESS.env,
    uptime: () => REAL_PROCESS.uptime(),
    platform: REAL_PROCESS.platform,
  };
  /* 身份核对：跑**真的** proc-identity 判定，只把「PID 现在的启动时间」换成假的。 */
  const verifyShim = async (req) => {
    if (cfg.verdict) return { verdict: cfg.verdict, why: "反向对照：判定被短路成固定值" };
    return REAL_VERIFY_PID_RECORD({
      pid: req.pid, file: req.file, record: req.record,
      readStartMs: async (n) => (Object.prototype.hasOwnProperty.call(cfg.starts, n) ? cfg.starts[n] : null),
    });
  };

  let saved = { wb: {}, wbai: {} };
  const deps = {
    windowMs: cfg.windowMs,
    graceMs: cfg.graceMs,
    prewarmGraceMs: cfg.prewarmGraceMs,
    fsPromises: {
      ...fs.promises,
      async writeFile(file, content, ...args) {
        if (cfg.partialInjection && String(content).includes("BAI-CAPTURE-HOOK")) {
          cfg.partialWritten = true;
          await fs.promises.writeFile(file, "#!", ...args);
          throw new Error("fake partial write failure");
        }
        if (cfg.partialWritten && cfg.failRestore) throw new Error("fake restore failure");
        return fs.promises.writeFile(file, content, ...args);
      },
    },
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    rmSync: fs.rmSync,
    writeFileSync: fs.writeFileSync,
    path,
    os: { tmpdir: () => TMPROOT, homedir: () => TMPROOT },
    net: cfg.net || net,
    createHash,
    log: () => { },          // 日志通道一律丢弃：绝不让令牌有机会进日志
    execFile: execFileShim,
    spawn: spawnShim,
    process: processShim,
    WB_BACKUP_FILE: path.join(TMPROOT, "wb-codebuddy.bak.json"),
    findWbCliScript: async () => cfg.install.script,
    wbMd5: (s) => "md5-" + String(s).length,
    WB_CAPTURE_HOOK: "\n// === BAI-CAPTURE-HOOK ===\n// === /BAI-CAPTURE-HOOK ===\n",
    DATA_DIR: TMPROOT,
    wbKickHostSession: cfg.kick || (async () => ({ action: "no_sidecar", detail: "测试桩：没有 WorkBuddy 后台", sessions: 0 })),
    wbClientRunningBefore: async () => cfg.clientRunningBefore,
    wbClientRestartedAfter: async () => false,
    loadCfg: () => JSON.parse(JSON.stringify(saved)),
    saveCfg: (c) => { saved = JSON.parse(JSON.stringify(c)); },
    wbTokenExp: () => "2030-01-01T00:00:00.000Z",
    verifyPidRecord: verifyShim,
    pidIdentityMessage: PID_ID.pidIdentityMessage,
    VERDICT_SAME,
  };
  /* withKick=false 的那套工厂把 wbKickHostSession 交给 D —— 测捕获流程时要数它被调了几次
     （追加踢会话那条兜底），所以那条路必须用注入桩；测 kick 本身则用真源码。 */
  const mod = (cfg.withKick === false ? makeCaptureModule : makeModule)(deps);
  return {
    mod, rec, cfg,
    savedCfg: () => saved,
    kills: () => rec.filter((r) => r.kind === "KILL"),
    taskkills: () => rec.filter((r) => r.kind === "taskkill"),
    spawns: () => rec.filter((r) => r.kind === "spawn"),
  };
}

/* ====================================================================== *
 * 2. ★ ① 控制管道连不上时，一个进程都不能杀
 * ====================================================================== */
describe("★① 管道连不上时的兜底：不许杀 sidecar（它后面挂着用户的终端）", () => {
  test("构造「控制管道连不上」→ 不调任何 kill，且说清为什么不杀 + 替代路径", async () => {
    const sidecarPid = startFakeProc("sidecar");
    const ptyPid = startFakeProc("用户终端PTY");
    /* 让 wbSidecarPidFiles 在假 tmpdir 下找得到它：token = sha1(cfgDir).slice(0,12)，
       cfgDir = homedir() + "\\.workbuddy"（与生产同一套算法）。 */
    const cfgDir = path.join(TMPROOT, ".workbuddy");
    const token = createHash("sha1").update(cfgDir).digest("hex").slice(0, 12);
    const pidDir = path.join(TMPROOT, "wb", token);
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(path.join(pidDir, "sidecar.pid"),
      JSON.stringify({ pid: sidecarPid, controlPipeUuid: "test-uuid" }), "utf8");

    const install = makeFakeInstall();
    const st = Date.now() - 600000;
    const env = makeEnv({ starts: { [sidecarPid]: st },
      procs: [procRow(sidecarPid, install.exe, `"${install.exe}" sidecar-entry.js`, st)] });
    /* 管道连不上：wbSidecarRpc 走的是真 net.connect，管道名不存在 → ENOENT → 落到 catch 分支。 */
    const r = await env.mod.wbKickHostSession({ provider: "wb", exe: install.exe });

    assert.equal(r.action, "pipe_unreachable",
      `控制管道连不上时必须落到「如实报告」分支，实际 action=${r.action}`);
    assert.deepEqual(env.kills(), [], "不许调 process.kill —— 这正是改前那条会杀掉用户终端的兜底");
    assert.deepEqual(env.taskkills(), [], "不许调 taskkill");
    assert.equal(aliveNow(sidecarPid), true, "sidecar 必须还活着（假进程真的没被杀）");
    assert.equal(aliveNow(ptyPid), true, "用户的终端 PTY 必须还活着");

    assert.match(r.detail, /没有终止任何进程/, "必须明说一个进程都没终止");
    assert.match(r.detail, /终端/, "必须说明 sidecar 后面挂着用户的终端");
    assert.match(r.detail, /手动填写令牌/, "必须给出替代路径之一：手动填写令牌");
    assert.match(r.detail, /重开客户端|重新打开客户端/, "必须给出替代路径之二：重启客户端再试");
    assert.doesNotMatch(r.detail, /已直接终止/, "不许再出现改前那句「已直接终止 sidecar」");
  });

  test("直接杀 sidecar 的兜底已移除，捕获只操作本次安装目录", () => {
    assert.match(SRV_CAPTURE, /await wbKickHostSession\(kickOpts\)/);
    assert.match(SRV_KICK, /allowedPids\.has\(Number\(j\.pid\)\)/);
    const code = SRV_KICK
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/process\.kill\(info\.pid\)/.test(code), false);
  });

  test("管道可达时只终止常驻 CLI 会话，不给用户终端发送 session.kill", async () => {
    const install = makeFakeInstall();
    const pid = startFakeProc("sidecar-scoped");
    const st = Date.now() - 600000;
    const dir = path.join(TMPROOT, "wb", "scope-test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "sidecar.pid"), JSON.stringify({ pid }), "utf8");
    const requests = [];
    const fakeNet = { connect() {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      socket.write = (s) => {
        const req = JSON.parse(s);
        requests.push(req);
        const result = req.method === "session.list"
          ? [{ sessionId: "__workbuddy_cli_host__" }, { sessionId: "user-terminal" }] : {};
        setImmediate(() => socket.emit("data", Buffer.from(JSON.stringify({ id: 1, result }) + "\n")));
      };
      setImmediate(() => socket.emit("connect"));
      return socket;
    } };
    const env = makeEnv({ net: fakeNet, starts: { [pid]: st },
      procs: [procRow(pid, install.exe, `"${install.exe}" sidecar-entry.js`, st)] });
    const result = await env.mod.wbKickHostSession({ exe: install.exe, provider: "wb" });
    assert.equal(result.action, "killed");
    assert.deepEqual(requests.filter((x) => x.method === "session.kill").map((x) => x.params.sessionId), ["__workbuddy_cli_host__"]);
    assert.equal(aliveNow(pid), true);
    assert.deepEqual(env.kills(), []);
  });

  test("sidecar 属于另一安装或同目录有多个 sidecar 时跳过，不连接控制管道", async () => {
    const install = makeFakeInstall();
    const rows = [procRow(1, install.exe, `"${install.exe}" sidecar-entry.js`, 1000),
      procRow(2, install.exe, `"${install.exe}" sidecar-entry.js`, 2000)];
    for (const procs of [[{ ...rows[0], exe: "D:\\Other\\WorkBuddy.exe" }], rows]) {
      const env = makeEnv({ procs, net: { connect() { assert.fail("不应连接未经确认的 sidecar"); } } });
      assert.equal((await env.mod.wbKickHostSession({ exe: install.exe, provider: "wb" })).action, "pid_unverified");
      assert.deepEqual(env.kills(), []);
    }
  });
});

/* ====================================================================== *
 * 3. ★ ② 自动重启：只按 PID + 先核对身份（三态）
 * ====================================================================== */
describe("★② 自动重启：PID 复用防护（recycled / unverifiable 一律不杀）", () => {
  test("判定 recycled（PID 被系统回收给了别的进程）→ 一个进程都不终止", async () => {
    const install = makeFakeInstall();
    const mainPid = startFakeProc("client-main");
    const recorded = Date.now() - 1200000;
    const env = makeEnv({
      install,
      procs: [procRow(mainPid, install.exe, `"${install.exe}"`, recorded)],
      starts: { [mainPid]: recorded + 600000 },   // 比记录晚 10 分钟 ⇒ recycled
    });
    const r = await env.mod.wbAutoRestartClient("wb", { script: install.script });
    assert.equal(r.action, "unverified", `PID 被回收时必须放弃重启，实际 ${r.action}`);
    assert.deepEqual(env.kills(), [], "recycled 不得 kill");
    assert.deepEqual(env.taskkills(), [], "recycled 不得 taskkill");
    assert.deepEqual(env.spawns(), [], "recycled 不得拉起新进程");
    assert.equal(aliveNow(mainPid), true, "假客户端必须还活着");
    assert.match(r.detail, /回收/, "必须把「这个 PID 已经不是当初那个」说给用户");
    assert.match(r.detail, /一个进程都没有终止/, "必须明说没动任何进程");
    assert.match(r.detail, /手动填写令牌/, "必须给替代路径");
  });

  test("判定 unverifiable（取不到启动时间）→ 同样一个进程都不终止", async () => {
    const install = makeFakeInstall();
    const mainPid = startFakeProc("client-main");
    const env = makeEnv({
      install,
      procs: [procRow(mainPid, install.exe, `"${install.exe}"`, Date.now() - 1200000)],
      starts: {},                      // 取不到启动时间 ⇒ unverifiable
    });
    const r = await env.mod.wbAutoRestartClient("wb", { script: install.script });
    assert.equal(r.action, "unverified", `unverifiable 时必须放弃重启，实际 ${r.action}`);
    assert.deepEqual(env.kills(), [], "unverifiable 不得 kill（校验不了就不动手）");
    assert.deepEqual(env.taskkills(), [], "unverifiable 不得 taskkill");
    assert.deepEqual(env.spawns(), [], "unverifiable 不得拉起");
    assert.equal(aliveNow(mainPid), true, "假客户端必须还活着");
    assert.match(r.detail, /无法验证/, "必须如实说「核对不了，所以没动」");
  });

  test("判定 same（确实是当初那个进程）→ 才终止，且只按 PID", async () => {
    const install = makeFakeInstall();
    const mainPid = startFakeProc("client-main");
    const st = Date.now() - 600000;
    const env = makeEnv({
      install,
      procs: [procRow(mainPid, install.exe, `"${install.exe}"`, st)],
      starts: { [mainPid]: st },
    });
    const r = await env.mod.wbAutoRestartClient("wb", { script: install.script });
    assert.equal(r.action, "restarted", `same 时应当重启，实际 ${r.action}：${r.detail}`);
    assert.ok(env.taskkills().length >= 1, "必须真的终止了那个 PID");
    for (const c of env.taskkills()) {
      assert.equal(c.args[0], "/PID", `taskkill 第一个参数必须是 PID 开关，实际 ${JSON.stringify(c.args)}`);
      assert.equal(c.args[1], String(mainPid), "只准打客户端主进程那一个 PID");
    }
    assert.equal(aliveNow(mainPid), false, "核对通过后，那个假客户端应当真的被终止掉");
    assert.equal(env.spawns().length, 1, "必须重新拉起一次");
    assert.deepEqual(env.spawns()[0].args, [], "拉起必须**无参数**（否则可能走 msix 分享目标激活路径）");
    assert.equal(env.spawns()[0].exe, install.exe, "拉起的必须是同一个客户端 exe");
  });

  test("对照底座：真判定函数本身必须能给出三个不同的结论（桩不背这个锅）", () => {
    /* 这条验的是 proc-identity 的判定，不是本文件的桩。若哪天它改成永远 same，下面会红。 */
    assert.equal(pidIdentityVerdict({ recordedStartMs: 1000, actualStartMs: 1000 }).verdict, VERDICT_SAME);
    assert.equal(pidIdentityVerdict({ recordedStartMs: 1000, actualStartMs: 1000 + 600000 }).verdict, VERDICT_RECYCLED);
    assert.equal(pidIdentityVerdict({ recordedStartMs: 1000, actualStartMs: null }).verdict, VERDICT_UNVERIFIABLE);
  });
});

/* ====================================================================== *
 * 4. ★ ③ 绝不按名字杀 + ★ ④ 绝不碰终端 PTY / sidecar
 * ====================================================================== */
describe("★③ 绝不按名字杀 / ★④ 绝不碰终端 PTY", () => {
  test("自动重启只终止客户端主进程：终端 PTY、sidecar、daemon、renderer 全都还活着", async () => {
    const install = makeFakeInstall();
    const mainPid = startFakeProc("client-main");
    const ptyPid = startFakeProc("用户终端PTY");        // 用户在客户端里开的终端
    const sidecarPid = startFakeProc("sidecar");
    const daemonPid = startFakeProc("daemon");
    const rendererPid = startFakeProc("renderer");
    const st = Date.now() - 600000;
    /* 一张**完整**的客户端进程表：形状照抄真机 —— sidecar / daemon / renderer 都跑在
       同一个 exe 上，只有命令行能把它们和主进程分开。 */
    const asar = (f) => `"${install.exe}" "${path.join(install.base, "resources", "app.asar", "main", f)}"`;
    const procs = [
      procRow(mainPid, install.exe, `"${install.exe}"`, st),
      procRow(sidecarPid, install.exe, `${asar("sidecar-entry.js")} --token x --control-pipe-uuid 46556343`, st + 1000),
      procRow(daemonPid, install.exe, `${asar("daemon-app-server-entry.js")} --stdio`, st + 2000),
      procRow(rendererPid, install.exe, `"${install.exe}" --type=renderer`, st + 3000),
      procRow(ptyPid, install.exe, `node -e fake-user-pty`, st + 4000),
    ];
    const env = makeEnv({ install, procs, starts: Object.fromEntries(procs.map((p) => [p.pid, p.st])) });

    const r = await env.mod.wbAutoRestartClient("wb", { script: install.script });

    assert.equal(r.action, "restarted", `应当重启成功，实际 ${r.action}：${r.detail}`);
    const killedPids = env.taskkills().map((c) => String(c.args[1]));
    assert.ok(killedPids.length >= 1, "至少要终止一次");
    assert.deepEqual([...new Set(killedPids)], [String(mainPid)],
      `只准终止客户端主进程，实际动了 ${killedPids}`);
    assert.equal(aliveNow(mainPid), false, "主进程应当被终止");
    assert.equal(aliveNow(ptyPid), true, "🔴 用户的终端 PTY 必须毫发无损");
    assert.equal(aliveNow(sidecarPid), true, "🔴 sidecar 不得被我们单独终止");
    assert.equal(aliveNow(daemonPid), true, "🔴 daemon 不得被我们单独终止");
    assert.equal(aliveNow(rendererPid), true, "🔴 renderer 不得被我们单独终止");
  });

  test("源码层面：重启段里没有按镜像名终止的写法，taskkill 只按 PID、也不带树形参数", () => {
    assert.equal(/\/IM/.test(SRV_RESTART), false,
      "自动重启这段源码里不得出现按镜像名终止的参数（红线：taskkill 只按 PID）");
    const runs = SRV_RESTART.match(/run\(\[[\s\S]*?\]\)/g) || [];
    assert.equal(runs.length, 2, `应当只有两次 taskkill 调用，实际 ${JSON.stringify(runs)}`);
    for (const a of runs) assert.match(a, /^\s*run\(\["\/PID"/, `taskkill 调用必须以 PID 开关开头：${a}`);
    const code = SRV_RESTART.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/\/T\b/.test(code), false,
      "不得带树形终止参数 —— 我们要的是「只结束主进程」，不主动连带终止子进程");
    for (const marker of ["sidecar-entry", "daemon-app-server-entry", "--type="]) {
      assert.ok(SRV_RESTART.includes(marker), `挑主进程的判据里必须能排掉 ${marker}`);
    }
  });

  test("对外动作只有三个：两次只按 PID 的 taskkill + 一次无参数 spawn", async () => {
    const install = makeFakeInstall();
    const mainPid = startFakeProc("client-main");
    const st = Date.now() - 600000;
    const env = makeEnv({
      install,
      procs: [procRow(mainPid, install.exe, `"${install.exe}"`, st)],
      starts: { [mainPid]: st },
    });
    await env.mod.wbAutoRestartClient("wb", { script: install.script });
    const outs = env.rec.filter((r) => r.kind === "taskkill" || r.kind === "spawn" || r.kind === "KILL");
    assert.deepEqual(outs.map((o) => o.kind), ["taskkill", "taskkill", "spawn"],
      `对外动作必须只有这些，实际 ${JSON.stringify(outs)}`);
    assert.equal(outs.filter((o) => o.kind === "KILL" && o.pid !== mainPid).length, 0,
      "不得对主进程以外的任何 PID 动手");
  });
});

/* ====================================================================== *
 * 5. 零操作路径：客户端在跑 → 程序自己重启 → 捕获成功
 * ====================================================================== */
describe("零操作路径：客户端在跑 → 程序自己重启 → 令牌抓回来了", () => {
  test("整条捕获跑通：自动重启被触发 + 抓到令牌 + 客户端脚本已还原 + 窗口会被关掉有告知", async () => {
    const install = makeFakeInstall();
    const mainPid = startFakeProc("client-main");
    const ptyPid = startFakeProc("用户终端PTY");
    const st = Date.now() - 600000;
    const env = makeEnv({
      install,
      windowMs: 12000,
      taskkillDelayMs: 700,        // 让「正在自动重启」这个窗口可被观测到
      clientRunningBefore: true,   // 客户端在注入前就已启动（典型情形）
      procs: [procRow(mainPid, install.exe, `"${install.exe}"`, st)],
      starts: { [mainPid]: st },
    });

    const cap = env.mod.wbCaptureToken(12000, "wb", { autoRestart: true });

    /* 🔴 ③：动手的那一刻，界面必须已经说清「窗口会被关掉并重新打开、未保存内容可能丢失」。 */
    let midFlight = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      const p = env.mod.wbCaptureStatusPayload();
      if (p.restarting) { midFlight = p; break; }
      await sleep(40);
    }
    assert.ok(midFlight, "重启期间状态接口必须报出 restarting=true");
    assert.match(midFlight.phaseText, /窗口会被关掉并重新打开/, "必须明说客户端窗口会被关掉并重开");
    assert.match(midFlight.phaseText, /未保存/, "必须明说未保存的对话可能丢失");

    /* 等「自动重启真的发生」，然后**假装新进程发了一条带鉴权的请求**（钩子的行为）。 */
    const t1 = Date.now();
    while (Date.now() - t1 < 9000) {
      const s = env.mod.state();
      if (s.restart && s.restart.action === "restarted") break;
      await sleep(40);
    }
    const after = env.mod.state();
    assert.equal(after.restart.action, "restarted",
      `自动重启必须被触发，实际 ${JSON.stringify(after.restart)}`);
    assert.equal(after.restarted, true, "重启完成后应立刻认为「钩子已生效」，不必再等探测");
    assert.equal(after.needRestart, false, "自动重启已经做完了，不再要求用户手动重启");
    assert.equal(env.spawns().length, 1, "自动重启必须有且只有一次拉起");
    assert.deepEqual(env.spawns()[0].args, [], "拉起必须无参数");
    assert.equal(aliveNow(ptyPid), true, "用户的终端 PTY 不受这次捕获影响");
    assert.equal(aliveNow(mainPid), false, "客户端主进程确实被换掉了");

    writeFileSync(OUT_FILE, JSON.stringify({ accessToken: TOK_FAKE, refreshToken: REFRESH_FAKE }), "utf8");
    const r = await cap;

    assert.equal(r.ok, true, "捕获应当成功");
    assert.equal(env.savedCfg().wb.accessToken, TOK_FAKE, "令牌应当被写进 cfg.wb");
    assert.equal(r.masked, env.mod.keyFp(TOK_FAKE), "对外只给脱敏指纹");
    assert.equal(r.hasRefresh, true, "带上了刷新令牌");
    assert.equal(readFileSync(install.script, "utf8").includes("BAI-CAPTURE-HOOK"), false,
      "捕获结束后必须把客户端脚本还原");
    assert.equal(JSON.stringify(r).includes(TOK_FAKE), false, "响应里绝不能出现令牌明文");
    assert.equal(JSON.stringify(env.mod.wbCaptureStatusPayload()).includes(TOK_FAKE), false,
      "状态接口里绝不能出现令牌明文");
  });
});

/* ====================================================================== *
 * 6. 兜底路径：预热请求不带 Authorization → 退回「请发一条消息」，且不说成失败
 * ====================================================================== */
describe("兜底路径：预热请求不带鉴权头时，退回「发一条消息」", () => {
  test("自动重启成功但一直没抓到 → 追加一次踢会话 + 文案说「这不是失败」", async () => {
    const install = makeFakeInstall();
    const mainPid = startFakeProc("client-main");
    const st = Date.now() - 600000;
    let kickCalls = 0;
    const env = makeEnv({
      install,
      windowMs: 5000,
      prewarmGraceMs: 300,
      withKick: false,
      clientRunningBefore: true,
      procs: [procRow(mainPid, install.exe, `"${install.exe}"`, st)],
      starts: { [mainPid]: st },
      kick: async () => { kickCalls++; return { action: "killed", detail: "测试桩：已踢常驻会话", killed: 1 }; },
    });

    let err = null;
    await env.mod.wbCaptureToken(5000, "wb", { autoRestart: true }).catch((e) => { err = e; });

    assert.ok(err, "抓不到令牌就该如实结束（这是超时，不是崩溃）");
    assert.match(err.message, /预热请求是否带鉴权仍未确认/);
    assert.match(err.message, /发一条消息/, "必须给出「发一条消息」这条替代路径");
    assert.match(err.message, /本轮已结束/, "超时后不得承诺继续捕获");
    assert.equal(kickCalls, 2, "预热宽限到之后必须追加一次踢会话（让下一条消息落到带钩子的新进程上）");
    assert.ok(env.mod.state().rekick, "追加踢会话的结果要留在状态里");
    assert.match(env.mod.state().phaseText, /尚未捕获/);
  });

  test("自动重启**没有**做成时，超时分诊说的是重启的失败原因，而不是「请发一条消息」", async () => {
    const install = makeFakeInstall();
    const mainPid = startFakeProc("client-main");
    const env = makeEnv({
      install,
      windowMs: 2500,
      prewarmGraceMs: 60000,          // 不让追加踢会话干扰这一条
      clientRunningBefore: true,
      procs: [procRow(mainPid, install.exe, `"${install.exe}"`, Date.now() - 1200000)],
      starts: {},                     // unverifiable ⇒ 自动重启放弃
    });
    let err = null;
    await env.mod.wbCaptureToken(2500, "wb", { autoRestart: true }).catch((e) => { err = e; });
    assert.ok(err);
    assert.match(err.message, /自动重启 WorkBuddy 客户端没有完成/, "分诊要按自动重启的结论来");
    assert.match(err.message, /手动完全退出并重开/, "要给出手动路径");
    assert.deepEqual(env.taskkills(), [], "核对不过 ⇒ 一个进程都没终止");
    assert.equal(env.mod.state().restart.action, "unverified", "必须把核对没通过这条结论留在状态里");
  });
});

/* ====================================================================== *
 * 7. 用户已关客户端：不尝试重启，只提示打开
 * ====================================================================== */
describe("用户已关客户端：不尝试重启", () => {
  test("进程表为空 → 不 kill、不 spawn，只提示打开客户端", async () => {
    const install = makeFakeInstall();
    const env = makeEnv({ install, procs: [], windowMs: 2500, clientRunningBefore: false });
    let err = null;
    await env.mod.wbCaptureToken(2500, "wb", { autoRestart: true }).catch((e) => { err = e; });
    assert.equal(env.mod.state().restart.action, "not_running", "应当是「客户端没在运行」这个结论");
    assert.deepEqual(env.kills(), [], "没有客户端可杀");
    assert.deepEqual(env.taskkills(), [], "没有客户端可杀");
    assert.deepEqual(env.spawns(), [], "绝不能替用户把客户端启动起来");
    assert.ok(err);
    assert.match(err.message, /没有在运行/, "超时分诊要说清客户端当时没开");
    assert.match(err.message, /打开 WorkBuddy/, "要告诉用户打开客户端");
  });

  test("直接调自动重启：客户端没开时不动任何进程", async () => {
    const install = makeFakeInstall();
    const env = makeEnv({ install, procs: [] });
    const r = await env.mod.wbAutoRestartClient("wb", { script: install.script });
    assert.equal(r.action, "not_running");
    assert.equal(r.killed, 0);
    assert.deepEqual(env.taskkills(), []);
    assert.deepEqual(env.spawns(), []);
    assert.match(r.detail, /打开/, "必须提示打开客户端");
  });
});

/* ====================================================================== *
 * 8. 界面文案（③：不能默默杀用户的应用）
 * ====================================================================== */
describe("界面文案：自动重启期间必须把话说明白", () => {
  test("卡片要能显示「正在自动重启 / 窗口会被关掉 / 未保存可能丢失」，且不被推进文案覆盖", () => {
    assert.match(CARD_SRC, /正在自动重启客户端/, "界面要有「正在自动重启」这一档");
    assert.match(CARD_SRC, /窗口会被关掉并重新打开/, "界面必须明说窗口会被关掉并重新打开");
    assert.match(CARD_SRC, /未保存/, "界面必须明说未保存的对话可能丢失");
    assert.match(CARD_SRC, /let tickBlocked = false;/, "推进器必须让位给轮询分支");
    assert.match(CARD_SRC, /if \(tickBlocked\) return;/, "推进器不得覆盖轮询写下的标题");
    assert.match(CARD_SRC,
      /tickBlocked = true;\s*\n\s*sc\.\$\('\[data-role="ptitle"\]'\)\.textContent = "正在自动重启客户端/,
      "自动重启这一档必须置上 tickBlocked");
    /* 这句分支必须排在「需要你手动完全退出并重启」之前，否则自动重启期间
       界面仍会要求用户手动重启 —— 那正是这次要消灭的手工步骤。 */
    const iRestart = CARD_SRC.indexOf("s.restarting");
    const iNeedManual = CARD_SRC.indexOf("s.needRestart && !s.restarted");
    assert.ok(iRestart > 0 && iNeedManual > iRestart,
      "自动重启分支必须排在「需要你手动重启」分支之前");
  });
});

describe("复审发现的安全边界", () => {
  test("只匹配本次安装目录的唯一主进程，未知命令行和 CLI 不作为目标", () => {
    const env = makeEnv();
    const exe = "C:\\Apps\\WorkBuddy\\WorkBuddy.exe";
    const main = { pid: 1, exe, cmd: `"${exe}"`, startMs: 1000 };
    for (const rows of [
      [{ ...main, exe: "D:\\Other\\WorkBuddy.exe" }],
      [{ ...main, cmd: `"${exe}" sidecar-entry.js` }],
      [{ ...main, cmd: `"${exe}" codebuddy --prewarm` }],
      [{ ...main, cmd: "" }],
      [main, { ...main, pid: 2 }],
    ]) assert.equal(env.mod.wbPickMainClientProcess(rows, exe), null);
    assert.equal(env.mod.wbPickMainClientProcess([main], exe), main);
  });

  test("发现进程时名称带 .exe，查询错误不冒充未运行", async () => {
    const env = makeEnv({ queryFail: true });
    assert.equal(await env.mod.wbClientProcessTable("wb"), null);
    const ps = env.rec.find((x) => x.kind === "ps").args.at(-1);
    assert.match(ps, /Name='WorkBuddy\.exe'/);
    assert.match(ps, /Name='WorkBuddyAI\.exe'/);
    assert.match(ps, /ErrorActionPreference='Stop'/);
  });

  for (const verdict of [VERDICT_RECYCLED, VERDICT_UNVERIFIABLE]) {
    test(`等待正常退出期间身份变为 ${verdict}，不发送强制终止`, async () => {
      const env = makeEnv();
      let checks = 0;
      const calls = [];
      const result = await env.mod.wbTerminatePidOnly(123, {
        graceMs: 1, alive: () => true,
        verifyIdentity: async () => ({ verdict: ++checks === 1 ? VERDICT_SAME : verdict }),
        execFile: (_cmd, args, _opts, cb) => { calls.push(args); cb(null); },
      });
      assert.deepEqual(calls, [["/PID", "123"]]);
      assert.equal(checks, 2);
      assert.equal(result.ok, verdict === VERDICT_RECYCLED);
    });
  }

  test("异步启动失败被返回，不误报重启成功", async () => {
    const env = makeEnv({ spawnError: true });
    const r = await env.mod.wbSpawnClientExe("fake.exe");
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOENT/);
  });

  test("默认不重启；并发第二次捕获被拒绝；成功后脚本还原", async () => {
    const install = makeFakeInstall();
    const pid = startFakeProc("client-main");
    const st = Date.now() - 600000;
    const env = makeEnv({ install, procs: [procRow(pid, install.exe, `"${install.exe}"`, st)], starts: { [pid]: st } });
    const first = env.mod.wbCaptureToken(3000, "wb");
    await assert.rejects(env.mod.wbCaptureToken(3000, "wbai"), /上一次获取还在进行中/);
    while (!env.mod.state().restart) await sleep(10);
    assert.equal(env.mod.state().restart.action, "disabled");
    assert.deepEqual(env.taskkills(), []);
    assert.deepEqual(env.spawns(), []);
    writeFileSync(OUT_FILE, JSON.stringify({ accessToken: TOK_FAKE }), "utf8");
    assert.equal((await first).ok, true);
    assert.equal(aliveNow(pid), true);
    assert.doesNotMatch(readFileSync(install.script, "utf8"), /BAI-CAPTURE-HOOK/);
  });

  test("自动重启必须由界面显式勾选，影响在点击前展示", () => {
    assert.match(CARD_SRC, /type="checkbox" data-role="auto-restart"/);
    const input = CARD_SRC.match(/<input[^>]*data-role="auto-restart"[^>]*>/)[0];
    assert.doesNotMatch(input, /\bchecked\b/);
    assert.match(CARD_SRC, /终端会话也可能结束/);
    assert.match(CARD_SRC, /autoRestart: run\.autoRestart/);
    assert.match(SRV_CAPTURE, /opts\.autoRestart === true \?/);
  });

  for (const failRestore of [false, true]) {
    test(`注入先截断再失败：${failRestore ? "还原失败保留磁盘备份" : "恢复原文"}`, async () => {
      const install = makeFakeInstall();
      const original = readFileSync(install.script, "utf8");
      const env = makeEnv({ install, partialInjection: true, failRestore });
      await assert.rejects(env.mod.wbCaptureToken(2000, "wb", { autoRestart: true }), /partial write failure/);
      assert.equal(env.mod.state().active, false);
      assert.deepEqual(env.taskkills(), []);
      assert.deepEqual(env.spawns(), []);
      if (failRestore) {
        const disk = path.join(TMPROOT, "wb-codebuddy.bak.json");
        assert.equal(JSON.parse(readFileSync(disk, "utf8")).content, original);
      } else {
        assert.equal(readFileSync(install.script, "utf8"), original);
      }
    });
  }
});

/* ====================================================================== *
 * SABOTAGE —— 「改坏」手法清单（grep SABOTAGE 可定位）
 *   S1 kick-kill-sidecar     把 ① 那条兜底的 process.kill 放回去          → ★① 必红
 *   S2 identity-always-same  把身份核对短路成「永远 same」                → ★② 必红
 *   S3 taskkill-by-image     把 taskkill 改成按镜像名终止                  → ★③ 必红
 *   S4 restart-picks-sidecar 让自动重启改去踢 sidecar/终端那一类进程      → ★④ 必红
 *   S5 no-auto-restart       捕获流程里不再自动重启（退回让用户手动）      → 零操作路径必红
 *   S6 silent-restart        自动重启时不再告知窗口会被关掉                → ③ 文案必红
 * 执行器：node scripts/wb-auto-capture-sabotage-run.mjs
 * 跑完之后源码里必须一条 SABOTAGE 标记都搜不到。
 * ====================================================================== */
export const SABOTAGE = [
  {
    name: "kick-kill-sidecar", file: "src/server/server.mjs",
    what: "把 ① 的兜底改回改前行为：管道连不上就 process.kill 掉整个 sidecar",
    from: `    return {
      action: "pipe_unreachable",`,
    to: `    try { process.kill(info.pid); } catch (e3) { /* SABOTAGE kick-kill-sidecar */ }
    return {
      action: "pipe_unreachable",`,
    reds: "★① 兜底用例（不许调 kill / sidecar 必须还活着）",
  },
  {
    name: "identity-always-same", file: "src/server/server.mjs",
    what: "把身份核对短路成「永远 same」——PID 复用防护就此失效",
    from: `  if (!ident || ident.verdict !== VERDICT_SAME) {`,
    to: `  if (!ident || (ident.verdict !== VERDICT_SAME && false)) { /* SABOTAGE identity-always-same */`,
    reds: "★② recycled / unverifiable 两条",
  },
  {
    name: "taskkill-by-image", file: "src/server/server.mjs",
    what: "把 taskkill 改成按镜像名终止（契约明文禁止：只按 PID）",
    from: `  const soft = await run(["/PID", String(pid)]);`,
    to: `  const soft = await run(["/PID", String(pid), "/IM", "WorkBuddy.exe"]); /* SABOTAGE taskkill-by-image */`,
    reds: "★③ 只按 PID 那条 + 源码层面那条",
  },
  {
    name: "restart-picks-sidecar", file: "src/server/server.mjs",
    what: "让自动重启改去踢 sidecar / 终端那一类子进程（违反「绝不碰终端 PTY」）",
    from: `  const mains = pool.filter((x) => !isChild(x));`,
    to: `  const mains = pool.filter((x) => isChild(x)); // SABOTAGE restart-picks-sidecar`,
    reds: "★④ 终端 PTY / sidecar / daemon / renderer 存活那条",
  },
  {
    name: "no-auto-restart", file: "src/server/server.mjs",
    what: "捕获流程里不再自动重启客户端（退回「用户完全退出 → 重开 → 发消息」）",
    from: `    const r = opts.autoRestart === true ? await wbAutoRestartClient(p, {`,
    to: `    const r = false ? await wbAutoRestartClient(p, { // SABOTAGE no-auto-restart`,
    reds: "零操作路径（restarting 文案 / restarted / spawn / 抓到手）",
  },
  {
    name: "silent-restart", file: "src/server/server.mjs",
    what: "自动重启时不再告知「窗口会被关掉、未保存内容可能丢失」",
    from: `          \`正在自动重启 \${zh} 客户端：**你的客户端窗口会被关掉并重新打开**，未保存的对话内容可能丢失。\``,
    to: `          \`正在自动重启 \${zh} 客户端。\`; // SABOTAGE silent-restart`,
    reds: "③ 「窗口会被关掉并重新打开」「未保存」两条",
  },
];
const FILE_PATHS = { "src/server/server.mjs": SERVER_PATH };
for (const s of SABOTAGE) s.path = FILE_PATHS[s.file];

if (process.argv.includes("--list-sabotage")) {
  console.log(`wb-auto-capture 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(26)} ${s.what}\n  ${"".padEnd(26)} → 会打红: ${s.reds}`);
  process.exit(0);
}
if (process.argv.includes("--sabotage")) {
  const name = process.argv[process.argv.indexOf("--sabotage") + 1];
  const s = SABOTAGE.find((x) => x.name === name);
  if (!s) { console.error(`没有这条手法：${name}`); process.exit(2); }
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}
