/**
 * 旧端口兼容入口的**等价性证明**（scripts/compat-relay-equivalence-test.mjs）
 *
 * ## 为什么要有这个
 *
 * `legacyPortAsGateway`（旧中转端口 → 统一网关的兼容入口）**默认关**，
 * 计划文档写明切默认的前置条件是「**先证明等价**」。
 * 已有 `compat-relay-test.mjs` 验的是**功能**（补前缀、原样转发、开关关掉走老路），
 * 这里验的是**等价**：同一批请求，「开关开」与「开关关」两条路
 * **客户端能观察到的结果是否一致**。
 *
 * ## 怎么验
 *
 * 一个**隔离实例**（独立数据目录 + 动态端口 + 代理探测关掉），一个**假上游**
 *（记录它收到的模型名）。
 * ⚠ 兼容入口的开关是**每请求实时读** cfg 的 ⇒ 改 config.json 即生效，**不用重启**。
 *
 * ## 本文件要如实记下的两处**不等价**（切默认前必须知道）
 *
 * · **兜底模型不在映射表里**：老路「查不到 ⇒ 静默回落到 defaultModel」成功；
 *   网关路「补前缀 ⇒ 反查不到档位 ⇒ 原样转发 ⇒ 网关说这家没这个档位」⇒ 400。
 * · **本家不可用时**：老路只在本家转 ⇒ 失败；网关路看得见别家 ⇒ **跨家转移**成功。
 *   ⇒ 这是**有意的行为变化**（计划文档写明），不是缺陷；但它让「两条路结果相同」
 *   **不成立** ⇒ 切默认时必须写进说明。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 系统分配的空闲端口（**不用固定端口段** —— 那会与真实服务撞）。 */
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});

describe("兼容入口的等价性：开关开 vs 开关关", () => {
  let server, root, dataDir, home, cfgFile, P, upA, upB;
  let seenA = [], seenB = [];   // ⚠ 要在 describe 作用域：测试函数里要看「别家的上游有没有被打到」
  let upStatus = 200;
  let upPortA = 0, upPortB = 0;     // ⚠ 要在 describe 作用域：测试函数里要用（⑥ 要把 sn 指到 B）

  before(async () => {
    /* ⚠ **两个**假上游：A 给本家（bai，可故意失败），B 给别家（sn，始终正常）
     *   ⇒ ⑥ 才能看出「网关路跨家转移、老路不转」。 */
    const mkUp = (sink) => http.createServer((rq, rs) => {
      const chunks = [];
      rq.on("data", (c) => chunks.push(c));
      rq.on("end", () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { }
        sink.push({ url: rq.url, model: body && body.model });
        if (upStatus !== 200) {
          rs.writeHead(upStatus, { "content-type": "application/json" });
          rs.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "假上游故意失败" } }));
          return;
        }
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(JSON.stringify({
          id: "msg_x", type: "message", role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: (body && body.model) || "x", stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
    });
    upA = mkUp(seenA); upB = mkUp(seenB);
    await new Promise((r) => upA.listen(0, "127.0.0.1", r));
    await new Promise((r) => upB.listen(0, "127.0.0.1", r));
    upPortA = upA.address().port;
    upPortB = upB.address().port;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bai-compat-equiv-"));
    dataDir = path.join(root, "data");
    home = path.join(root, "home");
    for (const d of [dataDir, home]) fs.mkdirSync(d, { recursive: true });

    P = {};
    P.bai = await freePort();
    P.gateway = await freePort();
    P.panel = await freePort();
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) P[k] = await freePort();

    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "src/server/config.defaults.json"), "utf8"));
    cfg.failover = { ...(cfg.failover || {}), enabled: false };
    cfg.proxy = ""; cfg._modelsSynced = "dev";
    cfg.relayPort = P.bai; cfg.panelPort = P.panel; cfg.gatewayPort = P.gateway;
    cfg.gatewayMode = "on";
    cfg.legacyPortAsGateway = "off";     // 起点是**关**（= 出厂默认）
    /* bai 的一档：模型 id 是档位名、目标是最终模型名（老配置那种写法）。 */
    cfg.mapping = { "claude-opus-5": { target: "hy3", label: "HY3" } };
    cfg.apiKey = "dummy-not-a-real-key";
    cfg.defaultModel = "hy3";
    cfg.upstream = `http://127.0.0.1:${upPortA}`;
    for (const k of ["sn", "wb", "wbai", "zen", "qd", "mm", "or"]) {
      cfg[k] = { ...cfg[k], relayPort: P[k], upstream: `http://127.0.0.1:${upPortA}` };
      cfg[k].accessToken = ""; cfg[k].refreshToken = ""; cfg[k].apiKey = "";
      if (k === "or") cfg[k].keys = [];
    }
    cfgFile = path.join(dataDir, "config.json");
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf8");

    const env = {
      ...process.env, BAI_DATA_DIR: dataDir, BAI_CLIENT_HOME: home, USERPROFILE: home,
      APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
      BAI_NO_PROXY_AUTODETECT: "1", BAI_ENV_FIXED: "1",
    };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    env.NO_PROXY = "127.0.0.1,localhost";

    server = spawn(process.execPath, [path.join(REPO, "src/server/server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let slog = "";
    server.stdout.on("data", (d) => { slog += d; });
    server.stderr.on("data", (d) => { slog += d; });
    for (let i = 0; i < 120; i++) {
      try {
        const st = await fetch(`http://127.0.0.1:${P.panel}/api/status`).then((r) => r.json());
        if (st.service && st.service.up) return;
      } catch { }
      await sleep(300);
    }
    throw new Error("server.mjs 起不来：" + slog.slice(-1500));
  }, { timeout: 120000 });

  after(() => {
    try { server && server.kill(); } catch { }
    try { upA && upA.close(); } catch { }
    try { upB && upB.close(); } catch { }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { }
  });

  /** 原子改 config.json（服务端会读它；写一半被读到会炸）。 */
  const setCompat = (on) => {
    const c = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    c.legacyPortAsGateway = on ? "on" : "off";
    const tmp = cfgFile + ".tmp-test";
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2), "utf8");
    fs.renameSync(tmp, cfgFile);
  };
  /** 原子改配置里的某个字段。 */
  const patchCfg = (fn) => {
    const c = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    fn(c);
    const tmp = cfgFile + ".tmp-test";
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2), "utf8");
    fs.renameSync(tmp, cfgFile);
  };

  const post = async (port_, body, path_ = "/v1/messages") => {
    const r = await fetch(`http://127.0.0.1:${port_}${path_}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    return { status: r.status, text: await r.text() };
  };

  /** 同一条请求跑两遍（开关关 / 开），返回两边的结果与**两个上游**各自看到什么。 */
  const bothWays = async (body) => {
    const run = async (on) => {
      setCompat(on);
      seenA.length = 0; seenB.length = 0;
      const r = await post(P.bai, body);
      await sleep(150);                     // 让上游那笔落到 seen 里
      return {
        status: r.status, text: r.text,
        upstreamA: seenA.map((s) => s.model),   // 本家（bai）的上游
        upstreamB: seenB.map((s) => s.model),   // 别家（or）的上游
      };
    };
    const off = await run(false);
    const on = await run(true);
    return { off, on };
  };

  test("① 老配置（model 写最终模型名 hy3）：两条路**逐字一致**", async () => {
    const r = await bothWays({ model: "hy3", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    assert.equal(r.off.status, 200, `老路状态码 ${r.off.status}：${r.off.text.slice(0, 200)}`);
    assert.equal(r.on.status, 200, `网关路状态码 ${r.on.status}：${r.on.text.slice(0, 200)}`);
    assert.deepEqual(r.on.upstreamA, r.off.upstreamA,
      `★ 两条路打给上游的模型名不同：老路 ${JSON.stringify(r.off.upstreamA)} vs 网关路 ${JSON.stringify(r.on.upstreamA)}`);
    assert.equal(r.off.upstreamA[0], "hy3", `老路应当把最终模型名原样交给上游，实际 ${r.off.upstreamA[0]}`);
  });

  test("② 客户端送档位名（claude-opus-5）：两条路**逐字一致**", async () => {
    const r = await bothWays({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    assert.equal(r.off.status, 200, r.off.text.slice(0, 200));
    assert.equal(r.on.status, 200, r.on.text.slice(0, 200));
    assert.deepEqual(r.on.upstreamA, r.off.upstreamA,
      `★ 两条路打给上游的模型名不同：${JSON.stringify(r.off.upstreamA)} vs ${JSON.stringify(r.on.upstreamA)}`);
  });

  test("③ 客户端送 provider/档位（bai/claude-opus-5）：两条路**逐字一致**", async () => {
    const r = await bothWays({ model: "bai/claude-opus-5", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    assert.equal(r.off.status, 200, r.off.text.slice(0, 200));
    assert.equal(r.on.status, 200, r.on.text.slice(0, 200));
    assert.deepEqual(r.on.upstreamA, r.off.upstreamA,
      `★ 两条路打给上游的模型名不同：${JSON.stringify(r.off.upstreamA)} vs ${JSON.stringify(r.on.upstreamA)}`);
  });

  test("④ 未知模型（回落 defaultModel）：两条路**逐字一致**", async () => {
    const r = await bothWays({ model: "zzz-not-a-real-model", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    assert.equal(r.off.status, 200, r.off.text.slice(0, 200));
    assert.equal(r.on.status, 200, r.on.text.slice(0, 200));
    assert.deepEqual(r.on.upstreamA, r.off.upstreamA,
      `★ 回落后的模型名不同：${JSON.stringify(r.off.upstreamA)} vs ${JSON.stringify(r.on.upstreamA)}`);
  });

  test("⑤ ★ 不等价的一处：defaultModel 不在映射表里 ⇒ 老路回落成功、网关路 400", async () => {
    /* 兼容入口补前缀时是「按老路的方式解析 ⇒ 反查指向该最终模型名的档位」
       ⇒ 反查不到 ⇒ 原样转发 ⇒ 网关说「这家没这个档位」⇒ 400。
       ⇒ **切默认前必须知道这一处不等价**（要么补，要么写进说明）。 */
    patchCfg((c) => { c.defaultModel = "a-model-not-in-the-mapping"; });
    const r = await bothWays({ model: "zzz-not-a-real-model", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    assert.equal(r.off.status, 200, `老路应当回落成功，实际 ${r.off.status}`);
    assert.notEqual(r.on.status, 200,
      "★ 网关路这里也成功了 ⇒ 兼容入口已经能处理「兜底模型不在映射表」⇒ 这条不等价的记录过时了，请重新核对");
    assert.match(r.on.text, /档位|前缀|provider/i,
      `网关路的报错应当说清是「档位/前缀」的问题，实际：${r.on.text.slice(0, 200)}`);
    patchCfg((c) => { c.defaultModel = "hy3"; });
  });

  test("⑥ 记录：两条路会不会打到别家（本条只记录、不作判据 —— 它依赖冷却状态）", async () => {
    /* ⚠ 这条**依赖运行时状态**（谁被试过 ⇒ 谁在冷却）⇒ 同一个夹具里，
     *   前面的用例已经把链上几家试过并失败过 ⇒ 结果会随用例顺序变
     *   ⇒ **不能当判据**（否则它测的是「冷却」不是「行为」）。
     *   ⇒ 这里只把观测到的行为**记下来**（打日志），真正的结论写进
     *   docs/replication-plan.md。
     *
     * 2026-10-26 观测到的：老路（不走网关）**也会**打到别家 ⇒
     * ⇒ 计划文档里「走网关后故障转移变成跨渠道的」（言下之意老路不跨）
     * ⇒ **这条行为差异不存在（或描述有误）**。 */
    patchCfg((c) => {
      c.failover = { ...(c.failover || {}), enabled: true };
      c.or = { ...c.or, upstream: `http://127.0.0.1:${upPortB}`, keys: ["dummy-not-a-real-key"] };
    });
    upStatus = 500;                          // 本家（bai）挂掉
    const r = await bothWays({ model: "hy3", messages: [{ role: "user", content: "hi" }], max_tokens: 16 });
    upStatus = 200;
    patchCfg((c) => {
      c.failover = { ...(c.failover || {}), enabled: false };
      c.or = { ...c.or, upstream: `http://127.0.0.1:${upPortA}`, keys: [] };
    });
    console.log(`      观测：老路打到别家 ${r.off.upstreamB.length} 次；网关路打到别家 ${r.on.upstreamB.length} 次`);
    /* ⚠⚠ **不作判据**：这条**依赖运行时状态**（谁被试过 ⇒ 谁在冷却）⇒
     *   同��个夹具里前面的用例已经把链上几家试过并失败过 ⇒
     *   两次实测的方向**相反**（一轮「老路打了、网关路没打」，一轮反过来）
     *   ⇒ 它测的是「冷却」不是「行为」⇒ 只能记录。
     *
     *   ⇒ **结论**：计划文档里「走网关后故障转移变成**跨渠道**的」这条行为差异，
     *   **并不是一条稳定的差异** ⇒ 切默认时**不要**把它当卖点写进说明。
     *   真正稳定的差异是 ⑤（defaultModel 不在映射表里 ⇒ 老路回落成功、网关路 400）。 */
  });
});
