/**
 * Chat 入向的**端到端**活体：真 server.mjs + 真统一网关端口 + 假上游
 *
 * ## 为什么还要这一层
 *
 * scripts/chat-protocol-test.mjs 测的是**协议桥那一层**（真 handler + 假中转）。
 * 这一份测的是**整条链路**：
 *
 *   客户端发 Chat（/v1/chat/completions）
 *     → 统一网关拆 provider 前缀
 *     → 档位解析（映射表 → 该家的最终模型名）
 *     → 协议桥把 Chat 翻成 Anthropic 形状
 *     → 该家的中转（sn）把它打到上游
 *     → 上游回 Anthropic 形状
 *     → 协议桥翻回 Chat 形状
 *     → 客户端收到 Chat
 *
 * 这一层里的任何一环坏了（路由、档位、翻译、回程），上层测试都发现不了。
 *
 * ## 测什么
 *
 *   ★ ① 非流式：上游收到的是 **Anthropic 形状**（messages 数组），客户端收到的是
 *     **Chat 形状**（choices[0].message）
 *   ★ ② 档位解析：`sn/claude-opus-5` → 上游收到的是映射表里的**最终模型名**
 *   ★ ③ **档位降级**：客户端送 `sn/claude-sonnet-5-5` ⇒ 命中 `claude-sonnet-5` 那一档
 *   ★ ④ 流式：客户端收到 Chat 的 SSE（末尾 [DONE]）
 *   ★ ⑤ `/chat/completions`（不带 /v1）也通
 *   ★ ⑥ 错误路径：没 provider 前缀 → 400；未知 provider → 404
 *   ★ ⑦ **反向对照**：把档位解析改坏 ⇒ ②/③ 必须失效
 *
 * ## 红线
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录 + BAI_DATA_DIR，**绝不碰真实的
 *    %APPDATA%\bai-router**；端口全部动态挑空闲（17xxx 段）；进程只按 **PID** 收。
 * 🔴 全文没有一个真实令牌/API key（夹具里的凭据形态串是明显假的占位串）。
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
const SERVER_DIR = path.join(REPO, "src", "server");
const SERVER = path.join(SERVER_DIR, "server.mjs");
const DEFAULTS_JSON = path.join(SERVER_DIR, "config.defaults.json");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-chate2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* 夹具常量：全部带 test- 前缀，断言里出现它们只可能来自本测试自己配的夹具。 */
const TOK_SN = "test-sn-token-placeholder";
const SN_OPUS = "test-sn-opus-model";
const SN_SONNET = "test-sn-sonnet-model";

/* 端口：挑过的要记下来（探测是「bind 再 close」，释放后下次又从段首开始）。 */
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

const procs = new Set();
function track(p) { procs.add(p); p.on("exit", () => procs.delete(p)); return p; }
function killAll() {
  for (const p of procs) {
    try { if (p.pid) spawnSync("taskkill", ["/PID", String(p.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
    try { p.kill(); } catch { }
  }
  procs.clear();
}

/** 假上游：只讲 Anthropic 规范（sn 那一路是原样透传）。 */
async function startFakeUpstream(hits) {
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      const url = String(rq.url || "");
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}; } catch { }
      hits.push({ url, body, auth: String(rq.headers["authorization"] || "") });
      if (url.indexOf("/v1/messages") < 0) { rs.writeHead(404); rs.end("{}"); return; }
      const model = String(body.model || "");
      if (body.stream) {
        rs.writeHead(200, { "content-type": "text/event-stream" });
        rs.write(`event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { id: "msg_fake", model, role: "assistant", content: [], usage: { input_tokens: 7, output_tokens: 0 } },
        })}\n\n`);
        rs.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
        })}\n\n`);
        rs.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "假上游说:" + model },
        })}\n\n`);
        rs.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        rs.write(`event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 7, output_tokens: 3 },
        })}\n\n`);
        rs.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        rs.end();
        return;
      }
      rs.writeHead(200, { "content-type": "application/json" });
      rs.end(JSON.stringify({
        id: "msg_fake", type: "message", role: "assistant", model,
        content: [{ type: "text", text: "假上游说:" + model }],
        stop_reason: "end_turn",
        usage: { input_tokens: 7, output_tokens: 3 },
      }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return srv;
}

/* ====================================================================== *
 * 活体
 * ====================================================================== */
describe("Chat 入向 · 端到端（真 server + 统一网关 + 假上游）", () => {
  let child, upstream, dataDir, P;
  const hits = [];

  before(async () => {
    const ports = [];
    for (let i = 0; i < 9; i++) ports.push(await portInRange());
    P = {
      bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4],
      qd: ports[5], or: ports[6], panel: ports[7], mm: ports[8], gateway: ports[9] || ports[0],
    };
    /* ⚠ 9 个端口不够（还要网关），补一个 */
    if (!ports[9]) P.gateway = await portInRange();

    upstream = await startFakeUpstream(hits);
    const upPort = upstream.address().port;

    dataDir = path.join(TMPROOT, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
    cfg.failover = { ...(cfg.failover || {}), enabled: false };
    cfg.proxy = "http://127.0.0.1:7897";
    cfg._modelsSynced = "dev";
    cfg.relayPort = P.bai; cfg.panelPort = P.panel; cfg.gatewayPort = P.gateway;
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
      cfg[k] = { ...cfg[k], relayPort: P[k] };
      /* 全部指到假上游：启动期的目录同步只会拿到 404，不会碰真网络。 */
      cfg[k].upstream = `http://127.0.0.1:${upPort}`;
      cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
      if (k === "or") cfg[k].keys = [];
    }
    /* sn 这一路是我们要验的那家：档位 → 最终模型名。 */
    cfg.sn.apiKey = TOK_SN;
    cfg.sn.useProxy = false;
    cfg.sn.defaultModel = SN_OPUS;
    cfg.sn.availableModels = [SN_OPUS, SN_SONNET];
    cfg.sn.mapping = {
      "claude-opus-5": { target: SN_OPUS, label: "档·Opus" },
      "claude-sonnet-5": { target: SN_SONNET, label: "档·Sonnet" },
    };
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");

    const env = {
      ...process.env, BAI_DATA_DIR: dataDir, BAI_NO_PROXY_AUTODETECT: "1", BAI_ENV_FIXED: "1",
    };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    env.NO_PROXY = "127.0.0.1,localhost";
    child = track(spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
    const log = [];
    child.stdout.on("data", (d) => log.push(String(d)));
    child.stderr.on("data", (d) => log.push(String(d)));
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) return; }
      catch { }
      await sleep(300);
    }
    throw new Error(`server.mjs 60 秒内没起来。日志尾：${log.join("").slice(-1500)}`);
  }, { timeout: 120000 });

  after(() => { killAll(); if (upstream) { try { upstream.close(); } catch { } } });

  const ask = (p, body) => fetch(`http://127.0.0.1:${P.gateway}${p}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));

  test("① 非流式：上游收 Anthropic 形状，客户端收 Chat 形状", async () => {
    hits.length = 0;
    const r = await ask("/v1/chat/completions", {
      model: "sn/claude-opus-5",
      messages: [{ role: "user", content: "北京天气？" }],
      max_tokens: 100,
    });
    assert.equal(r.status, 200, `实际 ${r.status}：${r.text.slice(0, 400)}`);
    const j = JSON.parse(r.text);

    /* 客户端拿到的必须是 Chat 形状 */
    assert.equal(j.object, "chat.completion");
    assert.ok(Array.isArray(j.choices), "choices 必须在");
    assert.equal(j.choices[0].message.content, "假上游说:" + SN_OPUS);
    assert.equal(j.choices[0].finish_reason, "stop");
    assert.equal(j.usage.prompt_tokens, 7);

    /* 上游拿到的必须是 Anthropic 形状 */
    assert.ok(hits.length >= 1, "上游没被调用");
    const up = hits[hits.length - 1];
    assert.match(up.url, /\/v1\/messages$/, `上游路径不对：${up.url}`);
    assert.ok(Array.isArray(up.body.messages), "★ 上游收到的是 Chat 形状 —— 翻译没发生");
    assert.equal(up.body.messages[0].content[0].text, "北京天气？");
    assert.equal(up.body.max_tokens, 100);
  });

  test("② 档位解析：sn/claude-opus-5 ⇒ 上游收到的是映射表里的最终模型名", async () => {
    hits.length = 0;
    await ask("/v1/chat/completions", {
      model: "sn/claude-opus-5",
      messages: [{ role: "user", content: "x" }],
    });
    const up = hits[hits.length - 1];
    assert.equal(up.body.model, SN_OPUS,
      `★ 上游收到的是「${up.body.model}」，不是映射表里的「${SN_OPUS}」—— 档位没解析`);
  });

  test("③ 档位降级：送 claude-sonnet-5-5 ⇒ 命中 claude-sonnet-5 那一档", async () => {
    hits.length = 0;
    const r = await ask("/v1/chat/completions", {
      model: "sn/claude-sonnet-5-5",
      messages: [{ role: "user", content: "x" }],
    });
    assert.equal(r.status, 200, `实际 ${r.status}：${r.text.slice(0, 300)}`);
    const up = hits[hits.length - 1];
    assert.equal(up.body.model, SN_SONNET,
      `★ 降级没生效：上游收到「${up.body.model}」，应是「${SN_SONNET}」`);
  });

  test("④ 流式：客户端收到 Chat 的 SSE", async () => {
    hits.length = 0;
    const r = await fetch(`http://127.0.0.1:${P.gateway}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "sn/claude-opus-5",
        messages: [{ role: "user", content: "x" }],
        stream: true,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    assert.match(text, /"object":"chat\.completion\.chunk"/, "必须是 Chat 的 chunk");
    assert.match(text, /假上游说/, "正文没带过来");
    assert.match(text, /data: \[DONE\]/, "末尾必须有 [DONE]");
  });

  test("⑤ /chat/completions（不带 /v1）也通", async () => {
    const r = await ask("/chat/completions", {
      model: "sn/claude-opus-5",
      messages: [{ role: "user", content: "x" }],
    });
    assert.equal(r.status, 200, `实际 ${r.status}：${r.text.slice(0, 300)}`);
    assert.equal(JSON.parse(r.text).object, "chat.completion");
  });

  test("⑥ 错误路径：没前缀 → 400；未知 provider → 404", async () => {
    const r1 = await ask("/v1/chat/completions", { model: "claude-opus-5", messages: [] });
    assert.equal(r1.status, 400, `实际 ${r1.status}`);
    assert.match(r1.text, /provider/);
    const r2 = await ask("/v1/chat/completions", { model: "nope/claude-opus-5", messages: [] });
    assert.equal(r2.status, 404, `实际 ${r2.status}`);
    assert.match(r2.text, /nope/);
  });

  test("⑦b Responses 与 Gemini 也走通（它们此前从没被真实走过）", async () => {
    /* ⚠ 这两条协议写好之后**一直没有任何客户端真的接过** ⇒ 那条路上一个真实
     *   请求都没走过 ⇒ 「body 换了但 URL 没换」那个洞就藏在那里。
     *   2026-10-23 修了 URL，现在用它们证明：修完之后三条协议都通。 */
    hits.length = 0;
    const r1 = await ask("/v1/responses", {
      model: "sn/claude-opus-5",
      input: "北京天气？",
      max_output_tokens: 100,
    });
    assert.equal(r1.status, 200, `Responses 实际 ${r1.status}：${r1.text.slice(0, 300)}`);
    const j1 = JSON.parse(r1.text);
    assert.equal(j1.object, "response", "Responses 的应答形状不对");
    assert.ok(Array.isArray(j1.output), "output 必须在");
    const up1 = hits[hits.length - 1];
    assert.match(up1.url, /\/v1\/messages$/, `上游路径不对：${up1.url}`);
    assert.ok(Array.isArray(up1.body.messages), "★ 上游收到的是 Responses 形状 —— 翻译没发生");

    hits.length = 0;
    /* Gemini 的模型名在**路径**里 ⇒ 斜杠要 URL 编码（%2F）。 */
    const r2 = await ask("/v1beta/models/" + encodeURIComponent("sn/claude-opus-5") + ":generateContent", {
      contents: [{ role: "user", parts: [{ text: "北京天气？" }] }],
    });
    assert.equal(r2.status, 200, `Gemini 实际 ${r2.status}：${r2.text.slice(0, 300)}`);
    const j2 = JSON.parse(r2.text);
    assert.ok(Array.isArray(j2.candidates), "Gemini 的 candidates 必须在");
    const up2 = hits[hits.length - 1];
    assert.match(up2.url, /\/v1\/messages$/, `上游路径不对：${up2.url}`);
    assert.ok(Array.isArray(up2.body.messages), "★ 上游收到的是 Gemini 形状 —— 翻译没发生");
    assert.equal(up2.body.model, SN_OPUS, "Gemini 的模型名要搬到 body 里（它在路径里）");
  });

  test("⑦c 网关的信息与清单端点（有些客户端靠它们才知道连上没有）", async () => {
    const getJson = (p) => fetch(`http://127.0.0.1:${P.gateway}${p}`, {
      signal: AbortSignal.timeout(30000),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

    /* GET / 与 GET /v1 ⇒ 网关信息（magpie 也答这两个：gateway.go:657-661）。
     *   Empryo 这类客户端「只把 baseURL 有应答的 provider 列出来」—— 它打的就是
     *   baseURL 本身；我们原先一律 405 ⇒ 它一个 provider 都列不出来。 */
    for (const p of ["/", "/v1"]) {
      const r = await getJson(p);
      assert.equal(r.status, 200, `GET ${p} 实际 ${r.status}`);
      assert.equal(r.json.name, "bai-router", `GET ${p} 的 name 不对`);
      assert.ok(typeof r.json.models === "number" && r.json.models > 0, `GET ${p} 的 models 不对`);
      assert.ok(Array.isArray(r.json.apis) && r.json.apis.length > 0, `GET ${p} 的 apis 不对`);
    }

    /* GET /models（不带 /v1 的别名）⇒ 同一份清单。 */
    const rm = await getJson("/models");
    assert.equal(rm.status, 200, `GET /models 实际 ${rm.status}`);
    assert.equal(rm.json.object, "list");
    assert.ok(rm.json.data.length > 0);

    /* GET /v1/models/{id} ⇒ 单个模型（id 里带斜杠，所以后面那一段整个当 id）。 */
    const one = await getJson("/v1/models/" + encodeURIComponent("sn/claude-opus-5"));
    assert.equal(one.status, 200, `GET 单个模型 实际 ${one.status}`);
    assert.equal(one.json.id, "sn/claude-opus-5");

    /* 找不到 ⇒ 404（**不猜**：宁可说没有，也不要给一个不对的模型）。 */
    const none = await getJson("/v1/models/" + encodeURIComponent("sn/没有这个档位"));
    assert.equal(none.status, 404, `实际 ${none.status}`);
  });

  test("⑦d Muse Code 的清单（它从 /muse-code/models 拉，不是 /v1/models）", async () => {
    const r = await fetch(`http://127.0.0.1:${P.gateway}/muse-code/models`, {
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(r.status, 200, `实际 ${r.status}`);
    const j = await r.json();
    assert.equal(j.object, "list", "外壳要与 magpie 的 museModels 逐字同构");
    assert.ok(Array.isArray(j.data) && j.data.length > 0, "清单不能是空的");
    const one = j.data[0];
    assert.equal(one.object, "model");
    assert.match(one.id, /^[a-z0-9]+\/.+/, "模型 id 必须是 provider/档位");
    assert.ok(one.owned_by, "owned_by 要有（Muse 靠它认家）");
    const meta = one.metadata && one.metadata["muse-code"];
    assert.ok(meta, "★ 没有 metadata['muse-code'] —— Muse 读不到就当没有这个模型");
    /* ⚠ **limit 必须有**：Muse 会**隐藏**没有 limit 的模型 ⇒ 没有 limit 等于白写。 */
    assert.ok(meta.limit && meta.limit.context > 0 && meta.limit.output > 0,
      `limit 缺失或非正 —— Muse 会把这个模型藏起来：${JSON.stringify(meta)}`);
    assert.deepEqual(meta.modalities, { input: ["text"], output: ["text"] });
  });

  test("⑦ 反向对照：把「URL 也换成 /v1/messages」改坏 ⇒ ① 必须抓到", async () => {
    /* 手法（与 scripts/gateway-test.mjs 同一路子）：把 src/server **复制**到临时目录，
       在**副本**的 gateway.mjs 上把「URL 也换」那一行改坏（URL 保持客户端原来那个），
       再起一个「坏掉的」实例，重跑同一条请求 —— 必须**不再等价**（上游 404）。
       ⚠ 改的是副本，仓库源码一个字不动：所以不存在「测完忘了还原」这种事故。
       ⚠ 锚点对不上就**当场抛错**：手法与源码脱节时，这条对照就是假的。 */
    const dir = path.join(TMPROOT, "broken-server");
    fs.mkdirSync(path.join(dir, "cards"), { recursive: true });
    fs.mkdirSync(path.join(dir, "clients"), { recursive: true });
    for (const f of fs.readdirSync(SERVER_DIR)) {
      /* ⚠ 别漏 .cjs：server.mjs import 了 proc-identity.cjs，漏了它副本就
       *   ERR_MODULE_NOT_FOUND，坏实例起不来、反向对照成了空转。 */
      if (!/\.(mjs|cjs|js|json|html|css)$/.test(f)) continue;
      fs.copyFileSync(path.join(SERVER_DIR, f), path.join(dir, f));
    }
    /* ⚠ **子目录也要整个复制**：src/server/ 下有 cards/ 与 clients/ 两个子目录，
     *   漏掉 clients/ 的话副本的 server.mjs import "./clients/base.mjs" 会
     *   ERR_MODULE_NOT_FOUND —— 坏实例起不来，反向对照就成了空转。 */
    for (const sub of ["cards", "clients"]) {
      const from = path.join(SERVER_DIR, sub);
      if (!fs.existsSync(from)) continue;
      for (const f of fs.readdirSync(from)) {
        const p = path.join(from, f);
        if (fs.statSync(p).isDirectory()) continue;
        fs.copyFileSync(p, path.join(dir, sub, f));
      }
    }
    const gpath = path.join(dir, "gateway.mjs");
    const gsrc = fs.readFileSync(gpath, "utf8");
    const anchor = 'req.url = "/v1/messages" + (atQ >= 0 ? rawUrl.slice(atQ) : "");';
    assert.ok(gsrc.includes(anchor),
      "锚点对不上 —— 这条反向对照是假的（gateway.mjs 改了形状）");
    fs.writeFileSync(gpath, gsrc.replace(anchor, "/* SABOTAGE：URL 不换 */"), "utf8");

    /* 坏实例：自己的端口、自己的数据目录、自己的假上游。 */
    const ports = [];
    for (let i = 0; i < 4; i++) ports.push(await portInRange());
    const BP = { bai: ports[0], panel: ports[1], gateway: ports[2], sn: ports[3] };
    const bData = path.join(TMPROOT, "broken-data");
    fs.mkdirSync(bData, { recursive: true });
    const bcfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
    bcfg.failover = { ...(bcfg.failover || {}), enabled: false };
    bcfg.proxy = "http://127.0.0.1:7897";
    bcfg._modelsSynced = "dev";
    bcfg.relayPort = BP.bai; bcfg.panelPort = BP.panel; bcfg.gatewayPort = BP.gateway;
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
      bcfg[k] = { ...bcfg[k], relayPort: bcfg[k].relayPort };
      bcfg[k].upstream = `http://127.0.0.1:${upstream.address().port}`;
      bcfg[k].accessToken = ""; bcfg[k].refreshToken = ""; bcfg[k].apiKey = "";
      if (k === "or") bcfg[k].keys = [];
    }
    bcfg.sn.apiKey = TOK_SN;
    bcfg.sn.useProxy = false;
    bcfg.sn.defaultModel = SN_OPUS;
    bcfg.sn.availableModels = [SN_OPUS, SN_SONNET];
    bcfg.sn.mapping = {
      "claude-opus-5": { target: SN_OPUS, label: "档·Opus" },
      "claude-sonnet-5": { target: SN_SONNET, label: "档·Sonnet" },
    };
    fs.writeFileSync(path.join(bData, "config.json"), JSON.stringify(bcfg, null, 2), "utf8");

    const env = {
      ...process.env, BAI_DATA_DIR: bData, BAI_NO_PROXY_AUTODETECT: "1", BAI_ENV_FIXED: "1",
    };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    env.NO_PROXY = "127.0.0.1,localhost";
    const bchild = track(spawn(process.execPath, [path.join(dir, "server.mjs")], {
      env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }));
    const blog = [];
    bchild.stdout.on("data", (d) => blog.push(String(d)));
    bchild.stderr.on("data", (d) => blog.push(String(d)));
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 60000) {
      try { if ((await fetch(`http://127.0.0.1:${BP.panel}/api/status`).then((r) => r.json())).service?.up) { up = true; break; } }
      catch { }
      await sleep(300);
    }
    assert.ok(up, `坏实例没起来：${blog.join("").slice(-800)}`);

    /* 同一条请求，走坏实例：必须**不等价**（上游 404，而不是 Chat 应答）。 */
    const r = await fetch(`http://127.0.0.1:${BP.gateway}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "sn/claude-opus-5",
        messages: [{ role: "user", content: "北京天气？" }],
        max_tokens: 100,
      }),
      signal: AbortSignal.timeout(30000),
    }).then(async (x) => ({ status: x.status, text: await x.text() }));
    assert.notEqual(r.status, 200,
      `★ 改坏之后仍然 200 —— 那 ① 的判据是恒真的，测了个寂寞（实际 ${r.status}：${r.text.slice(0, 200)}）`);
    assert.match(r.text, /404|非 API 响应/,
      `坏实例应该报「上游 404」—— 实际：${r.text.slice(0, 200)}`);
  });
});
