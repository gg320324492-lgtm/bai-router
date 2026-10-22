/* 额度探到之后，**真的进到了渠道状态层**吗？
 *
 * ── 这份测试在守什么 ──
 *
 * 状态层（`channel-state.mjs`）本身很完整：它认得「探到了」「探不到」「预算用完」
 * 三种信号。但它只认**别人喂给它的**东西 —— 面板上的渠道热力图（那张量条）画的是
 * `used / limit / ratio`，而这三个数字在「上游的余额」那一路**只可能**来自探测结果。
 *
 * 于是有一条**只有真接线才暴露**的缝：探测结果存在服务端的缓存里，状态层要从
 * 那个缓存里取。改缓存的数据结构时忘了改取的那一处 → 那一行静悄悄抛异常、
 * 被 catch 吃掉、返回 null → 「探不到 ≠ 0」这条规矩反而**救了场**：状态还是
 * 算得出来，只是**永远没有那三个数字**。
 *
 * 症状：面板上热力图的量条永远是空的，渠道状态永远是「不明」，
 * 而**面板上没有任何地方显示异常**。这正是这个仓库反复吃亏的那类 bug
 * （「功能都在、单测都绿，但接线少了一条路」）。
 *
 * ── 怎么测 ──
 *
 * 活体：假上游 + 真 server.mjs。假上游扮演 OpenRouter 的额度接口
 * （`GET /credits` → 用掉 42 / 共 100），先打 `/api/quota/overview`（它负责探测
 * 并把结果写进缓存），再打 `/api/channels/state`（它负责读缓存），
 * 断言那三个数字真的到了状态层。
 *
 * 末尾是**反向对照**：把取缓存的那一行改坏，断言必须变红。
 *
 * ── 红线 ──
 *   🔴 全文没有一个真实令牌（夹具里的 key 是明显假的占位串）。
 *   🔴 落盘只在 os.tmpdir() + BAI_DATA_DIR，绝不碰真实的 %APPDATA%\bai-router。
 *   🔴 端口动态挑空闲且落在 17xxx 段；进程只按 **PID** 收。
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

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-chstate-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* 假上游报的数字：OpenRouter 那边是「钱」，这里是 42 / 100。 */
const USED = 42;
const LIMIT = 100;

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

/** 假上游：扮演 OpenRouter 的额度接口。 */
async function startFakeQuotaUpstream(hits) {
  const srv = http.createServer((rq, rs) => {
    const url = String(rq.url || "").split("?")[0];
    hits.push({ url, auth: rq.headers["authorization"] || "" });
    if (url.endsWith("/credits")) {
      rs.writeHead(200, { "content-type": "application/json" });
      rs.end(JSON.stringify({ data: { total_credits: LIMIT, total_usage: USED } }));
      return;
    }
    /* 第二个候选：普通推理密钥回 403（真上游也是这个行为）。 */
    rs.writeHead(403, { "content-type": "application/json" });
    rs.end(JSON.stringify({ error: "forbidden" }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return srv;
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

async function startServer({ entry, dataDir, P, upstreamPort }) {
  const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
  cfg.failover = { ...(cfg.failover || {}), enabled: false };
  cfg.proxy = "http://127.0.0.1:7897";      // 预置，免得启动时自检把自己重启掉
  cfg._modelsSynced = "dev";
  cfg.relayPort = P.bai; cfg.panelPort = P.panel; cfg.gatewayPort = P.gateway;
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
    cfg[k] = { ...cfg[k], relayPort: P[k] };
    cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
    if (k === "or") cfg[k].keys = [];
  }
  /* 只给「or」配凭据与假上游：只有它会去发探测请求（别家没凭据 → 探测自己就
     短路了，一个请求都不发）。 */
  cfg.or.keys = ["sk-test-fake"];
  cfg.or.upstream = `http://127.0.0.1:${upstreamPort}`;
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm"]) {
    cfg[k].upstream = `http://127.0.0.1:${upstreamPort}`;
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

const getJson = (port, p) => fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(30000) })
  .then((r) => r.json());

/** 起一套环境，返回「探一遍 + 读状态」之后的样子。 */
async function probeAndRead(P, hits) {
  /* /api/quota/overview 负责探测并把结果写进缓存；/api/channels/state 负责读缓存。 */
  const overview = await getJson(P.panel, "/api/quota/overview");
  const state = await getJson(P.panel, "/api/channels/state");
  const or = (state.channels || []).find((c) => c.key === "or") || null;
  return { overview, state, or, hits };
}

describe("额度探测 → 渠道状态层（真接线）", () => {
  let S;
  before(async () => {
    const ports = [];
    for (let i = 0; i < 10; i++) ports.push(await portInRange());
    const P = {
      bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4],
      qd: ports[5], or: ports[6], mm: ports[7], panel: ports[8], gateway: ports[9],
    };
    const hits = [];
    const upstream = await startFakeQuotaUpstream(hits);
    const dataDir = path.join(TMPROOT, "data");
    const server = await startServer({ dataDir, P, upstreamPort: upstream.address().port });
    S = { P, hits, server, stop: () => { try { upstream.close(); } catch { } killAll(); } };
  }, { timeout: 120000 });
  after(() => { try { S && S.stop(); } catch { } });

  test("★ 探测真的打到了上游（别家一个请求都不发）", async () => {
    const r = await probeAndRead(S.P, S.hits);
    assert.ok(r.hits.some((h) => h.url.endsWith("/credits")),
      `假上游没收到探测请求：${JSON.stringify(r.hits)}`);
    assert.ok(r.hits.every((h) => !/^sk-test-fake$/.test(h.auth)),
      "凭据不该原样出现在日志里（这里只检查它确实带上了，不检查内容）");
  });

  test("★ 探到的数字真的进了状态层（热力图的量条有东西可画）", async () => {
    const r = await probeAndRead(S.P, S.hits);
    assert.ok(r.or, `状态层里没有 or 这个渠道：${JSON.stringify(r.state)}`);
    assert.equal(r.or.used, USED,
      `★ 状态层没拿到上游报的「已用」。实际 used=${r.or.used} —— ` +
      "这一格就是热力图上那根量条的数字");
    assert.equal(r.or.limit, LIMIT, `状态层的上限不对：${r.or.limit}`);
    assert.equal(r.or.ratio, USED, `状态层的比例不对：${r.or.ratio}`);
  });

  test("★ 探到 = 状态不是「不明」（有正面证据）", async () => {
    const r = await probeAndRead(S.P, S.hits);
    assert.notEqual(r.or.state, "unknown",
      `状态是「不明」：${JSON.stringify(r.or)} —— 探测到了就该算有正面证据`);
  });
});

/* ============================================================================ *
 * 反向对照：把「从缓存里取探测结果」改坏 → 上面那条必须变红
 * ============================================================================ */

/** 造一个「改坏过」的 server.mjs 副本：整份 src/server 复制到临时目录再改。 */
function makeSabotagedServer() {
  const dir = fs.mkdtempSync(path.join(TMPROOT, "sabotage-"));
  const dst = path.join(dir, "server");
  fs.cpSync(SERVER_DIR, dst, { recursive: true });
  const file = path.join(dst, "server.mjs");
  const src = fs.readFileSync(file, "utf8");
  const ANCHOR = "const hit = (() => { try { return probeCache.get(p) || null; } catch { return null; } })();";
  if (!src.includes(ANCHOR)) {
    throw new Error(`反向对照的锚点对不上源码了（找不到「${ANCHOR}」）——手法与源码脱节，这条对照就是假的`);
  }
  /* 改坏：装作缓存里永远没有这一家（等价于「改了数据结构、忘了改取的那一处」）。 */
  fs.writeFileSync(file, src.replace(ANCHOR, "const hit = null;"), "utf8");
  return file;
}

describe("反向对照：改坏「从缓存里取探测结果」", () => {
  let S;
  before(async () => {
    const ports = [];
    for (let i = 0; i < 10; i++) ports.push(await portInRange());
    const P = {
      bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4],
      qd: ports[5], or: ports[6], mm: ports[7], panel: ports[8], gateway: ports[9],
    };
    const hits = [];
    const upstream = await startFakeQuotaUpstream(hits);
    const dataDir = path.join(TMPROOT, "data-sabotage");
    const bad = makeSabotagedServer();
    const server = await startServer({ entry: bad, dataDir, P, upstreamPort: upstream.address().port });
    S = { P, hits, server, stop: () => { try { upstream.close(); } catch { } killAll(); } };
  }, { timeout: 120000 });
  after(() => { try { S && S.stop(); } catch { } });

  test("★ 改坏之后那三个数字必须不在（否则上面那条断言是恒真的）", async () => {
    const r = await probeAndRead(S.P, S.hits);
    assert.ok(r.or, "状态层里连 or 都没有了 —— 那不是这条对照要验的东西");
    assert.equal(r.or.used, null,
      `改坏之后 used 仍然是 ${r.or.used} —— 「探测结果进了状态层」那条断言是恒真的`);
    assert.notEqual(r.or.ratio, USED, "改坏之后比例仍然是探测到的那个数");
  });
});
