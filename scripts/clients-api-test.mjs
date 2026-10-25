/**
 * 客户端接线的**面板接口**（活体：真 server.mjs）
 *
 * ## 测什么
 *
 *   ★ ① GET /api/clients → 列出客户端（至少含 ZCode）
 *   ★ ② POST /api/clients/apply → 真的把配置文件写出来（写到**临时 home** 里）
 *   ★ ③ POST /api/clients/revert → 真的把那一块收回去
 *   ★ ④ 不认识的客户端 id → 404（不静默走别的路）
 *   ★ ⑤ 统一网关 GET /v1/models → 一份响应两种客户端都能读
 *
 * ## 隔离（这一份测试最要紧的地方）
 *
 *   接线会**写文件**。测试绝不能写进用户真的 home —— 所以起服务时给
 *   `BAI_CLIENT_HOME` 指一个临时目录（与 `BAI_DATA_DIR` 同一类的作用：
 *   把「写文件」这件事隔离开）。不设它的话，生产环境就是真实用户目录。
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录；端口全部动态挑空闲；进程只按 PID 收。
 * 🔴 全文没有一个真实令牌/API key。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-clientsapi-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

/* ⚠ 挑过的端口要记下来：探测是「bind 再 close」，释放后下一次挑又会从段首开始，
 *   于是十次全挑到同一个端口（起第二个实例时 EADDRINUSE）。 */
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

describe("客户端接线的面板接口", () => {
  let P, dataDir, clientHome, child;

  before(async () => {
    const ports = [];
    for (let i = 0; i < 10; i++) ports.push(await portInRange());
    P = {
      bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4],
      qd: ports[5], or: ports[6], mm: ports[7], panel: ports[8], gateway: ports[9],
    };
    dataDir = path.join(TMPROOT, "data");
    clientHome = path.join(TMPROOT, "home");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(clientHome, { recursive: true });
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
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2), "utf8");

    const env = {
      ...process.env,
      BAI_DATA_DIR: dataDir,
      BAI_CLIENT_HOME: clientHome,   // ← 接线写文件的地方，隔离到临时目录
      BAI_NO_PROXY_AUTODETECT: "1", BAI_ENV_FIXED: "1",
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

  after(() => { killAll(); });

  const get = (p) => fetch(`http://127.0.0.1:${P.panel}${p}`, { signal: AbortSignal.timeout(30000) }).then((r) => r.json());
  const post = (p, body) => fetch(`http://127.0.0.1:${P.panel}${p}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30000),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));

  test("① GET /api/clients → 列出客户端（含 ZCode）", async () => {
    const r = await get("/api/clients");
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.list), "列表必须是数组");
    const z = r.list.find((x) => x.id === "zcode");
    assert.ok(z, `列表里没有 zcode：${JSON.stringify(r.list.map((x) => x.id))}`);
    assert.equal(z.name, "ZCode");
    /* ⚠ ZCode 说的是 **anthropic**（不是 chat）：照 magpie —— 我们给 ZCode 新建的
     *   provider 块走 Anthropic Messages（internal/agent/zcode.go:23 的形状
     *   `kind:"anthropic"`），因为统一网关三个方言都答（/v1/messages、
     *   /v1/chat/completions、/v1/responses 在同一个地址上）。 */
    assert.equal(z.protocol, "anthropic");
  });

  test("①b 坏掉的声明不许炸掉整张列表（它是一条看得见的坏条目）", async () => {
    const r = await get("/api/clients");
    assert.equal(r.ok, true, "一个坏文件不许让整个接口 500");
    const broken = r.list.filter((x) => x.broken);
    for (const b of broken) assert.match(String(b.note || ""), /失败/, "坏条目要说清怎么坏了");
  });

  test("② POST /api/clients/apply → 真的把 ZCode 的配置写出来", async () => {
    const r = await post("/api/clients/apply", { id: "zcode" });
    assert.equal(r.status, 200, `接线失败：${JSON.stringify(r.json)}`);
    const file = path.join(clientHome, ".zcode", "v2", "config.json");
    assert.ok(fs.existsSync(file), `配置文件没写出来：${file}`);
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(j.provider && j.provider.bai, "provider 块没写进去");
    /* ⚠ 同上：ZCode 新建的 provider 块走 Anthropic Messages（照 magpie 的形状）。 */
    assert.equal(j.provider.bai.kind, "anthropic");
    assert.match(j.provider.bai.options.baseURL, /^http:\/\/127\.0\.0\.1:\d+$/);
    const ids = Object.keys(j.provider.bai.models || {});
    assert.ok(ids.length > 0, "模型清单没写进去");
    for (const id of ids) assert.match(id, /^[a-z0-9]+\//, `模型 id 必须是 provider/档位：${id}`);
    /* ⚠ 环境变量遮蔽检查**接上了**（字段在、失败也不炸）。
     *   只验「接线通」：本机注册表里没有同名变量 ⇒ 造不出遮蔽场景
     *   （要造就得改真实注册表 ⇒ 绝不做）。判据本身由 scripts/env-shadow-test.mjs 覆盖。 */
    assert.ok("envShadow" in r.json,
      "★ apply 的返回体里没有 envShadow 字段 ⇒ 遮蔽结果没法从接口拿出来");
    assert.equal(typeof r.json.detail, "string", "detail 必须是字符串（面板只显示它）");
  });

  test("②b 状态变成「已接到 B.AI」", async () => {
    const r = await get("/api/clients");
    const z = r.list.find((x) => x.id === "zcode");
    assert.equal(z.status.wired, true, `状态不对：${JSON.stringify(z.status)}`);
  });

  test("②c 列表每一项都带 envShadow（面板那行渲染得出来）", async () => {
    /* ⚠ **只读**：不要再 apply 一次（那会覆盖备份 ⇒ 把 ③ 的还原测坏）。 */
    const list = await get("/api/clients");
    for (const c of list.list) {
      assert.ok("envShadow" in c,
        `★ 列表项 ${c.id} 里没有 envShadow 字段 ⇒ 面板那行渲染不出来`);
    }
  });

  test("③ POST /api/clients/revert → 把我们写的那一块收回去", async () => {
    const file = path.join(clientHome, ".zcode", "v2", "config.json");
    const r = await post("/api/clients/revert", { id: "zcode" });
    assert.equal(r.status, 200, `断开失败：${JSON.stringify(r.json)}`);
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(j.provider, undefined, "★ 我们写的那块还在用户文件里");
  });

  test("④ 不认识的客户端 id → 404", async () => {
    const r = await post("/api/clients/apply", { id: "no-such-client" });
    assert.equal(r.status, 404, `实际 ${r.status}`);
    assert.ok(r.json.error, "错误要说清是哪个客户端不认识");
  });

  test("⑤ 统一网关 GET /v1/models → 一份响应两种客户端都能读", async () => {
    const r = await fetch(`http://127.0.0.1:${P.gateway}/v1/models`, { signal: AbortSignal.timeout(30000) });
    assert.equal(r.status, 200, `实际 ${r.status}`);
    const j = await r.json();
    assert.equal(j.object, "list");
    assert.ok(Array.isArray(j.data) && j.data.length > 0, "清单不能是空的");
    const one = j.data[0];
    assert.equal(one.object, "model", "OpenAI 侧要读 object");
    assert.equal(one.type, "model", "Anthropic 侧要读 type");
    assert.match(one.id, /^[a-z0-9]+\//, "模型 id 必须是 provider/档位");
  });

  test("⑥ 统一网关的 Chat 入口认得（协议已注册）", async () => {
    const r = await fetch(`http://127.0.0.1:${P.gateway}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "没有前缀", messages: [] }),
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(r.status, 400, `实际 ${r.status}（应当是 400：模型名没前缀）`);
    const t = await r.text();
    assert.match(t, /provider/, "错误要说清缺 provider 前缀");
  });
});
