/**
 * OpenCode 接入的**接线层**（v1.0.75）
 *
 * ## 这个文件在整条链路里的位置
 *
 * ```
 * Claude Code ──POST /v1/messages──▶ 中转（server.mjs）
 *                                     └─ openaiExchange("zen")
 *                                          ├─ transport=direct ──▶ wbPipe ──▶ /zen/v1/chat/completions（原有路径）
 *                                          └─ transport=opencode ─▶ **本文件** ──▶ opencode serve ──▶ Zen
 * ```
 *
 * 上游两个模块（`oc-runtime.mjs` 进程与会话、`oc-bridge.mjs` 协议翻译）**一个字都没改**。
 * 本文件只做它们做不到的那几件事：
 *
 *   ① **模型映射**：把 `j.model`（Claude Code 的档位名）经本渠道的 `mapping` 解析成真正要调的
 *      模型。桥刻意**不猜**（见 oc-bridge 的 `resolveModel`：发错的模型会让模型静默地什么都不回），
 *      所以这一步只能在中转层做。
 *   ② **两个方向都传 `opts.model`**：请求方向它是 OpenCode 的目标模型；响应方向它决定
 *      `message.model`。漏传就会让客户端收到 OpenCode 的内部 id（如 `big-pickle`）。
 *   ③ **应答器**：OpenCode 的会话接口一次性返回完整响应，没有可边收边转的流。流式与非流式
 *      两种客户端形状由本文件自己合成。
 *   ④ **失败前的零字节纪律**：故障转移用影子 res 判定该不该换下一家渠道，所以**在确认上游
 *      真有可用响应之前，一个字节都不能写给客户端**。先拿到完整结果，再决定写什么。
 *
 * ## 为什么单独一个文件，而不是塞进 server.mjs
 *
 * server.mjs 已经 6000 行。这里要做的是一件**可独立测**的事（传输选择 / 映射 / 应答合成 /
 * 失败归类），把它独立出来才能在不起真进程、不发真网络的前提下把每个分支测完，
 * 也避免给那个文件再加两百行。
 *
 * ## 红线
 *
 * 🔴 **不碰任何凭据**：本通道用 OpenCode 自己的认证，**根本不需要 Zen 的 API Key**，
 *    所以本文件不读、不写、不落盘、不打印任何令牌（连错误消息里都没有）。
 * 🔴 **找不到 opencode 二进制时不下载**——各人装法不一，猜错比不给更糟，只给可执行的指引。
 * 🔴 **只终止自己 spawn 的那个 PID**：终止逻辑在 oc-runtime 里，这里传的是它给的默认实现。
 *
 * @module server/oc-wiring
 */

import { createRuntime, createReadyProbe, findOpenCodeBinary, sessionKeyOf } from "./oc-runtime.mjs";
import { anthropicToOpenCode, openCodeToAnthropic, DIAG } from "./oc-bridge.mjs";
import fs from "node:fs";

/* ========================================================================== *
 * 传输开关
 * ========================================================================== */

/** 直连：打 `cfg.zen.upstream + /chat/completions`（本文件改动前唯一的那条路）。 */
export const ZEN_TRANSPORT_DIRECT = "direct";
/** 经 OpenCode：起一个真 `opencode serve`，用 OpenCode 自己的身份去请求。 */
export const ZEN_TRANSPORT_OPENCODE = "opencode";
export const ZEN_TRANSPORTS = Object.freeze([ZEN_TRANSPORT_DIRECT, ZEN_TRANSPORT_OPENCODE]);

/**
 * 读这一档的传输开关。
 *
 * ★ **任何认不出来 / 缺失 / 非字符串的值一律回 `direct`**——不是回 `opencode`。
 *   理由：这一档出厂值必须是 `direct`，而直连路径**当前怎么失败是被用户可配置的状态**
 *   （免费档 403 / Go 档需订阅），不能因为接线把它悄悄改成另一条路。
 *   一个写错的值退回到「改动前的行为」，永远比退回到「另一条没被验证过的行为」安全。
 *
 * @param {object} cfg 全量配置
 * @returns {"direct"|"opencode"}
 */
export function zenTransportOf(cfg) {
  const raw = cfg && cfg.zen ? cfg.zen.transport : undefined;
  return raw === ZEN_TRANSPORT_OPENCODE ? ZEN_TRANSPORT_OPENCODE : ZEN_TRANSPORT_DIRECT;
}

/** 探针（max_tokens ≤ 8 的桌面版健康探测）用的固定会话键——每次探测都造一个新会话，
 *  等于凭空给上游灌会话记录。与 server.mjs 的 `ZEN_PROBE_SESSION` 同一思路。 */
export const OC_PROBE_SESSION_KEY = "bai-oc-probe";

/* ========================================================================== *
 * 安装指引（找不到二进制时）
 * ========================================================================== */

/**
 * 没找到 opencode 时给用户的话。
 *
 * **故意不下载**：装法因人而异（npm 全局 / 官方脚本 / 手放 `~/.opencode`），
 * 猜一种装下去比不给更糟——用户会以为装好了，实际上只是换了个坏路径。
 * 所以这里给的是「可以自己确认的候选 + 一条最主流的命令」，并如实列出试过的路径。
 */
export function ocInstallHint(tried) {
  const lines = [
    "这一档需要先在本机装 OpenCode：找不到 opencode 二进制，所以这条请求没能发出去。",
    "装法因人而异，下面两条任选其一，装完重开会话即可（本模块不会替你下载）：",
    "  ① npm 全局装：在一个新终端里执行 `npm i -g opencode-ai`，然后跑 `opencode --version` 确认；",
    "  ② 或按官网 https://opencode.ai 的说明安装。",
    "已经按顺序找过但没找到的路径：" + (Array.isArray(tried) && tried.length
      ? tried.map((t) => `${t.path}（${t.how}）`).join("、")
      : "（无）"),
  ];
  return lines.join("\n");
}

/* ========================================================================== *
 * 二进制发现的一处适配
 * ========================================================================== */

/** Windows 上 Node 能直接执行 / 能经 shell 执行的形态。 */
const SPAWNABLE_EXT = /\.(exe|com|cmd|bat)$/i;

/**
 * 造 `findOpenCodeBinary` 的 `exists` 替身：**在 Windows 上，无扩展名的条目一律当不存在。**
 *
 * 理由是实测出来的，不是洁癖：npm 在 Windows 上装全局包时会生成三个文件——
 * `%APPDATA%\npm\opencode`（sh shim）、`opencode.cmd`、`opencode.ps1`。
 * `where opencode` 把**无扩展名那个排在第一条**，默认发现逻辑的 `exists()` 对它返回 true，
 * 于是会挑中它——而 Node 直接 spawn 它必然 `ENOENT`（不是 PE 文件）。
 * 后果是启动失败却报不出来：`spawn` 的 ENOENT 是异步 'error' 事件不是 throw，
 * 运行时只会一直等就绪，最后干等 60 秒再报 `ready-timeout`，用户完全看不懂。
 *
 * 挡掉它之后，发现顺序自然落到 `.cmd` shim（oc-runtime 会自动加 `shell: true`）
 * 或 npm 包里的真 `.exe`，两者都实测可执行。
 *
 * 非 Windows 平台**原样放行**——那里的可执行文件本来就常常没有扩展名。
 */
export function spawnableExists(realExists) {
  /* ⚠ 不传参数时必须落回**真的** fs.existsSync。曾经这里默认成 `(p) => false`，
   *  于是 `spawnableExists()` 造出来的判据对任何路径都说「不存在」——
   *  端到端实测直接顶到「找不到 opencode 二进制」，而它明明就装在
   *  %APPDATA%\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe。
   *  「找不到二进制」的用户文案是给人照着装指令的，把一个明明装着的机器说成没装，
   *  比报错本身更糟。 */
  const base = typeof realExists === "function" ? realExists : fs.existsSync;
  const isWin = process.platform === "win32";
  return function exists(p) {
    if (!base(p)) return false;
    if (isWin && !SPAWNABLE_EXT.test(String(p))) return false;
    return true;
  };
}

/* ========================================================================== *
 * 应答器
 * ========================================================================== */

/** 往 res 写一行 SSE。**本文件自己写 emit**，刻意不复用 wbPipe 里那个——那是它的局部闭包，
 *  签名与语义都是为 OpenAI 上游的增量帧准备的。 */
function sse(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 客户端已断开 */ }
}

/**
 * 一条完整的 Anthropic message → 客户端要的那种形状。
 *
 * - 流式：`message_start` → 每个块一组 `content_block_start`/`_delta`/`_stop`
 *   → `message_delta`（带 `stop_reason`）→ `message_stop`
 * - 非流式：直接落一条完整 JSON 消息
 *
 * 未知的块类型**跳过**而不是硬写：写一个不合法的块会让客户端整轮解析失败，
 * 那就不是「放过一个异常」，是换个地方误杀（与 oc-bridge 的防误杀同一条纪律）。
 */
export function writeAnthropicMessage(res, message, clientStream, { inputTokens = 0 } = {}) {
  const usage = (message && message.usage) || {};
  const inTok = Number.isFinite(usage.input_tokens) ? usage.input_tokens : (inputTokens || 0);
  const outTok = Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;

  if (!clientStream) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(message));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  sse(res, "message_start", {
    type: "message_start",
    message: {
      id: message.id, type: "message", role: "assistant", model: message.model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inTok, output_tokens: 0 },
    },
  });
  sse(res, "ping", { type: "ping" });

  let index = -1;
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      index++;
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      if (block.text) sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      index++;
      let partial = "{}";
      try { partial = JSON.stringify(block.input && typeof block.input === "object" ? block.input : {}); } catch { partial = "{}"; }
      sse(res, "content_block_start", {
        type: "content_block_start", index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partial } });
    } else if (block.type === "thinking") {
      index++;
      sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      if (block.thinking) sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
    } else {
      continue;   // 未知块：跳过（理由见文件内注释）
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index });
  }

  sse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: null },
    usage: { input_tokens: inTok, output_tokens: outTok },
  });
  sse(res, "message_stop", { type: "message_stop" });
  try { res.end(); } catch { /* 已断开 */ }
}

/* ========================================================================== *
 * 失败归类
 * ========================================================================== */

/**
 * 运行时的失败原因 → 「HTTP 状态码 / 中文明白 / relay 槽位里的 kind」。
 *
 * kind 刻意**复用 server.mjs 现有的那套词表**（`upstream_403` / `upstream_500` /
 * `rate_limit` / `timeout` / `network` / `auth`），不另造一套——面板与
 * attemptWithFailover 的 kind 归因都只认那套，新造一个等于多一份要维护的方言。
 *
 * `status` 的选法只有一条判据：**该不该让故障转移接手**（见 failover.mjs 的
 * `shouldFailover`）——400 类不转移（换渠道也一样错），401/403/429/5xx/网络错转移。
 */
export function classifyRuntimeFailure(reason, detail) {
  switch (reason) {
    case "opencode-not-found":
      return { status: 503, kind: "auth", what: "找不到 OpenCode" };
    case "spawn-failed":
      return { status: 502, kind: "network", what: "OpenCode 进程起不来" };
    case "process-exited":
      return { status: 502, kind: "network", what: "OpenCode 进程启动后立刻退出" };
    case "ready-timeout":
      return { status: 504, kind: "timeout", what: "OpenCode 在 60 秒内没有就绪" };
    case "session-body-invalid":
      return { status: 500, kind: "failover", what: "OpenCode 会话请求体不合规（已拒绝发送）" };
    case "session-create-failed":
      return { status: 502, kind: "network", what: "OpenCode 会话创建失败" };
    case "session-no-id":
      return { status: 502, kind: "network", what: "OpenCode 建会话成功但没给 id" };
    default:
      return { status: 502, kind: "network", what: `OpenCode 运行时未就绪（${String(reason || "未知原因")}）` };
  }
}

/** 上游 4xx/5xx 的中文说明。免费档围栏那条是这一档最常见的拒绝，单独说清楚。 */
function upstreamMessage(status, text) {
  const t = String(text || "").slice(0, 300);
  if (status === 403) {
    return "OpenCode 返回 403（FreeTierError）—— 免费档围栏的唯一判据是「发给模型的请求里必须带工具」。"
      + "本路径总是带着 format（StructuredOutput）发出去，所以这次被拒说明**会话权限被改成了 deny**："
      + "deny 会把工具从模型的可见列表里整个摘掉，请求退化成无工具推理。";
  }
  if (status === 429) return "OpenCode 触发限流（HTTP 429）。Zen 侧限流很严，等 30 秒左右再试。";
  if (status === 401) return "OpenCode 返回 401：本机的 OpenCode 登录态已失效，请重新登录 OpenCode。";
  if (status >= 500) return `OpenCode 上游自身故障（HTTP ${status}），不是你的配置问题。`;
  return `OpenCode 上游拒绝了请求（HTTP ${status}）：${t}`;
}

/* ========================================================================== *
 * 网关
 * ========================================================================== */

/**
 * 造一个 OpenCode 网关。
 *
 * 依赖全部可注入（fetch / findBinary / 端口 / 工作目录 / 日志 / 错误出口），
 * 所以除了「起真进程打真上游」那条端到端用例，其余分支都能**不起进程、不发网络**地测完。
 *
 * @returns {{exchange: Function, diagnostics: Function, dispose: Function}}
 */
export function createOcGateway(deps = {}) {
  const {
    fetchImpl = typeof fetch === "function" ? fetch : null,
    log = () => {},
    noteRelayError = () => {},
    anthroError = (res, status, msg) => {
      if (res.headersSent || res.writableEnded) { try { res.end(); } catch { } return; }
      res.writeHead(status >= 400 && status < 600 ? status : 502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(msg) } }));
    },
    host = "127.0.0.1",
    /** 端口来源。默认读 `cfg.zen.ocPort`——固定端口会和用户自己开着的 OpenCode 撞。 */
    portOf = (c) => Number(c && c.zen && c.zen.ocPort) || 17895,
    workDir,
    env = process.env,
    /** 单条消息的上限。默认 180 秒：免费档实测正常 3~10 秒，但冷启动后的第一条
     *  有实测会**整个挂住**（90 秒无响应、opencode 自己一声不吭），所以留了宽裕的余量。
     *  想调：`cfg.zen.ocTimeoutMs`（毫秒）。调小 = 更快让故障转移接手，代价是慢响应被误杀。 */
    timeoutOf = (c) => Number(c && c.zen && c.zen.ocTimeoutMs) || 180_000,
    readyTimeoutMs,
    idleTimeoutMs = 2 * 60 * 60_000,   // 见下面「为什么不是默认的 10 分钟」
    findBinary,
    runtimeFactory,
    createSession,
  } = deps;

  let rt = null;
  let rtPort = null;

  /** 惰性造运行时。**同一个端口只造一次**——会话复用与进程复用都靠它。
   *  端口变了就收掉旧的那个（换端口 = 旧进程上的 session id 全部作废，
   *  留着它们等于把死会话的 id 继续发出去）。 */
  function runtime(cfg) {
    const want = portOf(cfg);
    if (rt && rtPort === want) return rt;
    if (rt) { try { rt.dispose(); } catch { } rt = null; }
    rtPort = want;
    if (typeof runtimeFactory === "function") { rt = runtimeFactory(); return rt; }
    rt = createRuntime({
      port: want, host,
      workDir: workDir || env.TEMP || env.TMP || undefined,
      env,
      probeReady: createReadyProbe({ fetchImpl: fetchImpl || fetch }),
      createSession: createSession || (async ({ base, body }) => {
        const r = await (fetchImpl || fetch)(base + "/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (!r.ok) return { id: null, status: r.status, text: await r.text().catch(() => "") };
        const jj = await r.json();
        return { id: jj && jj.id, status: r.status };
      }),
      findBinary: findBinary || (() => findOpenCodeBinary({ env, exists: spawnableExists() })),
      readyTimeoutMs,
      /* ★ 空闲回收调成 2 小时，而不是 oc-runtime 默认的 10 分钟。
       * 会话 id 的缓存**绑在进程生命周期上**：`stop()` 会把 `sessions` 清空。10 分钟就回收
       * 的话，用户暂停一段对话再回来，同一段对话就会被分配到**一个全新的 OpenCode 会话**，
       * 上下文全丢——而这恰恰是「同一会话必须复用同一个 session id」要防的事。
       * 代价只是一个空闲的本机进程常驻两小时，没有请求时它不占 CPU。 */
      idleTimeoutMs,
      log,
    });
    return rt;
  }

  /** 网关自身的引用：exchange 内部要拿它读子进程日志（self 指回下面那个对象）。 */
  let api = null;

  /** 一次 OpenCode 请求。失败一律走 anthroError（影子 res 会缓冲，故障转移据此接手）。 */
  async function exchange({ cfg, S, j, isProbe, res, mapModel }) {
    const chan = "zen";    // 归因固定落在 zen 槽位（面板每渠道一个槽位）
    const tools = Array.isArray(j && j.tools) ? j.tools : [];

    // ---- ① 模型映射：本层的事（桥刻意不猜，见 oc-bridge 的 resolveModel）----
    const asked = String((j && j.model) || "");
    let target = "";
    try { target = String((mapModel && mapModel(asked)) || "").trim(); } catch { target = ""; }
    if (!target) {
      const msg = `这一档没有解析出要调的模型：档位「${asked || "(空)"}」在本渠道的映射里查不到，`
        + "而默认模型也是空的。带工具经 OpenCode 走时模型名**不能猜**——"
        + "发一个 OpenCode 不认识的模型名会让模型静默地什么都不回（诊断码 "
        + DIAG.MODEL_MISSING + "）。请到面板把映射表补上。";
      noteRelayError(chan, "failover", msg);
      return anthroError(res, 400, msg);
    }

    // ---- ② 二进制 / 进程 / 会话 ----
    const first = Array.isArray(j.messages) ? j.messages.find((m) => m && m.role === "user") : null;
    const key = isProbe === true ? OC_PROBE_SESSION_KEY : sessionKeyOf(first && first.content);
    let sess;
    try {
      sess = await runtime(cfg).sessionFor(key, isProbe === true ? "bai-router-probe" : "bai-router");
    } catch (e) {
      const msg = `OpenCode 运行时抛异常：${String((e && e.message) || e).slice(0, 160)}`;
      noteRelayError(chan, "network", msg);
      return anthroError(res, 502, msg);
    }
    if (!sess || !sess.ok) {
      const reason = (sess && sess.reason) || "unknown";
      const cls = classifyRuntimeFailure(reason, sess);
      const tail = reason === "opencode-not-found"
        ? "\n\n" + ocInstallHint(sess && sess.tried)
        : (sess && sess.hint ? "\n\n" + String(sess.hint) : "");
      const msg = `${cls.what}（${reason}）。故障转移可以改走其他渠道。${tail}`;
      noteRelayError(chan, reason === "opencode-not-found" ? "auth" : cls.kind, `${cls.what}（${reason}）`);
      log(`OpenCode 传输：${reason} —— ${msg.split("\n")[0]}`);
      return anthroError(res, cls.status, msg);
    }

    // ---- ③ 载荷（两个方向要用的模型名是同一个：opts.model）----
    const built = anthropicToOpenCode(j, tools, {
      model: target,
      toolChoice: j.tool_choice,
      parallel: j.parallel_tool_calls !== false,
    });
    const reqDiag = built.diagnostics.map((d) => d.code);
    if (reqDiag.includes(DIAG.MODEL_MISSING)) {
      /* 理论上到不了这里（上面已经判过 target），留着是因为「不传 opts.model 时桥会
       * 静默地不发 model 字段」正是规格里点名要防的那个坑。 */
      noteRelayError(chan, "failover", `OpenCode 载荷没带上模型（${DIAG.MODEL_MISSING}）`);
      return anthroError(res, 500, `OpenCode 载荷没有带上模型（诊断码 ${DIAG.MODEL_MISSING}）——本机缺陷，请报给开发者。`);
    }

    // ---- ④ 发（一次性返回，所以这里不做增量转码）----
    const base = runtime(cfg).base;
    const url = `${base}/session/${encodeURIComponent(sess.sessionId)}/message`;
    let json = null, status = 0, rawText = "";
    try {
      const r = await (fetchImpl || fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(built.payload),
        signal: AbortSignal.timeout(timeoutOf(cfg)),
      });
      status = r.status;
      if (r.ok) {
        json = await r.json();
      } else {
        rawText = await r.text().catch(() => "");
      }
    } catch (e) {
      const tail = ocChildLogTail(api);
      const msg = `连不上本机的 OpenCode 服务（${base}）：${String((e && e.message) || e).slice(0, 160)}`;
      noteRelayError(chan, "network", msg);
      log(`OpenCode 传输：连不上 ${base} —— ${String((e && e.message) || e).slice(0, 120)}`
        + (tail ? `｜opencode 自己的输出：${tail.slice(-600)}` : ""));
      return anthroError(res, 502, msg);
    }

    if (status !== 200) {
      const msg = upstreamMessage(status, rawText);
      noteRelayError(chan, status === 429 ? "rate_limit" : status === 401 ? "auth" : `upstream_${status}`, msg.slice(0, 180));
      log(`OpenCode 传输：上游 HTTP ${status} —— ${msg.slice(0, 120)}`);
      return anthroError(res, status >= 400 && status < 600 ? status : 502, msg);
    }

    // ---- ⑤ 回译（★ opts.model 必须传，否则 message.model 会落成 OpenCode 的内部 id）----
    const back = openCodeToAnthropic(json, { model: target, tools });
    const message = back.message;
    const codes = back.diagnostics.map((d) => d.code);
    if (codes.length) log(`OpenCode 传输：诊断 ${codes.join(",")}`);
    for (const code of [DIAG.UNSUPPORTED_TOOL_NAME, DIAG.ARGUMENTS_NOT_OBJECT, DIAG.CALL_DROPPED, DIAG.ENVELOPE_SHAPE_INVALID]) {
      if (codes.includes(code)) noteRelayError(chan, "failover", `OpenCode 翻译诊断：${code}`);
    }

    // ---- ⑥ 一个字节都不写之前先判定「这次到底算不算成功」----
    // 内容块一个都没有 = 用户屏幕上会是一句空回复。与 v1.0.74 的「200 + 空流」同一条
    // 纪律：当成上游失败，让故障转移去下一家，而不是把空回复当成功发出去。
    // （注意这**不是**误杀：有文本或 tool_use 的响应一个块都不会少，那条路不受影响。）
    if (!Array.isArray(message.content) || !message.content.length) {
      const diagNames = codes.length ? codes.join(",") : "（无）";
      const msg = `OpenCode 这次回了一个**空响应**：一个内容块都没有，usage=${JSON.stringify(message.usage)}。`
        + `桥侧诊断：${diagNames}。这一档不能把空回复当成功——已交给故障转移改走其他渠道。`;
      noteRelayError(chan, "failover", msg.slice(0, 180));
      log(`OpenCode 传输：空响应（${diagNames}），转故障转移`);
      return anthroError(res, 502, msg);
    }

    // ---- ⑦ 写。此时上游确认有可用响应，影子 res 会把 200 固化，不再转移 ----
    const inTok = Math.max(1, Math.ceil(JSON.stringify(j || {}).length / 4));
    writeAnthropicMessage(res, message, j && j.stream === true, { inputTokens: inTok });
    /* 日志里带上**会话键**：同一时刻可能有好几段对话在走这一档，只有键能把
     * 「这条是哪个会话的」与「这一轮是不是复用了会话」对上号（排查上下文丢失时必需）。
     * 键是 sha256 前 16 位，不是可还原的原文。 */
    log(`OpenCode 传输：200 model=${target} key=${key} session=${String(sess.sessionId).slice(0, 12)}…`
      + ` created=${sess.created === true} blocks=${message.content.length} stop=${message.stop_reason}`);
    return undefined;
  }

  api = {
    exchange,
    diagnostics() {
      if (!rt) return { started: false };
      return { started: true, ...rt.diagnostics() };
    },
    dispose() { if (rt) { const r = rt.dispose(); rt = null; return r; } return { ok: false, reason: "not-running" }; },
  };
  return api;
}

/**
 * 失败时把 opencode 子进程自己说的话摘出来给日志。
 *
 * 为什么需要：这一档卡住时，客户端只看到「连不上本机的 OpenCode 服务」——
 * 真正的原因（认证过期、模型 id 不认识、bundled 版本对不上…）只写在子进程的
 * stdout/stderr 里，而它默认**只留在内存里**（纪律：子进程输出不自动进日志）。
 * 没有这段，排查就只剩「重试一次」这一招。
 *
 * 只取尾部若干字，且 opencode 的输出不含本项目的任何凭据（本通道根本没有凭据）。
 */
export function ocChildLogTail(gw, max = 1200) {
  try {
    const d = gw && gw.diagnostics ? gw.diagnostics() : null;
    if (!d || !d.started) return "";
    return String(d.childLogTail || "").slice(-max);
  } catch { return ""; }
}