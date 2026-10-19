/**
 * T9 测试 —— 模型解析的**静默回落**必须看得见（v1.0.78）
 *
 * ## 测什么
 *
 * 用户实测报的现象：Claude Code 里显示 `Space-Bunny-Free`，实际跑的是 `deepseek-v4.1-flash`。
 * 根因在 resolveModel 的第三条分支——模型名在映射表与可用清单里都查不到时，
 * **静默**回落到本渠道的 defaultModel：没有日志、没有面板痕迹，请求照样 200。
 * 实测触发条件不需要故障转移：客户端指向 WorkBuddy 的中转口却发来 Zen 的模型名，
 * 就会无声无息地跑去跑 WorkBuddy 的出厂默认模型。
 *
 *   ★ ① **回落必须留痕**：不在映射里的模型名 → 日志与 /api/status 两处都能查到这次回落
 *     （收到的名字 / 落到的值 / 渠道 / 累计次数），而请求本身仍然是成功的
 *   ★ ② **面板要显示真实服务的模型**：served（真实服务）与 target（打算路由到）不一致时，
 *     两个都显示并标明差异 —— 活体证据是 WorkBuddy 429 换模：换完之后真实服务的已经不是
 *     resolveModel 给的那个名字了
 *   ★ ③ **正常路径零变化**：模型名在映射里时，上游收到的模型名、响应正文、
 *     日志、面板渲染与改动前**逐字一致**，且没有任何回落记录
 *   ★ ④ **回落不是静默成功**：诊断抽屉里那一条要一眼看出「你发的 A / 实际跑的是 B」
 *   ★ ⑤ **换模后 served 必须跟着改**（否则面板会拿一个假的名字说「实际服务的是它」）
 *
 * ## 怎么测的
 *
 *   · ①②③ 的主线是**活体**：真 server.mjs 子进程 + 假上游。假上游按模型名给不同的
 *     响应（sn 一律 200 原样透传；wb 的入口档一律 429 逼中转换模），每一次真实请求的
 *     {url, model, auth} 都记在 `hits` 里 —— 「上游到底跑的是哪个模型」只认这份记录。
 *   · ④ 是**源码求值**（vm 里跑从 panel-common.js 真抠出来的两个纯函数，不抄一份重写），
 *     ⑤ 的面板一半同理；正常路径「与改动前逐字一致」也在这里验（拿改动前那行表达式现算一遍）。
 *
 * ## 反向对照：每条都有，且**改回去必须红**
 *
 * 文件末尾 `SABOTAGE` 一节列出全部「改坏」手法，配套执行器
 * `scripts/model-truth-sabotage-run.mjs` 把每一条真的打到源码上跑一遍，
 * 确认**必须红**，再逐字还原，最后 `grep SABOTAGE` 自证干净。
 *
 * 判据只有一个：**改回改前行为，测试真的会红**。严禁恒真断言——每条断言都配了
 * 「判据自己失效了」的对照（例：④ 里专门喂一条 mismatch=true 但 served===target 的状态，
 * 断言它**不**出条目；mismatch 项与回落项各由不同输入驱动，互不代替）。
 *
 * ## 红线
 *
 * 🔴 全文没有一个真实令牌/API key。夹具里的凭据形态串是明显假的占位串，
 *    且有一条断言专门查「状态里绝不出现凭据」。
 * 🔴 落盘只在 `os.tmpdir()` 下的临时目录 + `BAI_DATA_DIR`，**绝不碰真实的
 *    %APPDATA%\bai-router**；端口全部动态挑空闲（17xxx 段）。进程只按 **PID** 收，
 *    绝不用按镜像名的 /IM。
 * 🔴 spawn 真 server.mjs 时一律 `BAI_NO_PROXY_AUTODETECT=1`（自动代理探测会自重启
 *    并掐断在途请求 —— 这是刚根治的 flake）。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER = path.join(REPO, "src", "server", "server.mjs");
const PANEL = path.join(REPO, "src", "server", "panel-common.js");
const DEFAULTS_JSON = path.join(REPO, "src", "server", "config.defaults.json");
const SRC = fs.readFileSync(SERVER, "utf8");
const PANEL_SRC = fs.readFileSync(PANEL, "utf8");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-modeltruth-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* 明显不是真令牌的假凭据（红线）。末尾那两位刻意选成不在任何模型名/渠道名里出现的字符。 */
const TOK_SN = "dummy-sn-key-not-a-real-credential-z9";
const TOK_WB = "dummy-wb-token-not-a-real-credential-y8";

/* ---- 假上游的模型名 ------------------------------------------------------
 * 全部带 test- 前缀：任何一条断言里出现它们都只可能来自本测试自己配的夹具，
 * 不可能与出厂默认值（sensenova-* / deepseek-* / hy* / space-bunny-*）混淆。 */
const SN_DEFAULT = "test-sn-default-model";       // sn 的出厂 defaultModel（回落落点）
const SN_LISTED = "test-sn-listed-model";         // 在 availableModels 里（第二条分支）
const SN_MAPPED = "test-sn-mapped-sonnet";        // 映射表里 claude-sonnet-5 的目标（第一条分支）
/** ★ 用户实测报的那个名字：Zen 的模型名打到 WorkBuddy/别家的中转口上就是它。
 *  夹具里它在**任何**一家的映射与清单里都不存在 —— 这正是回落的前提。 */
const FOREIGN = "space-bunny-free";
const WB_ENTRY = "test-wb-entry-a";               // 入口档：假上游对它一律 429
const WB_PAID = "test-wb-paid-a";                 // 换模后真实服务的那个（只有目录里有）
const WB_ENTRY_B = "test-wb-entry-b";

const ANTHRO_OK = JSON.stringify({
  id: "msg_test", type: "message", role: "assistant", model: "test-echo",
  content: [{ type: "text", text: "OK" }], stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
});

/* ====================================================================== *
 * 端口 / 进程 / 假上游（只在 17xxx 段挑）
 * ====================================================================== */
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

const procs = new Set();
function track(p) { procs.add(p); p.on("exit", () => procs.delete(p)); return p; }
function killAll() {
  for (const p of procs) {
    try { if (p.pid) spawnSync("taskkill", ["/PID", String(p.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
    try { p.kill(); } catch { }
  }
  procs.clear();
}

/**
 * 假上游：
 *   · POST /v1/messages  → sn 口径：一律 200 原样透传（Anthropic JSON）
 *                          wb 口径：入口档一律 429（逼中转同渠道换模），其余 200 OpenAI SSE
 *   · GET  /v3/config    → 一份目录（WorkBuddy 的 /v1/models 对齐用），只有 WB_PAID 是 0 倍率之外的一档
 *   · 其余              → 404（启动期的目录同步打过来也只是 404，不会把夹具配置改写掉）
 * `hits` 记下每一次真实请求的 {url, model, auth}，所有断言都从它取证。
 */
async function startFakeUpstream(hits) {
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      const url = String(rq.url || "");
      const auth = String(rq.headers["authorization"] || "");
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}; } catch { }
      const model = String(body.model || "");
      hits.push({ url, model, auth, openai: !!(body && body.messages === undefined && body.stream === undefined ? false : false) });

      /* 刻意**不**提供 /v3/config 目录：目录一可用，换模就会按倍率挑替补，
         挑中的是哪一档由倍率决定，那属于 wb-catalog 那条判据，混进来就分不清了。
         这里只要"目录抓不到 → 按兜底清单挑"这一条路，判据唯一。 */
      /* sn 的中转是 Anthropic 原样透传（POST /v1/messages）；
         WorkBuddy 的桥把它翻成 OpenAI 再打上游（POST /v2/chat/completions，实测路径）。 */
      if (url.indexOf("/v1/messages") < 0 && url.indexOf("/v2/chat/completions") < 0) { rs.writeHead(404); rs.end("{}"); return; }

      /* WorkBuddy 口径（上游只讲 OpenAI 且仅流式）：入口档一律 429，
         上游原文照抄实测形态 —— wbParseLimit 认得它才会触发换模。 */
      if (model === WB_ENTRY || model === WB_ENTRY_B) {
        rs.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        rs.end('{"error":{"message":"usage exceeds frequency limit, please retry later"}}');
        return;
      }
      /* sn 口径是 Anthropic 协议（直连透传），wb 口径是 OpenAI 协议。
         靠模型名前缀区分：sn 的模型名都是 test-sn-*。 */
      if (model.indexOf("test-sn-") === 0) {
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(ANTHRO_OK);
        return;
      }
      rs.writeHead(200, { "content-type": "text/event-stream" });
      rs.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK:" + model } }] })}\n\n`);
      rs.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      rs.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return srv;
}

/** 起一个真 server.mjs 子进程（临时 BAI_DATA_DIR + 17xxx 隔离端口）。
 *  `patch(cfg)` 在**写盘之前**改配置——配置必须一次写对：起来之后再改文件会撞上
 *  loadCfg 的节流，测试就会偶发地读到旧配置。 */
async function startServer(dataDir, P, upstreamPort, patch) {
  const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
  cfg.failover.enabled = false;
  /* 预置成探测必选中的值，否则服务启动时 applyProxy 自重启（exit(0)）把本进程带走 */
  cfg.proxy = "http://127.0.0.1:7897";
  cfg.relayPort = P.bai; cfg.panelPort = P.panel;
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) cfg[k] = { ...cfg[k], relayPort: P[k] };
  /* 其他渠道一律空凭据 + 指到同一个假上游：启动期的目录同步只会拿到 404，
     不会碰到真实网络，也不会改写我们夹在下面的那份映射。
     ⚠ mm 也要在内：它的上游是**真的** agent.minimax.cn，不改就会打到真网络。 */
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
    cfg[k].upstream = `http://127.0.0.1:${upstreamPort}`;
    cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
  }
  cfg.wb.accessToken = "";
  if (typeof patch === "function") patch(cfg);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

  const env = { ...process.env, BAI_DATA_DIR: dataDir, NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1", BAI_NO_PROXY_AUTODETECT: "1" };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
  env.NO_PROXY = "127.0.0.1,localhost";
  const child = track(spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  const out = []; child.stdout.on("data", (d) => out.push(String(d))); child.stderr.resume();
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) return { child, stdout: () => out.join("") }; }
    catch { }
    await sleep(300);
  }
  throw new Error(`server.mjs 40 秒内没起来。stdout 尾：${out.join("").slice(-800)}`);
}

const askStatus = (P) => fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json());
const askRelay = (port, model, maxTokens) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model, max_tokens: maxTokens, stream: false, system: "You are Claude Code.", messages: [{ role: "user", content: "T9：读一下 /etc/hostname" }] }),
  signal: AbortSignal.timeout(60000),
}).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ status: 0, text: String((e && e.message) || e) }));

/* 夹在配置里的 sn 映射：一条命中映射、一条命中可用清单、一个**不命中**（回落点）。 */
function patchSn(cfg) {
  cfg.sn.apiKey = TOK_SN;
  cfg.sn.useProxy = false;
  cfg.sn.defaultModel = SN_DEFAULT;
  cfg.sn.availableModels = [SN_LISTED, SN_DEFAULT];
  cfg.sn.mapping = {
    "claude-sonnet-5": { target: SN_MAPPED, label: "档·Sonnet" },
    "claude-haiku-4-5": { target: SN_LISTED, label: "档·Haiku" },
  };
}
/* WorkBuddy：入口档必然 429，换模挑中目录里那一档付费的。 */
function patchWb(cfg) {
  delete cfg.wb.accounts;
  cfg.wb.accessToken = TOK_WB;
  cfg.wb.poolMode = "";
  cfg.wb.useProxy = false;
  cfg.wb.defaultModel = WB_ENTRY;
  /* 兜底清单的顺序即换模挑替补的顺序：入口档 429 之后，下一档就是换过去的那一档。
     ★ 判据自失效对照：清单里第一个若不是 WB_PAID，下面那条链路断言当场炸。 */
  cfg.wb.availableModels = [WB_ENTRY, WB_PAID];
  cfg.wb.mapping = {
    "claude-sonnet-5": { target: WB_ENTRY, label: "档A" },
    "claude-opus-5": { target: WB_ENTRY_B, label: "档B" },
  };
}

/* ====================================================================== *
 * ★①② 活体：回落必须留痕（日志 + /api/status 两处）
 * ====================================================================== */
describe("T9 ★①② 活体：静默回落必须留痕", () => {
  let server, upstream, dataDir, P;
  const hits = [];

  before(async () => {
    const ports = await portsInRange(9);
    P = { bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4], qd: ports[5], or: ports[6], panel: ports[7], mm: ports[8] };
    dataDir = path.join(TMPROOT, "data-fallback");
    upstream = await startFakeUpstream(hits);
    server = await startServer(dataDir, P, upstream.address().port, patchSn);
  }, { timeout: 90000 });

  after(() => { try { upstream && upstream.close(); } catch { } killAll(); });

  test("★① 回落必须留痕：日志与 /api/status 两处都能查到这次回落，而请求照样成功", async () => {
    hits.length = 0;
    /* ★ 这就是用户实测报的那一下：把别家的模型名打到本渠道的中转口上。
       解析查不到 → 静默回落到本渠道的 defaultModel。 */
    const r = await askRelay(P.sn, FOREIGN, 1024);

    /* ① 请求本身**成功** —— 这正是「静默」二字的含义，也是它此前无从发现的原因。 */
    assert.equal(r.status, 200, `回落不该让请求失败。实际 ${r.status}：${r.text.slice(0, 200)}`);

    /* ★ 替换真的发生了，而且是**上游视角**的事实，不是我们自说自话：
       上游收到的是 defaultModel，不是客户端发来的那个名字。 */
    const chat = hits.filter((h) => h.url.indexOf("/v1/messages") >= 0);
    assert.ok(chat.length >= 1, `应当有一次真实上游调用。实际 hits=${JSON.stringify(hits.map((h) => h.url))}`);
    assert.equal(chat[0].model, SN_DEFAULT,
      `★ 上游实际跑的必须是回落后的模型。实际 ${JSON.stringify(chat.map((h) => h.model))}`);
    assert.equal(chat.some((h) => h.model === FOREIGN), false,
      "★ 上游绝不能收到那个不存在的模型名（否则回落就没发生，本条整条失去分辨力）");

    /* ② 面板状态里查得到：收到的名字 / 落到的值 / 渠道 / 次数 / 时刻。 */
    const st = await askStatus(P);
    const fb = st.sn.modelFallback;
    assert.ok(Array.isArray(fb) && fb.length >= 1,
      `★ /api/status 的 sn.modelFallback 里必须有这次回落。实际 ${JSON.stringify(fb)}`);
    const e = fb[0];
    assert.equal(e.requested, FOREIGN, `回落记录里必须有「收到的模型名」。实际 ${JSON.stringify(e)}`);
    assert.equal(e.landed, SN_DEFAULT, `回落记录里必须有「落到的值」。实际 ${JSON.stringify(e)}`);
    assert.ok(Number(e.count) >= 1, `回落记录里必须有累计次数。实际 ${JSON.stringify(e)}`);
    assert.ok(e.lastAt && !Number.isNaN(new Date(e.lastAt).getTime()),
      `回落记录里必须有最近时刻。实际 ${JSON.stringify(e)}`);

    /* ③ 渠道归属：别家没有回落时必须是空数组 —— 留痕不许张冠李戴到别的渠道上。
     *   bai 那家在 /api/status 里是**平铺**的（历史字段名，见 statusPayload），其余各家在自己的子对象下。 */
    assert.deepEqual(st.modelFallback, [],
      `★ 没发生回落的那家（bai）必须是空数组。实际 ${JSON.stringify(st.modelFallback)}`);
    for (const k of ["wb", "wbai", "zen", "qd", "mm", "or"]) {
      assert.deepEqual((st[k] || {}).modelFallback, [],
        `★ 没发生回落的那家（${k}）必须是空数组。实际 ${JSON.stringify((st[k] || {}).modelFallback)}`);
    }

    /* ④ 真实服务的模型也记下来了（这是 P1 的原料）：served 是实际服务的那个，
       target 是「我们打算路由到哪」——本例里两者都指向回落落点，所以**不**算不一致。 */
    const R = st.sn.recent;
    assert.equal(R.tier, FOREIGN, `观察表里记的档位就是客户端发来的名字。实际 ${JSON.stringify(R)}`);
    assert.equal(R.served, SN_DEFAULT, `served 必须是真实服务的模型。实际 ${JSON.stringify(R)}`);
    assert.equal(R.target, SN_DEFAULT, `本例 target 与回落落点相同。实际 ${JSON.stringify(R)}`);
    assert.equal(R.mismatch, false, `本例不存在「以为在用 A 实际用 B」，mismatch 必须是 false。实际 ${JSON.stringify(R)}`);

    /* ⑤ 日志里查得到，且三个要素齐全（收到的名字 / 落到的值 / 渠道）。 */
    const log = server.stdout();
    const line = log.split("\n").filter((l) => /模型回落/.test(l));
    assert.ok(line.length >= 1, `★ 子进程 stdout 里必须有「模型回落」那几行。实际日志尾：\n${log.slice(-600)}`);
    const first = line.find((l) => l.includes(FOREIGN) && l.includes(SN_DEFAULT) && /渠道\s*sn\b/.test(l));
    assert.ok(first, `★ 回落日志必须同时写清收到的名字、落到的值与渠道。实际：\n${line.join("\n")}`);
  }, { timeout: 90000 });

  test("★① 反向对照：同一个名字反复回落 → 计数累加，但日志不逐请求刷屏", async () => {
    const before = (await askStatus(P)).sn.modelFallback[0].count;
    const r = await askRelay(P.sn, FOREIGN, 1024);
    assert.equal(r.status, 200, `第二次请求同样成功。实际 ${r.status}：${r.text.slice(0, 160)}`);
    const after = (await askStatus(P)).sn.modelFallback[0];
    assert.equal(after.requested, FOREIGN, `还是同一个名字。实际 ${JSON.stringify(after)}`);
    assert.ok(after.count > before,
      `★ 持续回落必须累加计数（否则面板会以为只发生过一次）。实际 ${before} → ${JSON.stringify(after)}`);
    /* 日志去重：一个会话里每次请求都会走这条路，逐请求刷屏等于把日志淹了。
       判据是**条数不变**，不是"某一行"——所以先数一遍再数一遍。 */
    const lines = server.stdout().split("\n").filter((l) => /模型回落/.test(l));
    const n2 = lines.length;
    await askRelay(P.sn, FOREIGN, 1024);
    const lines2 = server.stdout().split("\n").filter((l) => /模型回落/.test(l));
    assert.equal(lines2.length, n2,
      `同一个回落不该逐请求刷日志（去重窗口 10 分钟）。实际 ${n2} → ${lines2.length}`);
  }, { timeout: 90000 });

  test("★ 状态里绝不出现凭据（红线自检）", async () => {
    const st = await askStatus(P);
    const dump = JSON.stringify(st.sn) + JSON.stringify(st.wb || {});
    for (const secret of [TOK_SN, TOK_WB]) {
      assert.equal(dump.includes(secret), false, `★ /api/status 里绝不许出现凭据：出现了 ${secret}`);
    }
  });
});

/* ====================================================================== *
 * ★③ 活体：正常路径零变化
 * ====================================================================== */
describe("T9 ★③ 活体：模型名在映射里时与改动前逐字一致", () => {
  let server, upstream, dataDir, P;
  const hits = [];

  before(async () => {
    const ports = await portsInRange(9);
    P = { bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4], qd: ports[5], or: ports[6], panel: ports[7], mm: ports[8] };
    dataDir = path.join(TMPROOT, "data-normal");
    upstream = await startFakeUpstream(hits);
    server = await startServer(dataDir, P, upstream.address().port, patchSn);
  }, { timeout: 90000 });

  after(() => { try { upstream && upstream.close(); } catch { } killAll(); });

  test("★③ 命中映射：上游收到的模型名、响应正文、日志、回落记录全部与改动前一致", async () => {
    hits.length = 0;
    const r = await askRelay(P.sn, "claude-sonnet-5", 1024);

    /* 上游收到的名字一字不差（改动动的是「第三条分支」，前两条一个字都没碰）。 */
    const chat = hits.filter((h) => h.url.indexOf("/v1/messages") >= 0);
    assert.equal(chat[0].model, SN_MAPPED, `命中映射时上游必须收到映射里的目标。实际 ${JSON.stringify(chat.map((h) => h.model))}`);
    /* 响应正文逐字一致（sn 是原样透传，上游给什么客户端就收到什么）。 */
    assert.equal(r.status, 200, `应当成功。实际 ${r.status}：${r.text.slice(0, 160)}`);
    assert.equal(r.text, ANTHRO_OK, `★ 响应正文必须与改动前逐字一致。实际 ${r.text.slice(0, 200)}`);

    /* ★ 一个回落记录都不许有：这条路径此前无声无息，改动后也必须无声无息。 */
    const st = await askStatus(P);
    assert.deepEqual(st.sn.modelFallback, [],
      `★ 正常路径不许产生任何回落记录。实际 ${JSON.stringify(st.sn.modelFallback)}`);
    assert.equal(/模型回落/.test(server.stdout()), false,
      `★ 正常路径不许打回落日志。实际日志尾：\n${server.stdout().slice(-600)}`);

    /* recent 带上真实服务的模型，但两者一致 → 不许被当成"不一致"来报警。 */
    const R = st.sn.recent;
    assert.equal(R.tier, "claude-sonnet-5", `实际 ${JSON.stringify(R)}`);
    assert.equal(R.label, "档·Sonnet", `实际 ${JSON.stringify(R)}`);
    assert.equal(R.target, SN_MAPPED, `实际 ${JSON.stringify(R)}`);
    assert.equal(R.served, SN_MAPPED, `★ served 必须是真实服务的那个（正常时与 target 相同）。实际 ${JSON.stringify(R)}`);
    assert.equal(R.mismatch, false, `正常路径不许报不一致。实际 ${JSON.stringify(R)}`);
  }, { timeout: 90000 });

  test("★③ 第二条分支（名字在可用清单里）同样零回落 —— 且不许被误报成不一致", async () => {
    hits.length = 0;
    const r = await askRelay(P.sn, SN_LISTED, 1024);
    assert.equal(r.status, 200, `应当成功。实际 ${r.status}：${r.text.slice(0, 160)}`);
    const chat = hits.filter((h) => h.url.indexOf("/v1/messages") >= 0);
    assert.equal(chat[0].model, SN_LISTED, `清单里的名字原样发出去。实际 ${JSON.stringify(chat.map((h) => h.model))}`);
    const st = await askStatus(P);
    assert.deepEqual(st.sn.modelFallback, [], `★ 第二条分支也不许产生回落记录。实际 ${JSON.stringify(st.sn.modelFallback)}`);

    /* ★ 这是**正常 CLI 流量的真实形态**：Claude Code 发来的是 settings.json 里写着的那个
     * 模型名（也就是 target），不是档位 key。于是 store.tier 存的是一个模型名，
     * 拿它当档位 key 去查 S.mapping 必然查不到 —— 若 target 因此被写成 defaultModel，
     * 面板就会天天报「你以为在用 SN_LISTED 其实在用 SN_DEFAULT」。
     * 那种误报比静默回落更坏：用户会学会无视它，于是真出事时也不看了。 */
    const R = st.sn.recent;
    assert.equal(R.tier, SN_LISTED, `实际 ${JSON.stringify(R)}`);
    assert.equal(R.served, SN_LISTED, `实际 ${JSON.stringify(R)}`);
    assert.equal(R.target, SN_LISTED,
      `★ target 必须重算成「我们打算路由到哪」= 客户端要的那个模型，而不是出厂默认档。实际 ${JSON.stringify(R)}`);
    assert.equal(R.mismatch, false, `★ 正常流量绝不许被报成不一致。实际 ${JSON.stringify(R)}`);
  }, { timeout: 90000 });
});

/* ====================================================================== *
 * ★②⑤ 活体：WorkBuddy 换模之后，served 必须是真实服务的那个
 * ====================================================================== */
describe("T9 ★②⑤ 活体：换模之后面板显示的是真实服务的模型", () => {
  let server, upstream, dataDir, P;
  const hits = [];

  before(async () => {
    const ports = await portsInRange(9);
    P = { bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4], qd: ports[5], or: ports[6], panel: ports[7], mm: ports[8] };
    dataDir = path.join(TMPROOT, "data-swap");
    upstream = await startFakeUpstream(hits);
    server = await startServer(dataDir, P, upstream.address().port, patchWb);
  }, { timeout: 90000 });

  after(() => { try { upstream && upstream.close(); } catch { } killAll(); });

  test("★②⑤ 429 换模：served 变成换过去的那个，target 仍是映射里配的那个，两者不一致", async () => {
    hits.length = 0;
    const r = await askRelay(P.wb, "claude-sonnet-5", 1024);
    assert.equal(r.status, 200, `换模后应当成功。实际 ${r.status}：${r.text.slice(0, 200)}`);

    /* 上游视角：确实先打入口档（429）、再打换过去的那一档。
       注意 WorkBuddy 的桥打的是 /v2/chat/completions（实测路径），不是 /v1/messages。 */
    const chain = hits.filter((h) => h.url.indexOf("/v3/config") < 0 && h.model).map((h) => h.model);
    assert.deepEqual(chain, [WB_ENTRY, WB_PAID],
      `★ 必须真的发生换模，否则本条整条失去分辨力。实际链路 ${JSON.stringify(chain)}`);

    const st = await askStatus(P);
    const R = st.wb.recent;
    assert.equal(R.tier, "claude-sonnet-5", `实际 ${JSON.stringify(R)}`);
    assert.equal(R.target, WB_ENTRY, `target 是「我们打算路由到哪」。实际 ${JSON.stringify(R)}`);
    assert.equal(R.served, WB_PAID,
      `★ served 必须是**真实服务的那个**（换过去的），不是换之前的。实际 ${JSON.stringify(R)}`);
    assert.equal(R.mismatch, true,
      `★ 两者不一致时 mismatch 必须是 true —— 那正是用户要看见的东西。实际 ${JSON.stringify(R)}`);
    assert.ok(R.observedAt, `实际 ${JSON.stringify(R)}`);
  }, { timeout: 120000 });
});

/* ====================================================================== *
 * ★④ 源码判据：面板两处呈现（vm 里跑真源码，不抄一份重写）
 * ====================================================================== */
function sliceBetween(src, startAnchor, endAnchor) {
  const i = src.indexOf(startAnchor);
  assert.ok(i >= 0, `抠源码失败：找不到 ${JSON.stringify(startAnchor)}`);
  const j = src.indexOf(endAnchor, i + startAnchor.length);
  assert.ok(j > i, `抠源码失败：找不到终点 ${JSON.stringify(endAnchor)}`);
  const out = src.slice(i, j);
  assert.equal((out.match(/\/\*/g) || []).length, (out.match(/\*\//g) || []).length,
    `切片停在注释中间：${JSON.stringify(startAnchor)}`);
  return out;
}

/** 把 panel-common.js 里的 modelIdentityItems + servedNote 抠出来在 vm 里求值。 */
function loadPanelIdentity() {
  const src = sliceBetween(PANEL_SRC, "  function modelIdentityItems(S, name) {", "  function buildDiag() {");
  const body = `(() => {
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    ${src}
    return { modelIdentityItems, servedNote };
  })()`;
  return vm.runInNewContext(body, { console }, { filename: "panel-model-identity" });
}

describe("T9 ★④ 源码判据：面板必须一眼看出「以为在用 A 其实在用 B」", () => {
  const panel = loadPanelIdentity();

  test("★④ 回落条目：标题里同时出现收到的名字与落到的值，并写明成因与处置", () => {
    const st = {
      recent: { tier: FOREIGN, label: FOREIGN, target: SN_DEFAULT, served: SN_DEFAULT, mismatch: false, observedAt: new Date().toISOString() },
      modelFallback: [{ requested: FOREIGN, landed: SN_DEFAULT, count: 3, firstAt: new Date().toISOString(), lastAt: new Date().toISOString() }],
    };
    const items = panel.modelIdentityItems(st, "示例渠道");
    assert.equal(items.length, 1, `应当恰好一条。实际 ${JSON.stringify(items)}`);
    const it = items[0];
    /* 红色：回落不是"需留意"，它就是「你以为在用 A 其实在用 B」。 */
    assert.equal(it.s, "err", `★ 回落必须是故障级（err），不能降级成"需留意"。实际 ${it.s}`);
    /* 一眼可见：标题里两个名字都在。 */
    assert.match(it.t, /示例渠道/, `标题要带上是哪家。实际 ${it.t}`);
    assert.ok(it.t.includes(FOREIGN), `★ 标题必须含客户端发来的名字。实际 ${it.t}`);
    assert.ok(it.t.includes(SN_DEFAULT), `★ 标题必须含实际落到的模型。实际 ${it.t}`);
    assert.match(it.t, /回落到/, `标题要说清这是回落。实际 ${it.t}`);
    assert.match(it.m, /静默/, `正文要点破"静默"这件事。实际 ${it.m}`);
    assert.match(it.t, /累计 3 次/, `累计次数要露出来。实际 ${it.t}`);
    assert.ok(it.t.includes("示例渠道"), `实际 ${it.t}`);

    /* 防恒真：只给 modelFallback、不给 recent，也必须出条目
       （否则这条可能其实是靠 recent 撑起来的，而 recent 里根本没有回落信息）。 */
    const onlyFb = panel.modelIdentityItems({ modelFallback: st.modelFallback }, "示例渠道");
    assert.equal(onlyFb.length, 1, `★ 回落条目不许依赖 recent。实际 ${JSON.stringify(onlyFb)}`);
    assert.equal(onlyFb[0].t, it.t, `两条应当同形。实际 ${JSON.stringify(onlyFb)}`);

    /* 防恒真：mismatch=true 但 served===target（自相矛盾的状态）不许出条目。 */
    const bogus = panel.modelIdentityItems({
      recent: { tier: "claude-sonnet-5", target: "x", served: "x", mismatch: true },
      modelFallback: [],
    }, "示例渠道");
    assert.equal(JSON.stringify(bogus), "[]", `★ 自相矛盾的状态不许报警（否则这条是恒真的）。实际 ${JSON.stringify(bogus)}`);
  });

  test("★②④ 不一致条目：served 与 target 两个都显示，并标明差异", () => {
    const st = {
      recent: {
        tier: "claude-sonnet-5", label: "档A",
        target: WB_ENTRY, served: WB_PAID, mismatch: true,
        observedAt: new Date("2026-10-13T08:00:00.000Z").toISOString(),
      },
      modelFallback: [],
    };
    const items = panel.modelIdentityItems(st, "示例渠道");
    assert.equal(items.length, 1, `应当恰好一条。实际 ${JSON.stringify(items)}`);
    const it = items[0];
    assert.equal(it.s, "err", `实际 ${it.s}`);
    assert.ok(it.t.includes(WB_ENTRY), `★ 必须显示「打算路由到」的那个。实际 ${it.t}`);
    assert.ok(it.t.includes(WB_PAID), `★ 必须显示「真实服务的」那个。实际 ${it.t}`);
    assert.match(it.t, /你以为在用/, `实际 ${it.t}`);
    assert.match(it.t, /实际服务的是/, `标题要写清哪个是真实服务的。实际 ${it.t}`);
    assert.match(it.m, /真实服务的是/, `正文也要写清。实际 ${it.m}`);
    assert.ok(it.m.includes("claude-sonnet-5"), `正文要带上正在用的档位。实际 ${it.m}`);
    assert.ok(it.m.includes("2026") || it.m.includes("档A"), `正文要带上定位信息。实际 ${it.m}`);

    /* 矩阵格那一处：正在用的那一档旁边补「实际服务 <名字>」，两个名字都在 tooltip 里。 */
    const note = panel.servedNote(st.recent);
    assert.ok(note.includes(WB_PAID), `矩阵格里必须出现真实服务的模型。实际 ${note}`);
    assert.ok(note.includes(WB_ENTRY), `★ 矩阵格的 tooltip 里必须同时给出打算路由到哪个。实际 ${note}`);
    assert.match(note, /实际服务/, `实际 ${note}`);
  });

  test("★③ 正常路径：一条条目都不出，矩阵格一个字都不加（与改动前逐字一致）", () => {
    const st = {
      recent: { tier: "claude-sonnet-5", label: "档·Sonnet", target: SN_MAPPED, served: SN_MAPPED, mismatch: false, observedAt: new Date().toISOString() },
      modelFallback: [],
    };
    /* 用 JSON 比而不是 deepEqual：vm 出来的数组来自另一个 realm，原型不同，
       deepStrictEqual 会因为**原型**而不是内容红（wb-catalog 那条测试踩过同一个坑）。 */
    assert.equal(JSON.stringify(panel.modelIdentityItems(st, "示例渠道")), "[]",
      `★ 正常路径不许产生任何条目。实际 ${JSON.stringify(panel.modelIdentityItems(st, "示例渠道"))}`);
    assert.equal(panel.servedNote(st.recent), "", "★ 正常路径不许在矩阵格加任何东西");
    assert.equal(panel.servedNote(null), "", "没有观察时也不许加东西");
    assert.equal(panel.servedNote({ tier: "claude-sonnet-5", target: "a", served: "a", mismatch: false }), "");
    /* 自相矛盾的状态（标了 mismatch 但两个名字一样）：两处都不许出声。 */
    assert.equal(panel.servedNote({ tier: "claude-sonnet-5", target: "a", served: "a", mismatch: true }), "",
      "★ mismatch=true 但两个名字一样时，矩阵格不许显示「实际服务 a」");

    /* ★ 与改动前**逐字**一致：把改动前那一行表达式原样搬过来现算一遍，两边必须完全相同。
       （改动只是在这一行**后面**加了 `${R && R.tier === t.key ? servedNote(R) : ""}`，
        而 servedNote 在正常路径上返回空串，所以 HTML 一字不差。） */
    const map = { "claude-sonnet-5": { target: SN_MAPPED, label: "档·Sonnet" }, "claude-haiku-4-5": { target: SN_LISTED, label: "档·Haiku" } };
    const TIERS = [{ key: "claude-fable-5", short: "Fable" }, { key: "claude-sonnet-5", short: "Sonnet" }, { key: "claude-opus-5", short: "Opus" }, { key: "claude-haiku-4-5", short: "Haiku" }];
    const esc = (s) => String(s == null ? "" : s);
    const before = TIERS.map((t) => {
      const m = map[t.key] || {};
      return `<span class="mrow"><i class="t">${esc(t.short)}</i><i class="v">${esc(m.label || m.target || "未设")}</i></span>`;
    }).join("");
    const R = st.recent;
    const after = TIERS.map((t) => {
      const m = map[t.key] || {};
      return `<span class="mrow"><i class="t">${esc(t.short)}</i><i class="v">${esc(m.label || m.target || "未设")}</i>${R && R.tier === t.key ? panel.servedNote(R) : ""}</span>`;
    }).join("");
    assert.equal(after, before, `★ 矩阵格渲染必须与改动前逐字一致。\nbefore=${before}\nafter =${after}`);
  });

  test("★ 渲染层不许认识渠道名（C11）：面板那两处一个渠道字面量都不许出现", () => {
    const fn = sliceBetween(PANEL_SRC, "  function modelIdentityItems(S, name) {", "  function buildDiag() {");
    for (const k of ["bai", "sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
      assert.equal(new RegExp(`["'\`]${k}["'\`]`).test(fn), false,
        `★ 渲染层不许出现渠道名 ${k}（渠道名由调用方 nameOf 传进来）。片段：\n${fn.slice(0, 400)}`);
    }
  });

  test("★ 结构判据：两个解析函数的**分支部分必须逐字一致**（改了一边忘了另一边要红）", () => {
    /* resolveModel 与 resolveModelQuiet 只差"第三条分支留不留痕"。它们一旦分叉，
       providerStatus 重算出来的「意图」就会与实际执行的解析慢慢对不上——
       而对不上的时候面板报的是**两个方向都可能错**的差异，用户无从判断该信哪个。
       所以把"前四行必须逐字相同"钉在源码上。 */
    const body = (anchor) => sliceBetween(SRC, anchor, "\n}").split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .slice(1)   // 去掉函数签名那一行：两个函数本来就差一个 ch 参数，比它没有意义
      .join("\n");
    const quiet = body("function resolveModelQuiet(name, cfg) {");
    const loud = body("function resolveModel(name, cfg, ch) {");
    /* 比的是"去掉留痕那一行之后必须完全相同"——这两条函数只允许差那一句。 */
    const stripNote = (s) => s.split("\n").filter((l) => !/noteModelFallback/.test(l)).join("\n");
    assert.equal(stripNote(loud), quiet,
      `★ 两个解析函数除留痕那一句外必须逐字一致。\nquiet:\n${quiet}\nloud:\n${loud}`);
    assert.match(quiet, /if \(m && m\.target\) return m\.target;/, "第一条分支（命中映射）");
    assert.match(quiet, /if \(\(cfg\.availableModels \|\| \[\]\)\.includes\(base\)\) return base;/, "第二条分支（命中清单）");
    assert.match(quiet, /return cfg\.defaultModel;/, "第三条分支（回落）必须原样保留");
    assert.equal(/noteModelFallback/.test(quiet), false, "重算那条路**不许**留痕（否则每刷新一次面板就多一条回落记录）");
    assert.match(loud, /noteModelFallback\(ch, base, cfg\.defaultModel\);/, "留痕必须落在回落那条上");
  });

  test("★ 结构判据：resolveModel 的第三条分支必须**有**留痕调用（前两条不许有）", () => {
    /* 这条钉的是"为什么会对"：光看结果对，可能是别处补的记录。
       少它，哪天有人为了让日志安静点把那一行删了，① 的两条断言未必都红。 */
    const fn = sliceBetween(SRC, "function resolveModel(name, cfg, ch) {", "// ---------- 桌面版可用性探测的两个端点");
    assert.equal((fn.match(/noteModelFallback/g) || []).length, 1,
      `★ resolveModel 里必须恰好有一处 noteModelFallback 调用。实际片段：\n${fn}`);
    assert.match(fn, /if \(m && m\.target\) return m\.target;/, "第一条分支（命中映射）必须原样保留");
    assert.match(fn, /if \(\(cfg\.availableModels \|\| \[\]\)\.includes\(base\)\) return base;/, "第二条分支（命中清单）必须原样保留");
    /* 留痕必须在 return defaultModel **之前**（反了就等于先回落再记，记的还是对的，
       但顺序一旦倒过来就看不出"因为什么才回落"）。 */
    assert.ok(fn.indexOf("noteModelFallback") < fn.indexOf("return cfg.defaultModel;"),
      "★ 留痕必须在回落到默认模型之前");
  });
});

/* ====================================================================== *
 * 反向对照手法表
 * ====================================================================== */
const SABOTAGE = [
  {
    name: "silent-fallback",
    file: "src/server/server.mjs",
    where: "resolveModel —— 第三条分支必须留痕",
    from: `  noteModelFallback(ch, base, cfg.defaultModel);
  return cfg.defaultModel;`,
    to: `  return cfg.defaultModel;`,
    reds: "★① 回落不再留痕：日志与 /api/status 两处都查不到（这就是改动前的行为）",
  },
  {
    name: "status-target-only",
    file: "src/server/server.mjs",
    where: "providerStatus —— served 必须读真实服务的那个，而不是拿 target 顶替",
    from: `      const target = resolveModelQuiet(t, S);
      const served = (obs && obs.served) || null;`,
    to: `      const target = resolveModelQuiet(t, S);
      const served = target;`,
    reds: "★② 换模后面板显示的仍是换之前的模型名（拿 intent 冒充事实）",
  },
  {
    name: "target-hardcoded-default",
    file: "src/server/server.mjs",
    where: "providerStatus —— target 必须重算，不能拿模型名当档位 key 查表再回落默认档",
    from: "      const target = resolveModelQuiet(t, S);",
    to: "      const target = S.mapping?.[t]?.target || S.defaultModel;",
    reds: "★③ 正常 CLI 流量（客户端发的是 target 不是档位 key）被误报成「以为在用 A 其实在用 B」——天天误报的告警比静默回落更坏",
  },
  {
    name: "quiet-also-logs",
    file: "src/server/server.mjs",
    where: "resolveModelQuiet —— 事后重算那条路不许留痕",
    from: `function resolveModelQuiet(name, cfg) {
  const base = normalizeModel(name);
  const m = cfg.mapping?.[base];
  if (m && m.target) return m.target;
  if ((cfg.availableModels || []).includes(base)) return base;
  return cfg.defaultModel;
}`,
    to: `function resolveModelQuiet(name, cfg) {
  const base = normalizeModel(name);
  const m = cfg.mapping?.[base];
  if (m && m.target) return m.target;
  if ((cfg.availableModels || []).includes(base)) return base;
  noteModelFallback(cfg.p, base, cfg.defaultModel);
  return cfg.defaultModel;
}`,
    reds: "★③ 面板每刷新一次就把回落计数再加一次（重算不是一次新的解析）",
  },
  {
    name: "no-mismatch-flag",
    file: "src/server/server.mjs",
    where: "providerStatus —— 不一致必须标出来",
    from: `        mismatch: !!(served && served !== target),`,
    to: `        mismatch: false,`,
    reds: "★②④ 两者不一致时面板沉默（差异恰恰被藏起来）",
  },
  {
    name: "no-obs-swap-update",
    file: "src/server/server.mjs",
    where: "WorkBuddy 换模 —— 换完必须把真实服务的模型写回观察",
    from: `        if (recovered && obs) {
          obs.swappedFrom = obs.served;
          obs.served = steps[steps.length - 1].model;
        }`,
    to: `        if (false && obs) {
          obs.swappedFrom = obs.served;
          obs.served = steps[steps.length - 1].model;
        }`,
    reds: "★②⑤ 换模后 served 停在换之前的名字（面板拿假名字说真话）",
  },
  {
    name: "panel-drop-fallback-item",
    file: "src/server/panel-common.js",
    where: "modelIdentityItems —— 回落必须在诊断抽屉里看得见",
    from: "    for (const f of fb.slice(0, 3)) {",
    to: "    for (const f of []) {",
    reds: "★④ 回落留在日志里但面板上一眼看不见（等于回到「用户无从知道」）",
  },
  {
    name: "panel-only-target",
    file: "src/server/panel-common.js",
    where: "modelIdentityItems —— 不一致时两个模型名必须都显示",
    from: "        t: `${name}：你以为在用「${R.target}」，实际服务的是「${R.served}」`,",
    to: "        t: `${name}：你在用「${R.target}」`,",
    reds: "★②④ 面板只显示打算路由到的那个（真实服务的那个被藏起来 —— 那正是要看见的东西）",
  },
];

if (process.argv.includes("--emit-sabotage")) {
  /* 给配套执行器 scripts/model-truth-sabotage-run.mjs 读。
     表只有一份：执行器从**本文件**里读出去，不复制一份（复制的迟早与源码脱节）。 */
  process.stdout.write(JSON.stringify(SABOTAGE));
  process.exit(0);
}

if (process.argv.includes("--list-sabotage")) {
  console.log(`T9 模型身份 · 反向对照手法（${SABOTAGE.length} 条，grep SABOTAGE 可定位）`);
  for (const s of SABOTAGE) console.log(`  ${s.name.padEnd(24)} ${s.where}\n  ${"".padEnd(24)} → 会打红: ${s.reds}`);
  process.exit(0);
}
const sIdx = process.argv.indexOf("--sabotage");
if (sIdx >= 0) {
  const name = process.argv[sIdx + 1];
  const s = SABOTAGE.find((x) => x.name === name);
  if (!s) { console.error(`没有这条手法：${name}。可用：${SABOTAGE.map((x) => x.name).join(", ")}`); process.exit(2); }
  const file = path.join(REPO, s.file);
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes(s.from)) { console.error(`手法 ${name} 的锚点已经对不上源码了（可能已改坏或已改名）`); process.exit(3); }
  fs.writeFileSync(file, src.replace(s.from, s.to));
  console.log(`已把 ${s.file} 改成改坏的样子：${s.where}`);
  process.exit(0);
}