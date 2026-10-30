/**
 * 并发闸门 e2e：★「客户端真的走了」判据（回归测试）
 *
 * ## 这个测试钉住什么
 *
 * 2026-10-30 修的那个 bug：`dispatchGated` 把 Node 的 `req.signal` 当成了
 * 「客户端已断开」。而 `http.IncomingMessage.signal` 是「**请求流被销毁**时
 * abort」的信号 —— 请求流在**请求体读完之后**就会被 autoDestroy 掉 ⇒
 * **每一个**读完 body 的请求 `req.signal.aborted` 恒为 `true`，哪怕客户端
 * 连接好好的、请求完整收到、响应也照写。
 * 后果：并发闸门**永远**拿不到名额，一律回 429「本地限流：客户端已断开」。
 *
 * 修法：自己造一个「客户端真的走了」的 AbortSignal，判据是
 * `res` 的 `'close'` 事件且 `writableFinished !== true`（正常收尾必须放过），
 * 外加 `req` 的 `'aborted'` 事件（请求体没收完就断了）。
 *
 * ⚠ 光靠「正常请求不再 429」钉不住这个 bug —— 判据写错成「永远 abort」
 *   也能让「不再误杀」成立，但 magpie 的语义（客户端走了就别排队、**别发出去**）
 *   就没了。所以这里钉**两头**：
 *
 *   ① 客户端在**排队期间**断开 ⇒ 那个请求**永远不打到上游**
 *      （magpie 原话："leaves the queue and is never sent"）；
 *   ② 客户端**没**断开的排队请求 ⇒ 轮到它时**照常打到上游**
 *      （证明闸门本身还在工作，不是「一律拒绝」蒙混过关）。
 *
 * ## 红线
 *
 * 🔴 落盘只在 os.tmpdir() 下的临时目录 + BAI_DATA_DIR，**绝不碰真实的
 *    %APPDATA%\bai-router**；端口动态挑空闲；进程只按 **PID** 收。
 * 🔴 全文没有一个真实令牌/API key。
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

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bai-concgone-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on("exit", () => { try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { } });

const TOK_SN = "test-sn-token-placeholder";
const SN_MODEL = "test-sn-model";

/* 端口：挑过的要记下来（探测是「bind 再 close」，释放后下次又从段首开始）。 */
const takenPorts = new Set();
async function portInRange() {
  for (let p = 19100; p < 19999; p++) {
    if (takenPorts.has(p)) continue;
    const free = await new Promise((res) => {
      const s = net.createServer();
      s.once("error", () => res(false));
      s.once("listening", () => s.close(() => res(true)));
      s.listen(p, "127.0.0.1");
    });
    if (free) { takenPorts.add(p); return p; }
  }
  throw new Error("19xxx 段找不到空闲端口");
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
 * 假上游：**第一个**请求挂住（占住并发名额），之后的立刻应答。
 * 挂住的那个就是「占坑的」，用来把后来的请求挤进队列。
 */
async function startFakeUpstream(hits, holdMs) {
  const srv = http.createServer((rq, rs) => {
    const chunks = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) || {}; } catch { }
      hits.push({ url: String(rq.url || ""), body });
      const answer = () => {
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(JSON.stringify({
          id: "msg_fake", type: "message", role: "assistant", model: String(body.model || ""),
          content: [{ type: "text", text: "假上游说" }],
          stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 },
        }));
      };
      /* 只有第一个请求挂住：它把并发名额占住 ⇒ 后来的请求只能排队。 */
      if (hits.length === 1) setTimeout(answer, holdMs);
      else answer();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return srv;
}

/* ====================================================================== *
 * 活体
 * ====================================================================== */
describe("并发闸门 · 客户端真的走了（magpie 的 ctx.Done()）", () => {
  let child, upstream, dataDir, P;
  const hits = [];
  const HOLD_MS = 2500;

  before(async () => {
    const ports = [];
    for (let i = 0; i < 9; i++) ports.push(await portInRange());
    P = {
      bai: ports[0], sn: ports[1], wb: ports[2], wbai: ports[3], zen: ports[4],
      qd: ports[5], or: ports[6], panel: ports[7], mm: ports[8],
    };

    upstream = await startFakeUpstream(hits, HOLD_MS);
    const upPort = upstream.address().port;

    dataDir = path.join(TMPROOT, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const cfg = JSON.parse(fs.readFileSync(DEFAULTS_JSON, "utf8"));
    cfg.failover = { ...(cfg.failover || {}), enabled: false };
    cfg.proxy = "http://127.0.0.1:7897";
    cfg._modelsSynced = "dev";
    cfg.relayPort = P.bai; cfg.panelPort = P.panel;
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
      cfg[k] = { ...cfg[k], relayPort: P[k] };
      cfg[k].upstream = `http://127.0.0.1:${upPort}`;
      cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
      if (k === "or") cfg[k].keys = [];
    }
    cfg.sn.apiKey = TOK_SN;
    cfg.sn.useProxy = false;
    cfg.sn.defaultModel = SN_MODEL;
    cfg.sn.availableModels = [SN_MODEL];
    /* ★ 并发上限 = 1：这是本测试的全部前提 —— 名额只有一个 ⇒ 后来的请求必须排队。 */
    cfg.limits = { ...(cfg.limits || {}), concurrency: 1 };

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

  const ask = (body, signal) => fetch(`http://127.0.0.1:${P.sn}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal,
  }).then(async (r) => ({ status: r.status, text: await r.text() }))
    .catch((e) => ({ status: "THREW", text: String((e && e.name) || e) }));

  /** 面板的并发统计（GET /api/limits）—— 用来从**服务端**看排队实况。 */
  const statsOf = async (key) => {
    const j = await fetch(`http://127.0.0.1:${P.panel}/api/limits`).then((r) => r.json());
    return (j && j.stats && j.stats[key]) || {};
  };
  /** 等某个条件成立（轮询服务端状态），返回最后一次读到的值。 */
  const waitFor = async (fn, ms = 4000) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < ms) {
      last = await fn();
      if (last) return last;
      await sleep(50);
    }
    return last;
  };

  const body = (tag) => ({
    model: SN_MODEL, messages: [{ role: "user", content: tag }], max_tokens: 100,
  });

  test("① 客户端在排队期间断开 ⇒ 那个请求离开队列、永远不打到上游", async () => {
    hits.length = 0;
    /* A：占住名额（假上游会挂 HOLD_MS）。 */
    const a = ask(body("占坑的"), AbortSignal.timeout(30000));
    /* 等 A 真的到了上游 ⇒ 名额已被占住。 */
    for (let i = 0; i < 100 && hits.length < 1; i++) await sleep(50);
    assert.equal(hits.length, 1, "占坑的请求没到上游 —— 名额没被占住，后面那条就不算排队");
    await waitFor(async () => (await statsOf("sn")).busy === 1);
    assert.equal((await statsOf("sn")).busy, 1, "占坑的请求没占住并发名额（busy≠1）");

    /* B：排队中（名额只有 1 个）。 */
    const ac = new AbortController();
    const b = ask(body("排队的"), AbortSignal.any([ac.signal, AbortSignal.timeout(30000)]));

    /* ★★ 判别力关键：B 必须**真的排进了队列**（waiting=1）。
     *   只断言「B 没打到上游」是不够的 —— 那个断言在「B 被直接拒掉」时也成立，
     *   而「被直接拒」恰恰是这次 bug 的症状（每个请求都被判成客户端已断开）。
     *   所以这里从**服务端**把「排过队」这件事钉住。 */
    const queued = await waitFor(async () => (await statsOf("sn")).waiting === 1);
    assert.equal(queued, true,
      "★ 排队的请求没有真的排进队列（waiting 始终不是 1）—— 它多半是被闸门**直接拒**了，" +
      "那正是「客户端已断开」误判的症状（本 bug 修好后不该再有）");

    /* 客户端现在走人。 */
    ac.abort();

    /* ★ 它必须**离开队列**（magpie：走掉的那个不占队列位置）。 */
    const left = await waitFor(async () => (await statsOf("sn")).waiting === 0);
    assert.equal(left, true, "客户端走了的请求还占着队列位置 —— 它白占一个坑，等名额的人要一直等它");

    /* 等占坑的 A 结束 —— 名额这时空出来了。 */
    const ra = await a;
    assert.equal(ra.status, 200, `占坑的请求不该失败：${ra.status} ${ra.text.slice(0, 200)}`);

    /* 如果 B 还占着队列（判据没生效），轮到它时它会被**打到上游**。
     *   magpie 的原话是 "leaves the queue and is never sent" —— 所以这里等一会儿，
     *   再看上游到底收了几条。 */
    await sleep(1200);
    assert.equal(hits.length, 1,
      `★ 客户端已经走了的请求还是被打到了上游（上游收到 ${hits.length} 条）—— 闸门没认出「客户端走了」`);

    const rb = await b;
    assert.ok(rb.status === "THREW" || rb.status >= 400,
      `断开的请求不该拿到成功应答：${rb.status} ${rb.text.slice(0, 200)}`);
  });

  test("② 客户端没断开的排队请求 ⇒ 轮到它时照常打到上游（闸门本身还在工作）", async () => {
    hits.length = 0;
    const a = ask(body("占坑的"), AbortSignal.timeout(30000));
    for (let i = 0; i < 100 && hits.length < 1; i++) await sleep(50);
    assert.equal(hits.length, 1, "占坑的请求没到上游");

    /* B：不 abort，老老实实排队。 */
    const b = ask(body("排队的"), AbortSignal.timeout(30000));

    const ra = await a;
    assert.equal(ra.status, 200, `占坑的请求不该失败：${ra.status} ${ra.text.slice(0, 200)}`);
    const rb = await b;
    assert.equal(rb.status, 200, `排队的请求轮到它时该成功：${rb.status} ${rb.text.slice(0, 200)}`);
    assert.equal(hits.length, 2, `排队的请求也该打到上游（上游收到 ${hits.length} 条）—— 闸门把正常请求也拒了`);
  });
});
