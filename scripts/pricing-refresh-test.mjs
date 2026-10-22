/* 价格表的「用户点了才更新」：真接线（端点 + 落盘 + 费用真的用上了新表）。
 *
 * ── 这份测试在守什么 ──
 *
 * 策略是定死的：**绝不自动更新**，更新必须是用户点了才发生的事。理由是价格会漂移，
 * 自动更新会让「今天我花了多少钱」这句话的**含义**在某天悄悄变掉，而用户是拿它
 * 跟厂商账单对账的。
 *
 * 这条策略落到代码上有三件事必须同时成立，少一件就等于「用户点了没反应」：
 *   ① 端点回的是**当前生效的那张表**（不是永远内置快照）；
 *   ② 刷新成功后**费用真的用上了新表**（estimateCost 传的就是它）；
 *   ③ 刷新失败时**继续用旧表**（绝不清空费用 —— 清空了用户会以为「今天没花钱」）。
 *
 * ①②③ 都在**接线**上：模块（`pricing.mjs` / `pricing-refresh.mjs`）单测全绿，
 * 而「端点没把表传下去」这类 bug 只有真起一次服务才暴露。
 *
 * ── 怎么测 ──
 *
 * 活体：假的价格源（一个本地 HTTP 服务，返回 models.dev 形状的 api.json）
 *   + 真 server.mjs。价格源的地址由 `BAI_PRICING_URL` 指过去 ——
 *   实测真源有 6 MB，测试不该真去拉它（既慢又不确定）。
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

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-pricing-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* 假的价格源：形状照 models.dev 的 api.json ——
   { "<provider id>": { models: { "<model id>": { cost: { input, output, cache_read, cache_write } } } } } */
const FAKE_PRICE = 12.5;

function makeModelsDevPayload() {
  return {
    sensenova: {
      models: {
        "test-remote-model": { cost: { input: FAKE_PRICE, output: FAKE_PRICE * 2, cache_read: 0, cache_write: 0 } },
      },
    },
  };
}

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

async function startServer({ dataDir, P, pricingUrl, mode }) {
  const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
  cfg.failover = { ...(cfg.failover || {}), enabled: false };
  cfg.proxy = "http://127.0.0.1:7897";
  cfg._modelsSynced = "dev";
  cfg.relayPort = P.bai; cfg.panelPort = P.panel; cfg.gatewayPort = P.gateway;
  for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
    cfg[k] = { ...cfg[k], relayPort: P[k] };
    cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
    if (k === "or") cfg[k].keys = [];
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");

  const env = {
    ...process.env, BAI_DATA_DIR: dataDir, BAI_NO_PROXY_AUTODETECT: "1", BAI_ENV_FIXED: "1",
    BAI_PRICING_URL: pricingUrl,
  };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
  env.NO_PROXY = "127.0.0.1,localhost";
  const child = track(spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));
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
const postJson = (port, p) => fetch(`http://127.0.0.1:${port}${p}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  signal: AbortSignal.timeout(30000),
}).then((r) => r.json());

/** 点一次刷新，轮到它跑完（最多 60 秒）。 */
async function refreshAndWait(P) {
  const started = await postJson(P.panel, "/api/pricing/refresh");
  assert.equal(started.ok, true, `刷新端点没回 ok：${JSON.stringify(started)}`);
  assert.equal(started.started, true, `刷新应当是「非阻塞」范式：立刻回 started:true。实际 ${JSON.stringify(started)}`);
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 60000) {
    last = await getJson(P.panel, "/api/pricing");
    if (!last.refreshing) return last;
    await sleep(300);
  }
  throw new Error(`刷新 60 秒还没跑完：${JSON.stringify(last)}`);
}

describe("价格表：用户点了才更新（真接线）", () => {
  let S, fake;
  before(async () => {
    const ports = [];
    for (let i = 0; i < 10; i++) ports.push(await portInRange());
    const P = {
      bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4],
      qd: ports[5], or: ports[6], mm: ports[7], panel: ports[8], gateway: ports[9],
    };
    /* 假的价格源：返回 models.dev 形状的 api.json。 */
    fake = http.createServer((rq, rs) => {
      rs.writeHead(200, { "content-type": "application/json" });
      rs.end(JSON.stringify(makeModelsDevPayload()));
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    const dataDir = path.join(TMPROOT, "data");
    const server = await startServer({
      dataDir, P, pricingUrl: `http://127.0.0.1:${fake.address().port}/api.json`,
    });
    S = { P, server, stop: () => { try { fake.close(); } catch { } killAll(); } };
  }, { timeout: 120000 });
  after(() => { try { S && S.stop(); } catch { } });

  test("★ 刷新前：回的是内置快照，带日期、条目不为空", async () => {
    const r = await getJson(S.P.panel, "/api/pricing");
    assert.equal(r.ok, true);
    assert.match(String(r.pricedAt), /^\d{4}-\d{2}-\d{2}$/, `表必须带快照日期：${JSON.stringify(r)}`);
    assert.equal(r.source, "builtin", "刚装好时用的是内置快照");
    assert.ok(Array.isArray(r.entries) && r.entries.length > 0, "内置表不该是空的");
    for (const e of r.entries) {
      assert.ok(e.name && !/^[\w-]+\//.test(e.name), `条目要带显示名（不许只给 key）：${JSON.stringify(e)}`);
    }
  });

  test("★ 刷新成功后：换成远端那张（快照日期是今天），且远端表落盘了", async () => {
    const r = await refreshAndWait(S.P);
    assert.equal(r.refreshing, false);
    assert.equal(r.lastError, "", `刷新不该报错：${r.lastError}`);
    assert.equal(r.source, "remote", "刷新成功后就该用远端那张");
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(r.pricedAt, today, `远端表的快照日期该是抓取那天（今天）：${r.pricedAt}`);
    assert.ok(r.entries.some((e) => e.key === "sn/test-remote-model"),
      `远端表里的条目没进来：${JSON.stringify(r.entries.map((e) => e.key))}`);
    /* 落盘：重启后还得是这张表。 */
    const p = path.join(TMPROOT, "data", "pricing-table.json");
    assert.ok(fs.existsSync(p), "远端表必须落盘（不然重启就丢了，用户白点一次）");
    const saved = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(String(saved.pricedAt), today);
  });

  test("★ 费用真的用上了新表（不是永远用内置快照）", async () => {
    /* 造一条 sn 的记录（token 数够大，费用才看得出来），再打 /api/usage：
     * 用远端表的单价（input 12.5 / output 25 每百万 token）算出来的钱，
     * 与内置快照算出来的**不一样** —— 一样就说明 estimateCost 还在用内置表。 */
    const rows = [{ t: new Date().toISOString(), provider: "sn", model: "test-remote-model", in: 1000000, out: 1000000, cache_read: 0, cache_write: 0, status: 200 }];
    /* ⚠ 账本就在**数据目录**下（usage-ledger.mjs 的 loadRecords(dir) 读 dir/usage.jsonl），
     *   不是「数据目录/usage/usage.jsonl」—— 多套一层目录就永远读不到，
     *   费用算出来永远是 0（而 0 看着像「今天没花钱」）。 */
    const ledger = path.join(TMPROOT, "data", "usage.jsonl");
    fs.writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const u = await getJson(S.P.panel, "/api/usage");
    const cost = u && u.totals ? u.totals.cost : null;
    assert.ok(cost != null, `费用不该是 null：${JSON.stringify(u && u.totals)}`);
    /* 远端表的单价：input 12.5 + output 25（美元/百万 token）；
     * 这条记录 in=1M、out=1M → 12.5 + 25 = 37.5 美元。
     * ⚠ 内置快照里**没有** sn/test-remote-model 这一条 → 用内置表算的话
     *   这条是「估不出」（cost=null），而 null 在这里会被读成「今天没花钱」。
     *   所以「算得出 37.5」本身就是「用的远端表」的证据。 */
    assert.ok(Math.abs(cost - 37.5) < 0.01,
      `费用应当按远端表算（37.5 美元），实际 ${cost} —— estimateCost 还在用内置快照`);
  });
});

describe("价格表：拉不到就继续用旧的（绝不把费用清空）", () => {
  let S, fake;
  before(async () => {
    const ports = [];
    for (let i = 0; i < 10; i++) ports.push(await portInRange());
    const P = {
      bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4],
      qd: ports[5], or: ports[6], mm: ports[7], panel: ports[8], gateway: ports[9],
    };
    /* 假的价格源：**故意回 500** —— 拉不到是最常见的情形（断网、源挂了）。 */
    fake = http.createServer((rq, rs) => {
      rs.writeHead(500, { "content-type": "application/json" });
      rs.end(JSON.stringify({ error: "boom" }));
    });
    await new Promise((r) => fake.listen(0, "127.0.0.1", r));
    const dataDir = path.join(TMPROOT, "data-fail");
    const server = await startServer({
      dataDir, P, pricingUrl: `http://127.0.0.1:${fake.address().port}/api.json`,
    });
    S = { P, server, stop: () => { try { fake.close(); } catch { } killAll(); } };
  }, { timeout: 120000 });
  after(() => { try { S && S.stop(); } catch { } });

  test("★ 拉不到 → 继续用旧表 + 说清原因，费用不许被清空", async () => {
    const before = await getJson(S.P.panel, "/api/pricing");
    assert.equal(before.source, "builtin");
    const r = await refreshAndWait(S.P);
    assert.equal(r.refreshing, false);
    assert.ok(r.lastError && r.lastError.length > 0, "拉不到必须说清原因，不能只是「失败」");
    assert.match(r.lastError, /继续用旧的那张|拉不到|不合格/, `原因要说清「继续用旧表」：${r.lastError}`);
    assert.equal(r.source, "builtin", "拉不到就不许换表");
    assert.equal(r.pricedAt, before.pricedAt, "表不许变");
    assert.ok(r.entries.length > 0, "表不许被清空（清空了用户会以为「今天没花钱」）");
  });
});
