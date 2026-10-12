/**
 * OpenCode **运行时**：二进制发现、进程生命周期、会话管理（v1.0.75）
 *
 * ## 这个模块为什么存在
 *
 * 直接打 `https://opencode.ai/zen/v1/*` 一律 403 FreeTierError——免费档围栏的唯一
 * 判据是「发给模型的请求里必须带工具」。OW Bridge 的解法不是绕过围栏，而是**跑一个
 * 真 `opencode serve`，用 OpenCode 自己的身份去请求**。本模块就是那个 `serve` 的
 * 发现与看护；协议翻译在 `oc-bridge.mjs`（同事的文件，不在本文件）。
 *
 * 已实测（`.research/oc-decisive-probe.mjs`、`oc-tool-e2e.mjs`，12/12 全过）：
 *
 *     opencode serve --pure --hostname 127.0.0.1 --port <17xxx>   (cwd = 独立目录)
 *       → POST /session  {title, permission:[{permission,pattern:"*",action:"ask"}]}
 *       → POST /session/{id}/message  {...}
 *
 * ## ⚠️ 全项目最关键的一行：permission.action 必须是 `ask`
 *
 * `deny` 会把工具**从模型的可见列表里整个摘掉**（OW Bridge 引 opencode 源码
 * `packages/opencode/src/permission/index.ts` 为证），请求退化成「无工具推理」，
 * 于是被免费档围栏以 403 FreeTierError 拒掉。这是实测，不是推测。
 *
 * `allow` 同样不接受，但理由**不同**：它会让 OpenCode 自己真去执行工具，而桥的设计
 * 是「模型只吐 {content, calls} 信封，工具由 Claude Code 执行」——`allow` 会造成
 * 重复执行 + 越权副作用。这一条是**设计判据，不是实测结论**，下面注释里分开写了。
 *
 * 为了让这条判据不可能被悄悄改掉，本文件做了三件事：
 *   ① `PERMISSION_ACTION` 是模块级常量，`buildSessionCreateBody` 不接受任何覆盖参数；
 *   ② `validateSessionCreateBody` 在真发请求前再验一遍，违规就**不发**并把后果写进错误；
 *   ③ `scripts/oc-runtime-test.mjs` 里有对应用例 + 反向对照。
 *
 * ## 三条纪律
 *
 * **① 找不到二进制不下载。** 各人装法不一（npm 全局 / 官方脚本 / 手放 `~/.opencode`），
 * 猜错比不给更糟——所以只如实报告试过哪些路径，并给出让人自己确认的安装指引。
 *
 * **② 只终止自己 spawn 的那个 PID。** 用户很可能**自己开着**一个 OpenCode 实例在用，
 * 按镜像名批量杀会连带杀掉他的正式实例。本文件里因此不存在任何按名字终止的调用，
 * 连注释都不写那个命令名——`scripts/oc-runtime-test.mjs` 有一条负样本扫描盯着这件事。
 *
 * **③ 不碰任何凭据。** 本通道**根本不需要 Zen 的 API Key**（免费档走 OpenCode 自己的
 * 认证），所以本文件不读、不写、不落盘、不打印任何令牌。子进程的 stdout/stderr 只留在
 * 内存里的定长环形缓冲里，**不自动进日志**，只由调用方显式取（`diagnostics()`）。
 *
 * ## 可测性
 *
 * 本文件**不含任何 fetch、不做任何网络请求**。就绪探测与会话创建都是注入进来的依赖
 * （`probeReady` / `createSession`），进程与文件系统操作（`spawn` / `terminate` /
 * `exists` / `which`）也都可以注入。所以测试能在**不起真进程、不发真网络**的前提下
 * 把超时、崩溃、重建、优先级这些分支全跑一遍。
 *
 * @module server/oc-runtime
 */

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

/* ========================================================================== *
 * 常量
 * ========================================================================== */

/**
 * 会话权限动作。**只能是 `ask`。**
 * - `deny` → 工具被从模型可见列表里摘掉 → 请求退化为无工具推理 → 实测 403 FreeTierError
 * - `allow` → OpenCode 会自己去执行工具（设计判据，非实测）：重复执行 + 越权副作用
 */
export const PERMISSION_ACTION = "ask";

/**
 * 会话要放行的权限种类。
 * 这四个是 Claude Code 用得到的；形状照 `.research/oc-decisive-probe.mjs` 实测通过的那份
 * （permission 传**数组**；传对象会被服务端以 400 BadRequest 拒掉）。
 */
export const SESSION_PERMISSION_KINDS = Object.freeze(["bash", "edit", "webfetch", "read"]);

/** 建会话的默认标题。 */
export const DEFAULT_SESSION_TITLE = "bai-router";

/** 无首条 user 消息时的固定会话键（与 server.mjs 的 zenSessionId 同一思路）。 */
export const SESSION_KEY_UNKNOWN = "bai-oc-unknown";

/** 就绪等待上限（毫秒）与轮询间隔，与实测脚本一致。 */
export const READY_TIMEOUT_MS = 60_000;
export const HEALTH_INTERVAL_MS = 800;

/** 默认端口：17xxx 段，与实测脚本同段，避免和用户自己的实例撞。 */
export const DEFAULT_PORT = 17895;
export const DEFAULT_HOST = "127.0.0.1";

/** 空闲回收：多久没有 `ensure`/`sessionFor` 之后自动收进程（毫秒）。 */
export const IDLE_TIMEOUT_MS = 10 * 60_000;

/** 子进程日志环形缓冲上限。**不进日志文件**，只在内存里。 */
const CHILD_LOG_LIMIT = 4000;

/** 只允许回环地址。OpenCode serve 默认无鉴权，绑到 0.0.0.0 等于把 agent 挂在网上。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 没找到二进制时给用户的指引。
 * **故意不写死某一种装法**：各家装法不一，猜错比不给更糟。
 * 本模块**不会**替用户下载任何东西。
 */
export const OPENCODE_MISSING_HINT = [
  "没找到 opencode 二进制。本模块不会替你下载——装法因人而异，请自行确认后重试：",
  "  ① 已用 npm 全局装：在一个新终端里跑 `opencode --version` 确认 PATH 已生效（PATH 改动要重开终端）；",
  "  ② 用官方安装脚本装的：通常落在用户目录下的 .opencode\\bin\\opencode.exe，本模块也会找那里；",
  "  ③ 以上都没有：按官方文档安装 OpenCode 后重试。",
  "已按顺序尝试过的路径见 tried 字段。",
].join("\n");

/* ========================================================================== *
 * 纯函数
 * ========================================================================== */

/** 端口必须是合法整数。 */
function assertPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new TypeError(`opencode 端口必须是 1..65535 的整数，收到：${JSON.stringify(port)}`);
  }
  return n;
}

/** 只许回环地址（见 LOOPBACK_HOSTS 处的理由）。 */
function assertHost(host) {
  const h = String(host == null ? "" : host).trim();
  if (!LOOPBACK_HOSTS.has(h)) {
    throw new TypeError(
      `opencode serve 只允许绑回环地址，收到：${JSON.stringify(host)}。`
      + "该服务默认无鉴权，绑到非回环地址等于把一个 agent 暴露到网络上。",
    );
  }
  return h;
}

/**
 * `opencode serve` 的参数。
 * 形状与实测脚本逐字一致：`--pure` 不加载外部插件，`--hostname`/`--port` 显式给死。
 *
 * @param {number} port
 * @param {string} [host="127.0.0.1"] 仅接受回环地址
 * @returns {string[]}
 */
export function parseServeArgs(port, host = DEFAULT_HOST) {
  const p = assertPort(port);
  const h = assertHost(host);
  return ["serve", "--pure", "--hostname", h, "--port", String(p)];
}

/** Windows 的 .cmd/.bat 必须经 shell 才能被 spawn 直接执行。 */
function needsShell(p) {
  return /\.(cmd|bat)$/i.test(String(p || ""));
}

/**
 * 建会话的请求体。
 *
 * ★ `permission` 是**数组**，每项 `{permission, pattern:"*", action:"ask"}`。
 * ★ action 必须是 `ask`，理由见文件头。**本函数不提供任何覆盖 action 的入参**——
 *   这是有意的：让「写成 deny」这件事在类型上就不可能发生。
 *
 * @param {string} [title]
 * @returns {{title: string, permission: Array<{permission:string,pattern:string,action:string}>}}
 */
export function buildSessionCreateBody(title) {
  const t = typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : DEFAULT_SESSION_TITLE;
  return {
    title: t,
    // 每次返回全新对象：调用方改了返回值也污染不到常量。
    permission: SESSION_PERMISSION_KINDS.map((permission) => ({
      permission,
      pattern: "*",
      action: PERMISSION_ACTION,
    })),
  };
}

/**
 * 发请求前的最后一道闸：检查 body 形状与权限动作。
 * 违规就**不发**——把一个 deny 的 body 送出去等于拿一次 403 去换一次 403。
 *
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateSessionCreateBody(body) {
  const problems = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, problems: ["body 不是对象"] };
  }
  if (typeof body.title !== "string" || !body.title) problems.push("title 必须是非空字符串");
  if (!Array.isArray(body.permission)) {
    // 实测：写成对象会被服务端以 400 BadRequest 拒掉。
    problems.push("permission 必须是**数组**（实测：写成对象服务端回 400 BadRequest）");
  } else if (!body.permission.length) {
    problems.push("permission 不能是空数组：空列表等于一个工具都不给模型看");
  } else {
    for (const [i, p] of body.permission.entries()) {
      if (!p || typeof p !== "object") { problems.push(`permission[${i}] 不是对象`); continue; }
      if (typeof p.permission !== "string" || !p.permission) problems.push(`permission[${i}].permission 缺失`);
      if (p.pattern !== "*") problems.push(`permission[${i}].pattern 必须是 "*"`);
      if (p.action !== PERMISSION_ACTION) {
        problems.push(
          `permission[${i}].action 是 ${JSON.stringify(p.action)}，必须是 ${JSON.stringify(PERMISSION_ACTION)}：`
          + (p.action === "deny"
            ? "deny 会把工具从模型的可见列表里整个摘掉，请求退化成无工具推理 → 实测 403 FreeTierError"
            : p.action === "allow"
              ? "allow 会让 OpenCode 自己去执行工具，与「模型只吐信封、工具由 Claude Code 执行」相悖（设计判据）"
              : "只接受 ask"),
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * 会话键：按对话**首条 user 内容**取 sha256 前 16 位 hex。
 *
 * 与 server.mjs 的 `zenSessionId` 同一思路：同一会话的每一轮请求带的都是那条同首条
 * user 消息，所以键在整段对话里恒定；不同会话自然不同。
 * **不含任何可还原的原文**——只出哈希，别人拿它反推不出用户说了什么。
 *
 * @param {string|Array|Object|null|undefined} firstUserContent
 * @returns {string}
 */
export function sessionKeyOf(firstUserContent) {
  let anchor = "";
  if (typeof firstUserContent === "string") anchor = firstUserContent;
  else if (firstUserContent != null) {
    try { anchor = JSON.stringify(firstUserContent); } catch { anchor = String(firstUserContent); }
  }
  if (!anchor) return SESSION_KEY_UNKNOWN;
  return "bai-oc-" + createHash("sha256").update(anchor).digest("hex").slice(0, 16);
}

/* ========================================================================== *
 * 二进制发现
 * ========================================================================== */

/** 归一成数组：`which` 可以回字符串、数组或 null。 */
function toList(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
}

/** 默认的 `where opencode`（Windows）。抽出来是为了让测试能整段替换掉。 */
function defaultWhich(cmd) {
  try {
    const r = nodeSpawnSync("where", [cmd], { encoding: "utf8", windowsHide: true });
    if (r && r.status !== 0) return null;
    return String((r && r.stdout) || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function found(p, source) {
  return { ok: true, path: p, source, spawnNeedsShell: needsShell(p) };
}

/**
 * 找 opencode 二进制。**纯路径拼接，不执行这个二进制。**
 *
 * 顺序（缺一不可，别自创）：
 *   ① `where opencode`——用户 PATH 上任何形态优先，接住大多数机器；
 *   ② `%APPDATA%/npm/opencode.cmd`——npm 全局装的 shim；
 *   ③ `%APPDATA%/npm/node_modules/opencode-ai/bin/opencode.exe`——同一次安装的真身；
 *   ④ `~/.opencode/bin/opencode.exe`——官方安装脚本落的那份。
 *
 * ②③ 顺序有意义：同一台机器上两者通常并存，shim 更贴近用户 PATH 的真实解析结果。
 *
 * **找不到时不下载**（见 OPENCODE_MISSING_HINT），只如实报告 tried 与 reason。
 *
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {(p:string)=>boolean} [opts.exists] 文件是否存在
 * @param {(cmd:string)=>string|string[]|null} [opts.which] 解析 PATH 上的命令
 * @param {string} [opts.homedir=os.homedir()]
 * @returns {{ok:true,path:string,source:string,spawnNeedsShell:boolean}
 *          |{ok:false,reason:string,tried:Array<{how:string,path:string}>,hint:string}}
 */
export function findOpenCodeBinary(opts = {}) {
  const {
    env = process.env,
    exists = fs.existsSync,
    which = defaultWhich,
    homedir = os.homedir(),
    join = path.join,
  } = opts;

  const tried = [];
  const seen = (p) => exists(p);

  // ① where
  let w = null;
  try { w = which("opencode"); } catch { w = null; }
  for (const cand of toList(w)) {
    tried.push({ how: "where", path: cand });
    if (seen(cand)) return found(cand, "where");
  }

  // ②③ npm 全局装的两处
  const appdata = env && env.APPDATA;
  if (appdata) {
    const shim = join(appdata, "npm", "opencode.cmd");
    tried.push({ how: "appdata-npm-shim", path: shim });
    if (seen(shim)) return found(shim, "npm-shim");

    const exe = join(appdata, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    tried.push({ how: "appdata-npm-package", path: exe });
    if (seen(exe)) return found(exe, "npm-package");
  }

  // ④ 官方安装脚本
  const userExe = join(homedir, ".opencode", "bin", "opencode.exe");
  tried.push({ how: "user-install", path: userExe });
  if (seen(userExe)) return found(userExe, "user-install");

  return { ok: false, reason: "opencode-not-found", tried, hint: OPENCODE_MISSING_HINT };
}

/* ========================================================================== *
 * 运行时
 * ========================================================================== */

/**
 * 造一个就绪探测器。**fetch 由调用方注入**——本文件不引用全局 fetch，也不在
 * 这里发任何请求；没有 fetchImpl 的调用方根本编不过这一行。
 *
 * 判据照实测脚本：`GET {base}/session`，`status < 500` 就算起来了
 * （连不上/超时算没起来，继续等）。
 *
 * @param {{fetchImpl: Function, path?: string, timeoutMs?: number}} o
 * @returns {(base:string)=>Promise<boolean>}
 */
export function createReadyProbe({ fetchImpl, path: probePath = "/session", timeoutMs = 3000 } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createReadyProbe 需要一个注入的 fetchImpl（本模块不含 fetch）");
  }
  return async function probeReady(base) {
    const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout
      ? { signal: AbortSignal.timeout(timeoutMs) } : {};
    const r = await fetchImpl(base + probePath, { method: "GET", ...ctl });
    return !!r && typeof r.status === "number" && r.status < 500;
  };
}

/**
 * 运行时对象：发现 + 起停 + 会话复用。
 *
 * 依赖全部可注入（见文件头「可测性」）。两个**必须**注入的：
 * `probeReady(base)->Promise<boolean>` 与
 * `createSession({base, body})->Promise<{id:string}>`——这两处是网络调用，本模块一概不做。
 *
 * @returns {{
 *   find: typeof findOpenCodeBinary,
 *   ensure: () => Promise<object>,
 *   sessionFor: (key:string, title?:string) => Promise<object>,
 *   isRunning: () => boolean,
 *   reclaimIfIdle: () => boolean,
 *   diagnostics: () => object,
 *   dispose: () => object,
 * }}
 */
export function createRuntime(deps = {}) {
  const {
    spawn = nodeSpawn,
    terminate = (child) => { try { child.kill(); } catch { /* 已退出 */ } },
    probeReady,
    createSession,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
    port = DEFAULT_PORT,
    host = DEFAULT_HOST,
    workDir = os.tmpdir(),
    env = process.env,
    readyTimeoutMs = READY_TIMEOUT_MS,
    healthIntervalMs = HEALTH_INTERVAL_MS,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
    findBinary = undefined,
    ...findOpts
  } = deps;

  if (typeof probeReady !== "function") {
    throw new TypeError("createRuntime 需要注入 probeReady(base)——本模块不含网络请求");
  }
  if (typeof createSession !== "function") {
    throw new TypeError("createRuntime 需要注入 createSession({base, body})——本模块不含网络请求");
  }

  const p = assertPort(port);
  const h = assertHost(host);

  const rt = {
    base: `http://${h}:${p}`,
    child: null,        // 只有它自己 spawn 的那个进程才会被终止
    pid: null,
    bin: null,
    starting: null,     // 并发 ensure() 的合流点：同一时刻只起一个进程
    exited: false,
    lastUsedAt: 0,
    sessions: new Map(),// key → sessionId（只在本进程生命周期内有意义）
    childLog: [],
    starts: 0,
  };

  const note = (m) => {
    try { rt.childLog.push(String(m)); } catch { /* 忽略 */ }
    if (rt.childLog.length > CHILD_LOG_LIMIT) rt.childLog.splice(0, rt.childLog.length - CHILD_LOG_LIMIT);
  };
  const attachOutput = (child) => {
    for (const [name, tag] of [["stdout", "out"], ["stderr", "err"]]) {
      const s = child && child[name];
      if (s && typeof s.on === "function") {
        s.on("data", (d) => note(`[${tag}] ` + String(d).slice(0, 500)));
      }
    }
  };

  /** 终止**且只终止**本次 spawn 的那个 PID。不接受外部传入的 pid。 */
  function stop() {
    const child = rt.child;
    const pid = rt.pid;
    if (!child) return { ok: false, reason: "not-running", pid: null };
    rt.child = null;
    rt.pid = null;
    rt.exited = false;
    rt.sessions.clear();   // 会话随进程一起没了，缓存必须跟着清，否则会把死进程的 id 复用出去
    try {
      terminate(child, pid);
      log(`OpenCode 运行时：已终止本次启动的进程 pid=${pid}`);
      return { ok: true, pid };
    } catch (e) {
      log(`OpenCode 运行时：终止 pid=${pid} 失败：${e && e.message}`);
      return { ok: false, pid, reason: "terminate-failed", error: String((e && e.message) || e) };
    }
  }

  rt.find = () => (findBinary ? findBinary() : findOpenCodeBinary({ env, ...findOpts }));

  rt.isRunning = () => !!rt.child && !rt.exited;

  rt.diagnostics = () => ({
    running: rt.isRunning(),
    pid: rt.pid,
    base: rt.base,
    starts: rt.starts,
    sessions: rt.sessions.size,
    lastUsedAt: rt.lastUsedAt,
    // 子进程输出**不自动进日志**，由调用方决定要不要记。
    childLogTail: rt.childLog.join("").slice(-CHILD_LOG_LIMIT),
  });

  /** 空闲回收（惰性：下次进来时才发现超时）。外部也可挂定时器主动调。 */
  rt.reclaimIfIdle = () => {
    if (!rt.isRunning()) return false;
    if (!rt.lastUsedAt) return false;
    if (now() - rt.lastUsedAt < idleTimeoutMs) return false;
    log(`OpenCode 运行时：空闲超过 ${Math.round(idleTimeoutMs / 1000)}s，回收 pid=${rt.pid}`);
    stop();
    return true;
  };

  async function start() {
    const bin = rt.find();
    if (!bin || !bin.ok) {
      // 找不到就**不下载**（hint 里是给人看的安装指引）。
      return { ok: false, reason: (bin && bin.reason) || "opencode-not-found", tried: bin && bin.tried, hint: bin && bin.hint };
    }
    rt.bin = bin;
    rt.starts++;
    // 会话 id 属于**某一个进程实例**。换了进程，缓存里的 id 全部作废——
    // 哪怕上一进程是意外退出的（没走 stop()，缓存还热着）。不清就会把死进程的
    // session id 发给新进程，等于拿一个必然失败的 id 继续用。
    rt.sessions.clear();
    const args = parseServeArgs(p, h);
    log(`OpenCode 运行时：启动 ${bin.path}（source=${bin.source}）${args.join(" ")}`);

    let child;
    try {
      child = spawn(bin.path, args, {
        cwd: workDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        // .cmd/.bat 在 Windows 上必须经 shell。参数全是本模块自己校验过的
        // 数字与回环字面量，不含任何用户输入，所以不存在命令行注入面。
        shell: bin.spawnNeedsShell === true,
      });
    } catch (e) {
      return { ok: false, reason: "spawn-failed", error: String((e && e.message) || e), path: bin.path };
    }

    rt.child = child;
    rt.pid = child && typeof child.pid === "number" ? child.pid : null;
    rt.exited = false;
    attachOutput(child);
    if (child && typeof child.on === "function") {
      child.on("exit", (code, signal) => {
        rt.exited = true;
        note(`[exit] code=${code} signal=${signal}`);
        log(`OpenCode 运行时：进程 pid=${rt.pid} 意外退出（code=${code} signal=${signal}）`);
      });
      child.on("error", (e) => { note(`[proc-error] ${e && e.message}`); });
    }

    // 轮询就绪
    const t0 = now();
    let attempts = 0;
    for (;;) {
      if (rt.exited) {
        const r = { ok: false, reason: "process-exited", pid: rt.pid };
        stop();   // 起都没起成的进程是我们自己的，照样只按 PID 收
        return r;
      }
      attempts++;
      let up = false;
      try { up = (await probeReady(rt.base)) === true; } catch { up = false; }
      if (up) { rt.lastUsedAt = now(); log(`OpenCode 运行时：就绪 pid=${rt.pid}（第 ${attempts} 次探测）`); return { ok: true, pid: rt.pid, base: rt.base, attempts, source: bin.source }; }
      if (now() - t0 >= readyTimeoutMs) {
        const r = { ok: false, reason: "ready-timeout", pid: rt.pid, attempts, waitedMs: now() - t0 };
        stop();
        return r;
      }
      await sleep(healthIntervalMs);
    }
  }

  rt.ensure = async () => {
    rt.reclaimIfIdle();
    if (rt.isRunning()) {
      rt.lastUsedAt = now();
      return { ok: true, pid: rt.pid, base: rt.base, reused: true };
    }
    if (rt.starting) return rt.starting;       // 合流：并发调用只起一个进程
    rt.starting = start().finally(() => { rt.starting = null; });
    return rt.starting;
  };

  /**
   * 取（必要时建）一个会话。**同一 key 复用，不同 key 新建。**
   *
   * 发请求前先过 `validateSessionCreateBody`：body 不合格就**不发**，
   * 直接把后果（403 FreeTierError / 400 BadRequest）带回去。
   */
  rt.sessionFor = async (key, title) => {
    rt.reclaimIfIdle();
    const k = typeof key === "string" && key ? key : SESSION_KEY_UNKNOWN;

    if (rt.sessions.has(k)) {
      if (rt.isRunning()) {
        rt.lastUsedAt = now();
        return { ok: true, sessionId: rt.sessions.get(k), created: false };
      }
      // 进程已经没了，缓存里的 session id 不能再发出去用，丢掉重开。
      rt.sessions.clear();
    }

    const up = await rt.ensure();
    if (!up.ok) return { ok: false, reason: up.reason, tried: up.tried, hint: up.hint, detail: up };

    const body = buildSessionCreateBody(title);
    const v = validateSessionCreateBody(body);
    if (!v.ok) {
      log(`OpenCode 运行时：会话请求体不合规，已拒绝发送：${v.problems.join("；")}`);
      return { ok: false, reason: "session-body-invalid", problems: v.problems };
    }

    let res;
    try {
      res = await createSession({ base: rt.base, body });
    } catch (e) {
      return { ok: false, reason: "session-create-failed", error: String((e && e.message) || e) };
    }
    const id = res && typeof res.id === "string" ? res.id.trim() : "";
    if (!id) {
      return { ok: false, reason: "session-no-id", got: Object.prototype.toString.call(res) };
    }
    rt.sessions.set(k, id);
    rt.lastUsedAt = now();
    return { ok: true, sessionId: id, created: true };
  };

  rt.dispose = () => stop();

  return rt;
}