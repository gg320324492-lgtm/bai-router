/* 代码插件运行时（pluginrt.mjs）的**接线**用例：装得上、改得动、拒得掉、坏了不连累。
 *
 * ── 这份测试在守什么 ──
 *
 * pluginrt.mjs 是**宿主那一半**（清单校验、权限模型、子进程、协议、超时）。
 * 它的纯逻辑部分由 scripts/pluginrt-test.mjs 守着（反向对照在那边）。
 * 这份守的是**接线**：runtime 真的被装上了、插件真的改到了发往上游的请求体、
 * 插件真的能拒绝、插件坏了用户还能正常用。
 *
 * 接线是最容易漏的地方：模块全绿、协议全对，而**没接进请求路径**，
 * 于是「插件装上了却什么也没发生」—— 用户看到的是「这功能没用」。
 *
 * ── 三条红线 ──
 *   🔴 全文没有一个真实令牌（夹具里的凭据是明显假的占位串）。
 *   🔴 落盘只在 os.tmpdir() + BAI_DATA_DIR，**绝不碰真实的 %APPDATA%\bai-router**。
 *   🔴 端口全部动态挑空闲且落在 17xxx 段；进程只按 **PID** 收。
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

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-codeplugin-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* 夹具：上游会收到什么模型名。带 test- 前缀，混淆不了真模型。 */
const FAKE_MODEL = "test-cp-model";
const FAKE_DEFAULT = "test-cp-default";
const TIER = "claude-opus-5";

/* ---------- 端口 ---------- */
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

/* ---------- 假上游：把收到的原始 body 逐字记下来 ---------- */
async function startFakeUpstream(hits) {
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let model = null, maxTokens = null;
      try { const j = JSON.parse(raw); model = j.model; maxTokens = j.max_tokens; } catch { }
      hits.push({ url: String(rq.url || ""), raw, model, maxTokens });
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

/* ---------- 插件夹具 ---------- */
/** 写一个代码插件到 <dataDir>/code-plugins/<id>/。 */
function writePlugin(dataDir, id, manifest, source) {
  const dir = path.join(dataDir, "code-plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(path.join(dir, "main.mjs"), source, "utf8");
  return dir;
}

const manifestOf = (id, extra = {}) => ({
  manifestVersion: 1,
  id,
  name: `插件·${id}`,
  entry: "main.mjs",
  timeoutMs: 800,
  permissions: { fsRead: [], net: false },
  ...extra,
});

/* ---------- 起一套真 server.mjs ---------- */
const procs = new Set();
function track(p) { procs.add(p); p.on("exit", () => procs.delete(p)); return p; }
function killAll() {
  for (const p of procs) {
    try { if (p.pid) spawnSync("taskkill", ["/PID", String(p.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch { }
    try { p.kill(); } catch { }
  }
  procs.clear();
}

async function startServer({ entry, dataDir, P, upstreamPort }) {
  const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
  cfg.failover = { ...(cfg.failover || {}), enabled: false };
  /* 预置成探测必选中的值，否则服务启动时 applyProxy 自重启（exit(0)）把本进程带走 */
  cfg.proxy = "http://127.0.0.1:7897";
  cfg._modelsSynced = "dev";
  cfg.relayPort = P.bai; cfg.panelPort = P.panel; cfg.gatewayPort = P.gateway;
  cfg.upstream = `http://127.0.0.1:${upstreamPort}`;
  cfg.mapping = { [TIER]: { target: FAKE_MODEL, label: "档·Opus" } };
  cfg.availableModels = [FAKE_DEFAULT];
  cfg.defaultModel = FAKE_DEFAULT;
  cfg.apiKey = "sk-test-fake";
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
    cfg[k] = { ...cfg[k], relayPort: P[k] };
    cfg[k].upstream = `http://127.0.0.1:${upstreamPort}`;
    cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
    if (k === "or") cfg[k].keys = [];
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");

  const env = { ...process.env, BAI_DATA_DIR: dataDir, BAI_NO_PROXY_AUTODETECT: "1", BAI_ENV_FIXED: "1" };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
  env.NO_PROXY = "127.0.0.1,localhost";
  const child = track(spawn(process.execPath, [entry || SERVER], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
  const out = [];
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try { if ((await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json())).service?.up) return { child, log: () => out.join("") }; }
    catch { }
    await sleep(300);
  }
  throw new Error(`server.mjs 60 秒内没起来。日志尾：${out.join("").slice(-800)}`);
}

const askRelay = (port, model) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model, max_tokens: 1024, stream: false, system: "You are Claude Code.",
    messages: [{ role: "user", content: "代码插件用例" }],
  }),
  signal: AbortSignal.timeout(30000),
}).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ status: 0, text: String((e && e.message) || e) }));

/**
 * 显式重载插件并等它装完。
 *
 * ⚠ 为什么必须显式：插件是**启动后异步**装的（onActivated 里 fire-and-forget，
 *   因为装插件要起子进程，卡住启动不划算）。所以「服务起来了」**不等于**
 *   「插件装好了」—— 两者之间有个几百毫秒的窗口。
 *   靠 sleep 赌窗口 =  flaky 测试；显式重载并 await = 确定性。
 */
async function reloadPlugins(P, expectIds) {
  const r = await fetch(`http://127.0.0.1:${P.panel}/api/code-plugins/reload`, { method: "POST" })
    .then((x) => x.json());
  assert.equal(r.ok, true, `重载插件失败：${JSON.stringify(r)}`);
  for (const id of expectIds || []) {
    assert.ok((r.installed || []).includes(id),
      `插件「${id}」没装上：${JSON.stringify(r)}`);
  }
  return r;
}

/* ====================================================================== *
 * ① 装得上 + 改得动
 * ====================================================================== */
describe("① 代码插件：装上，并且真的改到了发往上游的请求", () => {
  let S, dataDir;
  before(async () => {
    dataDir = path.join(TMPROOT, "data-modify");
    const ports = [];
    for (let i = 0; i < 10; i++) ports.push(await portInRange());
    const P = {
      bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4],
      qd: ports[5], or: ports[6], mm: ports[7], panel: ports[8], gateway: ports[9],
    };
    const hits = [];
    const upstream = await startFakeUpstream(hits);
    /* 一个改 max_tokens 的插件：档位对上就改成 7。 */
    writePlugin(dataDir, "demo", manifestOf("demo"), [
      "export default function (request, api) {",
      "  api.log('看到 ' + request.channel + ' 的 ' + request.model);",
      `  if (request.tier !== ${JSON.stringify(TIER)}) return { action: "allow" };`,
      "  return { action: 'modify', params: { max_tokens: 7 } };",
      "}",
    ].join("\n"));
    const server = await startServer({ dataDir, P, upstreamPort: upstream.address().port });
    S = { P, hits, server, stop: () => { try { upstream.close(); } catch { } killAll(); } };
    await reloadPlugins(P, ["demo"]);
  }, { timeout: 120000 });
  after(() => { try { S && S.stop(); } catch { } });

  test("★ GET /api/code-plugins 看得见装上的插件与它要什么权限", async () => {
    const r = await fetch(`http://127.0.0.1:${S.P.panel}/api/code-plugins`).then((x) => x.json());
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.list), "list 必须是数组");
    const one = r.list.find((x) => x.id === "demo");
    assert.ok(one, `装上的插件没出现在列表里：${JSON.stringify(r.list)}`);
    assert.equal(one.status, "active", `插件状态不对：${JSON.stringify(one)}`);
    assert.ok(one.permissions, "必须报出它要什么权限（用户看得见才敢让它跑）");
  });

  test("★ 插件的改写真的落到了上游（max_tokens 从 1024 变成 7）", async () => {
    S.hits.length = 0;
    const res = await askRelay(S.P.bai, TIER);
    assert.equal(res.status, 200, `请求必须成功。实际 ${res.status}：${res.text.slice(0, 200)}`);
    const hit = S.hits[S.hits.length - 1];
    assert.ok(hit, "必须真的打到上游");
    assert.equal(hit.maxTokens, 7,
      `★ 插件改的参数没到上游。实际 max_tokens=${hit.maxTokens}，原始 body=${hit.raw}`);
    assert.equal(hit.model, FAKE_MODEL, "档位照旧解析成本家的模型（插件不该动模型名）");
  });

  test("★ 档位对不上时插件放行（请求照旧成功，上游拿到原样的 max_tokens）", async () => {
    S.hits.length = 0;
    const res = await askRelay(S.P.bai, FAKE_DEFAULT);
    assert.equal(res.status, 200);
    const hit = S.hits[S.hits.length - 1];
    assert.equal(hit.maxTokens, 1024,
      `档位对不上时不该改。实际 max_tokens=${hit.maxTokens}`);
  });
});

/* ====================================================================== *
 * ② 拒得掉 + 坏了不连累
 * ====================================================================== */
describe("② 代码插件：能拒绝；插件坏了不许连累正常请求", () => {
  let S, dataDir;
  before(async () => {
    dataDir = path.join(TMPROOT, "data-deny");
    const ports = [];
    for (let i = 0; i < 10; i++) ports.push(await portInRange());
    const P = {
      bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4],
      qd: ports[5], or: ports[6], mm: ports[7], panel: ports[8], gateway: ports[9],
    };
    const hits = [];
    const upstream = await startFakeUpstream(hits);
    /* 一个拒绝的插件 + 一个会抛异常的插件（后者不许连累请求）。 */
    writePlugin(dataDir, "denier", manifestOf("denier"), [
      "export default function () {",
      "  return { action: 'deny', reason: '这条请求不该走这家' };",
      "}",
    ].join("\n"));
    writePlugin(dataDir, "boom", manifestOf("boom"), [
      "export default function () {",
      "  throw new Error('插件自己炸了');",
      "}",
    ].join("\n"));
    const server = await startServer({ dataDir, P, upstreamPort: upstream.address().port });
    S = { P, hits, server, stop: () => { try { upstream.close(); } catch { } killAll(); } };
    await reloadPlugins(P, ["denier", "boom"]);
  }, { timeout: 120000 });
  after(() => { try { S && S.stop(); } catch { } });

  test("★ 插件拒绝 → 请求明确失败（403），并说清是谁拒的、为什么", async () => {
    S.hits.length = 0;
    const res = await askRelay(S.P.bai, TIER);
    assert.equal(res.status, 403, `实际 ${res.status}：${res.text.slice(0, 300)}`);
    assert.match(res.text, /这条请求不该走这家/, "必须把插件给的人话原样带出来");
    assert.equal(S.hits.length, 0, "被拒绝的请求不许发到上游");
  });

  test("★ 插件自己炸了 → 请求照常成功（fail open）", async () => {
    /* ⚠ 顺序：denier 也装着，所以这条得先把 denier 停掉，只留会炸的那个。 */
    const rm = await fetch(`http://127.0.0.1:${S.P.panel}/api/code-plugins/remove`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "denier" }),
    });
    assert.equal(rm.status, 200, `停掉 denier 失败：${rm.status}`);
    S.hits.length = 0;
    const res = await askRelay(S.P.bai, TIER);
    assert.equal(res.status, 200,
      `插件炸了不该让用户的正常请求失败。实际 ${res.status}：${res.text.slice(0, 300)}`);
    const hit = S.hits[S.hits.length - 1];
    assert.ok(hit, "请求必须真的打到上游");
    assert.equal(hit.model, FAKE_MODEL);
  });
});

/* ====================================================================== *
 * ③ 反向对照：把「deny 就地结束」改坏 → 拒绝那条断言必须红
 * ====================================================================== */
/**
 * 造一个「改坏过」的 server.mjs 副本：整份 src/server 复制到临时目录再改。
 * ⚠ 改的是**副本** —— 仓库里的源码一个字节都不动，所以不存在「测完忘了还原」。
 */
function makeSabotagedServer() {
  const dir = fs.mkdtempSync(path.join(TMPROOT, "sabotage-"));
  const dst = path.join(dir, "server");
  fs.cpSync(path.join(REPO, "src", "server"), dst, { recursive: true });
  const file = path.join(dst, "server.mjs");
  const src = fs.readFileSync(file, "utf8");
  const ANCHOR = "if (cp.denied) {";
  if (!src.includes(ANCHOR)) {
    throw new Error(`反向对照的锚点对不上源码了（找不到「${ANCHOR}」）——手法与源码脱节，这条对照就是假的`);
  }
  fs.writeFileSync(file, src.replace(ANCHOR, "if (false) { /* SABOTAGE: deny 不再中止 */"), "utf8");
  return file;
}

describe("③ 反向对照：改坏「deny 就地结束」，拒绝那条必须红", () => {
  let S;
  before(async () => {
    const dataDir = path.join(TMPROOT, "data-sabotage");
    const ports = [];
    for (let i = 0; i < 10; i++) ports.push(await portInRange());
    const P = {
      bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4],
      qd: ports[5], or: ports[6], mm: ports[7], panel: ports[8], gateway: ports[9],
    };
    const hits = [];
    const upstream = await startFakeUpstream(hits);
    writePlugin(dataDir, "denier", manifestOf("denier"), [
      "export default function () {",
      "  return { action: 'deny', reason: '这条请求不该走这家' };",
      "}",
    ].join("\n"));
    const bad = makeSabotagedServer();
    const server = await startServer({ entry: bad, dataDir, P, upstreamPort: upstream.address().port });
    S = { P, hits, server, stop: () => { try { upstream.close(); } catch { } killAll(); } };
    await reloadPlugins(P, ["denier"]);
  }, { timeout: 120000 });
  after(() => { try { S && S.stop(); } catch { } });

  test("★ 改坏之后请求不再被拒（否则上面那条断言是恒真的）", async () => {
    S.hits.length = 0;
    const res = await askRelay(S.P.bai, TIER);
    assert.notEqual(res.status, 403,
      "改坏之后 deny 仍然拦住了 —— 那「deny 会拦住请求」这条断言是恒真的");
    assert.equal(res.status, 200,
      `改坏之后请求应当照常通过。实际 ${res.status}：${res.text.slice(0, 200)}`);
    assert.equal(S.hits.length, 1, "改坏之后请求真的发到了上游");
  });
});
