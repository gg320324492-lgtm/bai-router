/**
 * ★★「上游 429」在**活体路径**上的端到端测试（替代早先那份从未跑过的同名脚本）。
 *
 * ## 这份文件为什么存在
 *
 * 早先有一份同名的 e2e 脚本，它从未进过 `npm test`，因此它里面**一个真实存在、
 * 已经写好的断言一直是红的**，也没人发现：假上游的限流判据写成了 `/\/hy4/`
 * （转义了斜杠，等价于匹配字面量 "/hy4"），而模型名是 `hy4-preview-f`，
 * 于是**假上游一次都没真的回过 429**——它每次都回 200 + 只有一个 `[DONE]` 的空流。
 * 那个 200 空流正好撞上 v1.0.74 的「上游一个字都没返回」具名诊断，
 * 于是复现脚本「实测复现」出来的三个症状，其实是**一个假上游写错造成的**。
 *
 * 这份文件把假上游的限流判据改成真的（`/hy4-preview-f/`），并把三条核心断言
 * 钉在**真 server.mjs + 真池子 + 真假上游**上：
 *
 *   ★ A  429 之后**池子必须记上冷却**：`accounts[i].coolingModels` 含该模型、
 *          `reason === "cooling_model"`（没有回灌就一定红）
 *   ★ B  **诊断不许跑偏**：非 2xx 上游响应绝不能被归类成「空流」——
 *          客户端看到的必须说的是「限流/被拒」，且**一个「上游一个字都没返回」
 *          都不许出现**。分两层验：
 *            B1 活体：真 429 打进来，中转回的文案必须说的是限流
 *            B2 源码求值：`classifyEmptyStream` 拿到 httpStatus=429 时
 *               **绝不能**返回 `upstream_nothing`（把状态码检查抠掉就红）
 *   ★ C  冷却真的换了号：下一个请求落到另一个账号并成功（回灌的实际用途）
 *
 * ## 反向对照（sabotage）
 *
 * 文件末尾 `SABOTAGE` 一节列出两条「改坏」手法，配套执行器
 * `scripts/wb-pool-429-sabotage-run.mjs` 把每一条真的打到源码上跑一遍，
 * 确认**必须红**，再逐字还原，最后 `grep SABOTAGE` 自证干净。
 * 严禁恒真断言——每条断言都配了「判据自己失效了」的对照。
 *
 * ## 红线
 *
 *   🔴 全文没有一个真实令牌/API key。夹具里的凭据形态串是明显假的占位串。
 *   🔴 落盘只在 `os.tmpdir()` 下的临时目录 + `BAI_DATA_DIR`，
 *      **绝不碰真实的 %APPDATA%\bai-router**；端口固定在 17xxx 段挑空闲口。
 *   🔴 进程只按 **PID** 收，绝不用按镜像名的 /IM。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const DEFAULTS_JSON = path.join(REPO, "src", "server", "config.defaults.json");
const SRC = fs.readFileSync(SERVER, "utf8");
const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wb429-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 明显不是真令牌的假凭据（红线：绝不写真实令牌） */
const TOK_A = "dummy-access-token-A-not-real";
const TOK_B = "dummy-access-token-B-not-real";
const NOW = Date.UTC(2026, 9, 12, 0, 0, 0);
const MODEL = "hy4-preview-f";
/* 「空流」诊断的具名标签。B 组断言要反复用它，单独拎出来。 */
const EMPTY_LABEL = "上游一个字都没返回";

/* ───────────────────── 端口：只在 17xxx 段挑空闲口 ───────────────────── */
/* ⚠ 挑完就 close，**下一次探测会拿到同一个口**（内核总是给最小的空闲口）。
 *   所以必须把已经挑走的口记下来，否则 8 个中转口会全部挤成同一个。 */
const takenPorts = new Set();
async function portInRange() {
  for (let p = 17100; p < 17999; p++) {
    if (takenPorts.has(p)) continue;
    const free = await new Promise((res) => {
      const s = net.createServer();
      s.once("error", () => res(false));
      s.once("listening", () => s.close(() => res(true)));
      s.listen(p, "127.0.0.1");
    });
    if (free) { takenPorts.add(p); return p; }
  }
  throw new Error("17xxx 段找不到空闲端口");
}
async function portsInRange(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await portInRange());
  assert.equal(new Set(out).size, n, `挑出来的端口必须互不相同：${out.join(",")}`);
  return out;
}

/* 进程句柄登记：退出时逐个按 PID 收掉（绝不用 /IM） */
const procs = new Set();
function track(p) { procs.add(p); p.on("exit", () => procs.delete(p)); return p; }
function killAll() {
  for (const p of procs) {
    try { if (p.pid) spawnSync("taskkill", ["/PID", String(p.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
    try { p.kill(); } catch { }
  }
  procs.clear();
}
after(() => {
  killAll();
  try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { }
});

/* ====================================================================== *
 * B2 的源码求值工具：从 server.mjs 里**切出真函数**跑，不是抄一份重写。
 * 锚点对不上会当场炸，不会静默验错代码。
 * ====================================================================== */
function sliceBetween(startAnchor, endAnchor) {
  const i = SRC.indexOf(startAnchor);
  assert.ok(i >= 0, `抠源码失败：找不到 ${JSON.stringify(startAnchor)}`);
  const j = SRC.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(j > i, `抠源码失败：${JSON.stringify(startAnchor)} → ${JSON.stringify(endAnchor)} 没找到终点`);
  const out = SRC.slice(i, j);
  assert.equal((out.match(/\/\*/g) || []).length, (out.match(/\*\//g) || []).length,
    `切片停在注释中间：${JSON.stringify(startAnchor)} → ${JSON.stringify(endAnchor)}`);
  return out;
}
/* 锚点只认**声明本身**，不认上面那句注释里的字数（「四种/五种」随归因增减会变，
 * 拿它当锚点等于给每次改动埋一颗雷）。抠错位置会由 assert 当场炸，不会静默验错代码。 */
const ATTRS = sliceBetween("const EMPTY_STREAM_ATTRIBUTIONS = {", "function classifyEmptyStream(probe) {");
const CLASSIFY = sliceBetween("function classifyEmptyStream(probe) {", "// OpenAI SSE → Anthropic SSE");
const { classifyEmptyStream, EMPTY_STREAM_ATTRIBUTIONS } =
  new Function(`${ATTRS}\n${CLASSIFY}\nreturn {classifyEmptyStream, EMPTY_STREAM_ATTRIBUTIONS};`)();

describe("活体 429：诊断 / 回灌 / 换号", () => {
  let child, upstream, dataDir, P;
  /** 假上游每次收到的请求：{auth, model}。限流开关由 limitA 控制。 */
  const hits = [];
  let limitA = true;

  before(async () => {
    const ports = await portsInRange(8);
    P = { bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4], qd: ports[5], or: ports[6], panel: ports[7] };
    dataDir = path.join(TMPROOT, "data");
    fs.mkdirSync(dataDir, { recursive: true });

    upstream = track(http.createServer((rq, rs) => {
      const chunks = [];
      rq.on("data", (c) => chunks.push(c));
      rq.on("end", () => {
        const auth = rq.headers["authorization"] || "";
        let model = "";
        try { model = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}).model || ""); } catch { }
        hits.push({ auth, model, url: rq.url });
        if (process.env.WB429_DEBUG) console.log(`[上游] model=${model} 账号=${auth === `Bearer ${TOK_A}` ? "A" : auth === `Bearer ${TOK_B}` ? "B" : "?"} limitA=${limitA}`);
        /* 限流账号 A（**任何模型**都限流），账号 B 正常。
           为什么按「账号」而不是按「模型」限流：模型级换模循环会在同一次请求里
           换一个模型重试，所以按模型限流时这次请求往往在**换模之后拿到 200**，
           压根走不到「如实把 429 抛给用户」那条路。按账号限流才能确定性地
           验到「诊断 + 回灌 + 下次换号」这三件事。
           ⚠ 判据必须写成 `auth === "Bearer " + TOK_A`，不能像早先那份脚本那样
           写成 `/\/hy4/` —— 后者匹配字面量 "/hy4"，模型名里没有斜杠，于是限流
           分支永远不触发，假上游每次都回 200 空流，测出来的是假缺陷。 */
        if (limitA && auth === `Bearer ${TOK_A}`) {
          rs.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
          rs.end('{"error":{"message":"usage exceeds frequency limit, please retry later"}}');
          return;
        }
        rs.writeHead(200, { "content-type": "text/event-stream" });
        rs.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "WB429-OK:" + model } }] })}\n\n`);
        rs.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        rs.write("data: [DONE]\n\n");
        rs.end();
      });
    }));
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = upstream.address().port;

    const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
    cfg.failover.enabled = false;
    /* 预置成探测必选中的值，否则服务启动会 applyProxy 自重启（exit(0)）把本进程带走 */
    cfg.proxy = "http://127.0.0.1:7897";
    cfg.relayPort = P.bai; cfg.panelPort = P.panel;
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "or"]) cfg[k] = { ...cfg[k], relayPort: P[k] };
    cfg.wb.accessToken = ""; cfg.wb.refreshToken = "";
    cfg.wb.upstream = `http://127.0.0.1:${upPort}`;
    cfg.wb.defaultModel = MODEL;
    /* 只有这一个模型 → 模型级换模循环必然 no_alternative，
       于是「这次请求失败」是确定性的，断言才不是恒真。 */
    cfg.wb.availableModels = [MODEL];
    cfg.wb.mapping = { "claude-sonnet-4-5": { target: MODEL, label: "" } };
    cfg.wb.accounts = [
      { id: "acct-a", label: "账号A", order: 0, accessToken: TOK_A, refreshToken: "", credential: { lastRefreshTime: NOW }, modelCooldowns: {} },
      { id: "acct-b", label: "账号B", order: 1, accessToken: TOK_B, refreshToken: "", credential: { lastRefreshTime: NOW }, modelCooldowns: {} },
    ];
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

    const env = { ...process.env, BAI_DATA_DIR: dataDir, NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1" };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    env.NO_PROXY = "127.0.0.1,localhost";
    child = track(spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
    const out = []; child.stdout.on("data", (d) => out.push(String(d)));
    child.stderr.resume();

    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) return; }
      catch { }
      await sleep(300);
    }
    throw new Error(`server.mjs 40 秒内没起来。stdout 尾：${out.join("").slice(-1000)}`);
  }, { timeout: 60000 });

  after(() => {
    /* 假上游不关掉，node --test 会一直等它的事件循环 → 整个文件挂到超时。
       所以这里必须：先关上游，再按 PID 收子进程，最后删临时目录。 */
    try { upstream && upstream.close(); } catch { }
    killAll();
    try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { }
  });

  const ask = (text) => fetch(`http://127.0.0.1:${P.wb}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5", max_tokens: 256, stream: false,
      system: "You are Claude Code.",
      messages: [{ role: "user", content: text }],
    }),
    signal: AbortSignal.timeout(60000),
  }).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ status: 0, text: String((e && e.message) || e) }));

  const panelStatus = () => fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json());
  const acctRow = (st, id) => ((st.wb && st.wb.pool && st.wb.pool.accounts) || []).find((a) => a.id === id);

  /* ── ★ A ──────────────────────────────────────────────────────────────
   * 第一步：先拿到「确定用的账号 A」这个前提。sticky 模式下首个会话绑到第一个可用账号。 */
  let first = null;   // {status, text} —— 第一次（被限流）请求
  test("★ 前置：首个会话落到账号 A，且上游确实回了 429（证明前提成立）", async () => {
    limitA = true;
    hits.length = 0;
    first = await ask("第一轮：读一下 /etc/hostname");
    assert.equal(first.status, 429,
      `A 被限流且换遍了模型仍 429，中转应如实把 429 抛给用户。实际 HTTP ${first.status}：${first.text.slice(0, 200)}`);
    const usedA = hits.filter((h) => h.auth === `Bearer ${TOK_A}`).length;
    const usedB = hits.filter((h) => h.auth === `Bearer ${TOK_B}`).length;
    assert.ok(usedA >= 1, `首个请求应当用账号 A 打上游。实际 ${JSON.stringify(hits.map((h) => h.auth))}`);
    assert.equal(usedB, 0, `这次请求全程都该是 A（换模是同账号内换模型，不是换号）。实际 B 被打 ${usedB} 次`);
  });

  /* ── ★ B1 ── 活体：诊断不许跑偏 ─────────────────────────────────────── */
  test("★ B1 活体诊断：上游 429 绝不能说成「上游一个字都没返回」", async () => {
    assert.ok(first, "依赖前一条：first 必须先拿到");
    assert.ok(!first.text.includes(EMPTY_LABEL),
      `非 2xx 的上游响应是「被拒绝」，不是「没说话」。客户端却收到了空流诊断：${first.text.slice(0, 240)}`);
    assert.match(first.text, /frequency limit|限流|被拒/i,
      `文案必须点明是限流/被拒。实际：${first.text.slice(0, 240)}`);
  });

  /* ── ★ A 主断言 ─────────────────────────────────────────────────────── */
  test("★ A 429 之后池子必须记上冷却（coolingModels + reason=cooling_model）", async () => {
    const st = await panelStatus();
    const a = acctRow(st, "acct-a");
    assert.ok(a, "面板状态里应当有 acct-a 这一行");
    assert.ok(Array.isArray(a.coolingModels) && a.coolingModels.includes(MODEL),
      `账号 A 刚吃了 ${MODEL} 的 429，coolingModels 必须含它。实际 ${JSON.stringify(a.coolingModels)}（reason=${a.reason}）`);
    assert.equal(a.reason, "cooling_model",
      `限流该落成模型级冷却，实际 reason=${a.reason}——回灌没跑或分类错了`);
  });

  /* ── ★ C ── 冷却换了号 ──────────────────────────────────────────────── */
  test("★ C 下一个请求自动换到账号 B 并成功（回灌的实际用途）", async () => {
    hits.length = 0;
    const r = await ask("第一轮：读一下 /etc/hostname");   // 同一会话 → 同一个会话键
    assert.equal(r.status, 200, `A 已冷却，本请求应换 B 并成功。实际 HTTP ${r.status}：${r.text.slice(0, 200)}`);
    const usedB = hits.filter((h) => h.auth === `Bearer ${TOK_B}`).length;
    assert.equal(usedB, 1, `必须真的换到账号 B。实际 ${JSON.stringify(hits.map((h) => h.auth))}`);
    const st = await panelStatus();
    assert.equal(acctRow(st, "acct-b").reason, "ok", "B 这次成功，不该被记上任何冷却");
  });

  /* ── ★ B2 ── 源码求值：判空枚举必须先看 HTTP 状态码 ─────────────────── */
  test("★ B2 判空枚举先看状态码：非 2xx 绝不能判成 upstream_nothing", () => {
    /* 200 + 一个数据帧都没有 → 判 upstream_nothing（这是它本来的用途，不能被改坏） */
    assert.equal(classifyEmptyStream({ httpStatus: 200, dataFrames: 0, opened: 0, sawDone: true, unknown: [] }), "upstream_nothing",
      "200 + 空流仍然是「上游一个字都没返回」");
    /* 429 + 同样一个探针 → 必须换一个归因，绝不是 upstream_nothing。
       这里是 ① 的根因判据：上游明明回了一个 429 错误体，判空枚举却会说「没说话」。 */
    for (const code of [400, 401, 403, 404, 429, 500, 502, 503]) {
      const kind = classifyEmptyStream({ httpStatus: code, dataFrames: 0, opened: 0, sawDone: true, unknown: [] });
      assert.notEqual(kind, "upstream_nothing",
        `HTTP ${code} 是「上游拒绝了」，绝不能判成「上游一个字都没返回」（实际判成了 ${kind}）`);
      assert.equal(kind, "upstream_rejected", `HTTP ${code} 应当判成 upstream_rejected，实际 ${kind}`);
      assert.ok(!String(EMPTY_STREAM_ATTRIBUTIONS[kind].zh).includes(EMPTY_LABEL),
        `upstream_rejected 的正文里不该出现「${EMPTY_LABEL}」`);
    }
    /* 未知字段透传那条仍然排在最前：那是「上游确实返回了内容」的形态，不该被状态码抢走。
       （探针里没有 httpStatus → 走旧判据，行为逐字不变。） */
    assert.equal(classifyEmptyStream({ dataFrames: 1, opened: 0, sawDone: true, unknown: [{ hasValue: true }] }), "unrecognized_shape");
    assert.equal(classifyEmptyStream({ dataFrames: 0, opened: 0, sawDone: true, unknown: [] }), "upstream_nothing",
      "没有 httpStatus 的探针（历史形态）行为不变");
  });

  /* ── 反向对照：把 429 关掉，B1 的「限流」判据必须失效 ──────────────── */
  test("反向对照 R1：上游不拦时不该出现限流文案（证明 B1 不是恒真）", async () => {
    limitA = false;
    const r = await ask("对照轮：不拦的上游");
    assert.equal(r.status, 200, `不拦就该成功。实际 HTTP ${r.status}：${r.text.slice(0, 200)}`);
    assert.ok(r.text.includes("WB429-OK:"), "答复应当真的来自上游");
    limitA = true;
  });
});

/* ====================================================================== *
 * SABOTAGE —— 「改坏」手法清单
 *
 * 两条都要**真的打到源码上跑一遍**，确认对应断言变红，再逐字还原。
 * 执行器：node scripts/wb-pool-429-sabotage-run.mjs
 *   ① S1  删掉 openaiExchange 里那行 wbNoteFailure 回灌 → ★A 必红
 *   ② S2  删掉 classifyEmptyStream 里的 HTTP 状态码前置判据 → ★B2 必红
 *
 *   跑完执行器之后，源码里必须一条 SABOTAGE 标记都搜不到。
 * ====================================================================== */
export const SABOTAGE = {
  S1: {
    what: "把 server.mjs 里 429 那次失败回灌池子的那一行 wbNoteFailure 删掉",
    why: "★A 的判据一旦没人喂，池子就永远记不上冷却——这正是「隔离验证对、活体路径不对」的那类缺口",
    expectRed: "★ A 429 之后池子必须记上冷却",
  },
  S2: {
    what: "把 classifyEmptyStream 开头的 HTTP 状态码判据整段删掉",
    why: "没有状态码判据时，非 2xx 的响应会重新掉进「空流」枚举，说出与事实相反的话",
    expectRed: "★ B2 判空枚举先看状态码",
  },
};