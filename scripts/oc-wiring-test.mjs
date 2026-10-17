/**
 * OpenCode **接线层**测试（v1.0.75）
 *
 * ## 测什么
 *
 * 接的是 `src/server/oc-wiring.mjs`（接线）+ 它在 `src/server/server.mjs` 里那几处改动，
 * **不改** oc-runtime.mjs / oc-bridge.mjs（那两个模块各有自己的测试）。
 *
 *   ① 传输开关：`zenTransportOf` 的默认值与兜底（**出厂必须 direct**）
 *   ② 关闭态：transport=direct 时**根本没起 OpenCode 进程**，走的还是原来的直连路径
 *   ③ 模型映射：`j.model` 经 S.mapping 解析成要调的模型，**两个方向都传**给桥
 *   ④ 会话映射：同一段对话复用同一个 session id
 *   ⑤ 应答：流式 SSE 事件序列 / 非流式整条 JSON
 *   ⑥ 零字节纪律：确认上游有可用响应之前一个字都不写（影子 res 还能接手）
 *   ⑦ 具名错误：找不到二进制 → 可执行的安装指引；空响应 → 让故障转移接手
 *   ⑧ **端到端**：真 server.mjs + 真 `opencode serve` 进程，经**我们的中转路径**发一个
 *      带工具的 Anthropic 请求，断言拿到 `tool_use`
 *   ⑨ **端到端的关闭态**：真 server.mjs + transport=direct + 假上游，断言一个 OpenCode
 *      进程都不起，且直连请求逐字照旧
 *
 * ①～⑦ 用**注入的假依赖**（假运行时 / 假 fetch / 假 res），不起进程、不发真网络；
 * ⑧⑨ 才起真进程（cwd 用临时目录、端口 17xxx 段、会话权限由 oc-runtime 固定为 `ask`）。
 *
 * ## 红线
 *
 * 🔴 全文没有一个真实令牌/API key。落盘只在 `os.tmpdir()` 下的临时目录，
 *    **绝不碰真实的 %APPDATA%\bai-router**。进程只按 **PID** 收（taskkill /PID 与
 *    PowerShell Stop-Process -Id），绝不用按镜像名的 /IM——用户很可能自己开着 OpenCode 在用。
 * 🔴 找不到 opencode 时**不下载**，只给安装指引。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";

import {
  createOcGateway, zenTransportOf, writeAnthropicMessage, classifyRuntimeFailure,
  ocInstallHint, spawnableExists, classifyTransportError, ocSpawnEnv,
  ZEN_TRANSPORTS, ZEN_TRANSPORT_DIRECT, ZEN_TRANSPORT_OPENCODE, OC_PROBE_SESSION_KEY,
  OC_IDLE_TIMEOUT_MS,
} from "../src/server/oc-wiring.mjs";
import { CaptureRes } from "../src/server/failover.mjs";
import { shouldFailover } from "../src/server/failover.mjs";
import { DIAG } from "../src/server/oc-bridge.mjs";
import { sessionKeyOf, createRuntime, IDLE_TIMEOUT_MS } from "../src/server/oc-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const DEFAULTS_JSON = path.join(REPO, "src", "server", "config.defaults.json");
const SRC = readFileSync(SERVER, "utf8");
const TMPROOT = mkdtempSync(path.join(os.tmpdir(), "bai-oc-wiring-"));

/** 明显不是真 Key 的假凭据。红线：绝不把真 Key 写进任何文件 / 命令行 / 日志。 */
const DUMMY_KEY = "oc_dummy-not-a-real-key";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 假的 res：记录写过的每个 head 与每个字节。用来断言「在失败前一个字节都没写」。 */
function fakeRes() {
  return {
    statusCode: 0, headers: null, body: "", chunks: [], ended: false,
    get headersSent() { return this.statusCode > 0; },
    get writableEnded() { return this.ended; },
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    write(chunk) { const s = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); this.chunks.push(s); this.body += s; },
    end(chunk) { if (chunk) this.write(chunk); this.ended = true; },
  };
}

const SSE_RX = /^event:\s*(\S+)\s*\ndata:\s*([\s\S]*?)\s*$/;
/** 从 SSE 文本里取出全部 `event: X` 的顺序。 */
const sseEvents = (text) => String(text).split("\n\n").map((b) => (b.match(SSE_RX) || [])[1]).filter(Boolean);
/** 取某个 event 的全部 data 体（同名会多次出现）。 */
function sseAll(text, ev) {
  const out = [];
  for (const block of String(text).split("\n\n")) {
    const m = block.match(SSE_RX);
    if (!m || m[1] !== ev) continue;
    try { out.push(JSON.parse(m[2])); } catch { /* 心跳等非 JSON 帧 */ }
  }
  return out;
}
const sseData = (text, ev) => sseAll(text, ev)[0] || null;

/** 一个假的 OpenCode 运行时：记录每次会话键，session id 稳定派生。 */
function fakeRuntime({ sessionIds = {}, fail = null } = {}) {
  const calls = [];
  return {
    calls, base: "http://127.0.0.1:1", pid: null,
    sessionFor: async (key, title) => {
      calls.push({ key, title });
      if (fail) return fail;
      const created = !sessionIds[key];
      if (created) sessionIds[key] = `ses_${String(calls.length)}_${key.replace(/[^a-z0-9]/gi, "").slice(0, 6)}`;
      return { ok: true, sessionId: sessionIds[key], created };
    },
    diagnostics: () => ({ running: true, sessions: Object.keys(sessionIds).length }),
    dispose: () => ({ ok: true }),
  };
}

/** 一个「OpenCode 说它回了一个 tool-calls」的响应。modelID 故意取 big-pickle——
 *  那是 OpenCode 的内部 id，漏传 opts.model 时客户端就会收到它。 */
const OC_TOOL_RESPONSE = {
  info: { role: "assistant", finish: "tool-calls", modelID: "big-pickle", tokens: { input: 1200, output: 40, cache: { read: 300, write: 0 } } },
  structured: { content: "我先读一下这个文件。", calls: [{ name: "Read", arguments: { file_path: "/etc/hostname" } }] },
};

const TOOLS = [
  { name: "Read", description: "读一个文件", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { name: "Bash", description: "跑一条命令", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];

/** 假上游必须像真 fetch 一样同时给出 json() 和 text()。
 *  消息那一发现在走 oc-tool-guard，而守卫**逐字读 text() 再从同一段解析 json()**
 *  （正文被吞成空串的那个 bug 就出在这里）。只给 json() 的桩会把这条契约藏起来。 */
const ocOk = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const ocFail = (status, text) => new Response(text, { status });

const REQ = (over = {}) => ({
  model: "claude-sonnet-4-5", max_tokens: 1024, stream: false,
  system: "You are Claude Code.",
  messages: [{ role: "user", content: "用 Read 工具读 /etc/hostname。" }],
  tools: TOOLS, tool_choice: { type: "auto" }, ...over,
});

const mapTo = (target) => () => target;
const CFG_OPEN = { zen: { transport: "opencode", ocPort: 17899 } };

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

/** 这个端口上有人监听吗（用来断言「OpenCode 进程没起 / 起了」）。 */
function live(port) {
  return new Promise((r) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.on("connect", () => { s.destroy(); r(true); });
    s.on("error", () => r(false));
    setTimeout(() => { try { s.destroy(); } catch { } r(false); }, 1500);
  });
}

/** 收掉「命令行里带我们这个测试端口」的 opencode 进程。
 *  比扫日志可靠：日志是异步分块送达的，进程退出那一刻未必已经落到父进程缓冲区里。
 *  **仍然不是按镜像名批量杀**——先按 `--port <本次测试的端口>` 精确筛，
 *  用户自己开着的 OpenCode 端口不同，筛不到。 */
function killOpencodeOnPort(port) {
  if (!port) return;
  try {
    spawnSync("powershell", ["-NoProfile", "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object { $_.CommandLine -like '*--port ${port}*' } | Select-Object -ExpandProperty ProcessId; if ($p) { Stop-Process -Id $p -Force }`],
      { stdio: "ignore", windowsHide: true, timeout: 30000 });
  } catch { /* 查询失败就只剩日志那条路 */ }
}

/** 本文件 spawn 出去的每一个 PID。退出时逐个按 PID 收掉——**绝不按镜像名批量杀**。
 *  为什么要单独记一份：`child.kill()` 只按 PID 能收 server.mjs，但它 spawn 出来的
 *  opencode.exe 是**孙子进程**，父进程被硬杀时收不到（`process.on("exit")` 在
 *  TerminateProcess 下根本不跑）。漏掉的话每次跑测试都留下一具 550MB 的常驻进程，
 *  而且它们还在继续打免费档 —— 跑几轮之后上游开始限流，测试就变成时好时坏。 */
/** 同步等一会儿（只在这里用：kill 里必须是同步的，process.on("exit") 里没有 await 的机会）。 */
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const SPAWNED_PIDS = new Set();
/** 本文件用过的 opencode 端口：退出时按端口精确收尾，避免留下 550MB 的常驻进程。 */
const OC_PORTS = new Set();
const killByPid = (pid) => {
  if (!pid) return;
  SPAWNED_PIDS.delete(pid);
  try { spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* 已退出 */ }
};
process.on("exit", () => {
  for (const pid of [...SPAWNED_PIDS]) killByPid(pid);
  for (const port of OC_PORTS) killOpencodeOnPort(port);   // 兜底：无论钩子跑没跑到，一个都不留
});

/** 真 server.mjs 起一份：临时 DATA_DIR、端口全部动态挑空闲的、预设 proxy 防自重启。 */
async function bootServer(cfgOverrides) {
  const ports = await freePorts(10);
  const P = { bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4], qd: ports[5], or: ports[6], panel: ports[7], upstream: ports[8], oc: ports[9] };
  const dataDir = mkdtempSync(path.join(TMPROOT, "boot-"));

  const cfg = JSON.parse(readFileSync(DEFAULTS_JSON, "utf8"));
  cfg.failover.enabled = false;
  /* ⚠ **两件事必须同时做**，缺一不可（本机实测踩了两轮）：
   *
   * ① `cfg.proxy` 预置成探测必定会选中的那个值 → `applyProxy` 的首行
   *    `if ((cfg.proxy || "") === norm) return false` 短路，**不自重启**。
   *    置空反而更糟：detectWorkingProxy 探到 7897 → applyProxy 写配置并 spawn 继任者
   *    再 exit(0)，本进程被换掉，后面所有请求打到一个我们没在看的实例上。
   *
   * ② 同时把 HTTP_PROXY/HTTPS_PROXY 从**子进程环境**里摘掉。本机那台 7897 代理当前
   *    对 opencode.ai 的转发会整个挂住（实测：带代理同一条请求 240s 无响应，
   *    不带 4.8s 就回），而 server.mjs 会把 env 原样传给 opencode 子进程。
   *    端到端要断言的是**接线**，结果不该取决于「这台机器的代理此刻好不好用」。
   */
  cfg.proxy = "http://127.0.0.1:7897";
  Object.assign(cfg, cfgOverrides(P, cfg));
  /* 端口**最后**统一改写：override 若整块替换了某个渠道的子对象（`{...DEFAULTS.zen}`），
   * 会在前面把它带回出厂端口 15752 —— 那正是真实装机在用的端口，绝不能去抢。 */
  cfg.relayPort = P.bai; cfg.panelPort = P.panel;
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "or"]) cfg[k] = { ...cfg[k], relayPort: P[k] };
  writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

  const out = [];
  /* 代理环境变量一并摘掉（理由见上面 cfg.proxy 那段注释）：server.mjs 会把它传给
   * opencode 子进程，那台代理当前会把 opencode.ai 的转发整个挂住。 */
  const env = { ...process.env, BAI_DATA_DIR: dataDir, NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1", BAI_NO_PROXY_AUTODETECT: "1" };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
  env.NO_PROXY = "127.0.0.1,localhost";
  const child = spawn(process.execPath, [SERVER], {
    env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.on("data", (d) => out.push(String(d)));
  const err = [];
  child.stderr.on("data", (d) => err.push(String(d)));

  let up = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) { up = true; break; } }
    catch { }
    await sleep(300);
  }
  if (!up) {
    try { child.kill(); } catch { }
    throw new Error(`server.mjs 40 秒内没把面板端口起起来。\nstdout 尾：${out.join("").slice(-1500)}\nstderr 尾：${err.join("").slice(-1500)}`);
  }
  /* 等各家中转端口都起来（面板先起，中转后起）。 */
  const t1 = Date.now();
  while (Date.now() - t1 < 20000) {
    if (await live(P.zen)) break;
    await sleep(200);
  }
  if (!up || !(await live(P.zen))) {
    throw new Error(`中转端口 ${P.zen} 没起来。\nstdout 尾：${out.join("").slice(-1500)}\nstderr 尾：${err.join("").slice(-800)}`);
  }
  const kill = () => {
    /* opencode 是孙子进程：server.mjs 被硬杀时收不到它。三条路一起走，总有一条能中：
     *   ① 按端口精确筛（最可靠）② 日志里的「就绪 pid=NNNN」  ③ 兜底等待重扫 */
    killOpencodeOnPort(P.oc);
    for (let i = 0; i < 5; i++) {
      const pids = [...out.join("").matchAll(/OpenCode 运行时：就绪 pid=(\d+)/g)].map((m) => Number(m[1]));
      if (pids.length) { for (const pid of pids) killByPid(pid); break; }
      sleepSync(300);
    }
    killOpencodeOnPort(P.oc);
    killByPid(child.pid);
    /* 杀掉子进程后**必须把它的管道拆掉**：管道还挂着就会让本文件的 event loop
     * 一直有活干，node --test 的子进程迟迟不退出，外层就永远等不到汇总行。 */
    try { child.stdout.destroy(); child.stderr.destroy(); } catch { }
    try { child.removeAllListeners("data"); } catch { }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { }
  };
  SPAWNED_PIDS.add(child.pid);
  OC_PORTS.add(P.oc);
  return { P, dataDir, out, kill };
}

/** 直连路径的假上游：给一段**有内容**的 OpenAI SSE。
 *  必须有内容是因为 wbPipe 把「只有 message_start 的空流」判成上游失败（502），
 *  而本用例要断言的是「走的还是原来的直连路径」，所以得让直连真的成功。 */
const DIRECT_SSE = (marker) => [
  'data: ' + JSON.stringify({ choices: [{ delta: { content: marker } }] }),
  '',
  'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 2 } }),
  '',
  'data: [DONE]',
  '',
  '',
].join("\n");

const relayOf = (P) => (body, ms = 240000) => fetch(`http://127.0.0.1:${P.zen}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(ms),
});

after(() => { try { rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ================================================================== *
 * ① 传输开关：默认值与兜底
 * ================================================================== */
describe("① 传输开关：出厂与兜底一律 direct", () => {
  test("出厂值就是 direct（config.defaults.json 里 zen.transport）", () => {
    const d = JSON.parse(readFileSync(DEFAULTS_JSON, "utf8"));
    assert.equal(d.zen.transport, "direct", "config.defaults.json 的 zen.transport 出厂必须是 direct");
    assert.deepEqual([...ZEN_TRANSPORTS], ["direct", "opencode"]);
  });

  test("缺字段 / 空 cfg / 非字符串 → direct（绝不因为改动而改变直连怎么失败）", () => {
    assert.equal(zenTransportOf(undefined), "direct");
    assert.equal(zenTransportOf({}), "direct");
    assert.equal(zenTransportOf({ zen: {} }), "direct");
    assert.equal(zenTransportOf({ zen: { transport: null } }), "direct");
    assert.equal(zenTransportOf({ zen: { transport: 1 } }), "direct");
    /* 认错的大小写 / 拼写 / 前后空白一律当没打开 —— 退回到改动前的行为 */
    for (const bad of ["OpenCode", "OPENCODE", "open code", " opencode ", "", "sse", "http"]) {
      assert.equal(zenTransportOf({ zen: { transport: bad } }), "direct", `「${bad}」必须回落到 direct`);
    }
  });

  test("只有精确的 \"opencode\" 才打开", () => {
    assert.equal(zenTransportOf({ zen: { transport: "opencode" } }), "opencode");
    assert.equal(zenTransportOf({ zen: { transport: "direct" } }), "direct");
  });

  test("反向对照：判据认得出真正的开关值（否则上面几条就是永远通过的死断言）", () => {
    /* 拿一个「兜底被反过来」的替身当探针：垃圾值被判成 opencode 时，下面这条必须红。 */
    const flipped = (cfg) => (cfg && cfg.zen && cfg.zen.transport !== undefined && cfg.zen.transport !== "direct"
      ? "opencode" : "direct");
    assert.equal(flipped({ zen: { transport: "opencode" } }), "opencode");
    assert.equal(flipped({ zen: { transport: "direct" } }), "direct");
    assert.equal(flipped({ zen: { transport: "OpenCode" } }), "opencode",
      "反向对照的探针本身有效：兜底一旦被反过来，上面那条 garbage 用例会红");
    assert.equal(flipped({}), "direct");
  });
});

/* ================================================================== *
 * ①.5 spawn 环境隔离：子进程的数据目录必须独立（2026-10-17）
 * ================================================================== */
describe("①.5 spawn 环境隔离：ocSpawnEnv 四件套", () => {
  test("四个 XDG 目录全部落在 base/xdg/ 下，且不改传入的 env", () => {
    const base = path.join(TMPROOT, "wd");
    const src = { TEMP: "C:/tmp-t", KEEP: "1" };
    const out = ocSpawnEnv(src, base);
    assert.equal(out.XDG_DATA_HOME, path.join(base, "xdg", "data"));
    assert.equal(out.XDG_CONFIG_HOME, path.join(base, "xdg", "config"));
    assert.equal(out.XDG_CACHE_HOME, path.join(base, "xdg", "cache"));
    assert.equal(out.XDG_STATE_HOME, path.join(base, "xdg", "state"));
    assert.equal(out.KEEP, "1", "原 env 的字段必须原样保留");
    assert.equal(src.XDG_DATA_HOME, undefined, "不得改动传入的 env 对象");
  });

  test("没有 base 时退回 TEMP/TMP；两者都没有时原样返回（不猜路径）", () => {
    const viaTemp = ocSpawnEnv({ TEMP: path.join(TMPROOT, "t-emp") }, undefined);
    assert.equal(viaTemp.XDG_DATA_HOME, path.join(TMPROOT, "t-emp", "xdg", "data"));
    const viaTmp = ocSpawnEnv({ TMP: path.join(TMPROOT, "t-mp") }, undefined);
    assert.equal(viaTmp.XDG_STATE_HOME, path.join(TMPROOT, "t-mp", "xdg", "state"));
    const bare = { A: "1" };
    assert.equal(ocSpawnEnv(bare, undefined), bare, "没有任何落点时原样返回（不猜）");
  });

  test("接线真的用了它：runtime() 必须把隔离 env 传给 createRuntime（源码级，防改回）", () => {
    const W = readFileSync(path.join(REPO, "src", "server", "oc-wiring.mjs"), "utf8");
    assert.ok(W.includes("env: ocSpawnEnv(env, wd)"),
      "runtime() 必须把 ocSpawnEnv 的结果传给 createRuntime——改回原始 env 会在装有桌面版的机器上再次撞库退出（2026-10-17 实测）");
    assert.ok(W.includes("findOpenCodeBinary({ env, exists: spawnableExists() })"),
      "二进制发现仍须用原始 env（探测路径是 PATH/APPDATA，与 XDG 隔离无关）");
  });
});

/* ================================================================== *
 * ② 关闭态：transport=direct 时原路不变，一个 OpenCode 进程都不起
 * ================================================================== */
describe("② 关闭态：transport=direct 完全走原路径", () => {
  test("分流判据在 openaiExchange 里，且限定在 zen 一个渠道上", () => {
    const i = SRC.indexOf('if (p === "zen" && zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE) {');
    assert.ok(i > 0, "server.mjs 里找不到 openaiExchange 的分流判据");
    const line = SRC.slice(i, SRC.indexOf("\n", i));
    assert.ok(line.includes('p === "zen"'), "分流必须限定在 zen 渠道");
    assert.ok(line.includes("ZEN_TRANSPORT_OPENCODE"), "分流必须限定在开关值上");
  });

  test("分流必须在取 Zen 令牌之前（否则不配 Key 就永远到不了 OpenCode，开关等于打不开）", () => {
    const i = SRC.indexOf("async function openaiExchange(");
    assert.ok(i > 0, "server.mjs 里找不到 openaiExchange");
    const body = SRC.slice(i, i + 3200);
    const gate = body.indexOf("zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE");
    assert.ok(gate > 0, "openaiExchange 里没有 transport 分流判据");
    const tokenAt = body.indexOf("cfg.zen && cfg.zen.apiKey");
    assert.ok(tokenAt > 0, "openaiExchange 里找不到取 Zen 令牌的代码");
    assert.ok(gate < tokenAt, `分流判据必须在取令牌之前（判据 ${gate}，取令牌 ${tokenAt}）`);
  });

  test("分流条件唯一；形态判据在准入/目录/能力表/探测门各有一处（2026-10-17 客户端中转适配后）", () => {
    /* 旧断言是「zenTransportOf(cfg) 恰好 2 次」——那是「分流 + 准入」时期的数字。
     * 客户端中转形态需要四处判据（分流 / 准入 / 目录放行 / 能力表 / 探测门），
     * 数量不再有意义，**位置**才有：分流的条件字符串必须唯一，其余各处必须是「有」。 */
    const gateCount = (SRC.match(/p === "zen" && zenTransportOf\(cfg\) === ZEN_TRANSPORT_OPENCODE/g) || []).length;
    assert.equal(gateCount, 1, `openaiExchange 的分流条件必须唯一，实际 ${gateCount} 次`);
    const pc = SRC.indexOf("function providerConfigured(");
    assert.ok(pc > 0 && SRC.slice(pc, pc + 4000).includes("zenTransportOf(cfg)"),
      "providerConfigured 的准入判定必须带形态判据");
    assert.ok(SRC.includes("const ocTransport = zenTransportOf(cfg)"),
      "目录分支必须有形态放行判据（客户端中转下免费模型全体放行）");
    const zc = SRC.indexOf("function zenCapFields(");
    assert.ok(zc > 0 && SRC.slice(zc, zc + 1200).includes("zenTransportOf(cfg)"),
      "zenCapFields 必须区分两种形态（能力表文案）");
    const probe = SRC.indexOf('"/api/models/probe-zen"');
    assert.ok(probe > 0 && SRC.slice(probe, probe + 900).includes("zenTransportOf(cfg)"),
      "probe-zen 必须先判形态（客户端中转下不做直连探测）");
  });

  test("providerConfigured：直连仍要 Zen Key，opencode 档不读它", () => {
    const i = SRC.indexOf("function providerConfigured(");
    const body = SRC.slice(i, SRC.indexOf("\n}", i));
    const zenAt = body.indexOf('provider === "zen"');
    assert.ok(zenAt > 0, "providerConfigured 里没有 zen 分支");
    const zen = body.slice(zenAt);
    assert.ok(zen.includes("cfg.zen?.apiKey"), "zen 仍必须认 Zen API Key（直连那条路一个字没变）");
    assert.ok(zen.includes("ZEN_TRANSPORT_OPENCODE"), "opencode 档必须能在没有 Zen Key 时也算已配置");
    /* 顺带确认没有别的渠道被顺手改过 */
    for (const other of ['provider === "or"', 'provider === "qd"', 'provider === "wb"']) {
      const seg = body.slice(body.indexOf(other));
      assert.ok(!seg.slice(0, 120).includes("zenTransportOf"), `${other} 的准入判定不得被这一档的开关污染`);
    }
  });

  test("spawnableExists：Windows 上无扩展名的 shim 被当不存在（否则会挑中一个 spawn 不起来的路径）", () => {
    const s = spawnableExists(() => true);
    assert.equal(process.platform === "win32" ? s("C:\\x\\npm\\opencode") : true, false,
      "where opencode 的第一条（无扩展名 shim）必须被挡掉");
    assert.equal(s("C:\\x\\npm\\opencode.exe"), true, ".exe 必须放行");
    assert.equal(s("C:\\x\\npm\\opencode.cmd"), true, ".cmd 必须放行（oc-runtime 会自动加 shell）");
    assert.equal(spawnableExists(() => false)("C:\\x\\opencode.exe"), false, "真实 exists 为假时仍为假");
  });

  test("spawnableExists 不传参数时落回真的 fs.existsSync（曾经默认成恒假 → 明明装着的机器被说成没装）", () => {
    /* 用 node.exe 当「一定存在且形态可执行」的样本：无扩展名的文件本来就会被
     * 那道形态闸挡掉（见上一条），拿它当探针会把「判据退化了」和「形态被挡」混在一起。 */
    assert.equal(spawnableExists()(process.execPath), true,
      "默认判据必须真的去看文件系统 —— 否则所有机器都会得到「找不到 opencode 二进制」");
    assert.equal(spawnableExists()(path.join(process.execPath, "definitely-not-here.exe")), false,
      "真的不存在的文件仍然要判不存在");
  });

  test("ocInstallHint：给出可执行的安装命令 + 一键安装指引，且明说只在点击时下载", () => {
    const h = ocInstallHint([{ how: "where", path: "C:\\x\\npm\\opencode" }]);
    assert.match(h, /npm i -g opencode-ai/, "必须给出可执行的安装命令");
    assert.match(h, /opencode\.ai/, "必须给出官网");
    assert.match(h, /一键安装/, "必须告诉用户面板上的一键安装（2026-10-17 起）");
    assert.match(h, /不会自动替你下载/, "必须明说只有点击时才下载、除此之外不自动下载");
    assert.match(h, /C:\\x\\npm\\opencode/, "必须如实列出试过的路径");
  });
});

/* ================================================================== *
 * ③～⑦ 网关单元测试（注入假依赖：不起进程、不发真网络）
 * ================================================================== */
describe("③ 网关：模型映射 / 会话映射 / 应答 / 零字节纪律 / 具名错误", () => {
  const mk = (o = {}) => createOcGateway({
    log: () => {},
    runtimeFactory: () => o.rt || fakeRuntime(),
    fetchImpl: o.fetchImpl || (async () => ocOk(OC_TOOL_RESPONSE)),
    portOf: () => 17899,
    timeoutOf: () => 3000,
    ...o.deps,
  });
  /** 跑一次 exchange。**res 必须传给调用方**——断言要看的就是它，不能在内部造一个丢掉的。 */
  const go = async (gw, over = {}) => {
    const res = over.res || fakeRes();
    await gw.exchange({ cfg: CFG_OPEN, j: REQ(), isProbe: false, mapModel: mapTo("space-bunny-free"), ...over, res });
    return res;
  };

  test("③ 模型映射：解析结果进 opts.model，**两个方向都传**", async () => {
    let posted = null;
    const gw = mk({ fetchImpl: async (_url, init) => {
      posted = JSON.parse(init.body);
      return ocOk(OC_TOOL_RESPONSE);
    } });
    const res = fakeRes();
    await gw.exchange({ cfg: CFG_OPEN, j: REQ(), isProbe: false, res, mapModel: mapTo("space-bunny-free") });

    /* 请求方向：载荷里的 model 必须是映射结果，不是 Claude 的档位名 */
    assert.deepEqual(posted.model, { providerID: "opencode", modelID: "space-bunny-free" },
      "请求载荷的 model 必须是映射后的目标模型");
    assert.notEqual(posted.model.modelID, "claude-sonnet-4-5", "绝不能把 Anthropic 侧的档位名发给 OpenCode");

    /* 响应方向：★ 不传 opts.model 时 message.model 会落成 OpenCode 的内部 id（big-pickle） */
    const msg = JSON.parse(res.body);
    assert.equal(msg.model, "space-bunny-free", `message.model 必须是映射后的目标模型，实际 ${msg.model}`);
    assert.notEqual(msg.model, "big-pickle", "绝不能让客户端收到 OpenCode 的内部模型 id");
    assert.equal(OC_TOOL_RESPONSE.info.modelID, "big-pickle", "夹具本身就是内部 id（判据的前提）");
  });

  test("③ 映射结果为空 → 明确报错，而不是发一个没有模型的请求过去", async () => {
    const gw = mk();
    const res = fakeRes();
    await gw.exchange({ cfg: CFG_OPEN, j: REQ(), isProbe: false, res, mapModel: mapTo("") });
    assert.ok(res.statusCode >= 400, "映射结果为空时必须报错而不是发出去");
    assert.match(res.body, new RegExp(DIAG.MODEL_MISSING), `错误里必须点名诊断码 ${DIAG.MODEL_MISSING}`);
  });

  test("④ 会话映射：同一段对话复用同一个 session id，不同对话不同", async () => {
    const seen = [];
    /* 消息那一发现在走守卫，守卫还会轮询 /permission；这里按路由如实应答，
       断言只数 message 那一发（本测试要验的正是「每轮一次、session id 复用」）。 */
    const gw = mk({ fetchImpl: async (url) => {
      seen.push(url);
      return new URL(url).pathname === "/permission" ? ocOk([]) : ocOk(OC_TOOL_RESPONSE);
    } });
    const convA = REQ({ messages: [{ role: "user", content: "对话甲的第一句" }] });
    const convA2 = REQ({ messages: [{ role: "user", content: "对话甲的第一句" }, { role: "assistant", content: "好" }, { role: "user", content: "第二轮" }] });
    const convB = REQ({ messages: [{ role: "user", content: "对话乙的第一句" }] });
    for (const j of [convA, convA2, convB]) await go(gw, { j });
    const posts = seen.filter((u) => u.endsWith("/message"));
    assert.equal(posts.length, 3);
    const urlOf = (u) => decodeURIComponent((u.match(/\/session\/([^/]+)\/message$/) || [])[1]);
    assert.ok(urlOf(posts[0]), "URL 里必须带 session id");
    assert.equal(urlOf(posts[0]), urlOf(posts[1]), "同一段对话两轮必须是同一个 session id（否则上下文会丢）");
    assert.notEqual(urlOf(posts[0]), urlOf(posts[2]), "不同对话必须是不同的 session id");
  });

  test("④ 探针走固定会话键，不给每次探测都造一个新会话", async () => {
    const rt = fakeRuntime();
    const gw = mk({ rt });
    for (let i = 0; i < 2; i++) {
      await go(gw, { j: REQ({ messages: [{ role: "user", content: `探针 ${i}` }] }), isProbe: true });
    }
    assert.deepEqual(rt.calls.map((c) => c.key), [OC_PROBE_SESSION_KEY, OC_PROBE_SESSION_KEY], "探针必须复用同一个会话键");
  });

  test("⑤ 流式：完整且有序的 Anthropic 事件序列", async () => {
    const gw = mk();
    const res = await go(gw, { j: REQ({ stream: true }) });
    assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.deepEqual(sseEvents(res.body), [
      "message_start", "ping",
      "content_block_start", "content_block_delta", "content_block_stop",   // 文本块
      "content_block_start", "content_block_delta", "content_block_stop",   // tool_use 块
      "message_delta", "message_stop",
    ], `事件序列不对：${JSON.stringify(sseEvents(res.body))}`);

    assert.equal(sseData(res.body, "message_start").message.model, "space-bunny-free");
    const starts = sseAll(res.body, "content_block_start");
    assert.equal(starts[1].content_block.type, "tool_use");
    assert.equal(starts[1].content_block.name, "Read");
    assert.equal(starts[0].index, 0);
    assert.equal(starts[1].index, 1, "块的 index 必须连续");
    const deltas = sseAll(res.body, "content_block_delta");
    assert.equal(deltas[0].delta.type, "text_delta");
    assert.equal(deltas[1].delta.type, "input_json_delta");
    assert.deepEqual(JSON.parse(deltas[1].delta.partial_json), { file_path: "/etc/hostname" });
    const md = sseData(res.body, "message_delta");
    assert.equal(md.delta.stop_reason, "tool_use", "有 tool_use 时 stop_reason 必须是 tool_use");
    assert.equal(md.usage.output_tokens, 40, "usage 要回填");
    assert.equal(md.usage.input_tokens, 1500, "缓存 token 要并进 input");
  });

  test("⑤ 非流式：一条完整的 Anthropic JSON 消息", async () => {
    const gw = mk();
    const res = await go(gw);
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.ok(!res.body.includes("event:"), "非流式不得吐 SSE");
    const msg = JSON.parse(res.body);
    assert.equal(msg.type, "message");
    assert.equal(msg.role, "assistant");
    assert.equal(msg.stop_reason, "tool_use");
    const tu = msg.content.find((b) => b.type === "tool_use");
    assert.ok(tu, "必须拿到 tool_use 块");
    assert.equal(tu.name, "Read");
    assert.deepEqual(tu.input, { file_path: "/etc/hostname" });
    assert.ok(tu.id && tu.id.length > 0, "tool_use 必须有 id");
    assert.equal(msg.usage.cache_read_input_tokens, 300, "缓存 token 要如实回填");
    assert.equal(msg.usage.input_tokens, 1500, "缓存 token 要并进 input");
  });

  test("⑥ 零字节纪律：上游失败时，不许先吐成功应答的任何一帧", async () => {
    /* 注意这里的判据是「**没有成功的字节**」，不是「一个字节都没写」——
     * 错误体必须写出来，故障转移的影子 res 靠它判定该不该换下一家渠道
     * （failover.mjs：writeHead(>=400) 缓冲 / writeHead(<400) 立刻固化）。 */
    for (const [name, fetchImpl] of [
      ["上游 500", async () => ocFail(500, "Internal server error")],
      ["连不上", async () => { throw new Error("ECONNREFUSED 127.0.0.1:17899"); }],
    ]) {
      const gw = mk({ fetchImpl });
      const res = await go(gw, { j: REQ({ stream: true }) });
      assert.notEqual(res.statusCode, 200, `${name}：绝不能先固化 200（那会让影子 res 判成功、永不转移）`);
      assert.equal(sseEvents(res.body).length, 0, `${name}：失败时不得发出任何 SSE 帧（实际 ${JSON.stringify(sseEvents(res.body))}）`);
      assert.ok(!/message_start/.test(res.body), `${name}：不得先吐 message_start`);
      assert.doesNotThrow(() => JSON.parse(res.body), `${name}：写出来的必须是可解析的错误体`);
      assert.match(res.body, /"type":"error"/, `${name}：必须是 Anthropic 形状的错误`);
    }
  });

  test("⑥ 影子 res：失败被缓冲，故障转移仍能接手（真用 failover.mjs 的 CaptureRes）", async () => {
    const real = fakeRes();
    const cap = new CaptureRes(real);
    const gw = mk({ fetchImpl: async () => ocFail(500, "Internal server error") });
    await go(gw, { j: REQ({ stream: true }), res: cap });
    assert.equal(cap.ok(), false, "影子 res 必须判为失败（否则永远不会转移）");
    assert.equal(cap.status, 500);
    assert.equal(real.body, "", "真实客户端一个字节都没收到");
    assert.match(Buffer.concat(cap.buf.map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(String(b))))).toString("utf8"), /OpenCode/);
  });

  test("⑥ 成功时影子 res 固化为 200，不再转移", async () => {
    const real = fakeRes();
    const cap = new CaptureRes(real);
    const gw = mk();
    await go(gw, { j: REQ({ stream: true }), res: cap });
    assert.equal(cap.ok(), true, "拿到可用响应后必须固化");
    assert.equal(real.body.includes("message_stop"), true, "内容必须落给真实客户端");
  });

  test("⑦ 找不到二进制：给出可执行指引，状态码让故障转移接手", async () => {
    const rt = fakeRuntime({ fail: { ok: false, reason: "opencode-not-found", tried: [{ how: "where", path: "C:\\x\\npm\\opencode" }] } });
    const gw = mk({ rt });
    const res = fakeRes();
    await go(gw, { res });
    assert.equal(res.statusCode, 503);
    const msg = JSON.parse(res.body).error.message;
    assert.match(msg, /npm i -g opencode-ai/, "必须给出可执行的安装命令");
    assert.match(msg, /不会自动替你下载/, "必须明说只有点击时才下载、除此之外不自动下载");
  });

  test("⑦ 空响应：当成上游失败，不把空回复当成功发出去", async () => {
    const gw = mk({ fetchImpl: async () => ocOk({ info: { finish: "stop", modelID: "big-pickle" }, parts: [] }) });
    const res = await go(gw, { j: REQ({ stream: true }) });
    assert.equal(res.statusCode, 502, "空响应必须报错让故障转移接手");
    assert.match(res.body, new RegExp(DIAG.ENVELOPE_UNPARSED), `必须点名 ${DIAG.ENVELOPE_UNPARSED}`);
    assert.ok(!/message_start/.test(res.body), "失败时绝不能已经吐了 message_start");
  });

  test("⑦ 403 FreeTierError：说清唯一判据与 deny 的关系", async () => {
    const gw = mk({ fetchImpl: async () => ocFail(403, '{"error":{"type":"FreeTierError"}}') });
    const res = fakeRes();
    await go(gw, { res });
    assert.equal(res.statusCode, 403);
    const msg = JSON.parse(res.body).error.message;
    assert.match(msg, /FreeTierError/);
    assert.match(msg, /deny/, "必须指向 deny 会把工具从可见列表里摘掉这个真因");
  });

  test("⑦ classifyRuntimeFailure 的状态码只按「该不该转移」选", () => {
    assert.equal(classifyRuntimeFailure("ready-timeout").status, 504);
    assert.equal(classifyRuntimeFailure("spawn-failed").status, 502);
    assert.equal(classifyRuntimeFailure("session-body-invalid").status, 500);
    assert.equal(classifyRuntimeFailure("opencode-not-found").status, 503);
    /* 反向对照：判据本身有效（不是恒等于某个值） */
    const codes = ["ready-timeout", "spawn-failed", "session-body-invalid", "opencode-not-found"].map((r) => classifyRuntimeFailure(r).status);
    assert.equal(new Set(codes).size >= 3, true, `状态码判据退化了：${JSON.stringify(codes)}`);
  });

  test("writeAnthropicMessage：未知块跳过而不是写非法事件", () => {
    const res = fakeRes();
    writeAnthropicMessage(res, {
      id: "m1", model: "x", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 },
      content: [{ type: "text", text: "hi" }, { type: "server_tool_use", id: "z" }, { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } }],
    }, true, {});
    const ev = sseEvents(res.body);
    assert.equal(ev.filter((e) => e === "content_block_start").length, 2, "未知块不得开出一个 content_block_start");
    assert.equal(ev[ev.length - 1], "message_stop");
  });
});

/* ================================================================== *
 * ⑧ 端到端：真 server.mjs + 真 opencode serve
 * ================================================================== */

/** OpenCode 二进制在这台机器上装没装。装不上就把整组端到端 skip，并说明原因。 */
function opencodeBin() {
  const exe = path.join(process.env.APPDATA || "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
  if (existsSync(exe)) return exe;
  return process.env.OC_BIN || "";
}
const OC_BIN = opencodeBin();
/* ★ 端到端两组默认**跳过**，除非显式 `OC_E2E=1`。理由不是怕麻烦，是它们依赖第三方：
 *  这一档打的是 OpenCode 免费档，实测有三种与被测代码无关的抖动——
 *    ① `opencode serve` 冷启动后的**第一条**消息会整个挂住（90 秒无响应）；
 *    ② 免费小模型偶发不按 StructuredOutput 信封作答 → 走防误杀兜底，200 但没有 tool_use；
 *    ③ 限量严，连发几次就被顶掉。
 *  把这种测试塞进 `npm test`，等于让仓库的测试命令跟着上游的心情变红。
 *  它仍然是**真端到端**（真 server.mjs + 真 opencode 进程 + 真上游），只是要人显式叫它跑：
 *      npm run test:oc-e2e
 *  跳过时 node 会把下面这句原因打在报告里，不会静默溜过去。 */
const SKIP_E2E = !OC_BIN
  ? `本机找不到 opencode 二进制（试过 %APPDATA%\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe 与环境变量 OC_BIN）`
  : (process.env.OC_E2E ? false : "端到端依赖第三方免费档，默认不跑；显式执行：npm run test:oc-e2e");

describe("⑧ 端到端：真 server.mjs + 真 opencode 进程", { skip: SKIP_E2E }, () => {
  let srv, relay;

  before(async () => {
    srv = await bootServer((P, cfg) => ({
      zen: {
        ...cfg.zen,
        transport: ZEN_TRANSPORT_OPENCODE,
        ocPort: P.oc,
        /* ★ 不配 Zen API Key：这一档用 OpenCode 自己的认证。填上 Key 反而验不出
         * 「分流在取令牌之前」这件事。 */
        apiKey: "",
        /* defaultModel 故意填一个**不存在**的模型名：映射没生效时代理就会打它，
         * 模型静默地什么都不回 → 空响应 → 502。所以「拿到 tool_use」本身就证明了映射被用上了。 */
        defaultModel: "not-a-real-model-zzz",
        availableModels: ["space-bunny-free"],
        mapping: { "claude-sonnet-4-5": { target: "space-bunny-free", label: "Space-Bunny-Free" } },
        upstream: `http://127.0.0.1:${P.upstream}/zen/v1`,
        useProxy: false,
        /* 把单条消息上限压到 45 秒：实测 opencode 冷启动后的第一条消息**会整个挂住**
         * （90 秒无响应，opencode 自己一声不吭），默认的 180 秒让每次失败尝试都烧 3 分钟，
         * 端到端根本跑不完。压到 45 秒 + 重试，才能把「链路通不通」和「上游这一下抖不抖」
         * 分开——断言仍然是严格的：真不通的话重试几次也还是不通。 */
        ocTimeoutMs: 45000,
      },
    }));
    relay = relayOf(srv.P);
  }, { timeout: 60000 });

  after(async () => {
    if (process.env.OC_DEBUG) console.log("[DEBUG] server.mjs 日志尾：\n" + srv.out.join("").slice(-3000));
    await sleep(300);   // 等 stdout 落完，否则「就绪 pid=NNNN」那行读不到 → opencode 漏收
    try { srv && srv.kill(); } catch { }
  });

  /**
   * 打一次，**直到响应满足 ok(text)** 为止（有界重试）。返回最后一次的 { status, text, tries }。
   *
   * 为什么要有界重试 —— 两个都是实测到的上游事实，不是给测试放水：
   *   ① `opencode serve` 冷启动后的**第一条**消息会整个挂住（90 秒无响应，
   *      opencode 自己一声不吭），第二、三条只要 2.5~3.6 秒；
   *   ② 这个免费小模型**偶发**不按 StructuredOutput 的信封作答，于是走 oc-bridge
   *      的防误杀兜底：原文当 text 透传 → 200 但没有 tool_use 块。
   * 链路本身是不是通的，与「这一下上游抖没抖」必须分开判：真不通的话重试到
   * 预算用完也还是不通，下面那些断言照样红。
   */
  async function relayUntil(body, ok, { tries = 4, gapMs = 10000 } = {}) {
    let last = { status: 0, text: "", tries: 0 };
    for (let i = 1; i <= tries; i++) {
      try {
        const r = await relay(body, 120000);
        last = { status: r.status, text: await r.text(), tries: i };
      } catch (e) {
        last = { status: 0, text: String((e && e.message) || e), tries: i };
      }
      if (last.status === 200 && ok(last.text)) {
        console.log(`    · 第 ${i} 次尝试拿到 200 且满足断言（正文 ${last.text.length} 字节）`);
        return last;
      }
      console.log(`    · 第 ${i} 次尝试不满足断言：status=${last.status} 正文前 120 字「${last.text.slice(0, 120)}」`);
      if (i < tries) await sleep(gapMs);
    }
    return last;
  }

  /** 流式 SSE 里有 tool_use 块吗 */
  const sseHasToolUse = (text) => sseAll(text, "content_block_start")
    .some((d) => d.content_block && d.content_block.type === "tool_use");

  test("经我们的中转路径发一个带工具的请求 → 真 OpenCode 进程回 tool_use（流式）", async () => {
    assert.equal(await live(srv.P.oc), false, "起点：OpenCode 还没被起");
    const got = await relayUntil({
      model: "claude-sonnet-4-5", max_tokens: 1024, stream: true,
      system: "You are Claude Code, a command-line coding assistant.",
      messages: [{ role: "user", content: "Use the Read tool to read /etc/hostname. Do not answer from memory." }],
      tools: TOOLS, tool_choice: { type: "auto" },
    }, sseHasToolUse);
    const text = got.text;
    assert.equal(got.status, 200, `期望 200，实际 ${got.status}：${text.slice(0, 500)}
—— server.mjs 日志尾：${srv.out.join("").slice(-2500)}`);

    const ev = sseEvents(text);
    assert.equal(ev[0], "message_start", `第一个事件必须是 message_start，实际 ${ev[0]}`);
    assert.match(text.slice(0, 200), /event:\s*message_start/, "响应必须是 SSE");
    assert.equal(ev[ev.length - 1], "message_stop", "最后一个事件必须是 message_stop");
    assert.ok(ev.includes("message_delta"));

    /* ★ 本测试的核心断言 */
    const tuStart = sseAll(text, "content_block_start").find((d) => d.content_block && d.content_block.type === "tool_use");
    assert.ok(tuStart, `没有拿到 tool_use 块。事件序列：${ev.join(",")}\n正文前 800 字：${text.slice(0, 800)}`);
    assert.ok(tuStart.content_block.id, "tool_use 必须有 id");
    assert.ok(["Read", "Bash"].includes(tuStart.content_block.name), `工具名单外的名字：${tuStart.content_block.name}`);

    /* 模型映射：★ message.model 必须是映射后的目标模型，不能是 OpenCode 的内部 id */
    assert.equal(sseData(text, "message_start").message.model, "space-bunny-free",
      "message.model 必须是映射后的目标模型，不能是 OpenCode 的内部 id，也不能是 Anthropic 档位名");
    assert.equal(sseData(text, "message_delta").delta.stop_reason, "tool_use",
      `有 tool_use 时 stop_reason 必须是 tool_use，实际 ${sseData(text, "message_delta").delta.stop_reason}`);

    /* 真进程确实起来了（这一档不走直连） */
    assert.equal(await live(srv.P.oc), true, "OpenCode serve 应当已经在监听（说明确实起了真进程）");
  }, { timeout: 300000 });

  test("非流式：同一条链路返回完整 JSON 消息（含 tool_use）", async () => {
    const got = await relayUntil({
      model: "claude-sonnet-4-5", max_tokens: 1024, stream: false,
      system: "You are Claude Code, a command-line coding assistant.",
      messages: [{ role: "user", content: "Use the Read tool to read /etc/hostname. Do not answer from memory." }],
      tools: TOOLS, tool_choice: { type: "auto" },
    }, (t) => { try { return (JSON.parse(t).content || []).some((b) => b.type === "tool_use"); } catch { return false; } });
    const text = got.text;
    assert.equal(got.status, 200, `期望 200，实际 ${got.status}：${text.slice(0, 500)}
—— server.mjs 日志尾：${srv.out.join("").slice(-2500)}`);
    assert.ok(!/event:/.test(text), "非流式不得吐 SSE 帧");
    const msg = JSON.parse(text);
    assert.equal(msg.type, "message");
    assert.equal(msg.model, "space-bunny-free");
    const tu = (msg.content || []).find((b) => b.type === "tool_use");
    assert.ok(tu, `非流式也要拿到 tool_use，实际块：${JSON.stringify((msg.content || []).map((b) => b.type))}`);
    assert.ok(tu.id && tu.name);
    assert.ok(["end_turn", "tool_use"].includes(msg.stop_reason), `stop_reason 非法：${msg.stop_reason}`);
    assert.ok(msg.usage && typeof msg.usage.input_tokens === "number", "usage 必须回填");
  }, { timeout: 300000 });

  test("会话复用：同一段对话两轮复用同一个 session id（接线日志里 key 相同、created 由 true 变 false）", async () => {
    /* 会话键是**首条 user 消息**的哈希，所以这段对话用一句带 nonce 的开场白——
     * 前面两条用例用的是同一句开场白，若不区分，本用例的「第一轮 created=true」
     * 就会命中上一条留下的会话，变成永远失败的断言。
     * nonce 只影响会话归属，不影响指令本身。 */
    const anchorText = `Use the Read tool to read /etc/hostname. Do not answer from memory. [reuse-probe ${Date.now().toString(36)}]`;
    const wantKey = sessionKeyOf(anchorText);
    const anchor = { role: "user", content: anchorText };
    for (const messages of [
      [anchor],
      [anchor, { role: "assistant", content: [{ type: "text", text: "我先读一下。" }] }, { role: "user", content: "继续" }],
    ]) {
      const got = await relayUntil({ model: "claude-sonnet-4-5", max_tokens: 512, stream: false, system: "You are Claude Code.", messages, tools: TOOLS, tool_choice: { type: "auto" } }, () => true);
      assert.equal(got.status, 200, `期望 200，实际 ${got.status}：${got.text.slice(0, 300)}`);
    }
    /* 按**本用例自己的会话键**筛，而不是按出现顺序取最后两条：server.mjs 的 stdout 是
     * 异步分块送达的，上一条用例那行可能此刻才落进缓冲区，按顺序取会串行。 */
    await sleep(300);
    const lines = srv.out.join("").split("\n")
      .filter((l) => l.includes("OpenCode 传输：200") && l.includes(`key=${wantKey} `));
    assert.equal(lines.length, 2, `本会话键下应当恰好两条成功记录，实际 ${lines.length}：${JSON.stringify(srv.out.join("").slice(-800))}`);
    assert.match(lines[0], /created=true/, `第一轮应当新建会话：${lines[0]}`);
    assert.match(lines[1], /created=false/, `第二轮必须复用同一个 session id（否则上下文会丢）：${lines[1]}`);
    const sid = (l) => (l.match(/session=(\S+?)…/) || [])[1];
    assert.ok(sid(lines[0]), `日志里要带 session id：${lines[0]}`);
    assert.equal(sid(lines[0]), sid(lines[1]), "两轮必须是同一个 session id");
  }, { timeout: 300000 });
});

/* ================================================================== *
 * ⑨ 端到端的关闭态：真 server.mjs + transport=direct + 假上游
 * ================================================================== */
describe("⑨ 端到端的关闭态：transport=direct 一个 OpenCode 进程都不起", () => {
  let srv, fake, seen, relay;
  let reply = null;

  before(async () => {
    seen = [];
    srv = await bootServer((P, cfg) => ({
      zen: {
        ...cfg.zen,
        /* ★ 出厂值。**显式写出来**是为了连 config.defaults.json 哪天被改坏也能立刻在这里暴露。 */
        transport: ZEN_TRANSPORT_DIRECT,
        ocPort: P.oc,
        /* 同 ⑧：把单条消息上限压到 45 秒，否则 opencode 冷启动挂住时每次失败尝试都烧 3 分钟。 */
        ocTimeoutMs: 45000,
        apiKey: DUMMY_KEY,
        upstream: `http://127.0.0.1:${P.upstream}/zen/v1`,
        useProxy: true,   // 让直连走 fetch 而非 directHttp，假上游才收得到
      },
    }));
    const P = srv.P;
    fake = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: { ...req.headers } });
      req.resume();
      req.on("end", () => {
        const b = reply || { status: 200, ct: "text/event-stream", body: DIRECT_SSE("直连态标记") };
        res.writeHead(b.status, { "content-type": b.ct || "application/json" });
        res.end(typeof b.body === "string" ? b.body : JSON.stringify(b.body));
      });
    });
    await new Promise((r) => fake.listen(P.upstream, "127.0.0.1", r));
    relay = relayOf(P);
  }, { timeout: 60000 });

  after(async () => {
    try { srv && srv.kill(); } catch { }
    /* 先掐掉 keep-alive 连接再 close：留着连接的话 server 句柄不释放，本文件的
     * event loop 就一直有活干，node --test 的子进程退不出来，外层永远等不到汇总行。 */
    try { fake && fake.closeAllConnections && fake.closeAllConnections(); } catch { }
    try { fake && await new Promise((r) => fake.close(r)); } catch { }
  });

  test("请求打到原来的直连上游，一个 OpenCode 进程都没起", async () => {
    seen.length = 0;
    reply = { status: 200, ct: "text/event-stream", body: DIRECT_SSE("直连态标记") };
    const r = await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "关闭态第一句" }] }, 20000);
    const text = await r.text();
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${text.slice(0, 200)}`);

    const calls = seen.filter((s) => /\/zen\/v1\/chat\/completions$/.test(s.url));
    assert.equal(calls.length, 1, `直连路径应当向上游发一次，实际 ${seen.length} 次：${JSON.stringify(seen.map((s) => s.url))}`);
    assert.equal(calls[0].headers.authorization, `Bearer ${DUMMY_KEY}`, "直连的 Authorization 必须照旧");
    assert.match(calls[0].headers["user-agent"] || "", /^B\.AI-Router\//, "直连的 UA 必须照旧");
    assert.equal(calls[0].headers["x-opencode-session"], undefined, "免费档直连一个字都不该多加 x-opencode-session");
    /* 客户端拿到的就是假上游那段的直连内容——这条把「走的还是原来的直连路径」钉死：
     * 若接线误把请求送去了 OpenCode，这里会是 OpenCode 的回答而不是这个标记。 */
    assert.match(text, /直连态标记/, "客户端拿到的必须是直连上游的回包内容");
    assert.equal(await live(srv.P.oc), false, "★ 关闭态下 OpenCode serve 端口必须仍然是死的 —— 一个进程都不许起");
  });

  test("把开关切成 opencode 之后同一个中转口就不再打直连了（开关真的可配、真的可生效）", async () => {
    const save = await fetch(`http://127.0.0.1:${srv.P.panel}/api/config`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "zen", transport: "opencode" }),
    });
    const saved = await save.json();
    assert.notEqual(saved.ok, false, `保存 transport 失败：${JSON.stringify(saved).slice(0, 200)}`);

    seen.length = 0;
    reply = { status: 500, ct: "application/json", body: JSON.stringify({ error: "这一档切到 OpenCode 了，直连上游不会被碰" }) };
    const r = await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "切到 opencode 之后的第一句" }] }, 200000);
    const text = await r.text();
    /* 请求不该再打直连上游。OpenCode 这边通不通由 ⑧ 负责——这里只验「分流真的生效了」。 */
    assert.equal(seen.length, 0, `切成 opencode 后不该再打直连上游，实际打了：${JSON.stringify(seen.map((s) => s.url))}`);
    assert.match(text, /OpenCode|opencode/i, `错误应来自 OpenCode 这条路，实际：${text.slice(0, 300)}`);
    /* 接线确实跑起来了（而不是碰巧也没打直连）：server.mjs 的日志里有这一档的行。 */
    assert.ok(srv.out.join("").includes("OpenCode 传输"), "server.mjs 日志里应当有接线层的输出");

    /* 切回去，并确认直连又活了 */
    await fetch(`http://127.0.0.1:${srv.P.panel}/api/config`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "zen", transport: "direct" }),
    });
    seen.length = 0;
    reply = { status: 200, ct: "text/event-stream", body: DIRECT_SSE("直连态标记") };
    const r2 = await relay({ model: "claude-fable-5", max_tokens: 32, messages: [{ role: "user", content: "切回来之后" }] }, 20000);
    assert.equal(r2.status, 200);
    assert.equal(seen.filter((s) => /\/zen\/v1\/chat\/completions$/.test(s.url)).length, 1, "切回 direct 后必须恢复直连");
  }, { timeout: 260000 });

  test("非法取值被拒（400），不会把开关悄悄留在一个坏状态上", async () => {
    const bad = await fetch(`http://127.0.0.1:${srv.P.panel}/api/config`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "zen", transport: "OpenCode" }),
    });
    assert.equal(bad.status, 400, `非法取值必须被拒（400），实际 ${bad.status}`);
    assert.match(JSON.stringify(await bad.json()), /传输方式/);
  });
});

/* ================================================================== *
 * ⑩ v1.0.84：客户端断线要掐上游，以及「连不上」这个说法是错的
 * ================================================================== *
 *
 * 定位结论（2026-10-13，实测不是推断）：
 *   ① 超时发生在**请求已送达、等不到回复**这一层，不是连不上 TCP。
 *      对照：真连接失败 = `TypeError: fetch failed` + `cause=ECONNREFUSED`（4ms）；
 *      线上那种 = `TimeoutError`，与 timeoutMs 逐毫秒对齐，且服务端已收到完整请求体、
 *      同时并发 `GET /session` 10ms 就回 200（进程活着）。
 *   ② **被掐断的请求不会毒化会话**（实测，见下方断言与报告），
 *      所以「调大超时会拉长毒化窗口」这个顾虑不成立。
 *   ③ 生效的空闲回收是 **2 小时**，不是 oc-runtime 的 10 分钟默认值；
 *      实机日志全程 0 次 `空闲超过`，看着像回收的那几段其实是中转进程重启。
 *
 * 这一节钉的是**真因为修好而修**的那条：客户端断了，上游那一轮不能还占着。
 */
describe("⑩ 客户端断线即掐上游 + 失败归因不再谎称「连不上」", () => {
  const CFG_T = { zen: { transport: "opencode", ocPort: 17899 } };

  /** 带 EventEmitter 的 res——只有它能发出真实 res 会发的 `close`。 */
  function closableRes() {
    const r = new EventEmitter();
    r.statusCode = 0; r.headers = null; r.body = ""; r.chunks = []; r.ended = false;
    r.writableFinished = false;
    r.writeHead = (s, h) => { r.statusCode = s; r.headers = h || {}; };
    r.write = (c) => { const s = Buffer.isBuffer(c) ? c.toString("utf8") : String(c); r.chunks.push(s); r.body += s; };
    r.end = (c) => { if (c) r.write(c); r.ended = true; r.writableFinished = true; };
    Object.defineProperty(r, "headersSent", { get() { return r.statusCode > 0; } });
    Object.defineProperty(r, "writableEnded", { get() { return r.ended; } });
    return r;
  }

  /** 记下每个 URL；message 那条**永不回复**，直到 signal 掐断它。 */
  function hangingFetch(seen) {
    return async (url, init = {}) => {
      seen.push(String(url));
      const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
      const bad = () => ({ ok: false, status: 400, json: async () => null, text: async () => "{}" });
      if (String(url).endsWith("/abort")) return ok({ ok: true });
      if (String(url).endsWith("/permission")) return ok([]);
      if (String(url).includes("/message?limit=")) return bad();
      if (String(url).includes("/message")) {
        const s = init.signal;
        await new Promise((_, reject) => {
          if (!s) return;                                   // 没有 signal：永远挂着
          if (s.aborted) return reject(s.reason);
          s.addEventListener("abort", () => reject(s.reason), { once: true });
        });
      }
      return ok({});
    };
  }

  test("⑩-a 真连接失败与真截止是**两种不同的错误**（不是靠文案反推）", async () => {
    // 运行时事实 ①：连接失败（用 17xxx 段上一个没人听的端口，避开特权端口的怪形状）
    let connectErr = null;
    try { await fetch("http://127.0.0.1:17999/never", { signal: AbortSignal.timeout(2000) }); } catch (e) { connectErr = e; }
    assert.ok(connectErr, "该端口必然拒绝连接");
    assert.equal(connectErr.name, "TypeError", `真连接失败应是 TypeError，实际 ${connectErr.name}`);
    assert.match(String(connectErr.message), /fetch failed/);
    assert.equal(connectErr.cause?.code, "ECONNREFUSED", `连接失败必须带 ECONNREFUSED cause，实际 ${JSON.stringify(connectErr.cause?.code)}`);

    // 运行时事实 ②：我们自己的 AbortSignal.timeout
    let deadlineErr = null;
    try { await new Promise((_, rej) => { const s = AbortSignal.timeout(30); s.addEventListener("abort", () => rej(s.reason), { once: true }); }); } catch (e) { deadlineErr = e; }
    assert.equal(deadlineErr.name, "TimeoutError", `截止应是 TimeoutError，实际 ${deadlineErr.name}`);
    assert.match(String(deadlineErr.message), /aborted due to timeout/);

    /* 这两条**同时**成立，才说明 classifyTransportError 按 name 分是可靠的。
     * 如果哪天 Node 把两者合并成同一个错误类型，这一条会先红——那正是要重新定位的信号。 */
    const c1 = classifyTransportError(connectErr, "http://127.0.0.1:17895");
    assert.equal(c1.kind, "network");
    assert.equal(c1.status, 502);
    assert.match(c1.what, /连不上/);

    const c2 = classifyTransportError(deadlineErr, "http://127.0.0.1:17895");
    assert.equal(c2.kind, "timeout", "自己的截止必须归 timeout，不能归 network");
    assert.equal(c2.status, 504);
    assert.ok(!/连不上/.test(c2.what), `截止不是连不上，实际文案：${c2.what}`);

    // 转移行为不变：504 与 502 一样要转移，所以改归因不会改掉故障转移
    assert.equal(shouldFailover(504), true, "504 仍要转移");
    assert.equal(shouldFailover(502), true);
  });

  test("⑩-b ★ 客户端断开 → 立刻收工，并且真的去 abort 掉上游那一轮", async () => {
    const seen = [];
    const gw = createOcGateway({
      log: () => {}, runtimeFactory: () => fakeRuntime(), portOf: () => 17899,
      timeoutOf: () => 60_000,                       // 截止给足 60 秒：提前收工才是本事
      fetchImpl: hangingFetch(seen), noteRelayError: () => {}, anthroError: () => {},
    });
    const res = closableRes();
    const p = gw.exchange({ cfg: CFG_T, j: REQ(), isProbe: false, res, mapModel: mapTo("space-bunny-free") });

    await sleep(80);
    assert.ok(!seen.some((u) => u.endsWith("/abort")), "还没断线，不该提前 abort");
    const tClose = Date.now();
    res.emit("close");                               // 客户端挂断

    await p;                                          // 若修复被撤，这里会一直等到 60 秒截止
    const elapsed = Date.now() - tClose;
    assert.ok(elapsed < 5_000, `断线后 ${elapsed}ms 才收工——说明还在傻等截止`);

    const abortUrl = seen.find((u) => u.endsWith("/abort"));
    assert.ok(abortUrl, `断线后必须 POST {sessionId}/abort 把上游那一轮收掉；实际只打了：${seen.join(" | ")}`);
    assert.match(abortUrl, /\/session\/[^/]+\/abort$/, "abort 必须打在会话路由上");
  });

  test("⑩-c 反向对照：没有 close 事件就**不许**提前收工（否则上一条恒真）", async () => {
    const seen = [];
    const gw = createOcGateway({
      log: () => {}, runtimeFactory: () => fakeRuntime(), portOf: () => 17899,
      timeoutOf: () => 60_000, fetchImpl: hangingFetch(seen), noteRelayError: () => {}, anthroError: () => {},
    });
    const res = closableRes();
    const p = gw.exchange({ cfg: CFG_T, j: REQ(), isProbe: false, res, mapModel: mapTo("space-bunny-free") });
    let settled = false; p.then(() => { settled = true; }, () => { settled = true; });
    await sleep(400);
    assert.equal(settled, false, "客户端还在，没理由收工");
    assert.equal(seen.filter((u) => u.endsWith("/abort")).length, 0, "没断线就不该 abort 上游");
    res.emit("close");                               // 收尾，别把测试吊在 60 秒截止上
    await p;
  });

  test("⑩-d 正常收尾（writableFinished）不得被当成断线", async () => {
    /* res.end() 之后 Node 也会发 close。不看 writableFinished 的话，
     * 每个**成功**的请求都会在写完之后把自己 abort 掉。 */
    const seen = [];
    const gw = createOcGateway({
      log: () => {}, runtimeFactory: () => fakeRuntime(), portOf: () => 17899,
      timeoutOf: () => 3000,
      fetchImpl: async (url, init = {}) => {
        seen.push(String(url));
        const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
        if (String(url).endsWith("/permission")) return ok([]);
        if (String(url).includes("/message?limit=")) return { ok: false, status: 400, json: async () => null, text: async () => "{}" };
        if (String(url).includes("/message")) return ok(OC_TOOL_RESPONSE);
        return ok({});
      },
      noteRelayError: () => {}, anthroError: () => {},
    });
    const res = closableRes();
    await gw.exchange({ cfg: CFG_T, j: REQ(), isProbe: false, res, mapModel: mapTo("space-bunny-free") });
    res.emit("close");                               // 成功之后 Node 发的那个 close
    assert.equal(seen.filter((u) => u.endsWith("/abort")).length, 0, "正常收尾之后绝不该再 abort 上游");
    assert.equal(res.statusCode, 200, "正常路径不受影响");
  });

  test("⑩-e 走网关时，自己的截止报 504/timeout 而不是 502/network", async () => {
    const kinds = [];
    const gw = createOcGateway({
      log: () => {}, runtimeFactory: () => fakeRuntime(), portOf: () => 17899,
      timeoutOf: () => 30,
      noteRelayError: (_c, kind) => kinds.push(kind),
      anthroError: (res, status, msg) => { res.writeHead(status); res.end(msg); },
      fetchImpl: async (url, init = {}) => {
        const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
        if (String(url).endsWith("/permission")) return ok([]);
        if (String(url).includes("/message?limit=")) return { ok: false, status: 400, json: async () => null, text: async () => "{}" };
        if (String(url).includes("/message")) {
          await new Promise((_, rej) => {
            const s = AbortSignal.any([init.signal, AbortSignal.timeout(30)]);
            s.addEventListener("abort", () => rej(s.reason), { once: true });
          });
        }
        return ok({});
      },
    });
    const res = closableRes();
    await gw.exchange({ cfg: CFG_T, j: REQ(), isProbe: false, res, mapModel: mapTo("space-bunny-free") });
    assert.equal(res.statusCode, 504, `自己的截止必须是 504，实际 ${res.statusCode}`);
    assert.deepEqual(kinds, ["timeout"], `面板归因必须是 timeout，实际 ${JSON.stringify(kinds)}`);
    assert.match(res.body, /不是「连不上」/, "文案必须说清这不是连不上");
    assert.match(res.body, /\/session\/\{id\}\/abort/, "文案要说明上游那一轮已被收掉");
  });

  test("⑩-f 生效的空闲回收是 2 小时，不是 oc-runtime 的 10 分钟", () => {
    assert.equal(OC_IDLE_TIMEOUT_MS, 2 * 60 * 60_000);
    assert.notEqual(OC_IDLE_TIMEOUT_MS, IDLE_TIMEOUT_MS, "必须与 oc-runtime 的默认值不同，否则等于没改");
    assert.ok(OC_IDLE_TIMEOUT_MS > IDLE_TIMEOUT_MS);

    /* 行为断言：用网关实际传下去的那个值造一个运行时，空闲 10 分钟不许回收，
     * 空闲超过 2 小时才回收。（10 分钟就回收 = 用户一回头这段对话就换了新会话） */
    let clock = 1_000_000;
    const rt = createRuntime({
      port: 17901, host: "127.0.0.1", workDir: os.tmpdir(),
      probeReady: async () => true, createSession: async () => ({ id: "ses_x", status: 200 }),
      now: () => clock, sleep: async () => { }, idleTimeoutMs: OC_IDLE_TIMEOUT_MS,
      findBinary: () => ({ ok: true, path: "opencode.exe", source: "test", spawnNeedsShell: false, tried: [] }),
      spawn: () => ({ pid: 1234, stdout: null, stderr: null, on() { }, kill() { } }),
      log: () => {},
    });
    rt.child = { pid: 1234 }; rt.exited = false; rt.lastUsedAt = clock;
    clock += 10 * 60_000 + 1000;
    assert.equal(rt.reclaimIfIdle(), false, "空闲 10 分钟就回收 = 会话缓存被清掉，那正是本条要防的事");
    clock += 2 * 60 * 60_000;
    assert.equal(rt.reclaimIfIdle(), true, "超过 2 小时必须真的回收");
  });
});

/* ------------------------------------------------------------------ *
 * 反向对照的「把手册」：--list-sabotage / --sabotage
 * ------------------------------------------------------------------ *
 * 每条都是**真实跑过的**：在源码上打这个补丁 → 本文件必须红 → 还原。
 * 判据只有一个：改了之后测试真的会红。
 */
const SABOTAGE = [
  {
    name: "transport-fallback-opencode", where: "oc-wiring.mjs · zenTransportOf",
    from: `return raw === ZEN_TRANSPORT_OPENCODE ? ZEN_TRANSPORT_OPENCODE : ZEN_TRANSPORT_DIRECT;`,
    to: `return raw === undefined ? ZEN_TRANSPORT_DIRECT : ZEN_TRANSPORT_OPENCODE;`,
    reds: "① 缺字段/非字符串/garbage 一律 direct 那条",
  },
  {
    name: "always-opencode", where: "server.mjs · openaiExchange 分流",
    from: `if (p === "zen" && zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE) {`,
    to: `if (p === "zen") {`,
    reds: "⑨ 直连上游一次都不许被打 / 一个 OpenCode 进程都不许起 / 切回 direct 那条",
  },
  {
    name: "divert-after-token", where: "server.mjs · 分流位置",
    from: `  if (p === "zen" && zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE) {`,
    to: `  const __gate = p === "zen" && zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE; if (__gate) {`,
    reds: "② 分流必须在取令牌之前（取到 Key 才分流 → 不配 Key 的 ⑧ 直接 401）",
  },
  {
    name: "drop-opts-model-req", where: "oc-wiring.mjs · anthropicToOpenCode",
    from: `      model: target,`, to: `      /* model: target, */`,
    reds: "③ 请求方向 modelID / ⑧ 端到端拿到 tool_use（模型静默不回 → 空响应 502）",
  },
  {
    name: "drop-opts-model-res", where: "oc-wiring.mjs · openCodeToAnthropic",
    from: `openCodeToAnthropic(json, { model: target, tools })`,
    to: `openCodeToAnthropic(json, { tools })`,
    reds: "③ 响应方向 message.model / ⑧ message_start.message.model（会落成 big-pickle）",
  },
  {
    name: "no-session-reuse", where: "oc-wiring.mjs · 会话键",
    from: `const key = isProbe === true ? OC_PROBE_SESSION_KEY : sessionKeyOf(first && first.content);`,
    to: `const key = isProbe === true ? OC_PROBE_SESSION_KEY : ("k" + Math.random().toString(36).slice(2, 10));`,
    reds: "④ 同一段对话两轮必须是同一个 session id / ⑧ 第二轮 created=false",
  },
  {
    name: "write-before-ready", where: "oc-wiring.mjs · 应答器之前",
    from: `    const inTok = Math.max(1, Math.ceil(JSON.stringify(j || {}).length / 4));`,
    to: `    writeAnthropicMessage(res, { id: "m0", model: target, content: [], stop_reason: "end_turn", usage: {} }, j && j.stream === true, {});\n    const inTok = Math.max(1, Math.ceil(JSON.stringify(j || {}).length / 4));`,
    reds: "⑥ 零字节纪律 / 影子 res 判为失败",
  },
  {
    name: "empty-is-success", where: "oc-wiring.mjs · 空响应判定",
    from: `if (!Array.isArray(message.content) || !message.content.length) {`,
    to: `if (false) {`,
    reds: "⑦ 空响应必须报错让故障转移接手",
  },
  {
    name: "no-install-hint", where: "oc-wiring.mjs · 找不到二进制",
    from: `? "\n\n" + ocInstallHint(sess && sess.tried)`, to: `? ""`,
    reds: "⑦ 找不到二进制必须给出可执行的安装指引（npm i -g opencode-ai）",
  },
  {
    name: "zen-needs-key-anyway", where: "server.mjs · providerConfigured",
    from: `return !!cfg.zen?.apiKey || zenTransportOf(cfg) === ZEN_TRANSPORT_OPENCODE;`,
    to: `return !!cfg.zen?.apiKey;`,
    reds: "⑧ 端到端首条（没配 Zen Key 的 opencode 档被自己跳过 → 「所有渠道都失败了」）",
  },
  {
    name: "accept-garbage-transport", where: "server.mjs · /api/config 的 transport 行",
    from: `if (!ZEN_TRANSPORTS.includes(t)) {`, to: `if (false) {`,
    reds: "⑨ 非法取值必须被拒（400）",
  },
  {
    name: "drop-sse-stop-reason", where: "oc-wiring.mjs · writeAnthropicMessage",
    from: `sse(res, "message_stop", { type: "message_stop" });`,
    to: `/* dropped */`,
    reds: "⑤ 流式事件序列 / ⑧ message_stop 必须收尾",
  },
  /* ---- 工具守卫（oc-tool-guard）这一节三条 ---- */
  {
    name: "swallow-immediate-rawtext", where: "oc-tool-guard.mjs · request() 的成功分支",
    from: `    const rawText = await r.text();
    return { status: r.status, json: JSON.parse(rawText), rawText };`,
    to: `    return { status: r.status, json: await r.json(), rawText: '' };`,
    reds: "★ 正常正文原样返回（rawText 被吞成空串的那条）",
  },
  {
    name: "no-part-lookup-retry", where: "oc-tool-guard.mjs · findPart 的等待",
    from: `    for (let attempt = 0; attempt <= partLookupTries; attempt++) {`,
    to: `    for (let attempt = 0; attempt <= 0; attempt++) {`,
    reds: "★ 历史先是空的，几次之后才出现 → 必须等它，而不是退化成拒绝",
  },
  {
    name: "allow-native-locally", where: "oc-tool-guard.mjs · 权限回复",
    from: `{ reply: 'reject', message }`,
    to: `{ reply: 'always', message }`,
    reds: "★ 绝不本地执行（权限回复只能是 reject）/ 交接与全部 reject 分支",
  },
  {
    name: "ignore-client-close", where: "oc-wiring.mjs · 客户端断线处理",
    from: `    if (realRes && typeof realRes.on === "function") realRes.on("close", onClientClose);`,
    to: `    if (false && realRes && typeof realRes.on === "function") realRes.on("close", onClientClose);`,
    reds: "★ 断线即掐上游（⑩-b / ⑩-c）——撤掉后请求要一直等到 60 秒截止，且不会 POST /abort",
  },
  {
    name: "drop-cancelsignal", where: "oc-tool-guard.mjs · signal 合流",
    from: `  const signal = AbortSignal.any([work.signal, timeout, ...(cancelSignal ? [cancelSignal] : [])]);`,
    to: `  const signal = AbortSignal.any([work.signal, timeout]);`,
    reds: "★ 同上——守卫收不到上层给的取消信号，⑩-b 的「断线即收工」直接失效",
  },
  {
    name: "call-everything-network", where: "oc-wiring.mjs · 传输失败归因",
    from: `  if (name === "TimeoutError") {
    return { kind: "timeout", status: 504, what: \`OpenCode 那一轮没在自己的截止前结束（\${where}）\`, detail };
  }`,
    to: `  if (name === "TimeoutError") {
    return { kind: "network", status: 502, what: \`连不上本机的 OpenCode 服务（\${where}）\`, detail };
  }`,
    reds: "★ ⑩-a / ⑩-e——自己的截止又变回「连不上」+ network/502",
  },
  {
    name: "bypass-guard-in-wiring", where: "oc-wiring.mjs · ④ 发",
    from: `      const out = await postMessageWithToolGuard({`,
    to: `      const raw = await (fetchImpl || fetch)(base + "/session/" + encodeURIComponent(sess.sessionId) + "/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(built.payload), signal: AbortSignal.timeout(timeoutOf(cfg)) });
      const out = { status: raw.status, json: raw.ok ? await raw.json() : null, rawText: raw.ok ? "" : await raw.text() };
      if (false) await postMessageWithToolGuard({`,
    reds: "★ 消息那一发真的走了守卫，不再是裸 POST",
  },
];

if (process.argv.includes("--list-sabotage")) {
  console.log(`oc-wiring 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(26)} ${s.where}\n  ${"".padEnd(26)} → 会打红: ${s.reds}`);
  process.exit(0);
}
if (process.argv.includes("--sabotage")) {
  const name = process.argv[process.argv.indexOf("--sabotage") + 1];
  const s = SABOTAGE.find((x) => x.name === name);
  if (!s) { console.error(`没有这条手法：${name}。可用：${SABOTAGE.map((x) => x.name).join(", ")}`); process.exit(2); }
  const file = s.where.includes("server.mjs") ? "src/server/server.mjs"
    : s.where.includes("oc-tool-guard") ? "src/server/oc-tool-guard.mjs"
    : "src/server/oc-wiring.mjs";
  console.log(JSON.stringify({ file, ...s }, null, 2));
  process.exit(0);
}