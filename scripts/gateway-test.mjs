/**
 * T2 第一步：统一网关入口（magpie 形态：**一个端口**，模型 id 写成 provider/模型）
 *
 * ## 测什么
 *
 *   ★ ① parseGatewayModel：按**第一个** "/" 拆；provider 未知 / 没有前缀 → null
 *   ★ ② makeGatewayHandler：无前缀 → 400；未知 provider → 404；命中 → 模型段被剥出来
 *   ★ ③ **等价性对拍（本步的皇冠）**：同一个请求
 *        (a) 直接打 provider 自己的端口，模型给**档位名**（claude-opus-5）
 *        (b) 打统一网关，模型给 **provider/<该 provider 映射出来的真实模型名>**
 *      → **上游收到的请求体必须逐字相同**。
 *   ★ ④ 网关的错误应答说得清原因（400 说清「缺前缀」，404 说清「哪一家」）
 *   ★ ⑤ **反向对照**：把「模型已定稿就短路 resolveModel」改坏，等价性对拍**必须红**
 *
 * ## 怎么测的
 *
 *   ①② 是**纯逻辑**（直接 import src/server/gateway.mjs——server.mjs 一 import
 *   就起服务，只能这样测本体）。
 *   ③④⑤ 是**活体**：真 server.mjs 子进程 + 假上游（仓库里已有的套路，见
 *   scripts/model-truth-test.mjs 的 e2e 部分）。假上游把**收到的原始 body 字节**
 *   逐字记下来——「上游到底跑的是哪个模型」只认这份记录。
 *
 * ## 反向对照怎么做的
 *
 *   把整个 src/server 复制到临时目录，在**副本**的 server.mjs 上把短路那一行改坏
 *   （`if (req[GATEWAY_MODEL])` → `if (false)`），起一个「坏掉的」实例，
 *   重跑同一份等价性对拍 —— 必须**不再等价**。
 *   ⚠ 改的是**副本**，不碰仓库里的源码：所以不存在「测完忘了还原」这种事故。
 *   ⚠ 锚点对不上就**当场抛错**：手法与源码脱节时，这条对照就是假的，必须让它响。
 *
 * ## 红线
 *
 * 🔴 全文没有一个真实令牌/API key（夹具里的凭据形态串是明显假的占位串）。
 * 🔴 落盘只在 os.tmpdir() 下的临时目录 + BAI_DATA_DIR，**绝不碰真实的
 *    %APPDATA%\bai-router**；端口全部动态挑空闲（17xxx 段）。进程只按 **PID** 收。
 * 🔴 spawn 真 server.mjs 时一律 BAI_NO_PROXY_AUTODETECT=1（自动代理探测会自重启
 *    并掐断在途请求）。
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

import {
  parseGatewayModel, makeGatewayHandler, GATEWAY_MODEL, GATEWAY_BODY, KNOWN_PROVIDERS,
} from "../src/server/gateway.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER_DIR = path.join(REPO, "src", "server");
const SERVER = path.join(SERVER_DIR, "server.mjs");
const DEFAULTS_JSON = path.join(SERVER_DIR, "config.defaults.json");

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-gateway-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* 夹具里的模型名：全部带 test- 前缀，任何一条断言里出现它们都只可能来自本测试自己
 * 配的夹具，不可能与出厂默认值（sensenova-* / deepseek-* / hy* / space-bunny-*）混淆。 */
const FAKE_MODEL = "test-eq-model";      // 映射目标：provider 自己的真实模型名
const FAKE_DEFAULT = "test-eq-default";  // 出厂默认模型（回落落点）
const TIER = "claude-opus-5";            // 客户端送来的档位名

/* ====================================================================== *
 * ① parseGatewayModel（纯逻辑）
 * ====================================================================== */
describe("① parseGatewayModel：按第一个斜杠拆", () => {
  test("带前缀 → 拆对（provider 与 model 段都要对）", () => {
    assert.deepEqual(parseGatewayModel("sn/glm-5.2"), { provider: "sn", model: "glm-5.2" });
    assert.deepEqual(parseGatewayModel("bai/qwen3.8-flash"), { provider: "bai", model: "qwen3.8-flash" });
  });

  test("没有前缀 → null（不许把整串当模型名）", () => {
    assert.equal(parseGatewayModel("claude-opus-5"), null);
    assert.equal(parseGatewayModel("glm-5.2"), null);
  });

  test("provider 未知 → null（不猜：猜错就是把请求发给没点的公司）", () => {
    assert.equal(parseGatewayModel("nope/glm-5.2"), null);
    assert.equal(parseGatewayModel("foo/bar/baz"), null);
  });

  test("模型段里还有斜杠 → 只按**第一个**斜杠拆", () => {
    assert.deepEqual(parseGatewayModel("or/openai/gpt-4o"), { provider: "or", model: "openai/gpt-4o" });
    assert.deepEqual(parseGatewayModel("or/a/b/c"), { provider: "or", model: "a/b/c" });
  });

  test("空壳输入 → null（空串 / 只有斜杠 / 类型不对）", () => {
    assert.equal(parseGatewayModel(""), null);
    assert.equal(parseGatewayModel("/glm-5.2"), null);
    assert.equal(parseGatewayModel("sn/"), null);
    assert.equal(parseGatewayModel(undefined), null);
    assert.equal(parseGatewayModel(null), null);
    assert.equal(parseGatewayModel(123), null);
    assert.equal(parseGatewayModel({}), null);
  });

  test("已知渠道集合就是那 8 家（与 server.mjs 的 CHANNELS 对齐）", () => {
    assert.deepEqual([...KNOWN_PROVIDERS], ["bai", "sn", "wb", "wbai", "zen", "qd", "mm", "or"]);
  });
});

/* ====================================================================== *
 * ② makeGatewayHandler（纯逻辑：起一个本机 http server 打它）
 * ====================================================================== */
async function withGateway(handlers, isProvider, fn) {
  const srv = http.createServer(makeGatewayHandler({ handlers, isProvider }));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try { return await fn(port); } finally { await new Promise((r) => srv.close(r)); }
}
const postJson = (port, path_, obj) => fetch(`http://127.0.0.1:${port}${path_}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
  signal: AbortSignal.timeout(15000),
}).then(async (r) => {
  /* body 只能读一次：先读文本，再从文本里解析 JSON（直接 r.json() 会拿到空）。 */
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { }
  return { status: r.status, text, json };
});

describe("② makeGatewayHandler：分流与错误应答", () => {
  test("命中 → 模型段被剥出来写回请求体，handler 拿到的是**最终模型名**", async () => {
    const seen = [];
    await withGateway({
      sn: (req, res) => {
        seen.push({
          model: req[GATEWAY_MODEL],
          body: req[GATEWAY_BODY] ? req[GATEWAY_BODY].toString("utf8") : null,
          url: req.url,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
    }, undefined, async (port) => {
      const r = await postJson(port, "/v1/messages", { model: "sn/glm-5.2", max_tokens: 16, messages: [] });
      assert.equal(r.status, 200, `应当交给 provider 处理。实际 ${r.status}：${r.text.slice(0, 200)}`);
    });
    assert.equal(seen.length, 1, "provider 的 handler 必须被调用一次");
    assert.equal(seen[0].model, "glm-5.2", "标记里的模型名必须是剥掉前缀后的那一段");
    assert.equal(seen[0].url, "/v1/messages", "req 必须原样透传给 provider 的 handler");
    const body = JSON.parse(seen[0].body);
    assert.equal(body.model, "glm-5.2", "写回请求体的模型段必须是最终模型名（上游看到的就是它）");
    assert.equal(body.max_tokens, 16, "请求体的其余部分必须原样保留");
  });

  test("没有 provider 前缀 → 400，且错误信息说清原因", async () => {
    await withGateway({ sn: () => { throw new Error("不该被调用"); } }, undefined, async (port) => {
      const r = await postJson(port, "/v1/messages", { model: TIER, max_tokens: 16, messages: [] });
      assert.equal(r.status, 400, `实际 ${r.status}：${r.text.slice(0, 200)}`);
      assert.match(r.text, /provider/, "错误信息必须提到 provider 前缀这件事");
      assert.match(r.text, /claude-opus-5/, "错误信息必须把**收到的那个模型名**原样说出来");
      assert.equal(r.json?.type, "error", "错误应答必须是 Anthropic 规范形状");
    });
  });

  test("未知 provider → 404，且错误信息说清是哪一家", async () => {
    await withGateway({ sn: () => { throw new Error("不该被调用"); } }, undefined, async (port) => {
      const r = await postJson(port, "/v1/messages", { model: "nope/glm-5.2", max_tokens: 16, messages: [] });
      assert.equal(r.status, 404, `实际 ${r.status}：${r.text.slice(0, 200)}`);
      assert.match(r.text, /nope/, "错误信息必须点名是哪一家不认识");
    });
  });

  test("渠道认识但本实例没有它的处理器 → 404（不静默走老路）", async () => {
    await withGateway({}, () => true, async (port) => {
      const r = await postJson(port, "/v1/messages", { model: "sn/glm-5.2", max_tokens: 16, messages: [] });
      assert.equal(r.status, 404, `实际 ${r.status}：${r.text.slice(0, 200)}`);
      assert.match(r.text, /sn/, "错误信息必须点名是哪一家没有处理器");
    });
  });

  test("非 POST 的探测请求 → 405，说清网关只承接模型调用（而不是含糊的「请求体为空」）", async () => {
    await withGateway({ sn: () => { throw new Error("不该被调用"); } }, undefined, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { method: "GET" });
      const text = await r.text();
      assert.equal(r.status, 405, `实际 ${r.status}：${text.slice(0, 200)}`);
      assert.match(text, /POST/, "错误信息必须说清网关只承接 POST 模型调用");
    });
  });

  test("请求体不是 JSON / 没有 model 字段 → 400，说清实际收到了什么", async () => {
    await withGateway({ sn: () => { throw new Error("不该被调用"); } }, undefined, async (port) => {
      const r1 = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "not json",
      }).then(async (x) => ({ status: x.status, text: await x.text() }));
      assert.equal(r1.status, 400, `实际 ${r1.status}：${r1.text.slice(0, 200)}`);
      const r2 = await postJson(port, "/v1/messages", { max_tokens: 16, messages: [] });
      assert.equal(r2.status, 400, `实际 ${r2.status}：${r2.text.slice(0, 200)}`);
      assert.match(r2.text, /model/, "错误信息必须说清缺的是 model 字段");
    });
  });
});

/* ====================================================================== *
 * ③ 活体：真 server.mjs 子进程 + 假上游
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

/** 假上游：把**收到的原始 body 字节**逐字记下来。
 *  一切断言都从这份记录取证——「上游到底跑的是哪个模型」只认它。 */
async function startFakeUpstream(hits) {
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let model = null;
      try { model = JSON.parse(raw).model; } catch { }
      hits.push({ url: String(rq.url || ""), raw, model });
      rs.writeHead(200, { "content-type": "application/json" });
      rs.end(JSON.stringify({
        id: "msg_test", type: "message", role: "assistant", model: model || "test-echo",
        content: [{ type: "text", text: "OK" }], stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return srv;
}

/** 起一个真 server.mjs 子进程（临时 BAI_DATA_DIR + 17xxx 隔离端口）。
 *  `entry` 可以是仓库里的 server.mjs，也可以是「改坏过」的副本（反向对照用）。 */
async function startServer({ entry, dataDir, P, upstreamPort }) {
  const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
  cfg.failover.enabled = false;
  /* 预置成探测必选中的值，否则服务启动时 applyProxy 自重启（exit(0)）把本进程带走 */
  cfg.proxy = "http://127.0.0.1:7897";
  /* 模型同步已做过的标记：免得服务启动后回写 config.json（回写会让「配置一次写对」
     这条前提在测试期间失效）。与本测试无关，只为确定性。 */
  cfg._modelsSynced = "dev";
  cfg.relayPort = P.bai; cfg.panelPort = P.panel; cfg.gatewayPort = P.gateway;
  /* bai（扁平的那家）：映射表与可用清单都在顶层。
     ⚠ 故意**不**把 FAKE_MODEL 放进 availableModels —— 那样 resolveModel 会直接命中它，
     「模型已定稿」与「再解析一次」就分不出高下，等价性对拍会变成恒真断言。 */
  cfg.upstream = `http://127.0.0.1:${upstreamPort}`;
  cfg.mapping = { [TIER]: { target: FAKE_MODEL, label: "档·Opus" } };
  cfg.availableModels = [FAKE_DEFAULT];
  cfg.defaultModel = FAKE_DEFAULT;
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
    cfg[k] = { ...cfg[k], relayPort: P[k] };
    /* 其他渠道一律空凭据 + 指到同一个假上游：启动期的目录同步只会拿到 404，
       不会碰到真实网络，也不会改写我们夹在下面的那份映射。
       ⚠ mm 也要在内：它的上游是**真的** agent.minimax.cn，不改就会打到真网络。 */
    cfg[k].upstream = `http://127.0.0.1:${upstreamPort}`;
    cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
    if (k === "or") cfg[k].keys = [];
  }
  /* sn（我们做等价性对拍的那家）：映射目标与 bai 一样，形状一样 */
  cfg.sn.mapping = { [TIER]: { target: FAKE_MODEL, label: "档·Opus" } };
  cfg.sn.availableModels = [FAKE_DEFAULT];
  cfg.sn.defaultModel = FAKE_DEFAULT;
  cfg.sn.useProxy = false;

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2));

  const env = { ...process.env, BAI_DATA_DIR: dataDir, NODE_USE_ENV_PROXY: "1", BAI_ENV_FIXED: "1", BAI_NO_PROXY_AUTODETECT: "1" };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
  env.NO_PROXY = "127.0.0.1,localhost";
  const child = track(spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  const out = []; child.stdout.on("data", (d) => out.push(String(d))); child.stderr.resume();
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) return { child, stdout: () => out.join("") }; }
    catch { }
    await sleep(300);
  }
  throw new Error(`server.mjs 60 秒内没起来。stdout 尾：${out.join("").slice(-800)}`);
}

const askRelay = (port, model) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model, max_tokens: 1024, stream: false, system: "You are Claude Code.",
    messages: [{ role: "user", content: "等价性对拍" }],
  }),
  signal: AbortSignal.timeout(60000),
}).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ status: 0, text: String((e && e.message) || e) }));

/* 造一份「改坏短路」的 server.mjs 副本：整份 src/server 复制到临时目录再改。
 * ⚠ 改的是**副本**——仓库里的源码一个字节都不动，所以不存在「测完忘了还原」。 */
function makeSabotagedServer() {
  const dir = fs.mkdtempSync(path.join(TMPROOT, "sabotage-"));
  const dst = path.join(dir, "server");
  fs.cpSync(SERVER_DIR, dst, { recursive: true });
  const file = path.join(dst, "server.mjs");
  const src = fs.readFileSync(file, "utf8");
  const ANCHOR = "if (req[GATEWAY_MODEL]) {";
  if (!src.includes(ANCHOR)) {
    throw new Error(`反向对照的锚点对不上源码了（找不到「${ANCHOR}」）——手法与源码脱节，这条对照就是假的`);
  }
  fs.writeFileSync(file, src.replace(ANCHOR, "if (false) { /* SABOTAGE: 短路被改坏 */"));
  return file;
}

/* 起一套「真 server.mjs + 假上游」，供一个 describe 里的多条测试共用
 * （起一次服务要好几秒，共用才跑得完）。 */
async function startScenario({ entry, tag }) {
  const ports = await portsInRange(10);
  const P = { bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4], qd: ports[5], or: ports[6], mm: ports[7], panel: ports[8], gateway: ports[9] };
  const hits = [];
  const upstream = await startFakeUpstream(hits);
  const dataDir = path.join(TMPROOT, `data-${tag}`);
  const server = await startServer({ entry, dataDir, P, upstreamPort: upstream.address().port });
  return {
    P, hits,
    stdout: server.stdout(),
    stop: () => { try { upstream.close(); } catch { } killAll(); },
  };
}

/** 打一次请求，并取回**这一次**在上游留下的记录（清空 hits 后只看最后一条）。 */
async function measure(scenario, port, model) {
  scenario.hits.length = 0;
  const res = await askRelay(port, model);
  const hit = scenario.hits[scenario.hits.length - 1] || null;
  return { res, hit };
}

describe("③ 活体：统一网关与旧中转端口逐字等价", () => {
  let S;
  before(async () => { S = await startScenario({ entry: SERVER, tag: "live" }); }, { timeout: 120000 });
  after(() => { try { S && S.stop(); } catch { } });

  test("★ 等价性对拍：(a) 直连端口给档位名 vs (b) 网关给 provider/真实模型名 —— 上游收到的请求体逐字相同", async () => {
    /* (a) 直连 provider 自己的端口，模型给**档位名** */
    const a = await measure(S, S.P.sn, TIER);
    /* (b) 打统一网关，模型给 **provider/<该 provider 映射出来的真实模型名>** */
    const b = await measure(S, S.P.gateway, `sn/${FAKE_MODEL}`);

    assert.equal(a.res.status, 200, `(a) 直连路径必须成功。实际 ${a.res.status}：${a.res.text.slice(0, 200)}`);
    assert.equal(b.res.status, 200, `(b) 网关路径必须成功。实际 ${b.res.status}：${b.res.text.slice(0, 200)}`);
    assert.ok(a.hit && a.hit.url.includes("/v1/messages"), `(a) 必须真的打到上游。实际 ${JSON.stringify(a.hit)}`);
    assert.ok(b.hit && b.hit.url.includes("/v1/messages"), `(b) 必须真的打到上游。实际 ${JSON.stringify(b.hit)}`);

    /* ★ 两条路径各自的上游请求体必须**逐字相同**（不是「语义相同」，是字节相同）。 */
    assert.equal(b.hit.raw, a.hit.raw,
      `★ 上游收到的请求体必须逐字相同。\n(a)=${a.hit.raw}\n(b)=${b.hit.raw}`);
    /* 并且模型名确实落到了映射目标上（不是碰巧相同）。 */
    assert.equal(a.hit.model, FAKE_MODEL, `(a) 上游必须收到映射目标。实际 ${a.hit.model}`);
    assert.equal(b.hit.model, FAKE_MODEL, `(b) 上游必须收到同一个模型名。实际 ${b.hit.model}`);
    /* 客户端看到的响应也必须一致。 */
    assert.equal(b.res.text, a.res.text, "★ 两条路径给客户端的响应也必须逐字相同");
  }, { timeout: 180000 });

  test("★ 网关没有污染旧端口：直连路径仍然按映射解析档位名（短路只对网关生效）", async () => {
    const a = await measure(S, S.P.sn, TIER);
    assert.equal(a.res.status, 200, `直连路径必须成功。实际 ${a.res.status}：${a.res.text.slice(0, 200)}`);
    assert.equal(a.hit.model, FAKE_MODEL,
      `★ 旧端口必须照旧把档位名解析成映射目标。实际 ${a.hit.model}`);
    assert.equal(a.hit.raw.includes(TIER), false,
      "★ 旧端口绝不能把档位名原样发给上游（那说明 resolveModel 被绕过了）");
    assert.equal(a.hit.raw.includes("sn/"), false,
      "★ 旧端口绝不能把 provider 前缀发给上游（那说明网关的改写漏进了旧路径）");
  }, { timeout: 180000 });

  test("★ 网关收到没有 provider 前缀的模型 → 400，且说清原因", async () => {
    const r = await askRelay(S.P.gateway, TIER);
    assert.equal(r.status, 400, `实际 ${r.status}：${r.text.slice(0, 300)}`);
    assert.match(r.text, /provider/, "错误信息必须说清缺的是 provider 前缀");
    assert.match(r.text, new RegExp(TIER), "错误信息必须把收到的模型名原样说出来");
  }, { timeout: 180000 });

  test("★ 网关收到未知 provider → 404，且说清是哪一家", async () => {
    const r = await askRelay(S.P.gateway, "nope/glm-5.2");
    assert.equal(r.status, 404, `实际 ${r.status}：${r.text.slice(0, 300)}`);
    assert.match(r.text, /nope/, "错误信息必须点名是哪一家不认识");
  }, { timeout: 180000 });

  test("★ 小版本降级：客户端送 claude-opus-5-5 → 上游仍收到映射目标（不是默认模型）", async () => {
    /* 2026-10-22 从中转日志里查出来的真问题：客户端送来的 id 带**小版本**
     * （claude-opus-5-5），而映射表的 key 是**档位名**（claude-opus-5）。
     * 差最后一段就查不到 → 静默落回本渠道默认模型 → 用户点 opus、跑的是默认那个。
     * 实测日志里 claude-opus-5-5 出现过 7 次，全是回落。 */
    const a = await measure(S, S.P.sn, "claude-opus-5-5");
    assert.equal(a.res.status, 200, `直连路径必须成功。实际 ${a.res.status}：${a.res.text.slice(0, 200)}`);
    assert.equal(a.hit.model, FAKE_MODEL,
      `★ 直连路径必须把 claude-opus-5-5 解析成映射目标。实际 ${a.hit.model}`);
    assert.notEqual(a.hit.model, FAKE_DEFAULT,
      "★ 落回默认模型就是「用户点 opus、跑的是默认那个」——那条静默回落");

    /* 网关路径同理：sn/claude-opus-5-5 必须照样打到映射目标，
       而不是把 claude-opus-5-5 原样发给上游（上游压根没有这个模型名 → 400）。 */
    const b = await measure(S, S.P.gateway, "sn/claude-opus-5-5");
    assert.equal(b.res.status, 200, `网关路径必须成功。实际 ${b.res.status}：${b.res.text.slice(0, 200)}`);
    assert.equal(b.hit.model, FAKE_MODEL,
      `★ 网关路径也必须解析成映射目标。实际 ${b.hit.model}`);
    assert.equal(b.hit.raw, a.hit.raw,
      "★ 两条路径的上游请求体必须逐字相同（降级后它们本该是同一个请求）");
  }, { timeout: 180000 });
});

/* ====================================================================== *
 * ⑤ 反向对照：把短路改坏 → 等价性对拍必须红
 * ====================================================================== */
describe("⑤ 反向对照：改坏「模型已定稿就短路 resolveModel」", () => {
  let S;
  before(async () => {
    const bad = makeSabotagedServer();
    S = await startScenario({ entry: bad, tag: "sabotage" });
  }, { timeout: 120000 });
  after(() => { try { S && S.stop(); } catch { } });

  test("★ 改坏之后等价性对拍必须红（否则这条断言是恒真的）", async () => {
    const a = await measure(S, S.P.sn, TIER);
    const b = await measure(S, S.P.gateway, `sn/${FAKE_MODEL}`);

    assert.equal(a.res.status, 200, `(a) 直连路径必须成功。实际 ${a.res.status}：${a.res.text.slice(0, 200)}`);
    assert.equal(b.res.status, 200, `(b) 网关路径也必须成功（改坏的只是模型解析，不是整条链）。实际 ${b.res.status}：${b.res.text.slice(0, 200)}`);
    assert.ok(a.hit && b.hit, "两条路径都必须真的打到上游，否则下面那句「不等价」没有意义");

    /* ★ 改坏之后两条路径**不再等价**：网关路径把「最终模型名」又拿去查档位表，
     * 查不到 → 静默回落到本渠道的默认模型。这正是那条短路要防的事。 */
    assert.notEqual(b.hit.raw, a.hit.raw,
      "★ 改坏之后两条路径必须不再等价（若仍相等，说明等价性对拍根本没在看模型名，是恒真断言）");
    assert.equal(b.hit.model, FAKE_DEFAULT,
      `★ 改坏之后网关路径应当回落到默认模型。实际 ${b.hit.model}`);
    assert.equal(a.hit.model, FAKE_MODEL,
      `★ 直连路径不受影响（它没有网关标记）。实际 ${a.hit.model}`);
  }, { timeout: 180000 });
});
